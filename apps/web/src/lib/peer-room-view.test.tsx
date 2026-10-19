import { ChatMarkdown, MentionBotsContext } from "@rakazo/chat-ui/web";
import type { ThreadMessage } from "@rakazo/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { peerRoomView } from "./peer-messages.js";

const quinn = { id: "quinn", name: "Quinn" };

function message(role: ThreadMessage["role"], blocks: ThreadMessage["blocks"]): ThreadMessage {
  return { id: "m_1", threadId: "t_1", seq: 1, role, blocks, createdAt: "2026-10-19T10:00:00Z" };
}

describe("peer messages drawn as room messages in a bot's 1:1 chat", () => {
  it("shows an incoming message as the sender's room message, to this bot, with its intent", () => {
    const stored = message("user", [
      {
        kind: "bot_message_received",
        fromBotId: "lily",
        fromBotName: "Lily",
        text: "Draft is ready.",
        intent: "result",
      },
    ]);
    const view = peerRoomView(stored, quinn);

    expect(view?.message).toMatchObject({
      id: "m_1",
      role: "bot",
      botId: "lily",
      blocks: [{ kind: "text", text: "Draft is ready." }],
    });
    expect(view).toMatchObject({
      speakerName: "Lily",
      recipientName: "Quinn",
      intent: "result",
      peerBotId: "lily",
      peerBotName: "Lily",
    });
  });

  it("shows a sent message as this bot's own room message, to the recipient", () => {
    const stored = message("bot", [
      {
        kind: "bot_message_sent",
        toBotId: "lily",
        toBotName: "Lily",
        text: "Please check the copy.",
        intent: "request",
      },
    ]);
    const view = peerRoomView(stored, quinn);

    expect(view?.message).toMatchObject({ role: "bot", botId: "quinn" });
    expect(view).toMatchObject({ speakerName: "Quinn", recipientName: "Lily", intent: "request" });
  });

  it("keeps mentions coloured in the body through the chat Markdown renderer", () => {
    const view = peerRoomView(
      message("user", [
        { kind: "bot_message_received", fromBotId: "lily", fromBotName: "Lily", text: "@Quinn done" },
      ]),
      quinn,
    );
    const block = view?.message.blocks[0];
    const html = renderToStaticMarkup(
      <MentionBotsContext.Provider
        value={[{ id: "quinn", names: ["Quinn"], color: { onLight: "#5B21B6", onDark: "#A97EFE" } }]}
      >
        <ChatMarkdown>{block?.kind === "text" ? block.text : ""}</ChatMarkdown>
      </MentionBotsContext.Provider>,
    );

    expect(html).toContain('data-mention-bot="quinn"');
  });

  it("falls back to the compact row when the text is missing or the message is not a lone peer block", () => {
    expect(
      peerRoomView(
        message("user", [
          { kind: "bot_message_received", fromBotId: "lily", fromBotName: "Lily", text: "  " },
        ]),
        quinn,
      ),
    ).toBeUndefined();
    expect(peerRoomView(message("bot", [{ kind: "text", text: "hi" }]), quinn)).toBeUndefined();
  });

  it("does not change the stored message", () => {
    const stored = message("user", [
      { kind: "bot_message_received", fromBotId: "lily", fromBotName: "Lily", text: "Hi" },
    ]);
    const before = structuredClone(stored);
    peerRoomView(stored, quinn);
    expect(stored).toEqual(before);
  });
});
