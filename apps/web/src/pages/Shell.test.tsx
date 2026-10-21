// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import type { AgentSkillCatalogEntry, ThreadMessage } from "@rakazo/contracts";
import type { ComposerMention } from "@rakazo/core";
import type { ComponentProps, ReactNode } from "react";
import { act, createRef } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

import { FleetPauseControls } from "../components/FleetPauseControls";
import { dictation } from "../lib/dictation";
import { Composer } from "./Shell";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let composerProps: ComponentProps<typeof Composer>;

beforeEach(() => {
  i18n.load("en", {});
  i18n.activate("en");
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  localStorage.clear();
});

const bob: ComposerMention = { kind: "bot", id: "bot-2", name: "Bob" };
const summarize: AgentSkillCatalogEntry = {
  id: "skill-1",
  name: "summarize",
  description: "Summarize a document",
  source: "user",
  readOnly: false,
};

function renderComposer(
  onSend: ComponentProps<typeof Composer>["onSend"],
  overrides: Partial<ComponentProps<typeof Composer>> = {},
) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // Reduced motion skips the chip-row resize animation, which jsdom cannot run.
  window.matchMedia ??= () =>
    ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    }) as unknown as MediaQueryList;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  composerProps = {
    artifactTarget: { botId: "bot-1" },
    activeName: "Ada",
    running: false,
    pendingAttachments: [],
    attachmentNotice: null,
    sendError: null,
    runError: null,
    runErrorId: null,
    onRunErrorPresented: () => {},
    onDismissError: () => {},
    sending: false,
    fileInputRef: createRef(),
    onAttachmentPick: () => true,
    onRemoveAttachment: () => {},
    onSend,
    onStop: async () => {},
    draftKey: "bot:bot-1",
    enterToSend: true,
    mentionTargets: [bob],
    agentSkills: [summarize],
    ...overrides,
  };
  rerenderComposer({});
  const textarea = container.querySelector("textarea");
  if (!textarea) throw new Error("composer textarea not found");
  return textarea;
}

function rerenderComposer(overrides: Partial<ComponentProps<typeof Composer>>) {
  composerProps = { ...composerProps, ...overrides };
  act(() => root?.render(<Composer {...composerProps} />));
}

it("shows a readable run error with raw details, while preserving send errors", () => {
  const runError = '429: {"message":"Too many requests","metadata":{"provider":"OpenRouter"}}';
  renderComposer(async () => true, { runError, runErrorId: "failed-run" });
  const error = container?.querySelector('[data-testid="composer-error"]');
  expect(error?.textContent).toContain(
    "Your OpenRouter is rate limiting requests. Try again shortly.",
  );
  const details = error?.querySelector("details");
  expect(details?.open).toBe(false);
  expect(details?.querySelector("summary")?.textContent).toBe("Details");
  act(() => details?.querySelector("summary")?.click());
  expect(details?.open).toBe(true);
  expect(details?.querySelector("pre")?.textContent).toBe(runError);

  rerenderComposer({ sendError: "Could not send the message." });
  expect(error?.textContent).toBe("Could not send the message.");
  expect(error?.querySelector("details")).toBeNull();
});

function pickAttachment() {
  const input = container?.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("attachment input not found");
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [new File(["notes"], "notes.txt", { type: "text/plain" })],
  });
  act(() => input.dispatchEvent(new Event("change", { bubbles: true })));
}

