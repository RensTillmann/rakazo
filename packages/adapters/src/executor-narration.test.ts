import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { type MessageBlock, THINKING_BLOCK_MAX_CHARS } from "@rakazo/contracts";
import type * as DbModule from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type * as BotMessagesModule from "./bot-messages.js";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor, PERSON_SILENT_REPLY_NUDGE } from "./executor.js";

type Published = { role: string; blocks: MessageBlock[]; clientNonce?: string };
const published: Published[] = [];

vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof DbModule>()),
  createThreadMessageInTransaction: vi.fn(async (_tx: unknown, message: Published) => {
    published.push({
      role: message.role,
      blocks: message.blocks,
      clientNonce: message.clientNonce,
    });
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
const SECRET = "sk-live-0123456789abcdef";

type HistoryRow = {
  id: string;
  seq: number;
  role: string;
  blocks: MessageBlock[];
  clientNonce?: string;
};

/**
 * One run whose runtime yields `script` (tool events are executed). User-triggered unless
 * `trigger` says otherwise; `source` is the message that woke a bot_message run, `history`
 * the thread's earlier messages.
 */
function fixture(
  script: AgentRuntimeEvent[],
  options: { trigger?: string; source?: MessageBlock[]; history?: HistoryRow[] } = {},
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
    // Upstream #1401 holds mid-turn narration back until a turn is a minute old; these tests
    // cover a long turn, where user-run narration is published.
    startedAt: new Date(Date.now() - 10 * 60_000),
  };
  const history = (options.history ?? []).map((row) => ({
    clientNonce: null,
    ...row,
    threadId: run.threadId,
    botId: row.role === "bot" ? run.botId : null,
    runId: null,
    createdAt: new Date("2026-10-18T08:00:00Z"),
    replyToMessageId: null,
    replyQuote: null,
    replyTo: null,
  }));
  const prisma = {
    // Upstream's dedicated-computer lease fence locks rows with $queryRaw, checks for another
    // run with a live lease on the computer (none here), then bumps the lease.
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        $queryRaw: vi.fn(async () => [{ id: "row-1", scope: "dedicated" }]),
        run: { findMany: vi.fn(async () => []) },
        computerExecutionLease: {
          updateManyAndReturn: vi.fn(async () => [{ fence: 1 }]),
        },
      }),
    ),
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
      // Newest first, like the history query; this run's own earlier messages: none.
      findMany: vi.fn(async (query: { where?: { runId?: string } }) =>
        query.where?.runId ? [] : [...history].sort((left, right) => right.seq - left.seq),
      ),
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
        {
          // A read: webhook runs ask approval for connector writes such as label_create.
          name: "label_list",
          description: "List labels",
          readOnly: true,
          inputSchema: { type: "object" },
          route: { connectorId: "demo", resourceId: "resource-1", toolName: "label_list" },
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
    secrets: [SECRET],
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  return {
    runtimeRun,
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
    expect(pause.blocks).toEqual([expect.objectContaining({ kind: "ask", text: "Which colour?" })]);
    expect(pause.blocks[0]!.narration).toBeUndefined();
  });

  it("hands back the refusal and goes on when the same card is already open", async () => {
    const settle = vi.fn();
    const f = fixture([
      { type: "ask", text: "Case 78 · alert: export?", actions: [], settle },
      { type: "text", text: "Carrying on without asking." },
      { type: "done", text: "Carrying on without asking." },
    ]);
    f.pauseRunForInput.mockImplementationOnce((async () => ({
      duplicateAskedAt: new Date("2026-10-20T05:26:23.000Z"),
    })) as never);
    await f.run();
    expect(f.pauseRunForInput).toHaveBeenCalledWith(
      expect.objectContaining({ dedupeQuestion: true }),
    );
    expect(settle).toHaveBeenCalledWith(
      "Not asked: the same card is already open in Rens's queue (asked 05:26 UTC). Don't ask it again; his answer comes to the run that asked it.",
    );
    expect(f.finalBlocks()).toContainEqual(
      expect.objectContaining({ kind: "text", text: "Carrying on without asking." }),
    );
  });

  it("settles a stored card with null and does not dedupe asks it cannot settle", async () => {
    const settle = vi.fn();
    const stored = fixture([{ type: "ask", text: "Which colour?", actions: [], settle }]);
    await stored.run();
    expect(settle).toHaveBeenCalledWith(null);

    const plain = fixture([{ type: "ask", text: "Which colour?", actions: [] }]);
    await plain.run();
    expect(plain.pauseRunForInput).toHaveBeenCalledWith(
      expect.not.objectContaining({ dedupeQuestion: true }),
    );
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

describe("model thinking in a run's chat", () => {
  const tool = (executionId: string): AgentRuntimeEvent => ({
    type: "tool",
    name: "label_create",
    args: { name: executionId },
    executionId,
  });

  it("stores each call's thinking in order with the narration, steps and reply", async () => {
    const f = fixture([
      { type: "thinking", text: "No urgent label yet; create it." },
      { type: "text", text: NARRATION },
      tool("call-1"),
      { type: "thinking", text: "Created. Tell the user." },
      { type: "text", text: "Created the urgent label." },
      { type: "done", text: `${NARRATION}Created the urgent label.` },
    ]);
    await f.run();

    expect(published.map((message) => message.blocks)).toEqual([
      [
        { kind: "thinking", text: "No urgent label yet; create it." },
        { kind: "text", text: NARRATION, narration: true },
      ],
    ]);
    expect(f.finalBlocks()).toEqual([
      { kind: "steps", steps: [{ label: "Label create", count: 1 }] },
      { kind: "thinking", text: "Created. Tell the user." },
      { kind: "text", text: "Created the urgent label." },
    ]);
  });

  it("redacts the run's secrets and cuts long thinking, marking the cut", async () => {
    const long = `Key ${SECRET} works. ${"x".repeat(THINKING_BLOCK_MAX_CHARS + 500)}`;
    const f = fixture([
      { type: "thinking", text: long },
      { type: "text", text: "Done." },
      { type: "done", text: "Done." },
    ]);
    await f.run();

    const [thinking] = f.finalBlocks();
    expect(thinking).toMatchObject({ kind: "thinking", truncated: true });
    const text = thinking?.kind === "thinking" ? thinking.text : "";
    expect(text).not.toContain(SECRET);
    expect(text.startsWith("Key [redacted] works.")).toBe(true);
    expect(text.length).toBeLessThanOrEqual(THINKING_BLOCK_MAX_CHARS);
    expect(text.endsWith("…")).toBe(true);
  });

  it("stores the thinking of a run another bot started", async () => {
    const f = fixture(
      [
        { type: "thinking", text: "Elena asks for the label list." },
        { type: "text", text: "Urgent, later." },
        { type: "done", text: "Urgent, later." },
      ],
      { trigger: "bot_message", source: peerMessage("request") },
    );
    await f.run();

    expect(f.finalBlocks()).toEqual([
      { kind: "thinking", text: "Elena asks for the label list." },
      { kind: "text", text: "Urgent, later." },
    ]);
  });

  it("posts nothing when an fyi run's only output is its thinking and NO_RESPONSE", async () => {
    const f = fixture(
      [
        { type: "thinking", text: "Just an fyi; nothing to add." },
        { type: "text", text: "NO_RESPONSE" },
        { type: "done", text: "NO_RESPONSE" },
      ],
      { trigger: "bot_message", source: peerMessage("fyi") },
    );
    await f.run();

    expect(published).toEqual([]);
    expect(f.finalBlocks()).toEqual([]);
  });

  it("keeps none for routines", async () => {
    const f = fixture(
      [
        { type: "thinking", text: "Nothing new today." },
        { type: "text", text: "All quiet." },
        { type: "done", text: "All quiet." },
      ],
      { trigger: "routine" },
    );
    await f.run();

    expect(f.finalBlocks()).toEqual([{ kind: "text", text: "All quiet." }]);
  });

  it("never sends stored thinking back to the model in the next run's history", async () => {
    const f = fixture(
      [
        { type: "text", text: "Sure." },
        { type: "done", text: "Sure." },
      ],
      {
        history: [
          { id: "m1", seq: 0, role: "user", blocks: [{ kind: "text", text: "Which labels?" }] },
          {
            id: "m2",
            seq: 1,
            role: "bot",
            blocks: [
              { kind: "thinking", text: "PRIVATE-REASONING-MARKER" },
              { kind: "text", text: "Urgent and later." },
            ],
          },
        ],
      },
    );
    await f.run();

    const input = JSON.stringify(f.runtimeRun.mock.calls[0]![0]);
    expect(input).toContain("Urgent and later.");
    expect(input).not.toContain("PRIVATE-REASONING-MARKER");
  });
});

describe("NO_RESPONSE in a held webhook delivery's run (no routine on the run)", () => {
  const wake: MessageBlock[] = [
    { kind: "text", text: 'Run routine "Fleet events":\nAct on the event; else stay silent.' },
  ];

  it.each([
    ["once", ["NO_RESPONSE"]],
    ["repeated around a tool call", ["NO_RESPONSE", "NO_RESPONSE"]],
  ])("persists nothing (%s) and gets no nudge", async (_case, texts) => {
    const script: AgentRuntimeEvent[] = [{ type: "text", text: texts[0]! }];
    if (texts[1]) {
      script.push(
        { type: "tool", name: "label_list", args: {}, executionId: "call-1" },
        { type: "text", text: texts[1] },
      );
    }
    script.push({ type: "done", text: texts.join("") });
    const f = fixture(script, { trigger: "webhook", source: wake });
    await f.run();

    const request = f.runtimeRun.mock.calls[0]![0];
    expect(request.allowSilentEmpty).toBe(true);
    expect(request.silentReplyNudge).toBeUndefined();
    expect(published).toEqual([]);
    expect(f.finalBlocks()).toEqual([]);
    expect(f.finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ markUnread: false }));
  });
});

