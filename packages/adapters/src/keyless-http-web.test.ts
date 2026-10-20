import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { FakeWebProvider } from "./fake-web.js";
import {
  extractReadableText,
  isDuckDuckGoResultsPage,
  KeylessHttpWebProvider,
  parseDuckDuckGoResults,
} from "./keyless-http-web.js";
import { clampMaxChars, clampMaxResults } from "./web-limits.js";
import { createWebProvider, resolveWebProviderKind } from "./web-provider-factory.js";
import { webFetchFromTool, webSearchFromTool } from "./web-tools.js";

const ctx: AdapterContext = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

const publicResolver = async () => [{ address: "203.0.113.10", family: 4 as const }];

const resultsHtml = `
  <div class="result">
    <a class="result__a" href="https://example.test/a">Alpha</a>
    <div class="result__snippet">Snippet A</div>
  </div>`;

// Stand-in for DuckDuckGo's 202 bot-check page: no result links, no "no results" notice.
const botCheckHtml = `<html><body><form id="challenge-form"><p>Unfortunately, bots use DuckDuckGo too.</p></form></body></html>`;

// Trimmed from a live DuckDuckGo HTML response for a query with no matches (20 Oct 2026).
const noResultsHtml = `
  <div class="serp__results"><div id="links" class="results">
    <div class="result results_links results_links_deep web-result result--no-result">
      <div class="links_main links_deep result__body">
        <div class="no-results__container result__title"><span class='no-results'>
          <div class="no-results__message"><h1>No results found for <strong>&quot;xq7z&quot;</strong></h1></div>
        </span></div>
      </div>
    </div>
  </div></div>`;

