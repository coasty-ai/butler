import { FIXTURE_HOST } from "./graders";
import {
  BROWSER_EXECUTABLES,
  benchOwnBrowser,
  type StartFacts,
} from "./preflight";
import { FIELD, RECORD, type Run } from "./windows";

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
 * its reset when the surface still names the browser; the end of a cycle
 * asks it for the browsers the cycle used; and the gate asks it for a
 * browser an earlier cycle left (below). Nothing else does.
 *
 * A quit is blocked by a sheet. Cycle 20260919-1952's mail-save-attachment
 * attempt left a Save panel (an AXSheet with Cancel and Save) on a Safari
 * window; `quit saving no` was sent twice before the next two probes, each
 * returned silently and Safari kept its pid, and each probe then read that
 * Safari as the person's and skipped every browser task. The operator
 * cleared it by clicking Cancel on every sheet through System Events, then
 * quitting. So quitBrowser reads the sheets of the browser's windows first
 * (System Events, read-only, sheetsScript), and for the benchmark's own
 * browser only clicks the one button named Cancel on each sheet that has one
 * (cancelSheetsScript: a Save or Open panel, a confirmation; the click
 * discards nothing that was not already the panel's default), waits for the
 * sheets to go, and only then sends the quit. A sheet with no Cancel button
 * is never touched and the quit is not sent (SHEET_UP): an Apple Event to an
 * application showing a sheet can hang for hours (a TextEdit `close`, the
 * morning of 2026-09-19), and the caller says why. Sheets on a browser of
 * the person's are never read: THEIRS comes first, with no event at all.
 *
 * A browser an earlier cycle left running is *bench leftover*, the
 * benchmark's own and not the person's, when two facts hold, read here and
 * judged by benchLeftover, never from window titles alone (about:blank
 * titles carry no token, so the window rule reads such a browser as the
 * person's, which is what skipped the browser tasks of cycles 2032 and
 * 2038): every tab's URL is about:blank (or empty), the browser's own start
 * page (Safari's favorites:// and apple.com start page, Chrome's new tab;
 * START_PAGES), or on the fixture server's origin (tabsScript answers the
 * four counts and nothing else: no URL leaves the browser); and the person
 * has produced no input since the browser launched (the process's age from
 * `ps -o etime`, against the idle the gate reads: the helper's human-only
 * tap clock or HIDIdleTime, whichever is longer; the click that launches an
 * application lands a moment before its process starts, so a launch within
 * LAUNCH_SLACK of the last input counts as the person's). The helper's own
 * synthetic input moves HIDIdleTime like a hand would (docs/VOICE_LOOP.md),
 * so for a browser a cycle launched and then drove, that clock alone always
 * reads "input since launch"; the harness therefore also accepts input since
 * the launch that its own ledgers explain: the last input of any kind fell
 * no later than the harness's own last attempt ended (plus HARNESS_SLACK),
 * and no ledger line since the launch saw a person (a takeover row, a
 * HID_ACTIVE wait). A browser with any other tab is the person's, whatever
 * the clocks say.
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

/* ---------------------------------------------------------------- sheets */

/** The one button the harness ever clicks on a sheet. */
export const CANCEL_BUTTON = "Cancel";
/** How long the cancel script waits for the cancelled sheets to go, in quarter seconds. */
export const SHEET_WAIT_QUARTERS = 8;

/**
 * The sheets of every window of the browser's process, from System Events
 * (read-only, the same target the preflight's window count uses, so no new
 * consent): one record per sheet, holding its buttons' names, each name
 * FIELD-terminated and each record RECORD-terminated, as windows.ts's
 * scripts print theirs. A browser not running answers "" and is never
 * launched: System Events is asked, never the browser. No argument, no
 * interpolation: the bundle id comes from the fixed list.
 */
export function sheetsScript(browserId: string): string {
  if (!RESETTABLE_BROWSERS.includes(browserId) || !BUNDLE_ID.test(browserId))
    throw new Error("Not a resettable browser.");
  return [
    'tell application "System Events"',
    `  set procs to every process whose bundle identifier is "${browserId}"`,
    '  if (count of procs) is 0 then return ""',
    '  set out to ""',
    "  repeat with w in windows of item 1 of procs",
    "    set shs to {}",
    "    try",
    "      set shs to sheets of w",
    "    end try",
    "    repeat with s in shs",
    '      set names to ""',
    "      try",
    "        repeat with b in buttons of s",
    '          set n to ""',
    "          try",
    "            set n to name of b as text",
    "          end try",
    "          set names to names & n & (character id 31)",
    "        end repeat",
    "      end try",
    "      set out to out & names & (character id 30)",
    "    end repeat",
    "  end repeat",
    "  return out",
    "end tell",
  ].join("\n");
}

/**
 * sheetsScript's answer: the button names of each sheet, in memory only (a
 * button's name is UI text of the browser's, never written anywhere).
 * Undefined for anything that is not the script's own format (an error
 * line, a refused query).
 */
export function parseSheetsAnswer(
  stdout: string | undefined,
): string[][] | undefined {
  if (stdout === undefined) return undefined;
  const text = stdout.replace(/\r?\n$/, "");
  if (text === "") return [];
  if (!text.includes(RECORD)) return undefined;
  const rows = text.split(RECORD);
  if (rows.pop() !== "") return undefined;
  const sheets: string[][] = [];
  for (const row of rows) {
    if (row === "") {
      sheets.push([]);
      continue;
    }
    const names = row.split(FIELD);
    if (names.pop() !== "") return undefined;
    sheets.push(names);
  }
  return sheets;
}

/** Whether a sheet, by its buttons' names, can be dismissed with Cancel. */
export const hasCancel = (buttons: readonly string[]): boolean =>
  buttons.includes(CANCEL_BUTTON);

/**
 * Clicks the button named Cancel on every sheet of every window of the
 * browser's process that has one, through System Events (an AXPress: no
 * focus, no pointer, no keystroke), then waits up to two seconds for the
 * sheets to go, and answers "<clicked> <left>": how many it clicked and how
 * many sheets still stand. A sheet with no Cancel button is passed over.
 * The one click, on the one button name; nothing else is pressed, typed or
 * closed. System Events is the only application addressed.
 */
export function cancelSheetsScript(browserId: string): string {
  if (!RESETTABLE_BROWSERS.includes(browserId) || !BUNDLE_ID.test(browserId))
    throw new Error("Not a resettable browser.");
  return [
    'tell application "System Events"',
    `  set procs to every process whose bundle identifier is "${browserId}"`,
    '  if (count of procs) is 0 then return "0 0"',
    "  set n to 0",
    "  repeat with w in windows of item 1 of procs",
    "    set shs to {}",
    "    try",
    "      set shs to sheets of w",
    "    end try",
    "    repeat with s in shs",
    "      try",
    `        if exists button "${CANCEL_BUTTON}" of s then`,
    `          click button "${CANCEL_BUTTON}" of s`,
    "          set n to n + 1",
    "        end if",
    "      end try",
    "    end repeat",
    "  end repeat",
    "  set standing to 0",
    `  repeat ${SHEET_WAIT_QUARTERS} times`,
    "    set standing to 0",
    "    repeat with w in windows of item 1 of procs",
    "      try",
    "        set standing to standing + (count of sheets of w)",
    "      end try",
    "    end repeat",
    "    if standing is 0 then exit repeat",
    "    delay 0.25",
    "  end repeat",
    '  return (n as text) & " " & (standing as text)',
    "end tell",
  ].join("\n");
}

/** cancelSheetsScript's answer; undefined for anything but two counts. */
export function parseCancelAnswer(
  stdout: string | undefined,
): { clicked: number; left: number } | undefined {
  const match = /^\s*(\d{1,6})\s+(\d{1,6})\s*$/.exec(stdout ?? "");
  return match
    ? { clicked: Number(match[1]), left: Number(match[2]) }
    : undefined;
}

/** One sheet the quit met, for the diagnostics (BrowserSheet) and the terminal: counts and a flag, never a name. */
export interface BrowserSheet {
  /** Buttons on the sheet. */
  buttons: number;
  /** The harness clicked its Cancel button. */
  cancelled: boolean;
}

/**
 * The sheets as the row and the trace carry them: a count of buttons each,
 * and whether it was cancelled. The cancel script clicks in the order the
 * read listed the sheets, so the first `clicked` sheets with a Cancel
 * button are the ones it clicked.
 */
export function sheetOutcomes(
  sheets: readonly (readonly string[])[],
  clicked: number,
): BrowserSheet[] {
  let left = clicked;
  return sheets.map((buttons) => {
    const cancelled = hasCancel(buttons) && left > 0;
    if (cancelled) left--;
    return { buttons: buttons.length, cancelled };
  });
}

/** What a quit did, for the attempt row, the gate line and the terminal; never a title. */
export interface BrowserQuit {
  /** The browser was asked to quit and its process had gone when the script returned. */
  quit: boolean;
  /**
   * Why not: the browser scripts nothing (NO_SCRIPT, as for the reset), is
   * the person's by benchOwnBrowser and was never asked (THEIRS), is not
   * running (NOT_RUNNING), shows a sheet the harness would not dismiss (no
   * Cancel button, or one that stayed after the click) so no quit was sent
   * (SHEET_UP), was asked and still ran five seconds later, a dialog
   * holding it (STILL_RUNNING), or did not answer (UNREAD: no Automation
   * consent from this terminal, a hung query).
   */
  code?:
    | "NO_SCRIPT"
    | "THEIRS"
    | "NOT_RUNNING"
    | "SHEET_UP"
    | "STILL_RUNNING"
    | "UNREAD";
  /** The sheets the browser showed when asked, cancelled or not; absent when it showed none. */
  sheets?: BrowserSheet[];
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
 * Quits one browser: only a browser the reset can script, and only one that
 * is the benchmark's own by benchOwnBrowser over the facts given (not
 * running at the start or since, running with no window of the person's,
 * or bench leftover by the rule below), the rule chooseBrowser picks by and
 * resetFixtureTabs navigates under. A browser that rule refuses is the
 * person's: THEIRS, and no Apple Event is sent, not even to read its
 * sheets. For the benchmark's own, the sheets of its windows are read
 * first; each with a Cancel button is cancelled and the script waits for
 * them to go; a sheet with no Cancel button, or one still standing after
 * the click, means no quit is sent (SHEET_UP), since an event to an
 * application showing a sheet may never return. Then `quit saving no`, and
 * up to five seconds for the process to go. Never throws for what the
 * browser does.
 */
export async function quitBrowser(
  run: Run,
  browserId: string,
  facts: Pick<StartFacts, "running" | "windows" | "leftover">,
): Promise<BrowserQuit> {
  if (!RESETTABLE_BROWSERS.includes(browserId))
    return { quit: false, code: "NO_SCRIPT" };
  if (!benchOwnBrowser(browserId, facts))
    return { quit: false, code: "THEIRS" };
  const sheets = parseSheetsAnswer(
    await run("osascript", ["-e", sheetsScript(browserId)]),
  );
  if (sheets === undefined) return { quit: false, code: "UNREAD" };
  let seen = sheetOutcomes(sheets, 0);
  if (sheets.length) {
    if (!sheets.some(hasCancel))
      return { quit: false, code: "SHEET_UP", sheets: seen };
    const cancel = parseCancelAnswer(
      await run("osascript", ["-e", cancelSheetsScript(browserId)]),
    );
    if (!cancel) return { quit: false, code: "UNREAD", sheets: seen };
    seen = sheetOutcomes(sheets, cancel.clicked);
    if (cancel.left > 0) return { quit: false, code: "SHEET_UP", sheets: seen };
  }
  const answer = await run("osascript", ["-e", quitBrowserScript(browserId)]);
  const quit = parseQuitAnswer(answer) ?? { quit: false, code: "UNREAD" };
  return seen.length ? { ...quit, sheets: seen } : quit;
}

/* -------------------------------------------------------------- leftover */

/**
 * Each listed browser's own start pages, as URL prefixes: what a fresh
 * window or a new tab shows before anyone types. Safari's Start Page reads
 * as favorites:// (topsites://, bookmarks:// and history:// are its other
 * built-in pages) and its default home page is apple.com's start page;
 * Chrome's new tab is chrome://newtab/ or chrome://new-tab-page/; Edge's is
 * edge://newtab/ or its MSN page; Brave's is brave://newtab/ over Chrome's.
 * Fixed text from this file, never from a tab.
 */
export const START_PAGES: Readonly<Record<string, readonly string[]>> = {
  "com.apple.Safari": [
    "favorites://",
    "topsites://",
    "bookmarks://",
    "history://",
    "https://www.apple.com/startpage",
  ],
  "com.apple.SafariTechnologyPreview": [
    "favorites://",
    "topsites://",
    "bookmarks://",
    "history://",
    "https://www.apple.com/startpage",
  ],
  "com.google.Chrome": ["chrome://newtab", "chrome://new-tab-page"],
  "com.google.Chrome.canary": ["chrome://newtab", "chrome://new-tab-page"],
  "com.microsoft.edgemac": [
    "edge://newtab",
    "edge://new-tab-page",
    "https://ntp.msn.com/edge/ntp",
  ],
  "com.brave.Browser": [
    "brave://newtab",
    "chrome://newtab",
    "chrome://new-tab-page",
  ],
};
const START_PAGE = /^[a-z][a-z-]*:\/\/[A-Za-z0-9./-]*$/;

/** How many tabs of each kind a browser shows (tabsScript's answer). */
export interface TabCounts {
  /** about:blank, or no URL at all. */
  blank: number;
  /** The browser's own start page (START_PAGES). */
  start: number;
  /** On the fixture server's origin. */
  fixture: number;
  /** Anything else: the person's. */
  other: number;
}

/**
 * The rule the script applies to each tab, in TypeScript, so a test reads
 * what the AppleScript encodes: blank first, then the fixture's origin
 * (onFixtureOrigin), then the browser's own start pages, else other.
 */
export function tabKind(
  url: string,
  browserId: string,
  origin: string,
): keyof TabCounts {
  if (url === "" || url === "about:blank") return "blank";
  if (onFixtureOrigin(url, origin)) return "fixture";
  if ((START_PAGES[browserId] ?? []).some((page) => url.startsWith(page)))
    return "start";
  return "other";
}

/**
 * Counts the browser's tabs by kind (blank, start page, fixture, other) and
 * answers the four counts, or "absent" when the browser is not running:
 * System Events is asked first, since a `tell` to an application that is
 * not running would launch it. The fixture origin comes through argv, never
 * by interpolation; the start pages are this file's constants. Every URL is
 * read into a string and compared inside the browser: none leaves it, so a
 * tab of the person's is counted and never seen. Read-only: nothing is
 * navigated, closed or activated. Variable names are ones no browser's
 * dictionary uses (Chrome's `stop` is a command), since a name that is a
 * term of the application told fails to compile inside its tell block.
 */
export function tabsScript(browserId: string): string {
  if (!RESETTABLE_BROWSERS.includes(browserId) || !BUNDLE_ID.test(browserId))
    throw new Error("Not a resettable browser.");
  const pages = START_PAGES[browserId] ?? [];
  for (const page of pages)
    if (!START_PAGE.test(page)) throw new Error("Not a start page.");
  return [
    "on run argv",
    "  set o to item 1 of argv",
    `  set pages to {${pages.map((page) => `"${page}"`).join(", ")}}`,
    '  tell application "System Events"',
    `    set alive to count of (every process whose bundle identifier is "${browserId}")`,
    "  end tell",
    '  if alive is 0 then return "absent"',
    "  set nBlank to 0",
    "  set nStart to 0",
    "  set nFixture to 0",
    "  set nOther to 0",
    `  tell application id "${browserId}"`,
    "    repeat with w in windows",
    "      repeat with t in tabs of w",
    '        set u to ""',
    "        try",
    "          set u to URL of t as text",
    "        end try",
    '        if (u is "") or (u is "about:blank") then',
    "          set nBlank to nBlank + 1",
    '        else if (u is o) or (u starts with (o & "/")) then',
    "          set nFixture to nFixture + 1",
    "        else",
    "          set known to false",
    "          repeat with p in pages",
    "            if u starts with (p as text) then set known to true",
    "          end repeat",
    "          if known then",
    "            set nStart to nStart + 1",
    "          else",
    "            set nOther to nOther + 1",
    "          end if",
    "        end if",
    "      end repeat",
    "    end repeat",
    "  end tell",
    '  return (nBlank as text) & " " & (nStart as text) & " " & (nFixture as text) & " " & (nOther as text)',
    "end run",
  ].join("\n");
}

/** What a tab count read; never a URL. */
export interface TabsRead {
  tabs?: TabCounts;
  /** As BrowserReset.code: no tab scripting, not running, or no answer. */
  code?: "NO_SCRIPT" | "NOT_RUNNING" | "UNREAD";
}

/** tabsScript's answer: four counts, "absent", or nothing readable. */
export function parseTabsAnswer(stdout: string | undefined): TabsRead {
  const text = (stdout ?? "").trim();
  if (text === "absent") return { code: "NOT_RUNNING" };
  const match = /^(\d{1,6}) (\d{1,6}) (\d{1,6}) (\d{1,6})$/.exec(text);
  if (!match) return { code: "UNREAD" };
  return {
    tabs: {
      blank: Number(match[1]),
      start: Number(match[2]),
      fixture: Number(match[3]),
      other: Number(match[4]),
    },
  };
}

/** Counts one browser's tabs by kind; the fixture URL must be the fixture's (fixtureOrigin), or this throws. */
export async function readTabCounts(
  run: Run,
  browserId: string,
  fixtureUrl: string,
): Promise<TabsRead> {
  const origin = fixtureOrigin(fixtureUrl);
  if (!RESETTABLE_BROWSERS.includes(browserId)) return { code: "NO_SCRIPT" };
  return parseTabsAnswer(
    await run("osascript", ["-e", tabsScript(browserId), origin]),
  );
}

/** `ps -o etime` ("[[dd-]hh:]mm:ss") as seconds; undefined for anything else. */
export function parseEtime(text: string): number | undefined {
  const match = /^(?:(\d+)-)?(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/.exec(
    text.trim(),
  );
  if (!match) return undefined;
  const [, days, hours, minutes, seconds] = match;
  return (
    Number(days ?? 0) * 86400 +
    Number(hours ?? 0) * 3600 +
    Number(minutes) * 60 +
    Number(seconds)
  );
}

/**
 * The browser's main process and its age, from `ps -axo pid=,etime=,command=`
 * (the same executable rule as runningApps: helpers under Frameworks never
 * match). Undefined when it is not running or the line cannot be read.
 */
export function browserUptime(
  psText: string | undefined,
  browserId: string,
): { pid: number; seconds: number } | undefined {
  const executable = BROWSER_EXECUTABLES[browserId];
  if (!executable) return undefined;
  for (const line of (psText ?? "").split("\n")) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match || !executable.test(match[3])) continue;
    const seconds = parseEtime(match[2]);
    if (seconds !== undefined) return { pid: Number(match[1]), seconds };
  }
  return undefined;
}

