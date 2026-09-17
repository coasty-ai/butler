import Foundation

// Pure, testable rules for the local system index and the open_file action:
// which paths may be indexed or opened, and how they are shown to the model.
// Controller.swift gathers facts (realpath, resource values, Spotlight
// metadata); this file decides. Nothing here reads file contents.

enum FileKind: String { case folder, document }

enum FileResolution: Equatable {
    /// path is home-relative ("~/..."), real is the absolute realpath (never
    /// emitted). opens is the realpath LaunchServices is asked to open: the
    /// verified target of a Finder alias, otherwise real. kind is the kind of
    /// the item that opens (an alias to a folder opens a folder).
    case resolved(path: String, real: String, kind: FileKind, opens: String)
    case unresolved
    case refused
}

/// Metadata about one existing filesystem item, gathered without reading it.
struct FileFacts: Equatable {
    var directory: Bool = false
    var package: Bool = false
    /// Regular file with an execute permission bit.
    var executable: Bool = false
    /// Finder alias (bookmark) file.
    var alias: Bool = false
    /// Realpath of the alias target, when it resolves.
    var aliasTarget: String? = nil
    /// Content type identifier followed by every type it conforms to.
    var types: [String] = []
}

let iCloudDriveRelative = "Library/Mobile Documents/com~apple~CloudDocs"
let iCloudDriveName = "iCloud Drive"

func normalizedHome(_ home: String) -> String {
    var value = home
    while value.count > 1 && value.hasSuffix("/") { value.removeLast() }
    return value
}

/// "~" for the home folder itself, "~/..." inside it, nil outside.
func homeRelative(_ path: String, home: String) -> String? {
    let base = normalizedHome(home)
    guard !base.isEmpty, base != "/" else { return nil }
    if path == base { return "~" }
    guard path.hasPrefix(base + "/") else { return nil }
    let rest = String(path.dropFirst(base.count + 1))
    return rest.isEmpty ? "~" : "~/" + rest
}

// Names that commonly hold keys, tokens, password exports or password
// databases. Matched against every path component, case-insensitively.
func credentialLikeName(_ name: String) -> Bool {
    let lower = name.lowercased()
    if lower.hasPrefix(".env") || lower == ".netrc" { return true }
    // Default export names: Firefox (plaintext CSV) and a Bitcoin Core wallet.
    if ["logins.csv", "wallet.dat"].contains(lower) { return true }
    // Bitwarden's default plaintext and encrypted export names.
    for prefix in ["id_rsa", "id_ed25519", "id_ecdsa", "id_dsa", "bitwarden_export", "bitwarden_encrypted_export"] where lower.hasPrefix(prefix) { return true }
    for part in ["password", "passwd", "secret", ".keychain", "credentials"] where lower.contains(part) { return true }
    let ext = (lower as NSString).pathExtension
    return [
        // private keys and certificate bundles (p8: PEM-text keys such as AuthKey_*.p8)
        "pem", "key", "p8", "p12", "pfx", "pkcs12", "ppk", "jks", "keystore",
        // PGP keys and armored key exports
        "gpg", "pgp", "asc",
        // password databases and exports: KeePass, 1Password, Password Safe
        "kdbx", "kdb", "1pif", "1pux", "psafe3",
        // keychains and VPN profiles with embedded keys
        "keychain", "keychain-db", "ovpn",
    ].contains(ext)
}

let indexExcludedComponents: Set<String> = ["node_modules", ".git", ".trash"]

/// True when a real (symlink-free) path must never be indexed, shown or opened:
/// outside the home folder (including /Volumes), the home folder itself,
/// ~/Library (except the iCloud Drive subtree), hidden components, dependency
/// and VCS folders, the Trash and credential-like names.
func indexExcluded(realPath: String, home: String) -> Bool {
    guard let relative = homeRelative(realPath, home: home), relative != "~" else { return true }
    let components = relative.dropFirst(2).split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    guard !components.isEmpty else { return true }
    for component in components {
        if component.isEmpty || component == "." || component == ".." { return true }
        if component.hasPrefix(".") { return true }
        if indexExcludedComponents.contains(component.lowercased()) { return true }
        if credentialLikeName(component) { return true }
        if component.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f }) { return true }
    }
    if components[0] == "Library" {
        let cloud = iCloudDriveRelative.split(separator: "/").map(String.init)
        return !(components.count >= cloud.count && Array(components.prefix(cloud.count)) == cloud)
    }
    return false
}

