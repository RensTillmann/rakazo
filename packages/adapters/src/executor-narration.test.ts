import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import type * as DbModule from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type * as BotMessagesModule from "./bot-messages.js";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";

type Published = { role: string; blocks: MessageBlock[]; clientNonce?: string };
const published: Published[] = [];

vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof DbModule>()),
  createThreadMessageInTransaction: vi.fn(async (_tx: unknown, message: Published) => {
    published.push({ role: message.role, blocks: message.blocks, clientNonce: message.clientNonce });
    return { id: `message-${published.length}` };
  }),
  appendEventInTransaction: vi.fn(async () => ({ seq: published.length })),
}));

const returnBotMessageOutcome = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("./bot-messages.js", async (importOriginal) => ({
  ...(await importOriginal<typeof BotMessagesModule>()),
  returnBotMessageOutcome,
}));

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  provisionComputer: async () => ({ id: "computer-1", kind: "desktop" }),
}));

const NARRATION = "Label missing; create it.";

/**
 * One run whose runtime yields `script` (tool events are executed). User-triggered unless
 * `trigger` says otherwise; `source` is the message that woke a bot_message run.
 */
function fixture(
  script: AgentRuntimeEvent[],
  options: { trigger?: string; source?: MessageBlock[] } = {},
) {
  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger: options.trigger ?? "user",
    sourceMessageId: options.source ? "source-1" : null,
    leaseFence: 0,
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({})),
    run: {
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => run),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
    bot: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.botId,
        name: "Assistant",
        title: "Assistant",
        description: "Test assistant",
        disabledBuiltinTools: [],
        computerId: "computer-1",
        computer: { id: "computer-1", scope: "dedicated" },
      })),
      findMany: vi.fn(async () => []),
    },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: { findUniqueOrThrow: vi.fn(async () => ({ id: run.threadId, groupId: null })) },
    message: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () =>
        options.source ? { blocks: options.source, replyTo: null } : null,
      ),
      findFirst: vi.fn(async () => null),
    },
    task: { findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: "Tidy labels" })) },
    connection: { findMany: vi.fn(async () => []) },
    spaceModelPreference: { findFirst: vi.fn(async () => null) },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "scripted",
        defaultModelId: "scripted",
      })),
    },
    taughtSkill: { findMany: vi.fn(async () => []) },
    agentSecret: { findMany: vi.fn(async () => []) },
    botSecret: { findMany: vi.fn(async () => []) },
    agentSkill: { findMany: vi.fn(async () => []) },
    scratchpadItem: { findMany: vi.fn(async () => []) },
    actionApprovalRule: { findMany: vi.fn(async () => []) },
    actionAutoReviewPreference: { findUnique: vi.fn(async () => ({ enabled: false })) },
    externalEffect: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: object }) => ({ ...data, id: "effect-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    computer: { updateMany: vi.fn(async () => ({ count: 1 })) },
  };
  const append = vi.fn(async () => undefined);
  const pauseRunForInput = vi.fn(async () => true);
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const runtimeRun = vi.fn(async function* (request: AgentRunRequest) {
    for (const event of script) {
      yield event;
      if (event.type === "tool") {
        await request.executeTool!(event.name, event.args, event.executionId);
      }
    }
  });
  const executor = createRunExecutor({
    prisma,
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    connector: {
      discoverTools: async () => [
        {
          name: "label_create",
          description: "Create a label",
          readOnly: true,
          inputSchema: { type: "object" },
          route: { connectorId: "demo", resourceId: "resource-1", toolName: "label_create" },
        },
      ],
      resolveCall: async () => undefined,
      execute: vi.fn(async function* () {
        yield { type: "result" as const, data: { ok: true } };
      }),
    },
    sandbox: {
      describe: () => ({ capabilities: { graphical: false } }),
      execute: vi.fn(async function* () {}),
      exportWorkspace: async function* () {},
    },
    home: { commit: vi.fn(async () => "revision-1") },
    memory: { read: async () => ({ documents: [] }), commit: vi.fn() },
    memoryProviders: { resolve: async () => null },
    events: { append, notify: vi.fn(async () => undefined), pauseRunForInput, finalizeRun },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  return {
    append,
    pauseRunForInput,
    finalizeRun,
    /** Blocks of the run's final message (empty when the run finished with none). */
    finalBlocks: () =>
      (finalizeRun.mock.calls as unknown as [{ blocks: MessageBlock[] }][])[0]![0].blocks,
    async run() {
      published.length = 0;
      returnBotMessageOutcome.mockClear();
      await executor.continueRun(run.id, "worker-1");
      expect(runtimeRun).toHaveBeenCalled();
      expect(finalizeRun).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
    },
  };
}

type Block = { kind: string; text?: string; narration?: boolean };

const toolTurn: AgentRuntimeEvent[] = [
  { type: "text", text: NARRATION },
  { type: "tool", name: "label_create", args: { name: "urgent" }, executionId: "call-1" },
  {
    type: "tool",
    name: "message_user",
    args: { message: "Halfway there." },
    executionId: "call-2",
  },
  { type: "text", text: "Created the urgent label." },
  { type: "done", text: `${NARRATION}Created the urgent label.` },
];

function peerMessage(intent: "fyi" | "request"): MessageBlock[] {
  return [
    {
      kind: "bot_message_received",
      fromBotId: "bot-2",
      fromBotName: "Elena",
      text: "Heads up: the labels were tidied.",
      intent,
    },
  ];
}

describe("mid-turn narration in a user-triggered run", () => {
  it("flags narration but not message_user or the final reply", async () => {
    const f = fixture(toolTurn);
    await f.run();
    expect(published.flatMap((message) => message.blocks)).toEqual([
      { kind: "text", text: NARRATION, narration: true },
      { kind: "text", text: "Halfway there." },
    ]);
    const final = (f.finalizeRun.mock.calls as unknown as [{ blocks: Block[] }][])[0]![0];
    expect(final.blocks.filter((block) => block.kind === "text")).toEqual([
      { kind: "text", text: "Created the urgent label." },
    ]);
  });

  it("does not flag the ask_user card", async () => {
    const f = fixture([
      { type: "text", text: NARRATION },
      { type: "tool", name: "label_create", args: { name: "urgent" }, executionId: "call-1" },
      {
        type: "ask",
        text: "Which colour?",
        actions: [
          { id: "red", label: "Red" },
          { id: "blue", label: "Blue" },
        ],
      },
    ]);
    await f.run();
    const pause = (f.pauseRunForInput.mock.calls as unknown as [{ blocks: Block[] }][])[0]![0];
    expect(pause.blocks).toEqual([
      expect.objectContaining({ kind: "ask", text: "Which colour?" }),
    ]);
    expect(pause.blocks[0]!.narration).toBeUndefined();
  });
});

describe("NO_RESPONSE in a run woken by another bot's fyi", () => {
  it("finishes with no message at all", async () => {
    const f = fixture(
      [
        { type: "text", text: "NO_RESPONSE" },
        { type: "done", text: "NO_RESPONSE" },
      ],
      { trigger: "bot_message", source: peerMessage("fyi") },
    );
    await f.run();

    expect(published).toEqual([]);
    expect(f.finalBlocks()).toEqual([]);
    expect(returnBotMessageOutcome).not.toHaveBeenCalled();
  });

  it("finishes with no message when the sentinel repeats around tool calls", async () => {
    const f = fixture(
      [
        { type: "text", text: "NO_RESPONSE" },
        { type: "tool", name: "label_create", args: { name: "urgent" }, executionId: "call-1" },
        { type: "text", text: "NO_RESPONSE" },
        { type: "done", text: "NO_RESPONSENO_RESPONSE" },
      ],
      { trigger: "bot_message", source: peerMessage("fyi") },
    );
    await f.run();

    expect(published).toEqual([]);
    expect(f.finalBlocks()).toEqual([]);
    expect(returnBotMessageOutcome).not.toHaveBeenCalled();
  });

  it("still returns NO_RESPONSE to the sender of a request", async () => {
    const f = fixture(
      [
        { type: "text", text: "NO_RESPONSE" },
        { type: "done", text: "NO_RESPONSE" },
      ],
      { trigger: "bot_message", source: peerMessage("request") },
    );
    await f.run();

    expect(f.finalBlocks()).toEqual([{ kind: "text", text: "NO_RESPONSE" }]);
    expect(returnBotMessageOutcome).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      "NO_RESPONSE",
      "result",
    );
  });
});
