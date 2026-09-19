import { idleRequired } from "../bench/presence";
import {
  fillPlaceholders,
  turnsOf,
  type Expect,
  type Fill,
  type Outcome,
  type StateCheck,
  type Turn,
  type VoiceTask,
} from "./suite";

/**
 * Grading a spoken turn from the app's own diagnostics. `summarizeTurn` is
 * the trial prototype's summary, typed: one pass over the event slice the
 * script collected after it spoke, reading offsets from the moment `say`
 * started. `gradeTurn` then applies the task's expectation to the summaries
 * of its utterances and to the state the script read back with osascript.
 * Pure over event arrays and evidence records, so every rule is tested from
 * synthetic slices; the transcript, task text and messages it reads under
 * verbose diagnostics stay inside the summary and never reach a result row.
 */

export interface DiagnosticEvent {
  timestamp: string;
  event: string;
  data?: Record<string, unknown>;
}

/** Chatter the loop never waits for or counts. */
export const SKIP = new Set([
  "Heartbeat",
  "NativeInputIdle",
  "NativeRequest",
  "NativeResponse",
  "VoiceRequest",
  "VoiceResponse",
  "FrameSaved",
  "ProviderAttempt",
  "ProviderHeaders",
  "ModelRequestStarted",
  "ModelResponseReceived",
  "KokoroVoice",
  "Pill",
]);
/** Voice phases that are noise for the settle rule: the standby trace and levels. */
export const SKIP_PHASES = new Set([
  "standby_trace",
  "audio_level",
  "recognition_update",
  "transcript_partial",
]);
export const TERMINAL = new Set([
  "completed",
  "failed",
  "cancelled",
  "stopped",
]);
/** The same set as graders.ts MUTATING: steps that can change anything. */
export const MUTATING = new Set([
  "type_text",
  "menu_item",
  "drag",
  "click",
  "double_click",
  "right_click",
  "click_control",
  "key",
  "hotkey",
  "open_file",
]);
/** Takeover sources that mean the app wanted a hand, not that a person took over. */
export const HANDOFF_SOURCES = new Set([
  "request_user",
  "handoff",
  "policy",
  "surface",
]);

/** Whether an event counts for "something happened" (not chatter). */
export function isChatter(event: DiagnosticEvent): boolean {
  if (SKIP.has(event.event)) return true;
  const phase = event.data?.phase;
  return (
    event.event === "VoiceEvent" &&
    typeof phase === "string" &&
    SKIP_PHASES.has(phase)
  );
}

export interface TurnSummary {
  spokenAt: number;
  /** How long the `say` process ran. */
  sayMs: number;
  wakeMs: number | null;
  /** Verbose only: Command.text. Never copied to a result. */
  transcript: string | null;
  transcriptMs: number | null;
  transcriptLength: number | null;
  confidence: number | null;
  segments: number | null;
  recovered: boolean;
  /** transcript - say end: how long the endpointer waited after the voice stopped. */
  endpointMs: number | null;
  plan: string | null;
  planSource: string | null;
  decided: {
    code?: string;
    act?: string;
    plan?: string;
    actMs?: number;
  } | null;
  jev: { used?: boolean; act?: string; p?: number; ms?: number } | null;
  earlyExecuted: {
    code?: string;
    settle?: string;
    earlyMs?: number;
    durationMs?: number;
    atMs: number;
  } | null;
  earlyEnded: { phase?: string; code?: string; leadMs?: number } | null;
  runStarted: boolean;
  runId: string | null;
  /** Verbose only: RunState.task. */
  task: string | null;
  taskLength: number | null;
  firstActionMs: number | null;
  firstActionAfterTranscriptMs: number | null;
  actions: string[];
  actionAppIds: string[];
  mutations: number;
  failures: string[];
  confirmations: number;
  /** Verbose only. */
  confirmReason: string | null;
  needClick: boolean;
  takeover: boolean;
  takeoverSources: string[];
  /** Sources that mean the app asked for a hand (request_user, handoff…). */
  handoffSources: string[];
  statusTimeline: { status: string; atMs: number }[];
  terminal: string | null;
  terminalMs: number | null;
  /** Verbose only: RunState.message at the end and along the way. */
  messages: string[];
  providerModel: string | null;
  appId: string | null;
  pausedMs: number | null;
  resumedMs: number | null;
  spoken: boolean;
  replyMs: number | null;
  replyAfterTranscriptMs: number | null;
  speechOut: { engine?: string; latencyMs?: number; fallback?: boolean } | null;
  speech: {
    startedMs: number | null;
    finishedMs: number | null;
    interrupted: boolean | null;
  };
  followup: {
    openedMs: number | null;
    openedKind: string | null;
    detectedMs: number | null;
    detectedKind: string | null;
    closedMs: number | null;
  };
  captureTimings: Record<string, number> | null;
  captureTotals: number[];
  standby: { levels: { atMs: number; rms: number }[]; heardText: boolean };
  lastWakeStatus: boolean | null;
  events: number;
}

