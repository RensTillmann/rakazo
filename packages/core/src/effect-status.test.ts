import { describe, expect, it } from "vitest";
import { IN_PROGRESS_EFFECT_STATUSES, isSettledEffectStatus } from "./effect-status.js";

describe("settled effect statuses", () => {
  it("counts a final invalidated approval as settled, and in-flight or uncertain work as not", () => {
    expect(isSettledEffectStatus("invalidated")).toBe(true);
    expect(isSettledEffectStatus("approved")).toBe(true);
    for (const status of [...IN_PROGRESS_EFFECT_STATUSES, "uncertain"]) {
      expect(isSettledEffectStatus(status)).toBe(false);
    }
  });
});
