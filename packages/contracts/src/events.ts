import * as z from "zod";
import { botSecretDestinationSchema } from "./bot-secrets.js";
import { Id } from "./ids.js";
import { McpTransportSchema } from "./mcp.js";

export const ProductEventType = z.enum([
  "thread.message.created",
  "thread.cleared",
  "thread.message.updated",
  "thread.message.reaction",
  "thread.progress",
  "thread.artifact",
  "thread.ask",
  "thread.choice",
  "thread.meta",
  "thread.computer",
  "thread.subagent",
  "thread.cloud_agent",
  "thread.call.ended",
  "run.started",
  "run.steering.claimed",
  "run.checkpointed",
  "run.waiting_input",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "computer.status",
  "computer.takeover.requested",
  "computer.takeover.granted",
  "computer.takeover.released",
  "computer.command",
  "memory.revised",
  "routine.created",
  "routine.updated",
  "routine.fired",
  "skill.teaching.started",
  "skill.teaching.stopped",
  "skill.draft.created",
  "skill.saved",
  "effect.recorded",
  "agent.tool.called",
  "agent.tool.completed",
  /** Fleet (RAKAZO_ACTIVITY_DETAILS): one model call's token counts, for the activity window. */
  "agent.model.completed",
  "effect.reconciled",
  "usage.recorded",
  "bot.spawned",
  "bot.updated",
  "bot.archived",
  "bot.deleted",
  "group.created",
  "group.updated",
  "group.handoff",
  /** Liveness only: never persisted, never applied to a snapshot, always seq 0. */
  "heartbeat",
]);
export type ProductEventType = z.infer<typeof ProductEventType>;

export const MessageRole = z.enum(["user", "bot", "system"]);
export const BotMessageIntent = z.enum(["request", "result", "question", "status", "fyi"]);
export type BotMessageIntent = z.infer<typeof BotMessageIntent>;

export const MAX_CHART_DATA_ROWS = 5_000;

const ChartSpec = z.record(z.string(), z.any());

function embeddedChartRowCount(spec: Record<string, unknown>): number {
  const specData = Array.isArray(spec.data) ? spec.data.length : 0;
  const markData = Array.isArray(spec.marks)
    ? spec.marks.reduce((total, mark) => {
        if (!mark || typeof mark !== "object" || !Array.isArray(mark.data)) return total;
        return total + mark.data.length;
      }, 0)
    : 0;
  return specData + markData;
}

const ChartBlock = z
  .object({
    kind: z.literal("chart"),
    name: z.string(),
    /** Declarative Observable Plot spec, validated by render_plot before publish.
        z.any keeps the inferred type JSON-assignable for persistence. */
    spec: ChartSpec,
    data: z.array(z.any()).max(MAX_CHART_DATA_ROWS),
  })
  .superRefine((block, ctx) => {
    if (block.data.length + embeddedChartRowCount(block.spec) <= MAX_CHART_DATA_ROWS) return;
    ctx.addIssue({
      code: "custom",
      message: `Chart data exceeds the ${MAX_CHART_DATA_ROWS.toLocaleString("en-US")}-row limit`,
    });
  });

export const SecretAskPurpose = z.enum(["otp", "password", "api_key"]);
export type SecretAskPurpose = z.infer<typeof SecretAskPurpose>;

/** Longest stored `thinking` block; longer reasoning is cut and marked `truncated`. */
export const THINKING_BLOCK_MAX_CHARS = 8_000;

/** Longest reply draft an ask card shows editable (`ask_user` `draft`, `threads.answer` `draftFinal`). */
export const ASK_DRAFT_MAX_LENGTH = 20_000;

/** Longest customer inquiry a reply card shows (`ask_user` `inquiry`). */
export const ASK_INQUIRY_MAX_LENGTH = 20_000;

/**
 * Fleet: the outside conversation a reply card answers, at the exact version the draft was
 * written for. A newer `version` of the same `ref` replaces the older open card.
 */
