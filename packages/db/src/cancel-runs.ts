import { invalidateSourceApprovalEffects } from "./approval-invalidation.js";
import type { Prisma } from "./client.js";

/** The caller selects authorized runs and owns the surrounding transaction and cleanup. */
export async function cancelRunsInTransaction(
  tx: Pick<Prisma.TransactionClient, "run" | "attempt" | "task" | "message" | "externalEffect">,
  runs: ReadonlyArray<{ id: string; taskId: string }>,
  cancelledAt: Date,
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
  // Read source IDs before callers clear messages, and never fabricate answers.
  const sources = await tx.message.findMany({
    where: { runId: { in: runIds } },
    select: { id: true, thread: { select: { spaceId: true } } },
    orderBy: { id: "asc" },
  });
  for (const source of sources) {
    await invalidateSourceApprovalEffects(tx, source.thread.spaceId, source.id);
  }
  await tx.attempt.updateMany({
    where: { runId: { in: runIds }, status: "running" },
    data: { status: "cancelled", finishedAt: cancelledAt },
  });
  await tx.task.updateMany({
    where: { id: { in: runs.map((run) => run.taskId) } },
    data: { status: "cancelled" },
  });
}
