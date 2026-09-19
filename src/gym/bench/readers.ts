import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CALENDAR, REMINDERS, TOKEN_RE } from "./graders";
import type {
  AgendaEvidence,
  AgendaItem,
  AttemptContext,
  BenchTask,
  Cleanup,
  Evidence,
  EvidenceReaders,
  FileEntry,
  FileEvidence,
  MusicEvidence,
  PrepareContext,
} from "./types";

/**
 * The long suite's end-state readers and its cleanup, behind the contract in
 * types.ts (EvidenceReaders, Cleanup). A reader runs only when the task
 * declared it, reads only the attempt's own namespace (its bench folder, its
 * token) and never throws: a reader that cannot read yields no evidence, and
 * the grader then answers unknown rather than passed.
 *
 * Every external tool here is built into macOS (textutil, unzip, mdfind,
 * osascript) or is this repository's own agenda helper; none of them needs a
 * permission the controller has, and none of them posts input.
 *
 * The attempt's folder is always `<home>/OpenAssistBench/<token>`: the files
 * reader walks nothing else and cleanup deletes nothing else, so a harness
 * that passes some other folder gets no file evidence and CLEANUP_REFUSED.
 *
 * A token in a name does not make a thing the attempt's: a model can type the
 * token into the user's reminder or rename the user's file to it. Cleanup
 * therefore dates the attempt by its folder, which the harness creates empty
 * just before prepare(), and deletes only what was born after that. Anything
 * older is the user's: kept, moved out of the way at most, and reported.
 */

/** The bench root every attempt folder lives under, as `~/OpenAssistBench`. */
export const BENCH_ROOT = "OpenAssistBench";
const TEXT_LIMIT = 256 * 1024;
const ENTRY_LIMIT = 500;
const DEPTH_LIMIT = 6;

export type Exec = (
  file: string,
  args: string[],
  timeoutMs: number,
) => Promise<string>;

const execFileText: Exec = (file, args, timeoutMs) =>
  new Promise((done, fail) =>
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => (error ? fail(error) : done(String(stdout))),
    ),
  );

export interface ReaderOptions {
  exec?: Exec;
  /** The home folder the bench root lives under; tests point it at a temp dir. */
  home?: string;
  agendaBinary?: string;
  timeoutMs?: number;
  /**
   * When a path came into being, in epoch milliseconds, without following a
   * symlink; undefined when it cannot be read. Tests stand in a file that
   * existed before the attempt.
   */
  born?: (path: string) => number | undefined;
  /**
   * Read Music's player state through JXA. Off unless asked for: the first
   * Apple Event to Music from this terminal shows an Automation prompt, and
   * an unattended run must never leave a system dialog on screen. Grant it
   * once, attended (docs/BENCHMARK.md), then set OPEN_ASSIST_BENCH_MUSIC=1.
   */
  music?: boolean;
}

/** The environment switch for the Music reader, read once. */
export const MUSIC_READER_ENV = "OPEN_ASSIST_BENCH_MUSIC";

const here = dirname(fileURLToPath(import.meta.url));
export const AGENDA_BINARY = resolve(
  here,
  "../../../native/bin/coarena-agenda",
);

export const sha256 = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");

/* ------------------------------------------------------------------ files */

const TEXT_EXTENSIONS = new Set([".txt", ".md", ".csv"]);
const extensionOf = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
};

/**
 * Walks the bench folder without following symlinks. Dotfiles are skipped
 * (.DS_Store appears the moment Finder opens the folder). A symlink is listed
 * as an empty file so an unexpected item still counts against `nothingElse`,
 * but nothing behind it is ever read.
 */
