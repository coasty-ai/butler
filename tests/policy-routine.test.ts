import { describe, it, expect } from "vitest";
import {
  actionSchema,
  controlRole,
  defaultSettings,
  type Action,
  type Surface,
} from "../src/core/schema";
import {
  documentExtensions,
  documentURL,
  evaluate,
  launcherMatches,
  isInstallerName,
  PASTE_ALLOWED,
  type Decision,
} from "../src/core/policy";
import { pasteRequested } from "../src/core/runner";
import { redactSecrets, sanitizeText, scanText } from "../src/core/sanitize";
import { describeAction } from "../src/voice/router";
import installerNames from "./fixtures/installer-names.json";

const settings = structuredClone(defaultSettings);
const base: Surface = {
  appId: "com.example.app",
  pid: 7,
  secureInput: false,
  unknown: false,
};
const act = (input: Record<string, unknown>): Action =>
  actionSchema.parse({ frame_id: "f", ...input });
const click = (button: "left" | "right" = "left") =>
  act({ type: "click", x: 0.5, y: 0.5, button });
const doubleClick = act({ type: "double_click", x: 0.5, y: 0.5 });
const rightClick = act({ type: "right_click", x: 0.5, y: 0.5 });
const named = (label: string, extra: Record<string, unknown> = {}) =>
  act({ type: "click_control", label, ...extra });
const key = (k: string) => act({ type: "key", key: k });
const hotkey = (...keys: string[]) => act({ type: "hotkey", keys });
const type = (text: string) => act({ type: "type_text", text });
const openApp = (name: string) => act({ type: "open_app", name });
const decide = (action: Action, surface: Partial<Surface>, synthetic = false) =>
  evaluate(action, { ...base, ...surface }, settings, synthetic);
const blocks = (text: string) =>
  scanText(text).some((f) => f.action === "BLOCK_UPLOAD");

type Row = [string, Action, Partial<Surface>, Decision["kind"]];
const chrome = { appId: "com.google.Chrome" };
const spotlight = { appId: "com.apple.Spotlight", focusedRole: "AXTextField" };

describe("everyday tasks run without approval", () => {
  it.each<Row>([
    // Open Chrome through Spotlight.
    ["CMD+SPACE", hotkey("CMD", "SPACE"), {}, "ALLOW"],
    ["type a Spotlight query", type("chrome"), spotlight, "ALLOW"],
    [
      "Enter on Chrome -> Google Chrome",
      key("ENTER"),
      {
        ...spotlight,
        launcher: { query: "chrome", selectedResult: "Google Chrome" },
      },
      "ALLOW",
    ],
    [
      "Enter on Settings -> System Settings",
      key("ENTER"),
      {
        ...spotlight,
        launcher: { query: "Settings", selectedResult: "System Settings" },
      },
      "ALLOW",
    ],
    // Mail: select a message row, then read it.
    [
      "click a Mail message row",
      click(),
      {
        appId: "com.apple.mail",
        targetRole: "AXRow",
        targetText: "Lunch Thursday",
      },
      "ALLOW",
    ],
    [
      "click a Mail message cell",
      click(),
      { appId: "com.apple.mail", targetRole: "AXCell" },
      "ALLOW",
    ],
    [
      "DOWN in the message list",
      key("DOWN"),
      { focusedRole: "AXTable" },
      "ALLOW",
    ],
    // Finder.
    [
      "double-click a Finder folder",
      doubleClick,
      {
        appId: "com.apple.finder",
        targetRole: "AXCell",
        targetText: "Invoices",
        targetURL: "file:///Users/x/Documents/Invoices/",
      },
      "ALLOW",
    ],
    [
      "right-click a Finder file",
      rightClick,
      {
        appId: "com.apple.finder",
        targetRole: "AXCell",
        targetText: "report.pdf",
      },
      "ALLOW",
    ],
    [
      "right-click via click button",
      click("right"),
      { targetRole: "AXRow", targetText: "report.pdf" },
      "ALLOW",
    ],
    [
      "click a menu item",
      click(),
      { targetRole: "AXMenuItem", targetLabel: "New Folder" },
      "ALLOW",
    ],
    [
      "click a checkbox",
      click(),
      { targetRole: "AXCheckBox", targetLabel: "Bold" },
      "ALLOW",
    ],
    [
      "click a Format menu bar item",
      click(),
      { targetRole: "AXMenuBarItem", targetLabel: "Format" },
      "ALLOW",
    ],
    [
      "click a labelled button",
      click(),
      { targetRole: "AXButton", targetLabel: "OK" },
      "ALLOW",
    ],
    [
      "click a button labelled by its text",
      click(),
      { targetRole: "AXButton", targetText: "Skip Ad" },
      "ALLOW",
    ],
    // Tabs, windows and navigation shortcuts.
    ["CMD+W", hotkey("CMD", "W"), chrome, "ALLOW"],
    ["CMD+T", hotkey("CMD", "T"), chrome, "ALLOW"],
    ["CMD+SHIFT+T", hotkey("SHIFT", "CMD", "T"), chrome, "ALLOW"],
    ["CTRL+TAB", hotkey("CTRL", "TAB"), chrome, "ALLOW"],
    ["CTRL+SHIFT+TAB", hotkey("CTRL", "SHIFT", "TAB"), chrome, "ALLOW"],
    ["CMD+1", hotkey("CMD", "1"), chrome, "ALLOW"],
    ["CMD+9", hotkey("CMD", "9"), chrome, "ALLOW"],
    ["CMD+Z", hotkey("CMD", "Z"), {}, "ALLOW"],
    [
      "CMD+N in Finder",
      hotkey("CMD", "N"),
      { appId: "com.apple.finder" },
      "ALLOW",
    ],
    ["CMD+ALT+RIGHT", hotkey("CMD", "ALT", "RIGHT"), chrome, "ALLOW"],
    ["ALT+SHIFT+LEFT", hotkey("ALT", "SHIFT", "LEFT"), {}, "ALLOW"],
    [
      "CMD+B in an editor",
      hotkey("CMD", "B"),
      { focusedRole: "AXTextArea" },
      "ALLOW",
    ],
    [
      "PAGEDOWN in a web page",
      key("PAGEDOWN"),
      { ...chrome, focusedRole: "AXWebArea" },
      "ALLOW",
    ],
    ["TAB between controls", key("TAB"), { focusedRole: "AXButton" }, "ALLOW"],
    [
      "SPACE in a web page",
      key("SPACE"),
      { ...chrome, focusedRole: "AXWebArea" },
      "ALLOW",
    ],
    [
      "SPACE in a text field",
      key("SPACE"),
      { focusedRole: "AXTextField" },
      "ALLOW",
    ],
    // Searching.
    [
      "Enter in a search field by subrole",
      key("ENTER"),
      {
        appId: "com.apple.mail",
        focusedRole: "AXTextField",
        focusedSubrole: "AXSearchField",
      },
      "ALLOW",
    ],
    [
      "Enter in a web search box by label",
      key("ENTER"),
      { ...chrome, focusedRole: "AXComboBox", focusedLabel: "Search YouTube" },
      "ALLOW",
    ],
    // Links.
    [
      "click an https link",
      click(),
      {
        ...chrome,
        targetRole: "AXLink",
        targetURL: "https://en.wikipedia.org/wiki/Jarvis",
      },
      "ALLOW",
    ],
    // Writing.
    [
      "multi-line text in Notes",
      type("Line one\nLine two"),
      { appId: "com.apple.Notes", focusedRole: "AXTextArea" },
      "ALLOW",
    ],
    [
      "multi-line text in TextEdit",
      type("Dear team,\n\nThanks."),
      { appId: "com.apple.TextEdit", focusedRole: "AXTextArea" },
      "ALLOW",
    ],
  ])("%s", (_name, action, surface, kind) =>
    expect(decide(action, surface).kind).toBe(kind),
  );
});

describe("live false alarms (2026-09-17)", () => {
  const googleResult = {
    ...chrome,
    domain: "www.google.com",
    targetWebHost: "www.google.com",
    targetRole: "AXLink",
  };
  it("opens a search result whose title mentions a post without approval", () => {
    const label = "Post X · daytonaio 30+ likes · 7 months ago";
    expect(
      decide(click(), {
        ...googleResult,
        targetLabel: label,
        targetText: label,
      }),
    ).toMatchObject({ kind: "ALLOW", reason: "Open a search result." });
  });
  it("keeps result links on other hosts and non-link controls on the normal rules", () => {
    expect(
      decide(click(), {
        ...googleResult,
        targetWebHost: "accounts.example.com",
        targetLabel: "Delete account",
      }).kind,
    ).toBe("CONFIRM");
    expect(
      decide(click(), {
        ...googleResult,
        targetRole: "AXButton",
        targetLabel: "Delete",
      }).kind,
    ).toBe("CONFIRM");
  });
  it("treats post as a noun except on a post button or menu item", () => {
    const slack = { appId: "com.tinyspeck.slackmacgap" };
    expect(
      decide(click(), {
        ...slack,
        targetRole: "AXList",
        targetLabel: "All",
        targetText: "Post in · All",
      }).kind,
    ).not.toBe("CONFIRM");
    for (const label of ["Post", "Post reply", "Post to #general"])
      expect(
        decide(click(), {
          ...slack,
          targetRole: "AXButton",
          targetLabel: label,
        }),
      ).toMatchObject({ kind: "CONFIRM", reason: "Publish this post?" });
    expect(
      decide(click(), {
        ...slack,
        targetRole: "AXButton",
        targetLabel: "Publish",
      }).kind,
    ).toBe("CONFIRM");
  });
});

// Cycle 20260919-0226-17c6e7f, ABOUT_NOT_OPEN in 4 of 6 settings attempts:
// System Settings lists the General pane's rows as AXButtons described by
// their pane name, so the model named "About" from context.controls, the
// resolved click asked `Click "About"?`, the bench declined, and three
// declines paused the run with About never opened.
describe("System Settings pane rows (cycle 20260919-0226-17c6e7f)", () => {
  const settingsApp = { appId: "com.apple.systempreferences" };
  // The About row as the helper resolves and hit-tests it: a button whose
  // only accessible name is its description.
  const aboutRow = {
    ...settingsApp,
    controlStatus: "resolved" as const,
    controlLabel: "About",
    targetRole: "AXButton",
    targetLabel: "About",
  };
  it("opens the About row without asking", () => {
    expect(decide(named("About", { x: 0.781, y: 0.109 }), aboutRow)).toEqual({
      kind: "ALLOW",
      reason: "Open System Settings’ About pane: it only shows information.",
    });
    // The search route: the sidebar result is a row whose text names it.
    expect(
      decide(click(), {
        ...settingsApp,
        targetRole: "AXStaticText",
        targetLabel: "About",
        targetText: "About",
      }),
    ).toEqual({
      kind: "ALLOW",
      reason: "Select or open an identified, non-consequential item.",
    });
  });
  it("keeps asking before the pane's other rows and a reset under the pointer", () => {
    // The same list, one row down: only the anchored name is routine.
    for (const label of ["Software Update", "Sharing", "About This Mac"])
      expect(
        decide(named(label), {
          ...aboutRow,
          controlLabel: label,
          targetLabel: label,
        }),
      ).toMatchObject({ kind: "CONFIRM", reason: `Click “${label}”?` });
    // The consequential floor runs first, whatever the row is called.
    const reset = decide(named("Transfer or Reset"), {
      ...aboutRow,
      controlLabel: "Transfer or Reset",
      targetLabel: "Transfer or Reset",
    });
    expect(reset.kind).toBe("CONFIRM");
    expect(reset.reason).not.toBe("Click “Transfer or Reset”?");
    expect(
      decide(named("About"), {
        ...aboutRow,
        targetText: "About · Erase All Content and Settings",
      }).kind,
    ).toBe("CONFIRM");
  });
  it("still retries a row with no name or another element under the pointer", () => {
    // What System Events sees of the same button: no title, no description.
    const unnamed = decide(click(), {
      ...settingsApp,
      targetRole: "AXButton",
      targetLabel: "",
    });
    expect(unnamed.kind).toBe("RETRY");
    expect(unnamed.reason).toContain("no accessible label");
    const covered = decide(named("About"), {
      ...aboutRow,
      targetRole: "AXGroup",
      targetLabel: "Software Update",
    });
    expect(covered.kind).toBe("RETRY");
    expect(covered.reason).toContain("covered by something else");
  });
});

