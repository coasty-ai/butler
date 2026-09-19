/**
 * Measuring TypeSafe's Jev on Butler's own decisions. Jev is a "System
 * One" model: it takes app state plus typed questions and returns typed
 * answers with probabilities, through OpenRouter's alpha Decisions endpoint,
 * and it writes no text. This is the pure half of scripts/eval-jev.mjs: the
 * request it sends, how an answer is read, the questions it asks (built from
 * the dialog prompt and the watch's own state names, never from a case's
 * expected answer), and how answers are scored and binned. Nothing here
 * touches the network, the clock or the file system.
 *
 * Only labels, probabilities, ids and timings come out of it, so a report is
 * content-free: Jev has no words to leak, and the state it was shown is
 * never copied into a result.
 */
import { arbitrate, dialogEligible, fastStart } from "../assistant/arbitrate";
import { DIALOG_SYSTEM } from "../assistant/prompt";
import { DIALOG_ACTS, TASK_ACTS, type DialogAct } from "../assistant/protocol";
import {
  buildDialogState,
  dialogStateJson,
  type DialogState,
} from "../assistant/state";
import type { Channel, RunView, TurnRecord } from "../assistant/types";
import {
  agentNames,
  normalizeOcr,
  panelState,
  type AgentId,
  type AgentState,
} from "../core/monitor";
import {
  planVoiceTurn,
  type TurnPlan,
  type TurnPlanKind,
  type VoiceTurnRun,
} from "../voice/turns";
import * as jev from "../providers/jev";
import { wilson } from "./honesty";

// The wire ----------------------------------------------------------------

/**
 * The request, the answer readers and the dialog-act question live in
 * src/providers/jev.ts, which the app uses too. This module keeps the eval's
 * names and defaults (the dialog prompt and act list are filled in here, so
 * scripts/eval-jev.mjs and tests/eval-jev.test.ts read as before) and adds
 * only what a measurement needs: fixtures, scoring, bins and comparisons.
 */
export {
  DECISIONS_ENDPOINT,
  DIALOG_GOAL,
  DIALOG_QUESTION,
  DIALOG_RULES,
  DIALOG_VARIANTS,
  JEV_INPUT_PRICE,
  JEV_MODEL,
  JEV_OVERHEAD_TOKENS,
  JEV_PROVIDER,
  JEV_SERVED_MODEL,
  RETRY_STATUS,
  decisionsRequest,
  estimateCost,
  readChoice,
  readServed,
  readUsage,
  servedError,
} from "../providers/jev";
export type {
  ChoiceAnswer,
  DecisionsRequest,
  DialogVariant,
  JevChoiceQuestion,
  JevEntry,
  JevUsage as Usage,
  ReadChoice,
  Served,
} from "../providers/jev";

// Eval 1: the dialog act ---------------------------------------------------

/** The prompt's own line for each act (src/providers/jev.ts actDescriptions). */
export function actDescriptions(
  system: string = DIALOG_SYSTEM,
): Record<DialogAct, string> {
  return jev.actDescriptions(system, DIALOG_ACTS);
}

/** What the prompt says the request holds (src/providers/jev.ts stateGuide). */
export function stateGuide(system: string = DIALOG_SYSTEM): string {
  return jev.stateGuide(system);
}

/** The prompt's rules after the act list (src/providers/jev.ts promptRules). */
export function promptRules(system: string = DIALOG_SYSTEM): string[] {
  return jev.promptRules(system);
}

/**
 * The one Choice question (src/providers/jev.ts dialogActQuestion). The
 * variant has no default, so a caller always says which wording it measured.
 */
export function dialogActQuestion(
  variant: jev.DialogVariant,
  system: string = DIALOG_SYSTEM,
): jev.JevChoiceQuestion {
  return jev.dialogActQuestion(variant, system, DIALOG_ACTS);
}

