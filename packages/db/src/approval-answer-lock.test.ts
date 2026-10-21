import { describe, expect, it, vi } from "vitest";
import { answerRunInput } from "./events.js";

// Production answer seam with a deterministic persistence interleaving, not a
// PostgreSQL lock/race test. The effect lock must precede the status read.
function fixture(action: string) {
  let status = "intended";
  const order: string[] = [];
  const tx = {
    $queryRaw: vi.fn(async (sql: TemplateStringsArray, ...values: unknown[]) => {
      if (sql.join("?").includes("external_effects")) {
        order.push("effect-lock");
        expect(values).toEqual(["effect", "space"]);
        // The competing source-ending transaction committed while we waited.
        status = "invalidated";
      } else order.push("thread-lock");
      return [];
    }),
    run: {
      findFirst: vi.fn(async () => ({ botId: "bot", userId: "owner" })),
      updateMany: vi.fn(async () => ({ count: 1 })),
      findUnique: vi.fn(async () => ({ status: "queued" })),
    },
    message: {
      findFirst: vi.fn(async () => ({
        id: "approval-message",
        blocks: [
          {
            kind: "ask",
            text: "Review withdrawal",
            status: "pending",
            approvalEffectId: "effect",
            actions: [
              { id: "allow", label: "Allow once" },
              { id: "always", label: "Always allow" },
              { id: "deny", label: "Deny" },
            ],
          },
        ],
      })),
      update: vi.fn(),
    },
    externalEffect: {
      findFirst: vi.fn(async () => {
        order.push("effect-read");
        return status === "intended" ? { id: "effect", kind: "mcp", request: {} } : null;
      }),
      update: vi.fn(),
    },
    actionApprovalRule: { upsert: vi.fn() },
    thread: { update: vi.fn(async () => ({ nextEventSeq: 1 })) },
    event: { create: vi.fn(async ({ data }: { data: unknown }) => data) },
  };
  const prisma = { $transaction: async (work: (tx: unknown) => unknown) => work(tx) };
  return {
    tx,
    order,
    act: () =>
      answerRunInput(prisma as never, {
        spaceId: "space",
        threadId: "approval-thread",
        runId: "approval-run",
        messageId: "approval-message",
        answeredByUserId: "owner",
        answer: action,
      }),
  };
}

describe("approval answers serialize with source invalidation", () => {
  for (const action of ["allow", "always", "deny"]) {
    it(`rejects stale ${action} after the competing invalidation wins the row`, async () => {
      const f = fixture(action);
      await expect(f.act()).resolves.toBe(false);
      expect(f.order).toEqual(["thread-lock", "effect-lock", "effect-read"]);
      expect(f.tx.run.updateMany).not.toHaveBeenCalled();
      expect(f.tx.externalEffect.update).not.toHaveBeenCalled();
      expect(f.tx.message.update).not.toHaveBeenCalled();
      expect(f.tx.actionApprovalRule.upsert).not.toHaveBeenCalled();
    });
  }
  it("propagates an effect-lock failure without queueing or recording an answer", async () => {
    const f = fixture("allow");
    f.tx.$queryRaw.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("lock unavailable"));
    await expect(f.act()).rejects.toThrow("lock unavailable");
    expect(f.tx.externalEffect.findFirst).not.toHaveBeenCalled();
    expect(f.tx.run.updateMany).not.toHaveBeenCalled();
    expect(f.tx.message.update).not.toHaveBeenCalled();
  });
});
