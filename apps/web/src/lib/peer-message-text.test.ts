import { describe, expect, it } from "vitest";
import { withoutRecipientSalutation, withRecipientMention } from "./peer-message-text.js";

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

describe("withRecipientMention", () => {
  it("starts the body with an @mention of the recipient", () => {
    expect(withRecipientMention("Draft is ready.", "Josy")).toBe("@Josy Draft is ready.");
    expect(withRecipientMention("  hi", "Super Forms Bot")).toBe("@Super Forms Bot hi");
  });

  it("adds the mention once when the body already starts with it", () => {
    expect(withRecipientMention("@Josy please check", "Josy")).toBe("@Josy please check");
    expect(withRecipientMention("@josy, please check", "Josy")).toBe("@josy, please check");
    expect(withRecipientMention("@Josy", "Josy")).toBe("@Josy");
  });

  it("still adds it when the body starts with another name", () => {
    expect(withRecipientMention("@Josyanne hi", "Josy")).toBe("@Josy @Josyanne hi");
    expect(withRecipientMention("@Lily hi", "Josy")).toBe("@Josy @Lily hi");
  });

  it("puts the mention on its own line before line-level Markdown", () => {
    expect(withRecipientMention("```\ncode\n```", "Josy")).toBe("@Josy\n\n```\ncode\n```");
    expect(withRecipientMention("- one\n- two", "Josy")).toBe("@Josy\n\n- one\n- two");
    expect(withRecipientMention("# Title", "Josy")).toBe("@Josy\n\n# Title");
  });

  it("keeps the text when the recipient name is empty", () => {
    expect(withRecipientMention("hi", " ")).toBe("hi");
  });
});
