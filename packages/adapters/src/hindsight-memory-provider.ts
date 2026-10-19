import type {
  AdapterContext,
  SemanticMemoryForgetRequest,
  SemanticMemoryForgetResponse,
  SemanticMemoryProvider,
  SemanticMemoryPurgeHistoryRequest,
  SemanticMemoryRecallRequest,
  SemanticMemoryResponse,
  SemanticMemoryResult,
  SemanticMemorySaveRequest,
} from "@rakazo/adapter-kit";
import type { ResolveHostname } from "./network-address.js";
import { assertSupermemoryLocalBaseUrl } from "./supermemory-memory-provider.js";

export const HINDSIGHT_PROVIDER_ID = "hindsight";
export const HINDSIGHT_DEFAULT_BANKS = ["fleet", "knowledge", "public"] as const;
export const HINDSIGHT_DEFAULT_EXCLUDE_TAGS = ["pii:person", "embargo:security"] as const;
export const HINDSIGHT_RECALL_TIMEOUT_MS = 8_000;
export const HINDSIGHT_SAVE_REFUSAL =
  "Saving to shared memory through the memory provider is disabled. Use memory_save (fleet MCP).";
/** Injected into the run instead of recalled memory when Hindsight times out or fails. */
export const HINDSIGHT_UNAVAILABLE_NOTICE =
  "Shared memory is unavailable right now; say so if it matters";

export interface HindsightConnectionConfig {
  baseUrl: string;
  apiKey: string;
  banks: string[];
  excludeTags: string[];
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** Minimum number of results returned per recall; the run's limit wins when larger. */
  recallLimit?: number;
}

/** Hindsight sits on a private address, so every connection needs the deployment owner. */
export function hindsightRequiresDeploymentOwner(): boolean {
  return true;
}

function parseList(value: string | undefined, fallback: readonly string[]): string[] {
  if (value === undefined || !value.trim()) return [...fallback];
  const items = [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
  return items.length > 0 ? items : [...fallback];
}

function parseHindsightBaseUrl(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) throw new Error("baseUrl is required");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("baseUrl must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("baseUrl must use http or https");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("baseUrl must not contain credentials, a query or a fragment");
  }
  return url.toString().replace(/\/+$/, "");
}

function parseHindsightConnection(
  settings: Record<string, string>,
  credentials: Record<string, string>,
): HindsightConnectionConfig {
  const apiKey = credentials.apiKey?.trim();
  if (!apiKey) throw new Error("apiKey is required");
  if (apiKey.length < 8) throw new Error("apiKey must contain at least 8 characters");
  return {
    baseUrl: parseHindsightBaseUrl(settings.baseUrl),
    apiKey,
    banks: parseList(settings.banks, HINDSIGHT_DEFAULT_BANKS),
    excludeTags: parseList(settings.excludeTags, HINDSIGHT_DEFAULT_EXCLUDE_TAGS),
    recallLimit: parseRecallLimit(settings.recallLimit),
  };
}

export const HINDSIGHT_DEFAULT_RECALL_LIMIT = 8;

function parseRecallLimit(value: string | undefined): number {
  const raw = value?.trim();
  if (!raw) return HINDSIGHT_DEFAULT_RECALL_LIMIT;
  if (!/^\d+$/.test(raw)) throw new Error("recallLimit must be a whole number");
  const parsed = Number(raw);
  if (parsed < 1 || parsed > 50) throw new Error("recallLimit must be between 1 and 50");
  return parsed;
}

/** Takes results bank by bank in the configured order so every bank gets a fair share. */
export function mergeRoundRobin<T>(perBank: readonly (readonly T[])[], limit: number): T[] {
  const merged: T[] = [];
  const longest = Math.max(0, ...perBank.map((results) => results.length));
  for (let rank = 0; rank < longest && merged.length < limit; rank++) {
    for (const results of perBank) {
      if (merged.length >= limit) break;
      const item = results[rank];
      if (item !== undefined) merged.push(item);
    }
  }
  return merged;
}

function storedSettings(connection: HindsightConnectionConfig): Record<string, string> {
  return {
    baseUrl: connection.baseUrl,
    banks: connection.banks.join(","),
    excludeTags: connection.excludeTags.join(","),
    recallLimit: String(connection.recallLimit ?? HINDSIGHT_DEFAULT_RECALL_LIMIT),
  };
}

