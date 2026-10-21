import { randomUUID } from "node:crypto";
import { MessageBlock } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENDED_RUN_CARD_REASON, retireEndedRunCards } from "./approval-retire.js";
import { cancelRunsInTransaction } from "./cancel-runs.js";
import { createDb, type Pool, type PrismaClient } from "./client.js";
import { createThreadMessage } from "./messages.js";

// Fully migrated disposable local database only (VERIFY_DATABASE + DATABASE_URL).
const enabled = process.env.VERIFY_DATABASE && process.env.DATABASE_URL;
const postgres = enabled ? describe.sequential : describe.skip;

const QUESTION: MessageBlock = {
  kind: "ask",
  text: "Case 383 · which repository?",
  status: "pending",
  actions: [
    { id: "choice-1", label: "rakazo" },
    { id: "choice-2", label: "fleet" },
  ],
};

postgres("cards whose run ended (PostgreSQL)", () => {
  let db: { prisma: PrismaClient; pool: Pool };
  const spaces: string[] = [];

  beforeAll(() => {
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(new URL(process.env.DATABASE_URL!).hostname)
    ) {
      throw new Error("Card tests require a disposable local database");
    }
    db = createDb(process.env.DATABASE_URL!);
  });
  afterAll(async () => {
    if (!db) return;
    try {
      await db.prisma.organization.deleteMany({ where: { id: { in: spaces } } });
      await db.prisma.user.deleteMany({ where: { id: { in: spaces } } });
    } finally {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  async function fixture() {
    const prisma = db.prisma;
    const id = randomUUID();
    spaces.push(id);
    await prisma.user.create({ data: { id, name: "Card fixture", email: `${id}@example.test` } });
    await prisma.organization.create({
      data: { id, name: "Fixture", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id, organizationId: id, name: "Fixture" } });
    const bot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Jill", color: "test" },
    });
    const thread = await prisma.thread.create({ data: { spaceId: id, userId: id, botId: bot.id } });
    /** A card stored on a waiting run, then the run is put in `status` the way an old path left it. */
    async function card(status: string, block: MessageBlock = QUESTION) {
      const task = await prisma.task.create({
        data: {
          spaceId: id,
          userId: id,
          botId: bot.id,
          threadId: thread.id,
          prompt: "work",
          status: "running",
        },
      });
      const run = await prisma.run.create({
        data: {
          spaceId: id,
          userId: id,
          botId: bot.id,
          threadId: thread.id,
          taskId: task.id,
          status: "waiting_input",
          trigger: "user",
        },
      });
      const message = await createThreadMessage(prisma, {
        threadId: thread.id,
        runId: run.id,
        botId: bot.id,
        role: "bot",
        blocks: [block],
      });
      if (status !== "waiting_input") {
        await prisma.run.update({ where: { id: run.id }, data: { status } });
      }
      const ask = async () => {
        const [first] = MessageBlock.array().parse(
          (await prisma.message.findUniqueOrThrow({ where: { id: message.id } })).blocks,
        );
        return first;
      };
      return { run, task, message, ask };
    }
    return { prisma, id, thread, card };
  }

  it("cancelling a run retires its unanswered question and approval cards in the same transaction", async () => {
    const f = await fixture();
    const question = await f.card("waiting_input");
    const approval = await f.card("waiting_input", {
      kind: "ask",
      text: "Jill wants to push to acme/site",
      status: "pending",
      approvalEffectId: "effect-1",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "deny", label: "Deny" },
      ],
    });
    await f.prisma.$transaction((tx) =>
      cancelRunsInTransaction(
        tx,
        [question.run, approval.run].map((run) => ({ id: run.id, taskId: run.taskId })),
        new Date(),
      ),
    );
    for (const card of [question, approval]) {
      expect(await card.ask()).toMatchObject({
        status: "retired",
        retiredReason: ENDED_RUN_CARD_REASON,
      });
      expect(await card.ask()).not.toHaveProperty("answer");
    }
    expect(
      await f.prisma.event.count({
        where: { threadId: f.thread.id, type: "thread.message.updated" },
      }),
    ).toBe(2);
  });

  it("the reconciler retires cards left open on ended runs, once, and leaves live and answered ones", async () => {
    const f = await fixture();
    const cancelled = await f.card("cancelled");
    const completed = await f.card("completed");
    const failed = await f.card("failed");
    const waiting = await f.card("waiting_input");
    const answered = await f.card("cancelled", {
      ...QUESTION,
      status: "answered",
      answer: "choice-1",
    });

    const retired = await retireEndedRunCards(f.prisma, { spaceId: f.id });
    expect(retired.map((card) => card.messageId).sort()).toEqual(
      [cancelled.message.id, completed.message.id, failed.message.id].sort(),
    );
    for (const card of [cancelled, completed, failed]) {
      expect(await card.ask()).toMatchObject({
        status: "retired",
        retiredReason: ENDED_RUN_CARD_REASON,
      });
    }
    expect(await waiting.ask()).toMatchObject({ status: "pending" });
    expect(await answered.ask()).toMatchObject({ status: "answered", answer: "choice-1" });
    // The runs themselves are not touched, and a second pass changes nothing.
    expect(await f.prisma.run.findUniqueOrThrow({ where: { id: completed.run.id } })).toMatchObject(
      { status: "completed" },
    );
    expect(await retireEndedRunCards(f.prisma, { spaceId: f.id })).toEqual([]);
  });
});
