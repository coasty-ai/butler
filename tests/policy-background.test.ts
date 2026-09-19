import { describe, expect, it } from "vitest";
import {
  actionSchema,
  defaultSettings,
  type Action,
  type Settings,
  type Surface,
} from "../src/core/schema";
import { evaluate, type PolicyContext } from "../src/core/policy";

/**
 * Every step of a run bound to a background window passes the same rules as
 * a step on the screen (design §4): the autonomy tiers, the refusals and the
 * protected floors are untouched. Background mode adds refusals only: the
 * target is the window, so nothing opens or switches applications; a drag
 * and an unpublished chord have no route; and input goes to the bound
 * process alone.
 */
const SLACK = "com.tinyspeck.slackmacgap";
const bound: Surface = {
  appId: SLACK,
  appName: "Slack",
  pid: 501,
  secureInput: false,
  unknown: false,
  target: {
    bound: true,
    covered: false,
    minimized: false,
    focusedWindow: true,
    siblingWindows: 0,
  },
};
const inFront: Surface = {
  appId: SLACK,
  appName: "Slack",
  pid: 501,
  secureInput: false,
  unknown: false,
};
const context: PolicyContext = { target: { pid: 501, appName: "Slack" } };
const settings = structuredClone(defaultSettings);
const act = (input: Record<string, unknown>): Action =>
  actionSchema.parse({ frame_id: "f", ...input });
const control = (label: string, extra: Partial<Surface> = {}) => ({
  action: act({ type: "click_control", label }),
  surface: {
    controlStatus: "resolved" as const,
    controlLabel: label,
    targetRole: "AXButton",
    targetLabel: label,
    ...extra,
  },
});
/** The same step judged on the screen and in the background. */
const both = (action: Action, surface: Partial<Surface>, s = settings) => [
  evaluate(action, { ...inFront, ...surface }, s, false, {}),
  evaluate(action, { ...bound, ...surface }, s, false, context),
];

describe("policy parity in the background (design §4)", () => {
  it("asks for the same consequential steps and allows the same routine ones", () => {
    const send = control("Send");
    for (const decision of both(send.action, send.surface))
      expect(decision).toEqual({
        kind: "CONFIRM",
        reason: "Send this message?",
      });
    const reply = control("Reply");
    for (const decision of both(reply.action, reply.surface))
      expect(decision.kind).toBe("ALLOW");
    const typing = act({ type: "type_text", text: "running ten minutes late" });
    for (const decision of both(typing, { focusedRole: "AXTextArea" }))
      expect(decision.kind).toBe("ALLOW");
    const newline = act({ type: "type_text", text: "late\nsorry" });
    for (const decision of both(newline, { focusedRole: "AXTextArea" }))
      expect(decision.kind).toBe("CONFIRM");
    const search = act({ type: "key", key: "ENTER" });
    for (const decision of both(search, {
      focusedRole: "AXTextField",
      focusedSubrole: "AXSearchField",
      focusedValue: "prateek",
    }))
      expect(decision).toEqual({ kind: "ALLOW", reason: "Submit a search." });
  });
  it("keeps every refusal: credentials, the clipboard, terminals, protected apps", () => {
    const secret = act({ type: "type_text", text: "password: hunter2xyz" });
    for (const decision of both(secret, { focusedRole: "AXTextField" }))
      expect(decision.kind).toBe("DENY");
    // The clipboard denial is not turned into the chord's background retry.
    const paste = act({ type: "hotkey", keys: ["CMD", "V"] });
    for (const decision of both(paste, { focusedRole: "AXTextField" })) {
      expect(decision.kind).toBe("DENY");
      expect(decision.reason).toMatch(/Clipboard access is disabled/);
    }
    const terminal = { ...bound, appId: "com.apple.Terminal" };
    expect(
      evaluate(act({ type: "capture" }), terminal, settings, false, {
        target: { pid: 501, appName: "Terminal" },
      }).kind,
    ).toBe("USER_TAKEOVER");
  });
  it("secure input on the target pauses what carries text; a click carries none (design §4)", () => {
    // In front, secure input pauses every step, as it always did.
    const secure = { secureInput: true, focusedRole: "AXTextField" };
    for (const input of [
      { type: "click_control", label: "Reply" },
      { type: "type_text", text: "hello" },
    ])
      expect(
        evaluate(act(input), { ...inFront, ...secure }, settings, false, {})
          .kind,
      ).toBe("USER_TAKEOVER");
    // Bound: the field is the target's own; typing, keys and chords pause.
    for (const input of [
      { type: "type_text", text: "hello" },
      { type: "key", key: "ENTER" },
      { type: "hotkey", keys: ["CMD", "N"] },
    ])
      expect(
        evaluate(act(input), { ...bound, ...secure }, settings, false, context)
          .kind,
      ).toBe("USER_TAKEOVER");
    // Clicks, menus and scrolls go on: they carry no text.
    const reply = control("Reply", secure);
    expect(
      evaluate(
        reply.action,
        { ...bound, ...reply.surface },
        settings,
        false,
        context,
      ).kind,
    ).toBe("ALLOW");
    expect(
      evaluate(
        act({ type: "menu_item", path: ["File", "New Message"] }),
        {
          ...bound,
          ...secure,
          menuStatus: "resolved",
          menuLabel: "New Message",
        },
        settings,
        false,
        context,
      ).kind,
    ).toBe("ALLOW");
    expect(
      evaluate(
        act({ type: "scroll", delta_x: 0, delta_y: 100 }),
        { ...bound, ...secure },
        settings,
        false,
        context,
      ).kind,
    ).toBe("ALLOW");
    // Every other floor stands on a click: a protected target still pauses.
    expect(
      evaluate(
        reply.action,
        { ...bound, ...reply.surface, appId: "com.apple.Terminal" },
        settings,
        false,
        { target: { pid: 501, appName: "Terminal" } },
      ).kind,
    ).toBe("USER_TAKEOVER");
  });
  it("lets 'allow everything' remove the asking in both modes, never a refusal", () => {
    const all: Settings = {
      ...settings,
      autonomy: "all",
      autonomyAllAcknowledged: true,
    };
    const send = control("Send");
    for (const decision of both(send.action, send.surface, all))
      expect(decision.kind).toBe("ALLOW");
    expect(
      evaluate(
        act({ type: "open_app", name: "Notes" }),
        bound,
        all,
        false,
        context,
      ).kind,
    ).toBe("RETRY");
  });
});

