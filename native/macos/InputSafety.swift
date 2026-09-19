import Foundation
import CoreGraphics

let browserAppIDs = ["com.apple.Safari", "com.google.Chrome", "com.google.Chrome.canary", "org.mozilla.firefox", "com.brave.Browser", "com.microsoft.edgemac"]

func independentNavigationShortcut(_ action:[String:Any], appId:String) -> Bool {
    // open_app launches a natively verified bundle; it does not target pixels.
    if action["type"] as? String == "open_app" {return true}
    // A scroll moves what is under the pointer and commits nothing, and the
    // pages people scroll (feeds, articles with video) never hold still; the
    // same-application and same-window checks still apply.
    if action["type"] as? String == "scroll" {return true}
    if action["type"] as? String == "key" {return action["key"] as? String == "ESC"}
    guard action["type"] as? String == "hotkey",let keys=action["keys"] as? [String] else{return false}
    let chord=keys.sorted().joined(separator:"+")
    return ["CMD+SPACE","CMD+TAB","CMD+SHIFT+TAB","CMD+F"].contains(chord) || (chord == "CMD+L" && browserAppIDs.contains(appId))
}

// The clipboard is off limits to the agent: it can carry a secret the user
// copied a moment ago, and copying screen content out is exfiltration. The one
// exception is the paste the user asked for, which policy marks on the action:
// Command-V alone, never copy or cut, never another modifier.
func clipboardChordAllowed(names: [String], paste: Bool) -> Bool {
    let modifiers = names.filter { ["CMD", "CTRL", "ALT"].contains($0) }
    let clipboard = names.filter { ["C", "V", "X"].contains($0) }
    if modifiers.isEmpty || clipboard.isEmpty { return true }
    return paste && names.count == 2 && modifiers == ["CMD"] && clipboard == ["V"]
}

func focusedEditingAction(_ action:[String:Any]) -> Bool {
    if action["type"] as? String == "type_text" {return true}
    if action["type"] as? String == "key" {return ["LEFT","RIGHT","UP","DOWN","HOME","END","BACKSPACE","DELETE","TAB"].contains(action["key"] as? String ?? "")}
    return action["type"] as? String == "hotkey" && (action["keys"] as? [String] ?? []).sorted() == ["A","CMD"]
}

func forwardedSpotlightEvent(type: CGEventType, keyCode: Int64, flags: CGEventFlags, systemSiri: Bool, now: TimeInterval, deadline: TimeInterval) -> Bool {
    systemSiri && type == .keyDown && keyCode == 49 &&
    flags.intersection([.maskCommand,.maskControl,.maskAlternate,.maskShift]) == .maskCommand &&
    now <= deadline && deadline - now <= 0.15
}

// Window/pill changes and our own posted events are echoed by WindowServer as
// mouseMoved events at fixed-point locations that differ from the seeded or
// posted position by less than a pixel, usually with a zero hardware delta, and
// a hand resting on the mouse nudges it by a pixel or two. Neither is takeover:
// under 3 px of travel from the anchor with a hardware delta under 3 never is,
// in or out of the grace window after resume or our own pointer input. Travel
// of 3 px or a hardware delta of 3 always is. The caller keeps the anchor for
// ignored events, so slow real drift still accumulates to 3 px. graceActive no
// longer changes the result; call sites still pass it so the rule stays explicit.
func pointerTakeover(previous: CGPoint?, current: CGPoint, deltaX: Int64, deltaY: Int64, graceActive: Bool) -> Bool {
    guard let previous = previous else { return false }
    let distance = hypot(current.x - previous.x, current.y - previous.y)
    return distance >= 3 || max(abs(deltaX), abs(deltaY)) >= 3
}

// MARK: manual input idle reporting

// Kinds of the user's own input reported to main. Reports never carry
// coordinates, key codes or characters.
enum ManualInputKind: String, CaseIterable { case click, key, mouseMove = "mouse_move", scroll }

// The kind of an event the tap saw, or nil when it is not the user's input:
// our own marked input never opens or extends an episode.
func manualInputKind(type: CGEventType, marked: Bool) -> ManualInputKind? {
    guard !marked else { return nil }
    switch type {
    case .mouseMoved: return .mouseMove
    case .scrollWheel: return .scroll
    case .leftMouseDown, .rightMouseDown, .otherMouseDown, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged: return .click
    case .keyDown: return .key
    default: return nil
    }
}

struct IdleReport: Equatable {
    let idleMs: Int
    let kinds: [String]
    var event: [String: Any] { ["event": "user_input_idle", "idleMs": idleMs, "kinds": kinds] }
}

