import { randomUUID } from "node:crypto";
import type { AdapterContext } from "@rakazo/adapter-kit";
import type { Pool, PrismaClient } from "@rakazo/db";
import { createDb } from "@rakazo/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  deliverMessagingOutbound,
  reconcileMessagingOutbound,
  type MessagingDeliveryDeps,
} from "./messaging-delivery.js";
import { MessagingTeamChatEmulator } from "./messaging-team-chat-emulator.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describePostgres("durable messaging delivery admission (PostgreSQL)", () => {
  let db: { prisma: PrismaClient; pool: Pool };
  const ids: string[] = [];
  const context: AdapterContext = {
    operationId: "delivery-test", traceId: "delivery-test", spaceId: "test-space",
    userId: "test-user", signal: new AbortController().signal,
  };
  beforeAll(() => { db = createDb(process.env.DATABASE_URL!); });
  afterEach(async () => {
    await db.prisma.$executeRaw`UPDATE maintenance_state SET active = false WHERE id = 'default'`;
    await db.prisma.messagingOutbound.deleteMany({ where: { id: { in: ids } } });
    ids.length = 0;
  });
  afterAll(async () => {
    if (!db) return;
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  async function row(threadId: string, body: string, createdAt: Date) {
    const id = randomUUID();
    ids.push(id);
    return db.prisma.messagingOutbound.create({
      data: { id, idempotencyKey: id, kind: "group", threadId, body, createdAt },
    });
  }

  function setup() {
    const messaging = new MessagingTeamChatEmulator();
    const deps: MessagingDeliveryDeps = {
      prisma: db.prisma, messaging,
      jobs: { enqueue: vi.fn(async () => undefined) },
      events: { sendUserMessage: vi.fn(), notify: vi.fn(async () => undefined) },
    };
    return { messaging, deps, drain: () => deliverMessagingOutbound(deps, {}, context) };
  }

  it("commits executing before I/O, lets pause enter during the send, and preserves ordered work on resume", async () => {
    const h = setup();
    const thread = `teamchat-emulator:${randomUUID()}`;
    const first = await row(thread, "first", new Date(1));
    const second = await row(thread, "second", new Date(2));
    const entered = deferred();
    const release = deferred();
    const send = h.messaging.sendToThread.bind(h.messaging);
    vi.spyOn(h.messaging, "sendToThread").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return send(...args);
    });
    const draining = h.drain();
    try {
      await Promise.race([
        entered.promise,
        draining.then(() => { throw new Error("Delivery drained without entering the provider"); }),
      ]);
      expect((await db.prisma.messagingOutbound.findUniqueOrThrow({ where: { id: first.id } })).status)
        .toBe("executing");
      // This completes before provider release: no maintenance lock crosses network I/O.
      await db.prisma.$executeRaw`UPDATE maintenance_state SET active = true WHERE id = 'default'`;
      await h.drain();
      expect(h.messaging.sent).toHaveLength(0);
    } finally {
      release.resolve();
      await draining;
    }
    expect(h.messaging.sent.map((message) => message.body)).toEqual(["first"]);
    expect((await db.prisma.messagingOutbound.findUniqueOrThrow({ where: { id: second.id } })).status)
      .toBe("pending");
    await db.prisma.$executeRaw`UPDATE maintenance_state SET active = false WHERE id = 'default'`;
    await Promise.all([h.drain(), h.drain()]);
    expect(h.messaging.sent.map((message) => message.body)).toEqual(["first", "second"]);
    expect(await db.prisma.messagingOutbound.count({ where: { id: { in: ids }, status: "sent" } }))
      .toBe(2);
  });

  it("never resends an ambiguous or crashed delivery and holds its later messages without blocking another conversation", async () => {
    const h = setup();
    const thread = `teamchat-emulator:${randomUUID()}`;
    const first = await row(thread, "unknown", new Date(1));
    const second = await row(thread, "later", new Date(2));
    const independent = await row(`teamchat-emulator:${randomUUID()}`, "independent", new Date(3));
    const send = h.messaging.sendToThread.bind(h.messaging);
    vi.spyOn(h.messaging, "sendToThread").mockImplementationOnce(async (...args) => {
      await send(...args);
      throw new Error("response lost after acceptance");
    });
    await h.drain();
    await h.drain();
    expect(h.messaging.sent.map((message) => message.body)).toEqual(["unknown", "independent"]);
    expect((await db.prisma.messagingOutbound.findUniqueOrThrow({ where: { id: first.id } })).status)
      .toBe("uncertain");
    expect((await db.prisma.messagingOutbound.findUniqueOrThrow({ where: { id: second.id } })).status)
      .toBe("pending");
    expect((await db.prisma.messagingOutbound.findUniqueOrThrow({ where: { id: independent.id } })).status)
      .toBe("sent");
    const crashed = await row(`teamchat-emulator:${randomUUID()}`, "crashed", new Date(4));
    await db.prisma.messagingOutbound.update({ where: { id: crashed.id }, data: {
      status: "executing", updatedAt: new Date(Date.now() - 180_000),
    } });
    await reconcileMessagingOutbound(db.prisma);
    await h.drain();
    expect((await db.prisma.messagingOutbound.findUniqueOrThrow({ where: { id: crashed.id } })).status)
      .toBe("uncertain");
    expect(h.messaging.sent.map((message) => message.body)).toEqual(["unknown", "independent"]);
  });
});
