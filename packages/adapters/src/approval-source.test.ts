import { describe, expect, it } from "vitest";
import { approvalSourceMessageId } from "./approval-effect.js";

const route = {
  connectorId: "mcp",
  resourceId: "server-a",
  toolName: "question_withdraw",
  resourceRevision: 3,
};
describe("approval source identity", () => {
  it("uses the resolved MCP identity with the exact ID", () => {
    expect(approvalSourceMessageId(route, { message_id: "source-a" })).toBe("source-a");
  });
  it.each([undefined, { ...route, connectorId: "other" }, { ...route, toolName: "other" }])(
    "does not bind arbitrary tools that accept a message ID",
    (candidate) => {
      expect(approvalSourceMessageId(candidate, { message_id: "source-a" })).toBeUndefined();
    },
  );
  it.each([undefined, null, 12, "", " source-a", "source-a ", [], {}])(
    "rejects malformed source IDs without normalising identity",
    (message_id) => {
      expect(approvalSourceMessageId(route, { message_id })).toBeUndefined();
    },
  );
});
