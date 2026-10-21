import { describe, expect, it } from "vitest";
import {
  isAgedStuckWork,
  isStuckWorkStatus,
  STUCK_WORK_EXPIRE_AFTER_MS,
  STUCK_WORK_NOTIFY_AFTER_MS,
  stuckWorkAction,
  stuckWorkAgeMs,
  stuckWorkExpireAfterMs,
  stuckWorkNotifyAfterMs,
  stuckWorkReminder,
  stuckWorkStatusMessage,
  stuckWorkStatusMessages,
  stuckWorkStoppedNotification,
} from "./stuck-work.js";

describe("stuck work age", () => {
  it("never expires a run waiting on a card, but still reminds once", () => {
    const old = { ageMs: STUCK_WORK_EXPIRE_AFTER_MS * 10, waitsOnCard: true };
    expect(stuckWorkAction({ ...old, alreadyNotified: false })).toBe("notify");
    expect(stuckWorkAction({ ...old, alreadyNotified: true })).toBe("none");
  });

  it("does not count time the global pause held the run", () => {
    const hour = 60 * 60 * 1000;
    const now = new Date("2026-10-22T12:00:00Z");
    const at = new Date(now.getTime() - 30 * hour);
    const pauses = [
      { from: new Date(now.getTime() - 40 * hour), to: new Date(now.getTime() - 20 * hour) },
      { from: new Date(now.getTime() - 2 * hour), to: null },
    ];
    // 30 h since the run moved, 10 h + 2 h of them paused.
    expect(stuckWorkAgeMs(at, now, pauses)).toBe(18 * hour);
    expect(stuckWorkAgeMs(at, now)).toBe(30 * hour);
  });

  it("keeps the reminder well before the cancellation", () => {
    expect(STUCK_WORK_EXPIRE_AFTER_MS).toBeGreaterThan(STUCK_WORK_NOTIFY_AFTER_MS);
  });

  it("stays quiet until the reminder, then cancels at the longer limit", () => {
    expect(stuckWorkAction({ ageMs: STUCK_WORK_NOTIFY_AFTER_MS - 1, alreadyNotified: false })).toBe(
      "none",
    );
    expect(stuckWorkAction({ ageMs: STUCK_WORK_NOTIFY_AFTER_MS, alreadyNotified: false })).toBe(
      "notify",
    );
    expect(stuckWorkAction({ ageMs: STUCK_WORK_NOTIFY_AFTER_MS, alreadyNotified: true })).toBe(
      "none",
    );
    expect(stuckWorkAction({ ageMs: STUCK_WORK_EXPIRE_AFTER_MS, alreadyNotified: true })).toBe(
      "expire",
    );
  });

  it("reads RAKAZO_STUCK_NOTIFY_HOURS and RAKAZO_STUCK_EXPIRE_HOURS", () => {
    const hour = 60 * 60 * 1000;
    const env = { RAKAZO_STUCK_NOTIFY_HOURS: "1", RAKAZO_STUCK_EXPIRE_HOURS: "2.5" };
    expect(stuckWorkNotifyAfterMs(env)).toBe(hour);
    expect(stuckWorkExpireAfterMs(env)).toBe(2.5 * hour);
    expect(stuckWorkAction({ ageMs: hour, alreadyNotified: false }, env)).toBe("notify");
    expect(stuckWorkAction({ ageMs: 2.5 * hour, alreadyNotified: true }, env)).toBe("expire");
  });

  it.each([undefined, "", " ", "abc", "0", "-3", "Infinity"])(
    "keeps the constants when the hours are %j",
    (value) => {
      const env = { RAKAZO_STUCK_NOTIFY_HOURS: value, RAKAZO_STUCK_EXPIRE_HOURS: value };
      expect(stuckWorkNotifyAfterMs(env)).toBe(STUCK_WORK_NOTIFY_AFTER_MS);
      expect(stuckWorkExpireAfterMs(env)).toBe(STUCK_WORK_EXPIRE_AFTER_MS);
    },
  );

  it("treats only queued and human waits as stuck", () => {
    expect(isStuckWorkStatus("queued")).toBe(true);
    expect(isStuckWorkStatus("waiting_takeover")).toBe(true);
    expect(isStuckWorkStatus("running")).toBe(false);
    expect(isAgedStuckWork("queued", new Date(Date.now() - STUCK_WORK_NOTIFY_AFTER_MS))).toBe(true);
    expect(isAgedStuckWork("running", new Date(0))).toBe(false);
    expect(isAgedStuckWork("queued", "not-a-date")).toBe(false);
  });

  it("uses a distinct status line and a matching stopped notice", () => {
    const messages = STUCK_WORK_STATUSES_FOR_TEST();
    expect(new Set(messages).size).toBe(messages.length);
    expect(stuckWorkStatusMessage("waiting_takeover")).toMatch(/screen/);
    expect(stuckWorkStoppedNotification("waiting_input", "  ")).toEqual({
      kind: "failure",
      title: "Bot stopped",
      body: stuckWorkStatusMessage("waiting_input"),
    });
    expect(stuckWorkReminder("waiting_takeover", "Ada")).toMatchObject({
      kind: "takeover",
      title: "Ada still needs you",
    });
    expect(stuckWorkReminder("queued", "Ada").kind).toBe("help");
  });
});

function STUCK_WORK_STATUSES_FOR_TEST(): string[] {
  return [...stuckWorkStatusMessages()];
}
