import { createHash } from "node:crypto";
import { KNOWN_SITES } from "../core/places";
import { scanText } from "../core/sanitize";
import { isSafeIndexPath, tokenize } from "./retrieve";
import { outlineOf, stripPoliteness } from "./skills";
import type { PlanStep, ReplayPlan, SystemIndex } from "../core/memory";
import type { MemoryData } from "./types";

/** Browsers eligible for URL and search intents, in fallback order. */
export const BROWSERS = [
  { name: "Safari", bundleId: "com.apple.Safari" },
  { name: "Google Chrome", bundleId: "com.google.Chrome" },
  { name: "Firefox", bundleId: "org.mozilla.firefox" },
  { name: "Arc", bundleId: "company.thebrowser.Browser" },
  { name: "Brave Browser", bundleId: "com.brave.Browser" },
  { name: "Microsoft Edge", bundleId: "com.microsoft.edgemac" },
] as const;

const DOCUMENT_EXTENSIONS = new Set(
  (
    "pdf doc docx xls xlsx ppt pptx pages numbers key txt rtf rtfd md markdown csv tsv " +
    "json xml html htm png jpg jpeg gif heic tiff webp svg mov mp4 m4v mp3 m4a wav aiff " +
    "zip epub odt ods odp sketch fig psd ai"
  ).split(" "),
);

// "open Notes.app" or "open deploy.sh" names an app bundle, script or code
// file, never a website, even when the extension is also a top-level domain.
const NON_WEB_EXTENSIONS = new Set(
  (
    "app sh bash zsh command tool py rb pl js mjs cjs ts rs go swift java kt " +
    "php lua scpt workflow plist pkg dmg jar exe"
  ).split(" "),
);

const id = (kind: string, key: string) =>
  `intent:${kind}:${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;

// Clauses that make a request multi-step or conditional.
const MULTI_STEP =
  /(?:\band then\b|\bthen\b|\bafter that\b|\bafterwards\b|\bif\b|\bunless\b|\bwhen\b|[,;]|\band\b|&|\+)/i;
// An unquoted search query with these words is a compound or conditional
// request ("search youtube for lofi and play the first video"); the model
// handles it. A fully quoted query may contain them.
const QUERY_SEQUENCE =
  /(?:\bthen\b|\bafter that\b|\bafterwards\b|\band\b|\bif\b|\bwhen\b|\bunless\b|&|[,;])/i;
const QUOTED = /^(["'`])((?:(?!\1).)+)\1$/;

const unquote = (text: string) =>
  text
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();

/**
 * The browser a URL or search intent opens: the most used installed one,
 * else Safari. The early step (electron/early-start.ts) brings the same one
 * forward while "go to youtube…" is still being said.
 */
export function preferredBrowser(
  apps: SystemIndex["apps"],
  data: MemoryData | undefined,
): { name: string; bundleId: string } {
  const installed = (b: (typeof BROWSERS)[number]) =>
    apps.find((a) => a.bundleId === b.bundleId || a.name === b.name);
  const candidates = BROWSERS.flatMap((b) => {
    const app = installed(b);
    const usage =
      data && Object.hasOwn(data.apps, b.bundleId)
        ? data.apps[b.bundleId]
        : undefined;
    // Without an index, a browser that was launched before is installed.
    if (!app && (apps.length || !usage)) return [];
    return [
      {
        name: app?.name ?? b.name,
        bundleId: b.bundleId,
        count: usage?.count ?? 0,
        lastUsed: usage?.lastUsed ?? "",
      },
    ];
  })
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count || b.lastUsed.localeCompare(a.lastUsed));
  if (candidates[0])
    return { name: candidates[0].name, bundleId: candidates[0].bundleId };
  const safari = apps.find((a) => a.bundleId === BROWSERS[0].bundleId);
  return { name: safari?.name ?? "Safari", bundleId: BROWSERS[0].bundleId };
}

function browserPlan(
  kind: string,
  url: string,
  domain: string | undefined,
  index: SystemIndex | undefined,
  data: MemoryData | undefined,
): ReplayPlan {
  const browser = preferredBrowser(index?.apps ?? [], data);
  const steps: PlanStep[] = [
    { action: { type: "open_app", name: browser.name } },
    {
      action: { type: "hotkey", keys: ["CMD", "L"] },
      expectAppId: browser.bundleId,
    },
    { action: { type: "type_text", text: url }, expectAppId: browser.bundleId },
    { action: { type: "key", key: "ENTER" }, expectAppId: browser.bundleId },
  ];
  return {
    id: id(kind, `${browser.bundleId}|${url}`),
    source: "intent",
    mode: "replay",
    steps,
    ...(domain ? { completeWhen: { host: domain } } : {}),
    outline: outlineOf(steps),
  };
}

const DOMAIN =
  /^((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,24}))(:\d{1,5})?(\/[^\s]*)?$/i;

