import Foundation

/**
 Acting on what the model can name.

 Pixel coordinates are a guess: a page that animates, a list that reflows or a
 thumbnail that plays on hover invalidates them between the screenshot and the
 click, and an unlabelled container under the pointer tells policy nothing. The
 two surfaces an application publishes by name are its menu bar and its visible
 controls, and both can be resolved again at the moment of input. These are the
 pure rules for matching a name, for what is never pressed, and for how much of
 a menu is shown to the model; the helper does the accessibility reads.
 */

// MARK: Names

/**
 A title as it is matched and shown: trimmed, without the trailing ellipsis
 that marks an item opening a dialog, with runs of whitespace collapsed. Case
 is preserved for display; matching lowercases separately.
 */
func normalizeTargetTitle(_ value: String) -> String {
    let collapsed = value.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    var trimmed = collapsed
    while let last = trimmed.last, last == "…" || last == "." || last == "›" || last == "▸" || last == ">" {
        trimmed = String(trimmed.dropLast())
    }
    return trimmed.trimmingCharacters(in: .whitespaces)
}

// A request may stop short of the full title ("Play" for "Play/Pause", a video
// title the model quoted only the start of), but it must end where the title
// has a boundary, so "Play" can never select "Playlists".
private func boundaryCharacter(_ value: Character) -> Bool {
    value == " " || value == "/" || value == "-" || value == ":" || value == "," || value == "(" || value == "|" || value == "·"
}

/**
 Whether a requested name identifies this title: the same title, or a prefix of
 it that ends at a word boundary. Never a match inside the title, so a short
 word cannot select an unrelated long label.
 */
func targetTitleMatches(request: String, title: String) -> Bool {
    let wanted = normalizeTargetTitle(request).lowercased()
    let actual = normalizeTargetTitle(title).lowercased()
    guard !wanted.isEmpty, !actual.isEmpty else { return false }
    if wanted == actual { return true }
    guard actual.hasPrefix(wanted) else { return false }
    return boundaryCharacter(actual[actual.index(actual.startIndex, offsetBy: wanted.count)])
}

// MARK: Named controls

// One control as the model was shown it: the name it can quote, the short role
// name ("link", "button"), and the centre as a screen fraction.
struct NamedControl {
    let label: String
    let role: String
    let x: Double
    let y: Double
    let enabled: Bool
}
// Words that name a kind of control rather than a control: the model sometimes
// writes the role where the label belongs ("link" with the right x,y).
let placeholderControlNames: Set<String> = [
    "link", "button", "textfield", "text field", "textarea", "checkbox", "radiobutton",
    "popupbutton", "menubutton", "tab", "cell", "row", "image", "control", "item",
    "element", "result", "thumbnail", "video", "field",
]
func placeholderControlName(_ label: String) -> Bool {
    placeholderControlNames.contains(normalizeTargetTitle(label).lowercased())
}
// How far a copied position may be from a listed control's centre, as a screen
// fraction: positions in context.controls are rounded to three decimals.
let namedControlPositionTolerance = 0.006
enum ControlMatch: Equatable {
    case matched(Int)
    // Several controls share the name and no position told them apart: the
    // agent is told to name a different one rather than pick for it.
    case ambiguous(Int)
    case missing
}

/**
 Resolves the control a `click_control` names against what is on screen now.

 Exact names win over prefixes, so "Home" never loses to "Home improvement".
 When several controls share a name (a list of identical "Play" buttons), the
 optional position the model read from the same context list breaks the tie by
 distance; without one the call is ambiguous and nothing is clicked. A role
 filter, when given, is applied first.
 */