export const AskSource = z.object({
  /** Stable identity of the conversation, e.g. `zendesk:3529`. */
  ref: z.string().trim().min(1).max(200),
  /** Its latest message or revision the draft answers, e.g. the last comment id. */
  version: z.string().trim().min(1).max(200),
});
export type AskSource = z.infer<typeof AskSource>;

/** A tracker issue number: the case a to-do belongs to, or one it blocks. */
export const TrackerIssueNumber = z.number().int().positive().max(2_147_483_647);

/**
 * What a prerequisite blocks: a tracker issue (`{ issue }`, optionally labelled) or, for display
 * only, free text such as "release 6.4".
 */
export const PrerequisiteBlock = z.union([
  z.string().trim().min(1).max(60),
  z
    .object({ issue: TrackerIssueNumber, label: z.string().trim().min(1).max(60).optional() })
    .strict(),
]);
export type PrerequisiteBlock = z.infer<typeof PrerequisiteBlock>;

/**
 * Fleet: one manual prerequisite an ask card offers to hand to the user. Choosing the card's
 * `todo` option creates or refreshes the user's to-do for `key`; it never marks it done.
 */
export const AskPrerequisite = z.object({
  /** Stable requirement identity; a replacement card with the same key keeps the same to-do. */
  key: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(300),
  /** The exact steps the user takes. */
  steps: z.string().trim().min(1).max(4000),
  /** Why the item is needed, in the user's terms. */
  why: z.string().trim().min(1).max(600).optional(),
  /**
   * Other cases or jobs that truly depend on this item, as tracker issues (`{ issue: 142 }`) or
   * free text for display. Waiting on the asking bot itself is implied and never listed.
   */
  blocks: z.array(PrerequisiteBlock).max(10).optional(),
  /** `automatic`: the bot can check it with its own read-only tools; `manual`: only the user can. */
  verification: z.enum(["automatic", "manual"]),
});
export type AskPrerequisite = z.infer<typeof AskPrerequisite>;

export const ASK_PREREQUISITES_MAX = 10;

/**
 * `each`: every satisfied item wakes the bot for the work that needed only it. `all`: the bot is
 * woken once, when the last item of the card is satisfied.
 */
export const PrerequisiteRelease = z.enum(["each", "all"]);
export type PrerequisiteRelease = z.infer<typeof PrerequisiteRelease>;

/** How urgent a card's to-dos are; unknown sorts after `p3`. */
export const PrerequisitePriority = z.enum(["p0", "p1", "p2", "p3"]);
export type PrerequisitePriority = z.infer<typeof PrerequisitePriority>;

function uniqueKeys(items: ReadonlyArray<{ key: string }>): boolean {
  return new Set(items.map((item) => item.key)).size === items.length;
}

/** Fleet: the to-do items a card's `todo` option hands to the user, and how they release work. */
export const AskPrerequisites = z.object({
  items: z
    .array(AskPrerequisite)
    .min(1)
    .max(ASK_PREREQUISITES_MAX)
    .refine(uniqueKeys, { message: "prerequisite keys must be unique within a card" }),
  release: PrerequisiteRelease,
  priority: PrerequisitePriority.optional(),
  /** The tracker case (issue number) these to-dos belong to; its end retires them. */
  caseRef: TrackerIssueNumber.optional(),
});
export type AskPrerequisites = z.infer<typeof AskPrerequisites>;

/** A numbered step at the start of a line: "1. …", "2) …". */
const NUMBERED_STEP = /^\s*\d+[.)]\s+\S/m;

/**
 * A new item as `ask_user` accepts it: the stored shape plus the minimum for clear instructions,
 * a `why` and at least one numbered step. Stored cards keep the stored shape and are not re-checked.
 */
export const AskPrerequisiteInput = AskPrerequisite.extend({
  steps: AskPrerequisite.shape.steps.regex(NUMBERED_STEP, {
    error:
      'write "steps" as numbered steps ("1. …", "2. …") with real URLs, menu names and exact values',
  }),
  why: z
    .string({ error: 'add "why": why it is needed, who acts and what happens next' })
    .trim()
    .min(1, { error: 'add "why": why it is needed, who acts and what happens next' })
    .max(600),
});

