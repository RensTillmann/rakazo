import type {
  MaintenanceRecovery,
  MaintenanceRecoveryCommand,
  MaintenanceRecoveryItem,
  MaintenanceRecoveryResult,
} from "@rakazo/contracts";
import { MaintenanceRecoveryCommandSchema } from "@rakazo/contracts";
import { SETTLED_EFFECT_STATUSES } from "@rakazo/core";
import type { Pool, PoolClient } from "pg";
import type { CaseCoordination } from "./case-coordinators.js";
import { caseCoordinatorOf, fleetCoordinatorOf } from "./case-coordinators.js";
import { askCaseRef } from "./decisions.js";
import { MaintenanceConflictError, MaintenanceOwnerRequiredError } from "./maintenance.js";

export interface MaintenanceRecoveryStore {
  recoveryForOperator(operatorId: string): Promise<MaintenanceRecovery>;
  settleRecovery(
    operatorId: string,
    command: MaintenanceRecoveryCommand,
  ): Promise<MaintenanceRecoveryResult>;
}

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);

type Queryable = Pick<PoolClient, "query">;

export type RecoveryEvent = {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
};

export type EffectEvidence =
  | {
      kind: "conclusive";
      status: "completed" | "failed" | "uncertain";
      basis: string;
      error?: string;
    }
  | { kind: "missing"; missing: string };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseArgs(text: unknown): unknown {
  if (typeof text !== "string") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Does this recorded event describe exactly this effect's call (same tool, same arguments)? */
function describesEffect(
  kind: string,
  request: Record<string, unknown>,
  event: RecoveryEvent,
): boolean {
  const payload = event.payload;
  if (event.type === "agent.tool.called") {
    const args = parseArgs(payload.argsPreview);
    return payload.name === kind && args !== undefined && canonical(args) === canonical(request);
  }
  if (event.type === "computer.command" && payload.kind === kind) {
    if (kind === "shell") {
      return (
        payload.command === request.command &&
        (request.cwd === undefined || payload.cwd === request.cwd)
      );
    }
    return typeof request.path === "string" && payload.command === request.path;
  }
  return false;
}

/**
 * Settle an effect only from the run's own records of that exact call. The parent run's terminal
 * status or an expired lease is never evidence: a matching call must have a recorded completion.
 * An error after the call started (other than the computer reporting the action failed) leaves
 * the outcome unknown, so it maps to `uncertain`, never to `failed`.
 */
export function deriveEffectEvidence(
  effect: { kind: string; request: unknown },
  events: readonly RecoveryEvent[],
): EffectEvidence {
  const request =
    effect.request && typeof effect.request === "object"
      ? (effect.request as Record<string, unknown>)
      : {};
  const executions = new Set<string>();
  for (const event of events) {
    if (
      describesEffect(effect.kind, request, event) &&
      typeof event.payload.executionId === "string"
    ) {
      executions.add(event.payload.executionId);
    }
  }
  if (executions.size === 0) {
    return {
      kind: "missing",
      missing: `No recorded ${effect.kind} call matches this effect's arguments.`,
    };
  }
  if (executions.size > 1) {
    return {
      kind: "missing",
      missing: `${executions.size} recorded ${effect.kind} calls match; the evidence cannot be attributed to one.`,
    };
  }
  const [executionId] = [...executions];
  const completed = events.find(
    (event) => event.type === "agent.tool.completed" && event.payload.executionId === executionId,
  );
  if (!completed) {
    return {
      kind: "missing",
      missing: `The ${effect.kind} call started but no completion was recorded.`,
    };
  }
  const outcome = completed.payload.outcome;
  const error = typeof completed.payload.error === "string" ? completed.payload.error : undefined;
  const at = `agent.tool.completed #${completed.seq}`;
  if (outcome === "succeeded") {
    return { kind: "conclusive", status: "completed", basis: `${at} reports the call succeeded.` };
  }
  if (outcome === "error" && error?.startsWith("sandbox action failed:")) {
    return {
      kind: "conclusive",
      status: "failed",
      error,
      basis: `${at}: the computer reported the action failed (${error.slice(0, 160)}).`,
    };
  }
  if (outcome === "error") {
    return {
      kind: "conclusive",
      status: "uncertain",
      error,
      basis: `${at}: the call ended with "${(error ?? "an error").slice(0, 160)}" after it started, so whether it took effect is unknown.`,
    };
  }
  return { kind: "missing", missing: `${at} has no recognised outcome.` };
}

/** Prisma stores naive UTC timestamps; format them in SQL so the host timezone never shifts them. */
function utc(column: string): string {
  return `to_char(${column}, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

async function requireOwner(client: Queryable, operatorId: string, lock: boolean) {
  const owner = await client.query<{ ownerUserId: string | null }>(
    `SELECT "ownerUserId" FROM "deployment_settings" WHERE "id" = 'default'${lock ? " FOR SHARE" : ""}`,
  );
  if (!operatorId || owner.rows[0]?.ownerUserId !== operatorId)
    throw new MaintenanceOwnerRequiredError();
}

async function runEvents(client: Queryable, runId: string, since: Date): Promise<RecoveryEvent[]> {
  const result = await client.query<RecoveryEvent>(
    `SELECT "seq", "type", "payload" FROM "events"
     WHERE "runId" = $1 AND "type" IN ('agent.tool.called', 'agent.tool.completed', 'computer.command')
       AND "createdAt" >= $2::timestamp(3) - interval '2 seconds'
     ORDER BY "seq" LIMIT 5000`,
    [runId, since],
  );
  return result.rows;
}

type NewerAttempt = { id: string; fence: number; status: string } | null;

function attemptEvidence(attempt: { fence: number; leaseFence: number }, newer: NewerAttempt) {
  if (newer && attempt.leaseFence > attempt.fence) {
    return `Attempt ${newer.id} (fence ${newer.fence}) finished the run as ${newer.status}; the run's lease fence is ${attempt.leaseFence}, so fence ${attempt.fence} can no longer write.`;
  }
  return null;
}

