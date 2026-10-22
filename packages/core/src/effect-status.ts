/**
 * External effect statuses that no longer count as unfinished work: never started (intended,
 * approved), refused (denied), ended (completed, failed, cancelled, media_completed, media_failed),
 * or an approval that no longer applies because its source question ended (invalidated, final).
 * The pause status, run revalidation, cancellation acknowledgement and the recovery list all read
 * this one list, so an effect is settled or not in the same way everywhere.
 */
export const SETTLED_EFFECT_STATUSES = [
  "intended",
  "approved",
  "denied",
  "invalidated",
  "completed",
  "failed",
  "cancelled",
  "media_completed",
  "media_failed",
] as const;

/** Effect statuses still in progress at their provider: unfinished, but not yet uncertain. */
export const IN_PROGRESS_EFFECT_STATUSES = [
  "executing",
  "media_submitting",
  "media_pending",
  "media_polling",
] as const;

const SETTLED: Record<string, true> = Object.fromEntries(
  SETTLED_EFFECT_STATUSES.map((status) => [status, true]),
);

export function isSettledEffectStatus(status: string): boolean {
  return SETTLED[status] === true;
}
