import { describe, expect, it } from "vitest";
import {
  type ActionApprovalRule,
  applyJudgeDecision,
  batchedConnectorActions,
  COMPOSIO_MULTI_EXECUTE_TOOL,
  combineActionApprovals,
  connectorKindFromToolName,
  connectorToolRequiresApproval,
  isApprovalAskBlock,
  isOwnerStartedRun,
  isSecretAskBlock,
  planActionGate,
  resolveActionApproval,
  resolveActionApprovalDetail,
  shellCommandForms,
  shellRulePattern,
  toolRequiresApproval,
  toolRequiresExplicitApproval,
  unattendedTriggerToolRequiresApproval,
  watchToolRefusal,
} from "./action-approval.js";

describe("toolRequiresApproval", () => {
  it("requires approval for consequential builtins and destination writes", () => {
    expect(toolRequiresApproval("destination.write", false)).toBe(true);
    expect(toolRequiresApproval("destination.write", true)).toBe(true);
    expect(toolRequiresApproval("secret_request", false)).toBe(true);
    expect(toolRequiresApproval("forget_secret", false)).toBe(true);
    expect(toolRequiresApproval("forget_memory", false)).toBe(true);
    expect(toolRequiresApproval("list_secrets", false)).toBe(false);
    expect(toolRequiresApproval("delete_bot", false)).toBe(true);
    expect(toolRequiresApproval("archive_bot", false)).toBe(true);
    expect(toolRequiresApproval("cloud_agent_launch", false)).toBe(true);
    expect(toolRequiresApproval("create_space", false)).toBe(true);
    expect(toolRequiresExplicitApproval("create_space")).toBe(true);
    expect(toolRequiresExplicitApproval("save_shared_memory")).toBe(false);
    expect(toolRequiresExplicitApproval("archive_bot")).toBe(false);
  });

  it("does not gate read-only or local work", () => {
    for (const name of [
      "list_files",
      "computer_observe",
      "read_file",
      "write_file",
      "shell",
      "remember",
      "save_shared_memory",
      "spawn_bot",
      "run_subagent",
    ]) {
      expect(toolRequiresApproval(name, false)).toBe(false);
    }
  });

  it("always asks before fleet writes that touch several bots, cost money or rewrite a bot", () => {
    for (const name of [
      "create_group",
      "update_group",
      "set_child_instructions",
      "set_child_bot_model",
      "create_child_routine",
    ]) {
      expect(toolRequiresApproval(name, false)).toBe(true);
      expect(toolRequiresExplicitApproval(name)).toBe(true);
    }
  });

  it("never asks before reading the fleet or organizing the sidebar", () => {
    for (const name of ["list_fleet", "organize_bot", "update_bot"]) {
      expect(toolRequiresApproval(name, false)).toBe(false);
      expect(toolRequiresExplicitApproval(name)).toBe(false);
    }
    expect(toolRequiresApproval("organize_bot", true)).toBe(false);
  });

  it("gates connector executes except obvious reads", () => {
    expect(toolRequiresApproval("gmail_send_email", true)).toBe(true);
    expect(toolRequiresApproval("crm_create_note", true)).toBe(true);
    expect(toolRequiresApproval("get_contact", true)).toBe(false);
    expect(toolRequiresApproval("contacts_get", true)).toBe(false);
    expect(toolRequiresApproval("GMAIL_LIST_THREADS", true)).toBe(false);
    expect(toolRequiresApproval("list_messages", true)).toBe(false);
    expect(toolRequiresApproval("search_threads", true)).toBe(false);
    expect(toolRequiresApproval("find_user", true)).toBe(false);
    expect(toolRequiresApproval("read_inbox", true)).toBe(false);
    expect(toolRequiresApproval("contacts_get_or_create", true)).toBe(true);
    expect(toolRequiresApproval("notion_search_and_update", true)).toBe(true);
    expect(toolRequiresApproval("crm_get_then_upsert", true)).toBe(true);
  });
});

