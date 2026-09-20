import { Buffer } from "node:buffer";
import { lookup as dnsLookup } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import {
  defaultSettings,
  loopbackHost,
  webAddress,
  type Settings,
} from "../../core/schema";
import { scanText } from "../../core/sanitize";
import {
  TOOL_LIMITS,
  type ProviderResult,
  type ProviderState,
  type ToolPrepared,
  type ToolQuestion,
  type ToolSpec,
  type ToolTier,
  type ToolWords,
} from "../../core/tools";
import type { LocalProviderOptions, LocalServer } from "../local";
import type { McpProvider } from "../mcp";

/**
 * The web page text tool: two builtin read tools that fetch one page by GET
 * and hand the model its text whole, run in the app's own process. It exists
 * because a page to be read in full, counted over or compared with another
 * is one call here and a loop on screen: in probe 20260919-2257-efdc2a8
 * (STUCK_LOOP, autonomy all, gpt-5.4-mini) research-paginated-listing #1
 * (19 actions) and research-compare-to-csv #1 (18 actions) each ended
 * STUCK_LOOP with noteRoute none and every fact missing (count and
 * cheapestId; vendor1..3), the shape click_control ×8 with ActionLoopDetected
 * period 2 (the model paging back and forth between two controls), a
 * reflection, the same again; every frame was read whole (textTruncated
 * null on all 37 frames, 50–116 text nodes in 3–8 ms) and every click by
 * name registered effect changed, so neither reading nor clicking failed:
 * the aggregate across pages is what a frame-by-frame loop does badly, and
 * the pages are plain HTML the runner can read in one call. Tools first, the
 * screen as fallback (docs/TOOLS.md).
 *
 * What it reaches: one http or https address at a time, by GET, with a fixed
 * User-Agent naming Butler and no other header (no cookies, no credentials,
 * no Accept-Encoding), following at most WEB_LIMITS.redirects redirects on
 * the same host, within WEB_LIMITS.timeoutMs, a text/html or text/plain
 * response of at most WEB_LIMITS.responseBytes. What it never reaches: a
 * host on the user's protected-websites list (the floor open_url has, as a
 * fixed RETRY), an address with credentials or another scheme, and any
 * address on this Mac or a private network (loopback, RFC 1918, link-local,
 * CGNAT, multicast, .local and bare names, checked on the name and again on
 * every address DNS returns), except an origin the registry names in
 * LocalProviderOptions.loopbackOrigins: the bench names its fixture server,
 * the app names none.
 *
 * What comes back: the page's readable text, script, style, nav and hidden
 * elements gone, headings as "## Heading", list items as "- item", table
 * rows as one line with cells joined by " | ", links as their text with the
 * address in parentheses when it is not the text itself (the address, so a
 * "Next page" or "Details" link can be read next), capped at maxChars with
 * WEB_TEXT_CUT_MARKER as its last line when cut, behind one facts line
 * (title, host, characters, whether cut). The text passes the registry's
 * sanitizeResult (invisible characters, credential redaction) like every
 * result, and a credential finding in it (scanText BLOCK_UPLOAD) drops the
 * whole result with CREDENTIAL, as the files tool does with what it writes.
 * The trace (WebPageRead) carries the tool, the outcome, the response size
 * and the registrable domain alone: never the path.
 *
 * Under PRIVATE_LOCAL the fetch is a local act (no model is involved in it),
 * so the tool lists there as the files tool does; the page's text then goes
 * to the configured model as part of the step like any tool result, which is
 * where the same text goes today off the screen.
 */
export const WEB_ID = "web";
export const WEB_TITLE = "Web";
/** The one header the fetch sends beside what Node adds (Host, Connection). */
export const WEB_USER_AGENT = "Butler/1 (macOS; reads one page for its user)";
/** The last line of a page text maxChars cut short. */
export const WEB_TEXT_CUT_MARKER =
  "[page text cut at maxChars; the rest was not read]";
export const WEB_LIMITS = {
  /** maxChars when the call does not say. */
  defaultChars: 12_000,
  /** The most a call may ask for; a larger maxChars is clamped to it. */
  maxChars: 30_000,
  /** The least; a smaller maxChars is raised to it. */
  minChars: 200,
  /** A response body larger than this is refused, not cut. */
  responseBytes: 2 * 1024 * 1024,
  /** The whole fetch, redirects included. */
  timeoutMs: 10_000,
  /** Redirects followed, on the same host only. */
  redirects: 3,
  /** An address longer than this is refused. */
  urlChars: 2048,
  /** The facts line and the text at its cap: what the registry lets the model read (ToolSpec.resultChars). */
  resultChars: 30_400,
  /** A title is bounded before it becomes a fact. */
  titleChars: 200,
  /** A shown link address is bounded. */
  hrefChars: 200,
} as const;

