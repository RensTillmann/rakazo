import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { duplicateAskRefusal } from "./decisions.js";
import { pauseRunForInput } from "./events.js";

type RunRow = { id: string; botId: string; threadId: string; status: string };
type MessageRow = {
  id: string;
  runId: string;
  threadId: string;
  role: string;
  blocks: MessageBlock[];
  createdAt: Date;
  seq: number;
};

const ASKED_AT = new Date("2026-10-20T05:26:23.000Z");

/** A transaction over in-memory runs and messages, filtered like the real queries. */
function fixture(runs: RunRow[], messages: MessageRow[]) {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
    run: {
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: { botId: string; id: { not: string }; status: { notIn: string[] } };
        }) =>
          runs.filter(
            (run) =>
              run.botId === where.botId &&
              run.id !== where.id.not &&
              !where.status.notIn.includes(run.status),
          ),
      ),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn().mockResolvedValue({
        status: "running",
        createdAt: new Date("2026-10-20T05:28:00.000Z"),
        threadId: "thread-2",
      }),
    },
    message: {
      findMany: vi.fn(async ({ where }: { where: { runId: { in: string[] }; role: string } }) =>
        messages.filter(
          (message) => where.runId.in.includes(message.runId) && message.role === where.role,
        ),
      ),
      create: vi.fn().mockResolvedValue({ id: "message-new" }),
    },
    attempt: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    thread: {
      update: vi
        .fn()
        .mockResolvedValueOnce({ nextMessageSeq: 4 })
        .mockResolvedValueOnce({ nextEventSeq: 8 })
        .mockResolvedValueOnce({ nextEventSeq: 9 }),
    },
    event: {
      create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
        id: `event-${data.seq}`,
        spaceId: "workspace-1",
        threadId: "thread-2",
        botId: "bot-josy",
        seq: data.seq,
        type: data.type,
        payload: {},
        runId: "run-2",
        createdAt: new Date("2026-10-20T05:28:34.000Z"),
      })),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      findFirst: vi.fn().mockResolvedValue(null),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  } as unknown as PrismaClient;
  return { tx, prisma };
}

function openCard(text: string, extra: Partial<RunRow> = {}, block: Partial<MessageBlock> = {}) {
  const run: RunRow = {
    id: "run-1",
    botId: "bot-josy",
    threadId: "thread-1",
    status: "waiting_input",
    ...extra,
  };
  const message: MessageRow = {
    id: "message-1",
    runId: run.id,
    threadId: run.threadId,
    role: "bot",
    blocks: [
      {
        kind: "ask",
        text,
        status: "pending",
        actions: [
          { id: "choice-1", label: "Export" },
          { id: "choice-2", label: "Skip" },
        ],
        ...block,
      } as MessageBlock,
    ],
    createdAt: ASKED_AT,
    seq: 3,
  };
  return { runs: [run], messages: [message] };
}

function ask(prisma: PrismaClient, text: string, dedupeQuestion = true) {
  return pauseRunForInput(prisma, {
    spaceId: "workspace-1",
    threadId: "thread-2",
    botId: "bot-josy",
    runId: "run-2",
    attemptId: "attempt-2",
    leaseOwner: "worker-1",
    leaseFence: 1,
    blocks: [
      {
        kind: "ask",
        text,
        status: "pending",
        actions: [
          { id: "choice-1", label: "Export" },
          { id: "choice-2", label: "Skip" },
        ],
      },
    ],
    ...(dedupeQuestion ? { dedupeQuestion: true } : {}),
  });
}

