/**
 * Site recipes (streaming execution, design §3.2 step 2): the websites whose
 * intents a URL can address without a screenshot or a model, each with the
 * template that addresses it and the words that select it. "play a midwest
 * safety video on youtube" is YouTube's `search` with the object "midwest
 * safety", so the results page loads while the user is still speaking.
 *
 * Every URL is a recipe's template plus the URL-encoded object and nothing
 * else: never a dictated URL, never an object with an "@", a credential
 * (core/sanitize scanText), a URL or a host in it, so no recipe can reach a
 * host other than its own. Spotify and the App Store are applications: a
 * recipe that names them opens the app and builds no URL.
 *
 * The object is the clause minus its verb phrase and the site words in
 * their slot ("on youtube", "youtube for", the name right after the verb),
 * a leading "for"/"about" and article, and the trailing generic nouns
 * ("video", "clip", "song", "page", "site", "please"). An object under two
 * characters, or of stopwords only, needs the final. Only the site slots are
 * stripped: "search google for youtube videos" searches Google for "youtube
 * videos".
 */
import { domainHost } from "../core/places";
import { scanText } from "../core/sanitize";

export type RecipeIntent = "search" | "directions";
export interface SiteRecipe {
  /** The key a FastAction names the site by. */
  key: string;
  /** The name shown ("YouTube"). */
  label: string;
  /** How people say it, lowercased; multiword names allowed. */
  names: readonly string[];
  /** The site's domain: a front host under it is this site. */
  domain: string;
  /** The host every URL of the recipe is built on. */
  host: string;
  home: string;
  /** Intent → template; `{q}` is replaced by the encoded object. */
  templates: Partial<Record<RecipeIntent, string>>;
  /** An application rather than a website: named, it opens; nothing is built. */
  app?: string;
}

export const RECIPES: readonly SiteRecipe[] = [
  {
    key: "youtube",
    label: "YouTube",
    names: ["youtube", "you tube"],
    domain: "youtube.com",
    host: "www.youtube.com",
    home: "https://www.youtube.com/",
    templates: { search: "https://www.youtube.com/results?search_query={q}" },
  },
  {
    key: "google",
    label: "Google",
    names: ["google"],
    domain: "google.com",
    host: "www.google.com",
    home: "https://www.google.com/",
    templates: { search: "https://www.google.com/search?q={q}" },
  },
  {
    key: "google-maps",
    label: "Google Maps",
    names: ["google maps"],
    domain: "maps.google.com",
    host: "www.google.com",
    home: "https://www.google.com/maps",
    templates: {
      search: "https://www.google.com/maps/search/{q}",
      directions: "https://www.google.com/maps/dir/?api=1&destination={q}",
    },
  },
  {
    key: "amazon",
    label: "Amazon",
    names: ["amazon"],
    domain: "amazon.com",
    host: "www.amazon.com",
    home: "https://www.amazon.com/",
    templates: { search: "https://www.amazon.com/s?k={q}" },
  },
  {
    key: "wikipedia",
    label: "Wikipedia",
    names: ["wikipedia"],
    domain: "wikipedia.org",
    host: "en.wikipedia.org",
    home: "https://en.wikipedia.org/",
    templates: { search: "https://en.wikipedia.org/w/index.php?search={q}" },
  },
  {
    key: "github",
    label: "GitHub",
    names: ["github", "git hub"],
    domain: "github.com",
    host: "github.com",
    home: "https://github.com/",
    templates: { search: "https://github.com/search?q={q}" },
  },
  {
    key: "reddit",
    label: "Reddit",
    names: ["reddit"],
    domain: "reddit.com",
    host: "www.reddit.com",
    home: "https://www.reddit.com/",
    templates: { search: "https://www.reddit.com/search/?q={q}" },
  },
  {
    key: "x",
    label: "X",
    names: ["twitter", "x"],
    domain: "x.com",
    host: "x.com",
    home: "https://x.com/",
    templates: { search: "https://x.com/search?q={q}" },
  },
  {
    key: "gmail",
    label: "Gmail",
    names: ["gmail", "google mail"],
    domain: "mail.google.com",
    host: "mail.google.com",
    home: "https://mail.google.com/",
    templates: { search: "https://mail.google.com/mail/u/0/#search/{q}" },
  },
  {
    key: "spotify",
    label: "Spotify",
    names: ["spotify"],
    domain: "open.spotify.com",
    host: "open.spotify.com",
    home: "https://open.spotify.com/",
    templates: {},
    app: "Spotify",
  },
  {
    key: "app-store",
    label: "App Store",
    names: ["app store"],
    domain: "apps.apple.com",
    host: "apps.apple.com",
    home: "https://apps.apple.com/",
    templates: {},
    app: "App Store",
  },
];
/**
 * The table in force: the built-ins, or the user's recipes file merged over
 * them (src/voice/recipes-file.ts, installed by electron/recipes.ts at start
 * and on change). Every lookup below reads it, so decideFast sees the merged
 * table without a table threaded through FastContext.
 */
