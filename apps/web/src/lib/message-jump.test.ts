import type { ThreadMessage } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { messageInPage, messageJumpLocation, QUESTION_JUMP_SOURCE } from "./message-jump";

function message(id: string, seq: number): ThreadMessage {
  return {
    id,
    seq,
    role: "bot",
    blocks: [{ kind: "text", text: `Message ${id}` }],
    createdAt: "2026-10-21T08:00:00.000Z",
  } as unknown as ThreadMessage;
}

describe("messageJumpLocation", () => {
  it("opens a bot's chat or a room at the message", () => {
    expect(messageJumpLocation({ botId: "josy", messageId: "m1" })).toEqual({
      pathname: "/app/josy",
      search: "?m=m1",
    });
    expect(
      messageJumpLocation({ groupId: "room-1", messageId: "m1" }, QUESTION_JUMP_SOURCE),
    ).toEqual({ pathname: "/app/g/room-1", search: "?m=m1&src=question" });
  });

  it("keeps a search hit's routine and drops an empty query", () => {
    expect(messageJumpLocation({ botId: "josy", routineId: "r1" })).toEqual({
      pathname: "/app/josy",
      search: "?routine=r1",
    });
    expect(messageJumpLocation({ botId: "josy" })).toEqual({
      pathname: "/app/josy",
      search: undefined,
    });
  });
});

describe("messageInPage", () => {
  it("finds the card in the page fetched around it", () => {
    expect(messageInPage([message("a", 1), message("card", 2)], "card")).toBe(true);
  });

  it("reports a card the page does not hold, so the shell can show its note", () => {
    expect(messageInPage([message("a", 1), message("b", 2)], "card")).toBe(false);
    expect(messageInPage([], "card")).toBe(false);
  });
});
