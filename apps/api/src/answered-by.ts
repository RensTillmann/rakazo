import type { AskAnsweredBy } from "@rakazo/db";

/** Long enough to tell a phone from a desktop browser or a fleet session. */
export const ANSWERED_BY_USER_AGENT_MAX = 120;

/**
 * Fleet: who answered an ask card. The session id identifies the device; the session
 * token never reaches this record.
 */
export function answeredByFromRequest(input: {
  userId: string;
  sessionId?: string;
  userAgent?: string | null;
  now?: Date;
}): AskAnsweredBy {
  const userAgent = input.userAgent?.trim().slice(0, ANSWERED_BY_USER_AGENT_MAX);
  return {
    userId: input.userId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(userAgent ? { userAgent } : {}),
    at: (input.now ?? new Date()).toISOString(),
  };
}
