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

func searchCommandChecks(_ check: (Bool, String) -> Void) {
    for title in ["Search", "Find…", "Find in Files", "Jump to…", "Filter", "Quick Search"] {
        check(searchCommandTitle(title), "\(title) opens a search field")
    }
    for title in ["Replace", "Find and Replace…", "Play", "New Playlist", "Save", "Searchlight Settings", "", "Command Palette…", "Quick Open", "Go to File…"] {
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
