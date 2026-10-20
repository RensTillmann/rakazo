// @vitest-environment jsdom

import { FLAG_NOTE_MAX_LENGTH, type PendingDecision } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FleetFeedback, type FleetFeedbackContext, fleetFeedbackContext } from "./FleetFeedback";

const api = vi.hoisted(() => ({
  flagTarget: vi.fn(),
  flag: vi.fn(),
  send: vi.fn(),
  selected: "space-a",
}));
vi.mock("../lib/rpc", () => ({
  createSpaceRpc: () => ({
    threads: { flagTarget: api.flagTarget, flag: api.flag, send: api.send },
  }),
  selectedSpaceId: () => api.selected,
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, i) => text + part + (values[i] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
      <button type="button" {...props} />
    ),
    Dialog: Pass,
    DialogContent: Pass,
    DialogDescription: Pass,
    DialogFooter: Pass,
    DialogHeader: Pass,
    DialogTitle: Pass,
    Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
  };
});

let host: HTMLDivElement;
let root: Root;
let open: boolean;
let context: FleetFeedbackContext;
const configuredTarget = {
  botId: "learning-bot-a",
  botName: "Learning",
  label: "Forward to Learning",
};
const anchoredContext = {
  page: "https://fleet.example/app/bot-a",
  botId: "bot-a",
  messageId: "message-a",
  effectId: "effect-a",
};
async function render() {
  await act(async () =>
    root.render(
      <MemoryRouter>
        <FleetFeedback
          open={open}
          spaceId="space-a"
          context={context}
          onClose={() => {
            open = false;
          }}
        />
      </MemoryRouter>,
    ),
  );
}
async function type(value: string) {
  const textarea = host.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      textarea,
      value,
    );
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () =>
    host
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}
async function click(label: string) {
  await act(async () =>
    Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent === label)!
      .click(),
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.selected = "space-a";
  api.flagTarget.mockResolvedValue(configuredTarget);
  api.send.mockResolvedValue({});
  api.flag.mockResolvedValue({ botId: configuredTarget.botId });
  context = { page: "https://fleet.example/app/bot-a", botId: "bot-a" };
  open = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("blocks feedback when the configured target is unavailable without losing the draft", async () => {
  api.flagTarget.mockResolvedValue(null);
  await render();
  await type("  Keep my exact draft.\nSecond line.  ");
  await submit();
  expect(host.querySelector("[role=alert]")?.textContent).toContain("configured feedback target");
  expect(host.querySelector("textarea")?.value).toBe("  Keep my exact draft.\nSecond line.  ");
  expect(api.send).not.toHaveBeenCalled();
  expect(api.flag).not.toHaveBeenCalled();
});

it("preserves a failed draft through closing and reopening, then confirms a retry without navigation", async () => {
  api.send.mockRejectedValueOnce(new Error("Connection lost"));
  await render();
  await type("  The decision needs context.\nPlease improve it.  ");
  await submit();
  expect(host.querySelector("[role=alert]")?.textContent).toContain("Connection lost");
  await click("Close (keep draft)");
  await render();
  expect(host.querySelector("textarea")).toBeNull();
  open = true;
  await render();
  expect(host.querySelector("textarea")?.value).toBe(
    "  The decision needs context.\nPlease improve it.  ",
  );
  await submit();
  expect(host.querySelector("[role=status]")?.textContent).toContain("Sent to Elena.");
  expect(host.querySelector("a")?.getAttribute("href")).toBe("/app/learning-bot-a");
  expect(api.send.mock.calls[1]![0].clientNonce).toBe(api.send.mock.calls[0]![0].clientNonce);
  expect(api.send.mock.calls[1]![0].botId).toBe(configuredTarget.botId);
  expect(api.send.mock.calls[1]![0].text).toContain(
    "\n\n  The decision needs context.\nPlease improve it.  \n\n",
  );
  expect(open).toBe(true);
});

it("does not send if the Space changes while resolving the configured target", async () => {
  await render();
  await type("Wrong-space sends must be blocked.");
  let resolve!: (target: typeof configuredTarget) => void;
  const promise = new Promise<typeof configuredTarget>((done) => {
    resolve = done;
  });
  api.flagTarget.mockReturnValueOnce(promise);
  await submit();
  api.selected = "space-b";
  await act(async () => resolve(configuredTarget));
  expect(api.send).not.toHaveBeenCalled();
  expect(api.flag).not.toHaveBeenCalled();
  expect(host.querySelector("[role=alert]")?.textContent).toContain("Space changed");
  expect(host.querySelector("textarea")?.value).toBe("Wrong-space sends must be blocked.");
});

it("keeps the draft and its original Space when another tab switches before reopening", async () => {
  await render();
  await type("Keep this Space A draft.");
  await click("Close (keep draft)");
  await render();
  api.selected = "space-b";
  open = true;
  await render();
  await submit();
  expect(api.send).not.toHaveBeenCalled();
  expect(api.flag).not.toHaveBeenCalled();
  expect(host.querySelector("[role=alert]")?.textContent).toContain("Space changed");
  expect(host.querySelector("textarea")?.value).toBe("Keep this Space A draft.");
  expect(host.querySelector("pre")?.textContent).toContain("spaceId: space-a");
});

it("rejects a configured target that becomes unavailable after opening", async () => {
  await render();
  await type("Please investigate this card.");
  api.flagTarget.mockResolvedValue(null);
  await submit();
  expect(api.send).not.toHaveBeenCalled();
  expect(host.querySelector("[role=alert]")?.textContent).toContain("configured feedback target");
});

it("uses native message flag provenance and preserves the user's description verbatim", async () => {
  context = { ...anchoredContext, groupId: "group-a" };
  await render();
  const description = "  Exact description.\nFinal spaces.  ";
  await type(description);
  await submit();
  expect(api.send).not.toHaveBeenCalled();
  expect(api.flag.mock.calls[0]![0]).toMatchObject({ groupId: "group-a", messageId: "message-a" });
  expect(api.flag.mock.calls[0]![0]).not.toHaveProperty("botId");
  expect(api.flag.mock.calls[0]![0].note).toContain(`\n\n${description}\n\n`);
  expect(api.flag.mock.calls[0]![0].note).toContain("effectId: effect-a");
});

it("validates the complete native flag note without truncating the description", async () => {
  context = anchoredContext;
  await render();
  const description = "x".repeat(FLAG_NOTE_MAX_LENGTH);
  await type(description);
  await submit();
  expect(api.flag).not.toHaveBeenCalled();
  expect(api.send).not.toHaveBeenCalled();
  expect(host.querySelector("textarea")?.value).toBe(description);
  expect(host.querySelector("[role=alert]")?.textContent).toContain("2000 characters");
});

it("does not silently retarget a failed draft when another decision opens", async () => {
  context = anchoredContext;
  api.flag.mockRejectedValueOnce(new Error("Connection lost"));
  await render();
  await type("This report belongs to card A.");
  await submit();
  await click("Close (keep draft)");
  await render();
  context = { ...anchoredContext, messageId: "message-b", effectId: "effect-b" };
  open = true;
  await render();
  expect(host.querySelector("textarea")?.value).toBe("This report belongs to card A.");
  expect(host.querySelector("pre")?.textContent).toContain("messageId: message-a");
  expect(host.textContent).toContain("original context");
  await submit();
  expect(api.flag.mock.calls[1]![0].messageId).toBe("message-a");
});

it("requires explicit discard before starting a report for another decision", async () => {
  context = anchoredContext;
  await render();
  await type("Old card draft.");
  await click("Close (keep draft)");
  await render();
  context = { ...anchoredContext, messageId: "message-b" };
  open = true;
  await render();
  await click("Discard draft and start new report");
  expect(host.querySelector("textarea")?.value).toBe("");
  expect(host.querySelector("pre")?.textContent).toContain("messageId: message-b");
  await type("New card draft.");
  await submit();
  expect(api.flag.mock.calls[0]![0].messageId).toBe("message-b");
});

it("uses a fresh nonce if the description changes after a failed send", async () => {
  api.send.mockRejectedValueOnce(new Error("Connection lost"));
  await render();
  await type("Original draft.");
  await submit();
  await type("Edited draft.");
  await submit();
  expect(api.send.mock.calls[1]![0].clientNonce).not.toBe(api.send.mock.calls[0]![0].clientNonce);
});

it("includes only safe references, never secret card contents or URL credentials", () => {
  window.history.replaceState({}, "", "/app/bot-a?token=sensitive#password");
  const decision = {
    botId: "bot-a",
    groupId: null,
    messageId: "message-a",
    runId: "run-a",
    threadId: "thread-a",
    block: {
      kind: "ask",
      input: "secret",
      text: "private body",
      answer: "customer-password",
      credential: { password: "never-copy" },
      detail: "Ticket: 42\nPassword: hidden",
      approvalEffectId: "effect-a",
    },
  } as unknown as PendingDecision;
  const refs = fleetFeedbackContext(decision);
  expect(refs).toMatchObject({ messageId: "message-a", effectId: "effect-a", ticket: "42" });
  expect(refs.page).not.toMatch(/[?#]/);
  expect(JSON.stringify(refs)).not.toMatch(/sensitive|password|private body|never-copy|hidden/);
});
