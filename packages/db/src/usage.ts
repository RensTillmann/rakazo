import type {
  AgentRuntimeEvent,
  SubscriptionLimitReading,
  UsageOperationKind,
} from "@rakazo/adapter-kit";
import type { PrismaClient } from "./generated/prisma/client.js";

type UsageEvent = Extract<AgentRuntimeEvent, { type: "usage" }>;
export interface UsageAttribution {
  spaceId: string;
  userId: string;
  botId?: string;
  runId?: string;
  parentRunId?: string;
  operationId?: string;
  operationKind?: UsageOperationKind;
}

/** Usage is financial history, independent from message clearing or bot deletion. */
export async function recordUsage(
  prisma: Pick<PrismaClient, "usageRecord">,
  event: UsageEvent,
  attribution: UsageAttribution,
) {
  const data = {
    ...attribution,
    parentRunId: attribution.parentRunId ?? attribution.runId,
    provider: event.provider,
    model: event.model,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cacheReadTokens: event.cacheReadTokens ?? null,
    cacheWriteTokens: event.cacheWriteTokens ?? null,
    cacheWrite1hTokens: event.cacheWrite1hTokens ?? null,
    reasoningTokens: event.reasoningTokens ?? null,
    totalTokens: event.totalTokens ?? null,
    costUsd: event.costUsd ?? null,
    costSource: event.costSource ?? null,
    pricingVersion: event.pricingVersion ?? null,
    usageSource: event.usageSource ?? null,
    callId: event.callId ?? null,
    operationKind: attribution.operationKind ?? event.operationKind ?? "answer",
    agentId: event.agentId ?? null,
  };
  const insert = (runId: string | null | undefined = data.runId) => {
    if (event.callId) {
      // A database uniqueness constraint makes duplicate delivery harmless even concurrently.
      return prisma.usageRecord.createMany({ data: [{ ...data, runId }], skipDuplicates: true });
    }
    return prisma.usageRecord.create({
      data: { ...data, ...(runId !== undefined ? { runId } : {}) },
    });
  };
  try {
    return await insert();
  } catch (error) {
    // A cancelled/deleted run can disappear while its last model call is settling.
    // Keep durable attribution while allowing the optional lifecycle FK to dangle as null.
    if (
      data.runId &&
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "P2003"
    )
      return insert(null);
    throw error;
  }
}

/** Fleet: append one subscription-window reading; the newest row per provider is current. */
export function recordSubscriptionLimitReading(
  prisma: Pick<PrismaClient, "subscriptionLimitReading">,
  reading: SubscriptionLimitReading,
) {
  return prisma.subscriptionLimitReading.create({
    data: {
      provider: reading.provider,
      fiveHourUtil: reading.fiveHourUtil,
      fiveHourResetAt: reading.fiveHourResetAt,
      sevenDayUtil: reading.sevenDayUtil,
      sevenDayResetAt: reading.sevenDayResetAt,
      status: reading.status,
      observedAt: reading.observedAt,
    },
  });
}

export async function latestSubscriptionLimitReading(
  prisma: Pick<PrismaClient, "subscriptionLimitReading">,
  provider: string,
): Promise<SubscriptionLimitReading | null> {
  const row = await prisma.subscriptionLimitReading.findFirst({
    where: { provider },
    orderBy: { observedAt: "desc" },
  });
  if (!row) return null;
  return {
    provider: row.provider,
    fiveHourUtil: row.fiveHourUtil,
    fiveHourResetAt: row.fiveHourResetAt,
    sevenDayUtil: row.sevenDayUtil,
    sevenDayResetAt: row.sevenDayResetAt,
    status: row.status,
    observedAt: row.observedAt,
  };
}

export interface ExtraUsageBar {
  name: string;
  usedPct: number | null;
  label: string | null;
  detail: string | null;
  updatedAt: Date | null;
}

/**
 * Fleet: every row of `fleet.usage_bars`, written by the fleet service. The schema belongs to
 * another role, so a missing schema or table (or no read grant) simply means no extra bars.
 */
export async function listFleetUsageBars(
  prisma: Pick<PrismaClient, "$queryRawUnsafe">,
): Promise<ExtraUsageBar[]> {
  try {
    const rows = await prisma.$queryRawUnsafe<
      {
        name: string;
        used_pct: unknown;
        label: string | null;
        detail: string | null;
        updated_at: Date | null;
      }[]
    >("SELECT name, used_pct, label, detail, updated_at FROM fleet.usage_bars ORDER BY name");
    return rows.map((row) => {
      const used = row.used_pct === null || row.used_pct === undefined ? NaN : Number(row.used_pct);
      return {
        name: row.name,
        usedPct: Number.isFinite(used) ? used : null,
        label: row.label,
        detail: row.detail,
        updatedAt: row.updated_at,
      };
    });
  } catch {
    return [];
  }
}
