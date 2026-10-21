import { readFileSync } from "node:fs";
import type { ConnectorEvent, ConnectorProvider } from "@rakazo/adapter-kit";
import { ConnectorRegistry, DestinationEmulator } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { createDb, type Prisma, type PrismaClient } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { boundDirectApprovalRequest } from "../../../packages/adapters/src/approval-effect.js";
import { reviewApproval } from "./approval-review.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe.sequential : describe.skip;

describePostgres("saved reply review (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `reply-review-owner-${suffix}`;
  const organizationId = `reply-review-org-${suffix}`;
  const spaceId = `reply-review-space-${suffix}`;
  const actor: Actor = {
    userId,
    spaceId,
    email: `${userId}@rakazo.test`,
    isDeploymentOwner: true,
  };
  const reply = "The complete proposed reply.\nFINAL Ω";
  /** The Fleet's pinned zd_reply_context result (tests/fixtures in the Fleet repo). */
  const fleet = JSON.parse(
    readFileSync(new URL("./fixtures/zd_reply_context.json", import.meta.url), "utf8"),
  ) as { zd_reply_context: { structuredContent: { inquiry: string } } };
  const source: ConnectorProvider = {
    describe: () => ({
      id: "mcp",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { discover: true, oauth: false, secretsBrokered: false },
    }),
    async discoverTools() {
      return [];
    },
    async *execute(): AsyncGenerator<ConnectorEvent> {
      yield {
        type: "result",
        data: {
          isError: false,
          structuredContent: fleet.zd_reply_context.structuredContent,
        },
      };
    },
  };
  const connectors = new ConnectorRegistry(new DestinationEmulator(), [source]);
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let effectId: string;
  let serverId: string;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.user.create({
      data: { id: userId, name: "Owner", email: actor.email, emailVerified: false },
    });
    await prisma.organization.create({
      data: { id: organizationId, name: "Review", slug: organizationId, createdAt: new Date() },
    });
    await prisma.space.create({
      data: { id: spaceId, organizationId, name: "General", isDefault: true },
    });
    const bot = await prisma.bot.create({
      data: { userId, spaceId, name: "Support", color: "blue" },
    });
    const thread = await prisma.thread.create({ data: { userId, spaceId, botId: bot.id } });
    // The reply card Rens approved, for the version the Fleet still reports as newest.
    await prisma.message.create({
      data: {
        threadId: thread.id,
        seq: 1,
        role: "bot",
        botId: bot.id,
        blocks: [
          {
            kind: "ask",
            text: "Case 7 · Reply to Customer A (ZD #3529)",
            status: "answered",
            answer: "choice-1",
            draft: reply,
            source: { ref: "zendesk:3529", version: "98123" },
          },
        ],
      },
    });
    const task = await prisma.task.create({
      data: {
        userId,
        spaceId,
        botId: bot.id,
        threadId: thread.id,
        prompt: "Review",
        status: "pending",
      },
    });
    const run = await prisma.run.create({
      data: {
        userId,
        spaceId,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        status: "waiting_input",
        trigger: "user",
      },
    });
    const server = await prisma.mcpServer.create({
      data: { userId, spaceId, slug: "support", name: "Support", transport: "streamable_http" },
    });
    serverId = server.id;
    await prisma.botMcpServer.create({ data: { userId, spaceId, botId: bot.id, serverId } });
    const effect = await prisma.externalEffect.create({
      data: {
        spaceId,
        runId: run.id,
        kind: "mcp__support__zd_reply",
        idempotencyKey: `reply-${suffix}`,
        status: "awaiting_approval",
        request: boundDirectApprovalRequest(
          { connectorId: "mcp", resourceId: serverId, resourceRevision: 1, toolName: "zd_reply" },
          { ticket: 3529, body: reply, status: "pending" },
          "__rakazoCatalogTool",
        ) as Prisma.InputJsonValue,
      },
    });
    effectId = effect.id;
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await close();
  });

  it("shows the original account's full inquiry and the approved card's version to a full authenticated actor, but not after reauthorization", async () => {
    const deps = { prisma, connectors };
    expect(await reviewApproval(deps, actor, effectId)).toMatchObject({
      proposedReply: reply,
      cardVersion: "98123",
      customerContext: {
        status: "available",
        stale: false,
        source: { ref: "zendesk:3529", version: "98123" },
        inquiry: fleet.zd_reply_context.structuredContent.inquiry,
      },
    });
    await prisma.mcpServer.update({ where: { id: serverId }, data: { revision: 2 } });
    expect(await reviewApproval(deps, actor, effectId)).toMatchObject({
      proposedReply: reply,
      customerContext: { status: "unavailable" },
    });
  });
});
