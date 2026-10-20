/// <reference path="./linkify-it.d.ts" />
import LinkifyIt from "linkify-it";
import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useSyncExternalStore } from "react";

export type ChatMarkdownProps = {
  children: string;
  streaming?: boolean;
};

type LinkifyRules = {
  set(options: { fuzzyLink: boolean }): unknown;
  add(schema: string, definition: null): unknown;
};

type LinkifyParser = {
  set(options: { linkify: boolean }): unknown;
  linkify: LinkifyRules;
};

type ExplicitLinkMatch = {
  index: number;
  lastIndex: number;
  url: string;
};

type ExplicitLinkify = LinkifyRules & {
  match(text: string): ExplicitLinkMatch[] | null;
};

function applyExplicitLinkRules(linkify: LinkifyRules) {
  linkify.set({ fuzzyLink: false });
  linkify.add("ftp:", null);
  linkify.add("//", null);
}

/**
 * Turn bare http(s) URLs and email addresses into links, as the web renderer's GFM autolinks
 * do. Bare domains stay text: fuzzy matching would also link file names like setup.py or
 * notes.md. ftp: and protocol-relative URLs stay text because sanitizeMarkdownUrl would not
 * open them.
 */
export function linkifyExplicitUrls<T extends LinkifyParser>(parser: T): T {
  parser.set({ linkify: true });
  applyExplicitLinkRules(parser.linkify);
  return parser;
}

const plainTextLinkify: ExplicitLinkify = new LinkifyIt();
applyExplicitLinkRules(plainTextLinkify);

const protocolPattern = /^([a-z][a-z\d+.-]*):/i;
const safeProtocols = new Set(["http", "https", "mailto", "tel"]);

export type PlainTextPart =
  | { type: "text"; value: string }
  | { type: "link"; value: string; href: string };

function appendPlainText(parts: PlainTextPart[], value: string) {
  if (!value) return;
  const previous = parts.at(-1);
  if (previous?.type === "text") {
    previous.value += value;
    return;
  }
  parts.push({ type: "text", value });
}

/**
 * Split plain user-message text into literal runs and tappable links.
 * User bubbles stay plain text on web and mobile. Bold, headings, and other
 * markdown remain characters. Links use the same explicit autolinker as bot
 * messages, so a balanced parenthesis stays inside the URL and a closing
 * parenthesis that only wraps the surrounding prose does not.
 */
export function plainTextLinkParts(text: string): PlainTextPart[] {
  const matches = plainTextLinkify.match(text);
  if (!matches || matches.length === 0) return [{ type: "text", value: text }];

  const parts: PlainTextPart[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.index < cursor || match.lastIndex <= match.index) continue;
    const value = text.slice(match.index, match.lastIndex);
    const href = sanitizeMarkdownUrl(match.url);
    appendPlainText(parts, text.slice(cursor, match.index));
    if (!href) {
      appendPlainText(parts, value);
      cursor = match.lastIndex;
      continue;
    }
    parts.push({ type: "link", value, href });
    cursor = match.lastIndex;
  }

  appendPlainText(parts, text.slice(cursor));
  return parts.length > 0 ? parts : [{ type: "text", value: text }];
}

export function sanitizeMarkdownUrl(url: string, allowRelative = false): string | undefined {
  const value = url.trim();
  const protocol = value.match(protocolPattern)?.[1]?.toLowerCase();

  if (protocol) return safeProtocols.has(protocol) ? value : undefined;
  if (
    allowRelative &&
    (value.startsWith("/") ||
      value.startsWith("./") ||
      value.startsWith("../") ||
      value.startsWith("#"))
  ) {
    return value;
  }
  return undefined;
}

const httpUrlProtocols = new Set(["http:", "https:"]);

function markdownLinkBase(appOrigin?: string | null) {
  if (!appOrigin) return "https://app.invalid";
  try {
    return new URL(appOrigin).origin;
  } catch {
    return "https://app.invalid";
  }
}

export function markdownLinkRequiresConfirmation(url: string, appOrigin?: string | null): boolean {
  const value = url.trim();
  if (!value) return false;
  let parsed: URL;
  try {
    parsed = new URL(value, markdownLinkBase(appOrigin));
  } catch {
    return false;
  }
  if (!httpUrlProtocols.has(parsed.protocol)) return false;
  const explicitDestination = /^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith("//");
  if (!explicitDestination) return false;
  if (!appOrigin) return true;
  try {
    return parsed.origin !== new URL(appOrigin).origin;
  } catch {
    return true;
  }
}

export type MarkdownLinkDisplayParts = {
  before: string;
  host: string;
  after: string;
};

