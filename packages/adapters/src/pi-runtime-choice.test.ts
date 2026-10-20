import type { AgentRuntimeEvent, ConnectorTool } from "@rakazo/adapter-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fakeAgentState = vi.hoisted(() => ({
  options: ["Berlin", "Seoul", "Toronto"],
  draft: undefined as unknown,
  results: [] as unknown[],
  tools: [] as Array<{
    name: string;
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
  }>,
}));

vi.mock("@earendil-works/pi-agent-core", () => ({
  Agent: class {
    state = { errorMessage: undefined, messages: [] };
    private readonly tools: typeof fakeAgentState.tools;

    constructor(options: { initialState: { tools: typeof fakeAgentState.tools } }) {
      this.tools = options.initialState.tools;
      fakeAgentState.tools = this.tools;
    }

    subscribe(_listener: unknown) {}

    async prompt() {
      const askUser = this.tools.find((tool) => tool.name === "ask_user");
      if (!askUser) throw new Error("ask_user tool missing");
      const result = await askUser.execute("call-choice-1", {
        question: "Which city should I use?",
        options: fakeAgentState.options,
        ...(fakeAgentState.draft === undefined ? {} : { draft: fakeAgentState.draft }),
      });
      fakeAgentState.results.push(result);
    }

    async waitForIdle() {}

    abort() {}
  },
}));

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: (_provider: string, modelId: string) =>
      modelId === "choice-pi-model" ? { provider: "test", id: modelId } : undefined,
    streamSimple: () => {
      throw new Error("the fake agent must not call a provider");
    },
  }),
}));

vi.mock("./pi-local-provider.js", () => ({
  registerLocalProvider: (models: unknown) => models,
}));

vi.mock("./pi-openai-compatible-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  registerOpenAiCompatibleCatalog: (models: unknown) => models,
  registerOpenAiCompatibleRuntime: (models: unknown) => models,
}));

import { builtinAgentTools } from "./builtin-tools.js";
import { PiAgentRuntime } from "./pi-runtime.js";

const choiceTool: ConnectorTool = {
  name: "ask_user",
  description: "Ask a short multiple-choice question",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string" },
      options: { type: "array", items: { type: "string" } },
    },
    required: ["question", "options"],
  },
};

const runContext = {
  operationId: "choice-pi",
  traceId: "choice-pi",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};

const runRequest = {
  botId: "bot",
  threadId: "thread",
  runId: "run",
  prompt: "ask me which city to use",
  instructions: "Use ask_user for a short list of options.",
  history: [],
  tools: [choiceTool],
  model: { provider: "test", id: "choice-pi-model" },
};

describe("Pi choice asks", () => {
  beforeEach(() => {
    fakeAgentState.tools = [];
    fakeAgentState.options = ["Berlin", "Seoul", "Toronto"];
    fakeAgentState.draft = undefined;
    fakeAgentState.results = [];
  });

  it("emits a tappable ask and stops without a finished-work fallback", async () => {
    const runtime = new PiAgentRuntime();
    const events: AgentRuntimeEvent[] = [];

    for await (const event of runtime.run(runRequest, runContext)) events.push(event);

    expect(events).toContainEqual({
      type: "ask",
      text: "Which city should I use?",
      actions: [
        { id: "choice-1", label: "Berlin" },
        { id: "choice-2", label: "Seoul" },
        { id: "choice-3", label: "Toronto" },
      ],
    });
    expect(
      events.some((event) => event.type === "text" && event.text.includes("I finished the work.")),
    ).toBe(false);
  });

  it("rejects an empty choice set before emitting an ask", async () => {
    fakeAgentState.options = [];
    const runtime = new PiAgentRuntime();
    const events: AgentRuntimeEvent[] = [];

    await expect(async () => {
      for await (const event of runtime.run(runRequest, runContext)) events.push(event);
    }).rejects.toThrow("ask_user requires two to four unique, non-empty options");
    expect(events.some((event) => event.type === "ask")).toBe(false);
  });

  it("offers an optional reply draft of at most 20,000 characters", () => {
    const askUser = builtinAgentTools.find((tool) => tool.name === "ask_user");
    expect(askUser?.inputSchema).toMatchObject({
      properties: { draft: { type: "string", maxLength: 20_000 } },
      required: ["question", "options"],
    });
  });

  it("carries the reply draft onto the ask", async () => {
    fakeAgentState.draft = "Hi Konstantin,\n\nYour licence is active again.\n\nRens";
    const runtime = new PiAgentRuntime();
    const events: AgentRuntimeEvent[] = [];

    for await (const event of runtime.run(runRequest, runContext)) events.push(event);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "ask",
        text: "Which city should I use?",
        draft: "Hi Konstantin,\n\nYour licence is active again.\n\nRens",
      }),
    );
  });

  it("rejects a draft over 20,000 characters before emitting an ask", async () => {
    fakeAgentState.draft = "x".repeat(20_001);
    const runtime = new PiAgentRuntime();
    const events: AgentRuntimeEvent[] = [];

    await expect(async () => {
      for await (const event of runtime.run(runRequest, runContext)) events.push(event);
    }).rejects.toThrow("ask_user draft must be text of at most 20000 characters");
    expect(events.some((event) => event.type === "ask")).toBe(false);
  });

  it("returns the consumer's refusal without pausing when no card was made", async () => {
    const refusal =
      "Not asked: the same card is already open in Rens's queue (asked 05:26 UTC). Don't ask it again; his answer comes to the run that asked it.";
    const runtime = new PiAgentRuntime();
    const asks: AgentRuntimeEvent[] = [];

    for await (const event of runtime.run({ ...runRequest, settlesAsks: true }, runContext)) {
      if (event.type !== "ask") continue;
      asks.push(event);
      event.settle?.(refusal);
    }

    expect(asks).toHaveLength(1);
    expect(fakeAgentState.results).toEqual([
      expect.objectContaining({
        content: [{ type: "text", text: refusal }],
        details: expect.objectContaining({ notAsked: true }),
      }),
    ]);
    expect(fakeAgentState.results[0]).not.toHaveProperty("terminate");
  });

  it("pauses once the consumer has stored the card", async () => {
    const runtime = new PiAgentRuntime();

    for await (const event of runtime.run({ ...runRequest, settlesAsks: true }, runContext)) {
      if (event.type === "ask") event.settle?.(null);
    }

    expect(fakeAgentState.results).toEqual([
      expect.objectContaining({
        content: [{ type: "text", text: "Waiting for the user's choice." }],
        terminate: true,
      }),
    ]);
  });
});
