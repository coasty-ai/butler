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

    // Watching a coding agent's panel: OCR normalization and the anchor tables
    // read the fixture's panels the same way src/core/monitor.ts does.
    let normalization = fixture["ocrNormalization"] as? [[String: String]] ?? []
    check(normalization.count >= 6, "fixture has OCR normalization cases")
    for item in normalization {
        check(normalizeOcrText(item["in"] ?? "") == item["out"], "normalizes \(item["in"] ?? "") to \(item["out"] ?? "")")
    }
    let panels = fixture["agentStates"] as? [[String: Any]] ?? []
    check(panels.count >= 12, "fixture has panel state cases")
    for item in panels {
        let agent = item["agent"] as? String ?? ""
        let expected = item["state"] as? String ?? ""
        let lines = (item["lines"] as? [[String: Any]] ?? []).map { (text: normalizeOcrText($0["t"] as? String ?? ""), y: $0["y"] as? Double ?? 0, h: $0["h"] as? Double ?? 0) }
        check(agentPanelState(agent: agent, lines: lines) == expected, "\(agent) panel reads \(expected): \(lines.map { $0.text }.joined(separator: " | "))")
    }
    check(agentPanelState(agent: "nobody", lines: [(text: "do you want to proceed", y: 0.9, h: 0.02)]) == "unknown", "an unknown agent has no anchors")
    check(agentAnchor(agent: "claude-code", line: "esc to interrupt") && !agentAnchor(agent: "claude-code", line: "export function foo() {}"), "anchors are matched per agent")
    // The bottom of the panel decides before the transcript above it.
    check(agentPanelState(agent: "claude-code", lines: [(text: "interrupted", y: 0.1, h: 0.02), (text: "queue another message...", y: 0.95, h: 0.02)]) == "working",
          "an old interrupted line in the transcript does not outrank the spinner")
    check(agentPanelState(agent: "claude-code", lines: [(text: "interrupted", y: 0.9, h: 0.02), (text: "queue another message...", y: 0.95, h: 0.02)]) == "error",
          "interrupted at the bottom is a failure even beside the spinner")
    for label in strings("forbiddenAllowLabels") { check(forbiddenAllowLabel(label), "\(label) never allows once") }
    for label in strings("allowedAllowLabels") { check(!forbiddenAllowLabel(label), "\(label) allows once") }
    for (agent, kinds) in agentAllowLabels { for (kind, label) in kinds { check(!forbiddenAllowLabel(label), "\(agent) \(kind) allow label \(label) grants one use") } }

    // Double Escape while watching; single Escape otherwise.
    check(emergencyEscape(now: 10, lastEscapeAt: nil, watching: false), "without a watch one Escape stops")
    check(emergencyEscape(now: 10, lastEscapeAt: 5, watching: false), "without a watch the previous Escape does not matter")
    check(!emergencyEscape(now: 10, lastEscapeAt: nil, watching: true), "while watching a first Escape is the user's own key")
    check(!emergencyEscape(now: 10, lastEscapeAt: 9.1, watching: true), "while watching an Escape 0.9 s after another is still one key")
    check(emergencyEscape(now: 10, lastEscapeAt: 9.3, watching: true), "while watching two Escapes within 0.8 s stop")
    check(emergencyEscape(now: 1.8, lastEscapeAt: 1.0, watching: true), "exactly 0.8 s apart still counts")
    check(!emergencyEscape(now: 10, lastEscapeAt: 11, watching: true), "a clock that went backwards is not a double press")
    // Probes accept the bound token and nothing else.
    check(watchProbeAllowed(token: "abc", bound: "abc"), "the bound token probes")
    check(!watchProbeAllowed(token: "abd", bound: "abc"), "another token does not")
    check(!watchProbeAllowed(token: "abc", bound: nil), "nothing probes with no binding")
    check(!watchProbeAllowed(token: "", bound: ""), "an empty token never matches an empty binding")
    check(watchBindingsMax >= 2 && watchBindingsMax <= 8, "a few windows may be bound at once, not many")
    // A browser window is refused by the page it shows, as a capture is.
    let banks = ["chase.com", "Login.gov"]
    check(watchDomainRefused(domain: "chase.com", browser: true, protectedDomains: banks), "a protected domain is refused")
    check(watchDomainRefused(domain: "secure.CHASE.com", browser: true, protectedDomains: banks), "so is a subdomain, whatever the case")
    check(watchDomainRefused(domain: "login.gov", browser: true, protectedDomains: banks), "the list's case does not matter either")
    check(!watchDomainRefused(domain: "notchase.com", browser: true, protectedDomains: banks), "a domain that merely ends the same way is not")
    check(!watchDomainRefused(domain: "github.com", browser: true, protectedDomains: banks), "an ordinary page is watched")
    check(!watchDomainRefused(domain: "chase.com", browser: false, protectedDomains: []), "nothing is protected when nothing is listed")
    check(watchDomainRefused(domain: nil, browser: true, protectedDomains: banks), "a browser page that cannot be told is refused while any domain is protected")
    check(watchDomainRefused(domain: "", browser: true, protectedDomains: banks), "an empty host is no better")
    check(!watchDomainRefused(domain: nil, browser: true, protectedDomains: []), "unless nothing is protected")
    check(!watchDomainRefused(domain: nil, browser: false, protectedDomains: banks), "a window that is not a browser's has no page to tell")
    // The page a browser window shows (InputSafety.swift): its host alone, a
    // page known local, or one whose address cannot be read.
    check(pageURL(URL(string: "https://Secure.Chase.com/login?next=/accounts")!) == .host("secure.chase.com"), "a URL names its host, lowercased, never the path or query")
    check(pageURL("https://www.example.com:8443/a/b#c") == .host("www.example.com"), "a string URL the same, without the port")
    check(pageHost("http://127.0.0.1:47831/checkin") == "127.0.0.1", "the fixture server's loopback address is a host")
    check(pageURL("about:blank") == .local && pageURL(URL(string: "file:///Users/me/page.html")!) == .local, "a blank page or a file names no host and is known local")
    check(pageURL(nil) == .unreadable, "no URL attribute at all cannot be read")
    check(pageURL("not a url at all") == .unreadable && pageURL(42) == .unreadable, "nor can a value that is not a URL")
    check(pageHost(nil) == nil && pageHost("about:blank") == nil && pageHost("not a url at all") == nil, "none of those names a host")
    check(pageHostUnknown(browser: true, host: nil, unreadableWebArea: true), "a browser page with a web area that publishes no URL is unknown")
    check(!pageHostUnknown(browser: true, host: "example.com", unreadableWebArea: true), "not when a host was read from the window or another area")
    check(!pageHostUnknown(browser: true, host: nil, unreadableWebArea: false), "not when every web area named a local page, or none was found")
    check(!pageHostUnknown(browser: false, host: nil, unreadableWebArea: true), "never outside a browser: Mail's message view is WebKit and publishes no URL")
    check(watchDomainRefused(domain: nil, browser: true, protectedDomains: banks) == pageHostUnknown(browser: true, host: nil, unreadableWebArea: true), "an unknown page is refused by the rule a watch already applies while any domain is protected")

    // A folder in a named application: an editor may take it (the policy asks
    // first), a terminal, a system tool or a protected app never.
    let app = { (id: String, name: String) in LaunchCandidate(path: "/Applications/\(name).app", bundleId: id, names: [name], displayName: name, running: false, rootIndex: 0) }
    let code = app("com.microsoft.VSCode", "Visual Studio Code"), cursor = app("com.todesktop.230313mzl4w4u92", "Cursor")
    check(!namedFileHandlerRefused(code, protectedApps: []) && !namedFileHandlerRefused(cursor, protectedApps: []), "an editor named for a folder passes the native floor")
    check(fileHandlerRefused(kind: .folder, handler: code, protectedApps: []), "the default route still opens folders in Finder alone")
    check(!namedFileHandlerRefused(app("com.apple.finder", "Finder"), protectedApps: []), "Finder may be named")
    for (id, name) in [("com.apple.Terminal", "Terminal"), ("com.googlecode.iterm2", "iTerm"), ("dev.warp.Warp-Stable", "Warp"), ("com.mitchellh.ghostty", "Ghostty"),
                       ("com.apple.systempreferences", "System Settings"), ("com.apple.shortcuts", "Shortcuts"), ("com.apple.ScriptEditor2", "Script Editor")] {
        check(namedFileHandlerRefused(app(id, name), protectedApps: []), "\(name) never opens a named folder or file")
    }
    check(namedFileHandlerRefused(app("com.1password.1password", "1Password"), protectedApps: ["com.1password"]), "a protected app never opens one")
    check(!namedFileHandlerRefused(code, protectedApps: ["com.1password"]), "an unrelated protected entry leaves the editor alone")
}