// Opening any of these runs code, installs something or changes the system.
let fileRefusedExtensions: Set<String> = [
    // applications, bundles and plug-ins
    "app", "appex", "framework", "bundle", "plugin", "kext", "prefpane", "qlgenerator", "mdimporter", "xpc", "saver", "systemextension", "dext", "driver", "osax", "service", "wdgt",
    // scripts
    "sh", "command", "tool", "zsh", "bash", "csh", "tcsh", "ksh", "fish", "py", "pyc", "pyw", "rb", "pl", "pm", "php", "js", "mjs", "cjs", "jxa", "lua", "tcl", "ps1", "bat", "cmd", "vbs", "jar", "exe", "msi", "com",
    // installers and disk images
    "pkg", "mpkg", "dmg", "iso", "img", "sparseimage", "sparsebundle", "toast", "cdr",
    // workflows, automation and launchers (term: Terminal runs a session's command)
    "workflow", "wflow", "scpt", "scptd", "applescript", "shortcut", "terminal", "term", "action",
    // Apple's LSRiskCategoryUnsafeExecutable extensions (CoreTypes.bundle), plus
    // the extensions of its unsafe types for files whose type is not known
    "nib", "help", "trace", "tracetemplate", "x11app", "inputplugin", "ibplugin", "menu", "cin", "gcx", "icp", "ipg",
    "webarchive", "class", "jnlp", "qtz",
    // internet locations and stored URLs: opening one hands its URL to a handler
    "fileloc", "inetloc", "webloc", "url", "afploc", "ftploc", "mailloc", "newsloc", "vncloc", "atloc", "nslloc",
    // configuration profiles, extensions and libraries that switch app data
    "mobileconfig", "configprofile", "provisionprofile", "safariextz", "crx", "xpi", "photoslibrary", "musiclibrary", "tvlibrary",
]

// Uniform types whose conformance marks executable or installable content.
let fileRefusedTypes: Set<String> = [
    "public.executable", "public.unix-executable", "com.apple.application", "com.apple.application-bundle", "com.apple.application-file",
    "com.apple.bundle", "com.apple.plugin", "com.apple.framework", "com.apple.app-extension",
    "public.script", "public.shell-script", "com.apple.applescript.script", "com.apple.applescript.text", "com.apple.applescript.script-bundle",
    "com.apple.installer-package-archive", "com.apple.installer-package", "public.disk-image", "com.apple.disk-image", "com.apple.disk-image-udif",
    "com.apple.automator-workflow", "com.apple.shortcuts.workflow-file", "com.apple.terminal.shell-script", "com.microsoft.windows-executable", "com.sun.java-archive",
    "com.apple.mobileconfig", "com.apple.systempreference.prefpane", "com.apple.dt.document.workspace.shortcut", "com.apple.shortcut",
    // Apple's LSRiskCategoryUnsafeExecutable content types (CoreTypes.bundle)
    "com.apple.terminal.session", "com.apple.terminal.settings", "com.apple.webarchive", "com.apple.mach-o-binary",
    "com.apple.interfacebuilder.document", "com.sun.java-class", "com.sun.java-web-start", "com.apple.quartz-composer-composition", "com.apple.itunes.ipg",
    // every internet location and stored URL, whatever its extension or OSType
    "com.apple.internet-location", "public.stored-url", "com.microsoft.internet-shortcut",
]

/// True when one content type identifier marks refused content. Location
/// subtypes are also matched by name, for type trees that omit their parents.
func fileTypeRefused(_ identifier: String) -> Bool {
    let lower = identifier.lowercased()
    return fileRefusedTypes.contains(lower) || lower.hasSuffix("-internet-location")
}

// Document packages (directories presented as one document) that may be opened.
let documentPackageExtensions: Set<String> = ["rtfd", "pages", "numbers", "key", "graffle", "band", "scriv", "sketch", "pxm", "textbundle"]

/// True when the item at realPath must not be opened, whatever app would handle it.
func fileOpenRefused(realPath: String, facts: FileFacts) -> Bool {
    let name = (realPath as NSString).lastPathComponent
    let ext = (name as NSString).pathExtension.lowercased()
    if fileRefusedExtensions.contains(ext) { return true }
    if facts.types.contains(where: fileTypeRefused) { return true }
    // Launch agents and daemons wherever they are stored.
    if ext == "plist" && realPath.split(separator: "/").contains(where: { ["launchagents", "launchdaemons"].contains($0.lowercased()) }) { return true }
    // Regular files with an execute bit and no extension open in Terminal.
    if !facts.directory && facts.executable && ext.isEmpty { return true }
    // Bundles other than known document packages run or install code.
    if facts.directory && facts.package && !documentPackageExtensions.contains(ext) { return true }
    return false
}

func fileKind(_ facts: FileFacts) -> FileKind {
    facts.directory && !facts.package ? .folder : .document
}