export async function readFiles(
  root: string,
  exec: Exec = execFileText,
  timeoutMs = 5000,
): Promise<FileEvidence | undefined> {
  try {
    if (!existsSync(root) || !lstatSync(root).isDirectory())
      return { root, entries: [] };
    const entries: FileEntry[] = [];
    const walk = async (dir: string, prefix: string, depth: number) => {
      if (depth > DEPTH_LIMIT) return;
      const names = readdirSync(dir).sort();
      for (const name of names) {
        if (entries.length >= ENTRY_LIMIT) return;
        if (name.startsWith(".")) continue;
        const full = join(dir, name);
        const path = prefix ? `${prefix}/${name}` : name;
        const stat = lstatSync(full);
        if (stat.isDirectory()) {
          entries.push({ path, kind: "folder", size: 0, sha256: "" });
          await walk(full, path, depth + 1);
          continue;
        }
        if (!stat.isFile()) {
          entries.push({ path, kind: "file", size: 0, sha256: sha256("") });
          continue;
        }
        const data = readFileSync(full);
        const entry: FileEntry = {
          path,
          kind: "file",
          size: data.length,
          sha256: sha256(data),
        };
        const text = await textOf(full, name, data, exec, timeoutMs);
        if (text !== undefined) entry.text = text;
        entries.push(entry);
      }
    };
    await walk(root, "", 0);
    return { root, entries };
  } catch {
    return undefined;
  }
}

/**
 * What a grader may read of a file: plain text lowercased, RTF reduced to
 * its text by textutil, and for a zip archive its entry list (one name per
 * line, `__MACOSX/` resource forks left out) so an archive's contents can be
 * checked without extracting anything.
 */
async function textOf(
  full: string,
  name: string,
  data: Buffer,
  exec: Exec,
  timeoutMs: number,
): Promise<string | undefined> {
  const extension = extensionOf(name);
  if (data.length > TEXT_LIMIT) return undefined;
  if (TEXT_EXTENSIONS.has(extension))
    return data.toString("utf8").toLowerCase();
  try {
    if (extension === ".rtf")
      return (
        await exec("textutil", ["-convert", "txt", "-stdout", full], timeoutMs)
      ).toLowerCase();
    if (extension === ".zip")
      return (await exec("unzip", ["-Z1", full], timeoutMs))
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("__MACOSX/"))
        .join("\n")
        .toLowerCase();
  } catch {
    return undefined;
  }
  return undefined;
}

/* ----------------------------------------------------------------- agenda */

const lastJsonLine = (stdout: string): Record<string, unknown> | undefined => {
  try {
    const parsed = JSON.parse(stdout.trim().split("\n").pop() ?? "");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};
const text = (value: unknown, limit = 200) =>
  typeof value === "string" ? value.slice(0, limit) : undefined;

/** The helper's `find` output, checked field by field; malformed reads as nothing. */
export function parseAgendaFind(stdout: string): AgendaEvidence | undefined {
  const data = lastJsonLine(stdout);
  if (!data || typeof data.error === "string") return undefined;
  const access = (data.access ?? {}) as Record<string, unknown>;
  const items: AgendaItem[] = [];
  for (const raw of Array.isArray(data.items) ? data.items : []) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const kind =
      row.kind === "event" || row.kind === "reminder" ? row.kind : null;
    const title = text(row.title);
    if (!kind || title === undefined) continue;
    const item: AgendaItem = { kind, title };
    const calendar = text(row.calendar, 100);
    if (calendar !== undefined) item.calendar = calendar;
    if (typeof row.recurring === "boolean") item.recurring = row.recurring;
    if (kind === "event") {
      item.start = text(row.start, 40);
      item.end = text(row.end, 40);
      item.allDay = row.allDay === true;
    } else {
      const due = text(row.due, 40);
      if (due !== undefined) item.due = due;
      item.completed = row.completed === true;
    }
    items.push(item);
    if (items.length >= 50) break;
  }
  return {
    access: {
      calendar: text(access.calendar, 20) ?? "unknown",
      reminders: text(access.reminders, 20) ?? "unknown",
    },
    items,
  };
}

async function readAgenda(
  token: string,
  binary: string,
  exec: Exec,
  timeoutMs: number,
): Promise<AgendaEvidence | undefined> {
  if (!TOKEN_RE.test(token)) return undefined;
  try {
    return parseAgendaFind(await exec(binary, ["find", token], timeoutMs));
  } catch {
    return undefined;
  }
}

export type AgendaKind = AgendaItem["kind"];
/** The helper's container name (benchContainerName in AgendaRules.swift). */
const AGENDA_CONTAINER = "OpenAssistBench";
const STORE_KEY: Record<AgendaKind, "calendar" | "reminders"> = {
  event: "calendar",
  reminder: "reminders",
};

/**
 * The stores an agenda task can write: Calendar for events, Reminders for
 * reminders, by the apps it names. An agenda task naming neither is taken to
 * need both, so nothing is assumed safe by omission.
 */