describe("connectorToolRequiresApproval", () => {
  it("matches read-only connector tool names", () => {
    expect(connectorToolRequiresApproval("list_items")).toBe(false);
    expect(connectorToolRequiresApproval("send_message")).toBe(true);
  });

  it("requires approval for a declared write whatever its name says", () => {
    expect(connectorToolRequiresApproval("read_profile_card", false)).toBe(true);
    expect(connectorToolRequiresApproval("find_validator_record", false)).toBe(true);
    expect(connectorToolRequiresApproval("read_profile_card", true)).toBe(false);
    expect(connectorToolRequiresApproval("read_profile_card")).toBe(false);
  });

  it("never lets a declared read relax a mutating or ambiguous name", () => {
    expect(connectorToolRequiresApproval("delete_item", true)).toBe(true);
    expect(connectorToolRequiresApproval("get_or_create_contact", true)).toBe(true);
    expect(connectorToolRequiresApproval("profile_card", true)).toBe(true);
  });

  it("lets a trusted declared read lift the default-deny, never a mutating name", () => {
    expect(connectorToolRequiresApproval("memory_recall", true, true)).toBe(false);
    expect(connectorToolRequiresApproval("memory_recall", undefined, true)).toBe(true);
    expect(connectorToolRequiresApproval("memory_recall", false, true)).toBe(true);
    expect(connectorToolRequiresApproval("memory_recall", true)).toBe(true);
    expect(connectorToolRequiresApproval("delete_item", true, true)).toBe(true);
    expect(connectorToolRequiresApproval("get_or_create_contact", true, true)).toBe(true);
  });
});

describe("resolveActionApprovalDetail", () => {
  it("applies category rules to declared writes with read-looking names", () => {
    const rules = [
      { effect: "require_approval" as const, matchKind: "category" as const, matchValue: "email" },
    ];
    const base = { toolName: "gmail_read_thread", connectorKind: "gmail", rules };
    expect(resolveActionApprovalDetail(base).decision).toBe("allow");
    expect(resolveActionApprovalDetail({ ...base, readOnly: false }).decision).toBe("ask");
  });
});

describe("isOwnerStartedRun", () => {
  it.each([
    ["user", false, true],
    ["call_end", false, true],
    ["follow_up", true, true],
    ["follow_up", false, false],
    ["bot_message", true, false],
    ["messaging", true, false],
    ["spawn", true, false],
    ["tickets", true, false],
    ["webhook", true, false],
    ["routine", true, false],
    ["resume", true, false],
    ["unknown", true, false],
  ])("treats %s (follow-up from user: %s) as owner-started: %s", (trigger, fromUser, expected) => {
    expect(isOwnerStartedRun(trigger, fromUser)).toBe(expected);
  });
});

describe("shell rules", () => {
  const ask: ActionApprovalRule = {
    effect: "require_approval",
    matchKind: "shell",
    matchValue: "^git push",
  };
  const decide = (shellCommand: string, rules: ActionApprovalRule[] = [ask]) =>
    resolveActionApprovalDetail({ toolName: "shell", shellCommand, rules });

  it("matches the command itself", () => {
    expect(decide("git push origin main")).toMatchObject({
      decision: "ask",
      source: "require_approval",
    });
    expect(decide("git status").source).toBe("default");
  });

  it.each([
    "bash -c 'git push origin main'",
    'sh -c "git push"',
    "bash -lc 'git push'",
    "env GIT_TRACE=1 git push",
    "env -i HOME=/root git push",
    "timeout 60 git push",
    "timeout -s KILL 5m git push",
    "nohup git push",
    "nohup timeout 30 env A=1 bash -c 'git push --tags'",
    "/usr/bin/env git push",
  ])("looks through wrappers: %s", (command) => {
    expect(decide(command).decision).toBe("ask");
  });

  it("lists each unwrapped form", () => {
    expect(shellCommandForms("nohup bash -c 'timeout 5 git push'")).toEqual([
      "nohup bash -c 'timeout 5 git push'",
      "bash -c 'timeout 5 git push'",
      "timeout 5 git push",
      "git push",
    ]);
  });

  it("allows a command an always_allow shell rule matches", () => {
    const allow: ActionApprovalRule = {
      effect: "always_allow",
      matchKind: "shell",
      matchValue: "^ls\\b",
    };
    expect(decide("ls -la", [allow])).toMatchObject({
      decision: "allow",
      source: "always_allow",
    });
  });

  it("beats a tool-level shell rule", () => {
    const toolAllow: ActionApprovalRule = {
      effect: "always_allow",
      matchKind: "tool",
      matchValue: "shell",
    };
    expect(decide("git push", [toolAllow, ask]).decision).toBe("ask");
    expect(decide("git status", [toolAllow, ask]).source).toBe("always_allow");
  });

  it("ignores other tools, a missing command and an invalid stored regex", () => {
    expect(
      resolveActionApprovalDetail({
        toolName: "write_file",
        shellCommand: "git push",
        rules: [ask],
      }).source,
    ).toBe("default");
    expect(resolveActionApprovalDetail({ toolName: "shell", rules: [ask] }).source).toBe("default");
    expect(decide("git (push", [{ ...ask, matchValue: "git (push" }]).source).toBe("default");
  });

  it("compiles only valid patterns", () => {
    expect(shellRulePattern("^git push")).toBeInstanceOf(RegExp);
    expect(shellRulePattern("git (push")).toBeNull();
  });
});

