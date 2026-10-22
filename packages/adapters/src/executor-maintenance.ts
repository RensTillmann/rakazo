import type { AdapterContext } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import { isOneShotRoutineCrons, isOwnerHeldAuthorityReason, isRetriedAuthorityReason,
  isSettledEffectStatus, OWNER_OVERRIDE_REASON } from "@rakazo/core";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import type { Prisma, Run } from "@rakazo/db";
import { cancelRunsInTransaction, checkpointMaintenanceRun, expireComputerExecutionLeases,
  lockMaintenanceAdmission, maintenanceAttention, maintenanceAttentionReason, resumeMaintenanceRun } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { cancelComputerRunWork } from "./computer-idle.js";
import { screenLeaseIdForRun, toComputerRef } from "./computer-lifecycle.js";
import type { ExecutorDeps } from "./executor.js";

export type ExecutorContinuation = {
  kind: "executor-maintenance-v1";
  runId: string;
  leaseFence: number;
  runtime: string;
  presentation: Record<string, unknown>;
  occurrences: Array<[string, number]>;
  executions: Array<[string, number]>;
  authority: string;
  approvals: Array<{ id: string; kind: string; request: unknown; status: string }>;
};

export function readExecutorContinuation(blob: string | null, runId: string): ExecutorContinuation | undefined {
  if (!blob) return undefined;
  const value = JSON.parse(blob) as ExecutorContinuation;
  if (value.kind !== "executor-maintenance-v1" || value.runId !== runId || !value.runtime ||
    !Array.isArray(value.occurrences) || !Array.isArray(value.executions) || !Array.isArray(value.approvals) ||
    typeof value.authority !== "string" || !Number.isSafeInteger(value.leaseFence) ||
    !value.presentation) throw new Error("Exact continuation unavailable");
  const runtime = JSON.parse(value.runtime) as { kind?: string; runId?: string };
  if (!["pi-maintenance-v1", "scripted-maintenance-v1"].includes(runtime.kind ?? "") ||
    runtime.runId !== runId) throw new Error("Exact runtime continuation unavailable");
  return value;
}

async function authority(tx: Prisma.TransactionClient, runId: string) {
  const identity = await tx.run.findUnique({ where: { id: runId },
    select: { botId: true, taskId: true, routineId: true } });
  if (!identity) return { reason: "run-missing" };
  await tx.$queryRaw`SELECT id FROM bots WHERE id = ${identity.botId} FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM tasks WHERE id = ${identity.taskId} FOR SHARE`;
  if (identity.routineId) await tx.$queryRaw`SELECT id FROM routines WHERE id = ${identity.routineId} FOR SHARE`;
  const run = await tx.run.findUnique({ where: { id: runId }, include: {
    bot: true, task: true, routine: true, thread: { include: { group: { include: { members: true } } } },
  } });
  if (!run) return { reason: "run-missing" };
  const { bot, task, thread, routine } = run;
  if (bot.computerId) await tx.$queryRaw`SELECT id FROM computers WHERE id = ${bot.computerId} FOR SHARE`;
  const computer = bot.computerId ? await tx.computer.findUnique({ where: { id: bot.computerId } }) : null;
  const screen = bot.computerId ? await tx.computerExecutionLease.findUnique({
    where: { computerId_botId: { computerId: bot.computerId, botId: run.botId } },
    select: { computerId: true, runId: true, fence: true },
  }) : null;
  const snapshot = stableJsonValue({ userId: run.userId, spaceId: run.spaceId, botId: run.botId,
    taskId: run.taskId, threadId: run.threadId, sourceMessageId: run.sourceMessageId,
    routineId: run.routineId, prompt: task.prompt, spawnKey: bot.spawnKey,
    instructions: bot.instructions, disabledBuiltinTools: bot.disabledBuiltinTools,
    computer: computer ? { id: computer.id, providerRef: computer.providerRef,
      kind: computer.kind, screenGeneration: computer.screenGeneration, screen } : null,
    routine: routine ? { prompt: routine.prompt, crons: routine.crons, timezone: routine.timezone,
      webhookEnabled: routine.webhookEnabled, githubEnabled: routine.githubEnabled } : null });
  const refuse = (reason: string) => ({ reason, snapshot });
  if (bot.userId !== run.userId || bot.spaceId !== run.spaceId || bot.archivedAt ||
    task.userId !== run.userId || task.botId !== run.botId || task.threadId !== run.threadId ||
    task.spaceId !== run.spaceId || thread.userId !== run.userId || thread.spaceId !== run.spaceId) {
    return refuse("ownership-changed");
  }
  const member = await tx.spaceMember.findUnique({ where: {
    spaceId_userId: { spaceId: run.spaceId, userId: run.userId },
  } });
  if (!member) return refuse("owner-membership-missing");
  if (["cancelled", "completed", "failed"].includes(task.status)) return refuse("task-no-longer-active");
  if (thread.group && (thread.group.archivedAt || thread.group.pausedAt ||
    !thread.group.members.some((member) => member.botId === run.botId))) return refuse("room-held");
  if (bot.computerSwitching) return refuse("computer-held");
  if (run.checkpoint && !["takeover", "takeover-skipped"].includes(run.checkpoint)) {
    return refuse("independent-checkpoint-held");
  }
  if (routine && (routine.botId !== run.botId || routine.userId !== run.userId ||
    routine.spaceId !== run.spaceId || (!routine.active && !isOneShotRoutineCrons(routine.crons)))) {
    return refuse("routine-held");
  }
  const teaching = await tx.taughtSkill.findFirst({ where: { botId: run.botId, status: "recording" }, select: { id: true } });
  if (teaching) return refuse("teaching-held");
  if (computer?.controlLeaseId || computer?.maintenanceId) return refuse("computer-held");
  return { run, snapshot };
}

