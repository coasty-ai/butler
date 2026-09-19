/**
 * The policy while the user is still speaking (PolicyContext.speaking;
 * .data/design/streaming-execution.md §3.3): only going somewhere is allowed
 * (open_app by the existing rules, open_url on a non-protected http(s) host,
 * open_file of a standard folder, scroll); every other step waits for the
 * end of the sentence with RETRY. The protected-website floor holds for
 * open_url whatever the autonomy setting, speaking or not, and the model may
 * use open_url after the final under the same rule.
 */
import { describe, expect, it } from "vitest";
import {
  actionSchema,
  defaultSettings,
  validateAction,
  webAddress,
  type Action,
  type Frame,
  type Settings,
  type Surface,
} from "../src/core/schema";
import {
  PROTECTED_SITE_REFUSAL,
  SPEAKING_RETRY,
  evaluate,
  speakingAllowed,
} from "../src/core/policy";
import { readFileSync } from "node:fs";
import { strictActionParameters } from "../src/providers/action-format";

/** The core instruction is not exported; its text is pinned from the source. */
const CORE_INSTRUCTION = readFileSync(
  new URL("../src/providers/http.ts", import.meta.url),
  "utf8",
);

const settings: Settings = structuredClone(defaultSettings);
const all: Settings = {
  ...settings,
  autonomy: "all",
  autonomyAllAcknowledged: true,
};
const desk: Surface = {
  appId: "com.microsoft.VSCode",
  pid: 7,
  secureInput: false,
  unknown: false,
  focusedRole: "AXTextArea",
};
const launcher: Surface = {
  ...desk,
  launcherStatus: "resolved",
  launcherAppId: "com.tinyspeck.slackmacgap",
  launcherName: "Slack",
  windowCount: 1,
};
const folder: Surface = {
  ...desk,
  fileStatus: "resolved",
  fileKind: "folder",
  fileName: "Downloads",
};
const f = "frame-1";
const a = (input: Record<string, unknown>) =>
  actionSchema.parse({ frame_id: f, ...input });
const speaking = { speaking: true } as const;
const url = (u: string, siteKey = "youtube") =>
  a({ type: "open_url", url: u, siteKey });

