import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "./client.js";
import {
  createMaintenanceStore,
  lockMaintenanceAdmission,
  claimMaintenanceEffect,
  checkpointMaintenanceRun,
  resumeMaintenanceRun,
  maintenanceAttention,
} from "./maintenance.js";

// Opt in only with a dedicated disposable LOCAL test database. Never use the
// application's DATABASE_URL or shared deployment settings for these tests.
const databaseUrl = process.env.MAINTENANCE_TEST_DATABASE_URL;
const suite = databaseUrl ? describe.sequential : describe.skip;

suite("maintenance state PostgreSQL persistence and contention", () => {
  const schema = `maintenance_test_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool;
  let pool: Pool;
  let schemaCreated = false;
  let fleetTableCreated = false;
  let fleetSchemaCreated = false;
  let prisma: PrismaClient;

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      throw new Error("Maintenance tests require a disposable local database");
    }
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    const fleet = await admin.query("SELECT to_regclass('fleet.service_effects') AS ledger, to_regnamespace('fleet') AS namespace");
    if (fleet.rows[0].ledger) throw new Error("Disposable maintenance database must not contain a Fleet effect ledger");
    if (!fleet.rows[0].namespace) {
      await admin.query("CREATE SCHEMA fleet");
      fleetSchemaCreated = true;
    }
    await admin.query(`CREATE TABLE fleet.service_effects (
      id text PRIMARY KEY, kind text NOT NULL, status text NOT NULL, result jsonb,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    fleetTableCreated = true;
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema}`,
      max: 4,
    });
    await pool.query(
      'CREATE TABLE "deployment_settings" ("id" TEXT PRIMARY KEY, "ownerUserId" TEXT)',
    );
    await pool.query('INSERT INTO "deployment_settings" VALUES ($1, $2)', ["default", "operator"]);
    await pool.query(`
      CREATE TABLE "runs" (
        "id" TEXT PRIMARY KEY, "status" TEXT NOT NULL,
        "leaseOwner" TEXT, "leaseFence" INTEGER NOT NULL DEFAULT 1,
        "leaseExpiresAt" TIMESTAMP(3), "checkpoint" TEXT, "error" TEXT,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE "attempts" (
        "id" TEXT PRIMARY KEY, "runId" TEXT NOT NULL, "fence" INTEGER NOT NULL,
        "status" TEXT NOT NULL, "finishedAt" TIMESTAMP(3)
      );
      CREATE TABLE "external_effects" (
        "id" TEXT PRIMARY KEY, "runId" TEXT NOT NULL, "status" TEXT NOT NULL,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE "cloud_agents" (
        "id" TEXT PRIMARY KEY, "status" TEXT NOT NULL,
        "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
        "version" INTEGER NOT NULL DEFAULT 0, "nextPollAt" TIMESTAMP(3),
        "launchDispatched" BOOLEAN NOT NULL DEFAULT false, "remoteId" TEXT,
        "followup" JSONB, "followupDispatching" BOOLEAN NOT NULL DEFAULT false
      );
      CREATE TABLE "messaging_outbound" ("id" TEXT PRIMARY KEY, "status" TEXT NOT NULL);
      CREATE TABLE "routines" ("id" TEXT PRIMARY KEY, "active" BOOLEAN NOT NULL, "watchState" JSONB);
      CREATE TABLE "external_messages" ("id" TEXT PRIMARY KEY, "status" TEXT NOT NULL, "lastError" TEXT);
      CREATE TABLE "computers" ("id" TEXT PRIMARY KEY, "state" TEXT NOT NULL);
    `);
    const migration = await readFile(
      new URL(
        "../prisma/migrations/20261020220000_maintenance_control/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await pool.query(migration);
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) });
  });

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE "maintenance_audit", "runs", "attempts", "external_effects",
        "cloud_agents", "messaging_outbound", "routines", "external_messages", "computers",
        fleet.service_effects;
      UPDATE "maintenance_state" SET "active" = false, "revision" = 0;
    `);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    if (fleetTableCreated) await admin.query("DROP TABLE fleet.service_effects");
    if (fleetSchemaCreated) await admin.query("DROP SCHEMA fleet");
    await admin?.end();
  });

  it("serializes competing enters, persists across clients, resumes once and deduplicates retries", async () => {
    const command = { action: "enter" as const, expectedRevision: 0, requestId: "enter" };
    const results = await Promise.allSettled([
      createMaintenanceStore(pool).change("operator", command),
      createMaintenanceStore(pool).change("operator", { ...command, requestId: "competing" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const restarted = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema}`,
    });
    try {
      const store = createMaintenanceStore(restarted);
      expect(await store.status()).toEqual({ active: true, revision: 1 });
      const resume = { action: "resume" as const, expectedRevision: 1, requestId: "resume" };
      const resumed = await Promise.all([
        store.change("operator", resume),
        store.change("operator", resume),
      ]);
      expect(resumed.map((r) => r.replayed).sort()).toEqual([false, true]);
      expect(await store.status()).toEqual({ active: false, revision: 2 });
      const audit = await pool.query('SELECT * FROM "maintenance_audit" ORDER BY "revision"');
      expect(audit.rows).toHaveLength(2);
      const replay = await store.change("operator", {
        ...command,
        requestId: audit.rows[0].requestId,
      });
      expect(replay).toEqual({ state: { active: false, revision: 2 }, replayed: true });
      await expect(store.change("outsider", resume)).rejects.toThrow("owner required");
      expect((await pool.query('SELECT * FROM "maintenance_audit"')).rows).toHaveLength(2);
    } finally {
      await restarted.end();
    }
  });

  it("reports busy, pending and uncertain work without equating active pause with quiescence", async () => {
    const store = createMaintenanceStore(pool);
    await pool.query(`
      INSERT INTO "runs" ("id", "status", "leaseOwner", "leaseExpiresAt")
      VALUES ('busy', 'running', 'worker', CURRENT_TIMESTAMP + interval '1 hour'),
             ('queued', 'queued', NULL, NULL), ('paused', 'maintenance_paused', NULL, NULL);
      INSERT INTO "attempts" VALUES ('attempt', 'paused', 1, 'running', NULL);
      INSERT INTO "external_effects" ("id", "runId", "status")
      VALUES ('send', 'busy', 'executing');
    `);
    await store.change("operator", { requestId: "hold", action: "enter", expectedRevision: 0 });
    expect((await store.statusForOperator("operator")).status).toEqual({
      phase: "pausing", activeRuns: 2, activeEffects: 1, pendingRuns: 2, issues: [],
    });
    await pool.query(`UPDATE "external_effects" SET "status" = 'uncertain'`);
    expect((await store.statusForOperator("operator")).status).toMatchObject({
      phase: "needs_attention", activeEffects: 1, issues: ["uncertain-effects"],
    });
  });

  it("counts in-flight and uncertain deliveries but never reinterprets confirmed sent history", async () => {
    const store = createMaintenanceStore(pool);
    await pool.query(`
      INSERT INTO "messaging_outbound" VALUES
        ('in-flight', 'executing'), ('history', 'sent'), ('held', 'pending');
    `);
    await store.change("operator", { requestId: "enter", action: "enter", expectedRevision: 0 });
    expect((await store.statusForOperator("operator")).status).toEqual({
      phase: "pausing", activeRuns: 0, activeEffects: 1, pendingRuns: 0, issues: [],
    });
    await pool.query(`UPDATE "messaging_outbound" SET "status" = 'uncertain' WHERE "id" = 'in-flight'`);
    expect((await store.statusForOperator("operator")).status).toEqual({
      phase: "needs_attention", activeRuns: 0, activeEffects: 1, pendingRuns: 0,
      issues: ["uncertain-deliveries"],
    });
  });

  it("serializes a provider-effect claim with enter and never revives a denied effect", async () => {
    const store = createMaintenanceStore(pool);
    await pool.query(`
      INSERT INTO "external_effects" ("id", "runId", "status")
      VALUES ('allowed', 'run', 'approved'), ('denied', 'run', 'denied');
    `);
    let release!: () => void;
    let acquired!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { acquired = resolve; });
    const claim = prisma.$transaction(async (tx) => {
      expect(await claimMaintenanceEffect(tx, "allowed", "approved")).toBe(true);
      acquired();
      await gate;
    });
    await started;
    const enter = store.change("operator", {
      requestId: "race-enter", action: "enter", expectedRevision: 0,
    });
    release();
    await Promise.all([claim, enter]);
    expect((await store.statusForOperator("operator")).status).toMatchObject({
      phase: "pausing", activeEffects: 1,
    });
    expect(await prisma.$transaction((tx) => claimMaintenanceEffect(tx, "allowed", "approved"))).toBe(false);
    await store.change("operator", { requestId: "resume", action: "resume", expectedRevision: 1 });
    expect(await prisma.$transaction((tx) => claimMaintenanceEffect(tx, "denied", "approved"))).toBe(false);
    expect(await prisma.$transaction((tx) => lockMaintenanceAdmission(tx, ["usage"]))).toEqual({
      admitted: false, reason: "independent-hold", revision: 2,
    });
  });

  it("persists exact fenced continuations and revalidates before a single resume claim", async () => {
    const store = createMaintenanceStore(pool);
    const checkpoint = JSON.stringify({ messages: ["progress"], artifactIds: ["artifact"], cursor: 7 });
    await pool.query(`
      INSERT INTO "runs" ("id", "status", "leaseOwner", "leaseExpiresAt", "checkpoint")
      VALUES ('run', 'running', 'worker', CURRENT_TIMESTAMP + interval '1 hour', 'approval-checkpoint');
      INSERT INTO "attempts" VALUES ('attempt', 'run', 1, 'running', NULL);
      INSERT INTO "routines" ("id", "active") VALUES ('usage-held', false), ('enabled', true);
    `);
    await store.change("operator", { requestId: "enter", action: "enter", expectedRevision: 0 });
    expect(await prisma.$transaction((tx) => checkpointMaintenanceRun(tx, {
      runId: "run", leaseOwner: "stale-worker", leaseFence: 1, checkpoint,
    }))).toBe(false);
    expect(await prisma.$transaction((tx) => checkpointMaintenanceRun(tx, {
      runId: "run", leaseOwner: "worker", leaseFence: 1, checkpoint,
    }))).toBe(true);
    expect((await store.statusForOperator("operator")).status).toEqual({
      phase: "paused", activeRuns: 0, activeEffects: 0, pendingRuns: 1, issues: [],
    });
    expect(await prisma.$transaction((tx) => resumeMaintenanceRun(tx, "run", async () => true))).toBe(false);
    await store.change("operator", { requestId: "resume", action: "resume", expectedRevision: 1 });
    expect(await prisma.$transaction((tx) => resumeMaintenanceRun(tx, "run", async () => false))).toBe(false);
    const results = await Promise.all([1, 2].map(() => prisma.$transaction((tx) =>
      resumeMaintenanceRun(tx, "run", async (_tx, continuation) => {
        expect(continuation).toEqual({ runId: "run", checkpoint, leaseFence: 1 });
        return true;
      }),
    )));
    expect(results.sort()).toEqual([false, true]);
    expect((await pool.query(`SELECT "checkpoint", "maintenanceCheckpoint" FROM "runs"`)).rows)
      .toEqual([{ checkpoint: "approval-checkpoint", maintenanceCheckpoint: checkpoint }]);
    expect((await pool.query(`SELECT "id", "active" FROM "routines" ORDER BY "id"`)).rows).toEqual([
      { id: "enabled", active: true }, { id: "usage-held", active: false },
    ]);
  });

  it("persists force-stop intent through restart and resume until actual teardown settles", async () => {
    const store = createMaintenanceStore(pool);
    await pool.query(`
      INSERT INTO "runs" ("id", "status", "leaseOwner", "leaseExpiresAt")
      VALUES ('run', 'running', 'worker', CURRENT_TIMESTAMP + interval '1 hour');
      INSERT INTO "attempts" VALUES ('attempt', 'run', 1, 'running', NULL);
      INSERT INTO "external_effects" ("id", "runId", "status") VALUES ('send', 'run', 'uncertain');
      INSERT INTO "cloud_agents" ("id", "status") VALUES ('remote', 'running');
    `);
    const stop = { requestId: "stop", action: "force-stop" as const, expectedRevision: 0 };
    await store.change("operator", stop);
    expect(await store.cancellationTargets()).toEqual([{ id: "run", leaseFence: 1 }]);
    expect(await store.acknowledgeCancellation("run", 1)).toBe(false);
    expect((await pool.query(`SELECT "status" FROM "runs"`)).rows).toEqual([{ status: "running" }]);
    expect((await pool.query(`SELECT "cancelRequested" FROM "cloud_agents"`)).rows)
      .toEqual([{ cancelRequested: true }]);
    await store.change("operator", { requestId: "resume", action: "resume", expectedRevision: 1 });
    const restarted = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    try {
      const recovered = createMaintenanceStore(restarted);
      expect(await recovered.change("operator", stop)).toEqual({
        state: { active: false, revision: 2 }, replayed: true,
      });
      expect(await recovered.cancellationTargets()).toEqual([{ id: "run", leaseFence: 1 }]);
      await pool.query(`
        UPDATE "runs" SET "status" = 'cancelled';
        UPDATE "attempts" SET "status" = 'cancelled', "finishedAt" = CURRENT_TIMESTAMP;
      `);
      expect(await recovered.acknowledgeCancellation("run", 1)).toBe(false);
      await pool.query(`UPDATE "external_effects" SET "status" = 'completed'`);
      expect(await recovered.acknowledgeCancellation("run", 2)).toBe(false);
      expect(await recovered.acknowledgeCancellation("run", 1)).toBe(true);
      expect(await recovered.cancellationTargets()).toEqual([]);
    } finally {
      await restarted.end();
    }
  });

  it("bridges an admitted Fleet effect and owner Enter with the shared advisory lock", async () => {
    const claim = await pool.connect();
    let ownerLockRequested!: () => void;
    const ownerStarted = new Promise<void>((resolve) => { ownerLockRequested = resolve; });
    const observedPool = {
      query: pool.query.bind(pool),
      connect: async () => {
        const client = await pool.connect();
        return {
          release: () => client.release(),
          query: (sql: string, values?: unknown[]) => {
            const pending = client.query(sql, values);
            if (sql.includes("pg_advisory_xact_lock(")) ownerLockRequested();
            return pending;
          },
        };
      },
    } as unknown as Pool;
    try {
      await claim.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await claim.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('rakazo.maintenance', 0))");
      await claim.query(`INSERT INTO fleet.service_effects(id,kind,status)
        SELECT 'accepted','tracker.write','executing' FROM maintenance_state WHERE NOT active`);
      const entering = createMaintenanceStore(observedPool).change("operator", {
        action: "enter", expectedRevision: 0, requestId: "fleet-enter",
      });
      await ownerStarted;
      expect((await pool.query("SELECT active FROM maintenance_state")).rows[0].active).toBe(false);
      await claim.query("COMMIT");
      await entering;
      expect((await createMaintenanceStore(pool).statusForOperator("operator")).status)
        .toMatchObject({ phase: "pausing", activeEffects: 1 });
    } finally {
      await claim.query("ROLLBACK");
      claim.release();
    }
  });

  it("a Fleet claimant waiting behind Enter reads the committed hold in a fresh statement", async () => {
    const owner = await pool.connect();
    const claim = await pool.connect();
    try {
      await owner.query("BEGIN");
      await owner.query("SELECT pg_advisory_xact_lock(hashtextextended('rakazo.maintenance', 0))");
      await owner.query("UPDATE maintenance_state SET active=true, revision=1");
      await claim.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      const admitted = claim.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('rakazo.maintenance', 0))");
      await owner.query("COMMIT");
      await admitted;
      const inserted = await claim.query(`INSERT INTO fleet.service_effects(id,kind,status)
        SELECT 'denied','tracker.write','executing' FROM maintenance_state WHERE NOT active RETURNING id`);
      expect(inserted.rows).toEqual([]);
      await claim.query("COMMIT");
    } finally {
      await owner.query("ROLLBACK");
      await claim.query("ROLLBACK");
      owner.release();
      claim.release();
    }
  });

  it("reads native and optional Fleet activity in one repeatable snapshot", async () => {
    const store = createMaintenanceStore(pool);
    await store.change("operator", { action: "enter", expectedRevision: 0, requestId: "enter" });
    const observedPool = {
      query: pool.query.bind(pool),
      connect: async () => {
        const client = await pool.connect();
        return {
          release: () => client.release(),
          query: async (sql: string, values?: unknown[]) => {
            const result = await client.query(sql, values);
            if (sql.includes('LEFT JOIN "maintenance_state"')) {
              await store.change("operator", { action: "resume", expectedRevision: 1, requestId: "resume" });
              await pool.query("INSERT INTO fleet.service_effects(id,kind,status) VALUES('later','send','executing')");
            }
            return result;
          },
        };
      },
    } as unknown as Pool;
    expect(await createMaintenanceStore(observedPool).statusForOperator("operator")).toEqual({
      state: { active: true, revision: 1 },
      status: { phase: "paused", activeRuns: 0, activeEffects: 0, pendingRuns: 0, issues: [] },
    });
    expect((await store.statusForOperator("operator")).status.activeEffects).toBe(1);
  });

  it("retains prolonged Fleet execution and uncertain watch evidence as Needs attention", async () => {
    await pool.query(`INSERT INTO fleet.service_effects(id,kind,status,updated_at) VALUES
      ('long','tracker.write','executing',now()-interval '11 minutes'),
      ('unknown','send','uncertain',now()), ('receipt','send','completed',now());
      INSERT INTO routines(id,active,"watchState") VALUES
      ('independently-held',false,'{"maintenanceCheck":{"id":"check","status":"uncertain"}}');
    `);
    const store = createMaintenanceStore(pool);
    await store.change("operator", { action: "enter", expectedRevision: 0, requestId: "enter" });
    expect((await store.statusForOperator("operator")).status).toMatchObject({
      phase: "needs_attention", activeEffects: 3,
      issues: expect.arrayContaining(["uncertain-fleet-effects", "unsettled-fleet-effects", "uncertain-routine-checks"]),
    });
    expect((await pool.query("SELECT status FROM fleet.service_effects WHERE id='long'")).rows)
      .toEqual([{ status: "executing" }]);
  });

  it("force-stop durably requests ambient/watch cancellation without rewriting their evidence", async () => {
    await pool.query(`INSERT INTO routines(id,active,"watchState") VALUES
      ('watch',false,'{"maintenanceCheck":{"id":"exact-check","status":"executing"}}');
      INSERT INTO external_messages(id,status) VALUES('judge','judging'),('delivery','delivering');`);
    await createMaintenanceStore(pool).change("operator", {
      action: "force-stop", expectedRevision: 0, requestId: "stop",
    });
    expect((await pool.query('SELECT active,"watchState" FROM routines')).rows).toEqual([
      { active: false, watchState: { maintenanceCheck: { id: "exact-check", status: "executing", cancelRequested: true } } },
    ]);
    expect((await pool.query('SELECT id,status,"lastError" FROM external_messages ORDER BY id')).rows).toEqual([
      { id: "delivery", status: "delivering", lastError: null },
      { id: "judge", status: "judging", lastError: "maintenance-force-stop" },
    ]);
  });
  it("pages past unresolved expired attempts without acknowledging them, including after restart", async () => {
    await pool.query(`INSERT INTO runs(id,status,"leaseExpiresAt")
      SELECT 'blocked-' || lpad(n::text, 3, '0'), 'cancelled', now() - interval '1 hour'
      FROM generate_series(1,100) n;
      INSERT INTO attempts(id,"runId",fence,status)
      SELECT id || '-attempt', id, 1, 'running' FROM runs;
      INSERT INTO runs(id,status,"maintenanceCancelRequestedAt") VALUES ('later','cancelled',now());`);
    const store = createMaintenanceStore(pool);
    await store.change("operator", { action: "force-stop", expectedRevision: 0, requestId: "stop-pages" });
    const first = await store.cancellationTargets(100);
    expect(first).toHaveLength(100);
    expect(await store.acknowledgeCancellation(first[0]!.id, 1)).toBe(false);
    const restarted = createMaintenanceStore(pool);
    const next = await restarted.cancellationTargets(100, first.at(-1)!.id);
    expect(next).toEqual([{ id: "later", leaseFence: 1 }]);
    expect(await restarted.acknowledgeCancellation("later", 1)).toBe(true);
    expect((await restarted.statusForOperator("operator")).status).toMatchObject({
      activeRuns: 100, phase: "needs_attention", issues: expect.arrayContaining(["cancellation-pending"]),
    });
    expect(await restarted.cancellationTargets(100)).toEqual(first);
  });

  it("reports machine-encoded continuation holds independently of display wording", async () => {
    await pool.query('INSERT INTO runs(id,status,error) VALUES ($1,$2,$3)',
      ["held", "queued", maintenanceAttention("dependencies-changed")]);
    const store = createMaintenanceStore(pool);
    expect((await store.statusForOperator("operator")).status).toMatchObject({
      phase: "needs_attention", pendingRuns: 1,
      issues: expect.arrayContaining(["continuation-needs-attention"]),
    });
    await pool.query("UPDATE runs SET error = 'Needs attention: ordinary application message'");
    expect((await store.statusForOperator("operator")).status.phase).toBe("running");
  });
});
