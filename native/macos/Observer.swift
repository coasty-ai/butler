import Foundation
import CoreGraphics

/**
 Watching how the owner works (.data/design/observer.md §2, lane O1).

 The pure rules of the observe stream: what `observe {on, tier, everyMs}`
 accepts, which exclusion a moment falls under, what a frame carries at each
 tier and what it never carries, the redaction of titles, labels and text
 digests, how the owner's own input becomes content-free actions (a press
 with its hit-tested target, a chord, a typing burst as a count, a second of
 wheel as ticks, a switch, a menu path), the cadence that rate-limits frames,
 and the byte caps. The helper (Controller.swift, MARK: observe) does the
 accessibility reads, the screenshots and the tap; nothing here touches
 AppKit, so tests/native/ObserverTests.swift runs it as data.

 Limits, stated once and pinned by the tests:
 - A frame goes out on a change (front application, window title, web host,
   focused role) and at most once per `everyMs` (1 s to 10 min, default
   20 s) while the owner is active: unmarked input within 60 s. Changes
   inside the window are coalesced into the next frame. Entering idle or
   the lock screen is said once, with nothing but the code; nothing follows
   until the owner is back.
 - Butler's own run (the latch lifted, a target bound or a spoken scroll
   under way) is an `own_run` frame with no application: main adds the
   runId. Secure event input, a secure field with focus, a protected
   application or page (watchRefused, watchDomainRefused) is a frame with
   the application's id and the code, nothing else.
 - Tier structure names the application, the window title, the page's host,
   the focused role and label, and up to 60 controls as role and label.
   Tier text adds the accessibility or OCR text, at most 1 500 UTF-16 units.
   Tier pixels adds a JPEG at most 512 px wide as base64, never for a
   browser page whose host is not known, and only when the frame stays under
   the cap with it: the picture is encoded smaller until it fits, or left out.
 - Every title, label, control name, menu title and digest passes
   redactSecrets (the credential shapes of src/core/sanitize.ts: private
   keys, API keys, bearer tokens, JWTs, password and one-time-code
   assignments) before it is bounded, so a cut never leaves half a secret.
 - A frame over 24 KB, or one that would take a minute past 200 KB, is
   dropped and counted; observe_dropped says so at most once a minute with
   the count since the last notice. Actions are not counted against the
   budget: they are bounded by their aggregation.
 - Actions come from the tap's unmarked events only. A press is a click, a
   double click (the second press of a pair, the first is held 0.45 s and
   folded in) or a right click with the hit-tested role and label; a press
   on a menu item is menu_item with the path the menu bar shows. A key with
   Command, Control or Option is a chord named by the layout ("CMD+S"); a
   command key alone (RETURN, TAB, ESC, arrows, paging, function keys) is a
   chord too; any other key is typing, counted into a burst per field that
   ends after 1.5 s without a key or when the focus moves, and the burst
   carries the field's label and a count, never a character. CMD+TAB is not
   said as a chord: the activation it causes is app_switch, as is the one a
   Dock press causes (held 1.5 s for it; a Dock press nothing follows is a
   click). A secure field yields no typing and no chord at all, and a press
   on one is labelled "secure field".
 - What the helper cannot see: a menu picked by pressing, dragging and
   releasing (the release is not tapped), a menu an application draws
   itself, and a switch by clicking into another window (a click, and the
   frame that follows). A key is named by the keyboard layout's own
   character where it has one, else by the US position of the key.
 */

// MARK: Options

enum ObserveTier: String, Comparable {
    case structure, text, pixels
    private var rank: Int { switch self { case .structure: return 0; case .text: return 1; case .pixels: return 2 } }
    static func < (a: ObserveTier, b: ObserveTier) -> Bool { a.rank < b.rank }
}
let observeEveryMsDefault = 20_000
let observeEveryMsRange = 1_000...600_000
struct ObserveOptions: Equatable {
    let on: Bool
    let tier: ObserveTier
    let everyMs: Int
    /// What `observe {on, tier, everyMs}` means: `on` must be a flag, a
    /// missing tier is structure and an unknown one is refused (nil), a
    /// missing or unusable cadence is the default and any other is clamped.
    init?(command: [String: Any]) {
        guard let on = command["on"] as? Bool else { return nil }
        self.on = on
        if let raw = command["tier"] {
            guard let name = raw as? String, let tier = ObserveTier(rawValue: name) else { return nil }
            self.tier = tier
        } else { tier = .structure }
        let raw = (command["everyMs"] as? Int).map(Double.init) ?? command["everyMs"] as? Double
        if let raw, raw.isFinite { everyMs = min(max(Int(raw), observeEveryMsRange.lowerBound), observeEveryMsRange.upperBound) }
        else { everyMs = observeEveryMsDefault }
    }
}

