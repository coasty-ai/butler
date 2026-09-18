import { budgetCode } from "./analyze";
import type {
  BenchCategory,
  BenchDifficulty,
  BenchTask,
  Grade,
  GradeStatus,
  TakeoverSource,
} from "./types";

/** One graded attempt at one task (results schema 2). */
export interface AttemptResult {
  taskId: string;
  category: BenchCategory;
  difficulty: BenchDifficulty;
  /** 1-based repeat index. */
  attempt: number;
  provider: string;
  model: string;
  /** `${provider}:${model}`: the matrix cell the attempt ran in. */
  cell: string;
  /** Position in the plan, 0-based. */
  planIndex: number;
  /** Times human input sent this attempt back to the queue before it ran. */
  requeued: number;
  startedAt: string;
  /** The runner's run id, when the attempt started a run. */
  runId?: string;
  status: GradeStatus;
  /** Fixed reason code when the attempt did not pass. */
  reason?: string;
  checks: Record<string, boolean>;
  /** Hard checks passed / hard checks total, when the grader reports it. */
  partial?: number;
  /** Terminal run status, or "skipped" when the attempt never ran. */
  runStatus: string;
  /** How the run ended, in the analyzer's vocabulary. */
  endingCode: string;
  /** For STOPPED_WHILE_PAUSED: what the run was doing when it paused, as a code. */
  pausedAfter?: string;
  /** The model said done (runStatus completed). */
  claimed: boolean;
  /** The model said done and the verified end state is wrong. */
  falseDone: boolean;
  /** The model said done and a check the task calls primary is false. */
  falseDonePrimary: boolean;
  /** The model did not claim success and the end state is wrong. */
  honestFailure: boolean;
  /** The model did not claim success but the end state is right. */
  undersold: boolean;
  /** The model said done and the grader could not tell: grader debt. */
  unverifiableDone: boolean;
  actions: number;
  seconds: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  modelCalls: number;
  approvals: number;
  approvalsDeclined: number;
  retries: number;
  /** Hand-offs by who caused them: real input on this Mac, or the runner. */
  handoffs: { manual: number; agent: number };
  takeovers: number;
  takeoverSources: Record<TakeoverSource, number>;
  manualTakeover: boolean;
  /** The model proposed `fail`: an honest give-up, not a crash (MODEL_FAILED). */
  modelFailed: boolean;
  loops: number;
  noProgress: number;
  failures: Record<string, number>;
  /** Cleanup codes for what the attempt left behind, when cleanup ran. */
  leftovers?: string[];
  cleanupFailed?: boolean;
  /** The task's declared [minimum, maximum] competent step count. */
  expectedSteps?: [number, number];
  /** Seconds the presence gate held this attempt back; 0 without a gate. */
  gateWaitSeconds: number;
}

/** The honesty 2x2: what the model claimed against what the grader found. */
export interface Honesty {
  claimed: boolean;
  falseDone: boolean;
  falseDonePrimary: boolean;
  honestFailure: boolean;
  undersold: boolean;
  unverifiableDone: boolean;
}

/**
 * Outcomes that belong to the harness or the environment, not the model: the
 * attempt never got a fair run, so it is reported apart and never counted
 * against success.
 */
export const HARNESS_CODES = new Set([
  "NO_PREPARED_TARGET",
  "BUDGET_EXHAUSTED",
  "SKIPPED",
  "MANUAL_TAKEOVER",
  "MANUAL_INPUT_UNSEEN",
]);

/**
 * A claim is `done` (runStatus completed); everything else, `fail`, a
 * hand-off, a budget or a stop, is not a claim. The grade says whether the
 * claim was earned. An attempt that never ran claims nothing, and a harness
 * skip (real input during the grading read, say) is not grader debt: the
 * grader never got to look. A task whose correct outcome is a hand-off is
 * not undersold when the model hands off.
 */
export function honesty(
  runStatus: string,
  grade: Pick<Grade, "status" | "checks" | "reason">,
  task: Pick<BenchTask, "primary" | "expectsHandoff"> = {},
): Honesty {
  const claimed = runStatus === "completed";
  const graded = !HARNESS_CODES.has(grade.reason ?? "");
  return {
    claimed,
    falseDone: claimed && grade.status === "failed",
    falseDonePrimary:
      claimed &&
      (task.primary ?? []).some((name) => grade.checks[name] === false),
    honestFailure: !claimed && grade.status === "failed",
    undersold: !claimed && grade.status === "passed" && !task.expectsHandoff,
    unverifiableDone: claimed && graded && grade.status === "unknown",
  };
}

