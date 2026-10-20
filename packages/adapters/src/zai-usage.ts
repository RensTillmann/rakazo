import type { SubscriptionLimitReading } from "@rakazo/adapter-kit";

const QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
const TIMEOUT_MS = 8_000;

type ZaiUsageResult =
  | { kind: "reading"; reading: SubscriptionLimitReading }
  | { kind: "rate_limited" }
  | { kind: "failed" };

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** GLM Coding Plan model-credit windows, not the separate monthly MCP quota.
 * Endpoint/auth: https://github.com/zai-org/zai-coding-plugins/tree/main/plugins/glm-plan-usage
 * Quota reset timestamps are milliseconds; a missing reset must stay unknown.
 */
export function parseZaiQuotaUsageResponse(
  body: unknown,
  now = new Date(),
): SubscriptionLimitReading | null {
  const root = object(body);
  if (!root || root.success === false || (root.code !== undefined && root.code !== 200))
    return null;
  const data = object(root.data);
  if (!Array.isArray(data?.limits)) return null;
  const reading: SubscriptionLimitReading = {
    provider: "zai",
    fiveHourUtil: null,
    fiveHourResetAt: null,
    sevenDayUtil: null,
    sevenDayResetAt: null,
    status: null,
    observedAt: now,
  };
  for (const raw of data.limits) {
    const limit = object(raw);
    if (!limit || (limit.type !== "CREDIT_LIMIT" && limit.type !== "TOKENS_LIMIT")) continue;
    const pct = limit.percentage;
    if (typeof pct !== "number" || !Number.isFinite(pct) || pct < 0 || pct > 100) continue;
    const reset =
      typeof limit.nextResetTime === "number" && limit.nextResetTime > 0
        ? new Date(limit.nextResetTime)
        : null;
    const resetAt = reset && !Number.isNaN(reset.getTime()) ? reset : null;
    // Quota units: 3 = hours, 6 = weeks; `number` is the window length.
    if (limit.unit === 3 && limit.number === 5) {
      reading.fiveHourUtil = pct / 100;
      reading.fiveHourResetAt = resetAt;
    } else if (limit.unit === 6 && limit.number === 1) {
      reading.sevenDayUtil = pct / 100;
      reading.sevenDayResetAt = resetAt;
    }
  }
  return reading.fiveHourUtil === null && reading.sevenDayUtil === null ? null : reading;
}

export async function fetchZaiQuotaUsage(
  apiKey: string,
  options: { fetch?: typeof fetch; now?: () => Date } = {},
): Promise<ZaiUsageResult> {
  try {
    const response = await (options.fetch ?? fetch)(QUOTA_URL, {
      method: "GET",
      headers: {
        Authorization: apiKey,
        "Accept-Language": "en-US,en",
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 429) return { kind: "rate_limited" };
    if (!response.ok) return { kind: "failed" };
    const reading = parseZaiQuotaUsageResponse(
      await response.json(),
      options.now?.() ?? new Date(),
    );
    return reading ? { kind: "reading", reading } : { kind: "failed" };
  } catch {
    return { kind: "failed" };
  }
}
