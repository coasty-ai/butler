import Foundation
import CoreGraphics

/**
 Working in a window the user is not looking at (.data/design/background-actuation.md).

 The pure rules for a bound target: which rungs of the actuation ladder an
 action may take and in what order, when a rung is skipped for the rest of a
 run, how a delivery is judged from what was read back, how much of the window
 other windows cover and which parts of it the user's own pointer can reach,
 whether the user's input is aimed at it, and whether the binding still names
 the process it was minted for. The helper does the accessibility reads, the
 captures and the posting; nothing here touches AppKit.
 */

// MARK: Rungs

/// The ways an action reaches a bound window, in the order they are tried:
/// accessibility (no events at all), events posted to the bound process, and
/// today's foreground path after an announcement. The runner names the rungs
/// it allows for a step; the helper never performs the foreground one itself.
enum Rung: String, CaseIterable { case ax, post, foreground }

/// Fixed refusal codes of a bound run, stable for the runner and the trace.
enum TargetRefusal: String, CaseIterable {
    case gone = "TARGET_GONE"
    case protected = "TARGET_PROTECTED"
    case minimized = "TARGET_MINIMIZED"
    case offSpace = "TARGET_OFF_SPACE"
    case coveredStale = "TARGET_COVERED_STALE"
    case noEffect = "RUNG_NO_EFFECT"
    case unavailable = "RUNG_UNAVAILABLE"
    case keyboardAmbiguous = "KEYBOARD_AMBIGUOUS"
}

/**
 What kind of application owns the window (design §5). Chromium browsers and
 Electron render their content in another process: the renderer drops events
 posted to the process and an accessibility write can echo back without being
 rendered, so both take the same stricter rules. Firefox is grouped with them:
 its renderer is out of process too and its behaviour is unmeasured. WebKit
 (Safari) accepts accessibility writes and a posted wheel.
 */
enum TargetAppClass: String {
    case appKit, webKit, chromium, electron
    var multiprocessWeb: Bool { self == .chromium || self == .electron }
    var web: Bool { self != .appKit }
}
func targetAppClass(bundleId: String, electronFramework: Bool) -> TargetAppClass {
    if bundleId == "com.apple.Safari" { return .webKit }
    if browserAppIDs.contains(bundleId) { return .chromium }
    return electronFramework ? .electron : .appKit
}

/// What the helper knows about the bound window when an action is planned.
struct TargetFacts: Equatable {
    var appClass: TargetAppClass = .appKit
    var minimized = false
    var onScreen = true
    /// The bound window is the application's focused window.
    var focusedWindow = true
    /// Other unminimized windows the application owns.
    var siblingWindows = 0
}

/// Actions that have no background route at all: a drag needs the real
/// pointer, a move has no cursor to move, and launching is not a step in the
/// bound window.
let backgroundUnavailableActions: Set<String> = ["drag", "move", "open_app", "open_file", "monitor", "wait", "capture", "done"]
private let pointerActions: Set<String> = ["click", "double_click", "right_click", "click_control", "scroll"]
private let keyboardActions: Set<String> = ["type_text", "key", "hotkey"]

/**
 The rungs a step tries, in order, among those the runner allowed, and the
 code when none is left (design §2.5).

 Accessibility first wherever the action can be named: a control, a hit-tested
 element, a menu item, a text write, ENTER on a default button. Posting to the
 process needs a window with on-screen bounds (pointer events) and, for keys,
 an application whose only unminimized window is the bound one, so a keystroke
 cannot land in a sibling. A posted wheel is refused for Chromium and Electron.
 Rungs a run has already seen miss twice are skipped; when that leaves nothing,
 the code says the background has no effect here.
 */
func backgroundRungs(_ action: [String: Any], requested: [Rung], facts: TargetFacts, menuShortcut: Bool = false, skipped: Set<Rung> = []) -> (rungs: [Rung], code: TargetRefusal?) {
    let type = action["type"] as? String ?? ""
    guard !backgroundUnavailableActions.contains(type), pointerActions.contains(type) || keyboardActions.contains(type) || type == "menu_item" else { return ([], .unavailable) }
    var routes = [Rung](), dropped: TargetRefusal? = nil
    switch type {
    case "click", "right_click", "click_control", "scroll", "menu_item", "type_text": routes.append(.ax)
    case "key" where action["key"] as? String == "ENTER": routes.append(.ax)
    case "hotkey" where menuShortcut: routes.append(.ax)
    default: break
    }
    if type != "menu_item" {
        if pointerActions.contains(type) {
            if facts.minimized { dropped = .minimized }
            else if !facts.onScreen { dropped = .offSpace }
            else if type == "scroll" && facts.appClass.multiprocessWeb { dropped = .unavailable }
            else { routes.append(.post) }
        } else if facts.focusedWindow && facts.siblingWindows == 0 { routes.append(.post) }
        else { dropped = .keyboardAmbiguous }
    }
    let allowed = routes.filter { requested.contains($0) }
    let rungs = allowed.filter { !skipped.contains($0) }
    if !rungs.isEmpty { return (rungs, nil) }
    if !allowed.isEmpty { return ([], .noEffect) }
    return ([], dropped ?? .unavailable)
}