export type FleetResumeAuthority = {
  reason?: string; resourceId?: string; resourceRevision?: number;
  /** The owner let this held run continue: the Fleet's check is skipped this once. */
  overridden?: true;
};
/** How long the Fleet's maintenance_validate may take before the check counts as unavailable. */
export const FLEET_AUTHORITY_TIMEOUT_MS = 90_000;
/** A run held because the Fleet's check could not answer is checked again this often… */
export const FLEET_AUTHORITY_RETRY_INTERVAL_MS = 5 * 60_000;
/** …for this long after it was first held; then it waits for the owner. */
export const FLEET_AUTHORITY_RETRY_WINDOW_MS = 24 * 60 * 60_000;
/** A binding the Fleet could not find is asked about again hourly, in case a Fleet rule changed. */
export const FLEET_BINDING_RETRY_INTERVAL_MS = 60 * 60_000;

/**
 * Whether a run held for maintenance attention is validated again now. A Fleet check that did not
 * answer is retried every FLEET_AUTHORITY_RETRY_INTERVAL_MS, and a binding the Fleet could not find
 * (`binding-unavailable`) every FLEET_BINDING_RETRY_INTERVAL_MS, both for
 * FLEET_AUTHORITY_RETRY_WINDOW_MS from when it was first held (`heldSince`). A binding the Fleet
 * reports invalid is a real evidence problem and is never retried; any other hold is re-checked
 * on every pass.
 */
export function authorityRetry(
  reason: string | undefined,
  heldSince: Date,
  lastTried: number | undefined,
  now: number,
): "now" | "later" | "never" {
  if (!reason) return "now";
  const bindingUnavailable = /^(fleet-authority-)?binding-unavailable$/.test(reason);
  if (isOwnerHeldAuthorityReason(reason) && !bindingUnavailable) return "never";
  if (!bindingUnavailable && !isRetriedAuthorityReason(reason)) return "now";
  if (now - heldSince.getTime() > FLEET_AUTHORITY_RETRY_WINDOW_MS) return "never";
  const interval = bindingUnavailable
    ? FLEET_BINDING_RETRY_INTERVAL_MS
    : FLEET_AUTHORITY_RETRY_INTERVAL_MS;
  return lastTried !== undefined && now - lastTried < interval ? "later" : "now";
}
// The Fleet service's documented private deployment endpoint, not a model/tool-provided URL.
const FLEET_AUTHORITY_ENDPOINT = "http://fleet-service:8790/mcp";

