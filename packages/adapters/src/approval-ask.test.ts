import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { approvalDetailLength, approvalPush, buildApprovalAskBlock } from "./approval-ask.js";

function askOf(block: MessageBlock) {
  if (block.kind !== "ask") throw new Error("expected ask block");
  return block;
}

describe("buildApprovalAskBlock", () => {
  it("binds the approval to its effect and redacts secrets", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "gmail_send_email",
      { to: "person@example.test", body: "token-secret" },
      ["token-secret"],
    );

    expect(block).toMatchObject({
      kind: "ask",
      approvalEffectId: "effect-1",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "always", label: "Always allow this tool" },
        { id: "deny", label: "Deny" },
      ],
    });
    expect(JSON.stringify(block)).not.toContain("token-secret");
  });

  it("leaves out Always allow when a rule forbids it", () => {
    const block = buildApprovalAskBlock("effect-1", "shell", { command: "git push" }, [], {
      allowAlways: false,
    });
    expect(block).toMatchObject({
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "deny", label: "Deny" },
      ],
    });
  });

  it("bounds model-controlled summaries and details", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "destination.write",
      { title: "t".repeat(1_000), body: "b".repeat(10_000) },
      [],
    );

    expect(block.kind).toBe("ask");
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.text.length).toBeLessThanOrEqual(501);
    expect(block.detail?.length).toBeLessThanOrEqual(4_001);
  });

  it("adds the safety check's reason after the argument lines", () => {
    const block = askOf(
      buildApprovalAskBlock(
        "effect-1",
        "gmail_send_email",
        { to: "person@example.test", subject: "Hi" },
        [],
        { reviewReason: "Sends email outside the draft-only task." },
      ),
    );

    expect(block.detail).toBe(
      "To: person@example.test\nSubject: Hi\nSafety check: Sends email outside the draft-only task.",
    );
  });

  it("names the actions inside a Composio batch and always-allows the action, not the batch", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "COMPOSIO_MULTI_EXECUTE_TOOL",
      {
        tools: [
          {
            tool_slug: "GMAIL_SEND_EMAIL",
            arguments: JSON.stringify({ to: "person@example.test", subject: "Hi" }),
          },
        ],
      },
      [],
    );

    expect(block).toMatchObject({
      text: "Your bot wants to send an email (Gmail)",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "always", label: "Always allow this action" },
        { id: "deny", label: "Deny" },
      ],
    });
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.detail).toBe("To: person@example.test\nSubject: Hi");
    expect(block.text).not.toContain("COMPOSIO_MULTI_EXECUTE_TOOL");
  });

  it("uses a one-time create or cancel choice for a new security boundary", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "create_space",
      { name: "Customer support" },
      [],
    );

    expect(block).toMatchObject({
      kind: "ask",
      text: "Create space “Customer support”?",
      actions: [
        { id: "allow", label: "Create space", outcome: "created" },
        { id: "deny", label: "Cancel", outcome: "cancelled" },
      ],
    });
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.detail).toContain("stay separate from other spaces");
  });
});

it("shows the full instruction replacement as a diff with Apply and Dismiss", () => {
  const block = buildApprovalAskBlock(
    "effect-1",
    "propose_instructions_update",
    {
      botId: "bot-1",
      previousInstructions: "Draft only",
      instructions: "Draft only\nAsk before sending",
      reason: "Learned preference",
    },
    [],
  );
  expect(block).toMatchObject({
    kind: "ask",
    detail: "Learned preference\n\n- Draft only\n+ Draft only\n+ Ask before sending",
    instructionUpdate: {
      botId: "bot-1",
      before: "Draft only",
      after: "Draft only\nAsk before sending",
    },
    actions: [
      { id: "allow", label: "Apply" },
      { id: "deny", label: "Dismiss" },
    ],
  });
});

it("redacts known secrets in instruction approval details and editable metadata", () => {
  const block = buildApprovalAskBlock(
    "effect-1",
    "propose_instructions_update",
    {
      botId: "bot-1",
      previousInstructions: "old fake-token",
      instructions: "new fake-token",
      reason: "reason fake-token",
    },
    ["fake-token"],
  );
  expect(JSON.stringify(block)).not.toContain("fake-token");
});

