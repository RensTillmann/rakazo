import {
  ACTIONABLE_USER_TODO_STATUSES,
  type Actor,
  type AskPrerequisites,
  PrerequisiteBlock,
  PrerequisitePriority,
  type PrerequisiteRelease,
  type UserTodo,
  type UserTodoStatus,
  UserTodoStatusSchema,
} from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./client.js";

type UserTodoRow = Prisma.UserTodoGetPayload<{ include: { bot: { select: { name: true } } } }>;

/** Stored blocks as the list shows them: a tracker issue with its label, or display text alone. */
function blocksDto(stored: Prisma.JsonValue): UserTodo["blocks"] {
  const parsed = PrerequisiteBlock.array().safeParse(stored);
  if (!parsed.success) return [];
  return parsed.data.map((block) =>
    typeof block === "string"
      ? { issue: null, label: block }
      : { issue: block.issue, label: block.label ?? `#${block.issue}` },
  );
}

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
    caseRef: row.caseRef,
    blocks: blocksDto(row.blocks),
    priority: PrerequisitePriority.nullable().catch(null).parse(row.priority),
    position: row.position,
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

const PRIORITY_RANK: Record<string, number> = { p0: 0, p1: 1, p2: 2, p3: 3 };

/** An unfinished item that other cases or jobs depend on: the list shows it as "blocks …". */
export function userTodoBlocksOthers(todo: Pick<UserTodo, "blocks" | "status">): boolean {
  return (
    todo.blocks.length > 0 &&
    (ACTIONABLE_USER_TODO_STATUSES as readonly string[]).includes(todo.status)
  );
}

/**
 * Groups to-dos by card. Cards with an item that blocks other cases or jobs come first, then by
 * priority (unknown after p3), then the oldest asked. Items keep the bot's order on the card,
 * whatever their status.
 */
function orderUserTodos(todos: UserTodo[]): UserTodo[] {
  const groups = new Map<string, UserTodo[]>();
  for (const todo of todos) {
    const group = groups.get(todo.groupId);
    if (group) group.push(todo);
    else groups.set(todo.groupId, [todo]);
  }
  const ranked = [...groups.values()].map((items) => ({
    items: items.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)),
    blocks: items.some(userTodoBlocksOthers) ? 0 : 1,
    priority: Math.min(...items.map((item) => PRIORITY_RANK[item.priority ?? ""] ?? 4)),
    askedAt: items.reduce(
      (oldest, item) => (item.createdAt < oldest ? item.createdAt : oldest),
      items[0]!.createdAt,
    ),
  }));
  ranked.sort(
    (a, b) =>
      a.blocks - b.blocks ||
      a.priority - b.priority ||
      a.askedAt.localeCompare(b.askedAt) ||
      a.items[0]!.groupId.localeCompare(b.items[0]!.groupId),
  );
  return ranked.flatMap((group) => group.items);
}

/** The caller's to-dos in this space, in panel order. */
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
  return orderUserTodos(rows.map(userTodoDto));
}

/**
 * Whether the global pause holds work now. A `checking` to-do's check run is then queued and held
 * until resume, so the panel says it waits rather than that it is being checked.
 */
export async function userTodoChecksHeld(
  prisma: Pick<PrismaClient, "$queryRaw">,
): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ active: boolean }>>`
    SELECT "active" FROM "maintenance_state" WHERE "id" = 'default'`;
  return rows[0]?.active === true;
}

/** Every to-do of one tracker case in the caller's space, all statuses, in panel order. */
export async function listUserTodosForCase(
  prisma: PrismaClient,
  actor: Pick<Actor, "spaceId" | "userId">,
  caseRef: number,
): Promise<UserTodo[]> {
  const rows = await prisma.userTodo.findMany({
    where: { spaceId: actor.spaceId, userId: actor.userId, caseRef },
    include: { bot: { select: { name: true } } },
  });
  return orderUserTodos(rows.map(userTodoDto));
}

/** Whitespace-only edits to the steps are not a material change. */
function stepsKey(steps: string): string {
  return steps.trim().replace(/\s+/g, " ");
}

export interface ChosenUserTodo {
  id: string;
  title: string;
  status: string;
  position: number;
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
    priority: input.prerequisites.priority ?? null,
    caseRef: input.prerequisites.caseRef ?? null,
  };
  const chosen: ChosenUserTodo[] = [];
  // Key order, so two answers sharing requirements lock their rows in the same order.
  const items = input.prerequisites.items
    .map((item, position) => ({ ...item, position }))
    .sort((a, b) => a.key.localeCompare(b.key));
  for (const item of items) {
    const fields = {
      title: item.title,
      steps: item.steps,
      why: item.why ?? null,
      blocks: item.blocks ?? [],
      verification: item.verification,
      position: item.position,
    };
    // Concurrent answers for one requirement: the insert races on the unique key, never fails.
    const created = await tx.userTodo.createMany({
      data: [
        {
          spaceId: input.spaceId,
          ...source,
          requirementKey: item.key,
          ...fields,
        },
      ],
      skipDuplicates: true,
    });
    const key = { spaceId_requirementKey: { spaceId: input.spaceId, requirementKey: item.key } };
    if (created.count === 1) {
      const row = await tx.userTodo.findUniqueOrThrow({ where: key, select: { id: true } });
      chosen.push({ id: row.id, title: item.title, status: "open", position: item.position });
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
      JSON.stringify(existing.blocks) !== JSON.stringify(fields.blocks) ||
      existing.caseRef !== source.caseRef ||
      existing.sourceMessageId !== input.sourceMessageId;
    const updated = await tx.userTodo.update({
      where: { id: existing.id },
      data: {
        ...source,
        ...fields,
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
    chosen.push({
      id: existing.id,
      title: item.title,
      status: updated.status,
      position: item.position,
    });
  }
  return chosen.sort((a, b) => a.position - b.position);
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
