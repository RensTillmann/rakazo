import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The macros compile away in the app build; tests run the source, so render the English text.
const { english } = vi.hoisted(() => ({
  english: (strings: TemplateStringsArray, ...values: unknown[]) =>
    String.raw({ raw: strings }, ...values),
}));
vi.mock("@lingui/core/macro", () => ({ t: english }));
vi.mock("@lingui/react/macro", () => ({ useLingui: () => ({ t: english }) }));

import { APPROVAL_NEVER_AUTOMATIC_LINE } from "@rakazo/core";
import { ApprovalDetail } from "./ApprovalDetail";

describe("ApprovalDetail", () => {
  it("shows each line with its label in bold and a command in code style", () => {
    const html = renderToStaticMarkup(
      <ApprovalDetail
        detail={[
          "Command: `git push origin main`",
          "Why: I'll publish the fix Rens asked for.",
          APPROVAL_NEVER_AUTOMATIC_LINE,
        ].join("\n")}
      />,
    );

    expect(html).toContain('<span class="font-medium text-foreground">Command:</span>');
    expect(html).toContain(">git push origin main</code>");
    expect(html).toContain('<span class="font-medium text-foreground">Why:</span>');
    expect(html).toContain("I&#x27;ll publish the fix Rens asked for.");
    expect(html).toContain("Always asks you (never automatic)");
  });

  it("heads each action of a batch and keeps plain lines as text", () => {
    const html = renderToStaticMarkup(
      <ApprovalDetail
        detail={["Send an email (Gmail):", "To: ada@example.test", "Stays separate."].join("\n")}
      />,
    );

    expect(html).toContain(
      '<div class="pt-1 font-medium text-foreground">Send an email (Gmail)</div>',
    );
    expect(html).toContain("ada@example.test");
    expect(html).toContain('<div class="break-words">Stays separate.</div>');
  });
});
