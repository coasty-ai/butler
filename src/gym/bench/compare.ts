import { ran, type AttemptResult } from "./report";
import { mcnemarExact, powerN, twoProportionZ, wilson } from "./stats";

/**
 * Regression detection between cycles, and the within-cycle model
 * comparison that is the primary inference. Cross-cycle comparison is
 * confounded by environment and drift, so it is never made across a
 * different catalogue hash (a grader change changes the metric), git
 * revision or uncommitted tree (different code, different population); the
 * caller is told why instead of getting a number.
 */

/** A failure class as results.json stores it, enough to rate it per cell. */
export interface StoredClass {
  code: string;
  byModel: Record<string, { attempts: number }>;
}

/** What a cycle must carry to be compared. results.json satisfies it. */
export interface ComparableCycle {
  id: string;
  gitRev: string;
  catalogueHash: string;
  planHash: string;
  /** The plan's attempts without their order; equal designs pair. */
  designHash?: string;
  /** `i/n` when the cycle ran one slice of a plan (--shard, or automatic). */
  shard?: string;
  /** Run from a tree with uncommitted changes: not the code its gitRev names. */
  dirty?: boolean;
  startedAt: string;
  finishedAt?: string;
  stoppedBecause?: string;
  taskIds: string[];
  cells: string[];
  results: AttemptResult[];
  /**
   * The cycle's failure classes, analyzer frictions (PROVIDER_*, ...)
   * included, which its rows alone cannot rebuild.
   */
  failureClasses?: StoredClass[];
}

export interface Rate {
  k: number;
  n: number;
  rate: number;
}

export type Verdict =
  "regression" | "improvement" | "inconclusive" | "unchanged" | "new" | "gone";

export interface Regression {
  scope: "model" | "model:category" | "class";
  key: string;
  before: Rate;
  after: Rate;
  delta: number;
  /** Two-proportion z, or NaN for a paired (McNemar) comparison. */
  z: number;
  p: number;
  paired: boolean;
  verdict: Verdict;
}

export type NotComparable =
  | "GIT_REV_DIFFERS"
  | "CATALOGUE_HASH_DIFFERS"
  | "DIRTY_TREE"
  | "SHARD_DIFFERS"
  | "NO_BASELINE";

export interface Comparison {
  comparable: boolean;
  reason?: NotComparable;
  baselineIds: string[];
  regressions: Regression[];
  /** Environment classes (PROVIDER_*) whose rate moved by ten points or more. */
  environmentShifts: { code: string; before: number; after: number }[];
  /**
   * For the smallest compared model cell: the drop the z rule can flag at
   * p < 0.05, and the attempts per arm a 10-point drop from the baseline's
   * rate needs to be caught 80% of the time.
   */
  sensitivity?: {
    n: number;
    detectableDrop: number;
    baselineRate: number;
    neededPerArm: number;
  };
}

const MIN_N = 12;
const POINTS = 0.1;
const ALPHA = 0.05;

const rateOf = (k: number, n: number): Rate => ({ k, n, rate: n ? k / n : 0 });

/**
 * Whether two cycles measured the same mix of work. A shard holds some
 * (task, repeat) groups of its plan and not others, so its pass rate is
 * that mix's: the sibling shards of one plan, or a shard and a whole plan,
 * differ by which tasks they ran, and a difficulty gap between the mixes
 * would read as a regression with no code changed. Unsharded cycles hold
 * every task alike; a sharded one matches only the same slice of the same
 * plan, which its design hash names (shard and seed included).
 */
export function sameSlice(a: ComparableCycle, b: ComparableCycle): boolean {
  if (!a.shard && !b.shard) return true;
  return (
    a.shard === b.shard &&
    a.designHash !== undefined &&
    a.designHash === b.designHash
  );
}

/**
 * The completed cycles at the current rev and catalogue that cover the plan,
 * share a cell and ran the same slice of work (sameSlice). A cycle run from
 * an uncommitted tree is never a baseline: its rev names code it did not
 * run.
 */
export function selectBaseline(
  current: ComparableCycle,
  candidates: ComparableCycle[],
): ComparableCycle[] {
  return timingCycles(current, candidates).filter((cycle) =>
    sameSlice(cycle, current),
  );
}

