import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { withThoughtsVisibility } from "./show-thoughts";

const thought: MessageBlock = { kind: "text", text: "Label missing; create it.", narration: true };
const reply: MessageBlock = { kind: "text", text: "Created the label." };
const thinking: MessageBlock = { kind: "thinking", text: "The user wants an urgent label." };
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

  it("hides thinking blocks and messages made only of thoughts when off", () => {
    const withThinking = [
      { id: "narration", blocks: [thinking, thought] },
      { id: "final", blocks: [thinking, reply] },
    ];
    expect(withThoughtsVisibility(withThinking, false)).toEqual([
      { id: "final", blocks: [reply] },
    ]);
  });

  it("joins the tool steps a hidden thinking block separated", () => {
    const final = {
      id: "final",
      blocks: [
        { kind: "steps", steps: [{ label: "Shell", count: 1 }] },
        thinking,
        { kind: "steps", steps: [{ label: "Shell", count: 2 }, { label: "Read file", count: 1 }] },
        reply,
      ] satisfies MessageBlock[],
    };
    expect(withThoughtsVisibility([final], false)).toEqual([
      {
        id: "final",
        blocks: [
          {
            kind: "steps",
            steps: [
              { label: "Shell", count: 3 },
              { label: "Read file", count: 1 },
            ],
          },
          reply,
        ],
      },
    ]);
  });

  it("shows thinking blocks when on", () => {
    const withThinking = [{ id: "final", blocks: [thinking, reply] }];
    expect(withThoughtsVisibility(withThinking, true)).toBe(withThinking);
  });
});
