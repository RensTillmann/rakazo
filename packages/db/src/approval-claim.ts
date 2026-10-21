import { MessageBlock as MessageBlockSchema } from "@rakazo/contracts";
import { isApprovalAskBlock, isSecretAskBlock } from "@rakazo/core";
import { invalidatePendingApprovalEffect } from "./approval-invalidation.js";
import type { PrismaClient } from "./client.js";

/** Recover only the exact persisted route-bound withdrawal envelopes. Old plain
 * arguments and unbound catalog envelopes cannot establish tool/resource identity
 * and retain their existing replay checks; never guess from a display name.
 */
function legacySourceMessageId(request: unknown): string | undefined {
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  if (!Array.isArray(request) || request[0] !== "__rakazoCatalogTool") return undefined;
  let route: unknown;
  let args: unknown;
  if (request.length === 3 && request[1] === "direct" && object(request[2])) {
    route = request[2].route;
    args = request[2].args;
  } else if (
    request.length === 4 &&
    (request[1] === "connectors_execute_tool" || request[1] === "mcp_execute_tool") &&
    object(request[2])
  ) {
    route = request[3];
    args = request[2].arguments;
    if (!object(route) || request[2].id !== `${route.resourceId}:question_withdraw`)
      return undefined;
  } else return undefined;
  if (
    !object(route) ||
    route.connectorId !== "mcp" ||
    route.toolName !== "question_withdraw" ||
    typeof route.resourceId !== "string" ||
    route.resourceId.length === 0 ||
    (route.resourceRevision !== undefined &&
      typeof route.resourceRevision !== "string" &&
      typeof route.resourceRevision !== "number") ||
    !object(args)
  )
    return undefined;
  const id = args.message_id;
  return typeof id === "string" && id.length > 0 && id.trim() === id ? id : undefined;
}

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
      select: { sourceMessageId: true, status: true, request: true },
    });
    if (!effect || effect.status !== from) return false;
    const storedSourceMessageId = effect.sourceMessageId;
    const sourceMessageId = storedSourceMessageId ?? legacySourceMessageId(effect.request);
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
      where: {
        id: effectId,
        runId: run.id,
        spaceId: run.spaceId,
        status: from,
        sourceMessageId: storedSourceMessageId,
      },
      data: {
        status: "executing",
        ...(sourceMessageId && !storedSourceMessageId ? { sourceMessageId } : {}),
      },
    });
    return claimed.count === 1;
  });
}
