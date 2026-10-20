import type { Api, AssistantMessage, Model, Models } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { SubscriptionLimitReading } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { observedPiStream } from "./pi-usage.js";
import {
  fetchAnthropicOAuthUsage,
  OAUTH_USAGE_URL,
  parseOAuthUsageResponse,
  parseRateLimitHeaders,
  preferFallbackReason,
  preferFallbackThreshold,
  SubscriptionUsageRefresher,
  subscriptionLimitsEnabled,
  subscriptionWindow,
  summarizeThreadUsage,
} from "./subscription-limits.js";

const NOW = new Date("2026-10-19T10:00:00Z");
const FAKE_HEADERS = {
  "anthropic-ratelimit-unified-5h-utilization": "0.42",
  "anthropic-ratelimit-unified-5h-reset": "1760875200",
  "anthropic-ratelimit-unified-7d-utilization": "0.7",
  "anthropic-ratelimit-unified-7d-reset": "1761300000",
  "anthropic-ratelimit-unified-status": "allowed_warning",
  "content-type": "text/event-stream",
};

describe("subscription limit headers", () => {
  it("reads the flag", () => {
    expect(subscriptionLimitsEnabled({})).toBe(false);
    expect(subscriptionLimitsEnabled({ RAKAZO_SUBSCRIPTION_LIMITS: "true" })).toBe(true);
    expect(subscriptionLimitsEnabled({ RAKAZO_SUBSCRIPTION_LIMITS: "0" })).toBe(false);
  });

  it("parses the unified 5h and 7d windows", () => {
    expect(parseRateLimitHeaders(FAKE_HEADERS, "anthropic", NOW)).toEqual({
      provider: "anthropic",
      fiveHourUtil: 0.42,
      fiveHourResetAt: new Date(1760875200 * 1000),
      sevenDayUtil: 0.7,
      sevenDayResetAt: new Date(1761300000 * 1000),
      status: "allowed_warning",
      observedAt: NOW,
    });
  });

  it("is case-insensitive and lenient about missing or broken values", () => {
    expect(
      parseRateLimitHeaders(
        {
          "Anthropic-Ratelimit-Unified-7d-Utilization": "0.1",
          "anthropic-ratelimit-unified-5h-utilization": "n/a",
          "anthropic-ratelimit-unified-7d-reset": "",
        },
        "anthropic",
        NOW,
      ),
    ).toMatchObject({ fiveHourUtil: null, sevenDayUtil: 0.1, sevenDayResetAt: null, status: null });
  });

  it("returns null without window headers", () => {
    expect(parseRateLimitHeaders({ "content-type": "text/plain" }, "anthropic")).toBeNull();
    expect(
      parseRateLimitHeaders({ "anthropic-ratelimit-unified-status": "allowed" }, "anthropic"),
    ).toBeNull();
    expect(parseRateLimitHeaders(undefined, "anthropic")).toBeNull();
  });
});

const model: Model<Api> = {
  provider: "anthropic",
  id: "fixture",
  api: "anthropic-messages",
  name: "fixture",
  baseUrl: "https://model.example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
  contextWindow: 4096,
  maxTokens: 256,
};

function fakeModels(headers: Record<string, string>): Models {
  return {
    streamSimple: (
      requestModel: Model<Api>,
      _context: unknown,
      options?: {
        onResponse?: (
          response: { status: number; headers: Record<string, string> },
          model: Model<Api>,
        ) => unknown;
      },
    ) => {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        await options?.onResponse?.({ status: 200, headers }, requestModel);
        const message: AssistantMessage = {
          role: "assistant",
          content: [{ type: "text", text: "Done" }],
          api: requestModel.api,
          provider: requestModel.provider,
          model: requestModel.id,
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 1,
        };
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
      })();
      return stream;
    },
  } as unknown as Models;
}

describe("observedPiStream rate-limit hook", () => {
  it("passes a reading to onRateLimit and still calls the caller's onResponse", async () => {
    const readings: SubscriptionLimitReading[] = [];
    const callerOnResponse = vi.fn();
    const stream = observedPiStream(
      fakeModels(FAKE_HEADERS),
      model,
      { messages: [] },
      { onResponse: callerOnResponse },
      () => {},
      undefined,
      undefined,
      { onRateLimit: (reading) => void readings.push(reading) },
    );
    for await (const _event of stream) {
    }
    expect(readings).toHaveLength(1);
    expect(readings[0]).toMatchObject({ provider: "anthropic", fiveHourUtil: 0.42 });
    expect(callerOnResponse).toHaveBeenCalledOnce();
  });

  it("never fails the call when saving the reading throws", async () => {
    const stream = observedPiStream(
      fakeModels(FAKE_HEADERS),
      model,
      { messages: [] },
      undefined,
      () => {},
      undefined,
      undefined,
      {
        onRateLimit: () => {
          throw new Error("Synthetic store failure");
        },
      },
    );
    for await (const _event of stream) {
    }
    expect((await stream.result()).stopReason).toBe("stop");
  });

  it("skips calls without the headers", async () => {
    const onRateLimit = vi.fn();
    const stream = observedPiStream(
      fakeModels({ "content-type": "text/event-stream" }),
      model,
      { messages: [] },
      undefined,
      () => {},
      undefined,
      undefined,
      { onRateLimit },
    );
    for await (const _event of stream) {
    }
    expect(onRateLimit).not.toHaveBeenCalled();
  });
});