const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
/** Runner events arrive as {runId, data: {...}}; the rest carry their fields flat. */
const inner = (d: Record<string, unknown>): Record<string, unknown> =>
  d.data && typeof d.data === "object"
    ? (d.data as Record<string, unknown>)
    : {};
const field = (d: Record<string, unknown>, key: string): unknown =>
  d[key] ?? inner(d)[key];

/**
 * One utterance's summary from the events collected after it was spoken.
 * Offsets are from `spokenAt` (when `say` started), as the trials measured.
 */
export function summarizeTurn(
  events: DiagnosticEvent[],
  spokenAt: number,
  sayEndedAt: number = spokenAt,
): TurnSummary {
  const s: TurnSummary = {
    spokenAt,
    sayMs: Math.max(0, sayEndedAt - spokenAt),
    wakeMs: null,
    transcript: null,
    transcriptMs: null,
    transcriptLength: null,
    confidence: null,
    segments: null,
    recovered: false,
    endpointMs: null,
    plan: null,
    planSource: null,
    decided: null,
    jev: null,
    earlyExecuted: null,
    earlyEnded: null,
    runStarted: false,
    runId: null,
    task: null,
    taskLength: null,
    firstActionMs: null,
    firstActionAfterTranscriptMs: null,
    actions: [],
    actionAppIds: [],
    mutations: 0,
    failures: [],
    confirmations: 0,
    confirmReason: null,
    needClick: false,
    takeover: false,
    takeoverSources: [],
    handoffSources: [],
    statusTimeline: [],
    terminal: null,
    terminalMs: null,
    messages: [],
    providerModel: null,
    appId: null,
    pausedMs: null,
    resumedMs: null,
    spoken: false,
    replyMs: null,
    replyAfterTranscriptMs: null,
    speechOut: null,
    speech: { startedMs: null, finishedMs: null, interrupted: null },
    followup: {
      openedMs: null,
      openedKind: null,
      detectedMs: null,
      detectedKind: null,
      closedMs: null,
    },
    captureTimings: null,
    captureTotals: [],
    standby: { levels: [], heardText: false },
    lastWakeStatus: null,
    events: 0,
  };
  const t = (e: DiagnosticEvent) => Date.parse(e.timestamp) - spokenAt;
  let lastStatus: string | null = null;
  for (const e of events) {
    const d = e.data ?? {};
    if (!isChatter(e)) s.events++;
    if (e.event === "VoiceEvent") {
      const phase = d.phase;
      if (phase === "wake_status") s.lastWakeStatus = d.listening === true;
      if (phase === "wake_detected") s.wakeMs ??= t(e);
      if (phase === "transcript_final" || phase === "transcript_recovered") {
        if (s.transcriptMs === null) {
          s.transcriptMs = t(e);
          s.confidence = num(d.confidence);
          s.segments = num(d.segments);
          s.transcriptLength = num(d.textLength);
        }
        if (phase === "transcript_recovered") s.recovered = true;
      }
      if (phase === "followup_open" && s.followup.openedMs === null) {
        s.followup.openedMs = t(e);
        s.followup.openedKind = str(d.kind);
      }
      if (phase === "followup_detected" && s.followup.detectedMs === null) {
        s.followup.detectedMs = t(e);
        s.followup.detectedKind = str(d.kind);
      }
      if (phase === "followup_closed") s.followup.closedMs = t(e);
      if (phase === "speech_started") s.speech.startedMs ??= t(e);
      if (phase === "speech_finished") {
        s.speech.finishedMs = t(e);
        s.speech.interrupted = d.interrupted === true;
      }
      if (phase === "standby_trace") {
        if (d.kind === "level" && typeof d.rms === "number")
          s.standby.levels.push({ atMs: t(e), rms: d.rms });
        if (typeof d.textLength === "number" && d.textLength > 0)
          s.standby.heardText = true;
      }
      continue;
    }
    if (e.event === "Command") {
      s.transcript ??= str(d.text);
      s.transcriptLength ??= num(d.textLength) ?? str(d.text)?.length ?? null;
    }
    if (e.event === "TurnPlanned") {
      if (s.plan === null) {
        s.plan = str(d.plan);
        s.planSource = str(d.source);
      }
      if (d.plan === "needClick") s.needClick = true;
    }
    if (e.event === "DialogTurn" && d.phase === "decided") {
      s.decided ??= {
        code: str(d.code) ?? undefined,
        act: str(d.act) ?? undefined,
        plan: str(d.plan) ?? undefined,
        actMs: num(d.actMs) ?? undefined,
      };
      if (d.jevUsed !== undefined || d.jevAct)
        s.jev = {
          used: typeof d.jevUsed === "boolean" ? d.jevUsed : undefined,
          act: str(d.jevAct) ?? undefined,
          p: num(d.jevP) ?? undefined,
          ms: num(d.jevMs) ?? undefined,
        };
    }
    if (e.event === "EarlyStartExecuted")
      s.earlyExecuted = {
        code: str(d.code) ?? undefined,
        settle: str(d.settle) ?? undefined,
        earlyMs: num(d.earlyMs) ?? undefined,
        durationMs: num(d.durationMs) ?? undefined,
        atMs: t(e),
      };
    if (e.event === "EarlyStartEnded")
      s.earlyEnded = {
        phase: str(d.phase) ?? undefined,
        code: str(d.code) ?? undefined,
        leadMs: num(d.leadMs) ?? undefined,
      };
    if (e.event === "RunStarted") {
      s.runStarted = true;
      s.runId ??= str(d.runId);
    }
    // Native capture stage times of the first frame (a52652e).
    const timings = field(d, "timings");
    if (e.event === "FrameCaptured" && timings && typeof timings === "object") {
      const record = timings as Record<string, number>;
      s.captureTimings ??= record;
      if (typeof record.total === "number") s.captureTotals.push(record.total);
    }
    if (e.event === "ActionExecuted") {
      s.firstActionMs ??= t(e);
      const type =
        str(field(d, "actionType")) ??
        str((inner(d).action as Record<string, unknown> | undefined)?.type) ??
        "?";
      s.actions.push(type);
      if (MUTATING.has(type)) s.mutations++;
      const app = str(field(d, "appId")) ?? str(field(d, "frontmost"));
      if (app) s.actionAppIds.push(app);
    }
    if (e.event === "ActionFailed") {
      const code = str(field(d, "code")) ?? "?";
      const change = str(field(d, "change"));
      s.failures.push(code + (change ? `:${change}` : ""));
    }
    if (e.event === "PolicyConfirmationRequested") {
      s.confirmations++;
      s.confirmReason ??= str(field(d, "reason"));
    }
    if (e.event === "UserTakeoverStarted" || e.event === "NativeUserTakeover") {
      const source =
        str(field(d, "source")) ??
        (e.event === "NativeUserTakeover" ? "native" : "manual_input");
      if (HANDOFF_SOURCES.has(source)) s.handoffSources.push(source);
      else {
        s.takeover = true;
        s.takeoverSources.push(source);
      }
    }
    if (e.event === "RunState") {
      const status = str(d.status);
      s.runId ??= str(d.runId);
      if (d.task && !s.task) s.task = str(d.task);
      s.taskLength ??= num(d.taskLength);
      s.appId = str(d.appId) ?? s.appId;
      if (d.provider || d.model)
        s.providerModel ??= `${str(d.provider) ?? "?"}:${str(d.model) ?? "?"}`;
      const message = str(d.message);
      if (message && s.messages.at(-1) !== message) s.messages.push(message);
      if (status && status !== lastStatus) {
        s.statusTimeline.push({ status, atMs: t(e) });
        if (status === "paused") s.pausedMs ??= t(e);
        else if (lastStatus === "paused" && !TERMINAL.has(status))
          s.resumedMs ??= t(e);
        lastStatus = status;
      }
      if (status && TERMINAL.has(status)) {
        s.terminal = status;
        s.terminalMs = t(e);
      }
    }
    if (e.event === "SpeechOut" && d.phase === "requested") {
      s.spoken = true;
      s.replyMs ??= t(e);
      s.speechOut ??= {
        engine: str(d.engine) ?? undefined,
        latencyMs: num(d.latencyMs) ?? undefined,
        fallback: typeof d.fallback === "boolean" ? d.fallback : undefined,
      };
    }
  }
  if (s.transcriptMs !== null) {
    s.endpointMs = s.transcriptMs - s.sayMs;
    if (s.firstActionMs !== null)
      s.firstActionAfterTranscriptMs = s.firstActionMs - s.transcriptMs;
    if (s.replyMs !== null)
      s.replyAfterTranscriptMs = s.replyMs - s.transcriptMs;
  }
  return s;
}

