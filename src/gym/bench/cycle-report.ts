import { createHash } from "node:crypto";
import {
  APPROVAL_DECLINED_PREFIX,
  noteFor,
  ownerOf,
  type AnalysisReport,
} from "./analyze";
import {
  PROBE_INFORMATIONAL,
  compareModels,
  type ProbeReason,
  type ProbeVerdict,
  type Comparison,
  type ClassRate,
  type ComparableCycle,
  type ModelPair,
  type Regression,
  type StoredClass,
} from "./compare";
import {
  TASK_SKIPS,
  aggregate,
  factContributors,
  factsLine,
  median,
  ran,
  renderTable,
  type Aggregate,
  type ApprovalTally,
  type AttemptResult,
  type CellTotals,
} from "./report";
import { wilson } from "./stats";
import type { BenchTask } from "./types";
import { autonomyOf, type Autonomy } from "./cycle";

/**
 * results.json (schema 2) and report.md for one cycle. Every string in
 * either is a fixed code, an id, a bundle id, a task template or an ISO
 * timestamp, with one exception: a row's strayDocuments, the home-relative
 * paths of documents the attempt itself saved outside ~/OpenAssistBench,
 * which the harness never deletes and a person needs in order to. The test
 * feeds a run whose every free-text field carries a marker and asserts it
 * never appears here.
 */

/** Bumped when the meaning of a results.json field changes. */
export const HARNESS_VERSION = "1";

export interface CycleTaskInfo {
  id: string;
  category: string;
  difficulty: string;
  maxCost: number;
  maxActions: number;
  maxSeconds: number;
  /** Template only; a filled instruction can name one of the user's files. */
  instruction: string;
  verifies: string;
  suite: string;
}

export interface GateWaits {
  count: number;
  totalSeconds: number;
  byReason: Record<string, number>;
  longestSeconds: number;
  userPresentLong: number;
}

export interface CycleInfo {
  id: string;
  startedAt: string;
  finishedAt?: string;
  gitRev: string;
  gitBranch: string;
  dirty: boolean;
  host: { macos: string; arch: string };
  matrix: {
    provider: string;
    model: string;
    inputPrice: number;
    outputPrice: number;
  }[];
  /**
   * The model every run's done audit ran on (`--audit-model`), of the
   * cells' own provider; absent when each audit ran on its cell's model.
   */
  auditModel?: string;
  tasks: CycleTaskInfo[];
  repeat: number;
  seed: number;
  shard?: string;
  planHash: string;
  /** The plan's attempts without their order: cycles of one design pair. */
  designHash: string;
  /** sha256 of the task templates and the grader source. */
  catalogueHash: string;
  caps: {
    cycle: number;
    run: number;
    model: number;
    timeBoxSeconds: number;
    idleSeconds: number;
  };
  flags: {
    approveRoutine: boolean;
    stopOnHandoff: boolean;
    memory: boolean;
    requeue: number;
    /**
     * The Settings pane's Autonomy the attempts ran under (`--autonomy`);
     * absent on cycles from before the flag, which ran the default, "task".
     */
    autonomy?: Autonomy;
  };
  stoppedBecause?: string;
  gateWaits: GateWaits;
  /** smoke, long or all; absent on cycles from before suites. */
  suite?: string;
  /** A probe cycle: the class it tests and the baseline it answers to. */
  probe?: { code: string; baseline: string };
}

export interface FailureClass {
  rank: number;
  code: string;
  source: "grade" | "ending" | "friction";
  owner: string;
  /**
   * Attempts that ran and did not pass with the class in them, and their
   * share of ran attempts. A friction in a passing run is not a failure.
   */
  attempts: number;
  attemptRate: number;
  /** Passing attempts the class also appeared in: descriptive only. */
  passedAttempts: number;
  wilson95: [number, number];
  events: number;
  byModel: Record<string, { attempts: number; rate: number }>;
  byCategory: Record<string, { attempts: number; rate: number }>;
  contributors: string[];
  /** At most three run ids, resolvable in the cycle's own diagnostics log. */
  examples: {
    runId: string;
    cell: string;
    taskId: string;
    attempt: number;
    at: string;
  }[];
  note: string;
}

export interface CycleResults {
  schema_version: 2;
  harnessVersion: string;
  cycle: CycleInfo;
  results: AttemptResult[];
  aggregate: Aggregate;
  failureClasses: FailureClass[];
  baseline?: { cycleIds: string[]; gitRev: string; pooled: boolean };
  comparison?: Comparison;
  regressions: Regression[];
  modelComparison: ModelPair[];
  /** A probe cycle's verdict against its baseline (compare.ts compareProbe). */
  probe?: {
    code: string;
    pass: boolean;
    reasons: ProbeReason[];
    before: { k: number; n: number; rate: number };
    after: { k: number; n: number; rate: number };
    p: number;
  };
}

/**
 * The source files a task set's grades depend on, relative to the checkout:
 * the grader primitives for any task, each suite's catalogue for its own
 * tasks, the long catalogue for the market suite as well (its budgets,
 * marker rules, text fixtures and agenda helpers are what the market graders
 * are built from), and for the long and market suites the readers that
 * produce their evidence and the fixture pages they read (the market suite's
 * own pages build on the long suite's). A smoke cycle's hash then moves with
 * smoke code only, and a smoke, a long, a market and a mixed cycle never
 * share a hash, so a baseline never crosses suites.
 */
export function graderFiles(tasks: Pick<BenchTask, "suite">[]): string[] {
  const files = ["src/gym/bench/graders.ts"];
  const suites = new Set(tasks.map((task) => task.suite ?? "smoke"));
  if (suites.has("smoke")) files.push("src/gym/bench/catalogue.ts");
  if (suites.has("long") || suites.has("market"))
    files.push("src/gym/bench/catalogue-long.ts");
  if (suites.has("market"))
    files.push(
      "src/gym/bench/catalogue-market.ts",
      "src/gym/bench/fixtures-market.ts",
    );
  if (suites.has("long") || suites.has("market"))
    files.push("src/gym/bench/fixtures.ts", "src/gym/bench/readers.ts");
  return files;
}

