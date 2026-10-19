import { selectedAskActionLabel } from "@rakazo/core";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AnsweredByLine, type AskBlock, AskCard } from "./AskCard";

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

describe("AskCard free-text option", () => {
  const block = {
    kind: "ask",
    text: "Reply to Andreas Balodimos (#3536)?",
    status: "pending",
    actions: [
      { id: "self", label: "I'll send it myself" },
      { id: "skip", label: "Don't reply" },
    ],
  } as unknown as AskBlock;

  it("offers the composer as the card's free-text answer", () => {
    const html = renderToStaticMarkup(
      <AskCard block={block} canAnswer onAnswer={async () => {}} onAnswerInChat={() => {}} />,
    );
    expect(html).toContain('data-testid="ask-answer-in-chat"');
    expect(html).toContain("I&#x27;ll type it");
  });

  it("hides the option on approval cards", () => {
    const approval = {
      ...block,
      approvalEffectId: "effect-1",
      actions: [
        { id: "allow", label: "Allow" },
        { id: "deny", label: "Deny" },
      ],
    } as unknown as AskBlock;
    const html = renderToStaticMarkup(
      <AskCard block={approval} canAnswer onAnswer={async () => {}} onAnswerInChat={() => {}} />,
    );
    expect(html).not.toContain('data-testid="ask-answer-in-chat"');
  });
});
