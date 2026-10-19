import type { ThreadMessage } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { routineLogFolds, sidebarBotPreview } from "./routine-log-folds";
import {
  getRoutineOutputShown,
  ROUTINE_OUTPUT_STORAGE_KEY,
  resolveRoutineOutputShown,
  setRoutineOutputShown,
} from "./routine-output-preference";

function message(id: string, extra: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id,
    threadId: "thread-1",
    seq: 0,
    role: "bot",
    blocks: [{ kind: "text", text: id }],
    createdAt: `2026-10-19T08:0${id.length % 10}:00.000Z`,
    ...extra,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("routineLogFolds", () => {
  it("folds a webhook wake and its routine reply into one row", () => {
    const wake = message("wake", { role: "user", inbound: "webhook", routineLog: "Inbox triage" });
    const reply = message("reply", {
      runId: "run-1",
      routineLog: "Inbox triage",
      createdAt: "2026-10-19T08:05:00.000Z",
    });
    const folds = routineLogFolds([wake, reply], false);
    expect(folds.get("wake")).toBe(folds.get("reply"));
    expect(folds.get("reply")).toEqual({
      leaderId: "wake",
      routineName: "Inbox triage",
      createdAt: "2026-10-19T08:05:00.000Z",
    });
  });

  it("leaves messages the server did not mark (asks, message_user, normal replies) unfolded", () => {
    const folds = routineLogFolds(
      [
        message("ask", { runId: "run-1", blocks: [{ kind: "ask", text: "Send it?" }] }),
        message("progress", { runId: "run-1" }),
        message("routine", { runId: "run-1", routineLog: "Tracker" }),
        message("user-reply", { runId: "run-2" }),
      ],
      false,
    );
    expect([...folds.keys()]).toEqual(["routine"]);
  });

  it("keeps separate runs in separate rows", () => {
    const folds = routineLogFolds(
      [
        message("a", { runId: "run-1", routineLog: "Tracker" }),
        message("b", { runId: "run-2", routineLog: "Tracker" }),
      ],
      false,
    );
    expect(folds.get("a")?.leaderId).toBe("a");
    expect(folds.get("b")?.leaderId).toBe("b");
  });

  it("folds nothing once the owner turns on Show routine output", () => {
    const messages = [message("routine", { runId: "run-1", routineLog: "Tracker" })];
    expect(routineLogFolds(messages, true).size).toBe(0);
  });
});

describe("routine output preference", () => {
  it("is off unless a saved choice turns it on, and the setting flips it", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    });
    expect(resolveRoutineOutputShown()).toBe(false);
    setRoutineOutputShown(true);
    expect(store.get(ROUTINE_OUTPUT_STORAGE_KEY)).toBe("on");
    expect(getRoutineOutputShown()).toBe(true);
    expect(resolveRoutineOutputShown()).toBe(true);
    setRoutineOutputShown(false);
    expect(getRoutineOutputShown()).toBe(false);
  });
});

describe("sidebarBotPreview", () => {
  const label = (name: string) => `Routine log · ${name}`;

  it("names the routine instead of its text when the newest message is routine output", () => {
    expect(
      sidebarBotPreview(
        { preview: "Tracker: 14 open, 3 stale…", previewRoutineName: "Tracker" },
        false,
        label,
      ),
    ).toBe("Routine log · Tracker");
  });

  it("shows the text for ordinary messages or when routine output is shown", () => {
    expect(sidebarBotPreview({ preview: "Here you go." }, false, label)).toBe("Here you go.");
    expect(
      sidebarBotPreview(
        { preview: "Tracker: 14 open", previewRoutineName: "Tracker" },
        true,
        label,
      ),
    ).toBe("Tracker: 14 open");
  });
});
