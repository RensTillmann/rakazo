import type { AgentRunRequest } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { loadBotMessageContext, returnBotMessageOutcome } from "./bot-messages.js";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";
import { createJobReconciler } from "./job-reconciler.js";

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  provisionComputer: async () => ({ id: "computer-1", kind: "desktop" }),
}));

vi.mock("./bot-messages.js", () => ({
  loadBotMessageContext: vi.fn(async () => ({
    fromBotId: "caller",
    fromBotName: "Caller",
    text: "FYI",
    intent: "fyi",
    hop: 1,
    repliesToRequest: false,
  })),
  returnBotMessageOutcome: vi.fn(async () => undefined),
}));

async function runTurn(
  finalText: string,
  silent = true,
  narration: string | string[] = "I will check that.",
  secrets: string[] = [],
  intent: "fyi" | "request" | "question" = "fyi",
) {
  vi.mocked(loadBotMessageContext).mockResolvedValue({
    kind: "bot_message_received",
    fromBotId: "caller",
    fromBotName: "Caller",
    text: "Look again",
    intent,
    hop: 1,
    repliesToRequest: false,
  });
  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger: silent ? "bot_message" : "user",
    sourceMessageId: "source-1",
    leaseFence: 0,
  };
  const runtimeRun = vi.fn(async function* (_request: AgentRunRequest) {
    const narrations = Array.isArray(narration) ? narration : [narration];
    for (const [index, text] of narrations.entries()) {
      yield { type: "text" as const, text };
      yield {
        type: "tool" as const,
        name: "read_file",
        args: {},
        executionId: `call-${index + 1}`,
      };
    }
    if (finalText) yield { type: "text" as const, text: finalText };
    yield { type: "done" as const, text: narrations.join("") + finalText };
  });
  const prisma = {
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
        modelProvider: null,
        modelId: null,
        thinkingLevel: null,
        computerId: "computer-1",
        computerSwitching: false,
        memoryScope: null,
        computer: { id: "computer-1", scope: "dedicated" },
      })),
      findMany: vi.fn(async () => []),
    },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.threadId,
        groupId: null,
        historyCompactionSummary: null,
        historyCompactedUpToSeq: null,
        nextMessageSeq: 3,
      })),
    },
    message: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => null),
    },
    task: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.taskId,
        prompt: "Look again",
      })),
    },
    computer: { updateMany: vi.fn(async () => ({ count: 1 })) },
    connection: { findMany: vi.fn(async () => []) },
    spaceModelPreference: {
      findFirst: vi.fn<(...args: unknown[]) => Promise<Record<string, unknown> | null>>(
        async () => null,
      ),
    },
    secret: { findFirst: vi.fn(async () => null) },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    spaceBackupModel: { findMany: vi.fn(async () => []) },
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
    externalEffect: { findMany: vi.fn(async () => []) },
    computerExecutionLease: {
      updateManyAndReturn: vi.fn(async () => [{ fence: 1 }]),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    $queryRaw: vi.fn(async () => [{ id: "row-1", scope: "dedicated" }]),
    $transaction: vi.fn(
      async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => fn(prisma),
    ),
  };
  const finalizeRun = vi.fn(async (_input: { blocks: MessageBlock[] }) => ({
    continuationRunId: null,
  }));
  const append = vi.fn(async (_event: { type: string; payload?: unknown }) => undefined);
  const executor = createRunExecutor({
    prisma,
    runtime: {
      describe: () => ({ capabilities: { scripted: false } }),
      run: runtimeRun,
    },
    sandbox: {
      describe: () => ({ capabilities: { graphical: false } }),
      writeFile: vi.fn(async () => undefined),
      async *exportWorkspace() {
        yield* [];
      },
    },
    home: { commit: vi.fn(async () => "fixture-revision") },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    events: { append, finalizeRun },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets,
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  await executor.continueRun(run.id, "worker-1");
  expect(runtimeRun).toHaveBeenCalled();
  expect(finalizeRun).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
  return { finalizeRun, append };
}

describe("withheld narration on short peer turns", () => {
  it.each(["", "Checked: all clear."])("returns only the post-tool final %j", async (finalText) => {
    vi.mocked(returnBotMessageOutcome).mockClear();
    const { finalizeRun } = await runTurn(finalText);
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    expect(finalizeRun.mock.calls[0]![0].blocks.filter((block) => block.kind === "text")).toEqual(
      finalText ? [{ kind: "text", text: finalText }] : [],
    );
    if (finalText) {
      expect(returnBotMessageOutcome).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        finalText,
        "result",
      );
    } else {
      expect(returnBotMessageOutcome).not.toHaveBeenCalled();
    }
  });
});

