// @vitest-environment jsdom
import type { ThreadUsage, UsageLimits } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatUntil, ThreadUsageLine, UsageTopBar, usageTone } from "./UsageBars";

const limits = vi.hoisted(() => vi.fn());
const thread = vi.hoisted(() => vi.fn());
vi.mock("../lib/rpc", () => ({ rpc: { usage: { limits, thread } } }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      String.raw({ raw: strings }, ...values),
  }),
}));

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
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

const inTwoHours = () => new Date(Date.now() + 2 * 3_600_000 + 10_000).toISOString();

describe("usage helpers", () => {
  it("colors green, amber and red", () => {
    expect(usageTone(null)).toBe("ok");
    expect(usageTone(69)).toBe("ok");
    expect(usageTone(70)).toBe("warn");
    expect(usageTone(90)).toBe("high");
  });

  it("formats the time until a reset", () => {
    const now = Date.parse("2026-10-19T10:00:00Z");
    expect(formatUntil("2026-10-19T12:10:00Z", now)).toBe("2 h 10 m");
    expect(formatUntil("2026-10-19T10:45:00Z", now)).toBe("45 m");
    expect(formatUntil("2026-10-22T14:00:00Z", now)).toBe("3 d 4 h");
    expect(formatUntil("2026-10-19T09:00:00Z", now)).toBeNull();
    expect(formatUntil(null, now)).toBeNull();
  });
});

describe("UsageTopBar", () => {
  it("shows the Claude windows and fleet bars with % used, reset and stale age", async () => {
    limits.mockResolvedValue({
      enabled: true,
      claude: {
        fiveHour: { usedPct: 42, resetsAt: inTwoHours(), reset: false },
        sevenDay: { usedPct: 0, resetsAt: "2026-10-18T00:00:00.000Z", reset: true },
        status: "allowed",
        observedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
        ageSeconds: 1200,
      },
      extra: [
        {
          name: "hindsight",
          usedPct: 95,
          label: "Hindsight · this month",
          detail: "$4.10 of $20",
          updatedAt: new Date().toISOString(),
        },
      ],
    } satisfies UsageLimits);
    await render(<UsageTopBar />);
    const five = host.querySelector('[data-testid="usage-bar-five-hour"]');
    expect(five?.textContent).toContain("Claude · 5 hours");
    expect(five?.textContent).toContain("42%");
    expect(five?.textContent).toContain("resets in 2 h 0 m");
    expect(five?.textContent).toContain("as of");
    expect(five?.querySelector(".bg-emerald-500")).not.toBeNull();
    const week = host.querySelector('[data-testid="usage-bar-seven-day"]');
    expect(week?.textContent).toContain("Claude · this week");
    expect(week?.textContent).toContain("0%");
    expect(week?.textContent).toContain("reset");
    const hindsight = host.querySelector('[data-testid="usage-bar-hindsight"]');
    expect(hindsight?.textContent).toContain("$4.10 of $20");
    expect(hindsight?.textContent).not.toContain("as of");
    expect(hindsight?.querySelector(".bg-red-500")).not.toBeNull();
  });

  it("colours a fleet bar without a percentage by its tone, with no % or dash", async () => {
    limits.mockResolvedValue({
      enabled: true,
      claude: null,
      extra: [
        {
          name: "waiting-on-rens",
          usedPct: null,
          label: "15 waiting on you · oldest 4½ days",
          detail: "9 not asked as a card yet · list: https://example.test",
          updatedAt: new Date().toISOString(),
          tone: "high",
        },
        {
          name: "fleet-health",
          usedPct: null,
          label: "Fleet health",
          detail: "all OK",
          updatedAt: null,
        },
      ],
    } satisfies UsageLimits);
    await render(<UsageTopBar />);
    const waiting = host.querySelector('[data-testid="usage-bar-waiting-on-rens"]');
    const fill = waiting?.querySelector<HTMLElement>(".bg-red-500");
    expect(fill).not.toBeNull();
    expect(fill?.style.width).toBe("100%");
    expect(waiting?.textContent).toBe(
      "15 waiting on you · oldest 4½ days9 not asked as a card yet · list: https://example.test",
    );
    // No tone and no percentage: today's look, a dash and an empty track.
    const health = host.querySelector('[data-testid="usage-bar-fleet-health"]');
    expect(health?.textContent).toContain("–");
    expect(health?.querySelector<HTMLElement>(".bg-emerald-500")?.style.width).toBe("0%");
  });

  it("renders nothing when the setting is off", async () => {
    limits.mockResolvedValue({ enabled: false, claude: null, extra: [] } satisfies UsageLimits);
    await render(<UsageTopBar />);
    expect(host.querySelector('[data-testid="usage-top-bar"]')).toBeNull();
  });

  it("refetches when the refresh key changes", async () => {
    limits.mockResolvedValue({ enabled: false, claude: null, extra: [] } satisfies UsageLimits);
    await render(<UsageTopBar refreshKey="run-1" />);
    await render(<UsageTopBar refreshKey={null} />);
    expect(limits).toHaveBeenCalledTimes(2);
  });
});

describe("ThreadUsageLine", () => {
  const usage: ThreadUsage = {
    contextTokens: 45_000,
    contextWindow: 200_000,
    contextPct: 22.5,
    cachePctToday: 81.2,
    tokensToday: 1_234_000,
    runsToday: 6,
    apiEquivalentCostUsdToday: 3.1,
  };

  it("shows context, cache, tokens, runs and the API-price cost", async () => {
    thread.mockResolvedValue(usage);
    await render(<ThreadUsageLine botId="bot-1" />);
    expect(thread).toHaveBeenCalledWith(expect.objectContaining({ botId: "bot-1" }));
    expect(host.textContent).toBe(
      "context 45k of 200k (23%) · cache 81% today · 1.2M tokens today · 6 runs today · ≈ $3.10 at API prices",
    );
  });

  it("asks for the group in a room and refreshes after a run finishes", async () => {
    thread.mockResolvedValue(usage);
    await render(<ThreadUsageLine groupId="group-1" refreshKey="run-1" />);
    await render(<ThreadUsageLine groupId="group-1" refreshKey={null} />);
    expect(thread).toHaveBeenCalledTimes(2);
    expect(thread.mock.calls[0]?.[0]).toMatchObject({ groupId: "group-1" });
    expect(thread.mock.calls[0]?.[0]).not.toHaveProperty("botId");
  });

  it("stays empty for a chat without usage", async () => {
    thread.mockResolvedValue({
      ...usage,
      contextTokens: null,
      contextWindow: null,
      contextPct: null,
      cachePctToday: null,
      tokensToday: 0,
      runsToday: 0,
      apiEquivalentCostUsdToday: null,
    });
    await render(<ThreadUsageLine botId="bot-1" />);
    expect(host.querySelector('[data-testid="thread-usage-line"]')).toBeNull();
  });
});
