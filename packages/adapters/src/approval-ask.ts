import type { MessageBlock } from "@rakazo/contracts";
import {
  APPROVAL_NEVER_AUTOMATIC_LINE,
  batchedConnectorActions,
  instructionUpdateDiff,
  redactSecrets,
} from "@rakazo/core";

const MAX_APPROVAL_SUMMARY_LENGTH = 500;
const MAX_APPROVAL_DETAIL_LENGTH = 4_000;
const MAX_FIELD_LENGTH = 160;
const MAX_WHY_LENGTH = 200;
const MAX_DESCRIPTION_ACTION_LENGTH = 100;
const MAX_PUSH_LENGTH = 200;
const MAX_FIELDS_PER_ACTION = 5;
const FALLBACK_BOT_NAME = "Your bot";

type ApprovalAction = { toolName: string; args: Record<string, unknown> };

export type ApprovalAskOptions = {
  reviewReason?: string;
  /**
   * `allowAlways: false` (fleet): a tool-level or shell `require_approval` rule caused the ask,
   * so the card offers no "Always allow" and says it always asks; the server then refuses an
   * "always" answer for it.
   */
  allowAlways?: boolean;
  /** The bot asking, for the card title ("Elena wants to …"). */
  botName?: string;
  /** The bot's own most recent stated intention in this run, shown as the "Why" line. */
  intention?: string;
  /** The tool's own description; an MCP tool's first sentence names its action. */
  toolDescription?: string;
};

export function buildApprovalAskBlock(
  effectId: string,
  toolName: string,
  args: Record<string, unknown>,
  secrets: string[],
  options?: ApprovalAskOptions,
): MessageBlock {
  if (toolName === "propose_instructions_update") {
    const before = redactSecrets(String(args.previousInstructions ?? ""), secrets);
    const after = redactSecrets(String(args.instructions ?? ""), secrets);
    const reason = redactSecrets(String(args.reason), secrets);
    return {
      kind: "ask",
      approvalEffectId: effectId,
      text: "Update instructions?",
      detail: instructionUpdateDiff(before, after, reason),
      instructionUpdate: {
        botId: String(args.botId ?? ""),
        before,
        after,
        reason,
      },
      status: "pending",
      actions: [
        { id: "allow", label: "Apply" },
        { id: "deny", label: "Dismiss" },
      ],
    };
  }
  // A batch tool (Composio's multi-execute) is shown, and always-allowed, per action it runs.
  const batch = batchedActions(toolName, args);
  const actions = batch ?? [{ toolName, args }];
  const phrases = actionPhrases(toolName, args, options?.toolDescription);
  const title =
    toolName === "create_space"
      ? `Create space “${args.name ? String(args.name) : "Untitled"}”?`
      : `${options?.botName?.trim() || FALLBACK_BOT_NAME} wants to ${joinPhrases(phrases)}`;
  const detail = formatApprovalDetail(toolName, actions, secrets, options);
  const alwaysLabel = !batch
    ? "Always allow this tool"
    : batch.length > 1
      ? "Always allow these actions"
      : "Always allow this action";
  return {
    kind: "ask",
    approvalEffectId: effectId,
    text: truncate(redactSecrets(title, secrets), MAX_APPROVAL_SUMMARY_LENGTH),
    detail: detail
      ? truncate(redactSecrets(detail, secrets), MAX_APPROVAL_DETAIL_LENGTH)
      : undefined,
    status: "pending",
    actions:
      toolName === "create_space"
        ? [
            { id: "allow", label: "Create space", outcome: "created" },
            { id: "deny", label: "Cancel", outcome: "cancelled" },
          ]
        : [
            { id: "allow", label: "Allow once" },
            ...(options?.allowAlways === false ? [] : [{ id: "always", label: alwaysLabel }]),
            { id: "deny", label: "Deny" },
          ],
  };
}

/**
 * The approval push, read as "<Bot> needs your OK: <plain action>": the title names the bot, the
 * body the action. Never a message body or email content.
 */
