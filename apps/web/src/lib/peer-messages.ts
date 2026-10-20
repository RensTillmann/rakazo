import type { MessageBlock, ThreadMessage } from "@rakazo/contracts";
import { isPeerReceiptBlocks, messageReaction } from "@rakazo/core";
import { withoutRecipientSalutation, withRecipientMention } from "./peer-message-text";

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
  peerBotId: string;
  peerBotName: string;
}

/**
 * A bot-to-bot message in `threadBot`'s 1:1 chat, recast as the speaker's room message so the
 * reader sees the exchange inline; the body starts with an @mention of the recipient. Display
 * only; undefined (keep the compact row) without text.
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
  const text = withRecipientMention(
    withoutRecipientSalutation(block.text, recipientName),
    recipientName,
  );
  return {
    message: {
      ...message,
      role: "bot",
      botId: sent ? threadBot.id : peerBotId,
      blocks: [{ kind: "text", text }],
    },
    speakerName: sent ? threadBot.name : peerBotName,
    peerBotId,
    peerBotName,
  };
}

/**
 * The bot that never gets a peer run's own reply, for a "Not sent" line on it in the replying
 * bot's 1:1 chat. `marker` is the bot message that woke the run (the reply folds under it).
 * A request or question gets the run's final reply back as a bot message of its own (its
 * auto-outcome, already drawn with an @mention), so only other intents (fyi, result, status)
 * leave the reply unsent. Undefined unless `reply` is the run's last text reply in `transcript`,
 * and when a person took part in the run before it (a message of theirs or an ask card), since
 * it may then answer them. Display only; stored messages are unchanged.
 */
export function unsentPeerReplyTo(
  reply: ThreadMessage,
  marker: ThreadMessage,
  transcript: readonly ThreadMessage[],
): string | undefined {
  const woke = marker.blocks.length === 1 ? marker.blocks[0] : undefined;
  if (woke?.kind !== "bot_message_received") return undefined;
  // Same default as the server's `returnBotMessageOutcome`: no intent counts as a request.
  const intent = woke.intent ?? "request";
  if (intent === "request" || intent === "question") return undefined;
  if (reply.role !== "bot" || !reply.runId || reply.runId !== marker.runId) return undefined;
  for (const message of transcript) {
    if (message.runId !== reply.runId || message.id === reply.id) continue;
    const personInput =
      (message.role === "user" &&
        !message.inbound &&
        !isPeerReceiptBlocks(message.blocks) &&
        !messageReaction(message)) ||
      message.blocks.some((block) => block.kind === "ask");
    if (message.seq < reply.seq && personInput) return undefined;
    // One line per run, on its last text reply.
    if (
      message.seq > reply.seq &&
      message.role === "bot" &&
      message.blocks.some((block) => block.kind === "text" && block.text.trim())
    ) {
      return undefined;
    }
  }
  return reply.blocks.some((block) => block.kind === "text" && block.text.trim())
    ? woke.fromBotName
    : undefined;
}
