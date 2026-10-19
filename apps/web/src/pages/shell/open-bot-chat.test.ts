import { describe, expect, it, vi } from "vitest";
import { openBotChat } from "./open-bot-chat";

describe("openBotChat", () => {
  it("opens another bot's 1:1 chat", () => {
    const navigate = vi.fn();
    expect(openBotChat("quinn", { inGroup: false, botId: "robin" }, navigate)).toBe(true);
    expect(navigate).toHaveBeenCalledWith("/app/quinn");
  });

  it("opens the bot's 1:1 chat from a group thread", () => {
    const navigate = vi.fn();
    expect(openBotChat("quinn", { inGroup: true, botId: undefined }, navigate)).toBe(true);
    expect(navigate).toHaveBeenCalledWith("/app/quinn");
  });

  it("does nothing in that bot's own chat", () => {
    const navigate = vi.fn();
    expect(openBotChat("quinn", { inGroup: false, botId: "quinn" }, navigate)).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });
});
