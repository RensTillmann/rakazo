const STORAGE_PREFIX = "rakazo:bots-sidebar-collapsed:";
const WIDTH_STORAGE_PREFIX = "rakazo:bots-sidebar-width:";

/** Desktop bots sidebar widths (px). */
export const BOTS_SIDEBAR_DEFAULT_WIDTH = 316;
export const BOTS_SIDEBAR_MIN_WIDTH = 220;
export const BOTS_SIDEBAR_MAX_WIDTH = 560;
/** Avatar-only rail: a 38px avatar plus the list and row padding. */
export const BOTS_SIDEBAR_RAIL_WIDTH = 76;
/** The chat and the right panel each keep at least this much room. */
const MIN_NEIGHBOUR_WIDTH = 320;
/** Pointer travel (px) under which a press on the edge is a click (show/hide), not a resize. */
export const BOTS_SIDEBAR_CLICK_SLOP_PX = 4;
/** Arrow-key resize step (px). */
const KEY_STEP_PX = 24;

export interface BotsSidebarLayout {
  collapsed: boolean;
  /** Visible width; while collapsed, the width it reopens at. */
  width: number;
}

export function botsSidebarCollapsedStorageKey(userId: string | null | undefined): string | null {
  if (!userId) return null;
  return `${STORAGE_PREFIX}${userId}`;
}

export function readBotsSidebarCollapsed(userId: string | null | undefined): boolean {
  const storageKey = botsSidebarCollapsedStorageKey(userId);
  if (!storageKey) return false;
  try {
    return window.localStorage.getItem(storageKey) === "1";
  } catch {
    return false;
  }
}

export function writeBotsSidebarCollapsed(
  userId: string | null | undefined,
  collapsed: boolean,
): void {
  const storageKey = botsSidebarCollapsedStorageKey(userId);
  if (!storageKey) return;
  try {
    if (collapsed) window.localStorage.setItem(storageKey, "1");
    else window.localStorage.removeItem(storageKey);
  } catch {
    // Ignore quota / private-mode failures; in-memory state still applies.
  }
}

export function readBotsSidebarWidth(userId: string | null | undefined): number {
  if (!userId) return BOTS_SIDEBAR_DEFAULT_WIDTH;
  try {
    const saved = Number(window.localStorage.getItem(`${WIDTH_STORAGE_PREFIX}${userId}`));
    if (saved === BOTS_SIDEBAR_RAIL_WIDTH) return saved;
    if (saved >= BOTS_SIDEBAR_MIN_WIDTH) return Math.min(BOTS_SIDEBAR_MAX_WIDTH, saved);
  } catch {
    // Storage may be disabled.
  }
  return BOTS_SIDEBAR_DEFAULT_WIDTH;
}

export function writeBotsSidebarWidth(userId: string | null | undefined, width: number): void {
  if (!userId) return;
  try {
    window.localStorage.setItem(`${WIDTH_STORAGE_PREFIX}${userId}`, String(width));
  } catch {
    // Ignore quota / private-mode failures; in-memory state still applies.
  }
}

/** Widest the sidebar may get in this viewport, leaving room for the chat and the right panel. */
export function botsSidebarMaxWidth(viewportWidth: number): number {
  return Math.max(
    BOTS_SIDEBAR_MIN_WIDTH,
    Math.min(BOTS_SIDEBAR_MAX_WIDTH, viewportWidth - 2 * MIN_NEIGHBOUR_WIDTH),
  );
}

/**
 * Where a drag of the sidebar edge lands. `requested` is the width under the pointer: free resizing
 * down to the minimum width, then a snap to the avatar rail, then hidden past half the rail.
 * Dragging back out reverses each step. `reopenWidth` is kept as the width to reopen at when hidden.
 */
export function botsSidebarLayoutForWidth(
  requested: number,
  maxWidth: number,
  reopenWidth: number,
): BotsSidebarLayout {
  if (requested < BOTS_SIDEBAR_RAIL_WIDTH / 2) return { collapsed: true, width: reopenWidth };
  if (requested < (BOTS_SIDEBAR_RAIL_WIDTH + BOTS_SIDEBAR_MIN_WIDTH) / 2) {
    return { collapsed: false, width: BOTS_SIDEBAR_RAIL_WIDTH };
  }
  const max = Math.max(BOTS_SIDEBAR_MIN_WIDTH, maxWidth);
  return {
    collapsed: false,
    width: Math.round(Math.min(max, Math.max(BOTS_SIDEBAR_MIN_WIDTH, requested))),
  };
}

/** One arrow-key step on the edge: the same stops as dragging (free widths, rail, hidden). */
export function nudgeBotsSidebar(
  layout: BotsSidebarLayout,
  grow: boolean,
  maxWidth: number,
): BotsSidebarLayout {
  if (layout.collapsed) return grow ? { collapsed: false, width: BOTS_SIDEBAR_RAIL_WIDTH } : layout;
  if (layout.width <= BOTS_SIDEBAR_RAIL_WIDTH) {
    return grow
      ? { collapsed: false, width: BOTS_SIDEBAR_MIN_WIDTH }
      : { collapsed: true, width: layout.width };
  }
  if (!grow && layout.width <= BOTS_SIDEBAR_MIN_WIDTH) {
    return { collapsed: false, width: BOTS_SIDEBAR_RAIL_WIDTH };
  }
  return botsSidebarLayoutForWidth(
    Math.max(BOTS_SIDEBAR_MIN_WIDTH, layout.width + (grow ? KEY_STEP_PX : -KEY_STEP_PX)),
    maxWidth,
    layout.width,
  );
}
