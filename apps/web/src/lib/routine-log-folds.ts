import type { ThreadMessage } from "@rakazo/contracts";

/** Fleet patch: one folded "Routine log" row; `leaderId` is the message that renders it. */
export type RoutineLogFold = { leaderId: string; routineName: string; createdAt: string };

/**
 * Folds routine output (messages the server marked `routineLog`) into rows, or nothing when the
 * owner chose "Show routine output". A webhook wake and the run's reply that follows it, or
 * adjacent replies of one run, share one row timed by its newest message.
 */
export function routineLogFolds(
  messages: readonly ThreadMessage[],
  showRoutineOutput: boolean,
): Map<string, RoutineLogFold> {
  const folds = new Map<string, RoutineLogFold>();
  if (showRoutineOutput) return folds;
  let previous: { message: ThreadMessage; fold: RoutineLogFold } | undefined;
  for (const message of messages) {
    if (!message.routineLog) {
      previous = undefined;
      continue;
    }
    const joins =
      previous &&
      (previous.message.role === "user" ||
        (previous.message.runId !== undefined && previous.message.runId === message.runId));
    let fold: RoutineLogFold;
    if (previous && joins) {
      fold = previous.fold;
      fold.createdAt = message.createdAt;
      if (message.role === "bot") fold.routineName = message.routineLog;
    } else {
      fold = {
        leaderId: message.id,
        routineName: message.routineLog,
        createdAt: message.createdAt,
      };
    }
    folds.set(message.id, fold);
    previous = { message, fold };
  }
  return folds;
}

/** The sidebar line for a bot: its routine, not the text, when the newest message is routine output. */
export function sidebarBotPreview(
  bot: { preview: string; previewRoutineName?: string },
  showRoutineOutput: boolean,
  routineLogLabel: (routineName: string) => string,
): string {
  return bot.previewRoutineName && !showRoutineOutput
    ? routineLogLabel(bot.previewRoutineName)
    : bot.preview;
}