function parseTarget(
  target: string,
  verb: string,
): { url: string; domain: string } | undefined {
  const value = unquote(target);
  if (!value || /\s/.test(value) || value.length > 500) return undefined;
  if (/^https:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "https:" || !parsed.hostname.includes("."))
        return undefined;
      if (parsed.username || parsed.password) return undefined;
      return {
        url: value,
        domain: parsed.hostname.toLowerCase().replace(/^www\./, ""),
      };
    } catch {
      return undefined;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !DOMAIN.test(value))
    return undefined;
  const match = DOMAIN.exec(value);
  if (!match) return undefined;
  const tld = match[2].toLowerCase();
  // "open report.pdf" is a file and "open Notes.app" an app, not a domain.
  if (
    verb === "open" &&
    !match[3] &&
    !match[4] &&
    (DOCUMENT_EXTENSIONS.has(tld) || NON_WEB_EXTENSIONS.has(tld))
  )
    return undefined;
  if (/^\d+$/.test(tld)) return undefined;
  const host = match[1].toLowerCase();
  return {
    // The port is kept: "example.com:8080/x" must not load example.com/x.
    url: host + (match[3] ?? "") + (match[4] ?? ""),
    domain: host.replace(/^www\./, ""),
  };
}

const plus = (q: string) => encodeURIComponent(q).replace(/%20/g, "+");

/** The search text of a request, or undefined when it is not a single search. */
function searchQuery(raw: string): string | undefined {
  const text = raw.trim();
  const quoted = QUOTED.exec(text);
  const query = quoted ? quoted[2].trim() : unquote(text);
  if (
    !query ||
    query.length > 200 ||
    !tokenize(query).length ||
    (!quoted && QUERY_SEQUENCE.test(query)) ||
    scanText(query).some((f) => f.action === "BLOCK_UPLOAD")
  )
    return undefined;
  return query;
}

function matchSearch(
  text: string,
  index: SystemIndex | undefined,
  data: MemoryData | undefined,
): ReplayPlan | undefined {
  const google = [
    /^(?:search|look up|lookup)\s+(?:on\s+)?(?:google|the web|the internet|online|web)\s+for\s+(.+)$/i,
    /^(?:search|look up)\s+(?:for\s+)?(.+?)\s+(?:on|using)\s+google$/i,
    /^google\s+(?:search\s+)?(?:for\s+)?(.+)$/i,
  ];
  for (const pattern of google) {
    const m = pattern.exec(text);
    if (!m) continue;
    const query = searchQuery(m[1]);
    if (!query) return undefined;
    return browserPlan(
      "google",
      `https://www.google.com/search?q=${plus(query)}`,
      "google.com",
      index,
      data,
    );
  }
  const youtube = [
    /^search\s+(?:on\s+)?youtube\s+for\s+(.+)$/i,
    /^(?:search|look up)\s+(?:for\s+)?(.+?)\s+on\s+youtube$/i,
    /^youtube\s+(?:search\s+)?(?:for\s+)?(.+)$/i,
  ];
  for (const pattern of youtube) {
    const m = pattern.exec(text);
    if (!m) continue;
    const query = searchQuery(m[1]);
    if (!query) return undefined;
    return browserPlan(
      "youtube",
      `https://www.youtube.com/results?search_query=${plus(query)}`,
      "youtube.com",
      index,
      data,
    );
  }
  const play = /^play\s+(.+?)\s+on\s+youtube$/i.exec(text);
  if (play) {
    const query = searchQuery(play[1]);
    if (!query) return undefined;
    // No completeWhen: the model picks and plays a video.
    return browserPlan(
      "youtube-play",
      `https://www.youtube.com/results?search_query=${plus(query)}`,
      undefined,
      index,
      data,
    );
  }
  return undefined;
}

const nameKey = (name: string) =>
  name.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

function matchApp(
  target: string,
  index: SystemIndex | undefined,
  exactOnly = false,
): ReplayPlan | undefined {
  const apps = (index?.apps ?? []).filter(
    (a) =>
      a &&
      typeof a.name === "string" &&
      typeof a.bundleId === "string" &&
      a.name.trim(),
  );
  const query = nameKey(unquote(target).replace(/\.app$/i, ""));
  if (!query || !apps.length) return undefined;
  const unique = <T extends { bundleId: string }>(list: T[]) => {
    const ids = new Set(list.map((a) => a.bundleId));
    return ids.size === 1 ? list[0] : undefined;
  };
  const exact = apps.filter(
    (a) => nameKey(a.name.replace(/\.app$/i, "")) === query,
  );
  let app = exact.length ? unique(exact) : undefined;
  if (!exact.length && !exactOnly) {
    const tokens = tokenize(query);
    if (!tokens.length) return undefined;
    app = unique(
      apps.filter((a) => {
        const name = new Set(tokenize(a.name));
        return tokens.every((t) => name.has(t));
      }),
    );
  }
  if (!app) return undefined;
  const steps: PlanStep[] = [{ action: { type: "open_app", name: app.name } }];
  return {
    id: id("app", app.bundleId),
    source: "intent",
    mode: "replay",
    steps,
    completeWhen: { appId: app.bundleId },
    outline: outlineOf(steps),
  };
}