/// Rungs that read as no effect for an application in this run. Two misses on
/// the same rung for the same action kind skip it for the rest of the run
/// (design §2.7); the store is reset when a target is bound.
struct RungMisses: Equatable {
    static let limit = 2
    private(set) var counts = [String: Int]()
    private static func key(_ appId: String, _ type: String, _ rung: Rung) -> String { appId.lowercased() + "|" + type + "|" + rung.rawValue }
    mutating func record(appId: String, type: String, rung: Rung) {
        counts[RungMisses.key(appId, type, rung), default: 0] += 1
    }
    func skipped(appId: String, type: String) -> Set<Rung> {
        Set(Rung.allCases.filter { counts[RungMisses.key(appId, type, $0)] ?? 0 >= RungMisses.limit })
    }
}

// MARK: Postconditions

/// How a delivery read: something observable changed, nothing did, or the
/// application answered in a way that proves nothing (a write it echoed back).
enum RungEffect: String { case changed, none, unverifiable }

/// One reading of the bound window around a delivery: the controls hash of its
/// tree, the value of the field acted on, how many windows the application
/// shows, and its image.
struct TargetObservation {
    let controls: String
    let fieldValue: String?
    let windowCount: Int
    let pixels: ScreenPixels?
}

/// What changed between two readings, as the result reports it to the runner.
struct PostconditionRead: Equatable {
    var controlsChanged = false
    var fieldChanged = false
    var windowCountChanged = false
    var targetPixelsChanged = false
    var windowPixelsChanged = false
    var any: Bool { controlsChanged || fieldChanged || windowCountChanged || targetPixelsChanged || windowPixelsChanged }
    var dictionary: [String: Any] {
        ["controls": controlsChanged, "field": fieldChanged, "windows": windowCountChanged, "targetPixels": targetPixelsChanged, "windowPixels": windowPixelsChanged]
    }
}

/**
 The postcondition read of design §2.7: the controls hash, the field's value,
 the window count, and the image in the target's rectangle (a small change
 there counts) and across the whole window. `targetRect` is in image pixels.
 A missing image on either side reads as unchanged pixels: only what was seen
 counts as evidence.
 */
func postconditionRead(before: TargetObservation, after: TargetObservation, targetRect: CGRect?) -> PostconditionRead {
    var read = PostconditionRead()
    read.controlsChanged = before.controls != after.controls
    read.fieldChanged = before.fieldValue != after.fieldValue
    read.windowCountChanged = before.windowCount != after.windowCount
    if let old = before.pixels, let fresh = after.pixels {
        read.windowPixelsChanged = old.changed(comparedTo: fresh, in: CGRect(x: 0, y: 0, width: old.width, height: old.height), target: false)
        if let rect = targetRect { read.targetPixelsChanged = old.changed(comparedTo: fresh, in: rect, target: true) }
    }
    return read
}
func postconditionVerdict(_ read: PostconditionRead) -> RungEffect { read.any ? .changed : RungEffect.none }

/**
 How a text write is judged (design §2.6). The field is read back after the
 write; equal to the expectation is confirmed, except in a Chromium or Electron
 web area, which echoes a value it did not render: there the field's pixels
 must have changed too, and an echo without a visible change is unverifiable,
 which the runner treats as not typed. A read-back that differs is no effect.
 */
func writeVerdict(readBack: String?, expected: String, echoRisk: Bool, fieldPixelsChanged: Bool) -> RungEffect {
    guard readBack == expected else { return RungEffect.none }
    if !echoRisk || fieldPixelsChanged { return .changed }
    return .unverifiable
}