/**
 * NOT_REVIEWED (cycle 20260919-0739-d495598, three of three attempts): the
 * booking form's own submit button is labelled Review, and a review is what
 * the button opens: the page it leads to says nothing is booked until the
 * user confirms. The label carries no consequential word, so it reached the
 * benign-label gate, which did not know it and asked "Click “Review”?". The
 * unattended harness declines every question a task does not approve, the
 * model re-filled the form and asked the same question again, and the grader
 * saw no review posted and a run that ended after a decline. The decisions
 * below are the run's own sequence (focus a field, type, four times; the
 * review step; the confirm step) with content-free labels.
 */
describe("a web form's review step (cycle 20260919-0739-d495598)", () => {
  const safari = {
    appId: "com.apple.Safari",
    domain: "127.0.0.1",
    targetWebHost: "127.0.0.1",
  };
  const field = {
    ...safari,
    controlStatus: "resolved" as const,
    controlLabel: "Field",
    targetRole: "AXTextField",
    focusedRole: "AXTextField",
  };
  const button = (label: string) => ({
    ...safari,
    controlStatus: "resolved" as const,
    controlLabel: label,
    targetRole: "AXButton",
    targetLabel: label,
  });
  it("fills the form and opens the review without asking", () => {
    for (let i = 0; i < 4; i++) {
      expect(
        decide(named("Field", { x: 0.456, y: 0.3 + i / 10 }), field),
      ).toEqual({
        kind: "ALLOW",
        reason: "Focus a known input control.",
      });
      expect(decide(type("value"), field).kind).toBe("ALLOW");
    }
    expect(
      decide(named("Review", { x: 0.658, y: 0.58 }), button("Review")),
    ).toEqual({
      kind: "ALLOW",
      reason: "Activate an identified, non-consequential control.",
    });
    // A pointer click on the same button, and the label as sites style it.
    expect(decide(click(), button("Review")).kind).toBe("ALLOW");
    for (const label of ["Review…", "Review:", "Review (R)", "REVIEW"])
      expect(decide(click(), button(label)).kind, label).toBe("ALLOW");
  });
  it("still stops in front of the confirm step, whatever the setting or the words", () => {
    const confirm = named("Confirm reservation", { x: 0.5, y: 0.4 });
    const decision = decide(confirm, button("Confirm reservation"));
    expect(decision.kind).toBe("CONFIRM");
    expect(decision.reason).not.toBe("Click “Confirm reservation”?");
    // The user's own words mention confirming: an irreversible label is
    // never unlocked by them.
    for (const autonomy of ["ask", "task", "flow"] as const)
      expect(
        evaluate(
          confirm,
          { ...base, ...button("Confirm reservation") },
          { ...settings, autonomy },
          false,
          { userWords: "book it and check with me before you confirm" },
        ).kind,
        autonomy,
      ).toBe("CONFIRM");
  });
  it("keeps asking when review is only part of the label or the hit text says more", () => {
    // Labels that review and commit in one step carry the committing word.
    for (const label of [
      "Review order",
      "Review & confirm",
      "Review and submit",
      "Review and pay",
      "Submit review",
      "Post review",
      "Publish review",
    ])
      expect(decide(click(), button(label)).kind, label).toBe("CONFIRM");
    // A "Review" whose text under the pointer says the button confirms.
    expect(
      decide(click(), {
        ...button("Review"),
        targetText: "Review · Confirm reservation",
      }).kind,
    ).toBe("CONFIRM");
    // Other labels a booking site might use stay unknown and ask.
    for (const label of ["Reserve", "Book table", "Continue"])
      expect(decide(click(), button(label))).toMatchObject({
        kind: "CONFIRM",
        reason: `Click “${label}”?`,
      });
  });
});

describe("consequential and unverifiable input stays gated", () => {
  it.each<Row>([
    [
      "Enter in a Slack message field",
      key("ENTER"),
      {
        appId: "com.tinyspeck.slackmacgap",
        focusedRole: "AXTextArea",
        focusedLabel: "Message #general",
      },
      "CONFIRM",
    ],
    [
      "Enter in a single-line message field",
      key("ENTER"),
      {
        appId: "com.apple.MobileSMS",
        focusedRole: "AXTextField",
        focusedLabel: "iMessage",
      },
      "CONFIRM",
    ],
    [
      "multi-line text in Slack",
      type("hi\nthere"),
      { appId: "com.tinyspeck.slackmacgap", focusedRole: "AXTextArea" },
      "CONFIRM",
    ],
    [
      "multi-line text in a web textarea",
      type("hi\nthere"),
      { ...chrome, focusedRole: "AXTextArea" },
      "CONFIRM",
    ],
    [
      "Place order button",
      click(),
      { targetRole: "AXButton", targetLabel: "Place your order" },
      "CONFIRM",
    ],
    [
      "Accept cookies button",
      click(),
      { targetRole: "AXButton", targetLabel: "Accept all cookies" },
      "CONFIRM",
    ],
    [
      "Sign out menu item",
      click(),
      { targetRole: "AXMenuItem", targetLabel: "Sign Out" },
      "CONFIRM",
    ],
    [
      "Empty Trash menu item",
      click(),
      { targetRole: "AXMenuItem", targetLabel: "Empty Trash…" },
      "CONFIRM",
    ],
    [
      "consequential text inside a generic group",
      click(),
      { targetRole: "AXGroup", targetText: "Checkout now" },
      "CONFIRM",
    ],
    [
      "consequential child text of a vaguely labelled button",
      click(),
      {
        targetRole: "AXButton",
        targetLabel: "Primary",
        targetText: "Delete account",
      },
      "CONFIRM",
    ],
    [
      "right-click on a consequential control",
      rightClick,
      { targetRole: "AXButton", targetLabel: "Send" },
      "CONFIRM",
    ],
    [
      "double-click a script in Finder",
      doubleClick,
      {
        appId: "com.apple.finder",
        targetRole: "AXCell",
        targetText: "cleanup.command",
      },
      "CONFIRM",
    ],
    ["unlabelled button", click(), { targetRole: "AXButton" }, "RETRY"],
    ["no element hit", click(), {}, "RETRY"],
    [
      "unknown surface click",
      click(),
      { unknown: true, targetRole: "AXRow" },
      "RETRY",
    ],
    ["unknown surface arrow", key("DOWN"), { unknown: true }, "RETRY"],
    [
      "Dock right-click",
      rightClick,
      { targetAppId: "com.apple.dock", targetRole: "AXDockItem" },
      "RETRY",
    ],
    [
      "Dock list outside the verified path",
      click(),
      { targetAppId: "com.apple.dock", targetRole: "AXList" },
      "RETRY",
    ],
    [
      "clicking a Spotlight result row bypasses no launcher check",
      click(),
      {
        appId: "com.apple.Spotlight",
        targetRole: "AXRow",
        targetText: "Terminal",
      },
      "RETRY",
    ],
    [
      "protected link",
      click(),
      {
        ...chrome,
        targetRole: "AXLink",
        targetURL: "https://www.chase.com/login",
      },
      "CONFIRM",
    ],
    [
      "javascript link",
      click(),
      { targetRole: "AXLink", targetURL: "javascript:void(0)" },
      "DENY",
    ],
    [
      "file link",
      click(),
      { targetRole: "AXLink", targetURL: "file:///Users/x/run.command" },
      "DENY",
    ],
    ["CMD+Q", hotkey("CMD", "Q"), {}, "CONFIRM"],
    ["CMD+SHIFT+DELETE", hotkey("CMD", "SHIFT", "DELETE"), {}, "CONFIRM"],
    ["CMD+ENTER", hotkey("CMD", "ENTER"), {}, "CONFIRM"],
    ["unknown chord", hotkey("CMD", "SHIFT", "K"), {}, "RETRY"],
    ["CMD+B outside an editor", hotkey("CMD", "B"), {}, "RETRY"],
    [
      "SPACE on a focused button",
      key("SPACE"),
      { focusedRole: "AXButton" },
      "CONFIRM",
    ],
    [
      "BACKSPACE outside an editor",
      key("BACKSPACE"),
      { focusedRole: "AXOutline" },
      "CONFIRM",
    ],
    ["typing without a focused field", type("hello"), {}, "RETRY"],
    [
      "typing a credential",
      type("password: hunter2!x"),
      { focusedRole: "AXTextField" },
      "DENY",
    ],
    [
      "clipboard paste",
      hotkey("CMD", "V"),
      { focusedRole: "AXTextField" },
      "DENY",
    ],
    [
      "uninstaller label",
      click(),
      { targetRole: "AXButton", targetText: "Uninstaller" },
      "DENY",
    ],
  ])("%s", (_name, action, surface, kind) =>
    expect(decide(action, surface).kind).toBe(kind),
  );
  it("explains retries in terms the model can act on", () => {
    expect(decide(click(), { targetRole: "AXButton" }).reason).toContain(
      "no accessible label",
    );
    const chordReason = decide(hotkey("CMD", "SHIFT", "K"), {}).reason;
    expect(chordReason).toContain("not a routine shortcut");
    expect(chordReason).not.toContain("target could not be identified");
    expect(
      decide(type("hi\nthere"), { focusedRole: "AXTextArea" }).reason,
    ).toContain("Line breaks may send a message");
    expect(
      decide(click(), { targetRole: "AXButton", targetLabel: "Place order" }),
    ).toEqual({ kind: "CONFIRM", reason: "Place this order?" });
    expect(
      decide(click(), { targetRole: "AXButton", targetLabel: "Call" }),
    ).toEqual({ kind: "CONFIRM", reason: "Call this contact?" });
    expect(
      decide(key("ENTER"), {
        focusedRole: "AXTextField",
        focusedSubrole: "AXSearchField",
      }),
    ).toEqual({ kind: "ALLOW", reason: "Submit a search." });
  });
  it("keeps Spotlight Enter on its own verified path", () => {
    const retry = decide(key("ENTER"), {
      ...spotlight,
      focusedSubrole: "AXSearchField",
      focusedLabel: "Spotlight Search",
      launcher: {
        query: "chrome",
        selectedResult: "Chrome Remote Desktop Host",
      },
    });
    expect(retry.kind).toBe("RETRY");
    expect(retry.reason).toBe(
      'No input was sent. Spotlight selected "Chrome Remote Desktop Host" for "chrome". Use open_app with the exact application name, or retype the query to match the result exactly.',
    );
    const long = decide(key("ENTER"), {
      ...spotlight,
      launcher: { query: "q", selectedResult: "x".repeat(200) },
    });
    expect(long.reason.length).toBeLessThan(260);
    expect(
      decide(key("ENTER"), {
        ...spotlight,
        launcher: { query: "Setup", selectedResult: "Setup Assistant" },
      }).kind,
    ).toBe("DENY");
  });
});

