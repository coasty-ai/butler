import { MANUAL_PAUSE_MESSAGE, TARGET_HANDOFF_MESSAGE } from "./runner";

/** What the native helper reports once manual input has gone quiet. */
export interface InputIdleReport {
  idleMs: number;
  kinds: string[];
}

/**
 * Whether a held run may continue on its own after the user let go of the
 * mouse or keyboard. A manual hold continues after about a second of stillness
 * when the user only moved the pointer or scrolled, and after three seconds
 * when they clicked or typed. A "can't find the control" hand-off continues a
 * second after the user clicked. Nothing else may have happened since the hold
 * (voice, approvals, a new pause), and the app must not be listening.
 */
export function shouldAutoResume(state: {
  status: string | undefined;
  message: string | undefined;
  listening: boolean;
  holdSequence?: number;
  lastSequence: number;
  report: InputIdleReport;
}): "manual_input" | "target_handoff" | undefined {
  const { status, message, report } = state;
  if (state.listening || !status) return undefined;
  const pointerOnly = report.kinds.every(
    (kind) => kind === "mouse_move" || kind === "scroll",
  );
  if (
    status === "paused" &&
    message === MANUAL_PAUSE_MESSAGE &&
    state.holdSequence !== undefined &&
    state.holdSequence === state.lastSequence &&
    report.idleMs >= (pointerOnly ? 1000 : 3000)
  )
    return "manual_input";
  if (
    status === "takeover" &&
    message === TARGET_HANDOFF_MESSAGE &&
    report.kinds.includes("click") &&
    report.idleMs >= 1000
  )
    return "target_handoff";
  return undefined;
}
