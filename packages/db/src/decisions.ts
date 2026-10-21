import type { Actor, MessageBlock } from "@rakazo/contracts";
import { isApprovalAskBlock, isOpenAskBlock, isSecretAskBlock } from "@rakazo/core";
import type { Prisma, PrismaClient } from "./client.js";

/** Fleet: one pending card whose run is paused in `waiting_input`, for the decision dock. */
export type PendingDecisionRow = {
  messageId: string;
  runId: string;
  botId: string;
  botName: string;
  groupId: string | null;
  threadId: string;
  createdAt: string;
  block: MessageBlock;
};

type DecisionActor = Pick<Actor, "spaceId" | "userId">;

export function pendingAskBlock(blocks: unknown): MessageBlock | null {
  if (!Array.isArray(blocks)) return null;
  for (const block of blocks as MessageBlock[]) {
    if (block && isOpenAskBlock(block)) return block;
  }
  return null;
}

/** Chats the user can answer cards in: a live bot's own chat or a live room. */
function answerableThreadWhere(actor: DecisionActor) {
  return {
    spaceId: actor.spaceId,
    userId: actor.userId,
    OR: [
      { botId: { not: null }, bot: { archivedAt: null } },
      { groupId: { not: null }, group: { archivedAt: null } },
    ],
  };
}

/**
 * Every pending card the user may answer, oldest first. A card counts only while its run is
 * still `waiting_input`; a card on a finished or cancelled run is history.
 */
export async function listPendingDecisions(
  prisma: PrismaClient,
  actor: DecisionActor,
): Promise<PendingDecisionRow[]> {
  const runs = await prisma.run.findMany({
    where: {
      spaceId: actor.spaceId,
      status: "waiting_input",
      thread: answerableThreadWhere(actor),
    },
    select: {
      id: true,
      botId: true,
      threadId: true,
      bot: { select: { name: true } },
      thread: { select: { groupId: true } },
    },
  });
  if (runs.length === 0) return [];
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const messages = await prisma.message.findMany({
    where: { runId: { in: [...runsById.keys()] } },
    orderBy: [{ createdAt: "asc" }, { seq: "asc" }],
    select: { id: true, runId: true, threadId: true, botId: true, blocks: true, createdAt: true },
  });
  const decisions: PendingDecisionRow[] = [];
  for (const message of messages) {
    const run = message.runId ? runsById.get(message.runId) : undefined;
    if (!run || run.threadId !== message.threadId) continue;
    const block = pendingAskBlock(message.blocks);
    if (!block) continue;
    decisions.push({
      messageId: message.id,
      runId: run.id,
      botId: run.botId,
      botName: run.bot.name,
      groupId: run.thread.groupId,
      threadId: run.threadId,
      createdAt: message.createdAt.toISOString(),
      block,
    });
  }
  return decisions;
}

/** Pending card count per thread, for the sidebar's "Needs your answer" dot. */
export async function pendingDecisionCountsByThread(
  prisma: PrismaClient,
  threadIds: readonly string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (threadIds.length === 0) return counts;
  const runs = await prisma.run.findMany({
    where: { threadId: { in: [...threadIds] }, status: "waiting_input" },
    select: { id: true, threadId: true },
  });
  if (runs.length === 0) return counts;
  const threadByRun = new Map(runs.map((run) => [run.id, run.threadId]));
  const messages = await prisma.message.findMany({
    where: { runId: { in: [...threadByRun.keys()] } },
    select: { runId: true, threadId: true, blocks: true },
  });
  for (const message of messages) {
    const threadId = message.runId ? threadByRun.get(message.runId) : undefined;
    if (!threadId || threadId !== message.threadId || !pendingAskBlock(message.blocks)) continue;
    counts.set(threadId, (counts.get(threadId) ?? 0) + 1);
  }
  return counts;
}

/** Fleet: the leading `Case <n>` of a question (also after `URGENT · `), lowercased; null when none. */
export function askCaseKey(text: string): string | null {
  const match = /^\s*(?:urgent\s*·\s*)?case\s+(\d+)\b/i.exec(text);
  return match ? `case ${match[1]}` : null;
}

function sameQuestion(a: string, b: string): boolean {
  const key = askCaseKey(a);
  if (key) return askCaseKey(b) === key;
  return a.trim().replace(/\s+/g, " ") === b.trim().replace(/\s+/g, " ");
}

/**
 * Fleet: the bot's open question card (not an approval or secret card) in another run that has
 * not ended, asking the same thing: the same case key, or without one the same text.
 */
export async function findOpenDuplicateQuestion(
  tx: Prisma.TransactionClient,
  input: { botId: string; runId: string; text: string },
): Promise<{ messageId: string; askedAt: Date } | null> {
  const runs = await tx.run.findMany({
    where: {
      botId: input.botId,
      id: { not: input.runId },
      status: { notIn: ["cancelled", "completed", "failed"] },
    },
    select: { id: true, threadId: true },
  });
  if (runs.length === 0) return null;
  const threadByRun = new Map(runs.map((run) => [run.id, run.threadId]));
  const messages = await tx.message.findMany({
    where: { runId: { in: [...threadByRun.keys()] }, role: "bot" },
    orderBy: [{ createdAt: "asc" }, { seq: "asc" }],
    select: { id: true, runId: true, threadId: true, blocks: true, createdAt: true },
  });
  for (const message of messages) {
    if (!message.runId || threadByRun.get(message.runId) !== message.threadId) continue;
    const block = pendingAskBlock(message.blocks);
    if (block?.kind !== "ask") continue;
    if (block.approvalEffectId || isApprovalAskBlock(block) || isSecretAskBlock(block)) continue;
    if (sameQuestion(input.text, block.text)) {
      return { messageId: message.id, askedAt: message.createdAt };
    }
  }
  return null;
}

/** Fleet: what `ask_user` returns to the bot instead of a duplicate card. */
export function duplicateAskRefusal(askedAt: Date): string {
  const time = askedAt.toISOString().slice(11, 16);
  return `Not asked: the same card is already open in Rens's queue (asked ${time} UTC). Don't ask it again; his answer comes to the run that asked it.`;
}
