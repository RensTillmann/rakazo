import { describe, expect, it } from "vitest";
import { askCaseRef, caseCardOptionsRefusal } from "./events.js";

const REFUSED = /^ask_user refused \(rule D6, case decision cards\): /;

describe("case card head (one rule for dedupe, recovery and D6)", () => {
  it.each([
    ["Case 78 · alert: Can you export the 403/4xx …", 78],
    ["URGENT · case 78: export?", 78],
    ["Case 311: no middle dot", 311],
    ["case 311 · lower case head", 311],
    ["Case 780 · other", 780],
    ["Export the logs for case 78?", null],
    ["Room for case 311 · later", null],
    ["Which city should I use?", null],
  ])("reads the case of %j → %s", (question, caseRef) => {
    expect(askCaseRef(question)).toBe(caseRef);
  });
});

describe("case decision cards (D6)", () => {
  it("refuses a case card with no options or one option, naming the rule", () => {
    expect(caseCardOptionsRefusal("Case 311 · what should change?", [], false)).toMatch(REFUSED);
    expect(caseCardOptionsRefusal("Case 311 · what should change?", [], false)).toContain(
      "none were given",
    );
    for (const question of ["URGENT · Case 311 · send it?", "Case 311: send it?"]) {
      const one = caseCardOptionsRefusal(question, ["Send"], false);
      expect(one).toMatch(REFUSED);
      expect(one).toContain("1 was given");
    }
  });

  it("does not count an option that only invites typing", () => {
    for (const filler of [
      "Type it here",
      "Type your answer below",
      "Other",
      "Other…",
      "Something else",
      "Something else (describe it)",
      "Let me explain",
      "I'll describe it",
      "None of these",
      "Free text",
    ]) {
      const refusal = caseCardOptionsRefusal(
        "Case 311 · reply change?",
        ["Send as is", filler],
        false,
      );
      expect(refusal).toMatch(REFUSED);
      expect(refusal).toContain(`"${filler}" only invites typing`);
    }
  });

  it("counts short concrete options, including ones with a telling verb", () => {
    for (const second of [
      "Explain the delay",
      "Specify SPF",
      "Tell the customer",
      "Describe the 1 Oct bulk update",
      "Write off the invoice",
      "Others pay",
      "Hold",
    ]) {
      expect(
        caseCardOptionsRefusal("Case 311 · reply: which fix?", ["Send as is", second], false),
      ).toBeNull();
    }
    expect(
      caseCardOptionsRefusal("Case 311 · send?", ["Send as is", "Type it here", "Hold"], false),
    ).toBeNull();
  });

  it("leaves to-do cards and ordinary questions alone", () => {
    expect(
      caseCardOptionsRefusal("Case 383 · access: grant it?", ["I'll do it myself"], true),
    ).toBeNull();
    expect(caseCardOptionsRefusal("Which city should I use?", ["Type it here"], false)).toBeNull();
  });
});
