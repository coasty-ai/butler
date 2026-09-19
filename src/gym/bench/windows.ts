import { join, resolve, sep } from "node:path";
import { BROWSER_APPS, FINDER, TEXTEDIT } from "./graders";
import { BENCH_ROOT } from "./readers";
import type { AttemptResult } from "./report";
import type { BenchTask } from "./types";

/**
 * What an attempt leaves open, and what the harness may close. An attempt
 * leaves what it opened open (the harness never quits an application), so a
 * cycle ends with TextEdit documents and Finder windows on the bench folder
 * that nothing closed; and a document the model saved somewhere else under a
 * name without the token (TextEdit's iCloud folder, "Untitled.rtf") is
 * invisible to the token sweep, stays open, and counts as the person's at the
 * next start, which skips every task listing TextEdit (APPS_OPEN).
 *
 * Two rules, both pure over facts read through an injectable `run`:
 *
 * - Accounting: a snapshot of the task's applications' windows (titles, from
 *   System Events) and of TextEdit's documents (path and modified flag, from
 *   TextEdit) before and after each attempt; what is there after and was not
 *   before is the attempt's. Titles stay in memory; a row carries counts by
 *   bundle id and, for a document saved outside ~/OpenAssistBench, its path,
 *   the one path the harness ever writes, since only a person may delete it.
 * - Closing: the final sweep and --cleanup-only close what holds nothing: a
 *   TextEdit document under ~/OpenAssistBench or one an attempt created, when
 *   `modified` is false (`close ... saving no`; a saved document's window is
 *   the file, which stays), and a Finder window on ~/OpenAssistBench. A
 *   modified document is never closed, only reported; when TextEdit shows a
 *   sheet or dialog nothing is clicked. No file outside ~/OpenAssistBench is
 *   ever deleted or trashed here.
 */

/** Runs a command; undefined when it failed or timed out (harness-cycle.mjs `run`). */
export type Run = (
  command: string,
  args: string[],
) => Promise<string | undefined>;

/** Between a record's fields and between records: never in a title or a path. */
export const FIELD = "";
export const RECORD = "";

/** What the sweep leaves standing, for remainingLeftovers and the report. */
export const WINDOW_LEFTOVERS = {
  /** A document an attempt created has unsaved changes: never closed. */
  modified: "LEFTOVER_MODIFIED_DOCUMENT",
  /** TextEdit shows a sheet or dialog: nothing was clicked or closed there. */
  dialog: "TEXTEDIT_DIALOG",
  /** Finder or TextEdit did not answer (no consent, a hung query): nothing closed there. */
  unverified: "WINDOW_SWEEP_UNVERIFIED",
} as const;
/** A row's code for a document saved outside the bench folder (strayDocuments names it). */
export const STRAY_DOCUMENT = "LEFTOVER_STRAY_DOCUMENT";

export interface OpenDocument {
  /** The name the application shows (its window title). */
  name: string;
  /** POSIX path of the saved file; undefined for an unsaved document. */
  path?: string;
  modified: boolean;
}

export interface FinderWindow {
  id: number;
  /** POSIX path of the folder shown; undefined for Recents, AirDrop, a search. */
  target?: string;
}

export interface WindowSnapshot {
  /** Window titles by bundle id; undefined per id when System Events did not answer. */
  titles: Record<string, string[] | undefined>;
  /** TextEdit's open documents; undefined when TextEdit was not asked or did not answer. */
  documents?: OpenDocument[];
}

/* ---------------------------------------------------------------- scripts */

const BUNDLE_ID = /^[A-Za-z0-9.-]{1,120}$/;

/**
 * Every window title of a running application, from System Events (the
 * same read-only target the preflight's count uses, so no new consent). An
 * application not running answers nothing at all, never a launch.
 */
export function titlesScript(bundleId: string): string {
  if (!BUNDLE_ID.test(bundleId)) throw new Error("Not a bundle id.");
  return [
    'tell application "System Events"',
    `  set procs to every process whose bundle identifier is "${bundleId}"`,
    '  if (count of procs) is 0 then return ""',
    '  set out to ""',
    "  repeat with w in windows of item 1 of procs",
    '    set t to ""',
    "    try",
    "      set t to name of w as text",
    "    end try",
    "    set out to out & t & (character id 30)",
    "  end repeat",
    "  return out",
    "end tell",
  ].join("\n");
}