func matchNamedControl(_ controls: [NamedControl], label: String, role: String?,
                       hintX: Double?, hintY: Double?) -> ControlMatch {
    let wantedRole = role?.trimmingCharacters(in: .whitespaces).lowercased()
    let eligible = controls.enumerated().filter { _, control in
        guard let wantedRole, !wantedRole.isEmpty else { return true }
        return control.role.lowercased() == wantedRole
    }
    let wanted = normalizeTargetTitle(label).lowercased()
    guard !wanted.isEmpty else { return .missing }
    let exact = eligible.filter { normalizeTargetTitle($0.element.label).lowercased() == wanted }
    let prefixed = eligible.filter { targetTitleMatches(request: label, title: $0.element.label) }
    let tier = !exact.isEmpty ? exact : prefixed
    guard !tier.isEmpty else {
        // The name matched nothing, but the position is one the model copied
        // from the same list (live: label "link" with the exact x,y of the
        // video it meant). A single listed control at that spot is the one it
        // chose; its real name still goes through policy after the hit test.
        // Only for a placeholder name: a specific name that is not on screen
        // means the screen moved on, and whatever sits at that spot now is
        // not what was asked for.
        guard let hintX, let hintY, placeholderControlName(label) else { return .missing }
        let close = eligible.filter {
            abs($0.element.x - hintX) <= namedControlPositionTolerance && abs($0.element.y - hintY) <= namedControlPositionTolerance
        }
        return close.count == 1 ? .matched(close[0].offset) : .missing
    }
    if tier.count == 1 { return .matched(tier[0].offset) }
    guard let hintX, let hintY else { return .ambiguous(tier.count) }
    let distance = { (control: NamedControl) -> Double in
        let dx = control.x - hintX, dy = control.y - hintY
        return dx * dx + dy * dy
    }
    let sorted = tier.sorted { distance($0.element) < distance($1.element) }
    return .matched(sorted[0].offset)
}

// MARK: Menu bar

/**
 The menu bar is every macOS application's own declaration of what it can do.
 AppKit builds it from the application's NSMenu, so it stays in the
 accessibility tree with titles, shortcuts and enabled state even when the
 window publishes nothing (Chromium/CEF applications such as Spotify), and it
 lists commands that appear nowhere on screen. Reading it is how the agent
 learns an unfamiliar application instead of guessing pixels.
 */

// Bound text by UTF-16 code units (what the TypeScript validator counts),
// never splitting a grapheme cluster.
func utf16Prefix(_ value: String, _ limit: Int) -> String {
    var result = ""
    for character in value {
        if result.utf16.count + String(character).utf16.count > limit { break }
        result.append(character)
    }
    return result
}
// Enough menus for the applications people drive and enough items to carry a
// menu's real commands without flooding the model's context.
let menuTitleLimit = 44
let menuListLimit = 12
let menuItemListLimit = 14

// The Apple menu belongs to the system, not to the application: it holds Shut
// Down, Restart, Log Out and Force Quit, and nothing in it helps finish a
// task. It is never listed and never pressed, whatever the path says. Items
// that end the session, the application or the Mac are refused wherever they
// appear: quitting stays the user's to do.
let systemMenuTitles: Set<String> = ["apple", ""]
let irreversibleMenuItems: Set<String> = [
    "shut down", "restart", "sleep", "log out", "lock screen", "force quit", "quit",
    "erase all content and settings", "empty trash",
]
private let irreversibleMenuPrefixes = ["quit ", "force quit", "log out ", "shut down", "restart "]

func menuPathRefused(_ path: [String]) -> Bool {
    guard let first = path.first else { return true }
    if systemMenuTitles.contains(normalizeTargetTitle(first).lowercased()) { return true }
    return path.contains { segment in
        let title = normalizeTargetTitle(segment).lowercased()
        return irreversibleMenuItems.contains(title) || irreversibleMenuPrefixes.contains { title.hasPrefix($0) }
    }
}

// MARK: A windowless application's main window

/**
 A running application can come to the front with no window at all (live:
 Calendar after its window was closed), and the screenshot then shows the
 application behind it. A Dock click would reopen it through LaunchServices,
 but a windowless document app answers that with an Open panel or a template
 chooser (launchReopenAllowed in LaunchSafety.swift), so the helper presses the
 application's own Window menu item for its main window instead. Only an exact
 name is taken: the application's own name (Calendar, Notes, Messages, Music,
 Spotify) or its fixed main-window title below; never an item that acts on
 windows already there, and never one menuPathRefused refuses.

 AppKit lists every window of the application after Bring All to Front, titled
 by the window itself (a web page's title, a folder, a terminal's escape
 sequence), minimized and other-Space windows included. Nothing past that item
 is a command, so the scan ends there, and a menu without it is not read at
 all: its window list could not be told from its commands. Disabled items stay
 candidates, because AppKit validates a menu only when it opens; the helper
 checks again with the menu open. The entry itself is returned, so the item
 pressed is the item checked, never a longer title sharing its prefix.
 */