/** `ask_user`'s to-do arguments: the items, the option that accepts them, and the release mode. */
export const AskPrerequisitesInput = z.object({
  prerequisites: z
    .array(AskPrerequisiteInput)
    .min(1)
    .max(ASK_PREREQUISITES_MAX)
    .refine(uniqueKeys, { message: "prerequisite keys must be unique within a card" }),
  /** The exact label of the option meaning "I will do it myself". */
  option: z.string().trim().min(1).max(80),
  release: PrerequisiteRelease.default("all"),
  priority: PrerequisitePriority.optional(),
  /** Required: Fleet to-dos always belong to a tracker case, whose end retires them (ADR Q12). */
  caseRef: z
    .number({ error: "add caseRef: the tracker case (issue number) these to-dos belong to" })
    .pipe(TrackerIssueNumber),
});
export type AskPrerequisitesInput = z.infer<typeof AskPrerequisitesInput>;

/**
 * Fleet: the case of a card head, the leading `Case <n>` (any letter case, also after `URGENT · `,
 * e.g. "Case 383 · …" or "case 78: …"); null when none. The one head rule: card dedupe, recovery
 * accountability and D6 all read it.
 */
export function askCaseRef(text: string): number | null {
  const match = /^\s*(?:urgent\s*·\s*)?case\s+([1-9]\d*)\b/i.exec(text);
  return match ? Number(match[1]) : null;
}

/**
 * D6: a case decision card (head read by `askCaseRef`) needs at least two options, whatever their
 * labels; no check reads the wording of the question or the options (Rens, 23 Oct 2026). To-do cards
 * (`prerequisites`) are unaffected; secret cards come from `request_secret`, not here. Returns the
 * refusal, naming the rule, or null when the card may be asked.
 */
export function caseCardOptionsRefusal(
  question: string,
  options: readonly string[],
  todo: boolean,
): string | null {
  if (todo || askCaseRef(question) === null || options.length >= 2) return null;
  const given = options.length === 0 ? "none were given" : "only one was given";
  return `ask_user refused (rule D6, case decision cards): a "Case <n>" card needs at least two options to choose from, but ${given}. Offer the concrete choices (for a reply: the draft, the customer's asks and 2–3 concrete fixes).`;
}

