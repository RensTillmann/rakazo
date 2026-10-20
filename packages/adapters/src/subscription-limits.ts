import type { Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { SecretStore, SubscriptionLimitReading } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import * as z from "zod";
import type { StoredModelSecret } from "./pi-oauth.js";
import {
  ANTHROPIC_OAUTH_PROVIDER,
  CHATGPT_OAUTH_PROVIDER,
  oauthCredentialAccountId,
  parseModelSecret,
  refreshExpiredModelCredential,
} from "./pi-oauth.js";
import { fetchZaiQuotaUsage } from "./zai-usage.js";

/**
 * RAKAZO_SUBSCRIPTION_LIMITS (fleet patch): capture Anthropic's subscription-window headers on
 * every model call and serve them as usage bars. Off (default): nothing is read or stored.
 */
export function subscriptionLimitsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.RAKAZO_SUBSCRIPTION_LIMITS?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

const HEADER_PREFIX = "anthropic-ratelimit-unified-";

function utilization(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function epochSeconds(raw: string | undefined): Date | null {
  if (raw === undefined || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? new Date(value * 1000) : null;
}

/**
 * Anthropic's undocumented `anthropic-ratelimit-unified-*` headers (utilization 0..1, reset in
 * unix seconds). Lenient: returns null when none of the window headers is present.
 */
export function parseRateLimitHeaders(
  headers: Record<string, string | undefined> | undefined,
  provider: string,
  now: Date = new Date(),
): SubscriptionLimitReading | null {
  if (!headers) return null;
  const lower = new Map<string, string>();
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && name.toLowerCase().startsWith(HEADER_PREFIX)) {
      lower.set(name.toLowerCase().slice(HEADER_PREFIX.length), value);
    }
  }
  const reading = {
    provider,
    fiveHourUtil: utilization(lower.get("5h-utilization")),
    fiveHourResetAt: epochSeconds(lower.get("5h-reset")),
    sevenDayUtil: utilization(lower.get("7d-utilization")),
    sevenDayResetAt: epochSeconds(lower.get("7d-reset")),
    status: lower.get("status")?.trim() || null,
    observedAt: now,
  };
  if (reading.fiveHourUtil === null && reading.sevenDayUtil === null) return null;
  return reading;
}

type UsageWindow = { utilization?: unknown; resets_at?: unknown } | null | undefined;

function oauthWindow(window: UsageWindow): { util: number | null; resetAt: Date | null } {
  const raw = window?.utilization;
  const util =
    typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 100 ? raw / 100 : null;
  const reset = typeof window?.resets_at === "string" ? new Date(window.resets_at) : null;
  return { util, resetAt: reset && !Number.isNaN(reset.getTime()) ? reset : null };
}

/** `GET /api/oauth/usage` body: windows carry utilization as a percentage (0..100). */
export function parseOAuthUsageResponse(
  body: unknown,
  now: Date = new Date(),
): SubscriptionLimitReading | null {
  if (!body || typeof body !== "object") return null;
  const record = body as { five_hour?: UsageWindow; seven_day?: UsageWindow };
  const five = oauthWindow(record.five_hour);
  const seven = oauthWindow(record.seven_day);
  if (five.util === null && seven.util === null) return null;
  return {
    provider: ANTHROPIC_OAUTH_PROVIDER,
    fiveHourUtil: five.util,
    fiveHourResetAt: five.resetAt,
    sevenDayUtil: seven.util,
    sevenDayResetAt: seven.resetAt,
    status: null,
    observedAt: now,
  };
}

const CodexUsageWindowSchema = z.object({
  used_percent: z.number().min(0).max(100),
  limit_window_seconds: z.union([z.literal(18_000), z.literal(604_800)]),
  reset_at: z.number().int().positive(),
});
const CodexUsageResponseSchema = z.object({
  rate_limit: z.object({
    primary_window: z.unknown().optional(),
    secondary_window: z.unknown().optional(),
  }),
});

/** Wham primary/secondary are ordering, not durations: Pro can have only a weekly primary. */
export function parseCodexUsageResponse(
  body: unknown,
  now: Date = new Date(),
): SubscriptionLimitReading | null {
  const parsed = CodexUsageResponseSchema.safeParse(body);
  if (!parsed.success) return null;
  const limits = parsed.data.rate_limit;
  const reading: SubscriptionLimitReading = {
    provider: CHATGPT_OAUTH_PROVIDER,
    fiveHourUtil: null,
    fiveHourResetAt: null,
    sevenDayUtil: null,
    sevenDayResetAt: null,
    status: null,
    observedAt: now,
  };
  for (const window of [limits.primary_window, limits.secondary_window]) {
    const parsedWindow = CodexUsageWindowSchema.safeParse(window);
    if (!parsedWindow.success) continue;
    const used = parsedWindow.data.used_percent;
    const resetAt = new Date(parsedWindow.data.reset_at * 1000);
    if (!Number.isFinite(resetAt.getTime()) || resetAt.getTime() <= now.getTime()) continue;
    if (parsedWindow.data.limit_window_seconds === 18_000) {
      reading.fiveHourUtil = used / 100;
      reading.fiveHourResetAt = resetAt;
    } else if (parsedWindow.data.limit_window_seconds === 604_800) {
      reading.sevenDayUtil = used / 100;
      reading.sevenDayResetAt = resetAt;
    }
  }
  return reading.fiveHourUtil === null && reading.sevenDayUtil === null ? null : reading;
}

export const OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
/** Codex's read-only account allowance endpoint: https://github.com/openai/codex/issues/10869 */
export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const OAUTH_USAGE_CACHE_MS = 10 * 60_000;
export const OAUTH_USAGE_BACKOFF_MS = 15 * 60_000;
const OAUTH_USAGE_TIMEOUT_MS = 10_000;

export type OAuthUsageResult =
  | { kind: "reading"; reading: SubscriptionLimitReading }
  | { kind: "rate_limited" }
  | { kind: "failed" };

/** Tokens and account identifiers stay in request headers, never the returned reading. */
async function fetchOAuthUsage(
  url: string,
  headers: Record<string, string>,
  parse: (body: unknown, now: Date) => SubscriptionLimitReading | null,
  options: { fetch?: typeof fetch; now?: () => Date },
): Promise<OAuthUsageResult> {
  try {
    const response = await (options.fetch ?? globalThis.fetch)(url, {
      method: "GET",
      headers: { ...headers, Accept: "application/json" },
      signal: AbortSignal.timeout(OAUTH_USAGE_TIMEOUT_MS),
    });
    if (response.status === 429) return { kind: "rate_limited" };
    if (!response.ok) return { kind: "failed" };
    const reading = parse(await response.json(), options.now?.() ?? new Date());
    return reading ? { kind: "reading", reading } : { kind: "failed" };
  } catch {
    return { kind: "failed" };
  }
}

export function fetchAnthropicOAuthUsage(
  accessToken: string,
  options: { fetch?: typeof fetch; now?: () => Date } = {},
): Promise<OAuthUsageResult> {
  return fetchOAuthUsage(
    OAUTH_USAGE_URL,
    {
      Authorization: `Bearer ${accessToken}`,
      "anthropic-beta": "oauth-2025-04-20,claude-code-20250219",
    },
    parseOAuthUsageResponse,
    options,
  );
}

export function fetchCodexOAuthUsage(
  accessToken: string,
  accountId: string,
  options: { fetch?: typeof fetch; now?: () => Date } = {},
): Promise<OAuthUsageResult> {
  return fetchOAuthUsage(
    CODEX_USAGE_URL,
    {
      Authorization: `Bearer ${accessToken}`,
      "ChatGPT-Account-Id": accountId,
      "OAI-Product-Sku": "codex",
    },
    parseCodexUsageResponse,
    options,
  );
}

const MIN_TOKEN_VALIDITY_MS = 60_000;

type SubscriptionScope = { userId: string; spaceId: string };
type SubscriptionPrisma = Pick<PrismaClient, "userModelCredential" | "secret">;
type SubscriptionSecrets = Pick<SecretStore, "load" | "put">;
type SubscriptionSecret = { id: string; ciphertext: string };
type SubscriptionCredential = Extract<StoredModelSecret, { kind: "oauth" | "api_key" }>;
export type SubscriptionAccountReading = SubscriptionLimitReading & { label: string };

/** Reuses the runtime's locked refresh and account-identity safeguard. */
async function loadSubscriptionCredential(
  prisma: SubscriptionPrisma,
  secrets: SubscriptionSecrets,
  scope: SubscriptionScope,
  secret: SubscriptionSecret,
  provider: string,
  now: () => number,
): Promise<SubscriptionCredential | undefined> {
  const decrypt = async (row: SubscriptionSecret | null) => {
    if (!row) return undefined;
    try {
      const parsed = parseModelSecret(await secrets.load(row.ciphertext, row.id));
      if (provider === "zai") return parsed.kind === "api_key" ? parsed : undefined;
      return parsed.kind === "oauth" ? parsed : undefined;
    } catch {
      return undefined;
    }
  };
  let parsed = await decrypt(secret);
  if (!parsed) return undefined;
  if (parsed.kind === "api_key") return parsed;
  if (parsed.credential.expires - now() < MIN_TOKEN_VALIDITY_MS) {
    try {
      await refreshExpiredModelCredential(prisma, secrets, scope, secret.id, provider, {
        signal: AbortSignal.timeout(OAUTH_USAGE_TIMEOUT_MS),
      });
    } catch {
      return undefined;
    }
    parsed = await decrypt(
      await prisma.secret.findFirst({
        where: { id: secret.id, userId: scope.userId, spaceId: null },
        select: { id: true, ciphertext: true },
      }),
    );
    if (parsed?.kind !== "oauth" || parsed.credential.expires - now() < MIN_TOKEN_VALIDITY_MS) {
      return undefined;
    }
  }
  return parsed;
}

/**
 * Read-through allowance cache for connected credentials only. Every read checks ownership and
 * secret reference before using cached data; reconnect creates a new reference, token refresh
 * preserves it. All endpoints share the 10-minute throttle, 15-minute backoff and single flight.
 */
export class SubscriptionUsageRefresher {
  private readonly lastAttempt = new Map<string, number>();
  private readonly backoffUntil = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<SubscriptionLimitReading | null>>();
  private readonly readings = new Map<string, SubscriptionLimitReading>();

  constructor(private readonly options: { fetch?: typeof fetch; now?: () => number } = {}) {}

  async read(
    prisma: SubscriptionPrisma,
    secrets: SubscriptionSecrets,
    scope: SubscriptionScope,
  ): Promise<SubscriptionAccountReading[]> {
    const credentials = await prisma.userModelCredential.findMany({
      where: {
        userId: scope.userId,
        provider: { in: [ANTHROPIC_OAUTH_PROVIDER, CHATGPT_OAUTH_PROVIDER, "zai"] },
      },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      select: { provider: true, label: true, secretId: true },
    });
    if (!credentials.length) return [];
    const rows = await prisma.secret.findMany({
      where: {
        id: { in: credentials.map((row) => row.secretId) },
        userId: scope.userId,
        spaceId: null,
      },
      select: { id: true, ciphertext: true },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const seen = new Set<string>();
    const results = await Promise.all(
      credentials.map(async (credential) => {
        if (seen.has(credential.provider)) return null;
        seen.add(credential.provider);
        const secret = byId.get(credential.secretId);
        if (!secret) return null;
        const key = JSON.stringify([scope.userId, scope.spaceId, credential.provider, secret.id]);
        const reading = await this.refresh(key, credential.provider, () =>
          loadSubscriptionCredential(
            prisma,
            secrets,
            scope,
            secret,
            credential.provider,
            this.options.now ?? Date.now,
          ),
        );
        return reading ? { ...reading, label: credential.label } : null;
      }),
    );
    return results.filter((reading): reading is SubscriptionAccountReading => reading !== null);
  }

  private refresh(
    key: string,
    provider: string,
    loadCredential: () => Promise<SubscriptionCredential | undefined>,
  ): Promise<SubscriptionLimitReading | null> {
    const now = (this.options.now ?? Date.now)();
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const cached = this.readings.get(key) ?? null;
    if ((this.backoffUntil.get(key) ?? 0) > now) return Promise.resolve(cached);
    const last = this.lastAttempt.get(key);
    if (last !== undefined && now - last < OAUTH_USAGE_CACHE_MS) return Promise.resolve(cached);
    this.lastAttempt.set(key, now);
    const run = (async () => {
      const credential = await loadCredential();
      if (!credential) return null;
      const options = {
        ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
        now: () => new Date((this.options.now ?? Date.now)()),
      };
      let result: OAuthUsageResult;
      if (provider === "zai" && credential.kind === "api_key") {
        result = await fetchZaiQuotaUsage(credential.key, options);
      } else if (credential.kind === "oauth") {
        const accountId =
          provider === CHATGPT_OAUTH_PROVIDER
            ? oauthCredentialAccountId(credential.credential)
            : undefined;
        result =
          provider === CHATGPT_OAUTH_PROVIDER
            ? accountId
              ? await fetchCodexOAuthUsage(credential.credential.access, accountId, options)
              : { kind: "failed" }
            : await fetchAnthropicOAuthUsage(credential.credential.access, options);
      } else {
        result = { kind: "failed" };
      }
      if (result.kind === "rate_limited") {
        this.backoffUntil.set(key, (this.options.now ?? Date.now)() + OAUTH_USAGE_BACKOFF_MS);
      }
      if (result.kind === "reading") this.readings.set(key, result.reading);
      return result.kind === "reading" ? result.reading : cached;
    })()
      .catch(() => cached)
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, run);
    return run;
  }
}

/** One bar: 0..100 used. Once the window's reset passed, it reads 0% (reset). */
export function subscriptionWindow(
  util: number | null,
  resetAt: Date | null,
  now: Date,
): { usedPct: number | null; resetsAt: string | null; reset: boolean } {
  if (resetAt && resetAt.getTime() <= now.getTime()) {
    return { usedPct: 0, resetsAt: resetAt.toISOString(), reset: true };
  }
  return {
    usedPct: util === null ? null : Math.round(util * 1000) / 10,
    resetsAt: resetAt?.toISOString() ?? null,
    reset: false,
  };
}

const DEFAULT_PREFER_FALLBACK_AT = 0.98;
const UTC_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * RAKAZO_PREFER_FALLBACK_AT (fleet patch): the window utilization (fraction) from which an
 * Anthropic run starts on its first backup model. Unset/invalid: 0.98; `off` or 0: never.
 */
export function preferFallbackThreshold(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.RAKAZO_PREFER_FALLBACK_AT?.trim().toLowerCase();
  if (raw === undefined || raw === "") return DEFAULT_PREFER_FALLBACK_AT;
  if (raw === "off") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) return DEFAULT_PREFER_FALLBACK_AT;
  return value === 0 ? null : value;
}

function utcResetLabel(resetAt: Date): string {
  const hours = String(resetAt.getUTCHours()).padStart(2, "0");
  const minutes = String(resetAt.getUTCMinutes()).padStart(2, "0");
  return `${UTC_WEEKDAYS[resetAt.getUTCDay()]} ${hours}:${minutes} UTC`;
}

/**
 * Why an Anthropic run should start on its backup, or null. The newest reading is loaded only
 * once every other condition holds. A window counts while its utilization is at the threshold
 * and its reset time is still ahead (`subscriptionWindow` reads a passed reset as 0%); with
 * both windows hot, the one resetting last is named.
 */
export async function preferFallbackReason(input: {
  provider: string;
  hasBackups: boolean;
  loadReading: (provider: string) => Promise<SubscriptionLimitReading | null>;
  now: Date;
  env?: NodeJS.ProcessEnv;
}): Promise<string | null> {
  const env = input.env ?? process.env;
  if (!subscriptionLimitsEnabled(env)) return null;
  if (input.provider !== ANTHROPIC_OAUTH_PROVIDER || !input.hasBackups) return null;
  const threshold = preferFallbackThreshold(env);
  if (threshold === null) return null;
  const reading = await input.loadReading(ANTHROPIC_OAUTH_PROVIDER);
  if (!reading) return null;
  const windows = [
    { label: "5-hour", util: reading.fiveHourUtil, resetAt: reading.fiveHourResetAt },
    { label: "weekly", util: reading.sevenDayUtil, resetAt: reading.sevenDayResetAt },
  ];
  let blocking: { label: string; util: number; resetAt: Date } | undefined;
  for (const { label, util, resetAt } of windows) {
    if (util === null || util < threshold) continue;
    if (!resetAt || resetAt.getTime() <= input.now.getTime()) continue;
    if (!blocking || resetAt.getTime() > blocking.resetAt.getTime()) {
      blocking = { label, util, resetAt };
    }
  }
  if (!blocking) return null;
  return `Anthropic ${blocking.label} limit ${Math.round(blocking.util * 100)}% used (resets ${utcResetLabel(blocking.resetAt)})`;
}

export interface ThreadUsageRow {
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  runId: string | null;
  parentRunId: string | null;
  operationKind: string;
}

let cachedModels: Models | undefined;

/** Context window from Pi's model catalog; null for an unknown model. */
export function modelContextWindow(provider: string, modelId: string): number | null {
  cachedModels ??= builtinModels();
  const model = cachedModels
    .getProviders()
    .find((candidate) => candidate.id === provider)
    ?.getModels()
    .find((candidate) => candidate.id === modelId);
  return model?.contextWindow ?? null;
}

/**
 * The chat line. Context = the latest main call's input + cache read + cache write; cache % =
 * cache reads over all input today; cost is the API-price equivalent of today's calls.
 */
export function summarizeThreadUsage(
  today: ThreadUsageRow[],
  latest: ThreadUsageRow | null,
  contextWindowOf: (provider: string, modelId: string) => number | null = modelContextWindow,
) {
  const contextTokens = latest
    ? (latest.inputTokens ?? 0) + (latest.cacheReadTokens ?? 0) + (latest.cacheWriteTokens ?? 0)
    : null;
  const contextWindow = latest ? contextWindowOf(latest.provider, latest.model) : null;
  let input = 0;
  let cacheRead = 0;
  let tokens = 0;
  let cost = 0;
  let costKnown = false;
  const runs = new Set<string>();
  for (const row of today) {
    input += (row.inputTokens ?? 0) + (row.cacheReadTokens ?? 0) + (row.cacheWriteTokens ?? 0);
    cacheRead += row.cacheReadTokens ?? 0;
    tokens +=
      row.totalTokens ??
      (row.inputTokens ?? 0) +
        (row.outputTokens ?? 0) +
        (row.cacheReadTokens ?? 0) +
        (row.cacheWriteTokens ?? 0);
    if (row.costUsd !== null) {
      cost += row.costUsd;
      costKnown = true;
    }
    const run = row.parentRunId ?? row.runId;
    if (run) runs.add(run);
  }
  return {
    lastModel: latest ? { provider: latest.provider, model: latest.model } : null,
    contextTokens,
    contextWindow,
    contextPct:
      contextTokens !== null && contextWindow
        ? Math.round((contextTokens / contextWindow) * 1000) / 10
        : null,
    cachePctToday: input > 0 ? Math.round((cacheRead / input) * 1000) / 10 : null,
    tokensToday: tokens,
    runsToday: runs.size,
    apiEquivalentCostUsdToday: costKnown ? Math.round(cost * 10_000) / 10_000 : null,
  };
}
