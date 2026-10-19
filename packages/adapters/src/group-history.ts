import type { PrismaClient } from "@rakazo/db";

/** Who wrote what in a group thread: the owner's name and every bot's name by id. */
export type GroupAuthorNames = { userName: string; botNames: ReadonlyMap<string, string> };

/** Bot ids a message names: its author and both ends of any handoff block. */
export function groupMessageBotIds(
  messages: ReadonlyArray<{ botId?: string | null; blocks: unknown }>,
) {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.botId) ids.add(message.botId);
    if (!Array.isArray(message.blocks)) continue;
    for (const block of message.blocks) {
      if (block && typeof block === "object" && "kind" in block && block.kind === "handoff") {
        if ("fromBotId" in block && typeof block.fromBotId === "string") ids.add(block.fromBotId);
        if ("toBotId" in block && typeof block.toBotId === "string") ids.add(block.toBotId);
      }
    }
  }
  return [...ids];
}

export async function loadGroupAuthorNames(
  prisma: Pick<PrismaClient, "bot" | "user">,
  input: { userId: string; botIds: string[] },
): Promise<GroupAuthorNames> {
  const [user, bots] = await Promise.all([
    prisma.user.findUnique({ where: { id: input.userId }, select: { name: true } }),
    input.botIds.length
      ? prisma.bot.findMany({
          where: { id: { in: input.botIds } },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
  ]);
  return {
    userName: user?.name?.trim() || "User",
    botNames: new Map(bots.map((bot) => [bot.id, bot.name])),
  };
}

/**
 * One group-history turn as the running bot sees it. Only its own messages stay
 * `assistant`; another bot's message is a `user` turn prefixed `[Name] ` and the owner's is
 * prefixed with the owner's name, so a bot never mistakes a teammate's words for its own.
 */
export function groupHistoryTurn(
  message: { role: string; botId?: string | null },
  content: string,
  selfBotId: string,
  names: GroupAuthorNames,
): { role: "user" | "assistant" | "system"; content: string } {
  if (message.role === "system") return { role: "system", content };
  if (message.role === "user") return { role: "user", content: `[${names.userName}] ${content}` };
  if (message.botId === selfBotId) return { role: "assistant", content };
  const name = (message.botId && names.botNames.get(message.botId)) || "Another bot";
  return { role: "user", content: `[${name}] ${content}` };
}
