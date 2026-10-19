import { describe, expect, it } from "vitest";
import { isWorkerRecoverOnStartEnabled, recoverOrphanedJobs } from "./orphan-recovery.js";

interface FakeJob {
  key: string | null;
  locked_by: string | null;
  identifier: string;
  payload: unknown;
}
interface FakeRun {
  id: string;
  botId: string;
  status: string;
  leaseExpiresAt: Date | null;
}

function fakeDb(jobs: FakeJob[], runs: FakeRun[]) {
  const unlocked: string[][] = [];
  const queries: string[] = [];
  const db = {
    async query(sql: string, params: unknown[] = []) {
      queries.push(sql);
      if (sql.includes("from graphile_worker._private_jobs")) {
        const own = params[0] as string[];
        return {
          rows: jobs.filter((job) => job.locked_by !== null && !own.includes(job.locked_by)),
        };
      }
      if (sql.startsWith("update runs")) {
        const run = runs.find(
          (row) => row.id === params[0] && (row.status === "leased" || row.status === "running"),
        );
        if (!run) return { rows: [] };
        run.leaseExpiresAt = new Date(0);
        return { rows: [{ id: run.id, botId: run.botId }] };
      }
      if (sql.includes("force_unlock_workers")) {
        const ids = params[0] as string[];
        unlocked.push(ids);
        for (const job of jobs)
          if (job.locked_by && ids.includes(job.locked_by)) job.locked_by = null;
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  return { db: db as never, unlocked, queries };
}

const future = new Date(Date.now() + 5 * 60_000);

describe("recoverOrphanedJobs", () => {
  it("expires the lease of a dead worker's run.continue run and unlocks that worker", async () => {
    const run: FakeRun = { id: "run-1", botId: "bot-1", status: "running", leaseExpiresAt: future };
    const jobs: FakeJob[] = [
      {
        key: "run:run-1",
        locked_by: "pool-dead",
        identifier: "run.continue",
        payload: { runId: "run-1" },
      },
    ];
    const fake = fakeDb(jobs, [run]);
    const result = await recoverOrphanedJobs({
      enabled: true,
      db: fake.db,
      ownWorkerIds: ["pool-own"],
    });
    expect(run.leaseExpiresAt?.getTime()).toBe(0);
    expect(fake.unlocked).toEqual([["pool-dead"]]);
    expect(result.recoveredRuns).toEqual([
      { runId: "run-1", botId: "bot-1", workerId: "pool-dead" },
    ]);
    expect(jobs[0]!.locked_by).toBeNull();
  });

  it("falls back to the job key when the payload has no run id", async () => {
    const run: FakeRun = { id: "run-2", botId: "bot-2", status: "leased", leaseExpiresAt: future };
    const fake = fakeDb(
      [{ key: "run:run-2", locked_by: "pool-dead", identifier: "run.continue", payload: {} }],
      [run],
    );
    await recoverOrphanedJobs({ enabled: true, db: fake.db, ownWorkerIds: ["pool-own"] });
    expect(run.leaseExpiresAt?.getTime()).toBe(0);
  });

  it("leaves jobs locked by its own ids untouched", async () => {
    const run: FakeRun = { id: "run-1", botId: "bot-1", status: "running", leaseExpiresAt: future };
    const jobs: FakeJob[] = [
      { key: "run:run-1", locked_by: "pool-own", identifier: "run.continue", payload: {} },
    ];
    const fake = fakeDb(jobs, [run]);
    const result = await recoverOrphanedJobs({
      enabled: true,
      db: fake.db,
      ownWorkerIds: ["pool-own", "worker-own"],
    });
    expect(run.leaseExpiresAt).toBe(future);
    expect(fake.unlocked).toEqual([]);
    expect(jobs[0]!.locked_by).toBe("pool-own");
    expect(result).toEqual({ deadWorkerIds: [], recoveredRuns: [] });
  });

  it("does nothing when the setting is off", async () => {
    const run: FakeRun = { id: "run-1", botId: "bot-1", status: "running", leaseExpiresAt: future };
    const fake = fakeDb(
      [{ key: "run:run-1", locked_by: "pool-dead", identifier: "run.continue", payload: {} }],
      [run],
    );
    await recoverOrphanedJobs({ enabled: false, db: fake.db, ownWorkerIds: ["pool-own"] });
    expect(fake.queries).toEqual([]);
    expect(run.leaseExpiresAt).toBe(future);
    expect(isWorkerRecoverOnStartEnabled({})).toBe(false);
    expect(isWorkerRecoverOnStartEnabled({ RAKAZO_WORKER_RECOVER_ON_START: "true" })).toBe(true);
  });

  it("does nothing when its own worker id is unknown", async () => {
    const fake = fakeDb(
      [{ key: "run:run-1", locked_by: "pool-dead", identifier: "run.continue", payload: {} }],
      [],
    );
    await recoverOrphanedJobs({ enabled: true, db: fake.db, ownWorkerIds: [] });
    expect(fake.queries).toEqual([]);
  });

  it("unlocks a dead worker's other jobs without touching runs", async () => {
    const run: FakeRun = { id: "run-1", botId: "bot-1", status: "running", leaseExpiresAt: future };
    const jobs: FakeJob[] = [
      { key: null, locked_by: "pool-dead", identifier: "history.compact", payload: {} },
    ];
    const fake = fakeDb(jobs, [run]);
    const result = await recoverOrphanedJobs({
      enabled: true,
      db: fake.db,
      ownWorkerIds: ["pool-own"],
    });
    expect(fake.queries.some((sql) => sql.startsWith("update runs"))).toBe(false);
    expect(run.leaseExpiresAt).toBe(future);
    expect(fake.unlocked).toEqual([["pool-dead"]]);
    expect(result.recoveredRuns).toEqual([]);
  });

  it("does not expire a run that is no longer leased or running", async () => {
    const run: FakeRun = {
      id: "run-1",
      botId: "bot-1",
      status: "completed",
      leaseExpiresAt: future,
    };
    const fake = fakeDb(
      [{ key: "run:run-1", locked_by: "pool-dead", identifier: "run.continue", payload: {} }],
      [run],
    );
    const result = await recoverOrphanedJobs({
      enabled: true,
      db: fake.db,
      ownWorkerIds: ["pool-own"],
    });
    expect(run.leaseExpiresAt).toBe(future);
    expect(result.recoveredRuns).toEqual([]);
    expect(fake.unlocked).toEqual([["pool-dead"]]);
  });
});