function type(textarea: HTMLTextAreaElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  act(() => {
    setValue?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function pressEnter(textarea: HTMLTextAreaElement) {
  act(() => {
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

describe("Composer", () => {
  it.each([false, true])(
    "keeps the keyboard mention selection when targets refresh (reorder: %s)",
    (reorder) => {
      const alice: ComposerMention = { kind: "bot", id: "bot-3", name: "Alice" };
      const textarea = renderComposer(vi.fn(), { mentionTargets: [alice, bob] });
      type(textarea, "@");
      act(() => {
        textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      });
      expect(container?.querySelector('[aria-selected="true"]')?.textContent).toContain("Bob");

      rerenderComposer({
        mentionTargets: reorder ? [{ ...bob }, { ...alice }] : [{ ...alice }, { ...bob }],
      });
      pressEnter(textarea);

      expect(container?.querySelector('[data-testid="mention-chip"]')?.textContent).toBe("Bob");
      expect(container?.querySelector('[data-testid="mention-picker"]')).toBeNull();
    },
  );

  it("falls back to the first mention when the highlighted target disappears", () => {
    const alice: ComposerMention = { kind: "bot", id: "bot-3", name: "Alice" };
    const textarea = renderComposer(vi.fn(), { mentionTargets: [alice, bob] });
    type(textarea, "@");
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });

    rerenderComposer({ mentionTargets: [alice] });
    pressEnter(textarea);

    expect(container?.querySelector('[data-testid="mention-chip"]')?.textContent).toBe("Alice");
  });

  it("clears the draft once the message is sent", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const textarea = renderComposer(onSend);
    type(textarea, "hello");
    pressEnter(textarea);
    await act(async () => {});
    expect(onSend).toHaveBeenCalledWith("hello", [], expect.any(String));
    expect(textarea.value).toBe("");
  });

  it("keeps the draft cleared when the send callback rejects", async () => {
    const onSend = vi
      .fn()
      .mockRejectedValueOnce(new Error("unknown outcome"))
      .mockResolvedValue(true);
    const textarea = renderComposer(onSend);
    type(textarea, "@Bo");
    pressEnter(textarea);
    type(textarea, "hello");
    pressEnter(textarea);
    await act(async () => {});
    expect(textarea.value).toBe("");
    expect(container?.querySelector("[data-testid='mention-chip']")).toBeNull();
    type(textarea, "another message");
    pressEnter(textarea);
    await act(async () => {});
    expect(onSend.mock.calls[1]?.[2]).not.toBe(onSend.mock.calls[0]?.[2]);
  });

  it("restores the draft and its mentions when the send fails", async () => {
    let finishSend = (_sent: boolean) => {};
    const onSend = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishSend = resolve;
        }),
    );
    const textarea = renderComposer(onSend);
    const mentionChips = () =>
      [...(container?.querySelectorAll("[data-testid='mention-chip']") ?? [])].map(
        (chip) => chip.textContent,
      );
    type(textarea, "@Bo");
    pressEnter(textarea);
    type(textarea, "hello");
    pressEnter(textarea);
    expect(onSend).toHaveBeenCalledWith("@Bob hello", [bob], expect.any(String));
    expect(textarea.value).toBe("");
    expect(mentionChips()).toEqual([]);
    await act(async () => finishSend(false));
    expect(textarea.value).toBe("hello");
    expect(mentionChips()).toEqual(["Bob"]);
  });

  it("restores the chosen skill when the send fails", async () => {
    let finishSend = (_sent: boolean) => {};
    const onSend = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishSend = resolve;
        }),
    );
    const textarea = renderComposer(onSend);
    const skillChip = () => container?.querySelector("[data-testid='skill-chip']")?.textContent;
    type(textarea, "/sum");
    act(() =>
      container?.querySelector<HTMLButtonElement>("button[aria-label='Skill summarize']")?.click(),
    );
    type(textarea, "the notes");
    pressEnter(textarea);
    expect(onSend).toHaveBeenCalledWith("/summarize\nthe notes", [], expect.any(String));
    expect(skillChip()).toBeUndefined();
    await act(async () => finishSend(false));
    expect(textarea.value).toBe("the notes");
    expect(skillChip()).toBe("summarize");
  });

  it("keeps a newer draft when an earlier send fails", async () => {
    let finishSend = (_sent: boolean) => {};
    const textarea = renderComposer(
      () =>
        new Promise<boolean>((resolve) => {
          finishSend = resolve;
        }),
    );
    type(textarea, "hello");
    pressEnter(textarea);
    type(textarea, "newer");
    await act(async () => finishSend(false));
    expect(textarea.value).toBe("newer");
  });

  it("does not restore after a newer draft was typed then cleared while sending", async () => {
    let finishSend = (_sent: boolean) => {};
    const textarea = renderComposer(
      () =>
        new Promise<boolean>((resolve) => {
          finishSend = resolve;
        }),
    );
    type(textarea, "hello");
    pressEnter(textarea);
    type(textarea, "newer");
    type(textarea, "");
    await act(async () => finishSend(false));
    expect(textarea.value).toBe("");
  });

  it("reuses the nonce on an unchanged retry but renews it after an edit", async () => {
    const onSend = vi.fn().mockResolvedValue(false);
    const textarea = renderComposer(onSend);
    type(textarea, "hello");
    pressEnter(textarea);
    await act(async () => {});
    pressEnter(textarea);
    await act(async () => {});
    const firstNonce = onSend.mock.calls[0]?.[2];
    expect(firstNonce).toEqual(expect.any(String));
    expect(onSend.mock.calls[1]?.[2]).toBe(firstNonce);
    type(textarea, "hello edited");
    type(textarea, "hello");
    pressEnter(textarea);
    await act(async () => {});
    expect(onSend.mock.calls[2]?.[2]).not.toBe(firstNonce);
  });

  it("does not restore after an attachment was picked while sending", async () => {
    let finishSend = (_sent: boolean) => {};
    const textarea = renderComposer(
      () =>
        new Promise<boolean>((resolve) => {
          finishSend = resolve;
        }),
    );
    type(textarea, "hello");
    pressEnter(textarea);
    pickAttachment();
    await act(async () => finishSend(false));
    expect(textarea.value).toBe("");
  });

  it("restores after a rejected attachment pick and preserves the nonce on rejected retry picks", async () => {
    let finishSend = (_sent: boolean) => {};
    const onSend = vi.fn<ComponentProps<typeof Composer>["onSend"]>(
      () =>
        new Promise<boolean>((resolve) => {
          finishSend = resolve;
        }),
    );
    const onAttachmentPick = vi.fn(() => false);
    const textarea = renderComposer(onSend, { onAttachmentPick });
    type(textarea, "hello");
    pressEnter(textarea);
    pickAttachment();
    await act(async () => finishSend(false));
    expect(textarea.value).toBe("hello");
    pickAttachment();
    pressEnter(textarea);
    await act(async () => finishSend(false));
    expect(onAttachmentPick).toHaveBeenCalledTimes(2);
    expect(onSend.mock.calls[1]?.[2]).toBe(onSend.mock.calls[0]?.[2]);
  });

  const reply: ThreadMessage = {
    id: "message-1",
    threadId: "thread-1",
    seq: 1,
    role: "bot",
    blocks: [{ kind: "text", text: "original reply" }],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const replyChanges = [
    { name: "cancelled reply", props: { replyTarget: null, replyQuote: null } },
    { name: "different reply", props: { replyTarget: { ...reply, id: "message-2" } } },
    { name: "different quote", props: { replyQuote: "different quote" } },
  ];

  it.each(replyChanges)("renews the retry nonce for a $name", async ({ props }) => {
    const onSend = vi.fn().mockResolvedValue(false);
    const textarea = renderComposer(onSend, { replyTarget: reply, replyQuote: "original" });
    type(textarea, "hello");
    pressEnter(textarea);
    await act(async () => {});
    rerenderComposer(props);
    pressEnter(textarea);
    await act(async () => {});
    expect(onSend.mock.calls[1]?.[2]).not.toBe(onSend.mock.calls[0]?.[2]);
  });

  it.each(replyChanges)("does not restore after a $name while sending", async ({ props }) => {
    let finishSend = (_sent: boolean) => {};
    const textarea = renderComposer(
      () =>
        new Promise<boolean>((resolve) => {
          finishSend = resolve;
        }),
      { replyTarget: reply, replyQuote: "original" },
    );
    type(textarea, "hello");
    pressEnter(textarea);
    rerenderComposer(props);
    await act(async () => finishSend(false));
    expect(textarea.value).toBe("");
  });

  it("preserves the retry nonce when the reply object refreshes without changing its ID or quote", async () => {
    const onSend = vi.fn().mockResolvedValue(false);
    const textarea = renderComposer(onSend, { replyTarget: reply, replyQuote: "original" });
    type(textarea, "hello");
    pressEnter(textarea);
    await act(async () => {});
    rerenderComposer({ replyTarget: { ...reply } });
    pressEnter(textarea);
    await act(async () => {});
    expect(onSend.mock.calls[1]?.[2]).toBe(onSend.mock.calls[0]?.[2]);
  });

  it("uses a fresh nonce for another message after a successful retry", async () => {
    const onSend = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const textarea = renderComposer(onSend);
    type(textarea, "hello");
    pressEnter(textarea);
    await act(async () => {});
    pressEnter(textarea);
    await act(async () => {});
    type(textarea, "hello");
    pressEnter(textarea);
    await act(async () => {});
    expect(onSend.mock.calls[1]?.[2]).toBe(onSend.mock.calls[0]?.[2]);
    expect(onSend.mock.calls[2]?.[2]).not.toBe(onSend.mock.calls[0]?.[2]);
  });

  it("restores an unsent draft when the composer remounts", () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const draftKey = "bot:draft-restore-test";
    const first = renderComposer(onSend, { draftKey });
    type(first, "unsent thought");
    expect(window.localStorage.getItem(`rakazo.composerDraft.${draftKey}`)).toBe("unsent thought");
    act(() => root?.unmount());
    container?.remove();
    const second = renderComposer(onSend, { draftKey });
    expect(second.value).toBe("unsent thought");
  });

  it("keeps Enter as newline and Ctrl+Enter as send when enter-to-send is off", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const textarea = renderComposer(onSend, {
      draftKey: "bot:enter-toggle-test",
      enterToSend: false,
    });
    expect(container?.querySelector('[data-testid="composer-enter-to-send-toggle"]')).toBeNull();
    type(textarea, "line one");
    pressEnter(textarea);
    await act(async () => {});
    expect(onSend).not.toHaveBeenCalled();
    act(() => {
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
      );
    });
    await act(async () => {});
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});