// MARK: Exclusions

enum ObserveExclusion: String, CaseIterable { case secureInput = "secure_input", protected, locked, ownRun = "own_run", idle }
/// Unmarked input older than this means nobody is working here.
let observeIdleSeconds: Double = 60
/// The exclusion a moment falls under, in the order the stream states them:
/// the lock screen first (nothing behind it is read), then Butler's own run,
/// then an owner who has left, then secure input, then a protected surface.
/// The first three are states the stream says once on entry (nothing is
/// read from the front while they last); the last two are read per change.
func observeExclusion(secureInput: Bool, protected: Bool, locked: Bool, ownRun: Bool, idleSeconds: Double) -> ObserveExclusion? {
    if locked { return .locked }
    if ownRun { return .ownRun }
    if idleSeconds > observeIdleSeconds { return .idle }
    if secureInput { return .secureInput }
    if protected { return .protected }
    return nil
}

// MARK: Redaction

let observeSecretPlaceholder = "[Sensitive text omitted]"
private let observeCommonValues = "enabled|disabled|required|optional|none|null|true|false|reset|forgot|change|changed|show|hide|protected|expired|updated|manager|field|hint|strength|policy|monthly|weekly|weak|strong|medium|incorrect|invalid|wrong|below|here"
/// The credential shapes src/core/sanitize.ts blocks (BLOCK_UPLOAD), as ICU
/// patterns: a private key block, an API key, a bearer token, a JWT, a
/// password or key assignment, a one-time code assignment.
let observeSecretDetectors: [NSRegularExpression] = [
    #"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)"#,
    #"\b(?:sk-[\w-]{12,}|AKIA[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{20,}|AIza[\w-]{25,})\b"#,
    #"(?i)\bbearer\s+(?=[A-Za-z]*[0-9._~+/-])[A-Za-z0-9._~+/-]{12,}=*"#,
    #"(?i)\beyJ[\w-]+\.[\w-]+\.[\w-]+\b"#,
    #"(?i)\b(?:password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*(?!(?:"# + observeCommonValues
        + #")(?![^\s,;.!?]))(?:(?=[^\s,;]{0,4}[^\s\p{L},;.!?:])[^\s,;]{4,5}(?![^\s,;])|[^\s,;]{6,})"#,
    #"(?i)\b(?:mfa|otp)(?:\s*code)?\s*[:=]\s*(?=[A-Za-z]*\d)[A-Za-z0-9]{4,10}\b"#,
].compactMap { try? NSRegularExpression(pattern: $0) }
/// Replaces every credential-shaped span with the placeholder and keeps the
/// rest, as redactSecrets does in TypeScript. Overlapping spans merge.
func redactSecrets(_ text: String, placeholder: String = observeSecretPlaceholder) -> String {
    guard !text.isEmpty else { return text }
    let source = text as NSString
    let whole = NSRange(location: 0, length: source.length)
    var ranges = [NSRange]()
    for detector in observeSecretDetectors {
        for match in detector.matches(in: text, range: whole) where match.range.length > 0 { ranges.append(match.range) }
    }
    guard !ranges.isEmpty else { return text }
    ranges.sort { $0.location < $1.location }
    var result = "", cursor = 0
    for range in ranges {
        let end = range.location + range.length
        if end <= cursor { continue }
        let start = max(cursor, range.location)
        result += source.substring(with: NSRange(location: cursor, length: start - cursor)) + placeholder
        cursor = end
    }
    return result + source.substring(from: cursor)
}
/// Whether the text carries a credential shape at all.
func carriesSecret(_ text: String) -> Bool {
    let whole = NSRange(location: 0, length: (text as NSString).length)
    return observeSecretDetectors.contains { $0.firstMatch(in: text, range: whole) != nil }
}
/// A title, label or digest as the stream carries it: redacted first, then
/// trimmed and bounded by UTF-16 units, so a cut never leaves half a secret.
func observeText(_ raw: String, limit: Int) -> String {
    utf16Prefix(redactSecrets(raw).trimmingCharacters(in: .whitespacesAndNewlines), limit).trimmingCharacters(in: .whitespacesAndNewlines)
}
let observeSecureFieldLabel = "secure field"
/// A field's or control's label: a secure field is named as such and never
/// by its own label, which can be the value it hides.
func observeLabel(_ raw: String, secure: Bool, limit: Int = observeLabelLimit) -> String {
    secure ? observeSecureFieldLabel : observeText(raw, limit: limit)
}

