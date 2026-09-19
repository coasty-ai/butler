import { LATENCY, type TurnGrade } from "./grade";

/**
 * Failure classes for a spoken turn, in the order they are decided: the
 * first matching row names the turn. A turn carries at most one hard class
 * and may add one soft latency class; soft classes never fail it. Each
 * class has a fine owner (who fixes it), a loop owner (how selectLanes
 * files it), a cost (how far it pushes the owner back to the keyboard),
 * the evidence the brief attaches, and an authored mechanism note that
 * names the files, since laneBrief prints the note verbatim.
 */

export const FAILURE_CODES = [
  "ENV_NOT_READY",
  "TAKEOVER",
  "UNHEARD_NOISY",
  "UNHEARD",
  "MISHEARD",
  "WRONG_PLAN",
  "NEEDS_CLICK",
  "RUN_FAILED",
  "RUN_INCOMPLETE",
  "WRONG_STATE",
  "SLOW_FIRST_ACTION",
  "SLOW_REPLY",
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];
export const SOFT_CODES: readonly FailureCode[] = [
  "SLOW_FIRST_ACTION",
  "SLOW_REPLY",
];
/** Reported apart: the room's and the harness's, not the app's. */
export const ENVIRONMENT_CODES: readonly FailureCode[] = [
  "ENV_NOT_READY",
  "TAKEOVER",
];
export const isSoft = (code: string): boolean =>
  (SOFT_CODES as readonly string[]).includes(code);

export type FineOwner =
  | "recognizer/gate"
  | "dialog core"
  | "runner/policy"
  | "native"
  | "harness"
  | "user";

export const OWNER: Record<FailureCode, FineOwner> = {
  ENV_NOT_READY: "harness",
  TAKEOVER: "user",
  UNHEARD_NOISY: "recognizer/gate",
  UNHEARD: "recognizer/gate",
  MISHEARD: "recognizer/gate",
  WRONG_PLAN: "dialog core",
  NEEDS_CLICK: "runner/policy",
  RUN_FAILED: "runner/policy",
  RUN_INCOMPLETE: "runner/policy",
  WRONG_STATE: "runner/policy",
  SLOW_FIRST_ACTION: "runner/policy",
  SLOW_REPLY: "dialog core",
};

/** The owner selectLanes reads: every app class is the agent's; TAKEOVER is nobody's lane. */
export const LOOP_OWNER: Record<
  FailureCode,
  "agent" | "harness" | "grader" | "user"
> = {
  ENV_NOT_READY: "harness",
  TAKEOVER: "user",
  UNHEARD_NOISY: "agent",
  UNHEARD: "agent",
  MISHEARD: "agent",
  WRONG_PLAN: "agent",
  NEEDS_CLICK: "agent",
  RUN_FAILED: "agent",
  RUN_INCOMPLETE: "agent",
  WRONG_STATE: "agent",
  SLOW_FIRST_ACTION: "agent",
  SLOW_REPLY: "agent",
};

/** ENV_NOT_READY subcodes the grader, not the harness, owes a fix for. */
const GRADER_SUBCODES = new Set(["STATE_UNREADABLE"]);
export function loopOwnerOf(
  code: FailureCode,
  subcode?: string | null,
): string {
  if (code === "ENV_NOT_READY" && subcode && GRADER_SUBCODES.has(subcode))
    return "grader";
  return LOOP_OWNER[code];
}

/** How far each failure pushes the owner back to the keyboard. */
export const COST_WEIGHT: Record<FailureCode, number> = {
  NEEDS_CLICK: 10,
  WRONG_STATE: 8,
  RUN_FAILED: 6,
  RUN_INCOMPLETE: 6,
  WRONG_PLAN: 5,
  MISHEARD: 4,
  UNHEARD: 3,
  UNHEARD_NOISY: 2,
  SLOW_FIRST_ACTION: 2,
  SLOW_REPLY: 1,
  TAKEOVER: 0,
  ENV_NOT_READY: 0,
};

/** The files each fine owner's fix would touch; the brief names them. */
export const FILES: Record<FineOwner, string[]> = {
  "recognizer/gate": [
    "native/macos/Voice.swift",
    "native/macos/WakePolicy.swift",
    "native/macos/TurnPolicy.swift",
    "src/voice/phrases.ts",
  ],
  "dialog core": [
    "src/voice/turns.ts",
    "electron/assistant.ts",
    "src/assistant/prompt.ts",
    "src/assistant/arbitrate.ts",
  ],
  "runner/policy": [
    "src/core/runner.ts",
    "src/core/policy.ts",
    "electron/controller.ts",
  ],
  native: ["native/macos/Controller.swift", "electron/controller.ts"],
  harness: ["scripts/voice-loop.mjs", "src/gym/voice/grade.ts"],
  user: [],
};

