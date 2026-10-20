import { t as translate } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { ExtraUsageBar, ThreadUsage, UsageLimits } from "@rakazo/contracts";
import {
  Button,
  Disclosure,
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
  ScrollArea,
} from "@rakazo/ui-web";
import { useEffect, useMemo, useRef } from "react";
import { authClient } from "../lib/auth";
import { MODEL_SETTINGS_CHANGED_EVENT } from "../lib/model-settings-events";
import { createSpaceRpc, selectedSpaceId } from "../lib/rpc";
import { useVisibleResource } from "../lib/use-visible-resource";

export type HeaderModel = { provider: string; modelId: string; isDefault?: boolean };

/** An override is a separate row, even when its provider shares an account allowance. */
export function connectedModelRows(
  models: HeaderModel[],
  provider?: string | null,
  modelId?: string | null,
): HeaderModel[] {
  const rows = models.filter(
    (model, index) =>
      models.findIndex(
        (candidate) => candidate.provider === model.provider && candidate.modelId === model.modelId,
      ) === index,
  );
  if (
    provider &&
    modelId &&
    !rows.some((row) => row.provider === provider && row.modelId === modelId)
  ) {
    rows.push({ provider, modelId });
  }
  return rows;
}
type UsageTone = "ok" | "warn" | "high";
export function usageTone(usedPct: number | null): UsageTone {
  if (usedPct === null || usedPct < 70) return "ok";
  return usedPct < 90 ? "warn" : "high";
}
const TONE_CLASS: Record<UsageTone, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  high: "bg-destructive",
};
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

