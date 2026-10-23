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
    const none = caseCardOptionsRefusal("Case 311 · what should change?", [], false);
    expect(none).toMatch(REFUSED);
    expect(none).toContain("none were given");
    for (const question of ["URGENT · Case 311 · send it?", "Case 311: send it?"]) {
      const one = caseCardOptionsRefusal(question, ["Send"], false);
      expect(one).toMatch(REFUSED);
      expect(one).toContain("only one was given");
    }
  });

  it("accepts two options whatever their labels, and never reads the wording", () => {
    for (const options of [
      [
        "Explain the 1 Oct bulk update and restore the licences",
        "Ask the customer for the invoice",
      ],
      ["Send as is", "Type it here"],
      ["Other", "Something else"],
    ]) {
      expect(
        caseCardOptionsRefusal(
          "Case 311 · reply: what should change? Type it here.",
          options,
          false,
        ),
      ).toBeNull();
    }
  });

  it("leaves to-do cards and ordinary questions alone", () => {
    expect(
      caseCardOptionsRefusal("Case 383 · access: grant it?", ["I'll do it myself"], true),
    ).toBeNull();
    expect(caseCardOptionsRefusal("Which city should I use?", ["Type it here"], false)).toBeNull();
  });
});
