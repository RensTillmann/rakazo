import * as z from "zod";
import { ProductEventSchema } from "./events.js";
import { Id, IsoDate, RunStatus } from "./ids.js";

export const RUN_TRIGGERS = [
  "user",
  "routine",
  "resume",
  "follow_up",
  "reaction",
  "call_end",
  "spawn",
  "skill",
  "bot_message",
  "webhook",
  "messaging",
  "cloud_agent",
  "created",
  "tickets",
] as const;
export const RunTriggerSchema = z.enum(RUN_TRIGGERS);
export type RunTrigger = z.infer<typeof RunTriggerSchema>;

export const RoutineRunSchema = z.object({
  id: Id,
  botId: Id,
  groupId: Id.nullable(),
  status: RunStatus,
  createdAt: IsoDate,
  startedAt: IsoDate.nullable(),
  completedAt: IsoDate.nullable(),
  messageId: Id.nullable(),
});
export type RoutineRun = z.infer<typeof RoutineRunSchema>;

export const RoutineRunCursorSchema = z.object({ id: Id, createdAt: IsoDate });
export type RoutineRunCursor = z.infer<typeof RoutineRunCursorSchema>;
export const RoutineHistorySchema = z.object({
  runs: z.array(RoutineRunSchema),
  nextCursor: RoutineRunCursorSchema.nullable(),
});
export type RoutineHistory = z.infer<typeof RoutineHistorySchema>;

export const RunActivityRowSchema = z.object({
  runId: Id,
  botId: Id,
  botName: z.string(),
  groupId: Id.nullable(),
  groupName: z.string().nullable(),
  threadId: Id,
  status: RunStatus,
  trigger: RunTriggerSchema,
  notificationsEnabled: z.boolean(),
  promptSnippet: z.string(),
  updatedAt: z.string(),
});
export type RunActivityRow = z.infer<typeof RunActivityRowSchema>;

export const RunsListOutputSchema = z.object({
  runs: z.array(RunActivityRowSchema),
});
export type RunsListOutput = z.infer<typeof RunsListOutputSchema>;

/** Fleet (RAKAZO_ACTIVITY_DETAILS): one run in the Live activity window's run picker. */
export const RunActivitySummarySchema = z.object({
  runId: Id,
  botId: Id,
  botName: z.string(),
  status: RunStatus,
  trigger: RunTriggerSchema,
  promptSnippet: z.string(),
  createdAt: IsoDate,
  startedAt: IsoDate.nullable(),
  completedAt: IsoDate.nullable(),
});
export type RunActivitySummary = z.infer<typeof RunActivitySummarySchema>;

export const RUN_ACTIVITY_PAGE_MAX = 500;

/** A page of one run's stored events (oldest first) plus the thread's recent runs. */
export const RunActivityOutputSchema = z.object({
  threadId: Id,
  runs: z.array(RunActivitySummarySchema),
  /** The run the events belong to: the requested one, else the latest; null when none. */
  runId: Id.nullable(),
  events: z.array(ProductEventSchema),
  /** Pass as `afterSeq` for the next page; null once the page reached the end. */
  nextAfterSeq: z.number().int().nullable(),
});
export type RunActivityOutput = z.infer<typeof RunActivityOutputSchema>;
