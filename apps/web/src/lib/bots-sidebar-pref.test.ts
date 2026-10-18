import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BOTS_SIDEBAR_DEFAULT_WIDTH,
  BOTS_SIDEBAR_MAX_WIDTH,
  BOTS_SIDEBAR_MIN_WIDTH,
  BOTS_SIDEBAR_RAIL_WIDTH,
  botsSidebarCollapsedStorageKey,
  botsSidebarLayoutForWidth,
  botsSidebarMaxWidth,
  nudgeBotsSidebar,
  readBotsSidebarCollapsed,
  readBotsSidebarWidth,
  writeBotsSidebarCollapsed,
  writeBotsSidebarWidth,
} from "./bots-sidebar-pref";

function stubStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    },
  });
  return store;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bots sidebar collapse preference", () => {
  it("builds a per-user storage key", () => {
    expect(botsSidebarCollapsedStorageKey(null)).toBeNull();
    expect(botsSidebarCollapsedStorageKey("user-1")).toBe("rakazo:bots-sidebar-collapsed:user-1");
  });

  it("reads and writes collapsed state", () => {
    stubStorage();
    expect(readBotsSidebarCollapsed("user-1")).toBe(false);
    writeBotsSidebarCollapsed("user-1", true);
    expect(readBotsSidebarCollapsed("user-1")).toBe(true);
    writeBotsSidebarCollapsed("user-1", false);
    expect(readBotsSidebarCollapsed("user-1")).toBe(false);
  });

  it("keeps a saved width per user, the rail included, and ignores widths it cannot show", () => {
    const store = stubStorage();
    expect(readBotsSidebarWidth("user-1")).toBe(BOTS_SIDEBAR_DEFAULT_WIDTH);
    writeBotsSidebarWidth("user-1", 400);
    expect(readBotsSidebarWidth("user-1")).toBe(400);
    expect(readBotsSidebarWidth("user-2")).toBe(BOTS_SIDEBAR_DEFAULT_WIDTH);
    writeBotsSidebarWidth("user-1", BOTS_SIDEBAR_RAIL_WIDTH);
    expect(readBotsSidebarWidth("user-1")).toBe(BOTS_SIDEBAR_RAIL_WIDTH);
    store.set("rakazo:bots-sidebar-width:user-1", "150");
    expect(readBotsSidebarWidth("user-1")).toBe(BOTS_SIDEBAR_DEFAULT_WIDTH);
    store.set("rakazo:bots-sidebar-width:user-1", "5000");
    expect(readBotsSidebarWidth("user-1")).toBe(BOTS_SIDEBAR_MAX_WIDTH);
  });
});

describe("bots sidebar edge drag", () => {
  const max = 500;

  it("resizes freely between the minimum and the viewport limit", () => {
    expect(botsSidebarLayoutForWidth(350, max, 316)).toEqual({ collapsed: false, width: 350 });
    expect(botsSidebarLayoutForWidth(900, max, 316)).toEqual({ collapsed: false, width: max });
    expect(botsSidebarLayoutForWidth(BOTS_SIDEBAR_MIN_WIDTH - 20, max, 316)).toEqual({
      collapsed: false,
      width: BOTS_SIDEBAR_MIN_WIDTH,
    });
  });

  it("snaps to the avatar rail below the minimum, and hides past half the rail", () => {
    const snapOut = (BOTS_SIDEBAR_RAIL_WIDTH + BOTS_SIDEBAR_MIN_WIDTH) / 2;
    const rail = { collapsed: false, width: BOTS_SIDEBAR_RAIL_WIDTH };
    expect(botsSidebarLayoutForWidth(snapOut - 1, max, 316)).toEqual(rail);
    expect(botsSidebarLayoutForWidth(BOTS_SIDEBAR_RAIL_WIDTH / 2, max, 316)).toEqual(rail);
    expect(botsSidebarLayoutForWidth(BOTS_SIDEBAR_RAIL_WIDTH / 2 - 1, max, 316)).toEqual({
      collapsed: true,
      width: 316,
    });
    expect(botsSidebarLayoutForWidth(snapOut, max, 316)).toEqual({
      collapsed: false,
      width: BOTS_SIDEBAR_MIN_WIDTH,
    });
  });

  it("never offers less than the minimum width on a narrow window", () => {
    expect(botsSidebarMaxWidth(700)).toBe(BOTS_SIDEBAR_MIN_WIDTH);
    expect(botsSidebarMaxWidth(1100)).toBe(460);
    expect(botsSidebarMaxWidth(4000)).toBe(BOTS_SIDEBAR_MAX_WIDTH);
  });

  it("steps through the same stops with the arrow keys", () => {
    const hidden = { collapsed: true, width: 316 };
    const rail = { collapsed: false, width: BOTS_SIDEBAR_RAIL_WIDTH };
    const narrow = { collapsed: false, width: BOTS_SIDEBAR_MIN_WIDTH };
    expect(nudgeBotsSidebar(hidden, true, max)).toEqual(rail);
    expect(nudgeBotsSidebar(hidden, false, max)).toEqual(hidden);
    expect(nudgeBotsSidebar(rail, true, max)).toEqual(narrow);
    expect(nudgeBotsSidebar(rail, false, max)).toEqual({
      collapsed: true,
      width: BOTS_SIDEBAR_RAIL_WIDTH,
    });
    expect(nudgeBotsSidebar(narrow, false, max)).toEqual(rail);
    expect(nudgeBotsSidebar({ collapsed: false, width: 230 }, false, max)).toEqual(narrow);
    expect(nudgeBotsSidebar({ collapsed: false, width: 300 }, true, max)).toEqual({
      collapsed: false,
      width: 324,
    });
    expect(nudgeBotsSidebar({ collapsed: false, width: max }, true, max)).toEqual({
      collapsed: false,
      width: max,
    });
  });
});
