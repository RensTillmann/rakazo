import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { withThoughtsVisibility } from "./show-thoughts";

const thought: MessageBlock = { kind: "text", text: "Label missing; create it.", narration: true };
const reply: MessageBlock = { kind: "text", text: "Created the label." };
const messages: { id: string; blocks: MessageBlock[] }[] = [
  { id: "thought", blocks: [thought] },
  { id: "mixed", blocks: [thought, reply] },
  { id: "old", blocks: [reply] },
];

describe("withThoughtsVisibility", () => {
  it("hides narration blocks and messages made only of them when off", () => {
    expect(withThoughtsVisibility(messages, false)).toEqual([
      { id: "mixed", blocks: [reply] },
      { id: "old", blocks: [reply] },
    ]);
  });

  it("shows everything when on", () => {
    expect(withThoughtsVisibility(messages, true)).toBe(messages);
  });

  it("passes old messages without the flag through unchanged", () => {
    expect(withThoughtsVisibility(messages, false)[1]).toBe(messages[2]);
  });
});