describe("while speaking: the allow-list", () => {
  it("allows open_app by the existing rules, open_url on an ordinary host, a standard folder and a scroll", () => {
    expect(
      evaluate(
        a({ type: "open_app", name: "Slack" }),
        launcher,
        settings,
        false,
        speaking,
      ),
    ).toMatchObject({ kind: "ALLOW" });
    expect(
      evaluate(
        url("https://www.youtube.com/results?search_query=x"),
        desk,
        settings,
        false,
        speaking,
      ),
    ).toEqual({ kind: "ALLOW", reason: "Load a web address in the browser." });
    expect(
      evaluate(
        a({ type: "open_file", path: "~/Downloads" }),
        folder,
        settings,
        false,
        speaking,
      ),
    ).toMatchObject({ kind: "ALLOW" });
    expect(
      evaluate(
        a({ type: "scroll", delta_x: 0, delta_y: 300 }),
        desk,
        settings,
        false,
        speaking,
      ),
    ).toEqual({ kind: "ALLOW", reason: "Pointer navigation." });
  });
  it("makes every other step wait for the end of the sentence, whatever the autonomy setting", () => {
    const waiting: Record<string, unknown>[] = [
      { type: "click", x: 0.5, y: 0.5 },
      { type: "double_click", x: 0.5, y: 0.5 },
      { type: "right_click", x: 0.5, y: 0.5 },
      { type: "move", x: 0.5, y: 0.5 },
      {
        type: "drag",
        start_x: 0.1,
        start_y: 0.1,
        end_x: 0.5,
        end_y: 0.5,
        duration_ms: 200,
      },
      { type: "type_text", text: "hello" },
      { type: "key", key: "ENTER" },
      { type: "key", key: "ESC" },
      { type: "hotkey", keys: ["CMD", "L"] },
      { type: "menu_item", path: ["File", "New"] },
      { type: "click_control", label: "Send" },
      { type: "open_file", path: "~/Documents/notes.txt" },
      { type: "open_file", path: "~/Downloads", app: "Visual Studio Code" },
      { type: "monitor", reason: "watch" },
      { type: "tool_call", tool: "apple__calendar.create", args: {} },
      { type: "wait", milliseconds: 500 },
      { type: "capture" },
      { type: "request_user", reason: "please" },
      { type: "done", summary: "done" },
      { type: "fail", reason: "no" },
    ];
    for (const input of waiting) {
      const action = a(input);
      expect(speakingAllowed(action), action.type).toBe(false);
      for (const s of [settings, all])
        expect(evaluate(action, desk, s, false, speaking), action.type).toEqual(
          {
            kind: "RETRY",
            reason: SPEAKING_RETRY,
          },
        );
    }
    expect(SPEAKING_RETRY).toBe("Waiting for the end of the sentence.");
  });
  it("judges the allowed steps as it always has: a refused launch stays refused, an unresolved one retries", () => {
    expect(
      evaluate(
        a({ type: "open_app", name: "Slack" }),
        { ...launcher, launcherStatus: "refused" },
        settings,
        false,
        speaking,
      ),
    ).toMatchObject({ kind: "DENY" });
    const unresolved = evaluate(
      a({ type: "open_app", name: "Slack" }),
      { ...launcher, launcherStatus: "unresolved", launcherAppId: undefined },
      settings,
      false,
      speaking,
    );
    expect(unresolved.kind).toBe("RETRY");
    expect(unresolved.reason).not.toBe(SPEAKING_RETRY);
  });
  it("keeps the surface floors: a protected app or secure input in front hands off, speaking or not", () => {
    const secure = { ...desk, secureInput: true };
    expect(
      evaluate(
        url("https://www.youtube.com/"),
        secure,
        settings,
        false,
        speaking,
      ).kind,
    ).toBe("USER_TAKEOVER");
    expect(
      evaluate(
        url("https://www.youtube.com/"),
        { ...desk, appId: "com.1password.1password" },
        settings,
        false,
        speaking,
      ).kind,
    ).toBe("USER_TAKEOVER");
  });
  it("never lets a question through mid-sentence: what would ask waits, and stays a question after the final", () => {
    // A folder opened in an editor asks (openFileDecision); while speaking it waits.
    const inEditor = a({
      type: "open_file",
      path: "~/Downloads",
      app: "Cursor",
    });
    expect(evaluate(inEditor, folder, settings, false, speaking)).toEqual({
      kind: "RETRY",
      reason: SPEAKING_RETRY,
    });
    expect(speakingAllowed(inEditor)).toBe(false);
  });
  it("a synthetic tutorial surface opens no website, speaking or not", () => {
    for (const context of [speaking, {}])
      expect(
        evaluate(
          url("https://www.youtube.com/"),
          desk,
          settings,
          true,
          context,
        ),
      ).toEqual({
        kind: "RETRY",
        reason: "The tutorial has no websites to open.",
      });
  });
});

