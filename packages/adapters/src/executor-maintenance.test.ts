import { describe, expect, it, vi } from "vitest";
import type { Run } from "@rakazo/db";
import { maintenanceAttention, maintenanceAttentionReason } from "@rakazo/db";
import { createRunExecutor, type ExecutorDeps } from "./executor.js";
import { createExecutorMaintenance, readExecutorContinuation } from "./executor-maintenance.js";

function harness() {
  const state = { active: true, revision: 1 };
  const run = {
    id: "run", userId: "owner", spaceId: "space", botId: "bot", taskId: "task", threadId: "thread",
    routineId: null, sourceMessageId: "message", trigger: "user", status: "running",
    leaseOwner: "worker" as string | null, leaseFence: 4, leaseExpiresAt: new Date(Date.now() + 60_000),
    checkpoint: null as string | null, maintenanceCheckpoint: null as string | null,
    maintenanceCancelRequestedAt: null as Date | null, error: null as string | null,
  };
  const bot = { id: "bot", userId: "owner", spaceId: "space", archivedAt: null,
    spawnKey: null as string | null, instructions: "Keep exact context", disabledBuiltinTools: [],
    computerId: null as string | null, computerSwitching: false };
  const task = { id: "task", userId: "owner", spaceId: "space", botId: "bot", threadId: "thread",
    prompt: "Original task", status: "running" };
  const thread = { id: "thread", userId: "owner", spaceId: "space", group: null };
  const attempt = { id: "attempt", runId: "run", fence: 4, status: "running", finishedAt: null };
  const effects = [{ id: "approved", runId: "run", kind: "tool.write", status: "approved", request: { exact: 1 } }];
  const server = { id: "fleet-server", revision: 7, endpoint: "http://fleet-service:8790/mcp",
    transport: "streamable_http", enabled: true };
  const assignment = { serverId: server.id, allowAllTools: true, allowedTools: [], server };
  const tool = { name: "mcp__fleet__maintenance_validate", description: "Verify exact authority",
    readOnly: true, inputSchema: { type: "object" }, route: { connectorId: "mcp",
      resourceId: server.id, resourceRevision: server.revision, toolName: "maintenance_validate" } };
  const control = {
    verify: async (): Promise<Record<string, unknown>> => ({ allowed: true }),
    teaching: false,
    computer: null as null | { id: string; providerRef: string; kind: string; screenGeneration: number; controlLeaseId: string | null; maintenanceId: string | null },
    screen: null as null | { computerId: string; runId: string; fence: number },
    leases: [] as Array<{ computerId: string; runId: string; fence: number; computer: { id: string; kind: string; providerRef: string } }>,
  };
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, value]) => {
      if (key === "OR" && Array.isArray(value)) return value.some((clause) => matches(row, clause));
      if (value && typeof value === "object" && "in" in value) return (value.in as unknown[]).includes(row[key]);
      return value === undefined || row[key] === value;
    });
  const prisma = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join("?");
      if (sql.includes("maintenance_state")) return [{ ...state }];
      if (sql.includes('AS "runId"')) return run.status === "maintenance_paused" && !run.maintenanceCancelRequestedAt
        ? [{ runId: run.id, checkpoint: run.maintenanceCheckpoint, leaseFence: run.leaseFence }] : [];
      return [];
    }),
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>): Promise<unknown> => work(prisma)),
    run: {
      findUnique: vi.fn(async (_query: { where: { id: string } }) => ({ ...run, bot, task, thread, routine: null })),
      findUniqueOrThrow: vi.fn(async () => ({ ...run, startedAt: null })),
      findMany: vi.fn(async ({ where }: { where: { status: string } }) => where.status === run.status ? [{ ...run }] : []),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: object }) => {
        if (!matches(run, where)) return { count: 0 };
        Object.assign(run, data);
        return { count: 1 };
      }),
      update: vi.fn(async ({ data }: { data: object }) => Object.assign(run, data)),
    },
    bot: { findUnique: vi.fn(async () => ({ ...bot })),
      findUniqueOrThrow: vi.fn(async () => ({ computerId: "computer", computerSwitching: true })) },
    spaceMember: { findUnique: vi.fn(async () => ({ id: "membership" })) },
    taughtSkill: { findFirst: vi.fn(async () => control.teaching ? { id: "teaching" } : null) },
    computer: { findUnique: vi.fn(async () => control.computer), updateMany: vi.fn(async () => ({ count: 1 })) },
    computerExecutionLease: { findUnique: vi.fn(async () => control.screen),
      findMany: vi.fn(async () => control.leases), updateMany: vi.fn(async () => ({ count: 1 })) },
    externalEffect: { findMany: vi.fn(async ({ where }: { where: { status?: string } }) =>
      effects.filter((effect) => !where.status || effect.status === where.status).map((effect) => ({ ...effect }))) },
    // Cancellation also invalidates source-bound approvals; this run's cards bind none.
    message: { findMany: vi.fn(async () => []) },
    attempt: {
      findMany: vi.fn(async () => attempt.status === "running" ? [{ id: attempt.id }] : []),
      updateMany: vi.fn(async ({ data }: { data: object }) => { Object.assign(attempt, data); return { count: 1 }; }),
    },
    task: { updateMany: vi.fn(async ({ data }: { data: object }) => { Object.assign(task, data); return { count: 1 }; }) },
    botMcpServer: {
      findMany: vi.fn(async () => server.endpoint === "http://fleet-service:8790/mcp" && server.transport === "streamable_http"
        ? [assignment] : []),
      findFirst: vi.fn(async ({ where }: { where: { server: { revision: number } } }) =>
        where.server.revision === server.revision ? assignment : null),
    },
  };
  const deps = {
    prisma,
    runtime: { abort: vi.fn(async () => { attempt.status = "interrupted"; }) },
    sandbox: { cancelRunWork: vi.fn(async () => true), releaseScreen: vi.fn(async () => undefined) },
    events: { append: vi.fn(async () => undefined) },
    jobs: { enqueue: vi.fn(async () => undefined) },
    connector: { discoverTools: vi.fn(async () => [tool]), execute: vi.fn(async function* () {
      yield { type: "result" as const, data: { structuredContent: await control.verify() } };
    }) },
    maintenance: {
      cancellationTargets: vi.fn(async (limit = 100, afterId?: string) =>
        (run.maintenanceCancelRequestedAt && (!afterId || run.id > afterId)
          ? [{ id: run.id, leaseFence: run.leaseFence }] : []).slice(0, limit)),
      acknowledgeCancellation: vi.fn(async () => {
        if (attempt.status === "running" || effects.some((effect) => effect.status === "executing")) return false;
        run.maintenanceCancelRequestedAt = null;
        return true;
      }),
    },
  };
  const dependencies = deps as unknown as ExecutorDeps;
  const maintenance = createExecutorMaintenance(dependencies);
  const executor = createRunExecutor(dependencies);
  const restartMaintenance = () => createExecutorMaintenance(dependencies);
  const checkpoint = () => maintenance.checkpoint(run as unknown as Run, "worker", 4, 1, {
    runtime: JSON.stringify({ kind: "scripted-maintenance-v1", runId: "run", cursor: 2, script: [{ assistant: "original" }] }),
    presentation: { assembled: "Already shown", messageSegments: [{ kind: "text", text: "Already shown" }] },
    occurrences: [["original-effect", 2]], executions: [["original-call", 1]],
  });
  return { maintenance, executor, restartMaintenance, checkpoint, state, run, bot, task, effects, attempt, control, server, tool, deps, prisma };
}

