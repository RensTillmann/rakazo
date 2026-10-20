export const MODEL_SETTINGS_CHANGED_EVENT = "rakazo:model-settings-changed";

/** Only an opaque invalidation signal is shared with other windows, never model or account data. */
export function notifyModelSettingsChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(MODEL_SETTINGS_CHANGED_EVENT));
  try {
    window.localStorage.setItem(MODEL_SETTINGS_CHANGED_EVENT, `${Date.now()}:${Math.random()}`);
  } catch {
    // Same-window invalidation still works when browser storage is unavailable.
  }
}
