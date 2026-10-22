import { t } from "@lingui/core/macro";

export function rosterHasUndismissedRunError(
  runErrorId: string | null | undefined,
  dismissedRunErrorIds: ReadonlySet<string>,
): boolean {
  return Boolean(runErrorId && !dismissedRunErrorIds.has(runErrorId));
}

/**
 * Short sidebar label while a bot is queued, starting, or running. Null keeps the message preview.
 * A run the pause holds at a checkpoint says how many steps it kept.
 */
export function rosterWorkStatusLabel(status: string, pausedAfterSteps?: number): string | null {
  switch (status) {
    case "queued":
      return t`Waiting in line…`;
    case "leased":
      return t`Starting…`;
    case "running":
      return t`Working…`;
    case "maintenance_paused":
      return pausedAfterSteps === undefined
        ? t`Paused`
        : pausedAfterSteps === 1
          ? t`Paused after 1 step`
          : t`Paused after ${pausedAfterSteps} steps`;
    default:
      return null;
  }
}

/**
 * The chat waits for the user: a question, approval or secret card, or a takeover. A bot can be
 * working and have a waiting card at the same time, so a pending card count also counts.
 */
export function rosterNeedsAnswer(status: string, pendingDecisionCount = 0): boolean {
  return status === "waiting_input" || status === "waiting_takeover" || pendingDecisionCount > 0;
}

/** Short sidebar label while something waits for the user. Null when nothing waits. */
export function rosterNeedsAnswerLabel(status: string, pendingDecisionCount = 0): string | null {
  return rosterNeedsAnswer(status, pendingDecisionCount) ? t`Needs your answer` : null;
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
export function compactRosterStatusLabel(
  status: string,
  pendingDecisionCount = 0,
  pausedAfterSteps?: number,
): string | null {
  const workStatus =
    rosterNeedsAnswerLabel(status, pendingDecisionCount) ??
    rosterWorkStatusLabel(status, pausedAfterSteps);
  if (workStatus) return workStatus;
  switch (status) {
    case "failed":
      return t`Error`;
    default:
      return null;
  }
}