describe("executor durable maintenance lifecycle", () => {
  it("persists exact context, approval binding and original identities without browser/runtime cancellation", async () => {
    const f = harness();
    expect(await f.checkpoint()).toBe(true);
    const saved = readExecutorContinuation(f.run.maintenanceCheckpoint, f.run.id)!;
    expect(saved).toMatchObject({ runId: "run", leaseFence: 4, occurrences: [["original-effect", 2]],
      executions: [["original-call", 1]], presentation: { assembled: "Already shown" },
      approvals: [{ id: "approved", status: "approved", request: { exact: 1 } }] });
    expect(JSON.parse(saved.runtime).cursor).toBe(2);
    expect(f.run.status).toBe("maintenance_paused");
    expect(f.attempt.status).toBe("maintenance_paused");
    expect(f.deps.runtime.abort).not.toHaveBeenCalled();
    expect(f.deps.sandbox.cancelRunWork).not.toHaveBeenCalled();
    expect(f.deps.sandbox.releaseScreen).not.toHaveBeenCalled();
    Object.assign(f.state, { active: false, revision: 2 });
    await f.maintenance.reconcile(async () => undefined);
    await f.maintenance.reconcile(async () => undefined);
    expect(f.run.status).toBe("queued");
    expect(f.deps.jobs.enqueue).toHaveBeenCalledTimes(1);
    expect(f.run.maintenanceCheckpoint).toBe(JSON.stringify(saved));
  });

  it.each(["denied", "changed-request", "owner", "teaching", "independent-checkpoint"])(
    "retains the same checkpoint when %s invalidates current authority", async (hold) => {
      const f = harness();
      await f.checkpoint();
      const original = f.run.maintenanceCheckpoint;
      if (hold === "denied") f.effects[0]!.status = "denied";
      if (hold === "changed-request") f.effects[0]!.request = { exact: 2 };
      if (hold === "owner") f.bot.userId = "another-owner";
      if (hold === "teaching") f.control.teaching = true;
      if (hold === "independent-checkpoint") f.run.checkpoint = "independent-hold";
      Object.assign(f.state, { active: false, revision: 2 });
      await f.maintenance.reconcile(async () => undefined);
      expect(f.run.status).toBe("maintenance_paused");
      expect(maintenanceAttentionReason(f.run.error)).toBeTruthy();
      expect(f.run.maintenanceCheckpoint).toBe(original);
      expect(f.deps.jobs.enqueue).not.toHaveBeenCalled();
      if (hold === "denied") expect(f.effects[0]!.status).toBe("denied");
    },
  );

  it("refuses a consumed checkpoint after a worker crash instead of duplicating already-started work", async () => {
    const f = harness();
    await f.checkpoint();
    const saved = readExecutorContinuation(f.run.maintenanceCheckpoint, f.run.id)!;
    f.run.leaseFence += 1;
    f.run.status = "running";
    expect(await f.maintenance.validateLease(f.prisma as never, f.run as unknown as Run, saved, {})).toBe(false);
    expect(f.run.error).toContain("continuation-already-consumed");
  });

  it("does not restore a stale screen when unrelated validated work used the same computer", async () => {
    const f = harness();
    f.bot.computerId = "computer";
    f.control.computer = { id: "computer", kind: "e2b", providerRef: "sandbox", screenGeneration: 1,
      controlLeaseId: null, maintenanceId: null };
    f.control.screen = { computerId: "computer", runId: "run", fence: 5 };
    await f.checkpoint();
    f.control.screen = { computerId: "computer", runId: "unrelated-fresh-run", fence: 6 };
    Object.assign(f.state, { active: false, revision: 2 });
    await f.maintenance.reconcile(async () => undefined);
    expect(f.run.error).toContain("authority-changed");
    expect(f.deps.jobs.enqueue).not.toHaveBeenCalled();
  });

  it("runs already-started effect reconciliation while admission remains closed", async () => {
    const f = harness();
    const reconcileEffects = vi.fn(async () => undefined);
    await f.maintenance.reconcile(async () => undefined, reconcileEffects);
    expect(reconcileEffects).toHaveBeenCalledOnce();
    expect(f.deps.jobs.enqueue).not.toHaveBeenCalled();
  });

  it("force-stop invokes real abort and exact screen teardown before durable acknowledgment", async () => {
    const f = harness();
    f.run.maintenanceCancelRequestedAt = new Date();
    f.control.leases.push({ computerId: "computer", runId: "run", fence: 9,
      computer: { id: "computer", kind: "e2b", providerRef: "sandbox" } });
    await f.maintenance.reconcile(async () => undefined);
    expect(f.run.status).toBe("cancelled");
    expect(f.deps.runtime.abort).toHaveBeenCalledWith("run");
    expect(f.deps.sandbox.cancelRunWork).toHaveBeenCalledWith(expect.anything(), "computer", "run",
      expect.objectContaining({ runId: "run", cancelRunWork: true, screenLeaseId: expect.any(String) }));
    expect(f.deps.sandbox.releaseScreen).toHaveBeenCalledOnce();
    expect(f.deps.maintenance.acknowledgeCancellation.mock.invocationCallOrder[0]).toBeGreaterThan(
      f.deps.sandbox.releaseScreen.mock.invocationCallOrder[0]!);
    expect(f.run.maintenanceCancelRequestedAt).toBeNull();
  });

  it.each([new Date(0), new Date(Date.now() + 60_000)])(
    "does not acknowledge another worker's undrained attempt with lease expiry %s", async (expiresAt) => {
      const f = harness();
      f.run.leaseExpiresAt = expiresAt;
      f.run.maintenanceCancelRequestedAt = new Date();
      f.deps.runtime.abort.mockImplementation(async () => undefined);
      await f.maintenance.reconcile(async () => undefined);
      expect(f.run.status).toBe("cancelled");
      expect(f.attempt.status).toBe("running");
      expect(f.run.maintenanceCancelRequestedAt).not.toBeNull();
      f.attempt.status = "interrupted";
      await f.maintenance.reconcile(async () => undefined);
      expect(f.run.maintenanceCancelRequestedAt).toBeNull();
    },
  );

  it("does not acknowledge failed force teardown or unresolved effects", async () => {
    const f = harness();
    f.run.maintenanceCancelRequestedAt = new Date();
    f.control.leases.push({ computerId: "computer", runId: "run", fence: 9,
      computer: { id: "computer", kind: "e2b", providerRef: "sandbox" } });
    f.deps.sandbox.cancelRunWork.mockRejectedValueOnce(new Error("transport unavailable"));
    await f.maintenance.reconcile(async () => undefined);
    expect(f.run.maintenanceCancelRequestedAt).not.toBeNull();
    expect(f.deps.maintenance.acknowledgeCancellation).not.toHaveBeenCalled();
    expect(f.deps.sandbox.releaseScreen).not.toHaveBeenCalled();
  });

  it("reaches later cancellations after a full page of unresolved targets on a new worker", async () => {
    const f = harness();
    f.run.maintenanceCancelRequestedAt = new Date();
    const blocked = Array.from({ length: 100 }, (_, index) => ({
      id: `blocked-${String(index).padStart(3, "0")}`, leaseFence: 4,
    }));
    f.deps.maintenance.cancellationTargets.mockImplementation(async (limit = 100, afterId?: string) =>
      [...blocked, ...(f.run.maintenanceCancelRequestedAt ? [{ id: f.run.id, leaseFence: 4 }] : [])]
        .filter((row) => !afterId || row.id > afterId).slice(0, limit));
    const findRun = f.prisma.run.findUnique.getMockImplementation()!;
    f.prisma.run.findUnique.mockImplementation(async (query) => {
      if (query.where.id.startsWith("blocked-")) throw new Error("Remote cancellation owner unavailable");
      return findRun(query);
    });
    await f.restartMaintenance().reconcile(async () => undefined);
    expect(f.run.status).toBe("cancelled");
    expect(f.run.maintenanceCancelRequestedAt).toBeNull();
    expect(await f.deps.maintenance.cancellationTargets()).toEqual(blocked);
  });
});