async function newerFinishedAttempt(
  client: Queryable,
  runId: string,
  fence: number,
): Promise<NewerAttempt> {
  const result = await client.query<{ id: string; fence: number; status: string }>(
    `SELECT "id", "fence", "status" FROM "attempts"
     WHERE "runId" = $1 AND "fence" > $2 AND "status" <> 'running'
     ORDER BY "fence" DESC LIMIT 1`,
    [runId, fence],
  );
  return result.rows[0] ?? null;
}

function caseNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * The case a Fleet wake body names: the service's `case`, or the one `case` all of the gate's
 * items share. Job numbers (`items[].n`) are jobs, not cases, and are never taken for one.
 */
export function fleetWakeCase(wake: unknown): number | null {
  if (!wake || typeof wake !== "object") return null;
  const direct = "case" in wake ? caseNumber(wake.case) : null;
  if (direct !== null) return direct;
  if (!("items" in wake) || !Array.isArray(wake.items)) return null;
  const itemCases = new Set(
    wake.items.map((item: unknown) =>
      item && typeof item === "object" && "case" in item ? caseNumber(item.case) : null,
    ),
  );
  const [only] = itemCases;
  return itemCases.size === 1 && only !== undefined ? only : null;
}

/**
 * Q21: who answers for each item, and whether only the user can settle it. The case comes from the
 * run's to-dos' case link or its own card heads (`askCaseRef`), never from free text. A case item
 * belongs to that case's coordinator (`caseCoordinatorOf` the run's bot); anything else is internal
 * and belongs to the Fleet coordinator.
 */
