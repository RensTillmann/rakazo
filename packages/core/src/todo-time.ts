/** "about 5 minutes", "about 1 hour", "about 2 hrs" in a to-do's why or steps. */
const ABOUT_TIME = /\babout\s+(\d{1,4})\s*(minutes?|mins?|hours?|hrs?)\b/i;

/**
 * How long a card's to-dos take, in minutes, from the "about N minutes/hours" the bot wrote in
 * each item's why or steps. Null unless every item says it: a partial sum would understate it.
 */
export function todoTimeEstimateMinutes(
  items: ReadonlyArray<{ why?: string | null; steps: string }>,
): number | null {
  let total = 0;
  for (const item of items) {
    const match = ABOUT_TIME.exec(`${item.why ?? ""}\n${item.steps}`);
    if (!match) return null;
    total += Number(match[1]) * (match[2]!.toLowerCase().startsWith("h") ? 60 : 1);
  }
  return items.length ? total : null;
}
