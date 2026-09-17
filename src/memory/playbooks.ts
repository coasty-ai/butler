/**
 * App playbooks: a small, static table of reliable keyboard routes per
 * application, keyed by bundle id, with a fallback per app category.
 *
 * This file is data, not behavior. It executes nothing, adds no action type
 * and never contains user content: every line is a fixed, imperative hint that
 * the provider copies into the per-request `context.playbook` (see
 * docs/MEMORY.md). Live runs showed the model rediscovering basics on every
 * task — six `open_app Spotify` calls in a row on a surface that publishes no
 * accessibility tree, a profile-picker click before Chrome's CMD+L — and each
 * rediscovery costs a model call.
 *
 * A learned skill for the current task takes precedence: playbooks are hints
 * for first-time tasks, so `playbookLines` returns nothing when memory already
 * recalled a skill plan.
 *
 * Only keys the action schema can send appear here (see `supportedKeys` in
 * src/core/schema.ts): letters, digits, arrows, ENTER, TAB, ESC, SPACE,
 * PAGEUP/PAGEDOWN and the CMD/CTRL/ALT/SHIFT modifiers. No backtick, comma,
 * slash or plus shortcuts, because the model could not send them.
 */

/** A playbook never grows past this, whatever the table says. */
export const PLAYBOOK_MAX_LINES = 6;
/** Each line stays short enough to read at a glance and cheap to send. */
export const PLAYBOOK_MAX_CHARS = 120;

export type PlaybookCategory =
  | "browser"
  | "notes"
  | "mail"
  | "chat"
  | "music"
  | "files"
  | "settings"
  | "terminal"
  | "editor"
  | "viewer"
  | "generic";

const terminal = [
  "Not allowed: terminals are protected, so every click, key and character sent here is refused.",
  "Do not look for another way to a shell; you have no shell, filesystem or script tools.",
  "Say what needs running with request_user, or reach the goal through an ordinary app.",
];