export const MessageBlock = z.discriminatedUnion("kind", [
  /** `narration`: text written mid-turn before a tool call; clients may hide it. */
  z.object({ kind: z.literal("text"), text: z.string(), narration: z.boolean().optional() }),
  /**
   * The model's own reasoning for one model call, shown only behind the client's
   * "Show thoughts" toggle. Never sent back to a model, relayed, previewed, searched or
   * exported. `truncated`: cut at THINKING_BLOCK_MAX_CHARS.
   */
  z.object({
    kind: z.literal("thinking"),
    text: z.string(),
    truncated: z.literal(true).optional(),
  }),
  z.object({
    kind: z.literal("card"),
    lines: z.array(z.object({ k: z.string(), v: z.string() })),
  }),
  z.object({
    kind: z.literal("ask"),
    text: z.string(),
    approvalEffectId: Id.optional(),
    instructionUpdate: z
      .object({
        botId: Id,
        before: z.string(),
        after: z.string(),
        reason: z.string(),
        undoVersionId: Id.optional(),
      })
      .optional(),
    detail: z.string().optional(),
    detailFormat: z.enum(["text", "code"]).optional(),
    input: z.enum(["text", "secret"]).optional(),
    /** Why the secret is needed; drives field label on the masked card. */
    purpose: SecretAskPurpose.optional(),
    /** Fleet: a reply the bot drafted, shown editable on the card above its options. */
    draft: z.string().optional(),
    /** Fleet: the full customer inquiry and material context the draft answers. */
    inquiry: z.string().optional(),
    /** Fleet: the conversation and version the draft answers; the answer is bound to it. */
    source: AskSource.optional(),
    /** Fleet: the manual prerequisites the card's `todo` option hands to the user as to-dos. */
    prerequisites: AskPrerequisites.optional(),
    /**
     * Fleet: the draft as the user sent it, set only when it differs from `draft`. The bot was
     * told to send exactly this; the fleet service diffs it against `draft`.
     */
    draftFinal: z.string().optional(),
    // Records what the runtime could produce under either deployment mode, so
    // an ask persisted before an owner toggles the private-HTTP flag still
    // validates on replay.
    credential: botSecretDestinationSchema({ allowPrivateHttpOrigin: true }).optional(),
    /**
     * `retired`: closed without an answer because the request no longer applies (an approval whose
     * source question ended). Never an answer; `retiredReason` says why for every client.
     */
    status: z.enum(["pending", "answered", "retired"]).optional(),
    retiredReason: z.string().max(1000).optional(),
    retiredAt: z.string().optional(),
    answer: z.string().optional(),
    /** Fleet: the message whose identical question card supplied this answer. */
    syncedFrom: Id.optional(),
    /** Fleet: who answered this card through the API. Never holds the session token. */
    answeredBy: z
      .object({
        userId: Id,
        sessionId: z.string().optional(),
        userAgent: z.string().max(120).optional(),
        at: z.string(),
      })
      .optional(),
    actions: z
      .array(
        z.object({
          id: z.string(),
          label: z.string(),
          outcome: z.enum(["created", "cancelled"]).optional(),
          /** Fleet: choosing this option creates the card's `prerequisite` to-do. */
          todo: z.literal(true).optional(),
        }),
      )
      .optional(),
  }),
  z.object({
    kind: z.literal("choice"),
    question: z.string(),
    subtitle: z.string().optional(),
    options: z.array(z.object({ id: z.string(), letter: z.string(), label: z.string() })),
    /** Set once the user picks an option; renders the picker as answered. */
    answerId: z.string().optional(),
  }),
  z.object({
    /** Inline app authorization card (Composio-backed): logo, name, one-line
        description, and an Authorize button that flips to connected. */
    kind: z.literal("app_connect"),
    connectorId: z.string().optional(),
    provider: z.string(),
    name: z.string(),
    description: z.string(),
    logo: z.string().nullable(),
    status: z.enum(["pending", "connected"]),
  }),
  z.object({
    kind: z.literal("connect"),
    name: z.string(),
    initial: z.string(),
    color: z.string(),
    status: z.enum(["pending", "connected"]),
  }),
  z.object({
    kind: z.literal("computer"),
    state: z.string(),
    text: z.string(),
  }),
  z.object({
    /** Transcript card left in the thread when the bot hangs up a voice call. */
    kind: z.literal("voice_call"),
    /** Absent when the call had no client nonce to derive an id from. */
    callId: z.string().optional(),
    title: z.string(),
    farewell: z.string(),
    /** Connected time the caller's client measured; absent when the bot hung up. */
    durationSeconds: z.number().int().nonnegative().optional(),
  }),
  z.object({
    /** The bot is calling the user; the card tracks the call from ringing to its outcome. */
    kind: z.literal("call_request"),
    callId: z.string(),
    /** Why the bot is calling, shown on the incoming call. */
    reason: z.string(),
    /** The bot's first spoken sentence once the user answers. */
    opening: z.string(),
    status: z.enum(["ringing", "answered", "declined", "missed"]),
    expiresAt: z.string(),
    /** Connected time the user's client measured after answering. */
    durationSeconds: z.number().int().nonnegative().optional(),
  }),
  z.object({ kind: z.literal("meta"), text: z.string() }),
  z.object({
    kind: z.literal("progress"),
    text: z.string(),
    /** Provider-generated tool status rather than assistant-authored narration. */
    activity: z.literal(true).optional(),
    pendingToolNames: z.array(z.string()).optional(),
  }),
  z.object({
    kind: z.literal("steps"),
    steps: z.array(z.object({ label: z.string(), count: z.number().int().positive() })),
    durationMs: z.number().int().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal("subagent"),
    agentId: z.string(),
    name: z.string(),
    task: z.string(),
    status: z.enum(["running", "completed", "failed"]),
    progress: z.string().optional(),
    result: z.string().optional(),
  }),
  z.object({
    kind: z.literal("child_bot"),
    botId: z.string(),
    name: z.string(),
    title: z.string().optional(),
    status: z.enum(["created", "archived", "deleted"]),
  }),
  z.object({
    /** Compact card for a remote cloud coding agent (not the bot computer). */
    kind: z.literal("cloud_agent"),
    agentId: z.string(),
    title: z.string(),
    status: z.enum(["running", "finished", "failed", "cancelled"]),
    url: z.string(),
    branch: z.string().optional(),
    prUrl: z.string().optional(),
    latestRunId: z.string().optional(),
  }),
  z.object({
    kind: z.literal("skill_draft"),
    skillId: Id,
    name: z.string(),
    goal: z.string(),
    playbook: z.object({
      whenToUse: z.string(),
      inputs: z.array(z.string()),
      steps: z.array(z.string()),
      howToCheck: z.string(),
      whatToReturn: z.string(),
      approvalBoundaries: z.string(),
      failureHandling: z.string(),
    }),
    status: z.enum(["draft", "saved"]),
  }),
  ChartBlock,
  z.object({
    /** Approval card for an agent-created MCP server. The user completes the
        OAuth popup (or confirms no authorization is needed) in the UI. The
        status persists so the card renders its decision after a remount. */
    kind: z.literal("mcp_approval"),
    name: z.string(),
    serverId: Id,
    transport: McpTransportSchema,
    endpoint: z.string().nullable(),
    needsOAuth: z.boolean(),
    status: z.enum(["pending", "connected", "dismissed"]).default("pending"),
  }),
  z.object({
    kind: z.literal("image"),
    artifactId: Id,
    mimeType: z.string(),
    name: z.string(),
  }),
  z.object({
    kind: z.literal("file"),
    artifactId: Id,
    mimeType: z.string(),
    name: z.string(),
    size: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("handoff"),
    fromBotId: Id,
    toBotId: Id,
    text: z.string(),
    /** Links ownership transfers in one user-started group turn. */
    hop: z.number().int().positive().optional(),
  }),
  z.object({
    /** A group-chat message delivered into a member bot's own thread. */
    kind: z.literal("channel_message"),
    provider: z.string(),
    /** Per-message network when a provider spans multiple transports. */
    transport: z.string().optional(),
    channelId: Id,
    fromAddress: z.string(),
    fromLabel: z.string(),
    text: z.string(),
    hop: z.number().int().nonnegative().optional(),
  }),
  z.object({
    /** Shown in the sending bot's own chat, so the user can see what it sent. */
    kind: z.literal("bot_message_sent"),
    toBotId: Id,
    toBotName: z.string(),
    text: z.string(),
    intent: BotMessageIntent.optional(),
  }),
  z.object({
    /** Delivered into the receiving bot's own chat as the prompt that woke it. */
    kind: z.literal("bot_message_received"),
    fromBotId: Id,
    fromBotName: z.string(),
    text: z.string(),
    intent: BotMessageIntent.optional(),
    /** Sender-thread echo this delivery answers, when applicable. */
    returnToMessageId: Id.optional(),
    /** Links in a bot-started chain; absent when a person started it. */
    hop: z.number().int().nonnegative().optional(),
  }),
]);
export type MessageBlock = z.infer<typeof MessageBlock>;