describe("unattendedTriggerToolRequiresApproval", () => {
  it("forces approval for webhook-triggered local side effects", () => {
    for (const name of ["shell", "write_file", "browser_act", "computer_act"]) {
      expect(unattendedTriggerToolRequiresApproval("webhook", name, false)).toBe(true);
    }
  });

  it("allows webhook-triggered reads to stay unattended", () => {
    for (const name of [
      "computer_observe",
      "read_file",
      "web_search",
      "browser_snapshot",
      "request_takeover",
      "run_subagent",
      "list_fleet",
    ]) {
      expect(unattendedTriggerToolRequiresApproval("webhook", name, false)).toBe(false);
    }
    expect(unattendedTriggerToolRequiresApproval("webhook", "github_get_issue", true)).toBe(false);
  });

  it("forces approval for webhook-triggered connector writes regardless of normal rules", () => {
    expect(unattendedTriggerToolRequiresApproval("webhook", "github_create_issue", true)).toBe(
      true,
    );
    expect(unattendedTriggerToolRequiresApproval("user", "shell", false)).toBe(false);
  });

  it("forces approval for webhook-triggered declared writes with read-looking names", () => {
    for (const name of ["read_profile_card", "find_validator_record", "get_status"]) {
      expect(unattendedTriggerToolRequiresApproval("webhook", name, true, false)).toBe(true);
      expect(toolRequiresApproval(name, true, false)).toBe(true);
    }
    expect(unattendedTriggerToolRequiresApproval("webhook", "read_profile_card", true, true)).toBe(
      false,
    );
    expect(unattendedTriggerToolRequiresApproval("webhook", "delete_record", true, true)).toBe(
      true,
    );
    expect(unattendedTriggerToolRequiresApproval("user", "read_profile_card", true, false)).toBe(
      false,
    );
  });
});

describe("isApprovalAskBlock", () => {
  it("detects allow/deny approval cards", () => {
    expect(
      isApprovalAskBlock({
        kind: "ask",
        approvalEffectId: "effect-1",
        actions: [
          { id: "allow", label: "Allow once" },
          { id: "always", label: "Always allow" },
          { id: "deny", label: "Deny" },
        ],
      }),
    ).toBe(true);
    expect(isApprovalAskBlock({ kind: "ask" })).toBe(false);
    expect(
      isApprovalAskBlock({
        kind: "ask",
        approvalEffectId: "effect-1",
        actions: [{ id: "deny", label: "No" }],
      }),
    ).toBe(false);
  });
});

describe("isSecretAskBlock", () => {
  it("detects masked secret asks", () => {
    expect(isSecretAskBlock({ kind: "ask", input: "secret" })).toBe(true);
    expect(isSecretAskBlock({ kind: "ask", input: "text" })).toBe(false);
    expect(
      isSecretAskBlock({
        kind: "ask",
        input: "secret",
        approvalEffectId: "effect-1",
      }),
    ).toBe(false);
  });
});

describe("connectorKindFromToolName", () => {
  it("uses the first underscore segment", () => {
    expect(connectorKindFromToolName("gmail_send_email")).toBe("gmail");
  });

  it("prefers the longest matching connected provider slug", () => {
    expect(
      connectorKindFromToolName("microsoft_outlook_send_email", ["microsoft", "microsoft_outlook"]),
    ).toBe("microsoft_outlook");
  });
});

