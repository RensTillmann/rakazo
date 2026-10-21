/**
 * Terminal non-answer for a dependent approval. The caller must authorize and bind
 * the source/effect pair and own the source-question transaction/locks. This CAS
 * alone does not validate a source, refresh cards or fence an already won claim.
 */
export async function invalidatePendingApprovalEffect(
  store: {
    externalEffect: {
      updateMany: (args: {
        where: { id: string; status: { in: string[] } };
        data: {
          status: string;
          result: {
            error: string;
            invalidated: boolean;
            reason: string;
            sourceMessageId: string;
          };
        };
      }) => Promise<{ count: number }>;
    };
  },
  effectId: string,
  sourceMessageId: string,
): Promise<boolean> {
  const changed = await store.externalEffect.updateMany({
    where: { id: effectId, status: { in: ["intended", "approved"] } },
    data: {
      status: "invalidated",
      result: {
        error: "This approval no longer applies because its source question is no longer pending.",
        invalidated: true,
        reason: "source_question_unavailable",
        sourceMessageId,
      },
    },
  });
  return changed.count === 1;
}

/** End only effects explicitly bound to this source in this space. Execute inside
 * the authorized source lifecycle transaction, never as a later best-effort job.
 * This does not reconcile legacy envelopes or fence already executing effects.
 */
export async function invalidateSourceApprovalEffects(
  tx: Pick<import("./client.js").Prisma.TransactionClient, "externalEffect">,
  spaceId: string,
  sourceMessageId: string,
): Promise<number> {
  const changed = await tx.externalEffect.updateMany({
    where: { spaceId, sourceMessageId, status: { in: ["intended", "approved"] } },
    data: {
      status: "invalidated",
      result: {
        error: "This approval no longer applies because its source question is no longer pending.",
        invalidated: true,
        reason: "source_question_unavailable",
        sourceMessageId,
      },
    },
  });
  return changed.count;
}
