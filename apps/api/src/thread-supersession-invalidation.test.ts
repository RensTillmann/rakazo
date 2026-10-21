import { describe, expect, it, vi } from "vitest";
import { cancelSupersededQueuedRuns } from "./thread-target.js";

const input = { threadId: "thread", botIds: ["bot"], keepRunIds: ["keep"] };
function fixture(won = true) {
  const tx = {
    run: {
      findMany: vi.fn().mockResolvedValue([{ id: "old", taskId: "old-task" }]),
      updateMany: vi.fn().mockResolvedValue({ count: won ? 1 : 0 }),
      updateManyAndReturn: vi
        .fn()
        .mockResolvedValue(won ? [{ id: "old", taskId: "old-task" }] : []),
    },
    message: {
      findMany: vi.fn().mockResolvedValue([{ id: "question", thread: { spaceId: "space" } }]),
    },
    externalEffect: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    task: { updateMany: vi.fn() },
  };
  return { tx, cancel: () => cancelSupersededQueuedRuns(tx as never, input) };
}

describe("queued supersession source dependencies", () => {
  it("invalidates only the sources actually cancelled, before task cleanup", async () => {
    const { tx, cancel } = fixture();
    await cancel();
    expect(tx.message.findMany).toHaveBeenCalledWith({
      where: { runId: { in: ["old"] } },
      select: { id: true, thread: { select: { spaceId: true } } },
      orderBy: { id: "asc" },
    });
    expect(tx.externalEffect.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          spaceId: "space",
          sourceMessageId: "question",
          status: { in: ["intended", "approved"] },
        },
        data: expect.objectContaining({ status: "invalidated" }),
      }),
    );
    expect(tx.run.updateManyAndReturn.mock.invocationCallOrder[0]).toBeLessThan(
      tx.message.findMany.mock.invocationCallOrder[0]!,
    );
    expect(tx.externalEffect.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      tx.task.updateMany.mock.invocationCallOrder[0]!,
    );
  });

  it("rechecks exact eligibility in the cancellation statement rather than trusting an earlier read", async () => {
    const { tx, cancel } = fixture();
    await cancel();
    expect(tx.run.findMany).not.toHaveBeenCalled();
    expect(tx.run.updateManyAndReturn).toHaveBeenCalledWith({
      where: {
        threadId: "thread",
        botId: { in: ["bot"] },
        status: "queued",
        OR: [{ trigger: "user", sourceMessage: { role: "user" } }, { trigger: "reaction" }],
        id: { notIn: ["keep"] },
      },
      data: { status: "cancelled", completedAt: expect.any(Date) },
      select: { id: true, taskId: true },
    });
  });

  it("does not invalidate or cancel tasks when the queued status fence loses", async () => {
    const { tx, cancel } = fixture(false);
    await cancel();
    expect(tx.message.findMany).not.toHaveBeenCalled();
    expect(tx.externalEffect.updateMany).not.toHaveBeenCalled();
    expect(tx.task.updateMany).not.toHaveBeenCalled();
  });

  it("propagates invalidation failure before task cleanup in the owning transaction", async () => {
    const { tx, cancel } = fixture();
    tx.externalEffect.updateMany.mockRejectedValue(new Error("storage unavailable"));
    await expect(cancel()).rejects.toThrow("storage unavailable");
    expect(tx.task.updateMany).not.toHaveBeenCalled();
  });
});
