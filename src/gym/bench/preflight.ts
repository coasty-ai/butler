import { parseEnv } from "node:util";
import type { ProviderKind } from "../../core/schema";
import { providerKeyEnv } from "../../providers/catalog";
import { dayBoundary } from "./catalogue-long";
import {
  BROWSER_APPS,
  BROWSER_NAMES,
  BROWSER_PREFERENCE,
  CALENDAR,
  FINDER,
  MUSIC,
  namesBrowser,
  NOTES,
  REMINDERS,
  SETTINGS,
  TEXTEDIT,
  VSCODE_APPS,
} from "./graders";
import type { PreflightCode } from "./presence";
import { agendaKinds, parseAgendaFind, type AgendaKind } from "./readers";
import type { AttemptResult, TaskSkip } from "./report";
import { longHorizon } from "./suites";
import type { BenchTask } from "./types";

/**
 * What this Mac can run tonight, task by task. presence.ts answers "may an
 * unattended attempt start at all"; this module answers "which of the
 * selected tasks can", from facts the harness reads with read-only commands
 * (and, at the real start only, the agenda helper's idempotent `setup`).
 * A condition that concerns some tasks skips those tasks with a fixed code,
 * logged in the ledger and the report like any row, instead of refusing the
 * whole cycle; a resume retries every skip. Every rule is pure, so each code
 * is tested with fake inputs.
 */

/** Every code the harness can refuse or skip with, and what a person does about it. */
export type RemedyCode =
  PreflightCode | TaskSkip | "MISSING_KEY" | "NOTHING_TO_RUN";

/** One line each: what to do before leaving the Mac for the night. */
export const REMEDY: Record<RemedyCode, string> = {
  APP_RUNNING:
    "Quit the Butler app (a texted task would start a second agent on this desktop), or pass --allow-app-running.",
  HARNESS_RUNNING:
    "Another cycle or bench is driving this desktop (from this or another checkout); let it finish or stop it first.",
  SCREENSAVER_TOO_SOON:
    "Set Lock Screen > Start Screen Saver to Never (or beyond the time box) for the night; the lock that follows would stall the gate.",
  LOCKED: "Unlock the Mac and stay logged in on its own display.",
  DISPLAY_OFF: "Wake the display.",
  DISPLAY_HELD_BY_OTHER:
    "Something else holds the display awake (a call, a video, a caffeinate): end it, or name it with --allow-display-holder.",
  APP_RUN_ACTIVE:
    "The running app's log shows a run still in flight; let it finish or quit the app.",
  PRESENCE_UNKNOWN:
    "ps or pmset could not be read, so nothing can say whether another agent or a watched screen is here; try again.",
  SECURE_INPUT:
    "Secure event input is on: a password field has the keyboard (the gate line names the application when it can), and every attempt would hand off at once. Click somewhere else or close that window. A sign-in fixture page left in the benchmark's own browser is not this: the gate points its fixture tabs at about:blank itself, and quits that browser when the blank tabs still hold it.",
  MISSING_KEY:
    "Put the cell's key in .env under the name the app reads (OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY or GOOGLE_API_KEY), or drop the cell from --matrix.",
  NOTHING_TO_RUN:
    "Every selected task is skipped tonight: fix the skips listed below, or choose other tasks.",
  NO_AGENDA_ACCESS:
    "Build the helper (npm run build:native), run native/bin/coarena-agenda request in this terminal and grant Calendar and Reminders; an agenda task is skipped until every store it writes is granted.",
  NO_LOCAL_SOURCE:
    "The agenda helper's setup could not make the OpenAssistBench calendar or list in an On My Mac source; without one a bench item would sync to other devices, so the agenda tasks are skipped.",
  DAY_BOUNDARY:
    "None: agenda attempts wait out the hour either side of local midnight, when 'tomorrow' could change between prepare and grade; a resume runs them.",
  APP_NOT_INSTALLED:
    "Install the application in /Applications (or ~/Applications); the controller only launches from those folders, so a copy in Downloads does not count.",
  IDE_BLIND:
    "The editor showed the helper no accessibility tree in its first attempt; the rest of the ide category is skipped tonight.",
  FIXTURE_PORT:
    "Free port 47831 on 127.0.0.1 (another fixture server or a forgotten test server holds it); the browser and research tasks need it.",
  APPS_OPEN:
    "Save your work and quit the application named (TextEdit, Calendar, Reminders, Notes, Music, System Settings, or every browser a web task could use), or leave it open with no window; the harness never quits an application of yours (its own browser, holding secure event input with every fixture tab already blank, is the one it quits), and one an earlier attempt left open with only benchmark windows (titles carrying its token) does not count.",
  BENCH_ROOT_DIRTY:
    "An earlier cycle left benchmark items behind: run npm run cycle -- --cleanup-only, then remove by hand anything it still reports.",
};

