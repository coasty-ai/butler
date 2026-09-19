import { isTargetHold } from "./background";
import { MANUAL_PAUSE_MESSAGE, TARGET_HANDOFF_MESSAGE } from "./runner";

/** What the native helper reports once manual input has gone quiet. */
export interface InputIdleReport {
  idleMs: number;
  kinds: string[];
  /**
   * With a window bound (design §3): whether its application is frontmost
   * now, and whether the user's hands are in the window: their last press,
   * drag or wheel landed on it, or their last input was a key and the
   * application still has the keyboard (a hover moves neither). Two flags, no
   * coordinates; absent from a helper that knows no targets.
   */
  target?: { frontmost: boolean; lastInside: boolean };
}

/**
 * Whether a held run may continue on its own after the user let go of the
 * mouse or keyboard. A manual hold continues after about a second of stillness
 * when the user only moved the pointer or scrolled, and after three seconds
 * when they clicked or typed. A hold in a bound window needs the same
 * stillness and the hands gone from the window: its application no longer in
 * front and the last press, scroll or key somewhere else. Either alone is not
 * leaving: a scroll in the window while another application is in front keeps
 * the hands in it, and a click that brought the application forward keeps the
 * user in it. A report that cannot say keeps it held. A "can't find the
 * control" hand-off continues a second after the user clicked. Nothing else
 * may have happened since the hold (voice, approvals, a new pause), and the
 * app must not be listening.
 */
export function shouldAutoResume(state: {
  status: string | undefined;
  message: string | undefined;
  listening: boolean;
  holdSequence?: number;
  lastSequence: number;
  report: InputIdleReport;
}): "manual_input" | "target_hold" | "target_handoff" | undefined {
  const { status, message, report } = state;
  if (state.listening || !status) return undefined;
  const pointerOnly = report.kinds.every(
    (kind) => kind === "mouse_move" || kind === "scroll",
  );
  const stillHeld =
    status === "paused" &&
    state.holdSequence !== undefined &&
    state.holdSequence === state.lastSequence &&
    report.idleMs >= (pointerOnly ? 1000 : 3000);
  if (stillHeld && message === MANUAL_PAUSE_MESSAGE) return "manual_input";
  if (
    stillHeld &&
    message !== undefined &&
    isTargetHold(message) &&
    report.target &&
    !report.target.frontmost &&
    !report.target.lastInside
  )
    return "target_hold";
  if (
    status === "takeover" &&
    message === TARGET_HANDOFF_MESSAGE &&
    report.kinds.includes("click") &&
    report.idleMs >= 1000
  )
    return "target_handoff";
  return undefined;
}
