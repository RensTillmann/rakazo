import type { ComposerMentionOccurrence } from "@rakazo/core";

/** Per-thread composer draft persistence (survives tab reloads and discards). */

export const COMPOSER_DRAFT_STORAGE_PREFIX = "rakazo.composerDraft.";

type ComposerDraftSubmission = { text: string };
const pendingSubmissions = new Map<string, ComposerDraftSubmission>();
const acceptedListeners = new Map<string, Set<(text: string) => void>>();

export function beginComposerDraftSubmission(
  threadKey: string,
  text: string,
  occurrences: readonly ComposerMentionOccurrence[] = [],
): ComposerDraftSubmission {
  writeComposerDraftState(threadKey, text, occurrences);
  const submission = { text };
  pendingSubmissions.set(threadKey, submission);
  return submission;
}

export function settleComposerDraftSubmission(
  threadKey: string,
  submission: ComposerDraftSubmission,
  accepted: boolean,
): void {
  if (pendingSubmissions.get(threadKey) !== submission) return;
  pendingSubmissions.delete(threadKey);
  if (!accepted || readComposerDraft(threadKey) !== submission.text) return;
  writeComposerDraft(threadKey, "");
  for (const listener of acceptedListeners.get(threadKey) ?? []) listener(submission.text);
}

export function subscribeComposerDraftAccepted(
  threadKey: string,
  listener: (text: string) => void,
): () => void {
  let listeners = acceptedListeners.get(threadKey);
  if (!listeners) {
    listeners = new Set();
    acceptedListeners.set(threadKey, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) acceptedListeners.delete(threadKey);
  };
}

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function getLocalStorage(): DraftStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function composerDraftStorageKey(threadKey: string): string {
  return `${COMPOSER_DRAFT_STORAGE_PREFIX}${threadKey}`;
}

export function readComposerDraft(
  threadKey: string,
  storage: DraftStorage | null = getLocalStorage(),
): string {
  if (!storage || !threadKey) return "";
  try {
    return storage.getItem(composerDraftStorageKey(threadKey)) ?? "";
  } catch {
    return "";
  }
}

export function writeComposerDraft(
  threadKey: string,
  draft: string,
  storage: DraftStorage | null = getLocalStorage(),
): void {
  pendingSubmissions.delete(threadKey);
  if (!storage || !threadKey) return;
  try {
    storage.removeItem(`${composerDraftStorageKey(threadKey)}.mentions`);
    if (draft.length === 0) storage.removeItem(composerDraftStorageKey(threadKey));
    else storage.setItem(composerDraftStorageKey(threadKey), draft);
  } catch {
    // Quota or private-mode failures: the draft still lives in memory.
  }
}

/** Sidecar is text-bound: old plain drafts remain readable; stale identities never attach. */
export function readComposerDraftOccurrences(
  threadKey: string,
  storage: DraftStorage | null = getLocalStorage(),
): ComposerMentionOccurrence[] {
  if (!storage || !threadKey) return [];
  try {
    const saved = JSON.parse(
      storage.getItem(`${composerDraftStorageKey(threadKey)}.mentions`) ?? "null",
    );
    const text = readComposerDraft(threadKey, storage);
    if (!saved || saved.text !== text || !Array.isArray(saved.occurrences)) return [];
    let previousEnd = 0;
    const result: ComposerMentionOccurrence[] = [];
    for (const entry of saved.occurrences) {
      if (
        !entry ||
        !Number.isInteger(entry.start) ||
        !Number.isInteger(entry.end) ||
        entry.start < previousEnd ||
        entry.end <= entry.start ||
        entry.end > text.length ||
        !entry.mention ||
        !["bot", "everyone"].includes(entry.mention.kind) ||
        typeof entry.mention.id !== "string" ||
        !entry.mention.id ||
        typeof entry.mention.name !== "string" ||
        !entry.mention.name ||
        text.slice(entry.start, entry.end) !== `@${entry.mention.name}`
      )
        return [];
      result.push({
        start: entry.start,
        end: entry.end,
        mention: {
          kind: entry.mention.kind,
          id: entry.mention.id,
          name: entry.mention.name,
        },
      });
      previousEnd = entry.end;
    }
    return result;
  } catch {
    return [];
  }
}

export function writeComposerDraftState(
  threadKey: string,
  text: string,
  occurrences: readonly ComposerMentionOccurrence[],
  storage: DraftStorage | null = getLocalStorage(),
): void {
  writeComposerDraft(threadKey, text, storage);
  if (!storage || !threadKey || !text || !occurrences.length) return;
  try {
    storage.setItem(
      `${composerDraftStorageKey(threadKey)}.mentions`,
      JSON.stringify({ text, occurrences }),
    );
  } catch {
    // A missing sidecar loses routing metadata, never the plain draft.
  }
}
