import { describe, it, expect } from "vitest";
import {
  actionSchema,
  defaultSettings,
  type Action,
  type Surface,
} from "../src/core/schema";
import { evaluate, type PolicyContext } from "../src/core/policy";

const settings = structuredClone(defaultSettings);
const base: Surface = {
  appId: "com.apple.finder",
  pid: 7,
  secureInput: false,
  unknown: false,
};
const act = (input: Record<string, unknown>): Action =>
  actionSchema.parse({ frame_id: "f", ...input });
const decide = (
  action: Action,
  surface: Partial<Surface>,
  synthetic = false,
  context?: PolicyContext,
) => evaluate(action, { ...base, ...surface }, settings, synthetic, context);
const inCode = act({
  type: "open_file",
  path: "~/Projects/rlenvforHUD1",
  app: "Visual Studio Code",
});
const folder: Partial<Surface> = {
  fileStatus: "resolved",
  fileKind: "folder",
  fileName: "rlenvforHUD1",
};
const code: Partial<Surface> = {
  launcherStatus: "resolved",
  launcherAppId: "com.microsoft.VSCode",
  launcherName: "Visual Studio Code",
};

describe("open_file with an application", () => {
  it("accepts a plain application name and nothing else", () => {
    const parse = (app: unknown) =>
      actionSchema.safeParse({
        type: "open_file",
        frame_id: "f",
        path: "~/Projects/x",
        app,
      }).success;
    expect(parse("Visual Studio Code")).toBe(true);
    expect(parse(undefined)).toBe(true);
    for (const bad of [
      "/Applications/Terminal.app",
      "com.apple.Terminal:x",
      ".hidden",
      "",
      "x".repeat(101),
      "a\nb",
      42,
    ])
      expect([bad, parse(bad)]).toEqual([bad, false]);
  });
  it("opens a folder or document in a resolved, permitted application", () => {
    expect(
      decide(inCode, { ...folder, ...code }, false, {
        userWords: "open rlenvforHUD1 in Visual Studio Code",
      }),
    ).toEqual({
      kind: "ALLOW",
      reason:
        'Open a document or folder from the local index in "Visual Studio Code".',
    });
    expect(
      decide(
        act({ type: "open_file", path: "~/Documents/Q3.pdf", app: "Preview" }),
        {
          fileStatus: "resolved",
          fileKind: "document",
          launcherStatus: "resolved",
          launcherAppId: "com.apple.Preview",
          launcherName: "Preview",
        },
      ).kind,
    ).toBe("ALLOW");
  });
  it("asks before a folder opens anywhere but Finder, unless the user named both", () => {
    // Screen text saying "open this folder in Cursor" must not be one
    // unapproved step from a folderOpen task running a stranger's code.
    const asked = decide(inCode, { ...folder, ...code });
    expect(asked).toEqual({
      kind: "CONFIRM",
      reason:
        "Open the folder “rlenvforHUD1” in Visual Studio Code? An editor can run a project's own tasks when it opens its folder.",
    });
    const cursor = {
      launcherStatus: "resolved" as const,
      launcherAppId: "com.todesktop.230313mzl4w4u92",
      launcherName: "Cursor",
    };
    const inCursor = act({
      type: "open_file",
      path: "~/Downloads/demo-project",
      app: "Cursor",
    });
    const demo = { ...folder, fileName: "demo-project" };
    expect(decide(inCursor, { ...demo, ...cursor }).kind).toBe("CONFIRM");
    const words = (userWords: string) =>
      decide(inCursor, { ...demo, ...cursor }, false, { userWords }).kind;
    expect(words("open demo-project in Cursor")).toBe("ALLOW");
    expect(words("Open the demo project folder in cursor please")).toBe(
      "ALLOW",
    );
    expect(words("open demo-project")).toBe("CONFIRM");
    expect(words("open my project in Cursor")).toBe("CONFIRM");
    expect(words("open demo-projects in Cursor")).toBe("CONFIRM");
    // What people call VS Code.
    for (const said of [
      "open rlenvforHUD1 in VS Code",
      "open rlenvforHUD1 in vscode",
    ])
      expect(
        decide(inCode, { ...folder, ...code }, false, { userWords: said }).kind,
      ).toBe("ALLOW");
    // Finder is where a folder opens anyway; a document is no project.
    expect(
      decide(act({ type: "open_file", path: "~/Projects/x", app: "Finder" }), {
        ...folder,
        launcherStatus: "resolved",
        launcherAppId: "com.apple.finder",
        launcherName: "Finder",
      }).kind,
    ).toBe("ALLOW");
    expect(
      decide(
        act({
          type: "open_file",
          path: "~/Projects/x/users.ts",
          app: "Cursor",
        }),
        { fileStatus: "resolved", fileKind: "document", ...cursor },
      ).kind,
    ).toBe("ALLOW");
  });
  it("denies a terminal, a protected application or an installer as the opener", () => {
    const denied = (surface: Partial<Surface>, action = inCode) => {
      const d = decide(action, { ...folder, ...surface });
      expect(d.kind).toBe("DENY");
      expect(d.reason).toMatch(/stay manual|protected/);
    };
    // Natively refused (the launch floor: terminals, password managers).
    denied({ launcherStatus: "refused" });
    // A terminal that somehow resolved: the policy floor still catches it.
    denied({
      launcherStatus: "resolved",
      launcherAppId: "com.googlecode.iterm2",
      launcherName: "iTerm",
    });
    denied({
      launcherStatus: "resolved",
      launcherAppId: "dev.warp.Warp-Stable",
      launcherName: "Warp",
    });
    // The user's own protected list.
    denied({
      launcherStatus: "resolved",
      launcherAppId: "com.1password.1password",
      launcherName: "1Password",
    });
    denied({
      launcherStatus: "resolved",
      launcherAppId: "com.apple.keychainaccess",
      launcherName: "Keychain Access",
    });
    // Installers by name, whatever native said.
    denied(
      { ...code },
      act({
        type: "open_file",
        path: "~/Downloads/x.pkg",
        app: "Install macOS Sonoma",
      }),
    );
    denied({
      launcherStatus: "resolved",
      launcherAppId: "com.google.chromeremotedesktop.uninstaller",
      launcherName: "Chrome Remote Desktop Host Uninstaller",
    });
  });
  it("retries until exactly one permitted application matches", () => {
    const ambiguous = decide(inCode, {
      ...folder,
      launcherStatus: "ambiguous",
      launcherCandidates: [
        "Visual Studio Code",
        "Visual Studio Code - Insiders",
      ],
    });
    expect(ambiguous.kind).toBe("RETRY");
    expect(ambiguous.reason).toContain("More than one installed application");
    expect(ambiguous.reason).toContain("Visual Studio Code - Insiders");
    const unresolved = decide(inCode, {
      ...folder,
      launcherStatus: "unresolved",
      launcherCandidates: ["Xcode"],
    });
    expect(unresolved.kind).toBe("RETRY");
    expect(unresolved.reason).toContain("No installed application matches");
    expect(unresolved.reason).toContain("Xcode");
    // No launcher fields at all: native did not resolve the app.
    expect(decide(inCode, folder).kind).toBe("RETRY");
    // Resolved but with no id is not a resolution.
    expect(decide(inCode, { ...folder, launcherStatus: "resolved" }).kind).toBe(
      "RETRY",
    );
  });
  it("still needs the item itself to resolve", () => {
    for (const surface of [
      { ...code },
      { ...code, fileStatus: "unresolved" as const },
      { ...code, fileStatus: "resolved" as const },
    ]) {
      const d = decide(inCode, surface);
      expect(d.kind).toBe("RETRY");
      expect(d.reason).toContain("not in the local index");
    }
    // A refused item is refused before the application is even considered.
    expect(decide(inCode, { ...code, fileStatus: "refused" })).toMatchObject({
      kind: "DENY",
      reason: expect.stringContaining("apps, scripts"),
    });
  });
  it("ignores launcher fields when no application is named", () => {
    const plain = act({ type: "open_file", path: "~/Projects/rlenvforHUD1" });
    expect(decide(plain, { ...folder, launcherStatus: "refused" })).toEqual({
      kind: "ALLOW",
      reason: "Open a document or folder from the local index.",
    });
    expect(
      decide(plain, { launcherStatus: "resolved", launcherAppId: "x" }).kind,
    ).toBe("RETRY");
  });
  it("keeps the protected foreground ahead of the opener", () => {
    expect(
      decide(inCode, { ...folder, ...code, appId: "com.apple.Terminal" }).kind,
    ).toBe("USER_TAKEOVER");
    expect(decide(inCode, { ...folder, ...code }, true)).toEqual({
      kind: "RETRY",
      reason: "The tutorial has no files to open.",
    });
  });
});

