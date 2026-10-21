import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  createMaintenanceStore,
  MaintenanceConflictError,
  lockMaintenanceAdmission,
  claimMaintenanceEffect,
  checkpointMaintenanceRun,
  resumeMaintenanceRun,
} from "./maintenance.js";

const enter = { action: "enter" as const, expectedRevision: 0, requestId: "first" };
function fixture(
  options: {
    owner?: string | null;
    state?: { active: boolean; revision: number } | null;
    replay?: Record<string, unknown>;
    failAudit?: boolean;
    activity?: { activeRuns: number; activeEffects: number; pendingRuns: number; issues: string[] };
    fleet?: { activeEffects: number; uncertain: boolean; stalled: boolean };
    failFleet?: "lookup" | "aggregate";
  } = {},
) {
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    queries.push({ sql, values });
    if (options.failFleet === "lookup" && sql.includes("to_regclass")) throw new Error("lookup denied");
    if (options.failFleet === "aggregate" && sql.includes("FROM fleet.service_effects")) throw new Error("ledger denied");
    if (sql.includes("to_regclass")) return { rows: [{ relation: options.fleet ? "fleet.service_effects" : null }] };
    if (sql.includes("FROM fleet.service_effects")) return { rows: [options.fleet] };
    if (sql.includes('LEFT JOIN "maintenance_state"')) {
      return {
        rows: [
          {
            ownerUserId: options.owner === undefined ? "operator" : options.owner,
            active: options.state === null ? null : (options.state?.active ?? false),
            revision: options.state === null ? null : (options.state?.revision ?? 0),
            ...(options.activity ?? { activeRuns: 0, activeEffects: 0, pendingRuns: 0, issues: [] }),
          },
        ],
      };
    }
    if (sql.includes("deployment_settings")) {
      return { rows: [{ ownerUserId: options.owner === undefined ? "operator" : options.owner }] };
    }
    if (sql.startsWith("SELECT") && sql.includes("maintenance_state")) {
      return {
        rows: options.state === null ? [] : [options.state ?? { active: false, revision: 0 }],
      };
    }
    if (sql.startsWith("SELECT") && sql.includes("maintenance_audit")) {
      return { rows: options.replay ? [options.replay] : [] };
    }
    if (sql.includes("INSERT INTO") && options.failAudit) throw new Error("audit unavailable");
    return { rows: [] };
  });
  const release = vi.fn();
  const pool = { query, connect: vi.fn(async () => ({ query, release })) };
  return { store: createMaintenanceStore(pool as unknown as Pool), pool, queries, release };
}

describe("durable maintenance control transaction", () => {
  it("reads status without writing state or routines", async () => {
    const f = fixture({ state: { active: true, revision: 4 } });
    expect(await f.store.status()).toEqual({ active: true, revision: 4 });
    expect(f.pool.connect).not.toHaveBeenCalled();
    expect(f.queries).toHaveLength(1);
  });
  it("fails closed if the singleton is missing", async () => {
    const f = fixture({ state: null });
    await expect(f.store.status()).rejects.toThrow("unavailable");
    await expect(f.store.change("operator", enter)).rejects.toThrow("unavailable");
    expect(f.queries.at(-1)?.sql).toBe("ROLLBACK");
    expect(f.release).toHaveBeenCalledOnce();
  });
  it.each([null, "other"])("rejects non-owner (stored owner %s)", async (owner) => {
    const f = fixture({ owner });
    await expect(f.store.change("operator", enter)).rejects.toThrow("owner required");
    expect(f.queries.some((q) => q.sql.includes("maintenance_state"))).toBe(false);
    expect(f.queries.at(-1)?.sql).toBe("ROLLBACK");
  });
  it("locks owner then state and commits state plus audit in one transaction", async () => {
    const f = fixture();
    expect(await f.store.change("operator", enter)).toEqual({
      state: { active: true, revision: 1 },
      replayed: false,
    });
    expect(f.queries[0]?.sql).toBe("BEGIN");
    expect(f.queries[1]?.sql).toContain("FOR SHARE");
    expect(f.queries[2]?.sql).toContain("pg_advisory_xact_lock");
    expect(f.queries[3]?.sql).toContain("FOR UPDATE");
    expect(f.queries[5]?.values).toEqual([true, 1]);
    expect(f.queries[6]?.values).toEqual([1, "first", "operator", "enter", 0, true]);
    expect(f.queries.at(-1)?.sql).toBe("COMMIT");
    expect(f.release).toHaveBeenCalledOnce();
  });
  it("explicit resume changes only maintenance, not independent holds", async () => {
    const f = fixture({ state: { active: true, revision: 7 } });
    const result = await f.store.change("operator", {
      requestId: "resume",
      action: "resume",
      expectedRevision: 7,
    });
    expect(result.state).toEqual({ active: false, revision: 8 });
    expect(f.queries.filter((q) => q.sql.startsWith("UPDATE"))).toHaveLength(1);
    expect(f.queries.some((q) => /UPDATE.*(?:routines|usage|approvals)/.test(q.sql))).toBe(false);
    expect(f.queries.find((q) => q.sql.startsWith("UPDATE"))?.sql).toContain("maintenance_state");
  });
  it.each([
    { active: true, revision: 0 },
    { active: false, revision: 1 },
  ])("rejects stale/no-op commands for %j", async (state) => {
    const f = fixture({ state });
    await expect(f.store.change("operator", enter)).rejects.toBeInstanceOf(
      MaintenanceConflictError,
    );
    expect(f.queries.some((q) => q.sql.startsWith("UPDATE"))).toBe(false);
    expect(f.queries.at(-1)?.sql).toBe("ROLLBACK");
  });
  it("a retried enter after resume returns current state without re-entering", async () => {
    const f = fixture({
      state: { active: false, revision: 2 },
      replay: { ...enter, operatorId: "operator", active: true, revision: 1 },
    });
    expect(await f.store.change("operator", enter)).toEqual({
      state: { active: false, revision: 2 },
      replayed: true,
    });
    expect(f.queries.some((q) => q.sql.startsWith("UPDATE"))).toBe(false);
  });
  it.each([{ action: "resume" }, { operatorId: "other" }, { expectedRevision: 5 }])(
    "rejects request identity reuse with changed binding %j",
    async (delta) => {
      const f = fixture({ replay: { ...enter, operatorId: "operator", ...delta } });
      await expect(f.store.change("operator", enter)).rejects.toBeInstanceOf(
        MaintenanceConflictError,
      );
    },
  );
  it("rolls back state if the audit insert fails", async () => {
    const f = fixture({ failAudit: true });
    await expect(f.store.change("operator", enter)).rejects.toThrow("audit unavailable");
    expect(f.queries.at(-1)?.sql).toBe("ROLLBACK");
    expect(f.queries.some((q) => q.sql === "COMMIT")).toBe(false);
    expect(f.release).toHaveBeenCalledOnce();
  });
  it.each([-1, 1.5, Number.NaN, 2_147_483_647])(
    "rejects invalid revision %s before checkout",
    async (revision) => {
      const f = fixture();
      await expect(
        f.store.change("operator", { ...enter, expectedRevision: revision }),
      ).rejects.toThrow("Invalid");
      expect(f.pool.connect).not.toHaveBeenCalled();
    },
  );
});