/* ------------------------------------------------------------ provider keys */

/**
 * The names in a .env text whose value is not empty. Values are read to
 * tell empty from set and then dropped: nothing here keeps, returns or
 * prints one.
 */
export function presentKeyNames(envText: string | undefined): Set<string> {
  if (!envText) return new Set();
  try {
    const env = parseEnv(envText);
    return new Set(
      Object.entries(env)
        .filter(([, value]) => typeof value === "string" && value.trim())
        .map(([name]) => name),
    );
  } catch {
    return new Set();
  }
}

/** A cell with none of its provider's key names set cannot start (MISSING_KEY). */
export function missingKey(
  provider: ProviderKind,
  names: Set<string>,
): boolean {
  const wanted: readonly string[] =
    (providerKeyEnv as Partial<Record<ProviderKind, readonly string[]>>)[
      provider
    ] ?? [];
  return !wanted.some((name) => names.has(name));
}

/* ------------------------------------------------------------ applications */

/**
 * Whether the controller can launch an application from this path: the
 * roots Controller.swift applicationRoots() enumerates (system and user
 * Applications folders and one level of subfolders), Safari's cryptex, and
 * the Finder. A copy anywhere else (Downloads) cannot be opened by name.
 */
export function launchable(path: string, home: string): boolean {
  if (!/\.app\/?$/.test(path)) return false;
  if (path.replace(/\/$/, "") === "/System/Library/CoreServices/Finder.app")
    return true;
  const bundle = path.replace(/\/$/, "");
  const parent = bundle.slice(0, bundle.lastIndexOf("/"));
  const roots = [
    "/System/Applications",
    "/System/Applications/Utilities",
    "/System/Cryptexes/App/System/Applications",
    "/Applications",
    `${home}/Applications`,
  ];
  if (roots.includes(parent)) return true;
  // One level of subfolders under /Applications and ~/Applications.
  const grand = parent.slice(0, parent.lastIndexOf("/"));
  return (
    (grand === "/Applications" || grand === `${home}/Applications`) &&
    !parent.slice(grand.length + 1).startsWith(".") &&
    !parent.endsWith(".app")
  );
}

/**
 * The bundle ids that are launchable here, from one Spotlight lookup per id
 * (`mdfind "kMDItemCFBundleIdentifier == '<id>'c"`, undefined when it
 * failed). Spotlight off or broken finds nothing at all, not even the
 * Finder: that is no evidence of absence, so the answer is undefined and
 * nothing is skipped.
 */
