import { describe, expect, it } from "vitest";
import { parseZaiQuotaUsageResponse } from "./zai-usage.js";

const now = new Date("2030-01-01T10:00:00Z");
const reset = Date.parse("2030-01-07T00:00:00Z");
const response = (limits: unknown[]) => ({ code: 200, success: true, data: { limits } });

describe("GLM Coding Plan quota windows", () => {
  it("maps the reported credit windows by duration, not list order or budget size", () => {
    const reading = parseZaiQuotaUsageResponse(
      response([
        { type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 40, nextResetTime: reset },
        { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 25 },
        { type: "TIME_LIMIT", unit: 5, number: 1, percentage: 99 },
      ]),
      now,
    );
    expect(reading).toMatchObject({
      provider: "zai",
      fiveHourUtil: 0.25,
      fiveHourResetAt: null,
      sevenDayUtil: 0.4,
      sevenDayResetAt: new Date(reset),
      observedAt: now,
    });
  });

  it("keeps a genuinely reported zero while leaving an absent window unknown", () => {
    const reading = parseZaiQuotaUsageResponse(
      response([{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 0 }]),
      now,
    );
    expect(reading).toMatchObject({ fiveHourUtil: 0, sevenDayUtil: null, sevenDayResetAt: null });
  });

  it("does not call a monthly, unsupported, or malformed limit a weekly allowance", () => {
    expect(
      parseZaiQuotaUsageResponse(
        response([
          { type: "CREDIT_LIMIT", unit: 5, number: 1, percentage: 0 },
          { type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: -1 },
          { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 101 },
        ]),
        now,
      ),
    ).toBeNull();
  });

  it("does not turn an application error with HTTP-success-shaped data into zero usage", () => {
    expect(
      parseZaiQuotaUsageResponse(
        {
          success: false,
          code: 401,
          data: { limits: [{ type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 0 }] },
        },
        now,
      ),
    ).toBeNull();
  });
});
