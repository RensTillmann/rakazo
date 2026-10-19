import { isApprovalAskBlock, isSecretAskBlock } from "./action-approval.js";

type AskSnapshot = {
  messages: readonly {
    id: string;
    runId?: string | null;
    blocks: readonly { kind: string; status?: string }[];
  }[];
  run?: { id: string; status: string } | null;
  activeRuns?: readonly { id: string; status: string }[];
};

/** Every pending ask whose run is paused in `waiting_input`. Cards do not block the bot, so
 * several can wait at once and each one is answerable on its own. */
export function answerableAskMessageIds(snapshot: AskSnapshot | null): Set<string> {
  const ids = new Set<string>();
  if (!snapshot) return ids;
  const waitingRunIds = new Set(
    (snapshot.activeRuns ?? (snapshot.run ? [snapshot.run] : []))
      .filter((run) => run.status === "waiting_input")
      .map((run) => run.id),
  );
  for (const message of snapshot.messages) {
    if (!message?.runId || !waitingRunIds.has(message.runId)) continue;
    if (message.blocks.some((block) => block.kind === "ask" && block.status !== "answered")) {
      ids.add(message.id);
    }
  }
  return ids;
}

/** Newest answerable ask (mobile composer guard). */
export function latestAnswerableAskMessageId(snapshot: AskSnapshot | null): string | null {
  let latest: string | null = null;
  for (const id of answerableAskMessageIds(snapshot)) latest = id;
  return latest;
}

export type OpenAskSummary = {
  messageId: string;
  botId?: string;
  /** The card's question, on one line and cut to about 100 characters. */
  question: string;
  /** Fleet: true when composer text is taken as this card's answer (question cards); approval
   * and secret cards ignore composer text and must be answered on the card. */
  answersWithText: boolean;
};

const OPEN_ASK_QUESTION_MAX = 100;

/** Fleet: summary of the pending ask card that composer text would land on, for the composer guard. */
export function summarizeOpenAsk(
  message:
    | {
        id: string;
        botId?: string | null;
        blocks: readonly {
          kind: string;
          text?: string;
          status?: string;
          input?: string;
          approvalEffectId?: string;
          actions?: Array<{ id: string; label: string }>;
        }[];
      }
    | null
    | undefined,
): OpenAskSummary | null {
  const block = message?.blocks.find((item) => item.kind === "ask" && item.status !== "answered");
  if (!message || !block) return null;
  const flat = (block.text ?? "").replace(/\s+/g, " ").trim();
  const question =
    flat.length > OPEN_ASK_QUESTION_MAX
      ? `${flat.slice(0, OPEN_ASK_QUESTION_MAX - 1).trimEnd()}…`
      : flat;
  return {
    messageId: message.id,
    ...(message.botId ? { botId: message.botId } : {}),
    question,
    answersWithText: !isApprovalAskBlock(block) && !isSecretAskBlock(block),
  };
}

export function selectedAskActionLabel(
  answer: string,
  actions?: readonly { id: string; label: string }[],
): string {
  return resolveAskChoice(answer, actions)?.label ?? answer;
}

export function resolveAskChoice(
  answer: string,
  actions?: readonly { id: string; label: string }[],
): { id: string; label: string } | undefined {
  if (!actions?.length) return undefined;
  const trimmed = answer.trim();
  if (!trimmed) return undefined;
  const byId = actions.find((action) => action.id === trimmed);
  if (byId) return byId;
  const lower = trimmed.toLowerCase();
  return actions.find((action) => action.label.trim().toLowerCase() === lower);
}