/** Seconds a launch may follow the last input and still be the person's own click. */
export const LAUNCH_SLACK_SECONDS = 2;
/** Seconds after the harness's last attempt ended within which the last input is taken as the harness's own. */
export const HARNESS_SLACK_SECONDS = 30;

/** What the harness's own ledgers say about input since a browser launched (cycle.ts harnessInput). */
export interface HarnessInput {
  /** Seconds since the harness's last attempt that ran ended, over every ledger under --out-dir; undefined when none has. */
  lastInputAgoSeconds?: number;
  /** A ledger line at or after the launch saw a person: a takeover row, a HID_ACTIVE wait. */
  personSeenSinceLaunch: boolean;
}

/** What benchLeftover judges. */
export interface LeftoverInput {
  tabs: TabCounts;
  /** Seconds since the browser's process started (browserUptime). */
  uptimeSeconds: number;
  /**
   * Seconds since the last input the gate can see: the larger of the
   * helper's human-only tap clock (tapIdleSeconds) and HIDIdleTime, the two
   * readings gateDecision takes its idle from.
   */
  idleSeconds: number;
  /** The harness's own account of its input; absent when no ledger could be read. */
  harness?: HarnessInput;
}

/** Why a browser is or is not bench leftover. */
export type LeftoverCode = "LEFTOVER" | "OTHER_TABS" | "INPUT_SINCE_LAUNCH";