/// Lexically valid "~/..." request: no empty, "." or ".." components, no
/// control characters, bounded length.
func openPathSyntaxValid(_ requested: String) -> Bool {
    guard requested.hasPrefix("~/"), requested.count >= 3, requested.utf16.count <= 500 else { return false }
    if requested.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f }) { return false }
    let components = requested.dropFirst(2).split(separator: "/", omittingEmptySubsequences: false)
    // A single trailing slash ("~/Documents/") is tolerated.
    let trimmed = components.last == "" && components.count > 1 ? Array(components.dropLast()) : Array(components)
    return !trimmed.isEmpty && !trimmed.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." })
}

/// Resolves a model-supplied "~/..." path to one existing, permitted document
/// or folder inside the home folder. Traversal and excluded or refused items
/// are refused; paths that do not exist (or cannot be inspected) are unresolved.
func resolveOpenPath(_ requested: String, home: String, realpath: (String) -> String?, inspect: (String) -> FileFacts?) -> FileResolution {
    let base = normalizedHome(home)
    guard !base.isEmpty, base != "/" else { return .unresolved }
    guard openPathSyntaxValid(requested) else {
        let parts = requested.split(separator: "/", omittingEmptySubsequences: false)
        return parts.contains(where: { $0 == ".." }) || !requested.hasPrefix("~/") ? .refused : .unresolved
    }
    var rest = String(requested.dropFirst(2))
    if rest.hasSuffix("/") { rest.removeLast() }
    let lexical = base + "/" + rest
    // Excluded by name before touching the filesystem (e.g. ~/Library/Keychains).
    if indexExcluded(realPath: lexical, home: base) { return .refused }
    guard let real = realpath(lexical) else { return .unresolved }
    let realHome = realpath(base) ?? base
    // Symlinks may not lead outside the home folder or into excluded places.
    guard !indexExcluded(realPath: real, home: realHome) else { return .refused }
    guard let facts = inspect(real) else { return .unresolved }
    if fileOpenRefused(realPath: real, facts: facts) { return .refused }
    var opens = real, kind = fileKind(facts)
    if facts.alias {
        // An alias opens its target: the target must pass every rule itself,
        // and the target (not the alias file) is what is opened.
        guard let target = facts.aliasTarget else { return .unresolved }
        guard !indexExcluded(realPath: target, home: realHome), let targetFacts = inspect(target) else { return .refused }
        if targetFacts.alias || fileOpenRefused(realPath: target, facts: targetFacts) { return .refused }
        opens = target; kind = fileKind(targetFacts)
    }
    guard let path = homeRelative(real, home: realHome) else { return .refused }
    return .resolved(path: path, real: real, kind: kind, opens: opens)
}

// Document handlers that import configuration or automation, or connect to a
// remote machine, as soon as they open a file, even though open_app may
// launch them on their own.
let fileHandlerDeniedIds: Set<String> = ["com.apple.systempreferences", "com.apple.mcx.profilehelper", "com.apple.shortcuts", "com.apple.screensharing"]
let finderBundleId = "com.apple.finder"

/// True when the default application for an item must not open it. handler is
/// nil when LaunchServices has no default application, or when that
/// application is not a foreground native application open_app could launch
/// (script applets, background or menu-bar-only helpers, script wrappers).
/// Folders open only in Finder; any handler open_app denies or protects is
/// refused, so a document never becomes a way into a refused application.
func fileHandlerRefused(kind: FileKind, handler: LaunchCandidate?, protectedApps: [String]) -> Bool {
    guard let handler = handler else { return true }
    let id = handler.bundleId.lowercased()
    if kind == .folder && id != finderBundleId { return true }
    if fileHandlerDeniedIds.contains(id) { return true }
    return launchCandidateDenied(handler, protectedApps: protectedApps)
}

/// Display name for a resolved item (iCloud Drive's root has a friendly name).
func openFileDisplayName(_ path: String) -> String {
    if path == "~/" + iCloudDriveRelative { return iCloudDriveName }
    return String((path as NSString).lastPathComponent.prefix(120))
}

// MARK: - System index helpers

let indexStopwords: Set<String> = ["the", "a", "an", "and", "or", "of", "to", "in", "on", "at", "for", "from", "with", "my", "me", "please", "open", "show", "find", "file", "files", "folder", "folders", "document", "documents", "up", "it", "this", "that", "is", "can", "you", "go", "get", "launch", "start", "app", "application"]
// URL and host fragments. As name substrings they match thousands of items
// ("*com*" runs a Spotlight query to its timeout) and never name a file.
let indexURLFragments: Set<String> = ["http", "https", "www", "com", "org", "net", "io", "co", "html", "htm"]

