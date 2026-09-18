/**
 * Coding editors and terminals: the pure rules the policy uses for VS Code and
 * its forks, whose command palette, quick-open box and integrated terminal can
 * run anything, and for the terminal applications that are protected outright.
 *
 * Mirrored natively: the family, palette-title and terminal-focus rules in
 * native/macos/IdeSafety.swift and native/macos/NamedTargets.swift, and the
 * terminal applications in native/macos/LaunchSafety.swift. The shared
 * verdicts live in tests/fixtures/ide-agents.json; change both sides together.
 */

export type IdeFamily = "vscode" | "cursor" | "windsurf";

// Lowercased bundle id prefixes: VS Code (and Insiders, whose id extends it),
// VSCodium, Cursor and Windsurf. The same apps as
// screenReaderDetectingAppPrefixes in native/macos/InputSafety.swift, which
// keeps their accessibility tree hidden.
const ideBundlePrefixes: readonly (readonly [string, IdeFamily])[] = [
  ["com.microsoft.vscode", "vscode"],
  ["com.vscodium", "vscode"],
  ["com.todesktop.230313mzl4w4u92", "cursor"],
  ["com.exafunction.windsurf", "windsurf"],
];

/** The editor family of a bundle id, or undefined for anything else. */
export function ideFamily(appId?: string): IdeFamily | undefined {
  const id = (appId ?? "").trim().toLowerCase();
  if (!id) return undefined;
  return ideBundlePrefixes.find(([prefix]) => id.startsWith(prefix))?.[1];
}

/**
 * Terminal applications, lowercased. Every character and every ENTER sent to
 * one runs as a shell command, so they are part of the protected floor that
 * settings cannot remove (floorProtectedApps in policy.ts) and are never
 * launched (launchFloorDenied in LaunchSafety.swift).
 */
export const terminalAppIds: readonly string[] = [
  "com.apple.terminal",
  "com.googlecode.iterm2",
  "dev.warp.warp",
  "dev.warp.warp-stable",
  "dev.warp.warp-preview",
  "com.mitchellh.ghostty",
  "net.kovidgoyal.kitty",
  "org.alacritty",
  "io.alacritty",
  "co.zeit.hyper",
  "com.github.wez.wezterm",
];
// Warp ships each channel under its own id (Warp-Stable, Warp-Preview, …).
export const terminalAppPrefixes: readonly string[] = ["dev.warp.warp-"];
// Password managers hold every credential the user has. Whatever the settings
// say, the agent never sees, clicks or launches them; the same list is on the
// native launch floor (LaunchSafety.swift) and in tests/fixtures/ide-agents.json.
export const credentialAppPrefixes: readonly string[] = [
  "com.1password.",
  "com.agilebits.onepassword",
  "com.apple.passwords",
  "com.bitwarden.",
  "com.lastpass.",
  "com.dashlane.",
  "org.keepassxc.",
  "com.nordpass.",
  "in.sinew.enpass",
  "me.proton.pass",
  "com.keepersecurity.",
];

export function isTerminalApp(appId?: string): boolean {
  const id = (appId ?? "").trim().toLowerCase();
  return (
    !!id &&
    (terminalAppIds.includes(id) ||
      terminalAppPrefixes.some((prefix) => id.startsWith(prefix)))
  );
}

/** A menu title as matched: lowercase, collapsed spaces, no trailing ellipsis. */
function titleWords(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/(?:…|\.{3})+$/, "")
    .trim();
}

/**
 * Whether a search-opening command is a command palette: ENTER there runs
 * whichever command is selected, not a search. Same rule as
 * paletteCommandTitle in native/macos/NamedTargets.swift.
 */
export function paletteTitle(title?: string): boolean {
  return /\b(?:command palette|show all commands)\b/.test(
    titleWords(title ?? ""),
  );
}

/**
 * In VS Code and its forks every "Go to File", "Go to Symbol" and Quick Open
 * box is the palette's own input with a different prefix. Only the plain find
 * and search boxes are not.
 */
export function quickOpenTitle(title?: string): boolean {
  const words = titleWords(title ?? "");
  return !!words && !/^(?:find|search|filter|replace)\b/.test(words);
}

/**
 * Whether text typed into a VS Code-family quick-open box makes it run
 * something: ">" turns it into the command palette, and "task ", "debug ",
 * "term ", "ext " and "view " list tasks, launch configurations, terminals,
 * extensions and views that ENTER then runs or opens. A plain name (a file or
 * a symbol, "@", "#" or ":" navigation) only opens that item.
 */
export function quickOpenRunsCommand(query: string): boolean {
  return /^\s*(?:[>?]|(?:task|debug|term|ext|view|edt|chat)\s)/i.test(query);
}

