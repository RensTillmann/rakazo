import { describe, expect, it } from "vitest";
import { CASE_CARD_HEAD, caseCardOptionsRefusal } from "./events.js";

const REFUSED = /^ask_user refused \(rule D6, case decision cards\): /;

describe("case decision cards (D6)", () => {
  it.each([
    ["Case 311 · reply: which fix?", true],
    ["case 311 · lower case head", true],
    ["URGENT · Case 311 · send now?", true],
    ["urgent · case 7 · ...", true],
    ["Case 311: no middle dot", false],
    ["Room for case 311 · later", false],
    ["Which city should I use?", false],
  ])("recognises the card head of %j → %s", (question, isCase) => {
    expect(CASE_CARD_HEAD.test(question)).toBe(isCase);
  });

  it("refuses a case card with no options or one option, naming the rule", () => {
    expect(caseCardOptionsRefusal("Case 311 · what should change?", [], false)).toMatch(REFUSED);
    expect(caseCardOptionsRefusal("Case 311 · what should change?", [], false)).toContain(
      "none were given",
    );
    const one = caseCardOptionsRefusal("URGENT · Case 311 · send it?", ["Send"], false);
    expect(one).toMatch(REFUSED);
    expect(one).toContain("1 was given");
  });

  it("does not count an option that only invites typing", () => {
    for (const filler of [
      "Type it here",
      "Other",
      "Something else",
      "Let me explain",
      "I'll describe it",
      "Tell you in chat",
      "Specify…",
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

  it("accepts two concrete options, including ones that merely contain such a verb", () => {
    expect(
      caseCardOptionsRefusal(
        "Case 311 · reply: which fix?",
        [
          "Explain the 1 Oct bulk update and restore the licences",
          "Ask the customer for the invoice",
        ],
        false,
      ),
    ).toBeNull();
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
