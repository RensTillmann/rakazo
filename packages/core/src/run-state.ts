import type { RunStatus } from "@rakazo/contracts";

export const ACTIVE_RUN_STATUSES = [
  "queued",
  "leased",
  "running",
  "waiting_input",
  "waiting_takeover",
  "maintenance_paused",
] as const satisfies readonly RunStatus[];
/**
 * Runs that hold a thread's queue: a new message steers or waits behind them. A run paused
 * at a decision card (`waiting_input`) holds no compute and does not block the chat; new
 * messages start or queue a normal run beside it, and answering the card resumes it.
 */
export const QUEUE_HOLDING_RUN_STATUSES = [
  "queued",
  "leased",
  "running",
  "waiting_takeover",
  "maintenance_paused",
] as const satisfies readonly RunStatus[];
/**
 * Runs a worker is executing right now. Queued, waiting and maintenance-paused runs are still
 * active (unresolved) but not executing, so activity indicators must not animate them.
 */
export const EXECUTING_RUN_STATUSES = ["leased", "running"] as const satisfies readonly RunStatus[];

export function isExecutingRunStatus(status: string | null | undefined): boolean {
  return (EXECUTING_RUN_STATUSES as readonly string[]).includes(status ?? "");
}
const TERMINAL: RunStatus[] = ["completed", "failed", "cancelled"];
/**
 * These turns carry their own prompt and must not take a user message as steering.
 * Routine and webhook runs are not the conversation. The creation intro has no tools;
 * a message that lands during it waits, and the continuation after the intro finishes answers it.
 */
const NON_CONVERSATIONAL_RUN_TRIGGERS = new Set([
  "routine",
  "webhook",
  "created",
  "tickets",
  "todo_check",
]);

/**
 * Background triggers do internal work that must not leak into the chat: the
 * sidebar must not show them as activity and the bot transcript must not render
 * their steps/text. Ticket work reports through board comments and its status.
 * Existing ask and approval cards can still request user input.
 */
// Fleet: a scheduled to-do check reports through the To-dos list, never in the chat.
export const BACKGROUND_RUN_TRIGGERS = ["tickets", "todo_check"] as const;
const BACKGROUND_RUN_TRIGGER_SET = new Set<string>(BACKGROUND_RUN_TRIGGERS);

export function isBackgroundRunTrigger(trigger: string | null | undefined): boolean {
  return BACKGROUND_RUN_TRIGGER_SET.has(trigger ?? "");
}

const allowed: Record<RunStatus, RunStatus[]> = {
  queued: ["leased", "cancelled"],
  leased: ["running", "queued", "maintenance_paused", "cancelled"],
  running: ["waiting_input", "waiting_takeover", "maintenance_paused", "completed", "failed", "cancelled", "leased"],
  waiting_input: ["queued", "leased", "cancelled"],
  waiting_takeover: ["queued", "leased", "cancelled"],
  maintenance_paused: ["queued", "cancelled"],
  completed: [],
  failed: ["queued"],
  cancelled: [],
};

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return allowed[from]?.includes(to) ?? false;
}

export function assertTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal run transition ${from} -> ${to}`);
  }
}

export function isActive(status: RunStatus): boolean {
  return (ACTIVE_RUN_STATUSES as readonly RunStatus[]).includes(status);
}

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL.includes(status);
}

/** Whether a run's turn is part of the thread's conversation and may take user steering. */
export function isConversationalRun(trigger: string | null | undefined): boolean {
  return !NON_CONVERSATIONAL_RUN_TRIGGERS.has(trigger ?? "");
}

export function nextFence(current: number): number {
  return current + 1;
}
