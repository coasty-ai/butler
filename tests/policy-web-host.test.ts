/**
 * The protected-website floor when the page's address cannot be read.
 *
 * Measured 2026-09-19: Safari gave the helper no page host on any page
 * (`scripts/probe-web-controls.mjs` printed hasDomain false with the focus in
 * the AXWebArea), and five of six Safari attempts of cycle
 * 20260919-0816-a839d34 were NO_BROWSER_ADDRESS. The cause was the helper's
 * bounded host walk skipping AXTabGroup children along with toolbars, and
 * Safari holds its web area under its tab group; Chromium publishes the URL on
 * the window itself, so Chrome never showed it. With no domain the policy's
 * protected-website hand-off never fired in Safari, silently. The surface now
 * says when a page is there whose address could not be read (hostUnknown),
 * and the policy hands off on it while any site is protected.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  actionSchema,
  defaultSettings,
  type Action,
  type Settings,
  type Surface,
} from "../src/core/schema";
import {
  evaluate,
  surfacePolicy,
  UNREADABLE_PAGE_TAKEOVER,
  withoutAsking,
} from "../src/core/policy";
import { autonomyChange } from "../src/ui/settings-voice";

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const count = (text: string, needle: string) => text.split(needle).length - 1;
const between = (text: string, from: string, to: string) => {
  const start = text.indexOf(from);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = text.indexOf(to, start + from.length);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
};

const settings: Settings = structuredClone(defaultSettings);
// Mirrors `browsers` in src/core/policy.ts and browserAppIDs in
// native/macos/InputSafety.swift.
const BROWSERS = [
  "com.apple.Safari",
  "com.google.Chrome",
  "com.google.Chrome.canary",
  "org.mozilla.firefox",
  "com.brave.Browser",
  "com.microsoft.edgemac",
];
const safari: Surface = {
  appId: "com.apple.Safari",
  pid: 7,
  secureInput: false,
  unknown: false,
  focusedRole: "AXWebArea",
  accessibility: "full",
};
const unreadable: Surface = { ...safari, hostUnknown: true };
const act = (input: Record<string, unknown>): Action =>
  actionSchema.parse({ frame_id: "f", ...input });
const click = act({ type: "click", x: 0.5, y: 0.5, button: "left" });
const typing = act({ type: "type_text", text: "hello" });
const escape = act({ type: "key", key: "ESC" });

describe("a browser page whose address could not be read", () => {
  it("hands off before a capture while any website is protected, in every browser", () => {
    expect(settings.protectedDomains.length).toBeGreaterThan(0);
    for (const appId of BROWSERS) {
      const surface = { ...unreadable, appId };
      expect([appId, surfacePolicy(surface, settings)]).toEqual([
        appId,
        { kind: "USER_TAKEOVER", reason: UNREADABLE_PAGE_TAKEOVER },
      ]);
      // Every step is refused the same way, the harmless ones included: the
      // hand-off is the surface's, before any action is judged.
      for (const action of [click, typing, escape])
        expect([
          appId,
          evaluate(action, surface, settings, false).kind,
        ]).toEqual([appId, "USER_TAKEOVER"]);
    }
  });
  it("is a floor: 'all' removes questions, never this hand-off", () => {
    const all: Settings = { ...settings, ...autonomyChange("all", true) };
    expect(all.autonomyAllAcknowledged).toBe(true);
    const decision = surfacePolicy(unreadable, all);
    expect(decision.kind).toBe("USER_TAKEOVER");
    expect(withoutAsking(decision, all)).toEqual(decision);
    expect(evaluate(click, unreadable, all, false).kind).toBe("USER_TAKEOVER");
    for (const autonomy of ["ask", "task", "flow"] as const)
      expect(
        surfacePolicy(unreadable, {
          ...settings,
          ...autonomyChange(autonomy, true),
        }).kind,
      ).toBe("USER_TAKEOVER");
  });
  it("is worked like any page when nothing is protected: there is nothing the address could match", () => {
    const nothing: Settings = { ...settings, protectedDomains: [] };
    expect(surfacePolicy(unreadable, nothing)).toEqual({
      kind: "ALLOW",
      reason: "",
    });
    expect(evaluate(escape, unreadable, nothing, false).kind).toBe("ALLOW");
  });
  it("is not a browser with no page showing: a start page or a blank window has no address to read", () => {
    // The helper sets the flag only for a web area that publishes no URL.
    expect(surfacePolicy(safari, settings)).toEqual({
      kind: "ALLOW",
      reason: "",
    });
    expect(
      surfacePolicy({ ...safari, hostUnknown: false }, settings).kind,
    ).toBe("ALLOW");
    expect(evaluate(escape, safari, settings, false).kind).toBe("ALLOW");
  });
  it("is a browser's fact: outside one the flag changes nothing", () => {
    // Mail's message view is WebKit and publishes no URL; the helper never
    // sets the flag there, and the policy would not read it if it did.
    for (const appId of [
      "com.apple.mail",
      "com.apple.Notes",
      "com.tinyspeck.slackmacgap",
    ])
      expect([
        appId,
        surfacePolicy({ ...unreadable, appId }, settings).kind,
      ]).toEqual([appId, "ALLOW"]);
  });
  it("yields to an address that was read", () => {
    // A protected host keeps its own hand-off and words.
    expect(
      surfacePolicy({ ...unreadable, domain: "secure.paypal.com" }, settings),
    ).toEqual({
      kind: "USER_TAKEOVER",
      reason: "A protected website is active. Please take over.",
    });
    // A read host that is not protected is a known page, whatever the flag says.
    expect(
      surfacePolicy({ ...unreadable, domain: "example.com" }, settings).kind,
    ).toBe("ALLOW");
    // The fixture server's pages always have a host, so a bench run never
    // meets this hand-off on them.
    expect(
      surfacePolicy({ ...safari, domain: "127.0.0.1" }, settings).kind,
    ).toBe("ALLOW");
  });
  it("closes the allowances that trust a page by its host", () => {
    // A search-result link on an unknown page is not "Open a search result":
    // with a site protected the surface hands off first, and with none the
    // link is judged as any link with no page host behind it.
    const link = {
      ...safari,
      targetRole: "AXLink",
      targetLabel: "Post X · How to",
      targetURL: "https://example.org/post",
    };
    const nothing: Settings = { ...settings, protectedDomains: [] };
    expect(
      evaluate(click, { ...link, hostUnknown: true }, nothing, false).reason,
    ).not.toBe("Open a search result.");
    expect(
      evaluate(click, { ...link, hostUnknown: true }, settings, false).kind,
    ).toBe("USER_TAKEOVER");
  });
});

describe("the helper reads Safari's page (native/macos source pins)", () => {
  const controller = read("native/macos/Controller.swift");
  const input = read("native/macos/InputSafety.swift");
  it("walks into the tab group Safari holds its web area under, and still not into toolbars", () => {
    const walk = between(
      controller,
      "func visitWebAreas(",
      "func webAreaHost(",
    );
    expect(walk).toContain(
      'guard depth < 12, role != "AXToolbar" else { continue }',
    );
    expect(walk).not.toContain('AXTabGroup"]');
    // The old skip list is gone from every walk that looks for the page.
    expect(controller).not.toContain('["AXToolbar", "AXTabGroup"]');
    // Bounded as before: nodes, depth and time, and never into the page's own tree.
    expect(walk).toContain("index < 1500");
    expect(walk).toContain("systemUptime - started < 0.12");
    expect(walk).toContain(
      'if role == "AXWebArea" { if accept(node) { return }; continue }',
    );
    // The host is the web area's own AXURL, which WebKit publishes.
    expect(
      between(controller, "func webAreaHost(", "func enclosingWebArea("),
    ).toContain('pageHost(attribute(area, "AXURL"))');
    // containsWebArea (the covered-window rule) shares the walk, so Safari's
    // page counts as web content there too.
    expect(
      between(controller, "func containsWebArea(", "func targetElement("),
    ).toContain("visitWebAreas(window)");
  });
  it("reads the window's document first, then the focused web area, then the walk, and never the address field", () => {
    const identity = between(
      controller,
      "func pageIdentity(",
      "// True when a sheet, dialog or alert",
    );
    const order = [
      'pageHost(attribute(window, "AXDocument")) ?? pageHost(attribute(window, "AXURL"))',
      "enclosingWebArea(focused)",
      "CFEqual(areaWindow, window)",
      "visitWebAreas(window)",
      "return (host, host == nil && unreadable)",
    ];
    let at = -1;
    for (const step of order) {
      const next = identity.indexOf(step, at + 1);
      expect([step, next]).not.toEqual([step, -1]);
      at = next;
    }
    expect(identity).not.toContain("browserAddressField");
    expect(identity).not.toContain("focusedValue");
  });
  it("reports hostUnknown on both surfaces for a browser only, and the helper's own floor refuses on it", () => {
    // surface() and surfaceTarget() each set the flag through pageHostUnknown,
    // which takes the browser fact; windowDomain (watch) reads the same identity.
    expect(count(controller, 'result["hostUnknown"] = true')).toBe(2);
    expect(
      count(controller, "pageHostUnknown(browser: browserAppIDs.contains("),
    ).toBe(2);
    expect(
      between(controller, "func windowDomain(", "func watchWindowProtected("),
    ).toContain("pageIdentity(window: window, focused: nil).host");
    expect(
      between(
        controller,
        "func guardSurface() throws {",
        "// The text a window shows",
      ),
    ).toContain(
      's["hostUnknown"] as? Bool == true, watchDomainRefused(domain: nil, browser: true, protectedDomains: protectedDomains)',
    );
    // The pure rules live where the native-safety tests compile them.
    expect(input).toContain("func pageURL(_ value: Any?) -> PageURL");
    expect(input).toContain("func pageHost(_ value: Any?) -> String?");
    expect(input).toContain(
      "func pageHostUnknown(browser: Bool, host: String?, unreadableWebArea: Bool) -> Bool",
    );
    expect(input).toContain(
      "return browser && host == nil && unreadableWebArea",
    );
    expect(read("tests/native/IdeSafetyTests.swift")).toContain(
      "pageHostUnknown(browser: true, host: nil, unreadableWebArea: true)",
    );
  });
  it("is what the threat model, the harness docs and the probe say", () => {
    expect(read("docs/THREAT_MODEL.md")).toMatch(
      /address (?:could not|cannot) be read[^|]*hands? off/,
    );
    expect(read("docs/BENCHMARK.md")).toMatch(
      /NO_BROWSER_ADDRESS[\s\S]*AXTabGroup/,
    );
    expect(read("scripts/probe-web-controls.mjs")).toContain(
      "hostUnknown: surface.hostUnknown === true",
    );
  });
});
