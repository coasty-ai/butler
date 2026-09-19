/**
 * The open_url route (electron/open-url.ts): the browser is told the address
 * by one Apple Event on the app's own front tab, else by LaunchServices. The
 * scripts are pinned as text (Safari's current tab, Chrome's active tab, the
 * System Events guard, the one write, the URL and host through argv), the
 * own-tab rule is driven through a fake `run`, and the NativeController
 * routes open_url to the hook and never to the helper.
 */
import { describe, expect, it, vi } from "vitest";
import {
  OWN_TAB_MS,
  SCRIPTABLE_BROWSERS,
  UrlOpener,
  navigateScript,
  ownHost,
  parseNavigateAnswer,
  type Run,
} from "../electron/open-url";
import { NativeController } from "../electron/controller";

const SAFARI = { name: "Safari", bundleId: "com.apple.Safari" };
const CHROME = { name: "Google Chrome", bundleId: "com.google.Chrome" };
const FIREFOX = { name: "Firefox", bundleId: "org.mozilla.firefox" };
const HOME = "https://www.youtube.com/";
const RESULTS = "https://www.youtube.com/results?search_query=midwest+safety";

/** A fake osascript and open: every call recorded, the answers scripted. */
function fake(answers: Record<string, string | Error> = {}) {
  const calls: { command: string; args: string[] }[] = [];
  const run: Run = async (command, args) => {
    calls.push({ command, args });
    const answer = answers[command];
    if (answer instanceof Error) throw answer;
    return answer ?? "";
  };
  return { run, calls };
}

