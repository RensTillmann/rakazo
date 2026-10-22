import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  type AskPrerequisite,
  MessageBlock,
  type PrerequisitePriority,
  type PrerequisiteRelease,
  type UserTodo,
} from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { answerRunInput } from "./events.js";
import { lockMaintenanceAdmission } from "./maintenance.js";
import { createThreadMessage } from "./messages.js";
import { noCoordinators } from "./testing.js";
import {
  confirmUserTodo,
  reportUserTodo,
  requestUserTodoCheck,
  retireUserTodo,
  retireUserTodosForCase,
  sweepUserTodoChecks,
  UserTodoConflictError,
} from "./user-todo-actions.js";
import { listUserTodos, listUserTodosForCase } from "./user-todos.js";

// Fully migrated disposable local database only (VERIFY_DATABASE + DATABASE_URL).
const enabled = process.env.VERIFY_DATABASE && process.env.DATABASE_URL;
const postgres = enabled ? describe.sequential : describe.skip;

const ACCESS: AskPrerequisite = {
  key: "github-access:acme/site:write",
  title: "Give Elena write access to acme/site",
  steps: "Open github.com/acme/site/settings/access.\nInvite elena-bot with Write role.",
  verification: "automatic",
};

const BADGE: AskPrerequisite = {
  key: "office-badge:elena",
  title: "Collect Elena's office badge",
  steps: "Pick up the badge at reception and hand it over.",
  why: "Elena cannot enter the office without it.",
  verification: "manual",
};

/** The single block a test message carries, validated against the message contract. */
function onlyBlock(blocks: unknown): MessageBlock {
  const [block] = MessageBlock.array().length(1).parse(blocks);
  return block!;
}

function textOf(blocks: unknown): string {
  const block = onlyBlock(blocks);
  return block.kind === "text" ? block.text : "";
}

/** A tool result that must have succeeded. */
function succeeded<T extends { todo: UserTodo }>(result: T | { error: string }): T {
  if ("error" in result) throw new Error(result.error);
  return result;
}

