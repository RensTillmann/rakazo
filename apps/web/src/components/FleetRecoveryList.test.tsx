// @vitest-environment jsdom
import type { MaintenanceRecoveryItem } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
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
      ],
    });
    await act(async () => {
      root.render(<FleetRecoveryList spaceId="space-1" version={0} onSettled={() => {}} />);
    });
    const lines = [...container.querySelectorAll('[data-testid="recovery-accountable"]')].map(
      (line) => line.textContent,
    );
    expect(lines).toEqual([
      "Case 383 · Follow-up: Josy · Needs you",
      "Follow-up: Elena · Nothing for you to do",
    ]);
  });
});