describe("what a bound run cannot do in its window (design §2.5)", () => {
  it("refuses opening or switching: the target is the window", () => {
    const open = evaluate(
      act({ type: "open_app", name: "Notes" }),
      {
        ...bound,
        launcherStatus: "resolved",
        launcherAppId: "com.apple.Notes",
        launcherName: "Notes",
      },
      settings,
      false,
      context,
    );
    expect(open.kind).toBe("RETRY");
    expect(open.reason).toContain("Slack's window in the background");
    expect(open.reason).toContain("already the window in the screenshot");
    const file = evaluate(
      act({ type: "open_file", path: "~/Documents/Q3.xlsx" }),
      { ...bound, fileStatus: "resolved", fileKind: "document" },
      settings,
      false,
      context,
    );
    expect(file.kind).toBe("RETRY");
    // On the screen the same steps are allowed as before.
    expect(
      evaluate(
        act({ type: "open_file", path: "~/Documents/Q3.xlsx" }),
        { ...inFront, fileStatus: "resolved", fileKind: "document" },
        settings,
        false,
      ).kind,
    ).toBe("ALLOW");
  });
  it("refuses a drag and a chord the application does not publish", () => {
    const drag = act({
      type: "drag",
      start_x: 0.1,
      start_y: 0.1,
      end_x: 0.5,
      end_y: 0.5,
      duration_ms: 300,
    });
    expect(evaluate(drag, bound, settings, false, context)).toMatchObject({
      kind: "RETRY",
      reason: expect.stringContaining("Dragging has no route"),
    });
    const find = act({ type: "hotkey", keys: ["CMD", "F"] });
    expect(evaluate(find, inFront, settings, false).kind).toBe("ALLOW");
    const chord = evaluate(find, bound, settings, false, context);
    expect(chord.kind).toBe("RETRY");
    expect(chord.reason).toContain("cannot be posted to a background window");
    expect(chord.reason).toContain("menu_item");
    // Published as a menu shortcut it is pressed as that item, so it stands.
    expect(
      evaluate(
        act({ type: "hotkey", keys: ["CMD", "SHIFT", "D"] }),
        { ...bound, shortcutLabel: "Toggle Sidebar" },
        settings,
        false,
        context,
      ).kind,
    ).toBe("ALLOW");
    // A bare key has no modifier to refuse.
    expect(
      evaluate(
        act({ type: "key", key: "DOWN" }),
        bound,
        settings,
        false,
        context,
      ).kind,
    ).toBe("ALLOW");
  });
  it("applies from the surface's own target facts when the run gives none", () => {
    expect(
      evaluate(
        act({ type: "open_app", name: "Notes" }),
        { ...bound, launcherStatus: "resolved", launcherAppId: "x" },
        settings,
        false,
      ).kind,
    ).toBe("RETRY");
  });
});

describe("input goes to the bound process alone (design §4)", () => {
  it("denies a surface from another process or a target in another application", () => {
    const reply = control("Reply");
    const elsewhere = evaluate(
      reply.action,
      { ...bound, ...reply.surface, pid: 999 },
      settings,
      false,
      context,
    );
    expect(elsewhere.kind).toBe("DENY");
    expect(elsewhere.reason).toContain(
      "not the Slack window this run is bound to",
    );
    expect(
      evaluate(
        reply.action,
        { ...bound, ...reply.surface, targetAppId: "com.apple.Notes" },
        settings,
        false,
        context,
      ).kind,
    ).toBe("DENY");
    expect(
      evaluate(
        reply.action,
        { ...bound, ...reply.surface, targetAppId: SLACK },
        settings,
        false,
        context,
      ).kind,
    ).toBe("ALLOW");
  });
});
