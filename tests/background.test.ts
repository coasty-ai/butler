import { describe, expect, it } from "vitest";
import { actionSchema, type Action, type Geometry } from "../src/core/schema";
import {
  FOREGROUND_CAP,
  MAX_SPOKEN_TARGETS,
  MISS_LIMIT,
  aimAtDisplay,
  backgroundLadder,
  backgroundResult,
  backgroundRoute,
  coveredStaleRetry,
  foregroundCapReached,
  foregroundRequest,
  isForegroundRequest,
  isTargetHold,
  missKey,
  routeSkipped,
  spokenTargets,
  targetHold,
} from "../src/core/background";
import { cleanScreenContext } from "../src/core/context";
import { MANUAL_PAUSE_MESSAGE } from "../src/core/runner";

const act = (input: Record<string, unknown>): Action =>
  actionSchema.parse({ frame_id: "f", ...input });
const never = () => false;

describe("the windows the words name (design §2.2)", () => {
  it("reads 'in Slack' where the sentence pauses after it", () => {
    expect(
      spokenTargets("Tell Prateek I'm running ten minutes late in Slack"),
    ).toEqual([{ app: "Slack" }]);
    expect(spokenTargets("In Slack, tell Prateek I'm late")).toEqual([
      { app: "Slack" },
    ]);
    expect(spokenTargets("reply to Dana in slack and then close it")).toEqual([
      { app: "slack" },
    ]);
  });
  it("tries a multi-word name whole and by its first word", () => {
    expect(spokenTargets("open the budget in Google Chrome.")).toEqual([
      { app: "Google Chrome" },
      { app: "Google" },
    ]);
    expect(spokenTargets("reply to Dana in Slack about lunch")).toEqual([
      { app: "Slack about lunch" },
      { app: "Slack" },
    ]);
  });
  it("reads 'the Notes window called Groceries' with its title, once", () => {
    expect(
      spokenTargets("in the Notes window called Groceries, add milk"),
    ).toEqual([{ app: "Notes", title: "Groceries" }]);
    expect(spokenTargets("do it in the Slack app")).toEqual([{ app: "Slack" }]);
  });
  it("ignores phrases that are not places", () => {
    for (const task of [
      "remind me in ten minutes",
      "check in with Dana",
      "log in to slack",
      "do it in the morning",
      "sign in",
      "tell Prateek I'm in",
    ])
      expect(spokenTargets(task), task).toEqual([]);
  });
  it("caps the candidates", () => {
    expect(
      spokenTargets("in Notes, in Mail, in Safari, in Slack, in Music."),
    ).toHaveLength(MAX_SPOKEN_TARGETS);
  });
});

describe("the actuation ladder (design §2.5)", () => {
  it("presses by accessibility, then posts, then goes in front", () => {
    for (const type of ["click_control", "click", "right_click", "scroll"])
      expect(
        backgroundLadder(
          act(
            type === "click_control"
              ? { type, label: "Send" }
              : type === "scroll"
                ? { type, delta_x: 0, delta_y: 100 }
                : { type, x: 0.5, y: 0.5 },
          ),
          undefined,
          never,
        ),
      ).toEqual({ rungs: ["ax", "post"], foreground: true });
    expect(
      backgroundLadder(
        act({ type: "double_click", x: 0.5, y: 0.5 }),
        undefined,
        never,
      ),
    ).toEqual({ rungs: ["post"], foreground: true });
  });
  it("a menu item is a press and nothing else; a published shortcut is its item", () => {
    expect(
      backgroundLadder(
        act({ type: "menu_item", path: ["File", "Save"] }),
        undefined,
        never,
      ),
    ).toEqual({ rungs: ["ax"], foreground: false });
    const chord = act({ type: "hotkey", keys: ["CMD", "S"] });
    expect(backgroundLadder(chord, "Save", never)).toEqual({
      rungs: ["ax"],
      foreground: true,
    });
    expect(backgroundLadder(chord, undefined, never)).toEqual({
      rungs: ["ax", "post"],
      foreground: true,
    });
  });
  it("prunes what the run or memory saw ignored, keeping the way in front", () => {
    const typing = act({ type: "type_text", text: "hello" });
    expect(
      backgroundLadder(typing, undefined, (_rung, route) => route === "write"),
    ).toEqual({ rungs: ["post"], foreground: true });
    expect(
      backgroundLadder(typing, undefined, (rung) => rung === "post"),
    ).toEqual({ rungs: ["ax"], foreground: true });
    expect(backgroundLadder(typing, undefined, () => true)).toEqual({
      rungs: [],
      foreground: true,
    });
  });
  it("counts the run's misses by the kind of step and the rung, as the helper does", () => {
    expect(MISS_LIMIT).toBe(2);
    expect(missKey(act({ type: "click", x: 0.5, y: 0.5 }), "ax")).toBe(
      "click|ax",
    );
    expect(
      missKey(act({ type: "menu_item", path: ["File", "Save"] }), "ax"),
    ).toBe("menu_item|ax");
    // The same memory route, different keys: a click the application
    // ignores never disables its menu items.
    expect(backgroundRoute(act({ type: "click", x: 0.5, y: 0.5 }), "ax")).toBe(
      backgroundRoute(act({ type: "menu_item", path: ["File", "Save"] }), "ax"),
    );
  });
  it("names the memory route of each rung", () => {
    const typing = act({ type: "type_text", text: "hello" });
    expect(backgroundRoute(typing, "ax")).toBe("write");
    expect(backgroundRoute(typing, "post")).toBe("keys");
    expect(backgroundRoute(act({ type: "key", key: "ENTER" }), "post")).toBe(
      "keys",
    );
    const click = act({ type: "click", x: 0.5, y: 0.5 });
    expect(backgroundRoute(click, "ax")).toBe("press");
    expect(backgroundRoute(click, "post")).toBe("post");
  });
  it("delivers nothing for a wait, a capture, a drag or an open", () => {
    for (const input of [
      { type: "wait", milliseconds: 10 },
      { type: "capture" },
      {
        type: "drag",
        start_x: 0,
        start_y: 0,
        end_x: 1,
        end_y: 1,
        duration_ms: 200,
      },
      { type: "open_app", name: "Notes" },
      { type: "move", x: 0.5, y: 0.5 },
    ])
      expect(backgroundLadder(act(input), undefined, never)).toBeUndefined();
  });
});

