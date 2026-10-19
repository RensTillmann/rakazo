import type { PendingDecision } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  decisionDockEvent,
  newDecisionIds,
  orderDecisions,
  pendingDecisionSignature,
  stableDecisionIndex,
  stepDecisionIndex,
} from "./decision-queue";

function decision(messageId: string, threadId: string, createdAt: string): PendingDecision {
  return {
    messageId,
    runId: `run-${messageId}`,
    botId: `bot-${threadId}`,
    botName: threadId,
    groupId: null,
    threadId,
    createdAt,
    block: { kind: "ask", text: "Send it?", status: "pending" },
  };
}

const josyOld = decision("josy-old", "t-josy", "2026-10-20T08:00:00.000Z");
const lily = decision("lily", "t-lily", "2026-10-20T09:00:00.000Z");
const josyNew = decision("josy-new", "t-josy", "2026-10-20T10:00:00.000Z");
const elena = decision("elena", "t-elena", "2026-10-20T07:00:00.000Z");

describe("orderDecisions", () => {
  it("puts the open chat's cards first, then everything else oldest first", () => {
    const ordered = orderDecisions([josyNew, lily, elena, josyOld], "t-josy");
    expect(ordered.map((item) => item.messageId)).toEqual([
      "josy-old",
      "josy-new",
      "elena",
      "lily",
    ]);
  });

  it("is plain oldest first without an open chat or when the open chat has no card", () => {
    expect(orderDecisions([lily, elena], null).map((item) => item.messageId)).toEqual([
      "elena",
      "lily",
    ]);
    expect(orderDecisions([lily, elena], "t-other").map((item) => item.messageId)).toEqual([
      "elena",
      "lily",
    ]);
  });
});

describe("stableDecisionIndex", () => {
  it("keeps the shown card when a new card arrives before it", () => {
    const next = orderDecisions([elena, lily, josyOld], "t-josy");
    // The user looked at lily (index 1 of [elena, lily]); a Josy card now sorts first.
    expect(stableDecisionIndex(next, "lily", 1)).toBe(2);
  });

  it("stays at the same position when the shown card was answered elsewhere", () => {
    expect(stableDecisionIndex([elena, josyNew], "lily", 1)).toBe(1);
  });

  it("clamps to the last card when the answered card was last", () => {
    expect(stableDecisionIndex([elena], "lily", 1)).toBe(0);
    expect(stableDecisionIndex([elena, lily], null, 7)).toBe(1);
  });

  it("is zero for an empty queue", () => {
    expect(stableDecisionIndex([], "lily", 3)).toBe(0);
  });
});

describe("stepDecisionIndex", () => {
  it("wraps in both directions", () => {
    expect(stepDecisionIndex(2, 1, 3)).toBe(0);
    expect(stepDecisionIndex(0, -1, 3)).toBe(2);
    expect(stepDecisionIndex(1, 1, 3)).toBe(2);
    expect(stepDecisionIndex(0, 1, 0)).toBe(0);
  });
});

describe("newDecisionIds", () => {
  it("names only cards that were not waiting before", () => {
    expect(newDecisionIds([lily], [lily, josyNew])).toEqual(["josy-new"]);
    expect(newDecisionIds([lily, elena], [lily])).toEqual([]);
  });
});

describe("decisionDockEvent", () => {
  it("refetches on card and run changes, not on progress", () => {
    expect(decisionDockEvent({ type: "run.waiting_input" })).toBe(true);
    expect(decisionDockEvent({ type: "thread.message.updated" })).toBe(true);
    expect(decisionDockEvent({ type: "run.cancelled" })).toBe(true);
    expect(decisionDockEvent({ type: "thread.progress" })).toBe(false);
    expect(decisionDockEvent({ type: "heartbeat" })).toBe(false);
  });
});

describe("pendingDecisionSignature", () => {
  it("changes only when a chat's waiting-card count changes", () => {
    const before = pendingDecisionSignature([
      { id: "b", pendingDecisionCount: 1 },
      { id: "a", pendingDecisionCount: 0 },
      { id: "c" },
    ]);
    expect(before).toBe("b:1");
    expect(pendingDecisionSignature([{ id: "c" }, { id: "b", pendingDecisionCount: 1 }])).toBe(
      before,
    );
    expect(pendingDecisionSignature([{ id: "b", pendingDecisionCount: 2 }])).not.toBe(before);
  });
});
