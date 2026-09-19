import { describe, expect, it } from "vitest";
import {
  QUIT_WAIT_QUARTERS,
  RESETTABLE_BROWSERS,
  fixtureOrigin,
  onFixtureOrigin,
  parseQuitAnswer,
  parseResetAnswer,
  quitBrowser,
  quitBrowserScript,
  resetFixtureTabs,
  resetTabsScript,
} from "../src/gym/bench/browser-reset";
import {
  BROWSER_APPS,
  FIXTURE_HOST,
  FIXTURE_PORT,
} from "../src/gym/bench/graders";
import { benchOwnBrowser } from "../src/gym/bench/preflight";

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

describe("browser quit: the quit", () => {
  const fake = (answer: string | undefined) => {
    const calls: string[][] = [];
    const run = async (command: string, args: string[]) => {
      calls.push([command, ...args]);
      return answer;
    };
    return { calls, run };
  };
  const theirWindow = {
    running: new Set([SAFARI]),
    windows: { [SAFARI]: { windows: 2, foreign: 1 } },
  };

  it("asks the benchmark's own browser once and reads whether it went", async () => {
    // Not running by the facts (an attempt launched it): the benchmark's.
    const gone = fake("quit\n");
    expect(await quitBrowser(gone.run, SAFARI, {})).toEqual({ quit: true });
    expect(gone.calls).toEqual([
      ["osascript", "-e", quitBrowserScript(SAFARI)],
    ]);
    // Running with no window of the person's: the benchmark's too.
    const blank = fake("quit");
    expect(
      await quitBrowser(blank.run, CHROME, {
        running: new Set([CHROME]),
        windows: { [CHROME]: { windows: 1, foreign: 0 } },
      }),
    ).toEqual({ quit: true });
    expect(blank.calls).toEqual([
      ["osascript", "-e", quitBrowserScript(CHROME)],
    ]);
    // Asked and still there five seconds later (a dialog holds it), not
    // running after all, or no answer: not quit, and the code says which.
    expect(await quitBrowser(fake("quitting").run, SAFARI, {})).toEqual({
      quit: false,
      code: "STILL_RUNNING",
    });
    expect(await quitBrowser(fake("absent").run, SAFARI, {})).toEqual({
      quit: false,
      code: "NOT_RUNNING",
    });
    expect(await quitBrowser(fake(undefined).run, SAFARI, {})).toEqual({
      quit: false,
      code: "UNREAD",
    });
    expect(
      await quitBrowser(
        fake("execution error: Not authorized to send Apple events").run,
        SAFARI,
        {},
      ),
    ).toEqual({ quit: false, code: "UNREAD" });
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

  it("never quits a browser of the person's, one it cannot script, or any other application", async () => {
    // Running with a window of the person's: theirs, and no Apple Event.
    const theirs = fake("quit");
    expect(await quitBrowser(theirs.run, SAFARI, theirWindow)).toEqual({
      quit: false,
      code: "THEIRS",
    });
    expect(theirs.calls).toEqual([]);
    // Running with its windows unread (a dry run, a refused query): theirs.
    const unread = fake("quit");
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
    const refused = fake("quit");
    expect((await quitBrowser(refused.run, SAFARI, facts)).code).toBe("THEIRS");
    expect(refused.calls).toEqual([]);
    expect(await quitBrowser(fake("quit").run, CHROME, facts)).toEqual({
      quit: true,
    });
    // Not scriptable, or no browser at all: nothing runs, whatever the
    // facts say about it.
    for (const id of [
      "org.mozilla.firefox",
      "company.thebrowser.Browser",
      "com.apple.finder",
      "com.apple.Terminal",
      "com.1password.1password",
    ]) {
      const other = fake("quit");
      expect(await quitBrowser(other.run, id, {}), id).toEqual({
        quit: false,
        code: "NO_SCRIPT",
      });
      expect(other.calls).toEqual([]);
    }
  });
});