postgres("manual prerequisite to-dos (PostgreSQL)", () => {
  let db: { prisma: PrismaClient; pool: Pool };
  const spaces: string[] = [];

  beforeAll(() => {
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(new URL(process.env.DATABASE_URL!).hostname)
    ) {
      throw new Error("To-do tests require a disposable local database");
    }
    db = createDb(process.env.DATABASE_URL!);
  });
  afterAll(async () => {
    if (!db) return;
    try {
      await db.prisma.organization.deleteMany({ where: { id: { in: spaces } } });
      await db.prisma.user.deleteMany({ where: { id: { in: spaces } } });
    } finally {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  async function fixture() {
    const prisma = db.prisma;
    const id = randomUUID();
    spaces.push(id);
    await prisma.user.create({ data: { id, name: "To-do fixture", email: `${id}@example.test` } });
    await prisma.organization.create({
      data: { id, name: "Fixture", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id, organizationId: id, name: "Fixture" } });
    await prisma.member.create({
      data: { id, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
    });
    await prisma.spaceMember.create({
      data: {
        id,
        organizationId: id,
        spaceId: id,
        userId: id,
        role: "owner",
        createdAt: new Date(),
      },
    });
    const bot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Elena", color: "test" },
    });
    const other = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Jill", color: "test" },
    });
    const thread = await prisma.thread.create({ data: { spaceId: id, userId: id, botId: bot.id } });
    const actor = { spaceId: id, userId: id };

    /** A paused run with one question card; option 2 is the to-do option when it has items. */
    async function card(
      items?: AskPrerequisite[],
      release: PrerequisiteRelease = "all",
      priority?: PrerequisitePriority,
      caseRef?: number,
    ) {
      const task = await prisma.task.create({
        data: {
          spaceId: id,
          userId: id,
          botId: bot.id,
          threadId: thread.id,
          prompt: "deploy",
          status: "running",
        },
      });
      const run = await prisma.run.create({
        data: {
          spaceId: id,
          userId: id,
          botId: bot.id,
          threadId: thread.id,
          taskId: task.id,
          status: "waiting_input",
          trigger: "user",
        },
      });
      const message = await createThreadMessage(prisma, {
        threadId: thread.id,
        runId: run.id,
        botId: bot.id,
        role: "bot",
        blocks: [
          {
            kind: "ask",
            text: "I need write access to acme/site. How do you want to do it?",
            status: "pending",
            actions: [
              { id: "choice-1", label: "Use a deploy key instead" },
              {
                id: "choice-2",
                label: "I'll do it myself",
                ...(items ? { todo: true } : {}),
              },
            ],
            ...(items
              ? {
                  prerequisites: {
                    items,
                    release,
                    ...(priority ? { priority } : {}),
                    ...(caseRef ? { caseRef } : {}),
                  },
                }
              : {}),
          },
        ],
      });
      const answer = (value: string) =>
        answerRunInput(prisma, {
          spaceId: id,
          threadId: thread.id,
          runId: run.id,
          messageId: message.id,
          answeredByUserId: id,
          answer: value,
        });
      const resumePrompt = async () =>
        (await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).prompt;
      const block = async () =>
        onlyBlock((await prisma.message.findUniqueOrThrow({ where: { id: message.id } })).blocks);
      return { run, message, answer, resumePrompt, block };
    }

    const todos = () => prisma.userTodo.findMany({ where: { spaceId: id } });
    const messagesWithNonce = (prefix: string) =>
      prisma.message.findMany({
        where: { threadId: thread.id, clientNonce: { startsWith: prefix } },
      });
    /** Every release message posted to the bot, per item or per group. */
    const releases = () =>
      prisma.message.findMany({
        where: { threadId: thread.id, clientNonce: { contains: ":release:" } },
        orderBy: { seq: "asc" },
      });
    /** Answer a fresh card with its to-do option; returns the to-do. */
    async function chooseTodo(prerequisite: AskPrerequisite = ACCESS) {
      const asked = await card([prerequisite]);
      expect(await asked.answer("choice-2")).toBe(true);
      return prisma.userTodo.findUniqueOrThrow({
        where: { spaceId_requirementKey: { spaceId: id, requirementKey: prerequisite.key } },
      });
    }
    /** Answers one card carrying both items. */
    async function chooseBoth(release: PrerequisiteRelease) {
      const asked = await card([ACCESS, BADGE], release);
      expect(await asked.answer("choice-2")).toBe(true);
      const rows = await todos();
      const access = rows.find((row) => row.requirementKey === ACCESS.key)!;
      const badge = rows.find((row) => row.requirementKey === BADGE.key)!;
      return { asked, rows, access, badge };
    }
    /** Done — check now, then the bot verifies it. */
    async function verify(todo: { id: string; revision: number }) {
      await requestUserTodoCheck(
        prisma,
        actor,
        { todoId: todo.id, revision: todo.revision },
        noCoordinators,
      );
      return succeeded(
        await reportUserTodo(
          prisma,
          {
            spaceId: id,
            botId: bot.id,
            todoId: todo.id,
            outcome: "verified",
            evidence: "elena-bot has Write on acme/site",
          },
          noCoordinators,
        ),
      );
    }
    return {
      prisma,
      id,
      bot,
      other,
      thread,
      actor,
      card,
      todos,
      messagesWithNonce,
      releases,
      chooseTodo,
      chooseBoth,
      verify,
    };
  }

  it("choosing the to-do option records intent as one open to-do and tells the bot not to ask again", async () => {
    const f = await fixture();
    const asked = await f.card([ACCESS]);
    expect(await asked.answer("choice-2")).toBe(true);

    const [todo, ...rest] = await f.todos();
    expect(rest).toHaveLength(0);
    expect(todo).toMatchObject({
      botId: f.bot.id,
      userId: f.id,
      threadId: f.thread.id,
      runId: asked.run.id,
      sourceMessageId: asked.message.id,
      requirementKey: ACCESS.key,
      title: ACCESS.title,
      steps: ACCESS.steps,
      verification: "automatic",
      status: "open",
      evidence: null,
    });
    // The original answer stays in history; the to-do is not an answer and approves nothing.
    expect(await asked.block()).toMatchObject({ status: "answered", answer: "choice-2" });
    expect(await f.prisma.externalEffect.count({ where: { spaceId: f.id } })).toBe(0);
    const prompt = await asked.resumePrompt();
    expect(prompt).toContain("Selected choice choice-2: I'll do it myself");
    expect(prompt).toContain(`- “${ACCESS.title}” (to-do ${todo!.id})`);
    expect(prompt).toContain("Do not ask about them again");
    expect((await listUserTodos(f.prisma, f.actor)).map((row) => row.id)).toEqual([todo!.id]);
  });

  it("another answer, or a card without a prerequisite, creates nothing", async () => {
    const f = await fixture();
    expect(await (await f.card([ACCESS])).answer("choice-1")).toBe(true);
    expect(await (await f.card()).answer("choice-2")).toBe(true);
    expect(await f.todos()).toHaveLength(0);
  });

  it("a replacement card for the same requirement keeps the to-do's identity and progress", async () => {
    const f = await fixture();
    const first = await f.chooseTodo();
    const checking = await requestUserTodoCheck(
      f.prisma,
      f.actor,
      {
        todoId: first.id,
        revision: first.revision,
      },
      noCoordinators,
    );
    const reported = await reportUserTodo(
      f.prisma,
      {
        spaceId: f.id,
        botId: f.bot.id,
        todoId: first.id,
        outcome: "remaining",
        evidence: "elena-bot is not a collaborator yet",
        remainingStep: "Invite elena-bot with Write role",
      },
      noCoordinators,
    );
    expect(reported).toMatchObject({ todo: { status: "remaining" } });
    expect(checking.todo.status).toBe("checking");

    // Same steps with different whitespace and a new title: not a material change.
    const again = await f.chooseTodo({
      ...ACCESS,
      title: "Write access to acme/site for Elena",
      steps: `  ${ACCESS.steps.replace("\n", "\n\n")}  `,
    });
    expect(again.id).toBe(first.id);
    expect(again).toMatchObject({
      status: "remaining",
      statusDetail: "Invite elena-bot with Write role",
      evidence: "elena-bot is not a collaborator yet",
      title: "Write access to acme/site for Elena",
    });
    expect(await f.todos()).toHaveLength(1);
  });

  it("materially changed steps reset the to-do to open and clear its old evidence", async () => {
    const f = await fixture();
    const first = await f.chooseTodo();
    await requestUserTodoCheck(
      f.prisma,
      f.actor,
      { todoId: first.id, revision: first.revision },
      noCoordinators,
    );
    await reportUserTodo(
      f.prisma,
      {
        spaceId: f.id,
        botId: f.bot.id,
        todoId: first.id,
        outcome: "verified",
        evidence: "elena-bot has Write on acme/site",
      },
      noCoordinators,
    );

    const changed = await f.chooseTodo({
      ...ACCESS,
      steps: "Invite elena-bot with Admin role on acme/site.",
    });
    expect(changed.id).toBe(first.id);
    expect(changed).toMatchObject({
      status: "open",
      statusDetail: null,
      evidence: null,
      checkedAt: null,
      steps: "Invite elena-bot with Admin role on acme/site.",
    });
    expect(changed.revision).toBeGreaterThan(first.revision);
  });

  it("two concurrent 'check now' clicks make one transition and one bounded check run", async () => {
    const f = await fixture();
    const todo = await f.chooseTodo();
    const results = await Promise.allSettled([
      requestUserTodoCheck(
        f.prisma,
        f.actor,
        { todoId: todo.id, revision: todo.revision },
        noCoordinators,
      ),
      requestUserTodoCheck(
        f.prisma,
        f.actor,
        { todoId: todo.id, revision: todo.revision },
        noCoordinators,
      ),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const [failure] = rejected;
    expect(failure?.status === "rejected" && failure.reason).toBeInstanceOf(UserTodoConflictError);

    const row = await f.prisma.userTodo.findUniqueOrThrow({ where: { id: todo.id } });
    expect(row.status).toBe("checking");
    expect(row.revision).toBe(todo.revision + 1);
    expect(row.checkRequestedAt).not.toBeNull();
    // The same read-only todo_check run the hourly sweep starts, not a chat message.
    const checks = await f.prisma.run.findMany({
      where: { spaceId: f.id, trigger: "todo_check" },
      include: { task: { select: { prompt: true } } },
    });
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      status: "queued",
      botId: f.bot.id,
      clientNonce: `todo-check:${todo.id}:${row.revision}`,
    });
    expect(checks[0]!.task.prompt).toContain(ACCESS.steps);
    expect(checks[0]!.task.prompt).toContain(`todo_report with todo_id "${todo.id}"`);
    expect(checks[0]!.task.prompt).not.toContain("How do you want to do it?");
    expect(await f.messagesWithNonce("todo:")).toHaveLength(0);
  });

  it("a check-now during the global pause is held as queued work, not run", async () => {
    const f = await fixture();
    const todo = await f.chooseTodo();
    await f.prisma.$executeRaw`UPDATE maintenance_state SET active = true WHERE id = 'default'`;
    try {
      const { todo: checking } = await requestUserTodoCheck(
        f.prisma,
        f.actor,
        {
          todoId: todo.id,
          revision: todo.revision,
        },
        noCoordinators,
      );
      expect(checking.status).toBe("checking");
      const [run] = await f.prisma.run.findMany({
        where: { spaceId: f.id, trigger: "todo_check" },
      });
      // Queued work is retained by the pause; the worker's admission refuses to claim it.
      expect(run).toMatchObject({ status: "queued", startedAt: null });
      expect((await f.prisma.$transaction((tx) => lockMaintenanceAdmission(tx))).admitted).toBe(
        false,
      );
      // The hourly sweep does not stack a second check on the held one, even after resume.
      await f.prisma.$executeRaw`UPDATE maintenance_state SET active = false WHERE id = 'default'`;
      expect(
        await sweepUserTodoChecks(f.prisma, noCoordinators, {
          spaceId: f.id,
          now: inHours(5),
        }),
      ).toEqual([]);
    } finally {
      await f.prisma.$executeRaw`UPDATE maintenance_state SET active = false WHERE id = 'default'`;
    }
  });

  it("a case to-do another bot asked is checked by the case coordinator, who may report it", async () => {
    const f = await fixture();
    const josy = await f.prisma.bot.create({
      data: { spaceId: f.id, userId: f.id, name: "Josy", color: "test" },
    });
    await f.prisma.thread.create({ data: { spaceId: f.id, userId: f.id, botId: josy.id } });
    const coordination = {
      caseCoordinators: ["josy", "Elena-coordinator"],
      fleetCoordinator: null,
    };
    const asked = await f.card([ACCESS], "all", undefined, 383);
    expect(await asked.answer("choice-2")).toBe(true);
    const todo = (await f.todos())[0]!;
    const { checkRunId } = await requestUserTodoCheck(
      f.prisma,
      f.actor,
      { todoId: todo.id, revision: todo.revision },
      coordination,
    );
    const run = await f.prisma.run.findUniqueOrThrow({ where: { id: checkRunId! } });
    expect(run.botId).toBe(josy.id);
    const report = (botId: string) =>
      reportUserTodo(
        f.prisma,
        {
          spaceId: f.id,
          botId,
          todoId: todo.id,
          outcome: "remaining",
          evidence: "elena-bot is not a collaborator",
          remainingStep: "Invite elena-bot",
        },
        coordination,
      );
    expect(await report(f.other.id)).toHaveProperty("error");
    expect(await report(josy.id)).toMatchObject({ todo: { status: "remaining" } });
  });

  it("todo_report only takes the requesting bot's report against the current revision", async () => {
    const f = await fixture();
    const todo = await f.chooseTodo();
    const { todo: checking } = await requestUserTodoCheck(
      f.prisma,
      f.actor,
      {
        todoId: todo.id,
        revision: todo.revision,
      },
      noCoordinators,
    );

    expect(
      await reportUserTodo(
        f.prisma,
        {
          spaceId: f.id,
          botId: f.other.id,
          todoId: todo.id,
          outcome: "verified",
          evidence: "looks fine",
        },
        noCoordinators,
      ),
    ).toHaveProperty("error");
    expect(
      await reportUserTodo(
        f.prisma,
        {
          spaceId: f.id,
          botId: f.bot.id,
          todoId: todo.id,
          outcome: "verified",
          evidence: "looks fine",
          expectedRevision: todo.revision,
        },
        noCoordinators,
      ),
    ).toHaveProperty("error");
    expect((await f.prisma.userTodo.findUniqueOrThrow({ where: { id: todo.id } })).status).toBe(
      "checking",
    );

    const accepted = await reportUserTodo(
      f.prisma,
      {
        spaceId: f.id,
        botId: f.bot.id,
        todoId: todo.id,
        outcome: "verified",
        evidence: "elena-bot has Write on acme/site",
        expectedRevision: checking.revision,
      },
      noCoordinators,
    );
    expect(accepted).toMatchObject({
      todo: { status: "verified", evidence: "elena-bot has Write on acme/site" },
    });
  });

  it("'couldn't check' stays distinct from 'checked, still to do'", async () => {
    const f = await fixture();
    const todo = await f.chooseTodo();
    await requestUserTodoCheck(
      f.prisma,
      f.actor,
      { todoId: todo.id, revision: todo.revision },
      noCoordinators,
    );
    const unavailable = await reportUserTodo(
      f.prisma,
      {
        spaceId: f.id,
        botId: f.bot.id,
        todoId: todo.id,
        outcome: "unavailable",
        evidence: "GitHub API timed out",
      },
      noCoordinators,
    );
    expect(unavailable).toMatchObject({
      todo: { status: "unavailable", statusDetail: "GitHub API timed out" },
      wake: null,
    });
    // Unavailable is not a failed check: the user can ask again, and the bot then reports.
    const again = await requestUserTodoCheck(
      f.prisma,
      f.actor,
      {
        todoId: todo.id,
        revision: succeeded(unavailable).todo.revision,
      },
      noCoordinators,
    );
    const remaining = await reportUserTodo(
      f.prisma,
      {
        spaceId: f.id,
        botId: f.bot.id,
        todoId: todo.id,
        outcome: "remaining",
        evidence: "elena-bot has Read, not Write",
        remainingStep: "Change elena-bot's role to Write",
      },
      noCoordinators,
    );
    expect(again.todo.status).toBe("checking");
    expect(remaining).toMatchObject({
      todo: {
        status: "remaining",
        statusDetail: "Change elena-bot's role to Write",
        evidence: "elena-bot has Read, not Write",
      },
      wake: null,
    });
    expect(await f.releases()).toHaveLength(0);
  });

  it("a manual to-do is confirmed by the user, labelled as such, and releases its bot once", async () => {
    const f = await fixture();
    const todo = await f.chooseTodo({
      ...ACCESS,
      key: "phone-call:bank",
      title: "Call the bank about the transfer limit",
      steps: "Call the bank and raise the daily transfer limit.",
      verification: "manual",
    });
    await expect(
      requestUserTodoCheck(
        f.prisma,
        f.actor,
        { todoId: todo.id, revision: todo.revision },
        noCoordinators,
      ),
    ).rejects.toBeInstanceOf(UserTodoConflictError);

    const confirmed = await confirmUserTodo(f.prisma, f.actor, {
      todoId: todo.id,
      revision: todo.revision,
    });
    expect(confirmed.todo).toMatchObject({
      status: "confirmed",
      evidence: "Confirmed by the user; not verified by a check.",
    });
    await expect(
      confirmUserTodo(f.prisma, f.actor, { todoId: todo.id, revision: confirmed.todo.revision }),
    ).rejects.toBeInstanceOf(UserTodoConflictError);
    const releases = await f.releases();
    expect(releases).toHaveLength(1);
    const text = textOf(releases[0]!.blocks);
    expect(text).toContain("confirmed done by the user");
    expect(text).toContain("approves nothing else");
  });

  it("a retired to-do is no longer actionable", async () => {
    const f = await fixture();
    const todo = await f.chooseTodo();
    expect(
      await retireUserTodo(f.prisma, {
        spaceId: f.id,
        botId: f.other.id,
        todoId: todo.id,
        reason: "not mine",
      }),
    ).toHaveProperty("error");
    const retired = await retireUserTodo(f.prisma, {
      spaceId: f.id,
      botId: f.bot.id,
      todoId: todo.id,
      reason: "The case was cancelled",
    });
    expect(retired).toMatchObject({
      todo: { status: "retired", statusDetail: "The case was cancelled" },
    });
    const revision = succeeded(retired).todo.revision;
    await expect(
      requestUserTodoCheck(f.prisma, f.actor, { todoId: todo.id, revision }, noCoordinators),
    ).rejects.toBeInstanceOf(UserTodoConflictError);
    expect(
      await reportUserTodo(
        f.prisma,
        {
          spaceId: f.id,
          botId: f.bot.id,
          todoId: todo.id,
          outcome: "verified",
          evidence: "done",
        },
        noCoordinators,
      ),
    ).toHaveProperty("error");
    expect(
      await retireUserTodo(f.prisma, {
        spaceId: f.id,
        botId: f.bot.id,
        todoId: todo.id,
        reason: "again",
      }),
    ).toHaveProperty("error");
    expect((await listUserTodos(f.prisma, f.actor))[0]).toMatchObject({ status: "retired" });
  });

  it("a verified to-do posts exactly one release message to its bot", async () => {
    const f = await fixture();
    const todo = await f.chooseTodo();
    const { checkRunId } = await requestUserTodoCheck(
      f.prisma,
      f.actor,
      { todoId: todo.id, revision: todo.revision },
      noCoordinators,
    );
    const report = () =>
      reportUserTodo(
        f.prisma,
        {
          spaceId: f.id,
          botId: f.bot.id,
          todoId: todo.id,
          outcome: "verified",
          evidence: "elena-bot has Write on acme/site",
        },
        noCoordinators,
      );
    const results = await Promise.all([report(), report()]);
    expect(results.filter((result) => "todo" in result)).toHaveLength(1);
    expect(await report()).toHaveProperty("error");

    const releases = await f.releases();
    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({ role: "user" });
    const text = textOf(releases[0]!.blocks);
    expect(text).toContain(`“${ACCESS.title}” (to-do ${todo.id}) was verified`);
    // The release is an ordinary message to the bot: it starts or joins the bot's normal work.
    const released = await f.prisma.message.findUniqueOrThrow({ where: { id: releases[0]!.id } });
    const steered = await f.prisma.steeringMessage.count({ where: { messageId: released.id } });
    const started = await f.prisma.run.count({ where: { sourceMessageId: released.id } });
    expect(steered + started).toBe(1);
    // Queued behind the check run, it still shows in the chat: neither the message nor its live
    // event belongs to the background check, whose own steps the transcript hides.
    expect(released.runId).not.toBe(checkRunId);
    const created = await f.prisma.event.findFirstOrThrow({
      where: {
        type: "thread.message.created",
        payload: { path: ["messageId"], equals: released.id },
      },
    });
    expect(created.runId).not.toBe(checkRunId);
  });

  it("one card creates one to-do per item, grouped by the card", async () => {
    const f = await fixture();
    const { asked, rows } = await f.chooseBoth("all");
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({
        sourceMessageId: asked.message.id,
        groupTitle: "I need write access to acme/site. How do you want to do it?",
        release: "all",
        status: "open",
      });
    }
    const listed = await listUserTodos(f.prisma, f.actor);
    expect(new Set(listed.map((todo) => todo.groupId))).toEqual(new Set([asked.message.id]));
    expect(listed.find((todo) => todo.requirementKey === BADGE.key)).toMatchObject({
      why: BADGE.why,
      caseRef: null,
    });
    expect(listed.find((todo) => todo.requirementKey === ACCESS.key)?.why).toBeNull();
    const prompt = await asked.resumePrompt();
    expect(prompt).toContain(ACCESS.title);
    expect(prompt).toContain(BADGE.title);
    expect(prompt).toContain("you get one message then");
  });

  it("release 'all' wakes the bot exactly once, when the last item is satisfied", async () => {
    const f = await fixture();
    const { access, badge } = await f.chooseBoth("all");
    expect((await f.verify(access)).wake).toBeNull();
    expect(await f.releases()).toHaveLength(0);

    const confirmed = await confirmUserTodo(f.prisma, f.actor, {
      todoId: badge.id,
      revision: badge.revision,
    });
    expect(confirmed.wake).not.toBeNull();
    const releases = await f.releases();
    expect(releases).toHaveLength(1);
    const text = textOf(releases[0]!.blocks);
    expect(text).toContain("All prerequisites satisfied");
    expect(text).toContain(`${ACCESS.title}” (to-do ${access.id}) was verified`);
    expect(text).toContain(`${BADGE.title}” (to-do ${badge.id}) was confirmed done by the user`);

    // Retiring a satisfied item afterwards releases nothing again.
    succeeded(
      await retireUserTodo(f.prisma, {
        spaceId: f.id,
        botId: f.bot.id,
        todoId: badge.id,
        reason: "superseded",
      }),
    );
    expect(await f.releases()).toHaveLength(1);
  });

  it("retiring the last open item of an 'all' card wakes nothing: the retiring bot decides", async () => {
    const f = await fixture();
    const { access, badge } = await f.chooseBoth("all");
    await f.verify(access);
    const retired = succeeded(
      await retireUserTodo(f.prisma, {
        spaceId: f.id,
        botId: f.bot.id,
        todoId: badge.id,
        reason: "Badge no longer needed",
      }),
    );
    expect(retired.wake).toBeNull();
    // No "continue the work" message: the case may have ended with the requirement.
    expect(await f.releases()).toHaveLength(0);
    expect(await f.prisma.run.count({ where: { spaceId: f.id, trigger: "follow_up" } })).toBe(0);
  });

  it("release 'each' wakes the bot once per satisfied item, naming it", async () => {
    const f = await fixture();
    const { access, badge } = await f.chooseBoth("each");
    expect((await f.verify(access)).wake).not.toBeNull();
    let releases = await f.releases();
    expect(releases).toHaveLength(1);
    expect(textOf(releases[0]!.blocks)).toContain(`${ACCESS.title}” (to-do ${access.id})`);
    expect(textOf(releases[0]!.blocks)).not.toContain(BADGE.title);

    const confirm = () =>
      confirmUserTodo(f.prisma, f.actor, { todoId: badge.id, revision: badge.revision });
    const settled = await Promise.allSettled([confirm(), confirm()]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    releases = await f.releases();
    expect(releases).toHaveLength(2);
    expect(textOf(releases[1]!.blocks)).toContain(`${BADGE.title}” (to-do ${badge.id})`);
  });

  it("orders cards by blocking, then priority, then age, and keeps the bot's item order", async () => {
    const f = await fixture();
    const item = (key: string, extra: Partial<AskPrerequisite> = {}): AskPrerequisite => ({
      key,
      title: key,
      steps: `Do ${key}.`,
      verification: "manual",
      ...extra,
    });
    const answerCard = async (items: AskPrerequisite[], priority?: PrerequisitePriority) => {
      const asked = await f.card(items, "all", priority);
      expect(await asked.answer("choice-2")).toBe(true);
      return asked.message.id;
    };
    // Oldest first, but no priority and nothing blocked: last.
    const unranked = await answerCard([item("unranked")]);
    const p1 = await answerCard([item("p1")], "p1");
    // The bot's order on the card is z then a, not key order.
    const blocking = await answerCard(
      [item("z-first", { blocks: [{ issue: 142, label: "Case 142" }] }), item("a-second")],
      "p3",
    );
    const p0 = await answerCard([item("p0")], "p0");
    // A finished item that blocked others no longer lifts its card.
    const doneBlocker = await answerCard([item("done", { blocks: ["#144"] })], "p2");
    const done = await f.prisma.userTodo.findFirstOrThrow({
      where: { spaceId: f.id, requirementKey: "done" },
    });
    await confirmUserTodo(f.prisma, f.actor, { todoId: done.id, revision: done.revision });

    const listed = await listUserTodos(f.prisma, f.actor);
    expect(listed.map((todo) => todo.groupId)).toEqual([
      blocking,
      blocking,
      p0,
      p1,
      doneBlocker,
      unranked,
    ]);
    expect(listed.slice(0, 2).map((todo) => todo.requirementKey)).toEqual(["z-first", "a-second"]);
    expect(listed[0]).toMatchObject({
      blocks: [{ issue: 142, label: "Case 142" }],
      priority: "p3",
      position: 0,
    });
    expect(listed.at(-1)).toMatchObject({ blocks: [], priority: null });
  });

  const HOUR = 60 * 60 * 1000;
  const inHours = (hours: number) => new Date(Date.now() + hours * HOUR);

  async function sweepRuns(f: Awaited<ReturnType<typeof fixture>>) {
    return f.prisma.run.findMany({
      where: { spaceId: f.id, trigger: "todo_check" },
      include: { task: { select: { prompt: true } } },
      orderBy: { createdAt: "asc" },
    });
  }

  it("the hourly sweep checks only due automatic to-dos, through one bounded run each", async () => {
    const f = await fixture();
    const { access, badge } = await f.chooseBoth("all");
    // Not an hour old yet: nothing is due.
    expect(await sweepUserTodoChecks(f.prisma, noCoordinators, { spaceId: f.id })).toEqual([]);

    const started = await sweepUserTodoChecks(f.prisma, noCoordinators, {
      spaceId: f.id,
      now: inHours(1.1),
    });
    expect(started).toHaveLength(1);
    const [run] = await sweepRuns(f);
    expect(run).toMatchObject({ id: started[0], botId: f.bot.id, status: "queued" });
    // Context-bounded: the to-do and its steps, not the card's question or the conversation.
    expect(run!.task.prompt).toContain(`“${ACCESS.title}” (to-do ${access.id})`);
    expect(run!.task.prompt).toContain(ACCESS.steps);
    expect(run!.task.prompt).toContain(`todo_report with todo_id "${access.id}"`);
    expect(run!.task.prompt).not.toContain("How do you want to do it?");
    // The manual item cannot be checked by a bot, so it costs no run at all.
    expect(run!.task.prompt).not.toContain(BADGE.title);
    expect(await f.prisma.userTodo.findUniqueOrThrow({ where: { id: badge.id } })).toMatchObject({
      status: "open",
      checkRequestedAt: null,
    });
    const checking = await f.prisma.userTodo.findUniqueOrThrow({ where: { id: access.id } });
    expect(checking).toMatchObject({ status: "checking" });
    // The run names its to-do at the revision it checks, so a refused command lands on it.
    expect(run!.clientNonce).toBe(`todo-check:${access.id}:${checking.revision}`);
    // The same hour does not start a second check.
    expect(
      await sweepUserTodoChecks(f.prisma, noCoordinators, {
        spaceId: f.id,
        now: inHours(1.2),
      }),
    ).toEqual([]);
    // No message lands in the chat: the check reports through todo_report alone.
    expect(await f.messagesWithNonce("todo:")).toHaveLength(0);
    // A refused command is recorded the way the executor does it: on that revision.
    expect(
      await reportUserTodo(
        f.prisma,
        {
          spaceId: f.id,
          botId: f.bot.id,
          todoId: access.id,
          outcome: "unavailable",
          evidence: "Couldn't check: needs a command that may change something (gh api -X POST).",
          expectedRevision: checking.revision,
        },
        noCoordinators,
      ),
    ).toMatchObject({ todo: { status: "unavailable" } });
  });

  it("a sweep and a check-now on the same item start one check and release once", async () => {
    const f = await fixture();
    const todo = await f.chooseTodo();
    const results = await Promise.allSettled([
      sweepUserTodoChecks(f.prisma, noCoordinators, { spaceId: f.id, now: inHours(2) }),
      requestUserTodoCheck(
        f.prisma,
        f.actor,
        { todoId: todo.id, revision: todo.revision },
        noCoordinators,
      ),
    ]);
    const swept = results[0].status === "fulfilled" ? results[0].value.length : 0;
    const clicked = results[1].status === "fulfilled" ? 1 : 0;
    expect(swept + clicked).toBe(1);
    const row = await f.prisma.userTodo.findUniqueOrThrow({ where: { id: todo.id } });
    expect(row).toMatchObject({ status: "checking", revision: todo.revision + 1 });
    expect(await sweepRuns(f)).toHaveLength(1);

    // Both checks may still run (a fresh check-now on the new revision); two verified reports
    // resolve the to-do once and wake the bot once.
    await requestUserTodoCheck(
      f.prisma,
      f.actor,
      { todoId: todo.id, revision: row.revision },
      noCoordinators,
    );
    const report = () =>
      reportUserTodo(
        f.prisma,
        {
          spaceId: f.id,
          botId: f.bot.id,
          todoId: todo.id,
          outcome: "verified",
          evidence: "elena-bot has Write on acme/site",
        },
        noCoordinators,
      );
    const reports = await Promise.all([report(), report()]);
    expect(reports.filter((result) => "todo" in result)).toHaveLength(1);
    expect(await f.releases()).toHaveLength(1);
  });

  it("an unfinished or unavailable check keeps the to-do and is retried, never assumed done", async () => {
    const f = await fixture();
    const todo = await f.chooseTodo();
    expect(
      await sweepUserTodoChecks(f.prisma, noCoordinators, {
        spaceId: f.id,
        now: inHours(1.5),
      }),
    ).toHaveLength(1);
    // The check never reported (its run failed): an hour later it is checked again, same to-do.
    const failRuns = () =>
      f.prisma.run.updateMany({
        where: { spaceId: f.id, trigger: "todo_check" },
        data: { status: "failed" },
      });
    await failRuns();
    expect(
      await sweepUserTodoChecks(f.prisma, noCoordinators, { spaceId: f.id, now: inHours(3) }),
    ).toHaveLength(1);
    const unavailable = await reportUserTodo(
      f.prisma,
      {
        spaceId: f.id,
        botId: f.bot.id,
        todoId: todo.id,
        outcome: "unavailable",
        evidence: "No GitHub read tool in this run",
      },
      noCoordinators,
    );
    expect(unavailable).toMatchObject({
      todo: { id: todo.id, status: "unavailable", statusDetail: "No GitHub read tool in this run" },
      wake: null,
    });
    await failRuns();
    // Retried on the next hour, still the same to-do and still not done.
    const retried = await sweepUserTodoChecks(f.prisma, noCoordinators, {
      spaceId: f.id,
      now: inHours(4.5),
    });
    expect(retried).toHaveLength(1);
    expect(await f.todos()).toHaveLength(1);
    expect((await f.todos())[0]).toMatchObject({ id: todo.id, status: "checking" });
    expect(await f.releases()).toHaveLength(0);
  });

  it("starts no check while the global pause holds admission", async () => {
    const f = await fixture();
    const todo = await f.chooseTodo();
    await f.prisma.$executeRaw`UPDATE maintenance_state SET active = true WHERE id = 'default'`;
    try {
      expect(
        await sweepUserTodoChecks(f.prisma, noCoordinators, {
          spaceId: f.id,
          now: inHours(2),
        }),
      ).toEqual([]);
    } finally {
      await f.prisma.$executeRaw`UPDATE maintenance_state SET active = false WHERE id = 'default'`;
    }
    expect(await f.prisma.userTodo.findUniqueOrThrow({ where: { id: todo.id } })).toMatchObject({
      status: "open",
      revision: todo.revision,
    });
    expect(await sweepRuns(f)).toHaveLength(0);
  });

  /** Answers one card for `caseRef` carrying both items. */
  async function chooseForCase(f: Awaited<ReturnType<typeof fixture>>, caseRef: number) {
    const asked = await f.card([ACCESS, BADGE], "all", undefined, caseRef);
    expect(await asked.answer("choice-2")).toBe(true);
    const rows = await f.todos();
    return {
      access: rows.find((row) => row.requirementKey === ACCESS.key)!,
      badge: rows.find((row) => row.requirementKey === BADGE.key)!,
    };
  }

  it("backfills a case only from an exact card head and leaves the rest unlinked", async () => {
    const f = await fixture();
    const titles: Array<[string, number | null]> = [
      ["Case 383 · access: Give Jill write access?", 383],
      ["URGENT · Case 77 · alert: Rotate the key?", 77],
      ["case 383 · access: lower case is not the head", null],
      ["Room for case 12 · repo: who joins?", null],
      ["Case 383: no middle dot", null],
      ["About Case 383 · elsewhere in the text", null],
      ["Case 99999999999 · too large", null],
    ];
    const ids: string[] = [];
    for (const [index, [groupTitle]] of titles.entries()) {
      const row = await f.prisma.userTodo.create({
        data: {
          spaceId: f.id,
          userId: f.id,
          botId: f.bot.id,
          threadId: f.thread.id,
          runId: "legacy-run",
          sourceMessageId: `legacy-card-${index}`,
          groupTitle,
          requirementKey: `legacy-${randomUUID()}`,
          title: "Legacy to-do",
          steps: "Do it.",
          verification: "manual",
        },
      });
      ids.push(row.id);
    }
    // The exact backfill statement of the migration.
    const migration = readFileSync(
      new URL(
        "../prisma/migrations/20261022090000_user_todo_case_ref/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const backfill = /UPDATE "user_todos"[\s\S]*?;/.exec(migration)![0];
    await f.prisma.$executeRawUnsafe(backfill);
    const rows = await f.prisma.userTodo.findMany({ where: { id: { in: ids } } });
    for (const [index, [, caseRef]] of titles.entries()) {
      expect(rows.find((row) => row.id === ids[index])?.caseRef).toBe(caseRef);
    }
  });

  it("links a card's to-dos to its case and lists them by case", async () => {
    const f = await fixture();
    const { access, badge } = await chooseForCase(f, 383);
    await f.chooseTodo({ ...ACCESS, key: "other-case-item" });
    expect(access.caseRef).toBe(383);
    const listed = await listUserTodosForCase(f.prisma, f.actor, 383);
    expect(listed.map((todo) => todo.id).sort()).toEqual([access.id, badge.id].sort());
    expect(listed.every((todo) => todo.caseRef === 383)).toBe(true);
    expect(await listUserTodosForCase(f.prisma, f.actor, 384)).toEqual([]);
    // Another account's case of the same number is not visible.
    expect(
      await listUserTodosForCase(f.prisma, { spaceId: f.id, userId: randomUUID() }, 383),
    ).toEqual([]);
  });

  it("retires a case's unfinished to-dos once, keeps finished ones and releases nothing", async () => {
    const f = await fixture();
    const { access, badge } = await chooseForCase(f, 383);
    await confirmUserTodo(f.prisma, f.actor, { todoId: badge.id, revision: badge.revision });
    const reason = "Case 383 was cancelled by Rens.";

    const retired = await retireUserTodosForCase(f.prisma, f.actor, { caseRef: 383, reason });
    expect(retired.map((todo) => todo.id)).toEqual([access.id]);
    expect(retired[0]).toMatchObject({ status: "retired", statusDetail: reason });
    expect(await f.prisma.userTodo.findUniqueOrThrow({ where: { id: badge.id } })).toMatchObject({
      status: "confirmed",
    });
    // Idempotent, and nothing deleted or woken: the case ended.
    expect(await retireUserTodosForCase(f.prisma, f.actor, { caseRef: 383, reason })).toEqual([]);
    expect(await f.todos()).toHaveLength(2);
    expect(await f.releases()).toHaveLength(0);
  });

  it("racing a check, the case retirement wins once and the late report is refused", async () => {
    const f = await fixture();
    const { access } = await chooseForCase(f, 383);
    const reason = "No longer needed for case 383.";
    const [checked, retired] = await Promise.allSettled([
      requestUserTodoCheck(
        f.prisma,
        f.actor,
        { todoId: access.id, revision: access.revision },
        noCoordinators,
      ),
      retireUserTodosForCase(f.prisma, f.actor, { caseRef: 383, reason }),
    ]);
    expect(retired.status).toBe("fulfilled");
    const row = await f.prisma.userTodo.findUniqueOrThrow({ where: { id: access.id } });
    expect(row).toMatchObject({ status: "retired", statusDetail: reason });
    // Either the check went first (and was then retired) or it found the to-do retired.
    if (checked.status === "rejected") {
      expect(checked.reason).toBeInstanceOf(UserTodoConflictError);
    }
    expect(
      await reportUserTodo(
        f.prisma,
        {
          spaceId: f.id,
          botId: f.bot.id,
          todoId: access.id,
          outcome: "verified",
          evidence: "elena-bot has Write",
        },
        noCoordinators,
      ),
    ).toHaveProperty("error");
    expect(await f.releases()).toHaveLength(0);
  });
});
