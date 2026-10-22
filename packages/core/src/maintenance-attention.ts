/**
 * Plain sentences for the codes Fleet control lists under "Needs attention": the pause status's
 * own issues and the reasons a held run gives (`continuation:<run>:maintenance:attention:<code>`).
 * One map for every client; a code without an entry gets the generic sentence.
 */
export const MAINTENANCE_ATTENTION_SENTENCES: Record<string, string> = {
  // Status issues.
  "uncertain-effects":
    "an action started but its outcome is unknown; check it under Unfinished operations",
  "unsettled-effects": "an action has been running for more than 10 minutes without a result",
  "uncertain-deliveries":
    "a message may or may not have been delivered; check it under Unfinished operations",
  "uncertain-team-chat-effects": "a team chat message may or may not have been sent",
  "team-chat-cancellation-pending": "a team chat message is still being cancelled",
  "routine-check-cancellation-pending": "a routine check is still being cancelled",
  "uncertain-routine-checks": "a routine check's outcome is unknown",
  "unsettled-routine-checks": "a routine check has been running for more than 10 minutes",
  "continuation-needs-attention":
    "some held runs could not be resumed yet; their reasons are listed",
  "cancellation-pending": "a force stop is still tearing down a run",
  "run-lease-expired": "a run's worker stopped reporting; a worker restart picks it up",
  "remote-cancellation-pending": "a cloud agent is still being cancelled",
  // Why a held run could not resume.
  "fleet-authority-verifier-unavailable":
    "the Fleet's safety check did not answer in time; it is retried automatically every 5 minutes",
  "fleet-authority-verification-failed":
    "the Fleet's safety check failed to run; it is retried automatically every 5 minutes",
  "fleet-authority-reply-invalid": "the Fleet's safety check answered in an unexpected form",
  "fleet-authority-verifier-changed": "the Fleet's safety check connection changed while checking",
  "fleet-authority-binding-invalid":
    "the Fleet found this run's link to its job invalid; it waits for you",
  "fleet-authority-binding-unavailable":
    "the Fleet could not find this run's link to its job; it waits for you",
  "fleet-authority-invalid-run-binding": "the Fleet found this run's link to its job invalid",
  "fleet-authority-unknown-profile": "the Fleet does not know this bot",
  "fleet-current-dispatch-hold": "the Fleet currently holds this kind of work",
  "fleet-independent-brake": "a separate Fleet brake holds this work",
  "fleet-routine-hold": "the bot's routine is held",
  "fleet-summary-no-longer-eligible": "the summary this run was for no longer applies",
  "dependencies-changed": "the work it depends on changed, or a to-do still blocks it",
  "continuation-verification-unavailable": "its saved progress could not be checked; it is retried",
  "continuation-already-consumed": "its saved progress was already used by another resume",
  "authority-changed": "its bot, task or instructions changed while it was held",
  "approval-binding-changed": "an approval it relied on changed while it was held",
  "ownership-changed": "its bot, task or chat changed owner",
  "owner-membership-missing": "its owner is no longer in this space",
  "task-no-longer-active": "its task ended while it was held",
  "room-held": "its room is paused, archived or no longer has this bot",
  "computer-held": "its computer is busy or switching",
  "independent-checkpoint-held": "it is also waiting on a takeover or approval",
  "routine-held": "its routine is paused",
  "teaching-held": "the bot is being taught a skill",
  "runtime-continuation-invalid": "its saved progress cannot be continued",
  "runtime-tool-binding-changed": "a tool it was using changed while it was held",
  "owner-override": "you let it continue; it skips the Fleet's check once, when Fleet runs",
};

/** Held because the Fleet's check did not answer: retried automatically. */
export function isRetriedAuthorityReason(reason: string | undefined): boolean {
  return reason === "fleet-authority-verifier-unavailable" ||
    reason === "fleet-authority-verification-failed";
}

/**
 * Held because the Fleet reports the run's binding unavailable or invalid: a real evidence
 * problem, never retried. Only the owner settles it: let it continue once, or stop it.
 */
export function isOwnerHeldAuthorityReason(reason: string | undefined): boolean {
  return /^(fleet-authority-)?binding-(unavailable|invalid)$/.test(reason ?? "");
}

/** The Fleet's reasons for a run that waits on the user's answer to its case's card. */
export const FLEET_CARD_WAIT_PREFIX = "fleet-current-card-wait-";

/** Waiting on the user's answer to a card: waiting, not something needing attention. */
export function isWaitingAuthorityReason(reason: string | undefined): boolean {
  return (reason ?? "").startsWith(FLEET_CARD_WAIT_PREFIX);
}

/** A status issue that only says a run waits on the user's answer; it raises no attention. */
export function isWaitingIssue(issue: string): boolean {
  const { runId, code } = maintenanceIssueCode(issue);
  return runId !== null && isWaitingAuthorityReason(code);
}

/** The owner let a held run continue: its next resume skips the Fleet's check, once. */
export const OWNER_OVERRIDE_REASON = "owner-override";

/** The plain sentence for one attention code. */
export function maintenanceAttentionSentence(code: string): string {
  if (isWaitingAuthorityReason(code)) return "waiting on your answer to this case's card";
  return (
    MAINTENANCE_ATTENTION_SENTENCES[code] ??
    (code.endsWith("-unavailable")
      ? "something it needs could not be checked; look at the run before relying on it"
      : "look at this before resuming work that depends on it")
  );
}

/** A status issue split into what it is about: one held run, or a status-wide code. */
export function maintenanceIssueCode(issue: string): { runId: string | null; code: string } {
  const run = /^continuation:([^:]+):(?:maintenance:attention:)?(.+)$/.exec(issue);
  return run ? { runId: run[1]!, code: run[2]! } : { runId: null, code: issue };
}