/// The result of executeTarget as the runner reads it: what was tried, how it
/// read, and the code when the runner has to decide the next rung itself.
func targetResult(rung: Rung?, effect: RungEffect?, code: TargetRefusal?, read: PostconditionRead?) -> [String: Any] {
    var result: [String: Any] = ["executed": rung != nil]
    if let rung { result["rung"] = rung.rawValue }
    if let effect { result["effect"] = effect.rawValue }
    if let code { result["code"] = code.rawValue }
    if let read { result["observed"] = read.dictionary }
    return result
}

// MARK: Coordinates

/// The screen point of a fraction of the window image, from the window's frame
/// as it is now: the last row or column at the far edge, as execute() does for
/// the display. Nil for a fraction outside the image or a frame too small.
func windowPoint(x: Double, y: Double, in window: CGRect) -> CGPoint? {
    guard x.isFinite, y.isFinite, x >= 0, x <= 1, y >= 0, y <= 1, window.width >= 1, window.height >= 1 else { return nil }
    return CGPoint(x: window.minX + min(window.width - 1, floor(x * window.width)), y: window.minY + min(window.height - 1, floor(y * window.height)))
}
/// A screen rectangle as pixels of the window image: relative to the window's
/// frame, scaled by the image's ratio to it.
func imageRect(_ rect: CGRect, window: CGRect, imageWidth: Int, imageHeight: Int) -> CGRect {
    guard window.width > 0, window.height > 0 else { return .null }
    let sx = Double(imageWidth) / window.width, sy = Double(imageHeight) / window.height
    return CGRect(x: (rect.minX - window.minX) * sx, y: (rect.minY - window.minY) * sy, width: rect.width * sx, height: rect.height * sy)
}

// MARK: Coverage

/**
 The parts of a window's frame that no window above it covers, as screen
 rectangles: the frame minus the union of the rectangles above it, cut along
 every edge and merged along rows. The frame itself when nothing is above it;
 empty when it is fully covered.
 */
func uncoveredRects(of frame: CGRect, above: [CGRect]) -> [CGRect] {
    guard frame.width > 0, frame.height > 0 else { return [] }
    let covering = above.map { $0.intersection(frame) }.filter { !$0.isNull && $0.width > 0 && $0.height > 0 }
    guard !covering.isEmpty else { return [frame] }
    let xs = Array(Set([frame.minX, frame.maxX] + covering.flatMap { [$0.minX, $0.maxX] })).sorted()
    let ys = Array(Set([frame.minY, frame.maxY] + covering.flatMap { [$0.minY, $0.maxY] })).sorted()
    var result = [CGRect]()
    for row in 0..<(ys.count - 1) {
        var run: CGRect? = nil
        for column in 0..<(xs.count - 1) {
            let cell = CGRect(x: xs[column], y: ys[row], width: xs[column + 1] - xs[column], height: ys[row + 1] - ys[row])
            let centre = CGPoint(x: cell.midX, y: cell.midY)
            if covering.contains(where: { $0.contains(centre) }) {
                if let open = run { result.append(open); run = nil }
            } else {
                run = run.map { $0.union(cell) } ?? cell
            }
        }
        if let open = run { result.append(open) }
    }
    return result
}
/// How much of the frame the windows above it cover, 0 to 1.
func coverage(of frame: CGRect, above: [CGRect]) -> Double {
    guard frame.width > 0, frame.height > 0 else { return 1 }
    let uncovered = uncoveredRects(of: frame, above: above).reduce(0.0) { $0 + Double($1.width * $1.height) }
    return max(0, min(1, 1 - uncovered / Double(frame.width * frame.height)))
}
/// Covered means nothing of the window worth seeing is on screen; a sliver of
/// a title bar does not make its picture fresh.
let coveredThreshold = 0.98
func windowCovered(_ coverage: Double) -> Bool { coverage >= coveredThreshold }
/// WebKit and Chromium stop drawing a window that is fully covered, so its
/// picture may show the last frame before it was covered; AppKit keeps drawing.
func staleRisk(covered: Bool, appClass: TargetAppClass, webArea: Bool) -> Bool { covered && (appClass.web || webArea) }

// MARK: Takeover

/// Whether the user's pointer is inside the part of the bound window they can see.
func pointerInsideTarget(_ location: CGPoint, rects: [CGRect]) -> Bool { rects.contains { $0.contains(location) } }

/**
 Whether one unmarked event of the user's own was aimed at the bound window
 (design §3): a pointer event, hovering included, over the part of it no other
 window covers, or a key while the target application is frontmost. Read for
 every event, going or held, so the resume rule knows where the hands went
 last; whether it is also a takeover is takeoverScope's question.
 */
