import { useLingui } from "@lingui/react/macro";
import type { ThreadUsage, UsageLimits } from "@rakazo/contracts";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";

/** Readings older than this show their age (the server refreshes after 10 min). */
const STALE_AFTER_SECONDS = 10 * 60;
const LIMITS_POLL_MS = 5 * 60_000;

type UsageTone = "ok" | "warn" | "high";

/** Green below 70% used, amber below 90%, red from 90%. */
export function usageTone(usedPct: number | null): UsageTone {
  if (usedPct === null || usedPct < 70) return "ok";
  return usedPct < 90 ? "warn" : "high";
}

const TONE_CLASS: Record<UsageTone, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  high: "bg-red-500",
};

/** "2 h 10 m", "45 m", "3 d 4 h" until `iso`; null when absent or past. */
export function formatUntil(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const minutes = Math.round((Date.parse(iso) - now) / 60_000);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days > 0) return `${days} d ${hours} h`;
  if (hours > 0) return `${hours} h ${rest} m`;
  return `${rest} m`;
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

type Bar = {
  key: string;
  label: string;
  usedPct: number | null;
  detail: string | null;
  stale: string | null;
};

function UsageMeter({ bar }: { bar: Bar }) {
  const pct = bar.usedPct === null ? null : Math.min(100, Math.max(0, bar.usedPct));
  return (
    <span className="flex min-w-0 items-center gap-1.5" data-testid={`usage-bar-${bar.key}`}>
      <span className="truncate">{bar.label}</span>
      <span className="relative h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-foreground/10">
        <span
          className={`absolute inset-y-0 start-0 rounded-full ${TONE_CLASS[usageTone(pct)]}`}
          style={{ width: `${pct ?? 0}%` }}
        />
      </span>
      <span className="shrink-0 tabular-nums text-foreground/80">
        {pct === null ? "–" : `${Math.round(pct)}%`}
      </span>
      {bar.detail ? <span className="truncate">{bar.detail}</span> : null}
      {bar.stale ? <span className="shrink-0 italic">{bar.stale}</span> : null}
    </span>
  );
}

/** Fleet: slim usage strip on every app page (RAKAZO_SUBSCRIPTION_LIMITS); hidden when off. */
export function UsageTopBar({ refreshKey }: { refreshKey?: string | null }) {
  const { t } = useLingui();
  const [limits, setLimits] = useState<UsageLimits | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is the trigger.
  useEffect(() => {
    let cancelled = false;
    // Through a promise so a missing or failing endpoint never throws into React.
    const load = () =>
      Promise.resolve()
        .then(() => rpc.usage.limits())
        .then((next) => {
          if (!cancelled) setLimits(next);
        })
        .catch(() => {
          /* Undocumented upstream surface: keep the last bars rather than a broken one. */
        });
    void load();
    const timer = setInterval(load, LIMITS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [refreshKey]);
  if (!limits?.enabled) return null;
  const now = Date.now();
  const bars: Bar[] = [];
  const claude = limits.claude;
  if (claude) {
    const time = new Date(claude.observedAt).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    const stale = claude.ageSeconds > STALE_AFTER_SECONDS ? t`as of ${time}` : null;
    const resetDetail = (resetsAt: string | null, reset: boolean) => {
      if (reset) return t`reset`;
      const until = formatUntil(resetsAt, now);
      return until ? t`resets in ${until}` : null;
    };
    bars.push(
      {
        key: "five-hour",
        label: t`Claude · 5 hours`,
        usedPct: claude.fiveHour.usedPct,
        detail: resetDetail(claude.fiveHour.resetsAt, claude.fiveHour.reset),
        stale,
      },
      {
        key: "seven-day",
        label: t`Claude · this week`,
        usedPct: claude.sevenDay.usedPct,
        detail: resetDetail(claude.sevenDay.resetsAt, claude.sevenDay.reset),
        stale,
      },
    );
  }
  for (const extra of limits.extra) {
    const age = extra.updatedAt ? (now - Date.parse(extra.updatedAt)) / 1000 : 0;
    bars.push({
      key: extra.name,
      label: extra.label ?? extra.name,
      usedPct: extra.usedPct,
      detail: extra.detail,
      stale: (() => {
        if (!extra.updatedAt || age <= STALE_AFTER_SECONDS) return null;
        const time = new Date(extra.updatedAt).toLocaleString([], {
          dateStyle: "short",
          timeStyle: "short",
        });
        return t`as of ${time}`;
      })(),
    });
  }
  if (bars.length === 0) return null;
  return (
    <div
      data-testid="usage-top-bar"
      className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-sidebar-border px-3 py-1 text-[11px] text-muted-foreground md:px-[22px]"
    >
      {bars.map((bar) => (
        <UsageMeter key={bar.key} bar={bar} />
      ))}
    </div>
  );
}

/** Fleet: grey line under the chat name; refetched whenever `refreshKey` changes. */
export function ThreadUsageLine({
  botId,
  groupId,
  refreshKey,
}: {
  botId?: string | null;
  groupId?: string | null;
  refreshKey?: string | null;
}) {
  const { t } = useLingui();
  const [usage, setUsage] = useState<ThreadUsage | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is the trigger.
  useEffect(() => {
    if (!botId && !groupId) {
      setUsage(null);
      return;
    }
    let cancelled = false;
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    Promise.resolve()
      .then(() =>
        rpc.usage.thread({
          ...(groupId ? { groupId } : { botId: botId ?? undefined }),
          dayStart: dayStart.toISOString(),
        }),
      )
      .then((next) => {
        if (!cancelled) setUsage(next);
      })
      .catch(() => {
        if (!cancelled) setUsage(null);
      });
    return () => {
      cancelled = true;
    };
  }, [botId, groupId, refreshKey]);
  if (!usage || (usage.runsToday === 0 && usage.contextTokens === null)) return null;
  const parts: string[] = [];
  if (usage.contextTokens !== null) {
    const size = formatTokens(usage.contextTokens);
    if (usage.contextPct !== null && usage.contextWindow) {
      const limit = formatTokens(usage.contextWindow);
      const pct = Math.round(usage.contextPct);
      parts.push(t`context ${size} of ${limit} (${pct}%)`);
    } else {
      parts.push(t`context ${size}`);
    }
  }
  if (usage.cachePctToday !== null) {
    const cache = Math.round(usage.cachePctToday);
    parts.push(t`cache ${cache}% today`);
  }
  const tokens = formatTokens(usage.tokensToday);
  const runs = usage.runsToday;
  parts.push(t`${tokens} tokens today`);
  parts.push(t`${runs} runs today`);
  if (usage.apiEquivalentCostUsdToday !== null) {
    const cost = usage.apiEquivalentCostUsdToday.toFixed(2);
    parts.push(t`≈ $${cost} at API prices`);
  }
  return (
    <span
      data-testid="thread-usage-line"
      className="block truncate text-[11px] font-normal text-muted-foreground"
    >
      {parts.join(" · ")}
    </span>
  );
}
