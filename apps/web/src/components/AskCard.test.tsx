// @vitest-environment jsdom
import { selectedAskActionLabel } from "@rakazo/core";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnsweredByLine, type AskBlock, AskCard } from "./AskCard";

// vi.mock factories run before module code, so the shared lingui stub is hoisted with them.
const { joinTemplate, dictationMock } = vi.hoisted(() => ({
  joinTemplate: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce(
      (text, part, index) => text + part + (index < values.length ? String(values[index]) : ""),
      "",
    ),
  dictationMock: {
    subscribe: () => () => {},
    listen: vi.fn(async (_options: { onFinal: (text: string) => void }) => {}),
    submitHold: () => {},
    stop: () => {},
  },
}));

vi.mock("@lingui/core/macro", () => ({ t: joinTemplate }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: joinTemplate }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../lib/rpc", () => ({ rpc: {} }));
vi.mock("../lib/dictation", () => ({ dictation: dictationMock }));

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

  it("offers a typed answer field below the choices", () => {
    const html = renderToStaticMarkup(
      <AskCard block={block} canAnswer onAnswer={async () => {}} />,
    );
    expect(html).toContain('data-testid="ask-type-answer"');
    expect(html).toContain("<textarea");
    expect(html).toContain('placeholder="Or type your own answer…"');
    expect(html).not.toContain("I&#x27;ll type it");
  });

  it("hides the field on approval cards", () => {
    const approval = {
      ...block,
      approvalEffectId: "effect-1",
      actions: [
        { id: "allow", label: "Allow" },
        { id: "deny", label: "Deny" },
      ],
    } as unknown as AskBlock;
    const html = renderToStaticMarkup(
      <AskCard block={approval} canAnswer onAnswer={async () => {}} />,
    );
    expect(html).not.toContain('data-testid="ask-type-answer"');
  });

  describe("typing an answer", () => {
    let container: HTMLDivElement;
    let root: Root;
    const onAnswer = vi.fn(
      async (
        _text: string,
        _username?: string,
        _files?: readonly File[],
        _draftFinal?: string,
      ) => {},
    );

    beforeEach(() => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      onAnswer.mockClear();
      dictationMock.listen.mockClear();
      container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
      act(() =>
        root.render(
          <AskCard
            block={block}
            canAnswer
            onAnswer={onAnswer}
            voice={{}}
            attachmentMaxBytes={10 * 1024 * 1024}
          />,
        ),
      );
    });

    afterEach(() => {
      act(() => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    });

    const field = () =>
      container.querySelector<HTMLTextAreaElement>('[data-testid="ask-type-answer"]')!;
    const sendButton = () =>
      [...container.querySelectorAll("button")].find((button) => button.textContent === "Send")!;
    const type = (value: string) =>
      act(() => {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
        descriptor?.set?.call(field(), value);
        field().dispatchEvent(new Event("input", { bubbles: true }));
      });
    const press = (init: KeyboardEventInit) => {
      const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
      act(() => {
        field().dispatchEvent(event);
      });
      return event;
    };
    const button = (label: string) =>
      container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
    const chooseFiles = (files: File[]) =>
      act(() => {
        const input = container.querySelector<HTMLInputElement>(
          '[data-testid="ask-attach-input"]',
        )!;
        Object.defineProperty(input, "files", { configurable: true, value: files });
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });

    it("sends the exact typed text on Enter", async () => {
      expect(field().getAttribute("aria-label")).toBe("Your answer");
      type("  Only on Monday, after 10  ");
      await act(async () => {
        press({ key: "Enter" });
      });
      expect(onAnswer).toHaveBeenCalledTimes(1);
      expect(onAnswer).toHaveBeenCalledWith(
        "Only on Monday, after 10",
        undefined,
        undefined,
        undefined,
      );
    });

    it("keeps Shift+Enter for a new line and sends both lines", async () => {
      type("First line");
      const shiftEnter = press({ key: "Enter", shiftKey: true });
      expect(shiftEnter.defaultPrevented).toBe(false);
      expect(onAnswer).not.toHaveBeenCalled();
      type("First line\nSecond line");
      await act(async () => {
        sendButton().click();
      });
      expect(onAnswer).toHaveBeenCalledWith(
        "First line\nSecond line",
        undefined,
        undefined,
        undefined,
      );
    });

    it("keeps Send disabled until there is text", async () => {
      expect(sendButton().disabled).toBe(true);
      type("   ");
      expect(sendButton().disabled).toBe(true);
      await act(async () => {
        press({ key: "Enter" });
      });
      expect(onAnswer).not.toHaveBeenCalled();
      type("Yes");
      expect(sendButton().disabled).toBe(false);
    });

    it("still answers a choice by its id", async () => {
      const choice = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Don't reply",
      )!;
      await act(async () => {
        choice.click();
      });
      expect(onAnswer).toHaveBeenCalledWith("skip", undefined, undefined, undefined);
    });

    it("puts dictated text into the box and never sends it", async () => {
      // The card's mic adds the words to the box, so it does not promise to send them.
      expect(button("Hold to talk").title).toBe("Hold to talk, release to add the text");
      type("Only on Monday");
      // A keyboard press (detail 0) starts a locked recording.
      await act(async () => {
        button("Hold to talk").dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
      });
      const options = dictationMock.listen.mock.calls[0]![0];
      act(() => options.onFinal("after ten"));
      expect(field().value).toBe("Only on Monday after ten");
      expect(onAnswer).not.toHaveBeenCalled();
    });

    it("shows chosen files as removable chips and sends them with the answer", async () => {
      const brief = new File(["brief"], "brief.pdf", { type: "application/pdf" });
      const notes = new File(["notes"], "notes.txt", { type: "text/plain" });
      chooseFiles([brief, notes]);
      const chips = container.querySelector('[data-testid="ask-attachments"]');
      expect(chips?.textContent).toContain("brief.pdf");
      expect(chips?.textContent).toContain("notes.txt");
      act(() => button("Remove notes.txt").click());
      expect(chips?.textContent).not.toContain("notes.txt");
      type("Here it is");
      await act(async () => {
        sendButton().click();
      });
      expect(onAnswer).toHaveBeenCalledWith("Here it is", undefined, [brief], undefined);
    });

    it("answers with files alone", async () => {
      const brief = new File(["brief"], "brief.pdf", { type: "application/pdf" });
      expect(sendButton().disabled).toBe(true);
      chooseFiles([brief]);
      expect(sendButton().disabled).toBe(false);
      await act(async () => {
        sendButton().click();
      });
      expect(onAnswer).toHaveBeenCalledWith(
        "See the attached file(s).",
        undefined,
        [brief],
        undefined,
      );
    });
  });
});

