import { describe, expect, it } from "vitest";
import { shouldAutoResume } from "../src/core/resume";
import {
  MANUAL_PAUSE_MESSAGE,
  TARGET_HANDOFF_MESSAGE,
} from "../src/core/runner";

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
