import type { AgentRuntimeEvent, ConnectorTool } from "@rakazo/adapter-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fakeAgentState = vi.hoisted(() => ({
  options: ["Berlin", "Seoul", "Toronto"],
  draft: undefined as unknown,
  todoArgs: undefined as Record<string, unknown> | undefined,
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
        ...fakeAgentState.todoArgs,
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
    fakeAgentState.todoArgs = undefined;
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

  const seoul = {
    key: "city-access:seoul",
    title: "Open the Seoul office account",
    steps:
      "1. Sign in at https://office.example/admin\n2. Open Accounts → Seoul and click Enable (not checked)",
    why: "The Seoul team cannot work until the account is enabled; I check its status page.",
    verification: "automatic",
  };
  const badge = {
    key: "city-badge:seoul",
    title: "Pick up the Seoul door badge",
    steps: "1. Collect the badge at reception (desk 2).",
    why: "Without the badge the door stays shut; only you can confirm you have it.",
    verification: "manual",
    blocks: [{ issue: 142 }, "release 6.4"],
  };

  it("marks the to-do option and carries every prerequisite item onto the ask", async () => {
    fakeAgentState.todoArgs = {
      prerequisites: [seoul, badge],
      option: "Seoul",
      release: "each",
      priority: "p1",
      caseRef: 383,
    };
    const runtime = new PiAgentRuntime();
    const events: AgentRuntimeEvent[] = [];

    for await (const event of runtime.run(runRequest, runContext)) events.push(event);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "ask",
        actions: [
          { id: "choice-1", label: "Berlin" },
          { id: "choice-2", label: "Seoul", todo: true },
          { id: "choice-3", label: "Toronto" },
        ],
        prerequisites: {
          items: [seoul, badge],
          release: "each",
          priority: "p1",
          caseRef: 383,
        },
      }),
    );
  });

  it("rejects a case ref that is not a tracker issue number", async () => {
    for (const caseRef of ["383", 0, 3.5]) {
      fakeAgentState.todoArgs = { prerequisites: [seoul], option: "Seoul", caseRef };
      const runtime = new PiAgentRuntime();
      await expect(async () => {
        for await (const _event of runtime.run(runRequest, runContext));
      }).rejects.toThrow("ask_user prerequisites refused: caseRef");
    }
  });

  it("releases all items together unless told otherwise", async () => {
    fakeAgentState.todoArgs = { prerequisites: [seoul], option: "Seoul" };
    const runtime = new PiAgentRuntime();
    const events: AgentRuntimeEvent[] = [];

    for await (const event of runtime.run(runRequest, runContext)) events.push(event);

    expect(events).toContainEqual(
      expect.objectContaining({ prerequisites: { items: [seoul], release: "all" } }),
    );
  });

  it("rejects a to-do option that is not one of the options", async () => {
    fakeAgentState.todoArgs = { prerequisites: [seoul], option: "Paris" };
    const runtime = new PiAgentRuntime();
    const events: AgentRuntimeEvent[] = [];

    await expect(async () => {
      for await (const event of runtime.run(runRequest, runContext)) events.push(event);
    }).rejects.toThrow("ask_user option must be exactly one of the options");
    expect(events.some((event) => event.type === "ask")).toBe(false);
  });

  /** Runs ask_user with `todoArgs`; returns the refusal (empty when accepted) and whether it asked. */
  async function attempt(todoArgs: Record<string, unknown>) {
    fakeAgentState.todoArgs = todoArgs;
    const events: AgentRuntimeEvent[] = [];
    let refusal = "";
    try {
      for await (const event of new PiAgentRuntime().run(runRequest, runContext)) {
        events.push(event);
      }
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    return { refusal, asked: events.some((event) => event.type === "ask") };
  }

  it("refuses an item without why or numbered steps, naming each item and field to fix", async () => {
    const { refusal, asked } = await attempt({
      prerequisites: [
        { ...seoul, why: undefined },
        { ...badge, steps: "Collect the badge at reception." },
      ],
      option: "Seoul",
    });
    expect(asked).toBe(false);
    expect(refusal).toContain('item "city-access:seoul" why:');
    expect(refusal).toContain('item "city-badge:seoul" steps:');
    expect(refusal).not.toContain('item "city-access:seoul" steps:');
    expect(refusal).not.toContain('item "city-badge:seoul" why:');
  });

  it("refuses a blank why and accepts the same item once it has one", async () => {
    const blank = await attempt({ prerequisites: [{ ...seoul, why: "   " }], option: "Seoul" });
    expect(blank.asked).toBe(false);
    expect(blank.refusal).toContain('item "city-access:seoul" why:');
    expect(await attempt({ prerequisites: [seoul], option: "Seoul" })).toEqual({
      refusal: "",
      asked: true,
    });
  });

  it("rejects items that repeat a key or miss their steps", async () => {
    for (const prerequisites of [
      [seoul, { ...badge, key: seoul.key }],
      [{ ...seoul, steps: "" }],
    ]) {
      const { refusal, asked } = await attempt({ prerequisites, option: "Seoul" });
      expect(asked).toBe(false);
      expect(refusal).toMatch(/^ask_user prerequisites refused: /);
    }
  });

  it("carries the full customer inquiry and the source version onto a reply card", async () => {
    const inquiry = `Hi,\n\n${"My licence stopped working. ".repeat(400)}\n\nKonstantin`;
    fakeAgentState.draft = "Hi Konstantin,\n\nFixed.\n\nRens";
    fakeAgentState.todoArgs = { inquiry, source: { ref: "zendesk:3529", version: "42" } };
    const runtime = new PiAgentRuntime();
    const events: AgentRuntimeEvent[] = [];

    for await (const event of runtime.run(runRequest, runContext)) events.push(event);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "ask",
        inquiry,
        source: { ref: "zendesk:3529", version: "42" },
      }),
    );
  });

  it("rejects a source without a version and an inquiry over 20,000 characters", async () => {
    for (const [args, message] of [
      [{ source: { ref: "zendesk:3529" } }, "ask_user source needs ref and version"],
      [{ inquiry: "x".repeat(20_001) }, "ask_user inquiry must be text of at most 20000"],
    ] as const) {
      fakeAgentState.todoArgs = args;
      const runtime = new PiAgentRuntime();
      await expect(async () => {
        for await (const _event of runtime.run(runRequest, runContext));
      }).rejects.toThrow(message);
    }
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
