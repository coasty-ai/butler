import { describe, expect, it } from "vitest";
import {
  CANCEL_BUTTON,
  HARNESS_SLACK_SECONDS,
  LAUNCH_SLACK_SECONDS,
  QUIT_WAIT_QUARTERS,
  RESETTABLE_BROWSERS,
  SHEET_WAIT_QUARTERS,
  START_PAGES,
  benchLeftover,
  browserUptime,
  cancelSheetsScript,
  fixtureOrigin,
  hasCancel,
  inputSinceLaunch,
  onFixtureOrigin,
  parseCancelAnswer,
  parseEtime,
  parseQuitAnswer,
  parseResetAnswer,
  parseSheetsAnswer,
  parseTabsAnswer,
  quitBrowser,
  quitBrowserScript,
  readTabCounts,
  resetFixtureTabs,
  resetTabsScript,
  sheetOutcomes,
  sheetsScript,
  tabKind,
  tabsScript,
  type TabCounts,
} from "../src/gym/bench/browser-reset";
import {
  BROWSER_APPS,
  FIXTURE_HOST,
  FIXTURE_PORT,
} from "../src/gym/bench/graders";
import { benchOwnBrowser } from "../src/gym/bench/preflight";
import { FIELD, RECORD } from "../src/gym/bench/windows";

const SAFARI = "com.apple.Safari";
const CHROME = "com.google.Chrome";
const ORIGIN = `http://${FIXTURE_HOST}:${FIXTURE_PORT}`;

