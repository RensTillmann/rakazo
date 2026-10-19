import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { handoffToGroupBot, wakeMentionedGroupMembers } from "./group-handoff.js";

const run = {
  id: "run-a",
  spaceId: "workspace-1",
  threadId: "thread-1",
  botId: "bot-a",
  userId: "user-1",
};

function harness(
  sourceBlocks: unknown,
  existing?: { sourceRuns: { id: string; botId: string }[] },
) {
  const runCreate = vi.fn(async () => ({ id: "run-b" }));
  const messageCreate = vi.fn(async () => ({ id: "message-1" }));
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: "group-1" }]),
    chatGroup: {
      findFirst: vi.fn(async () => ({
        id: "group-1",
        members: ["bot-a", "bot-b", "bot-c"].map((id) => ({
          bot: { id, name: id.toUpperCase() },
        })),
      })),
      update: vi.fn(async () => ({ id: "group-1" })),
    },
    run: {
      findFirst: vi.fn(async () => ({
        id: run.id,
        sourceMessage: { blocks: sourceBlocks },
      })),
      findUnique: vi.fn(async () => ({ status: "running" })),
      create: runCreate,
    },
    message: {
      findUnique: vi.fn(async () => existing ?? null),
      create: messageCreate,
    },
    thread: {
      update: vi.fn(async (args: { select: { nextMessageSeq?: boolean } }) =>
        args.select.nextMessageSeq ? { nextMessageSeq: 2 } : { nextEventSeq: 2 },
      ),
    },
    task: { create: vi.fn(async () => ({ id: "task-b" })) },
    event: {
      findFirst: vi.fn(async () => ({ seq: 1 })),
      create: vi.fn(async () => ({ seq: 1 })),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx)),
  } as unknown as PrismaClient;
  return {
    deps: {
      prisma,
      events: { notify: vi.fn(async () => undefined) },
      jobs: { enqueue: vi.fn(async () => undefined) },
    },
    messageCreate,
    runCreate,
  };
}

describe("group handoff ownership", () => {
  it("marks a new ownership transfer as a follow-up with a chain hop", async () => {
    const { deps, messageCreate, runCreate } = harness([{ kind: "text", text: "user request" }]);

    await expect(
      handoffToGroupBot(deps as never, run, "group-1", {
        bot_id: "bot-b",
        message: "Do the distinct next stage",
      }),
    ).resolves.toMatchObject({ ok: true, botId: "bot-b" });

    expect(messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          blocks: [
            expect.objectContaining({
              kind: "handoff",
              fromBotId: "bot-a",
              toBotId: "bot-b",
              hop: 1,
            }),
          ],
        }),
      }),
    );
    expect(runCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ trigger: "follow_up" }) }),
    );
  });

  it("refuses to bounce a handed-off stage straight back to its sender", async () => {
    const { deps, runCreate } = harness([
      { kind: "handoff", fromBotId: "bot-b", toBotId: "bot-a", text: "Investigate", hop: 1 },
    ]);

    await expect(
      handoffToGroupBot(deps as never, run, "group-1", {
        bot_id: "bot-b",
        message: "You investigate it",
      }),
    ).resolves.toEqual({
      error:
        "do not hand this stage back to its sender; post the result in the shared thread instead",
    });
    expect(runCreate).not.toHaveBeenCalled();
  });

  it("caps longer multi-agent handoff chains", async () => {
    const { deps, runCreate } = harness([
      { kind: "handoff", fromBotId: "bot-b", toBotId: "bot-a", text: "Stage six", hop: 6 },
    ]);

    await expect(
      handoffToGroupBot(deps as never, run, "group-1", {
        bot_id: "bot-c",
        message: "Stage seven",
      }),
    ).resolves.toEqual({
      error:
        "group handoff limit reached for this chain; finish the current stage in the shared thread instead",
    });
    expect(runCreate).not.toHaveBeenCalled();
  });

  it("reuses the recorded transfer when a source run is retried", async () => {
    const { deps, messageCreate, runCreate } = harness([], {
      sourceRuns: [{ id: "run-b", botId: "bot-b" }],
    });

    await expect(
      handoffToGroupBot(deps as never, run, "group-1", {
        bot_id: "bot-c",
        message: "A duplicate stage",
      }),
    ).resolves.toMatchObject({ ok: true, botId: "bot-b", runId: "run-b" });
    expect(messageCreate).not.toHaveBeenCalled();
    expect(runCreate).not.toHaveBeenCalled();
  });

  it("rejects malformed source ancestry instead of restarting its hop count", async () => {
    const { deps, runCreate } = harness({ kind: "not-an-array" });

    await expect(
      handoffToGroupBot(deps as never, run, "group-1", {
        bot_id: "bot-b",
        message: "Continue",
      }),
    ).resolves.toEqual({ error: "cannot verify the group handoff chain" });
    expect(runCreate).not.toHaveBeenCalled();
  });
});