describe("trusted Fleet continuation authority", () => {
  async function pausedFleet() {
    const f = harness();
    f.bot.spawnKey = "fleet:bot";
    await f.checkpoint();
    Object.assign(f.state, { active: false, revision: 2 });
    return f;
  }

  it("checks the exact run through the assigned private Fleet resource before native revalidation", async () => {
    const f = await pausedFleet();
    await f.maintenance.reconcile(async () => undefined);
    expect(f.deps.connector.execute).toHaveBeenCalledWith(expect.objectContaining({ args: { run_id: "run" },
      route: expect.objectContaining({ resourceId: "fleet-server", resourceRevision: 7 }) }),
    expect.objectContaining({ runId: "run", userId: "owner", botId: "bot", spaceId: "space" }));
    expect(f.run.status).toBe("queued");
  });

  it.each(["http://other:8790/mcp", "http://user@fleet-service:8790/mcp",
    "http://fleet-service:8790/mcp?trusted=true", "http://fleet-service:8790/mcp#fragment"])(
    "rejects untrusted endpoint %s without executing its advertised verifier", async (endpoint) => {
      const f = await pausedFleet();
      f.server.endpoint = endpoint;
      await f.maintenance.reconcile(async () => undefined);
      expect(f.deps.connector.execute).not.toHaveBeenCalled();
      expect(f.run.error).toContain("fleet-authority-verifier-unavailable");
    },
  );

  it.each(["pause", "cancel", "resource-revision", "approval"])(
    "rechecks %s after the remote check rather than requeueing from a stale reply", async (race) => {
      const f = await pausedFleet();
      f.control.verify = async () => {
        if (race === "pause") Object.assign(f.state, { active: true, revision: 3 });
        if (race === "cancel") f.run.maintenanceCancelRequestedAt = new Date();
        if (race === "resource-revision") f.server.revision += 1;
        if (race === "approval") f.effects[0]!.status = "denied";
        return { allowed: true };
      };
      await f.maintenance.reconcile(async () => undefined);
      expect(f.run.status).toBe("maintenance_paused");
      expect(f.deps.jobs.enqueue).not.toHaveBeenCalled();
    },
  );

  it.each([{ allowed: "true" }, { allowed: true, reason: null }, { allowed: true, invented: true }])(
    "retains malformed validation reply %j with an explicit cause", async (reply) => {
      const f = await pausedFleet();
      f.control.verify = async () => reply;
      await f.maintenance.reconcile(async () => undefined);
      expect(f.run.error).toContain("fleet-authority-reply-invalid");
      expect(f.deps.jobs.enqueue).not.toHaveBeenCalled();
    },
  );

  it("keeps unbound legacy work visible without claiming it resumed", async () => {
    const f = await pausedFleet();
    f.control.verify = async () => ({ allowed: false, reason: "fleet-authority-binding-unavailable" });
    await f.maintenance.reconcile(async () => undefined);
    expect(maintenanceAttentionReason(f.run.error)).toBe("fleet-authority-binding-unavailable");
    expect(f.run.maintenanceCheckpoint).not.toBeNull();
    expect(f.deps.jobs.enqueue).not.toHaveBeenCalled();
  });
});

