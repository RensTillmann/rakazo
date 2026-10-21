import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deletePushToken,
  ExpoPushProvider,
  endSessionPushToken,
  expoPushData,
  expoPushErrorMessage,
  loadPushToken,
  MAX_EXPO_PUSH_RESPONSE_BYTES,
  PushSessionEndedError,
  savePushToken,
} from "./expo-push.js";

const dirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const notifyContext = {
  operationId: "n",
  traceId: "n",
  spaceId: "w",
  userId: "user-1",
  runId: "run-1",
  signal: new AbortController().signal,
};

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, { status });
}

interface PushEffectState {
  id: string;
  idempotencyKey: string;
  status: string;
  kind: string;
  spaceId: string;
  runId: string;
  request: unknown;
  createdAt: Date;
  updatedAt: Date;
}

function pushDatabase() {
  const state = { paused: false, authorized: true, cancelRequestedAt: null as Date | null };
  const effects: PushEffectState[] = [];
  const client = {
    $queryRaw: vi.fn(async () => [{ active: state.paused, revision: 1 }]),
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(client)),
    run: {
      findFirst: vi.fn(async () => state.authorized ? {
        bot: { notifyOnFinish: true }, thread: { groupId: null, group: null }, routine: null,
        maintenanceCancelRequestedAt: state.cancelRequestedAt,
      } : null),
      findUnique: vi.fn(async () => ({ maintenanceCancelRequestedAt: state.cancelRequestedAt })),
    },
    spaceMember: { findUnique: vi.fn(async () => state.authorized ? { id: "member" } : null) },
    externalEffect: {
      upsert: vi.fn(async ({ create }: { create: Omit<PushEffectState, "id" | "createdAt" | "updatedAt"> }) => {
        let effect = effects.find((row) => row.idempotencyKey === create.idempotencyKey);
        if (!effect) {
          effect = { ...create, id: `push-${effects.length}`, createdAt: new Date(), updatedAt: new Date() };
          effects.push(effect);
        }
        return { ...effect };
      }),
      findMany: vi.fn(async () => effects.filter((row) => row.status === "intended").map((row) => ({ ...row }))),
      updateMany: vi.fn(async ({ where, data }: {
        where: { id?: string; kind?: string; status?: string | { in: string[] }; updatedAt?: { lt: Date } };
        data: { status: string };
      }) => {
        let count = 0;
        for (const row of effects) {
          if (where.id && row.id !== where.id) continue;
          if (where.kind && row.kind !== where.kind) continue;
          if (typeof where.status === "string" && row.status !== where.status) continue;
          if (typeof where.status === "object" && !where.status.in.includes(row.status)) continue;
          if (where.updatedAt && row.updatedAt >= where.updatedAt.lt) continue;
          row.status = data.status;
          row.updatedAt = new Date();
          count++;
        }
        return { count };
      }),
    },
  };
  return { prisma: client as unknown as PrismaClient, client, state, effects };
}

describe("expo push tickets", () => {
  it("reads a single Expo ticket and a ticket array", () => {
    expect(expoPushErrorMessage({ data: { status: "ok", id: "1" } }, 200)).toBeUndefined();
    expect(expoPushErrorMessage({ data: { status: "error", message: "bad token" } }, 200)).toBe(
      "bad token",
    );
    expect(expoPushErrorMessage({ errors: [{ message: "rate limited" }] }, 429)).toBe(
      "rate limited",
    );
    expect(expoPushErrorMessage(undefined, 502)).toBe("expo push failed (502)");
    expect(
      expoPushErrorMessage(
        { data: { status: "error", details: { error: "DeviceNotRegistered" } } },
        200,
      ),
    ).toBe("DeviceNotRegistered");
  });
});

