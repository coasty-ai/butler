import { FIXTURE_HOST } from "./graders";
import type { Run } from "./windows";

/**
 * The fixture tabs an attempt leaves in the benchmark's own browser, pointed
 * at about:blank after it. A sign-in fixture page leaves its password field
 * focused, and a focused secure field holds macOS secure event input for the
 * whole session: the helper's surface then reports `secureInput: true` to
 * every following run, the policy turns that into a takeover, and the
 * attempt hands off with no action. Cycle 20260919-0957 lost 14 of its 15
 * attempts that way after one `wall-login-mfa-handoff`; the operator cleared
 * it by loading about:blank in the tab, which is what this does.
 *
 * Two rules, both pure over an injectable `run`:
 *
 * - Only the benchmark's own browser is asked (the caller's rule,
 *   preflight.ts benchOwnBrowser: not running at the start, or with no
 *   window of the person's), and only its tabs whose URL is on the fixture
 *   server's origin, `http://127.0.0.1:<port>`, are navigated. A tab on any
 *   other host, a dev server of the person's on another loopback port
 *   included, is never touched; no tab is ever closed.
 * - The origin reaches the script through argv, never by interpolation, and
 *   comes from the fixture handle's own URL (fixtureOrigin refuses anything
 *   that is not the loopback host with a port). The browser is addressed by
 *   bundle id from a fixed list; a browser with no scripting dictionary for
 *   tabs is not reset and says so.
 *
 * Each reset is one Apple Event to the browser, and the first from a new
 * terminal asks for Automation consent once: run a cycle attended before the
 * first unattended night, as for TextEdit and the Finder (windows.ts).
 */

const BUNDLE_ID = /^[A-Za-z0-9.-]{1,120}$/;

/**
 * Browsers whose scripting dictionary has windows, tabs and a settable tab
 * URL: Safari's, and Chrome's, which Edge and Brave ship. Firefox, Arc, Dia,
 * Opera and Vivaldi script none of that and are never reset.
 */
export const RESETTABLE_BROWSERS: readonly string[] = [
  "com.apple.Safari",
  "com.apple.SafariTechnologyPreview",
  "com.google.Chrome",
  "com.google.Chrome.canary",
  "com.microsoft.edgemac",
  "com.brave.Browser",
];

/**
 * The fixture server's origin, "http://127.0.0.1:<port>", from its base URL
 * (FixtureHandle.url) or any URL on it. Throws for anything else: no other
 * origin may ever reach the script.
 */
export function fixtureOrigin(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Not a fixture URL.");
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== FIXTURE_HOST ||
    !/^\d{1,5}$/.test(parsed.port) ||
    parsed.username ||
    parsed.password
  )
    throw new Error("Not a fixture URL.");
  return `http://${FIXTURE_HOST}:${parsed.port}`;
}

/**
 * The rule the script applies to each tab: the URL is the origin itself or a
 * path under it. Here in TypeScript too, so a test reads the rule the
 * AppleScript encodes ("about:blank", another host and another loopback
 * port all fail it).
 */
export function onFixtureOrigin(url: string, origin: string): boolean {
  return url === origin || url.startsWith(origin + "/");
}

/**
 * Points every tab of the browser that is on the origin given as the
 * script's argument (argv, never interpolated) at about:blank, and answers
 * how many, or "absent" when the browser is not running. System Events is
 * asked first whether it runs, since a `tell` to an application that is not
 * running would launch it. The URL is read before it is compared, so an
 * empty tab (Safari's `missing value`) reads as "" and is left alone.
 */
export function resetTabsScript(browserId: string): string {
  if (!RESETTABLE_BROWSERS.includes(browserId) || !BUNDLE_ID.test(browserId))
    throw new Error("Not a resettable browser.");
  return [
    "on run argv",
    "  set o to item 1 of argv",
    '  tell application "System Events"',
    `    set alive to count of (every process whose bundle identifier is "${browserId}")`,
    "  end tell",
    '  if alive is 0 then return "absent"',
    "  set n to 0",
    `  tell application id "${browserId}"`,
    "    repeat with w in windows",
    "      repeat with t in tabs of w",
    '        set u to ""',
    "        try",
    "          set u to URL of t as text",
    "        end try",
    '        if (u is o) or (u starts with (o & "/")) then',
    '          set URL of t to "about:blank"',
    "          set n to n + 1",
    "        end if",
    "      end repeat",
    "    end repeat",
    "  end tell",
    "  return n as text",
    "end run",
  ].join("\n");
}

/** What a reset did, for the attempt row and the gate line; never a URL or a title. */
export interface BrowserReset {
  /** Fixture tabs pointed at about:blank. */
  tabs: number;
  /**
   * Why no tab could be looked at: the browser scripts no tabs
   * (NO_SCRIPT), is not running (NOT_RUNNING), or did not answer (UNREAD:
   * no Automation consent from this terminal, a hung query). Absent when
   * the browser answered a count.
   */
  code?: "NO_SCRIPT" | "NOT_RUNNING" | "UNREAD";
}

/** The script's answer; undefined for anything but a count or "absent". */
export function parseResetAnswer(
  stdout: string | undefined,
): BrowserReset | undefined {
  const text = (stdout ?? "").trim();
  if (text === "absent") return { tabs: 0, code: "NOT_RUNNING" };
  const match = /^(\d{1,6})$/.exec(text);
  return match ? { tabs: Number(match[1]) } : undefined;
}

/**
 * Resets the fixture tabs of one browser, the benchmark's own by the
 * caller's rule. Never throws for what the browser does; a URL that is not
 * the fixture's throws, since that is a wiring fault and no script may run
 * on it.
 */
export async function resetFixtureTabs(
  run: Run,
  browserId: string,
  fixtureUrl: string,
): Promise<BrowserReset> {
  const origin = fixtureOrigin(fixtureUrl);
  if (!RESETTABLE_BROWSERS.includes(browserId))
    return { tabs: 0, code: "NO_SCRIPT" };
  const answer = await run("osascript", [
    "-e",
    resetTabsScript(browserId),
    origin,
  ]);
  return parseResetAnswer(answer) ?? { tabs: 0, code: "UNREAD" };
}