describe("activatable controls need a benign label", () => {
  const mail = { appId: "com.apple.mail" };
  it.each<Row>([
    [
      "German Senden in Mail",
      click(),
      { ...mail, targetRole: "AXButton", targetLabel: "Senden" },
      "CONFIRM",
    ],
    [
      "Löschen",
      click(),
      { targetRole: "AXButton", targetLabel: "Löschen" },
      "CONFIRM",
    ],
    [
      "Replace in a save sheet",
      click(),
      { targetRole: "AXButton", targetLabel: "Replace" },
      "CONFIRM",
    ],
    [
      "Don't Save",
      click(),
      { targetRole: "AXButton", targetLabel: "Don't Save" },
      "CONFIRM",
    ],
    [
      "Don’t Save (curly)",
      click(),
      { targetRole: "AXButton", targetLabel: "Don’t Save" },
      "CONFIRM",
    ],
    [
      "Save",
      click(),
      { targetRole: "AXButton", targetLabel: "Save" },
      "CONFIRM",
    ],
    [
      "Turn off",
      click(),
      { ...chrome, targetRole: "AXButton", targetLabel: "Turn off" },
      "CONFIRM",
    ],
    [
      "No protection radio",
      click(),
      { ...chrome, targetRole: "AXRadioButton", targetLabel: "No protection" },
      "CONFIRM",
    ],
    [
      "System Settings checkbox",
      click(),
      {
        appId: "com.apple.systempreferences",
        targetRole: "AXCheckBox",
        targetLabel: "Firewall",
      },
      "CONFIRM",
    ],
    [
      "Repost",
      click(),
      { targetRole: "AXButton", targetLabel: "Repost" },
      "CONFIRM",
    ],
    [
      "Comment",
      click(),
      { targetRole: "AXButton", targetLabel: "Comment" },
      "CONFIRM",
    ],
    [
      "Connect",
      click(),
      { targetRole: "AXButton", targetLabel: "Connect" },
      "CONFIRM",
    ],
    [
      "Decline",
      click(),
      { targetRole: "AXButton", targetLabel: "Decline" },
      "CONFIRM",
    ],
    [
      "Move to Bin",
      click(),
      { targetRole: "AXMenuItem", targetLabel: "Move to Bin" },
      "CONFIRM",
    ],
    [
      "Cancel subscription",
      click(),
      { targetRole: "AXButton", targetLabel: "Cancel subscription" },
      "CONFIRM",
    ],
    [
      "Move to Trash menu item",
      click(),
      { targetRole: "AXMenuItem", targetLabel: "Move to Trash" },
      "CONFIRM",
    ],
    [
      "unknown menu item",
      click(),
      { targetRole: "AXMenuItem", targetLabel: "Duplicate" },
      "CONFIRM",
    ],
    [
      "Reply",
      click(),
      { ...mail, targetRole: "AXButton", targetLabel: "Reply" },
      "ALLOW",
    ],
    [
      "Show Sidebar",
      click(),
      { targetRole: "AXButton", targetLabel: "Show Sidebar" },
      "ALLOW",
    ],
    [
      "Play with hint",
      click(),
      { targetRole: "AXButton", targetLabel: "Play (k)" },
      "ALLOW",
    ],
    [
      "Settings…",
      click(),
      { targetRole: "AXMenuItem", targetLabel: "Settings…" },
      "ALLOW",
    ],
    [
      "New Folder menu item",
      click(),
      { targetRole: "AXMenuItem", targetLabel: "New Folder" },
      "ALLOW",
    ],
    [
      "Sort By menu item",
      click(),
      { targetRole: "AXMenuItem", targetLabel: "Sort By Name" },
      "ALLOW",
    ],
    [
      "prefix still loses to consequential words",
      click(),
      { targetRole: "AXMenuItem", targetLabel: "New Post" },
      "CONFIRM",
    ],
    [
      "Calculator digit button",
      click(),
      {
        appId: "com.apple.calculator",
        targetRole: "AXButton",
        targetLabel: "7",
      },
      "ALLOW",
    ],
    [
      "unlabelled Calculator button",
      click(),
      { appId: "com.apple.calculator", targetRole: "AXButton" },
      "RETRY",
    ],
    [
      "digit button outside Calculator",
      click(),
      { targetRole: "AXButton", targetLabel: "7" },
      "CONFIRM",
    ],
    ["unlabelled menu item", click(), { targetRole: "AXMenuItem" }, "RETRY"],
    ["unlabelled group", click(), { targetRole: "AXGroup" }, "RETRY"],
    [
      "labelled group",
      click(),
      { targetRole: "AXGroup", targetText: "Weather" },
      "ALLOW",
    ],
    [
      "popup button",
      click(),
      { targetRole: "AXPopUpButton", targetLabel: "Sort" },
      "ALLOW",
    ],
    [
      "right-click an unknown button",
      rightClick,
      { targetRole: "AXButton", targetLabel: "Senden" },
      "ALLOW",
    ],
    [
      "right-click an unlabelled image",
      rightClick,
      { targetRole: "AXImage" },
      "ALLOW",
    ],
  ])("%s", (_name, action, surface, kind) =>
    expect(decide(action, surface).kind).toBe(kind),
  );
  it("explains what approval covers", () => {
    expect(
      decide(click(), { targetRole: "AXButton", targetLabel: "Senden" }),
    ).toEqual({ kind: "CONFIRM", reason: "Click “Senden”?" });
    expect(
      decide(click(), { targetRole: "AXCheckBox", targetLabel: "Firewall" }),
    ).toEqual({ kind: "CONFIRM", reason: "Change this setting?" });
    expect(
      decide(click(), { targetRole: "AXButton", targetLabel: "Save" }),
    ).toEqual({ kind: "CONFIRM", reason: "Save these changes?" });
    expect(
      decide(click(), { targetRole: "AXButton", targetLabel: "Don't Save" })
        .reason,
    ).toBe("Discard unsaved changes?");
    const long = decide(click(), {
      targetRole: "AXButton",
      targetLabel: "x".repeat(200),
    }).reason;
    expect(long.length).toBeLessThan(80);
    expect(decide(click(), { targetRole: "AXGroup" }).reason).toContain(
      "no accessible label",
    );
  });
});

describe("Finder opening and code-running surfaces", () => {
  const finder = { appId: "com.apple.finder" };
  it.each<Row>([
    ["CMD+O in Finder", hotkey("CMD", "O"), finder, "CONFIRM"],
    ["CMD+DOWN in Finder", hotkey("CMD", "DOWN"), finder, "CONFIRM"],
    ["CMD+O elsewhere", hotkey("CMD", "O"), chrome, "ALLOW"],
    [
      "CMD+DOWN in a text field elsewhere",
      hotkey("CMD", "DOWN"),
      { focusedRole: "AXTextArea" },
      "ALLOW",
    ],
    [
      "double-click a Finder name field",
      doubleClick,
      { ...finder, targetRole: "AXTextField", targetLabel: "cleanup" },
      "CONFIRM",
    ],
    [
      "click a Finder name field",
      click(),
      { ...finder, targetRole: "AXTextField" },
      "ALLOW",
    ],
    [
      "double-click an app without extension",
      doubleClick,
      { ...finder, targetRole: "AXRow", targetText: "Zoom" },
      "CONFIRM",
    ],
    [
      "double-click an app bundle URL",
      doubleClick,
      {
        ...finder,
        targetRole: "AXCell",
        targetText: "Zoom",
        targetURL: "file:///Applications/zoom.us.app/",
      },
      "CONFIRM",
    ],
    [
      // Until 2026-09-19 this was CONFIRM, the false positive the recovery
      // tasks hit: the URL's extension names a document, so it opens.
      "double-click a document by its file URL",
      doubleClick,
      {
        ...finder,
        targetRole: "AXCell",
        targetText: "notes",
        targetURL: "file:///Users/x/notes.txt",
      },
      "ALLOW",
    ],
    [
      "double-click a file URL with an unknown extension",
      doubleClick,
      {
        ...finder,
        targetRole: "AXCell",
        targetText: "data",
        targetURL: "file:///Users/x/data.bin",
      },
      "CONFIRM",
    ],
    [
      "double-click a Desktop folder via targetAppId",
      doubleClick,
      {
        targetAppId: "com.apple.finder",
        targetRole: "AXImage",
        targetText: "Invoices",
        targetURL: "file:///Users/x/Desktop/Invoices/",
      },
      "ALLOW",
    ],
    [
      "double-click a web URL in Finder",
      doubleClick,
      {
        ...finder,
        targetRole: "AXCell",
        targetText: "x",
        targetURL: "https://example.com/",
      },
      "CONFIRM",
    ],
    [
      "double-click a word in a text field",
      doubleClick,
      { targetRole: "AXTextArea" },
      "RETRY",
    ],
    ["CMD+R in Chrome", hotkey("CMD", "R"), chrome, "ALLOW"],
    [
      "CMD+R in Xcode",
      hotkey("CMD", "R"),
      { appId: "com.apple.dt.Xcode" },
      "CONFIRM",
    ],
    [
      "CMD+R in Script Editor",
      hotkey("CMD", "R"),
      { appId: "com.apple.ScriptEditor2" },
      "USER_TAKEOVER",
    ],
    [
      "Run button in Script Editor",
      click(),
      {
        appId: "com.apple.ScriptEditor2",
        targetRole: "AXButton",
        targetLabel: "Run",
      },
      "USER_TAKEOVER",
    ],
    [
      "typing in Automator",
      type("ls"),
      { appId: "com.apple.Automator", focusedRole: "AXTextArea" },
      "USER_TAKEOVER",
    ],
    [
      "Automator applet",
      click(),
      {
        appId: "com.apple.automator.MyApplet",
        targetRole: "AXButton",
        targetLabel: "OK",
      },
      "USER_TAKEOVER",
    ],
    [
      "Disk Utility",
      click(),
      { appId: "com.apple.DiskUtility", targetRole: "AXRow" },
      "USER_TAKEOVER",
    ],
    [
      "Installer as a click target",
      click(),
      {
        targetAppId: "com.apple.installer",
        targetRole: "AXButton",
        targetLabel: "Continue",
      },
      "USER_TAKEOVER",
    ],
    [
      "Terminal lowercase",
      key("DOWN"),
      { appId: "com.apple.terminal" },
      "USER_TAKEOVER",
    ],
    [
      "Terminal from the Dock",
      click(),
      {
        targetAppId: "com.apple.dock",
        targetRole: "AXDockItem",
        targetSubrole: "AXApplicationDockItem",
        launcherAppId: "com.apple.Terminal",
        targetLabel: "Terminal",
      },
      "USER_TAKEOVER",
    ],
  ])("%s", (_name, action, surface, kind) =>
    expect(decide(action, surface).kind).toBe(kind),
  );
  it("keeps the floor when settings remove protected apps", () => {
    const open = { ...settings, protectedApps: [] };
    for (const appId of [
      "com.apple.Terminal",
      "com.googlecode.iterm2",
      "com.apple.ScriptEditor2",
      "com.apple.Automator",
      "com.apple.DiskUtility",
      "com.apple.keychainaccess",
      "com.apple.installer",
      "com.apple.MigrateAssistant",
      "com.apple.bootcampassistant",
    ])
      expect(evaluate(key("DOWN"), { ...base, appId }, open, false).kind).toBe(
        "USER_TAKEOVER",
      );
    expect(
      decide(openApp("Script Editor"), {
        launcherStatus: "resolved",
        launcherAppId: "com.apple.ScriptEditor2",
        launcherName: "Script Editor",
      }).kind,
    ).toBe("DENY");
    expect(decide(hotkey("CMD", "R"), {}).reason).toBe(
      "Run or reload in this application?",
    );
  });
});

