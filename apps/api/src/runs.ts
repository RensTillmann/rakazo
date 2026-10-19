import type {
  Actor,
  ProductEvent,
  RunActivityOutput,
  RunActivityRow,
  RunActivitySummary,
} from "@rakazo/contracts";
import { MessageBlock } from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  BACKGROUND_RUN_TRIGGERS,
  botMessageContext,
  runPushEnabled,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";

const RECENT_LIMIT = 20;
const ACTIVITY_PAGE_DEFAULT = 300;
const TERMINAL_STATUSES = ["completed", "failed", "cancelled"] as const;

function promptSnippet(prompt: string, max = 120): string {
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}

export function activityPromptSnippet(
  input: { trigger: string; prompt: string; sourceBlocks?: unknown },
  max = 120,
): string {
  if (input.trigger !== "bot_message") return promptSnippet(input.prompt, max);
  const parsed = MessageBlock.array().safeParse(input.sourceBlocks);
  const message = parsed.success ? botMessageContext(parsed.data) : undefined;
  if (!message) return "Message from another agent";
  const name = message.fromBotName.trim() || "Another agent";
  const label =
    message.intent === "result" || message.intent === "status" || message.intent === "fyi"
      ? `Update from ${name}`
      : `${name} asked`;
  return promptSnippet(message.text.trim() ? `${label}: ${message.text}` : label, max);
}

export function activityNotificationsEnabled(
  groupId: string | null,
  groupNotify: boolean | null,
  notifyOnFinish: boolean,
): boolean {
  return runPushEnabled({
    groupNotify: groupId === null ? null : (groupNotify ?? false),
    notifyOnFinish,
  });
}

export async function listSpaceRuns(
  prisma: PrismaClient,
  actor: Actor,
  filter: "active" | "recent",
): Promise<RunActivityRow[]> {
  const rows = await prisma.run.findMany({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      bot: { archivedAt: null },
      // Background ticket work belongs on the board, not in the activity list.
      trigger: { notIn: [...BACKGROUND_RUN_TRIGGERS] },
      ...(filter === "active"
        ? { status: { in: [...ACTIVE_RUN_STATUSES] } }
        : { status: { in: [...TERMINAL_STATUSES] } }),
    },
    include: {
      bot: { select: { name: true, archivedAt: true, notifyOnFinish: true } },
      task: { select: { prompt: true } },
      sourceMessage: { select: { blocks: true } },
      thread: {
        select: {
          groupId: true,
          group: { select: { name: true, notify: true } },
        },
      },
    },
    orderBy:
      filter === "active"
        ? [{ updatedAt: "desc" }, { id: "desc" }]
        : [{ completedAt: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
    take: filter === "recent" ? RECENT_LIMIT : undefined,
  });

  return rows.map((row) => ({
    runId: row.id,
    botId: row.botId,
    botName: row.bot.name,
    groupId: row.thread.groupId,
    groupName: row.thread.group?.name ?? null,
    threadId: row.threadId,
    status: row.status as RunActivityRow["status"],
    trigger: row.trigger as RunActivityRow["trigger"],
    notificationsEnabled: activityNotificationsEnabled(
      row.thread.groupId,
      row.thread.group?.notify ?? null,
      row.bot.notifyOnFinish,
    ),
    promptSnippet: activityPromptSnippet({
      trigger: row.trigger,
      prompt: row.task.prompt,
      sourceBlocks: row.sourceMessage?.blocks,
    }),
    updatedAt: (filter === "recent" && row.completedAt
      ? row.completedAt
      : row.updatedAt
    ).toISOString(),
  }));
}

/**
 * Fleet (RAKAZO_ACTIVITY_DETAILS): a page of one run's stored events for the Live activity
 * window, with the thread's recent runs for its picker. The caller has already resolved the
 * thread for this actor (space and owner, as `threads.get`); a run from another thread is
 * treated as missing.
 */
export async function loadRunActivity(
  prisma: PrismaClient,
  actor: Actor,
  threadId: string,
  input: { runId?: string; afterSeq?: number; limit?: number },
): Promise<RunActivityOutput> {
  const rows = await prisma.run.findMany({
    where: { threadId, spaceId: actor.spaceId },
    include: {
      bot: { select: { name: true } },
      task: { select: { prompt: true } },
      sourceMessage: { select: { blocks: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: RECENT_LIMIT,
  });
  const runs: RunActivitySummary[] = rows.map((row) => ({
    runId: row.id,
    botId: row.botId,
    botName: row.bot.name,
    status: row.status as RunActivitySummary["status"],
    trigger: row.trigger as RunActivitySummary["trigger"],
    promptSnippet: activityPromptSnippet({
      trigger: row.trigger,
      prompt: row.task.prompt,
      sourceBlocks: row.sourceMessage?.blocks,
    }),
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
  }));
  let runId = input.runId ?? runs[0]?.runId ?? null;
  if (input.runId) {
    const owned = await prisma.run.findFirst({
      where: { id: input.runId, threadId, spaceId: actor.spaceId },
      select: { id: true },
    });
    runId = owned?.id ?? null;
  }
  if (!runId) return { threadId, runs, runId: null, events: [], nextAfterSeq: null };
  const limit = input.limit ?? ACTIVITY_PAGE_DEFAULT;
  const page = await prisma.event.findMany({
    where: { threadId, runId, seq: { gt: input.afterSeq ?? -1 } },
    orderBy: { seq: "asc" },
    take: limit + 1,
  });
  const more = page.length > limit;
  const events: ProductEvent[] = page.slice(0, limit).map((event) => ({
    id: event.id,
    spaceId: event.spaceId,
    threadId: event.threadId,
    botId: event.botId,
    seq: event.seq,
    type: event.type as ProductEvent["type"],
    runId: event.runId ?? undefined,
    createdAt: event.createdAt.toISOString(),
    payload: (event.payload ?? {}) as ProductEvent["payload"],
  }));
  return {
    threadId,
    runs,
    runId,
    events,
    nextAfterSeq: more ? (events.at(-1)?.seq ?? null) : null,
  };
}