/** The metric's identity: task templates and grader source, hashed. */
export function catalogueHash(
  tasks: Pick<
    BenchTask,
    | "id"
    | "instruction"
    | "verifies"
    | "maxCost"
    | "maxActions"
    | "maxSeconds"
    | "primary"
    | "evidence"
    | "expectsHandoff"
    | "approve"
  >[],
  graderSources: string[],
): string {
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify(
      tasks.map((task) => ({
        id: task.id,
        instruction: task.instruction,
        verifies: task.verifies,
        maxCost: task.maxCost,
        maxActions: task.maxActions,
        maxSeconds: task.maxSeconds,
        primary: task.primary ?? null,
        evidence: task.evidence ?? null,
        expectsHandoff: task.expectsHandoff ?? false,
        approve: task.approve ?? null,
      })),
    ),
  );
  for (const source of graderSources) hash.update("\n--\n").update(source);
  return hash.digest("hex");
}

/* ------------------------------------------------------- failure classes */

/** ActionFailed codes in the analyzer's friction vocabulary. */
const FAILURE_FRICTION: Record<string, string> = {
  STATE_CHANGED: "SCREEN_CHANGED",
  MALFORMED_RESPONSE: "MALFORMED_RESPONSE",
  REFUSED: "MODEL_REFUSED",
};

const CODE = /^[A-Z][A-Z0-9_]*$/;

type Contribution = { source: FailureClass["source"]; events: number };

/**
 * The codes one attempt contributes, by source. Without the cycle's
 * diagnostics the row's own counters stand in for friction; with them the
 * analyzer's per-run codes are richer (BLIND_SURFACE, PROVIDER_*, ...).
 */
function attemptCodes(
  result: AttemptResult,
  analysis?: AnalysisReport,
): Map<string, Contribution> {
  const codes = new Map<string, Contribution>();
  const add = (
    code: string | undefined,
    source: FailureClass["source"],
    events = 1,
  ) => {
    if (!code || !CODE.test(code) || codes.has(code)) return;
    codes.set(code, { source, events });
  };
  if (result.status !== "passed") add(result.reason, "grade");
  if (result.endingCode !== "COMPLETED") add(result.endingCode, "ending");
  const logged = analysis?.perRun.find((run) => run.runId === result.runId);
  if (logged)
    for (const [code, events] of Object.entries(logged.frictions))
      add(code, "friction", events);
  else {
    for (const [code, events] of Object.entries(result.failures))
      add(FAILURE_FRICTION[code] ?? code, "friction", events);
    if (result.loops) add("ACTION_LOOP", "friction", result.loops);
    if (result.retries) add("UNIDENTIFIED_TARGET", "friction", result.retries);
    if (result.approvalsDeclined)
      add("APPROVAL_DECLINED", "friction", result.approvalsDeclined);
  }
  // The questions declined, by the policy's question as a code: from the
  // row with or without the log, since the attempt answered each one itself
  // and knows exactly what it was. APPROVAL_DECLINED keeps its own count.
  for (const [code, tally] of Object.entries(result.approvalCodes ?? {}))
    if (tally.declined)
      add(`${APPROVAL_DECLINED_PREFIX}${code}`, "friction", tally.declined);
  // Harness-only codes the analyzer does not classify.
  if (result.noProgress) add("NO_PROGRESS", "friction", result.noProgress);
  // A click by name the helper read as no effect on every route: the same
  // count the analyzer takes from the executed rows when the log has them.
  if (result.clickNoEffect)
    add("CLICK_NO_EFFECT", "friction", result.clickNoEffect);
  if (result.falseDone) add("FALSE_DONE", "friction");
  if (result.modelFailed) add("MODEL_FAILED", "friction");
  // The runner's check of a done against the task's file, from the row
  // (the analyzer reads the same from the log's reason when it has one).
  const deliverable = result.doneChallenged?.DELIVERABLE_UNCHANGED;
  if (deliverable) add("DONE_CHALLENGED_DELIVERABLE", "friction", deliverable);
  return codes;
}

/**
 * A cycle's class rates over some of its cells, in the shape compare.ts
 * consumes. The stored classes (results.json's, or the current cycle's built
 * with its analysis) carry the analyzer's frictions, PROVIDER_* among them,
 * which the rows alone cannot rebuild; without them the rows stand in.
 */
export function classRates(
  cycle: Pick<ComparableCycle, "results" | "failureClasses">,
  cells: string[],
): ClassRate[] {
  const rows = cycle.results.filter((row) => cells.includes(row.cell));
  const executed = rows.filter(ran).length;
  const stored: StoredClass[] = cycle.failureClasses ?? failureClasses(rows);
  return stored
    .map((row) => ({
      code: row.code,
      attempts: cells.reduce(
        (sum, cell) => sum + (row.byModel[cell]?.attempts ?? 0),
        0,
      ),
      ran: executed,
    }))
    .filter((row) => row.attempts > 0);
}

/**
 * Class rates for a probe (compare.ts compareProbe). Every class comes from
 * the rows, on both sides alike, except the class under test, which keeps
 * its stored count: the analyzer's frictions (BLIND_SURFACE and the like)
 * live only in a cycle's stored classes. A stored per-model count cannot be
 * cut down to the probe's tasks, but a probe runs every category the class
 * appeared in, so all of the class's attempts are inside it.
 */
export function probeClassRates(code: string) {
  return (
    cycle: Pick<ComparableCycle, "results" | "failureClasses">,
    cells: string[],
  ): ClassRate[] => {
    const fromRows = classRates({ results: cycle.results }, cells);
    const stored = cycle.failureClasses?.find((row) => row.code === code);
    if (!stored) return fromRows;
    const attempts = cells.reduce(
      (sum, cell) => sum + (stored.byModel[cell]?.attempts ?? 0),
      0,
    );
    const executed = cycle.results.filter(
      (row) => cells.includes(row.cell) && ran(row),
    ).length;
    return [
      ...fromRows.filter((row) => row.code !== code),
      ...(attempts ? [{ code, attempts, ran: executed }] : []),
    ];
  };
}

