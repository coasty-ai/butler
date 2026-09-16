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
    case "drag":
      return "Drag the selected item to a new position.";
    default:
      return action.type.replaceAll("_", " ");
  }
}

export type VoiceIntent = {
  kind: "stop" | "pause" | "resume" | "approve" | "decline" | "command";
  text: string;
};
export function voiceIntent(text: string): VoiceIntent {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[.!?,]+$/g, "")
    .trim();
  if (["stop", "stop now", "cancel", "cancel task"].includes(normalized))
    return { kind: "stop", text };
  if (["wait", "pause", "hold on"].includes(normalized))
    return { kind: "pause", text };
  if (["resume", "continue", "keep going"].includes(normalized))
    return { kind: "resume", text };
  if (
    ["yes", "yes please", "approve", "send it", "go ahead"].includes(normalized)
  )
    return { kind: "approve", text };
  if (
    [
      "no",
      "no thanks",
      "deny",
      "don’t",
      "do not",
      "don’t send",
      "do not send",
    ].includes(normalized)
  )
    return { kind: "decline", text };
  return { kind: "command", text: text.trim() };
}
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
}
export const idlePill: PillState = {
  phase: "idle",
  label: "Hold ⌥ Space",
  transcript: "",
  canApprove: false,
  synthetic: false,
  inputLevel: 0,
};