/** The evidence each class attaches to its brief, as field names. */
export const EVIDENCE: Record<FailureCode, string[]> = {
  ENV_NOT_READY: ["subcode", "preflight facts", "osascript exit code"],
  TAKEOVER: [
    "HID idle timeline",
    "UserTakeoverStarted.source",
    "run id left paused",
  ],
  UNHEARD_NOISY: [
    "standby_trace levels +-15 s (rms, buffers, engine)",
    "sayMs",
    "last wake_status",
    "standby_trace textLength>0 seen",
    "noise paragraph key",
  ],
  UNHEARD: [
    "standby_trace levels +-15 s (rms, buffers, engine)",
    "sayMs",
    "last wake_status",
    "standby_trace textLength>0 seen",
    "previous turn speech_finished / followup_closed offsets",
  ],
  MISHEARD: [
    "confidence",
    "segments",
    "recovered",
    "transcriptLength vs say length",
    "heard regex",
    "EarlyStartEnded.code",
    "turns.jsonl line (local)",
  ],
  WRONG_PLAN: [
    "TurnPlanned.plan/source/window",
    "DialogTurn.decided{code, act, plan, actMs, jevUsed, jevAct, jevP, jevMs}",
    "Command.intent/activeRun",
    "run non-terminal at prompt time",
    "taskLength",
  ],
  NEEDS_CLICK: [
    "confirmation reason code",
    "needClick.reason",
    "takeover source",
    "RunState.appId",
    "actions before it",
  ],
  RUN_FAILED: [
    "ActionFailed{code,change} histogram",
    "RunState.error code",
    "endingCode",
    "NoProgressDetected count",
  ],
  RUN_INCOMPLETE: [
    "last RunState.status",
    "actions",
    "elapsed",
    "ActionLoopDetected",
    "capture total p50",
  ],
  WRONG_STATE: [
    "false check names",
    "RunState.appId",
    "mutations",
    "launchedAppIds",
    "endMessage flags",
  ],
  SLOW_FIRST_ACTION: [
    "FrameCaptured.timings (shot/ocr/context/total)",
    "decided.actMs",
    "jev.ms",
    "EarlyStart offsets",
  ],
  SLOW_REPLY: [
    "SpeechOut.latencyMs/engine/fallback",
    "decided.actMs",
    "KokoroVoice warm state",
    "endpointMs",
  ],
};

/** One line per class: the mechanism, prefixed with the fine owner and its files. */
export const NOTE: Record<FailureCode, string> = {
  ENV_NOT_READY:
    "The harness or the room was not ready for this turn; the subcode says what.",
  TAKEOVER:
    "A person touched the Mac during the turn; the cycle stopped and said nothing.",
  UNHEARD_NOISY:
    "The wake phrase was spoken into a listening helper over background speech and never detected; standby levels attached.",
  UNHEARD:
    "The wake phrase was spoken into a listening helper and never detected; standby levels attached.",
  MISHEARD:
    "The wake phrase was detected but the transcript lacks the prompt's key words; confidence and segments attached.",
  WRONG_PLAN:
    "The words were heard but the dialog chose the wrong kind of thing: a run for a question, an answer for a command, a refused resume, or the wrong task words.",
  NEEDS_CLICK:
    "The run stopped for a confirmation or a hand-off; a click is what the hands-free goal forbids. A refusal may not be removed: the route must avoid the control or the owner accepts it.",
  RUN_FAILED:
    "The run ended failed or was cancelled by the app itself; the ActionFailed codes say where.",
  RUN_INCOMPLETE:
    "The run was still going at the task's timeout and the loop had to stop it.",
  WRONG_STATE:
    "The run said done but the Mac disagrees: a state check the task defines is false (a false done when primary).",
  SLOW_FIRST_ACTION:
    "Heard and done, but the first action came more than the budget after the transcript; capture timings attached.",
  SLOW_REPLY:
    "Heard and done, but the spoken reply came more than the budget after the transcript; speech engine latency attached.",
};

/** `[owner: files] note`, the line laneBrief prints. */
export function noteFor(code: FailureCode): string {
  const owner = OWNER[code];
  const files = FILES[owner];
  return `[${owner}${files.length ? `: ${files.join(", ")}` : ""}] ${NOTE[code]}`;
}

export interface Classification {
  code?: FailureCode;
  softCode?: FailureCode;
  subcode?: string;
  pass: boolean;
}

/**
 * The class of a graded turn, first match wins (design table 3.3). Soft
 * latency classes are added only when the turn otherwise passed.
 */
export function classify(g: TurnGrade): Classification {
  const hard = hardClass(g);
  if (hard) return { ...hard, pass: false };
  const soft = softClass(g);
  return { softCode: soft?.code, subcode: soft?.subcode, pass: true };
}

