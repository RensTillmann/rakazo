import { describe, expect, it, vi } from "vitest";
import { cancelRunsInTransaction } from "./cancel-runs.js";

function fixture() {
  const order: string[] = [];
  const effects = [
    { id: "pending", sourceMessageId: "question", spaceId: "space", status: "intended" },
    { id: "approved", sourceMessageId: "question", spaceId: "space", status: "approved" },
    ...["denied", "executing", "completed", "uncertain"].map((status) => ({
      id: status,
      sourceMessageId: "question",
      spaceId: "space",
      status,
    })),
    { id: "other-source", sourceMessageId: "other", spaceId: "space", status: "intended" },
    { id: "other-space", sourceMessageId: "question", spaceId: "other", status: "intended" },
    { id: "unbound", sourceMessageId: null, spaceId: "space", status: "intended" },
  ];
  const cancel = vi.fn(async () => {
    order.push("cancel");
    return { count: 1 };
  });
  const sources = vi.fn(async () => {
    order.push("sources");
    return [{ id: "question", thread: { spaceId: "space" } }];
  });
  const invalidate = vi.fn(async ({ where, data }) => {
    order.push("invalidate");
    let count = 0;
    for (const effect of effects) {
      if (
        effect.sourceMessageId === where.sourceMessageId &&
        effect.spaceId === where.spaceId &&
        where.status.in.includes(effect.status)
      ) {
        effect.status = data.status;
        count++;
      }
    }
    return { count };
  });
  const attempts = vi.fn(async () => {
    order.push("attempts");
    return { count: 1 };
  });
  const tasks = vi.fn(async () => {
    order.push("tasks");
    return { count: 1 };
  });
  const tx = {
    run: { updateMany: cancel },
    message: { findMany: sources },
    externalEffect: { updateMany: invalidate },
    attempt: { updateMany: attempts },
    task: { updateMany: tasks },
  };
  return {
    tx: tx as unknown as Parameters<typeof cancelRunsInTransaction>[0],
    order,
    effects,
    cancel,
    sources,
    invalidate,
    attempts,
    tasks,
  };
}
const runs = [{ id: "source-run", taskId: "source-task" }];
const now = new Date("2026-01-01T00:00:00Z");

describe("source-bound approvals at the shared cancellation seam", () => {
  it("invalidates pending dependencies after the source-run cancellation lock", async () => {
    const f = fixture();
    await cancelRunsInTransaction(f.tx, runs, now);
    // Cancellation never settles a running attempt: only its worker's drain may (Q35).
    expect(f.order).toEqual(["cancel", "sources", "invalidate", "tasks"]);
    expect(f.attempts).not.toHaveBeenCalled();
    expect(f.effects.slice(0, 2).map((e) => e.status)).toEqual(["invalidated", "invalidated"]);
    expect(f.invalidate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          result: expect.objectContaining({
            invalidated: true,
            reason: "source_question_unavailable",
            sourceMessageId: "question",
          }),
        }),
      }),
    );
  });
  it("selects only messages attached to the authorized cancelled runs", async () => {
    const f = fixture();
    await cancelRunsInTransaction(f.tx, runs, now);
    expect(f.sources).toHaveBeenCalledWith({
      where: { runId: { in: ["source-run"] } },
      select: { id: true, thread: { select: { spaceId: true } } },
      orderBy: { id: "asc" },
    });
  });
  it("preserves terminal history, unrelated sources/spaces and legacy unbound effects", async () => {
    const f = fixture();
    const before = f.effects.slice(2).map((e) => ({ ...e }));
    await cancelRunsInTransaction(f.tx, runs, now);
    expect(f.effects.slice(2)).toEqual(before);
  });
  it("does not read or change anything for an empty cancellation", async () => {
    const f = fixture();
    await cancelRunsInTransaction(f.tx, [], now);
    expect(f.order).toEqual([]);
  });
  it("handles a cancelled run with no source messages", async () => {
    const f = fixture();
    f.sources.mockResolvedValue([]);
    await cancelRunsInTransaction(f.tx, runs, now);
    expect(f.invalidate).not.toHaveBeenCalled();
    expect(f.tasks).toHaveBeenCalled();
  });
  it("propagates invalidation failure to the owning transaction", async () => {
    const f = fixture();
    f.invalidate.mockRejectedValue(new Error("storage failure"));
    await expect(cancelRunsInTransaction(f.tx, runs, now)).rejects.toThrow("storage failure");
    expect(f.attempts).not.toHaveBeenCalled();
    expect(f.tasks).not.toHaveBeenCalled();
  });
  it("does not invalidate when source cancellation fails", async () => {
    const f = fixture();
    f.cancel.mockRejectedValue(new Error("cancel failed"));
    await expect(cancelRunsInTransaction(f.tx, runs, now)).rejects.toThrow("cancel failed");
    expect(f.sources).not.toHaveBeenCalled();
    expect(f.invalidate).not.toHaveBeenCalled();
  });
});
