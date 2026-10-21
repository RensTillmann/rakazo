/**
 * Fleet: the full text of a tool result the runtime cut off, kept for the rest of the run
 * so the model can page through it with `read_tool_result`. A graceful runtime checkpoint
 * saves these bounded, already-sanitized pages with their original references.
 */

export const READ_TOOL_RESULT_TOOL = "read_tool_result";
/** Most characters one stored result keeps. */
export const MAX_STORED_RESULT_CHARS = 1_000_000;
/** Most characters one run keeps across all its stored results; the oldest go first. */
export const MAX_STORED_RUN_CHARS = 5_000_000;
/** Runs kept at once, so finished runs cannot grow the process forever. */
const MAX_STORED_RUNS = 50;

/** `RAKAZO_TOOL_RESULT_OVERFLOW=true` keeps cut-off results and offers `read_tool_result`. */
export function toolResultOverflowEnabled(): boolean {
  return process.env.RAKAZO_TOOL_RESULT_OVERFLOW?.trim().toLowerCase() === "true";
}

/** The plain line that ends a cut-off tool result. */
export function cutOffNote(
  shown: number,
  total: number,
  ref?: string,
  pageLength?: number,
): string {
  const counts = `showed ${shown.toLocaleString("en-GB")} of ${total.toLocaleString("en-GB")} characters`;
  const rest = ref
    ? `Continue with ${READ_TOOL_RESULT_TOOL}("${ref}", offset=${shown}${pageLength === undefined ? "" : `, length=${pageLength}`}); follow the pages before claiming the whole source was read.`
    : "This is partial evidence; read a bounded range from the same original source.";
  return `[cut off: ${counts}. ${rest}]`;
}

interface StoredResult {
  text: string;
  originalChars: number;
}
interface RunStore {
  results: Map<string, StoredResult>;
  chars: number;
  seq: number;
}

export type ToolResultOverflowSnapshot = {
  seq: number;
  results: Array<[string, StoredResult]>;
};

export class ToolResultOverflowStore {
  private readonly runs = new Map<string, RunStore>();

  constructor(
    private readonly maxResultChars = MAX_STORED_RESULT_CHARS,
    private readonly maxRunChars = MAX_STORED_RUN_CHARS,
    private readonly maxRuns = MAX_STORED_RUNS,
  ) {}

  /** Keep `text` for `runId`; returns the short ref the model reads it back with. */
  keep(runId: string, text: string): string {
    let run = this.runs.get(runId);
    if (!run) {
      run = { results: new Map(), chars: 0, seq: 0 };
      this.runs.set(runId, run);
      while (this.runs.size > this.maxRuns) {
        const oldest = this.runs.keys().next().value;
        if (oldest === undefined) break;
        this.runs.delete(oldest);
      }
    }
    const kept = text.slice(0, Math.min(this.maxResultChars, this.maxRunChars));
    // Context preparation can revisit the same original before every model call.
    // Reuse its reference rather than evicting useful evidence with duplicate copies.
    for (const [ref, prior] of run.results) {
      if (prior.originalChars === text.length && prior.text === kept) return ref;
    }
    run.seq += 1;
    const ref = `r${run.seq}`;
    run.results.set(ref, { text: kept, originalChars: text.length });
    run.chars += kept.length;
    for (const [oldRef, oldText] of run.results) {
      if (run.chars <= this.maxRunChars || oldRef === ref) break;
      run.results.delete(oldRef);
      run.chars -= oldText.text.length;
    }
    return ref;
  }

  /** Up to `length` characters from `offset`, with the cut-off line while more remains. */
  read(runId: string, ref: string, offset: number, length: number): string {
    const stored = this.runs.get(runId)?.results.get(ref);
    const text = stored?.text;
    if (text === undefined) {
      return `No kept tool result "${ref}" in this run. It may have been dropped to save memory; run the original tool again with a narrower question.`;
    }
    const incomplete =
      stored!.originalChars > text.length
        ? `[Only ${text.length.toLocaleString("en-GB")} of ${stored!.originalChars.toLocaleString("en-GB")} original characters retained; the remaining evidence was not stored. Re-run the original tool with a narrower request or read the original source.]`
        : undefined;
    const start = Math.max(0, Math.floor(offset));
    if (start >= text.length) {
      if (incomplete) return incomplete;
      return `Nothing left: "${ref}" has ${text.length.toLocaleString("en-GB")} characters.`;
    }
    const pageLength = Math.max(1, Math.floor(length));
    const end = Math.min(text.length, start + pageLength);
    const slice = text.slice(start, end);
    if (end >= text.length) return incomplete ? `${slice}\n${incomplete}` : slice;
    return `${slice}\n${cutOffNote(end, text.length, ref, pageLength)}${incomplete ? `\n${incomplete}` : ""}`;
  }

  snapshot(runId: string): ToolResultOverflowSnapshot {
    const run = this.runs.get(runId);
    return { seq: run?.seq ?? 0, results: [...(run?.results ?? [])] };
  }

  restore(runId: string, snapshot: ToolResultOverflowSnapshot): void {
    if (!Number.isSafeInteger(snapshot?.seq) || snapshot.seq < 0 ||
      !Array.isArray(snapshot.results)) throw new Error("Invalid continuation tool evidence");
    const results = new Map<string, StoredResult>();
    let chars = 0;
    for (const [ref, result] of snapshot.results) {
      if (!/^r[1-9]\d*$/.test(ref) || Number(ref.slice(1)) > snapshot.seq ||
        typeof result?.text !== "string" || !Number.isSafeInteger(result.originalChars) ||
        result.originalChars < result.text.length || result.text.length > this.maxResultChars ||
        results.has(ref)) throw new Error("Invalid continuation tool evidence");
      results.set(ref, result);
      chars += result.text.length;
    }
    if (chars > this.maxRunChars) throw new Error("Continuation tool evidence exceeds retention bound");
    this.runs.set(runId, { seq: snapshot.seq, results, chars });
    while (this.runs.size > this.maxRuns) {
      const oldest = this.runs.keys().next().value;
      if (oldest === undefined) break;
      this.runs.delete(oldest);
    }
  }

  clear(runId: string): void {
    this.runs.delete(runId);
  }
}

export const toolResultOverflowStore = new ToolResultOverflowStore();
