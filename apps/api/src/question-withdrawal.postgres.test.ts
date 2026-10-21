import { randomUUID } from "node:crypto";
import { RPCHandler } from "@orpc/server/fetch";
import { FakeSandboxProvider, InMemoryRealtimeFanout, screenLeaseIdForRun } from "@rakazo/adapters";
import type { Actor, MessageBlock } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createDb, createThreadEvents, createThreadMessage, listPendingDecisions } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const describePostgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL
    ? describe.sequential
    : describe.skip;
const QUESTION: MessageBlock = { kind: "ask", text: "Case 42: which developer should reply?" };
const REASON = "The customer supplied new information; replace the obsolete question.";

describePostgres("withdrawing an obsolete question (PostgreSQL)", () => {
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

  async function setup(card: MessageBlock = QUESTION) {
    const id = randomUUID();
    organizations.push(id);
    await prisma.user.create({
      data: { id, name: "Withdrawal fixture", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "Withdrawal fixture", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id, organizationId: id, name: "Fixture" } });
    const actor: Actor = {
      spaceId: id,
      userId: id,
      email: `${id}@example.test`,
      isDeploymentOwner: false,
    };
    const computer = await prisma.computer.create({
      data: { spaceId: id, userId: id, scopeKey: id, homeKey: id, kind: "fake", state: "running" },
    });
    const bot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Fixture", color: "test", computerId: computer.id },
    });
    const thread = await prisma.thread.create({ data: { spaceId: id, userId: id, botId: bot.id } });
    const realtime = new InMemoryRealtimeFanout();
    const notifications: unknown[] = [];
    await realtime.subscribe(`thread:${thread.id}`, (payload) => {
      notifications.push(JSON.parse(payload));
    });
    const events = createThreadEvents(prisma, realtime);
    const sandbox = new FakeSandboxProvider();
    const context = {
      ...actor,
      operationId: "fixture",
      traceId: "fixture",
      signal: new AbortController().signal,
    };
    const ref = await sandbox.provision({ botId: computer.id, homePath: "/fixture" }, context);
    await prisma.computer.update({ where: { id: computer.id }, data: { providerRef: ref.id } });

    async function startRun(botId = bot.id) {
      const task = await prisma.task.create({
        data: {
          spaceId: id, userId: id, botId, threadId: thread.id,
          prompt: "Handle the customer question.", status: "running",
        },
      });
      const run = await prisma.run.create({
        data: {
          spaceId: id, userId: id, botId, threadId: thread.id, taskId: task.id,
          status: "running", trigger: "user", leaseOwner: "fixture-worker", leaseFence: 1,
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      });
      const attempt = await prisma.attempt.create({
        data: { runId: run.id, fence: 1, status: "running" },
      });
      return { run, task, attempt };
    }
    async function ask(
      started: { run: { id: string; botId: string }; attempt: { id: string } },
      block = card,
    ) {
      return events.pauseRunForInput({
        spaceId: id, threadId: thread.id, botId: started.run.botId, runId: started.run.id,
        attemptId: started.attempt.id, leaseOwner: "fixture-worker", leaseFence: 1,
        blocks: [block], dedupeQuestion: true,
      });
    }
    const started = await startRun();
    expect(await ask(started)).toBe(true);
    const message = await prisma.message.findFirstOrThrow({
      where: { runId: started.run.id, role: "bot" },
    });
    const deps = { prisma, events, sandbox };
    const handler = new RPCHandler(createRouter(deps as unknown as RouterDeps));
    async function withdraw(input: Record<string, unknown> = {}, caller: Actor | null = actor) {
      const { response } = await handler.handle(
        new Request("http://127.0.0.1/rpc/decisions/withdraw", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            json: { botId: bot.id, messageId: message.id, reason: REASON, ...input },
          }),
        }),
        { prefix: "/rpc", context: { actor: caller } },
      );
      return response!;
    }
    async function answer() {
      return events.answerRunInput({
        spaceId: id, threadId: thread.id, runId: started.run.id, messageId: message.id,
        answeredByUserId: id, answer: "The internal developer should reply.",
      });
    }
    return { ...started, actor, bot, thread, message, computer, events, notifications, sandbox, ref,
      context, startRun, ask, withdraw, answer };
  }

  it("withdraws only the obsolete question, keeps its history, and permits a fresh same-case ask", async () => {
    const f = await setup();
    const replacement = await f.startRun();
    const fresh: MessageBlock = { kind: "ask", text: "Case 42: should we contact the new developer?" };
    expect(await f.ask(replacement, fresh)).toHaveProperty("duplicateAskedAt");
    await f.events.append({
      spaceId: f.actor.spaceId, threadId: f.thread.id, botId: f.bot.id,
      runId: f.run.id, type: "thread.progress", payload: {},
    });

    const response = await f.withdraw();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ json: { withdrawn: true, runId: f.run.id } });
    expect(await prisma.run.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({
      status: "cancelled", completedAt: expect.any(Date), leaseOwner: null, leaseExpiresAt: null,
    });
    expect(await prisma.task.findUniqueOrThrow({ where: { id: f.task.id } })).toMatchObject({
      status: "cancelled", prompt: "Handle the customer question.",
    });
    // Paused attempts already ended; cancellation must not rewrite their historical outcome.
    expect(await prisma.attempt.findUniqueOrThrow({ where: { id: f.attempt.id } })).toMatchObject({
      status: "waiting_input", finishedAt: expect.any(Date),
    });
    expect(await prisma.message.findUniqueOrThrow({ where: { id: f.message.id } })).toEqual(f.message);
    expect(await prisma.message.count({ where: { threadId: f.thread.id, role: "user" } })).toBe(0);
    expect(await prisma.externalEffect.count({ where: { runId: f.run.id } })).toBe(0);
    const cancelled = await prisma.event.findMany({ where: { runId: f.run.id, type: "run.cancelled" } });
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!.payload).toMatchObject({ messageId: f.message.id, reason: REASON });
    expect(f.notifications).toContainEqual({ cursor: cancelled[0]!.seq });
    expect(await prisma.event.count({ where: { runId: f.run.id, type: "thread.progress" } })).toBe(0);
    expect(await listPendingDecisions(prisma, f.actor)).toEqual([]);
    expect(await f.answer()).toBe(false);
    expect(await f.ask(replacement, fresh)).toBe(true);
    expect((await listPendingDecisions(prisma, f.actor)).map((d) => d.runId)).toEqual([replacement.run.id]);

    const repeated = await f.withdraw();
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual({ json: { withdrawn: false, runId: f.run.id } });
    expect(await prisma.event.count({ where: { runId: f.run.id, type: "run.cancelled" } })).toBe(1);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: replacement.run.id } })).toMatchObject({ status: "waiting_input" });
  });

  it("authenticates the caller and binds ownership of the bot, thread, run and message", async () => {
    const f = await setup();
    expect((await f.withdraw({}, null)).status).toBe(401);
    expect((await f.withdraw({}, { ...f.actor, userId: "another-owner" })).status).toBe(404);
    expect((await f.withdraw({}, { ...f.actor, spaceId: "another-space" })).status).toBe(404);
    expect((await f.withdraw({ botId: "another-bot" })).status).toBe(404);
    expect((await f.withdraw({ messageId: "missing-message" })).status).toBe(404);
    await prisma.message.update({ where: { id: f.message.id }, data: { botId: null } });
    expect((await f.withdraw()).status).toBe(404);
    await prisma.message.update({ where: { id: f.message.id }, data: { botId: f.bot.id } });
    await prisma.message.update({ where: { id: f.message.id }, data: { role: "user" } });
    expect((await f.withdraw()).status).toBe(404);
    await prisma.message.update({ where: { id: f.message.id }, data: { role: "bot" } });
    await prisma.run.update({ where: { id: f.run.id }, data: { userId: "another-owner" } });
    expect((await f.withdraw()).status).toBe(404);
    await prisma.run.update({ where: { id: f.run.id }, data: { userId: f.actor.userId } });
    await prisma.bot.update({ where: { id: f.bot.id }, data: { userId: "another-owner" } });
    expect((await f.withdraw()).status).toBe(404);
    await prisma.bot.update({ where: { id: f.bot.id }, data: { userId: f.actor.userId } });
    await prisma.thread.update({ where: { id: f.thread.id }, data: { userId: "another-owner" } });
    expect((await f.withdraw()).status).toBe(404);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({ status: "waiting_input" });
  });

  it.each([
    { kind: "ask", text: "Approve?", approvalEffectId: "effect-fixture", actions: [{ id: "allow", label: "Yes" }, { id: "deny", label: "No" }] },
    { kind: "ask", text: "Effect-bound custom card", approvalEffectId: "effect-fixture" },
    { kind: "ask", text: "Enter a secret", input: "secret" },
  ] satisfies MessageBlock[])("refuses protected card $text", async (card) => {
    const f = await setup(card);
    expect((await f.withdraw()).status).toBe(409);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({ status: "waiting_input" });
    expect(await prisma.message.findUniqueOrThrow({ where: { id: f.message.id } })).toEqual(f.message);
    expect(await prisma.event.count({ where: { runId: f.run.id, type: "run.cancelled" } })).toBe(0);
  });

  it.each([
    { kind: "ask", text: "Another ordinary question" },
    { kind: "ask", text: "Approve a separate action?", approvalEffectId: "other-effect", actions: [{ id: "allow", label: "Yes" }, { id: "deny", label: "No" }] },
    { kind: "ask", text: "Enter a separate secret", input: "secret" },
  ] satisfies MessageBlock[])("preserves another pending card in the same run: $text", async (card) => {
    const f = await setup();
    const other = await createThreadMessage(prisma, {
      threadId: f.thread.id,
      runId: f.run.id,
      botId: f.bot.id,
      role: "bot",
      blocks: [card],
    });
    expect((await listPendingDecisions(prisma, f.actor)).map((decision) => decision.messageId)).toEqual([f.message.id, other.id]);
    expect((await f.withdraw()).status).toBe(409);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({ status: "waiting_input" });
    expect(await prisma.message.findUniqueOrThrow({ where: { id: other.id } })).toEqual(other);
    expect(await prisma.event.count({ where: { runId: f.run.id, type: "run.cancelled" } })).toBe(0);
  });

  it("does not treat answered approval history as another pending decision", async () => {
    const f = await setup();
    const history = await createThreadMessage(prisma, {
      threadId: f.thread.id,
      runId: f.run.id,
      botId: f.bot.id,
      role: "bot",
      blocks: [{
        kind: "ask", text: "Earlier approval", approvalEffectId: "answered-effect",
        status: "answered", answer: "deny",
        actions: [{ id: "allow", label: "Yes" }, { id: "deny", label: "No" }],
      }],
    });
    expect((await f.withdraw()).status).toBe(200);
    expect(await prisma.message.findUniqueOrThrow({ where: { id: history.id } })).toEqual(history);
  });

  it.each(["queued", "running", "completed", "failed"])("refuses an unanswered card on a %s run", async (status) => {
    const f = await setup();
    await prisma.run.update({ where: { id: f.run.id }, data: { status } });
    expect((await f.withdraw()).status).toBe(409);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({ status });
  });

  it("never withdraws a real answer, even if that run is later cancelled", async () => {
    const f = await setup();
    expect(await f.answer()).toBe(true);
    expect((await f.withdraw()).status).toBe(409);
    await prisma.run.update({ where: { id: f.run.id }, data: { status: "cancelled" } });
    expect((await f.withdraw()).status).toBe(409);
  });

  it("serializes a simultaneous answer and withdrawal so exactly one wins", async () => {
    const f = await setup();
    const [answered, withdrawn] = await Promise.all([f.answer(), f.withdraw()]);
    const run = await prisma.run.findUniqueOrThrow({ where: { id: f.run.id } });
    const message = await prisma.message.findUniqueOrThrow({ where: { id: f.message.id } });
    if (answered) {
      expect(withdrawn.status).toBe(409);
      expect(run.status).toBe("queued");
      expect(message.blocks).toEqual([expect.objectContaining({ status: "answered" })]);
      expect(await prisma.event.count({ where: { runId: f.run.id, type: "run.cancelled" } })).toBe(0);
    } else {
      expect(withdrawn.status).toBe(200);
      expect(run.status).toBe("cancelled");
      expect(message).toEqual(f.message);
    }
  });

  it("expires only the withdrawn run's lease and does not stop another run on that computer", async () => {
    const f = await setup();
    const newer = await f.startRun();
    const otherBot = await prisma.bot.create({
      data: { spaceId: f.actor.spaceId, userId: f.actor.userId, name: "Other", color: "test", computerId: f.computer.id },
    });
    const other = await f.startRun(otherBot.id);
    const expiresAt = new Date(Date.now() + 60_000);
    const oldLease = await prisma.computerExecutionLease.create({
      data: { computerId: f.computer.id, botId: f.bot.id, runId: f.run.id, fence: 3, expiresAt },
    });
    const otherLease = await prisma.computerExecutionLease.create({
      data: { computerId: f.computer.id, botId: otherBot.id, runId: other.run.id, fence: 7, expiresAt },
    });
    await prisma.computer.update({
      where: { id: f.computer.id },
      data: { executionBotId: f.bot.id, executionRunId: newer.run.id, executionLeaseExpiresAt: expiresAt },
    });
    // A newer screen claim by the same bot must survive release of the old fenced claim.
    const newerScreenLease = screenLeaseIdForRun(null, newer.run.id, 8);
    await f.sandbox.connectScreen(f.ref, { view: "snapshot" }, {
      ...f.context, botId: f.bot.id, runId: newer.run.id, screenLeaseId: newerScreenLease,
    });
    const activeAttempt = await prisma.attempt.create({
      data: { runId: f.run.id, fence: 2, status: "running" },
    });
    expect((await f.withdraw()).status).toBe(200);
    // Withdrawal cancels the run and expires its lease, but only the attempt's own worker (or
    // evidence) may settle the attempt: a cancelled run is not proof that it drained (Q35).
    expect(await prisma.attempt.findUniqueOrThrow({ where: { id: activeAttempt.id } })).toMatchObject({ status: "running", finishedAt: null });
    expect(await prisma.computerExecutionLease.findUniqueOrThrow({ where: { id: oldLease.id } })).toMatchObject({ expiresAt: new Date(0), fence: 3 });
    expect(await prisma.computerExecutionLease.findUniqueOrThrow({ where: { id: otherLease.id } })).toEqual(otherLease);
    expect(await prisma.computer.findUniqueOrThrow({ where: { id: f.computer.id } })).toMatchObject({ executionRunId: newer.run.id, executionLeaseExpiresAt: expiresAt });
    expect(await prisma.run.findUniqueOrThrow({ where: { id: newer.run.id } })).toEqual(newer.run);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: other.run.id } })).toEqual(other.run);
    expect(await prisma.task.findUniqueOrThrow({ where: { id: newer.task.id } })).toEqual(newer.task);
    expect(f.sandbox.boxes.get(f.ref.id)!.screenLeases.get(f.bot.id)).toBe(newerScreenLease);
  });

  it("leaves a newer execution lease belonging to the same bot untouched", async () => {
    const f = await setup();
    const newer = await f.startRun();
    const lease = await prisma.computerExecutionLease.create({
      data: {
        computerId: f.computer.id, botId: f.bot.id, runId: newer.run.id,
        fence: 9, expiresAt: new Date(Date.now() + 60_000),
      },
    });
    expect((await f.withdraw()).status).toBe(200);
    expect(await prisma.computerExecutionLease.findUniqueOrThrow({ where: { id: lease.id } })).toEqual(lease);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: newer.run.id } })).toEqual(newer.run);
  });

  it.each(["", "  \n ", "x".repeat(501)])("requires a nonempty reason of at most 500 characters", async (reason) => {
    const f = await setup();
    expect((await f.withdraw({ reason })).status).toBe(400);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({ status: "waiting_input" });
  });
});