async function accountFor(
  client: Queryable,
  ownerId: string,
  items: MaintenanceRecoveryItem[],
  coordination: CaseCoordination,
): Promise<void> {
  const runIds = [...new Set(items.flatMap((item) => (item.runId ? [item.runId] : [])))];
  const cases = new Map<string, number>();
  /** Runs a Fleet wake started; a case the wake does not name stays unknown, never guessed. */
  const fleetWoken = new Set<string>();
  /** The wake's top-level `fleet` flag: whether the case is a fleet case; absent when not said. */
  const fleetCase = new Map<string, boolean>();
  const runBots = new Map<string, string>();
  if (runIds.length) {
    const runs = await client.query<{ id: string; botId: string | null }>(
      `SELECT "id", "botId" FROM "runs" WHERE "id" = ANY($1)`,
      [runIds],
    );
    for (const run of runs.rows) if (run.botId) runBots.set(run.id, run.botId);
    const todos = await client.query<{ runId: string; caseRef: number }>(
      `SELECT "runId", "caseRef" FROM "user_todos" WHERE "runId" = ANY($1) AND "caseRef" IS NOT NULL`,
      [runIds],
    );
    for (const row of todos.rows) cases.set(row.runId, row.caseRef);
    // The Fleet gate's and service's wake bodies are stored with the run's inbound message.
    const wakes = await client.query<{ runId: string; wake: unknown }>(
      `SELECT "runId", "payload"->'inboundDelivery'->'payload' AS "wake" FROM "events"
        WHERE "runId" = ANY($1) AND "type" = 'thread.message.created'
          AND "payload"->'inboundDelivery'->'payload'->>'source' IN ('fleet-gate', 'fleet-service')`,
      [runIds],
    );
    for (const row of wakes.rows) {
      fleetWoken.add(row.runId);
      if (row.wake && typeof row.wake === "object" && "fleet" in row.wake) {
        if (typeof row.wake.fleet === "boolean") fleetCase.set(row.runId, row.wake.fleet);
      }
      const caseRef = fleetWakeCase(row.wake);
      if (caseRef !== null && !cases.has(row.runId)) cases.set(row.runId, caseRef);
    }
    const cards = await client.query<{ runId: string; text: string | null }>(
      `SELECT m."runId", b->>'text' AS "text"
         FROM "messages" m, jsonb_array_elements(m."blocks") b
        WHERE m."runId" = ANY($1) AND m."role" = 'bot' AND b->>'kind' = 'ask'
        ORDER BY m."seq"`,
      [runIds],
    );
    for (const row of cards.rows) {
      const caseRef = askCaseRef(row.text ?? "");
      if (caseRef !== null && !cases.has(row.runId)) cases.set(row.runId, caseRef);
    }
  }
  const bots = (
    await client.query<{ id: string; name: string }>(
      `SELECT "id", "name" FROM "bots" WHERE "userId" = $1 AND "archivedAt" IS NULL`,
      [ownerId],
    )
  ).rows;
  const internal = fleetCoordinatorOf(bots, coordination)?.name ?? null;
  for (const item of items) {
    const caseRef = item.runId ? (cases.get(item.runId) ?? null) : null;
    const asker = item.runId ? (runBots.get(item.runId) ?? null) : null;
    item.caseRef = caseRef;
    // A Fleet wake says whether its case is a fleet case: then the Fleet coordinator answers,
    // otherwise the default case coordinator. Without that word, a case item goes to its case's
    // coordinator and anything else (a Fleet wake with no case included) to the Fleet coordinator.
    const fleet = item.runId ? fleetCase.get(item.runId) : undefined;
    item.coordinator =
      fleet === true
        ? internal
        : fleet === false
          ? (caseCoordinatorOf(bots, coordination, null)?.name ?? item.bot)
          : caseRef === null
            ? internal
            : (caseCoordinatorOf(bots, coordination, asker)?.name ?? item.bot);
    item.caseUnknown = caseRef === null && item.runId !== null && fleetWoken.has(item.runId);
    // The recovery commands are the owner's: applying recorded evidence and recording a checked
    // outcome; an unresolved Fleet service effect only the operator settles, with `fleet settle`.
    // Draining items settle themselves; other unknowns are the coordinator's to chase.
    item.userActionNeeded =
      item.state === "settleable" ||
      item.ownerVerifiable ||
      (item.kind === "fleet-effect" && item.state === "unresolved");
  }
}