function matchFile(
  target: string,
  index: SystemIndex | undefined,
): ReplayPlan | undefined {
  const query = nameKey(unquote(target));
  if (!query) return undefined;
  const stem = (name: string) => name.replace(/\.[a-z0-9]{1,10}$/i, "");
  const found = new Map<string, SystemIndex["matches"][number]>();
  for (const entry of index?.matches ?? []) {
    if (!entry || typeof entry.name !== "string") continue;
    if (!isSafeIndexPath(entry.path)) continue;
    const name = nameKey(entry.name);
    if (name === query || nameKey(stem(entry.name)) === query)
      found.set(entry.path, entry);
  }
  if (found.size !== 1) return undefined;
  const entry = [...found.values()][0];
  const steps: PlanStep[] = [
    { action: { type: "open_file", path: entry.path } },
  ];
  return {
    id: id("file", entry.path),
    source: "intent",
    mode: "replay",
    steps,
    completeWhen: { opened: true },
    outline: outlineOf(steps),
  };
}

const INTENT_VERB =
  /^(?:search|look ?up|google|youtube|play|open|launch|start|switch to|go to|take me to|show me|visit|navigate to|browse to|bring up)\b/i;

/**
 * Whether the task may be an app, URL or search intent. Those plans read only
 * the index app list, never its name matches, so recall can try them with a
 * query-less (cached) index first. File intents need the name matches.
 */
export function mayBeQuickIntent(task: string): boolean {
  const text = stripPoliteness(task);
  return !!text && text.length <= 300 && INTENT_VERB.test(text);
}

/**
 * Deterministic plans for predictable single-step requests. Returns undefined
 * for anything ambiguous, multi-step or conditional.
 */
export function matchIntent(
  task: string,
  index: SystemIndex | undefined,
  data?: MemoryData,
): ReplayPlan | undefined {
  const text = stripPoliteness(task);
  if (!text || text.length > 300) return undefined;

  // Searches allow "and"/"if" only inside a quoted query.
  const search = /^(?:search|look ?up|google|youtube|play)\b/i.test(text)
    ? matchSearch(text, index, data)
    : undefined;
  if (search) return search;

  if (MULTI_STEP.test(text)) return undefined;

  // Open a named file or folder.
  const fileKeyword =
    /^open\s+(?:up\s+)?(?:the\s+|my\s+)?(?:file|document|doc|folder|directory|spreadsheet|presentation|pdf)\s+(?:called\s+|named\s+)?(.+)$/i.exec(
      text,
    ) ??
    /^open\s+(?:up\s+)?(?:the\s+|my\s+)?(.+?)\s+(?:file|document|folder|directory|spreadsheet|presentation)$/i.exec(
      text,
    );
  if (fileKeyword) return matchFile(fileKeyword[1], index);

  const verb =
    /^(open up|open|launch|start|switch to|go to|take me to|show me|visit|navigate to|browse to|bring up)\s+(.+)$/i.exec(
      text,
    );
  if (!verb) return undefined;
  const action = verb[1].toLowerCase();
  const target = verb[2].trim();
  const appName = target
    .replace(/^(?:the|my)\s+/i, "")
    .replace(/\s+(?:app|application)$/i, "");

  if (
    [
      "go to",
      "take me to",
      "show me",
      "open",
      "open up",
      "visit",
      "navigate to",
      "browse to",
    ].includes(action)
  ) {
    const url = parseTarget(
      target,
      action.startsWith("open") ? "open" : action,
    );
    if (url) return browserPlan("url", url.url, url.domain, index, data);
    // A well-known site by the name people say ("youtube", "my gmail"),
    // unless an app is installed under exactly that name.
    const host = KNOWN_SITES.get(
      nameKey(unquote(target).replace(/^(?:the|my)\s+/i, "")),
    );
    if (host && !matchApp(appName, index, true))
      return browserPlan("url", host, host, index, data);
  }

  // "open report.pdf": a single-word name with a document extension.
  if (action.startsWith("open")) {
    const bare = unquote(target.replace(/^(?:the|my)\s+/i, ""));
    const ext = /\.([a-z0-9]{1,10})$/i.exec(bare)?.[1]?.toLowerCase();
    if (ext && DOCUMENT_EXTENSIONS.has(ext)) return matchFile(bare, index);
  }

  if (["visit", "navigate to", "browse to"].includes(action)) return undefined;
  return matchApp(appName, index);
}