/* ------------------------------------------------------------- hearing */

/** Lowercase, `_`/`+`/`%20` to spaces, everything but letters, digits and spaces removed. */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/%20|[_+]/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type Heard = "heard" | "misheard" | "unheard";
/** A wake later than this belongs to something else. */
export const HEARD_WITHIN_MS = 15_000;

/**
 * heard: the wake phrase within 15 s and the utterance's key words in the
 * transcript. misheard: heard something else. unheard: nothing at all. A
 * follow-up line (no wake phrase) counts its transcript instead of a wake.
 */
export function heardVerdict(
  turn: Pick<Turn, "heard" | "withWake">,
  s: TurnSummary,
): Heard {
  const arrivedMs = turn.withWake === false ? s.transcriptMs : s.wakeMs;
  if (arrivedMs === null || arrivedMs > HEARD_WITHIN_MS) return "unheard";
  if (s.transcript === null) return "unheard";
  if (!turn.heard) return "heard";
  const pattern = new RegExp(turn.heard, "i");
  return pattern.test(normalizeForMatch(s.transcript)) ? "heard" : "misheard";
}

/* ------------------------------------------------------------- outcomes */

export interface OutcomeMatch {
  ok: boolean;
  /** What the app did, as a code: run, answer, question, confirmation, none… */
  observed: Outcome | "none";
  reason?: string;
}

