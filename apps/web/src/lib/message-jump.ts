import type { ThreadMessage } from "@rakazo/contracts";
import { foldPeerReplies } from "@rakazo/core";

/** `src` value of a jump opened from the To-dos panel's "Show question". */
export const QUESTION_JUMP_SOURCE = "question";

/**
 * The chat route that opens a thread at one message: the shell's `?m=` jump (search hits, the
 * To-dos panel) fetches the page around it, scrolls to it and highlights it.
 */
export function messageJumpLocation(
  target: { botId?: string; groupId?: string; messageId?: string; routineId?: string },
  source?: string,
): { pathname: string; search?: string } {
  const params = new URLSearchParams();
  if (target.messageId) params.set("m", target.messageId);
  if (target.routineId) params.set("routine", target.routineId);
  if (source) params.set("src", source);
  const search = params.toString();
  return {
    pathname: target.groupId ? `/app/g/${target.groupId}` : `/app/${target.botId}`,
    search: search ? `?${search}` : undefined,
  };
}

/** Whether a fetched page shows the message; a reply folded under its peer marker counts. */
export function messageInPage(messages: ThreadMessage[], messageId: string): boolean {
  const transcript = foldPeerReplies(messages, { includePeerReceipts: true });
  return (
    transcript.markerOf.has(messageId) || transcript.messages.some(({ id }) => id === messageId)
  );
}