/**
 * Commands that focus or open a coding agent's own input, exactly as their
 * palette titles read (normalized as paletteClass does). Claude Code's come
 * from its extension bundle and work in all three editors; the Chat ones are
 * VS Code's own titles for the Copilot Chat view and are unverified on device.
 * Cursor's and Windsurf's own agents have no verified title yet, so their
 * palette commands need approval like any other.
 */
export const agentFocusCommands: readonly string[] = [
  "claude code: focus input",
  "claude code: open in side bar",
  "claude code: open in new tab",
  "claude code: new conversation",
  "chat: focus on chat view",
  "chat: open chat",
];

// Anything that opens, focuses or feeds a terminal, a shell, a REPL or a
// console, or runs a task, a build, a test, a file or the debugger, or shows
// the panel that holds the terminal. VS Code's palette matches loosely, so a
// word anywhere in the query is enough; "term " and "ext " are quick-open
// prefixes, and installing an extension runs its code.
const refusedPaletteWords =
  /\b(?:terminals?|shell|bash|zsh|console|repl|tasks?|debug(?:ger|ging)?|run|rerun|execute|exec|build|launch|install|panel)\b|^(?:term|ext)\b|^developer:/;
// VS Code also matches each typed word against the start of a command's
// words, so "new term" or "tog ter" selects a terminal command. A typed word of
// three letters or more that begins one of these words, or that starts with
// its stem, is refused too. Other fuzzy matches cannot all be listed, which
// is why every other palette command needs approval.
const refusedWordStems: readonly (readonly [string, string])[] = [
  ["term", "terminal"],
  ["consol", "console"],
  ["debug", "debug"],
  ["task", "task"],
  ["shell", "shell"],
  ["panel", "panel"],
  ["build", "build"],
  ["exec", "execute"],
  ["launch", "launch"],
  ["install", "install"],
  ["run", "run"],
];
function refusedPaletteWord(word: string): boolean {
  return (
    word.length >= 3 &&
    refusedWordStems.some(
      ([stem, full]) => word.startsWith(stem) || full.startsWith(word),
    )
  );
}

/** A palette query as matched: lowercase words without the ">" prefix. */
function paletteWords(query: string): string {
  return titleWords(query.replace(/[‘’]/g, "'").replace(/[“”]/g, '"'))
    .replace(/^[>\s]+/, "")
    .replace(/\.+$/, "")
    .trim();
}

/**
 * What ENTER in a command palette would run, from the query typed into it:
 * "refused" for terminal, task, run, build and debug commands, "agent_focus"
 * for exactly one of agentFocusCommands, and "other" for everything else,
 * including an empty query (ENTER then runs the most recently used command).
 */
export function paletteClass(
  query: string,
): "agent_focus" | "refused" | "other" {
  const words = paletteWords(query);
  if (
    refusedPaletteWords.test(words) ||
    words.split(/[^\p{L}\p{N}]+/u).some(refusedPaletteWord)
  )
    return "refused";
  return agentFocusCommands.includes(words) ? "agent_focus" : "other";
}

/**
 * Menu items and menu-published shortcuts that open or focus a terminal or
 * the panel that holds it, or run a task, a build or the debugger: everything
 * under the Terminal and Run menus, "View > Terminal", "Toggle Panel".
 */
export function ideCommandTitleRefused(title: string): boolean {
  return /\b(?:terminals?|tasks?|debug(?:ging)?|run|build|panel)\b/.test(
    titleWords(title),
  );
}

export function ideMenuRefused(path: readonly string[]): boolean {
  const first = titleWords(path[0] ?? "");
  return (
    first === "terminal" ||
    first === "run" ||
    path.some((part) => ideCommandTitleRefused(part))
  );
}

/**
 * "Undo", "Undo All Edits", "Reject", "Discard Changes": a coding agent's work
 * thrown away. The whole label of a control, as normalizeControlLabel leaves
 * it, so a file named undo.ts or a link about undoing a commit is not one.
 */
export function ideDiscardLabel(label: string): boolean {
  return /^(?:undo|reject|discard)(?: (?:all|last|proposed))?(?: (?:edits?|changes?|files?))?$/.test(
    titleWords(label),
  );
}

/**
 * Whether an identified field in one of these editors may be its quick-open
 * box, which turns into the command palette with ">": a combo box (VS Code's
 * quick input), a search field, or a label the quick input or a search box
 * uses ("Type the name of a command to run.", "Search files by name…").
 */
export function ideQuickInputField(
  role?: string,
  subrole?: string,
  label?: string,
): boolean {
  return (
    role === "AXComboBox" ||
    subrole === "AXSearchField" ||
    /\b(?:search|find|filter|query|go to|commands?|narrow down|type the name)\b/i.test(
      label ?? "",
    )
  );
}
