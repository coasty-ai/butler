import type { Action } from "../core/schema";

export function voiceCommandConfidence(event: {
  event: string;
  confidence?: number;
}): number {
  const value = event.confidence;
  // Recovered hypotheses may start/steer a task, but can never authorize an
  // approval. Do not trust even a high confidence attached to that event.
  return event.event === "transcript_final" &&
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
    ? value
    : 0;
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
export type FollowUpKind = "answer" | "approval" | "continuation";
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