/** Reliable routes per application, keyed by bundle id (lowercased at lookup). */
export const playbooks: Record<string, string[]> = {
  "com.google.chrome": [
    "Press CMD+L to focus the address bar, type the URL or search words, then press ENTER.",
    "Use CMD+T for a new tab, CMD+W to close one, CTRL+TAB to cycle tabs and CMD+1 to CMD+9 to jump.",
    "Search the page with CMD+F, type the words, press ENTER, then ESC to close the find bar.",
    "Read context.browserAddress before typing so you never resubmit the page you are already on.",
    "Chrome is already frontmost here: do not call open_app again, press CMD+L instead.",
    "A profile picker or first-run window blocks the page: choose once, then stay on the keyboard.",
  ],
  "com.apple.safari": [
    "Press CMD+L to focus the Smart Search field, type the URL or query, then press ENTER.",
    "Use CMD+T for a new tab, CMD+W to close one, CTRL+TAB to cycle tabs and CMD+1 to CMD+9 to jump.",
    "Search the page with CMD+F, type the words, press ENTER, then ESC to close the find bar.",
    "Read context.browserAddress before typing so you never resubmit the page you are already on.",
    "Reload with CMD+R and go back with CMD+LEFT instead of hunting for toolbar buttons.",
  ],
  "com.spotify.client": [
    "Spotify publishes no accessibility tree: context.controls is empty, so work from the keyboard.",
    "Search with CMD+K (CMD+L on older builds), type the query, then press ENTER.",
    "Move through results with UP and DOWN and press ENTER to play the highlighted one.",
    "SPACE plays or pauses; do not click the transport controls, they are invisible to you.",
    "Never call open_app for Spotify once appId is com.spotify.client; it is already frontmost.",
    "Its menu bar still works: context.menuBar lists the titles, so use a menu item before guessing.",
  ],
  "com.tinyspeck.slackmacgap": [
    "Jump to a channel or person with CMD+K, type the name, then UP or DOWN and ENTER.",
    "Search all messages with CMD+G, type the terms, press ENTER, then read the results pane.",
    "The message box takes focus when a channel opens, so type straight away; SHIFT+ENTER adds a line.",
    "ENTER sends immediately: type in the message box only when the objective asks you to send.",
    "Close a thread, panel or dialog with ESC rather than looking for its close button.",
  ],
  "com.apple.notes": [
    "Create a note with CMD+N, type the title, press ENTER, then type the body.",
    "Search every note with CMD+ALT+F, type the words, then ENTER to open the highlighted note.",
    "Find inside the open note with CMD+F, and press ESC to close the find bar.",
    "Notes saves as you type: there is no save step and no confirmation to wait for.",
    "Do not edit an existing note unless the objective asks; CMD+N keeps new text in a new note.",
  ],
  "com.apple.mail": [
    "Start a message with CMD+N, type the recipient, press TAB to the subject, TAB again to the body.",
    "Search the mailbox with CMD+ALT+F, type the terms, press ENTER, then UP and DOWN to read results.",
    "Reply with CMD+R and reply all with CMD+SHIFT+R; CMD+SHIFT+N fetches new mail.",
    "CMD+SHIFT+D sends the draft: press it only when the objective asks you to send.",
    "Read the message list with UP and DOWN instead of clicking rows.",
  ],
  "com.apple.finder": [
    "Open any folder by path with CMD+SHIFT+G, type the path, then press ENTER.",
    "Prefer open_file with a ~/ path from context.memory.files over clicking through folders.",
    "Search with CMD+F; CMD+DOWN opens the selection and CMD+UP goes up one folder.",
    "Switch to list view with CMD+2 so rows are readable and selectable from the keyboard.",
    "Never empty the Trash or move the user's files unless the objective asks.",
  ],
  "com.apple.systempreferences": [
    "Every pane is reachable from the search field: press CMD+F, type the setting, then DOWN and ENTER.",
    "Panes load slowly: wait 500-1500 ms after opening one before reading the screenshot.",
    "A toggle changes the Mac for real, so propose one only when the objective asks for it.",
    "Never touch Apple ID, passwords, security, privacy or network settings on your own.",
  ],
  "com.apple.mobilesms": [
    "Start a conversation with CMD+N, type the contact, press ENTER, then TAB to the message field.",
    "Find an existing conversation with CMD+F, type the name, then ENTER to open the top result.",
    "ENTER sends immediately: type in the message field only when the objective asks you to send.",
    "Never open, forward or reply to messages the objective did not ask about.",
  ],
  "com.apple.ical": [
    "Create an event with CMD+N, type the title, then TAB through the date and time fields.",
    "Switch views with CMD+1 for day, CMD+2 for week and CMD+3 for month; CMD+T jumps to today.",
    "Find an event with CMD+F, type the words, press ENTER, then UP and DOWN through the results.",
    "Moving or deleting an event changes the user's calendar: propose it only when asked.",
  ],
  "com.apple.terminal": terminal,
  "com.googlecode.iterm2": terminal,
  "dev.warp.warp-stable": terminal,
  "com.mitchellh.ghostty": terminal,
  "net.kovidgoyal.kitty": terminal,
  "org.alacritty": terminal,
  "co.zeit.hyper": terminal,
  "com.github.wez.wezterm": terminal,
  "com.microsoft.vscode": [
    "Open the command palette with CMD+SHIFT+P, type the command, then press ENTER to run it.",
    "Open a file by name with CMD+P, type part of the name, then UP or DOWN and ENTER.",
    "Find in the file with CMD+F and across the project with CMD+SHIFT+F; ESC closes the box.",
    "Save with CMD+S only when the objective asks you to change the file.",
    "Never open a terminal or run a task from the palette: the shell is not allowed.",
  ],
  "com.apple.preview": [
    "Open the document with open_file and a ~/ path from context.memory.files instead of browsing.",
    "Search the open document with CMD+F, type the words, then ENTER to step through the matches.",
    "Turn pages with PAGEDOWN and PAGEUP; DOWN and UP scroll within the page.",
    "Show the thumbnail sidebar with CMD+ALT+2, then pick a page with UP or DOWN.",
    "Do not annotate, crop, rotate or save over the user's file unless the objective asks.",
  ],
  "com.apple.music": [
    "Search the library with CMD+F, type the query, press ENTER, then UP or DOWN to pick a result.",
    "SPACE plays or pauses the selection; CMD+RIGHT is the next track and CMD+LEFT the previous one.",
    "Play the highlighted row with ENTER; artwork tiles rarely click where you expect.",
    "Never buy, subscribe or change the Apple account: playing something needs none of that.",
  ],
  "com.apple.photos": [
    "Search with CMD+F, type the person, place or thing, then press ENTER to see the matches.",
    "Move through the grid with the arrow keys; SPACE previews the selected photo and ESC closes it.",
    "Never delete, hide or share photos, and never empty Recently Deleted.",
    "Importing or editing changes the user's library: propose it only when the objective asks.",
  ],
};

