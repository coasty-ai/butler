import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RESERVED_PROVIDERS,
  TOOL_ID,
  TOOL_LIMITS,
  TOOL_REFUSALS,
  type ProviderResult,
  type ToolSpec,
} from "../src/core/tools";
import { LOCAL_SERVERS, WEB } from "../src/tools/providers";
import {
  FILES,
  FILE_LIMITS,
  FILE_TOOLS,
  FILE_TOOL_IDS,
  FILE_TOOL_NAMES,
  FILE_WRITE_TOOL_IDS,
  REPLACING_WORDS,
  asksToReplace,
  checkArgs,
  createFilesProvider,
  credentialLikeName,
  fileName,
  fileToolSpec,
  homePath,
  refusedExtension,
  textOf,
} from "../src/tools/providers/files";
import type { McpProvider } from "../src/tools/mcp";

/**
 * The files tool against a real temp folder standing in for the home
 * folder: which paths it touches and which it refuses, before and after the
 * realpath; the read, append, write and list round trips; the byte, text
 * and credential floors; the read-back that makes a write verified; and the
 * undo that puts the previous contents back unless the file moved on.
 */
let home: string;
let provider: McpProvider;
let now = 1_000_000;
const signal = new AbortController().signal;
const spec = (name: (typeof FILE_TOOL_NAMES)[number]): ToolSpec =>
  fileToolSpec(name);
const call = (
  name: (typeof FILE_TOOL_NAMES)[number],
  args: Record<string, unknown>,
) =>
  provider.call(spec(name), args, {
    signal,
    timeoutMs: TOOL_LIMITS.callTimeoutMs,
  });
const code = (result: ProviderResult) => /^([A-Z_]+):/.exec(result.raw)?.[1];
const file = (relative: string) => join(home, relative);
const text = (relative: string) => readFileSync(file(relative), "utf8");

beforeEach(async () => {
  // realpath: on macOS the temp dir is a symlink (/var → /private/var), and
  // the rules compare realpaths against the home they are given.
  home = realpathSync(mkdtempSync(join(tmpdir(), "butler-files-")));
  mkdirSync(join(home, "OpenAssistBench/benchnote0a1b"), { recursive: true });
  mkdirSync(join(home, "Library/Keychains"), { recursive: true });
  mkdirSync(join(home, "Library/Mobile Documents/com~apple~CloudDocs/Notes"), {
    recursive: true,
  });
  writeFileSync(
    file("OpenAssistBench/benchnote0a1b/benchnote0a1b-notes.txt"),
    "Research notes for benchnote0a1b\n",
  );
  now = 1_000_000;
  provider = createFilesProvider({ home, now: () => now });
  await provider.start();
});
afterEach(async () => {
  await provider.close();
  rmSync(home, { recursive: true, force: true });
});

describe("the files tool's table", () => {
  it("is six builtin, trusted, local, closed-world tools under a reserved id", () => {
    expect(RESERVED_PROVIDERS.has("files")).toBe(true);
    expect(LOCAL_SERVERS).toEqual([FILES, WEB]);
    expect(FILE_TOOL_NAMES).toEqual([
      "read_text_file",
      "append_text_file",
      "replace_file_text",
      "list_directory",
      "rename_file",
      "move_file",
    ]);
    expect(FILE_TOOL_IDS).toEqual([
      "files__read_text_file",
      "files__append_text_file",
      "files__replace_file_text",
      "files__list_directory",
      "files__rename_file",
      "files__move_file",
    ]);
    // The content writes alone: a rename or move is not a note written.
    expect(FILE_WRITE_TOOL_IDS).toEqual([
      "files__append_text_file",
      "files__replace_file_text",
    ]);
    // Nine Apple tools and six files tools fit the model's list.
    expect(9 + FILE_TOOL_NAMES.length).toBeLessThanOrEqual(TOOL_LIMITS.list);
    for (const name of FILE_TOOL_NAMES) {
      const s = spec(name);
      expect(TOOL_ID.test(s.id)).toBe(true);
      expect(s).toMatchObject({
        provider: "files",
        title: "Files",
        trusted: true,
        local: true,
        openWorld: false,
        longRunning: false,
        transport: "builtin",
        timeoutMs: TOOL_LIMITS.callTimeoutMs,
        dateKeys: [],
        trace: { tool: name, server: "files" },
      });
      expect(s.does.length).toBeLessThanOrEqual(200);
      expect(s.params.length).toBeLessThanOrEqual(300);
    }
    expect(spec("read_text_file").tier).toBe("read");
    expect(spec("list_directory").tier).toBe("read");
    expect(spec("append_text_file")).toMatchObject({
      tier: "additive",
      undoable: true,
    });
    expect(spec("replace_file_text")).toMatchObject({
      tier: "write",
      undoable: true,
    });
    for (const name of ["rename_file", "move_file"] as const) {
      expect(spec(name)).toMatchObject({ tier: "write", undoable: true });
      expect(FILE_TOOLS[name].does).toContain("never over an existing file");
      expect(FILE_TOOLS[name].does).toContain("One call per file");
    }
    expect(FILE_TOOLS.append_text_file.does).toContain("keeping what is there");
    // Naming that steers a small model (probe cycle 20260919-1952: "write
    // <fact> into <path>" matched the tool then named write_text_file, and
    // the header went with the file): the additive tool's description
    // carries the verbs a task uses, the erasing tool says what it does and
    // names the other, and no tool has "write" in its name.
    expect(FILE_TOOLS.append_text_file.does).toMatch(/\bwrite\b.*\badd\b/);
    expect(FILE_TOOLS.replace_file_text.does).toMatch(/erasing/);
    expect(FILE_TOOLS.replace_file_text.does).toContain("append_text_file");
    for (const name of FILE_TOOL_NAMES) expect(name).not.toMatch(/write/);
    expect(FILE_LIMITS.readBytes).toBe(TOOL_LIMITS.rawResultBytes);
  });
  it("follows settings.tools.files", () => {
    const s = { tools: { files: true } } as never;
    const off = { tools: { files: false } } as never;
    expect(FILES.enabled(s)).toBe(true);
    expect(FILES.enabled(off)).toBe(false);
    expect(FILES.id).toBe("files");
  });
  it("lists its tools only while on", async () => {
    expect((await provider.tools(signal)).map((t) => t.id)).toEqual(
      FILE_TOOL_IDS,
    );
    expect(provider.state()).toEqual({
      state: "on",
      toolCount: 6,
      restarts: 0,
    });
    await provider.close();
    expect(await provider.tools(signal)).toEqual([]);
    expect(provider.state().state).toBe("off");
    expect(
      provider.prepare(spec("read_text_file"), { path: "~/a.txt" }),
    ).toEqual({ ok: false, problem: "unavailable" });
    expect((await call("read_text_file", { path: "~/a.txt" })).code).toBe(
      "unavailable",
    );
    expect(provider.catalog()).toEqual([]);
    expect(provider.pinOf("read_text_file")).toBeUndefined();
    expect(provider.stderrBytes()).toBe(0);
  });
});

