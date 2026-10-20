import { setTimeout as delay } from "node:timers/promises";
import { Readability } from "@mozilla/readability";
import type {
  AdapterContext,
  WebFetchRequest,
  WebFetchResult,
  WebProvider,
  WebSearchHit,
  WebSearchRequest,
} from "@rakazo/adapter-kit";
import { JSDOM } from "jsdom";
import { clampMaxChars, clampMaxResults } from "./web-limits.js";
import { fetchSafeWebText, type ResolveHostname, WebHttpStatusError } from "./web-ssrf.js";

export {
  clampMaxChars,
  clampMaxResults,
  DEFAULT_WEB_FETCH_MAX_CHARS,
  DEFAULT_WEB_SEARCH_MAX_RESULTS,
  MAX_WEB_FETCH_MAX_CHARS,
  MAX_WEB_SEARCH_RESULTS,
  MIN_WEB_FETCH_MAX_CHARS,
} from "./web-limits.js";

const DEFAULT_SEARCH_ENDPOINT = "https://html.duckduckgo.com/html/";
const SEARCH_ATTEMPTS = 2;
const DEFAULT_SEARCH_RETRY_DELAY_MS = 1_500;

export type KeylessHtmlSearchBackend = {
  id: string;
  /** Shown to the bot when the engine blocks a search. Defaults to `id`. */
  name?: string;
  endpoint: string;
  parse(html: string, maxResults: number): WebSearchHit[];
  /**
   * Whether a 200 page with no parsed hits is the engine's own results page
   * (its "no results" notice) rather than a block or challenge page.
   * Omitted: every 200 page counts as a results page.
   */
  isResultsPage?(html: string): boolean;
};

export type KeylessHttpWebOptions = {
  fetch?: typeof globalThis.fetch;
  resolveHostname?: ResolveHostname;
  searchBackend?: KeylessHtmlSearchBackend;
  searchTimeoutMs?: number;
  /** Wait before the one retry of a blocked search. */
  searchRetryDelayMs?: number;
  /** Test seam for the retry wait. Must reject when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  fetchTimeoutMs?: number;
  maxBufferBytes?: number;
  userAgent?: string;
};

/** HTML search backend using DuckDuckGo’s public HTML form. One keyless option, not the interface. */
export const duckDuckGoHtmlSearchBackend: KeylessHtmlSearchBackend = {
  id: "duckduckgo-html",
  name: "DuckDuckGo",
  endpoint: DEFAULT_SEARCH_ENDPOINT,
  parse: parseDuckDuckGoResults,
  isResultsPage: isDuckDuckGoResultsPage,
};

/**
 * Keyless HTTP web search + page fetch. No API key, no sandbox, no JS execution.
 * Search uses a pluggable HTML backend (default: DuckDuckGo HTML). Fetch uses
 * Mozilla Readability with a lightweight HTML-strip fallback.
 */
export class KeylessHttpWebProvider implements WebProvider {
  private readonly fetchImpl?: typeof globalThis.fetch;
  private readonly resolveHostname?: ResolveHostname;
  private readonly searchBackend: KeylessHtmlSearchBackend;
  private readonly searchTimeoutMs: number;
  private readonly searchRetryDelayMs: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly fetchTimeoutMs: number;
  private readonly maxBufferBytes: number;
  private readonly userAgent: string;

  constructor(options: KeylessHttpWebOptions = {}) {
    this.fetchImpl = options.fetch;
    this.resolveHostname = options.resolveHostname;
    this.searchBackend = options.searchBackend ?? duckDuckGoHtmlSearchBackend;
    this.searchTimeoutMs = options.searchTimeoutMs ?? 15_000;
    this.searchRetryDelayMs = options.searchRetryDelayMs ?? DEFAULT_SEARCH_RETRY_DELAY_MS;
    this.sleep = options.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }));
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? 15_000;
    this.maxBufferBytes = options.maxBufferBytes ?? 5 * 1024 * 1024;
    this.userAgent =
      options.userAgent ?? "Rakazo/0.1 (+https://github.com/elie222/rakazo; web tools)";
  }

  describe() {
    return {
      id: "keyless-http",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        search: true,
        fetch: true,
        keyless: true,
        native: false,
        readability: true,
      },
    };
  }

  /**
   * A non-200 answer, or a 200 page that is neither results nor the engine's
   * "no results" notice, is a block (DuckDuckGo serves a 202 bot check). Retry
   * once after a pause, then fail loudly so the bot never mistakes a block for
   * "nothing exists".
   */
  async search(request: WebSearchRequest, context: AdapterContext): Promise<WebSearchHit[]> {
    const query = request.query.trim();
    if (!query) throw new Error("query is required");
    const maxResults = clampMaxResults(request.maxResults);
    const searchUrl = new URL(this.searchBackend.endpoint);
    searchUrl.searchParams.set("q", query);
    const signal = request.signal ?? context.signal;
    let blocked = "";
    for (let attempt = 0; attempt < SEARCH_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await this.sleep(this.searchRetryDelayMs, signal);
      const page = await this.fetchSearchPage(searchUrl.href, signal);
      if (page.status === 200) {
        const hits = this.searchBackend.parse(page.body, maxResults);
        if (hits.length > 0 || (this.searchBackend.isResultsPage?.(page.body) ?? true)) {
          return hits;
        }
        blocked = "HTTP 200 without a results page";
      } else {
        blocked = `HTTP ${page.status}`;
      }
    }
    const engine = this.searchBackend.name ?? this.searchBackend.id;
    throw new Error(
      `${engine} blocked the search (${blocked}); try again in a minute or use web_fetch on a known URL`,
    );
  }

  private async fetchSearchPage(
    url: string,
    signal: AbortSignal | undefined,
  ): Promise<{ status: number; body: string }> {
    try {
      const { status, body } = await fetchSafeWebText(url, {
        fetch: this.fetchImpl,
        resolveHostname: this.resolveHostname,
        timeoutMs: this.searchTimeoutMs,
        maxBytes: 1024 * 1024,
        userAgent: this.userAgent,
        signal,
      });
      return { status, body };
    } catch (error) {
      if (error instanceof WebHttpStatusError) return { status: error.status, body: "" };
      throw error;
    }
  }

  async fetch(request: WebFetchRequest, context: AdapterContext): Promise<WebFetchResult> {
    const maxChars = clampMaxChars(request.maxChars);
    const { url, body } = await fetchSafeWebText(request.url, {
      fetch: this.fetchImpl,
      resolveHostname: this.resolveHostname,
      timeoutMs: this.fetchTimeoutMs,
      maxBytes: this.maxBufferBytes,
      userAgent: this.userAgent,
      signal: request.signal ?? context.signal,
    });
    if (!body.trim()) throw new Error(`Failed to fetch content from ${url}`);
    const extracted = extractReadableText(body, url);
    const truncated = extracted.text.length > maxChars;
    return {
      url,
      title: extracted.title,
      text: truncated
        ? `${extracted.text.slice(0, maxChars)}\n\n[Content truncated]`
        : extracted.text,
      truncated,
    };
  }
}

