import Foundation
import CoreGraphics

/**
 Revealing a control before a click by name (click_control), shared by the
 frontmost route (Controller.swift surface and execute) and the bound-window
 route (surfaceTarget and executeTarget), and the order a control's name is
 read in.

 Market shard 1/3 under autonomy all (cycle 20260920-0241-5e7d433): the three
 email tasks ended STOPPED_AFTER_HANDOFF after retargets for CONTROL_NOT_FOUND,
 CONTROL_UNLABELLED (filing a message under a folder) and CONTROL_COVERED
 three times over (the reply form). A live read of the mail message fixture
 in Safari (scripts/probe-web-controls.mjs): 14 controls listed and not one
 radio among them, although the page has a fieldset of them; the hit test at
 the textarea's centre found an AXDockItem. WebKit leaves AXTitle empty when
 a <label> names a control (the label is its AXTitleUIElement), so every
 radio was nameless and dropped; and a control whose centre lies under the
 Dock hit-tests to the Dock, so the policy read it as covered by something
 else and the run handed off.

 The rules here are pure: the name order (which ends at the title element),
 where a window's content is clear (the screen's visible frame, which
 excludes the menu bar and a Dock that does not hide, minus the Dock's own
 frame when it is on screen), whether a point is clear, how far to scroll to
 bring a control's frame into the clear, and where on a control to click
 when only part of it is clear. Controller.swift reads the frames, performs
 the scrolls and hit-tests the result.
 */

/// The element that titles a control: a <label> wrapping or pointing at it in
/// a web page, an AppKit field's label. Read last, and its own text is what
/// names the control.
let titleElementAttribute = "AXTitleUIElement"
/// The action WebKit and Chromium offer on every element of a page, and
/// AppKit on the rows of its tables and outlines: scroll it into the viewport.
let scrollToVisibleAction = "AXScrollToVisible"

/// The order a control's name is read in: title, description, then its value
/// (an editable field's placeholder instead: its contents are never a name),
/// and last the element that titles it.
func controlNameOrder(editable: Bool) -> [String] {
    (editable ? ["AXTitle", "AXDescription", "AXPlaceholderValue"] : ["AXTitle", "AXDescription", "AXValue"]) + [titleElementAttribute]
}
/// The first name a reader yields, in order; empty when none does. Readers
/// run lazily, so a named control costs one read.
func firstControlName(_ readers: [() -> String?]) -> String {
    for read in readers {
        if let value = read()?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty { return value }
    }
    return ""
}

/// The roles a radio button or check box may be grouped under; the group's
/// name (a fieldset's legend) rides beside the control as `group`.
let controlGroupRoles: Set<String> = ["AXGroup", "AXRadioGroup"]
let groupedControlRoles: Set<String> = ["AXRadioButton", "AXCheckBox"]
/// The walk up from a grouped control stops here: nothing above names a group.
let controlGroupStopRoles: Set<String> = ["AXWebArea", "AXWindow", "AXScrollArea", "AXApplication"]

/// Roles whose value is what the user entered or set (a field's text, a
/// number input's value, a slider's position): never read as the control's
/// name. modelControlName reads a field's placeholder in its place.
let editableControlRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXIncrementor", "AXSlider"]
/// The role word the model reads in context.controls: "number" for an
/// AXIncrementor (Chrome and Safari both expose <input type=number> as one,
/// and the model reads role words; "incrementor" names nothing it knows),
/// else the role without its AX prefix, lowercased ("AXSlider" -> "slider").
func controlRoleWord(role: String) -> String {
    role == "AXIncrementor" ? "number" : String(role.dropFirst(2)).lowercased()
}

// MARK: Geometry