describe("paths", () => {
  const HOME = "/Users/me";
  const accepts = (path: string) => {
    const found = homePath(path, HOME);
    expect(found, path).not.toHaveProperty("problem");
    return found as Exclude<ReturnType<typeof homePath>, { problem: string }>;
  };
  const refuses = (path: unknown, problem: string) =>
    expect(homePath(path, HOME), String(path)).toEqual({ problem });
  it("takes a ~/ path or the home folder's own absolute form, and reports the ~/ form", () => {
    expect(accepts("~/OpenAssistBench/x/x-notes.txt")).toEqual({
      absolute: "/Users/me/OpenAssistBench/x/x-notes.txt",
      relative: "~/OpenAssistBench/x/x-notes.txt",
      name: "x-notes.txt",
      components: ["OpenAssistBench", "x", "x-notes.txt"],
    });
    expect(accepts("/Users/me/Documents/a.csv").relative).toBe(
      "~/Documents/a.csv",
    );
    expect(accepts("~/Documents/").name).toBe("Documents");
    expect(homePath("~/Documents", "/Users/me/")).toMatchObject({
      absolute: "/Users/me/Documents",
    });
    // The iCloud Drive subtree is the one part of ~/Library a person keeps documents in.
    expect(
      accepts("~/Library/Mobile Documents/com~apple~CloudDocs/Notes/a.txt")
        .name,
    ).toBe("a.txt");
  });
  it("refuses what open_file refuses: outside home, the home itself, .., hidden, Library, credentials, dependency folders", () => {
    refuses("/etc/passwd", "OUTSIDE_HOME");
    refuses("/Users/other/a.txt", "OUTSIDE_HOME");
    refuses("/Users/me2/a.txt", "OUTSIDE_HOME");
    refuses("/Volumes/USB/a.txt", "OUTSIDE_HOME");
    refuses("~", "PROTECTED_PATH");
    refuses("~/", "PROTECTED_PATH");
    refuses("/Users/me", "PROTECTED_PATH");
    refuses("~/Documents/../../etc/passwd", "BAD_PATH");
    refuses("~/Documents/./a.txt", "BAD_PATH");
    refuses("~/Documents//a.txt", "BAD_PATH");
    refuses("~/.ssh/id_rsa", "PROTECTED_PATH");
    refuses("~/.env", "PROTECTED_PATH");
    refuses("~/Documents/.hidden/a.txt", "PROTECTED_PATH");
    refuses("~/Library/Keychains/login.keychain-db", "PROTECTED_PATH");
    refuses("~/Library/Application Support/x/a.txt", "PROTECTED_PATH");
    refuses("~/Library/Mobile Documents/com~apple~CloudDocs", "PROTECTED_PATH");
    refuses("~/Library", "PROTECTED_PATH");
    refuses("~/Documents/passwords.txt", "PROTECTED_PATH");
    refuses("~/Documents/secret-plan.txt", "PROTECTED_PATH");
    refuses("~/Documents/id_rsa.pub", "PROTECTED_PATH");
    refuses("~/Documents/cert.pem", "PROTECTED_PATH");
    refuses("~/Downloads/logins.csv", "PROTECTED_PATH");
    refuses("~/code/node_modules/a/README.md", "PROTECTED_PATH");
    refuses("~/code/.git/config", "PROTECTED_PATH");
    refuses("~/.Trash/a.txt", "PROTECTED_PATH");
    refuses("Documents/a.txt", "BAD_PATH");
    refuses("file:///Users/me/a.txt", "BAD_PATH");
    refuses("~user/a.txt", "BAD_PATH");
    refuses("~/Documents/a\u0000.txt", "BAD_PATH");
    refuses("~/Documents/a\n.txt", "BAD_PATH");
    refuses("", "BAD_PATH");
    refuses(42, "BAD_PATH");
    refuses(`~/${"a".repeat(FILE_LIMITS.pathChars)}`, "BAD_PATH");
    // No home to speak of: nothing is inside it.
    expect(homePath("~/a.txt", "")).toEqual({ problem: "OUTSIDE_HOME" });
    expect(homePath("~/a.txt", "/")).toEqual({ problem: "OUTSIDE_HOME" });
  });
  it("names credential-like files and executable kinds as the native rules do", () => {
    for (const name of [
      ".env.local",
      ".netrc",
      "logins.csv",
      "wallet.dat",
      "id_ed25519",
      "bitwarden_export_2026.json",
      "my-passwords.kdbx",
      "AuthKey_ABC.p8",
      "client.ovpn",
      "Passwd-list.txt",
      "credentials.json",
      "login.keychain-db",
    ])
      expect(credentialLikeName(name), name).toBe(true);
    for (const name of ["notes.txt", "ledger.csv", "README.md", "a.key.txt"])
      expect(credentialLikeName(name), name).toBe(false);
    for (const name of [
      "run.sh",
      "open.command",
      "setup.pkg",
      "disk.dmg",
      "script.py",
      "index.js",
      "Info.plist",
      "link.webloc",
      "Thing.app",
      "do.applescript",
      "x.SH",
    ])
      expect(refusedExtension(name), name).toBe(true);
    for (const name of ["notes.txt", "data.csv", "README.md", "a.log", "csv"])
      expect(refusedExtension(name), name).toBe(false);
  });
  it("checks arguments by the tool's own keys and turns a refused path into the bad_path problem before any question", () => {
    const ok = checkArgs(
      "append_text_file",
      { path: "~/Documents/a.txt", text: "hi" },
      HOME,
    );
    expect(ok).toMatchObject({
      name: "append_text_file",
      text: "hi",
      newline: true,
    });
    expect(
      checkArgs(
        "append_text_file",
        { path: "~/Documents/a.txt", text: "hi", newline: false },
        HOME,
      ),
    ).toMatchObject({ newline: false });
    for (const [name, args] of [
      ["append_text_file", { path: "~/Documents/a.txt" }],
      ["append_text_file", { path: "~/Documents/a.txt", text: 3 }],
      ["append_text_file", { path: "~/a.txt", text: "x", newline: "yes" }],
      ["append_text_file", { path: "~/a.txt", text: "x", mode: "0777" }],
      ["read_text_file", { path: "~/a.txt", text: "x" }],
      ["read_text_file", {}],
      ["list_directory", { path: ["~/"] }],
      ["rename_file", { path: "~/a.txt" }],
      ["rename_file", { path: "~/a.txt", newName: 3 }],
      ["rename_file", { path: "~/a.txt", newName: "b.txt", text: "x" }],
      ["move_file", { path: "~/a.txt" }],
      ["move_file", { path: "~/a.txt", toFolder: ["~/b"] }],
      ["undo", { token: "t" }],
      ["bash", { path: "~/a.txt" }],
    ] as const)
      expect(checkArgs(name, args as never, HOME), name).toEqual({
        problem: "invalid_args",
      });
    // A new name that is not a bare file name is invalid_args (BAD_NAME at
    // call); one the path rules refuse is bad_path with the finer code.
    for (const newName of ["", "  ", "a/b.txt", ".", "..", "sub/", "a\nb"])
      expect(
        checkArgs("rename_file", { path: "~/a.txt", newName }, HOME),
        JSON.stringify(newName),
      ).toEqual({ problem: "invalid_args", code: "BAD_NAME" });
    for (const [newName, code] of [
      [".hidden.txt", "PROTECTED_PATH"],
      ["passwords.txt", "PROTECTED_PATH"],
      ["node_modules", "PROTECTED_PATH"],
      ["run.sh", "EXECUTABLE"],
      ["Thing.app", "EXECUTABLE"],
      ["link.webloc", "EXECUTABLE"],
    ] as const)
      expect(
        checkArgs("rename_file", { path: "~/a.txt", newName }, HOME),
        newName,
      ).toEqual({ problem: "bad_path", code });
    expect(
      checkArgs("rename_file", { path: "~/a.txt", newName: "b.txt" }, HOME),
    ).toMatchObject({ name: "rename_file", newName: "b.txt" });
    expect(fileName("x".repeat(FILE_LIMITS.nameChars + 1))).toEqual({
      problem: "BAD_NAME",
    });
    expect(fileName("2026-03-04-acme-42.txt")).toEqual({
      name: "2026-03-04-acme-42.txt",
    });
    // The folder a move goes to follows the path rules, with its code.
    for (const [toFolder, code] of [
      ["/etc", "OUTSIDE_HOME"],
      ["~/Library/Preferences", "PROTECTED_PATH"],
      ["~/.hidden", "PROTECTED_PATH"],
      ["~", "PROTECTED_PATH"],
      ["~/Documents/../x", "BAD_PATH"],
      ["~/Apps/Thing.app", "EXECUTABLE"],
    ] as const)
      expect(
        checkArgs("move_file", { path: "~/a.txt", toFolder }, HOME),
        toFolder,
      ).toEqual({ problem: "bad_path", code });
    expect(
      checkArgs("move_file", { path: "~/a.txt", toFolder: "~/Archive/" }, HOME),
    ).toMatchObject({
      name: "move_file",
      toFolder: { relative: "~/Archive", name: "Archive" },
    });
    // The source of a rename or move is a write: an executable kind is refused.
    expect(
      checkArgs(
        "rename_file",
        { path: "~/bin/run.sh", newName: "x.txt" },
        HOME,
      ),
    ).toEqual({ problem: "bad_path" });
    expect(
      checkArgs("move_file", { path: "~/setup.pkg", toFolder: "~/Old" }, HOME),
    ).toEqual({ problem: "bad_path" });
    for (const path of [
      "/etc/hosts",
      "~/.ssh/id_rsa",
      "~/Library/Preferences/a.plist",
      "~/Documents/../x.txt",
    ])
      expect(checkArgs("read_text_file", { path }, HOME), path).toEqual({
        problem: "bad_path",
      });
    // A write never touches an executable kind; a read of one is a content question.
    expect(
      checkArgs("replace_file_text", { path: "~/bin/run.sh", text: "x" }, HOME),
    ).toEqual({ problem: "bad_path" });
    expect(
      checkArgs("append_text_file", { path: "~/x.command", text: "x" }, HOME),
    ).toEqual({ problem: "bad_path" });
    expect(
      checkArgs("read_text_file", { path: "~/bin/run.sh" }, HOME),
    ).toMatchObject({ name: "read_text_file" });
  });
  it("prepares a question by the file's own name and grounds the call on the ~/ path alone", () => {
    const prepared = provider.prepare(spec("append_text_file"), {
      path: `${home}/OpenAssistBench/benchnote0a1b/benchnote0a1b-notes.txt`,
      text: "Build 4471 failed at lint",
    });
    expect(prepared).toEqual({
      ok: true,
      question: {
        kind: "file_append",
        name: "benchnote0a1b-notes.txt",
        text: "Build 4471 failed at lint",
      },
      // The ~/ form whatever way the model wrote it; the text stays out.
      groundText: ["~/OpenAssistBench/benchnote0a1b/benchnote0a1b-notes.txt"],
      argsBytes: expect.any(Number),
    });
    expect(
      provider.prepare(spec("replace_file_text"), {
        path: "~/Documents/a.txt",
        text: "all new",
      }),
    ).toMatchObject({
      question: { kind: "file_write", name: "a.txt", text: "all new" },
    });
    expect(
      provider.prepare(spec("read_text_file"), { path: "~/Documents/a.txt" }),
    ).toMatchObject({ question: { kind: "file_read", name: "a.txt" } });
    expect(
      provider.prepare(spec("list_directory"), { path: "~/Documents/" }),
    ).toMatchObject({ question: { kind: "file_list", name: "Documents" } });
    // A rename grounds on the path alone (the new name is content); a move
    // grounds on the file and the folder.
    expect(
      provider.prepare(spec("rename_file"), {
        path: "~/Documents/receipt-1.txt",
        newName: "2026-03-04-acme-42.txt",
      }),
    ).toEqual({
      ok: true,
      question: {
        kind: "file_rename",
        name: "receipt-1.txt",
        newName: "2026-03-04-acme-42.txt",
      },
      groundText: ["~/Documents/receipt-1.txt"],
      argsBytes: expect.any(Number),
    });
    expect(
      provider.prepare(spec("move_file"), {
        path: "~/Documents/receipt-1.txt",
        toFolder: "~/Documents/Archive",
      }),
    ).toEqual({
      ok: true,
      question: { kind: "file_move", name: "receipt-1.txt", folder: "Archive" },
      groundText: ["~/Documents/receipt-1.txt", "~/Documents/Archive"],
      argsBytes: expect.any(Number),
    });
    expect(
      provider.prepare(spec("rename_file"), {
        path: "~/Documents/a.txt",
        newName: "a/b.txt",
      }),
    ).toEqual({ ok: false, problem: "invalid_args" });
    expect(
      provider.prepare(spec("rename_file"), {
        path: "~/Documents/a.txt",
        newName: "run.sh",
      }),
    ).toEqual({ ok: false, problem: "bad_path" });
    expect(
      provider.prepare(spec("move_file"), {
        path: "~/Documents/a.txt",
        toFolder: "/tmp",
      }),
    ).toEqual({ ok: false, problem: "bad_path" });
    expect(
      provider.prepare(spec("read_text_file"), { path: "~/.ssh/config" }),
    ).toEqual({ ok: false, problem: "bad_path" });
    expect(provider.prepare(spec("read_text_file"), {})).toEqual({
      ok: false,
      problem: "invalid_args",
    });
  });
});

