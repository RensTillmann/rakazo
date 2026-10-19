import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVITY_ARG_STRING_MAX,
  ACTIVITY_ARGS_PREVIEW_MAX,
  activityArgsPreview,
  activityDetailsDays,
  activityDetailsEnabled,
  activityResultDetails,
  createActivityDetailsRetention,
  stripExpiredActivityDetails,
} from "./activity-details.js";
import { toolCompletionAuditPayload } from "./executor.js";
import { clipToolResultText } from "./pi-runtime-limits.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("activity details setting", () => {
  it("is off unless RAKAZO_ACTIVITY_DETAILS is true; retention defaults to 14 days", () => {
    expect(activityDetailsEnabled({})).toBe(false);
    expect(activityDetailsEnabled({ RAKAZO_ACTIVITY_DETAILS: "true" })).toBe(true);
    expect(activityDetailsDays({})).toBe(14);
    expect(activityDetailsDays({ RAKAZO_ACTIVITY_DETAILS_DAYS: "3" })).toBe(3);
    expect(activityDetailsDays({ RAKAZO_ACTIVITY_DETAILS_DAYS: "-1" })).toBe(14);
  });
});

describe("activityArgsPreview", () => {
  it("blanks secrets like the model's view and caps strings and the whole preview", () => {
    const preview = activityArgsPreview(
      {
        query: "from:boss",
        header: "Bearer abc.def",
        password: "hunter2",
        note: `token run-secret-123 ${"y".repeat(900)}`,
        list: Array.from({ length: 20 }, () => "z".repeat(600)),
      },
      ["run-secret-123"],
    );
    expect(preview.length).toBeLessThanOrEqual(ACTIVITY_ARGS_PREVIEW_MAX);
    expect(preview).toContain('"query":"from:boss"');
    expect(preview).toContain("Bearer [redacted]");
    expect(preview).toContain('"password":"[redacted]"');
    expect(preview).not.toContain("hunter2");
    expect(preview).not.toContain("run-secret-123");
    expect(preview).not.toContain("y".repeat(ACTIVITY_ARG_STRING_MAX + 1));
    expect(preview).not.toContain("z".repeat(ACTIVITY_ARG_STRING_MAX + 1));
    expect(preview.endsWith("…")).toBe(true);
  });
});

describe("activityResultDetails", () => {
  it("counts the full result against what the model saw when it was cut off", () => {
    const full = `sk-abcdef ${"m".repeat(89_394)}`;
    expect(full).toHaveLength(89_404);
    const details = activityResultDetails({
      text: clipToolResultText(full),
      resultChars: full.length,
    });
    expect(details).toMatchObject({ resultChars: 89_404, shownChars: 12_000, clipped: true });
    expect(details.resultPreview).toHaveLength(2_000 - "sk-abcdef".length + "[redacted]".length);
    expect(details.resultPreview.startsWith("[redacted] ")).toBe(true);
  });

  it("is not clipped when the model saw everything", () => {
    expect(activityResultDetails({ text: "ok", resultChars: 2 })).toEqual({
      resultChars: 2,
      shownChars: 2,
      clipped: false,
      resultPreview: "ok",
    });
  });
});

describe("tool completion audit payload", () => {
  const completion = {
    name: "GMAIL_FETCH_EMAILS",
    executionId: "call-1",
    durationMs: 1200,
    result: { ok: true },
    shown: { text: clipToolResultText("x".repeat(20_000)), resultChars: 20_000 },
    budget: { modelCalls: 4, usedMs: 150_000 },
  };

  it("adds the details and budget counters with the setting on", () => {
    vi.stubEnv("RAKAZO_ACTIVITY_DETAILS", "true");
    expect(toolCompletionAuditPayload(completion)).toMatchObject({
      resultChars: 20_000,
      shownChars: 12_000,
      clipped: true,
      modelCalls: 4,
      elapsedMinutes: 2.5,
    });
  });

  it("stays the upstream payload with the setting off", () => {
    const payload = toolCompletionAuditPayload(completion);
    expect(Object.keys(payload).sort()).toEqual(["durationMs", "executionId", "name", "outcome"]);
  });
});

describe("activity details retention", () => {
  it("strips only the previews from tool events older than the window", async () => {
    const $executeRaw = vi.fn(async () => 3);
    const now = new Date("2026-10-19T12:00:00.000Z");
    await expect(stripExpiredActivityDetails({ $executeRaw } as never, now, 14)).resolves.toBe(3);
    const [strings, cutoff] = $executeRaw.mock.calls[0] as unknown as [string[], Date];
    const sql = strings.join("?");
    expect(sql).toContain(`"payload" - 'argsPreview' - 'resultPreview'`);
    expect(sql).toContain("'agent.tool.called', 'agent.tool.completed'");
    expect(sql).toContain(`"createdAt" <`);
    expect(cutoff.toISOString()).toBe("2026-10-05T12:00:00.000Z");
  });

  it("runs at most once per interval from the reconciler tick", async () => {
    const $executeRaw = vi.fn(async () => 0);
    let now = new Date("2026-10-19T12:00:00.000Z");
    const tick = createActivityDetailsRetention({ $executeRaw } as never, {
      intervalMs: 60_000,
      now: () => now,
    });
    await tick();
    await tick();
    expect($executeRaw).toHaveBeenCalledTimes(1);
    now = new Date(now.getTime() + 60_000);
    await tick();
    expect($executeRaw).toHaveBeenCalledTimes(2);
  });
});