/** One line of tests/fixtures/dialog-eval.jsonl. */
export interface DialogCase {
  id: string;
  user: string;
  channel?: Channel;
  expect: { act: string | string[]; mustNotRun?: boolean; grounded?: boolean };
  tags?: string[];
  view?: Partial<RunView>;
  run?: VoiceTurnRun;
  turns?: { role: "user" | "assistant"; text: string; untrusted?: boolean }[];
  addressAs?: string;
  agenda?: string[];
  notifications?: string[];
  openApps?: string[];
  heldByVoice?: boolean;
}

/** The clock scripts/eval-dialog.mjs gives every case. */
export const EVAL_NOW = "2026-09-17T14:05:00";
/** The character budget eval-dialog.mjs and the dialog core render into. */
export const DIALOG_STATE_CHARS = 6000;
const IDLE: RunView = {
  running: false,
  status: "idle",
  recent: [],
  queued: [],
  watches: [],
};

/** The case's turns exactly as eval-dialog.mjs records them. */
export function caseTurns(c: DialogCase): TurnRecord[] {
  return (c.turns ?? []).map((t, i) => ({
    role: t.role,
    channel: "voice",
    text: t.text,
    at: i,
    untrusted: t.untrusted === true,
  }));
}

/** The dialog state eval-dialog.mjs builds for a case, field for field. */
export function caseDialogState(c: DialogCase): DialogState {
  return buildDialogState({
    channel: c.channel ?? "voice",
    user: c.user,
    view: c.view ? { ...IDLE, ...c.view } : IDLE,
    turns: caseTurns(c),
    addressAs: c.addressAs,
    agenda: c.agenda,
    notifications: c.notifications,
    openApps: c.openApps,
    heldByVoice: c.heldByVoice === true,
    now: new Date(EVAL_NOW),
  });
}

/**
 * The state Jev is shown: the very string the dialog model gets as its user
 * message, bounded and ordered by dialogStateJson, parsed back to an object
 * because TypeSafe reads named fields best.
 */
export function caseJevState(c: DialogCase): unknown {
  return JSON.parse(dialogStateJson(caseDialogState(c), DIALOG_STATE_CHARS));
}

export const acceptedActs = (c: DialogCase): string[] =>
  Array.isArray(c.expect.act) ? c.expect.act : [c.expect.act];

/** The deterministic router's plan for the case, as eval-dialog.mjs asks it. */
export function routerPlan(c: DialogCase): TurnPlan {
  return planVoiceTurn({
    text: c.user,
    confidence: 0.9,
    source: "wake",
    gateMatches: false,
    now: 1,
    run: c.run,
  });
}

/**
 * True when the turn never reaches a dialog model, as electron/assistant.ts
 * decides it: the router settled it (a clarify, a queue, a control word), or
 * it is a fast start that runs the user's words at once. Whatever a model
 * answers there changes nothing, so its accuracy is also reported without
 * these cases.
 */
export function routerSettled(
  c: DialogCase,
  plan: TurnPlan = routerPlan(c),
): boolean {
  return !dialogEligible(plan) || fastStart(plan, c.user);
}

/** Router plans that do what one dialog act would do. */
const ROUTER_ACTS: Partial<Record<TurnPlanKind, DialogAct>> = {
  start: "start",
  revise: "revise",
  replace: "replace",
  queue: "queue",
  status: "status",
  pause: "pause",
  resume: "resume",
  // A clarify asks one short question: the prompt's "unsure, use none".
  clarify: "none",
  acknowledge: "none",
};

/**
 * The router-only baseline scored as an act: what the head-timeout fallback
 * would do with no model at all. A plan with no act of its own keeps its
 * kind, which no case accepts.
 */
export function routerAct(plan: TurnPlan): string {
  if (plan.kind === "reply") return plan.act;
  return ROUTER_ACTS[plan.kind] ?? plan.kind;
}

/**
 * What would happen if Jev's act were wired in. Jev writes no TASK, so the
 * task is the user's own words, the way a fast start runs them today; the
 * router's plan and arbitration are exactly eval-dialog.mjs's.
 */
