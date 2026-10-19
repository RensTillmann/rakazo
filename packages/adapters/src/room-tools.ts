import { runContinueJob, runJobKey } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { resolveBotMentionedGroupBotIds } from "@rakazo/core";
import {
  appendEventInTransaction,
  createGroupRepos,
  createThreadMessageInTransaction,
  IsolationError,
  lockOwnedGroup,
  touchGroupUpdatedAt,
  wakeGroupMembersInTransaction,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./executor.js";
import { archiveGroupWithTeardown } from "./group-archive.js";

/** Rooms are groups a bot sets up for one case or a standing team. */
export const ROOM_MIN_BOTS = 3;
export const ROOM_MAX_BOTS = 6;

export const ROOM_TOOL_NAMES: readonly string[] = [
  "room_create",
  "room_update",
  "room_post",
  "room_archive",
  "room_list",
];

export function isRoomToolName(name: string): boolean {
  return ROOM_TOOL_NAMES.includes(name);
}

/**
 * `RAKAZO_ROOM_TOOL_BOTS` (comma-separated bot ids) is an optional hard allow-list for the
 * room tools. Unset, every bot is offered them unless it disabled them itself.
 */
export function roomToolsAllowedForBot(botId: string): boolean {
  const raw = process.env.RAKAZO_ROOM_TOOL_BOTS?.trim();
  if (!raw) return true;
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .includes(botId);
}

type RoomRun = { id: string; spaceId: string; threadId: string; botId: string; userId: string };
type RoomDeps = Pick<ExecutorDeps, "prisma" | "events" | "jobs" | "sandbox">;

function roomBotIds(value: unknown): string[] | { error: string } {
  if (!Array.isArray(value)) return { error: "botIds must be a list of bot ids" };
  const ids = value.map((id) => String(id).trim()).filter(Boolean);
  if (new Set(ids).size !== ids.length) return { error: "botIds must be distinct" };
  if (ids.length < ROOM_MIN_BOTS || ids.length > ROOM_MAX_BOTS) {
    return { error: `a room needs ${ROOM_MIN_BOTS} to ${ROOM_MAX_BOTS} bots` };
  }
  return ids;
}

function isolationMessage(error: unknown, fallback: string) {
  if (error instanceof IsolationError) return { error: error.message || fallback };
  throw error;
}

async function cancelRunJobs(deps: Pick<ExecutorDeps, "jobs">, runIds: string[]) {
  await Promise.all(
    runIds.map((runId) => deps.jobs.cancel(runJobKey(runId)).catch(() => undefined)),
  );
}

export async function roomCreate(
  deps: RoomDeps,
  run: RoomRun,
  args: { name?: unknown; botIds?: unknown; roomKind?: unknown; caseNumber?: unknown },
) {
  const name = String(args.name ?? "").trim();
  if (!name || name.length > 80) return { error: "name must be 1 to 80 characters" };
  const roomKind = args.roomKind === "standing" ? "standing" : "case";
  if (args.roomKind !== undefined && args.roomKind !== "case" && args.roomKind !== "standing") {
    return { error: "roomKind must be case or standing" };
  }
  const caseNumber =
    args.caseNumber === undefined || args.caseNumber === null ? null : Number(args.caseNumber);
  if (caseNumber !== null && !(Number.isInteger(caseNumber) && caseNumber > 0)) {
    return { error: "caseNumber must be a positive integer" };
  }
  const botIds = roomBotIds(args.botIds);
  if ("error" in botIds) return botIds;
  try {
    const group = await createGroupRepos(deps.prisma).createGroup(run, { name, botIds });
    return {
      ok: true,
      roomId: group.id,
      threadId: group.threadId,
      name: group.name,
      roomKind,
      caseNumber,
      leaderBotId: botIds[0],
      members: group.members,
    };
  } catch (error) {
    return isolationMessage(error, "one of the bots is not available");
  }
}

export async function roomUpdate(
  deps: RoomDeps,
  run: RoomRun,
  args: { roomId?: unknown; botIds?: unknown },
) {
  const roomId = String(args.roomId ?? "").trim();
  if (!roomId) return { error: "roomId is required" };
  const botIds = roomBotIds(args.botIds);
  if ("error" in botIds) return botIds;
  try {
    const updated = await createGroupRepos(deps.prisma).updateGroup(run, {
      groupId: roomId,
      botIds,
    });
    await cancelRunJobs(deps, updated.cancelledRunIds);
    return {
      ok: true,
      roomId,
      members: updated.group.members,
      cancelledRunIds: updated.cancelledRunIds,
    };
  } catch (error) {
    return isolationMessage(error, "room is not available");
  }
}

export async function roomArchive(deps: RoomDeps, run: RoomRun, args: { roomId?: unknown }) {
  const roomId = String(args.roomId ?? "").trim();
  if (!roomId) return { error: "roomId is required" };
  try {
    const archived = await archiveGroupWithTeardown(deps, run, roomId);
    return { ok: true, roomId, cancelledRunIds: archived.cancelledRunIds };
  } catch (error) {
    return isolationMessage(error, "room is not available");
  }
}

export async function roomList(deps: RoomDeps, run: RoomRun) {
  const groups = await createGroupRepos(deps.prisma).listGroups(run);
  return {
    rooms: groups.map((group) => ({
      roomId: group.id,
      name: group.name,
      updatedAt: group.updatedAt,
      // The first member leads. A member's status is its newest active run in any thread,
      // so "running" can mean busy elsewhere.
      members: group.members.map((member, index) => ({
        botId: member.botId,
        name: member.name,
        leader: index === 0,
        status: member.status ?? "idle",
        busy: (member.status ?? "idle") !== "idle",
      })),
    })),
  };
}

/**
 * Posts in a room as the calling bot and wakes the members it names, or the leader when it
 * names nobody. A busy member is steered rather than started twice.
 */
export async function roomPost(
  deps: RoomDeps,
  run: RoomRun,
  args: { roomId?: unknown; text?: unknown },
  deliveryKey: string,
) {
  const roomId = String(args.roomId ?? "").trim();
  const text = String(args.text ?? "").trim();
  if (!roomId) return { error: "roomId is required" };
  if (!text) return { error: "text is required" };
  const clientNonce = `room-post:${deliveryKey}`;
  const committed = await deps.prisma.$transaction(async (tx) => {
    try {
      await lockOwnedGroup(tx, run, roomId);
    } catch (error) {
      if (error instanceof IsolationError) return { error: "room is not available" } as const;
      throw error;
    }
    const group = await tx.chatGroup.findFirst({
      where: { id: roomId, archivedAt: null },
      select: {
        thread: { select: { id: true } },
        members: {
          where: { bot: { archivedAt: null } },
          orderBy: [{ createdAt: "asc" }, { botId: "asc" }],
          select: { bot: { select: { id: true, name: true } } },
        },
      },
    });
    if (!group?.thread) return { error: "room is archived or not available" } as const;
    const threadId = group.thread.id;
    const existing = await tx.message.findUnique({
      where: { threadId_clientNonce: { threadId, clientNonce } },
      select: { id: true },
    });
    if (existing) return { ok: true, threadId, messageId: existing.id, wakes: [] } as const;

    const members = group.members.map((member) => member.bot);
    const mentioned = resolveBotMentionedGroupBotIds({
      text,
      members,
      authorBotId: run.botId,
    });
    const leader = members[0];
    const targets =
      mentioned.length > 0 ? mentioned : leader && leader.id !== run.botId ? [leader.id] : [];
    const blocks: MessageBlock[] = [{ kind: "text", text }];
    const message = await createThreadMessageInTransaction(tx, {
      threadId,
      role: "bot",
      blocks,
      botId: run.botId,
      clientNonce,
    });
    const wakes = await wakeGroupMembersInTransaction(tx, {
      spaceId: run.spaceId,
      userId: run.userId,
      threadId,
      messageId: message.id,
      botIds: targets,
      prompt: text,
    });
    const event = await appendEventInTransaction(tx, {
      spaceId: run.spaceId,
      threadId,
      botId: run.botId,
      type: "thread.message.created",
      payload: { messageId: message.id, role: "bot", blocks },
    });
    await touchGroupUpdatedAt(tx, roomId);
    return { ok: true, threadId, messageId: message.id, wakes, eventSeq: event.seq } as const;
  });
  if ("error" in committed) return committed;
  if ("eventSeq" in committed && committed.eventSeq !== undefined) {
    await deps.events.notify(committed.threadId, committed.eventSeq).catch((error) => {
      getLogger().error("room post realtime notification", error);
    });
  }
  for (const wake of committed.wakes) {
    if (!wake.runId) continue;
    await deps.jobs.enqueue(runContinueJob(wake.runId)).catch((error) => {
      // Queued runs are durable; the job reconciler repairs a missed immediate wake.
      getLogger().error("room post enqueue", error);
    });
  }
  return {
    ok: true,
    roomId,
    messageId: committed.messageId,
    woke: committed.wakes.map((wake) => ({ botId: wake.botId, steered: wake.steered })),
  };
}
