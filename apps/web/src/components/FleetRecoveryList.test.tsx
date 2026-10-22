// @vitest-environment jsdom
import type { MaintenanceRecoveryItem } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFleetRecovery } from "../lib/rpc";
import { FleetRecoveryList } from "./FleetRecoveryList";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values),
  }),
}));
vi.mock("../lib/rpc", () => ({ readFleetRecovery: vi.fn(), settleFleetRecovery: vi.fn() }));

function item(overrides: Partial<MaintenanceRecoveryItem>): MaintenanceRecoveryItem {
  return {
    kind: "effect",
    id: "effect-1",
    status: "uncertain",
    state: "unresolved",
    bot: "Jill",
    runId: "run-1",
    runStatus: "failed",
    operation: "shell",
    startedAt: null,
    lastEvidenceAt: null,
    evidence: "The shell started but its outcome is unknown.",
    proposed: null,
    missing: null,
    ownerVerifiable: true,
    caseRef: 383,
    caseUnknown: false,
    coordinator: "Josy",
    userActionNeeded: true,
    ...overrides,
  };
}

describe("FleetRecoveryList", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows each item's case, who follows it up, and whether it needs the user", async () => {
    vi.mocked(readFleetRecovery).mockResolvedValue({
      items: [
        item({}),
        item({
          id: "run-2",
          kind: "run",
          state: "draining",
          caseRef: null,
          coordinator: "Elena",
          ownerVerifiable: false,
          userActionNeeded: false,
        }),
        item({
          id: "run-3",
          kind: "run",
          state: "draining",
          caseRef: null,
          coordinator: null,
          ownerVerifiable: false,
          userActionNeeded: false,
        }),
        item({
          id: "run-4",
          kind: "run",
          state: "unresolved",
          caseRef: null,
          caseUnknown: true,
          coordinator: "Elena",
          ownerVerifiable: false,
          userActionNeeded: false,
        }),
      ],
    });
    await act(async () => {
      root.render(<FleetRecoveryList spaceId="space-1" version={0} onSettled={() => {}} />);
    });
    const lines = [...container.querySelectorAll('[data-testid="recovery-accountable"]')].map(
      (line) => line.textContent,
    );
    // Nothing to say, nothing shown: no line for an item no one needs to act on.
    // A Fleet wake that named no case says so instead of guessing one.
    expect(lines).toEqual([
      "Case 383 · Follow-up: Josy · Needs you",
      "Follow-up: Elena",
      "Case unknown · Follow-up: Elena",
    ]);
    // Every item is listed, the one with nothing to say included.
    expect(
      [...container.querySelectorAll("li")].map((li) => li.querySelector("p")?.textContent),
    ).toEqual([
      "shell · Jill · uncertain · Outcome unknown",
      "shell · Jill · uncertain · Finishing on its own",
      "shell · Jill · uncertain · Finishing on its own",
      "shell · Jill · uncertain · Outcome unknown",
    ]);
  });
});