it.each([true, false])(
  "keeps a pending draft recoverable across unmount (accepted: %s)",
  async (accepted) => {
    let finishSend = (_accepted: boolean) => {};
    const onSend = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishSend = resolve;
        }),
    );
    const draftKey = "bot:pending-draft";
    const textarea = renderComposer(onSend, { draftKey });
    type(textarea, "pending text");
    pressEnter(textarea);
    expect(textarea.value).toBe("");
    expect(localStorage.getItem(`rakazo.composerDraft.${draftKey}`)).toBe("pending text");
    act(() => root?.unmount());
    container?.remove();
    await act(async () => finishSend(accepted));
    const restored = renderComposer(vi.fn(), { draftKey });
    expect(restored.value).toBe(accepted ? "" : "pending text");
  },
);

it.each([true, false])(
  "preserves newer stored edits when a send settles (accepted: %s)",
  async (accepted) => {
    let finishSend = (_accepted: boolean) => {};
    const textarea = renderComposer(
      () =>
        new Promise<boolean>((resolve) => {
          finishSend = resolve;
        }),
    );
    type(textarea, "submitted text");
    pressEnter(textarea);
    type(textarea, "newer text");
    await act(async () => finishSend(accepted));
    expect(textarea.value).toBe("newer text");
    expect(localStorage.getItem("rakazo.composerDraft.bot:bot-1")).toBe("newer text");
  },
);

