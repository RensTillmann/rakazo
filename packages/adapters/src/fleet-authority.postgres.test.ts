import { randomUUID } from "node:crypto";
import type { SecretStore } from "@rakazo/adapter-kit";
import type { PrismaClient, Run } from "@rakazo/db";
import { createDb, maintenanceAttentionReason } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./executor.js";
import {
  createExecutorMaintenance,
  FLEET_AUTHORITY_RETRY_INTERVAL_MS,
} from "./executor-maintenance.js";
import { FleetAuthorityStub } from "./fleet-authority-stub.js";
import { McpConnector } from "./mcp-connector.js";

// Fully migrated disposable local database only (VERIFY_DATABASE + DATABASE_URL).
const enabled = process.env.VERIFY_DATABASE && process.env.DATABASE_URL;
const describePostgres = enabled ? describe.sequential : describe.skip;

const FLEET_ENDPOINT = "http://fleet-service:8790/mcp";
const TOKEN = "fleet-service-token";

describePostgres("Fleet authority on resume, through the MCP connector (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  const stub = new FleetAuthorityStub(TOKEN);
  const users: string[] = [];

  beforeAll(async () => {
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(new URL(process.env.DATABASE_URL!).hostname)
    ) {
      throw new Error("Fleet authority tests require a disposable local database");
    }
    const db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    close = () => db.pool.end();
    await stub.start();
  });
  afterAll(async () => {
    await stub.stop();
    if (!prisma) return;
    try {
      await prisma.organization.deleteMany({ where: { id: { in: users } } });
      await prisma.user.deleteMany({ where: { id: { in: users } } });
    } finally {
      await prisma.$disconnect();
      await close();
    }
  });

  /** A Fleet-spawned bot assigned the Fleet service, with one queued run held across a pause. */
  async function fleetBotRun() {
    const id = randomUUID();
    users.push(id);
    const now = new Date();
    await prisma.user.create({ data: { id, name: "Rens", email: `${id}@example.test` } });
    await prisma.organization.create({ data: { id, name: "Fleet", slug: id, createdAt: now } });
    await prisma.member.create({
      data: { id, organizationId: id, userId: id, role: "owner", createdAt: now },
    });
    await prisma.space.create({ data: { id, organizationId: id, name: "Fleet" } });
    await prisma.spaceMember.create({
      data: { id, spaceId: id, organizationId: id, userId: id, role: "owner", createdAt: now },
    });
    const bot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Riona", color: "test", spawnKey: "fleet:riona" },
    });
    const thread = await prisma.thread.create({ data: { spaceId: id, userId: id, botId: bot.id } });
    const secret = await prisma.secret.create({
      data: { userId: id, spaceId: id, kind: "mcp", ciphertext: `ref:${id}` },
    });
    const server = await prisma.mcpServer.create({
      data: {
        spaceId: id,
        userId: id,
        slug: "fleet",
        name: "Fleet",
        transport: "streamable_http",
        endpoint: FLEET_ENDPOINT,
        secretId: secret.id,
      },
    });
    await prisma.botMcpServer.create({
      data: { spaceId: id, userId: id, botId: bot.id, serverId: server.id },
    });
    const task = await prisma.task.create({
      data: {
        spaceId: id,
        userId: id,
        botId: bot.id,
        threadId: thread.id,
        prompt: "work",
        status: "queued",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        status: "queued",
        trigger: "user",
      },
    });
    return run.id;
  }

  /** The executor's maintenance seam over the real MCP connector, reaching the stub. */
  function maintenance(timeoutMs: number) {
    const secrets = {
      load: async () => JSON.stringify({ secret: TOKEN }),
      onChange: () => () => {},
    } as unknown as SecretStore;
    const connector = new McpConnector(prisma, secrets, {
      allowPrivateEndpoint: true,
      network: {
        // `fleet-service` is the stub on this host.
        resolveHostname: async () => [{ address: "10.0.0.8", family: 4 }],
        fetch: (input, init) =>
          fetch(String(input).replace("http://fleet-service:8790/mcp", stub.url), init),
      },
    });
    return createExecutorMaintenance({ prisma, connector } as unknown as ExecutorDeps, timeoutMs);
  }

  /** What `continueRun` does for a queued run after a pause: the Fleet check, then the lease check. */
  async function revalidate(seam: ReturnType<typeof maintenance>, runId: string) {
    const run: Run = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
    if (!seam.mayValidate(run)) return "skipped" as const;
    const checked = await seam.externalAuthority(run);
    const admitted = await prisma.$transaction((tx) =>
      seam.validateLease(tx, run, undefined, checked),
    );
    const after = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
    return { admitted, reason: maintenanceAttentionReason(after.error) ?? null };
  }

  it("admits the run when the Fleet allows it, with the bearer and the call's invocation id", async () => {
    const runId = await fleetBotRun();
    stub.answer = { allowed: true };
    stub.calls.length = 0;
    expect(await revalidate(maintenance(5_000), runId)).toEqual({ admitted: true, reason: null });
    expect(stub.calls).toEqual([{ runId, invocationId: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
    expect(stub.refused).toBe(0);
  });

  it("holds a run the Fleet did not answer in time and checks it again five minutes later", async () => {
    const runId = await fleetBotRun();
    const seam = maintenance(300);
    stub.answer = { allowed: true, delayMs: 2_000 };
    expect(await revalidate(seam, runId)).toEqual({
      admitted: false,
      reason: "fleet-authority-verifier-unavailable",
    });
    // The next wake within five minutes does not call the Fleet again.
    expect(await revalidate(seam, runId)).toBe("skipped");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + FLEET_AUTHORITY_RETRY_INTERVAL_MS + 1_000);
      stub.answer = { allowed: true };
      expect(await revalidate(seam, runId)).toEqual({
        admitted: true,
        reason: "fleet-authority-verifier-unavailable",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a run the Fleet denies in attention with the Fleet's reason, never retried for a bad binding", async () => {
    const runId = await fleetBotRun();
    const seam = maintenance(5_000);
    stub.answer = { allowed: false, reason: "fleet-authority-binding-invalid" };
    expect(await revalidate(seam, runId)).toEqual({
      admitted: false,
      reason: "fleet-authority-binding-invalid",
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 2 * FLEET_AUTHORITY_RETRY_INTERVAL_MS);
      expect(await revalidate(seam, runId)).toBe("skipped");
    } finally {
      vi.useRealTimers();
    }
  });
});