export type WebToolName = "read_page_text" | "read_current_page";
export interface WebTool {
  does: string;
  params: string;
  tier: ToolTier;
  keys: readonly string[];
  required: readonly string[];
}
export const WEB_TOOLS: Record<WebToolName, WebTool> = {
  read_page_text: {
    does: "Reads a public web page at an http(s) address and returns its whole text: headings, list items, table rows (cells joined by |), links with addresses; up to maxChars. To read, count or compare pages.",
    params:
      "url (text, a full http or https address), maxChars? (integer, 200-30000, default 12000)",
    tier: "read",
    keys: ["url", "maxChars"],
    required: ["url"],
  },
  read_current_page: {
    does: "Reads the whole text of the web page in front (the browser's current address) the same way, not just the visible part; up to maxChars.",
    params: "maxChars? (integer, 200-30000, default 12000)",
    tier: "read",
    keys: ["maxChars"],
    required: [],
  },
};
export const WEB_TOOL_NAMES = Object.keys(WEB_TOOLS) as WebToolName[];
export const WEB_TOOL_IDS = WEB_TOOL_NAMES.map((n) => `${WEB_ID}__${n}`);

// MARK: addresses

export type UrlProblem = "BAD_URL" | "PROTECTED_SITE" | "LOCAL_ADDRESS";
export interface WebTarget {
  url: URL;
  /** The hostname as the address wrote it, lowercased by the URL parser. */
  host: string;
}
export interface AddressRules {
  /** settings.protectedDomains: a host equal to one or under it is refused. */
  protectedDomains: readonly string[];
  /** Origins on this Mac a read may reach although they are loopback. */
  loopbackOrigins: readonly string[];
}
const CONTROL = /[\u0000-\u001f\u007f]/;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
/** A host (with an optional port) and then a path, a query or nothing: what an address without a scheme looks like. */
const BARE_ADDRESS = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?(?:[/?#]|$)/i;
/**
 * The address with a scheme: as written when it has one, else http for a
 * loopback or private host and https for any other, since the bench's
 * instructions write their site as "127.0.0.1:47831/<token>" (siteOf) and a
 * model copies it as written.
 */
export function normalizeAddress(value: string): string {
  const text = value.trim();
  if (HAS_SCHEME.test(text)) return text;
  const bare = BARE_ADDRESS.exec(text);
  if (!bare) return text;
  const host = bare[1].replace(/^\[|\]$/g, "");
  return `${privateAddress(host) ? "http" : "https"}://${text}`;
}
/** Whether a host is on the protected-websites list: equal to an entry or under it (policy.ts protectedHost). */
export function protectedHost(
  host: string,
  protectedDomains: readonly string[],
): boolean {
  const h = host.toLowerCase();
  return protectedDomains.some((d) => {
    const domain = d.toLowerCase();
    return h === domain || h.endsWith("." + domain);
  });
}
const privateV4 = ([a, b]: number[]): boolean =>
  a === 0 ||
  a === 10 ||
  a === 127 ||
  (a === 100 && b >= 64 && b <= 127) ||
  (a === 169 && b === 254) ||
  (a === 172 && b >= 16 && b <= 31) ||
  (a === 192 && b === 168) ||
  a >= 224;
const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
/**
 * Whether a host names this Mac or a private network, by its name or its
 * literal address: loopback (schema.ts loopbackHost), a bare name with no
 * dot (it resolves on this network alone), .local, .localhost, .internal,
 * .lan, .intranet and .home.arpa names, and the IPv4 ranges 0/8, 10/8,
 * 100.64/10 (CGNAT), 127/8, 169.254/16 (link-local), 172.16/12, 192.168/16
 * and 224/3 (multicast and reserved); for IPv6 the unspecified and loopback
 * addresses, fc00::/7 and fe80::/10, and a mapped IPv4 by its IPv4. The
 * same test runs on every address DNS returns for a public name, so a name
 * that resolves inward is refused too.
 */
export function privateAddress(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (!host) return true;
  if (loopbackHost(host)) return true;
  const v4 = V4.exec(host);
  if (v4) return privateV4(v4.slice(1).map(Number));
  if (host.includes(":")) {
    if (host === "::" || host === "::1") return true;
    const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
    if (mapped) return privateAddress(mapped[1]);
    // The URL parser writes a mapped IPv4 in hex ("::ffff:7f00:1").
    const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
    if (hexMapped) {
      const high = parseInt(hexMapped[1], 16);
      const low = parseInt(hexMapped[2], 16);
      return privateV4([high >> 8, high & 0xff, low >> 8, low & 0xff]);
    }
    return /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host);
  }
  if (!host.includes(".")) return true;
  return /\.(?:localhost|local|internal|lan|intranet|home\.arpa)$/.test(host);
}
/**
 * The address the tool may read, or the problem with it: a string of at
 * most WEB_LIMITS.urlChars with no control character that webAddress
 * accepts (http or https, a host, no credentials), whose host is not
 * protected and not on this Mac or a private network unless its origin is
 * one the registry allows. Pure; call time applies the same rules to every
 * redirect and, through the guarded lookup, to what DNS answers.
 */
export function webTarget(
  value: unknown,
  rules: AddressRules,
): WebTarget | { problem: UrlProblem } {
  if (typeof value !== "string") return { problem: "BAD_URL" };
  if (
    !value.trim() ||
    value.length > WEB_LIMITS.urlChars ||
    CONTROL.test(value)
  )
    return { problem: "BAD_URL" };
  const url = webAddress(normalizeAddress(value));
  if (!url) return { problem: "BAD_URL" };
  return judgeUrl(url, rules);
}
/** The rules over a parsed address (a redirect's target). */
export function judgeUrl(
  url: URL,
  rules: AddressRules,
): WebTarget | { problem: UrlProblem } {
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return { problem: "BAD_URL" };
  if (!url.hostname || url.username || url.password)
    return { problem: "BAD_URL" };
  if (protectedHost(url.hostname, rules.protectedDomains))
    return { problem: "PROTECTED_SITE" };
  if (
    privateAddress(url.hostname) &&
    !rules.loopbackOrigins.includes(url.origin)
  )
    return { problem: "LOCAL_ADDRESS" };
  return { url, host: url.hostname };
}
/**
 * The host as a trace may carry it: the registrable domain of a name (the
 * last two labels, or three under a two-letter country code with a short
 * second level: "bbc.co.uk"), or a fixed word for a literal address
 * (loopback, private, ip). Never the whole host, never the path.
 */
export function traceHost(hostname: string): string {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (V4.test(host) || host.includes(":"))
    return loopbackHost(host)
      ? "loopback"
      : privateAddress(host)
        ? "private"
        : "ip";
  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const tld = labels[labels.length - 1];
  const second = labels[labels.length - 2];
  const take = tld.length === 2 && second.length <= 3 ? 3 : 2;
  return labels.slice(-take).join(".");
}

// MARK: HTML to text

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  copy: "©",
  reg: "®",
  trade: "™",
  laquo: "«",
  raquo: "»",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  sbquo: "‚",
  bdquo: "„",
  middot: "·",
  bull: "•",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  deg: "°",
  times: "×",
  divide: "÷",
  minus: "−",
  plusmn: "±",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  larr: "←",
  rarr: "→",
  uarr: "↑",
  darr: "↓",
  hearts: "♥",
  check: "✓",
  sect: "§",
  para: "¶",
  shy: "",
  zwj: "",
  zwnj: "",
};
/** Named, decimal and hexadecimal character references decoded; an unknown name stays as written. */
export function decodeEntities(text: string): string {
  return text.replace(
    /&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g,
    (whole, body: string) => {
      if (body[0] === "#") {
        const hex = body[1] === "x" || body[1] === "X";
        const point = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
        if (
          !Number.isFinite(point) ||
          point <= 0 ||
          point > 0x10ffff ||
          (point >= 0xd800 && point <= 0xdfff)
        )
          return "";
        return String.fromCodePoint(point);
      }
      const named = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()];
      return named === undefined ? whole : named;
    },
  );
}
/** Elements dropped with everything inside them: code, styling, the head (and a title outside one), navigation and embedded content. */
const DROPPED =
  /<(script|style|noscript|template|svg|math|iframe|object|embed|nav|head|title|select)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const COMMENT = /<!--[\s\S]*?-->/g;
