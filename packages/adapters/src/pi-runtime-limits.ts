import { DEFAULT_MODEL_MAX_TOKENS } from "@rakazo/contracts";
import { cutOffNote } from "./tool-result-overflow.js";

/** Hung completions must fail before the typical 5-minute run lease. */
export const MODEL_STREAM_TIMEOUT_MS = 120_000;
/**
 * `timeoutMs` bounds only time-to-headers; the SSE body that follows is
 * unbounded. A Codex stream silent this long is a dead connection — reasoning
 * models emit thinking deltas continuously while generating.
 */
export const MODEL_STREAM_IDLE_TIMEOUT_MS = 180_000;
export const DEFAULT_MODEL_STREAM_MAX_RETRIES = 1;

/** More retries extend the worst-case turn; the executor heartbeat renews its leases. */
export function modelStreamMaxRetries(): number {
  const value = process.env.MODEL_STREAM_MAX_RETRIES?.trim();
  const raw = Number(value || DEFAULT_MODEL_STREAM_MAX_RETRIES);
  return Number.isInteger(raw) && raw >= 0 && raw <= 5 ? raw : DEFAULT_MODEL_STREAM_MAX_RETRIES;
}

export const TOOL_RESULT_TEXT_LIMIT = 12_000;

/**
 * Cut text over `limit` and end it with a plain line saying how much was shown.
 * With `ref` (a kept copy, `RAKAZO_TOOL_RESULT_OVERFLOW`), the line says how to read the rest.
 */
export function clipToolResultText(
  text: string,
  limit: number = TOOL_RESULT_TEXT_LIMIT,
  ref?: string,
): string {
  return text.length > limit
    ? `${text.slice(0, limit)}\n${cutOffNote(limit, text.length, ref)}`
    : text;
}

/**
 * Share one remaining character budget across all text parts.
 * Later text is omitted once the aggregate limit is exhausted; non-text parts stay.
 * When text is cut, `keep` receives all text parts joined (so offsets match what was shown)
 * and may return a ref for the cut-off line.
 */
export function clipToolResultContent<T>(
  content: T[],
  limit: number = TOOL_RESULT_TEXT_LIMIT,
  keep?: (fullText: string) => string | undefined,
): T[] {
  const isText = (part: T): part is T & { type: "text"; text: unknown } =>
    Boolean(part) &&
    typeof part === "object" &&
    "type" in (part as object) &&
    (part as { type?: unknown }).type === "text" &&
    "text" in (part as object);
  const texts = content.filter(isText).map((part) => String(part.text));
  const total = texts.reduce((sum, text) => sum + text.length, 0);
  if (total <= limit) return content;
  const note = cutOffNote(limit, total, keep?.(texts.join("")));
  let remaining = limit;
  let noted = false;
  const clipped: T[] = [];
  for (const part of content) {
    if (!isText(part)) {
      clipped.push(part);
      continue;
    }
    if (remaining <= 0) continue;
    const text = String(part.text);
    if (text.length <= remaining) {
      clipped.push(part);
      remaining -= text.length;
      continue;
    }
    clipped.push({ ...part, text: `${text.slice(0, remaining)}\n${note}` });
    remaining = 0;
    noted = true;
  }
  if (!noted) clipped.push({ type: "text", text: note } as T);
  return clipped;
}

/**
 * Prompt tokens providers bill, including cache read/write rather than the uncached remainder.
 * The cache halves are reported alongside so downstream views can show what a cache hit saved.
 */
export function billedPromptTokens(usage: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
} {
  const cacheReadTokens = nonNegativeCount(usage.cacheRead);
  const cacheWriteTokens = nonNegativeCount(usage.cacheWrite);
  return {
    inputTokens: nonNegativeCount(usage.input) + cacheReadTokens + cacheWriteTokens,
    outputTokens: nonNegativeCount(usage.output),
    cacheReadTokens,
    cacheWriteTokens,
  };
}

/**
 * A reasoning model spends this same budget on its thinking, so the modest default
 * can be consumed before the reply starts. Wide enough for thinking plus an answer,
 * still far below a model card's 128k ceiling.
 */
export const REASONING_MODEL_MAX_TOKENS = 32_768;

/**
 * Completions default to a modest output cap so OpenRouter-style providers do not
 * hold credit for a model card's 128k ceiling. A configured maxTokens is the escape.
 * Reasoning models get the wider default because their thinking is billed against
 * the same ceiling: at 4k a hard question can leave no room for the reply at all.
 */
export function resolveCompletionMaxTokens(
  modelMaxTokens?: number,
  configuredMaxTokens?: number,
  optionsMaxTokens?: number,
  reasoning?: boolean,
): number {
  const userCap =
    typeof configuredMaxTokens === "number" && configuredMaxTokens >= 1
      ? configuredMaxTokens
      : reasoning
        ? REASONING_MODEL_MAX_TOKENS
        : DEFAULT_MODEL_MAX_TOKENS;
  const optionCap =
    typeof optionsMaxTokens === "number" && optionsMaxTokens >= 1
      ? Math.min(optionsMaxTokens, userCap)
      : userCap;
  if (typeof modelMaxTokens === "number" && modelMaxTokens >= 1) {
    return Math.min(modelMaxTokens, optionCap);
  }
  return optionCap;
}

function nonNegativeCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}
