import type { ScreenContext } from "../../core/schema";
import type {
  AgendaEvidence,
  AgendaItem,
  BenchTask,
  Evidence,
  FileEntry,
  FileEvidence,
  FixtureEvidence,
  Grade,
  JournalStep,
  MusicEvidence,
  RunJournal,
  TakeoverSource,
} from "./types";

/**
 * Deterministic grader helpers. Every one of them reads the end state the
 * native controller reported (frontmost bundle id, window title, accessibility
 * text, committed browser host), a reader the task declared (files, agenda,
 * music, fixture) or the run journal. None of them compares pixels, and none
 * of them returns screen text to the caller: a grade carries booleans and a
 * fixed reason code only.
 */

export const FINDER = "com.apple.finder";
export const TEXTEDIT = "com.apple.TextEdit";
export const CALENDAR = "com.apple.iCal";
export const REMINDERS = "com.apple.reminders";
export const SETTINGS = "com.apple.systempreferences";
// Lowercase: Calculator's own Info.plist says com.apple.calculator, which is
// what the helper reports as the frontmost bundle id and what the policy's
// Calculator rules compare against. Frontmost checks compare exactly.
export const CALCULATOR = "com.apple.calculator";
export const NOTES = "com.apple.Notes";
export const MUSIC = "com.apple.Music";
export const VSCODE_APPS = [
  "com.microsoft.VSCode",
  "com.microsoft.VSCodeInsiders",
  "com.vscodium",
];
/** The loopback fixture server's port; instructions name 127.0.0.1:<port>. */
export const FIXTURE_PORT = 47831;
/**
 * The one host the fixture server answers on. Dotted, so the instruction's
 * "127.0.0.1:<port>/<token>" passes normalizeHost, and the only web host an
 * unattended approval may be given on.
 */
export const FIXTURE_HOST = "127.0.0.1";
/** The marker namespace. Nothing of the user's is ever named this way. */
export const TOKEN_RE = /^benchnote[0-9a-z]{4}$/;

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

/** The host of a URL or bare host string, without `www.`, a port or a trailing dot. */
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
    // A bare address keeps its port ("127.0.0.1:47831/orders"); the URL
    // branch drops it through hostname, so this branch must too.
    host = trimmed.split("/")[0].split("?")[0].split("#")[0].split(":")[0];
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
  const flat = text.replace(/(?<=\d)[,    ](?=\d)/g, "");
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Not preceded by a digit or a decimal point, and not continued by more
  // digits: "5888" is not in "15888", "1.5888" or "5888.5".
  return new RegExp(`(?<![\\d.])${escaped}(?!\\.?\\d)`).test(flat);
}

/** True when every term appears in the text (each lowercased separately). */
export function containsAll(text: string, terms: string[]): boolean {
  return terms.every((term) => text.includes(term.toLowerCase()));
}

/* ---------------------------------------------------------------- journal */

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

/** True when the run typed at least `length` characters in one step, optionally in an app. */
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

export type StepMatch = (step: JournalStep, index: number) => boolean;
export const inApp =
  (appIds: string[]): StepMatch =>
  (step) =>
    !!step.appId && appIds.includes(step.appId);
export const launchOf =
  (appIds: string[]): StepMatch =>
  (step) =>
    !!step.launchedAppId && appIds.includes(step.launchedAppId);
export const menuLeafOf =
  (leaf: string): StepMatch =>
  (step) =>
    step.type === "menu_item" && step.menuLeaf === leaf.toLowerCase();
export const typedMarkerIn =
  (marker: string, appIds?: string[]): StepMatch =>
  (step) =>
    step.type === "type_text" &&
    (step.markers ?? []).includes(marker) &&
    (!appIds || !step.appId || appIds.includes(step.appId));