describe("open_url: the host is the whole judgment", () => {
  it("refuses a protected host outright, never as a question, speaking or not and even under all", () => {
    for (const u of [
      "https://www.paypal.com/signin",
      "https://paypal.com",
      "http://secure.chase.com/login?x=1",
      "https://LOGIN.GOV/",
    ])
      for (const s of [settings, all])
        for (const context of [speaking, {}])
          expect(evaluate(url(u, "bank"), desk, s, false, context), u).toEqual({
            kind: "DENY",
            reason: PROTECTED_SITE_REFUSAL,
          });
  });
  it("allows any other http or https host, the user's own protected list applied", () => {
    expect(
      evaluate(url("https://notpaypal.com/"), desk, settings, false),
    ).toMatchObject({ kind: "ALLOW" });
    expect(
      evaluate(url("https://paypal.com.evil.example/"), desk, settings, false),
    ).toMatchObject({ kind: "ALLOW" });
    expect(
      evaluate(
        url("https://mail.google.com/mail/u/0/#search/rent"),
        desk,
        { ...settings, protectedDomains: ["google.com"] },
        false,
      ),
    ).toEqual({ kind: "DENY", reason: PROTECTED_SITE_REFUSAL });
  });
  it("takes only a full http or https address without credentials, in the schema and in webAddress", () => {
    for (const bad of [
      "youtube.com",
      "ftp://youtube.com/",
      "file:///Users/me/secret.html",
      "javascript:alert(1)",
      "https://user:secret@youtube.com/",
      "https://",
      "mailto:a@b.co",
    ]) {
      expect(webAddress(bad), bad).toBeUndefined();
      expect(() => a({ type: "open_url", url: bad }), bad).toThrow();
    }
    expect(
      webAddress(" https://www.YouTube.com/results?search_query=x ")?.hostname,
    ).toBe("www.youtube.com");
    expect(() =>
      a({
        type: "open_url",
        url: "https://www.youtube.com/",
        siteKey: "you tube",
      }),
    ).toThrow();
    expect(a({ type: "open_url", url: "https://www.youtube.com/" })).toEqual({
      type: "open_url",
      url: "https://www.youtube.com/",
      frame_id: f,
    });
  });
  it("reads the path and query for nothing: the same host decides alike", () => {
    expect(
      evaluate(
        url(
          "https://www.youtube.com/results?search_query=send+money+to+paypal.com",
        ),
        desk,
        settings,
        false,
      ).kind,
    ).toBe("ALLOW");
    expect(
      evaluate(url("https://www.paypal.com/"), desk, settings, false).kind,
    ).toBe("DENY");
  });
  it("is refused on a bound background window like open_app, and keeps a denial's own reason", () => {
    const bound = { ...desk, pid: 9 };
    const context = { target: { pid: 9, appName: "Notes" } };
    const decision = evaluate(
      url("https://www.youtube.com/"),
      bound,
      settings,
      false,
      context,
    );
    expect(decision.kind).toBe("RETRY");
    expect(decision.reason).toContain("nothing else is opened or switched to");
    expect(
      evaluate(url("https://www.paypal.com/"), bound, settings, false, context),
    ).toEqual({
      kind: "DENY",
      reason: PROTECTED_SITE_REFUSAL,
    });
  });
  it("is an action the model may propose: in the strict schema and in the core instruction, once each", () => {
    const branches: { properties: { type: { enum: string[] } } }[] = (
      strictActionParameters as unknown as {
        properties: {
          action: { anyOf: { properties: { type: { enum: string[] } } }[] };
        };
      }
    ).properties.action.anyOf;
    const openUrl = branches.find(
      (b) => b.properties.type.enum[0] === "open_url",
    )!;
    expect(Object.keys(openUrl.properties).sort()).toEqual(
      ["frame_id", "note", "siteKey", "type", "url"].sort(),
    );
    expect(CORE_INSTRUCTION).toContain("open_url(url, optional siteKey)");
    expect(
      CORE_INSTRUCTION.match(
        /use open_url\(url\) with a full http or https address/g,
      ),
    ).toHaveLength(1);
    expect(CORE_INSTRUCTION).toContain(
      "a protected website is refused, and nothing is clicked",
    );
    // Validated like any model action: the frame must be the current one.
    const frame = { id: f } as Frame;
    const proposed: Action = validateAction(
      {
        type: "open_url",
        url: "https://www.youtube.com/",
        siteKey: "youtube",
        frame_id: f,
      },
      frame,
    );
    expect(proposed.type).toBe("open_url");
    expect(() =>
      validateAction(
        { type: "open_url", url: "https://www.youtube.com/", frame_id: "old" },
        frame,
      ),
    ).toThrow("STALE_FRAME");
  });
});
