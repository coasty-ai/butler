import Foundation
import CoreGraphics

// Pure checks for revealing a covered control before a click by name
// (Reveal.swift): the name order that ends at the title element, the clear
// rectangle of a window's content beside the Dock, whether a point is clear,
// how far to scroll to bring a frame into the clear, the clear part of a
// control, the settle time, and the route word once the page moved. The
// screen is the probe's Mac: 1440 x 900, the menu bar 25 px, the Dock 63 px
// tall at the bottom; the window extends under the Dock.
func revealChecks(_ check: (Bool, String) -> Void) {
    // The name order: title, description, value (a field's placeholder), then the title element.
    check(controlNameOrder(editable: false) == ["AXTitle", "AXDescription", "AXValue", "AXTitleUIElement"],
          "a control's name is read from its title, description and value, then the element that titles it")
    check(controlNameOrder(editable: true) == ["AXTitle", "AXDescription", "AXPlaceholderValue", "AXTitleUIElement"],
          "an editable field's contents are never its name: its placeholder stands where the value would, then its title element")
    check(controlNameOrder(editable: true).last == titleElementAttribute && controlNameOrder(editable: false).last == titleElementAttribute
          && !controlNameOrder(editable: true).contains("AXValue"), "the title element is read last, and a field's value is never read")
    var reads = [String]()
    let named = firstControlName([{ reads.append("title"); return "" }, { reads.append("description"); return "  " }, { reads.append("label"); return " Receipts " }, { reads.append("never"); return "Trash" }])
    check(named == "Receipts" && reads == ["title", "description", "label"], "the first non-blank name wins, trimmed, and nothing after it is read")
    check(firstControlName([{ nil }, { "" }]) == "" && firstControlName([]) == "", "no name from any reader is the empty name")
    check(groupedControlRoles == ["AXRadioButton", "AXCheckBox"] && controlGroupRoles.contains("AXGroup") && controlGroupRoles.contains("AXRadioGroup")
          && controlGroupStopRoles.contains("AXWebArea") && controlGroupStopRoles.contains("AXWindow"),
          "radio buttons and check boxes carry their group, read from a group or radio group and never past the page or the window")
    check(scrollToVisibleAction == "AXScrollToVisible" && titleElementAttribute == "AXTitleUIElement", "the accessibility names are the system's")

    // Geometry. AppKit's visible frame (origin bottom left) as the top-left rectangle.
    let display = CGRect(x: 0, y: 0, width: 1440, height: 900)
    let visibleFrame = topLeftRect(fromAppKit: CGRect(x: 0, y: 63, width: 1440, height: 812), primaryHeight: 900)
    check(visibleFrame == CGRect(x: 0, y: 25, width: 1440, height: 812), "the screen's visible frame converts to y 25..837: below the menu bar, above the Dock")
    let dock = CGRect(x: 300, y: 837, width: 840, height: 63)
    let window = CGRect(x: 295, y: 102, width: 1055, height: 780) // its bottom at 882, under the Dock
    let visible = window.intersection(visibleFrame)
    check(visible.maxY == 837, "a window that extends under the Dock is visible down to the Dock's top by the visible frame alone")
    let clear = clearContentRect(visible: window.intersection(display), dock: dock)
    check(clear.minY == window.minY && clear.maxY == dock.minY && clear.minX == window.minX && clear.width == window.width,
          "the clear rectangle is the window cut at the Dock's top edge, full width")
    check(clearContentRect(visible: visible, dock: nil) == visible && clearContentRect(visible: visible, dock: CGRect(x: 0, y: 890, width: 1440, height: 10)) == visible,
          "with no Dock, or a Dock that does not meet the window, the visible rectangle is clear as it is")
    check(clearContentRect(visible: visible, dock: .null) == visible && clearContentRect(visible: visible, dock: .zero) == visible, "a null or empty Dock frame covers nothing")
    let leftDock = CGRect(x: 0, y: 100, width: 70, height: 700), rightDock = CGRect(x: 1370, y: 100, width: 70, height: 700)
    let wide = CGRect(x: 0, y: 25, width: 1440, height: 812)
    check(clearContentRect(visible: wide, dock: leftDock).minX == 70 && clearContentRect(visible: wide, dock: leftDock).maxX == 1440, "a Dock on the left cuts the left edge")
    check(clearContentRect(visible: wide, dock: rightDock).maxX == 1370 && clearContentRect(visible: wide, dock: rightDock).minX == 0, "a Dock on the right cuts the right edge")
    check(clearContentRect(visible: CGRect(x: 0, y: 840, width: 1440, height: 50), dock: dock).isNull, "a window wholly under the Dock has nothing clear")

    check(pointClear(CGPoint(x: 800, y: 500), clear: clear) && !pointClear(CGPoint(x: 800, y: 860), clear: clear) && !pointClear(CGPoint(x: 800, y: 50), clear: clear),
          "a point in the clear rectangle is clear; one under the Dock or above the window is not")
    check(!pointClear(CGPoint(x: 800, y: 500), clear: .null), "nothing is clear when nothing is")

    // The scroll that clears a control: a text area whose centre sits under the Dock (y 820..900 in the window).
    let textarea = CGRect(x: 400, y: 820, width: 600, height: 80)
    let delta = revealDelta(frame: textarea, clear: clear)
    check(delta == textarea.maxY - (clear.maxY - revealMargin), "a control below the clear rectangle scrolls up by what brings its bottom edge inside, with the margin")
    check(delta > 0 && revealDelta(frame: CGRect(x: 400, y: 60, width: 600, height: 30), clear: clear) < 0, "below scrolls the content up (positive), above scrolls it down (negative)")
    check(revealDelta(frame: CGRect(x: 400, y: 400, width: 600, height: 80), clear: clear) == 0, "a control inside the clear rectangle needs no scroll")
    check(revealDelta(frame: CGRect(x: 400, y: 100, width: 600, height: 900), clear: clear) == (550 - clear.midY).rounded(), "a control taller than the room is centred")
    check(abs(revealDelta(frame: CGRect(x: 400, y: 5000, width: 600, height: 80), clear: clear)) == clear.height, "one scroll is bounded to the clear rectangle's height")
    check(revealDelta(frame: textarea, clear: .null) == 0 && revealDelta(frame: .zero, clear: clear) == 0, "nothing to scroll into, or no frame, is no scroll")
    check(revealDelta(frame: CGRect(x: 0, y: 120, width: 10, height: 100), clear: CGRect(x: 0, y: 200, width: 10, height: 110)) == -80,
          "a room too small for the margin drops it rather than shrink below the control")

    // The clear part of a control: the text area's top 17 px above the Dock (820..837).
    let part = clearPoint(frame: textarea, clear: clear)
    check(part == CGPoint(x: 700, y: 828), "the clear part's centre, in whole pixels, when at least clearPartMinimum of it is clear")
    check(clearPoint(frame: CGRect(x: 400, y: 832, width: 600, height: 60), clear: clear) == nil, "a sliver thinner than clearPartMinimum is not clicked")
    check(clearPoint(frame: CGRect(x: 400, y: 850, width: 600, height: 40), clear: clear) == nil && clearPoint(frame: textarea, clear: .null) == nil,
          "a control wholly under the Dock, or with nothing clear, has no clear part")
    check(clearPartMinimum == 8 && revealMargin == 16 && revealSettleMs == 100, "the constants: an 8 px part, a 16 px margin, one read 100 ms after a scroll")

    // The route word: a page that moved says so; otherwise the click's own route.
    check(revealRoute(scrolled: true, route: .pointer) == .scrolled && revealRoute(scrolled: true, route: .press) == .scrolled && revealRoute(scrolled: true, route: nil) == .scrolled,
          "a click after a reveal that moved the page reports scrolled whatever route acted")
    check(revealRoute(scrolled: false, route: .press) == .press && revealRoute(scrolled: false, route: nil) == nil, "with no scroll the route is the click's own, or none")
    check(ClickRoute.scrolled.rawValue == "scrolled", "the code is the runner's")
    let reveal = Reveal(point: nil, scrolled: false, clear: false)
    check(reveal.point == nil && !reveal.scrolled && !reveal.clear && !reveal.visible, "a control with no frame reveals nothing, unscrolled, unclear and not visible")
    check(Reveal(point: CGPoint(x: 1, y: 1), scrolled: false, clear: true, visible: true).visible, "a clear point is visible")
}
