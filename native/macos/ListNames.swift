import Foundation

/**
 Names repeated in a list, told apart by their row.

 Market sweep 1/3 at 55e4e83 under autonomy all (cycle 20260920-0514-55e4e83,
 gpt-5.4-mini), and the same shape in shards 2/3 and 3/3 of the two cycles
 before: research-compare-to-csv #2 and #3 (20 actions each, STUCK_LOOP,
 FACT_NOT_NOTED vendor1..3, the grader's `visited` false) alternated
 click_control between the first row's "Details" link and "Back to vendors",
 opening the first vendor again and again. The vendors fixture is a table with
 a row per vendor, the vendor's name in one cell and a link named "Details" in
 the next, so context.controls listed three links named alike: a click_control
 by that name alone is TARGET_AMBIGUOUS, and with x,y it picks whichever the
 model copied. Repeated names in lists ("Details", "View", "Edit", "Open",
 "Add to basket", "Apply") are the commonest list pattern on the web.

 The pure rules: which listed entries repeat a name (case-insensitive, after
 the walk's own trimming) within one role, and the qualified name
 "<name> (<row text>)" within the name cap, the row text cut and never the
 name. Controller.swift (controlRowText) reads the row: the nearest AXRow or
 list item above the control, then its cells in order. WebKit and Chromium
 expose a <tr> as AXRow > AXCell > AXStaticText, and a cell may carry its
 text on its own value, title or description instead of a static text
 child; the live probe of 2026-09-20 07:29 (scripts/probe-web-controls.mjs
 on the vendors fixture in Safari, the helper at bad4c35) read the row's
 children as static text alone and printed repeatedNames 1, qualified 0: the
 three "Details" links still listed alike, research-compare-to-csv 0 of 7
 that day. rowCellText below is the pure choice among the cells read: the
 first with a text, skipping the cell that holds the control itself (the
 link's own cell, whichever column it is in) and any whose text is the
 control's own name. The qualification runs before the entries are stored,
 so the name the model reads is the name resolveNamedControlEntry matches,
 and "Details" alone stays ambiguous across the qualified names
 (targetTitleMatches: a prefix ending at a boundary). A control both walks
 list (the tracked walk of windowState reaches a small page's links too)
 keeps the web walk's qualified name: mergeControls replaces the bare entry
 when isRowQualified says the later name is the earlier one qualified.
 */

/// The cap on a listed control's name in UTF-16 units: modelControlName's,
/// CONTROL_LABEL_LIMIT in src/core/labels.ts and the context schema's
/// (src/core/context.ts, bounded(80)).
let controlNameChars = 80
/// The row text's own bound before it is joined: the row's first cell (a
/// vendor's name, a sender, a title) in a few words.
let rowTextChars = 30
/// How far up from a control its row is looked for: a link sits in a cell in
/// a row, a button in a group in a cell in a row; eight reaches a row from
/// any control in a table's cell or a list item's paragraph.
let rowSearchDepth = 8
/// Roles that are a row of a list: an AXRow (a <tr>, an AppKit table row).
let rowRoles: Set<String> = ["AXRow"]
/// Subroles that are a row of a list: a group whose subrole is AXListItem (a
/// <li> in WebKit and Chromium).
let rowSubroles: Set<String> = ["AXListItem"]
/// How long the row reads may take in all, after the walk's own budget: a
/// page of distinct names costs nothing, and a long list of repeated names
/// is qualified as far as this allows.
let rowReadSeconds = 0.15
/// How many of a row's children (its cells) are read, in order: a table's
/// leading columns, where the name that tells rows apart sits.
let rowCellLimit = 8