describe("maintenance lease redelivery", () => {
  it("does not repark or consume an already-resumed continuation while its worker lease is live", async () => {
    const f = harness();
    f.run.maintenanceCheckpoint = "A duplicate delivery must not even parse this while the owner is live";
    await f.executor.continueRun(f.run.id, "another-worker");
    expect(f.prisma.run.updateMany).not.toHaveBeenCalled();
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
    expect(f.deps.connector.execute).not.toHaveBeenCalled();
    expect(f.run.status).toBe("running");
  });
});

describe("queued authority after maintenance", () => {
  it("admits never-started Fleet chat after resume without inventing a runtime or tracker checkpoint", async () => {
    const f = harness();
    Object.assign(f.run, { status: "queued", leaseOwner: null, leaseExpiresAt: null });
    f.bot.spawnKey = "fleet:bot";
    f.effects.splice(0);
    await f.executor.continueRun(f.run.id, "worker");
    expect(f.run.leaseFence).toBe(4);
    expect(f.deps.connector.execute).not.toHaveBeenCalled();
    Object.assign(f.state, { active: false, revision: 2 });
    // Fleet's verifier authorizes persisted fresh unbound work; native still
    // verifies the owner and independent holds before reaching computer setup.
    await f.executor.continueRun(f.run.id, "worker");
    expect(f.run.leaseFence).toBe(5);
    expect(f.run.error).toBeNull();
    expect(f.run.maintenanceCheckpoint).toBeNull();
    expect(f.deps.jobs.enqueue).toHaveBeenCalledOnce();
  });

  it.each(["user", "approval"])("holds %s work without a runtime checkpoint when Fleet authority is stale", async (trigger) => {
    const f = harness();
    Object.assign(f.run, { status: "queued", trigger, leaseOwner: null, leaseExpiresAt: null });
    Object.assign(f.state, { active: false, revision: 2 });
    f.bot.spawnKey = "fleet:bot";
    f.effects[0]!.status = "denied";
    f.control.verify = async () => ({ allowed: false, reason: "dependencies-changed" });
    await f.executor.continueRun(f.run.id, "worker");
    expect(f.run.status).toBe("queued");
    expect(f.run.maintenanceCheckpoint).toBeNull();
    expect(maintenanceAttentionReason(f.run.error)).toBe("dependencies-changed");
    expect(f.run.leaseOwner).toBeNull();
    expect(f.effects[0]!.status).toBe("denied");
    expect(f.effects[0]!.request).toEqual({ exact: 1 });
  });

  it("does not hold a continuation for an approval that ended invalidated", async () => {
    const f = harness();
    await f.checkpoint();
    Object.assign(f.state, { active: false, revision: 2 });
    await f.maintenance.reconcile(async () => undefined);
    f.effects.push({ id: "gone", runId: "run", kind: "tool.write", status: "invalidated", request: { exact: 2 } });
    await f.executor.continueRun(f.run.id, "worker");
    expect(f.run.status).toBe("queued");
    expect(f.run.error).toBeNull();
  });

  it("checks unsettled effects again when leasing a previously validated continuation", async () => {
    const f = harness();
    await f.checkpoint();
    Object.assign(f.state, { active: false, revision: 2 });
    await f.maintenance.reconcile(async () => undefined);
    f.effects.push({ id: "unknown", runId: "run", kind: "tool.write", status: "uncertain", request: { exact: 2 } });
    await f.executor.continueRun(f.run.id, "worker");
    expect(f.run.status).toBe("maintenance_paused");
    expect(maintenanceAttentionReason(f.run.error)).toBe("unsettled-effects");
    expect(f.effects[1]!.status).toBe("uncertain");
  });

  it("scans beyond a full page of runtime-invalid continuations after restart", async () => {
    const f = harness();
    await f.checkpoint();
    Object.assign(f.state, { active: false, revision: 2 });
    const blocked = Array.from({ length: 100 }, (_, index) => ({
      ...f.run, id: `blocked-${String(index).padStart(3, "0")}`,
      error: maintenanceAttention("runtime-continuation-invalid"),
    }));
    f.prisma.run.findMany.mockImplementation(async ({ where }: { where: { status: string; id?: { gt: string } } }) => {
      if (where.status !== "maintenance_paused") return [];
      return [...blocked, { ...f.run }].filter((run) => run.status === where.status &&
        (!where.id || run.id > where.id.gt)).slice(0, 100);
    });
    await f.restartMaintenance().reconcile(async () => undefined);
    expect(f.run.status).toBe("queued");
    expect(blocked.every((run) => run.status === "maintenance_paused")).toBe(true);
    expect(f.deps.jobs.enqueue).toHaveBeenCalledOnce();
  });
});
