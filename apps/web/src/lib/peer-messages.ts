import type { MessageBlock, ThreadMessage } from "@rakazo/contracts";
import { withoutRecipientSalutation } from "./peer-message-text";

export interface PeerMessage {
  messageId: string;
  direction: "sent" | "received";
  peerBotId: string;
  peerBotName: string;
  text: string;
  createdAt: string;
}

export interface PeerConversation {
  peerBotId: string;
  peerBotName: string;
  messages: PeerMessage[];
  lastText: string;
  lastAt: string;
}

type PeerBlock = Extract<MessageBlock, { kind: "bot_message_sent" | "bot_message_received" }>;

export function isPeerBlock(block: MessageBlock): block is PeerBlock {
  return block.kind === "bot_message_sent" || block.kind === "bot_message_received";
}

export function peerMessagesFrom(messages: readonly ThreadMessage[]): PeerMessage[] {
  const collected: PeerMessage[] = [];
  for (const message of messages) {
    for (const block of message.blocks) {
      if (!isPeerBlock(block)) continue;
      collected.push(
        block.kind === "bot_message_sent"
          ? {
              messageId: message.id,
              direction: "sent",
              peerBotId: block.toBotId,
              peerBotName: block.toBotName,
              text: block.text,
              createdAt: message.createdAt,
            }
          : {
              messageId: message.id,
              direction: "received",
              peerBotId: block.fromBotId,
              peerBotName: block.fromBotName,
              text: block.text,
              createdAt: message.createdAt,
            },
      );
    }
  }
  return collected;
}

/** One conversation per peer, most recently active first. */
export function peerConversations(messages: readonly ThreadMessage[]): PeerConversation[] {
  const byPeer = new Map<string, PeerConversation>();
  for (const peerMessage of peerMessagesFrom(messages)) {
    const existing = byPeer.get(peerMessage.peerBotId);
    if (existing) {
      existing.messages.push(peerMessage);
      // Names can change; the newest one wins.
      existing.peerBotName = peerMessage.peerBotName;
      existing.lastText = peerMessage.text;
      existing.lastAt = peerMessage.createdAt;
      continue;
    }
    byPeer.set(peerMessage.peerBotId, {
      peerBotId: peerMessage.peerBotId,
      peerBotName: peerMessage.peerBotName,
      messages: [peerMessage],
      lastText: peerMessage.text,
      lastAt: peerMessage.createdAt,
    });
  }
  return [...byPeer.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

export interface PeerRoomView {
  /** Display copy of the stored message, shaped like the speaker's message in a room. */
  message: ThreadMessage;
  speakerName: string;
  recipientName: string;
  intent?: PeerBlock["intent"];
  peerBotId: string;
  peerBotName: string;
}

/**
 * A bot-to-bot message in `threadBot`'s 1:1 chat, recast as the speaker's room message so the
 * reader sees the exchange inline. Display only; undefined (keep the compact row) without text.
 */
export function peerRoomView(
  message: ThreadMessage,
  threadBot: { id: string; name: string },
): PeerRoomView | undefined {
  if (message.blocks.length !== 1) return undefined;
  const block = message.blocks[0];
  if (!block || !isPeerBlock(block) || !block.text.trim()) return undefined;
  const sent = block.kind === "bot_message_sent";
  const peerBotId = sent ? block.toBotId : block.fromBotId;
  const peerBotName = sent ? block.toBotName : block.fromBotName;
  const recipientName = sent ? peerBotName : threadBot.name;
  return {
    message: {
      ...message,
      role: "bot",
      botId: sent ? threadBot.id : peerBotId,
      blocks: [{ kind: "text", text: withoutRecipientSalutation(block.text, recipientName) }],
    },
    speakerName: sent ? threadBot.name : peerBotName,
    recipientName,
    intent: block.intent,
    peerBotId,
    peerBotName,
  };
}
