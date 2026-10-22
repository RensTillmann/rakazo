import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import {
  createDb,
  createMaintenanceRecoveryStore,
  HELD_EFFECT_STALE_MS,
  markStaleHeldEffectsUncertain,
} from "@rakazo/db";
import { noCoordinators } from "@rakazo/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveDuplicateEffectGate } from "./approval-effect.js";

// Fully migrated disposable local database only (VERIFY_DATABASE + DATABASE_URL).
const enabled = process.env.VERIFY_DATABASE && process.env.DATABASE_URL;
const describePostgres = enabled ? describe.sequential : describe.skip;

describePostgres("an action a held run cannot settle (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let pool: ReturnType<typeof createDb>["pool"];
  const users: string[] = [];

  beforeAll(() => {
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(new URL(process.env.DATABASE_URL!).hostname)
    ) {
      throw new Error("Held-effect tests require a disposable local database");
    }
    const db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    pool = db.pool;
  });
  afterAll(async () => {
    if (!prisma) return;
    try {
      await prisma.organization.deleteMany({ where: { id: { in: users } } });
      await prisma.user.deleteMany({ where: { id: { in: users } } });
    } finally {
      await prisma.$disconnect();
      await pool.end();
    }
  });

  /** A run in `status` with a shell action marked executing `minutesAgo` minutes ago. */
  async function runWithAction(status: string, minutesAgo: number, recentEvent = false) {
    const id = randomUUID();
    users.push(id);
    await prisma.user.create({ data: { id, name: "Rens", email: `${id}@example.test` } });
    await prisma.organization.create({ data: { id, name: "F", slug: id, createdAt: new Date() } });
    await prisma.space.create({ data: { id, organizationId: id, name: "F" } });
    await prisma.deploymentSettings.upsert({
      where: { id: "default" },
      create: { id: "default", ownerUserId: id },
      update: { ownerUserId: id },
    });
    const bot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Josy", color: "test" },
    });
    const thread = await prisma.thread.create({ data: { spaceId: id, userId: id, botId: bot.id } });
    const task = await prisma.task.create({
      data: {
        spaceId: id,
        userId: id,
        botId: bot.id,
        threadId: thread.id,
        prompt: "w",
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
        status,
        trigger: "user",
        error: "maintenance:attention:unsettled-effects",
      },
    });
    const effect = await prisma.externalEffect.create({
      data: {
        spaceId: id,
        runId: run.id,
        kind: "shell",
        idempotencyKey: `tool:${run.id}:shell:call-1`,
        status: "executing",
        request: { command: "tracker draft 311" },
      },
    });
    const at = new Date(Date.now() - minutesAgo * 60_000);
    await prisma.$executeRaw`UPDATE external_effects SET "updatedAt" = ${at} WHERE id = ${effect.id}`;
    if (recentEvent) {
      await prisma.event.create({
        data: {
          spaceId: id,
          threadId: thread.id,
          botId: bot.id,
          seq: 1,
          type: "computer.command",
          payload: {},
          runId: run.id,
        },
      });
    }
    return { userId: id, runId: run.id, effectId: effect.id };
  }

  const status = async (effectId: string) =>
    (await prisma.externalEffect.findUniqueOrThrow({ where: { id: effectId } })).status;

  it("doubts only a stalled action of a run that is not running, then lets the owner have it redone once", async () => {
    const stalled = await runWithAction("queued", 15);
    const fresh = await runWithAction("queued", 2);
    const alive = await runWithAction("maintenance_paused", 15, true);
    const running = await runWithAction("running", 15);
    expect(HELD_EFFECT_STALE_MS).toBe(10 * 60_000);

    const changed = await markStaleHeldEffectsUncertain(prisma);
    expect(changed).toContain(stalled.effectId);
    expect(changed).not.toContain(fresh.effectId);
    expect(await status(stalled.effectId)).toBe("uncertain");
    for (const other of [fresh, alive, running])
      expect(await status(other.effectId)).toBe("executing");

    // The owner checked: it did not take effect. It goes back to intended for the run's resume.
    await prisma.deploymentSettings.update({
      where: { id: "default" },
      data: { ownerUserId: stalled.userId },
    });
    const store = createMaintenanceRecoveryStore(pool, noCoordinators);
    expect(
      await store.settleRecovery(stalled.userId, {
        requestId: `checked:${stalled.effectId}`,
        basis: "owner-verified",
        kind: "effect",
        id: stalled.effectId,
        expectedStatus: "uncertain",
        outcome: "failed",
        note: "No draft 311 comment on the tracker",
      }),
    ).toEqual({ outcome: "settled", status: "intended" });
    const effect = await prisma.externalEffect.findUniqueOrThrow({
      where: { id: stalled.effectId },
    });
    // The resumed call finds its own action by execution id and claims it to run once
    // (an action needing approval asks again first); it is no longer an unsettled hold.
    expect(resolveDuplicateEffectGate(effect, "shell")).toEqual({ action: "paused" });
    expect(await markStaleHeldEffectsUncertain(prisma)).not.toContain(stalled.effectId);
  });
});
