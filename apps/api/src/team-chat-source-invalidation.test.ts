import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { TeamChatBridge } from "./team-chat-bridge.js";

function fixture(won = true) {
  let woken = false;
  const tx = {
    run: {
      updateManyAndReturn: vi
        .fn()
        .mockResolvedValue(won ? [{ id: "source-run", taskId: "task" }] : []),
    },
    message: {
      findMany: vi.fn().mockResolvedValue([{ id: "question", thread: { spaceId: "space" } }]),
    },
    externalEffect: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    task: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
  const prisma = {
    message: {
      findUnique: vi.fn(async () => (woken ? { id: "wake" } : null)),
      findMany: vi.fn().mockResolvedValue([]),
    },
    run: { updateMany: vi.fn(), findUnique: vi.fn() },
    task: { updateMany: vi.fn() },
    externalMessage: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi
        .fn()
        .mockResolvedValue({ status: "queueing", engagementReason: "message_teamchat_agent" }),
    },
    $transaction: vi.fn(async (callback: (store: typeof tx) => unknown) => callback(tx)),
  };
  const enqueue = vi.fn();
  const bridge = new TeamChatBridge({
    prisma: prisma as unknown as PrismaClient,
    events: {
      sendUserMessage: vi.fn(async () => {
        woken = true;
        return { messageId: "message", runId: "source-run", taskId: "task", seq: 1 };
      }),
    },
    jobs: { enqueue },
    send: vi.fn(),
    providerId: "slack",
    botId: "bot",
  });
  const queue = () =>
    (bridge as unknown as { queue(message: unknown): Promise<void> }).queue({
      id: "external",
      providerEventId: "event",
      senderId: "sender",
      senderName: "Sender",
      content: "Continue",
      batchContext: null,
      engagementReason: null,
      externalConversation: {
        spaceId: "space",
        userId: "user",
        botId: "bot",
        thread: { id: "thread" },
      },
    });
  return { tx, prisma, enqueue, queue };
}

describe("team chat fallback source dependencies", () => {
  it("invalidates only won scoped cancellations in the same transaction before task cleanup", async () => {
    const { tx, prisma, enqueue, queue } = fixture();
    await queue();
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(tx.run.updateManyAndReturn).toHaveBeenCalledWith({
      where: {
        id: "source-run",
        spaceId: "space",
        userId: "user",
        botId: "bot",
        threadId: "thread",
        status: { in: expect.any(Array) },
      },
      data: {
        status: "cancelled",
        completedAt: expect.any(Date),
        leaseOwner: null,
        leaseExpiresAt: null,
      },
      select: { id: true, taskId: true },
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
      tx.task.updateMany.mock.invocationCallOrder[0]!,
    );
    expect(tx.task.updateMany).toHaveBeenCalledWith({
      where: { id: "task" },
      data: { status: "cancelled" },
    });
    expect(prisma.run.updateMany).not.toHaveBeenCalled();
    expect(prisma.task.updateMany).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does not cancel tasks or invalidate dependencies after losing cancellation", async () => {
    const { tx, prisma, enqueue, queue } = fixture(false);
    await queue();
    expect(tx.message.findMany).not.toHaveBeenCalled();
    expect(tx.externalEffect.updateMany).not.toHaveBeenCalled();
    expect(tx.task.updateMany).not.toHaveBeenCalled();
    expect(prisma.task.updateMany).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("propagates invalidation failure before task cleanup or abandoning the external reservation", async () => {
    const { tx, prisma, enqueue, queue } = fixture();
    tx.externalEffect.updateMany.mockRejectedValue(new Error("storage unavailable"));
    await expect(queue()).rejects.toThrow("storage unavailable");
    expect(tx.task.updateMany).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(prisma.externalMessage.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "ignored" }),
      }),
    );
  });
});
