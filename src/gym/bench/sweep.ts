import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TokenLedger } from "./attempt";
import { TOKEN_RE } from "./graders";
import {
  BENCH_ROOT,
  benchDirFor,
  bornAt,
  createReaders,
  type ReaderOptions,
} from "./readers";
import type { AttemptResult } from "./report";
import type { BenchTask } from "./types";

/**
 * What a crashed or interrupted attempt left behind, found again later. The
 * attempt's own cleanup (readers.ts cleanupAttempt) runs in a finally, but a
 * kill -9, a power cut or a cleanup Spotlight had not caught up with leaves
 * items no row can name. The harness therefore keeps a ledger of tokens in
 * flight, and a sweep runs the same cleanup again for every token in it and
 * every token folder under ~/OpenAssistBench: at the end of every cycle,
 * and on its own with `--cleanup-only`. The token namespace (benchnote plus
 * four characters) is what makes that safe, and the cleanup rules are the
 * attempt's own, dated by the attempt's start, so a sweep deletes nothing a
 * cleanup at the time would have kept.
 */

/**
 * Codes a later sweep can still clear: things the attempt made that were
 * still there. Everything else waits for a person (a file of theirs the
 * model renamed, a folder that was a link) or cannot improve by retrying (no
 * agenda grant), and must not keep a token in the ledger forever: a ledger
 * entry makes every later cycle skip its long tasks as BENCH_ROOT_DIRTY.
 */
export const RETRYABLE_LEFTOVERS = new Set([
  "LEFTOVER_FILES",
  "LEFTOVER_EVENT",
  "LEFTOVER_REMINDER",
  "LEFTOVER_STRAY_FILE",
]);

/**
 * Checks that got no answer: Spotlight or the agenda helper timed out,
 * failed or printed nothing readable. The next sweep may get one, so the
 * token stays, but only for MAX_CLEANUPS cleanups in all: indexing switched
 * off, or a helper that is simply missing, never answers, and must not skip
 * every later night's long tasks.
 */
export const TRANSIENT_LEFTOVERS = new Set([
  "SWEEP_UNVERIFIED",
  "LEFTOVER_AGENDA_NO_ANSWER",
]);
/** The attempt's own cleanup, the cycle's final sweep and one --cleanup-only. */
export const MAX_CLEANUPS = 3;

/**
 * How long after an attempt's cleanup a clean answer from Spotlight counts.
 * Spotlight indexes a save seconds after it happens, so a stray file saved
 * just before `done` is invisible to the cleanup that follows the grading
 * read; the token of an attempt that swept for stray files therefore stays
 * in the ledger until a sweep this much later has looked again.
 */
export const SPOTLIGHT_SETTLE_MS = 30_000;

/**
 * Beside the desktop lock, under ~/Library, which the stray-file sweep
 * never looks at (readers.ts strayAction), so the ledger cannot sweep
 * itself.
 */
export function tokenLedgerDir(home = homedir()): string {
  return join(home, "Library", "Caches", "open-assist", "bench-tokens");
}

export interface LedgerEntry {
  token: string;
  /** The task the token was drawn for, so a sweep cleans every store it wrote. */
  taskId?: string;
  /** The bench folder's birth time: what cleanup dates the attempt by. */
  start?: number;
  /**
   * When the attempt's own cleanup ran, for a token kept for a later look
   * (close with `recheck`): a sweep's clean answer counts only once
   * SPOTLIGHT_SETTLE_MS have passed since.
   */
  cleanedAt?: number;
  /** Cleanups run for this token so far, attempt and sweeps alike. */
  cleanups?: number;
}

export interface FileTokenLedger extends TokenLedger {
  entries(): LedgerEntry[];
}

