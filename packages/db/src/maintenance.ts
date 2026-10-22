import type { MaintenanceState, MaintenanceSnapshot, MaintenanceCommand, MaintenanceChange } from "@rakazo/contracts";
import { MaintenanceCommandSchema } from "@rakazo/contracts";
import type { MaintenancePauseSpan } from "@rakazo/core";
import type { Pool } from "pg";
import type { Prisma } from "./client.js";

export interface MaintenanceControlStore {
  statusForOperator(operatorId: string): Promise<MaintenanceSnapshot>;
  change(operatorId: string, command: MaintenanceCommand): Promise<MaintenanceChange>;
}
export interface MaintenanceCancellationStore {
  cancellationTargets(limit?: number, afterId?: string): Promise<Array<{ id: string; leaseFence: number }>>;
  acknowledgeCancellation(runId: string, leaseFence: number): Promise<boolean>;
}

/** Stable storage discriminator, independent of operator-facing wording. */
const MAINTENANCE_ATTENTION_PREFIX = "maintenance:attention:";
export function maintenanceAttention(reason: string): string {
  if (!/^[a-z0-9-]+$/.test(reason)) throw new Error("Invalid maintenance attention reason");
  return `${MAINTENANCE_ATTENTION_PREFIX}${reason}`;
}
export function maintenanceAttentionReason(error: string | null | undefined): string | undefined {
  return error?.startsWith(MAINTENANCE_ATTENTION_PREFIX)
    ? error.slice(MAINTENANCE_ATTENTION_PREFIX.length) : undefined;
}

type AuditRow = MaintenanceState & MaintenanceCommand & { operatorId: string };

export class MaintenanceOwnerRequiredError extends Error {
  constructor() {
    super("Deployment owner required");
    this.name = "MaintenanceOwnerRequiredError";
  }
}

export class MaintenanceConflictError extends Error {
  constructor() {
    super("Maintenance command conflicts with durable state; refresh status first");
    this.name = "MaintenanceConflictError";
  }
}

/** Call INSIDE a Prisma transaction; keep admission/claim writes in that transaction.
 * The shared row lock serializes every claim with enter/resume/force-stop.
 * Never hold this transaction open across a provider/network call.
 */
export async function lockMaintenanceAdmission(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  independentHolds: readonly string[] = [],
) {
  const rows = await tx.$queryRaw<MaintenanceState[]>`
    SELECT "active", "revision" FROM "maintenance_state" WHERE "id" = 'default' FOR SHARE`;
  const state = rows[0];
  if (!state) throw new Error("Maintenance state unavailable");
  return {
    admitted: !state.active && independentHolds.length === 0,
    reason: independentHolds.length ? "independent-hold" as const
      : state.active ? "maintenance" as const : "open" as const,
    revision: state.revision,
  };
}

/** A committed executing claim is an already-started effect, not permission to
 * re-send it on retry. Reconcile its original idempotency identity after a crash.
 */
export async function claimMaintenanceEffect(
  tx: Pick<Prisma.TransactionClient, "$queryRaw" | "externalEffect">,
  effectId: string,
  expectedStatus: "intended" | "approved",
  independentHolds: readonly string[] = [],
): Promise<boolean> {
  if (!(await lockMaintenanceAdmission(tx, independentHolds)).admitted) return false;
  const claimed = await tx.externalEffect.updateMany({
    where: { id: effectId, status: expectedStatus },
    data: { status: "executing" },
  });
  return claimed.count === 1;
}

export type MaintenanceContinuation = {
  runId: string;
  checkpoint: string;
  leaseFence: number;
};

/** Call only after the worker reached a safe boundary and drained its own work.
 * Retains the existing run checkpoint (approval/takeover state) independently.
 */
