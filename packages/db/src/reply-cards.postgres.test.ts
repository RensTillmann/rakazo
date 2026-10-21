import { randomUUID } from "node:crypto";
import { MessageBlock } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimSourceCheckedEffect, reconcileLegacySourceBindings } from "./approval-claim.js";
import { retireInvalidatedApprovalCards } from "./approval-retire.js";
import { createDb, type Pool, type PrismaClient } from "./client.js";
import { answerRunInput, pauseRunForInput } from "./events.js";
import { createThreadMessage } from "./messages.js";

// Fully migrated disposable local database only (VERIFY_DATABASE + DATABASE_URL).
const enabled = process.env.VERIFY_DATABASE && process.env.DATABASE_URL;
const postgres = enabled ? describe.sequential : describe.skip;

const INQUIRY =
  "Hi, my licence stopped working after the renewal.\n\nOrder 1182, renewed yesterday.";
const SOURCE_REF = "zendesk:3529";

function onlyAsk(blocks: unknown) {
  const [block] = MessageBlock.array().length(1).parse(blocks);
  if (block?.kind !== "ask") throw new Error("expected one ask block");
  return block;
}

postgres("reply cards, legacy approvals and claims (PostgreSQL)", () => {
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
      data: { spaceId: id, userId: id, name: "Josy", color: "test" },
    });
    const thread = await prisma.thread.create({ data: { spaceId: id, userId: id, botId: bot.id } });

    async function startRun() {
      const task = await prisma.task.create({
        data: {
          spaceId: id,
          userId: id,
          botId: bot.id,
          threadId: thread.id,
          prompt: "Reply to the customer.",
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
          status: "running",
          trigger: "user",
          leaseOwner: "fixture-worker",
          leaseFence: 1,
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      });
      const attempt = await prisma.attempt.create({
        data: { runId: run.id, fence: 1, status: "running" },
      });
      return { run, task, attempt };
    }

    /** A reply card for `version` of the conversation, stored the way the executor stores it. */
    async function replyCard(version: string, options: { fence?: number } = {}) {
      const started = await startRun();
      const paused = await pauseRunForInput(prisma, {
        spaceId: id,
        threadId: thread.id,
        botId: bot.id,
        runId: started.run.id,
        attemptId: started.attempt.id,
        leaseOwner: "fixture-worker",
        leaseFence: options.fence ?? 1,
        dedupeQuestion: true,
        blocks: [
          {
            kind: "ask",
            text: "Reply to Konstantin Grushko (#3529)?",
            status: "pending",
            draft: `Hi Konstantin,\n\nVersion ${version} reply.\n\nRens`,
            inquiry: INQUIRY,
            source: { ref: SOURCE_REF, version },
            actions: [
              { id: "choice-1", label: "Approve and send" },
              { id: "choice-2", label: "Don't send" },
            ],
          },
        ],
      });
      const message = await prisma.message.findFirst({
        where: { runId: started.run.id, role: "bot" },
      });
      const answer = (value: string, draftFinal?: string) =>
        answerRunInput(prisma, {
          spaceId: id,
          threadId: thread.id,
          runId: started.run.id,
          messageId: message!.id,
          answeredByUserId: id,
          answer: value,
          ...(draftFinal !== undefined ? { draftFinal } : {}),
        });
      const card = async () =>
        onlyAsk((await prisma.message.findUniqueOrThrow({ where: { id: message!.id } })).blocks);
      const runStatus = async () =>
        (await prisma.run.findUniqueOrThrow({ where: { id: started.run.id } })).status;
      const prompt = async () =>
        (await prisma.task.findUniqueOrThrow({ where: { id: started.task.id } })).prompt;
      return { paused, started, message, answer, card, runStatus, prompt };
    }

    /** An ordinary question on its own waiting run, the source of a withdrawal request. */
    async function sourceQuestion() {
      const started = await startRun();
      await prisma.run.update({ where: { id: started.run.id }, data: { status: "waiting_input" } });
      const question = await createThreadMessage(prisma, {
        threadId: thread.id,
        runId: started.run.id,
        botId: bot.id,
        role: "bot",
        blocks: [
          {
            kind: "ask",
            text: "Case 383 · which repository?",
            status: "pending",
            actions: [
              { id: "choice-1", label: "rakazo" },
              { id: "choice-2", label: "fleet" },
            ],
          },
        ],
      });
      return { started, question };
    }

    /** A withdrawal approval recorded before source binding: exact route-bound envelope only. */
    async function legacyWithdrawal(sourceMessageId: string, status = "intended") {
      const started = await startRun();
      await prisma.run.update({ where: { id: started.run.id }, data: { status: "waiting_input" } });
      const effect = await prisma.externalEffect.create({
        data: {
          spaceId: id,
          runId: started.run.id,
          kind: "mcp",
          idempotencyKey: `legacy-${randomUUID()}`,
          status,
          request: [
            "__rakazoCatalogTool",
            "direct",
            {
              route: {
                connectorId: "mcp",
                resourceId: "fleet-server",
                toolName: "question_withdraw",
                resourceRevision: 1,
              },
              args: { message_id: sourceMessageId, reason: "obsolete" },
            },
          ],
        },
      });
      const approval = await createThreadMessage(prisma, {
        threadId: thread.id,
        runId: started.run.id,
        botId: bot.id,
        role: "bot",
        blocks: [
          {
            kind: "ask",
            text: "Josy wants to withdraw a question",
            status: "pending",
            approvalEffectId: effect.id,
            actions: [
              { id: "allow", label: "Allow once" },
              { id: "deny", label: "Deny" },
            ],
          },
        ],
      });
      return { started, effect, approval };
    }

    return { prisma, id, bot, thread, replyCard, sourceQuestion, legacyWithdrawal };
  }

  it("a newer version of the same conversation retires the older open reply card", async () => {
    const f = await fixture();
    const first = await f.replyCard("41");
    expect(first.paused).toBe(true);
    expect(await first.card()).toMatchObject({ inquiry: INQUIRY, source: { version: "41" } });

    const second = await f.replyCard("42");
    expect(second.paused).toBe(true);
    const old = await first.card();
    expect(old).toMatchObject({ status: "retired" });
    expect(old.retiredReason).toContain(`${SOURCE_REF} (version 41 → 42)`);
    expect(old.answer).toBeUndefined();
    expect(await first.runStatus()).toBe("cancelled");
    // A click from a tab still showing the old card changes nothing.
    expect(await first.answer("choice-1")).toBe(false);
    expect(await second.card()).toMatchObject({ status: "pending", source: { version: "42" } });
  });

  it("the same version is refused as a duplicate and leaves the open card alone", async () => {
    const f = await fixture();
    const first = await f.replyCard("41");
    const again = await f.replyCard("41");
    expect(again.paused).toMatchObject({ duplicateAskedAt: expect.any(Date) });
    expect(again.message).toBeNull();
    expect(await first.card()).toMatchObject({ status: "pending" });
    expect(await first.runStatus()).toBe("waiting_input");
  });

  it("a card that loses its lease does not retire the older card", async () => {
    const f = await fixture();
    const first = await f.replyCard("41");
    const lost = await f.replyCard("42", { fence: 7 });
    expect(lost.paused).toBe(false);
    expect(await first.card()).toMatchObject({ status: "pending" });
    expect(await first.runStatus()).toBe("waiting_input");
  });

  it("an answer binds the edited reply and the source version", async () => {
    const f = await fixture();
    const card = await f.replyCard("42");
    const edited = "Hi Konstantin,\n\nYour licence works again from today.\n\nRens";
    expect(await card.answer("choice-1", edited)).toBe(true);
    expect(await card.card()).toMatchObject({
      status: "answered",
      answer: "choice-1",
      draftFinal: edited,
      source: { ref: SOURCE_REF, version: "42" },
    });
    const prompt = await card.prompt();
    expect(prompt).toContain(`Edited reply (send exactly this):\n${edited}`);
    expect(prompt).toContain(`This answer is for ${SOURCE_REF} at version 42.`);
  });

  it("a legacy request whose source already ended is invalidated and its card retired without a click", async () => {
    const f = await fixture();
    const source = await f.sourceQuestion();
    const legacy = await f.legacyWithdrawal(source.question.id);
    expect(
      await answerRunInput(f.prisma, {
        spaceId: f.id,
        threadId: f.thread.id,
        runId: source.started.run.id,
        messageId: source.question.id,
        answeredByUserId: f.id,
        answer: "choice-2",
      }),
    ).toBe(true);
    // The unbound legacy request survived the answer: nothing named its source.
    expect(
      (await f.prisma.externalEffect.findUniqueOrThrow({ where: { id: legacy.effect.id } })).status,
    ).toBe("intended");

    expect(await reconcileLegacySourceBindings(f.prisma, { spaceId: f.id })).toBe(1);
    const effect = await f.prisma.externalEffect.findUniqueOrThrow({
      where: { id: legacy.effect.id },
    });
    expect(effect.status).toBe("invalidated");
    const retired = await retireInvalidatedApprovalCards(f.prisma, { spaceId: f.id });
    expect(retired.map((card) => card.messageId)).toEqual([legacy.approval.id]);
    const card = onlyAsk(
      (await f.prisma.message.findUniqueOrThrow({ where: { id: legacy.approval.id } })).blocks,
    );
    expect(card).toMatchObject({ status: "retired" });
    expect(card.answer).toBeUndefined();
  });

  it("a legacy request whose source is still open gets its source recorded, so the answer ends it", async () => {
    const f = await fixture();
    const source = await f.sourceQuestion();
    const legacy = await f.legacyWithdrawal(source.question.id);
    expect(await reconcileLegacySourceBindings(f.prisma, { spaceId: f.id })).toBe(1);
    expect(
      await f.prisma.externalEffect.findUniqueOrThrow({ where: { id: legacy.effect.id } }),
    ).toMatchObject({ status: "intended", sourceMessageId: source.question.id });
    // Reconciling again changes nothing.
    expect(await reconcileLegacySourceBindings(f.prisma, { spaceId: f.id })).toBe(0);

    await answerRunInput(f.prisma, {
      spaceId: f.id,
      threadId: f.thread.id,
      runId: source.started.run.id,
      messageId: source.question.id,
      answeredByUserId: f.id,
      answer: "choice-1",
    });
    expect(
      (await f.prisma.externalEffect.findUniqueOrThrow({ where: { id: legacy.effect.id } })).status,
    ).toBe("invalidated");
  });

  it("an unbound request is never given a guessed source", async () => {
    const f = await fixture();
    const source = await f.sourceQuestion();
    const legacy = await f.legacyWithdrawal(source.question.id);
    await f.prisma.externalEffect.update({
      where: { id: legacy.effect.id },
      data: { request: { message_id: source.question.id } },
    });
    expect(await reconcileLegacySourceBindings(f.prisma, { spaceId: f.id })).toBe(0);
    expect(
      await f.prisma.externalEffect.findUniqueOrThrow({ where: { id: legacy.effect.id } }),
    ).toMatchObject({ status: "intended", sourceMessageId: null });
  });

  it("two competing execution claims let exactly one run the approved request", async () => {
    const f = await fixture();
    const source = await f.sourceQuestion();
    const legacy = await f.legacyWithdrawal(source.question.id, "approved");
    const run = {
      id: legacy.started.run.id,
      spaceId: f.id,
      botId: f.bot.id,
      userId: f.id,
    };
    const claims = await Promise.all(
      Array.from({ length: 4 }, () =>
        claimSourceCheckedEffect(f.prisma, run, legacy.effect.id, "approved"),
      ),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(
      await f.prisma.externalEffect.findUniqueOrThrow({ where: { id: legacy.effect.id } }),
    ).toMatchObject({ status: "executing", sourceMessageId: source.question.id });
  });
});
