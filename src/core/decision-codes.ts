/**
 * Every reason a policy decision can carry, as a short fixed code.
 *
 * The policy's ALLOW, RETRY and DENY reasons are fixed sentences or fixed
 * shapes around a quoted label, an application's name, a key chord or a
 * file (src/core/policy.ts, src/core/tool-policy.ts TOOL_ALLOWED,
 * src/core/tools.ts TOOL_REFUSALS, the runner's windowlessRepeat). The
 * model reads the sentence; the diagnostics stream and the bench ledger
 * must say what was decided without the label or any other screen text, so
 * each table names the shape of the reason and nothing in it. The runner
 * stamps the code beside the reason on PolicyAllowed, ActionRetargetRequested
 * and a policy denial's UserDenied; electron/diagnostics.ts writes the code
 * and the reason's length and never the reason. A reason a table does not
 * know is OTHER; tests/policy-decision-codes.test.ts enumerates the policy's
 * decision sites so a new sentence cannot stay OTHER unnoticed.
 *
 * The questions of a CONFIRM decision have their own table in
 * src/core/approval-codes.ts.
 */
import {
  PASTE_ALLOWED,
  PROTECTED_SITE_REFUSAL,
  SPEAKING_RETRY,
} from "./policy";
import { TOOL_ALLOWED } from "./tool-policy";
import { TOOL_REFUSALS } from "./tools";

export const ALLOWED_CODES = [
  // A step with no rule to state: capture, done, fail, wait.
  "NONE",
  // Why a question was not asked (withoutAsking and the autonomy rules).
  "ALLOWED_AUTONOMY_ALL",
  "ALLOWED_FLOW_UNDOABLE",
  "ALLOWED_GROUNDED",
  "ALLOWED_TOGGLE_ASKED",
  "UNDO_MENU",
  "KEY_UNDOABLE_EDIT",
  // Opening things.
  "OPEN_APP",
  "OPEN_APP_SHOW_WINDOW",
  "OPEN_URL",
  "OPEN_FILE_INDEXED",
  "OPEN_DOCUMENT",
  "OPEN_SEARCH_RESULT",
  "OPEN_TAB",
  "FOLLOW_LINK",
  "OPEN_SPOTLIGHT",
  "SPOTLIGHT_RESULT",
  // Menus and shortcuts.
  "OPEN_MENU",
  "CONTEXT_MENU",
  "MENU_ITEM",
  "MENU_SHORTCUT",
  "ROUTINE_SHORTCUT",
  "PALETTE_AGENT_FOCUS",
  "PASTE_ASKED",
  "FIND_IN_APP",
  "APP_SEARCH",
  "ADDRESS_BAR_FOCUS",
  "ADDRESS_BAR_NAVIGATE",
  "RELOAD_PAGE",
  "DISMISS",
  "KEY_NAVIGATION",
  "SPACE_KEY",
  // Text.
  "TYPE_TEXT_FIELD",
  "TYPE_DOCUMENT",
  "NOTES_EDITOR",
  "EDIT_TEXT",
  "FORMAT_TEXT",
  "FOCUS_INPUT",
  "SUBMIT_SEARCH",
  "SEARCH_FIELD_TYPE",
  "SEARCH_FIELD_ENTER",
  "SEARCH_FIELD_CORRECT",
  "CALCULATOR",
  // Pointer targets.
  "POINTER_NAVIGATION",
  "SELECT_ITEM",
  "ACTIVATE_CONTROL",
  "FILTER_RESULTS",
  "SEARCH_PAGE_CONTROL",
  "SETTINGS_ABOUT",
  // Special surfaces.
  "MONITOR",
  "TUTORIAL_SURFACE",
  // Tool steps (TOOL_ALLOWED).
  "TOOL_READ",
  "TOOL_GROUNDED",
  "TOOL_UNDOABLE",
  "TOOL_GROUNDED_WRITE",
  "OTHER",
] as const;
export type AllowedCode = (typeof ALLOWED_CODES)[number];

