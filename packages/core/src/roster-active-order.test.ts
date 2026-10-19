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

const idle = (id: string): RosterActivityBot => ({
  id,
  status: "idle",
  unread: false,
  updatedAt: "2026-10-19T08:00:00.000Z",
});
const ids = ["josy", "riona", "sage", "quinn", "nova"];

function ordered(activity: RosterActivityState) {
  const { active, groups } = orderRosterWithActiveFirst(roster(), activity, botId);
  return { active: active.map((item) => item.id), groups };
}

describe("orderRosterWithActiveFirst", () => {
  it("leaves an inactive list unchanged", () => {
    const activity = trackRosterActivity(null, ids.map(idle), 1000);
    const result = ordered(activity);
    expect(result.active).toEqual([]);
    expect(result.groups).toEqual(roster());
  });

  it("moves one active non-pinned bot above pinned Josy", () => {
    const start = trackRosterActivity(null, ids.map(idle), 1000);
    const activity = trackRosterActivity(
      start,
      ids.map((id) => (id === "nova" ? { ...idle(id), status: "running" } : idle(id))),
      2000,
    );
    const result = ordered(activity);
    expect(result.active).toEqual(["nova"]);
    expect(result.groups[0]?.bots.map((item) => item.id)).toEqual(["josy", "riona", "standup"]);
    // Shown once: removed from its folder.
    expect(result.groups[2]?.bots.map((item) => item.id)).toEqual(["ops"]);
  });

  it("puts two active bots newest first", () => {
    let activity = trackRosterActivity(null, ids.map(idle), 1000);
    activity = trackRosterActivity(
      activity,
      ids.map((id) => (id === "quinn" ? { ...idle(id), status: "running" } : idle(id))),
      2000,
    );
    activity = trackRosterActivity(
      activity,
      ids.map((id) =>
        id === "quinn" || id === "riona" ? { ...idle(id), status: "running" } : idle(id),
      ),
      3000,
    );
    expect(ordered(activity).active).toEqual(["riona", "quinn"]);
  });

  it("puts Josy first when she asks a question after Sage went active", () => {
    let activity = trackRosterActivity(null, ids.map(idle), 1000);
    activity = trackRosterActivity(
      activity,
      ids.map((id) => (id === "sage" ? { ...idle(id), status: "running" } : idle(id))),
      2000,
    );
    expect(ordered(activity).active).toEqual(["sage"]);
    activity = trackRosterActivity(
      activity,
      ids.map((id) =>
        id === "josy"
          ? { ...idle(id), status: "waiting_input" }
          : id === "sage"
            ? { ...idle(id), status: "running" }
            : idle(id),
      ),
      3000,
    );
    expect(ordered(activity).active).toEqual(["josy", "sage"]);
  });

  it("returns a bot that becomes inactive to its exact former position", () => {
    let activity = trackRosterActivity(null, ids.map(idle), 1000);
    activity = trackRosterActivity(
      activity,
      ids.map((id) => (id === "riona" ? { ...idle(id), status: "running" } : idle(id))),
      2000,
    );
    expect(ordered(activity).groups[0]?.bots.map((item) => item.id)).toEqual(["josy", "standup"]);
    activity = trackRosterActivity(activity, ids.map(idle), 3000);
    const result = ordered(activity);
    expect(result.active).toEqual([]);
    expect(result.groups).toEqual(roster());
  });

  it("never moves rooms", () => {
    const activity: RosterActivityState = new Map([
      ["standup", { working: true, waiting: false, unreadKey: null, at: 5000 }],
      ["ops", { working: false, waiting: true, unreadKey: null, at: 6000 }],
    ]);
    const result = ordered(activity);
    expect(result.active).toEqual([]);
    expect(result.groups).toEqual(roster());
  });

  it("counts an unread reply as active, and reading it returns the bot", () => {
    let activity = trackRosterActivity(null, ids.map(idle), 1000);
    activity = trackRosterActivity(
      activity,
      ids.map((id) =>
        id === "sage"
          ? { ...idle(id), unread: true, updatedAt: "2026-10-19T09:00:00.000Z" }
          : idle(id),
      ),
      2000,
    );
    expect(ordered(activity).active).toEqual(["sage"]);
    activity = trackRosterActivity(activity, ids.map(idle), 3000);
    const result = ordered(activity);
    expect(result.active).toEqual([]);
    expect(result.groups).toEqual(roster());
  });

  it("keeps the same state on a poll with no change, so the order does not flicker", () => {
    const bots = ids.map((id) => (id === "nova" ? { ...idle(id), status: "running" } : idle(id)));
    const first = trackRosterActivity(trackRosterActivity(null, ids.map(idle), 1000), bots, 2000);
    expect(trackRosterActivity(first, bots, 9000)).toBe(first);
  });
});
