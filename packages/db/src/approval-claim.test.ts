import { describe, expect, it, vi } from "vitest";
import { claimSourceCheckedEffect } from "./approval-claim.js";

function fixture(status = "approved", sourceMessageId: string | null = "source") {
  const row = { status, sourceMessageId, request: undefined as unknown };
  const message = {
    threadId: "source-thread",
    runId: "source-run",
    blocks: [{ kind: "ask", text: "Continue?", choices: ["Yes", "No"] }],
  };
  const order: string[] = [];
  const findFirst = vi.fn(async () => row);
  const source = vi.fn(async () => message);
  const sourceRun = vi.fn().mockResolvedValue({ id: "source-run" });
  const update = vi.fn(async ({ where, data }) => {
    order.push(data.status);
    const matches =
      typeof where.status === "string"
        ? row.status === where.status
        : where.status.in.includes(row.status);
    if (!matches || ("sourceMessageId" in where && where.sourceMessageId !== row.sourceMessageId))
      return { count: 0 };
    row.status = data.status;
    if ("sourceMessageId" in data) row.sourceMessageId = data.sourceMessageId;
    return { count: 1 };
  });
  const lock = vi.fn(async (parts: TemplateStringsArray) => {
    order.push(parts.join("?").includes("threads") ? "thread" : "run");
    return [];
  });
  const tx = {
    externalEffect: { findFirst, updateMany: update },
    message: { findFirst: source },
    run: { findFirst: sourceRun },
    $queryRaw: lock,
  };
  const transaction = vi.fn(async (fn) => fn(tx));
  const db = { $transaction: transaction } as unknown as Parameters<
    typeof claimSourceCheckedEffect
  >[0];
  const scope = { id: "effect-run", spaceId: "space", userId: "owner", botId: "bot" };
  return {
    db,
    scope,
    row,
    message,
    order,
    findFirst,
    source,
    sourceRun,
    update,
    lock,
    transaction,
  };
}

