import Foundation

/**
 The effect check of a click by name (click_control), shared by the frontmost
 route (Controller.swift execute) and the bound-window ladder (executeTarget).

 Cycle 20260919-2044-60630f0 (market suite, gpt-5.4-mini, Safari): eight runs
 ended STUCK_LOOP and five of them were one shape, click_control repeated on
 the same page with no visible change and no native error. The frontmost route
 posted the pointer click at the control's centre and reported the step
 executed with nothing read back, so the model saw the same screen and
 repeated. Every click by name is now followed by bounded reads of what a click
 can change, a second route when the first read as nothing, and a result that
 says what was seen. Nothing here touches AppKit: the helper takes the
 snapshots and posts the input.
 */

/// What a click can change, read before and after it. Every field is a
/// digest, an identity or a count: nothing here is shown or written as text.
struct ClickSnapshot: Equatable {
    /// The focused element: its identity, role and label; empty when none.
    var focus = ""
    /// The window's controls digest (WindowState.controls).
    var controls = ""
    /// The window's title.
    var title = ""
    /// The window's document or page address.
    var page = ""
    /// The clicked control's own state: value digest, selected, expanded.
    var control = ""
    /// The application's windows on screen.
    var windows = 0
    /// The clicked control is the application's focused element.
    var targetFocused = false
}

/// What the reads found: something on the window changed; only focus moved
/// (or a field holds it); or nothing at all.
enum ClickEffect: String { case changed, focused, none }

/// How the click reached the control: a pointer click at its centre (the HID
/// tap in front; events posted to the process in a bound window) or the
/// accessibility route (AXPress, or AXFocused for a field).
enum ClickRoute: String { case pointer, press }

/// Roles whose click asks for focus. AXSearchField is a subrole of a text
/// field on macOS, so it is matched as either.
let editableClickRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"]
func focusRequested(role: String, subrole: String) -> Bool {
    editableClickRoles.contains(role) || subrole == "AXSearchField"
}

/// The reads after an input: 120 ms, then 180 ms more (300 ms in all). The
/// second read is taken only when the first saw nothing.
let clickReadDelaysMs: [Int] = [120, 180]

/**
 The verdict over two snapshots. A change to the window (its controls, title,
 page, window count) or to the control's own state is a change wherever it
 came from. Focus moving, or a field holding focus after a click that asked
 for it, is focused: the click did what a click on a field is for, and the
 next frame shows the field focused. Anything else is none, whatever the
 return code of the input was.
 */
func clickEffect(before: ClickSnapshot, after: ClickSnapshot, editable: Bool) -> ClickEffect {
    if before.controls != after.controls || before.title != after.title || before.page != after.page
        || before.control != after.control || before.windows != after.windows { return .changed }
    if before.focus != after.focus { return .focused }
    if editable && after.targetFocused { return .focused }
    return .none
}

/// The result fields of a click by name, as the runner reads them: the
/// route that acted last and the final effect.
func clickResult(effect: ClickEffect, via: ClickRoute) -> [String: Any] {
    ["effect": effect.rawValue, "via": via.rawValue]
}

/// In a bound window the route is the rung: accessibility is the press,
/// posted events the pointer. Other steps name no route.
func clickRoute(type: String, rung: Rung) -> ClickRoute? {
    guard type == "click_control" else { return nil }
    return rung == .ax ? .press : .pointer
}
