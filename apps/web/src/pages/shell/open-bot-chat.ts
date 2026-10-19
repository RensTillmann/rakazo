/** Where the reader is: a bot's 1:1 chat, or a group thread. */
export type OpenChatLocation = { inGroup: boolean; botId: string | undefined };

/**
 * Opens a bot's 1:1 chat from a mention or a speaker header. Already in that
 * chat does nothing, so the thread does not reload. Returns whether it navigated.
 */
export function openBotChat(
  botId: string,
  current: OpenChatLocation,
  navigate: (path: string) => void,
): boolean {
  if (!current.inGroup && current.botId === botId) return false;
  navigate(`/app/${botId}`);
  return true;
}
