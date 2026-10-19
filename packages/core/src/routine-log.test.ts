import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { isRoutineLogRun, routineLogName } from "./routine-log.js";

const text = (value: string): MessageBlock[] => [{ kind: "text", text: value }];

describe("isRoutineLogRun", () => {
  it("covers routine runs and webhook wakes of a routine, nothing the owner started", () => {
    expect(isRoutineLogRun({ trigger: "routine", routineId: "r-1" })).toBe(true);
    expect(isRoutineLogRun({ trigger: "webhook", routineId: "r-1" })).toBe(true);
    expect(isRoutineLogRun({ trigger: "webhook", routineId: null })).toBe(false);
    expect(isRoutineLogRun({ trigger: "user", routineId: "r-1" })).toBe(false);
  });
});

describe("routineLogName", () => {
  it("folds a routine run's final plain reply under the routine", () => {
    expect(
      routineLogName(
        { role: "bot", blocks: text("Run budget: 3 of 20 runs used."), clientNonce: null },
        "Tracker status",
      ),
    ).toBe("Tracker status");
  });

  it("never folds an ask card from a routine run", () => {
    expect(
      routineLogName(
        { role: "bot", blocks: [...text("Before I go on:"), { kind: "ask", text: "Send it?" }] },
        "Tracker status",
      ),
    ).toBeUndefined();
  });

  it("never folds what the bot sent the owner through message_user", () => {
    expect(
      routineLogName(
        {
          role: "bot",
          blocks: text("Rens, the invoice bounced."),
          clientNonce: "user-progress:run-1:0:abc:def",
        },
        "Tracker status",
      ),
    ).toBeUndefined();
  });

  it("never folds a reply to a message the owner wrote", () => {
    expect(
      routineLogName(
        { role: "bot", blocks: text("Done."), replyToMessageId: "message-owner" },
        "Tracker status",
      ),
    ).toBeUndefined();
  });

  it("leaves a normal user-triggered reply unchanged", () => {
    expect(routineLogName({ role: "bot", blocks: text("Here you go.") }, undefined)).toBeUndefined();
    expect(routineLogName({ role: "user", blocks: text('Run routine "X":') }, undefined)).toBe(
      undefined,
    );
  });

  it("folds a webhook wake under the routines its header names", () => {
    expect(
      routineLogName(
        {
          role: "user",
          inbound: "webhook",
          blocks: text('Run routine "Inbox triage":\n@triage\n\nInbound webhook payload:\n{}'),
        },
        undefined,
      ),
    ).toBe("Inbox triage");
    expect(
      routineLogName({ role: "user", inbound: "github", blocks: text("[GitHub Event: push]") }, undefined),
    ).toBeUndefined();
  });
});
