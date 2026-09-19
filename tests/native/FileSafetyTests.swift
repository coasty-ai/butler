import Foundation

// Pure system index and open_file rules in FileSafety.swift.
func fileSafetyChecks(_ check: (Bool, String) -> Void) {
    let home = "/Users/u"
    // homeRelative
    check(homeRelative("/Users/u/Documents/Q3.xlsx", home: home) == "~/Documents/Q3.xlsx", "home-relative path for a document")
    check(homeRelative("/Users/u", home: home) == "~", "home folder itself is ~")
    check(homeRelative("/Users/u/Desktop", home: "/Users/u/") == "~/Desktop", "trailing slash on home is ignored")
    check(homeRelative("/Users/uu/Desktop", home: home) == nil, "sibling home with a shared prefix is outside")
    check(homeRelative("/Volumes/Disk/file.txt", home: home) == nil, "external volumes are outside the home folder")
    check(homeRelative("/Users/u/x", home: "/") == nil, "root is never treated as a home folder")

    // indexExcluded
    func excluded(_ relative: String) -> Bool { indexExcluded(realPath: home + "/" + relative, home: home) }
    check(!excluded("Documents/Q3 report.pdf"), "ordinary document is indexable")
    check(!excluded("Desktop"), "standard folder is indexable")
    check(indexExcluded(realPath: home, home: home), "home folder itself is not an item")
    check(excluded("Library/Keychains/login.keychain-db"), "~/Library is excluded")
    check(excluded("Library/Application Support/Slack/data"), "application data under Library is excluded")
    check(excluded("Library"), "~/Library itself is excluded")
    check(!excluded("Library/Mobile Documents/com~apple~CloudDocs"), "iCloud Drive root is allowed")
    check(!excluded("Library/Mobile Documents/com~apple~CloudDocs/Budget.numbers"), "iCloud Drive documents are allowed")
    check(excluded("Library/Mobile Documents/iCloud~com~app/Documents/x.txt"), "other app containers in Mobile Documents are excluded")
    check(excluded("Library/Mobile Documents"), "Mobile Documents parent is excluded")
    check(excluded(".ssh/config"), "hidden folders are excluded")
    check(excluded("Documents/.hidden.txt"), "hidden files are excluded")
    check(excluded("Projects/app/node_modules/pkg/readme.md"), "node_modules is excluded")
    check(excluded("Projects/app/.git/HEAD"), ".git is excluded")
    check(excluded(".Trash/old.pdf"), "Trash is excluded")
    check(indexExcluded(realPath: "/Volumes/Backup/Documents/a.pdf", home: home), "volumes outside home are excluded")
    check(indexExcluded(realPath: "/etc/passwd", home: home), "system paths are excluded")
    check(indexExcluded(realPath: "/Users/uu/Documents/a.pdf", home: home), "other users' folders are excluded")
    for name in [".env", ".env.local", "id_rsa", "id_rsa.pub", "id_ed25519", "server.pem", "tls.key", "cert.p12", "cert.pfx", "login.keychain", "login.keychain-db", "My Passwords.txt", "PASSWORD list.xlsx", "client_secret.json", "vault.kdbx", "aws credentials.csv"] {
        check(excluded("Documents/" + name), "credential-like name \(name) is excluded")
    }
    // Default password-export names and further key and password-database formats.
    for name in ["logins.csv", "Logins.CSV", "bitwarden_export_20240101123000.json", "bitwarden_encrypted_export_20240101.json", "AuthKey_ABC123.p8", "identity.pkcs12", "office.ovpn", "export.1pif", "export.1pux", "old.kdb", "safe.psafe3", "private-key.asc", "wallet.dat"] {
        check(excluded("Downloads/" + name), "credential-like name \(name) is excluded")
        check(credentialLikeName(name), "credentialLikeName matches \(name)")
    }
    check(!excluded("Downloads/logins report.csv") && !excluded("Downloads/export.csv") && !excluded("Documents/wallet.dat.txt") && !excluded("Documents/bitwarden notes.md"), "names that only resemble export names are indexable")
    check(excluded("Secrets/notes.txt"), "items inside a credential-like folder are excluded")
    check(!excluded("Documents/keynote talk.pdf"), "names merely containing 'key' are not credentials")
    check(excluded("Documents//a.pdf"), "empty path components are excluded")
    check(excluded("Documents/../Library/x"), "dot-dot components are excluded")
    check(excluded("Documents/a\u{7}b.txt"), "control characters are excluded")

    // fileOpenRefused
    func refused(_ name: String, _ facts: FileFacts = FileFacts()) -> Bool { fileOpenRefused(realPath: home + "/Downloads/" + name, facts: facts) }
    check(!refused("Report.pdf", FileFacts(types: ["com.adobe.pdf", "public.data"])), "PDF documents may be opened")
    check(!refused("notes.md"), "markdown may be opened")
    check(!refused("page.html", FileFacts(types: ["public.html", "public.text"])), "HTML documents may be opened")
    check(!refused("archive.zip", FileFacts(types: ["public.zip-archive", "public.archive"])), "zip archives may be opened")
    for name in ["Tool.app", "Ext.appex", "Kit.framework", "Thing.bundle", "Pane.prefPane"] {
        check(refused(name, FileFacts(directory: true, package: true)), "application or bundle \(name) is refused")
    }
    for name in ["run.sh", "Run.command", "x.tool", "a.zsh", "b.bash", "c.py", "d.rb", "e.pl", "f.js", "g.jxa", "h.php", "i.ps1", "j.jar", "setup.exe"] {
        check(refused(name), "script \(name) is refused")
    }
    for name in ["Setup.pkg", "Suite.mpkg", "Image.dmg", "disc.iso", "vol.sparsebundle"] {
        check(refused(name), "installer or disk image \(name) is refused")
    }
    for name in ["Flow.workflow", "a.scpt", "a.applescript", "Do.shortcut", "Pro.terminal", "loc.fileloc", "site.webloc", "Profile.mobileconfig"] {
        check(refused(name), "workflow or launcher \(name) is refused")
    }
    check(refused("RUN.SH"), "refused extensions are case-insensitive")
    check(refused("tool", FileFacts(types: ["public.unix-executable", "public.data", "public.executable"])), "Mach-O executables are refused by type")
    check(refused("renamed.txt", FileFacts(types: ["public.shell-script", "public.script"])), "scripts are refused by type conformance even when renamed")
    check(refused("App Copy", FileFacts(directory: true, package: true, types: ["com.apple.application-bundle"])), "application bundles are refused by type")
    check(refused("runme", FileFacts(executable: true)), "executable files without an extension are refused")
    check(!refused("report.txt", FileFacts(executable: true, types: ["public.plain-text"])), "an execute bit on a plain document is not refused")
    check(fileOpenRefused(realPath: home + "/Documents/LaunchAgents/com.evil.plist", facts: FileFacts()), "launch agent property lists are refused")
    check(!fileOpenRefused(realPath: home + "/Documents/settings.plist", facts: FileFacts()), "ordinary property lists may be opened")
    check(refused("Unknown.pkgbundle", FileFacts(directory: true, package: true)), "unknown packages are refused")
    check(!refused("Essay.pages", FileFacts(directory: true, package: true)), "Pages document packages may be opened")
    check(!refused("Notes.rtfd", FileFacts(directory: true, package: true)), "RTFD document packages may be opened")
    check(!refused("Screenshots", FileFacts(directory: true)), "plain folders may be opened")
    check(refused("Photos Library.photoslibrary", FileFacts(directory: true, package: true)), "media libraries are refused")
    // Terminal session and settings files run a stored command when opened.
    check(refused("Session.term", FileFacts(types: ["com.apple.terminal.session", "public.item", "public.data"])), "Terminal session files are refused")
    check(refused("Session.term"), "Terminal session files are refused by extension without a type")
    check(refused("Profile.terminal", FileFacts(types: ["com.apple.terminal.settings", "public.item", "public.data"])), "Terminal settings files are refused")
    check(refused("invoice.pdf", FileFacts(types: ["com.apple.terminal.session", "public.item", "public.data"])), "a renamed file typed as a Terminal session is refused")
    check(refused("Invoice", FileFacts(types: ["com.apple.terminal.settings"])), "an extensionless file typed as Terminal settings is refused")
    // Apple's LSRiskCategoryUnsafeExecutable types, whatever the name.
    for type in ["com.apple.webarchive", "com.apple.mach-o-binary", "com.apple.interfacebuilder.document", "com.sun.java-class", "com.sun.java-web-start", "com.apple.quartz-composer-composition", "com.apple.itunes.ipg", "com.apple.shortcuts.workflow-file", "COM.APPLE.WEBARCHIVE"] {
        check(refused("notes.txt", FileFacts(types: [type, "public.data", "public.item"])), "unsafe executable type \(type) is refused")
    }
    // Apple's LSRiskCategoryUnsafeExecutable extensions, untyped or with dynamic types.
    for ext in ["wflow", "nib", "help", "trace", "tracetemplate", "x11app", "inputplugin", "ibplugin", "menu", "cin", "gcx", "icp", "ipg", "webarchive", "class", "jnlp", "qtz"] {
        check(refused("item." + ext, FileFacts(types: ["dyn.ah62d4rv4ge8", "public.data", "public.item"])), "unsafe executable extension .\(ext) is refused")
        check(refused("ITEM." + ext.uppercased()), "unsafe executable extension .\(ext) is refused case-insensitively")
    }
    check(refused("Plug.inputplugin", FileFacts(directory: true, package: true)) && refused("Nib.nib", FileFacts(directory: true)), "unsafe executable extensions are refused on directories")
    // Internet locations and stored URLs hand their URL to a handler when opened.
    for ext in ["afploc", "ftploc", "mailloc", "newsloc", "vncloc", "atloc", "nslloc", "webloc", "inetloc", "fileloc", "url"] {
        check(refused("Share." + ext), "location extension .\(ext) is refused without a type")
    }
    check(refused("Share.vncloc", FileFacts(types: ["com.apple.vnc-internet-location", "com.apple.internet-location", "public.stored-url", "public.data", "public.item"])), "VNC location files are refused")
    check(refused("Invoice", FileFacts(types: ["com.apple.file-internet-location", "public.data", "com.apple.internet-location", "public.stored-url", "public.item"])), "an extensionless file typed as a file location is refused by conformance")
    check(refused("Invoice", FileFacts(types: ["com.apple.web-internet-location", "public.data", "public.item"])), "an extensionless web location is refused even without its parent types")
    check(refused("Invoice", FileFacts(types: ["com.apple.file-internet-location"])), "a file location type alone is refused")
    check(refused("Invoice", FileFacts(types: ["com.example.custom-location", "public.stored-url"])), "any type conforming to public.stored-url is refused")
    check(refused("Invoice", FileFacts(types: ["com.example.bookmark", "com.apple.internet-location"])), "any type conforming to com.apple.internet-location is refused")
    check(refused("Link", FileFacts(types: ["com.microsoft.internet-shortcut", "public.data"])), "Windows internet shortcuts are refused by type")
    check(fileTypeRefused("com.apple.afp-internet-location") && fileTypeRefused("PUBLIC.STORED-URL") && !fileTypeRefused("public.plain-text") && !fileTypeRefused("com.adobe.pdf"), "fileTypeRefused matches location types case-insensitively and nothing else")
    check(!refused("Location notes.txt", FileFacts(types: ["public.plain-text", "public.text", "public.data"])) && !refused("terms.pdf", FileFacts(types: ["com.adobe.pdf"])) && !refused("menu.pdf", FileFacts(types: ["com.adobe.pdf"])), "ordinary documents with similar names may be opened")

    // fileKind
    check(fileKind(FileFacts(directory: true)) == .folder, "plain directory is a folder")
    check(fileKind(FileFacts(directory: true, package: true)) == .document, "document package is a document")
    check(fileKind(FileFacts()) == .document, "regular file is a document")

    // resolveOpenPath with a fake filesystem.
    let links: [String: String] = [
        "/Users/u/Documents/Q3.xlsx": "/Users/u/Documents/Q3.xlsx",
        "/Users/u/Documents": "/Users/u/Documents",
        "/Users/u/Desktop/Shortcut.pdf": "/Users/u/Documents/Q3.xlsx",
        "/Users/u/Desktop/Escape": "/etc",
        "/Users/u/Desktop/Volume Link": "/Volumes/USB/doc.pdf",
        "/Users/u/Desktop/Keys": "/Users/u/.ssh",
        "/Users/u/Desktop/Hidden Link.txt": "/Users/u/Library/Preferences/com.apple.x.plist",
        "/Users/u/Downloads/Setup.pkg": "/Users/u/Downloads/Setup.pkg",
        "/Users/u/Downloads/Tool.app": "/Users/u/Downloads/Tool.app",
        "/Users/u/Downloads/renamed": "/Users/u/Downloads/renamed",
        "/Users/u/Desktop/Good Alias": "/Users/u/Desktop/Good Alias",
        "/Users/u/Desktop/App Alias": "/Users/u/Desktop/App Alias",
        "/Users/u/Desktop/Broken Alias": "/Users/u/Desktop/Broken Alias",
        "/Users/u/Desktop/Outside Alias": "/Users/u/Desktop/Outside Alias",
        "/Users/u/Desktop/Folder Alias": "/Users/u/Desktop/Folder Alias",
        "/Users/u/Desktop/Session Alias": "/Users/u/Desktop/Session Alias",
        "/Users/u/Downloads/Invoice": "/Users/u/Downloads/Invoice",
        "/Users/u/Downloads/Share.vncloc": "/Users/u/Downloads/Share.vncloc",
        "/Users/u/Downloads/logins.csv": "/Users/u/Downloads/logins.csv",
        "/Users/u/Library/Mobile Documents/com~apple~CloudDocs": "/Users/u/Library/Mobile Documents/com~apple~CloudDocs",
        "/Users/u/Essay.pages": "/Users/u/Essay.pages",
        "/Users/u": "/Users/u",
        "/Users/u/Library/Keychains": "/Users/u/Library/Keychains",
    ]
    let facts: [String: FileFacts] = [
        "/Users/u/Documents/Q3.xlsx": FileFacts(types: ["org.openxmlformats.spreadsheetml.sheet", "public.data"]),
        "/Users/u/Documents": FileFacts(directory: true, types: ["public.folder", "public.directory"]),
        "/Users/u/Downloads/Setup.pkg": FileFacts(types: ["com.apple.installer-package-archive"]),
        "/Users/u/Downloads/Tool.app": FileFacts(directory: true, package: true, types: ["com.apple.application-bundle"]),
        "/Users/u/Downloads/renamed": FileFacts(executable: true, types: ["public.unix-executable", "public.executable"]),
        "/Users/u/Desktop/Good Alias": FileFacts(alias: true, aliasTarget: "/Users/u/Documents/Q3.xlsx", types: ["com.apple.alias-file"]),
        "/Users/u/Desktop/App Alias": FileFacts(alias: true, aliasTarget: "/Users/u/Downloads/Tool.app", types: ["com.apple.alias-file"]),
        "/Users/u/Desktop/Broken Alias": FileFacts(alias: true, aliasTarget: nil, types: ["com.apple.alias-file"]),
        "/Users/u/Desktop/Outside Alias": FileFacts(alias: true, aliasTarget: "/Applications/Calculator.app", types: ["com.apple.alias-file"]),
        "/Users/u/Desktop/Folder Alias": FileFacts(alias: true, aliasTarget: "/Users/u/Documents", types: ["com.apple.alias-file"]),
        "/Users/u/Desktop/Session Alias": FileFacts(alias: true, aliasTarget: "/Users/u/Downloads/Invoice", types: ["com.apple.alias-file"]),
        "/Users/u/Downloads/Invoice": FileFacts(types: ["com.apple.terminal.session", "public.item", "public.data"]),
        "/Users/u/Downloads/Share.vncloc": FileFacts(types: ["com.apple.vnc-internet-location", "com.apple.internet-location", "public.stored-url"]),
        "/Users/u/Downloads/logins.csv": FileFacts(types: ["public.comma-separated-values-text", "public.plain-text"]),
        "/Users/u/Library/Mobile Documents/com~apple~CloudDocs": FileFacts(directory: true, types: ["public.folder"]),
        "/Users/u/Essay.pages": FileFacts(directory: true, package: true, types: ["com.apple.iwork.pages.sffpages"]),
        "/etc": FileFacts(directory: true),
        "/Users/u/Library/Keychains": FileFacts(directory: true),
    ]
    var inspected = [String]()
    func resolve(_ requested: String, home: String = home) -> FileResolution {
        resolveOpenPath(requested, home: home, realpath: { links[$0] }, inspect: { inspected.append($0); return facts[$0] })
    }
    check(resolve("~/Documents/Q3.xlsx") == .resolved(path: "~/Documents/Q3.xlsx", real: "/Users/u/Documents/Q3.xlsx", kind: .document, opens: "/Users/u/Documents/Q3.xlsx"), "existing document resolves")
    check(resolve("~/Documents") == .resolved(path: "~/Documents", real: "/Users/u/Documents", kind: .folder, opens: "/Users/u/Documents"), "existing folder resolves as a folder")
    check(resolve("~/Documents/") == .resolved(path: "~/Documents", real: "/Users/u/Documents", kind: .folder, opens: "/Users/u/Documents"), "a trailing slash is tolerated")
    check(resolve("~/Documents/Q3.xlsx", home: "/Users/u/") == .resolved(path: "~/Documents/Q3.xlsx", real: "/Users/u/Documents/Q3.xlsx", kind: .document, opens: "/Users/u/Documents/Q3.xlsx"), "home with a trailing slash resolves")
    check(resolve("~/Essay.pages") == .resolved(path: "~/Essay.pages", real: "/Users/u/Essay.pages", kind: .document, opens: "/Users/u/Essay.pages"), "document package resolves as a document")
    check(resolve("~/Library/Mobile Documents/com~apple~CloudDocs") == .resolved(path: "~/Library/Mobile Documents/com~apple~CloudDocs", real: "/Users/u/Library/Mobile Documents/com~apple~CloudDocs", kind: .folder, opens: "/Users/u/Library/Mobile Documents/com~apple~CloudDocs"), "iCloud Drive root resolves")
    check(resolve("~/Desktop/Shortcut.pdf") == .resolved(path: "~/Documents/Q3.xlsx", real: "/Users/u/Documents/Q3.xlsx", kind: .document, opens: "/Users/u/Documents/Q3.xlsx"), "symlink inside home resolves to its real home-relative path")
    check(resolve("~/Documents/Missing.docx") == .unresolved, "nonexistent path is unresolved")
    inspected = []
    check(resolve("~/Library/Keychains") == .refused && inspected.isEmpty, "~/Library/Keychains is refused before inspection")
    check(resolve("~/.ssh/id_rsa") == .refused, "hidden credential path is refused")
    check(resolve("~/Documents/../Library/Keychains") == .refused, "dot-dot traversal is refused")
    check(resolve("~/Documents/..") == .refused, "trailing dot-dot is refused")
    check(resolve("~/./Documents") == .unresolved, "dot components are not resolved")
    check(resolve("~//Documents") == .unresolved, "empty components are not resolved")
    check(resolve("/etc/passwd") == .refused, "absolute paths are refused")
    check(resolve("~") == .refused, "bare home is refused")
    check(resolve("~other/Documents") == .refused, "other users' tilde paths are refused")
    check(resolve("~/Documents/a\u{0}b") == .unresolved, "control characters are not resolved")
    check(resolve("~/" + String(repeating: "a", count: 600)) == .unresolved, "overlong paths are not resolved")
    check(resolve("~/Desktop/Escape") == .refused, "symlink escaping the home folder is refused")
    check(resolve("~/Desktop/Volume Link") == .refused, "symlink to an external volume is refused")
    check(resolve("~/Desktop/Keys") == .refused, "symlink into a hidden folder is refused")
    check(resolve("~/Desktop/Hidden Link.txt") == .refused, "symlink into ~/Library is refused")
    check(resolve("~/Downloads/Setup.pkg") == .refused, "installer package is refused")
    check(resolve("~/Downloads/Tool.app") == .refused, "application bundle is refused")
    check(resolve("~/Downloads/renamed") == .refused, "executable without extension is refused")
    check(resolve("~/Desktop/Good Alias") == .resolved(path: "~/Desktop/Good Alias", real: "/Users/u/Desktop/Good Alias", kind: .document, opens: "/Users/u/Documents/Q3.xlsx"), "alias to a permitted document resolves and opens its verified target")
    check(resolve("~/Desktop/Folder Alias") == .resolved(path: "~/Desktop/Folder Alias", real: "/Users/u/Desktop/Folder Alias", kind: .folder, opens: "/Users/u/Documents"), "alias to a folder opens the folder, so its kind is folder")
    check(resolve("~/Desktop/Session Alias") == .refused, "alias to a Terminal session file is refused")
    check(resolve("~/Desktop/App Alias") == .refused, "alias to an application is refused")
    check(resolve("~/Desktop/Outside Alias") == .refused, "alias to a target outside home is refused")
    check(resolve("~/Desktop/Broken Alias") == .unresolved, "alias whose target is missing is unresolved")
    check(resolve("~/Downloads/Invoice") == .refused, "an extensionless file typed as a Terminal session is refused when resolved")
    check(resolve("~/Downloads/Share.vncloc") == .refused, "a VNC location file is refused when resolved")
    inspected = []
    check(resolve("~/Downloads/logins.csv") == .refused && inspected.isEmpty, "a password export name is refused before inspection")
    check(resolveOpenPath("~/Documents/Q3.xlsx", home: "/", realpath: { $0 }, inspect: { _ in FileFacts() }) == .unresolved, "root home never resolves")
    // Home folder itself behind a symlink (e.g. /Users -> /System/Volumes/Data/Users).
    let linkedHome: [String: String] = ["/home/u": "/data/u", "/home/u/Notes.txt": "/data/u/Notes.txt"]
    check(resolveOpenPath("~/Notes.txt", home: "/home/u", realpath: { linkedHome[$0] }, inspect: { _ in FileFacts(types: ["public.plain-text"]) }) == .resolved(path: "~/Notes.txt", real: "/data/u/Notes.txt", kind: .document, opens: "/data/u/Notes.txt"), "a symlinked home folder compares real paths")
    check(openFileDisplayName("~/Library/Mobile Documents/com~apple~CloudDocs") == "iCloud Drive", "iCloud Drive root has a friendly name")
    check(openFileDisplayName("~/Documents/Q3.xlsx") == "Q3.xlsx", "display name is the last component")

    // fileHandlerRefused: the default application must be one open_app permits.
    func app(_ bundleId: String, _ name: String, path: String? = nil) -> LaunchCandidate {
        LaunchCandidate(path: path ?? "/Applications/\(name).app", bundleId: bundleId, names: [name, name], displayName: name, running: false, rootIndex: 0)
    }
    let defaults = ["com.1password", "com.apple.Passwords", "com.apple.keychainaccess", "com.bitwarden", "com.apple.Terminal", "com.googlecode.iterm2"]
    let finder = app("com.apple.finder", "Finder", path: "/System/Library/CoreServices/Finder.app")
    let textEdit = app("com.apple.TextEdit", "TextEdit", path: "/System/Applications/TextEdit.app")
    check(!fileHandlerRefused(kind: .document, handler: textEdit, protectedApps: defaults), "a document opening in TextEdit is permitted")
    check(!fileHandlerRefused(kind: .document, handler: app("com.microsoft.VSCode", "Visual Studio Code", path: "/Users/u/Downloads/Visual Studio Code.app"), protectedApps: defaults), "a permitted handler outside /Applications is permitted")
    check(!fileHandlerRefused(kind: .document, handler: app("com.apple.archiveutility", "Archive Utility", path: "/System/Library/CoreServices/Applications/Archive Utility.app"), protectedApps: defaults), "archives opening in Archive Utility are permitted")
    check(!fileHandlerRefused(kind: .folder, handler: finder, protectedApps: defaults), "a folder opening in Finder is permitted")
    check(!fileHandlerRefused(kind: .folder, handler: app("COM.APPLE.FINDER", "Finder"), protectedApps: defaults), "Finder's bundle identifier is compared case-insensitively")
    check(!fileHandlerRefused(kind: .document, handler: finder, protectedApps: defaults), "a document Finder opens (saved search, clipping) is permitted")
    check(fileHandlerRefused(kind: .document, handler: nil, protectedApps: defaults), "a document with no default application is refused")
    check(fileHandlerRefused(kind: .folder, handler: nil, protectedApps: defaults), "a folder with no default application is refused")
    check(fileHandlerRefused(kind: .folder, handler: app("com.cocoatech.PathFinder", "Path Finder"), protectedApps: defaults), "a folder must open in Finder, not a replacement file manager")
    check(fileHandlerRefused(kind: .folder, handler: textEdit, protectedApps: defaults), "a folder whose handler is not Finder is refused")
    check(fileHandlerRefused(kind: .folder, handler: finder, protectedApps: defaults + ["com.apple.finder"]), "a folder is refused when Finder is protected")
    for (id, name) in [("com.apple.keychainaccess", "Keychain Access"), ("com.apple.Terminal", "Terminal"), ("com.googlecode.iterm2", "iTerm"), ("com.apple.ScriptEditor2", "Script Editor"), ("com.apple.Automator", "Automator"), ("com.apple.DiskUtility", "Disk Utility"), ("com.apple.installer", "Installer"), ("ai.coarena.openassist", "Butler")] {
        check(fileHandlerRefused(kind: .document, handler: app(id, name), protectedApps: []), "a document opening in launch-floor application \(name) is refused even with no protected apps")
    }
    check(fileHandlerRefused(kind: .document, handler: app("com.example.tool", "Acme Setup Assistant"), protectedApps: []), "a document opening in an installer-named application is refused")
    check(fileHandlerRefused(kind: .document, handler: app("com.example.installerhelper", "Acme"), protectedApps: []), "a document opening in an installer bundle identifier is refused")
    check(fileHandlerRefused(kind: .document, handler: app("com.apple.automator.Converter", "Converter"), protectedApps: []), "a document opening in an Automator applet identifier is refused")
    check(fileHandlerRefused(kind: .document, handler: app("", "Nameless"), protectedApps: []), "a handler without a bundle identifier is refused")
    check(fileHandlerRefused(kind: .document, handler: app("com.bitwarden.desktop", "Bitwarden"), protectedApps: defaults), "a document opening in a protected application is refused")
    check(fileHandlerRefused(kind: .document, handler: app("com.example.notes", "Notes Plus"), protectedApps: ["com.example.notes"]), "a document opening in a user-protected application is refused")
    check(!fileHandlerRefused(kind: .document, handler: app("com.example.notes", "Notes Plus"), protectedApps: [""]), "an empty protected entry protects nothing")
    for (id, name) in [("com.apple.systempreferences", "System Settings"), ("com.apple.mcx.ProfileHelper", "ProfileHelper"), ("com.apple.shortcuts", "Shortcuts"), ("com.apple.ScreenSharing", "Screen Sharing")] {
        check(fileHandlerRefused(kind: .document, handler: app(id, name), protectedApps: []), "a document that \(name) would import or connect is refused")
    }

    // Index query helpers
    check(indexQueryTokens("open the Q3 quarterly report") == ["quarterly", "report", "q3"], "query tokens are the longest three without stopwords")
    check(indexQueryTokens("find my file") == [], "stopword-only query has no tokens")
    check(indexQueryTokens("résumé \"*x*\" || kMDItemFSName") == ["kmditemfsname", "résumé"], "tokens drop quotes, wildcards and operators")
    check(indexQueryTokens("report Report REPORT") == ["report"], "tokens are deduplicated case-insensitively")
    // URL and host fragments never become Spotlight substring matches.
    check(indexQueryTokens("go to github.com") == ["github"], "a host name drops its top-level domain")
    check(indexQueryTokens("Go to GitHub.com.") == ["github"], "a host name at the end of a sentence drops its top-level domain")
    check(indexQueryTokens("open https://www.github.com/anthropics/claude-code") == ["anthropics", "github", "claude"], "URLs drop the scheme, www and top-level domain but keep path words")
    check(indexQueryTokens("open news.bbc.co.uk") == ["news", "bbc"], "multi-label domains drop their suffixes")
    check(indexQueryTokens("visit example.dev and example.ai") == ["example", "visit"], "any top-level domain is dropped")
    check(indexQueryTokens("go to github dot com") == ["github", "dot"], "a spoken com is dropped")
    check(indexQueryTokens("http www com org net io co html htm") == [], "URL fragments alone produce no tokens")
    check(indexQueryTokens("open report.pdf") == ["report"], "a file extension is not a token")
    check(indexQueryTokens("open ~/Documents/Budget 2024.numbers") == ["budget", "2024"], "path components keep names and drop the extension")
    check(indexQueryTokens("open Q3.2024 notes v1.2") == ["notes", "2024", "q3"], "numeric dotted labels are kept")
    check(indexQueryTokens("open index.html?x=1") == ["index"], "a query string does not hide the extension")
    check(indexQueryTokens("open the co-op budget") == ["budget", "op"], "the co fragment is dropped wherever it appears")
    check(indexMatchQuery(["q3", "report"]) == "kMDItemDisplayName == \"*q3*\"cdw || kMDItemDisplayName == \"*report*\"cdw", "Spotlight match query ORs display-name substrings")
    check(indexLimit(nil) == 10 && indexLimit(50) == 20 && indexLimit(0) == 1 && indexLimit(5) == 5 && indexLimit("7") == 10 && indexLimit(true) == 10, "index limit defaults to 10 and is clamped to 1...20")
    let now = Date()
    let items = [
        IndexItem(path: "/Users/u/Documents/Q3 report.pdf", types: ["com.adobe.pdf"], lastUsed: now),
        IndexItem(path: "/Users/u/Library/Caches/report.json", types: ["public.json"], lastUsed: now),
        IndexItem(path: "/Users/u/Downloads/report.pkg", types: ["com.apple.installer-package-archive"], lastUsed: now),
        IndexItem(path: "/Users/u/Downloads/report.app", types: ["com.apple.application-bundle", "com.apple.package"], lastUsed: now),
        IndexItem(path: "/Users/u/Projects/Reports", types: ["public.folder", "public.directory"], lastUsed: nil),
        IndexItem(path: "/Users/u/Documents/Q3 report.pdf", types: ["com.adobe.pdf"], lastUsed: now),
        IndexItem(path: "/Users/u/Documents/passwords report.xlsx", types: ["public.data"], lastUsed: now),
        IndexItem(path: "/Volumes/USB/report.pdf", types: ["com.adobe.pdf"], lastUsed: now),
        IndexItem(path: "/Users/u/Desktop/report alias", types: ["com.apple.alias-file"], lastUsed: now),
        IndexItem(path: "/Users/u/Essay.pages", types: ["com.apple.iwork.pages.sffpages", "com.apple.package"], lastUsed: now),
        IndexItem(path: "/Users/u/Downloads/report.term", types: ["com.apple.terminal.session", "public.data", "public.item"], lastUsed: now),
        IndexItem(path: "/Users/u/Downloads/Report", types: ["com.apple.file-internet-location", "public.data", "com.apple.internet-location", "public.stored-url", "public.item"], lastUsed: now),
        IndexItem(path: "/Users/u/Downloads/report.vncloc", types: ["com.apple.vnc-internet-location"], lastUsed: now),
        IndexItem(path: "/Users/u/Downloads/logins.csv", types: ["public.comma-separated-values-text"], lastUsed: now),
        IndexItem(path: "/Users/u/Downloads/bitwarden_export_20240101.json", types: ["public.json"], lastUsed: now),
    ]
    let entries = indexEntries(items, home: home, limit: 10)
    check(entries.map { $0.path } == ["~/Documents/Q3 report.pdf", "~/Projects/Reports", "~/Essay.pages"], "index entries keep only permitted documents and folders, deduplicated (no Terminal sessions, locations or password exports)")
    check(entries.map { $0.kind } == [.document, .folder, .document], "index entry kinds come from content types")
    check(entries.allSatisfy { !$0.path.hasPrefix("/") && !$0.name.contains("/") }, "index entries never expose absolute paths")
    check(indexEntries(items, home: home, limit: 1).count == 1, "index entries honour the limit")
    let older = now.addingTimeInterval(-3600)
    let ranked = rankIndexMatches([
        IndexItem(path: "/Users/u/a/report.txt", types: [], lastUsed: now),
        IndexItem(path: "/Users/u/a/q3 report.txt", types: [], lastUsed: older),
        IndexItem(path: "/Users/u/a/q3 old report.txt", types: [], lastUsed: nil),
        IndexItem(path: "/Users/u/a/report 2.txt", types: [], lastUsed: older),
    ], tokens: ["report", "q3"])
    check(ranked.map { ($0.path as NSString).lastPathComponent } == ["q3 report.txt", "q3 old report.txt", "report.txt", "report 2.txt"], "matches rank by matched tokens then recency")
    check(indexStandardFolders.first?.relative == "Desktop" && indexStandardFolders.contains { $0.name == "iCloud Drive" && $0.relative == iCloudDriveRelative }, "standard folders include Desktop and iCloud Drive")
}