function mentionHarness(
  activeRuns: Array<{ id: string; botId: string; status: string; trigger: string }> = [],
  options: { archived?: boolean } = {},
) {
  const runCreate = vi.fn(async (args: { data: { botId: string } }) => ({
    id: `run-${args.data.botId}`,
  }));
  const steeringCreate = vi.fn(async () => ({ id: "steer-1" }));
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: "group-1" }]),
    chatGroup: {
      // The lookup filters on archivedAt: null, so an archived room reads as missing.
      findFirst: vi.fn(async () =>
        options.archived
          ? null
          : {
              members: ["bot-a", "bot-b", "bot-c"].map((id) => ({
                bot: { id, name: id.toUpperCase() },
              })),
            },
      ),
      update: vi.fn(async () => ({ id: "group-1" })),
    },
    message: { findFirst: vi.fn(async () => ({ id: "reply-1" })) },
    run: {
      findMany: vi.fn(async () => activeRuns),
      findUnique: vi.fn(async () => null),
      create: runCreate,
    },
    steeringMessage: { findFirst: vi.fn(async () => null), create: steeringCreate },
    task: { create: vi.fn(async () => ({ id: "task-1" })) },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx)),
  } as unknown as PrismaClient;
  const jobs = { enqueue: vi.fn(async () => undefined) };
  return { deps: { prisma, jobs }, runCreate, steeringCreate, jobs };
}

describe("group reply mentions", () => {
  it("wakes nobody when the reply names nobody, and never the author", async () => {
    const { deps, runCreate } = mentionHarness();
    await expect(wakeMentionedGroupMembers(deps as never, run, "group-1", "All done.")).resolves.toEqual([]);
    await expect(
      wakeMentionedGroupMembers(deps as never, run, "group-1", "@BOT-A noted"),
    ).resolves.toEqual([]);
    expect(runCreate).not.toHaveBeenCalled();
  });

  it("starts named idle members with a deduplicating nonce", async () => {
    const { deps, runCreate, jobs } = mentionHarness();
    await wakeMentionedGroupMembers(deps as never, run, "group-1", "@BOT-B can you check?");
    expect(runCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          botId: "bot-b",
          trigger: "follow_up",
          sourceMessageId: "reply-1",
          clientNonce: "group-mention:run-a:bot-b",
        }),
      }),
    );
    expect(jobs.enqueue).toHaveBeenCalledTimes(1);
  });

  it("steers a named member that already runs in this thread", async () => {
    const { deps, runCreate, steeringCreate, jobs } = mentionHarness([
      { id: "run-b1", botId: "bot-b", status: "running", trigger: "follow_up" },
    ]);
    await wakeMentionedGroupMembers(deps as never, run, "group-1", "@BOT-B also this");
    expect(runCreate).not.toHaveBeenCalled();
    expect(steeringCreate).toHaveBeenCalledWith({
      data: { messageId: "reply-1", botId: "bot-b", userId: "user-1", runId: "run-b1" },
    });
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it("skips an archived room", async () => {
    const { deps, runCreate } = mentionHarness([], { archived: true });
    await expect(
      wakeMentionedGroupMembers(deps as never, run, "group-1", "@BOT-B ping"),
    ).resolves.toEqual([]);
    expect(runCreate).not.toHaveBeenCalled();
  });
});