const STOP_WITHIN_MS = 3000;
const INTERRUPT_WITHIN_MS = 1500;

/** What the summary shows the app did with the utterance. */
export function observedOutcome(s: TurnSummary): Outcome | "none" {
  if (s.plan === "stop") return "stop";
  if (s.plan === "pause") return "pause";
  if (s.plan === "resume") return "resume";
  if (
    s.plan === "revise" ||
    s.plan === "amendTask" ||
    s.decided?.act === "revise"
  )
    return "revise";
  if (
    s.confirmations > 0 ||
    s.statusTimeline.some((x) => x.status === "confirming")
  )
    return "confirmation";
  if (s.runStarted) return "run";
  if (s.decided?.act === "answer") return "answer";
  if (s.plan === "clarify" || (s.decided?.act === "none" && s.spoken))
    return "question";
  return "none";
}

/**
 * Whether one utterance's plan-level expectation held: the kind of thing
 * that happened, not whether it finished well (terminal, confirmations and
 * state are judged apart, so each failure lands in its own class).
 */
export function outcomeMatches(expect: Expect, s: TurnSummary): OutcomeMatch {
  const accepted = [expect.outcome, ...(expect.alsoAccept ?? [])];
  const observed = observedOutcome(s);
  const fail = (reason: string): OutcomeMatch => ({
    ok: false,
    observed,
    reason,
  });
  for (const outcome of accepted) {
    switch (outcome) {
      case "answer":
        if (s.decided?.act === "answer" && !s.runStarted && s.spoken)
          return { ok: true, observed };
        break;
      case "question":
        if (
          (s.plan === "clarify" || (s.decided?.act === "none" && s.spoken)) &&
          !s.runStarted &&
          !s.actions.length
        )
          return { ok: true, observed };
        break;
      case "run": {
        const started =
          s.runStarted &&
          (s.plan === "start" ||
            s.plan === "replace" ||
            s.decided?.code === "fast_start" ||
            s.decided?.code === "jev_start" ||
            s.decided?.act === "start" ||
            s.decided?.act === "replace");
        if (started) return { ok: true, observed };
        break;
      }
      case "stop":
        if (s.plan === "stop") {
          const from = s.wakeMs ?? s.followup.detectedMs ?? 0;
          if (
            s.terminal &&
            (s.terminal === "cancelled" || s.terminal === "stopped") &&
            s.terminalMs !== null &&
            s.terminalMs - from <= STOP_WITHIN_MS
          )
            return { ok: true, observed };
          return fail(s.terminal ? "STOP_LATE" : "STOP_IGNORED");
        }
        break;
      case "pause":
        if (s.plan === "pause") {
          const from = s.wakeMs ?? 0;
          if (s.pausedMs !== null && s.pausedMs - from <= STOP_WITHIN_MS)
            return { ok: true, observed };
          return fail("PAUSE_LATE");
        }
        break;
      case "resume":
        if (s.plan === "resume") {
          const from = s.wakeMs ?? 0;
          if (s.resumedMs !== null && s.resumedMs - from <= STOP_WITHIN_MS)
            return { ok: true, observed };
          return fail("RESUME_LATE");
        }
        break;
      case "revise":
        if (observed === "revise") return { ok: true, observed };
        break;
      case "confirmation": {
        const asked =
          s.confirmations > 0 ||
          s.statusTimeline.some((x) => x.status === "confirming");
        if (!asked) break;
        if (
          expect.confirmReason &&
          s.confirmReason &&
          !new RegExp(expect.confirmReason, "i").test(s.confirmReason)
        )
          return fail("CONFIRM_REASON");
        return { ok: true, observed };
      }
      case "silence":
        if (s.wakeMs === null && s.transcriptMs === null && !s.runStarted)
          return { ok: true, observed };
        return fail("FALSE_WAKE");
      case "interrupt": {
        const from = s.wakeMs ?? 0;
        if (
          s.speech.interrupted &&
          s.speech.finishedMs !== null &&
          s.speech.finishedMs - from <= INTERRUPT_WITHIN_MS
        )
          return { ok: true, observed };
        return fail(
          s.speech.interrupted ? "INTERRUPT_LATE" : "NOT_INTERRUPTED",
        );
      }
    }
  }
  return fail(
    `EXPECTED_${expect.outcome.toUpperCase()}_GOT_${observed.toUpperCase()}`,
  );
}

