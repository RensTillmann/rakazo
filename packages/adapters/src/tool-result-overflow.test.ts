import { toolRequiresApproval, unattendedTriggerToolRequiresApproval } from "@rakazo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { selectBuiltinToolsForRun } from "./executor.js";
import { clipToolResultContent, clipToolResultText } from "./pi-runtime-limits.js";
import { cutOffNote, ToolResultOverflowStore } from "./tool-result-overflow.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("cut-off line", () => {
  it("says how much was shown and how to read the rest", () => {
    const clipped = clipToolResultText("x".repeat(20_483), 12_000, "r1");
    expect(clipped.startsWith("x".repeat(12_000))).toBe(true);
    expect(clipped.endsWith(
      '\n[cut off: showed 12,000 of 20,483 characters. Ask a narrower question, or read the rest with read_tool_result("r1", offset=12000).]',
    )).toBe(true);
  });

  it("without a kept copy only gives the counts and the narrower-question advice", () => {
    const clipped = clipToolResultText("x".repeat(20_483));
    expect(clipped.endsWith(
      "\n[cut off: showed 12,000 of 20,483 characters. Ask a narrower question.]",
    )).toBe(true);
    expect(clipped).not.toContain("read_tool_result");
  });

  it("notes the cut once across parts and hands the joined text to keep", () => {
    const keep = vi.fn(() => "r2");
    const image = { type: "image", data: "iVBORw0KGgo=" };
    const clipped = clipToolResultContent(
      [
        { type: "text", text: "a".repeat(8) },
        image,
        { type: "text", text: "b".repeat(5) },
        { type: "text", text: "c".repeat(4) },
      ],
      10,
      keep,
    );
    expect(keep).toHaveBeenCalledWith(`${"a".repeat(8)}${"b".repeat(5)}${"c".repeat(4)}`);
    expect(clipped).toEqual([
      { type: "text", text: "a".repeat(8) },
      image,
      { type: "text", text: `bb\n${cutOffNote(10, 17, "r2")}` },
    ]);
  });

  it("adds a note part when the budget ends exactly between parts", () => {
    const clipped = clipToolResultContent(
      [
        { type: "text", text: "a".repeat(10) },
        { type: "text", text: "omitted" },
      ],
      10,
    );
    expect(clipped).toEqual([
      { type: "text", text: "a".repeat(10) },
      { type: "text", text: cutOffNote(10, 17) },
    ]);
  });

  it("leaves results within the limit untouched", () => {
    const keep = vi.fn(() => "r1");
    const content = [{ type: "text", text: "short" }];
    expect(clipToolResultContent(content, 10, keep)).toBe(content);
    expect(keep).not.toHaveBeenCalled();
  });
});

describe("ToolResultOverflowStore", () => {
  it("returns the next slice with the line while more remains, and none at the end", () => {
    const store = new ToolResultOverflowStore();
    const ref = store.keep("run", `${"a".repeat(10)}${"b".repeat(10)}${"c".repeat(5)}`);
    expect(store.read("run", ref, 10, 10)).toBe(`${"b".repeat(10)}\n${cutOffNote(20, 25, ref)}`);
    expect(store.read("run", ref, 20, 10)).toBe("c".repeat(5));
    expect(store.read("other-run", ref, 0, 10)).toContain("No kept tool result");
  });

  it("drops the oldest results past the run cap and cuts one result to its cap", () => {
    const store = new ToolResultOverflowStore(6, 10);
    const first = store.keep("run", "1".repeat(4));
    const second = store.keep("run", "2".repeat(4));
    const third = store.keep("run", "3".repeat(9));
    expect(store.read("run", first, 0, 10)).toContain("No kept tool result");
    expect(store.read("run", second, 0, 10)).toBe("2".repeat(4));
    expect(store.read("run", third, 0, 10)).toBe("3".repeat(6));
    store.keep("run", "4".repeat(6));
    expect(store.read("run", second, 0, 10)).toContain("No kept tool result");
  });
});

describe("read_tool_result", () => {
  const base = {
    graphicalToolsAllowed: false,
    groupId: null,
    trigger: "message",
    semanticMemoryEnabled: false,
    messagingChannelRun: false,
  };

  it("is a read for approvals, also in unattended runs", () => {
    expect(toolRequiresApproval("read_tool_result", false)).toBe(false);
    expect(unattendedTriggerToolRequiresApproval("webhook", "read_tool_result", false)).toBe(
      false,
    );
  });

  it("is offered only with RAKAZO_TOOL_RESULT_OVERFLOW=true", () => {
    const names = () => selectBuiltinToolsForRun(base).map((tool) => tool.name);
    vi.stubEnv("RAKAZO_TOOL_RESULT_OVERFLOW", "");
    expect(names()).not.toContain("read_tool_result");
    vi.stubEnv("RAKAZO_TOOL_RESULT_OVERFLOW", "true");
    expect(names()).toContain("read_tool_result");
  });
});
