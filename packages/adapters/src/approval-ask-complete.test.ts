import { describe, expect, it } from "vitest";
import { buildApprovalAskBlock } from "./approval-ask.js";

function ask(...args: Parameters<typeof buildApprovalAskBlock>) {
  const block = buildApprovalAskBlock(...args);
  if (block.kind !== "ask") throw new Error("expected ask");
  return block;
}

describe("complete redacted approval evidence", () => {
  it("retains the resolved summary, last evidence and exclusions", () => {
    const title = "Review ".repeat(100);
    const lines = ["Current evidence: " + "e".repeat(5000), "Excluded: all other resources"];
    const block = ask("effect", "shell", {}, [], { summary: { title, lines } });
    expect(block.text).toBe(title);
    expect(block.detail).toBe(lines.join("\n"));
  });

  it("retains complete multiline arguments and late evidence links", () => {
    const body = "First line\n" + "b".repeat(5000) + "\nLast line";
    const block = ask(
      "effect",
      "mcp__review__action",
      {
        to: "example",
        subject: "Review",
        body,
        query: "scope",
        path: "review.txt",
        url: "https://example.test/evidence",
        remaining_step: "verify repository selection",
      },
      [],
    );
    expect(block.detail).toContain(body);
    expect(block.detail).toContain("https://example.test/evidence");
    expect(block.detail).toContain("Remaining step: verify repository selection");
  });

  it("keeps complete tool wording, intention and safety checks after redaction", () => {
    const description =
      "Withdraw an obsolete question. " + "Only ordinary unanswered questions. ".repeat(50);
    const intention = "Inspect ".repeat(100) + "sensitive-value";
    const reason = "Check ".repeat(100) + "sensitive-value";
    const block = ask(
      "effect",
      "mcp__review__withdraw",
      { api_key: "hidden-value" },
      ["sensitive-value"],
      { toolDescription: description, intention, reviewReason: reason },
    );
    expect(block.detail).toContain(description);
    expect(block.detail).toContain(intention.replace("sensitive-value", "[redacted]"));
    expect(block.detail).toContain(reason.replace("sensitive-value", "[redacted]"));
    expect(JSON.stringify(block)).not.toContain("sensitive-value");
    expect(JSON.stringify(block)).not.toContain("hidden-value");
  });
});