const TOKEN =
  /<\/?([A-Za-z][\w:-]*)\b([^>]*)>|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[^>]*>|([^<]+)/g;
const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);
/** Elements that start and end a line of their own. */
const BLOCK = new Set([
  "p",
  "div",
  "section",
  "article",
  "main",
  "blockquote",
  "pre",
  "address",
  "figure",
  "figcaption",
  "details",
  "summary",
  "fieldset",
  "legend",
  "dl",
  "dt",
  "dd",
  "form",
  "header",
  "footer",
  "aside",
  "center",
  "caption",
  "body",
  "html",
  "hr",
  "menu",
  "dialog",
  "label",
]);
const HEADING = /^h([1-6])$/;
const squash = (text: string) => text.replace(/\s+/g, " ").trim();
const attr = (attrs: string, name: string): string | undefined => {
  const m = new RegExp(
    `(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`,
    "i",
  ).exec(attrs);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
};
const hasAttr = (attrs: string, name: string): boolean =>
  new RegExp(`(?:^|\\s)${name}(?:\\s|=|$)`, "i").test(attrs);
/**
 * A link's address as the text shows it: resolved against the page, http or
 * https only, the fragment dropped; the path and query alone when it is on
 * the page's own origin, the whole address otherwise. Nothing for another
 * scheme (mailto, javascript, data) or a fragment-only link.
 */
