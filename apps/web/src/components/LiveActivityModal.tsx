import { useLingui } from "@lingui/react/macro";
import type { ProductEvent, RunActivitySummary } from "@rakazo/contracts";
import { Dialog, DialogContent, DialogTitle } from "@rakazo/ui-web";
import type { ITheme } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import {
  activityStatusLine,
  renderActivityLines,
  subscribeActivityEvents,
} from "../lib/live-activity-terminal";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { useXterm } from "./computer/TerminalApp";

/** Stored pages fetched on open; a run longer than this shows its first pages and then live. */
const MAX_REPLAY_PAGES = 10;
/** Always dark, like a terminal attached to the bot's session. */
const DARK_THEME: ITheme = {
  background: "#0b0d10",
  foreground: "#d6dae0",
  cursor: "#0b0d10",
  selectionBackground: "#33404f",
};

export type LiveActivityTarget = { botId: string } | { groupId: string };

/**
 * Fleet (RAKAZO_ACTIVITY_DETAILS): a read-only terminal that replays a run's stored events and
 * then follows it live, like attaching to the bot's Pi session. Closing it leaves the bot alone.
 */
export function LiveActivityModal({
  onClose,
  target,
}: {
  onClose: () => void;
  target: LiveActivityTarget;
}) {
  const { t } = useLingui();
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        data-testid="live-activity"
        className="flex h-[min(88vh,900px)] w-[min(1100px,94vw)] flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
      >
        <LiveActivityTerminal target={target} title={t`Live activity`} />
      </DialogContent>
    </Dialog>
  );
}

function LiveActivityTerminal({ target, title }: { target: LiveActivityTarget; title: string }) {
  const { t } = useLingui();
  const host = useRef<HTMLDivElement>(null);
  const terminal = useXterm(host, false, DARK_THEME);
  const [runs, setRuns] = useState<RunActivitySummary[]>([]);
  // Picked in the run picker; unset follows the latest run, including one that starts later.
  const [pickedRunId, setPickedRunId] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [events, setEvents] = useState<ProductEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const botId = "botId" in target ? target.botId : undefined;
  const groupId = "groupId" in target ? target.groupId : undefined;

  useEffect(() => {
    let cancelled = false;
    const threadTarget = botId ? { botId } : { groupId: groupId ?? "" };
    let threadId: string | null = null;
    let loadedRunId: string | null = null;
    // Live events that land while the stored pages load are merged by seq afterwards.
    let early: ProductEvent[] = [];
    const merge = (current: ProductEvent[], incoming: ProductEvent[]) => {
      const bySeq = new Map(current.map((event) => [event.seq, event]));
      for (const event of incoming) bySeq.set(event.seq, event);
      return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
    };
    const unsubscribe = subscribeActivityEvents((event) => {
      if (event.seq === 0 || (threadId && event.threadId !== threadId)) return;
      if (event.type === "run.started" && !pickedRunId && event.runId && event.runId !== loadedRunId) {
        // A new run started while following the latest one: switch to it.
        setReload((value) => value + 1);
        return;
      }
      if (!loadedRunId) {
        early.push(event);
        return;
      }
      if (event.runId !== loadedRunId) return;
      setEvents((current) => merge(current, [event]));
    });
    void (async () => {
      try {
        let afterSeq: number | undefined;
        let pageRunId: string | null = null;
        let stored: ProductEvent[] = [];
        for (let page = 0; page < MAX_REPLAY_PAGES; page += 1) {
          const result = await rpc.runs.activity({
            ...threadTarget,
            ...(pickedRunId ? { runId: pickedRunId } : {}),
            ...(afterSeq === undefined ? {} : { afterSeq }),
          });
          if (cancelled) return;
          threadId = result.threadId;
          if (page === 0) {
            setRuns(result.runs);
            setRunId(result.runId);
            pageRunId = result.runId;
          }
          stored = stored.concat(result.events);
          if (result.nextAfterSeq === null) break;
          afterSeq = result.nextAfterSeq;
        }
        loadedRunId = pageRunId;
        const ownLive = early.filter(
          (event) => event.threadId === threadId && event.runId === loadedRunId,
        );
        early = [];
        setError(null);
        setEvents(merge(stored, ownLive));
      } catch (cause) {
        if (!cancelled) setError(errorText(cause, t`Could not load the activity`));
      }
    })();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [botId, groupId, pickedRunId, reload, t]);

  const run = runs.find((candidate) => candidate.runId === runId) ?? null;

  useEffect(() => {
    if (!terminal) return;
    // Clear in-band (ESC c) so a queued earlier render cannot land after this one.
    const frame = window.requestAnimationFrame(() => {
      const lines = renderActivityLines(events, run);
      terminal.write(`\x1bc${lines.join("\r\n")}`);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [terminal, events, run]);

  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-5">
        <DialogTitle className="min-w-0 flex-1 truncate text-[14px] leading-5 font-medium text-foreground">
          {title}
          {run ? <span className="text-muted-foreground"> · {run.promptSnippet}</span> : null}
        </DialogTitle>
        <select
          aria-label={t`Run`}
          value={pickedRunId ?? ""}
          onChange={(event) => setPickedRunId(event.target.value || null)}
          className="h-8 max-w-[320px] rounded-md border border-border bg-background px-2 text-[13px]"
        >
          <option value="">{t`Latest run (follow live)`}</option>
          {runs.map((candidate) => (
            <option key={candidate.runId} value={candidate.runId}>
              {new Date(candidate.createdAt).toLocaleString()} · {candidate.botName} ·{" "}
              {candidate.trigger} · {candidate.status}
            </option>
          ))}
        </select>
      </header>
      {error ? (
        <div role="alert" className="px-5 py-2 text-[13px] text-destructive">
          {error}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 bg-[#0b0d10] px-2 py-1.5">
        <div ref={host} data-testid="live-activity-terminal" className="h-full w-full" />
      </div>
      <footer
        data-testid="live-activity-status"
        className="flex h-7 shrink-0 items-center gap-3 bg-[#151a20] px-4 font-mono text-[12px] text-[#9aa4b0]"
      >
        <span>{run ? `${run.botName} · ${run.status}` : t`No runs yet`}</span>
        <span className="ms-auto">{activityStatusLine(events)}</span>
      </footer>
    </>
  );
}