export async function checkpointMaintenanceRun(
  tx: Pick<Prisma.TransactionClient, "$queryRaw" | "run" | "attempt">,
  input: MaintenanceContinuation & { leaseOwner: string; observedRevision?: number },
): Promise<boolean> {
  if (!input.checkpoint) throw new Error("Exact continuation required");
  const admission = await lockMaintenanceAdmission(tx);
  // A worker that observed a hold must drain even if Resume raced its final tool.
  // Persist the exact boundary first; the normal validator decides whether it may queue.
  if (admission.reason !== "maintenance" &&
    !(Number.isSafeInteger(input.observedRevision) && input.observedRevision! > 0 &&
      input.observedRevision! <= admission.revision)) return false;
  const saved = await tx.run.updateMany({
    where: {
      id: input.runId, leaseOwner: input.leaseOwner, leaseFence: input.leaseFence,
      status: { in: ["leased", "running"] }, maintenanceCancelRequestedAt: null,
    },
    data: {
      status: "maintenance_paused", maintenanceCheckpoint: input.checkpoint,
      leaseOwner: null, leaseExpiresAt: null,
    },
  });
  if (saved.count !== 1) return false;
  await tx.attempt.updateMany({
    where: { runId: input.runId, fence: input.leaseFence, status: "running" },
    data: { status: "maintenance_paused", finishedAt: new Date() },
  });
  return true;
}

/** No automatic dispatch. The caller revalidates ownership, dependencies,
 * deadlines, independent holds and exact approval binding under this lock,
 * then enqueues the same durable run identity only when this returns true.
 */
export async function resumeMaintenanceRun(
  tx: Prisma.TransactionClient,
  runId: string,
  revalidate: (tx: Prisma.TransactionClient, continuation: MaintenanceContinuation) => Promise<boolean>,
): Promise<boolean> {
  if (!(await lockMaintenanceAdmission(tx)).admitted) return false;
  const rows = await tx.$queryRaw<MaintenanceContinuation[]>`
    SELECT "id" AS "runId", "maintenanceCheckpoint" AS "checkpoint", "leaseFence"
    FROM "runs" WHERE "id" = ${runId} AND "status" = 'maintenance_paused'
      AND "maintenanceCancelRequestedAt" IS NULL FOR UPDATE`;
  const continuation = rows[0];
  if (!continuation?.checkpoint || !(await revalidate(tx, continuation))) return false;
  const resumed = await tx.run.updateMany({
    where: { id: runId, status: "maintenance_paused", leaseFence: continuation.leaseFence,
      maintenanceCancelRequestedAt: null },
    data: { status: "queued" },
  });
  return resumed.count === 1;
}

/** The pause state; a missing row throws and is never read as resumed. */
export interface MaintenanceStatusStore {
  status(): Promise<MaintenanceState>;
}

/** Trusted server-side store; operatorId MUST come from the authenticated session.
 * No tool/model caller may supply operatorId or invoke this as an approval bypass.
 * Caller must still enforce its existing authentication and CSRF protections.
 */