export function approvalPush(
  botName: string | undefined,
  toolName: string,
  args: Record<string, unknown>,
  secrets: string[],
  toolDescription?: string,
): { title: string; body: string } {
  const action = joinPhrases(actionPhrases(toolName, args, toolDescription));
  return {
    title: truncate(
      redactSecrets(`${botName?.trim() || FALLBACK_BOT_NAME} needs your OK`, secrets),
      MAX_PUSH_LENGTH,
    ),
    body: truncate(redactSecrets(capitalize(action), secrets), MAX_PUSH_LENGTH),
  };
}

function actionPhrases(
  toolName: string,
  args: Record<string, unknown>,
  toolDescription?: string,
): string[] {
  const batch = batchedActions(toolName, args);
  if (batch) return batch.map((action) => plainAction(action.toolName, action.args));
  return [plainAction(toolName, args, toolDescription)];
}

/** The actions inside a batch call, each with its own arguments; null for any other call. */
function batchedActions(toolName: string, args: Record<string, unknown>): ApprovalAction[] | null {
  if (!batchedConnectorActions(toolName, args) || !Array.isArray(args.tools)) return null;
  return args.tools.flatMap((item: unknown): ApprovalAction[] => {
    if (!item || typeof item !== "object" || !("tool_slug" in item)) return [];
    if (typeof item.tool_slug !== "string") return [];
    return [
      {
        toolName: item.tool_slug.trim(),
        args: objectArgs("arguments" in item ? item.arguments : undefined),
      },
    ];
  });
}

