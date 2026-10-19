import { describe, expect, it, vi } from "vitest";
import { answeredByDeviceLabel } from "./answered-by-label";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings.join(""),
}));

describe("answeredByDeviceLabel", () => {
  it.each([
    ["fleet-service (do not delete)", "fleet service"],
    ["fleet-ui-driver playwright/1.50", "test browser"],
    [
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36",
      "Android phone",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36",
      "Windows · Chrome",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0",
      "Windows · Edge",
    ],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1", "iPhone"],
    [undefined, "unknown device"],
  ])("labels %s as %s", (userAgent, label) => {
    expect(answeredByDeviceLabel(userAgent)).toBe(label);
  });
});
