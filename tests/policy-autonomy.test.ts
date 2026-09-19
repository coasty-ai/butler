import { describe, expect, it } from "vitest";
import {
  actionSchema,
  defaultSettings,
  type Action,
  type Settings,
  type Surface,
} from "../src/core/schema";
import {
  askedForLabel,
  evaluate,
  reversibleLabel,
  type PolicyContext,
} from "../src/core/policy";
import {
  AUTONOMY_ALL_ACKNOWLEDGEMENT,
  autonomyChange,
  autonomyHint,
} from "../src/ui/settings-voice";

/**
 * How often a run stops to ask. The line the settings never cross: a step
 * that cannot be undone (money out, something published or sent, anything
 * deleted or installed, account and security settings) asks every time.
 */
const base: Surface = {
  appId: "com.apple.TextEdit",
  pid: 7,
  secureInput: false,
  unknown: false,
};
const act = (input: Record<string, unknown>): Action =>
  actionSchema.parse({ frame_id: "f", ...input });
const menu = (label: string) =>
  act({ type: "menu_item", path: ["File", label] });
const control = (label: string) => act({ type: "click_control", label });
const shortcut = (...keys: string[]) => act({ type: "hotkey", keys });
const settingsWith = (autonomy: Settings["autonomy"]): Settings => ({
  ...structuredClone(defaultSettings),
  autonomy,
});
const decide = (
  action: Action,
  surface: Partial<Surface>,
  autonomy: Settings["autonomy"],
  context: PolicyContext = {},
) =>
  evaluate(
    action,
    { ...base, ...surface, menuStatus: "resolved", ...surface },
    settingsWith(autonomy),
    false,
    context,
  );
const menuSurface = (label: string) => ({
  menuStatus: "resolved" as const,
  menuLabel: label,
});
const controlSurface = (label: string) => ({
  controlStatus: "resolved" as const,
  controlLabel: label,
  targetLabel: label,
  targetRole: "button",
});

describe("how often it asks: the setting", () => {
  it("asks for everything consequential in 'ask', as it always did", () => {
    for (const label of ["Save", "Send", "Delete", "Like"])
      expect(decide(menu(label), menuSurface(label), "ask").kind).toBe(
        "CONFIRM",
      );
  });

  it("in 'task', runs an undoable step the user's own words asked for", () => {
    const words = { userWords: "save the draft in TextEdit" };
    const allowed = decide(menu("Save"), menuSurface("Save"), "task", words);
    expect(allowed.kind).toBe("ALLOW");
    expect(allowed.reason).toMatch(/what you asked for and can be undone/);
    // The same step, unasked for, still stops: the run is not free to save
    // things the user never mentioned.
    expect(decide(menu("Save"), menuSurface("Save"), "task").kind).toBe(
      "CONFIRM",
    );
    expect(
      decide(menu("Save"), menuSurface("Save"), "task", {
        userWords: "open the draft",
      }).kind,
    ).toBe("CONFIRM");
  });

  it("in 'flow', runs every undoable step and reports it", () => {
    for (const label of ["Save", "Like", "Archive", "Join", "Replace"]) {
      const decision = decide(menu(label), menuSurface(label), "flow");
      expect(decision.kind, label).toBe("ALLOW");
      expect(decision.reason).toMatch(/can be undone: done without asking/);
    }
  });

  it("asks for what cannot be undone, in every mode and however it was asked for", () => {
    const irreversible = [
      "Send",
      "Publish",
      "Pay",
      "Buy now",
      "Place order",
      "Delete",
      "Move to Bin",
      "Erase",
      "Install",
      "Uninstall",
      "Share",
      "Upload",
      "Invite",
      "Sign out",
      "Transfer",
      "Subscribe",
      "Accept",
    ];
    for (const label of irreversible)
      for (const autonomy of ["ask", "task", "flow"] as const) {
        // Even when the user's own words name it: "send the email" still asks.
        const context = { userWords: `${label.toLowerCase()} it for me` };
        expect(
          decide(menu(label), menuSurface(label), autonomy, context).kind,
          `${label} in ${autonomy}`,
        ).toBe("CONFIRM");
      }
  });

  it("applies the same rule to a clicked control and to the app's own shortcut", () => {
    const words = { userWords: "save it" };
    expect(
      decide(control("Save"), controlSurface("Save"), "task", words).kind,
    ).toBe("ALLOW");
    expect(decide(control("Send"), controlSurface("Send"), "flow").kind).toBe(
      "CONFIRM",
    );
    // A chord the app itself lists as "Save As…" (CMD+S is routine anyway
    // and never asked, with or without this setting).
    const saveAs = {
      shortcutLabel: "Save As…",
      menuStatus: "refused" as const,
    };
    const asked = { userWords: "save it as a pdf" };
    expect(
      decide(shortcut("CMD", "SHIFT", "S"), saveAs, "task", asked).kind,
    ).toBe("ALLOW");
    expect(
      decide(shortcut("CMD", "SHIFT", "S"), saveAs, "ask", asked).kind,
    ).toBe("CONFIRM");
    // The same chord, when the app lists it as something that cannot be
    // undone, asks in every mode.
    const send = { shortcutLabel: "Send", menuStatus: "refused" as const };
    expect(
      decide(shortcut("CMD", "SHIFT", "S"), send, "flow", {
        userWords: "send it",
      }).kind,
    ).toBe("CONFIRM");
  });

  it("changes nothing about protected apps, websites or pasting", () => {
    const passwords = { appId: "com.1password.1password" };
    for (const autonomy of ["ask", "task", "flow"] as const) {
      expect(
        decide(control("Save"), { ...passwords }, autonomy, {
          userWords: "save it",
        }).kind,
      ).not.toBe("ALLOW");
      // A paste still needs the user's own word for it, whatever the mode.
      expect(
        decide(shortcut("CMD", "V"), { focusedRole: "AXTextField" }, autonomy)
          .kind,
      ).not.toBe("ALLOW");
    }
  });
});

