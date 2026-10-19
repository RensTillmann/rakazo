import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RosterAttentionBadge } from "./RosterAttentionBadge";

describe("RosterAttentionBadge", () => {
  it("shows a ringed orange dot labelled for a row that needs an answer", () => {
    const html = renderToStaticMarkup(<RosterAttentionBadge label="Needs your answer" />);

    expect(html).toContain("data-roster-attention-badge");
    expect(html).toContain('aria-label="Needs your answer"');
    expect(html).toContain('role="img"');
    expect(html).toContain("bg-warning");
    expect(html).toContain("border-sidebar");
    expect(html).toContain("-top-0.5");
    expect(html).toContain("-end-0.5");
  });

  it("shows the same dot labelled for an unread row", () => {
    const html = renderToStaticMarkup(<RosterAttentionBadge label="Unread" />);

    expect(html).toContain('aria-label="Unread"');
    expect(html).toContain("bg-warning");
  });

  it("renders nothing when the row needs no attention", () => {
    expect(renderToStaticMarkup(<RosterAttentionBadge label={null} />)).toBe("");
  });
});
