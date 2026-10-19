import type { MessageBlock } from "@rakazo/contracts";
import { botMessageContext, inboundSourceFromClientNonce } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import type { ApprovalTrigger } from "./approval-ask.js";

type TriggerRun = {
  trigger: string;
  sourceMessageId?: string | null;
  routineId?: string | null;
};

/**
 * What started a run, for the approval card's "Why" fallback when the bot stated no intention.
 * A webhook delivery's payload is never read into it: only its routine name and source.
 */
export async function loadApprovalTrigger(
  prisma: Pick<PrismaClient, "message" | "routine" | "chatGroup">,
  run: TriggerRun,
  thread: { groupId?: string | null },
): Promise<ApprovalTrigger | undefined> {
  const source = run.sourceMessageId
    ? await prisma.message.findUnique({
        where: { id: run.sourceMessageId },
        select: { blocks: true, clientNonce: true },
      })
    : null;
  const blocks = Array.isArray(source?.blocks) ? (source.blocks as MessageBlock[]) : [];

  if (run.trigger === "bot_message") {
    const context = botMessageContext(blocks);
    return context ? { kind: "bot_message", botName: context.fromBotName, text: context.text } : undefined;
  }
  if (run.routineId && (run.trigger === "routine" || run.trigger === "webhook")) {
    const routine = await prisma.routine.findUnique({
      where: { id: run.routineId },
      select: { name: true },
    });
    if (!routine) return undefined;
    const event = run.trigger === "webhook" ? inboundSourceFromClientNonce(source?.clientNonce) : undefined;
    return { kind: "routine", routineName: routine.name, ...(event ? { event } : {}) };
  }
  if (run.trigger !== "user" && run.trigger !== "follow_up") return undefined;
  const text = blocks
    .filter((block): block is Extract<MessageBlock, { kind: "text" }> => block.kind === "text")
    .map((block) => block.text)
    .join(" ")
    .trim();
  if (!text) return undefined;
  if (thread.groupId) {
    const group = await prisma.chatGroup.findUnique({
      where: { id: thread.groupId },
      select: { name: true },
    });
    return group ? { kind: "room", roomName: group.name, text } : undefined;
  }
  return { kind: "user", text };
}
