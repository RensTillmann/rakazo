import { describe, expect, it } from "vitest";
import { previewFromBlocks } from "./thread-listing.js";

describe("previewFromBlocks", () => {
  it("preserves literal URL paths in autolinks", () => {
    expect(previewFromBlocks([{ kind: "text", text: "Open <https://example.test/_draft_>" }])).toBe(
      "Open https://example.test/_draft_",
    );
  });
  it("preserves filenames while removing surrounding Markdown", () => {
    expect(previewFromBlocks([{ kind: "text", text: "Saved **monthly_sales_report.csv**" }])).toBe(
      "Saved monthly_sales_report.csv",
    );
  });
  it("returns the first text block with Markdown stripped", () => {
    expect(
      previewFromBlocks([
        { kind: "steps", steps: [{ label: "Read file", count: 1 }] },
        { kind: "text", text: "Created **Projects-CoS** as a **Project**" },
      ]),
    ).toBe("Created Projects-CoS as a Project");
  });

  it("previews a withdrawn or ended card by its retired state, not its question", () => {
    const card = { kind: "ask", text: "Case 401 · Renew the plan?", actions: [] };
    expect(
      previewFromBlocks([
        { ...card, status: "retired", retiredReason: "Withdrawn: Case 401 closed" },
      ]),
    ).toBe("No longer needed · Withdrawn: Case 401 closed");
    expect(previewFromBlocks([{ ...card, status: "retired" }])).toBe("No longer needed");
    expect(previewFromBlocks([{ ...card, status: "pending" }])).toBe("Case 401 · Renew the plan?");
  });

  it("never previews the bot's thinking", () => {
    expect(
      previewFromBlocks([
        { kind: "thinking", text: "Private reasoning" },
        { kind: "text", text: "The reply" },
      ]),
    ).toBe("The reply");
  });

  it("returns empty when there is no text block", () => {
    expect(previewFromBlocks([{ kind: "steps", steps: [] }])).toBe("");
    expect(previewFromBlocks(undefined)).toBe("");
  });
});
