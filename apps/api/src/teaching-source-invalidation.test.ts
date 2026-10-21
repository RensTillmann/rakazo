import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { createTaughtSkillsService } from "./taught-skills.js";

function fixture(won = true) {
  const tx = {
    run: {
      updateManyAndReturn: vi.fn().mockResolvedValue(won ? [{ id: "source-run" }] : []),
    },
    message: {
      findMany: vi.fn().mockResolvedValue([{ id: "question", thread: { spaceId: "space" } }]),
    },
    externalEffect: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    event: { deleteMany: vi.fn() },
  };
  const prisma = {
    bot: { findFirst: vi.fn().mockResolvedValue({ id: "bot", computer: { kind: "desktop" } }) },
    taughtSkill: { findFirst: vi.fn().mockResolvedValue(null) },
    run: {
      findMany: vi.fn().mockResolvedValue([{ id: "source-run" }]),
      updateMany: vi.fn(),
    },
    event: { deleteMany: vi.fn() },
    computer: { updateMany: vi.fn() },
    computerExecutionLease: { updateMany: vi.fn() },
    $transaction: vi.fn(async (callback: (store: typeof tx) => unknown) => callback(tx)),
  };
  const start = () =>
    createTaughtSkillsService({ prisma } as never).start(
      { spaceId: "space", userId: "user" } as Actor,
      "bot",
      "Practice navigation",
    );
  return { tx, prisma, start };
}

describe("teaching takeover source dependencies", () => {
  it("invalidates won cancellations transactionally before progress cleanup or lease changes", async () => {
    const { tx, prisma, start } = fixture();
    await expect(start()).rejects.toThrow("Teaching needs a graphical sandbox computer");
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(tx.run.updateManyAndReturn).toHaveBeenCalledWith({
      where: { botId: "bot", spaceId: "space", userId: "user", status: { in: expect.any(Array) } },
      data: { status: "cancelled", completedAt: expect.any(Date) },
      select: { id: true },
    });
    expect(tx.message.findMany).toHaveBeenCalledWith({
      where: { runId: { in: ["source-run"] } },
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
    expect(tx.externalEffect.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      tx.event.deleteMany.mock.invocationCallOrder[0]!,
    );
    expect(tx.event.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.computerExecutionLease.updateMany.mock.invocationCallOrder[0]!,
    );
    expect(prisma.run.findMany).not.toHaveBeenCalled();
    expect(prisma.run.updateMany).not.toHaveBeenCalled();
    expect(prisma.event.deleteMany).not.toHaveBeenCalled();
  });

  it("does not touch source dependencies or progress when no active run wins cancellation", async () => {
    const { tx, start } = fixture(false);
    await expect(start()).rejects.toThrow("Teaching needs a graphical sandbox computer");
    expect(tx.message.findMany).not.toHaveBeenCalled();
    expect(tx.externalEffect.updateMany).not.toHaveBeenCalled();
    expect(tx.event.deleteMany).not.toHaveBeenCalled();
  });

  it("propagates invalidation failure before progress cleanup or computer changes", async () => {
    const { tx, prisma, start } = fixture();
    tx.externalEffect.updateMany.mockRejectedValue(new Error("storage unavailable"));
    await expect(start()).rejects.toThrow("storage unavailable");
    expect(tx.event.deleteMany).not.toHaveBeenCalled();
    expect(prisma.computerExecutionLease.updateMany).not.toHaveBeenCalled();
    expect(prisma.computer.updateMany).not.toHaveBeenCalled();
  });
});