/* ---------------------------------------------------------- state checks */

/** What the script read back for one check: a value, an exit code, a duration. */
export interface CheckEvidence {
  value?: string;
  exitCode: number;
  ms: number;
}
export type StateEvidence = Record<string, CheckEvidence>;

export interface CheckResults {
  /** true, false, or null when unreadable and optional. */
  checks: Record<string, boolean | null>;
  /** Non-optional checks that could not be read: grader debt, never a pass. */
  unreadable: string[];
  failed: string[];
  primaryFailed: string[];
}

const firstNumber = (text: string): number | null => {
  const match = /-?\d+(?:\.\d+)?/.exec(text.replace(/(?<=\d)[,  ](?=\d)/g, ""));
  return match ? Number(match[0]) : null;
};
const allNumbers = (text: string): number[] =>
  [...text.replace(/(?<=\d)[,  ](?=\d)/g, "").matchAll(/-?\d+(?:\.\d+)?/g)].map(
    (m) => Number(m[0]),
  );

/** One check against its evidence; null when it could not be read. */
export function checkHolds(
  check: StateCheck,
  evidence: CheckEvidence | undefined,
): boolean | null {
  if (!evidence) return null;
  if (check.expect === "exitZero") return evidence.exitCode === 0;
  if (evidence.exitCode !== 0 || evidence.value === undefined) return null;
  const value = evidence.value;
  const want = check.value === undefined ? "" : String(check.value);
  switch (check.expect) {
    case "contains":
      return normalizeForMatch(value).includes(normalizeForMatch(want));
    case "notContains":
      return !normalizeForMatch(value).includes(normalizeForMatch(want));
    case "equals":
      return normalizeForMatch(value) === normalizeForMatch(want);
    case "matches":
      return new RegExp(want, "is").test(normalizeForMatch(value));
    case "gt": {
      const n = firstNumber(value);
      return n !== null && n > Number(want);
    }
    case "lt": {
      const n = firstNumber(value);
      return n !== null && n < Number(want);
    }
    case "inRange": {
      const [lo, hi] = Array.isArray(check.value) ? check.value : [NaN, NaN];
      return allNumbers(value).some((n) => n >= lo && n <= hi);
    }
    case "nonempty":
      return value.trim().length > 0;
  }
  return null;
}

/**
 * Applies the expectation's state checks, frontmost and replyHas to what the
 * script collected. Only names and booleans come out; no value is copied.
 */
export function applyStateChecks(
  expect: Expect,
  evidence: StateEvidence,
  s: TurnSummary | undefined,
  observed: Outcome | "none",
): CheckResults {
  const out: CheckResults = {
    checks: {},
    unreadable: [],
    failed: [],
    primaryFailed: [],
  };
  const record = (
    name: string,
    ok: boolean | null,
    primary: boolean,
    optional: boolean,
  ) => {
    out.checks[name] = ok;
    if (ok === null) {
      if (!optional) out.unreadable.push(name);
      return;
    }
    if (!ok) {
      out.failed.push(name);
      if (primary) out.primaryFailed.push(name);
    }
  };
  for (const check of expect.state ?? []) {
    if (check.when && check.when !== observed) continue;
    record(
      check.name,
      checkHolds(check, evidence[check.name]),
      !!check.primary,
      !!check.optional,
    );
  }
  if (expect.frontmost) {
    const wanted = (
      Array.isArray(expect.frontmost) ? expect.frontmost : [expect.frontmost]
    ).map((x) => x.toLowerCase());
    const read = evidence.frontmost;
    const ok =
      read && read.exitCode === 0 && read.value !== undefined
        ? wanted.includes(read.value.trim().toLowerCase())
        : null;
    record("frontmost", ok, true, false);
  }
  if (expect.replyHas && s) {
    const pattern = new RegExp(expect.replyHas, "i");
    record(
      "replyHas",
      s.messages.some((m) => pattern.test(m)),
      true,
      false,
    );
  }
  if (expect.noMutation && s)
    record("noMutation", s.mutations === 0, false, false);
  if (expect.maxActions !== undefined && s)
    record("maxActions", s.actions.length <= expect.maxActions, false, false);
  if (expect.actionTypes?.length && s)
    record(
      "actionTypes",
      expect.actionTypes.every((type) => s.actions.includes(type)),
      true,
      false,
    );
  if (expect.noEarlyStart && s)
    record("noEarlyStart", s.earlyExecuted === null, false, false);
  // Recorded, never failing: the early start is a speed feature, not a result.
  if (expect.earlyStart && s) out.checks.earlyStart = s.earlyExecuted !== null;
  return out;
}

