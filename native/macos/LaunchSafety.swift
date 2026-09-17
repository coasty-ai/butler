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

// Shell-equivalent, scripting, disk, credential and system-flow applications
// stay manual even when a user removes them from the protected list.
let launchFloorDenied: Set<String> = ["com.apple.terminal", "com.googlecode.iterm2", "com.apple.scripteditor2", "com.apple.automator", "com.apple.diskutility", "com.apple.keychainaccess", "com.apple.migrateassistant", "com.apple.bootcampassistant", "com.apple.installer", "com.apple.spotlight", "com.apple.siri", "ai.coarena.openassist", "com.github.electron"]
// Automator/AppleScript applets and web-app wrappers are scripts, not products.
let launchRefusedPrefixes = ["com.apple.automator.", "com.apple.scripteditor.id.", "com.apple.safari.webapp.", "com.google.chrome.app."]
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
