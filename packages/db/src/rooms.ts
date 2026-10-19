import { ACTIVE_RUN_STATUSES, isConversationalRun, roomMaxRunsPerDay } from "@rakazo/core";
import type { Prisma } from "./client.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The room brake. A paused room starts no bot-started runs. Otherwise the runs this group
 * thread started in the last 24 hours (or since the last resume, if later) are counted
 * against `RAKAZO_ROOM_MAX_RUNS_PER_DAY`; reaching it pauses the room. Runs from the
 * user's own messages count but are never refused, so they do not call this.
 */
export async function roomRunAllowedInTransaction(
  tx: Prisma.TransactionClient,
  input: { groupId: string; threadId: string },
  now = new Date(),
): Promise<boolean> {
  const group = await tx.chatGroup.findUnique({
    where: { id: input.groupId },
    select: { pausedAt: true, budgetResetAt: true },
  });
  if (!group || group.pausedAt) return false;
  const max = roomMaxRunsPerDay();
  if (max === undefined) return true;
  const dayAgo = new Date(now.getTime() - DAY_MS);
  const since = group.budgetResetAt && group.budgetResetAt > dayAgo ? group.budgetResetAt : dayAgo;
  const started = await tx.run.count({
    where: { threadId: input.threadId, createdAt: { gte: since } },
  });
  if (started < max) return true;
  await tx.chatGroup.update({ where: { id: input.groupId }, data: { pausedAt: now } });
  return false;
}

/** A busy bot's conversational turn that may take a new room message as steering. */
const STEERABLE_RUN_STATUSES: Record<string, true> = {
  queued: true,
  leased: true,
  running: true,
  waiting_takeover: true,
};

/** `paused`: the room brake refused the run this wake needed. */
export type RoomWake = { botId: string; runId: string | null; steered: boolean; paused?: true };

/**
 * Wakes group members for a message a bot wrote in the shared thread (a room post, a
 * mention or a handoff). A member with an active run in this thread is steered instead of
 * getting a second run: a conversational turn takes the message directly, any other turn
 * (a routine, a pending ask) keeps it as pending steering for its continuation. Only idle
 * members get a new `follow_up` run sourced from the message. `runNonce` deduplicates the
 * new runs when the same wake is replayed.
 */
export async function wakeGroupMembersInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    groupId: string;
    spaceId: string;
    userId: string;
    threadId: string;
    messageId: string;
    botIds: string[];
    prompt: string;
    runNonce?: (botId: string) => string;
  },
): Promise<RoomWake[]> {
  const botIds = [...new Set(input.botIds)];
  if (botIds.length === 0) return [];
  const activeRuns = await tx.run.findMany({
    where: {
      threadId: input.threadId,
      botId: { in: botIds },
      status: { in: [...ACTIVE_RUN_STATUSES] },
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, botId: true, status: true, trigger: true },
  });
  const wakes: RoomWake[] = [];
  for (const botId of botIds) {
    const active = activeRuns.filter((run) => run.botId === botId);
    if (active.length) {
      const steerable = active.find(
        (run) => STEERABLE_RUN_STATUSES[run.status] === true && isConversationalRun(run.trigger),
      );
      const alreadySteered = await tx.steeringMessage.findFirst({
        where: { messageId: input.messageId, botId },
        select: { id: true },
      });
      if (!alreadySteered) {
        await tx.steeringMessage.create({
          data: {
            messageId: input.messageId,
            botId,
            userId: input.userId,
            runId: steerable?.id ?? null,
          },
        });
      }
      wakes.push({ botId, runId: steerable?.id ?? active[0]?.id ?? null, steered: true });
      continue;
    }
    const clientNonce = input.runNonce?.(botId);
    if (clientNonce) {
      const replayed = await tx.run.findUnique({
        where: { spaceId_clientNonce: { spaceId: input.spaceId, clientNonce } },
        select: { id: true },
      });
      if (replayed) {
        wakes.push({ botId, runId: replayed.id, steered: false });
        continue;
      }
    }
    if (!(await roomRunAllowedInTransaction(tx, input))) {
      wakes.push({ botId, runId: null, steered: false, paused: true });
      continue;
    }
    const task = await tx.task.create({
      data: {
        spaceId: input.spaceId,
        botId,
        threadId: input.threadId,
        userId: input.userId,
        prompt: input.prompt,
        status: "queued",
      },
    });
    const run = await tx.run.create({
      data: {
        spaceId: input.spaceId,
        botId,
        threadId: input.threadId,
        taskId: task.id,
        userId: input.userId,
        status: "queued",
        trigger: "follow_up",
        sourceMessageId: input.messageId,
        ...(clientNonce ? { clientNonce } : {}),
      },
      select: { id: true },
    });
    wakes.push({ botId, runId: run.id, steered: false });
  }
  return wakes;
}
