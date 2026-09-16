import Foundation
import CoreGraphics

let browserAppIDs = ["com.apple.Safari", "com.google.Chrome", "com.google.Chrome.canary", "org.mozilla.firefox", "com.brave.Browser", "com.microsoft.edgemac"]

func independentNavigationShortcut(_ action:[String:Any], appId:String) -> Bool {
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

// Window/pill changes may re-emit the pointer's current location. This is not
// user takeover. Actual displacement or a hardware delta still stops input,
// including movement against a screen edge and sub-pixel trackpad movement.
func stationaryPointerEvent(previous: CGPoint?, current: CGPoint, deltaX: Int64, deltaY: Int64) -> Bool {
    guard let previous = previous else { return false }
    return previous == current && deltaX == 0 && deltaY == 0
}
