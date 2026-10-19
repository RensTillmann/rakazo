import { getLogger, unwrapJobPayload } from "@rakazo/logging";

/** Fleet: RAKAZO_WORKER_RECOVER_ON_START. Off (unset) keeps upstream behaviour. */
export function isWorkerRecoverOnStartEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RAKAZO_WORKER_RECOVER_ON_START === "true";
}

/** The subset of pg.Pool the recovery needs; a fake in tests. */
export interface OrphanRecoveryDb {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Row[] }>;
}

export interface OrphanRecoveryResult {
  deadWorkerIds: string[];
  recoveredRuns: { runId: string; botId: string; workerId: string }[];
}

function runIdOf(key: string | null, payload: unknown): string | undefined {
  const unpacked = unwrapJobPayload(payload).payload;
  if (
    unpacked &&
    typeof unpacked === "object" &&
    "runId" in unpacked &&
    typeof unpacked.runId === "string" &&
    unpacked.runId
  ) {
    return unpacked.runId;
  }
  return key?.startsWith("run:") ? key.slice("run:".length) || undefined : undefined;
}

/**
 * Start-up only. The deployment runs one worker service, so a graphile job still
 * locked by another worker id belongs to a dead process (graphile frees such locks
 * only after 4 hours). Expire the lease of each `run.continue` job's run so
 * continueRun reclaims it at once (the fence stays), then free the locks through
 * graphile's public force_unlock_workers.
 */
export async function recoverOrphanedJobs(input: {
  enabled: boolean;
  db: OrphanRecoveryDb;
  ownWorkerIds: readonly string[];
}): Promise<OrphanRecoveryResult> {
  const result: OrphanRecoveryResult = { deadWorkerIds: [], recoveredRuns: [] };
  if (!input.enabled) return result;
  // Without our own ids we cannot tell dead workers from ourselves: do nothing.
  if (input.ownWorkerIds.length === 0) {
    getLogger().warn("worker orphan recovery skipped: own worker id unknown");
    return result;
  }
  const { rows } = await input.db.query<{
    key: string | null;
    locked_by: string;
    identifier: string;
    payload: unknown;
  }>(
    `select jobs.key, jobs.locked_by, tasks.identifier, jobs.payload
     from graphile_worker._private_jobs as jobs
     join graphile_worker._private_tasks as tasks on tasks.id = jobs.task_id
     where jobs.locked_by is not null and not (jobs.locked_by = any($1::text[]))`,
    [[...input.ownWorkerIds]],
  );
  const dead = new Set<string>();
  for (const job of rows) {
    dead.add(job.locked_by);
    if (job.identifier !== "run.continue") continue;
    const runId = runIdOf(job.key, job.payload);
    if (!runId) continue;
    const expired = await input.db.query<{ id: string; botId: string }>(
      `update runs set "leaseExpiresAt" = now(), "updatedAt" = now()
       where id = $1 and status in ('leased', 'running')
       returning id, "botId"`,
      [runId],
    );
    const run = expired.rows[0];
    if (!run) continue;
    result.recoveredRuns.push({ runId: run.id, botId: run.botId, workerId: job.locked_by });
    getLogger().info("worker orphan recovery: run lease expired", {
      runId: run.id,
      botId: run.botId,
      oldWorkerId: job.locked_by,
    });
  }
  result.deadWorkerIds = [...dead];
  if (result.deadWorkerIds.length > 0) {
    await input.db.query("select graphile_worker.force_unlock_workers($1::text[])", [
      result.deadWorkerIds,
    ]);
  }
  getLogger().info("worker orphan recovery done", {
    recoveredRuns: result.recoveredRuns.length,
    deadWorkers: result.deadWorkerIds.length,
  });
  return result;
}
