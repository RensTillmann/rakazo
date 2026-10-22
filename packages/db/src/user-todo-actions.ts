import { createHash } from "node:crypto";
import type { Actor, UserTodo, UserTodoStatus } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { CaseCoordination } from "./case-coordinators.js";
import { caseCoordinatorOf } from "./case-coordinators.js";
import type { Prisma, PrismaClient } from "./client.js";
import { sendUserMessageInTransaction } from "./events.js";
import { lockMaintenanceAdmission } from "./maintenance.js";
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

/** The one transition into `checking`, shared by Done — check now and the hourly sweep. */
async function beginUserTodoCheck(
  tx: Prisma.TransactionClient,
  todo: { id: string; threadId: string; revision: number },
  where: Prisma.UserTodoWhereInput,
  now: Date,
): Promise<TodoRow | null> {
  return casUserTodo(
    tx,
    todo,
    { ...where, verification: "automatic" },
    { status: "checking", statusDetail: null, checkRequestedAt: now },
  );
}

/** What every check asks of the checking bot; the result goes through `todo_report` only. */
function checkInstructions(row: { id: string }): string {
  return `Verify with your own read-only tools whether this is actually done; do not change anything to make it pass. Then call todo_report with todo_id "${row.id}" and outcome "verified" only with positive evidence it is done, "remaining" if you checked and it is not done (name the remaining step), or "unavailable" if you could not check. Put what you observed in evidence.`;
}

/** The run tag that names the to-do and the revision a check run checks. */
export function todoCheckRunNonce(todo: { id: string; revision: number }): string {
  return `todo-check:${todo.id}:${todo.revision}`;
}

/** The to-do and revision a `todo_check` run checks, from its tag; null for any other run. */
export function todoCheckRunTarget(
  clientNonce: string | null | undefined,
): { todoId: string; revision: number } | null {
  const match = /^todo-check:(.+):(\d+)$/.exec(clientNonce ?? "");
  return match ? { todoId: match[1]!, revision: Number(match[2]) } : null;
}

/**
 * Who checks a to-do: its case's coordinator (`caseCoordinatorOf`); without a case, or with no
 * coordinator configured, the bot that asked.
 */
export async function userTodoCheckerBotId(
  db: Pick<Prisma.TransactionClient, "bot">,
  todo: { spaceId: string; userId: string; botId: string; caseRef: number | null },
  coordination: CaseCoordination,
): Promise<string> {
  if (todo.caseRef === null || coordination.caseCoordinators.length === 0) return todo.botId;
  const bots = await db.bot.findMany({
    where: { spaceId: todo.spaceId, userId: todo.userId, archivedAt: null },
    select: { id: true, name: true },
  });
  return caseCoordinatorOf(bots, coordination, todo.botId)?.id ?? todo.botId;
}

/**
 * Starts the one kind of check, for Done — check now and the hourly sweep alike: a queued,
 * context-bounded, read-only `todo_check` run of the to-do's checker in its own thread. The prompt
 * carries only the to-do, why it is needed, its steps and its last result, never a conversation.
 * The run reports through `todo_report`. Queued like any work, it is held while the pause holds.
 */
async function startTodoCheckRun(
  tx: Prisma.TransactionClient,
  row: TodoRow,
  heading: string,
  coordination: CaseCoordination,
): Promise<string | null> {
  const checkerId = await userTodoCheckerBotId(tx, row, coordination);
  const checker = await tx.bot.findFirst({
    where: { id: checkerId, spaceId: row.spaceId, archivedAt: null },
    select: { id: true, thread: { select: { id: true } } },
  });
  if (!checker?.thread) return null;
  const prompt = [
    `${heading} of the user's to-do “${row.title}” (to-do ${row.id}), asked by ${row.bot.name}. Only this to-do matters here; nothing else is asked of you.`,
    ...(row.why ? [`Why it is needed: ${row.why}`] : []),
    `The steps the user was asked to do:\n${row.steps}`,
    ...(row.evidence ? [`Last result: ${row.evidence}`] : []),
    checkInstructions(row),
    "This check is read-only: actions that change anything are refused. Do not message the user.",
  ].join("\n\n");
  const task = await tx.task.create({
    data: {
      spaceId: row.spaceId,
      botId: checker.id,
      threadId: checker.thread.id,
      userId: row.userId,
      prompt,
      status: "queued",
    },
  });
  const run = await tx.run.create({
    data: {
      spaceId: row.spaceId,
      botId: checker.id,
      threadId: checker.thread.id,
      taskId: task.id,
      userId: row.userId,
      status: "queued",
      trigger: "todo_check",
      clientNonce: todoCheckRunNonce(row),
    },
  });
  return run.id;
}

/** Done — check now: the to-do, now `checking`, and the check run to enqueue after commit. */
export interface UserTodoCheckResult {
  todo: UserTodo;
  checkRunId: string | null;
}

/**
 * Done — check now: marks an automatic to-do `checking` and starts its bounded, read-only check
 * at once, the same run the hourly sweep starts. During the global pause the run stays queued and
 * is held like any other work until resume; nothing runs.
 */
export async function requestUserTodoCheck(
  prisma: PrismaClient,
  actor: Pick<Actor, "spaceId" | "userId">,
  input: { todoId: string; revision: number },
  coordination: CaseCoordination,
): Promise<UserTodoCheckResult> {
  const todo = await ownedTodo(prisma, actor, input.todoId);
  return prisma.$transaction(async (tx) => {
    const row = await beginUserTodoCheck(
      tx,
      { ...todo, revision: input.revision },
      { status: { in: CHECKABLE } },
      new Date(),
    );
    if (!row) throw new UserTodoConflictError();
    return {
      todo: userTodoDto(row),
      checkRunId: await startTodoCheckRun(
        tx,
        row,
        "Check, asked by the user just now,",
        coordination,
      ),
    };
  });
}