/**
 * How many sheets and dialogs an application shows, from System Events. A
 * Save panel, an alert or a "revert changes?" question in front means the
 * sweep closes nothing of that application's: a close would queue behind it.
 */
export function dialogScript(bundleId: string): string {
  if (!BUNDLE_ID.test(bundleId)) throw new Error("Not a bundle id.");
  return [
    'tell application "System Events"',
    `  set procs to every process whose bundle identifier is "${bundleId}"`,
    '  if (count of procs) is 0 then return "0"',
    "  set n to 0",
    "  repeat with w in windows of item 1 of procs",
    "    try",
    "      set n to n + (count of sheets of w)",
    "    end try",
    "    try",
    '      if (subrole of w as text) is in {"AXDialog", "AXSystemDialog"} then set n to n + 1',
    "    end try",
    "  end repeat",
    "  return n as text",
    "end tell",
  ].join("\n");
}

/**
 * TextEdit's open documents: name, path ("" when unsaved) and whether it has
 * unsaved changes. Guarded by `is running`, which never launches: a `tell`
 * to an application that is not running would start it.
 */
export function documentsScript(): string {
  return [
    'if not (application "TextEdit" is running) then return ""',
    'tell application "TextEdit"',
    '  set out to ""',
    "  repeat with d in documents",
    '    set p to ""',
    "    try",
    "      set q to path of d",
    "      if q is not missing value then set p to q as text",
    "    end try",
    '    set m to "1"',
    "    try",
    '      if (modified of d) is false then set m to "0"',
    "    end try",
    "    set out to out & (name of d as text) & (character id 31) & p & (character id 31) & m & (character id 30)",
    "  end repeat",
    "  return out",
    "end tell",
  ].join("\n");
}

/** Every Finder window with its id and the folder it shows. */
export function finderWindowsScript(): string {
  return [
    'tell application "Finder"',
    '  set out to ""',
    "  repeat with w in Finder windows",
    '    set t to ""',
    "    try",
    "      set t to POSIX path of (target of w as alias)",
    "    end try",
    "    set out to out & (id of w as text) & (character id 31) & t & (character id 30)",
    "  end repeat",
    "  return out",
    "end tell",
  ].join("\n");
}

/**
 * Closes the one TextEdit document at the path given as the script's
 * argument (argv, never interpolated: a path may hold any character), and
 * only when it has no unsaved changes, checked again here. Answers "closed",
 * "modified" or "absent".
 */
export const CLOSE_DOCUMENT_SCRIPT = [
  "on run argv",
  "  set p to item 1 of argv",
  '  if not (application "TextEdit" is running) then return "absent"',
  '  tell application "TextEdit"',
  "    repeat with d in documents",
  "      set q to missing value",
  "      try",
  "        set q to path of d",
  "      end try",
  "      if q is not missing value and (q as text) is p then",
  '        if modified of d then return "modified"',
  "        close d saving no",
  '        return "closed"',
  "      end if",
  "    end repeat",
  "  end tell",
  '  return "absent"',
  "end run",
].join("\n");

/** As CLOSE_DOCUMENT_SCRIPT for an unsaved document, by the name TextEdit shows. */
export const CLOSE_UNTITLED_SCRIPT = [
  "on run argv",
  "  set n to item 1 of argv",
  '  if not (application "TextEdit" is running) then return "absent"',
  '  tell application "TextEdit"',
  "    repeat with d in documents",
  "      set q to missing value",
  "      try",
  "        set q to path of d",
  "      end try",
  "      if q is missing value and (name of d as text) is n then",
  '        if modified of d then return "modified"',
  "        close d saving no",
  '        return "closed"',
  "      end if",
  "    end repeat",
  "  end tell",
  '  return "absent"',
  "end run",
].join("\n");

/** Closes one Finder window by id (argv). Answers "closed" or "absent". */
export const CLOSE_FINDER_WINDOW_SCRIPT = [
  "on run argv",
  "  set i to (item 1 of argv) as integer",
  '  tell application "Finder"',
  '    if not (exists Finder window id i) then return "absent"',
  "    close Finder window id i",
  '    return "closed"',
  "  end tell",
  "end run",
].join("\n");

/* ---------------------------------------------------------------- parsing */

/** The records of a script's answer; undefined for anything that is not one (an error line). */
function records(stdout: string | undefined): string[] | undefined {
  if (stdout === undefined) return undefined;
  const text = stdout.replace(/\r?\n$/, "");
  if (text === "") return [];
  if (!text.includes(RECORD)) return undefined;
  const rows = text.split(RECORD);
  // Every record ends with the separator, so the last piece is empty.
  if (rows.pop() !== "") return undefined;
  return rows;
}