let table: readonly SiteRecipe[] = RECIPES;
export function activeRecipes(): readonly SiteRecipe[] {
  return table;
}
/** Installs the table the lookups read; installRecipes(RECIPES) restores the built-ins. */
export function installRecipes(list: readonly SiteRecipe[]): void {
  table = list;
}
/** Names too short to mean the site anywhere but after "on"/"in"/"at"/"to" ("on x"). */
const AFTER_PREPOSITION_ONLY = new Set(["x"]);

const wordSet = (list: string) => new Set(list.split(/\s+/).filter(Boolean));
const FILLERS = wordSet("um uh uhm umm er erm hmm hm mm");
const LEADS = wordSet(
  "ok okay so hey now just please also then and can could would will you",
);
/** Before a site name in its slot: "on youtube", "at amazon", "using google". */
const SITE_PREPOSITIONS = wordSet("on in at using with via through");
/** After the site in its slot: "youtube for X", "on google about X". */
const SITE_TRAILERS = wordSet("for about");
const OBJECT_LEADS = wordSet("for about a an some any me");
/** After a verb outside the table ("fetch up", "look into"). */
const PARTICLES = wordSet("up over into onto");
/** Trailing words that name the kind of thing rather than the thing. */
const GENERIC_TRAILERS = wordSet(`video videos vid vids clip clips song songs
  track tracks tune tunes page pages site website result results online
  please now there`);
/** An object that names the site's front page and nothing on it. */
const HOME_PAGE = new Set([
  "homepage",
  "home page",
  "front page",
  "main page",
  "the homepage",
  "the home page",
  "the front page",
  "the main page",
]);
const STOPWORDS = wordSet(
  "a an the some any that this it me my of for to on in at and or up down",
);

interface VerbRule {
  phrase: readonly string[];
  intent: RecipeIntent;
  /** The verb names the site itself ("google X", "directions to X"). */
  site?: string;
  /** Where the intent goes when no site is named and the browser is in front. */
  defaultSite?: string;
  /** A media verb: assumed to mean YouTube when a search is what is meant. */
  media?: boolean;
  /** Never without a site named: "open X on youtube" is a search, "open X" is not. */
  requireSite?: boolean;
}
const VERB_RULES: readonly VerbRule[] = [
  {
    phrase: ["how", "do", "i", "get", "to"],
    intent: "directions",
    site: "google-maps",
  },
  {
    phrase: ["get", "me", "directions", "to"],
    intent: "directions",
    site: "google-maps",
  },
  {
    phrase: ["get", "directions", "to"],
    intent: "directions",
    site: "google-maps",
  },
  { phrase: ["directions", "to"], intent: "directions", site: "google-maps" },
  { phrase: ["navigate", "to"], intent: "directions", site: "google-maps" },
  { phrase: ["google"], intent: "search", site: "google" },
  { phrase: ["search", "for"], intent: "search", defaultSite: "google" },
  { phrase: ["search"], intent: "search", defaultSite: "google" },
  { phrase: ["look", "up"], intent: "search", defaultSite: "google" },
  { phrase: ["look", "for"], intent: "search" },
  { phrase: ["shop", "for"], intent: "search", defaultSite: "amazon" },
  { phrase: ["read", "about"], intent: "search", defaultSite: "wikipedia" },
  { phrase: ["show", "me"], intent: "search" },
  { phrase: ["pull", "up"], intent: "search" },
  { phrase: ["bring", "up"], intent: "search" },
  { phrase: ["find"], intent: "search" },
  { phrase: ["watch"], intent: "search", media: true, defaultSite: "youtube" },
  { phrase: ["listen", "to"], intent: "search", media: true },
  { phrase: ["play"], intent: "search", media: true },
  { phrase: ["take", "me", "to"], intent: "search", requireSite: true },
  { phrase: ["switch", "to"], intent: "search", requireSite: true },
  { phrase: ["go", "to"], intent: "search", requireSite: true },
  { phrase: ["open", "up"], intent: "search", requireSite: true },
  { phrase: ["open"], intent: "search", requireSite: true },
  { phrase: ["launch"], intent: "search", requireSite: true },
];

