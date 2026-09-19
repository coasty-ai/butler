import { describe, expect, it } from "vitest";
import { shouldAutoResume } from "../src/core/resume";
import {
  MANUAL_PAUSE_MESSAGE,
  TARGET_HANDOFF_MESSAGE,
} from "../src/core/runner";
import { targetHold } from "../src/core/background";

const manual = (idleMs: number, kinds: string[], extra = {}) =>
  shouldAutoResume({
    status: "paused",
    message: MANUAL_PAUSE_MESSAGE,
    listening: false,
    holdSequence: 9,
    lastSequence: 9,
    report: { idleMs, kinds },
    ...extra,
  });

describe("auto-resume after the user lets go", () => {
  it("continues a pointer-only hold after a second", () => {
    expect(manual(1000, ["mouse_move"])).toBe("manual_input");
    expect(manual(1000, ["mouse_move", "scroll"])).toBe("manual_input");
  });
  it("waits three seconds after clicks or typing", () => {
    expect(manual(1000, ["click", "mouse_move"])).toBeUndefined();
    expect(manual(1000, ["key"])).toBeUndefined();
    expect(manual(3000, ["click", "key", "mouse_move"])).toBe("manual_input");
  });
  it("never continues when anything else happened or the user is talking", () => {
    expect(manual(3000, ["mouse_move"], { lastSequence: 10 })).toBeUndefined();
    expect(
      manual(3000, ["mouse_move"], { holdSequence: undefined }),
    ).toBeUndefined();
    expect(manual(3000, ["mouse_move"], { listening: true })).toBeUndefined();
    expect(
      manual(3000, ["mouse_move"], {
        message: "Paused. Capture and input are stopped.",
      }),
    ).toBeUndefined();
    expect(
      manual(3000, ["mouse_move"], { status: "confirming" }),
    ).toBeUndefined();
  });
  it("continues a control hand-off only after the user clicked", () => {
    const handoff = (
      idleMs: number,
      kinds: string[],
      message = TARGET_HANDOFF_MESSAGE,
    ) =>
      shouldAutoResume({
        status: "takeover",
        message,
        listening: false,
        lastSequence: 3,
        report: { idleMs, kinds },
      });
    expect(handoff(1000, ["click"])).toBe("target_handoff");
    expect(handoff(3000, ["mouse_move"])).toBeUndefined();
    expect(
      handoff(1000, ["click"], "What would you like me to check for you?"),
    ).toBeUndefined();
  });
});

describe("a hold in a bound window (design §3)", () => {
  const hold = (
    idleMs: number,
    kinds: string[],
    target?: { frontmost: boolean; lastInside: boolean },
    extra = {},
  ) =>
    shouldAutoResume({
      status: "paused",
      message: targetHold("Slack"),
      listening: false,
      holdSequence: 9,
      lastSequence: 9,
      report: { idleMs, kinds, ...(target ? { target } : {}) },
      ...extra,
    });
  it("continues once the application is no longer in front and the last press, scroll or key was elsewhere", () => {
    expect(
      hold(3000, ["click", "key"], { frontmost: false, lastInside: false }),
    ).toBe("target_hold");
    // A pointer-only episode (a scroll elsewhere, then hovering) needs a second.
    expect(
      hold(1000, ["mouse_move", "scroll"], {
        frontmost: false,
        lastInside: false,
      }),
    ).toBe("target_hold");
  });
  it("stays held while the hands are still in the window behind: a scroll there with another application in front", () => {
    expect(
      hold(1000, ["scroll"], { frontmost: false, lastInside: true }),
    ).toBeUndefined();
    expect(
      hold(3000, ["click", "scroll"], { frontmost: false, lastInside: true }),
    ).toBeUndefined();
  });
  it("stays held while the application is in front, whatever the last input was", () => {
    // A click on its Dock icon or a Command-Tab into it: the last input was
    // outside the window, and the user is in the application now.
    expect(
      hold(3000, ["click"], { frontmost: true, lastInside: false }),
    ).toBeUndefined();
    expect(
      hold(1000, ["mouse_move"], { frontmost: true, lastInside: false }),
    ).toBeUndefined();
    expect(
      hold(3000, ["click"], { frontmost: true, lastInside: true }),
    ).toBeUndefined();
    expect(
      hold(30000, ["key"], { frontmost: true, lastInside: true }),
    ).toBeUndefined();
  });
  it("still needs the stillness, and a report without the facts keeps it held", () => {
    expect(
      hold(1000, ["click"], { frontmost: false, lastInside: false }),
    ).toBeUndefined();
    expect(hold(3000, ["click"])).toBeUndefined();
  });
  it("never continues when anything else happened, the user is talking, or the hold is another kind", () => {
    const away = { frontmost: false, lastInside: false };
    expect(hold(3000, ["click"], away, { lastSequence: 10 })).toBeUndefined();
    expect(
      hold(3000, ["click"], away, { holdSequence: undefined }),
    ).toBeUndefined();
    expect(hold(3000, ["click"], away, { listening: true })).toBeUndefined();
    expect(hold(3000, ["click"], away, { status: "takeover" })).toBeUndefined();
    expect(
      hold(3000, ["click"], away, {
        message:
          "Paused — you’re in Slack. I’ll continue when your hands are idle.",
      }),
    ).toBeUndefined();
    // The facts change nothing for a hold on the screen: it continues as before.
    expect(
      manual(3000, ["click"], {
        report: {
          idleMs: 3000,
          kinds: ["click"],
          target: { frontmost: true, lastInside: true },
        },
      }),
    ).toBe("manual_input");
  });
});
