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
  useLingui: () => ({ t: translate }),
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
const box = (id: string) =>
  container.querySelector<HTMLInputElement>(`input[type="checkbox"][aria-label="Title ${id}"]`)!;
/** The checkbox's accessible checked state: `mixed` while pending. */
const checkState = (id: string) =>
  box(id).indeterminate ? "mixed" : box(id).checked ? "true" : "false";
const status = (id: string) =>
  container.querySelector(`[data-todo-id="${id}"] [role="status"]`)!.textContent;
const group = (title: string) =>
  container.querySelector<HTMLElement>(`section[aria-label="${title}"]`)!;

async function openDialog() {
  await act(async () => headerButton()!.click());
  await flush();
}

async function tick(id: string) {
  await act(async () => box(id).click());
  await flush();
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

  it("groups to-dos by card with the bot and how many are done, ignoring retired ones", async () => {
    await render([
      todo("a", { status: "verified" }),
      todo("b", { status: "confirmed", verification: "manual" }),
      todo("c"),
      todo("d", { status: "retired" }),
      todo("x", { groupId: "card-2", groupTitle: "Connect the CRM?", botName: "Lily" }),
    ]);
    await openDialog();
    const mail = group("Set up the mail domain?");
    expect(mail.textContent).toContain("Josy · 2 of 3 done");
    expect([...mail.querySelectorAll('input[type="checkbox"]')].map((b) => b.ariaLabel)).toEqual([
      "Title a",
      "Title b",
      "Title c",
      "Title d",
    ]);
    const crm = group("Connect the CRM?");
    expect(crm.textContent).toContain("Lily · 0 of 1 done");
    expect(crm.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
  });

  it("shows each item's full steps and a status line for every state", async () => {
    await render([
      todo("open"),
      todo("manual", { verification: "manual" }),
      todo("checking", { status: "checking" }),
      todo("verified", { status: "verified", evidence: "Setting is on since 09:12" }),
      todo("remaining", { status: "remaining", statusDetail: "Turn on 2FA" }),
      todo("unavailable", { status: "unavailable", statusDetail: "Bot lost access" }),
      todo("confirmed", { status: "confirmed", verification: "manual" }),
      todo("retired", { status: "retired", statusDetail: "Plan changed" }),
    ]);
    await openDialog();
    const steps = [...container.querySelectorAll('[data-todo-id="open"] p')].find((p) =>
      p.textContent?.startsWith("1."),
    )!;
    expect(steps.textContent).toBe("1. Open settings\n2. Turn it on");
    expect(steps.className).toContain("whitespace-pre-wrap");
    expect(status("open")).toBe("Tick when done; the bot checks it.");
    expect(status("manual")).toBe("Tick when you've done it.");
    expect(status("checking")).toBe("Checking…");
    expect(status("verified")).toBe("✓ VerifiedSetting is on since 09:12");
    expect(status("remaining")).toBe("Still to do: Turn on 2FA");
    expect(status("unavailable")).toBe("Couldn't check: Bot lost access");
    expect(status("confirmed")).toBe("✓ Confirmed by you");
    expect(status("retired")).toBe("No longer needed: Plan changed");
  });

  it("only shows a box ticked once the bot verified it or the user confirmed it", async () => {
    await render([
      todo("open"),
      todo("checking", { status: "checking" }),
      todo("verified", { status: "verified" }),
      todo("remaining", { status: "remaining", statusDetail: "r" }),
      todo("unavailable", { status: "unavailable", statusDetail: "u" }),
      todo("confirmed", { status: "confirmed", verification: "manual" }),
      todo("retired", { status: "retired" }),
      todo("manual", { verification: "manual", status: "remaining" }),
    ]);
    await openDialog();
    const state = (id: string) => [checkState(id), box(id).disabled];
    expect(state("open")).toEqual(["false", false]);
    expect(state("remaining")).toEqual(["false", false]);
    expect(state("unavailable")).toEqual(["false", false]);
    expect(state("manual")).toEqual(["false", false]);
    expect(state("checking")).toEqual(["mixed", true]);
    expect(state("verified")).toEqual(["true", true]);
    expect(state("confirmed")).toEqual(["true", true]);
    expect(state("retired")).toEqual(["false", true]);
  });

  it("asks the bot to check an automatic item with the seen revision and refreshes", async () => {
    await render([todo("a", { revision: 7 })]);
    await openDialog();
    const reads = vi.mocked(rpc.todos.list).mock.calls.length;
    vi.mocked(rpc.todos.check).mockResolvedValue({ todo: todo("a", { status: "checking" }) });
    vi.mocked(rpc.todos.list).mockResolvedValue({
      todos: [todo("a", { status: "checking", revision: 8 })],
    });
    await tick("a");
    expect(rpc.todos.check).toHaveBeenCalledWith({ todoId: "a", revision: 7 });
    expect(rpc.todos.confirm).not.toHaveBeenCalled();
    expect(vi.mocked(rpc.todos.list).mock.calls.length).toBeGreaterThan(reads);
    expect(checkState("a")).toBe("mixed");
  });

  it("lets the user re-tick an item the bot found still to do", async () => {
    await render([todo("a", { status: "remaining", statusDetail: "Add SPF", revision: 4 })]);
    await openDialog();
    vi.mocked(rpc.todos.check).mockResolvedValue({ todo: todo("a", { status: "checking" }) });
    await tick("a");
    expect(rpc.todos.check).toHaveBeenCalledWith({ todoId: "a", revision: 4 });
  });

  it("records the user's word for a manual item", async () => {
    await render([todo("m", { verification: "manual", revision: 2 })]);
    await openDialog();
    vi.mocked(rpc.todos.confirm).mockResolvedValue({
      todo: todo("m", { verification: "manual", status: "confirmed" }),
    });
    vi.mocked(rpc.todos.list).mockResolvedValue({
      todos: [todo("m", { verification: "manual", status: "confirmed", revision: 3 })],
    });
    await tick("m");
    expect(rpc.todos.confirm).toHaveBeenCalledWith({ todoId: "m", revision: 2 });
    expect(rpc.todos.check).not.toHaveBeenCalled();
    expect(checkState("m")).toBe("true");
    expect(status("m")).toBe("✓ Confirmed by you");
  });

  it("shows the ticked box as pending, not done, while the request runs", async () => {
    await render([todo("a"), todo("m", { verification: "manual" })]);
    await openDialog();
    let finish!: (value: { todo: UserTodo }) => void;
    vi.mocked(rpc.todos.check).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }) as never,
    );
    await tick("a");
    expect(checkState("a")).toBe("mixed");
    expect(box("a").disabled).toBe(true);
    expect(box("m").disabled).toBe(true);
    await act(async () => finish({ todo: todo("a", { status: "checking" }) }));
    await flush();
    expect(box("m").disabled).toBe(false);
  });

  it("explains a stale to-do and shows the refreshed state", async () => {
    await render([todo("a", { revision: 1 })]);
    await openDialog();
    vi.mocked(rpc.todos.check).mockRejectedValue({ code: "CONFLICT" });
    vi.mocked(rpc.todos.list).mockResolvedValue({
      todos: [todo("a", { status: "verified", evidence: "Done already", revision: 2 })],
    });
    await tick("a");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "This to-do changed; refreshed.",
    );
    expect(checkState("a")).toBe("true");
    expect(status("a")).toBe("✓ VerifiedDone already");
  });
});
