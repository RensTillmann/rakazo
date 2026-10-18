import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { blocksToAgentHistoryText } from "./attachments.js";
import { withoutThinking } from "./events.js";
import { messageReplyExcerpt } from "./message-quote.js";

const thinking: MessageBlock = { kind: "thinking", text: "PRIVATE-REASONING" };
const reply: MessageBlock = { kind: "text", text: "Urgent and later." };

describe("thinking blocks", () => {
  it("never become model history or compaction input", () => {
    expect(blocksToAgentHistoryText([thinking, reply])).toBe("Urgent and later.");
    expect(blocksToAgentHistoryText([thinking])).toBe("");
  });

  it("are never quoted in a reply", () => {
    expect(messageReplyExcerpt([thinking, reply], "bot")).toBe("Urgent and later.");
    expect(messageReplyExcerpt([thinking], "bot")).toBe("");
  });

  it("drop out and rejoin the tool steps they separated", () => {
    const blocks: MessageBlock[] = [
      { kind: "steps", steps: [{ label: "Shell", count: 1 }] },
      thinking,
      { kind: "steps", steps: [{ label: "Shell", count: 1 }], durationMs: 3_000 },
      thinking,
      reply,
      { kind: "steps", steps: [{ label: "Read file", count: 1 }] },
    ];
    expect(withoutThinking(blocks)).toEqual([
      { kind: "steps", steps: [{ label: "Shell", count: 2 }], durationMs: 3_000 },
      reply,
      { kind: "steps", steps: [{ label: "Read file", count: 1 }] },
    ]);
    const plain: MessageBlock[] = [reply];
    expect(withoutThinking(plain)).toBe(plain);
  });
});
