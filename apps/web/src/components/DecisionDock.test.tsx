// @vitest-environment jsdom
import type { PendingDecision } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rpc } from "../lib/rpc";
import { DecisionDock } from "./DecisionDock";

const { translate } = vi.hoisted(() => ({
  translate: (parts: TemplateStringsArray | { message: string }, ...values: unknown[]) =>
    "message" in parts ? parts.message : String.raw(parts, ...values),
}));
vi.mock("@lingui/core/macro", () => ({ t: translate }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: translate }),
}));
vi.mock("@rakazo/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children: ReactNode }) => <p>{children}</p>,
}));
vi.mock("@rakazo/ui-web", () => ({
  BotAvatar: () => null,
  Button: ({ children, ...props }: { children: ReactNode }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  Input: (props: Record<string, unknown>) => <input {...props} />,
  Textarea: (props: Record<string, unknown>) => <textarea {...props} />,
}));
vi.mock("../lib/rpc", () => ({
  rpc: { decisions: { list: vi.fn() }, threads: { answer: vi.fn() }, bots: {} },
}));

function decision(
  messageId: string,
  overrides: Partial<PendingDecision> & { createdAt: string },
): PendingDecision {
  return {
    messageId,
    runId: `run-${messageId}`,
    botId: "josy",
    botName: "Josy",
    groupId: null,
    threadId: "t-josy",
    block: {
      kind: "ask",
      text: `Question ${messageId}?`,
      status: "pending",
      actions: [
        { id: "yes", label: "Yes" },
        { id: "no", label: "No" },
      ],
    },
    ...overrides,
  };
}

const lilyOld = decision("lily-old", {
  botId: "lily",
  botName: "Lily",
  threadId: "t-lily",
  createdAt: "2026-10-20T08:00:00.000Z",
});
const josy = decision("josy-1", { createdAt: "2026-10-20T09:00:00.000Z" });
const roomCard = decision("room-1", {
  groupId: "room",
  threadId: "t-room",
  createdAt: "2026-10-20T10:00:00.000Z",
});

let container: HTMLDivElement;
let root: Root;
const onAnswered = vi.fn();
const onHeightChange = vi.fn();

async function render(
  currentThreadId: string | null,
  refreshKey = "0",
  focusRequest: { messageId: string; nonce: number } | null = null,
) {
  await act(async () => {
    root.render(
      <DecisionDock
        userId="user-1"
        currentThreadId={currentThreadId}
        refreshKey={refreshKey}
        focusRequest={focusRequest}
        bots={[]}
        groups={[{ id: "room", name: "Ops room" }]}
        onHeightChange={onHeightChange}
        onAnswered={onAnswered}
      />,
    );
  });
  await act(async () => {
    vi.runAllTimers();
  });
}

const query = (selector: string) => container.querySelector<HTMLElement>(selector);
const visibleCard = () =>
  [...container.querySelectorAll<HTMLElement>("[data-decision-id]")].filter(
    (element) => !element.hidden,
  );
const clickButton = (label: string) =>
  act(() => {
    [...visibleCard()[0]!.querySelectorAll("button")]
      .find((button) => button.textContent === label)
      ?.click();
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  vi.mocked(rpc.decisions.list).mockResolvedValue({ decisions: [lilyOld, josy, roomCard] });
  vi.mocked(rpc.threads.answer).mockReset();
  onAnswered.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("DecisionDock", () => {
  it("shows the open chat's card first, then the rest oldest first", async () => {
    await render("t-josy");
    expect(query('[data-testid="decision-dock-position"]')?.textContent).toBe("Decisions 1 of 3");
    expect(visibleCard()[0]?.dataset.decisionId).toBe("josy-1");
    act(() => query('button[aria-label="Next decision"]')?.click());
    expect(visibleCard()[0]?.dataset.decisionId).toBe("lily-old");
    act(() => query('button[aria-label="Next decision"]')?.click());
    expect(visibleCard()[0]?.dataset.decisionId).toBe("room-1");
    expect(query('[data-testid="decision-dock"]')?.textContent).toContain("Ops room");
  });

  it("starts at the open chat's first card once a fresh load knows the open chat", async () => {
    vi.mocked(rpc.decisions.list).mockResolvedValue({ decisions: [lilyOld, josy] });
    // The page loads before the route names the open chat: oldest card first.
    await render(null);
    expect(visibleCard()[0]?.dataset.decisionId).toBe("lily-old");
    await render("t-josy");
    expect(query('[data-testid="decision-dock-position"]')?.textContent).toBe("Decisions 1 of 2");
    expect(visibleCard()[0]?.dataset.decisionId).toBe("josy-1");
    // Opening another chat starts at that chat's first card, not the card shown before.
    await render("t-lily");
    expect(query('[data-testid="decision-dock-position"]')?.textContent).toBe("Decisions 1 of 2");
    expect(visibleCard()[0]?.dataset.decisionId).toBe("lily-old");
  });

  it("keeps the shown card when the list changes within the same chat", async () => {
    vi.mocked(rpc.decisions.list)
      .mockResolvedValueOnce({ decisions: [josy, roomCard] })
      .mockResolvedValue({ decisions: [lilyOld, josy, roomCard] });
    await render("t-josy");
    act(() => query('button[aria-label="Next decision"]')?.click());
    expect(visibleCard()[0]?.dataset.decisionId).toBe("room-1");
    await render("t-josy", "1");
    expect(visibleCard()[0]?.dataset.decisionId).toBe("room-1");
    expect(query('[data-testid="decision-dock-position"]')?.textContent).toBe("Decisions 3 of 3");
  });

  it("shows a chip's card even when it arrives with a chat switch", async () => {
    await render("t-josy");
    expect(visibleCard()[0]?.dataset.decisionId).toBe("josy-1");
    await render("t-room", "0", { messageId: "lily-old", nonce: 1 });
    expect(visibleCard()[0]?.dataset.decisionId).toBe("lily-old");
    expect(query('[data-testid="decision-dock-position"]')?.textContent).toBe("Decisions 2 of 3");
  });

  it("cycles with the arrow keys and keeps a half-typed answer while cycling", async () => {
    await render(null);
    expect(visibleCard()[0]?.dataset.decisionId).toBe("lily-old");
    clickButton("I'll type it");
    const input = visibleCard()[0]!.querySelector("input")!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "Only on Monday");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const dock = query('[data-testid="decision-dock"]')!;
    act(() => {
      dock.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(visibleCard()[0]?.dataset.decisionId).toBe("josy-1");
    act(() => {
      dock.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    expect(visibleCard()[0]?.dataset.decisionId).toBe("lily-old");
    expect(visibleCard()[0]!.querySelector("input")?.value).toBe("Only on Monday");
  });

  it("answers through the card's own chat, from any chat, and drops it", async () => {
    vi.mocked(rpc.threads.answer).mockResolvedValue({ ok: true } as never);
    vi.mocked(rpc.decisions.list)
      .mockResolvedValueOnce({ decisions: [roomCard, josy] })
      .mockResolvedValue({ decisions: [josy] });
    await render("t-lily");
    expect(visibleCard()[0]?.dataset.decisionId).toBe("josy-1");
    act(() => query('button[aria-label="Next decision"]')?.click());
    await act(async () => clickButton("Yes"));
    expect(rpc.threads.answer).toHaveBeenCalledWith({
      groupId: "room",
      runId: "run-room-1",
      messageId: "room-1",
      answer: "yes",
    });
    expect(onAnswered).toHaveBeenCalledWith(roomCard);
    expect(query('[data-testid="decision-dock-position"]')?.textContent).toBe("Decisions 1 of 1");
  });

  it("drops a card answered elsewhere quietly on CONFLICT", async () => {
    vi.mocked(rpc.threads.answer).mockRejectedValue({ code: "CONFLICT" });
    vi.mocked(rpc.decisions.list)
      .mockResolvedValueOnce({ decisions: [josy] })
      .mockResolvedValue({ decisions: [] });
    await render("t-josy");
    await act(async () => clickButton("Yes"));
    await act(async () => {
      vi.runAllTimers();
    });
    expect(query('[data-testid="decision-dock"]')).toBeNull();
    expect(container.textContent).not.toContain("Could not submit");
  });

  it("minimizes to a pill, remembers it per user, and announces new cards", async () => {
    vi.mocked(rpc.decisions.list)
      .mockResolvedValueOnce({ decisions: [josy] })
      .mockResolvedValue({ decisions: [josy, lilyOld] });
    await render("t-josy");
    act(() => query('button[aria-label="Minimize decisions"]')?.click());
    expect(query('[data-testid="decision-dock-pill"]')?.textContent).toBe("1 decision");
    expect(localStorage.getItem("rk:decision-dock:minimized:user-1")).toBe("1");
    await render("t-josy", "1");
    expect(query('[data-testid="decision-dock-pill"]')?.textContent).toBe("2 decisions");
    expect(query('[data-testid="decision-dock-announcer"]')?.textContent).toBe(
      "New decision from Lily",
    );
    act(() => query('[data-testid="decision-dock-pill"]')?.click());
    expect(query('[data-testid="decision-dock"]')).not.toBeNull();
    expect(localStorage.getItem("rk:decision-dock:minimized:user-1")).toBe("0");
  });

  it("starts as a pill on small screens", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    await render("t-josy");
    expect(query('[data-testid="decision-dock-pill"]')).not.toBeNull();
  });
});
