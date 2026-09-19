import { webAddress, type Action, type Settings, type Surface } from "./schema";
import { KNOWN_FOLDERS } from "./places";
import { scanText } from "./sanitize";
import type { ToolClock, ToolPrepared, ToolSpec } from "./tools";
import { toolDecision } from "./tool-policy";
import {
  ideCommandTitleRefused,
  ideDiscardLabel,
  ideFamily,
  ideMenuRefused,
  ideQuickInputField,
  isTerminalApp,
  credentialAppPrefixes,
  paletteClass,
  paletteTitle,
  quickOpenRunsCommand,
  quickOpenTitle,
} from "./ide";
export type Decision = {
  kind: "ALLOW" | "CONFIRM" | "DENY" | "RETRY" | "USER_TAKEOVER";
  reason: string;
  /** A question no autonomy setting removes (the send_to question of a tool step). */
  floor?: true;
};
// Installer, uninstaller and system setup/recovery tools are never launched or
// operated by the agent. Shared by the Dock, Spotlight and open_app rules and
// mirrored by the independent native refusal in native/macos/LaunchSafety.swift;
// change both together.
export const INSTALLER_PATTERN =
  /\b(?:install\w*|uninstall\w*|setup\w*|updater?|migrat\w*|boot ?camp\w*|recovery)\b/i;
export function isInstallerName(value: string | undefined): boolean {
  if (!value) return false;
  // Bundle ids join words with dots/hyphens; treat those as word breaks too.
  return (
    INSTALLER_PATTERN.test(value) ||
    INSTALLER_PATTERN.test(value.replace(/[._-]+/g, " "))
  );
}
const browsers = [
  "com.apple.Safari",
  "com.google.Chrome",
  "com.google.Chrome.canary",
  "org.mozilla.firefox",
  "com.brave.Browser",
  "com.microsoft.edgemac",
];
// Apps where Return inserts a paragraph rather than sending a message.
const documentApps = [
  "com.apple.Notes",
  "com.apple.TextEdit",
  "com.apple.iWork.Pages",
  "com.microsoft.Word",
  "com.apple.mail",
  "com.apple.Stickies",
  // IDEs are deliberately absent: their terminals and chat panels are
  // AXTextAreas where a typed newline runs or sends.
];
// Built-in surface floor that settings.protectedApps cannot remove. Mirrors
// launchFloorDenied (and its applet prefixes) in native/macos/LaunchSafety.swift;
// change both together. These apps run arbitrary code or change disks,
// credentials or the system, however they were brought to the front. Every
// terminal application (terminalAppIds in ide.ts) is part of it.
const floorProtectedApps = new Set([
  "com.apple.scripteditor2",
  "com.apple.automator",
  "com.apple.diskutility",
  "com.apple.keychainaccess",
  "com.apple.installer",
  "com.apple.migrateassistant",
  "com.apple.bootcampassistant",
]);
const floorProtectedPrefixes = [
  "com.apple.automator.",
  "com.apple.scripteditor.id.",
  ...credentialAppPrefixes,
];
function floorProtected(appId: string | undefined): boolean {
  const id = (appId ?? "").toLowerCase();
  return (
    isTerminalApp(id) ||
    floorProtectedApps.has(id) ||
    floorProtectedPrefixes.some((prefix) => id.startsWith(prefix))
  );
}
// Clicking these selects, scrolls or opens a menu/panel; it does not commit a
// change. They are ALLOWed after the consequential label check.
const selectionPointerRoles = [
  "AXCell",
  "AXRow",
  "AXList",
  "AXTable",
  "AXOutline",
  "AXScrollArea",
  "AXWebArea",
  "AXTabGroup",
  "AXToolbar",
  "AXSplitGroup",
  "AXWindow",
  "AXDisclosureTriangle",
  "AXMenuButton",
  "AXPopUpButton",
  "AXTab",
  "AXMenuBarItem",
];
// Generic content: only routine when something identifies what was hit.
const contentPointerRoles = ["AXGroup", "AXImage", "AXStaticText", "AXHeading"];
// Activating these can commit anything, in any language. Only an anchored
// allow-list of benign labels runs without approval.
const activatableRoles = [
  "AXButton",
  "AXMenuItem",
  "AXCheckBox",
  "AXRadioButton",
];
const benignControlLabels = new Set([
  "ok",
  "cancel",
  "close",
  "done",
  "back",
  "forward",
  "next",
  "previous",
  "skip",
  "skip ad",
  "skip ads",
  "not now",
  "later",
  "maybe later",
  "dismiss",
  "got it",
  "open",
  "show",
  "hide",
  "show more",
  "show less",
  "more",
  "less",
  "expand",
  "collapse",
  "view",
  "edit",
  "search",
  "find",
  "filter",
  "sort",
  "refresh",
  "reload",
  "reply",
  "reply all",
  "compose",
  "new message",
  // Notes' compose button ("New Note" is covered by the prefix below).
  "create a note",
  "create a new note",
  "settings",
  "preferences",
  "options",
  "more options",
  "menu",
  "help",
  "info",
  "details",
  // A review step looks before anything commits (a booking form's Review, a
  // checkout's Review page); the step that commits carries its own word
  // (Confirm, Submit, Order), and the consequential check runs before this
  // list, so a label joining the two still asks (cycle 20260919-0739-d495598).
  "review",
  "general",
  "play",
  "pause",
  "play video",
  "pause video",
  "mute",
  "unmute",
  "full screen",
  "exit full screen",
  "minimize",
  "zoom",
  "zoom in",
  "zoom out",
  "go back",
  "go forward",
  "home",
  "today",
  "day",
  "week",
  "month",
  "year",
  "list",
  "grid",
  "icons",
  "columns",
  "gallery",
  "sidebar",
  "show sidebar",
  "hide sidebar",
  "toggle sidebar",
  "undo",
  "redo",
  "bold",
  "italic",
  "underline",
  // A review or preview only shows what was entered; Apply commits the
  // values already on screen, which setting them back and applying again
  // undoes; a draft kept is a draft; a basket is emptied as easily as it is
  // filled (cycle 20260919-0739: the market pages' forms, every one of which
  // asked and was declined in the default mode).
  "review",
  "preview",
  "apply",
  "keep draft",
  "add to basket",
  "add to cart",
  "add to bag",
]);
const benignControlPrefix = /^(?:new|show|hide|view|sort by|go to|open)\b/;
/**
 * A button on a web page whose whole name is a short code: a seat (12A), a
 * day or year in a date picker (17, 2026), a page number. Pressing one picks
 * or navigates; what commits the pick is a button with a name of its own.
 * Only inside a page: a native digit key may be a keypad (Calculator has its
 * own rule; a dial pad asks as before).
 */
const webCodeLabel = /^\d{1,4}[a-z]?$/;
/** Lowercase, trim, and drop trailing ellipses, colons and keyboard hints. */
const calculatorKey =
  /^(?:[0-9]|[+\-−×÷*/=.,%]|\+\/[-−]|all clear|clear|ac|c|add|subtract|multiply|divide|equals|percent|negate|decimal(?: point)?|point|change sign|sin|cos|tan|sinh|cosh|tanh|log|ln|x²|x³|√|π|e|rad|deg|mc|m\+|m-|mr|\(|\))$/;
const searchResultHost =
  /^(?:(?:www\.)?google\.[a-z]{2,3}(?:\.[a-z]{2})?|(?:www\.)?bing\.com|duckduckgo\.com|search\.brave\.com|www\.ecosia\.org|search\.yahoo\.com)$/;
export function normalizeControlLabel(value: string): string {
  let label = value.trim().toLowerCase().replace(/\s+/g, " "),
    previous = "";
  while (label !== previous) {
    previous = label;
    label = label
      .replace(/\s*\([^()]{1,12}\)$/, "")
      .replace(/(?:\.{3}|…|:)$/, "")
      .trim();
  }
  return label;
}
function benignControl(role: string, label: string): boolean {
  const normalized = normalizeControlLabel(label);
  return (
    benignControlLabels.has(normalized) ||
    (["AXButton", "AXMenuItem"].includes(role) &&
      benignControlPrefix.test(normalized))
  );
}
/**
 * A blind surface: the frontmost application publishes no usable accessibility
 * information (a Chromium/CEF window such as Spotify). The native helper only
 * reports "none" when Accessibility is trusted, a frontmost window of a
 * non-trivial size exists and a completed walk found no actionable element, no
 * usable focused element and no hit-test target. There, retrying an
 * unidentified target can never succeed, so the user is asked to approve one
 * action instead of being handed the whole task. Secure input and protected
 * applications are stopped before this is ever consulted.
 */
function blindSurface(surface: Surface): boolean {
  return (
    !surface.unknown && !surface.secureInput && surface.accessibility === "none"
  );
}
/** Focused roles text is typed into; a secure field is refused before them. */
const editableRoles = ["AXTextField", "AXTextArea", "AXComboBox"];
/**
 * Whether a known, non-secure text field has the focus: what a dictation
 * ("type hello world") is typed into without a model call (src/core/runner.ts).
 * Secure input or a secure field, a terminal's input and an unidentified
 * surface never count, so the words go to the normal run and its refusals.
 */
export function focusedTextField(surface: Surface): boolean {
  return (
    !surface.unknown &&
    !surface.secureInput &&
    !surface.terminalFocus &&
    surface.focusedSubrole !== "AXSecureTextField" &&
    editableRoles.includes(surface.focusedRole ?? "")
  );
}
/** The application name an approval question names, never a bundle id. */
function appLabel(surface: Surface): string {
  const name = quote((surface.appName ?? "").trim());
  if (name) return name;
  const tail = surface.appId.split(".").filter(Boolean).pop() ?? "";
  return quote(tail) || "this app";
}
/**
 * Refusals that still apply when nothing on screen can be identified. Blind or
 * not, the agent never operates an installer, uninstaller or updater.
 */