/** One small file per token; only a benchmark token can name one. */
export function fileTokenLedger(
  dir: string,
  now: () => number = Date.now,
): FileTokenLedger {
  const path = (token: string) => {
    if (!TOKEN_RE.test(token)) throw new Error("Not a bench token.");
    return join(dir, token);
  };
  const read = (token: string): LedgerEntry | undefined => {
    try {
      const data = JSON.parse(readFileSync(path(token), "utf8")) as {
        taskId?: unknown;
        start?: unknown;
        cleanedAt?: unknown;
        cleanups?: unknown;
      };
      const time = (value: unknown) =>
        typeof value === "number" && Number.isFinite(value) ? value : undefined;
      const start = time(data.start);
      const cleanedAt = time(data.cleanedAt);
      const cleanups = time(data.cleanups);
      return {
        token,
        ...(typeof data.taskId === "string" ? { taskId: data.taskId } : {}),
        ...(start !== undefined ? { start } : {}),
        ...(cleanedAt !== undefined ? { cleanedAt } : {}),
        ...(cleanups !== undefined ? { cleanups } : {}),
      };
    } catch {
      return undefined;
    }
  };
  const write = (entry: LedgerEntry) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(
      path(entry.token),
      JSON.stringify({
        taskId: entry.taskId,
        start: entry.start,
        cleanedAt: entry.cleanedAt,
        cleanups: entry.cleanups,
      }) + "\n",
      { mode: 0o600 },
    );
  };
  return {
    open(token, taskId) {
      write({ token, taskId });
    },
    started(token, at) {
      write({ ...(read(token) ?? { token }), start: at });
    },
    close(token, leftovers, failed, recheck = false) {
      const entry = read(token) ?? { token };
      const cleanups = (entry.cleanups ?? 0) + 1;
      const keep =
        failed ||
        recheck ||
        leftovers.some((code) => RETRYABLE_LEFTOVERS.has(code)) ||
        (cleanups < MAX_CLEANUPS &&
          leftovers.some((code) => TRANSIENT_LEFTOVERS.has(code)));
      if (!keep) {
        rmSync(path(token), { force: true });
        return;
      }
      write({
        ...entry,
        cleanups,
        // The first clean answer's time: a sweep that runs too early keeps
        // the token without moving the settle time on.
        ...(recheck ? { cleanedAt: entry.cleanedAt ?? now() } : {}),
      });
    },
    entries() {
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((name) => TOKEN_RE.test(name))
        .sort()
        .map((token) => read(token) ?? { token });
    },
  };
}

