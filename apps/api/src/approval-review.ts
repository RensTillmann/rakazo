import { ORPCError } from "@orpc/server";
import type { AdapterContext } from "@rakazo/adapter-kit";
import type { BoundApprovalRoute, ConnectorRegistry } from "@rakazo/adapters";
import {
  boundDirectApprovalDetails,
  catalogApprovalConnectorId,
  catalogApprovalDetails,
  catalogApprovalInnerArgs,
  parseCatalogApprovalTarget,
} from "@rakazo/adapters";
import type { ApprovalReview } from "@rakazo/contracts";
import { CustomerReplyContextSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";

const MARKER = "__rakazoCatalogTool";
type Scope = { userId: string; spaceId: string };

/** Reads only persisted arguments. Model summaries and client-supplied context are never a source. */
export async function reviewApproval(
  deps: { prisma: PrismaClient; connectors: ConnectorRegistry },
  actor: Scope,
  effectId: string,
  signal?: AbortSignal,
): Promise<ApprovalReview | null> {
  const effect = await deps.prisma.externalEffect.findUnique({
    where: { id: effectId },
    include: { run: { include: { bot: true } } },
  });
  if (
    !effect ||
    effect.spaceId !== actor.spaceId ||
    effect.run.spaceId !== actor.spaceId ||
    effect.run.userId !== actor.userId ||
    effect.run.bot.spaceId !== actor.spaceId ||
    effect.run.bot.userId !== actor.userId
  )
    throw new ORPCError("NOT_FOUND");

  const bound = boundDirectApprovalDetails(effect.request, MARKER);
  const catalog = catalogApprovalDetails(effect.request, MARKER);
  const target = catalog && parseCatalogApprovalTarget(catalog.args);
  const route: BoundApprovalRoute | undefined =
    bound?.route ??
    catalog?.route ??
    (catalog && target
      ? { ...target, connectorId: catalogApprovalConnectorId(catalog.toolName) }
      : undefined);
  const args = bound?.args ?? (catalog && catalogApprovalInnerArgs(catalog));
  if (
    route?.connectorId !== "mcp" ||
    route.toolName !== "zd_reply" ||
    !args ||
    !Number.isSafeInteger(args.ticket) ||
    Number(args.ticket) <= 0 ||
    typeof args.body !== "string" ||
    typeof args.status !== "string"
  )
    return null;

  const expected = args.expect_last_comment_id;
  const review: ApprovalReview = {
    ticket: String(args.ticket),
    proposedReply: args.body,
    status: args.status,
    tags: Array.isArray(args.tags)
      ? args.tags.filter((tag): tag is string => typeof tag === "string")
      : [],
    expectedLastCommentId:
      typeof expected === "number" && Number.isSafeInteger(expected) ? String(expected) : null,
    customerContext: { status: "unavailable" },
  };
  // A legacy proposal still has its complete body, but no provable original account identity.
  if (route.resourceRevision === undefined) return review;
  try {
    // The exact bound server, not another bot's connection or a server selected by its display name.
    const assignment = await deps.prisma.botMcpServer.findFirst({
      where: {
        botId: effect.run.botId,
        serverId: route.resourceId,
        userId: actor.userId,
        spaceId: actor.spaceId,
        server: { enabled: true },
      },
      include: { server: true },
    });
    if (!assignment || assignment.server.revision !== route.resourceRevision) return review;
    const operationId = `approval-review:${effectId}`;
    const context: AdapterContext = {
      userId: actor.userId,
      spaceId: actor.spaceId,
      botId: effect.run.botId,
      operationId,
      traceId: operationId,
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
    };
    for await (const event of deps.connectors.execute(
      {
        tool: "zd_reply_context",
        executionId: operationId,
        args: { ticket: args.ticket },
        route: { ...route, toolName: "zd_reply_context" },
      },
      context,
    )) {
      if (event.type === "error") return review;
      if (event.type !== "result") continue;
      const result = event.data as { isError?: boolean; structuredContent?: unknown } | null;
      if (!result || result.isError) return review;
      const parsed = CustomerReplyContextSchema.safeParse(result.structuredContent);
      if (!parsed.success || parsed.data.ticket !== review.ticket) return review;
      const latest = parsed.data.latestCommentId;
      review.customerContext = {
        ...parsed.data,
        status: "available",
        stale:
          review.expectedLastCommentId !== null && latest !== null && /^\d+$/.test(latest)
            ? BigInt(latest) > BigInt(review.expectedLastCommentId)
            : null,
      };
    }
  } catch {
    // Keep the immutable proposal available; connector/credential errors must not leak into this response.
  }
  return review;
}
