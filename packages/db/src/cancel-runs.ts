import { endRunCardsInTransaction } from "./approval-retire.js";
import type { Prisma } from "./client.js";

/** The caller selects authorized runs and owns the surrounding transaction and cleanup. */
export async function cancelRunsInTransaction(
  tx: Prisma.TransactionClient,
  runs: ReadonlyArray<{ id: string; taskId: string }>,
  cancelledAt: Date,
  /** What the runs' unanswered cards say once retired; the generic ended-run reason by default. */
  cardReason?: string,
): Promise<void> {
  if (runs.length === 0) return;
  const runIds = runs.map((run) => run.id);
  await tx.run.updateMany({
    where: { id: { in: runIds } },
    data: {
      status: "cancelled",
      completedAt: cancelledAt,
      leaseOwner: null,
      leaseExpiresAt: null,
    },
  });
  // The run update holds the source-run locks through commit. Recorders and
  // execution claims re-read that run under the same lock before proceeding.
  // Read source IDs before callers clear messages, and never fabricate answers. Unanswered
  // cards of these runs are retired, never left pending on an ended run.
  await endRunCardsInTransaction(tx, runIds, cardReason);
  // Cancellation fences new work, but does not prove that its owning worker has
  // drained. Only that worker's finally (or confirmed remote reconciliation) may
  // settle a running attempt; lease expiry and a local abort are not evidence.
  await tx.task.updateMany({
    where: { id: { in: runs.map((run) => run.taskId) } },
    data: { status: "cancelled" },
  });
}