/** Counts are supplied by the producer, never inferred from diagnostic prose. */
export function attentionSummary(extra: ExtraUsageBar[], now = Date.now()): string[] {
  const parts: string[] = [];
  for (const bar of extra) {
    const start = parts.length;
    if (bar.usedPct !== null && bar.usedPct >= 90) {
      const name = bar.name;
      parts.push(translate`${name} usage high`);
    }
    const s = bar.summary;
    if (s) {
      if (s.waitingCount !== undefined && (!s.partial || s.waitingCount > 0)) {
        const count = s.waitingCount;
        parts.push(
          s.partial
            ? translate`At least ${count} waiting items`
            : translate`${count} waiting items`,
        );
      }
      if (s.unaskedCount != null && s.unaskedCount > 0) {
        const count = s.unaskedCount;
        parts.push(translate`${count} not yet asked`);
      }
      if (s.pausedRoutineCount !== undefined && s.pausedRoutineCount > 0) {
        const count = s.pausedRoutineCount;
        parts.push(translate`${count} paused routines`);
      }
      if (s.issueCount !== undefined && s.issueCount > 0) {
        const count = s.issueCount;
        parts.push(translate`${count} issues`);
      }
    }
    if ((bar.tone === "warn" || bar.tone === "high") && parts.length === start) {
      parts.push(translate`Status needs attention`);
    }
    if (s?.partial) parts.push(translate`Status incomplete`);
    if (parts.length > start && bar.updatedAt && now - Date.parse(bar.updatedAt) > 10 * 60_000) {
      const time = new Date(bar.updatedAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
      parts.push(translate`as of ${time}`);
    }
  }
  return [...new Set(parts)];
}

function Meter({
  name,
  label,
  pct,
  detail,
}: {
  name: string;
  label: string;
  pct: number | null;
  detail?: string | null;
}) {
  const { t } = useLingui();
  return (
    <div data-testid={`usage-bar-${name}`} className="space-y-1">
      <div className="flex flex-wrap justify-between gap-x-3">
        <span>{label}</span>
        <span className="tabular-nums">
          {pct === null ? t`Unavailable` : `${Math.round(pct)}%`}
        </span>
      </div>
      {pct === null ? null : (
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            data-tone={usageTone(pct)}
            className={`h-full ${TONE_CLASS[usageTone(pct)]}`}
            style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
          />
        </div>
      )}
      {detail ? (
        <p className="whitespace-pre-wrap break-words text-muted-foreground">{detail}</p>
      ) : null}
    </div>
  );
}

function DiagnosticText({ text }: { text: string }) {
  // Keep the full producer text, with its external list URLs usable on touch screens too.
  return (
    <p className="whitespace-pre-wrap break-words">
      {text.split(/(https?:\/\/[^\s]+)/g).map((part, i) =>
        /^https?:\/\//.test(part) ? (
          <a key={i} href={part} target="_blank" rel="noreferrer" className="underline">
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </p>
  );
}

export function UsageDetails({
  limits,
  usage,
  model,
  contextLabel,
  models = [],
  backups = [],
  modelProvider,
  modelId,
}: {
  limits: UsageLimits | null;
  usage: ThreadUsage | null;
  model?: string | null;
  contextLabel?: string;
  models?: HeaderModel[];
  backups?: HeaderModel[];
  modelProvider?: string | null;
  modelId?: string | null;
}) {
  const { t } = useLingui();
  const accounts = limits?.enabled ? limits.accounts : [];
  const context = contextLabel ?? t`Context`;
  const tokens = usage?.tokensToday.toLocaleString();
  const runs = usage?.runsToday;
  const cost = usage?.apiEquivalentCostUsdToday?.toFixed(2);
  return (
    <div className="space-y-4 text-xs">
      {model ? <p className="whitespace-pre-line break-words">{model}</p> : null}
      {connectedModelRows(models, modelProvider, modelId).map((row) => {
        const roles = [
          row.isDefault ? t`Primary` : null,
          row.provider === modelProvider && row.modelId === modelId ? t`Active` : null,
          backups.some(
            (backup) => backup.provider === row.provider && backup.modelId === row.modelId,
          )
            ? t`Backup`
            : null,
        ].filter(Boolean);
        return (
          <p key={`${row.provider}/${row.modelId}`} className="break-words">
            {row.provider}/{row.modelId}
            {roles.length ? ` · ${roles.join(" · ")}` : ""}
          </p>
        );
      })}
      {usage ? (
        <section className="space-y-1">
          {usage.lastModel ? (
            <p>
              {t`Last call`}: {usage.lastModel.provider}/{usage.lastModel.model}
            </p>
          ) : null}
          <p>
            {context}:{" "}
            {usage.contextTokens === null ? t`Unavailable` : usage.contextTokens.toLocaleString()} /{" "}
            {usage.contextWindow === null
              ? t`unknown window`
              : usage.contextWindow.toLocaleString()}{" "}
            {t`tokens`} {usage.contextPct === null ? "" : `(${Math.round(usage.contextPct)}%)`}
          </p>
          <p>
            {t`Cache today`}:{" "}
            {usage.cachePctToday === null ? t`Unavailable` : `${Math.round(usage.cachePctToday)}%`}{" "}
            · {t`across this chat’s model calls`}
          </p>
          <p>{t`${tokens} tokens today · ${runs} runs today`}</p>
          <p>
            {cost === undefined
              ? t`API-price equivalent unavailable`
              : t`≈ $${cost} at API prices today`}
          </p>
        </section>
      ) : null}
      {accounts.map((account) => (
        <section key={account.provider} className="space-y-3">
          <h3 className="font-medium">
            {account.label} · {t`Shared provider account allowance`}
          </h3>
          {(
            [
              ["five-hour", t`5 hours`, account.fiveHour],
              ["seven-day", t`This week`, account.sevenDay],
            ] as const
          ).map(([key, label, window]) => {
            const until = formatUntil(window.resetsAt, Date.now());
            const resetLabel = window.reset
              ? t`Reset`
              : until
                ? t`Resets in ${until}`
                : t`Reset time`;
            const detail = window.resetsAt
              ? `${resetLabel} · ${new Date(window.resetsAt).toLocaleString()}`
              : t`Reset time unavailable`;
            return (
              <Meter
                key={key}
                name={`${account.provider}-${key}`}
                label={label}
                pct={window.usedPct}
                detail={detail}
              />
            );
          })}
          <p className="text-muted-foreground">
            {account.status ? `${account.status} · ` : ""}
            {t`Observed`} {new Date(account.observedAt).toLocaleString()}
          </p>
        </section>
      ))}
      {limits?.enabled
        ? limits.extra.map((extra) => {
            const waiting =
              extra.summary?.waitingCount !== undefined ||
              extra.summary?.unaskedCount !== undefined;
            const label =
              extra.usedPct !== null
                ? (extra.label ?? extra.name)
                : waiting
                  ? t`Waiting on you`
                  : t`Status`;
            const counts = attentionSummary([extra]);
            return (
              <section key={extra.name} className="space-y-2">
                {extra.usedPct === null ? (
                  <div data-testid={`usage-status-${extra.name}`} className="space-y-1">
                    <h3 className="font-medium">{label}</h3>
                    {counts.length ? <p>{counts.join(" · ")}</p> : null}
                  </div>
                ) : (
                  <Meter
                    name={extra.name}
                    label={label}
                    pct={extra.usedPct}
                    detail={extra.detail}
                  />
                )}
                <Disclosure
                  summary={t`Diagnostics`}
                  summaryClassName="items-start text-start break-words"
                >
                  <div className="space-y-2 pt-2 text-muted-foreground">
                    {extra.label &&
                    !extra.detail?.startsWith(extra.label) &&
                    extra.label !== label ? (
                      <DiagnosticText text={extra.label} />
                    ) : null}
                    {extra.detail ? <DiagnosticText text={extra.detail} /> : null}
                    {extra.updatedAt ? (
                      <p>
                        {t`Updated`} {new Date(extra.updatedAt).toLocaleString()}
                      </p>
                    ) : null}
                  </div>
                </Disclosure>
              </section>
            );
          })
        : null}
      {!accounts.length ? (
        <p className="text-muted-foreground">{t`Provider account allowance unavailable`}</p>
      ) : null}
    </div>
  );
}

function AccountAllowanceSummary({ account }: { account?: UsageLimits["accounts"][number] }) {
  const { t } = useLingui();
  const weekly = account?.sevenDay.usedPct;
  const fiveHour = account?.fiveHour.usedPct;
  const used = weekly ?? fiveHour;
  const age =
    account && account.ageSeconds > 10 * 60
      ? new Date(account.observedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : null;
  return (
    <>
      <span className={used != null && used >= 90 ? "text-destructive" : undefined}>
        {weekly != null
          ? t`${Math.round(weekly)}% used this week`
          : fiveHour != null
            ? t`${Math.round(fiveHour)}% used · 5 hours`
            : t`Usage unavailable`}
      </span>
      {weekly != null && fiveHour != null && fiveHour >= 90 ? (
        <span className="text-destructive"> · {t`${Math.round(fiveHour)}% used · 5 hours`}</span>
      ) : null}
      {age ? ` · ${t`as of ${age}`}` : ""}
    </>
  );
}

/** The chat header and Board/Artifacts use one limits fetcher per page. */
export function UsageTopBar({
  refreshKey,
  botId,
  groupId,
  spaceId,
  model,
  modelProvider,
  modelId,
  models = [],
  backups = [],
  modelsStatus,
  compact = false,
}: {
  refreshKey?: string | null;
  botId?: string | null;
  groupId?: string | null;
  spaceId?: string | null;
  model?: string | null;
  modelProvider?: string | null;
  modelId?: string | null;
  models?: HeaderModel[];
  backups?: HeaderModel[];
  modelsStatus?: "loading" | "partial";
  compact?: boolean;
}) {
  const { t } = useLingui();
  const session = authClient.useSession();
  const effectiveSpace = spaceId ?? selectedSpaceId();
  const scope = `${session.data?.user.id ?? "anonymous"}:${effectiveSpace ?? "primary"}`;
  const api = useMemo(() => createSpaceRpc(effectiveSpace), [effectiveSpace]);
  const limitsResource = useVisibleResource(() => api.usage.limits(), {
    key: `limits:${scope}`,
    event: MODEL_SETTINGS_CHANGED_EVENT,
  });
  const threadResource = useVisibleResource(
    async () => {
      if (!botId && !groupId) return null;
      const dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);
      return api.usage.thread({
        ...(groupId ? { groupId } : { botId: botId ?? undefined }),
        dayStart: dayStart.toISOString(),
      });
    },
    { key: `thread:${scope}:${groupId ?? botId ?? "none"}`, event: MODEL_SETTINGS_CHANGED_EVENT },
  );
  const { refresh: refreshLimits } = limitsResource;
  const { refresh: refreshThread } = threadResource;
  const previousRefreshKey = useRef(refreshKey);
  useEffect(() => {
    if (previousRefreshKey.current === refreshKey) return;
    previousRefreshKey.current = refreshKey;
    void refreshLimits();
    void refreshThread();
  }, [refreshKey, refreshLimits, refreshThread]);
  const limits = limitsResource.data;
  const usage = threadResource.data;
  const contextMatches =
    !groupId &&
    usage?.lastModel &&
    modelProvider &&
    modelId &&
    usage.lastModel.provider === modelProvider &&
    usage.lastModel.model === modelId;
  const contextLabel = contextMatches ? t`Context` : t`Last call context`;
  const summary = limits?.enabled ? attentionSummary(limits.extra) : [];
  const modelRows = connectedModelRows(
    models,
    groupId ? null : modelProvider,
    groupId ? null : modelId,
  );
  if (!compact && !limits?.enabled && !limitsResource.error) return null;
  return (
    <div
      data-testid="usage-top-bar"
      className={
        compact
          ? "contents"
          : "app-no-drag flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-sidebar-border px-3 py-1 text-[11px] text-muted-foreground md:px-[22px]"
      }
    >
      <div
        className={`app-no-drag flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground ${compact ? "col-start-1 row-start-3 md:row-start-2" : "flex-1"}`}
      >
        {botId || groupId ? (
          <>
            <span>
              {contextLabel} {usage?.contextPct == null ? "—" : `${Math.round(usage.contextPct)}%`}
            </span>
            <span>
              {t`Cache today`}{" "}
              {usage?.cachePctToday == null ? "—" : `${Math.round(usage.cachePctToday)}%`}
            </span>
          </>
        ) : null}
        {summary.length ? (
          <span className="break-words text-foreground">{summary.join(" · ")}</span>
        ) : null}
        {limitsResource.error || threadResource.error ? (
          <span>{t`Status refresh unavailable`}</span>
        ) : null}
      </div>
      {!compact && !modelRows.length && limits?.enabled ? (
        <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1">
          <span>{t`Account usage`}</span>
          {limits.accounts.map((account) => (
            <div
              key={account.provider}
              data-testid="account-usage-row"
              data-provider={account.provider}
            >
              {account.label} · <AccountAllowanceSummary account={account} />
            </div>
          ))}
        </div>
      ) : null}
      {modelRows.length || modelsStatus ? (
        <div
          data-testid="header-model"
          className={`app-no-drag ms-auto flex min-w-0 max-w-full flex-col items-end gap-0.5 text-end text-[11px] text-muted-foreground ${compact ? "col-span-2 row-start-2 md:col-span-1 md:col-start-2 md:row-span-2 md:row-start-1" : ""}`}
        >
          <span>{t`Account usage`}</span>
          {modelsStatus ? (
            <span>
              {modelsStatus === "partial" ? t`Model list incomplete` : t`Loading model list`}
            </span>
          ) : null}
          {modelRows.map((row) => {
            const account = limits?.enabled
              ? limits.accounts.find((candidate) => candidate.provider === row.provider)
              : undefined;
            const active = !groupId && row.provider === modelProvider && row.modelId === modelId;
            return (
              <div
                key={`${row.provider}/${row.modelId}`}
                data-testid="model-usage-row"
                data-provider={row.provider}
                data-model={row.modelId}
                data-active={active ? "true" : undefined}
                className="max-w-full break-words [overflow-wrap:anywhere]"
              >
                {row.modelId}
                {active ? ` (${t`active`})` : ""} · <AccountAllowanceSummary account={account} />
              </div>
            );
          })}
        </div>
      ) : null}
      <Popover>
        <PopoverTrigger
          className={`app-no-drag ms-auto shrink-0 rounded px-1 py-0.5 text-[11px] text-foreground hover:bg-accent ${compact ? "col-start-2 row-start-3 md:col-start-3 md:row-start-2" : ""}`}
        >{t`Usage / Details`}</PopoverTrigger>
        <PopoverContent align="end" className="w-[min(28rem,calc(100vw-1.5rem))]">
          <div className="flex items-center justify-between">
            <PopoverTitle>{t`Usage / Details`}</PopoverTitle>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void refreshLimits();
                void refreshThread();
              }}
            >{t`Refresh`}</Button>
          </div>
          <ScrollArea className="max-h-[65vh] overflow-y-auto">
            <UsageDetails
              limits={limits}
              usage={usage}
              model={model}
              contextLabel={contextLabel}
              models={models}
              backups={backups}
              modelProvider={groupId ? null : modelProvider}
              modelId={groupId ? null : modelId}
            />
          </ScrollArea>
        </PopoverContent>
      </Popover>
    </div>
  );
}