describe("held-back narration on peer requests", () => {
  it.each(["request", "question"] as const)(
    "saves the last non-empty narration as the final result for an empty %s reply",
    async (intent) => {
      vi.mocked(returnBotMessageOutcome).mockClear();
      const { finalizeRun, append } = await runTurn(
        "",
        true,
        ["I will check that.", "  The draft is posted.  ", "   "],
        [],
        intent,
      );
      expect(finalizeRun).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ outcome: "completed" }),
      );
      expect(finalizeRun.mock.calls[0]![0].blocks.filter((block) => block.kind === "text")).toEqual(
        [{ kind: "text", text: "The draft is posted." }],
      );
      expect(append.mock.calls.map(([event]) => event.type)).not.toContain(
        "thread.message.created",
      );
      expect(returnBotMessageOutcome).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        "The draft is posted.",
        "result",
      );

      // A worker stopping after finalizeRun leaves only these saved blocks for retry.
      vi.mocked(returnBotMessageOutcome).mockClear();
      const terminalRun = {
        id: "run-1",
        status: "completed",
        botId: "bot-1",
        bot: { name: "Assistant" },
      };
      const reconciler = createJobReconciler({
        prisma: {
          run: {
            findMany: vi.fn(async ({ where }: { where: { trigger?: string } }) =>
              where.trigger === "bot_message" ? [terminalRun] : [],
            ),
            updateMany: vi.fn(async () => ({ count: 1 })),
          },
          routine: { findMany: vi.fn(async () => []) },
          computer: { findMany: vi.fn(async () => []) },
          messagingOutbound: { findFirst: vi.fn(async () => null) },
          message: {
            findMany: vi.fn(async () => [
              { blocks: finalizeRun.mock.calls[0]![0].blocks, clientNonce: null },
            ]),
          },
        },
        jobs: { enqueue: vi.fn() },
        events: {},
      } as unknown as Parameters<typeof createJobReconciler>[0]);
      await reconciler.reconcileOnce();
      expect(returnBotMessageOutcome).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        terminalRun,
        { id: "bot-1", name: "Assistant" },
        "The draft is posted.",
        "result",
        { forceUnread: false },
      );
    },
  );
});

describe("withheld narration on short reply-producing turns", () => {
  it.each(["", "Checked: all clear."])("keeps pre-tool text with final %j", async (finalText) => {
    const { finalizeRun } = await runTurn(finalText, false);
    const text = finalizeRun.mock.calls[0]![0].blocks.filter((block) => block.kind === "text")
      .map((block) => block.text)
      .join("");
    expect(text).toBe(`I will check that.${finalText ? `\n\n${finalText}` : ""}`);
  });
});

describe("text from separate assistant turns", () => {
  it.each(["The draft is posted.", "The draft is posted at https://example.com/drafts/42"])(
    "keeps a paragraph break after %j in finalized blocks",
    async (narration) => {
      const { finalizeRun } = await runTurn("Nothing has changed since then.", false, narration);
      const text = finalizeRun.mock.calls[0]![0].blocks.filter((block) => block.kind === "text")
        .map((block) => block.text)
        .join("");
      expect(text).toBe(`${narration}\n\nNothing has changed since then.`);
    },
  );

  it("streams the break when the redactor holds all pre-tool text", async () => {
    const narration = "I will check that.";
    const finalText = "Checked: all clear.";
    const { append } = await runTurn(finalText, false, narration, [
      "fake-secret-longer-than-the-entire-reply-for-redactor-buffering",
    ]);
    const text = append.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "thread.progress")
      .map((event) => {
        const payload = event.payload as { text?: string; delta?: string };
        return payload.text ?? payload.delta ?? "";
      })
      .join("");
    expect(text).toBe(`${narration}\n\n${finalText}`);
  });
});