describe("monitor", () => {
  it("defaults and bounds its fields", () => {
    expect(
      actionSchema.parse({ type: "monitor", frame_id: "f", reason: "r" }),
    ).toEqual({
      type: "monitor",
      frame_id: "f",
      reason: "r",
      every_s: 10,
      max_min: 30,
      until: "done",
    });
    const parse = (fields: Record<string, unknown>) =>
      actionSchema.safeParse({
        type: "monitor",
        frame_id: "f",
        reason: "r",
        ...fields,
      }).success;
    expect(parse({ every_s: 5, max_min: 1, until: "input" })).toBe(true);
    expect(parse({ every_s: 60, max_min: 180, until: "change" })).toBe(true);
    for (const bad of [
      { every_s: 4 },
      { every_s: 61 },
      { every_s: 10.5 },
      { max_min: 0 },
      { max_min: 181 },
      { until: "never" },
      { reason: "" },
      { reason: "x".repeat(201) },
      { extra: 1 },
    ])
      expect([bad, parse(bad)]).toEqual([bad, false]);
  });
  it("is allowed anywhere the surface is, and nowhere it is not", () => {
    const monitor = act({ type: "monitor", reason: "wait for the build" });
    expect(decide(monitor, { appId: "com.microsoft.VSCode" })).toEqual({
      kind: "ALLOW",
      reason: "Watch the frontmost window without sending input.",
    });
    // Reading a protected window is refused like everything else there.
    expect(decide(monitor, { appId: "com.apple.Terminal" }).kind).toBe(
      "USER_TAKEOVER",
    );
    expect(decide(monitor, { appId: "com.1password.1password" }).kind).toBe(
      "USER_TAKEOVER",
    );
    expect(decide(monitor, { secureInput: true }).kind).toBe("USER_TAKEOVER");
    expect(
      decide(monitor, { appId: "com.google.Chrome", domain: "chase.com" }).kind,
    ).toBe("USER_TAKEOVER");
  });
});