func inputInsideTarget(type: CGEventType, location: CGPoint, uncovered: [CGRect], targetFrontmost: Bool) -> Bool {
    switch type {
    case .keyDown: return targetFrontmost
    case .mouseMoved, .leftMouseDown, .rightMouseDown, .otherMouseDown, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .scrollWheel:
        return pointerInsideTarget(location, rects: uncovered)
    default: return false
    }
}

enum TakeoverScope: String { case screen, target }
/**
 What one unmarked event of the user's own means (design §3). Nothing bound,
 or the target brought forward for the announced handoff: today's rule, any
 input is a takeover of the screen. Bound: a press, drag or wheel inside the
 uncovered part of the window, or a key while the target is frontmost, is a
 takeover of the target; hovering over it and everything elsewhere is the user's
 normal life. The caller has already dropped pointer jitter and echoes.
 */
func takeoverScope(type: CGEventType, inside: Bool, bound: Bool, handoff: Bool) -> TakeoverScope? {
    guard bound, !handoff else { return .screen }
    switch type {
    case .leftMouseDown, .rightMouseDown, .otherMouseDown, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .scrollWheel, .keyDown:
        return inside ? .target : nil
    default: return nil
    }
}
func takeoverScope(type: CGEventType, location: CGPoint, bound: Bool, handoff: Bool, uncovered: [CGRect], targetFrontmost: Bool) -> TakeoverScope? {
    takeoverScope(type: type, inside: inputInsideTarget(type: type, location: location, uncovered: uncovered, targetFrontmost: targetFrontmost), bound: bound, handoff: handoff)
}

/// The target came to the front: by the user's hand when their own input was
/// within 0.3 s, as expected during the handoff, or by activating itself.
enum TargetActivation: Equatable { case userEntered, selfActivated, expected }
let selfActivationWindow: TimeInterval = 0.3
func targetActivation(lastManualInputAt: TimeInterval?, now: TimeInterval, handoff: Bool) -> TargetActivation {
    if handoff { return .expected }
    if let last = lastManualInputAt, now - last <= selfActivationWindow, now >= last { return .userEntered }
    return .selfActivated
}

// MARK: Naming the target

/**
 The application the words name (design §2.2, rule 1), decided from the
 launcher's resolution of the words over the installed applications and the
 bundle identifiers running now. Words that name no installed application, or
 several, are a plain refusal: the runner tries its next candidate. An installed
 application that is not running is TARGET_GONE: the run says so and opens it in
 front. A protected one is TARGET_PROTECTED. Nothing is matched by a running
 application's name alone, so "Notes" is the launcher's Notes and nothing else.
 */
enum TargetNameResolution: Equatable {
    case running(bundleId: String, name: String)
    case notRunning(name: String)
    case protected
    case unknown
}
func resolveTargetName(_ resolution: LaunchResolution, runningBundleIds: Set<String>) -> TargetNameResolution {
    switch resolution {
    case .resolved(let appId, let name, _):
        return runningBundleIds.contains(appId.lowercased()) ? .running(bundleId: appId, name: name) : .notRunning(name: name)
    case .refused: return .protected
    case .ambiguous, .unresolved: return .unknown
    }
}

// MARK: The handoff

/// A handoff nobody closed (the runner died mid-step, or its restore never
/// came) ends on its own once the helper has sent no input for this long: the
/// flag clears and the application in front before comes back.
let handoffIdleLimit: TimeInterval = 20
/// Whether an open handoff has outlived the helper's own input by the limit.
func handoffExpired(handoff: Bool, lastInputAt: TimeInterval, now: TimeInterval) -> Bool {
    handoff && now - lastInputAt >= handoffIdleLimit
}

// MARK: Binding validity

/// The process a binding was minted for: its pid, bundle identifier and launch
/// time, so a recycled pid is never the same target.
struct TargetIdentity: Equatable {
    let pid: pid_t
    let bundleId: String
    let launchedAt: TimeInterval?
}
/// Whether the binding still names its process and that process still owns
/// the window. Nothing is re-resolved by name: a target that is gone is gone.
func targetLive(bound: TargetIdentity, running: TargetIdentity?, windowOwner: pid_t?) -> Bool {
    guard let running, running == bound, let owner = windowOwner else { return false }
    return owner == bound.pid
}
