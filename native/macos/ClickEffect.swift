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
/// tap in front; events posted to the process in a bound window), the
/// accessibility route (AXPress, or AXFocused for a field), or either after
/// the page was scrolled to bring the control into the clear (Reveal.swift).
enum ClickRoute: String { case pointer, press, scrolled }

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

// MARK: A field takes the pointer first

/**
 Market sweeps of 2026-09-20 under autonomy all (gpt-5.4-mini, Safari):
 booking-table-pause-before-confirm passed at 55e4e83 (#1) with click_control
 on its fields reading press/focused and the four type_text steps each adding
 a text node to the page (15 -> 19), and failed at 72ef8e4 (#2) and bad4c35
 (#3) with the identical shape — press/focused, the same four typings — and
 the text nodes at 15 throughout, the review posted empty; checkin-flight-seat
 passed twice (c8c9e10 #1, 55e4e83 #1: 8 -> 9 after the first typed value)
 and failed three times (55e4e83 #2, 72ef8e4 #1 and #2: 8 -> 8, the passenger
 never entered). Before d87736e a named field was clicked with the pointer
 and typing landed every time; since then a field was given focus by
 accessibility first (AXFocused, then AXPress under a0d2cb8's press-first
 for a hit-invisible control), and on a WebKit field that route makes the
 accessibility focus read the field while the caret, the keyboard focus the
 keystrokes go to, is not reliably placed. The rules here are pure: a field
 whose point is clear is clicked by the pointer first, as a person clicks it;
 the accessibility route is the first route only when the point is not clear
 (under the Dock, or a hit-invisible input drawn by its label); and a focus
 either route claims is verified against the application's focused element
 before "focused" is reported. Buttons, links, radios, check boxes and menu
 buttons keep a0d2cb8's order.
 */
/// The order of a click by name's two routes: the pointer click at the
/// control's point, or the control's own accessibility route (AXFocused for
/// a field, then AXPress; AXPress for the rest).
enum ClickOrder: String { case pointerFirst, pressFirst }
/// Whether a control is a field: one of the roles whose value a person sets
/// by hand (Reveal.swift editableControlRoles: a text field, text area,
/// combo box, number input, slider; an incrementor's inner text field is a
/// text field) or a search field by role or subrole.
func fieldRole(role: String, subrole: String) -> Bool {
    editableControlRoles.contains(role) || role == "AXSearchField" || subrole == "AXSearchField"
}
/// The order for a control: a field takes the pointer first whenever its
/// point is clear and the accessibility route first when it is not; any
/// other control is pressed first only when it is hit-invisible
/// (HitCover.hitAncestor), else the pointer comes first, as under a0d2cb8.
func clickOrder(role: String, subrole: String, clear: Bool, hitAncestor: Bool) -> ClickOrder {
    if fieldRole(role: role, subrole: subrole) { return clear ? .pointerFirst : .pressFirst }
    return hitAncestor ? .pressFirst : .pointerFirst
}

/// The poll for a field's focus after either route: the application's
/// focused element is read every focusPollStepMs until it is the field or
/// inside it, focusPollLimitMs at most. Reads only.
let focusPollStepMs = 30
let focusPollLimitMs = 300
let focusPollReads = focusPollLimitMs / focusPollStepMs
/// How far up from the focused element the field is looked for: a
/// descendant may hold the focus (an incrementor's inner text field, a
/// combo box's own field).
let focusDescendantDepth = 4
/// Whether the focus landed: the focused element is the control, or the
/// control is among the focused element's nearest focusDescendantDepth
/// ancestors (the focus is inside it). Nothing focused, or anything else
/// (the web area, another field, the window), is not landed.
func focusLanded<Element>(focused: Element?, control: Element, ancestors: [Element], same: (Element, Element) -> Bool) -> Bool {
    guard let focused else { return false }
    if same(focused, control) { return true }
    return ancestors.prefix(focusDescendantDepth).contains(where: { same(control, $0) })
}
/// A field's effect over the snapshot read and the focus poll: a change to
/// the window stands as read; focused only when the field holds the focus
/// (a focus that moved elsewhere is not the field's, whatever clickEffect
/// made of it); else none, so the runner and the policy never believe a
/// field has focus that the application does not give it.
func fieldClickEffect(read: ClickEffect, landed: Bool) -> ClickEffect {
    if read == .changed { return .changed }
    return landed ? .focused : .none
}

// MARK: Typing needs a field

/// The focused roles text is typed into: the policy's own list
/// (src/core/policy.ts editableRoles) and a search field by role or subrole.
let typingRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXIncrementor", "AXSearchField"]
/// Whether the frontmost type_text is refused before a keystroke is posted:
/// the focused element identifies itself as something text is not typed
/// into (the web area a field's focus fell back to, a button, a link, a
/// list), so the keystrokes would go somewhere the model did not choose. A
/// focus that identifies nothing (InputSafety.swift uninformativeFocusRoles:
/// none, the window, an unnamed group) is left to the policy, which asks
/// the user about typing into a blind surface and refuses an unidentified
/// one; the helper does not overrule an approval it cannot see.
func typingRefused(role: String, subrole: String) -> Bool {
    if typingRoles.contains(role) || subrole == "AXSearchField" { return false }
    return !uninformativeFocusRoles.contains(role)
}
/// The refusal's words: the policy's own NO_FIELD_FOCUSED sentence without
/// its "No input was sent." prefix, which the runner adds (noInput), so the
/// model reads one sentence for the one condition wherever it is caught.
let noFieldFocusedCode = "NO_FIELD_FOCUSED"
let noFieldFocusedMessage = "No known text field is focused. Click the intended text field first, then type."
