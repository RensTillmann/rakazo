import * as z from "zod";

const MaintenanceRevisionSchema = z.number().int().nonnegative().max(2_147_483_647);

export const MaintenanceStateSchema = z.object({
  active: z.boolean(),
  revision: MaintenanceRevisionSchema,
});
export type MaintenanceState = z.infer<typeof MaintenanceStateSchema>;

export const MaintenanceStatusSchema = z.object({
  phase: z.enum(["running", "pausing", "paused", "needs_attention"]),
  activeRuns: z.number().int().nonnegative(),
  activeEffects: z.number().int().nonnegative(),
  pendingRuns: z.number().int().nonnegative(),
  issues: z.array(z.string()),
});
export type MaintenanceStatus = z.infer<typeof MaintenanceStatusSchema>;

export const MaintenanceSnapshotSchema = z.object({
  state: MaintenanceStateSchema,
  status: MaintenanceStatusSchema,
}).refine(({ state, status }) => {
  // Stored intent alone is not effective quiescence; pending work may remain held.
  if (status.phase === "paused") {
    return state.active && status.activeRuns === 0 && status.activeEffects === 0;
  }
  return status.phase !== "running" || !state.active;
}, { message: "Maintenance status contradicts durable state or active work" });
export type MaintenanceSnapshot = z.infer<typeof MaintenanceSnapshotSchema>;

export const MaintenanceCommandSchema = z.strictObject({
  // Validate without normalizing: the exact identity binds retries to their command.
  requestId: z.string().max(128).refine((value) => value.trim().length > 0),
  action: z.enum(["enter", "resume", "force-stop"]),
  expectedRevision: MaintenanceRevisionSchema.max(2_147_483_646),
});
export type MaintenanceCommand = z.infer<typeof MaintenanceCommandSchema>;

export const MaintenanceChangeSchema = z.object({
  state: MaintenanceStateSchema,
  replayed: z.boolean(),
});
export type MaintenanceChange = z.infer<typeof MaintenanceChangeSchema>;

/**
 * One unfinished operation that keeps Fleet from being verifiably quiescent.
 * `draining`: its owner is still live and should settle it. `settleable`: recorded evidence
 * determines the outcome; the owner can apply it. `unresolved`: the outcome is unknown and
 * `missing` names the evidence that would settle it.
 */
export const MaintenanceRecoveryItemSchema = z.object({
  kind: z.enum(["run", "attempt", "effect", "fleet-effect", "operation"]),
  id: z.string(),
  status: z.string(),
  state: z.enum(["draining", "settleable", "unresolved"]),
  bot: z.string().nullable(),
  runId: z.string().nullable(),
  runStatus: z.string().nullable(),
  operation: z.string(),
  startedAt: z.string().nullable(),
  lastEvidenceAt: z.string().nullable(),
  evidence: z.string(),
  proposed: z.object({ status: z.string(), basis: z.string() }).nullable(),
  missing: z.string().nullable(),
  ownerVerifiable: z.boolean(),
});
export type MaintenanceRecoveryItem = z.infer<typeof MaintenanceRecoveryItemSchema>;

export const MaintenanceRecoverySchema = z.object({ items: z.array(MaintenanceRecoveryItemSchema) });
export type MaintenanceRecovery = z.infer<typeof MaintenanceRecoverySchema>;

export const MaintenanceRecoveryCommandSchema = z.discriminatedUnion("basis", [
  z.strictObject({
    requestId: z.string().max(128).refine((value) => value.trim().length > 0),
    basis: z.literal("evidence"),
    kind: z.enum(["attempt", "effect"]),
    id: z.string().min(1).max(64),
    expectedStatus: z.string().min(1).max(32),
  }),
  z.strictObject({
    requestId: z.string().max(128).refine((value) => value.trim().length > 0),
    basis: z.literal("owner-verified"),
    kind: z.literal("effect"),
    id: z.string().min(1).max(64),
    expectedStatus: z.string().min(1).max(32),
    outcome: z.enum(["completed", "failed"]),
    note: z.string().max(2000).refine((value) => value.trim().length >= 10),
  }),
]);
export type MaintenanceRecoveryCommand = z.infer<typeof MaintenanceRecoveryCommandSchema>;

export const MaintenanceRecoveryResultSchema = z.object({
  outcome: z.enum(["settled", "replayed", "changed", "refused"]),
  status: z.string(),
  reason: z.string().optional(),
});
export type MaintenanceRecoveryResult = z.infer<typeof MaintenanceRecoveryResultSchema>;