export async function prepareHindsightConnection(
  settings: Record<string, string>,
  credentials: Record<string, string>,
  options?: {
    allowPrivateEndpoint?: boolean;
    resolveHostname?: ResolveHostname;
    fetch?: typeof globalThis.fetch;
  },
): Promise<{ settings: Record<string, string>; credentials: Record<string, string> }> {
  const connection = parseHindsightConnection(settings, credentials);
  // Same private-address check as Supermemory local mode.
  await assertSupermemoryLocalBaseUrl(connection.baseUrl, options);
  const fetchImpl = options?.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${connection.baseUrl}/v1/default/banks`, {
      method: "GET",
      headers: { authorization: `Bearer ${connection.apiKey}` },
      redirect: "error",
      signal: AbortSignal.timeout(HINDSIGHT_RECALL_TIMEOUT_MS),
    });
  } catch {
    throw new Error("Could not reach Hindsight at the base URL.");
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error("Hindsight rejected the API key.");
  }
  if (!response.ok) throw new Error(`Hindsight answered HTTP ${response.status}.`);
  return { settings: storedSettings(connection), credentials: { apiKey: connection.apiKey } };
}

export function createHindsightProvider(
  settings: Record<string, string>,
  credentials: Record<string, string>,
): SemanticMemoryProvider {
  return new HindsightMemoryProvider(parseHindsightConnection(settings, credentials));
}

interface HindsightRecallItem {
  id?: unknown;
  text?: unknown;
  score?: unknown;
  occurred_start?: unknown;
  mentioned_at?: unknown;
}

/** Hindsight ranks results; a missing score falls back to the rank within its bank. */
function toResults(bank: string, body: unknown): SemanticMemoryResult[] {
  const results =
    body && typeof body === "object" && "results" in body && Array.isArray(body.results)
      ? body.results
      : [];
  // Response JSON from Hindsight; every field is checked before use below.
  const items: (HindsightRecallItem | null)[] = results;
  return items.flatMap((item, index) => {
    if (!item || typeof item.text !== "string" || !item.text.trim()) return [];
    const updatedAt =
      typeof item.mentioned_at === "string"
        ? item.mentioned_at
        : typeof item.occurred_start === "string"
          ? item.occurred_start
          : undefined;
    return [
      {
        memory: item.text,
        score:
          typeof item.score === "number" && Number.isFinite(item.score)
            ? item.score
            : 1 / (index + 1),
        entity: bank,
        ...(typeof item.id === "string" ? { id: item.id } : {}),
        ...(updatedAt ? { updatedAt } : {}),
      },
    ];
  });
}

export class HindsightMemoryProvider implements SemanticMemoryProvider {
  constructor(private readonly connection: HindsightConnectionConfig) {}

  describe() {
    return {
      id: HINDSIGHT_PROVIDER_ID,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        recall: true,
        save: false,
        purgeHistory: false,
        sharedScope: true,
      } as const,
    };
  }

  /** Request body for one bank. Every recall excludes the configured tags. */
  recallBody(query: string): Record<string, unknown> {
    return {
      query,
      tag_groups: [{ not: { tags: this.connection.excludeTags, match: "any_strict" } }],
    };
  }

  private async recallBank(
    bank: string,
    query: string,
    signal: AbortSignal,
  ): Promise<SemanticMemoryResult[]> {
    const fetchImpl = this.connection.fetch ?? globalThis.fetch;
    const response = await fetchImpl(
      `${this.connection.baseUrl}/v1/default/banks/${encodeURIComponent(bank)}/memories/recall`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.connection.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(this.recallBody(query)),
        redirect: "error",
        signal,
      },
    );
    if (!response.ok)
      throw new Error(`Hindsight recall from ${bank} failed: HTTP ${response.status}`);
    return toResults(bank, await response.json());
  }

  async recall(
    request: SemanticMemoryRecallRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse<SemanticMemoryResult[]>> {
    const timeoutMs = this.connection.timeoutMs ?? HINDSIGHT_RECALL_TIMEOUT_MS;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([context.signal, timeout]);
    const work = Promise.all(
      this.connection.banks.map((bank) => this.recallBank(bank, request.query, signal)),
    );
    // A fetch that ignores the signal must not hold the run past the timeout either.
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    });
    try {
      const perBank = await Promise.race([work, deadline]);
      const limit = Math.max(
        0,
        request.limit,
        this.connection.recallLimit ?? HINDSIGHT_DEFAULT_RECALL_LIMIT,
      );
      const merged = mergeRoundRobin(perBank, limit);
      return { ok: true, value: merged };
    } catch (error) {
      work.catch(() => undefined);
      if (timeout.aborted || (error instanceof Error && error.message === "timeout")) {
        return { ok: false, error: `Hindsight recall timed out after ${timeoutMs} ms` };
      }
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Hindsight recall failed",
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async save(
    _request: SemanticMemorySaveRequest,
    _context: AdapterContext,
  ): Promise<SemanticMemoryResponse> {
    return { ok: false, error: HINDSIGHT_SAVE_REFUSAL };
  }

  async purgeHistory(
    _request: SemanticMemoryPurgeHistoryRequest,
    _context: AdapterContext,
  ): Promise<SemanticMemoryResponse> {
    return { ok: false, error: HINDSIGHT_SAVE_REFUSAL };
  }

  async forget(
    _request: SemanticMemoryForgetRequest,
    _context: AdapterContext,
  ): Promise<SemanticMemoryForgetResponse> {
    return { ok: false, error: HINDSIGHT_SAVE_REFUSAL };
  }
}