/// An AppKit screen rectangle (origin at the bottom left of the primary
/// screen) as the top-left-origin rectangle accessibility and the window
/// server use.
func topLeftRect(fromAppKit rect: CGRect, primaryHeight: CGFloat) -> CGRect {
    CGRect(x: rect.minX, y: primaryHeight - rect.maxY, width: rect.width, height: rect.height)
}
/// The part of a window's visible rectangle that is clear of the Dock: the
/// visible rectangle when the Dock's frame does not meet it, else cut along
/// the Dock's side (the bottom for a wide Dock, the left or right for a tall
/// one). Empty (null) when nothing is left.
func clearContentRect(visible: CGRect, dock: CGRect?) -> CGRect {
    guard let dock, !dock.isNull, dock.width > 0, dock.height > 0, visible.intersects(dock) else { return visible }
    var clear = visible
    if dock.width >= dock.height {
        if dock.midY >= visible.midY { clear.size.height = max(0, dock.minY - visible.minY) } else { let top = dock.maxY; clear.size.height = max(0, visible.maxY - top); clear.origin.y = top }
    } else if dock.midX <= visible.midX {
        let left = dock.maxX; clear.size.width = max(0, visible.maxX - left); clear.origin.x = left
    } else {
        clear.size.width = max(0, dock.minX - visible.minX)
    }
    return clear.width > 0 && clear.height > 0 ? clear : .null
}
/// Whether a point lies in the clear rectangle.
func pointClear(_ point: CGPoint, clear: CGRect) -> Bool {
    !clear.isNull && clear.contains(point)
}
/// A margin kept between a revealed control and the clear rectangle's edges,
/// so a control brought to the very edge does not sit under a rounded corner
/// or a bar drawn over it.
let revealMargin: CGFloat = 16
/// How far the page has to scroll to bring a control's frame inside the clear
/// rectangle, in pixels: positive scrolls the content up (the control was
/// below), negative down; 0 when the frame already fits, or when nothing is
/// clear. A frame taller than the room is centred. Bounded to one height of
/// the clear rectangle: one screen at most for one control.
func revealDelta(frame: CGRect, clear: CGRect) -> CGFloat {
    guard !clear.isNull, clear.height > 0, frame.height > 0 else { return 0 }
    let margin = clear.height > frame.height + 2 * revealMargin ? revealMargin : 0
    let room = clear.insetBy(dx: 0, dy: margin)
    var delta: CGFloat = 0
    if frame.height > room.height { delta = frame.midY - room.midY }
    else if frame.maxY > room.maxY { delta = frame.maxY - room.maxY }
    else if frame.minY < room.minY { delta = frame.minY - room.minY }
    return max(-clear.height, min(clear.height, delta.rounded()))
}
/// The smallest part of a control worth clicking when only part of it is
/// clear (the top rows of a text area whose bottom the Dock covers).
let clearPartMinimum: CGFloat = 8
/// The centre of the clear part of a control's frame, whole pixels, or nil
/// when less than clearPartMinimum of it is clear in either direction.
func clearPoint(frame: CGRect, clear: CGRect) -> CGPoint? {
    guard !clear.isNull else { return nil }
    let part = frame.intersection(clear)
    guard !part.isNull, part.width >= clearPartMinimum, part.height >= clearPartMinimum else { return nil }
    return CGPoint(x: floor(part.midX), y: floor(part.midY))
}
/// The wait after a scroll before the control's frame is read again. WebKit
/// and Chromium answer AXScrollToVisible and a pixel wheel event without an
/// animation; the read is one frame later.
let revealSettleMs = 100

/// What revealing a control found: the point to click (nil when the control
/// has no frame), whether the page moved for it, and whether that point is
/// clear now (inside the clear rectangle with this control under it).
struct Reveal { let point: CGPoint?; let scrolled: Bool; let clear: Bool }
/// A click's route word once a reveal moved the page (ClickEffect.swift
/// ClickRoute.scrolled), for the result and the diagnostics.
func revealRoute(scrolled: Bool, route: ClickRoute?) -> ClickRoute? {
    scrolled ? .scrolled : route
}