export function shownHref(
  href: string | undefined,
  base: URL | undefined,
): string | undefined {
  if (!href) return undefined;
  const raw = decodeEntities(href).trim();
  if (!raw || raw.startsWith("#")) return undefined;
  let url: URL;
  try {
    url = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  url.hash = "";
  const shown =
    base && url.origin === base.origin ? url.pathname + url.search : url.href;
  return shown.slice(0, WEB_LIMITS.hrefChars);
}
export interface PageText {
  title: string;
  text: string;
}
/**
 * A minimal HTML-to-text in TypeScript (no dependency): the title from
 * <title>; script, style, noscript, template, svg, math, iframe, object,
 * embed, nav, head and select gone with their contents, as is anything
 * hidden or aria-hidden; comments, doctypes and processing instructions
 * gone; each heading, paragraph, list item, table row, division and other
 * block on a line of its own; headings marked "#"×level, list items "- "
 * (or "1. " in an ordered list), table cells joined by " | "; a link's text
 * followed by its address in parentheses when the address is not the text;
 * an image's alt text; character references decoded; whitespace folded.
 * Attribute values holding ">" and unclosed elements are not handled: the
 * result degrades to more text, never to less than the page's words.
 */
export function htmlToText(html: string, base?: URL): PageText {
  const title = squash(
    decodeEntities(
      /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1] ?? "",
    ),
  );
  const source = html.replace(COMMENT, "").replace(DROPPED, "");
  const lines: string[] = [];
  let current = "";
  let prefix = "";
  const lists: { ordered: boolean; count: number }[] = [];
  let row: string[] | undefined;
  let cell: string | undefined;
  let link: { start: number; shown?: string } | undefined;
  let skip: { tag: string; depth: number } | undefined;
  const append = (text: string) => {
    if (cell !== undefined) cell += text;
    else current += text;
  };
  const flushLine = () => {
    const line = squash(current);
    current = "";
    if (line) lines.push(prefix ? `${prefix}${line}` : line);
    prefix = "";
    link = undefined;
  };
  const closeRow = () => {
    if (cell !== undefined) {
      row?.push(squash(cell));
      cell = undefined;
    }
    if (row) {
      const line = row.join(" | ").trim();
      if (line.replace(/[\s|]/g, "")) lines.push(line);
      row = undefined;
    }
  };
  for (const m of source.matchAll(TOKEN)) {
    const [whole, rawTag, attrs = "", text] = m;
    if (text !== undefined) {
      if (skip) continue;
      append(decodeEntities(text).replace(/\s+/g, " "));
      continue;
    }
    if (!rawTag) continue;
    const tag = rawTag.toLowerCase();
    const closing = whole.startsWith("</");
    if (skip) {
      if (tag !== skip.tag) continue;
      if (closing) {
        if (--skip.depth === 0) skip = undefined;
      } else if (!VOID.has(tag)) skip.depth++;
      continue;
    }
    if (!closing) {
      if (
        hasAttr(attrs, "hidden") ||
        /^true$/i.test(attr(attrs, "aria-hidden") ?? "")
      ) {
        if (!VOID.has(tag) && !/\/\s*$/.test(attrs)) skip = { tag, depth: 1 };
        continue;
      }
      const heading = HEADING.exec(tag);
      if (heading) {
        flushLine();
        prefix = `${"#".repeat(Number(heading[1]))} `;
      } else if (tag === "br") {
        if (cell !== undefined) cell += " ";
        else flushLine();
      } else if (tag === "ul" || tag === "ol") {
        flushLine();
        lists.push({ ordered: tag === "ol", count: 0 });
      } else if (tag === "li") {
        flushLine();
        const list = lists[lists.length - 1];
        if (list) {
          list.count++;
          prefix = list.ordered ? `${list.count}. ` : "- ";
        } else prefix = "- ";
      } else if (
        tag === "table" ||
        tag === "thead" ||
        tag === "tbody" ||
        tag === "tfoot"
      ) {
        flushLine();
        closeRow();
      } else if (tag === "tr") {
        flushLine();
        closeRow();
        row = [];
      } else if (tag === "td" || tag === "th") {
        if (cell !== undefined) row?.push(squash(cell));
        if (!row) row = [];
        cell = "";
      } else if (tag === "a") {
        link = {
          start: (cell ?? current).length,
          shown: shownHref(attr(attrs, "href"), base),
        };
      } else if (tag === "img") {
        const alt = squash(decodeEntities(attr(attrs, "alt") ?? ""));
        if (alt) append(` ${alt} `);
      } else if (tag === "input") {
        const type = (attr(attrs, "type") ?? "text").toLowerCase();
        const value = squash(decodeEntities(attr(attrs, "value") ?? ""));
        if ((type === "submit" || type === "button") && value)
          append(` ${value} `);
      } else if (BLOCK.has(tag)) flushLine();
      continue;
    }
    if (HEADING.test(tag) || tag === "li" || BLOCK.has(tag)) flushLine();
    else if (tag === "ul" || tag === "ol") {
      flushLine();
      lists.pop();
    } else if (tag === "td" || tag === "th") {
      if (cell !== undefined) {
        row?.push(squash(cell));
        cell = undefined;
      }
    } else if (tag === "tr" || tag === "table") {
      flushLine();
      closeRow();
    } else if (tag === "a" && link) {
      const buffer = cell ?? current;
      const label = squash(buffer.slice(link.start));
      if (link.shown) {
        if (!label) append(link.shown);
        else if (label !== link.shown && !label.includes(link.shown))
          append(` (${link.shown})`);
      }
      link = undefined;
    }
  }
  flushLine();
  closeRow();
  return { title, text: lines.join("\n").trim() };
}
/** A text/plain body as lines: newlines normalised, trailing space gone. */
export function plainText(body: string): PageText {
  return {
    title: "",
    text: body
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => line.replace(/[ \t\f\v]+$/g, ""))
      .join("\n")
      .trim(),
  };
}
/**
 * The text at maxChars: whole when it fits, else cut so that the marker is
 * its last line and the whole is within maxChars.
 */