describe("expo push", () => {
  it("keeps refreshed push tokens owner-only", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-push-"));
    dirs.push(dataDir);
    const tokenFile = path.join(dataDir, "push-tokens", "user-1.txt");
    await savePushToken(dataDir, "user-1", "ExponentPushToken[old]");
    await chmod(tokenFile, 0o644);

    await savePushToken(dataDir, "user-1", "ExponentPushToken[new]");

    expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
  });

  it("does not follow a token-file symlink for reads or writes", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-push-"));
    dirs.push(dataDir);
    const tokenDir = path.join(dataDir, "push-tokens");
    const tokenFile = path.join(tokenDir, "user-1.txt");
    const target = path.join(dataDir, "outside.txt");
    await savePushToken(dataDir, "user-1", "ExponentPushToken[old]");
    await writeFile(target, "not-a-push-token");
    await rm(tokenFile);
    await symlink(target, tokenFile);

    await expect(loadPushToken(dataDir, "user-1")).resolves.toBeUndefined();
    // The new token replaces the link itself.
    await savePushToken(dataDir, "user-1", "ExponentPushToken[new]");
    await expect(readFile(target, "utf8")).resolves.toBe("not-a-push-token");
    await expect(loadPushToken(dataDir, "user-1")).resolves.toBe("ExponentPushToken[new]");
  });

  it("removes a registered token", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-push-"));
    dirs.push(dataDir);
    await savePushToken(dataDir, "user-1", "ExponentPushToken[test]");
    await deletePushToken(dataDir, "user-1");
    await expect(loadPushToken(dataDir, "user-1")).resolves.toBeUndefined();
  });

  it("moves a device token to the user who saves it last", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-push-"));
    dirs.push(dataDir);
    await savePushToken(dataDir, "user-1", "ExponentPushToken[device]", "session-1");
    await savePushToken(dataDir, "user-3", "ExponentPushToken[other]", "session-3");

    await savePushToken(dataDir, "user-2", "ExponentPushToken[device]", "session-2");

    await expect(loadPushToken(dataDir, "user-1")).resolves.toBeUndefined();
    await expect(loadPushToken(dataDir, "user-2")).resolves.toBe("ExponentPushToken[device]");
    await expect(loadPushToken(dataDir, "user-3")).resolves.toBe("ExponentPushToken[other]");
  });

  it("removes a token only with the session that registered it", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-push-"));
    dirs.push(dataDir);
    await savePushToken(dataDir, "user-1", "ExponentPushToken[test]", "session-1");

    await endSessionPushToken(dataDir, "user-1", "session-2");
    await expect(loadPushToken(dataDir, "user-1")).resolves.toBe("ExponentPushToken[test]");

    await endSessionPushToken(dataDir, "user-1", "session-1");
    await expect(loadPushToken(dataDir, "user-1")).resolves.toBeUndefined();
  });

  it("moves a token to the session that replaces its own", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-push-"));
    dirs.push(dataDir);
    await savePushToken(dataDir, "user-1", "ExponentPushToken[test]", "session-1");

    await endSessionPushToken(dataDir, "user-1", "session-1", "session-2");
    await endSessionPushToken(dataDir, "user-1", "session-1");
    await expect(loadPushToken(dataDir, "user-1")).resolves.toBe("ExponentPushToken[test]");

    await endSessionPushToken(dataDir, "user-1", "session-2");
    await expect(loadPushToken(dataDir, "user-1")).resolves.toBeUndefined();
  });

  it("does not restore a token another account claimed during session replacement", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-push-"));
    dirs.push(dataDir);
    const token = "ExponentPushToken[device]";
    await savePushToken(dataDir, "user-a", token, "session-a");

    await endSessionPushToken(dataDir, "user-a", "session-a", "session-a2", {
      beforeCommit: async () => {
        const dir = path.join(dataDir, "push-tokens");
        await rm(path.join(dir, "user-a.txt"));
        await writeFile(path.join(dir, "user-b.txt"), `${token}\nsession-b`, { mode: 0o600 });
      },
    });

    await expect(loadPushToken(dataDir, "user-a")).resolves.toBeUndefined();
    await expect(loadPushToken(dataDir, "user-b")).resolves.toBe(token);
  });

  it("does not delete a token that changed after it was read", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-push-"));
    dirs.push(dataDir);
    const tokenFile = path.join(dataDir, "push-tokens", "user-1.txt");
    await savePushToken(dataDir, "user-1", "ExponentPushToken[t]", "session-1");

    await savePushToken(dataDir, "user-2", "ExponentPushToken[t]", "session-2", {
      beforeRemoveOthers: async () => {
        await writeFile(tokenFile, "ExponentPushToken[x]\nsession-1b", "utf8");
      },
    });

    await expect(loadPushToken(dataDir, "user-1")).resolves.toBe("ExponentPushToken[x]");
    await expect(loadPushToken(dataDir, "user-2")).resolves.toBe("ExponentPushToken[t]");
  });

  it("does not publish a token once its session is no longer active", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-push-"));
    dirs.push(dataDir);
    await savePushToken(dataDir, "user-1", "ExponentPushToken[kept]", "session-kept");

    await expect(
      savePushToken(dataDir, "user-2", "ExponentPushToken[kept]", "session-2", {
        sessionActive: async () => false,
      }),
    ).rejects.toBeInstanceOf(PushSessionEndedError);

    await expect(loadPushToken(dataDir, "user-1")).resolves.toBe("ExponentPushToken[kept]");
    await expect(loadPushToken(dataDir, "user-2")).resolves.toBeUndefined();
  });

  it("removes a token when session end waits out the registration that just saved it", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-push-"));
    dirs.push(dataDir);
    let release!: (active: boolean) => void;
    const gate = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    let waiting = false;
    const saving = savePushToken(dataDir, "user-1", "ExponentPushToken[t]", "session-1", {
      sessionActive: async () => {
        waiting = true;
        return gate;
      },
    });
    await vi.waitFor(() => expect(waiting).toBe(true));
    let ended = false;
    const ending = endSessionPushToken(dataDir, "user-1", "session-1").then(() => {
      ended = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(ended).toBe(false);

    release(true);
    await saving;
    await ending;
    await expect(loadPushToken(dataDir, "user-1")).resolves.toBeUndefined();
  });

  it("publishes nothing when registration loses the session check", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-push-"));
    dirs.push(dataDir);
    let release!: (active: boolean) => void;
    const gate = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    let waiting = false;
    const saving = savePushToken(dataDir, "user-1", "ExponentPushToken[t]", "session-1", {
      sessionActive: async () => {
        waiting = true;
        return gate;
      },
    });
    await vi.waitFor(() => expect(waiting).toBe(true));
    const ending = endSessionPushToken(dataDir, "user-1", "session-1");
    release(false);

    await expect(saving).rejects.toBeInstanceOf(PushSessionEndedError);
    await ending;
    await expect(loadPushToken(dataDir, "user-1")).resolves.toBeUndefined();
  });

  it("keeps a single owner when two accounts claim one token together", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-push-"));
    dirs.push(dataDir);
    await savePushToken(dataDir, "user-1", "ExponentPushToken[t]", "session-1");
    let release!: (active: boolean) => void;
    const gate = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    let waiting = false;
    const first = savePushToken(dataDir, "user-2", "ExponentPushToken[t]", "session-2", {
      sessionActive: async () => {
        waiting = true;
        return gate;
      },
    });
    await vi.waitFor(() => expect(waiting).toBe(true));
    let secondDone = false;
    const second = savePushToken(dataDir, "user-3", "ExponentPushToken[t]", "session-3").then(
      () => {
        secondDone = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(secondDone).toBe(false);

    release(true);
    await first;
    await second;
    const owners = [
      await loadPushToken(dataDir, "user-1"),
      await loadPushToken(dataDir, "user-2"),
      await loadPushToken(dataDir, "user-3"),
    ].filter((token) => token === "ExponentPushToken[t]");
    expect(owners).toEqual(["ExponentPushToken[t]"]);
  });

  it("reads a token file written before tokens recorded their session", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-push-"));
    dirs.push(dataDir);
    await mkdir(path.join(dataDir, "push-tokens"));
    await writeFile(path.join(dataDir, "push-tokens", "user-1.txt"), "ExponentPushToken[legacy]\n");

    await endSessionPushToken(dataDir, "user-1", "session-1");
    await expect(loadPushToken(dataDir, "user-1")).resolves.toBe("ExponentPushToken[legacy]");

    await savePushToken(dataDir, "user-2", "ExponentPushToken[legacy]", "session-2");
    await expect(loadPushToken(dataDir, "user-1")).resolves.toBeUndefined();
  });

  it("does not call Expo when the user has no token", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-push-"));
    dirs.push(dataDir);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const push = new ExpoPushProvider(dataDir, pushDatabase().prisma);
    await push.send(
      { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
      {
        operationId: "n",
        traceId: "n",
        spaceId: "w",
        userId: "missing",
        runId: "run-1",
        signal: new AbortController().signal,
      },
    );
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(push.hasPushRecipient("missing")).resolves.toBe(false);
    await expect(
      push.deliver(
        { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
        {
          operationId: "n",
          traceId: "n",
          spaceId: "w",
          userId: "missing",
          runId: "run-1",
          signal: new AbortController().signal,
        },
      ),
    ).resolves.toBe("undeliverable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts to Expo when a token is registered", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-push-"));
    dirs.push(dataDir);
    await savePushToken(dataDir, "user-1", "ExponentPushToken[test]");
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(jsonResponse({ data: { status: "ok", id: "ticket" } })),
      );
    vi.stubGlobal("fetch", fetchMock);
    const push = new ExpoPushProvider(dataDir, pushDatabase().prisma);
    await push.send(
      { kind: "takeover", title: "Need you", body: "on screen", botId: "bot-1", threadId: "th-1" },
      notifyContext,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://exp.host/--/api/v2/push/send");
    const body = JSON.parse(String(init.body)) as {
      to: string;
      title: string;
      collapseId: string;
      tag: string;
      data: { kind: string; deliveryId: string };
    };
    expect(body.to).toBe("ExponentPushToken[test]");
    expect(body.title).toBe("Need you");
    expect(body.collapseId).toBe("th-1");
    expect(body.tag).toBe("th-1");
    expect(body.data).toEqual({
      kind: "takeover",
      botId: "bot-1",
      threadId: "th-1",
      spaceId: "w",
      deliveryId: expect.any(String),
    });
    expect(body.data.deliveryId.length).toBeGreaterThan(0);

    await push.send(
      { kind: "takeover", title: "Need you", body: "on screen", botId: "bot-1", threadId: "th-1" },
      { ...notifyContext, operationId: "another-notice" },
    );
    const secondInit = (fetchMock.mock.calls[1] as [string, RequestInit])[1];
    const secondBody = JSON.parse(String(secondInit.body)) as { data: { deliveryId: string } };
    expect(secondBody.data.deliveryId).not.toBe(body.data.deliveryId);
  });

  it("puts the space and group on the payload a tap opens", () => {
    expect(
      expoPushData(
        {
          kind: "completion",
          title: "done",
          body: "ok",
          botId: "bot-1",
          threadId: "thread-1",
          groupId: "group-1",
        },
        "space-1",
        "delivery-1",
      ),
    ).toEqual({
      kind: "completion",
      botId: "bot-1",
      threadId: "thread-1",
      spaceId: "space-1",
      groupId: "group-1",
      deliveryId: "delivery-1",
    });
    expect(
      expoPushData(
        { kind: "completion", title: "done", body: "ok", botId: "bot-1", threadId: "thread-1" },
        "",
        "delivery-2",
      ),
    ).toEqual({
      kind: "completion",
      botId: "bot-1",
      threadId: "thread-1",
      deliveryId: "delivery-2",
    });
  });

  it("does not deliver a token whose session row is gone, and leaves it to be retargeted", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-push-"));
    dirs.push(dataDir);
    const token = "ExponentPushToken[test]";
    await savePushToken(dataDir, "user-1", token, "session-1");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const push = new ExpoPushProvider(dataDir, pushDatabase().prisma, async () => null);

    await expect(
      push.deliver(
        { kind: "completion", title: "done", body: "secret", botId: "b", threadId: "t" },
        notifyContext,
      ),
    ).resolves.toBe("undeliverable");
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(loadPushToken(dataDir, "user-1")).resolves.toBe(token);
    await expect(push.hasPushRecipient("user-1")).resolves.toBe(false);

    await endSessionPushToken(dataDir, "user-1", "session-1", "session-2");
    await expect(loadPushToken(dataDir, "user-1")).resolves.toBe(token);
    const replaced = new ExpoPushProvider(dataDir, pushDatabase().prisma, async (sessionId) =>
      sessionId === "session-2" ? new Date(Date.now() + 60_000) : null,
    );
    await expect(replaced.hasPushRecipient("user-1")).resolves.toBe(true);
  });

  it("does not deliver a token whose session expiry has passed", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-push-"));
    dirs.push(dataDir);
    await savePushToken(dataDir, "user-1", "ExponentPushToken[test]", "session-1");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const push = new ExpoPushProvider(dataDir, pushDatabase().prisma, async () => new Date(Date.now() - 1_000));

    await expect(
      push.deliver(
        { kind: "completion", title: "done", body: "secret", botId: "b", threadId: "t" },
        notifyContext,
      ),
    ).resolves.toBe("undeliverable");
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(loadPushToken(dataDir, "user-1")).resolves.toBeUndefined();
  });

  it("does not send a token another account claimed while the session was looked up", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-push-"));
    dirs.push(dataDir);
    const token = "ExponentPushToken[device]";
    await savePushToken(dataDir, "user-1", token, "session-1");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let waiting = false;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const push = new ExpoPushProvider(dataDir, pushDatabase().prisma, async () => {
      waiting = true;
      await gate;
      return new Date(Date.now() + 60_000);
    });

    const delivering = push.deliver(
      { kind: "completion", title: "done", body: "secret", botId: "b", threadId: "t" },
      notifyContext,
    );
    await vi.waitFor(() => expect(waiting).toBe(true));
    await savePushToken(dataDir, "user-2", token, "session-2");
    release();

    await expect(delivering).resolves.toBe("undeliverable");
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(loadPushToken(dataDir, "user-1")).resolves.toBeUndefined();
    await expect(loadPushToken(dataDir, "user-2")).resolves.toBe(token);
  });

  it("saves a token when a leftover lock file is empty", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-push-"));
    dirs.push(dataDir);
    await mkdir(path.join(dataDir, "push-tokens"), { recursive: true });
    await writeFile(path.join(dataDir, "push-tokens", ".lock"), "");

    await savePushToken(dataDir, "user-1", "ExponentPushToken[test]", "session-1");

    await expect(loadPushToken(dataDir, "user-1")).resolves.toBe("ExponentPushToken[test]");
  });

  it.skipIf(process.platform === "win32")(
    "waits while another process holds the shared token lock file",
    async () => {
      const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-push-"));
      dirs.push(dataDir);
      const lockFile = path.join(dataDir, "push-tokens", ".lock");
      await mkdir(path.dirname(lockFile), { recursive: true });
      await writeFile(lockFile, "");
      const require = createRequire(import.meta.url);
      const holder = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
import { createRequire } from "node:module";
import { openSync, constants } from "node:fs";
const flock = createRequire(process.env.KOFFI)("koffi")
  .load(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : null)
  .func("int flock(int fd, int operation)");
const fd = openSync(process.env.LOCK, constants.O_RDWR);
if (flock(fd, 2) !== 0) process.exit(1);
process.stdout.write("ready\\n");
process.stdin.resume();
await new Promise((resolve) => process.stdin.once("end", resolve));
flock(fd, 8);
`,
        ],
        {
          env: { ...process.env, KOFFI: require.resolve("koffi"), LOCK: lockFile },
          stdio: ["pipe", "pipe", "inherit"],
        },
      );
      let output = "";
      holder.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      try {
        await vi.waitFor(() => expect(output).toContain("ready"));
        let saved = false;
        const saving = savePushToken(
          dataDir,
          "user-1",
          "ExponentPushToken[test]",
          "session-1",
        ).then(() => {
          saved = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(saved).toBe(false);

        holder.stdin?.end();
        await saving;
        await expect(loadPushToken(dataDir, "user-1")).resolves.toBe("ExponentPushToken[test]");
      } finally {
        holder.kill();
      }
    },
  );

  it("delivers when the registering session is still live", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-push-"));
    dirs.push(dataDir);
    await savePushToken(dataDir, "user-1", "ExponentPushToken[test]", "session-1");
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(jsonResponse({ data: { status: "ok", id: "ticket" } })),
      );
    vi.stubGlobal("fetch", fetchMock);
    const push = new ExpoPushProvider(dataDir, pushDatabase().prisma, async () => new Date(Date.now() + 60_000));

    await expect(
      push.deliver(
        { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
        notifyContext,
      ),
    ).resolves.toBe("delivered");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not deliver a session-bound token when it cannot check the session", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-push-"));
    dirs.push(dataDir);
    await savePushToken(dataDir, "user-1", "ExponentPushToken[test]", "session-1");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const push = new ExpoPushProvider(dataDir, pushDatabase().prisma);

    await expect(
      push.deliver(
        { kind: "completion", title: "done", body: "secret", botId: "b", threadId: "t" },
        notifyContext,
      ),
    ).resolves.toBe("undeliverable");
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(loadPushToken(dataDir, "user-1")).resolves.toBe("ExponentPushToken[test]");
  });

  it("keeps the token when the session lookup fails", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-push-"));
    dirs.push(dataDir);
    await savePushToken(dataDir, "user-1", "ExponentPushToken[test]", "session-1");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const push = new ExpoPushProvider(dataDir, pushDatabase().prisma, async () => {
      throw new Error("database unavailable");
    });

    await expect(
      push.deliver(
        { kind: "completion", title: "done", body: "secret", botId: "b", threadId: "t" },
        notifyContext,
      ),
    ).resolves.toBe("undeliverable");
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(loadPushToken(dataDir, "user-1")).resolves.toBe("ExponentPushToken[test]");
  });

  it("throws when Expo rejects the request", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-push-"));
    dirs.push(dataDir);
    await savePushToken(dataDir, "user-1", "ExponentPushToken[test]");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ errors: [{ message: "boom" }] }, 500)),
    );
    const push = new ExpoPushProvider(dataDir, pushDatabase().prisma);
    await expect(
      push.send(
        { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
        notifyContext,
      ),
    ).rejects.toThrow("boom");
  });

  it("rejects and cancels a declared oversized response", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-push-"));
    dirs.push(dataDir);
    await savePushToken(dataDir, "user-1", "ExponentPushToken[test]");
    const response = new Response("oversized", {
      headers: { "content-length": String(MAX_EXPO_PUSH_RESPONSE_BYTES + 1) },
    });
    const cancel = vi.spyOn(response.body!, "cancel");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await expect(
      new ExpoPushProvider(dataDir, pushDatabase().prisma).send(
        { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
        notifyContext,
      ),
    ).rejects.toThrow("Expo push response is too large.");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not wait past cancellation when an oversized body cancel hangs", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-push-"));
    dirs.push(dataDir);
    await savePushToken(dataDir, "user-1", "ExponentPushToken[test]");
    let cancelStarted = false;
    const hangingBody = new ReadableStream<Uint8Array>({
      cancel() {
        cancelStarted = true;
        return new Promise(() => undefined);
      },
    });
    const abort = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        setTimeout(() => abort.abort(), 20);
        return new Response(hangingBody, {
          headers: { "content-length": String(MAX_EXPO_PUSH_RESPONSE_BYTES + 1) },
        });
      }),
    );

    const started = Date.now();
    await expect(
      new ExpoPushProvider(dataDir, pushDatabase().prisma).send(
        { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
        { ...notifyContext, signal: abort.signal },
      ),
    ).rejects.toThrow("Expo push response is too large.");
    expect(cancelStarted).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("caps a streamed response without a content length", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-push-"));
    dirs.push(dataDir);
    await savePushToken(dataDir, "user-1", "ExponentPushToken[test]");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(new Uint8Array(MAX_EXPO_PUSH_RESPONSE_BYTES + 1))),
    );

    await expect(
      new ExpoPushProvider(dataDir, pushDatabase().prisma).send(
        { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
        notifyContext,
      ),
    ).rejects.toThrow("Expo push response is too large.");
  });

  it("rejects malformed successful responses", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-push-"));
    dirs.push(dataDir);
    await savePushToken(dataDir, "user-1", "ExponentPushToken[test]");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json")));

    await expect(
      new ExpoPushProvider(dataDir, pushDatabase().prisma).send(
        { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
        notifyContext,
      ),
    ).rejects.toThrow("Expo push returned an invalid response.");
  });

  it("passes caller cancellation to the Expo request", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-push-"));
    dirs.push(dataDir);
    await savePushToken(dataDir, "user-1", "ExponentPushToken[test]");
    const controller = new AbortController();
    controller.abort(new Error("notification cancelled"));
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal?.aborted).toBe(true);
      throw init?.signal?.reason;
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new ExpoPushProvider(dataDir, pushDatabase().prisma).send(
        { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
        { ...notifyContext, signal: controller.signal },
      ),
    ).rejects.toThrow("notification cancelled");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("throws when the Expo request never reaches the network", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-push-"));
    dirs.push(dataDir);
    await savePushToken(dataDir, "user-1", "ExponentPushToken[test]");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const push = new ExpoPushProvider(dataDir, pushDatabase().prisma);
    await expect(
      push.send(
        { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
        notifyContext,
      ),
    ).rejects.toThrow("offline");
  });

  it("reports DeviceNotRegistered without deleting a stored or replacement token", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-push-"));
    dirs.push(dataDir);
    await savePushToken(dataDir, "user-1", "ExponentPushToken[old]");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await savePushToken(dataDir, "user-1", "ExponentPushToken[new]");
        return jsonResponse({
          data: { status: "error", details: { error: "DeviceNotRegistered" } },
        });
      }),
    );
    const push = new ExpoPushProvider(dataDir, pushDatabase().prisma);
    await expect(
      push.send(
        { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
        notifyContext,
      ),
    ).rejects.toThrow("DeviceNotRegistered");
    await expect(loadPushToken(dataDir, "user-1")).resolves.toBe("ExponentPushToken[new]");
  });
});

describe("durable push admission", () => {
  const message = { kind: "completion" as const, title: "Done", body: "Finished", botId: "b", threadId: "t" };

  async function fixture() {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-push-maintenance-"));
    dirs.push(dataDir);
    await savePushToken(dataDir, notifyContext.userId, "ExponentPushToken[test]");
    const db = pushDatabase();
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ data: { status: "ok", id: "ticket" } }));
    vi.stubGlobal("fetch", fetchMock);
    return { dataDir, db, fetchMock, push: new ExpoPushProvider(dataDir, db.prisma) };
  }

  it("keeps paused notices through restart and delivers them once on resume", async () => {
    const { dataDir, db, fetchMock, push } = await fixture();
    db.state.paused = true;
    await expect(push.deliver(message, notifyContext)).resolves.toBe("pending");
    expect(db.effects[0]?.status).toBe("intended");
    expect(fetchMock).not.toHaveBeenCalled();
    const restarted = new ExpoPushProvider(dataDir, db.prisma);
    await restarted.reconcile(false);
    expect(fetchMock).not.toHaveBeenCalled();
    db.state.paused = false;
    await restarted.reconcile(true);
    await restarted.send(message, notifyContext);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(db.effects[0]?.status).toBe("completed");
  });

  it("settles an admitted send while paused without admitting a concurrent duplicate", async () => {
    const { db, fetchMock, push } = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    fetchMock.mockImplementation(async () => {
      entered();
      await gate;
      return jsonResponse({ data: { status: "ok", id: "ticket" } });
    });
    const sending = push.deliver(message, notifyContext);
    await waiting;
    expect(db.effects[0]?.status).toBe("executing");
    db.state.paused = true;
    await expect(push.deliver(message, notifyContext)).resolves.toBe("executing");
    release();
    await expect(sending).resolves.toBe("delivered");
    expect(db.effects[0]?.status).toBe("completed");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("never replays an unknown provider response after restart or resume", async () => {
    const { dataDir, db, fetchMock, push } = await fixture();
    fetchMock.mockRejectedValueOnce(new Error("connection lost after submission"));
    await expect(push.send(message, notifyContext)).rejects.toThrow("connection lost");
    expect(db.effects[0]?.status).toBe("uncertain");
    const restarted = new ExpoPushProvider(dataDir, db.prisma);
    await restarted.reconcile(true);
    await expect(restarted.deliver(message, notifyContext)).resolves.toBe("uncertain");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("marks crashed submissions uncertain while held and does not resend them", async () => {
    const { dataDir, db, fetchMock, push } = await fixture();
    db.state.paused = true;
    await push.send(message, notifyContext);
    const effect = db.effects[0]!;
    effect.status = "executing";
    effect.updatedAt = new Date(Date.now() - 120_000);
    const restarted = new ExpoPushProvider(dataDir, db.prisma);
    await restarted.reconcile(false);
    expect(effect.status).toBe("uncertain");
    db.state.paused = false;
    await restarted.reconcile(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("revalidates ownership and preferences before a queued send", async () => {
    const { db, fetchMock, push } = await fixture();
    db.state.paused = true;
    await push.send(message, notifyContext);
    db.state.paused = false;
    db.state.authorized = false;
    await push.reconcile(true);
    expect(db.effects[0]?.status).toBe("cancelled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires an affirmative Expo acceptance, not merely a successful HTTP status", async () => {
    const { db, fetchMock, push } = await fixture();
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    await expect(push.send(message, notifyContext)).rejects.toThrow("invalid response");
    expect(db.effects[0]?.status).toBe("uncertain");
    await push.reconcile(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("aborts the actual in-flight Expo request when force-stop targets its terminal source run", async () => {
    const { db, fetchMock, push } = await fixture();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let requestSignal: AbortSignal | undefined;
    fetchMock.mockImplementation(async (_url, init) => {
      requestSignal = init?.signal ?? undefined;
      entered();
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), { once: true });
      });
    });
    const sending = push.deliver(message, notifyContext);
    const rejected = expect(sending).rejects.toThrow("cancellation requested");
    await started;
    db.state.paused = true;
    db.state.cancelRequestedAt = new Date();
    await vi.advanceTimersByTimeAsync(2_000);
    await rejected;
    expect(requestSignal?.aborted).toBe(true);
    expect(db.effects[0]?.status).toBe("uncertain");
    expect(vi.getTimerCount()).toBe(0);
    db.state.paused = false;
    await push.reconcile(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("cancels an unsent intent whose source was force-stopped instead of submitting it after resume", async () => {
    const { db, fetchMock, push } = await fixture();
    db.state.paused = true;
    await push.send(message, notifyContext);
    db.state.cancelRequestedAt = new Date();
    db.state.paused = false;
    await push.reconcile(true);
    expect(db.effects[0]?.status).toBe("cancelled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retains a safely unsubmitted notice if the initial cancellation observation fails", async () => {
    const { db, fetchMock, push } = await fixture();
    db.client.run.findUnique.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(push.send(message, notifyContext)).rejects.toThrow("database unavailable");
    expect(db.effects[0]?.status).toBe("intended");
    expect(fetchMock).not.toHaveBeenCalled();
    await push.reconcile(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(db.effects[0]?.status).toBe("completed");
  });
});