describe("multi-line and tabbed typing", () => {
  it.each<Row>([
    [
      "newline in the VS Code terminal",
      type("ls\n"),
      { appId: "com.microsoft.VSCode", focusedRole: "AXTextArea" },
      "CONFIRM",
    ],
    [
      "newline in Xcode",
      type("a\nb"),
      { appId: "com.apple.dt.Xcode", focusedRole: "AXTextArea" },
      "CONFIRM",
    ],
    [
      "newline in a Mail subject field",
      type("a\nb"),
      { appId: "com.apple.mail", focusedRole: "AXTextField" },
      "CONFIRM",
    ],
    [
      "newline in the Mail body",
      type("a\nb"),
      { appId: "com.apple.mail", focusedRole: "AXTextArea" },
      "ALLOW",
    ],
    [
      "tab in a sign-in field",
      type("jdoe\tsomething-else"),
      { focusedRole: "AXTextField" },
      "CONFIRM",
    ],
    [
      "tab in Slack",
      type("a\tb"),
      { appId: "com.tinyspeck.slackmacgap", focusedRole: "AXTextArea" },
      "CONFIRM",
    ],
    [
      "tab in a TextEdit document",
      type("a\tb"),
      { appId: "com.apple.TextEdit", focusedRole: "AXTextArea" },
      "ALLOW",
    ],
    [
      "tab in Calculator",
      type("1\t2"),
      { appId: "com.apple.calculator" },
      "RETRY",
    ],
    [
      "tab in a browser address bar",
      key("ENTER"),
      {
        ...chrome,
        addressBar: true,
        focusedRole: "AXTextField",
        focusedValue: "example.com\tx",
      },
      "CONFIRM",
    ],
  ])("%s", (_name, action, surface, kind) =>
    expect(decide(action, surface).kind).toBe(kind),
  );
});

describe("Spotlight launcher matching", () => {
  it.each([
    ["Chrome", "Google Chrome", true],
    ["google chrome", "Google Chrome.app", true],
    ["Settings", "System Settings", true],
    ["Code", "Visual Studio Code", true],
    ["Apple Notes", "Notes", true],
    ["Word", "Microsoft Word 2021", true],
    ["notes", "Notes.app", true],
    ["Chrome", "Chrome Remote Desktop Host", false],
    ["Studio", "Android Studio", false],
    ["Google", "Google Chrome", false],
    ["Notes", "Stickies", false],
    ["", "Google Chrome", false],
    ["Chrome", "", false],
    ["Apple", "Apple", true],
  ])("%s -> %s is %s", (query, selected, expected) =>
    expect(launcherMatches(query, selected)).toBe(expected),
  );
  // Shared with native/macos/LaunchSafety.swift (launchNameDenied) for parity.
  it.each(installerNames.match)("installer fixture matches: %s", (value) =>
    expect(isInstallerName(value)).toBe(true),
  );
  it.each(installerNames.noMatch)(
    "installer fixture does not match: %s",
    (value) => expect(isInstallerName(value)).toBe(false),
  );
  it("recognises installers in names and bundle ids", () => {
    for (const value of [
      "Chrome Remote Desktop Host Uninstaller",
      "Install macOS Sonoma",
      "com.google.chromeremotedesktop.me2me-host-uninstaller",
      "com.apple.InstallAssistant.Sonoma",
      "Setup Assistant",
      "Migration Assistant",
      "Boot Camp Assistant",
    ])
      expect(isInstallerName(value)).toBe(true);
    for (const value of ["Google Chrome", "com.apple.Notes", "Stickies"])
      expect(isInstallerName(value)).toBe(false);
  });
});

describe("Calculator keypad input", () => {
  const calculator = { appId: "com.apple.calculator" };
  it("allows calculations without a focused text field", () => {
    for (const action of [
      { type: "type_text", frame_id: "f", text: "128*46=" },
      { type: "type_text", frame_id: "f", text: "12.5 / 3" },
      { type: "key", frame_id: "f", key: "7" },
      { type: "key", frame_id: "f", key: "ENTER" },
      { type: "key", frame_id: "f", key: "BACKSPACE" },
    ] as Action[])
      expect(decide(action, calculator).kind).toBe("ALLOW");
  });
  it("gates keypad input while a sheet or dialog is open and non-keypad buttons", () => {
    const click = {
      type: "click",
      frame_id: "f",
      x: 0.3,
      y: 0.5,
      button: "left",
    } as Action;
    expect(
      decide(click, {
        ...calculator,
        targetRole: "AXButton",
        targetLabel: "multiply",
      }).kind,
    ).toBe("ALLOW");
    expect(
      decide(click, {
        ...calculator,
        targetRole: "AXButton",
        targetLabel: "Print",
        modal: true,
      }).kind,
    ).not.toBe("ALLOW");
    expect(
      decide(click, {
        ...calculator,
        targetRole: "AXButton",
        targetLabel: "Replace",
        modal: true,
      }).kind,
    ).toBe("CONFIRM");
    expect(
      decide({ type: "key", frame_id: "f", key: "ENTER" } as Action, {
        ...calculator,
        modal: true,
      }).kind,
    ).not.toBe("ALLOW");
    expect(
      decide({ type: "type_text", frame_id: "f", text: "12" } as Action, {
        ...calculator,
        modal: true,
      }).kind,
    ).not.toBe("ALLOW");
  });
  it("keeps other text, other apps and unknown surfaces gated", () => {
    expect(
      decide({ type: "type_text", frame_id: "f", text: "hello" }, calculator)
        .kind,
    ).toBe("RETRY");
    expect(
      decide(
        { type: "type_text", frame_id: "f", text: "128*46=" },
        { appId: "com.apple.mail" },
      ).kind,
    ).toBe("RETRY");
    expect(
      decide(
        { type: "key", frame_id: "f", key: "ENTER" },
        { ...calculator, unknown: true },
      ).kind,
    ).not.toBe("ALLOW");
  });
});
describe("open_app policy", () => {
  const resolved: Partial<Surface> = {
    launcherStatus: "resolved",
    launcherAppId: "com.google.Chrome",
    launcherName: "Google Chrome",
  };
  it("refuses to open the app that is already frontmost", () => {
    // Live: Spotify was frontmost and the model sent open_app twelve times.
    const decision = decide(openApp("Spotify"), {
      appId: "com.spotify.client",
      launcherStatus: "resolved",
      launcherAppId: "com.spotify.client",
      launcherName: "Spotify",
    });
    expect(decision.kind).toBe("RETRY");
    expect(decision.reason).toMatch(/already open and frontmost/);
    // Switching to a different app still works.
    expect(
      decide(openApp("Google Chrome"), {
        ...resolved,
        appId: "com.spotify.client",
      }).kind,
    ).toBe("ALLOW");
  });
  it("lets open_app show the window of a frontmost app that has none", () => {
    // Live: Calendar was running with no window; open_app activated it, the
    // screenshot showed the app behind it, and a second open_app was refused
    // with "work with what is on screen" until the run handed over.
    const calendar: Partial<Surface> = {
      appId: "com.apple.iCal",
      appName: "Calendar",
      launcherStatus: "resolved",
      launcherAppId: "com.apple.iCal",
      launcherName: "Calendar",
    };
    expect(
      decide(openApp("Calendar"), { ...calendar, windowCount: 0 }),
    ).toEqual({
      kind: "ALLOW",
      reason: "Show the main window of an application open with no window.",
    });
    // A window on screen, or a helper that reported no count, keeps the refusal.
    for (const windowCount of [1, undefined])
      expect(
        decide(openApp("Calendar"), { ...calendar, windowCount }).reason,
      ).toMatch(/already open and frontmost/);
    // The windowless exception never reaches past a refusal.
    expect(
      decide(openApp("Installer"), {
        ...calendar,
        windowCount: 0,
        appId: "com.apple.installer",
        launcherAppId: "com.apple.installer",
      }).kind,
    ).not.toBe("ALLOW");
    expect(
      decide(openApp("Calendar"), {
        ...calendar,
        windowCount: 0,
        launcherStatus: "refused",
      }).kind,
    ).toBe("DENY");
    expect(
      evaluate(
        openApp("Calendar"),
        { ...base, ...calendar, windowCount: 0 },
        {
          ...settings,
          protectedApps: [...settings.protectedApps, "com.apple.ical"],
        },
        false,
      ).kind,
    ).not.toBe("ALLOW");
  });
  it("turns a Dock click on the windowless frontmost app into a route", () => {
    const dock: Partial<Surface> = {
      appId: "com.apple.iCal",
      appName: "Calendar",
      targetAppId: "com.apple.dock",
      targetRole: "AXDockItem",
      targetSubrole: "AXApplicationDockItem",
      launcherAppId: "com.apple.iCal",
      targetLabel: "Calendar",
    };
    const windowless = decide(click(), { ...dock, windowCount: 0 });
    // It never sends the model back to open_app, which the history of a
    // windowless open_app tells it not to repeat.
    expect(windowless.reason).not.toMatch(/open_app/);
    expect(windowless).toEqual({
      kind: "RETRY",
      reason:
        "No input was sent. Calendar is open but shows no window. Choose its window from its Window menu in context.menus, or use File > New.",
    });
    // With a window, or on another application's icon, the redirect is generic.
    for (const surface of [
      { ...dock, windowCount: 1 },
      { ...dock, windowCount: 0, appId: "com.apple.Notes" },
      dock,
    ]) {
      const decision = decide(click(), surface);
      expect(decision.kind).toBe("RETRY");
      expect(decision.reason).toBe(
        "No input was sent. To open or switch to an application, use open_app with its exact name instead of clicking the Dock.",
      );
    }
    // Refusals still come first.
    expect(
      decide(click(), {
        ...dock,
        windowCount: 0,
        appId: "com.apple.Terminal",
        launcherAppId: "com.apple.Terminal",
        targetLabel: "Terminal",
      }).kind,
    ).toBe("USER_TAKEOVER");
  });
  it("opens a verified installed application", () => {
    expect(decide(openApp("Google Chrome"), resolved)).toEqual({
      kind: "ALLOW",
      reason: "Open a verified installed application.",
    });
    expect(describeAction(openApp("Google Chrome"))).toBe(
      "Open Google Chrome.",
    );
  });
  it("covers every refusal branch", () => {
    expect(decide(openApp("Notes"), resolved, true)).toEqual({
      kind: "RETRY",
      reason: "The tutorial has no applications to open.",
    });
    expect(decide(openApp("Notes"), { ...resolved, unknown: true })).toEqual({
      kind: "RETRY",
      reason:
        "No input was sent. Accessibility is not trusted, so applications cannot be opened.",
    });
    const installer =
      "That application cannot be opened by the assistant: installers, uninstallers, system utilities and protected apps require manual operation. If the task needs it, ask the user with request_user.";
    expect(decide(openApp("Notes"), { launcherStatus: "refused" })).toEqual({
      kind: "DENY",
      reason: installer,
    });
    expect(
      decide(openApp("Chrome Remote Desktop Host Uninstaller"), resolved).kind,
    ).toBe("DENY");
    expect(
      decide(openApp("Chrome"), {
        ...resolved,
        launcherAppId: "com.google.chromeremotedesktop.me2me-host-uninstaller",
      }).reason,
    ).toBe(installer);
    expect(
      decide(openApp("Terminal"), {
        launcherStatus: "resolved",
        launcherAppId: "com.apple.Terminal",
        launcherName: "Terminal",
      }),
    ).toEqual({
      kind: "DENY",
      reason:
        "That application is protected. Ask the user to open it with request_user.",
    });
    expect(
      decide(openApp("Chrom"), {
        launcherStatus: "unresolved",
        launcherCandidates: ["Google Chrome", "Chromium"],
      }),
    ).toEqual({
      kind: "RETRY",
      reason:
        'No input was sent. No installed application matches "Chrom" exactly. Candidates: Google Chrome, Chromium. Use one of them, or request_user if it is not installed.',
    });
    expect(
      decide(openApp("Figma"), { launcherStatus: "unresolved" }).reason,
    ).toBe(
      'No input was sent. No installed application matches "Figma" exactly. Use one of them, or request_user if it is not installed.',
    );
    expect(
      decide(openApp("Code"), {
        launcherStatus: "ambiguous",
        launcherCandidates: ["Visual Studio Code", "Code"],
      }),
    ).toEqual({
      kind: "RETRY",
      reason:
        "More than one installed application matches. Candidates: Visual Studio Code, Code. Use the exact name.",
    });
    // A resolution without a bundle id is not verified.
    expect(decide(openApp("Notes"), { launcherStatus: "resolved" }).kind).toBe(
      "RETRY",
    );
    expect(decide(openApp("Notes"), {}).kind).toBe("RETRY");
    // Protected foreground still wins before any launch decision.
    expect(
      decide(openApp("Notes"), { ...resolved, secureInput: true }).kind,
    ).toBe("USER_TAKEOVER");
  });
  it("bounds candidates echoed back to the model", () => {
    const reason = decide(openApp("x"), {
      launcherStatus: "unresolved",
      launcherCandidates: Array.from(
        { length: 9 },
        (_, i) => `App ${i}\n"${"y".repeat(100)}`,
      ),
    }).reason;
    expect(reason).not.toContain("\n");
    expect(reason).not.toContain("App 5");
    expect(reason.length).toBeLessThan(500);
  });
  it.each([
    "/Applications/Calculator.app",
    "..\\Terminal",
    "file:Terminal",
    ".hidden",
    "Notes\nTerminal",
    "",
    "x".repeat(101),
  ])("rejects path-like or malformed names: %j", (name) =>
    expect(
      actionSchema.safeParse({ type: "open_app", frame_id: "f", name }).success,
    ).toBe(false),
  );
  it("accepts plain display names", () => {
    for (const name of ["Google Chrome", "Notes", "Visual Studio Code"])
      expect(
        actionSchema.safeParse({ type: "open_app", frame_id: "f", name })
          .success,
      ).toBe(true);
  });
});

