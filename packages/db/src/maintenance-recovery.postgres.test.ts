import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CaseCoordination } from "./case-coordinators.js";
import { createMaintenanceRecoveryStore } from "./maintenance-recovery.js";
import { noCoordinators } from "./testing.js";

// Opt in only with a dedicated disposable LOCAL test database.
const databaseUrl = process.env.MAINTENANCE_TEST_DATABASE_URL;
const suite = databaseUrl ? describe.sequential : describe.skip;

suite("maintenance recovery against PostgreSQL", () => {
  // Its own database, so it can hold a Fleet ledger (`fleet.service_effects`) of its own.
  const database = `recovery_test_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      throw new Error("Recovery tests require a disposable local database");
    }
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE DATABASE "${database}"`);
    url.pathname = `/${database}`;
    pool = new Pool({ connectionString: url.toString(), max: 4 });
    await pool.query(`
      CREATE SCHEMA fleet;
      CREATE TABLE fleet.service_effects (
        id text PRIMARY KEY, kind text NOT NULL, status text NOT NULL, result jsonb,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE "deployment_settings" ("id" TEXT PRIMARY KEY, "ownerUserId" TEXT);
      INSERT INTO "deployment_settings" VALUES ('default', 'operator');
      CREATE TABLE "bots" (
        "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "userId" TEXT NOT NULL DEFAULT 'operator',
        "archivedAt" TIMESTAMP(3)
      );
      CREATE TABLE "runs" (
        "id" TEXT PRIMARY KEY, "botId" TEXT, "status" TEXT NOT NULL,
        "leaseFence" INTEGER NOT NULL DEFAULT 1, "leaseExpiresAt" TIMESTAMP(3),
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),
        "error" TEXT, "maintenanceCancelRequestedAt" TIMESTAMP(3)
      );
      CREATE TABLE "maintenance_state" ("id" TEXT PRIMARY KEY, "active" BOOLEAN NOT NULL, "revision" INTEGER NOT NULL);
      INSERT INTO "maintenance_state" VALUES ('default', true, 1);
      CREATE TABLE "attempts" (
        "id" TEXT PRIMARY KEY, "runId" TEXT NOT NULL, "fence" INTEGER NOT NULL,
        "status" TEXT NOT NULL, "error" TEXT,
        "startedAt" TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'), "finishedAt" TIMESTAMP(3)
      );
      CREATE TABLE "external_effects" (
        "id" TEXT PRIMARY KEY, "runId" TEXT NOT NULL, "kind" TEXT NOT NULL, "status" TEXT NOT NULL,
        "request" JSONB NOT NULL, "result" JSONB,
        "createdAt" TIMESTAMP(3) NOT NULL, "updatedAt" TIMESTAMP(3) NOT NULL
      );
      CREATE TABLE "events" (
        "runId" TEXT, "seq" INTEGER NOT NULL, "type" TEXT NOT NULL, "payload" JSONB NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL
      );
      CREATE TABLE "cloud_agents" (
        "id" TEXT PRIMARY KEY, "status" TEXT NOT NULL, "launchDispatched" BOOLEAN NOT NULL DEFAULT false,
        "remoteId" TEXT, "followup" JSONB, "followupDispatching" BOOLEAN NOT NULL DEFAULT false
      );
      CREATE TABLE "external_messages" ("id" TEXT PRIMARY KEY, "status" TEXT NOT NULL);
      CREATE TABLE "messaging_outbound" ("id" TEXT PRIMARY KEY, "status" TEXT NOT NULL);
      CREATE TABLE "routines" ("id" TEXT PRIMARY KEY, "watchState" JSONB);
      CREATE TABLE "computers" ("id" TEXT PRIMARY KEY, "state" TEXT NOT NULL);
      CREATE TABLE "messages" (
        "id" TEXT PRIMARY KEY, "runId" TEXT, "role" TEXT NOT NULL, "seq" INTEGER NOT NULL,
        "blocks" JSONB NOT NULL
      );
      CREATE TABLE "user_todos" ("id" TEXT PRIMARY KEY, "runId" TEXT NOT NULL, "caseRef" INTEGER);
    `);
    await pool.query(
      await readFile(
        new URL(
          "../prisma/migrations/20261021160000_maintenance_recovery/migration.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    await pool.query(
      await readFile(
        new URL(
          "../prisma/migrations/20261023120000_maintenance_recovery_run_actions/migration.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
  });

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE "bots", "runs", "attempts", "external_effects", "events", "maintenance_recovery",
        "cloud_agents", "external_messages", "messaging_outbound", "routines", "computers",
        "messages", "user_todos", fleet.service_effects;
      INSERT INTO "bots" ("id", "name") VALUES
        ('isabella', 'Isabella'), ('riona', 'Riona'), ('jill', 'Jill'), ('josy', 'Josy'),
        ('elena', 'Elena');
    `);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin?.end();
  });

  /** The three records the Q35 rollout left behind, with the events their runs actually wrote. */
  async function seedQ35Records() {
    await pool.query(`
      INSERT INTO "runs" ("id", "botId", "status", "leaseFence") VALUES
        ('run-isabella', 'isabella', 'completed', 2),
        ('run-riona', 'riona', 'completed', 1),
        ('run-jill', 'jill', 'failed', 1);
      INSERT INTO "attempts" ("id", "runId", "fence", "status", "startedAt", "finishedAt") VALUES
        ('attempt-1', 'run-isabella', 1, 'running', '2026-10-19 13:58:42.947', NULL),
        ('attempt-2', 'run-isabella', 2, 'completed', '2026-10-19 14:39:04.523', '2026-10-19 14:39:52.438'),
        ('attempt-jill', 'run-jill', 1, 'failed', '2026-10-21 02:32:09.202', '2026-10-21 02:37:41.38');
      INSERT INTO "external_effects" ("id", "runId", "kind", "status", "request", "createdAt", "updatedAt") VALUES
        ('open-path', 'run-riona', 'open_path', 'executing',
          '{"path": "/home/rakazo/tmp/jpg284/photo.png"}', '2026-10-21 06:07:48.8', '2026-10-21 06:07:48.803'),
        ('shell', 'run-jill', 'shell', 'executing',
          '{"cwd": "/home/rakazo/repos/rakazo", "command": "git diff && git status --short"}',
          '2026-10-21 02:37:31.795', '2026-10-21 02:37:40.938');
      INSERT INTO "events" ("runId", "seq", "type", "payload", "createdAt") VALUES
        ('run-riona', 8564, 'agent.tool.completed',
          '{"name": "shell", "outcome": "succeeded", "executionId": "earlier"}', '2026-10-21 06:07:43.803'),
        ('run-riona', 8567, 'agent.tool.called',
          '{"name": "open_path", "argsPreview": "{\\"path\\":\\"/home/rakazo/tmp/jpg284/photo.png\\"}", "executionId": "open"}',
          '2026-10-21 06:07:48.804'),
        ('run-riona', 8569, 'agent.tool.completed',
          '{"name": "open_path", "outcome": "error", "error": "sandbox action failed: 500 {\\"error\\":\\"computer action failed\\"}", "executionId": "open"}',
          '2026-10-21 06:07:52.172'),
        ('run-jill', 17210, 'computer.command',
          '{"kind": "shell", "cwd": "/home/rakazo/repos/rakazo", "command": "git diff && git status --short", "status": "running", "executionId": "jill-shell"}',
          '2026-10-21 02:37:41.323'),
        ('run-jill', 17211, 'computer.command',
          '{"kind": "shell", "cwd": "/home/rakazo/repos/rakazo", "command": "git diff && git status --short", "status": "done", "exitCode": 1, "output": "This operation was aborted", "executionId": "jill-shell"}',
          '2026-10-21 02:37:41.357'),
        ('run-jill', 17212, 'agent.tool.completed',
          '{"name": "shell", "outcome": "error", "error": "This operation was aborted", "executionId": "jill-shell"}',
          '2026-10-21 02:37:41.374');
    `);
  }

  const byId = async (operatorId = "operator", coordination = noCoordinators) =>
    new Map(
      (
        await createMaintenanceRecoveryStore(pool, coordination).recoveryForOperator(operatorId)
      ).items.map((item) => [item.id, item]),
    );

  it("derives each Q35 record's state from its own evidence, never from the parent run alone", async () => {
    await seedQ35Records();
    await pool.query(`
      INSERT INTO "runs" ("id", "botId", "status", "leaseExpiresAt") VALUES
        ('live', 'jill', 'running', (now() AT TIME ZONE 'UTC') + interval '1 hour'),
        ('bare', 'jill', 'completed', NULL);
      INSERT INTO "external_effects" ("id", "runId", "kind", "status", "request", "createdAt", "updatedAt") VALUES
        ('no-evidence', 'bare', 'send_email', 'executing', '{"to": "a@example.test"}',
          '2026-10-21 05:00:00', '2026-10-21 05:00:00');
    `);
    const items = await byId();

    expect(items.get("attempt-1")).toMatchObject({
      kind: "attempt",
      state: "settleable",
      bot: "Isabella",
      startedAt: "2026-10-19T13:58:42.947Z",
      proposed: { status: "interrupted", basis: expect.stringContaining("attempt-2 (fence 2)") },
    });
    expect(items.get("open-path")).toMatchObject({
      state: "settleable",
      bot: "Riona",
      ownerVerifiable: false,
      proposed: { status: "failed", basis: expect.stringContaining("#8569") },
    });
    // The call started and was aborted: its outcome is unknown, so evidence only makes that explicit.
    expect(items.get("shell")).toMatchObject({
      state: "settleable",
      ownerVerifiable: true,
      proposed: { status: "uncertain" },
    });
    expect(items.get("no-evidence")).toMatchObject({
      state: "unresolved",
      proposed: null,
      ownerVerifiable: true,
      missing: expect.stringContaining("No recorded send_email call"),
    });
    expect(items.get("live")).toMatchObject({ kind: "run", state: "draining" });
    expect(items.has("attempt-2")).toBe(false);
    expect(items.has("attempt-jill")).toBe(false);
    // Repeated observations describe the same operations, one item each.
    expect([...(await byId()).keys()]).toEqual([...items.keys()]);
    await expect(byId("outsider")).rejects.toThrow("owner required");
  });

  it("lists no approval that ended invalidated: it is final, not unfinished work", async () => {
    await pool.query(`
      INSERT INTO "runs" ("id", "botId", "status") VALUES ('withdrawn', 'jill', 'cancelled');
      INSERT INTO "external_effects" ("id", "runId", "kind", "status", "request", "createdAt", "updatedAt") VALUES
        ('stale-approval', 'withdrawn', 'shell', 'invalidated', '{"command": "deploy"}',
          '2026-10-21 05:00:00', '2026-10-21 05:00:00');
    `);
    expect((await byId()).has("stale-approval")).toBe(false);
  });

  it("lets the owner continue or stop a run the Fleet holds for a binding problem, audited", async () => {
    await pool.query(`
      INSERT INTO "runs" ("id", "botId", "status", "error") VALUES
        ('bound', 'riona', 'maintenance_paused', 'maintenance:attention:fleet-authority-binding-invalid'),
        ('doomed', 'riona', 'queued', 'maintenance:attention:fleet-authority-binding-unavailable'),
        ('retried', 'jill', 'maintenance_paused', 'maintenance:attention:fleet-authority-verifier-unavailable');
    `);
    const items = await byId();
    expect(items.get("bound")).toMatchObject({
      kind: "run",
      state: "unresolved",
      ownerActions: ["continue", "stop"],
      userActionNeeded: true,
    });
    // Retried automatically: listed, nothing for the owner to do.
    expect(items.get("retried")).toMatchObject({ state: "draining", ownerActions: [] });

    const store = createMaintenanceRecoveryStore(pool, noCoordinators);
    const run = (
      id: string,
      basis: "owner-override" | "owner-stop",
      status = "maintenance_paused",
    ) => ({ requestId: `${basis}:${id}`, basis, kind: "run", id, expectedStatus: status }) as const;
    // Owner only.
    await expect(store.settleRecovery("outsider", run("bound", "owner-override"))).rejects.toThrow(
      "owner required",
    );
    // Not for a run the Fleet's check will retry by itself.
    expect(await store.settleRecovery("operator", run("retried", "owner-override"))).toMatchObject({
      outcome: "refused",
    });

    // While paused it is recorded and waits for Resume; the run is marked for one override.
    expect(await store.settleRecovery("operator", run("bound", "owner-override"))).toEqual({
      outcome: "settled",
      status: "maintenance_paused",
      reason: "Recorded. Fleet is paused: it continues when you resume Fleet.",
    });
    expect(
      (await pool.query(`SELECT "error", "status" FROM "runs" WHERE "id" = 'bound'`)).rows[0],
    ).toEqual({ error: "maintenance:attention:owner-override", status: "maintenance_paused" });
    // Repeating the request replays; it is no longer binding-held, so a new one is refused.
    expect(await store.settleRecovery("operator", run("bound", "owner-override"))).toMatchObject({
      outcome: "replayed",
    });

    expect(await store.settleRecovery("operator", run("doomed", "owner-stop", "queued"))).toEqual({
      outcome: "settled",
      status: "stopping",
    });
    expect(
      (
        await pool.query(
          `SELECT "maintenanceCancelRequestedAt" IS NOT NULL AS "requested" FROM "runs" WHERE "id" = 'doomed'`,
        )
      ).rows[0],
    ).toEqual({ requested: true });

    const audit = await pool.query(
      `SELECT "operatorId", "targetKind", "targetId", "basis", "toStatus", "evidence"
         FROM "maintenance_recovery" WHERE "targetKind" = 'run' ORDER BY "targetId"`,
    );
    expect(audit.rows).toEqual([
      {
        operatorId: "operator",
        targetKind: "run",
        targetId: "bound",
        basis: "owner-override",
        toStatus: "owner-override",
        evidence: { reason: "owner override", heldFor: "fleet-authority-binding-invalid" },
      },
      {
        operatorId: "operator",
        targetKind: "run",
        targetId: "doomed",
        basis: "owner-stop",
        toStatus: "stopping",
        evidence: { reason: "owner stop", heldFor: "fleet-authority-binding-unavailable" },
      },
    ]);
    // Being stopped, it leaves the held list; the overridden one waits for the next resume.
    const after = await byId();
    expect(after.has("doomed")).toBe(false);
    expect(after.get("bound")).toMatchObject({ state: "draining", ownerActions: [] });
  });

  it("names the Fleet coordinator for a Fleet service effect and how to settle it there", async () => {
    await pool.query(`
      INSERT INTO fleet.service_effects (id, kind, status, updated_at) VALUES
        ('fx-1', 'tracker.set_body', 'uncertain', now()),
        ('fx-2', 'tracker.comment', 'executing', now());
    `);
    const coordination: CaseCoordination = {
      caseCoordinators: ["Josy"],
      fleetCoordinator: "elena",
    };
    const items = await byId("operator", coordination);
    expect(items.get("fx-1")).toMatchObject({
      kind: "fleet-effect",
      state: "unresolved",
      caseRef: null,
      coordinator: "Elena",
      // Only the operator can run the settle command: it needs them, and says what to run.
      userActionNeeded: true,
      missing:
        "Settle it in the Fleet service: `python -m fleet settle fx-1 --result ok|failed --evidence <link>`.",
    });
    // Still executing and recent: it finishes on its own; nothing to settle yet.
    expect(items.get("fx-2")).toMatchObject({
      state: "draining",
      missing: null,
      coordinator: "Elena",
      userActionNeeded: false,
    });
  });

  it("takes a run's case from the Fleet wake that started it, and never guesses one", async () => {
    await pool.query(`
      INSERT INTO "runs" ("id", "botId", "status", "leaseExpiresAt") VALUES
        ('service-wake', 'riona', 'running', (now() AT TIME ZONE 'UTC') - interval '1 hour'),
        ('gate-wake', 'riona', 'running', (now() AT TIME ZONE 'UTC') - interval '1 hour'),
        ('job-only', 'jill', 'running', (now() AT TIME ZONE 'UTC') - interval '1 hour'),
        ('chat', 'jill', 'running', (now() AT TIME ZONE 'UTC') - interval '1 hour'),
        ('fleet-case', 'riona', 'running', (now() AT TIME ZONE 'UTC') - interval '1 hour'),
        ('other-case', 'elena', 'running', (now() AT TIME ZONE 'UTC') - interval '1 hour');
      INSERT INTO "events" ("runId", "seq", "type", "payload", "createdAt") VALUES
        ('service-wake', 1, 'thread.message.created',
          '{"inboundDelivery": {"source": "webhook", "payload": {"source": "fleet-service", "event": "tracker", "case": 412, "facts": {}}}}', now()),
        ('gate-wake', 1, 'thread.message.created',
          '{"inboundDelivery": {"source": "webhook", "payload": {"source": "fleet-gate", "event": "tracker", "job": "tracker", "items": [{"n": 501, "case": 400}, {"n": 502, "case": 400}]}}}', now()),
        ('job-only', 1, 'thread.message.created',
          '{"inboundDelivery": {"source": "webhook", "payload": {"source": "fleet-gate", "event": "tracker", "job": "tracker", "items": [{"n": 503, "title": "Fix SPF"}]}}}', now()),
        ('chat', 1, 'thread.message.created', '{"messageId": "m"}', now()),
        ('fleet-case', 1, 'thread.message.created',
          '{"inboundDelivery": {"source": "webhook", "payload": {"source": "fleet-gate", "event": "tracker", "job": "tracker", "fleet": true, "items": [{"n": 504, "case": 77}]}}}', now()),
        ('other-case', 1, 'thread.message.created',
          '{"inboundDelivery": {"source": "webhook", "payload": {"source": "fleet-gate", "event": "tracker", "job": "tracker", "fleet": false, "items": [{"n": 505}]}}}', now());
    `);
    const coordination: CaseCoordination = {
      caseCoordinators: ["Josy"],
      fleetCoordinator: "Elena",
    };
    const items = await byId("operator", coordination);
    expect(items.get("service-wake")).toMatchObject({ caseRef: 412, caseUnknown: false });
    expect(items.get("gate-wake")).toMatchObject({ caseRef: 400, caseUnknown: false });
    // A job number is not a case: the case is unknown and the Fleet coordinator answers, not Josy.
    expect(items.get("job-only")).toMatchObject({
      caseRef: null,
      caseUnknown: true,
      coordinator: "Elena",
    });
    // Not a Fleet wake: internal work, with no claim about a case.
    expect(items.get("chat")).toMatchObject({
      caseRef: null,
      caseUnknown: false,
      coordinator: "Elena",
    });
    // The wake says it is a fleet case: the Fleet coordinator answers, never Josy.
    expect(items.get("fleet-case")).toMatchObject({ caseRef: 77, coordinator: "Elena" });
    // Not a fleet case: the default case coordinator, even when the case number is unknown.
    expect(items.get("other-case")).toMatchObject({
      caseRef: null,
      caseUnknown: true,
      coordinator: "Josy",
    });
  });

  it("names the case, its coordinator and whether only the user can settle each item (Q21)", async () => {
    await seedQ35Records();
    await pool.query(`
      INSERT INTO "messages" ("id", "runId", "role", "seq", "blocks") VALUES
        ('m1', 'run-jill', 'bot', 1,
          '[{"kind": "ask", "text": "Case 383 · repo: which repository?", "status": "answered"}]'),
        ('m2', 'run-riona', 'bot', 1,
          '[{"kind": "ask", "text": "About case 99, not a card head", "status": "pending"}]'),
        ('m3', 'elena-live', 'bot', 1,
          '[{"kind": "ask", "text": "URGENT · Case 50 · fleet: restart?", "status": "pending"}]');
      INSERT INTO "user_todos" ("id", "runId", "caseRef") VALUES ('t1', 'run-isabella', 142);
      INSERT INTO "runs" ("id", "botId", "status", "leaseExpiresAt") VALUES
        ('live', 'jill', 'running', (now() AT TIME ZONE 'UTC') + interval '1 hour'),
        ('elena-live', 'elena', 'running', (now() AT TIME ZONE 'UTC') + interval '1 hour');
    `);
    const coordination: CaseCoordination = {
      caseCoordinators: ["josy", "Elena"],
      fleetCoordinator: "elena",
    };
    const items = await byId("operator", coordination);
    // Case from a card head; a worker's case goes to the default case coordinator, by bot name.
    expect(items.get("shell")).toMatchObject({
      caseRef: 383,
      coordinator: "Josy",
      userActionNeeded: true,
    });
    // Case from a linked to-do; recorded evidence still needs the owner to apply it.
    expect(items.get("attempt-1")).toMatchObject({
      caseRef: 142,
      coordinator: "Josy",
      userActionNeeded: true,
    });
    // A coordinator's own case stays hers; still finishing on its own, so nobody needs to act.
    expect(items.get("elena-live")).toMatchObject({
      caseRef: 50,
      coordinator: "Elena",
      userActionNeeded: false,
    });
    // Free text never names a case: internal, so the Fleet coordinator answers for it.
    expect(items.get("open-path")).toMatchObject({ caseRef: null, coordinator: "Elena" });
    expect(items.get("live")).toMatchObject({ caseRef: null, coordinator: "Elena" });
    // Without coordinators configured nobody is named, and nothing is guessed.
    expect((await byId()).get("shell")).toMatchObject({ caseRef: 383, coordinator: "Jill" });
    expect((await byId()).get("live")).toMatchObject({ coordinator: null });
  });

  it("settles from evidence once, records provenance, and replays the same request", async () => {
    await seedQ35Records();
    const store = createMaintenanceRecoveryStore(pool, noCoordinators);
    const attempt = {
      requestId: "settle-attempt",
      basis: "evidence",
      kind: "attempt",
      id: "attempt-1",
      expectedStatus: "running",
    } as const;
    expect(await store.settleRecovery("operator", attempt)).toEqual({
      outcome: "settled",
      status: "interrupted",
    });
    expect(await store.settleRecovery("operator", attempt)).toEqual({
      outcome: "replayed",
      status: "interrupted",
    });
    await expect(
      store.settleRecovery("operator", { ...attempt, id: "open-path", kind: "effect" }),
    ).rejects.toThrow("conflicts");
    await expect(
      store.settleRecovery("outsider", { ...attempt, requestId: "other" }),
    ).rejects.toThrow("owner required");

    const effect = {
      requestId: "settle-open",
      basis: "evidence",
      kind: "effect",
      id: "open-path",
      expectedStatus: "executing",
    } as const;
    expect(await store.settleRecovery("operator", effect)).toEqual({
      outcome: "settled",
      status: "failed",
    });

    const rows = await pool.query(`
      SELECT a."status" AS attempt, a."error", e."status" AS effect, e."result"
      FROM "attempts" a, "external_effects" e WHERE a."id" = 'attempt-1' AND e."id" = 'open-path'`);
    expect(rows.rows[0]).toMatchObject({
      attempt: "interrupted",
      error: expect.stringContaining("attempt-2"),
      effect: "failed",
      result: {
        error: expect.stringContaining("sandbox action failed"),
        reconciliation: {
          basis: "evidence",
          operatorId: "operator",
          from: "executing",
          to: "failed",
          requestId: "settle-open",
        },
      },
    });
    const audit = await pool.query(
      `SELECT "targetId", "basis", "fromStatus", "toStatus" FROM "maintenance_recovery" ORDER BY "targetId"`,
    );
    expect(audit.rows).toEqual([
      { targetId: "attempt-1", basis: "evidence", fromStatus: "running", toStatus: "interrupted" },
      { targetId: "open-path", basis: "evidence", fromStatus: "executing", toStatus: "failed" },
    ]);
    const remaining = await byId();
    expect(remaining.has("attempt-1")).toBe(false);
    expect(remaining.has("open-path")).toBe(false);
  });

  it("preserves a real outcome that lands first and lets only one competing settlement win", async () => {
    await seedQ35Records();
    const store = createMaintenanceRecoveryStore(pool, noCoordinators);
    await pool.query(
      `UPDATE "external_effects" SET "status" = 'completed', "result" = '{"ok": true}' WHERE "id" = 'open-path'`,
    );
    expect(
      await store.settleRecovery("operator", {
        requestId: "late",
        basis: "evidence",
        kind: "effect",
        id: "open-path",
        expectedStatus: "executing",
      }),
    ).toEqual({ outcome: "changed", status: "completed" });
    expect(
      (await pool.query(`SELECT "result" FROM "external_effects" WHERE "id" = 'open-path'`)).rows[0]
        .result,
    ).toEqual({ ok: true });

    const results = await Promise.all(
      ["a", "b"].map((requestId) =>
        store.settleRecovery("operator", {
          requestId,
          basis: "evidence",
          kind: "attempt",
          id: "attempt-1",
          expectedStatus: "running",
        }),
      ),
    );
    expect(results.map((result) => result.outcome).sort()).toEqual(["changed", "settled"]);
    expect(
      (await pool.query(`SELECT count(*)::int AS n FROM "maintenance_recovery"`)).rows[0].n,
    ).toBe(1);
  });

  it("refuses settlement without evidence and takes an owner check only where evidence cannot decide", async () => {
    await seedQ35Records();
    await pool.query(`
      INSERT INTO "runs" ("id", "botId", "status", "leaseFence") VALUES ('expired', 'jill', 'failed', 1);
      INSERT INTO "attempts" ("id", "runId", "fence", "status") VALUES ('lonely', 'expired', 1, 'running');
    `);
    const store = createMaintenanceRecoveryStore(pool, noCoordinators);
    expect((await byId()).get("lonely")).toMatchObject({ state: "unresolved", proposed: null });
    expect(
      await store.settleRecovery("operator", {
        requestId: "lonely",
        basis: "evidence",
        kind: "attempt",
        id: "lonely",
        expectedStatus: "running",
      }),
    ).toMatchObject({ outcome: "refused", status: "running" });

    const verify = {
      requestId: "verify-open",
      basis: "owner-verified",
      kind: "effect",
      id: "open-path",
      expectedStatus: "executing",
      outcome: "completed",
      note: "Checked the screen myself.",
    } as const;
    expect(await store.settleRecovery("operator", verify)).toMatchObject({
      outcome: "refused",
      status: "executing",
    });

    expect(
      await store.settleRecovery("operator", {
        requestId: "shell-evidence",
        basis: "evidence",
        kind: "effect",
        id: "shell",
        expectedStatus: "executing",
      }),
    ).toEqual({ outcome: "settled", status: "uncertain" });
    expect((await byId()).get("shell")).toMatchObject({
      status: "uncertain",
      state: "unresolved",
      ownerVerifiable: true,
    });
    expect(
      await store.settleRecovery("operator", {
        ...verify,
        requestId: "shell-verified",
        id: "shell",
        expectedStatus: "uncertain",
        outcome: "failed",
        note: "Read-only git commands; the computer restarted since.",
      }),
    ).toEqual({ outcome: "settled", status: "failed" });
    const shell = (
      await pool.query(`SELECT "status", "result" FROM "external_effects" WHERE "id" = 'shell'`)
    ).rows[0];
    expect(shell).toMatchObject({
      status: "failed",
      result: {
        error:
          "Owner verified it did not take effect: Read-only git commands; the computer restarted since.",
        reconciliation: { basis: "owner-verified", from: "uncertain", to: "failed" },
      },
    });
    expect((await byId()).has("shell")).toBe(false);
  });
});