// One episode of manual input. The first input opens it; once input has been
// quiet for 1 s it reports idleMs 1000, at 3 s it reports idleMs 3000 and
// closes. Input before the 3 s report restarts the timing (both reports are due
// again) and adds its kind; kinds reset only when the episode closes. Times are
// monotonic seconds. A late tick past both thresholds reports both, in order.
struct ManualInputEpisode {
    static let thresholds: [(seconds: TimeInterval, idleMs: Int)] = [(1.0, 1000), (3.0, 3000)]
    private(set) var lastInputAt: TimeInterval? = nil
    private(set) var kinds = Set<ManualInputKind>()
    private var reported = 0
    var isOpen: Bool { lastInputAt != nil }
    mutating func observe(kind: ManualInputKind, at time: TimeInterval) {
        lastInputAt = max(lastInputAt ?? time, time)
        kinds.insert(kind)
        reported = 0
    }
    mutating func tick(now: TimeInterval) -> [IdleReport] {
        guard let last = lastInputAt else { return [] }
        let thresholds = ManualInputEpisode.thresholds
        var reports = [IdleReport]()
        while reported < thresholds.count && now - last >= thresholds[reported].seconds {
            reports.append(IdleReport(idleMs: thresholds[reported].idleMs, kinds: kinds.map { $0.rawValue }.sorted()))
            reported += 1
        }
        if reported == thresholds.count { self = ManualInputEpisode() }
        return reports
    }
}

// MARK: presence

// What the helper knows about whether someone is at the Mac, read by main to
// decide who hears progress and whether a texted task may take the screen.
// Counters and flags only: no coordinates, no key codes, no window titles.
struct PresenceReport: Equatable {
    let hidIdleSeconds: Double
    // Age of the last unmarked input the emergency-stop tap saw, or nil while
    // no tap is installed (main then falls back to hidIdleSeconds).
    let tapIdleSeconds: Double?
    let locked: Bool
    let displayAsleep: Bool
    // Something is holding the display awake: a call sharing the screen, a
    // video, a presentation. Idle input then does not mean the user has left,
    // and a texted task must not take a screen an audience may be watching.
    let displayHeldAwake: Bool
    var dictionary: [String: Any] {
        ["hidIdleSeconds": hidIdleSeconds, "tapIdleSeconds": tapIdleSeconds.map { $0 as Any } ?? NSNull(),
         "locked": locked, "displayAsleep": displayAsleep, "displayHeldAwake": displayHeldAwake]
    }
}

// Builds the report from raw readings. The tap's idle age counts from its
// installation until the first manual input, so a fresh tap never reports the
// user as present on data it never saw, and a clock that ran backwards reads
// as zero rather than negative. An unreadable HID counter reads as zero (just
// active): that is the side on which a texted task never takes the screen.
// The lock flags are best effort: an absent session dictionary reads as
// unlocked and on console, because unknown must never count as away. The
// display flags pass through as read.
func presenceReport(hidIdleSeconds: Double, tapInstalledAt: TimeInterval?, lastManualInputAt: TimeInterval?,
                    now: TimeInterval, screenLocked: Bool?, onConsole: Bool?, displayAsleep: Bool,
                    displayHeldAwake: Bool) -> PresenceReport {
    let hid = hidIdleSeconds.isFinite ? max(0, hidIdleSeconds) : 0
    var tapIdle: Double? = nil
    if let installed = tapInstalledAt {
        tapIdle = max(0, now - max(installed, lastManualInputAt ?? installed))
    }
    let locked = (screenLocked ?? false) || !(onConsole ?? true)
    return PresenceReport(hidIdleSeconds: hid, tapIdleSeconds: tapIdle, locked: locked, displayAsleep: displayAsleep,
                          displayHeldAwake: displayHeldAwake)
}

// MARK: Electron accessibility

// Editors that take an enabled accessibility tree for a screen reader: VS Code
// and its forks (editor.accessibilitySupport "auto") switch to screen reader
// optimized mode and show a sticky prompt, so they are never switched.
let screenReaderDetectingAppPrefixes = ["com.microsoft.vscode", "com.vscodium", "com.todesktop.230313mzl4w4u92", "com.exafunction.windsurf"]

// Whether AXManualAccessibility may be set on an application: never on Butler
// itself (or this helper), protected applications (matched like
// guardSurface) or screen-reader-detecting editors.
func manualAccessibilityEligible(pid: pid_t, bundleId: String, ownPid: pid_t, parentPid: pid_t, protectedApps: [String]) -> Bool {
    let id = bundleId.lowercased()
    guard pid > 0, pid != ownPid, pid != parentPid, id != "ai.coarena.openassist" else { return false }
    if protectedApps.contains(where: { id.contains($0.lowercased()) }) { return false }
    return !screenReaderDetectingAppPrefixes.contains { id.hasPrefix($0) }
}

// Processes already attempted, keyed by pid and launch time so a reused pid is
// a new process. Bounded; forgetting only allows a harmless repeat.
struct ManualAccessibilityAttempts {
    static let limit = 256
    private(set) var seen = Set<String>()
    // True the first time a process is claimed.
    mutating func claim(pid: pid_t, launchedAt: TimeInterval?) -> Bool {
        let key = "\(pid):" + (launchedAt.map { String($0) } ?? "-")
        guard !seen.contains(key) else { return false }
        if seen.count >= ManualAccessibilityAttempts.limit { seen.removeAll() }
        seen.insert(key)
        return true
    }
}