/**
 * Whether the person has produced input since the browser launched, by the
 * clocks: the last input of any kind fell before the launch (less the
 * click that launches an application, which lands a moment before its
 * process starts: LAUNCH_SLACK), or fell no later than the harness's own
 * last attempt ended (HARNESS_SLACK) while that attempt ended after the
 * launch and no ledger line since the launch saw a person, in which case
 * the input since the launch was the harness's own. Anything else is the
 * person's.
 */
export function inputSinceLaunch(
  input: Pick<LeftoverInput, "uptimeSeconds" | "idleSeconds" | "harness">,
): boolean {
  const { uptimeSeconds, idleSeconds, harness } = input;
  if (idleSeconds >= uptimeSeconds + LAUNCH_SLACK_SECONDS) return false;
  if (
    harness &&
    !harness.personSeenSinceLaunch &&
    harness.lastInputAgoSeconds !== undefined &&
    harness.lastInputAgoSeconds <= uptimeSeconds &&
    idleSeconds + HARNESS_SLACK_SECONDS >= harness.lastInputAgoSeconds
  )
    return false;
  return true;
}

/**
 * The rule: bench leftover when no tab is anything but blank, the browser's
 * own start page or the fixture's, and no input since the launch is the
 * person's (inputSinceLaunch). A browser with any other tab is the person's
 * whatever the clocks say (OTHER_TABS), and one someone has typed into
 * since it launched is the person's whatever its tabs (INPUT_SINCE_LAUNCH).
 */
export function benchLeftover(input: LeftoverInput): {
  leftover: boolean;
  code: LeftoverCode;
} {
  if (input.tabs.other > 0) return { leftover: false, code: "OTHER_TABS" };
  if (inputSinceLaunch(input))
    return { leftover: false, code: "INPUT_SINCE_LAUNCH" };
  return { leftover: true, code: "LEFTOVER" };
}