/** titlesScript's answer: one title per window ("" for one with no readable name). */
export function parseTitles(stdout: string | undefined): string[] | undefined {
  return records(stdout);
}

/** documentsScript's answer. */
export function parseDocuments(
  stdout: string | undefined,
): OpenDocument[] | undefined {
  const rows = records(stdout);
  if (!rows) return undefined;
  const out: OpenDocument[] = [];
  for (const row of rows) {
    const fields = row.split(FIELD);
    if (fields.length !== 3 || !/^[01]$/.test(fields[2])) return undefined;
    out.push({
      name: fields[0],
      ...(fields[1] ? { path: fields[1] } : {}),
      modified: fields[2] === "1",
    });
  }
  return out;
}

/** finderWindowsScript's answer. */
export function parseFinderWindows(
  stdout: string | undefined,
): FinderWindow[] | undefined {
  const rows = records(stdout);
  if (!rows) return undefined;
  const out: FinderWindow[] = [];
  for (const row of rows) {
    const fields = row.split(FIELD);
    if (fields.length !== 2 || !/^\d{1,12}$/.test(fields[0])) return undefined;
    out.push({
      id: Number(fields[0]),
      ...(fields[1] ? { target: fields[1] } : {}),
    });
  }
  return out;
}

/** dialogScript's answer; undefined for anything but a count. */
export function parseCount(stdout: string | undefined): number | undefined {
  const match = /^\s*(\d{1,9})\s*$/.exec(stdout ?? "");
  return match ? Number(match[1]) : undefined;
}

/* ------------------------------------------------------------------ paths */

/** `~/...` for a path under home, so a row never carries the user name. */
export function homeRelative(path: string, home: string): string {
  const root = resolve(home);
  if (path === root) return "~";
  return path.startsWith(root + sep) ? "~" + path.slice(root.length) : path;
}

/** The inverse, for a path read back from a row. */
export function expandHome(path: string, home: string): string {
  if (path === "~") return resolve(home);
  return path.startsWith("~/") ? join(resolve(home), path.slice(2)) : path;
}

/** Whether a path is ~/OpenAssistBench itself or anything inside it. */
export function underBenchRoot(path: string, home: string): boolean {
  const root = join(resolve(home), BENCH_ROOT);
  const full = resolve(expandHome(path, home));
  return full === root || full.startsWith(root + sep);
}

/* ------------------------------------------------------------- snapshots */

/**
 * The applications whose windows an attempt of this task is accounted for:
 * the Finder (the neutral start activates it and a file task opens folders
 * in it), the task's own applications, and the browser the harness chose
 * for it; never a browser the task lists but the attempt does not use,
 * whose tabs are the person's.
 */
export function snapshotApps(
  task: Pick<BenchTask, "apps">,
  browserId?: string,
): string[] {
  return [
    ...new Set([
      FINDER,
      ...task.apps.filter((id) => !BROWSER_APPS.includes(id)),
      ...(browserId ? [browserId] : []),
    ]),
  ];
}

/**
 * The windows of each application asked, one System Events query at a time,
 * and TextEdit's documents when TextEdit is among them and running (ps says;
 * an Apple Event to an application that is not running would launch it).
 */
export async function readWindowSnapshot(
  run: Run,
  apps: string[],
  running?: Set<string>,
): Promise<WindowSnapshot> {
  const titles: WindowSnapshot["titles"] = {};
  for (const id of apps)
    titles[id] = parseTitles(await run("osascript", ["-e", titlesScript(id)]));
  const snapshot: WindowSnapshot = { titles };
  if (apps.includes(TEXTEDIT) && (!running || running.has(TEXTEDIT)))
    snapshot.documents = parseDocuments(
      await run("osascript", ["-e", documentsScript()]),
    );
  return snapshot;
}

/** What tells one document from another: its path, or its name while unsaved. */
export const documentKey = (doc: Pick<OpenDocument, "name" | "path">) =>
  doc.path !== undefined ? `path:${doc.path}` : `name:${doc.name}`;

/** What appeared during an attempt: the attempt's leftover. */
export interface AttemptWindows {
  /** Windows open after the attempt that were not before, by bundle id. */
  windows: Record<string, number>;
  /** TextEdit documents open after the attempt that were not before. */
  documents: OpenDocument[];
}

