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
  it("shows an incoming message as the sender's room message, mentioning this bot", () => {
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
      blocks: [{ kind: "text", text: "@Quinn Draft is ready." }],
    });
    expect(view).toMatchObject({ speakerName: "Lily", peerBotId: "lily", peerBotName: "Lily" });
  });

  it("shows a sent message as this bot's own room message, mentioning the recipient", () => {
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

    expect(view?.message).toMatchObject({
      role: "bot",
      botId: "quinn",
      blocks: [{ kind: "text", text: "@Lily Please check the copy." }],
    });
    expect(view).toMatchObject({ speakerName: "Quinn", peerBotId: "lily" });
  });

  it("keeps mentions coloured in the body through the chat Markdown renderer", () => {
    const view = peerRoomView(
      message("user", [
        {
          kind: "bot_message_received",
          fromBotId: "lily",
          fromBotName: "Lily",
          text: "@Quinn done",
        },
      ]),
      quinn,
    );
    const block = view?.message.blocks[0];
    const html = renderToStaticMarkup(
      <MentionBotsContext.Provider
        value={[
          { id: "quinn", names: ["Quinn"], color: { onLight: "#5B21B6", onDark: "#A97EFE" } },
        ]}
      >
        <ChatMarkdown>{block?.kind === "text" ? block.text : ""}</ChatMarkdown>
      </MentionBotsContext.Provider>,
    );

    expect(html).toContain('data-mention-bot="quinn"');
  });

  it("renders the recipient as a mention chip in both chats, once, like a typed @mention", () => {
    const color = { onLight: "#5B21B6", onDark: "#A97EFE" };
    const bots = [
      { id: "quinn", names: ["Quinn"], color },
      { id: "josy", names: ["Josy"], color },
    ];
    const sentToJosy = peerRoomView(
      message("bot", [
        {
          kind: "bot_message_sent",
          toBotId: "josy",
          toBotName: "Josy",
          text: "fyi: #282 is done",
        },
      ]),
      quinn,
    )?.message.blocks[0];
    const alreadyMentioned = peerRoomView(
      message("user", [
        {
          kind: "bot_message_received",
          fromBotId: "josy",
          fromBotName: "Josy",
          text: "@Quinn ok",
        },
      ]),
      quinn,
    )?.message.blocks[0];
    const render = (block: typeof sentToJosy) =>
      renderToStaticMarkup(
        <MentionBotsContext.Provider value={bots}>
          <ChatMarkdown>{block?.kind === "text" ? block.text : ""}</ChatMarkdown>
        </MentionBotsContext.Provider>,
      );

    expect(sentToJosy).toEqual({ kind: "text", text: "@Josy fyi: #282 is done" });
    expect(render(sentToJosy)).toMatch(
      /<span class="rk-mention" data-mention-bot="josy"[^>]*>@Josy<\/span>/,
    );
    expect(alreadyMentioned).toEqual({ kind: "text", text: "@Quinn ok" });
    expect(render(alreadyMentioned).match(/data-mention-bot="quinn"/g)).toHaveLength(1);
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

  it("drops a leading recipient salutation before the mention in both chats, stored text unchanged", () => {
    const received = message("user", [
      {
        kind: "bot_message_received",
        fromBotId: "lily",
        fromBotName: "Lily",
        text: "quinn: QA #285 ready",
      },
    ]);
    const sent = message("bot", [
      { kind: "bot_message_sent", toBotId: "lily", toBotName: "Lily", text: "Lily, hold the docs" },
    ]);
    const before = structuredClone(sent);
    const receivedBlock = peerRoomView(received, quinn)?.message.blocks[0];
    const sentBlock = peerRoomView(sent, quinn)?.message.blocks[0];
    const html = renderToStaticMarkup(
      <ChatMarkdown>{sentBlock?.kind === "text" ? sentBlock.text : ""}</ChatMarkdown>,
    );

    expect(receivedBlock).toEqual({ kind: "text", text: "@Quinn QA #285 ready" });
    expect(html).toContain("@Lily Hold the docs");
    expect(html).not.toContain("Lily,");
    expect(sent).toEqual(before);
  });
});
