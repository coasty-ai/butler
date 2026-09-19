import { describe, expect, it } from "vitest";
import {
  RESETTABLE_BROWSERS,
  fixtureOrigin,
  onFixtureOrigin,
  parseResetAnswer,
  resetFixtureTabs,
  resetTabsScript,
} from "../src/gym/bench/browser-reset";
import {
  BROWSER_APPS,
  FIXTURE_HOST,
  FIXTURE_PORT,
} from "../src/gym/bench/graders";

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