describe("the scripts", () => {
  it("set the URL of Safari's current tab or Chrome's active tab, once, with the URL and host from argv", () => {
    for (const [id, dialect] of Object.entries(SCRIPTABLE_BROWSERS)) {
      const script = navigateScript(id);
      expect(script).toContain("set theURL to item 1 of argv");
      expect(script).toContain("set ownHost to item 2 of argv");
      expect(script).toContain(
        `set alive to count of (every process whose bundle identifier is "${id}")`,
      );
      expect(script.indexOf('tell application "System Events"')).toBeLessThan(
        script.indexOf(`tell application id "${id}"`),
      );
      expect(script).toContain('if alive is 0 then return "absent"');
      expect(script).toContain('if (count of windows) is 0 then return "none"');
      expect(script).toContain(
        `set t to ${dialect === "safari" ? "current tab" : "active tab"} of front window`,
      );
      expect(script).toContain(
        'if my ownPage(u, ownHost) is false then return "foreign"',
      );
      expect(script.match(/set URL of t to theURL/g)).toHaveLength(1);
      // No key, no click, no other write; the only "https://" is the scheme
      // the host rule strips, never an address of its own.
      for (const forbidden of [
        "keystroke",
        "key code",
        "click",
        "open location",
        "make new",
        "close",
      ])
        expect(script, forbidden).not.toContain(forbidden);
      expect(script.match(/https?:\/\//g)).toEqual(["https://", "http://"]);
      // The host rule: scheme stripped, cut at the path, query, fragment or port, "www." dropped.
      expect(script).toContain('repeat with sep in {"/", "?", "#", ":"}');
      expect(script).toContain(
        'return (h is ownHost) or (h ends with ("." & ownHost))',
      );
    }
    expect(() => navigateScript(FIREFOX.bundleId)).toThrow(/scriptable/);
    expect(() => navigateScript('x"; do shell script "rm')).toThrow();
  });
  it("read the answer as one of four words, anything else unread", () => {
    expect(parseNavigateAnswer("navigated\n")).toBe("navigated");
    expect(parseNavigateAnswer("absent")).toBe("absent");
    expect(parseNavigateAnswer("none")).toBe("none");
    expect(parseNavigateAnswer("foreign")).toBe("foreign");
    expect(parseNavigateAnswer("")).toBe("unread");
    expect(parseNavigateAnswer(undefined)).toBe("unread");
    expect(parseNavigateAnswer("execution error: Not authorized")).toBe(
      "unread",
    );
  });
  it("names the host a URL is on without www., and nothing for what is not a web address", () => {
    expect(ownHost("https://www.YouTube.com/results?q=x")).toBe("youtube.com");
    expect(ownHost("https://m.youtube.com/")).toBe("m.youtube.com");
    expect(ownHost("ftp://youtube.com/")).toBe("");
  });
});

describe("the route", () => {
  it("hands the first address to LaunchServices, and the next one to the app's own front tab by script", async () => {
    const f = fake({ osascript: "navigated" });
    let now = 1_000;
    const opener = new UrlOpener(f.run, () => now);
    expect(opener.ownTab()).toBeUndefined();
    expect(await opener.open(HOME, SAFARI)).toEqual({
      host: "www.youtube.com",
      appId: SAFARI.bundleId,
      via: "open",
    });
    expect(f.calls).toEqual([
      { command: "open", args: ["-b", SAFARI.bundleId, HOME] },
    ]);
    expect(opener.ownTab()).toEqual({
      bundleId: SAFARI.bundleId,
      host: "youtube.com",
    });
    now += 1_500;
    expect(await opener.open(RESULTS, SAFARI)).toEqual({
      host: "www.youtube.com",
      appId: SAFARI.bundleId,
      via: "script",
    });
    expect(f.calls[1]).toEqual({
      command: "osascript",
      args: ["-e", navigateScript(SAFARI.bundleId), RESULTS, "youtube.com"],
    });
    expect(f.calls).toHaveLength(2);
  });
  it("falls back to LaunchServices when the front tab is not its own, the browser has no window, is not running, or does not answer", async () => {
    for (const answer of [
      "foreign",
      "none",
      "absent",
      "",
      new Error("not authorized"),
    ]) {
      const f = fake({ osascript: answer });
      const opener = new UrlOpener(f.run, () => 5_000);
      await opener.open(HOME, CHROME);
      const result = await opener.open(RESULTS, CHROME);
      expect(result.via, String(answer)).toBe("open");
      expect(f.calls.map((c) => c.command)).toEqual([
        "open",
        "osascript",
        "open",
      ]);
      expect(f.calls[2].args).toEqual(["-b", CHROME.bundleId, RESULTS]);
    }
  });
  it("forgets its tab after OWN_TAB_MS, for another browser, and never scripts a browser without a tab dictionary", async () => {
    const f = fake({ osascript: "navigated" });
    let now = 0;
    const opener = new UrlOpener(f.run, () => now);
    await opener.open(HOME, SAFARI);
    now += OWN_TAB_MS + 1;
    expect(opener.ownTab()).toBeUndefined();
    await opener.open(RESULTS, SAFARI);
    expect(f.calls.map((c) => c.command)).toEqual(["open", "open"]);
    await opener.open(HOME, CHROME);
    expect(f.calls[2]).toEqual({
      command: "open",
      args: ["-b", CHROME.bundleId, HOME],
    });
    const fox = fake({ osascript: "navigated" });
    const opener2 = new UrlOpener(fox.run, () => 0);
    await opener2.open(HOME, FIREFOX);
    await opener2.open(RESULTS, FIREFOX);
    expect(fox.calls.map((c) => c.command)).toEqual(["open", "open"]);
  });
  it("refuses anything but a web address, and a browser id that is not one, before running anything", async () => {
    const f = fake();
    const opener = new UrlOpener(f.run, () => 0);
    for (const bad of [
      "youtube.com",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "https://u:p@x.com/",
    ])
      await expect(opener.open(bad, SAFARI), bad).rejects.toThrow(
        /web address/,
      );
    await expect(
      opener.open(HOME, { name: "x", bundleId: "bad id;" }),
    ).rejects.toThrow(/browser/);
    expect(f.calls).toEqual([]);
  });
  it("passes the URL and host as arguments, never inside the script text", () => {
    const script = navigateScript(SAFARI.bundleId);
    expect(script).not.toContain("youtube");
    expect(script.split("\n")[0]).toBe("on run argv");
  });
});

describe("NativeController.execute for open_url", () => {
  const source = (path: string) =>
    require("node:fs").readFileSync(
      new URL(`../${path}`, import.meta.url),
      "utf8",
    ) as string;
  it("routes open_url to the hook before any helper request, and to LaunchServices without one", async () => {
    const controller = source("electron/controller.ts");
    const execute = controller.slice(
      controller.indexOf("  async execute("),
      controller.indexOf("  async openUrl("),
    );
    expect(
      execute.indexOf(
        'if (action.type === "open_url") return this.openUrl(action);',
      ),
    ).toBeLessThan(
      execute.indexOf('await this.request("execute", { action })'),
    );
    const openUrl = controller.slice(
      controller.indexOf("  async openUrl("),
      controller.indexOf("  async revalidate("),
    );
    expect(openUrl).toContain("if (!this.urlRoute)");
    expect(openUrl).toContain("return this.openUrlByLaunchServices(action);");
    expect(openUrl).not.toContain("this.request(");
    expect(openUrl).toContain("const navigated = await this.urlRoute(action);");
    expect(openUrl).toContain("return navigated ? { navigated } : {};");
    // The hook is the first way in, and the prototype has the method.
    expect(typeof NativeController.prototype.openUrl).toBe("function");
    expect(controller).toContain("this.urlRoute = hooks.openUrl;");
  });
  it("without a hook, hands the address to LaunchServices in the browser in front, else the default browser", async () => {
    const launches: string[][] = [];
    const make = (appId: string) => {
      const c = new NativeController(
        "/nonexistent/helper",
        () => {},
        () => {},
        undefined,
        { launch: async (args) => void launches.push(args) },
      );
      (c as unknown as { surface: () => Promise<{ appId: string }> }).surface =
        async () => ({ appId });
      return c;
    };
    const action = {
      type: "open_url" as const,
      url: "https://www.youtube.com/results?search_query=x",
      frame_id: "f",
    };
    expect(await make("com.apple.Safari").openUrl(action)).toEqual({
      navigated: {
        host: "www.youtube.com",
        appId: "com.apple.Safari",
        via: "open",
      },
    });
    expect(await make("com.apple.finder").openUrl(action)).toEqual({
      navigated: { host: "www.youtube.com", via: "open" },
    });
    expect(launches).toEqual([
      ["-b", "com.apple.Safari", action.url],
      [action.url],
    ]);
  });
  it("is what main wires with the browser the early step would open", () => {
    const main = source("electron/main.ts");
    expect(main).toMatch(
      /openUrl: \(action\) =>\s*urlOpener\.open\(\s*action\.url,\s*preferredBrowser\(installedApps, memory\?\.data\(\)\),\s*\),/,
    );
    expect(main).toContain("const urlOpener = new UrlOpener();");
  });
  vi.restoreAllMocks();
});
