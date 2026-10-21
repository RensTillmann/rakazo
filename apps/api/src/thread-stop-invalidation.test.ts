import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { stopThreadRuns } from "./thread-target.js";

function fixture(won = true) {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    run: {
      updateManyAndReturn: vi
        .fn()
        .mockResolvedValue(won ? [{ id: "source-run", botId: "bot" }] : []),
      findUnique: vi.fn().mockResolvedValue({ status: "cancelled" }),
    },
    message: {
      findMany: vi
        .fn()
        .mockResolvedValue([{ id: "source-question", thread: { spaceId: "space" } }]),
    },
    externalEffect: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    steeringMessage: { deleteMany: vi.fn() },
    computer: { findMany: vi.fn().mockResolvedValue([]) },
    computerExecutionLease: { findMany: vi.fn().mockResolvedValue([]) },
    thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 1 }) },
    event: { create: vi.fn(async ({ data }) => data), deleteMany: vi.fn() },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    computer: { updateMany: vi.fn() },
    computerExecutionLease: { updateMany: vi.fn() },
  };
  const notify = vi.fn().mockResolvedValue(undefined);
  const stop = () =>
    stopThreadRuns(
      { prisma, sandbox: {}, events: { notify } } as never,
      { spaceId: "space", userId: "user" } as Actor,
      { kind: "bot", botId: "bot", threadId: "thread" } as never,
    );
  return { tx, prisma, notify, stop };
}

describe("Stop source dependency invalidation", () => {
  it("invalidates only dependencies of runs actually cancelled, before cleanup", async () => {
    const { tx, stop } = fixture();
    await stop();
    expect(tx.message.findMany).toHaveBeenCalledWith({
      where: { runId: { in: ["source-run"] } },
      select: { id: true, thread: { select: { spaceId: true } } },
      orderBy: { id: "asc" },
    });
    expect(tx.externalEffect.updateMany).toHaveBeenCalledWith({
      where: {
        spaceId: "space",
        sourceMessageId: "source-question",
        status: { in: ["intended", "approved"] },
      },
      data: {
        status: "invalidated",
        result: {
          error:
            "This approval no longer applies because its source question is no longer pending.",
          invalidated: true,
          reason: "source_question_unavailable",
          sourceMessageId: "source-question",
        },
      },
    });
    expect(tx.run.updateManyAndReturn.mock.invocationCallOrder[0]).toBeLessThan(
      tx.message.findMany.mock.invocationCallOrder[0]!,
    );
    expect(tx.externalEffect.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      tx.steeringMessage.deleteMany.mock.invocationCallOrder[0]!,
    );
  });

  it("does not touch dependencies when no run wins cancellation", async () => {
    const { tx, stop } = fixture(false);
    await stop();
    expect(tx.message.findMany).not.toHaveBeenCalled();
    expect(tx.externalEffect.updateMany).not.toHaveBeenCalled();
  });

  it("propagates invalidation failure before cleanup or postcommit notification", async () => {
    const { tx, prisma, notify, stop } = fixture();
    tx.externalEffect.updateMany.mockRejectedValue(new Error("storage unavailable"));
    await expect(stop()).rejects.toThrow("storage unavailable");
    expect(tx.steeringMessage.deleteMany).not.toHaveBeenCalled();
    expect(tx.event.create).not.toHaveBeenCalled();
    expect(prisma.computer.updateMany).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});