const openFile = (path: string) => act({ type: "open_file", path });
describe("open_file policy", () => {
  const doc: Partial<Surface> = {
    fileStatus: "resolved",
    fileKind: "document",
    fileName: "Q3.xlsx",
  };
  const unresolved =
    "No input was sent. That path is not in the local index. Use a path listed in context.memory.files or folders, or request_user.";
  it("opens resolved documents and folders from the local index", () => {
    const allow = {
      kind: "ALLOW",
      reason: "Open a document or folder from the local index.",
    };
    expect(decide(openFile("~/Documents/Q3.xlsx"), doc)).toEqual(allow);
    expect(
      decide(openFile("~/Documents/Projects"), {
        fileStatus: "resolved",
        fileKind: "folder",
        fileName: "Projects",
      }),
    ).toEqual(allow);
  });
  it("never opens files in the tutorial", () => {
    expect(decide(openFile("~/Documents/Q3.xlsx"), doc, true)).toEqual({
      kind: "RETRY",
      reason: "The tutorial has no files to open.",
    });
  });
  it("retries on an unknown surface", () => {
    const d = decide(openFile("~/Documents/Q3.xlsx"), {
      ...doc,
      unknown: true,
    });
    expect(d.kind).toBe("RETRY");
    expect(d.reason).toContain("No input was sent.");
  });
  it("denies natively refused files", () => {
    expect(
      decide(openFile("~/Downloads/run.command"), { fileStatus: "refused" }),
    ).toEqual({
      kind: "DENY",
      reason:
        "That file cannot be opened by the assistant: apps, scripts, installers and private system files require manual operation.",
    });
    // Refused wins even if a kind was reported.
    expect(
      decide(openFile("~/Downloads/x.pkg"), {
        fileStatus: "refused",
        fileKind: "document",
      }).kind,
    ).toBe("DENY");
  });
  it("retries unresolved, missing or incomplete resolutions", () => {
    for (const surface of [
      { fileStatus: "unresolved" as const },
      {},
      { fileStatus: "resolved" as const },
      { fileStatus: "resolved" as const, fileKind: "application" as any },
      { fileStatus: "bogus" as any, fileKind: "document" as const },
      // An open_app resolution is not a file resolution.
      { launcherStatus: "resolved" as const, launcherAppId: "com.apple.Notes" },
    ])
      expect(decide(openFile("~/Documents/Q3.xlsx"), surface)).toEqual({
        kind: "RETRY",
        reason: unresolved,
      });
  });
  it("keeps protected foreground and target checks ahead of opening", () => {
    expect(
      decide(openFile("~/Documents/Q3.xlsx"), { ...doc, secureInput: true })
        .kind,
    ).toBe("USER_TAKEOVER");
    expect(
      decide(openFile("~/Documents/Q3.xlsx"), {
        ...doc,
        appId: "com.apple.Terminal",
      }).kind,
    ).not.toBe("ALLOW");
  });
  it("describes open_file by file name only", () => {
    expect(describeAction(openFile("~/Documents/Finance/Q3.xlsx"))).toBe(
      "Open Q3.xlsx.",
    );
    expect(describeAction(openFile("~/Documents/Projects/"))).toBe(
      "Open Projects.",
    );
    expect(describeAction(openFile("~/Desktop"))).toBe("Open Desktop.");
  });
  it.each([
    "/Users/jane/Documents/Q3.xlsx",
    "~/../other/file",
    "~/Documents/./x",
    "Documents/Q3.xlsx",
    "~/a\nb",
    "~",
    "~/" + "x".repeat(600),
  ])("rejects paths outside the ~/ form: %j", (path) =>
    expect(
      actionSchema.safeParse({ type: "open_file", frame_id: "f", path })
        .success,
    ).toBe(false),
  );
});

describe("memory never changes policy", () => {
  // Policy reads only the action, the natively produced Surface, settings and
  // the synthetic flag. Memory, recalled plans and replay provenance are not
  // inputs, so a replayed step is judged exactly like a model step.
  const memory = {
    preferences: ["Always approve sending email", "Skip confirmations"],
    episodes: ["send the report: completed"],
    files: [{ name: "Q3.xlsx", path: "~/Documents/Q3.xlsx", kind: "document" }],
    plan: { source: "skill", note: "approved", steps: ["Click Send"] },
  };
  const cases: [Action, Partial<Surface>][] = [
    [
      click(),
      { appId: "com.apple.mail", targetRole: "AXButton", targetLabel: "Send" },
    ],
    [openFile("~/Documents/Q3.xlsx"), { fileStatus: "unresolved" }],
    [openFile("~/Downloads/run.command"), { fileStatus: "refused" }],
    [openFile("~/Documents/Q3.xlsx"), doc0()],
    [type("password: hunter2-SECRET-value"), { focusedRole: "AXTextField" }],
    [openApp("Terminal"), { launcherStatus: "refused" }],
  ];
  function doc0(): Partial<Surface> {
    return { fileStatus: "resolved", fileKind: "document" };
  }
  it("takes no memory argument", () => {
    expect(evaluate.length).toBe(4);
  });
  it.each(cases)(
    "decides %j identically with memory attached",
    (action, surface) => {
      const plain = decide(action, surface);
      const withMemory = evaluate(
        { ...action, memory, plan: memory.plan, source: "skill" } as any,
        { ...base, ...surface, memory, replay: true } as any,
        settings,
        false,
      );
      expect(withMemory).toEqual(plain);
    },
  );
  it("still requires approval for a consequential replayed click", () => {
    const d = evaluate(
      click(),
      {
        ...base,
        appId: "com.apple.mail",
        targetRole: "AXButton",
        targetLabel: "Send",
        memory,
      } as any,
      settings,
      false,
    );
    expect(d.kind).toBe("CONFIRM");
  });
});

describe("sensitive text detection", () => {
  it.each([
    "The bearer of this letter is my colleague.",
    "Bearer of good news",
    "MFA: enabled for all users",
    "OTP = optional",
    "Note: password: change it monthly",
    "Password: Forgot?",
    "password field hint",
    "api_key: required",
    "Password: Tap to reveal",
    "Password: Enter below",
    "Password: Tap.",
    "Password: weak",
    "Password: incorrect.",
    "Password: Sunny",
    "OTP code: enabled",
    "bearer abcdefghijklmnopqrstuvwxyz",
  ])("does not block prose: %s", (text) => expect(blocks(text)).toBe(false));
  it.each([
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123",
    "Bearer supersecret-token",
    "eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl",
    "password=syntheticSECRET",
    "passwd: hunter2!x",
    "client_secret=AbC123xyz",
    "MFA code: 482913",
    "otp=1234",
    "sk-syntheticTESTsecret123456",
    "password: abc12",
    "password: pw4!",
    "Password = hunter2",
    "otp: A1B2C3",
    "MFA code: 12ab",
    "authorization: bearer abcdefghijklmnopqrstuvwxyz0123",
    "bearer abc.def-ghi_jk",
  ])("blocks credentials: %s", (text) => expect(blocks(text)).toBe(true));
  it("keeps dates and identifiers but redacts phone numbers", () => {
    const summary =
      "Created 2026-09-16 14:30 for run 53f3e47f-1234-4567-8cd6-c0e751c0cd36 (order 12345678-1234-1234-1234-123456789012)";
    expect(sanitizeText(summary).text).toBe(summary);
    for (const phone of ["+1 415 555 0100", "555-123-4567", "(415) 555-0100"])
      expect(sanitizeText(`Call ${phone} today`).text).toBe(
        "Call [REDACTED:phone_or_account] today",
      );
    expect(sanitizeText("Version 12345678").text).toBe("Version 12345678");
    expect(sanitizeText("ID 1234567890123456789").text).toBe(
      "ID 1234567890123456789",
    );
  });
  it("redacts only credential spans", () =>
    expect(redactSecrets("Login: password=syntheticSECRET then continue")).toBe(
      "Login: [Sensitive text omitted] then continue",
    ));
});

