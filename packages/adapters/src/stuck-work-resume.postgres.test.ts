import { randomUUID } from "node:crypto";
import type { JobPublisher } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { createDb, createThreadMessage, type PrismaClient } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reconcileStuckWork } from "./stuck-work.js";

// Fully migrated disposable local database only (VERIFY_DATABASE + DATABASE_URL).
const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

const HOUR = 60 * 60 * 1000;
const QUESTION: MessageBlock = {
  kind: "ask",
  text: "Case 383 · which repository?",
  status: "pending",
  actions: [
    { id: "choice-1", label: "rakazo" },
    { id: "choice-2", label: "fleet" },
  ],
};

describePostgres("stuck-work expiry around a resume (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  const spaces: string[] = [];
  const auditRevisions: number[] = [];

  beforeAll(() => {
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(new URL(process.env.DATABASE_URL!).hostname)
    ) {
      throw new Error("Expiry tests require a disposable local database");
    }
    const db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    close = () => db.pool.end();
  });
  afterAll(async () => {
    if (!prisma) return;
    try {
      await prisma.maintenanceAudit.deleteMany({ where: { revision: { in: auditRevisions } } });
      await prisma.organization.deleteMany({ where: { id: { in: spaces } } });
      await prisma.user.deleteMany({ where: { id: { in: spaces } } });
    } finally {
      await prisma.$disconnect();
      await close();
    }
  });

  async function fixture() {
    const id = randomUUID();
    spaces.push(id);
    await prisma.user.create({ data: { id, name: "Expiry fixture", email: `${id}@example.test` } });
    await prisma.organization.create({
      data: { id, name: "Fixture", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id, organizationId: id, name: "Fixture" } });
    const bot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Josy", color: "test" },
    });
    const thread = await prisma.thread.create({ data: { spaceId: id, userId: id, botId: bot.id } });
    /** A run in `status` that last moved `hoursAgo` hours ago, optionally holding an open card. */
    async function run(status: string, hoursAgo: number, card?: MessageBlock) {
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
      const created = await prisma.run.create({
        data: {
          spaceId: id,
          userId: id,
          botId: bot.id,
          threadId: thread.id,
          taskId: task.id,
          status,
          trigger: "user",
        },
      });
      const message = card
        ? await createThreadMessage(prisma, {
            threadId: thread.id,
            runId: created.id,
            botId: bot.id,
            role: "bot",
            blocks: [card],
          })
        : null;
      const at = new Date(Date.now() - hoursAgo * HOUR);
      await prisma.$executeRaw`UPDATE runs SET "updatedAt" = ${at} WHERE id = ${created.id}`;
      return { id: created.id, messageId: message?.id };
    }
    return { run };
  }

  const jobs = {
    enqueue: async () => undefined,
    cancel: async () => undefined,
  } as unknown as JobPublisher;
  const sweep = () => reconcileStuckWork({ prisma, jobs, now: new Date(), batchSize: 1000 });
  const status = async (id: string) =>
    (await prisma.run.findUniqueOrThrow({ where: { id } })).status;

  /** Records a pause from `fromHoursAgo` to `toHoursAgo` in the durable audit. */
  async function pausedBetween(fromHoursAgo: number, toHoursAgo: number) {
    const top = await prisma.maintenanceAudit.aggregate({ _max: { revision: true } });
    const base = Math.max(top._max.revision ?? 0, 1_000_000) + 1;
    for (const [offset, active, hoursAgo] of [
      [0, true, fromHoursAgo],
      [1, false, toHoursAgo],
    ] as const) {
      const revision = base + offset;
      auditRevisions.push(revision);
      await prisma.maintenanceAudit.create({
        data: {
          revision,
          requestId: randomUUID(),
          operatorId: "test-owner",
          action: active ? "enter" : "resume",
          expectedRevision: revision - 1,
          active,
          createdAt: new Date(Date.now() - hoursAgo * HOUR),
        },
      });
    }
  }

  it("keeps decisions waiting for the user when the pause lifts, however old", async () => {
    const f = await fixture();
    const question = await f.run("waiting_input", 72, QUESTION);
    const approval = await f.run("waiting_input", 30, {
      ...QUESTION,
      text: "Josy wants to send the reply",
      approvalEffectId: "effect-1",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "deny", label: "Deny" },
      ],
    });
    await sweep();
    await sweep();
    for (const card of [question, approval]) {
      expect(await status(card.id)).toBe("waiting_input");
      const [block] = (await prisma.message.findUniqueOrThrow({ where: { id: card.messageId! } }))
        .blocks as MessageBlock[];
      expect(block).toMatchObject({ kind: "ask", status: "pending" });
    }
  });

  it("does not count paused time, so work held by the pause survives resume", async () => {
    const f = await fixture();
    // Queued 30 h ago; the pause held it from 29 h ago until 1 h ago: 2 h of real waiting.
    await pausedBetween(29, 1);
    try {
      const held = await f.run("queued", 30);
      await sweep();
      expect(await status(held.id)).toBe("queued");
    } finally {
      // The audit is global; later tests must not see this pause.
      await prisma.maintenanceAudit.deleteMany({ where: { revision: { in: auditRevisions } } });
    }
  });

  it("still expires genuinely stuck work", async () => {
    const f = await fixture();
    const queued = await f.run("queued", 30);
    const orphanWait = await f.run("waiting_input", 30);
    const answered = await f.run("waiting_input", 30, {
      ...QUESTION,
      status: "answered",
      answer: "choice-1",
    });
    await sweep();
    expect(await status(queued.id)).toBe("cancelled");
    expect(await status(orphanWait.id)).toBe("cancelled");
    expect(await status(answered.id)).toBe("cancelled");
  });
});
