import { describe, expect, it } from "vitest";
import {
  MessageBlock,
  THINKING_BLOCK_MAX_CHARS,
  ThreadMessageSchema,
  thinkingBlock,
  withoutThinkingBlocks,
} from "./index.js";

describe("thinking block", () => {
  it("parses as a message block, and old messages without it still parse", () => {
    expect(MessageBlock.parse({ kind: "thinking", text: "Plan" })).toEqual({
      kind: "thinking",
      text: "Plan",
    });
    expect(
      ThreadMessageSchema.safeParse({
        id: "message-1",
        threadId: "thread-1",
        seq: 0,
        role: "bot",
        blocks: [{ kind: "text", text: "Hi" }],
        createdAt: "2026-10-18T08:00:00.000Z",
      }).success,
    ).toBe(true);
  });

  it("keeps short thinking whole and cuts long thinking at the cap, marking it", () => {
    expect(thinkingBlock("  Plan  ")).toEqual({ kind: "thinking", text: "Plan" });
    expect(thinkingBlock("   ")).toBeNull();
    const cut = thinkingBlock("a".repeat(THINKING_BLOCK_MAX_CHARS + 1));
    expect(cut?.truncated).toBe(true);
    expect(cut?.text).toHaveLength(THINKING_BLOCK_MAX_CHARS);
    expect(cut?.text.endsWith("…")).toBe(true);
    expect(thinkingBlock("a".repeat(THINKING_BLOCK_MAX_CHARS))?.truncated).toBeUndefined();
  });

  it("is dropped from blocks bound for a model, relay, search or export", () => {
    const reply = { kind: "text" as const, text: "Done." };
    expect(withoutThinkingBlocks([{ kind: "thinking", text: "x" }, reply])).toEqual([reply]);
    const plain = [reply];
    expect(withoutThinkingBlocks(plain)).toBe(plain);
  });
});
