import { describe, expect, it } from "vitest";
import { actionSchema, type Action } from "../src/core/schema";
import {
  BACKGROUND_NOTE,
  FOREGROUND_CAP,
  MAX_SPOKEN_TARGETS,
  backgroundLadder,
  backgroundResult,
  backgroundRoute,
  foregroundCapReached,
  foregroundRequest,
  isForegroundRequest,
  routeSkipped,
  spokenTargets,
  targetHold,
} from "../src/core/background";

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
      backgroundLadder(typing, undefined, (route) => route === "write"),
    ).toEqual({ rungs: ["post"], foreground: true });
    expect(backgroundLadder(typing, undefined, () => true)).toEqual({
      rungs: [],
      foreground: true,
    });
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
  it("keeps the note within the context bound and says what matters", () => {
    expect(BACKGROUND_NOTE.length).toBeLessThanOrEqual(800);
    for (const phrase of [
      "click_control",
      "menu_item",
      "type_text",
      "open_app",
      "CMD+TAB",
      "context.background.covered",
      "context.controls",
    ])
      expect(BACKGROUND_NOTE).toContain(phrase);
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
  it("names a pruned route once in plain words", () => {
    expect(routeSkipped("Slack", "write")).toBe(
      "Slack ignores typing in the background; I’ll ask for the window when I need to type.",
    );
    expect(routeSkipped("Slack", "keys")).toContain("ignores typing");
    expect(routeSkipped("Notes", "press")).toContain("accessibility presses");
    expect(routeSkipped("Notes", "post")).toContain("posted clicks");
  });
});