it.each([true, false])(
  "settles a submission after returning to its thread (accepted: %s)",
  async (accepted) => {
    let finishSend = (_accepted: boolean) => {};
    const draftKey = "bot:return-before-settle";
    const first = renderComposer(
      () =>
        new Promise<boolean>((resolve) => {
          finishSend = resolve;
        }),
      { draftKey },
    );
    type(first, "submitted text");
    pressEnter(first);
    act(() => root?.unmount());
    container?.remove();
    const returned = renderComposer(vi.fn(), { draftKey });
    expect(returned.value).toBe("submitted text");
    await act(async () => finishSend(accepted));
    expect(returned.value).toBe(accepted ? "" : "submitted text");
    expect(localStorage.getItem(`rakazo.composerDraft.${draftKey}`)).toBe(
      accepted ? null : "submitted text",
    );
  },
);

it("preserves edits made after returning, even when the text matches the submission", async () => {
  let finishSend = (_accepted: boolean) => {};
  const draftKey = "bot:identical-newer-edit";
  const first = renderComposer(
    () =>
      new Promise<boolean>((resolve) => {
        finishSend = resolve;
      }),
    { draftKey },
  );
  type(first, "submitted text");
  pressEnter(first);
  act(() => root?.unmount());
  container?.remove();
  const returned = renderComposer(vi.fn(), { draftKey });
  type(returned, "edited text");
  type(returned, "submitted text");
  await act(async () => finishSend(true));
  expect(returned.value).toBe("submitted text");
  expect(localStorage.getItem(`rakazo.composerDraft.${draftKey}`)).toBe("submitted text");
});

