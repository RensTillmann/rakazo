import type { ActionApprovalRule as StoredActionApprovalRule } from "@rakazo/contracts";

const APPROVAL_EXEMPT_TOOLS = new Set([
  "computer_observe",
  "computer_act",
  "browser_navigate",
  "browser_snapshot",
  "browser_act",
  "list_files",
  "read_file",
  "read_history",
  "search_history",
  "write_file",
  "shell",
  "open_path",
  "launch_app",
  "remember",
  "request_takeover",
  "request_secret",
  "run_subagent",
  "spawn_bot",
  "schedule_create",
  "schedule_list",
  "schedule_cancel",
]);

const APPROVAL_REQUIRED_BUILTIN_TOOLS = new Set([
  "generate_image",
  "generate_video",
  "destination.write",
  "delete_bot",
  "archive_bot",
  "secret_request",
  "forget_secret",
  "forget_memory",
  "cloud_agent_launch",
  "cloud_agent_reply",
  "cloud_agent_cancel",
]);
const EXPLICIT_APPROVAL_BUILTIN_TOOLS = new Set(["create_space", "propose_instructions_update"]);

const UNATTENDED_SAFE_BUILTIN_TOOLS = new Set([
  "browser_snapshot",
  "cloud_agent_status",
  "computer_observe",
  "list_files",
  "list_secrets",
  "read_file",
  "recall_memory",
  "request_takeover",
  "run_subagent",
  "task_catalog",
  "schedule_list",
  "scratchpad_list",
  "skill_read",
  "web_fetch",
  "web_search",
]);

const READ_ONLY_CONNECTOR_PATTERN = /(^|_)(get|list|search|find|read|fetch)(_|$)/i;
const MUTATING_CONNECTOR_PATTERN =
  /(^|_)(accept|add|approve|archive|assign|buy|cancel|charge|checkout|close|commit|copy|create|delete|deploy|disable|enable|execute|forward|grant|invite|link|mark|merge|modify|move|patch|pay|post|publish|purchase|put|register|reject|remove|rename|replace|reply|reset|revoke|run|schedule|send|set|share|start|stop|submit|subscribe|trigger|unassign|unlink|unsubscribe|update|upload|upsert|write)(_|$)/i;
const COMPOUND_CONNECTOR_ACTION_PATTERN = /_(and|or|then)_/i;

const EMAIL_CONNECTOR_SLUGS = new Set(["gmail", "outlook", "microsoft_outlook"]);
const PURCHASE_CONNECTOR_SLUGS = new Set(["stripe", "shopify", "paypal", "square"]);

export type ActionApprovalRule = Pick<
  StoredActionApprovalRule,
  "effect" | "matchKind" | "matchValue"
>;

export function connectorKindFromToolName(toolName: string, connectorKinds: string[] = []): string {
  const normalizedTool = toolName.toLowerCase();
  const matched = connectorKinds
    .map((kind) => kind.toLowerCase())
    .filter((kind) => normalizedTool === kind || normalizedTool.startsWith(`${kind}_`))
    .sort((left, right) => right.length - left.length)[0];
  if (matched) return matched;
  const [segment] = toolName.split("_");
  return (segment ?? toolName).toLowerCase();
}

/**
 * `readOnly` is the connector tool's declared effect (for installed APIs, derived from the stored
 * HTTP method and read-only flag). A declared write always needs approval. A declared read never
 * relaxes the name check: the provider chooses both the name and the hint.
 *
 * Fleet (`trustDeclaredRead`): an MCP server's `readOnlyHint` comes from a server the owner added
 * and allowlisted, so a declared read lifts the default-deny for names outside the read-word list
 * (`memory_recall`). Mutating and compound names still ask whatever the hint says.
 */
export function connectorToolRequiresApproval(
  toolName: string,
  readOnly?: boolean,
  trustDeclaredRead = false,
): boolean {
  if (readOnly === false) return true;
  if (MUTATING_CONNECTOR_PATTERN.test(toolName)) return true;
  if (COMPOUND_CONNECTOR_ACTION_PATTERN.test(toolName)) return true;
  if (trustDeclaredRead && readOnly === true) return false;
  return !READ_ONLY_CONNECTOR_PATTERN.test(toolName);
}

export function toolRequiresApproval(
  toolName: string,
  viaConnector: boolean,
  readOnly?: boolean,
  trustDeclaredRead = false,
): boolean {
  if (APPROVAL_EXEMPT_TOOLS.has(toolName)) return false;
  if (toolRequiresExplicitApproval(toolName)) return true;
  if (APPROVAL_REQUIRED_BUILTIN_TOOLS.has(toolName)) return true;
  if (viaConnector) return connectorToolRequiresApproval(toolName, readOnly, trustDeclaredRead);
  return false;
}

/** Security-boundary changes cannot be auto-reviewed or permanently allowed. */
export function toolRequiresExplicitApproval(toolName: string): boolean {
  return EXPLICIT_APPROVAL_BUILTIN_TOOLS.has(toolName);
}

