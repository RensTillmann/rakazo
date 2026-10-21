// @vitest-environment jsdom
import type { ApprovalReview } from "@rakazo/contracts";
import { selectedAskActionLabel } from "@rakazo/core";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnsweredByLine, type AskBlock, AskCard } from "./AskCard";
import { UserTodosProvider } from "./TodosControl";

// vi.mock factories run before module code, so the shared lingui stub is hoisted with them.
const { joinTemplate, dictationMock, reviewRpc, listTodos } = vi.hoisted(() => ({
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
  reviewRpc: { approvals: { review: vi.fn(async (): Promise<ApprovalReview | null> => null) } },
  listTodos: vi.fn(),
}));

vi.mock("@lingui/core/macro", () => ({ t: joinTemplate }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: joinTemplate }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../lib/rpc", () => ({ rpc: { todos: { list: listTodos } } }));
vi.mock("../lib/dictation", () => ({ dictation: dictationMock }));
vi.mock("../lib/space-rpc", () => ({ useSpaceRpc: () => reviewRpc }));

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

  const dns = {
    key: "dns",
    title: "Add the DNS record",
    steps: "Open the registrar",
    verification: "automatic",
  };
  const withPrerequisites = (items: (typeof dns)[]) =>
    ({
      ...block,
      prerequisites: { items, release: "all" },
      actions: [
        { id: "self", label: "I'll do it myself", todo: true },
        { id: "skip", label: "Skip" },
      ],
    }) as unknown as AskBlock;

  it("notes under the accepting option that it adds a to-do", () => {
    const html = renderToStaticMarkup(
      <AskCard block={withPrerequisites([dns])} canAnswer onAnswer={async () => {}} />,
    );
    expect(html.match(/adds 1 to-do</g)).toHaveLength(1);
    expect(html).toContain('title="Add the DNS record"');
    expect(html.indexOf("adds 1 to-do")).toBeGreaterThan(html.indexOf("do it myself"));
    expect(html.indexOf("adds 1 to-do")).toBeLessThan(html.indexOf("Skip"));
    expect(
      renderToStaticMarkup(<AskCard block={block} canAnswer onAnswer={async () => {}} />),
    ).not.toContain("to-do");
  });

  it("counts several to-dos and keeps their titles in the tooltip", () => {
    const html = renderToStaticMarkup(
      <AskCard
        block={withPrerequisites([dns, { ...dns, key: "mx", title: "Add the MX record" }])}
        canAnswer
        onAnswer={async () => {}}
      />,
    );
    expect(html).toContain("adds 2 to-dos");
    expect(html).toContain('title="Add the DNS record\nAdd the MX record"');
  });

  it("shows the to-dos it handed over once answered, and not while pending", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const todo = (id: string, groupId: string, title: string) => ({
      id,
      botId: "josy",
      botName: "Josy",
      threadId: "t-josy",
      groupId,
      groupTitle: "Reply?",
      release: "all",
      requirementKey: id,
      title,
      steps: "Open the registrar",
      why: null,
      caseNumber: null,
      blocks: [],
      priority: null,
      position: 0,
      verification: "automatic",
      status: "open",
      statusDetail: null,
      evidence: null,
      revision: 1,
      checkRequestedAt: null,
      checkedAt: null,
      createdAt: "2026-10-21T08:00:00.000Z",
      updatedAt: "2026-10-21T08:00:00.000Z",
    });
    listTodos.mockResolvedValue({
      todos: [todo("t1", "msg-1", "Add the DNS record"), todo("t2", "msg-2", "Other card")],
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const card = (status: "pending" | "answered") => (
      <UserTodosProvider scope="user-1:primary" enabled>
        <AskCard
          block={{ ...withPrerequisites([dns]), status, answer: "self" } as AskBlock}
          messageId="msg-1"
          canAnswer
          onAnswer={async () => {}}
        />
      </UserTodosProvider>
    );
    await act(async () => root.render(card("answered")));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const checklist = container.querySelector('[data-testid="todo-checklist"]');
    expect(checklist?.querySelector('input[type="checkbox"]')?.getAttribute("aria-label")).toBe(
      "Mark “Add the DNS record” as done",
    );
    expect(checklist?.textContent).not.toContain("Other card");
    await act(async () => root.render(card("pending")));
    expect(container.querySelector('[data-testid="todo-checklist"]')).toBeNull();
    expect(container.textContent).toContain("adds 1 to-do");
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
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

describe("AskCard reply approval review", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onAnswer = vi.fn(async () => {});
  const proposal = `Hello,\n\n${"Complete reply. ".repeat(400)}FINAL Ω`;
  const review: ApprovalReview = {
    ticket: "42",
    proposedReply: proposal,
    status: "pending",
    tags: ["reviewed"],
    expectedLastCommentId: "10",
    customerContext: { status: "unavailable" },
  };
  const block: AskBlock = {
    kind: "ask",
    text: "Approve tool?",
    status: "pending",
    approvalEffectId: "effect-reply",
    detail:
      "Ticket: 42\nStatus: pending\nTags: reviewed\nExpect last comment ID: 10\nMessage: clipped preview\nWhy: Customer requested help\nSafety check: Verified policy\nThis action is never automatic.",
    actions: [
      { id: "allow", label: "Allow" },
      { id: "deny", label: "Deny" },
    ],
  };
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((element) => element.textContent === label)!;
  const render = (card = block) =>
    act(async () => {
      root.render(<AskCard block={card} canAnswer onAnswer={onAnswer} />);
    });

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    reviewRpc.approvals.review.mockReset();
    onAnswer.mockClear();
    container = document.createElement("div");
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  });

  it("keeps decision reasons alongside the complete proposal without duplicate clipped metadata", async () => {
    reviewRpc.approvals.review.mockResolvedValue(review);
    await render();
    expect(container.querySelector('[aria-label="Proposed reply"] > div')?.textContent).toBe(
      proposal,
    );
    expect(container.textContent).toContain("Customer requested help");
    expect(container.textContent).toContain("Verified policy");
    expect(container.textContent).toContain("never automatic");
    expect(container.textContent).not.toContain("clipped preview");
    expect(container.textContent).not.toContain("Expect last comment ID:");
    expect(button("Allow once").disabled).toBe(false);
  });

  it("leaves historical approvals unchanged without reading current customer context", async () => {
    await render({ ...block, status: "answered", answer: "allow" });
    expect(reviewRpc.approvals.review).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label="Proposed reply"]')).toBeNull();
    expect(container.textContent).toContain("Allowed once");
    expect(container.textContent).toContain("clipped preview");
  });

  it("blocks blind approval during loading and failure but still lets the user deny", async () => {
    let reject!: (error: Error) => void;
    reviewRpc.approvals.review.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    await render();
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(button("Allow once").disabled).toBe(true);
    expect(button("Deny").disabled).toBe(false);
    await act(async () => reject(new Error("offline")));
    expect(button("Allow once").disabled).toBe(true);
    expect(button("Retry")).toBeDefined();
    expect(container.querySelector('[aria-label="Proposed reply"]')).toBeNull();
    await act(async () => button("Deny").click());
    expect(onAnswer).toHaveBeenCalledWith("deny", undefined, undefined, undefined);
  });

  it("keeps the full reply visible and prevents overlapping refreshes when a retry fails", async () => {
    let reject!: (error: Error) => void;
    reviewRpc.approvals.review.mockResolvedValueOnce(review).mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    await render();
    const refresh = button("Refresh customer context");
    await act(async () => {
      refresh.click();
      refresh.click();
    });
    expect(reviewRpc.approvals.review).toHaveBeenCalledTimes(2);
    expect(refresh.disabled).toBe(true);
    expect(container.querySelector('[aria-label="Proposed reply"] > div')?.textContent).toBe(
      proposal,
    );
    await act(async () => reject(new Error("offline")));
    expect(container.querySelector('[aria-label="Proposed reply"] > div')?.textContent).toBe(
      proposal,
    );
    expect(button("Refresh customer context").disabled).toBe(false);
  });

  it.each([
    { result: "failure", detailFormat: undefined },
    { result: "not a reply", detailFormat: undefined },
    { result: "failure", detailFormat: "code" as const },
    { result: "not a reply", detailFormat: "code" as const },
  ])(
    "does not change unrelated approvals after $result ($detailFormat)",
    async ({ result, detailFormat }) => {
      if (result === "failure") reviewRpc.approvals.review.mockRejectedValue(new Error("offline"));
      else reviewRpc.approvals.review.mockResolvedValue(null);
      await render({ ...block, text: "Run command?", detail: "echo hello", detailFormat });
      expect(container.textContent).toContain("Run command?");
      expect(container.textContent).toContain("echo hello");
      expect(container.querySelector('[role="status"]')).toBeNull();
      expect(button("Allow once").disabled).toBe(false);
      expect(button("Retry")).toBeUndefined();
    },
  );
});

