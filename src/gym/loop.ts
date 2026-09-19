/**
 * The fix loop: what a cycle's failures mean for the next day's work.
 *
 * A cycle measures the agent (scripts/harness-cycle.mjs). This module turns
 * that measurement into a plan: which failure classes deserve a fix lane,
 * what each lane must prove before it may be merged, which probe validates
 * it, and when a class counts as fixed, parked or still open. It is pure —
 * no files, no git, no network, no clock of its own — so the whole loop can
 * be exercised from recorded cycles in tests. scripts/harness-loop.mjs runs
 * the plan: it creates the worktrees, hands each lane to whatever fix agent
 * the operator names, runs the suites and the probe, and stops.
 *
 * Two rules never move. A lane is never merged by the loop: it ends as a
 * branch a person reviews, whatever the probe says. And a diff that weakens
 * a safety floor is refused outright, however much it improves a rate: the
 * loop may make the agent faster or more capable, never less careful.
 */
import type { CycleResults, FailureClass } from "./bench/cycle-report";

/** Classes the loop writes lanes for; anything else is a human's problem. */
export const LANE_OWNERS = ["agent", "grader", "harness"] as const;
export type LaneOwner = (typeof LANE_OWNERS)[number];

export const LOOP_LIMITS = {
  /** A class needs at least this share of ran attempts to earn a lane. */
  minAttemptRate: 0.05,
  /** …and at least this many attempts, so one bad night is not a lane. */
  minAttempts: 3,
  /** Unknown grades hide every other number, so they come first at this rate. */
  unknownFirstRate: 0.1,
  /** Lanes started per cycle: the operator reviews each one by hand. */
  maxLanes: 3,
  /** Failed lanes for a class before it is parked. */
  parkAfter: 3,
  /** "Fixed" thresholds: the class rate must be at or below this… */
  fixedAt: 0.1,
  /** …and 5% for the classes a user experiences as a breach of trust. */
  strictFixedAt: 0.05,
  strictClasses: ["HANDOFF_TAKEOVER", "FALSE_DONE"],
} as const;

/** What the loop knows about a class from earlier cycles. */
export interface ClassHistory {
  code: string;
  /** Lanes that reached a probe and did not move the rate. */
  failedLanes: number;
  /** Open branch for this class, if a lane is in flight. */
  openLane?: string;
  parked?: boolean;
  fixed?: boolean;
}
export interface LoopState {
  /** Cycles the loop has already planned from, newest last. */
  cycles: string[];
  classes: Record<string, ClassHistory>;
}
export const emptyLoopState = (): LoopState => ({ cycles: [], classes: {} });

export interface Lane {
  code: string;
  owner: string;
  branch: string;
  worktree: string;
  /** Why this class was chosen, in one line for the report. */
  reason: string;
  attempts: number;
  attemptRate: number;
  models: string[];
  categories: string[];
  examples: string[];
}

/** Whether a class is one of the strict ones (a user-visible breach of trust). */
export const strictClass = (code: string): boolean =>
  (LOOP_LIMITS.strictClasses as readonly string[]).includes(code);

/** The rate a class must be at or below to count as fixed. */
export const fixedThreshold = (code: string): number =>
  strictClass(code) ? LOOP_LIMITS.strictFixedAt : LOOP_LIMITS.fixedAt;

/**
 * The classes worth a lane, most costly first. Unknown grades (a grader or
 * harness fault) come before agent classes at the same rate: while they are
 * there, every other number in the cycle is uncertain. A class that is
 * parked, already fixed, or has a lane in flight is skipped.
 */
export function selectLanes(
  cycle: CycleResults,
  state: LoopState,
  cycleId = cycle.cycle.id,
): Lane[] {
  const ranked = [...cycle.failureClasses]
    .filter((c) => (LANE_OWNERS as readonly string[]).includes(c.owner))
    .filter((c) => {
      const history = state.classes[c.code];
      return !history?.parked && !history?.fixed && !history?.openLane;
    })
    .filter(
      (c) =>
        c.attempts >= LOOP_LIMITS.minAttempts &&
        c.attemptRate >= LOOP_LIMITS.minAttemptRate,
    )
    .sort((a, b) => priority(b) - priority(a) || a.rank - b.rank);
  return ranked.slice(0, LOOP_LIMITS.maxLanes).map((c) => lane(c, cycleId));
}

function priority(c: FailureClass): number {
  // A grader or harness fault at the unknown-first rate outranks everything.
  const blocking =
    c.owner !== "agent" && c.attemptRate >= LOOP_LIMITS.unknownFirstRate;
  return (blocking ? 1000 : 0) + c.attemptRate * 100;
}