async function fleetAuthority(
  deps: ExecutorDeps, run: Run, timeoutMs: number,
): Promise<FleetResumeAuthority> {
  const bot = await deps.prisma.bot.findUnique({ where: { id: run.botId }, select: { spawnKey: true } });
  if (!bot?.spawnKey?.startsWith("fleet:")) return {};
  // The owner's audited override is consumed by this resume: the error is cleared or replaced.
  if (maintenanceAttentionReason(run.error) === OWNER_OVERRIDE_REASON) return { overridden: true };
  if (!deps.connector) return { reason: "fleet-authority-verifier-unavailable" };
  const assignments = await deps.prisma.botMcpServer.findMany({
    where: { botId: run.botId, userId: run.userId, spaceId: run.spaceId, server: {
      enabled: true, userId: run.userId, spaceId: run.spaceId,
      transport: "streamable_http", endpoint: FLEET_AUTHORITY_ENDPOINT,
    } }, include: { server: true },
  });
  if (assignments.length !== 1) return { reason: "fleet-authority-verifier-unavailable" };
  const assigned = assignments[0]!;
  const resourceRevision = assigned.server.revision;
  const context: AdapterContext = { operationId: `maintenance-validate:${run.id}`,
    traceId: `maintenance-validate:${run.id}`, spaceId: run.spaceId, userId: run.userId,
    botId: run.botId, runId: run.id, signal: AbortSignal.timeout(timeoutMs) };
  try {
    const discovered = await deps.connector.discoverTools(context);
    const candidates = discovered.filter((tool) => tool.route?.connectorId === "mcp" &&
      tool.route.toolName === "maintenance_validate" && tool.readOnly === true &&
      tool.route.resourceId === assigned.serverId &&
      tool.route.resourceRevision === resourceRevision);
    if (candidates.length !== 1) return { reason: "fleet-authority-verifier-unavailable" };
    const tool = candidates[0]!;
    for await (const event of deps.connector.execute({ tool: tool.name, args: { run_id: run.id },
      executionId: `maintenance-validate:${run.id}:${run.leaseFence}`, route: tool.route }, context)) {
      // A check cut off by the time budget did not answer; one that answered with an error failed.
      if (event.type === "error") {
        return { reason: context.signal.aborted
          ? "fleet-authority-verifier-unavailable" : "fleet-authority-verification-failed" };
      }
      if (event.type !== "result") continue;
      if (!event.data || typeof event.data !== "object") return { reason: "fleet-authority-reply-invalid" };
      const result = event.data as { isError?: boolean; structuredContent?: unknown; content?: Array<{ type: string; text?: string }> };
      if (result.isError) return { reason: "fleet-authority-verification-failed" };
      let payload: unknown;
      try {
        payload = result.structuredContent ?? JSON.parse(result.content?.find((part) => part.type === "text")?.text ?? "null");
      } catch { return { reason: "fleet-authority-reply-invalid" }; }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { reason: "fleet-authority-reply-invalid" };
      const reply = payload as Record<string, unknown>;
      if (typeof reply.allowed !== "boolean" || Object.keys(reply).some((key) => !["allowed", "reason"].includes(key)) ||
        (reply.reason !== undefined && (typeof reply.reason !== "string" || !/^[a-z0-9-]{1,100}$/.test(reply.reason)))) {
        return { reason: "fleet-authority-reply-invalid" };
      }
      if (!reply.allowed) return { reason: typeof reply.reason === "string" ? reply.reason : "fleet-authority-reply-invalid" };
      if (reply.reason !== undefined) return { reason: "fleet-authority-reply-invalid" };
      return { resourceId: assigned.serverId, resourceRevision };
    }
  } catch { return { reason: "fleet-authority-verifier-unavailable" }; }
  return { reason: "fleet-authority-verification-failed" };
}

async function revalidateFleetResource(tx: Prisma.TransactionClient, run: Run, checked: FleetResumeAuthority) {
  if (checked.reason) return checked.reason;
  if (!checked.resourceId) return undefined;
  await tx.$queryRaw`SELECT id FROM mcp_servers WHERE id = ${checked.resourceId} FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM bot_mcp_servers
    WHERE "botId" = ${run.botId} AND "serverId" = ${checked.resourceId} FOR SHARE`;
  const assignment = await tx.botMcpServer.findFirst({ where: {
    botId: run.botId, serverId: checked.resourceId, userId: run.userId, spaceId: run.spaceId,
    server: { enabled: true, userId: run.userId, spaceId: run.spaceId,
      transport: "streamable_http", endpoint: FLEET_AUTHORITY_ENDPOINT, revision: checked.resourceRevision },
  } });
  return assignment && (assignment.allowAllTools ||
    (Array.isArray(assignment.allowedTools) && assignment.allowedTools.includes("maintenance_validate")))
    ? undefined : "fleet-authority-verifier-changed";
}