export function createMaintenanceRecoveryStore(
  pool: Pick<Pool, "connect">,
  coordination: CaseCoordination,
): MaintenanceRecoveryStore {
  return {
    async recoveryForOperator(operatorId) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        await requireOwner(client, operatorId, false);
        const STALE = "CURRENT_TIMESTAMP - interval '10 minutes'";
        const items: MaintenanceRecoveryItem[] = [];
        const base = {
          proposed: null,
          missing: null,
          ownerVerifiable: false,
          caseRef: null,
          caseUnknown: false,
          coordinator: null,
          userActionNeeded: false,
        } satisfies Partial<MaintenanceRecoveryItem>;

        const runs = await client.query(
          `SELECT r."id", r."status", COALESCE(r."leaseExpiresAt" > CURRENT_TIMESTAMP, false) AS "live",
             ${utc('r."updatedAt"')} AS "updatedAt", b."name" AS "bot"
           FROM "runs" r LEFT JOIN "bots" b ON b."id" = r."botId"
           WHERE r."status" IN ('running', 'leased') ORDER BY r."id"`,
        );
        for (const run of runs.rows) {
          const live = run.live === true;
          items.push({
            ...base,
            kind: "run",
            id: run.id,
            status: run.status,
            bot: run.bot ?? null,
            runId: run.id,
            runStatus: run.status,
            operation: "run",
            startedAt: null,
            lastEvidenceAt: run.updatedAt,
            state: live ? "draining" : "unresolved",
            evidence: live
              ? "The worker holds a live lease and will checkpoint it."
              : "Its lease expired without a heartbeat.",
            missing: live
              ? null
              : "A worker restart reclaims an expired lease; until then its progress is unknown.",
          });
        }

        const attempts = await client.query(
          `SELECT a."id", a."runId", a."fence", a."status", ${utc('a."startedAt"')} AS "startedAt",
             r."status" AS "runStatus", r."leaseFence", b."name" AS "bot"
           FROM "attempts" a JOIN "runs" r ON r."id" = a."runId" LEFT JOIN "bots" b ON b."id" = r."botId"
           WHERE a."status" = 'running'
             AND NOT (r."status" IN ('running', 'leased') AND r."leaseFence" = a."fence")
           ORDER BY a."id"`,
        );
        for (const attempt of attempts.rows) {
          const basis = attemptEvidence(
            attempt,
            await newerFinishedAttempt(client, attempt.runId, attempt.fence),
          );
          items.push({
            ...base,
            kind: "attempt",
            id: attempt.id,
            status: attempt.status,
            bot: attempt.bot ?? null,
            runId: attempt.runId,
            runStatus: attempt.runStatus,
            operation: `attempt (fence ${attempt.fence})`,
            startedAt: attempt.startedAt,
            lastEvidenceAt: attempt.startedAt,
            state: basis ? "settleable" : "unresolved",
            evidence: `The run is ${attempt.runStatus} but this attempt never reported an end.`,
            proposed: basis ? { status: "interrupted", basis } : null,
            missing: basis
              ? null
              : `No newer fenced attempt finished the run; the outcome of fence ${attempt.fence} is unknown.`,
          });
        }

        const effects = await client.query(
          `SELECT e."id", e."runId", e."kind", e."status", e."request", e."createdAt",
             ${utc('e."createdAt"')} AS "startedAt", ${utc('e."updatedAt"')} AS "updatedAt",
             e."updatedAt" < ${STALE} AS "stale", r."status" AS "runStatus", b."name" AS "bot"
           FROM "external_effects" e JOIN "runs" r ON r."id" = e."runId"
           LEFT JOIN "bots" b ON b."id" = r."botId"
           WHERE e."status" <> ALL($1::text[]) ORDER BY e."createdAt", e."id"`,
          [SETTLED_EFFECT_STATUSES],
        );
        for (const effect of effects.rows) {
          const terminal = TERMINAL_RUN_STATUSES.has(effect.runStatus);
          const common = {
            ...base,
            kind: "effect" as const,
            id: effect.id,
            status: effect.status,
            bot: effect.bot ?? null,
            runId: effect.runId,
            runStatus: effect.runStatus,
            operation: effect.kind,
            startedAt: effect.startedAt,
            lastEvidenceAt: effect.updatedAt,
          };
          if (!terminal) {
            const stale = effect.stale === true;
            items.push({
              ...common,
              state: stale ? "unresolved" : "draining",
              evidence: `Its run is ${effect.runStatus}; the run settles its own effects.`,
              missing: stale
                ? "No update for more than 10 minutes while its run is still active."
                : null,
            });
            continue;
          }
          if (effect.status === "executing") {
            const evidence = deriveEffectEvidence(
              effect,
              await runEvents(client, effect.runId, effect.createdAt),
            );
            const conclusive = evidence.kind === "conclusive";
            items.push({
              ...common,
              state: conclusive ? "settleable" : "unresolved",
              evidence: `The run ended (${effect.runStatus}) while this ${effect.kind} was still marked executing.`,
              proposed: conclusive ? { status: evidence.status, basis: evidence.basis } : null,
              missing: conclusive ? null : evidence.missing,
              ownerVerifiable: !conclusive || evidence.status === "uncertain",
            });
            continue;
          }
          items.push({
            ...common,
            state: "unresolved",
            evidence:
              effect.status === "uncertain"
                ? `The ${effect.kind} started but its outcome is unknown.`
                : `The run ended (${effect.runStatus}) with this effect still ${effect.status}.`,
            missing:
              effect.status === "uncertain"
                ? "Check the destination, then record what actually happened."
                : "The provider has not reported a final result.",
            ownerVerifiable: effect.status === "uncertain",
          });
        }

        const fleet = await client.query<{ relation: string | null }>(
          "SELECT to_regclass('fleet.service_effects')::text AS relation",
        );
        if (fleet.rows[0]?.relation) {
          const fleetEffects = await client.query(
            `SELECT id, kind, status, updated_at < ${STALE} AS stale,
               ${utc("created_at AT TIME ZONE 'UTC'")} AS "startedAt",
               ${utc("updated_at AT TIME ZONE 'UTC'")} AS "updatedAt"
             FROM fleet.service_effects
             WHERE status IN ('executing', 'uncertain') ORDER BY created_at, id`,
          );
          for (const effect of fleetEffects.rows) {
            const unresolved = effect.status === "uncertain" || effect.stale === true;
            items.push({
              ...base,
              kind: "fleet-effect",
              id: effect.id,
              status: effect.status,
              bot: null,
              runId: null,
              runStatus: null,
              operation: effect.kind,
              startedAt: effect.startedAt,
              lastEvidenceAt: effect.updatedAt,
              state: unresolved ? "unresolved" : "draining",
              evidence: "Fleet service operation.",
              // Only the Fleet service holds its receipt; its coordinator settles it there.
              missing: unresolved
                ? `Settle it in the Fleet service: \`python -m fleet settle ${effect.id} --result ok|failed --evidence <link>\`.`
                : null,
            });
          }
        }

        const operations = await client.query(
          `SELECT 'cloud agent' AS "operation", "id", "status" FROM "cloud_agents"
             WHERE "status" = 'running' AND ("launchDispatched" OR ("remoteId" IS NOT NULL
               AND ("followup" IS NULL OR "followupDispatching")))
           UNION ALL SELECT 'team chat message', "id", "status" FROM "external_messages"
             WHERE "status" IN ('judging', 'delivering', 'uncertain')
           UNION ALL SELECT 'messaging delivery', "id", "status" FROM "messaging_outbound"
             WHERE "status" IN ('executing', 'uncertain')
           UNION ALL SELECT 'routine check', "id", "watchState" #>> '{maintenanceCheck,status}' FROM "routines"
             WHERE "watchState" #>> '{maintenanceCheck,status}' IN ('executing', 'uncertain')
           UNION ALL SELECT 'computer suspend', "id", "state" FROM "computers" WHERE "state" = 'suspending'
           ORDER BY 1, 2`,
        );
        for (const operation of operations.rows) {
          const uncertain = operation.status === "uncertain";
          items.push({
            ...base,
            kind: "operation",
            id: operation.id,
            status: operation.status,
            bot: null,
            runId: null,
            runStatus: null,
            operation: operation.operation,
            startedAt: null,
            lastEvidenceAt: null,
            state: uncertain ? "unresolved" : "draining",
            evidence: uncertain ? "Its outcome is unknown." : "Still in progress.",
            missing: uncertain ? "Its own reconciler must confirm the outcome." : null,
          });
        }
        await accountFor(client, operatorId, items, coordination);
        await client.query("COMMIT");
        return { items };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async settleRecovery(operatorId, command) {
      if (!MaintenanceRecoveryCommandSchema.safeParse(command).success) {
        throw new Error("Invalid recovery command");
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await requireOwner(client, operatorId, true);
        const previous = await client.query(
          `SELECT * FROM "maintenance_recovery" WHERE "requestId" = $1`,
          [command.requestId],
        );
        const replay = previous.rows[0];
        if (replay) {
          if (
            replay.operatorId !== operatorId ||
            replay.targetKind !== command.kind ||
            replay.targetId !== command.id ||
            replay.basis !== command.basis
          ) {
            throw new MaintenanceConflictError();
          }
          await client.query("COMMIT");
          return { outcome: "replayed", status: replay.toStatus };
        }
        const done = async (
          result: MaintenanceRecoveryResult,
          write?: { from: string; to: string; evidence: Record<string, unknown> },
        ) => {
          if (write) {
            await client.query(
              `INSERT INTO "maintenance_recovery"
               ("requestId", "operatorId", "targetKind", "targetId", "basis", "fromStatus", "toStatus", "evidence")
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
              [
                command.requestId,
                operatorId,
                command.kind,
                command.id,
                command.basis,
                write.from,
                write.to,
                write.evidence,
              ],
            );
          }
          await client.query("COMMIT");
          return result;
        };

        if (command.kind === "attempt") {
          const found = await client.query(
            `SELECT a."id", a."runId", a."fence", a."status", r."leaseFence"
             FROM "attempts" a JOIN "runs" r ON r."id" = a."runId"
             WHERE a."id" = $1 FOR UPDATE OF a`,
            [command.id],
          );
          const attempt = found.rows[0];
          if (!attempt)
            return done({ outcome: "refused", status: "missing", reason: "Attempt not found." });
          if (attempt.status !== command.expectedStatus)
            return done({ outcome: "changed", status: attempt.status });
          const basis = attemptEvidence(
            attempt,
            await newerFinishedAttempt(client, attempt.runId, attempt.fence),
          );
          if (!basis) {
            return done({
              outcome: "refused",
              status: attempt.status,
              reason: "No newer fenced attempt finished this run.",
            });
          }
          const updated = await client.query(
            `UPDATE "attempts" SET "status" = 'interrupted', "finishedAt" = CURRENT_TIMESTAMP, "error" = $2
             WHERE "id" = $1 AND "status" = 'running'`,
            [command.id, `Settled from evidence: ${basis}`],
          );
          if (updated.rowCount !== 1) return done({ outcome: "changed", status: "unknown" });
          return done(
            { outcome: "settled", status: "interrupted" },
            { from: attempt.status, to: "interrupted", evidence: { evidence: basis } },
          );
        }

        const found = await client.query(
          `SELECT e."id", e."runId", e."kind", e."status", e."request", e."createdAt", r."status" AS "runStatus"
           FROM "external_effects" e JOIN "runs" r ON r."id" = e."runId"
           WHERE e."id" = $1 FOR UPDATE OF e`,
          [command.id],
        );
        const effect = found.rows[0];
        if (!effect)
          return done({ outcome: "refused", status: "missing", reason: "Effect not found." });
        if (effect.status !== command.expectedStatus)
          return done({ outcome: "changed", status: effect.status });
        if (!TERMINAL_RUN_STATUSES.has(effect.runStatus)) {
          return done({
            outcome: "refused",
            status: effect.status,
            reason: "Its run is still active and settles its own effects.",
          });
        }
        const evidence =
          effect.status === "executing"
            ? deriveEffectEvidence(effect, await runEvents(client, effect.runId, effect.createdAt))
            : null;
        let to: string;
        let record: Record<string, unknown>;
        let error: string | undefined;
        if (command.basis === "evidence") {
          if (evidence?.kind !== "conclusive") {
            return done({
              outcome: "refused",
              status: effect.status,
              reason:
                evidence?.kind === "missing"
                  ? evidence.missing
                  : "No recorded evidence settles this effect.",
            });
          }
          to = evidence.status;
          record = { evidence: evidence.basis };
          error = evidence.error;
        } else {
          if (
            !["executing", "uncertain"].includes(effect.status) ||
            (evidence?.kind === "conclusive" && evidence.status !== "uncertain")
          ) {
            return done({
              outcome: "refused",
              status: effect.status,
              reason: "Recorded evidence settles this effect; apply it instead.",
            });
          }
          to = command.outcome;
          record = { note: command.note.trim() };
          if (to === "failed")
            error = `Owner verified it did not take effect: ${command.note.trim()}`;
        }
        const provenance = {
          requestId: command.requestId,
          operatorId,
          basis: command.basis,
          from: effect.status,
          to,
          at: new Date().toISOString(),
          ...record,
        };
        const updated = await client.query(
          `UPDATE "external_effects"
           SET "status" = $3, "updatedAt" = CURRENT_TIMESTAMP,
             "result" = COALESCE("result", '{}'::jsonb) || $4::jsonb
           WHERE "id" = $1 AND "status" = $2`,
          [
            command.id,
            effect.status,
            to,
            {
              reconciliation: provenance,
              ...(error ? { error } : {}),
              ...(to === "uncertain" ? { uncertain: true } : {}),
            },
          ],
        );
        if (updated.rowCount !== 1) return done({ outcome: "changed", status: "unknown" });
        return done(
          { outcome: "settled", status: to },
          { from: effect.status, to, evidence: record },
        );
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