/**
 * The difference of two snapshots. Titles are compared as a multiset per
 * application (two "Untitled" windows after one before is one new window);
 * an application either snapshot could not read is left out, since nothing
 * can be attributed on a partial view, and so are the documents when either
 * reading failed.
 */
export function attemptWindows(
  before: WindowSnapshot,
  after: WindowSnapshot,
): AttemptWindows {
  const windows: Record<string, number> = {};
  for (const [id, titles] of Object.entries(after.titles)) {
    const earlier = before.titles[id];
    if (!titles || !earlier) continue;
    const seen = new Map<string, number>();
    for (const title of earlier) seen.set(title, (seen.get(title) ?? 0) + 1);
    let added = 0;
    for (const title of titles) {
      const left = seen.get(title) ?? 0;
      if (left > 0) seen.set(title, left - 1);
      else added++;
    }
    if (added > 0) windows[id] = added;
  }
  const documents: OpenDocument[] = [];
  if (before.documents && after.documents) {
    const earlier = new Set(before.documents.map(documentKey));
    for (const doc of after.documents)
      if (!earlier.has(documentKey(doc))) documents.push(doc);
  }
  return { windows, documents };
}

/**
 * The documents an attempt saved outside ~/OpenAssistBench, home-relative
 * and sorted: the token sweep cannot find them (their names carry no token),
 * the harness never deletes a file outside the bench folder, and a person
 * needs the path to check each one and delete it.
 */
export function strayDocuments(
  documents: OpenDocument[],
  home: string,
): string[] {
  return [
    ...new Set(
      documents
        .filter((doc) => doc.path !== undefined)
        .filter((doc) => !underBenchRoot(doc.path!, home))
        .map((doc) => homeRelative(doc.path!, home)),
    ),
  ].sort();
}

/**
 * A row with the attempt's windows on it: the count of windows it left open
 * by bundle id, the paths of the documents it saved outside the bench
 * folder, and LEFTOVER_STRAY_DOCUMENT among its leftovers when there are any.
 * Titles never reach the row.
 */
export function withWindowFields<T extends Pick<AttemptResult, "leftovers">>(
  row: T,
  left: AttemptWindows,
  home: string,
): T & Pick<AttemptResult, "strayDocuments" | "leftoverWindows"> {
  const stray = strayDocuments(left.documents, home);
  const leftovers = [...(row.leftovers ?? [])];
  if (stray.length && !leftovers.includes(STRAY_DOCUMENT))
    leftovers.push(STRAY_DOCUMENT);
  return {
    ...row,
    ...(leftovers.length ? { leftovers } : {}),
    ...(stray.length ? { strayDocuments: stray } : {}),
    ...(Object.keys(left.windows).length
      ? { leftoverWindows: { ...left.windows } }
      : {}),
  };
}

/* ---------------------------------------------------------------- closing */

export interface WindowSweep {
  /** TextEdit documents closed with `saving no`, each unmodified at the time. */
  closedDocuments: number;
  /** Finder windows on ~/OpenAssistBench closed. */
  closedFinderWindows: number;
  /** Documents of the benchmark's kept open for their unsaved changes. */
  modifiedDocuments: number;
  /** TextEdit documents that are neither under the bench folder nor an attempt's: untouched. */
  otherDocuments: number;
  /** TextEdit showed a sheet or dialog: none of its documents was touched. */
  dialog: boolean;
  /** Applications that did not answer, by bundle id. */
  unread: string[];
  /** WINDOW_LEFTOVERS codes for what stands. */
  leftovers: string[];
}

/**
 * Closes what holds nothing, through one Apple Event per window: Finder
 * windows whose target is ~/OpenAssistBench or inside it; TextEdit
 * documents whose path is under it, or that an attempt created (`documents`
 * from attemptWindows, `paths` from rows' strayDocuments), when `modified`
 * is false, checked once in the listing and again in the close itself. A
 * modified document stays and is reported; a document of nobody's here (the
 * person's) is counted and never touched; with a sheet or dialog up in
 * TextEdit nothing there is closed and nothing is clicked. TextEdit is asked
 * only while `running` (ps) shows it: an event to it otherwise would launch
 * it. Never throws; a reading that fails is WINDOW_SWEEP_UNVERIFIED.
 */