/** External webhook runs may inspect state unattended, but side effects always need the owner. */
export function unattendedTriggerToolRequiresApproval(
  trigger: string,
  toolName: string,
  viaConnector: boolean,
  readOnly?: boolean,
  trustDeclaredRead = false,
): boolean {
  if (trigger !== "webhook") return false;
  return viaConnector
    ? connectorToolRequiresApproval(toolName, readOnly, trustDeclaredRead)
    : !UNATTENDED_SAFE_BUILTIN_TOOLS.has(toolName);
}

function categoryMatches(
  category: string,
  toolName: string,
  connectorKind: string,
  readOnly: boolean | undefined,
): boolean {
  const normalized = category.toLowerCase();
  const consequential = connectorToolRequiresApproval(toolName, readOnly);
  if (normalized === "email") {
    if (EMAIL_CONNECTOR_SLUGS.has(connectorKind.toLowerCase())) return consequential;
    return consequential && /send.*mail|gmail_send|outlook_send/i.test(toolName);
  }
  if (normalized === "purchase") {
    if (PURCHASE_CONNECTOR_SLUGS.has(connectorKind.toLowerCase())) return consequential;
    return consequential && /purchase|pay_|charge|checkout|buy_/i.test(toolName);
  }
  return false;
}

// Fleet: wrappers a shell rule looks through, so `^git push` also matches `env X=1 git push`.
const SHELL_WRAPPER_PATTERNS = [
  /^(?:\S*\/)?env(?:\s+(?:-u\s+\S+|-\S+|[A-Za-z_][A-Za-z0-9_]*=\S*))*\s+(?=\S)/,
  /^(?:\S*\/)?timeout(?:\s+(?:-[sk]\s+\S+|-\S+))*\s+\d+(?:\.\d+)?[smhd]?\s+(?=\S)/,
  /^(?:\S*\/)?nohup\s+(?=\S)/,
];
const SHELL_DASH_C_PATTERN = /^(?:\S*\/)?(?:ba|da|z)?sh(?:\s+-[A-Za-z]+)*?\s+-[A-Za-z]*c[A-Za-z]*\s+([\s\S]+)$/;
const MAX_SHELL_UNWRAP = 8;

/**
 * The command itself plus each form left after peeling `bash -c`, `env`, `timeout` and `nohup`
 * prefixes, outermost first. A shell rule matches when its regex matches any of them.
 */
export function shellCommandForms(command: string): string[] {
  const forms = [command];
  let current = command.trim();
  for (let step = 0; step < MAX_SHELL_UNWRAP; step += 1) {
    let next: string | undefined;
    const dashC = SHELL_DASH_C_PATTERN.exec(current);
    if (dashC?.[1]) {
      const inner = dashC[1].trim();
      const quote = inner[0];
      next =
        (quote === "'" || quote === '"') && inner.length > 1 && inner.endsWith(quote)
          ? inner.slice(1, -1)
          : inner;
    } else {
      const wrapper = SHELL_WRAPPER_PATTERNS.find((pattern) => pattern.test(current));
      if (wrapper) next = current.replace(wrapper, "");
    }
    if (next === undefined) break;
    current = next.trim();
    forms.push(current);
  }
  return forms;
}

/** A shell rule's `matchValue` is a JS regex; the RPC refuses one that does not compile. */
export function shellRulePattern(matchValue: string): RegExp | null {
  try {
    return new RegExp(matchValue);
  } catch {
    return null;
  }
}

function ruleMatches(
  rule: ActionApprovalRule,
  toolName: string,
  connectorKind: string,
  readOnly: boolean | undefined,
  shellCommand: string | undefined,
): boolean {
  const value = rule.matchValue.toLowerCase();
  switch (rule.matchKind) {
    case "tool":
      return toolName.toLowerCase() === value;
    case "connector":
      return connectorKind.toLowerCase() === value;
    case "category":
      return categoryMatches(rule.matchValue, toolName, connectorKind, readOnly);
    case "shell": {
      if (toolName !== "shell" || shellCommand === undefined) return false;
      const pattern = shellRulePattern(rule.matchValue);
      return pattern
        ? shellCommandForms(shellCommand).some((form) => pattern.test(form))
        : false;
    }
    default:
      return false;
  }
}

function ruleSpecificity(rule: ActionApprovalRule): number {
  switch (rule.matchKind) {
    case "shell":
      return 4;
    case "tool":
      return 3;
    case "connector":
      return 2;
    case "category":
      return 1;
    default:
      return 0;
  }
}

export type ActionApprovalSource = "require_approval" | "always_allow" | "default";

export type ActionApprovalResolved = {
  decision: "ask" | "allow";
  source: ActionApprovalSource;
  matchingRules: ActionApprovalRule[];
};