export function capText(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const room = Math.max(0, maxChars - WEB_TEXT_CUT_MARKER.length - 1);
  return {
    text: `${text.slice(0, room).trimEnd()}\n${WEB_TEXT_CUT_MARKER}`,
    truncated: true,
  };
}

// MARK: the fetch

export type FetchProblem =
  | UrlProblem
  | "TIMEOUT"
  | "TOO_LARGE"
  | "NOT_TEXT"
  | "TOO_MANY_REDIRECTS"
  | "REDIRECT_OFF_HOST"
  | "FETCH_FAILED"
  | "INTERRUPTED";
export interface Fetched {
  status: number;
  /** The media type alone ("text/html"), lowercased. */
  type: string;
  charset?: string;
  body: Buffer;
  url: URL;
}
type FetchFail = { problem: FetchProblem; detail?: string };
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const TEXT_TYPES = /^(?:text\/html|text\/plain|application\/xhtml\+xml)$/;
const isFail = <T extends object>(value: T | FetchFail): value is FetchFail =>
  "problem" in value;
/**
 * dns.lookup with the private-address rule over what it answers, so a public
 * name that resolves to this Mac or a private network is refused before a
 * connection is made; a name whose origin is allowed passes through.
 */
export function guardedLookup(
  lookup: LookupFunction,
  allowLocal: boolean,
): LookupFunction {
  const guarded: LookupFunction = (hostname, options, callback) =>
    lookup(hostname, options, (error, address, family) => {
      if (error || allowLocal) return callback(error, address, family);
      const addresses = Array.isArray(address)
        ? address.map((entry) => entry.address)
        : [String(address)];
      if (addresses.some(privateAddress)) {
        const refused: NodeJS.ErrnoException = new Error(
          "The name resolves to a private address.",
        );
        refused.code = "LOCAL_ADDRESS";
        return callback(refused, address, family);
      }
      callback(error, address, family);
    });
  return guarded;
}
interface FetchOptions {
  deadline: number;
  signal: AbortSignal;
  lookup: LookupFunction;
  rules: AddressRules;
  now: () => number;
}
/** One GET, no redirect followed: the status and headers, and the body of a text response within the size cap. */
function once(
  url: URL,
  o: FetchOptions,
): Promise<
  | {
      status: number;
      location?: string;
      type: string;
      charset?: string;
      encoding: string;
      body: Buffer;
    }
  | FetchFail