describe("AskCard reply draft", () => {
  const draft = "Hi Konstantin,\n\nYour licence is active again.\n\nRens";
  const edited = "Hi Konstantin,\n\nYour licence is active again from today.\n\nRens";
  const block = {
    kind: "ask",
    text: "Case 280 · licence: Reply to Konstantin Grushko (#3529)?",
    status: "pending",
    draft,
    actions: [
      { id: "choice-1", label: "Approve and send" },
      { id: "choice-2", label: "Don't reply" },
    ],
  } as unknown as AskBlock;

  it("shows the sent reply read-only once answered, marked when it was edited", () => {
    const answered = {
      ...block,
      status: "answered",
      answer: "choice-1",
      draftFinal: edited,
    } as unknown as AskBlock;
    const html = renderToStaticMarkup(
      <AskCard block={answered} canAnswer onAnswer={async () => {}} />,
    );
    expect(html).toContain('data-testid="ask-draft"');
    expect(html).not.toContain("<textarea");
    expect(html).toContain("active again from today");
    expect(html).toContain("Edited before answering");
    const unedited = renderToStaticMarkup(
      <AskCard
        block={{ ...answered, draftFinal: undefined } as AskBlock}
        canAnswer
        onAnswer={async () => {}}
      />,
    );
    expect(unedited).toContain("Your licence is active again.");
    expect(unedited).not.toContain("Edited before answering");
  });

  it("sends the edited reply with a typed answer too", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const onAnswer = vi.fn(
      async (
        _text: string,
        _username?: string,
        _files?: readonly File[],
        _draftFinal?: string,
      ) => {},
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<AskCard block={block} canAnswer onAnswer={onAnswer} />));
    const setValue = (element: HTMLTextAreaElement, value: string) =>
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
          element,
          value,
        );
        element.dispatchEvent(new Event("input", { bubbles: true }));
      });
    const draftField = container.querySelector<HTMLTextAreaElement>('[data-testid="ask-draft"]')!;
    expect(draftField.value).toBe(draft);
    setValue(draftField, edited);
    const answerField = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="ask-type-answer"]',
    )!;
    setValue(answerField, "Send it after 10");
    await act(async () => {
      answerField.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    expect(onAnswer).toHaveBeenCalledWith("Send it after 10", undefined, undefined, edited);
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
});