export const RETRY_CODES = [
  "WAITING_FOR_SENTENCE",
  "TUTORIAL_NO_TARGET",
  "ACCESSIBILITY_NOT_TRUSTED",
  // Applications.
  "APP_ALREADY_FRONTMOST",
  "APP_AMBIGUOUS",
  "APP_UNRESOLVED",
  "APP_UNIDENTIFIED",
  "WINDOWLESS",
  "WINDOWLESS_REPEAT",
  "DOCK_CLICK",
  "CMD_TAB",
  "SPOTLIGHT_UNVERIFIED",
  "SPOTLIGHT_MISMATCH",
  // Addresses and files.
  "BAD_URL",
  "FILE_NOT_INDEXED",
  // Named controls and menu items.
  "CONTROL_NOT_FOUND",
  "CONTROL_AMBIGUOUS",
  "CONTROL_DISABLED",
  "CONTROL_UNRESOLVED",
  "CONTROL_COVERED",
  "CONTROL_UNLABELLED",
  "MENU_ITEM_MISSING",
  "MENU_ITEM_DISABLED",
  "MENUS_UNREADABLE",
  "TARGET_DISABLED",
  "TARGET_UNIDENTIFIED",
  // Keys and fields.
  "SHORTCUT_NOT_ROUTINE",
  "KEY_UNVERIFIED",
  "PASTE_VIA_KEYS",
  "FIELD_UNIDENTIFIED",
  "NO_FIELD_FOCUSED",
  "NO_FIELD_SEARCH_ROUTE",
  // Editors and their palettes.
  "PALETTE_QUERY_EDITED",
  "PALETTE_EMPTY",
  "PALETTE_SELECTION_MOVED",
  "IDE_FOCUS_UNKNOWN",
  "IDE_BOX_UNKNOWN",
  "IDE_NO_TEXT_FIELD",
  // A run bound to a background window.
  "BACKGROUND_NO_SWITCH",
  "BACKGROUND_NO_DRAG",
  "BACKGROUND_NO_CHORD",
  // Tool steps (TOOL_REFUSALS that retry).
  "TOOL_PRACTICE",
  "TOOL_UNKNOWN",
  "TOOL_BAD_ARGS",
  "TOOL_TOO_LARGE",
  "TOOL_BAD_PATH",
  "TOOL_UNAVAILABLE",
  "TOOL_NO_HOOK",
  "OTHER",
] as const;
export type RetryCode = (typeof RETRY_CODES)[number];

export const DENY_CODES = [
  "PROTECTED_APP",
  "PROTECTED_SITE",
  "APP_REFUSED",
  "FILE_REFUSED",
  "FILE_APP_REFUSED",
  "INSTALLER_WINDOW",
  "INSTALLER_APP",
  "UNINSTALLER_CONTROL",
  "SPOTLIGHT_INSTALLER",
  "EXECUTABLE_ADDRESS",
  "EXECUTABLE_LINK",
  "NOT_A_BROWSER",
  "IDE_TERMINAL",
  "TERMINAL_FOCUS",
  "QUIT_LOGOUT_SHUTDOWN",
  "CLIPBOARD",
  "CREDENTIAL",
  "OUTSIDE_BOUND_WINDOW",
  // Tool steps (TOOL_REFUSALS that deny).
  "TOOL_DENYLISTED",
  "TOOL_CREDENTIAL",
  "TOOL_BUDGET",
  "TOOL_PRIVACY",
  "OTHER",
] as const;
export type DenyCode = (typeof DENY_CODES)[number];

interface Table<C extends string> {
  /** Reasons that are one fixed string, compared whole. */
  fixed: ReadonlyMap<string, C>;
  /**
   * Reasons that quote a label, an application, a chord or a file inside a
   * fixed frame; the frame decides, tried in order after the fixed table.
   */
  shapes: readonly (readonly [RegExp, C])[];
}

