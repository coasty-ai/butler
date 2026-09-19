import type { Action } from "../core/schema";

/**
 * A hypothesis the recognizer left standing this long before the endpoint,
 * then failed to finalize (Apple's empty final: 17 of 24 turns on
 * 2026-09-18), is what the user said as surely as any final. It counts as
 * clearly heard for starting a task; VoiceTurnInput.recovered still keeps
 * it from ever approving one.
 */
export const STABLE_HYPOTHESIS_MS = 1500;
export const STABLE_HYPOTHESIS_CONFIDENCE = 0.7;

export function voiceCommandConfidence(event: {
  event: string;
  confidence?: number;
  source?: string;
  stableMs?: number;
}): number {
  const value = event.confidence;
  if (
    event.event === "transcript_final" &&
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  )
    return value;
  // A recovered hypothesis starts or steers a task when it stood still long
  // enough; it never authorizes an approval, whatever confidence it carries.
  if (
    event.event === "transcript_recovered" &&
    event.source === "empty_final_after_endpoint" &&
    typeof event.stableMs === "number" &&
    event.stableMs >= STABLE_HYPOTHESIS_MS
  )
    return STABLE_HYPOTHESIS_CONFIDENCE;
  return 0;
}

export function describeAction(action: Action): string {
  switch (action.type) {
    case "type_text":
      return `Type: ${action.text}`;
    case "key":
      return `Press ${action.key}.`;
    case "hotkey":
      return `Press ${action.keys.join(" + ")}.`;
    case "click":
    case "double_click":
    case "right_click":
      return `${action.type.replaceAll("_", " ")} at ${Math.round(action.x * 100)}% across, ${Math.round(action.y * 100)}% down the selected screen.`;
    case "open_app":
      return `Open ${action.name}.`;
    case "open_file": {
      // Basename only: spoken and shown approvals never reveal folder layout.
      const name = action.path.replace(/\/+$/, "").split("/").pop();
      return `Open ${name && name !== "~" ? name : "your home folder"}.`;
    }
    case "drag":
      return "Drag the selected item to a new position.";
    case "menu_item":
      return `Choose ${action.path.join(" › ")}.`;
    default:
      return action.type.replaceAll("_", " ");
  }
}

// Intent rules live in turns.ts (shared with the turn planner); re-exported
// here for existing callers.
export {
  intentKey,
  voiceIntent,
  type VoiceIntent,
  type VoiceIntentKind,
} from "./turns";
/** A short listening window after a reply or turn, without the wake phrase. */
/** "scroll": open for the whole of a spoken scroll, for its steering words. */
export type FollowUpKind = "answer" | "approval" | "continuation" | "scroll";
export type PillPhase =
  | "idle"
  | "text"
  | "listening"
  | "working"
  | "approval"
  | "paused"
  | "done"
  | "error";
export interface PillState {
  phase: PillPhase;
  label: string;
  transcript: string;
  detail?: string;
  canApprove: boolean;
  synthetic: boolean;
  inputLevel: number;
  /** The assistant is speaking (voice bars; label is the spoken text). */
  speaking: boolean;
  /** A follow-up window is open (soft glow). */
  followUp?: FollowUpKind;
  /** The hands-free endpoint is about to close the turn (shrinking ring). */
  closing: boolean;
}
export const idlePill: PillState = {
  phase: "idle",
  label: "Hold ⌥ Space",
  transcript: "",
  canApprove: false,
  synthetic: false,
  inputLevel: 0,
  speaking: false,
  followUp: undefined,
  closing: false,
};
