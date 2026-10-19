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

  it("gives a photo avatar the speaker-name colour of its own id, not a shared fallback", () => {
    const photo = "data:image/png;base64,AAAA";
    for (const id of ["cmvag1it0001h4epbvls4w5nn", "cmvag1iox00184epb1t9edqer"]) {
      expect(botMentionTextColors(id, photo).onDark).toBe(resolvePersonaColorDef(id, photo).light);
    }
    const ids = ["josy-id", "quinn-id", "riona-id", "elena-id", "maya-id", "isabella-id"];
    const shades = new Set(ids.map((id) => botMentionTextColors(id, photo).onDark));
    expect(shades.size).toBeGreaterThan(1);
  });
});
