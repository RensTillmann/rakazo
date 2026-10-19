import { describe, expect, it, vi } from "vitest";
import {
  compactRosterStatusLabel,
  groupRosterStatus,
  rosterHasUndismissedRunError,
  rosterNeedsAnswer,
  rosterNeedsAnswerLabel,
  rosterWorkStatusLabel,
} from "./roster-status";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
}));

describe("rosterHasUndismissedRunError", () => {
  it("shows a failure only until its run ID is dismissed", () => {
    expect(rosterHasUndismissedRunError("run-failed", new Set())).toBe(true);
    expect(rosterHasUndismissedRunError("run-failed", new Set(["run-failed"]))).toBe(false);
    expect(rosterHasUndismissedRunError(null, new Set())).toBe(false);
  });
});

describe("rosterWorkStatusLabel", () => {
  it("names queued, leased, and running work for the sidebar", () => {
    expect(rosterWorkStatusLabel("queued")).toBe("Waiting in line…");
    expect(rosterWorkStatusLabel("leased")).toBe("Starting…");
    expect(rosterWorkStatusLabel("running")).toBe("Working…");
  });

  it("leaves other statuses to the message preview", () => {
    expect(rosterWorkStatusLabel("idle")).toBeNull();
    expect(rosterWorkStatusLabel("waiting_input")).toBeNull();
    expect(rosterWorkStatusLabel("waiting_takeover")).toBeNull();
    expect(rosterWorkStatusLabel("completed")).toBeNull();
    expect(rosterWorkStatusLabel("failed")).toBeNull();
    expect(rosterWorkStatusLabel("cancelled")).toBeNull();
    expect(rosterWorkStatusLabel("")).toBeNull();
  });
});

describe("compactRosterStatusLabel", () => {
  it("keeps work, human-wait, and error states visible without a preview", () => {
    expect(compactRosterStatusLabel("queued")).toBe("Waiting in line…");
    expect(compactRosterStatusLabel("leased")).toBe("Starting…");
    expect(compactRosterStatusLabel("running")).toBe("Working…");
    expect(compactRosterStatusLabel("waiting_input")).toBe("Needs your answer");
    expect(compactRosterStatusLabel("waiting_takeover")).toBe("Needs your answer");
    expect(compactRosterStatusLabel("failed")).toBe("Error");
  });

  it("does not add status text to idle rows", () => {
    expect(compactRosterStatusLabel("idle")).toBeNull();
  });
});

describe("rosterNeedsAnswer", () => {
  it("flags only runs that wait for the user, never working runs", () => {
    expect(rosterNeedsAnswer("waiting_input")).toBe(true);
    expect(rosterNeedsAnswer("waiting_takeover")).toBe(true);
    for (const status of ["queued", "leased", "running", "idle", "completed", "failed"]) {
      expect(rosterNeedsAnswer(status)).toBe(false);
    }
    expect(rosterNeedsAnswerLabel("waiting_input")).toBe("Needs your answer");
    expect(rosterNeedsAnswerLabel("running")).toBeNull();
  });
});

describe("groupRosterStatus", () => {
  it("prefers a member waiting for the user over a working member", () => {
    expect(groupRosterStatus([{ status: "running" }, { status: "waiting_input" }])).toBe(
      "waiting_input",
    );
  });

  it("shows work when a member runs and idle otherwise", () => {
    expect(groupRosterStatus([{ status: "idle" }, { status: "running" }])).toBe("running");
    expect(groupRosterStatus([{ status: "completed" }, {}])).toBe("idle");
    expect(groupRosterStatus([])).toBe("idle");
  });
});
