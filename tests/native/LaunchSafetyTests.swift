import Foundation

// Pure open_app resolution and denial checks for LaunchSafety.swift.
func launchSafetyChecks(_ check: (Bool, String) -> Void) {
    func app(_ name: String, _ id: String, root: Int = 2, running: Bool = false, path: String? = nil, extra: [String] = []) -> LaunchCandidate {
        LaunchCandidate(path: path ?? "/Applications/\(name).app", bundleId: id, names: [name] + extra, displayName: name, running: running, rootIndex: root)
    }
    let installed = [
        app("Notes", "com.apple.Notes", root: 0), app("Google Chrome", "com.google.Chrome"),
        app("Visual Studio Code", "com.microsoft.VSCode", extra: ["Code"]), app("System Settings", "com.apple.systempreferences", root: 0),
        app("Terminal", "com.apple.Terminal", root: 1), app("Script Editor", "com.apple.ScriptEditor2", root: 1),
        app("Chrome Remote Desktop Host Uninstaller", "com.google.chromeremotedesktop.uninstaller"),
        app("Install macOS Sonoma", "com.apple.InstallAssistant.macOSSonoma"),
        app("AirPort Utility", "com.apple.airport.airportutility", root: 1), app("ColorSync Utility", "com.apple.ColorSyncUtility", root: 1),
        app("1Password", "com.1password.1password"), app("Gmail", "com.google.Chrome.app.abcdef"),
        app("Slack", "com.tinyspeck.slackmacgap", root: 2, path: "/Applications/Slack.app"),
        app("Slack", "com.tinyspeck.slackmacgap", root: 4, running: true, path: "/Users/u/Applications/Slack.app"),
        app("Quick Notes", "com.example.quicknotes"),
    ]
    let protected = ["com.1password", "com.apple.keychainaccess"]
    func resolve(_ query: String, _ list: [LaunchCandidate] = installed) -> LaunchResolution { resolveLaunch(query: query, candidates: list, protectedApps: protected) }
    func resolvedId(_ result: LaunchResolution) -> String? { if case .resolved(let id, _, _) = result { return id }; return nil }

    check(normalizeAppName("  Google   Chrome.app ") == "google chrome", "app name normalization trims, lowercases, strips .app and collapses spaces")
    check(normalizeAppName("NOTES") == "notes", "app name normalization is case-insensitive")
    check(resolvedId(resolve("notes")) == "com.apple.Notes", "exact tier resolves despite a longer token match")
    check(resolvedId(resolve("Google Chrome.app")) == "com.google.Chrome", "exact tier accepts a trailing .app")
    check(resolvedId(resolve("Chrome")) == "com.google.Chrome", "token tier resolves a unique permitted product name")
    check(resolvedId(resolve("Code")) == "com.microsoft.VSCode", "bundle name alternative matches exactly")
    check(resolvedId(resolve("Settings")) == "com.apple.systempreferences", "token tier resolves System Settings")
    check(resolve("Note") == .unresolved(["Notes", "Quick Notes"]), "partial words do not match but similar names are offered")
    check(resolve("Utility") == .ambiguous(["AirPort Utility", "ColorSync Utility"]), "several distinct bundle ids are ambiguous")
    check(resolve("Zzqx") == .unresolved([]), "unrelated names list no inventory")
    check(resolve("Terminal") == .refused, "floor deny list refuses Terminal")
    check(resolve("Script Editor") == .refused, "floor deny list refuses Script Editor")
    check(resolve("Installer") == .refused, "installer request is refused by name")
    check(resolve("Install macOS Sonoma") == .refused, "installer application is refused")
    check(resolve("Chrome Remote Desktop Host Uninstaller") == .refused, "uninstaller application is refused")
    check(resolve("1Password") == .refused, "protected applications are refused")
    check(resolve("Gmail") == .refused, "web app wrapper bundle prefix is refused")
    if case .resolved(let id, _, let path) = resolve("Slack") {
        check(id == "com.tinyspeck.slackmacgap" && path == "/Users/u/Applications/Slack.app", "same bundle id at two paths is one candidate and the running copy is preferred")
    } else { check(false, "same bundle id at two paths is one candidate and the running copy is preferred") }
    let idle = installed.map { LaunchCandidate(path: $0.path, bundleId: $0.bundleId, names: $0.names, displayName: $0.displayName, running: false, rootIndex: $0.rootIndex) }
    if case .resolved(_, _, let path) = resolve("Slack", idle) { check(path == "/Applications/Slack.app", "without a running copy root precedence decides") }
    else { check(false, "without a running copy root precedence decides") }
    check(launchDenied(name: "Adobe Updater", displayName: "Adobe Updater", bundleId: "com.adobe.AAM.Updater-1.0"), "updater names and bundle ids are denied")
    check(launchDenied(name: "Boot Camp Assistant", displayName: "Boot Camp Assistant", bundleId: "com.apple.bootcampassistant"), "boot camp is denied")
    check(!launchDenied(name: "Notes", displayName: "Notes", bundleId: "com.apple.Notes"), "ordinary applications are not denied")
    // Fixture strings shared with the TypeScript INSTALLER_PATTERN policy tests.
    for name in ["Chrome Remote Desktop Host Uninstaller", "Install macOS Sonoma", "Setup Assistant", "com.apple.MigrateAssistant", "Boot Camp Assistant", "Adobe Updater", "com.foo.app-updater", "Setup_Helper", "Migrate Mail", "com.foo.migrator", "BootcampHelper", "Recovery"] {
        check(launchNameDenied(name), "installer pattern matches \(name)")
    }
    for name in ["Notes", "Google Chrome", "System Settings", "Setapp", "com.setapp.DesktopClient", "Visual Studio Code", "Calculator"] {
        check(!launchNameDenied(name), "installer pattern does not match \(name)")
    }
    check(launchDenied(name: "Mail Mover", displayName: "Mail Mover", bundleId: "com.foo.mail-migrator"), "installer pattern applies to separator-normalized bundle ids")
    check(!launchDenied(name: "Setapp", displayName: "Setapp", bundleId: "com.setapp.DesktopClient"), "Setapp is not an installer")
    check(resolve("Migrate Mail", installed + [app("Migrate Mail", "com.foo.mailmover")]) == .refused, "Migrate-prefixed applications are refused like policy denies them")
    check(resolve("Setup_Helper") == .refused, "underscore-joined setup names are refused")
    check(scriptBundle(executableName: "applet", hasMainScript: false, hasWorkflow: false, hasOSAKeys: false), "AppleScript applet executable is a script bundle")
    check(scriptBundle(executableName: "Droplet", hasMainScript: false, hasWorkflow: false, hasOSAKeys: false), "droplet executable is a script bundle")
    check(scriptBundle(executableName: "Application Stub", hasMainScript: false, hasWorkflow: false, hasOSAKeys: false), "Automator application stub is a script bundle")
    check(scriptBundle(executableName: "Photo Cleanup", hasMainScript: true, hasWorkflow: false, hasOSAKeys: false), "applet with a renamed executable but a main script is a script bundle")
    check(scriptBundle(executableName: "Cleanup", hasMainScript: false, hasWorkflow: true, hasOSAKeys: false), "Automator workflow application with a custom id is a script bundle")
    check(scriptBundle(executableName: "Cleanup", hasMainScript: false, hasWorkflow: false, hasOSAKeys: true), "OSA applet Info.plist keys mark a script bundle")
    check(!scriptBundle(executableName: "Google Chrome", hasMainScript: false, hasWorkflow: false, hasOSAKeys: false), "ordinary application binary is not a script bundle")
    check(!scriptBundle(executableName: "appletviewer", hasMainScript: false, hasWorkflow: false, hasOSAKeys: false), "executable names are matched exactly")
    check(!launchReopenAllowed(wasRunning: true, alreadyReopened: false, elapsed: 1.2, onScreenWindows: 0), "a running app with no on-screen window is never reopened")
    check(launchReopenAllowed(wasRunning: true, alreadyReopened: false, elapsed: 1.2, onScreenWindows: 1), "a running app with a visible window may be reopened once")
    check(!launchReopenAllowed(wasRunning: true, alreadyReopened: true, elapsed: 1.2, onScreenWindows: 2), "reopen happens at most once")
    check(!launchReopenAllowed(wasRunning: true, alreadyReopened: false, elapsed: 0.5, onScreenWindows: 2), "reopen waits for activation to stall")
    check(!launchReopenAllowed(wasRunning: false, alreadyReopened: false, elapsed: 2, onScreenWindows: 1), "a cold launch is never reopened")
    let many = (1...9).map { app("Tool \($0)", "com.example.tool\($0)") }
    if case .ambiguous(let names) = resolve("Tool", many) { check(names.count == 5, "candidate names are bounded to five") }
    else { check(false, "candidate names are bounded to five") }
    if case .unresolved(let names) = resolve("Tools", many) { check(names.count == 5 && names.allSatisfy { !$0.contains("/") }, "unresolved candidates are bounded display names") }
    else { check(false, "unresolved candidates are bounded display names") }
}
