import type { Agent, AgentMessage, AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/pi-ai";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { sanitizeSensitiveText } from "./activity-details.js";
import { toolResultOverflowStore, type ToolResultOverflowSnapshot } from "./tool-result-overflow.js";

export class MaintenanceBoundary extends Error {
  constructor(readonly revision?: number) { super("Maintenance admission closed"); }
}

/** Raised before any restored work starts, never after consuming a continuation. */
export class MaintenanceContinuationUnavailable extends Error {
  constructor(reason = "runtime-tool-binding-changed") { super(reason); }
}

type DeferredTool = { id: string; name: string; args: unknown };
type SavedAgent = {
  messages: AgentMessage[];
  systemPrompt: string;
  streamed: string;
  queued: AgentMessage[];
  deferred: DeferredTool[];
  complete: boolean;
};
type Continuation = {
  kind: "pi-maintenance-v1";
  runId: string;
  agents: Record<string, SavedAgent>;
  streamed: string;
  seenSteeringIds: string[];
  overflow: ToolResultOverflowSnapshot;
  tools: string;
  budget: { modelCalls: number; usedMs: number; warned: boolean; toolCalls: number };
};

function assertJsonValue(value: unknown): asserts value is JsonValue {
  // Reject unsupported/cyclic data instead of dropping fields from a checkpoint.
  stableJsonValue(value);
}

/** Only runtime-owned transcripts are continuations; a takeover label is not one. */
export function readPiMaintenance(blob: string | undefined, runId: string): Continuation | undefined {
  if (!blob || !blob.startsWith("{")) return undefined;
  const value = JSON.parse(blob) as Continuation;
  if (value.kind !== "pi-maintenance-v1") throw new Error("Unsupported runtime continuation");
  if (value.runId !== runId || !value.agents?.main || !value.budget ||
    !Array.isArray(value.seenSteeringIds) || typeof value.streamed !== "string" || typeof value.tools !== "string") {
    throw new Error("Invalid runtime continuation");
  }
  for (const saved of Object.values(value.agents)) {
    if (!Array.isArray(saved.messages) || !Array.isArray(saved.queued) || !Array.isArray(saved.deferred) ||
      typeof saved.systemPrompt !== "string" || typeof saved.streamed !== "string") {
      throw new Error("Incomplete runtime continuation");
    }
  }
  return value;
}

/** Shared by the main agent and its helpers. No abort signal is used for a graceful hold. */
export class PiMaintenance {
  paused = false;
  readonly restored: Continuation | undefined;
  private readonly saved: Record<string, SavedAgent> = {};
  private readonly deferred = new Map<string, DeferredTool[]>();
  private readonly beforeModel = new Map<string, SavedAgent>();
  private tools = "";

  constructor(private readonly request: AgentRunRequest, private readonly signal: AbortSignal) {
    try {
      this.restored = readPiMaintenance(request.resumeFromCheckpoint, request.runId);
      Object.assign(this.saved, this.restored?.agents);
      if (this.restored) toolResultOverflowStore.restore(request.runId, this.restored.overflow);
    } catch {
      throw new MaintenanceContinuationUnavailable("runtime-continuation-invalid");
    }
  }

  async admit(): Promise<boolean> {
    if (this.paused) return false;
    if (this.request.beforeExecution && !(await this.request.beforeExecution())) this.paused = true;
    return !this.paused;
  }

  async prepare(agent: Agent, namespace = "main"): Promise<void> {
    if (!this.request.beforeExecution && !this.restored) return;
    // Keep the untransformed transcript, not a reconstructed chat/history prompt.
    this.beforeModel.set(namespace, this.snapshot(agent, namespace));
    if (!(await this.admit())) throw new MaintenanceBoundary();
  }

  defer(namespace: string, id: string, name: string, args: unknown): AgentToolResult<unknown> {
    const pending = this.deferred.get(namespace) ?? [];
    if (!pending.some((item) => item.id === id)) pending.push({ id, name, args });
    this.deferred.set(namespace, pending);
    return { content: [{ type: "text", text: "Not executed: maintenance pause." }],
      details: { maintenanceDeferred: true }, terminate: true };
  }

  restore(namespace: string): SavedAgent | undefined { return this.restored?.agents[namespace]; }

  bindTools(tools: string): void {
    if (this.restored && this.restored.tools !== tools) throw new MaintenanceContinuationUnavailable();
    this.tools = tools;
  }

  private snapshot(agent: Agent, namespace: string, complete = false, streamed = ""): SavedAgent {
    return { systemPrompt: agent.state.systemPrompt, streamed,
      messages: [...agent.state.messages], queued: agent.peekQueuedMessages(),
      deferred: [...(this.deferred.get(namespace) ?? [])], complete };
  }

  capture(agent: Agent, namespace = "main", complete = false, streamed = ""): void {
    const last = agent.state.messages.at(-1);
    // Pi encodes a rejected prepareRequest/stream as an assistant error. That synthetic
    // error never ran a model and must not become part of the resumed transcript.
    const deniedModel = last?.role === "assistant" && last.errorMessage === "Maintenance admission closed";
    this.saved[namespace] = deniedModel && this.beforeModel.has(namespace)
      ? this.beforeModel.get(namespace)!
      : this.snapshot(agent, namespace, complete, streamed);
    this.saved[namespace]!.streamed = streamed;
  }

  async replay(agent: Agent, tools: AgentTool[], namespace = "main"): Promise<void> {
    const restored = this.restore(namespace);
    if (!restored) return;
    const messages = [...restored.messages];
    for (const pending of restored.deferred) {
      const tool = tools.find((candidate) => candidate.name === pending.name);
      if (!tool) throw new Error(`Continuation tool unavailable: ${pending.name}`);
      let result: AgentToolResult<unknown>;
      let isError = false;
      try {
        result = await tool.execute(pending.id, pending.args as never);
      } catch (error) {
        if (this.signal.aborted) throw error;
        isError = true;
        result = { content: [{ type: "text", text: sanitizeSensitiveText(
          error instanceof Error ? error.message : String(error)) }], details: undefined };
      }
      const index = messages.findIndex((message) => message.role === "toolResult" && message.toolCallId === pending.id);
      if (index < 0) throw new Error("Continuation tool result binding missing");
      const previous = messages[index]!;
      if (previous.role !== "toolResult") throw new Error("Continuation tool result binding changed");
      const details = result.details;
      if (details !== undefined) assertJsonValue(details);
      messages[index] = { ...previous, content: result.content, details, isError };
    }
    agent.state.messages = messages;
    for (const message of restored.queued) agent.followUp(message);
  }

  encode(streamed: string, budget: Continuation["budget"], seenSteeringIds: string[]): string {
    if (!this.saved.main) throw new Error("Drained main transcript required");
    return JSON.stringify({ kind: "pi-maintenance-v1", runId: this.request.runId,
      agents: this.saved, streamed, budget, seenSteeringIds,
      overflow: toolResultOverflowStore.snapshot(this.request.runId), tools: this.tools } satisfies Continuation);
  }
}