describe("operator maintenance status", () => {
  it("checks ownership, native and optional Fleet work in one repeatable-read snapshot", async () => {
    const f = fixture({ state: { active: true, revision: 8 } });
    expect(await f.store.statusForOperator("operator")).toEqual({
      state: { active: true, revision: 8 },
      status: { phase: "paused", activeRuns: 0, activeEffects: 0, pendingRuns: 0, issues: [] },
    });
    expect(f.queries[0]?.sql).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(f.queries.at(-1)?.sql).toBe("COMMIT");
    expect(f.pool.connect).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
  });
  it.each([null, "other"])("denies status for stored owner %s", async (owner) => {
    await expect(fixture({ owner }).store.statusForOperator("operator")).rejects.toThrow(
      "owner required",
    );
  });
  it("fails closed on missing state for the owner", async () => {
    await expect(fixture({ state: null }).store.statusForOperator("operator")).rejects.toThrow(
      "unavailable",
    );
  });
  it("reports optional Fleet uncertainty without hiding native counts", async () => {
    const f = fixture({ state: { active: true, revision: 8 },
      activity: { activeRuns: 1, activeEffects: 2, pendingRuns: 3, issues: [] },
      fleet: { activeEffects: 4, uncertain: true, stalled: false } });
    expect((await f.store.statusForOperator("operator")).status).toEqual({
      phase: "needs_attention", activeRuns: 1, activeEffects: 6, pendingRuns: 3,
      issues: ["uncertain-fleet-effects"],
    });
  });
  it.each(["lookup", "aggregate"] as const)("fails closed when optional Fleet %s errors", async (failFleet) => {
    const f = fixture({ failFleet, state: { active: true, revision: 1 },
      fleet: { activeEffects: 0, uncertain: false, stalled: false } });
    await expect(f.store.statusForOperator("operator")).rejects.toThrow("denied");
    expect(f.queries.at(-1)?.sql).toBe("ROLLBACK");
    expect(f.release).toHaveBeenCalledOnce();
  });
});

