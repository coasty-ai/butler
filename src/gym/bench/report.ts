import type { BenchCategory, BenchDifficulty, GradeStatus } from "./types";

/** One graded attempt at one task. */
export interface AttemptResult {
  taskId: string;
  category: BenchCategory;
  difficulty: BenchDifficulty;
  /** 1-based repeat index. */
  attempt: number;
  status: GradeStatus;
  /** Fixed reason code when the attempt did not pass. */
  reason?: string;
  checks: Record<string, boolean>;
  /** Terminal run status, or "skipped" when the attempt never ran. */
  runStatus: string;
  actions: number;
  seconds: number;
  cost: number;
  modelCalls: number;
  approvals: number;
  approvalsDeclined: number;
  retries: number;
  takeovers: number;
  loops: number;
  failures: Record<string, number>;
}

export interface CategoryTotals {
  attempts: number;
  passed: number;
  failed: number;
  unknown: number;
  successRate: number;
}

export interface Aggregate {
  attempts: number;
  /** Attempts that actually drove the desktop (skipped ones excluded). */
  ran: number;
  passed: number;
  failed: number;
  unknown: number;
  /** passed / attempts. Unknown attempts count against it. */
  successRate: number;
  /** passed / (passed + failed), or null when nothing could be graded. */
  gradedSuccessRate: number | null;
  medianActions: number;
  medianSeconds: number;
  totalCost: number;
  totalSeconds: number;
  approvals: number;
  approvalsDeclined: number;
  retries: number;
  takeovers: number;
  loops: number;
  /** Failure codes summed over every attempt. */
  failures: Record<string, number>;
  byCategory: Record<string, CategoryTotals>;
}

/** An attempt that never ran contributes no effort numbers. */
export const ran = (result: AttemptResult) => result.runStatus !== "skipped";

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

export function aggregate(results: AttemptResult[]): Aggregate {
  const executed = results.filter(ran);
  const passed = results.filter((r) => r.status === "passed").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const unknown = results.filter((r) => r.status === "unknown").length;
  const failures: Record<string, number> = {};
  const byCategory: Record<string, CategoryTotals> = {};
  for (const result of results) {
    tally(failures, result.failures);
    const totals = (byCategory[result.category] ??= {
      attempts: 0,
      passed: 0,
      failed: 0,
      unknown: 0,
      successRate: 0,
    });
    totals.attempts++;
    totals[result.status]++;
  }
  for (const totals of Object.values(byCategory))
    totals.successRate = totals.attempts ? totals.passed / totals.attempts : 0;
  const sum = (pick: (r: AttemptResult) => number) =>
    results.reduce((total, result) => total + pick(result), 0);
  return {
    attempts: results.length,
    ran: executed.length,
    passed,
    failed,
    unknown,
    successRate: results.length ? passed / results.length : 0,
    gradedSuccessRate: passed + failed ? passed / (passed + failed) : null,
    medianActions: median(executed.map((r) => r.actions)),
    medianSeconds: median(executed.map((r) => r.seconds)),
    totalCost: sum((r) => r.cost),
    totalSeconds: sum((r) => r.seconds),
    approvals: sum((r) => r.approvals),
    approvalsDeclined: sum((r) => r.approvalsDeclined),
    retries: sum((r) => r.retries),
    takeovers: sum((r) => r.takeovers),
    loops: sum((r) => r.loops),
    failures,
    byCategory,
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
 * The per-attempt table. It holds task ids, counts, durations, cost and fixed
 * reason codes only, so it is safe to paste into an issue.
 */
export function renderTable(results: AttemptResult[]): string {
  const header = [
    "task",
    "#",
    "result",
    "act",
    "secs",
    "cost",
    "appr",
    "retry",
    "tko",
    "reason",
  ];
  const rows = results.map((result) => [
    result.taskId,
    String(result.attempt),
    MARK[result.status],
    String(result.actions),
    result.seconds.toFixed(1),
    money(result.cost),
    String(result.approvals),
    String(result.retries),
    String(result.takeovers),
    result.status === "passed" ? "" : (result.reason ?? ""),
  ]);
  const widths = header.map((name, column) =>
    Math.max(name.length, ...rows.map((row) => row[column].length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, column) =>
        pad(cell, widths[column], column > 1 && column < 9),
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
    `attempts ${totals.attempts} (ran ${totals.ran})  passed ${totals.passed}  failed ${totals.failed}  unknown ${totals.unknown}`,
    `success rate ${percent(totals.successRate)}` +
      (totals.gradedSuccessRate === null
        ? "  (nothing could be graded)"
        : `  of graded attempts ${percent(totals.gradedSuccessRate)}`),
    `median actions ${totals.medianActions}  median seconds ${totals.medianSeconds.toFixed(1)}  total cost ${money(totals.totalCost)}`,
    `approvals ${totals.approvals} (declined ${totals.approvalsDeclined})  retries ${totals.retries}  takeovers ${totals.takeovers}  loops ${totals.loops}`,
  ];
  const failures = Object.entries(totals.failures).sort((a, b) => b[1] - a[1]);
  if (failures.length)
    lines.push(
      "failure codes  " +
        failures.map(([code, count]) => `${code} ${count}`).join("  "),
    );
  const categories = Object.entries(totals.byCategory).sort((a, b) =>
    a[0] < b[0] ? -1 : 1,
  );
  if (categories.length)
    lines.push(
      "by category    " +
        categories
          .map(
            ([name, totals]) => `${name} ${totals.passed}/${totals.attempts}`,
          )
          .join("  "),
    );
  return lines.join("\n");
}
