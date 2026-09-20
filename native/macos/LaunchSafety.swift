import Foundation

// Pure, testable application-name resolution and launch denial rules for the
// open_app action. Controller.swift enumerates candidates; this file decides.

struct LaunchCandidate {
    let path: String          // realpath of the bundle; never written to output
    let bundleId: String
    let names: [String]       // file stem, CFBundleName, CFBundleDisplayName, FileManager display name
    let displayName: String
    let running: Bool
    let rootIndex: Int        // lower is preferred when one bundle id exists at several paths
}

enum LaunchResolution: Equatable {
    case resolved(appId: String, name: String, path: String)
    case ambiguous([String])
    case unresolved([String])
    case refused
}

// Terminal applications, lowercased: every character and ENTER sent to one runs
// as a shell command. Identical to terminalAppIds and terminalAppPrefixes in
// src/core/ide.ts (the policy floor); tests/fixtures/ide-agents.json holds both.
let terminalAppIds: [String] = ["com.apple.terminal", "com.googlecode.iterm2", "dev.warp.warp", "dev.warp.warp-stable", "dev.warp.warp-preview", "com.mitchellh.ghostty", "net.kovidgoyal.kitty", "org.alacritty", "io.alacritty", "co.zeit.hyper", "com.github.wez.wezterm"]
// Warp ships each channel under its own id (Warp-Stable, Warp-Preview, …).
let terminalAppPrefixes = ["dev.warp.warp-"]
func terminalApp(_ bundleId: String?) -> Bool {
    let id = (bundleId ?? "").lowercased()
    return !id.isEmpty && (terminalAppIds.contains(id) || terminalAppPrefixes.contains { id.hasPrefix($0) })
}
// Shell-equivalent, scripting, disk, credential and system-flow applications
// stay manual even when a user removes them from the protected list.
let launchFloorDenied: Set<String> = Set(terminalAppIds).union(["com.apple.scripteditor2", "com.apple.automator", "com.apple.diskutility", "com.apple.keychainaccess", "com.apple.migrateassistant", "com.apple.bootcampassistant", "com.apple.installer", "com.apple.spotlight", "com.apple.siri", "ai.coarena.openassist", "com.github.electron"])
// Automator/AppleScript applets and web-app wrappers are scripts, not products;
// every Warp channel is a terminal.
// Password managers: never launched, whatever the settings say. Identical to
// credentialAppPrefixes in src/core/policy.ts and the shared fixture.
let credentialAppPrefixes = ["com.1password.", "com.agilebits.onepassword", "com.apple.passwords", "com.bitwarden.", "com.lastpass.", "com.dashlane.", "org.keepassxc.", "com.nordpass.", "in.sinew.enpass", "me.proton.pass", "com.keepersecurity."]
let launchRefusedPrefixes = ["com.apple.automator.", "com.apple.scripteditor.id.", "com.apple.safari.webapp.", "com.google.chrome.app."] + terminalAppPrefixes + credentialAppPrefixes
// Identical to INSTALLER_PATTERN in src/core/policy.ts; keep the two in step.
let launchNamePattern = try! NSRegularExpression(pattern: "\\b(?:install\\w*|uninstall\\w*|setup\\w*|updater?|migrat\\w*|boot ?camp\\w*|recovery)\\b", options: [.caseInsensitive])
let launchBundlePattern = try! NSRegularExpression(pattern: "(installer|uninstall|setup|updater)", options: [.caseInsensitive])

func normalizeAppName(_ value: String) -> String {
    var name = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if name.hasSuffix(".app") { name = String(name.dropLast(4)).trimmingCharacters(in: .whitespacesAndNewlines) }
    return name.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

func appNameTokens(_ value: String) -> [String] {
    normalizeAppName(value).split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init)
}

private func matches(_ pattern: NSRegularExpression, _ value: String) -> Bool {
    pattern.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) != nil
}

// Like isInstallerName in policy.ts: bundle ids and file names join words with
// dots, underscores or hyphens, so the value is also tested with those as spaces.
func launchNameDenied(_ name: String) -> Bool {
    matches(launchNamePattern, name) ||
        matches(launchNamePattern, name.replacingOccurrences(of: "[._-]+", with: " ", options: .regularExpression))
}

// AppleScript applets, droplets, Automator applications and script wrappers run
// code as soon as they open, whatever bundle identifier they were given, so
// they are refused by structure rather than by identifier.
let scriptBundleExecutables: Set<String> = ["applet", "droplet", "application stub"]
func scriptBundle(executableName: String, hasMainScript: Bool, hasWorkflow: Bool, hasOSAKeys: Bool) -> Bool {
    scriptBundleExecutables.contains(executableName.lowercased()) || hasMainScript || hasWorkflow || hasOSAKeys
}
// Bundle-relative paths whose presence marks a script bundle.
let scriptBundleMainScripts = ["Contents/Resources/Scripts/main.scpt", "Contents/Resources/Scripts/main.scptd", "Contents/Resources/Scripts/main.applescript", "Contents/Resources/script"]
let scriptBundleWorkflow = "Contents/document.wflow"
let scriptBundleOSAKeys = ["OSAAppletShowStartupScreen", "OSAAppletStayOpen"]

// Reopening an already running app through LaunchServices makes a windowless
// app show an Open panel, template chooser or new document. Only an app that
// already shows a window is reopened, and only once after activation stalls.
func launchReopenAllowed(wasRunning: Bool, alreadyReopened: Bool, elapsed: TimeInterval, onScreenWindows: Int) -> Bool {
    wasRunning && !alreadyReopened && elapsed >= 1 && onScreenWindows > 0
}