// MARK: Frames

let observeTitleLimit = 120
let observeLabelLimit = 120
let observeAppNameLimit = 100
let observeControlLimit = 60
let observeControlLabelLimit = 80
let observeTextLimit = 1_500
let observeImageMaxWidth = 512
let observeFrameMaxBytes = 24 * 1024
let observeMinuteBudgetBytes = 200 * 1024

struct ObserveControl: Equatable { let role: String; let label: String }
/// What the helper read for one frame. Labels and text arrive raw and are
/// redacted and bounded here; `images` are JPEG renditions at most 512 px
/// wide, largest first, of which the first that fits the byte cap is used.
struct ObserveReadings: Equatable {
    var appId = ""
    var appName = ""
    var windowTitle = ""
    var host: String? = nil
    var browser = false
    var focusedRole: String? = nil
    var focusedLabel = ""
    var focusedSecure = false
    var controls: [ObserveControl] = []
    var visibleText = ""
    var images: [Data] = []
}
/// The change key of a frame: the four facts the design names, raw (it is
/// never emitted), so a redacted title that reads the same still compares
/// by what the window really shows.
func observeSignature(appId: String, windowTitle: String, host: String?, focusedRole: String?) -> String {
    [appId, windowTitle, host ?? "", focusedRole ?? ""].joined(separator: "\u{1}")
}
/// The JSON size of an event, as the caps count it; an unencodable object counts as over every cap.
func observeBytes(_ object: [String: Any]) -> Int {
    (try? JSONSerialization.data(withJSONObject: object))?.count ?? Int.max
}
/// A picture never goes out for a browser page whose host is not known.
func observeImageAllowed(browser: Bool, host: String?) -> Bool {
    !browser || !(host ?? "").isEmpty
}
/// The largest rendition that keeps the frame under the cap, as base64; nil leaves the frame without a picture.
func observeImageFitting(_ candidates: [Data], frameBytes: Int, cap: Int = observeFrameMaxBytes) -> String? {
    for data in candidates where !data.isEmpty {
        let encoded = data.base64EncodedString()
        // "image":"…", with its quotes, colon and comma.
        if frameBytes + encoded.utf8.count + 12 <= cap { return encoded }
    }
    return nil
}
/**
 One frame as the stream emits it. With an exclusion: the code, and the
 application's id for secure input and a protected surface only (main adds
 the runId to own_run; locked and idle carry nothing). Without: the
 structure, then the text digest from tier text, then the picture at tier
 pixels when the page allows one and it fits.
 */
