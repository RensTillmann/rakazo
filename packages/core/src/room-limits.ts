function positiveIntegerEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 ? value : undefined;
}

/**
 * `RAKAZO_ROOM_MAX_RUNS_PER_DAY`: runs one group thread may start in 24 hours before the
 * room pauses bot-started work. Unset or invalid means no limit.
 */
export function roomMaxRunsPerDay(): number | undefined {
  return positiveIntegerEnv("RAKAZO_ROOM_MAX_RUNS_PER_DAY");
}

/** `RAKAZO_ROOM_MAX_WAKES`: bots one group message may wake. Unset or invalid means no limit. */
export function roomMaxWakes(): number | undefined {
  return positiveIntegerEnv("RAKAZO_ROOM_MAX_WAKES");
}

/** Keeps the first `RAKAZO_ROOM_MAX_WAKES` targets, in the order they were resolved. */
export function capRoomWakes(botIds: string[]): string[] {
  const max = roomMaxWakes();
  return max === undefined ? botIds : botIds.slice(0, max);
}
