import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import type {
  AdapterContext,
  AgentHomeStore,
  ConnectorProvider,
  JobPublisher,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { routineJobKey, routineWakeupJob } from "@rakazo/adapter-kit";
import type { RoutineWatch, RoutineWatchState } from "@rakazo/contracts";
import { RoutineWatchSchema, RoutineWatchStateSchema } from "@rakazo/contracts";
import type { ActionApprovalRule } from "@rakazo/core";
import { connectorKindFromToolName, watchToolRefusal } from "@rakazo/core";
import type { ComputerMode, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  parseComputerMode,
} from "@rakazo/db";
import { lockMaintenanceAdmission } from "@rakazo/db/maintenance";
import { Prisma } from "@rakazo/db";
import { z } from "zod";
import { getLogger } from "@rakazo/logging";
import { scheduleComputerSleep } from "./computer-idle.js";
import { ComputerBusyError, provisionComputer } from "./computer-lifecycle.js";
import { resolveBotWorkspaceCwd, teamBotWorkspaceDirectory } from "./computer-support.js";
import { connectedContext, selectRunConnections } from "./connection-context.js";

/**
 * The checker behind a routine's "when something changes" trigger. It never
 * calls a model: it fingerprints the watched thing and compares the result
 * with the last one, so a routine only spends a run when there is news.
 */

/** Virtual root for validating watch paths; providers resolve the actual workspace. */
const WORKSPACE = "/home/rakazo";
const CHECK_TIMEOUT_MS = 60_000;
/** Starting a stopped computer can take longer than a check; it gets its own budget. */
const PROVISION_TIMEOUT_MS = 5 * 60_000;
/** A busy or still-booting computer is tried again this soon, not counted as a failure. */
const RETRY_AFTER_MS = 60_000;
/** Above this, a files watch keeps only the fingerprint and reports a count. */
const MAX_TRACKED_ENTRIES = 2_000;
const MAX_DETAIL = 1_500;
const MAX_LISTED = 20;

export type RoutineWatchDeps = {
  prisma: PrismaClient;
  sandbox: SandboxProvider;
  home: AgentHomeStore;
  jobs: JobPublisher;
  events: ThreadEvents;
  dataDir?: string;
  connector?: ConnectorProvider;
  /** The shell tool's desktop-protection guard: why a command is refused on a graphical computer. */
  commandRefusal?: (command: string) => string | undefined;
};

export type RoutineWatchTarget = {
  id: string;
  spaceId: string;
  userId: string;
  botId: string;
  watch: unknown;
  watchState: unknown;
  check?: { id: string; signal: AbortSignal };
};

/** Thrown when a check cannot be completed; the routine is paused and the bot says why. */
export class RoutineWatchError extends Error {}

/** Thrown when a check cannot run yet for a passing reason; it is retried shortly, not paused. */
export class RoutineWatchRetry extends Error {}

/** A provider operation may have started; an automatic fresh check is unsafe. */
class RoutineWatchUncertain extends RoutineWatchError {}

const MaintenanceCheckSchema = z.object({
  id: z.string(),
  status: z.enum(["executing", "completed", "uncertain"]),
  startedAt: z.string(),
  scheduledAt: z.string(),
  state: RoutineWatchStateSchema.optional(),
  nextRunAt: z.string().optional(),
  note: z.string().optional(),
  cancelRequested: z.boolean().optional(),
});

export function routineWatchCheckOutstanding(state: unknown): boolean {
  if (!state || typeof state !== "object" || !("maintenanceCheck" in state)) return false;
  const check = MaintenanceCheckSchema.safeParse(state.maintenanceCheck);
  return !check.success || check.data.status !== "completed";
}

export type RoutineWatchOutcome = {
  state: RoutineWatchState;
  /** True when the routine should run now. */
  changed: boolean;
};

export function parseRoutineWatch(value: unknown): RoutineWatch | null {
  if (value == null) return null;
  const parsed = RoutineWatchSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseRoutineWatchState(value: unknown): RoutineWatchState | null {
  if (value == null) return null;
  const parsed = RoutineWatchStateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** When the next check is due. */
export function nextRoutineWatchAt(watch: RoutineWatch, from: Date): Date {
  return new Date(from.getTime() + watch.everyMinutes * 60_000);
}

/** What a watch looks at, in a few words, for messages and the routine list. */
export function describeRoutineWatch(watch: RoutineWatch): string {
  if (watch.kind === "files") return (watch.paths ?? []).join(", ");
  if (watch.kind === "command") return `\`${watch.command ?? ""}\``;
  return watch.tool ?? "";
}

export async function checkRoutineWatch(
  deps: RoutineWatchDeps,
  routine: RoutineWatchTarget,
  now: Date = new Date(),
): Promise<RoutineWatchOutcome> {
  routine.check?.signal.throwIfAborted();
  const watch = parseRoutineWatch(routine.watch);
  if (!watch) throw new RoutineWatchError("The change trigger's settings are not valid.");
  const previous = parseRoutineWatchState(routine.watchState);
  const reading =
    watch.kind === "tool"
      ? await readTool(deps, routine, watch)
      : await readComputer(deps, routine, watch);
  routine.check?.signal.throwIfAborted();
  return compareReading(previous, reading, now);
}

type Reading = {
  fingerprint: string;
  entries?: Record<string, string>;
  /** Shown when the reading differs from the last one. */
  detail: string | null;
};

/** Pure: decides baseline / unchanged / changed and describes the change. */
export function compareReading(
  previous: RoutineWatchState | null,
  reading: Reading,
  now: Date,
): RoutineWatchOutcome {
  const base = {
    checkedAt: now.toISOString(),
    fingerprint: reading.fingerprint,
    ...(reading.entries ? { entries: reading.entries } : {}),
  };
  // A first check, or the first good one after a failure, only records where things stand.
  if (!previous?.fingerprint) {
    return { changed: false, state: { ...base, outcome: "baseline", detail: null } };
  }
  if (previous.fingerprint === reading.fingerprint) {
    return { changed: false, state: { ...base, outcome: "unchanged", detail: null } };
  }
  const detail =
    reading.entries && previous.entries
      ? describeEntryChanges(previous.entries, reading.entries)
      : reading.detail;
  return { changed: true, state: { ...base, outcome: "changed", detail } };
}

export function describeEntryChanges(
  before: Record<string, string>,
  after: Record<string, string>,
): string {
  const items = [...Object.values(before), ...Object.values(after)].some((signature) =>
    signature.startsWith(ITEM_SIGNATURE),
  );
  // Files are named by path; tracked items by the title saved in their signature.
  const name = (key: string, signature: string | undefined) =>
    items ? (itemTitle(signature) ?? key) : key;
  const added: string[] = [];
  const edited: string[] = [];
  const removed: string[] = [];
  for (const [key, signature] of Object.entries(after)) {
    if (!(key in before)) added.push(name(key, signature));
    else if (itemFields(before[key]) !== itemFields(signature)) edited.push(name(key, signature));
  }
  for (const key of Object.keys(before)) if (!(key in after)) removed.push(name(key, before[key]));
  const lines: string[] = [];
  const list = (label: string, names: string[]) => {
    if (!names.length) return;
    const shown = names.sort().slice(0, MAX_LISTED);
    const more = names.length - shown.length;
    lines.push(`${label}: ${shown.join(", ")}${more > 0 ? ` (and ${more} more)` : ""}`);
  };
  list("New", added);
  list(items ? "Updated" : "Edited", edited);
  list(items ? "Gone" : "Removed", removed);
  return lines.join("\n") || (items ? "The watched items changed." : "The watched files changed.");
}

/** Marks an item signature, so a note can name items by title rather than identity. */
const ITEM_SIGNATURE = "item:";
const TITLE_FIELDS = ["name", "title", "subject", "summary", "filename", "snippet"];

function itemTitle(signature: string | undefined): string | null {
  if (!signature?.startsWith(ITEM_SIGNATURE)) return null;
  try {
    const { title } = JSON.parse(signature.slice(ITEM_SIGNATURE.length)) as { title?: unknown };
    return typeof title === "string" && title ? title : null;
  } catch {
    return null;
  }
}

/** Titles are display details, never implicit tracked fields. */
function itemFields(signature: string | undefined): string | undefined {
  if (!signature?.startsWith(ITEM_SIGNATURE)) return signature;
  return stableStringify(
    (JSON.parse(signature.slice(ITEM_SIGNATURE.length)) as { fields: unknown }).fields,
  );
}

/**
 * The items in a JSON result, compared by the tracked fields only. Every object
 * anywhere in the result that carries the first field is an item; that field
 * is its identity, and the rest decide whether it was updated.
 */
export function readItems(data: unknown, track: readonly string[]): Reading {
  const [identity, ...fields] = track;
  const items = new Map<string, { fields: string[]; titles: string[] }>();
  let count = 0;
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const id = identity ? record[identity] : undefined;
    if (typeof id === "string" || typeof id === "number") {
      const key = String(id);
      const item = items.get(key) ?? { fields: [], titles: [] };
      item.fields.push(stableStringify(fields.map((field) => record[field] ?? null)));
      const titleField = TITLE_FIELDS.find((field) => typeof record[field] === "string");
      if (titleField) item.titles.push(String(record[titleField]).slice(0, 120));
      items.set(key, item);
      count++;
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(resultJson(data));
  // IDs can repeat in nested results. Preserve every object's values, independent of order.
  const entries = Object.fromEntries(
    [...items].map(([id, item]) => [
      id,
      `${ITEM_SIGNATURE}${stableStringify({ fields: item.fields.sort(), title: item.titles.sort()[0] ?? null })}`,
    ]),
  );
  const fingerprint = sha256(
    stableStringify(
      Object.fromEntries(
        Object.entries(entries).map(([id, signature]) => [id, itemFields(signature)]),
      ),
    ),
  );
  return count > MAX_TRACKED_ENTRIES
    ? { fingerprint, detail: `${count} watched items; something among them changed.` }
    : { fingerprint, entries, detail: null };
}

/** A result as JSON: the parsed text of an MCP or text result, or the data itself. */
function resultJson(data: unknown): unknown {
  const text = typeof data === "string" || isMcpEnvelope(data) ? toolResultText(data) : null;
  if (text === null) return data;
  try {
    return JSON.parse(text);
  } catch {
    throw new RoutineWatchError("The result is not JSON, so its tracked fields cannot be read.");
  }
}

function isMcpEnvelope(data: unknown): boolean {
  return Array.isArray((data as { content?: unknown } | null)?.content);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** JSON with sorted keys, so the same data always fingerprints the same. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_DETAIL ? `${trimmed.slice(0, MAX_DETAIL)}…` : trimmed;
}

function context(routine: RoutineWatchTarget): AdapterContext {
  const operationId = routine.check?.id ?? `watch:${routine.id}:${Date.now()}`;
  return {
    operationId,
    traceId: operationId,
    spaceId: routine.spaceId,
    userId: routine.userId,
    botId: routine.botId,
    signal: watchSignal(routine, CHECK_TIMEOUT_MS),
  };
}

function watchSignal(routine: RoutineWatchTarget, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return routine.check ? AbortSignal.any([routine.check.signal, timeout]) : timeout;
}

async function watchCheckCancellation(prisma: PrismaClient, routineId: string, checkId: string) {
  const controller = new AbortController();
  let checking = false;
  const check = async () => {
    if (checking || controller.signal.aborted) return;
    checking = true;
    try {
      const row = await prisma.routine.findUnique({
        where: { id: routineId }, select: { watchState: true },
      });
      const state = z.object({ maintenanceCheck: MaintenanceCheckSchema }).safeParse(row?.watchState);
      if (!state.success || state.data.maintenanceCheck.id !== checkId ||
          state.data.maintenanceCheck.cancelRequested) {
        controller.abort(new RoutineWatchUncertain("The change check was cancelled; its remote outcome is unconfirmed."));
      }
    } catch (error) {
      controller.abort(error);
      throw error;
    } finally {
      checking = false;
    }
  };
  await check();
  const timer = setInterval(() => {
    void check().catch((error) => getLogger().error("routine watch cancellation observation", error));
  }, 2_000);
  timer.unref?.();
  return { signal: controller.signal, stop: () => clearInterval(timer) };
}

async function toolContext(
  prisma: PrismaClient,
  routine: RoutineWatchTarget,
): Promise<AdapterContext> {
  const rows = await prisma.connection.findMany({
    where: { userId: routine.userId, spaceId: routine.spaceId },
    select: {
      id: true,
      connectorId: true,
      provider: true,
      providerRef: true,
      displayName: true,
      status: true,
    },
  });
  return { ...context(routine), ...connectedContext(selectRunConnections(rows, [])) };
}

// Lists every file under each path as "path<TAB>size<TAB>mtime". A path that
// does not exist is reported rather than read as "no files", which would make
// a deleted folder look unchanged forever.
export const FILES_SCRIPT = `root="$1"; shift
if [ -n "$root" ]; then root=$(realpath -- "$root") || exit 1; fi
status=0
for p in "$@"; do
  if [ -e "$p" ]; then
    if [ -n "$root" ]; then
      actual=$(realpath -- "$p") || exit 1
      case "$actual" in "$root"|"$root"/*) ;; *) echo "Path escapes the bot folder" >&2; exit 1 ;; esac
    fi
    find -P "$p" -type f -printf '%p\\t%s\\t%T@\\n' || status=1
  else printf 'MISSING\\t%s\\n' "$p"; fi
done
exit "$status"`;

/** Team file checks stay in this bot's folder, including absolute paths. */
export function resolveWatchPath(mode: ComputerMode, botId: string, path: string): string {
  const folder = watchFolder(mode, botId);
  const resolved = posix.resolve(folder, path);
  if (mode === "team" && resolved !== folder && !resolved.startsWith(`${folder}/`)) {
    throw new RoutineWatchError("The watched path must stay inside the bot's folder.");
  }
  return resolved;
}

/** Where a bot's relative paths and commands start. */
export function watchFolder(mode: ComputerMode, botId: string): string {
  // Not resolveBotWorkspacePath(mode, botId, "."): a team computer refuses "." as escaping.
  return mode === "team" ? `${WORKSPACE}/${teamBotWorkspaceDirectory(botId)}` : WORKSPACE;
}

async function readComputer(
  deps: RoutineWatchDeps,
  routine: RoutineWatchTarget,
  watch: RoutineWatch,
): Promise<Reading> {
  const bot = await deps.prisma.bot.findUnique({
    where: { id: routine.botId },
    include: { computer: true },
  });
  if (!bot?.computer) throw new RoutineWatchError("This bot has no computer to check.");
  const mode = parseComputerMode(bot.computer.scope);
  if (watch.kind === "command") {
    const graphical =
      bot.computer.kind !== "desktop" && deps.sandbox.describe().capabilities.graphical;
    const refusal = graphical ? deps.commandRefusal?.(watch.command ?? "") : undefined;
    if (refusal) {
      throw new RoutineWatchError(
        `The check command is refused by the desktop-protection guard: ${refusal}.`,
      );
    }
  }
  const ctx = context(routine);
  let computer: Awaited<ReturnType<typeof provisionComputer>>;
  try {
    computer = await provisionComputer(deps, bot.computer.id, {
      ...ctx,
      signal: watchSignal(routine, PROVISION_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof ComputerBusyError) throw new RoutineWatchRetry();
    throw new RoutineWatchUncertain(`Could not confirm starting the bot's computer: ${errorText(error)}`);
  }
  scheduleComputerSleep(deps.jobs, bot.computer.id);
  // The check's own time budget starts once the computer is up.
  const botFolder = watchFolder(mode, bot.id);
  const cwd = resolveBotWorkspaceCwd(mode, bot.id, undefined);
  ctx.signal = watchSignal(routine, CHECK_TIMEOUT_MS);

  if (watch.kind === "command") {
    // Runs this shell command on the bot's computer every interval, in its folder,
    // without a model or per-run approval: equivalent to the bot running it itself.
    const result = await run(deps, computer, ctx, ["sh", "-lc", watch.command ?? ""], cwd);
    if (result.code !== 0) {
      throw new RoutineWatchError(
        `The check command exited with ${result.code}${result.stderr ? `: ${clip(result.stderr)}` : "."}`,
      );
    }
    if (watch.track) return readItems(result.stdout, watch.track);
    return { fingerprint: sha256(result.stdout), detail: clip(result.stdout) || null };
  }

  const paths = (watch.paths ?? []).map((path) => {
    const resolved = resolveWatchPath(mode, bot.id, path);
    const relative = posix.relative(botFolder, resolved);
    // Inside the workspace, pass the path relative to the provider's working
    // directory so a desktop computer resolves it under its own home.
    const outside = relative === ".." || relative.startsWith("../");
    if (mode !== "team" && (outside || posix.isAbsolute(relative))) return resolved;
    // `./` keeps a name such as `-reports` from being read as a `find` option.
    return !relative ? "." : outside ? relative : `./${relative}`;
  });
  const result = await run(
    deps,
    computer,
    ctx,
    ["sh", "-c", FILES_SCRIPT, "watch", mode === "team" ? "." : "", ...paths],
    cwd,
  );
  if (result.code !== 0) {
    throw new RoutineWatchError(
      `Could not list the watched files (exit ${result.code})${result.stderr ? `: ${clip(result.stderr)}` : "."}`,
    );
  }
  const entries: Record<string, string> = {};
  const missing: string[] = [];
  for (const line of result.stdout.split("\n")) {
    if (!line) continue;
    const [first, second, third] = line.split("\t");
    // Paths went in as `./name`; report them as the bot wrote them.
    if (first === "MISSING") missing.push((second ?? "").replace(/^\.\//, ""));
    else if (first) entries[first.replace(/^\.\//, "")] = `${second}:${third}`;
  }
  if (missing.length) {
    throw new RoutineWatchError(`Nothing exists at ${missing.join(", ")}.`);
  }
  const fingerprint = sha256(stableStringify(entries));
  const count = Object.keys(entries).length;
  return count > MAX_TRACKED_ENTRIES
    ? { fingerprint, detail: `${count} watched files; something among them changed.` }
    : { fingerprint, entries, detail: null };
}

async function run(
  deps: RoutineWatchDeps,
  computer: Awaited<ReturnType<typeof provisionComputer>>,
  ctx: AdapterContext,
  argv: string[],
  cwd: string | undefined,
): Promise<{ stdout: string; stderr: string; code: number }> {
  let stdout = "";
  let stderr = "";
  let code = -1;
  try {
    for await (const event of deps.sandbox.execute(
      computer,
      { argv, cwd, timeoutMs: CHECK_TIMEOUT_MS },
      ctx,
    )) {
      if (event.type === "stdout") stdout += event.data;
      else if (event.type === "stderr") stderr += event.data;
      else if (event.type === "exit") code = event.code;
    }
  } catch (error) {
    throw new RoutineWatchUncertain(`The check's computer outcome is unknown: ${errorText(error)}`);
  }
  return { stdout, stderr, code };
}

async function readTool(
  deps: RoutineWatchDeps,
  routine: RoutineWatchTarget,
  watch: RoutineWatch,
): Promise<Reading> {
  const connector = deps.connector;
  if (!connector) throw new RoutineWatchError("No integrations are available to check.");
  const ctx = await toolContext(deps.prisma, routine);
  const toolName = watch.tool ?? "";
  let tools: Awaited<ReturnType<ConnectorProvider["discoverTools"]>>;
  try {
    tools = await connector.discoverTools(ctx);
  } catch (error) {
    throw new RoutineWatchError(`Could not list the integration's tools: ${errorText(error)}`);
  }
  const call = { tool: toolName, args: watch.args ?? {}, executionId: ctx.operationId };
  const tool = tools.find((candidate) => candidate.name === toolName);
  const resolved = tool
    ? { call: { ...call, route: tool.route }, tool }
    : await connector.resolveCall?.(call, ctx).catch(() => undefined);
  if (!resolved) {
    throw new RoutineWatchError(`No connected integration has a tool named ${toolName}.`);
  }
  const refusal = watchToolRefusal({
    toolName: resolved.tool.name,
    connectorKind: connectorKindFromToolName(
      resolved.tool.name,
      ctx.connectedConnections?.map((row) => row.externalId),
    ),
    readOnly: resolved.tool.readOnly,
    rules: (await deps.prisma.actionApprovalRule.findMany({
      where: { spaceId: routine.spaceId, createdByUserId: routine.userId },
      select: { effect: true, matchKind: true, matchValue: true },
    })) as ActionApprovalRule[],
  });
  if (refusal) throw new RoutineWatchError(refusal);
  let data: unknown;
  let failure: string | null = null;
  try {
    for await (const event of connector.execute(resolved.call, ctx)) {
      if (event.type === "result") data = event.data;
      else if (event.type === "error") failure = event.message;
    }
  } catch (error) {
    throw new RoutineWatchUncertain(`${toolName} outcome is unknown: ${errorText(error)}`);
  }
  if (data && typeof data === "object") {
    const result = data as { isError?: boolean; error?: unknown };
    if (result.isError === true || result.error != null)
      failure = toolResultText(result.error ?? data);
  }
  if (failure) throw new RoutineWatchError(`${toolName} failed: ${clip(failure)}`);
  if (watch.track) return readItems(data, watch.track);
  // The fingerprint covers the whole result; only the note the bot reads is unwrapped.
  return {
    fingerprint: sha256(stableStringify(data ?? null)),
    detail: clip(toolResultText(data)),
  };
}

/**
 * What a tool returned, as text a bot can read: an MCP result's text parts
 * rather than its `{content:[{type:"text",text}]}` envelope.
 */
export function toolResultText(data: unknown): string {
  if (typeof data === "string") return data;
  const content = (data as { content?: unknown } | null)?.content;
  if (Array.isArray(content)) {
    const texts = content
      .filter(
        (part): part is { type: "text"; text: string } =>
          (part as { type?: unknown })?.type === "text" &&
          typeof (part as { text?: unknown }).text === "string",
      )
      .map((part) => part.text);
    if (texts.length) return texts.join("\n");
  }
  return stableStringify(data ?? null);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type RoutineWatchTickDeps = RoutineWatchDeps & {
  jobs: JobPublisher;
};

type TickRoutine = RoutineWatchTarget & { name: string };

export type RoutineWatchTick =
  | { run: false }
  | { run: true; state: RoutineWatchState; nextRunAt: Date; note: string };

/**
 * One scheduled check of a watching routine. Returns whether the routine
 * should run now; every other outcome is fully handled here: the next check is
 * scheduled, or the routine is paused and its bot says why.
 */
export async function tickRoutineWatch(
  deps: RoutineWatchTickDeps,
  routine: TickRoutine,
  target: { threadId: string; botId: string },
  scheduledAt: Date,
): Promise<RoutineWatchTick> {
  const watch = parseRoutineWatch(routine.watch);
  const previous = parseRoutineWatchState(routine.watchState);
  const now = new Date();
  const storedState = z.record(z.string(), z.json()).nullable().parse(routine.watchState ?? null);
  const recorded = MaintenanceCheckSchema.safeParse(storedState?.maintenanceCheck);
  if (storedState?.maintenanceCheck !== undefined && !recorded.success) return { run: false };
  const priorCheck = recorded.success ? recorded.data : null;
  const check = {
    id: randomUUID(), status: "executing" as const,
    startedAt: now.toISOString(), scheduledAt: scheduledAt.toISOString(),
  };
  const baseState = previous ?? {
    checkedAt: now.toISOString(), outcome: "baseline" as const, fingerprint: null, detail: null,
  };
  const admitted = await deps.prisma.$transaction(async (tx) => {
    if (!(await lockMaintenanceAdmission(tx)).admitted) return false;
    if (priorCheck) return priorCheck.status === "completed" &&
      priorCheck.scheduledAt === scheduledAt.toISOString();
    const claimed = await tx.routine.updateMany({
      where: {
        id: routine.id, active: true, nextRunAt: scheduledAt,
        watchState: { equals: storedState ?? Prisma.DbNull },
      },
      data: { watchState: { ...baseState, maintenanceCheck: check } },
    });
    return claimed.count === 1;
  });
  if (!admitted) return { run: false };
  if (priorCheck) {
    const nextRunAt = new Date(priorCheck.nextRunAt ?? "");
    if (!priorCheck.state || !priorCheck.note || !Number.isFinite(nextRunAt.getTime()))
      throw new Error("Completed routine watch continuation is incomplete");
    return { run: true, state: priorCheck.state, nextRunAt, note: priorCheck.note };
  }
  const fence = {
    id: routine.id, active: true, nextRunAt: scheduledAt,
    watchState: { path: ["maintenanceCheck", "id"], equals: check.id },
  };
  const settlementFence = {
    id: routine.id, watchState: { equals: { ...baseState, maintenanceCheck: check } },
  };
  let outcome: RoutineWatchOutcome;
  const cancellation = await watchCheckCancellation(deps.prisma, routine.id, check.id);
  try {
    if (!watch) throw new RoutineWatchError("The change trigger's settings are not valid.");
    outcome = await checkRoutineWatch(deps, {
      ...routine, check: { id: `watch:${routine.id}:${check.id}`, signal: cancellation.signal },
    }, now);
  } catch (error) {
    if (error instanceof RoutineWatchRetry) {
      const retryAt = new Date(now.getTime() + RETRY_AFTER_MS);
      const deferred = await deps.prisma.routine.updateMany({
        where: fence,
        data: { nextRunAt: retryAt, watchState: storedState ?? Prisma.DbNull },
      });
      if (deferred.count === 1) await deps.jobs.enqueue(routineWakeupJob(routine.id, retryAt));
      else await deps.prisma.routine.updateMany({
        where: { id: routine.id, watchState: fence.watchState },
        data: { watchState: storedState ?? Prisma.DbNull },
      });
      return { run: false };
    }
    const reason = error instanceof Error ? error.message : String(error);
    const failedState = {
      checkedAt: now.toISOString(), outcome: "failed",
      fingerprint: previous?.fingerprint ?? null,
      ...(previous?.entries ? { entries: previous.entries } : {}),
      detail: reason,
      ...(error instanceof RoutineWatchUncertain || cancellation.signal.aborted
        ? { maintenanceCheck: {
            ...check, status: "uncertain", cancelRequested: cancellation.signal.aborted,
          } } : {}),
    };
    const paused = await deps.prisma.routine.updateMany({
      where: fence,
      data: {
        active: false,
        nextRunAt: null,
        watchState: failedState,
      },
    });
    if (paused.count === 1) {
      await deps.jobs.cancel(routineJobKey(routine.id)).catch(() => undefined);
      await postRoutineWatchMessage(deps, {
        spaceId: routine.spaceId,
        ...target,
        role: "bot",
        text: `I paused the **${routine.name}** routine because its change check failed: ${reason}\n\nTell me how to fix it, or turn the routine back on once it's sorted.`,
      });
    }
    else await deps.prisma.routine.updateMany({
      where: { id: routine.id, watchState: fence.watchState },
      data: { watchState: failedState },
    });
    return { run: false };
  } finally {
    cancellation.stop();
  }
  const nextRunAt = nextRoutineWatchAt(
    watch,
    new Date(Math.max(now.getTime(), scheduledAt.getTime())),
  );
  if (outcome.changed) {
    const note = `\n\nThis run was started because something you watch changed (${describeRoutineWatch(watch)}).\nWhat changed since the last check:\n${outcome.state.detail ?? "(no detail)"}`;
    const completedState = {
      ...baseState,
      maintenanceCheck: {
        ...check, status: "completed", state: outcome.state,
        nextRunAt: nextRunAt.toISOString(), note,
      },
    };
    const saved = await deps.prisma.routine.updateMany({
      where: { ...fence, ...settlementFence },
      data: { watchState: completedState },
    });
    if (!saved.count) await deps.prisma.routine.updateMany({
      where: settlementFence, data: { watchState: completedState },
    });
    return saved.count ? { run: true, state: outcome.state, nextRunAt, note } : { run: false };
  }
  const claimed = await deps.prisma.routine.updateMany({
    where: { ...fence, ...settlementFence },
    data: { nextRunAt, watchState: outcome.state },
  });
  if (claimed.count !== 1) {
    // A manual hold/schedule change must not leave a drained check "executing".
    // Update only its result, never overwrite the independent hold or due date.
    await deps.prisma.routine.updateMany({
      where: settlementFence, data: { watchState: outcome.state },
    });
    return { run: false };
  }
  if (watch.loud) {
    await postRoutineWatchMessage(deps, {
      spaceId: routine.spaceId,
      ...target,
      role: "system",
      text:
        outcome.state.outcome === "baseline"
          ? `${routine.name} routine: watching for changes`
          : `${routine.name} routine: no changes`,
    });
  }
  await deps.jobs.enqueue(routineWakeupJob(routine.id, nextRunAt));
  return { run: false };
}

/** A line in the routine's thread without a model run. */
export async function postRoutineWatchMessage(
  deps: Pick<RoutineWatchDeps, "prisma" | "events">,
  input: {
    spaceId: string;
    threadId: string;
    botId: string;
    role: "bot" | "system";
    text: string;
  },
): Promise<void> {
  const blocks =
    input.role === "bot"
      ? [{ kind: "text" as const, text: input.text }]
      : [{ kind: "meta" as const, text: input.text }];
  try {
    const seq = await deps.prisma.$transaction(async (tx) => {
      const message = await createThreadMessageInTransaction(tx, {
        threadId: input.threadId,
        botId: input.botId,
        role: input.role,
        blocks,
      });
      const event = await appendEventInTransaction(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        type: "thread.message.created",
        payload: { messageId: message.id, role: input.role, blocks },
      });
      return event.seq;
    });
    if (seq !== undefined) await deps.events.notify(input.threadId, seq).catch(() => undefined);
  } catch {
    // Best effort: the routine's state is already saved.
  }
}

export function assertWatchToolReadOnly(tool: string, readOnly: boolean | undefined): void {
  const refusal = watchToolRefusal({ toolName: tool, readOnly, rules: [] });
  if (refusal) throw new RoutineWatchError(refusal);
}

/** Validate without executing a tool or provisioning a computer. */
export async function validateRoutineWatch(
  deps: { connector?: ConnectorProvider; prisma?: PrismaClient },
  watch: RoutineWatch,
  target: { spaceId: string; userId: string; botId: string },
  computer?: { scope: string } | null,
): Promise<void> {
  if (watch.kind === "files" && computer) {
    for (const path of watch.paths ?? [])
      resolveWatchPath(parseComputerMode(computer.scope), target.botId, path);
  }
  // The API composition root has a registry, not the run's authorized connector.
  // Without that provider, tool metadata must be checked by readTool at runtime.
  if (watch.kind !== "tool" || !deps.connector) return;
  const routine = { ...target, id: "validate", watch, watchState: null };
  const ctx = deps.prisma ? await toolContext(deps.prisma, routine) : context(routine);
  const name = watch.tool ?? "";
  const tool =
    (await deps.connector.discoverTools(ctx)).find((tool) => tool.name === name) ??
    (
      await deps.connector.resolveCall?.(
        { tool: name, args: watch.args ?? {}, executionId: ctx.operationId },
        ctx,
      )
    )?.tool;
  if (!tool) throw new RoutineWatchError(`No connected integration has a tool named ${name}.`);
  assertWatchToolReadOnly(name, tool.readOnly);
}