describe("a run answering a person's own message", () => {
  const personSource: MessageBlock[] = [
    { kind: "text", text: "polisje.nl is a client site. Its mail is client mail." },
  ];
  const thread: HistoryRow[] = [
    {
      id: "fyi-1",
      seq: 1,
      role: "user",
      clientNonce: "bot-message:fyi-1",
      blocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-2",
          fromBotName: "Isabella",
          text: "Josy, case 173 is a bug report.",
          intent: "fyi",
        },
      ],
    },
    {
      id: "wake-1",
      seq: 2,
      role: "user",
      clientNonce: "webhook:bot-1:delivery-1",
      blocks: [{ kind: "text", text: 'Run routine "Fleet events":\nAct on the event.' }],
    },
    { id: "source-1", seq: 3, role: "user", blocks: personSource },
  ];

  it("marks the person's words, not a teammate's message or a delivered wake", async () => {
    const f = fixture(
      [
        { type: "text", text: "Noted." },
        { type: "done", text: "Noted." },
      ],
      {
        source: personSource,
        history: [
          ...thread.slice(0, 2),
          { id: "earlier", seq: 0, role: "user", blocks: [{ kind: "text", text: "Hi Josy" }] },
          thread[2]!,
        ],
      },
    );
    await f.run();

    const { history, prompt } = f.runtimeRun.mock.calls[0]![0];
    expect(history.map((turn) => turn.content)).toEqual([
      "[from the user] Hi Josy",
      "[from Isabella] Josy, case 173 is a bug report.",
      'Run routine "Fleet events":\nAct on the event.',
      "[from the user] polisje.nl is a client site. Its mail is client mail.",
    ]);
    expect(prompt.startsWith("[from the user] Tidy labels\n\n")).toBe(true);
  });

  it("gets the nudge; routines and teammates' fyi do not", async () => {
    const done: AgentRuntimeEvent[] = [{ type: "done", text: "ok" }];
    const user = fixture(done, { source: personSource, history: thread });
    await user.run();
    expect(user.runtimeRun.mock.calls[0]![0].silentReplyNudge).toBe(PERSON_SILENT_REPLY_NUDGE);
    expect(PERSON_SILENT_REPLY_NUDGE).toContain("NO_RESPONSE is not allowed here");

    const fyi = fixture(done, { trigger: "bot_message", source: peerMessage("fyi") });
    await fyi.run();
    const fyiRequest = fyi.runtimeRun.mock.calls[0]![0];
    expect(fyiRequest.silentReplyNudge).toBeUndefined();
    expect(fyiRequest.prompt.startsWith("[from the user]")).toBe(false);

    const routine = fixture(done, { trigger: "routine" });
    await routine.run();
    expect(routine.runtimeRun.mock.calls[0]![0].silentReplyNudge).toBeUndefined();
  });

  it("posts the answer the nudge produced, without the marker", async () => {
    const f = fixture(
      [
        { type: "text", text: "NO_RESPONSE" },
        { type: "text", text: "\n\n" },
        { type: "text", text: "Got it: polisje.nl mail is client mail." },
        { type: "done", text: "NO_RESPONSE\n\nGot it: polisje.nl mail is client mail." },
      ],
      { source: personSource, history: thread },
    );
    await f.run();

    expect(f.finalBlocks()).toEqual([
      { kind: "text", text: "Got it: polisje.nl mail is client mail." },
    ]);
  });

  it.each([
    ["once", ["NO_RESPONSE"]],
    ["repeated around tools and after the nudge", ["NO_RESPONSE", "NO_RESPONSE\n\nNO_RESPONSE"]],
  ])("never posts the silent marker (%s)", async (_case, texts) => {
    const script: AgentRuntimeEvent[] = [
      { type: "thinking", text: "A work card is waiting; stay silent." },
      { type: "text", text: texts[0]! },
    ];
    if (texts[1]) {
      script.push(
        { type: "tool", name: "label_create", args: { name: "urgent" }, executionId: "call-1" },
        { type: "text", text: texts[1] },
      );
    }
    script.push({ type: "done", text: texts.join("") });
    const f = fixture(script, { source: personSource, history: thread });
    await f.run();

    expect(f.finalBlocks()).toEqual([]);
    expect(JSON.stringify(published)).not.toContain("NO_RESPONSE");
  });
});
