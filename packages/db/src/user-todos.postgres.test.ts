import { randomUUID } from "node:crypto";
import {
  type AskPrerequisite,
  MessageBlock,
  type PrerequisiteRelease,
  type UserTodo,
} from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Pool, type PrismaClient } from "./client.js";
import { answerRunInput } from "./events.js";
import { createThreadMessage } from "./messages.js";
import {
  confirmUserTodo,
  reportUserTodo,
  requestUserTodoCheck,
  retireUserTodo,
  UserTodoConflictError,
} from "./user-todo-actions.js";
import { listUserTodos } from "./user-todos.js";

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
    async function card(items?: AskPrerequisite[], release: PrerequisiteRelease = "all") {
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
            ...(items ? { prerequisites: { items, release } } : {}),
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
      await requestUserTodoCheck(prisma, actor, { todoId: todo.id, revision: todo.revision });
      return succeeded(
        await reportUserTodo(prisma, {
          spaceId: id,
          botId: bot.id,
          todoId: todo.id,
          outcome: "verified",
          evidence: "elena-bot has Write on acme/site",
        }),
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
    const checking = await requestUserTodoCheck(f.prisma, f.actor, {
      todoId: first.id,
      revision: first.revision,
    });
    const reported = await reportUserTodo(f.prisma, {
      spaceId: f.id,
      botId: f.bot.id,
      todoId: first.id,
      outcome: "remaining",
      evidence: "elena-bot is not a collaborator yet",
      remainingStep: "Invite elena-bot with Write role",
    });
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
    await requestUserTodoCheck(f.prisma, f.actor, { todoId: first.id, revision: first.revision });
    await reportUserTodo(f.prisma, {
      spaceId: f.id,
      botId: f.bot.id,
      todoId: first.id,
      outcome: "verified",
      evidence: "elena-bot has Write on acme/site",
    });

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

  it("two concurrent 'check now' clicks make one transition and one check message", async () => {
    const f = await fixture();
    const todo = await f.chooseTodo();
    const results = await Promise.allSettled([
      requestUserTodoCheck(f.prisma, f.actor, { todoId: todo.id, revision: todo.revision }),
      requestUserTodoCheck(f.prisma, f.actor, { todoId: todo.id, revision: todo.revision }),
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
    const checks = await f.messagesWithNonce(`todo:${todo.id}:check:`);
    expect(checks).toHaveLength(1);
    const text = textOf(checks[0]!.blocks);
    expect(text).toContain(ACCESS.steps);
    expect(text).toContain(`todo_report with todo_id "${todo.id}"`);
    expect(checks[0]!.role).toBe("user");
  });

  it("todo_report only takes the requesting bot's report against the current revision", async () => {
    const f = await fixture();
    const todo = await f.chooseTodo();
    const { todo: checking } = await requestUserTodoCheck(f.prisma, f.actor, {
      todoId: todo.id,
      revision: todo.revision,
    });

    expect(
      await reportUserTodo(f.prisma, {
        spaceId: f.id,
        botId: f.other.id,
        todoId: todo.id,
        outcome: "verified",
        evidence: "looks fine",
      }),
    ).toHaveProperty("error");
    expect(
      await reportUserTodo(f.prisma, {
        spaceId: f.id,
        botId: f.bot.id,
        todoId: todo.id,
        outcome: "verified",
        evidence: "looks fine",
        expectedRevision: todo.revision,
      }),
    ).toHaveProperty("error");
    expect((await f.prisma.userTodo.findUniqueOrThrow({ where: { id: todo.id } })).status).toBe(
      "checking",
    );

    const accepted = await reportUserTodo(f.prisma, {
      spaceId: f.id,
      botId: f.bot.id,
      todoId: todo.id,
      outcome: "verified",
      evidence: "elena-bot has Write on acme/site",
      expectedRevision: checking.revision,
    });
    expect(accepted).toMatchObject({
      todo: { status: "verified", evidence: "elena-bot has Write on acme/site" },
    });
  });

  it("'couldn't check' stays distinct from 'checked, still to do'", async () => {
    const f = await fixture();
    const todo = await f.chooseTodo();
    await requestUserTodoCheck(f.prisma, f.actor, { todoId: todo.id, revision: todo.revision });
    const unavailable = await reportUserTodo(f.prisma, {
      spaceId: f.id,
      botId: f.bot.id,
      todoId: todo.id,
      outcome: "unavailable",
      evidence: "GitHub API timed out",
    });
    expect(unavailable).toMatchObject({
      todo: { status: "unavailable", statusDetail: "GitHub API timed out" },
      wake: null,
    });
    // Unavailable is not a failed check: the user can ask again, and the bot then reports.
    const again = await requestUserTodoCheck(f.prisma, f.actor, {
      todoId: todo.id,
      revision: succeeded(unavailable).todo.revision,
    });
    const remaining = await reportUserTodo(f.prisma, {
      spaceId: f.id,
      botId: f.bot.id,
      todoId: todo.id,
      outcome: "remaining",
      evidence: "elena-bot has Read, not Write",
      remainingStep: "Change elena-bot's role to Write",
    });
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
      requestUserTodoCheck(f.prisma, f.actor, { todoId: todo.id, revision: todo.revision }),
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
      requestUserTodoCheck(f.prisma, f.actor, { todoId: todo.id, revision }),
    ).rejects.toBeInstanceOf(UserTodoConflictError);
    expect(
      await reportUserTodo(f.prisma, {
        spaceId: f.id,
        botId: f.bot.id,
        todoId: todo.id,
        outcome: "verified",
        evidence: "done",
      }),
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
    await requestUserTodoCheck(f.prisma, f.actor, { todoId: todo.id, revision: todo.revision });
    const report = () =>
      reportUserTodo(f.prisma, {
        spaceId: f.id,
        botId: f.bot.id,
        todoId: todo.id,
        outcome: "verified",
        evidence: "elena-bot has Write on acme/site",
      });
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
      caseNumber: null,
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

  it("release 'all' with the last open item retired releases the satisfied rest once", async () => {
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
    expect(retired.wake).not.toBeNull();
    const releases = await f.releases();
    expect(releases).toHaveLength(1);
    expect(textOf(releases[0]!.blocks)).not.toContain(BADGE.title);
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
});
