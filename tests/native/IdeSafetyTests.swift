import Foundation

// Pure coding-editor rules in IdeSafety.swift, the palette title rule in
// NamedTargets.swift and the terminal floor in LaunchSafety.swift, checked
// against the fixture the TypeScript policy tests share.
func ideSafetyChecks(_ check: (Bool, String) -> Void) {
    // The search and palette context: what ENTER, TAB and other keys do to it.
    let palette = openedSearchContext(title: "Command Palette…", pid: 7, at: 100, appId: "com.sublimetext.4")
    check(palette?.title == "Command Palette" && palette?.recordsQuery == true && palette?.query == "",
          "a command palette in any application records what is typed, starting empty")
    let spotify = openedSearchContext(title: "Search", pid: 7, at: 100, appId: "com.spotify.client")
    check(spotify != nil && spotify?.recordsQuery == false && spotify?.query == nil, "an ordinary search box records nothing")
    let goToFile = openedSearchContext(title: "Go to File…", pid: 7, at: 100, appId: "com.microsoft.VSCode")
    check(goToFile?.recordsQuery == true, "every quick-open box in a VS Code-family editor records what is typed")
    check(openedSearchContext(title: "Save", pid: 7, at: 100, appId: "com.microsoft.VSCode") == nil, "a command that opens no search field opens no context")
    check(openedSearchContext(title: nil, pid: 7, at: 100, appId: "com.microsoft.VSCode") == nil, "a chord with no menu item opens no context")
    check(searchCommandTitle("Show All Commands"), "Help > Show All Commands opens the same palette as View > Command Palette")

    let typed = nextSearchContext(nextSearchContext(palette, .typed("Claude Code: ", replaced: false)), .typed("Focus input", replaced: false))
    check(typed?.query == "Claude Code: Focus input", "typing in steps appends to the recorded text")
    for key in ["ENTER", "TAB", "ESC"] {
        check(nextSearchContext(typed, .key(key)) == nil, "\(key) ends the search context")
        check(nextSearchContext(spotify, .key(key)) == nil, "\(key) ends an ordinary search context too")
    }
    check(typed?.state == nil, "typed text is exact")
    // Arrows move the selection, not the text: a file name stays a file name
    // and a refused command stays refused (policy judges the text last known).
    for key in ["DOWN", "UP", "PAGEDOWN", "PAGEUP"] {
        let after = nextSearchContext(typed, .key(key))
        check(after?.query == "Claude Code: Focus input" && after?.state == .moved && after?.title == "Command Palette",
              "\(key) keeps the text and marks the selection moved")
    }
    // Deletions and caret keys may change the text: it is kept, but inexact.
    let refused = nextSearchContext(palette, .typed("Terminal: Create New Terminal", replaced: false))
    for key in ["BACKSPACE", "DELETE", "LEFT", "RIGHT", "HOME", "END", "A"] {
        let after = nextSearchContext(refused, .key(key))
        check(after?.query == "Terminal: Create New Terminal" && after?.state == .edited,
              "\(key) keeps the refused text last known, marked edited")
    }
    let edited = nextSearchContext(refused, .key("BACKSPACE"))
    check(nextSearchContext(nextSearchContext(edited, .key("DOWN")), .key("UP"))?.state == .edited, "an arrow key never makes edited text exact")
    check(nextSearchContext(edited, .typed("x", replaced: false)) == SearchContext(pid: 7, at: 100, title: "Command Palette", recordsQuery: true,
                                                                               query: "Terminal: Create New Terminalx", state: .edited),
          "appending to edited text keeps it all and stays edited")
    check(nextSearchContext(edited, .typed("Git: Push", replaced: true)).map { ($0.query, $0.state) } ?? ("", .moved) == ("Git: Push", nil),
          "replacing the field's contents makes the text exact again")
    let moved = nextSearchContext(typed, .key("DOWN"))
    check(nextSearchContext(moved, .typed(" now", replaced: false)).map { ($0.query, $0.state) } ?? ("", .moved) == ("Claude Code: Focus input now", nil),
          "typing puts the top match back in front")
    check(nextSearchContext(typed, .key("SPACE")).map { ($0.query, $0.state) } ?? ("", .moved) == ("Claude Code: Focus input ", nil),
          "SPACE at the end of typed text is typed text")
    check(nextSearchContext(edited, .key("SPACE"))?.state == .edited, "SPACE after an edit stays edited")
    check(nextSearchContext(typed, .typed("Git: Push", replaced: true)).map { ($0.query, $0.state) } ?? ("", .moved) == ("Git: Push", nil),
          "a replaced field holds only the new text")
    // Typing that may stop part-way leaves a prefix; everything it would have
    // typed is recorded, so a refused command in it still counts.
    let cut = nextSearchContext(palette, .interrupted("Terminal: Create New Terminal", replaced: false))
    check(cut?.query == "Terminal: Create New Terminal" && cut?.state == .edited, "typing cut short records its text as edited")
    let cutReplace = nextSearchContext(refused, .interrupted("Git: Push", replaced: true))
    check(cutReplace?.query == "Terminal: Create New Terminal Git: Push" && cutReplace?.state == .edited,
          "a replacement cut short keeps the old text too: it may still be in the field")
    for key in ["DOWN", "BACKSPACE", "SPACE"] {
        check(nextSearchContext(spotify, .key(key)) == spotify, "\(key) in an ordinary search box keeps the context and records nothing")
    }
    check(nextSearchContext(spotify, .typed("after hours", replaced: false)) == spotify, "an ordinary search box never records text")
    check(nextSearchContext(spotify, .interrupted("after hours", replaced: false)) == spotify, "or text cut short")
    let long = nextSearchContext(palette, .typed(String(repeating: "a", count: 300), replaced: false))
    check(long?.query?.utf16.count == searchQueryLimit && long?.state == .edited, "recorded text is bounded, and text past the limit is not exact")
    let full = nextSearchContext(palette, .typed(String(repeating: "a", count: searchQueryLimit), replaced: false))
    check(full?.state == nil, "text exactly at the limit is still exact")
    check(nextSearchContext(nil, .typed("x", replaced: false)) == nil, "no context is ever created by typing")

    // Terminal focus.
    check(terminalFocusEvidence(roleDescription: "text entry area", label: "Terminal 1, zsh", domClasses: [], ide: true),
          "VS Code's terminal label marks a terminal")
    check(!terminalFocusEvidence(roleDescription: "text entry area", label: "Terminal 1, zsh", domClasses: [], ide: false),
          "the label rule is limited to the editors")

    // Shared fixture parity with src/core/ide.ts and the policy floor.
    let fixturePath = FileManager.default.currentDirectoryPath + "/tests/fixtures/ide-agents.json"
    guard let bytes = FileManager.default.contents(atPath: fixturePath),
          let fixture = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] else {
        check(false, "IDE fixture is readable from the repository root"); return
    }
    func strings(_ key: String) -> [String] { fixture[key] as? [String] ?? [] }
    let families = fixture["ideApps"] as? [String: String] ?? [:]
    check(!families.isEmpty, "fixture lists editor families")
    for (id, family) in families { check(ideFamily(id) == family, "fixture editor \(id) is \(family)") }
    for id in strings("notIdeApps") { check(ideFamily(id) == nil, "fixture non-editor \(id.isEmpty ? "(empty)" : id)") }
    for prefix in screenReaderDetectingAppPrefixes { check(ideFamily(prefix) != nil, "screen-reader-detecting editor \(prefix) has a family") }

    check(terminalAppIds == strings("terminalAppIds"), "native terminal ids equal the fixture and src/core/ide.ts")
    check(terminalAppPrefixes == strings("terminalAppPrefixes"), "native terminal prefixes equal the fixture")
    check(launchFloorDenied.isSuperset(of: terminalAppIds), "every terminal id is on the launch floor")
    check(credentialAppPrefixes == strings("credentialAppPrefixes"), "native password-manager prefixes equal the fixture")
    for prefix in strings("credentialAppPrefixes") {
        check(launchDenied(name: "Vault", displayName: "Vault", bundleId: prefix + "app"), "launching a password manager (\(prefix)) is refused")
    }
    for id in strings("terminalApps") {
        check(terminalApp(id), "fixture terminal \(id)")
        check(launchDenied(name: "Some App", displayName: "Some App", bundleId: id), "launching \(id) is refused")
    }
    for id in strings("notTerminalApps") { check(!terminalApp(id), "fixture non-terminal \(id)") }
    let ghostty = LaunchCandidate(path: "/Applications/Ghostty.app", bundleId: "com.mitchellh.ghostty", names: ["Ghostty"], displayName: "Ghostty", running: false, rootIndex: 2)
    let warp = LaunchCandidate(path: "/Applications/Warp.app", bundleId: "dev.warp.Warp-Stable", names: ["Warp"], displayName: "Warp", running: true, rootIndex: 2)
    check(resolveLaunch(query: "Ghostty", candidates: [ghostty, warp], protectedApps: []) == .refused, "open_app Ghostty is refused")
    check(resolveLaunch(query: "Warp", candidates: [ghostty, warp], protectedApps: []) == .refused, "open_app Warp is refused")

    for title in strings("paletteTitles") {
        check(paletteCommandTitle(title), "fixture palette title \(title)")
        check(searchCommandTitle(title), "fixture palette title \(title) opens a field")
    }
    for title in strings("notPaletteTitles") { check(!paletteCommandTitle(title), "fixture non-palette title \(title)") }

    let cases = fixture["terminalFocus"] as? [[String: Any]] ?? []
    check(cases.count >= 6, "fixture has terminal focus cases")
    for item in cases {
        let label = item["label"] as? String ?? ""
        let expected = item["terminal"] as? Bool ?? false
        check(terminalFocusEvidence(roleDescription: item["roleDescription"] as? String ?? "", label: label,
                                    domClasses: item["domClasses"] as? [String] ?? [], ide: item["ide"] as? Bool ?? false) == expected,
              "fixture terminal focus \(label.isEmpty ? (item["domClasses"] as? [String] ?? []).joined(separator: " ") : label): \(expected)")
    }
}