/** The marker was typed on its own at least once. A soft check: never make it hard. */
export function typedMarker(
  journal: RunJournal,
  marker: string,
  appIds?: string[],
): boolean {
  return journal.steps.some(typedMarkerIn(marker, appIds));
}
export function countSteps(journal: RunJournal, match: StepMatch): number {
  return journal.steps.filter(match).length;
}
/** Every matcher hits, and each first hit comes strictly after the previous matcher's first hit. */
export function inOrder(journal: RunJournal, ...matches: StepMatch[]): boolean {
  let last = -1;
  for (const match of matches) {
    const index = journal.steps.findIndex(
      (step, i) => i > last && match(step, i),
    );
    if (index < 0) return false;
    last = index;
  }
  return true;
}
const MUTATING = new Set([
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
/** Steps that can change anything. open_app, wait, scroll and capture are not counted. */
export function mutations(journal: RunJournal): number {
  return journal.steps.filter((step) => MUTATING.has(step.type)).length;
}
/**
 * How much the run entered into an application: characters typed plus keys
 * and clicks while it was frontmost. A value the display already showed
 * before the attempt cannot satisfy it, whichever way the model drives the app.
 */
export function inputCount(journal: RunJournal, appIds: string[]): number {
  let total = 0;
  for (const step of journal.steps) {
    if (!step.appId || !appIds.includes(step.appId)) continue;
    if (step.type === "type_text") total += step.textLength ?? 0;
    else if (
      ["key", "hotkey", "click", "double_click", "click_control"].includes(
        step.type,
      )
    )
      total += 1;
  }
  return total;
}
/**
 * The run gave up honestly: it asked the user, or proposed `fail`. The runner
 * records `fail` as a failed run with no hand-off, so a task that expects a
 * hand-off must accept both.
 */
export function honestHandoff(journal: RunJournal): boolean {
  return journal.takeoverSources.request_user >= 1 || journal.modelFailed;
}

/* ---------------------------------------------------------------- markers */

/** Parameter values long enough to be markers, never a short word or a digit. */
export function markerValues(parameters: Record<string, string>): string[] {
  return [...new Set(Object.values(parameters))].filter(
    (value) => value.length >= 6,
  );
}
/**
 * Which marker values the typed text carries on their own. A value inside a
 * longer parameter does not count: typing the bench folder path into Go to
 * Folder is not typing the token, even though the path contains it.
 */
export function markersIn(text: string, values: string[]): string[] {
  return values.filter((value) => {
    let stripped = text;
    for (const other of values)
      if (
        other !== value &&
        other.length > value.length &&
        other.includes(value)
      )
        stripped = stripped.split(other).join(" ");
    return stripped.includes(value);
  });
}

/* ------------------------------------------------------------------ files */

export function fileEntry(
  files: FileEvidence | undefined,
  relative: string,
): FileEntry | undefined {
  return files?.entries.find((entry) => entry.path === relative);
}
export function fileText(
  files: FileEvidence | undefined,
  relative: string,
): string {
  return fileEntry(files, relative)?.text ?? "";
}
export function filesMatching(
  files: FileEvidence | undefined,
  pattern: RegExp,
): FileEntry[] {
  return (files?.entries ?? []).filter((entry) => pattern.test(entry.path));
}
/** The bench folder holds exactly these paths (folders included), nothing else. */
export function onlyEntries(
  files: FileEvidence | undefined,
  expected: string[],
): boolean {
  const actual = new Set((files?.entries ?? []).map((entry) => entry.path));
  return (
    actual.size === expected.length &&
    expected.every((path) => actual.has(path))
  );
}
/** Line endings unified, trailing spaces and blank edges removed. */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}
export function occurrences(text: string, term: string): number {
  const needle = term.toLowerCase();
  return needle ? text.split(needle).length - 1 : 0;
}

/* ----------------------------------------------------------------- agenda */

export function agendaItems(
  agenda: AgendaEvidence | undefined,
  kind: AgendaItem["kind"],
  marker: string,
): AgendaItem[] {
  const needle = marker.toLowerCase();
  return (agenda?.items ?? []).filter(
    (item) => item.kind === kind && item.title.toLowerCase().includes(needle),
  );
}
export function daysFrom(base: Date, days: number): Date {
  const day = new Date(base);
  day.setDate(day.getDate() + days);
  return day;
}
export function sameLocalDay(iso: string | undefined, day: Date): boolean {
  if (!iso) return false;
  const date = new Date(iso);
  return (
    !Number.isNaN(date.getTime()) &&
    date.getFullYear() === day.getFullYear() &&
    date.getMonth() === day.getMonth() &&
    date.getDate() === day.getDate()
  );
}
export function localHour(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : date.getHours();
}

/* -------------------------------------------------- music, fixture, window */

export function playlistNamed(
  music: MusicEvidence | undefined,
  marker: string,
) {
  const needle = marker.toLowerCase();
  return music?.playlists.find((playlist) =>
    playlist.name.toLowerCase().includes(needle),
  );
}
export function visited(
  fixture: FixtureEvidence | undefined,
  path: string,
): boolean {
  return !!fixture?.visits.includes(path);
}
export function windowTitleHas(
  context: ScreenContext | undefined,
  term: string,
): boolean {
  return (context?.windowTitle ?? "")
    .toLowerCase()
    .includes(term.toLowerCase());
}

/* --------------------------------------------------------------- verdicts */

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

/**
 * verdict() plus partial credit. Soft checks are recorded (they explain a
 * run) but never fail it: a marker typed in two halves is not a wrong end
 * state.
 */
export function checked(
  checks: Record<string, boolean>,
  reasons: Record<string, string>,
  soft: string[] = [],
): Grade {
  const hard = Object.entries(checks).filter(([name]) => !soft.includes(name));
  const passed = hard.filter(([, ok]) => ok).length;
  const partial = hard.length ? passed / hard.length : 0;
  const first = hard.find(([, ok]) => !ok);
  return first
    ? {
        status: "failed",
        checks,
        reason: reasons[first[0]] ?? "FAILED",
        partial,
      }
    : { status: "passed", checks, partial };
}

/** The frontmost application, or undefined when the controller did not say. */
export function frontmost(evidence: Evidence): string | undefined {
  return typeof evidence.appId === "string" && evidence.appId
    ? evidence.appId
    : undefined;
}

/** The hand-off code for each source the runner reports, most specific first. */
const HANDOFF_CODES: [Exclude<TakeoverSource, "manual_input">, string][] = [
  ["request_user", "HANDOFF_REQUEST_USER"],
  ["handoff", "HANDOFF_TARGET"],
  ["policy", "HANDOFF_POLICY"],
  ["surface", "HANDOFF_SURFACE"],
];

/**
 * A run the user or the policy interrupted cannot be graded as automation.
 * A hand-off the agent asked for is a failure named by what asked for it;
 * real input on this Mac makes the attempt unknown, because the desktop
 * changed under the grader.
 */
export function holdOverride(journal: RunJournal): Grade | undefined {
  if (journal.manualTakeover || journal.takeoverSources.manual_input > 0)
    return unverifiable("MANUAL_TAKEOVER");
  if (journal.takeovers > 0) {
    const named = HANDOFF_CODES.find(
      ([source]) => journal.takeoverSources[source] > 0,
    );
    // A journal that counted a hand-off without its source keeps the old code.
    return {
      status: "failed",
      checks: {},
      reason: named ? named[1] : "HANDOFF_TAKEOVER",
    };
  }
  if (!journal.settled) return unverifiable("RUN_NOT_SETTLED");
  return undefined;
}

/**
 * Applies the shared pre-checks, then the task's own grader. A task that
 * expects a hand-off is graded on the hand-off itself, so only real input and
 * an unsettled run stop it from being graded.
 */
export function gradeTask(task: BenchTask, evidence: Evidence): Grade {
  const journal = evidence.journal;
  if (task.expectsHandoff) {
    if (journal.manualTakeover || journal.takeoverSources.manual_input > 0)
      return unverifiable("MANUAL_TAKEOVER");
    if (!journal.settled) return unverifiable("RUN_NOT_SETTLED");
    return task.grade(evidence);
  }
  return holdOverride(journal) ?? task.grade(evidence);
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

/* -------------------------------------------------------------- approvals */

/**
 * Questions no unattended run may ever answer yes to, whatever a task lists.
 * The list is a floor under the per-task allow-list, not the filter itself,
 * so it names every destructive prompt the policy can ask: a task author who
 * copies "Discard unsaved changes?" into `approve` to get past a close dialog
 * must not have the harness discard the user's own document.
 */
export const SENSITIVE_PROMPT =
  /\b(send|delete|pay|purchase|transaction|publish|install|password|security|order|subscription|share|upload|sign|call|revoke|disable|reset|erase|restart|shut down|quit|discard)/i;

/**
 * Whether the harness answers yes to an approval prompt. Only a reason the
 * task listed word for word, and only under --approve-routine: the policy asks
 * "Change this subscription?" and "Place this order?" in exactly the same
 * shape as "Save these changes?", so a blacklist cannot tell them apart.
 */
export function approvesPrompt(
  task: Pick<BenchTask, "approve">,
  reason: string,
  approveRoutine: boolean,
): boolean {
  return (
    approveRoutine &&
    Array.isArray(task.approve) &&
    task.approve.includes(reason) &&
    !SENSITIVE_PROMPT.test(reason)
  );
}

/**
 * What the attempt saw when the policy asked: bundle ids, a flag and web
 * hosts, never screen text.
 */
export interface ApprovalView {
  /** Frontmost bundle id from the surface the proposed action was checked on. */
  appId?: string;
  /** Frontmost bundle id of the frame the action was proposed on. */
  frameAppId?: string;
  /** The application owning the element under the pointer (Surface.targetAppId). */
  targetAppId?: string;
  /** A sheet, dialog or alert was focused or held the target (Surface.modal). */
  modal?: boolean;
  /** Host of the page the frontmost window shows (Surface.domain). */
  domain?: string;
  /** Host of the page holding the pointer target (Surface.targetWebHost). */
  targetWebHost?: string;
}

/**
 * The policy's question for the Find bar's Replace button and for a Save
 * panel's "already exists, replace it?" alike (policy.ts consequentialReason).
 */
export const REPLACE_REASON = "Replace the existing item?";
/**
 * The policy's catch-all for a consequential control with no more specific
 * word: a loopback form's Submit, and just as well a real site's Authorize,
 * Confirm, Join or Block (policy.ts consequentialReason).
 */
export const SUBMIT_REASON = "Submit or authorize this change?";

/**
 * Where each routine question may be answered yes, whatever else a task
 * lists: a Save or a Replace only in TextEdit, whose documents in these
 * tasks are the bench folder's, and a Submit only in a browser (on the
 * fixture host, below). A task listing browsers and TextEdit together must
 * not have a browser's Save approved, and a reason with no entry here is
 * never approved.
 */
export const APPROVAL_APPS: Readonly<Record<string, readonly string[]>> = {
  "Save these changes?": [TEXTEDIT],
  [REPLACE_REASON]: [TEXTEDIT],
  [SUBMIT_REASON]: BROWSER_APPS,
};

/**
 * The second half of an unattended yes, on top of approvesPrompt: the prompt
 * must have come up in one of the task's own applications that the reason is
 * scoped to (APPROVAL_APPS), on no web page but the fixture server's, and a
 * Replace only with no sheet or dialog in front. An allow-listed reason is a
 * question shape, not a place: "Save these changes?" asked while some other
 * application is frontmost would save that application's document, the
 * policy asks "Submit or authorize this change?" for a real site's OAuth
 * Authorize as for the loopback form's Submit, and the Save panel asks its
 * overwrite question as a sheet, which the Find bar never is. Unknown means
 * no: a view without a frontmost application, or a browser with no known
 * host, approves nothing.
 */
export function approvalInContext(
  task: Pick<BenchTask, "apps">,
  reason: string,
  view: ApprovalView,
): boolean {
  const scope = APPROVAL_APPS[reason] ?? [];
  const allowed = (id: string | undefined) =>
    !!id && (task.apps ?? []).includes(id) && scope.includes(id);
  if (!allowed(view.appId)) return false;
  if (view.frameAppId !== undefined && !allowed(view.frameAppId)) return false;
  // Every host known must be the fixture's, and a browser in front or under
  // the pointer must show one. The pointer's own application is held to
  // nothing more: another process can draw the front application's own
  // panels (a sandboxed TextEdit's Save panel is served out of process).
  const hosts = [view.domain, view.targetWebHost].filter(
    (host): host is string => host !== undefined,
  );
  if (hosts.some((host) => host.toLowerCase() !== FIXTURE_HOST)) return false;
  const browser = [view.appId, view.frameAppId, view.targetAppId].some(
    (id) => !!id && BROWSER_APPS.includes(id),
  );
  if (browser && !hosts.length) return false;
  if (reason === REPLACE_REASON && view.modal !== false) return false;
  return true;
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
