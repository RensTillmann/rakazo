import type { Api, AssistantMessage, Model, Models } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { SecretContext, SubscriptionLimitReading } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { serializeModelSecret } from "./pi-oauth.js";
import { observedPiStream } from "./pi-usage.js";
import {
  CODEX_USAGE_URL,
  fetchCodexOAuthUsage,
  OAUTH_USAGE_URL,
  parseCodexUsageResponse,
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

function subscriptionFixture(provider = "anthropic") {
  const scope = { userId: "user-1", spaceId: "space-1" };
  const credentials: { userId: string; provider: string; label: string; secretId: string }[] = [];
  const rows: { id: string; userId: string; spaceId: null; ciphertext: string }[] = [];
  const plaintexts: Record<string, string> = {};
  const connect = (userId: string, selectedProvider: string, id: string) => {
    credentials.push({ userId, provider: selectedProvider, label: selectedProvider, secretId: id });
    rows.push({ id, userId, spaceId: null, ciphertext: `encrypted-${id}` });
    plaintexts[id] = serializeModelSecret({
      kind: "oauth",
      credential: {
        type: "oauth",
        access: `fake-access-${id}`,
        refresh: "fake-refresh",
        accountId: "fake-account",
        expires: NOW.getTime() + 86_400_000,
      },
    });
  };
  connect(scope.userId, provider, "secret-1");
  const credentialFindMany = vi.fn(
    async ({ where }: { where: { userId: string; provider: { in: string[] } } }) =>
      credentials.filter(
        (row) => row.userId === where.userId && where.provider.in.includes(row.provider),
      ),
  );
  const secretFindMany = vi.fn(
    async ({ where }: { where: { id: { in: string[] }; userId: string; spaceId: null } }) =>
      rows.filter(
        (row) =>
          where.id.in.includes(row.id) &&
          row.userId === where.userId &&
          row.spaceId === where.spaceId,
      ),
  );
  const secrets = {
    load: vi.fn(async (_ciphertext: string, context: SecretContext) => {
      const id = typeof context === "string" ? context : context.recordId;
      return plaintexts[id] ?? "";
    }),
    put: vi.fn(),
  };
  const prisma = {
    userModelCredential: { findMany: credentialFindMany },
    secret: { findMany: secretFindMany },
  } as unknown as PrismaClient;
  return { prisma, secrets, scope, credentials, rows, plaintexts, connect, secretFindMany };
}

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

  it("keeps a valid weekly reading when another window reports an invalid percentage", () => {
    expect(
      parseOAuthUsageResponse(
        {
          five_hour: { utilization: 101 },
          seven_day: { utilization: 98 },
        },
        NOW,
      ),
    ).toMatchObject({ fiveHourUtil: null, sevenDayUtil: 0.98 });
  });

  it("caches readings and token decryption for 10 minutes and backs off 15 minutes after 429", async () => {
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
    const { prisma, secrets, scope } = subscriptionFixture();
    const read = () => refresher.read(prisma, secrets, scope);
    expect((await read())[0]?.fiveHourUtil).toBe(0.1);
    expect((await read())[0]?.fiveHourUtil).toBe(0.1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(secrets.load).toHaveBeenCalledTimes(1);
    now += 10 * 60_000;
    expect((await read())[0]?.fiveHourUtil).toBe(0.1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    now += 10 * 60_000;
    expect((await read())[0]?.fiveHourUtil).toBe(0.1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(secrets.load).toHaveBeenCalledTimes(2);
    now += 5 * 60_000;
    expect((await read())[0]?.fiveHourUtil).toBe(0.2);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("does not request usage without an owned subscription secret", async () => {
    const fetcher = vi.fn();
    const refresher = new SubscriptionUsageRefresher({ fetch: fetcher, now: () => NOW.getTime() });
    const fixture = subscriptionFixture();
    fixture.rows[0]!.userId = "another-user";
    expect(await refresher.read(fixture.prisma, fixture.secrets, fixture.scope)).toEqual([]);
    expect(fixture.secrets.load).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not substitute an API key for an OAuth-only provider", async () => {
    const fetcher = vi.fn();
    const refresher = new SubscriptionUsageRefresher({ fetch: fetcher, now: () => NOW.getTime() });
    const fixture = subscriptionFixture("openai-codex");
    fixture.plaintexts["secret-1"] = "fake-api-key";
    expect(await refresher.read(fixture.prisma, fixture.secrets, fixture.scope)).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("shares one in-flight read for concurrent callers", async () => {
    let resolve!: (response: Response) => void;
    const response = new Promise<Response>((done) => {
      resolve = done;
    });
    const fetcher = vi.fn(async () => response);
    const refresher = new SubscriptionUsageRefresher({ fetch: fetcher, now: () => NOW.getTime() });
    const { prisma, secrets, scope } = subscriptionFixture();
    const first = refresher.read(prisma, secrets, scope);
    const second = refresher.read(prisma, secrets, scope);
    resolve(new Response(JSON.stringify({ five_hour: { utilization: 42 } })));
    const results = await Promise.all([first, second]);
    expect(results[0]?.[0]?.fiveHourUtil).toBe(0.42);
    expect(results[1]?.[0]?.fiveHourUtil).toBe(0.42);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(secrets.load).toHaveBeenCalledOnce();
  });

  it("isolates actor caches and immediately drops allowance after disconnect", async () => {
    const responses = [
      new Response(JSON.stringify({ five_hour: { utilization: 10 } })),
      new Response(JSON.stringify({ five_hour: { utilization: 90 } })),
    ];
    const fetcher = vi.fn(async () => responses.shift() as Response);
    const refresher = new SubscriptionUsageRefresher({ fetch: fetcher, now: () => NOW.getTime() });
    const { prisma, secrets, scope, credentials, connect } = subscriptionFixture();
    connect("user-2", "anthropic", "secret-2");
    expect((await refresher.read(prisma, secrets, scope))[0]?.fiveHourUtil).toBe(0.1);
    expect(
      (await refresher.read(prisma, secrets, { ...scope, userId: "user-2" }))[0]?.fiveHourUtil,
    ).toBe(0.9);
    expect((await refresher.read(prisma, secrets, scope))[0]?.fiveHourUtil).toBe(0.1);
    credentials.splice(0, 1);
    expect(await refresher.read(prisma, secrets, scope)).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not inherit usage or 429 backoff when reconnect replaces a credential reference", async () => {
    const responses = [
      new Response(JSON.stringify({ five_hour: { utilization: 98 } })),
      new Response("", { status: 429 }),
      new Response(JSON.stringify({ five_hour: { utilization: 2 } })),
    ];
    const fetcher = vi.fn(async () => responses.shift() as Response);
    const refresher = new SubscriptionUsageRefresher({ fetch: fetcher, now: () => NOW.getTime() });
    const { prisma, secrets, scope, credentials, connect } = subscriptionFixture();
    expect((await refresher.read(prisma, secrets, scope))[0]?.fiveHourUtil).toBe(0.98);
    credentials.splice(0, 1);
    connect(scope.userId, "anthropic", "secret-reconnect");
    expect(await refresher.read(prisma, secrets, scope)).toEqual([]);
    credentials.splice(0, 1);
    connect(scope.userId, "anthropic", "secret-reconnect-again");
    expect((await refresher.read(prisma, secrets, scope))[0]?.fiveHourUtil).toBe(0.02);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("scopes backoff and readings by space while ordinary token rotation retains the throttle", async () => {
    const responses = [
      new Response(JSON.stringify({ five_hour: { utilization: 42 } })),
      new Response("", { status: 429 }),
    ];
    const fetcher = vi.fn(async () => responses.shift() as Response);
    const refresher = new SubscriptionUsageRefresher({ fetch: fetcher, now: () => NOW.getTime() });
    const { prisma, secrets, scope, rows } = subscriptionFixture();
    expect((await refresher.read(prisma, secrets, scope))[0]?.fiveHourUtil).toBe(0.42);
    rows[0]!.ciphertext = "rotated-same-account";
    expect((await refresher.read(prisma, secrets, scope))[0]?.fiveHourUtil).toBe(0.42);
    expect(await refresher.read(prisma, secrets, { ...scope, spaceId: "space-2" })).toEqual([]);
    expect((await refresher.read(prisma, secrets, scope))[0]?.fiveHourUtil).toBe(0.42);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(secrets.load).toHaveBeenCalledTimes(2);
  });

  it("reads each connected provider through its own authenticated endpoint, including measured Z.AI zero", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (url === CODEX_USAGE_URL)
        return new Response(
          JSON.stringify({
            rate_limit: {
              primary_window: {
                used_percent: 2,
                limit_window_seconds: 604800,
                reset_at: 1793089481,
              },
            },
          }),
        );
      if (url === OAUTH_USAGE_URL)
        return new Response(
          JSON.stringify({
            seven_day: { utilization: 98, resets_at: "2026-10-27T00:00:00Z" },
          }),
        );
      return new Response(
        JSON.stringify({
          success: true,
          code: 200,
          data: {
            limits: [
              { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 0 },
              {
                type: "CREDIT_LIMIT",
                unit: 6,
                number: 1,
                percentage: 0,
                nextResetTime: 1793075423998,
              },
            ],
          },
        }),
      );
    });
    const refresher = new SubscriptionUsageRefresher({ fetch: fetcher, now: () => NOW.getTime() });
    const { prisma, secrets, scope, plaintexts, connect } = subscriptionFixture();
    connect(scope.userId, "openai-codex", "codex-secret");
    connect(scope.userId, "zai", "zai-secret");
    plaintexts["zai-secret"] = "fake-zai-key";
    const readings = await refresher.read(prisma, secrets, scope);
    expect(readings.map(({ provider, sevenDayUtil }) => [provider, sevenDayUtil])).toEqual([
      ["anthropic", 0.98],
      ["openai-codex", 0.02],
      ["zai", 0],
    ]);
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.z.ai/api/monitor/usage/quota/limit",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "fake-zai-key" }),
      }),
    );
    expect(fetcher).toHaveBeenCalledWith(
      CODEX_USAGE_URL,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer fake-access-codex-secret",
          "ChatGPT-Account-Id": "fake-account",
        }),
      }),
    );
    expect(JSON.stringify(readings)).not.toContain("fake-access");
    expect(JSON.stringify(readings)).not.toContain("fake-zai-key");
    expect(JSON.stringify(readings)).not.toContain("fake-account");
  });

  it("does not send a Codex request without a verified credential account identity", async () => {
    const fetcher = vi.fn();
    const refresher = new SubscriptionUsageRefresher({ fetch: fetcher, now: () => NOW.getTime() });
    const fixture = subscriptionFixture("openai-codex");
    fixture.plaintexts["secret-1"] = serializeModelSecret({
      kind: "oauth",
      credential: {
        type: "oauth",
        access: "not-a-jwt",
        refresh: "fake-refresh",
        expires: NOW.getTime() + 86_400_000,
      },
    });
    expect(await refresher.read(fixture.prisma, fixture.secrets, fixture.scope)).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("Codex subscription usage", () => {
  const weekly = {
    used_percent: 2,
    limit_window_seconds: 604800,
    reset_at: 1793089481,
    reset_after_seconds: 577774,
  };

  it("classifies a weekly primary by duration rather than its position", () => {
    expect(
      parseCodexUsageResponse(
        {
          rate_limit: { primary_window: weekly, secondary_window: null },
        },
        NOW,
      ),
    ).toEqual({
      provider: "openai-codex",
      fiveHourUtil: null,
      fiveHourResetAt: null,
      sevenDayUtil: 0.02,
      sevenDayResetAt: new Date(1793089481000),
      status: null,
      observedAt: NOW,
    });
  });

  it("preserves known zero and handles reversed primary/secondary windows", () => {
    expect(
      parseCodexUsageResponse(
        {
          rate_limit: {
            primary_window: weekly,
            secondary_window: { ...weekly, used_percent: 0, limit_window_seconds: 18000 },
          },
        },
        NOW,
      ),
    ).toMatchObject({ fiveHourUtil: 0, sevenDayUtil: 0.02 });
  });

  it.each([null, -1, 101, NaN, Infinity, "2"])("rejects invalid utilization %s", (used) => {
    expect(
      parseCodexUsageResponse(
        {
          rate_limit: { primary_window: { ...weekly, used_percent: used } },
        },
        NOW,
      ),
    ).toBeNull();
  });

  it.each([null, -1, 0, Infinity, 1e20, "1793089481"])("rejects uncertain reset %s", (reset) => {
    expect(
      parseCodexUsageResponse(
        {
          rate_limit: { primary_window: { ...weekly, reset_at: reset } },
        },
        NOW,
      ),
    ).toBeNull();
  });

  it("keeps a valid alternate window while rejecting an expired or malformed primary", () => {
    expect(
      parseCodexUsageResponse(
        {
          rate_limit: {
            primary_window: { ...weekly, limit_window_seconds: 18000, reset_at: 1 },
            secondary_window: weekly,
          },
        },
        NOW,
      ),
    ).toMatchObject({ fiveHourUtil: null, fiveHourResetAt: null, sevenDayUtil: 0.02 });
    expect(
      parseCodexUsageResponse(
        {
          rate_limit: { primary_window: ["invalid"], secondary_window: weekly },
        },
        NOW,
      ),
    ).toMatchObject({ fiveHourUtil: null, sevenDayUtil: 0.02 });
  });

  it("does not guess an unsupported duration or a relative-only reset", () => {
    expect(
      parseCodexUsageResponse(
        {
          rate_limit: { primary_window: { ...weekly, limit_window_seconds: 3600 } },
        },
        NOW,
      ),
    ).toBeNull();
    expect(
      parseCodexUsageResponse(
        {
          rate_limit: { primary_window: { ...weekly, reset_at: undefined } },
        },
        NOW,
      ),
    ).toBeNull();
    expect(parseCodexUsageResponse({ rate_limit: null }, NOW)).toBeNull();
  });

  it("returns safe unavailability for authorization, rate limit, malformed body and network failures", async () => {
    for (const response of [
      new Response("", { status: 401 }),
      new Response("not json"),
      new Response(JSON.stringify({ rate_limit: null })),
    ]) {
      expect(
        await fetchCodexOAuthUsage("fake-token", "fake-account", {
          fetch: vi.fn(async () => response),
        }),
      ).toEqual({ kind: "failed" });
    }
    expect(
      await fetchCodexOAuthUsage("fake-token", "fake-account", {
        fetch: vi.fn(async () => new Response("", { status: 429 })),
      }),
    ).toEqual({ kind: "rate_limited" });
    expect(
      await fetchCodexOAuthUsage("fake-token", "fake-account", {
        fetch: vi.fn(async () => {
          throw new Error("Synthetic offline failure");
        }),
      }),
    ).toEqual({ kind: "failed" });
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
    const second = {
      ...row,
      provider: "other-provider",
      model: "latest-model",
      runId: "run-2",
      parentRunId: "run-2",
      costUsd: null,
    };
    const rows = [row, second, { ...row, runId: null }];
    expect(summarizeThreadUsage(rows, second, () => 10_000)).toEqual({
      lastModel: { provider: "other-provider", model: "latest-model" },
      contextTokens: 1000,
      contextWindow: 10_000,
      contextPct: 10,
      cachePctToday: 80,
      tokensToday: 3150,
      runsToday: 2,
      apiEquivalentCostUsdToday: 0.02,
    });
    expect(summarizeThreadUsage([], null, () => null)).toEqual({
      lastModel: null,
      contextTokens: null,
      contextWindow: null,
      contextPct: null,
      cachePctToday: null,
      tokensToday: 0,
      runsToday: 0,
      apiEquivalentCostUsdToday: null,
    });
    expect(summarizeThreadUsage(rows, null, () => 10_000)).toMatchObject({
      lastModel: null,
      contextTokens: null,
      contextWindow: null,
      cachePctToday: 80,
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
