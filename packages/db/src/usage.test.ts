import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./generated/prisma/client.js";
import {
  latestSubscriptionLimitReading,
  listFleetUsageBars,
  recordSubscriptionLimitReading,
  recordUsage,
} from "./usage.js";

describe("usage ledger", () => {
  it("retains charged usage arriving after its run was deleted", async () => {
    const createMany = vi
      .fn()
      .mockRejectedValueOnce({ code: "P2003" })
      .mockResolvedValueOnce({ count: 1 });
    const prisma = { usageRecord: { createMany } } as unknown as Pick<PrismaClient, "usageRecord">;
    await recordUsage(
      prisma,
      {
        type: "usage",
        provider: "fixture",
        model: "test",
        callId: "late-call",
        inputTokens: 10,
        outputTokens: 2,
      },
      { spaceId: "space-fixture", userId: "user-fixture", runId: "deleted-run" },
    );
    expect(createMany).toHaveBeenCalledTimes(2);
    expect(createMany.mock.calls[1]?.[0]).toMatchObject({
      data: [expect.objectContaining({ runId: null, parentRunId: "deleted-run", inputTokens: 10 })],
    });
  });
  it("persists every reported bucket and durable operation attribution idempotently", async () => {
    const createMany = vi.fn(async () => ({ count: 1 }));
    const create = vi.fn();
    const prisma = { usageRecord: { createMany, create } } as unknown as Pick<
      PrismaClient,
      "usageRecord"
    >;
    const event = {
      type: "usage" as const,
      provider: "fixture",
      model: "test",
      callId: "call-fixture",
      inputTokens: 60,
      outputTokens: 30,
      cacheReadTokens: 40,
      cacheWriteTokens: 0,
      reasoningTokens: 10,
      totalTokens: 130,
      costUsd: 0.001,
      costSource: "fixture",
      pricingVersion: "v1",
      operationKind: "subagent" as const,
      agentId: "agent-fixture",
    };
    await recordUsage(prisma, event, {
      spaceId: "space-fixture",
      userId: "user-fixture",
      botId: "bot-fixture",
      parentRunId: "run-fixture",
      operationId: "operation-fixture",
    });
    expect(createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          callId: event.callId,
          inputTokens: 60,
          outputTokens: 30,
          cacheReadTokens: 40,
          reasoningTokens: 10,
          operationKind: "subagent",
          agentId: "agent-fixture",
          parentRunId: "run-fixture",
          cacheWriteTokens: 0,
        }),
      ],
      skipDuplicates: true,
    });
    expect(create).not.toHaveBeenCalled();
  });
  it("keeps unknown usage null and never invents a foreground run for background work", async () => {
    const create = vi.fn(async (args) => args.data);
    const prisma = { usageRecord: { create } } as unknown as Pick<PrismaClient, "usageRecord">;
    await recordUsage(
      prisma,
      { type: "usage", provider: "fixture", model: "test", inputTokens: null, outputTokens: null },
      {
        spaceId: "space-fixture",
        userId: "user-fixture",
        operationKind: "compaction",
        operationId: "job-fixture",
      },
    );
    const data = create.mock.calls[0]?.[0].data;
    expect(data).toMatchObject({
      operationKind: "compaction",
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      costUsd: null,
    });
    expect(data).not.toHaveProperty("runId");
  });
});

describe("subscription limit readings", () => {
  const reading = {
    provider: "anthropic",
    fiveHourUtil: 0.42,
    fiveHourResetAt: new Date("2026-10-19T12:00:00Z"),
    sevenDayUtil: null,
    sevenDayResetAt: null,
    status: "allowed",
    observedAt: new Date("2026-10-19T10:00:00Z"),
  };
  it("appends each reading and reads the newest per provider", async () => {
    const create = vi.fn(async () => ({}));
    const findFirst = vi.fn(async () => ({ id: "reading-fixture", ...reading }));
    const prisma = { subscriptionLimitReading: { create, findFirst } } as unknown as Pick<
      PrismaClient,
      "subscriptionLimitReading"
    >;
    await recordSubscriptionLimitReading(prisma, reading);
    expect(create).toHaveBeenCalledWith({ data: reading });
    await expect(latestSubscriptionLimitReading(prisma, "anthropic")).resolves.toEqual(reading);
    expect(findFirst).toHaveBeenCalledWith({
      where: { provider: "anthropic" },
      orderBy: { observedAt: "desc" },
    });
  });

  it("lists fleet usage bars and treats a missing table as none", async () => {
    const updated = new Date("2026-10-19T09:00:00Z");
    const hindsight = { label: "Hindsight · this month", detail: "$4.10 of $20" };
    const ok = {
      $queryRawUnsafe: vi.fn(async () => [
        { name: "hindsight", used_pct: "20.5", ...hindsight, updated_at: updated },
        { name: "other", used_pct: null, label: null, detail: null, updated_at: null },
      ]),
    } as unknown as Pick<PrismaClient, "$queryRawUnsafe">;
    await expect(listFleetUsageBars(ok)).resolves.toEqual([
      { name: "hindsight", usedPct: 20.5, ...hindsight, updatedAt: updated },
      { name: "other", usedPct: null, label: null, detail: null, updatedAt: null },
    ]);
    const missing = {
      $queryRawUnsafe: vi.fn(async () => {
        throw new Error('relation "fleet.usage_bars" does not exist');
      }),
    } as unknown as Pick<PrismaClient, "$queryRawUnsafe">;
    await expect(listFleetUsageBars(missing)).resolves.toEqual([]);
  });
});
