import { stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { FileFacts, FileFactsReader } from "../core/deliverables";

/**
 * The runner's deliverable reader (RunnerExtras.deliverables): a file's
 * existence, size and modification time by path, for the check of a done
 * against the file the task asks to write (src/core/deliverables.ts). `~`
 * is the home folder given; a path that does not resolve under it (another
 * volume, `..` out of it, the home itself) answers null and is not checked.
 * A missing file is a fact (exists false), not a refusal. The contents are
 * never read, nothing is written, and a failure to read answers null.
 */
export function fileFactsReader(home: string): FileFactsReader {
  const root = resolve(home);
  return async (path: string): Promise<FileFacts | null> => {
    if (typeof path !== "string" || !path) return null;
    const expanded = path.startsWith("~/") ? root + path.slice(1) : path;
    const full = resolve(expanded);
    if (!full.startsWith(root + sep)) return null;
    try {
      const facts = await stat(full);
      return { exists: true, size: facts.size, mtimeMs: facts.mtimeMs };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      return code === "ENOENT" || code === "ENOTDIR"
        ? { exists: false, size: 0, mtimeMs: 0 }
        : null;
    }
  };
}
