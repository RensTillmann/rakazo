import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import {
  createHindsightProvider,
  HINDSIGHT_SAVE_REFUSAL,
  HindsightMemoryProvider,
} from "./hindsight-memory-provider.js";

const context: AdapterContext = {
  operationId: "op-1",
  traceId: "trace-1",
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  signal: new AbortController().signal,
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("HindsightMemoryProvider", () => {
  it("recalls every bank with the exclude-tags filter and merges round-robin in bank order", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("/banks/fleet/")
        ? json({ results: [{ id: "f1", text: "fleet fact", score: 0.4 }] })
        : url.includes("/banks/knowledge/")
          ? json({
              results: [
                { id: "k1", text: "knowledge fact", score: 0.9 },
                { id: "k2", text: "weak fact", score: 0.1 },
              ],
            })
          : json({ results: [{ id: "p1", text: "public fact", score: 0.6 }] }),
    );
    const provider = new HindsightMemoryProvider({
      baseUrl: "http://hindsight:8888",
      apiKey: "hs_test_key",
      banks: ["fleet", "knowledge", "public"],
      excludeTags: ["pii:person", "embargo:security"],
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await provider.recall(
      { query: "release notes", scope: "shared", botId: "bot-1", limit: 3 },
      context,
    );

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "http://hindsight:8888/v1/default/banks/fleet/memories/recall",
      "http://hindsight:8888/v1/default/banks/knowledge/memories/recall",
      "http://hindsight:8888/v1/default/banks/public/memories/recall",
    ]);
    for (const call of fetchMock.mock.calls) {
      const init = (call as unknown as [string, RequestInit])[1];
      expect(init.method).toBe("POST");
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer hs_test_key");
      expect(JSON.parse(String(init.body))).toEqual({
        query: "release notes",
        tag_groups: [{ not: { tags: ["pii:person", "embargo:security"], match: "any_strict" } }],
      });
    }
    expect(result).toEqual({
      ok: true,
      value: [
        { id: "f1", memory: "fleet fact", score: 0.4, entity: "fleet" },
        { id: "k1", memory: "knowledge fact", score: 0.9, entity: "knowledge" },
        { id: "p1", memory: "public fact", score: 0.6, entity: "public" },
        { id: "k2", memory: "weak fact", score: 0.1, entity: "knowledge" },
      ],
    });
  });

  it("gives every bank a fair share and lets other banks fill an empty one", async () => {
    const many = (prefix: string, n: number) =>
      json({ results: Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, text: `${prefix}${i}` })) });
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("/banks/fleet/")
        ? json({ results: [] })
        : url.includes("/banks/knowledge/")
          ? many("k", 10)
          : many("p", 10),
    );
    const provider = new HindsightMemoryProvider({
      baseUrl: "http://hindsight:8888",
      apiKey: "hs_test_key",
      banks: ["fleet", "knowledge", "public"],
      excludeTags: [],
      recallLimit: 8,
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await provider.recall(
      { query: "q", scope: "shared", botId: "bot-1", limit: 5 },
      context,
    );

    expect(result.ok && result.value.map((item) => item.id)).toEqual([
      "k0", "p0", "k1", "p1", "k2", "p2", "k3", "p3",
    ]);
  });

  it("uses the run limit when it is larger than recallLimit", async () => {
    const fetchMock = vi.fn(async () =>
      json({ results: Array.from({ length: 6 }, (_, i) => ({ text: `m${i}` })) }),
    );
    const provider = new HindsightMemoryProvider({
      baseUrl: "http://hindsight:8888",
      apiKey: "hs_test_key",
      banks: ["knowledge"],
      excludeTags: [],
      recallLimit: 2,
      fetch: fetchMock as unknown as typeof fetch,
    });
    const result = await provider.recall(
      { query: "q", scope: "shared", botId: "bot-1", limit: 4 },
      context,
    );
    expect(result.ok && result.value).toHaveLength(4);
  });

  it("parses recallLimit from settings and rejects invalid values", () => {
    expect(() =>
      createHindsightProvider(
        { baseUrl: "http://hindsight:8888", recallLimit: "abc" },
        { apiKey: "hs_test_key" },
      ),
    ).toThrow("recallLimit must be a whole number");
    expect(() =>
      createHindsightProvider(
        { baseUrl: "http://hindsight:8888", recallLimit: "0" },
        { apiKey: "hs_test_key" },
      ),
    ).toThrow("recallLimit must be between 1 and 50");
  });

  it("applies default banks and exclude tags from empty settings", async () => {
    const fetchMock = vi.fn(async () => json({ results: [] }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const provider = createHindsightProvider(
        { baseUrl: "http://hindsight:8888/" },
        { apiKey: "hs_test_key" },
      );
      await provider.recall({ query: "q", scope: "shared", botId: "bot-1", limit: 5 }, context);
    } finally {
      vi.unstubAllGlobals();
    }
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map((call) => call[0])).toEqual([
      "http://hindsight:8888/v1/default/banks/fleet/memories/recall",
      "http://hindsight:8888/v1/default/banks/knowledge/memories/recall",
      "http://hindsight:8888/v1/default/banks/public/memories/recall",
    ]);
    expect(JSON.parse(String(calls[0]?.[1].body)).tag_groups).toEqual([
      { not: { tags: ["pii:person", "embargo:security"], match: "any_strict" } },
    ]);
  });

  it("returns an error instead of hanging when recall times out", async () => {
    vi.useFakeTimers();
    try {
      const provider = new HindsightMemoryProvider({
        baseUrl: "http://hindsight:8888",
        apiKey: "hs_test_key",
        banks: ["fleet"],
        excludeTags: ["pii:person"],
        timeoutMs: 8_000,
        // Never settles and ignores the abort signal.
        fetch: (() => new Promise<Response>(() => undefined)) as typeof fetch,
      });
      const pending = provider.recall(
        { query: "q", scope: "shared", botId: "bot-1", limit: 5 },
        context,
      );
      await vi.advanceTimersByTimeAsync(8_000);
      await expect(pending).resolves.toEqual({
        ok: false,
        error: "Hindsight recall timed out after 8000 ms",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns an error when a bank fails", async () => {
    const provider = new HindsightMemoryProvider({
      baseUrl: "http://hindsight:8888",
      apiKey: "hs_test_key",
      banks: ["fleet"],
      excludeTags: [],
      fetch: (async () => new Response("down", { status: 503 })) as typeof fetch,
    });
    await expect(
      provider.recall({ query: "q", scope: "shared", botId: "bot-1", limit: 5 }, context),
    ).resolves.toEqual({ ok: false, error: "Hindsight recall from fleet failed: HTTP 503" });
  });

  it("refuses save, forget and purgeHistory and reports itself recall-only", async () => {
    const fetchMock = vi.fn();
    const provider = new HindsightMemoryProvider({
      baseUrl: "http://hindsight:8888",
      apiKey: "hs_test_key",
      banks: ["fleet"],
      excludeTags: [],
      fetch: fetchMock as unknown as typeof fetch,
    });
    const refusal = { ok: false, error: HINDSIGHT_SAVE_REFUSAL };
    expect(HINDSIGHT_SAVE_REFUSAL).toContain("memory_save (fleet MCP)");
    await expect(
      provider.save(
        { content: "x", scope: "shared", botId: "bot-1", source: { kind: "durable" } },
        context,
      ),
    ).resolves.toEqual(refusal);
    await expect(provider.forget({ id: "m1" }, context)).resolves.toEqual(refusal);
    await expect(
      provider.purgeHistory({ botId: "bot-1", generations: [1] }, context),
    ).resolves.toEqual(refusal);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(provider.describe().capabilities).toMatchObject({ save: false, purgeHistory: false });
  });
});
