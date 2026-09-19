/**
 * Which folder a coding agent works in. Only two sources are ever accepted:
 * a project the owner named ("in open-assist", "in ~/code/app") and the
 * project open in the coding editor in front (its window title, read the way
 * a watch reads one; src/core/ide.ts says which apps are editors). A name is
 * looked up in a fixed set of places under the home folder; a path must lie
 * inside the home folder (never the home folder itself, its Library, or a
 * hidden folder such as ~/.ssh) or inside a mounted volume. System paths are
 * refused outright. Pure: the file system is passed in.
 */
import { ideFamily } from "../core/ide";

export interface ProjectLookup {
  home: string;
  isDir(path: string): boolean;
  entries(dir: string): string[];
}
export type ProjectResolution =
  | { ok: true; dir: string; via: "named" | "editor" }
  | { ok: false; reason: "not_found" | "refused" | "no_project" };

/** Where a spoken project name is looked for, relative to home, in order. */
export const PROJECT_ROOTS: readonly string[] = [
  "",
  "code",
  "Code",
  "Projects",
  "projects",
  "src",
  "dev",
  "Developer",
  "repos",
  "work",
  "Documents",
  "Desktop",
];
export function projectRootDirs(home: string): string[] {
  return PROJECT_ROOTS.map((root) => (root ? `${home}/${root}` : home));
}

/** "~/code/app" → "/Users/me/code/app"; trailing slashes and doubled ones gone. */
export function expandHome(path: string, home: string): string {
  const expanded = path === "~" ? home : path.replace(/^~(?=\/)/, home);
  return expanded.replace(/\/{2,}/g, "/").replace(/(.)\/+$/, "$1");
}

/**
 * Whether a coding agent may be pointed at this folder: an absolute path
 * with no ".." inside the home folder but not the home folder itself, its
 * Library or anything hidden; or a folder inside a mounted volume. Nothing
 * else, so never /, /System, /usr, /etc, /Library, /Applications or another
 * user's home.
 */
export function allowedProjectDir(path: string, home: string): boolean {
  const p = expandHome(path, home);
  if (!p.startsWith("/")) return false;
  const parts = p.split("/").filter(Boolean);
  if (parts.some((part) => part === "..")) return false;
  const root = expandHome(home, home);
  if (p === root) return false;
  if (p.startsWith(`${root}/`)) {
    const rel = p.slice(root.length + 1).split("/");
    if (rel[0] === "Library") return false;
    return !rel.some((part) => part.startsWith("."));
  }
  if (p.startsWith("/Volumes/"))
    return parts.length >= 3 && !parts.some((part) => part.startsWith("."));
  return false;
}

/**
 * A project name as compared: lowercase letters and digits only, with a
 * leading "the" and a trailing "repo", "project" or "folder" dropped, so
 * "open assist", "Open-Assist" and "open_assist" all name the same folder.
 */
export function projectKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/^the |^my /, "")
    .replace(
      /\s+(?:repo|repository|project|folder|directory|codebase|code base)$/,
      "",
    )
    .replace(/[^a-z0-9]+/g, "");
}
export function matchesProject(entry: string, named: string): boolean {
  const key = projectKey(named);
  return !!key && projectKey(entry) === key;
}

// Title segments that are the editor's own name, not a project's.
const EDITOR_NAMES =
  /^(?:visual studio code(?: - insiders)?|code(?: - insiders)?|cursor|windsurf|vscodium|\[.*\])$/i;
const LOOKS_LIKE_FILE = /^[^\s/]+\.[A-Za-z0-9]{1,8}$/;
/**
 * The project open in a VS Code-family window, from its title: "ide.ts —
 * open-assist", "● ide.ts — open-assist — Visual Studio Code", "open-assist"
 * with nothing open. The root name is the segment after the file; a lone
 * file name is no project.
 */
export function projectFromEditorTitle(title: string): string | undefined {
  const parts = title
    .replace(/^[●•*]\s*/, "")
    .split(/\s+[—–-]\s+/)
    .map((part) => part.replace(/\s*\((?:workspace)\)$/i, "").trim())
    .filter((part) => part && !EDITOR_NAMES.test(part));
  const name = parts.length >= 2 ? parts[1] : parts[0];
  if (!name || LOOKS_LIKE_FILE.test(name) || name.includes("/"))
    return undefined;
  return /^[\w .()-]{1,64}$/.test(name) ? name : undefined;
}

/** A folder the owner named, as a path or as a name looked up under the roots. */
function resolveNamed(named: string, lookup: ProjectLookup): ProjectResolution {
  const trimmed = named.trim();
  if (/^(?:~|\/)/.test(trimmed)) {
    const dir = expandHome(trimmed, lookup.home);
    if (!allowedProjectDir(dir, lookup.home))
      return { ok: false, reason: "refused" };
    return lookup.isDir(dir)
      ? { ok: true, dir, via: "named" }
      : { ok: false, reason: "not_found" };
  }
  if (!projectKey(trimmed)) return { ok: false, reason: "not_found" };
  for (const root of projectRootDirs(lookup.home)) {
    if (!lookup.isDir(root)) continue;
    const entry = lookup
      .entries(root)
      .find((candidate) => matchesProject(candidate, trimmed));
    if (!entry) continue;
    const dir = `${root}/${entry}`;
    if (!allowedProjectDir(dir, lookup.home))
      return { ok: false, reason: "refused" };
    if (lookup.isDir(dir)) return { ok: true, dir, via: "named" };
  }
  return { ok: false, reason: "not_found" };
}

/**
 * The folder for a delegation: the named project when there is one,
 * otherwise the project of the editor in front. An editor that is not a
 * coding editor, or a title with no project in it, resolves to nothing.
 */
export function resolveProject(
  o: { named?: string; editor?: { appId?: string; title?: string } },
  lookup: ProjectLookup,
): ProjectResolution {
  if (o.named?.trim()) return resolveNamed(o.named, lookup);
  if (!o.editor || !ideFamily(o.editor.appId))
    return { ok: false, reason: "no_project" };
  const name = projectFromEditorTitle(o.editor.title ?? "");
  if (!name) return { ok: false, reason: "no_project" };
  const found = resolveNamed(name, lookup);
  return found.ok ? { ...found, via: "editor" } : found;
}
