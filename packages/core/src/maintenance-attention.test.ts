import { describe, expect, it } from "vitest";
import {
  isWaitingIssue,
  MAINTENANCE_ATTENTION_SENTENCES,
  maintenanceAttentionSentence,
  maintenanceIssueCode,
} from "./maintenance-attention.js";

describe("maintenance attention sentences", () => {
  it("says what a timed-out Fleet check means and that it is retried", () => {
    expect(maintenanceAttentionSentence("fleet-authority-verifier-unavailable")).toMatch(
      /did not answer in time; it is retried automatically/,
    );
    expect(maintenanceAttentionSentence("fleet-authority-binding-invalid")).toMatch(
      /waits for you/,
    );
  });

  it("gives every known code a sentence and unknown codes a generic one", () => {
    for (const sentence of Object.values(MAINTENANCE_ATTENTION_SENTENCES)) {
      expect(sentence.length).toBeGreaterThan(10);
    }
    expect(maintenanceAttentionSentence("fleet-new-thing-unavailable")).toMatch(
      /could not be checked/,
    );
    expect(maintenanceAttentionSentence("something-new")).toMatch(/look at this/);
  });

  it("treats a run waiting on the user's card answer as waiting, not attention", () => {
    const code = "fleet-current-card-wait-case-412";
    expect(maintenanceAttentionSentence(code)).toBe("waiting on your answer to this case's card");
    expect(isWaitingIssue(`continuation:run-1:maintenance:attention:${code}`)).toBe(true);
    expect(
      isWaitingIssue("continuation:run-1:maintenance:attention:fleet-authority-binding-invalid"),
    ).toBe(false);
    expect(isWaitingIssue("uncertain-effects")).toBe(false);
  });

  it("says what changed for a run held because its authority changed", () => {
    expect(maintenanceAttentionSentence("authority-changed-computer-instructions")).toBe(
      "its computer, its bot's instructions changed while it was held; it is checked again hourly, or stop it",
    );
  });

  it("splits a held run's issue from status-wide codes", () => {
    expect(
      maintenanceIssueCode(
        "continuation:run-1:maintenance:attention:fleet-authority-verifier-unavailable",
      ),
    ).toEqual({ runId: "run-1", code: "fleet-authority-verifier-unavailable" });
    expect(maintenanceIssueCode("uncertain-effects")).toEqual({
      runId: null,
      code: "uncertain-effects",
    });
  });
});
