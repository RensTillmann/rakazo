// @vitest-environment jsdom
import type { UserTodo } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rpc } from "../lib/rpc";
import { TODO_UNDO_MS, TodoChecklist, TodosSidebarButton, UserTodosProvider } from "./TodosControl";

const { translate } = vi.hoisted(() => ({
  translate: (parts: TemplateStringsArray | { message: string }, ...values: unknown[]) =>
    "message" in parts ? parts.message : String.raw(parts, ...values),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: translate,
    i18n: { date: (date: Date) => date.toISOString().slice(0, 16) },
  }),
}));
vi.mock("@rakazo/ui-web", async () => {
  // vi.mock factories are hoisted above the file's static imports, so React is loaded here.
  const { createContext, useContext } = await import("react");
  const Toggle = createContext<() => void>(() => {});
  return {
    Popover: ({
      open,
      onOpenChange,
      children,
    }: {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      children: ReactNode;
    }) => <Toggle.Provider value={() => onOpenChange(!open)}>{children}</Toggle.Provider>,
    PopoverTrigger: ({ children, ...props }: { children: ReactNode }) => (
      <button type="button" {...props} onClick={useContext(Toggle)}>
        {children}
      </button>
    ),
    PopoverContent: ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div>,
  };
});
vi.mock("../lib/rpc", () => ({
  rpc: { todos: { list: vi.fn(), check: vi.fn(), confirm: vi.fn() } },
}));

