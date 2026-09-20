import Foundation

// Pure naming, menu and control rules in NamedTargets.swift.
func namedTargetChecks(_ check: (Bool, String) -> Void) {
    // normalizeTargetTitle
    check(normalizeTargetTitle("  Settings…  ") == "Settings", "trailing ellipsis and padding are dropped")
    check(normalizeTargetTitle("Move\tto   Bin") == "Move to Bin", "runs of whitespace collapse")
    check(normalizeTargetTitle("Recent Items >") == "Recent Items", "submenu arrow is not part of the title")

    // targetTitleMatches
    check(targetTitleMatches(request: "play", title: "Play"), "case differences still match")
    check(targetTitleMatches(request: "Play", title: "Play/Pause"), "a prefix at a boundary matches")
    check(targetTitleMatches(request: "Log Out", title: "Log Out Nitish Kovuru…"), "menu items that append a name still match")
    check(!targetTitleMatches(request: "Play", title: "Playlists"), "a prefix inside a word never matches")
    check(!targetTitleMatches(request: "Out", title: "Log Out"), "a name is never matched mid-title")
    check(!targetTitleMatches(request: "", title: "Play"), "an empty request matches nothing")

    // matchNamedControl
    let controls = [
        NamedControl(label: "Home", role: "link", x: 0.1, y: 0.1, enabled: true),
        NamedControl(label: "Home improvement tips", role: "link", x: 0.5, y: 0.5, enabled: true),
        NamedControl(label: "Play", role: "button", x: 0.2, y: 0.8, enabled: true),
        NamedControl(label: "Play", role: "button", x: 0.8, y: 0.8, enabled: true),
    ]
    check(matchNamedControl(controls, label: "Home", role: nil, hintX: nil, hintY: nil) == .matched(0),
          "an exact name wins over a longer one it prefixes")
    check(matchNamedControl(controls, label: "Home improvement", role: nil, hintX: nil, hintY: nil) == .matched(1),
          "a prefix at a boundary resolves when nothing matches exactly")
    check(matchNamedControl(controls, label: "Play", role: nil, hintX: nil, hintY: nil) == .ambiguous(2),
          "two controls with one name and no position are ambiguous")
    check(matchNamedControl(controls, label: "Play", role: nil, hintX: 0.75, hintY: 0.79) == .matched(3),
          "the position the model read tells identical names apart")
    check(matchNamedControl(controls, label: "Home", role: "button", hintX: nil, hintY: nil) == .missing,
          "a role that does not match is not clicked instead")
    check(matchNamedControl(controls, label: "Shuffle", role: nil, hintX: 0.1, hintY: 0.1) == .missing,
          "a name that is not on screen is missing, never the nearest control")
    check(matchNamedControl([], label: "Play", role: nil, hintX: nil, hintY: nil) == .missing,
          "an empty screen matches nothing")
    // Live: label "link", role "link" and the exact position of the video link.
    let page = [
        NamedControl(label: "YouTube Home", role: "link", x: 0.082, y: 0.156, enabled: true),
        NamedControl(label: "Midwest Safety Verified @MidwestSafety", role: "link", x: 0.73, y: 0.324, enabled: true),
    ]
    check(matchNamedControl(page, label: "link", role: "link", hintX: 0.73, hintY: 0.324) == .matched(1),
          "a position copied from the list identifies the control when the name does not")
    check(matchNamedControl(page, label: "link", role: "link", hintX: 0.5, hintY: 0.5) == .missing,
          "a position between controls identifies nothing")
    check(matchNamedControl(page, label: "link", role: "button", hintX: 0.73, hintY: 0.324) == .missing,
          "the role still has to agree")
    check(matchNamedControl(page, label: "Blinding Lights", role: "link", hintX: 0.73, hintY: 0.324) == .missing,
          "a specific name that is gone never takes whatever sits at its old position")

    // menuPathRefused
    check(menuPathRefused(["Apple", "System Settings"]), "the system menu is never pressed")
    check(menuPathRefused(["Spotify", "Quit Spotify"]), "quitting an application is left to the user")
    check(menuPathRefused(["Apple", "Shut Down"]), "shutting down is refused")
    check(menuPathRefused(["Spotify", "Log Out"]), "logging out is refused")
    check(menuPathRefused(["File", "Force Quit Safari"]), "force quit is refused wherever it appears")
    check(menuPathRefused([]), "an empty path is refused")
    check(!menuPathRefused(["Playback", "Play"]), "an ordinary command is allowed through to policy")
    check(!menuPathRefused(["File", "New Playlist"]), "creating something is allowed through to policy")
    check(!menuPathRefused(["Window", "Spotify"]), "restoring a window is allowed through to policy")

    // menuShortcut
    check(menuShortcut(cmdChar: "l", virtualKey: nil, modifiers: 0) == "CMD+L", "a plain command shortcut")
    check(menuShortcut(cmdChar: "n", virtualKey: nil, modifiers: 1) == "CMD+SHIFT+N", "shift is added to command")
    check(menuShortcut(cmdChar: "", virtualKey: 124, modifiers: 0) == "CMD+RIGHT", "arrow shortcuts use the agent's key names")
    check(menuShortcut(cmdChar: "", virtualKey: 999, modifiers: 0) == nil, "a key the agent cannot press is not shown")
    check(menuShortcut(cmdChar: "?", virtualKey: nil, modifiers: 0) == nil, "punctuation the schema has no key for is dropped")
    check(menuShortcut(cmdChar: "z", virtualKey: nil, modifiers: 8) == nil, "a shortcut without Command is not offered")

    // normalizeChord
    check(normalizeChord(["N", "CMD"]) == "CMD+N", "keys in any order normalize to one spelling")
    check(normalizeChord(["shift", "cmd", "n"]) == "CMD+SHIFT+N", "modifiers keep their fixed order")

    // hotkeyRoute: the live Calendar map after launch.
    let calendar: [String: [String]] = [
        "CMD+N": ["File", "New Event"], "CMD+Q": ["Calendar", "Quit Calendar"], "CMD+RIGHT": ["View", "Next"],
        "CMD+A": ["Edit", "Select All"], "CMD+C": ["Edit", "Copy"], "CMD+V": ["Edit", "Paste"], "CMD+X": ["Edit", "Cut"],
        "CMD+Z": ["Edit", "Undo"], "CMD+SHIFT+Z": ["Edit", "Redo"], "CMD+ALT+SHIFT+V": ["Edit", "Paste and Match Style"],
        "CMD+W": ["File"], "CTRL+TAB": ["Window", "Show Next Tab"], "CMD+BACKSPACE": ["Edit", "Delete"],
        "CMD+SHIFT+UP": ["View", "Scroll Up"], "ALT+LEFT": ["View", "Back"], "CMD+END": ["View", "Go to End"],
        "CMD+I": ["File", "Get Info"], "CMD+SHIFT+BACKSPACE": ["Finder", "Empty Trash"],
    ]
    let route = { (keys: [String]) in hotkeyRoute(keys: keys, shortcuts: calendar, approved: false, label: nil) }
    check(route(["CMD", "N"]) == .menu(["File", "New Event"]), "a chord the application publishes is pressed through its menu item")
    check(route(["N", "CMD"]) == .menu(["File", "New Event"]), "the chord is found whatever order its keys come in")
    check(route(["CTRL", "TAB"]) == .menu(["Window", "Show Next Tab"]), "a named-key chord is routed like a letter")
    check(route(["CMD", "T"]) == .keys, "a chord no menu publishes stays keys")
    check(hotkeyRoute(keys: ["CMD", "N"], shortcuts: [:], approved: false, label: nil) == .keys, "an application with no readable menus keeps keys")
    check(route(["CMD", "W"]) == .keys, "an entry without an item is never pressed")
    for keys in [["CMD", "A"], ["CMD", "C"], ["CMD", "V"], ["CMD", "X"], ["CMD", "Z"], ["CMD", "SHIFT", "Z"], ["CMD", "ALT", "SHIFT", "V"], ["CMD", "I"]] {
        check(route(keys) == .keys, "\(keys.joined(separator: "+")) edits the focused text and stays keys")
    }
    // Caret and selection moves and word or line deletes act on the focused field;
    // Calendar's CMD+RIGHT pages the calendar forward instead of ending the line.
    for keys in [["CMD", "RIGHT"], ["CMD", "BACKSPACE"], ["CMD", "SHIFT", "UP"], ["ALT", "LEFT"], ["CMD", "END"]] {
        check(route(keys) == .keys, "\(keys.joined(separator: "+")) moves or deletes in the focused text and stays keys")
    }
    // A refused item is refused, never typed: a text chord (Finder's Empty Trash) included.
    check(route(["CMD", "Q"]) == .refused && route(["CMD", "SHIFT", "BACKSPACE"]) == .refused, "a chord for a refused item is refused, never posted as keys")
    check(hotkeyRoute(keys: ["CMD", "Q"], shortcuts: calendar, approved: true, label: "Quit Calendar") == .refused, "an approval never presses a refused item")
    check(focusedTextChord(["ctrl", "c"]) && focusedTextChord(["cmd", "a"]) && focusedTextChord(["SHIFT", "ALT", "RIGHT"]) && focusedTextChord(["U", "CMD"])
          && !focusedTextChord(["CMD", "N"]) && !focusedTextChord(["CMD", "SHIFT", "A"]) && !focusedTextChord(["CTRL", "TAB"]) && !focusedTextChord(["CMD", "SHIFT", "I"]),
          "text chords are the clipboard, select all, formatting, undo, redo and caret moves only")

    // After an approval the chord must still name the item the user approved.
    let approved = { (keys: [String], label: String?) in hotkeyRoute(keys: keys, shortcuts: calendar, approved: true, label: label) }
    check(approved(["CMD", "N"], "New Event") == .menu(["File", "New Event"]), "the approved item is the item pressed")
    check(approved(["CMD", "N"], "New Calendar") == .changed, "a chord that now names another item spends the approval")
    check(approved(["CMD", "N"], nil) == .changed, "a chord that named nothing when approved is not pressed as a menu item now")
    check(approved(["CMD", "T"], "New Tab") == .changed, "a chord whose approved item is gone is not posted as keys instead")
    check(approved(["CMD", "T"], nil) == .keys && approved(["CMD", "BACKSPACE"], "Delete") == .keys, "an unchanged unpublished or text chord keeps keys")
    check(approved(["CMD", "BACKSPACE"], "Move to Trash") == .changed, "a text chord bound to another item since the approval is not sent either")
    // Allowed without asking, the chord is still bound to the item policy judged:
    // a menu that changed since surface cannot make it press an item policy never saw.
    let judged = { (keys: [String], label: String?) in hotkeyRoute(keys: keys, shortcuts: calendar, approved: false, label: label) }
    check(judged(["CMD", "N"], "New Event") == .menu(["File", "New Event"]), "the judged item is the item pressed")
    check(judged(["CMD", "N"], "New Calendar") == .changed && judged(["CMD", "N"], "Send") == .changed, "an allowed chord that now names another item is not pressed")
    check(judged(["CMD", "T"], "New Tab") == .changed && judged(["CMD", "BACKSPACE"], "Move to Trash") == .changed,
          "an allowed chord whose judged item is gone or rebound is not posted as keys instead")
    check(judged(["CMD", "N"], nil) == .menu(["File", "New Event"]) && judged(["CMD", "T"], nil) == .keys,
          "with no label judged, an unapproved chord goes the way its menus say now")
    let long = "Export “Quarterly planning notes for the whole team.pdf” as PDF"
    check(shortcutMenuLabel(["File", long]).utf16.count <= menuTitleLimit && long.hasPrefix(shortcutMenuLabel(["File", long])), "the label is the bounded title")
    check(hotkeyRoute(keys: ["CMD", "E"], shortcuts: ["CMD+E": ["File", long]], approved: true, label: shortcutMenuLabel(["File", long])) == .menu(["File", long]),
          "a long title is compared as surface reported it")
    check(publishedShortcutItem(keys: ["N", "CMD"], shortcuts: calendar) == ["File", "New Event"] && publishedShortcutItem(keys: ["CMD", "W"], shortcuts: calendar) == nil,
          "the published item is found by chord and needs a title")

    // shortcutStatus: policy refuses before asking what native would refuse.
    check(shortcutStatus(keys: ["CMD", "Q"], shortcuts: calendar) == "refused", "a chord for Quit is refused before any approval")
    check(shortcutStatus(keys: ["CMD", "SHIFT", "BACKSPACE"], shortcuts: calendar) == "refused", "a text chord for a refused item is refused before any approval")
    check(shortcutStatus(keys: ["CMD", "SHIFT", "Q"], shortcuts: ["CMD+SHIFT+Q": ["Apple", "Log Out Nitish"]]) == "refused", "the system menu's chords are refused")
    check(shortcutStatus(keys: ["CMD", "N"], shortcuts: calendar) == nil && shortcutStatus(keys: ["CMD", "T"], shortcuts: calendar) == nil,
          "an ordinary or unpublished chord has no status")

    // revalidatesByName: the live CMD+N goes by name while focus settles; once the
    // user approved a step, it is checked like keys whichever way it is pressed.
    check(revalidatesByName(type: "hotkey", menuRoute: ["File", "New Event"], approved: false), "an allowed menu-routed hotkey is checked by its item")
    check(!revalidatesByName(type: "hotkey", menuRoute: ["Edit", "Delete"], approved: true), "an approved menu-routed hotkey gets the full keyboard check")
    check(!revalidatesByName(type: "hotkey", menuRoute: nil, approved: false), "a hotkey sent as keys gets the focused-field check")
    check(!revalidatesByName(type: "key", menuRoute: ["File", "New Event"], approved: false), "only a hotkey is pressed through a menu route")
    check(revalidatesByName(type: "menu_item", menuRoute: nil, approved: true) && revalidatesByName(type: "click_control", menuRoute: nil, approved: false),
          "named menu items and controls keep their by-name check")

    // menuPressRefusal: nothing refused, missing or greyed out is pressed, and a
    // hotkey's error names only its chord (menu titles can carry file names).
    let quick = ["File", "Quick Look “Q3 salary review.xlsx”"]
    check(menuPressRefusal(path: quick, chord: "CMD+Y", item: .missing)! == ("The menu item for CMD+Y is not in this application's menus.", "TARGET_MISSING"),
          "a hotkey's missing item is named by its chord")
    check(menuPressRefusal(path: quick, chord: "CMD+Y", item: .disabled)! == ("The menu item for CMD+Y is greyed out right now.", "TARGET_DISABLED"),
          "a hotkey's greyed-out item is named by its chord")
    check(!menuCommandName(path: quick, chord: "CMD+Y").contains("salary"), "no title reaches a hotkey's error")
    check(menuPressRefusal(path: ["Edit", "Find"], chord: nil, item: .missing)?.message == "Edit > Find is not in this application's menus.",
          "a menu_item names the path the model sent")
    check(menuPressRefusal(path: quick, chord: "CMD+Y", item: .enabled) == nil && menuPressRefusal(path: quick, chord: "CMD+Y", item: nil) == nil,
          "an enabled item is pressed")
    for item: MenuItemState? in [nil, .enabled, .disabled, .missing] {
        check(menuPressRefusal(path: ["Calendar", "Quit Calendar"], chord: "CMD+Q", item: item)?.code == "TARGET_REFUSED", "a refused item is refused in any state")
    }

    // menuDigestLine
    let line = menuDigestLine(menu: "Edit", items: [
        MenuItemDigest(title: "Undo", shortcut: "CMD+Z", enabled: true, submenu: false),
        MenuItemDigest(title: "Search", shortcut: "CMD+L", enabled: false, submenu: false),
        MenuItemDigest(title: "AutoFill", shortcut: nil, enabled: true, submenu: true),
    ])
    check(line == "Edit: Undo [CMD+Z], Search [CMD+L] (disabled), AutoFill >", "a menu reads as one line with shortcuts and state")
    check(menuDigestLine(menu: "Help", items: []) == "Help", "a menu with no readable items is still named")
    let many = (0..<30).map { MenuItemDigest(title: "Item \($0)", shortcut: nil, enabled: true, submenu: false) }
    check(menuDigestLine(menu: "Long", items: many, itemLimit: 3) == "Long: Item 0, Item 1, Item 2", "items are bounded")
}