/* ----------------------------------------------------------------- grade */

/** What the script knew about the turn that no event says. */
export interface TurnContext {
  /** The loop said "stop" (a timeout, a confirmation, or the end of a steering task). */
  stoppedByLoop?: boolean;
  /** The task's timeout passed with the run still going. */
  timedOut?: boolean;
  /** A preflight or gate refusal for this turn (ENV_NOT_READY subcode). */
  envSubcode?: string;
  /** HID idle fell while the app did nothing: a person is here. */
  hidTakeover?: boolean;
  /** Verbose diagnostics were on, so transcripts and task text were readable. */
  verbose?: boolean;
  /** The attempt's token and folder, so `{token}` in a check value or replyHas resolves. */
  fill?: Fill;
}

/** The expectation with its placeholders filled; values only, never scripts (the script fills those). */
export function fillExpect(expect: Expect, fill: Fill | undefined): Expect {
  if (!fill) return expect;
  const text = (value: string | undefined) =>
    value === undefined ? undefined : fillPlaceholders(value, fill);
  return {
    ...expect,
    replyHas: text(expect.replyHas),
    taskWords: text(expect.taskWords),
    taskWordsNot: text(expect.taskWordsNot),
    state: expect.state?.map((check) => ({
      ...check,
      value:
        typeof check.value === "string"
          ? fillPlaceholders(check.value, fill)
          : check.value,
    })),
  };
}

/** Latency budgets: targets for the report, limits for the soft classes. */
export const LATENCY = {
  wakeTargetMs: 3000,
  endpointTargetMs: 3800,
  firstActionTargetMs: 2500,
  firstActionLimitMs: 4000,
  replyTargetMs: 1500,
  replyLimitMs: 3000,
  ackLimitMs: 2000,
  captureTargetMs: 900,
} as const;

/** Everything classify() needs, and nothing that could carry content. */
export interface TurnGrade {
  taskId: string;
  category: string;
  tags: string[];
  noisy: boolean;
  heard: Heard;
  /** Which utterance failed to be heard, when one did. */
  unheardUtterance: number | null;
  expectOutcome: Outcome;
  observed: (Outcome | "none")[];
  planMatched: boolean;
  planReasons: string[];
  taskWordsOk: boolean | null;
  runStarted: boolean;
  terminal: string | null;
  runCompletedRequired: boolean;
  noConfirmationRequired: boolean;
  confirmations: number;
  needClick: boolean;
  handoffSources: string[];
  takeover: boolean;
  stoppedByLoop: boolean;
  timedOut: boolean;
  envSubcode: string | null;
  failures: string[];
  actions: number;
  mutations: number;
  checks: Record<string, boolean | null>;
  checksFailed: string[];
  primaryFailed: string[];
  unreadable: string[];
  firstActionAfterTranscriptMs: number | null;
  replyAfterTranscriptMs: number | null;
  firstActionLimitMs: number;
  replyLimitMs: number;
  /** A reply to a command (ack) has a tighter budget than an answer. */
  replyIsAck: boolean;
  spoken: boolean;
}

/**
 * The grade for one task attempt from the summaries of its utterances (one
 * per spoken line, each over the events from its own `say`) and the state
 * the script read back at the end.
 */
