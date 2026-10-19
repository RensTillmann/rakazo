import { runJobKey } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { createGroupRepos } from "@rakazo/db";
import { cancelComputerRunWork } from "./computer-idle.js";
import { screenLeaseIdForRun, toComputerRef } from "./computer-lifecycle.js";
import type { ExecutorDeps } from "./executor.js";

/**
 * Archive a group and tear down its runs: cancel their jobs, stop their computer work and
 * screens, then expire the leases. The groups RPC and the `room_archive` tool share this.
 */
export async function archiveGroupWithTeardown(
  deps: Pick<ExecutorDeps, "prisma" | "jobs" | "sandbox">,
  actor: Pick<Actor, "spaceId" | "userId">,
  groupId: string,
) {
  const groupRepos = createGroupRepos(deps.prisma);
  const archived = await groupRepos.archiveGroup(actor, groupId);
  await Promise.all(
    archived.cancelledRunIds.map((runId) =>
      deps.jobs.cancel(runJobKey(runId)).catch(() => undefined),
    ),
  );
  await Promise.all(
    archived.computers.map(async (computer) => {
      if (!computer.providerRef) return;
      const adapterContext = {
        operationId: "stop",
        traceId: "stop",
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: computer.botId,
        runId: computer.runId,
        screenLeaseId: screenLeaseIdForRun(
          { runId: computer.runId, fence: computer.fence },
          computer.runId,
        ),
        cancelRunWork: true,
        signal: new AbortController().signal,
      };
      const ref = toComputerRef(computer);
      await cancelComputerRunWork(deps.sandbox, ref, computer.id, computer.runId, adapterContext);
      await deps.sandbox.releaseScreen?.(ref, adapterContext).catch(() => undefined);
    }),
  );
  // Expire the leases only after teardown: while they were live, no other run could claim
  // these screens.
  await groupRepos.releaseArchivedRunLeases(archived.cancelledRunIds);
  return { cancelledRunIds: archived.cancelledRunIds };
}
