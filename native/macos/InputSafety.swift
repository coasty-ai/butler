import Foundation
import CoreGraphics

let browserAppIDs = ["com.apple.Safari", "com.google.Chrome", "com.google.Chrome.canary", "org.mozilla.firefox", "com.brave.Browser", "com.microsoft.edgemac"]

func independentNavigationShortcut(_ action:[String:Any], appId:String) -> Bool {
    // open_app launches a natively verified bundle; it does not target pixels.
    if action["type"] as? String == "open_app" {return true}
    if action["type"] as? String == "key" {return action["key"] as? String == "ESC"}
    guard action["type"] as? String == "hotkey",let keys=action["keys"] as? [String] else{return false}
    let chord=keys.sorted().joined(separator:"+")
    return ["CMD+SPACE","CMD+TAB","CMD+SHIFT+TAB","CMD+F"].contains(chord) || (chord == "CMD+L" && browserAppIDs.contains(appId))
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
// posted position by less than a pixel, usually with a zero hardware delta.
// Those are not user takeover. Movement of 3 px or a hardware delta of 3 is
// always takeover; outside the short grace window after resume or our own
// pointer input, any hardware delta with at least 1 px of travel is too.
func pointerTakeover(previous: CGPoint?, current: CGPoint, deltaX: Int64, deltaY: Int64, graceActive: Bool) -> Bool {
    guard let previous = previous else { return false }
    let distance = hypot(current.x - previous.x, current.y - previous.y)
    if distance >= 3 || max(abs(deltaX), abs(deltaY)) >= 3 { return true }
    return !graceActive && (deltaX != 0 || deltaY != 0) && distance >= 1
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
