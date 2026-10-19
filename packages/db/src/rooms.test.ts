import { afterEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "./client.js";
import { roomRunAllowedInTransaction, wakeGroupMembersInTransaction } from "./rooms.js";

function brakeTx(group: { pausedAt: Date | null; budgetResetAt: Date | null }, started: number) {
  const update = vi.fn(async () => ({}));
  const count = vi.fn(async (_args: { where: { createdAt: { gte: Date } } }) => started);
  const runCreate = vi.fn(async () => ({ id: "run-new" }));
  const tx = {
    chatGroup: { findUnique: vi.fn(async () => group), update },
    run: {
      count,
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      create: runCreate,
    },
    task: { create: vi.fn(async () => ({ id: "task-new" })) },
    steeringMessage: { findFirst: vi.fn(async () => null), create: vi.fn() },
  };
  const client: unknown = tx;
  return { tx: client as Prisma.TransactionClient, update, count, runCreate };
}

const input = { groupId: "group-1", threadId: "thread-1" };
const now = new Date("2026-10-19T12:00:00Z");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("room brake", () => {
  it("allows every run when RAKAZO_ROOM_MAX_RUNS_PER_DAY is unset", async () => {
    const { tx, count } = brakeTx({ pausedAt: null, budgetResetAt: null }, 500);
    await expect(roomRunAllowedInTransaction(tx, input, now)).resolves.toBe(true);
    expect(count).not.toHaveBeenCalled();
  });

  it("pauses the room when the 24 h budget is used up", async () => {
    vi.stubEnv("RAKAZO_ROOM_MAX_RUNS_PER_DAY", "40");
    const under = brakeTx({ pausedAt: null, budgetResetAt: null }, 39);
    await expect(roomRunAllowedInTransaction(under.tx, input, now)).resolves.toBe(true);
    const over = brakeTx({ pausedAt: null, budgetResetAt: null }, 40);
    await expect(roomRunAllowedInTransaction(over.tx, input, now)).resolves.toBe(false);
    expect(over.update).toHaveBeenCalledWith({ where: { id: "group-1" }, data: { pausedAt: now } });
  });

  it("counts from the last resume when it is inside the 24 h window", async () => {
    vi.stubEnv("RAKAZO_ROOM_MAX_RUNS_PER_DAY", "40");
    const resetAt = new Date("2026-10-19T10:00:00Z");
    const { tx, count } = brakeTx({ pausedAt: null, budgetResetAt: resetAt }, 0);
    await roomRunAllowedInTransaction(tx, input, now);
    expect(count.mock.calls[0]?.[0].where.createdAt.gte).toEqual(resetAt);
  });

  it("refuses bot-started runs in a paused room", async () => {
    const { tx, runCreate } = brakeTx({ pausedAt: now, budgetResetAt: null }, 0);
    const wakes = await wakeGroupMembersInTransaction(tx, {
      groupId: "group-1",
      spaceId: "space-1",
      userId: "user-1",
      threadId: "thread-1",
      messageId: "message-1",
      botIds: ["bot-b"],
      prompt: "check",
    });
    expect(wakes).toEqual([{ botId: "bot-b", runId: null, steered: false, paused: true }]);
    expect(runCreate).not.toHaveBeenCalled();
  });
});
