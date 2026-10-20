import { Trans, useLingui } from "@lingui/react/macro";
import type { PendingDecision } from "@rakazo/contracts";
import { inferAttachmentMimeType } from "@rakazo/core";
import { BotAvatar } from "@rakazo/ui-web";
import { ChevronLeft, ChevronRight, Maximize2, Minimize2, Minus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  newDecisionIds,
  orderDecisions,
  stableDecisionIndex,
  stepDecisionIndex,
} from "../lib/decision-queue";
import { readFileAsBase64 } from "../lib/pending-attachments";
import { rpc } from "../lib/rpc";
import { AskCard, type AskVoice } from "./AskCard";

const FALLBACK_COLOR = "#8b5cf6";
const REFETCH_DELAY_MS = 250;
const BUMP_MS = 1_200;

function minimizedStorageKey(userId: string | null): string {
  return `rk:decision-dock:minimized:${userId ?? "anon"}`;
}

function largeStorageKey(userId: string | null): string {
  return `rk:decision-dock:large:${userId ?? "anon"}`;
}

function readLarge(userId: string | null): boolean {
  try {
    return window.localStorage.getItem(largeStorageKey(userId)) === "1";
  } catch {
    return false;
  }
}

function readMinimized(userId: string | null): boolean {
  try {
    const stored = window.localStorage.getItem(minimizedStorageKey(userId));
    if (stored === "1") return true;
    if (stored === "0") return false;
  } catch {}
  // Small screens start as the pill so the dock never hides the chat.
  return typeof window.matchMedia === "function"
    ? !window.matchMedia("(min-width: 640px)").matches
    : false;
}

/**
 * Fleet: every card waiting for the user, from every bot, in one floating queue over the chat.
 * A waiting card no longer blocks its bot, so answers can come from any chat at any time.
 */
