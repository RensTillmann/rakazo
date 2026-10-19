/**
 * Fleet: the full text of a tool result the runtime cut off, kept for the rest of the run
 * so the model can page through it with `read_tool_result`. In memory only: a process
 * restart loses it, and the tool then says the result is gone.
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
export function cutOffNote(shown: number, total: number, ref?: string): string {
  const counts = `showed ${shown.toLocaleString("en-GB")} of ${total.toLocaleString("en-GB")} characters`;
  const rest = ref
    ? `Ask a narrower question, or read the rest with ${READ_TOOL_RESULT_TOOL}("${ref}", offset=${shown}).`
    : "Ask a narrower question.";
  return `[cut off: ${counts}. ${rest}]`;
}

interface RunStore {
  results: Map<string, string>;
  chars: number;
  seq: number;
}

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
    const kept = text.slice(0, this.maxResultChars);
    run.seq += 1;
    const ref = `r${run.seq}`;
    run.results.set(ref, kept);
    run.chars += kept.length;
    for (const [oldRef, oldText] of run.results) {
      if (run.chars <= this.maxRunChars || oldRef === ref) break;
      run.results.delete(oldRef);
      run.chars -= oldText.length;
    }
    return ref;
  }

  /** Up to `length` characters from `offset`, with the cut-off line while more remains. */
  read(runId: string, ref: string, offset: number, length: number): string {
    const text = this.runs.get(runId)?.results.get(ref);
    if (text === undefined) {
      return `No kept tool result "${ref}" in this run. It may have been dropped to save memory; run the original tool again with a narrower question.`;
    }
    const start = Math.max(0, Math.floor(offset));
    if (start >= text.length) {
      return `Nothing left: "${ref}" has ${text.length.toLocaleString("en-GB")} characters.`;
    }
    const end = Math.min(text.length, start + Math.max(1, Math.floor(length)));
    const slice = text.slice(start, end);
    if (end >= text.length) return slice;
    return `${slice}\n${cutOffNote(end, text.length, ref)}`;
  }

  clear(runId: string): void {
    this.runs.delete(runId);
  }
}

export const toolResultOverflowStore = new ToolResultOverflowStore();
