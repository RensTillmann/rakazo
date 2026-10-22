import type { MaintenanceStatus } from "@rakazo/contracts";
import { MaintenanceConflictError, MaintenanceOwnerRequiredError } from "@rakazo/db/maintenance";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { mountMaintenanceRoutes } from "./maintenance.js";

const origin = "https://operator.example.test";
const command = { requestId: "command", action: "enter", expectedRevision: 0 };
const status: MaintenanceStatus = {
  phase: "running", activeRuns: 0, activeEffects: 0, pendingRuns: 0, issues: [],
};
function fixture() {
  const store = {
    status: vi.fn(),
    statusForOperator: vi.fn(async (_userId: string) => ({
      state: { active: false, revision: 0 }, status,
    })),
    change: vi.fn(async (_userId: string, _command: unknown) => ({
      state: { active: true, revision: 1 },
      replayed: false,
    })),
  };
  const recovery = {
    recoveryForOperator: vi.fn(async (_userId: string) => ({ items: [] })),
    settleRecovery: vi.fn(async (_userId: string, _command: unknown) => ({
      outcome: "settled" as const, status: "failed",
    })),
  };
  const authenticate = vi.fn(
    async (_request: Request): Promise<{ userId: string } | null> => ({ userId: "operator" }),
  );
  const app = new Hono();
  mountMaintenanceRoutes(app, {
    store, recovery, authenticate, trustedOrigin: (value) => value === origin,
  });
  const post = (body: unknown = command, headers: Record<string, string> = {}) =>
    app.request("/api/maintenance", {
      method: "POST",
      headers: { origin, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  return { app, store, recovery, authenticate, post };
}

describe("owner maintenance HTTP controls", () => {
  it("reads owner-scoped status and prevents caching", async () => {
    const f = fixture();
    const response = await f.app.request("/api/maintenance");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ state: { active: false, revision: 0 }, status });
    expect(f.store.statusForOperator).toHaveBeenCalledExactlyOnceWith("operator");
    expect(f.store.change).not.toHaveBeenCalled();
  });
  it("does not publish a paused status when work is still active", async () => {
    const f = fixture();
    f.store.statusForOperator.mockResolvedValue({
      state: { active: true, revision: 1 },
      status: { ...status, phase: "paused", activeEffects: 1 },
    });
    const response = await f.app.request("/api/maintenance");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Maintenance control unavailable" });
  });
  it("does not acknowledge a command with an invalid durable revision", async () => {
    const f = fixture();
    f.store.change.mockResolvedValue({
      state: { active: true, revision: -1 },
      replayed: false,
    });
    const response = await f.post();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Maintenance control unavailable" });
  });
  it.each(["GET", "POST"])("requires authentication for %s", async (method) => {
    const f = fixture();
    f.authenticate.mockResolvedValue(null);
    const response = method === "GET" ? await f.app.request("/api/maintenance") : await f.post();
    expect(response.status).toBe(401);
    expect(f.store.statusForOperator).not.toHaveBeenCalled();
    expect(f.store.change).not.toHaveBeenCalled();
  });
  it.each(["", "null", "https://other.example.test"])(
    "rejects untrusted/missing Origin %s before changing state",
    async (value) => {
      const f = fixture();
      expect((await f.post(command, { origin: value })).status).toBe(403);
      expect(f.authenticate).not.toHaveBeenCalled();
      expect(f.store.change).not.toHaveBeenCalled();
    },
  );
  it("rejects simple form content types", async () => {
    const f = fixture();
    expect((await f.post(command, { "content-type": "text/plain" })).status).toBe(415);
    expect(f.store.change).not.toHaveBeenCalled();
  });
  it("binds command to session identity, never body identity", async () => {
    const f = fixture();
    const response = await f.post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      state: { active: true, revision: 1 },
      replayed: false,
    });
    expect(f.store.change).toHaveBeenCalledExactlyOnceWith("operator", command);
    expect((await f.post({ ...command, operatorId: "other" })).status).toBe(400);
  });
  it("accepts separately requested force stop with the same owner and CSRF checks", async () => {
    const f = fixture();
    const stop = { ...command, action: "force-stop" };
    expect((await f.post(stop)).status).toBe(200);
    expect(f.store.change).toHaveBeenCalledExactlyOnceWith("operator", stop);
    expect((await f.post(stop, { origin: "https://untrusted.example.test" })).status).toBe(403);
    expect(f.store.change).toHaveBeenCalledOnce();
  });
  it.each([
    null,
    [],
    {},
    { ...command, expectedRevision: "0" },
    { ...command, expectedRevision: -1 },
    { ...command, expectedRevision: 2147483647 },
    { ...command, expectedRevision: 0.5 },
    { ...command, action: "automatic-resume" },
    { ...command, requestId: " " },
    { ...command, requestId: "x".repeat(129) },
    { ...command, workId: "repair" },
  ])("rejects invalid/extra command fields %j", async (body) => {
    const f = fixture();
    expect((await f.post(body)).status).toBe(400);
    expect(f.store.change).not.toHaveBeenCalled();
  });
  it("preserves exact command identity rather than trimming it for validation", async () => {
    const f = fixture();
    const exact = { ...command, requestId: " command " };
    expect((await f.post(exact)).status).toBe(200);
    expect(f.store.change).toHaveBeenCalledExactlyOnceWith("operator", exact);
  });
  it("bounds streamed commands even without a content-length", async () => {
    const f = fixture();
    expect((await f.post({ ...command, requestId: "x".repeat(4096) })).status).toBe(413);
    expect(f.store.change).not.toHaveBeenCalled();
  });
  it("rejects malformed JSON", async () => {
    const f = fixture();
    const response = await f.app.request("/api/maintenance", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    expect(f.store.change).not.toHaveBeenCalled();
  });
  it("maps authoritative owner denial for both status and command", async () => {
    const f = fixture();
    f.store.statusForOperator.mockRejectedValue(new MaintenanceOwnerRequiredError());
    f.store.change.mockRejectedValue(new MaintenanceOwnerRequiredError());
    expect((await f.app.request("/api/maintenance")).status).toBe(403);
    expect((await f.post()).status).toBe(403);
  });
  it("reports conflicts without retrying or changing the command", async () => {
    const f = fixture();
    f.store.change.mockRejectedValue(new MaintenanceConflictError());
    expect((await f.post()).status).toBe(409);
    expect(f.store.change).toHaveBeenCalledOnce();
  });
  it("fails closed on store and authentication errors without leaking details", async () => {
    const f = fixture();
    f.store.change.mockRejectedValue(new Error("private DB details"));
    let response = await f.post();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private DB details");
    f.authenticate.mockRejectedValue(new Error("private session details"));
    response = await f.app.request("/api/maintenance");
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private session details");
  });
  it("does not invent state when a pool is unavailable", async () => {
    const app = new Hono();
    mountMaintenanceRoutes(app, {
      store: null,
      authenticate: async () => ({ userId: "operator" }),
      trustedOrigin: () => true,
    });
    expect((await app.request("/api/maintenance")).status).toBe(503);
  });
});