export function installedApps(
  found: Record<string, string | undefined>,
  home: string,
): Set<string> | undefined {
  const paths = (text: string | undefined) =>
    (text ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  if (!paths(found[FINDER]).some((path) => launchable(path, home)))
    return undefined;
  const installed = new Set<string>();
  for (const [id, text] of Object.entries(found))
    // A lookup that failed is not a lookup that found nothing.
    if (
      text === undefined ||
      paths(text).some((path) => launchable(path, home))
    )
      installed.add(id);
  return installed;
}

/** Alternatives a task accepts any one of: "the browser", "the editor". */
const ALTERNATIVES = [BROWSER_APPS, VSCODE_APPS];

/**
 * What a task needs installed: every application it names, except that a
 * group of alternatives (any browser, any VS Code build) needs only one.
 */
export function requiredApps(task: Pick<BenchTask, "apps">): string[][] {
  const groups: string[][] = [];
  const rest = [...task.apps];
  for (const group of ALTERNATIVES) {
    const named = rest.filter((id) => group.includes(id));
    if (!named.length) continue;
    groups.push(named);
    for (const id of named) rest.splice(rest.indexOf(id), 1);
  }
  return [...groups, ...rest.map((id) => [id])];
}

/** Every bundle id any selected task could need, for the Spotlight lookups. */
export function appIdsToCheck(tasks: Pick<BenchTask, "apps">[]): string[] {
  return [...new Set([FINDER, ...tasks.flatMap((task) => task.apps)])];
}

/**
 * Applications whose open windows can hold a person's unsaved work, by the
 * main executable `ps -axo pid=,command=` shows. The Finder is always open
 * and a task never types into a window of its; a browser in the person's
 * use is avoided by choosing the other one (chooseBrowser) rather than by a
 * skip; Calculator holds nothing to lose and its graders need the entry in
 * the journal, so a result left on its display cannot pass.
 */
export const DOCUMENT_APPS: Record<string, RegExp> = {
  [TEXTEDIT]: /\/TextEdit\.app\/Contents\/MacOS\/TextEdit(\s|$)/,
  [CALENDAR]: /\/Calendar\.app\/Contents\/MacOS\/Calendar(\s|$)/,
  [REMINDERS]: /\/Reminders\.app\/Contents\/MacOS\/Reminders(\s|$)/,
  [NOTES]: /\/Notes\.app\/Contents\/MacOS\/Notes(\s|$)/,
  [MUSIC]: /\/Music\.app\/Contents\/MacOS\/Music(\s|$)/,
  [SETTINGS]: /\/System Settings\.app\/Contents\/MacOS\/System Settings(\s|$)/,
  "com.microsoft.VSCode":
    /\/Visual Studio Code\.app\/Contents\/MacOS\/[^/\s]+(\s|$)/,
};
/** The document applications running now, from ps output. */
export function runningDocumentApps(psText: string | undefined): Set<string> {
  return runningOf(psText, DOCUMENT_APPS);
}

/**
 * The browsers' main executables, by the same ps line. Helper processes
 * (renderers, GPU, networking) live under Contents/Frameworks and never
 * match. A browser is not a document application: it is never a skip reason
 * on its own, only one alternative fewer for chooseBrowser, and it counts
 * only for tasks whose instruction names the choice.
 */
export const BROWSER_EXECUTABLES: Record<string, RegExp> = {
  "com.apple.Safari": /\/Safari\.app\/Contents\/MacOS\/Safari(\s|$)/,
  "com.apple.SafariTechnologyPreview":
    /\/Safari Technology Preview\.app\/Contents\/MacOS\/Safari Technology Preview(\s|$)/,
  "com.google.Chrome":
    /\/Google Chrome\.app\/Contents\/MacOS\/Google Chrome(\s|$)/,
  "com.google.Chrome.canary":
    /\/Google Chrome Canary\.app\/Contents\/MacOS\/Google Chrome Canary(\s|$)/,
  "com.microsoft.edgemac":
    /\/Microsoft Edge\.app\/Contents\/MacOS\/Microsoft Edge(\s|$)/,
  "org.mozilla.firefox": /\/Firefox\.app\/Contents\/MacOS\/firefox(\s|$)/,
  "com.brave.Browser":
    /\/Brave Browser\.app\/Contents\/MacOS\/Brave Browser(\s|$)/,
  "com.operasoftware.Opera": /\/Opera\.app\/Contents\/MacOS\/Opera(\s|$)/,
  "com.vivaldi.Vivaldi": /\/Vivaldi\.app\/Contents\/MacOS\/Vivaldi(\s|$)/,
  "company.thebrowser.Browser": /\/Arc\.app\/Contents\/MacOS\/Arc(\s|$)/,
  "company.thebrowser.dia": /\/Dia\.app\/Contents\/MacOS\/Dia(\s|$)/,
};
/** The document applications and browsers running now, from ps output. */
export function runningApps(psText: string | undefined): Set<string> {
  return runningOf(psText, { ...DOCUMENT_APPS, ...BROWSER_EXECUTABLES });
}
function runningOf(
  psText: string | undefined,
  executables: Record<string, RegExp>,
): Set<string> {
  const running = new Set<string>();
  for (const line of (psText ?? "").split("\n"))
    for (const [id, executable] of Object.entries(executables))
      if (executable.test(line)) running.add(id);
  return running;
}

/**
 * The applications a person opened since the harness last looked, from a
 * fresh ps after a gate pass. At the first pass that is everything running:
 * the start's reading can be hours old, and the harness has launched
 * nothing yet. After a wait that saw a person, it is what was not running
 * when the last attempt ended; what an attempt opened stays open (the
 * harness never quits an application of the person's; its own browser,
 * quit to release secure event input, is taken off that set at the quit)
 * and is the benchmark's own. Nothing otherwise, and nothing from a ps that
 * could not be read, which the gate refuses to pass on by itself.
 */
export function openedByPerson(
  pass: { first: boolean; sawInput: boolean },
  psText: string | undefined,
  afterLast: Set<string> | undefined,
): Set<string> {
  if (psText === undefined || (!pass.first && !pass.sawInput)) return new Set();
  const now = runningApps(psText);
  if (pass.first) return now;
  return new Set([...now].filter((id) => !afterLast?.has(id)));
}

/* ---------------------------------------------------------------- windows */

/**
 * What System Events says about a running application's windows: how many,
 * and how many are not the benchmark's, a window whose title does not carry
 * a token (a person's document, an untitled one, one with no readable name).
 */
export interface WindowFacts {
  windows: number;
  foreign: number;
}

const BUNDLE_ID = /^[A-Za-z0-9.-]{1,120}$/;
/**
 * The one Apple Event the preflight sends: to System Events, read-only, for
 * the counts above. No title leaves the script, so nothing of the person's
 * reaches a log. The first such event from a terminal shows the Automation
 * consent prompt once; `--preflight`, run attended, is where it should
 * appear. Never sent to the application itself (Calculator takes none).
 */
export function windowScript(bundleId: string): string {
  if (!BUNDLE_ID.test(bundleId)) throw new Error("Not a bundle id.");
  return [
    'tell application "System Events"',
    `  set procs to every process whose bundle identifier is "${bundleId}"`,
    '  if (count of procs) is 0 then return "0 0"',
    "  set total to 0",
    "  set foreign to 0",
    "  repeat with w in windows of item 1 of procs",
    "    set total to total + 1",
    "    try",
    '      if (name of w as text) does not contain "benchnote" then set foreign to foreign + 1',
    "    on error",
    "      set foreign to foreign + 1",
    "    end try",
    "  end repeat",
    '  return (total as text) & " " & (foreign as text)',
    "end tell",
  ].join("\n");
}
/** The script's answer; undefined for anything but two counts (a hung or refused query). */
export function parseWindowFacts(
  stdout: string | undefined,
): WindowFacts | undefined {
  const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(stdout ?? "");
  if (!match) return undefined;
  const windows = Number(match[1]);
  const foreign = Number(match[2]);
  return foreign <= windows ? { windows, foreign } : undefined;
}
/** The window facts of each running application asked, one query at a time (one consent prompt, not several). */
export async function readWindowFacts(
  run: (command: string, args: string[]) => Promise<string | undefined>,
  ids: string[],
): Promise<Record<string, WindowFacts | undefined>> {
  const facts: Record<string, WindowFacts | undefined> = {};
  for (const id of ids)
    facts[id] = parseWindowFacts(
      await run("osascript", ["-e", windowScript(id)]),
    );
  return facts;
}
/**
 * An open application that cannot hold the person's work: no window at all,
 * or only windows whose title carries a benchmark token, which is what an
 * earlier attempt leaves behind (a TextEdit document named with it, a
 * fixture page titled "Orders · benchnote1a2b"). Windows that could not be
 * read, no consent or a hung query included, keep the skip.
 */
export function safeOpen(
  id: string,
  facts: Pick<StartFacts, "windows">,
): boolean {
  const windows = facts.windows?.[id];
  return !!windows && (windows.windows === 0 || windows.foreign === 0);
}

/* --------------------------------------------------------------- browsers */

/** The browser an attempt uses: the name open_app takes, and the id the graders hold the run to. */
export interface BrowserChoice {
  id: string;
  name: string;
}

/**
 * The browser an attempt of this task uses, filled into its instruction as
 * `{browser}` and graded as the only browser: the first in
 * BROWSER_PREFERENCE among the task's browsers that is installed (when
 * Spotlight could say) and not running, else one running with no window of
 * the person's (safeOpen). Safari when Chrome is the one open, Chrome when
 * Safari is. Every alternative in the person's use means the task cannot
 * run without a browser that may hold their tabs: undefined, and
 * startSkipDetail says APPS_OPEN with those ids.
 */
export function chooseBrowser(
  task: Pick<BenchTask, "apps">,
  facts: Pick<StartFacts, "installed" | "running" | "windows">,
): BrowserChoice | undefined {
  // Spotlight silent: only Safari (on every Mac) and what is running are
  // known to exist, so no third browser is ever named for open_app to miss.
  const known =
    facts.installed ?? new Set(["com.apple.Safari", ...(facts.running ?? [])]);
  const candidates = BROWSER_PREFERENCE.filter(
    (id) => task.apps.includes(id) && known.has(id),
  );
  // One not running first (its windows will all be the fixture's), then one
  // the benchmark's by its windows: both are benchOwnBrowser, the rule the
  // fixture-tab reset acts under too.
  const id =
    candidates.find((candidate) => !facts.running?.has(candidate)) ??
    candidates.find((candidate) => benchOwnBrowser(candidate, facts));
  return id ? { id, name: BROWSER_NAMES[id] } : undefined;
}

/**
 * Whether a browser is the benchmark's own, to use and to reset: not
 * running (the attempt launches it, so every window it gets is the
 * fixture's), or running with no window of the person's (safeOpen: none, or
 * only titles carrying a token). The one rule chooseBrowser picks by and
 * browser-reset.ts navigates under; a browser this refuses is the person's,
 * and nothing of the harness ever touches a tab of it. `running` is the
 * start's reading plus what the person opened since (openedByPerson), so a
 * browser an attempt launched stays the benchmark's for the night.
 */
export function benchOwnBrowser(
  id: string,
  facts: Pick<StartFacts, "running" | "windows">,
): boolean {
  return !facts.running?.has(id) || safeOpen(id, facts);
}

/* -------------------------------------------------------------- the agenda */

/** Calendar and Reminders access from `coarena-agenda status`; undefined when unreadable. */
export function agendaAccess(
  statusStdout: string | undefined,
): { calendar: string; reminders: string } | undefined {
  // status prints the access object find prints, without items.
  return statusStdout === undefined
    ? undefined
    : parseAgendaFind(statusStdout)?.access;
}

/** The error code `coarena-agenda setup` failed with, if it failed. */
export function agendaSetupError(stdout: string | undefined): string {
  try {
    const last = (stdout ?? "").trim().split("\n").pop() ?? "";
    const data = JSON.parse(last) as { error?: unknown };
    return typeof data.error === "string" ? data.error : "";
  } catch {
    return "UNREADABLE";
  }
}

const STORE: Record<AgendaKind, "calendar" | "reminders"> = {
  event: "calendar",
  reminder: "reminders",
};

/* ----------------------------------------------------------- task-level */

/** Tasks that need a bench folder: the long and market suites, and anything with a reader. */
export function needsBenchDir(task: Pick<BenchTask, "suite" | "evidence">) {
  return longHorizon(task) || (task.evidence?.length ?? 0) > 0;
}

/** What the harness found before the first attempt. */
export interface StartFacts {
  /** Launchable bundle ids; undefined when Spotlight could not say. */
  installed?: Set<string>;
  /** Document applications and browsers running at the start (runningApps), plus what a person opened since. */
  running?: Set<string>;
  /**
   * What System Events said about the windows of the running applications
   * a selected task lists (readWindowFacts); undefined per id when it could
   * not say, and absent altogether when nothing asked (a dry run).
   */
  windows?: Record<string, WindowFacts | undefined>;
  /** ~/OpenAssistBench or the token ledger holds an earlier attempt's items. */
  benchRootDirty?: boolean;
  /**
   * `coarena-agenda status` (read-only): the access per store, or null when
   * there is no helper or it did not answer. Undefined: not asked (no
   * selected task writes the agenda).
   */
  agendaAccess?: { calendar: string; reminders: string } | null;
  /**
   * `coarena-agenda setup`, at the real start only: the stores it left
   * ready (parseAgendaSetup) and its error code, if any.
   */
  agendaSetup?: { ready: AgendaKind[]; error: string };
  /** The fixture server: false when its port is taken or it did not start. */
  fixture?: boolean;
}

/** A skip with what it was about: for APPS_OPEN, the applications open, by bundle id and nothing else. */
export interface SkipDetail {
  code: TaskSkip;
  apps?: string[];
}

/**
 * The applications open that keep a long or market task from running: its
 * required ones (TextEdit, Calendar, ...) that are running with a window
 * that could hold the person's work (not safeOpen), and, when its
 * instruction names the browser, every browser it could use if chooseBrowser
 * finds none free. Smoke tasks only open their application and are never
 * kept. Empty when the task can run.
 */
export function appsOpen(task: BenchTask, facts: StartFacts): string[] {
  if (!longHorizon(task)) return [];
  const open = task.apps.filter(
    (id) =>
      !BROWSER_APPS.includes(id) &&
      facts.running?.has(id) &&
      !safeOpen(id, facts),
  );
  const browsers = task.apps.filter((id) => BROWSER_APPS.includes(id));
  if (browsers.length && namesBrowser(task) && !chooseBrowser(task, facts))
    open.push(...browsers.filter((id) => facts.running?.has(id)));
  return open;
}

/**
 * The first reason a task cannot run tonight, with its detail, or
 * undefined. Checked once at the start; the time-dependent rules are in
 * taskGate.
 */
export function startSkipDetail(
  task: BenchTask,
  facts: StartFacts,
): SkipDetail | undefined {
  if (
    facts.installed &&
    requiredApps(task).some(
      (group) => !group.some((id) => facts.installed!.has(id)),
    )
  )
    return { code: "APP_NOT_INSTALLED" };
  // Long and market tasks edit documents, calendars and settings: one
  // already open may hold the person's unsaved work, which the model could
  // type into, and the harness never quits an application of the person's to find out. One
  // an earlier attempt left open shows only benchmark windows, or none, and
  // runs; a browser task takes the browser that is not the person's.
  const open = appsOpen(task, facts);
  if (open.length) return { code: "APPS_OPEN", apps: open };
  const code = startSkipRest(task, facts);
  return code ? { code } : undefined;
}

/** The first reason a task cannot run tonight, or undefined. */
export function startSkip(
  task: BenchTask,
  facts: StartFacts,
): TaskSkip | undefined {
  return startSkipDetail(task, facts)?.code;
}

/** The remedy for a skip, naming what was open for APPS_OPEN. */
export function skipRemedy(detail: SkipDetail): string {
  return detail.apps?.length
    ? `${REMEDY[detail.code]} Open now: ${detail.apps.join(", ")}.`
    : REMEDY[detail.code];
}

function startSkipRest(
  task: BenchTask,
  facts: StartFacts,
): TaskSkip | undefined {
  if (facts.benchRootDirty && needsBenchDir(task)) return "BENCH_ROOT_DIRTY";
  const kinds = agendaKinds(task);
  if (kinds.length) {
    if (facts.agendaAccess === null) return "NO_AGENDA_ACCESS";
    const access = facts.agendaAccess;
    if (access && kinds.some((kind) => access[STORE[kind]] !== "granted"))
      return "NO_AGENDA_ACCESS";
    const setup = facts.agendaSetup;
    if (setup && kinds.some((kind) => !setup.ready.includes(kind)))
      return setup.error === "NO_ACCESS"
        ? "NO_AGENDA_ACCESS"
        : "NO_LOCAL_SOURCE";
  }
  if (facts.fixture === false && task.evidence?.includes("fixture"))
    return "FIXTURE_PORT";
  return undefined;
}

/** What readStartFacts reads through: read-only commands and two checks. */
export interface StartFactsSource {
  /** Runs a read-only command; undefined when it failed or timed out. */
  run: (command: string, args: string[]) => Promise<string | undefined>;
  home: string;
  /** ~/OpenAssistBench or the token ledger holds an earlier attempt's items. */
  benchRootDirty: () => boolean;
  /** The agenda helper's path, or undefined when it is not built. */
  agendaBinary?: string;
  /** Whether the fixture server can serve: a free port, or one started. */
  fixture?: () => Promise<boolean>;
  /**
   * Ask System Events about the windows of the running applications the
   * long and market tasks list (readWindowFacts): an Apple Event, the first
   * of which from a terminal shows a consent prompt once. Off in a dry run,
   * which then reports every open application as a skip.
   */
  appleEvents?: boolean;
}

/** The running applications whose windows decide a selected long task's skip. */
export function appsToWatch(
  tasks: BenchTask[],
  running: Iterable<string>,
): string[] {
  return [...running].filter((id) =>
    tasks.some((task) => longHorizon(task) && task.apps.includes(id)),
  );
}

/**
 * The facts startSkips judges, for the selected tasks, from read-only reads
 * only: one Spotlight lookup per bundle id a task could need (ignoring case
 * the way LaunchServices does), ps, the bench root and the token ledger,
 * the agenda helper's `status` (never `setup`, which writes), the fixture
 * check and, when asked, System Events' window counts for the running
 * applications a long task lists. harness-cycle.mjs and bench.mjs both
 * start from these.
 */
export async function readStartFacts(
  tasks: BenchTask[],
  source: StartFactsSource,
): Promise<StartFacts> {
  const ids = appIdsToCheck(tasks);
  const found = await Promise.all(
    ids.map((id) =>
      source.run("mdfind", [`kMDItemCFBundleIdentifier == '${id}'c`]),
    ),
  );
  const facts: StartFacts = {
    installed: installedApps(
      Object.fromEntries(ids.map((id, i) => [id, found[i]])),
      source.home,
    ),
    running: runningApps(await source.run("ps", ["-axo", "pid=,command="])),
  };
  if (source.appleEvents)
    facts.windows = await readWindowFacts(
      source.run,
      appsToWatch(tasks, facts.running ?? []),
    );
  if (tasks.some(needsBenchDir)) {
    try {
      facts.benchRootDirty = source.benchRootDirty();
    } catch {
      // A ledger that cannot be read may hold anything.
      facts.benchRootDirty = true;
    }
  }
  if (tasks.some((task) => agendaKinds(task).length))
    facts.agendaAccess = source.agendaBinary
      ? (agendaAccess(await source.run(source.agendaBinary, ["status"])) ??
        null)
      : null;
  if (
    source.fixture &&
    tasks.some((task) => task.evidence?.includes("fixture"))
  )
    facts.fixture = await source.fixture();
  return facts;
}

/** Every selected task's start skip, by task id. */
export function startSkips(
  tasks: BenchTask[],
  facts: StartFacts,
): Map<string, TaskSkip> {
  const skips = new Map<string, TaskSkip>();
  for (const [id, detail] of startSkipDetails(tasks, facts))
    skips.set(id, detail.code);
  return skips;
}
/** Every selected task's start skip with its detail, by task id. */
export function startSkipDetails(
  tasks: BenchTask[],
  facts: StartFacts,
): Map<string, SkipDetail> {
  const skips = new Map<string, SkipDetail>();
  for (const task of tasks) {
    const detail = startSkipDetail(task, facts);
    if (detail) skips.set(task.id, detail);
  }
  return skips;
}

/**
 * An ide attempt that never saw the editor: it retried, and every retry was
 * on a surface with no accessibility at all (BLIND_SURFACE). The helper
 * never switches VS Code's tree on, so every later ide attempt tonight would
 * end the same way and pay for it.
 */
export function ideBlind(
  row: Pick<AttemptResult, "category" | "status" | "retries" | "blindRetries">,
): boolean {
  return (
    row.category === "ide" &&
    row.status !== "passed" &&
    row.retries > 0 &&
    (row.blindRetries ?? 0) === row.retries
  );
}

/**
 * The per-attempt check the cycle loop asks before (and again after) the
 * presence gate: a start skip, a category a result closed (IDE_BLIND), or
 * the hour around midnight for an agenda task (DAY_BOUNDARY).
 */
export function taskGate(
  tasks: Map<string, BenchTask>,
  skips: Map<string, TaskSkip>,
  now: () => Date,
): {
  skip: (entry: { taskId: string }) => TaskSkip | undefined;
  observe: (row: AttemptResult) => void;
} {
  const closed = new Map<string, TaskSkip>();
  return {
    skip(entry) {
      const task = tasks.get(entry.taskId);
      if (!task) return undefined;
      const early = skips.get(task.id) ?? closed.get(task.category);
      if (early) return early;
      if (agendaKinds(task).length && dayBoundary(now())) return "DAY_BOUNDARY";
      return undefined;
    },
    observe(row) {
      if (ideBlind(row)) closed.set("ide", "IDE_BLIND");
    },
  };
}