// mainWindowMenuEntry: the Window menu entry that shows a windowless app's main window.
func mainWindowMenuChecks(_ check: (Bool, String) -> Void) {
    func item(_ title: String, enabled: Bool = true, submenu: Bool = false, shortcut: String? = nil) -> MenuItemDigest? {
        title.isEmpty ? nil : MenuItemDigest(title: title, shortcut: shortcut, enabled: enabled, submenu: submenu)
    }
    // Entries as the helper reads them (a separator digests to nil); the
    // answer is the entry's position, standing in for the element pressed.
    func pick(_ names: [String], _ menu: [MenuItemDigest?], bundleId: String = "com.example.app") -> Int? {
        mainWindowMenuEntry(appNames: names, bundleId: bundleId, entries: Array(menu.enumerated()), digest: { $0.element })?.offset
    }
    let front = item("Bring All to Front")
    // Calendar's Window menu with its window closed (item order from its MainMenu nib).
    let calendar = [item("Minimize", enabled: false, shortcut: "CMD+M"), item("Zoom", enabled: false), item("Move Window to Left Side of Screen", enabled: false),
                    item(""), item("Calendar", shortcut: "CMD+0"), item(""), front]
    check(pick(["Calendar"], calendar, bundleId: "com.apple.iCal") == 4, "Calendar's Window menu item shows its main window")
    check(pick(["calendar "], calendar) == 4, "the application name matches case- and space-insensitively")
    check(pick(["Notes"], calendar) == nil, "another application's name is not this application's window")
    check(pick(["Calendar"], [item("Calendar", submenu: true), front]) == nil, "a submenu is not a window")
    // AppKit validates a closed menu lazily: the helper re-checks with it open.
    check(pick(["Calendar"], [item("Calendar", enabled: false), front]) == 0, "a greyed-out read is still the candidate")
    check(pick(["Mail"], [item("Minimize"), item("Message Viewer", shortcut: "CMD+0"), front], bundleId: "com.apple.mail") == 1,
          "Mail's main window is its Message Viewer")
    check(pick(["Mail"], [item("Minimize"), item("Message Viewer"), front], bundleId: "COM.APPLE.MAIL") == 1, "the bundle identifier matches case-insensitively")
    for title in ["Message Viewer", "Main Window", "Main Window…"] {
        check(pick(["Widget"], [item(title), front], bundleId: "com.example.widget") == nil, "\(title) is only another application's main window")
    }
    check(pick(["Code", "Visual Studio Code"], [item("Visual Studio Code"), front]) == 0, "any of the application's names identifies it")
    // The window list after Bring All to Front is titled by the windows
    // themselves (a web page's <title>, a folder), minimized ones included.
    for title in ["Safari", "Main Window", "Message Viewer"] {
        let menu = [item("Minimize"), item("Zoom"), item(""), front, item(""), item(title)]
        check(pick(["Safari"], menu, bundleId: "com.apple.mail") == nil, "a window-list entry titled \(title) is never pressed")
    }
    check(pick(["Calendar"], [item("Minimize"), item("Arrange in Front"), item("Calendar")]) == nil, "Arrange in Front also starts the window list")
    check(pick(["Calendar"], [item("Minimize"), item("Calendar")]) == nil, "without Bring All to Front the window list cannot be told apart")
    check(pick(["Calendar"], [item("Calendar"), front, item("Calendar")]) == 0, "the command before the list is the one taken")
    // The entry checked is the entry pressed, never a longer title before it.
    check(pick(["Calendar"], [item("Calendar Settings"), item("Calendar"), front]) == 1, "a prefix-sharing entry before the exact one is not pressed")
    check(pick(["Calendar"], [item("Calendar Settings"), item("Calendar Settings", enabled: false), item("Calendar"), front]) == 2,
          "the exact entry is found past every near miss")
    // An application named like a window command never gets that command.
    for name in ["Zoom", "Minimize", "Move", "Close Window", "Merge All Windows", "Tile Window to Left of Screen"] {
        check(pick([name], [item(name), front]) == nil, "\(name) acts on windows and is never pressed")
    }
    check(pick(["Bring All to Front"], [front, item("")]) == nil, "Bring All to Front is never pressed")
    check(pick(["Quit Calendar"], [item("Quit Calendar"), front]) == nil, "a refused menu path stays refused")
    check(pick(["Calendar"], [item("Calendar Settings"), item("Calendars"), item("Show Calendar List"), front]) == nil,
          "only the exact name, never a longer or shorter title")
    check(pick([""], [item("x"), front]) == nil, "an empty name matches nothing")
    check(pick(["Calendar"], []) == nil, "no Window menu, no restore")
}

