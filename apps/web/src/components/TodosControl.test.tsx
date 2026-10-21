// @vitest-environment jsdom
import type { UserTodo } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rpc } from "../lib/rpc";
import { TodosControl } from "./TodosControl";

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
vi.mock("@rakazo/ui-web", () => {
  const Pass = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return {
    Button: ({ children, ...props }: { children: ReactNode }) => (
      <button type="button" {...props}>
        {children}
      </button>
    ),
    Dialog: ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div>,
    DialogContent: Pass,
    DialogDescription: Pass,
    DialogHeader: Pass,
    DialogTitle: Pass,
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

const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

async function render(todos: UserTodo[]) {
  vi.mocked(rpc.todos.list).mockResolvedValue({ todos });
  await act(async () => root.render(<TodosControl />));
  await flush();
}

const headerButton = () => container.querySelector("button");
const row = (id: string) => container.querySelector<HTMLElement>(`[data-todo-id="${id}"]`);
const box = (id: string) =>
  container.querySelector<HTMLInputElement>(
    `input[type="checkbox"][aria-label="Mark 'Title ${id}' as done"]`,
  )!;
/** The box's accessible state: `mixed` while pending. */
const boxState = (id: string) =>
  box(id).indeterminate ? "mixed" : box(id).checked ? "checked" : "unchecked";
const secondary = (id: string) =>
  row(id)?.querySelector('[data-testid="todo-secondary"]')?.textContent ?? null;
const group = (title: string) =>
  container.querySelector<HTMLElement>(`section[aria-label="${title}"]`)!;
const doneRow = () =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Done ("))!;

async function click(element: HTMLElement) {
  await act(async () => element.click());
  await flush();
}

async function openDialog() {
  await click(headerButton()!);
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.mocked(rpc.todos.list).mockReset();
  vi.mocked(rpc.todos.check).mockReset();
  vi.mocked(rpc.todos.confirm).mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("TodosControl", () => {
  it("renders nothing when there are no to-dos", async () => {
    await render([]);
    expect(container.innerHTML).toBe("");
  });

  it("counts only the to-dos the user can still act on", async () => {
    await render([
      todo("a"),
      todo("b", { status: "checking" }),
      todo("c", { status: "remaining", statusDetail: "x" }),
      todo("d", { status: "unavailable", statusDetail: "y" }),
      todo("e", { status: "verified" }),
      todo("f", { status: "confirmed", verification: "manual" }),
      todo("g", { status: "retired" }),
    ]);
    expect(headerButton()?.textContent).toBe("To-dos: 4");
  });

  it("stays visible without a count when only settled to-dos remain", async () => {
    await render([todo("e", { status: "verified" })]);
    expect(headerButton()?.textContent).toBe("To-dos");
  });

  it("heads each card's group with bot, wrapped topic, and progress", async () => {
    const topic = "Set up rakazo.dev so outgoing mail passes SPF, DKIM and DMARC?";
    await render([
      todo("a", { status: "verified", groupTitle: topic }),
      todo("b", { status: "confirmed", verification: "manual", groupTitle: topic }),
      todo("c", { groupTitle: topic }),
      todo("d", { status: "retired", groupTitle: topic }),
      todo("x", { groupId: "card-2", groupTitle: "Connect the CRM?", botName: "Lily" }),
    ]);
    await openDialog();
    const mail = group(topic);
    const label = mail.querySelector("header p")!;
    expect(label.textContent).toBe(`Josy · ${topic}`);
    expect(label.getAttribute("title")).toBe(`Josy · ${topic}`);
    expect(label.className).toContain("line-clamp-2");
    expect(mail.querySelector('[data-testid="todo-progress"]')?.textContent).toBe("2/3");
    const crm = group("Connect the CRM?");
    expect(crm.querySelector("header p")?.getAttribute("title")).toBe("Lily · Connect the CRM?");
    expect(crm.querySelector('[data-testid="todo-progress"]')?.textContent).toBe("0/1");
  });

  it("shows one line per item with a clipped title and the full title as tooltip", async () => {
    const long = "Add the DKIM record for the k1 selector in Cloudflare";
    await render([todo("a", { title: long })]);
    await openDialog();
    const title = container.querySelector<HTMLButtonElement>('button[aria-label="Show how"]')!;
    expect(title.textContent).toBe("Add the DKIM record for the k1 selector…");
    expect(title.title).toBe(long);
    expect(container.textContent).not.toContain("Open settings");
  });

  it("adds one short muted line only where it matters", async () => {
    await render([
      todo("open"),
      todo("checking", { status: "checking" }),
      todo("remaining", {
        status: "remaining",
        statusDetail: "needs 6.3.727, found 6.3.725",
      }),
      todo("unavailable", { status: "unavailable", statusDetail: "No HubSpot read tool" }),
    ]);
    await openDialog();
    expect(secondary("open")).toBeNull();
    expect(secondary("checking")).toBe("checking…");
    expect(secondary("remaining")).toBe("still missing: needs 6.3.727, found 6.3.725");
    expect(secondary("unavailable")).toBe("couldn't check — tick again to retry");
    expect(
      row("unavailable")!.querySelector<HTMLElement>('[data-testid="todo-secondary"]')!.title,
    ).toBe("No HubSpot read tool");
  });

  it("shows each box unchecked, pending, or checked, and only unchecked ones are tickable", async () => {
    await render([
      todo("open"),
      todo("remaining", { status: "remaining", statusDetail: "r" }),
      todo("unavailable", { status: "unavailable", statusDetail: "u" }),
      todo("manual", { verification: "manual" }),
      todo("checking", { status: "checking" }),
      todo("verified", { status: "verified" }),
      todo("confirmed", { status: "confirmed", verification: "manual" }),
    ]);
    await openDialog();
    await click(doneRow());
    const state = (id: string) => [boxState(id), box(id).disabled];
    expect(state("open")).toEqual(["unchecked", false]);
    expect(state("remaining")).toEqual(["unchecked", false]);
    expect(state("unavailable")).toEqual(["unchecked", false]);
    expect(state("manual")).toEqual(["unchecked", false]);
    expect(state("checking")).toEqual(["mixed", true]);
    expect(state("verified")).toEqual(["checked", true]);
    expect(state("confirmed")).toEqual(["checked", true]);
    expect(row("confirmed")!.textContent).toContain("(you)");
    expect(row("verified")!.textContent).not.toContain("(you)");
  });

  it("asks the bot to check an automatic item, shows it pending, then the verified result", async () => {
    await render([todo("a", { revision: 7 })]);
    await openDialog();
    let finish!: (value: { todo: UserTodo }) => void;
    vi.mocked(rpc.todos.check).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }) as never,
    );
    await click(box("a"));
    expect(rpc.todos.check).toHaveBeenCalledWith({ todoId: "a", revision: 7 });
    expect(rpc.todos.confirm).not.toHaveBeenCalled();
    expect([boxState("a"), box("a").disabled]).toEqual(["mixed", true]);
    await click(box("a"));
    expect(rpc.todos.check).toHaveBeenCalledTimes(1);
    vi.mocked(rpc.todos.list).mockResolvedValue({
      todos: [todo("a", { status: "verified", evidence: "SPF found", revision: 9 })],
    });
    await act(async () => finish({ todo: todo("a", { status: "checking", revision: 8 }) }));
    await flush();
    // Finished items fold away under the list's Done row.
    expect(row("a")).toBeNull();
    await click(doneRow());
    expect([boxState("a"), box("a").disabled]).toEqual(["checked", true]);
  });

  it("unticks with the reason when the bot finds the item still missing, and retries", async () => {
    await render([todo("a", { revision: 2 })]);
    await openDialog();
    vi.mocked(rpc.todos.check).mockResolvedValue({ todo: todo("a", { status: "checking" }) });
    vi.mocked(rpc.todos.list).mockResolvedValue({
      todos: [todo("a", { status: "remaining", statusDetail: "_dmarc missing", revision: 4 })],
    });
    await click(box("a"));
    expect(boxState("a")).toBe("unchecked");
    expect(secondary("a")).toBe("still missing: _dmarc missing");
    await click(box("a"));
    expect(rpc.todos.check).toHaveBeenLastCalledWith({ todoId: "a", revision: 4 });
  });

  it("retries an item the bot couldn't check by ticking it again", async () => {
    await render([todo("a", { status: "unavailable", statusDetail: "u", revision: 5 })]);
    await openDialog();
    vi.mocked(rpc.todos.check).mockResolvedValue({ todo: todo("a", { status: "checking" }) });
    await click(box("a"));
    expect(rpc.todos.check).toHaveBeenCalledWith({ todoId: "a", revision: 5 });
  });

  it("ticks a manual item at once as the user's word", async () => {
    await render([todo("m", { verification: "manual", revision: 2 })]);
    await openDialog();
    let finish!: (value: { todo: UserTodo }) => void;
    vi.mocked(rpc.todos.confirm).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }) as never,
    );
    await click(box("m"));
    expect(rpc.todos.confirm).toHaveBeenCalledWith({ todoId: "m", revision: 2 });
    expect(rpc.todos.check).not.toHaveBeenCalled();
    expect([boxState("m"), box("m").disabled]).toEqual(["checked", true]);
    expect(row("m")!.textContent).toContain("(you)");
    vi.mocked(rpc.todos.list).mockResolvedValue({
      todos: [todo("m", { verification: "manual", status: "confirmed", revision: 3 })],
    });
    await act(async () => finish({ todo: todo("m", { status: "confirmed" }) }));
    await flush();
    await click(doneRow());
    expect(boxState("m")).toBe("checked");
  });

  it("opens why, numbered steps, who checks it, and chips from the title", async () => {
    await render([
      todo("a", {
        why: "Mailgun rejects mail without it.",
        caseNumber: "3536",
        evidence: "dig TXT shows v=spf1 -all",
        checkedAt: "2026-10-21T09:15:00.000Z",
      }),
      todo("m", { verification: "manual" }),
    ]);
    await openDialog();
    const title = row("a")!.querySelector<HTMLButtonElement>('button[aria-label="Show how"]')!;
    expect(title.getAttribute("aria-expanded")).toBe("false");
    expect(row("a")!.querySelector('[data-testid="todo-details"]')).toBeNull();
    await click(title);
    expect(title.getAttribute("aria-expanded")).toBe("true");
    const opened = row("a")!.querySelector<HTMLElement>('[data-testid="todo-details"]')!;
    expect([...opened.children].map((child) => child.textContent)).toEqual([
      "Mailgun rejects mail without it.",
      "Open settingsTurn it on",
      "Josy checks it when you tick the box",
      "unblocks JosyCase 3536asked 2026-10-21T08:00",
    ]);
    expect([...opened.querySelectorAll("ol > li")].map((li) => li.textContent)).toEqual([
      "Open settings",
      "Turn it on",
    ]);
    expect(
      [...opened.querySelectorAll('[data-testid="todo-chips"] > span')].map((c) => c.textContent),
    ).toEqual(["unblocks Josy", "Case 3536", "asked 2026-10-21T08:00"]);
    // Evidence and timestamps only in the tooltip.
    expect(opened.title).toBe("dig TXT shows v=spf1 -all\nChecked 2026-10-21T09:15");
    expect(opened.textContent).not.toContain("dig TXT");
    expect(rpc.todos.check).not.toHaveBeenCalled();

    await click(row("m")!.querySelector<HTMLButtonElement>('button[aria-label="Show how"]')!);
    const manual = row("m")!.querySelector<HTMLElement>('[data-testid="todo-details"]')!;
    expect(manual.querySelector('[data-testid="todo-why"]')).toBeNull();
    expect(manual.querySelector('[data-testid="todo-checker"]')?.textContent).toBe(
      "You confirm this one",
    );
    expect(
      [...manual.querySelectorAll('[data-testid="todo-chips"] > span')].map((c) => c.textContent),
    ).toEqual(["unblocks Josy", "asked 2026-10-21T08:00"]);
    expect(manual.title).toBe("");

    await click(title);
    expect(row("a")!.querySelector('[data-testid="todo-details"]')).toBeNull();
  });

  it("does not repeat the reason under the title inside the opened item", async () => {
    await render([
      todo("r", { status: "remaining", statusDetail: "needs 6.3.727, found 6.3.725" }),
      todo("u", { status: "unavailable", statusDetail: "No HubSpot read tool" }),
    ]);
    await openDialog();
    for (const id of ["r", "u"]) {
      await click(row(id)!.querySelector<HTMLButtonElement>('button[aria-label="Show how"]')!);
    }
    expect(row("r")!.textContent!.split("needs 6.3.727, found 6.3.725")).toHaveLength(2);
    expect(row("u")!.textContent).not.toContain("No HubSpot read tool");
    expect(row("u")!.textContent!.split("couldn't check")).toHaveLength(2);
  });

  it("folds finished items of every group into one Done row at the bottom, grouped", async () => {
    await render([
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
    await openDialog();
    const folds = [...container.querySelectorAll("button")].filter((b) =>
      b.textContent?.startsWith("Done ("),
    );
    expect(folds).toHaveLength(1);
    const fold = folds[0]!;
    const list = fold.closest(".overflow-y-auto")!;
    expect(list.lastElementChild!.contains(fold)).toBe(true);
    expect(fold.textContent).toBe("Done (5) ▸");
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(
      [...container.querySelectorAll<HTMLElement>("[data-todo-id]")].map((li) => li.dataset.todoId),
    ).toEqual(["a", "x"]);
    // A group with nothing left to do only appears under Done.
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
    expect(secondary("r")).toBe("no longer needed");
    expect(row("r")!.querySelector<HTMLElement>('[data-testid="todo-secondary"]')!.title).toBe(
      "Plan changed",
    );
    expect(box("r").disabled).toBe(true);
  });

  it("explains a stale to-do and shows the refreshed state", async () => {
    await render([todo("a", { revision: 1 }), todo("b")]);
    await openDialog();
    vi.mocked(rpc.todos.check).mockRejectedValue({ code: "CONFLICT" });
    vi.mocked(rpc.todos.list).mockResolvedValue({
      todos: [todo("a", { status: "checking", revision: 2 }), todo("b")],
    });
    await click(box("a"));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "This to-do changed; refreshed.",
    );
    expect(boxState("a")).toBe("mixed");
    expect(secondary("a")).toBe("checking…");
  });
});