/// Letter and digit runs of one whitespace-separated word. In each "/", "?" or
/// "#" separated segment of a dotted name ("github.com", "news.bbc.co.uk",
/// "report.pdf") the final label is a top-level domain or a file extension,
/// not part of a name, and is dropped when it contains a letter.
private func indexWordTokens(_ word: Substring) -> [String] {
    var tokens = [String]()
    for segment in word.split(whereSeparator: { "/?#\\".contains($0) }) {
        var parts = segment.split(whereSeparator: { !($0.isLetter || $0.isNumber) }).map(String.init)
        let labels = segment.split(separator: ".").map { String($0.filter { $0.isLetter || $0.isNumber }) }.filter { !$0.isEmpty }
        if labels.count >= 2, let last = labels.last, last.count <= 10, last.contains(where: { $0.isLetter }), parts.last == last { parts.removeLast() }
        tokens += parts
    }
    return tokens
}

/// The longest (at most 3) distinct query tokens: letters and digits only, at
/// least 2 characters, stopwords, URL fragments, top-level domains and file
/// extensions removed. Safe to embed in a Spotlight query.
func indexQueryTokens(_ query: String) -> [String] {
    var seen = Set<String>(), tokens = [String]()
    for word in query.lowercased().split(whereSeparator: { $0.isWhitespace }) {
        for raw in indexWordTokens(word) {
            let token = String(raw.prefix(64))
            guard token.count >= 2, !indexStopwords.contains(token), !indexURLFragments.contains(token), seen.insert(token).inserted else { continue }
            tokens.append(token)
        }
    }
    let ordered = tokens.enumerated().sorted { $0.element.count != $1.element.count ? $0.element.count > $1.element.count : $0.offset < $1.offset }
    return ordered.prefix(3).map { $0.element }
}

/// Spotlight query string matching display names containing any token.
func indexMatchQuery(_ tokens: [String]) -> String {
    tokens.map { "kMDItemDisplayName == \"*\($0)*\"cdw" }.joined(separator: " || ")
}

func indexLimit(_ value: Any?) -> Int {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite else { return 10 }
    return max(1, min(20, number.intValue))
}

struct IndexItem: Equatable {
    let path: String      // absolute path from Spotlight
    let types: [String]   // kMDItemContentTypeTree
    let lastUsed: Date?
}

/// Filters Spotlight results to permitted documents and folders, shown
/// home-relative. Spotlight paths are canonical, so rules apply lexically.
func indexEntries(_ items: [IndexItem], home: String, limit: Int) -> [(name: String, path: String, kind: FileKind, lastUsed: Date?)] {
    var seen = Set<String>(), result = [(name: String, path: String, kind: FileKind, lastUsed: Date?)]()
    for item in items where result.count < limit {
        guard !indexExcluded(realPath: item.path, home: home), let relative = homeRelative(item.path, home: home), relative.utf16.count <= 500,
              seen.insert(relative).inserted else { continue }
        let lowered = Set(item.types.map { $0.lowercased() })
        let directory = lowered.contains("public.folder") || lowered.contains("public.directory")
        let package = lowered.contains("com.apple.package")
        let facts = FileFacts(directory: directory, package: package, types: item.types)
        guard !lowered.contains("com.apple.alias-file"), !lowered.contains("public.symlink"), !fileOpenRefused(realPath: item.path, facts: facts) else { continue }
        result.append((openFileDisplayName(relative), relative, fileKind(facts), item.lastUsed))
    }
    return result
}

/// Ranks name matches: more matched tokens first, then most recently used.
func rankIndexMatches(_ items: [IndexItem], tokens: [String]) -> [IndexItem] {
    func score(_ item: IndexItem) -> Int {
        let name = (item.path as NSString).lastPathComponent.lowercased()
        return tokens.filter { name.contains($0) }.count
    }
    return items.enumerated().sorted { a, b in
        let sa = score(a.element), sb = score(b.element)
        if sa != sb { return sa > sb }
        let da = a.element.lastUsed ?? .distantPast, db = b.element.lastUsed ?? .distantPast
        if da != db { return da > db }
        return a.offset < b.offset
    }.map { $0.element }
}

/// Standard folders, in display order, relative to the home folder.
let indexStandardFolders: [(name: String, relative: String)] = [
    ("Desktop", "Desktop"), ("Documents", "Documents"), ("Downloads", "Downloads"), (iCloudDriveName, iCloudDriveRelative),
    ("Pictures", "Pictures"), ("Music", "Music"), ("Movies", "Movies"),
    ("Projects", "Projects"), ("Developer", "Developer"), ("code", "code"), ("src", "src"), ("work", "work"),
]
