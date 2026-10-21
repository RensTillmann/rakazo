import type { ProductEvent, RunActivitySummary } from "@rakazo/contracts";

/**
 * Fleet (RAKAZO_ACTIVITY_DETAILS): a bot run as Pi-TUI-style terminal lines for the Live activity
 * window. Pure (events in, ANSI lines out) so it is testable without xterm. The bot runs Pi
 * in-process in the worker, so there is no real TUI to attach to; this replays and follows the
 * run's stored events instead.
 */

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const DIM_ITALIC = "\x1b[2;3m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const MAGENTA = "\x1b[35m";
const CYAN = "\x1b[36m";

/** Result lines shown under a tool call before the rest is folded. */
export const RESULT_PREVIEW_LINES = 20;
const ARGS_SUMMARY_MAX = 120;

const live = new Set<(event: ProductEvent) => void>();

/** Thread subscriptions forward every event to any open Live activity window. */
export function publishActivityEvent(event: ProductEvent) {
  for (const listener of live) listener(event);
}

export function subscribeActivityEvents(listener: (event: ProductEvent) => void) {
  live.add(listener);
  return () => {
    live.delete(listener);
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function count(value: number): string {
  return value.toLocaleString("en-GB");
}

function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function duration(ms: unknown): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function blocksOf(event: ProductEvent): Record<string, unknown>[] {
  const blocks = event.payload.blocks;
  return Array.isArray(blocks)
    ? blocks.filter(
        (block): block is Record<string, unknown> => Boolean(block) && typeof block === "object",
      )
    : [];
}

/** One line of the tool's arguments, as `name(…)` shows them. */
export function argsSummary(argsPreview: unknown): string {
  const oneLine = text(argsPreview).replace(/\s+/g, " ").trim();
  return oneLine.length > ARGS_SUMMARY_MAX ? `${oneLine.slice(0, ARGS_SUMMARY_MAX - 1)}…` : oneLine;
}

function toolResultLines(completed: ProductEvent): string[] {
  const payload = completed.payload;
  const lines: string[] = [];
  const outcome = text(payload.outcome) || "succeeded";
  const parts = [outcome];
  const took = duration(payload.durationMs);
  if (took) parts.push(took);
  if (typeof payload.resultChars === "number") parts.push(`${count(payload.resultChars)} chars`);
  const colour = outcome === "error" ? RED : outcome === "paused" ? YELLOW : DIM;
  lines.push(`  ${colour}⎿ ${parts.join(" · ")}${RESET}`);
  if (outcome === "error" && text(payload.error)) {
    lines.push(`    ${RED}${text(payload.error).replace(/\s+/g, " ")}${RESET}`);
  }
  const preview = text(payload.resultPreview);
  if (preview) {
    const previewLines = preview.split(/\r?\n/);
    for (const line of previewLines.slice(0, RESULT_PREVIEW_LINES)) lines.push(`    ${line}`);
    const more = previewLines.length - RESULT_PREVIEW_LINES;
    if (more > 0) lines.push(`    ${DIM}… ${count(more)} more lines${RESET}`);
  }
  if (
    payload.clipped === true &&
    typeof payload.shownChars === "number" &&
    typeof payload.resultChars === "number"
  ) {
    lines.push(
      `  ${YELLOW}⚠ cut off: showed ${count(payload.shownChars)} of ${count(payload.resultChars)} chars${RESET}`,
    );
  }
  return lines;
}

/** Steps (tool calls), the latest budget counters and elapsed time, for the status bar. */
export function activityStatus(events: readonly ProductEvent[]): {
  steps: number;
  modelCalls: number | null;
  elapsedMs: number;
} {
  let steps = 0;
  let modelCalls: number | null = null;
  for (const event of events) {
    if (event.type === "agent.tool.called") steps += 1;
    if (event.type === "agent.tool.completed" && typeof event.payload.modelCalls === "number") {
      modelCalls = event.payload.modelCalls;
    }
  }
  const first = events[0];
  const last = events.at(-1);
  const elapsedMs = first && last ? Date.parse(last.createdAt) - Date.parse(first.createdAt) : 0;
  return { steps, modelCalls, elapsedMs: Number.isFinite(elapsedMs) ? elapsedMs : 0 };
}

/** The run's status as the stream shows it: a finish event wins over the status loaded when the window opened. */
export function activityRunStatus(events: readonly ProductEvent[], loaded: string): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const type = events[index]?.type;
    if (type === "run.completed") return "finished";
    if (type === "run.failed") return "failed";
    if (type === "run.cancelled") return "stopped";
    if (type === "run.started") return "running";
    if (type === "run.checkpointed") {
      const status = events[index]?.payload.status;
      if (status === "maintenance_paused") return "paused";
      if (status === "queued") return "queued";
    }
  }
  return loaded === "maintenance_paused" ? "paused" : loaded;
}

/** "41,802 in (40,100 cached) / 155 out": provider input excludes cache reads and writes, so add them back. */
function modelTokens(payload: Record<string, unknown>): string {
  const number = (value: unknown) => (typeof value === "number" ? value : 0);
  const output = typeof payload.outputTokens === "number" ? count(payload.outputTokens) : "?";
  if (typeof payload.inputTokens !== "number") return `? in / ${output} out`;
  const cached = number(payload.cacheReadTokens);
  const input = payload.inputTokens + cached + number(payload.cacheWriteTokens);
  return `${count(input)} in${cached > 0 ? ` (${count(cached)} cached)` : ""} / ${output} out`;
}

export function activityStatusLine(events: readonly ProductEvent[]): string {
  const status = activityStatus(events);
  const parts = [`${status.steps} steps`];
  if (status.modelCalls !== null) parts.push(`${status.modelCalls} model calls`);
  parts.push(elapsed(status.elapsedMs));
  return parts.join(" · ");
}

/** The run as terminal lines, oldest first. */
export function renderActivityLines(
  events: readonly ProductEvent[],
  run: Pick<RunActivitySummary, "botName" | "trigger" | "promptSnippet" | "createdAt"> | null,
): string[] {
  const lines: string[] = [];
  if (run) {
    const started = new Date(run.createdAt).toLocaleString("en-GB");
    const snippet = run.promptSnippet ? ` · ${run.promptSnippet}` : "";
    lines.push(`${BOLD}${CYAN}▌ ${run.botName} · ${run.trigger}${snippet}${RESET}`);
    lines.push(`${DIM}  started ${started}${RESET}`);
    lines.push("");
  }
  const completions = new Map<string, ProductEvent>();
  const calledIds = new Set<string>();
  for (const event of events) {
    const executionId = text(event.payload.executionId);
    if (!executionId) continue;
    if (event.type === "agent.tool.completed") completions.set(executionId, event);
    if (event.type === "agent.tool.called") calledIds.add(executionId);
  }
  // Message events repeat earlier blocks on update; each block is shown once.
  const shownBlocks = new Set<string>();
  // Streamed text arrives as deltas; it is held until a line ends so lines are not split.
  let streaming = "";
  const flushText = () => {
    if (!streaming) return;
    for (const line of streaming.split(/\r?\n/)) lines.push(line);
    streaming = "";
  };
  for (const event of events) {
    const payload = event.payload;
    if (event.type === "thread.progress") {
      if (typeof payload.delta === "string") {
        streaming += payload.delta;
        continue;
      }
      if (text(payload.text)) {
        flushText();
        lines.push(`${DIM}  ${text(payload.text)}${RESET}`);
      }
      continue;
    }
    if (event.type === "thread.message.created" || event.type === "thread.message.updated") {
      const messageId = text(payload.messageId) || event.id;
      for (const [index, block] of blocksOf(event).entries()) {
        const key = `${messageId}:${index}`;
        if (shownBlocks.has(key)) continue;
        const hop = typeof block.hop === "number" ? ` (hop ${block.hop})` : "";
        const said = text(block.text).replace(/\s+/g, " ");
        if (block.kind === "thinking" && text(block.text)) {
          flushText();
          for (const line of text(block.text).split(/\r?\n/)) {
            lines.push(`${DIM_ITALIC}${line}${RESET}`);
          }
        } else if (block.kind === "bot_message_sent") {
          flushText();
          lines.push(`${MAGENTA}→ message to ${text(block.toBotName)}: ${said}${RESET}`);
        } else if (block.kind === "bot_message_received") {
          lines.push(`${MAGENTA}← message from ${text(block.fromBotName)}${hop}: ${said}${RESET}`);
        } else if (block.kind === "handoff") {
          flushText();
          lines.push(`${MAGENTA}⇢ handoff${hop}: ${said}${RESET}`);
        } else continue;
        shownBlocks.add(key);
      }
      continue;
    }
    if (event.type === "agent.tool.called") {
      flushText();
      lines.push(`${BOLD}● ${text(payload.name)}${RESET}(${argsSummary(payload.argsPreview)})`);
      const completed = completions.get(text(payload.executionId));
      if (completed) lines.push(...toolResultLines(completed));
      else lines.push(`  ${DIM}⎿ running…${RESET}`);
      continue;
    }
    if (event.type === "agent.tool.completed") {
      // Shown under its call; a completion without a stored call still gets a line.
      if (!calledIds.has(text(payload.executionId))) {
        flushText();
        lines.push(`${BOLD}● ${text(payload.name)}${RESET}()`, ...toolResultLines(event));
      }
      continue;
    }
    if (event.type === "agent.model.completed") {
      flushText();
      lines.push(`${DIM}  · ${text(payload.model)}: ${modelTokens(payload)} tokens${RESET}`);
      continue;
    }
    if (event.type === "thread.ask" || event.type === "run.waiting_input") {
      flushText();
      const question = text(payload.text) || text(payload.question) || text(payload.reason);
      lines.push(
        `${MAGENTA}? waiting for you${question ? `: ${question.replace(/\s+/g, " ")}` : ""}${RESET}`,
      );
      continue;
    }
    if (
      event.type === "run.completed" ||
      event.type === "run.failed" ||
      event.type === "run.cancelled"
    ) {
      flushText();
      const status = activityStatus(events.slice(0, events.indexOf(event) + 1));
      const summary = `${status.steps} steps · ${elapsed(status.elapsedMs)}`;
      if (event.type === "run.completed") lines.push(`${GREEN}✓ run finished · ${summary}${RESET}`);
      else if (event.type === "run.failed") {
        const error = text(payload.error);
        lines.push(`${RED}✗ run failed · ${summary}${error ? ` · ${error}` : ""}${RESET}`);
      } else lines.push(`${YELLOW}■ run stopped · ${summary}${RESET}`);
    }
  }
  flushText();
  return lines;
}
