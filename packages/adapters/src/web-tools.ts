import type { AdapterContext, WebFetchProvider, WebSearchProvider } from "@rakazo/adapter-kit";
import { clampMaxChars, clampMaxResults } from "./web-limits.js";

export async function webSearchFromTool(
  search: WebSearchProvider,
  context: AdapterContext,
  args: Record<string, unknown>,
) {
  const query = String(args.query ?? "").trim();
  if (!query) return { error: "query is required" };
  try {
    const results = await search.search(
      {
        query,
        maxResults: clampMaxResults(args.maxResults),
        signal: context.signal,
      },
      context,
    );
    return { results };
  } catch (error) {
    return { error: toolErrorMessage(error) };
  }
}

export async function webFetchFromTool(
  fetchProvider: WebFetchProvider,
  context: AdapterContext,
  args: Record<string, unknown>,
) {
  const url = String(args.url ?? "").trim();
  if (!url) return { error: "url is required" };
  try {
    const result = await fetchProvider.fetch(
      {
        url,
        maxChars: clampMaxChars(args.maxChars),
        signal: context.signal,
      },
      context,
    );
    return result;
  } catch (error) {
    return { error: toolErrorMessage(error) };
  }
}

const MAX_CAUSE_CHARS = 200;

/**
 * Undici reports every network failure as a bare `fetch failed`; the reason
 * (ENOTFOUND, UND_ERR_CONNECT_TIMEOUT, …) lives on `cause`. Prefer the cause's
 * code: it names the failure without echoing request details.
 */
function toolErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause: unknown = error.cause;
  let detail = "";
  if (cause instanceof Error) {
    const code = "code" in cause ? cause.code : undefined;
    detail = typeof code === "string" && code ? code : cause.message;
  } else if (typeof cause === "string") {
    detail = cause;
  }
  detail = detail.trim().slice(0, MAX_CAUSE_CHARS);
  if (!detail || error.message.includes(detail)) return error.message;
  return `${error.message}: ${detail}`;
}
