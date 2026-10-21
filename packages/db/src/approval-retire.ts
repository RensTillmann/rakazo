import type { MessageBlock } from "@rakazo/contracts";
import { MessageBlock as MessageBlockSchema } from "@rakazo/contracts";
import { isOpenAskBlock } from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import { appendEventInTransaction } from "./events.js";

/** What every client shows on a retired approval card when the effect gives no reason. */
export const RETIRED_APPROVAL_REASON =
  "No longer needed: the question this request depended on was answered, withdrawn or stopped.";

export type RetiredApprovalCard = {
  messageId: string;
  threadId: string;
  runId: string;
  /** The paused run went back to `queued`; the caller wakes it (its tool call gets the effect's result). */
  queued: boolean;
  eventSeq: number;
};

function retiredReason(result: unknown): string {
  const error =
    result && typeof result === "object" && "error" in result
      ? (result as { error?: unknown }).error
      : undefined;
  return typeof error === "string" && error.trim()
    ? `No longer needed: ${error.trim()}`
    : RETIRED_APPROVAL_REASON;
}

/**
 * Close approval cards whose effect was invalidated (its source question ended) instead of
 * leaving them pending forever. Each card is retired in its own transaction under the same
 * thread -> run -> effect locks an answer takes: the block becomes `retired` with a reason (never
 * an answer), a `thread.message.updated` event refreshes every open tab and the decision dock,
 * and the paused run is queued again when no other card of it still waits. On resume the run's
 * tool call gets the stored "no longer applies" result, exactly as after a denial.
 */
export async function retireInvalidatedApprovalCards(
  prisma: PrismaClient,
  options: { limit?: number; spaceId?: string; now?: Date } = {},
): Promise<RetiredApprovalCard[]> {
  const candidates = await prisma.externalEffect.findMany({
    where: {
      status: "invalidated",
      ...(options.spaceId ? { spaceId: options.spaceId } : {}),
      run: { status: "waiting_input" },
    },
    select: { id: true, runId: true, spaceId: true, run: { select: { threadId: true } } },
    orderBy: { updatedAt: "asc" },
    take: options.limit ?? 50,
  });
  const retired: RetiredApprovalCard[] = [];
  for (const candidate of candidates) {
    const threadId = candidate.run.threadId;
    const card = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM runs WHERE id = ${candidate.runId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM external_effects WHERE id = ${candidate.id} FOR UPDATE`;
      const effect = await tx.externalEffect.findFirst({
        where: { id: candidate.id, status: "invalidated" },
        select: { result: true },
      });
      const run = await tx.run.findFirst({
        where: { id: candidate.runId, threadId, status: "waiting_input" },
        select: { botId: true },
      });
      if (!effect || !run) return null;
      const messages = await tx.message.findMany({
        where: {
          runId: candidate.runId,
          threadId,
          role: "bot",
          blocks: { array_contains: [{ kind: "ask" }] },
        },
        orderBy: { seq: "desc" },
        select: { id: true, blocks: true },
      });
      let target: { id: string; blocks: MessageBlock[] } | null = null;
      let otherOpen = false;
      for (const message of messages) {
        const parsed = MessageBlockSchema.array().safeParse(message.blocks);
        if (!parsed.success) continue;
        for (const block of parsed.data) {
          if (!isOpenAskBlock(block)) continue;
          if (block.approvalEffectId === candidate.id && !target)
            target = { id: message.id, blocks: parsed.data };
          else otherOpen = true;
        }
      }
      if (!target) return null;
      const at = (options.now ?? new Date()).toISOString();
      const reason = retiredReason(effect.result);
      const blocks = target.blocks.map((block) =>
        block.kind === "ask" && block.approvalEffectId === candidate.id && isOpenAskBlock(block)
          ? { ...block, status: "retired" as const, retiredReason: reason, retiredAt: at }
          : block,
      );
      await tx.message.update({ where: { id: target.id }, data: { blocks } });
      const event = await appendEventInTransaction(tx, {
        spaceId: candidate.spaceId,
        threadId,
        botId: run.botId,
        type: "thread.message.updated",
        runId: candidate.runId,
        payload: { messageId: target.id, role: "bot", blocks },
      });
      const queued = otherOpen
        ? false
        : (
            await tx.run.updateMany({
              where: { id: candidate.runId, threadId, status: "waiting_input" },
              data: { status: "queued" },
            })
          ).count === 1;
      return {
        messageId: target.id,
        threadId,
        runId: candidate.runId,
        queued,
        eventSeq: event.seq,
      };
    });
    if (card) retired.push(card);
  }
  return retired;
}