describe("browser reset: the script", () => {
  it("navigates, and only navigates: never types, clicks, launches, closes, quits or deletes", () => {
    for (const id of RESETTABLE_BROWSERS) {
      const script = resetTabsScript(id);
      expect(script).not.toMatch(
        /keystroke|key code|\bclick\b|do shell script|\bquit\b|\bdelete\b|\bclose\b|\bmake\b|\bactivate\b|\blaunch\b|\bopen\b|\bsave\b/,
      );
      // The one write, to the one value.
      expect(script.match(/set URL of t to/g)).toHaveLength(1);
      expect(script).toContain('set URL of t to "about:blank"');
      // The origin comes through argv; the browser by bundle id from the
      // fixed list, never by a name.
      expect(script).toMatch(/^on run argv\n {2}set o to item 1 of argv\n/);
      expect(script).toContain(`tell application id "${id}"`);
      expect(script).not.toMatch(/\$\{/);
      // A tell to a browser that is not running would launch it: System
      // Events is asked first whether it runs.
      expect(script).toContain(
        `count of (every process whose bundle identifier is "${id}")`,
      );
      expect(script).toContain('if alive is 0 then return "absent"');
      expect(script.indexOf('if alive is 0 then return "absent"')).toBeLessThan(
        script.indexOf(`tell application id "${id}"`),
      );
      // Only a tab on the origin itself or on a path under it; the URL is
      // read into a string first, so an empty tab reads as "".
      expect(script).toContain("set u to URL of t as text");
      expect(script).toContain('if (u is o) or (u starts with (o & "/")) then');
      expect(script).toContain("return n as text");
    }
    expect(RESETTABLE_BROWSERS).toContain(SAFARI);
    expect(RESETTABLE_BROWSERS).toContain(CHROME);
    for (const id of RESETTABLE_BROWSERS) expect(BROWSER_APPS).toContain(id);
    // Browsers with no tab scripting, and anything that is not a listed
    // bundle id, get no script at all.
    expect(() => resetTabsScript("org.mozilla.firefox")).toThrow();
    expect(() => resetTabsScript("company.thebrowser.Browser")).toThrow();
    expect(() => resetTabsScript("com.apple.finder")).toThrow();
    expect(() =>
      resetTabsScript('com.apple.Safari" & (do shell script "id")'),
    ).toThrow();
  });

  it("takes the fixture's origin and nothing else", () => {
    expect(fixtureOrigin(ORIGIN)).toBe(ORIGIN);
    expect(fixtureOrigin(`${ORIGIN}/benchnote1a2b/orders?x=1`)).toBe(ORIGIN);
    expect(fixtureOrigin("http://127.0.0.1:50123")).toBe(
      "http://127.0.0.1:50123",
    );
    for (const bad of [
      "http://localhost:47831",
      "https://127.0.0.1:47831",
      "http://127.0.0.1",
      "http://example.com:47831",
      "http://user:pw@127.0.0.1:47831",
      "about:blank",
      "",
      "not a url",
      "file:///Users/x",
    ])
      expect(() => fixtureOrigin(bad), bad).toThrow();
    // The rule the script applies to each tab, in TypeScript: the origin
    // itself or a path under it, and nothing on another host or port.
    expect(onFixtureOrigin(ORIGIN, ORIGIN)).toBe(true);
    expect(onFixtureOrigin(`${ORIGIN}/`, ORIGIN)).toBe(true);
    expect(onFixtureOrigin(`${ORIGIN}/benchnote1a2b/login`, ORIGIN)).toBe(true);
    for (const other of [
      "about:blank",
      "",
      "http://127.0.0.1:3000/",
      `${ORIGIN}0/x`,
      "https://bank.example/login",
      `https://evil.example/?u=${ORIGIN}/`,
      "http://localhost:47831/",
      `https://127.0.0.1:${FIXTURE_PORT}/`,
    ])
      expect(onFixtureOrigin(other, ORIGIN), other).toBe(false);
  });
});

describe("browser reset: the reset", () => {
  const fake = (answer: string | undefined) => {
    const calls: string[][] = [];
    const run = async (command: string, args: string[]) => {
      calls.push([command, ...args]);
      return answer;
    };
    return { calls, run };
  };

  it("asks the browser once, with the origin as its argument, and reads the count", async () => {
    const safari = fake("2\n");
    expect(await resetFixtureTabs(safari.run, SAFARI, ORIGIN)).toEqual({
      tabs: 2,
    });
    expect(safari.calls).toEqual([
      ["osascript", "-e", resetTabsScript(SAFARI), ORIGIN],
    ]);
    // A page URL gives the same origin; Chrome gets Chrome's script.
    const chrome = fake("0");
    expect(
      await resetFixtureTabs(chrome.run, CHROME, `${ORIGIN}/benchnote1/x`),
    ).toEqual({ tabs: 0 });
    expect(chrome.calls).toEqual([
      ["osascript", "-e", resetTabsScript(CHROME), ORIGIN],
    ]);
  });

  it("says when the browser is not running, has no script or did not answer, and never asks a browser it cannot script", async () => {
    expect(await resetFixtureTabs(fake("absent").run, SAFARI, ORIGIN)).toEqual({
      tabs: 0,
      code: "NOT_RUNNING",
    });
    expect(await resetFixtureTabs(fake(undefined).run, SAFARI, ORIGIN)).toEqual(
      { tabs: 0, code: "UNREAD" },
    );
    expect(
      await resetFixtureTabs(fake("execution error: x").run, SAFARI, ORIGIN),
    ).toEqual({ tabs: 0, code: "UNREAD" });
    const firefox = fake("3");
    expect(
      await resetFixtureTabs(firefox.run, "org.mozilla.firefox", ORIGIN),
    ).toEqual({ tabs: 0, code: "NO_SCRIPT" });
    expect(firefox.calls).toEqual([]);
    // A URL that is not the fixture's is a wiring fault: nothing runs.
    const other = fake("3");
    await expect(
      resetFixtureTabs(other.run, SAFARI, "https://bank.example"),
    ).rejects.toThrow();
    expect(other.calls).toEqual([]);
    expect(parseResetAnswer("  7 \n")).toEqual({ tabs: 7 });
    expect(parseResetAnswer("absent")).toEqual({
      tabs: 0,
      code: "NOT_RUNNING",
    });
    expect(parseResetAnswer("7 tabs")).toBeUndefined();
    expect(parseResetAnswer("")).toBeUndefined();
    expect(parseResetAnswer(undefined)).toBeUndefined();
  });
});

describe("browser quit: the script", () => {
  it("quits, and only quits: after System Events says the browser runs, with saving no, then waits for the process to go", () => {
    for (const id of RESETTABLE_BROWSERS) {
      const script = quitBrowserScript(id);
      expect(script).not.toMatch(
        /keystroke|key code|\bclick\b|do shell script|\bdelete\b|\bclose\b|\bmake\b|\bactivate\b|\blaunch\b|\bopen\b|\bsave\b|set URL/,
      );
      // Nothing variable reaches it: no argument, no interpolation, and the
      // browser by bundle id from the fixed list, once, with no other
      // application's id anywhere in it.
      expect(script).not.toMatch(/argv|\$\{/);
      expect(script.match(/tell application id /g)).toHaveLength(1);
      expect(script).toContain(`tell application id "${id}"`);
      for (const other of [
        ...RESETTABLE_BROWSERS.filter((x) => x !== id),
        "com.apple.finder",
        "com.apple.Terminal",
        "com.1password.1password",
      ])
        expect(script).not.toContain(`"${other}"`);
      // A tell to a browser that is not running would launch it: System
      // Events is asked first whether it runs.
      const alive = `count of (every process whose bundle identifier is "${id}")`;
      expect(script.indexOf(alive)).toBeLessThan(
        script.indexOf(`tell application id "${id}"`),
      );
      expect(script).toContain('if alive is 0 then return "absent"');
      // The one command, with saving no, and plainly should the dictionary
      // refuse the parameter; the words "quit" in the script are that
      // command twice and the answer once.
      expect(script).toMatch(
        /try\n\s+quit saving no\n\s+on error\n\s+quit\n\s+end try/,
      );
      expect(script.match(/\bquit\b/g)).toHaveLength(3);
      // Then it waits for the process to go, a quarter second at a time, at
      // most five seconds, well inside the runner's ten-second limit, and
      // says which it saw.
      expect(script).toContain(`repeat ${QUIT_WAIT_QUARTERS} times`);
      expect(QUIT_WAIT_QUARTERS * 0.25).toBeLessThanOrEqual(5);
      expect(script).toContain("delay 0.25");
      expect(script).toContain('if alive is 0 then return "quit"');
      expect(script.trim().endsWith('return "quitting"')).toBe(true);
    }
    // Browsers with no scripting dictionary for it, applications that are no
    // browser, and anything not shaped like a listed bundle id: no script.
    for (const bad of [
      "org.mozilla.firefox",
      "company.thebrowser.Browser",
      "com.apple.finder",
      "com.apple.Terminal",
      "com.1password.1password",
      'com.apple.Safari" & (do shell script "id")',
      "",
    ])
      expect(() => quitBrowserScript(bad), bad).toThrow();
  });
});

describe("browser sheets: the scripts", () => {
  /** A sheet as the read script prints it: its buttons' names, each FIELD-terminated, then RECORD. */
  const sheet = (...buttons: string[]) =>
    buttons.map((name) => name + FIELD).join("") + RECORD;

  it("reads the sheets' button names through System Events alone, and reads only", () => {
    for (const id of RESETTABLE_BROWSERS) {
      const script = sheetsScript(id);
      expect(script).not.toMatch(
        /keystroke|key code|\bclick\b|do shell script|\bquit\b|\bdelete\b|\bclose\b|\bmake\b|\bactivate\b|\blaunch\b|\bopen\b|\bsave\b|set URL|tell application id/,
      );
      // System Events is the only application addressed: a tell to the
      // browser could launch it or queue behind its sheet.
      expect(script.match(/tell application/g)).toHaveLength(1);
      expect(script).toContain('tell application "System Events"');
      expect(script).toContain(`bundle identifier is "${id}"`);
      expect(script).not.toMatch(/argv|\$\{/);
      for (const other of RESETTABLE_BROWSERS.filter((x) => x !== id))
        expect(script).not.toContain(`"${other}"`);
      expect(script).toContain('if (count of procs) is 0 then return ""');
      expect(script).toContain("set shs to sheets of w");
      expect(script).toContain("set n to name of b as text");
      expect(script).toContain("set names to names & n & (character id 31)");
      expect(script).toContain("set out to out & names & (character id 30)");
    }
    for (const bad of [
      "org.mozilla.firefox",
      "com.apple.finder",
      "com.apple.TextEdit",
      'com.apple.Safari" & (do shell script "id")',
      "",
    ])
      expect(() => sheetsScript(bad), bad).toThrow();
  });

  it("reads the answer: one record per sheet, names in memory, nothing else", () => {
    expect(parseSheetsAnswer("\n")).toEqual([]);
    expect(parseSheetsAnswer("")).toEqual([]);
    expect(parseSheetsAnswer(sheet("Cancel", "Save") + "\n")).toEqual([
      ["Cancel", "Save"],
    ]);
    expect(
      parseSheetsAnswer(sheet("Cancel", "Save") + sheet("OK") + sheet()),
    ).toEqual([["Cancel", "Save"], ["OK"], []]);
    // A button with no readable name is "".
    expect(parseSheetsAnswer(sheet("", "Cancel"))).toEqual([["", "Cancel"]]);
    // An error line, a refused query or a record without its terminator is
    // not an answer.
    expect(parseSheetsAnswer(undefined)).toBeUndefined();
    expect(
      parseSheetsAnswer("execution error: Not authorized to send Apple events"),
    ).toBeUndefined();
    expect(
      parseSheetsAnswer("Cancel" + FIELD + "Save" + FIELD),
    ).toBeUndefined();
    expect(parseSheetsAnswer("Cancel" + RECORD)).toBeUndefined();
    expect(hasCancel(["Cancel", "Save"])).toBe(true);
    expect(hasCancel(["Don't Save", "Save"])).toBe(false);
    expect(hasCancel([])).toBe(false);
    expect(CANCEL_BUTTON).toBe("Cancel");
    // Outcomes: the first `clicked` sheets with a Cancel button are the
    // cancelled ones, in the order they were read; counts only.
    expect(
      sheetOutcomes([["Cancel", "Save"], ["OK"], ["Cancel", "Replace"]], 2),
    ).toEqual([
      { buttons: 2, cancelled: true },
      { buttons: 1, cancelled: false },
      { buttons: 2, cancelled: true },
    ]);
    expect(sheetOutcomes([["Cancel", "Save"], ["Cancel"]], 1)).toEqual([
      { buttons: 2, cancelled: true },
      { buttons: 1, cancelled: false },
    ]);
    expect(sheetOutcomes([["Cancel", "Save"]], 0)).toEqual([
      { buttons: 2, cancelled: false },
    ]);
  });

  it("clicks nothing but a button named Cancel, through System Events alone, then waits for the sheets to go", () => {
    for (const id of RESETTABLE_BROWSERS) {
      const script = cancelSheetsScript(id);
      expect(script).not.toMatch(
        /keystroke|key code|do shell script|\bquit\b|\bdelete\b|\bclose\b|\bmake\b|\bactivate\b|\blaunch\b|\bopen\b|\bsave\b|set URL|tell application id|\bperform\b|\bselect\b/,
      );
      expect(script.match(/tell application/g)).toHaveLength(1);
      expect(script).toContain('tell application "System Events"');
      expect(script).toContain(`bundle identifier is "${id}"`);
      expect(script).not.toMatch(/argv|\$\{/);
      // Every click in the script is the one click, on the one button name,
      // behind an existence check.
      const clicks = script.match(/\bclick\b.*$/gm) ?? [];
      expect(clicks).toEqual([`click button "${CANCEL_BUTTON}" of s`]);
      expect(script).toContain(`if exists button "${CANCEL_BUTTON}" of s then`);
      expect(script).toContain('if (count of procs) is 0 then return "0 0"');
      // Then it waits for the cancelled sheets to go, at most two seconds,
      // and answers what it clicked and what stands.
      expect(script).toContain(`repeat ${SHEET_WAIT_QUARTERS} times`);
      expect(SHEET_WAIT_QUARTERS * 0.25).toBeLessThanOrEqual(2);
      expect(script).toContain(
        "set standing to standing + (count of sheets of w)",
      );
      expect(script).toContain("if standing is 0 then exit repeat");
      expect(script.trim().endsWith("end tell")).toBe(true);
      expect(script).toContain('return (n as text) & " " & (standing as text)');
    }
    for (const bad of [
      "org.mozilla.firefox",
      "com.apple.finder",
      "com.apple.TextEdit",
      'com.apple.Safari" & (do shell script "id")',
    ])
      expect(() => cancelSheetsScript(bad), bad).toThrow();
    expect(parseCancelAnswer("1 0\n")).toEqual({ clicked: 1, left: 0 });
    expect(parseCancelAnswer("2 1")).toEqual({ clicked: 2, left: 1 });
    expect(parseCancelAnswer("0 0")).toEqual({ clicked: 0, left: 0 });
    expect(parseCancelAnswer("1")).toBeUndefined();
    expect(parseCancelAnswer("clicked")).toBeUndefined();
    expect(parseCancelAnswer(undefined)).toBeUndefined();
  });
});

describe("browser quit: the quit", () => {
  /** A sheet as the read script prints it. */
  const sheet = (...buttons: string[]) =>
    buttons.map((name) => name + FIELD).join("") + RECORD;
  /**
   * A browser as the three scripts see it: its sheets (read before the
   * quit), what the cancel script does to them (every Cancel button clicked
   * and, unless `sheetsStay`, the sheet gone), and what the quit answers.
   * `broken` scripts answer nothing. Every call is kept in order.
   */
  const browser = (
    id: string,
    state: {
      sheets?: string[][];
      sheetsStay?: boolean;
      quit?: string;
      broken?: ("sheets" | "cancel" | "quit")[];
    } = {},
  ) => {
    const calls: string[][] = [];
    let sheets = [...(state.sheets ?? [])];
    const broken = new Set(state.broken ?? []);
    const run = async (command: string, args: string[]) => {
      calls.push([command, ...args]);
      expect(command).toBe("osascript");
      expect(args[0]).toBe("-e");
      const script = args[1];
      if (script === sheetsScript(id)) {
        if (broken.has("sheets")) return undefined;
        return sheets.map((buttons) => sheet(...buttons)).join("") + "\n";
      }
      if (script === cancelSheetsScript(id)) {
        if (broken.has("cancel")) return undefined;
        const clicked = sheets.filter(hasCancel).length;
        if (!state.sheetsStay) sheets = sheets.filter((b) => !hasCancel(b));
        return `${clicked} ${sheets.length}\n`;
      }
      if (script === quitBrowserScript(id)) {
        if (broken.has("quit")) return undefined;
        return (state.quit ?? "quit") + "\n";
      }
      throw new Error(`unexpected script:\n${script}`);
    };
    const kinds = () =>
      calls.map((call) =>
        call[2] === sheetsScript(id)
          ? "sheets"
          : call[2] === cancelSheetsScript(id)
            ? "cancel"
            : "quit",
      );
    return { run, calls, kinds };
  };
  const theirWindow = {
    running: new Set([SAFARI]),
    windows: { [SAFARI]: { windows: 2, foreign: 1 } },
  };

  it("reads the sheets, then quits the benchmark's own browser, and reads whether it went", async () => {
    // Not running by the facts (an attempt launched it): the benchmark's.
    // No sheet: the read, then the quit, and nothing else.
    const gone = browser(SAFARI);
    expect(await quitBrowser(gone.run, SAFARI, {})).toEqual({ quit: true });
    expect(gone.kinds()).toEqual(["sheets", "quit"]);
    expect(gone.calls).toEqual([
      ["osascript", "-e", sheetsScript(SAFARI)],
      ["osascript", "-e", quitBrowserScript(SAFARI)],
    ]);
    // Running with no window of the person's: the benchmark's too.
    const blank = browser(CHROME);
    expect(
      await quitBrowser(blank.run, CHROME, {
        running: new Set([CHROME]),
        windows: { [CHROME]: { windows: 1, foreign: 0 } },
      }),
    ).toEqual({ quit: true });
    expect(blank.kinds()).toEqual(["sheets", "quit"]);
    // Bench leftover by the rule (facts.leftover): the benchmark's, though
    // its windows read as the person's.
    const leftover = browser(SAFARI);
    expect(
      await quitBrowser(leftover.run, SAFARI, {
        ...theirWindow,
        leftover: new Set([SAFARI]),
      }),
    ).toEqual({ quit: true });
    expect(leftover.kinds()).toEqual(["sheets", "quit"]);
    // Asked and still there five seconds later (a dialog holds it), not
    // running after all, or no answer: not quit, and the code says which.
    expect(
      await quitBrowser(browser(SAFARI, { quit: "quitting" }).run, SAFARI, {}),
    ).toEqual({ quit: false, code: "STILL_RUNNING" });
    expect(
      await quitBrowser(browser(SAFARI, { quit: "absent" }).run, SAFARI, {}),
    ).toEqual({ quit: false, code: "NOT_RUNNING" });
    expect(
      await quitBrowser(browser(SAFARI, { broken: ["quit"] }).run, SAFARI, {}),
    ).toEqual({ quit: false, code: "UNREAD" });
    expect(
      await quitBrowser(
        browser(SAFARI, { quit: "execution error: Not authorized" }).run,
        SAFARI,
        {},
      ),
    ).toEqual({ quit: false, code: "UNREAD" });
    // The sheets could not be read: nothing is sent to the browser.
    const unread = browser(SAFARI, { broken: ["sheets"] });
    expect(await quitBrowser(unread.run, SAFARI, {})).toEqual({
      quit: false,
      code: "UNREAD",
    });
    expect(unread.kinds()).toEqual(["sheets"]);
    expect(parseQuitAnswer(" quit \n")).toEqual({ quit: true });
    expect(parseQuitAnswer("quitting")).toEqual({
      quit: false,
      code: "STILL_RUNNING",
    });
    expect(parseQuitAnswer("absent")).toEqual({
      quit: false,
      code: "NOT_RUNNING",
    });
    expect(parseQuitAnswer("quit now")).toBeUndefined();
    expect(parseQuitAnswer("")).toBeUndefined();
    expect(parseQuitAnswer(undefined)).toBeUndefined();
  });

  it("cancels a Save panel before the quit, and sends no quit past a sheet it would not dismiss", async () => {
    // Cycle 20260919-1952: a Save panel (Cancel, Save) on one window blocked
    // two plain quits. Now: the read, the cancel, then the quit, with the
    // sheet on the answer as counts.
    const panel = browser(SAFARI, { sheets: [["Cancel", "Save"]] });
    expect(await quitBrowser(panel.run, SAFARI, {})).toEqual({
      quit: true,
      sheets: [{ buttons: 2, cancelled: true }],
    });
    expect(panel.kinds()).toEqual(["sheets", "cancel", "quit"]);
    // Two sheets, one with no Cancel button: the one is cancelled, the
    // other stands, and no quit is sent (SHEET_UP).
    const mixed = browser(SAFARI, {
      sheets: [
        ["Cancel", "Save"],
        ["Don't Save", "Save"],
      ],
    });
    expect(await quitBrowser(mixed.run, SAFARI, {})).toEqual({
      quit: false,
      code: "SHEET_UP",
      sheets: [
        { buttons: 2, cancelled: true },
        { buttons: 2, cancelled: false },
      ],
    });
    expect(mixed.kinds()).toEqual(["sheets", "cancel"]);
    // No sheet has a Cancel button: nothing is clicked and nothing is sent
    // to the browser.
    const alert = browser(SAFARI, { sheets: [["OK"]] });
    expect(await quitBrowser(alert.run, SAFARI, {})).toEqual({
      quit: false,
      code: "SHEET_UP",
      sheets: [{ buttons: 1, cancelled: false }],
    });
    expect(alert.kinds()).toEqual(["sheets"]);
    // The click did not land (the sheet stayed): SHEET_UP, no quit.
    const stuck = browser(SAFARI, {
      sheets: [["Cancel", "Save"]],
      sheetsStay: true,
    });
    expect(await quitBrowser(stuck.run, SAFARI, {})).toEqual({
      quit: false,
      code: "SHEET_UP",
      sheets: [{ buttons: 2, cancelled: true }],
    });
    expect(stuck.kinds()).toEqual(["sheets", "cancel"]);
    // The cancel script did not answer: UNREAD, no quit.
    const mute = browser(SAFARI, {
      sheets: [["Cancel", "Save"]],
      broken: ["cancel"],
    });
    expect(await quitBrowser(mute.run, SAFARI, {})).toEqual({
      quit: false,
      code: "UNREAD",
      sheets: [{ buttons: 2, cancelled: false }],
    });
    expect(mute.kinds()).toEqual(["sheets", "cancel"]);
    // Cancelled, quit sent, and the browser still ran: the sheet stays on
    // the answer beside the code.
    const held = browser(SAFARI, {
      sheets: [["Cancel", "Save"]],
      quit: "quitting",
    });
    expect(await quitBrowser(held.run, SAFARI, {})).toEqual({
      quit: false,
      code: "STILL_RUNNING",
      sheets: [{ buttons: 2, cancelled: true }],
    });
  });

  it("never quits a browser of the person's, one it cannot script, or any other application, and reads none of their sheets", async () => {
    // Running with a window of the person's: theirs, and no Apple Event,
    // not even the sheets read.
    const theirs = browser(SAFARI, { sheets: [["Cancel", "Save"]] });
    expect(await quitBrowser(theirs.run, SAFARI, theirWindow)).toEqual({
      quit: false,
      code: "THEIRS",
    });
    expect(theirs.calls).toEqual([]);
    // Running with its windows unread (a dry run, a refused query): theirs.
    const unread = browser(SAFARI);
    expect(
      await quitBrowser(unread.run, SAFARI, { running: new Set([SAFARI]) }),
    ).toEqual({ quit: false, code: "THEIRS" });
    expect(unread.calls).toEqual([]);
    // The rule is benchOwnBrowser's, the one chooseBrowser picks by and the
    // reset navigates under: of two running browsers, the one with the
    // person's window is refused and the one with only fixture windows is
    // asked.
    const facts = {
      running: new Set([SAFARI, CHROME]),
      windows: {
        [SAFARI]: { windows: 1, foreign: 1 },
        [CHROME]: { windows: 1, foreign: 0 },
      },
    };
    expect(benchOwnBrowser(SAFARI, facts)).toBe(false);
    expect(benchOwnBrowser(CHROME, facts)).toBe(true);
    const refused = browser(SAFARI);
    expect((await quitBrowser(refused.run, SAFARI, facts)).code).toBe("THEIRS");
    expect(refused.calls).toEqual([]);
    expect(await quitBrowser(browser(CHROME).run, CHROME, facts)).toEqual({
      quit: true,
    });
    // A leftover set naming the other browser changes nothing for this one.
    expect(
      (
        await quitBrowser(browser(SAFARI).run, SAFARI, {
          ...facts,
          leftover: new Set([CHROME]),
        })
      ).code,
    ).toBe("THEIRS");
    // Not scriptable, or no browser at all: nothing runs, whatever the
    // facts say about it.
    for (const id of [
      "org.mozilla.firefox",
      "company.thebrowser.Browser",
      "com.apple.finder",
      "com.apple.Terminal",
      "com.1password.1password",
    ]) {
      const calls: string[][] = [];
      const other = async (command: string, args: string[]) => {
        calls.push([command, ...args]);
        return "quit";
      };
      expect(await quitBrowser(other, id, {}), id).toEqual({
        quit: false,
        code: "NO_SCRIPT",
      });
      expect(calls).toEqual([]);
    }
  });
});

describe("bench leftover: the tabs", () => {
  const counts = (over: Partial<TabCounts> = {}): TabCounts => ({
    blank: 0,
    start: 0,
    fixture: 0,
    other: 0,
    ...over,
  });

  it("sorts each tab: blank, the fixture's, the browser's own start page, else the person's", () => {
    for (const url of ["", "about:blank"])
      for (const id of RESETTABLE_BROWSERS)
        expect(tabKind(url, id, ORIGIN), `${id} ${url}`).toBe("blank");
    expect(tabKind(ORIGIN, SAFARI, ORIGIN)).toBe("fixture");
    expect(tabKind(`${ORIGIN}/benchnote1a2b/mail`, CHROME, ORIGIN)).toBe(
      "fixture",
    );
    // Cycle 1952's Safari: 24 about:blank tabs, one favorites://, one
    // apple.com start page.
    expect(tabKind("favorites://", SAFARI, ORIGIN)).toBe("start");
    expect(tabKind("https://www.apple.com/startpage/", SAFARI, ORIGIN)).toBe(
      "start",
    );
    expect(tabKind("chrome://newtab/", CHROME, ORIGIN)).toBe("start");
    expect(tabKind("chrome://new-tab-page/", CHROME, ORIGIN)).toBe("start");
    expect(tabKind("edge://newtab/", "com.microsoft.edgemac", ORIGIN)).toBe(
      "start",
    );
    expect(tabKind("brave://newtab/", "com.brave.Browser", ORIGIN)).toBe(
      "start",
    );
    // One browser's start page is another's other tab.
    expect(tabKind("chrome://newtab/", SAFARI, ORIGIN)).toBe("other");
    expect(tabKind("favorites://", CHROME, ORIGIN)).toBe("other");
    // Anything of the person's, a page on apple.com included, another
    // loopback port, another host carrying the origin in its query.
    for (const url of [
      "https://www.apple.com/",
      "https://www.apple.com/mac/",
      "https://mail.example/inbox",
      "http://127.0.0.1:3000/",
      "http://localhost:47831/",
      `https://evil.example/?u=${ORIGIN}/`,
      `${ORIGIN}0/x`,
      "file:///Users/x/notes.html",
    ])
      expect(tabKind(url, SAFARI, ORIGIN), url).toBe("other");
    // Every listed browser has its start pages, each a fixed prefix.
    for (const id of RESETTABLE_BROWSERS) {
      expect(START_PAGES[id]?.length, id).toBeGreaterThan(0);
      for (const page of START_PAGES[id])
        expect(page).toMatch(/^[a-z][a-z-]*:\/\/[A-Za-z0-9./-]*$/);
    }
  });

  it("counts through a read-only script: the origin by argv, the start pages as this file's constants, no URL out", () => {
    for (const id of RESETTABLE_BROWSERS) {
      const script = tabsScript(id);
      expect(script).not.toMatch(
        /keystroke|key code|\bclick\b|do shell script|\bquit\b|\bdelete\b|\bclose\b|\bmake\b|\bactivate\b|\blaunch\b|\bopen\b|\bsave\b|set URL of/,
      );
      expect(script).toMatch(/^on run argv\n {2}set o to item 1 of argv\n/);
      expect(script).not.toMatch(/\$\{/);
      expect(script).toContain(`tell application id "${id}"`);
      expect(script.match(/tell application id /g)).toHaveLength(1);
      for (const other of RESETTABLE_BROWSERS.filter((x) => x !== id))
        expect(script).not.toContain(`"${other}"`);
      // System Events first: a tell to a browser not running would launch it.
      expect(script.indexOf('if alive is 0 then return "absent"')).toBeLessThan(
        script.indexOf(`tell application id "${id}"`),
      );
      // The URL is read into a string and compared inside the browser: the
      // answer is four counts.
      expect(script).toContain("set u to URL of t as text");
      expect(script).toContain('if (u is "") or (u is "about:blank") then');
      expect(script).toContain(
        'else if (u is o) or (u starts with (o & "/")) then',
      );
      for (const page of START_PAGES[id]) expect(script).toContain(`"${page}"`);
      // No variable named like a term of a browser's dictionary (Chrome's
      // `stop`, `save`, `print`), which fails to compile inside its tell.
      expect(script).not.toMatch(
        /\bset (start|stop|left|save|print|other|blank) to\b/,
      );
      expect(script).toContain(
        'return (nBlank as text) & " " & (nStart as text) & " " & (nFixture as text) & " " & (nOther as text)',
      );
    }
    expect(() => tabsScript("org.mozilla.firefox")).toThrow();
    expect(() => tabsScript("com.apple.finder")).toThrow();
    expect(() =>
      tabsScript('com.apple.Safari" & (do shell script "id")'),
    ).toThrow();
    expect(parseTabsAnswer("24 2 0 0\n")).toEqual({
      tabs: counts({ blank: 24, start: 2 }),
    });
    expect(parseTabsAnswer("0 0 3 1")).toEqual({
      tabs: counts({ fixture: 3, other: 1 }),
    });
    expect(parseTabsAnswer("absent")).toEqual({ code: "NOT_RUNNING" });
    expect(parseTabsAnswer("24 2 0")).toEqual({ code: "UNREAD" });
    expect(parseTabsAnswer("execution error: x")).toEqual({ code: "UNREAD" });
    expect(parseTabsAnswer(undefined)).toEqual({ code: "UNREAD" });
  });

  it("asks the browser once with the origin as its argument, and never a browser it cannot script or a URL that is not the fixture's", async () => {
    const calls: string[][] = [];
    const run = async (command: string, args: string[]) => {
      calls.push([command, ...args]);
      return "24 2 0 0\n";
    };
    expect(await readTabCounts(run, SAFARI, ORIGIN)).toEqual({
      tabs: counts({ blank: 24, start: 2 }),
    });
    expect(calls).toEqual([["osascript", "-e", tabsScript(SAFARI), ORIGIN]]);
    calls.length = 0;
    expect(
      await readTabCounts(run, "org.mozilla.firefox", `${ORIGIN}/x`),
    ).toEqual({ code: "NO_SCRIPT" });
    expect(calls).toEqual([]);
    await expect(
      readTabCounts(run, SAFARI, "https://bank.example"),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});

describe("bench leftover: the rule", () => {
  const counts = (over: Partial<TabCounts> = {}): TabCounts => ({
    blank: 0,
    start: 0,
    fixture: 0,
    other: 0,
    ...over,
  });
  const PS = [
    "  201     35:12 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "  202     35:11 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/140.0.0.0/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer",
    "90992  01:02:03 /System/Cryptexes/App/System/Applications/Safari.app/Contents/MacOS/Safari",
    "  205 2-03:04:05 /System/Applications/TextEdit.app/Contents/MacOS/TextEdit",
  ].join("\n");

  it("reads a process's age from ps etime, the browser's main process only", () => {
    expect(parseEtime("00:05")).toBe(5);
    expect(parseEtime("35:12")).toBe(35 * 60 + 12);
    expect(parseEtime("01:02:03")).toBe(3600 + 120 + 3);
    expect(parseEtime("2-03:04:05")).toBe(2 * 86400 + 3 * 3600 + 4 * 60 + 5);
    expect(parseEtime(" 35:12 ")).toBe(35 * 60 + 12);
    for (const bad of ["", "35", "x", "1:2:3:4", "Fri Sep 19 19:57:48 2026"])
      expect(parseEtime(bad), bad).toBeUndefined();
    expect(browserUptime(PS, SAFARI)).toEqual({ pid: 90992, seconds: 3723 });
    expect(browserUptime(PS, CHROME)).toEqual({ pid: 201, seconds: 2112 });
    expect(browserUptime(PS, "com.microsoft.edgemac")).toBeUndefined();
    expect(browserUptime(PS, "com.apple.TextEdit")).toBeUndefined();
    expect(browserUptime(undefined, SAFARI)).toBeUndefined();
    expect(browserUptime("", SAFARI)).toBeUndefined();
  });

  it("is bench leftover only with no tab of the person's and no input of the person's since the launch", () => {
    const blank = counts({ blank: 24, start: 2 });
    // Nothing at all since the launch: the clocks alone say so.
    expect(
      benchLeftover({ tabs: blank, uptimeSeconds: 600, idleSeconds: 900 }),
    ).toEqual({ leftover: true, code: "LEFTOVER" });
    // The click that launches an application lands a moment before its
    // process starts: a launch within the slack of the last input is the
    // person's own.
    expect(
      benchLeftover({ tabs: blank, uptimeSeconds: 600, idleSeconds: 600.3 }),
    ).toEqual({ leftover: false, code: "INPUT_SINCE_LAUNCH" });
    expect(
      benchLeftover({
        tabs: blank,
        uptimeSeconds: 600,
        idleSeconds: 600 + LAUNCH_SLACK_SECONDS,
      }),
    ).toEqual({ leftover: true, code: "LEFTOVER" });
    // Input since the launch, and nothing to explain it: the person's.
    expect(
      benchLeftover({ tabs: blank, uptimeSeconds: 2100, idleSeconds: 120 }),
    ).toEqual({ leftover: false, code: "INPUT_SINCE_LAUNCH" });
    // A tab of the person's decides before any clock does.
    expect(
      benchLeftover({
        tabs: counts({ blank: 24, other: 1 }),
        uptimeSeconds: 600,
        idleSeconds: 900,
      }),
    ).toEqual({ leftover: false, code: "OTHER_TABS" });
    // Fixture tabs, blank tabs and start pages are all the benchmark's.
    expect(
      benchLeftover({
        tabs: counts({ blank: 1, start: 1, fixture: 3 }),
        uptimeSeconds: 600,
        idleSeconds: 900,
      }),
    ).toEqual({ leftover: true, code: "LEFTOVER" });
    // No tab at all (every window closed) holds nothing of anyone's.
    expect(
      benchLeftover({ tabs: counts(), uptimeSeconds: 600, idleSeconds: 900 }),
    ).toEqual({ leftover: true, code: "LEFTOVER" });
  });

  it("takes input since the launch as the harness's own when its ledgers explain it and no person was seen since", () => {
    const blank = counts({ blank: 24, start: 2 });
    // The evidence: Safari launched by cycle 1952's attempt at 19:57:48,
    // its attempts drove it until about 20:30 (the helper's input moves
    // HIDIdleTime), the next cycle read it at 20:32: idle about 2 min,
    // uptime about 35 min, the harness's last attempt ended about 2 min
    // ago, nobody seen. The clocks alone say input since the launch; the
    // ledgers explain it.
    const evidence = {
      tabs: blank,
      uptimeSeconds: 35 * 60,
      idleSeconds: 2 * 60,
    };
    expect(inputSinceLaunch(evidence)).toBe(true);
    expect(
      benchLeftover({
        ...evidence,
        harness: {
          lastInputAgoSeconds: 2 * 60 + 10,
          personSeenSinceLaunch: false,
        },
      }),
    ).toEqual({ leftover: true, code: "LEFTOVER" });
    // The last input fell after the harness's last attempt by more than
    // the slack: someone else's.
    expect(
      benchLeftover({
        ...evidence,
        harness: {
          lastInputAgoSeconds: 2 * 60 + HARNESS_SLACK_SECONDS + 1,
          personSeenSinceLaunch: false,
        },
      }),
    ).toEqual({ leftover: false, code: "INPUT_SINCE_LAUNCH" });
    expect(
      benchLeftover({
        ...evidence,
        harness: {
          lastInputAgoSeconds: 2 * 60 + HARNESS_SLACK_SECONDS,
          personSeenSinceLaunch: false,
        },
      }),
    ).toEqual({ leftover: true, code: "LEFTOVER" });
    // A person was seen since the launch (a takeover row, a HID_ACTIVE
    // wait): the person's, whatever the last input was.
    expect(
      benchLeftover({
        ...evidence,
        harness: { lastInputAgoSeconds: 2 * 60, personSeenSinceLaunch: true },
      }),
    ).toEqual({ leftover: false, code: "INPUT_SINCE_LAUNCH" });
    // The harness's last attempt ended before the browser launched: it
    // explains nothing about input since.
    expect(
      benchLeftover({
        ...evidence,
        harness: { lastInputAgoSeconds: 40 * 60, personSeenSinceLaunch: false },
      }),
    ).toEqual({ leftover: false, code: "INPUT_SINCE_LAUNCH" });
    // No ledger has an attempt: nothing is explained.
    expect(
      benchLeftover({ ...evidence, harness: { personSeenSinceLaunch: false } }),
    ).toEqual({ leftover: false, code: "INPUT_SINCE_LAUNCH" });
    // A tab of the person's still decides first.
    expect(
      benchLeftover({
        ...evidence,
        tabs: counts({ blank: 24, other: 2 }),
        harness: { lastInputAgoSeconds: 2 * 60, personSeenSinceLaunch: false },
      }),
    ).toEqual({ leftover: false, code: "OTHER_TABS" });
  });
});