describe("search result pages and Dock launches", () => {
  const click = {
    type: "click",
    frame_id: "f",
    x: 0.3,
    y: 0.4,
    button: "left",
  } as Action;
  it("treats labelled controls on search result pages as routine", () => {
    for (const domain of [
      "www.google.com",
      "google.co.uk",
      "duckduckgo.com",
      "www.bing.com",
    ])
      expect(
        decide(click, {
          appId: "com.apple.Safari",
          domain,
          targetWebHost: domain,
          targetRole: "AXButton",
          targetLabel: "°Fahrenheit",
        }).kind,
      ).toBe("ALLOW");
  });
  it("excludes browser chrome, other apps and embedded frames on other hosts", () => {
    const page = {
      appId: "com.apple.Safari",
      domain: "www.google.de",
      targetRole: "AXButton",
      targetLabel: "Abmelden",
    };
    for (const surface of [
      { ...page, targetWebHost: "ogs.google.com" },
      { ...page },
      {
        ...page,
        targetWebHost: "www.google.de",
        targetAppId: "com.apple.notificationcenterui",
      },
      { ...page, targetWebHost: "www.google.de", appId: "com.apple.mail" },
    ])
      expect(decide(click, surface).kind).toBe("CONFIRM");
  });
  it("keeps consequential words and other sites gated", () => {
    expect(
      decide(click, {
        appId: "com.apple.Safari",
        domain: "www.google.com",
        targetRole: "AXButton",
        targetLabel: "Delete all activity",
      }).kind,
    ).toBe("CONFIRM");
    for (const domain of [
      "mail.google.com",
      "google.com.evil.test",
      "shop.example",
    ])
      expect(
        decide(click, {
          appId: "com.apple.Safari",
          domain,
          targetRole: "AXButton",
          targetLabel: "°Fahrenheit",
        }).kind,
      ).toBe("CONFIRM");
  });
  it("sends Dock application clicks to open_app", () => {
    const decision = decide(click, {
      targetAppId: "com.apple.dock",
      targetRole: "AXDockItem",
      targetSubrole: "AXApplicationDockItem",
      launcherAppId: "com.apple.freeform",
      targetLabel: "Freeform",
    });
    expect(decision.kind).toBe("RETRY");
    expect(decision.reason).toContain("open_app");
  });
});

describe("YouTube search and results", () => {
  const youtube = { appId: "com.google.Chrome", domain: "www.youtube.com" };
  it("submits the YouTube search text area and filters results without approval", () => {
    expect(
      decide({ type: "key", frame_id: "f", key: "ENTER" } as Action, {
        ...youtube,
        focusedRole: "AXTextArea",
        focusedLabel: "Search or ask a question",
        focusedValue: "The Weeknd",
      }).kind,
    ).toBe("ALLOW");
    expect(
      decide(
        {
          type: "click",
          frame_id: "f",
          x: 0.5,
          y: 0.2,
          button: "left",
        } as Action,
        {
          ...youtube,
          targetRole: "AXRadioButton",
          targetLabel: "Videos",
          targetWebHost: "www.youtube.com",
        },
      ).kind,
    ).toBe("ALLOW");
  });
  it("keeps message areas, likes and other hosts gated", () => {
    expect(
      decide({ type: "key", frame_id: "f", key: "ENTER" } as Action, {
        ...youtube,
        focusedRole: "AXTextArea",
        focusedLabel: "Add a comment",
      }).kind,
    ).toBe("CONFIRM");
    expect(
      decide(
        {
          type: "click",
          frame_id: "f",
          x: 0.5,
          y: 0.2,
          button: "left",
        } as Action,
        {
          ...youtube,
          targetRole: "AXButton",
          targetLabel: "like this video",
          targetWebHost: "www.youtube.com",
        },
      ).kind,
    ).toBe("CONFIRM");
    expect(
      decide(
        {
          type: "click",
          frame_id: "f",
          x: 0.5,
          y: 0.2,
          button: "left",
        } as Action,
        {
          ...youtube,
          targetRole: "AXRadioButton",
          targetLabel: "Videos",
          targetWebHost: "ads.example",
        },
      ).kind,
    ).toBe("CONFIRM");
  });
});

// Live run, 2026-09-17: "Open Spotify and play Weeknd after hours". Spotify
// (Chromium/CEF) opened, then every observation returned no focused element,
// no controls and no hit-test target, so the model repeated open_app six
// times, pressed CMD+TAB twice and clicked blind until the run handed off.
describe("applications that publish no accessibility", () => {
  const spotify = {
    appId: "com.spotify.client",
    appName: "Spotify",
    accessibility: "none" as const,
  };
  const seeing = { ...spotify, accessibility: "full" as const };
  it("offers one approved click instead of a retry that cannot succeed", () => {
    expect(decide(click(), spotify)).toEqual({
      kind: "CONFIRM",
      reason: "Click here in Spotify? I can’t see its controls.",
    });
    expect(decide(doubleClick, spotify)).toEqual({
      kind: "CONFIRM",
      reason: "Double-click here in Spotify? I can’t see its controls.",
    });
    expect(decide(rightClick, spotify)).toEqual({
      kind: "CONFIRM",
      reason: "Right-click here in Spotify? I can’t see its controls.",
    });
    expect(decide(click("right"), spotify).kind).toBe("CONFIRM");
  });
  it("asks before typing into a field it cannot see, without the text", () => {
    const decision = decide(type("Discover Weekly"), spotify);
    expect(decision).toEqual({
      kind: "CONFIRM",
      reason: "Type here in Spotify? I can’t see its text fields.",
    });
    expect(decision.reason).not.toContain("Discover Weekly");
    expect(decide(type("new music\n"), spotify).kind).toBe("CONFIRM");
  });
  it("names the application even without a display name", () => {
    expect(
      decide(click(), { ...spotify, appName: undefined }).reason,
    ).toContain("Click here in client?");
    expect(
      decide(click(), { appId: "", accessibility: "none" }).reason,
    ).toContain("Click here in this app?");
  });
  it("keeps every refusal that applies when nothing can be identified", () => {
    // Secure input, protected apps and uninstallers stop before the surface is
    // ever called blind.
    expect(decide(click(), { ...spotify, secureInput: true }).kind).toBe(
      "USER_TAKEOVER",
    );
    expect(decide(type("hello"), { ...spotify, secureInput: true }).kind).toBe(
      "USER_TAKEOVER",
    );
    expect(
      decide(click(), {
        ...spotify,
        appId: "com.1password.1password",
        appName: "1Password",
      }).kind,
    ).toBe("USER_TAKEOVER");
    expect(
      decide(click(), {
        ...spotify,
        appId: "com.apple.terminal",
        appName: "Terminal",
      }).kind,
    ).toBe("USER_TAKEOVER");
    expect(
      decide(click(), { ...spotify, appId: "com.acme.Uninstaller" }).kind,
    ).toBe("USER_TAKEOVER");
    for (const app of [
      { appId: "com.acme.installer", appName: "Acme Installer" },
      { appId: "com.acme.opaque", appName: "Acme Setup Assistant" },
      { appId: "com.acme.updater", appName: "Acme Updater" },
    ]) {
      expect(decide(click(), { ...spotify, ...app }).kind).toBe("DENY");
      expect(decide(type("next"), { ...spotify, ...app }).kind).toBe("DENY");
    }
    expect(decide(type("api_key=sk-fixtureSECRET123456"), spotify).kind).toBe(
      "DENY",
    );
  });
  it("does not relax applications that do expose controls", () => {
    for (const surface of [
      seeing,
      { ...spotify, accessibility: "partial" as const },
      { ...spotify, accessibility: undefined },
      { ...spotify, unknown: true },
    ]) {
      expect(decide(click(), surface).kind).toBe("RETRY");
      expect(decide(doubleClick, surface).kind).toBe("RETRY");
      expect(decide(type("hello"), surface).kind).toBe("RETRY");
    }
    // A blind surface that did identify something is not blind for that step.
    expect(decide(click(), { ...spotify, targetRole: "AXButton" }).kind).toBe(
      "RETRY",
    );
    expect(decide(click(), { ...seeing, targetRole: "AXButton" }).kind).toBe(
      "RETRY",
    );
    expect(
      decide(click(), {
        ...seeing,
        targetRole: "AXButton",
        targetLabel: "Delete playlist",
      }).kind,
    ).toBe("CONFIRM");
    // The tutorial surface is never treated as a blind application.
    expect(decide(click(), spotify, true).kind).toBe("ALLOW");
  });
  it("opens the application's own search from the keyboard", () => {
    for (const keys of [
      ["CMD", "K"],
      ["CMD", "L"],
    ]) {
      expect(decide(hotkey(...keys), spotify).kind).toBe("ALLOW");
      expect(decide(hotkey(...keys), seeing).kind).toBe(
        keys[1] === "L" ? "DENY" : "RETRY",
      );
    }
    // Keyboard navigation and Enter already work; the gates are unchanged.
    for (const k of ["DOWN", "UP", "TAB", "ESC"])
      expect(decide(key(k), spotify).kind).toBe("ALLOW");
    expect(decide(key("ENTER"), spotify).kind).toBe("CONFIRM");
    expect(decide(hotkey("CMD", "ENTER"), spotify).kind).toBe("CONFIRM");
    expect(decide(hotkey("CMD", "Q"), spotify).kind).toBe("CONFIRM");
    expect(decide(hotkey("CMD", "SHIFT", "K"), spotify).kind).toBe("RETRY");
    // Relaunching the frontmost application still costs nothing and retries.
    expect(
      decide(openApp("Spotify"), {
        ...spotify,
        launcherStatus: "resolved",
        launcherAppId: spotify.appId,
      }).kind,
    ).toBe("RETRY");
  });
});