describe("ask dedupe (patch/ask-dedupe)", () => {
  it("refuses a second card for the same case and stores nothing", async () => {
    const { runs, messages } = openCard("Case 78 · alert: Can you export the 403/4xx …");
    const { tx, prisma } = fixture(runs, messages);

    await expect(ask(prisma, "case 78 · alert: export the 4xx log lines?")).resolves.toEqual({
      duplicateAskedAt: ASKED_AT,
    });
    expect(tx.run.updateMany).not.toHaveBeenCalled();
    expect(tx.message.create).not.toHaveBeenCalled();
    expect(tx.event.create).not.toHaveBeenCalled();
    const lock = tx.$queryRaw.mock.calls[1] as [TemplateStringsArray, ...unknown[]];
    expect(lock[0].join("?")).toContain("pg_advisory_xact_lock");
    expect(lock).toContain("ask-dedupe\u001fbot-josy");
  });

  it("refuses the same case asked with an URGENT prefix", async () => {
    const { runs, messages } = openCard("Case 78 · alert: Can you export the 403/4xx …");
    const { prisma } = fixture(runs, messages);
    await expect(ask(prisma, "URGENT · Case 78 · still waiting on the export")).resolves.toEqual({
      duplicateAskedAt: ASKED_AT,
    });

    const urgentFirst = openCard("URGENT · Case 78 · alert: export?");
    await expect(
      ask(fixture(urgentFirst.runs, urgentFirst.messages).prisma, "Case 78 · export?"),
    ).resolves.toEqual({ duplicateAskedAt: ASKED_AT });
  });

  it("allows a card for another case", async () => {
    const { runs, messages } = openCard("Case 78 · alert: Can you export the 403/4xx …");
    const { tx, prisma } = fixture(runs, messages);
    await expect(ask(prisma, "Case 79 · alert: Can you export the 403/4xx …")).resolves.toBe(true);
    expect(tx.message.create).toHaveBeenCalledOnce();
  });

  it("refuses the same text without a case key, whitespace aside", async () => {
    const { runs, messages } = openCard("Send the  renewal reply\nto Konstantin?");
    const { prisma } = fixture(runs, messages);
    await expect(ask(prisma, "  Send the renewal reply to Konstantin? ")).resolves.toEqual({
      duplicateAskedAt: ASKED_AT,
    });
    const other = openCard("Send the renewal reply to Konstantin?");
    await expect(
      ask(fixture(other.runs, other.messages).prisma, "Send the renewal reply to Maria?"),
    ).resolves.toBe(true);
  });

  it("allows the same case again once the earlier card is answered", async () => {
    const { runs, messages } = openCard(
      "Case 78 · alert: export?",
      { status: "running" },
      { status: "answered", answer: "choice-1" },
    );
    const { tx, prisma } = fixture(runs, messages);
    await expect(ask(prisma, "Case 78 · alert: export?")).resolves.toBe(true);
    expect(tx.message.create).toHaveBeenCalledOnce();
  });

  it("ignores a card whose run was cancelled or ended", async () => {
    for (const status of ["cancelled", "completed", "failed"]) {
      const { runs, messages } = openCard("Case 78 · alert: export?", { status });
      const { prisma } = fixture(runs, messages);
      await expect(ask(prisma, "Case 78 · alert: export?")).resolves.toBe(true);
    }
  });

  it("leaves approval cards alone", async () => {
    // An open approval card with the same text does not block a question card.
    const approval = openCard("Case 78 · alert: export?", {}, { approvalEffectId: "effect-1" });
    await expect(
      ask(fixture(approval.runs, approval.messages).prisma, "Case 78 · alert: export?"),
    ).resolves.toBe(true);

    // An approval pause never runs the check.
    const open = openCard("Case 78 · alert: export?");
    const { tx, prisma } = fixture(open.runs, open.messages);
    await expect(ask(prisma, "Case 78 · alert: export?", false)).resolves.toBe(true);
    expect(tx.run.findMany).not.toHaveBeenCalled();
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
  });

  it("tells the bot when the open card was asked, in UTC", () => {
    expect(duplicateAskRefusal(ASKED_AT)).toBe(
      "Not asked: the same card is already open in Rens's queue (asked 05:26 UTC). Don't ask it again; his answer comes to the run that asked it.",
    );
  });
});