/** How long a pending automatic to-do waits between scheduled checks. */
export const USER_TODO_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * The hourly sweep: every automatic to-do still pending (open, remaining, unavailable) whose last
 * check request (or creation) is an hour old, and every check that has not reported for an hour
 * and has no check run still waiting, goes to `checking` through the same transition as Done —
 * check now and gets the same bounded `todo_check` run of its case coordinator. Manual to-dos are
 * never swept, so they cost no model call. Nothing starts while the global pause holds admission.
 * Returns the runs started; the caller enqueues them.
 */
export async function sweepUserTodoChecks(
  prisma: PrismaClient,
  coordination: CaseCoordination,
  options: { now?: Date; limit?: number; spaceId?: string } = {},
): Promise<string[]> {
  const now = options.now ?? new Date();
  const before = new Date(now.getTime() - USER_TODO_SWEEP_INTERVAL_MS);
  const due: Prisma.UserTodoWhereInput = {
    verification: "automatic",
    bot: { archivedAt: null },
    ...(options.spaceId ? { spaceId: options.spaceId } : {}),
    OR: [
      {
        status: { in: ["open", "remaining", "unavailable"] },
        OR: [
          { checkRequestedAt: { lte: before } },
          { checkRequestedAt: null, createdAt: { lte: before } },
        ],
      },
      { status: "checking", checkRequestedAt: { lte: before } },
    ],
  };
  const candidates = await prisma.userTodo.findMany({
    where: due,
    orderBy: [{ checkRequestedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
    take: options.limit ?? 20,
    select: { id: true, threadId: true, revision: true, status: true },
  });
  const started: string[] = [];
  for (const candidate of candidates) {
    const runId = await prisma.$transaction(async (tx) => {
      // Under the same admission lock a pause takes: nothing new starts once it holds.
      if (!(await lockMaintenanceAdmission(tx)).admitted) return "paused" as const;
      // A check run of this revision still queued or running (a check-now held by the pause)
      // is not repeated.
      const waiting = await tx.run.count({
        where: {
          trigger: "todo_check",
          clientNonce: todoCheckRunNonce(candidate),
          status: { in: [...ACTIVE_RUN_STATUSES] },
        },
      });
      if (waiting > 0) return null;
      const row = await beginUserTodoCheck(tx, candidate, due, now);
      if (!row) return null;
      return startTodoCheckRun(tx, row, "Scheduled check", coordination);
    });
    if (runId === "paused") break;
    if (runId) started.push(runId);
  }
  return started;
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
  coordination: CaseCoordination,
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
    where: { id: input.todoId, spaceId: input.spaceId },
  });
  // The bot that asked, or the case coordinator that checks it for that bot.
  const allowed =
    todo &&
    (todo.botId === input.botId ||
      (await userTodoCheckerBotId(prisma, todo, coordination)) === input.botId);
  if (!todo || !allowed) return { error: "To-do not found, or it belongs to another bot." };
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
      { botId: todo.botId, status: { in: REPORTABLE } },
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
 * `todo_retire`: the requesting bot withdraws a cancelled or superseded requirement. It releases
 * nothing, even when it was the last open item of an `all` group: the bot retiring it is the one
 * running now and decides itself whether its case still needs the work (ADR Q12/Q22); a release
 * telling it to continue could revive work for a case that has ended.
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
    return { todo: userTodoDto(row), wake: null };
  });
}

const RETIRABLE_FOR_CASE: UserTodoStatus[] = ["open", "checking", "remaining", "unavailable"];

/**
 * The tracker case ended or no longer needs its to-dos: each of the case's open, checking,
 * remaining or unavailable to-dos is retired with `reason` through the same compare-and-set as
 * `todo_retire` (status `retired`, the reason as its detail, a new revision). Verified, confirmed
 * and already retired ones stay as they are; nothing is deleted. Unlike `todo_retire` it releases
 * no work: the case itself is over. A check that was running is retired too; its later report is
 * refused. Idempotent: a repeat retires nothing. Returns the to-dos this call retired.
 */
export async function retireUserTodosForCase(
  prisma: PrismaClient,
  actor: Pick<Actor, "spaceId" | "userId">,
  input: { caseRef: number; reason: string },
): Promise<UserTodo[]> {
  const reason = input.reason.trim();
  const candidates = await prisma.userTodo.findMany({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      caseRef: input.caseRef,
      status: { in: RETIRABLE_FOR_CASE },
    },
    select: { id: true, threadId: true },
    orderBy: { createdAt: "asc" },
  });
  const retired: UserTodo[] = [];
  for (const candidate of candidates) {
    const row = await prisma.$transaction(async (tx) => {
      // Every to-do write takes its thread lock first, so the row read under it is current.
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${candidate.threadId} FOR UPDATE`;
      const current = await tx.userTodo.findFirst({
        where: { id: candidate.id, caseRef: input.caseRef, status: { in: RETIRABLE_FOR_CASE } },
        select: { id: true, threadId: true, revision: true },
      });
      if (!current) return null;
      return casUserTodo(
        tx,
        current,
        { status: { in: RETIRABLE_FOR_CASE } },
        { status: "retired", statusDetail: reason },
      );
    });
    if (row) retired.push(userTodoDto(row));
  }
  return retired;
}
