// @vitest-environment jsdom
import type { MaintenanceSnapshot } from "@rakazo/contracts";
import { maintenanceAttentionSentence } from "@rakazo/core";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFleetMaintenance, readFleetRecovery } from "../lib/rpc";
import { FleetPauseControls } from "./FleetPauseControls";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values),
  }),
}));
vi.mock("@rakazo/ui-web", () => {
  const Box = ({ children, className }: { children?: ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  );
  return {
    Button: ({
      children,
      onClick,
      disabled,
    }: {
      children: ReactNode;
      onClick?: () => void;
      disabled?: boolean;
    }) => (
      <button type="button" onClick={onClick} disabled={disabled}>
        {children}
      </button>
    ),
    Dialog: ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div>,
    DialogContent: Box,
    DialogDescription: Box,
    DialogFooter: ({ children, className }: { children: ReactNode; className?: string }) => (
      <footer className={className}>{children}</footer>
    ),
    DialogHeader: Box,
    DialogTitle: Box,
  };
});
vi.mock("../lib/rpc", () => ({
  FleetMaintenanceError: class extends Error {},
  readFleetMaintenance: vi.fn(),
  sendFleetMaintenance: vi.fn(),
  readFleetRecovery: vi.fn(),
  settleFleetRecovery: vi.fn(),
}));

/** Nine held runs (seven waiting on the Fleet's check) and two status issues. */
function snapshot(): MaintenanceSnapshot {
  const held = Array.from({ length: 9 }, (_, index) =>
    index < 7
      ? `continuation:run-${index}:maintenance:attention:fleet-authority-verifier-unavailable`
      : `continuation:run-${index}:maintenance:attention:fleet-authority-binding-invalid`,
  );
  return {
    state: { active: true, revision: 4 },
    status: {
      phase: "needs_attention",
      activeRuns: 0,
      activeEffects: 1,
      pendingRuns: 9,
      issues: ["uncertain-effects", "continuation-needs-attention", "run-lease-expired", ...held],
    },
  };
}

describe("Fleet control dialog", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.mocked(readFleetMaintenance).mockResolvedValue(snapshot());
    vi.mocked(readFleetRecovery).mockResolvedValue({ items: [] });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const button = (text: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent?.startsWith(text));

  it("keeps the actions in view and scrolls a long attention list behind a count", async () => {
    await act(async () => {
      root.render(<FleetPauseControls spaceId={null} />);
    });
    await act(async () => button("Fleet: Needs attention")!.click());

    // The body scrolls inside a dialog capped at 85% of the viewport; the footer is outside it.
    const body = container.querySelector('[data-testid="fleet-control-body"]')!;
    expect(body.className).toContain("overflow-y-auto");
    expect(container.querySelector('[role="dialog"] > div')!.className).toContain("max-h-[85vh]");
    const footer = container.querySelector("footer")!;
    expect(body.contains(footer)).toBe(false);
    expect([...footer.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "Refresh status",
      "Resume Fleet",
      "Force stop…",
    ]);

    // Codes are folded under the count until asked for.
    expect(container.querySelector('[data-testid="fleet-attention-codes"]')).toBeNull();
    const toggle = button("9 runs need attention")!;
    expect(toggle.textContent).toBe("9 runs need attention · 2 issues · show");
    await act(async () => toggle.click());
    const codes = [...container.querySelectorAll('[data-testid="fleet-attention-codes"] li')].map(
      (li) => li.textContent,
    );
    expect(codes).toEqual([
      `fleet-authority-verifier-unavailable ×7: ${maintenanceAttentionSentence("fleet-authority-verifier-unavailable")}`,
      `fleet-authority-binding-invalid ×2: ${maintenanceAttentionSentence("fleet-authority-binding-invalid")}`,
      `uncertain-effects: ${maintenanceAttentionSentence("uncertain-effects")}`,
      `run-lease-expired: ${maintenanceAttentionSentence("run-lease-expired")}`,
    ]);
  });

  it("counts runs waiting on a card answer apart from those needing attention", async () => {
    const waiting = "fleet-current-card-wait-case-412";
    vi.mocked(readFleetMaintenance).mockResolvedValue({
      state: { active: true, revision: 4 },
      status: {
        phase: "paused",
        activeRuns: 0,
        activeEffects: 0,
        pendingRuns: 2,
        issues: [
          `continuation:run-a:maintenance:attention:${waiting}`,
          `continuation:run-b:maintenance:attention:${waiting}`,
        ],
      },
    });
    await act(async () => {
      root.render(<FleetPauseControls spaceId={null} />);
    });
    await act(async () => button("Fleet: Paused")!.click());
    const toggle = button("2 runs waiting on your answer")!;
    expect(toggle.textContent).toBe("2 runs waiting on your answer · show");
    await act(async () => toggle.click());
    expect(
      [...container.querySelectorAll('[data-testid="fleet-attention-codes"] li')].map(
        (li) => li.textContent,
      ),
    ).toEqual([`${waiting} ×2: waiting on your answer to this case's card`]);
  });
});
