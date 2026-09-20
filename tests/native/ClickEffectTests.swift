import Foundation
import CoreGraphics

// Pure checks for the click-by-name effect check (ClickEffect.swift): the
// verdict over two snapshots, which roles ask for focus, the read schedule,
// the result's fixed words, and the bound ladder's read of focus and of the
// clicked control's own state. Every fixture is a digest or a fixed word.
func clickEffectChecks(_ check: (Bool, String) -> Void) {
    let before = ClickSnapshot(focus: "1|AXButton|next", controls: "a", title: "t1", page: "p1", control: "v|0|0", windows: 1, targetFocused: false)
    check(clickEffect(before: before, after: before, editable: false) == ClickEffect.none, "an identical reading is no effect")
    var after = before; after.controls = "b"
    check(clickEffect(before: before, after: after, editable: false) == .changed, "a changed controls digest is a change")
    after = before; after.title = "t2"
    check(clickEffect(before: before, after: after, editable: false) == .changed, "a changed window title is a change (a page that paged)")
    after = before; after.page = "p2"
    check(clickEffect(before: before, after: after, editable: false) == .changed, "a changed document or page address is a change")
    after = before; after.control = "v|1|0"
    check(clickEffect(before: before, after: after, editable: false) == .changed, "the clicked control's own state changing (selected, expanded, value) is a change")
    after = before; after.windows = 2
    check(clickEffect(before: before, after: after, editable: false) == .changed, "a sheet or a new window is a change")
    after = before; after.focus = "2|AXTextField|name"
    check(clickEffect(before: before, after: after, editable: false) == .focused, "focus moving alone is focused, never a change and never nothing")
    after = before; after.focus = "2|AXTextField|name"; after.controls = "b"
    check(clickEffect(before: before, after: after, editable: false) == .changed, "a change outranks a focus move")
    after = before; after.targetFocused = true
    check(clickEffect(before: before, after: after, editable: false) == ClickEffect.none, "a button holding focus after a click that changed nothing is no effect")
    check(clickEffect(before: before, after: after, editable: true) == .focused, "a field holding focus after its click is focused: the click did what it is for")
    var held = before; held.targetFocused = true
    check(clickEffect(before: held, after: held, editable: true) == .focused && clickEffect(before: held, after: held, editable: false) == ClickEffect.none,
          "a field that already held focus reads focused; a button that did reads none")

    check(focusRequested(role: "AXTextField", subrole: "") && focusRequested(role: "AXTextArea", subrole: "") && focusRequested(role: "AXComboBox", subrole: "")
          && focusRequested(role: "AXTextField", subrole: "AXSearchField") && focusRequested(role: "AXSearchField", subrole: ""),
          "text fields, text areas, combo boxes and search fields ask for focus")
    check(!focusRequested(role: "AXButton", subrole: "") && !focusRequested(role: "AXLink", subrole: "") && !focusRequested(role: "AXCheckBox", subrole: "")
          && !focusRequested(role: "AXRadioButton", subrole: "") && !focusRequested(role: "AXPopUpButton", subrole: ""),
          "buttons, links, check boxes, radio buttons and pop-ups are pressed, not focused")
    check(clickReadDelaysMs == [120, 180] && clickReadDelaysMs.reduce(0, +) <= 300, "two reads, within 300 ms in all")

    let result = clickResult(effect: .none, via: .press)
    check(result["effect"] as? String == "none" && result["via"] as? String == "press" && result.count == 2, "the result names the effect and the route as fixed words, nothing else")
    check(ClickEffect.changed.rawValue == "changed" && ClickEffect.focused.rawValue == "focused" && ClickEffect.none.rawValue == "none"
          && ClickRoute.pointer.rawValue == "pointer" && ClickRoute.press.rawValue == "press", "the codes are the runner's")
    check(clickRoute(type: "click_control", rung: .ax) == .press && clickRoute(type: "click_control", rung: .post) == .pointer, "in a bound window accessibility is the press and posting the pointer")
    check(clickRoute(type: "click", rung: .ax) == nil && clickRoute(type: "type_text", rung: .post) == nil && clickRoute(type: "click_control", rung: .foreground) == .pointer,
          "other steps name no route; the announced foreground is the pointer")

    // The bound ladder's postcondition read carries focus and the control's state.
    let observed = TargetObservation(controls: "a", fieldValue: nil, windowCount: 1, pixels: nil, focus: "1|AXButton|send", control: "v|0|0", targetFocused: false)
    var moved = observed; moved.focus = "2|AXTextField|message"; moved.targetFocused = true
    let focusRead = postconditionRead(before: observed, after: moved, targetRect: nil)
    check(focusRead.focusChanged && !focusRead.any && focusRead.targetFocused, "focus moving in a bound window is read, and is not a change by itself")
    check(postconditionVerdict(focusRead) == .focused && postconditionVerdict(focusRead, editable: true) == .focused, "focus moving reads as focused for any control")
    var heldFocus = observed; heldFocus.targetFocused = true
    let heldRead = postconditionRead(before: observed, after: heldFocus, targetRect: nil)
    check(!heldRead.focusChanged && postconditionVerdict(heldRead) == RungEffect.none && postconditionVerdict(heldRead, editable: true) == .focused,
          "a field already holding focus is focused for a field's click and none for a button's")
    var state = observed; state.control = "v|1|0"
    let stateRead = postconditionRead(before: observed, after: state, targetRect: nil)
    check(stateRead.controlChanged && stateRead.any && postconditionVerdict(stateRead) == .changed, "the clicked control's own state changing is a change of the window")
    check(RungEffect.focused.rawValue == "focused", "the bound effect carries the same word")
    let delivered = targetResult(rung: .ax, effect: .focused, code: nil, read: focusRead, via: .press)
    check(delivered["executed"] as? Bool == true && delivered["effect"] as? String == "focused" && delivered["via"] as? String == "press"
          && (delivered["observed"] as? [String: Any])?["focus"] as? Bool == true && (delivered["observed"] as? [String: Any])?["control"] as? Bool == false,
          "a bound click by name reports its route beside the rung, and the read's focus and control flags")
    check(targetResult(rung: .post, effect: .changed, code: nil, read: nil)["via"] == nil, "a step with no route named reports none")
}
