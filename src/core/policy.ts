import type { Action, Settings, Surface } from "./schema";
import { scanText } from "./sanitize";
export type Decision = {
  kind: "ALLOW" | "CONFIRM" | "DENY" | "RETRY" | "USER_TAKEOVER";
  reason: string;
};
export function surfacePolicy(surface: Surface, settings: Settings): Decision {
  if (/uninstall/i.test(surface.appId))
    return {
      kind: "USER_TAKEOVER",
      reason:
        "An uninstaller opened. Input stopped; close it manually before continuing.",
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
  if (
    surface.domain &&
    settings.protectedDomains.some(
      (d) => surface.domain === d || surface.domain?.endsWith("." + d),
    )
  )
    return {
      kind: "USER_TAKEOVER",
      reason: "A protected website is active. Please take over.",
    };
  return { kind: "ALLOW", reason: "" };
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
  // Dismissal and these exact OS navigation shortcuts do not activate the
  // focused control. Do not let a focused Send/Delete label gate Escape.
  if (!surface.unknown && action.type === "key" && action.key === "ESC")
    return { kind: "ALLOW", reason: "Dismiss the current menu or panel." };
  if (!surface.unknown && action.type === "hotkey") {
    const keys = [...action.keys].sort().join("+");
    if (["CMD+SPACE", "CMD+TAB", "CMD+SHIFT+TAB"].includes(keys))
      return {
        kind: "ALLOW",
        reason: "Open Spotlight or switch applications.",
      };
    if (keys === "CMD+F")
      return { kind: "ALLOW", reason: "Find within the current application." };
    if (keys === "CMD+N" && surface.appId === "com.apple.Notes")
      return { kind: "ALLOW", reason: "Create a new note." };
    if (
      keys === "CMD+L" &&
      [
        "com.apple.Safari",
        "com.google.Chrome",
        "com.google.Chrome.canary",
        "org.mozilla.firefox",
        "com.brave.Browser",
        "com.microsoft.edgemac",
      ].includes(surface.appId)
    )
      return { kind: "ALLOW", reason: "Focus the browser address bar." };
    if (keys === "CMD+L")
      return {
        kind: "DENY",
        reason:
          "The foreground application is not a browser. First switch to the requested browser using Command-Space and its full app name, then use Command-L.",
      };
  }
  const leftClick = action.type === "click" && action.button === "left";
  if (
    !surface.unknown &&
    leftClick &&
    surface.targetAppId === "com.apple.dock" &&
    surface.targetRole === "AXDockItem" &&
    surface.targetSubrole === "AXApplicationDockItem" &&
    surface.launcherAppId
  ) {
    if (
      /\b(?:uninstall\w*|install\w*)\b/i.test(surface.targetLabel ?? "") ||
      /(?:installer|uninstall)/i.test(surface.launcherAppId)
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
    return {
      kind: "ALLOW",
      reason: "Open a verified application from the Dock.",
    };
  }
  // Focusing a text field does not submit it. Its label or existing contents
  // can mention sending/deleting without making the focus click consequential.
  if (
    !surface.unknown &&
    leftClick &&
    ["AXTextField", "AXTextArea", "AXComboBox", "AXScrollBar"].includes(
      surface.targetRole ?? "",
    )
  )
    return { kind: "ALLOW", reason: "Focus a known input control." };
  const label = (surface.targetLabel ?? "").trim().toLowerCase();
  if (/\buninstall(?:er|ing)?\b/.test(label))
    return {
      kind: "DENY",
      reason:
        "Uninstaller controls require manual operation. Return to the requested task.",
    };
  if (
    /\b(send|post|publish|pay|buy|purchase|transfer|delete|remove|uninstall|submit|invite|share|approve|confirm|authorize|upload|install|password|security)\b/.test(
      label,
    )
  ) {
    const reason = /\bsend\b/.test(label)
      ? "Send this message?"
      : /\b(delete|remove)\b/.test(label)
        ? "Delete this item?"
        : /\b(pay|buy|purchase|transfer)\b/.test(label)
          ? "Approve this transaction?"
          : /\b(post|publish)\b/.test(label)
            ? "Publish this post?"
            : /\b(share|upload)\b/.test(label)
              ? "Share or upload this item?"
              : /\b(password|security)\b/.test(label)
                ? "Change these account or security settings?"
                : /\binstall\b/.test(label)
                  ? "Install this software?"
                  : /\binvite\b/.test(label)
                    ? "Send this invitation?"
                    : "Submit or authorize this change?";
    return { kind: "CONFIRM", reason };
  }
  const editable = ["AXTextField", "AXTextArea", "AXComboBox"].includes(
    surface.focusedRole ?? "",
  );
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
    leftClick &&
    surface.appId === "com.apple.Notes" &&
    surface.targetAppId === "com.apple.Notes" &&
    surface.targetRole === "AXButton" &&
    /^(?:new note|create (?:a )?(?:new )?note)$/.test(label)
  )
    return { kind: "ALLOW", reason: "Create a new note." };
  if (
    !surface.unknown &&
    surface.addressBar &&
    editable &&
    [
      "com.apple.Safari",
      "com.google.Chrome",
      "com.google.Chrome.canary",
      "org.mozilla.firefox",
      "com.brave.Browser",
      "com.microsoft.edgemac",
    ].includes(surface.appId)
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
      !/[\r\n]/.test(value) &&
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
    action.type === "hotkey" &&
    [...action.keys].sort().join("+") === "A+CMD"
  )
    return { kind: "ALLOW", reason: "Select text in a known input field." };
  if (
    !surface.unknown &&
    editable &&
    action.type === "key" &&
    action.key === "ENTER" &&
    surface.appId === "com.apple.Spotlight"
  ) {
    const normalize = (value: string) =>
      value
        .trim()
        .toLowerCase()
        .replace(/\.app$/, "")
        .replace(/\s+/g, " ");
    const selected = normalize(surface.launcher?.selectedResult ?? "");
    const query = normalize(surface.launcher?.query ?? "");
    if (/\b(?:uninstall\w*|install\w*|delete|remove)\b/.test(selected))
      return {
        kind: "DENY",
        reason:
          "The selected Spotlight result is an installer or destructive utility. Do not launch it. Search for the full name of the intended application.",
      };
    if (!selected || !query || selected !== query)
      return {
        kind: "DENY",
        reason:
          "The selected Spotlight result does not exactly match the search. Replace the query with the full application name, then verify the selected result before Enter.",
      };
    return {
      kind: "ALLOW",
      reason: "Open the verified matching Spotlight result.",
    };
  }
  if (
    !surface.unknown &&
    action.type === "type_text" &&
    editable &&
    !/[\r\n]/.test(action.text)
  )
    return { kind: "ALLOW", reason: "Type in a known non-secure text field." };
  if (
    !surface.unknown &&
    action.type === "key" &&
    editable &&
    [
      "LEFT",
      "RIGHT",
      "UP",
      "DOWN",
      "HOME",
      "END",
      "BACKSPACE",
      "DELETE",
      "TAB",
    ].includes(action.key)
  )
    return { kind: "ALLOW", reason: "Edit or navigate text." };
  if (
    !surface.unknown &&
    leftClick &&
    ["AXTab", "AXMenuBarItem"].includes(surface.targetRole ?? "")
  )
    return { kind: "ALLOW", reason: "Open a tab or application menu." };
  if (
    !surface.unknown &&
    leftClick &&
    surface.targetRole === "AXButton" &&
    /^(search|find|reply|reply all|compose|new message|edit|view|back|next|(?:play|pause)(?: video)?(?: \([a-z]\))?)$/.test(
      label,
    )
  )
    return {
      kind: "ALLOW",
      reason: "Known preparation or navigation control.",
    };
  if (
    !surface.unknown &&
    action.type === "click" &&
    action.button === "left" &&
    surface.targetRole === "AXLink" &&
    surface.targetURL
  ) {
    try {
      const url = new URL(surface.targetURL);
      if (
        url.protocol === "https:" &&
        ["youtube.com", "www.youtube.com", "m.youtube.com"].includes(
          url.hostname,
        ) &&
        ["/watch", "/results"].includes(url.pathname)
      )
        return {
          kind: "ALLOW",
          reason: "Open a public video or search-results page.",
        };
    } catch {
      /* Unverified links use bounded targeting recovery below. */
    }
  }
  // Unrecognized navigation is a targeting failure, not a request for the user
  // to bless a blind click. Give the agent bounded recovery before takeover.
  if (
    action.type === "hotkey" &&
    action.keys.some((k) => ["ENTER", "BACKSPACE", "DELETE"].includes(k))
  )
    return {
      kind: "CONFIRM",
      reason: "This shortcut may send or delete content. Allow it?",
    };
  if (
    action.type === "key" &&
    ["ENTER", "DELETE", "BACKSPACE", "SPACE"].includes(action.key)
  )
    return {
      kind: "CONFIRM",
      reason: "Activate this control? It may submit or change content.",
    };
  return {
    kind: "RETRY",
    reason:
      "No input was sent. This target could not be identified. Use a recognized control or an exact application shortcut instead of repeating this action. Check frame appId; switch to the requested app first. For a new Apple Notes note, focus Notes and use Command-N. Do not ask the user to approve routine navigation.",
  };
}
