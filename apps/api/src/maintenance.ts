import {
  MaintenanceChangeSchema,
  MaintenanceCommandSchema,
  MaintenanceRecoveryCommandSchema,
  MaintenanceRecoveryResultSchema,
  MaintenanceRecoverySchema,
  MaintenanceSnapshotSchema,
} from "@rakazo/contracts";
import type { MaintenanceControlStore, MaintenanceRecoveryStore } from "@rakazo/db/maintenance";
import {
  MaintenanceConflictError,
  MaintenanceOwnerRequiredError,
} from "@rakazo/db/maintenance";
import type { Context, Hono } from "hono";
import { readBoundedBody } from "./http-body.js";

function rejectUntrustedMutation(c: Context, trustedOrigin: (origin: string) => boolean) {
  if (c.req.method !== "POST") return null;
  // CORS alone does not prevent cookie-authenticated cross-site mutations.
  // Require an explicit trusted Origin and JSON for every control command,
  // including non-browser clients; credentials alone do not bypass this gate.
  const origin = c.req.header("origin");
  if (!origin || origin === "null" || !trustedOrigin(origin)) {
    return c.json({ error: "Trusted origin required" }, 403);
  }
  if (c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return c.json({ error: "JSON required" }, 415);
  }
  return null;
}

function controlError(c: Context, error: unknown) {
  if (error instanceof MaintenanceOwnerRequiredError) {
    return c.json({ error: "Deployment owner required" }, 403);
  }
  if (error instanceof MaintenanceConflictError) {
    return c.json({ error: "Refresh maintenance status before retrying" }, 409);
  }
  // Do not leak SQL, connection details or session failures to the caller.
  return c.json({ error: "Maintenance control unavailable" }, 503);
}

async function readCommand(c: Context, limit: number): Promise<{ raw: unknown } | Response> {
  const body = await readBoundedBody(c.req.raw, limit);
  if (body === null) return c.json({ error: "Command too large" }, 413);
  try {
    return { raw: JSON.parse(body) };
  } catch {
    return c.json({ error: "Invalid command" }, 400);
  }
}

/** Owner controls only, never mounted as a model tool or unauthenticated webhook. */
export function mountMaintenanceRoutes(
  app: Hono,
  deps: {
    store: MaintenanceControlStore | null;
    recovery?: MaintenanceRecoveryStore | null;
    authenticate: (request: Request) => Promise<{ userId: string } | null>;
    trustedOrigin: (origin: string) => boolean;
  },
) {
  app.use("/api/maintenance/*", async (c, next) => {
    c.header("cache-control", "no-store");
    await next();
  });
  app.use("/api/maintenance", async (c, next) => {
    c.header("cache-control", "no-store");
    await next();
  });
  app.on(["GET", "POST"], "/api/maintenance", async (c) => {
    const rejected = rejectUntrustedMutation(c, deps.trustedOrigin);
    if (rejected) return rejected;
    try {
      const actor = await deps.authenticate(c.req.raw);
      if (!actor) return c.json({ error: "Authentication required" }, 401);
      if (!deps.store) return c.json({ error: "Maintenance store unavailable" }, 503);
      if (c.req.method === "GET") {
        return c.json(MaintenanceSnapshotSchema.parse(await deps.store.statusForOperator(actor.userId)));
      }
      const read = await readCommand(c, 2048);
      if (read instanceof Response) return read;
      const command = MaintenanceCommandSchema.safeParse(read.raw);
      if (!command.success) return c.json({ error: "Invalid command" }, 400);
      return c.json(MaintenanceChangeSchema.parse(await deps.store.change(actor.userId, command.data)));
    } catch (error) {
      return controlError(c, error);
    }
  });
  // Settles one unfinished attempt/effect from recorded evidence or the owner's verification.
  // Never resumes, retries or undoes work; the global pause is untouched.
  app.on(["GET", "POST"], "/api/maintenance/recovery", async (c) => {
    const rejected = rejectUntrustedMutation(c, deps.trustedOrigin);
    if (rejected) return rejected;
    try {
      const actor = await deps.authenticate(c.req.raw);
      if (!actor) return c.json({ error: "Authentication required" }, 401);
      if (!deps.recovery) return c.json({ error: "Maintenance store unavailable" }, 503);
      if (c.req.method === "GET") {
        return c.json(MaintenanceRecoverySchema.parse(await deps.recovery.recoveryForOperator(actor.userId)));
      }
      const read = await readCommand(c, 4096);
      if (read instanceof Response) return read;
      const command = MaintenanceRecoveryCommandSchema.safeParse(read.raw);
      if (!command.success) return c.json({ error: "Invalid command" }, 400);
      return c.json(MaintenanceRecoveryResultSchema.parse(
        await deps.recovery.settleRecovery(actor.userId, command.data),
      ));
    } catch (error) {
      return controlError(c, error);
    }
  });
}
