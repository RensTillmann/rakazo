import { describe, expect, it } from "vitest";
import { retiredCardReason } from "./retired-card.js";

describe("retired card reason", () => {
  it("drops a leading 'No longer needed' so clients show the phrase once", () => {
    expect(retiredCardReason("No longer needed: the question ended.")).toBe("the question ended.");
    expect(retiredCardReason("no longer needed · Case closed")).toBe("Case closed");
    expect(retiredCardReason("Withdrawn: Case 401 closed")).toBe("Withdrawn: Case 401 closed");
    expect(retiredCardReason("No longer needed")).toBe("");
    expect(retiredCardReason(undefined)).toBe("");
  });
});
