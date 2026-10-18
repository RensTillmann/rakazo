import { describe, expect, it } from "vitest";
import { inboundDeliveryNoncePrefix, inboundSourceFromClientNonce } from "./inbound-delivery.js";

describe("inboundSourceFromClientNonce", () => {
  it("reads the source of a webhook, GitHub or messaging delivery", () => {
    expect(inboundSourceFromClientNonce(`${inboundDeliveryNoncePrefix("webhook", "bot-1")}d`)).toBe(
      "webhook",
    );
    expect(inboundSourceFromClientNonce("github:bot-1:delivery-1")).toBe("github");
    expect(inboundSourceFromClientNonce("messaging:bot-1:digest")).toBe("messaging");
  });

  it("leaves the owner's own messages unmarked", () => {
    for (const nonce of [
      undefined,
      null,
      "",
      "7b9e45a1-f066-4f70-b384-8a6b249009e2",
      "call:c-1:7b9e45a1",
      "routine-mention:n-1:r-1",
      "bot-message:x",
      "webhook",
      ":webhook:x",
    ]) {
      expect(inboundSourceFromClientNonce(nonce)).toBeUndefined();
    }
  });
});
