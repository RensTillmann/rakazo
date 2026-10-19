import { t } from "@lingui/core/macro";

export function rosterHasUndismissedRunError(
  runErrorId: string | null | undefined,
  dismissedRunErrorIds: ReadonlySet<string>,
): boolean {
  return Boolean(runErrorId && !dismissedRunErrorIds.has(runErrorId));
}

/** Short sidebar label while a bot is queued, starting, or running. Null keeps the message preview. */
export function rosterWorkStatusLabel(status: string): string | null {
  switch (status) {
    case "queued":
      return t`Waiting in line…`;
    case "leased":
      return t`Starting…`;
    case "running":
      return t`Working…`;
    default:
      return null;
  }
}

/** The chat's newest run waits for the user: a question, approval or secret card, or a takeover. */
export function rosterNeedsAnswer(status: string): boolean {
  return status === "waiting_input" || status === "waiting_takeover";
}

/** Short sidebar label while a run waits for the user. Null when nothing waits. */
export function rosterNeedsAnswerLabel(status: string): string | null {
  return rosterNeedsAnswer(status) ? t`Needs your answer` : null;
}

/**
 * One roster status for a room: a member waiting for the user wins, then a working member,
 * so a room shows the same "Working…" and "Needs your answer" states as a bot row.
 */
export function groupRosterStatus(members: ReadonlyArray<{ status?: string | null }>): string {
  const statuses = members.map((member) => member.status ?? "idle");
  return (
    statuses.find(rosterNeedsAnswer) ??
    statuses.find((status) => rosterWorkStatusLabel(status) !== null) ??
    "idle"
  );
}

/** Compact rows keep actionable status visible in place of the message preview. */
export function compactRosterStatusLabel(status: string): string | null {
  const workStatus = rosterWorkStatusLabel(status) ?? rosterNeedsAnswerLabel(status);
  if (workStatus) return workStatus;
  switch (status) {
    case "failed":
      return t`Error`;
    default:
      return null;
  }
}