export function agendaKinds(task: BenchTask): AgendaKind[] {
  if (!task.evidence?.includes("agenda")) return [];
  const kinds: AgendaKind[] = [];
  if (task.apps.includes(CALENDAR)) kinds.push("event");
  if (task.apps.includes(REMINDERS)) kinds.push("reminder");
  return kinds.length ? kinds : ["event", "reminder"];
}

/**
 * Whether cleanup asks Spotlight for files saved elsewhere under the token:
 * every task that declares the files reader. Its clean answer is not final
 * (Spotlight lags a save), so the attempt keeps its token for a later sweep.
 */
export function sweepsStrayFiles(task: Pick<BenchTask, "evidence">): boolean {
  return task.evidence?.includes("files") ?? false;
}

/**
 * The stores `coarena-agenda setup` left ready: granted, with the local
 * OpenAssistBench container in place. setup is idempotent and only ever
 * creates that container in the non-syncing source; an error (NO_ACCESS,
 * NO_LOCAL_SOURCE, SETUP_FAILED) or an unreadable answer means none.
 */
export function parseAgendaSetup(stdout: string): AgendaKind[] {
  const data = lastJsonLine(stdout);
  if (!data || typeof data.error === "string") return [];
  const access = (data.access ?? {}) as Record<string, unknown>;
  const containers = (data.containers ?? {}) as Record<string, unknown>;
  return (["event", "reminder"] as const).filter(
    (kind) =>
      access[STORE_KEY[kind]] === "granted" &&
      containers[STORE_KEY[kind]] === AGENDA_CONTAINER,
  );
}

/* ------------------------------------------------------------------ music */

const PLAYER_STATES = new Set(["playing", "paused", "stopped"]);

/**
 * A read-only look at Music through JXA: whether it is running, its player
 * state, and playlists named with the token. Music is never launched: a
 * stopped app answers "stopped" without starting.
 */
export function musicScript(token: string): string {
  if (!TOKEN_RE.test(token)) throw new Error("Not a bench token.");
  return [
    "(() => {",
    '  const music = Application("Music");',
    "  if (!music.running())",
    '    return JSON.stringify({ available: true, player: "stopped", playlists: [] });',
    "  const player = String(music.playerState());",
    `  const lists = music.playlists.whose({ name: { _contains: ${JSON.stringify(token)} } })();`,
    "  return JSON.stringify({",
    "    available: true,",
    "    player,",
    "    playlists: lists.map((list) => ({ name: list.name(), tracks: list.tracks().length })),",
    "  });",
    "})()",
  ].join("\n");
}

export function parseMusic(stdout: string): MusicEvidence {
  const unavailable: MusicEvidence = {
    available: false,
    player: "unknown",
    playlists: [],
  };
  const data = lastJsonLine(stdout);
  if (!data || data.available !== true) return unavailable;
  const player = text(data.player, 30) ?? "unknown";
  const playlists: MusicEvidence["playlists"] = [];
  for (const raw of Array.isArray(data.playlists) ? data.playlists : []) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const name = text(row.name, 100);
    if (name === undefined) continue;
    playlists.push({
      name,
      tracks: typeof row.tracks === "number" ? row.tracks : 0,
    });
  }
  return {
    available: true,
    player: PLAYER_STATES.has(player)
      ? (player as MusicEvidence["player"])
      : "unknown",
    playlists,
  };
}

async function readMusic(
  token: string,
  exec: Exec,
  timeoutMs: number,
): Promise<MusicEvidence> {
  try {
    return parseMusic(
      await exec(
        "osascript",
        ["-l", "JavaScript", "-e", musicScript(token)],
        timeoutMs,
      ),
    );
  } catch {
    return { available: false, player: "unknown", playlists: [] };
  }
}

/* ---------------------------------------------------------------- prepare */

const lstatOrNull = (path: string): Stats | null => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};

/**
 * Writes a fixture file inside the attempt's folder, for PrepareContext.write:
 * a relative path of visible names only (no "..", no absolute path, no
 * dotfile), parents created as folders, never through a symlink (a dangling
 * one included, which writeFile would follow out of the folder).
 */
