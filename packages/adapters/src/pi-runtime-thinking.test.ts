import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const providerState = vi.hoisted(() => ({
  models: new Map<string, Record<string, unknown>>(),
  stream: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: (provider: string, id: string) => providerState.models.get(`${provider}/${id}`),
    streamSimple: (...args: unknown[]) => providerState.stream(...args),
  }),
}));

vi.mock("./pi-local-provider.js", () => ({ registerLocalProvider: (models: unknown) => models }));
vi.mock("./pi-openai-compatible-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  registerOpenAiCompatibleCatalog: (models: unknown) => models,
  registerOpenAiCompatibleRuntime: (models: unknown) => models,
}));

import { PiAgentRuntime } from "./pi-runtime.js";

const testModel: Model<"anthropic-messages"> = {
  provider: "provider-a",
  id: "thinking-model",
  name: "thinking-model",
  api: "anthropic-messages",
  baseUrl: "https://models.invalid",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_768,
  maxTokens: 4_096,
};

function message(content: AssistantMessage["content"]): AssistantMessage {
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
    stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
    timestamp: Date.now(),
  };
}

/** Streams every part of `response` in order, the way a provider does. */
function stream(response: AssistantMessage) {
  const result = new AssistantMessageEventStream();
  result.push({ type: "start", partial: { ...response, content: [] } });
  response.content.forEach((part, contentIndex) => {
    if (part.type === "thinking") {
      result.push({ type: "thinking_start", contentIndex, partial: response });
      const thinking = part.thinking;
      result.push({ type: "thinking_delta", contentIndex, delta: thinking, partial: response });
      result.push({ type: "thinking_end", contentIndex, content: thinking, partial: response });
    } else if (part.type === "text") {
      result.push({ type: "text_start", contentIndex, partial: response });
      result.push({ type: "text_delta", contentIndex, delta: part.text, partial: response });
      result.push({ type: "text_end", contentIndex, content: part.text, partial: response });
    } else if (part.type === "toolCall") {
      result.push({ type: "toolcall_start", contentIndex, partial: response });
      result.push({ type: "toolcall_end", contentIndex, toolCall: part, partial: response });
    }
  });
  result.push({ type: "done", reason: response.stopReason as "stop", message: response });
  result.end(response);
  return result;
}

function request(): AgentRunRequest {
  return {
    botId: "bot",
    threadId: "thread",
    runId: "thinking-run",
    prompt: "Is the build green?",
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
    executeTool: vi.fn(async () => ({ ok: true, output: "passed" })),
  } as unknown as AgentRunRequest;
}

async function run(input: AgentRunRequest) {
  const events: AgentRuntimeEvent[] = [];
  for await (const event of new PiAgentRuntime().run(input, {
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

beforeEach(() => {
  providerState.models.clear();
  providerState.models.set(
    `${testModel.provider}/${testModel.id}`,
    testModel as unknown as Record<string, unknown>,
  );
  providerState.stream.mockReset();
});

describe("model thinking", () => {
  it("emits each model call's thinking once, before that call's text and tool call", async () => {
    providerState.stream
      .mockImplementationOnce(() =>
        stream(
          message([
            { type: "thinking", thinking: "The user wants CI status." },
            { type: "thinking", thinking: "Run the tests first." },
            { type: "toolCall", id: "call-1", name: "shell", arguments: { command: "pnpm test" } },
          ]),
        ),
      )
      .mockImplementationOnce(() =>
        stream(
          message([
            { type: "thinking", thinking: "Tests passed; answer briefly." },
            { type: "text", text: "Yes, the build is green." },
          ]),
        ),
      );

    const events = await run(request());

    expect(events.filter((event) => event.type === "thinking" || event.type === "text")).toEqual([
      { type: "thinking", text: "The user wants CI status.\n\nRun the tests first." },
      { type: "thinking", text: "Tests passed; answer briefly." },
      { type: "text", text: "Yes, the build is green." },
    ]);
    const activity = events.findIndex((event) => event.type === "progress");
    expect(activity).toBeGreaterThan(events.findIndex((event) => event.type === "thinking"));
    expect(events.at(-1)).toEqual({ type: "done", text: "Yes, the build is green." });
  });

  it("emits nothing for empty or redacted thinking", async () => {
    providerState.stream.mockImplementationOnce(() =>
      stream(
        message([
          { type: "thinking", thinking: "  ", redacted: true },
          { type: "text", text: "Done." },
        ]),
      ),
    );

    const events = await run(request());

    expect(events.some((event) => event.type === "thinking")).toBe(false);
    expect(events.filter((event) => event.type === "text")).toEqual([
      { type: "text", text: "Done." },
    ]);
  });
});