export function arbitratedKind(
  c: DialogCase,
  act: DialogAct,
  base: TurnPlan = routerPlan(c),
): string {
  const turns = caseTurns(c);
  const words = "text" in base && base.text ? base.text : c.user;
  return arbitrate({
    base,
    head: { act, ...(TASK_ACTS.has(act) ? { task: words } : {}) },
    utterance: c.user,
    run: c.run,
    context: turns.filter((t) => !t.untrusted).map((t) => t.text),
    userWords: turns.filter((t) => t.role === "user").map((t) => t.text),
    channel: c.channel ?? "voice",
    heldByVoice: c.heldByVoice === true,
  }).plan.kind;
}

/**
 * The plan that would actually run with a model answering `act`: the
 * router's own on a turn it settles (no model is asked), else the
 * arbitration of the act. Used the same way for Jev and for a baseline
 * model, so their would-run counts measure the same thing.
 */
export function plannedKind(c: DialogCase, act: DialogAct): string {
  const base = routerPlan(c);
  return routerSettled(c, base) ? base.kind : arbitratedKind(c, act, base);
}
const RUN_KINDS = new Set(["start", "revise", "replace", "queue"]);

// Eval 2: a coding agent's panel -------------------------------------------

export const PANEL_STATES = [
  "idle",
  "working",
  "needs_permission",
  "review_edits",
  "done",
  "error",
  "unknown",
] as const satisfies readonly AgentState[];

/**
 * What each state means, in general terms. None of the anchor phrases in
 * src/core/monitor.ts is quoted: the point is whether Jev can read a panel
 * the regex tables were not written for.
 */
export const PANEL_CRITERIA: Record<AgentState, string> = {
  idle: "Nothing is in progress and nothing asks for the user: the agent waits for a new message, showing its empty input box or a focus hint, with at most finished history above it.",
  working:
    "The agent is busy right now: running a command or tool, thinking or generating; its turn is still in progress.",
  needs_permission:
    "The agent has stopped to ask the user for permission or a decision before it goes on: a confirmation question, numbered options, or approve and decline buttons.",
  review_edits:
    "The agent has changed files and waits for the user to keep or undo those edits.",
  done: "A status line says the agent's latest turn has just finished or was stopped, and it waits for the user.",
  error:
    "The latest turn, at the bottom of the panel, failed or was cut short: an error message, a tool that was stopped midway, or a button to try again.",
  unknown:
    "The lines show no coding agent state at all: only code, file names or a bare title.",
};
export const PANEL_QUESTION =
  "Which state does this coding agent's panel show?";
export const PANEL_RULES = [
  "A question for the user counts wherever it appears in the panel.",
  "Otherwise read the lines at the bottom first: the transcript above may quote older turns.",
] as const;

export function panelQuestion(): jev.JevChoiceQuestion {
  return {
    type: "choice",
    instructions: { question: PANEL_QUESTION, rules: [...PANEL_RULES] },
    criteria: { ...PANEL_CRITERIA },
  };
}

/** One agentStates case from tests/fixtures/ide-agents.json. */
export interface PanelCase {
  agent: AgentId;
  state: AgentState;
  lines: { t: string; y: number; h: number }[];
}

/**
 * The panel as text lines, top to bottom, each placed in words: Jev is bad
 * at comparing numbers, so the window fraction becomes top, middle or
 * bottom in code, with bottom at the same boundary panelState reads from.
 */
export function panelJevState(c: PanelCase): {
  agent: string;
  lines: { text: string; where: "top" | "middle" | "bottom" }[];
} {
  return {
    agent: agentNames[c.agent],
    lines: [...c.lines]
      .sort((a, b) => a.y - b.y)
      .map((l) => ({
        text: l.t,
        where: l.y + l.h >= 0.6 ? "bottom" : l.y < 0.2 ? "top" : "middle",
      })),
  };
}

