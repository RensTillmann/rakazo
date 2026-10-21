import { randomUUID } from "node:crypto";
import type { JobPublisher } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { MessageBlock } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { answerRunInput, createDb, createThreadEvents, createThreadMessage } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { forwardDraftEditLearning, resolveThreadTarget } from "./thread-target.js";

const describePostgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL
    ? describe.sequential
    : describe.skip;

const DRAFT = "Hi Konstantin,\n\nYour licence is active again.\n\nRens";
const EDITED =
  "Hi Konstantin,\n\nYour licence works again from today. Sorry for the trouble.\n\nRens";

describePostgres("draft-edit learning note to Elena (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let closePool: () => Promise<void>;
  const organizations: string[] = [];

  beforeAll(() => {
    const db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    closePool = () => db.pool.end();
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.organization.deleteMany({ where: { id: { in: organizations } } });
    await prisma.user.deleteMany({ where: { id: { in: organizations } } });
    await prisma.$disconnect();
    await closePool();
  });

  async function setup() {
    const id = randomUUID();
    organizations.push(id);
    await prisma.user.create({
      data: { id, name: "Learning fixture", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "Learning fixture", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id, organizationId: id, name: "Fixture" } });
    const actor: Actor = {
      spaceId: id,
      userId: id,
      email: `${id}@example.test`,
      isDeploymentOwner: false,
    };
    const josy = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Josy", color: "test" },
    });
    const elena = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Elena", color: "test" },
    });
    const thread = await prisma.thread.create({
      data: { spaceId: id, userId: id, botId: josy.id },
    });
    await prisma.thread.create({ data: { spaceId: id, userId: id, botId: elena.id } });
    const task = await prisma.task.create({
      data: {
        spaceId: id,
        userId: id,
        botId: josy.id,
        threadId: thread.id,
        prompt: "reply",
        status: "running",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId: josy.id,
        threadId: thread.id,
        taskId: task.id,
        status: "waiting_input",
        trigger: "user",
      },
    });
    const card = await createThreadMessage(prisma, {
      threadId: thread.id,
      runId: run.id,
      botId: josy.id,
      role: "bot",
      blocks: [
        {
          kind: "ask",
          text: "Reply to Konstantin Grushko (#3529)?",
          status: "pending",
          draft: DRAFT,
          source: { ref: "zendesk:3529", version: "42" },
          actions: [
            { id: "choice-1", label: "Approve and send" },
            { id: "choice-2", label: "Don't send" },
          ],
        },
      ],
    });
    const enqueued: unknown[] = [];
    const jobs = {
      enqueue: async (job: unknown) => void enqueued.push(job),
    } as unknown as JobPublisher;
    const deps = { prisma, events: createThreadEvents(prisma), jobs };
    const source = await resolveThreadTarget(prisma, actor, { botId: josy.id });
    const learn = () =>
      forwardDraftEditLearning(deps, actor, source, {
        messageId: card.id,
        flagBot: "Elena",
        label: "Feedback to Elena",
        webOrigin: "http://127.0.0.1:5173",
      });
    const answer = (draftFinal?: string) =>
      answerRunInput(prisma, {
        spaceId: id,
        threadId: thread.id,
        runId: run.id,
        messageId: card.id,
        answeredByUserId: id,
        answer: "choice-1",
        ...(draftFinal !== undefined ? { draftFinal } : {}),
      });
    const notes = () =>
      prisma.message.findMany({
        where: { thread: { botId: elena.id }, clientNonce: `draft-edit:${card.id}` },
      });
    return { id, learn, answer, notes, enqueued };
  }

  it("an edited draft reaches Elena once, as a note that changes nothing", async () => {
    const f = await setup();
    expect(await f.answer(EDITED)).toBe(true);
    const first = await f.learn();
    const second = await f.learn();
    expect(first).not.toBeNull();
    expect(second?.seq).toBe(first?.seq);
    const notes = await f.notes();
    expect(notes).toHaveLength(1);
    const [block] = MessageBlock.array().parse(notes[0]!.blocks);
    const text = block?.kind === "text" ? block.text : "";
    expect(text).toContain("Learning note only");
    expect(text).toContain("approves, sends and changes nothing");
    expect(text).toContain(`Original draft:\n${DRAFT}`);
    expect(text).toContain(`What I sent instead:\n${EDITED}`);
    expect(text).toContain("zendesk:3529 (version 42)");
    // No authority changes: no approval effects or always-allow rules appear.
    expect(await prisma.externalEffect.count({ where: { spaceId: f.id } })).toBe(0);
    expect(await prisma.actionApprovalRule.count({ where: { spaceId: f.id } })).toBe(0);
  });

  it("an unchanged draft sends no note", async () => {
    const f = await setup();
    expect(await f.answer(DRAFT)).toBe(true);
    expect(await f.learn()).toBeNull();
    expect(await f.notes()).toHaveLength(0);
  });

  it("a card still waiting for an answer sends no note", async () => {
    const f = await setup();
    expect(await f.learn()).toBeNull();
    expect(await f.notes()).toHaveLength(0);
  });
});
