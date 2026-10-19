import { blocksToAgentHistoryText } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import { groupHistoryTurn, groupMessageBotIds, loadGroupAuthorNames } from "./group-history.js";

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