// The live failure this replaces: in an application that publishes no controls
// the agent guessed shortcuts, could not tell whether they worked, pressed
// CMD+TAB, landed in another application and reopened the first one, twenty
// actions long, until the loop detector stopped the run.
describe("named targets: menus and controls the agent can name", () => {
  const menu = (...path: string[]) => act({ type: "menu_item", path });
  const spotify = {
    appId: "com.spotify.client",
    accessibility: "none" as const,
  };
  it("presses a menu item the application publishes", () => {
    expect(
      decide(menu("Playback", "Play"), {
        ...spotify,
        menuStatus: "resolved",
        menuLabel: "Play",
      }),
    ).toEqual({
      kind: "ALLOW",
      reason: "Choose a menu item this application publishes.",
    });
  });
  it("still asks before a menu item that sends or deletes", () => {
    const decision = decide(menu("File", "Send"), {
      menuStatus: "resolved",
      menuLabel: "Send",
    });
    expect(decision.kind).toBe("CONFIRM");
    expect(decision.reason).toBe("Send this message?");
    expect(
      decide(menu("Edit", "Delete"), {
        menuStatus: "resolved",
        menuLabel: "Delete",
      }).kind,
    ).toBe("CONFIRM");
  });
  it("refuses to quit an application or end the session", () => {
    const decision = decide(menu("Spotify", "Quit Spotify"), {
      ...spotify,
      menuStatus: "refused",
    });
    expect(decision.kind).toBe("DENY");
    expect(decision.reason).toContain("left to the user");
  });
  // Native presses a published chord as its menu item and refuses Quit, so an
  // approval for CMD+Q could only ever end in that refusal.
  it("refuses a shortcut whose menu item is refused before asking", () => {
    const quit = decide(hotkey("CMD", "Q"), {
      ...spotify,
      shortcutLabel: "Quit Spotify",
      shortcutStatus: "refused",
    });
    expect(quit).toEqual({
      kind: "DENY",
      reason: decide(menu("Spotify", "Quit Spotify"), { menuStatus: "refused" })
        .reason,
    });
    // Refused before the delete rule would ask (Finder's Empty Trash chord).
    expect(
      decide(hotkey("CMD", "SHIFT", "BACKSPACE"), { shortcutStatus: "refused" })
        .kind,
    ).toBe("DENY");
    // An application without that item still asks, as before.
    expect(decide(hotkey("CMD", "Q"), spotify).kind).toBe("CONFIRM");
  });
  // The hotkey clipboard rules hold through the Edit menu too.
  it("keeps the clipboard rules for Copy, Cut and Paste menu items", () => {
    const resolved = (label: string) => ({
      menuStatus: "resolved" as const,
      menuLabel: label,
      focusedRole: "AXTextField",
    });
    for (const [path, label] of [
      [["Edit", "Copy"], "Copy"],
      [["Edit", "Cut"], "Cut"],
      [["Edit", "Paste"], "Paste"],
      [["Edit", "Paste and Match Style"], "Paste and Match Style"],
      [["Edit", "Copy Link"], "Copy Link"],
      [["Edit", "Copy Special", "Copy as HTML"], "Copy as HTML"],
    ] as const) {
      const decision = decide(menu(...path), resolved(label));
      expect(decision.kind).toBe("DENY");
      expect(decision.reason).toContain("Clipboard access is disabled");
    }
    // Even the paste the user asked for goes as CMD+V, which native checks
    // against the field it lands in; copying never goes either way.
    const asked = (path: string[], label: string) =>
      evaluate(
        menu(...path),
        { ...base, ...resolved(label) },
        settings,
        false,
        { pasteRequested: true },
      );
    const paste = asked(["Edit", "Paste"], "Paste");
    expect(paste.kind).toBe("RETRY");
    expect(paste.reason).toContain("CMD+V");
    expect(asked(["Edit", "Copy"], "Copy").kind).toBe("DENY");
    expect(
      asked(["Edit", "Paste and Match Style"], "Paste and Match Style").kind,
    ).toBe("DENY");
    // Other Edit items are unaffected.
    expect(
      decide(menu("Edit", "Select All"), resolved("Select All")).kind,
    ).toBe("ALLOW");
    expect(
      decide(menu("File", "Pasteboard"), resolved("Pasteboard")).kind,
    ).toBe("ALLOW");
  });
  it("sends a missing or greyed-out item back with what to do instead", () => {
    const missing = decide(menu("Playback", "Play"), {
      ...spotify,
      menuStatus: "missing",
    });
    expect(missing.kind).toBe("RETRY");
    expect(missing.reason).toContain("context.menus");
    // Spotify greys out Search while no window is open: the state, not the name.
    const disabled = decide(menu("Edit", "Search"), {
      ...spotify,
      menuStatus: "disabled",
    });
    expect(disabled.kind).toBe("RETRY");
    expect(disabled.reason).toContain("greyed out");
    expect(disabled.reason).toContain("open a window");
  });
  it("clicks a control by name under the same rules as a click", () => {
    expect(
      decide(named("After Hours"), {
        ...chrome,
        controlStatus: "resolved",
        controlLabel: "After Hours",
        targetRole: "AXLink",
        targetLabel: "After Hours",
        targetURL: "https://www.youtube.com/watch?v=x",
      }),
    ).toEqual({ kind: "ALLOW", reason: "Follow a web link." });
    // The label rules do not care how the control was addressed.
    expect(
      decide(named("Send"), {
        controlStatus: "resolved",
        targetRole: "AXButton",
        targetLabel: "Send",
      }).kind,
    ).toBe("CONFIRM");
    expect(
      decide(named("Search"), {
        controlStatus: "resolved",
        targetRole: "AXTextField",
        targetLabel: "Search",
      }),
    ).toEqual({ kind: "ALLOW", reason: "Focus a known input control." });
  });
  // Live: click_control on the "(9) midwest safety - YouTube" tab resolved,
  // but the element under its centre was a ChatGPT window in front of it, and
  // the click was allowed and landed there.
  it("refuses a named click when something else is under the pointer", () => {
    const covered = decide(named("(9) midwest safety - YouTube"), {
      ...chrome,
      controlStatus: "resolved",
      controlLabel: "(9) midwest safety - YouTube - Memory usage - 371 MB",
      targetRole: "AXGroup",
      targetLabel:
        "OpenCode business model - Google Chrome - Nitish (Person 1)",
    });
    expect(covered.kind).toBe("RETRY");
    expect(covered.reason).toContain("covered by something else");
    expect(covered.reason).toContain("Bring its window to the front");
    expect(covered.reason).not.toContain("scrolled");
    // Market 1/3 (cycle 20260920-0241): the mail fixture's reply form sat
    // under the Dock and every click on it was refused as covered. Native now
    // scrolls the page to reveal the control first (surface.controlScrolled);
    // one covered after that is not one its window in front would uncover,
    // so the sentence sends the model to the page's scroll or the keyboard.
    const scrolled = decide(named("Keep draft"), {
      ...chrome,
      controlStatus: "resolved",
      controlLabel: "Keep draft",
      controlScrolled: true,
      targetRole: "AXDockItem",
      targetLabel: "Finder",
    });
    expect(scrolled.kind).toBe("RETRY");
    expect(scrolled.reason).toContain(
      "was scrolled into view and is still covered by something else",
    );
    expect(scrolled.reason).toContain("Scroll the page yourself");
    expect(scrolled.reason).toContain("TAB");
    expect(scrolled.reason).not.toContain("Bring its window to the front");
    // Revealed and clear: the control itself is under the pointer, as usual.
    expect(
      decide(named("Keep draft"), {
        ...chrome,
        controlStatus: "resolved",
        controlLabel: "Keep draft",
        controlScrolled: true,
        targetRole: "AXButton",
        targetLabel: "Keep draft",
      }).reason,
    ).not.toContain("covered");
    // The same control under the pointer, or text that contains its name.
    expect(
      decide(named("Midwest Safety"), {
        ...chrome,
        controlStatus: "resolved",
        controlLabel: "Midwest Safety Verified @MidwestSafety",
        targetRole: "AXLink",
        targetLabel: "Midwest Safety Verified @MidwestSafety•4.73M subscribers",
        targetURL: "https://www.youtube.com/@MidwestSafety",
      }).kind,
    ).toBe("ALLOW");
    expect(
      decide(named("Play"), {
        controlStatus: "resolved",
        controlLabel: "Play",
        targetRole: "AXButton",
        targetLabel: "",
        targetText: "",
      }).reason,
    ).not.toContain("covered by something else");
  });
  it("explains a name that is gone or shared by several controls", () => {
    const missing = decide(named("After Hours"), { controlStatus: "missing" });
    expect(missing.kind).toBe("RETRY");
    expect(missing.reason).toContain("context.controls");
    const ambiguous = decide(named("Play"), { controlStatus: "ambiguous" });
    expect(ambiguous.kind).toBe("RETRY");
    expect(ambiguous.reason).toContain("x and y");
    expect(decide(named("Play"), { controlStatus: "disabled" }).kind).toBe(
      "RETRY",
    );
  });
  it("allows a chord the application's own menus publish", () => {
    // CMD+J is in no allow-list; Sublime Text's View menu says what it does.
    // (VS Code's own Toggle Panel opens its terminal: tests/policy-ide.test.ts.)
    const decision = decide(hotkey("CMD", "J"), {
      appId: "com.sublimetext.4",
      shortcutLabel: "Toggle Minimap",
    });
    expect(decision.kind).toBe("ALLOW");
    expect(decision.reason).toContain("Toggle Minimap");
    expect(
      decide(hotkey("CMD", "J"), { appId: "com.sublimetext.4" }).kind,
    ).toBe("RETRY");
  });
  it("asks about a published shortcut whose menu item is consequential", () => {
    const decision = decide(hotkey("CMD", "E"), {
      appId: "com.apple.mail",
      shortcutLabel: "Send Message",
    });
    expect(decision.kind).toBe("CONFIRM");
    expect(decision.reason).toBe("Send this message?");
  });
  it("turns Command-Tab into open_app instead of walking out of the app", () => {
    for (const chord of [hotkey("CMD", "TAB"), hotkey("CMD", "SHIFT", "TAB")]) {
      const decision = decide(chord, spotify);
      expect(decision.kind).toBe("RETRY");
      expect(decision.reason).toContain("open_app");
    }
    expect(decide(hotkey("CMD", "SPACE"), spotify).kind).toBe("ALLOW");
  });
  it("keeps every protected surface rule above named targets", () => {
    expect(
      decide(menu("Playback", "Play"), {
        ...spotify,
        secureInput: true,
        menuStatus: "resolved",
      }).kind,
    ).toBe("USER_TAKEOVER");
    // A protected application is handed to the user, whatever the action.
    expect(
      decide(named("Unlock"), {
        appId: "com.1password.1password",
        controlStatus: "resolved",
      }).kind,
    ).toBe("USER_TAKEOVER");
  });
});

// Live run: Edit > Search opened Spotify's search box, then three attempts to
// type "after hours" were refused because the box is not exposed, and the run
// handed the task back to the user.
describe("typing into the search the application just opened", () => {
  const spotify = {
    appId: "com.spotify.client",
    appName: "Spotify",
    accessibility: "partial" as const,
  };
  const opened = { ...spotify, searchOpenedBy: "Search" };
  it("types the query and opens the result", () => {
    expect(decide(type("after hours"), opened)).toEqual({
      kind: "ALLOW",
      reason: "Type into Spotify’s Search field.",
    });
    expect(decide(key("ENTER"), opened).kind).toBe("ALLOW");
    expect(decide(key("BACKSPACE"), opened).kind).toBe("ALLOW");
    expect(decide(key("DOWN"), opened).kind).toBe("ALLOW");
  });
  it("is exactly the old refusal without the app's own search command", () => {
    expect(decide(type("after hours"), spotify).kind).toBe("RETRY");
    expect(decide(key("ENTER"), spotify).kind).toBe("CONFIRM");
  });
  it("keeps every other rule for typing", () => {
    // Credentials, line breaks, secure input and modals are not relaxed.
    expect(decide(type("password=hunter2hunter2"), opened).kind).not.toBe(
      "ALLOW",
    );
    expect(decide(type("line one\nline two"), opened).kind).not.toBe("ALLOW");
    expect(
      decide(type("after hours"), { ...opened, secureInput: true }).kind,
    ).toBe("USER_TAKEOVER");
    expect(decide(type("after hours"), { ...opened, modal: true }).kind).toBe(
      "RETRY",
    );
  });
  it("defers to an identified focus", () => {
    // A known button has focus: its own rules decide, not the search context.
    expect(
      decide(key("ENTER"), {
        ...opened,
        focusedRole: "AXButton",
        focusedLabel: "Send",
      }).kind,
    ).not.toBe("ALLOW");
    // A known text field is typed into under the ordinary field rule.
    expect(
      decide(type("after hours"), { ...opened, focusedRole: "AXTextField" }),
    ).toEqual({
      kind: "ALLOW",
      reason: "Type in a known non-secure text field.",
    });
  });
});