func observeFrame(_ readings: ObserveReadings, tier: ObserveTier, exclusion: ObserveExclusion?, atMs: Int) -> [String: Any] {
    var frame: [String: Any] = ["event": "observe_frame", "atMs": atMs]
    if let exclusion {
        frame["excluded"] = exclusion.rawValue
        if (exclusion == .secureInput || exclusion == .protected), !readings.appId.isEmpty { frame["appId"] = readings.appId }
        return frame
    }
    frame["appId"] = readings.appId.isEmpty ? "unknown" : readings.appId
    let appName = observeText(readings.appName, limit: observeAppNameLimit)
    if !appName.isEmpty { frame["appName"] = appName }
    let title = observeText(readings.windowTitle, limit: observeTitleLimit)
    if !title.isEmpty { frame["windowTitle"] = title }
    if let host = readings.host, !host.isEmpty { frame["host"] = host }
    if let role = readings.focusedRole, !role.isEmpty { frame["focusedRole"] = role }
    let label = observeLabel(readings.focusedLabel, secure: readings.focusedSecure)
    if !label.isEmpty { frame["focusedLabel"] = label }
    frame["controls"] = readings.controls.prefix(observeControlLimit).map { ["role": $0.role, "label": observeText($0.label, limit: observeControlLabelLimit)] }
    if tier >= .text {
        let digest = observeText(readings.visibleText, limit: observeTextLimit)
        if !digest.isEmpty { frame["textDigest"] = digest }
    }
    if tier == .pixels, observeImageAllowed(browser: readings.browser, host: readings.host),
       let image = observeImageFitting(readings.images, frameBytes: observeBytes(frame)) {
        frame["image"] = image
    }
    return frame
}

// MARK: Cadence

/// Frames go out on a change, at most one per `everyMs`; a change inside the
/// window waits for the window to open and goes out with what is there then.
struct ObserveCadence: Equatable {
    let everyMs: Int
    private(set) var lastFrameAt: TimeInterval? = nil
    private(set) var pending = false
    init(everyMs: Int) { self.everyMs = min(max(everyMs, observeEveryMsRange.lowerBound), observeEveryMsRange.upperBound) }
    mutating func changed() { pending = true }
    func due(now: TimeInterval) -> Bool {
        pending && (lastFrameAt.map { now - $0 >= Double(everyMs) / 1000 } ?? true)
    }
    mutating func sent(at now: TimeInterval) { lastFrameAt = now; pending = false }
}
enum ObserveDecision: Equatable { case nothing, frame, transition(ObserveExclusion) }
/// States said once on entry, with no reading of the front while they last.
let observeTransitionStates: Set<ObserveExclusion> = [.locked, .ownRun, .idle]
/**
 What one tick of the sampler does with what it read: nothing, a frame (the
 change key differs from the last frame's and the cadence allows one), or
 the one transition frame said on entering the lock screen, Butler's own run
 or idle. Those three states are not part of the cadence: they are said once
 and nothing follows until they end, and coming back from any of them is a
 change. Secure input and a protected surface are part of the key, so a
 password field taking focus in the same window is a change.
 */
struct ObserveTracker: Equatable {
    private(set) var cadence: ObserveCadence
    private(set) var lastKey: String? = nil
    private(set) var lastExclusion: ObserveExclusion? = nil
    init(everyMs: Int) { cadence = ObserveCadence(everyMs: everyMs) }
    mutating func decide(signature: String, exclusion: ObserveExclusion?, now: TimeInterval) -> ObserveDecision {
        let previous = lastExclusion
        lastExclusion = exclusion
        if let exclusion, observeTransitionStates.contains(exclusion) {
            lastKey = nil
            return previous == exclusion ? .nothing : .transition(exclusion)
        }
        let key = (exclusion?.rawValue ?? "") + "|" + signature
        if key != lastKey { cadence.changed() }
        guard cadence.due(now: now) else { return .nothing }
        cadence.sent(at: now)
        lastKey = key
        return .frame
    }
}

// MARK: Byte caps

enum ObserveDropReason: String { case frameTooLarge = "frame_too_large", minuteBudget = "minute_budget" }
let observeDroppedNoticeInterval: TimeInterval = 60
/// The two caps on frames: one frame's size and a minute's total. Drops are
/// counted; the notice goes out with the first drop and then at most once a
/// minute, carrying the count since the last notice.
struct ObserveBudget: Equatable {
    enum Verdict: Equatable { case send, drop(ObserveDropReason, notice: Int?) }
    private(set) var windowStartedAt: TimeInterval? = nil
    private(set) var usedBytes = 0
    private(set) var lastNoticeAt: TimeInterval? = nil
    private(set) var droppedSinceNotice = 0
    private(set) var dropped = 0
    mutating func admit(bytes: Int, now: TimeInterval) -> Verdict {
        if let started = windowStartedAt, now - started >= 60 { windowStartedAt = nil; usedBytes = 0 }
        let reason: ObserveDropReason? = bytes > observeFrameMaxBytes ? .frameTooLarge : usedBytes + bytes > observeMinuteBudgetBytes ? .minuteBudget : nil
        guard let reason else {
            if windowStartedAt == nil { windowStartedAt = now }
            usedBytes += bytes
            return .send
        }
        dropped += 1
        droppedSinceNotice += 1
        if lastNoticeAt.map({ now - $0 >= observeDroppedNoticeInterval }) ?? true {
            let count = droppedSinceNotice
            droppedSinceNotice = 0
            lastNoticeAt = now
            return .drop(reason, notice: count)
        }
        return .drop(reason, notice: nil)
    }
}