export function writeInside(
  benchDir: string,
  relative: string,
  content: string,
): void {
  const parts = relative.split("/");
  if (
    !relative ||
    relative.startsWith("/") ||
    parts.some((part) => !part || part.startsWith("."))
  )
    throw new Error("Not a path inside the bench folder.");
  const root = resolve(benchDir);
  if (!lstatOrNull(root)?.isDirectory())
    throw new Error("The bench folder is not a folder.");
  let dir = root;
  for (const part of parts.slice(0, -1)) {
    dir = join(dir, part);
    const stat = lstatOrNull(dir);
    if (!stat) mkdirSync(dir);
    else if (!stat.isDirectory())
      throw new Error("Not a path inside the bench folder.");
  }
  const target = join(dir, parts[parts.length - 1]);
  const existing = lstatOrNull(target);
  if (existing && !existing.isFile())
    throw new Error("Not a path inside the bench folder.");
  writeFileSync(target, content);
}

/* ---------------------------------------------------------------- cleanup */

/** The one folder an attempt may own, given its token. */
export const benchDirFor = (home: string, token: string) =>
  join(home, BENCH_ROOT, token);

/**
 * Where cleanup moves what it finds in an attempt's folder that is older than
 * the attempt: the user's own files, which the model moved in. Beside the
 * bench folders and never deleted by the harness; a LEFTOVER_FOREIGN_FILE
 * tells a person to look here.
 */
export const quarantineFor = (home: string, token: string) =>
  join(home, BENCH_ROOT, ".quarantine", token);

