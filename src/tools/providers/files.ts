import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve, sep } from "node:path";
import type { Settings } from "../../core/schema";
import { scanText } from "../../core/sanitize";
import {
  TOOL_LIMITS,
  type ProviderResult,
  type ProviderState,
  type ToolPrepared,
  type ToolQuestion,
  type ToolSpec,
  type ToolTier,
} from "../../core/tools";
import type { LocalProviderOptions, LocalServer } from "../local";
import type { McpProvider } from "../mcp";

/**
 * The files tool: six builtin tools over files inside the home folder, run
 * in the app's own process: four over a plain-text file's contents and a
 * folder's listing, and two that rename or move a file. It exists because
 * "write X into notes.txt and save" is a step a tool does in one call and an
 * editor in twenty (cycle 20260919-1646: 8 of 28 attempts found the fact and
 * then lost it between TextEdit's window, the header and Save). Tools first,
 * the screen as fallback (docs/TOOLS.md).
 *
 * rename_file and move_file came with cycle 20260919-2044 (autonomy all,
 * gpt-5.4-mini): files-rename-receipts #2 listed and read through the tool
 * (10 tool calls, 0 tool writes), found nothing here that renames, fell back
 * to Finder clicks and keys and back to the tool, and was ended STUCK_LOOP
 * at 25 actions with nothing renamed. A rename is one call per file: the new
 * name is a bare file name in the same folder, a move keeps the name and
 * needs the folder to exist, neither ever lands on an existing item, both
 * are verified by stat afterwards and undone by moving the file back.
 *
 * Paths follow open_file's rules (native/macos/FileSafety.swift
 * indexExcluded), applied to the path as written and again to its realpath:
 * "~/" or the home folder's own absolute prefix; never "..", a hidden
 * component, node_modules, .git, the Trash, a credential-like name, or
 * ~/Library except the iCloud Drive subtree; a write never touches an
 * executable, installer, script or location file by extension. Contents are
 * text only (no NUL byte, valid UTF-8); a read is at most 64 KB. A write is
 * read back before it is reported, and its previous contents are kept for
 * TOOL_LIMITS.undoWindowMs so ToolAccess.undoLast can put them back, unless
 * the file changed since. The text a user asked to write is theirs and is
 * not redacted, but a credential in it (scanText BLOCK_UPLOAD) is refused:
 * it would not be typed either.
 *
 * The one tool that erases is named for it: replace_file_text, never
 * "write". In probe cycle 20260919-1952 the note tasks said "write <fact>
 * into <path>", gpt-5.4-mini matched the verb to write_text_file, and the
 * header line the graders require went with the rest of the file (2 of the
 * 3 tool-route notes, NOTE_HEADER_LOST and FACT_NOT_NOTED); the one that
 * appended passed. So the destructive tool says what it does, and prepare
 * refuses to replace a file that holds text unless the user's own words ask
 * for it (would_erase: a fixed RETRY that names append_text_file, in every
 * mode; never a question).
 */
export const FILES_ID = "files";
export const FILES_TITLE = "Files";
export const FILE_LIMITS = {
  /** A read returns at most this many bytes; a larger file is refused, not cut. */
  readBytes: TOOL_LIMITS.rawResultBytes,
  /** A new file name (rename_file newName) is at most this long. */
  nameChars: 255,
  /** A file a write leaves behind is at most this large. */
  fileBytes: 1_048_576,
  /** Bytes of a file's head read to tell text from binary before an append. */
  headBytes: 8192,
  listEntries: 200,
  undoTokens: 20,
  pathChars: 1024,
} as const;

export type FileToolName =
  | "read_text_file"
  | "append_text_file"
  | "replace_file_text"
  | "list_directory"
  | "rename_file"
  | "move_file";
