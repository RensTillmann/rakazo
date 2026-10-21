import { invalidatePendingApprovalEffect } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { claimApprovedEffect, resolveDuplicateEffectGate } from "./approval-effect.js";

describe("approval invalidation", () => {
  function storeWithStatus(initial: string) {
    let status = initial;
    let result: unknown;
    const store = {
      externalEffect: {
        updateMany: vi.fn(
          async ({
            where,
            data,
          }: {
            where: { id: string; status: string | { in: string[] } };
            data: { status: string; result?: unknown };
          }) => {
            const matches =
              typeof where.status === "string"
                ? status === where.status
                : where.status.in.includes(status);
            if (where.id !== "effect-1" || !matches) return { count: 0 };
            status = data.status;
            if (data.result !== undefined) result = data.result;
            return { count: 1 };
          },
        ),
      },
    };
    return { store, current: () => ({ status, result }) };
  }

  it.each(["intended", "approved"])(
    "invalidates %s without recording a human denial",
    async (initial) => {
      const { store, current } = storeWithStatus(initial);
      await expect(invalidatePendingApprovalEffect(store, "effect-1", "source-1")).resolves.toBe(
        true,
      );
      expect(current()).toEqual({
        status: "invalidated",
        result: {
          error:
            "This approval no longer applies because its source question is no longer pending.",
          invalidated: true,
          reason: "source_question_unavailable",
          sourceMessageId: "source-1",
        },
      });
      expect(resolveDuplicateEffectGate(current(), "destination.write")).toEqual({
        action: "return",
        result: current().result,
      });
      await expect(claimApprovedEffect(store, "effect-1")).resolves.toBe(false);
      await expect(invalidatePendingApprovalEffect(store, "effect-1", "source-1")).resolves.toBe(
        false,
      );
    },
  );

  it.each(["denied", "completed", "executing", "uncertain", "invalidated"])(
    "preserves %s history instead of rewriting it",
    async (initial) => {
      const { store, current } = storeWithStatus(initial);
      await expect(invalidatePendingApprovalEffect(store, "effect-1", "source-1")).resolves.toBe(
        false,
      );
      expect(current()).toEqual({ status: initial, result: undefined });
    },
  );

  it("does not cancel a different effect", async () => {
    const { store, current } = storeWithStatus("approved");
    await expect(invalidatePendingApprovalEffect(store, "other-effect", "source-1")).resolves.toBe(
      false,
    );
    expect(current().status).toBe("approved");
  });

  it("returns a fail-closed result for an invalidated legacy row without an audit result", () => {
    expect(resolveDuplicateEffectGate({ status: "invalidated" }, "destination.write")).toEqual({
      action: "return",
      result: {
        error:
          "This approval no longer applies. Request a new decision only if it is still needed.",
        invalidated: true,
      },
    });
  });

  it("invalidation winning the claim prevents execution", async () => {
    const { store, current } = storeWithStatus("approved");
    const [invalidated, claimed] = await Promise.all([
      invalidatePendingApprovalEffect(store, "effect-1", "source-1"),
      claimApprovedEffect(store, "effect-1"),
    ]);
    expect([invalidated, claimed]).toEqual([true, false]);
    expect(current().status).toBe("invalidated");
  });

  it("a claim already won is not relabelled as an unexecuted invalidation", async () => {
    const { store, current } = storeWithStatus("approved");
    const [claimed, invalidated] = await Promise.all([
      claimApprovedEffect(store, "effect-1"),
      invalidatePendingApprovalEffect(store, "effect-1", "source-1"),
    ]);
    expect([claimed, invalidated]).toEqual([true, false]);
    expect(current().status).toBe("executing");
  });
});
