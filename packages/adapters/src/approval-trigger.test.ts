import { describe, expect, it } from "vitest";
import { loadApprovalTrigger } from "./approval-trigger.js";

function fakePrisma(input: {
  message?: { blocks: unknown; clientNonce?: string | null };
  routine?: { name: string };
  group?: { name: string };
}) {
  return {
    message: { findUnique: async () => input.message ?? null },
    routine: { findUnique: async () => input.routine ?? null },
    chatGroup: { findUnique: async () => input.group ?? null },
  } as unknown as Parameters<typeof loadApprovalTrigger>[0];
}

const text = (value: string) => [{ kind: "text", text: value }];

describe("loadApprovalTrigger", () => {
  it("quotes the triggering user message", async () => {
    const prisma = fakePrisma({ message: { blocks: text("Check the invoice") } });
    await expect(
      loadApprovalTrigger(prisma, { trigger: "user", sourceMessageId: "m1" }, {}),
    ).resolves.toEqual({ kind: "user", text: "Check the invoice" });
  });

  it("uses the room for a group run", async () => {
    const prisma = fakePrisma({ message: { blocks: text("Go live") }, group: { name: "Launch" } });
    await expect(
      loadApprovalTrigger(prisma, { trigger: "user", sourceMessageId: "m1" }, { groupId: "g1" }),
    ).resolves.toEqual({ kind: "room", roomName: "Launch", text: "Go live" });
  });

  it("names a scheduled routine", async () => {
    const prisma = fakePrisma({ routine: { name: "Morning brief" } });
    await expect(
      loadApprovalTrigger(prisma, { trigger: "routine", routineId: "r1" }, {}),
    ).resolves.toEqual({ kind: "routine", routineName: "Morning brief" });
  });

  it("names a webhook routine and its source, never the payload", async () => {
    const prisma = fakePrisma({
      message: { blocks: text("Inbound webhook payload: secret stuff"), clientNonce: "github:b1:x" },
      routine: { name: "Inbox triage run" },
    });
    const trigger = await loadApprovalTrigger(
      prisma,
      { trigger: "webhook", sourceMessageId: "m1", routineId: "r1" },
      {},
    );
    expect(trigger).toEqual({ kind: "routine", routineName: "Inbox triage run", event: "github" });
    expect(JSON.stringify(trigger)).not.toContain("secret stuff");
  });

  it("quotes the asking bot", async () => {
    const prisma = fakePrisma({
      message: {
        blocks: [{ kind: "bot_message_received", fromBotId: "b2", fromBotName: "Jill", text: "Ship it" }],
      },
    });
    await expect(
      loadApprovalTrigger(prisma, { trigger: "bot_message", sourceMessageId: "m1" }, {}),
    ).resolves.toEqual({ kind: "bot_message", botName: "Jill", text: "Ship it" });
  });

  it("knows nothing for a webhook without routine or other triggers", async () => {
    const prisma = fakePrisma({ message: { blocks: text("payload") } });
    await expect(
      loadApprovalTrigger(prisma, { trigger: "webhook", sourceMessageId: "m1" }, {}),
    ).resolves.toBeUndefined();
    await expect(loadApprovalTrigger(prisma, { trigger: "spawn" }, {})).resolves.toBeUndefined();
    await expect(loadApprovalTrigger(prisma, { trigger: "user" }, {})).resolves.toBeUndefined();
  });
});
