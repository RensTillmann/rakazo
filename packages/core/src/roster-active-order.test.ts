import { describe, expect, it } from "vitest";
import {
  orderRosterWithActiveFirst,
  type RosterActivityBot,
  type RosterActivityState,
  trackRosterActivity,
} from "./roster-active-order.js";

type Item = { kind: "bot" | "group"; id: string };
type Group = { key: string; title: string | null; bots: Item[] };

const bot = (id: string): Item => ({ kind: "bot", id });
const room = (id: string): Item => ({ kind: "group", id });
const botId = (item: Item) => (item.kind === "bot" ? item.id : null);

function roster(): Group[] {
  return [
    { key: "pinned", title: "Pinned", bots: [bot("josy"), bot("riona"), room("standup")] },
    { key: "section:fleet", title: "Fleet", bots: [bot("sage"), bot("quinn")] },
    { key: "unassigned", title: "Unassigned", bots: [bot("nova"), room("ops")] },
  ];
}

/** A bot that never had a message: no activity. */
const fresh = (id: string): RosterActivityBot => ({
  id,
  status: "idle",
  unread: false,
  updatedAt: "2026-10-19T07:00:00.000Z",
  lastMessageAt: null,
});
const ids = ["josy", "riona", "sage", "quinn", "nova"];
const freshRoster = () => ids.map(fresh);
const T0 = Date.parse("2026-10-19T08:00:00.000Z");

function ordered(activity: RosterActivityState) {
  const { active, groups } = orderRosterWithActiveFirst(roster(), activity, botId);
  return { active: active.map((item) => item.id), groups };
}

function withBot(bots: RosterActivityBot[], next: RosterActivityBot) {
  return bots.map((entry) => (entry.id === next.id ? next : entry));
}

describe("roster recency block", () => {
  it("leaves a roster without activity unchanged", () => {
    const activity = trackRosterActivity(null, freshRoster(), T0);
    const result = ordered(activity);
    expect(result.active).toEqual([]);
    expect(result.groups).toEqual(roster());
  });

  it("keeps a bot in the top block after it becomes idle", () => {
    let bots = freshRoster();
    let activity = trackRosterActivity(null, bots, T0);
    bots = withBot(bots, { ...fresh("sage"), status: "running" });
    activity = trackRosterActivity(activity, bots, T0 + 1_000);
    bots = withBot(bots, {
      ...fresh("sage"),
      lastMessageAt: new Date(T0 + 5_000).toISOString(),
    });
    activity = trackRosterActivity(activity, bots, T0 + 6_000);
    const result = ordered(activity);
    expect(result.active).toEqual(["sage"]);
    expect(result.groups[1]).toEqual({
      key: "section:fleet",
      title: "Fleet",
      bots: [bot("quinn")],
    });
  });

  it("puts a newer active bot above the previous one", () => {
    let bots = freshRoster();
    let activity = trackRosterActivity(null, bots, T0);
    bots = withBot(bots, { ...fresh("nova"), status: "running" });
    activity = trackRosterActivity(activity, bots, T0 + 1_000);
    bots = withBot(bots, { ...fresh("nova"), lastMessageAt: new Date(T0 + 2_000).toISOString() });
    bots = withBot(bots, { ...fresh("quinn"), status: "queued" });
    activity = trackRosterActivity(activity, bots, T0 + 3_000);
    expect(ordered(activity).active).toEqual(["quinn", "nova"]);
  });

  it("puts Josy first and Sage second when Josy asks after Sage", () => {
    let bots = freshRoster();
    let activity = trackRosterActivity(null, bots, T0);
    bots = withBot(bots, { ...fresh("sage"), status: "running" });
    activity = trackRosterActivity(activity, bots, T0 + 1_000);
    bots = withBot(bots, { ...fresh("josy"), status: "waiting_input" });
    activity = trackRosterActivity(activity, bots, T0 + 2_000);
    const result = ordered(activity);
    expect(result.active).toEqual(["josy", "sage"]);
    expect(result.groups[0]).toEqual({
      key: "pinned",
      title: "Pinned",
      bots: [bot("riona"), room("standup")],
    });
  });

  it("takes the page-load order from the server message times", () => {
    const bots = withBot(
      withBot(freshRoster(), { ...fresh("quinn"), lastMessageAt: "2026-10-19T06:00:00.000Z" }),
      { ...fresh("riona"), lastMessageAt: "2026-10-19T07:30:00.000Z" },
    );
    const first = trackRosterActivity(null, bots, T0);
    const reloaded = trackRosterActivity(null, bots, T0 + 60_000);
    expect(ordered(first).active).toEqual(["riona", "quinn"]);
    expect(ordered(reloaded).active).toEqual(["riona", "quinn"]);
  });

  it("keeps a bot without any activity in its folder", () => {
    const bots = withBot(freshRoster(), {
      ...fresh("sage"),
      lastMessageAt: "2026-10-19T07:30:00.000Z",
    });
    const result = ordered(trackRosterActivity(null, bots, T0));
    expect(result.active).toEqual(["sage"]);
    expect(result.groups[1]).toEqual({
      key: "section:fleet",
      title: "Fleet",
      bots: [bot("quinn")],
    });
    expect(result.groups[2]).toEqual(roster()[2]);
  });

  it("never moves rooms", () => {
    const bots = ids.map((id) => ({ ...fresh(id), lastMessageAt: "2026-10-19T07:30:00.000Z" }));
    const result = ordered(trackRosterActivity(null, bots, T0));
    expect(result.active).toEqual(ids);
    expect(result.groups).toEqual([
      { key: "pinned", title: "Pinned", bots: [room("standup")] },
      { key: "unassigned", title: "Unassigned", bots: [room("ops")] },
    ]);
  });

  it("keeps an emptied folder when the surface shows empty folders", () => {
    const bots = ["sage", "quinn"].map((id) => ({
      ...fresh(id),
      lastMessageAt: "2026-10-19T07:30:00.000Z",
    }));
    const { groups } = orderRosterWithActiveFirst(
      roster(),
      trackRosterActivity(null, bots, T0),
      botId,
      (group) => group.key.startsWith("section:"),
    );
    expect(groups[1]).toEqual({ key: "section:fleet", title: "Fleet", bots: [] });
  });

  it("bumps a bot to the top when an unread reply arrives", () => {
    let bots = withBot(
      withBot(freshRoster(), { ...fresh("quinn"), lastMessageAt: "2026-10-19T07:00:00.000Z" }),
      { ...fresh("riona"), lastMessageAt: "2026-10-19T07:30:00.000Z" },
    );
    let activity = trackRosterActivity(null, bots, T0);
    expect(ordered(activity).active).toEqual(["riona", "quinn"]);
    bots = withBot(bots, {
      ...fresh("quinn"),
      unread: true,
      lastMessageAt: "2026-10-19T07:00:00.000Z",
    });
    activity = trackRosterActivity(activity, bots, T0 + 1_000);
    expect(ordered(activity).active).toEqual(["quinn", "riona"]);
  });

  it("returns the same state on an unchanged poll, so the order does not reshuffle", () => {
    const bots = withBot(freshRoster(), {
      ...fresh("sage"),
      status: "running",
      lastMessageAt: "2026-10-19T07:30:00.000Z",
    });
    const first = trackRosterActivity(null, bots, T0);
    const polled = trackRosterActivity(
      first,
      bots.map((entry) => ({ ...entry })),
      T0 + 30_000,
    );
    expect(polled).toBe(first);
  });
});
