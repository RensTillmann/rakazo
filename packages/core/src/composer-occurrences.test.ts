import { describe, expect, it } from "vitest";
import {
  composerMentionQuery,
  composerOccurrenceMentions,
  editComposerOccurrences,
  insertComposerOccurrence,
} from "./composer-occurrences.js";

import { resolveGroupTargetBotIds } from "./group-mentions.js";

const bot = { kind: "bot" as const, id: "bot-a", name: "Avery" };

describe("inline composer occurrences", () => {
  it("completes at the caret in the middle, retaining punctuation and Unicode", () => {
    const text = "É🙂 ask @Av; then continue.";
    const caret = text.indexOf(";");
    const result = insertComposerOccurrence(text, caret, caret, bot, []);
    expect(result?.text).toBe("É🙂 ask @Avery; then continue.");
    expect(result?.caret).toBe("É🙂 ask @Avery".length);
    expect(result?.occurrences[0]?.start).toBe("É🙂 ask ".length);
  });

  it("retains repeat positions but deduplicates routing IDs", () => {
    const first = insertComposerOccurrence("Ask @Av", 7, 7, bot, [])!;
    const text = `${first.text}then @Av`;
    const second = insertComposerOccurrence(
      text,
      text.length,
      text.length,
      bot,
      first.occurrences,
    )!;
    expect(second.text).toBe("Ask @Avery then @Avery ");
    expect(second.occurrences).toHaveLength(2);
    expect(composerOccurrenceMentions(second.occurrences)).toEqual([bot]);
  });

  it("shifts identities when editing before a mention and drops edited/deleted mentions", () => {
    const first = insertComposerOccurrence("Ask @Av", 7, 7, bot, [])!;
    const next = `🙂 ${first.text}`;
    const shifted = editComposerOccurrences(first.text, next, first.occurrences);
    expect(shifted[0]?.start).toBe(first.occurrences[0]!.start + 3);
    expect(editComposerOccurrences(next, next.replace("@Avery", "@Other"), shifted)).toEqual([]);
    expect(editComposerOccurrences(next, next.replace("@Avery", ""), shifted)).toEqual([]);
  });

  it("replaces a selected range and keeps following occurrences correctly offset", () => {
    const text = "@Av replace this; @Avery";
    const existing = [{ start: text.lastIndexOf("@"), end: text.length, mention: bot }];
    const result = insertComposerOccurrence(text, 3, text.indexOf(";"), bot, existing)!;
    expect(result.text).toBe("@Avery; @Avery");
    expect(result.occurrences.map(({ start }) => start)).toEqual([0, 8]);
  });

  it("recognises Unicode queries and ignores email-like text", () => {
    expect(composerMentionQuery("Hi @Él", 6)?.query).toBe("Él");
    expect(composerMentionQuery("person@Av", 9)).toBeNull();
    expect(insertComposerOccurrence("plain", 5, 5, bot, [])).toBeNull();
  });
});

describe("mention edit boundaries", () => {
  const bob = { kind: "bot" as const, id: "bob", name: "Bob" };
  it.each(["by", "é", "界", "2", "_", "-", "𐐀"])(
    "drops an identity when %s joins either boundary",
    (joined) => {
      const first = insertComposerOccurrence("Ask @Bo", 7, 7, bob, [])!;
      for (const text of [`Ask @Bob${joined} `, `Ask ${joined}@Bob `]) {
        expect(editComposerOccurrences(first.text, text, first.occurrences)).toEqual([]);
      }
    },
  );
  it("routes an extended name only to its current recipient", () => {
    const first = insertComposerOccurrence("Ask @Bo", 7, 7, bob, [])!;
    const text = "Ask @Bobby ";
    const occurrences = editComposerOccurrences(first.text, text, first.occurrences);
    expect(
      resolveGroupTargetBotIds({
        text,
        members: [
          { id: "bob", name: "Bob" },
          { id: "bobby", name: "Bobby" },
        ],
        explicitMentions: composerOccurrenceMentions(occurrences).map((m) => m.id),
      }),
    ).toEqual(["bobby"]);
  });
  it.each([";", ",", ".", "!", "🙂", "\n"])(
    "preserves punctuation or delimiter %s and genuine repeats",
    (delimiter) => {
      const first = insertComposerOccurrence("Ask @Bo", 7, 7, bob, [])!;
      const text = `Ask @Bob${delimiter} `;
      const occurrences = editComposerOccurrences(first.text, text, first.occurrences);
      expect(composerOccurrenceMentions(occurrences)).toEqual([bob]);
      const next = `${text}again @Bo`;
      const repeated = insertComposerOccurrence(next, next.length, next.length, bob, occurrences)!;
      expect(repeated.occurrences).toHaveLength(2);
      expect(composerOccurrenceMentions(repeated.occurrences)).toEqual([bob]);
    },
  );
});