// Main windows not named after their application, by bundle identifier
// (lowercased), each confirmed in the application's own menu nib.
let mainWindowMenuTitles: [String: Set<String>] = ["com.apple.mail": ["message viewer"]]
private let windowListStartTitles: Set<String> = ["bring all to front", "arrange in front"]
private let windowArrangingWords: Set<String> = [
    "close", "minimize", "minimise", "merge", "move", "zoom", "tile", "fill", "center", "centre",
    "full", "hide", "bring", "cycle", "arrange", "remove", "resize", "float",
]
func mainWindowMenuEntry<Entry>(appNames: [String], bundleId: String, entries: [Entry], digest: (Entry) -> MenuItemDigest?) -> Entry? {
    let names = Set(appNames.map { normalizeTargetTitle($0).lowercased() }.filter { !$0.isEmpty })
    let fixed = mainWindowMenuTitles[bundleId.lowercased()] ?? []
    var chosen: Entry? = nil
    for entry in entries {
        guard let item = digest(entry) else { continue } // separators carry no title
        let title = normalizeTargetTitle(item.title).lowercased()
        if windowListStartTitles.contains(title) { return chosen }
        guard chosen == nil, !item.submenu, !title.isEmpty, !menuPathRefused(["Window", item.title]) else { continue }
        let words = title.split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init)
        guard !words.contains(where: windowArrangingWords.contains) else { continue }
        // Exact, never targetTitleMatches: its word-boundary prefix would let
        // "Calendar" take "Calendar Settings".
        if names.contains(title) || fixed.contains(title) { chosen = entry }
    }
    return nil
}

// AXMenuItemCmdModifiers is a mask over Command: bit 3 clear means Command is
// part of the shortcut, and the low bits add Shift, Option and Control. The
// names are the agent's own key names, so a shortcut read from a menu is one
// it can press.
func menuShortcutModifiers(_ modifiers: Int) -> [String] {
    var names = [String]()
    if modifiers & 8 == 0 { names.append("CMD") }
    if modifiers & 4 != 0 { names.append("CTRL") }
    if modifiers & 2 != 0 { names.append("ALT") }
    if modifiers & 1 != 0 { names.append("SHIFT") }
    return names
}
// Menu shortcuts whose key has no printable character.
let menuShortcutVirtualKeys: [Int: String] = [
    36: "ENTER", 48: "TAB", 49: "SPACE", 51: "BACKSPACE", 53: "ESC", 115: "HOME",
    116: "PAGEUP", 117: "DELETE", 119: "END", 121: "PAGEDOWN", 123: "LEFT",
    124: "RIGHT", 125: "DOWN", 126: "UP",
]
/**
 A menu item's shortcut in the agent's key names ("CMD+L", "CMD+SHIFT+N"), or
 nil when it has none or uses a key the agent cannot send. Unsendable keys are
 dropped rather than rendered, so every shortcut the model reads is pressable.
 */
func menuShortcut(cmdChar: String, virtualKey: Int?, modifiers: Int) -> String? {
    let character = cmdChar.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
    var key: String? = nil
    if character.count == 1, let scalar = character.unicodeScalars.first, scalar.isASCII,
       CharacterSet.alphanumerics.contains(scalar) {
        key = character
    } else if let virtualKey, let named = menuShortcutVirtualKeys[virtualKey] {
        key = named
    }
    guard let key else { return nil }
    let modifierNames = menuShortcutModifiers(modifiers)
    guard !modifierNames.isEmpty else { return nil }
    return (modifierNames + [key]).joined(separator: "+")
}

/**
 One line per menu for the model's context. Disabled items are kept and marked:
 what an application greys out is evidence about the state it is in (Spotify
 greys out Search while no window is open), and pressing one is refused anyway.
 */
struct MenuItemDigest {
    let title: String
    let shortcut: String?
    let enabled: Bool
    let submenu: Bool
}
func menuDigestLine(menu: String, items: [MenuItemDigest], itemLimit: Int = menuItemListLimit) -> String {
    let rendered = items.prefix(itemLimit).map { item -> String in
        var text = String(normalizeTargetTitle(item.title).prefix(menuTitleLimit))
        if let shortcut = item.shortcut { text += " [\(shortcut)]" }
        if item.submenu { text += " >" }
        if !item.enabled { text += " (disabled)" }
        return text
    }
    let title = String(normalizeTargetTitle(menu).prefix(menuTitleLimit))
    return rendered.isEmpty ? title : "\(title): " + rendered.joined(separator: ", ")
}

/**
 A chord in the one spelling menus and policy both use: modifiers in a fixed
 order, then the key ("CMD+SHIFT+N"). The agent may send its keys in any order.
 */