/** Whether a probe's tasks are still the ones its baseline ran, template for template. */
export function sameTemplates(
  baseline: CycleTaskInfo[],
  current: CycleTaskInfo[],
): boolean {
  const key = (task: CycleTaskInfo) =>
    JSON.stringify([
      task.instruction,
      task.verifies,
      task.maxCost,
      task.maxActions,
      task.maxSeconds,
    ]);
  const before = new Map(baseline.map((task) => [task.id, key(task)]));
  return current.every((task) => before.get(task.id) === key(task));
}

/**
 * Grade reasons, endings and frictions merged into one ranked list. Rank
 * key: failed attempts affected, then events. Only attempts the model got
 * count (a harness skip is listed under unknowns instead), and only those
 * that did not pass: a class that shows up mostly in passing runs is not
 * what a fix lane should chase first.
 */
export function failureClasses(
  results: AttemptResult[],
  analysis?: AnalysisReport,
): FailureClass[] {
  const executed = results.filter(ran);
  const byCell = new Map<string, number>();
  const byCategory = new Map<string, number>();
  for (const row of executed) {
    byCell.set(row.cell, (byCell.get(row.cell) ?? 0) + 1);
    byCategory.set(row.category, (byCategory.get(row.category) ?? 0) + 1);
  }
  const classes = new Map<
    string,
    {
      source: FailureClass["source"];
      attempts: number;
      passedAttempts: number;
      events: number;
      cells: Map<string, number>;
      categories: Map<string, number>;
      examples: FailureClass["examples"];
    }
  >();
  for (const row of executed) {
    for (const [code, { source, events }] of attemptCodes(row, analysis)) {
      let entry = classes.get(code);
      if (!entry) {
        entry = {
          source,
          attempts: 0,
          passedAttempts: 0,
          events: 0,
          cells: new Map(),
          categories: new Map(),
          examples: [],
        };
        classes.set(code, entry);
      }
      if (row.status === "passed") {
        entry.passedAttempts++;
        continue;
      }
      entry.attempts++;
      entry.events += events;
      entry.cells.set(row.cell, (entry.cells.get(row.cell) ?? 0) + 1);
      entry.categories.set(
        row.category,
        (entry.categories.get(row.category) ?? 0) + 1,
      );
      if (entry.examples.length < 3 && row.runId)
        entry.examples.push({
          runId: row.runId,
          cell: row.cell,
          taskId: row.taskId,
          attempt: row.attempt,
          at: row.startedAt,
        });
    }
  }
  const share = (counts: Map<string, number>, totals: Map<string, number>) =>
    Object.fromEntries(
      [...counts.entries()].map(([key, attempts]) => [
        key,
        { attempts, rate: attempts / (totals.get(key) ?? 1) },
      ]),
    );
  return [...classes.entries()]
    .filter(([, entry]) => entry.attempts > 0)
    .sort(
      (a, b) =>
        b[1].attempts - a[1].attempts ||
        b[1].events - a[1].events ||
        (a[0] < b[0] ? -1 : 1),
    )
    .map(([code, entry], index) => ({
      rank: index + 1,
      code,
      source: entry.source,
      owner: ownerOf(code),
      attempts: entry.attempts,
      attemptRate: executed.length ? entry.attempts / executed.length : 0,
      passedAttempts: entry.passedAttempts,
      wilson95: wilson(entry.attempts, executed.length),
      events: entry.events,
      byModel: share(entry.cells, byCell),
      byCategory: share(entry.categories, byCategory),
      // A grade class's contributors are the facts its failed notes lacked,
      // by name (`hour 3, alert 2`), from the rows; the analyzer's
      // frictions inside the runs stand for every other class.
      contributors:
        (entry.source === "grade" && factContributors(executed, code)) ||
        analysis?.fixNext.find((item) => item.code === code)?.contributors ||
        [],
      examples: entry.examples,
      note: noteOf(code, entry.source),
    }));
}

/**
 * The authored note for a class. A grade reason is the task's own check
 * name, so without a note of its own it points there rather than borrowing
 * the analyzer's "unrecognizable ending" line.
 */
function noteOf(code: string, source: FailureClass["source"]): string {
  const note = noteFor(code);
  if (source === "grade" && note === noteFor("UNCLASSIFIED"))
    return "The first check the task's grader found false; see the task's verifies line.";
  return note;
}

/* --------------------------------------------------------------- results */

export interface CycleInput {
  cycle: CycleInfo;
  results: AttemptResult[];
  analysis?: AnalysisReport;
  baseline?: { cycles: ComparableCycle[]; comparison: Comparison };
  probe?: ProbeVerdict;
}

export function comparable(
  cycle: CycleInfo,
  results: AttemptResult[],
  failureClasses?: StoredClass[],
): ComparableCycle {
  return {
    id: cycle.id,
    gitRev: cycle.gitRev,
    catalogueHash: cycle.catalogueHash,
    planHash: cycle.planHash,
    designHash: cycle.designHash,
    ...(cycle.shard ? { shard: cycle.shard } : {}),
    dirty: cycle.dirty,
    startedAt: cycle.startedAt,
    finishedAt: cycle.finishedAt,
    stoppedBecause: cycle.stoppedBecause,
    taskIds: cycle.tasks.map((task) => task.id),
    cells: cycle.matrix.map((cell) => `${cell.provider}:${cell.model}`),
    results,
    ...(failureClasses ? { failureClasses } : {}),
  };
}

/** A check name, or a sub-check's `<check>.<fact>` (graders.ts SUB_CHECK). */
const CHECK = /^[A-Za-z][A-Za-z0-9_]{0,39}(\.[A-Za-z][A-Za-z0-9_]{0,39})?$/;
/** A fact name in missingFacts: the grader's constant, never a value. */
const FACT = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const NOTE_ROUTES = new Set(["tool", "editor", "none"]);
/** A bundle id, the one thing an APPS_OPEN row names: no path, no title. */
const BUNDLE_ID = /^[A-Za-z0-9.-]{1,120}$/;
/**
 * A path as windows.ts writes one: home-relative or absolute, one line, no
 * control character. The only field that may carry one (strayDocuments).
 */
const PATH = /^(~|\/)[^ -]{0,1000}$/;
const RUN_ID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const codeOnly = (value: string | undefined) =>
  value !== undefined && CODE.test(value) ? value : undefined;
const keysOnly = <T>(record: Record<string, T>, shape: RegExp) =>
  Object.fromEntries(Object.entries(record).filter(([key]) => shape.test(key)));
