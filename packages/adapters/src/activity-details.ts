import type { AgentToolCompletion } from "@rakazo/adapter-kit";
import { redactSecrets } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";

/**
 * Fleet: RAKAZO_ACTIVITY_DETAILS. Tool events also carry what the tool was asked and what the
 * model saw of the answer, so the owner can follow a run step by step in the Live activity window.
 * Previews are blanked like the model's view and dropped after RAKAZO_ACTIVITY_DETAILS_DAYS.
 */
export const ACTIVITY_ARG_STRING_MAX = 500;
export const ACTIVITY_ARGS_PREVIEW_MAX = 4_000;
export const ACTIVITY_RESULT_PREVIEW_MAX = 2_000;
export const DEFAULT_ACTIVITY_DETAILS_DAYS = 14;
const RETENTION_INTERVAL_MS = 60 * 60_000;
const SENSITIVE_KEY =
  /^(?:.*[_-])?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|authorization|auth)$/i;

export function activityDetailsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RAKAZO_ACTIVITY_DETAILS?.trim() === "true";
}

export function activityDetailsDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.RAKAZO_ACTIVITY_DETAILS_DAYS?.trim() || DEFAULT_ACTIVITY_DETAILS_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_ACTIVITY_DETAILS_DAYS;
}

/** Credential shapes blanked in errors, kept overflow and activity previews. */
export function sanitizeSensitiveText(message: string) {
  return message
    .replace(/sk-or-v1-[a-zA-Z0-9]+/g, "[redacted]")
    .replace(/sk-[a-zA-Z0-9-]+/g, "[redacted]")
    .replace(/Bearer\s+[^\s"',;&]+/gi, "Bearer [redacted]")
    .replace(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, "[redacted]")
    .replace(/COMPOSIO_API_KEY[=:]?\s*\S+/gi, "COMPOSIO_API_KEY=[redacted]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*)[^\s"',;&]+/gi,
      "$1[redacted]",
    )
    .replace(/((?:auth|authorization)\s*[=:]\s*)(?!Bearer\b)[^\s"',;&]+/gi, "$1[redacted]");
}

/** The tool's arguments as compact JSON: secrets blanked, each string ≤ 500, the whole ≤ 4,000. */
export function activityArgsPreview(args: unknown, secrets: string[] = []): string {
  const compact = (value: unknown, key?: string): unknown => {
    if (typeof value === "string") {
      if (key && SENSITIVE_KEY.test(key)) return "[redacted]";
      const text = redactSecrets(sanitizeSensitiveText(value), secrets);
      return text.length > ACTIVITY_ARG_STRING_MAX
        ? `${text.slice(0, ACTIVITY_ARG_STRING_MAX)}…`
        : text;
    }
    if (Array.isArray(value)) return value.map((item) => compact(item));
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([name, item]) => [
          name,
          compact(item, name),
        ]),
      );
    }
    return value;
  };
  let text: string;
  try {
    text = JSON.stringify(compact(args)) ?? "";
  } catch {
    text = "";
  }
  // Numbers and keys can still hold a run secret once joined into one string.
  text = redactSecrets(text, secrets);
  return text.length > ACTIVITY_ARGS_PREVIEW_MAX
    ? `${text.slice(0, ACTIVITY_ARGS_PREVIEW_MAX - 1)}…`
    : text;
}

/** Full size against what the model was given, and the start of what it saw. */
export function activityResultDetails(
  shown: NonNullable<AgentToolCompletion["shown"]>,
  secrets: string[] = [],
): { resultChars: number; shownChars: number; clipped: boolean; resultPreview: string } {
  const noteAt = shown.text.lastIndexOf("\n[cut off:");
  const seen = noteAt >= 0 ? shown.text.slice(0, noteAt) : shown.text;
  const resultChars = Math.max(shown.resultChars, seen.length);
  const shownChars = seen.length;
  return {
    resultChars,
    shownChars,
    clipped: resultChars > shownChars,
    resultPreview: redactSecrets(
      sanitizeSensitiveText(seen.slice(0, ACTIVITY_RESULT_PREVIEW_MAX)),
      secrets,
    ),
  };
}

/** Model calls so far and elapsed minutes (one decimal), from the run budget's counters. */
export function activityBudgetDetails(budget: NonNullable<AgentToolCompletion["budget"]>): {
  modelCalls: number;
  elapsedMinutes: number;
} {
  return {
    modelCalls: budget.modelCalls,
    elapsedMinutes: Math.round((Math.max(0, budget.usedMs) / 60_000) * 10) / 10,
  };
}

/** Drop the previews from tool events older than the retention window; the rest stays. */
export async function stripExpiredActivityDetails(
  prisma: Pick<PrismaClient, "$executeRaw">,
  now: Date = new Date(),
  days: number = activityDetailsDays(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60_000);
  return prisma.$executeRaw`
    UPDATE "events"
    SET "payload" = "payload" - 'argsPreview' - 'resultPreview'
    WHERE "type" IN ('agent.tool.called', 'agent.tool.completed')
      AND "createdAt" < ${cutoff}
      AND ("payload" ? 'argsPreview' OR "payload" ? 'resultPreview')
  `;
}

/** For the job reconciler's tick: strips at most once an hour. */
export function createActivityDetailsRetention(
  prisma: Pick<PrismaClient, "$executeRaw">,
  options: { intervalMs?: number; now?: () => Date } = {},
): () => Promise<void> {
  const intervalMs = options.intervalMs ?? RETENTION_INTERVAL_MS;
  let lastRunAt: number | undefined;
  return async () => {
    const now = options.now?.() ?? new Date();
    if (lastRunAt !== undefined && now.getTime() - lastRunAt < intervalMs) return;
    lastRunAt = now.getTime();
    await stripExpiredActivityDetails(prisma, now);
  };
}