export type ThinkingBlock = Extract<MessageBlock, { kind: "thinking" }>;

/** A stored thinking block for `text`, cut at THINKING_BLOCK_MAX_CHARS; null when empty. */
export function thinkingBlock(text: string): ThinkingBlock | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.length <= THINKING_BLOCK_MAX_CHARS) return { kind: "thinking", text: trimmed };
  return {
    kind: "thinking",
    text: `${trimmed.slice(0, THINKING_BLOCK_MAX_CHARS - 1).trimEnd()}…`,
    truncated: true,
  };
}

/**
 * Blocks a model, relay, notification, preview, search or export may see: everything but
 * `thinking`. Returns the same array when there is nothing to drop.
 */
export function withoutThinkingBlocks<T extends { kind: string }>(blocks: readonly T[]): T[] {
  if (!blocks.some((block) => block.kind === "thinking")) return blocks as T[];
  return blocks.filter((block) => block.kind !== "thinking");
}

/**
 * Something the bot did on its computer, shown in the terminal's Activity view: a shell
 * command (with a redacted output tail) or a file/app action, whose `command` is the path or
 * app name.
 */
export const COMPUTER_COMMAND_OUTPUT_MAX_CHARS = 16_000;
export const ComputerCommandKind = z.enum([
  "shell",
  "write_file",
  "attach_file",
  "open_path",
  "launch_app",
]);
export type ComputerCommandKind = z.infer<typeof ComputerCommandKind>;
export const ComputerCommandSchema = z.object({
  executionId: z.string(),
  kind: ComputerCommandKind,
  command: z.string(),
  cwd: z.string(),
  status: z.enum(["running", "done"]),
  exitCode: z.number().int().nullable(),
  output: z.string(),
  /** Size written by write_file. */
  bytes: z.number().int().nonnegative().optional(),
});
export type ComputerCommand = z.infer<typeof ComputerCommandSchema>;