const tallyCount = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;
/** Approval tallies under a code key with three whole counts; anything else is dropped. */
const talliesOnly = (
  record: Record<string, ApprovalTally>,
): Record<string, ApprovalTally> =>
  Object.fromEntries(
    Object.entries(record)
      .filter(
        ([key, tally]) =>
          CODE.test(key) &&
          !!tally &&
          typeof tally === "object" &&
          [tally.asked, tally.approved, tally.declined].every(tallyCount),
      )
      .map(([key, tally]) => [
        key,
        {
          asked: tally.asked,
          approved: tally.approved,
          declined: tally.declined,
        },
      ]),
  );

/**
 * A row reduced to what may leave the machine. Every field is built from
 * codes already, so this changes nothing for a well-behaved attempt; it is
 * the writer's own guarantee that a reason, a failure key or a leftover that
 * somehow carried text is dropped rather than published.
 */
export function contentFree(row: AttemptResult): AttemptResult {
  const reason = codeOnly(row.reason);
  const pausedAfter = codeOnly(row.pausedAfter);
  const runId =
    row.runId !== undefined && RUN_ID.test(row.runId) ? row.runId : undefined;
  const leftovers = row.leftovers?.filter((code) => CODE.test(code));
  const openApps = row.openApps?.filter((id) => BUNDLE_ID.test(id));
  const strayDocuments = row.strayDocuments?.filter((path) => PATH.test(path));
  const leftoverWindows = row.leftoverWindows
    ? Object.fromEntries(
        Object.entries(row.leftoverWindows).filter(
          ([id, n]) =>
            BUNDLE_ID.test(id) && Number.isSafeInteger(n) && (n as number) > 0,
        ),
      )
    : undefined;
  const approvalCodes = row.approvalCodes && talliesOnly(row.approvalCodes);
  // The runner's done checks: code keys with whole counts, never a reason's
  // words (attempt.ts already maps a sentence to OTHER).
  const doneChallenged = row.doneChallenged
    ? Object.fromEntries(
        Object.entries(row.doneChallenged).filter(
          ([code, n]) => CODE.test(code) && tallyCount(n) && n > 0,
        ),
      )
    : undefined;
  // A count, at most a fixed code, and whether the browser was quit: never
  // a URL or a title.
  const browserReset =
    row.browserReset &&
    Number.isSafeInteger(row.browserReset.tabs) &&
    row.browserReset.tabs >= 0 &&
    (row.browserReset.code === undefined || CODE.test(row.browserReset.code))
      ? {
          tabs: row.browserReset.tabs,
          ...(row.browserReset.code ? { code: row.browserReset.code } : {}),
          ...(row.browserReset.quit === true ? { quit: true } : {}),
        }
      : undefined;
  // Which facts a failed note lacked and how it was written: names from a
  // fixed list, and one of three routes.
  const missingFacts = row.missingFacts?.filter(
    (fact) => typeof fact === "string" && FACT.test(fact),
  );
  const noteRoute =
    row.noteRoute && NOTE_ROUTES.has(row.noteRoute) ? row.noteRoute : undefined;
  const {
    reason: _r,
    pausedAfter: _p,
    runId: _i,
    leftovers: _l,
    openApps: _a,
    strayDocuments: _s,
    leftoverWindows: _w,
    approvalCodes: _c,
    browserReset: _b,
    doneChallenged: _d,
    missingFacts: _f,
    noteRoute: _n,
    ...rest
  } = row;
  return {
    ...rest,
    ...(runId ? { runId } : {}),
    ...(missingFacts?.length ? { missingFacts } : {}),
    ...(noteRoute ? { noteRoute } : {}),
    ...(doneChallenged && Object.keys(doneChallenged).length
      ? { doneChallenged }
      : {}),
    ...(reason ? { reason } : {}),
    ...(pausedAfter ? { pausedAfter } : {}),
    ...(leftovers?.length ? { leftovers } : {}),
    ...(openApps?.length ? { openApps } : {}),
    ...(strayDocuments?.length ? { strayDocuments } : {}),
    ...(leftoverWindows && Object.keys(leftoverWindows).length
      ? { leftoverWindows }
      : {}),
    ...(browserReset ? { browserReset } : {}),
    ...(approvalCodes && Object.keys(approvalCodes).length
      ? { approvalCodes }
      : {}),
    endingCode: codeOnly(row.endingCode) ?? "UNCLASSIFIED",
    checks: keysOnly(row.checks, CHECK),
    failures: keysOnly(row.failures, CODE),
  };
}

export function buildCycleResults(input: CycleInput): CycleResults {
  const comparison = input.baseline?.comparison;
  const results = input.results.map(contentFree);
  return {
    schema_version: 2,
    harnessVersion: HARNESS_VERSION,
    cycle: input.cycle,
    results,
    aggregate: aggregate(results),
    failureClasses: failureClasses(results, input.analysis),
    ...(input.baseline && comparison
      ? {
          baseline: {
            cycleIds: comparison.baselineIds,
            gitRev: input.baseline.cycles[0]?.gitRev ?? input.cycle.gitRev,
            pooled: input.baseline.cycles.length > 1,
          },
          comparison,
        }
      : {}),
    regressions: comparison?.regressions ?? [],
    modelComparison: compareModels(results),
    ...(input.probe
      ? {
          probe: {
            code: input.probe.code,
            pass: input.probe.pass,
            reasons: input.probe.reasons,
            before: input.probe.before,
            after: input.probe.after,
            p: input.probe.p,
          },
        }
      : {}),
  };
}

/* ---------------------------------------------------------------- report */

const percent = (value: number | null) =>
  value === null ? "n/a" : `${Math.round(value * 100)}%`;
const points = (value: number) =>
  `${value >= 0 ? "+" : ""}${Math.round(value * 100)}`;
const interval = ([lo, hi]: [number, number]) =>
  `[${Math.round(lo * 100)}, ${Math.round(hi * 100)}]`;
const money = (value: number | null) =>
  value === null ? "n/a" : `$${value.toFixed(3)}`;
const pValue = (p: number) =>
  Number.isNaN(p) ? "" : p < 0.001 ? "<0.001" : p.toFixed(3);

