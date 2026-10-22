import { describe, expect, it } from "vitest";

import {
  composerDraftStorageKey,
  readComposerDraft,
  readComposerDraftOccurrences,
  writeComposerDraft,
  writeComposerDraftState,
} from "./composer-draft.js";

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

describe("composer drafts", () => {
  it("scopes stored drafts per thread", () => {
    expect(composerDraftStorageKey("bot:1")).toBe("rakazo.composerDraft.bot:1");
    expect(composerDraftStorageKey("group:2")).toBe("rakazo.composerDraft.group:2");
  });

  it("round-trips a draft and clears the key when empty", () => {
    const storage = memoryStorage();
    expect(readComposerDraft("bot:1", storage)).toBe("");
    writeComposerDraft("bot:1", "hello @ada", storage);
    expect(readComposerDraft("bot:1", storage)).toBe("hello @ada");
    expect(readComposerDraft("group:2", storage)).toBe("");
    writeComposerDraft("bot:1", "", storage);
    expect(readComposerDraft("bot:1", storage)).toBe("");
  });

  it("tolerates missing storage", () => {
    expect(readComposerDraft("bot:1", null)).toBe("");
    expect(() => writeComposerDraft("bot:1", "hi", null)).not.toThrow();
  });
});

describe("inline draft metadata", () => {
  const occurrence = {
    start: 4,
    end: 8,
    mention: { kind: "bot" as const, id: "bot-a", name: "Ada" },
  };
  it("round-trips identities but plain writes and empty drafts clear them", () => {
    const storage = memoryStorage();
    writeComposerDraftState("one", "Ask @Ada", [occurrence], storage);
    expect(readComposerDraftOccurrences("one", storage)).toEqual([occurrence]);
    expect(readComposerDraftOccurrences("two", storage)).toEqual([]);
    writeComposerDraft("one", "Ask @Ada", storage);
    expect(readComposerDraftOccurrences("one", storage)).toEqual([]);
    writeComposerDraftState("one", "Ask @Ada", [occurrence], storage);
    writeComposerDraft("one", "", storage);
    expect(readComposerDraftOccurrences("one", storage)).toEqual([]);
  });
  it.each([
    { text: "different", occurrences: [occurrence] },
    { text: "Ask @Ada", occurrences: [{ ...occurrence, end: 99 }] },
    {
      text: "Ask @Ada",
      occurrences: [{ ...occurrence, mention: { kind: "routine", id: "r", name: "Ada" } }],
    },
    { text: "Ask @Ada", occurrences: [occurrence, occurrence] },
  ])("ignores stale, corrupt or action metadata: %j", (saved) => {
    const storage = memoryStorage({
      "rakazo.composerDraft.one": "Ask @Ada",
      "rakazo.composerDraft.one.mentions": JSON.stringify(saved),
    });
    expect(readComposerDraftOccurrences("one", storage)).toEqual([]);
    expect(readComposerDraft("one", storage)).toBe("Ask @Ada");
  });
});

it.each(["by", "é", "-", "_", "𐐀"])("rejects stale boundary sidecars (%s)", (joined) => {
  for (const text of [`Ask @Ada${joined}`, `Ask ${joined}@Ada`]) {
    const start = text.indexOf("@");
    const storage = memoryStorage({
      "rakazo.composerDraft.one": text,
      "rakazo.composerDraft.one.mentions": JSON.stringify({
        text,
        occurrences: [{ start, end: start + 4, mention: { kind: "bot", id: "a", name: "Ada" } }],
      }),
    });
    expect(readComposerDraftOccurrences("one", storage)).toEqual([]);
    expect(readComposerDraft("one", storage)).toBe(text);
  }
});
