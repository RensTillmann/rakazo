import { readFileSync } from "node:fs";
import type { AdapterContext, ConnectorCall, ConnectorEvent } from "@rakazo/adapter-kit";
import { ApprovalReviewSchema, CustomerReplyContextSchema } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { reviewApproval } from "./approval-review.js";

/** The Fleet's pinned zd_reply_context contract (copied whole from its tests/fixtures). */
const fleet = JSON.parse(
  readFileSync(new URL("./fixtures/zd_reply_context.json", import.meta.url), "utf8"),
) as {
  zd_reply_context: { arguments: { ticket: number }; structuredContent: unknown };
  zd_reply: { inputSchema: { properties: Record<string, unknown>; required: string[] } };
};

const actor = { userId: "owner", spaceId: "space" };
const body = `Hello\n\n${"A complete response. ".repeat(300)}FINAL CHARACTER Ω`;
function fixture(userId = "owner", spaceId = "space") {
  const effect = {
    spaceId,
    run: { userId, spaceId, botId: "bot", bot: { userId, spaceId } },
    request: [
      "__rakazoCatalogTool",
      "direct",
      {
        route: {
          connectorId: "mcp",
          resourceId: "fleet",
          toolName: "zd_reply",
          resourceRevision: 2,
        },
        args: { ticket: 3529, body, status: "pending" },
      },
    ],
  };
  const prisma = {
    externalEffect: { findUnique: vi.fn(async () => effect) },
    botMcpServer: { findFirst: vi.fn(async () => ({ server: { revision: 2 } })) },
    // The reply card Rens approved: version 98123 of zendesk:3529.
    message: {
      findFirst: vi.fn(async () => ({
        blocks: [
          {
            kind: "ask",
            text: "Case 7 · Reply to Customer A (ZD #3529)",
            status: "answered",
            answer: "choice-1",
            draft: body,
            source: { ref: "zendesk:3529", version: "98123" },
          },
        ],
      })),
    },
  };
  const execute = vi.fn(async function* (
    _call: ConnectorCall,
    _context: AdapterContext,
  ): AsyncGenerator<ConnectorEvent> {
    yield { type: "error", message: "offline" };
  });
  return { deps: { prisma, connectors: { execute } }, execute, effect };
}

describe("saved approval review boundary", () => {
  it("retains the entire immutable proposal when authoritative context is unavailable", async () => {
    const { deps } = fixture();
    const review = await reviewApproval(deps as never, actor, "effect");
    expect(review?.proposedReply).toBe(body);
    expect(review?.customerContext.status).toBe("unavailable");
  });
  it.each([
    ["other", "space"],
    ["owner", "other"],
  ])("denies foreign identity %s/%s before connector access", async (userId, spaceId) => {
    const { deps, execute } = fixture(userId, spaceId);
    await expect(reviewApproval(deps as never, actor, "effect")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(execute).not.toHaveBeenCalled();
  });
  it("reads the Fleet's pinned zd_reply_context payload: full inquiry and its version", async () => {
    const { deps, execute } = fixture();
    const result = { structuredContent: fleet.zd_reply_context.structuredContent };
    execute.mockImplementation(async function* (): AsyncGenerator<ConnectorEvent> {
      yield { type: "result", data: result };
    });
    const review = await reviewApproval(deps as never, actor, "effect");
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      args: fleet.zd_reply_context.arguments,
      route: { resourceId: "fleet", toolName: "zd_reply_context" },
    });
    expect(ApprovalReviewSchema.parse(review)).toBeTruthy();
    const context = CustomerReplyContextSchema.parse(fleet.zd_reply_context.structuredContent);
    expect(review).toMatchObject({ ticket: "3529", cardVersion: "98123" });
    expect(review?.customerContext).toEqual({ ...context, status: "available", stale: false });
    expect(
      review?.customerContext.status === "available" && review.customerContext.inquiry,
    ).toContain("[#98100 · first inquiry · customer · Customer A");
  });
  it("marks the context stale when the customer wrote after the approved card's version", async () => {
    const { deps, execute } = fixture();
    deps.prisma.message.findFirst.mockResolvedValueOnce({
      blocks: [
        {
          kind: "ask",
          text: "Case 7 · Reply to Customer A (ZD #3529)",
          status: "answered",
          answer: "choice-1",
          draft: body,
          source: { ref: "zendesk:3529", version: "98100" },
        },
      ],
    });
    execute.mockImplementation(async function* (): AsyncGenerator<ConnectorEvent> {
      yield {
        type: "result",
        data: { structuredContent: fleet.zd_reply_context.structuredContent },
      };
    });
    const review = await reviewApproval(deps as never, actor, "effect");
    expect(review?.cardVersion).toBe("98100");
    expect(review?.customerContext).toMatchObject({ status: "available", stale: true });
  });
  it("matches the Fleet's zd_reply arguments: no comment-id binding left to read", () => {
    expect(fleet.zd_reply.inputSchema.required).toEqual(["ticket", "body", "status"]);
    expect(Object.keys(fleet.zd_reply.inputSchema.properties).sort()).toEqual([
      "body",
      "status",
      "tags",
      "ticket",
    ]);
  });
  it("treats the old latestCommentId/customerMessage shape as unavailable", async () => {
    const { deps, execute } = fixture();
    execute.mockImplementation(async function* (): AsyncGenerator<ConnectorEvent> {
      yield {
        type: "result",
        data: {
          structuredContent: {
            ticket: "3529",
            subject: "Question",
            latestCommentId: "102",
            customerMessage: { id: "99", author: "C", createdAt: "x", body: "old" },
          },
        },
      };
    });
    const review = await reviewApproval(deps as never, actor, "effect");
    expect(review?.customerContext.status).toBe("unavailable");
  });
  it("denies a foreign bot even when the effect and run are in the actor's scope", async () => {
    const { deps, effect, execute } = fixture();
    effect.run.bot.userId = "other";
    await expect(reviewApproval(deps as never, actor, "effect")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(execute).not.toHaveBeenCalled();
  });
  it("never contacts a reauthorized or unassigned server", async () => {
    const { deps, execute } = fixture();
    deps.prisma.botMcpServer.findFirst.mockResolvedValueOnce({ server: { revision: 3 } });
    expect((await reviewApproval(deps as never, actor, "effect"))?.customerContext.status).toBe(
      "unavailable",
    );
    expect(execute).not.toHaveBeenCalled();
    deps.prisma.botMcpServer.findFirst.mockResolvedValueOnce(null as never);
    expect((await reviewApproval(deps as never, actor, "effect"))?.proposedReply).toBe(body);
    expect(execute).not.toHaveBeenCalled();
  });
  it("keeps a legacy proposal without reading customer data under an unbound account", async () => {
    const { deps, effect, execute } = fixture();
    effect.request = [
      "__rakazoCatalogTool",
      "connectors_execute_tool",
      {
        id: "fleet:zd_reply",
        arguments: { ticket: 3529, body, status: "pending" },
      },
    ] as never;
    execute.mockImplementation(async function* (): AsyncGenerator<ConnectorEvent> {
      yield {
        type: "result",
        data: {
          structuredContent: {
            ...(fleet.zd_reply_context.structuredContent as object),
            subject: "Another account",
          },
        },
      };
    });
    const review = await reviewApproval(deps as never, actor, "effect");
    expect(review?.proposedReply).toBe(body);
    expect(review?.customerContext.status).toBe("unavailable");
    expect(execute).not.toHaveBeenCalled();
  });
});
