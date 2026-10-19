/**
 * Fleet patch: a WhatsApp-style recency block at the very top of the roster.
 *
 * Every bot with any activity renders in one top block, newest activity first, and stays there:
 * a newer active bot simply goes above it. The activity time is the latest of the bot's newest
 * message (`lastMessageAt`, from the server, so the order survives reloads and devices) and any
 * change seen live (starts working, starts waiting for the user, a new unread reply), so a bot
 * that starts working jumps to the top before its first message lands. Bots without any
 * activity keep their pinned slot or folder. Rooms never move.
 */

const WORKING_STATUSES: Record<string, true> = { queued: true, leased: true, running: true };
const WAITING_STATUSES: Record<string, true> = { waiting_input: true, waiting_takeover: true };

export type RosterActivityBot = {
  id: string;
  status?: string | null;
  unread?: boolean;
  /** Row time; used only when the payload predates `lastMessageAt`. */
  updatedAt?: string | null;
  /** Newest message time, null for a chat without messages. */
  lastMessageAt?: string | null;
};

type TrackedActivity = {
  working: boolean;
  waiting: boolean;
  /** The message time of the newest unread reply, null when read. */
  unreadKey: string | null;
  /** Activity time in ms: newest of the server message time and live bumps. */
  at: number;
};

/** Bot id -> its tracked activity. Absent ids have no activity and keep their place. */
export type RosterActivityState = ReadonlyMap<string, TrackedActivity>;

export function rosterBotIsActive(bot: RosterActivityBot): boolean {
  const status = bot.status ?? "idle";
  return (
    WORKING_STATUSES[status] === true || WAITING_STATUSES[status] === true || bot.unread === true
  );
}

function parsedTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Advance the activity state from a fresh bot list. A bot's time only moves forward: to a newer
 * server message time, or to `now` when it starts working, starts waiting for an answer, or gets
 * a newer unread reply. A poll that returns the same times and states returns the same map
 * (same reference), so the order never flickers.
 *
 * `previous === null` is the first load: the order comes from the server message times.
 */
export function trackRosterActivity(
  previous: RosterActivityState | null,
  bots: readonly RosterActivityBot[],
  now: number = Date.now(),
): RosterActivityState {
  const next = new Map<string, TrackedActivity>();
  let changed = previous === null;
  for (const bot of bots) {
    const status = bot.status ?? "idle";
    const working = WORKING_STATUSES[status] === true;
    const waiting = WAITING_STATUSES[status] === true;
    const serverAt = parsedTime(
      bot.lastMessageAt === undefined ? bot.updatedAt : bot.lastMessageAt,
    );
    const unreadKey = bot.unread === true ? (bot.lastMessageAt ?? bot.updatedAt ?? "") : null;
    const before = previous?.get(bot.id);
    if (!before) {
      const live = working || waiting || unreadKey !== null;
      if (serverAt === null && !live) continue;
      // A bot that turns active mid-session jumps to the top now; on first load it takes
      // its message time so the order equals the order before the reload.
      const at = previous !== null && live ? Math.max(now, serverAt ?? now) : (serverAt ?? now);
      next.set(bot.id, { working, waiting, unreadKey, at });
      changed = true;
      continue;
    }
    const bumped =
      (working && !before.working) ||
      (waiting && !before.waiting) ||
      (unreadKey !== null && unreadKey !== before.unreadKey);
    const at = Math.max(before.at, serverAt ?? before.at, bumped ? now : before.at);
    if (
      at !== before.at ||
      working !== before.working ||
      waiting !== before.waiting ||
      unreadKey !== before.unreadKey
    ) {
      changed = true;
      next.set(bot.id, { working, waiting, unreadKey, at });
    } else {
      next.set(bot.id, before);
    }
  }
  if (!changed && previous && previous.size !== next.size) changed = true;
  return changed || !previous ? next : previous;
}

type RosterGroupLike<I> = { bots: readonly I[] };

/**
 * Pull bots with activity out of their pinned slot or folder into one top list, newest activity
 * first (ties keep roster order). A group emptied by this move is dropped unless `keepEmpty`
 * says the surface shows that group empty (e.g. a folder that stays a drop target). Everything
 * else, including rooms (items where `botId` returns null), keeps its exact place.
 */
export function orderRosterWithActiveFirst<I, G extends RosterGroupLike<I>>(
  groups: readonly G[],
  activity: RosterActivityState,
  botId: (item: I) => string | null,
  keepEmpty: (group: G) => boolean = () => false,
): { active: I[]; groups: G[] } {
  if (activity.size === 0) return { active: [], groups: [...groups] };
  const active: { item: I; at: number; index: number }[] = [];
  const rest: G[] = [];
  for (const group of groups) {
    const kept: I[] = [];
    for (const item of group.bots) {
      const id = botId(item);
      const tracked = id === null ? undefined : activity.get(id);
      if (tracked) active.push({ item, at: tracked.at, index: active.length });
      else kept.push(item);
    }
    if (kept.length === group.bots.length) rest.push(group);
    else if (kept.length > 0 || keepEmpty(group)) rest.push({ ...group, bots: kept });
  }
  active.sort((a, b) => b.at - a.at || a.index - b.index);
  return { active: active.map((entry) => entry.item), groups: rest };
}
