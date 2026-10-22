import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { pausedStepsByThread } from "./maintenance.js";

// Fully migrated disposable local database only (VERIFY_DATABASE + DATABASE_URL).
const enabled = process.env.VERIFY_DATABASE && process.env.DATABASE_URL;
const describePostgres = enabled ? describe.sequential : describe.skip;

describePostgres("progress a paused run kept (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  const users: string[] = [];

  beforeAll(() => {
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(new URL(process.env.DATABASE_URL!).hostname)
    ) {
      throw new Error("Paused-steps tests require a disposable local database");
    }
    const db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    close = () => db.pool.end();
  });
  afterAll(async () => {
    if (!prisma) return;
    try {
      await prisma.organization.deleteMany({ where: { id: { in: users } } });
      await prisma.user.deleteMany({ where: { id: { in: users } } });
    } finally {
      await prisma.$disconnect();
      await close();
    }
  });

  /** A bot's chat with one run in `status`, `checkpoint` stored, and `tools` completed calls. */
  async function chat(status: string, checkpoint: string | null, tools: number) {
    const id = randomUUID();
    users.push(id);
    await prisma.user.create({ data: { id, name: "Steps", email: `${id}@example.test` } });
    await prisma.organization.create({ data: { id, name: "S", slug: id, createdAt: new Date() } });
    await prisma.space.create({ data: { id, organizationId: id, name: "S" } });
    const bot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Bo", color: "test" },
    });
    const thread = await prisma.thread.create({ data: { spaceId: id, userId: id, botId: bot.id } });
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
        status,
        trigger: "user",
        maintenanceCheckpoint: checkpoint,
      },
    });
    const types = [
      ...Array.from({ length: tools }, () => "agent.tool.completed"),
      "agent.tool.called",
      "agent.text.delta",
    ];
    for (const [seq, type] of types.entries()) {
      await prisma.event.create({
        data: {
          spaceId: id,
          threadId: thread.id,
          botId: bot.id,
          seq: seq + 1,
          type,
          payload: {},
          runId: run.id,
        },
      });
    }
    return thread.id;
  }

  it("counts the completed tool calls of a run the pause holds at a checkpoint, and nothing else", async () => {
    const held = await chat("maintenance_paused", "checkpoint", 3);
    const fresh = await chat("maintenance_paused", "checkpoint", 0);
    const noCheckpoint = await chat("maintenance_paused", null, 2);
    const running = await chat("running", "checkpoint", 4);
    const steps = await pausedStepsByThread(prisma, [held, fresh, noCheckpoint, running]);
    expect(Object.fromEntries(steps)).toEqual({ [held]: 3, [fresh]: 0 });
    expect(await pausedStepsByThread(prisma, [])).toEqual(new Map());
  });
});