describe("the content-keeping rule", () => {
  const NOTES = "~/OpenAssistBench/benchnote0a1b/benchnote0a1b-notes.txt";
  const notes = "OpenAssistBench/benchnote0a1b/benchnote0a1b-notes.txt";
  const replace = (path: string, words?: string) =>
    provider.prepare(
      spec("replace_file_text"),
      { path, text: "name,price,days\nAcme,120,3\n" },
      { userWords: words },
    );
  it("refuses to replace a file that holds text unless the words ask for it, with the fixed retry and no question", () => {
    // The note tasks' words: "write <fact> into <path>", no replacing word.
    for (const words of [
      `In Safari, read the report and write the Q3 total on a new line in ${NOTES}. Save it.`,
      "fill in the table",
      "add the totals to the notes file, clearly marked",
      "",
      undefined,
    ])
      expect(replace(NOTES, words), String(words)).toEqual({
        ok: false,
        problem: "would_erase",
      });
    // No third argument at all (an older caller) reads as no words.
    expect(
      provider.prepare(spec("replace_file_text"), { path: NOTES, text: "x" }),
    ).toEqual({ ok: false, problem: "would_erase" });
    expect(text(notes)).toBe("Research notes for benchnote0a1b\n");
    expect(TOOL_REFUSALS.would_erase).toMatch(/^No input was sent\./);
    expect(TOOL_REFUSALS.would_erase).toContain("append_text_file");
    expect(TOOL_REFUSALS.would_erase).toContain("replace_file_text");
    expect(TOOL_REFUSALS.would_erase).toMatch(/replace, overwrite or clear/);
  });
  it("replaces once the words say replace, overwrite, rewrite, clear, erase or start over, in any form", () => {
    for (const words of [
      `Replace what ${NOTES} holds with the price table.`,
      `overwrite ${NOTES} with the table`,
      `Rewrite ${NOTES} as a CSV table`,
      `clear ${NOTES} and put the table in`,
      `Erase the notes in ${NOTES}, then add the table`,
      `start over in ${NOTES} with the table`,
      "REPLACING the file's contents",
      "the file was overwritten last time; do it again",
      "it has been cleared before",
      "erased",
      "starting afresh",
    ])
      expect(replace(NOTES, words), words).toMatchObject({
        ok: true,
        question: { kind: "file_write", name: "benchnote0a1b-notes.txt" },
        groundText: [NOTES],
      });
    for (const words of [
      "write it clearly",
      "the erasure was a mistake",
      "restart the server",
      "started",
      "over",
      "nuclear power",
    ])
      expect(asksToReplace(words), words).toBe(false);
    expect(asksToReplace(undefined)).toBe(false);
    expect(REPLACING_WORDS.flags).toContain("i");
  });
  it("lets an empty or absent file be written, leaves a folder to the call, and follows a symlink to what it would erase", () => {
    const empty = "~/OpenAssistBench/benchnote0a1b/benchnote0a1b-empty.txt";
    writeFileSync(
      file("OpenAssistBench/benchnote0a1b/benchnote0a1b-empty.txt"),
      "",
    );
    expect(replace(empty, "write the table into the file")).toMatchObject({
      ok: true,
      question: { kind: "file_write" },
    });
    expect(
      replace("~/OpenAssistBench/benchnote0a1b/benchnote0a1b-new.csv", "x"),
    ).toMatchObject({ ok: true });
    expect(
      replace("~/OpenAssistBench/benchnote0a1b/benchnote0a1b-new.csv"),
    ).toMatchObject({ ok: true });
    // A folder is not a file with contents; call() answers NOT_A_FILE.
    expect(replace("~/OpenAssistBench", "x")).toMatchObject({ ok: true });
    // The append never asks the question: it keeps what is there.
    expect(
      provider.prepare(
        spec("append_text_file"),
        { path: NOTES, text: "Q3 total 15,888" },
        { userWords: "write the Q3 total into the notes" },
      ),
    ).toMatchObject({ ok: true, question: { kind: "file_append" } });
    // A symlink at the path is what the write would follow.
    symlinkSync(file(notes), file("OpenAssistBench/benchnote0a1b/alias.txt"));
    expect(
      replace("~/OpenAssistBench/benchnote0a1b/alias.txt", "put the table in"),
    ).toEqual({ ok: false, problem: "would_erase" });
    // A path the rules refuse is bad_path first, whatever the words.
    expect(replace("~/.ssh/config", "replace it")).toEqual({
      ok: false,
      problem: "bad_path",
    });
  });
});