/**
 * Collapse running/done events into one entry per command, in start order. A finished
 * command stays finished, so history and live events can be merged in either order.
 */
export function foldComputerCommands<T extends ComputerCommand>(events: T[]): T[] {
  const byId = new Map<string, T>();
  for (const event of events) {
    if (byId.get(event.executionId)?.status === "done" && event.status === "running") continue;
    byId.set(event.executionId, event);
  }
  return [...byId.values()];
}

export const ProductEventSchema = z.object({
  id: Id,
  spaceId: Id,
  threadId: Id,
  botId: Id,
  seq: z.number().int().nonnegative(),
  type: ProductEventType,
  runId: Id.optional(),
  createdAt: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
export type ProductEvent = z.infer<typeof ProductEventSchema>;

export const ReplyPreviewSchema = z.object({
  role: MessageRole,
  botId: Id.optional(),
  text: z.string(),
  attachment: z
    .object({
      kind: z.enum(["image", "file"]),
      artifactId: Id,
      mimeType: z.string(),
      name: z.string(),
    })
    .optional(),
});
export type ReplyPreview = z.infer<typeof ReplyPreviewSchema>;

/** An integration that delivers wakes into a bot's chat: a webhook, GitHub, or a messaging channel. */
export const InboundDeliverySource = z.enum(["webhook", "github", "messaging"]);
export type InboundDeliverySource = z.infer<typeof InboundDeliverySource>;

export const ThreadMessageSchema = z.object({
  id: Id,
  threadId: Id,
  seq: z.number().int().nonnegative(),
  role: MessageRole,
  blocks: z.array(MessageBlock),
  botId: Id.optional(),
  replyToMessageId: Id.optional(),
  replyQuote: z.string().optional(),
  replyPreview: ReplyPreviewSchema.nullable().optional(),
  runId: Id.optional(),
  /** Set when the message was sent from a live voice call; groups one call's transcript. */
  callId: z.string().optional(),
  /** Set when an integration delivered the message as an automatic wake, not the owner. */
  inbound: InboundDeliverySource.optional(),
  /** Fleet patch: the routine name when this is routine output the owner's chat folds away. */
  routineLog: z.string().optional(),
  createdAt: z.string(),
});
export type ThreadMessage = z.infer<typeof ThreadMessageSchema>;

export function canReactToThreadMessage(message: Pick<ThreadMessage, "id" | "blocks">): boolean {
  return (
    !message.id.startsWith("progress:") &&
    !message.id.startsWith("subagent:") &&
    !message.blocks.some((block) => block.kind === "channel_message")
  );
}