/// A row's child as controlRowText read it: its role, the text it answered
/// (a cell's own value, title or description, else the first static text
/// under it, else its title element's name; an editable field's title or
/// description alone, never its value) and whether it holds the control (it
/// is the ancestor of the control directly under the row: the cell with the
/// link in it, whose text is the link's own name or its neighbour's).
struct RowCell { let role: String; let text: String; let holdsControl: Bool }
/// The text that names a control's row, chosen among its cells in order: the
/// first of the leading rowCellLimit cells that does not hold the control
/// and answers a text that is not the control's own name (whitespace
/// collapsed, case ignored), that text collapsed and bounded to rowTextChars.
/// Empty when no cell qualifies. The vendors fixture's row is the vendor's
/// name in one cell and the "Details" link in the next; a row with the link
/// first and the name after it reads the same, since the link's cell is
/// skipped by identity and not by position.
func rowCellText(_ cells: [RowCell], own: String) -> String {
    let ownWords = own.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ").lowercased()
    for cell in cells.prefix(rowCellLimit) where !cell.holdsControl {
        let words = cell.text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        guard !words.isEmpty, words.lowercased() != ownWords else { continue }
        return utf16Prefix(words, rowTextChars).trimmingCharacters(in: .whitespaces)
    }
    return ""
}
/// Whether `candidate` is `name` qualified by a row, "<name> (<row>)" as
/// rowQualifiedName joins it, with at least one character of row text. The
/// tracked walk (windowState, Controller.swift) lists a small page's links
/// too, with the bare name, and comes first in mergeControls; the web walk's
/// entry for the same control, by role and position, replaces it when this
/// holds, so the qualified name is the one the model reads and a
/// click_control resolves.
func isRowQualified(_ candidate: String, of name: String) -> Bool {
    !name.isEmpty && candidate.utf16.count > name.utf16.count + 3 && candidate.hasPrefix(name + " (") && candidate.hasSuffix(")")
}

/// A name as it repeats: whitespace collapsed and lowercased, keyed with its
/// role, since "Details" the link and "Details" the button are told apart by
/// the role a click_control may name.
func listNameKey(name: String, role: String) -> String {
    let collapsed = name.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ").lowercased()
    return role.trimmingCharacters(in: .whitespaces).lowercased() + "|" + collapsed
}
/// The indexes of the entries whose name another entry of the same role
/// shares, in order. A nameless entry never repeats.
func repeatedNameIndexes(_ entries: [(name: String, role: String)]) -> [Int] {
    var counts = [String: Int]()
    let keys = entries.map { entry -> String? in
        entry.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : listNameKey(name: entry.name, role: entry.role)
    }
    for key in keys { if let key { counts[key, default: 0] += 1 } }
    return entries.indices.filter { index in
        guard let key = keys[index] else { return false }
        return counts[key, default: 0] >= 2
    }
}
/// The row text as it is joined: whitespace collapsed, parentheses dropped
/// (so the qualifier stays one parenthesised group, which
/// normalizeControlLabel in src/core/policy.ts knows to strip), bounded to
/// rowTextChars; empty when it is the control's own name.
func rowQualifier(_ row: String, own: String) -> String {
    let words = row.replacingOccurrences(of: "(", with: " ").replacingOccurrences(of: ")", with: " ")
        .split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    let ownWords = own.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    guard !words.isEmpty, words.lowercased() != ownWords.lowercased() else { return "" }
    return utf16Prefix(words, rowTextChars).trimmingCharacters(in: .whitespaces)
}
/// "<name> (<row>)" within `limit` UTF-16 units: the row text is cut to the
/// room the name leaves, never the name. The name as it was when the row
/// text is empty, is the name itself, or has no room for one character.
func rowQualifiedName(_ name: String, row: String, limit: Int = controlNameChars) -> String {
    let qualifier = rowQualifier(row, own: name)
    guard !qualifier.isEmpty else { return name }
    let room = limit - name.utf16.count - 3 // " (" and ")"
    guard room >= 1 else { return name }
    let cut = utf16Prefix(qualifier, room).trimmingCharacters(in: .whitespaces)
    guard !cut.isEmpty else { return name }
    return "\(name) (\(cut))"
}
/// The names of a list with the repeated ones qualified by their row. `row`
/// is read only for an entry that repeats (an accessibility walk in
/// Controller.swift, controlRowText) and may answer nothing, which leaves
/// that name as it was, still repeated.
func qualifiedListNames(_ entries: [(name: String, role: String)], limit: Int = controlNameChars, row: (Int) -> String) -> [String] {
    var names = entries.map { $0.name }
    for index in repeatedNameIndexes(entries) {
        names[index] = rowQualifiedName(entries[index].name, row: row(index), limit: limit)
    }
    return names
}