// MARK: Actions

/// The pointer action a press is: the second press of a pair is the double
/// click, a third press (a selection gesture) is nothing more.
enum ObservePointer: String { case click, doubleClick = "double_click", rightClick = "right_click" }
func observePointerKind(type: CGEventType, clickState: Int64) -> ObservePointer? {
    switch type {
    case .leftMouseDown: return clickState >= 3 ? nil : clickState == 2 ? .doubleClick : .click
    case .rightMouseDown: return .rightClick
    case .otherMouseDown: return .click
    default: return nil
    }
}

/// What one key press is to the stream: a chord with a name, a keystroke
/// counted into a typing burst, or nothing (a modifier alone, fn, caps lock).
enum ObservedKey: Equatable { case chord(String), character, ignored }
/// Keys that are commands on their own, by virtual key code.
let observeCommandKeys: [Int64: String] = [
    36: "RETURN", 76: "ENTER", 48: "TAB", 53: "ESC", 123: "LEFT", 124: "RIGHT", 125: "DOWN", 126: "UP",
    115: "HOME", 119: "END", 116: "PAGEUP", 121: "PAGEDOWN",
    122: "F1", 120: "F2", 99: "F3", 118: "F4", 96: "F5", 97: "F6", 98: "F7", 100: "F8", 101: "F9", 109: "F10", 103: "F11", 111: "F12",
]
/// Keys named for a chord by their US position when the layout gives no single character.
let observePositionKeys: [Int64: String] = [
    0: "A", 11: "B", 8: "C", 2: "D", 14: "E", 3: "F", 5: "G", 4: "H", 34: "I", 38: "J", 40: "K", 37: "L", 46: "M", 45: "N", 31: "O", 35: "P",
    12: "Q", 15: "R", 1: "S", 17: "T", 32: "U", 9: "V", 13: "W", 7: "X", 16: "Y", 6: "Z",
    29: "0", 18: "1", 19: "2", 20: "3", 21: "4", 23: "5", 22: "6", 26: "7", 28: "8", 25: "9",
    49: "SPACE", 51: "BACKSPACE", 117: "DELETE", 27: "-", 24: "=", 33: "[", 30: "]", 42: "\\", 41: ";", 39: "'", 43: ",", 47: ".", 44: "/", 50: "`",
]
/// Modifiers alone, fn, caps lock and the keypad clear key: never an action.
let observeIgnoredKeys: Set<Int64> = [54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 71]
/// The modifiers a chord names, in the order the runner's hotkeys use.
func observeModifiers(_ flags: CGEventFlags) -> [String] {
    var names = [String]()
    if flags.contains(.maskCommand) { names.append("CMD") }
    if flags.contains(.maskControl) { names.append("CTRL") }
    if flags.contains(.maskAlternate) { names.append("ALT") }
    if flags.contains(.maskShift) { names.append("SHIFT") }
    return names
}
/// The key's name in a chord: the layout's single visible ASCII character
/// (uppercased), else its US position, else KEY. `layoutName` is read by the
/// helper only when a command modifier is down, never for typing.
func observeKeyName(keyCode: Int64, layoutName: String?) -> String {
    if let command = observeCommandKeys[keyCode] { return command }
    if let name = layoutName, name.unicodeScalars.count == 1, let scalar = name.unicodeScalars.first,
       scalar.isASCII, scalar.value > 32, scalar.value < 127 {
        return name.uppercased()
    }
    return observePositionKeys[keyCode] ?? "KEY"
}
func observeKey(keyCode: Int64, flags: CGEventFlags, layoutName: String? = nil) -> ObservedKey {
    if observeIgnoredKeys.contains(keyCode) { return .ignored }
    let modifiers = observeModifiers(flags)
    if modifiers.contains(where: { $0 != "SHIFT" }) {
        return .chord((modifiers + [observeKeyName(keyCode: keyCode, layoutName: layoutName)]).joined(separator: "+"))
    }
    if let command = observeCommandKeys[keyCode] { return .chord((modifiers + [command]).joined(separator: "+")) }
    return .character
}
/// The chords whose effect is an application switch, said as app_switch instead.
let observeSwitchChords: Set<String> = ["CMD+TAB", "CMD+SHIFT+TAB"]

