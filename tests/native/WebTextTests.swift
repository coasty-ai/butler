import Foundation
import CoreGraphics

// Pure checks for the page-text walk's budget (WebText.swift): the marker
// line and the constants the runner and the instruction rely on, the node and
// wall-time stops, the character stop against the per-node cap, the marker
// fitting inside the limit, where a frame lies against the visible rect, and
// which roles ask for their visible children first.
func webTextChecks(_ check: (Bool, String) -> Void) {
    check(TextWalkBudget.marker == "[page continues below; scroll to read more]", "the marker line is pinned (src/core/schema.ts VISIBLE_TEXT_CUT_MARKER quotes it)")
    check(TextWalkBudget.marker.count == 43, "the marker is 43 characters, the room finish() keeps for it")
    check(TextWalkBudget.webSeconds == 0.8 && TextWalkBudget.nodeCap == 4000 && TextWalkBudget.textCap == 600 && TextWalkBudget.belowStreak == 3, "the budget's constants are pinned")
    // Admission: nodes and wall time.
    var b = TextWalkBudget(seconds: 0.5, maxNodes: 3, maxCharacters: 100)
    check(b.admit(elapsed: 0) && b.admit(elapsed: 0.1) && b.admit(elapsed: 0.2) && b.truncated == nil && b.nodes == 3, "nodes within the budget are admitted and counted")
    check(!b.admit(elapsed: 0.3) && b.truncated == "nodes" && b.nodes == 3, "the node after the cap is refused as nodes")
    check(!b.admit(elapsed: 0) && b.truncated == "nodes", "once stopped, every node is refused and the reason stays")
    var t = TextWalkBudget(seconds: 0.5, maxNodes: 10, maxCharacters: 100)
    check(t.admit(elapsed: 0.49) && !t.admit(elapsed: 0.5) && t.truncated == "time" && t.nodes == 1, "wall time at the budget is refused as time")
    // Taking text: folding, the characters left, the per-node cap.
    var c = TextWalkBudget(seconds: 1, maxNodes: 10, maxCharacters: 20)
    check(c.take("  a   b\n c ") == "a b c" && c.characters == 6 && c.truncated == nil, "whitespace folds and the newline is counted")
    check(c.take("   \n ") == nil && c.characters == 6, "an empty text takes nothing")
    check(c.take(String(repeating: "x", count: 30)) == String(repeating: "x", count: 14) && c.truncated == "chars" && c.characters == 21, "a text cut by the characters left is the chars stop")
    check(c.take("more") == nil && c.truncated == "chars" && !c.admit(elapsed: 0), "with nothing left, nothing is taken and no node admitted")
    var d = TextWalkBudget(seconds: 1, maxNodes: 10, maxCharacters: 4200)
    check(d.take(String(repeating: "y", count: 700))?.count == 600 && d.truncated == nil, "a text cut by the per-node cap is not a stop")
    check(d.take(String(repeating: "z", count: 50), cap: 10) == String(repeating: "z", count: 10) && d.truncated == nil, "the cap is a parameter")
    // Finishing: the marker only on a cut, inside the limit.
    check(TextWalkBudget(maxCharacters: 100).finish(["a", "b"]) == "a\nb", "a finished walk joins its parts with no marker")
    var e = TextWalkBudget(seconds: 0, maxNodes: 10, maxCharacters: 100)
    check(!e.admit(elapsed: 0.1) && e.finish(["a", "b"]) == "a\nb\n" + TextWalkBudget.marker, "a cut walk ends with the marker on its own line")
    check(e.finish([]) == TextWalkBudget.marker, "a cut walk with no text is the marker alone")
    var f = TextWalkBudget(seconds: 1, maxNodes: 10, maxCharacters: 60)
    _ = f.take(String(repeating: "q", count: 80))
    let out = f.finish([String(repeating: "q", count: 60)])
    check(f.truncated == "chars" && out.count == 60 && out.hasSuffix("\n" + TextWalkBudget.marker) && out.hasPrefix("qqqq"), "the marker fits inside the limit, the text giving way")
    // Placing a frame against the visible rect.
    let visible = CGRect(x: 0, y: 100, width: 1000, height: 600)
    check(TextWalkBudget.place(nil, in: visible) == .visible(whole: false), "no frame is visited and read on")
    check(TextWalkBudget.place(CGRect(x: 10, y: 10, width: 0, height: 0), in: visible) == .visible(whole: false), "an empty frame is visited and read on")
    check(TextWalkBudget.place(CGRect(x: 10, y: 200, width: 100, height: 20), in: visible) == .visible(whole: true), "a frame inside the visible rect needs no frames read below it")
    check(TextWalkBudget.place(CGRect(x: 10, y: 50, width: 100, height: 100), in: visible) == .visible(whole: false), "a frame across the top edge is visited with frames read on")
    check(TextWalkBudget.place(CGRect(x: 10, y: 0, width: 100, height: 100), in: visible) == .above, "a frame ending at the top edge is above")
    check(TextWalkBudget.place(CGRect(x: 10, y: 700, width: 100, height: 100), in: visible) == .below, "a frame starting at the bottom edge is below")
    check(TextWalkBudget.place(CGRect(x: 1200, y: 200, width: 100, height: 100), in: visible) == .aside, "a frame beside the visible rect is aside, outside the below run")
    check(TextWalkBudget.place(CGRect(x: -500, y: 50, width: 2000, height: 2000), in: visible) == .visible(whole: false), "the body's frame around the visible rect is visited")
    // Children: which attribute first.
    check(TextWalkBudget.childrenAttribute(role: "AXList") == "AXVisibleChildren" && TextWalkBudget.childrenAttribute(role: "AXWebArea") == "AXVisibleChildren" && TextWalkBudget.childrenAttribute(role: "AXTable") == "AXVisibleChildren", "lists, tables and the page ask for their visible children first")
    check(TextWalkBudget.childrenAttribute(role: "AXGroup") == "AXChildren" && TextWalkBudget.childrenAttribute(role: "AXHeading") == "AXChildren" && TextWalkBudget.childrenAttribute(role: "") == "AXChildren", "a group reads its children at once")
    check(WebText.empty.text == "" && WebText.empty.truncated == nil && WebText.empty.nodes == 0 && WebText.empty.elapsedMs == 0, "the empty reading")
}