func searchCommandChecks(_ check: (Bool, String) -> Void) {
    for title in ["Search", "Find…", "Find in Files", "Quick Open", "Jump to…", "Command Palette…", "Filter", "Go to File…", "Quick Search"] {
        check(searchCommandTitle(title), "\(title) opens a search field")
    }
    for title in ["Replace", "Find and Replace…", "Play", "New Playlist", "Save", "Searchlight Settings", ""] {
        check(!searchCommandTitle(title), "\(title) does not open a search field")
    }
    check(searchCommandCurrent(commandPid: 7, commandAt: 100, pid: 7, now: 130), "a search opened moments ago in this app is current")
    check(!searchCommandCurrent(commandPid: 7, commandAt: 100, pid: 8, now: 101), "another application never inherits it")
    check(!searchCommandCurrent(commandPid: 7, commandAt: 100, pid: 7, now: 100 + searchCommandSeconds + 1), "it expires")
}

func queryFieldChecks(_ check: (Bool, String) -> Void) {
    check(replacesOnType(role: "AXTextArea", subrole: "", label: "Search or ask a question"), "YouTube's search box holds a query")
    check(replacesOnType(role: "AXTextField", subrole: "AXSearchField", label: ""), "a search field holds a query")
    check(replacesOnType(role: "AXTextField", subrole: "", label: "Find in page"), "a find field holds a query")
    check(!replacesOnType(role: "AXTextArea", subrole: "", label: "Message #general"), "a message box keeps its text")
    check(!replacesOnType(role: "AXTextArea", subrole: "", label: ""), "an unnamed editor keeps its text")
    check(!replacesOnType(role: "AXTextField", subrole: "AXSecureTextField", label: "Search"), "a secure field is never touched")
    check(!replacesOnType(role: "AXButton", subrole: "", label: "Search"), "a search button is not a field")
}

