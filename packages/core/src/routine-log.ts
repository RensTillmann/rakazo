import type { InboundDeliverySource, MessageBlock } from "@rakazo/contracts";
import { inboundDeliverySummary } from "./inbound-delivery.js";

// Fleet patch: a routine run's own output is a log, not words for the owner. Clients fold it into
// one "Routine log" row unless the owner chooses to see routine output.

/** A run whose output is routine log: a scheduled or manual routine, or a webhook that woke one. */
export function isRoutineLogRun(run: { trigger: string; routineId: string | null }): boolean {
  return run.trigger === "routine" || (run.trigger === "webhook" && run.routineId !== null);
}

/** Cards that ask the owner something or need his decision; a message carrying one never folds. */
const OWNER_CARD_KINDS: Partial<Record<MessageBlock["kind"], true>> = {
  ask: true,
  choice: true,
  app_connect: true,
  connect: true,
  computer: true,
  mcp_approval: true,
  skill_draft: true,
};

/**
 * The routine name a message is folded under, or undefined when the owner should read it.
 * - A wake an integration delivered folds under the routines its header names.
 * - A bot message folds only as the plain final reply of a routine-log run (`routineName`): never
 *   a `message_user` post (its `user-progress:` client nonce, see adapters/user-progress.ts), a
 *   quoted reply, a message without text, or one carrying an ask or approval card.
 */
export function routineLogName(
  message: {
    role: string;
    blocks: readonly MessageBlock[];
    inbound?: InboundDeliverySource;
    clientNonce?: string | null;
    replyToMessageId?: string | null;
  },
  routineName: string | undefined,
): string | undefined {
  if (message.role === "user") {
    if (!message.inbound) return undefined;
    const text = message.blocks.find((block) => block.kind === "text");
    const routines = text?.kind === "text" ? inboundDeliverySummary(text.text).routines : [];
    return routines.length > 0 ? routines.join(", ") : undefined;
  }
  if (
    message.role !== "bot" ||
    !routineName ||
    message.replyToMessageId ||
    message.clientNonce?.startsWith("user-progress:") ||
    !message.blocks.some((block) => block.kind === "text") ||
    message.blocks.some((block) => OWNER_CARD_KINDS[block.kind])
  ) {
    return undefined;
  }
  return routineName;
}
