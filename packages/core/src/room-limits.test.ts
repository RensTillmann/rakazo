import { afterEach, describe, expect, it, vi } from "vitest";
import { capRoomWakes, roomMaxRunsPerDay, roomMaxWakes } from "./room-limits.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("room limits", () => {
  it("are off when unset or invalid", () => {
    vi.stubEnv("RAKAZO_ROOM_MAX_RUNS_PER_DAY", "");
    vi.stubEnv("RAKAZO_ROOM_MAX_WAKES", "zero");
    expect(roomMaxRunsPerDay()).toBeUndefined();
    expect(roomMaxWakes()).toBeUndefined();
    expect(capRoomWakes(["a", "b", "c", "d"])).toEqual(["a", "b", "c", "d"]);
  });

  it("read positive integers and cap wakes in resolved order", () => {
    vi.stubEnv("RAKAZO_ROOM_MAX_RUNS_PER_DAY", "40");
    vi.stubEnv("RAKAZO_ROOM_MAX_WAKES", "3");
    expect(roomMaxRunsPerDay()).toBe(40);
    expect(capRoomWakes(["a", "b", "c", "d"])).toEqual(["a", "b", "c"]);
  });
});