describe("AskCard reply context and who acts", () => {
  const inquiryLines = Array.from({ length: 30 }, (_, index) => `Inquiry line ${index + 1}`);
  const inquiry = inquiryLines.join("\n");
  const draftCard = {
    kind: "ask",
    text: "Reply to Konstantin Grushko (#3529)?",
    status: "pending",
    inquiry,
    draft: "Hi Konstantin,\n\nYour licence is active again.",
    source: { ref: "zendesk:3529", version: "comment 98123" },
    actions: [
      { id: "choice-1", label: "Approve and send" },
      { id: "choice-2", label: "Don't reply" },
    ],
  } as unknown as AskBlock;
  const render = (block: AskBlock, botName: string | undefined = "Josy") =>
    renderToStaticMarkup(
      <AskCard block={block} botName={botName} canAnswer onAnswer={async () => {}} />,
    );
  const text = (html: string) => {
    const element = document.createElement("div");
    element.innerHTML = html;
    return element;
  };

  it("shows the whole customer inquiry above the draft, folded when long", () => {
    const card = text(render(draftCard));
    const shown = card.querySelector<HTMLElement>('[data-testid="ask-inquiry"]')!;
    // Nothing is cut: every line is in the DOM, only folded behind a fade.
    expect(shown.textContent).toBe(inquiry);
    expect(shown.getAttribute("dir")).toBe("auto");
    expect(shown.className).toContain("whitespace-pre-wrap");
    expect(shown.parentElement!.dataset.folded).toBe("true");
    expect(card.textContent).not.toContain("…");
    const sections = [...card.querySelectorAll("section")].map((s) => s.getAttribute("aria-label"));
    expect(sections).toEqual(["Customer inquiry", "Proposed reply"]);
    expect(card.textContent).toContain("Show all");
  });

  it("does not fold a short inquiry", () => {
    const card = text(render({ ...draftCard, inquiry: "Is my licence active?" } as AskBlock));
    expect(card.querySelector('[data-testid="ask-inquiry"]')!.parentElement!.dataset.folded).toBe(
      undefined,
    );
    expect(card.textContent).not.toContain("Show all");
  });

  it("toggles the folded inquiry with Show all and Show less", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(<AskCard block={draftCard} botName="Josy" canAnswer onAnswer={async () => {}} />),
    );
    const toggle = () =>
      [...container.querySelectorAll("button")].find((b) =>
        /^Show (all|less)$/.test(b.textContent!),
      )!;
    const fold = () => container.querySelector('[data-testid="ask-inquiry"]')!.parentElement!;
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    await act(async () => toggle().click());
    expect(toggle().textContent).toBe("Show less");
    expect(fold().dataset.folded).toBeUndefined();
    await act(async () => toggle().click());
    expect(toggle().textContent).toBe("Show all");
    expect(fold().dataset.folded).toBe("true");
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("labels the editable draft and names the source version", () => {
    const card = text(render(draftCard));
    const draft = card.querySelector('textarea[data-testid="ask-draft"]')!;
    expect(draft.getAttribute("aria-label")).toBe("Proposed reply");
    expect(card.querySelector('[data-testid="ask-source"]')?.textContent).toBe(
      "For zendesk:3529 · version comment 98123",
    );
  });

  it("shows the sent reply read-only once answered, folding a long one", () => {
    const long = Array.from({ length: 20 }, (_, index) => `Reply line ${index + 1}`).join("\n");
    const card = text(
      render({
        ...draftCard,
        status: "answered",
        answer: "choice-1",
        draftFinal: long,
      } as AskBlock),
    );
    const sent = card.querySelector<HTMLElement>('div[data-testid="ask-draft"]')!;
    expect(sent.textContent).toBe(long);
    expect(sent.parentElement!.dataset.folded).toBe("true");
    expect(card.textContent).toContain("Edited before answering");
    expect(card.querySelector('[data-testid="ask-who-acts"]')).toBeNull();
  });

  it("keeps a replaced card's reason", () => {
    const card = text(
      render({
        ...draftCard,
        status: "retired",
        retiredReason: "Replaced by a newer card for zendesk:3529",
      } as AskBlock),
    );
    expect(card.textContent).toContain("Replaced by a newer card for zendesk:3529");
    expect(card.querySelector('[data-testid="ask-who-acts"]')).toBeNull();
  });

  const whoActs = (html: string) =>
    text(html).querySelector('[data-testid="ask-who-acts"]')?.textContent;

  it("says who acts on a draft card and for which source", () => {
    expect(whoActs(render(draftCard))).toBe(
      "Josy gets your choice and the reply exactly as shown (with your edits); nothing is sent until Josy does it, for zendesk:3529.",
    );
    expect(whoActs(render({ ...draftCard, source: undefined } as AskBlock))).toBe(
      "Josy gets your choice and the reply exactly as shown (with your edits); nothing is sent until Josy does it.",
    );
  });

  it("says who acts on an ordinary question", () => {
    const question = {
      kind: "ask",
      text: "Which city?",
      status: "pending",
      actions: [{ id: "a", label: "Berlin" }],
    } as unknown as AskBlock;
    expect(whoActs(render(question))).toBe("Your choice goes to Josy, which continues with it.");
  });

  it("says who acts on an approval and titles each button with its effect", () => {
    const approval = {
      kind: "ask",
      text: "Send the email?",
      status: "pending",
      approvalEffectId: "effect-1",
      detail: "To: a@example.com",
      actions: [
        { id: "allow", label: "Allow" },
        { id: "always", label: "Always" },
        { id: "deny", label: "Deny" },
      ],
    } as unknown as AskBlock;
    const html = render(approval);
    expect(whoActs(html)).toBe(
      "Josy runs this only if you allow it. Allow once: this time only · Always allow: no card next time for this tool · Deny: nothing runs.",
    );
    const titles = [...text(html).querySelectorAll("button")].map((b) => [b.textContent, b.title]);
    expect(titles).toEqual([
      ["Allow once", "Runs this time only; asks again next time"],
      ["Always allow this tool", "Runs now and no card next time for this tool"],
      ["Deny", "Nothing runs"],
    ]);
  });

  it("says who acts on an instruction update", () => {
    const update = {
      kind: "ask",
      text: "Update?",
      status: "pending",
      approvalEffectId: "effect-2",
      instructionUpdate: { botId: "josy", before: "a", after: "b", reason: "r" },
      actions: [
        { id: "allow", label: "Allow" },
        { id: "deny", label: "Deny" },
      ],
    } as unknown as AskBlock;
    expect(whoActs(render(update))).toBe(
      "Apply changes Josy's instructions now · Edit first lets you change them · Dismiss keeps them as they are.",
    );
  });

  it("says who acts on a secret card", () => {
    const secret = {
      kind: "ask",
      text: "API key for the CRM?",
      status: "pending",
      input: "secret",
      purpose: "api_key",
      credential: {
        name: "CRM_KEY",
        origin: "https://crm.example.com",
        auth: { type: "bearer" },
      },
    } as unknown as AskBlock;
    expect(whoActs(render(secret))).toBe(
      "Saved encrypted for Josy to use at https://crm.example.com; never shown in chat.",
    );
  });

  it("says what the create-space buttons do", () => {
    const create = {
      kind: "ask",
      text: "Create the space Sales?",
      status: "pending",
      approvalEffectId: "effect-3",
      actions: [
        { id: "allow", label: "Create", outcome: "created" },
        { id: "deny", label: "Cancel", outcome: "cancelled" },
      ],
    } as unknown as AskBlock;
    expect(whoActs(render(create))).toBe(
      "Create space creates it now; Cancel leaves everything as is.",
    );
  });

  it("never calls anyone an operator or developer", () => {
    const html = [draftCard, { ...draftCard, status: "answered", answer: "choice-1" }].map(
      (block) =>
        renderToStaticMarkup(
          <AskCard block={block as AskBlock} canAnswer onAnswer={async () => {}} />,
        ),
    );
    for (const markup of html) expect(markup).not.toMatch(/operator|developer/i);
    // Without a bot name the line still reads as a sentence.
    expect(whoActs(html[0]!)).toMatch(/^The bot gets your choice/);
  });
});
