/**
 * Thinking ahead while the user is still talking (design
 * .data/design/endpoint-decider.md §3.3: speculate on computation, never on
 * the turn). A hands-free turn ends about 2 s after the last word changed,
 * and the run that follows spends 0.4–0.9 s on its first capture and 1.4–3 s
 * on its first model step. When a hypothesis has stood unchanged for
 * SPECULATE_LIMITS.stableMs and would start a run on the user's own words
 * without asking the dialog model (a fast start), that computation can begin
 * on the hypothesis and be kept when the final says the same words. This is
 * the pure part, beside the router's fastStart: which hypothesis qualifies
 * and whether two texts say the same thing. electron/main.ts arms the timer
 * and src/core/runner.ts prepares the step; neither executes, speaks or shows anything before the
 * final.
 *
 * The owner's final differed from the 0.8 s hypothesis in 46.6 % of turns, so
 * the turn itself never ends early here; in the other 53 % the words are
 * known about 1.2 s before the endpoint, which is what this saves.
 */
import { scanText } from "../core/sanitize";
import { fastStart } from "./arbitrate";
import {
  WAKE_CALL,
  clarifyFragment,
  intentKey,
  isStatusQuestion,
  isWakePhraseOnly,
  restartedTurn,
  utteranceCompleteness,
  voiceIntent,
  type TurnPlan,
} from "../voice/turns";

export const SPECULATE_LIMITS = {
  /** A hypothesis unchanged this long is prepared for (the design's 0.8 s cut). */
  stableMs: 800,
  /** A prepared frame older than this at the final is dropped (native refuses at 30 s). */
  frameMaxAgeMs: 20_000,
} as const;

/**
 * Why a hypothesis was not prepared for, or a prepared step was let go.
 * Fixed codes for the content-free trace.
 */
export type SpeculationCode =
  | "empty"
  | "wake_only"
  | "secret"
  | "control"
  | "not_command"
  | "status_question"
  | "fragment"
  | "incomplete"
  | "plan_not_start"
  | "proposal"
  | "needs_model"
  | "tool_answer"
  | "coding"
  | "ptt"
  | "window"
  | "early_step"
  /** A fast action already changed the screen for this activation (electron/streaming.ts). */
  | "streamed"
  | "blocked"
  | "disabled"
  | "once"
  | "text_changed"
  | "reactivated"
  | "cancelled"
  | "no_final"
  | "native_error"
  | "surface"
  | "stale"
  | "screen_changed"
  | "not_started"
  | "superseded"
  | "discarded";

/** The wake phrase at the start, with or without "hey", as native strips it. */
const LEADING_WAKE = new RegExp(
  String.raw`^\s*${WAKE_CALL}(?![a-z])[\s,.:;!?—-]*`,
  "iu",
);

/**
 * The words of a hypothesis or a final as they compare: only the request
 * after the last wake phrase, with case, punctuation, fillers, stutters and
 * the leading "okay" or trailing "please" removed (intentKey). Two texts with
 * the same key ask for the same thing; a different key is a change of words.
 */
export function hypothesisKey(text: string): string {
  return intentKey(restartedTurn(text.trim()).text.replace(LEADING_WAKE, ""));
}

/** Whether the final says what the hypothesis said. */
export function sameWords(a: string, b: string): boolean {
  const key = hypothesisKey(a);
  return key.length > 0 && key === hypothesisKey(b);
}

/**
 * Whether these heard words are worth preparing for, before the router's
 * plan is known: a finished-sounding command that is not a control word, a
 * fragment, a status question or the wake phrase alone, and carries no
 * credential (a partial never leaves the machine with one). The dialog
 * preempt (electron/assistant.ts) applies the same tests to its partials.
 */
export function speculationCandidate(
  text: string,
): { key: string } | { code: SpeculationCode } {
  const words = text.trim();
  if (!words) return { code: "empty" };
  if (isWakePhraseOnly(words)) return { code: "wake_only" };
  if (scanText(words).some((f) => f.action === "BLOCK_UPLOAD"))
    return { code: "secret" };
  const intent = voiceIntent(words).kind;
  if (intent === "stop" || intent === "pause") return { code: "control" };
  if (intent !== "command") return { code: "not_command" };
  if (isStatusQuestion(words)) return { code: "status_question" };
  if (clarifyFragment(words) !== undefined) return { code: "fragment" };
  if (utteranceCompleteness(words, "command") !== "complete")
    return { code: "incomplete" };
  const key = hypothesisKey(words);
  if (!key) return { code: "empty" };
  return { key };
}

/**
 * Whether the router's plan for the hypothesis is a run the final would
 * start on these very words with no model in between: a start (never an
 * accepted offer, whose words are the assistant's) that fastStart lets run
 * unaided. Anything the dialog model decides is left to its own preempt.
 */
export function speculationPlan(
  plan: TurnPlan,
  text: string,
): { task: string } | { code: SpeculationCode } {
  if (plan.kind !== "start") return { code: "plan_not_start" };
  if (plan.taskSource === "proposal") return { code: "proposal" };
  if (!fastStart(plan, text)) return { code: "needs_model" };
  return { task: plan.text };
}