export function DecisionDock({
  userId,
  currentThreadId,
  refreshKey,
  focusRequest,
  bots,
  groups,
  onHeightChange,
  onAnswered,
  voice,
  attachmentMaxBytes,
  onFeedback,
}: {
  userId: string | null;
  currentThreadId: string | null;
  /** Changes whenever the queue may have changed (live events, sidebar poll counts). */
  refreshKey: string;
  /** A transcript chip asked to show this card. */
  focusRequest: { messageId: string; nonce: number } | null;
  bots: ReadonlyArray<{ id: string; color: string }>;
  groups: ReadonlyArray<{ id: string; name: string }>;
  onHeightChange: (height: number) => void;
  onAnswered: (decision: PendingDecision) => void;
  /** Hold-to-talk into a question card's answer box (it never sends on its own). */
  voice?: AskVoice;
  /** The chat's upload limit; set = a question card's answer can carry files. */
  attachmentMaxBytes?: number;
  /** Reports references only; never answers or advances the selected card. */
  onFeedback?: (decision: PendingDecision) => void;
}) {
  const { t } = useLingui();
  const [decisions, setDecisions] = useState<PendingDecision[]>([]);
  const decisionsRef = useRef(decisions);
  decisionsRef.current = decisions;
  const [currentId, setCurrentId] = useState<string | null>(null);
  const lastIndex = useRef(0);
  // Opening another chat (or learning which chat is open after a fresh load) starts the dock
  // at that chat's first card instead of keeping the card shown before.
  const [orderedForThreadId, setOrderedForThreadId] = useState(currentThreadId);
  if (orderedForThreadId !== currentThreadId) {
    setOrderedForThreadId(currentThreadId);
    setCurrentId(null);
  }
  const [minimized, setMinimized] = useState(() => readMinimized(userId));
  const [large, setLarge] = useState(() => readLarge(userId));
  const [bump, setBump] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const loaded = useRef(false);
  const fetchEpoch = useRef(0);
  const rootRef = useRef<HTMLElement | null>(null);

  const load = useCallback(async () => {
    const epoch = ++fetchEpoch.current;
    try {
      const result = await rpc.decisions.list();
      if (epoch !== fetchEpoch.current) return;
      const added = loaded.current ? newDecisionIds(decisionsRef.current, result.decisions) : [];
      loaded.current = true;
      decisionsRef.current = result.decisions;
      setDecisions(result.decisions);
      if (added.length > 0) {
        const first = result.decisions.find((decision) => decision.messageId === added[0]);
        const botName = first?.botName ?? "";
        const addedCount = added.length;
        setAnnouncement(
          addedCount === 1
            ? t`New decision from ${botName}`
            : t`${addedCount} new decisions waiting`,
        );
        setBump(true);
      }
    } catch {
      // Keep the last known queue; the next live event or poll retries.
    }
  }, [t]);

  useEffect(() => {
    void refreshKey;
    const timer = window.setTimeout(() => void load(), loaded.current ? REFETCH_DELAY_MS : 0);
    return () => window.clearTimeout(timer);
  }, [load, refreshKey]);

  useEffect(() => {
    if (!bump) return;
    const timer = window.setTimeout(() => setBump(false), BUMP_MS);
    return () => window.clearTimeout(timer);
  }, [bump]);

  const ordered = useMemo(
    () => orderDecisions(decisions, currentThreadId),
    [decisions, currentThreadId],
  );
  // No card picked yet (first load or a chat switch): the first card of the new ordering.
  const index = stableDecisionIndex(ordered, currentId, currentId ? lastIndex.current : 0);
  const current = ordered[index] ?? null;
  useEffect(() => {
    lastIndex.current = index;
    const id = current?.messageId ?? null;
    if (id !== currentId) setCurrentId(id);
  }, [current?.messageId, currentId, index]);
  useEffect(() => {
    if (!focusRequest) return;
    setCurrentId(focusRequest.messageId);
    setMinimized(false);
    // The chip can be newer than the last fetch; point at the card again once it is loaded.
    void load().then(() => setCurrentId(focusRequest.messageId));
  }, [focusRequest, load]);

  useEffect(() => {
    void minimized;
    void large;
    const element = rootRef.current;
    if (!element || ordered.length === 0) {
      onHeightChange(0);
      return;
    }
    const report = () => onHeightChange(element.getBoundingClientRect().height);
    report();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => observer.disconnect();
  }, [onHeightChange, ordered.length, minimized, large]);
  useEffect(() => () => onHeightChange(0), [onHeightChange]);

  function setMinimizedRemembered(next: boolean) {
    setMinimized(next);
    try {
      window.localStorage.setItem(minimizedStorageKey(userId), next ? "1" : "0");
    } catch {}
  }

  function setLargeRemembered(next: boolean) {
    setLarge(next);
    try {
      window.localStorage.setItem(largeStorageKey(userId), next ? "1" : "0");
    } catch {}
  }

  function step(by: number) {
    const next = ordered[stepDecisionIndex(index, by, ordered.length)];
    if (next) setCurrentId(next.messageId);
  }

  async function answer(
    decision: PendingDecision,
    text: string,
    username?: string,
    files?: readonly File[],
    draftFinal?: string,
  ) {
    const target = decision.groupId ? { groupId: decision.groupId } : { botId: decision.botId };
    // Files go up as artifacts of the card's own chat, like the composer's attachments.
    const artifactIds: string[] = [];
    for (const file of files ?? []) {
      const mimeType = inferAttachmentMimeType(file.name, file.type);
      if (!mimeType) throw new Error(t`Unsupported file type: ${file.name}`);
      const contentBase64 = await readFileAsBase64(file);
      const artifact = await rpc.artifacts.create({
        ...target,
        name: file.name,
        mimeType,
        contentBase64,
      });
      artifactIds.push(artifact.id);
    }
    try {
      await rpc.threads.answer({
        ...target,
        runId: decision.runId,
        messageId: decision.messageId,
        answer: text,
        ...(username ? { username } : {}),
        ...(draftFinal !== undefined ? { draftFinal } : {}),
        ...(artifactIds.length ? { artifactIds } : {}),
      });
    } catch (error) {
      // Answered elsewhere or its run moved on: the card is gone, so drop it quietly.
      if ((error as { code?: string } | null)?.code !== "CONFLICT") throw error;
    }
    decisionsRef.current = decisionsRef.current.filter(
      (item) => item.messageId !== decision.messageId,
    );
    setDecisions(decisionsRef.current);
    onAnswered(decision);
    void load();
  }

  const live = (
    <div aria-live="polite" className="sr-only" data-testid="decision-dock-announcer">
      {announcement}
    </div>
  );

  if (ordered.length === 0 || !current) return live;

  const count = ordered.length;
  const position = index + 1;
  const groupName = current.groupId
    ? groups.find((group) => group.id === current.groupId)?.name
    : undefined;
  const color = bots.find((bot) => bot.id === current.botId)?.color ?? FALLBACK_COLOR;
  const attachRoot = (element: HTMLElement | null) => {
    rootRef.current = element;
  };

  return (
    <>
      {live}
      {minimized ? (
        <button
          ref={attachRoot}
          type="button"
          data-testid="decision-dock-pill"
          onClick={() => setMinimizedRemembered(false)}
          className={`absolute bottom-4 end-4 z-30 flex items-center gap-2 rounded-full border border-warning/40 bg-card px-3.5 py-2 text-[13px] font-medium text-foreground shadow-lg transition-transform motion-reduce:transition-none ${
            bump ? "scale-110 motion-reduce:scale-100" : "scale-100"
          }`}
        >
          <span
            aria-hidden="true"
            className={`size-2 rounded-full bg-warning ${bump ? "animate-ping motion-reduce:animate-none" : ""}`}
          />
          {count === 1 ? <Trans>1 decision</Trans> : <Trans>{count} decisions</Trans>}
        </button>
      ) : (
        <section
          ref={attachRoot}
          data-testid="decision-dock"
          aria-label={t`Decisions`}
          onKeyDown={(event) => {
            const target = event.target as HTMLElement;
            if (
              target.closest("input, textarea, select, [contenteditable='true']") ||
              event.altKey ||
              event.ctrlKey ||
              event.metaKey
            ) {
              return;
            }
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              step(event.key === "ArrowLeft" ? -1 : 1);
            }
          }}
          // The default is twice the first dock (800px wide, body up to 56rem); enlarged goes to
          // 1200px and 80rem. Width is capped by the chat and height by the viewport; below `sm`
          // the dock is full width either way.
          className={`absolute bottom-4 end-4 z-30 flex w-[min(800px,calc(100%-2rem))] flex-col rounded-2xl border border-border bg-background shadow-xl ${
            large ? "sm:w-[min(1200px,calc(100%-2rem))]" : ""
          }`}
        >
          <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
            <BotAvatar color={color} identity={current.botId} size={24} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13.5px] font-medium text-foreground">
                {current.botName}
              </div>
              <div className="truncate text-[12px] text-muted-foreground">
                {groupName ?? t`Direct chat`}
              </div>
            </div>
            <span
              className="shrink-0 text-[12px] text-muted-foreground"
              data-testid="decision-dock-position"
            >
              <Trans>
                Decisions {position} of {count}
              </Trans>
            </span>
            <button
              type="button"
              aria-label={t`Previous decision`}
              disabled={count < 2}
              onClick={() => step(-1)}
              className="grid size-7 place-items-center rounded-md hover:bg-accent disabled:opacity-40"
            >
              <ChevronLeft size={16} aria-hidden="true" className="rtl:rotate-180" />
            </button>
            <button
              type="button"
              aria-label={t`Next decision`}
              disabled={count < 2}
              onClick={() => step(1)}
              className="grid size-7 place-items-center rounded-md hover:bg-accent disabled:opacity-40"
            >
              <ChevronRight size={16} aria-hidden="true" className="rtl:rotate-180" />
            </button>
            <button
              type="button"
              aria-label={large ? t`Make decisions smaller` : t`Enlarge decisions`}
              onClick={() => setLargeRemembered(!large)}
              className="hidden size-7 place-items-center rounded-md hover:bg-accent sm:grid"
            >
              {large ? (
                <Minimize2 size={15} aria-hidden="true" />
              ) : (
                <Maximize2 size={15} aria-hidden="true" />
              )}
            </button>
            <button
              type="button"
              aria-label={t`Minimize decisions`}
              onClick={() => setMinimizedRemembered(true)}
              className="grid size-7 place-items-center rounded-md hover:bg-accent"
            >
              <Minus size={16} aria-hidden="true" />
            </button>
            {onFeedback ? (
              <button
                type="button"
                onClick={() => onFeedback(current)}
                className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <Trans>Feedback to Elena</Trans>
              </button>
            ) : null}
          </header>
          <div
            data-testid="decision-dock-body"
            className={`max-h-[min(70vh,56rem)] overflow-y-auto p-2 ${
              large ? "sm:max-h-[min(85vh,80rem)]" : ""
            }`}
          >
            {/* Every card stays mounted while cycling so a half-typed answer survives. */}
            {ordered.map((decision) =>
              decision.block.kind === "ask" ? (
                <div
                  key={decision.messageId}
                  hidden={decision.messageId !== current.messageId}
                  data-decision-id={decision.messageId}
                  className="[&>div]:max-w-none"
                >
                  <AskCard
                    block={decision.block}
                    canAnswer
                    onAnswer={(text, username, files, draftFinal) =>
                      answer(decision, text, username, files, draftFinal)
                    }
                    voice={voice}
                    attachmentMaxBytes={attachmentMaxBytes}
                  />
                </div>
              ) : null,
            )}
          </div>
        </section>
      )}
    </>
  );
}