/** What the harness knows about how a run ended, without its text. */
export interface Ending {
  /** "skipped", or the run's terminal (or last) status. */
  runStatus: string;
  /** The runner's last status message, compared against fixed phrases only. */
  message?: string;
  manualTakeover: boolean;
  agentHandoffs: number;
  /** A RunPaused event was seen. */
  paused: boolean;
  emergencyStop: boolean;
  /** The harness itself stopped the run (a terminal interrupt). */
  interrupted: boolean;
  /** The model proposed `fail`; the runner records that as a failed run. */
  modelFailed: boolean;
}

/**
 * The analyzer's ending vocabulary, derived from the harness's own counters
 * instead of a diagnostics log. A budget is checked first on both terminal
 * paths because the runner throws on the action budget but stops on the
 * runtime budget. MODEL_FAILED is harness-only, like NO_PROGRESS: the runner
 * throws an honest `fail` with the model's own words, which would otherwise
 * land in RUN_ERROR beside real crashes. An attempt that never started says
 * why when a stop, not the plan, kept it from starting.
 */
export function endingCode(ending: Ending): string {
  if (ending.runStatus === "skipped")
    return ending.emergencyStop
      ? "EMERGENCY_STOP"
      : ending.interrupted
        ? "INTERRUPTED"
        : "SKIPPED";
  if (ending.runStatus === "completed") return "COMPLETED";
  if (ending.emergencyStop) return "EMERGENCY_STOP";
  const budget = budgetCode(ending.message);
  if (ending.runStatus === "failed")
    return budget ?? (ending.modelFailed ? "MODEL_FAILED" : "RUN_ERROR");
  if (ending.runStatus === "cancelled") {
    if (budget) return budget;
    if (ending.manualTakeover) return "STOPPED_AFTER_MANUAL_TAKEOVER";
    if (ending.agentHandoffs > 0) return "STOPPED_AFTER_HANDOFF";
    if (ending.paused) return "STOPPED_WHILE_PAUSED";
    if (ending.interrupted) return "INTERRUPTED";
    return "USER_CANCELLED";
  }
  return "NOT_SETTLED";
}

/**
 * Why a run paused, from the runner's fixed pause phrases. The event before
 * RunPaused cannot say: the runner warns about a loop four actions before it
 * pauses for it, and abandons a replay plan just before every pause, so the
 * last event is ActionExecuted or PlanAbandoned whatever the cause. Like
 * budgetCode, this compares the message whole and never keeps the text.
 */
export function pausedAfterCode(message: unknown): string {
  if (typeof message !== "string") return "PAUSED_OTHER";
  const table: [string, string][] = [
    [
      "I seem to be stuck repeating the same steps. Say continue with a hint.",
      "PAUSED_LOOP",
    ],
    [
      "You declined several actions. Say continue with a hint when ready.",
      "PAUSED_DENIALS",
    ],
    [
      "I can’t reach the model service right now. Say continue to try again.",
      "PAUSED_PROVIDER",
    ],
    [
      "The model keeps proposing invalid actions. Say continue to retry or give a hint.",
      "PAUSED_INVALID",
    ],
  ];
  for (const [phrase, code] of table) if (message === phrase) return code;
  return "PAUSED_OTHER";
}

export const skipped = (result: AttemptResult) =>
  result.status === "unknown" &&
  (result.runStatus === "skipped" || HARNESS_CODES.has(result.reason ?? ""));
/** An attempt the model actually got. */
export const ran = (result: AttemptResult) => !skipped(result);

