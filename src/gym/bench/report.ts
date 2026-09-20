import { budgetCode } from "./analyze";
import type {
  BenchCategory,
  BenchDifficulty,
  BenchTask,
  Grade,
  GradeStatus,
  NoteRoute,
  TakeoverSource,
} from "./types";

/**
 * How one kind of policy question was answered during an attempt, keyed by
 * the question's code (src/core/approval-codes.ts approvalCode): how often it
 * was asked, and how the harness answered. asked = approved + declined.
 */
export interface ApprovalTally {
  asked: number;
  approved: number;
  declined: number;
}

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
  /**
   * The false parts of the check `reason` names, by fact name (`hour`,
   * `alert`, `row2`): which fact the note lacked, never what it was
   * (Grade.missingFacts). The table renders them as `FACT_NOT_NOTED(hour,alert)`.
   */
  missingFacts?: string[];
  /** For a note task: how the file came to hold its text (Grade.noteRoute). */
  noteRoute?: NoteRoute;
  /**
   * The grader's checks; a sub-check (`noted.hour`) says how one fact of a
   * composite check fared (graders.ts SUB_CHECK).
   */
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
  /** Of inputTokens, what the provider's prompt cache served, when it reports it. */
  cachedInputTokens?: number;
  modelCalls: number;
  approvals: number;
  approvalsDeclined: number;
  /**
   * The questions asked, by code (SAVE_CHANGES, PLACE_ORDER, CLICK_CONTROL,
   * ...), with how each was answered; absent when nothing was asked. Never
   * the question's text or the label it quoted.
   */
  approvalCodes?: Record<string, ApprovalTally>;
  retries: number;
  /**
   * Retries on a surface that reported no accessibility at all (the
   * analyzer's BLIND_SURFACE): an ide attempt whose every retry was blind
   * closes the category for the night (IDE_BLIND).
   */
  blindRetries?: number;
  /** Hand-offs by who caused them: real input on this Mac, or the runner. */
  handoffs: { manual: number; agent: number };
  takeovers: number;
  takeoverSources: Record<TakeoverSource, number>;
  manualTakeover: boolean;
  /** The model proposed `fail`: an honest give-up, not a crash (MODEL_FAILED). */
  modelFailed: boolean;
  loops: number;
  noProgress: number;
  /** Clicks by name the helper read as no effect on every route; absent when none. */
  clickNoEffect?: number;
  failures: Record<string, number>;
  /**
   * The dones the runner sent back, by why as a code (doneChallengeCode):
   * REFUSED_STEP for a claim after a step was declined or refused,
   * DELIVERABLE_UNCHANGED for a claim with the file the task asks to write
   * unchanged since the run began, REQUIREMENT_UNMET for a claim the done
   * audit (src/core/done-audit.ts) read against the objective's clauses
   * and found a requirement unmet. Absent when no done was challenged. With
   * the row's ending it says what became of the claim: COMPLETED is the
   * claim repeated (graded as any), MODEL_FAILED the claim withdrawn,
   * DELIVERABLE_MISSING the runner's own verdict at the second done.
   */
  doneChallenged?: Record<string, number>;
  /** Cleanup codes for what the attempt left behind, when cleanup ran. */
  leftovers?: string[];
  cleanupFailed?: boolean;
  /** An APPS_OPEN skip: the applications that were open, by bundle id. Never a window title. */
  openApps?: string[];
  /**
   * Documents the attempt saved outside ~/OpenAssistBench (TextEdit showed
   * them open after the attempt and not before), home-relative. The one
   * place a path is written: the harness never deletes a file outside the
   * bench folder, so the person needs the path to check it and delete it
   * themselves (LEFTOVER_STRAY_DOCUMENT among the leftovers).
   */
  strayDocuments?: string[];
  /**
   * Windows open after the attempt that were not before, by bundle id
   * (windows.ts). The final sweep closes the ones that hold nothing.
   */
  leftoverWindows?: Record<string, number>;
  /**
   * Fixture tabs the harness pointed at about:blank in the browser it chose
   * for the attempt, after it (browser-reset.ts): a sign-in page's focused
   * password field would otherwise hold secure event input for the whole
   * session and hand every later attempt off at once. `code` says why none
   * could be looked at. `quit` is set when the surface still named that
   * browser as holding secure event input after the reset (a blank tab keeps
   * the focused field's state until its window goes) and the harness quit
   * it, so the next attempt never meets the gate on it. Absent for an
   * attempt without a browser.
   */
  browserReset?: { tabs: number; code?: string; quit?: boolean };
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
/**
 * Task-level preflight skips (src/gym/bench/preflight.ts): this Mac could
 * not run the task tonight (no agenda grant, no local calendar source, the
 * hour around midnight, an application missing or already open, the fixture
 * port taken, leftovers from a crashed cycle, an editor the helper cannot
 * see). None of them says anything about the model, and a resume retries
 * every one of them.
 */
