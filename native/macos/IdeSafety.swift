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

// MARK: Watching a coding agent's panel

/**
 The states a coding agent's panel can show, read from its text: the same
 anchor tables as src/core/monitor.ts, so the helper and the watch agree on
 what "working", "needs permission" and "done" look like. The strings come
 from the Claude Code extension bundle and VS Code's own message table;
 Cursor's and Cascade's are unverified and kept short. Nothing here acts on
 the text: a wrong guess costs a wake, never an input.
 */
let agentPanelAnchors: [String: [(state: String, patterns: [String])]] = [
    "claude-code": [
        ("needs_permission", ["do you want to proceed", "tell claude what to do instead", "claude needs your permission", "waiting for your permission",
                              "claude is waiting for your decision", "claude is requesting permission", "no, keep planning"]),
        ("working", ["queue another message", "claude is working", "esc to interrupt", "compacting conversation"]),
        ("idle", ["ask claude to edit", "cmd ?esc to focus or unfocus claude", "ready for your input"]),
        ("done", ["^finished$", "^stopped$", "claude is waiting for your input"]),
        ("error", ["\\binterrupted\\b", "api error", "^failed$"]),
    ],
    "copilot": [
        ("needs_permission", ["\\brun .{1,80} command\\?", "waiting for confirmation", "continue to iterate\\?", "allow in this session", "always allow"]),
        ("review_edits", ["keep all edits", "undo all edits"]),
        ("working", ["^working\\b", "thinking\\.\\.\\.", "waiting for tool"]),
        ("idle", ["^chat input", "ask copilot", "press enter to send"]),
        ("done", ["new chat response"]),
        ("error", ["^retry$"]),
    ],
    "cursor-agent": [
        ("needs_permission", ["\\brun\\b.*\\bskip\\b"]),
        ("review_edits", ["keep all", "undo all", "review next file"]),
        ("working", ["^generating"]),
    ],
    "windsurf-cascade": [
        ("needs_permission", ["\\baccept\\b.*\\breject\\b", "^continue$"]),
        ("working", ["^generating", "^running"]),
    ],
]
// When several states show at once the one that needs the user wins, then a
// failure, then activity: a permission question sits above the spinner.
let agentStatePriority = ["needs_permission", "review_edits", "error", "working", "done", "idle"]
// Exact on-screen labels that allow one request once, by agent and kind. None
// of them grants more than one use; forbiddenAllowLabel checks that too.
let agentAllowLabels: [String: [String: String]] = [
    "claude-code": ["command": "Yes", "edit": "Yes", "tool": "Yes", "plan": "Yes, and manually approve edits"],
    "copilot": ["command": "Allow", "tool": "Allow", "edit": "Allow", "continue": "Continue", "review": "Keep"],
    "cursor-agent": ["command": "Run", "tool": "Run", "edit": "Run", "review": "Keep All"],
    "windsurf-cascade": ["command": "Run", "tool": "Run", "edit": "Run"],
]
private let forbiddenAllowPattern = try! NSRegularExpression(pattern: "don'?t ask again|allow all|always allow|in this session|in this workspace|bypass|run everything|turbo|autopilot|auto[- ]?accept|auto approve", options: [.caseInsensitive])
func forbiddenAllowLabel(_ label: String) -> Bool {
    forbiddenAllowPattern.firstMatch(in: label, range: NSRange(label.startIndex..., in: label)) != nil
}
private var anchorPatternCache = [String: NSRegularExpression]()
private let anchorCacheLock = NSLock()
private func anchorPattern(_ pattern: String) -> NSRegularExpression? {
    anchorCacheLock.lock(); defer { anchorCacheLock.unlock() }
    if let cached = anchorPatternCache[pattern] { return cached }
    guard let compiled = try? NSRegularExpression(pattern: pattern) else { return nil }
    anchorPatternCache[pattern] = compiled
    return compiled
}
/**
 OCR reads an ellipsis as three dots, curly quotes as straight ones and the
 command glyph before "Esc" as "#" or "X"; anchors match this lowercase,
 single-spaced form. Same rule as normalizeOcr in src/core/monitor.ts.
 */