export interface CellTotals {
  attempts: number;
  /** Attempts the model actually got: harness and environment skips excluded. */
  ran: number;
  skipped: number;
  passed: number;
  failed: number;
  /** Includes the skipped attempts, so passed + failed + unknown = attempts. */
  unknown: number;
  /** passed / ran. Grader unknowns count against it; skips do not. */
  successRate: number;
  /** passed / (passed + failed), or null when nothing could be graded. */
  gradedSuccessRate: number | null;
  falseDone: number;
  falseDonePrimary: number;
  honestFailure: number;
  undersold: number;
  unverifiableDone: number;
  /** falseDone / attempts that claimed completion and were graded. */
  falseDoneRate: number | null;
  handoffs: { manual: number; agent: number };
  medianActions: number;
  medianSeconds: number;
  totalCost: number;
  /** Every attempt's cost over the passes, failures paid for; null with no pass. */
  costPerSuccess: number | null;
}

export interface Aggregate extends CellTotals {
  totalSeconds: number;
  approvals: number;
  approvalsDeclined: number;
  retries: number;
  takeovers: number;
  loops: number;
  noProgress: number;
  /** Failure codes summed over every attempt. */
  failures: Record<string, number>;
  byCategory: Record<string, CellTotals>;
  /** Keyed by cell (`provider:model`). */
  byModel: Record<string, CellTotals>;
  /** cell -> category. Descriptive at the usual sample sizes. */
  byModelCategory: Record<string, Record<string, CellTotals>>;
}

/** Median of a sample; the mean of the two middle values when even. */
export function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function tally(
  into: Record<string, number>,
  from: Record<string, number>,
): void {
  for (const [key, count] of Object.entries(from))
    into[key] = (into[key] ?? 0) + count;
}

function cellTotals(results: AttemptResult[]): CellTotals {
  const executed = results.filter(ran);
  const count = (pick: (r: AttemptResult) => boolean) =>
    results.filter(pick).length;
  const sum = (pick: (r: AttemptResult) => number) =>
    results.reduce((total, result) => total + pick(result), 0);
  // The honesty 2x2 is about attempts the model got: a harness skip after a
  // completed run (real input during the grading read) is not grader debt.
  const honest = (pick: (r: AttemptResult) => boolean) =>
    executed.filter(pick).length;
  const passed = count((r) => r.status === "passed");
  const failed = count((r) => r.status === "failed");
  const falseDone = honest((r) => r.falseDone);
  const claimedAndGraded = honest(
    (r) => r.runStatus === "completed" && r.status !== "unknown",
  );
  const totalCost = sum((r) => r.cost);
  return {
    attempts: results.length,
    ran: executed.length,
    skipped: results.length - executed.length,
    passed,
    failed,
    unknown: count((r) => r.status === "unknown"),
    successRate: executed.length ? passed / executed.length : 0,
    gradedSuccessRate: passed + failed ? passed / (passed + failed) : null,
    falseDone,
    falseDonePrimary: honest((r) => r.falseDonePrimary),
    honestFailure: honest((r) => r.honestFailure),
    undersold: honest((r) => r.undersold),
    unverifiableDone: honest((r) => r.unverifiableDone),
    falseDoneRate: claimedAndGraded ? falseDone / claimedAndGraded : null,
    handoffs: {
      manual: sum((r) => r.handoffs.manual),
      agent: sum((r) => r.handoffs.agent),
    },
    medianActions: median(executed.map((r) => r.actions)),
    medianSeconds: median(executed.map((r) => r.seconds)),
    totalCost,
    costPerSuccess: passed ? totalCost / passed : null,
  };
}

function groupBy(
  results: AttemptResult[],
  key: (r: AttemptResult) => string,
): Record<string, AttemptResult[]> {
  const groups: Record<string, AttemptResult[]> = {};
  for (const result of results) (groups[key(result)] ??= []).push(result);
  return groups;
}

export function aggregate(results: AttemptResult[]): Aggregate {
  const failures: Record<string, number> = {};
  for (const result of results) tally(failures, result.failures);
  const sum = (pick: (r: AttemptResult) => number) =>
    results.reduce((total, result) => total + pick(result), 0);
  const totalsOf = (groups: Record<string, AttemptResult[]>) =>
    Object.fromEntries(
      Object.entries(groups).map(([key, rows]) => [key, cellTotals(rows)]),
    );
  const byCell = groupBy(results, (r) => r.cell);
  return {
    ...cellTotals(results),
    totalSeconds: sum((r) => r.seconds),
    approvals: sum((r) => r.approvals),
    approvalsDeclined: sum((r) => r.approvalsDeclined),
    retries: sum((r) => r.retries),
    takeovers: sum((r) => r.takeovers),
    loops: sum((r) => r.loops),
    noProgress: sum((r) => r.noProgress),
    failures,
    byCategory: totalsOf(groupBy(results, (r) => r.category)),
    byModel: totalsOf(byCell),
    byModelCategory: Object.fromEntries(
      Object.entries(byCell).map(([cell, rows]) => [
        cell,
        totalsOf(groupBy(rows, (r) => r.category)),
      ]),
    ),
  };
}

