import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import type * as Core from "@rakazo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const providerState = vi.hoisted(() => ({
  models: new Map<string, Record<string, unknown>>(),
  stream: vi.fn(),
}));

vi.mock("@rakazo/core", async (importOriginal) => ({
  ...(await importOriginal<typeof Core>()),
  abortableDelay: vi.fn(async () => undefined),
}));

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: (provider: string, id: string) => providerState.models.get(`${provider}/${id}`),
    streamSimple: (...args: unknown[]) => providerState.stream(...args),
  }),
}));

vi.mock("./pi-current-models.js", () => ({ supplementPiModels: (models: unknown) => models }));
vi.mock("./pi-local-provider.js", () => ({ registerLocalProvider: (models: unknown) => models }));
vi.mock("./pi-openai-compatible-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  registerOpenAiCompatibleCatalog: (models: unknown) => models,
  registerOpenAiCompatibleRuntime: (models: unknown) => models,
}));

import {
  PiAgentRuntime,
  RUN_BUDGET_FALLBACK_TEXT,
  RUN_BUDGET_FINAL_PROMPT,
  runBudgetLimits,
  runBudgetWarnAt,
} from "./pi-runtime.js";

const testModel: Model<"openai-completions"> = {
  provider: "provider-a",
  id: "budget-model",
  name: "budget-model",
  api: "openai-completions",
  baseUrl: "https://models.invalid/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_768,
  maxTokens: 4_096,
};

function message(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: testModel.api,
    provider: testModel.provider,
    model: testModel.id,
    usage: {
      input: 4,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 6,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
}

function stream(response: AssistantMessage) {
  const result = new AssistantMessageEventStream();
  result.push({ type: "start", partial: { ...response, content: [], stopReason: "stop" } });
  if (response.stopReason === "error") {
    result.push({ type: "error", reason: "error", error: response });
  } else {
    const text = response.content.find((part) => part.type === "text");
    if (text?.type === "text") {
      result.push({ type: "text_start", contentIndex: 0, partial: response });
      result.push({ type: "text_delta", contentIndex: 0, delta: text.text, partial: response });
      result.push({ type: "text_end", contentIndex: 0, content: text.text, partial: response });
    }
    const call = response.content.find((part) => part.type === "toolCall");
    if (call?.type === "toolCall") {
      result.push({ type: "toolcall_start", contentIndex: 0, partial: response });
      result.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: response });
    }
    result.push({ type: "done", reason: call ? "toolUse" : "stop", message: response });
  }
  result.end(response);
  return result;
}

let callId = 0;
function toolTurn(narration?: string) {
  callId += 1;
  return message(
    [
      ...(narration ? [{ type: "text" as const, text: narration }] : []),
      {
        type: "toolCall" as const,
        id: `shell-${callId}`,
        name: "shell",
        arguments: { command: "chromium --headless --screenshot https://nu.nl" },
      },
    ],
    "toolUse",
  );
}

function textTurn(text: string) {
  return message([{ type: "text", text }], "stop");
}

/** True when the request is the budget's final turn. */
function isFinalTurn(context: unknown): boolean {
  if (!context || typeof context !== "object" || !("messages" in context)) return false;
  const messages = Array.isArray(context.messages) ? context.messages : [];
  return JSON.stringify(messages.at(-1) ?? null).includes(RUN_BUDGET_FINAL_PROMPT);
}

/** The text of the request's last message when it is the early budget warning. */
function warningText(context: unknown): string | undefined {
  if (!context || typeof context !== "object" || !("messages" in context)) return undefined;
  const messages = Array.isArray(context.messages) ? context.messages : [];
  const content = (messages.at(-1) as { content?: unknown } | undefined)?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part: { text?: unknown }) => String(part?.text ?? "")).join("")
        : "";
  return text.startsWith("Run budget almost used (") ? text : undefined;
}

