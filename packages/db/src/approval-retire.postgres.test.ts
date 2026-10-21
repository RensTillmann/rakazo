import { randomUUID } from "node:crypto";
import type { MessageBlock } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { retireInvalidatedApprovalCards } from "./approval-retire.js";
import { createDb } from "./client.js";
import { listPendingDecisions } from "./decisions.js";
import { answerRunInput } from "./events.js";
import { createThreadMessage } from "./messages.js";

// Fully migrated disposable local database only (VERIFY_DATABASE + DATABASE_URL).
const enabled = process.env.VERIFY_DATABASE && process.env.DATABASE_URL;
const postgres = enabled ? describe.sequential : describe.skip;

postgres("retiring approval cards whose source question ended (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  const spaces: string[] = [];

  beforeAll(() => {
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(new URL(process.env.DATABASE_URL!).hostname)
    ) {
      throw new Error("Retirement tests require a disposable local database");
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

  async function fixture(options: { secondCard?: boolean } = {}) {
    const prisma = db.prisma;
    const id = randomUUID();
    spaces.push(id);
    await prisma.user.create({ data: { id, name: "Retire fixture", email: `${id}@example.test` } });
    await prisma.organization.create({
      data: { id, name: "Fixture", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id, organizationId: id, name: "Fixture" } });
    await prisma.member.create({
      data: { id, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
    });
    await prisma.spaceMember.create({
      data: {
        id,
        organizationId: id,
        spaceId: id,
        userId: id,
        role: "owner",
        createdAt: new Date(),
      },
    });
    const bot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Elena", color: "test" },
    });
    const thread = await prisma.thread.create({ data: { spaceId: id, userId: id, botId: bot.id } });
    const waitingRun = async () => {
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
      return prisma.run.create({
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
    };
    const source = await waitingRun();
    const question = await createThreadMessage(prisma, {
      threadId: thread.id,
      runId: source.id,
      botId: bot.id,
      role: "bot",
      blocks: [
        {
          kind: "ask",
          text: "Case 383 · fleet: which repository?",
          status: "pending",
          actions: [
            { id: "choice-1", label: "rakazo" },
            { id: "choice-2", label: "fleet" },
          ],
        },
      ],
    });
    const dependent = await waitingRun();
    const effect = await prisma.externalEffect.create({
      data: {
        spaceId: id,
        runId: dependent.id,
        kind: "mcp",
        idempotencyKey: `withdraw-${id}`,
        status: "intended",
        request: { message_id: question.id },
        sourceMessageId: question.id,
      },
    });
    const approval = await createThreadMessage(prisma, {
      threadId: thread.id,
      runId: dependent.id,
      botId: bot.id,
      role: "bot",
      blocks: [
        {
          kind: "ask",
          text: "Elena wants to withdraw a question",
          status: "pending",
          approvalEffectId: effect.id,
          actions: [
            { id: "allow", label: "Allow once" },
            { id: "deny", label: "Deny" },
          ],
        },
      ],
    });
    if (options.secondCard) {
      await createThreadMessage(prisma, {
        threadId: thread.id,
        runId: dependent.id,
        botId: bot.id,
        role: "bot",
        blocks: [{ kind: "ask", text: "Another open question", status: "pending" }],
      });
    }
    const actor = { spaceId: id, userId: id };
    const answer = (messageId: string, runId: string, value: string) =>
      answerRunInput(prisma, {
        spaceId: id,
        threadId: thread.id,
        runId,
        messageId,
        answeredByUserId: id,
        answer: value,
      });
    const card = async () =>
      (
        (await prisma.message.findUniqueOrThrow({ where: { id: approval.id } })).blocks as Extract<
          MessageBlock,
          { kind: "ask" }
        >[]
      )[0]!;
    return {
      prisma,
      id,
      actor,
      thread,
      source,
      dependent,
      question,
      effect,
      approval,
      answer,
      card,
    };
  }

  it("retires the stuck approval card once its source is answered, and a stale click does nothing", async () => {
    const f = await fixture();
    expect(await f.answer(f.question.id, f.source.id, "choice-2")).toBe(true);
    expect(
      (await f.prisma.externalEffect.findUniqueOrThrow({ where: { id: f.effect.id } })).status,
    ).toBe("invalidated");
    // Before retirement the dependent card is still listed and actionable-looking: the reported bug.
    expect((await listPendingDecisions(f.prisma, f.actor)).map((d) => d.messageId)).toContain(
      f.approval.id,
    );

    const retired = await retireInvalidatedApprovalCards(f.prisma, { spaceId: f.id });
    expect(retired).toEqual([
      expect.objectContaining({ messageId: f.approval.id, runId: f.dependent.id, queued: true }),
    ]);
    expect(await f.card()).toMatchObject({
      kind: "ask",
      status: "retired",
      retiredReason: expect.stringContaining("No longer needed"),
    });
    expect((await f.card()).answer).toBeUndefined();
    expect((await f.prisma.run.findUniqueOrThrow({ where: { id: f.dependent.id } })).status).toBe(
      "queued",
    );
    expect((await listPendingDecisions(f.prisma, f.actor)).map((d) => d.messageId)).not.toContain(
      f.approval.id,
    );
    const event = await f.prisma.event.findFirst({
      where: { threadId: f.thread.id, runId: f.dependent.id, type: "thread.message.updated" },
      orderBy: { seq: "desc" },
    });
    expect(event?.payload).toMatchObject({
      messageId: f.approval.id,
      blocks: [{ status: "retired" }],
    });

    // A tab that still shows the card cannot approve it, and nothing is revived.
    expect(await f.answer(f.approval.id, f.dependent.id, "allow")).toBe(false);
    expect(
      (await f.prisma.externalEffect.findUniqueOrThrow({ where: { id: f.effect.id } })).status,
    ).toBe("invalidated");
    expect(await retireInvalidatedApprovalCards(f.prisma, { spaceId: f.id })).toEqual([]);
  });

  it("retires the card but keeps the run waiting while another of its cards is open", async () => {
    const f = await fixture({ secondCard: true });
    expect(await f.answer(f.question.id, f.source.id, "choice-1")).toBe(true);
    const [card] = await retireInvalidatedApprovalCards(f.prisma, { spaceId: f.id });
    expect(card).toMatchObject({ messageId: f.approval.id, queued: false });
    expect((await f.card()).status).toBe("retired");
    expect((await f.prisma.run.findUniqueOrThrow({ where: { id: f.dependent.id } })).status).toBe(
      "waiting_input",
    );
  });

  it("ends a race between approving and answering the source in one consistent state", async () => {
    for (let round = 0; round < 6; round += 1) {
      const f = await fixture();
      const [approved, sourceAnswered] = await Promise.all([
        f.answer(f.approval.id, f.dependent.id, "allow"),
        f.answer(f.question.id, f.source.id, "choice-1"),
      ]);
      expect(sourceAnswered).toBe(true);
      await retireInvalidatedApprovalCards(f.prisma, { spaceId: f.id });
      const effect = await f.prisma.externalEffect.findUniqueOrThrow({
        where: { id: f.effect.id },
      });
      const card = await f.card();
      // Whoever won, the action can no longer execute and the card is answered or retired, never both.
      expect(effect.status).toBe("invalidated");
      expect(card.status).toBe(approved ? "answered" : "retired");
      expect((await f.prisma.run.findUniqueOrThrow({ where: { id: f.dependent.id } })).status).toBe(
        "queued",
      );
    }
  });
});