describe("append, write, read and list", () => {
  const NOTES = "~/OpenAssistBench/benchnote0a1b/benchnote0a1b-notes.txt";
  const notes = "OpenAssistBench/benchnote0a1b/benchnote0a1b-notes.txt";
  it("appends on its own line, keeps the header, reads back and reports verified facts with an undo token", async () => {
    const result = await call("append_text_file", {
      path: NOTES,
      text: "Build 4471 failed at lint",
    });
    expect(result).toMatchObject({
      code: "ok",
      items: 1,
      verified: true,
      facts: {
        kind: "file",
        name: "benchnote0a1b-notes.txt",
        change: "appended",
        lines: 1,
      },
    });
    expect(result.undoToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.raw).toBe(
      `Added 1 line to ${NOTES}; it now holds 2 lines (59 bytes).`,
    );
    expect(text(notes)).toBe(
      "Research notes for benchnote0a1b\nBuild 4471 failed at lint\n",
    );
    // A file whose last line is open gets its newline first; the text's own
    // trailing newline is not doubled; several lines count as several.
    writeFileSync(file(notes), "header");
    await call("append_text_file", { path: NOTES, text: "one\ntwo\n" });
    expect(text(notes)).toBe("header\none\ntwo\n");
    const again = await call("append_text_file", { path: NOTES, text: "3" });
    expect(again.facts).toMatchObject({ lines: 1 });
    expect(text(notes)).toBe("header\none\ntwo\n3\n");
    // newline:false appends the bytes as given.
    await call("append_text_file", {
      path: NOTES,
      text: " tail",
      newline: false,
    });
    expect(text(notes)).toBe("header\none\ntwo\n3\n tail");
    // An empty file: no leading newline.
    writeFileSync(file(notes), "");
    await call("append_text_file", { path: NOTES, text: "first" });
    expect(text(notes)).toBe("first\n");
  });
  it("creates a missing file in an existing folder, and refuses a missing folder", async () => {
    const created = await call("append_text_file", {
      path: "~/OpenAssistBench/benchnote0a1b/benchnote0a1b-kpi.txt",
      text: "Revenue 12,400\nSignups 88",
    });
    expect(created).toMatchObject({
      code: "ok",
      verified: true,
      facts: { change: "created", lines: 2, name: "benchnote0a1b-kpi.txt" },
    });
    expect(created.raw).toContain("Created ~/OpenAssistBench/");
    expect(text("OpenAssistBench/benchnote0a1b/benchnote0a1b-kpi.txt")).toBe(
      "Revenue 12,400\nSignups 88\n",
    );
    const missing = await call("replace_file_text", {
      path: "~/Nowhere/a.txt",
      text: "x",
    });
    expect(missing.code).toBe("error");
    expect(code(missing)).toBe("NOT_FOUND");
    expect(existsSync(file("Nowhere"))).toBe(false);
  });
  it("replaces the whole file with replace_file_text and reads it back (call() trusts prepare's rule)", async () => {
    const result = await call("replace_file_text", {
      path: NOTES,
      text: "name,price,days\nAcme,120,3\n",
    });
    expect(result).toMatchObject({
      code: "ok",
      verified: true,
      facts: { change: "replaced", lines: 2 },
    });
    expect(result.raw).toContain("Replaced the contents of");
    expect(text(notes)).toBe("name,price,days\nAcme,120,3\n");
    const created = await call("replace_file_text", {
      path: "~/OpenAssistBench/benchnote0a1b/benchnote0a1b-compare.csv",
      text: "a,b",
    });
    expect(created.facts).toMatchObject({ change: "created", lines: 1 });
  });
  it("reads a text file whole and refuses a folder, a missing file, a binary and one over the cap", async () => {
    const read = await call("read_text_file", { path: NOTES });
    expect(read).toEqual({
      code: "ok",
      raw: "Research notes for benchnote0a1b\n",
      items: 1,
    });
    expect(read).not.toHaveProperty("undoToken");
    expect(
      code(await call("read_text_file", { path: "~/OpenAssistBench" })),
    ).toBe("NOT_A_FILE");
    expect(
      code(await call("read_text_file", { path: "~/OpenAssistBench/no.txt" })),
    ).toBe("NOT_FOUND");
    writeFileSync(file("OpenAssistBench/bin.dat"), Buffer.from([1, 0, 2, 3]));
    expect(
      code(await call("read_text_file", { path: "~/OpenAssistBench/bin.dat" })),
    ).toBe("NOT_TEXT");
    writeFileSync(file("OpenAssistBench/latin.txt"), Buffer.from([0xe9, 0x41]));
    expect(
      code(
        await call("read_text_file", { path: "~/OpenAssistBench/latin.txt" }),
      ),
    ).toBe("NOT_TEXT");
    writeFileSync(
      file("OpenAssistBench/big.txt"),
      "x".repeat(FILE_LIMITS.readBytes + 1),
    );
    const big = await call("read_text_file", {
      path: "~/OpenAssistBench/big.txt",
    });
    expect(code(big)).toBe("TOO_LARGE");
    expect(big.raw).toContain(String(FILE_LIMITS.readBytes));
    // Exactly the cap reads.
    writeFileSync(
      file("OpenAssistBench/edge.txt"),
      "y".repeat(FILE_LIMITS.readBytes),
    );
    expect(
      (await call("read_text_file", { path: "~/OpenAssistBench/edge.txt" }))
        .code,
    ).toBe("ok");
    expect(textOf(Buffer.from("héllo", "utf8"))).toBe("héllo");
    expect(textOf(Buffer.from([0x68, 0x00]))).toBeUndefined();
  });
  it("never appends to or replaces a binary, an executable kind or a folder, and bounds the result size", async () => {
    writeFileSync(file("OpenAssistBench/bin.dat"), Buffer.from([1, 0, 2, 3]));
    expect(
      code(
        await call("append_text_file", {
          path: "~/OpenAssistBench/bin.dat",
          text: "x",
        }),
      ),
    ).toBe("NOT_TEXT");
    expect(readFileSync(file("OpenAssistBench/bin.dat"))).toEqual(
      Buffer.from([1, 0, 2, 3]),
    );
    expect(
      code(
        await call("append_text_file", {
          path: "~/OpenAssistBench",
          text: "x",
        }),
      ),
    ).toBe("NOT_A_FILE");
    // A symlink named like a note that points at a script is the script.
    writeFileSync(file("OpenAssistBench/run.sh"), "#!/bin/sh\n");
    symlinkSync(
      file("OpenAssistBench/run.sh"),
      file("OpenAssistBench/innocent.txt"),
    );
    expect(
      code(
        await call("append_text_file", {
          path: "~/OpenAssistBench/innocent.txt",
          text: "rm -rf /",
        }),
      ),
    ).toBe("EXECUTABLE");
    expect(text("OpenAssistBench/run.sh")).toBe("#!/bin/sh\n");
    writeFileSync(
      file("OpenAssistBench/full.txt"),
      "z".repeat(FILE_LIMITS.fileBytes - 2),
    );
    expect(
      code(
        await call("append_text_file", {
          path: "~/OpenAssistBench/full.txt",
          text: "more",
        }),
      ),
    ).toBe("TOO_LARGE");
    expect(text("OpenAssistBench/full.txt").length).toBe(
      FILE_LIMITS.fileBytes - 2,
    );
  });
  it("refuses a credential in the text as a floor of its own, whatever policy said", async () => {
    for (const secret of [
      "api_key=sk-abcdefghijklmnopqrstuv",
      "token: eyJhbGciOi.eyJzdWIiOiIx.SflKxwRJSMe",
      "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
    ]) {
      const result = await call("append_text_file", {
        path: NOTES,
        text: secret,
      });
      expect(code(result), secret).toBe("CREDENTIAL");
      expect(result.raw).not.toContain("sk-");
      expect(result.raw).not.toContain("eyJ");
    }
    expect(text(notes)).toBe("Research notes for benchnote0a1b\n");
    // Ordinary text is the user's and goes in unredacted: a password field's
    // label, a price, an address.
    const plain = await call("append_text_file", {
      path: NOTES,
      text: "Password reset link sent to dana@example.com, $12.50",
    });
    expect(plain.code).toBe("ok");
    expect(text(notes)).toContain(
      "Password reset link sent to dana@example.com, $12.50",
    );
  });
  it("holds a symlink to the same rules by its realpath", async () => {
    const outside = mkdtempSync(join(tmpdir(), "butler-outside-"));
    try {
      writeFileSync(join(outside, "target.txt"), "theirs\n");
      symlinkSync(
        join(outside, "target.txt"),
        file("OpenAssistBench/link.txt"),
      );
      symlinkSync(outside, file("OpenAssistBench/elsewhere"));
      mkdirSync(file("Documents"));
      symlinkSync(file("Library/Keychains"), file("Documents/keys"));
      expect(
        code(
          await call("read_text_file", { path: "~/OpenAssistBench/link.txt" }),
        ),
      ).toBe("OUTSIDE_HOME");
      expect(
        code(
          await call("append_text_file", {
            path: "~/OpenAssistBench/link.txt",
            text: "mine",
          }),
        ),
      ).toBe("OUTSIDE_HOME");
      expect(readFileSync(join(outside, "target.txt"), "utf8")).toBe(
        "theirs\n",
      );
      expect(
        code(
          await call("replace_file_text", {
            path: "~/OpenAssistBench/elsewhere/new.txt",
            text: "x",
          }),
        ),
      ).toBe("OUTSIDE_HOME");
      expect(existsSync(join(outside, "new.txt"))).toBe(false);
      expect(
        code(await call("list_directory", { path: "~/Documents/keys" })),
      ).toBe("PROTECTED_PATH");
      expect(
        code(
          await call("replace_file_text", {
            path: "~/Documents/keys/x.txt",
            text: "x",
          }),
        ),
      ).toBe("PROTECTED_PATH");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
  it("lists a folder's visible entries with sizes, hiding dotfiles, credential-like names and dependency folders", async () => {
    mkdirSync(file("OpenAssistBench/benchnote0a1b/sub"));
    mkdirSync(file("OpenAssistBench/benchnote0a1b/node_modules"));
    writeFileSync(file("OpenAssistBench/benchnote0a1b/.DS_Store"), "x");
    writeFileSync(file("OpenAssistBench/benchnote0a1b/id_rsa"), "x");
    writeFileSync(file("OpenAssistBench/benchnote0a1b/b.csv"), "a,b\n");
    const listed = await call("list_directory", {
      path: "~/OpenAssistBench/benchnote0a1b",
    });
    expect(listed).toEqual({
      code: "ok",
      raw: [
        "b.csv (4 bytes)",
        "benchnote0a1b-notes.txt (33 bytes)",
        "sub/",
      ].join("\n"),
      items: 3,
    });
    expect(code(await call("list_directory", { path: NOTES }))).toBe(
      "NOT_A_FOLDER",
    );
    expect(
      code(await call("list_directory", { path: "~/OpenAssistBench/none" })),
    ).toBe("NOT_FOUND");
    mkdirSync(file("OpenAssistBench/many"));
    for (let i = 0; i < FILE_LIMITS.listEntries + 5; i++)
      writeFileSync(
        file(`OpenAssistBench/many/f${String(i).padStart(3, "0")}`),
        "",
      );
    const many = await call("list_directory", {
      path: "~/OpenAssistBench/many",
    });
    expect(many.items).toBe(FILE_LIMITS.listEntries);
    expect(many.raw.split("\n")).toHaveLength(FILE_LIMITS.listEntries + 1);
    expect(many.raw).toMatch(/… and 5 more$/);
    mkdirSync(file("OpenAssistBench/empty"));
    expect(
      await call("list_directory", { path: "~/OpenAssistBench/empty" }),
    ).toEqual({ code: "ok", raw: "(empty folder)", items: 0 });
  });
  it("answers a bad call with a code and no throw", async () => {
    expect(await call("read_text_file", { path: "/etc/hosts" })).toMatchObject({
      code: "error",
      raw: expect.stringMatching(/^BAD_PATH: /),
    });
    expect(await call("read_text_file", {})).toMatchObject({
      code: "error",
      raw: expect.stringMatching(/^BAD_ARGS: /),
    });
    expect(
      await provider.call(
        { ...spec("read_text_file"), name: "bash" },
        { path: "~/a.txt" },
        { signal, timeoutMs: 1000 },
      ),
    ).toMatchObject({ code: "error" });
  });
});

describe("rename and move", () => {
  const BENCH = "~/OpenAssistBench/benchnote0a1b";
  const bench = "OpenAssistBench/benchnote0a1b";
  const receipt = (n: number) => `${bench}/receipt-${n}.txt`;
  beforeEach(() => {
    for (const n of [1, 2])
      writeFileSync(
        file(receipt(n)),
        `Date: 2026-03-0${n}\nVendor: Acme\nTotal: $4${n}\n`,
      );
    mkdirSync(file(`${bench}/Archive`));
  });
  it("renames a file in place, verified by stat, with the facts and an undo token; one call per file", async () => {
    // Cycle 20260919-2044 files-rename-receipts: the receipt under its
    // date-vendor-amount name, its bytes untouched.
    const before = readFileSync(file(receipt(1)));
    const result = await call("rename_file", {
      path: `${BENCH}/receipt-1.txt`,
      newName: "2026-03-01-acme-41.txt",
    });
    expect(result).toMatchObject({
      code: "ok",
      items: 1,
      verified: true,
      facts: {
        kind: "file",
        name: "2026-03-01-acme-41.txt",
        change: "renamed",
        from: "receipt-1.txt",
      },
    });
    expect(result.facts).not.toHaveProperty("lines");
    expect(result.undoToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.raw).toBe(
      `Renamed ${BENCH}/receipt-1.txt to 2026-03-01-acme-41.txt.`,
    );
    expect(existsSync(file(receipt(1)))).toBe(false);
    expect(readFileSync(file(`${bench}/2026-03-01-acme-41.txt`))).toEqual(
      before,
    );
    // The other receipt is untouched: nothing else in the folder moved.
    expect(existsSync(file(receipt(2)))).toBe(true);
  });
  it("moves a file into an existing folder, keeping its name", async () => {
    const result = await call("move_file", {
      path: `${BENCH}/receipt-2.txt`,
      toFolder: `${BENCH}/Archive/`,
    });
    expect(result).toMatchObject({
      code: "ok",
      verified: true,
      facts: {
        kind: "file",
        name: "receipt-2.txt",
        change: "moved",
        folder: "Archive",
      },
    });
    expect(result.raw).toBe(
      `Moved ${BENCH}/receipt-2.txt to ${BENCH}/Archive/.`,
    );
    expect(existsSync(file(receipt(2)))).toBe(false);
    expect(text(`${bench}/Archive/receipt-2.txt`)).toContain("Vendor: Acme");
  });
  it("never lands on an existing item, whatever it is", async () => {
    expect(
      code(
        await call("rename_file", {
          path: `${BENCH}/receipt-1.txt`,
          newName: "receipt-2.txt",
        }),
      ),
    ).toBe("EXISTS");
    // A folder, a broken link, the file's own name: all taken.
    expect(
      code(
        await call("rename_file", {
          path: `${BENCH}/receipt-1.txt`,
          newName: "Archive",
        }),
      ),
    ).toBe("EXISTS");
    symlinkSync(file(`${bench}/nowhere`), file(`${bench}/dangling.txt`));
    expect(
      code(
        await call("rename_file", {
          path: `${BENCH}/receipt-1.txt`,
          newName: "dangling.txt",
        }),
      ),
    ).toBe("EXISTS");
    expect(
      code(
        await call("rename_file", {
          path: `${BENCH}/receipt-1.txt`,
          newName: "receipt-1.txt",
        }),
      ),
    ).toBe("EXISTS");
    writeFileSync(file(`${bench}/Archive/receipt-1.txt`), "older\n");
    expect(
      code(
        await call("move_file", {
          path: `${BENCH}/receipt-1.txt`,
          toFolder: `${BENCH}/Archive`,
        }),
      ),
    ).toBe("EXISTS");
    expect(
      code(
        await call("move_file", {
          path: `${BENCH}/receipt-1.txt`,
          toFolder: BENCH,
        }),
      ),
    ).toBe("EXISTS");
    // Nothing moved or was replaced.
    expect(text(receipt(1))).toContain("Total: $41");
    expect(text(receipt(2))).toContain("Total: $42");
    expect(text(`${bench}/Archive/receipt-1.txt`)).toBe("older\n");
  });
  it("refuses a missing file, a folder, a link, a missing or non-folder destination, and a bad new name, each with its code", async () => {
    expect(
      code(
        await call("rename_file", {
          path: `${BENCH}/receipt-9.txt`,
          newName: "x.txt",
        }),
      ),
    ).toBe("NOT_FOUND");
    expect(
      code(
        await call("rename_file", { path: `${BENCH}/Archive`, newName: "Old" }),
      ),
    ).toBe("NOT_A_FILE");
    symlinkSync(file(receipt(1)), file(`${bench}/alias.txt`));
    expect(
      code(
        await call("rename_file", {
          path: `${BENCH}/alias.txt`,
          newName: "x.txt",
        }),
      ),
    ).toBe("NOT_A_FILE");
    expect(
      code(
        await call("move_file", {
          path: `${BENCH}/alias.txt`,
          toFolder: `${BENCH}/Archive`,
        }),
      ),
    ).toBe("NOT_A_FILE");
    expect(existsSync(file(`${bench}/alias.txt`))).toBe(true);
    expect(existsSync(file(receipt(1)))).toBe(true);
    expect(
      code(
        await call("move_file", {
          path: `${BENCH}/receipt-1.txt`,
          toFolder: `${BENCH}/Nowhere`,
        }),
      ),
    ).toBe("NOT_FOUND");
    expect(
      code(
        await call("move_file", {
          path: `${BENCH}/receipt-1.txt`,
          toFolder: `${BENCH}/receipt-2.txt`,
        }),
      ),
    ).toBe("NOT_A_FOLDER");
    for (const [newName, expected] of [
      ["a/b.txt", "BAD_NAME"],
      ["", "BAD_NAME"],
      ["..", "BAD_NAME"],
      [".hidden", "PROTECTED_PATH"],
      ["secrets.txt", "PROTECTED_PATH"],
      ["run.sh", "EXECUTABLE"],
      ["x.webloc", "EXECUTABLE"],
    ] as const) {
      const result = await call("rename_file", {
        path: `${BENCH}/receipt-1.txt`,
        newName,
      });
      expect(code(result), newName).toBe(expected);
      expect(result.code).toBe("error");
    }
    // The old side of the rule: an executable kind is never renamed or
    // moved either, by the path as written and by its real name.
    writeFileSync(file(`${bench}/run.sh`), "#!/bin/sh\n");
    expect(
      code(
        await call("rename_file", {
          path: `${BENCH}/run.sh`,
          newName: "a.txt",
        }),
      ),
    ).toBe("BAD_PATH");
    expect(
      code(
        await call("move_file", {
          path: `${BENCH}/run.sh`,
          toFolder: `${BENCH}/Archive`,
        }),
      ),
    ).toBe("BAD_PATH");
    expect(existsSync(file(`${bench}/run.sh`))).toBe(true);
    for (const toFolder of ["/tmp", "~/Library/Preferences", "~/.Trash"])
      expect(
        (
          await call("move_file", {
            path: `${BENCH}/receipt-1.txt`,
            toFolder,
          })
        ).code,
        toFolder,
      ).toBe("error");
    expect(existsSync(file(receipt(1)))).toBe(true);
  });
  it("holds a folder given as a link to the same rules by its realpath, and moves into a linked folder inside the home", async () => {
    const outside = mkdtempSync(join(tmpdir(), "butler-outside-"));
    try {
      symlinkSync(outside, file(`${bench}/elsewhere`));
      expect(
        code(
          await call("move_file", {
            path: `${BENCH}/receipt-1.txt`,
            toFolder: `${BENCH}/elsewhere`,
          }),
        ),
      ).toBe("OUTSIDE_HOME");
      expect(existsSync(join(outside, "receipt-1.txt"))).toBe(false);
      symlinkSync(file("Library/Keychains"), file(`${bench}/keys`));
      expect(
        code(
          await call("move_file", {
            path: `${BENCH}/receipt-1.txt`,
            toFolder: `${BENCH}/keys`,
          }),
        ),
      ).toBe("PROTECTED_PATH");
      // A link to a folder inside the home is that folder.
      symlinkSync(file(`${bench}/Archive`), file(`${bench}/shelf`));
      const moved = await call("move_file", {
        path: `${BENCH}/receipt-1.txt`,
        toFolder: `${BENCH}/shelf`,
      });
      expect(moved).toMatchObject({
        code: "ok",
        facts: { change: "moved", folder: "shelf" },
      });
      expect(existsSync(file(`${bench}/Archive/receipt-1.txt`))).toBe(true);
      expect(existsSync(file(receipt(1)))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
  it("undoes a rename or a move by moving the file back, unless it moved again or its old place is taken", async () => {
    const renamed = await call("rename_file", {
      path: `${BENCH}/receipt-1.txt`,
      newName: "2026-03-01-acme-41.txt",
    });
    expect(await provider.undo(renamed.undoToken!, signal)).toEqual({
      code: "ok",
      raw: "Put the file back where it was.",
      items: 1,
    });
    expect(existsSync(file(receipt(1)))).toBe(true);
    expect(existsSync(file(`${bench}/2026-03-01-acme-41.txt`))).toBe(false);
    expect(code(await provider.undo(renamed.undoToken!, signal))).toBe(
      "NOT_FOUND",
    );
    const moved = await call("move_file", {
      path: `${BENCH}/receipt-2.txt`,
      toFolder: `${BENCH}/Archive`,
    });
    expect((await provider.undo(moved.undoToken!, signal)).code).toBe("ok");
    expect(existsSync(file(receipt(2)))).toBe(true);
    expect(existsSync(file(`${bench}/Archive/receipt-2.txt`))).toBe(false);
    // Moved again since: left where it is.
    const again = await call("rename_file", {
      path: `${BENCH}/receipt-1.txt`,
      newName: "a.txt",
    });
    await call("rename_file", { path: `${BENCH}/a.txt`, newName: "b.txt" });
    expect(code(await provider.undo(again.undoToken!, signal))).toBe(
      "CHANGED_SINCE",
    );
    expect(existsSync(file(`${bench}/b.txt`))).toBe(true);
    // Its old place taken since: left where it is.
    const third = await call("rename_file", {
      path: `${BENCH}/receipt-2.txt`,
      newName: "c.txt",
    });
    writeFileSync(file(receipt(2)), "the user made a new one\n");
    expect(code(await provider.undo(third.undoToken!, signal))).toBe(
      "CHANGED_SINCE",
    );
    expect(text(receipt(2))).toBe("the user made a new one\n");
    expect(existsSync(file(`${bench}/c.txt`))).toBe(true);
    // The window closes on a move as on a write.
    const late = await call("rename_file", {
      path: `${BENCH}/c.txt`,
      newName: "d.txt",
    });
    now += TOOL_LIMITS.undoWindowMs;
    expect(code(await provider.undo(late.undoToken!, signal))).toBe(
      "NOT_FOUND",
    );
    expect(existsSync(file(`${bench}/d.txt`))).toBe(true);
  });
});

describe("undo", () => {
  const NOTES = "~/OpenAssistBench/benchnote0a1b/benchnote0a1b-notes.txt";
  const notes = "OpenAssistBench/benchnote0a1b/benchnote0a1b-notes.txt";
  it("puts a replaced file back, removes a created one, and takes an append off the end", async () => {
    const replaced = await call("replace_file_text", {
      path: NOTES,
      text: "new",
    });
    expect(await provider.undo(replaced.undoToken!, signal)).toEqual({
      code: "ok",
      raw: "Put the file back as it was.",
      items: 1,
    });
    expect(text(notes)).toBe("Research notes for benchnote0a1b\n");
    const created = await call("replace_file_text", {
      path: "~/OpenAssistBench/benchnote0a1b/new.txt",
      text: "x",
    });
    expect(await provider.undo(created.undoToken!, signal)).toEqual({
      code: "ok",
      raw: "Removed the file the write created.",
      items: 1,
    });
    expect(existsSync(file("OpenAssistBench/benchnote0a1b/new.txt"))).toBe(
      false,
    );
    const appended = await call("append_text_file", { path: NOTES, text: "L" });
    expect((await provider.undo(appended.undoToken!, signal)).code).toBe("ok");
    expect(text(notes)).toBe("Research notes for benchnote0a1b\n");
  });
  it("is single use, expires with the undo window, and leaves a file that changed since alone", async () => {
    const first = await call("replace_file_text", { path: NOTES, text: "one" });
    expect((await provider.undo(first.undoToken!, signal)).code).toBe("ok");
    expect(code(await provider.undo(first.undoToken!, signal))).toBe(
      "NOT_FOUND",
    );
    expect(code(await provider.undo("nope", signal))).toBe("NOT_FOUND");
    const second = await call("replace_file_text", {
      path: NOTES,
      text: "two",
    });
    now += TOOL_LIMITS.undoWindowMs;
    expect(code(await provider.undo(second.undoToken!, signal))).toBe(
      "NOT_FOUND",
    );
    expect(text(notes)).toBe("two");
    const third = await call("replace_file_text", {
      path: NOTES,
      text: "three",
    });
    writeFileSync(file(notes), "the user typed over it");
    expect(code(await provider.undo(third.undoToken!, signal))).toBe(
      "CHANGED_SINCE",
    );
    expect(text(notes)).toBe("the user typed over it");
  });
  it("keeps at most the last tokens and forgets them all on close", async () => {
    const tokens: string[] = [];
    for (let i = 0; i < FILE_LIMITS.undoTokens + 2; i++)
      tokens.push(
        (await call("append_text_file", { path: NOTES, text: `${i}` }))
          .undoToken!,
      );
    expect(code(await provider.undo(tokens[0], signal))).toBe("NOT_FOUND");
    expect(code(await provider.undo(tokens[1], signal))).toBe("NOT_FOUND");
    expect((await provider.undo(tokens.at(-1)!, signal)).code).toBe("ok");
    await provider.close();
    expect(code(await provider.undo(tokens.at(-2)!, signal))).toBe("NOT_FOUND");
  });
});