describe("the second in front (design §2.8)", () => {
  const display: Geometry = {
    display_id: 1,
    x: 0,
    y: 0,
    width: 1440,
    height: 900,
    native_width: 2880,
    native_height: 1800,
    model_width: 1280,
    model_height: 800,
    scale_factor: 2,
  };
  const window = { id: 77, x: 144, y: 90, width: 720, height: 450 };
  it("re-aims a point from the window image to the display", () => {
    const click = act({ type: "click", x: 0.5, y: 0.5, frame_id: "w" });
    expect(aimAtDisplay(click, window, display)).toEqual({
      ...click,
      x: (144 + 360) / 1440,
      y: (90 + 225) / 900,
    });
    // The window's corners land on its frame; a point past the display clamps.
    expect(
      aimAtDisplay(act({ type: "click", x: 0, y: 0 }), window, display),
    ).toMatchObject({ x: 0.1, y: 0.1 });
    expect(
      aimAtDisplay(
        act({ type: "click", x: 1, y: 1 }),
        { ...window, x: 1200, y: 800 },
        display,
      ),
    ).toMatchObject({ x: 1, y: 1 });
    // A display that does not start at the origin.
    expect(
      aimAtDisplay(
        act({ type: "click", x: 0.5, y: 0.5 }),
        { ...window, x: 1440 + 144 },
        { ...display, x: 1440 },
      ),
    ).toMatchObject({ x: (144 + 360) / 1440, y: (90 + 225) / 900 });
  });
  it("maps every point a step carries and leaves the rest alone", () => {
    const drag = act({
      type: "drag",
      start_x: 0,
      start_y: 0,
      end_x: 1,
      end_y: 1,
      duration_ms: 200,
    });
    expect(aimAtDisplay(drag, window, display)).toMatchObject({
      start_x: 0.1,
      start_y: 0.1,
      end_x: (144 + 720) / 1440,
      end_y: (90 + 450) / 900,
    });
    const control = act({
      type: "click_control",
      label: "Send",
      x: 0.5,
      y: 0.5,
    });
    expect(aimAtDisplay(control, window, display)).toMatchObject({
      label: "Send",
      x: (144 + 360) / 1440,
    });
    const typing = act({ type: "type_text", text: "hello" });
    expect(aimAtDisplay(typing, window, display)).toEqual(typing);
    // No window frame to map through: the step passes unchanged.
    const click = act({ type: "click", x: 0.5, y: 0.5 });
    expect(aimAtDisplay(click, undefined, display)).toEqual(click);
  });
  it("tells the model to use a listed control before asking for a covered window", () => {
    expect(coveredStaleRetry("Slack")).toContain("No input was sent.");
    expect(coveredStaleRetry("Slack")).toContain("context.controls");
    expect(coveredStaleRetry("Slack")).toContain("instead of a point");
  });
});