describe("fleet approval cards", () => {
  it.each([
    "create_group",
    "update_group",
    "set_child_instructions",
    "set_child_bot_model",
    "create_child_routine",
  ])("builds the %s card from the resolved summary with allow and deny only", (toolName) => {
    const block = buildApprovalAskBlock(
      "effect-1",
      toolName,
      { name: "model typed this" },
      ["fake-token"],
      {
        summary: {
          title: "Create group “Launch”?",
          lines: ["Members: Scout, Writer", "Prompt: use fake-token"],
        },
      },
    );
    expect(block).toEqual({
      kind: "ask",
      approvalEffectId: "effect-1",
      text: "Create group “Launch”?",
      detail: "Members: Scout, Writer\nPrompt: use [redacted]",
      detailFormat: toolName === "set_child_instructions" ? "code" : "text",
      status: "pending",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "deny", label: "Deny" },
      ],
    });
  });

  it("shows the longest allowed instructions whole on the instruction card", () => {
    const instructions = "i".repeat(20_000);
    const lines = ["Old length: 0 characters", "New length: 20000 characters", "", instructions];
    const block = buildApprovalAskBlock("effect-1", "set_child_instructions", {}, [], {
      summary: { title: "Replace the instructions of Scout?", lines },
    });
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.detail).toBe(lines.join("\n"));
    expect(block.actions?.map((action) => action.id)).toEqual(["allow", "deny"]);
    expect(approvalDetailLength("set_child_instructions")).toBeGreaterThanOrEqual(
      lines.join("\n").length,
    );
  });

  it("never offers always allow on a tool that needs explicit approval", () => {
    const block = buildApprovalAskBlock("effect-1", "create_group", { name: "Launch" }, []);
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.actions?.map((action) => action.id)).toEqual(["allow", "deny"]);
  });
});

describe("plain-language approval cards", () => {
  it("titles built-in tools as '<Bot> wants to <action>' and shows their key arguments", () => {
    const message = askOf(
      buildApprovalAskBlock(
        "effect-1",
        "message_bot",
        { bot_id: "bot-josy", confirm_name: "Josy", message: "Can you check case 12?" },
        [],
        { botName: "Isabella" },
      ),
    );
    expect(message.text).toBe("Isabella wants to send a message to Josy");
    expect(message.detail).toBe("Message: Can you check case 12?");

    const shell = askOf(
      buildApprovalAskBlock("effect-1", "shell", { command: "git push", cwd: "/repo" }, [], {
        botName: "Jill",
      }),
    );
    expect(shell.text).toBe("Jill wants to run a command on their computer");
    expect(shell.detail).toBe("Command: `git push`");

    const file = askOf(
      buildApprovalAskBlock(
        "effect-1",
        "write_file",
        { path: "/workspace/reports/week-42.md", content: "# Week 42" },
        [],
        { botName: "Jill" },
      ),
    );
    expect(file.text).toBe("Jill wants to save the file week-42.md");
    expect(file.detail).toBe("File: week-42.md\nText: # Week 42");
  });

  it("humanises a Composio slug and names the app unless the phrase already does", () => {
    const email = askOf(
      buildApprovalAskBlock(
        "effect-1",
        "GMAIL_SEND_EMAIL",
        { recipient_email: "ada@example.test", subject: "Invoice 1042", body: "Paid, thanks." },
        [],
        { botName: "Josy" },
      ),
    );
    expect(email.text).toBe("Josy wants to send an email (Gmail)");
    expect(email.detail).toBe(
      "To: ada@example.test\nSubject: Invoice 1042\nMessage: Paid, thanks.",
    );

    const share = askOf(
      buildApprovalAskBlock(
        "effect-1",
        "GOOGLEDRIVE_CREATE_PERMISSION",
        { file_id: "f1", email_address: "ada@example.test", role: "writer" },
        [],
        { botName: "Josy" },
      ),
    );
    expect(share.text).toBe("Josy wants to share a Drive file");
    expect(share.detail).toBe("To: ada@example.test\nAccess: writer\nFile ID: f1");

    const event = askOf(
      buildApprovalAskBlock("effect-1", "GOOGLECALENDAR_CREATE_EVENT", {}, [], {
        botName: "Josy",
      }),
    );
    expect(event.text).toBe("Josy wants to create an event (Google Calendar)");
  });

  it("lists each inner action of a Composio batch in the title and the detail", () => {
    const block = askOf(
      buildApprovalAskBlock(
        "effect-1",
        "COMPOSIO_MULTI_EXECUTE_TOOL",
        {
          tools: [
            {
              tool_slug: "GMAIL_SEND_EMAIL",
              arguments: { recipient_email: "ada@example.test", subject: "Hi" },
            },
            { tool_slug: "GMAIL_ADD_LABEL_TO_EMAIL", arguments: { message_id: "m1" } },
          ],
        },
        [],
        { botName: "Josy" },
      ),
    );

    expect(block.text).toBe("Josy wants to send an email (Gmail) and change email labels (Gmail)");
    expect(block.detail).toBe(
      [
        "Send an email (Gmail):",
        "To: ada@example.test",
        "Subject: Hi",
        "Change email labels (Gmail):",
        "Message ID: m1",
      ].join("\n"),
    );
    expect(block.actions?.map((action) => action.id)).toEqual(["allow", "always", "deny"]);
  });

  it("titles an MCP tool from its own description, in the base verb form", () => {
    const block = askOf(
      buildApprovalAskBlock(
        "effect-1",
        "mcp__fleet-dr-eggbot__memory_recall",
        { query: "Ada's invoice" },
        [],
        {
          botName: "Elena",
          toolDescription: "Searches the shared memory for facts. Returns up to 10 results.",
        },
      ),
    );

    expect(block.text).toBe("Elena wants to search the shared memory for facts");
    expect(block.detail).toBe("Search for: Ada's invoice");
  });

  it("humanises an MCP tool name when it has no description of its own", () => {
    for (const toolDescription of [undefined, "memory_recall"]) {
      const block = askOf(
        buildApprovalAskBlock("effect-1", "mcp__fleet-dr-eggbot__memory_recall", {}, [], {
          botName: "Elena",
          toolDescription,
        }),
      );
      expect(block.text).toBe("Elena wants to use memory recall (fleet-dr-eggbot)");
    }
  });

  it("drops arguments whose name looks like a token, key, password or secret", () => {
    const block = askOf(
      buildApprovalAskBlock(
        "effect-1",
        "mcp__crm__lookup",
        {
          query: "Ada",
          limit: 5,
          api_key: "k-123",
          authToken: "t-456",
          password: "hunter2",
          client_secret: "s-789",
          keyword: "billing",
        },
        [],
      ),
    );

    expect(block.detail).toBe("Search for: Ada\nLimit: 5\nKeyword: billing");
    for (const secret of ["k-123", "t-456", "hunter2", "s-789"]) {
      expect(JSON.stringify(block)).not.toContain(secret);
    }
  });

  it("cuts each argument to about 160 characters after blanking known secrets", () => {
    const block = askOf(
      buildApprovalAskBlock(
        "effect-1",
        "message_bot",
        { confirm_name: "Josy", message: `${"x".repeat(150)}SECRETVALUE123456 ${"y".repeat(400)}` },
        ["SECRETVALUE123456"],
        { botName: "Isabella" },
      ),
    );

    expect(block.detail).toBe(`Message: ${"x".repeat(150)}[redacted]…`);
    expect(block.detail).not.toContain("SECRETVAL");
  });

  it("adds the bot's last stated intention as a one-line Why, cut to about 200 characters", () => {
    const block = askOf(
      buildApprovalAskBlock("effect-1", "web_search", { query: "Ada invoice" }, [], {
        botName: "Elena",
        intention: "  I'll check what we already\n know about Ada. ",
      }),
    );
    expect(block.detail).toBe(
      "Search for: Ada invoice\nWhy: I'll check what we already know about Ada.",
    );

    const long = askOf(
      buildApprovalAskBlock("effect-1", "web_search", {}, [], { intention: "w".repeat(500) }),
    );
    expect(long.detail).toBe(`Why: ${"w".repeat(200)}…`);
  });

  it("says a never-list card always asks, and only on such cards", () => {
    const never = askOf(
      buildApprovalAskBlock("effect-1", "shell", { command: "git push" }, [], {
        botName: "Jill",
        allowAlways: false,
      }),
    );
    expect(never.detail).toBe("Command: `git push`\nAlways asks you (never automatic)");

    const ordinary = askOf(
      buildApprovalAskBlock("effect-1", "shell", { command: "ls" }, [], { botName: "Jill" }),
    );
    expect(ordinary.detail).not.toContain("Always asks you");
  });
});