function todo(id: string, overrides: Partial<UserTodo> = {}): UserTodo {
  return {
    id,
    botId: "josy",
    botName: "Josy",
    threadId: "t-josy",
    groupId: "card-1",
    groupTitle: "Set up the mail domain?",
    release: "all",
    requirementKey: `key-${id}`,
    title: `Title ${id}`,
    steps: "1. Open settings\n2. Turn it on",
    why: null,
    caseNumber: null,
    blocks: [],
    priority: null,
    position: 0,
    verification: "automatic",
    status: "open",
    statusDetail: null,
    evidence: null,
    revision: 3,
    checkRequestedAt: null,
    checkedAt: null,
    createdAt: "2026-10-21T08:00:00.000Z",
    updatedAt: "2026-10-21T08:00:00.000Z",
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;
const onFeedback = vi.fn();

const flush = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

async function mount(todos: UserTodo[], children: ReactNode) {
  vi.mocked(rpc.todos.list).mockResolvedValue({ todos });
  await act(async () =>
    root.render(
      <UserTodosProvider scope="user-1:primary" enabled onFeedback={onFeedback}>
        {children}
      </UserTodosProvider>,
    ),
  );
  await flush();
}

const sidebarButton = () =>
  container.querySelector<HTMLButtonElement>('[data-testid="todos-sidebar-button"]');

async function openPanel(todos: UserTodo[], rail = false) {
  await mount(todos, <TodosSidebarButton rail={rail} />);
  await click(sidebarButton()!);
}

const row = (id: string) => container.querySelector<HTMLElement>(`[data-todo-id="${id}"]`);
const box = (id: string) =>
  container.querySelector<HTMLInputElement>(
    `input[type="checkbox"][aria-label="Mark “Title ${id}” as done"]`,
  )!;
const boxState = (id: string) => row(id)!.querySelector<HTMLElement>("[data-box]")!.dataset.box;
const titleButton = (id: string) =>
  row(id)!.querySelector<HTMLButtonElement>('button[aria-label="Show how"]')!;
const secondary = (id: string) =>
  row(id)?.querySelector('[data-testid="todo-secondary"]')?.textContent ?? null;
const group = (title: string) =>
  container.querySelector<HTMLElement>(`section[aria-label="${title}"]`)!;
const buttonNamed = (scope: ParentNode, text: string) =>
  [...scope.querySelectorAll("button")].find((b) => b.textContent === text);
const doneRow = () =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Done ("))!;
const renderedIds = () =>
  [...container.querySelectorAll<HTMLElement>("[data-todo-id]")].map((li) => li.dataset.todoId);

async function click(element: HTMLElement) {
  await act(async () => element.click());
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.mocked(rpc.todos.list).mockReset();
  vi.mocked(rpc.todos.check).mockReset();
  vi.mocked(rpc.todos.confirm).mockReset();
  onFeedback.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("To-dos sidebar button", () => {
  it("is hidden while there are no to-dos", async () => {
    await mount([], <TodosSidebarButton rail={false} />);
    expect(sidebarButton()).toBeNull();
  });

  it("badges the open count and opens the grouped panel", async () => {
    await mount(
      [
        todo("a"),
        todo("b", { status: "checking" }),
        todo("c", { status: "remaining", statusDetail: "x" }),
        todo("d", { status: "unavailable", statusDetail: "y" }),
        todo("e", { status: "verified" }),
        todo("f", { status: "retired" }),
      ],
      <TodosSidebarButton rail={false} />,
    );
    const button = sidebarButton()!;
    expect(button.querySelector('[data-testid="todos-badge"]')?.textContent).toBe("4");
    expect(button.getAttribute("aria-label")).toBe("To-dos, 4 open");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await click(button);
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain("Title a");
  });

  it("shows only the square with its badge in the collapsed avatar rail", async () => {
    await openPanel([todo("a"), todo("b")], true);
    const button = sidebarButton()!;
    expect(button.title).toBe("To-dos, 2 open");
    expect(button.querySelector(".sr-only")?.textContent).toBe("To-dos");
    expect(button.querySelector('[data-testid="todos-badge"]')?.textContent).toBe("2");
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });
});

describe("To-dos panel", () => {
  it("heads each card's group with bot, wrapped topic, and progress", async () => {
    const topic = "Set up rakazo.dev so outgoing mail passes SPF, DKIM and DMARC?";
    await openPanel([
      todo("a", { status: "verified", groupTitle: topic }),
      todo("b", { status: "confirmed", verification: "manual", groupTitle: topic }),
      todo("c", { groupTitle: topic }),
      todo("d", { status: "retired", groupTitle: topic }),
      todo("x", { groupId: "card-2", groupTitle: "Connect the CRM?", botName: "Lily" }),
    ]);
    const mail = group(topic);
    const label = mail.querySelector("header p")!;
    expect(label.textContent).toBe(`Josy · ${topic}`);
    expect(label.getAttribute("title")).toBe(`Josy · ${topic}`);
    expect(label.className).toContain("line-clamp-2");
    expect(mail.querySelector('[data-testid="todo-progress"]')?.textContent).toBe("2/3");
    expect(
      group("Connect the CRM?").querySelector('[data-testid="todo-progress"]')?.textContent,
    ).toBe("0/1");
  });

  it("keeps the server's order, also while an item is being checked", async () => {
    const delivered = [
      todo("z", { groupId: "card-9", groupTitle: "Newest blocking card", botName: "Lily" }),
      todo("m", { groupId: "card-9", groupTitle: "Newest blocking card", botName: "Lily" }),
      todo("b", { groupId: "card-1" }),
      todo("a", { groupId: "card-1", status: "remaining", statusDetail: "r" }),
    ];
    await openPanel(delivered);
    expect(renderedIds()).toEqual(["z", "m", "b", "a"]);
    vi.mocked(rpc.todos.check).mockResolvedValue({ todo: todo("m", { status: "checking" }) });
    vi.mocked(rpc.todos.list).mockResolvedValue({
      todos: delivered.map((item) => (item.id === "m" ? { ...item, status: "checking" } : item)),
    });
    await click(box("m"));
    await advance(TODO_UNDO_MS);
    expect(boxState("m")).toBe("checking");
    expect(renderedIds()).toEqual(["z", "m", "b", "a"]);
  });

  it("adds one short muted line only where it matters", async () => {
    await openPanel([
      todo("open"),
      todo("checking", { status: "checking" }),
      todo("remaining", { status: "remaining", statusDetail: "needs 6.3.727, found 6.3.725" }),
      todo("unavailable", { status: "unavailable", statusDetail: "No HubSpot read tool" }),
    ]);
    expect(secondary("open")).toBeNull();
    expect(secondary("checking")).toBe("checking…");
    expect(secondary("remaining")).toBe("still missing: needs 6.3.727, found 6.3.725");
    expect(secondary("unavailable")).toBe("couldn't check — tick again to retry");
    expect(
      row("unavailable")!.querySelector<HTMLElement>('[data-testid="todo-secondary"]')!.title,
    ).toBe("No HubSpot read tool");
  });

  it("draws unchecked, checked, checking (spinner only), and retired (⊘, struck) boxes", async () => {
    await openPanel([
      todo("open"),
      todo("checking", { status: "checking" }),
      todo("verified", { status: "verified" }),
      todo("confirmed", { status: "confirmed", verification: "manual" }),
      todo("retired", { status: "retired", statusDetail: "Plan changed" }),
    ]);
    await click(doneRow());
    expect(boxState("open")).toBe("unchecked");
    expect(box("open").disabled).toBe(false);
    expect(box("open").className).toContain("focus-visible:ring-2");
    expect(box("open").className).toContain("enabled:hover:border-primary");

    expect(boxState("checking")).toBe("checking");
    expect(box("checking").disabled).toBe(true);
    expect(box("checking").indeterminate).toBe(true);
    // Only the spinner shows: the box outline is visually hidden.
    expect(box("checking").className).toBe("sr-only");
    expect(row("checking")!.querySelector("[data-box] svg.animate-spin")).not.toBeNull();

    expect([boxState("verified"), box("verified").checked, box("verified").disabled]).toEqual([
      "checked",
      true,
      true,
    ]);
    expect(row("confirmed")!.textContent).toContain("(you)");
    expect(row("verified")!.textContent).not.toContain("(you)");

    expect(boxState("retired")).toBe("retired");
    expect(row("retired")!.querySelector('input[type="checkbox"]')).toBeNull();
    expect(row("retired")!.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
      "No longer needed",
    );
    expect(titleButton("retired").firstElementChild!.className).toContain("line-through");
    expect(secondary("retired")).toBe("no longer needed");
  });

  it("sends nothing during the undo window, and Undo cancels it", async () => {
    await openPanel([todo("a", { revision: 7 })]);
    await click(box("a"));
    expect(boxState("a")).toBe("countdown");
    expect(row("a")!.querySelector("[data-box] svg.animate-spin")).toBeNull();
    expect(row("a")!.querySelector("[data-box] svg circle animate")).not.toBeNull();
    await advance(TODO_UNDO_MS - 1);
    expect(rpc.todos.check).not.toHaveBeenCalled();
    await click(buttonNamed(row("a")!, "Undo")!);
    expect(boxState("a")).toBe("unchecked");
    expect(buttonNamed(row("a")!, "Undo")).toBeUndefined();
    await advance(TODO_UNDO_MS * 2);
    expect(rpc.todos.check).not.toHaveBeenCalled();
    expect(rpc.todos.confirm).not.toHaveBeenCalled();
  });

  it("unticking the box during the window also cancels", async () => {
    await openPanel([todo("a")]);
    await click(box("a"));
    await click(box("a"));
    expect(boxState("a")).toBe("unchecked");
    await advance(TODO_UNDO_MS * 2);
    expect(rpc.todos.check).not.toHaveBeenCalled();
  });

  it("asks the bot to check after the window, with a spinner until it answers", async () => {
    await openPanel([todo("a", { revision: 7 })]);
    let finish!: (value: { todo: UserTodo }) => void;
    vi.mocked(rpc.todos.check).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }) as never,
    );
    await click(box("a"));
    await advance(TODO_UNDO_MS);
    expect(rpc.todos.check).toHaveBeenCalledWith({ todoId: "a", revision: 7 });
    expect(rpc.todos.confirm).not.toHaveBeenCalled();
    expect(boxState("a")).toBe("checking");
    expect(box("a").className).toBe("sr-only");
    expect(buttonNamed(row("a")!, "Undo")).toBeUndefined();
    vi.mocked(rpc.todos.list).mockResolvedValue({
      todos: [todo("a", { status: "remaining", statusDetail: "_dmarc missing", revision: 9 })],
    });
    await act(async () => finish({ todo: todo("a", { status: "checking", revision: 8 }) }));
    await flush();
    expect(boxState("a")).toBe("unchecked");
    expect(secondary("a")).toBe("still missing: _dmarc missing");
  });

  it("retries an item the bot couldn't check by ticking it again", async () => {
    await openPanel([todo("a", { status: "unavailable", statusDetail: "u", revision: 5 })]);
    vi.mocked(rpc.todos.check).mockResolvedValue({ todo: todo("a", { status: "checking" }) });
    await click(box("a"));
    await advance(TODO_UNDO_MS);
    expect(rpc.todos.check).toHaveBeenCalledWith({ todoId: "a", revision: 5 });
  });

  it("confirms a manual item after the window and shows it ticked as the user's word", async () => {
    await openPanel([todo("m", { verification: "manual", revision: 2 })]);
    let finish!: (value: { todo: UserTodo }) => void;
    vi.mocked(rpc.todos.confirm).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }) as never,
    );
    await click(box("m"));
    expect(rpc.todos.confirm).not.toHaveBeenCalled();
    await advance(TODO_UNDO_MS);
    expect(rpc.todos.confirm).toHaveBeenCalledWith({ todoId: "m", revision: 2 });
    expect(rpc.todos.check).not.toHaveBeenCalled();
    expect([boxState("m"), box("m").disabled]).toEqual(["checked", true]);
    expect(row("m")!.textContent).toContain("(you)");
    await act(async () => finish({ todo: todo("m", { status: "confirmed" }) }));
  });

  it("never toggles from the title or status line; they open the details", async () => {
    await openPanel([todo("a", { status: "remaining", statusDetail: "SPF lacks mailgun" })]);
    expect(row("a")!.querySelector('[data-testid="todo-details"]')).toBeNull();
    await click(row("a")!.querySelector<HTMLElement>('[data-testid="todo-secondary"]')!);
    expect(titleButton("a").getAttribute("aria-expanded")).toBe("true");
    expect(row("a")!.querySelector('[data-testid="todo-details"]')).not.toBeNull();
    await click(titleButton("a").firstElementChild as HTMLElement);
    expect(row("a")!.querySelector('[data-testid="todo-details"]')).toBeNull();
    await advance(TODO_UNDO_MS * 2);
    expect(boxState("a")).toBe("unchecked");
    expect(rpc.todos.check).not.toHaveBeenCalled();
  });

  it("opens why, numbered steps, who checks it, chips, and feedback", async () => {
    await openPanel([
      todo("a", {
        why: "Mailgun rejects mail without it.",
        caseNumber: "3536",
        evidence: "dig TXT shows v=spf1 -all",
        checkedAt: "2026-10-21T09:15:00.000Z",
      }),
      todo("m", { verification: "manual" }),
    ]);
    await click(titleButton("a"));
    const opened = row("a")!.querySelector<HTMLElement>('[data-testid="todo-details"]')!;
    expect([...opened.children].map((child) => child.textContent)).toEqual([
      "Mailgun rejects mail without it.",
      "Open settingsTurn it on",
      "Josy checks it when you tick the box",
      "Case 3536asked 2026-10-21T08:00",
      "Feedback to Elena",
    ]);
    expect([...opened.querySelectorAll("ol > li")].map((li) => li.textContent)).toEqual([
      "Open settings",
      "Turn it on",
    ]);
    expect(opened.title).toBe("dig TXT shows v=spf1 -all\nChecked 2026-10-21T09:15");
    expect(opened.textContent).not.toContain("unblocks");
    await click(buttonNamed(opened, "Feedback to Elena")!);
    expect(onFeedback).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));

    await click(titleButton("m"));
    const manual = row("m")!.querySelector<HTMLElement>('[data-testid="todo-details"]')!;
    expect(manual.querySelector('[data-testid="todo-why"]')).toBeNull();
    expect(manual.querySelector('[data-testid="todo-checker"]')?.textContent).toBe(
      "You confirm this one",
    );
    expect(
      [...manual.querySelectorAll('[data-testid="todo-chips"] > span')].map((c) => c.textContent),
    ).toEqual(["asked 2026-10-21T08:00"]);
  });

  it("offers feedback for the whole list in the panel header", async () => {
    await openPanel([todo("a")]);
    const header = container.querySelector('[role="dialog"] h2')!.parentElement!;
    await click(buttonNamed(header, "Feedback to Elena")!);
    expect(onFeedback).toHaveBeenCalledWith(null);
  });

  it("does not repeat the reason under the title inside the opened item", async () => {
    await openPanel([
      todo("r", { status: "remaining", statusDetail: "needs 6.3.727, found 6.3.725" }),
      todo("u", { status: "unavailable", statusDetail: "No HubSpot read tool" }),
    ]);
    await click(titleButton("r"));
    await click(titleButton("u"));
    expect(row("r")!.textContent!.split("needs 6.3.727, found 6.3.725")).toHaveLength(2);
    expect(row("u")!.textContent).not.toContain("No HubSpot read tool");
  });

  it("shows a red blocks chip per entry only while the item is unfinished", async () => {
    await openPanel([
      todo("a", { blocks: ["deploy", "#412"] }),
      todo("c", { status: "checking", blocks: ["deploy"] }),
      todo("v", { status: "verified", blocks: ["deploy"] }),
      todo("r", { status: "retired", blocks: ["deploy"] }),
    ]);
    await click(doneRow());
    const chips = (id: string) =>
      [...row(id)!.querySelectorAll('[data-testid="todo-blocks"]')].map((c) => c.textContent);
    expect(chips("a")).toEqual(["blocks deploy", "blocks #412"]);
    expect(row("a")!.querySelector('[data-testid="todo-blocks"]')!.className).toContain(
      "text-destructive",
    );
    expect(chips("c")).toEqual(["blocks deploy"]);
    expect(chips("v")).toEqual([]);
    expect(chips("r")).toEqual([]);
    expect(container.textContent).not.toContain("unblocks");
  });

  it("folds finished items of every group into one Done row at the bottom, grouped", async () => {
    await openPanel([
      todo("a"),
      todo("v", { status: "verified" }),
      todo("c", { status: "confirmed", verification: "manual" }),
      todo("r", { status: "retired", statusDetail: "Plan changed" }),
      todo("x", { groupId: "card-2", groupTitle: "Connect the CRM?", botName: "Lily" }),
      todo("y", {
        groupId: "card-2",
        groupTitle: "Connect the CRM?",
        botName: "Lily",
        status: "verified",
      }),
      todo("z", {
        groupId: "card-3",
        groupTitle: "Rotate the API key?",
        botName: "Lily",
        status: "confirmed",
        verification: "manual",
      }),
    ]);
    const folds = [...container.querySelectorAll("button")].filter((b) =>
      b.textContent?.startsWith("Done ("),
    );
    expect(folds).toHaveLength(1);
    const fold = folds[0]!;
    expect(fold.closest(".overflow-y-auto")!.lastElementChild!.contains(fold)).toBe(true);
    expect(fold.textContent).toBe("Done (5) ▸");
    expect(renderedIds()).toEqual(["a", "x"]);
    expect(container.querySelectorAll('section[aria-label="Rotate the API key?"]')).toHaveLength(0);
    await click(fold);
    expect(fold.textContent).toBe("Done (5) ▾");
    const done = container.querySelector<HTMLElement>('[data-testid="todo-done"]')!;
    expect(
      [...done.querySelectorAll<HTMLElement>("section")].map((section) => [
        section.querySelector("p")!.getAttribute("title"),
        [...section.querySelectorAll<HTMLElement>("[data-todo-id]")].map((li) => li.dataset.todoId),
      ]),
    ).toEqual([
      ["Josy · Set up the mail domain?", ["v", "c", "r"]],
      ["Lily · Connect the CRM?", ["y"]],
      ["Lily · Rotate the API key?", ["z"]],
    ]);
  });

  it("explains a stale to-do and shows the refreshed state", async () => {
    await openPanel([todo("a", { revision: 1 }), todo("b")]);
    vi.mocked(rpc.todos.check).mockRejectedValue({ code: "CONFLICT" });
    vi.mocked(rpc.todos.list).mockResolvedValue({
      todos: [todo("a", { status: "checking", revision: 2 }), todo("b")],
    });
    await click(box("a"));
    await advance(TODO_UNDO_MS);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "This to-do changed; refreshed.",
    );
    expect(boxState("a")).toBe("checking");
  });
});