const ALLOWED: Table<AllowedCode> = {
  fixed: new Map<string, AllowedCode>([
    ["", "NONE"],
    [
      "Show the main window of an application open with no window.",
      "OPEN_APP_SHOW_WINDOW",
    ],
    ["Open a verified installed application.", "OPEN_APP"],
    ["Load a web address in the browser.", "OPEN_URL"],
    ["Open a document or folder from the local index.", "OPEN_FILE_INDEXED"],
    [
      "Open the coding agent's input from the command palette.",
      "PALETTE_AGENT_FOCUS",
    ],
    ["Choose a menu item this application publishes.", "MENU_ITEM"],
    [PASTE_ALLOWED, "PASTE_ASKED"],
    ["Watch the frontmost window without sending input.", "MONITOR"],
    ["CoArena-owned tutorial surface.", "TUTORIAL_SURFACE"],
    ["Pointer navigation.", "POINTER_NAVIGATION"],
    ["Dismiss the current menu or panel.", "DISMISS"],
    ["Navigate with the keyboard.", "KEY_NAVIGATION"],
    ["Enter a calculation.", "CALCULATOR"],
    ["Press a Calculator key.", "CALCULATOR"],
    ["Open Spotlight.", "OPEN_SPOTLIGHT"],
    ["Open the verified matching Spotlight result.", "SPOTLIGHT_RESULT"],
    ["Find within the current application.", "FIND_IN_APP"],
    ["Open this application's own search or command palette.", "APP_SEARCH"],
    ["Focus the browser address bar.", "ADDRESS_BAR_FOCUS"],
    ["Navigate from the verified browser address bar.", "ADDRESS_BAR_NAVIGATE"],
    ["Reload the page.", "RELOAD_PAGE"],
    ["Routine application shortcut.", "ROUTINE_SHORTCUT"],
    ["Select or format text in a known field.", "FORMAT_TEXT"],
    ["Focus a known input control.", "FOCUS_INPUT"],
    ["Open an application menu.", "OPEN_MENU"],
    ["Open a context menu.", "CONTEXT_MENU"],
    ["Open a document.", "OPEN_DOCUMENT"],
    ["Open a search result.", "OPEN_SEARCH_RESULT"],
    ["Open a tab.", "OPEN_TAB"],
    ["Follow a web link.", "FOLLOW_LINK"],
    ["Write in the Notes document editor.", "NOTES_EDITOR"],
    ["Submit a search.", "SUBMIT_SEARCH"],
    ["Type in a known non-secure text field.", "TYPE_TEXT_FIELD"],
    ["Write multi-line text in a document editor.", "TYPE_DOCUMENT"],
    ["Edit text.", "EDIT_TEXT"],
    ["Type a space or scroll the page.", "SPACE_KEY"],
    ["Select or open an identified, non-consequential item.", "SELECT_ITEM"],
    ["Filter the visible results.", "FILTER_RESULTS"],
    ["Use a control on a search results page.", "SEARCH_PAGE_CONTROL"],
    [
      "Open System Settings’ About pane: it only shows information.",
      "SETTINGS_ABOUT",
    ],
    ["Activate an identified, non-consequential control.", "ACTIVATE_CONTROL"],
    [TOOL_ALLOWED.read, "TOOL_READ"],
    [TOOL_ALLOWED.grounded, "TOOL_GROUNDED"],
    [TOOL_ALLOWED.undoable, "TOOL_UNDOABLE"],
    [TOOL_ALLOWED.grounded_write, "TOOL_GROUNDED_WRITE"],
    [TOOL_ALLOWED.unasked, "ALLOWED_AUTONOMY_ALL"],
  ]),
  shapes: [
    // The quoted part comes first and may hold anything, so the frame is
    // matched at the end and the code never depends on the label.
    [
      /: done without asking, as you set\. Reported when done\.$/su,
      "ALLOWED_AUTONOMY_ALL",
    ],
    [
      /^.+ can be undone: done without asking, and reported\.$/su,
      "ALLOWED_FLOW_UNDOABLE",
    ],
    [
      /^.+ is what you asked for and can be undone: reported, not asked\.$/su,
      "ALLOWED_GROUNDED",
    ],
    [
      /^.+ is the state you asked for, and pressing it again puts it back: reported, not asked\.$/su,
      "ALLOWED_TOGGLE_ASKED",
    ],
    [
      /^.+ takes the last step back: done without asking, and reported\.$/su,
      "UNDO_MENU",
    ],
    [
      /^Press .+: an edit that can be undone, reported\.$/su,
      "KEY_UNDOABLE_EDIT",
    ],
    [
      /^Open a document or folder from the local index in ".*"\.$/su,
      "OPEN_FILE_INDEXED",
    ],
    [/^This application's own shortcut for .+\.$/su, "MENU_SHORTCUT"],
    [/^Type into .+ field\.$/su, "SEARCH_FIELD_TYPE"],
    [/^Open the result of .+\.$/su, "SEARCH_FIELD_ENTER"],
    [/^Correct the query in .+ field\.$/su, "SEARCH_FIELD_CORRECT"],
  ],
};

const RETRY: Table<RetryCode> = {
  fixed: new Map<string, RetryCode>([
    [SPEAKING_RETRY, "WAITING_FOR_SENTENCE"],
    ["The tutorial has no applications to open.", "TUTORIAL_NO_TARGET"],
    ["The tutorial has no websites to open.", "TUTORIAL_NO_TARGET"],
    ["The tutorial has no files to open.", "TUTORIAL_NO_TARGET"],
    [
      "No input was sent. Accessibility is not trusted, so applications cannot be opened.",
      "ACCESSIBILITY_NOT_TRUSTED",
    ],
    [
      "No input was sent. Accessibility is not trusted, so files cannot be opened.",
      "ACCESSIBILITY_NOT_TRUSTED",
    ],
    [
      "No input was sent. Use a full http or https address without credentials.",
      "BAD_URL",
    ],
    [
      "No input was sent. That path is not in the local index. Use a path listed in context.memory.files or folders, or request_user.",
      "FILE_NOT_INDEXED",
    ],
    [
      "No input was sent. Paste with CMD+V into the focused text field instead of the menu item.",
      "PASTE_VIA_KEYS",
    ],
    [
      "No input was sent. This application's menus could not be read. Use a shortcut from context.menus or a visible control.",
      "MENUS_UNREADABLE",
    ],
    [
      "No input was sent. That control could not be resolved. Name a control from context.controls.",
      "CONTROL_UNRESOLVED",
    ],
    [
      "No input was sent. Dragging has no route to a background window. Use a listed control, the menu or the keyboard, or scroll.",
      "BACKGROUND_NO_DRAG",
    ],
    [
      "No input was sent. The target is disabled. Choose an enabled control or an application shortcut from the fresh screenshot.",
      "TARGET_DISABLED",
    ],
    [
      "No input was sent. The focused application could not be identified, so shortcuts are paused. Capture a fresh screenshot and switch to the requested application first.",
      "APP_UNIDENTIFIED",
    ],
    [
      "No input was sent. Command-Tab switches to whichever application came last, not the one you want. Use open_app with the application's name.",
      "CMD_TAB",
    ],
    [
      "No input was sent. To open or switch to an application, use open_app with its exact name instead of clicking the Dock.",
      "DOCK_CLICK",
    ],
    [
      "No input was sent. This control has no accessible label, so its effect cannot be verified. Use a labelled control, a menu item or a keyboard shortcut instead.",
      "CONTROL_UNLABELLED",
    ],
    [
      "No input was sent. The focused field could not be identified. Capture a fresh screenshot and focus the intended text field first.",
      "FIELD_UNIDENTIFIED",
    ],
    [
      "No input was sent. No known text field is focused. Click the intended text field first, then type.",
      "NO_FIELD_FOCUSED",
    ],
    [
      "No input was sent. This key cannot be verified here. Use type_text for text in a focused field, or a navigation key once the application is identified.",
      "KEY_UNVERIFIED",
    ],
    [
      "No input was sent. This target could not be identified. Use a recognized control, open_app, or an exact application shortcut instead of repeating this action. Check frame appId; switch to the requested app first. Do not ask the user to approve routine navigation.",
      "TARGET_UNIDENTIFIED",
    ],
    [TOOL_REFUSALS.practice, "TOOL_PRACTICE"],
    [TOOL_REFUSALS.unknown_tool, "TOOL_UNKNOWN"],
    [TOOL_REFUSALS.invalid_args, "TOOL_BAD_ARGS"],
    [TOOL_REFUSALS.too_large, "TOOL_TOO_LARGE"],
    [TOOL_REFUSALS.bad_path, "TOOL_BAD_PATH"],
    [TOOL_REFUSALS.unavailable, "TOOL_UNAVAILABLE"],
    [TOOL_REFUSALS.no_hook, "TOOL_NO_HOOK"],
  ]),
  shapes: [
    [
      /^No input was sent\. .+ is already open and frontmost\. Work with what is on screen, or use a keyboard shortcut\.$/su,
      "APP_ALREADY_FRONTMOST",
    ],
    [
      /^More than one installed application matches\..* Use the exact name\.$/su,
      "APP_AMBIGUOUS",
    ],
    [
      /^No input was sent\. No installed application matches ".*" exactly\..* Use one of them, or (?:request_user if it is not installed|open the item with open_file alone)\.$/su,
      "APP_UNRESOLVED",
    ],
    [
      /^No input was sent\. The text in .+ was edited after it was typed, so what ENTER would open or run there cannot be named\. Press ESC, open it again and type the whole .+, then press ENTER\.$/su,
      "PALETTE_QUERY_EDITED",
    ],
    [
      /^No input was sent\. Nothing is typed in .+, so ENTER would run whichever command it lists first \(often the one used last\)\. Type the command's name first\.$/su,
      "PALETTE_EMPTY",
    ],
    [
      /^No input was sent\. An arrow key moved the selection in .+ off the top match for .+, so what ENTER would run cannot be named\. Type more of the command's name so it comes first, then press ENTER\.$/su,
      "PALETTE_SELECTION_MOVED",
    ],
    [
      /^No input was sent\. Nothing identifies what has focus in .+, where this key could run a line in its terminal or a command left selected in its palette\. Open the box you need with the app's own command first \(CMD\+P for a file, CMD\+F to find\), or ask the user with request_user\.$/su,
      "IDE_FOCUS_UNKNOWN",
    ],
    [
      /^No input was sent\. This box in .+ can run commands, and what was typed there is not known\. Open it again with the app's own command \(CMD\+P for a file, CMD\+F to find\), type the query, then press ENTER\.$/su,
      "IDE_BOX_UNKNOWN",
    ],
    [
      /^No input was sent\. .+ is not in this application's menus\. Choose an item from context\.menus, or take another route\.$/su,
      "MENU_ITEM_MISSING",
    ],
    [
      /^No input was sent\. .+ is greyed out right now\. Do the step that enables it first \(open a window, select something\), or take another route\.$/su,
      "MENU_ITEM_DISABLED",
    ],
    [
      /^No input was sent\. Nothing in context\.controls is named .+ now\. If you can see it in the screenshot, click it by position with click\(x,y\) instead; otherwise take a fresh look\. Do not repeat this name\.$/su,
      "CONTROL_NOT_FOUND",
    ],
    [
      /^No input was sent\. Several controls are named .+\. Add the x and y of the one you mean from context\.controls, or name a different control\.$/su,
      "CONTROL_AMBIGUOUS",
    ],
    [
      /^No input was sent\. .+ is disabled\. Choose an enabled control\.$/su,
      "CONTROL_DISABLED",
    ],
    [
      /^No input was sent\. .+ is covered by something else right now\. Bring its window to the front first, or choose another route\.$/su,
      "CONTROL_COVERED",
    ],
    [
      /^No input was sent\. This run works in .+'s window in the background: it is already the window in the screenshot, so nothing else is opened or switched to\. Work in it, or finish with done\.$/su,
      "BACKGROUND_NO_SWITCH",
    ],
    [
      /^No input was sent\. .+ is not one of .+'s menu shortcuts, and a chord cannot be posted to a background window\. Use menu_item with the command's name from context\.menus, or a listed control\.$/su,
      "BACKGROUND_NO_CHORD",
    ],
    [
      /^No input was sent\. .+ is not a routine shortcut in this context\. Use a visible control, a menu item, or a common shortcut such as CMD\+W, CMD\+T, CTRL\+TAB or CMD\+A in a focused text field\.$/su,
      "SHORTCUT_NOT_ROUTINE",
    ],
    // The runner's own refusal of a second open_app on a windowless
    // application (src/core/runner.ts windowlessRepeat) before the policy's.
    [
      /^No input was sent\. .+ is open but shows no window, and opening it again will not show one\. Use its Window menu or File > New\.$/su,
      "WINDOWLESS_REPEAT",
    ],
    [
      /^No input was sent\. .+ is open but shows no window\. Choose its window from its Window menu in context\.menus, or use File > New\.$/su,
      "WINDOWLESS",
    ],
    [
      /^No input was sent\. Spotlight has no verified selection for ".*"\. Use open_app with the exact application name, or type the full application name and wait for the result\.$/su,
      "SPOTLIGHT_UNVERIFIED",
    ],
    [
      /^No input was sent\. Spotlight selected ".*" for ".*"\. Use open_app with the exact application name, or retype the query to match the result exactly\.$/su,
      "SPOTLIGHT_MISMATCH",
    ],
    [
      /^No input was sent\. No text field is identified in .+, and typing blind there can reach its terminal\. Open the box you need with the app's own command first \(CMD\+P for a file, CMD\+F to find\), or ask the user with request_user\.$/su,
      "IDE_NO_TEXT_FIELD",
    ],
    [
      /^No input was sent\. No text field is focused in .+\. Open its search first with menu_item .+, then type\.$/su,
      "NO_FIELD_SEARCH_ROUTE",
    ],
  ],
};

const DENY: Table<DenyCode> = {
  fixed: new Map<string, DenyCode>([
    [PROTECTED_SITE_REFUSAL, "PROTECTED_SITE"],
    [
      "That application is protected. Ask the user to open it with request_user.",
      "PROTECTED_APP",
    ],
    [
      "That application is protected. Open the item with open_file alone, or ask the user with request_user.",
      "PROTECTED_APP",
    ],
    [
      "That application cannot be opened by the assistant: installers, uninstallers, system utilities and protected apps require manual operation. If the task needs it, ask the user with request_user.",
      "APP_REFUSED",
    ],
    [
      "That file cannot be opened by the assistant: apps, scripts, installers and private system files require manual operation.",
      "FILE_REFUSED",
    ],
    [
      "That application cannot open it: terminals, installers, system utilities and protected apps stay manual. Open the item with open_file alone, or ask the user with request_user.",
      "FILE_APP_REFUSED",
    ],
    [
      "Installer, uninstaller and updater windows require manual operation. Return to the requested task, or ask the user with request_user.",
      "INSTALLER_WINDOW",
    ],
    [
      "Installer and uninstaller applications require manual operation. Open the requested application instead.",
      "INSTALLER_APP",
    ],
    [
      "Uninstaller controls require manual operation. Return to the requested task.",
      "UNINSTALLER_CONTROL",
    ],
    [
      "The selected Spotlight result is an installer or destructive utility. Do not launch it. Use open_app with the full name of the intended application.",
      "SPOTLIGHT_INSTALLER",
    ],
    [
      "Executable and local-file addresses require manual operation.",
      "EXECUTABLE_ADDRESS",
    ],
    [
      "Executable and local-file links require manual operation.",
      "EXECUTABLE_LINK",
    ],
    [
      "The foreground application is not a browser. First switch to the requested browser using open_app or Command-Space and its full app name, then use Command-L.",
      "NOT_A_BROWSER",
    ],
    // policy.ts IDE_TERMINAL_REFUSAL, TERMINAL focus, MENU_REFUSAL and
    // CLIPBOARD_REFUSAL are module-private; the enumeration test reads them
    // from the source and fails here should they drift.
    [
      "Terminals, tasks, builds and run or debug commands are left to the user: a terminal runs whatever is typed next. Finish the task another way, or ask the user with request_user.",
      "IDE_TERMINAL",
    ],
    [
      "The focus is in a terminal, where typed text and ENTER run shell commands. Terminals are left to the user: finish the task another way, or ask the user with request_user.",
      "TERMINAL_FOCUS",
    ],
    [
      "Quitting an application, logging out and shutting down are left to the user. Finish the task another way.",
      "QUIT_LOGOUT_SHUTDOWN",
    ],
    [
      "Clipboard access is disabled. Pasting is allowed only when the user asked for a paste and a text field is focused; copying and cutting never are.",
      "CLIPBOARD",
    ],
    ["Detected credentials cannot be typed by the agent.", "CREDENTIAL"],
    [TOOL_REFUSALS.denylisted, "TOOL_DENYLISTED"],
    [TOOL_REFUSALS.credential, "TOOL_CREDENTIAL"],
    [TOOL_REFUSALS.budget, "TOOL_BUDGET"],
    [TOOL_REFUSALS.privacy, "TOOL_PRIVACY"],
  ]),
  shapes: [
    [
      /^No input was sent\. The step's target is not the .+ window this run is bound to; input goes only to that window\.$/su,
      "OUTSIDE_BOUND_WINDOW",
    ],
  ],
};

/**
 * Exact, never trimmed or lowercased: a reason that drifted from the
 * policy's string is OTHER, which the enumeration test turns into a failure.
 */
function lookup<C extends string>(
  table: Table<C>,
  reason: string,
  other: C,
): C {
  const fixed = table.fixed.get(reason);
  if (fixed) return fixed;
  for (const [shape, code] of table.shapes) if (shape.test(reason)) return code;
  return other;
}

/** The code for the reason of an ALLOW decision (a PolicyAllowed event). */
export function allowedCode(reason: string): AllowedCode {
  return lookup(ALLOWED, reason, "OTHER");
}
/** The code for the reason of a RETRY decision (an ActionRetargetRequested event). */
export function retryCode(reason: string): RetryCode {
  return lookup(RETRY, reason, "OTHER");
}
/** The code for the reason of a DENY decision (a policy denial's UserDenied event). */
export function deniedCode(reason: string): DenyCode {
  return lookup(DENY, reason, "OTHER");
}