export type RecipeMatch =
  | {
      kind: "url";
      site: SiteRecipe;
      intent: RecipeIntent;
      q: string;
      url: string;
    }
  | { kind: "app"; site: SiteRecipe; name: string }
  /** A site named with nothing to look up: its front page. */
  | { kind: "home"; site: SiteRecipe }
  /** The object is too short, of stopwords only, or carries an "@", a credential, a URL or a host. */
  | { kind: "needs_final"; site?: SiteRecipe }
  /** Two sites named in site slots, or a site without the intent. */
  | { kind: "ambiguous" }
  /** A search verb with no site named and none implied: Jev may decide the act. */
  | { kind: "unsure"; media: boolean };

export interface RecipeOptions {
  /** The host the browser shows, or was just sent to: a search with no site named goes there. */
  frontHost?: string;
  /** The front application is a browser, so a bare "search for X" may go to Google. */
  browserFront?: boolean;
  /**
   * A search is what is meant (Jev said so): a media verb with no site goes
   * to YouTube, any other verb to Google, and a verb outside the table is
   * read as a search whose object is the rest of the clause.
   */
  assume?: boolean;
}

const normalize = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}.\-\s]/gu, " ")
    .replace(/\.+(?=\s|$)/g, "")
    .split(/\s+/)
    .filter((w) => w && !FILLERS.has(w));

export function siteByKey(key: string): SiteRecipe | undefined {
  return table.find((r) => r.key === key);
}
/** The recipe a spoken name selects ("youtube", "google maps"). */
export function siteByName(name: string): SiteRecipe | undefined {
  const key = normalize(name).join(" ");
  return table.find((r) => r.names.includes(key));
}
/** The recipe a host belongs to ("m.youtube.com" → YouTube), the most specific domain first. */
export function siteByHost(host: string | undefined): SiteRecipe | undefined {
  if (!host) return undefined;
  const h = host.toLowerCase();
  return [...table]
    .sort((a, b) => b.domain.length - a.domain.length)
    .find((r) => h === r.domain || h.endsWith("." + r.domain));
}
/** A recipe named by the first words, and how many words it took ("youtube midwest safety" → YouTube, 1). */
export function siteAtStart(
  words: readonly string[],
): { site: SiteRecipe; len: number } | undefined {
  let best: { site: SiteRecipe; len: number } | undefined;
  for (const site of table)
    for (const name of site.names) {
      const parts = name.split(" ");
      if (AFTER_PREPOSITION_ONLY.has(name)) continue;
      if (
        parts.every((p, i) => words[i] === p) &&
        parts.length > (best?.len ?? 0)
      )
        best = { site, len: parts.length };
    }
  return best;
}

export function homeUrl(site: SiteRecipe): string {
  return site.home;
}
/** The template with the object encoded into it: the only way a recipe URL is built. */
export function buildUrl(template: string, q: string): string {
  return template.replace("{q}", encodeURIComponent(q));
}

/** Why an object may not go into a URL yet, if it may not. */
export function queryProblem(q: string): "needs_final" | undefined {
  const words = q.split(" ").filter(Boolean);
  if (q.length < 2 || !words.length) return "needs_final";
  if (q.includes("@") || q.includes("://")) return "needs_final";
  if (words.every((w) => STOPWORDS.has(w))) return "needs_final";
  if (words.some((w) => domainHost(w))) return "needs_final";
  if (
    scanText(q).some((f) => f.action === "BLOCK_UPLOAD" || f.category === "url")
  )
    return "needs_final";
  return undefined;
}

/** The object words cleaned: leading "for"/article, trailing generic nouns. */
export function cleanObject(words: readonly string[]): string {
  const out = [...words];
  while (out.length && OBJECT_LEADS.has(out[0])) out.shift();
  for (;;) {
    const last = out[out.length - 1];
    if (last === undefined) break;
    if (GENERIC_TRAILERS.has(last)) out.pop();
    else if (last === "me" && out[out.length - 2] === "for") out.splice(-2);
    else break;
  }
  return out.join(" ");
}

