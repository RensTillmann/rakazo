import { randomUUID } from "node:crypto";
import type { JobPublisher, MessagingInboundMessage } from "@rakazo/adapter-kit";
import { FakeSandboxProvider } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import type { Pool } from "pg";
import {
  claimSteering, createDb, createGroupRepos, createPendingSteeringRun, createThreadEvents,
  createThreadMessage, sendUserMessage,
} from "@rakazo/db";
import { claimMaintenanceEffect, createMaintenanceStore } from "@rakazo/db/maintenance";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveThreadTarget, sendThreadMessage, stopThreadRuns, threadSnapshot } from "./thread-target.js";
import { TeamChatBridge } from "./team-chat-bridge.js";
import { deliverWebhookEvent } from "./webhook-inbound.js";
import { createMessagingInboundHandler } from "./messaging-inbound.js";

// Run only against a fully migrated disposable local database, never deployment settings.
const databaseUrl = process.env.MAINTENANCE_TEST_DATABASE_URL;
const suite = databaseUrl ? describe.sequential : describe.skip;

suite("durable intake during maintenance (PostgreSQL)", () => {
  let db: { prisma: PrismaClient; pool: Pool };
  let originalState: { active: boolean; revision: number };
  const organizations: string[] = [];
  const channels: string[] = [];
  const messagingIdentities: string[] = [];

  beforeAll(async () => {
    if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(databaseUrl!).hostname)) {
      throw new Error("Maintenance intake tests require a disposable local database");
    }
    db = createDb(databaseUrl!);
    originalState = await db.prisma.maintenanceState.findUniqueOrThrow({ where: { id: "default" } });
  });

  afterAll(async () => {
    if (!db) return;
    try {
      await db.prisma.messagingOutbound.deleteMany({ where: { identityId: { in: messagingIdentities } } });
      await db.prisma.messagingChannel.deleteMany({ where: { id: { in: channels } } });
      await db.prisma.organization.deleteMany({ where: { id: { in: organizations } } });
      await db.prisma.user.deleteMany({ where: { id: { in: organizations } } });
      if (originalState) await db.prisma.maintenanceState.update({
        where: { id: "default" }, data: { active: originalState.active, revision: originalState.revision },
      });
    } finally {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  async function fixture() {
    const prisma = db.prisma;
    const id = randomUUID();
    organizations.push(id);
    await prisma.user.create({ data: { id, name: "Intake fixture", email: `${id}@example.test` } });
    await prisma.organization.create({ data: { id, name: "Fixture", slug: id, createdAt: new Date() } });
    await prisma.space.create({ data: { id, organizationId: id, name: "Fixture" } });
    await prisma.member.create({ data: { id, organizationId: id, userId: id, role: "owner", createdAt: new Date() } });
    await prisma.spaceMember.create({ data: { id, organizationId: id, spaceId: id, userId: id, role: "owner", createdAt: new Date() } });
    const bot = await prisma.bot.create({ data: { spaceId: id, userId: id, name: "Fixture", color: "test" } });
    const thread = await prisma.thread.create({ data: { spaceId: id, userId: id, botId: bot.id } });
    const actor: Actor = { spaceId: id, userId: id, email: `${id}@example.test`, isDeploymentOwner: false };
    const events = createThreadEvents(prisma);
    const jobs: JobPublisher = { enqueue: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined), close: async () => undefined };
    await prisma.maintenanceState.update({ where: { id: "default" }, data: { active: true } });
    return { prisma, actor, bot, thread, events, jobs };
  }

  async function messagingFixture() {
    const f = await fixture();
    const identity = await f.prisma.messagingIdentity.create({ data: {
      provider: "fixture", address: f.actor.userId, spaceId: f.actor.spaceId,
      userId: f.actor.userId, botId: f.bot.id,
    } });
    messagingIdentities.push(identity.id);
    const channel = await f.prisma.messagingChannel.create({ data: {
      provider: "fixture", threadId: randomUUID(), name: "Fixture room",
    } });
    channels.push(channel.id);
    const member = await f.prisma.messagingChannelMember.create({ data: {
      channelId: channel.id, address: identity.address, identityId: identity.id, status: "left",
    } });
    const handle = createMessagingInboundHandler({
      prisma: f.prisma, events: f.events, jobs: f.jobs, openSignup: false,
      signupPolicy: { signupsEnabled: undefined, signupAllowlist: undefined },
      provision: async () => { throw new Error("Existing identity must not be provisioned"); },
    });
    const groupEvent: MessagingInboundMessage = {
      type: "message", provider: "fixture", handle: randomUUID(), transport: "SMS",
      from: identity.address, fromLabel: null, threadId: channel.threadId,
      isDirect: false, channelName: channel.name, participants: [identity.address],
      content: "Rejoined", mediaUrl: null,
    };
    const leaveEvent: MessagingInboundMessage = {
      ...groupEvent, handle: randomUUID(), threadId: `dm:${identity.id}`,
      isDirect: true, content: "LEAVE",
    };
    return { ...f, identity, channel, member, handle, groupEvent, leaveEvent };
  }

  async function maintenanceOwner(f: { prisma: PrismaClient; actor: Pick<Actor, "userId"> }) {
    const settings = await f.prisma.deploymentSettings.findUnique({ where: { id: "default" } });
    await f.prisma.deploymentSettings.upsert({
      where: { id: "default" }, create: { id: "default", ownerUserId: f.actor.userId },
      update: { ownerUserId: f.actor.userId },
    });
    const store = createMaintenanceStore(db.pool);
    const requestIds: string[] = [];
    return {
      store,
      async command(action: "enter" | "resume" | "force-stop") {
        const requestId = randomUUID();
        requestIds.push(requestId);
        return store.change(f.actor.userId, {
          action, requestId, expectedRevision: (await store.status()).revision,
        });
      },
      async restore() {
        await db.pool.query('DELETE FROM "maintenance_audit" WHERE "requestId" = ANY($1::text[])', [requestIds]);
        if (settings) await f.prisma.deploymentSettings.update({
          where: { id: "default" }, data: { ownerUserId: settings.ownerUserId },
        });
        else await f.prisma.deploymentSettings.delete({ where: { id: "default" } });
      },
    };
  }

  it.each([false, true])("keeps Fleet pausing when a second bridge reconciles an expired unresolved ambient judge (act: %s)", async (act) => {
    const f = await fixture();
    const { store, command, restore } = await maintenanceOwner(f);
    await f.prisma.bot.update({ where: { id: f.bot.id }, data: { teamChatAmbientEnabled: true } });
    let begin!: () => void;
    let release!: () => void;
    let providerDrained = false;
    const started = new Promise<void>((resolve) => { begin = resolve; });
    const drain = new Promise<void>((resolve) => { release = resolve; });
    const judge = { decide: vi.fn(async () => {
      begin();
      await drain;
      providerDrained = true;
      return { act };
    }) };
    const deps = {
      ...f, providerId: "slack", botId: f.bot.id, judge, send: vi.fn(),
      ambientDebounceMs: 0, reconcileIntervalMs: 60_000,
    };
    const original = new TeamChatBridge(deps);
    const replacement = new TeamChatBridge(deps);
    let running: Promise<void> | undefined;
    try {
      await original.start();
      await original.receive({
        eventId: "ambient-expired", workspaceId: f.actor.spaceId, conversationKey: "room",
        conversationId: "room", senderId: "human", senderName: "Fixture",
        content: "Keep the original judge operation", kind: "ambient",
      });
      await command("resume");
      running = original.reconcileOnce();
      await started;
      const operation = await f.prisma.externalMessage.findFirstOrThrow({
        where: { status: "judging", externalConversation: { botId: f.bot.id } },
      });
      await command("enter");
      expect((await store.statusForOperator(f.actor.userId)).status.phase).toBe("pausing");
      // Expire only the scheduling lease, not the provider or its operation identity.
      await f.prisma.externalMessage.update({
        where: { id: operation.id }, data: { nextAttemptAt: new Date(0) },
      });
      await replacement.start();
      await replacement.reconcileOnce();
      expect(providerDrained).toBe(false);
      expect((await store.statusForOperator(f.actor.userId)).status).toMatchObject({
        phase: "pausing", activeEffects: 1,
      });
      expect(await f.prisma.externalMessage.findUniqueOrThrow({ where: { id: operation.id } }))
        .toMatchObject({ status: "judging", judgedAt: operation.judgedAt, runId: null });
      expect(judge.decide).toHaveBeenCalledOnce();
      release();
      await running;
      expect(providerDrained).toBe(true);
      expect((await store.statusForOperator(f.actor.userId)).status).toMatchObject({
        phase: "paused", activeEffects: 0,
      });
      expect(await f.prisma.externalMessage.findUniqueOrThrow({ where: { id: operation.id } }))
        .toMatchObject({ status: act ? "running" : "ignored", judgedAt: operation.judgedAt });
      await replacement.reconcileOnce();
      expect(judge.decide).toHaveBeenCalledOnce();
    } finally {
      release();
      await running;
      await original.stop();
      await replacement.stop();
      await restore();
    }
  });

  it("keeps an orphaned ambient operation identifiable after connection restart, force-stop and resume", async () => {
    const f = await fixture();
    const { store, command, restore } = await maintenanceOwner(f);
    await f.prisma.bot.update({ where: { id: f.bot.id }, data: { teamChatAmbientEnabled: true } });
    const judge = { decide: vi.fn(async () => ({ act: false })) };
    const deps = {
      ...f, providerId: "slack", botId: f.bot.id, judge, send: vi.fn(),
      ambientDebounceMs: 0, reconcileIntervalMs: 60_000,
    };
    const producer = createDb(databaseUrl!);
    let producerClosed = false;
    const original = new TeamChatBridge({
      ...deps, prisma: producer.prisma, events: createThreadEvents(producer.prisma),
    });
    const reader = createDb(databaseUrl!);
    const replacement = new TeamChatBridge({
      ...deps, prisma: reader.prisma, events: createThreadEvents(reader.prisma),
    });
    try {
      await original.start();
      for (const eventId of ["orphan-first", "orphan-last"]) await original.receive({
        eventId, workspaceId: f.actor.spaceId, conversationKey: "room",
        conversationId: "room", senderId: "human", senderName: "Fixture",
        content: eventId, kind: "ambient",
      });
      const messages = await producer.prisma.externalMessage.findMany({
        where: { externalConversation: { botId: f.bot.id } }, orderBy: { createdAt: "asc" },
      });
      // Persist the exact crash boundary: claim committed, producer gone, no drain receipt.
      const operation = await producer.prisma.externalMessage.update({
        where: { id: messages.at(-1)!.id },
        data: {
          status: "judging", judgedAt: new Date("2026-01-01T00:00:00Z"), nextAttemptAt: new Date(0),
          batchContext: JSON.stringify({ messageIds: messages.map(({ id }) => id) }),
          lastError: "producer-disconnected",
        },
      });
      await original.stop();
      await producer.prisma.$disconnect();
      await producer.pool.end();
      producerClosed = true;
      await replacement.start();
      expect(await reader.prisma.externalMessage.findUniqueOrThrow({ where: { id: operation.id } })).toEqual(operation);
      expect((await store.statusForOperator(f.actor.userId)).status).toMatchObject({
        phase: "pausing", activeEffects: 1,
      });
      await command("resume");
      await replacement.reconcileOnce();
      expect(judge.decide).not.toHaveBeenCalled();
      await command("force-stop");
      expect((await createMaintenanceStore(reader.pool).statusForOperator(f.actor.userId)).status).toMatchObject({
        phase: "needs_attention", activeEffects: 1, issues: ["team-chat-cancellation-pending"],
      });
      await replacement.reconcileOnce();
      await command("resume");
      await replacement.reconcileOnce();
      expect(judge.decide).not.toHaveBeenCalled();
      expect(await reader.prisma.externalMessage.findUniqueOrThrow({ where: { id: operation.id } }))
        .toMatchObject({
          id: operation.id, status: "judging", judgedAt: operation.judgedAt,
          batchContext: operation.batchContext, nextAttemptAt: operation.nextAttemptAt,
          lastError: "maintenance-force-stop", runId: null, deliveredAt: null,
        });
      expect((await store.statusForOperator(f.actor.userId)).status).toMatchObject({
        phase: "needs_attention", activeEffects: 1,
      });
    } finally {
      await original.stop();
      await replacement.stop();
      if (!producerClosed) {
        await producer.prisma.$disconnect();
        await producer.pool.end();
      }
      await reader.prisma.$disconnect();
      await reader.pool.end();
      // Only remove this test's fixture; never invent a drain receipt to clean up.
      await f.prisma.organization.delete({ where: { id: f.actor.spaceId } });
      await restore();
    }
  });

  it.each(["pause", "force-before-expiry", "force-after-expiry"] as const)(
    "retains the ambient batch across resume and bridge restart until provider drain (%s)",
    async (mode) => {
      const f = await fixture();
      const { store, command, restore } = await maintenanceOwner(f);
      await f.prisma.bot.update({ where: { id: f.bot.id }, data: { teamChatAmbientEnabled: true } });
      let begin!: () => void;
      let release!: () => void;
      let interrupted!: () => void;
      let providerDrained = false;
      let providerCalls = 0;
      const started = new Promise<void>((resolve) => { begin = resolve; });
      const drain = new Promise<void>((resolve) => { release = resolve; });
      const aborted = new Promise<void>((resolve) => { interrupted = resolve; });
      const judge = { decide: vi.fn(async ({ signal }: { signal?: AbortSignal }) => {
        // A regression must fail the call-count assertion, not block on a second drain gate.
        if (++providerCalls > 1) return { act: false };
        signal!.addEventListener("abort", interrupted, { once: true });
        begin();
        await drain;
        providerDrained = true;
        return { act: false };
      }) };
      const deps = {
        ...f, providerId: "slack", botId: f.bot.id, judge, send: vi.fn(),
        ambientDebounceMs: 0, reconcileIntervalMs: 60_000,
      };
      const original = new TeamChatBridge(deps);
      // A fresh persistence connection/bridge has no access to the producer's local state.
      let reader = createDb(databaseUrl!);
      let replacement = new TeamChatBridge({
        ...deps, prisma: reader.prisma, events: createThreadEvents(reader.prisma),
      });
      let running: Promise<void> | undefined;
      try {
        await original.start();
        for (const eventId of ["batch-first", "batch-last"]) await original.receive({
          eventId, workspaceId: f.actor.spaceId, conversationKey: "room",
          conversationId: "room", senderId: "human", senderName: "Fixture",
          content: eventId, kind: "ambient",
        });
        await command("resume");
        running = original.reconcileOnce();
        await started;
        const operation = await f.prisma.externalMessage.findFirstOrThrow({
          where: { status: "judging", externalConversation: { botId: f.bot.id } },
        });
        await command("enter");
        if (mode === "force-before-expiry") await command("force-stop");
        await f.prisma.externalMessage.update({
          where: { id: operation.id },
          data: { nextAttemptAt: new Date(0), ...(mode === "pause" ? { lastError: "preserved-diagnostic" } : {}) },
        });
        await replacement.start();
        if (mode === "force-after-expiry") await command("force-stop");
        if (mode !== "pause") await aborted;
        expect(providerDrained).toBe(false);
        expect((await store.statusForOperator(f.actor.userId)).status).toMatchObject({
          phase: mode === "pause" ? "pausing" : "needs_attention", activeEffects: 1,
        });
        expect(await reader.prisma.externalMessage.findUniqueOrThrow({ where: { id: operation.id } }))
          .toMatchObject({
            status: "judging", judgedAt: operation.judgedAt, nextAttemptAt: new Date(0),
            lastError: mode === "pause" ? "preserved-diagnostic" : "maintenance-force-stop",
          });
        const batch = await reader.prisma.externalMessage.findMany({
          where: { externalConversationId: operation.externalConversationId },
          orderBy: { createdAt: "asc" },
        });
        expect(JSON.parse(operation.batchContext!)).toEqual({ messageIds: batch.map(({ id }) => id) });
        await command("resume");
        await replacement.reconcileOnce();
        expect(judge.decide).toHaveBeenCalledOnce();
        await replacement.stop();
        await reader.prisma.$disconnect();
        await reader.pool.end();
        reader = createDb(databaseUrl!);
        replacement = new TeamChatBridge({
          ...deps, prisma: reader.prisma, events: createThreadEvents(reader.prisma),
        });
        await replacement.start();
        expect(judge.decide).toHaveBeenCalledOnce();
        expect((await createMaintenanceStore(reader.pool).statusForOperator(f.actor.userId)).status.activeEffects).toBe(1);
        await command("enter");
        release();
        await running;
        expect(providerDrained).toBe(true);
        expect(await reader.prisma.externalMessage.findUniqueOrThrow({ where: { id: operation.id } }))
          .toMatchObject({
            status: mode === "pause" ? "ignored" : "cancelled", judgedAt: operation.judgedAt,
            nextAttemptAt: null, runId: null,
            lastError: mode === "pause" ? "preserved-diagnostic" : "maintenance-force-stop",
          });
        expect((await store.statusForOperator(f.actor.userId)).status).toMatchObject({
          phase: "paused", activeEffects: 0,
        });
        expect(await reader.prisma.externalMessage.count({
          where: { externalConversation: { botId: f.bot.id }, status: mode === "pause" ? "ignored" : "cancelled" },
        })).toBe(2);
        await command("resume");
        await replacement.reconcileOnce();
        expect(judge.decide).toHaveBeenCalledOnce();
      } finally {
        release();
        await running;
        await original.stop();
        await replacement.stop();
        await reader.prisma.$disconnect();
        await reader.pool.end();
        await restore();
      }
    },
    15_000,
  );

  it.each(["sent", "executing", "uncertain"])(
    "refreshes a settled invite without replacing a %s delivery still needing reconciliation",
    async (status) => {
      const f = await messagingFixture();
      await f.handle(f.groupEvent);
      const key = `invite:${f.channel.id}:${f.identity.id}`;
      const first = await f.prisma.messagingOutbound.update({
        where: { idempotencyKey: key }, data: { status, providerHandle: "original-delivery" },
      });
      await f.prisma.messagingChannelMember.update({ where: { id: f.member.id }, data: { status: "approved" } });
      await f.handle(f.leaveEvent);
      await f.handle({ ...f.groupEvent, handle: randomUUID() });
      expect(await f.prisma.messagingChannelMember.findUniqueOrThrow({ where: { id: f.member.id } }))
        .toMatchObject({ status: "invited" });
      const current = await f.prisma.messagingOutbound.findUniqueOrThrow({ where: { idempotencyKey: key } });
      if (status === "sent") {
        expect(current.id).not.toBe(first.id);
        expect(current).toMatchObject({ status: "pending", identityId: f.identity.id, body: first.body });
      } else {
        expect(current).toEqual(first);
      }
      expect(await f.prisma.messagingOutbound.count({ where: { idempotencyKey: key } })).toBe(1);
      expect(await f.prisma.run.count({ where: { threadId: f.thread.id } })).toBe(0);
    },
  );

  it.each(["sent", "executing", "uncertain"])(
    "repeats LEAVE without losing a %s confirmation's delivery identity",
    async (status) => {
      const f = await messagingFixture();
      await f.prisma.messagingChannelMember.update({ where: { id: f.member.id }, data: { status: "approved" } });
      await f.handle(f.leaveEvent);
      const key = `command:leave:${f.member.id}`;
      const first = await f.prisma.messagingOutbound.update({
        where: { idempotencyKey: key }, data: { status, providerHandle: "original-delivery" },
      });
      await f.prisma.messagingChannelMember.update({ where: { id: f.member.id }, data: { status: "approved" } });
      await f.handle({ ...f.leaveEvent, handle: randomUUID() });
      expect(await f.prisma.messagingChannelMember.findUniqueOrThrow({ where: { id: f.member.id } }))
        .toMatchObject({ status: "left" });
      const current = await f.prisma.messagingOutbound.findUniqueOrThrow({ where: { idempotencyKey: key } });
      if (status === "sent") {
        expect(current.id).not.toBe(first.id);
        expect(current).toMatchObject({ status: "pending", identityId: f.identity.id, body: first.body });
      } else {
        expect(current).toEqual(first);
      }
      expect(await f.prisma.messagingOutbound.count({ where: { idempotencyKey: key } })).toBe(1);
      expect(await f.prisma.run.count({ where: { threadId: f.thread.id } })).toBe(0);
    },
  );

  it.each(["cancelled", "completed", "maintenance_paused"])(
    "exposes only resumable work in the thread snapshot (%s)",
    async (status) => {
      const f = await fixture();
      const target = await resolveThreadTarget(f.prisma, f.actor, { botId: f.bot.id });
      const sent = await sendThreadMessage(f, f.actor, target, { text: "Original request" });
      await f.prisma.run.update({ where: { id: sent.runId! }, data: { status } });
      const snapshot = await threadSnapshot(f, target);
      if (status === "maintenance_paused") {
        expect(snapshot.run).toMatchObject({ id: sent.runId, status });
        expect(snapshot.activeRuns?.map((run) => run.id)).toEqual([sent.runId]);
      } else {
        expect(snapshot.run).toBeNull();
        expect(snapshot.activeRuns).toEqual([]);
      }
    },
  );

  it.each(["stop", "clear"])("preserves unconfirmed runtime and effect evidence after human %s", async (action) => {
    const f = await fixture();
    const target = await resolveThreadTarget(f.prisma, f.actor, { botId: f.bot.id });
    const sent = await sendThreadMessage(f, f.actor, target, { text: "Still running remotely" });
    const runId = sent.runId!;
    await f.prisma.run.update({ where: { id: runId }, data: {
      status: "running", leaseOwner: "remote-worker", leaseFence: 3, leaseExpiresAt: new Date(0),
    } });
    const attempt = await f.prisma.attempt.create({ data: { runId, fence: 3, status: "running" } });
    const effect = await f.prisma.externalEffect.create({ data: {
      runId, spaceId: f.actor.spaceId, kind: "send_message", status: "uncertain",
      idempotencyKey: randomUUID(), request: { body: "Remote outcome unknown" },
    } });
    if (action === "stop") {
      await stopThreadRuns({ ...f, sandbox: new FakeSandboxProvider() }, f.actor, target);
    } else {
      await f.events.clearThread({ spaceId: f.actor.spaceId, threadId: f.thread.id, botId: f.bot.id });
    }
    expect((await f.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe("cancelled");
    expect(await f.prisma.attempt.findUniqueOrThrow({ where: { id: attempt.id } }))
      .toMatchObject({ status: "running", finishedAt: null });
    expect(await f.prisma.externalEffect.findUniqueOrThrow({ where: { id: effect.id } }))
      .toMatchObject({ status: "uncertain", request: effect.request });
  });

  it.each(["user", "messaging", "webhook"] as const)(
    "retains idle %s input and its idempotent queued identity while paused",
    async (trigger) => {
      const f = await fixture();
      const input = {
        spaceId: f.actor.spaceId, userId: f.actor.userId, botId: f.bot.id, threadId: f.thread.id,
        trigger, clientNonce: "same-delivery", prompt: "Keep this request",
        blocks: [{ kind: "text" as const, text: "Keep this request" }],
      };
      const sent = await sendUserMessage(f.prisma, input);
      expect(await sendUserMessage(f.prisma, input)).toEqual(sent);
      expect(await f.prisma.run.findUniqueOrThrow({ where: { id: sent.runId! } })).toMatchObject({
        status: "queued", sourceMessageId: sent.messageId, trigger,
      });
      expect(await f.prisma.message.count({ where: { threadId: f.thread.id } })).toBe(1);
      expect(await f.prisma.attempt.count({ where: { runId: sent.runId! } })).toBe(0);
    },
  );

  it("preserves busy direct messages in order without admitting steering until resume", async () => {
    const f = await fixture();
    const target = await resolveThreadTarget(f.prisma, f.actor, { botId: f.bot.id });
    const first = await sendThreadMessage(f, f.actor, target, { text: "First", clientNonce: "first" });
    const runId = first.runId!;
    await f.prisma.run.update({ where: { id: runId }, data: { status: "running", leaseOwner: "worker", leaseFence: 1 } });
    for (const text of ["Second", "Third"]) {
      await sendThreadMessage(f, f.actor, target, { text, clientNonce: text });
    }
    const claim = { threadId: f.thread.id, botId: f.bot.id, runId, leaseOwner: "worker", leaseFence: 1, seenIds: [] };
    expect(await claimSteering(f.prisma, claim)).toEqual([]);
    expect(await f.prisma.steeringMessage.count({ where: { runId, claimedAt: null } })).toBe(2);
    await f.prisma.maintenanceState.update({ where: { id: "default" }, data: { active: false } });
    const claimed = await claimSteering(f.prisma, claim);
    expect(claimed.map((message) => message.text)).toEqual(["Second", "Third"]);
    expect(await claimSteering(f.prisma, { ...claim, seenIds: claimed.map((message) => message.id) })).toEqual([]);
  });

  it("keeps group mentions behind the same checkpointed run instead of creating an escape run", async () => {
    const f = await fixture();
    const peer = await f.prisma.bot.create({ data: { spaceId: f.actor.spaceId, userId: f.actor.userId, name: "Peer", color: "test" } });
    const group = await createGroupRepos(f.prisma).createGroup(f.actor, { name: "Room", botIds: [f.bot.id, peer.id] });
    const target = await resolveThreadTarget(f.prisma, f.actor, { groupId: group.id });
    const first = await sendThreadMessage(f, f.actor, target, { text: "Please inspect", mentions: [f.bot.id], clientNonce: "first" });
    await f.prisma.run.update({ where: { id: first.runId! }, data: { status: "maintenance_paused", maintenanceCheckpoint: "exact-checkpoint" } });
    const second = await sendThreadMessage(f, f.actor, target, { text: "Keep this context", mentions: [f.bot.id], clientNonce: "second" });
    expect(second.runId).toBe(first.runId);
    expect(await f.prisma.run.count({ where: { threadId: target.threadId } })).toBe(1);
    expect(await f.prisma.steeringMessage.count({ where: { botId: f.bot.id, claimedAt: null } })).toBe(1);
    expect(await sendThreadMessage(f, f.actor, target, { text: "Keep this context", mentions: [f.bot.id], clientNonce: "second" })).toEqual(second);
  });

  it("persists structured webhook authority candidates beside the original queued request", async () => {
    const f = await fixture();
    const payload = { source: "fleet-gate", event: "case.ready", items: [{ n: 42 }] };
    const sent = await deliverWebhookEvent(f, { bot: f.bot, threadId: f.thread.id }, {
      prompt: "Untrusted event text", routines: [], source: "webhook", payload, idempotencyKey: "wake-42",
    });
    const event = await f.prisma.event.findFirstOrThrow({
      where: { threadId: f.thread.id, type: "thread.message.created" }, orderBy: { seq: "asc" },
    });
    expect(event.payload).toMatchObject({ messageId: sent.messageId, inboundDelivery: { source: "webhook", payload } });
    expect(await f.prisma.run.findUniqueOrThrow({ where: { id: sent.runId! } })).toMatchObject({ status: "queued", sourceMessageId: sent.messageId });
  });

  it("keeps each held webhook's source identity and order through paused intake", async () => {
    const f = await fixture();
    const target = await resolveThreadTarget(f.prisma, f.actor, { botId: f.bot.id });
    const first = await sendThreadMessage(f, f.actor, target, { text: "Existing work" });
    await f.prisma.run.update({ where: { id: first.runId! }, data: { status: "maintenance_paused", maintenanceCheckpoint: "exact-checkpoint" } });
    const messages: string[] = [];
    for (const n of [41, 42]) {
      const input = {
        prompt: `Case ${n}`, routines: [], source: "webhook" as const,
        payload: { source: "fleet-gate", items: [{ n }] }, idempotencyKey: `case-${n}`,
      };
      const sent = await deliverWebhookEvent(f, { bot: f.bot, threadId: f.thread.id }, input);
      messages.push(sent.messageId);
      expect((await deliverWebhookEvent(f, { bot: f.bot, threadId: f.thread.id }, input)).messageId).toBe(sent.messageId);
    }
    expect(await f.prisma.steeringMessage.count({ where: { botId: f.bot.id, claimedAt: null } })).toBe(2);
    await f.prisma.run.update({ where: { id: first.runId! }, data: { status: "completed" } });
    for (const messageId of messages) {
      const runId = await f.prisma.$transaction((tx) => createPendingSteeringRun(tx, {
        spaceId: f.actor.spaceId, threadId: f.thread.id, botId: f.bot.id,
      }));
      expect(await f.prisma.run.findUniqueOrThrow({ where: { id: runId! } })).toMatchObject({
        sourceMessageId: messageId, trigger: "webhook", status: "queued",
      });
      expect(await f.prisma.steeringMessage.count({ where: { runId } })).toBe(1);
      await f.prisma.run.update({ where: { id: runId! }, data: { status: "completed" } });
    }
  });

  it("lets a human clear a paused run without leaving a resumable checkpoint behind", async () => {
    const f = await fixture();
    const target = await resolveThreadTarget(f.prisma, f.actor, { botId: f.bot.id });
    const sent = await sendThreadMessage(f, f.actor, target, { text: "Old request" });
    await f.prisma.run.update({ where: { id: sent.runId! }, data: { status: "maintenance_paused", maintenanceCheckpoint: "exact-checkpoint" } });
    const cleared = await f.events.clearThread({ spaceId: f.actor.spaceId, threadId: f.thread.id, botId: f.bot.id });
    expect(cleared.cancelledRunIds).toEqual([sent.runId]);
    expect(await f.prisma.run.findUniqueOrThrow({ where: { id: sent.runId! } })).toMatchObject({ status: "cancelled" });
    expect((await f.prisma.maintenanceState.findUniqueOrThrow({ where: { id: "default" } })).active).toBe(true);
  });

  it("retains ambient room inputs without a model call, then resumes their original identity", async () => {
    const f = await fixture();
    await f.prisma.bot.update({ where: { id: f.bot.id }, data: { teamChatAmbientEnabled: true } });
    const judge = { decide: vi.fn().mockResolvedValueOnce(null).mockResolvedValue({ act: true, reason: "Requested action" }) };
    const bridge = new TeamChatBridge({
      ...f, providerId: "slack", botId: f.bot.id, judge, send: vi.fn(),
      ambientDebounceMs: 0, reconcileIntervalMs: 60_000,
    });
    await bridge.start();
    try {
      await bridge.receive({
        eventId: "ambient-1", workspaceId: f.actor.spaceId, conversationKey: "room",
        conversationId: "room", senderId: "human", senderName: "Fixture",
        content: "Please inspect the case", kind: "ambient",
      });
      await bridge.reconcileOnce();
      expect(judge.decide).not.toHaveBeenCalled();
      const original = await f.prisma.externalMessage.findFirstOrThrow({
        where: { externalConversation: { botId: f.bot.id } },
      });
      expect(original.status).toBe("observed");
      await f.prisma.maintenanceState.update({ where: { id: "default" }, data: { active: false } });
      await bridge.reconcileOnce();
      expect(judge.decide).toHaveBeenCalledOnce();
      expect(await f.prisma.externalMessage.findUniqueOrThrow({ where: { id: original.id } })).toMatchObject({
        status: "observed", runId: null, providerEventId: "ambient-1",
      });
      await bridge.reconcileOnce();
      expect(judge.decide).toHaveBeenCalledTimes(2);
      const resumed = await f.prisma.externalMessage.findUniqueOrThrow({ where: { id: original.id } });
      expect(resumed).toMatchObject({ status: "running", providerEventId: "ambient-1" });
      expect(resumed.runId).not.toBeNull();
      await bridge.reconcileOnce();
      expect(judge.decide).toHaveBeenCalledTimes(2);
    } finally {
      await bridge.stop();
    }
  });

  it("acknowledges ambient force-stop only after drain and never retries an orphaned cancellation", async () => {
    const f = await fixture();
    await f.prisma.bot.update({ where: { id: f.bot.id }, data: { teamChatAmbientEnabled: true } });
    let begin!: () => void;
    let interrupted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { begin = resolve; });
    const aborted = new Promise<void>((resolve) => { interrupted = resolve; });
    const drained = new Promise<void>((resolve) => { release = resolve; });
    const judge = { decide: vi.fn(async ({ signal }: { signal?: AbortSignal }) => {
      begin();
      signal!.addEventListener("abort", interrupted, { once: true });
      await aborted;
      await drained;
      return { act: true };
    }) };
    const deps = {
      ...f, providerId: "slack", botId: f.bot.id, judge, send: vi.fn(),
      ambientDebounceMs: 0, reconcileIntervalMs: 60_000,
    };
    let bridge = new TeamChatBridge(deps);
    await bridge.start();
    try {
      await bridge.receive({
        eventId: "ambient-force", workspaceId: f.actor.spaceId, conversationKey: "room",
        conversationId: "room", senderId: "human", senderName: "Fixture",
        content: "Preserved request", kind: "ambient",
      });
      await f.prisma.maintenanceState.update({ where: { id: "default" }, data: { active: false } });
      const running = bridge.reconcileOnce();
      await started;
      const input = await f.prisma.externalMessage.findFirstOrThrow({
        where: { status: "judging", externalConversation: { botId: f.bot.id } },
      });
      await f.prisma.externalMessage.update({
        where: { id: input.id }, data: { lastError: "maintenance-force-stop" },
      });
      await aborted;
      expect((await f.prisma.externalMessage.findUniqueOrThrow({ where: { id: input.id } })).status).toBe("judging");
      release();
      await running;
      expect(await f.prisma.externalMessage.findUniqueOrThrow({ where: { id: input.id } })).toMatchObject({
        status: "cancelled", runId: null, lastError: "maintenance-force-stop", content: "Preserved request",
      });
      await bridge.stop();
      // Simulate the durable marker of a worker that died before acknowledging drain.
      await f.prisma.externalMessage.update({
        where: { id: input.id }, data: { status: "judging", nextAttemptAt: new Date(0) },
      });
      bridge = new TeamChatBridge(deps);
      await bridge.start();
      expect(judge.decide).toHaveBeenCalledOnce();
      expect((await f.prisma.externalMessage.findUniqueOrThrow({ where: { id: input.id } })).status).toBe("judging");
    } finally {
      release();
      await bridge.stop();
    }
  }, 15_000);

  it.each(["confirmed", "unknown"] as const)("fences a room reply and preserves its %s outcome across restart", async (outcome) => {
    const f = await fixture();
    const send = vi.fn(async () => {
      if (outcome === "unknown") throw new Error("Provider acknowledgement lost");
      return { handle: "provider-confirmed" };
    });
    const deps = { ...f, providerId: "slack", botId: f.bot.id, send, reconcileIntervalMs: 60_000 };
    let bridge = new TeamChatBridge(deps);
    await bridge.start();
    try {
      await bridge.receive({
        eventId: "mention-1", workspaceId: f.actor.spaceId, conversationKey: "room",
        conversationId: "room", senderId: "human", senderName: "Fixture",
        content: "Please reply", kind: "mention",
      });
      const inbound = await f.prisma.externalMessage.findFirstOrThrow({
        where: { externalConversation: { botId: f.bot.id }, providerEventId: "mention-1" },
        include: { run: true },
      });
      expect(inbound.run).not.toBeNull();
      await createThreadMessage(f.prisma, {
        threadId: inbound.run!.threadId, runId: inbound.runId!, botId: f.bot.id,
        role: "bot", blocks: [{ kind: "text", text: "Preserved reply" }],
      });
      await f.prisma.run.update({ where: { id: inbound.runId! }, data: { status: "completed" } });
      await bridge.reconcileOnce();
      expect(send).not.toHaveBeenCalled();
      await f.prisma.maintenanceState.update({ where: { id: "default" }, data: { active: false } });
      await bridge.reconcileOnce();
      expect(send).toHaveBeenCalledOnce();
      const delivery = await f.prisma.externalMessage.findUniqueOrThrow({ where: { id: inbound.id } });
      expect(delivery.status).toBe(outcome === "confirmed" ? "delivered" : "uncertain");
      if (outcome === "unknown") expect(delivery.deliveredAt).toBeNull();
      await bridge.stop();
      bridge = new TeamChatBridge(deps);
      await bridge.start();
      await bridge.reconcileOnce();
      expect(send).toHaveBeenCalledOnce();
    } finally {
      await bridge.stop();
    }
  });

  it.each(["allow", "deny"] as const)("retains the exact %s approval while execution is paused", async (answer) => {
    const f = await fixture();
    const prompt = "Send the exact approved body.\nOriginal Ω";
    const task = await f.prisma.task.create({ data: {
      spaceId: f.actor.spaceId, userId: f.actor.userId, botId: f.bot.id,
      threadId: f.thread.id, prompt, status: "waiting_input",
    } });
    const run = await f.prisma.run.create({ data: {
      spaceId: f.actor.spaceId, userId: f.actor.userId, botId: f.bot.id,
      threadId: f.thread.id, taskId: task.id, status: "waiting_input", trigger: "user",
    } });
    const request = { recipient: "fixture@example.test", body: "Exact body\nΩ", attachments: ["artifact-original"] };
    const effect = await f.prisma.externalEffect.create({ data: {
      spaceId: f.actor.spaceId, runId: run.id, kind: "send_message",
      idempotencyKey: randomUUID(), status: "intended", request,
    } });
    const card = await createThreadMessage(f.prisma, {
      threadId: f.thread.id, botId: f.bot.id, runId: run.id, role: "bot",
      blocks: [{
        kind: "ask", text: "Send it?", status: "pending", approvalEffectId: effect.id,
        actions: [{ id: "allow", label: "Allow" }, { id: "deny", label: "Deny" }],
      }],
    });
    const input = {
      spaceId: f.actor.spaceId, threadId: f.thread.id, runId: run.id,
      messageId: card.id, answeredByUserId: f.actor.userId, answer,
    };
    expect(await f.events.answerRunInput(input)).toBe(true);
    expect(await f.events.answerRunInput(input)).toBe(false);
    expect(await f.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "queued", taskId: task.id, maintenanceCheckpoint: null,
    });
    expect((await f.prisma.task.findUniqueOrThrow({ where: { id: task.id } })).prompt).toBe(prompt);
    expect(await f.prisma.externalEffect.findUniqueOrThrow({ where: { id: effect.id } })).toMatchObject({
      request, idempotencyKey: effect.idempotencyKey, status: answer === "allow" ? "approved" : "denied",
    });
    const answeredCard = await f.prisma.message.findUniqueOrThrow({ where: { id: card.id } });
    expect(answeredCard.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "ask", status: "answered", answer, approvalEffectId: effect.id }),
    ]));
    expect(await f.prisma.$transaction((tx) => claimMaintenanceEffect(tx, effect.id, "approved"))).toBe(false);
    expect(await f.prisma.attempt.count({ where: { runId: run.id } })).toBe(0);
    await f.prisma.maintenanceState.update({ where: { id: "default" }, data: { active: false } });
    expect(await f.prisma.$transaction((tx) => claimMaintenanceEffect(tx, effect.id, "approved"))).toBe(answer === "allow");
    expect(await f.prisma.$transaction((tx) => claimMaintenanceEffect(tx, effect.id, "approved"))).toBe(false);
    expect((await f.prisma.externalEffect.findUniqueOrThrow({ where: { id: effect.id } })).request).toEqual(request);
  });

  it.each(["deny", "obsolete", "replaced"] as const)("records human decisions but never resurrects a %s approval", async (decision) => {
    const f = await fixture();
    const task = await f.prisma.task.create({ data: { spaceId: f.actor.spaceId, userId: f.actor.userId, botId: f.bot.id, threadId: f.thread.id, prompt: "Send once", status: "waiting_input" } });
    const run = await f.prisma.run.create({ data: { spaceId: f.actor.spaceId, userId: f.actor.userId, botId: f.bot.id, threadId: f.thread.id, taskId: task.id, status: "waiting_input", trigger: "user" } });
    const effect = await f.prisma.externalEffect.create({ data: {
      spaceId: f.actor.spaceId, runId: run.id, kind: "send_message", idempotencyKey: randomUUID(),
      status: decision === "obsolete" ? "denied" : "intended", request: { body: "Original request" },
    } });
    const card = await createThreadMessage(f.prisma, { threadId: f.thread.id, botId: f.bot.id, runId: run.id, role: "bot", blocks: [{
      kind: "ask", text: "Send it?", status: "pending", approvalEffectId: effect.id,
      actions: [{ id: "allow", label: "Allow" }, { id: "deny", label: "Deny" }],
    }] });
    if (decision === "replaced") await createThreadMessage(f.prisma, {
      threadId: f.thread.id, botId: f.bot.id, runId: run.id, role: "bot",
      blocks: [{
        kind: "ask", text: "Updated decision", status: "pending", approvalEffectId: effect.id,
        actions: [{ id: "allow", label: "Allow" }, { id: "deny", label: "Deny" }],
      }],
    });
    const answer = { spaceId: f.actor.spaceId, threadId: f.thread.id, runId: run.id, messageId: card.id, answeredByUserId: f.actor.userId, answer: decision === "deny" ? "deny" : "allow" };
    expect(await f.events.answerRunInput(answer)).toBe(decision === "deny");
    expect(await f.events.answerRunInput({ ...answer, answer: "allow" })).toBe(false);
    await f.prisma.maintenanceState.update({ where: { id: "default" }, data: { active: false } });
    expect(await f.prisma.$transaction((tx) => claimMaintenanceEffect(tx, effect.id, "approved"))).toBe(false);
    expect(await f.prisma.externalEffect.findUniqueOrThrow({ where: { id: effect.id } })).toMatchObject({
      status: decision === "replaced" ? "intended" : "denied",
    });
  });
});
