// @vitest-environment jsdom
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoutineLogFold } from "../lib/routine-log-folds";
import { RoutineLogFoldable } from "./RoutineLogRow";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce(
        (out, part, i) => out + part + (i < values.length ? String(values[i]) : ""),
        "",
      ),
    i18n: { locale: "en-GB" },
  }),
}));

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const fold: RoutineLogFold = {
  leaderId: "wake",
  routineName: "Tracker status",
  createdAt: "2026-10-19T08:05:00.000Z",
};

function Transcript({ folds }: { folds: Map<string, RoutineLogFold> }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      {["wake", "reply", "owner"].map((id) => {
        const messageFold = folds.get(id);
        if (messageFold && !expanded && messageFold.leaderId !== id) return null;
        return (
          <RoutineLogFoldable
            key={id}
            fold={messageFold}
            messageId={id}
            expanded={expanded}
            onToggle={() => setExpanded((open) => !open)}
          >
            <p data-testid="message">{id}</p>
          </RoutineLogFoldable>
        );
      })}
    </>
  );
}

const messages = () =>
  [...host.querySelectorAll('[data-testid="message"]')].map((node) => node.textContent);
const row = () => host.querySelector<HTMLButtonElement>('[data-testid="routine-log-row"]');

describe("RoutineLogFoldable", () => {
  it("renders a routine run folded to one row and expands it in place on click", async () => {
    const folds = new Map([
      ["wake", fold],
      ["reply", fold],
    ]);
    await act(async () => root.render(<Transcript folds={folds} />));

    expect(messages()).toEqual(["owner"]);
    expect(row()?.textContent).toMatch(/^Routine log · Tracker status · \S/);
    expect(row()?.getAttribute("aria-expanded")).toBe("false");

    await act(async () => row()?.click());
    expect(messages()).toEqual(["wake", "reply", "owner"]);
    expect(row()?.getAttribute("aria-expanded")).toBe("true");

    await act(async () => row()?.click());
    expect(messages()).toEqual(["owner"]);
  });

  it("leaves unfolded messages exactly as they render today", async () => {
    await act(async () => root.render(<Transcript folds={new Map()} />));
    expect(row()).toBeNull();
    expect(messages()).toEqual(["wake", "reply", "owner"]);
  });
});
