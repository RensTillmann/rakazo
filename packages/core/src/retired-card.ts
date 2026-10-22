/** The phrase every client shows on a retired card; the stored reason says why, after it. */
export const RETIRED_CARD_PHRASE = "No longer needed";

const LEADING_PHRASE = /^\s*no longer needed\s*[:·.-]?\s*/i;

/**
 * Why a card was retired, without the phrase clients already show before it. Cards stored before
 * the reason dropped the phrase began with "No longer needed: …"; that lead is not shown twice.
 * Empty when the reason is only the phrase or missing.
 */
export function retiredCardReason(reason: string | null | undefined): string {
  return (reason ?? "").replace(LEADING_PHRASE, "").trim();
}
