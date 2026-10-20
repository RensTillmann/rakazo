import type { ComposerMention } from "./composer-mentions.js";

/** UTF-16 offsets, matching textarea selectionStart/selectionEnd. */
export type ComposerMentionOccurrence = {
  start: number;
  end: number;
  mention: ComposerMention;
};

export function composerMentionQuery(text: string, caret: number) {
  const match = /(?:^|\s)@([\p{L}\p{N}_-]*)$/u.exec(text.slice(0, caret));
  return match ? { start: caret - match[1]!.length - 1, query: match[1]! } : null;
}

/** Preserve identities only while the selected occurrence itself is untouched. */
export function editComposerOccurrences(
  previous: string,
  next: string,
  occurrences: readonly ComposerMentionOccurrence[],
): ComposerMentionOccurrence[] {
  let start = 0;
  while (start < previous.length && start < next.length && previous[start] === next[start]) start++;
  let oldEnd = previous.length;
  let newEnd = next.length;
  while (oldEnd > start && newEnd > start && previous[oldEnd - 1] === next[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  const delta = newEnd - oldEnd;
  return occurrences.flatMap((occurrence) => {
    let updated: ComposerMentionOccurrence;
    if (occurrence.end <= start) updated = occurrence;
    else if (occurrence.start >= oldEnd) {
      updated = { ...occurrence, start: occurrence.start + delta, end: occurrence.end + delta };
    } else return [];
    return next.slice(updated.start, updated.end) === `@${updated.mention.name}` ? [updated] : [];
  });
}

/** Picker completion replaces the query and selected range, not the end of the draft. */
export function insertComposerOccurrence(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  mention: ComposerMention,
  occurrences: readonly ComposerMentionOccurrence[],
) {
  const query = composerMentionQuery(text, selectionStart);
  if (!query) return null;
  const label = `@${mention.name}`;
  const suffix = text.slice(selectionEnd);
  const spacer = suffix.length === 0 || /^[\p{L}\p{N}_@]/u.test(suffix) ? " " : "";
  const inserted = label + spacer;
  const next = text.slice(0, query.start) + inserted + suffix;
  const delta = query.start + inserted.length - selectionEnd;
  const retained = occurrences.flatMap((occurrence) => {
    if (occurrence.end <= query.start) return [occurrence];
    if (occurrence.start >= selectionEnd) {
      return [{ ...occurrence, start: occurrence.start + delta, end: occurrence.end + delta }];
    }
    return [];
  });
  return {
    text: next,
    caret: query.start + inserted.length,
    occurrences: [
      ...retained,
      { start: query.start, end: query.start + label.length, mention },
    ].sort((a, b) => a.start - b.start),
  };
}

/** Repeated visible occurrences carry one routing identity, never duplicate wakes. */
export function composerOccurrenceMentions(occurrences: readonly ComposerMentionOccurrence[]) {
  const seen = new Set<string>();
  return occurrences.flatMap(({ mention }) => {
    const key = `${mention.kind}:${mention.id}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [mention];
  });
}
