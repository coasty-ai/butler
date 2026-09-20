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
 name. Controller.swift (controlRowText) reads the row: the nearest AXRow
 (WebKit and Chromium expose a <tr> as an AXRow with AXCell children) or list
 item above the control, and the first static text in it that is not the
 control's own name. The qualification runs before the entries are stored,
 so the name the model reads is the name resolveNamedControlEntry matches,
 and "Details" alone stays ambiguous across the qualified names
 (targetTitleMatches: a prefix ending at a boundary).
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
