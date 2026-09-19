import { describe, expect, it } from "vitest";
import {
  PROJECT_ROOTS,
  allowedProjectDir,
  expandHome,
  matchesProject,
  projectFromEditorTitle,
  projectKey,
  resolveProject,
  type ProjectLookup,
} from "../src/coding/project";

const home = "/Users/nkov";
/** A file system in a map: folder → its entries. */
function lookup(tree: Record<string, string[]>): ProjectLookup {
  return {
    home,
    isDir: (path) => path in tree,
    entries: (dir) => tree[dir] ?? [],
  };
}
const fs = lookup({
  [home]: ["open-assist", "Documents", "Library", "code", ".ssh", "Desktop"],
  [`${home}/open-assist`]: ["src"],
  [`${home}/Documents`]: ["notes"],
  [`${home}/Library`]: ["Keychains"],
  [`${home}/code`]: ["butler-app", "My App"],
  [`${home}/code/butler-app`]: [],
  [`${home}/code/My App`]: [],
  [`${home}/.ssh`]: [],
  [`${home}/Desktop`]: [],
  "/Volumes/Work/repo": [],
  "/Volumes/Work": ["repo"],
});

describe("project folders: what is allowed", () => {
  it.each([
    [`${home}/open-assist`, true],
    [`${home}/code/butler-app`, true],
    [`${home}/Documents/notes`, true],
    ["/Volumes/Work/repo", true],
    [home, false],
    [`${home}/`, false],
    [`${home}/Library`, false],
    [`${home}/Library/Keychains`, false],
    [`${home}/.ssh`, false],
    [`${home}/code/.git`, false],
    [`${home}/code/../../etc`, false],
    ["/", false],
    ["/System", false],
    ["/usr/local", false],
    ["/etc", false],
    ["/private/var", false],
    ["/Library", false],
    ["/Applications", false],
    ["/Users/other/code", false],
    ["/Volumes", false],
    ["/Volumes/Work", false],
    ["relative/path", false],
  ])("%s → %s", (path, ok) => {
    expect(allowedProjectDir(path, home)).toBe(ok);
  });
  it("expands the home shorthand and tidies slashes", () => {
    expect(expandHome("~/code/app/", home)).toBe(`${home}/code/app`);
    expect(expandHome("~", home)).toBe(home);
    expect(expandHome("//Users//nkov/x", home)).toBe(`${home}/x`);
  });
});

describe("project folders: names", () => {
  it("compares names loosely and drops the words around them", () => {
    expect(projectKey("Open Assist")).toBe("openassist");
    expect(projectKey("the open-assist repo")).toBe("openassist");
    expect(projectKey("my butler project")).toBe("butler");
    expect(matchesProject("open-assist", "open assist")).toBe(true);
    expect(matchesProject("open_assist", "Open-Assist")).toBe(true);
    expect(matchesProject("My App", "my app")).toBe(true);
    expect(matchesProject("open-assist", "assist")).toBe(false);
    expect(matchesProject("x", "")).toBe(false);
  });
  it("looks under the home folder and the usual code folders, home first", () => {
    expect(PROJECT_ROOTS[0]).toBe("");
    expect(PROJECT_ROOTS).toContain("code");
    expect(PROJECT_ROOTS).toContain("Projects");
  });
  it.each([
    ["ide.ts — open-assist", "open-assist"],
    ["● ide.ts — open-assist — Visual Studio Code", "open-assist"],
    ["open-assist", "open-assist"],
    ["main.tsx - butler-app - Cursor", "butler-app"],
    ["ide.ts — open-assist (Workspace)", "open-assist"],
    ["settings.tsx — My App — Windsurf", "My App"],
    ["ide.ts", undefined],
    ["", undefined],
    ["[Extension Development Host]", undefined],
    ["a — /Users/nkov/x", undefined],
  ])("reads %j as project %j", (title, name) => {
    expect(projectFromEditorTitle(title)).toBe(name);
  });
});

describe("project folders: resolution", () => {
  it("finds a named project under the roots and a path as it is", () => {
    expect(resolveProject({ named: "open assist" }, fs)).toEqual({
      ok: true,
      dir: `${home}/open-assist`,
      via: "named",
    });
    expect(resolveProject({ named: "the butler app repo" }, fs)).toEqual({
      ok: true,
      dir: `${home}/code/butler-app`,
      via: "named",
    });
    expect(resolveProject({ named: "~/code/My App" }, fs)).toEqual({
      ok: true,
      dir: `${home}/code/My App`,
      via: "named",
    });
    expect(resolveProject({ named: "/Volumes/Work/repo" }, fs)).toMatchObject({
      ok: true,
      dir: "/Volumes/Work/repo",
    });
  });
  it("refuses system paths and hidden or library folders, by name or by path", () => {
    for (const named of [
      "/etc",
      "/System",
      "~",
      "~/Library",
      "~/.ssh",
      "Library",
      ".ssh",
    ])
      expect(resolveProject({ named }, fs)).toEqual({
        ok: false,
        reason: "refused",
      });
  });
  it("reports a name it cannot find, so the words stay in the task", () => {
    expect(resolveProject({ named: "settings page" }, fs)).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(resolveProject({ named: "~/code/nope" }, fs)).toEqual({
      ok: false,
      reason: "not_found",
    });
  });
  it("takes the project from a coding editor's window, and from nothing else", () => {
    const editor = {
      appId: "com.microsoft.VSCode",
      title: "ide.ts — open-assist",
    };
    expect(resolveProject({ editor }, fs)).toEqual({
      ok: true,
      dir: `${home}/open-assist`,
      via: "editor",
    });
    expect(
      resolveProject(
        {
          editor: {
            appId: "com.todesktop.230313mzl4w4u92",
            title: "a.ts — butler-app",
          },
        },
        fs,
      ),
    ).toMatchObject({ ok: true, dir: `${home}/code/butler-app` });
    expect(
      resolveProject(
        { editor: { appId: "com.apple.Terminal", title: "open-assist" } },
        fs,
      ),
    ).toEqual({ ok: false, reason: "no_project" });
    expect(
      resolveProject(
        { editor: { appId: "com.microsoft.VSCode", title: "ide.ts" } },
        fs,
      ),
    ).toEqual({ ok: false, reason: "no_project" });
    expect(resolveProject({}, fs)).toEqual({ ok: false, reason: "no_project" });
  });
  it("prefers the named project over the editor's", () => {
    const editor = {
      appId: "com.microsoft.VSCode",
      title: "ide.ts — open-assist",
    };
    expect(resolveProject({ named: "butler app", editor }, fs)).toMatchObject({
      dir: `${home}/code/butler-app`,
      via: "named",
    });
  });
});