describe("owner recovery of unfinished operations", () => {
  const settle = { requestId: "r1", basis: "evidence", kind: "effect", id: "e1", expectedStatus: "executing" };
  const send = (f: ReturnType<typeof fixture>, body: unknown, headers: Record<string, string> = {}) =>
    f.app.request("/api/maintenance/recovery", {
      method: "POST",
      headers: { origin, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  it("settles only for the authenticated owner through a trusted origin", async () => {
    const f = fixture();
    const ok = await send(f, settle);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(f.recovery.settleRecovery).toHaveBeenCalledExactlyOnceWith("operator", settle);

    expect((await send(f, settle, { origin: "https://other.example.test" })).status).toBe(403);
    f.recovery.settleRecovery.mockRejectedValueOnce(new MaintenanceOwnerRequiredError());
    expect((await send(f, settle)).status).toBe(403);
    f.recovery.settleRecovery.mockRejectedValueOnce(new MaintenanceConflictError());
    expect((await send(f, settle)).status).toBe(409);
    f.authenticate.mockResolvedValueOnce(null);
    expect((await send(f, settle)).status).toBe(401);
    expect(f.recovery.settleRecovery).toHaveBeenCalledTimes(3);
  });

  it("takes the owner's continue or stop for a held run, owner-only, and nothing else for a run", async () => {
    const f = fixture();
    for (const basis of ["owner-override", "owner-stop"] as const) {
      const command = { requestId: `r-${basis}`, basis, kind: "run", id: "run-1", expectedStatus: "queued" };
      expect((await send(f, command)).status).toBe(200);
      expect(f.recovery.settleRecovery).toHaveBeenLastCalledWith("operator", command);
      f.recovery.settleRecovery.mockRejectedValueOnce(new MaintenanceOwnerRequiredError());
      expect((await send(f, command)).status).toBe(403);
    }
    // A run is never settled from evidence or a note, and an override names no outcome.
    expect((await send(f, { ...settle, kind: "run" })).status).toBe(400);
    expect((await send(f, {
      requestId: "r", basis: "owner-override", kind: "run", id: "run-1", expectedStatus: "queued", outcome: "completed",
    })).status).toBe(400);
    expect(f.recovery.settleRecovery).toHaveBeenCalledTimes(4);
  });

  it("rejects an owner check without a meaningful note before touching the store", async () => {
    const f = fixture();
    const response = await send(f, {
      ...settle, basis: "owner-verified", outcome: "failed", note: "   ok    ",
    });
    expect(response.status).toBe(400);
    expect(f.recovery.settleRecovery).not.toHaveBeenCalled();
  });
});
