import type { SecretStore, SubscriptionLimitReading } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import {
  ANTHROPIC_OAUTH_PROVIDER,
  parseModelSecret,
  refreshExpiredModelCredential,
} from "./pi-oauth.js";

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
  const util = typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw / 100 : null;
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

export const OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const OAUTH_USAGE_CACHE_MS = 10 * 60_000;
export const OAUTH_USAGE_BACKOFF_MS = 15 * 60_000;
const OAUTH_USAGE_TIMEOUT_MS = 10_000;

export type OAuthUsageResult =
  | { kind: "reading"; reading: SubscriptionLimitReading }
  | { kind: "rate_limited" }
  | { kind: "failed" };

/** The token goes only into the Authorization header; it is never logged or returned. */
export async function fetchAnthropicOAuthUsage(
  accessToken: string,
  options: { fetch?: typeof fetch; now?: () => Date } = {},
): Promise<OAuthUsageResult> {
  const fetcher = options.fetch ?? globalThis.fetch;
  try {
    const response = await fetcher(OAUTH_USAGE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20,claude-code-20250219",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(OAUTH_USAGE_TIMEOUT_MS),
    });
    if (response.status === 429) return { kind: "rate_limited" };
    if (!response.ok) return { kind: "failed" };
    const reading = parseOAuthUsageResponse(await response.json(), options.now?.() ?? new Date());
    return reading ? { kind: "reading", reading } : { kind: "failed" };
  } catch {
    return { kind: "failed" };
  }
}

const MIN_TOKEN_VALIDITY_MS = 60_000;

/**
 * The newest Anthropic subscription (OAuth) credential of this user, refreshed when about to
 * expire. Read server-side only; undefined when the user has none.
 */
export async function loadAnthropicSubscriptionToken(
  prisma: Pick<PrismaClient, "userModelCredential" | "secret">,
  secrets: Pick<SecretStore, "load" | "put">,
  scope: { userId: string; spaceId: string },
  now: () => number = Date.now,
): Promise<string | undefined> {
  const credential = await prisma.userModelCredential.findFirst({
    where: { userId: scope.userId, provider: ANTHROPIC_OAUTH_PROVIDER },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    select: { secretId: true },
  });
  if (!credential) return undefined;
  const read = async () => {
    const row = await prisma.secret.findFirst({
      where: { id: credential.secretId, userId: scope.userId },
      select: { id: true, ciphertext: true },
    });
    if (!row) return undefined;
    try {
      const parsed = parseModelSecret(await secrets.load(row.ciphertext, row.id));
      return parsed.kind === "oauth" ? parsed.credential : undefined;
    } catch {
      return undefined;
    }
  };
  let oauth = await read();
  if (!oauth) return undefined;
  if (oauth.expires - now() < MIN_TOKEN_VALIDITY_MS) {
    try {
      await refreshExpiredModelCredential(
        prisma,
        secrets,
        scope,
        credential.secretId,
        ANTHROPIC_OAUTH_PROVIDER,
        { signal: AbortSignal.timeout(OAUTH_USAGE_TIMEOUT_MS) },
      );
    } catch {
      return undefined;
    }
    oauth = await read();
    if (!oauth || oauth.expires - now() < MIN_TOKEN_VALIDITY_MS) return undefined;
  }
  return oauth.access;
}

/**
 * Idle refresh for the usage bars: at most one `/api/oauth/usage` call per user per 10 min,
 * none for 15 min after a 429. Concurrent callers share one request.
 */
export class SubscriptionUsageRefresher {
  private readonly lastAttempt = new Map<string, number>();
  private readonly backoffUntil = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<SubscriptionLimitReading | null>>();

  constructor(
    private readonly options: {
      loadToken: (key: string) => Promise<string | undefined>;
      fetch?: typeof fetch;
      now?: () => number;
    },
  ) {}

  refresh(key: string): Promise<SubscriptionLimitReading | null> {
    const now = (this.options.now ?? Date.now)();
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    if ((this.backoffUntil.get(key) ?? 0) > now) return Promise.resolve(null);
    const last = this.lastAttempt.get(key);
    if (last !== undefined && now - last < OAUTH_USAGE_CACHE_MS) return Promise.resolve(null);
    this.lastAttempt.set(key, now);
    const run = (async () => {
      const token = await this.options.loadToken(key);
      if (!token) return null;
      const result = await fetchAnthropicOAuthUsage(token, {
        ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
        now: () => new Date((this.options.now ?? Date.now)()),
      });
      if (result.kind === "rate_limited") {
        this.backoffUntil.set(key, (this.options.now ?? Date.now)() + OAUTH_USAGE_BACKOFF_MS);
        return null;
      }
      return result.kind === "reading" ? result.reading : null;
    })()
      .catch(() => null)
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, run);
    return run;
  }
}