function blindRefusal(surface: Surface): Decision | undefined {
  if (isInstallerName(surface.appId) || isInstallerName(surface.appName))
    return {
      kind: "DENY",
      reason:
        "Installer, uninstaller and updater windows require manual operation. Return to the requested task, or ask the user with request_user.",
    };
  return undefined;
}
// A focus that names nothing a person could type into: the window, the page,
// an unnamed container, or no focused element at all.
const unidentifiedFocusRoles = [
  "",
  "AXWindow",
  "AXApplication",
  "AXUnknown",
  "AXGroup",
  "AXWebArea",
  "AXScrollArea",
];
const chord = (keys: readonly string[]) => [...keys].sort().join("+");
const arrows = ["UP", "DOWN", "LEFT", "RIGHT"];
const routineShortcuts = new Set(
  [
    ["CMD", "W"],
    ["CMD", "T"],
    ["CMD", "SHIFT", "T"],
    ["CMD", "Z"],
    ["CMD", "SHIFT", "Z"],
    ["CMD", "N"],
    ["CMD", "S"],
    ["CMD", "M"],
    ["CMD", "H"],
    ["CMD", "O"],
    ["CMD", "P"],
    ["CTRL", "TAB"],
    ["CTRL", "SHIFT", "TAB"],
    ["CMD", "ALT", "LEFT"],
    ["CMD", "ALT", "RIGHT"],
    ..."123456789".split("").map((n) => ["CMD", n]),
    ...[
      ["CMD"],
      ["ALT"],
      ["SHIFT"],
      ["CMD", "SHIFT"],
      ["ALT", "SHIFT"],
    ].flatMap((mods) => arrows.map((arrow) => [...mods, arrow])),
  ].map(chord),
);
// In a blind application the only routes left are its own shortcuts and its
// menu bar. These chords open an application's search or command palette
// (Spotify's CMD+K and CMD+L); they carry no send or delete meaning, and
// chords containing Enter, Backspace or Delete are gated before this.
const blindSearchShortcuts = new Set([
  chord(["CMD", "K"]),
  chord(["CMD", "L"]),
]);
const navigationKeys = [
  "UP",
  "DOWN",
  "LEFT",
  "RIGHT",
  "HOME",
  "END",
  "PAGEUP",
  "PAGEDOWN",
  "TAB",
];
export const consequential =
  /\b(send|publish|pay|buy|purchase|transfer|delete|remove|uninstall|submit|invite|share|approve|confirm|authorize|upload|install|password|security|order|checkout|continue to checkout|subscribe|unsubscribe|donate|sign|trash|erase|reset|archive|discard|empty|format|revoke|deactivate|disable|withdraw|deposit|bid|call|dial|accept|agree|logout|log out|sign out|restart|shut down|force quit|replace|overwrite|don['’]?t save|turn off|repost|retweet|comment|connect|decline|bin|move to bin|cancel subscription|cancel membership|save|like|dislike|join|block)\b/;
/**
 * The consequential steps that always ask, whatever the user set: money
 * leaving, something going out under the user's name, data or software
 * disappearing, and account or security settings. No autonomy setting and
 * no standing allowance reaches these, because a wrong one cannot be taken
 * back by pressing undo.
 */
export const irreversible =
  /\b(send|publish|post|repost|retweet|pay|buy|purchase|transfer|order|checkout|continue to checkout|donate|withdraw|deposit|bid|subscribe|unsubscribe|cancel subscription|cancel membership|delete|remove|trash|erase|empty|bin|move to bin|format|reset|uninstall|install|revoke|password|security|invite|share|upload|call|dial|authorize|logout|log out|sign out|sign|agree|accept|approve|confirm)\b/;
/**
 * Steps a person undoes without thinking: saving, liking, archiving mail,
 * joining a call. They ask in "ask" mode and in a run the user's own words
 * did not describe; otherwise they run and are reported afterwards.
 */
const reversible =
  /\b(save|like|dislike|archive|join|connect|comment|decline|block|disable|deactivate|turn off|replace|overwrite|don['’]?t save|discard|restart|shut down|force quit|submit)\b/;
/**
 * A consequential step, as the user's autonomy setting has it. In "ask" it
 * always asks, as before. A step that can be undone runs when the user's
 * own words asked for it ("task") or whatever they said ("flow"), and the
 * run reports it instead. In "all", chosen and acknowledged in Settings,
 * the steps that cannot be undone stop asking too; that setting removes the
 * asking only, never a refusal (protected apps and websites, credential
 * fields, secrets in typed text), and every step is still reported.
 */
function consequentialDecision(
  title: string,
  settings: Settings,
  context: PolicyContext,
): Decision {
  const asks: Decision = {
    kind: "CONFIRM",
    reason: consequentialReason(title),
  };
  if (settings.autonomy === "all" && settings.autonomyAllAcknowledged)
    return {
      kind: "ALLOW",
      reason: `${quote(title)}: done without asking, as you set. Reported when done.`,
    };
  if (settings.autonomy === "ask" || !reversibleLabel(title)) return asks;
  if (settings.autonomy === "flow")
    return {
      kind: "ALLOW",
      reason: `${quote(title)} can be undone: done without asking, and reported.`,
    };
  return askedForLabel(title, context.userWords)
    ? {
        kind: "ALLOW",
        reason: `${quote(title)} is what you asked for and can be undone: reported, not asked.`,
      }
    : asks;
}
/** Whether a label's consequence can be undone (nothing irreversible in it). */
export function reversibleLabel(text: string): boolean {
  const label = text.toLowerCase();
  return !irreversible.test(label) && reversible.test(label);
}
/**
 * Whether the user's own words for this run already asked for this step:
 * "save the draft" authorises the Save sheet it leads to. Only the user's
 * own words count (never a rewrite, a proposal or a wake-up run), and only
 * for a step that can be undone.
 */
export function askedForLabel(
  label: string,
  userWords: string | undefined,
): boolean {
  if (!userWords || !reversibleLabel(label)) return false;
  const said = userWords.toLowerCase();
  const matches = label.toLowerCase().match(new RegExp(reversible, "g")) ?? [];
  return matches.some((word) => said.includes(word));
}
/**
 * Words any label shares with any request; on their own they name nothing.
 * "on" is here as the preposition it nearly always is ("on the home panel"),
 * so an On toggle is never named by it; "off" stays, since nobody says it
 * but to mean the state.
 */
const controlStopWords = new Set(
  "a an the to of for and or in on at by with from as is it its this that these those my me your you i we our be do".split(
    " ",
  ),
);
/**
 * Toggles that grant access: the words the user said do not make them
 * routine, because what they let in is not undone by pressing again. The
 * consequential pattern gates Accept, Agree, Authorize and Security before
 * this; these are the rest, and they keep their question as before.
 */
const grantsAccess =
  /\b(?:allow|grant|permit|trust|log ?in|login|log ?on|logon|continue|verify|enable)\b/;
/** The words of a label or a request, with "wi-fi" also as "wifi" and "wi", "fi". */
function controlWords(text: string): Set<string> {
  const found = new Set<string>();
  for (const [word] of text
    .toLowerCase()
    .matchAll(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)) {
    if (controlStopWords.has(word)) continue;
    found.add(word);
    if (/['’-]/.test(word)) {
      found.add(word.replace(/['’-]/g, ""));
      for (const part of word.split(/['’-]/))
        if (!controlStopWords.has(part)) found.add(part);
    }
  }
  return found;
}
/**
 * Whether the user's own words name the state an identified toggle (a
 * checkbox or radio) sets, when its label carries no consequential word:
 * "turn the hallway light off" names the Off radio, "turn off wi-fi" the
 * Wi-Fi checkbox. A toggle is what role alone makes undoable (press it again),
 * the way the reversible pattern makes Save undoable for askedForLabel, so
 * the same "task" promise applies: the state the words asked for is set and
 * reported instead of asked. It is never applied to a button: a button's
 * label may be a commit verb the pattern does not know ("Book now", "Check
 * out", "Senden"), and a word the request shares with it ("find me a book")
 * proves nothing; for those the anchored allow-list and its `Click “…”?`
 * question stand. Only the user's own words count, never a rewrite, a
 * proposal or a wake-up run; a word both share that names nothing ("to",
 * "on") is not a match; and a toggle that grants access keeps asking.
 * Cycle 20260919-0739: the panel's Off radios asked "Change this setting?"
 * in the default mode, and the run that was declined there handed off.
 */
export function askedForControl(
  label: string,
  userWords: string | undefined,
): boolean {
  if (!userWords) return false;
  const normalized = normalizeControlLabel(label);
  if (grantsAccess.test(normalized)) return false;
  const said = controlWords(userWords);
  const named = controlWords(normalized);
  return named.size > 0 && [...named].some((word) => said.has(word));
}
function consequentialReason(text: string): string {
  const has = (pattern: RegExp) => pattern.test(text);
  if (has(/\bsend\b/)) return "Send this message?";
  if (has(/\bdon['’]?t save\b/)) return "Discard unsaved changes?";
  if (has(/\b(replace|overwrite)\b/)) return "Replace the existing item?";
  if (has(/\b(cancel subscription|cancel membership)\b/))
    return "Change this subscription?";
  if (has(/\b(call|dial)\b/)) return "Call this contact?";
  if (has(/\b(order|checkout)\b/)) return "Place this order?";
  if (has(/\b(delete|remove|trash|erase|discard|empty|bin)\b/))
    return "Delete this item?";
  if (has(/\b(pay|buy|purchase|transfer|donate|withdraw|deposit|bid)\b/))
    return "Approve this transaction?";
  if (has(/\b(post|publish|repost|retweet)\b/)) return "Publish this post?";
  if (has(/\bcomment\b/)) return "Publish this comment?";
  if (has(/\b(share|upload)\b/)) return "Share or upload this item?";
  if (has(/\b(password|security)\b/))
    return "Change these account or security settings?";
  if (has(/\binstall\b/)) return "Install this software?";
  if (has(/\b(invite|connect)\b/)) return "Send this invitation?";
  if (has(/\bdecline\b/)) return "Decline this invitation?";
  if (has(/\b(unsubscribe|subscribe)\b/)) return "Change this subscription?";
  if (has(/\b(logout|log out|sign out)\b/)) return "Sign out of this account?";
  if (has(/\b(restart|shut down|force quit)\b/))
    return "Restart, shut down or force quit?";
  if (has(/\b(accept|agree|sign)\b/)) return "Accept or sign this?";
  if (has(/\barchive\b/)) return "Archive this item?";
  if (has(/\b(reset|format)\b/)) return "Reset or erase this?";
  if (has(/\b(revoke|deactivate|disable|turn off)\b/))
    return "Disable or revoke this?";
  if (has(/\bsave\b/)) return "Save these changes?";
  return "Submit or authorize this change?";
}
// Screen-derived strings echoed back to the model stay short and single-line.
function quote(value: string): string {
  const clean = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/"/g, "'")
    .trim();
  return clean.length > 60 ? clean.slice(0, 59) + "…" : clean;
}
const launcherQualifiers = new Set([
  "google",
  "apple",
  "microsoft",
  "mozilla",
  "adobe",
  "visual",
  "studio",
  "the",
  "app",
  // "Settings" must reach "System Settings" the same way "Chrome" reaches
  // "Google Chrome".
  "system",
]);
/**
 * An application name as native resolution compares it (normalizeAppName in
 * native/macos/LaunchSafety.swift): trimmed, lowercase, without a trailing
 * ".app", inner whitespace collapsed. "Chrome" and "Google Chrome" differ.
 */
export function normalizeAppName(value: string): string {
  let name = value.trim().toLowerCase();
  if (name.endsWith(".app")) name = name.slice(0, -4).trim();
  return name.split(/\s+/).filter(Boolean).join(" ");
}
function launcherTokens(value: string): string[] {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.app$/, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}
/**
 * Whether a Spotlight selection is the application the query names: exact
 * (case, spacing, ".app" insensitive) or equal after dropping vendor/qualifier
 * words and version numbers ("Chrome" -> "Google Chrome", "Code" -> "Visual
 * Studio Code"). Extra product words ("Chrome Remote Desktop Host") never match.
 */
export function launcherMatches(query: string, selected: string): boolean {
  const q = launcherTokens(query),
    s = launcherTokens(selected);
  if (!q.length || !s.length) return false;
  if (q.join(" ") === s.join(" ")) return true;
  const core = (tokens: string[]) =>
    tokens
      .filter((t) => !launcherQualifiers.has(t) && !/^\d+$/.test(t))
      .join(" ");
  const cq = core(q);
  return cq !== "" && cq === core(s);
}
export function surfacePolicy(surface: Surface, settings: Settings): Decision {
  if (/uninstall/i.test(surface.appId))
    return {
      kind: "USER_TAKEOVER",
      reason:
        "An uninstaller opened. Input stopped; close it manually before continuing.",
    };
  if (floorProtected(surface.appId))
    return {
      kind: "USER_TAKEOVER",
      reason:
        "A protected application is active. Switch to a permitted application to resume.",
    };
  if (surface.secureInput)
    return {
      kind: "USER_TAKEOVER",
      reason:
        "Sensitive input is active. Capture is suspended until you resume.",
    };
  if (
    settings.protectedApps.some((a) =>
      surface.appId.toLowerCase().includes(a.toLowerCase()),
    )
  )
    return {
      kind: "USER_TAKEOVER",
      reason:
        "A protected application is active. Switch to a permitted application to resume.",
    };
  if (surface.domain && protectedHost(surface.domain, settings))
    return {
      kind: "USER_TAKEOVER",
      reason: "A protected website is active. Please take over.",
    };
  // The rule above reads the page's address; a browser page whose address
  // the helper could not read is not taken for safe. While any website is
  // protected the run hands off before a capture, as on the protected site
  // itself (the rule a watch already applies: watchDomainRefused in
  // native/macos/IdeSafety.swift); with nothing protected there is nothing
  // the address could have matched, so the page is worked like any other.
  // The helper sets the flag only for a web area that publishes no URL, never
  // for a start page, a blank window or a local file, and only in a browser.
  // Live 2026-09-19: Safari reported no host on any page (the helper's walk
  // skipped the tab group its web area sits under), so this floor never fired
  // there and nothing said so; the surface now says so and the run stops.
  if (
    surface.hostUnknown &&
    !surface.domain &&
    browsers.includes(surface.appId) &&
    settings.protectedDomains.length > 0
  )
    return { kind: "USER_TAKEOVER", reason: UNREADABLE_PAGE_TAKEOVER };
  return { kind: "ALLOW", reason: "" };
}
/** The hand-off for a browser page whose address could not be read. */
export const UNREADABLE_PAGE_TAKEOVER =
  "This page's address could not be read, so it cannot be told from a protected website. Please take over.";
function verifiedFolder(targetURL: string | undefined): boolean {
  if (!targetURL) return false;
  let url: URL;
  try {
    url = new URL(targetURL);
  } catch {
    return false;
  }
  // Bundles (".app/", ".workflow/", ...) are directories that run.
  return (
    url.protocol === "file:" &&
    url.pathname.endsWith("/") &&
    !/\.[A-Za-z0-9-]{1,15}\/$/.test(url.pathname)
  );
}
function protectedHost(host: string, settings: Settings): boolean {
  const h = host.toLowerCase();
  return settings.protectedDomains.some((d) => {
    const domain = d.toLowerCase();
    return h === domain || h.endsWith("." + domain);
  });
}
function openAppDecision(
  action: Extract<Action, { type: "open_app" }>,
  surface: Surface,
  settings: Settings,
  synthetic: boolean,
): Decision {
  if (synthetic)
    return {
      kind: "RETRY",
      reason: "The tutorial has no applications to open.",
    };
  if (surface.unknown)
    return {
      kind: "RETRY",
      reason:
        "No input was sent. Accessibility is not trusted, so applications cannot be opened.",
    };
  const status = surface.launcherStatus;
  if (
    status === "refused" ||
    isInstallerName(action.name) ||
    isInstallerName(surface.launcherName) ||
    isInstallerName(surface.launcherAppId)
  )
    return {
      kind: "DENY",
      reason:
        // Native resolution folds protected apps (settings.protectedApps) into
        // "refused", so this reason must also cover them.
        "That application cannot be opened by the assistant: installers, uninstallers, system utilities and protected apps require manual operation. If the task needs it, ask the user with request_user.",
    };
  const candidates = (surface.launcherCandidates ?? [])
    .slice(0, 5)
    .map(quote)
    .filter(Boolean)
    .join(", ");
  if (status === "resolved" && surface.launcherAppId) {
    const frontmost = surface.launcherAppId === surface.appId;
    // Already frontmost: launching again changes nothing and the model would
    // repeat it. Say so instead of spending a step (live: Spotify, 12 times).
    // Unless it shows no window at all (live: Calendar): then nothing on
    // screen is its, and open_app is what shows its main window natively.
    if (frontmost && surface.windowCount !== 0)
      return {
        kind: "RETRY",
        reason: `No input was sent. ${quote(action.name)} is already open and frontmost. Work with what is on screen, or use a keyboard shortcut.`,
      };
    // DENY, not USER_TAKEOVER: the protected app is not active yet, and the
    // denial counter stops an injected request from looping.
    if (
      surfacePolicy({ ...surface, appId: surface.launcherAppId }, settings)
        .kind !== "ALLOW"
    )
      return {
        kind: "DENY",
        reason:
          "That application is protected. Ask the user to open it with request_user.",
      };
    return frontmost
      ? {
          kind: "ALLOW",
          reason: "Show the main window of an application open with no window.",
        }
      : { kind: "ALLOW", reason: "Open a verified installed application." };
  }
  if (status === "ambiguous")
    return {
      kind: "RETRY",
      reason: `More than one installed application matches.${candidates ? ` Candidates: ${candidates}.` : ""} Use the exact name.`,
    };
  return {
    kind: "RETRY",
    reason: `No input was sent. No installed application matches "${quote(action.name)}" exactly.${candidates ? ` Candidates: ${candidates}.` : ""} Use one of them, or request_user if it is not installed.`,
  };
}
/** The refusal for a web address on a protected host: a floor, never a question. */
export const PROTECTED_SITE_REFUSAL =
  "That website is protected. Ask the user to open it with request_user.";
/**
 * open_url loads an address in the browser without typing or clicking, so
 * the only thing to judge is where it goes: the host, against the protected
 * websites, refused outright as the page in front would be (surfacePolicy)
 * and never asked about, whatever the autonomy setting. Nothing else about
 * the address is read; the schema already requires http or https with no
 * credentials.
 */
function openUrlDecision(
  action: Extract<Action, { type: "open_url" }>,
  settings: Settings,
  synthetic: boolean,
): Decision {
  if (synthetic)
    return { kind: "RETRY", reason: "The tutorial has no websites to open." };
  const url = webAddress(action.url);
  if (!url)
    return {
      kind: "RETRY",
      reason:
        "No input was sent. Use a full http or https address without credentials.",
    };
  if (protectedHost(url.hostname, settings))
    return { kind: "DENY", reason: PROTECTED_SITE_REFUSAL };
  return { kind: "ALLOW", reason: "Load a web address in the browser." };
}
/** Lowercase words, so a name can be found as a whole-word run in a sentence. */
function words(text: string): string {
  return ` ${text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()} `;
}
/** Spoken names for applications whose Applications-folder name nobody says. */
const appAliases: Record<string, string[]> = {
  "visual studio code": ["vs code", "vscode"],
};
/**
 * Whether the user's own words name both this folder and this application,
 * as whole words: "open rlenvforHUD1 in VS Code".
 */
function namesFolderAndApp(
  userWords: string | undefined,
  folder: string,
  apps: (string | undefined)[],
): boolean {
  if (!userWords) return false;
  const said = words(userWords);
  const has = (name: string) => {
    const w = words(name);
    return w.trim().length >= 2 && said.includes(w);
  };
  return (
    has(folder) &&
    apps.some(
      (app) =>
        !!app &&
        (has(app) ||
          (appAliases[app.trim().toLowerCase()] ?? []).some((alias) =>
            has(alias),
          )),
    )
  );
}
function openFileDecision(
  action: Extract<Action, { type: "open_file" }>,
  surface: Surface,
  settings: Settings,
  synthetic: boolean,
  context: PolicyContext,
): Decision {
  if (synthetic)
    return { kind: "RETRY", reason: "The tutorial has no files to open." };
  if (surface.unknown)
    return {
      kind: "RETRY",
      reason:
        "No input was sent. Accessibility is not trusted, so files cannot be opened.",
    };
  if (surface.fileStatus === "refused")
    return {
      kind: "DENY",
      reason:
        "That file cannot be opened by the assistant: apps, scripts, installers and private system files require manual operation.",
    };
  // Only a native resolution of a document or folder is allowed; a missing or
  // unexpected status or kind is treated as unresolved.
  const resolvedFile =
    surface.fileStatus === "resolved" &&
    (surface.fileKind === "document" || surface.fileKind === "folder");
  const unresolvedFile: Decision = {
    kind: "RETRY",
    reason:
      "No input was sent. That path is not in the local index. Use a path listed in context.memory.files or folders, or request_user.",
  };
  if (action.app !== undefined) {
    // The application is resolved natively through the open_app allow-list
    // and reported in the same launcher fields, so it is judged like a
    // launch: DENY when refused, an installer or a protected app, RETRY until
    // exactly one permitted application matches. Without `app` those fields
    // are not consulted at all.
    const status = surface.launcherStatus;
    if (
      status === "refused" ||
      isInstallerName(action.app) ||
      isInstallerName(surface.launcherName) ||
      isInstallerName(surface.launcherAppId)
    )
      return {
        kind: "DENY",
        reason:
          "That application cannot open it: terminals, installers, system utilities and protected apps stay manual. Open the item with open_file alone, or ask the user with request_user.",
      };
    if (status === "resolved" && surface.launcherAppId) {
      if (
        surfacePolicy({ ...surface, appId: surface.launcherAppId }, settings)
          .kind !== "ALLOW"
      )
        return {
          kind: "DENY",
          reason:
            "That application is protected. Open the item with open_file alone, or ask the user with request_user.",
        };
      if (!resolvedFile) return unresolvedFile;
      // A folder opens in Finder unless the user asked for more. In any other
      // application it opens as a project, and a code editor may run the
      // project's own tasks as it opens (a tasks.json task set to run on
      // folderOpen; Cursor trusts every workspace by default): screen text
      // saying "open this folder in Cursor" would be one step from running a
      // stranger's code. So the user names both, or approves it.
      const folder =
        surface.fileName ?? action.path.replace(/\/+$/, "").split("/").pop();
      const app = surface.launcherName ?? action.app;
      if (
        surface.fileKind === "folder" &&
        surface.launcherAppId.toLowerCase() !== "com.apple.finder" &&
        !namesFolderAndApp(context.userWords, folder ?? "", [
          action.app,
          surface.launcherName,
        ])
      )
        return {
          kind: "CONFIRM",
          reason: `Open the folder “${quote(folder ?? "")}” in ${quote(app)}? An editor can run a project's own tasks when it opens its folder.`,
        };
      return {
        kind: "ALLOW",
        reason: `Open a document or folder from the local index in "${quote(app)}".`,
      };
    }
    const candidates = (surface.launcherCandidates ?? [])
      .slice(0, 5)
      .map(quote)
      .filter(Boolean)
      .join(", ");
    return {
      kind: "RETRY",
      reason:
        status === "ambiguous"
          ? `More than one installed application matches.${candidates ? ` Candidates: ${candidates}.` : ""} Use the exact name.`
          : `No input was sent. No installed application matches "${quote(action.app)}" exactly.${candidates ? ` Candidates: ${candidates}.` : ""} Use one of them, or open the item with open_file alone.`,
    };
  }
  if (resolvedFile)
    return {
      kind: "ALLOW",
      reason: "Open a document or folder from the local index.",
    };
  return unresolvedFile;
}
const IDE_TERMINAL_REFUSAL =
  "Terminals, tasks, builds and run or debug commands are left to the user: a terminal runs whatever is typed next. Finish the task another way, or ask the user with request_user.";
/**
 * ENTER in the application's own command palette runs whichever command the
 * palette selected, and in VS Code and its forks every quick-open box turns
 * into that palette with ">" or a "task "/"term " prefix. VS Code runs the
 * selected entry on CMD+, ALT+ and CTRL+ENTER as well. What the agent typed
 * since the command (Surface.searchQuery, recorded natively) decides:
 * terminal, task, run and debug commands are refused, even after an arrow key
 * or an edit since, and opening a coding agent's own input is routine in those
 * editors. Anything else is the user's call, but only while the palette's
 * choice can be named: with nothing typed, the selection moved off the top
 * match or the text edited since, ENTER is retried instead of asking the user
 * to approve a command nobody can name. Plain find and search boxes, and a
 * file or symbol name, keep the search rules.
 */
function paletteEnterDecision(
  action: Action,
  surface: Surface,
): Decision | undefined {
  const chordEnter = action.type === "hotkey" && action.keys.includes("ENTER");
  if (
    surface.unknown ||
    !surface.searchOpenedBy ||
    !(chordEnter || (action.type === "key" && action.key === "ENTER"))
  )
    return undefined;
  const opener = surface.searchOpenedBy;
  const ide = !!ideFamily(surface.appId);
  const palette = paletteTitle(opener);
  // A helper that recorded no text leaves nothing exact to go on.
  const query = surface.searchQuery ?? "";
  const edited =
    surface.searchQueryState === "edited" || surface.searchQuery === undefined;
  const runsCommand =
    palette ||
    (ide &&
      quickOpenTitle(opener) &&
      // An edit could have added or removed the box's ">" or "task " prefix.
      (edited || quickOpenRunsCommand(query)));
  if (!runsCommand) return undefined;
  const kind = paletteClass(query);
  if (kind === "refused") return { kind: "DENY", reason: IDE_TERMINAL_REFUSAL };
  const where = `${appLabel(surface)}’s ${palette ? "command palette" : quote(opener)}`;
  const shown = quote(query.replace(/^[>\s]+/, ""));
  if (edited)
    return {
      kind: "RETRY",
      reason: `No input was sent. The text in ${where} was edited after it was typed, so what ENTER would open or run there cannot be named. Press ESC, open it again and type the whole ${palette ? "command" : "query"}, then press ENTER.`,
    };
  if (!shown)
    return {
      kind: "RETRY",
      reason: `No input was sent. Nothing is typed in ${where}, so ENTER would run whichever command it lists first (often the one used last). Type the command's name first.`,
    };
  if (surface.searchQueryState === "moved")
    return {
      kind: "RETRY",
      reason: `No input was sent. An arrow key moved the selection in ${where} off the top match for “${shown}”, so what ENTER would run cannot be named. Type more of the command's name so it comes first, then press ENTER.`,
    };
  if (kind === "agent_focus" && ide && !surface.modal && !chordEnter)
    return {
      kind: "ALLOW",
      reason: "Open the coding agent's input from the command palette.",
    };
  // The palette matches loosely and runs its top match, which the policy
  // cannot read: the question says so rather than promising the typed text.
  return {
    kind: "CONFIRM",
    reason: `Run the top match for “${shown}” in ${where}? It may not be exactly that command.`,
  };
}
// Controls that run what they name when clicked or pressed.
const ideCommandControlRoles = [
  "AXButton",
  "AXMenuItem",
  "AXMenuButton",
  "AXPopUpButton",
  "AXLink",
];
/**
 * A control in VS Code or a fork that opens its terminal or the panel holding
 * it, or runs a file, a task, a build or the debugger: the editor's Run and
 * Debug buttons, a CodeLens "Run Test", a context menu's "Open in Integrated
 * Terminal", a chat's "Run in Terminal". The same titles its menus and
 * shortcuts are refused for. Only the control's own label counts, so a file
 * or tab named build.gradle is not one.
 */
function ideRunControl(
  appId: string | undefined,
  role: string | undefined,
  label: string | undefined,
): boolean {
  return (
    !!ideFamily(appId) &&
    ideCommandControlRoles.includes(role ?? "") &&
    ideCommandTitleRefused(normalizeControlLabel(label ?? ""))
  );
}
/**
 * ENTER (or an editing key) in VS Code or a fork when no command the agent
 * just ran says what has focus. The editors keep their tree hidden, so an
 * unidentified focus may be the integrated terminal, where UP has recalled the
 * last shell line, or a palette whose context lapsed (after 45 s, a pointer
 * action or an unrelated shortcut such as CMD+A) or that the user opened. With
 * the tree exposed the palette is an identified search field instead. ENTER
 * there runs whatever line or command is selected, so it is retried rather
 * than approved blind; reopening the box with the editor's own command makes
 * it known again.
 */
function ideUnverifiedKey(
  action: Action,
  surface: Surface,
  editable: boolean,
): Decision | undefined {
  if (surface.unknown || surface.searchOpenedBy || !ideFamily(surface.appId))
    return undefined;
  const enter =
    (action.type === "key" && action.key === "ENTER") ||
    (action.type === "hotkey" && action.keys.includes("ENTER"));
  const editKey =
    action.type === "key" &&
    ["SPACE", "BACKSPACE", "DELETE"].includes(action.key);
  const app = appLabel(surface);
  if (
    (enter || editKey) &&
    !editable &&
    unidentifiedFocusRoles.includes(surface.focusedRole ?? "")
  )
    return {
      kind: "RETRY",
      reason: `No input was sent. Nothing identifies what has focus in ${app}, where this key could run a line in its terminal or a command left selected in its palette. Open the box you need with the app's own command first (CMD+P for a file, CMD+F to find), or ask the user with request_user.`,
    };
  if (
    enter &&
    editable &&
    ideQuickInputField(
      surface.focusedRole,
      surface.focusedSubrole,
      surface.focusedLabel,
    )
  )
    return {
      kind: "RETRY",
      reason: `No input was sent. This box in ${app} can run commands, and what was typed there is not known. Open it again with the app's own command (CMD+P for a file, CMD+F to find), type the query, then press ENTER.`,
    };
  return undefined;
}
/**
 * The integrated terminal (xterm.js) is a text area like any other, but every
 * line typed there and every ENTER runs as a shell command. Native reports it
 * from the focused element itself (Surface.terminalFocus). Escape, arrows and
 * Tab only move around the command line and stay allowed.
 */
function terminalInput(action: Action): boolean {
  if (action.type === "type_text") return true;
  if (action.type === "key")
    return ["ENTER", "BACKSPACE", "DELETE", "SPACE"].includes(action.key);
  if (action.type !== "hotkey") return false;
  // Control chords edit, interrupt or end the shell; Shift-Tab changes a
  // coding agent's permission mode in its terminal interface.
  return (
    action.keys.some((k) => ["ENTER", "CTRL"].includes(k)) ||
    chord(action.keys) === chord(["SHIFT", "TAB"])
  );
}
const MENU_REFUSAL =
  "Quitting an application, logging out and shutting down are left to the user. Finish the task another way.";
const CLIPBOARD_REFUSAL =
  "Clipboard access is disabled. Pasting is allowed only when the user asked for a paste and a text field is focused; copying and cutting never are.";
/** Edit > Copy, Cut, Paste and their variants ("Copy Link", "Paste and Match Style"). */
const clipboardMenuTitle = /^(?:copy|cut|paste)\b/i;
/** Edit > Undo, as applications title it ("Undo", "Undo Typing"). */
const undoMenuTitle = /^undo\b/;
export const UNDO_QUESTION = "Undo the last change?";
/**
 * Edit > Undo takes the last step back, whoever asked for it: the user's
 * spoken "undo that", or the model correcting its own step. Reversible by
 * definition, so only "ask" asks; every other setting runs and reports it.
 */
/**
 * Return, Delete, Backspace or Space on a control the rules did not place:
 * it may submit a form or change content, so it asks. In "flow" an edit that
 * can be undone (Delete, Backspace, Space) runs and is reported; Return may
 * send, so it still asks there. ("Allow everything" removes the asking in
 * withoutAsking.)
 */
function activationDecision(key: string, settings: Settings): Decision {
  if (settings.autonomy === "flow" && key !== "ENTER")
    return {
      kind: "ALLOW",
      reason: `Press ${key}: an edit that can be undone, reported.`,
    };
  return {
    kind: "CONFIRM",
    reason: "Activate this control? It may submit or change content.",
  };
}
function undoDecision(title: string, settings: Settings): Decision {
  return settings.autonomy === "ask"
    ? { kind: "CONFIRM", reason: UNDO_QUESTION }
    : {
        kind: "ALLOW",
        reason: `${quote(title)} takes the last step back: done without asking, and reported.`,
      };
}
/**
 * A menu item the frontmost application publishes, pressed by name. The native
 * helper resolved the path against the live menu bar and reported what it
 * found, so these rules judge a real item rather than the model's spelling.
 * The item's own title still goes through the consequential check: "Send" in a
 * menu sends exactly as much as "Send" on a button.
 */
function menuItemDecision(
  action: Action,
  surface: Surface,
  context: PolicyContext,
  settings: Settings,
): Decision {
  if (action.type !== "menu_item") return { kind: "ALLOW", reason: "" };
  const named = action.path.join(" > ");
  if (surface.menuStatus === "refused")
    return { kind: "DENY", reason: MENU_REFUSAL };
  // The clipboard rules hold whichever way the command is reached. A menu item
  // is pressed without the focused-field check keys get, so even the paste the
  // user asked for goes as CMD+V, which lands only in the field it was checked on.
  const item = normalizeControlLabel(
    surface.menuLabel ?? action.path[action.path.length - 1],
  );
  if (
    [...action.path, item].some((t) =>
      clipboardMenuTitle.test(normalizeControlLabel(t)),
    )
  )
    return context.pasteRequested && item === "paste"
      ? {
          kind: "RETRY",
          reason:
            "No input was sent. Paste with CMD+V into the focused text field instead of the menu item.",
        }
      : { kind: "DENY", reason: CLIPBOARD_REFUSAL };
  // In VS Code and its forks these open the integrated terminal (or the panel
  // that holds it) or run a task, a build or the debugger: a shell reached
  // through the menus. Refused before the enabled checks, so a greyed-out one
  // is never a reason to go and enable it. The resolved title is checked too:
  // a path may name only the start of an item ("Toggle" for "Toggle Terminal").
  if (
    ideFamily(surface.appId) &&
    (ideMenuRefused(action.path) ||
      ideCommandTitleRefused(surface.menuLabel ?? ""))
  )
    return { kind: "DENY", reason: IDE_TERMINAL_REFUSAL };
  if (surface.menuStatus === "missing")
    return {
      kind: "RETRY",
      reason: `No input was sent. ${quote(named)} is not in this application's menus. Choose an item from context.menus, or take another route.`,
    };
  if (surface.menuStatus === "disabled")
    return {
      kind: "RETRY",
      reason: `No input was sent. ${quote(named)} is greyed out right now. Do the step that enables it first (open a window, select something), or take another route.`,
    };
  if (surface.menuStatus !== "resolved")
    return {
      kind: "RETRY",
      reason:
        "No input was sent. This application's menus could not be read. Use a shortcut from context.menus or a visible control.",
    };
  const title = normalizeControlLabel(
    surface.menuLabel ?? action.path[action.path.length - 1],
  );
  if (undoMenuTitle.test(title)) return undoDecision(title, settings);
  if (consequential.test(title))
    return consequentialDecision(title, settings, context);
  return {
    kind: "ALLOW",
    reason: "Choose a menu item this application publishes.",
  };
}
/**
 * A control named from context.controls. Resolution happened natively against
 * the tree as it is now, and the resolved position went through the same
 * pointer hit test as a click, so every rule below this point sees the same
 * evidence it would for a click on that control.
 */
function namedControlRefusal(
  action: Action,
  surface: Surface,
): Decision | undefined {
  if (action.type !== "click_control") return undefined;
  if (surface.controlStatus === "missing")
    return {
      kind: "RETRY",
      reason: `No input was sent. Nothing in context.controls is named ${quote(action.label)} now. If you can see it in the screenshot, click it by position with click(x,y) instead; otherwise take a fresh look. Do not repeat this name.`,
    };
  if (surface.controlStatus === "ambiguous")
    return {
      kind: "RETRY",
      reason: `No input was sent. Several controls are named ${quote(action.label)}. Add the x and y of the one you mean from context.controls, or name a different control.`,
    };
  if (surface.controlStatus === "disabled")
    return {
      kind: "RETRY",
      reason: `No input was sent. ${quote(action.label)} is disabled. Choose an enabled control.`,
    };
  if (surface.controlStatus !== "resolved")
    return {
      kind: "RETRY",
      reason:
        "No input was sent. That control could not be resolved. Name a control from context.controls.",
    };
  // The named control was found, but the element under its centre is
  // something else (live: a Chrome tab's centre landed in a ChatGPT window in
  // front of it). Clicking there would act on whatever covers the control.
  if (!namedTargetUnderPointer(surface))
    return {
      kind: "RETRY",
      reason: `No input was sent. ${quote(action.label)} is covered by something else right now. Bring its window to the front first, or choose another route.`,
    };
  return undefined;
}
/**
 * Whether the pointer hit test at a resolved named control's centre found that
 * control: the resolved name and the name the hit walk collected agree (equal,
 * or one starting with the other, or contained in the joined hit text). With
 * nothing named at the point there is no contrary evidence.
 */
function namedTargetUnderPointer(surface: Surface): boolean {
  const named = normalizeControlLabel(surface.controlLabel ?? "");
  const hit = normalizeControlLabel(surface.targetLabel ?? "");
  const text = normalizeControlLabel(surface.targetText ?? "");
  if (!named || (!hit && !text)) return true;
  const agrees = (a: string, b: string) =>
    !!a && !!b && (a === b || a.startsWith(b) || b.startsWith(a));
  return (
    agrees(named, hit) ||
    (!!text && text.includes(named)) ||
    agrees(named, text)
  );
}
/** What the run knows that the surface does not. */
export interface PolicyContext {
  /** The user's own words (task or corrections) asked for a paste. */
  pasteRequested?: boolean;
  /**
   * The run's objective when it is the user's own words (Run.taskSource
   * "user_words"); unset for a rewrite, a proposal or a wake-up run.
   */
  userWords?: string;
  /**
   * For a tool_call: the frozen spec of the tool it names, the tool layer's
   * validation of its arguments, and the calls this run has made. Unset
   * when the tool is not in the run's list.
   */
  tool?: { spec: ToolSpec; prepared: ToolPrepared; calls: number };
  /** The tool layer's clock, so questions and grounding read dates in the user's zone. */
  clock?: ToolClock;
  /**
   * The window the run is bound to, while it works there in the background
   * (design §4): input goes to that process alone, and the step's own target
   * must belong to it.
   */
  target?: { pid: number; appName: string };
  /**
   * The user is still speaking (.data/design/streaming-execution.md §3.3):
   * the step is a fast action on a committed clause, before the final. Only
   * going somewhere is allowed then (open_app, open_url on a non-protected
   * host, open_file of a standard folder, scroll); every other step, and any
   * step that would ask, gets RETRY with SPEAKING_RETRY. The protected
   * floors are unchanged.
   */
  speaking?: boolean;
}
/** Every step but navigation, while the user is still speaking. */
export const SPEAKING_RETRY = "Waiting for the end of the sentence.";
const knownFolderPath = (path: string) =>
  [...KNOWN_FOLDERS.values()].includes(path.replace(/\/+$/, ""));
/** What may run before the sentence ends: a place to go, nothing done there. */
export function speakingAllowed(action: Action): boolean {
  switch (action.type) {
    case "open_app":
    case "open_url":
    case "scroll":
      return true;
    case "open_file":
      return action.app === undefined && knownFolderPath(action.path);
    default:
      return false;
  }
}
/** The decision reason that marks the one clipboard press native may send. */
export const PASTE_ALLOWED = "Paste what the user copied, as asked.";
/**
 * The policy's answer for one step: the rules in decideAction, then the one
 * setting that removes asking. "Allow everything", chosen and acknowledged
 * in Settings, turns every question into a reported step and nothing else:
 * refusals stand, and so does the question before a protected website,
 * which that setting promises stays guarded. (Live 2026-09-19: Return in
 * Calendar's event field and in an editor asked under "all".)
 */
export function evaluate(
  action: Action,
  surface: Surface,
  settings: Settings,
  synthetic: boolean,
  context: PolicyContext = {},
): Decision {
  // Mid-sentence, before the rules: a step that is not navigation is not
  // judged, it waits for the final (nothing here loosens what follows).
  if (context.speaking && !speakingAllowed(action))
    return { kind: "RETRY", reason: SPEAKING_RETRY };
  const decision = decideAction(action, surface, settings, synthetic, context);
  const judged = withoutAsking(
    backgroundRefusal(action, surface, context, decision) ?? decision,
    settings,
  );
  // Nobody can be asked a question in the middle of their sentence.
  if (context.speaking && judged.kind === "CONFIRM")
    return { kind: "RETRY", reason: SPEAKING_RETRY };
  return judged;
}
/**
 * What a run bound to a background window cannot do there (design §2.5):
 * the target is the window, so nothing opens or switches applications; a
 * drag and a modifier chord the application does not publish as a menu item
 * have no background route. A denial or a hand-off keeps its own reason, so
 * this never loosens a refusal; a step the rules allowed, would ask about or
 * would retry gets the background reason instead. Only while the run is
 * bound.
 */
function backgroundRefusal(
  action: Action,
  surface: Surface,
  context: PolicyContext,
  decision: Decision,
): Decision | undefined {
  if (!context.target && !surface.target) return undefined;
  if (decision.kind === "DENY" || decision.kind === "USER_TAKEOVER")
    return undefined;
  const app = quote(context.target?.appName ?? surface.appName ?? "") || "it";
  if (
    action.type === "open_app" ||
    action.type === "open_file" ||
    action.type === "open_url"
  )
    return {
      kind: "RETRY",
      reason: `No input was sent. This run works in ${app}'s window in the background: it is already the window in the screenshot, so nothing else is opened or switched to. Work in it, or finish with done.`,
    };
  if (action.type === "drag")
    return {
      kind: "RETRY",
      reason:
        "No input was sent. Dragging has no route to a background window. Use a listed control, the menu or the keyboard, or scroll.",
    };
  if (
    action.type === "hotkey" &&
    !surface.shortcutLabel &&
    action.keys.some((k) => ["CMD", "CTRL", "ALT", "SHIFT"].includes(k))
  )
    return {
      kind: "RETRY",
      reason: `No input was sent. ${action.keys.join("+")} is not one of ${app}'s menu shortcuts, and a chord cannot be posted to a background window. Use menu_item with the command's name from context.menus, or a listed control.`,
    };
  return undefined;
}
export const PROTECTED_SITE_QUESTION = "Open a protected website?";
export function withoutAsking(
  decision: Decision,
  settings: Settings,
): Decision {
  if (decision.kind !== "CONFIRM") return decision;
  if (!(settings.autonomy === "all" && settings.autonomyAllAcknowledged))
    return decision;
  if (decision.reason === PROTECTED_SITE_QUESTION || decision.floor)
    return decision;
  const step = decision.reason.split("?")[0].trim();
  return {
    kind: "ALLOW",
    reason: `${step}: done without asking, as you set. Reported when done.`,
  };
}
function decideAction(
  action: Action,
  surface: Surface,
  settings: Settings,
  synthetic: boolean,
  context: PolicyContext = {},
): Decision {
  // On a bound window the surface's secure input is the target's (a secure
  // field focused there, or secure event input anywhere): it pauses what
  // carries text and nothing else, since a click carries none (design §4).
  // The screen's own rule is unchanged: in front, secure input pauses all.
  const carriesText = ["type_text", "key", "hotkey"].includes(action.type);
  const judged =
    context.target && surface.secureInput && !carriesText
      ? { ...surface, secureInput: false }
      : surface;
  const protectedSurface = surfacePolicy(judged, settings);
  if (protectedSurface.kind !== "ALLOW") return protectedSurface;
  if (surface.targetAppId) {
    const targetPolicy = surfacePolicy(
      { ...judged, appId: surface.targetAppId },
      settings,
    );
    if (targetPolicy.kind !== "ALLOW") return targetPolicy;
  }
  if (action.type === "request_user")
    return { kind: "USER_TAKEOVER", reason: action.reason };
  if (
    action.type === "type_text" &&
    scanText(action.text).some((f) => f.action === "BLOCK_UPLOAD")
  )
    return {
      kind: "DENY",
      reason: "Detected credentials cannot be typed by the agent.",
    };
  if (
    action.type === "hotkey" &&
    action.keys.some((k) => ["CMD", "CTRL", "ALT"].includes(k)) &&
    action.keys.some((k) => ["V", "C", "X"].includes(k))
  ) {
    // The clipboard can hold a secret the user copied a moment ago, and
    // copying screen content out is exfiltration. The one exception: when the
    // user's own words asked for a paste, Command-V alone, into an identified
    // text field, pastes what they copied. Copy and cut are never allowed.
    const pasteOnly =
      action.keys.length === 2 &&
      action.keys.includes("CMD") &&
      action.keys.includes("V");
    if (
      context.pasteRequested &&
      pasteOnly &&
      !surface.unknown &&
      editableRoles.includes(surface.focusedRole ?? "")
    )
      return { kind: "ALLOW", reason: PASTE_ALLOWED };
    return { kind: "DENY", reason: CLIPBOARD_REFUSAL };
  }
  // After the floors above: a tool call with a terminal in front is a
  // takeover like any step, and it never touches the surface otherwise.
  if (action.type === "tool_call")
    return toolDecision(action, settings, synthetic, context);
  if (["capture", "done", "fail", "wait"].includes(action.type))
    return { kind: "ALLOW", reason: "" };
  // A bound run's input goes to one process (design §4): a surface the
  // helper read from another one, or a hit target in another application,
  // is never acted on, whatever the step.
  if (
    context.target &&
    (surface.pid !== context.target.pid ||
      (surface.targetAppId !== undefined &&
        surface.targetAppId !== surface.appId))
  )
    return {
      kind: "DENY",
      reason: `No input was sent. The step's target is not the ${quote(context.target.appName)} window this run is bound to; input goes only to that window.`,
    };
  // Watching reads the frontmost window and sends nothing; the protected
  // checks above already refused a window that must not be read.
  if (action.type === "monitor")
    return {
      kind: "ALLOW",
      reason: "Watch the frontmost window without sending input.",
    };
  // Before the synthetic ALLOW: the tutorial must never launch real apps.
  if (action.type === "open_app")
    return openAppDecision(action, surface, settings, synthetic);
  if (action.type === "open_file")
    return openFileDecision(action, surface, settings, synthetic, context);
  if (action.type === "open_url")
    return openUrlDecision(action, settings, synthetic);
  if (synthetic)
    return { kind: "ALLOW", reason: "CoArena-owned tutorial surface." };
  // Only consulted where an identified target or field is missing; it never
  // relaxes a rule that applies to an application that does expose controls.
  const blind = blindSurface(surface);
  if (surface.targetEnabled === false)
    return {
      kind: "RETRY",
      reason:
        "No input was sent. The target is disabled. Choose an enabled control or an application shortcut from the fresh screenshot.",
    };
  if (action.type === "menu_item")
    return menuItemDecision(action, surface, context, settings);
  const namedRefusal = namedControlRefusal(action, surface);
  if (namedRefusal) return namedRefusal;
  if (["move", "scroll"].includes(action.type))
    return { kind: "ALLOW", reason: "Pointer navigation." };
  const editable = editableRoles.includes(surface.focusedRole ?? "");
  // Dismissal, navigation keys and these exact shortcuts do not activate the
  // focused control. Do not let a focused Send/Delete label gate them.
  if (!surface.unknown && action.type === "key" && action.key === "ESC")
    return { kind: "ALLOW", reason: "Dismiss the current menu or panel." };
  if (
    !surface.unknown &&
    action.type === "key" &&
    navigationKeys.includes(action.key)
  )
    return { kind: "ALLOW", reason: "Navigate with the keyboard." };
  if (!surface.unknown && surface.terminalFocus && terminalInput(action))
    return {
      kind: "DENY",
      reason:
        "The focus is in a terminal, where typed text and ENTER run shell commands. Terminals are left to the user: finish the task another way, or ask the user with request_user.",
    };
  // A focused Run or Debug button pressed from the keyboard is the same click.
  if (
    !surface.unknown &&
    action.type === "key" &&
    ["ENTER", "SPACE"].includes(action.key) &&
    ideRunControl(surface.appId, surface.focusedRole, surface.focusedLabel)
  )
    return { kind: "DENY", reason: IDE_TERMINAL_REFUSAL };
  // Before the field rules below: a palette's input can be an identified,
  // searchable field when the editor exposes its tree.
  const palette = paletteEnterDecision(action, surface);
  if (palette) return palette;
  const ideKey = ideUnverifiedKey(action, surface, editable);
  if (ideKey) return ideKey;
  // Calculator accepts keypad input without a focused text field. Digits,
  // operators, Enter (=) and Backspace only change the displayed calculation.
  if (
    !surface.unknown &&
    !surface.modal &&
    surface.appId === "com.apple.calculator" &&
    !editableRoles.includes(surface.focusedRole ?? "")
  ) {
    if (
      action.type === "type_text" &&
      /^[0-9+\-*/=.,%()xX×÷ ]{1,60}$/.test(action.text)
    )
      return { kind: "ALLOW", reason: "Enter a calculation." };
    if (
      action.type === "key" &&
      (/^[0-9]$/.test(action.key) ||
        ["ENTER", "BACKSPACE", "DELETE"].includes(action.key))
    )
      return { kind: "ALLOW", reason: "Enter a calculation." };
  }
  if (action.type === "hotkey") {
    const keys = chord(action.keys);
    // Native presses this chord as its menu item and never presses that one,
    // so asking the user to approve it would only lead to a refusal.
    if (surface.shortcutStatus === "refused")
      return { kind: "DENY", reason: MENU_REFUSAL };
    if (action.keys.some((k) => ["ENTER", "BACKSPACE", "DELETE"].includes(k)))
      return {
        kind: "CONFIRM",
        reason: "This shortcut may send or delete content. Allow it?",
      };
    if (surface.unknown)
      return {
        kind: "RETRY",
        reason:
          "No input was sent. The focused application could not be identified, so shortcuts are paused. Capture a fresh screenshot and switch to the requested application first.",
      };
    // A chord an editor's own menus bind to its terminal, the panel holding it,
    // a task or the debugger (Run Build Task, Toggle Panel) is that command.
    if (
      ideFamily(surface.appId) &&
      surface.shortcutLabel &&
      ideCommandTitleRefused(surface.shortcutLabel)
    )
      return { kind: "DENY", reason: IDE_TERMINAL_REFUSAL };
    if (keys === "CMD+SPACE")
      return { kind: "ALLOW", reason: "Open Spotlight." };
    // Command-Tab lands on whichever application the switcher was last on, not
    // on the one the task needs, and a run that keeps pressing it walks out of
    // the application it was working in.
    if (["CMD+TAB", "CMD+SHIFT+TAB"].includes(keys))
      return {
        kind: "RETRY",
        reason:
          "No input was sent. Command-Tab switches to whichever application came last, not the one you want. Use open_app with the application's name.",
      };
    if (keys === "CMD+F")
      return { kind: "ALLOW", reason: "Find within the current application." };
    // Before the browser-only CMD+L rule: in an application that publishes
    // nothing, its own search shortcut is the route that replaces clicking.
    if (blind && blindSearchShortcuts.has(keys))
      return {
        kind: "ALLOW",
        reason: "Open this application's own search or command palette.",
      };
    if (keys === "CMD+L")
      return browsers.includes(surface.appId)
        ? { kind: "ALLOW", reason: "Focus the browser address bar." }
        : {
            kind: "DENY",
            reason:
              "The foreground application is not a browser. First switch to the requested browser using open_app or Command-Space and its full app name, then use Command-L.",
          };
    if (keys === "CMD+Q")
      return { kind: "CONFIRM", reason: "Quit this application?" };
    // Finder opens the selection with these; opening can run a program.
    if (
      surface.appId === "com.apple.finder" &&
      ["CMD+O", "CMD+DOWN"].includes(keys)
    )
      return {
        kind: "CONFIRM",
        reason: "Open this item? It may run a program.",
      };
    // Browsers reload; Script Editor, Xcode and others run code.
    if (keys === "CMD+R")
      return browsers.includes(surface.appId)
        ? { kind: "ALLOW", reason: "Reload the page." }
        : { kind: "CONFIRM", reason: "Run or reload in this application?" };
    if (routineShortcuts.has(keys))
      return { kind: "ALLOW", reason: "Routine application shortcut." };
    // The application's own menus name this chord, so it is a published
    // command of the frontmost application rather than a guess, and the menu's
    // own title decides whether it needs approval.
    if (surface.shortcutLabel) {
      const title = normalizeControlLabel(surface.shortcutLabel);
      if (consequential.test(title))
        return consequentialDecision(title, settings, context);
      return {
        kind: "ALLOW",
        reason: `This application's own shortcut for ${quote(surface.shortcutLabel)}.`,
      };
    }
    if (editable && ["A+CMD", "B+CMD", "CMD+I", "CMD+U"].includes(keys))
      return {
        kind: "ALLOW",
        reason: "Select or format text in a known field.",
      };
    return {
      kind: "RETRY",
      reason: `No input was sent. ${action.keys.join("+")} is not a routine shortcut in this context. Use a visible control, a menu item, or a common shortcut such as CMD+W, CMD+T, CTRL+TAB or CMD+A in a focused text field.`,
    };
  }
  const leftClick =
    action.type === "click_control" ||
    ((action.type === "click" || action.type === "double_click") &&
      action.button === "left");
  const rightClick =
    action.type === "right_click" ||
    ((action.type === "click" || action.type === "double_click") &&
      action.button === "right");
  if (
    !surface.unknown &&
    action.type === "click" &&
    action.button === "left" &&
    surface.targetAppId === "com.apple.dock" &&
    surface.targetRole === "AXDockItem" &&
    surface.targetSubrole === "AXApplicationDockItem" &&
    surface.launcherAppId
  ) {
    if (
      isInstallerName(surface.targetLabel) ||
      isInstallerName(surface.launcherAppId)
    )
      return {
        kind: "DENY",
        reason:
          "Installer and uninstaller applications require manual operation. Open the requested application instead.",
      };
    const appPolicy = surfacePolicy(
      { ...surface, appId: surface.launcherAppId },
      settings,
    );
    if (appPolicy.kind !== "ALLOW") return appPolicy;
    // The frontmost application's own icon while it shows no window: the
    // click is how a person gets the window back (live: Calendar), and the
    // generic redirect below reads as a dead end after open_app was refused.
    // It promises no open_app result: the helper restores only a Window menu
    // item it recognizes, and the history then says not to open it again.
    if (surface.launcherAppId === surface.appId && surface.windowCount === 0)
      return {
        kind: "RETRY",
        reason: `No input was sent. ${quote(surface.appName || surface.targetLabel || "This application")} is open but shows no window. Choose its window from its Window menu in context.menus, or use File > New.`,
      };
    // A stray pointer near the screen edge must not launch an app. open_app
    // requires naming the application, which states the intent explicitly.
    return {
      kind: "RETRY",
      reason:
        "No input was sent. To open or switch to an application, use open_app with its exact name instead of clicking the Dock.",
    };
  }
  // Focusing a text field does not submit it. Its label or existing contents
  // can mention sending/deleting without making the focus click consequential.
  // A double-click is not a focus click (Finder names are AXTextFields).
  if (
    !surface.unknown &&
    ((action.type === "click" && action.button === "left") ||
      action.type === "click_control") &&
    ["AXTextField", "AXTextArea", "AXComboBox", "AXScrollBar"].includes(
      surface.targetRole ?? "",
    )
  )
    return { kind: "ALLOW", reason: "Focus a known input control." };
  const label = (surface.targetLabel ?? "").trim().toLowerCase();
  const text = (surface.targetText ?? "").trim().toLowerCase();
  // Label and the originally hit text are joined so either can trigger a gate.
  const words = `${label} | ${text}`;
  if (/\buninstall(?:er|ing)?\b/.test(words))
    return {
      kind: "DENY",
      reason:
        "Uninstaller controls require manual operation. Return to the requested task.",
    };
  // A top-level menu title ("Format", "Share") only opens its menu; the menu
  // items inside still pass the label check below.
  if (!surface.unknown && leftClick && surface.targetRole === "AXMenuBarItem")
    return { kind: "ALLOW", reason: "Open an application menu." };
  // Finder opens whatever is double-clicked, and hides ".app". Only a verified
  // folder (a file URL ending in "/" whose name is not a bundle) is routine.
  if (
    action.type === "double_click" &&
    (surface.appId === "com.apple.finder" ||
      surface.targetAppId === "com.apple.finder") &&
    !verifiedFolder(surface.targetURL)
  )
    return {
      kind: "CONFIRM",
      reason: "Open this item? It may run a program.",
    };
  // A result link on a search results page only opens that result. Its title
  // ("Post X · …", "How to delete…") describes the page, not an action here.
  if (
    !surface.unknown &&
    leftClick &&
    surface.targetRole === "AXLink" &&
    browsers.includes(surface.appId) &&
    (surface.targetAppId ?? surface.appId) === surface.appId &&
    !!surface.domain &&
    searchResultHost.test(surface.domain) &&
    surface.targetWebHost === surface.domain
  )
    return { kind: "ALLOW", reason: "Open a search result." };
  // "Post" is usually a noun on screen ("Post X · …", "Post in: All", "blog
  // post"). It can publish only as a button or menu item ("Post", "New Post").
  if (
    ["AXButton", "AXMenuItem", "AXMenuButton"].includes(
      surface.targetRole ?? "",
    ) &&
    /\bpost\b/.test(normalizeControlLabel(surface.targetLabel ?? ""))
  )
    return { kind: "CONFIRM", reason: "Publish this post?" };
  if (
    leftClick &&
    ideRunControl(
      surface.targetAppId || surface.appId,
      surface.targetRole,
      surface.targetLabel,
    )
  )
    return { kind: "DENY", reason: IDE_TERMINAL_REFUSAL };
  // In a coding agent's panel Undo, Reject and Discard throw its edits away
  // (Copilot's Undo All Edits, Claude Code's Reject). Elsewhere "undo" stays
  // on the harmless list. Only a control whose whole name is that: a file
  // named undo.ts, a tab or a link about undoing a commit is not one.
  if (
    leftClick &&
    ideFamily(surface.targetAppId || surface.appId) &&
    ideCommandControlRoles.includes(surface.targetRole ?? "") &&
    ideDiscardLabel(
      normalizeControlLabel(surface.targetLabel || surface.targetText || ""),
    )
  )
    return {
      kind: "CONFIRM",
      reason: "Discard the coding agent's changes?",
    };
  if (consequential.test(words))
    return consequentialDecision(words, settings, context);
  // Calculator keypad buttons only edit the displayed calculation. Sheets
  // (Print, Save Tape) and other buttons fall through to the normal rules.
  if (
    !surface.unknown &&
    !surface.modal &&
    leftClick &&
    surface.targetRole === "AXButton" &&
    surface.appId === "com.apple.calculator" &&
    (surface.targetAppId ?? surface.appId) === "com.apple.calculator" &&
    calculatorKey.test(normalizeControlLabel(surface.targetLabel ?? ""))
  )
    return { kind: "ALLOW", reason: "Press a Calculator key." };
  if (
    !surface.unknown &&
    surface.appId === "com.apple.Notes" &&
    surface.focusedRole === "AXTextArea" &&
    (action.type === "type_text" ||
      (action.type === "key" && action.key === "ENTER"))
  )
    return { kind: "ALLOW", reason: "Write in the Notes document editor." };
  if (
    !surface.unknown &&
    surface.addressBar &&
    editable &&
    browsers.includes(surface.appId)
  ) {
    const value = (
      action.type === "type_text" ? action.text : (surface.focusedValue ?? "")
    ).trim();
    if (
      /^(?:javascript|data|file|vbscript):/i.test(value) &&
      (action.type === "type_text" ||
        (action.type === "key" && action.key === "ENTER"))
    )
      return {
        kind: "DENY",
        reason: "Executable and local-file addresses require manual operation.",
      };
    if (
      action.type === "key" &&
      action.key === "ENTER" &&
      value &&
      !/[\r\n\t]/.test(value) &&
      !scanText(value).some((f) => f.action === "BLOCK_UPLOAD")
    )
      return {
        kind: "ALLOW",
        reason: "Navigate from the verified browser address bar.",
      };
  }
  if (
    !surface.unknown &&
    editable &&
    action.type === "key" &&
    action.key === "ENTER" &&
    surface.appId === "com.apple.Spotlight"
  ) {
    const query = surface.launcher?.query ?? "";
    const selected = surface.launcher?.selectedResult ?? "";
    if (isInstallerName(selected) || /\b(?:delete|remove)\b/i.test(selected))
      return {
        kind: "DENY",
        reason:
          "The selected Spotlight result is an installer or destructive utility. Do not launch it. Use open_app with the full name of the intended application.",
      };
    if (!selected.trim() || !query.trim())
      return {
        kind: "RETRY",
        reason: `No input was sent. Spotlight has no verified selection for "${quote(query)}". Use open_app with the exact application name, or type the full application name and wait for the result.`,
      };
    if (!launcherMatches(query, selected))
      return {
        kind: "RETRY",
        reason: `No input was sent. Spotlight selected "${quote(selected)}" for "${quote(query)}". Use open_app with the exact application name, or retype the query to match the result exactly.`,
      };
    return {
      kind: "ALLOW",
      reason: "Open the verified matching Spotlight result.",
    };
  }
  // Search fields submit a query, not a message. Spotlight and address bars
  // are handled above with their stricter rules.
  if (
    !surface.unknown &&
    action.type === "key" &&
    action.key === "ENTER" &&
    !surface.addressBar &&
    surface.appId !== "com.apple.Spotlight" &&
    // Web search boxes are often text areas (YouTube: "Search or ask a question").
    editableRoles.includes(surface.focusedRole ?? "") &&
    !/[\r\n]/.test(surface.focusedValue ?? "") &&
    (surface.focusedSubrole === "AXSearchField" ||
      /\b(search|find|filter|query|go to)\b/i.test(
        surface.focusedLabel ?? "",
      )) &&
    !scanText(surface.focusedValue ?? "").some(
      (f) => f.action === "BLOCK_UPLOAD",
    )
  )
    return { kind: "ALLOW", reason: "Submit a search." };
  // Tabs count as line breaks: both can send, run or move focus.
  if (!surface.unknown && action.type === "type_text" && editable)
    return !/[\r\n\t]/.test(action.text)
      ? { kind: "ALLOW", reason: "Type in a known non-secure text field." }
      : documentApps.includes(surface.appId) &&
          surface.focusedRole === "AXTextArea"
        ? {
            kind: "ALLOW",
            reason: "Write multi-line text in a document editor.",
          }
        : {
            kind: "CONFIRM",
            reason:
              "Type text with line breaks or tabs? Line breaks may send a message and tabs may move focus.",
          };
  if (
    !surface.unknown &&
    action.type === "key" &&
    ["BACKSPACE", "DELETE"].includes(action.key) &&
    editable
  )
    return { kind: "ALLOW", reason: "Edit text." };
  if (
    !surface.unknown &&
    action.type === "key" &&
    action.key === "SPACE" &&
    (editable || surface.focusedRole === "AXWebArea")
  )
    return { kind: "ALLOW", reason: "Type a space or scroll the page." };
  if (!surface.unknown && leftClick && surface.targetRole === "AXTab")
    return { kind: "ALLOW", reason: "Open a tab." };
  if (
    !surface.unknown &&
    leftClick &&
    surface.targetRole === "AXLink" &&
    surface.targetURL
  ) {
    let url: URL | undefined;
    try {
      url = new URL(surface.targetURL);
    } catch {
      /* Unparseable links use bounded targeting recovery below. */
    }
    if (
      url &&
      ["javascript:", "data:", "file:", "vbscript:"].includes(url.protocol)
    )
      return {
        kind: "DENY",
        reason: "Executable and local-file links require manual operation.",
      };
    if (url && ["http:", "https:"].includes(url.protocol))
      return protectedHost(url.hostname, settings)
        ? { kind: "CONFIRM", reason: PROTECTED_SITE_QUESTION }
        : { kind: "ALLOW", reason: "Follow a web link." };
  }
  const role = surface.targetRole ?? "";
  if (
    !surface.unknown &&
    (leftClick || rightClick) &&
    role &&
    // Dock items launch apps and Spotlight rows launch results; both have
    // their own verified paths above.
    surface.targetAppId !== "com.apple.dock" &&
    surface.appId !== "com.apple.Spotlight" &&
    surface.targetAppId !== "com.apple.Spotlight"
  ) {
    // Opening a file can run a program; that is not routine.
    if (
      action.type === "double_click" &&
      /\.(?:app|command|tool|sh|zsh|bash|pkg|mpkg|dmg|scpt|applescript|workflow|terminal|jar|py|rb|pl)\b/.test(
        words,
      )
    )
      return {
        kind: "CONFIRM",
        reason: "Open this file? It may run a program.",
      };
    // A context menu only lists choices; picking one is a separate click.
    if (rightClick) return { kind: "ALLOW", reason: "Open a context menu." };
    const shown = surface.targetLabel?.trim() || surface.targetText?.trim();
    if (
      selectionPointerRoles.includes(role) ||
      (contentPointerRoles.includes(role) && shown)
    )
      return {
        kind: "ALLOW",
        reason: "Select or open an identified, non-consequential item.",
      };
    if (activatableRoles.includes(role) && shown) {
      // Search result pages are read-only views (unit toggles, tabs, "more
      // results"). The consequential-word check above still gates them.
      // Only controls inside the results page itself: not browser chrome,
      // other apps' panels or embedded account/consent frames on other hosts.
      // YouTube filter chips and tabs are radio buttons that only change the
      // visible results.
      if (
        role === "AXRadioButton" &&
        browsers.includes(surface.appId) &&
        (surface.targetAppId ?? surface.appId) === surface.appId &&
        surface.domain &&
        /^(?:www\.|m\.)?youtube\.com$/.test(surface.domain) &&
        surface.targetWebHost === surface.domain
      )
        return { kind: "ALLOW", reason: "Filter the visible results." };
      if (
        ["AXButton", "AXRadioButton"].includes(role) &&
        browsers.includes(surface.appId) &&
        (surface.targetAppId ?? surface.appId) === surface.appId &&
        surface.domain &&
        searchResultHost.test(surface.domain) &&
        surface.targetWebHost === surface.domain
      )
        return {
          kind: "ALLOW",
          reason: "Use a control on a search results page.",
        };
      // System Settings lists the General pane's rows as buttons described by
      // their pane name; About only shows information (cycle 20260919-0226).
      // Scoped to System Settings: an "About" elsewhere is not known.
      if (
        surface.appId === "com.apple.systempreferences" &&
        normalizeControlLabel(shown) === "about"
      )
        return {
          kind: "ALLOW",
          reason:
            "Open System Settings’ About pane: it only shows information.",
        };
      if (
        benignControl(role, shown) ||
        (role === "AXButton" &&
          !!surface.targetWebHost &&
          webCodeLabel.test(normalizeControlLabel(shown)))
      )
        return {
          kind: "ALLOW",
          reason: "Activate an identified, non-consequential control.",
        };
      // A toggle set to the state the user's own words asked for: undone by
      // pressing it again, so it runs and is reported except in "ask"
      // (askedForControl). A button never runs on the words alone, and a
      // toggle they did not name asks as before.
      if (
        ["AXCheckBox", "AXRadioButton"].includes(role) &&
        settings.autonomy !== "ask" &&
        askedForControl(shown, context.userWords)
      )
        return {
          kind: "ALLOW",
          reason: `${quote(shown)} is the state you asked for, and pressing it again puts it back: reported, not asked.`,
        };
      return {
        kind: "CONFIRM",
        reason: ["AXCheckBox", "AXRadioButton"].includes(role)
          ? "Change this setting?"
          : `Click “${quote(shown)}”?`,
      };
    }
    if (activatableRoles.includes(role) || contentPointerRoles.includes(role))
      return {
        kind: "RETRY",
        reason:
          "No input was sent. This control has no accessible label, so its effect cannot be verified. Use a labelled control, a menu item or a keyboard shortcut instead.",
      };
  }
  // The application's own search command (Spotify's Edit > Search, Slack's
  // Jump to…) just ran here and nothing else has happened since, so the
  // unexposed field that has focus is that search box: a single-line query,
  // correcting it, and Enter to open the result are all a search, not a send.
  // Native clears this on any pointer input, another command, Escape, a pause
  // or an application switch; a focus that is identified keeps its own rules.
  const searchFocus =
    !surface.unknown &&
    !surface.modal &&
    !!surface.searchOpenedBy &&
    !editable &&
    unidentifiedFocusRoles.includes(surface.focusedRole ?? "");
  if (searchFocus) {
    const where = `${appLabel(surface)}’s ${quote(surface.searchOpenedBy!)}`;
    if (action.type === "type_text" && !/[\r\n\t]/.test(action.text))
      return { kind: "ALLOW", reason: `Type into ${where} field.` };
    if (
      action.type === "key" &&
      ["ENTER", "BACKSPACE", "DELETE"].includes(action.key)
    )
      return {
        kind: "ALLOW",
        reason:
          action.key === "ENTER"
            ? `Open the result of ${where}.`
            : `Correct the query in ${where} field.`,
      };
  }
  if (
    action.type === "key" &&
    ["ENTER", "DELETE", "BACKSPACE", "SPACE"].includes(action.key)
  )
    return activationDecision(action.key, settings);
  if (action.type === "type_text") {
    // VS Code and its forks keep their tree hidden, and a focus nothing
    // identifies there may be the integrated terminal, where a typed line runs.
    // Typing there needs a box the editor's own command just opened, never a
    // blind approval.
    if (!surface.unknown && ideFamily(surface.appId))
      return {
        kind: "RETRY",
        reason: `No input was sent. No text field is identified in ${appLabel(surface)}, and typing blind there can reach its terminal. Open the box you need with the app's own command first (CMD+P for a file, CMD+F to find), or ask the user with request_user.`,
      };
    // A blind application reports no focused field even when the cursor is in
    // one, so retrying only burns steps. Ask the user instead. The text itself
    // is never quoted; credentials and secure input were refused above.
    if (blind)
      return (
        blindRefusal(surface) ?? {
          kind: "CONFIRM",
          reason: `Type here in ${appLabel(surface)}? I can’t see its text fields.`,
        }
      );
    // The application publishes its own way to open a search field: name it,
    // so the next step is that route rather than the same text again.
    const route = (surface.searchCommand ?? [])
      .map((part) => quote(part))
      .filter(Boolean);
    return {
      kind: "RETRY",
      reason: surface.unknown
        ? "No input was sent. The focused field could not be identified. Capture a fresh screenshot and focus the intended text field first."
        : route.length >= 2
          ? `No input was sent. No text field is focused in ${appLabel(surface)}. Open its search first with menu_item ${JSON.stringify(route)}, then type.`
          : "No input was sent. No known text field is focused. Click the intended text field first, then type.",
    };
  }
  if (action.type === "key")
    return {
      kind: "RETRY",
      reason:
        "No input was sent. This key cannot be verified here. Use type_text for text in a focused field, or a navigation key once the application is identified.",
    };
  // A blind application identifies no pointer target anywhere, so retrying
  // ends in a takeover of the whole task. Ask the user to approve this one
  // click instead, naming the application and what will happen. Protected
  // applications, secure input and uninstallers were refused above; installers
  // and updaters are refused here.
  if (blind && (leftClick || rightClick) && !surface.targetRole)
    return (
      blindRefusal(surface) ?? {
        kind: "CONFIRM",
        reason: `${
          rightClick
            ? "Right-click"
            : action.type === "double_click"
              ? "Double-click"
              : "Click"
        } here in ${appLabel(surface)}? I can’t see its controls.`,
      }
    );
  // Unrecognized navigation is a targeting failure, not a request for the user
  // to bless a blind click. Give the agent bounded recovery before takeover.
  return {
    kind: "RETRY",
    reason:
      "No input was sent. This target could not be identified. Use a recognized control, open_app, or an exact application shortcut instead of repeating this action. Check frame appId; switch to the requested app first. Do not ask the user to approve routine navigation.",
  };
}