/** What the deterministic anchor tables say, as monitor.test.ts reads it. */
export function regexPanelState(c: PanelCase): AgentState {
  return panelState(
    c.agent,
    c.lines.map((l) => ({ t: normalizeOcr(l.t), y: l.y, h: l.h })),
  );
}

// Scoring -----------------------------------------------------------------

/** One case's outcome. p is the probability of the option Jev chose. */
export interface Scored {
  id: string;
  expected: string[];
  tags: string[];
  got?: string;
  p: number;
  confidence: number;
  /** Probability mass on every accepted option: a soft accuracy. */
  pAccepted: number;
  right: boolean;
  error?: string;
  latencyMs?: number;
  /** The first call of a run, on a connection opened for it. */
  cold?: boolean;
  cost: number;
  mustNotRun?: boolean;
  /** For the dialog eval: the router settles the turn before any model. */
  settled?: boolean;
  /**
   * For the dialog eval: the plan that would run (plannedKind), or null when
   * a baseline's act is unknown and its accepted acts disagree on the plan.
   */
  plan?: string | null;
  /** The whole distribution, for run-to-run drift; never reported per case. */
  probabilities?: Record<string, number>;
}

export function scoreAnswer(
  expected: readonly string[],
  answer: jev.ChoiceAnswer,
): Pick<Scored, "got" | "p" | "confidence" | "pAccepted" | "right"> {
  const pAccepted = expected.reduce(
    (sum, option) => sum + (answer.probabilities[option] ?? 0),
    0,
  );
  // Jev rounds to two places; the float noise it sometimes carries
  // (0.47000000000000003) is dropped here.
  return {
    got: answer.choice,
    p: round(answer.probabilities[answer.choice] ?? 0),
    confidence: round(answer.confidence),
    pAccepted: round(Math.min(1, pAccepted)),
    right: expected.includes(answer.choice),
  };
}

/**
 * Four places everywhere: enough to tell 110/124 from 109/124 and to keep
 * Jev's two-place probabilities exact, without float noise in a report.
 */
export function round(value: number, places = 4): number {
  return Number(value.toFixed(places));
}

