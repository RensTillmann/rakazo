import { describe, expect, it } from "vitest";
import { todoTimeEstimateMinutes } from "./todo-time.js";

describe("to-do time estimate", () => {
  it("adds up the time every item names, in why or steps", () => {
    expect(
      todoTimeEstimateMinutes([
        { why: "Mail bounces without it. Takes about 5 minutes.", steps: "1. Open DNS" },
        { steps: "1. Call the bank (about 1 hour)" },
      ]),
    ).toBe(65);
    expect(todoTimeEstimateMinutes([{ steps: "1. Do it, about 2 hrs" }])).toBe(120);
  });

  it("says nothing when an item names no time", () => {
    expect(
      todoTimeEstimateMinutes([{ why: "about 5 minutes", steps: "1." }, { steps: "1. Open" }]),
    ).toBeNull();
    expect(todoTimeEstimateMinutes([])).toBeNull();
  });
});