// One on-screen window as the window server lists it. Counted only when a
// person would call it the application's window: on the normal layer, drawn,
// and larger than a status item or an invisible helper surface. Minimized
// windows and windows on another Space are not on screen, so not counted.
struct OnScreenWindow {
    let pid: Int
    let layer: Int
    let alpha: Double
    let width: Double
    let height: Double
}
let standardWindowMinSide = 40.0
func standardWindowCount(_ windows: [OnScreenWindow], pid: Int) -> Int {
    windows.filter { $0.pid == pid && $0.layer == 0 && $0.alpha > 0 && $0.width >= standardWindowMinSide && $0.height >= standardWindowMinSide }.count
}
// Where a window stands in an application's accessibility window list (front
// to back): its index, or -1 for no window or one the list does not hold. The
// helper's read-only windows query (windowsReport, Controller.swift; read by
// scripts/probe-web-controls.mjs --type) compares the main window, the focused
// window and the focused element's window by number, so a probe can say the
// key window is not the field's without a title. Identity is the caller's
// (CFEqual for elements).
func windowIndex<T>(_ target: T?, in windows: [T], same: (T, T) -> Bool) -> Int {
    guard let target = target else { return -1 }
    return windows.firstIndex { same($0, target) } ?? -1
}
// A running application turns frontmost before an unhidden window or a Space
// switch reaches the screen. Any window is a final count; none is final only
// after this long, or open_app would call a hidden TextEdit windowless and
// send the model to File > New instead of the user's open document. A Space
// switch animates for about half a second, so the settle is the full second
// launchReopenAllowed already waits before judging a running app's windows.
let windowSettleSeconds = 1.0
func windowCountSettled(windows: Int, waited: TimeInterval) -> Bool {
    windows > 0 || waited >= windowSettleSeconds
}

func launchDenied(name: String, displayName: String, bundleId: String) -> Bool {
    let id = bundleId.lowercased()
    return id.isEmpty || launchNameDenied(name) || launchNameDenied(displayName) || launchNameDenied(id) || matches(launchBundlePattern, id) ||
        launchFloorDenied.contains(id) || launchRefusedPrefixes.contains(where: { id.hasPrefix($0) })
}

func launchProtected(bundleId: String, protectedApps: [String]) -> Bool {
    let id = bundleId.lowercased()
    return protectedApps.contains(where: { !$0.isEmpty && id.contains($0.lowercased()) })
}

func launchCandidateDenied(_ candidate: LaunchCandidate, protectedApps: [String]) -> Bool {
    candidate.names.contains(where: launchNameDenied) ||
        launchDenied(name: candidate.names.first ?? "", displayName: candidate.displayName, bundleId: candidate.bundleId) ||
        launchProtected(bundleId: candidate.bundleId, protectedApps: protectedApps)
}

// Whole-word token sequence: "chrome" is inside "google chrome", "note" is not inside "notes".
private func containsTokens(_ haystack: [String], _ needle: [String]) -> Bool {
    guard !needle.isEmpty, needle.count <= haystack.count else { return false }
    return (0...(haystack.count - needle.count)).contains { Array(haystack[$0..<($0 + needle.count)]) == needle }
}

private func overlap(_ query: [String], _ name: String) -> Int {
    let tokens = appNameTokens(name)
    return query.filter { q in tokens.contains { $0 == q || (min($0.count, q.count) >= 3 && ($0.hasPrefix(q) || q.hasPrefix($0))) } }.count
}

// Bounded, permitted-only names so a retry reason never lists the whole inventory.
func launchCandidateNames(query: String, candidates: [LaunchCandidate], requireOverlap: Bool) -> [String] {
    let tokens = appNameTokens(query)
    var seen = Set<String>(), scored = [(Int, String)]()
    for candidate in candidates {
        let name = String(candidate.displayName.prefix(120)), key = normalizeAppName(name)
        guard !key.isEmpty, !seen.contains(key) else { continue }
        let score = candidate.names.map { overlap(tokens, $0) }.max() ?? 0
        if requireOverlap && score == 0 { continue }
        seen.insert(key); scored.append((score, name))
    }
    return scored.sorted { $0.0 != $1.0 ? $0.0 > $1.0 : $0.1.lowercased() < $1.1.lowercased() }.prefix(5).map { $0.1 }
}

func resolveLaunch(query: String, candidates: [LaunchCandidate], protectedApps: [String]) -> LaunchResolution {
    let normalized = normalizeAppName(query)
    guard !normalized.isEmpty else { return .unresolved([]) }
    if launchNameDenied(normalized) { return .refused }
    let permitted = candidates.filter { !launchCandidateDenied($0, protectedApps: protectedApps) }
    let tokens = appNameTokens(normalized)
    let tiers: [(LaunchCandidate) -> Bool] = [
        { $0.names.contains { normalizeAppName($0) == normalized } },
        { $0.names.contains { containsTokens(appNameTokens($0), tokens) } },
    ]
    for tier in tiers {
        let hits = candidates.filter(tier)
        guard !hits.isEmpty else { continue }
        let allowed = hits.filter { hit in permitted.contains { $0.path == hit.path } }
        guard !allowed.isEmpty else { return .refused }
        let ids = Set(allowed.map { $0.bundleId.lowercased() })
        if ids.count > 1 { return .ambiguous(launchCandidateNames(query: normalized, candidates: allowed, requireOverlap: false)) }
        let best = allowed.min { a, b in a.running != b.running ? a.running : a.rootIndex < b.rootIndex }!
        return .resolved(appId: best.bundleId, name: String(best.displayName.prefix(120)), path: best.path)
    }
    return .unresolved(launchCandidateNames(query: normalized, candidates: permitted, requireOverlap: true))
}
