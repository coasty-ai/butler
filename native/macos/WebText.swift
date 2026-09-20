import Foundation
import CoreGraphics

/**
 The budget of one page-text walk (Controller.swift webVisibleText) and its
 account of itself, pure so the rules can be tested without a browser.

 Every attribute a walk reads is a message to the browser's process (0.2–2 ms
 each; a frame is two, position and size). A node that is visited costs its
 frame, its role and its value or children, four reads; a node pruned as
 off-screen costs its frame alone, two. Until 2026-09-19 the walk started at
 the window, read the subrole and the frame of every node before its role, and
 had 0.3 s: 40 to 400 nodes, spent first on the window's chrome and then, in
 document order, on the page from its top, so on a long page the text the
 model saw after a scroll was the top of the viewport or nothing, and the
 model scrolled and captured until the loop rule ended the run (market cycles
 20260919-2044 and 20260919-2144, msg-group-chat-digest and
 memory-link-to-note, every fact missing, nothing written). The walk now
 starts at the page, prunes by frame before it reads a role, stops reading
 frames under a node the visible rect contains whole, stops at a run of
 siblings below the fold, and says when and why it stopped early.
 */
struct TextWalkBudget {
    /// The line a cut text ends with, so the model reads the cut as a fact
    /// about the reading and not as the end of the page. Pinned by
    /// tests/native/WebTextTests.swift and by src/core/schema.ts
    /// VISIBLE_TEXT_CUT_MARKER, which the instruction quotes.
    static let marker = "[page continues below; scroll to read more]"
    /// Wall time for one page. The capture's other stages come to about a
    /// second (settle, the stable-window samples, the screenshot, the
    /// controls' 0.25 s, OCR when the text is short, encoding), the runner
    /// waits 25 s for a capture and up to 60 s while the helper answers its
    /// liveness probe (2c31e83), and the market cycles' captures all answered
    /// under 3 s; the half second added here is spent only on pages with
    /// more text than the budget reads, where it replaces a scroll, a capture
    /// and a model call of 5–15 s. A fully visible chat page of 27 lines
    /// costs about 270 reads with the rules above, 0.3 s at a millisecond each.
    static let webSeconds = 0.8
    /// Siblings entirely below the visible rect, consecutive in document
    /// order, after which the rest of the siblings are taken as below too
    /// (a single column lays its blocks out in order; a fixed banner that
    /// follows three below-fold blocks in the markup is the case this loses).
    static let belowStreak = 3
    static let nodeCap = 4000
    /// A page walk that finished (no stop reason) with fewer nodes or
    /// characters than this read a subtree that was not the page: probe
    /// 20260919-2257 read 8–11 nodes a frame on the check-in fixture while
    /// the page held the confirmation, and the model clicked on. Such a walk
    /// is repeated from the window root (the walk before 091b033) and the
    /// larger text wins.
    static let fallbackNodes = 24
    static let fallbackCharacters = 400
    static func fellShort(nodes: Int, characters: Int, truncated: String?) -> Bool {
        truncated == nil && (nodes < fallbackNodes || characters < fallbackCharacters)
    }
    /// Characters kept of one static text: a wall of text is not the page.
    static let textCap = 600
    /// The roles whose AXVisibleChildren may be fewer than their children
    /// (lists, tables, outlines, the scroll area and the page); every other
    /// role reads AXChildren at once, one message instead of a failed one and
    /// a second.
    static let visibleChildrenRoles: Set<String> = ["AXList", "AXTable", "AXOutline", "AXGrid", "AXScrollArea", "AXWebArea"]

    let seconds: Double
    let maxNodes: Int
    let maxCharacters: Int
    private(set) var nodes = 0
    private(set) var characters = 0
    /// Why the walk stopped early: "time", "nodes" or "chars"; nil while it runs or when it finished.
    private(set) var truncated: String? = nil

    init(seconds: Double = webSeconds, maxNodes: Int = nodeCap, maxCharacters: Int = 4200) {
        self.seconds = seconds; self.maxNodes = maxNodes; self.maxCharacters = maxCharacters
    }

    /// Whether the next node may be visited, given the wall time so far. The
    /// first refusal names its reason and every later call refuses too.
    mutating func admit(elapsed: TimeInterval) -> Bool {
        guard truncated == nil else { return false }
        if nodes >= maxNodes { truncated = "nodes"; return false }
        if elapsed >= seconds { truncated = "time"; return false }
        nodes += 1
        return true
    }

    /// One static text's value, whitespace folded, bounded by the per-node cap
    /// and by the characters left; nil when empty or when nothing is left. A
    /// text cut by the characters left (not by the cap) is the "chars" stop.
    mutating func take(_ value: String, cap: Int = textCap) -> String? {
        let text = value.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        guard !text.isEmpty else { return nil }
        let room = maxCharacters - characters
        guard room > 0 else { truncated = truncated ?? "chars"; return nil }
        let bounded = String(text.prefix(min(cap, room)))
        if bounded.count < text.count, bounded.count == room { truncated = truncated ?? "chars" }
        characters += bounded.count + 1
        return bounded
    }

    /// The parts joined, and when the walk stopped early the marker as the
    /// last line, the whole never longer than maxCharacters.
    func finish(_ parts: [String]) -> String {
        let text = parts.joined(separator: "\n")
        guard truncated != nil else { return text }
        let room = max(0, maxCharacters - Self.marker.count - 1)
        let kept = text.count > room ? String(text.prefix(room)) : text
        return kept.isEmpty ? Self.marker : kept + "\n" + Self.marker
    }

    /// Where a node's frame lies against the visible rect. `whole` is a frame
    /// the visible rect contains, under which no frame need be read.
    enum Place: Equatable { case visible(whole: Bool), above, below, aside }
    static func place(_ rect: CGRect?, in visible: CGRect) -> Place {
        guard let rect, rect.width > 0, rect.height > 0 else { return .visible(whole: false) }
        if rect.intersects(visible) { return .visible(whole: visible.contains(rect)) }
        if rect.maxY <= visible.minY { return .above }
        if rect.minY >= visible.maxY { return .below }
        return .aside
    }

    /// The children attribute to read first for a role.
    static func childrenAttribute(role: String) -> String {
        visibleChildrenRoles.contains(role) ? "AXVisibleChildren" : "AXChildren"
    }
}

/// What one page-text walk returned: the text (ending with the marker when
/// cut), why it stopped early if it did, and its counts.
struct WebText {
    let text: String
    let truncated: String?
    let nodes: Int
    let elapsedMs: Int
    let characters: Int
    /// Which walk produced the text: "page" (from the page's root) or
    /// "window" (from the window root, after a page walk fell short).
    let walk: String
    static let empty = WebText(text: "", truncated: nil, nodes: 0, elapsedMs: 0, characters: 0, walk: "page")
}