export function gradeTurn(
  task: VoiceTask,
  summaries: TurnSummary[],
  evidence: StateEvidence,
  context: TurnContext = {},
): TurnGrade {
  const turns = turnsOf(task).map((turn) => ({
    ...turn,
    expect: fillExpect(turn.expect, context.fill),
  }));
  const last = turns.at(-1)!;
  const lastSummary = summaries.at(-1);
  const heardEach = turns.map((turn, i) =>
    summaries[i] ? heardVerdict(turn, summaries[i]) : "unheard",
  );
  const unheardAt = heardEach.findIndex((h) => h !== "heard");
  // The false-wake test is heard by nobody, by design.
  const silence = last.expect.outcome === "silence";
  const heard: Heard = silence
    ? "heard"
    : unheardAt < 0
      ? "heard"
      : heardEach[unheardAt];
  const matches = turns.map((turn, i) =>
    summaries[i]
      ? outcomeMatches(turn.expect, summaries[i])
      : { ok: false, observed: "none" as const, reason: "NOT_SPOKEN" },
  );
  const observed = matches.map((m) => m.observed);
  const planMatched = matches.every((m) => m.ok);
  const planReasons = matches.flatMap((m) =>
    m.ok || !m.reason ? [] : [m.reason],
  );

  // The run's words, under verbose diagnostics; null when unreadable.
  const taskText = summaries.map((s) => s.task).find((x) => x) ?? null;
  let taskWordsOk: boolean | null = null;
  const words = turns
    .map((t) => t.expect)
    .find((e) => e.taskWords || e.taskWordsNot);
  if (words && taskText !== null) {
    taskWordsOk =
      (!words.taskWords || new RegExp(words.taskWords, "i").test(taskText)) &&
      (!words.taskWordsNot ||
        !new RegExp(words.taskWordsNot, "i").test(taskText));
  } else if (words && context.verbose === false) taskWordsOk = null;

  const runStarted = summaries.some((s) => s.runStarted);
  // The end of the run is what the last utterance saw, else any utterance.
  const terminal =
    lastSummary?.terminal ??
    summaries.map((s) => s.terminal).find((x) => x) ??
    null;
  const expectOutcome = last.expect.outcome;
  const runCompletedRequired =
    last.expect.runCompleted ??
    (expectOutcome === "run" || expectOutcome === "revise");
  const noConfirmationRequired = turns.every(
    (turn) =>
      turn.expect.noConfirmation ?? turn.expect.outcome !== "confirmation",
  );
  // State is judged only for a heard prompt whose plan was right: a check
  // that cannot be read must not mask an unheard or misrouted turn.
  const state =
    heard === "heard" && planMatched
      ? applyStateChecks(
          // Checks may sit on any utterance; the last one's frontmost/reply rules apply.
          {
            ...last.expect,
            state: turns.flatMap((turn) => turn.expect.state ?? []),
          },
          evidence,
          lastSummary ?? summaries[0],
          observed.at(-1) ?? "none",
        )
      : { checks: {}, unreadable: [], failed: [], primaryFailed: [] };
  const first = summaries[0];
  const replyIsAck = expectOutcome !== "answer" && expectOutcome !== "question";
  return {
    taskId: task.id,
    category: task.category,
    tags: task.tags,
    noisy: task.tags.includes("noisy"),
    heard,
    unheardUtterance: silence || unheardAt < 0 ? null : unheardAt,
    expectOutcome,
    observed,
    planMatched,
    planReasons,
    taskWordsOk,
    runStarted,
    terminal,
    runCompletedRequired,
    noConfirmationRequired,
    confirmations: summaries.reduce((n, s) => n + s.confirmations, 0),
    needClick: summaries.some((s) => s.needClick),
    handoffSources: summaries.flatMap((s) => s.handoffSources),
    takeover: summaries.some((s) => s.takeover) || !!context.hidTakeover,
    stoppedByLoop: !!context.stoppedByLoop,
    timedOut: !!context.timedOut,
    envSubcode: context.envSubcode ?? null,
    failures: summaries.flatMap((s) => s.failures),
    actions: summaries.reduce((n, s) => n + s.actions.length, 0),
    mutations: summaries.reduce((n, s) => n + s.mutations, 0),
    checks: state.checks,
    checksFailed: state.failed,
    primaryFailed: state.primaryFailed,
    unreadable: state.unreadable,
    firstActionAfterTranscriptMs: first?.firstActionAfterTranscriptMs ?? null,
    replyAfterTranscriptMs: first?.replyAfterTranscriptMs ?? null,
    firstActionLimitMs:
      last.expect.latency?.firstActionAfterTranscriptMs ??
      LATENCY.firstActionLimitMs,
    replyLimitMs:
      last.expect.latency?.replyAfterTranscriptMs ??
      (replyIsAck ? LATENCY.ackLimitMs : LATENCY.replyLimitMs),
    replyIsAck,
    spoken: summaries.some((s) => s.spoken),
  };
}

/* ------------------------------------------------------------------ gate */

export type VoiceGateReason =
  | "HID_ACTIVE"
  | "NOT_LISTENING"
  | "SPEAKING"
  | "FOLLOWUP_OPEN"
  | "RUN_OPEN"
  | "BUSY"
  | "NOISE"
  | "VOLUME";