function hardClass(
  g: TurnGrade,
): { code: FailureCode; subcode?: string } | undefined {
  if (g.envSubcode) return { code: "ENV_NOT_READY", subcode: g.envSubcode };
  if (g.takeover) return { code: "TAKEOVER" };
  // The false-wake test passes by hearing nothing; a wake there is the failure.
  if (g.expectOutcome === "silence")
    return g.planMatched
      ? undefined
      : { code: "WRONG_PLAN", subcode: "FALSE_WAKE" };
  if (g.heard === "unheard")
    return { code: g.noisy ? "UNHEARD_NOISY" : "UNHEARD" };
  if (g.heard === "misheard") return { code: "MISHEARD" };
  if (!g.planMatched) return { code: "WRONG_PLAN", subcode: g.planReasons[0] };
  if (g.taskWordsOk === false)
    return { code: "WRONG_PLAN", subcode: "TASK_WORDS" };
  if (
    g.noConfirmationRequired &&
    (g.confirmations > 0 || g.needClick || g.handoffSources.length)
  )
    return {
      code: "NEEDS_CLICK",
      subcode:
        g.confirmations > 0
          ? "CONFIRMATION"
          : g.needClick
            ? "NEED_CLICK"
            : g.handoffSources[0],
    };
  const cancelled = g.terminal === "cancelled" || g.terminal === "stopped";
  if (
    g.terminal === "failed" ||
    (cancelled && !g.stoppedByLoop && g.expectOutcome !== "stop")
  )
    return { code: "RUN_FAILED", subcode: g.failures[0] };
  if (g.timedOut || (g.runStarted && g.terminal === null))
    return { code: "RUN_INCOMPLETE" };
  if (g.runCompletedRequired && g.terminal !== "completed")
    return { code: "RUN_INCOMPLETE", subcode: g.terminal ?? "NO_TERMINAL" };
  // A state the grader could not read is its debt, never a pass and never
  // the app's fault; it is judged where the state would have been.
  if (g.unreadable.length)
    return { code: "ENV_NOT_READY", subcode: "STATE_UNREADABLE" };
  if (g.checksFailed.length)
    return {
      code: "WRONG_STATE",
      subcode: g.primaryFailed.length ? "FALSE_DONE" : g.checksFailed[0],
    };
  return undefined;
}

function softClass(
  g: TurnGrade,
): { code: FailureCode; subcode?: string } | undefined {
  if (
    g.runStarted &&
    g.firstActionAfterTranscriptMs !== null &&
    g.firstActionAfterTranscriptMs > g.firstActionLimitMs
  )
    return { code: "SLOW_FIRST_ACTION" };
  if (
    g.spoken &&
    g.replyAfterTranscriptMs !== null &&
    g.replyAfterTranscriptMs > g.replyLimitMs
  )
    return { code: "SLOW_REPLY", subcode: g.replyIsAck ? "ACK" : "ANSWER" };
  return undefined;
}

/** The classes a user feels as a breach of trust: fixed only at 5%. */
export const STRICT_VOICE_CLASSES: readonly FailureCode[] = [
  "NEEDS_CLICK",
  "WRONG_STATE",
];
export const strictVoiceClass = (code: string): boolean =>
  (STRICT_VOICE_CLASSES as readonly string[]).includes(code);
export const voiceFixedThreshold = (code: string): number =>
  strictVoiceClass(code) ? 0.05 : 0.1;

export interface RankedClass {
  code: FailureCode;
  count: number;
  weight: number;
  score: number;
  soft: boolean;
  rank: number;
}

/**
 * Classes by count x cost, most costly first; a tie keeps the design's
 * order. Environment classes are ranked too (the report lists them apart)
 * but never score.
 */
export function rankClasses(
  rows: { code?: string | null; softCode?: string | null }[],
): RankedClass[] {
  const counts = new Map<FailureCode, number>();
  for (const row of rows)
    for (const code of [row.code, row.softCode])
      if (code && (FAILURE_CODES as readonly string[]).includes(code))
        counts.set(
          code as FailureCode,
          (counts.get(code as FailureCode) ?? 0) + 1,
        );
  return [...counts.entries()]
    .map(([code, count]) => ({
      code,
      count,
      weight: COST_WEIGHT[code],
      score: count * COST_WEIGHT[code],
      soft: isSoft(code),
      rank: 0,
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        FAILURE_CODES.indexOf(a.code) - FAILURE_CODES.indexOf(b.code),
    )
    .map((c, i) => ({ ...c, rank: i + 1 }));
}

/** The latency budgets the report prints beside the numbers. */
export const BUDGETS = LATENCY;