/** A URL recipe for a site and an object, or what stands in its way. */
export function recipeSearch(
  site: SiteRecipe,
  objectWords: readonly string[],
  intent: RecipeIntent = "search",
): RecipeMatch {
  if (site.app) return { kind: "app", site, name: site.app };
  const template = site.templates[intent];
  if (!template) return { kind: "ambiguous" };
  const q = cleanObject(objectWords);
  if (queryProblem(q)) return { kind: "needs_final", site };
  return { kind: "url", site, intent, q, url: buildUrl(template, q) };
}

function verbRuleAt(words: readonly string[]): VerbRule | undefined {
  return VERB_RULES.find((r) => r.phrase.every((p, i) => words[i] === p));
}

/** A site named in a site slot of `rest`, removed from it. */
function takeSite(
  rest: string[],
  atStart: boolean,
): { site: SiteRecipe; rest: string[] } | undefined {
  for (let i = 0; i < rest.length; i++) {
    const prep =
      i > 0 && SITE_PREPOSITIONS.has(rest[i - 1]) ? i - 1 : undefined;
    if (!(prep !== undefined || (atStart && i === 0))) continue;
    // "on the app store"
    const from = rest[i] === "the" && i + 1 < rest.length ? i + 1 : i;
    // The longest name that stands here: "google maps" over "google".
    let found: { site: SiteRecipe; len: number } | undefined;
    for (const site of table)
      for (const name of site.names) {
        const parts = name.split(" ");
        if (!parts.every((p, k) => rest[from + k] === p)) continue;
        if (AFTER_PREPOSITION_ONLY.has(name) && prep === undefined) continue;
        if (parts.length > (found?.len ?? 0))
          found = { site, len: parts.length };
      }
    if (!found) continue;
    let end = from + found.len;
    if (SITE_TRAILERS.has(rest[end])) end++;
    const start = prep ?? i;
    return {
      site: found.site,
      rest: [...rest.slice(0, start), ...rest.slice(end)],
    };
  }
  return undefined;
}

/**
 * The recipe the clause selects, or undefined when no recipe verb begins it
 * (leads skipped). The site is the one named in a site slot; else the one
 * the verb implies; else, when the browser is in front, the front host's or
 * the verb's default; else the clause is `unsure`.
 */
export function matchRecipe(
  text: string,
  o: RecipeOptions = {},
): RecipeMatch | undefined {
  const words = normalize(text);
  let i = 0;
  while (i < words.length && LEADS.has(words[i])) i++;
  const rest = words.slice(i);
  const rule = verbRuleAt(rest);
  if (!rule && !o.assume) return undefined;
  const verbLen = rule ? rule.phrase.length : rest.length ? 1 : 0;
  if (!verbLen) return undefined;
  const intent = rule?.intent ?? "search";
  let object = rest.slice(verbLen);
  // A verb outside the table read as a search: its particle is not the object.
  if (!rule) while (object.length && PARTICLES.has(object[0])) object.shift();
  const named = takeSite(object, true);
  if (named) {
    object = named.rest;
    // A second site in a site slot: "search youtube on google".
    if (takeSite(object, false)) return { kind: "ambiguous" };
    if (named.site.app)
      return { kind: "app", site: named.site, name: named.site.app };
    // "go to youtube", "open the app store", "pull up the youtube homepage":
    // the place itself.
    if (
      (!object.length && rule?.requireSite) ||
      HOME_PAGE.has(object.join(" "))
    )
      return { kind: "home", site: named.site };
    return recipeSearch(named.site, object, intent);
  }
  const implied = rule?.site ? siteByKey(rule.site) : undefined;
  if (implied) return recipeSearch(implied, object, intent);
  if (rule?.requireSite) return undefined;
  const front = o.frontHost ? siteByHost(o.frontHost) : undefined;
  if (front && !front.app && front.templates[intent])
    return recipeSearch(front, object, intent);
  const fallback =
    (o.browserFront || o.assume) && rule?.defaultSite
      ? siteByKey(rule.defaultSite)
      : o.assume
        ? siteByKey(rule?.media ? "youtube" : "google")
        : undefined;
  if (fallback) return recipeSearch(fallback, object, intent);
  return { kind: "unsure", media: !!rule?.media };
}
