import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { answerRunInput, withdrawQuestionInTransaction } from "./events.js";

// Exercises the production lifecycle transaction, with an in-memory persistence
// boundary. This is not PostgreSQL concurrency or UI coverage.
function fixture() {
  const source: { id: string; threadId: string; runId: string; blocks: MessageBlock[] } = {
    id: "source",
    threadId: "thread",
    runId: "source-run",
    blocks: [
      {
        kind: "ask",
        text: "Choose a route",
        status: "pending",
        actions: [{ id: "a", label: "A" }],
      },
    ],
  };
  const effects = [
    { id: "pending", sourceMessageId: "source", spaceId: "space", status: "intended" },
    { id: "approved", sourceMessageId: "source", spaceId: "space", status: "approved" },
    { id: "denied", sourceMessageId: "source", spaceId: "space", status: "denied" },
    { id: "done", sourceMessageId: "source", spaceId: "space", status: "completed" },
    { id: "running", sourceMessageId: "source", spaceId: "space", status: "executing" },
    { id: "uncertain", sourceMessageId: "source", spaceId: "space", status: "uncertain" },
    { id: "other-question", sourceMessageId: "other", spaceId: "space", status: "intended" },
    { id: "other-space", sourceMessageId: "source", spaceId: "other", status: "intended" },
    { id: "legacy-unbound", sourceMessageId: null, spaceId: "space", status: "intended" },
  ].map((effect) => ({ ...effect, result: undefined as unknown }));
  let runStatus = "waiting_input";
  const tx = {
    $queryRaw: vi.fn(async () => []),
    message: {
      findFirst: vi.fn(async () => source),
      findMany: vi.fn(async () => []),
      update: vi.fn(async ({ data }: { data: { blocks: MessageBlock[] } }) => {
        source.blocks = data.blocks;
        return source;
      }),
    },
    run: {
      findFirst: vi.fn(async () => ({
        id: "source-run",
        taskId: "task",
        botId: "bot",
        userId: "owner",
        status: runStatus,
      })),
      findUnique: vi.fn(async () => ({ status: runStatus })),
      updateMany: vi.fn(async ({ data }: { data: { status: string } }) => {
        runStatus = data.status;
        return { count: 1 };
      }),
    },
    task: { updateMany: vi.fn(async () => ({ count: 1 })) },
    attempt: { updateMany: vi.fn(async () => ({ count: 0 })) },
    externalEffect: {
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { spaceId: string; sourceMessageId: string; status: { in: string[] } };
          data: { status: string; result: unknown };
        }) => {
          let count = 0;
          for (const effect of effects) {
            if (
              effect.spaceId === where.spaceId &&
              effect.sourceMessageId === where.sourceMessageId &&
              where.status.in.includes(effect.status)
            ) {
              Object.assign(effect, data);
              count++;
            }
          }
          return { count };
        },
      ),
    },
    thread: { update: vi.fn(async () => ({ nextEventSeq: 1 })) },
    event: {
      create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => data),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
  };
  const prisma = { $transaction: async (work: (tx: unknown) => unknown) => work(tx) };
  return { tx, prisma, source, effects };
}
const input = {
  spaceId: "space",
  threadId: "thread",
  runId: "source-run",
  messageId: "source",
  answeredByUserId: "owner",
  answer: "a",
};

for (const transition of ["answer", "withdraw"] as const) {
  describe(`dependent approval on source ${transition}`, () => {
    async function act(f: ReturnType<typeof fixture>) {
      if (transition === "answer") return answerRunInput(f.prisma as never, input);
      return withdrawQuestionInTransaction(
        f.tx as never,
        { spaceId: "space", userId: "owner" },
        { botId: "bot", messageId: "source", reason: "No longer needed" },
      );
    }
    it("invalidates intended and approved dependencies in the source transaction without inventing an answer", async () => {
      const f = fixture();
      await act(f);
      for (const id of ["pending", "approved"]) {
        expect(f.effects.find((e) => e.id === id)).toMatchObject({
          status: "invalidated",
          result: {
            invalidated: true,
            reason: "source_question_unavailable",
            sourceMessageId: "source",
          },
        });
      }
      const result = f.effects[0]!.result as Record<string, unknown>;
      expect(result).not.toHaveProperty("answer");
      expect(result).not.toHaveProperty("answeredBy");
      if (transition === "withdraw")
        expect(f.source.blocks[0]).toMatchObject({ status: "pending" });
      else expect(f.source.blocks[0]).toMatchObject({ status: "answered", answer: "a" });
    });
    it("preserves denied/completed/executing/uncertain history and unrelated requests", async () => {
      const f = fixture();
      const before = structuredClone(f.effects.slice(2));
      await act(f);
      expect(f.effects.slice(2)).toEqual(before);
      expect(f.tx.externalEffect.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            spaceId: "space",
            sourceMessageId: "source",
            status: { in: ["intended", "approved"] },
          },
        }),
      );
    });
    it("does not invalidate dependencies when the source transition is refused", async () => {
      const f = fixture();
      f.source.blocks = [{ kind: "ask", text: "Choose a route", status: "answered", answer: "a" }];
      const before = structuredClone(f.effects);
      if (transition === "answer") await expect(act(f)).resolves.toBe(false);
      else await expect(act(f)).rejects.toThrow("Only an unanswered ordinary question");
      expect(f.effects).toEqual(before);
      expect(f.tx.externalEffect.updateMany).not.toHaveBeenCalled();
    });
    it("rolls failure up to the enclosing transaction instead of accepting a partial source transition", async () => {
      const f = fixture();
      f.tx.externalEffect.updateMany.mockRejectedValueOnce(new Error("storage unavailable"));
      await expect(act(f)).rejects.toThrow("storage unavailable");
    });
  });
}