/** Deterministic rule resolution. Always-allow and require-approval both beat the default. */
export function resolveActionApprovalDetail(input: {
  toolName: string;
  connectorKind?: string;
  readOnly?: boolean;
  /** The `shell` tool's command, for `shell` rules. */
  shellCommand?: string;
  rules: ActionApprovalRule[];
}): ActionApprovalResolved {
  const connectorKind = input.connectorKind ?? connectorKindFromToolName(input.toolName);
  const matchingRules = input.rules.filter((rule) =>
    ruleMatches(rule, input.toolName, connectorKind, input.readOnly, input.shellCommand),
  );
  if (matchingRules.length === 0) {
    return { decision: "allow", source: "default", matchingRules };
  }

  const highestSpecificity = Math.max(...matchingRules.map(ruleSpecificity));
  const winners = matchingRules.filter((rule) => ruleSpecificity(rule) === highestSpecificity);
  if (winners.some((rule) => rule.effect === "require_approval")) {
    return { decision: "ask", source: "require_approval", matchingRules };
  }
  return { decision: "allow", source: "always_allow", matchingRules };
}

export function resolveActionApproval(input: {
  toolName: string;
  connectorKind?: string;
  readOnly?: boolean;
  rules: ActionApprovalRule[];
}): "ask" | "allow" {
  return resolveActionApprovalDetail(input).decision;
}

/** Composio's batch tool: it runs the connector actions named in `tools[].tool_slug`. */
export const COMPOSIO_MULTI_EXECUTE_TOOL = "COMPOSIO_MULTI_EXECUTE_TOOL";

/**
 * The connector actions a batch call runs, so approval judges (and "Always allow" remembers)
 * each action instead of the batch wrapper. Null for any other tool and for a malformed batch,
 * which then stays judged by the wrapper's own name.
 */
export function batchedConnectorActions(
  toolName: string,
  args: Record<string, unknown> | null | undefined,
): string[] | null {
  if (toolName !== COMPOSIO_MULTI_EXECUTE_TOOL || !Array.isArray(args?.tools)) return null;
  const slugs: unknown[] = args.tools.map((item: unknown) =>
    item && typeof item === "object" && "tool_slug" in item ? item.tool_slug : undefined,
  );
  const named = slugs.filter(
    (slug): slug is string => typeof slug === "string" && slug.trim() !== "",
  );
  if (named.length === 0 || named.length !== slugs.length) return null;
  return [...new Set(named.map((slug) => slug.trim()))];
}

/**
 * One decision for a batch of actions: a require_approval rule on any action asks; the batch
 * counts as always-allowed only when every consequential action is; otherwise the default path
 * decides, as for a single call.
 */
export function combineActionApprovals(
  parts: ReadonlyArray<{ resolved: ActionApprovalResolved; consequential: boolean }>,
): { resolved: ActionApprovalResolved; consequential: boolean } {
  const matchingRules = parts.flatMap((part) => part.resolved.matchingRules);
  const consequential = parts.some((part) => part.consequential);
  if (parts.some((part) => part.resolved.decision === "ask")) {
    return {
      resolved: { decision: "ask", source: "require_approval", matchingRules },
      consequential,
    };
  }
  const gated = parts.filter((part) => part.consequential);
  const source =
    gated.length > 0 && gated.every((part) => part.resolved.source === "always_allow")
      ? "always_allow"
      : "default";
  return { resolved: { decision: "allow", source, matchingRules }, consequential };
}

export type AutoReviewJudgeDecision = "pass" | "ask" | "error";

/**
 * Pure combiner for Auto Review after rule resolution.
 * Rules win: require_approval asks, always_allow runs. Only the default path may call a judge.
 * The judge only escalates to ask; it never silent-denies.
 */
export function planActionGate(input: {
  resolved: ActionApprovalResolved;
  consequential: boolean;
  autoReviewEnabled: boolean;
  checkerConfigured: boolean;
}): "ask" | "allow" | "judge" {
  if (input.resolved.decision === "ask") return "ask";
  if (input.resolved.source === "always_allow") return "allow";
  if (
    input.consequential &&
    input.autoReviewEnabled &&
    input.checkerConfigured &&
    input.resolved.source === "default"
  ) {
    return "judge";
  }
  return "allow";
}

/** Map a judge outcome onto ask/allow. Errors fail closed on consequential tools. */
export function applyJudgeDecision(input: {
  decision: AutoReviewJudgeDecision;
  consequential: boolean;
}): "ask" | "allow" {
  if (input.decision === "pass") return "allow";
  if (input.decision === "ask") return "ask";
  return input.consequential ? "ask" : "allow";
}

export function isSecretAskBlock(block: {
  kind: string;
  input?: string;
  approvalEffectId?: string;
}): boolean {
  return block.kind === "ask" && block.input === "secret" && !block.approvalEffectId;
}

/**
 * Fleet: the approval-card detail line for a card a tool-level or shell `require_approval` rule
 * caused; the web card shows it translated.
 */
export const APPROVAL_NEVER_AUTOMATIC_LINE = "Always asks you (never automatic)";

export function isApprovalAskBlock(block: {
  kind: string;
  approvalEffectId?: string;
  actions?: Array<{ id: string; label: string }>;
}): boolean {
  if (block.kind !== "ask" || !block.approvalEffectId || !block.actions?.length) return false;
  const actionIds = new Set(block.actions.map((action) => action.id));
  return (
    actionIds.has("allow") &&
    actionIds.has("deny") &&
    [...actionIds].every((id) => id === "allow" || id === "always" || id === "deny")
  );
}