describe("approvalPush", () => {
  it("names the bot and the plain action, never the message or email contents", () => {
    const email = approvalPush(
      "Josy",
      "GMAIL_SEND_EMAIL",
      { recipient_email: "ada@example.test", subject: "Invoice 1042", body: "Paid, thanks." },
      [],
    );
    expect(email).toEqual({ title: "Josy needs your OK", body: "Send an email (Gmail)" });
    expect(JSON.stringify(email)).not.toMatch(/Invoice 1042|Paid, thanks/);

    const message = approvalPush(
      "Isabella",
      "message_bot",
      { confirm_name: "Josy", message: "The client's card number is 4111" },
      [],
    );
    expect(message).toEqual({ title: "Isabella needs your OK", body: "Send a message to Josy" });
  });

  it("lists a batch's actions and uses the MCP description", () => {
    expect(
      approvalPush(
        "Josy",
        "COMPOSIO_MULTI_EXECUTE_TOOL",
        {
          tools: [
            { tool_slug: "GMAIL_SEND_EMAIL", arguments: {} },
            { tool_slug: "GOOGLEDRIVE_CREATE_PERMISSION", arguments: {} },
          ],
        },
        [],
      ).body,
    ).toBe("Send an email (Gmail) and share a Drive file");
    expect(
      approvalPush(
        "Elena",
        "mcp__fleet-dr-eggbot__memory_recall",
        { query: "Ada" },
        [],
        "Search the shared memory.",
      ),
    ).toEqual({ title: "Elena needs your OK", body: "Search the shared memory" });
  });
});