function request(executeTool = vi.fn(async () => ({ ok: true }))): AgentRunRequest {
  return {
    botId: "bot",
    threadId: "thread",
    runId: `budget-run-${callId}`,
    prompt: "Take a screenshot of nu.nl",
    instructions: "Use tools when useful.",
    history: [],
    tools: [
      {
        name: "shell",
        description: "Run a command.",
        inputSchema: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
    ],
    model: { provider: testModel.provider, id: testModel.id, apiKey: "fake-key" },
    executeTool,
  } as unknown as AgentRunRequest;
}

async function run(input: AgentRunRequest, runtime = new PiAgentRuntime()) {
  const events: AgentRuntimeEvent[] = [];
  for await (const event of runtime.run(input, {
    operationId: "operation",
    traceId: "trace",
    spaceId: "space",
    userId: "user",
    signal: new AbortController().signal,
  })) {
    events.push(event);
  }
  return events;
}

const BUDGET_ENV = [
  "RAKAZO_RUN_MAX_MODEL_CALLS",
  "RAKAZO_RUN_MAX_MINUTES",
  "RAKAZO_RUN_BUDGET_BY_BOT",
  "RAKAZO_RUN_BUDGET_WARN_AT",
] as const;
const previousEnv = Object.fromEntries(BUDGET_ENV.map((name) => [name, process.env[name]]));

beforeEach(() => {
  providerState.models.clear();
  providerState.models.set(
    `${testModel.provider}/${testModel.id}`,
    testModel as unknown as Record<string, unknown>,
  );
  providerState.stream.mockReset();
  for (const name of BUDGET_ENV) delete process.env[name];
});

afterEach(() => {
  for (const name of BUDGET_ENV) {
    if (previousEnv[name] === undefined) delete process.env[name];
    else process.env[name] = previousEnv[name];
  }
});

describe("run budget", () => {
  it("reads both limits and treats unset, empty, zero, and invalid values as unlimited", () => {
    expect(runBudgetLimits({})).toEqual({ maxModelCalls: 0, maxMs: 0 });
    expect(
      runBudgetLimits({ RAKAZO_RUN_MAX_MODEL_CALLS: "", RAKAZO_RUN_MAX_MINUTES: "0" }),
    ).toEqual({ maxModelCalls: 0, maxMs: 0 });
    expect(
      runBudgetLimits({ RAKAZO_RUN_MAX_MODEL_CALLS: "-3", RAKAZO_RUN_MAX_MINUTES: "soon" }),
    ).toEqual({ maxModelCalls: 0, maxMs: 0 });
    expect(
      runBudgetLimits({ RAKAZO_RUN_MAX_MODEL_CALLS: " 40 ", RAKAZO_RUN_MAX_MINUTES: "20" }),
    ).toEqual({ maxModelCalls: 40, maxMs: 1_200_000 });
    expect(runBudgetLimits({ RAKAZO_RUN_MAX_MINUTES: "0.5" })).toEqual({
      maxModelCalls: 0,
      maxMs: 30_000,
    });
  });

  it("stops tools after the model-call limit and publishes the final line", async () => {
    process.env.RAKAZO_RUN_MAX_MODEL_CALLS = "2";
    const finalLine = "Tried shell Chromium twice; it hangs, so the screenshot is blocked.";
    providerState.stream.mockImplementation((_model, context) =>
      // The model ignores "No tools" once: the call must still not run.
      stream(
        isFinalTurn(context)
          ? message(
              [
                { type: "text", text: finalLine },
                {
                  type: "toolCall",
                  id: "ignored",
                  name: "shell",
                  arguments: { command: "chromium" },
                },
              ],
              "toolUse",
            )
          : toolTurn(),
      ),
    );
    const executeTool = vi.fn(async () => ({ ok: true }));

    const events = await run(request(executeTool));

    expect(providerState.stream).toHaveBeenCalledTimes(3);
    expect(providerState.stream.mock.calls.map(([, context]) => isFinalTurn(context))).toEqual([
      false,
      false,
      true,
    ]);
    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual({
      type: "progress",
      text: "Stopped: this task reached its limit of 2 model calls.",
    });
    expect(events.filter((event) => event.type === "text")).toEqual([
      { type: "text", text: finalLine },
    ]);
    expect(events.at(-1)).toEqual({ type: "done", text: finalLine });
  });

  it("stops after the minute limit, counting a long tool call, on a fake clock", async () => {
    process.env.RAKAZO_RUN_MAX_MINUTES = "20";
    let clock = 1_000_000;
    const finalLine = "Started the screenshot; Chromium hung past the time limit.";
    providerState.stream.mockImplementation((_model, context) =>
      stream(isFinalTurn(context) ? textTurn(finalLine) : toolTurn()),
    );
    // A hung shell command that only returns at its own timeout.
    const executeTool = vi.fn(async () => {
      clock += 21 * 60_000;
      return { ok: false, error: "command timed out after 300000 ms" };
    });

    const events = await run(request(executeTool), new PiAgentRuntime({ now: () => clock }));

    expect(providerState.stream).toHaveBeenCalledTimes(2);
    expect(isFinalTurn(providerState.stream.mock.calls[1]?.[1])).toBe(true);
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({
      type: "progress",
      text: "Stopped: this task reached its limit of 20 minutes.",
    });
    expect(events.at(-1)).toEqual({ type: "done", text: finalLine });
  });

  it("ends with the fixed line, still completed, when the final turn fails", async () => {
    process.env.RAKAZO_RUN_MAX_MODEL_CALLS = "1";
    providerState.stream.mockImplementation((_model, context) =>
      stream(isFinalTurn(context) ? message([], "error", "invalid api key") : toolTurn("Trying.")),
    );
    const executeTool = vi.fn(async () => ({ ok: true }));

    const events = await run(request(executeTool));

    expect(providerState.stream).toHaveBeenCalledTimes(2);
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.type === "text").at(-1)).toEqual({
      type: "text",
      text: RUN_BUDGET_FALLBACK_TEXT,
    });
    expect(events.at(-1)).toEqual({
      type: "done",
      text: `Trying.${RUN_BUDGET_FALLBACK_TEXT}`,
    });
  });

  it("does not limit a run when neither setting is set", async () => {
    let turns = 0;
    providerState.stream.mockImplementation(() => {
      turns += 1;
      return stream(turns <= 60 ? toolTurn() : textTurn("Done after sixty tool calls."));
    });
    const executeTool = vi.fn(async () => ({ ok: true }));
    let clock = 0;
    const runtime = new PiAgentRuntime({
      now: () => {
        clock += 60 * 60_000;
        return clock;
      },
    });

    const events = await run(request(executeTool), runtime);

    expect(providerState.stream).toHaveBeenCalledTimes(61);
    expect(executeTool).toHaveBeenCalledTimes(60);
    expect(providerState.stream.mock.calls.some(([, context]) => isFinalTurn(context))).toBe(false);
    expect(events.at(-1)).toEqual({ type: "done", text: "Done after sixty tool calls." });
  });

  it("replaces the global limits for the named bot only", () => {
    const env = {
      RAKAZO_RUN_MAX_MODEL_CALLS: "40",
      RAKAZO_RUN_MAX_MINUTES: "20",
      RAKAZO_RUN_BUDGET_BY_BOT: JSON.stringify({ jill: { modelCalls: 120, minutes: 45 } }),
    };
    expect(runBudgetLimits(env, "jill")).toEqual({ maxModelCalls: 120, maxMs: 2_700_000 });
    expect(runBudgetLimits(env, "josy")).toEqual({ maxModelCalls: 40, maxMs: 1_200_000 });
    expect(runBudgetLimits(env)).toEqual({ maxModelCalls: 40, maxMs: 1_200_000 });
  });

  it("falls back to the global value for a missing or invalid per-bot field", () => {
    const base = { RAKAZO_RUN_MAX_MODEL_CALLS: "40", RAKAZO_RUN_MAX_MINUTES: "20" };
    expect(
      runBudgetLimits(
        { ...base, RAKAZO_RUN_BUDGET_BY_BOT: JSON.stringify({ jill: { modelCalls: 120 } }) },
        "jill",
      ),
    ).toEqual({ maxModelCalls: 120, maxMs: 1_200_000 });
    expect(
      runBudgetLimits(
        { ...base, RAKAZO_RUN_BUDGET_BY_BOT: JSON.stringify({ jill: { minutes: 45 } }) },
        "jill",
      ),
    ).toEqual({ maxModelCalls: 40, maxMs: 2_700_000 });
    expect(
      runBudgetLimits(
        {
          ...base,
          RAKAZO_RUN_BUDGET_BY_BOT: JSON.stringify({ jill: { modelCalls: -1, minutes: "lots" } }),
        },
        "jill",
      ),
    ).toEqual({ maxModelCalls: 40, maxMs: 1_200_000 });
  });

  it("ignores per-bot budgets that are not valid JSON or not an object", () => {
    const base = { RAKAZO_RUN_MAX_MODEL_CALLS: "40", RAKAZO_RUN_MAX_MINUTES: "20" };
    for (const raw of ['{"jill": {"modelCalls": 120', "[1, 2]", "null", '{"jill": 5}']) {
      expect(runBudgetLimits({ ...base, RAKAZO_RUN_BUDGET_BY_BOT: raw }, "jill")).toEqual({
        maxModelCalls: 40,
        maxMs: 1_200_000,
      });
    }
  });

  it("applies the run's own bot budget at run time", async () => {
    process.env.RAKAZO_RUN_MAX_MODEL_CALLS = "5";
    process.env.RAKAZO_RUN_BUDGET_BY_BOT = JSON.stringify({ bot: { modelCalls: 1 } });
    providerState.stream.mockImplementation((_model, context) =>
      stream(isFinalTurn(context) ? textTurn("Ran one command.") : toolTurn()),
    );
    const executeTool = vi.fn(async () => ({ ok: true }));

    const events = await run(request(executeTool));

    expect(providerState.stream).toHaveBeenCalledTimes(2);
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({
      type: "progress",
      text: "Stopped: this task reached its limit of 1 model calls.",
    });
  });

  it("reads the warning fraction and treats unset, 0, and out-of-range values as off", () => {
    expect(runBudgetWarnAt({})).toBe(0);
    expect(runBudgetWarnAt({ RAKAZO_RUN_BUDGET_WARN_AT: "0" })).toBe(0);
    expect(runBudgetWarnAt({ RAKAZO_RUN_BUDGET_WARN_AT: "1.2" })).toBe(0);
    expect(runBudgetWarnAt({ RAKAZO_RUN_BUDGET_WARN_AT: "soon" })).toBe(0);
    expect(runBudgetWarnAt({ RAKAZO_RUN_BUDGET_WARN_AT: " 0.8 " })).toBe(0.8);
  });

  it("warns once at 80% of model calls, tools on, then keeps the final turn unchanged", async () => {
    process.env.RAKAZO_RUN_MAX_MODEL_CALLS = "5";
    process.env.RAKAZO_RUN_BUDGET_WARN_AT = "0.8";
    const finalLine = "Saved progress to notes.md; next step is the failing test.";
    providerState.stream.mockImplementation((_model, context) =>
      stream(isFinalTurn(context) ? textTurn(finalLine) : toolTurn()),
    );
    const executeTool = vi.fn(async () => ({ ok: true }));

    const events = await run(request(executeTool));

    const contexts = providerState.stream.mock.calls.map(([, context]) => context);
    expect(contexts).toHaveLength(6);
    expect(contexts.map((context) => warningText(context))).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      "Run budget almost used (4 of 5 model calls). Save your progress now so the next run can continue: where you are, what is done, the exact next step. Then stop or finish.",
      undefined,
    ]);
    // The warning turn keeps tools on: its tool call ran.
    expect(executeTool).toHaveBeenCalledTimes(5);
    expect(contexts.map((context) => isFinalTurn(context))).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
    expect(events).toContainEqual({
      type: "progress",
      text: "Stopped: this task reached its limit of 5 model calls.",
    });
    expect(events.at(-1)).toEqual({ type: "done", text: finalLine });
  });

  it("warns once at 80% of minutes when that comes before 80% of model calls", async () => {
    process.env.RAKAZO_RUN_MAX_MODEL_CALLS = "100";
    process.env.RAKAZO_RUN_MAX_MINUTES = "10";
    process.env.RAKAZO_RUN_BUDGET_WARN_AT = "0.8";
    let clock = 0;
    providerState.stream.mockImplementation((_model, context) =>
      stream(isFinalTurn(context) ? textTurn("Out of time.") : toolTurn()),
    );
    const executeTool = vi.fn(async () => {
      clock += 3 * 60_000;
      return { ok: true };
    });

    const events = await run(request(executeTool), new PiAgentRuntime({ now: () => clock }));

    const contexts = providerState.stream.mock.calls.map(([, context]) => context);
    expect(contexts.map((context) => warningText(context))).toEqual([
      undefined,
      undefined,
      undefined,
      "Run budget almost used (3 of 100 model calls / 9 of 10 minutes). Save your progress now so the next run can continue: where you are, what is done, the exact next step. Then stop or finish.",
      undefined,
    ]);
    expect(isFinalTurn(contexts.at(-1))).toBe(true);
    expect(events).toContainEqual({
      type: "progress",
      text: "Stopped: this task reached its limit of 10 minutes.",
    });
    expect(events.at(-1)).toEqual({ type: "done", text: "Out of time." });
  });

  it.each([undefined, "0"])("does not warn when the warning setting is %s", async (warnAt) => {
    process.env.RAKAZO_RUN_MAX_MODEL_CALLS = "5";
    if (warnAt !== undefined) process.env.RAKAZO_RUN_BUDGET_WARN_AT = warnAt;
    providerState.stream.mockImplementation((_model, context) =>
      stream(isFinalTurn(context) ? textTurn("Stopped.") : toolTurn()),
    );

    const events = await run(request());

    const contexts = providerState.stream.mock.calls.map(([, context]) => context);
    expect(contexts).toHaveLength(6);
    expect(contexts.some((context) => warningText(context) !== undefined)).toBe(false);
    expect(isFinalTurn(contexts.at(-1))).toBe(true);
    expect(events.at(-1)).toEqual({ type: "done", text: "Stopped." });
  });
});