export function markdownLinkDisplayParts(url: string): MarkdownLinkDisplayParts | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (!httpUrlProtocols.has(parsed.protocol)) return undefined;
  const href = parsed.href;
  const authorityAt = href.indexOf("//") + 2;
  const userinfoLength =
    parsed.username || parsed.password
      ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ""}@`.length
      : 0;
  const hostAt = authorityAt + userinfoLength;
  return {
    before: href.slice(0, hostAt),
    host: parsed.host,
    after: href.slice(hostAt + parsed.host.length),
  };
}

const imageLinkProtocols = new Set(["http", "https"]);

export function sanitizeMarkdownImageUrl(url: string): string | undefined {
  const href = sanitizeMarkdownUrl(url);
  if (!href) return undefined;
  const protocol = href.match(protocolPattern)?.[1]?.toLowerCase();
  return protocol && imageLinkProtocols.has(protocol) ? href : undefined;
}

const inlineImagePattern = /^data:image\/(?:png|gif|jpe?g|webp);base64,[a-z\d+/=]+$/i;
const MAX_INLINE_IMAGE_URL_LENGTH = 1024 * 1024;

/**
 * Markdown images in bot output never fetch on their own: an image URL can carry conversation
 * data to any host the moment a reply renders. Only embedded raster data renders at once; a
 * remote image waits for the reader's tap unless they turned on loading web images.
 */
export function inlineMarkdownImageSrc(url: string): string | undefined {
  const value = url.trim();
  return value.length <= MAX_INLINE_IMAGE_URL_LENGTH && inlineImagePattern.test(value)
    ? value
    : undefined;
}

/** A markdown image that may load on request, with the host its placeholder names. */
export function remoteMarkdownImage(url: string): { href: string; host: string } | undefined {
  const href = sanitizeMarkdownImageUrl(url);
  if (!href) return undefined;
  try {
    return { href, host: new URL(href).host };
  } catch {
    return undefined;
  }
}

/** Whether remote markdown images load without a tap. Apps provide the reader's device setting. */
export const RemoteImagesContext = createContext(false);

// Images the reader chose to load stay loaded for the session, even after a bubble remounts.
const loadedRemoteImages = new Set<string>();

export function remoteImageLoaded(href: string): boolean {
  return loadedRemoteImages.has(href);
}

/** The current URL only. A link that cannot open stays text, so its image is not requested. */
export function remoteImageRenders(
  href: string,
  loadRemote: boolean,
  rejectedLink: boolean,
): boolean {
  return !rejectedLink && (loadRemote || remoteImageLoaded(href));
}

export function markRemoteImageLoaded(href: string): void {
  loadedRemoteImages.add(href);
}

const SHORT_LINK_LABEL_MAX = 40;
const SHORT_LINK_PATH_MIN = 12;
// Control and format characters (bidi overrides, zero-width joiners and spaces, the BOM) that a
// decoded path could use to disguise itself.
const HIDDEN_PATH_CHARACTERS = /[\p{Cc}\p{Cf}]/gu;

function httpUrl(href: string): URL | undefined {
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function decodedUrl(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

function comparableUrl(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

/**
 * The words a link shows. An author's label stays as written; a bare URL (an autolink, or a
 * label that just repeats the address) shortens to host and path, like `x.com/elonmusk`. The
 * host is what tells a reader where the link goes, so it is never cut and stays in its ASCII
 * (punycode) form; only a long path is trimmed.
 */
export function linkLabel(text: string, href: string): string {
  const url = httpUrl(href);
  // Some parsers show an autolink with its escapes decoded (`caf%C3%A9` as `café`), so a label
  // that matches the decoded address is bare too.
  const label = comparableUrl(text);
  if (!url || (label !== comparableUrl(href) && label !== comparableUrl(decodedUrl(href)))) {
    return text;
  }
  const host = url.host.replace(/^www\./i, "");
  const path = decodedUrl(url.pathname.replace(/\/+$/, "")).replace(HIDDEN_PATH_CHARACTERS, "");
  const room = Math.max(SHORT_LINK_LABEL_MAX - host.length, SHORT_LINK_PATH_MIN);
  return path.length > room ? `${host}${path.slice(0, room - 1)}…` : `${host}${path}`;
}

/** The origin a link's site icon is looked up by, or undefined for links that get no icon. */
export function linkFaviconOrigin(href: string): string | undefined {
  return httpUrl(href)?.origin;
}

/**
 * Where link icons come from. Apps load them through the Rakazo API, which fetches and caches
 * them, so a device never contacts the linked site or an icon service. `globe` is the native
 * fallback glyph; web draws its own.
 */
export type LinkFavicons = {
  /** Cache scope for the API serving these answers. */
  endpoint?: string;
  /** `retry` means the server was too busy to look, not that the site has no icon. */
  load(origin: string): Promise<{ icon: string | null; retry?: boolean }>;
  globe?: ReactNode;
};

export const LinkFaviconsContext = createContext<LinkFavicons | null>(null);

/** True while a reply streams: a half-written autolink host must not be looked up. */
export const LinkFaviconsPausedContext = createContext(false);

// One answer per API endpoint and origin for the session, shared by links on screen.
const linkFavicons = new Map<string, string | null>();
const pendingFavicons = new Set<string>();
// A failed lookup (an older server without the procedure, or no connection) is not asked again
// by every link that mounts, but is retried after a while so a brief outage does not last all day.
const FAILED_FAVICON_RETRY_MS = 5 * 60 * 1000;
const failedFavicons = new Map<string, number>();
// A busy server is asked again a few times, a little later, while the link stays on screen.
const BUSY_FAVICON_RETRY_MS = 10_000;
const BUSY_FAVICON_ATTEMPTS = 3;
const busyFaviconRetries = new Map<string, ReturnType<typeof setTimeout>>();
// How many links to each origin are on screen; a busy retry stops once none are.
const mountedFaviconLinks = new Map<string, number>();
const faviconListeners = new Set<() => void>();

function setLinkFavicon(origin: string, icon: string | null) {
  linkFavicons.set(origin, icon);
  for (const listener of faviconListeners) listener();
}

function subscribeLinkFavicons(listener: () => void) {
  faviconListeners.add(listener);
  return () => {
    faviconListeners.delete(listener);
  };
}

/** The origin stays pending across busy retries, so links that mount meanwhile do not ask too. */
function requestLinkFavicon(source: LinkFavicons, origin: string, key: string, attempt: number) {
  pendingFavicons.add(key);
  source.load(origin).then(
    (answer) => {
      const shown = mountedFaviconLinks.has(key);
      if (answer.retry && shown && attempt < BUSY_FAVICON_ATTEMPTS) {
        const retry = () => {
          busyFaviconRetries.delete(key);
          requestLinkFavicon(source, origin, key, attempt + 1);
        };
        busyFaviconRetries.set(key, setTimeout(retry, BUSY_FAVICON_RETRY_MS));
        return;
      }
      pendingFavicons.delete(key);
      // A busy answer for links no longer on screen is dropped; the next one to mount asks.
      if (answer.retry && shown) failedFavicons.set(key, Date.now());
      else if (!answer.retry) setLinkFavicon(key, answer.icon);
    },
    () => {
      pendingFavicons.delete(key);
      failedFavicons.set(key, Date.now());
    },
  );
}

/** The icon for a link once the API has one, and a way to drop an image that turns out unusable. */
export function useLinkFavicon(href: string): { icon: string | null; unusable: () => void } {
  const source = useContext(LinkFaviconsContext);
  const paused = useContext(LinkFaviconsPausedContext);
  const origin = linkFaviconOrigin(href);
  const key = JSON.stringify([source?.endpoint ?? "", origin]);
  const snapshot = () => (origin ? (linkFavicons.get(key) ?? null) : null);
  const icon = useSyncExternalStore(subscribeLinkFavicons, snapshot, snapshot);
  useEffect(() => {
    if (!origin) return;
    mountedFaviconLinks.set(key, (mountedFaviconLinks.get(key) ?? 0) + 1);
    return () => {
      const left = (mountedFaviconLinks.get(key) ?? 1) - 1;
      if (left > 0) {
        mountedFaviconLinks.set(key, left);
        return;
      }
      mountedFaviconLinks.delete(key);
      const retry = busyFaviconRetries.get(key);
      if (retry === undefined) return;
      clearTimeout(retry);
      busyFaviconRetries.delete(key);
      pendingFavicons.delete(key);
    };
  }, [key, origin]);
  useEffect(() => {
    if (!source || paused || !origin) return;
    if (linkFavicons.has(key) || pendingFavicons.has(key)) return;
    if (Date.now() - (failedFavicons.get(key) ?? -Infinity) < FAILED_FAVICON_RETRY_MS) return;
    requestLinkFavicon(source, origin, key, 1);
  }, [source, paused, origin, key]);
  return {
    icon,
    unusable: () => {
      if (origin) setLinkFavicon(key, null);
    },
  };
}

export function closeUnterminatedFence(markdown: string): string {
  let openFence: { marker: "`" | "~"; length: number } | undefined;

  for (const line of markdown.split("\n")) {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!match?.[1]) continue;

    const marker = match[1][0] as "`" | "~";
    if (!openFence) {
      openFence = { marker, length: match[1].length };
      continue;
    }

    if (
      marker === openFence.marker &&
      match[1].length >= openFence.length &&
      (match[2] ?? "").trim() === ""
    ) {
      openFence = undefined;
    }
  }

  return openFence ? `${markdown}\n${openFence.marker.repeat(openFence.length)}` : markdown;
}

