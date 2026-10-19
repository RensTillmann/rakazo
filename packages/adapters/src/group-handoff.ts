import { runContinueJob } from "@rakazo/adapter-kit";
import { MessageBlock } from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  botMessageHopExhausted,
  capRoomWakes,
  nextBotMessageHop,
  renderGroupMembersContext,
  resolveBotMentionedGroupBotIds,
} from "@rakazo/core";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  IsolationError,
  lockOwnedGroup,
  type PrismaClient,
  roomRunAllowedInTransaction,
  touchGroupUpdatedAt,
  wakeGroupMembersInTransaction,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./executor.js";

const ROOM_PAUSED_ERROR =
  "this room reached its daily run budget and is paused; post the result here instead, and use room_resume or ask Rens to resume it";

export async function handoffToGroupBot(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs">,
  run: {
    id: string;
    spaceId: string;
    threadId: string;
    botId: string;
    userId: string;
  },
  groupId: string,
  input: { bot_id?: string; confirm_name?: string; message: string },
) {
  const deliveryKey = `group-handoff:${run.id}`;
  const committed = await deps.prisma.$transaction(async (tx) => {
    try {
      await lockOwnedGroup(tx, run, groupId);
    } catch (error) {
      if (error instanceof IsolationError)
        return { error: "group is no longer available" } as const;
      throw error;
    }
    const [group, activeSource] = await Promise.all([
      tx.chatGroup.findFirst({
        where: { id: groupId, archivedAt: null, thread: { id: run.threadId } },
        include: {
          members: {
            where: { bot: { archivedAt: null } },
            include: { bot: { select: { id: true, name: true } } },
            orderBy: { createdAt: "asc" },
          },
        },
      }),
      tx.run.findFirst({
        where: {
          id: run.id,
          spaceId: run.spaceId,
          threadId: run.threadId,
          botId: run.botId,
          userId: run.userId,
          status: "running",
        },
        select: { id: true, sourceMessage: { select: { blocks: true } } },
      }),
    ]);
    if (!group || !activeSource) return { error: "source run is no longer active" } as const;
    if (!group.members.some((member) => member.bot.id === run.botId)) {
      return { error: "source bot is no longer a group member" } as const;
    }

    const existing = await tx.message.findUnique({
      where: { threadId_clientNonce: { threadId: run.threadId, clientNonce: deliveryKey } },
      select: {
        id: true,
        sourceRuns: {
          orderBy: { createdAt: "asc" },
          take: 1,
          select: { id: true, botId: true },
        },
        steeringMessages: { take: 1, select: { botId: true, runId: true } },
      },
    });
    if (existing) {
      const nextRun = existing.sourceRuns[0];
      const steered = existing.steeringMessages[0];
      const event = await tx.event.findFirst({
        where: { threadId: run.threadId, runId: run.id, type: "group.handoff" },
        orderBy: { seq: "desc" },
        select: { seq: true },
      });
      if (!event) return { error: "recorded handoff is incomplete" } as const;
      if (nextRun) {
        return {
          ok: true,
          botId: nextRun.botId,
          runId: nextRun.id,
          steered: false,
          eventSeq: event.seq,
        } as const;
      }
      if (!steered) return { error: "recorded handoff is incomplete" } as const;
      return {
        ok: true,
        botId: steered.botId,
        runId: steered.runId,
        steered: true,
        eventSeq: event.seq,
      } as const;
    }

    let targetId = input.bot_id?.trim();
    if (!targetId && input.confirm_name?.trim()) {
      const name = input.confirm_name.trim().toLowerCase();
      targetId = group.members.find((member) => member.bot.name.toLowerCase() === name)?.bot.id;
    }
    if (!targetId) return { error: "handoff target bot is required" } as const;
    if (targetId === run.botId) return { error: "cannot hand off to yourself" } as const;
    if (!group.members.some((member) => member.bot.id === targetId)) {
      return { error: "handoff target is not a group member" } as const;
    }

    let sourceBlocks: MessageBlock[] = [];
    if (activeSource.sourceMessage) {
      const parsedSource = MessageBlock.array().safeParse(activeSource.sourceMessage.blocks);
      if (!parsedSource.success) {
        return { error: "cannot verify the group handoff chain" } as const;
      }
      sourceBlocks = parsedSource.data;
    }
    const sourceHandoff = sourceBlocks.find(
      (block): block is Extract<MessageBlock, { kind: "handoff" }> => block.kind === "handoff",
    );
    if (sourceHandoff?.fromBotId === targetId) {
      return {
        error:
          "do not hand this stage back to its sender; post the result in the shared thread instead",
      } as const;
    }
    const hop = nextBotMessageHop(sourceHandoff?.hop);
    if (botMessageHopExhausted(hop)) {
      return {
        error:
          "group handoff limit reached for this chain; finish the current stage in the shared thread instead",
      } as const;
    }

    // Check the brake before posting the handoff: a refused run must not leave a handoff
    // block behind, and the pause it sets has to commit. A busy target is steered instead.
    const targetBusy = await tx.run.findFirst({
      where: {
        threadId: run.threadId,
        botId: targetId,
        status: { in: [...ACTIVE_RUN_STATUSES] },
      },
      select: { id: true },
    });
    if (
      !targetBusy &&
      !(await roomRunAllowedInTransaction(tx, { groupId, threadId: run.threadId }))
    ) {
      return { error: ROOM_PAUSED_ERROR } as const;
    }

    const handoffBlock: MessageBlock = {
      kind: "handoff",
      fromBotId: run.botId,
      toBotId: targetId,
      text: input.message,
      hop,
    };
    const message = await createThreadMessageInTransaction(tx, {
      threadId: run.threadId,
      role: "bot",
      blocks: [handoffBlock],
      botId: run.botId,
      runId: run.id,
      clientNonce: deliveryKey,
    });
    const [wake] = await wakeGroupMembersInTransaction(tx, {
      groupId,
      spaceId: run.spaceId,
      userId: run.userId,
      threadId: run.threadId,
      messageId: message.id,
      botIds: [targetId],
      prompt: input.message,
    });
    if (!wake || wake.paused) return { error: ROOM_PAUSED_ERROR } as const;
    const event = await appendEventInTransaction(tx, {
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      type: "group.handoff",
      runId: run.id,
      payload: {
        messageId: message.id,
        fromBotId: run.botId,
        toBotId: targetId,
        text: input.message,
      },
    });
    await touchGroupUpdatedAt(tx, groupId);
    return {
      ok: true,
      botId: targetId,
      runId: wake.runId,
      steered: wake.steered,
      eventSeq: event.seq,
    } as const;
  });
  if ("error" in committed) return committed;
  await deps.events.notify(run.threadId, committed.eventSeq).catch((error) => {
    getLogger().error("group handoff realtime notification", error);
  });
  if (committed.runId && !committed.steered) {
    await deps.jobs.enqueue(runContinueJob(committed.runId)).catch((error) => {
      // The queued run is durable and the job reconciler will repair a missed immediate wake.
      getLogger().error("group handoff enqueue", error);
    });
  }
  return {
    ok: true,
    botId: committed.botId,
    runId: committed.runId,
    note: committed.steered
      ? "Handoff recorded. The next bot is already working here and got it as steering. End this turn without narrating it."
      : "Handoff recorded. End this turn without narrating it; the next bot owns the next stage.",
  };
}