export interface VoiceGateFacts {
  now: number;
  /** Seconds since any HID event (ioreg), the app's own input included. */
  hidIdleSeconds: number | undefined;
  /** --idle-seconds: the full idle at the start and after any human input. */
  idleSeconds: number;
  /** When a person was last seen at the Mac (a takeover, a gate refusal). */
  humanSeenAt?: number;
  /** The app's last ActionExecuted: its own input resets HIDIdleTime too. */
  lastActionAt?: number;
  /** The latest wake_status; null when none was seen. */
  listening: boolean | null;
  /** The newest non-chatter event. */
  lastEventAt: number;
  /** The last speech_finished, if the app has spoken. */
  speechFinishedAt?: number;
  /** A followup_open without its followup_closed. */
  followupOpen: boolean;
  /** The newest run is not terminal. */
  runOpen: boolean;
  quiet?: {
    /** The newest standby levels, oldest first. */
    levels: number[];
    threshold: number;
    /** The last standby_trace with textLength > 0. */
    heardTextAt?: number;
  };
  volume?: { level: number; muted: boolean; wanted: number };
}

export interface VoiceGateDecision {
  ok: boolean;
  reason?: VoiceGateReason;
  idle?: { required: number; seen: number };
}

/** Milliseconds the app must have been silent in the log before a prompt. */
export const SETTLE_MS = 5000;
/** The echo guard after the app's own speech. */
export const ECHO_GUARD_MS = 800;
/** A standby text trace this recent means the room is talking. */
export const ROOM_TEXT_MS = 10_000;

/**
 * Before every prompt, cheapest to recover first: the app must be settled
 * (no open run, no open follow-up window, not speaking, quiet in its log
 * and listening), the room quiet, the volume as calibrated, and nobody at
 * the Mac. The idle rule is the bench's `idleRequired`: the full idle at
 * the start and after any person, between tasks only "no input since the
 * app's own last action plus slack", since the app's synthetic input moves
 * HIDIdleTime like a hand would.
 */
export function voiceGate(f: VoiceGateFacts): VoiceGateDecision {
  if (f.runOpen) return { ok: false, reason: "RUN_OPEN" };
  if (f.followupOpen) return { ok: false, reason: "FOLLOWUP_OPEN" };
  if (
    f.speechFinishedAt !== undefined &&
    f.now - f.speechFinishedAt < ECHO_GUARD_MS
  )
    return { ok: false, reason: "SPEAKING" };
  if (f.now - f.lastEventAt < SETTLE_MS) return { ok: false, reason: "BUSY" };
  if (f.listening !== true) return { ok: false, reason: "NOT_LISTENING" };
  if (f.quiet) {
    const recent = f.quiet.levels.slice(-2);
    if (recent.length < 2 || recent.some((rms) => rms > f.quiet!.threshold))
      return { ok: false, reason: "NOISE" };
    if (
      f.quiet.heardTextAt !== undefined &&
      f.now - f.quiet.heardTextAt < ROOM_TEXT_MS
    )
      return { ok: false, reason: "NOISE" };
  }
  if (
    f.volume &&
    (f.volume.muted || Math.abs(f.volume.level - f.volume.wanted) > 2)
  )
    return { ok: false, reason: "VOLUME" };
  const required = idleRequired(
    {
      idleSeconds: f.idleSeconds,
      humanSeenAt: f.humanSeenAt,
      lastAgentInputAt: f.lastActionAt,
    },
    f.now,
  );
  const seen = f.hidIdleSeconds ?? 0;
  if (seen < required)
    return { ok: false, reason: "HID_ACTIVE", idle: { required, seen } };
  return { ok: true, idle: { required, seen } };
}

/**
 * The quiet threshold between the room's floor and the loop's own voice:
 * `floor + 0.35 x (speech - floor)`, calibrated per cycle and printed.
 */
export function quietThreshold(floor: number, speechLevel: number): number {
  return floor + 0.35 * Math.max(0, speechLevel - floor);
}

/** The median of standby `level` rms values, or undefined without samples. */
export function medianLevel(levels: number[]): number | undefined {
  if (!levels.length) return undefined;
  const sorted = [...levels].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * A person at the Mac during a turn: HID idle shorter than the time since
 * the prompt while the app executed nothing in the last 3 s. The app's own
 * clicks reset the counter, so a recent ActionExecuted explains a reset.
 */
export function hidTakeover(o: {
  now: number;
  hidIdleSeconds: number | undefined;
  promptStartedAt: number;
  lastActionAt?: number;
}): boolean {
  if (o.hidIdleSeconds === undefined) return false;
  const sincePrompt = (o.now - o.promptStartedAt) / 1000;
  const appJustActed =
    o.lastActionAt !== undefined && o.now - o.lastActionAt <= 3000;
  return o.hidIdleSeconds < sincePrompt && !appJustActed;
}
