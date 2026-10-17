import type { MessageBlock } from "@rakazo/contracts";

/** Per-browser "Show thoughts" toggle for mid-turn narration. Default off. */
export const SHOW_THOUGHTS_KEY = "rakazo.showThoughts";

const listeners = new Set<() => void>();

export function readShowThoughts(): boolean {
  try {
    return window.localStorage.getItem(SHOW_THOUGHTS_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeShowThoughts(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(SHOW_THOUGHTS_KEY, "1");
    else window.localStorage.removeItem(SHOW_THOUGHTS_KEY);
  } catch {
    // Private mode / blocked storage: the change still applies until reload.
  }
  for (const listener of listeners) listener();
}

export function subscribeShowThoughts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Drops narration text blocks when thoughts are hidden, and messages left with no
 * blocks. Messages without narration keep their identity so memoised rows stay stable.
 */
export function withThoughtsVisibility<T extends { blocks: MessageBlock[] }>(
  messages: T[],
  showThoughts: boolean,
): T[] {
  if (showThoughts) return messages;
  const visible: T[] = [];
  for (const message of messages) {
    if (!message.blocks.some((block) => block.kind === "text" && block.narration)) {
      visible.push(message);
      continue;
    }
    const blocks = message.blocks.filter((block) => !(block.kind === "text" && block.narration));
    if (blocks.length > 0) visible.push({ ...message, blocks });
  }
  return visible;
}
