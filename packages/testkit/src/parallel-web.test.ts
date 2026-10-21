import type { AgentRunRequest, AgentRuntime } from "@rakazo/adapter-kit";
import { createRunExecutor, createWebProvider, PiAgentRuntime } from "@rakazo/adapters";
import { maintenanceAttentionReason } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycle from "../../adapters/src/computer-lifecycle.js";
import { parallelMcpFixture } from "../../adapters/src/parallel-web.test-support.js";
import { startModelEmulator } from "./model-emulator.js";

vi.mock("../../adapters/src/computer-lifecycle.js", async (original) => ({
  ...(await original<typeof ComputerLifecycle>()),
  acquireComputerExecutionLease: async () => null,
  acquireDedicatedScreenLeaseFence: async (
    _prisma: unknown,
    input: { computerId: string; botId: string; runId: string },
  ) => ({ ...input, fence: 7 }),
  provisionComputer: async () => ({ id: "computer", kind: "desktop" }),
}));

afterEach(() => vi.unstubAllEnvs());

/** Exercise the deployment-selected provider through ordinary executor dispatch. */
function executorFixture(
  runtime: AgentRuntime,
  disabledBuiltinTools: string[] = [],
  result?: unknown,
) {
  const peer = parallelMcpFixture({ result });
  const computer = {
    id: "computer", scope: "dedicated", kind: "desktop", providerRef: null,
    screenGeneration: 0, controlLeaseId: null, maintenanceId: null,
  };
  const bot = {
    id: "bot", userId: "user", spaceId: "space", spawnKey: null, archivedAt: null,
    name: "Researcher", title: "Researcher", description: "Research public sources", instructions: "",
    computerId: computer.id, computer, computerSwitching: false, disabledBuiltinTools,
  };
  const task = {
    id: "task", userId: "user", spaceId: "space", botId: "bot", threadId: "thread",
    status: "queued", prompt: "Research the question and read its source",
  };
  const thread = { id: "thread", userId: "user", spaceId: "space", groupId: null, group: null };
  const run = {
    id: "run",
    botId: "bot",
    threadId: "thread",
    taskId: "task",
    spaceId: "space",
    userId: "user",
    status: "queued",
    trigger: "user",
    sourceMessageId: null,
    error: null,
    leaseFence: 0,
    checkpoint: null,
    maintenanceCheckpoint: null,
    maintenanceCancelRequestedAt: null,
    routineId: null,
    bot, task, thread, routine: null,
  };
  const maintenanceState = { active: false, revision: 0 };
  const prisma = {
    user: { findUnique: vi.fn<() => Promise<{ timezone: string } | null>>(async () => null) },
    run: {
      findUnique: async () => structuredClone(run),
      findUniqueOrThrow: async () => structuredClone(run),
      updateMany: async ({ where, data }: {
        where: { status?: string; leaseFence?: number };
        data: Record<string, unknown>;
      }) => {
        if ((where.status !== undefined && where.status !== run.status) ||
          (where.leaseFence !== undefined && where.leaseFence !== run.leaseFence)) {
          return { count: 0 };
        }
        Object.assign(run, data);
        return { count: 1 };
      },
    },
    bot: {
      findUnique: async () => bot,
      findUniqueOrThrow: async () => bot,
      findMany: async () => [],
    },
    computer: { findUnique: async () => computer },
    computerExecutionLease: { findUnique: async () => null },
    spaceMember: { findUnique: async () => ({ spaceId: "space", userId: "user" }) },
    attempt: {
      create: async () => ({ id: "attempt" }),
      update: vi.fn(),
      updateMany: async () => ({ count: 1 }),
    },
    thread: { findUniqueOrThrow: async () => thread },
    message: { findMany: async () => [] },
    task: { findUniqueOrThrow: async () => task },
    connection: { findMany: async () => [] },
    spaceModelPreference: { findFirst: async () => null },
    userModelCredential: { findFirst: async () => null },
    deploymentSettings: {
      findUnique: async () => ({ defaultModelProvider: "scripted", defaultModelId: "scripted" }),
    },
    taughtSkill: { findMany: async () => [], findFirst: async () => null },
    agentSecret: { findMany: async () => [] },
    botSecret: { findMany: async () => [] },
    agentSkill: { findMany: async () => [] },
    scratchpadItem: { findMany: async () => [] },
    actionApprovalRule: { findMany: async () => [] },
    actionAutoReviewPreference: { findUnique: async () => ({ enabled: false }) },
    externalEffect: { findMany: async () => [] },
    usageRecord: { createMany: async () => ({ count: 1 }) },
  };
  const finalizeRun = vi.fn(async ({ outcome }: { outcome: string }) => {
    run.status = outcome;
    return { continuationRunId: null };
  });
  const transactionalPrisma = Object.assign(prisma, {
    $queryRaw: async () => [{ ...maintenanceState }],
    $transaction: async <T>(work: (tx: typeof prisma & {
      $queryRaw: () => Promise<Array<typeof maintenanceState>>;
    }) => Promise<T>): Promise<T> => work(transactionalPrisma),
  });
  vi.stubEnv("WEB_PROVIDER", "parallel");
  const executor = createRunExecutor({
    prisma: transactionalPrisma,
    runtime,
    web: createWebProvider(undefined, peer.network),
    sandbox: { describe: () => ({ capabilities: { graphical: false } }) },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    events: { append: async () => undefined, claimSteering: async () => [], finalizeRun },
    jobs: { enqueue: async () => undefined },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  return { peer, prisma, run, maintenanceState, finalizeRun, execute: () => executor.continueRun("run", "worker") };
}

describe("Parallel through the ordinary bot caller", () => {
  it.each(["unchanged", "changed"])("revalidates %s ownership before resuming queued research", async (ownership) => {
    const model = await startModelEmulator({
      steps: ownership === "changed" ? [] : [
        {
          expect: (request) => {
            expect(JSON.stringify(request.messages)).toContain("Research the question and read its source");
          },
          response: {
            type: "tool", id: "search", name: "web_search",
            arguments: { query: "preserved question" },
          },
        },
        {
          expect: (request) => {
            expect(JSON.stringify(request.messages.findLast((message) => message.role === "tool")))
              .toContain("Useful evidence");
          },
          response: { type: "text", text: "The source supports the answer." },
        },
      ],
    });
    try {
      const prompts: string[] = [];
      const pi = new PiAgentRuntime();
      const runtime: AgentRuntime = {
        describe: () => pi.describe(),
        abort: (id) => pi.abort(id),
        run: (request, context) => {
          prompts.push(request.prompt);
          return pi.run(
            { ...request, model: { ...model.model, contextWindow: 200_000, maxTokens: 2048 } },
            context,
          );
        },
      };
      const fixture = executorFixture(runtime);
      fixture.maintenanceState.active = true;
      fixture.maintenanceState.revision = 1;
      await fixture.execute();
      expect(fixture.run.status).toBe("queued");
      expect(prompts).toEqual([]);
      expect(model.requests).toEqual([]);
      expect(fixture.peer.fetch).not.toHaveBeenCalled();
      expect(fixture.finalizeRun).not.toHaveBeenCalled();
      fixture.maintenanceState.active = false;
      fixture.maintenanceState.revision = 2;
      if (ownership === "changed") fixture.run.bot.userId = "different-owner";
      await fixture.execute();
      // A duplicate dispatch must neither restart completed research nor release a held owner.
      await fixture.execute();
      expect(fixture.run.task.prompt).toBe("Research the question and read its source");
      if (ownership === "changed") {
        expect(fixture.run.status).toBe("queued");
        expect(maintenanceAttentionReason(fixture.run.error)).toBe("ownership-changed");
        expect(prompts).toEqual([]);
        expect(model.requests).toEqual([]);
        expect(fixture.peer.fetch).not.toHaveBeenCalled();
        expect(fixture.finalizeRun).not.toHaveBeenCalled();
      } else {
        expect(fixture.run.error).toBeNull();
        expect(fixture.run.status).toBe("completed");
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toContain("Research the question and read its source");
        expect(fixture.peer.calls.map((call) => call.name)).toEqual(["web_search"]);
        expect(fixture.finalizeRun).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome: "completed" }));
      }
      model.assertComplete();
    } finally {
      await model.close();
    }
  });

  it.each(["missing", "failure", "saved"])("uses optional timezone context (%s)", async (state) => {
    let prompt = "";
    const runtime = {
      describe: () => ({ capabilities: { scripted: false } }),
      run: async function* (request: AgentRunRequest) {
        prompt = request.prompt;
        yield { type: "done" as const, text: "Done." };
      },
    } as unknown as AgentRuntime;
    const fixture = executorFixture(runtime);
    if (state === "failure") {
      fixture.prisma.user.findUnique.mockRejectedValueOnce(new Error("lookup unavailable"));
    } else if (state === "saved") {
      fixture.prisma.user.findUnique.mockResolvedValueOnce({ timezone: "Pacific/Auckland" });
    }
    await fixture.execute();
    expect(prompt).toContain(state === "saved" ? "(Pacific/Auckland)" : "Current date and time:");
    expect(prompt).toContain("(UTC)");
  });

  it.each([false, true])(
    "passes large MCP envelopes through executor dispatch into real Pi's next model steps (text-only=%s)",
    async (textOnly) => {
      const model = await startModelEmulator({
        steps: [
          {
            expect: (request) => {
              expect(request.tools?.some((tool) => tool.function.name === "web_search")).toBe(true);
            },
            response: {
              type: "tool",
              id: "search",
              name: "web_search",
              arguments: { query: "current question", maxResults: 1 },
            },
          },
          {
            expect: (request) => {
              expect(
                JSON.stringify(request.messages.findLast((message) => message.role === "tool")),
              ).toContain("Useful evidence");
            },
            response: {
              type: "tool",
              id: "fetch",
              name: "web_fetch",
              arguments: { url: "https://example.test/page", maxChars: 100 },
            },
          },
          {
            expect: (request) => {
              const result = JSON.stringify(
                request.messages.findLast((message) => message.role === "tool"),
              );
              expect(result).toContain("Page text");
              expect(result).toContain("[Content truncated]");
              expect(result).not.toContain("Invalid Parallel MCP response");
              expect(result.length).toBeLessThan(1_000);
            },
            response: { type: "text", text: "The source supports the answer." },
          },
        ],
      });
      try {
        const pi = new PiAgentRuntime();
        const runtime: AgentRuntime = {
          describe: () => pi.describe(),
          abort: (id) => pi.abort(id),
          run: (request, context) =>
            pi.run(
              { ...request, model: { ...model.model, contextWindow: 200_000, maxTokens: 2048 } },
              context,
            ),
        };
        const data = {
          results: [
            {
              url: "https://example.test/page",
              title: "Source",
              excerpts: ["Useful evidence"],
              full_content: "Page text ".repeat(120_000),
            },
          ],
        };
        const result = {
          content: [{ type: "text", text: JSON.stringify(data) }],
          ...(textOnly ? {} : { structuredContent: data }),
        };
        expect(Buffer.byteLength(JSON.stringify(result))).toBeGreaterThan(1_000_000);
        const fixture = executorFixture(runtime, [], result);
        await fixture.execute();
        expect(fixture.finalizeRun).toHaveBeenCalledWith(
          expect.objectContaining({ outcome: "completed" }),
        );
        model.assertComplete();
        expect(fixture.peer.calls.map((call) => call.name)).toEqual(["web_search", "web_fetch"]);
        expect(
          fixture.peer.requests.every(
            (request) =>
              request.url === "https://search.parallel.ai/mcp" &&
              request.headers.get("user-agent")?.startsWith("Rakazo/") &&
              !request.headers.has("authorization"),
          ),
        ).toBe(true);
      } finally {
        await model.close();
      }
    },
  );

  it("refuses disabled builtin calls before reaching the MCP transport", async () => {
    const results: unknown[] = [];
    const runtime = {
      describe: () => ({ capabilities: { scripted: false } }),
      run: async function* (request: AgentRunRequest) {
        expect(request.tools.some((tool) => tool.name === "web_search")).toBe(false);
        results.push(
          await request.executeTool!("web_search", { query: "must not leave" }, "blocked"),
        );
        yield { type: "done" as const, text: "Search is disabled." };
      },
    } as unknown as AgentRuntime;
    const fixture = executorFixture(runtime, ["web_search", "web_fetch"]);
    await fixture.execute();
    expect(results).toEqual([{ error: "This tool is disabled for this bot." }]);
    expect(fixture.peer.fetch).not.toHaveBeenCalled();
  });
});