/**
 * A bot's final group reply wakes the members it @-mentions. Nobody named wakes nobody (no
 * first-member fallback), the author never wakes itself, and a member already busy in this
 * thread is steered. The run nonce `group-mention:<runId>:<botId>` makes a replay a no-op.
 */
export async function wakeMentionedGroupMembers(
  deps: Pick<ExecutorDeps, "prisma" | "jobs">,
  run: { id: string; spaceId: string; threadId: string; botId: string; userId: string },
  groupId: string,
  text: string,
) {
  if (!text.includes("@")) return [];
  const wakes = await deps.prisma.$transaction(async (tx) => {
    try {
      await lockOwnedGroup(tx, run, groupId);
    } catch (error) {
      if (error instanceof IsolationError) return [];
      throw error;
    }
    const group = await tx.chatGroup.findFirst({
      where: { id: groupId, archivedAt: null, pausedAt: null, thread: { id: run.threadId } },
      select: {
        members: {
          where: { bot: { archivedAt: null } },
          orderBy: [{ createdAt: "asc" }, { botId: "asc" }],
          select: { bot: { select: { id: true, name: true } } },
        },
      },
    });
    if (!group) return [];
    const targets = capRoomWakes(
      resolveBotMentionedGroupBotIds({
        text,
        members: group.members.map((member) => member.bot),
        authorBotId: run.botId,
      }),
    );
    if (targets.length === 0) return [];
    const reply = await tx.message.findFirst({
      where: { threadId: run.threadId, runId: run.id, role: "bot", botId: run.botId },
      orderBy: { seq: "desc" },
      select: { id: true },
    });
    if (!reply) return [];
    const woken = await wakeGroupMembersInTransaction(tx, {
      groupId,
      spaceId: run.spaceId,
      userId: run.userId,
      threadId: run.threadId,
      messageId: reply.id,
      botIds: targets,
      prompt: text,
      runNonce: (botId) => `group-mention:${run.id}:${botId}`,
    });
    await touchGroupUpdatedAt(tx, groupId);
    return woken;
  });
  for (const wake of wakes) {
    if (!wake.runId || wake.steered) continue;
    await deps.jobs.enqueue(runContinueJob(wake.runId)).catch((error) => {
      // The queued run is durable and the job reconciler will repair a missed immediate wake.
      getLogger().error("group mention enqueue", error);
    });
  }
  return wakes;
}

export async function loadGroupContext(
  prisma: PrismaClient,
  groupId: string,
  self: { id: string; name: string },
): Promise<string | undefined> {
  const group = await prisma.chatGroup.findUnique({
    where: { id: groupId },
    include: {
      members: {
        where: { bot: { archivedAt: null } },
        include: {
          bot: { select: { id: true, name: true, title: true, description: true } },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!group) return undefined;
  return renderGroupMembersContext(
    group.name,
    group.members.map((member) => member.bot),
    self,
  );
}