> {
  return new Promise((resolve) => {
    if (o.signal.aborted) return resolve({ problem: "INTERRUPTED" });
    const remaining = o.deadline - o.now();
    if (remaining <= 0) return resolve({ problem: "TIMEOUT" });
    const allowLocal = o.rules.loopbackOrigins.includes(url.origin);
    const make = url.protocol === "https:" ? httpsRequest : httpRequest;
    let settled = false;
    const finish = (value: Parameters<typeof resolve>[0]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      o.signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const req = make(url, {
      method: "GET",
      headers: { "User-Agent": WEB_USER_AGENT },
      lookup: guardedLookup(o.lookup, allowLocal),
    });
    const onAbort = () => {
      req.destroy();
      finish({ problem: "INTERRUPTED" });
    };
    const timer = setTimeout(() => {
      req.destroy();
      finish({ problem: "TIMEOUT" });
    }, remaining);
    o.signal.addEventListener("abort", onAbort, { once: true });
    req.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "LOCAL_ADDRESS")
        return finish({ problem: "LOCAL_ADDRESS" });
      finish({
        problem: "FETCH_FAILED",
        detail: typeof error.code === "string" ? error.code : undefined,
      });
    });
    req.on("response", (res: IncomingMessage) => {
      const status = res.statusCode ?? 0;
      const contentType = String(res.headers["content-type"] ?? "");
      const type = contentType.split(";")[0].trim().toLowerCase();
      const charset = /charset\s*=\s*"?([\w-]+)/i
        .exec(contentType)?.[1]
        ?.toLowerCase();
      const encoding = String(res.headers["content-encoding"] ?? "")
        .trim()
        .toLowerCase();
      const header = (name: string) => {
        const value = res.headers[name];
        return Array.isArray(value) ? value[0] : value;
      };
      if (REDIRECTS.has(status)) {
        res.resume();
        return finish({
          status,
          location: header("location"),
          type,
          charset,
          encoding,
          body: Buffer.alloc(0),
        });
      }
      if (status < 200 || status >= 300) {
        res.resume();
        return finish({
          status,
          type,
          charset,
          encoding,
          body: Buffer.alloc(0),
        });
      }
      if (!TEXT_TYPES.test(type)) {
        res.destroy();
        return finish({ problem: "NOT_TEXT", detail: type.slice(0, 60) });
      }
      const declared = Number(header("content-length"));
      if (Number.isFinite(declared) && declared > WEB_LIMITS.responseBytes) {
        res.destroy();
        return finish({ problem: "TOO_LARGE" });
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > WEB_LIMITS.responseBytes) {
          res.destroy();
          return finish({ problem: "TOO_LARGE" });
        }
        chunks.push(chunk);
      });
      res.on("end", () =>
        finish({
          status,
          type,
          charset,
          encoding,
          body: Buffer.concat(chunks),
        }),
      );
      res.on("error", () => finish({ problem: "FETCH_FAILED" }));
    });
    req.end();
  });
}
/** The body decompressed when the server compressed it anyway, within the size cap. */
function decoded(body: Buffer, encoding: string): Buffer | FetchFail {
  if (!encoding || encoding === "identity") return body;
  try {
    const options = { maxOutputLength: WEB_LIMITS.responseBytes };
    if (encoding === "gzip" || encoding === "x-gzip")
      return gunzipSync(body, options);
    if (encoding === "deflate") return inflateSync(body, options);
    if (encoding === "br") return brotliDecompressSync(body, options);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return code === "ERR_BUFFER_TOO_LARGE"
      ? { problem: "TOO_LARGE" }
      : { problem: "FETCH_FAILED", detail: "decode" };
  }
  return { problem: "FETCH_FAILED", detail: "encoding" };
}
/**
 * The page at the address, following at most WEB_LIMITS.redirects redirects
 * on the same host, each judged by the same rules, within the deadline.
 */
export async function fetchPage(
  target: WebTarget,
  o: FetchOptions,
): Promise<Fetched | FetchFail> {
  let url = target.url;
  for (let hop = 0; ; hop++) {
    const res = await once(url, o);
    if (isFail(res)) return res;
    if (REDIRECTS.has(res.status)) {
      if (hop >= WEB_LIMITS.redirects) return { problem: "TOO_MANY_REDIRECTS" };
      if (!res.location) return { problem: "FETCH_FAILED", detail: "redirect" };
      let next: URL;
      try {
        next = new URL(res.location, url);
      } catch {
        return { problem: "BAD_URL" };
      }
      if (next.hostname !== url.hostname)
        return { problem: "REDIRECT_OFF_HOST" };
      const judged = judgeUrl(next, o.rules);
      if ("problem" in judged) return judged;
      url = judged.url;
      continue;
    }
    const body = decoded(res.body, res.encoding);
    if (!Buffer.isBuffer(body)) return body;
    return {
      status: res.status,
      type: res.type,
      charset: res.charset,
      body,
      url,
    };
  }
}
/** The body as text: the declared charset, else a meta charset in an HTML head, else UTF-8; a bad label reads as UTF-8. */
export function bodyText(body: Buffer, type: string, charset?: string): string {
  let label = charset;
  if (!label && type !== "text/plain") {
    const head = body.subarray(0, 4096).toString("latin1");
    label = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i
      .exec(head)?.[1]
      ?.toLowerCase();
  }
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(label || "utf-8");
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  return decoder.decode(body).replace(/^﻿/, "");
}

// MARK: the provider

export function webToolSpec(name: WebToolName): ToolSpec {
  const tool = WEB_TOOLS[name];
  return {
    id: `${WEB_ID}__${name}`,
    provider: WEB_ID,
    name,
    title: WEB_TITLE,
    does: tool.does,
    params: tool.params,
    tier: tool.tier,
    trusted: true,
    // Local in the sense the privacy gate reads (toolsAllowed): no third
    // party receives anything of the user's through it. The fetch sends the
    // address and a fixed User-Agent, nothing else; the model that reads
    // the text is the configured one, in every privacy mode, as with the
    // text off the screen. Closed-world: a GET changes nothing anywhere.
    local: true,
    openWorld: false,
    undoable: false,
    longRunning: false,
    transport: "builtin",
    timeoutMs: TOOL_LIMITS.callTimeoutMs,
    dateKeys: [],
    trace: { tool: name, server: WEB_ID },
    resultChars: WEB_LIMITS.resultChars,
  };
}
const isToolName = (name: string): name is WebToolName => name in WEB_TOOLS;
interface Checked {
  name: WebToolName;
  target: WebTarget;
  maxChars: number;
}
export interface ArgsProblem {
  problem: "invalid_args" | "bad_url" | "protected_site" | "no_page";
  code: "BAD_ARGS" | "NO_PAGE" | UrlProblem;
}
/**
 * The arguments checked against the tool's own keys and the address rules;
 * a problem is the registry's ToolProblem, so policy retries with the fixed
 * sentence and no question is asked about an address the call would refuse.
 * maxChars is an integer, clamped into [minChars, maxChars]; a page in front
 * comes from ToolWords.pageAddress.
 */
