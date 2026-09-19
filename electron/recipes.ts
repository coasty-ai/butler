/**
 * The user's site recipes file as main.ts holds it (design modules.md §2,
 * §6): `recipes.json` under the app's data folder, read at start, on each
 * change (a watch on the folder, debounced) and when Settings opens, parsed
 * by src/voice/recipes-file.ts, and installed over the built-in table with
 * installRecipes so the fast decider reads the merge. Its absence is normal:
 * the built-ins stand. Every rejected entry is traced RecipesFileRejected
 * {index, code} and listed in the Modules pane by index; the file's own
 * words never reach a trace.
 */
import { readFileSync, watch as fsWatch } from "node:fs";
import { basename, dirname } from "node:path";
import { trace, type DiagnosticSink } from "../src/core/diagnostics";
import { RECIPES, installRecipes, type SiteRecipe } from "../src/voice/recipes";
import {
  mergeRecipes,
  parseRecipesFile,
  type RecipeRejection,
  type RecipesFileError,
} from "../src/voice/recipes-file";

export interface RecipesStatus {
  path: string;
  exists: boolean;
  /** User entries loaded, built-ins, and the merged table's size. */
  loaded: number;
  builtin: number;
  total: number;
  rejected: { index: number; code: RecipeRejection }[];
  /** The file could not be read as a JSON array, or read at all. */
  error?: RecipesFileError | "unreadable";
  readAt?: number;
}
export interface RecipesFileDeps {
  path: string;
  trace?: DiagnosticSink;
  /** The file's text, or undefined when it does not exist. Defaults to fs. */
  read?: (path: string) => string | undefined;
  /** Watches the file's folder; returns the stop. Defaults to fs.watch. */
  watch?: (dir: string, onChange: (file: string) => void) => () => void;
  /** Where the merged table goes; defaults to installRecipes. */
  install?: (table: readonly SiteRecipe[]) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}
export interface RecipesFile {
  /** Reads the file now and installs the merge. */
  load(): RecipesStatus;
  status(): RecipesStatus;
  close(): void;
}
/** A change is read once the editor has finished writing. */
export const RECIPES_WATCH_DEBOUNCE_MS = 250;

function readFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw error;
  }
}
function watchDir(dir: string, onChange: (file: string) => void): () => void {
  const watcher = fsWatch(dir, (_event, file) => {
    if (typeof file === "string") onChange(file);
  });
  watcher.on("error", () => {});
  return () => watcher.close();
}

export function createRecipesFile(deps: RecipesFileDeps): RecipesFile {
  const read = deps.read ?? readFile;
  const install = deps.install ?? installRecipes;
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer =
    deps.clearTimer ??
    ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let current: RecipesStatus = {
    path: deps.path,
    exists: false,
    loaded: 0,
    builtin: RECIPES.length,
    total: RECIPES.length,
    rejected: [],
  };
  let stop: (() => void) | undefined;
  let pending: unknown;
  const load = (): RecipesStatus => {
    let text: string | undefined;
    try {
      text = read(deps.path);
    } catch {
      current = {
        ...current,
        exists: true,
        loaded: 0,
        total: RECIPES.length,
        rejected: [],
        error: "unreadable",
        readAt: now(),
      };
      install(RECIPES);
      trace(deps.trace, "RecipesFileLoaded", {
        loaded: 0,
        rejected: 0,
        code: "unreadable",
      });
      return current;
    }
    if (text === undefined) {
      current = {
        path: deps.path,
        exists: false,
        loaded: 0,
        builtin: RECIPES.length,
        total: RECIPES.length,
        rejected: [],
        readAt: now(),
      };
      install(RECIPES);
      return current;
    }
    const parsed = parseRecipesFile(text);
    const table = mergeRecipes(RECIPES, parsed.entries);
    install(table);
    for (const r of parsed.rejected)
      trace(deps.trace, "RecipesFileRejected", {
        index: r.index,
        code: r.code,
      });
    trace(deps.trace, "RecipesFileLoaded", {
      loaded: parsed.entries.length,
      rejected: parsed.rejected.length,
      ...(parsed.error ? { code: parsed.error } : {}),
    });
    current = {
      path: deps.path,
      exists: true,
      loaded: parsed.entries.length,
      builtin: RECIPES.length,
      total: table.length,
      rejected: parsed.rejected,
      ...(parsed.error ? { error: parsed.error } : {}),
      readAt: now(),
    };
    return current;
  };
  try {
    stop = (deps.watch ?? watchDir)(dirname(deps.path), (file) => {
      if (file !== basename(deps.path)) return;
      if (pending !== undefined) clearTimer(pending);
      pending = setTimer(() => {
        pending = undefined;
        load();
      }, RECIPES_WATCH_DEBOUNCE_MS);
    });
  } catch {
    // Without a watch the file is still re-read when Settings opens.
    trace(deps.trace, "RecipesFileLoaded", {
      loaded: 0,
      rejected: 0,
      code: "watch_failed",
    });
  }
  return {
    load,
    status: () => current,
    close() {
      if (pending !== undefined) clearTimer(pending);
      pending = undefined;
      stop?.();
      stop = undefined;
    },
  };
}