/** Common invariant at resume and lease claims, inside the caller's locks. */
async function validateAuthority(
  tx: Prisma.TransactionClient, run: Run, continuation: ExecutorContinuation | undefined,
  checked: FleetResumeAuthority,
): Promise<string | undefined> {
  const current = await authority(tx, run.id);
  const currentRun = "run" in current ? current.run : undefined;
  let reason = await revalidateFleetResource(tx, run, checked) ?? current.reason;
  if (!reason && currentRun?.bot.spawnKey?.startsWith("fleet:") && !checked.resourceId &&
    !checked.overridden) {
    reason = "fleet-authority-verifier-unavailable";
  }
  if (!reason && (currentRun?.leaseFence !== run.leaseFence ||
    currentRun?.maintenanceCheckpoint !== run.maintenanceCheckpoint)) reason = "continuation-already-consumed";
  if (!reason && continuation && current.snapshot !== continuation.authority) reason = "authority-changed";
  if (!reason && continuation && run.leaseFence !== continuation.leaseFence) reason = "continuation-already-consumed";
  await tx.$queryRaw`SELECT id FROM external_effects WHERE "runId" = ${run.id} FOR SHARE`;
  const effects = await tx.externalEffect.findMany({ where: { runId: run.id } });
  if (!reason && effects.some((effect) => !isSettledEffectStatus(effect.status))) reason = "unsettled-effects";
  for (const approved of continuation?.approvals ?? []) {
    const effect = effects.find((row) => row.id === approved.id);
    if (!effect || effect.status !== "approved" || effect.kind !== approved.kind ||
      stableJsonValue(effect.request) !== stableJsonValue(approved.request)) reason = "approval-binding-changed";
  }
  return reason;
}

/** Bounded keyset queries scan past unresolved holds on every pass, including
 * after restart. Held evidence is never deleted just to rotate the queue. */
async function* pages<T extends { id: string }>(load: (afterId?: string) => Promise<T[]>) {
  let afterId: string | undefined;
  for (;;) {
    const rows = await load(afterId);
    for (const row of rows) yield row;
    if (rows.length < 100) return;
    afterId = rows.at(-1)!.id;
  }
}

