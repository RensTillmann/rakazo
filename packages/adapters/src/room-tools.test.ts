import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DELEGATION_TOOL_NAMES } from "./builtin-tools.js";
import { selectBuiltinToolsForRun } from "./executor.js";
import {
  ROOM_TOOL_NAMES,
  roomCreate,
  roomPost,
  roomToolsAllowedForBot,
  roomUpdate,
} from "./room-tools.js";

const run = {
  id: "run-1",
  spaceId: "space-1",
  threadId: "thread-1",
  botId: "josy",
  userId: "user-1",
};
const unusedDeps = {
  prisma: {} as PrismaClient,
  events: { notify: vi.fn() },
  jobs: { enqueue: vi.fn(), cancel: vi.fn() },
  sandbox: {},
} as never;

const baseOptions = {
  graphicalToolsAllowed: false,
  groupId: null,
  trigger: "user",
  semanticMemoryEnabled: false,
  messagingChannelRun: false,
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("room tools", () => {
  it("are offered to chat runs but never to delegated or background runs", () => {
    const names = selectBuiltinToolsForRun(baseOptions).map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([...ROOM_TOOL_NAMES]));
    for (const name of ROOM_TOOL_NAMES) expect(DELEGATION_TOOL_NAMES.has(name)).toBe(true);
    const background = selectBuiltinToolsForRun({ ...baseOptions, trigger: "tickets" }).map(
      (tool) => tool.name,
    );
    expect(background.filter((name) => name.startsWith("room_"))).toEqual([]);
  });

  it("follow the per-bot disabled tools when RAKAZO_ROOM_TOOL_BOTS is unset", () => {
    expect(roomToolsAllowedForBot("any-bot")).toBe(true);
    const names = selectBuiltinToolsForRun({
      ...baseOptions,
      botId: "riona",
      disabledBuiltinTools: ["room_post"],
    }).map((tool) => tool.name);
    expect(names).not.toContain("room_post");
    expect(names).toContain("room_list");
  });

  it("are limited to the listed bots when RAKAZO_ROOM_TOOL_BOTS is set", () => {
    vi.stubEnv("RAKAZO_ROOM_TOOL_BOTS", "josy, elena");
    expect(roomToolsAllowedForBot("josy")).toBe(true);
    expect(roomToolsAllowedForBot("riona")).toBe(false);
    const riona = selectBuiltinToolsForRun({ ...baseOptions, botId: "riona" }).map(
      (tool) => tool.name,
    );
    expect(riona.filter((name) => name.startsWith("room_"))).toEqual([]);
    const josy = selectBuiltinToolsForRun({ ...baseOptions, botId: "josy" }).map(
      (tool) => tool.name,
    );
    expect(josy).toEqual(expect.arrayContaining([...ROOM_TOOL_NAMES]));
  });

  it("refuse rooms outside 3 to 6 distinct bots before touching the database", async () => {
    await expect(
      roomCreate(unusedDeps, run, {
        name: "Case 4 · Refund",
        botIds: ["a", "b"],
        roomKind: "case",
      }),
    ).resolves.toEqual({ error: "a room needs 3 to 6 bots" });
    await expect(
      roomCreate(unusedDeps, run, {
        name: "Case 4 · Refund",
        botIds: ["a", "b", "c", "d", "e", "f", "g"],
        roomKind: "case",
      }),
    ).resolves.toEqual({ error: "a room needs 3 to 6 bots" });
    await expect(
      roomUpdate(unusedDeps, run, { roomId: "room-1", botIds: ["a", "a", "b"] }),
    ).resolves.toEqual({ error: "botIds must be distinct" });
    await expect(
      roomCreate(unusedDeps, run, { name: "Team", botIds: ["a", "b", "c"], roomKind: "other" }),
    ).resolves.toEqual({ error: "roomKind must be case or standing" });
  });

  it("refuse an empty post", async () => {
    await expect(
      roomPost(unusedDeps, run, { roomId: "room-1", text: " " }, "key"),
    ).resolves.toEqual({ error: "text is required" });
  });
});
