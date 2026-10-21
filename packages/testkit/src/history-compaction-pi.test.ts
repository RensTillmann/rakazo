import { PiAgentRuntime } from "@rakazo/adapters";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compactHistory } from "../../adapters/src/history-compaction.js";
import { startModelEmulator } from "./model-emulator.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("history compaction with real Pi", () => {
  it.each(["", "   "])("preserves history and retries an empty summary (%j)", async (text) => {
    const summary = "Earlier decisions and the new conversation facts.";
    const server = await startModelEmulator({
      steps: [text, summary].map((response, index) => ({
        expect(request) {
          expect(JSON.stringify(request.messages)).toContain("Earlier decisions.");
          expect(JSON.stringify(request.messages)).toContain("New conversation facts.");
        },
        response: { type: "text", text: response },
        usage: {
          prompt_tokens: 100 + index,
          completion_tokens: 10,
          total_tokens: 110 + index,
          prompt_tokens_details: { cached_tokens: 20 },
        },
      })),
    });
    cleanups.push(() => server.close());
    const thread = {
      id: "fixture-thread",
      botId: "fixture-bot",
      spaceId: "fixture-space",
      userId: "fixture-user",
      nextMessageSeq: 51,
      historyCompactedUpToSeq: 49,
      historyCompactionGeneration: 0,
      historyCompactionSummary: "Earlier decisions.",
    };
    const updateMany = vi.fn(
      async (args: {
        data: { historyCompactedUpToSeq: number; historyCompactionSummary: string };
      }) => {
        Object.assign(thread, args.data);
        return { count: 1 };
      },
    );
    const createMany = vi.fn(async (_args: Prisma.UsageRecordCreateManyArgs) => ({ count: 1 }));
    const create = vi.fn();
    const effects: Array<Record<string, unknown>> = [];
    const prisma = {
      $queryRaw: vi.fn(async () => [{ active: false, revision: 0 }]),
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
      run: {
        findFirst: vi.fn(async () => ({ id: "fixture-run" })),
        findUnique: vi.fn(async () => ({ maintenanceCancelRequestedAt: null })),
      },
      bot: { findFirst: vi.fn(async () => ({ id: thread.botId })) },
      spaceMember: { findUnique: vi.fn(async () => ({ id: "fixture-member" })) },
      externalEffect: {
        upsert: vi.fn(async ({ where, create }: {
          where: { idempotencyKey: string }; create: Record<string, unknown>;
        }) => {
          const existing = effects.find((effect) => effect.idempotencyKey === where.idempotencyKey);
          if (existing) return { ...existing };
          const effect = { id: `effect-${effects.length}`, result: null, ...create };
          effects.push(effect);
          return { ...effect };
        }),
        findMany: vi.fn(async ({ where }: { where: { kind: string; status: string } }) =>
          effects.filter((effect) => effect.kind === where.kind && effect.status === where.status)
            .map((effect) => ({ ...effect }))),
        updateMany: vi.fn(async ({ where, data }: {
          where: { id: string; status: string | { in: string[] } };
          data: Record<string, unknown>;
        }) => {
          const selected = effects.filter((effect) =>
            effect.id === where.id && (typeof where.status === "string"
              ? effect.status === where.status : where.status.in.includes(String(effect.status))));
          for (const effect of selected) Object.assign(effect, data);
          return { count: selected.length };
        }),
      },
      thread: { findUniqueOrThrow: vi.fn(async () => thread), updateMany },
      message: {
        findMany: vi.fn(async () => [
          {
            seq: 50,
            role: "user",
            blocks: [{ kind: "text", text: "New conversation facts." }],
          },
        ]),
      },
      usageRecord: { createMany, create },
    };
    const memoryProviders = { resolve: vi.fn(async () => null) };
    const jobs = { enqueue: vi.fn(async () => undefined) };
    const deps = {
      prisma: prisma as unknown as PrismaClient,
      runtime: new PiAgentRuntime(),
      jobs,
      memoryProviders,
      resolveModel: async () => server.model,
    };

    await expect(compactHistory(deps, thread.id)).rejects.toThrow("summarizer returned no summary");
    expect(updateMany).not.toHaveBeenCalled();
    expect(thread.historyCompactedUpToSeq).toBe(49);
    expect(thread.historyCompactionSummary).toBe("Earlier decisions.");
    expect(memoryProviders.resolve).not.toHaveBeenCalled();
    expect(jobs.enqueue).not.toHaveBeenCalled();
    expect(createMany).toHaveBeenCalledOnce();
    expect(effects).toEqual([
      expect.objectContaining({ kind: "history_compaction", status: "intended", runId: "fixture-run" }),
    ]);
    expect(createMany.mock.calls[0]?.[0]).toMatchObject({
      skipDuplicates: true,
      data: [
        {
          spaceId: thread.spaceId,
          userId: thread.userId,
          botId: thread.botId,
          operationKind: "compaction",
          inputTokens: 80,
          outputTokens: 10,
          cacheReadTokens: 20,
          totalTokens: 110,
          callId: expect.any(String),
        },
      ],
    });

    await compactHistory(deps, thread.id);
    server.assertComplete();
    expect(effects).toEqual([
      expect.objectContaining({ kind: "history_compaction", status: "completed" }),
      expect.objectContaining({ kind: "history_compaction_memory", status: "cancelled" }),
    ]);
    expect(updateMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        id: thread.id,
        historyCompactedUpToSeq: 49,
        historyCompactionGeneration: 0,
      },
      data: { historyCompactedUpToSeq: 50, historyCompactionSummary: summary },
    });
    expect(memoryProviders.resolve).toHaveBeenCalledOnce();
    expect(jobs.enqueue).not.toHaveBeenCalled();
    expect(createMany).toHaveBeenCalledTimes(2);
    expect(createMany.mock.calls[1]?.[0]).toMatchObject({
      skipDuplicates: true,
      data: [
        {
          operationKind: "compaction",
          inputTokens: 81,
          outputTokens: 10,
          cacheReadTokens: 20,
          totalTokens: 111,
          callId: expect.any(String),
        },
      ],
    });
    expect(create).not.toHaveBeenCalled();
  });
});