export function checkArgs(
  name: string,
  args: Record<string, unknown>,
  rules: AddressRules,
  words?: ToolWords,
): Checked | ArgsProblem {
  if (!isToolName(name)) return { problem: "invalid_args", code: "BAD_ARGS" };
  const tool = WEB_TOOLS[name];
  if (Object.keys(args).some((key) => !tool.keys.includes(key)))
    return { problem: "invalid_args", code: "BAD_ARGS" };
  if (tool.required.some((key) => typeof args[key] !== "string"))
    return { problem: "invalid_args", code: "BAD_ARGS" };
  let maxChars: number = WEB_LIMITS.defaultChars;
  if (args.maxChars !== undefined) {
    if (
      typeof args.maxChars !== "number" ||
      !Number.isInteger(args.maxChars) ||
      args.maxChars <= 0
    )
      return { problem: "invalid_args", code: "BAD_ARGS" };
    maxChars = Math.min(
      WEB_LIMITS.maxChars,
      Math.max(WEB_LIMITS.minChars, args.maxChars),
    );
  }
  const address = name === "read_page_text" ? args.url : words?.pageAddress;
  if (
    name === "read_current_page" &&
    (typeof address !== "string" || !address.trim())
  )
    return { problem: "no_page", code: "NO_PAGE" };
  const target = webTarget(address, rules);
  if ("problem" in target)
    return {
      problem:
        target.problem === "PROTECTED_SITE" ? "protected_site" : "bad_url",
      code: target.problem,
    };
  return { name, target, maxChars };
}
const refuse = (code: string, sentence: string): ProviderResult => ({
  code: "error",
  raw: `${code}: ${sentence}`,
  items: 0,
});
export const WEB_SENTENCES: Record<
  | Exclude<FetchProblem, "INTERRUPTED">
  | "BAD_ARGS"
  | "NO_PAGE"
  | "CREDENTIAL"
  | "HTTP_ERROR",
  string
> = {
  BAD_ARGS: "The arguments do not match the tool's parameters.",
  BAD_URL: "Use a full http or https address without credentials.",
  PROTECTED_SITE:
    "That website is protected. Ask the user to open it with request_user.",
  LOCAL_ADDRESS:
    "Addresses on this Mac or a private network are not read here.",
  NO_PAGE: "No web page is in front; call read_page_text with the address.",
  TIMEOUT: `The page did not finish loading in ${WEB_LIMITS.timeoutMs / 1000} seconds.`,
  TOO_LARGE: "The page is larger than 2 MB; it is not read here.",
  NOT_TEXT: "That address is not an HTML or plain-text page.",
  TOO_MANY_REDIRECTS: `The address redirected more than ${WEB_LIMITS.redirects} times.`,
  REDIRECT_OFF_HOST:
    "The address redirected to another host; open it with open_url instead.",
  FETCH_FAILED: "The page could not be fetched.",
  HTTP_ERROR: "The server did not serve the page.",
  CREDENTIAL:
    "The page holds what looks like a credential; its text is not passed on.",
};
const hasCredential = (text: string) =>
  scanText(text).some((f) => f.action === "BLOCK_UPLOAD");
/** What a refused checkArgs answers at call(): the code and its sentence. */
const argsRefusal = (problem: ArgsProblem): ProviderResult =>
  refuse(problem.code, WEB_SENTENCES[problem.code]);