describe("source-checked execution claim", () => {
  it.each(["approved", "intended"] as const)("locks source before claiming %s", async (status) => {
    const f = fixture(status);
    expect(await claimSourceCheckedEffect(f.db, f.scope, "effect", status)).toBe(true);
    expect(f.order).toEqual(["thread", "run", "executing"]);
    expect(f.source).toHaveBeenCalledTimes(2);
    expect(f.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "effect",
          runId: "effect-run",
          spaceId: "space",
          run: { userId: "owner", botId: "bot" },
        },
      }),
    );
  });
  it("re-reads an answer that wins while waiting for the source lock", async () => {
    const f = fixture();
    f.lock.mockImplementation(async () => {
      f.message.blocks = [
        {
          kind: "ask",
          text: "Continue?",
          choices: ["Yes", "No"],
          status: "answered",
          answer: "Yes",
        } as never,
      ];
      return [];
    });
    expect(await claimSourceCheckedEffect(f.db, f.scope, "effect", "approved")).toBe(false);
    expect(f.row.status).toBe("invalidated");
    expect(f.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "executing" } }),
    );
  });
  it("rejects a source with no exact owned waiting run", async () => {
    const f = fixture();
    f.sourceRun.mockResolvedValue(null);
    expect(await claimSourceCheckedEffect(f.db, f.scope, "effect", "approved")).toBe(false);
    expect(f.row.status).toBe("invalidated");
    expect(f.sourceRun).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "source-run",
          threadId: "source-thread",
          spaceId: "space",
          userId: "owner",
          botId: "bot",
          status: "waiting_input",
        },
      }),
    );
  });
  it("fails closed if the source disappears under lock", async () => {
    const f = fixture();
    f.source.mockResolvedValueOnce(f.message).mockResolvedValueOnce(null as never);
    expect(await claimSourceCheckedEffect(f.db, f.scope, "effect", "approved")).toBe(false);
    expect(f.row.status).toBe("invalidated");
  });
  it("refuses protected or replaced question content", async () => {
    const f = fixture();
    f.message.blocks = [
      { kind: "ask", text: "Continue?", choices: ["Yes"], approvalEffectId: "other" } as never,
    ];
    expect(await claimSourceCheckedEffect(f.db, f.scope, "effect", "approved")).toBe(false);
    expect(f.row.status).toBe("invalidated");
  });
  it("does not claim or change another owned run's effect", async () => {
    const f = fixture();
    f.findFirst.mockResolvedValue(null as never);
    expect(await claimSourceCheckedEffect(f.db, f.scope, "effect", "approved")).toBe(false);
    expect(f.update).not.toHaveBeenCalled();
    expect(f.lock).not.toHaveBeenCalled();
  });
  it.each(["denied", "invalidated", "completed", "executing", "uncertain"])(
    "preserves %s history",
    async (status) => {
      const f = fixture(status);
      expect(await claimSourceCheckedEffect(f.db, f.scope, "effect", "approved")).toBe(false);
      expect(f.update).not.toHaveBeenCalled();
      expect(f.row.status).toBe(status);
    },
  );
  it("does not claim a bound source without account identity", async () => {
    const f = fixture();
    expect(
      await claimSourceCheckedEffect(f.db, { ...f.scope, userId: undefined }, "effect", "approved"),
    ).toBe(false);
    expect(f.update).not.toHaveBeenCalled();
  });
  it("propagates lock failure without claiming or changing history", async () => {
    const f = fixture();
    f.lock.mockRejectedValue(new Error("lock failed"));
    await expect(claimSourceCheckedEffect(f.db, f.scope, "effect", "approved")).rejects.toThrow(
      "lock failed",
    );
    expect(f.update).not.toHaveBeenCalled();
  });
  it("retains the status CAS for effects without a source", async () => {
    const f = fixture("approved", null);
    expect(await claimSourceCheckedEffect(f.db, f.scope, "effect", "approved")).toBe(true);
    expect(f.lock).not.toHaveBeenCalled();
    expect(f.source).not.toHaveBeenCalled();
  });
  it("does not resurrect a concurrent denial", async () => {
    const f = fixture();
    f.lock.mockImplementation(async () => {
      f.row.status = "denied";
      return [];
    });
    expect(await claimSourceCheckedEffect(f.db, f.scope, "effect", "approved")).toBe(false);
    expect(f.row.status).toBe("denied");
  });
});

const legacyRoute = {
  connectorId: "mcp",
  resourceId: "server-a",
  toolName: "question_withdraw",
  resourceRevision: 3,
};
const legacyDirect = (route = legacyRoute, args: unknown = { message_id: "source" }) => [
  "__rakazoCatalogTool",
  "direct",
  { route, args },
];
const legacyCatalog = (route = legacyRoute, args: unknown = { message_id: "source" }) => [
  "__rakazoCatalogTool",
  "connectors_execute_tool",
  { id: "server-a:question_withdraw", arguments: args },
  route,
];