/** Composio accepts batch arguments as an object or a JSON string. */
function objectArgs(raw: unknown): Record<string, unknown> {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

// ---- Plain action ("wants to …") -------------------------------------------------------------

const BUILTIN_ACTIONS: Record<string, string | ((args: Record<string, unknown>) => string)> = {
  generate_image: "make an image",
  generate_video: "make a video",
  computer_observe: "look at their computer screen",
  computer_act: "use their computer",
  browser_navigate: "open a web page",
  browser_snapshot: "look at a web page",
  browser_act: "click and type on a web page",
  list_files: "look through files on their computer",
  read_file: "read a file",
  write_file: (args) => {
    const file = fileName(stringArg(args, "path", "file_path", "filePath"));
    return file ? `save the file ${file}` : "save a file";
  },
  attach_file: "share a file in the chat",
  shell: "run a command on their computer",
  open_path: "open a file or app",
  launch_app: "open an app",
  request_takeover: "ask you to take over the screen",
  ask_user: "ask you a question",
  message_user: "send you a message",
  request_secret: "ask you for a password or key",
  secret_request: "ask you for a password or key",
  list_secrets: "look at the names of their saved keys",
  forget_secret: "delete a saved password or key",
  render_plot: "draw a chart",
  add_mcp_server: "add a tool server",
  remember: "save a note to their memory",
  save_shared_memory: "save to the shared memory",
  web_search: "search the web",
  web_fetch: "read a web page",
  cloud_agent_launch: "start a cloud coding agent",
  cloud_agent_status: "check on a cloud coding agent",
  cloud_agent_reply: "reply to a cloud coding agent",
  cloud_agent_cancel: "stop a cloud coding agent",
  search_history: "search the chat history",
  read_history: "read the chat history",
  save_memory: "save a memory",
  recall_memory: "search their memory",
  forget_memory: "forget a memory",
  task_catalog: "look at the task list",
  scratchpad_list: "look at their notes",
  scratchpad_add: "add a note",
  scratchpad_update: "change a note",
  scratchpad_complete: "tick off a note",
  scratchpad_remove: "remove a note",
  board_tickets: "look at the board",
  ticket_get: "read a ticket",
  ticket_create: "create a ticket",
  ticket_update: "change a ticket",
  ticket_comment: "comment on a ticket",
  schedule_create: "set up a schedule",
  schedule_list: "look at the schedules",
  schedule_cancel: "cancel a schedule",
  end_call: "end the call",
  skill_read: "read a skill",
  skill_create: "create a skill",
  skill_update: "change a skill",
  skill_delete: "delete a skill",
  run_subagent: "start a helper bot",
  propose_instructions_update: "update their instructions",
  create_space: (args) => `create the space “${stringArg(args, "name") ?? "Untitled"}”`,
  spawn_bot: (args) => {
    const name = stringArg(args, "name");
    return name ? `create a new bot (${name})` : "create a new bot";
  },
  update_bot: "change a bot's profile",
  archive_bot: (args) => botAction("archive the bot", args),
  delete_bot: (args) => botAction("delete the bot", args),
  message_bot: (args) => {
    const to = stringArg(args, "confirm_name", "confirmName");
    return to ? `send a message to ${to}` : "send a message to another bot";
  },
  handoff_to_bot: (args) => {
    const to = stringArg(args, "confirm_name", "confirmName");
    return to ? `hand this over to ${to}` : "hand this over to another bot";
  },
  room_create: "start a room",
  room_update: "change who is in a room",
  room_post: "post in a room",
  room_archive: "close a room",
  room_list: "look at the rooms",
  room_resume: "restart a paused room",
  connect_agent: "connect to an outside agent",
  respond_agent_connection: "answer an outside agent's connection request",
  message_agent: "send a message to an outside agent",
  "destination.write": (args) => {
    const collection = stringArg(args, "collection") ?? "records";
    const title = stringArg(args, "title");
    return title ? `save “${title}” to ${collection}` : `save a record to ${collection}`;
  },
};

/** Composio actions whose slug alone reads badly; the app name is added unless it is in here. */
const CONNECTOR_ACTIONS: Record<string, string> = {
  GMAIL_SEND_EMAIL: "send an email",
  GMAIL_REPLY_TO_THREAD: "reply to an email",
  GMAIL_FORWARD_MESSAGE: "forward an email",
  GMAIL_SEND_DRAFT: "send a drafted email",
  GMAIL_CREATE_EMAIL_DRAFT: "write an email draft",
  GMAIL_DELETE_MESSAGE: "delete an email",
  GMAIL_DELETE_DRAFT: "delete an email draft",
  GMAIL_MOVE_TO_TRASH: "move an email to the trash",
  GMAIL_TRASH_MESSAGE: "move an email to the trash",
  GMAIL_MODIFY_THREAD_LABELS: "change email labels",
  GMAIL_ADD_LABEL_TO_EMAIL: "change email labels",
  GMAIL_FETCH_EMAILS: "read emails",
  GMAIL_FETCH_MESSAGE_BY_THREAD_ID: "read an email thread",
  GOOGLEDRIVE_CREATE_PERMISSION: "share a Drive file",
  GOOGLEDRIVE_ADD_FILE_SHARING_PREFERENCE: "share a Drive file",
  GOOGLEDRIVE_DELETE_PERMISSION: "stop sharing a Drive file",
  GOOGLEDRIVE_DELETE_FILE: "delete a Drive file",
  GOOGLEDRIVE_TRASH_FILE: "move a Drive file to the trash",
  GOOGLEDRIVE_UPLOAD_FILE: "upload a file to Drive",
};

const APP_NAMES: Record<string, string> = {
  GMAIL: "Gmail",
  GOOGLEDRIVE: "Drive",
  GOOGLECALENDAR: "Google Calendar",
  GOOGLEDOCS: "Google Docs",
  GOOGLESHEETS: "Google Sheets",
  GITHUB: "GitHub",
  HUBSPOT: "HubSpot",
  LINKEDIN: "LinkedIn",
  WORDPRESS: "WordPress",
  YOUTUBE: "YouTube",
};

/** Verbs that read better with "a"/"an" before a singular object ("create an event"). */
const ARTICLE_VERBS: Record<string, true> = {
  add: true,
  create: true,
  delete: true,
  draft: true,
  fetch: true,
  find: true,
  forward: true,
  get: true,
  make: true,
  move: true,
  post: true,
  remove: true,
  reply: true,
  schedule: true,
  send: true,
  share: true,
  start: true,
  update: true,
  upload: true,
  write: true,
};
const NO_ARTICLE_WORDS: Record<string, true> = {
  a: true,
  an: true,
  the: true,
  to: true,
  by: true,
  from: true,
  in: true,
  on: true,
  for: true,
  all: true,
};

function plainAction(
  toolName: string,
  args: Record<string, unknown>,
  toolDescription?: string,
): string {
  const builtin = Object.hasOwn(BUILTIN_ACTIONS, toolName) ? BUILTIN_ACTIONS[toolName] : undefined;
  if (typeof builtin === "string") return builtin;
  if (builtin) return builtin(args);
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
  if (mcp) {
    const [, server, tool] = mcp;
    return actionFromDescription(toolDescription, tool!) ?? `use ${humanize(tool!)} (${server})`;
  }
  if (/^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+$/.test(toolName)) {
    return connectorAction(toolName.toUpperCase());
  }
  return `use ${humanize(toolName)}`;
}

/**
 * `GMAIL_SEND_EMAIL` → "send an email (Gmail)";
 * `GOOGLEDRIVE_CREATE_PERMISSION` → "share a Drive file".
 */
function connectorAction(slug: string): string {
  const [toolkit, ...rest] = slug.split("_");
  const app = APP_NAMES[toolkit!] ?? capitalize(toolkit!.toLowerCase());
  const known = CONNECTOR_ACTIONS[slug];
  const phrase = known ?? withArticle(rest.map((word) => word.toLowerCase()));
  return phrase.toLowerCase().includes(app.toLowerCase()) ? phrase : `${phrase} (${app})`;
}

function withArticle(words: string[]): string {
  const [verb, object] = words;
  if (
    !verb ||
    !object ||
    ARTICLE_VERBS[verb] !== true ||
    NO_ARTICLE_WORDS[object] === true ||
    (object.endsWith("s") && !object.endsWith("ss"))
  ) {
    return words.join(" ").replace(/\bid\b/g, "ID");
  }
  const article = /^[aeiou]/.test(object) ? "an" : "a";
  return [verb, article, ...words.slice(1)].join(" ").replace(/\bid\b/g, "ID");
}

/** An MCP tool's own description, first sentence, as "<verb> …"; undefined when unusable. */
function actionFromDescription(description: string | undefined, toolPart: string) {
  const first = description
    ?.trim()
    .split(/(?<=[.!?])\s+|\n/)[0]
    ?.trim()
    .replace(/[.!?:;,]+$/, "");
  // The MCP connector falls back to the bare tool name when a server gives no description.
  if (!first || first === toolPart) return undefined;
  const text = first.replace(/^use (?:this(?: tool)?|it) to\s+/i, "");
  const [word, ...rest] = text.split(/\s+/);
  if (!word || /^(?:this|that|a|an|the|tool|returns?|it)$/i.test(word)) return undefined;
  const verb = word === word.toUpperCase() ? word : baseVerb(word.toLowerCase());
  return truncate([verb, ...rest].join(" "), MAX_DESCRIPTION_ACTION_LENGTH);
}

/** "Searches" → "search", "Queries" → "query", "Lists" → "list"; base forms are unchanged. */
function baseVerb(word: string): string {
  if (word.endsWith("ss")) return word;
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (/(?:ch|sh|x|z|ss)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s")) return word.slice(0, -1);
  return word;
}

function botAction(prefix: string, args: Record<string, unknown>): string {
  const name = stringArg(args, "confirm_name", "confirmName");
  return name ? `${prefix} ${name}` : prefix;
}

// ---- Detail lines ("To: …", "Why: …") ---------------------------------------------------------

type FieldSpec = { keys: string[]; label: string; code?: boolean; file?: boolean };

/** Key arguments, in the order a person reads them. */
const FIELD_SPECS: FieldSpec[] = [
  { keys: ["collection"], label: "Where" },
  {
    keys: ["to", "recipient", "recipient_email", "recipients", "email_address", "emailAddress"],
    label: "To",
  },
  { keys: ["address"], label: "To" },
  { keys: ["subject"], label: "Subject" },
  { keys: ["title"], label: "Title" },
  { keys: ["message", "body", "text", "comment", "message_body"], label: "Message" },
  { keys: ["command", "cmd"], label: "Command", code: true },
  { keys: ["query", "q", "search_query"], label: "Search for" },
  { keys: ["path", "file_path", "filePath", "filename", "file_name"], label: "File", file: true },
  { keys: ["url", "uri", "link"], label: "Link" },
  { keys: ["prompt", "task"], label: "Prompt" },
  { keys: ["content"], label: "Text" },
  { keys: ["role"], label: "Access" },
  { keys: ["amount"], label: "Amount" },
];
const FIELD_KEYS = new Set(FIELD_SPECS.flatMap((spec) => spec.keys));
const SECRET_KEY_WORDS: Record<string, true> = {
  apikey: true,
  auth: true,
  authorization: true,
  cookie: true,
  credential: true,
  credentials: true,
  key: true,
  keys: true,
  passphrase: true,
  passwd: true,
  password: true,
  pwd: true,
  secret: true,
  secrets: true,
  token: true,
  tokens: true,
};

function formatApprovalDetail(
  toolName: string,
  actions: ApprovalAction[],
  secrets: string[],
  options?: ApprovalAskOptions,
): string | undefined {
  const lines: string[] = [];
  if (toolName === "create_space") {
    lines.push(
      "Bots, groups, chats, files, memory, and integrations in this space stay separate from other spaces.",
    );
  }
  for (const action of actions) {
    const fields = actionFields(action, secrets);
    if (fields.length > 0 && actions.length > 1) {
      lines.push(`${capitalize(plainAction(action.toolName, action.args))}:`);
    }
    lines.push(...fields);
  }
  const why = options?.intention ? oneLine(options.intention, secrets, MAX_WHY_LENGTH) : "";
  if (why) lines.push(`Why: ${why}`);
  const reviewReason = options?.reviewReason
    ? oneLine(options.reviewReason.replace(/\u2014|\u2013/g, "-"), secrets, MAX_WHY_LENGTH)
    : "";
  if (reviewReason) lines.push(`Safety check: ${reviewReason}`);
  if (options?.allowAlways === false) lines.push(APPROVAL_NEVER_AUTOMATIC_LINE);
  if (lines.length === 0) return undefined;
  return lines.join("\n");
}

function actionFields(action: ApprovalAction, secrets: string[]): string[] {
  const fields: string[] = [];
  const add = (label: string, raw: unknown, spec?: FieldSpec) => {
    if (fields.length >= MAX_FIELDS_PER_ACTION) return;
    let text = displayValue(raw);
    if (!text) return;
    if (spec?.file) text = fileName(text) ?? text;
    const value = oneLine(text, secrets, MAX_FIELD_LENGTH);
    if (!value) return;
    fields.push(`${label}: ${spec?.code ? `\`${value}\`` : value}`);
  };
  for (const spec of FIELD_SPECS) {
    const key = spec.keys.find(
      (candidate) => !secretLikeKey(candidate) && displayValue(action.args[candidate]),
    );
    if (key) add(spec.label, action.args[key], spec);
  }
  // A connector tool's other plain arguments; built-ins show only the fields above.
  if (!Object.hasOwn(BUILTIN_ACTIONS, action.toolName)) {
    for (const [key, value] of Object.entries(action.args)) {
      if (FIELD_KEYS.has(key) || secretLikeKey(key)) continue;
      add(capitalize(humanize(key)), value);
    }
  }
  return fields;
}

/** Drop arguments whose name reads as a token, key, password or secret. */
function secretLikeKey(key: string): boolean {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((word) => SECRET_KEY_WORDS[word] === true);
}

function displayValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value.join(", ").trim();
  }
  return "";
}

/** Redact first, so a cut never leaves part of a secret behind. */
function oneLine(value: string, secrets: string[], maxLength: number): string {
  return truncate(redactSecrets(value, secrets).replace(/\s+/g, " ").trim(), maxLength);
}

// ---- Shared helpers ---------------------------------------------------------------------------

function stringArg(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function fileName(path: string | undefined): string | undefined {
  const name = path?.split(/[\\/]/).filter(Boolean).at(-1);
  return name || undefined;
}

function humanize(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\bid\b/g, "ID");
}

function joinPhrases(phrases: string[]): string {
  if (phrases.length <= 1) return phrases[0] ?? "";
  return `${phrases.slice(0, -1).join(", ")} and ${phrases.at(-1)}`;
}

function capitalize(value: string): string {
  return value ? `${value[0]!.toUpperCase()}${value.slice(1)}` : value;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}
