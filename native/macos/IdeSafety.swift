import Foundation

/**
 Coding editors: the pure rules for VS Code and its forks, whose command
 palette, quick-open box and integrated terminal can run anything.

 Mirrors src/core/ide.ts (family) and feeds its policy two facts only the
 helper can see: what the agent typed into a palette since the command that
 opened it, and whether the focused element is a terminal. The shared verdicts
 live in tests/fixtures/ide-agents.json; change both sides together.
 */

// MARK: Family

// Lowercased bundle id prefixes, the same apps as screenReaderDetectingAppPrefixes
// (InputSafety.swift): VS Code and Insiders, VSCodium, Cursor, Windsurf.
let ideBundleFamilies: [(prefix: String, family: String)] = [
    ("com.microsoft.vscode", "vscode"), ("com.vscodium", "vscode"),
    ("com.todesktop.230313mzl4w4u92", "cursor"), ("com.exafunction.windsurf", "windsurf"),
]
func ideFamily(_ bundleId: String) -> String? {
    let id = bundleId.trimmingCharacters(in: .whitespaces).lowercased()
    guard !id.isEmpty else { return nil }
    return ideBundleFamilies.first { id.hasPrefix($0.prefix) }?.family
}

// MARK: Search and palette context

/**
 The field an application's own search or palette command just opened, and
 what the agent has typed there since. ENTER in a palette runs whichever
 command is selected, so policy classifies it by that text; in VS Code and its
 forks every quick-open box turns into the palette with ">" or "task ", so the
 text is recorded there for every opener.
 */
struct SearchContext: Equatable {
    let pid: pid_t
    let at: TimeInterval
    let title: String
    let recordsQuery: Bool
    // What the agent has typed into the field since the command, when this
    // opener records it (nil otherwise): the field's exact text while `state`
    // is nil, and after that the text last known. It is kept rather than
    // dropped so a refused command stays refused after an arrow key or a
    // deletion (one BACKSPACE used to turn "Terminal: Create New Terminal"
    // into an unknown query, which policy only asked about).
    var query: String?
    var state: SearchQueryState? = nil
}
// Why `query` may no longer be the field's text or its selected entry.
enum SearchQueryState: String, Equatable {
    // An arrow or page key moved the selection off the entry the text put on
    // top. The text itself is unchanged, so a file name typed into Go to File
    // still opens a file.
    case moved
    // A deletion, a caret key, typing cut short or text past the limit: the
    // field's text may differ from `query`.
    case edited
}
let searchQueryLimit = 120
// Keys that move a palette's or search box's selection without touching its text.
let searchSelectionKeys: Set<String> = ["UP", "DOWN", "PAGEUP", "PAGEDOWN"]
func searchContextRecordsQuery(title: String, appId: String) -> Bool {
    paletteCommandTitle(title) || ideFamily(appId) != nil
}
func openedSearchContext(title: String?, pid: pid_t, at: TimeInterval, appId: String, titleLimit: Int = 60) -> SearchContext? {
    guard let title, searchCommandTitle(title) else { return nil }
    let records = searchContextRecordsQuery(title: title, appId: appId)
    return SearchContext(pid: pid, at: at, title: boundedUTF16(normalizeTargetTitle(title), titleLimit), recordsQuery: records, query: records ? "" : nil)
}
enum SearchInput: Equatable {
    // Text typed into the field; `replaced` when the field's contents were
    // selected first, so the text is now its whole value.
    case typed(String, replaced: Bool)
    // Typing of this text started but may not have finished: the field holds
    // some prefix of it (and, if a replacement stopped before its first
    // character, still the old text).
    case interrupted(String, replaced: Bool)
    case key(String)
}
/**
 How the context changes with the agent's next input. ENTER and TAB end it as
 ESC does: ENTER was judged against the field while it was current and runs
 whatever it selected, and TAB moves focus somewhere else, so neither may lend
 the search field's rules to the next keystroke. Before this, ENTER on VS
 Code's "Terminal: Create New Terminal" left the palette's context current, so
 a shell command typed next was allowed as palette text.
 UP, DOWN and the page keys only move the selection. Any other key (a
 deletion, a caret key) may change the text, so it is no longer exact, but the
 text last known is kept for policy to judge. Typing puts the top match back
 in front, so it clears a moved selection; only a replaced (select-all) typing
 makes edited text exact again.
 */
func nextSearchContext(_ context: SearchContext?, _ input: SearchInput) -> SearchContext? {
    guard var context else { return nil }
    switch input {
    case .key(let key):
        if ["ESC", "ENTER", "TAB"].contains(key) { return nil }
        guard context.recordsQuery else { return context }
        if searchSelectionKeys.contains(key) { context.state = context.state ?? .moved }
        // A space at the caret, which only typing has moved, is typed text.
        else if key == "SPACE" && context.state != .edited { context.record((context.query ?? "") + " ", state: nil) }
        else { context.state = .edited }
    case .interrupted(let text, let replaced):
        guard context.recordsQuery else { return context }
        context.record((context.query ?? "") + (replaced ? " " : "") + text, state: .edited)
    case .typed(let text, let replaced):
        guard context.recordsQuery else { return context }
        if replaced { context.record(text, state: nil) }
        else { context.record((context.query ?? "") + text, state: context.state == .edited ? .edited : nil) }
    }
    return context
}
extension SearchContext {
    // Text past the limit is cut, so what was recorded is no longer the field's
    // whole text.
    fileprivate mutating func record(_ text: String, state: SearchQueryState?) {
        let bounded = boundedUTF16(text, searchQueryLimit)
        query = bounded
        self.state = bounded == text ? state : .edited
    }
}
private func boundedUTF16(_ value: String, _ limit: Int) -> String {
    var result = ""
    for character in value {
        if result.utf16.count + String(character).utf16.count > limit { break }
        result.append(character)
    }
    return result
}

// MARK: Terminal focus

/**
 Whether the focused element is a terminal's input. xterm.js (VS Code's
 integrated terminal, its forks, Hyper, cloud shells in a browser) takes every
 keystroke through a hidden helper textarea, which is an ordinary AXTextArea to
 accessibility: only its DOM class, a terminal role description or, in the
 editors, its label ("Terminal 1, zsh"; xterm.js's own "Terminal input") tell
 it apart from a chat or search box. The label rule is limited to the editors
 because elsewhere "Terminal" names ordinary fields (an airport's terminal).
 With the editors' tree hidden none of this is visible, which is why policy
 also refuses typing into an unidentified focus there.
 */
func terminalFocusEvidence(roleDescription: String, label: String, domClasses: [String], ide: Bool) -> Bool {
    if domClasses.contains(where: { $0.lowercased().hasPrefix("xterm") }) { return true }
    if roleDescription.lowercased().range(of: "\\bterminal\\b", options: .regularExpression) != nil { return true }
    guard ide else { return false }
    let words = label.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    return words.range(of: "^terminal\\b", options: .regularExpression) != nil
}