/**
 * selectBaseline without the slice rule: cycles whose per-task durations
 * estimate this plan's, before it is known which slice tonight runs. A
 * task's median time does not depend on which other tasks ran beside it.
 */
export function timingCycles(
  current: ComparableCycle,
  candidates: ComparableCycle[],
): ComparableCycle[] {
  const eligible = candidates.filter(
    (cycle) =>
      cycle.id !== current.id &&
      cycle.finishedAt &&
      !cycle.stoppedBecause &&
      !cycle.dirty &&
      cycle.gitRev === current.gitRev &&
      cycle.catalogueHash === current.catalogueHash &&
      current.taskIds.every((id) => cycle.taskIds.includes(id)) &&
      cycle.cells.some((cell) => current.cells.includes(cell)),
  );
  // The most recent one chooses the population; every completed cycle at the
  // same rev is then pooled with it.
  eligible.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  return eligible;
}

function passRate(results: AttemptResult[]): Rate {
  const executed = results.filter(ran);
  return rateOf(
    executed.filter((r) => r.status === "passed").length,
    executed.length,
  );
}

const pairKey = (r: AttemptResult) =>
  JSON.stringify([r.cell, r.taskId, r.attempt]);

/** Discordant pairs by (cell, task, attempt), for cycles of the same plan. */
function pairs(
  before: AttemptResult[],
  after: AttemptResult[],
): { b: number; c: number; n: number } {
  const earlier = new Map(before.filter(ran).map((r) => [pairKey(r), r]));
  let b = 0;
  let c = 0;
  let n = 0;
  for (const row of after.filter(ran)) {
    const mate = earlier.get(pairKey(row));
    if (!mate) continue;
    n++;
    const was = mate.status === "passed";
    const is = row.status === "passed";
    if (was && !is) b++;
    if (!was && is) c++;
  }
  return { b, c, n };
}

function verdictFor(
  before: Rate,
  after: Rate,
  pDrop: number,
  pRise: number,
): Verdict {
  const delta = after.rate - before.rate;
  if (before.n < MIN_N || after.n < MIN_N)
    return Math.abs(delta) >= POINTS ? "inconclusive" : "unchanged";
  if (delta <= -POINTS && pDrop < ALPHA) return "regression";
  if (delta >= POINTS && pRise < ALPHA) return "improvement";
  if (Math.abs(delta) >= POINTS) return "inconclusive";
  return "unchanged";
}

function compareRates(
  scope: Regression["scope"],
  key: string,
  before: AttemptResult[],
  after: AttemptResult[],
  paired: boolean,
): Regression {
  const b = passRate(before);
  const a = passRate(after);
  if (paired) {
    const p = pairs(before, after);
    const test = mcnemarExact(p.b, p.c);
    // The paired test has the pairs as its n; the rates stay per arm.
    return {
      scope,
      key,
      before: b,
      after: a,
      delta: a.rate - b.rate,
      z: Number.NaN,
      p: p.b >= p.c ? test.pWorse : test.pBetter,
      paired: true,
      verdict: verdictFor(
        { ...b, n: p.n },
        { ...a, n: p.n },
        test.pWorse,
        test.pBetter,
      ),
    };
  }
  const test = twoProportionZ(b.k, b.n, a.k, a.n);
  return {
    scope,
    key,
    before: b,
    after: a,
    delta: test.delta,
    z: test.z,
    p: a.rate < b.rate ? test.pDrop : test.pRise,
    paired: false,
    verdict: verdictFor(b, a, test.pDrop, test.pRise),
  };
}

/** A class's rate: attempts that carry the code over attempts that ran. */
export interface ClassRate {
  code: string;
  attempts: number;
  ran: number;
}

/**
 * A class's rate before and after. A class absent on one side has zero
 * attempts over that side's attempts that ran, not an empty sample: that is
 * what lets "gone" and "new" be told apart from "no data".
 */
