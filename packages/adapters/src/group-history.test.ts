import { blocksToAgentHistoryText } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import {
  directHistoryTurn,
  groupHistoryTurn,
  groupMessageBotIds,
  isPersonMessage,
  loadGroupAuthorNames,
} from "./group-history.js";

const names = {
  userName: "Rens",
  botNames: new Map([
    ["josy", "Josy"],
    ["riona", "Riona"],
  ]),
};

describe("group history authors", () => {
  it("keeps only the bot's own messages as assistant turns", () => {
    expect(groupHistoryTurn({ role: "bot", botId: "josy" }, "Plan ready", "josy", names)).toEqual({
      role: "assistant",
      content: "Plan ready",
    });
    expect(groupHistoryTurn({ role: "bot", botId: "riona" }, "Draft sent", "josy", names)).toEqual({
      role: "user",
      content: "[Riona] Draft sent",
    });
    expect(groupHistoryTurn({ role: "user", botId: null }, "Go ahead", "josy", names)).toEqual({
      role: "user",
      content: "[Rens] Go ahead",
    });
    expect(groupHistoryTurn({ role: "system" }, "Cleared", "josy", names)).toEqual({
      role: "system",
      content: "Cleared",
    });
  });

  it("names handoff ends and collects every bot a window mentions", async () => {
    const blocks = [
      {
        kind: "handoff" as const,
        fromBotId: "josy",
        toBotId: "riona",
        text: "Take the refund",
        hop: 1,
      },
    ];
    expect(blocksToAgentHistoryText(blocks, names.botNames)).toBe(
      "[handoff Josy -> Riona] Take the refund",
    );
    expect(groupMessageBotIds([{ botId: "maya", blocks }])).toEqual(["maya", "josy", "riona"]);

    const prisma = {
      user: { findUnique: vi.fn(async () => ({ name: "Rens" })) },
      bot: { findMany: vi.fn(async () => [{ id: "josy", name: "Josy" }]) },
    };
    const loaded = await loadGroupAuthorNames(prisma as never, { userId: "u", botIds: ["josy"] });
    expect(loaded.userName).toBe("Rens");
    expect(loaded.botNames.get("josy")).toBe("Josy");
  });
});

describe("1:1 history authors", () => {
  const text = (value: string) => [{ kind: "text", text: value }];

  it("marks a person's own message like a teammate's", () => {
    expect(directHistoryTurn({ role: "user", blocks: text("x") }, "Mail is client mail")).toEqual({
      role: "user",
      content: "[from the user] Mail is client mail",
    });
    // A voice call or an app send keeps the person's mark.
    expect(isPersonMessage({ role: "user", clientNonce: "call:c1:1", blocks: text("Hello") })).toBe(
      true,
    );
    expect(directHistoryTurn({ role: "bot", blocks: text("Noted") }, "Noted")).toEqual({
      role: "assistant",
      content: "Noted",
    });
    expect(directHistoryTurn({ role: "system", blocks: [] }, "Cleared")).toEqual({
      role: "system",
      content: "Cleared",
    });
  });

  it("leaves another bot's message and an integration's wake unmarked", () => {
    const peer = {
      role: "user",
      clientNonce: "bot-message:m1",
      blocks: [{ kind: "bot_message_received", fromBotName: "Isabella", text: "case 173" }],
    };
    expect(directHistoryTurn(peer, "[from Isabella] case 173")).toEqual({
      role: "user",
      content: "[from Isabella] case 173",
    });
    for (const clientNonce of ["webhook:bot-1:d1", "github:bot-1:d2", "messaging:bot-1:d3"]) {
      expect(isPersonMessage({ role: "user", clientNonce, blocks: text("Run routine") })).toBe(
        false,
      );
    }
    expect(
      isPersonMessage({ role: "user", blocks: [{ kind: "channel_message", text: "hi" }] }),
    ).toBe(false);
  });
});
