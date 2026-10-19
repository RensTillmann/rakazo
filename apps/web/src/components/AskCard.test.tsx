import { selectedAskActionLabel } from "@rakazo/core";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AnsweredByLine } from "./AskCard";

// vi.mock factories run before module code, so the shared lingui stub is hoisted with them.
const { joinTemplate } = vi.hoisted(() => ({
  joinTemplate: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce(
      (text, part, index) => text + part + (index < values.length ? String(values[index]) : ""),
      "",
    ),
}));

vi.mock("@lingui/core/macro", () => ({ t: joinTemplate }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: joinTemplate }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../lib/rpc", () => ({ rpc: {} }));

describe("AnsweredByLine", () => {
  it("names the answering device and time", () => {
    const at = "2026-10-19T15:17:00.000Z";
    const html = renderToStaticMarkup(
      <AnsweredByLine
        answeredBy={{
          userId: "user-1",
          sessionId: "session-1",
          userAgent: "fleet-service (do not delete)",
          at,
        }}
      />,
    );
    expect(html).toContain('data-testid="ask-answered-by"');
    expect(html).toContain(`Answered by fleet service · ${new Date(at).toLocaleString()}`);
    expect(html).not.toContain("session-1");
  });
});

describe("selectedAskActionLabel", () => {
  it("maps a choice answer id to its user-facing label", () => {
    expect(
      selectedAskActionLabel("choice-2", [
        { id: "choice-1", label: "Berlin" },
        { id: "choice-2", label: "Seoul" },
      ]),
    ).toBe("Seoul");
  });

  it("falls back to the answer when an action is unavailable", () => {
    expect(selectedAskActionLabel("custom", undefined)).toBe("custom");
  });
});
