// @vitest-environment jsdom
import type { ExtraUsageBar, ThreadUsage, UsageLimits } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attentionSummary, formatUntil, UsageDetails, UsageTopBar, usageTone } from "./UsageBars";

const api = vi.hoisted(() => ({
  usage: { limits: vi.fn(), thread: vi.fn() },
}));
vi.mock("../lib/auth", () => ({
  authClient: { useSession: () => ({ data: { user: { id: "user-1" } } }) },
}));
vi.mock("../lib/rpc", () => ({
  createSpaceRpc: () => api,
  selectedSpaceId: () => "space-1",
}));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      String.raw({ raw: strings }, ...values),
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
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render(node: ReactNode) {
  await act(async () => {
    root.render(node);
  });
}
const extra = (summary: ExtraUsageBar["summary"]): ExtraUsageBar => ({
  name: "status",
  usedPct: null,
  label: "Old diagnostic label with 900 waiting cards",
  detail: "Historical failures",
  updatedAt: null,
  summary,
});

describe("usage helpers", () => {
  it("retains allowance thresholds and reset timing", () => {
    expect([usageTone(null), usageTone(69), usageTone(70), usageTone(90)]).toEqual([
      "ok",
      "ok",
      "warn",
      "high",
    ]);
    const now = Date.parse("2026-10-19T10:00:00Z");
    expect(formatUntil("2026-10-19T12:10:00Z", now)).toBe("2 h 10 m");
    expect(formatUntil("2026-10-22T14:00:00Z", now)).toBe("3 d 4 h");
    expect(formatUntil(null, now)).toBeNull();
  });
  it("uses structured waiting items and routine counts, not historical diagnostic numbers", () => {
    const result = attentionSummary([
      extra({ waitingCount: 43, unaskedCount: 7 }),
      extra({ pausedRoutineCount: 9, issueCount: 2 }),
    ]);
    expect(result).toContain("43 waiting items");
    expect(result).toContain("9 paused routines");
    expect(result).toContain("2 issues");
    expect(result.join(" ")).not.toMatch(/cards|900|Historical/);
  });
  it("never fills unknown partial counts with zero", () => {
    const result = attentionSummary([extra({ partial: true, issueCount: 2, unaskedCount: null })]);
    expect(result).toContain("Status incomplete");
    expect(result).toContain("2 issues");
    expect(result.join(" ")).not.toMatch(/0 |paused|waiting|unasked/);
  });
  it("keeps active legacy warnings visible without printing raw diagnostics", () => {
    expect(attentionSummary([{ ...extra(null), tone: "high" }])).toContain(
      "Status needs attention",
    );
  });
  it("keeps an unverified recorded brake visible without inventing a paused count", () => {
    const result = attentionSummary([{ ...extra({ partial: true, issueCount: 0 }), tone: "high" }]);
    expect(result).toContain("Status needs attention");
    expect(result).toContain("Status incomplete");
    expect(result.join(" ")).not.toMatch(/\d+ paused|\d+ issues/);
  });
  it("marks old status counts with their observation time", () => {
    const observed = "2026-10-20T10:00:00Z";
    const result = attentionSummary(
      [{ ...extra({ issueCount: 2 }), updatedAt: observed }],
      Date.parse("2026-10-20T10:11:00Z"),
    );
    expect(result.join(" ")).toContain("2 issues");
    expect(result.join(" ")).toContain(
      new Date(observed).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    );
  });
});

describe("usage details", () => {
  const usage: ThreadUsage = {
    contextTokens: 45_123,
    contextWindow: 200_000,
    contextPct: 22.5,
    cachePctToday: 81.2,
    tokensToday: 1_234_000,
    runsToday: 6,
    apiEquivalentCostUsdToday: 3.1,
    lastModel: { provider: "old-provider", model: "old-model" },
  };
  it("preserves exact last-call context, totals and cross-model daily cache", async () => {
    await render(<UsageDetails limits={null} usage={usage} contextLabel="Last call context" />);
    expect(host.textContent).toContain("old-provider/old-model");
    expect(host.textContent).toContain((45_123).toLocaleString());
    expect(host.textContent).toContain((200_000).toLocaleString());
    expect(host.textContent).toContain((1_234_000).toLocaleString());
    expect(host.textContent).toContain("81%");
    expect(host.textContent).toContain("$3.10");
  });
  it("keeps compact context and cache visible without assigning old context to the configured model", async () => {
    api.usage.limits.mockResolvedValue({ enabled: false, claude: null, extra: [] });
    api.usage.thread.mockResolvedValue(usage);
    await render(
      <UsageTopBar compact botId="bot-1" modelProvider="new-provider" modelId="new-model" />,
    );
    expect(host.textContent).toContain("Last call context 23%");
    expect(host.textContent).toContain("Cache today 81%");
    expect(host.textContent).not.toContain("Historical failures");
  });
  it("keeps the weekly account percentage visible without assigning it to the current model", async () => {
    api.usage.limits.mockResolvedValue({
      enabled: true,
      claude: {
        provider: "anthropic",
        fiveHour: { usedPct: 10, resetsAt: null, reset: false },
        sevenDay: { usedPct: 98, resetsAt: null, reset: false },
        status: null,
        observedAt: "2026-10-20T12:00:00Z",
        ageSeconds: 0,
      },
      extra: [],
    });
    api.usage.thread.mockResolvedValue(usage);
    await render(
      <UsageTopBar compact botId="bot-1" modelProvider="openai-codex" modelId="new-model" />,
    );
    const quota = host.querySelector('[data-testid="weekly-allowance-summary"]');
    expect(quota?.textContent).toContain("Claude");
    expect(quota?.textContent).toContain("98%");
    expect(quota?.textContent).not.toContain("openai");
  });
  it("retains weekly and five-hour provider allowance and full linked diagnostics under disclosure", async () => {
    const resetsAt = "2026-10-25T12:00:00.000Z";
    const limits: UsageLimits = {
      enabled: true,
      claude: {
        fiveHour: { usedPct: null, resetsAt: null, reset: false },
        sevenDay: { usedPct: 98, resetsAt, reset: false },
        status: "allowed",
        observedAt: "2026-10-20T12:00:00.000Z",
        ageSeconds: 0,
      },
      extra: [
        {
          ...extra({ partial: true }),
          name: "hindsight",
          usedPct: 30,
          detail: "Full provider diagnostic with history · list: https://example.test/list",
          label: "Hindsight monthly cost",
        },
      ],
    };
    await render(<UsageDetails limits={limits} usage={null} />);
    expect(host.textContent).toContain("Anthropic Claude");
    expect(host.querySelector('[data-testid="usage-bar-seven-day"]')?.textContent).toContain("98%");
    expect(host.querySelector('[data-testid="usage-bar-seven-day"]')?.textContent).toContain(
      new Date(resetsAt).toLocaleString(),
    );
    expect(host.querySelector('[data-testid="usage-bar-five-hour"]')?.textContent).toContain(
      "Unavailable",
    );
    const details = host.querySelector("details");
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain("Full provider diagnostic with history");
    expect(details?.querySelector("a")?.href).toBe("https://example.test/list");
  });
});