func normalizeOcrText(_ s: String) -> String {
    var text = s.replacingOccurrences(of: "…", with: "...")
    for quote in ["‘", "’", "‚", "‛"] { text = text.replacingOccurrences(of: quote, with: "'") }
    for quote in ["“", "”", "„", "‟"] { text = text.replacingOccurrences(of: quote, with: "\"") }
    text = text.replacingOccurrences(of: "⌘", with: "cmd").lowercased()
    text = text.replacingOccurrences(of: "(^|\\s)[#x](?=\\s?esc\\b)", with: "$1cmd", options: .regularExpression)
    return text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}
private func lineMatches(_ patterns: [String], _ line: String) -> Bool {
    patterns.contains { pattern in
        guard let regex = anchorPattern(pattern) else { return false }
        return regex.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)) != nil
    }
}
/// Whether a normalized line is one of the agent's anchors.
func agentAnchor(agent: String, line: String) -> Bool {
    (agentPanelAnchors[agent] ?? []).contains { lineMatches($0.patterns, line) }
}
private func classifyPanel(agent: String, lines: [String], states: [String] = agentStatePriority) -> String {
    let table = agentPanelAnchors[agent] ?? []
    for state in states {
        guard let entry = table.first(where: { $0.state == state }) else { continue }
        if lines.contains(where: { lineMatches(entry.patterns, $0) }) { return state }
    }
    return "unknown"
}
private let askingStates = ["needs_permission", "review_edits"]
private let activityStates = ["error", "working", "done", "idle"]
/**
 The panel's state from its normalized lines with their vertical position and
 height as fractions of the window. A question for the user counts wherever it
 is: the agent shows it once and takes it down when answered. The activity
 states are read from the bottom first, where the placeholder, spinner and
 status sit, because the transcript above may still quote an old
 "interrupted"; the whole panel is read only when the bottom says nothing.
 */
func agentPanelState(agent: String, lines: [(text: String, y: Double, h: Double)]) -> String {
    let all = lines.map { $0.text }
    let asking = classifyPanel(agent: agent, lines: all, states: askingStates)
    if asking != "unknown" { return asking }
    let bottom = lines.filter { $0.y + $0.h >= 0.6 }.map { $0.text }
    let fromBottom = classifyPanel(agent: agent, lines: bottom, states: activityStates)
    if fromBottom != "unknown" { return fromBottom }
    return classifyPanel(agent: agent, lines: all, states: activityStates)
}

// MARK: Watch mode

/**
 Whether the user's Escape is the emergency stop. While a detached watch is
 the only thing going on, the helper's input is latched off and Escape is the
 user's own key in their own work, so a single press must not end the watch:
 two within 0.8 s do. Without a watch, one Escape stops as it always has.
 */
func emergencyEscape(now: TimeInterval, lastEscapeAt: TimeInterval?, watching: Bool) -> Bool {
    guard watching else { return true }
    guard let last = lastEscapeAt else { return false }
    return now - last <= 0.8 && now >= last
}
/// A probe names the bound window by the token the helper minted, and by nothing else.
func watchProbeAllowed(token: String, bound: String?) -> Bool {
    guard let bound, !bound.isEmpty, !token.isEmpty else { return false }
    return token == bound
}
/// Windows one helper holds bound at once; a watch is released before its wake-up run, so more is a leak.
let watchBindingsMax = 4
/**
 The same rule a capture applies to a browser window (guardSurface): a page on
 a protected domain, or any of its subdomains, is never read. A browser
 window whose page cannot be told is refused too while any domain is
 protected, since a watch reads it every few seconds without the user there.
 */
func watchDomainRefused(domain: String?, browser: Bool, protectedDomains: [String]) -> Bool {
    guard let domain = domain?.lowercased(), !domain.isEmpty else { return browser && !protectedDomains.isEmpty }
    return protectedDomains.contains { let p = $0.lowercased(); return domain == p || domain.hasSuffix("." + p) }
}

// MARK: Opening an item in a named application

/**
 The floor for open_file with an application: the one named must not be one a
 file may never reach (System Settings, Shortcuts, screen sharing) nor one the
 launch floor or the user's protected list refuses, terminals among them.
 Unlike the default route a folder may open in an application other than
 Finder, as an editor opens a project; the policy asks the user first unless
 their own words named both (openFileDecision), since an editor can run a
 project's own tasks as it opens.
 */
func namedFileHandlerRefused(_ named: LaunchCandidate, protectedApps: [String]) -> Bool {
    fileHandlerDeniedIds.contains(named.bundleId.lowercased()) || launchCandidateDenied(named, protectedApps: protectedApps)
}
