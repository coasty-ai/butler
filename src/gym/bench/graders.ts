import type { ScreenContext } from "../../core/schema";
import type {
  BenchTask,
  Evidence,
  Grade,
  JournalStep,
  RunJournal,
} from "./types";

/**
 * Deterministic grader helpers. Every one of them reads the end state the
 * native controller reported (frontmost bundle id, window title, accessibility
 * text, committed browser host) or the run journal. None of them compares
 * pixels, and none of them returns screen text to the caller: a grade carries
 * booleans and a fixed reason code only.
 */

/** Browsers whose frontmost bundle id satisfies a "the browser" task. */
export const BROWSER_APPS = [
  "com.apple.Safari",
  "com.apple.SafariTechnologyPreview",
  "com.google.Chrome",
  "com.google.Chrome.canary",
  "com.microsoft.edgemac",
  "org.mozilla.firefox",
  "com.brave.Browser",
  "com.operasoftware.Opera",
  "com.vivaldi.Vivaldi",
  "company.thebrowser.Browser",
  "company.thebrowser.dia",
];
/** Hosts that count as "a web search happened". */
export const SEARCH_HOSTS = [
  "google.com",
  "bing.com",
  "duckduckgo.com",
  "search.brave.com",
  "ecosia.org",
  "startpage.com",
  "search.yahoo.com",
  "yahoo.com",
];

/**
 * Every piece of accessibility text the controller reported for the frontmost
 * window, lowercased and joined. Used only for `includes` checks; never
 * returned in a result.
 */
export function accessibilityText(context?: ScreenContext): string {
  if (!context) return "";
  const parts: (string | undefined)[] = [
    context.appName,
    context.windowTitle,
    context.documentName,
    context.selectedText,
    context.visibleText,
    context.browserAddress,
    context.launcher?.query,
    context.launcher?.selectedResult,
  ];
  for (const control of context.controls ?? []) parts.push(control.label);
  for (const window of context.recentWindows ?? []) parts.push(window.title);
  return parts
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join(" | ")
    .toLowerCase();
}

/** The host of a URL or bare host string, without `www.` or a trailing dot. */
export function normalizeHost(value?: string): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  let host = trimmed;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      host = new URL(trimmed).hostname;
    } catch {
      return undefined;
    }
  } else {
    host = trimmed.split("/")[0].split("?")[0].split("#")[0];
    // A bare word with no dot is a search box query, not a host.
    if (!host.includes(".")) return undefined;
  }
  host = host.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("www.")) host = host.slice(4);
  return host || undefined;
}

/** True when `actual` is `expected` or a subdomain of it. */
export function hostMatches(actual?: string, expected?: string): boolean {
  const a = normalizeHost(actual);
  const b = normalizeHost(expected);
  if (!a || !b) return false;
  return a === b || a.endsWith("." + b);
}

/** True when any of `expected` matches. */
export function hostMatchesAny(
  actual: string | undefined,
  expected: string[],
): boolean {
  return expected.some((host) => hostMatches(actual, host));
}

/**
 * A number as a display shows it. Digit group separators between digits are
 * removed first, and the match may not run into a longer number, so "5888"
 * does not match "158882".
 */
export function containsNumber(text: string, value: string): boolean {
  const flat = text.replace(/(?<=\d)[,\u00a0\u202f\u2009 ](?=\d)/g, "");
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Not preceded by a digit or a decimal point, and not continued by more
  // digits: "5888" is not in "15888", "1.5888" or "5888.5".
  return new RegExp(`(?<![\\d.])${escaped}(?!\\.?\\d)`).test(flat);
}

/** True when every term appears in the text (each lowercased separately). */
export function containsAll(text: string, terms: string[]): boolean {
  return terms.every((term) => text.includes(term.toLowerCase()));
}

/** Executed steps of one action type. */
export function steps(journal: RunJournal, type: string): JournalStep[] {
  return journal.steps.filter((step) => step.type === type);
}

/** True when the run launched this bundle id with open_app. */
export function launchedApp(journal: RunJournal, appId: string): boolean {
  return journal.steps.some((step) => step.launchedAppId === appId);
}

/** The open_file step that opened exactly this home-relative path. */
export function openedPathStep(
  journal: RunJournal,
  path: string,
): JournalStep | undefined {
  return journal.steps.find(
    (step) => step.type === "open_file" && step.openedPath === path,
  );
}

/** True when the run typed at least `length` characters, optionally in an app. */
export function typedAtLeast(
  journal: RunJournal,
  length: number,
  appIds?: string[],
): boolean {
  return journal.steps.some(
    (step) =>
      step.type === "type_text" &&
      (step.textLength ?? 0) >= length &&
      (!appIds || !step.appId || appIds.includes(step.appId)),
  );
}

/** A grade with no checks, for the cases that stop grading before it starts. */
export function unverifiable(reason: string): Grade {
  return { status: "unknown", checks: {}, reason };
}

/**
 * Turns named checks into a grade: every check true passes, otherwise the
 * first false check names the failure.
 */
export function verdict(
  checks: Record<string, boolean>,
  reasons: Record<string, string>,
): Grade {
  for (const [name, ok] of Object.entries(checks))
    if (!ok)
      return { status: "failed", checks, reason: reasons[name] ?? "FAILED" };
  return { status: "passed", checks };
}

/** The frontmost application, or undefined when the controller did not say. */
export function frontmost(evidence: Evidence): string | undefined {
  return typeof evidence.appId === "string" && evidence.appId
    ? evidence.appId
    : undefined;
}

/**
 * A run the user or the policy interrupted cannot be graded as automation.
 * A hand-off the agent asked for is a failure; real input on this Mac makes
 * the attempt unknown, because the desktop changed under the grader.
 */
export function holdOverride(journal: RunJournal): Grade | undefined {
  if (journal.manualTakeover) return unverifiable("MANUAL_TAKEOVER");
  if (journal.takeovers > 0)
    return { status: "failed", checks: {}, reason: "HANDOFF_TAKEOVER" };
  if (!journal.settled) return unverifiable("RUN_NOT_SETTLED");
  return undefined;
}

/** Applies the shared pre-checks, then the task's own grader. */
export function gradeTask(task: BenchTask, evidence: Evidence): Grade {
  return holdOverride(evidence.journal) ?? task.grade(evidence);
}

/**
 * The common shape: the right application ended up frontmost, and its
 * accessibility text shows the expected result. Without accessibility text the
 * state check cannot run at all, so the attempt is unknown rather than passed;
 * an application that is not even frontmost is still a clear failure.
 */
export function gradeFrontmostAnd(
  evidence: Evidence,
  appIds: string[],
  extra?: (text: string, evidence: Evidence) => Record<string, boolean>,
  reasons: Record<string, string> = {},
): Grade {
  const app = frontmost(evidence);
  if (!app) return unverifiable("NO_FRONTMOST_INFO");
  const checks: Record<string, boolean> = { frontmost: appIds.includes(app) };
  const all = { frontmost: "NOT_FRONTMOST", ...reasons };
  if (!extra) return verdict(checks, all);
  const text = accessibilityText(evidence.context);
  if (!text)
    return checks.frontmost
      ? unverifiable("NO_ACCESSIBILITY")
      : verdict(checks, all);
  Object.assign(checks, extra(text, evidence));
  return verdict(checks, all);
}

/** Fills `{name}` placeholders in a task instruction. */
export function fillInstruction(
  instruction: string,
  parameters: Record<string, string>,
): string {
  return instruction.replace(/\{(\w+)\}/g, (match: string, name: string) =>
    Object.hasOwn(parameters, name) ? parameters[name] : match,
  );
}
