import type { Action, Settings, Surface } from "./schema";
import { scanText } from "./sanitize";
export type Decision = {
  kind: "ALLOW" | "CONFIRM" | "DENY" | "RETRY" | "USER_TAKEOVER";
  reason: string;
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
// credentials or the system, however they were brought to the front.
const floorProtectedApps = new Set([
  "com.apple.terminal",
  "com.googlecode.iterm2",
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
];
function floorProtected(appId: string | undefined): boolean {
  const id = (appId ?? "").toLowerCase();
  return (
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
]);
const benignControlPrefix = /^(?:new|show|hide|view|sort by|go to|open)\b/;
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
const consequential =
  /\b(send|publish|pay|buy|purchase|transfer|delete|remove|uninstall|submit|invite|share|approve|confirm|authorize|upload|install|password|security|order|checkout|continue to checkout|subscribe|unsubscribe|donate|sign|trash|erase|reset|archive|discard|empty|format|revoke|deactivate|disable|withdraw|deposit|bid|call|dial|accept|agree|logout|log out|sign out|restart|shut down|force quit|replace|overwrite|don['’]?t save|turn off|repost|retweet|comment|connect|decline|bin|move to bin|cancel subscription|cancel membership|save|like|dislike|join|block)\b/;
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
  return { kind: "ALLOW", reason: "" };
}
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
    return { kind: "ALLOW", reason: "Open a verified installed application." };
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
function openFileDecision(surface: Surface, synthetic: boolean): Decision {
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
  if (
    surface.fileStatus === "resolved" &&
    (surface.fileKind === "document" || surface.fileKind === "folder")
  )
    return {
      kind: "ALLOW",
      reason: "Open a document or folder from the local index.",
    };
  return {
    kind: "RETRY",
    reason:
      "No input was sent. That path is not in the local index. Use a path listed in context.memory.files or folders, or request_user.",
  };
}
export function evaluate(
  action: Action,
  surface: Surface,
  settings: Settings,
  synthetic: boolean,
): Decision {
  const protectedSurface = surfacePolicy(surface, settings);
  if (protectedSurface.kind !== "ALLOW") return protectedSurface;
  if (surface.targetAppId) {
    const targetPolicy = surfacePolicy(
      { ...surface, appId: surface.targetAppId },
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
  )
    return {
      kind: "DENY",
      reason: "Clipboard access is disabled in GUI Research Mode.",
    };
  if (["capture", "done", "fail", "wait"].includes(action.type))
    return { kind: "ALLOW", reason: "" };
  // Before the synthetic ALLOW: the tutorial must never launch real apps.
  if (action.type === "open_app")
    return openAppDecision(action, surface, settings, synthetic);
  if (action.type === "open_file") return openFileDecision(surface, synthetic);
  if (synthetic)
    return { kind: "ALLOW", reason: "CoArena-owned tutorial surface." };
  if (surface.targetEnabled === false)
    return {
      kind: "RETRY",
      reason:
        "No input was sent. The target is disabled. Choose an enabled control or an application shortcut from the fresh screenshot.",
    };
  if (["move", "scroll"].includes(action.type))
    return { kind: "ALLOW", reason: "Pointer navigation." };
  const editable = ["AXTextField", "AXTextArea", "AXComboBox"].includes(
    surface.focusedRole ?? "",
  );
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
  // Calculator accepts keypad input without a focused text field. Digits,
  // operators, Enter (=) and Backspace only change the displayed calculation.
  if (
    !surface.unknown &&
    !surface.modal &&
    surface.appId === "com.apple.calculator" &&
    !["AXTextField", "AXTextArea", "AXComboBox"].includes(
      surface.focusedRole ?? "",
    )
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
    if (["CMD+SPACE", "CMD+TAB", "CMD+SHIFT+TAB"].includes(keys))
      return {
        kind: "ALLOW",
        reason: "Open Spotlight or switch applications.",
      };
    if (keys === "CMD+F")
      return { kind: "ALLOW", reason: "Find within the current application." };
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
    (action.type === "click" || action.type === "double_click") &&
    action.button === "left";
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
    action.type === "click" &&
    action.button === "left" &&
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
  if (consequential.test(words))
    return { kind: "CONFIRM", reason: consequentialReason(words) };
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
    ["AXTextField", "AXComboBox", "AXTextArea"].includes(
      surface.focusedRole ?? "",
    ) &&
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
        ? { kind: "CONFIRM", reason: "Open a protected website?" }
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
      if (benignControl(role, shown))
        return {
          kind: "ALLOW",
          reason: "Activate an identified, non-consequential control.",
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
  if (
    action.type === "key" &&
    ["ENTER", "DELETE", "BACKSPACE", "SPACE"].includes(action.key)
  )
    return {
      kind: "CONFIRM",
      reason: "Activate this control? It may submit or change content.",
    };
  if (action.type === "type_text")
    return {
      kind: "RETRY",
      reason: surface.unknown
        ? "No input was sent. The focused field could not be identified. Capture a fresh screenshot and focus the intended text field first."
        : "No input was sent. No known text field is focused. Click the intended text field first, then type.",
    };
  if (action.type === "key")
    return {
      kind: "RETRY",
      reason:
        "No input was sent. This key cannot be verified here. Use type_text for text in a focused field, or a navigation key once the application is identified.",
    };
  // Unrecognized navigation is a targeting failure, not a request for the user
  // to bless a blind click. Give the agent bounded recovery before takeover.
  return {
    kind: "RETRY",
    reason:
      "No input was sent. This target could not be identified. Use a recognized control, open_app, or an exact application shortcut instead of repeating this action. Check frame appId; switch to the requested app first. Do not ask the user to approve routine navigation.",
  };
}
