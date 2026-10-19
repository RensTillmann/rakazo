import { ACTIVE_RUN_STATUSES, isConversationalRun } from "@rakazo/core";
import type { Prisma } from "./client.js";

/** A busy bot's conversational turn that may take a new room message as steering. */
const STEERABLE_RUN_STATUSES: Record<string, true> = {
  queued: true,
  leased: true,
  running: true,
  waiting_takeover: true,
};

export type RoomWake = { botId: string; runId: string | null; steered: boolean };

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
      await tx.steeringMessage.create({
        data: {
          messageId: input.messageId,
          botId,
          userId: input.userId,
          runId: steerable?.id ?? null,
        },
      });
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