it("clears accepted saved text when only an attachment was picked during the send", async () => {
  let finishSend = (_accepted: boolean) => {};
  const textarea = renderComposer(
    () =>
      new Promise<boolean>((resolve) => {
        finishSend = resolve;
      }),
  );
  type(textarea, "submitted text");
  pressEnter(textarea);
  pickAttachment();
  await act(async () => finishSend(true));
  expect(textarea.value).toBe("");
  expect(localStorage.getItem("rakazo.composerDraft.bot:bot-1")).toBeNull();
});

it.each([false, true])(
  "preserves dictation alongside a draft when sending fails (throws=%s)",
  async (throws) => {
    let finish!: (value: boolean) => void;
    let fail!: (error: Error) => void;
    const onSend = vi.fn(
      () =>
        new Promise<boolean>((resolve, reject) => {
          finish = resolve;
          fail = reject;
        }),
    );
    let onFinal!: (text: string) => void;
    const listen = vi.spyOn(dictation, "listen").mockImplementation(async (options) => {
      onFinal = options.onFinal;
    });
    try {
      const textarea = renderComposer(onSend, { phoneCallsEnabled: true });
      const mic = container?.querySelector<HTMLButtonElement>('button[aria-label="Hold to talk"]');
      expect(mic).not.toBeNull();
      act(() => mic?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })));
      act(() => onFinal("dictated words"));
      type(textarea, "typed draft");
      await act(async () => {
        if (throws) fail(new Error("offline"));
        else finish(false);
      });
      expect(textarea.value).toBe("typed draft dictated words");
    } finally {
      listen.mockRestore();
    }
  },
);

it("hides call dictation until the server enables it", () => {
  renderComposer(vi.fn().mockResolvedValue(true));
  expect(container?.querySelector('button[aria-label="Hold to talk"]')).toBeNull();
});

describe("Composer and waiting cards", () => {
  it("sends typed text as a normal message with no open-question line or confirm", async () => {
    // Cards wait in the decision dock and are answered there; composer text never answers one.
    const onSend = vi.fn().mockResolvedValue(true);
    const textarea = renderComposer(onSend);
    type(textarea, "I'll send it myself");
    pressEnter(textarea);
    await act(async () => {});
    expect(container?.querySelector('[data-testid="composer-open-ask"]')).toBeNull();
    expect(container?.querySelector('[data-testid="composer-answer-confirm"]')).toBeNull();
    expect(onSend).toHaveBeenCalledWith("I'll send it myself", [], expect.any(String));
  });
});