export interface WebProviderOptions extends LocalProviderOptions {
  /** Tests: a shorter whole-fetch budget than WEB_LIMITS.timeoutMs. */
  timeoutMs?: number;
  /** Tests: a lookup that answers a made-up name, in place of dns.lookup. */
  lookup?: LookupFunction;
}
export function createWebProvider(o: WebProviderOptions): McpProvider {
  const now = o.now ?? Date.now;
  const timeoutMs = o.timeoutMs ?? WEB_LIMITS.timeoutMs;
  const lookup = o.lookup ?? (dnsLookup as unknown as LookupFunction);
  let state: ProviderState = "off";
  const specs = WEB_TOOL_NAMES.map(webToolSpec);
  const on = () => state === "on";
  // The registry always hands settings in; a provider built bare (a test)
  // judges hosts against the defaults' protected list.
  const settings = o.settings ?? (() => defaultSettings);
  const rules = (): AddressRules => ({
    protectedDomains: settings().protectedDomains,
    loopbackOrigins: o.loopbackOrigins ?? [],
  });
  const trace = (
    tool: WebToolName,
    outcome: string,
    resultBytes: number,
    host: string,
  ) => {
    try {
      o.trace?.("WebPageRead", {
        tool,
        server: WEB_ID,
        outcome,
        resultBytes,
        host: traceHost(host),
      });
    } catch {}
  };

  const read = async (
    checked: Checked,
    signal: AbortSignal,
  ): Promise<ProviderResult> => {
    const { target, maxChars } = checked;
    const fetched = await fetchPage(target, {
      deadline: now() + timeoutMs,
      signal,
      lookup,
      rules: rules(),
      now,
    });
    if (isFail(fetched)) {
      if (fetched.problem === "INTERRUPTED") {
        trace(checked.name, "interrupted", 0, target.host);
        return { code: "interrupted", raw: "", items: 0 };
      }
      trace(checked.name, fetched.problem, 0, target.host);
      const sentence = WEB_SENTENCES[fetched.problem];
      return refuse(
        fetched.problem,
        fetched.problem === "FETCH_FAILED" && fetched.detail
          ? `${sentence.slice(0, -1)} (${fetched.detail}).`
          : sentence,
      );
    }
    if (fetched.status < 200 || fetched.status >= 300) {
      trace(checked.name, "HTTP_ERROR", 0, target.host);
      return refuse(
        "HTTP_ERROR",
        `The server answered ${fetched.status}; the page was not read.`,
      );
    }
    const decodedText = bodyText(fetched.body, fetched.type, fetched.charset);
    const page =
      fetched.type === "text/plain"
        ? plainText(decodedText)
        : htmlToText(decodedText, fetched.url);
    if (hasCredential(page.text) || hasCredential(page.title)) {
      trace(checked.name, "CREDENTIAL", fetched.body.length, target.host);
      return refuse("CREDENTIAL", WEB_SENTENCES.CREDENTIAL);
    }
    const cut = capText(page.text, maxChars);
    const title = page.title.slice(0, WEB_LIMITS.titleChars);
    const host = fetched.url.hostname;
    const chars = cut.text.length;
    const facts = `Page: ${title || "(untitled)"} — ${host}, ${page.text.length} characters of text${
      cut.truncated
        ? `, cut at ${maxChars}; call again with a larger maxChars (up to ${WEB_LIMITS.maxChars}) to read the rest`
        : ""
    }.`;
    trace(checked.name, "ok", fetched.body.length, host);
    return {
      code: "ok",
      raw: `${facts}\n\n${cut.text || "(no text on the page)"}`,
      items: 1,
      facts: {
        kind: "page",
        title,
        host,
        chars,
        truncated: cut.truncated,
      },
    };
  };

  return {
    id: WEB_ID,
    transport: "builtin",
    title: WEB_TITLE,
    async start() {
      state = "on";
    },
    async retry() {
      state = "on";
    },
    state: () => ({ state, toolCount: on() ? specs.length : 0, restarts: 0 }),
    stderrBytes: () => 0,
    pinOf: () => undefined,
    catalog: () => [],
    async tools() {
      return on() ? specs : [];
    },
    prepare(spec, args, words): ToolPrepared {
      if (!on()) return { ok: false, problem: "unavailable" };
      const checked = checkArgs(spec.name, args, rules(), words);
      if ("problem" in checked) return { ok: false, problem: checked.problem };
      // The host grounds the call: the path is the page's business, and the
      // tool is closed-world and a read, so no question is ever built from
      // it; the kind renders like every other (toolQuestion web_read).
      const question: ToolQuestion = {
        kind: "web_read",
        host: checked.target.host,
      };
      return {
        ok: true,
        question,
        groundText: [checked.target.host],
        argsBytes: Buffer.byteLength(JSON.stringify(args)),
      };
    },
    async call(spec, args, callOptions) {
      if (!on()) return { code: "unavailable", raw: "", items: 0 };
      const checked = checkArgs(spec.name, args, rules(), callOptions.words);
      if ("problem" in checked) return argsRefusal(checked);
      try {
        return await read(checked, callOptions.signal);
      } catch (error) {
        return refuse(
          "FAILED",
          error instanceof Error && "code" in error
            ? `The call failed (${String((error as { code?: unknown }).code)}).`
            : "The call failed.",
        );
      }
    },
    async undo() {
      return refuse(
        "NOT_FOUND",
        "A read changes nothing; there is nothing to take back.",
      );
    },
    async close() {
      state = "off";
    },
  };
}

/** The web tool as the registry composes it (src/tools/providers/index.ts LOCAL_SERVERS). */
export const WEB: LocalServer = {
  id: WEB_ID,
  title: WEB_TITLE,
  enabled: (settings: Settings) => settings.tools.web,
  create: createWebProvider,
};