// Controller.swift is not compiled into these tests (it is the helper itself), so
// the few lines that connect the pure rules above to input are pinned by reading
// its source: a hotkey's route, the approval binding and the checks each route gets.
func hotkeyWiringChecks(_ check: (Bool, String) -> Void) {
    guard let source = try? String(contentsOfFile: FileManager.default.currentDirectoryPath + "/native/macos/Controller.swift", encoding: .utf8) else {
        check(false, "the helper source is readable from the repository root"); return
    }
    let squeezed = { (text: Substring) in text.filter { !$0.isWhitespace } }
    func section(_ from: String, _ to: String) -> Substring {
        guard let start = source.range(of: from), let end = source.range(of: to, range: start.upperBound..<source.endIndex) else { return "" }
        return source[start.lowerBound..<end.lowerBound]
    }
    func has(_ part: Substring, _ lines: [String]) -> Bool {
        let body = squeezed(part)
        var at = body.startIndex
        for line in lines { // in this order
            guard let found = body.range(of: squeezed(Substring(line)), range: at..<body.endIndex) else { return false }
            at = found.upperBound
        }
        return true
    }
    check(has(section("case \"execute\":", "case \"revalidate\":"), [
        "let route = currentHotkeyRoute(action), approved = action[\"approved\"] as? Bool == true",
        "if route == .refused { throw ControlError(menuRefusal, code: \"TARGET_REFUSED\") }",
        "menuRoute = route.menuPath",
        "try await revalidate(action, menuRoute: menuRoute, approved: approved)",
        "if route == .changed { throw changedScreen(",
        "try execute(action, menuRoute: menuRoute)",
    ]), "execute routes a hotkey once, refuses before input and checks an approved step in full")
    check(has(section("case \"revalidate\":", "macOS 14 required."), ["revalidate(action, menuRoute: nil, approved: true)"]),
          "the check after an approval never takes the by-name shortcut")
    check(has(section("func currentHotkeyRoute(", "\n}"), [
        "hotkeyRoute(keys: names, shortcuts: shortcuts, approved: action[\"approved\"] as? Bool == true, label: action[\"shortcutLabel\"] as? String)",
    ]), "the live route is bound to the item policy judged and to the approval")
    check(has(section("func revalidate(", "let keys: [String:CGKeyCode]"), [
        "let named = revalidatesByName(type: action[\"type\"] as? String ?? \"\", menuRoute: menuRoute, approved: approved)",
        "if named { try ensureRunning(); return fresh }",
        "sameElement(",
    ]), "only a by-name step skips the focused-field check")
    check(has(section("func execute(", "final class LaunchOutcome"), [
        "if action[\"type\"] as? String == \"hotkey\", let path = menuRoute { try pressMenuPath(path, chord: normalizeChord(names)); return [\"via\": \"menu\"] }",
        "CGEvent(keyboardEventSource:nil,virtualKey:code,keyDown:true)",
    ]), "a menu-routed hotkey is pressed as its item and returns before any key is posted")
    check(has(section("func pressMenuPath(", "\n}"), [
        "menuPressRefusal(path: path, chord: chord, item: nil)",
        "resolveMenuPath(element, path, chord: chord)",
        "menuPressRefusal(path: path, chord: chord, item:",
        "AXUIElementPerformAction(item.item, kAXPressAction as CFString)",
    ]), "a menu press is refused before anything opens, must still carry its chord, and is refused unless enabled")
    check(has(section("func surface(", "\n}"), ["commandFacts(element, pid: app.processIdentifier, action: action)"])
          && has(section("func surfaceTarget(", "\n}"), ["commandFacts(element, pid: bound.pid, action: action)"])
          && has(section("func commandFacts(", "\n}"), [
        "publishedShortcutItem(keys: names, shortcuts: shortcuts)", "shortcutMenuLabel(item)", "shortcutStatus(keys: names, shortcuts: shortcuts)",
    ]), "surface and surfaceTarget report the label and the refusal from the same rules execute uses")
    check(has(section("func changedScreen(", "\n"), ["change: screenChangeCode(reason)"]) && source.contains("if let change = (error as? ControlError)?.change {result[\"change\"] = change}"),
          "a refusal's kind of change reaches the app as its code")
}