describe("resolveActionApproval", () => {
  const alwaysAllowDestination: ActionApprovalRule[] = [
    { effect: "always_allow", matchKind: "tool", matchValue: "destination.write" },
  ];
  const requireEmail: ActionApprovalRule[] = [
    { effect: "require_approval", matchKind: "category", matchValue: "email" },
  ];
  const requireDestination: ActionApprovalRule[] = [
    { effect: "require_approval", matchKind: "tool", matchValue: "destination.write" },
  ];

  it("skips approval when always-allow matches", () => {
    expect(
      resolveActionApproval({
        toolName: "destination.write",
        rules: alwaysAllowDestination,
      }),
    ).toBe("allow");
  });

  it("requires approval for email even when always-allow would match another tool", () => {
    expect(
      resolveActionApproval({
        toolName: "gmail_send_email",
        rules: [...alwaysAllowDestination, ...requireEmail],
      }),
    ).toBe("ask");
  });

  it("does not apply consequential categories to connector reads", () => {
    expect(
      resolveActionApproval({
        toolName: "gmail_list_threads",
        rules: requireEmail,
      }),
    ).toBe("allow");
  });

  it("lets an explicit rule gate a tool that is exempt by default", () => {
    expect(
      resolveActionApproval({
        toolName: "shell",
        rules: [{ effect: "require_approval", matchKind: "tool", matchValue: "shell" }],
      }),
    ).toBe("ask");
  });

  it("lets require_approval beat always-allow at the same specificity", () => {
    expect(
      resolveActionApproval({
        toolName: "destination.write",
        rules: [...alwaysAllowDestination, ...requireDestination],
      }),
    ).toBe("ask");
  });

  it("allows actions by default when no rules match", () => {
    expect(
      resolveActionApproval({
        toolName: "list_files",
        rules: [],
      }),
    ).toBe("allow");
    expect(
      resolveActionApproval({
        toolName: "destination.write",
        rules: [],
      }),
    ).toBe("allow");
  });

  it("lets a tool exception override a broader category rule", () => {
    expect(
      resolveActionApproval({
        toolName: "gmail_send_email",
        rules: [
          ...requireEmail,
          { effect: "always_allow", matchKind: "tool", matchValue: "gmail_send_email" },
        ],
      }),
    ).toBe("allow");
  });

  it("labels always-allow vs default allow", () => {
    expect(
      resolveActionApprovalDetail({
        toolName: "destination.write",
        rules: alwaysAllowDestination,
      }),
    ).toMatchObject({ decision: "allow", source: "always_allow" });
    expect(
      resolveActionApprovalDetail({
        toolName: "destination.write",
        rules: [],
      }),
    ).toMatchObject({ decision: "allow", source: "default" });
  });
});

describe("planActionGate", () => {
  const consequential = true;

  it("lets require_approval win without judging", () => {
    expect(
      planActionGate({
        resolved: {
          decision: "ask",
          source: "require_approval",
          matchingRules: [],
        },
        consequential,
        autoReviewEnabled: true,
        checkerConfigured: true,
      }),
    ).toBe("ask");
  });

  it("lets always_allow skip the judge", () => {
    expect(
      planActionGate({
        resolved: {
          decision: "allow",
          source: "always_allow",
          matchingRules: [],
        },
        consequential,
        autoReviewEnabled: true,
        checkerConfigured: true,
      }),
    ).toBe("allow");
  });

  it("judges consequential default actions when auto review is ready", () => {
    expect(
      planActionGate({
        resolved: { decision: "allow", source: "default", matchingRules: [] },
        consequential,
        autoReviewEnabled: true,
        checkerConfigured: true,
      }),
    ).toBe("judge");
  });

  it("stays YOLO when auto review is off or checker missing", () => {
    expect(
      planActionGate({
        resolved: { decision: "allow", source: "default", matchingRules: [] },
        consequential,
        autoReviewEnabled: false,
        checkerConfigured: true,
      }),
    ).toBe("allow");
    expect(
      planActionGate({
        resolved: { decision: "allow", source: "default", matchingRules: [] },
        consequential,
        autoReviewEnabled: true,
        checkerConfigured: false,
      }),
    ).toBe("allow");
  });

  it("does not judge non-consequential tools", () => {
    expect(
      planActionGate({
        resolved: { decision: "allow", source: "default", matchingRules: [] },
        consequential: false,
        autoReviewEnabled: true,
        checkerConfigured: true,
      }),
    ).toBe("allow");
  });
});

describe("applyJudgeDecision", () => {
  it("maps pass and ask", () => {
    expect(applyJudgeDecision({ decision: "pass", consequential: true })).toBe("allow");
    expect(applyJudgeDecision({ decision: "ask", consequential: true })).toBe("ask");
  });

  it("fails closed on consequential checker errors and open on exempt", () => {
    expect(applyJudgeDecision({ decision: "error", consequential: true })).toBe("ask");
    expect(applyJudgeDecision({ decision: "error", consequential: false })).toBe("allow");
  });
});