/** A bot that `@Name` in message text refers to, with its avatar colour for each theme. */
export type MentionBot = {
  id: string;
  /** Display name, plus any handle the mention system accepts. */
  names: readonly string[];
  color: { onLight: string; onDark: string };
};

/** The bots the reader can see. Apps provide the space's bots; empty leaves mentions plain. */
export const MentionBotsContext = createContext<readonly MentionBot[]>([]);

/**
 * Opens a mentioned bot's 1:1 chat. Apps that route provide it with a localized
 * label; without it a mention stays plain coloured text.
 */
export type MentionOpenBot = {
  onOpenBot: (botId: string) => void;
  /** Accessible name for the mention, e.g. "Open chat with Quinn". */
  label: (botName: string) => string;
};

export const MentionOpenBotContext = createContext<MentionOpenBot | null>(null);

/** True while the reader has text selected, so a drag-select over a mention does not open it. */
export function hasTextSelection(): boolean {
  const selection = typeof window === "undefined" ? null : window.getSelection?.();
  return Boolean(selection && !selection.isCollapsed && selection.toString().length > 0);
}

export type MentionPart =
  | { type: "text"; value: string }
  | { type: "mention"; value: string; bot: MentionBot };

type MentionNames = { names: readonly string[]; byName: Map<string, MentionBot> };