/** Birth time in epoch milliseconds, from lstat, never through a link. */
export const bornAt = (path: string): number | undefined => {
  try {
    const ms = lstatSync(path).birthtimeMs;
    return ms > 0 ? ms : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Made during the attempt: born at or after the attempt's folder was. When
 * either time cannot be read nothing counts as made, so nothing is deleted
 * on a guess.
 */
export const madeSince = (
  born: number | undefined,
  start: number | undefined,
): boolean => born !== undefined && start !== undefined && born >= start;

export interface PathFacts {
  kind: "file" | "other" | "missing";
  /** Birth time in epoch milliseconds. */
  born?: number;
}

/** iCloud Drive's local folder, and TextEdit's own folder inside it. */
const ICLOUD = ["Library", "Mobile Documents"];
const TEXTEDIT_ICLOUD = [...ICLOUD, "com~apple~TextEdit", "Documents"];

/**
 * What the stray sweep may do with a path Spotlight named, whose name starts
 * with this attempt's token in any case, outside the attempt's own folder:
 *
 * - "foreign": it existed before the attempt started, or its age cannot be
 *   read. The model renamed something of the user's to the token; it stays
 *   where it is (moving it out of an iCloud folder would delete it on the
 *   user's other devices) and is reported for a person to check.
 * - "delete": a regular file the attempt made, under home but outside
 *   ~/Library, or in TextEdit's iCloud folder, where TextEdit saves when
 *   iCloud Drive is on.
 * - "report": anything else the attempt made: a folder or bundle (an .rtfd
 *   saved in the wrong place), a link, a file elsewhere in iCloud Drive.
 * - "ignore": not this sweep's to judge: another token, outside home, the
 *   rest of ~/Library (application state), the harness's quarantine.
 */
export function strayAction(
  path: string,
  token: string,
  home: string,
  facts: (path: string) => PathFacts,
  start?: number,
): "delete" | "report" | "foreign" | "ignore" {
  if (!TOKEN_RE.test(token)) return "ignore";
  const root = resolve(home);
  const full = resolve(path);
  const under = (...parts: string[]) =>
    full.startsWith(join(root, ...parts) + sep);
  if (!under()) return "ignore";
  const inICloud = under(...ICLOUD);
  if (under("Library") && !inICloud) return "ignore";
  const own = benchDirFor(home, token);
  if (full === own || full.startsWith(own + sep)) return "ignore";
  if (under(BENCH_ROOT, ".quarantine")) return "ignore";
  if (!basename(full).toLowerCase().startsWith(token)) return "ignore";
  const found = facts(full);
  if (found.kind === "missing") return "ignore";
  if (!madeSince(found.born, start)) return "foreign";
  if (found.kind !== "file") return "report";
  return !inICloud || under(...TEXTEDIT_ICLOUD) ? "delete" : "report";
}

/** Past this many entries the attempt's folder is not walked to the end, and not deleted. */
const WALK_LIMIT = 10_000;

/**
 * Entries in the attempt's folder that are older than the attempt, as
 * "/"-separated relative paths. A folder of the user's that was moved in is
 * listed once and not entered; a folder the attempt made is searched for
 * anything of the user's moved into it. undefined when the walk could not
 * finish, so nothing is deleted on a partial view. Dotfiles are included:
 * .DS_Store is born with the attempt, and a dotfile of the user's is still
 * the user's.
 */
export function olderEntries(
  root: string,
  start: number | undefined,
  born: (path: string) => number | undefined,
): string[] | undefined {
  const older: string[] = [];
  let seen = 0;
  const walk = (dir: string, prefix: string): boolean => {
    for (const name of readdirSync(dir).sort()) {
      if (++seen > WALK_LIMIT) return false;
      const full = join(dir, name);
      const path = prefix ? `${prefix}/${name}` : name;
      if (!madeSince(born(full), start)) older.push(path);
      else if (lstatSync(full).isDirectory() && !walk(full, path)) return false;
    }
    return true;
  };
  try {
    return walk(root, "") ? older : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Moves each entry, keeping its relative path, from the attempt's folder to
 * its quarantine folder: a rename on the same volume, so nothing is copied or
 * lost. False when any move fails or the quarantine is not a plain folder
 * (a link there would carry the user's file somewhere else).
 */
function quarantine(root: string, relatives: string[], into: string): boolean {
  try {
    const holder = lstatOrNull(dirname(into));
    if (holder && !holder.isDirectory()) return false;
    mkdirSync(into, { recursive: true, mode: 0o700 });
    if (!lstatOrNull(into)?.isDirectory()) return false;
    for (const relative of relatives) {
      const target = join(into, relative);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      if (lstatOrNull(target)) return false;
      renameSync(join(root, relative), target);
    }
    return true;
  } catch {
    return false;
  }
}

export function createReaders(options: ReaderOptions = {}): {
  readEvidence: EvidenceReaders;
  cleanupAttempt: Cleanup;
  agendaFor: (task: BenchTask) => Promise<PrepareContext["agenda"]>;
} {
  const exec = options.exec ?? execFileText;
  const home = options.home ?? homedir();
  const binary = options.agendaBinary ?? AGENDA_BINARY;
  const timeoutMs = options.timeoutMs ?? 5000;
  // Removal and its verification search two years of events each way.
  const slowMs = timeoutMs * 4;
  const born = options.born ?? bornAt;
  const music = options.music ?? process.env[MUSIC_READER_ENV] === "1";

  const readEvidence: EvidenceReaders = async (task, ctx) => {
    const out: Partial<Evidence> = {};
    for (const reader of task.evidence ?? []) {
      if (reader === "files") {
        // Only the folder this attempt's token names is ever walked.
        if (resolve(ctx.benchDir) !== benchDirFor(home, ctx.token)) continue;
        const files = await readFiles(ctx.benchDir, exec, timeoutMs);
        if (files) out.files = files;
      } else if (reader === "agenda") {
        const agenda = await readAgenda(ctx.token, binary, exec, timeoutMs);
        if (agenda) out.agenda = agenda;
      } else if (reader === "music") {
        out.music = music
          ? await readMusic(ctx.token, exec, timeoutMs)
          : { available: false, player: "unknown", playlists: [] };
      } else if (reader === "fixture") {
        const fixture = ctx.fixture?.read(ctx.token);
        if (fixture) out.fixture = fixture;
      }
    }
    return out;
  };

  /**
   * PrepareContext.agenda for one attempt, or undefined when the task cannot
   * run safely. `setup` (idempotent) must report every store the task writes
   * as granted, with its local OpenAssistBench container in place: without
   * the container the model is told to use a calendar that is not there and
   * writes to the default one, which may be shared; without the grant nothing
   * can read the item back or remove it. The harness passes the result as the
   * attempt's `agenda`, and an agenda task's prepare() skips without it.
   */
  const agendaFor = async (
    task: BenchTask,
  ): Promise<PrepareContext["agenda"]> => {
    const kinds = agendaKinds(task);
    if (!kinds.length) return undefined;
    let ready: AgendaKind[];
    try {
      ready = parseAgendaSetup(await exec(binary, ["setup"], timeoutMs));
    } catch {
      return undefined;
    }
    if (!kinds.every((kind) => ready.includes(kind))) return undefined;
    return {
      async add(item) {
        if (!ready.includes(item.kind)) throw new Error("AGENDA_NOT_READY");
        const answer = lastJsonLine(
          await exec(binary, ["add", JSON.stringify(item)], timeoutMs),
        );
        if (answer?.added !== item.kind) throw new Error("AGENDA_ADD_FAILED");
      },
    };
  };

  const isLink = (path: string) => {
    try {
      return lstatSync(path).isSymbolicLink();
    } catch {
      return false;
    }
  };
  const pathFacts = (path: string): PathFacts => {
    try {
      const stat = lstatSync(path);
      return { kind: stat.isFile() ? "file" : "other", born: born(path) };
    } catch {
      return { kind: "missing" };
    }
  };

  /**
   * When the attempt began: its folder's birth time, read before cleanup
   * removes the folder. undefined for a folder the token does not name or a
   * link, and then nothing outside the benchmark's own containers is deleted.
   */
  const attemptStart = (ctx: AttemptContext): number | undefined => {
    const dir = benchDirFor(home, ctx.token);
    if (resolve(ctx.benchDir) !== dir || isLink(dir)) return undefined;
    return born(dir);
  };

  /**
   * Whatever happened, after the readers: the attempt's folder, its agenda
   * items, its fixture log, the task's own extras, then a sweep for files the
   * model saved elsewhere under the token's name. Each step runs on its own,
   * so one that fails or is refused never keeps the others from running. The
   * token is checked before anything is deleted, the folder must be the one
   * the token names, and a symlinked folder is refused rather than followed.
   */
  const cleanupAttempt: Cleanup = async (task, ctx) => {
    if (!TOKEN_RE.test(ctx.token)) return ["CLEANUP_REFUSED"];
    const start = attemptStart(ctx);
    const codes: string[] = [];
    codes.push(...removeBenchDir(ctx, start));
    const readers = task.evidence ?? [];
    if (readers.includes("agenda"))
      codes.push(...(await cleanAgenda(task, ctx, start)));
    try {
      ctx.fixture?.reset(ctx.token);
    } catch {
      codes.push("LEFTOVER_FIXTURE");
    }
    if (task.cleanup)
      try {
        codes.push(
          ...(await task.cleanup({ benchDir: ctx.benchDir, token: ctx.token })),
        );
      } catch {
        codes.push("CLEANUP_TASK_FAILED");
      }
    if (sweepsStrayFiles(task)) codes.push(...(await sweep(ctx.token, start)));
    return [...new Set(codes)];
  };

  /**
   * Deletes the attempt's folder, after moving anything in it that is older
   * than the attempt into quarantine (LEFTOVER_FOREIGN_FILE). When the
   * quarantine or the walk fails, nothing is deleted (LEFTOVER_FILES).
   */
  function removeBenchDir(
    ctx: AttemptContext,
    start: number | undefined,
  ): string[] {
    const expected = benchDirFor(home, ctx.token);
    // A folder the token does not name is not this attempt's to delete.
    if (resolve(ctx.benchDir) !== expected) return ["CLEANUP_REFUSED"];
    try {
      if (isLink(expected)) return ["CLEANUP_REFUSED", "LEFTOVER_FILES"];
      if (!existsSync(expected)) return [];
      const older = olderEntries(expected, start, born);
      if (!older) return ["LEFTOVER_FILES"];
      const codes: string[] = [];
      if (older.length) {
        codes.push("LEFTOVER_FOREIGN_FILE");
        if (!quarantine(expected, older, quarantineFor(home, ctx.token)))
          return [...codes, "LEFTOVER_FILES"];
      }
      rmSync(expected, { recursive: true, force: true });
      if (existsSync(expected)) codes.push("LEFTOVER_FILES");
      return codes;
    } catch {
      return ["LEFTOVER_FILES"];
    }
  }

  /**
   * `remove` with the attempt's start, then a `find` over two years to
   * verify. The helper keeps (and counts as foreign) a token-titled item it
   * cannot show the attempt made: LEFTOVER_FOREIGN_MARKED for a person to
   * check. A store the helper has no grant for reads as empty, so an empty
   * answer from one the task writes proves nothing: LEFTOVER_AGENDA_UNVERIFIED,
   * which no retry changes. A helper that gave no answer (it timed out,
   * failed, or printed nothing readable, with the stores granted as far as
   * it said) is LEFTOVER_AGENDA_NO_ANSWER: a later sweep asks again.
   */
  async function cleanAgenda(
    task: BenchTask,
    ctx: AttemptContext,
    start: number | undefined,
  ): Promise<string[]> {
    const kinds = agendaKinds(task);
    const granted = (access: { calendar: string; reminders: string }) =>
      kinds.every(
        (kind) =>
          (kind === "event" ? access.calendar : access.reminders) === "granted",
      );
    try {
      const args = ["remove", ctx.token];
      if (start !== undefined) args.push(new Date(start).toISOString());
      const removed = lastJsonLine(await exec(binary, args, slowMs));
      if (!removed) return ["LEFTOVER_AGENDA_NO_ANSWER"];
      if (typeof removed.error === "string") {
        // A failure carries the helper's status: without a grant no retry
        // can help, with one the removal itself failed and may not again.
        const access = (removed.access ?? {}) as Record<string, unknown>;
        const { calendar, reminders } = access;
        return typeof calendar === "string" &&
          typeof reminders === "string" &&
          !granted({ calendar, reminders })
          ? ["LEFTOVER_AGENDA_UNVERIFIED"]
          : ["LEFTOVER_AGENDA_NO_ANSWER"];
      }
      // An older helper that does not count what it kept.
      if (
        typeof removed.removed !== "number" ||
        typeof removed.foreign !== "number"
      )
        return ["LEFTOVER_AGENDA_UNVERIFIED"];
      const codes: string[] = [];
      if (removed.foreign > 0) codes.push("LEFTOVER_FOREIGN_MARKED");
      const after = parseAgendaFind(
        await exec(binary, ["find", ctx.token, "wide"], slowMs),
      );
      if (!after) return [...codes, "LEFTOVER_AGENDA_NO_ANSWER"];
      if (!granted(after.access)) codes.push("LEFTOVER_AGENDA_UNVERIFIED");
      if (after.items.some((item) => item.kind === "event"))
        codes.push("LEFTOVER_EVENT");
      if (after.items.some((item) => item.kind === "reminder"))
        codes.push("LEFTOVER_REMINDER");
      return codes;
    } catch {
      // Timed out, or the helper could not be run at all.
      return ["LEFTOVER_AGENDA_NO_ANSWER"];
    }
  }

  /**
   * Files saved in the wrong place. Spotlight names them (case-insensitively:
   * a model may capitalise the token); the rule in strayAction decides, and a
   * file is unlinked in place, never a folder, never through a link. No answer
   * from Spotlight (indexing off, a timeout) is not a clean answer:
   * SWEEP_UNVERIFIED. Spotlight lags a save by seconds, so a file it has not
   * indexed yet is caught by a later sweep, not this one.
   */
  async function sweep(
    token: string,
    start: number | undefined,
  ): Promise<string[]> {
    let found: string[];
    try {
      found = (
        await exec(
          "mdfind",
          ["-onlyin", home, `kMDItemFSName == "${token}*"c`],
          timeoutMs,
        )
      )
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    } catch {
      return ["SWEEP_UNVERIFIED"];
    }
    const codes: string[] = [];
    for (const path of found) {
      const action = strayAction(path, token, home, pathFacts, start);
      if (action === "ignore") continue;
      if (action === "foreign") {
        codes.push("LEFTOVER_FOREIGN_FILE");
        continue;
      }
      if (action === "delete")
        try {
          unlinkSync(path);
        } catch {
          /* Reported below. */
        }
      if (pathFacts(path).kind !== "missing") codes.push("LEFTOVER_STRAY_FILE");
    }
    return codes;
  }

  return { readEvidence, cleanupAttempt, agendaFor };
}

const defaults = createReaders();
export const readEvidence: EvidenceReaders = defaults.readEvidence;
export const cleanupAttempt: Cleanup = defaults.cleanupAttempt;
export const agendaFor = defaults.agendaFor;