export interface FileTool {
  does: string;
  params: string;
  tier: ToolTier;
  undoable: boolean;
  keys: readonly string[];
  required: readonly string[];
}
export const FILE_TOOLS: Record<FileToolName, FileTool> = {
  read_text_file: {
    does: "Reads a plain-text file inside your home folder, up to 64 KB, and returns its text.",
    params: "path (text, a ~/ path)",
    tier: "read",
    undoable: false,
    keys: ["path"],
    required: ["path"],
  },
  append_text_file: {
    does: "Writes text at the end of a plain-text file in your home folder on its own line, keeping what is there: how to write, add, log or note a fact into a file. Creates it if absent; the write is the save.",
    params:
      "path (text, a ~/ path), text (text), newline? (boolean, default true)",
    tier: "additive",
    undoable: true,
    keys: ["path", "text", "newline"],
    required: ["path", "text"],
  },
  replace_file_text: {
    does: "Replaces everything a plain-text file in your home folder holds with the text, erasing what it held. Only when the objective says to replace, overwrite or clear the file; otherwise append_text_file.",

    params: "path (text, a ~/ path), text (text)",
    tier: "write",
    undoable: true,
    keys: ["path", "text"],
    required: ["path", "text"],
  },
  list_directory: {
    does: "Lists the visible files and folders inside a folder in your home folder: one name per line with its size, up to 200.",
    params: "path (text, a ~/ path)",
    tier: "read",
    undoable: false,
    keys: ["path"],
    required: ["path"],
  },
  rename_file: {
    does: "Renames a file in your home folder in place: newName is the bare new file name (no slash), kept in the same folder; never over an existing file. One call per file to rename.",
    params: "path (text, a ~/ path), newName (text, a file name with no slash)",
    tier: "write",
    undoable: true,
    keys: ["path", "newName"],
    required: ["path", "newName"],
  },
  move_file: {
    does: "Moves a file in your home folder into another folder there, keeping its name; the folder must already exist; never over an existing file. One call per file to move.",
    params: "path (text, a ~/ path), toFolder (text, a ~/ folder path)",
    tier: "write",
    undoable: true,
    keys: ["path", "toFolder"],
    required: ["path", "toFolder"],
  },
};
export const FILE_TOOL_NAMES = Object.keys(FILE_TOOLS) as FileToolName[];
export const FILE_TOOL_IDS = FILE_TOOL_NAMES.map((n) => `${FILES_ID}__${n}`);
/**
 * The two tools that change a file's contents, by id: what a grader or a
 * step namer counts as the note written. rename_file and move_file change
 * where a file is or what it is called, never what it holds, so they are not
 * here: a grader's rename check reads the folder, not the step.
 */
export const FILE_WRITE_TOOL_IDS = [
  `${FILES_ID}__append_text_file`,
  `${FILES_ID}__replace_file_text`,
];
/**
 * Whether the user's own words ask for a file's contents to go: replace,
 * overwrite, rewrite, clear, erase or start over, in any of their forms.
 * Without one, replace_file_text on a file that holds text is the
 * would_erase problem at prepare. Words that are not the user's (undefined)
 * ask for nothing.
 */
export const REPLACING_WORDS =
  /\b(?:replac(?:e|es|ed|ing)|overwrit(?:e|es|ing|ten)|rewrit(?:e|es|ing|ten)|clear(?:s|ed|ing)?|eras(?:e|es|ed|ing)|start(?:s|ed|ing)?\s+(?:over|afresh))\b/i;
export const asksToReplace = (words: string | undefined): boolean =>
  typeof words === "string" && REPLACING_WORDS.test(words);

// MARK: paths

export type PathProblem =
  "BAD_PATH" | "OUTSIDE_HOME" | "PROTECTED_PATH" | "EXECUTABLE";