describe("Fleet pause controls", () => {
  const running = {
    state: { active: false, revision: 2 },
    status: { phase: "running", activeRuns: 0, activeEffects: 0, pendingRuns: 0, issues: [] },
  };
  const pausing = {
    state: { active: true, revision: 3 },
    status: {
      phase: "pausing", activeRuns: 2, activeEffects: 1, pendingRuns: 4,
      issues: ["Waiting for provider acknowledgement"],
    },
  };
  let fetchMock: Mock;
  const response = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    fetchMock = vi.fn().mockImplementation(async (_url, init) => response(init?.method === "POST"
      ? { state: pausing.state, replayed: false }
      : running));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function renderPause() {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<FleetPauseControls spaceId="space-a" />));
  }
  async function clickPauseControl(label: string) {
    const button = Array.from(document.querySelectorAll("button")).find(
      (element) => element.textContent === label,
    );
    expect(button, label).toBeDefined();
    await act(async () => button?.click());
  }
  const mutations = () => fetchMock.mock.calls.filter((call) => call[1]?.method === "POST");

  it.each([401, 403])("reads without mutating and hides controls on HTTP %s", async (status) => {
    fetchMock.mockImplementation(async () => response({}, status));
    await renderPause();
    expect(container?.querySelector("button")).toBeNull();
    expect(mutations()).toHaveLength(0);
  });

  it("shows blockers without claiming the fleet is paused and warns before force stop", async () => {
    fetchMock.mockImplementation(async (_url, init) => response(init?.method === "POST"
      ? { state: { active: true, revision: 4 }, replayed: false }
      : pausing));
    await renderPause();
    await clickPauseControl("Fleet: Pausing");
    expect(document.body.textContent).toContain("Active runs: 2");
    expect(document.body.textContent).toContain("Active effects: 1");
    expect(document.body.textContent).toContain("Queued/held runs: 4");
    expect(document.body.textContent).toContain("Waiting for provider acknowledgement");
    await clickPauseControl("Force stop…");
    expect(document.body.textContent).toContain("Already-started effects cannot be undone");
    expect(mutations()).toHaveLength(0);
    await clickPauseControl("Confirm force stop");
    expect(JSON.parse(mutations()[0]![1].body)).toEqual({
      action: "force-stop", expectedRevision: 3, requestId: expect.any(String),
    });
  });

  it("keeps the exact command identity after an ambiguous network failure", async () => {
    let failed = false;
    fetchMock.mockImplementation(async (_url, init) => {
      if (init?.method === "POST") {
        if (!failed) {
          failed = true;
          throw new TypeError("Network disconnected");
        }
        return response({ state: pausing.state, replayed: true });
      }
      return response(failed ? pausing : running);
    });
    await renderPause();
    await clickPauseControl("Fleet: Running");
    await clickPauseControl("Pause Fleet");
    expect(document.body.textContent).toContain("Outcome unknown");
    await clickPauseControl("Retry request");
    expect(mutations()).toHaveLength(2);
    expect(mutations()[1]![1].body).toBe(mutations()[0]![1].body);
    expect(mutations()[0]![1].credentials).toBe("same-origin");
    expect(new Headers(mutations()[0]![1].headers).get("x-rakazo-space-id")).toBe("space-a");
    expect(document.body.textContent).not.toContain("Outcome unknown");
    expect(document.body.textContent).not.toContain("Retry request");
  });

  it("refreshes a conflict without replaying it and gives the next intent a new identity", async () => {
    let conflict = false;
    fetchMock.mockImplementation(async (_url, init) => {
      if (init?.method === "POST") {
        conflict = true;
        return response({}, 409);
      }
      return response(conflict ? pausing : running);
    });
    await renderPause();
    await clickPauseControl("Fleet: Running");
    await clickPauseControl("Pause Fleet");
    expect(document.body.textContent).toContain("Fleet changed");
    expect(document.body.textContent).toContain("Pausing");
    expect(mutations()).toHaveLength(1);
    await clickPauseControl("Resume Fleet");
    const first = JSON.parse(mutations()[0]![1].body);
    const second = JSON.parse(mutations()[1]![1].body);
    expect(second.expectedRevision).toBe(3);
    expect(second.requestId).not.toBe(first.requestId);
    expect(second.action).toBe("resume");
  });

  it("marks failed refreshes as stale and disables new actions", async () => {
    await renderPause();
    await clickPauseControl("Fleet: Running");
    fetchMock.mockImplementation(async () => response({}, 503));
    await clickPauseControl("Refresh status");
    expect(document.body.textContent).toContain("Status unavailable");
    const pause = Array.from(document.querySelectorAll("button")).find(
      (element) => element.textContent === "Pause Fleet",
    );
    expect(pause?.disabled).toBe(true);
    expect(mutations()).toHaveLength(0);
  });

  it("does not treat stored pause intent or contradictory quiescence as effective status", async () => {
    fetchMock.mockImplementation(async () => response({ state: { active: true, revision: 3 } }));
    await renderPause();
    expect(container?.textContent).toContain("Fleet status unavailable");
    expect(container?.querySelector("button")).toBeNull();
    fetchMock.mockImplementation(async () => response({
      ...pausing, status: { ...pausing.status, phase: "paused" },
    }));
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(container?.textContent).toContain("Fleet status unavailable");
    expect(mutations()).toHaveLength(0);
  });

  it("removes already-visible controls if the command is no longer authorized", async () => {
    await renderPause();
    await clickPauseControl("Fleet: Running");
    fetchMock.mockImplementation(async () => response({}, 403));
    await clickPauseControl("Pause Fleet");
    expect(container?.querySelector("button")).toBeNull();
    expect(document.body.textContent).not.toContain("Resume Fleet");
    expect(document.body.textContent).not.toContain("Retry request");
  });

  it("allows only one in-flight command despite repeated clicks", async () => {
    let finish!: (value: Response) => void;
    fetchMock.mockImplementation(async (_url, init) => init?.method === "POST"
      ? new Promise<Response>((resolve) => { finish = resolve; })
      : response(running));
    await renderPause();
    await clickPauseControl("Fleet: Running");
    const pause = Array.from(document.querySelectorAll("button")).find(
      (element) => element.textContent === "Pause Fleet",
    )!;
    await act(async () => {
      pause.click();
      pause.click();
    });
    expect(mutations()).toHaveLength(1);
    await act(async () => finish(response({ state: pausing.state, replayed: false })));
    expect(mutations()).toHaveLength(1);
  });

  it("retains the exact request when HTTP success contains no durable acknowledgement", async () => {
    fetchMock.mockImplementation(async (_url, init) => response(init?.method === "POST"
      ? {}
      : running));
    await renderPause();
    await clickPauseControl("Fleet: Running");
    await clickPauseControl("Pause Fleet");
    expect(document.body.textContent).toContain("Outcome unknown");
    expect(document.body.textContent).toContain("Retry request");
    fetchMock.mockImplementation(async (_url, init) => response(init?.method === "POST"
      ? { state: pausing.state, replayed: true }
      : pausing));
    await clickPauseControl("Retry request");
    expect(mutations()).toHaveLength(2);
    expect(mutations()[1]![1].body).toBe(mutations()[0]![1].body);
    expect(document.body.textContent).not.toContain("Outcome unknown");
    expect(document.body.textContent).not.toContain("Retry request");
    expect(document.body.textContent).toContain("Fleet: Pausing");
  });

  it("requires a new force-stop confirmation after a revision changes", async () => {
    fetchMock.mockImplementation(async () => response(pausing));
    await renderPause();
    await clickPauseControl("Fleet: Pausing");
    await clickPauseControl("Force stop…");
    fetchMock.mockImplementation(async () => response({
      state: { active: true, revision: 4 },
      status: { ...pausing.status, phase: "needs_attention" },
    }));
    await clickPauseControl("Refresh status");
    await clickPauseControl("Confirm force stop");
    expect(document.body.textContent).toContain("Fleet changed");
    expect(document.body.textContent).toContain("Needs attention");
    expect(mutations()).toHaveLength(0);
  });

  it("shows paused with pending work without resuming or discarding it", async () => {
    fetchMock.mockImplementation(async () => response({
      state: { active: true, revision: 3 },
      status: { phase: "paused", activeRuns: 0, activeEffects: 0, pendingRuns: 4, issues: [] },
    }));
    await renderPause();
    await clickPauseControl("Fleet: Paused");
    expect(document.body.textContent).toContain("Queued/held runs: 4");
    expect(document.body.textContent).toContain("Resume Fleet");
    expect(mutations()).toHaveLength(0);
  });

  it("offers a separately confirmed force stop while Fleet is running", async () => {
    await renderPause();
    await clickPauseControl("Fleet: Running");
    await clickPauseControl("Force stop…");
    expect(mutations()).toHaveLength(0);
    await clickPauseControl("Confirm force stop");
    expect(JSON.parse(mutations()[0]![1].body)).toEqual({
      action: "force-stop", expectedRevision: 2, requestId: expect.any(String),
    });
  });
});