describe("watchToolRefusal", () => {
  const rule = (matchKind: string, matchValue: string, effect = "require_approval") =>
    ({ effect, matchKind, matchValue }) as Parameters<typeof watchToolRefusal>[0]["rules"][number];

  it("allows only explicitly declared reads", () => {
    expect(watchToolRefusal({ toolName: "drive_files", readOnly: true, rules: [] })).toBeNull();
  });

  it.each(["brain_changed", "gmail_search_threads", "clickbot_tasks", "send_email"])(
    "refuses missing metadata even for %s",
    (toolName) => {
      expect(watchToolRefusal({ toolName, rules: [] })).toMatch(/can change data/);
      expect(watchToolRefusal({ toolName, readOnly: false, rules: [] })).toMatch(/can change data/);
    },
  );

  it("refuses a read the space's rules would ask about", () => {
    expect(
      watchToolRefusal({
        toolName: "brain_search",
        readOnly: true,
        rules: [rule("tool", "brain_search")],
      }),
    ).toMatch(/approval/);
    expect(
      watchToolRefusal({
        toolName: "brain_search",
        readOnly: true,
        rules: [rule("tool", "brain_search", "always_allow")],
      }),
    ).toBeNull();
  });
});

describe("Composio batch approval", () => {
  it("names the actions a multi-execute batch runs, and nothing for other or malformed calls", () => {
    const tools = [
      { tool_slug: "GMAIL_FETCH_MESSAGE_BY_THREAD_ID", arguments: { thread_id: "t" } },
      { tool_slug: " GMAIL_SEND_EMAIL ", arguments: "{}" },
      { tool_slug: "GMAIL_FETCH_MESSAGE_BY_THREAD_ID" },
    ];
    expect(batchedConnectorActions(COMPOSIO_MULTI_EXECUTE_TOOL, { tools })).toEqual([
      "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
      "GMAIL_SEND_EMAIL",
    ]);
    expect(batchedConnectorActions("GMAIL_SEND_EMAIL", { tools })).toBeNull();
    expect(batchedConnectorActions(COMPOSIO_MULTI_EXECUTE_TOOL, { tools: [] })).toBeNull();
    // One unnamed action keeps the whole batch judged as the wrapper.
    expect(
      batchedConnectorActions(COMPOSIO_MULTI_EXECUTE_TOOL, {
        tools: [...tools, { arguments: {} }],
      }),
    ).toBeNull();
  });

  it("treats a fetch as a read, unless the name also mutates", () => {
    expect(connectorToolRequiresApproval("GMAIL_FETCH_MESSAGE_BY_THREAD_ID")).toBe(false);
    expect(connectorToolRequiresApproval("GMAIL_FETCH_AND_DELETE_MESSAGE")).toBe(true);
    expect(connectorToolRequiresApproval("GMAIL_SEND_EMAIL")).toBe(true);
  });

  it("lets a batch run unattended only when every consequential action is always-allowed", () => {
    const read = {
      resolved: resolveActionApprovalDetail({ toolName: "GMAIL_FETCH_X", rules: [] }),
      consequential: false,
    };
    const allowRule: ActionApprovalRule = {
      effect: "always_allow",
      matchKind: "tool",
      matchValue: "GMAIL_ADD_LABEL",
    };
    const labelAllowed = {
      resolved: resolveActionApprovalDetail({ toolName: "GMAIL_ADD_LABEL", rules: [allowRule] }),
      consequential: true,
    };
    const sendDefault = {
      resolved: resolveActionApprovalDetail({ toolName: "GMAIL_SEND_EMAIL", rules: [allowRule] }),
      consequential: true,
    };
    const requireSend: ActionApprovalRule = {
      effect: "require_approval",
      matchKind: "tool",
      matchValue: "GMAIL_SEND_EMAIL",
    };
    const sendRequired = {
      resolved: resolveActionApprovalDetail({ toolName: "GMAIL_SEND_EMAIL", rules: [requireSend] }),
      consequential: true,
    };

    expect(combineActionApprovals([read, labelAllowed]).resolved.source).toBe("always_allow");
    // Allowing the label action never allows the send in the same batch.
    expect(combineActionApprovals([labelAllowed, sendDefault]).resolved.source).toBe("default");
    expect(combineActionApprovals([labelAllowed, sendRequired]).resolved.decision).toBe("ask");
    expect(combineActionApprovals([read])).toEqual({
      resolved: { decision: "allow", source: "default", matchingRules: [] },
      consequential: false,
    });
  });
});
