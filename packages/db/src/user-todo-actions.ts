import { createHash } from "node:crypto";
import type { Actor, UserTodo, UserTodoStatus } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./client.js";
import { sendUserMessageInTransaction } from "./events.js";
import { userTodoDto } from "./user-todos.js";

/** The to-do changed since the caller read it, or is not in a state that takes the action. */
export class UserTodoConflictError extends Error {
  constructor() {
    super("This to-do changed. Refresh and try again.");
    this.name = "UserTodoConflictError";
  }
}

export class UserTodoNotFoundError extends Error {
  constructor() {
    super("To-do not found");
    this.name = "UserTodoNotFoundError";
  }
}

/** A message the to-do posted to its bot's thread; the caller notifies and wakes after commit. */
export interface UserTodoWake {
  threadId: string;
  seq: number;
  /** Set when the message started a new queued run rather than steering or queueing behind one. */
  startedRunId: string | null;
}

export interface UserTodoActionResult {
  todo: UserTodo;
  /** The check request, or the release message when this action satisfied its group. */
  wake: UserTodoWake | null;
}

const CHECKABLE: UserTodoStatus[] = ["open", "checking", "remaining", "unavailable"];
const CONFIRMABLE: UserTodoStatus[] = ["open", "remaining", "unavailable"];
const REPORTABLE: UserTodoStatus[] = ["open", "checking"];
const SATISFIED: readonly string[] = ["verified", "confirmed"] satisfies UserTodoStatus[];

export const TODO_EVIDENCE_MAX_LENGTH = 4000;
export const TODO_DETAIL_MAX_LENGTH = 1000;

const include = { bot: { select: { name: true } } } as const;
type TodoRow = Prisma.UserTodoGetPayload<{ include: typeof include }>;

/**
 * Locks the to-do's thread before its row, the same order as an answer that refreshes it, then
 * applies `data` only if the row is still at `revision` and `where` holds. Every item of a group
 * comes from one card in one thread, so the thread lock also serializes the group's release.
 */
async function casUserTodo(
  tx: Prisma.TransactionClient,
  todo: { id: string; threadId: string; revision: number },
  where: Prisma.UserTodoWhereInput,
  data: Prisma.UserTodoUpdateManyMutationInput,
): Promise<TodoRow | null> {
  await tx.$queryRaw`SELECT id FROM threads WHERE id = ${todo.threadId} FOR UPDATE`;
  const updated = await tx.userTodo.updateMany({
    where: { ...where, id: todo.id, revision: todo.revision },
    data: { ...data, revision: { increment: 1 } },
  });
  if (updated.count !== 1) return null;
  return tx.userTodo.findUniqueOrThrow({ where: { id: todo.id }, include });
}

/** One user-visible message to the to-do's bot through the ordinary send path. */
async function postToBot(
  tx: Prisma.TransactionClient,
  todo: { spaceId: string; threadId: string; botId: string; userId: string },
  clientNonce: string,
  text: string,
): Promise<UserTodoWake> {
  const sent = await sendUserMessageInTransaction(tx, {
    spaceId: todo.spaceId,
    threadId: todo.threadId,
    botId: todo.botId,
    userId: todo.userId,
    blocks: [{ kind: "text", text }],
    prompt: text,
    trigger: "follow_up",
    clientNonce,
  });
  return { threadId: todo.threadId, seq: sent.event.seq, startedRunId: sent.run?.id ?? null };
}

function satisfaction(row: { id: string; title: string; status: string; evidence: string | null }) {
  return row.status === "verified"
    ? `“${row.title}” (to-do ${row.id}) was verified: ${row.evidence ?? ""}`
    : `“${row.title}” (to-do ${row.id}) was confirmed done by the user (their word; not checked by you)`;
}

const RELEASE_NOTE =
  "This approves nothing else: any approval that work needs is still asked for as usual.";

/**
 * Releases the work a change to `row` satisfied, at most once per satisfaction. `each`: a newly
 * satisfied item wakes its bot, naming it. `all`: the group wakes its bot once, when every item
 * not retired is satisfied, listing them. `releasedRevision` marks what already woke the bot.
 */