export interface HomePath {
  /** The absolute path, joined from the home folder and the checked components. */
  absolute: string;
  /** "~/..." as the tool reports it and as grounding reads it. */
  relative: string;
  /** The last component. */
  name: string;
  components: string[];
}
const CONTROL = /[\u0000-\u001f\u007f]/;
const EXCLUDED_COMPONENTS = new Set(["node_modules", ".git", ".trash"]);
const ICLOUD_DRIVE = ["Library", "Mobile Documents", "com~apple~CloudDocs"];
/** Names that commonly hold keys, tokens, password exports or password databases (FileSafety.swift credentialLikeName). */
export function credentialLikeName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith(".env") || lower === ".netrc") return true;
  if (lower === "logins.csv" || lower === "wallet.dat") return true;
  for (const prefix of [
    "id_rsa",
    "id_ed25519",
    "id_ecdsa",
    "id_dsa",
    "bitwarden_export",
    "bitwarden_encrypted_export",
  ])
    if (lower.startsWith(prefix)) return true;
  for (const part of [
    "password",
    "passwd",
    "secret",
    ".keychain",
    "credentials",
  ])
    if (lower.includes(part)) return true;
  return CREDENTIAL_EXTENSIONS.has(extensionOf(lower));
}
const CREDENTIAL_EXTENSIONS = new Set([
  "pem",
  "key",
  "p8",
  "p12",
  "pfx",
  "pkcs12",
  "ppk",
  "jks",
  "keystore",
  "gpg",
  "pgp",
  "asc",
  "kdbx",
  "kdb",
  "1pif",
  "1pux",
  "psafe3",
  "keychain",
  "keychain-db",
  "ovpn",
]);
/** Extensions a write never creates or touches: opening one runs code, installs something or hands a URL to a handler (FileSafety.swift fileRefusedExtensions). */
const REFUSED_EXTENSIONS = new Set([
  "app",
  "appex",
  "framework",
  "bundle",
  "plugin",
  "kext",
  "prefpane",
  "qlgenerator",
  "mdimporter",
  "xpc",
  "saver",
  "systemextension",
  "dext",
  "driver",
  "osax",
  "service",
  "wdgt",
  "sh",
  "command",
  "tool",
  "zsh",
  "bash",
  "csh",
  "tcsh",
  "ksh",
  "fish",
  "py",
  "pyc",
  "pyw",
  "rb",
  "pl",
  "pm",
  "php",
  "js",
  "mjs",
  "cjs",
  "jxa",
  "lua",
  "tcl",
  "ps1",
  "bat",
  "cmd",
  "vbs",
  "jar",
  "exe",
  "msi",
  "com",
  "pkg",
  "mpkg",
  "dmg",
  "iso",
  "img",
  "sparseimage",
  "sparsebundle",
  "toast",
  "cdr",
  "workflow",
  "wflow",
  "scpt",
  "scptd",
  "applescript",
  "shortcut",
  "terminal",
  "term",
  "action",
  "nib",
  "help",
  "trace",
  "tracetemplate",
  "x11app",
  "inputplugin",
  "ibplugin",
  "menu",
  "cin",
  "gcx",
  "icp",
  "ipg",
  "webarchive",
  "class",
  "jnlp",
  "qtz",
  "fileloc",
  "inetloc",
  "webloc",
  "url",
  "afploc",
  "ftploc",
  "mailloc",
  "newsloc",
  "vncloc",
  "atloc",
  "nslloc",
  "mobileconfig",
  "configprofile",
  "provisionprofile",
  "safariextz",
  "crx",
  "xpi",
  "photoslibrary",
  "musiclibrary",
  "tvlibrary",
  "plist",
]);
const extensionOf = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1) : "";
};
/** Whether a write may not touch a file of this name, by its extension. */
export function refusedExtension(name: string): boolean {
  return REFUSED_EXTENSIONS.has(extensionOf(name.toLowerCase()));
}
const normalizedHome = (home: string) => home.replace(/\/+$/, "");
export type NameProblem = "BAD_NAME" | "PROTECTED_PATH" | "EXECUTABLE";
/**
 * A bare file name a rename may give, or the problem with it: one component
 * (no slash), not empty, ".", ".." or over FILE_LIMITS.nameChars, no control
 * character (BAD_NAME); not hidden, a component the path rules exclude or a
 * credential-like name (PROTECTED_PATH); not a kind a write never touches
 * (EXECUTABLE). Pure, like homePath.
 */
export function fileName(
  name: unknown,
): { name: string } | { problem: NameProblem } {
  if (
    typeof name !== "string" ||
    !name.trim() ||
    name.length > FILE_LIMITS.nameChars ||
    CONTROL.test(name) ||
    name.includes("/") ||
    name === "." ||
    name === ".."
  )
    return { problem: "BAD_NAME" };
  if (
    name.startsWith(".") ||
    EXCLUDED_COMPONENTS.has(name.toLowerCase()) ||
    credentialLikeName(name)
  )
    return { problem: "PROTECTED_PATH" };
  if (refusedExtension(name)) return { problem: "EXECUTABLE" };
  return { name };
}
/**
 * The path as the tool may touch it, or the problem with it. Pure: the
 * filesystem is not consulted here; call time applies the same rules to the
 * realpath, so a symlink inside the home folder cannot lead out of it.
 */
export function homePath(
  path: unknown,
  home: string,
): HomePath | { problem: PathProblem } {
  if (typeof path !== "string") return { problem: "BAD_PATH" };
  if (!path || path.length > FILE_LIMITS.pathChars || CONTROL.test(path))
    return { problem: "BAD_PATH" };
  const base = normalizedHome(home);
  if (!base || base === "/" || !base.startsWith("/"))
    return { problem: "OUTSIDE_HOME" };
  let rest: string;
  if (path === "~" || path.startsWith("~/")) rest = path.slice(2);
  else if (path === base || path.startsWith(base + "/"))
    rest = path.slice(base.length + 1);
  else return { problem: path.startsWith("/") ? "OUTSIDE_HOME" : "BAD_PATH" };
  rest = rest.replace(/\/+$/, "");
  // The home folder itself is never read, listed or written.
  if (!rest) return { problem: "PROTECTED_PATH" };
  const components = rest.split("/");
  for (const component of components) {
    if (!component || component === "." || component === "..")
      return { problem: "BAD_PATH" };
    if (component.startsWith(".")) return { problem: "PROTECTED_PATH" };
    if (EXCLUDED_COMPONENTS.has(component.toLowerCase()))
      return { problem: "PROTECTED_PATH" };
    if (credentialLikeName(component)) return { problem: "PROTECTED_PATH" };
  }
  if (components[0] === "Library") {
    const inside =
      components.length > ICLOUD_DRIVE.length &&
      ICLOUD_DRIVE.every((part, i) => components[i] === part);
    if (!inside) return { problem: "PROTECTED_PATH" };
  }
  const absolute = resolve(base, ...components);
  if (!absolute.startsWith(base + sep)) return { problem: "OUTSIDE_HOME" };
  return {
    absolute,
    relative: `~/${components.join("/")}`,
    name: components[components.length - 1],
    components,
  };
}
const isProblem = (
  value: HomePath | { problem: PathProblem },
): value is { problem: PathProblem } => "problem" in value;

