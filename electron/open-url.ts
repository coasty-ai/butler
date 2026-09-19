/**
 * The open_url route (.data/design/streaming-execution.md §3.3): the chosen
 * browser is told the address itself. No keystroke, no click, no address
 * field: a URL typed into a field is only what was typed, while an address
 * handed to the browser is the page it loads.
 *
 * Two ways in, both LaunchServices or Apple Events to the browser and never
 * the helper:
 *
 * - When this app navigated the browser's front tab a moment ago (its own
 *   tab: the host it last sent it to, within OWN_TAB_MS) and the browser
 *   scripts tabs (Safari's dictionary; Chrome's, which Edge and Brave ship),
 *   one Apple Event sets the URL of that tab (`set URL of current tab of
 *   front window`, `active tab` in Chrome), so "go to youtube and play X"
 *   loads the results over the home page instead of piling up tabs. The
 *   script first checks the tab is still on that host; a tab the person
 *   moved elsewhere, no window, or a browser that is not running answers
 *   "foreign", "none" or "absent" and nothing is set.
 * - Otherwise `open -b <bundle id> <url>`: LaunchServices launches or
 *   activates the browser and hands it the URL (a new tab in front, or a
 *   window). The person's own tabs are never navigated.
 *
 * The URL reaches osascript and open as an argument, never interpolated
 * into a script; the browser is named by bundle id from a fixed list. The
 * first Apple Event from the app asks for Automation consent once (a live
 * run, attended). The URL itself is checked by webAddress: http or https
 * with a host and no credentials, as the schema requires.
 */
import { execFile } from "node:child_process";
import { webAddress, type ExecutionResult } from "../src/core/schema";

/** Runs a command and answers its stdout; injected for tests. */
export type Run = (command: string, args: string[]) => Promise<string>;
export interface Browser {
  name: string;
  bundleId: string;
}
export type Navigated = NonNullable<ExecutionResult["navigated"]> & {
  via: "script" | "open";
};

/** Browsers whose scripting dictionary sets a tab's URL, and which dialect. */
export const SCRIPTABLE_BROWSERS: Readonly<
  Record<string, "safari" | "chrome">
> = {
  "com.apple.Safari": "safari",
  "com.apple.SafariTechnologyPreview": "safari",
  "com.google.Chrome": "chrome",
  "com.google.Chrome.canary": "chrome",
  "com.microsoft.edgemac": "chrome",
  "com.brave.Browser": "chrome",
};
const BUNDLE_ID = /^[A-Za-z0-9.-]{1,120}$/;
/** How long a navigated front tab stays this app's own, so the next address replaces its page. */
export const OWN_TAB_MS = 10 * 60_000;
/** osascript and open are given this long; a browser that hangs answers UNREAD and the URL goes through open. */
export const ROUTE_TIMEOUT_MS = 3_000;

/** The host a URL names, lowercased, without a leading "www.": what "the same site" means. */
export function ownHost(url: string): string {
  const host = webAddress(url)?.hostname.toLowerCase() ?? "";
  return host.replace(/^www\./, "");
}

/**
 * Sets the front tab's URL when that tab is on the app's own host, answering
 * "navigated"; else "absent" (browser not running; System Events is asked
 * first, since a `tell` would launch it), "none" (no window) or "foreign"
 * (another page). argv: the URL, then the host. The one write is the URL.
 */
export function navigateScript(bundleId: string): string {
  const dialect = SCRIPTABLE_BROWSERS[bundleId];
  if (!dialect || !BUNDLE_ID.test(bundleId))
    throw new Error("Not a scriptable browser.");
  const tab = dialect === "safari" ? "current tab" : "active tab";
  return [
    "on run argv",
    "  set theURL to item 1 of argv",
    "  set ownHost to item 2 of argv",
    '  tell application "System Events"',
    `    set alive to count of (every process whose bundle identifier is "${bundleId}")`,
    "  end tell",
    '  if alive is 0 then return "absent"',
    `  tell application id "${bundleId}"`,
    '    if (count of windows) is 0 then return "none"',
    `    set t to ${tab} of front window`,
    '    set u to ""',
    "    try",
    "      set u to URL of t as text",
    "    end try",
    '    if my ownPage(u, ownHost) is false then return "foreign"',
    "    set URL of t to theURL",
    "  end tell",
    '  return "navigated"',
    "end run",
    "on ownPage(u, ownHost)",
    "  try",
    "    set h to u",
    '    if h starts with "https://" then',
    "      set h to text 9 thru -1 of h",
    '    else if h starts with "http://" then',
    "      set h to text 8 thru -1 of h",
    "    else",
    "      return false",
    "    end if",
    '    repeat with sep in {"/", "?", "#", ":"}',
    "      set AppleScript's text item delimiters to sep",
    "      set h to text item 1 of h",
    "    end repeat",
    '    set AppleScript\'s text item delimiters to ""',
    '    if h starts with "www." and (length of h) > 4 then set h to text 5 thru -1 of h',
    '    return (h is ownHost) or (h ends with ("." & ownHost))',
    "  on error",
    "    return false",
    "  end try",
    "end ownPage",
  ].join("\n");
}
export type NavigateAnswer =
  "navigated" | "absent" | "none" | "foreign" | "unread";
/** The script's answer; anything else (no consent, a hung query) is "unread". */
export function parseNavigateAnswer(
  stdout: string | undefined,
): NavigateAnswer {
  const text = (stdout ?? "").trim();
  return text === "navigated" ||
    text === "absent" ||
    text === "none" ||
    text === "foreign"
    ? text
    : "unread";
}

const execRun: Run = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: ROUTE_TIMEOUT_MS, maxBuffer: 64 * 1024, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout))),
    );
  });

/** The route, with the memory of the tab it last navigated. */
export class UrlOpener {
  private own?: { bundleId: string; host: string; at: number };
  constructor(
    private readonly run: Run = execRun,
    private readonly now: () => number = Date.now,
  ) {}
  /** Which tab counts as the app's own right now, if any (tests and the report). */
  ownTab(): { bundleId: string; host: string } | undefined {
    const own = this.own;
    if (!own || this.now() - own.at > OWN_TAB_MS) return undefined;
    return { bundleId: own.bundleId, host: own.host };
  }
  async open(url: string, browser: Browser): Promise<Navigated> {
    const parsed = webAddress(url);
    if (!parsed) throw new Error("Not a web address.");
    if (!BUNDLE_ID.test(browser.bundleId)) throw new Error("Not a browser.");
    const own = this.ownTab();
    let via: Navigated["via"] = "open";
    if (
      own &&
      own.bundleId === browser.bundleId &&
      SCRIPTABLE_BROWSERS[browser.bundleId]
    ) {
      const answer = parseNavigateAnswer(
        await this.run("osascript", [
          "-e",
          navigateScript(browser.bundleId),
          parsed.href,
          own.host,
        ]).catch(() => undefined),
      );
      if (answer === "navigated") via = "script";
    }
    if (via === "open")
      await this.run("open", ["-b", browser.bundleId, parsed.href]);
    this.own = {
      bundleId: browser.bundleId,
      host: ownHost(parsed.href),
      at: this.now(),
    };
    return { host: parsed.hostname, appId: browser.bundleId, via };
  }
}