describe("the bound window's context reaches the model (design §2.3)", () => {
  // The keys the helper's targetContext writes (Controller.swift); the
  // native test pins the same list against the source. Every one must pass
  // the runner's strict schema, or the whole context is dropped.
  const TARGET_CONTEXT_KEYS = [
    "appName",
    "windowTitle",
    "documentName",
    "visibleText",
    "selectedText",
    "windowCount",
    "openApps",
    "accessibility",
    "menus",
    "background",
    "controls",
    "screenText",
  ];
  it("accepts exactly the keys the helper writes for a bound window", () => {
    const context = {
      appName: "Slack",
      windowTitle: "Prateek (DM)",
      documentName: "notes.txt",
      visibleText: "Running late",
      selectedText: "late",
      windowCount: 2,
      openApps: ["Mail — Inbox"],
      accessibility: "full",
      menus: ["File: New Message"],
      background: {
        appName: "Slack",
        title: "Prateek (DM)",
        covered: true,
        staleRisk: true,
        minimized: false,
      },
      controls: [{ role: "button", label: "Send", x: 0.9, y: 0.9 }],
      screenText: "Message Prateek",
    };
    expect(Object.keys(context).sort()).toEqual(
      [...TARGET_CONTEXT_KEYS].sort(),
    );
    const clean = cleanScreenContext(context);
    expect(clean?.background).toEqual(context.background);
    expect(clean?.controls).toHaveLength(1);
    // The field an accessibility write goes to is the surface's
    // (focusedRole, focusedLabel), never a context key of its own.
    expect(
      cleanScreenContext({
        ...context,
        focusedField: { role: "textarea", label: "Message" },
      }),
    ).toBeUndefined();
  });
});

describe("the foreground cap (design §2.8)", () => {
  it("is three detours in any ten steps", () => {
    expect(FOREGROUND_CAP).toEqual({ handoffs: 3, steps: 10 });
    expect(foregroundCapReached([0, 1, 2], 2)).toBe(true);
    expect(foregroundCapReached([0, 1], 2)).toBe(false);
    // The first two fell out of the window of ten.
    expect(foregroundCapReached([0, 1, 12], 12)).toBe(false);
    expect(foregroundCapReached([3, 7, 12], 12)).toBe(true);
  });
});

describe("what the model is told (design §2.4)", () => {
  const send = act({ type: "click_control", label: "Send" });
  const what = " click on button “Send”";
  it("names the rung and what the postcondition read found", () => {
    expect(
      backgroundResult(send, what, { rung: "ax", effect: "changed" }, "Slack"),
    ).toBe(
      "Executed click on button “Send” by accessibility; the window changed. Verify the next screenshot.",
    );
    expect(
      backgroundResult(send, what, { rung: "post", effect: "none" }, "Slack"),
    ).toBe(
      "Executed click on button “Send” by events posted to Slack; nothing changed, so Slack may ignore this route; use a listed control, the menu or the keyboard instead. Verify the next screenshot.",
    );
    // A press that only moved focus (a field clicked by name) took.
    expect(
      backgroundResult(
        send,
        what,
        { rung: "ax", effect: "focused", via: "press" },
        "Slack",
      ),
    ).toBe(
      "Executed click on button “Send” by accessibility; it has focus now. Verify the next screenshot.",
    );
    expect(
      backgroundResult(
        act({ type: "type_text", text: "hello" }),
        " typing into “Message”",
        { rung: "ax", effect: "unverifiable" },
        "Slack",
      ),
    ).toBe(
      "Executed typing into “Message” by an accessibility write; whether it took could not be read. Verify the next screenshot shows the intended result before done.",
    );
    expect(
      backgroundResult(
        act({ type: "key", key: "ENTER" }),
        "",
        { rung: "post", effect: "changed" },
        "Notes",
      ),
    ).toBe(
      "Executed by keys posted to Notes; the window changed. Verify the next screenshot shows the intended result before done.",
    );
  });
  it("reports a step taken in front as before, with no read to claim", () => {
    expect(
      backgroundResult(
        send,
        what,
        { rung: "foreground", effect: "unverifiable" },
        "Slack",
      ),
    ).toBe(
      "Executed click on button “Send” with Slack in front for a second. Verify the next screenshot.",
    );
  });
});

describe("what the pill and the voice say", () => {
  it("recognises the foreground request the pill shows as its label", () => {
    expect(isForegroundRequest(foregroundRequest("Slack"))).toBe(true);
    expect(isForegroundRequest("Working in Slack in the background")).toBe(
      false,
    );
    expect(isForegroundRequest(targetHold("Slack"))).toBe(false);
  });
  it("says what a hold in the window does: continues when the user switches away, and is recognised as that hold", () => {
    expect(targetHold("Slack")).toBe(
      "Paused — you’re in Slack. I’ll continue when you switch away.",
    );
    expect(isTargetHold(targetHold("Slack"))).toBe(true);
    expect(isTargetHold(targetHold("Visual Studio Code"))).toBe(true);
    expect(isTargetHold(MANUAL_PAUSE_MESSAGE)).toBe(false);
    expect(
      isTargetHold(
        "Paused — you’re in Slack. I’ll continue when your hands are idle.",
      ),
    ).toBe(false);
    expect(isTargetHold(foregroundRequest("Slack"))).toBe(false);
  });
  it("names a pruned route once in plain words", () => {
    expect(routeSkipped("Slack", "write")).toBe(
      "Slack ignores typing in the background; I’ll ask for the window when I need to type.",
    );
    expect(routeSkipped("Slack", "keys")).toContain("ignores typing");
    expect(routeSkipped("Notes", "press")).toContain("accessibility presses");
    expect(routeSkipped("Notes", "post")).toContain("posted clicks");
  });
});