async function releaseSatisfied(
  tx: Prisma.TransactionClient,
  row: TodoRow,
): Promise<UserTodoWake | null> {
  if (row.release === "each") {
    if (!SATISFIED.includes(row.status) || row.releasedRevision === row.revision) return null;
    await tx.userTodo.update({
      where: { id: row.id },
      data: { releasedRevision: row.revision },
    });
    return postToBot(
      tx,
      row,
      `todo:${row.id}:release:${row.revision}`,
      `Prerequisite satisfied: my to-do ${satisfaction(row)}. Continue the work that needed only this item. ${RELEASE_NOTE}`,
    );
  }
  const group = await tx.userTodo.findMany({
    where: {
      spaceId: row.spaceId,
      sourceMessageId: row.sourceMessageId,
      status: { not: "retired" },
    },
    orderBy: { createdAt: "asc" },
  });
  if (
    group.length === 0 ||
    !group.every((item) => SATISFIED.includes(item.status)) ||
    group.every((item) => item.releasedRevision === item.revision)
  ) {
    return null;
  }
  for (const item of group) {
    await tx.userTodo.update({
      where: { id: item.id },
      data: { releasedRevision: item.revision },
    });
  }
  // The nonce names the exact satisfactions released, so a retry cannot post a second message.
  const satisfied = createHash("sha256")
    .update(group.map((item) => `${item.id}:${item.revision}`).join(","))
    .digest("hex")
    .slice(0, 24);
  return postToBot(
    tx,
    row,
    `todo-group:${row.sourceMessageId}:release:${satisfied}`,
    [
      "All prerequisites satisfied:",
      ...group.map((item) => `- my to-do ${satisfaction(item)}`),
      `Continue the work that was waiting for them. ${RELEASE_NOTE}`,
    ].join("\n"),
  );
}

async function ownedTodo(
  prisma: PrismaClient,
  actor: Pick<Actor, "spaceId" | "userId">,
  todoId: string,
) {
  const todo = await prisma.userTodo.findFirst({
    where: { id: todoId, spaceId: actor.spaceId, userId: actor.userId },
  });
  if (!todo) throw new UserTodoNotFoundError();
  return todo;
}

/**
 * Done — check now: marks an automatic to-do `checking` and asks its bot, in a normal message
 * to its thread, to verify the steps with its own read-only tools and call `todo_report`.
 */
export async function requestUserTodoCheck(
  prisma: PrismaClient,
  actor: Pick<Actor, "spaceId" | "userId">,
  input: { todoId: string; revision: number },
): Promise<UserTodoActionResult> {
  const todo = await ownedTodo(prisma, actor, input.todoId);
  return prisma.$transaction(async (tx) => {
    const row = await casUserTodo(
      tx,
      { ...todo, revision: input.revision },
      { verification: "automatic", status: { in: CHECKABLE } },
      { status: "checking", statusDetail: null, checkRequestedAt: new Date() },
    );
    if (!row) throw new UserTodoConflictError();
    const text = [
      `Please check my to-do “${row.title}” (to-do ${row.id}). I say I did these steps:`,
      row.steps,
      `Verify with your own read-only tools whether this is actually done; do not change anything to make it pass. Then call todo_report with todo_id "${row.id}" and outcome "verified" only with positive evidence it is done, "remaining" if you checked and it is not done (name the remaining step), or "unavailable" if you could not check. Put what you observed in evidence.`,
    ].join("\n\n");
    const wake = await postToBot(tx, row, `todo:${row.id}:check:${row.revision}`, text);
    return { todo: userTodoDto(row), wake };
  });
}

/** I did it: the user's own confirmation of a manual to-do no bot can check. */
export async function confirmUserTodo(
  prisma: PrismaClient,
  actor: Pick<Actor, "spaceId" | "userId">,
  input: { todoId: string; revision: number },
): Promise<UserTodoActionResult> {
  const todo = await ownedTodo(prisma, actor, input.todoId);
  return prisma.$transaction(async (tx) => {
    const row = await casUserTodo(
      tx,
      { ...todo, revision: input.revision },
      { verification: "manual", status: { in: CONFIRMABLE } },
      {
        status: "confirmed",
        statusDetail: null,
        evidence: "Confirmed by the user; not verified by a check.",
        checkedAt: new Date(),
      },
    );
    if (!row) throw new UserTodoConflictError();
    return { todo: userTodoDto(row), wake: await releaseSatisfied(tx, row) };
  });
}

