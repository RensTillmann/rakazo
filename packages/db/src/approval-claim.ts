import { MessageBlock as MessageBlockSchema } from "@rakazo/contracts";
import { isApprovalAskBlock, isSecretAskBlock } from "@rakazo/core";
import { invalidatePendingApprovalEffect } from "./approval-invalidation.js";
import type { PrismaClient } from "./client.js";

/** Claim is the execution linearization point. Source endings and recording take
 * the same source-thread -> source-run locks; the effect CAS comes last. Never
 * lock the effect first and then wait on a source lock held by invalidation.
 * This does not roll back an external call whose claim already won.
 */
export async function claimSourceCheckedEffect(
  db: PrismaClient,
  run: { id: string; spaceId: string; botId: string; userId?: string },
  effectId: string,
  from: "intended" | "approved",
): Promise<boolean> {
  if (!run.userId) return false;
  const userId = run.userId;
  return db.$transaction(async (tx) => {
    const effect = await tx.externalEffect.findFirst({
      where: {
        id: effectId,
        runId: run.id,
        spaceId: run.spaceId,
        run: { userId, botId: run.botId },
      },
      select: { sourceMessageId: true, status: true },
    });
    if (!effect || effect.status !== from) return false;
    const sourceMessageId = effect.sourceMessageId;
    if (sourceMessageId) {
      const ownership = {
        id: sourceMessageId,
        botId: run.botId,
        role: "bot",
        thread: { spaceId: run.spaceId, userId },
      };
      const candidate = await tx.message.findFirst({
        where: ownership,
        select: { threadId: true, runId: true },
      });
      const invalidate = async () => {
        await invalidatePendingApprovalEffect(tx, effectId, sourceMessageId);
        return false;
      };
      if (!candidate?.runId) return invalidate();
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${candidate.threadId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM runs WHERE id = ${candidate.runId} FOR UPDATE`;
      const source = await tx.message.findFirst({
        where: { ...ownership, threadId: candidate.threadId, runId: candidate.runId },
        select: { blocks: true },
      });
      const blocks = MessageBlockSchema.array().safeParse(source?.blocks);
      const asks = blocks.success ? blocks.data.filter((block) => block.kind === "ask") : [];
      const ask = asks[0];
      if (
        asks.length !== 1 ||
        !ask ||
        ask.status === "answered" ||
        ask.answer !== undefined ||
        ask.answeredBy ||
        ask.syncedFrom ||
        ask.draftFinal !== undefined ||
        ask.approvalEffectId ||
        isApprovalAskBlock(ask) ||
        isSecretAskBlock(ask) ||
        ask.credential ||
        ask.instructionUpdate
      )
        return invalidate();
      const sourceRun = await tx.run.findFirst({
        where: {
          id: candidate.runId,
          threadId: candidate.threadId,
          spaceId: run.spaceId,
          userId,
          botId: run.botId,
          status: "waiting_input",
        },
        select: { id: true },
      });
      if (!sourceRun) return invalidate();
    }
    const claimed = await tx.externalEffect.updateMany({
      where: { id: effectId, runId: run.id, spaceId: run.spaceId, status: from, sourceMessageId },
      data: { status: "executing" },
    });
    return claimed.count === 1;
  });
}
