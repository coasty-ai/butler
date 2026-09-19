import { CATALOGUE, CATEGORIES, selectTasks } from "./catalogue";
import { LONG_CATALOGUE, LONG_CATEGORIES } from "./catalogue-long";
import { MARKET_CATALOGUE, MARKET_CATEGORIES } from "./catalogue-market";
import type { BenchCategory, BenchSuite, BenchTask } from "./types";

/**
 * Suite selection over the three catalogues: the smoke suite (the default,
 * so `npm run bench` is unchanged), the long-horizon suite and the market
 * suite, or all of them. Ids are unique across suites, so a stored plan
 * resolves against "all" whatever suite it was drawn from.
 */

export type SuiteSelector = BenchSuite | "all";
export const SUITE_SELECTORS: SuiteSelector[] = [
  "smoke",
  "long",
  "market",
  "all",
];
const BY_SUITE: Record<BenchSuite, BenchTask[]> = {
  smoke: CATALOGUE,
  long: LONG_CATALOGUE,
  market: MARKET_CATALOGUE,
};
const CATEGORIES_BY_SUITE: Record<BenchSuite, BenchCategory[]> = {
  smoke: CATEGORIES,
  long: LONG_CATEGORIES,
  market: MARKET_CATEGORIES,
};

/** The tasks of one suite, or of every suite. */
export function catalogueFor(suite: SuiteSelector = "smoke"): BenchTask[] {
  return suite === "all"
    ? Object.values(BY_SUITE).flat()
    : [...BY_SUITE[suite]];
}
export function categoriesFor(suite: SuiteSelector = "smoke"): BenchCategory[] {
  return suite === "all"
    ? [...new Set(Object.values(CATEGORIES_BY_SUITE).flat())]
    : [...CATEGORIES_BY_SUITE[suite]];
}

/**
 * selectTasks over a suite, where a suite name in the selector ("long",
 * "market", "all") selects that whole suite; ids and categories resolve
 * against the suite chosen.
 */
export function selectSuite(
  selector: string | undefined,
  suite: SuiteSelector = "smoke",
): { tasks: BenchTask[]; unknown: string[] } {
  const parts = (selector ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const suites = parts.filter((part): part is SuiteSelector =>
    SUITE_SELECTORS.includes(part as SuiteSelector),
  );
  const rest = parts.filter(
    (part) => !SUITE_SELECTORS.includes(part as SuiteSelector),
  );
  const tasks: BenchTask[] = [];
  const add = (found: BenchTask[]) => {
    for (const task of found) if (!tasks.includes(task)) tasks.push(task);
  };
  for (const name of suites) add(catalogueFor(name));
  if (!rest.length && suites.length) return { tasks, unknown: [] };
  const picked = selectTasks(
    rest.length ? rest.join(",") : undefined,
    catalogueFor(suite),
  );
  add(picked.tasks);
  return { tasks, unknown: picked.unknown };
}

/**
 * The suite a selection belongs to, for a plan and its report: the one
 * suite every task is from, or "all" when they mix.
 */
export function suiteOf(tasks: Pick<BenchTask, "suite">[]): SuiteSelector {
  const suites = new Set(tasks.map((task) => task.suite ?? "smoke"));
  return suites.size === 1 ? [...suites][0] : "all";
}

/**
 * A task from the long or the market suite: it works on documents,
 * calendars and pages, gets a bench folder, the end-state readers and the
 * cleanup, and is skipped while one of its applications is already open.
 */
export const longHorizon = (task: Pick<BenchTask, "suite">) =>
  task.suite === "long" || task.suite === "market";
