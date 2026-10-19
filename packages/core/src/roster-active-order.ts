/**
 * Fleet patch: active bots move to the very top of the roster.
 *
 * A bot is active while a run is in progress, it waits for the user's answer, or it has an
 * unread reply. Active bots render in one top block, newest activity first; when a bot is no
 * longer active it returns to its normal place. Rooms never move.
 */

const WORKING_STATUSES: Record<string, true> = { queued: true, leased: true, running: true };
const WAITING_STATUSES: Record<string, true> = { waiting_input: true, waiting_takeover: true };

export type RosterActivityBot = {
  id: string;
  status?: string | null;
  unread?: boolean;
  /** Time of the newest message; identifies which unread reply is the latest. */
  updatedAt?: string | null;
};

type TrackedActivity = {
  working: boolean;
  waiting: boolean;
  /** The `updatedAt` of the newest unread reply, null when read. */
  unreadKey: string | null;
  /** Activity time in ms: when it started working, asked, or its latest unread reply arrived. */
  at: number;
};

/** Active bot id -> its tracked activity. Absent ids are inactive. */
export type RosterActivityState = ReadonlyMap<string, TrackedActivity>;

export function rosterBotIsActive(bot: RosterActivityBot): boolean {
  const status = bot.status ?? "idle";
  return WORKING_STATUSES[status] === true || WAITING_STATUSES[status] === true || bot.unread === true;
}

function parsedTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Advance the activity state from a fresh bot list. The activity time only changes when a bot
 * starts working, starts waiting for an answer, or gets a newer unread reply, so a poll that
 * returns the same states returns the same map (same reference) and the order never flickers.
 *
 * `previous === null` is the first load: already-active bots take their newest message time.
 */
export function trackRosterActivity(
  previous: RosterActivityState | null,
  bots: readonly RosterActivityBot[],
  now: number = Date.now(),
): RosterActivityState {
  const next = new Map<string, TrackedActivity>();
  let changed = previous === null;
  for (const bot of bots) {
    if (!rosterBotIsActive(bot)) continue;
    const status = bot.status ?? "idle";
    const working = WORKING_STATUSES[status] === true;
    const waiting = WAITING_STATUSES[status] === true;
    const unreadKey = bot.unread === true ? (bot.updatedAt ?? "") : null;
    const before = previous?.get(bot.id);
    if (!before) {
      const at = previous === null ? (parsedTime(bot.updatedAt) ?? now) : now;
      next.set(bot.id, { working, waiting, unreadKey, at });
      changed = true;
      continue;
    }
    const bumped =
      (working && !before.working) ||
      (waiting && !before.waiting) ||
      (unreadKey !== null && unreadKey !== before.unreadKey);
    if (
      bumped ||
      working !== before.working ||
      waiting !== before.waiting ||
      unreadKey !== before.unreadKey
    ) {
      changed = true;
    }
    next.set(bot.id, { working, waiting, unreadKey, at: bumped ? now : before.at });
  }
  if (!changed && previous && previous.size !== next.size) changed = true;
  return changed || !previous ? next : previous;
}

type RosterGroupLike<I> = { bots: readonly I[] };

/**
 * Pull active bots out of their pinned slot or folder into one top list, newest activity first
 * (ties keep roster order). Groups emptied only by this move are dropped; everything else,
 * including rooms (items where `botId` returns null), keeps its exact place.
 */
export function orderRosterWithActiveFirst<I, G extends RosterGroupLike<I>>(
  groups: readonly G[],
  activity: RosterActivityState,
  botId: (item: I) => string | null,
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
    else if (kept.length > 0) rest.push({ ...group, bots: kept });
  }
  active.sort((a, b) => b.at - a.at || a.index - b.index);
  return { active: active.map((entry) => entry.item), groups: rest };
}
