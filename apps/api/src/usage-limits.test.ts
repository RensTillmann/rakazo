import { createRouterClient } from "@orpc/server";
import type { SubscriptionUsageRefresher } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { ThreadUsageSchema, UsageLimitsSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "owner@example.test",
  isDeploymentOwner: true,
} satisfies Actor;

type StoredReading = {
  id: string;
  provider: string;
  fiveHourUtil: number | null;
  fiveHourResetAt: Date | null;
  sevenDayUtil: number | null;
  sevenDayResetAt: Date | null;
  status: string | null;
  observedAt: Date;
};

const reading = (observedAt: Date): StoredReading => ({
  id: "reading-1",
  provider: "anthropic",
  fiveHourUtil: 0.42,
  fiveHourResetAt: new Date(Date.now() + 3_600_000),
  sevenDayUtil: 0.9,
  // Already passed: the week bar must read 0% (reset).
  sevenDayResetAt: new Date(Date.now() - 60_000),
  status: "allowed",
  observedAt,
});

function fixture(stored: StoredReading | null) {
  const usageRow = {
    provider: "anthropic",
    model: "claude-fixture",
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 900,
    cacheWriteTokens: 0,
    totalTokens: 1020,
    costUsd: 0.05,
    runId: "run-1",
    parentRunId: "run-1",
    operationKind: "answer",
  };
  const prisma = {
    bot: {
      findFirst: vi.fn(async () => ({
        id: "bot-1",
        name: "Josy",
        userId: actor.userId,
        spaceId: actor.spaceId,
        archivedAt: null,
        thread: { id: "thread-bot-1" },
        computer: null,
      })),
    },
    subscriptionLimitReading: {
      findFirst: vi.fn(async () => stored),
      create: vi.fn(async () => ({})),
    },
    usageRecord: {
      findMany: vi.fn(async () => [usageRow]),
      findFirst: vi.fn(async () => usageRow),
    },
    $queryRawUnsafe: vi.fn(async () => [
      {
        name: "hindsight",
        used_pct: "20.5",
        label: "Hindsight · this month",
        detail: "$4.10 of $20",
        updated_at: new Date("2026-10-19T09:00:00Z"),
      },
    ]),
  };
  const refresh = vi.fn(async () => null);
  const deps = {
    prisma: prisma as unknown as PrismaClient,
    events: { notify: vi.fn() },
    jobs: { enqueue: vi.fn() },
    secrets: { load: vi.fn(), put: vi.fn() },
    subscriptionUsage: { refresh } as unknown as SubscriptionUsageRefresher,
    env: {
      webOrigin: "https://rakazo.example.test",
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      defaultProvider: "fake",
      defaultModel: "fake",
      screenProxySecret: "secret",
    },
  } as unknown as RouterDeps;
  const client = createRouterClient(createRouter(deps), { context: { actor } });
  return { client, prisma, refresh };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("usage.limits", () => {
  it("is off without RAKAZO_SUBSCRIPTION_LIMITS", async () => {
    const { client, prisma } = fixture(reading(new Date()));
    await expect(client.usage.limits()).resolves.toEqual({
      enabled: false,
      claude: null,
      extra: [],
    });
    expect(prisma.subscriptionLimitReading.findFirst).not.toHaveBeenCalled();
  });

  it("returns the latest reading with its age, zeroes a passed window and adds fleet bars", async () => {
    vi.stubEnv("RAKAZO_SUBSCRIPTION_LIMITS", "true");
    const { client, refresh } = fixture(reading(new Date(Date.now() - 60_000)));
    const result = UsageLimitsSchema.parse(await client.usage.limits());
    expect(refresh).not.toHaveBeenCalled();
    expect(result.claude?.fiveHour).toMatchObject({ usedPct: 42, reset: false });
    expect(result.claude?.sevenDay).toMatchObject({ usedPct: 0, reset: true });
    expect(result.claude?.ageSeconds).toBeGreaterThanOrEqual(59);
    expect(result.extra).toEqual([
      {
        name: "hindsight",
        usedPct: 20.5,
        label: "Hindsight · this month",
        detail: "$4.10 of $20",
        updatedAt: "2026-10-19T09:00:00.000Z",
        tone: null,
      },
    ]);
  });

  it("refreshes a stale reading through the OAuth endpoint and stores it", async () => {
    vi.stubEnv("RAKAZO_SUBSCRIPTION_LIMITS", "true");
    const { client, prisma, refresh } = fixture(reading(new Date(Date.now() - 11 * 60_000)));
    const fresh = { ...reading(new Date()), fiveHourUtil: 0.5 };
    refresh.mockResolvedValueOnce(fresh as never);
    const result = await client.usage.limits();
    expect(refresh).toHaveBeenCalledWith(actor.userId, expect.any(Function));
    expect(prisma.subscriptionLimitReading.create).toHaveBeenCalledOnce();
    expect(result.claude?.fiveHour.usedPct).toBe(50);
  });

  it("returns no Claude bars when there is no reading and no refresh", async () => {
    vi.stubEnv("RAKAZO_SUBSCRIPTION_LIMITS", "true");
    const { client } = fixture(null);
    expect((await client.usage.limits()).claude).toBeNull();
  });
});

describe("usage.thread", () => {
  it("reads this chat's usage today and sizes the context from the latest call", async () => {
    const { client, prisma } = fixture(null);
    const dayStart = "2026-10-18T22:00:00.000Z";
    const result = ThreadUsageSchema.parse(await client.usage.thread({ botId: "bot-1", dayStart }));
    expect(result).toMatchObject({
      contextTokens: 1000,
      cachePctToday: 90,
      tokensToday: 1020,
      runsToday: 1,
      apiEquivalentCostUsdToday: 0.05,
    });
    expect(prisma.usageRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          run: { thread: { botId: "bot-1" } },
          createdAt: { gte: new Date(dayStart) },
        },
      }),
    );
  });

  it("rejects a target with both a bot and a group", async () => {
    const { client } = fixture(null);
    await expect(client.usage.thread({ botId: "bot-1", groupId: "group-1" })).rejects.toThrow();
  });
});
