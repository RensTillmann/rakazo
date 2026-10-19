import { describe, expect, it, vi } from "vitest";
import { activityNotificationsEnabled, activityPromptSnippet, loadRunActivity } from "./runs.js";

describe("run activity copy", () => {
  it("presents structured agent messages instead of their internal wake prompt", () => {
    expect(
      activityPromptSnippet({
        trigger: "bot_message",
        prompt: "[bot] A message just arrived from another bot with internal routing data",
        sourceBlocks: [
          {
            kind: "bot_message_received",
            fromBotId: "maya",
            fromBotName: "Maya",
            text: "Please check the release workflow.",
            intent: "request",
          },
        ],
      }),
    ).toBe("Maya asked: Please check the release workflow.");
  });

  it("fails closed when an agent message has no valid structured source", () => {
    expect(
      activityPromptSnippet({
        trigger: "bot_message",
        prompt: "[bot] private internal routing envelope",
        sourceBlocks: [{ kind: "text", text: "not a peer message" }],
      }),
    ).toBe("Message from another agent");
  });
});

describe("run activity notification preference", () => {
  it("follows the bot outside rooms and the room's switch inside one", () => {
    expect(activityNotificationsEnabled(null, null, false)).toBe(false);
    expect(activityNotificationsEnabled(null, null, true)).toBe(true);
    expect(activityNotificationsEnabled("group-1", false, true)).toBe(false);
    expect(activityNotificationsEnabled("group-1", true, false)).toBe(true);
    expect(activityNotificationsEnabled("group-1", null, true)).toBe(false);
  });
});

describe("run activity events (Live activity window)", () => {
  const actor = { spaceId: "space-1", userId: "user-1" } as never;
  const runRow = {
    id: "run-1",
    botId: "bot-1",
    bot: { name: "Mail bot" },
    status: "completed",
    trigger: "routine",
    task: { prompt: "Check the inbox" },
    sourceMessage: null,
    createdAt: new Date("2026-10-19T08:00:00.000Z"),
    startedAt: new Date("2026-10-19T08:00:01.000Z"),
    completedAt: new Date("2026-10-19T08:03:00.000Z"),
  };
  const event = (seq: number) => ({
    id: `event-${seq}`,
    spaceId: "space-1",
    threadId: "thread-1",
    botId: "bot-1",
    seq,
    type: "agent.tool.called",
    runId: "run-1",
    payload: { name: "GMAIL_FETCH_EMAILS" },
    createdAt: new Date("2026-10-19T08:00:02.000Z"),
  });
  const fakePrisma = (owned: { id: string } | null) => ({
    run: {
      findMany: vi.fn(async () => [runRow]),
      findFirst: vi.fn(async () => owned),
    },
    event: { findMany: vi.fn(async () => [event(4), event(5), event(6)]) },
  });

  it("lists the thread's runs in this space and pages the latest run's events", async () => {
    const prisma = fakePrisma(null);
    const result = await loadRunActivity(prisma as never, actor, "thread-1", { limit: 2 });
    expect(prisma.run.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { threadId: "thread-1", spaceId: "space-1" }, take: 20 }),
    );
    expect(prisma.event.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { threadId: "thread-1", runId: "run-1", seq: { gt: -1 } },
        take: 3,
      }),
    );
    expect(result.runId).toBe("run-1");
    expect(result.runs[0]).toMatchObject({ runId: "run-1", botName: "Mail bot", trigger: "routine" });
    expect(result.events.map((item) => item.seq)).toEqual([4, 5]);
    expect(result.nextAfterSeq).toBe(5);
  });

  it("treats a run from another thread or space as missing", async () => {
    const prisma = fakePrisma(null);
    const result = await loadRunActivity(prisma as never, actor, "thread-1", {
      runId: "foreign-run",
    });
    expect(prisma.run.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "foreign-run", threadId: "thread-1", spaceId: "space-1" },
      }),
    );
    expect(prisma.event.findMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({ runId: null, events: [], nextAfterSeq: null });
  });

  it("returns a picked run of this thread", async () => {
    const prisma = fakePrisma({ id: "run-1" });
    const result = await loadRunActivity(prisma as never, actor, "thread-1", {
      runId: "run-1",
      afterSeq: 3,
    });
    expect(prisma.event.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { threadId: "thread-1", runId: "run-1", seq: { gt: 3 } } }),
    );
    expect(result.events).toHaveLength(3);
    expect(result.nextAfterSeq).toBeNull();
  });
});