describe("oauth usage endpoint", () => {
  it("converts percentages and ISO resets", () => {
    expect(
      parseOAuthUsageResponse(
        {
          five_hour: { utilization: 42, resets_at: "2026-10-19T12:00:00Z" },
          seven_day: { utilization: 70.5, resets_at: null },
          seven_day_opus: { utilization: 1, resets_at: null },
        },
        NOW,
      ),
    ).toEqual({
      provider: "anthropic",
      fiveHourUtil: 0.42,
      fiveHourResetAt: new Date("2026-10-19T12:00:00Z"),
      sevenDayUtil: 0.705,
      sevenDayResetAt: null,
      status: null,
      observedAt: NOW,
    });
    expect(parseOAuthUsageResponse({ five_hour: null })).toBeNull();
    expect(parseOAuthUsageResponse("nope")).toBeNull();
  });

  it("sends the bearer token and beta flag, and reports 429", async () => {
    const fetcher = vi.fn(async () => new Response("", { status: 429 }));
    await expect(
      fetchAnthropicOAuthUsage("fake-fixture-token", { fetch: fetcher as typeof fetch }),
    ).resolves.toEqual({ kind: "rate_limited" });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(OAUTH_USAGE_URL);
    expect(init.headers).toMatchObject({
      Authorization: "Bearer fake-fixture-token",
      "anthropic-beta": "oauth-2025-04-20,claude-code-20250219",
    });
  });

  it("caches for 10 minutes and backs off after a 429", async () => {
    let now = NOW.getTime();
    const responses = [
      new Response(JSON.stringify({ five_hour: { utilization: 10, resets_at: null } })),
      new Response("", { status: 429 }),
      new Response(JSON.stringify({ five_hour: { utilization: 20, resets_at: null } })),
    ];
    const fetcher = vi.fn(async () => responses.shift() as Response);
    const refresher = new SubscriptionUsageRefresher({
      fetch: fetcher as typeof fetch,
      now: () => now,
    });
    const token = async () => "fake-fixture-token";
    expect((await refresher.refresh("user", token))?.fiveHourUtil).toBe(0.1);
    expect(await refresher.refresh("user", token)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 10 * 60_000;
    expect(await refresher.refresh("user", token)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
    now += 10 * 60_000;
    expect(await refresher.refresh("user", token)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
    now += 6 * 60_000;
    expect((await refresher.refresh("user", token))?.fiveHourUtil).toBe(0.2);
  });

  it("does not call the endpoint without a subscription credential", async () => {
    const fetcher = vi.fn();
    const refresher = new SubscriptionUsageRefresher({
      fetch: fetcher as unknown as typeof fetch,
    });
    expect(await refresher.refresh("user", async () => undefined)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("usage shapes", () => {
  it("shows 0% once a window's reset passed", () => {
    const past = new Date(NOW.getTime() - 1000);
    const future = new Date(NOW.getTime() + 3_600_000);
    expect(subscriptionWindow(0.93, past, NOW)).toEqual({
      usedPct: 0,
      resetsAt: past.toISOString(),
      reset: true,
    });
    expect(subscriptionWindow(0.4234, future, NOW)).toEqual({
      usedPct: 42.3,
      resetsAt: future.toISOString(),
      reset: false,
    });
    expect(subscriptionWindow(null, null, NOW)).toEqual({
      usedPct: null,
      resetsAt: null,
      reset: false,
    });
  });

  it("sums today's chat usage and sizes the context from the latest call", () => {
    const row = {
      provider: "anthropic",
      model: "fixture",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 800,
      cacheWriteTokens: 100,
      totalTokens: 1050,
      costUsd: 0.01,
      runId: "run-1",
      parentRunId: "run-1",
      operationKind: "answer",
    };
    const second = { ...row, runId: "run-2", parentRunId: "run-2", costUsd: null };
    const rows = [row, second, { ...row, runId: null }];
    expect(summarizeThreadUsage(rows, second, () => 10_000)).toEqual({
      contextTokens: 1000,
      contextWindow: 10_000,
      contextPct: 10,
      cachePctToday: 80,
      tokensToday: 3150,
      runsToday: 2,
      apiEquivalentCostUsdToday: 0.02,
    });
    expect(summarizeThreadUsage([], null, () => null)).toEqual({
      contextTokens: null,
      contextWindow: null,
      contextPct: null,
      cachePctToday: null,
      tokensToday: 0,
      runsToday: 0,
      apiEquivalentCostUsdToday: null,
    });
  });
});

describe("prefer the backup near the Anthropic limit", () => {
  const ENABLED = { RAKAZO_SUBSCRIPTION_LIMITS: "true" };
  const WEEKLY_RESET = new Date("2026-10-21T08:00:00Z");
  const reading = (
    overrides: Partial<SubscriptionLimitReading> = {},
  ): SubscriptionLimitReading => ({
    provider: "anthropic",
    fiveHourUtil: 0.3,
    fiveHourResetAt: new Date("2026-10-19T12:00:00Z"),
    sevenDayUtil: 0.98,
    sevenDayResetAt: WEEKLY_RESET,
    status: "allowed_warning",
    observedAt: new Date("2026-10-19T09:00:00Z"),
    ...overrides,
  });
  const reason = (
    overrides: Partial<Parameters<typeof preferFallbackReason>[0]> = {},
    latest: SubscriptionLimitReading | null = reading(),
  ) =>
    preferFallbackReason({
      provider: "anthropic",
      hasBackups: true,
      loadReading: async () => latest,
      now: NOW,
      env: ENABLED,
      ...overrides,
    });

  it("reads the threshold", () => {
    expect(preferFallbackThreshold({})).toBe(0.98);
    expect(preferFallbackThreshold({ RAKAZO_PREFER_FALLBACK_AT: "0.9" })).toBe(0.9);
    expect(preferFallbackThreshold({ RAKAZO_PREFER_FALLBACK_AT: "nope" })).toBe(0.98);
    expect(preferFallbackThreshold({ RAKAZO_PREFER_FALLBACK_AT: "1.5" })).toBe(0.98);
    expect(preferFallbackThreshold({ RAKAZO_PREFER_FALLBACK_AT: " OFF " })).toBeNull();
    expect(preferFallbackThreshold({ RAKAZO_PREFER_FALLBACK_AT: "0" })).toBeNull();
  });

  it("names the hot window while its reset is ahead", async () => {
    await expect(reason()).resolves.toBe("Anthropic weekly limit 98% used (resets Wed 08:00 UTC)");
    await expect(reason({}, reading({ fiveHourUtil: 0.99, sevenDayUtil: 0.5 }))).resolves.toBe(
      "Anthropic 5-hour limit 99% used (resets Mon 12:00 UTC)",
    );
  });

  it("names the window that resets last when both are hot", async () => {
    await expect(reason({}, reading({ fiveHourUtil: 1 }))).resolves.toBe(
      "Anthropic weekly limit 98% used (resets Wed 08:00 UTC)",
    );
  });

  it("stays on Anthropic below the threshold or once the window reset", async () => {
    await expect(reason({}, reading({ sevenDayUtil: 0.97 }))).resolves.toBeNull();
    await expect(
      reason({ now: new Date(WEEKLY_RESET.getTime() + 1) }, reading()),
    ).resolves.toBeNull();
    await expect(reason({ now: WEEKLY_RESET }, reading())).resolves.toBeNull();
    await expect(reason({}, reading({ sevenDayResetAt: null }))).resolves.toBeNull();
    await expect(reason({}, null)).resolves.toBeNull();
  });

  it("honours a custom threshold", async () => {
    const env = { ...ENABLED, RAKAZO_PREFER_FALLBACK_AT: "0.95" };
    await expect(reason({ env }, reading({ sevenDayUtil: 0.96 }))).resolves.toBe(
      "Anthropic weekly limit 96% used (resets Wed 08:00 UTC)",
    );
  });

  it("skips the reading for other providers, no backups, or a switch that is off", async () => {
    const loadReading = vi.fn(async () => reading());
    for (const overrides of [
      { provider: "openai-codex" },
      { hasBackups: false },
      { env: {} },
      { env: { ...ENABLED, RAKAZO_PREFER_FALLBACK_AT: "off" } },
      { env: { ...ENABLED, RAKAZO_PREFER_FALLBACK_AT: "0" } },
    ]) {
      await expect(reason({ ...overrides, loadReading })).resolves.toBeNull();
    }
    expect(loadReading).not.toHaveBeenCalled();
  });
});