/**
 * The probe's verdict on one line, for the report's header and the
 * terminal: the verdict, the probed class before and now, each compared
 * model's success before and now, then the reasons that failed it and last
 * the informational ones (PROBE_INFORMATIONAL), each with its key and, for
 * NOW_GRADED, the task ids the class rose on.
 */
export function probeLine(
  probe: Pick<
    ProbeVerdict,
    "code" | "pass" | "reasons" | "before" | "after" | "p"
  >,
  regressions: Regression[],
  baseline?: string,
): string {
  const reason = (r: ProbeReason) =>
    `${r.code}${r.key ? ` ${r.key}` : ""}${r.tasks?.length ? ` (${r.tasks.join(", ")})` : ""}`;
  const failing = probe.reasons.filter((r) => !PROBE_INFORMATIONAL.has(r.code));
  const noted = probe.reasons.filter((r) => PROBE_INFORMATIONAL.has(r.code));
  return [
    `probe ${probe.code} against ${baseline ?? "its baseline"}: ${probe.pass ? "pass" : "FAIL"}`,
    `class ${probe.before.k}/${probe.before.n} before, ${probe.after.k}/${probe.after.n} now (one-sided p ${pValue(probe.p)})`,
    ...regressions
      .filter((row) => row.scope === "model")
      .map(
        (row) =>
          `success ${row.key} ${row.before.k}/${row.before.n} before, ${row.after.k}/${row.after.n} now (${points(row.delta)} pts, p ${pValue(row.p)}, ${row.verdict})`,
      ),
    ...(failing.length ? [failing.map(reason).join(", ")] : []),
    ...(noted.length ? [`informational: ${noted.map(reason).join(", ")}`] : []),
  ].join(" · ");
}

/**
 * The regime a cycle's numbers were measured under, for its header, the dry
 * run and the start banner: the autonomy mode and what became of the
 * policy's questions. Under "task" (the default), "ask" and "flow" the
 * unattended harness answers every question itself, declining all of them
 * unless `--approve-routine` approves the ones a task lists; under "all"
 * (the owner's regime, acknowledged) the policy asks none but the
 * protected-website question and its floors, which are still declined.
 */
export function autonomyLine(flags: {
  autonomy?: string;
  approveRoutine: boolean;
}): string {
  const mode = autonomyOf(flags);
  if (mode === "all") return "all (never asks; only protected sites refused)";
  return `${mode} (${flags.approveRoutine ? "routine prompts approved, the rest declined" : "every prompt declined"})`;
}

/** `67% [35, 88] n=9`, bold at n >= 30 and italic below 12 (descriptive only). */
function rateCell(totals: CellTotals | undefined): string {
  if (!totals || !totals.ran) return "-";
  const text = `${percent(totals.successRate)} ${interval(wilson(totals.passed, totals.ran))} n=${totals.ran}`;
  if (totals.ran >= 30) return `**${text}**`;
  if (totals.ran < 12) return `_${text}_`;
  return text;
}

function table(header: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join(
    "\n",
  );
}

/** The honesty 2x2 for one set of rows: what was claimed against what was found. */
export function honestyCells(results: AttemptResult[]) {
  const executed = results.filter(ran);
  const count = (pick: (r: AttemptResult) => boolean) =>
    executed.filter(pick).length;
  const earned = count((r) => r.claimed && r.status === "passed");
  const falseDone = count((r) => r.falseDone);
  const claimedAndGraded = count((r) => r.claimed && r.status !== "unknown");
  return {
    earned,
    falseDone,
    honestFailure: count((r) => r.honestFailure),
    undersold: count((r) => r.undersold),
    unverifiableDone: count((r) => r.unverifiableDone),
    claimedAndGraded,
    falseDoneRate: claimedAndGraded ? falseDone / claimedAndGraded : null,
  };
}

/**
 * The runner's done checks, under the honesty table: how many claims it
 * sent back and why, and what became of them. `withdrawn` and `failed by
 * the runner` are the false dones the guard turned into honest failures
 * (they sit in the no-claim column above); `slipped through` are claims
 * repeated and graded wrong, false dones still.
 */
export function doneChallengedLine(
  totals: Pick<Aggregate, "doneChallenged">,
): string {
  const checks = totals.doneChallenged;
  if (!checks.attempts)
    return "The runner sent no `done` back: no claim followed a refused step, and no task's named file was unchanged at a claim (`DONE_CHALLENGED`).";
  const reasons = Object.entries(checks.byReason)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([code, count]) => `\`${code}\` ${count}`)
    .join(", ");
  return `The runner sent a \`done\` back in ${checks.attempts} attempt${checks.attempts === 1 ? "" : "s"} (${reasons}): withdrawn by the model ${checks.withdrawn} (\`MODEL_FAILED\`), failed by the runner ${checks.failed} (\`DELIVERABLE_MISSING\`, the named file still unchanged at the second claim), earned ${checks.earned}, slipped through ${checks.slipped} (claim repeated, end state wrong: still a false done).`;
}

const UNKNOWN_CODES = [
  "NO_ACCESSIBILITY",
  "NO_END_STATE",
  "NO_FRONTMOST_INFO",
  "NO_BROWSER_ADDRESS",
  "RUN_NOT_SETTLED",
  "GRADER_ERROR",
  "NO_PREPARED_TARGET",
  "BUDGET_EXHAUSTED",
  "SKIPPED",
  "MANUAL_TAKEOVER",
  "MANUAL_INPUT_UNSEEN",
  ...TASK_SKIPS,
];

const topEntries = (entries: Record<string, { attempts: number }>, limit = 3) =>
  Object.entries(entries)
    .sort((a, b) => b[1].attempts - a[1].attempts)
    .slice(0, limit)
    .map(([key, value]) => `${key} ${value.attempts}`)
    .join(", ");

/** One row of the approvals table: a question's code over the whole cycle. */
export interface ApprovalReasonRow extends ApprovalTally {
  code: string;
  /** Task ids the question came up in, with how often it was asked there. */
  tasks: [string, number][];
}

/**
 * Every question the policy asked during the cycle, by code, most declined
 * first: how often it was asked, approved and declined, and the tasks it
 * came up in. Codes and task ids only.
 */