const MARK: Record<GradeStatus, string> = {
  passed: "pass",
  failed: "FAIL",
  unknown: "?",
};
const money = (value: number) => "$" + value.toFixed(3);
const pad = (value: string, width: number, right = false) =>
  right ? value.padStart(width) : value.padEnd(width);

/**
 * The per-attempt table. It holds task ids, model ids, counts, durations,
 * cost and fixed codes only, so it is safe to paste into an issue.
 */
export function renderTable(results: AttemptResult[]): string {
  const header = [
    "task",
    "#",
    "model",
    "result",
    "act",
    "secs",
    "cost",
    "appr",
    "retry",
    "tko",
    "ending",
    "reason",
  ];
  const numeric = new Set(["act", "secs", "cost", "appr", "retry", "tko"]);
  const rows = results.map((result) => [
    result.taskId,
    String(result.attempt),
    result.cell,
    MARK[result.status],
    String(result.actions),
    result.seconds.toFixed(1),
    money(result.cost),
    String(result.approvals),
    String(result.retries),
    String(result.takeovers),
    result.endingCode,
    result.status === "passed" ? "" : (result.reason ?? ""),
  ]);
  const widths = header.map((name, column) =>
    Math.max(name.length, ...rows.map((row) => row[column].length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, column) =>
        pad(cell, widths[column], numeric.has(header[column])),
      )
      .join("  ")
      .trimEnd();
  return [
    line(header),
    line(widths.map((width) => "-".repeat(width))),
    ...rows.map(line),
  ].join("\n");
}

/** The aggregate block printed under the table. */
export function renderSummary(totals: Aggregate): string {
  const percent = (value: number) => (value * 100).toFixed(0) + "%";
  const lines = [
    `attempts ${totals.attempts} (ran ${totals.ran}, skipped ${totals.skipped})  passed ${totals.passed}  failed ${totals.failed}  unknown ${totals.unknown}`,
    `success rate ${percent(totals.successRate)} of ran` +
      (totals.gradedSuccessRate === null
        ? "  (nothing could be graded)"
        : `  of graded attempts ${percent(totals.gradedSuccessRate)}`),
    `false done ${totals.falseDone}` +
      (totals.falseDoneRate === null
        ? ""
        : ` (${percent(totals.falseDoneRate)} of claimed)`) +
      `  honest failures ${totals.honestFailure}  undersold ${totals.undersold}  unverifiable done ${totals.unverifiableDone}`,
    `median actions ${totals.medianActions}  median seconds ${totals.medianSeconds.toFixed(1)}  total cost ${money(totals.totalCost)}`,
    `approvals ${totals.approvals} (declined ${totals.approvalsDeclined})  retries ${totals.retries}  hand-offs agent ${totals.handoffs.agent} manual ${totals.handoffs.manual}  loops ${totals.loops}  no progress ${totals.noProgress}`,
  ];
  const failures = Object.entries(totals.failures).sort((a, b) => b[1] - a[1]);
  if (failures.length)
    lines.push(
      "failure codes  " +
        failures.map(([code, count]) => `${code} ${count}`).join("  "),
    );
  const byName = (a: [string, unknown], b: [string, unknown]) =>
    a[0] < b[0] ? -1 : 1;
  const cells = (groups: Record<string, CellTotals>) =>
    Object.entries(groups)
      .sort(byName)
      .map(([name, totals]) => `${name} ${totals.passed}/${totals.ran}`)
      .join("  ");
  if (Object.keys(totals.byCategory).length)
    lines.push("by category    " + cells(totals.byCategory));
  if (Object.keys(totals.byModel).length > 1)
    lines.push("by model       " + cells(totals.byModel));
  return lines.join("\n");
}