export function createExecutorMaintenance(
  deps: ExecutorDeps,
  /** The Fleet check's time budget; tests shorten it. */
  authorityTimeoutMs = FLEET_AUTHORITY_TIMEOUT_MS,
) {
  /** When each held run's Fleet check was last tried in this process. */
  const tried = new Map<string, number>();
  /** Whether to validate a run now; records the attempt, so a failed check waits its interval. */
  const mayValidate = (run: Run): boolean => {
    const now = Date.now();
    const decision = authorityRetry(
      maintenanceAttentionReason(run.error),
      run.updatedAt,
      tried.get(run.id),
      now,
    );
    if (decision !== "now") return false;
    // Only the last interval matters; older entries are dropped so the map stays small.
    if (tried.size > 1_000) {
      for (const [id, at] of tried) if (now - at >= FLEET_AUTHORITY_RETRY_INTERVAL_MS) tried.delete(id);
    }
    tried.set(run.id, now);
    return true;
  };
  const checkpointEvent = (run: Run, status: "maintenance_paused" | "queued") => deps.events.append({
    spaceId: run.spaceId, threadId: run.threadId, botId: run.botId, runId: run.id,
    type: "run.checkpointed", payload: { status, trigger: run.trigger, taskId: run.taskId },
  });
  return {
    externalAuthority: (run: Run) => fleetAuthority(deps, run, authorityTimeoutMs),
    mayValidate,
    async validateLease(tx: Prisma.TransactionClient, run: Run, continuation: ExecutorContinuation | undefined,
      checked: FleetResumeAuthority) {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM runs WHERE id = ${run.id} FOR UPDATE`;
      let reason: string | undefined;
      try {
        reason = await validateAuthority(tx, run, continuation, checked);
      } catch (error) {
        getLogger().warn("Maintenance lease authority unavailable", { runId: run.id, error });
        reason = "continuation-verification-unavailable";
      }
      if (reason) {
        // An unchanged hold is not rewritten, so `updatedAt` keeps when it was first held.
        if (continuation || run.error !== maintenanceAttention(reason)) {
          await tx.run.updateMany({ where: { id: run.id, leaseFence: run.leaseFence, status: run.status },
            data: { ...(continuation ? { status: "maintenance_paused", leaseOwner: null, leaseExpiresAt: null } : {}),
              error: maintenanceAttention(reason) } });
        }
        return false;
      }
      return true;
    },
    async holdUnstartedContinuation(run: Run, leaseOwner: string, leaseFence: number,
      continuation: ExecutorContinuation, reason: string) {
      const held = await deps.prisma.$transaction(async (tx) => {
        await lockMaintenanceAdmission(tx);
        const saved = await tx.run.updateMany({ where: {
          id: run.id, status: "running", leaseOwner, leaseFence, maintenanceCancelRequestedAt: null,
        }, data: { status: "maintenance_paused", leaseOwner: null, leaseExpiresAt: null,
          maintenanceCheckpoint: JSON.stringify({ ...continuation, leaseFence }),
          error: maintenanceAttention(reason) } });
        if (saved.count !== 1) return false;
        await tx.attempt.updateMany({ where: { runId: run.id, fence: leaseFence, status: "running" },
          data: { status: "maintenance_paused", finishedAt: new Date() } });
        return true;
      });
      if (held) await checkpointEvent(run, "maintenance_paused").catch((error) =>
        getLogger().warn("Maintenance hold notification failed", { runId: run.id, error }));
      return held;
    },
    async checkpoint(run: Run, leaseOwner: string, leaseFence: number, revision: number,
      continuation: Omit<ExecutorContinuation, "kind" | "runId" | "authority" | "approvals" | "leaseFence">) {
      const saved = await deps.prisma.$transaction(async (tx) => {
        await lockMaintenanceAdmission(tx);
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM runs WHERE id = ${run.id} FOR UPDATE`;
        const current = await authority(tx, run.id);
        const approvals = await tx.externalEffect.findMany({ where: { runId: run.id, status: "approved" },
          select: { id: true, kind: true, request: true, status: true }, orderBy: { id: "asc" } });
        const checkpoint = JSON.stringify({ ...continuation, kind: "executor-maintenance-v1", runId: run.id, leaseFence,
          authority: current.snapshot ?? "unverifiable", approvals } satisfies ExecutorContinuation);
        const committed = await checkpointMaintenanceRun(tx, {
          runId: run.id, leaseOwner, leaseFence, checkpoint, observedRevision: revision,
        });
        if (committed && current.reason) await tx.run.update({ where: { id: run.id },
          data: { error: maintenanceAttention(current.reason) } });
        return committed;
      });
      if (saved) await checkpointEvent(run, "maintenance_paused").catch((error) =>
        getLogger().warn("Maintenance checkpoint notification failed", { runId: run.id, error }));
      return saved;
    },

    async reconcile(retryRoutine: (runId: string) => Promise<"held" | void>,
      reconcileEffects?: () => Promise<void>) {
      for await (const target of pages((afterId) => deps.maintenance?.cancellationTargets(100, afterId) ?? Promise.resolve([]))) {
        try {
        const run = await deps.prisma.run.findUnique({ where: { id: target.id } });
        if (!run || run.leaseFence !== target.leaseFence || !run.maintenanceCancelRequestedAt) continue;
        // Snapshot exact per-run fences before cancellation. Never kill another run's screen.
        const leases = await deps.prisma.computerExecutionLease.findMany({ where: { runId: run.id }, include: { computer: true } });
        const cancelled = await deps.prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR UPDATE`;
          await tx.$queryRaw`SELECT id FROM runs WHERE id = ${run.id} FOR UPDATE`;
          const current = await tx.run.findUnique({ where: { id: run.id } });
          if (!current?.maintenanceCancelRequestedAt || current.leaseFence !== target.leaseFence) return false;
          if (!["completed", "failed", "cancelled"].includes(current.status)) {
            await cancelRunsInTransaction(tx, [current], new Date());
          }
          return true;
        });
        if (!cancelled) continue;
        if (!["completed", "failed", "cancelled"].includes(run.status)) {
          await deps.events.append({ spaceId: run.spaceId, threadId: run.threadId, botId: run.botId,
            runId: run.id, type: "run.cancelled", payload: { reason: "maintenance-force-stop" } });
        }
        let abortError: unknown;
        const aborting = deps.runtime.abort(run.id).catch((error) => { abortError = error; });
        for (const lease of leases) {
          if (!lease.computer.providerRef) throw new Error("Maintenance cancellation provider identity unavailable");
          const context: AdapterContext = { operationId: "maintenance-force-stop", traceId: "maintenance-force-stop",
            spaceId: run.spaceId, userId: run.userId, botId: run.botId, runId: run.id,
            screenLeaseId: screenLeaseIdForRun(lease, run.id), cancelRunWork: true,
            signal: AbortSignal.timeout(30_000) };
          const computer = toComputerRef(lease.computer);
          if (!(await cancelComputerRunWork(deps.sandbox, computer, lease.computerId, run.id, context))) {
            throw new Error("Maintenance cancellation teardown unconfirmed");
          }
          if (!deps.sandbox.releaseScreen) throw new Error("Maintenance screen teardown unavailable");
          await deps.sandbox.releaseScreen(computer, context);
        }
        await aborting;
        if (abortError) throw abortError;
        await expireComputerExecutionLeases(deps.prisma, { runId: run.id });
        await deps.prisma.computer.updateMany({ where: { executionRunId: run.id },
          data: { executionRunId: null, executionBotId: null, executionLeaseExpiresAt: null } });
        await deps.maintenance!.acknowledgeCancellation(run.id, target.leaseFence);
        } catch (error) {
          getLogger().warn("Maintenance force-stop remains unconfirmed", { runId: target.id, error });
        }
      }
      await reconcileEffects?.();
      if (!(await deps.prisma.$transaction((tx) => lockMaintenanceAdmission(tx))).admitted) return;
      for await (const run of pages((afterId) => deps.prisma.run.findMany({ where: {
        status: "maintenance_paused", maintenanceCancelRequestedAt: null,
        ...(afterId ? { id: { gt: afterId } } : {}),
      }, orderBy: { id: "asc" }, take: 100 }))) {
        if (maintenanceAttentionReason(run.error)?.startsWith("runtime-")) continue;
        if (!mayValidate(run)) continue;
        try {
          const continuation = readExecutorContinuation(run.maintenanceCheckpoint, run.id);
          if (!continuation) throw new Error("Exact continuation unavailable");
          const checked = await fleetAuthority(deps, run, authorityTimeoutMs);
          const resumed = await deps.prisma.$transaction(async (tx) => {
            if (!(await lockMaintenanceAdmission(tx)).admitted) return false;
            await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR UPDATE`;
            return resumeMaintenanceRun(tx, run.id, async (tx, locked) => {
            const reason = locked.leaseFence !== run.leaseFence || locked.checkpoint !== run.maintenanceCheckpoint
              ? "continuation-already-consumed" : await validateAuthority(tx, run, continuation, checked);
            if (reason) {
              // An unchanged hold is not rewritten, so `updatedAt` keeps when it was first held.
              if (run.error !== maintenanceAttention(reason)) {
                await tx.run.update({ where: { id: run.id }, data: { error: maintenanceAttention(reason) } });
              }
              return false;
            }
            await tx.run.update({ where: { id: run.id }, data: { error: null } });
            return true;
            });
          });
          if (resumed) { await checkpointEvent(run, "queued"); await deps.jobs.enqueue(runContinueJob(run.id)); }
        } catch (error) {
          getLogger().warn("Maintenance continuation needs attention", { runId: run.id, error });
          await deps.prisma.run.updateMany({ where: { id: run.id, status: "maintenance_paused" },
            data: { error: maintenanceAttention("continuation-verification-unavailable") } });
        }
      }
      for await (const run of pages((afterId) => deps.prisma.run.findMany({ where: {
        status: "failed", maintenanceCheckpoint: { startsWith: '{"kind":"routine-retry-held"' },
        ...(afterId ? { id: { gt: afterId } } : {}),
      }, orderBy: { id: "asc" }, take: 100 }))) {
        if (await retryRoutine(run.id) === "held") continue;
        await deps.prisma.run.updateMany({ where: {
          id: run.id, status: "failed", maintenanceCheckpoint: run.maintenanceCheckpoint,
        }, data: { maintenanceCheckpoint: null } });
      }
    },
  };
}
