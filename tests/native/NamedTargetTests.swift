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
