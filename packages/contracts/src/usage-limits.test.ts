import { describe, expect, it } from "vitest";
import { ExtraUsageBarSummarySchema, ThreadUsageSchema } from "./usage-limits.js";

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