export function createMaintenanceStore(pool: Pick<Pool, "connect" | "query">) {
  return {
    async status(): Promise<MaintenanceState> {
      const result = await pool.query<MaintenanceState>(
        `SELECT "active", "revision" FROM "maintenance_state" WHERE "id" = 'default'`,
      );
      const state = result.rows[0];
      // A missing migration/row must never be interpreted as resumed.
      if (!state) throw new Error("Maintenance state unavailable");
      return state;
    },

    /** Operator-facing status uses one snapshot for owner and state. */
    async statusForOperator(operatorId: string): Promise<MaintenanceSnapshot> {
      const client = await pool.connect();
      try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const result = await client.query<{
        ownerUserId: string | null;
        active: boolean | null;
        revision: number | null;
        activeRuns: number;
        activeEffects: number;
        pendingRuns: number;
        issues: string[];
      }>(
        `SELECT d."ownerUserId", m."active", m."revision",
          (SELECT count(DISTINCT r."id")::int FROM "runs" r
            WHERE r."status" IN ('running', 'leased')
              OR EXISTS (SELECT 1 FROM "attempts" a
                WHERE a."runId" = r."id" AND a."status" = 'running')) AS "activeRuns",
          ((SELECT count(*) FROM "external_effects"
            WHERE "status" NOT IN ('intended', 'approved', 'denied', 'completed', 'failed',
              'cancelled', 'media_completed', 'media_failed'))
            + (SELECT count(*) FROM "cloud_agents" WHERE "status" = 'running'
              AND ("launchDispatched" OR ("remoteId" IS NOT NULL
                AND ("followup" IS NULL OR "followupDispatching"))))
            + (SELECT count(*) FROM "external_messages"
              WHERE "status" IN ('judging', 'delivering', 'uncertain'))
            + (SELECT count(*) FROM "messaging_outbound"
              WHERE "status" IN ('executing', 'uncertain'))
            + (SELECT count(*) FROM "routines"
              WHERE "watchState" #>> '{maintenanceCheck,status}' IN ('executing', 'uncertain'))
            + (SELECT count(*) FROM "computers" WHERE "state" = 'suspending'))::int AS "activeEffects",
          (SELECT count(*)::int FROM "runs"
            WHERE "status" IN ('queued', 'maintenance_paused')) AS "pendingRuns",
          array_remove(ARRAY[
            CASE WHEN EXISTS (SELECT 1 FROM "external_effects"
              WHERE "status" NOT IN ('intended', 'approved', 'denied', 'completed', 'failed',
                'cancelled', 'executing', 'media_submitting', 'media_pending', 'media_polling',
                'media_completed', 'media_failed')) THEN 'uncertain-effects' END,
            CASE WHEN EXISTS (SELECT 1 FROM "external_effects"
              WHERE "status" IN ('executing', 'media_submitting', 'media_pending', 'media_polling')
                AND "updatedAt" < CURRENT_TIMESTAMP - interval '10 minutes')
              THEN 'unsettled-effects' END,
            CASE WHEN EXISTS (SELECT 1 FROM "messaging_outbound"
              WHERE "status" = 'uncertain') THEN 'uncertain-deliveries' END,
            CASE WHEN EXISTS (SELECT 1 FROM "external_messages"
              WHERE "status" = 'uncertain') THEN 'uncertain-team-chat-effects' END,
            CASE WHEN EXISTS (SELECT 1 FROM "external_messages"
              WHERE "status" = 'judging' AND "lastError" = 'maintenance-force-stop')
              THEN 'team-chat-cancellation-pending' END,
            CASE WHEN EXISTS (SELECT 1 FROM "routines"
              WHERE "watchState" #>> '{maintenanceCheck,status}' = 'executing'
                AND "watchState" #>> '{maintenanceCheck,cancelRequested}' = 'true')
              THEN 'routine-check-cancellation-pending' END,
            CASE WHEN EXISTS (SELECT 1 FROM "routines"
              WHERE "watchState" #>> '{maintenanceCheck,status}' = 'uncertain')
              THEN 'uncertain-routine-checks' END,
            CASE WHEN EXISTS (SELECT 1 FROM "routines"
              WHERE "watchState" #>> '{maintenanceCheck,status}' = 'executing'
                AND ("watchState" #>> '{maintenanceCheck,startedAt}')::timestamptz
                  < CURRENT_TIMESTAMP - interval '10 minutes')
              THEN 'unsettled-routine-checks' END,
            CASE WHEN EXISTS (SELECT 1 FROM "runs"
              WHERE "status" IN ('maintenance_paused', 'queued')
                AND "error" LIKE '${MAINTENANCE_ATTENTION_PREFIX}%') THEN 'continuation-needs-attention' END,
            CASE WHEN EXISTS (SELECT 1 FROM "runs"
              WHERE "maintenanceCancelRequestedAt" IS NOT NULL) THEN 'cancellation-pending' END,
            CASE WHEN EXISTS (SELECT 1 FROM "runs"
              WHERE "status" IN ('running', 'leased')
                AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < CURRENT_TIMESTAMP))
              THEN 'run-lease-expired' END,
            CASE WHEN EXISTS (SELECT 1 FROM "cloud_agents"
              WHERE "cancelRequested") THEN 'remote-cancellation-pending' END
          ], NULL)::text[] || ARRAY(SELECT 'continuation:' || "id" || ':' || "error"
            FROM "runs" WHERE "status" IN ('maintenance_paused', 'queued')
              AND "error" LIKE '${MAINTENANCE_ATTENTION_PREFIX}%' ORDER BY "id") AS "issues"
         FROM "deployment_settings" d
         LEFT JOIN "maintenance_state" m ON m."id" = 'default'
         WHERE d."id" = 'default'`,
      );
      const row = result.rows[0];
      if (!operatorId || !row?.ownerUserId || row.ownerUserId !== operatorId) {
        throw new MaintenanceOwnerRequiredError();
      }
      if (row.active === null || row.revision === null) {
        throw new Error("Maintenance state unavailable");
      }
      const { activeRuns, pendingRuns, issues } = row;
      let activeEffects = row.activeEffects;
      const fleet = await client.query<{ relation: string | null }>(
        "SELECT to_regclass('fleet.service_effects')::text AS relation",
      );
      if (fleet.rows[0]?.relation) {
        const effects = await client.query<{ activeEffects: number; uncertain: boolean; stalled: boolean }>(
          `SELECT count(*)::int AS "activeEffects",
            COALESCE(bool_or(status = 'uncertain'), false) AS uncertain,
            COALESCE(bool_or(status = 'executing' AND updated_at < CURRENT_TIMESTAMP - interval '10 minutes'), false) AS stalled
           FROM fleet.service_effects WHERE status IN ('executing', 'uncertain')`,
        );
        const activity = effects.rows[0];
        if (!activity) throw new Error("Fleet maintenance activity unavailable");
        activeEffects += activity.activeEffects;
        if (activity.uncertain) issues.push("uncertain-fleet-effects");
        if (activity.stalled) issues.push("unsettled-fleet-effects");
      }
      await client.query("COMMIT");
      return {
        state: { active: row.active, revision: row.revision },
        status: {
          phase: issues.length ? "needs_attention" : !row.active ? "running"
            : activeRuns || activeEffects ? "pausing" : "paused",
          activeRuns, activeEffects, pendingRuns, issues,
        },
      };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    /** Trusted worker only; invoke the existing run cancellation/teardown path
     * for each target. Requests survive resume and worker restart.
     */
    async cancellationTargets(limit = 100, afterId?: string): Promise<Array<{ id: string; leaseFence: number }>> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
        throw new Error("Invalid cancellation target limit");
      }
      const result = await pool.query<{ id: string; leaseFence: number }>(
        `SELECT "id", "leaseFence" FROM "runs"
         WHERE "maintenanceCancelRequestedAt" IS NOT NULL
           AND ($2::text IS NULL OR "id" > $2)
         ORDER BY "id" LIMIT $1`, [limit, afterId ?? null],
      );
      return result.rows;
    },

    /** Acknowledge ONLY after teardown; executing/unknown effects must first be
     * reconciled, not converted to success to make the status look quiescent.
     */
    async acknowledgeCancellation(runId: string, leaseFence: number): Promise<boolean> {
      const result = await pool.query(
        `UPDATE "runs" r SET "maintenanceCancelRequestedAt" = NULL
         WHERE r."id" = $1 AND r."leaseFence" = $2
           AND r."maintenanceCancelRequestedAt" IS NOT NULL
           AND r."status" IN ('completed', 'failed', 'cancelled')
           AND NOT EXISTS (SELECT 1 FROM "attempts" a
             WHERE a."runId" = r."id" AND a."status" = 'running')
           AND NOT EXISTS (SELECT 1 FROM "external_effects" e
             WHERE e."runId" = r."id" AND e."status" NOT IN
               ('intended', 'approved', 'denied', 'completed', 'failed', 'cancelled',
                'media_completed', 'media_failed'))
         RETURNING r."id"`, [runId, leaseFence],
      );
      return result.rows.length === 1;
    },

    async change(
      operatorId: string,
      command: MaintenanceCommand,
    ): Promise<MaintenanceChange> {
      if (!operatorId || !MaintenanceCommandSchema.safeParse(command).success) {
        throw new Error("Invalid maintenance command");
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Re-read and lock the authoritative owner, not a cached actor boolean.
        // Lock order is owner then state for every control transaction.
        const owner = await client.query<{ ownerUserId: string | null }>(
          `SELECT "ownerUserId" FROM "deployment_settings" WHERE "id" = 'default' FOR SHARE`,
        );
        if (owner.rows[0]?.ownerUserId !== operatorId) {
          throw new MaintenanceOwnerRequiredError();
        }
        // Fleet's role has SELECT-only access to public state. Its effect claims hold
        // the shared advisory lock, then read state in a fresh SQL statement.
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('rakazo.maintenance', 0))");
        const locked = await client.query<MaintenanceState>(
          `SELECT "active", "revision" FROM "maintenance_state" WHERE "id" = 'default' FOR UPDATE`,
        );
        const state = locked.rows[0];
        if (!state) throw new Error("Maintenance state unavailable");
        const previous = await client.query<AuditRow>(
          `SELECT * FROM "maintenance_audit" WHERE "requestId" = $1`,
          [command.requestId],
        );
        const replay = previous.rows[0];
        if (replay) {
          if (
            replay.operatorId !== operatorId ||
            replay.action !== command.action ||
            replay.expectedRevision !== command.expectedRevision
          ) {
            throw new MaintenanceConflictError();
          }
          await client.query("COMMIT");
          // Return CURRENT status, not the stale state when the command first ran.
          // A retry of enter after an explicit resume must not re-enter maintenance.
          return { state, replayed: true };
        }
        const active = command.action !== "resume";
        if (state.revision !== command.expectedRevision ||
            (command.action !== "force-stop" && state.active === active)) {
          throw new MaintenanceConflictError();
        }
        const next = { active, revision: state.revision + 1 };
        await client.query(
          `UPDATE "maintenance_state" SET "active" = $1, "revision" = $2 WHERE "id" = 'default'`,
          [next.active, next.revision],
        );
        if (command.action === "force-stop") {
          // Request existing teardown paths. Never fake terminal status, release
          // a worker's lease, or declare an unknown provider effect completed.
          await client.query(
            `UPDATE "runs" SET "maintenanceCancelRequestedAt" = CURRENT_TIMESTAMP
             WHERE "maintenanceCancelRequestedAt" IS NULL
               AND ("status" IN ('running', 'leased', 'maintenance_paused')
                 OR EXISTS (SELECT 1 FROM "attempts" a
                   WHERE a."runId" = "runs"."id" AND a."status" = 'running')
                 OR EXISTS (SELECT 1 FROM "external_effects" e
                   WHERE e."runId" = "runs"."id" AND e."status" NOT IN
                     ('intended', 'approved', 'denied', 'completed', 'failed', 'cancelled',
                      'media_completed', 'media_failed')))`,
          );
          await client.query(
            `UPDATE "cloud_agents" SET "cancelRequested" = true,
               "version" = "version" + 1, "nextPollAt" = CURRENT_TIMESTAMP
             WHERE "status" = 'running' AND NOT "cancelRequested"`,
          );
          await client.query(
            `UPDATE "routines" SET "watchState" = jsonb_set(
               "watchState", '{maintenanceCheck,cancelRequested}', 'true'::jsonb, true)
             WHERE "watchState" #>> '{maintenanceCheck,status}' = 'executing'`,
          );
          await client.query(
            `UPDATE "external_messages" SET "lastError" = 'maintenance-force-stop'
             WHERE "status" = 'judging'`,
          );
        }
        await client.query(
          `INSERT INTO "maintenance_audit"
           ("revision", "requestId", "operatorId", "action", "expectedRevision", "active")
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            next.revision,
            command.requestId,
            operatorId,
            command.action,
            command.expectedRevision,
            active,
          ],
        );
        await client.query("COMMIT");
        return { state: next, replayed: false };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

export * from "./maintenance-recovery.js";

/**
 * Every stretch the global pause held work, from the durable audit (enter/force-stop start or
 * continue a hold, resume ends it). The last span is open (`to: null`) while the pause holds.
 */
export async function loadMaintenancePauseSpans(
  db: Pick<Prisma.TransactionClient, "maintenanceAudit">,
): Promise<MaintenancePauseSpan[]> {
  const rows = await db.maintenanceAudit.findMany({
    orderBy: { revision: "asc" },
    select: { active: true, createdAt: true },
  });
  const spans: MaintenancePauseSpan[] = [];
  let open: Date | null = null;
  for (const row of rows) {
    if (row.active && !open) open = row.createdAt;
    if (!row.active && open) {
      spans.push({ from: open, to: row.createdAt });
      open = null;
    }
  }
  if (open) spans.push({ from: open, to: null });
  return spans;
}
