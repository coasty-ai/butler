import { parseEnv } from "node:util";
import type { ProviderKind } from "../../core/schema";
import { providerKeyEnv } from "../../providers/catalog";
import { dayBoundary } from "./catalogue-long";
import {
  BROWSER_APPS,
  CALENDAR,
  FINDER,
  MUSIC,
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
    "Save your work and quit TextEdit, Calendar, Reminders, Notes, Music and System Settings before the night; the harness never quits an application.",
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
 * main executable `ps -axo pid=,command=` shows. The Finder and the browser
 * are always open and a task never types into a document of theirs;
 * Calculator holds nothing to lose and its graders need the entry in the
 * journal, so a result left on its display cannot pass.
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
  const running = new Set<string>();
  for (const line of (psText ?? "").split("\n"))
    for (const [id, executable] of Object.entries(DOCUMENT_APPS))
      if (executable.test(line)) running.add(id);
  return running;
}

/**
 * The document applications a person opened since the harness last looked,
 * from a fresh ps after a gate pass. At the first pass that is everything
 * running: the start's reading can be hours old, and the harness has
 * launched nothing yet. After a wait that saw a person, it is what was not
 * running when the last attempt ended; what an attempt opened stays open
 * (the harness never quits an application) and is the benchmark's own.
 * Nothing otherwise, and nothing from a ps that could not be read, which
 * the gate refuses to pass on by itself.
 */
export function openedByPerson(
  pass: { first: boolean; sawInput: boolean },
  psText: string | undefined,
  afterLast: Set<string> | undefined,
): Set<string> {
  if (psText === undefined || (!pass.first && !pass.sawInput)) return new Set();
  const now = runningDocumentApps(psText);
  if (pass.first) return now;
  return new Set([...now].filter((id) => !afterLast?.has(id)));
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
  /** Document applications running at the start. */
  running?: Set<string>;
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

/**
 * The first reason a task cannot run tonight, or undefined. Checked once at
 * the start; the time-dependent rules are in taskGate.
 */
export function startSkip(
  task: BenchTask,
  facts: StartFacts,
): TaskSkip | undefined {
  if (
    facts.installed &&
    requiredApps(task).some(
      (group) => !group.some((id) => facts.installed!.has(id)),
    )
  )
    return "APP_NOT_INSTALLED";
  // Long and market tasks edit documents, calendars and settings: one
  // already open may hold the person's unsaved work, which the model could
  // type into, and the harness never quits an application to find out.
  if (longHorizon(task) && task.apps.some((id) => facts.running?.has(id)))
    return "APPS_OPEN";
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
}

/**
 * The facts startSkips judges, for the selected tasks, from read-only reads
 * only: one Spotlight lookup per bundle id a task could need (ignoring case
 * the way LaunchServices does), ps, the bench root and the token ledger,
 * the agenda helper's `status` (never `setup`, which writes), and the
 * fixture check. harness-cycle.mjs and bench.mjs both start from these.
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
    running: runningDocumentApps(
      await source.run("ps", ["-axo", "pid=,command="]),
    ),
  };
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
  for (const task of tasks) {
    const code = startSkip(task, facts);
    if (code) skips.set(task.id, code);
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