/** Token folders under <home>/OpenAssistBench (never .quarantine). */
export function benchRootTokens(home: string): string[] {
  try {
    return readdirSync(join(home, BENCH_ROOT))
      .filter((name) => TOKEN_RE.test(name))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Whether an earlier attempt's items may still be on this Mac: a token
 * folder under the bench root, or a token the ledger still holds.
 */
export function benchRootDirty(home: string, ledger: LedgerEntry[]): boolean {
  return ledger.length > 0 || benchRootTokens(home).length > 0;
}

/**
 * A token folder nobody recorded (an older harness wrote it): only the
 * folder and files saved elsewhere under the token can be looked for.
 */
const FILES_ONLY: BenchTask = {
  id: "cleanup-sweep",
  instruction: "",
  apps: [],
  category: "files",
  difficulty: "easy",
  maxCost: 0,
  maxActions: 0,
  maxSeconds: 0,
  safety: "Cleanup only.",
  verifies: "Nothing.",
  evidence: ["files"],
  grade: () => ({ status: "unknown", checks: {} }),
};

export interface SweptToken {
  token: string;
  leftovers: string[];
}

const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/**
 * How long a sweep must wait before a clean answer from Spotlight counts for
 * every token cleaned so far: 0 when none was cleaned less than `settleMs`
 * ago.
 */
export function settleDelay(
  entries: LedgerEntry[],
  now: number,
  settleMs = SPOTLIGHT_SETTLE_MS,
): number {
  const latest = Math.max(
    -Infinity,
    ...entries.flatMap((entry) =>
      entry.cleanedAt === undefined ? [] : [entry.cleanedAt],
    ),
  );
  return Math.min(settleMs, Math.max(0, latest + settleMs - now));
}

/**
 * Runs the attempt's cleanup again for every token in the ledger and every
 * token folder under the bench root. Once cleanup has removed a folder, the
 * ledger's start stands in for its birth time, so an item made during the
 * attempt is still told from one that was the person's all along; without a
 * start nothing outside the benchmark's own containers is deleted. It first
 * waits out Spotlight's lag after the latest attempt cleanup (settleDelay),
 * so a stray file saved just before an attempt ended is indexed by the time
 * it looks. A token whose cleanup leaves nothing a sweep could clear leaves
 * the ledger, unless the sweep ran before its settle time (a second Ctrl-C
 * cut the wait short). Must run under the desktop lock: a harness running
 * beside it would lose the folder of the attempt it is in the middle of.
 */
export async function sweepTokens(input: {
  home: string;
  ledger: FileTokenLedger;
  /** Every task a token may have been drawn for, by id. */
  tasks: Map<string, BenchTask>;
  options?: Omit<ReaderOptions, "home" | "born">;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  settleMs?: number;
  /** Told before the sweep waits for Spotlight, with the wait in ms. */
  onWait?: (ms: number) => void;
}): Promise<SweptToken[]> {
  const now = input.now ?? Date.now;
  const settleMs = input.settleMs ?? SPOTLIGHT_SETTLE_MS;
  const listed = input.ledger.entries();
  const wait = settleDelay(listed, now(), settleMs);
  if (wait > 0) {
    input.onWait?.(wait);
    await (input.sleep ?? delay)(wait);
  }
  const entries = new Map(listed.map((entry) => [entry.token, entry]));
  for (const token of benchRootTokens(input.home))
    if (!entries.has(token)) entries.set(token, { token });
  const out: SweptToken[] = [];
  for (const entry of [...entries.values()].sort((a, b) =>
    a.token < b.token ? -1 : 1,
  )) {
    const dir = benchDirFor(input.home, entry.token);
    const task =
      (entry.taskId ? input.tasks.get(entry.taskId) : undefined) ?? FILES_ONLY;
    const born = (path: string) =>
      path === dir && !existsSync(dir) ? entry.start : bornAt(path);
    const { cleanupAttempt } = createReaders({
      ...input.options,
      home: input.home,
      born,
    });
    let leftovers: string[];
    let failed = false;
    try {
      leftovers = await cleanupAttempt(task, {
        token: entry.token,
        benchDir: dir,
        benchPath: `~/${BENCH_ROOT}/${entry.token}`,
      });
    } catch {
      leftovers = [];
      failed = true;
    }
    // Looked too early for Spotlight to have caught up: keep it for a
    // later sweep, whatever this one found.
    const early =
      entry.cleanedAt !== undefined && now() - entry.cleanedAt < settleMs;
    try {
      input.ledger.close(entry.token, leftovers, failed, early);
    } catch {
      // The entry stays; the next sweep tries again.
    }
    out.push({
      token: entry.token,
      leftovers: failed ? ["CLEANUP_FAILED"] : leftovers,
    });
  }
  return out;
}

/**
 * What is still on this Mac after the final sweep: the codes rows reported
 * that no sweep can clear (a file of the person's, a refused folder), and
 * whatever the sweep itself still found. A row's retryable and transient
 * codes are the sweep's to answer, since its token stayed in the ledger for
 * it. `swept` undefined means the sweep itself failed: then nothing the
 * rows reported was answered, and SWEEP_FAILED says so.
 */
export function remainingLeftovers(
  rows: Pick<AttemptResult, "leftovers">[],
  swept: SweptToken[] | undefined,
): string[] {
  const codes = new Set<string>();
  for (const row of rows)
    for (const code of row.leftovers ?? [])
      if (
        !swept ||
        !(RETRYABLE_LEFTOVERS.has(code) || TRANSIENT_LEFTOVERS.has(code))
      )
        codes.add(code);
  if (!swept) codes.add("SWEEP_FAILED");
  for (const token of swept ?? [])
    for (const code of token.leftovers) codes.add(code);
  return [...codes].sort();
}