// MARK: text

const decoder = new TextDecoder("utf-8", { fatal: true });
/** The bytes as text, or undefined for anything with a NUL byte or invalid UTF-8. */
export function textOf(bytes: Buffer): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return decoder.decode(bytes);
  } catch {
    return undefined;
  }
}
/** `bytes` bytes of a file from `position`, without reading the rest. */
function sliceOf(path: string, position: number, bytes: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, position);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}
const hasCredential = (text: string) =>
  scanText(text).some((f) => f.action === "BLOCK_UPLOAD");
/** Lines of text with something on them; at least one for any text. */
const lineCount = (text: string) =>
  Math.max(1, text.split("\n").filter((line) => line.trim()).length);

// MARK: the provider

export function fileToolSpec(name: FileToolName): ToolSpec {
  const tool = FILE_TOOLS[name];
  return {
    id: `${FILES_ID}__${name}`,
    provider: FILES_ID,
    name,
    title: FILES_TITLE,
    does: tool.does,
    params: tool.params,
    tier: tool.tier,
    trusted: true,
    local: true,
    openWorld: false,
    undoable: tool.undoable,
    longRunning: false,
    transport: "builtin",
    timeoutMs: TOOL_LIMITS.callTimeoutMs,
    dateKeys: [],
    trace: { tool: name, server: FILES_ID },
  };
}
const isToolName = (name: string): name is FileToolName => name in FILE_TOOLS;
interface Checked {
  name: FileToolName;
  path: HomePath;
  text: string;
  newline: boolean;
  /** rename_file: the bare new name, checked by fileName. */
  newName?: string;
  /** move_file: the folder the file goes into, under the path rules. */
  toFolder?: HomePath;
}
export interface ArgsProblem {
  problem: "invalid_args" | "bad_path";
  /**
   * The refusal code call() answers with when it is finer than the problem:
   * a new name or a folder the rules refuse (BAD_NAME, OUTSIDE_HOME,
   * PROTECTED_PATH, EXECUTABLE). The path itself keeps BAD_PATH, as before.
   */
  code?: NameProblem | PathProblem;
}
/**
 * The arguments checked against the tool's own keys and the path rules;
 * a problem is the registry's ToolProblem, so policy retries with the fixed
 * sentence and no question is asked about a path the call would refuse.
 */
export function checkArgs(
  name: string,
  args: Record<string, unknown>,
  home: string,
): Checked | ArgsProblem {
  if (!isToolName(name)) return { problem: "invalid_args" };
  const tool = FILE_TOOLS[name];
  if (Object.keys(args).some((key) => !tool.keys.includes(key)))
    return { problem: "invalid_args" };
  if (tool.required.some((key) => typeof args[key] !== "string"))
    return { problem: "invalid_args" };
  if (args.newline !== undefined && typeof args.newline !== "boolean")
    return { problem: "invalid_args" };
  if (args.text !== undefined && typeof args.text !== "string")
    return { problem: "invalid_args" };
  const path = homePath(args.path, home);
  if (isProblem(path)) return { problem: "bad_path" };
  const writes = tool.tier !== "read";
  if (writes && refusedExtension(path.name)) return { problem: "bad_path" };
  const checked: Checked = {
    name,
    path,
    text: typeof args.text === "string" ? args.text : "",
    newline: args.newline !== false,
  };
  if (name === "rename_file") {
    const named = fileName(args.newName);
    if ("problem" in named)
      return named.problem === "BAD_NAME"
        ? { problem: "invalid_args", code: "BAD_NAME" }
        : { problem: "bad_path", code: named.problem };
    checked.newName = named.name;
  }
  if (name === "move_file") {
    const folder = homePath(args.toFolder, home);
    if (isProblem(folder)) return { problem: "bad_path", code: folder.problem };
    // A folder of a bundle kind (x.app) is a bundle: nothing is moved into it.
    if (refusedExtension(folder.name))
      return { problem: "bad_path", code: "EXECUTABLE" };
    checked.toFolder = folder;
  }
  return checked;
}
function questionOf(checked: Checked): ToolQuestion {
  const name = checked.path.name;
  switch (checked.name) {
    case "read_text_file":
      return { kind: "file_read", name };
    case "list_directory":
      return { kind: "file_list", name };
    case "append_text_file":
      return { kind: "file_append", name, text: checked.text };
    case "replace_file_text":
      return { kind: "file_write", name, text: checked.text };
    case "rename_file":
      return { kind: "file_rename", name, newName: checked.newName ?? "" };
    case "move_file":
      return { kind: "file_move", name, folder: checked.toFolder?.name ?? "" };
  }
}
const refuse = (code: string, sentence: string): ProviderResult => ({
  code: "error",
  raw: `${code}: ${sentence}`,
  items: 0,
});
const PATH_SENTENCES: Record<PathProblem, string> = {
  BAD_PATH: "The path must be a ~/ path with no . or .. segments.",
  OUTSIDE_HOME: "Only files inside your home folder can be touched.",
  PROTECTED_PATH:
    "That path is under ~/Library, hidden, or named like a credential; it stays manual.",
  EXECUTABLE: "That file's kind is never written here.",
};
const NAME_SENTENCES: Record<NameProblem, string> = {
  BAD_NAME:
    "The new name must be a bare file name: no slash, not empty, not . or ..",
  PROTECTED_PATH: PATH_SENTENCES.PROTECTED_PATH,
  EXECUTABLE: PATH_SENTENCES.EXECUTABLE,
};
/** What a refused checkArgs answers at call(): the finer code when there is one. */
const argsRefusal = (problem: ArgsProblem): ProviderResult => {
  if (problem.code === "BAD_NAME")
    return refuse("BAD_NAME", NAME_SENTENCES.BAD_NAME);
  if (problem.code) return refuse(problem.code, PATH_SENTENCES[problem.code]);
  return problem.problem === "bad_path"
    ? refuse("BAD_PATH", PATH_SENTENCES.BAD_PATH)
    : refuse("BAD_ARGS", "The arguments do not match the tool's parameters.");
};
/**
 * What an undo puts back: a write's previous bytes (or the file's absence),
 * or a renamed or moved file's old place.
 */