func normalizeChord(_ keys: [String]) -> String {
    let upper = keys.map { $0.trimmingCharacters(in: .whitespaces).uppercased() }
    let order = ["CMD", "CTRL", "ALT", "SHIFT"]
    let modifiers = order.filter { upper.contains($0) }
    let rest = upper.filter { !order.contains($0) }.sorted()
    return (modifiers + rest).joined(separator: "+")
}

// MARK: Shortcuts pressed through the menu

/**
 Chords whose target is the text in the focused field rather than the
 application: select all, bold/italic/underline, undo, redo, every clipboard
 chord, and a modifier with an arrow, Home, End, Page Up/Down or a delete key
 (caret and selection moves, word and line deletes). They stay keys sent to the
 verified focused element, because the clipboard rules (clipboardChordAllowed)
 and the focused-field revalidation are what make them safe, and the menu item
 an application binds the same chord to is a different command (Calendar's
 CMD+RIGHT is View > Next, not "end of line").
 */
private let textMoveKeys: Set<String> = ["LEFT", "RIGHT", "UP", "DOWN", "HOME", "END", "PAGEUP", "PAGEDOWN", "BACKSPACE", "DELETE"]
func focusedTextChord(_ keys: [String]) -> Bool {
    let names = keys.map { $0.trimmingCharacters(in: .whitespaces).uppercased() }
    if !clipboardChordAllowed(names: names, paste: false) { return true }
    let rest = names.filter { !["CMD", "CTRL", "ALT", "SHIFT"].contains($0) }
    if !rest.isEmpty && rest.allSatisfy(textMoveKeys.contains) { return true }
    // The chords policy allows as "select or format text in a known field", plus undo and redo.
    return ["CMD+A", "CMD+B", "CMD+I", "CMD+U", "CMD+Z", "CMD+SHIFT+Z"].contains(normalizeChord(names))
}
/** The menu item the frontmost application publishes for a chord, as [menu, item title]. */
func publishedShortcutItem(keys: [String], shortcuts: [String: [String]]) -> [String]? {
    guard let path = shortcuts[normalizeChord(keys)], path.count >= 2 else { return nil }
    return path
}
/** The item's title as surface reports it (shortcutLabel), bounded like the menu digest. */
func shortcutMenuLabel(_ path: [String]) -> String { utf16Prefix(path.last ?? "", menuTitleLimit) }

enum HotkeyRoute: Equatable {
    case keys, menu([String]), refused, changed
    var menuPath: [String]? { if case .menu(let path) = self { return path }; return nil }
}
/**
 How a hotkey reaches the frontmost application, decided once per execute:
 - refused: its chord is published for an item that is never pressed (Quit,
   Log Out, Empty Trash). Refused whichever way it would go, text chords
   included: its keys are never posted in its place.
 - changed: the chord no longer names the item policy judged it by (label, the
   shortcutLabel surface reported and the runner sends back; the item the user
   approved, for an approved step). Bound whenever a label was judged, and always
   once approved (a label of nil then means the chord named nothing at the time):
   a menu that changed in between is never a way to press an item policy never
   saw. Nothing is sent, and any approval is spent.
 - menu: a published chord other than a text chord, pressed as that item
   (AXPress, resolved again right before input with the chord it must still
   carry). Live: right after Calendar launched its focus moved between
   screenshot and input, and six CMD+N (File > New Event) were refused in a row.
 - keys: text chords and chords no menu publishes, posted to the verified
   focused element as before.
 */
func hotkeyRoute(keys: [String], shortcuts: [String: [String]], approved: Bool, label: String?) -> HotkeyRoute {
    let item = publishedShortcutItem(keys: keys, shortcuts: shortcuts)
    if let item, menuPathRefused(item) { return .refused }
    if approved || label != nil, item.map(shortcutMenuLabel) != label { return .changed }
    guard let item, !focusedTextChord(keys) else { return .keys }
    return .menu(item)
}
/**
 "refused" when native refuses the chord (hotkeyRoute), so policy refuses it
 before asking the user to approve a step that could only end in that refusal.
 */
func shortcutStatus(keys: [String], shortcuts: [String: [String]]) -> String? {
    hotkeyRoute(keys: keys, shortcuts: shortcuts, approved: false, label: nil) == .refused ? "refused" : nil
}
/**
 Whether revalidation checks a step by its name alone (menu_item, click_control,
 and a hotkey pressed through its menu item), leaving out the fresh capture after
 a quick decision and the focused-field and controls checks. A menu-routed hotkey
 counts only before an approval: the approval was given on the screen as it was,
 and a menu command acts on whatever holds focus or selection (Edit > Delete,
 Move to Trash), so once approved it gets the full keyboard check keys get, and a
 change there expires the approval.
 */
