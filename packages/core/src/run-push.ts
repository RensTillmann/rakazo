/**
 * Whether a run's push reaches the user. Outside groups the bot's "notify on finish"
 * decides. In a group the room's `notify` switch decides, except that help (approvals,
 * asks, cards) and takeover pushes always go out, so a muted room never hides a question.
 * `kind` is omitted when asking about finish pushes in general (the activity list).
 */
export function runPushEnabled(input: {
  /** `null` outside a group; the room's `notify` setting inside one. */
  groupNotify: boolean | null;
  notifyOnFinish: boolean;
  kind?: string;
}): boolean {
  if (input.groupNotify === null) return input.notifyOnFinish;
  return input.groupNotify || input.kind === "help" || input.kind === "takeover";
}