function scriptedSearch(responses: Array<[status: number, html: string]>) {
  const requests: string[] = [];
  const sleeps: number[] = [];
  const fetchMock: typeof fetch = async (input) => {
    requests.push(String(input));
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra search request");
    return new Response(next[1], { status: next[0], headers: { "content-type": "text/html" } });
  };
  const provider = new KeylessHttpWebProvider({
    fetch: fetchMock,
    resolveHostname: publicResolver,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { provider, requests, sleeps };
}

describe("web provider factory", () => {
  it("defaults to keyless-http", () => {
    expect(resolveWebProviderKind({})).toBe("keyless-http");
    expect(createWebProvider().describe().id).toBe("keyless-http");
    expect(createWebProvider("fake").describe().id).toBe("fake");
  });
});

describe("keyless HTTP web provider", () => {
  it("searches via the HTML backend without a vendor API key", async () => {
    const html = `
      <div class="result">
        <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.test%2Fa">Alpha</a>
        <a class="result__snippet">Snippet A</a>
      </div>
      <div class="result">
        <a class="result__a" href="https://example.test/b">Beta</a>
        <div class="result__snippet">Snippet B</div>
      </div>
    `;
    const fetchMock: typeof fetch = async () =>
      new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    const provider = new KeylessHttpWebProvider({
      fetch: fetchMock,
      resolveHostname: publicResolver,
    });
    const results = await provider.search({ query: "alpha", maxResults: 5 }, ctx);
    expect(results).toEqual([
      { title: "Alpha", url: "https://example.test/a", snippet: "Snippet A" },
      { title: "Beta", url: "https://example.test/b", snippet: "Snippet B" },
    ]);
  });

  it("fetches readable page text with truncation", async () => {
    const long = "word ".repeat(100);
    const html = `<html><head><title>Doc</title></head><body><article><p>${long}</p></article></body></html>`;
    const fetchMock: typeof fetch = async () =>
      new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    const provider = new KeylessHttpWebProvider({
      fetch: fetchMock,
      resolveHostname: publicResolver,
    });
    const result = await provider.fetch({ url: "https://example.test/doc", maxChars: 120 }, ctx);
    expect(result.title).toBeTruthy();
    expect(result.url).toBe("https://example.test/doc");
    expect(result.truncated).toBe(true);
    expect(result.text.endsWith("[Content truncated]")).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(120 + "\n\n[Content truncated]".length);
  });

  it("falls back to HTML strip when Readability finds nothing", () => {
    const extracted = extractReadableText(
      "<html><title>Plain</title><body><div>just text here</div></body></html>",
      "https://example.test/",
    );
    expect(extracted.title).toBe("Plain");
    expect(extracted.text).toContain("just text here");
  });

  it("parses HTML search results with a cap", () => {
    const html = Array.from({ length: 12 }, (_, i) => {
      return `<div class="result"><a class="result__a" href="https://example.test/${i}">T${i}</a><div class="result__snippet">S${i}</div></div>`;
    }).join("");
    expect(parseDuckDuckGoResults(html, 3)).toHaveLength(3);
  });

  it("retries once after a 202 bot-check page and returns the retry's results", async () => {
    const { provider, requests, sleeps } = scriptedSearch([
      [202, botCheckHtml],
      [200, resultsHtml],
    ]);
    await expect(provider.search({ query: "alpha", maxResults: 5 }, ctx)).resolves.toEqual([
      { title: "Alpha", url: "https://example.test/a", snippet: "Snippet A" },
    ]);
    expect(requests).toHaveLength(2);
    expect(sleeps).toEqual([1_500]);
  });

  it("fails with a clear error when DuckDuckGo blocks the search twice", async () => {
    const { provider, requests, sleeps } = scriptedSearch([
      [202, botCheckHtml],
      [202, botCheckHtml],
    ]);
    await expect(webSearchFromTool(provider, ctx, { query: "alpha" })).resolves.toEqual({
      error:
        "DuckDuckGo blocked the search (HTTP 202); try again in a minute or use web_fetch on a known URL",
    });
    expect(requests).toHaveLength(2);
    expect(sleeps).toEqual([1_500]);
  });

  it("treats a 200 page without results markup and an error status as blocks", async () => {
    const { provider, requests } = scriptedSearch([
      [200, botCheckHtml],
      [429, "slow down"],
    ]);
    await expect(provider.search({ query: "alpha" }, ctx)).rejects.toThrow(
      "DuckDuckGo blocked the search (HTTP 429); try again in a minute or use web_fetch on a known URL",
    );
    expect(requests).toHaveLength(2);
  });

  it("returns [] for DuckDuckGo's genuine no-results page without retrying", async () => {
    expect(isDuckDuckGoResultsPage(noResultsHtml)).toBe(true);
    expect(isDuckDuckGoResultsPage(botCheckHtml)).toBe(false);
    const { provider, requests, sleeps } = scriptedSearch([[200, noResultsHtml]]);
    await expect(webSearchFromTool(provider, ctx, { query: "xq7z" })).resolves.toEqual({
      results: [],
    });
    expect(requests).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("returns normal results on the first request without waiting", async () => {
    const { provider, requests, sleeps } = scriptedSearch([[200, resultsHtml]]);
    await expect(provider.search({ query: "alpha" }, ctx)).resolves.toHaveLength(1);
    expect(requests).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });
});

describe("web tool apply with fake provider", () => {
  it("returns injected search and fetch results", async () => {
    const fake = new FakeWebProvider();
    fake.searchHits = [
      { title: "One", url: "https://example.test/1", snippet: "s1" },
      { title: "Two", url: "https://example.test/2", snippet: "s2" },
    ];
    fake.fetchResult = {
      url: "https://example.test/1",
      title: "One",
      text: "Body text",
      truncated: false,
    };

    await expect(webSearchFromTool(fake, ctx, { query: "q", maxResults: 1 })).resolves.toEqual({
      results: [{ title: "One", url: "https://example.test/1", snippet: "s1" }],
    });
    expect(fake.lastSearch?.query).toBe("q");

    await expect(
      webFetchFromTool(fake, ctx, { url: "https://example.test/1", maxChars: 100 }),
    ).resolves.toEqual({
      url: "https://example.test/1",
      title: "One",
      text: "Body text",
      truncated: false,
    });
  });

  it("surfaces provider errors as tool errors", async () => {
    const fake = new FakeWebProvider();
    fake.searchError = new Error("boom");
    await expect(webSearchFromTool(fake, ctx, { query: "q" })).resolves.toEqual({
      error: "boom",
    });
  });

  it("includes the network cause in the tool error", async () => {
    const fake = new FakeWebProvider();
    fake.searchError = new TypeError("fetch failed", {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND html.duckduckgo.com"), {
        code: "ENOTFOUND",
      }),
    });
    await expect(webSearchFromTool(fake, ctx, { query: "q" })).resolves.toEqual({
      error: "fetch failed: ENOTFOUND",
    });

    fake.searchError = new TypeError("fetch failed", { cause: new Error("other side closed") });
    await expect(webSearchFromTool(fake, ctx, { query: "q" })).resolves.toEqual({
      error: "fetch failed: other side closed",
    });
  });
});

describe("web tool clamps", () => {
  it("clamps maxResults and maxChars", () => {
    expect(clampMaxResults(undefined)).toBe(5);
    expect(clampMaxResults(100)).toBe(10);
    expect(clampMaxResults(0)).toBe(1);
    expect(clampMaxChars(undefined)).toBe(8_000);
    expect(clampMaxChars(10)).toBe(100);
    expect(clampMaxChars(999_999)).toBe(50_000);
  });
});