describe("how often it asks: allow everything", () => {
  const all = (over: Partial<Settings> = {}): Settings => ({
    ...structuredClone(defaultSettings),
    autonomy: "all",
    autonomyAllAcknowledged: true,
    ...over,
  });
  const decideAll = (
    action: Action,
    surface: Partial<Surface>,
    settings: Settings,
    context: PolicyContext = {},
  ) => evaluate(action, { ...base, ...surface }, settings, false, context);

  it("asks for nothing once it is chosen and acknowledged", () => {
    for (const label of ["Send", "Pay", "Delete", "Install", "Sign out"]) {
      const decision = decideAll(menu(label), menuSurface(label), all());
      expect(decision.kind, label).toBe("ALLOW");
      expect(decision.reason).toMatch(/as you set\. Reported when done/);
    }
  });

  it("does nothing without the acknowledgement: the mode alone is not consent", () => {
    const unacknowledged = all({ autonomyAllAcknowledged: false });
    // It behaves as the quiet mode: undoable steps run, the rest ask.
    expect(
      decideAll(menu("Send"), menuSurface("Send"), unacknowledged).kind,
    ).toBe("CONFIRM");
    expect(
      decideAll(menu("Delete"), menuSurface("Delete"), unacknowledged).kind,
    ).toBe("CONFIRM");
    expect(
      decideAll(menu("Save"), menuSurface("Save"), unacknowledged).kind,
    ).toBe("CONFIRM");
  });

  it("still refuses what is refused, not asked", () => {
    const settings = all();
    // A password manager is refused however the user set the asking.
    const passwords = { appId: "com.1password.1password" };
    expect(decideAll(control("Save"), passwords, settings).kind).not.toBe(
      "ALLOW",
    );
    // Typing into a credential field, and typing a secret anywhere.
    expect(
      decideAll(
        act({ type: "type_text", text: "hunter2" }),
        { focusedRole: "AXSecureTextField" },
        settings,
      ).kind,
    ).not.toBe("ALLOW");
    expect(
      decideAll(
        act({
          type: "type_text",
          text: "sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ",
        }),
        { focusedRole: "AXTextField" },
        settings,
      ).kind,
    ).not.toBe("ALLOW");
  });

  it("keeps the acknowledgement and the mode together", () => {
    // Picking it without ticking shows the tick box and asks meanwhile.
    // Picking it shows the tick box, unticked; the policy still asks until
    // it is ticked (live 2026-09-18: snapping back hid the tick box).
    expect(autonomyChange("all", false)).toEqual({
      autonomy: "all",
      autonomyAllAcknowledged: false,
    });
    expect(autonomyChange("all", true)).toEqual({
      autonomy: "all",
      autonomyAllAcknowledged: true,
    });
    // Leaving it drops the acknowledgement with it; unticking keeps it pending.
    expect(autonomyChange("flow", true)).toEqual({
      autonomy: "flow",
      autonomyAllAcknowledged: false,
    });
    expect(autonomyHint("all", false)).toMatch(/Tick the line below/);
    // And it says what it means before it is ticked.
    expect(AUTONOMY_ALL_ACKNOWLEDGEMENT).toMatch(
      /send, buy, delete and install without asking/,
    );
    expect(autonomyHint("all")).toMatch(/Nothing waits for you/);
    expect(autonomyHint("all")).toMatch(/still reported/);
    expect(autonomyHint("all")).toMatch(/Escape/);
  });
});

describe("how often it asks: the setting in Settings", () => {
  it("says plainly what each choice does, and what still waits", () => {
    expect(autonomyHint("ask")).toMatch(/every consequential step waits/i);
    const task = autonomyHint("task");
    expect(task).toMatch(/you asked for/i);
    expect(task).toMatch(/money, sending, deleting, installing/i);
    const flow = autonomyHint("flow");
    expect(flow).toMatch(/can be undone just happens/i);
    expect(flow).toMatch(/still wait for you/i);
    expect(defaultSettings.autonomy).toBe("task");
  });
});

describe("how often it asks: the words", () => {
  it("knows which labels can be undone", () => {
    for (const label of ["Save", "Like", "Archive", "Join", "Replace"])
      expect(reversibleLabel(label), label).toBe(true);
    // "Join call" carries "call": a label is only as undoable as its worst
    // word, and placing a call is not.
    expect(reversibleLabel("Join call")).toBe(false);
    for (const label of [
      "Send",
      "Delete",
      "Pay",
      "Install",
      "Share",
      "Sign out",
      // A mixed label is only as undoable as its worst word.
      "Save and send",
      "Archive and delete",
    ])
      expect(reversibleLabel(label), label).toBe(false);
  });

  it("matches a label to the user's own words, and nothing else", () => {
    expect(askedForLabel("Save", "save the draft")).toBe(true);
    expect(askedForLabel("Save…", "Save the file as a PDF")).toBe(true);
    expect(askedForLabel("Save", "open the draft")).toBe(false);
    expect(askedForLabel("Save", undefined)).toBe(false);
    // A word the user said about something else does not authorise a step
    // that cannot be undone.
    expect(askedForLabel("Send", "send the draft")).toBe(false);
    expect(askedForLabel("Delete", "delete the draft")).toBe(false);
  });
});
