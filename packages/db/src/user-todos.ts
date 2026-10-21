import {
  ACTIONABLE_USER_TODO_STATUSES,
  type Actor,
  type AskPrerequisites,
  type PrerequisiteRelease,
  type UserTodo,
  type UserTodoStatus,
  UserTodoStatusSchema,
} from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./client.js";
import { askCaseKey } from "./decisions.js";

type UserTodoRow = Prisma.UserTodoGetPayload<{ include: { bot: { select: { name: true } } } }>;

export function userTodoDto(row: UserTodoRow): UserTodo {
  return {
    id: row.id,
    botId: row.botId,
    botName: row.bot.name,
    threadId: row.threadId,
    groupId: row.sourceMessageId,
    groupTitle: row.groupTitle,
    release: row.release === "each" ? "each" : "all",
    requirementKey: row.requirementKey,
    title: row.title,
    steps: row.steps,
    why: row.why,
    caseNumber: askCaseKey(row.groupTitle)?.replace(/^case /, "") ?? null,
    verification: row.verification === "manual" ? "manual" : "automatic",
    status: UserTodoStatusSchema.catch("open").parse(row.status),
    statusDetail: row.statusDetail,
    evidence: row.evidence,
    revision: row.revision,
    checkRequestedAt: row.checkRequestedAt?.toISOString() ?? null,
    checkedAt: row.checkedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The caller's to-dos in this space: actionable first, then the most recently changed. */
export async function listUserTodos(
  prisma: PrismaClient,
  actor: Pick<Actor, "spaceId" | "userId">,
): Promise<UserTodo[]> {
  const rows = await prisma.userTodo.findMany({
    where: { spaceId: actor.spaceId, userId: actor.userId },
    include: { bot: { select: { name: true } } },
    orderBy: { updatedAt: "desc" },
    take: 200,
  });
  const actionable = (todo: UserTodo) =>
    Number((ACTIONABLE_USER_TODO_STATUSES as readonly string[]).includes(todo.status));
  return rows.map(userTodoDto).sort((a, b) => actionable(b) - actionable(a));
}

/** Whitespace-only edits to the steps are not a material change. */
function stepsKey(steps: string): string {
  return steps.trim().replace(/\s+/g, " ");
}

export interface ChosenUserTodo {
  id: string;
  title: string;
  status: string;
}

/**
 * Answering a card with its `todo` option: records the user's intent to do each prerequisite.
 * Every item becomes a to-do grouped by the card, or refreshes the existing one for the same
 * requirement key and keeps its identity. Changed steps or verification invalidate earlier
 * progress and evidence; a retired requirement asked again starts over. Never marks anything
 * done. Runs inside the answer's transaction, which already holds the card thread's row lock.
 */
export async function upsertUserTodosFromAnswerInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    spaceId: string;
    userId: string;
    botId: string;
    threadId: string;
    runId: string;
    sourceMessageId: string;
    question: string;
    prerequisites: AskPrerequisites;
  },
): Promise<ChosenUserTodo[]> {
  const source = {
    userId: input.userId,
    botId: input.botId,
    threadId: input.threadId,
    runId: input.runId,
    sourceMessageId: input.sourceMessageId,
    groupTitle: input.question.trim().slice(0, 300),
    release: input.prerequisites.release,
  };
  const chosen: ChosenUserTodo[] = [];
  // Key order, so two answers sharing requirements lock their rows in the same order.
  const items = [...input.prerequisites.items].sort((a, b) => a.key.localeCompare(b.key));
  for (const item of items) {
    // Concurrent answers for one requirement: the insert races on the unique key, never fails.
    const created = await tx.userTodo.createMany({
      data: [
        {
          spaceId: input.spaceId,
          ...source,
          requirementKey: item.key,
          title: item.title,
          steps: item.steps,
          why: item.why ?? null,
          verification: item.verification,
        },
      ],
      skipDuplicates: true,
    });
    const key = { spaceId_requirementKey: { spaceId: input.spaceId, requirementKey: item.key } };
    if (created.count === 1) {
      const row = await tx.userTodo.findUniqueOrThrow({ where: key, select: { id: true } });
      chosen.push({ id: row.id, title: item.title, status: "open" });
      continue;
    }
    await tx.$queryRaw`SELECT id FROM user_todos WHERE "spaceId" = ${input.spaceId} AND "requirementKey" = ${item.key} FOR UPDATE`;
    const existing = await tx.userTodo.findUniqueOrThrow({ where: key });
    const material =
      existing.status === "retired" ||
      existing.verification !== item.verification ||
      stepsKey(existing.steps) !== stepsKey(item.steps);
    const changed =
      material ||
      existing.title !== item.title ||
      existing.steps !== item.steps ||
      existing.why !== (item.why ?? null) ||
      existing.sourceMessageId !== input.sourceMessageId;
    const updated = await tx.userTodo.update({
      where: { id: existing.id },
      data: {
        ...source,
        title: item.title,
        steps: item.steps,
        why: item.why ?? null,
        verification: item.verification,
        ...(material
          ? {
              status: "open" satisfies UserTodoStatus,
              statusDetail: null,
              evidence: null,
              checkRequestedAt: null,
              checkedAt: null,
              releasedRevision: null,
            }
          : {}),
        // A visible change makes an open tab's action stale; a same-card refresh does not.
        ...(changed ? { revision: { increment: 1 } } : {}),
      },
      select: { status: true },
    });
    chosen.push({ id: existing.id, title: item.title, status: updated.status });
  }
  return chosen;
}

/** What the resumed bot is told after the user chose the to-do option. */
export function userTodosChosenNote(todos: ChosenUserTodo[], release: PrerequisiteRelease): string {
  const list = todos
    .map(
      (todo) =>
        `- “${todo.title}” (to-do ${todo.id})${todo.status === "open" ? "" : `: ${todo.status}`}`,
    )
    .join("\n");
  return [
    "The user chose to do this themselves. These are now their to-dos; nothing is done unless marked:",
    list,
    "Do not ask about them again.",
    release === "each"
      ? "Work that needs one of them waits until it is verified or confirmed; you get a message for each one."
      : "Work that needs them waits until all are verified or confirmed; you get one message then.",
    "If a requirement is cancelled or superseded, call todo_retire with its to-do id and the reason.",
  ].join("\n");
}
