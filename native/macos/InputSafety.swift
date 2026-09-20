import Foundation
import CoreGraphics

let browserAppIDs = ["com.apple.Safari", "com.google.Chrome", "com.google.Chrome.canary", "org.mozilla.firefox", "com.brave.Browser", "com.microsoft.edgemac"]

// MARK: The page a browser window shows

/**
 What a window's or web area's URL attribute says about the page: the host it
 names (lowercased and alone, as `domain` carries it: never the path, the
 query or the port), a page whose URL names no host (about:blank, a file,
 which is known local), or nothing readable at all (no attribute, or a value
 that is not a URL). WebKit publishes AXURL as a URL, some views as a string.
 */
enum PageURL: Equatable { case host(String), local, unreadable }
func pageURL(_ value: Any?) -> PageURL {
    guard let value else { return .unreadable }
    // Foundation parses almost any string as a relative URL; only an absolute
    // one (a scheme) is a page address that was read.
    guard let url = (value as? URL) ?? (value as? String).flatMap({ URL(string: $0) }), url.scheme != nil else { return .unreadable }
    guard let host = url.host?.lowercased(), !host.isEmpty else { return .local }
    return .host(host)
}
/// The host a URL attribute names, else nil.
func pageHost(_ value: Any?) -> String? {
    if case .host(let host) = pageURL(value) { return host }
    return nil
}
/// The most an address in the frame context carries (ScreenContext.browserAddress's bound).
let pageAddressChars = 2000
/**
 The address a browser frame's context reports (ScreenContext.browserAddress:
 what tells the runner a page is in front and what web__read_current_page
 reads): the first page URL that names a host, whole, in the order given (the
 web area holding focus, then the window's), else the address field's text
 when that field is the focused element, else nothing. Until 2026-09-20 the
 field was the only source, so a page with focus in its content, which is
 every page after a click or a scroll, reported no address: across market
 shards 2/3 and 3/3 (cycles 20260920-0327-abc24ae and 20260920-0415-c8c9e10)
 web__read_current_page never reached a call, was refused no_page on every
 research page, and the runs looked and clicked to STUCK_LOOP. The field's
 text is what was typed there, not the page committed, so it comes last and
 only while focused; addressBar, the flag that says the field is focused, is
 read elsewhere and unchanged.
 */
func browserPageAddress(pageURLs: [Any?], fieldValue: String?, fieldFocused: Bool) -> String? {
    for value in pageURLs {
        guard case .host = pageURL(value) else { continue }
        let address = (value as? URL)?.absoluteString ?? (value as? String) ?? ""
        if !address.isEmpty { return String(address.prefix(pageAddressChars)) }
    }
    guard fieldFocused, let fieldValue, !fieldValue.isEmpty else { return nil }
    return String(fieldValue.prefix(pageAddressChars))
}
/**
 Whether a browser window shows a page the policy cannot tell from a protected
 one: no host was read from the window or any web area, and a web area was
 there that published no readable URL. A page whose URL names no host is known
 local, and a window with no web area shows no page, so neither is unknown.
 Never outside a browser: Mail's message view is WebKit and publishes no URL.
 The policy hands off on an unknown page while any domain is protected, as
 watchDomainRefused does for a watch, so an unreadable address is never taken
 for a safe one (Safari, 2026-09-19: no host on any page, and nothing said so).
 */
func pageHostUnknown(browser: Bool, host: String?, unreadableWebArea: Bool) -> Bool {
    return browser && host == nil && unreadableWebArea
}

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

// Where the last counted input of the user's own landed, for the resume rule
// (design §3): a press, drag or wheel on the part of the bound window no other
// window covers, or elsewhere; or a key, whose place is wherever the keyboard
// focus is when the question is asked. A hover, a release or a modifier is
// not counted and moves nothing (handsPlacement in BackgroundInput.swift).
enum HandsPlacement: Equatable { case pointerInside, pointerOutside, key }
// Whether the hands are in the bound window, given where the last counted
// input landed and whether the target application is frontmost now: the last
// press, drag or wheel was on the window, or the last input was a key and the
// application still has the keyboard. Asked of one event as it arrives (is it
// aimed at the window) and again of the last counted input when the idle
// report is written, so a scroll in a window behind another keeps reading as
// inside however the front changes, and a key stops reading as inside the
// moment the user switches away.
func handsInside(_ placement: HandsPlacement?, targetFrontmost: Bool) -> Bool {
    switch placement {
    case .pointerInside: return true
    case .key: return targetFrontmost
    case .pointerOutside, nil: return false
    }
}

// Where the user's hands are relative to a bound window when its run is held
// (design §3): whether the target application is frontmost now, and whether
// the hands are in the window (handsInside of the last counted input). Two
// flags, so main can tell "still in Slack" from "switched away" without a
// coordinate; the run continues only when both say the hands are gone.
struct TargetIdle: Equatable {
    let frontmost: Bool
    let lastInside: Bool
}

struct IdleReport: Equatable {
    let idleMs: Int
    let kinds: [String]
    var target: TargetIdle? = nil
    var event: [String: Any] {
        var event: [String: Any] = ["event": "user_input_idle", "idleMs": idleMs, "kinds": kinds]
        if let target { event["target"] = ["frontmost": target.frontmost, "lastInside": target.lastInside] }
        return event
    }
}

