// Fleet patch: whether a routine run's own output shows in full in a bot's chat. Off by default,
// so the owner sees one folded "Routine log" row instead of text that was never meant for him.

export const ROUTINE_OUTPUT_STORAGE_KEY = "rakazo.showRoutineOutput";

const listeners = new Set<() => void>();
let memoryPreference: boolean | null = null;

function getLocalStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

/** Only a saved "on" shows routine output in full; missing or unreadable storage keeps it folded. */
export function resolveRoutineOutputShown(
  storage: Pick<Storage, "getItem"> | null = getLocalStorage(),
): boolean {
  try {
    return storage?.getItem(ROUTINE_OUTPUT_STORAGE_KEY)?.trim().toLowerCase() === "on";
  } catch {
    return false;
  }
}

export function getRoutineOutputShown(): boolean {
  return memoryPreference ?? resolveRoutineOutputShown();
}

export function setRoutineOutputShown(shown: boolean): void {
  memoryPreference = shown;
  try {
    getLocalStorage()?.setItem(ROUTINE_OUTPUT_STORAGE_KEY, shown ? "on" : "off");
  } catch {
    // Ignore quota / private-mode failures; the in-memory preference still applies.
  }
  for (const listener of listeners) listener();
}

export function subscribeRoutineOutput(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