/** Display names seen in context.appName, for frames without a bundle id. */
const names: Record<string, string> = {
  "google chrome": "com.google.chrome",
  chrome: "com.google.chrome",
  safari: "com.apple.safari",
  spotify: "com.spotify.client",
  slack: "com.tinyspeck.slackmacgap",
  notes: "com.apple.notes",
  mail: "com.apple.mail",
  finder: "com.apple.finder",
  "system settings": "com.apple.systempreferences",
  "system preferences": "com.apple.systempreferences",
  messages: "com.apple.mobilesms",
  calendar: "com.apple.ical",
  terminal: "com.apple.terminal",
  iterm: "com.googlecode.iterm2",
  iterm2: "com.googlecode.iterm2",
  "visual studio code": "com.microsoft.vscode",
  code: "com.microsoft.vscode",
  preview: "com.apple.preview",
  music: "com.apple.music",
  photos: "com.apple.photos",
};

/** Generic routes for an app the table does not name, by category. */
export const categoryPlaybooks: Record<PlaybookCategory, string[]> = {
  browser: [
    "Focus the address bar with CMD+L, type the URL or search words, then press ENTER.",
    "Use CMD+T for a new tab, CMD+W to close one and CMD+F to search the page.",
    "Read context.browserAddress before typing so you never resubmit the current page.",
    "Do not call open_app for a browser that is already frontmost; press CMD+L instead.",
  ],
  notes: [
    "Create a new item with CMD+N and type straight into it; CMD+S saves where saving is needed.",
    "Search with CMD+F, and try CMD+K or CMD+SHIFT+P for the app's own command palette.",
    "Do not edit or replace existing content unless the objective asks for it.",
  ],
  mail: [
    "Write a new message with CMD+N, then TAB between the recipient, subject and body fields.",
    "Search the mailbox with CMD+ALT+F, press ENTER, then read the results with UP and DOWN.",
    "Sending is a real action: propose it only when the objective asks, and expect an approval.",
  ],
  chat: [
    "Find a conversation with CMD+K, type the name, then UP or DOWN and ENTER to open it.",
    "The message box usually holds focus, so type directly; SHIFT+ENTER adds a line without sending.",
    "ENTER sends immediately: type a message only when the objective asks you to send one.",
  ],
  music: [
    "Search with CMD+K or CMD+F, type the query, press ENTER, then UP or DOWN and ENTER to play.",
    "SPACE plays or pauses; CMD+RIGHT and CMD+LEFT move between tracks.",
    "Never buy, subscribe or change the account while playing something.",
  ],
  files: [
    "Open a folder by path with CMD+SHIFT+G, type the path, then press ENTER.",
    "Prefer open_file with a ~/ path from context.memory.files over clicking through folders.",
    "Never delete or move the user's files unless the objective asks.",
  ],
  settings: [
    "Search the settings with CMD+F, type the name of the setting, then DOWN and ENTER.",
    "Wait 500-1500 ms after opening a pane before reading the screenshot.",
    "Changing a setting is real: propose one only when asked, and never touch accounts or security.",
  ],
  terminal,
  editor: [
    "Open the command palette with CMD+SHIFT+P and a file by name with CMD+P, then press ENTER.",
    "Find in the file with CMD+F and across the project with CMD+SHIFT+F; ESC closes the box.",
    "Never open a terminal or run a task from the editor: you have no shell.",
  ],
  viewer: [
    "Open the document with open_file and a ~/ path from context.memory.files rather than browsing.",
    "Search the document with CMD+F, then press ENTER to step through the matches.",
    "Turn pages with PAGEDOWN and PAGEUP, and never save over the user's file.",
  ],
  generic: [
    "Try the app's own search or command palette first, usually CMD+K, then CMD+F.",
    "Do not call open_app for the application that is already frontmost; use its shortcuts.",
    "When context.accessibility is none, never click blindly: use shortcuts and the menu bar.",
    "context.menuBar lists the top-level menus: open the one you need and choose by keyboard.",
  ],
};