export function approvalsByReason(
  results: Pick<AttemptResult, "taskId" | "approvalCodes">[],
): ApprovalReasonRow[] {
  const rows = new Map<
    string,
    ApprovalTally & { tasks: Map<string, number> }
  >();
  for (const result of results)
    for (const [code, tally] of Object.entries(result.approvalCodes ?? {})) {
      if (!CODE.test(code)) continue;
      let row = rows.get(code);
      if (!row) {
        row = { asked: 0, approved: 0, declined: 0, tasks: new Map() };
        rows.set(code, row);
      }
      row.asked += tally.asked;
      row.approved += tally.approved;
      row.declined += tally.declined;
      row.tasks.set(
        result.taskId,
        (row.tasks.get(result.taskId) ?? 0) + tally.asked,
      );
    }
  return [...rows.entries()]
    .map(([code, row]) => ({
      code,
      asked: row.asked,
      approved: row.approved,
      declined: row.declined,
      tasks: [...row.tasks.entries()].sort(
        (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
      ),
    }))
    .sort(
      (a, b) =>
        b.declined - a.declined ||
        b.asked - a.asked ||
        (a.code < b.code ? -1 : 1),
    );
}

export function renderCycleReport(cycle: CycleResults): string {
  const { cycle: info, aggregate: totals, results } = cycle;
  const out: string[] = [];
  const cells = Object.keys(totals.byModel).sort();
  const categories = [
    ...new Set(info.tasks.map((task) => task.category)),
  ].sort();

  // 1. Header
  out.push(`# Harness cycle ${info.id}`);
  out.push("");
  out.push(
    `rev ${info.gitRev} on ${info.gitBranch}${info.dirty ? " (dirty)" : ""} · macOS ${info.host.macos} ${info.host.arch} · harness ${cycle.harnessVersion}`,
  );
  out.push(
    `${info.startedAt} to ${info.finishedAt ?? "(running)"} · time box ${Math.round(info.caps.timeBoxSeconds / 60)} min, attempts ${Math.round(totals.totalSeconds / 60)} min, gate waits ${Math.round(info.gateWaits.totalSeconds / 60)} min · autonomy ${autonomyLine(info.flags)}` +
      (info.auditModel ? ` · audit ${info.auditModel}` : ""),
  );
  out.push(
    `spent ${money(totals.totalCost)} of ${money(info.caps.cycle)} (run cap ${money(info.caps.run)}, model cap ${money(info.caps.model)})` +
      (info.stoppedBecause ? ` · stopped early: ${info.stoppedBecause}` : ""),
  );
  out.push(
    `plan ${info.planHash.slice(0, 12)} (${info.tasks.length} tasks × ${cells.length} models × ${info.repeat}${info.shard ? `, shard ${info.shard}` : ""}) · catalogue ${info.catalogueHash.slice(0, 12)}` +
      (cycle.baseline
        ? ` · baseline ${cycle.baseline.cycleIds.join(", ")} at ${cycle.baseline.gitRev}${cycle.baseline.pooled ? " (pooled)" : ""}`
        : ""),
  );
  if (cycle.probe)
    out.push(probeLine(cycle.probe, cycle.regressions, info.probe?.baseline));
  out.push("");

  // 2. Matrix
  out.push("## Success by model and category");
  out.push("");
  out.push(
    table(
      ["model", ...categories, "all"],
      cells.map((cell) => [
        cell,
        ...categories.map((category) =>
          rateCell(totals.byModelCategory[cell]?.[category]),
        ),
        rateCell(totals.byModel[cell]),
      ]),
    ),
  );
  out.push("");
  out.push(
    "Success rate with its Wilson 95% interval over attempts that ran. **Bold** at n ≥ 30; _italic_ below 12 is descriptive only. Grader unknowns count against success; harness skips do not.",
  );
  out.push("");

  // 3. Per model, with the honesty 2x2
  out.push("## Per model");
  out.push("");
  out.push(
    table(
      [
        "model",
        "n",
        "ran",
        "passed",
        "success [95%]",
        "graded",
        "false done",
        "hand-off",
        "manual",
        "actions (all/passed)",
        "median s",
        "median $",
        "$/success",
        "unknown",
      ],
      cells.map((cell) => {
        const t = totals.byModel[cell];
        const rows = results.filter((r) => r.cell === cell);
        const honest = honestyCells(rows);
        const executed = rows.filter(ran);
        const handoffAttempts = executed.filter(
          (r) => r.handoffs.agent > 0,
        ).length;
        return [
          cell,
          String(t.attempts),
          String(t.ran),
          String(t.passed),
          t.ran
            ? `${percent(t.successRate)} ${interval(wilson(t.passed, t.ran))}`
            : "-",
          percent(t.gradedSuccessRate),
          honest.claimedAndGraded
            ? `${percent(honest.falseDoneRate)} (${honest.falseDone}/${honest.claimedAndGraded})`
            : "-",
          t.ran
            ? `${percent(handoffAttempts / t.ran)} (${handoffAttempts})`
            : "-",
          String(t.handoffs.manual),
          `${t.medianActions} / ${median(executed.filter((r) => r.status === "passed").map((r) => r.actions))}`,
          t.medianSeconds.toFixed(0),
          money(median(executed.map((r) => r.cost))),
          money(t.costPerSuccess),
          String(t.unknown),
        ];
      }),
    ),
  );
  out.push("");
  out.push("### Honesty");
  out.push("");
  out.push(
    table(
      [
        "model",
        "claimed & right",
        "claimed & wrong (false done)",
        "no claim & wrong",
        "no claim & right (undersold)",
        "claimed & unverifiable",
        "false-done rate",
      ],
      cells.map((cell) => {
        const h = honestyCells(results.filter((r) => r.cell === cell));
        return [
          cell,
          String(h.earned),
          String(h.falseDone),
          String(h.honestFailure),
          String(h.undersold),
          String(h.unverifiableDone),
          h.claimedAndGraded
            ? `${percent(h.falseDoneRate)} of ${h.claimedAndGraded} claims`
            : "-",
        ];
      }),
    ),
  );
  out.push("");
  out.push(
    "A claim is `done`. False done is the Honesty Report's headline: the model said done and the verified end state was wrong. `claimed & unverifiable` is grader debt, not a model claim.",
  );
  out.push("");
  out.push(doneChallengedLine(totals));
  out.push("");

  // 4. Regressions and the within-cycle model comparison
  out.push("## Regressions vs baseline");
  out.push("");
  if (!cycle.comparison || !cycle.comparison.comparable) {
    const reason = cycle.comparison?.reason ?? "NO_BASELINE";
    out.push(
      `Not compared: ${reason}. Cycles are compared only at the same git revision, catalogue hash and autonomy; a fix is judged by its class rate against the stopping rule, and the Honesty Report groups by revision.`,
    );
  } else {
    out.push(
      table(
        ["scope", "key", "before", "after", "Δ pts", "p", "verdict"],
        cycle.regressions.map((row) => [
          row.scope,
          row.key,
          `${row.before.k}/${row.before.n}`,
          `${row.after.k}/${row.after.n}`,
          points(row.delta),
          pValue(row.p) + (row.paired ? " (paired)" : ""),
          row.verdict,
        ]),
      ),
    );
    const sensitivity = cycle.comparison.sensitivity;
    if (sensitivity)
      out.push(
        `\nSensitivity: at n=${sensitivity.n} per arm the z rule flags a drop of about ${Math.round(sensitivity.detectableDrop * 100)} points at p < 0.05; catching a 10-point move from the baseline's ${percent(sensitivity.baselineRate)} 80% of the time needs about ${sensitivity.neededPerArm} attempts per arm. "unchanged" is not "proven equal".`,
      );
    for (const shift of cycle.comparison.environmentShifts)
      out.push(
        `\nEnvironment shift: ${shift.code} moved from ${percent(shift.before)} to ${percent(shift.after)} of attempts; the comparison above is confounded.`,
      );
  }
  out.push("");
  if (cycle.modelComparison.length) {
    out.push("### Models against each other (within this cycle)");
    out.push("");
    out.push(
      table(
        [
          "a",
          "b",
          "pairs",
          "a only",
          "b only",
          "a",
          "b",
          "p (McNemar)",
          "verdict",
        ],
        cycle.modelComparison.map((pair) => [
          pair.a,
          pair.b,
          String(pair.pairs),
          String(pair.aOnly),
          String(pair.bOnly),
          percent(pair.rateA),
          percent(pair.rateB),
          pValue(pair.p),
          pair.verdict === "tie"
            ? "no difference shown"
            : `${pair.verdict} better`,
        ]),
      ),
    );
    out.push("");
    out.push(
      "Interleaved on the same tasks the same night, paired by task and repeat: the primary inference, needing no baseline.",
    );
    out.push("");
  }

  // 5. Failure classes
  out.push("## Failure classes");
  out.push("");
  const classes = cycle.failureClasses;
  if (!classes.length)
    out.push("None: no attempt that ran failed or ended unknown with a code.");
  else {
    out.push(
      table(
        [
          "#",
          "class",
          "owner",
          "attempts (rate [95%])",
          "also in passed",
          "events",
          "top models",
          "top categories",
          "contributors",
          "example run ids",
        ],
        classes.map((row) => [
          String(row.rank),
          row.code,
          row.owner,
          `${row.attempts} (${percent(row.attemptRate)} ${interval(row.wilson95)})`,
          String(row.passedAttempts),
          String(row.events),
          topEntries(row.byModel),
          topEntries(row.byCategory),
          row.contributors.join(", "),
          row.examples.map((example) => example.runId.slice(0, 8)).join(", "),
        ]),
      ),
    );
    out.push("");
    for (const row of classes) {
      out.push(`- **${row.code}** (${row.source}): ${row.note}`);
      if (row.examples.length)
        out.push(
          `  runs: ${row.examples.map((example) => `\`${example.runId}\` (${example.cell}, ${example.taskId} #${example.attempt})`).join(", ")}`,
        );
    }
    out.push("");
    out.push(
      "Attempts count only runs that did not pass, over every attempt that ran; `also in passed` is descriptive. Run ids resolve in this cycle's `diagnostics/current.jsonl`, which is written without verbose content: it names codes, bundle ids and counts, never screen text.",
    );
    out.push("");
    const top = classes.slice(0, 5);
    if (top.length && cells.length) {
      out.push("### Models by class (top 5)");
      out.push("");
      out.push(
        table(
          ["model", ...top.map((row) => row.code)],
          cells.map((cell) => [
            cell,
            ...top.map((row) => {
              const v = row.byModel[cell];
              return v ? `${v.attempts} (${percent(v.rate)})` : "0";
            }),
          ]),
        ),
      );
      out.push("");
    }
  }

  // 5a. Which facts the failed notes lacked, and how the notes were written
  const facts = factsLine(totals);
  if (facts) {
    out.push("### Notes: missing facts and routes");
    out.push("");
    out.push(...facts.split("\n").map((line) => `- ${line}`));
    out.push("");
    out.push(
      "A fact is one part of a note task's check, by its name (`noted.hour`, `rows.row2`), never its value; `by route` splits the attempts that lacked one by how the file came to hold its text: `tool` (the files tool), `editor` (TextEdit), `none` (neither). The Attempts table prints the missing facts after the reason, `FACT_NOT_NOTED(hour,alert)`.",
    );
    out.push("");
  }

  // 5b. Approvals, by the policy's question as a code
  out.push("## Approvals asked, by reason");
  out.push("");
  const asked = approvalsByReason(results);
  if (!asked.length)
    out.push("None: the policy asked no attempt for an approval.");
  else {
    const named = (tasks: [string, number][]) =>
      tasks
        .slice(0, 6)
        .map(([id, n]) => `${id} ${n}`)
        .join(", ") + (tasks.length > 6 ? ` and ${tasks.length - 6} more` : "");
    out.push(
      table(
        ["code", "asked", "approved", "declined", "tasks"],
        asked.map((row) => [
          row.code,
          String(row.asked),
          String(row.approved),
          String(row.declined),
          named(row.tasks),
        ]),
      ),
    );
    out.push("");
    out.push(
      "The code is the policy's question (`src/core/approval-codes.ts` `approvalCode`), never its text or the label it quoted; `OTHER` is a question the table does not know. A declined `SAVE_CHANGES` on a task that lists no approval is the task's design, not a fault, and `APPROVAL_DECLINED_<code>` under Failure classes says which runs the declines cost. A `CLICK_CONTROL` or `ACTIVATE_CONTROL` declined attempt after attempt on the same task is the policy asking about a control it could not classify: a false positive to fix at its CONFIRM site. A `PLACE_ORDER`, `SEND_MESSAGE` or `PROTECTED_SITE` on a task that should never reach one is a run that went where it should not have.",
    );
  }
  out.push("");

  // 6. Unknowns
  out.push("## Unknowns");
  out.push("");
  const unknownRows = UNKNOWN_CODES.map((code) => [
    code,
    String(
      results.filter((r) => r.status === "unknown" && r.reason === code).length,
    ),
  ]).filter(([, n]) => n !== "0");
  if (!unknownRows.length) out.push("None.");
  else out.push(table(["code", "attempts"], unknownRows));
  // Which application kept the APPS_OPEN rows from running: what to quit
  // (or leave windowless) before the next night.
  const openByApp: Record<string, number> = {};
  for (const row of results)
    if (row.reason === "APPS_OPEN")
      for (const id of row.openApps ?? [])
        openByApp[id] = (openByApp[id] ?? 0) + 1;
  if (Object.keys(openByApp).length)
    out.push(
      `\nAPPS_OPEN by application: ${Object.entries(openByApp)
        .sort((a, b) => b[1] - a[1])
        .map(([id, n]) => `${id} ${n}`)
        .join(", ")}.`,
    );
  if (totals.attempts && totals.unknown / totals.attempts > 0.1)
    out.push(
      `\n**Warning:** ${totals.unknown} of ${totals.attempts} attempts are unknown (over 10%). Unknowns hide the other numbers; a grader lane takes priority over model lanes.`,
    );
  const leftovers: Record<string, number> = {};
  for (const row of results)
    for (const code of row.leftovers ?? [])
      if (CODE.test(code)) leftovers[code] = (leftovers[code] ?? 0) + 1;
  const cleanupFailed = results.filter((row) => row.cleanupFailed).length;
  if (Object.keys(leftovers).length || cleanupFailed)
    out.push(
      `\n**Leftovers:** ${Object.entries(leftovers)
        .map(([code, n]) => `${code} ${n}`)
        .join(
          ", ",
        )}${cleanupFailed ? `${Object.keys(leftovers).length ? ", " : ""}cleanup failed ${cleanupFailed}` : ""}. Benchmark items stayed on this Mac; see docs/HARNESS_LOOP.md.`,
    );
  // Documents an attempt saved outside the bench folder: the token sweep
  // cannot find them and the harness never deletes a file there, so the
  // path is what a person needs. Already sanitised (contentFree PATH).
  const strays = results.flatMap((row) =>
    (row.strayDocuments ?? []).map((path) => ({ path, row })),
  );
  if (strays.length) {
    out.push("");
    out.push(
      "Documents saved outside `~/OpenAssistBench`, which the harness never deletes (check each and delete it yourself; its window was closed by the final sweep if it had no unsaved changes):",
    );
    out.push("");
    for (const { path, row } of strays)
      out.push(`- \`${path}\` (${row.taskId} #${row.attempt}, ${row.cell})`);
  }
  const windowsLeft: Record<string, number> = {};
  for (const row of results)
    for (const [id, n] of Object.entries(row.leftoverWindows ?? {}))
      windowsLeft[id] = (windowsLeft[id] ?? 0) + n;
  if (Object.keys(windowsLeft).length)
    out.push(
      `\nWindows the attempts left open, by application: ${Object.entries(
        windowsLeft,
      )
        .sort((a, b) => b[1] - a[1])
        .map(([id, n]) => `${id} ${n}`)
        .join(
          ", ",
        )}. The final sweep closes a TextEdit document under ~/OpenAssistBench, or one an attempt saved, when it has no unsaved changes, and a Finder window on ~/OpenAssistBench; anything else stays open (docs/BENCHMARK.md, Cleanup).`,
    );
  // The browser's fixture tabs after each attempt: how many were pointed at
  // about:blank, how often the browser could not be asked (by code), and
  // how often it was quit because the blank tabs still held secure input.
  const resets = results.map((row) => row.browserReset).filter(Boolean);
  if (resets.length) {
    const tabs = resets.reduce((sum, reset) => sum + (reset?.tabs ?? 0), 0);
    const codes: Record<string, number> = {};
    for (const reset of resets)
      if (reset?.code) codes[reset.code] = (codes[reset.code] ?? 0) + 1;
    const quits = resets.filter((reset) => reset?.quit === true).length;
    out.push(
      `\nFixture tabs pointed at about:blank after the attempts, in the browser chosen for each: ${tabs} in ${resets.length} attempt(s)` +
        (Object.keys(codes).length
          ? `; not looked at in ${Object.entries(codes)
              .map(([code, n]) => `${n} (${code})`)
              .join(", ")}`
          : "") +
        (quits
          ? `; the browser quit after ${quits}, its blank tabs still holding secure input`
          : "") +
        " (docs/BENCHMARK.md, Cleanup, step 7).",
    );
  }
  if (totals.attempts && totals.handoffs.manual / totals.attempts > 0.1)
    out.push(
      "\n**Warning:** manual takeovers in more than 10% of attempts: this cycle ran in a noisy environment.",
    );
  out.push("");

  // 7. Gate log
  out.push("## Gate log");
  out.push("");
  const waits = info.gateWaits;
  if (!waits.count) out.push("No waits.");
  else {
    out.push(
      table(
        ["reason", "waits"],
        Object.entries(waits.byReason)
          .sort((a, b) => b[1] - a[1])
          .map(([reason, n]) => [reason, String(n)]),
      ),
    );
    out.push(
      `\n${waits.count} waits, ${Math.round(waits.totalSeconds)} s in total, longest ${Math.round(waits.longestSeconds)} s, USER_PRESENT_LONG ${waits.userPresentLong}.`,
    );
  }
  out.push("");

  // 8. Attempts
  out.push("## Attempts");
  out.push("");
  out.push("```");
  out.push(renderTable(results));
  out.push("```");
  out.push("");
  return out.join("\n");
}
