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
      "Please type it here",
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

  const fixes =
    "Case 311 · reply: what should change?\n- Explain the 1 Oct bulk update\n- Restore the 23 licences";
  const concrete = ["Explain the bulk update", "Restore the licences"];

  it.each(["Type it here", "type your answer", "What should change"])(
    "refuses a question saying %j unless the text lists concrete fixes",
    (phrase) => {
      const bare = caseCardOptionsRefusal(`Case 311 · reply: ${phrase}?`, concrete, false);
      expect(bare).toMatch(REFUSED);
      expect(bare).toContain(`The question says "${phrase}"`);
      expect(bare).toContain("which it does not");
      expect(
        caseCardOptionsRefusal(`Case 311 · reply: ${phrase}?\n1. Fix A\n2. Fix B`, concrete, false),
      ).toBeNull();
    },
  );

  it("refuses an open question with listed fixes but a free-text option, naming both", () => {
    const refusal = caseCardOptionsRefusal(fixes, ["Send as is", "Type it here"], false);
    expect(refusal).toMatch(REFUSED);
    expect(refusal).toContain('"Type it here" only invites typing');
    expect(refusal).toContain('The question says "what should change"');
    expect(refusal).not.toContain("which it does not");
  });

  it("asks an open question whose text lists two fixes with concrete options", () => {
    expect(caseCardOptionsRefusal(fixes, concrete, false)).toBeNull();
    expect(
      caseCardOptionsRefusal(
        "Case 311 · reply: what should change?\n- only one fix",
        concrete,
        false,
      ),
    ).toMatch(REFUSED);
  });

  it("leaves to-do cards and ordinary questions alone", () => {
    expect(
      caseCardOptionsRefusal("Case 383 · access: grant it?", ["I'll do it myself"], true),
    ).toBeNull();
    expect(caseCardOptionsRefusal("Which city should I use?", ["Type it here"], false)).toBeNull();
  });
});
