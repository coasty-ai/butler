/**
 * Places a spoken request may go to besides an application, by the name
 * people say for them. src/voice/early.ts recognizes them while the user is
 * still speaking (the browser or Finder comes forward before the sentence
 * ends); src/memory/intents.ts turns "go to youtube" into the browser plan
 * that loads the page without a model call.
 */

/** Well-known websites: the spoken name → the host the browser is sent to. */
export const KNOWN_SITES: ReadonlyMap<string, string> = new Map([
  ["google", "google.com"],
  ["youtube", "youtube.com"],
  ["gmail", "mail.google.com"],
  ["google calendar", "calendar.google.com"],
  ["google docs", "docs.google.com"],
  ["google drive", "drive.google.com"],
  ["github", "github.com"],
  ["twitter", "x.com"],
  ["linkedin", "linkedin.com"],
  ["reddit", "reddit.com"],
  ["wikipedia", "wikipedia.org"],
  ["amazon", "amazon.com"],
  ["netflix", "netflix.com"],
]);

/**
 * Standard folders the native helper opens in Finder (FileSafety.swift):
 * inside the home folder and not hidden. The home folder itself, the Trash
 * and /Applications are outside its rules and so not here.
 */
export const KNOWN_FOLDERS: ReadonlyMap<string, string> = new Map([
  ["downloads", "~/Downloads"],
  ["desktop", "~/Desktop"],
  ["documents", "~/Documents"],
]);

/**
 * Top-level domains a spoken or written address may end in ("github dot
 * com", "notion.so"). Deliberately without "app", "sh", "py" and other file
 * and bundle extensions: "open Notes.app" names an app, "open deploy.sh" a
 * script, never a website.
 */
export const SITE_TLDS: ReadonlySet<string> = new Set(
  `com org net io ai co dev edu gov us uk ca de fr es it nl se no dk fi jp in
   au nz ch tv me fm gg xyz info biz so ly to at eu br mx ie pl cz`
    .split(/\s+/)
    .filter(Boolean),
);

const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,24})$/;
/** The host a written domain names ("www.GitHub.com" → "www.github.com"), if it is one. */
export function domainHost(word: string): string | undefined {
  const host = word.toLowerCase();
  const match = HOST.exec(host);
  return match && SITE_TLDS.has(match[1]) ? host : undefined;
}