describe("graceful pause status and force stop", () => {
  it.each([
    { active: true, activeRuns: 1, activeEffects: 0, issues: [], phase: "pausing" },
    { active: true, activeRuns: 0, activeEffects: 1, issues: [], phase: "pausing" },
    { active: true, activeRuns: 0, activeEffects: 0, issues: [], phase: "paused" },
    { active: false, activeRuns: 1, activeEffects: 0, issues: [], phase: "running" },
    { active: true, activeRuns: 0, activeEffects: 1, issues: ["uncertain-effects"], phase: "needs_attention" },
    { active: false, activeRuns: 0, activeEffects: 1, issues: ["uncertain-effects"], phase: "needs_attention" },
  ])("reports actual outstanding work: %j", async ({ active, phase, ...activity }) => {
    const f = fixture({ state: { active, revision: 9 }, activity: { ...activity, pendingRuns: 3 } });
    expect((await f.store.statusForOperator("operator")).status).toEqual({
      ...activity, pendingRuns: 3, phase,
    });
  });
  it("requests cancellation without claiming active runs or effects have finished", async () => {
    const f = fixture({ state: { active: true, revision: 2 } });
    expect(await f.store.change("operator", {
      requestId: "stop", action: "force-stop", expectedRevision: 2,
    })).toEqual({ state: { active: true, revision: 3 }, replayed: false });
    expect(f.queries.some((q) => q.sql.includes('"maintenanceCancelRequestedAt" ='))).toBe(true);
    expect(f.queries.some((q) => q.sql.includes('"cancelRequested" = true'))).toBe(true);
    expect(f.queries.some((q) => /SET "status" = '(completed|cancelled)'/.test(q.sql))).toBe(false);
  });
  it("replayed force stop never cancels a newly resumed generation", async () => {
    const command = { requestId: "stop", action: "force-stop" as const, expectedRevision: 2 };
    const f = fixture({
      state: { active: false, revision: 4 },
      replay: { ...command, operatorId: "operator", active: true, revision: 3 },
    });
    expect(await f.store.change("operator", command)).toEqual({
      state: { active: false, revision: 4 }, replayed: true,
    });
    expect(f.queries.some((q) => q.sql.startsWith("UPDATE"))).toBe(false);
  });
});

describe("transactional maintenance admission", () => {
  it("holds every effect while paused without touching its approval or execution state", async () => {
    const tx = {
      $queryRaw: vi.fn(async () => [{ active: true, revision: 3 }]),
      externalEffect: { updateMany: vi.fn(async () => ({ count: 1 })) },
    };
    expect(await claimMaintenanceEffect(tx as never, "effect", "approved")).toBe(false);
    expect(tx.externalEffect.updateMany).not.toHaveBeenCalled();
  });
  it("preserves independent holds after resume", async () => {
    const tx = { $queryRaw: vi.fn(async () => [{ active: false, revision: 4 }]) };
    expect(await lockMaintenanceAdmission(tx as never, ["usage"])).toEqual({
      admitted: false, reason: "independent-hold", revision: 4,
    });
  });
  it("claims only the exact still-approved effect after acquiring the state lock", async () => {
    const tx = {
      $queryRaw: vi.fn(async () => [{ active: false, revision: 4 }]),
      externalEffect: { updateMany: vi.fn(async () => ({ count: 0 })) },
    };
    expect(await claimMaintenanceEffect(tx as never, "effect", "approved")).toBe(false);
    expect(tx.externalEffect.updateMany).toHaveBeenCalledWith({
      where: { id: "effect", status: "approved" }, data: { status: "executing" },
    });
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.externalEffect.updateMany.mock.invocationCallOrder[0]!,
    );
  });
  it("fails closed when the durable singleton is missing", async () => {
    const tx = { $queryRaw: vi.fn(async () => []) };
    await expect(lockMaintenanceAdmission(tx as never)).rejects.toThrow("unavailable");
  });
});

describe("durable maintenance continuations", () => {
  it("does not checkpoint a run after pause was already resumed", async () => {
    const tx = {
      $queryRaw: vi.fn(async () => [{ active: false, revision: 4 }]),
      run: { updateMany: vi.fn() },
      attempt: { updateMany: vi.fn() },
    };
    expect(await checkpointMaintenanceRun(tx as never, {
      runId: "run", leaseOwner: "worker", leaseFence: 2, checkpoint: "exact-continuation",
    })).toBe(false);
    expect(tx.run.updateMany).not.toHaveBeenCalled();
    expect(tx.attempt.updateMany).not.toHaveBeenCalled();
  });
  it("does not resume a denied or expired continuation even after global resume", async () => {
    const tx = {
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([{ active: false, revision: 4 }])
        .mockResolvedValueOnce([{ runId: "run", checkpoint: "exact-continuation", leaseFence: 2 }]),
      run: { updateMany: vi.fn() },
    };
    const revalidate = vi.fn(async () => false);
    expect(await resumeMaintenanceRun(tx as never, "run", revalidate)).toBe(false);
    expect(revalidate).toHaveBeenCalledOnce();
    expect(tx.run.updateMany).not.toHaveBeenCalled();
  });
  it("saves an already-observed hold even if explicit Resume races the final drain", async () => {
    const tx = {
      $queryRaw: vi.fn(async () => [{ active: false, revision: 4 }]),
      run: { updateMany: vi.fn(async () => ({ count: 1 })) },
      attempt: { updateMany: vi.fn(async () => ({ count: 1 })) },
    };
    expect(await checkpointMaintenanceRun(tx as never, {
      runId: "run", leaseOwner: "worker", leaseFence: 2, checkpoint: "genuine-runtime-state", observedRevision: 3,
    })).toBe(true);
    expect(tx.run.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "maintenance_paused", maintenanceCheckpoint: "genuine-runtime-state" }),
    }));
  });
});