describe("Answered card checklist", () => {
  it("shows only the card's items, sharing one fetch with the panel", async () => {
    await mount(
      [
        todo("a", { groupId: "msg-1" }),
        todo("b", { groupId: "msg-1", status: "verified" }),
        todo("x", { groupId: "msg-2" }),
      ],
      <>
        <TodosSidebarButton rail={false} />
        <TodoChecklist messageId="msg-1" />
        <TodoChecklist messageId="msg-3" />
      </>,
    );
    expect(rpc.todos.list).toHaveBeenCalledTimes(1);
    const lists = container.querySelectorAll('[data-testid="todo-checklist"]');
    expect(lists).toHaveLength(1);
    expect(lists[0]!.textContent).toContain("To-dos 1/2");
    expect(renderedIds()).toEqual(["a", "b"]);
    expect(boxState("b")).toBe("checked");
    vi.mocked(rpc.todos.check).mockResolvedValue({ todo: todo("a", { status: "checking" }) });
    await click(box("a"));
    expect(boxState("a")).toBe("countdown");
    await advance(TODO_UNDO_MS);
    expect(rpc.todos.check).toHaveBeenCalledWith({ todoId: "a", revision: 3 });
  });

  it("renders nothing without the shared provider", async () => {
    await act(async () => root.render(<TodoChecklist messageId="msg-1" />));
    expect(container.innerHTML).toBe("");
  });
});