/// An action's common shape; `atMs` is wall-clock milliseconds for the log.
func observeAction(kind: String, appId: String, atMs: Int, fields: [String: Any] = [:]) -> [String: Any] {
    var event: [String: Any] = ["event": "observe_action", "atMs": atMs, "appId": appId, "kind": kind]
    for (key, value) in fields { event[key] = value }
    return event
}

/// A typing burst: one field, a count of key presses, how long it took. The
/// characters are never here; the count includes space and backspace.
let observeTypingGap: TimeInterval = 1.5
let observeTypingMaxChars = 10_000
struct ObserveTypingBurst: Equatable {
    let appId: String
    let field: String
    var chars: Int
    let startedAt: TimeInterval
    let startedAtMs: Int
    var lastAt: TimeInterval
    var event: [String: Any] {
        observeAction(kind: "typing", appId: appId, atMs: startedAtMs,
                      fields: ["typed": ["field": field, "chars": chars, "ms": Int(((lastAt - startedAt) * 1000).rounded())]])
    }
}
struct ObserveTypingAggregator: Equatable {
    private(set) var burst: ObserveTypingBurst? = nil
    /// A keystroke in a field: the burst it ends, if the field, the
    /// application or a gap of 1.5 s separates it from the one open.
    mutating func key(appId: String, field: String, at now: TimeInterval, atMs: Int) -> ObserveTypingBurst? {
        var ended: ObserveTypingBurst? = nil
        if let open = burst, open.appId != appId || open.field != field || now - open.lastAt >= observeTypingGap { ended = open; burst = nil }
        if var open = burst {
            open.chars = min(open.chars + 1, observeTypingMaxChars)
            open.lastAt = max(open.lastAt, now)
            burst = open
        } else {
            burst = ObserveTypingBurst(appId: appId, field: field, chars: 1, startedAt: now, startedAtMs: atMs, lastAt: now)
        }
        return ended
    }
    /// The burst that has gone quiet for 1.5 s (or whatever is open, forced).
    mutating func flush(now: TimeInterval, force: Bool = false) -> ObserveTypingBurst? {
        guard let open = burst, force || now - open.lastAt >= observeTypingGap else { return nil }
        burst = nil
        return open
    }
}

/// A second of wheel in one direction, as ticks (wheel events with movement).
let observeScrollWindow: TimeInterval = 1.0
let observeScrollMaxTicks = 10_000
struct ObserveScrollBurst: Equatable {
    let appId: String
    let direction: String
    var ticks: Int
    let startedAt: TimeInterval
    let startedAtMs: Int
    var lastAt: TimeInterval
    var event: [String: Any] {
        observeAction(kind: "scroll", appId: appId, atMs: startedAtMs, fields: ["scroll": ["direction": direction, "ticks": ticks]])
    }
}
struct ObserveScrollAggregator: Equatable {
    private(set) var burst: ObserveScrollBurst? = nil
    /// One wheel movement: positive is up (the wheel's own sign), negative
    /// down, zero nothing. Returns the burst it closes, if any.
    mutating func wheel(appId: String, delta: Double, at now: TimeInterval, atMs: Int) -> ObserveScrollBurst? {
        guard delta != 0, delta.isFinite else { return nil }
        let direction = delta > 0 ? "up" : "down"
        var ended: ObserveScrollBurst? = nil
        if let open = burst, open.appId != appId || open.direction != direction || now - open.startedAt >= observeScrollWindow { ended = open; burst = nil }
        if var open = burst {
            open.ticks = min(open.ticks + 1, observeScrollMaxTicks)
            open.lastAt = max(open.lastAt, now)
            burst = open
        } else {
            burst = ObserveScrollBurst(appId: appId, direction: direction, ticks: 1, startedAt: now, startedAtMs: atMs, lastAt: now)
        }
        return ended
    }
    /// The second that has passed, or a wheel that has gone quiet for one.
    mutating func flush(now: TimeInterval, force: Bool = false) -> ObserveScrollBurst? {
        guard let open = burst, force || now - open.startedAt >= observeScrollWindow || now - open.lastAt >= observeScrollWindow else { return nil }
        burst = nil
        return open
    }
}

