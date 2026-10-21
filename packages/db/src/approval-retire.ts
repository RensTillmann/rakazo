import type { MessageBlock } from "@rakazo/contracts";
import { MessageBlock as MessageBlockSchema } from "@rakazo/contracts";
import { isOpenAskBlock } from "@rakazo/core";
import { invalidateRunSourceApprovalEffects } from "./approval-invalidation.js";
import type { Prisma, PrismaClient } from "./client.js";
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

/** What a card says when its run ended while it still waited for an answer. */
export const ENDED_RUN_CARD_REASON = "Its run ended without an answer";

/** Retires every still-open ask block of `blocks`; null when none was open. */
function retireOpenAsks(blocks: unknown, reason: string, at: string): MessageBlock[] | null {
  const parsed = MessageBlockSchema.array().safeParse(blocks);
  if (!parsed.success || !parsed.data.some(isOpenAskBlock)) return null;
  return parsed.data.map((block) =>
    isOpenAskBlock(block)
      ? { ...block, status: "retired" as const, retiredReason: reason, retiredAt: at }
      : block,
  );
}

/**
 * Runs just ended (cancelled, stopped, withdrawn, expired): end their cards in the same
 * transaction. Dependent approval requests bound to their questions are invalidated, and every
 * card of theirs still waiting for an answer, questions and approvals alike, is retired with
 * `reason` (never answered) and a `thread.message.updated` event refreshes open tabs. Call after
 * the caller's cancellation won and before it deletes any message.
 */
export async function endRunCardsInTransaction(
  tx: Prisma.TransactionClient,
  runIds: readonly string[],
  reason: string = ENDED_RUN_CARD_REASON,
): Promise<void> {
  if (runIds.length === 0) return;
  await invalidateRunSourceApprovalEffects(tx, runIds);
  const cards = await tx.message.findMany({
    where: {
      runId: { in: [...runIds] },
      role: "bot",
      blocks: { array_contains: [{ kind: "ask" }] },
    },
    select: {
      id: true,
      threadId: true,
      botId: true,
      blocks: true,
      thread: { select: { spaceId: true } },
    },
    orderBy: { seq: "asc" },
  });
  const at = new Date().toISOString();
  for (const card of cards) {
    const blocks = retireOpenAsks(card.blocks, reason, at);
    if (!blocks || !card.botId) continue;
    await tx.message.update({ where: { id: card.id }, data: { blocks } });
    // The run has ended, so the update belongs to the thread, not to that run.
    await appendEventInTransaction(tx, {
      spaceId: card.thread.spaceId,
      threadId: card.threadId,
      botId: card.botId,
      type: "thread.message.updated",
      payload: { messageId: card.id, role: "bot", blocks },
    });
  }
}

export type RetiredEndedRunCard = { messageId: string; threadId: string; eventSeq: number };

/**
 * Cards left open on runs that already ended, from before cards were ended with their run or by a
 * path that missed it: each is retired with `ENDED_RUN_CARD_REASON` under its thread lock. The
 * run's own state is never changed.
 */
export async function retireEndedRunCards(
  prisma: PrismaClient,
  options: { spaceId?: string; limit?: number } = {},
): Promise<RetiredEndedRunCard[]> {
  const ended = ["cancelled", "completed", "failed"];
  // Open cards are few (answered and retired ones are excluded), so they are read first.
  const open = await prisma.message.findMany({
    where: {
      role: "bot",
      blocks: { array_contains: [{ kind: "ask" }] },
      NOT: [
        { blocks: { array_contains: [{ kind: "ask", status: "answered" }] } },
        { blocks: { array_contains: [{ kind: "ask", status: "retired" }] } },
      ],
      ...(options.spaceId ? { thread: { spaceId: options.spaceId } } : {}),
    },
    select: { id: true, threadId: true, runId: true, blocks: true },
    orderBy: { createdAt: "asc" },
    take: 500,
  });
  const openCards = open.filter((message) => {
    const parsed = MessageBlockSchema.array().safeParse(message.blocks);
    return message.runId && parsed.success && parsed.data.some(isOpenAskBlock);
  });
  if (openCards.length === 0) return [];
  const endedRuns = new Set(
    (
      await prisma.run.findMany({
        where: { id: { in: openCards.map((message) => message.runId!) }, status: { in: ended } },
        select: { id: true },
      })
    ).map((run) => run.id),
  );
  const candidates = openCards
    .filter((message) => endedRuns.has(message.runId!))
    .slice(0, options.limit ?? 50);
  const retired: RetiredEndedRunCard[] = [];
  for (const candidate of candidates) {
    const card = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${candidate.threadId} FOR UPDATE`;
      const message = await tx.message.findFirst({
        where: { id: candidate.id, runId: candidate.runId },
        select: { blocks: true, botId: true, thread: { select: { spaceId: true } } },
      });
      const runEnded = await tx.run.count({
        where: { id: candidate.runId!, status: { in: ended } },
      });
      if (!runEnded) return null;
      const blocks = message
        ? retireOpenAsks(message.blocks, ENDED_RUN_CARD_REASON, new Date().toISOString())
        : null;
      if (!message?.botId || !blocks) return null;
      await tx.message.update({ where: { id: candidate.id }, data: { blocks } });
      const event = await appendEventInTransaction(tx, {
        spaceId: message.thread.spaceId,
        threadId: candidate.threadId,
        botId: message.botId,
        type: "thread.message.updated",
        payload: { messageId: candidate.id, role: "bot", blocks },
      });
      return { messageId: candidate.id, threadId: candidate.threadId, eventSeq: event.seq };
    });
    if (card) retired.push(card);
  }
  return retired;
}
