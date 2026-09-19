import { FIXTURE_HOST } from "./graders";
import { benchOwnBrowser, type StartFacts } from "./preflight";
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
 *
 * The reset is not always enough. A blank tab's WebContent keeps the focused
 * secure field's state until its window goes: in cycle 20260919-1522 Safari
 * held secure event input for 50 minutes with every tab already on
 * about:blank, until the operator quit Safari by hand, which released it at
 * once. So the harness may quit the browser too (quitBrowser below), under
 * the same rule and a stricter guard: only a browser on the list above, and
 * only one benchOwnBrowser says is the benchmark's own, checked here and
 * not left to the caller, so a browser of the person's is never quit and no
 * other application ever is. The quit is `quit saving no` (the Standard
 * Suite every listed browser ships), sent only after System Events says the
 * browser runs, and the script waits up to five seconds for the process to
 * go. The gate asks it once per wait, after a reset has run and the next
 * read still names that browser; the attempt callback asks it once after
 * its reset when the surface still names the browser. Nothing else does.
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

/* ------------------------------------------------------------------ quit */

/** How long the quit script waits for the browser's process to go, in quarter seconds. */
export const QUIT_WAIT_QUARTERS = 20;

/**
 * Quits the browser, and answers "quit" once its process has gone, "quitting"
 * when it is still there after five seconds (a dialog holds it: a download
 * in progress, a page that asks to stay), or "absent" when it was not
 * running. System Events is asked first whether it runs, since a `tell` to
 * an application that is not running would launch it. `quit saving no` is
 * the Standard Suite's; a dictionary that takes the command without the
 * parameter is asked plainly. Nothing variable reaches the script: the
 * bundle id comes from the fixed list and is shaped like one, and the script
 * takes no argument, so nothing is ever interpolated from a name or a title.
 */
export function quitBrowserScript(browserId: string): string {
  if (!RESETTABLE_BROWSERS.includes(browserId) || !BUNDLE_ID.test(browserId))
    throw new Error("Not a resettable browser.");
  const alive = [
    'tell application "System Events"',
    `  set alive to count of (every process whose bundle identifier is "${browserId}")`,
    "end tell",
  ];
  return [
    ...alive,
    'if alive is 0 then return "absent"',
    `tell application id "${browserId}"`,
    "  try",
    "    quit saving no",
    "  on error",
    "    quit",
    "  end try",
    "end tell",
    `repeat ${QUIT_WAIT_QUARTERS} times`,
    ...alive.map((line) => "  " + line),
    '  if alive is 0 then return "quit"',
    "  delay 0.25",
    "end repeat",
    'return "quitting"',
  ].join("\n");
}

/** What a quit did, for the attempt row, the gate line and the terminal; never a title. */
export interface BrowserQuit {
  /** The browser was asked to quit and its process had gone when the script returned. */
  quit: boolean;
  /**
   * Why not: the browser scripts nothing (NO_SCRIPT, as for the reset), is
   * the person's by benchOwnBrowser and was never asked (THEIRS), is not
   * running (NOT_RUNNING), was asked and still ran five seconds later, a
   * dialog holding it (STILL_RUNNING), or did not answer (UNREAD: no
   * Automation consent from this terminal, a hung query).
   */
  code?: "NO_SCRIPT" | "THEIRS" | "NOT_RUNNING" | "STILL_RUNNING" | "UNREAD";
}

/** The quit script's answer; undefined for anything but its three words. */
export function parseQuitAnswer(
  stdout: string | undefined,
): BrowserQuit | undefined {
  const text = (stdout ?? "").trim();
  if (text === "absent") return { quit: false, code: "NOT_RUNNING" };
  if (text === "quit") return { quit: true };
  if (text === "quitting") return { quit: false, code: "STILL_RUNNING" };
  return undefined;
}

/**
 * Quits one browser when a blank fixture tab still holds secure event input:
 * only a browser the reset can script, and only one that is the benchmark's
 * own by benchOwnBrowser over the facts given (not running at the start or
 * since, or running with no window of the person's), the rule chooseBrowser
 * picks by and resetFixtureTabs navigates under. A browser that rule
 * refuses is the person's: THEIRS, and no Apple Event is sent. Never
 * throws for what the browser does.
 */
export async function quitBrowser(
  run: Run,
  browserId: string,
  facts: Pick<StartFacts, "running" | "windows">,
): Promise<BrowserQuit> {
  if (!RESETTABLE_BROWSERS.includes(browserId))
    return { quit: false, code: "NO_SCRIPT" };
  if (!benchOwnBrowser(browserId, facts))
    return { quit: false, code: "THEIRS" };
  const answer = await run("osascript", ["-e", quitBrowserScript(browserId)]);
  return parseQuitAnswer(answer) ?? { quit: false, code: "UNREAD" };
}
