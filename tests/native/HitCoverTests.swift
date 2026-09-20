import Foundation
import CoreGraphics

// Pure checks for a control the hit test cannot see (Reveal.swift coveredBy):
// what the element found at a control's point is to the control. Market
// shard 3/3 under autonomy all (cycle 20260920-0415-c8c9e10): the home
// panel's light switches hit-tested to the AXWebArea and the mail fixture's
// folder radios to the AXGroup of the <label> wrapping each input, and every
// click by name on them was refused CONTROL_COVERED. Both are the control's
// own ancestors: nothing lies over the control. The fixtures are small
// integers standing for elements; identity is equality.
func hitCoverChecks(_ check: (Bool, String) -> Void) {
    let same: (Int, Int) -> Bool = { $0 == $1 }
    // A radio in a <label>: radio 1, its label's group 2, a paragraph group 3, a form 4, the web area 5, a scroll area 6, a group 7, the window 8.
    let radio = 1, ancestry = [2, 3, 4, 5, 6, 7, 8]
    check(coveredBy(hit: radio, control: radio, ancestors: ancestry, same: same) == .clear, "the control itself under the point is clear")
    check(coveredBy(hit: 2, control: radio, ancestors: ancestry, same: same) == .hitAncestor,
          "a radio whose point falls through to its label's group (the mail fixture's folders) is hit-invisible, not covered")
    check(coveredBy(hit: 5, control: radio, ancestors: ancestry, same: same) == .hitAncestor,
          "a switch whose point falls through to the web area (the home panel's lights) is hit-invisible, not covered")
    check(coveredBy(hit: 8, control: radio, ancestors: ancestry, same: same) == .hitAncestor, "the window itself is an ancestor like any other")
    check(coveredBy(hit: 42, control: radio, ancestors: ancestry, same: same) == .covered, "a sibling group (a modal overlay, a sticky header) over the point is covered")
    check(coveredBy(hit: -1, control: radio, ancestors: ancestry, same: same) == .covered, "another application's element (the Dock, another window) is covered")
    check(coveredBy(hit: nil, control: radio, ancestors: ancestry, same: same) == .covered, "nothing under the point is covered")
    check(coveredBy(hit: 2, control: radio, ancestors: [], same: same) == .covered, "with no ancestors read, an element that is not the control is covered")
    // The depth bound: an ancestor past hitAncestorDepth is not consulted.
    let deep = Array(2...(hitAncestorDepth + 3))
    check(coveredBy(hit: deep[hitAncestorDepth - 1], control: radio, ancestors: deep, same: same) == .hitAncestor, "the ancestor at the depth bound still counts")
    check(coveredBy(hit: deep[hitAncestorDepth], control: radio, ancestors: deep, same: same) == .covered, "one past the bound is not looked for: covered")
    check(hitAncestorDepth == 12, "twelve levels reach the window from any control a page lists")
    // A descendant of the control (a button's static text) is the reveal's own
    // hitMatches, decided before this rule: here it is not the control and
    // not an ancestor, so the rule alone says covered.
    check(coveredBy(hit: 100, control: radio, ancestors: ancestry, same: same) == .covered, "an element that is neither the control nor an ancestor is covered whatever it is")
    // Identity is the caller's: the same element seen twice is the same element.
    var compared = 0
    _ = coveredBy(hit: 5, control: radio, ancestors: ancestry, same: { compared += 1; return $0 == $1 })
    check(compared == 5, "the ancestors are compared nearest first and the search stops at the match")
    check(HitCover.clear.rawValue == "clear" && HitCover.hitAncestor.rawValue == "hitAncestor" && HitCover.covered.rawValue == "covered", "the words are the surface's")
    // The reveal's visibility beside its clearness: a hit-invisible control's point is visible and not clear.
    let invisible = Reveal(point: CGPoint(x: 700, y: 500), scrolled: false, clear: false, visible: true)
    check(!invisible.clear && invisible.visible, "a point inside the clear rectangle with the control's ancestor under it is visible, not clear")
    let none = Reveal(point: nil, scrolled: false, clear: false)
    check(!none.visible, "a control with no frame is not visible")
}
