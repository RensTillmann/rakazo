import type { AdapterContext, ConnectorCall, ConnectorEvent } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { reviewApproval } from "./approval-review.js";

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
        args: { ticket: 42, body, status: "pending", expect_last_comment_id: 100 },
      },
    ],
  };
  const prisma = {
    externalEffect: { findUnique: vi.fn(async () => effect) },
    botMcpServer: { findFirst: vi.fn(async () => ({ server: { revision: 2 } })) },
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
  it("uses only the saved ticket and bound server and reports newer staff comments as stale", async () => {
    const { deps, execute } = fixture();
    execute.mockImplementation(async function* (): AsyncGenerator<ConnectorEvent> {
      yield {
        type: "result",
        data: {
          structuredContent: {
            ticket: "42",
            subject: "Question",
            latestCommentId: "102",
            customerMessage: {
              id: "99",
              author: "Customer",
              createdAt: "2026-01-01T00:00:00Z",
              body: "Complete question\nEND",
            },
          },
        },
      };
    });
    const review = await reviewApproval(deps as never, actor, "effect");
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      args: { ticket: 42 },
      route: { resourceId: "fleet", toolName: "zd_reply_context" },
    });
    expect(review?.customerContext).toMatchObject({
      status: "available",
      stale: true,
      customerMessage: { body: "Complete question\nEND" },
    });
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
        arguments: { ticket: 42, body, status: "pending" },
      },
    ] as never;
    execute.mockImplementation(async function* (): AsyncGenerator<ConnectorEvent> {
      yield {
        type: "result",
        data: {
          structuredContent: {
            ticket: "42",
            subject: "Another account",
            latestCommentId: "102",
            customerMessage: {
              id: "99",
              author: "Other customer",
              createdAt: "2026-01-01T00:00:00Z",
              body: "Private account data",
            },
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