// Live: "paste the image in Messages" was refused at CMD+V by the blanket
// clipboard rule; pasting what the user copied, when they asked for it, is the
// one clipboard press the agent may make.
describe("paste on request", () => {
  const field = { focusedRole: "AXTextArea", focusedLabel: "Message" };
  const asked = { pasteRequested: true };
  it("allows CMD+V into a text field when the user asked for a paste", () => {
    expect(
      evaluate(
        hotkey("CMD", "V"),
        { ...base, ...field },
        settings,
        false,
        asked,
      ),
    ).toEqual({ kind: "ALLOW", reason: PASTE_ALLOWED });
  });
  it("refuses it without the request, without a field, or with any other chord", () => {
    expect(
      evaluate(hotkey("CMD", "V"), { ...base, ...field }, settings, false).kind,
    ).toBe("DENY");
    expect(
      evaluate(hotkey("CMD", "V"), base, settings, false, asked).kind,
    ).toBe("DENY");
    expect(
      evaluate(
        hotkey("CMD", "C"),
        { ...base, ...field },
        settings,
        false,
        asked,
      ).kind,
    ).toBe("DENY");
    expect(
      evaluate(
        hotkey("CMD", "X"),
        { ...base, ...field },
        settings,
        false,
        asked,
      ).kind,
    ).toBe("DENY");
    expect(
      evaluate(
        hotkey("CMD", "SHIFT", "V"),
        { ...base, ...field },
        settings,
        false,
        asked,
      ).kind,
    ).toBe("DENY");
  });
  it("reads the request from the user's own words only", () => {
    expect(pasteRequested("Paste the image into Messages")).toBe(true);
    expect(pasteRequested("send it", [{ text: "you can just paste it" }])).toBe(
      true,
    );
    expect(pasteRequested("copy the link and send it")).toBe(false);
    expect(pasteRequested("open the pastebin site")).toBe(false);
  });
  it("never reads a paste request from a task the model rewrote or offered", () => {
    expect(
      pasteRequested("Paste the link into Notes", [], "model_rewrite"),
    ).toBe(false);
    expect(pasteRequested("Paste the link into Notes", [], "proposal")).toBe(
      false,
    );
    expect(pasteRequested("Paste the link into Notes", [], "user_words")).toBe(
      true,
    );
    expect(
      pasteRequested("Paste the link into Notes", [], "user_words_unsure"),
    ).toBe(true);
    // The user's own correction still counts after a rewrite.
    expect(
      pasteRequested(
        "Open Notes",
        [{ text: "just paste it" }],
        "model_rewrite",
      ),
    ).toBe(true);
  });
});

// Live: role "day cell" made a click_control on a Calendar day invalid.
describe("click_control roles the model spells its own way", () => {
  it("maps them to a listed role or drops them", () => {
    expect(controlRole("day cell")).toBe("cell");
    expect(controlRole("AXButton")).toBe("button");
    expect(controlRole("text field")).toBe("textfield");
    expect(controlRole("Link")).toBe("link");
    expect(controlRole("calendar thing")).toBeUndefined();
    expect(controlRole(3)).toBeUndefined();
  });
  it("keeps the action valid either way", () => {
    for (const role of ["day cell", "calendar thing", "AXButton"])
      expect(
        actionSchema.safeParse({
          type: "click_control",
          frame_id: "f",
          label: "19",
          role,
        }).success,
      ).toBe(true);
  });
});

describe("Finder double-click on a document by its own URL", () => {
  const finder = { appId: "com.apple.finder", targetRole: "AXCell" };
  const item = (targetURL: string | undefined, text = "item") =>
    decide(doubleClick, { ...finder, targetText: text, targetURL });
  const opened: Decision = { kind: "ALLOW", reason: "Open a document." };
  const asked: Decision = {
    kind: "CONFIRM",
    reason: "Open this item? It may run a program.",
  };
  const executable = [
    "app",
    "command",
    "tool",
    "sh",
    "zsh",
    "bash",
    "pkg",
    "mpkg",
    "dmg",
    "scpt",
    "applescript",
    "workflow",
    "terminal",
    "jar",
    "py",
    "rb",
    "pl",
  ];

  it("ships the document list as fixed, lowercase and disjoint from every executable extension", () => {
    expect([...documentExtensions]).toEqual([
      "txt",
      "rtf",
      "rtfd",
      "md",
      "markdown",
      "pdf",
      "png",
      "jpg",
      "jpeg",
      "gif",
      "heic",
      "heif",
      "webp",
      "tiff",
      "tif",
      "csv",
      "tsv",
      "json",
      "xml",
      "yaml",
      "yml",
      "log",
      "doc",
      "docx",
      "xls",
      "xlsx",
      "ppt",
      "pptx",
      "pages",
      "numbers",
      "key",
      "mov",
      "mp4",
      "m4v",
      "mp3",
      "m4a",
      "wav",
      "aiff",
      "aac",
      "epub",
      "ics",
      "vcf",
    ]);
    for (const ext of documentExtensions)
      expect(ext, ext).toBe(ext.toLowerCase());
    for (const ext of ["zip", "html", "htm", "svg", "js", "webloc", "inetloc"])
      expect(documentExtensions, ext).not.toContain(ext);
    for (const ext of executable) expect(documentExtensions).not.toContain(ext);
  });

  it.each(documentExtensions.map((ext) => [ext] as [string]))(
    "opens a .%s without a question",
    (ext) => {
      // Packages (rtfd, pages, numbers, key) come from the helper with a
      // trailing slash, like any directory; the rule reads the name either way.
      const packaged = ["rtfd", "pages", "numbers", "key"].includes(ext);
      const url = `file:///Users/x/Documents/report.${ext}${packaged ? "/" : ""}`;
      expect(documentURL(url)).toBe(true);
      expect(item(url, "report")).toEqual(opened);
    },
  );

  it.each([
    ["an uppercase extension", "file:///Users/x/NOTES.TXT"],
    ["a mixed-case extension", "file:///Users/x/Budget.Pdf"],
    ["a URL-encoded name", "file:///Users/x/my%20notes%20(final).txt"],
    ["a non-ASCII encoded name", "file:///Users/x/r%C3%A9sum%C3%A9.pdf"],
    ["a name with dots in its stem", "file:///Users/x/2026.09.budget.txt"],
    ["a package with a trailing slash", "file:///Users/x/Letter.pages/"],
    ["a package without one", "file:///Users/x/Letter.pages"],
    ["a folder with a bundle-looking stem", "file:///Users/x/a.b/c.txt"],
    // The extension decides what opens it: a text file under /Applications
    // is opened by its text editor, not run, wherever it sits.
    [
      "a document inside /Applications",
      "file:///Applications/Utilities/ReadMe.txt",
    ],
    [
      "a document inside an application bundle",
      "file:///Applications/Numbers.app/Contents/Resources/Release%20Notes.rtf",
    ],
  ])("opens %s", (_name, url) => {
    expect(documentURL(url)).toBe(true);
    expect(item(url)).toEqual(opened);
  });

  it.each([
    // A disguised program: Finder shows "report.pdf"; the URL says ".app".
    ["a double extension ending in .app", "file:///Users/x/report.pdf.app/"],
    ["a double extension ending in .command", "file:///Users/x/x.txt.command"],
    ["a double extension ending in .sh", "file:///Users/x/notes.md.sh"],
    ["an application bundle", "file:///Applications/Zoom.app/"],
    ["a disk image", "file:///Users/x/Downloads/Installer.dmg"],
    ["a shell script", "file:///Users/x/run.sh"],
    ["an installer package", "file:///Users/x/Setup.pkg"],
    ["a web page", "file:///Users/x/page.html"],
    ["an archive", "file:///Users/x/photos.zip"],
    ["an unknown extension", "file:///Users/x/data.bin"],
    ["a name without a stem", "file:///Users/x/.txt"],
    ["a name without an extension", "file:///Users/x/README"],
    ["a name ending in a dot", "file:///Users/x/notes."],
    ["an https URL", "https://example.com/notes.txt"],
    ["a data URL", "data:text/plain,notes.txt"],
    ["an unparseable URL", "not a url.txt"],
    ["a malformed escape", "file:///Users/x/bad%E0%A4%A.txt"],
  ])("asks about %s", (_name, url) => {
    expect(documentURL(url)).toBe(false);
    expect(item(url)).toEqual(asked);
  });

  it("asks about every executable extension, on its own or behind a document's", () => {
    for (const ext of executable) {
      expect(documentURL(`file:///Users/x/thing.${ext}`), ext).toBe(false);
      expect(item(`file:///Users/x/thing.${ext}`), ext).toEqual(asked);
      expect(item(`file:///Users/x/thing.txt.${ext}`), ext).toEqual(asked);
    }
  });

  it("asks about an item with no URL and a document extension in its label alone", () => {
    expect(documentURL(undefined)).toBe(false);
    expect(documentURL("")).toBe(false);
    expect(item(undefined, "notes.txt")).toEqual(asked);
    // The generic rule for other applications is unchanged: the label decides there.
    expect(
      decide(doubleClick, {
        appId: "com.example.files",
        targetRole: "AXCell",
        targetText: "run.command",
      }).kind,
    ).toBe("CONFIRM");
  });

  it("keeps a verified folder routine and a bundle asked, as before", () => {
    expect(item("file:///Users/x/Documents/Invoices/", "Invoices").kind).toBe(
      "ALLOW",
    );
    expect(item("file:///Users/x/Documents/Invoices/", "Invoices")).not.toEqual(
      opened,
    );
    expect(item("file:///Applications/zoom.us.app/", "Zoom")).toEqual(asked);
    expect(item("file:///Users/x/Run.workflow/", "Run")).toEqual(asked);
  });

  it("reads the Finder as the target application too", () => {
    expect(
      decide(doubleClick, {
        targetAppId: "com.apple.finder",
        targetRole: "AXImage",
        targetText: "notes",
        targetURL: "file:///Users/x/Desktop/notes.txt",
      }),
    ).toEqual(opened);
  });

  it("leaves the autonomy 'all' path as it was: programs done without asking, documents opened either way", () => {
    const all = {
      ...structuredClone(defaultSettings),
      autonomy: "all" as const,
      autonomyAllAcknowledged: true,
    };
    const under = (targetURL: string | undefined) =>
      evaluate(
        doubleClick,
        { ...base, ...finder, targetText: "item", targetURL },
        all,
        false,
      );
    expect(under("file:///Users/x/notes.txt")).toEqual(opened);
    expect(under("file:///Applications/Zoom.app/")).toEqual({
      kind: "ALLOW",
      reason:
        "Open this item: done without asking, as you set. Reported when done.",
    });
    expect(under(undefined).kind).toBe("ALLOW");
    // Unacknowledged, "all" is not in force.
    expect(
      evaluate(
        doubleClick,
        { ...base, ...finder, targetText: "item" },
        { ...all, autonomyAllAcknowledged: false },
        false,
      ),
    ).toEqual(asked);
  });

  it("still asks on the Finder's open keys, which carry no selection URL", () => {
    const finderKeys = { appId: "com.apple.finder" };
    expect(decide(hotkey("CMD", "O"), finderKeys)).toEqual(asked);
    expect(decide(hotkey("CMD", "DOWN"), finderKeys)).toEqual(asked);
    expect(
      decide(hotkey("CMD", "O"), {
        ...finderKeys,
        targetURL: "file:///Users/x/notes.txt",
      }),
    ).toEqual(asked);
  });
});
