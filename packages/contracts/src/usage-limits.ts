import * as z from "zod";

/** One subscription window. `usedPct` is 0..100; a window whose reset has passed reads 0. */
export const SubscriptionWindowSchema = z.object({
  usedPct: z.number().nullable(),
  resetsAt: z.iso.datetime().nullable(),
  /** True when `resetsAt` already passed and `usedPct` was zeroed for that reason. */
  reset: z.boolean(),
});
export type SubscriptionWindow = z.infer<typeof SubscriptionWindowSchema>;

/** A row of `fleet.usage_bars`, written by the fleet service. */
export const ExtraUsageBarSchema = z.object({
  name: z.string(),
  usedPct: z.number().nullable(),
  label: z.string().nullable(),
  detail: z.string().nullable(),
  updatedAt: z.iso.datetime().nullable(),
  /** The colour of a bar that is not a percentage (`usedPct` null): a count, a health state. */
  tone: z.enum(["ok", "warn", "high"]).nullable().optional(),
});
export type ExtraUsageBar = z.infer<typeof ExtraUsageBarSchema>;

/** Fleet `usage.limits` (RAKAZO_SUBSCRIPTION_LIMITS); `enabled: false` hides the bar. */
export const UsageLimitsSchema = z.object({
  enabled: z.boolean(),
  claude: z
    .object({
      fiveHour: SubscriptionWindowSchema,
      sevenDay: SubscriptionWindowSchema,
      status: z.string().nullable(),
      observedAt: z.iso.datetime(),
      ageSeconds: z.number(),
    })
    .nullable(),
  extra: z.array(ExtraUsageBarSchema),
});
export type UsageLimits = z.infer<typeof UsageLimitsSchema>;

/** Fleet `usage.thread`: the grey line under a chat header. Cost is an API-price equivalent. */
export const ThreadUsageSchema = z.object({
  contextTokens: z.number().nullable(),
  contextWindow: z.number().nullable(),
  contextPct: z.number().nullable(),
  cachePctToday: z.number().nullable(),
  tokensToday: z.number(),
  runsToday: z.number(),
  apiEquivalentCostUsdToday: z.number().nullable(),
});
export type ThreadUsage = z.infer<typeof ThreadUsageSchema>;