function compareClass(
  code: string,
  before: ClassRate | undefined,
  after: ClassRate | undefined,
  ranBefore: number,
  ranAfter: number,
): Regression | undefined {
  const b = rateOf(before?.attempts ?? 0, ranBefore);
  const a = rateOf(after?.attempts ?? 0, ranAfter);
  const base = {
    scope: "class" as const,
    key: code,
    before: b,
    after: a,
    paired: false,
    delta: a.rate - b.rate,
  };
  if (!before?.attempts && a.k >= 3)
    return { ...base, z: Number.NaN, p: Number.NaN, verdict: "new" };
  if (
    (before?.attempts ?? 0) >= 3 &&
    a.k === 0 &&
    a.n >= 36 &&
    wilson(0, a.n)[1] < 0.1
  )
    return { ...base, z: Number.NaN, p: Number.NaN, verdict: "gone" };
  if (!b.n || !a.n) return undefined;
  const test = twoProportionZ(b.k, b.n, a.k, a.n);
  // For a failure class a rise is the regression.
  let verdict: Verdict;
  if (b.n < MIN_N || a.n < MIN_N)
    verdict = Math.abs(base.delta) >= POINTS ? "inconclusive" : "unchanged";
  else if (base.delta >= POINTS && test.pRise < ALPHA) verdict = "regression";
  else if (base.delta <= -POINTS && test.pDrop < ALPHA) verdict = "improvement";
  else if (Math.abs(base.delta) >= POINTS) verdict = "inconclusive";
  else verdict = "unchanged";
  return {
    ...base,
    z: test.z,
    p: base.delta >= 0 ? test.pRise : test.pDrop,
    verdict,
  };
}

/** The drop a one-sided z test flags at p < 0.05 with these arms at rate p. */
export function detectableDrop(n1: number, n2: number, p = 0.5): number {
  if (!n1 || !n2) return 1;
  return 1.6449 * Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
}

/**
 * Compares the current cycle with its baseline. Only cells present in both
 * are compared; a baseline of one cycle with the same design (the same
 * attempts, whatever their order) is paired by (task, rep) and tested
 * exactly, otherwise the pooled z test applies. `classes` rates a cycle's
 * failure classes over the given cells; the baseline's are summed.
 */