/** Ordered: the first pattern that matches the bundle id or name wins. */
const categories: [PlaybookCategory, RegExp][] = [
  [
    "terminal",
    /\bterm\b|terminal|iterm|ghostty|alacritty|kitty|\bwarp\b|wezterm|\bhyper\b|tmux|\bshell\b/,
  ],
  [
    "browser",
    /chrome|chromium|safari|firefox|\bedge\b|\bopera\b|vivaldi|brave|\barc\b|thebrowser|orion|\bzen\b/,
  ],
  [
    "editor",
    /vscode|visual studio|xcode|sublime|intellij|pycharm|webstorm|goland|jetbrains|android studio|\bzed\b|cursor|textmate|\batom\b|emacs|\bvim\b|\bnova\b/,
  ],
  [
    "chat",
    /slack|discord|teams|telegram|whatsapp|signal|\bzoom\b|messages|mobilesms|imessage|webex/,
  ],
  ["mail", /\bmail\b|outlook|spark|thunderbird|airmail|postbox/],
  ["music", /music|spotify|itunes|tidal|soundcloud|pandora|\bvlc\b|\biina\b/],
  [
    "notes",
    /notes|notion|\bbear\b|obsidian|craft|evernote|onenote|logseq|\bword\b|\bpages\b|textedit|\bdocs\b/,
  ],
  ["files", /finder|forklift|commander|\bfiles\b/],
  ["settings", /systempreferences|system settings|preferences|settings/],
  ["viewer", /preview|photos|acrobat|\bpdf\b|\bskim\b|quicktime|\bimage\b/],
];

const normalize = (value: unknown) =>
  typeof value === "string"
    ? value
        .trim()
        .toLowerCase()
        .replace(/\.app$/, "")
    : "";

/** Bounded copy: at most 6 lines of at most 120 characters, always fixed text. */
const bound = (lines: string[]) =>
  lines
    .slice(0, PLAYBOOK_MAX_LINES)
    .map((line) => line.slice(0, PLAYBOOK_MAX_CHARS));

/**
 * The category of an application the table does not name, from its bundle id
 * and display name. Returns "generic" when nothing matches and undefined when
 * there is nothing to match against.
 */
export function playbookCategory(
  appId?: string,
  appName?: string,
): PlaybookCategory | undefined {
  const text = `${normalize(appId)} ${normalize(appName)}`.trim();
  if (!text) return undefined;
  return categories.find(([, pattern]) => pattern.test(text))?.[0] ?? "generic";
}

/**
 * Reliable keyboard routes for one application: its own entry, else the
 * fallback for its category. At most 6 short lines, never user content.
 * Returns [] when the frontmost application is unknown.
 */
export function playbookFor(appId?: string, appName?: string): string[] {
  const id = normalize(appId);
  const name = normalize(appName);
  const entry = playbooks[id] ?? playbooks[names[name] ?? ""];
  if (entry) return bound(entry);
  const category = playbookCategory(appId, appName);
  return category ? bound(categoryPlaybooks[category]) : [];
}

export interface PlaybookContext {
  /** Bundle id of the frontmost application (Frame.appId). */
  appId?: string;
  /** Display name of the frontmost application (ScreenContext.appName). */
  appName?: string;
  /** Source of the plan memory recalled for this task, when there is one. */
  plan?: "skill" | "intent";
}

/**
 * The `context.playbook` lines for one request. A learned skill already has
 * the steps that worked for this exact task, so its plan wins and no hint is
 * sent; a built-in intent is generic, so the playbook still helps.
 */
export function playbookLines(context?: PlaybookContext): string[] {
  if (!context || context.plan === "skill") return [];
  return playbookFor(context.appId, context.appName);
}