export type UserTodoReportOutcome = "verified" | "remaining" | "unavailable";

/**
 * `todo_report`: the requesting bot's verification result. Only that bot, only while the to-do is
 * open or checking, and only against the revision it read. `verified` releases the work it
 * satisfies; `remaining` and `unavailable` record why it is not done or could not be checked.
 */
export async function reportUserTodo(
  prisma: PrismaClient,
  input: {
    spaceId: string;
    botId: string;
    todoId: string;
    outcome: UserTodoReportOutcome;
    evidence: string;
    remainingStep?: string;
    /** The revision the reporter read; defaults to the current one (a read-then-CAS). */
    expectedRevision?: number;
  },
): Promise<UserTodoActionResult | { error: string }> {
  const evidence = input.evidence.trim();
  const remainingStep = input.remainingStep?.trim() ?? "";
  if (!evidence) return { error: "evidence is required: say what you observed." };
  if (evidence.length > TODO_EVIDENCE_MAX_LENGTH)
    return { error: `evidence must be at most ${TODO_EVIDENCE_MAX_LENGTH} characters.` };
  if (input.outcome === "remaining" && !remainingStep)
    return { error: "remaining_step is required when the outcome is remaining." };
  if (remainingStep.length > TODO_DETAIL_MAX_LENGTH)
    return { error: `remaining_step must be at most ${TODO_DETAIL_MAX_LENGTH} characters.` };
  const todo = await prisma.userTodo.findFirst({
    where: { id: input.todoId, spaceId: input.spaceId, botId: input.botId },
  });
  if (!todo) return { error: "To-do not found, or it belongs to another bot." };
  const outcome = input.outcome;
  const detail =
    outcome === "remaining"
      ? remainingStep
      : outcome === "unavailable"
        ? evidence.slice(0, TODO_DETAIL_MAX_LENGTH)
        : null;
  return prisma.$transaction(async (tx) => {
    const row = await casUserTodo(
      tx,
      { ...todo, revision: input.expectedRevision ?? todo.revision },
      { botId: input.botId, status: { in: REPORTABLE } },
      { status: outcome, statusDetail: detail, evidence, checkedAt: new Date() },
    );
    if (!row) {
      return {
        error:
          "Not recorded: this to-do changed or is no longer waiting for a check (it may be retired, already verified, or replaced). Do not retry.",
      };
    }
    return { todo: userTodoDto(row), wake: await releaseSatisfied(tx, row) };
  });
}

/**
 * `todo_retire`: the requesting bot withdraws a cancelled or superseded requirement. In an `all`
 * group, retiring the last unsatisfied item releases the rest.
 */
export async function retireUserTodo(
  prisma: PrismaClient,
  input: { spaceId: string; botId: string; todoId: string; reason: string },
): Promise<UserTodoActionResult | { error: string }> {
  const reason = input.reason.trim();
  if (!reason) return { error: "reason is required." };
  if (reason.length > TODO_DETAIL_MAX_LENGTH)
    return { error: `reason must be at most ${TODO_DETAIL_MAX_LENGTH} characters.` };
  const todo = await prisma.userTodo.findFirst({
    where: { id: input.todoId, spaceId: input.spaceId, botId: input.botId },
  });
  if (!todo) return { error: "To-do not found, or it belongs to another bot." };
  return prisma.$transaction(async (tx) => {
    const row = await casUserTodo(
      tx,
      todo,
      { botId: input.botId, status: { not: "retired" } },
      { status: "retired", statusDetail: reason },
    );
    if (!row) return { error: "Not retired: this to-do changed or is already retired." };
    return { todo: userTodoDto(row), wake: await releaseSatisfied(tx, row) };
  });
}