export function compareCycles(
  current: ComparableCycle,
  baseline: ComparableCycle[],
  classes: (cycle: ComparableCycle, cells: string[]) => ClassRate[],
): Comparison {
  const none: Comparison = {
    comparable: false,
    baselineIds: baseline.map((cycle) => cycle.id),
    regressions: [],
    environmentShifts: [],
  };
  if (!baseline.length) return { ...none, reason: "NO_BASELINE" };
  if (current.dirty || baseline.some((cycle) => cycle.dirty))
    return { ...none, reason: "DIRTY_TREE" };
  if (baseline.some((cycle) => cycle.gitRev !== current.gitRev))
    return { ...none, reason: "GIT_REV_DIFFERS" };
  if (baseline.some((cycle) => cycle.catalogueHash !== current.catalogueHash))
    return { ...none, reason: "CATALOGUE_HASH_DIFFERS" };
  // A named baseline too: the pooled test over two different task mixes
  // measures the mix, not the code.
  if (baseline.some((cycle) => !sameSlice(cycle, current)))
    return { ...none, reason: "SHARD_DIFFERS" };
  const paired =
    baseline.length === 1 &&
    baseline[0].designHash !== undefined &&
    baseline[0].designHash === current.designHash;
  const before = baseline.flatMap((cycle) => cycle.results);
  const after = current.results;
  const shared = current.cells.filter((cell) =>
    baseline.some((cycle) => cycle.cells.includes(cell)),
  );
  const regressions: Regression[] = [];
  let smallest = Infinity;
  for (const cell of shared) {
    const b = before.filter((r) => r.cell === cell);
    const a = after.filter((r) => r.cell === cell);
    const row = compareRates("model", cell, b, a, paired);
    smallest = Math.min(smallest, row.before.n, row.after.n);
    regressions.push(row);
    for (const category of new Set(a.map((r) => r.category))) {
      const bc = b.filter((r) => r.category === category);
      const ac = a.filter((r) => r.category === category);
      if (!bc.length) continue;
      regressions.push(
        compareRates("model:category", `${cell}:${category}`, bc, ac, paired),
      );
    }
  }
  const beforeClasses = new Map<string, ClassRate>();
  for (const cycle of baseline)
    for (const row of classes(cycle, shared)) {
      const known = beforeClasses.get(row.code);
      beforeClasses.set(
        row.code,
        known
          ? {
              ...known,
              attempts: known.attempts + row.attempts,
              ran: known.ran + row.ran,
            }
          : row,
      );
    }
  const afterClasses = new Map(
    classes(current, shared).map((c) => [c.code, c]),
  );
  const ranBefore = before.filter(
    (r) => shared.includes(r.cell) && ran(r),
  ).length;
  const ranAfter = after.filter(
    (r) => shared.includes(r.cell) && ran(r),
  ).length;
  const environmentShifts: Comparison["environmentShifts"] = [];
  for (const code of new Set([
    ...beforeClasses.keys(),
    ...afterClasses.keys(),
  ])) {
    const b = beforeClasses.get(code);
    const a = afterClasses.get(code);
    if (code.startsWith("PROVIDER_")) {
      const rb = ranBefore ? (b?.attempts ?? 0) / ranBefore : 0;
      const ra = ranAfter ? (a?.attempts ?? 0) / ranAfter : 0;
      if (Math.abs(ra - rb) >= POINTS)
        environmentShifts.push({ code, before: rb, after: ra });
      continue;
    }
    const row = compareClass(code, b, a, ranBefore, ranAfter);
    if (row) regressions.push(row);
  }
  const order: Record<Verdict, number> = {
    regression: 0,
    new: 1,
    inconclusive: 2,
    improvement: 3,
    gone: 4,
    unchanged: 5,
  };
  regressions.sort(
    (x, y) => order[x.verdict] - order[y.verdict] || (x.key < y.key ? -1 : 1),
  );
  const baselineRate = passRate(
    before.filter((r) => shared.includes(r.cell)),
  ).rate;
  return {
    comparable: true,
    baselineIds: baseline.map((cycle) => cycle.id),
    regressions,
    environmentShifts,
    sensitivity: Number.isFinite(smallest)
      ? {
          n: smallest,
          detectableDrop: detectableDrop(smallest, smallest),
          baselineRate,
          // Below 10% there is no 10-point drop to catch; the rise is the
          // mirror question and needs the same attempts.
          neededPerArm: powerN(
            baselineRate,
            baselineRate >= 0.1 ? baselineRate - 0.1 : baselineRate + 0.1,
          ),
        }
      : undefined,
  };
}

/** A within-cycle comparison of two models on the same tasks and reps. */
export interface ModelPair {
  a: string;
  b: string;
  pairs: number;
  /** Pairs a passed and b failed. */
  aOnly: number;
  /** Pairs b passed and a failed. */
  bOnly: number;
  rateA: number;
  rateB: number;
  /** McNemar exact, two-sided. */
  p: number;
  verdict: "a" | "b" | "tie";
}

/**
 * The primary inference: models interleaved on the same tasks the same
 * night, paired by (task, rep) and tested exactly. It needs no baseline and
 * is immune to the drift that confounds cross-cycle comparison.
 */
export function compareModels(results: AttemptResult[]): ModelPair[] {
  const cells = [...new Set(results.map((r) => r.cell))].sort();
  const out: ModelPair[] = [];
  for (let i = 0; i < cells.length; i++)
    for (let j = i + 1; j < cells.length; j++) {
      const a = results.filter((r) => r.cell === cells[i]);
      const b = results.filter((r) => r.cell === cells[j]);
      // Pairing ignores the cell, so the two arms are re-keyed to one cell.
      const key = (rows: AttemptResult[]) =>
        rows.map((r) => ({ ...r, cell: "pair" }));
      const discordant = pairs(key(a), key(b));
      // pairs() counts "before passed, after failed" as b: with a as before,
      // that is a pass where b failed.
      const aOnly = discordant.b;
      const bOnly = discordant.c;
      const test = mcnemarExact(aOnly, bOnly);
      out.push({
        a: cells[i],
        b: cells[j],
        pairs: discordant.n,
        aOnly,
        bOnly,
        rateA: passRate(a).rate,
        rateB: passRate(b).rate,
        p: test.pTwoSided,
        verdict:
          test.pTwoSided < ALPHA && discordant.n >= MIN_N
            ? aOnly > bOnly
              ? "a"
              : "b"
            : "tie",
      });
    }
  return out;
}