/// One press as the stream would say it, held briefly so a pair reads as one
/// double click and a Dock press can become the switch it causes.
let observeDoubleClickHold: TimeInterval = 0.45
let observeDockHold: TimeInterval = 1.5
struct ObservePress: Equatable {
    let kind: ObservePointer
    let appId: String
    let target: ObserveControl?
    let dock: Bool
    let at: TimeInterval
    let atMs: Int
    var event: [String: Any] {
        var fields = [String: Any]()
        if let target { fields["target"] = ["role": target.role, "label": target.label] }
        return observeAction(kind: kind.rawValue, appId: appId, atMs: atMs, fields: fields)
    }
}
struct ObservePressCoalescer: Equatable {
    private(set) var pending: ObservePress? = nil
    /// A press arrives: the held press it does not merge with goes out. A
    /// double click within the hold replaces the click that began the pair.
    mutating func press(_ press: ObservePress) -> ObservePress? {
        var out: ObservePress? = nil
        if let held = pending {
            if press.kind == .doubleClick, held.kind == .click, held.appId == press.appId, press.at - held.at <= observeDoubleClickHold {
                pending = press
                return nil
            }
            out = held
        }
        pending = press
        return out
    }
    /// The press that has waited its hold: a double click or right click at
    /// once, a click 0.45 s, a Dock press 1.5 s.
    mutating func flush(now: TimeInterval, force: Bool = false) -> ObservePress? {
        guard let held = pending else { return nil }
        let hold = held.dock ? observeDockHold : held.kind == .click ? observeDoubleClickHold : 0
        guard force || now - held.at >= hold else { return nil }
        pending = nil
        return held
    }
    /// The Dock press an activation consumes, if one is still held.
    mutating func takeDockPress(now: TimeInterval) -> ObservePress? {
        guard let held = pending, held.dock, now - held.at <= observeDockHold else { return nil }
        pending = nil
        return held
    }
}

/// CMD+TAB seen: the activation that follows within the window is the switch.
let observeSwitchWindow: TimeInterval = 1.5
struct ObserveSwitchWitness: Equatable {
    private(set) var chordAt: TimeInterval? = nil
    private(set) var chord: String? = nil
    /// Whether the chord is a switch chord (kept here, not said as a chord).
    mutating func saw(chord name: String, at now: TimeInterval) -> Bool {
        guard observeSwitchChords.contains(name) else { return false }
        chordAt = now
        chord = name
        return true
    }
    /// The chord that explains an activation now, if one is recent.
    func cause(now: TimeInterval) -> String? {
        guard let at = chordAt, let chord, now - at <= observeSwitchWindow, now >= at else { return nil }
        return chord
    }
    mutating func reset() { chordAt = nil; chord = nil }
}

/// The path of a picked menu item, from the elements above the hit: the item
/// first, up to the menu bar item. Nil when the press was not on a menu item.
struct ObserveAncestor: Equatable { let role: String; let title: String }
let observeMenuDepth = 6
let observeMenuTitleLimit = 60
func observeMenuPath(_ ancestry: [ObserveAncestor]) -> [String]? {
    guard ancestry.first?.role == "AXMenuItem" else { return nil }
    var path = [String]()
    for node in ancestry where node.role == "AXMenuItem" || node.role == "AXMenuBarItem" {
        let title = observeText(node.title, limit: observeMenuTitleLimit)
        if !title.isEmpty { path.append(title) }
        if node.role == "AXMenuBarItem" { break }
    }
    guard !path.isEmpty else { return nil }
    return Array(path.reversed().suffix(observeMenuDepth))
}