const mentionNameCache = new WeakMap<readonly MentionBot[], MentionNames>();

function mentionNames(bots: readonly MentionBot[]): MentionNames {
  const cached = mentionNameCache.get(bots);
  if (cached) return cached;
  const byName = new Map<string, MentionBot>();
  for (const bot of bots) {
    for (const name of bot.names) {
      const key = name.trim().toLowerCase();
      if (key && !byName.has(key)) byName.set(key, bot);
    }
  }
  // Longest first, so "Super Forms Bot" wins over "Super".
  const names = [...byName.keys()].sort((a, b) => b.length - a.length);
  const result = { names, byName };
  mentionNameCache.set(bots, result);
  return result;
}

function isWordChar(char: string | undefined) {
  if (!char) return false;
  return /[0-9_]/.test(char) || char.toLowerCase() !== char.toUpperCase();
}

/** The index just past a code span opening at `start`, or undefined when the run never closes. */
function codeSpanEnd(text: string, start: number): number | undefined {
  let run = 0;
  while (text[start + run] === "`") run += 1;
  const fence = "`".repeat(run);
  let close = text.indexOf(fence, start + run);
  while (close !== -1) {
    let closeRun = 0;
    while (text[close + closeRun] === "`") closeRun += 1;
    if (closeRun === run) return close + run;
    close = text.indexOf(fence, close + closeRun);
  }
  return undefined;
}

/**
 * Split message text into literal runs and `@Name` mentions of known bots. Names match without
 * regard to case, longest first, and only as whole words; `a@quinn.com` and code spans stay text.
 */
export function mentionParts(text: string, bots: readonly MentionBot[]): MentionPart[] {
  if (!text.includes("@") || bots.length === 0) return [{ type: "text", value: text }];
  const { names, byName } = mentionNames(bots);
  const parts: MentionPart[] = [];
  let last = 0;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "`") {
      const end = codeSpanEnd(text, index);
      if (end !== undefined) {
        index = end;
        continue;
      }
      while (text[index] === "`") index += 1;
      continue;
    }
    if (char === "@" && !isWordChar(text[index - 1])) {
      const name = names.find((candidate) => {
        const end = index + 1 + candidate.length;
        return text.slice(index + 1, end).toLowerCase() === candidate && !isWordChar(text[end]);
      });
      const bot = name ? byName.get(name) : undefined;
      if (name && bot) {
        const end = index + 1 + name.length;
        if (index > last) parts.push({ type: "text", value: text.slice(last, index) });
        parts.push({ type: "mention", value: text.slice(index, end), bot });
        last = end;
        index = end;
        continue;
      }
    }
    index += 1;
  }
  if (last < text.length || parts.length === 0) {
    parts.push({ type: "text", value: text.slice(last) });
  }
  return parts;
}

