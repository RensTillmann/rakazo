import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { RPCHandler } from "@orpc/server/fetch";
import type { AgentRunRequest, ArtifactStore, JobPublisher } from "@rakazo/adapter-kit";
import {
  createRunExecutor,
  EncryptedSecretStore,
  FakeBrowserProvider,
  FakeSandboxProvider,
  LocalAgentHomeStore,
  ScriptedAgentRuntime,
} from "@rakazo/adapters";
import type { Actor, MessageBlock } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createDb, createThreadEvents, createThreadMessage } from "@rakazo/db";
import { MarkdownMemoryStore } from "@rakazo/memory";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const describePostgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL
    ? describe.sequential
    : describe.skip;

const QUESTION: MessageBlock = { kind: "ask", text: "Which invoice do you mean?" };
const FILE_BYTES = Buffer.from("invoice 42: 120 EUR");

describePostgres("answering a question card with files (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let closePool: () => Promise<void>;
  let dataDir: string;
  const organizations: string[] = [];

  beforeAll(async () => {
    const db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    closePool = () => db.pool.end();
    dataDir = await mkdtemp(join(process.cwd(), ".answer-attachments-test-"));
    await prisma.deploymentSettings.upsert({
      where: { id: "default" },
      create: {
        id: "default",
        defaultModelProvider: "openrouter",
        defaultModelId: "openai/gpt-4o",
      },
      update: { defaultModelProvider: "openrouter", defaultModelId: "openai/gpt-4o" },
    });
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.organization.deleteMany({ where: { id: { in: organizations } } });
      await prisma.user.deleteMany({ where: { id: { in: organizations } } });
      await prisma.$disconnect();
      await closePool();
    }
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  async function setup(card: MessageBlock = QUESTION) {
    const id = randomUUID();
    organizations.push(id);
    await prisma.user.create({
      data: { id, name: "Answer fixture", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "Answer fixture", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id, organizationId: id, name: "Fixture" } });
    const computer = await prisma.computer.create({
      data: { spaceId: id, userId: id, scopeKey: id, homeKey: id, kind: "fake", state: "running" },
    });
    const bot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Fixture", color: "test", computerId: computer.id },
    });
    const thread = await prisma.thread.create({ data: { spaceId: id, userId: id, botId: bot.id } });
    const source = await createThreadMessage(prisma, {
      threadId: thread.id,
      role: "user",
      blocks: [{ kind: "text", text: "Check my invoice." }],
    });
    const task = await prisma.task.create({
      data: {
        spaceId: id,
        userId: id,
        botId: bot.id,
        threadId: thread.id,
        prompt: "Check my invoice.",
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
        sourceMessageId: source.id,
        leaseOwner: "fixture-worker",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    await prisma.message.update({ where: { id: source.id }, data: { runId: run.id } });
    const attempt = await prisma.attempt.create({
      data: { runId: run.id, fence: 1, status: "running" },
    });
    const events = createThreadEvents(prisma);
    expect(
      await events.pauseRunForInput({
        spaceId: id,
        threadId: thread.id,
        botId: bot.id,
        runId: run.id,
        attemptId: attempt.id,
        leaseOwner: "fixture-worker",
        leaseFence: 1,
        blocks: [card],
      }),
    ).toBe(true);
    const cardMessage = await prisma.message.findFirstOrThrow({
      where: { runId: run.id, role: "bot" },
    });
    const artifact = await prisma.artifact.create({
      data: {
        spaceId: id,
        botId: bot.id,
        userId: id,
        name: "invoice.txt",
        mimeType: "text/plain",
        size: FILE_BYTES.byteLength,
        hash: "fixture",
        storageKey: `fixture/${id}/invoice.txt`,
      },
    });
    // Another person's upload in the same space: a send refuses it, so the answer must too.
    const foreignArtifact = await prisma.artifact.create({
      data: {
        spaceId: id,
        botId: bot.id,
        userId: `${id}-other`,
        name: "secret.txt",
        mimeType: "text/plain",
        size: 3,
        hash: "fixture",
        storageKey: `fixture/${id}/secret.txt`,
      },
    });
    const actor: Actor = {
      spaceId: id,
      userId: id,
      email: `${id}@example.test`,
      isDeploymentOwner: false,
    };
    const sandbox = new FakeSandboxProvider();
    const ref = await sandbox.provision(
      { botId: computer.id, homePath: dataDir },
      {
        ...actor,
        operationId: "fixture",
        traceId: "fixture",
        signal: new AbortController().signal,
      },
    );
    await prisma.computer.update({ where: { id: computer.id }, data: { providerRef: ref.id } });
    const enqueue = vi.fn<JobPublisher["enqueue"]>(async () => undefined);
    const jobs: JobPublisher = {
      enqueue,
      cancel: vi.fn(async () => undefined),
      close: async () => undefined,
    };
    const deps = { prisma, events, jobs, sandbox, env: { agentRuntime: "scripted" } };
    const handler = new RPCHandler(createRouter(deps as unknown as RouterDeps));
    const answer = async (input: Record<string, unknown>) => {
      const { response } = await handler.handle(
        new Request("http://127.0.0.1/rpc/threads/answer", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            json: { botId: bot.id, runId: run.id, messageId: cardMessage.id, ...input },
          }),
        }),
        { prefix: "/rpc", context: { actor } },
      );
      return response!;
    };
    const cardAsk = async () => {
      const blocks = (await prisma.message.findUniqueOrThrow({ where: { id: cardMessage.id } }))
        .blocks as MessageBlock[];
      return blocks.find((block) => block.kind === "ask");
    };
    const userMessages = () =>
      prisma.message.findMany({
        where: { threadId: thread.id, role: "user" },
        orderBy: { seq: "asc" },
      });
    return {
      bot,
      thread,
      run,
      source,
      cardMessage,
      artifact,
      foreignArtifact,
      sandbox,
      events,
      jobs,
      enqueue,
      answer,
      cardAsk,
      userMessages,
    };
  }

  it("records the files as a reply to the card, resumes the same run, and puts them on its computer", async () => {
    const fixture = await setup();
    const response = await fixture.answer({
      answer: "Here it is.",
      artifactIds: [fixture.artifact.id],
    });
    expect(response.status).toBe(200);

    const fileBlock = {
      kind: "file",
      artifactId: fixture.artifact.id,
      mimeType: "text/plain",
      name: "invoice.txt",
      size: FILE_BYTES.byteLength,
    };
    const [, reply] = await fixture.userMessages();
    expect(reply).toMatchObject({
      replyToMessageId: fixture.cardMessage.id,
      runId: fixture.run.id,
      blocks: [{ kind: "text", text: "Here it is." }, fileBlock],
    });
    expect(await fixture.cardAsk()).toMatchObject({ status: "answered", answer: "Here it is." });
    const created = await prisma.event.findFirstOrThrow({
      where: {
        threadId: fixture.thread.id,
        type: "thread.message.created",
        payload: { path: ["messageId"], equals: reply!.id },
      },
    });
    expect(created).toMatchObject({
      runId: fixture.run.id,
      payload: { role: "user", replyToMessageId: fixture.cardMessage.id },
    });
    // Part of the answer: no run of its own, never steering; the paused run resumes.
    expect(await prisma.run.count({ where: { threadId: fixture.thread.id } })).toBe(1);
    expect(await prisma.steeringMessage.count({ where: { messageId: reply!.id } })).toBe(0);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: fixture.run.id } })).toMatchObject({
      status: "queued",
    });
    expect(fixture.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "run.continue",
        payload: expect.objectContaining({ runId: fixture.run.id }),
      }),
    );

    const requests: AgentRunRequest[] = [];
    const runtime = {
      describe: () => ({
        ...new ScriptedAgentRuntime().describe(),
        capabilities: { streaming: true, compaction: false, tools: true, scripted: false },
      }),
      abort: async () => undefined,
      async *run(request: AgentRunRequest) {
        requests.push(request);
        yield { type: "done" as const, text: "Invoice 42 is 120 EUR." };
      },
    };
    const writeFile = vi.spyOn(fixture.sandbox, "writeFile");
    const artifactGet = vi.fn(async () => FILE_BYTES);
    const executor = createRunExecutor({
      prisma,
      events: fixture.events,
      jobs: fixture.jobs,
      sandbox: fixture.sandbox,
      browser: new FakeBrowserProvider({ pages: {} }),
      runtime,
      home: new LocalAgentHomeStore(dataDir),
      memory: new MarkdownMemoryStore(prisma),
      memoryProviders: { resolve: async () => null },
      artifacts: { get: artifactGet } as unknown as ArtifactStore,
      secretStore: new EncryptedSecretStore("fake-fixture-encryption-key"),
      secrets: [],
      deploymentModelKey: "fake-fixture-model-key",
      deploymentModelConfigured: true,
      dataDir,
    });
    await executor.continueRun(fixture.run.id, "resume-worker");

    expect(await prisma.run.findUniqueOrThrow({ where: { id: fixture.run.id } })).toMatchObject({
      status: "completed",
      error: null,
    });
    expect(requests).toHaveLength(1);
    const [request] = requests;
    const attachedPath = `attachments/${fixture.artifact.id}.txt`;
    expect(request!.prompt).toContain("Here it is.");
    expect(request!.prompt).toContain("Current-turn attached files");
    expect(request!.prompt).toContain(attachedPath);
    expect(request!.history.some((turn) => turn.content.includes("[file: invoice.txt"))).toBe(true);
    expect(artifactGet).toHaveBeenCalledWith(fixture.artifact.storageKey, expect.anything());
    expect(writeFile).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ path: expect.stringContaining(attachedPath) }),
      expect.anything(),
    );
  });

  it("refuses files a send would refuse and leaves the card waiting", async () => {
    const fixture = await setup();
    for (const artifactIds of [[fixture.foreignArtifact.id], [`missing-${randomUUID()}`]]) {
      const response = await fixture.answer({ answer: "Here it is.", artifactIds });
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
    expect(await fixture.userMessages()).toHaveLength(1);
    expect(await fixture.cardAsk()).not.toMatchObject({ status: "answered" });
    expect(await prisma.run.findUniqueOrThrow({ where: { id: fixture.run.id } })).toMatchObject({
      status: "waiting_input",
    });
    expect(fixture.enqueue).not.toHaveBeenCalled();
  });

  it("refuses files on an approval card", async () => {
    const fixture = await setup({
      kind: "ask",
      text: "Allow sending the email?",
      approvalEffectId: `effect-${randomUUID()}`,
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "deny", label: "Deny" },
      ],
    });
    const response = await fixture.answer({
      answer: "allow",
      artifactIds: [fixture.artifact.id],
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(
      "Files can only be attached when answering a question.",
    );
    expect(await fixture.userMessages()).toHaveLength(1);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: fixture.run.id } })).toMatchObject({
      status: "waiting_input",
    });
  });

  it("answers without files as before, adding no message", async () => {
    const fixture = await setup();
    const response = await fixture.answer({ answer: "The March one." });
    expect(response.status).toBe(200);
    expect(await fixture.userMessages()).toHaveLength(1);
    expect(await fixture.cardAsk()).toMatchObject({ status: "answered", answer: "The March one." });
    expect(await prisma.run.findUniqueOrThrow({ where: { id: fixture.run.id } })).toMatchObject({
      status: "queued",
    });
  });
});
