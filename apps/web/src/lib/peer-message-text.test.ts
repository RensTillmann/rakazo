import { describe, expect, it } from "vitest";
import { withoutRecipientSalutation } from "./peer-message-text.js";

describe("withoutRecipientSalutation", () => {
  it("drops a leading recipient name with a comma and capitalises the rest", () => {
    expect(withoutRecipientSalutation("Lily, hold the docs", "Lily")).toBe("Hold the docs");
    expect(withoutRecipientSalutation("Quinn, QA sub-issue #285 is ready", "Quinn")).toBe(
      "QA sub-issue #285 is ready",
    );
  });

  it("drops a colon form with optional spaces, case-insensitively", () => {
    expect(withoutRecipientSalutation("lily : hold the docs", "Lily")).toBe("Hold the docs");
    expect(withoutRecipientSalutation("LILY:hold", "Lily")).toBe("Hold");
  });

  it("keeps text where the name is not a salutation at the very start", () => {
    expect(withoutRecipientSalutation("Lily hold the docs", "Lily")).toBe("Lily hold the docs");
    expect(withoutRecipientSalutation("Lilyanne, hi", "Lily")).toBe("Lilyanne, hi");
    expect(withoutRecipientSalutation("Thanks Lily, done", "Lily")).toBe("Thanks Lily, done");
    expect(withoutRecipientSalutation("Quinn, hi", "Lily")).toBe("Quinn, hi");
  });

  it("does not touch code at the start", () => {
    expect(withoutRecipientSalutation("`Lily, x`", "Lily")).toBe("`Lily, x`");
    expect(withoutRecipientSalutation("```\nLily, x\n```", "Lily")).toBe("```\nLily, x\n```");
  });

  it("keeps the original when nothing remains", () => {
    expect(withoutRecipientSalutation("Lily,", "Lily")).toBe("Lily,");
    expect(withoutRecipientSalutation("Lily:  ", "Lily")).toBe("Lily:  ");
  });

  it("keeps the text when the recipient name is empty", () => {
    expect(withoutRecipientSalutation(", hi", "")).toBe(", hi");
  });
});