func revalidatesByName(type: String, menuRoute: [String]?, approved: Bool) -> Bool {
    ["menu_item", "click_control"].contains(type) || (type == "hotkey" && menuRoute != nil && !approved)
}

enum MenuItemState { case enabled, disabled, missing }
let menuRefusal = "Menu items that quit an application or end the session are left to the user."
/**
 How a menu press names its item in an error. A hotkey pressed through its item
 names only its chord: the title can carry a document's name (Finder's File >
 Quick Look "<file>"), and the error sentence goes into the trace. The model
 already sees the item in context.menus. A menu_item names the path it sent.
 */
func menuCommandName(path: [String], chord: String?) -> String {
    chord.map { "The menu item for \($0)" } ?? path.joined(separator: " > ")
}
/**
 Why a menu item is not pressed, or nil to press it. Refused items are refused
 whatever their state, before anything is opened (item nil: not resolved yet).
 Nothing here falls back to keys: a hotkey whose item is refused, gone or greyed
 out reports that, and its chord is never posted in its place.
 */
func menuPressRefusal(path: [String], chord: String?, item: MenuItemState?) -> (message: String, code: String)? {
    if menuPathRefused(path) { return (menuRefusal, "TARGET_REFUSED") }
    let named = menuCommandName(path: path, chord: chord)
    switch item {
    case .missing?: return ("\(named) is not in this application's menus.", "TARGET_MISSING")
    case .disabled?: return ("\(named) is greyed out right now.", "TARGET_DISABLED")
    case .enabled?, nil: return nil
    }
}

// MARK: Search opened by the application's own command

/**
 Whether a menu command opens a search, find or quick-switch field. After the
 application's own command for that (Spotify's Edit > Search, Slack's Jump to,
 VS Code's Quick Open), the text the agent types next goes into that field even
 when the application does not expose the field to accessibility. "Replace"
 is excluded: it edits content rather than looking something up.
 */
func searchCommandTitle(_ title: String) -> Bool {
    let words = normalizeTargetTitle(title).lowercased()
    guard !words.isEmpty, !words.contains("replace") else { return false }
    let openers = ["search", "find", "filter", "quick open", "go to file", "go to symbol",
                   "jump to", "command palette", "show all commands", "quick switcher", "quick search", "open quickly", "switch to"]
    return openers.contains { opener in
        words == opener || words.hasPrefix(opener + " ") || words.hasSuffix(" " + opener)
            || words.contains(" " + opener + " ")
    }
}
/**
 Whether a search-opening command is a command palette (VS Code's View >
 Command Palette and Help > Show All Commands, Sublime Text's Tools > Command
 Palette): ENTER there runs whichever command is selected rather than opening
 a search result, so what was typed is recorded for policy (IdeSafety.swift).
 Same rule as paletteTitle in src/core/ide.ts.
 */
func paletteCommandTitle(_ title: String) -> Bool {
    let words = normalizeTargetTitle(title).lowercased()
    return ["command palette", "show all commands"].contains { opener in
        words == opener || words.hasPrefix(opener + " ") || words.hasSuffix(" " + opener)
            || words.contains(" " + opener + " ")
    }
}
/**
 A search command stays the context for typing only briefly and only in the
 application that ran it: long enough to type a query, use the arrow keys and
 press Enter, never across an application switch or a pause.
 */
let searchCommandSeconds = 45.0
func searchCommandCurrent(commandPid: pid_t, commandAt: TimeInterval, pid: pid_t, now: TimeInterval) -> Bool {
    commandPid == pid && now >= commandAt && now - commandAt <= searchCommandSeconds
}

// MARK: Query fields

/**
 Whether a focused field holds a query rather than content, so a new query
 typed into it replaces the old one instead of being appended to it (live:
 "midwest safety" + "By Justin Bieber" became one search). Search, find,
 filter and ask boxes only; a document, message or note keeps its text.
 */
func replacesOnType(role: String, subrole: String, label: String) -> Bool {
    guard ["AXTextField", "AXTextArea", "AXComboBox"].contains(role), subrole != "AXSecureTextField" else { return false }
    if subrole == "AXSearchField" { return true }
    let words = label.lowercased()
    return ["search", "find", "filter", "query", "ask a question", "jump to", "go to"].contains { words.contains($0) }
}