export function parseDuckDuckGoResults(html: string, maxResults: number): WebSearchHit[] {
  const dom = new JSDOM(html, { url: DEFAULT_SEARCH_ENDPOINT });
  const document = dom.window.document;
  const results: WebSearchHit[] = [];

  for (const node of Array.from(document.querySelectorAll(".result"))) {
    const link = node.querySelector("a.result__a");
    if (!link) continue;
    const title = normalizeWhitespace(link.textContent ?? "");
    let url: string;
    try {
      url = unwrapDuckDuckGoUrl(link.getAttribute("href") ?? "");
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
      url = parsed.href;
    } catch {
      continue;
    }
    const snippet = normalizeWhitespace(node.querySelector(".result__snippet")?.textContent ?? "");
    if (title && url) results.push({ title, url, snippet });
    if (results.length >= maxResults) break;
  }
  return results;
}

/**
 * DuckDuckGo HTML marks real results with `a.result__a`. A genuine empty search
 * (checked live 20 Oct 2026 with a quoted random token) is still a results page:
 * `<div class="result results_links ... result--no-result">` holding
 * `<span class='no-results'>` "No results found for …". The 202 bot-check page
 * has neither.
 */
export function isDuckDuckGoResultsPage(html: string): boolean {
  const dom = new JSDOM(html, { url: DEFAULT_SEARCH_ENDPOINT });
  return dom.window.document.querySelector("a.result__a, .result--no-result") !== null;
}

function unwrapDuckDuckGoUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl, DEFAULT_SEARCH_ENDPOINT);
    const target = parsed.searchParams.get("uddg");
    if (target) return target;
    return parsed.href;
  } catch {
    return rawUrl;
  }
}

export function extractReadableText(html: string, url: string): { title: string; text: string } {
  const readable = extractWithReadability(html, url);
  if (readable) return readable;
  return stripHtmlFallback(html);
}

function extractWithReadability(html: string, url: string): { title: string; text: string } | null {
  try {
    const dom = new JSDOM(html, { url });
    const article = new Readability(dom.window.document).parse();
    if (article?.textContent && article.textContent.length > 0) {
      return {
        title: article.title?.trim() || "Untitled",
        text: normalizeArticleText(article.textContent),
      };
    }
    return null;
  } catch {
    return null;
  }
}

function stripHtmlFallback(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = normalizeWhitespace(titleMatch?.[1] ?? "") || "Untitled";
  const text = normalizeArticleText(
    html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " "),
  );
  return { title, text };
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeArticleText(text: string): string {
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
