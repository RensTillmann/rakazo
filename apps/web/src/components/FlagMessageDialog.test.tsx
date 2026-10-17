// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FlagMessageDialog } from "./FlagMessageDialog";

const flag = vi.hoisted(() => vi.fn());
vi.mock("../lib/rpc", () => ({ rpc: { threads: { flag } } }));
vi.mock("../lib/client-id", () => ({ newClientId: () => "nonce-1" }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
      <button type="button" {...props} />
    ),
    Dialog: Pass,
    DialogContent: ({ children }: { children?: ReactNode; initialFocus?: unknown }) => (
      <div>{children}</div>
    ),
    DialogDescription: Pass,
    DialogFooter: Pass,
    DialogHeader: Pass,
    DialogTitle: Pass,
    Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
  };
});

let host: HTMLDivElement;
let root: Root;
const onClose = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.matchMedia = vi.fn(() => ({ matches: false })) as unknown as typeof window.matchMedia;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () =>
    root.render(
      <FlagMessageDialog
        flag={{ botId: "bot-elena", botName: "Elena", label: "Needs fleet improvement…" }}
        thread={{ botId: "bot-josy" }}
        messageId="msg-1"
        onClose={onClose}
      />,
    ),
  );
}

async function type(text: string) {
  const note = host.querySelector("textarea")!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(note, text);
    note.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(label: string) {
  const button = Array.from(host.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === label,
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

it("sends the message and the note to the flag bot, then confirms", async () => {
  flag.mockResolvedValue({ botId: "bot-elena" });
  await render();
  expect(host.textContent).toContain("Needs fleet improvement…");
  await type("  Options were not checked on mobile.  ");
  await click("Send");
  expect(flag).toHaveBeenCalledWith({
    botId: "bot-josy",
    messageId: "msg-1",
    note: "Options were not checked on mobile.",
    clientNonce: "nonce-1",
  });
  expect(host.textContent).toContain("Sent to Elena.");
  await click("Done");
  expect(onClose).toHaveBeenCalled();
});

it("sends without a note", async () => {
  flag.mockResolvedValue({ botId: "bot-elena" });
  await render();
  await click("Send");
  expect(flag).toHaveBeenCalledWith(expect.objectContaining({ note: undefined }));
});

it("keeps the dialog open with the error when sending fails", async () => {
  flag.mockRejectedValue(new Error("Flagging messages is not set up."));
  await render();
  await click("Send");
  expect(host.querySelector("[role=alert]")?.textContent).toBe("Flagging messages is not set up.");
  expect(onClose).not.toHaveBeenCalled();
  expect(host.querySelector("textarea")).not.toBeNull();
});
