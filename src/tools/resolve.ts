import {
  accessSync,
  constants,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

/**
 * A server command is resolved here, never by a shell: a Finder-launched app
 * sees only the LaunchServices PATH, so a bare name ("npx", "claude") is
 * looked up in the fixed places a developer's runtime lives, and the pane
 * shows the absolute result before the server can be approved.
 */
export const REFUSED_COMMANDS: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "osascript",
  "open",
  "sudo",
  "env",
]);
export type ResolveCode = "NOT_FOUND" | "REFUSED" | "RELATIVE";
/** The file-system questions resolution asks; tests answer them from a table. */
export interface ResolveFs {
  isExecutable(path: string): boolean;
  list(dir: string): string[];
  /** A small text file's content (an installed package's package.json), or undefined; optional for tests' tables. */
  read?(path: string): string | undefined;
}
export const realFs: ResolveFs = {
  isExecutable(path) {
    try {
      accessSync(path, constants.X_OK);
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
  list(dir) {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
  read(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
};
/** "v22.23.2" before "v20.19.0": numeric per component, highest first. */
const byVersionDesc = (a: string, b: string) => {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pb[i] || 0) - (pa[i] || 0);
    if (diff) return diff;
  }
  return 0;
};
/** The directories a bare name is looked up in, in order. */
export function searchPath(home: string, fs: ResolveFs = realFs): string[] {
  const nvm = fs
    .list(join(home, ".nvm/versions/node"))
    .filter((name) => /^v\d+\.\d+\.\d+$/.test(name))
    .sort(byVersionDesc)
    .slice(0, 1)
    .map((version) => join(home, ".nvm/versions/node", version, "bin"));
  const python = fs
    .list(join(home, "Library/Python"))
    .filter((name) => /^\d+(?:\.\d+)*$/.test(name))
    .sort(byVersionDesc)
    .map((version) => join(home, "Library/Python", version, "bin"));
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    ...nvm,
    join(home, ".volta/bin"),
    join(home, ".local/bin"),
    join(home, ".cargo/bin"),
    ...python,
    "/usr/bin",
    "/bin",
  ];
}
/**
 * An absolute path is used as given; a bare name is searched; anything with
 * a slash that is not absolute is refused, as are the shells and launchers
 * whose argument would be the real command.
 */
export function resolveCommand(
  command: string,
  home: string,
  fs: ResolveFs = realFs,
): { path?: string; code?: ResolveCode } {
  const name = command.trim();
  if (!name) return { code: "NOT_FOUND" };
  if (REFUSED_COMMANDS.has(basename(name))) return { code: "REFUSED" };
  if (isAbsolute(name))
    return fs.isExecutable(name) ? { path: name } : { code: "NOT_FOUND" };
  if (name.includes("/")) return { code: "RELATIVE" };
  for (const dir of searchPath(home, fs)) {
    const path = join(dir, name);
    if (fs.isExecutable(path)) return { path };
  }
  return { code: "NOT_FOUND" };
}
/**
 * The PATH a server child receives: the resolved command's own directory
 * first (a node script's `#!/usr/bin/env node` finds its runtime), then the
 * fixed list. Never the app's PATH.
 */
export function childPath(
  resolved: string,
  home: string,
  fs: ResolveFs = realFs,
): string {
  return [...new Set([dirname(resolved), ...searchPath(home, fs)])].join(":");
}