/**
 * The deployment's reference links, each a URL with `{n}` where the number goes:
 * `case` (`RAKAZO_CASE_LINK_URL`) for "case 174", `zendesk` (`RAKAZO_ZENDESK_LINK_URL`) for
 * "ZD #3529". Apps provide them from `me`; a missing one leaves its references as text.
 */
export type ReferenceLinks = { case?: string | null; zendesk?: string | null };

export const ReferenceLinksContext = createContext<ReferenceLinks>({});

export type ReferenceLinkPart =
  | { type: "text"; value: string }
  | { type: "reference"; value: string; href: string };

// "case 174", "Case #174", "ZD 3529", "zd #3529", "Zendesk #3529", "Zendesk ticket #3529", or a
// bare "#174" (group 3). Left to right, so the "#174" of "case #174" is part of that one match.
const REFERENCE = /(case|zd|zendesk(?:[^\S\r\n]+ticket)?)[^\S\r\n]+#?(\d+)|#(\d+)/giu;

// A bare "#N" right after one of these words (same line, spaces between) is a pull request, a
// Zendesk ticket or a position in a list, not a case: "PR #12", "pull request #12", "step #2".
const NOT_A_CASE_BEFORE =
  /(?<![\p{L}\p{N}_])(?:pull[^\S\r\n]+requests?|pulls?|prs?|mrs?|zd|zendesk|tickets?|step|option|item|line|no|nr|number|page|comment|version|v)\.?[^\S\r\n]*$/iu;

// The text before a bare "#N" ends inside a URL: "https://x.test/issues/1#12", "www.x.test/#3".
const URL_BEFORE = /(?:\/\/|www\.)\S*$/iu;

/** Code spans in `text` as [start, end) ranges; a run of backticks that never closes is text. */
function codeSpanRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  let index = text.indexOf("`");
  while (index !== -1) {
    const end = codeSpanEnd(text, index);
    if (end !== undefined) {
      ranges.push([index, end]);
      index = text.indexOf("`", end);
      continue;
    }
    while (text[index] === "`") index += 1;
    index = text.indexOf("`", index);
  }
  return ranges;
}

/** The link for reference `number`, or undefined when the template is not an http(s) URL with `{n}`. */
export function referenceLinkHref(template: string, number: string): string | undefined {
  if (!template.includes("{n}")) return undefined;
  const href = sanitizeMarkdownUrl(template.replaceAll("{n}", number));
  return href && httpUrl(href) ? href : undefined;
}

/**
 * Split message text into literal runs and "case 174" / "ZD #3529" references linked through
 * the deployment's templates. Only whole words before a number count: "cases 12", "showcase 5"
 * and code spans stay text, and so does a reference whose template is not set. A bare "#174"
 * links through the case template too, except after "PR", "pull (request)", "MR", "ZD",
 * "Zendesk", "ticket" or a list word such as "step", "option", "no", "v" on the same line, when
 * glued to a word or "/" ("super-forms#12", "owner/repo#12"), inside a URL, or with more than
 * six digits.
 */
export function referenceLinkParts(text: string, links: ReferenceLinks): ReferenceLinkPart[] {
  if ((!links.case && !links.zendesk) || !/case|zd|zendesk|#\d/i.test(text)) {
    return [{ type: "text", value: text }];
  }
  const code = text.includes("`") ? codeSpanRanges(text) : [];
  const parts: ReferenceLinkPart[] = [];
  let last = 0;
  for (const match of text.matchAll(REFERENCE)) {
    const start = match.index;
    const end = start + match[0].length;
    const bare = match[3];
    const template = bare || match[1]?.toLowerCase() === "case" ? links.case : links.zendesk;
    // "case 1.5" is a decimal, not case 1.
    const decimal = /^[.,]\d/.test(text.slice(end, end + 2));
    if (isWordChar(text[start - 1]) || isWordChar(text[end]) || decimal) continue;
    if (bare) {
      if (!template || bare.length > 6 || text[start - 1] === "/") continue;
      const before = text.slice(text.lastIndexOf("\n", start - 1) + 1, start);
      if (NOT_A_CASE_BEFORE.test(before) || URL_BEFORE.test(before)) continue;
    }
    if (code.some(([from, to]) => start >= from && start < to)) continue;
    const href = template ? referenceLinkHref(template, match[2] ?? bare ?? "") : undefined;
    if (!href) continue;
    if (start > last) parts.push({ type: "text", value: text.slice(last, start) });
    parts.push({ type: "reference", value: match[0], href });
    last = end;
  }
  if (last < text.length || parts.length === 0) {
    parts.push({ type: "text", value: text.slice(last) });
  }
  return parts;
}
