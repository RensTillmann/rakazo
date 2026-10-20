/**
 * Display copy of a bot-to-bot message body without a leading "<recipient>," or "<recipient>:"
 * salutation, since the route line already names the recipient. Exact name, case-insensitive,
 * only at the very start; keeps the original text when nothing would remain.
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