// One episode of manual input. The first input opens it; once input has been
// quiet for 1 s it reports idleMs 1000, at 3 s it reports idleMs 3000 and
// closes. Input before the 3 s report restarts the timing (both reports are due
// again) and adds its kind; kinds reset only when the episode closes. Times are
// monotonic seconds. A late tick past both thresholds reports both, in order.
// A counted input (a press, drag, wheel or key) also says where it put the
// hands; the latest placement is read against the front when a target is bound
// (targetFrontmost given) and rides on the report, so the resume rule sees
// where the hands went last. The placement outlives the episode: the hands
// stay where they went until a counted input takes them somewhere else, so an
// episode of hovering after a scroll in the window still reads as inside.
struct ManualInputEpisode {
    static let thresholds: [(seconds: TimeInterval, idleMs: Int)] = [(1.0, 1000), (3.0, 3000)]
    private(set) var lastInputAt: TimeInterval? = nil
    private(set) var kinds = Set<ManualInputKind>()
    private(set) var placement: HandsPlacement? = nil
    private var reported = 0
    var isOpen: Bool { lastInputAt != nil }
    mutating func observe(kind: ManualInputKind, at time: TimeInterval, placement: HandsPlacement? = nil) {
        if let placement, time >= lastInputAt ?? time { self.placement = placement }
        lastInputAt = max(lastInputAt ?? time, time)
        kinds.insert(kind)
        reported = 0
    }
    mutating func tick(now: TimeInterval, targetFrontmost: Bool? = nil) -> [IdleReport] {
        guard let last = lastInputAt else { return [] }
        let thresholds = ManualInputEpisode.thresholds
        let target = targetFrontmost.map { TargetIdle(frontmost: $0, lastInside: handsInside(placement, targetFrontmost: $0)) }
        var reports = [IdleReport]()
        while reported < thresholds.count && now - last >= thresholds[reported].seconds {
            reports.append(IdleReport(idleMs: thresholds[reported].idleMs, kinds: kinds.map { $0.rawValue }.sorted(), target: target))
            reported += 1
        }
        if reported == thresholds.count { lastInputAt = nil; kinds = []; reported = 0 }
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

// MARK: The flags a posted event carries

/// The modifier bits a chord may name (CMD, CTRL, ALT, SHIFT in `keys`): the
/// only bits an event the helper posts ever carries.
let requestableModifiers: CGEventFlags = [.maskCommand, .maskControl, .maskAlternate, .maskShift]
/**
 The flags an event goes out with: exactly the modifiers the action asked for,
 and nothing the event was created with. A `CGEvent(keyboardEventSource: nil,
 …)` or `CGEvent(mouseEventSource: nil, …)` copies the session's modifier
 state into its flags at creation, so a key the person holds — or one the
 system believes they hold — rides on every event the helper posts unless the
 flags are set. Live 2026-09-20: from 05:37 PT every `type_text` into a Safari
 field lost its text (the page's text nodes never grew, forms posted empty;
 checkin-flight-seat 3/3 → 0/4, booking-table-pause-before-confirm 3/3 → 0/4)
 while the click that focused the field read `focused` and the per-character
 focus check stayed silent; at 12:15 PT `CGEventSource.flagsState` for the
 combined session and the HID system both read Fn (`maskSecondaryFn`, raw
 0x20800000) held, the owner away from the keyboard since 05:36, so each typed
 character had gone out as Globe+<char> — a system shortcut or nothing, never
 text — and each pointer click as an Fn-click. One synthetic release of Fn
 cleared the state and the next typing landed. `created` is the event's own
 flags at the call (the session's copy); it is replaced, never merged, and an
 intended bit outside the four chord modifiers is not posted either.
 */
func postedFlags(intended: CGEventFlags, created: CGEventFlags) -> CGEventFlags {
    intended.intersection(requestableModifiers)
}
/// The modifier words a frame reports, in this order, each from one flag bit.
let modifierWordOrder: [(flag: CGEventFlags, word: String)] = [
    (.maskSecondaryFn, "fn"), (.maskCommand, "command"), (.maskShift, "shift"),
    (.maskAlternate, "option"), (.maskControl, "control"), (.maskAlphaShift, "capslock"),
]
/**
 The session's modifier state as a fixed word list (ScreenContext.modifiers,
 Surface.modifiers): one word per held modifier from `modifierWordOrder`,
 empty when none is held. Content-free by construction: the words are the
 six above and no other, whatever bits the flags carry.
 */
func modifierWords(_ flags: CGEventFlags) -> [String] {
    modifierWordOrder.filter { flags.contains($0.flag) }.map { $0.word }
}

// Synthetic buttons and keys the helper has pressed and not yet released, so
// every exit path can release them before the process disappears. Input posted
// to a bound process (a background run) is released to that same process;
// otherwise to the HID stream it went out on.
struct HeldInput: Equatable {
    var leftButton: CGPoint? = nil
    var rightButton: CGPoint? = nil
    var keys: [CGKeyCode] = []
    var targetPid: pid_t? = nil
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
