import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { createPendingSteeringRun, sendUserMessage } from "./events.js";
import { createThreadMessage } from "./messages.js";
import { provisionMessagingIdentity } from "./messaging.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe.sequential : describe.skip;

describePostgres("a decision card does not make the bot busy (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let provisioned = false;
  let userId: string;
  let spaceId: string;
  let botId: string;
  let threadId: string;
  const address = `+1555${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      try {
        await db.prisma.$disconnect();
      } finally {
        await db.pool.end();
      }
    };
    ({ userId, spaceId, botId, threadId } = await provisionMessagingIdentity(
      prisma,
      { provider: "sendblue", address },
      { signupsEnabled: undefined, signupAllowlist: undefined },
    ));
    provisioned = true;
  });

  afterAll(async () => {
    try {
      if (prisma && provisioned) {
        await prisma.messagingIdentity.deleteMany({ where: { provider: "sendblue", address } });
        await prisma.organization.deleteMany({ where: { id: spaceId } });
        await prisma.user.deleteMany({ where: { id: userId } });
      }
    } finally {
      await close?.();
    }
  });

  beforeEach(async () => {
    await prisma.run.updateMany({
      where: {
        threadId,
        status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
      },
      data: { status: "cancelled" },
    });
    await prisma.steeringMessage.deleteMany({ where: { botId } });
  });

  async function createRun(
    status: "waiting_input" | "running",
    trigger = "user",
  ): Promise<{ id: string }> {
    const task = await prisma.task.create({
      data: { spaceId, botId, threadId, userId, prompt: "book the trip", status: "running" },
    });
    return prisma.run.create({
      data: {
        spaceId,
        botId,
        threadId,
        taskId: task.id,
        userId,
        status,
        trigger,
        startedAt: new Date(),
        ...(status === "running"
          ? { leaseOwner: "worker-1", leaseFence: 1, leaseExpiresAt: new Date(Date.now() + 60_000) }
          : {}),
      },
      select: { id: true },
    });
  }

  function send(trigger: "user" | "webhook" | "messaging", text = `hello ${randomUUID()}`) {
    return sendUserMessage(prisma, {
      spaceId,
      threadId,
      botId,
      userId,
      blocks: [{ kind: "text", text }],
      prompt: text,
      trigger,
      clientNonce: randomUUID(),
    });
  }

  it.each(["user", "webhook", "messaging"] as const)(
    "starts a normal %s run while a card waits and leaves the card pending",
    async (trigger) => {
      const waiting = await createRun("waiting_input");
      const sent = await send(trigger);

      expect(sent.runId).not.toBeNull();
      expect(sent.runId).not.toBe(waiting.id);
      expect(sent.taskId).not.toBeNull();
      const started = await prisma.run.findUniqueOrThrow({ where: { id: sent.runId! } });
      expect(started).toMatchObject({ status: "queued", trigger, sourceMessageId: sent.messageId });
      expect(await prisma.steeringMessage.count({ where: { messageId: sent.messageId } })).toBe(0);
      await expect(
        prisma.run.findUniqueOrThrow({ where: { id: waiting.id }, select: { status: true } }),
      ).resolves.toEqual({ status: "waiting_input" });
    },
  );

  it("steers a running conversational run, never the run waiting at a card", async () => {
    const waiting = await createRun("waiting_input");
    const running = await createRun("running");
    const sent = await send("user");

    expect(sent.runId).toBe(running.id);
    expect(sent.taskId).toBeNull();
    const steering = await prisma.steeringMessage.findMany({
      where: { messageId: sent.messageId },
      select: { runId: true },
    });
    expect(steering).toEqual([{ runId: running.id }]);
    expect(steering.some((row) => row.runId === waiting.id)).toBe(false);
  });

  it("queues the follow-up for pending steering while only a card waits", async () => {
    await createRun("waiting_input");
    const message = await createThreadMessage(prisma, {
      threadId,
      role: "user",
      blocks: [{ kind: "text", text: `later ${randomUUID()}` }],
    });
    const pending = await prisma.steeringMessage.create({
      data: { messageId: message.id, botId, userId, runId: null },
    });

    const runId = await prisma.$transaction((tx) =>
      createPendingSteeringRun(tx, { spaceId, threadId, botId }),
    );

    expect(runId).not.toBeNull();
    await expect(
      prisma.steeringMessage.findUniqueOrThrow({ where: { id: pending.id } }),
    ).resolves.toMatchObject({ runId });
  });

  it("still holds the follow-up behind a running run", async () => {
    await createRun("running");
    const message = await createThreadMessage(prisma, {
      threadId,
      role: "user",
      blocks: [{ kind: "text", text: `later ${randomUUID()}` }],
    });
    await prisma.steeringMessage.create({
      data: { messageId: message.id, botId, userId, runId: null },
    });

    await expect(
      prisma.$transaction((tx) => createPendingSteeringRun(tx, { spaceId, threadId, botId })),
    ).resolves.toBeNull();
  });
});
