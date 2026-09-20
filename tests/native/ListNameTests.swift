import Foundation

// Pure checks for names repeated in a list (ListNames.swift): which listed
// entries repeat a name within one role, the qualified name "<name> (<row
// text>)" within the name cap with the row text cut and never the name, and
// that the qualified names are what matchNamedControl resolves. Market sweep
// 1/3 at 55e4e83 (cycle 20260920-0514-55e4e83): the vendors table's three
// "Details" links were listed alike, and research-compare-to-csv opened the
// first vendor again and again. Then the cell choice (rowCellText) and the
// merge rule (isRowQualified): the probe of 2026-09-20 07:29 on that page
// read the row's children as static text alone and still printed qualified
// 0, since WebKit exposes a <tr> as AXRow > AXCell > AXStaticText and a
// cell may carry its text itself, and the tracked walk lists a small page's
// links first with the bare name. Every name here is synthetic.
func listNameChecks(_ check: (Bool, String) -> Void) {
    typealias Entry = (name: String, role: String)
    let vendors: [Entry] = [("Details", "link"), ("Details", "link"), ("Details", "link"), ("Back to vendors", "link")]
    // repeatedNameIndexes
    check(repeatedNameIndexes(vendors) == [0, 1, 2], "three links named alike repeat; the one named on its own does not")
    check(repeatedNameIndexes([("Details", "link"), ("details", "link")]) == [0, 1], "a name repeats whatever its case")
    check(repeatedNameIndexes([("Details", "link"), (" Details  ", "link")]) == [0, 1], "a name repeats whatever its padding or spacing")
    check(repeatedNameIndexes([("Details", "link"), ("Details", "button")]).isEmpty, "the same name under two roles is not a repeat: a click_control may name the role")
    check(repeatedNameIndexes([("Details", "link")]).isEmpty, "a name listed once does not repeat")
    check(repeatedNameIndexes([("", "textfield"), ("", "textfield"), ("  ", "textfield")]).isEmpty, "nameless fields never repeat")
    check(repeatedNameIndexes([]).isEmpty, "no entries, no repeats")
    // rowQualifier and rowQualifiedName
    check(rowQualifiedName("Details", row: "Vendor B") == "Details (Vendor B)", "the row text follows the name in parentheses")
    check(rowQualifiedName("Details", row: "  Vendor\tB \n") == "Details (Vendor B)", "the row text is trimmed and its whitespace collapsed")
    check(rowQualifiedName("Details", row: "") == "Details", "no row text leaves the name as it was")
    check(rowQualifiedName("Details", row: "details") == "Details", "a row text that is the control's own name qualifies nothing")
    check(rowQualifiedName("Details", row: "Acme (UK)") == "Details (Acme UK)", "parentheses in the row text are dropped, so the qualifier stays one group")
    check(rowQualifiedName("Details", row: String(repeating: "v", count: 40)) == "Details (" + String(repeating: "v", count: rowTextChars) + ")",
          "the row text is bounded to rowTextChars before it is joined")
    let long = String(repeating: "n", count: 75)
    check(rowQualifiedName(long, row: "Vendor B") == long + " (Ve)", "the row text is cut to the room the name leaves within the cap")
    check(rowQualifiedName(long, row: "Vendor B").utf16.count == controlNameChars, "a cut qualified name fills the cap exactly")
    check(rowQualifiedName(String(repeating: "n", count: 77), row: "Vendor B") == String(repeating: "n", count: 77), "a name leaving no room for one character stays whole and unqualified")
    check(rowQualifiedName(String(repeating: "n", count: 80), row: "Vendor B") == String(repeating: "n", count: 80), "a name at the cap is never cut")
    check(rowQualifiedName(String(repeating: "n", count: 76), row: " x") == String(repeating: "n", count: 76) + " (x)", "one character of room carries one character")
    check(rowQualifiedName("Details", row: "Vendor B", limit: 12) == "Details (Ve)", "the limit is the caller's")
    check(rowQualifiedName("Details", row: "Vendor B", limit: 10) == "Details", "with no room under the caller's limit the name is unchanged")
    let sixty = String(repeating: "n", count: 60)
    let qualified = rowQualifiedName(sixty, row: String(repeating: "r", count: 30))
    check(qualified.hasPrefix(sixty + " (") && qualified.hasSuffix(")") && qualified.utf16.count == controlNameChars,
          "a 60-unit name with a 30-unit row text is cut to the cap with the name whole")
    check(rowQualifiedName("Détails", row: "Vendor Ä").utf16.count == "Détails (Vendor Ä)".utf16.count, "the bound counts UTF-16 units like the TypeScript validator")
    // qualifiedListNames
    let rows = ["Vendor A", "Vendor B", "Vendor C", "never read"]
    var read = [Int]()
    let names = qualifiedListNames(vendors) { index in read.append(index); return rows[index] }
    check(names == ["Details (Vendor A)", "Details (Vendor B)", "Details (Vendor C)", "Back to vendors"], "three Details with three row texts are three distinct names; the fourth link is untouched")
    check(read == [0, 1, 2], "the row is read for the repeated entries alone, in order")
    check(Set(names).count == names.count, "the qualified names are distinct")
    check(qualifiedListNames(vendors) { _ in "" } == vendors.map { $0.name }, "with no row text found the names stay as they were, still repeated")
    check(qualifiedListNames(vendors) { $0 == 1 ? "Vendor B" : "" } == ["Details", "Details (Vendor B)", "Details", "Back to vendors"], "a row found for one entry qualifies that entry alone")
    check(qualifiedListNames([("Add to basket", "button"), ("Add to basket", "button"), ("Apply", "button")]) { ["Widget", "Gadget", "x"][$0] }
          == ["Add to basket (Widget)", "Add to basket (Gadget)", "Apply"], "a shop's repeated buttons are told apart the same way")
    check(qualifiedListNames([("", "textfield"), ("", "textfield")]) { _ in "Row" } == ["", ""], "nameless fields are never qualified")
    // The qualified names are what a click_control resolves against (NamedTargets.swift).
    let controls = names.enumerated().map { NamedControl(label: $0.element, role: "link", x: 0.42, y: 0.3 + Double($0.offset) * 0.04, enabled: true) }
    check(matchNamedControl(controls, label: "Details (Vendor B)", role: nil, hintX: nil, hintY: nil) == .matched(1), "a qualified name resolves to its row's link exactly")
    check(matchNamedControl(controls, label: "details (vendor c)", role: "link", hintX: nil, hintY: nil) == .matched(2), "case and a role filter do not change that")
    check(matchNamedControl(controls, label: "Details", role: nil, hintX: nil, hintY: nil) == .ambiguous(3), "the bare name alone is still ambiguous across the qualified names")
    check(matchNamedControl(controls, label: "Details", role: nil, hintX: 0.42, hintY: 0.38) == .matched(2), "the bare name with the position copied from the list still picks the nearest")
    check(matchNamedControl(controls, label: "Details (Vendor D)", role: nil, hintX: nil, hintY: nil) == .missing, "a qualifier naming a row that is not listed matches nothing")
    check(matchNamedControl(controls, label: "Back to vendors", role: nil, hintX: nil, hintY: nil) == .matched(3), "the unrepeated link resolves as before")
    // rowCellText: which cell's text names the row. The vendors fixture's row
    // is the vendor's name in one AXCell and the "Details" link's cell next.
    let cell = { (text: String) in RowCell(role: "AXCell", text: text, holdsControl: false) }
    let holder = RowCell(role: "AXCell", text: "Details", holdsControl: true)
    check(rowCellText([cell("Vendor A"), holder], own: "Details") == "Vendor A", "the first cell with a text names the row")
    check(rowCellText([holder, cell("Vendor A")], own: "Details") == "Vendor A", "the cell holding the control is skipped wherever it comes, so the name after the link is found")
    check(rowCellText([RowCell(role: "AXCell", text: "Acme Ltd", holdsControl: true), cell("Vendor A")], own: "Details") == "Vendor A",
          "the control's own cell is skipped by identity even when its text is not the control's name")
    check(rowCellText([cell("details"), cell("Vendor A")], own: "Details") == "Vendor A", "a cell whose text is the control's own name, whatever its case, is skipped")
    check(rowCellText([cell(" Add  to\tbasket "), cell("Widget")], own: "Add to basket") == "Widget", "the own-name comparison collapses whitespace")
    check(rowCellText([cell(""), cell("   "), cell("Vendor A")], own: "Details") == "Vendor A", "empty and blank cells are skipped")
    check(rowCellText([cell("Vendor A"), cell("Vendor B")], own: "Details") == "Vendor A", "the first qualifying cell wins over a later one")
    check(rowCellText(Array(repeating: cell(""), count: 8) + [cell("Ninth")], own: "Details") == "", "cells past rowCellLimit are never read")
    check(rowCellText(Array(repeating: cell(""), count: 7) + [cell("Eighth")], own: "Details") == "Eighth", "the eighth cell is still in reach")
    check(rowCellText([cell("  Vendor\n A  ")], own: "Details") == "Vendor A", "the chosen text is trimmed and its whitespace collapsed")
    check(rowCellText([cell(String(repeating: "v", count: 40))], own: "Details") == String(repeating: "v", count: rowTextChars), "the chosen text is bounded to rowTextChars")
    check(rowCellText([cell("Vendor Ä" + String(repeating: "x", count: 40))], own: "Details").utf16.count == rowTextChars, "the bound counts UTF-16 units")
    check(rowCellText([], own: "Details") == "", "no cells, no row text")
    check(rowCellText([holder], own: "Details") == "", "a row holding the control alone names nothing")
    check(rowCellText([RowCell(role: "AXStaticText", text: "Vendor A", holdsControl: false), RowCell(role: "AXLink", text: "Details", holdsControl: true)], own: "Details") == "Vendor A",
          "a list item's static text and link read the same way as a table's cells")
    check(rowCellText([RowCell(role: "AXLink", text: "Vendor A", holdsControl: false), holder], own: "Details") == "Vendor A", "a name that is itself a link still names the row")
    check(rowQualifiedName("Details", row: rowCellText([holder, cell("Vendor B")], own: "Details")) == "Details (Vendor B)", "the chosen cell text is what the qualified name carries")
    check(rowQualifiedName("Details", row: rowCellText([holder], own: "Details")) == "Details", "no cell chosen leaves the name as it was")
    // isRowQualified: what mergeControls lets a later entry replace.
    check(isRowQualified("Details (Vendor B)", of: "Details"), "the name with a row qualifier replaces the bare name")
    check(isRowQualified(rowQualifiedName("Details", row: "Acme (UK)"), of: "Details"), "whatever rowQualifiedName joins is accepted")
    check(isRowQualified(rowQualifiedName(long, row: "Vendor B"), of: long), "a qualified name cut to the cap is accepted too")
    check(!isRowQualified("Details", of: "Details"), "the same bare name replaces nothing")
    check(!isRowQualified("Details (Vendor B)", of: "Detail"), "a name that is only a prefix of the other is not the other qualified")
    check(!isRowQualified("Details (Vendor B", of: "Details"), "an unclosed group is not a qualifier")
    check(!isRowQualified("Details ()", of: "Details"), "an empty group is not a qualifier")
    check(!isRowQualified("Details (Vendor B)", of: ""), "a nameless entry is never replaced")
    check(!isRowQualified("Back to vendors", of: "Details"), "another name replaces nothing")
    check(!isRowQualified("Details", of: "Details (Vendor B)"), "the bare name never replaces the qualified one")
    // The constants Controller.swift reads.
    check(controlNameChars == 80, "the name cap is the one modelControlName, CONTROL_LABEL_LIMIT and the context schema share")
    check(rowTextChars == 30 && rowSearchDepth == 8 && rowReadSeconds == 0.15, "the row text bound, the search depth and the read budget")
    check(rowCellLimit == 8, "eight of a row's cells are read at most")
    check(rowRoles == ["AXRow"] && rowSubroles == ["AXListItem"], "a row is an AXRow or a group with the AXListItem subrole")
    check(listNameKey(name: " Add  to Basket ", role: "Button") == "button|add to basket", "the repeat key is the role and the collapsed lowercased name")
}