/* ----------------------------------------------------------------- probe */

/** Why a probe did not pass, as a fixed code and the row it is about. */
export interface ProbeReason {
  code:
    | "CLASS_NOT_IMPROVED"
    | "OTHER_CLASS_REGRESSED"
    | "MODEL_REGRESSED"
    | "TASKS_CHANGED"
    | "NO_SHARED_CELLS";
  key?: string;
}

export interface ProbeVerdict {
  code: string;
  pass: boolean;
  reasons: ProbeReason[];
  /** The class over the attempts that ran, in the baseline's scope and now. */
  before: Rate;
  after: Rate;
  /** One-sided p that the class's rate fell. */
  p: number;
  comparison: Comparison;
}

/**
 * `--probe CODE --baseline <cycle>` (harness-design-loop.md §3.3): the fix
 * under test against the baseline, over the cells and tasks the probe ran.
 * It passes when the class's rate fell (one-sided p < 0.05) or the class
 * is gone (0 in 36 or more attempts), no other agent-owned class is a
 * regression, and no affected model's success rate is. A probe runs a
 * different revision by design (that is the fix), so the revision, tree and
 * catalogue-hash checks of compareCycles are replaced by one on the task
 * templates the two ran (`templatesMatch`). Evidence for a merge, never for
 * "fixed": its tasks are the ones the fix was tuned on.
 */
export function compareProbe(
  current: ComparableCycle,
  baseline: ComparableCycle,
  code: string,
  options: {
    templatesMatch: boolean;
    classes: (cycle: ComparableCycle, cells: string[]) => ClassRate[];
    owner: (code: string) => string;
  },
): ProbeVerdict {
  const cells = current.cells.filter((cell) => baseline.cells.includes(cell));
  const tasks = new Set(current.taskIds);
  const scoped: ComparableCycle = {
    ...baseline,
    gitRev: current.gitRev,
    catalogueHash: current.catalogueHash,
    dirty: false,
    // Another plan: nothing pairs, the pooled z test applies. The probe's
    // scope replaces the slice rule too: it is judged on its own tasks,
    // whichever night of a sharded plan the baseline was.
    designHash: undefined,
    shard: undefined,
    taskIds: baseline.taskIds.filter((id) => tasks.has(id)),
    cells,
    results: baseline.results.filter(
      (row) => cells.includes(row.cell) && tasks.has(row.taskId),
    ),
  };
  const now: ComparableCycle = { ...current, dirty: false, shard: undefined };
  const comparison = compareCycles(now, [scoped], options.classes);
  const rateFor = (cycle: ComparableCycle): Rate => {
    const executed = cycle.results.filter(
      (row) => cells.includes(row.cell) && ran(row),
    ).length;
    const found = options
      .classes(cycle, cells)
      .find((row) => row.code === code);
    return rateOf(found?.attempts ?? 0, executed);
  };
  const before = rateFor(scoped);
  const after = rateFor(now);
  const test = twoProportionZ(before.k, before.n, after.k, after.n);
  const reasons: ProbeReason[] = [];
  if (!options.templatesMatch) reasons.push({ code: "TASKS_CHANGED" });
  if (!cells.length) reasons.push({ code: "NO_SHARED_CELLS" });
  const improved = after.rate < before.rate && test.pDrop < ALPHA;
  const cleared = after.k === 0 && after.n >= 36;
  if (!improved && !cleared) reasons.push({ code: "CLASS_NOT_IMPROVED" });
  for (const row of comparison.regressions) {
    if (row.verdict !== "regression") continue;
    if (
      row.scope === "class" &&
      row.key !== code &&
      options.owner(row.key) === "agent"
    )
      reasons.push({ code: "OTHER_CLASS_REGRESSED", key: row.key });
    if (row.scope === "model")
      reasons.push({ code: "MODEL_REGRESSED", key: row.key });
  }
  return {
    code,
    pass: !reasons.length,
    reasons,
    before,
    after,
    p: test.pDrop,
    comparison,
  };
}
