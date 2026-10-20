import { describe, expect, it } from "vitest";
import {
  ExtraUsageBarSummarySchema,
  SubscriptionAccountUsageSchema,
  ThreadUsageSchema,
  UsageLimitsSchema,
} from "./usage-limits.js";

describe("usage status availability", () => {
  it("distinguishes unavailable counts from a known zero", () => {
    expect(
      ExtraUsageBarSummarySchema.parse({ waitingCount: 0, unaskedCount: null, partial: true }),
    ).toEqual({ waitingCount: 0, unaskedCount: null, partial: true });
    expect(ExtraUsageBarSummarySchema.parse({ partial: true })).toEqual({ partial: true });
  });

  it.each([-1, 0.5, Infinity, NaN, "3"])("rejects invalid structured counts: %s", (count) => {
    for (const key of ["waitingCount", "unaskedCount", "pausedRoutineCount", "issueCount"]) {
      expect(ExtraUsageBarSummarySchema.safeParse({ [key]: count }).success).toBe(false);
    }
  });

  it("accepts thread usage without model metadata during staggered deployment", () => {
    const usage = {
      contextTokens: null,
      contextWindow: null,
      contextPct: null,
      cachePctToday: null,
      tokensToday: 0,
      runsToday: 0,
      apiEquivalentCostUsdToday: null,
    };
    expect(ThreadUsageSchema.safeParse(usage).success).toBe(true);
    expect(ThreadUsageSchema.parse({ ...usage, lastModel: null }).lastModel).toBeNull();
    expect(
      ThreadUsageSchema.parse({ ...usage, lastModel: { provider: "provider", model: "model" } })
        .lastModel,
    ).toEqual({ provider: "provider", model: "model" });
  });
});

describe("connected subscription accounts", () => {
  const unknownWindow = { usedPct: null, resetsAt: null, reset: false };
  const account = {
    provider: "openai-codex",
    label: "OpenAI Codex",
    fiveHour: unknownWindow,
    sevenDay: { usedPct: 0, resetsAt: "2026-10-27T00:00:00Z", reset: false },
    status: null,
    observedAt: "2026-10-20T00:00:00Z",
    ageSeconds: 0,
  };

  it("distinguishes absent accounts, unavailable windows and measured zero", () => {
    const limits = UsageLimitsSchema.parse({ enabled: true, accounts: [account], extra: [] });
    expect(limits.accounts[0]?.fiveHour.usedPct).toBeNull();
    expect(limits.accounts[0]?.sevenDay.usedPct).toBe(0);
    expect(UsageLimitsSchema.parse({ enabled: true, accounts: [], extra: [] }).accounts).toEqual(
      [],
    );
  });

  it.each([-1, 100.1, NaN, Infinity])("rejects out-of-range measured allowance %s", (usedPct) => {
    expect(
      SubscriptionAccountUsageSchema.safeParse({
        ...account,
        sevenDay: { ...account.sevenDay, usedPct },
      }).success,
    ).toBe(false);
  });
});
