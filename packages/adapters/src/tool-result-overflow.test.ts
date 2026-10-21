import { toolRequiresApproval, unattendedTriggerToolRequiresApproval } from "@rakazo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { selectBuiltinToolsForRun } from "./executor.js";
import { clipToolResultContent } from "./pi-runtime-limits.js";
import { cutOffNote, ToolResultOverflowStore } from "./tool-result-overflow.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("cut-off line", () => {
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
    expect(store.read("run", ref, 10, 10).startsWith(`${"b".repeat(10)}\n`)).toBe(true);
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
    expect(store.read("run", third, 0, 10)).toContain("3".repeat(6));
    expect(store.read("run", third, 0, 10)).toContain("Only 6 of 9 original characters retained");
    expect(store.read("run", third, 6, 10)).not.toContain("Nothing left");
    expect(store.read("run", third, 6, 10)).toContain("original tool");
    store.keep("run", "4".repeat(6));
    expect(store.read("run", second, 0, 10)).toContain("No kept tool result");
  });

  it("keeps repeated context projections from evicting the same original evidence", () => {
    const store = new ToolResultOverflowStore(100, 110);
    const first = store.keep("run", "START-MIDDLE-FINAL");
    for (let index = 0; index < 20; index++) {
      expect(store.keep("run", "START-MIDDLE-FINAL")).toBe(first);
    }
    store.keep("run", "another result");
    expect(store.read("run", first, 0, 100)).toBe("START-MIDDLE-FINAL");
    expect(store.read("other-run", first, 0, 100)).toContain("No kept");
    store.clear("run");
    expect(store.read("run", first, 0, 100)).toContain("No kept");
  });

  it("enforces the run capacity even when one result exceeds the run budget", () => {
    const store = new ToolResultOverflowStore(100, 6);
    const ref = store.keep("run", "START-MIDDLE-FINAL");
    expect(store.read("run", ref, 0, 100)).toContain("Only 6 of 18 original characters retained");
    expect(store.read("run", ref, 0, 100)).not.toContain("FINAL");
  });
  it("restores bounded evidence and original reference allocation after a process restart", () => {
    const first = new ToolResultOverflowStore(100, 200);
    const ref = first.keep("run", "exact retained middle and final");
    const snapshot = JSON.parse(JSON.stringify(first.snapshot("run")));
    const restarted = new ToolResultOverflowStore(100, 200);
    restarted.restore("run", snapshot);
    expect(restarted.read("run", ref, 0, 100)).toBe("exact retained middle and final");
    expect(restarted.keep("run", "next original result")).toBe("r2");
    expect(restarted.read("other-run", ref, 0, 100)).toContain("No kept");
    expect(() => restarted.restore("run", { seq: 1, results: [["r2", { text: "wrong", originalChars: 5 }]] }))
      .toThrow("Invalid continuation");
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
    expect(unattendedTriggerToolRequiresApproval("webhook", "read_tool_result", false)).toBe(false);
  });

  it("is offered only with RAKAZO_TOOL_RESULT_OVERFLOW=true", () => {
    const names = () => selectBuiltinToolsForRun(base).map((tool) => tool.name);
    vi.stubEnv("RAKAZO_TOOL_RESULT_OVERFLOW", "");
    expect(names()).not.toContain("read_tool_result");
    vi.stubEnv("RAKAZO_TOOL_RESULT_OVERFLOW", "true");
    expect(names()).toContain("read_tool_result");
  });
});
