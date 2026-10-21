/**
 * Fleet: who coordinates work. Read once from settings at startup and passed to whoever needs it,
 * so to-do checks and recovery items name the same bot by the same rules.
 */
export interface CaseCoordination {
  /** `RAKAZO_CASE_COORDINATOR_BOTS`: bot names or ids that coordinate cases; the first is the default. */
  caseCoordinators: readonly string[];
  /** `RAKAZO_FLEET_COORDINATOR_BOT`, else `RAKAZO_FLAG_BOT`: accountable for work with no case. */
  fleetCoordinator: string | null;
}

export const NO_CASE_COORDINATION: CaseCoordination = {
  caseCoordinators: [],
  fleetCoordinator: null,
};

export function caseCoordinationFromEnv(env: Record<string, string | undefined>): CaseCoordination {
  return {
    caseCoordinators: (env.RAKAZO_CASE_COORDINATOR_BOTS ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
    fleetCoordinator:
      env.RAKAZO_FLEET_COORDINATOR_BOT?.trim() || env.RAKAZO_FLAG_BOT?.trim() || null,
  };
}

/** The bot a setting names: by id, else by name ignoring case. */
function namedBot<B extends { id: string; name: string }>(
  bots: readonly B[],
  wanted: string,
): B | undefined {
  return (
    bots.find((bot) => bot.id === wanted) ??
    bots.find((bot) => bot.name.toLowerCase() === wanted.toLowerCase())
  );
}

/**
 * Who answers for work on a case that `askerId` asked about: the asker when it coordinates cases
 * itself (only Josy, and Elena for fleet cases, ask Rens), else the default case coordinator.
 * Null when no configured coordinator is among `bots`.
 */
export function caseCoordinatorOf<B extends { id: string; name: string }>(
  bots: readonly B[],
  coordination: CaseCoordination,
  askerId: string | null,
): B | null {
  const coordinators = coordination.caseCoordinators.flatMap((wanted) => {
    const bot = namedBot(bots, wanted);
    return bot ? [bot] : [];
  });
  return coordinators.find((bot) => bot.id === askerId) ?? coordinators[0] ?? null;
}

/** Who answers for work with no case; null when unset or not among `bots`. */
export function fleetCoordinatorOf<B extends { id: string; name: string }>(
  bots: readonly B[],
  coordination: CaseCoordination,
): B | null {
  return coordination.fleetCoordinator
    ? (namedBot(bots, coordination.fleetCoordinator) ?? null)
    : null;
}