// MARK: Blind surfaces

// How much of its own interface the frontmost application publishes to the
// accessibility API. Chromium/CEF applications (Spotify) and some game or
// custom-drawn windows expose a window and nothing inside it: every pointer
// target and every focused field is then unidentifiable, so the agent must be
// told rather than left retrying. Reported on the surface and in the model's
// screen context; only "none" changes policy (docs/THREAT_MODEL.md).
enum SurfaceAccessibility: String { case none, partial, full }

// A frontmost window smaller than this is a palette, a notification or a
// window still being laid out: too little evidence to call an application
// blind. An empty desktop has no focused window at all and is never blind.
let blindWindowMinimumWidth = 200.0
let blindWindowMinimumHeight = 120.0
// A focused element that is only the window, the application or an unnamed
// container identifies nothing the agent could type into or act on.
let uninformativeFocusRoles: Set<String> = ["", "AXWindow", "AXApplication", "AXUnknown", "AXGroup"]

/**
 Classifies the frontmost application's accessibility.

 `nil` means "no verdict": accessibility is not trusted, or there is no
 frontmost window of a usable size (an empty desktop, a window still opening),
 so a momentary blank never marks an application blind. `.none` requires a real
 sized window, a completed walk that found nothing actionable, no usable
 focused element and no hit-test target for the pointer action being checked.
 */
func surfaceAccessibility(trusted: Bool, windowWidth: Double, windowHeight: Double,
                          focusedRole: String, actionable: Int, walkComplete: Bool,
                          hitTarget: Bool) -> SurfaceAccessibility? {
    guard trusted else { return nil }
    let focused = !uninformativeFocusRoles.contains(focusedRole.trimmingCharacters(in: .whitespacesAndNewlines))
    if focused && actionable > 0 { return .full }
    guard windowWidth >= blindWindowMinimumWidth, windowHeight >= blindWindowMinimumHeight else {
        return (focused || actionable > 0 || hitTarget) ? .partial : nil
    }
    if !focused && actionable == 0 && !hitTarget && walkComplete { return SurfaceAccessibility.none }
    return .partial
}

// Roles the pointer hit-test walk climbs through toward the real control, and
// roles that are already the control.
let hitWalkClimbRoles: Set<String> = ["AXStaticText", "AXImage", "AXGroup"]
let hitWalkControlRoles: Set<String> = ["AXButton", "AXLink", "AXTextField", "AXTextArea", "AXComboBox", "AXTab", "AXMenuBarItem", "AXDockItem"]
// An ancestor reached by the walk is the clicked control when it has an
// actionable role, its own accessible description (aria-label, title) or a
// press action; climbing further would lose that name to an unrelated container.
func hitWalkStopsAt(role: String, description: String, actions: [String]) -> Bool {
    hitWalkControlRoles.contains(role) || !description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || actions.contains("AXPress")
}
// Names gathered from every element the walk visited, hit element first,
// de-duplicated and bounded, so policy sees an intermediate label such as
// "Delete" even when the final target is an unlabelled container.
func joinedTargetText(_ parts: [String], limit: Int = 240) -> String {
    var seen = Set<String>(), kept = [String]()
    for part in parts {
        let text = part.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        guard !text.isEmpty, seen.insert(text.lowercased()).inserted else { continue }
        kept.append(text)
    }
    return String(kept.joined(separator: " · ").prefix(limit))
}

// Checked before every typed character. Secure input hands control to the user;
// a focus change (a typed tab, an auto-advancing code field) stops the step.
enum TypingInterruption: Equatable { case surfaceBlocked, focusChanged }
func typingInterruption(secureInput: Bool, focusUnchanged: Bool, secureField: Bool) -> TypingInterruption? {
    if secureInput || secureField { return .surfaceBlocked }
    return focusUnchanged ? nil : .focusChanged
}

// Synthetic buttons and keys the helper has pressed and not yet released, so
// every exit path can release them before the process disappears.
struct HeldInput: Equatable {
    var leftButton: CGPoint? = nil
    var rightButton: CGPoint? = nil
    var keys: [CGKeyCode] = []
    mutating func record(type: CGEventType, location: CGPoint, keyCode: CGKeyCode) {
        switch type {
        case .leftMouseDown, .leftMouseDragged: leftButton = location
        case .leftMouseUp: leftButton = nil
        case .rightMouseDown, .rightMouseDragged: rightButton = location
        case .rightMouseUp: rightButton = nil
        case .keyDown: if !keys.contains(keyCode) { keys.append(keyCode) }
        case .keyUp: keys.removeAll { $0 == keyCode }
        default: break
        }
    }
    var isEmpty: Bool { leftButton == nil && rightButton == nil && keys.isEmpty }
}