export async function closeBenchWindows(input: {
  run: Run;
  home: string;
  documents?: OpenDocument[];
  paths?: string[];
  running: Set<string>;
}): Promise<WindowSweep> {
  const { run, home } = input;
  const sweep: WindowSweep = {
    closedDocuments: 0,
    closedFinderWindows: 0,
    modifiedDocuments: 0,
    otherDocuments: 0,
    dialog: false,
    unread: [],
    leftovers: [],
  };
  const unread = (id: string) => {
    if (!sweep.unread.includes(id)) sweep.unread.push(id);
  };
  const ask = async (script: string, args: string[] = []) =>
    (await run("osascript", ["-e", script, ...args]))?.trim();

  const finder = parseFinderWindows(await ask(finderWindowsScript()));
  if (!finder) unread(FINDER);
  else
    for (const window of finder) {
      if (!window.target || !underBenchRoot(window.target, home)) continue;
      const answer = await ask(CLOSE_FINDER_WINDOW_SCRIPT, [String(window.id)]);
      if (answer === "closed") sweep.closedFinderWindows++;
      else if (answer !== "absent") unread(FINDER);
    }

  if (input.running.has(TEXTEDIT)) {
    const dialogs = parseCount(await ask(dialogScript(TEXTEDIT)));
    if (dialogs === undefined) unread(TEXTEDIT);
    else if (dialogs > 0) sweep.dialog = true;
    else {
      const docs = parseDocuments(await ask(documentsScript()));
      if (!docs) unread(TEXTEDIT);
      else {
        const ours = new Set([
          ...(input.documents ?? []).map(documentKey),
          ...(input.paths ?? []).map(
            (path) => `path:${resolve(expandHome(path, home))}`,
          ),
        ]);
        for (const doc of docs) {
          const own =
            (doc.path !== undefined && underBenchRoot(doc.path, home)) ||
            ours.has(documentKey(doc));
          if (!own) {
            sweep.otherDocuments++;
            continue;
          }
          if (doc.modified) {
            sweep.modifiedDocuments++;
            continue;
          }
          const answer =
            doc.path !== undefined
              ? await ask(CLOSE_DOCUMENT_SCRIPT, [doc.path])
              : await ask(CLOSE_UNTITLED_SCRIPT, [doc.name]);
          if (answer === "closed") sweep.closedDocuments++;
          else if (answer === "modified") sweep.modifiedDocuments++;
          else if (answer !== "absent") unread(TEXTEDIT);
        }
      }
    }
  }

  if (sweep.modifiedDocuments) sweep.leftovers.push(WINDOW_LEFTOVERS.modified);
  if (sweep.dialog) sweep.leftovers.push(WINDOW_LEFTOVERS.dialog);
  if (sweep.unread.length) sweep.leftovers.push(WINDOW_LEFTOVERS.unverified);
  return sweep;
}

/** One line for the terminal: what the sweep closed and what it left. */
export function describeWindowSweep(sweep: WindowSweep): string {
  const parts = [
    `Closed ${sweep.closedDocuments} TextEdit document(s) and ${sweep.closedFinderWindows} Finder window(s) the attempts left on ~/${BENCH_ROOT}.`,
  ];
  if (sweep.modifiedDocuments)
    parts.push(
      `${sweep.modifiedDocuments} document(s) with unsaved changes stay open: save or discard them yourself.`,
    );
  if (sweep.dialog)
    parts.push(
      "A dialog is up in TextEdit: nothing there was clicked or closed; dismiss it yourself.",
    );
  if (sweep.unread.length)
    parts.push(
      `${sweep.unread.join(", ")} did not answer (no Automation consent from this terminal, or a hung query): nothing there was closed.`,
    );
  if (sweep.otherDocuments)
    parts.push(
      `${sweep.otherDocuments} other TextEdit document(s) stay open; they are not the benchmark's to close, and a task listing TextEdit is skipped while they are.`,
    );
  return parts.join(" ");
}

/**
 * The paths rows name, for the final line and the report: every document
 * an attempt saved outside the bench folder, once each, with the remedy.
 */
export function strayDocumentsLine(
  rows: Pick<AttemptResult, "strayDocuments">[],
): string | undefined {
  const paths = [
    ...new Set(rows.flatMap((row) => row.strayDocuments ?? [])),
  ].sort();
  if (!paths.length) return undefined;
  return `Documents saved outside ~/${BENCH_ROOT}, which the harness never deletes: ${paths.join(", ")}. Check each and delete it yourself.`;
}
