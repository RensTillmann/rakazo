import { describe, expect, it } from "vitest";
import { botMentionTextColors, resolvePersonaColorDef } from "./bot-avatar-colors.js";

describe("persona avatar colors", () => {
  it("keeps Amber Gold on dark eyes instead of a brightness heuristic", () => {
    expect(resolvePersonaColorDef("preview", "#EAB308").eyeColor).toBe("#141414");
    expect(resolvePersonaColorDef("preview", "#8B5CF6").eyeColor).toBe("#FFFFFF");
  });
});

describe("bot mention text colors", () => {
  it("uses the persona's darker stop on light themes and lighter stop on dark themes", () => {
    expect(botMentionTextColors("quinn", "#8B5CF6::shape_3")).toEqual({
      onLight: "#7C3AED",
      onDark: "#A97EFE",
    });
  });

  it("darkens a pale persona so it stays readable on a light theme", () => {
    const colors = botMentionTextColors("quinn", "#FFFFFF");
    expect(colors.onDark).toBe("#FFFFFF");
    expect(colors.onLight).not.toBe("#CBD5E1");
  });
});