type Undo = { token: string; expiresAt: number } & (
  | {
      kind: "write";
      path: string;
      /** The bytes before the write; undefined when the file did not exist. */
      before?: Buffer;
      /** The bytes the write left, so a file changed since is left alone. */
      after: Buffer;
    }
  | {
      kind: "move";
      /** Where the rename or move put the file. */
      from: string;
      /** Where it was. */
      to: string;
    }
);

export function createFilesProvider(o: LocalProviderOptions): McpProvider {
  const now = o.now ?? Date.now;
  const home = normalizedHome(o.home);
  let state: ProviderState = "off";
  const undos: Undo[] = [];
  const specs = FILE_TOOL_NAMES.map(fileToolSpec);
  const on = () => state === "on";

  /**
   * The realpath of what exists on the way to the path (the file, else its
   * folder), held to the same rules as the path as written, so a symlink can
   * never lead out of the home folder or into what the rules exclude. Also
   * says whether the file itself exists and what it is.
   */
  const resolveReal = (
    path: HomePath,
  ):
    | { real: string; exists: boolean; kind: "file" | "folder" | "other" }
    | ProviderResult => {
    let stat;
    try {
      stat = lstatSync(path.absolute);
    } catch {
      stat = undefined;
    }
    const existing = stat ? path.absolute : dirname(path.absolute);
    let real: string;
    try {
      real = realpathSync(existing);
    } catch {
      return refuse("NOT_FOUND", "That folder does not exist.");
    }
    const checked = homePath(real, home);
    if (isProblem(checked))
      return refuse(checked.problem, PATH_SENTENCES[checked.problem]);
    if (!stat) {
      let parent;
      try {
        parent = statSync(real);
      } catch {
        return refuse("NOT_FOUND", "That folder does not exist.");
      }
      if (!parent.isDirectory())
        return refuse("NOT_FOUND", "The path's folder is not a folder.");
      return { real: resolve(real, path.name), exists: false, kind: "file" };
    }
    let target;
    try {
      target = statSync(real);
    } catch {
      return refuse("NOT_FOUND", "That file does not exist.");
    }
    return {
      real,
      exists: true,
      kind: target.isFile()
        ? "file"
        : target.isDirectory()
          ? "folder"
          : "other",
    };
  };
  const isResult = (value: unknown): value is ProviderResult =>
    !!value && typeof value === "object" && "code" in value;
  /** Whether anything at all is at the path: a file, a folder, a link (broken or not). */
  const exists = (path: string): boolean => {
    try {
      lstatSync(path);
      return true;
    } catch {
      return false;
    }
  };
  /**
   * Whether the path is a file with bytes in it: what replace_file_text
   * would erase. A missing file, an empty one, a folder or one that cannot
   * be read is not (call() answers for those); the symlink is followed, as
   * the write follows it.
   */
  const hasContent = (path: HomePath): boolean => {
    try {
      const stat = statSync(path.absolute);
      return stat.isFile() && stat.size > 0;
    } catch {
      return false;
    }
  };

  const read = (path: HomePath): ProviderResult => {
    const found = resolveReal(path);
    if (isResult(found)) return found;
    if (!found.exists) return refuse("NOT_FOUND", "That file does not exist.");
    if (found.kind !== "file")
      return refuse("NOT_A_FILE", "That path is a folder, not a file.");
    const size = statSync(found.real).size;
    if (size > FILE_LIMITS.readBytes)
      return refuse(
        "TOO_LARGE",
        `That file is ${size} bytes; reads stop at ${FILE_LIMITS.readBytes}.`,
      );
    const text = textOf(readFileSync(found.real));
    if (text === undefined)
      return refuse("NOT_TEXT", "That file is not plain text.");
    return { code: "ok", raw: text, items: 1 };
  };
  const list = (path: HomePath): ProviderResult => {
    const found = resolveReal(path);
    if (isResult(found)) return found;
    if (!found.exists)
      return refuse("NOT_FOUND", "That folder does not exist.");
    if (found.kind !== "folder")
      return refuse("NOT_A_FOLDER", "That path is a file, not a folder.");
    const entries = readdirSync(found.real, { withFileTypes: true })
      .filter(
        (entry) =>
          !entry.name.startsWith(".") &&
          !EXCLUDED_COMPONENTS.has(entry.name.toLowerCase()) &&
          !credentialLikeName(entry.name),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    const shown = entries.slice(0, FILE_LIMITS.listEntries).map((entry) => {
      if (entry.isDirectory()) return `${entry.name}/`;
      if (!entry.isFile()) return entry.name;
      try {
        return `${entry.name} (${statSync(resolve(found.real, entry.name)).size} bytes)`;
      } catch {
        return entry.name;
      }
    });
    const more = entries.length - shown.length;
    const lines = [...shown, ...(more > 0 ? [`… and ${more} more`] : [])];
    return {
      code: "ok",
      raw: lines.length ? lines.join("\n") : "(empty folder)",
      items: shown.length,
    };
  };
  const remember = (undo: Undo) => {
    const at = now();
    for (let i = undos.length - 1; i >= 0; i--)
      if (undos[i].expiresAt <= at) undos.splice(i, 1);
    undos.push(undo);
    while (undos.length > FILE_LIMITS.undoTokens) undos.shift();
  };
  const write = (
    checked: Checked,
    mode: "append" | "replace",
  ): ProviderResult => {
    if (hasCredential(checked.text))
      return refuse(
        "CREDENTIAL",
        "Detected credentials are not written to a file.",
      );
    const found = resolveReal(checked.path);
    if (isResult(found)) return found;
    if (found.exists && found.kind !== "file")
      return refuse("NOT_A_FILE", "That path is a folder, not a file.");
    // The realpath's own name decides the kind: a symlink named notes.txt
    // that points at a script is the script.
    if (refusedExtension(found.real.split("/").pop() ?? ""))
      return refuse("EXECUTABLE", PATH_SENTENCES.EXECUTABLE);
    let before: Buffer | undefined;
    let size = 0;
    let endsWithNewline = false;
    if (found.exists) {
      size = statSync(found.real).size;
      const head = sliceOf(found.real, 0, FILE_LIMITS.headBytes);
      if (
        head.includes(0) ||
        (size <= FILE_LIMITS.headBytes && textOf(head) === undefined)
      )
        return refuse("NOT_TEXT", "That file is not plain text.");
      endsWithNewline =
        size > 0 && sliceOf(found.real, size - 1, 1)[0] === 0x0a;
      // What undo puts back; a file too large to hold is changed without one.
      before =
        size <= FILE_LIMITS.fileBytes ? readFileSync(found.real) : undefined;
    }
    let bytes: Buffer;
    if (mode === "replace") bytes = Buffer.from(checked.text, "utf8");
    else {
      // On its own line: a newline first when the file's last line is open,
      // and one after unless the text brought its own. newline:false appends
      // the bytes as given.
      const lead = checked.newline && size > 0 && !endsWithNewline ? "\n" : "";
      const tail = checked.newline && !checked.text.endsWith("\n") ? "\n" : "";
      bytes = Buffer.from(`${lead}${checked.text}${tail}`, "utf8");
    }
    const finalSize = mode === "replace" ? bytes.length : size + bytes.length;
    if (finalSize > FILE_LIMITS.fileBytes)
      return refuse(
        "TOO_LARGE",
        `The file would be ${finalSize} bytes; writes stop at ${FILE_LIMITS.fileBytes}.`,
      );
    try {
      if (mode === "replace") writeFileSync(found.real, bytes);
      else appendFileSync(found.real, bytes);
    } catch (error) {
      return refuse(
        "WRITE_FAILED",
        error instanceof Error && "code" in error
          ? `The write failed (${String((error as { code?: unknown }).code)}).`
          : "The write failed.",
      );
    }
    // Read back: what the file now holds ends with (append) or is (replace)
    // what was written; only then is the write reported as verified.
    const after = readFileSync(found.real);
    const verified =
      mode === "replace"
        ? after.equals(bytes)
        : after.length >= bytes.length &&
          after.subarray(after.length - bytes.length).equals(bytes);
    if (!verified)
      return refuse(
        "READBACK_MISMATCH",
        "The file did not read back as written; check it on screen.",
      );
    // A write undo can put back: the file did not exist, or its previous
    // contents were small enough to keep. A larger file changes without one.
    const undoable = !found.exists || before !== undefined;
    const token = randomUUID();
    if (undoable)
      remember({
        token,
        kind: "write",
        path: found.real,
        before,
        after,
        expiresAt: now() + TOOL_LIMITS.undoWindowMs,
      });
    const change: "appended" | "created" | "replaced" = !found.exists
      ? "created"
      : mode === "append"
        ? "appended"
        : "replaced";
    const lines = lineCount(checked.text);
    const total = lineCount(textOf(after) ?? "");
    const said =
      change === "created"
        ? `Created ${checked.path.relative} with ${lines} line${lines === 1 ? "" : "s"} (${after.length} bytes).`
        : change === "appended"
          ? `Added ${lines} line${lines === 1 ? "" : "s"} to ${checked.path.relative}; it now holds ${total} line${total === 1 ? "" : "s"} (${after.length} bytes).`
          : `Replaced the contents of ${checked.path.relative} with ${lines} line${lines === 1 ? "" : "s"} (${after.length} bytes).`;
    return {
      code: "ok",
      raw: said,
      items: 1,
      verified: true,
      facts: { kind: "file", name: checked.path.name, change, lines },
      ...(undoable ? { undoToken: token } : {}),
    };
  };

  /**
   * The file a rename or move acts on, by its realpath: a regular file the
   * rules allow, never a link (renaming a link's target behind its name, or
   * the link itself away from what it points at, is nobody's intent; it
   * stays manual) and never an executable kind by its real name.
   */
  const source = (
    path: HomePath,
  ): { real: string; name: string } | ProviderResult => {
    let stat;
    try {
      stat = lstatSync(path.absolute);
    } catch {
      return refuse("NOT_FOUND", "That file does not exist.");
    }
    if (stat.isSymbolicLink())
      return refuse(
        "NOT_A_FILE",
        "That path is a link, not a file; it stays manual.",
      );
    const found = resolveReal(path);
    if (isResult(found)) return found;
    if (!found.exists) return refuse("NOT_FOUND", "That file does not exist.");
    if (found.kind !== "file")
      return refuse("NOT_A_FILE", "That path is a folder, not a file.");
    const name = found.real.split("/").pop() ?? "";
    if (refusedExtension(name))
      return refuse("EXECUTABLE", PATH_SENTENCES.EXECUTABLE);
    return { real: found.real, name };
  };
  /**
   * Puts the file at `to`: never over anything that exists there (a case-only
   * change of name reads as taken on a case-insensitive volume), verified by
   * stat afterwards (at its new place, gone from the old), and remembered so
   * undo can move it back within the window.
   */
  const relocate = (
    from: { real: string; name: string },
    to: string,
    change: "renamed" | "moved",
    said: string,
    facts: { from?: string; folder?: string },
  ): ProviderResult => {
    if (exists(to))
      return refuse(
        "EXISTS",
        "Something is already at that name; nothing was replaced.",
      );
    try {
      renameSync(from.real, to);
    } catch (error) {
      return refuse(
        "MOVE_FAILED",
        error instanceof Error && "code" in error
          ? `The file could not be moved (${String((error as { code?: unknown }).code)}).`
          : "The file could not be moved.",
      );
    }
    let landed = false;
    try {
      landed = statSync(to).isFile();
    } catch {
      landed = false;
    }
    if (!landed || exists(from.real))
      return refuse(
        "MOVE_FAILED",
        "The file did not end up where it was sent; check it on screen.",
      );
    const token = randomUUID();
    remember({
      token,
      kind: "move",
      from: to,
      to: from.real,
      expiresAt: now() + TOOL_LIMITS.undoWindowMs,
    });
    return {
      code: "ok",
      raw: said,
      items: 1,
      verified: true,
      facts: {
        kind: "file",
        name: to.split("/").pop() ?? from.name,
        change,
        ...facts,
      },
      undoToken: token,
    };
  };
  const rename = (checked: Checked): ProviderResult => {
    const from = source(checked.path);
    if (isResult(from)) return from;
    const newName = checked.newName ?? "";
    return relocate(
      from,
      resolve(dirname(from.real), newName),
      "renamed",
      `Renamed ${checked.path.relative} to ${newName}.`,
      { from: from.name },
    );
  };
  const move = (checked: Checked): ProviderResult => {
    const from = source(checked.path);
    if (isResult(from)) return from;
    const target = checked.toFolder!;
    const folder = resolveReal(target);
    if (isResult(folder)) return folder;
    if (!folder.exists)
      return refuse("NOT_FOUND", "That folder does not exist.");
    if (folder.kind !== "folder")
      return refuse("NOT_A_FOLDER", "That path is a file, not a folder.");
    const to = resolve(folder.real, from.name);
    if (to === from.real)
      return refuse("EXISTS", "The file is already in that folder.");
    return relocate(
      from,
      to,
      "moved",
      `Moved ${checked.path.relative} to ${target.relative}/.`,
      { folder: target.name },
    );
  };

  return {
    id: FILES_ID,
    transport: "builtin",
    title: FILES_TITLE,
    async start() {
      state = "on";
    },
    async retry() {
      state = "on";
    },
    state: () => ({ state, toolCount: on() ? specs.length : 0, restarts: 0 }),
    stderrBytes: () => 0,
    pinOf: () => undefined,
    catalog: () => [],
    async tools() {
      return on() ? specs : [];
    },
    prepare(spec, args, words): ToolPrepared {
      if (!on()) return { ok: false, problem: "unavailable" };
      const checked = checkArgs(spec.name, args, home);
      if ("problem" in checked) return { ok: false, problem: checked.problem };
      // The content-keeping rule: a whole-file replace of a file that holds
      // text needs the user's own words to say replace, overwrite, rewrite,
      // clear, erase or start over; otherwise the fixed RETRY sends the model
      // to append_text_file. An empty or absent file may be written. This is
      // a retry, not a question, so it holds under "all" as in every mode.
      if (
        checked.name === "replace_file_text" &&
        !asksToReplace(words?.userWords) &&
        hasContent(checked.path)
      )
        return { ok: false, problem: "would_erase" };
      // The path alone grounds the call, in its ~/ form whatever way the
      // model wrote it: the text is the file's content, which the words
      // cannot be expected to carry (it was read off a page), and the tool
      // is closed-world, so nothing in it leaves the Mac. A new name is
      // content too (read off the file, as the receipts' dates were); a
      // move's folder is a place the words can name, so it grounds with the
      // file.
      return {
        ok: true,
        question: questionOf(checked),
        groundText: [
          checked.path.relative,
          ...(checked.toFolder ? [checked.toFolder.relative] : []),
        ],
        argsBytes: Buffer.byteLength(JSON.stringify(args)),
      };
    },
    async call(spec, args) {
      if (!on()) return { code: "unavailable", raw: "", items: 0 };
      const checked = checkArgs(spec.name, args, home);
      if ("problem" in checked) return argsRefusal(checked);
      try {
        switch (checked.name) {
          case "read_text_file":
            return read(checked.path);
          case "list_directory":
            return list(checked.path);
          case "append_text_file":
            return write(checked, "append");
          case "replace_file_text":
            return write(checked, "replace");
          case "rename_file":
            return rename(checked);
          case "move_file":
            return move(checked);
        }
      } catch (error) {
        return refuse(
          "FAILED",
          error instanceof Error && "code" in error
            ? `The call failed (${String((error as { code?: unknown }).code)}).`
            : "The call failed.",
        );
      }
    },
    async undo(token) {
      const at = now();
      const index = undos.findIndex((u) => u.token === token);
      const undo = index >= 0 ? undos[index] : undefined;
      if (undo) undos.splice(index, 1);
      if (!undo || undo.expiresAt <= at)
        return refuse(
          "NOT_FOUND",
          "There is no write of this session to take back.",
        );
      if (undo.kind === "move") {
        // Back to where it was, unless it moved again or something else has
        // taken its old place since.
        if (!exists(undo.from) || exists(undo.to))
          return refuse(
            "CHANGED_SINCE",
            "The file moved again since, or something is at its old place; it is left as it is.",
          );
        try {
          renameSync(undo.from, undo.to);
        } catch {
          return refuse("FAILED", "The file could not be put back.");
        }
        return { code: "ok", raw: "Put the file back where it was.", items: 1 };
      }
      try {
        const current = readFileSync(undo.path);
        if (!current.equals(undo.after))
          return refuse(
            "CHANGED_SINCE",
            "The file changed since the write; it is left as it is.",
          );
        if (undo.before === undefined) unlinkSync(undo.path);
        else writeFileSync(undo.path, undo.before);
      } catch {
        return refuse("FAILED", "The file could not be put back.");
      }
      return {
        code: "ok",
        raw:
          undo.before === undefined
            ? "Removed the file the write created."
            : "Put the file back as it was.",
        items: 1,
      };
    },
    async close() {
      state = "off";
      undos.length = 0;
    },
  };
}

/** The files tool as the registry composes it (src/tools/providers/index.ts LOCAL_SERVERS). */
export const FILES: LocalServer = {
  id: FILES_ID,
  title: FILES_TITLE,
  enabled: (settings: Settings) => settings.tools.files,
  create: createFilesProvider,
};