describe("legacy bound source execution claim", () => {
  it.each([legacyDirect(), legacyCatalog()].map((request) => [request]))(
    "revalidates persisted exact envelopes",
    async (request) => {
      const f = fixture("approved", null);
      f.row.request = request;
      expect(await claimSourceCheckedEffect(f.db, f.scope, "effect", "approved")).toBe(true);
      expect(f.order).toEqual(["thread", "run", "executing"]);
      expect(f.update).toHaveBeenCalledWith({
        where: {
          id: "effect",
          runId: "effect-run",
          spaceId: "space",
          status: "approved",
          sourceMessageId: null,
        },
        data: { status: "executing", sourceMessageId: "source" },
      });
    },
  );
  it.each([legacyDirect(), legacyCatalog()].map((request) => [request]))(
    "rejects an answer that wins before the lock",
    async (request) => {
      const f = fixture("approved", null);
      f.row.request = request;
      f.lock.mockImplementation(async () => {
        f.message.blocks[0] = {
          ...f.message.blocks[0],
          status: "answered",
          answer: "Yes",
        } as never;
        return [];
      });
      expect(await claimSourceCheckedEffect(f.db, f.scope, "effect", "approved")).toBe(false);
      expect(f.row.status).toBe("invalidated");
    },
  );
  it.each([legacyDirect(), legacyCatalog()].map((request) => [request]))(
    "rejects a missing or foreign source",
    async (request) => {
      const f = fixture("approved", null);
      f.row.request = request;
      f.source.mockResolvedValue(null as never);
      expect(await claimSourceCheckedEffect(f.db, f.scope, "effect", "approved")).toBe(false);
      expect(f.row.status).toBe("invalidated");
      expect(f.source).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: "source",
            botId: "bot",
            role: "bot",
            thread: { spaceId: "space", userId: "owner" },
          },
        }),
      );
    },
  );
  it.each(["denied", "completed", "executing", "uncertain", "invalidated"])(
    "preserves legacy %s history",
    async (status) => {
      const f = fixture(status, null);
      f.row.request = legacyDirect();
      expect(await claimSourceCheckedEffect(f.db, f.scope, "effect", "approved")).toBe(false);
      expect(f.source).not.toHaveBeenCalled();
      expect(f.update).not.toHaveBeenCalled();
    },
  );
  it.each(
    [
      { message_id: "source" },
      ["wrong-marker", "direct", { route: legacyRoute, args: { message_id: "source" } }],
      ["__rakazoCatalogTool", "connectors_execute_tool", { arguments: { message_id: "source" } }],
      legacyDirect({ ...legacyRoute, connectorId: "other" }),
      legacyDirect({ ...legacyRoute, toolName: "other" }),
      legacyDirect({ ...legacyRoute, resourceId: "" }),
      legacyDirect({ ...legacyRoute, resourceRevision: {} } as never),
      legacyDirect(legacyRoute, { message_id: " source" }),
      legacyDirect(legacyRoute, { message_id: 42 }),
      legacyDirect(legacyRoute, []),
      [
        "__rakazoCatalogTool",
        "other_execute_tool",
        { id: "server-a:question_withdraw", arguments: { message_id: "source" } },
        legacyRoute,
      ],
      [
        "__rakazoCatalogTool",
        "connectors_execute_tool",
        { id: "other:question_withdraw", arguments: { message_id: "source" } },
        legacyRoute,
      ],
    ].map((request) => [request]),
  )("does not infer a source from unbound or mismatched data", async (request) => {
    const f = fixture("approved", null);
    f.row.request = request;
    expect(await claimSourceCheckedEffect(f.db, f.scope, "effect", "approved")).toBe(true);
    expect(f.source).not.toHaveBeenCalled();
    expect(f.lock).not.toHaveBeenCalled();
  });
  it("does not replace an existing explicit binding from an envelope", async () => {
    const f = fixture();
    f.row.request = legacyDirect(legacyRoute, { message_id: "unrelated" });
    expect(await claimSourceCheckedEffect(f.db, f.scope, "effect", "approved")).toBe(true);
    expect(f.source).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: "source" }) }),
    );
  });
});

describe("legacy recovery CAS and failures", () => {
  it("accepts the original MCP catalog wrapper", async () => {
    const f = fixture("intended", null);
    const request = legacyCatalog();
    request[1] = "mcp_execute_tool";
    f.row.request = request;
    expect(await claimSourceCheckedEffect(f.db, f.scope, "effect", "intended")).toBe(true);
    expect(f.row.sourceMessageId).toBe("source");
  });
  it("does not overwrite a competing source binding", async () => {
    const f = fixture("approved", null);
    f.row.request = legacyDirect();
    f.lock.mockImplementation(async () => {
      f.row.sourceMessageId = "other-source";
      return [];
    });
    expect(await claimSourceCheckedEffect(f.db, f.scope, "effect", "approved")).toBe(false);
    expect(f.row.status).toBe("approved");
    expect(f.row.sourceMessageId).toBe("other-source");
  });
  it("does not bind or execute when acquiring the source lock fails", async () => {
    const f = fixture("approved", null);
    f.row.request = legacyDirect();
    f.lock.mockRejectedValue(new Error("lock failed"));
    await expect(claimSourceCheckedEffect(f.db, f.scope, "effect", "approved")).rejects.toThrow(
      "lock failed",
    );
    expect(f.row.sourceMessageId).toBeNull();
    expect(f.update).not.toHaveBeenCalled();
  });
});