/** Nearest-rank, as scripts/eval-dialog.mjs computes its TTFT percentiles. */
export function percentile(values: readonly number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

export interface Bin {
  from: number;
  to: number;
  n: number;
  meanP: number | null;
  accuracy: number | null;
  /** Wilson 95% on the bin's accuracy: a small bin is shown, not argued from. */
  accuracyCI95: [number, number] | null;
}
/**
 * Equal-width reliability bins over the chosen option's probability; the
 * last bin is closed so p = 1 lands in it. Errors are left out: they have no
 * probability to be calibrated.
 */
export function calibrationBins(
  rows: readonly { p: number; right: boolean }[],
  bins = 5,
): Bin[] {
  const out = Array.from({ length: bins }, (_, i) => ({
    from: round(i / bins, 2),
    to: round((i + 1) / bins, 2),
    n: 0,
    sumP: 0,
    right: 0,
  }));
  for (const row of rows) {
    const at = Math.min(bins - 1, Math.max(0, Math.floor(row.p * bins)));
    out[at].n++;
    out[at].sumP += row.p;
    if (row.right) out[at].right++;
  }
  return out.map((b) => {
    const ci = wilson(b.right, b.n);
    return {
      from: b.from,
      to: b.to,
      n: b.n,
      meanP: b.n ? round(b.sumP / b.n) : null,
      accuracy: b.n ? round(b.right / b.n) : null,
      accuracyCI95: ci ? [round(ci[0]), round(ci[1])] : null,
    };
  });
}
/** Expected calibration error: the count-weighted gap between p and accuracy. */
export function calibrationError(bins: readonly Bin[]): number {
  const total = bins.reduce((sum, b) => sum + b.n, 0);
  if (!total) return 0;
  return round(
    bins.reduce(
      (sum, b) =>
        b.n && b.meanP !== null && b.accuracy !== null
          ? sum + (b.n / total) * Math.abs(b.accuracy - b.meanP)
          : sum,
      0,
    ),
  );
}

export interface Threshold {
  threshold: number;
  /** Answered cases at or above the threshold. */
  n: number;
  /** n over every case attempted, errors included. */
  coverage: number;
  accuracy: number | null;
}
/**
 * Accuracy and coverage when only answers at or above a threshold are
 * acted on; the rest would fall back to the current path.
 */
export function atThreshold(
  rows: readonly Scored[],
  threshold: number,
  by: "p" | "confidence" = "p",
): Threshold {
  const kept = rows.filter((r) => !r.error && r[by] >= threshold);
  return {
    threshold,
    n: kept.length,
    coverage: rows.length ? round(kept.length / rows.length) : 0,
    accuracy: kept.length
      ? round(kept.filter((r) => r.right).length / kept.length)
      : null,
  };
}

/** Right answers out of cases; an error counts as wrong, as in eval-dialog. */
export function tally(rows: readonly { right: boolean }[]): {
  cases: number;
  right: number;
  accuracy: number;
} {
  const right = rows.filter((r) => r.right).length;
  return {
    cases: rows.length,
    right,
    accuracy: rows.length ? round(right / rows.length) : 0,
  };
}

export interface Summary {
  cases: number;
  answered: number;
  errors: number;
  errorCodes: Record<string, number>;
  right: number;
  /** Over every case attempted: an error counts as wrong, as in eval-dialog. */
  accuracy: number;
  accuracyCI95: [number, number] | null;
  accuracyAnswered: number | null;
  meanPAccepted: number | null;
  thresholds: Threshold[];
  confidenceThresholds: Threshold[];
  calibration: Bin[];
  calibrationError: number;
  /**
   * Warm calls only, on a connection an earlier call opened. A first voice
   * turn after idle pays for a new connection, which coldMs reports apart.
   */
  latencyMs: { p50: number; p95: number; max: number };
  coldMs: number[];
  inputTokens: number;
  cost: number;
}

export function summarize(
  rows: readonly Scored[],
  inputTokens = 0,
  thresholds: readonly number[] = [0.8, 0.9],
): Summary {
  const answered = rows.filter((r) => !r.error);
  const right = answered.filter((r) => r.right).length;
  const errorCodes: Record<string, number> = {};
  for (const r of rows)
    if (r.error) errorCodes[r.error] = (errorCodes[r.error] ?? 0) + 1;
  const timed = answered.filter(
    (r): r is Scored & { latencyMs: number } => r.latencyMs !== undefined,
  );
  const warm = timed.filter((r) => !r.cold).map((r) => r.latencyMs);
  const bins = calibrationBins(answered);
  const ci = wilson(right, rows.length);
  return {
    cases: rows.length,
    answered: answered.length,
    errors: rows.length - answered.length,
    errorCodes,
    right,
    accuracy: rows.length ? round(right / rows.length) : 0,
    accuracyCI95: ci ? [round(ci[0]), round(ci[1])] : null,
    accuracyAnswered: answered.length ? round(right / answered.length) : null,
    meanPAccepted: answered.length
      ? round(
          answered.reduce((sum, r) => sum + r.pAccepted, 0) / answered.length,
        )
      : null,
    thresholds: thresholds.map((t) => atThreshold(rows, t, "p")),
    confidenceThresholds: thresholds.map((t) =>
      atThreshold(rows, t, "confidence"),
    ),
    calibration: bins,
    calibrationError: calibrationError(bins),
    latencyMs: {
      p50: Math.round(percentile(warm, 0.5)),
      p95: Math.round(percentile(warm, 0.95)),
      max: Math.round(warm.length ? Math.max(...warm) : 0),
    },
    coldMs: timed.filter((r) => r.cold).map((r) => Math.round(r.latencyMs)),
    inputTokens,
    cost: round(
      rows.reduce((sum, r) => sum + r.cost, 0),
      6,
    ),
  };
}

/** Right answers out of cases, per fixture tag. */
export function byTag(
  rows: readonly Scored[],
): Record<string, { n: number; right: number }> {
  const out: Record<string, { n: number; right: number }> = {};
  for (const r of rows)
    for (const tag of r.tags) {
      const cell = (out[tag] ??= { n: 0, right: 0 });
      cell.n++;
      if (r.right) cell.right++;
    }
  return out;
}

/** "expected → got" counts for the wrong answers; expected is the first accepted. */
export function confusion(rows: readonly Scored[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows)
    if (!r.error && !r.right) {
      const key = `${r.expected.join("|")} -> ${r.got}`;
      out[key] = (out[key] ?? 0) + 1;
    }
  return out;
}

/** What `wouldRunReport` reads from a row: Jev's, a baseline model's or the router's. */
export type WouldRunRow = Pick<
  Scored,
  "id" | "right" | "mustNotRun" | "settled" | "plan" | "error"
>;
export interface WouldRun {
  /** mustNotRun cases whose plan would start, revise, replace or queue. */
  n: number;
  /** ...where the act itself was wrong. */
  actErrors: number;
  /**
   * ...where the fixture accepts the act, yet it runs: the user's words
   * point at untrusted text ("do what she asked") and pass grounding as
   * their own.
   */
  acceptedActs: number;
  /** ...on turns the router settles: they run whatever any model says. */
  routerSettled: number;
  /** n less routerSettled: the runs this model's act is responsible for. */
  modelAttributable: number;
  /** mustNotRun cases whose plan is unknown (a baseline without its act). */
  unknown: number;
  ids: {
    actErrors: string[];
    acceptedActs: string[];
    routerSettled: string[];
    unknown: string[];
  };
}

/**
 * Would-run counted one way for every column: the plan each act leads to on
 * the cases the fixture says must not run, split by whether the act was
 * wrong or accepted, with the router-settled ones marked.
 */
export function wouldRunReport(rows: readonly WouldRunRow[]): WouldRun {
  const guarded = rows.filter((r) => r.mustNotRun && !r.error);
  const runs = guarded.filter(
    (r) => typeof r.plan === "string" && RUN_KINDS.has(r.plan),
  );
  const ids = (list: readonly WouldRunRow[]) => list.map((r) => r.id);
  const settled = runs.filter((r) => r.settled);
  const unknown = guarded.filter((r) => r.plan === null);
  return {
    n: runs.length,
    actErrors: runs.filter((r) => !r.right).length,
    acceptedActs: runs.filter((r) => r.right).length,
    routerSettled: settled.length,
    modelAttributable: runs.length - settled.length,
    unknown: unknown.length,
    ids: {
      actErrors: ids(runs.filter((r) => !r.right)),
      acceptedActs: ids(runs.filter((r) => r.right)),
      routerSettled: ids(settled),
      unknown: ids(unknown),
    },
  };
}

/** The dialog report's safety block: task acts where the case says none may run. */
export function mustNotRunReport(
  rows: readonly Scored[],
  thresholds: readonly number[] = [0.8, 0.9],
): {
  cases: number;
  /** Jev chose start, revise, replace or queue. */
  taskActs: number;
  /** ...of which the fixture's accepted acts allow that act anyway. */
  taskActsAccepted: number;
  /** Task acts a confidence gate at each threshold would still let through. */
  taskActsAtOrAbove: { threshold: number; n: number }[];
  ids: string[];
  wouldRun: WouldRun;
} {
  const guarded = rows.filter((r) => r.mustNotRun && !r.error);
  const slips = guarded.filter(
    (r) => r.got && TASK_ACTS.has(r.got as DialogAct),
  );
  return {
    cases: rows.filter((r) => r.mustNotRun).length,
    taskActs: slips.length,
    taskActsAccepted: slips.filter((r) => r.expected.includes(r.got ?? ""))
      .length,
    taskActsAtOrAbove: thresholds.map((threshold) => ({
      threshold,
      n: slips.filter((r) => r.p >= threshold).length,
    })),
    ids: slips.map((r) => r.id),
    wouldRun: wouldRunReport(rows),
  };
}

/** The wrong answers, ids and labels only. */
export function wrongList(
  rows: readonly Scored[],
): { id: string; expected: string[]; got: string; p?: number }[] {
  return rows
    .filter((r) => !r.right)
    .map((r) =>
      r.error
        ? { id: r.id, expected: r.expected, got: `error:${r.error}` }
        : { id: r.id, expected: r.expected, got: r.got ?? "", p: r.p },
    );
}

// Across runs --------------------------------------------------------------

export interface Spread {
  mean: number;
  min: number;
  max: number;
}
/** Mean and range over runs; one run is not a variance estimate, only a point. */
export function spread(values: readonly number[]): Spread | null {
  if (!values.length) return null;
  return {
    mean: round(values.reduce((sum, v) => sum + v, 0) / values.length),
    min: round(Math.min(...values)),
    max: round(Math.max(...values)),
  };
}

/**
 * Cases whose answer changed between runs of the same question: the act (or
 * error) per run, and whether that moved the case between right and wrong.
 */
export function flips(
  runs: readonly (readonly Scored[])[],
): { id: string; got: string[]; rightChanged: boolean }[] {
  const got = new Map<string, string[]>();
  const right = new Map<string, boolean[]>();
  for (const rows of runs)
    for (const r of rows) {
      (got.get(r.id) ?? got.set(r.id, []).get(r.id)!).push(
        r.error ? `error:${r.error}` : (r.got ?? ""),
      );
      (right.get(r.id) ?? right.set(r.id, []).get(r.id)!).push(r.right);
    }
  return [...got]
    .filter(([, acts]) => new Set(acts).size > 1)
    .map(([id, acts]) => ({
      id,
      got: acts,
      rightChanged: new Set(right.get(id)).size > 1,
    }));
}

/**
 * How far the probabilities moved between runs: per case, the largest range
 * any option's probability covered. A threshold chosen from one run has to
 * survive this much drift.
 */
export function probabilityShift(runs: readonly (readonly Scored[])[]): {
  /** Cases answered in at least two runs. */
  cases: number;
  /** ...whose distribution moved at all. */
  moved: number;
  max: number;
} {
  const seen = new Map<string, Record<string, number>[]>();
  for (const rows of runs)
    for (const r of rows)
      if (!r.error && r.probabilities)
        (seen.get(r.id) ?? seen.set(r.id, []).get(r.id)!).push(r.probabilities);
  let cases = 0;
  let moved = 0;
  let max = 0;
  for (const list of seen.values()) {
    if (list.length < 2) continue;
    cases++;
    const options = new Set(list.flatMap((p) => Object.keys(p)));
    let shift = 0;
    for (const option of options) {
      const values = list.map((p) => p[option] ?? 0);
      shift = Math.max(shift, Math.max(...values) - Math.min(...values));
    }
    // Jev answers in hundredths: anything smaller is float noise.
    if (shift >= 0.005) moved++;
    max = Math.max(max, shift);
  }
  return { cases, moved, max: round(max) };
}

/**
 * Exact two-sided McNemar p for paired right/wrong outcomes on the same
 * cases: b cases only the first got right, c only the second. It sets one
 * model's cases against the other's, which an interval against a point value
 * does not.
 */
export function mcnemar(b: number, c: number): number {
  const n = b + c;
  if (!n) return 1;
  let coefficient = 1;
  let tail = 0;
  for (let i = 0; i <= Math.min(b, c); i++) {
    if (i > 0) coefficient = (coefficient * (n - i + 1)) / i;
    tail += coefficient;
  }
  return round(Math.min(1, (2 * tail) / 2 ** n));
}

// A baseline model's run ----------------------------------------------------

export interface BaselineCase {
  /** The act it chose, or null when the report does not say. */
  act: string | null;
  /** Whether that act was accepted, or null when the case is not covered. */
  right: boolean | null;
}
export interface Baseline {
  model: string | null;
  promptVersion: number | null;
  cases: Record<string, BaselineCase>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A baseline model's per-case acts from scripts/eval-dialog.mjs output, so
 * its would-run is counted the same way as Jev's. --verbose lines give every
 * act; without them the JSON report's wrong list gives the misses, and a
 * case it does not list was right, with its act known only when the case
 * accepts a single act. A format failure is a miss with no act: eval-dialog
 * lists it with the fixture's act as is (a bare string on a single-act case)
 * and prints no verbose line for it. Only ids and acts are read, never the
 * task or reply.
 */
export function readBaseline(
  text: string,
  cases: readonly DialogCase[],
): Baseline {
  // The report is the last thing eval-dialog prints, after any verbose lines.
  const at = text.startsWith("{\n") ? 0 : text.lastIndexOf("\n{\n") + 1;
  let report: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text.slice(at));
    if (!isRecord(parsed) || !Array.isArray(parsed.wrong)) throw new Error();
    report = parsed;
  } catch {
    throw new Error("not a scripts/eval-dialog.mjs report");
  }
  const ids = new Set(cases.map((c) => c.id));
  const verbose = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^(\S+): ([a-z]+)(?: \||$)/.exec(line);
    if (m && ids.has(m[1]) && (DIALOG_ACTS as readonly string[]).includes(m[2]))
      verbose.set(m[1], m[2]);
  }
  const missed = new Map<string, string>();
  let invalid = 0;
  for (const entry of report.wrong as unknown[]) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      typeof entry.got !== "string"
    )
      continue;
    // The other entries with a string `expected` ("no run", "grounded task")
    // are about the plan, not the act.
    const formatFailure = entry.got.startsWith("invalid:");
    if (formatFailure) invalid++;
    if (formatFailure || Array.isArray(entry.expected))
      missed.set(entry.id, entry.got);
  }
  // Unlisted means right only when every case was asked, none errored and
  // every format failure the report counts is listed.
  const complete =
    report.cases === cases.length &&
    report.errors === 0 &&
    report.formatFailures === invalid;
  const out: Record<string, BaselineCase> = {};
  for (const c of cases) {
    const accepted = acceptedActs(c);
    const act = verbose.get(c.id);
    const miss = missed.get(c.id);
    if (act) out[c.id] = { act, right: accepted.includes(act) };
    else if (miss !== undefined)
      out[c.id] = {
        act: miss.startsWith("invalid:") ? null : miss,
        right: false,
      };
    else if (complete)
      out[c.id] = {
        act: accepted.length === 1 ? accepted[0] : null,
        right: true,
      };
    else out[c.id] = { act: null, right: null };
  }
  return {
    model: typeof report.model === "string" ? report.model : null,
    promptVersion:
      typeof report.promptVersion === "number" ? report.promptVersion : null,
    cases: out,
  };
}

/**
 * The plan a baseline's answer leads to. When only "it was right" is known,
 * the plan is still known if every accepted act leads to the same one;
 * otherwise it is null and counted as unknown, never guessed.
 */
export function baselinePlan(
  c: DialogCase,
  answer: BaselineCase,
): string | null {
  if (answer.act !== null)
    return (DIALOG_ACTS as readonly string[]).includes(answer.act)
      ? plannedKind(c, answer.act as DialogAct)
      : null;
  if (answer.right !== true) return null;
  const plans = new Set(
    acceptedActs(c)
      .filter((act) => (DIALOG_ACTS as readonly string[]).includes(act))
      .map((act) => plannedKind(c, act as DialogAct)),
  );
  return plans.size === 1 ? [...plans][0] : null;
}