function lane(c: FailureClass, cycleId: string): Lane {
  const slug = c.code.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const models = Object.entries(c.byModel)
    .filter(([, m]) => m.rate > 0)
    .map(([cell]) => cell)
    .sort();
  const categories = Object.entries(c.byCategory)
    .filter(([, m]) => m.rate > 0)
    .map(([name]) => name)
    .sort();
  return {
    code: c.code,
    owner: c.owner,
    branch: `fix/${slug}-${cycleId}`,
    worktree: `.claude/worktrees/fix-${slug}`,
    reason:
      c.owner === "agent"
        ? `${c.code} in ${c.attempts} ran attempts (${pct(c.attemptRate)})`
        : `${c.owner}-owned ${c.code} hides other numbers: ${pct(c.attemptRate)} of ran attempts`,
    attempts: c.attempts,
    attemptRate: c.attemptRate,
    models,
    categories,
    examples: c.examples.map((e) => e.runId),
  };
}
const pct = (rate: number) => `${(rate * 100).toFixed(1)}%`;

/**
 * The lane's brief: the mechanism to explain, the evidence to start from,
 * and the six things it must satisfy before a person may merge it. Content
 * free: codes, ids, counts and rates only, never a task's text or a screen.
 */
export function laneBrief(
  lane: Lane,
  cycle: CycleResults,
  o: { probeCommand: string; suites: string[] },
): string {
  const cls = cycle.failureClasses.find((c) => c.code === lane.code);
  return [
    `# Fix lane: ${lane.code}`,
    "",
    `Cycle ${cycle.cycle.id} at ${cycle.cycle.gitRev}. ${lane.reason}.`,
    `Owner: ${lane.owner}. Branch ${lane.branch} in worktree ${lane.worktree}.`,
    cls?.note ? `Analyzer note: ${cls.note}` : "",
    lane.models.length ? `Models affected: ${lane.models.join(", ")}.` : "",
    lane.categories.length
      ? `Categories affected: ${lane.categories.join(", ")}.`
      : "",
    lane.examples.length
      ? `Example runs (resolve in this cycle's diagnostics): ${lane.examples.join(", ")}.`
      : "",
    "",
    "## What the lane must do",
    "1. State the mechanism in one paragraph: what the agent did, what it should have done, and the line that decides.",
    "2. A failing test first, reproducing the class from a content-free event sequence.",
    "3. The fix, minimal and in the files the mechanism names.",
    `4. Every suite green: ${o.suites.join(" ; ")}.`,
    "5. Two adversarial tests that try to break the fix, including a neighbouring class that must not get worse.",
    `6. The probe, run by the operator: ${o.probeCommand}`,
    "",
    "## Rules",
    "- A safety floor is never relaxed to make a class pass: no approval removed, no refusal weakened, no protected app, domain or credential rule loosened. If the only fix needs a floor to change, stop and say so in the branch.",
    "- The loop never merges: leave the branch for review.",
    "- Content-free traces only; never add a task's text or screen content to a test fixture.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Paths whose refusals are the agent's safety floor. A lane may add to them
 * (a new refusal is a tightening) but never subtract: the loop refuses a
 * diff that removes refusals here, whatever it does to a rate.
 */
export const FLOOR_PATHS = [
  "src/core/policy.ts",
  "src/core/ide.ts",
  "src/core/sanitize.ts",
  "src/voice/turns.ts",
  "src/assistant/arbitrate.ts",
  "native/macos/InputSafety.swift",
  "native/macos/LaunchSafety.swift",
  "native/macos/FileSafety.swift",
  "native/macos/FrameSafety.swift",
  "native/macos/IdeSafety.swift",
  "native/macos/MessageSafety.swift",
  "native/macos/NamedTargets.swift",
  "native/macos/WakePolicy.swift",
  "native/macos/TurnPolicy.swift",
  "electron/credentials.ts",
] as const;
/** Lines that state a refusal: removing one is weakening the floor. */
const REFUSAL =
  /\b(DENY|CONFIRM|USER_TAKEOVER|refuse[ds]?|Refused|BLOCK_UPLOAD|protected|forbidden|never)\b/;

export interface FloorVerdict {
  /** The lane may go to a person for review. */
  ok: boolean;
  /** Floor files the diff touched at all. */
  touched: string[];
  /** Refusal lines the diff removed, as file:line-ish fragments. */
  removed: { file: string; line: string }[];
}

/**
 * Reads a unified diff and decides whether it weakens a floor. Lines removed
 * from a floor file that state a refusal fail it; additions never do, so a
 * lane that adds a rule is fine. Files outside FLOOR_PATHS are not read.
 */
export function floorVerdict(diff: string): FloorVerdict {
  const touched: string[] = [];
  const removed: { file: string; line: string }[] = [];
  let file = "";
  for (const raw of diff.split("\n")) {
    const header = /^diff --git a\/(\S+) b\/(\S+)/.exec(raw);
    if (header) {
      file = header[2];
      if (isFloor(file) && !touched.includes(file)) touched.push(file);
      continue;
    }
    if (!isFloor(file)) continue;
    if (!raw.startsWith("-") || raw.startsWith("---")) continue;
    const line = raw.slice(1).trim();
    // A comment or an empty line carries no rule.
    if (!line || line.startsWith("//") || line.startsWith("*")) continue;
    if (REFUSAL.test(line)) removed.push({ file, line: line.slice(0, 120) });
  }
  return { ok: removed.length === 0, touched, removed };
}
const isFloor = (file: string) =>
  (FLOOR_PATHS as readonly string[]).includes(file);

export type LaneOutcome =
  /** The lane produced a branch a person may review. */
  | { verdict: "review"; reason: string }
  /** The probe says the class did not move; the lane counts as failed. */
  | { verdict: "failed"; reason: string }
  /** Refused by the loop itself: a floor, or a suite that did not pass. */
  | { verdict: "blocked"; reason: string };

/**
 * What became of one lane, from its own checks. The probe is evidence for a
 * review, never a merge: "review" is the best outcome the loop can give.
 */
export function laneOutcome(o: {
  floor: FloorVerdict;
  suitesPassed: boolean;
  probe?: CycleResults["probe"];
}): LaneOutcome {
  if (!o.floor.ok)
    return {
      verdict: "blocked",
      reason: `weakens a safety floor: ${o.floor.removed
        .map((r) => r.file)
        .join(", ")}`,
    };
  if (!o.suitesPassed)
    return { verdict: "blocked", reason: "a required suite did not pass" };
  if (!o.probe) return { verdict: "review", reason: "no probe was run" };
  return o.probe.pass
    ? {
        verdict: "review",
        reason: `probe ${o.probe.code}: ${pct(o.probe.before.rate)} -> ${pct(
          o.probe.after.rate,
        )}`,
      }
    : {
        verdict: "failed",
        reason: `probe ${o.probe.code} did not improve the class (${o.probe.reasons
          .map((r) => (typeof r === "string" ? r : r.code))
          .join(", ")})`,
      };
}

/** The state after a lane ends: parked once too many lanes failed. */
export function recordLane(
  state: LoopState,
  code: string,
  outcome: LaneOutcome,
): LoopState {
  const previous = state.classes[code] ?? { code, failedLanes: 0 };
  const failedLanes =
    previous.failedLanes + (outcome.verdict === "failed" ? 1 : 0);
  return {
    ...state,
    classes: {
      ...state.classes,
      [code]: {
        ...previous,
        code,
        failedLanes,
        openLane: undefined,
        parked: previous.parked || failedLanes >= LOOP_LIMITS.parkAfter,
      },
    },
  };
}

/**
 * A class counts as fixed when a full cycle (never a probe) puts its rate at
 * or below the threshold with the Wilson upper bound below it too, so the
 * number is not just a quiet night.
 */
export function classFixed(cls: FailureClass): boolean {
  const limit = fixedThreshold(cls.code);
  return cls.attemptRate <= limit && cls.wilson95[1] < limit;
}

/** The loop's own summary for the cycle report and the operator. */
export function loopReport(o: {
  cycle: CycleResults;
  lanes: { lane: Lane; outcome?: LaneOutcome }[];
  state: LoopState;
}): string {
  const lines = [
    `# Fix loop for ${o.cycle.cycle.id}`,
    "",
    `Revision ${o.cycle.cycle.gitRev}; ${o.cycle.failureClasses.length} failure classes, ${o.lanes.length} lane(s) planned.`,
    "",
  ];
  for (const { lane, outcome } of o.lanes) {
    lines.push(
      `- **${lane.code}** (${lane.owner}, ${pct(lane.attemptRate)}): ${lane.branch}` +
        (outcome ? ` — ${outcome.verdict}: ${outcome.reason}` : " — planned"),
    );
  }
  const parked = Object.values(o.state.classes).filter((c) => c.parked);
  if (parked.length)
    lines.push("", `Parked: ${parked.map((c) => c.code).join(", ")}.`);
  const fixed = Object.values(o.state.classes).filter((c) => c.fixed);
  if (fixed.length)
    lines.push(
      `Fixed at this revision: ${fixed.map((c) => c.code).join(", ")}.`,
    );
  lines.push(
    "",
    "Every branch above is for review: the loop merges nothing, and a change that weakens a safety floor is refused outright.",
  );
  return lines.join("\n");
}