export const TASK_SKIPS = [
  "NO_AGENDA_ACCESS",
  "NO_LOCAL_SOURCE",
  "DAY_BOUNDARY",
  "APP_NOT_INSTALLED",
  "IDE_BLIND",
  "FIXTURE_PORT",
  "APPS_OPEN",
  "BENCH_ROOT_DIRTY",
] as const;
export type TaskSkip = (typeof TASK_SKIPS)[number];

export const HARNESS_CODES = new Set<string>([
  "NO_PREPARED_TARGET",
  "BUDGET_EXHAUSTED",
  "SKIPPED",
  "MANUAL_TAKEOVER",
  "MANUAL_INPUT_UNSEEN",
  ...TASK_SKIPS,
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

/**
 * Why the runner sent a done back, as the row's code: the journal's
 * `reason` on ActionFailed DONE_CHALLENGED (refused_step,
 * deliverable_unchanged, requirement_unmet) upper-cased, REFUSED_STEP for a journal from
 * before the reason was written, and OTHER for anything not shaped like a
 * code, so no sentence ever becomes a key.
 */
export function doneChallengeCode(reason: unknown): string {
  if (reason === undefined) return "REFUSED_STEP";
  return typeof reason === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(reason)
    ? reason.toUpperCase()
    : "OTHER";
}

/**
 * The runner's done checks over the attempts that ran: how many were sent
 * back and why, and what became of each challenged claim. `withdrawn` and
 * `failed` are the false dones the guard turned into honest failures;
 * `slipped` the claims repeated and graded wrong, still false dones.
 */
export interface DoneChallengeTotals {
  /** Challenges by reason code (doneChallengeCode), summed over attempts. */
  byReason: Record<string, number>;
  /** Attempts with at least one challenge. */
  attempts: number;
  /** ... whose model then said fail (MODEL_FAILED). */
  withdrawn: number;
  /** ... the runner failed at the second done (DELIVERABLE_MISSING). */
  failed: number;
  /** ... whose model repeated done and the grader found the end state right. */
  earned: number;
  /** ... whose model repeated done and the grader found it wrong (falseDone). */
  slipped: number;
}

export function doneChallengeTotals(
  results: AttemptResult[],
): DoneChallengeTotals {
  const byReason: Record<string, number> = {};
  const challenged = results.filter(
    (r) => ran(r) && r.doneChallenged && Object.keys(r.doneChallenged).length,
  );
  for (const result of challenged) tally(byReason, result.doneChallenged!);
  const count = (pick: (r: AttemptResult) => boolean) =>
    challenged.filter(pick).length;
  return {
    byReason,
    attempts: challenged.length,
    withdrawn: count((r) => r.endingCode === "MODEL_FAILED"),
    failed: count((r) => r.endingCode === "DELIVERABLE_MISSING"),
    earned: count((r) => r.claimed && r.status === "passed"),
    slipped: count((r) => r.falseDone),
  };
}

/**
 * "done challenged 3 (DELIVERABLE_UNCHANGED 2, REFUSED_STEP 1)  withdrawn 1
 * failed by runner 1  earned 0  slipped through 1", or undefined when no
 * done was sent back. Codes and counts only.
 */
export function doneChallengeLine(
  totals: DoneChallengeTotals,
): string | undefined {
  if (!totals.attempts) return undefined;
  const reasons = Object.entries(totals.byReason)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([code, count]) => `${code} ${count}`)
    .join(", ");
  return `done challenged ${totals.attempts} (${reasons})  withdrawn ${totals.withdrawn}  failed by runner ${totals.failed}  earned ${totals.earned}  slipped through ${totals.slipped}`;
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
  /**
   * The runner failed the run itself: a second done with the file the task
   * asks to write still unchanged (RunFailed DELIVERABLE_MISSING).
   */
  deliverableMissing?: boolean;
  /**
   * The runner failed the run itself: a done repeated after the done audit's
   * challenge with nothing but looks executed since (RunFailed
   * REQUIREMENTS_UNMET).
   */
  requirementsUnmet?: boolean;
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
    return (
      budget ??
      (ending.deliverableMissing
        ? "DELIVERABLE_MISSING"
        : ending.requirementsUnmet
          ? "REQUIREMENTS_UNMET"
          : ending.modelFailed
            ? "MODEL_FAILED"
            : "RUN_ERROR")
    );
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

/**
 * The reason as the table and the terminal print it: the code, and when the
 * failing check had parts, the missing ones in brackets,
 * `FACT_NOT_NOTED(hour,alert)`. Fact names only; "" for a row with no reason.
 */
export function reasonLabel(
  result: Pick<AttemptResult, "reason" | "missingFacts">,
): string {
  if (!result.reason) return "";
  const facts = result.missingFacts ?? [];
  return facts.length ? `${result.reason}(${facts.join(",")})` : result.reason;
}

/**
 * How often each fact was the missing one, over the attempts that did not
 * pass with a reason of `reason` (any reason when none is given): the class
 * table's contributors for a grade class, `hour 3, alert 2`.
 */
export function missingFactCounts(
  results: Pick<AttemptResult, "status" | "reason" | "missingFacts">[],
  reason?: string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const result of results) {
    if (result.status === "passed") continue;
    if (reason !== undefined && result.reason !== reason) continue;
    for (const fact of new Set(result.missingFacts ?? []))
      counts[fact] = (counts[fact] ?? 0) + 1;
  }
  return counts;
}
/** missingFactCounts rendered most common first, `["hour 3", "alert 2"]`, at most `limit`. */
export function factContributors(
  results: Pick<AttemptResult, "status" | "reason" | "missingFacts">[],
  reason: string,
  limit = 3,
): string[] {
  return Object.entries(missingFactCounts(results, reason))
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, limit)
    .map(([fact, count]) => `${fact} ${count}`);
}

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
  /** Every attempt's questions summed, by code. */
  approvalCodes: Record<string, ApprovalTally>;
  retries: number;
  takeovers: number;
  loops: number;
  noProgress: number;
  /** Clicks by name with no effect, summed over every attempt. */
  clickNoEffect: number;
  /** Failure codes summed over every attempt. */
  failures: Record<string, number>;
  /**
   * Facts a failed attempt's note lacked, by name, over attempts that did
   * not pass (missingFactCounts): `{hour: 3, alert: 2}`. Empty when no
   * attempt failed on a check with parts.
   */
  missingFacts: Record<string, number>;
  /** Note attempts that ran, by how the note was produced: tool, editor, none. */
  noteRoutes: Record<string, number>;
  /** Attempts that failed with a missing fact, by the note's route: the split of FACT_NOT_NOTED by route. */
  missingFactsByRoute: Record<string, number>;
  /** Cleanup codes, by the attempts that left each behind. */
  leftovers: Record<string, number>;
  /** Attempts whose cleanup threw. */
  cleanupFailed: number;
  /** The runner's done checks and what became of the challenged claims. */
  doneChallenged: DoneChallengeTotals;
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
  const leftovers: Record<string, number> = {};
  for (const result of results)
    for (const code of new Set(result.leftovers ?? []))
      leftovers[code] = (leftovers[code] ?? 0) + 1;
  const approvalCodes: Record<string, ApprovalTally> = {};
  for (const result of results)
    for (const [code, tally] of Object.entries(result.approvalCodes ?? {})) {
      const total = (approvalCodes[code] ??= {
        asked: 0,
        approved: 0,
        declined: 0,
      });
      total.asked += tally.asked;
      total.approved += tally.approved;
      total.declined += tally.declined;
    }
  const sum = (pick: (r: AttemptResult) => number) =>
    results.reduce((total, result) => total + pick(result), 0);
  const totalsOf = (groups: Record<string, AttemptResult[]>) =>
    Object.fromEntries(
      Object.entries(groups).map(([key, rows]) => [key, cellTotals(rows)]),
    );
  const byCell = groupBy(results, (r) => r.cell);
  const noteRoutes: Record<string, number> = {};
  const missingFactsByRoute: Record<string, number> = {};
  for (const result of results) {
    if (!result.noteRoute || !ran(result)) continue;
    noteRoutes[result.noteRoute] = (noteRoutes[result.noteRoute] ?? 0) + 1;
    if (result.status !== "passed" && result.missingFacts?.length)
      missingFactsByRoute[result.noteRoute] =
        (missingFactsByRoute[result.noteRoute] ?? 0) + 1;
  }
  return {
    ...cellTotals(results),
    totalSeconds: sum((r) => r.seconds),
    approvals: sum((r) => r.approvals),
    approvalsDeclined: sum((r) => r.approvalsDeclined),
    approvalCodes,
    retries: sum((r) => r.retries),
    takeovers: sum((r) => r.takeovers),
    loops: sum((r) => r.loops),
    noProgress: sum((r) => r.noProgress),
    clickNoEffect: sum((r) => r.clickNoEffect ?? 0),
    failures,
    missingFacts: missingFactCounts(results),
    noteRoutes,
    missingFactsByRoute,
    leftovers,
    cleanupFailed: results.filter((r) => r.cleanupFailed).length,
    doneChallenged: doneChallengeTotals(results),
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
 * "declined SAVE_CHANGES 15, CLICK_CONTROL 2": the questions an attempt was
 * refused, by code, most declined first; empty when none was. Codes only.
 */
export function declinedCodes(
  result: Pick<AttemptResult, "approvalCodes">,
): string {
  const declined = Object.entries(result.approvalCodes ?? {})
    .filter(([, tally]) => tally.declined > 0)
    .sort((a, b) => b[1].declined - a[1].declined || (a[0] < b[0] ? -1 : 1));
  if (!declined.length) return "";
  return (
    "declined " +
    declined.map(([code, tally]) => `${code} ${tally.declined}`).join(", ")
  );
}

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
    // A skip for an open application says which, and a failed attempt names
    // the questions it was refused, so the line is actionable.
    result.status === "passed"
      ? ""
      : [reasonLabel(result), ...(result.openApps ?? []), declinedCodes(result)]
          .join(" ")
          .trim(),
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

/**
 * "Leftovers LEFTOVER_FILES 1  LEFTOVER_EVENT 2  cleanup failed 1": what
 * cleanup could not remove, by the attempts that left it, or undefined when
 * every attempt cleaned up after itself. Codes only.
 */
export function leftoversLine(
  totals: Pick<Aggregate, "leftovers" | "cleanupFailed">,
): string | undefined {
  const codes = Object.entries(totals.leftovers).sort((a, b) =>
    a[0] < b[0] ? -1 : 1,
  );
  if (!codes.length && !totals.cleanupFailed) return undefined;
  return (
    "Leftovers  " +
    [
      ...codes.map(([code, count]) => `${code} ${count}`),
      ...(totals.cleanupFailed
        ? [`cleanup failed ${totals.cleanupFailed}`]
        : []),
    ].join("  ")
  );
}

/**
 * "missing facts  hour 3  alert 2  (by route: editor 4  tool 1)" and
 * "note routes  editor 6  tool 3  none 1": which facts the failed notes
 * lacked and how the notes were produced; undefined when no attempt wrote a
 * note. Names and counts only.
 */
export function factsLine(
  totals: Pick<
    Aggregate,
    "missingFacts" | "noteRoutes" | "missingFactsByRoute"
  >,
): string | undefined {
  const byCount = (a: [string, number], b: [string, number]) =>
    b[1] - a[1] || (a[0] < b[0] ? -1 : 1);
  const list = (record: Record<string, number>) =>
    Object.entries(record)
      .sort(byCount)
      .map(([name, count]) => `${name} ${count}`)
      .join("  ");
  const out: string[] = [];
  if (Object.keys(totals.missingFacts).length)
    out.push(
      `missing facts  ${list(totals.missingFacts)}` +
        (Object.keys(totals.missingFactsByRoute).length
          ? `  (by route: ${list(totals.missingFactsByRoute)})`
          : ""),
    );
  if (Object.keys(totals.noteRoutes).length)
    out.push(`note routes  ${list(totals.noteRoutes)}`);
  return out.length ? out.join("\n") : undefined;
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
    `approvals ${totals.approvals} (declined ${totals.approvalsDeclined})  retries ${totals.retries}  hand-offs agent ${totals.handoffs.agent} manual ${totals.handoffs.manual}  loops ${totals.loops}  no progress ${totals.noProgress}  clicks without effect ${totals.clickNoEffect}`,
  ];
  const failures = Object.entries(totals.failures).sort((a, b) => b[1] - a[1]);
  if (failures.length)
    lines.push(
      "failure codes  " +
        failures.map(([code, count]) => `${code} ${count}`).join("  "),
    );
  const facts = factsLine(totals);
  if (facts) lines.push(facts);
  const asked = Object.entries(totals.approvalCodes).sort(
    (a, b) => b[1].asked - a[1].asked || (a[0] < b[0] ? -1 : 1),
  );
  if (asked.length)
    lines.push(
      "approvals by reason  " +
        asked
          .map(
            ([code, tally]) =>
              `${code} asked ${tally.asked} declined ${tally.declined}`,
          )
          .join("  "),
    );
  const challenged = doneChallengeLine(totals.doneChallenged);
  if (challenged) lines.push(challenged);
  const line = leftoversLine(totals);
  if (line) lines.push(line);
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
