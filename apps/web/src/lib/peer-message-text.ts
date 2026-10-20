/**
 * Display copy of a bot-to-bot message body without a leading "<recipient>," or "<recipient>:"
 * salutation, since the shown body starts with an @mention of the recipient instead. Exact
 * name, case-insensitive, only at the very start; keeps the original text when nothing would
 * remain.
 */
export function withoutRecipientSalutation(text: string, recipientName: string): string {
  const name = recipientName.trim();
  if (!name) return text;
  const lead = text.match(/^\s*/)?.[0] ?? "";
  const body = text.slice(lead.length);
  if (body.slice(0, name.length).toLowerCase() !== name.toLowerCase()) return text;
  const rest = body.slice(name.length).match(/^ *[,:] *([\s\S]*)$/);
  if (!rest) return text;
  const remaining = rest[1] ?? "";
  if (!remaining.trim()) return text;
  return lead + remaining.charAt(0).toUpperCase() + remaining.slice(1);
}

// Markdown that only works at the start of a line: a fence, heading, list item, quote or table.
const LINE_START_MARKDOWN = /^(?:```|~~~|#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\|)/;

/**
 * Display copy of a bot-to-bot message body that starts with "@<recipient> ", so it reads (and
 * renders) like a chat message mentioning the recipient. Kept as is when it already starts with
 * that mention; a body opening with line-level Markdown gets the mention on its own line.
 */
export function withRecipientMention(text: string, recipientName: string): string {
  const name = recipientName.trim();
  if (!name) return text;
  const body = text.trimStart();
  const mention = `@${name}`;
  const after = body.charAt(mention.length);
  if (
    body.slice(0, mention.length).toLowerCase() === mention.toLowerCase() &&
    !/[\p{L}\p{N}_]/u.test(after)
  ) {
    return text;
  }
  return LINE_START_MARKDOWN.test(body) ? `${mention}\n\n${body}` : `${mention} ${body}`;
}
