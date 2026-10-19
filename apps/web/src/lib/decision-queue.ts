import type { PendingDecision } from "@rakazo/contracts";

/**
 * Fleet: the decision dock's queue. The open chat's cards come first, then every other card
 * oldest first, so the user answers what they are looking at before older work elsewhere.
 */
export function orderDecisions(
  decisions: readonly PendingDecision[],
  currentThreadId: string | null | undefined,
): PendingDecision[] {
  const byAge = [...decisions].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.messageId.localeCompare(b.messageId),
  );
  if (!currentThreadId) return byAge;
  return [
    ...byAge.filter((decision) => decision.threadId === currentThreadId),
    ...byAge.filter((decision) => decision.threadId !== currentThreadId),
  ];
}

/**
 * Where the dock points after the list changes: the same card when it is still waiting (found by
 * messageId, even when its position moved), else the card now at the old position, clamped.
 */
export function stableDecisionIndex(
  next: readonly PendingDecision[],
  currentMessageId: string | null,
  previousIndex: number,
): number {
  if (next.length === 0) return 0;
  if (currentMessageId) {
    const found = next.findIndex((decision) => decision.messageId === currentMessageId);
    if (found >= 0) return found;
  }
  return Math.min(Math.max(previousIndex, 0), next.length - 1);
}

/** Moves the dock by `step` cards, wrapping at both ends. */
export function stepDecisionIndex(index: number, step: number, length: number): number {
  if (length === 0) return 0;
  return (((index + step) % length) + length) % length;
}

/** Card ids that were not in the previous list: new cards to announce. */
export function newDecisionIds(
  previous: readonly PendingDecision[],
  next: readonly PendingDecision[],
): string[] {
  const known = new Set(previous.map((decision) => decision.messageId));
  return next.filter((decision) => !known.has(decision.messageId)).map((d) => d.messageId);
}

/** Live thread events after which the dock refetches: a card arrived, was answered, or its run moved. */
export function decisionDockEvent(event: { type: string }): boolean {
  switch (event.type) {
    case "thread.ask":
    case "thread.message.updated":
    case "run.waiting_input":
    case "run.started":
    case "run.completed":
    case "run.failed":
    case "run.cancelled":
      return true;
    default:
      return false;
  }
}

/** One string per sidebar poll that changes exactly when some chat's waiting-card count changes. */
export function pendingDecisionSignature(
  chats: ReadonlyArray<{ id: string; pendingDecisionCount?: number }>,
): string {
  return chats
    .filter((chat) => (chat.pendingDecisionCount ?? 0) > 0)
    .map((chat) => `${chat.id}:${chat.pendingDecisionCount}`)
    .sort()
    .join(",");
}
