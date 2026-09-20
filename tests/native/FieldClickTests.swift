import Foundation
import CoreGraphics

// Pure checks for a field's click by name taking the pointer first, for the
// focus check behind "focused", and for the typing refusal (ClickEffect.swift).
// Market sweeps of 2026-09-20 (gpt-5.4-mini, autonomy all, Safari):
// booking-table-pause-before-confirm passed once with the page's text nodes
// growing 15 -> 19 over four typings and failed twice with the identical
// click_control press/focused shape and the nodes at 15 throughout;
// checkin-flight-seat read 8 -> 9 in its passes and 8 -> 8 in its failures.
// AXFocused/AXPress on a WebKit field reads focused without placing the caret;
// a pointer click did every time before d87736e. The fixtures are role words
// and small integers standing for elements; identity is equality.
func fieldClickChecks(_ check: (Bool, String) -> Void) {
    // Which controls are fields.
    for role in ["AXTextField", "AXTextArea", "AXComboBox", "AXIncrementor", "AXSlider", "AXSearchField"] {
        check(fieldRole(role: role, subrole: ""), "\(role) is a field: its value is set by hand")
    }
    check(fieldRole(role: "AXTextField", subrole: "AXSearchField"), "a search field by subrole is a field")
    for role in ["AXButton", "AXLink", "AXRadioButton", "AXCheckBox", "AXMenuButton", "AXPopUpButton", "AXStaticText", "AXGroup", "AXWebArea", ""] {
        check(!fieldRole(role: role, subrole: ""), "\(role.isEmpty ? "no role" : role) is not a field")
    }
    check(editableControlRoles.allSatisfy { fieldRole(role: $0, subrole: "") }, "every editable control role (Reveal.swift) is a field")

    // The route table: role x clear x hit-ancestor.
    let fields = ["AXTextField", "AXTextArea", "AXComboBox", "AXIncrementor", "AXSearchField", "AXSlider"]
    let others = ["AXButton", "AXLink", "AXRadioButton", "AXCheckBox", "AXMenuButton", "AXPopUpButton"]
    for role in fields {
        check(clickOrder(role: role, subrole: "", clear: true, hitAncestor: false) == .pointerFirst, "\(role), clear: the pointer first")
        check(clickOrder(role: role, subrole: "", clear: false, hitAncestor: true) == .pressFirst, "\(role), hit-invisible: the accessibility route first")
        check(clickOrder(role: role, subrole: "", clear: false, hitAncestor: false) == .pressFirst, "\(role), covered or under the Dock: the accessibility route first")
        check(clickOrder(role: role, subrole: "", clear: true, hitAncestor: true) == .pointerFirst, "\(role), clear: the pointer first whatever the hit flag")
    }
    check(clickOrder(role: "AXTextField", subrole: "AXSearchField", clear: true, hitAncestor: false) == .pointerFirst, "a search field by subrole, clear: the pointer first")
    for role in others {
        check(clickOrder(role: role, subrole: "", clear: true, hitAncestor: false) == .pointerFirst, "\(role), clear: the pointer first, then the press (a0d2cb8)")
        check(clickOrder(role: role, subrole: "", clear: false, hitAncestor: true) == .pressFirst, "\(role), hit-invisible: pressed by its own action first (a0d2cb8)")
        check(clickOrder(role: role, subrole: "", clear: false, hitAncestor: false) == .pointerFirst, "\(role), covered: a0d2cb8's order (no pointer click lands there anyway)")
        check(clickOrder(role: role, subrole: "", clear: true, hitAncestor: true) == .pressFirst, "\(role), hit-invisible and clear: pressed first (a0d2cb8)")
    }
    check(ClickOrder.pointerFirst.rawValue == "pointerFirst" && ClickOrder.pressFirst.rawValue == "pressFirst", "the order's words")

    // The focus check: the field itself, inside it, elsewhere, nothing, too deep.
    let same: (Int, Int) -> Bool = { $0 == $1 }
    let field = 10, inner = 11, webArea = 5
    check(focusLanded(focused: field, control: field, ancestors: [3, 5, 8], same: same), "the field itself focused: landed")
    check(focusLanded(focused: inner, control: field, ancestors: [field, 3, 5, 8], same: same), "an incrementor's inner text field focused: landed (the focus is inside the control)")
    check(focusLanded(focused: inner, control: field, ancestors: [12, 13, 14, field], same: same), "the control at focusDescendantDepth still counts")
    check(!focusLanded(focused: inner, control: field, ancestors: [12, 13, 14, 15, field], same: same), "one past the depth does not")
    check(!focusLanded(focused: webArea, control: field, ancestors: [6, 7, 8], same: same), "the web area focused (a field's focus fell back to the page): not landed")
    check(!focusLanded(focused: 20, control: field, ancestors: [3, 5, 8], same: same), "another field focused: not landed")
    check(!focusLanded(focused: nil, control: field, ancestors: [], same: same), "nothing focused (the poll ran out): not landed")
    check(!focusLanded(focused: inner, control: field, ancestors: [], same: same), "with no ancestors read, an element that is not the field is not landed")
    check(focusDescendantDepth == 4, "four levels reach a field from its inner element")
    check(focusPollStepMs == 30 && focusPollLimitMs == 300 && focusPollReads == 10, "the focus is polled every 30 ms, ten reads, 300 ms at most")

    // The field's effect: a change stands; focused only when landed; else none.
    check(fieldClickEffect(read: .changed, landed: false) == .changed && fieldClickEffect(read: .changed, landed: true) == .changed, "a change to the window stands as read")
    check(fieldClickEffect(read: .focused, landed: true) == .focused && fieldClickEffect(read: .none, landed: true) == .focused, "the field holding the focus is focused whatever the snapshot read")
    check(fieldClickEffect(read: .focused, landed: false) == ClickEffect.none, "a focus that moved elsewhere is not the field's: none, never focused")
    check(fieldClickEffect(read: .none, landed: false) == ClickEffect.none, "nothing read and no focus: none")

    // Typing needs a field.
    for role in ["AXTextField", "AXTextArea", "AXComboBox", "AXIncrementor", "AXSearchField"] {
        check(!typingRefused(role: role, subrole: ""), "type_text with \(role) focused is posted")
    }
    check(!typingRefused(role: "AXTextField", subrole: "AXSearchField"), "a search field by subrole is typed into")
    for role in ["AXWebArea", "AXButton", "AXLink", "AXList", "AXTable", "AXCell", "AXStaticText", "AXCheckBox", "AXRadioButton", "AXSlider", "AXMenuItem", "AXScrollArea", "AXImage", "AXOutline"] {
        check(typingRefused(role: role, subrole: ""), "type_text with \(role) focused is refused before a keystroke")
    }
    for role in uninformativeFocusRoles {
        check(!typingRefused(role: role, subrole: ""), "a focus that identifies nothing (\(role.isEmpty ? "none" : role)) is the policy's to judge, not refused here")
    }
    check(typingRoles == ["AXTextField", "AXTextArea", "AXComboBox", "AXIncrementor", "AXSearchField"], "the typing roles are the policy's editableRoles and the search field")
    check(noFieldFocusedCode == "NO_FIELD_FOCUSED" && noFieldFocusedMessage == "No known text field is focused. Click the intended text field first, then type.",
          "the refusal is the policy's NO_FIELD_FOCUSED sentence, which the runner prefixes")
}
