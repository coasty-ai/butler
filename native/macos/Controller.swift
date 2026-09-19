import Foundation
import AppKit
import ScreenCaptureKit
import Vision
import CryptoKit
import Carbon
import UniformTypeIdentifiers
import CoreServices
import IOKit.pwr_mgt

let outputLock = NSLock()
let stateLock = NSLock()
var stopped = true
var lastPointerPosition: CGPoint?
var pointerGraceUntil: TimeInterval = 0
var lastInputTime: TimeInterval = 0
var forwardedSpotlightDeadline: TimeInterval = 0
var tap: CFMachPort?
var currentFrame: [String: Any]?
var rememberedPID:pid_t?
let inputMarker:Int64 = 0x4f50454e41535354
var recentWindows = [[String:String]]()
var recentFiles = [String]()
var protectedApps = ["com.1password", "com.apple.Passwords", "com.apple.keychainaccess", "com.bitwarden", "com.apple.Terminal", "com.googlecode.iterm2"]
var protectedDomains = ["paypal.com", "chase.com", "bankofamerica.com", "mychart.com", "login.gov"]
var displayID = CGMainDisplayID()
// Synthetic buttons and keys pressed and not yet released (guarded by stateLock).
var heldInput = HeldInput()
// The user's own input episode for idle reporting (guarded by idleLock, which
// is never held together with stateLock).
let idleLock = NSLock()
var manualInputEpisode = ManualInputEpisode()
var idleTimer: DispatchSourceTimer?
// When the emergency-stop tap was installed and when it last saw the user's
// own input, for the presence probe (guarded by idleLock, monotonic seconds).
var tapInstalledAt: TimeInterval?
var lastManualInputAt: TimeInterval?
// Processes AXManualAccessibility was already set on (guarded by stateLock).
var manualAccessibilityAttempts = ManualAccessibilityAttempts()
// The windows bound for detached watches, by token (guarded by stateLock):
// probes name a window by its token alone, and each watch releases only its
// own. While `watching`, one Escape is the user's own key and two within
// 0.8 s are the emergency stop (emergencyEscape in IdeSafety.swift).
var watchBindings = [String: WatchBinding]()
var watching = false
var lastEscapeAt: TimeInterval?
func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
    outputLock.lock(); FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10])); outputLock.unlock()
}
func latch(_ value: Bool) {
    let point = value ? nil : CGEvent(source:nil)?.location
    stateLock.lock(); stopped = value
    if !value { lastPointerPosition = point; pointerGraceUntil = ProcessInfo.processInfo.systemUptime + 0.75; searchCommand = nil }
    stateLock.unlock()
}
func withState<T>(_ body: () -> T) -> T { stateLock.lock(); defer { stateLock.unlock() }; return body() }
func setCurrentFrame(_ value: [String:Any]) { stateLock.lock(); currentFrame = value; stateLock.unlock() }
func getCurrentFrame() -> [String:Any]? { stateLock.lock(); defer {stateLock.unlock()}; return currentFrame }
func isStopped() -> Bool { stateLock.lock(); defer { stateLock.unlock() }; return stopped }
func inputSettleRemaining() -> TimeInterval { stateLock.lock(); defer {stateLock.unlock()}; return lastInputTime + 0.25 - ProcessInfo.processInfo.systemUptime }
struct ControlError: Error { let message: String; let code: String?; let change: String?; init(_ message: String, code: String? = nil, change: String? = nil) { self.message = message; self.code = code; self.change = change } }
// The reason travels as its fixed code too (FrameSafety.swift), so the trace can say what moved.
func changedScreen(_ reason: String) -> ControlError { ControlError(reason, code: "STATE_CHANGED", change: screenChangeCode(reason)) }
func ensureRunning() throws { if isStopped() { throw ControlError("Native input stopped. Explicitly resume to continue.", code: "STOPPED") } }
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? { var value: CFTypeRef?; if AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success { return value }; return nil }
func elementRect(_ element: AXUIElement) -> CGRect? {
    guard let position = attribute(element, kAXPositionAttribute), CFGetTypeID(position) == AXValueGetTypeID(),
          let size = attribute(element, kAXSizeAttribute), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero, extent = CGSize.zero
    guard AXValueGetValue(position as! AXValue, .cgPoint, &point), AXValueGetValue(size as! AXValue, .cgSize, &extent) else { return nil }
    return CGRect(origin: point, size: extent)
}
func controlLabel(_ element:AXUIElement) -> String {
    for name in [kAXTitleAttribute,kAXDescriptionAttribute,kAXValueAttribute] {if let value=attribute(element,name) as? String,!value.isEmpty{return value}}
    return ""
}
func controlSignature(_ element:AXUIElement) -> String {
    let fields=[kAXRoleAttribute,kAXSubroleAttribute,kAXValueAttribute,kAXEnabledAttribute,"AXURL"].map {String(describing:attribute(element,$0) ?? "" as CFString)}
    return SHA256.hash(data:Data((fields + [controlLabel(element),String(describing:elementRect(element))]).joined(separator:"\u{0}").utf8)).map{String(format:"%02x",$0)}.joined()
}
func focusSignature(_ element:AXUIElement) -> String {
    var selection=""
    if let value=attribute(element,kAXSelectedTextRangeAttribute),CFGetTypeID(value) == AXValueGetTypeID() {
        var range=CFRange();if AXValueGetValue(value as! AXValue,.cfRange,&range){selection="\(range.location):\(range.length)"}
    }
    return controlSignature(element) + ":" + selection
}
func browserAddressField(_ element:AXUIElement, appId:String) -> Bool {
    guard browserAppIDs.contains(appId), ["AXTextField","AXComboBox"].contains(attribute(element,kAXRoleAttribute) as? String ?? "") else{return false}
    let label=controlLabel(element).lowercased(), identifier=(attribute(element,"AXIdentifier") as? String ?? "").lowercased()
    guard identifier == "omnibox" || ["address and search bar","search or enter website name","search or enter address"].contains(label) else{return false}
    var parent=attribute(element,kAXParentAttribute).map{$0 as! AXUIElement};var toolbar=false
    for _ in 0..<16 {
        guard let node=parent else{break};let role=attribute(node,kAXRoleAttribute) as? String ?? ""
        if role == "AXWebArea" {return false};if role == "AXToolbar" {toolbar=true};if role == "AXWindow" {return toolbar}
        parent=attribute(node,kAXParentAttribute).map{$0 as! AXUIElement}
    }
    return false
}
struct TrackedControl { let element: AXUIElement; let bounds: CGRect; let signature:String; var role:String = ""; var name:String = ""; var enabled:Bool = true }
// Names shown to the model for grounding. Editable fields expose their title,
// description or placeholder, never their contents.
func modelControlName(_ element:AXUIElement, role:String) -> String {
    let editable = ["AXTextField","AXTextArea","AXComboBox"].contains(role)
    let names = editable ? [kAXTitleAttribute,kAXDescriptionAttribute,"AXPlaceholderValue"] : [kAXTitleAttribute,kAXDescriptionAttribute,kAXValueAttribute]
    for name in names { if let value = attribute(element,name) as? String, !value.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty { return utf16Prefix(value, 80) } }
    return ""
}
// Visible controls of the focused window with their centers as screenshot
// fractions, so the model can click a listed control exactly instead of
// estimating pixel positions. Reuses the controls already walked for safety.
// Interactive elements inside the visible part of a browser's web area, found
// breadth-first with node and time budgets so capture latency stays bounded.
// Names only (modelControlName never returns field contents).
func webControls(_ window: AXUIElement, display: CGRect, limit: Int = 45) -> [[String:Any]] {
    let started = ProcessInfo.processInfo.systemUptime
    let interactive: Set<String> = ["AXLink","AXButton","AXTextField","AXTextArea","AXComboBox","AXCheckBox","AXRadioButton","AXPopUpButton","AXMenuButton","AXTab"]
    let visible = (elementRect(window) ?? display).intersection(display)
    var queue: [(AXUIElement, Int)] = [(window, 0)], index = 0, result = [[String:Any]]()
    while index < queue.count && index < 2500 && result.count < limit {
        if ProcessInfo.processInfo.systemUptime - started > 0.25 { break }
        let (node, depth) = queue[index]; index += 1
        let role = attribute(node, kAXRoleAttribute) as? String ?? ""
        if attribute(node, kAXSubroleAttribute) as? String == kAXSecureTextFieldSubrole { continue }
        let rect = elementRect(node)
        // Skip subtrees that are scrolled out of view.
        if let rect = rect, depth > 2, rect.width > 0, rect.height > 0, !rect.intersects(visible) { continue }
        if interactive.contains(role), let rect = rect, rect.width >= 2, rect.height >= 2, visible.contains(CGPoint(x: rect.midX, y: rect.midY)) {
            let name = modelControlName(node, role: role)
            if !name.isEmpty || ["AXTextField","AXTextArea","AXComboBox"].contains(role) {
                var item: [String:Any] = ["role": String(role.dropFirst(2)).lowercased(),
                    "x": (Double(rect.midX - display.minX) / Double(display.width) * 1000).rounded() / 1000,
                    "y": (Double(rect.midY - display.minY) / Double(display.height) * 1000).rounded() / 1000]
                if !name.isEmpty { item["label"] = name }
                if attribute(node, kAXEnabledAttribute) as? Bool == false { item["enabled"] = false }
                result.append(item)
            }
        }
        guard depth < 40 else { continue }
        let children = (attribute(node, "AXVisibleChildren") ?? attribute(node, kAXChildrenAttribute)) as? [AXUIElement] ?? []
        for child in children.prefix(60) { queue.append((child, depth + 1)) }
    }
    return result
}
/**
 The text a person can read in a browser page right now, in reading order.
 Web pages nest their text far deeper than the generic window walk goes, so a
 research task used to see only the title and had to guess from pixels. Depth
 first so the order is the page's own, pruned to the visible part of the
 window, bounded in nodes, characters and time, and never reading a secure
 field.
 */
func webVisibleText(_ window: AXUIElement, display: CGRect, limit: Int = 4200) -> String {
    let started = ProcessInfo.processInfo.systemUptime
    let visible = (elementRect(window) ?? display).intersection(display)
    var parts = [String](), characters = 0, nodes = 0
    func visit(_ node: AXUIElement, _ depth: Int) {
        guard depth < 60, nodes < 4000, characters < limit,
              ProcessInfo.processInfo.systemUptime - started < 0.3 else { return }
        nodes += 1
        if attribute(node, kAXSubroleAttribute) as? String == kAXSecureTextFieldSubrole { return }
        if depth > 2, let rect = elementRect(node), rect.width > 0, rect.height > 0, !rect.intersects(visible) { return }
        if attribute(node, kAXRoleAttribute) as? String == "AXStaticText",
           let value = attribute(node, kAXValueAttribute) as? String {
            let text = value.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
            if !text.isEmpty {
                let bounded = String(text.prefix(min(600, limit - characters)))
                parts.append(bounded); characters += bounded.count + 1
            }
            return
        }
        let children = (attribute(node, "AXVisibleChildren") ?? attribute(node, kAXChildrenAttribute)) as? [AXUIElement] ?? []
        for child in children.prefix(200) { visit(child, depth + 1) }
    }
    visit(window, 0)
    return parts.joined(separator: "\n")
}
/**
 Text read from the screenshot itself, inside the frontmost window, top to
 bottom. Applications that publish no text to accessibility (Spotify, canvas
 apps, Chrome while its page tree is switched off) still show it on screen, and
 a model reads text far more reliably than it reads pixels. On-device (Vision,
 about a quarter of a second on Apple silicon once warm), so it only runs when
 accessibility produced little text; nothing leaves the Mac that the
 screenshot itself did not already carry.
 */
func recognizeScreenText(_ image: CGImage, window: CGRect?, display: CGRect, limit: Int = 3000) -> String {
    let request = VNRecognizeTextRequest()
    // Accurate without language correction: clean text at about a quarter of
    // a second once warm; fast mode garbles small UI text at 1x.
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    request.minimumTextHeight = 0.01
    if let window, display.width > 0, display.height > 0 {
        let area = window.intersection(display)
        if area.width > 40, area.height > 40 {
            // Vision's region is normalized with the origin at the bottom left.
            request.regionOfInterest = CGRect(x: (area.minX - display.minX) / display.width,
                                              y: 1 - (area.maxY - display.minY) / display.height,
                                              width: area.width / display.width,
                                              height: area.height / display.height)
        }
    }
    guard (try? VNImageRequestHandler(cgImage: image).perform([request])) != nil else { return "" }
    let observations = (request.results ?? []).sorted {
        abs($0.boundingBox.midY - $1.boundingBox.midY) > 0.008 ? $0.boundingBox.midY > $1.boundingBox.midY : $0.boundingBox.minX < $1.boundingBox.minX
    }
    var lines = [String](), characters = 0
    for observation in observations {
        guard let text = observation.topCandidates(1).first?.string.trimmingCharacters(in: .whitespaces), !text.isEmpty else { continue }
        if characters + text.count > limit { break }
        lines.append(text); characters += text.count + 1
    }
    return lines.joined(separator: "\n")
}
func mergeControls(_ first: [[String:Any]], _ second: [[String:Any]], limit: Int) -> [[String:Any]] {
    var seen = Set<String>(), merged = [[String:Any]]()
    for item in first + second where merged.count < limit {
        let key = "\(item["role"] ?? "")|\(item["x"] ?? "")|\(item["y"] ?? "")"
        if seen.insert(key).inserted { merged.append(item) }
    }
    return merged
}
func groundedControls(_ state: WindowState, display: CGRect, limit: Int = 60) -> [[String:Any]] {
    var result = [[String:Any]]()
    for control in state.tracked where result.count < limit {
        let b = control.bounds
        guard b.width >= 2, b.height >= 2, display.width > 0, display.height > 0 else { continue }
        let center = CGPoint(x: b.midX, y: b.midY)
        guard display.contains(center) else { continue }
        var item: [String:Any] = ["role": String(control.role.dropFirst(control.role.hasPrefix("AX") ? 2 : 0)).lowercased(),
                                  "x": (Double(center.x - display.minX) / Double(display.width) * 1000).rounded() / 1000,
                                  "y": (Double(center.y - display.minY) / Double(display.height) * 1000).rounded() / 1000]
        if !control.name.isEmpty { item["label"] = control.name }
        if !control.enabled { item["enabled"] = false }
        result.append(item)
    }
    return result
}
struct WindowState {
    let pid: pid_t
    let appId: String
    let window: AXUIElement?
    let bounds: CGRect?
    let document: String
    let focused: AXUIElement?
    let focusedValue: String
    let focusedSignature: String
    let addressBar: Bool
    let controls: String
    let tracked: [TrackedControl]
}
func spotlightState(_ app: AXUIElement) -> [String:String] {
    let focus = attribute(app,kAXFocusedUIElementAttribute).map {$0 as! AXUIElement}
    var result = ["query":String((focus.flatMap {attribute($0,kAXValueAttribute) as? String} ?? "").prefix(300))]
    var visited = 0
    func text(_ node:AXUIElement,_ depth:Int) -> String? {
        guard depth < 4 else {return nil}
        if attribute(node,kAXRoleAttribute) as? String == "AXStaticText", let value=attribute(node,kAXValueAttribute) as? String,!value.isEmpty {return String(value.prefix(300))}
        for child in (attribute(node,kAXChildrenAttribute) as? [AXUIElement] ?? []).prefix(20) {if let value=text(child,depth+1){return value}}
        return nil
    }
    func visit(_ node:AXUIElement,_ depth:Int) {
        guard visited < 180,depth < 10,result["selectedResult"] == nil else{return};visited+=1
        if attribute(node,kAXRoleAttribute) as? String == "AXCell",attribute(node,kAXSelectedAttribute) as? Bool == true,let label=text(node,0) {result["selectedResult"]=label;return}
        for child in (attribute(node,kAXChildrenAttribute) as? [AXUIElement] ?? []).prefix(40) {visit(child,depth+1)}
    }
    if let window=attribute(app,kAXFocusedWindowAttribute) {visit(window as! AXUIElement,0)}
    return result
}
// Spotlight's nonactivating search panel owns keyboard focus without becoming
// NSWorkspace.frontmostApplication. Require both a visible panel and AX focus.
func inputApplication() -> NSRunningApplication? {
    if let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]] {
        for info in windows {
            guard let pid = info[kCGWindowOwnerPID as String] as? Int,
                  let app = NSRunningApplication(processIdentifier:pid_t(pid)), app.bundleIdentifier == "com.apple.Spotlight",
                  let raw = info[kCGWindowBounds as String] as? [String:Any], let rect = CGRect(dictionaryRepresentation:raw as CFDictionary), rect.width > 100, rect.height > 30,
                  let focused = attribute(AXUIElementCreateApplication(app.processIdentifier),kAXFocusedUIElementAttribute), CFGetTypeID(focused) == AXUIElementGetTypeID(),
                  attribute(focused as! AXUIElement,kAXRoleAttribute) as? String == "AXTextField" else {continue}
            return app
        }
    }
    return NSWorkspace.shared.frontmostApplication
}
// How many windows an application shows (standardWindowCount decides which
// count). The window server's list needs no accessibility call, so a hung
// application cannot stall it.
func onScreenWindowCount(_ pid: pid_t, list: [[String:Any]]? = nil) -> Int {
    let windows = list ?? (CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]] ?? [])
    return standardWindowCount(windows.compactMap { info in
        guard let owner = info[kCGWindowOwnerPID as String] as? Int, let raw = info[kCGWindowBounds as String] as? [String:Any],
              let rect = CGRect(dictionaryRepresentation: raw as CFDictionary) else { return nil }
        return OnScreenWindow(pid: owner, layer: info[kCGWindowLayer as String] as? Int ?? -1, alpha: info[kCGWindowAlpha as String] as? Double ?? 1,
                              width: Double(rect.width), height: Double(rect.height))
    }, pid: Int(pid))
}
func windowState() -> WindowState {
    let running = inputApplication()
    let pid = running?.processIdentifier ?? 0
    let app = AXUIElementCreateApplication(pid)
    let window = attribute(app, kAXFocusedWindowAttribute).map { $0 as! AXUIElement }
    let focused = attribute(app, kAXFocusedUIElementAttribute).map { $0 as! AXUIElement }
    var controls = [String](), tracked = [TrackedControl](), visited = 0
    func visit(_ node: AXUIElement, _ depth: Int) {
        guard visited < 400, depth < 12 else { return }; visited += 1
        if attribute(node, "AXHidden") as? Bool == true { return }
        let role = attribute(node, kAXRoleAttribute) as? String ?? ""
        if ["AXTextField", "AXTextArea", "AXComboBox", "AXButton", "AXLink", "AXCheckBox", "AXRadioButton", "AXPopUpButton"].contains(role) {
            let secure = attribute(node, kAXSubroleAttribute) as? String == kAXSecureTextFieldSubrole
            let value = secure ? "secure" : String(describing: attribute(node, kAXValueAttribute) ?? "" as CFString)
            let label = controlLabel(node)
            let valueDigest = SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
            controls.append([role, label, valueDigest, String(describing: elementRect(node)), String(describing: attribute(node, kAXEnabledAttribute))].joined(separator: "\u{0}"))
            if !secure, (!label.isEmpty || ["AXTextField", "AXTextArea", "AXComboBox"].contains(role)), let bounds = elementRect(node), !bounds.isNull, !bounds.isInfinite {
                tracked.append(TrackedControl(element: node, bounds: bounds,signature:controlSignature(node),role:role,name:modelControlName(node, role:role),enabled:attribute(node, kAXEnabledAttribute) as? Bool ?? true))
            }
        }
        let children = (attribute(node, "AXVisibleChildren") ?? attribute(node, kAXChildrenAttribute)) as? [AXUIElement] ?? []
        for child in children.prefix(100) { visit(child, depth + 1) }
    }
    if let window = window { visit(window, 0) }
    if running?.bundleIdentifier == "com.apple.Spotlight" {controls.append("Spotlight selection:" + (spotlightState(app)["selectedResult"] ?? ""))}
    return WindowState(pid: pid, appId: running?.bundleIdentifier ?? "", window: window, bounds: window.flatMap(elementRect),
        document: window.map { String(describing: attribute($0, "AXDocument") ?? attribute($0, "AXURL") ?? "" as CFString) } ?? "",
        focused: focused, focusedValue: focused.map { String(describing: attribute($0, kAXValueAttribute) ?? "" as CFString) } ?? "",
        focusedSignature:focused.map(focusSignature) ?? "",addressBar:focused.map{browserAddressField($0,appId:running?.bundleIdentifier ?? "")} ?? false,
        controls: SHA256.hash(data: Data(controls.joined(separator: "\u{1}").utf8)).map { String(format: "%02x", $0) }.joined(), tracked: tracked)
}
func sameElement(_ a: AXUIElement?, _ b: AXUIElement?) -> Bool {
    if let a = a, let b = b { return CFEqual(a, b) }; return a == nil && b == nil
}
func sameWindow(_ a: WindowState, _ b: WindowState, ignoringBounds: Bool = false) -> Bool {
    a.pid == b.pid && sameElement(a.window, b.window) && (ignoringBounds || a.bounds == b.bounds) && a.document == b.document
}
// Spotlight's panel grows as results populate, a keyboard step targets the
// verified focused element rather than a screen position, and a named menu
// item or control is resolved again at the moment of input, so none of them
// depends on exact window bounds. Pointer input keeps the exact comparison.
func boundsIndependent(_ action: [String:Any]?, _ a: WindowState, _ b: WindowState) -> Bool {
    if let type = action?["type"] as? String { return ["key", "hotkey", "type_text", "menu_item", "click_control"].contains(type) }
    return a.appId == "com.apple.Spotlight" && b.appId == "com.apple.Spotlight"
}
func sameWindow(_ a: WindowState, _ b: WindowState, for action: [String:Any]?) -> Bool {
    sameWindow(a, b, ignoringBounds: boundsIndependent(action, a, b))
}
// Two samples describe the same observable input context.
func stableWindow(_ a: WindowState, _ b: WindowState) -> Bool {
    sameWindow(a, b, for: nil) && a.controls == b.controls && sameElement(a.focused, b.focused) && a.focusedSignature == b.focusedSignature
}
func hitMatches(_ expected: AXUIElement, at point: CGPoint) -> Bool {
    var hit: AXUIElement?
    guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &hit) == .success else { return false }
    for _ in 0..<8 {
        guard let current = hit else { return false }
        if CFEqual(expected, current) { return true }
        hit = attribute(current, kAXParentAttribute).map { $0 as! AXUIElement }
    }
    return false
}
// Breadth-first, bounded search for the first web area's URL host.
func webAreaHost(_ window: AXUIElement) -> String? {
    let started = ProcessInfo.processInfo.systemUptime
    var queue: [(AXUIElement, Int)] = [(window, 0)], index = 0
    while index < queue.count && index < 1500 && ProcessInfo.processInfo.systemUptime - started < 0.12 {
        let (node, depth) = queue[index]; index += 1
        let role = attribute(node, kAXRoleAttribute) as? String ?? ""
        if role == "AXWebArea" {
            let url = attribute(node, "AXURL")
            let host = (url as? URL)?.host ?? (url as? String).flatMap { URL(string: $0)?.host }
            // A hostless area (Web Inspector, blank tab) is not the page; keep looking.
            if let host = host, !host.isEmpty { return host.lowercased() }
            continue
        }
        // Tab bars and toolbars can hold many nodes and never contain the page.
        guard depth < 12, !["AXToolbar", "AXTabGroup"].contains(role) else { continue }
        for child in (attribute(node, kAXChildrenAttribute) as? [AXUIElement] ?? []).prefix(40) { queue.append((child, depth + 1)) }
    }
    return nil
}
// Host of the web page that contains an element (nearest AXWebArea ancestor).
func enclosingWebHost(_ element: AXUIElement) -> String? {
    var node: AXUIElement? = element
    for _ in 0..<40 {
        guard let current = node else { return nil }
        if attribute(current, kAXRoleAttribute) as? String == "AXWebArea" {
            let url = attribute(current, "AXURL")
            return ((url as? URL)?.host ?? (url as? String).flatMap { URL(string: $0)?.host })?.lowercased()
        }
        node = attribute(current, kAXParentAttribute).map { $0 as! AXUIElement }
    }
    return nil
}
// True when a sheet, dialog or alert is part of the focused window or contains
// the element: keypad-style shortcuts must not confirm those.
func modalContext(window: AXUIElement?, element: AXUIElement?) -> Bool {
    if let window = window {
        let subrole = attribute(window, kAXSubroleAttribute) as? String ?? ""
        if ["AXDialog", "AXSystemDialog"].contains(subrole) { return true }
        if (attribute(window, kAXChildrenAttribute) as? [AXUIElement] ?? []).contains(where: { attribute($0, kAXRoleAttribute) as? String == "AXSheet" }) { return true }
    }
    var node = element
    for _ in 0..<30 {
        guard let current = node else { break }
        if ["AXSheet"].contains(attribute(current, kAXRoleAttribute) as? String ?? "") { return true }
        node = attribute(current, kAXParentAttribute).map { $0 as! AXUIElement }
    }
    return false
}
// Electron apps (Slack, Discord, Notion) publish their web content
// accessibility tree only once an assistive client asks for it, which grounded
// controls and focused-field checks need. AXManualAccessibility is Electron's
// documented switch. AXEnhancedUserInterface (VoiceOver's, also the only hook
// CEF documents) breaks window managers and animations and is never set.
// Once per process, from the surface path (capture reaches it through
// guardSurface), never from the event tap; bounded by a short messaging
// timeout, errors ignored (native and CEF apps reject the attribute).
func exposeAccessibilityTree(_ app: NSRunningApplication) {
    let pid = app.processIdentifier
    guard AXIsProcessTrusted(),
          manualAccessibilityEligible(pid: pid, bundleId: app.bundleIdentifier ?? "", ownPid: getpid(), parentPid: getppid(), protectedApps: protectedApps),
          withState({ manualAccessibilityAttempts.claim(pid: pid, launchedAt: app.launchDate?.timeIntervalSince1970) }) else { return }
    let element = AXUIElementCreateApplication(pid)
    _ = AXUIElementSetMessagingTimeout(element, 0.25)
    // Electron 23+ reports success and builds the tree asynchronously: give it a
    // moment, once, before this first observation walks it.
    if AXUIElementSetAttributeValue(element, "AXManualAccessibility" as CFString, kCFBooleanTrue) == .success {
        Thread.sleep(forTimeInterval: 0.25)
    }
}
// Anything inside a window the agent could target. A single one is enough to
// show the application publishes its interface, so the walk stops at the first.
let actionableWalkRoles: Set<String> = ["AXButton","AXLink","AXTextField","AXTextArea","AXComboBox","AXCheckBox","AXRadioButton","AXPopUpButton","AXMenuButton","AXTab","AXCell","AXRow","AXMenuItem","AXSlider","AXDisclosureTriangle","AXToolbar","AXTabGroup","AXOutline","AXTable","AXList"]
/**
 Bounded breadth-first search of the frontmost window for the first element the
 agent could target. `complete` is true only when the walk ran out of nodes
 rather than out of budget, so a tree too large to finish is never mistaken for
 an application that publishes nothing. Roles only; no names are read.
 */
func actionableWalk(_ window: AXUIElement, limit: Int = 1) -> (found: Int, complete: Bool) {
    let started = ProcessInfo.processInfo.systemUptime
    var queue: [(AXUIElement, Int)] = [(window, 0)], index = 0, found = 0, truncated = false
    while index < queue.count && found < limit {
        if index >= 600 || ProcessInfo.processInfo.systemUptime - started > 0.12 { truncated = true; break }
        let (node, depth) = queue[index]; index += 1
        if actionableWalkRoles.contains(attribute(node, kAXRoleAttribute) as? String ?? "") { found += 1; continue }
        guard depth < 12 else { truncated = true; continue }
        let children = (attribute(node, "AXVisibleChildren") ?? attribute(node, kAXChildrenAttribute)) as? [AXUIElement] ?? []
        if children.count > 40 { truncated = true }
        for child in children.prefix(40) { queue.append((child, depth + 1)) }
    }
    return (found, found > 0 || !truncated)
}
// Top-level menu titles of the frontmost application. AppKit builds the menu
// bar from the application's own NSMenu, so it stays in the system-wide
// accessibility tree even when the application publishes nothing else (a
// Chromium/CEF window such as Spotify). Titles only, bounded; menu contents
// are never read here.
func menuBarTitles(_ app: AXUIElement, limit: Int = 12) -> [String] {
    guard let bar = attribute(app, kAXMenuBarAttribute) else { return [] }
    var titles = [String]()
    for item in (attribute(bar as! AXUIElement, kAXChildrenAttribute) as? [AXUIElement] ?? []).prefix(limit + 4) {
        guard titles.count < limit, let raw = attribute(item, kAXTitleAttribute) as? String else { continue }
        // The Apple menu carries an empty title and is not the application's.
        let title = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if !title.isEmpty { titles.append(utf16Prefix(title, 40)) }
    }
    return titles
}
// MARK: Workspace

// Notifications seen while the helper has been running, and whether the user
// asked for them at all (docs/PRIVACY.md). Guarded by stateLock.
var deliveredNotifications = [DeliveredNotification]()
var notificationsEnabled = true
var notificationObserver: AXObserver? = nil
// Reading a banner is a handful of accessibility reads on another process; the
// observer fires on the main run loop, so it stays bounded and never blocks a
// capture.
func readNotificationBanner(_ window: AXUIElement) {
    var texts = [String](), queue = [window], index = 0
    while index < queue.count && index < 120 && texts.count < 8 {
        let node = queue[index]; index += 1
        if attribute(node, kAXSubroleAttribute) as? String == kAXSecureTextFieldSubrole { continue }
        for name in [kAXValueAttribute, kAXTitleAttribute, kAXDescriptionAttribute] {
            if let value = attribute(node, name) as? String,
               !value.trimmingCharacters(in: .whitespaces).isEmpty {
                texts.append(utf16Prefix(value, 400))
            }
        }
        queue.append(contentsOf: (attribute(node, kAXChildrenAttribute) as? [AXUIElement] ?? []).prefix(20))
    }
    let parts = notificationParts(texts)
    // A notification from a protected application is not read at all.
    guard !protectedApps.contains(where: { parts.app.lowercased().contains($0.lowercased()) }) else { return }
    let entry = DeliveredNotification(at: Date().timeIntervalSince1970,
                                      app: utf16Prefix(parts.app, 60),
                                      title: utf16Prefix(parts.title, notificationTextLimit),
                                      body: utf16Prefix(parts.body, notificationTextLimit))
    withState { deliveredNotifications = mergeNotification(deliveredNotifications, entry) }
}
/**
 Watches Notification Center for banners.

 A delivered notification is only in the accessibility tree while its banner is
 on screen, so there is nothing to read after the fact: the helper has to be
 watching. Installed once, on the main run loop, and only while the user has
 notifications switched on.
 */
func watchNotifications() {
    // The observer and its state belong to the main run loop, where its
    // callbacks fire; configure and capture reach this from other threads.
    guard Thread.isMainThread else { DispatchQueue.main.async { watchNotifications() }; return }
    guard notificationObserver == nil, AXIsProcessTrusted(),
          let center = NSWorkspace.shared.runningApplications.first(where: {
              $0.bundleIdentifier == "com.apple.notificationcenterui"
          }) else { return }
    var observer: AXObserver?
    guard AXObserverCreate(center.processIdentifier, { _, element, _, _ in
        guard withState({ notificationsEnabled }) else { return }
        readNotificationBanner(element)
    }, &observer) == .success, let observer else { return }
    let app = AXUIElementCreateApplication(center.processIdentifier)
    guard AXObserverAddNotification(observer, app, kAXWindowCreatedNotification as CFString, nil) == .success else { return }
    CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode)
    notificationObserver = observer
}
/**
 The applications the user has open, most recently used first, with the titles
 of their windows. Background and agent processes are skipped, as are protected
 applications and this agent's own windows.
 */
func openApplications() -> [OpenApp] {
    var titles = [pid_t: [String]]()
    if let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String:Any]] {
        for window in list {
            guard let pid = window[kCGWindowOwnerPID as String] as? Int,
                  let title = window[kCGWindowName as String] as? String,
                  !title.trimmingCharacters(in: .whitespaces).isEmpty else { continue }
            titles[pid_t(pid), default: []].append(utf16Prefix(title, windowTitleLimit))
        }
    }
    let frontmost = NSWorkspace.shared.frontmostApplication?.processIdentifier
    // Recently focused applications first: recentWindows is in use order.
    let recency = recentWindows.compactMap { $0["appName"] }
    let running = NSWorkspace.shared.runningApplications.filter { running in
        let id = (running.bundleIdentifier ?? "").lowercased()
        return running.activationPolicy == .regular && running.processIdentifier != getppid()
            && id != "ai.coarena.openassist"
            && !protectedApps.contains(where: { id.contains($0.lowercased()) })
    }
    let apps = running.map {
        OpenApp(name: utf16Prefix($0.localizedName ?? "", 60),
                windows: titles[$0.processIdentifier] ?? [],
                frontmost: $0.processIdentifier == frontmost)
    }.filter { !$0.name.isEmpty }
    return apps.sorted { first, second in
        if first.frontmost != second.frontmost { return first.frontmost }
        let a = recency.firstIndex(of: first.name) ?? Int.max
        let b = recency.firstIndex(of: second.name) ?? Int.max
        if a != b { return a < b }
        return first.windows.count > second.windows.count
    }
}

// MARK: Named targets

// The frontmost application's menus, read once and reused for a few seconds.
// Titles and shortcuts are stable while an application is in front, and a
// fresh read costs about a tenth of a second of accessibility round trips.
struct MenuSnapshot {
    let pid: pid_t
    let at: TimeInterval
    let lines: [String]
    // Chord ("CMD+L") to the path of the item it invokes, so a shortcut the
    // model presses is judged by the application's own declaration of what it
    // does, and pressed as that item (hotkeyRoute).
    let shortcuts: [String: [String]]
    // The application's own enabled search command ("Edit" > "Search"), so a
    // refusal to type blind can name the route that makes typing possible.
    let searchPath: [String]?
}
var menuSnapshot: MenuSnapshot? = nil // guarded by stateLock
// The application's own search command the agent ran last, if any, so text
// typed next is known to go into that search field, and what was typed into a
// palette since (guarded by stateLock; transitions in IdeSafety.swift).
var searchCommand: SearchContext? = nil
func noteCommand(_ title: String?, pid: pid_t, appId: String) {
    withState { searchCommand = openedSearchContext(title: title, pid: pid, at: ProcessInfo.processInfo.systemUptime, appId: appId) }
}
let menuSnapshotSeconds = 4.0
// The AXMenu holding a menu bar item's or a submenu item's entries.
func submenuOf(_ item: AXUIElement) -> AXUIElement? {
    for child in (attribute(item, kAXChildrenAttribute) as? [AXUIElement] ?? [])
    where attribute(child, kAXRoleAttribute) as? String == kAXMenuRole { return child }
    return nil
}
func menuEntries(_ menu: AXUIElement, limit: Int) -> [AXUIElement] {
    Array((attribute(menu, kAXChildrenAttribute) as? [AXUIElement] ?? []).prefix(limit))
}
func menuBarItem(_ app: AXUIElement, _ title: String) -> AXUIElement? {
    guard let bar = attribute(app, kAXMenuBarAttribute) else { return nil }
    return menuEntries(bar as! AXUIElement, limit: menuListLimit + 6).first {
        targetTitleMatches(request: title, title: attribute($0, kAXTitleAttribute) as? String ?? "")
    }
}
func menuItemShortcut(_ item: AXUIElement) -> String? {
    menuShortcut(cmdChar: attribute(item, kAXMenuItemCmdCharAttribute) as? String ?? "",
                 virtualKey: attribute(item, kAXMenuItemCmdVirtualKeyAttribute) as? Int,
                 modifiers: attribute(item, kAXMenuItemCmdModifiersAttribute) as? Int ?? 0)
}
func menuEntryDigest(_ item: AXUIElement) -> MenuItemDigest? {
    let title = normalizeTargetTitle(attribute(item, kAXTitleAttribute) as? String ?? "")
    guard !title.isEmpty else { return nil } // separators carry no title
    return MenuItemDigest(title: utf16Prefix(title, menuTitleLimit), shortcut: menuItemShortcut(item),
                          enabled: attribute(item, kAXEnabledAttribute) as? Bool ?? true,
                          submenu: submenuOf(item) != nil)
}
/**
 The frontmost application's menus as one line each, plus its shortcuts. Titles
 only: menu items name commands, never document contents. The Apple menu is
 skipped (it is the system's, not the application's).
 */
func menuMap(_ app: AXUIElement, pid: pid_t) -> MenuSnapshot {
    if let cached = withState({ menuSnapshot }), cached.pid == pid,
       ProcessInfo.processInfo.systemUptime - cached.at < menuSnapshotSeconds { return cached }
    var lines = [String](), shortcuts = [String: [String]](), searchPath: [String]? = nil
    if let bar = attribute(app, kAXMenuBarAttribute) {
        for item in menuEntries(bar as! AXUIElement, limit: menuListLimit + 6) where lines.count < menuListLimit {
            let title = normalizeTargetTitle(attribute(item, kAXTitleAttribute) as? String ?? "")
            guard !title.isEmpty, !systemMenuTitles.contains(title.lowercased()) else { continue }
            guard let menu = submenuOf(item) else { lines.append(title); continue }
            var entries = [MenuItemDigest]()
            for element in menuEntries(menu, limit: menuItemListLimit + 8) {
                guard let entry = menuEntryDigest(element) else { continue }
                entries.append(entry)
                // The whole title, not the digest's bounded one: this path is resolved by name.
                if let shortcut = entry.shortcut, shortcuts[shortcut] == nil {
                    shortcuts[shortcut] = [title, normalizeTargetTitle(attribute(element, kAXTitleAttribute) as? String ?? "")]
                }
                if searchPath == nil, entry.enabled, !entry.submenu, searchCommandTitle(entry.title) { searchPath = [title, entry.title] }
            }
            lines.append(menuDigestLine(menu: title, items: entries))
        }
    }
    let snapshot = MenuSnapshot(pid: pid, at: ProcessInfo.processInfo.systemUptime, lines: lines, shortcuts: shortcuts, searchPath: searchPath)
    withState { menuSnapshot = snapshot }
    return snapshot
}
/**
 Resolves a menu path ("Playback" > "Play") against the live menu bar. Returns
 nil when no menu item carries that name, which is a rejection the agent can
 act on: the menus it was shown are the truth. With a chord, the item must
 also still carry that shortcut, so a hotkey presses exactly its own item.
 */
func resolveMenuPath(_ app: AXUIElement, _ path: [String], chord: String? = nil) -> (item: AXUIElement, title: String, enabled: Bool)? {
    guard path.count >= 2, let bar = attribute(app, kAXMenuBarAttribute) else { return nil }
    var container = bar as! AXUIElement, found: AXUIElement? = nil
    for (index, segment) in path.enumerated() {
        guard let match = menuEntries(container, limit: 200).first(where: {
            targetTitleMatches(request: segment, title: attribute($0, kAXTitleAttribute) as? String ?? "")
                && (chord == nil || index < path.count - 1 || menuItemShortcut($0) == chord)
        }) else { return nil }
        found = match
        if index < path.count - 1 {
            guard let next = submenuOf(match) else { return nil }
            container = next
        }
    }
    guard let item = found else { return nil }
    return (item, normalizeTargetTitle(attribute(item, kAXTitleAttribute) as? String ?? ""),
            attribute(item, kAXEnabledAttribute) as? Bool ?? true)
}
func pressEscape() {
    postInput(CGEvent(keyboardEventSource: nil, virtualKey: 53, keyDown: true))
    postInput(CGEvent(keyboardEventSource: nil, virtualKey: 53, keyDown: false))
}
/**
 Presses a menu item by name. AppKit validates items and Chromium builds them
 only when a menu opens, so an item that reports itself disabled is retried
 once with its menu open — which is what a person does — and the menu is always
 closed again on failure. A hotkey pressed through its item names its chord,
 which the item must still carry.
 */
func pressMenuPath(_ path: [String], chord: String? = nil) throws {
    if let refusal = menuPressRefusal(path: path, chord: chord, item: nil) { throw ControlError(refusal.message, code: refusal.code) }
    guard let app = inputApplication() else { throw changedScreen("Foreground application changed.") }
    let element = AXUIElementCreateApplication(app.processIdentifier)
    _ = AXUIElementSetMessagingTimeout(element, 2.0)
    var resolved = resolveMenuPath(element, path, chord: chord)
    if resolved == nil || resolved?.enabled == false {
        if let top = menuBarItem(element, path[0]) {
            try ensureRunning()
            _ = AXUIElementPerformAction(top, kAXPressAction as CFString)
            Thread.sleep(forTimeInterval: 0.2)
            resolved = resolveMenuPath(element, path, chord: chord)
            if resolved == nil || resolved?.enabled == false { pressEscape() }
        }
    }
    if let refusal = menuPressRefusal(path: path, chord: chord, item: resolved.map { $0.enabled ? .enabled : .disabled } ?? .missing) {
        throw ControlError(refusal.message, code: refusal.code)
    }
    let item = resolved! // a missing item was refused just above
    try ensureRunning(); try guardSurface()
    guard AXUIElementPerformAction(item.item, kAXPressAction as CFString) == .success else {
        pressEscape()
        throw ControlError("\(menuCommandName(path: path, chord: chord)) could not be chosen.", code: "INPUT_FAILED")
    }
    withState { menuSnapshot = nil } // menus revalidate after their own command
    noteCommand(item.title, pid: app.processIdentifier, appId: app.bundleIdentifier ?? "")
}
// How a hotkey reaches the frontmost application now (hotkeyRoute). The step
// carries the item policy judged it by (the runner sends surface's shortcutLabel
// back) and whether the user approved it, so a chord that now names another
// item is not pressed.
func currentHotkeyRoute(_ action: [String:Any]) -> HotkeyRoute {
    guard action["type"] as? String == "hotkey", let names = action["keys"] as? [String] else { return .keys }
    let shortcuts = inputApplication().map { menuMap(AXUIElementCreateApplication($0.processIdentifier), pid: $0.processIdentifier).shortcuts } ?? [:]
    return hotkeyRoute(keys: names, shortcuts: shortcuts, approved: action["approved"] as? Bool == true, label: action["shortcutLabel"] as? String)
}
/**
 Shows a frontmost, windowless application's main window by pressing the
 Window menu item that names it (mainWindowMenuEntry in NamedTargets.swift).
 The element that rule approved is the one pressed: resolving its title again
 would take the first item sharing that prefix. Like pressMenuPath, an item
 that reads greyed out is checked once more with its menu open. Never a
 LaunchServices reopen: a windowless document app answers that with an Open
 panel. False when the application lists no such item or it stays disabled; a
 stop or a blocked surface still throws.
 */
func restoreMainWindow(pid: pid_t, bundleId: String, appNames: [String]) throws -> Bool {
    let element = AXUIElementCreateApplication(pid)
    _ = AXUIElementSetMessagingTimeout(element, 2.0)
    func find() -> AXUIElement? {
        guard let top = menuBarItem(element, "Window"), let menu = submenuOf(top) else { return nil }
        return mainWindowMenuEntry(appNames: appNames, bundleId: bundleId, entries: menuEntries(menu, limit: 40), digest: menuEntryDigest)
    }
    func enabled(_ item: AXUIElement) -> Bool { attribute(item, kAXEnabledAttribute) as? Bool ?? true }
    guard var item = find(), inputApplication()?.processIdentifier == pid else { return false }
    var opened = false
    if !enabled(item) {
        guard let top = menuBarItem(element, "Window") else { return false }
        try ensureRunning()
        _ = AXUIElementPerformAction(top, kAXPressAction as CFString); opened = true
        Thread.sleep(forTimeInterval: 0.2)
        guard let again = find(), enabled(again) else { pressEscape(); return false }
        item = again
    }
    try ensureRunning(); try guardSurface()
    guard AXUIElementPerformAction(item, kAXPressAction as CFString) == .success else { if opened { pressEscape() }; return false }
    withState { menuSnapshot = nil } // menus revalidate after their own command
    noteCommand(nil, pid: pid, appId: bundleId) // a window command, never a search
    return true
}
/**
 The controls the model was shown, read again now: the same walk capture uses,
 so a name it quoted resolves to where that control is at this moment.
 */
func currentNamedControls() -> [NamedControl] {
    let display = CGDisplayBounds(displayID)
    let state = windowState()
    var items = groundedControls(state, display: display)
    if browserAppIDs.contains(state.appId), let window = state.window {
        items = mergeControls(items, webControls(window, display: display), limit: 60)
    }
    return items.map {
        NamedControl(label: $0["label"] as? String ?? "", role: $0["role"] as? String ?? "",
                     x: $0["x"] as? Double ?? 0, y: $0["y"] as? Double ?? 0,
                     enabled: $0["enabled"] as? Bool ?? true)
    }
}
func resolveNamedControl(_ action: [String:Any]) -> (match: ControlMatch, control: NamedControl?) {
    let controls = currentNamedControls()
    let match = matchNamedControl(controls, label: action["label"] as? String ?? "",
                                  role: action["role"] as? String,
                                  hintX: action["x"] as? Double, hintY: action["y"] as? Double)
    if case .matched(let index) = match, controls.indices.contains(index) { return (match, controls[index]) }
    return (match, nil)
}
// The accessibility level of the frontmost application's own window, as
// reported on the surface and in the screen context.
func accessibilityLevel(_ element: AXUIElement, focusedRole: String, hitTarget: Bool) -> SurfaceAccessibility? {
    let window = attribute(element, kAXFocusedWindowAttribute).map { $0 as! AXUIElement }
    let bounds = window.flatMap(elementRect) ?? .zero
    let walk = window.map { actionableWalk($0) } ?? (found: 0, complete: false)
    return surfaceAccessibility(trusted: AXIsProcessTrusted(), windowWidth: Double(bounds.width), windowHeight: Double(bounds.height),
                                focusedRole: focusedRole, actionable: walk.found, walkComplete: walk.complete, hitTarget: hitTarget)
}
func surface(_ requested: [String:Any]? = nil) -> [String: Any] {
    guard let app = inputApplication() else { return ["appId":"unknown", "pid":0, "secureInput":true, "unknown":true] }
    exposeAccessibilityTree(app)
    let element = AXUIElementCreateApplication(app.processIdentifier)
    // A control the agent named is resolved to where it is now, so the hit test
    // below describes the element it actually asked for rather than a position
    // a moving page has since given to something else.
    var action = requested
    var namedControl: (status: String, label: String?)? = nil
    if requested?["type"] as? String == "click_control", let request = requested {
        let resolution = resolveNamedControl(request)
        switch resolution.match {
        case .matched:
            if let control = resolution.control {
                action?["x"] = control.x; action?["y"] = control.y
                namedControl = (control.enabled ? "resolved" : "disabled", control.label)
            }
        case .ambiguous: namedControl = ("ambiguous", nil)
        case .missing: namedControl = ("missing", nil)
        }
    }
    var secure = IsSecureEventInputEnabled()
    var focusedRole: String? = nil
    var addressBar = false
    var focusedValue = ""
    var focusedSubrole: String? = nil
    var focusedLabel = ""
    var terminalFocus = false
    if let focused = attribute(element, kAXFocusedUIElementAttribute) {
        let el = focused as! AXUIElement
        focusedRole = attribute(el, kAXRoleAttribute) as? String
        focusedSubrole = attribute(el, kAXSubroleAttribute) as? String
        addressBar = browserAddressField(el,appId:app.bundleIdentifier ?? "")
        if addressBar {focusedValue=String((attribute(el,kAXValueAttribute) as? String ?? "").prefix(2000))}
        let secureField = focusedSubrole == kAXSecureTextFieldSubrole
        secure = secure || secureField
        // Describes the field (e.g. "Search"), never its contents.
        if !secureField {focusedLabel = fieldLabel(el)}
        // An xterm.js terminal is an ordinary text area to accessibility; its
        // DOM class, role description or editor label tell it apart.
        terminalFocus = terminalFocusEvidence(roleDescription: attribute(el, kAXRoleDescriptionAttribute) as? String ?? "", label: fieldLabel(el),
                                              domClasses: attribute(el, "AXDOMClassList") as? [String] ?? [], ide: ideFamily(app.bundleIdentifier ?? "") != nil)
    }
    var domain: String? = nil
    if let window = attribute(element, kAXFocusedWindowAttribute) {
        if let url = attribute(window as! AXUIElement, "AXDocument") as? String { domain = URL(string:url)?.host?.lowercased() }
        if domain == nil, let url = attribute(window as! AXUIElement, "AXURL") as? URL { domain = url.host?.lowercased() }
        // Safari sets no window-level document URL; only its AXWebArea carries
        // the page URL. Without this, protected domains are never detected there.
        if domain == nil { domain = webAreaHost(window as! AXUIElement) }
    }
    var result: [String: Any] = ["appId":app.bundleIdentifier ?? "unknown", "pid":Int(app.processIdentifier), "secureInput":secure, "unknown":!AXIsProcessTrusted()]
    // Display name, so an approval question can name the application the user
    // sees ("Spotify") rather than its bundle identifier.
    if let name = app.localizedName, !name.isEmpty { result["appName"] = utf16Prefix(name, 100) }
    let focusedWindow = attribute(element, kAXFocusedWindowAttribute).map { $0 as! AXUIElement }
    let focusedElement = attribute(element, kAXFocusedUIElementAttribute).map { $0 as! AXUIElement }
    if modalContext(window: focusedWindow, element: focusedElement) { result["modal"] = true }
    if let domain = domain { result["domain"] = domain }
    if let role = focusedRole {result["focusedRole"] = role}
    if let subrole = focusedSubrole, !subrole.isEmpty {result["focusedSubrole"] = subrole}
    if !focusedLabel.isEmpty {result["focusedLabel"] = focusedLabel}
    if terminalFocus {result["terminalFocus"] = true}
    result["addressBar"] = addressBar
    if addressBar {result["focusedValue"] = focusedValue}
    if app.bundleIdentifier == "com.apple.Spotlight" {result["launcher"] = spotlightState(element)}
    if let a = action, let x = a["x"] as? Double,let y = a["y"] as? Double,x>=0,x<=1,y>=0,y<=1 {
        let b = CGDisplayBounds(displayID);var target:AXUIElement?
        if AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(),Float(b.minX+x*b.width),Float(b.minY+y*b.height),&target) == .success,var target = target {
            // Every visited element contributes its name, so a label on an
            // intermediate ancestor (an icon's aria-label) reaches policy.
            var names = [elementText(target)] + targetNames(target)
            for _ in 0..<6 {
                let role=attribute(target,kAXRoleAttribute) as? String ?? ""
                if hitWalkControlRoles.contains(role) {break}
                guard hitWalkClimbRoles.contains(role),let parent=attribute(target,kAXParentAttribute),CFGetTypeID(parent) == AXUIElementGetTypeID() else{break}
                target=parent as! AXUIElement
                names += targetNames(target)
                if hitWalkStopsAt(role:attribute(target,kAXRoleAttribute) as? String ?? "",description:attribute(target,kAXDescriptionAttribute) as? String ?? "",actions:actionNames(target)) {break}
            }
            // Web thumbnails and cards nest a clickable, unlabelled group inside
            // the link that carries the name and URL (YouTube results). When the
            // walk stopped at such a container, prefer the enclosing link/button.
            if ["AXGroup","AXImage","AXStaticText"].contains(attribute(target,kAXRoleAttribute) as? String ?? "") {
                var ancestor = attribute(target,kAXParentAttribute).map { $0 as! AXUIElement }
                for _ in 0..<8 {
                    guard let current = ancestor else { break }
                    let role = attribute(current,kAXRoleAttribute) as? String ?? ""
                    if ["AXWebArea","AXWindow","AXApplication"].contains(role) { break }
                    if ["AXLink","AXButton"].contains(role) { target = current; names += targetNames(current); break }
                    ancestor = attribute(current,kAXParentAttribute).map { $0 as! AXUIElement }
                }
            }
            let joined = joinedTargetText(names)
            if !joined.isEmpty {result["targetText"] = joined}
            result["targetRole"] = attribute(target,kAXRoleAttribute) as? String ?? ""
            result["targetSubrole"] = attribute(target,kAXSubroleAttribute) as? String ?? ""
            var targetPID:pid_t=0
            if AXUIElementGetPid(target,&targetPID) == .success {result["targetAppId"]=NSRunningApplication(processIdentifier:targetPID)?.bundleIdentifier ?? ""}
            if let enabled=attribute(target,kAXEnabledAttribute) as? Bool {result["targetEnabled"]=enabled}
            let title = controlLabel(target)
            result["targetLabel"] = String(title.prefix(120))
            if let url=attribute(target,"AXURL") as? URL {result["targetURL"] = String(url.absoluteString.prefix(2000))}
            else if let url=attribute(target,"AXURL") as? String {result["targetURL"] = String(url.prefix(2000))}
            if result["targetAppId"] as? String == "com.apple.dock",result["targetSubrole"] as? String == "AXApplicationDockItem",
               let raw=result["targetURL"] as? String,let url=URL(string:raw),url.isFileURL,url.pathExtension == "app",let bundle=Bundle(url:url)?.bundleIdentifier {
                result["launcherAppId"]=bundle
            }
            if attribute(target,kAXSubroleAttribute) as? String == kAXSecureTextFieldSubrole {result["secureInput"] = true}
            if let host = enclosingWebHost(target) { result["targetWebHost"] = host }
            if modalContext(window: nil, element: target) { result["modal"] = true }
        }
    }
    if let a = action, a["type"] as? String == "open_app", let name = a["name"] as? String {
        let resolution = resolveLaunch(query:name, candidates:applicationCandidates(), protectedApps:protectedApps)
        var cached: LaunchBinding? = nil
        switch resolution {
        case .resolved(let appId, let display, let path):
            result["launcherStatus"] = "resolved"; result["launcherAppId"] = appId; result["launcherName"] = display
            if let frameId = a["frame_id"] as? String { cached = LaunchBinding(frameId:frameId, name:normalizeAppName(name), bundleId:appId, path:path) }
        case .ambiguous(let names): result["launcherStatus"] = "ambiguous"; result["launcherCandidates"] = names
        case .unresolved(let names): result["launcherStatus"] = "unresolved"; result["launcherCandidates"] = names
        case .refused: result["launcherStatus"] = "refused"
        }
        stateLock.lock(); launchBinding = cached; stateLock.unlock()
    }
    // Whether the frontmost application shows any window, for open_app and a
    // Dock click on an application: opening the frontmost app again is only
    // useful when it has no window to work in (policy.ts).
    if action?["type"] as? String == "open_app" || result["launcherAppId"] != nil {
        result["windowCount"] = min(onScreenWindowCount(app.processIdentifier), 99)
    }
    if let a = action, a["type"] as? String == "open_file" {
        let requested = a["path"] as? String ?? ""
        var cached: FileBinding? = nil
        // A named application goes through the open_app resolution and is
        // reported in its fields; the item is then checked against that
        // application instead of its default one, and bound only when both
        // resolved.
        let appName = a["app"] as? String
        var handler: LaunchCandidate? = nil, appReady = appName == nil
        if let appName {
            switch resolveLaunch(query: appName, candidates: applicationCandidates(), protectedApps: protectedApps) {
            case .resolved(let appId, let display, let path):
                result["launcherStatus"] = "resolved"; result["launcherAppId"] = appId; result["launcherName"] = display
                handler = applicationCandidate(at: path, rootIndex: 0, allowedRoots: allowedApplicationRealRoots())
                appReady = handler?.bundleId == appId
                if !appReady { result["launcherStatus"] = "unresolved"; handler = nil }
            case .ambiguous(let names): result["launcherStatus"] = "ambiguous"; result["launcherCandidates"] = names
            case .unresolved(let names): result["launcherStatus"] = "unresolved"; result["launcherCandidates"] = names
            case .refused: result["launcherStatus"] = "refused"
            }
        }
        switch checkOpenFile(requested, in: handler) {
        case .resolved(let plan):
            result["fileStatus"] = "resolved"; result["fileKind"] = plan.kind.rawValue; result["fileName"] = openFileDisplayName(plan.path)
            if appReady, let frameId = a["frame_id"] as? String { cached = FileBinding(frameId: frameId, requested: requested, app: appName.map(normalizeAppName), plan: plan) }
        case .unresolved: result["fileStatus"] = "unresolved"
        case .refused: result["fileStatus"] = "refused"
        }
        stateLock.lock(); fileBinding = cached; stateLock.unlock()
    }
    if let command = withState({ searchCommand }),
       searchCommandCurrent(commandPid: command.pid, commandAt: command.at, pid: app.processIdentifier, now: ProcessInfo.processInfo.systemUptime) {
        result["searchOpenedBy"] = command.title
        // The agent's own typing, never the field's value: ENTER in a palette
        // runs whichever command that text selected. The state says when an
        // arrow key or an edit means the text is only the last known one.
        if let query = command.query { result["searchQuery"] = query }
        if let state = command.state { result["searchQueryState"] = state.rawValue }
    } else if let type = action?["type"] as? String, ["type_text", "key"].contains(type),
              let path = menuMap(element, pid: app.processIdentifier).searchPath {
        // Typing with nothing identified to type into: name the application's
        // own way to open a field, so the refusal is a route, not a dead end.
        result["searchCommand"] = path.map { utf16Prefix($0, 60) }
    }
    if let status = namedControl {
        result["controlStatus"] = status.status
        if let label = status.label { result["controlLabel"] = utf16Prefix(label, 120) }
    }
    if let a = action, a["type"] as? String == "menu_item", let path = a["path"] as? [String] {
        if menuPathRefused(path) { result["menuStatus"] = "refused" }
        else if let resolved = resolveMenuPath(element, path) {
            result["menuStatus"] = resolved.enabled ? "resolved" : "disabled"
            result["menuLabel"] = utf16Prefix(resolved.title, 80)
        } else { result["menuStatus"] = "missing" }
    }
    // A chord that is one of this application's own menu shortcuts is not a
    // guess: the menu says what it does, so policy can judge it by that name.
    // Bounded like the digest's titles: the label reaches the trace in policy reasons.
    if let a = action, a["type"] as? String == "hotkey", let names = a["keys"] as? [String] {
        let shortcuts = menuMap(element, pid: app.processIdentifier).shortcuts
        if let item = publishedShortcutItem(keys: names, shortcuts: shortcuts) { result["shortcutLabel"] = shortcutMenuLabel(item) }
        if let status = shortcutStatus(keys: names, shortcuts: shortcuts) { result["shortcutStatus"] = status }
    }
    // Computed last: the hit test above is the pointer evidence that this
    // application publishes something at the requested position.
    if let level = accessibilityLevel(element, focusedRole: focusedRole ?? "", hitTarget: result["targetRole"] != nil) {
        result["accessibility"] = level.rawValue
    }
    return result
}
// MARK: open_file
// One verified open: the item, what LaunchServices opens (an alias's target)
// and the default application checked for it.
struct FileOpenPlan: Equatable { let path: String; let realPath: String; let kind: FileKind; let opens: String; let handlerPath: String; let handlerId: String }
enum FileOpenCheck { case resolved(FileOpenPlan), unresolved, refused }
struct FileBinding { var frameId: String; let requested: String; let app: String?; let plan: FileOpenPlan }
var fileBinding: FileBinding?
// Filesystem facts for FileSafety: resource values only, never file contents.
func inspectFile(_ real: String) -> FileFacts? {
    let url = URL(fileURLWithPath: real)
    guard let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .isPackageKey, .isAliasFileKey, .isSymbolicLinkKey, .isRegularFileKey, .isExecutableKey, .contentTypeKey]) else { return nil }
    var facts = FileFacts()
    facts.directory = values.isDirectory ?? false
    facts.package = facts.directory && (values.isPackage ?? false)
    facts.executable = (values.isRegularFile ?? false) && (values.isExecutable ?? false)
    if let type = values.contentType { facts.types = [type.identifier] + type.supertypes.map { $0.identifier } }
    // realpath already followed symlinks; a remaining alias flag is a Finder alias.
    if values.isAliasFile == true && values.isSymbolicLink != true {
        facts.alias = true
        if let target = try? URL(resolvingAliasFileAt: url, options: [.withoutUI, .withoutMounting]) { facts.aliasTarget = realPath(target.path) }
    }
    return facts
}
func resolveOpenFile(_ requested: String) -> FileResolution {
    resolveOpenPath(requested, home: FileManager.default.homeDirectoryForCurrentUser.path, realpath: realPath, inspect: inspectFile)
}
// The application LaunchServices would open the item with, as open_app sees
// it: nil when there is none or it is not a foreground native application
// (applets, script wrappers, background and menu-bar-only helpers). Any
// install location is accepted here; the denial rules decide.
func defaultFileHandler(opens: String, kind: FileKind) -> LaunchCandidate? {
    guard let app = NSWorkspace.shared.urlForApplication(toOpen: URL(fileURLWithPath: opens, isDirectory: kind == .folder)),
          let real = realPath(app.path) else { return nil }
    let parent = (real as NSString).deletingLastPathComponent
    guard parent != "/" else { return nil }
    return applicationCandidate(at: real, rootIndex: 0, allowedRoots: [parent])
}
// Path rules first, then the application under the open_app rules: the one
// named for this open, or else the item's default one. A named application
// may open a folder (an editor opening a project), which the default route
// leaves to Finder; it still must not be one a document may never reach.
func checkOpenFile(_ requested: String, in named: LaunchCandidate? = nil) -> FileOpenCheck {
    switch resolveOpenFile(requested) {
    case .unresolved: return .unresolved
    case .refused: return .refused
    case .resolved(let path, let real, let kind, let opens):
        let app: LaunchCandidate
        if let named {
            guard !namedFileHandlerRefused(named, protectedApps: protectedApps) else { return .refused }
            app = named
        } else {
            let handler = defaultFileHandler(opens: opens, kind: kind)
            guard let candidate = handler, !fileHandlerRefused(kind: kind, handler: handler, protectedApps: protectedApps) else { return .refused }
            app = candidate
        }
        return .resolved(FileOpenPlan(path: path, realPath: real, kind: kind, opens: opens, handlerPath: app.path, handlerId: app.bundleId))
    }
}
// Accessible names of one element visited by the hit-test walk. Editable and
// secure elements never contribute their value.
func targetNames(_ element:AXUIElement) -> [String] {
    let role = attribute(element,kAXRoleAttribute) as? String ?? ""
    let editable = attribute(element,kAXSubroleAttribute) as? String == kAXSecureTextFieldSubrole || ["AXTextField","AXTextArea","AXComboBox"].contains(role)
    let label = editable ? fieldLabel(element) : String(controlLabel(element).prefix(120))
    return [label] + [kAXDescriptionAttribute,kAXHelpAttribute,kAXTitleAttribute].map { String((attribute(element,$0) as? String ?? "").prefix(120)) }
}
func actionNames(_ element:AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(element,&names) == .success, let list = names as? [String] else { return [] }
    return list
}
// Bounded label of an element: title, description or placeholder, never its value.
func fieldLabel(_ element:AXUIElement) -> String {
    for name in [kAXTitleAttribute,kAXDescriptionAttribute,kAXPlaceholderValueAttribute] {if let value=attribute(element,name) as? String,!value.isEmpty{return String(value.prefix(120))}}
    return ""
}
// Visible text of the element the pointer actually hits, before walking up to
// its control. Editable and secure fields contribute only their label.
func elementText(_ element:AXUIElement) -> String {
    let role = attribute(element,kAXRoleAttribute) as? String ?? ""
    if attribute(element,kAXSubroleAttribute) as? String == kAXSecureTextFieldSubrole || ["AXTextField","AXTextArea","AXComboBox"].contains(role) {return fieldLabel(element)}
    for name in [kAXValueAttribute,kAXTitleAttribute,kAXDescriptionAttribute] {if let value=attribute(element,name) as? String,!value.isEmpty{return String(value.prefix(120))}}
    return ""
}
struct LaunchBinding { let frameId: String; let name: String; let bundleId: String; let path: String }
var launchBinding: LaunchBinding?
var applicationCache: (time: TimeInterval, list: [LaunchCandidate])?
func realPath(_ path: String) -> String? {
    guard let raw = realpath(path, nil) else { return nil }
    defer { free(raw) }; return String(cString: raw)
}
// Fixed allow-listed roots in precedence order. CoreServices is never
// enumerated (it holds Installer, Setup Assistant and similar); only Finder.
func applicationRoots() -> [(path: String, index: Int)] {
    let fm = FileManager.default, home = fm.homeDirectoryForCurrentUser.path + "/Applications"
    var roots: [(String, Int)] = [("/System/Applications", 0), ("/System/Applications/Utilities", 1), ("/Applications", 2)]
    func subfolders(_ root: String, _ index: Int, skipLocalized: Bool) {
        for entry in ((try? fm.contentsOfDirectory(atPath: root)) ?? []).sorted() where !entry.hasPrefix(".") && !entry.hasSuffix(".app") {
            if skipLocalized && entry.hasSuffix(".localized") { continue }
            var directory: ObjCBool = false
            if fm.fileExists(atPath: root + "/" + entry, isDirectory: &directory), directory.boolValue { roots.append((root + "/" + entry, index)) }
        }
    }
    subfolders("/Applications", 3, skipLocalized: false)
    roots.append((home, 4)); subfolders(home, 5, skipLocalized: true)
    return roots
}
// Realpaths a candidate may live under. Safari and other Rapid Security
// Response apps in /Applications are symlinks into the sealed system cryptex.
func allowedApplicationRealRoots() -> [String] {
    ["/System/Applications", "/Applications", FileManager.default.homeDirectoryForCurrentUser.path + "/Applications", "/System/Cryptexes/App/System/Applications"].compactMap(realPath)
}
func truthy(_ value: Any?) -> Bool {
    if let flag = value as? Bool { return flag }
    if let text = value as? String { return ["1", "yes", "true"].contains(text.lowercased()) }
    return false
}
// A launchable, foreground, native application bundle inside an allowed root.
func applicationCandidate(at path: String, rootIndex: Int, allowedRoots: [String]) -> LaunchCandidate? {
    guard let real = realPath(path), !real.contains("/Contents/"), real.hasSuffix(".app"),
          real == "/System/Library/CoreServices/Finder.app" || allowedRoots.contains(where: { real.hasPrefix($0 + "/") }),
          let info = NSDictionary(contentsOfFile: real + "/Contents/Info.plist") as? [String:Any],
          info["CFBundlePackageType"] as? String == "APPL" || (real == "/System/Library/CoreServices/Finder.app" && info["CFBundlePackageType"] as? String == "FNDR"),
          let bundleId = info["CFBundleIdentifier"] as? String, !bundleId.isEmpty, bundleId.count <= 255,
          !truthy(info["LSBackgroundOnly"]), !truthy(info["LSUIElement"]),
          let executable = info["CFBundleExecutable"] as? String, !executable.isEmpty, !executable.contains("/"), executable != "..",
          let binary = realPath(real + "/Contents/MacOS/" + executable), binary.hasPrefix(real + "/"),
          let handle = FileHandle(forReadingAtPath: binary) else { return nil }
    defer { try? handle.close() }
    // Applets and Automator/script wrappers are refused by structure, whatever
    // bundle identifier they carry: their stub is real Mach-O but runs a script.
    let fm = FileManager.default
    guard !scriptBundle(executableName: executable,
                        hasMainScript: scriptBundleMainScripts.contains { fm.fileExists(atPath: real + "/" + $0) },
                        hasWorkflow: fm.fileExists(atPath: real + "/" + scriptBundleWorkflow),
                        hasOSAKeys: scriptBundleOSAKeys.contains { info[$0] != nil }) else { return nil }
    let header = handle.readData(ofLength: 4)
    // Mach-O thin or universal binaries only; "#!" script wrappers are refused.
    guard header.count == 4 else { return nil }
    let magic = header.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }
    guard [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].contains(magic) else { return nil }
    let stem = String(((path as NSString).lastPathComponent as NSString).deletingPathExtension.prefix(120))
    let display = String(FileManager.default.displayName(atPath: real).prefix(120))
    let names = [stem, info["CFBundleName"] as? String ?? "", info["CFBundleDisplayName"] as? String ?? "", display].map { String($0.prefix(120)) }.filter { !$0.isEmpty }
    let visible = normalizeAppName(display).isEmpty ? stem : (display.lowercased().hasSuffix(".app") ? String(display.dropLast(4)) : display)
    return LaunchCandidate(path: real, bundleId: bundleId, names: names, displayName: String(visible.prefix(120)), running: false, rootIndex: rootIndex)
}
// Enumerated only when an open_app is evaluated; cached briefly because it
// reads every bundle's Info.plist. Running state is always fresh.
func applicationCandidates() -> [LaunchCandidate] {
    let now = ProcessInfo.processInfo.systemUptime
    stateLock.lock(); let cached = applicationCache; stateLock.unlock()
    var list: [LaunchCandidate]
    if let cached = cached, now - cached.time < 30 { list = cached.list } else {
        let roots = applicationRoots(), fm = FileManager.default
        let allowed = allowedApplicationRealRoots()
        list = []
        for root in roots {
            for entry in ((try? fm.contentsOfDirectory(atPath: root.path)) ?? []).sorted() where entry.hasSuffix(".app") && !entry.hasPrefix(".") {
                if let candidate = applicationCandidate(at: root.path + "/" + entry, rootIndex: root.index, allowedRoots: allowed) { list.append(candidate) }
            }
        }
        if let finder = applicationCandidate(at: "/System/Library/CoreServices/Finder.app", rootIndex: 6, allowedRoots: []) { list.append(finder) }
        stateLock.lock(); applicationCache = (now, list); stateLock.unlock()
    }
    let running = Set(NSWorkspace.shared.runningApplications.compactMap { $0.bundleIdentifier?.lowercased() })
    return list.map { LaunchCandidate(path: $0.path, bundleId: $0.bundleId, names: $0.names, displayName: $0.displayName, running: running.contains($0.bundleId.lowercased()), rootIndex: $0.rootIndex) }
}
func guardSurface() throws {
    let s = surface(), app = (s["appId"] as? String ?? "").lowercased()
    // SURFACE_BLOCKED: the runner hands control to the user instead of failing.
    if app.contains("uninstall") {throw ControlError("An uninstaller opened. Input stopped; close it manually before continuing.", code: "SURFACE_BLOCKED")}
    if s["secureInput"] as? Bool == true { throw ControlError("Sensitive input is active; capture and input are blocked.", code: "SURFACE_BLOCKED") }
    if protectedApps.contains(where:{ app.contains($0.lowercased()) }) { throw ControlError("Protected application. Switch applications and resume.", code: "SURFACE_BLOCKED") }
    if let domain = s["domain"] as? String, protectedDomains.contains(where:{ domain == $0 || domain.hasSuffix("."+$0) }) { throw ControlError("Protected domain. Take over manually.", code: "SURFACE_BLOCKED") }
}
func screenContext() -> [String:Any] {
    guard (try? guardSurface()) != nil, let app=inputApplication() else{return [:]}
    let element=AXUIElementCreateApplication(app.processIdentifier)
    var result:[String:Any] = ["appName":app.localizedName ?? "", "windowTitle":""]
    if app.bundleIdentifier == "com.apple.Spotlight" {result["launcher"] = spotlightState(element)}
    if let raw=attribute(element,kAXFocusedWindowAttribute) {
        let window=raw as! AXUIElement
        let title=String((attribute(window,kAXTitleAttribute) as? String ?? "").prefix(300))
        result["windowTitle"]=title
        let entry=["appName":app.localizedName ?? "", "title":title]
        recentWindows.removeAll{$0 == entry};recentWindows.insert(entry,at:0);recentWindows=Array(recentWindows.prefix(8))
        if let document=attribute(window,"AXDocument") as? String,let url=URL(string:document),url.isFileURL {
            let name=String(url.lastPathComponent.prefix(300));result["documentName"]=name
            recentFiles.removeAll{$0 == name};recentFiles.insert(name,at:0);recentFiles=Array(recentFiles.prefix(8))
        }
        var text=[String](),nodes=0,characters=0
        func visit(_ node:AXUIElement,_ depth:Int) {
            guard depth<6,nodes<120,characters<4000 else{return};nodes+=1
            if attribute(node,"AXHidden") as? Bool == true || attribute(node,kAXSubroleAttribute) as? String == kAXSecureTextFieldSubrole{return}
            let role=attribute(node,kAXRoleAttribute) as? String ?? ""
            let value=(role == "AXStaticText" ? attribute(node,kAXValueAttribute) : attribute(node,kAXTitleAttribute)) as? String ?? ""
            if !value.isEmpty {let bounded=String(value.prefix(min(300,4000-characters)));text.append(bounded);characters+=bounded.count}
            let children=(attribute(node,"AXVisibleChildren") ?? attribute(node,kAXChildrenAttribute)) as? [AXUIElement] ?? []
            for child in children.prefix(30){visit(child,depth+1)}
        }
        visit(window,0);result["visibleText"]=String(text.joined(separator:"\n").prefix(4200))
    }
    // In a browser the page is the content, whatever has focus: the find bar,
    // a menu or the address bar are separate windows or chrome around it.
    if browserAppIDs.contains(app.bundleIdentifier ?? ""),
       let main=attribute(element,kAXMainWindowAttribute) ?? attribute(element,kAXFocusedWindowAttribute) {
        let page=webVisibleText(main as! AXUIElement, display: CGDisplayBounds(displayID))
        if page.count > (result["visibleText"] as? String ?? "").count {result["visibleText"]=String(page.prefix(4200))}
    }
    if let raw=attribute(element,kAXFocusedUIElementAttribute) {
        let focused=raw as! AXUIElement
        if browserAddressField(focused,appId:app.bundleIdentifier ?? "") {result["browserAddress"] = String((attribute(focused,kAXValueAttribute) as? String ?? "").prefix(2000))}
        if attribute(focused,kAXSubroleAttribute) as? String != kAXSecureTextFieldSubrole,let selection=attribute(focused,kAXSelectedTextAttribute) as? String {result["selectedText"]=String(selection.prefix(2000))}
    }
    var windows=recentWindows
    if let list=CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]] {
        // A frontmost application with no window shows the app behind it in
        // the screenshot (live: Calendar); the count says so, never a title.
        // Spotlight's panel is not a window the model works in.
        if app.bundleIdentifier != "com.apple.Spotlight" {result["windowCount"]=min(onScreenWindowCount(app.processIdentifier,list:list),99)}
        for window in list where windows.count<12 {
            guard let pid=window[kCGWindowOwnerPID as String] as? Int,pid != Int(getppid()),let other=NSRunningApplication(processIdentifier:pid_t(pid)),!protectedApps.contains(where:{(other.bundleIdentifier ?? "").lowercased().contains($0.lowercased())}),let title=window[kCGWindowName as String] as? String,!title.isEmpty else{continue}
            let entry=["appName":other.localizedName ?? "", "title":String(title.prefix(300))]
            if !windows.contains(entry){windows.append(entry)}
        }
    }
    result["recentWindows"]=windows;result["recentFiles"]=recentFiles
    // The rest of the picture: what else is open, and what has arrived.
    let open=openAppLines(openApplications())
    if !open.isEmpty {result["openApps"]=open}
    watchNotifications()
    let now=Date().timeIntervalSince1970
    let recent=withState { notificationsEnabled ? deliveredNotifications : [] }
        .filter { now - $0.at <= notificationHorizonSeconds }
    if !recent.isEmpty {result["notifications"]=recent.map { notificationLine($0, now: now) }}
    // Tell the model when this application publishes no usable accessibility,
    // so it stops guessing pixels and drives the menu bar and shortcuts. The
    // menu bar is a native NSMenu and normally survives a blind window; the
    // titles are bounded and carry no menu contents.
    let focusedRole=attribute(element,kAXFocusedUIElementAttribute).flatMap{attribute($0 as! AXUIElement,kAXRoleAttribute) as? String} ?? ""
    if let level=accessibilityLevel(element,focusedRole:focusedRole,hitTarget:false) {
        result["accessibility"]=level.rawValue
    }
    let menus=menuMap(element, pid: app.processIdentifier).lines
    if !menus.isEmpty {result["menus"]=menus}
    return result
}
let pointerEventTypes:[CGEventType] = [.mouseMoved,.leftMouseDragged,.rightMouseDragged,.leftMouseDown,.rightMouseDown,.otherMouseDown,.leftMouseUp,.rightMouseUp]
func postInput(_ event:CGEvent?) {
    guard let event = event else {return}
    stateLock.lock()
    lastInputTime = ProcessInfo.processInfo.systemUptime
    if event.type == .keyDown && event.getIntegerValueField(.keyboardEventKeycode) == 49 && event.flags.intersection([.maskCommand,.maskControl,.maskAlternate,.maskShift]) == .maskCommand {
        forwardedSpotlightDeadline = lastInputTime + 0.15
    }
    // WindowServer echoes our own pointer events at fractional positions.
    if pointerEventTypes.contains(event.type) {lastPointerPosition = event.location;pointerGraceUntil = lastInputTime + 0.75}
    // Recorded and posted under the lock: once an exit path has released held
    // input and holds the lock, no later press can be posted.
    heldInput.record(type:event.type,location:event.location,keyCode:CGKeyCode(truncatingIfNeeded:event.getIntegerValueField(.keyboardEventKeycode)))
    event.setIntegerValueField(.eventSourceUserData,value:inputMarker);event.post(tap:.cghidEventTap)
    stateLock.unlock()
}
// Releases anything still pressed and ends the process without unlocking, so
// no request thread can post input afterwards. With a signal, the default
// action is re-raised so the parent still observes that signal.
func releaseHeldInputAndExit(signal terminating: Int32? = nil) -> Never {
    stateLock.lock()
    stopped = true
    let held = heldInput; heldInput = HeldInput()
    func post(_ event: CGEvent?) { event?.setIntegerValueField(.eventSourceUserData,value:inputMarker);event?.post(tap:.cghidEventTap) }
    if let point = held.leftButton { post(CGEvent(mouseEventSource:nil,mouseType:.leftMouseUp,mouseCursorPosition:point,mouseButton:.left)) }
    if let point = held.rightButton { post(CGEvent(mouseEventSource:nil,mouseType:.rightMouseUp,mouseCursorPosition:point,mouseButton:.right)) }
    for code in held.keys.reversed() { post(CGEvent(keyboardEventSource:nil,virtualKey:code,keyDown:false)) }
    if let tap = tap { CGEvent.tapEnable(tap:tap, enable:false) }
    if let terminating = terminating { signal(terminating,SIG_DFL);kill(getpid(),terminating) }
    _exit(0)
}
// Notes one input event of the user's own; cheap and lock-protected, safe on
// the event tap path.
func recordManualInput(_ kind: ManualInputKind?) {
    guard let kind = kind else { return }
    let now = ProcessInfo.processInfo.systemUptime
    idleLock.lock(); manualInputEpisode.observe(kind: kind, at: now); lastManualInputAt = now; idleLock.unlock()
}
// Whether something holds the display awake (conferencing apps sharing the
// screen, video players, browsers playing media, Keynote, caffeinate). Idle
// input then does not mean the user has left. A failed read counts as held:
// that only delays a texted task, the side on which it never takes a screen
// someone may be watching.
func displayHeldAwake() -> Bool {
    var assertions: Unmanaged<CFDictionary>?
    guard IOPMCopyAssertionsStatus(&assertions) == kIOReturnSuccess,
          let status = assertions?.takeRetainedValue() as? [String: Any] else { return true }
    let level = status[kIOPMAssertionTypePreventUserIdleDisplaySleep as String] as? NSNumber
    return (level?.intValue ?? 0) != 0
}
// Whether someone seems to be at the Mac, for main's presence rules. Reads a
// few system counters and returns in well under a millisecond: no input is
// sent, no window is touched and no permission is needed. Safe off the main
// thread and outside the command queue: it takes only idleLock.
func presence() -> [String: Any] {
    let now = ProcessInfo.processInfo.systemUptime
    idleLock.lock(); let installed = tapInstalledAt, lastManual = lastManualInputAt; idleLock.unlock()
    // kCGAnyInputEventType is ~0; an unreadable counter reads as just active.
    let hidIdle = CGEventType(rawValue: ~0).map { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) } ?? 0
    let session = CGSessionCopyCurrentDictionary() as? [String: Any]
    // CGSSessionScreenIsLocked is undocumented; kCGSessionOnConsoleKey is
    // false during fast user switching. Both are best effort.
    return presenceReport(hidIdleSeconds: hidIdle, tapInstalledAt: installed, lastManualInputAt: lastManual, now: now,
                          screenLocked: session?["CGSSessionScreenIsLocked"] as? Bool,
                          onConsole: session?[kCGSessionOnConsoleKey as String] as? Bool,
                          displayAsleep: CGDisplayIsAsleep(CGMainDisplayID()) != 0,
                          displayHeldAwake: displayHeldAwake()).dictionary
}
// Tells main when the user's manual input has gone quiet (idleMs 1000, then
// 3000), so it can decide whether a paused run continues. Informational only:
// nothing here changes the stop latch.
func startIdleReporting() {
    guard idleTimer == nil else { return }
    let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
    timer.schedule(deadline: .now() + .milliseconds(150), repeating: .milliseconds(150), leeway: .milliseconds(30))
    timer.setEventHandler {
        idleLock.lock(); let reports = manualInputEpisode.tick(now: ProcessInfo.processInfo.systemUptime); idleLock.unlock()
        for report in reports { emit(report.event) }
    }
    idleTimer = timer
    timer.resume()
}
// Anchor bookkeeping for one unmarked pointer event: its travel from the anchor
// and whether it is an echo or jitter that pointerTakeover rejects. Ignored
// events keep the anchor, so slow real drift still accumulates.
func classifyUserPointer(type: CGEventType, event: CGEvent) -> (ignored: Bool, distance: Double) {
    stateLock.lock(); defer { stateLock.unlock() }
    let previous = lastPointerPosition
    var distance: Double = 0
    if let previous = previous { distance = hypot(event.location.x-previous.x, event.location.y-previous.y) }
    let ignored = type == .mouseMoved && !pointerTakeover(previous:previous,current:event.location,deltaX:event.getIntegerValueField(.mouseEventDeltaX),deltaY:event.getIntegerValueField(.mouseEventDeltaY),graceActive:ProcessInfo.processInfo.systemUptime < pointerGraceUntil)
    if !ignored || previous == nil { lastPointerPosition = event.location }
    return (ignored, distance)
}
func installTap() -> Bool {
    if tap != nil { return true }
    let types:[CGEventType] = [.keyDown,.leftMouseDown,.rightMouseDown,.otherMouseDown,.mouseMoved,.leftMouseDragged,.rightMouseDragged,.scrollWheel]
    let mask = types.reduce(CGEventMask(0)){$0 | (1 << $1.rawValue)}
    tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly, eventsOfInterest: mask, callback: { _, type, event, _ in
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            // Input may have been missed while disabled: pause (resumable), and
            // cancel only if the tap cannot be re-armed.
            guard let tap = tap else { return Unmanaged.passUnretained(event) }
            CGEvent.tapEnable(tap:tap, enable:true)
            if !CGEvent.tapIsEnabled(tap:tap) {latch(true);emit(["event":"emergency_stop"])}
            else if !isStopped() {latch(true);emit(["event":"user_takeover","source":"tap_timeout","eventType":type.rawValue])}
            return Unmanaged.passUnretained(event)
        }
        let pointer = [.mouseMoved,.leftMouseDragged,.rightMouseDragged,.leftMouseDown,.rightMouseDown,.otherMouseDown].contains(type)
        let marked = event.getIntegerValueField(.eventSourceUserData) == inputMarker
        if marked {
            if pointer {stateLock.lock();lastPointerPosition = event.location;stateLock.unlock()}
            return Unmanaged.passUnretained(event)
        }
        let escape = type == .keyDown && event.getIntegerValueField(.keyboardEventKeycode) == 53
        // Echoes and resting-hand jitter are neither takeover nor manual input.
        var pointerDistance:Double = 0
        if pointer {
            let classified = classifyUserPointer(type:type, event:event)
            if classified.ignored {return Unmanaged.passUnretained(event)}
            pointerDistance = classified.distance
        }
        // Already stopped: no takeover to report, so skip per-event app lookups,
        // but note the input so main learns when the user lets go.
        if isStopped() {
            if escape {
                let now = ProcessInfo.processInfo.systemUptime
                let stop = withState { () -> Bool in let fire = emergencyEscape(now: now, lastEscapeAt: lastEscapeAt, watching: watching); lastEscapeAt = now; return fire }
                if stop {emit(["event":"emergency_stop"])}
            }
            // Our own Command-Space re-posted by Siri is not the user's input;
            // checked by its deadline alone, without the app lookup.
            let echoed = type == .keyDown && withState { forwardedSpotlightEvent(type:type,keyCode:event.getIntegerValueField(.keyboardEventKeycode),flags:event.flags,systemSiri:true,now:ProcessInfo.processInfo.systemUptime,deadline:forwardedSpotlightDeadline) }
            if !echoed {recordManualInput(manualInputKind(type:type, marked:marked))}
            return Unmanaged.passUnretained(event)
        }
        let source = NSRunningApplication(processIdentifier:pid_t(event.getIntegerValueField(.eventSourceUnixProcessID)))
        let systemSiri = source?.bundleIdentifier == "com.apple.Siri" && source?.executableURL?.path == "/System/Library/CoreServices/Siri.app/Contents/MacOS/Siri"
        stateLock.lock()
        let forwarded = forwardedSpotlightEvent(type:type,keyCode:event.getIntegerValueField(.keyboardEventKeycode),flags:event.flags,systemSiri:systemSiri,now:ProcessInfo.processInfo.systemUptime,deadline:forwardedSpotlightDeadline)
        if forwarded {forwardedSpotlightDeadline = 0}
        stateLock.unlock()
        if forwarded {emit(["event":"input_forwarded","source":"spotlight"]);return Unmanaged.passUnretained(event)}
        recordManualInput(manualInputKind(type:type, marked:marked))
        if escape {latch(true);emit(["event":"emergency_stop"])}
        else if !isStopped() {latch(true);emit(["event":"user_takeover","source":type == .mouseMoved ? "mouse_move" : type == .keyDown ? "key" : type == .scrollWheel ? "scroll" : "mouse_button_or_drag","delta_x":event.getIntegerValueField(.mouseEventDeltaX),"delta_y":event.getIntegerValueField(.mouseEventDeltaY),"sourcePid":event.getIntegerValueField(.eventSourceUnixProcessID),"eventType":type.rawValue,"flags":event.flags.rawValue,"pointerDistance":pointerDistance])}
        return Unmanaged.passUnretained(event)
    }, userInfo:nil)
    guard let tap = tap else { return false }
    let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
    CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes); CGEvent.tapEnable(tap:tap, enable:true)
    idleLock.lock(); tapInstalledAt = ProcessInfo.processInfo.systemUptime; idleLock.unlock()
    startIdleReporting()
    return true
}
func geometry(_ display: SCDisplay, width: Int, height: Int) -> [String:Any] {
    let b = CGDisplayBounds(display.displayID)
    return ["display_id":Int(display.displayID),"x":Double(b.origin.x),"y":Double(b.origin.y),"width":Double(b.width),"height":Double(b.height),"native_width":CGDisplayPixelsWide(display.displayID),"native_height":CGDisplayPixelsHigh(display.displayID),"model_width":width,"model_height":height,"scale_factor":Double(CGDisplayPixelsWide(display.displayID))/Double(b.width)]
}
/// Blocking work (image encoding, Vision) on a global queue, awaited off the
/// cooperative pool, so two such stages of a capture can run at once.
func offThread<T>(_ work: @escaping () -> T) async -> T {
    await withCheckedContinuation { continuation in
        DispatchQueue.global(qos: .userInitiated).async { continuation.resume(returning: work()) }
    }
}
@available(macOS 14.0, *)
func capture() async throws -> [String:Any] {
    try ensureRunning(); try guardSurface()
    // Stage times in ms travel with the frame (FrameCaptured in the diagnostics),
    // so a slow capture says where it spent the time. Each mark is the time since
    // the previous one; "ocr" and "encode" are only what remained after the
    // stages they overlap.
    let startedAt = ProcessInfo.processInfo.systemUptime
    var timings = [String:Int](), stageAt = startedAt
    func mark(_ stage: String) { let now = ProcessInfo.processInfo.systemUptime; timings[stage] = Int(((now - stageAt) * 1000).rounded()); stageAt = now }
    // Observe after our own input has reached the app and its short transition
    // has settled. The event tap and stop signal remain active during the wait.
    while true {
        if inputSettleRemaining() <= 0 {break}
        try await Task.sleep(nanoseconds:20_000_000);try ensureRunning()
    }
    mark("settle")
    guard CGPreflightScreenCaptureAccess() else { throw ControlError("Grant Screen Recording permission and restart the app.") }
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly:true)
    mark("content")
    guard let display = content.displays.first(where:{$0.displayID == displayID}) else { throw ControlError("Selected display is no longer connected.") }
    // Terminals are on the protected floor whatever the settings say, and their
    // windows can show secrets, so they are never in a screenshot either.
    let excluded = content.applications.filter { app in protectedApps.contains(where: { app.bundleIdentifier.lowercased().contains($0.lowercased()) }) || terminalApp(app.bundleIdentifier) || app.processID == getppid() || app.bundleIdentifier == "ai.coarena.openassist" }
    let filter = SCContentFilter(display:display, excludingApplications:excluded, exceptingWindows:[])
    let bounds = CGDisplayBounds(displayID), ratio = min(1, 1440 / bounds.width)
    let config = SCStreamConfiguration();config.width = Int(bounds.width*ratio);config.height = Int(bounds.height*ratio);config.showsCursor = false
    // Live suggestions, result lists and panel animations settle within a few
    // hundred milliseconds. Wait (bounded) for two agreeing samples before the
    // screenshot, and re-sample instead of failing when one changes under it.
    let stableDeadline = ProcessInfo.processInfo.systemUptime + 1.5
    func settledSample() async throws -> WindowState {
        var sample = windowState()
        while ProcessInfo.processInfo.systemUptime < stableDeadline {
            try await Task.sleep(nanoseconds:100_000_000);try ensureRunning()
            let next = windowState()
            if stableWindow(sample, next) {return next}
            sample = next
        }
        return sample
    }
    func attempt() async throws -> ([String:Any], WindowState, CGImage)? {
        let oldWindow = try await settledSample()
        let before = surface()
        let image = try await SCScreenshotManager.captureImage(contentFilter:filter, configuration:config)
        try ensureRunning(); try guardSurface()
        let afterWindow = windowState()
        return stableWindow(oldWindow, afterWindow) ? (before, afterWindow, image) : nil
    }
    var captured = try await attempt()
    for _ in 0..<2 where captured == nil { captured = try await attempt() }
    guard let (before, afterWindow, image) = captured else { throw changedScreen("The active window changed during capture.") }
    mark("shot")
    // The PNG is only for the model: encode it while accessibility is read.
    let encoding = Task { await offThread { NSBitmapImageRep(cgImage:image).representation(using:.png, properties:[:]) } }
    var context=screenContext();try ensureRunning()
    mark("context")
    // Little or no text from accessibility: read it from the screenshot, while
    // the controls are walked (Vision and the accessibility walk are independent).
    var reading: Task<String, Never>?
    if !context.isEmpty, (context["visibleText"] as? String ?? "").count < 600 {
        let window = afterWindow.bounds, display = CGDisplayBounds(displayID)
        reading = Task { await offThread { recognizeScreenText(image, window: window, display: display) } }
    }
    if !context.isEmpty {
        var controls = groundedControls(afterWindow, display: bounds)
        // Web pages nest their controls deeper than the safety walk reaches.
        if browserAppIDs.contains(afterWindow.appId), let window = afterWindow.window {
            controls = mergeControls(controls, webControls(window, display: bounds), limit: 60)
        }
        context["controls"] = controls
    }
    mark("controls")
    if let reading { let text = await reading.value; if text.count > 40 { context["screenText"] = text } }
    mark("ocr")
    try ensureRunning()
    guard let png = await encoding.value else { throw ControlError("Screenshot encoding failed.") }
    mark("encode")
    timings["total"] = Int(((ProcessInfo.processInfo.systemUptime - startedAt) * 1000).rounded())
    let frame: [String:Any] = ["id":UUID().uuidString.lowercased(),"sha256":SHA256.hash(data:png).map{String(format:"%02x",$0)}.joined(),"image":"data:image/png;base64,"+png.base64EncodedString(),"geometry":geometry(display,width:config.width,height:config.height),"capturedAt":ProcessInfo.processInfo.systemUptime*1000,"synthetic":false,"appId":before["appId"] ?? "unknown","context":context,"timings":timings]
    guard let pixels = ScreenPixels(image) else { throw ControlError("Screenshot comparison failed.") }
    setCurrentFrame(["frame":frame,"pid":before["pid"] ?? 0,"window":afterWindow,"pixels":pixels])
    return frame
}
// menuRoute: the item a hotkey will be pressed through (currentHotkeyRoute),
// chosen once by the caller so the check and the input agree on the target.
// approved: the runner's check after the user approved the step, which never
// takes the by-name shortcut for a hotkey (revalidatesByName).
@available(macOS 14.0, *)
func revalidate(_ action: [String:Any], menuRoute: [String]?, approved: Bool) async throws -> [String:Any] {
    try ensureRunning(); try guardSurface()
    guard let saved = getCurrentFrame(), let previous = saved["frame"] as? [String:Any],
          action["frame_id"] as? String == previous["id"] as? String,
          let oldWindow = saved["window"] as? WindowState, let oldPixels = saved["pixels"] as? ScreenPixels,
          let oldGeometry = previous["geometry"] as? [String:Any] else { throw changedScreen("The observation is no longer current.") }
    // No age limit here: a slow approval is safe because the step is compared
    // against a fresh capture below.
    // Check the ORIGINAL window before capture replaces currentFrame.
    guard sameWindow(oldWindow, windowState(), for: action) else { throw changedScreen("The active window moved or changed.") }
    // A named menu item or control is resolved again by name at the moment of
    // input, so a second screenshot proves nothing about it and costs a third
    // of a second. Skipped while the observation is recent enough for
    // execute's own age check; a slow approval still gets a fresh capture.
    // A hotkey pressed through its menu item is that menu item, until approved.
    let named = revalidatesByName(type: action["type"] as? String ?? "", menuRoute: menuRoute, approved: approved)
    if named,
       ProcessInfo.processInfo.systemUptime*1000 - (previous["capturedAt"] as? Double ?? 0) < 20000 {
        try ensureRunning(); return previous
    }
    let fresh = try await capture()
    guard let current = getCurrentFrame(), let newWindow = current["window"] as? WindowState,
          let pixels = current["pixels"] as? ScreenPixels, let geometry = fresh["geometry"] as? [String:Any],
          NSDictionary(dictionary: oldGeometry).isEqual(to: geometry), sameWindow(oldWindow, newWindow, for: action) else { throw changedScreen("The display or window changed.") }
    let appId = fresh["appId"] as? String ?? ""
    if independentNavigationShortcut(action,appId:appId) {
        // Carry a verified launch binding to the observation that replaced it.
        if action["type"] as? String == "open_app", let oldId = previous["id"] as? String, let newId = fresh["id"] as? String {
            withState { if let binding = launchBinding, binding.frameId == oldId { launchBinding = LaunchBinding(frameId:newId, name:binding.name, bundleId:binding.bundleId, path:binding.path) } }
        }
        try ensureRunning();return fresh
    }
    // A named menu item or listed control is resolved again immediately before
    // the input, so a page that animated or a list that reflowed changes
    // nothing about what is pressed.
    // The focused-field check below does not apply to an unapproved hotkey
    // pressed through its menu item: the item is the target, not whichever
    // element has focus.
    if named { try ensureRunning(); return fresh }
    // open_file opens a natively verified document or folder; like open_app it
    // does not target pixels or controls.
    if action["type"] as? String == "open_file" {
        if let oldId = previous["id"] as? String, let newId = fresh["id"] as? String {
            withState { if var binding = fileBinding, binding.frameId == oldId { binding.frameId = newId; fileBinding = binding } }
        }
        try ensureRunning();return fresh
    }
    let keyboard = ["type_text", "key", "hotkey"].contains(action["type"] as? String ?? "")
    if keyboard {
        guard sameElement(oldWindow.focused, newWindow.focused), oldWindow.focusedValue == newWindow.focusedValue, oldWindow.focusedSignature == newWindow.focusedSignature else { throw changedScreen("The focused field changed.") }
        if let focused=newWindow.focused,elementRect(focused) != nil,["AXTextField","AXTextArea","AXComboBox"].contains(attribute(focused,kAXRoleAttribute) as? String ?? ""),focusedEditingAction(action) {try ensureRunning();return fresh}
        if action["type"] as? String == "key",action["key"] as? String == "ENTER",oldWindow.addressBar,newWindow.addressBar {try ensureRunning();return fresh}
        // The application's own search command just opened the field this goes
        // to, in this same application and window (checked above), and nothing
        // else has happened since. Its results, artwork and caret animate as
        // the field opens; those pixels are not the target of the keystrokes.
        if let command = withState({ searchCommand }),
           searchCommandCurrent(commandPid: command.pid, commandAt: command.at, pid: newWindow.pid, now: ProcessInfo.processInfo.systemUptime) {
            try ensureRunning(); return fresh
        }
    }
    guard oldWindow.controls == newWindow.controls else { throw changedScreen("The window's controls changed.") }
    // Keyboard input goes to the focused element, verified identical above
    // (identity, value, selection, geometry). Pixels elsewhere in the window
    // (video, ads, Spotlight previews) are not its target.
    if keyboard, newWindow.focused != nil {try ensureRunning();return fresh}
    let display = CGDisplayBounds(displayID)
    let sx = Double(oldPixels.width) / display.width, sy = Double(oldPixels.height) / display.height
    let bounds = (oldWindow.bounds ?? display).intersection(display)
    let region = CGRect(x: (bounds.minX - display.minX)*sx, y: (bounds.minY - display.minY)*sy, width: bounds.width*sx, height: bounds.height*sy)
    // Stable, named accessibility controls may animate focus/hover/carets.
    // Their identity, labels, values, enabled state and geometry were checked
    // above. For pointer targets also verify the current hit-tested element.
    let stable = oldWindow.tracked.filter { old in newWindow.tracked.contains { CFEqual(old.element, $0.element) && old.bounds == $0.bounds && old.signature == $0.signature } }
    let masks = stable.map { control -> CGRect in
        let rect = control.bounds.insetBy(dx: -6, dy: -6)
        return CGRect(x:(rect.minX-display.minX)*sx,y:(rect.minY-display.minY)*sy,width:rect.width*sx,height:rect.height*sy)
    }
    var points = [CGPoint]()
    var allInStableControls = true
    for (xKey,yKey) in [("x","y"),("start_x","start_y"),("end_x","end_y")] {
        if let x = action[xKey] as? Double, let y = action[yKey] as? Double {
            guard x.isFinite, y.isFinite, x>=0, x<=1, y>=0, y<=1 else { throw ControlError("Invalid coordinates.") }
            let actual = CGPoint(x:display.minX+x*display.width,y:display.minY+y*display.height)
            if let control = stable.filter({$0.bounds.contains(actual)}).min(by:{$0.bounds.width*$0.bounds.height < $1.bounds.width*$1.bounds.height}) {
                guard hitMatches(control.element, at:actual) else { throw changedScreen("Another control covers the input target.") }
            } else { allInStableControls = false }
            points.append(CGPoint(x:x*Double(oldPixels.width),y:y*Double(oldPixels.height)))
        }
    }
    // Every point is inside an unchanged control that still hit-tests to the
    // same element: only the neighbourhood of the input matters.
    if allInStableControls && !points.isEmpty {
        guard !targetPixelsChanged(oldPixels, pixels, points: points, stableControls:masks) else { throw changedScreen("The input target changed.") }
        try ensureRunning(); return fresh
    }
    guard !oldPixels.changed(comparedTo: pixels, in: region, target: false, ignoring:masks) else { throw changedScreen("The window content changed.") }
    guard !framePixelsChanged(oldPixels, pixels, window: region, points: points, stableControls:masks) else { throw changedScreen("The input target changed.") }
    try ensureRunning(); return fresh
}
let keys: [String:CGKeyCode] = ["A":0,"S":1,"D":2,"F":3,"H":4,"G":5,"Z":6,"X":7,"C":8,"V":9,"B":11,"Q":12,"W":13,"E":14,"R":15,"Y":16,"T":17,"1":18,"2":19,"3":20,"4":21,"6":22,"5":23,"9":25,"7":26,"8":28,"0":29,"O":31,"U":32,"I":34,"P":35,"ENTER":36,"L":37,"J":38,"K":40,"N":45,"M":46,"TAB":48,"SPACE":49,"BACKSPACE":51,"ESC":53,"CMD":55,"SHIFT":56,"ALT":58,"CTRL":59,"HOME":115,"PAGEUP":116,"DELETE":117,"END":119,"PAGEDOWN":121,"LEFT":123,"RIGHT":124,"DOWN":125,"UP":126]
// Returns how a hotkey went: "menu" when pressed through its menu item
// (menuRoute, the path revalidate was given), "keys" when posted.
@discardableResult
func execute(_ action:[String:Any], menuRoute: [String]? = nil) throws -> String? {
    try ensureRunning(); try guardSurface()
    // Waiting and observing send no input, so window transitions must not reject them.
    switch action["type"] as? String {
    case "wait": guard let ms = action["milliseconds"] as? Int, ms>=0,ms<=5000 else {throw ControlError("Invalid wait.")};for _ in 0..<(ms/10){try ensureRunning();Thread.sleep(forTimeInterval:0.01)};return nil
    case "capture": return nil
    default: break
    }
    guard AXIsProcessTrusted() else { throw ControlError("Accessibility permission is required.") }
    stateLock.lock(); let saved = currentFrame; stateLock.unlock()
    guard let frame = saved?["frame"] as? [String:Any], let g = frame["geometry"] as? [String:Any], action["frame_id"] as? String == frame["id"] as? String else { throw changedScreen("Stale frame.") }
    guard ProcessInfo.processInfo.systemUptime*1000 - (frame["capturedAt"] as? Double ?? 0) < 30000 else { throw changedScreen("Frame expired.") }
    guard surface()["pid"] as? Int == saved?["pid"] as? Int else { throw changedScreen("Foreground application changed.") }
    guard let savedWindow = saved?["window"] as? WindowState, sameWindow(savedWindow, windowState(), for: action) else { throw changedScreen("The active window changed before input.") }
    let b = CGDisplayBounds(displayID)
    guard b.width == g["width"] as? Double, b.height == g["height"] as? Double, b.origin.x == g["x"] as? Double, b.origin.y == g["y"] as? Double else { throw changedScreen("Display geometry changed.") }
    func point(_ x:String,_ y:String) throws -> CGPoint { guard let nx = action[x] as? Double, let ny = action[y] as? Double, nx.isFinite,ny.isFinite,nx >= 0,nx <= 1,ny >= 0,ny <= 1 else { throw ControlError("Invalid coordinates.") };return CGPoint(x:b.minX+min(b.width-1,floor(nx*b.width)),y:b.minY+min(b.height-1,floor(ny*b.height))) }
    func mouse(_ type:CGEventType,_ p:CGPoint,_ button:CGMouseButton = .left,_ count:Int64 = 1) throws { try ensureRunning();guard let e = CGEvent(mouseEventSource:nil, mouseType:type, mouseCursorPosition:p, mouseButton:button) else { throw ControlError("Input event failed.") };e.setIntegerValueField(.mouseEventClickState,value:count);postInput(e) }
    switch action["type"] as? String {
    case "type_text", "menu_item": break
    // ENTER and TAB end a search or palette context like ESC; arrows mark its
    // selection moved and other keys its text edited (IdeSafety.swift). A
    // chord (CMD+ENTER runs a palette entry too) replaces it below with the
    // search its menu item opens, or with nothing.
    case "key": withState { searchCommand = nextSearchContext(searchCommand, .key(action["key"] as? String ?? "")) }
    // Through the menu, pressMenuPath notes the command once it is pressed.
    case "hotkey" where menuRoute == nil:
        if let names = action["keys"] as? [String], let app = inputApplication() {
            let menus = menuMap(AXUIElementCreateApplication(app.processIdentifier), pid: app.processIdentifier)
            noteCommand(menus.shortcuts[normalizeChord(names)]?.last, pid: app.processIdentifier, appId: app.bundleIdentifier ?? "")
        }
    case "hotkey": break
    default: withState { searchCommand = nil }
    }
    switch action["type"] as? String {
    case "click", "double_click", "right_click":
        let p = try point("x","y"), right = action["button"] as? String == "right" || action["type"] as? String == "right_click"
        for i in 1...(action["type"] as? String == "double_click" ? 2 : 1) {try mouse(right ? .rightMouseDown:.leftMouseDown,p,right ? .right:.left,Int64(i));postInput(CGEvent(mouseEventSource:nil,mouseType:right ? .rightMouseUp:.leftMouseUp,mouseCursorPosition:p,mouseButton:right ? .right:.left))}
    case "move": try mouse(.mouseMoved,try point("x","y"))
    case "drag":
        let start = try point("start_x","start_y"), end = try point("end_x","end_y"), duration = action["duration_ms"] as? Double ?? 0
        guard duration >= 100 && duration <= 2000 else { throw ControlError("Invalid drag duration.") }
        var last = start;try mouse(.leftMouseDown,start)
        defer {postInput(CGEvent(mouseEventSource:nil,mouseType:.leftMouseUp,mouseCursorPosition:last,mouseButton:.left))}
        for i in 1...20 {try ensureRunning();last = CGPoint(x:start.x+(end.x-start.x)*Double(i)/20,y:start.y+(end.y-start.y)*Double(i)/20);try mouse(.leftMouseDragged,last);Thread.sleep(forTimeInterval:duration/20000)}
    case "scroll":
        guard let dx = action["delta_x"] as? Int,let dy = action["delta_y"] as? Int,abs(dx)<=1000,abs(dy)<=1000 else {throw ControlError("Invalid scroll.")}
        postInput(CGEvent(scrollWheelEvent2Source:nil,units:.pixel,wheelCount:2,wheel1:Int32(-dy),wheel2:Int32(-dx),wheel3:0))
    case "type_text":
        guard let text = action["text"] as? String,text.count<=2000 else {throw ControlError("Invalid text.")}
        // The stop latch, secure input and the exact focused element are checked
        // per character; the full protected-surface walk is throttled so long
        // text stays within the request timeout.
        guard let inputApp = inputApplication() else { throw changedScreen("Foreground application changed.") }
        let inputPID = inputApp.processIdentifier, inputElement = AXUIElementCreateApplication(inputPID)
        func focusedElement() -> AXUIElement? {
            guard let value = attribute(inputElement,kAXFocusedUIElementAttribute), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
            return (value as! AXUIElement)
        }
        let typingTarget = focusedElement()
        var replaced = false
        // A query field that already holds text is replaced, not appended to:
        // select its contents first (by accessibility, falling back to the
        // field's own Select All) so the typed text becomes the whole query.
        if let target = typingTarget,
           replacesOnType(role: attribute(target,kAXRoleAttribute) as? String ?? "",
                          subrole: attribute(target,kAXSubroleAttribute) as? String ?? "",
                          label: fieldLabel(target)),
           let existing = attribute(target,kAXValueAttribute) as? String, !existing.isEmpty {
            let length = (existing as NSString).length
            var range = CFRange(location: 0, length: length)
            if let value = AXValueCreate(.cfRange, &range) {
                _ = AXUIElementSetAttributeValue(target, kAXSelectedTextRangeAttribute as CFString, value)
            }
            var selected = CFRange(location: 0, length: 0)
            let applied = attribute(target, kAXSelectedTextRangeAttribute).map { AXValueGetValue($0 as! AXValue, .cfRange, &selected) } ?? false
            if !(applied && selected.location == 0 && selected.length == length) {
                try ensureRunning()
                let down = CGEvent(keyboardEventSource:nil,virtualKey:0,keyDown:true); down?.flags = .maskCommand; postInput(down)
                let up = CGEvent(keyboardEventSource:nil,virtualKey:0,keyDown:false); up?.flags = .maskCommand; postInput(up)
                Thread.sleep(forTimeInterval: 0.05)
            }
            replaced = true
        }
        // A palette's text is not exact until every character is in: typing
        // that stops part-way leaves a prefix, which selects a different command.
        let typedInto = withState { () -> SearchContext? in
            let before = searchCommand; searchCommand = nextSearchContext(searchCommand, .interrupted(text, replaced: replaced)); return before
        }
        var sinceGuard = 0, lastGuard = ProcessInfo.processInfo.systemUptime
        for character in text {
            try ensureRunning()
            let focus = focusedElement()
            switch typingInterruption(secureInput:IsSecureEventInputEnabled(), focusUnchanged:sameElement(typingTarget, focus), secureField:focus.map { attribute($0,kAXSubroleAttribute) as? String == kAXSecureTextFieldSubrole } ?? false) {
            case .surfaceBlocked?: throw ControlError("Sensitive input is active; capture and input are blocked.", code: "SURFACE_BLOCKED")
            case .focusChanged?: throw changedScreen("The focused field changed while typing.")
            case nil: break
            }
            if sinceGuard >= 25 || ProcessInfo.processInfo.systemUptime - lastGuard >= 0.15 {
                try guardSurface()
                guard inputApplication()?.processIdentifier == inputPID else { throw changedScreen("Foreground application changed while typing.") }
                sinceGuard = 0;lastGuard = ProcessInfo.processInfo.systemUptime
            }
            sinceGuard += 1
            let utf16 = Array(String(character).utf16);let e = CGEvent(keyboardEventSource:nil,virtualKey:0,keyDown:true);e?.keyboardSetUnicodeString(stringLength:utf16.count,unicodeString:utf16);postInput(e);let up = CGEvent(keyboardEventSource:nil,virtualKey:0,keyDown:false);postInput(up)}
        // Only the same context (not one a pause or another command replaced)
        // learns the finished text.
        withState { if let before = typedInto, searchCommand?.pid == before.pid, searchCommand?.at == before.at { searchCommand = nextSearchContext(before, .typed(text, replaced: replaced)) } }
    case "menu_item":
        guard let path = action["path"] as? [String], path.count >= 2, path.count <= 3,
              path.allSatisfy({ !$0.trimmingCharacters(in: .whitespaces).isEmpty }) else { throw ControlError("Invalid menu path.") }
        try pressMenuPath(path)
    case "click_control":
        // Resolved again here, against the tree as it is at this instant: the
        // name is the intent, the position is only where it happens to be.
        let (match, resolved) = resolveNamedControl(action)
        guard case .matched = match, let control = resolved else {
            switch match {
            case .ambiguous(let count):
                throw ControlError("\(count) controls are named that. Name a different control, or add the x and y from the context list.", code: "TARGET_AMBIGUOUS")
            default:
                throw ControlError("No control named that is on screen now. Choose one from the context list.", code: "TARGET_MISSING")
            }
        }
        guard control.enabled else { throw ControlError("That control is disabled.", code: "TARGET_DISABLED") }
        let target = CGPoint(x: b.minX+min(b.width-1, floor(control.x*b.width)), y: b.minY+min(b.height-1, floor(control.y*b.height)))
        try mouse(.leftMouseDown, target)
        postInput(CGEvent(mouseEventSource:nil, mouseType:.leftMouseUp, mouseCursorPosition:target, mouseButton:.left))
    case "key", "hotkey":
        let names = action["keys"] as? [String] ?? [action["key"] as? String ?? ""]
        guard names.count<=4,names.allSatisfy({keys[$0] != nil}) else {throw ControlError("Unsupported key.")}
        guard clipboardChordAllowed(names: names, paste: action["paste"] as? Bool == true) else {throw ControlError("Clipboard disabled.")}
        // Pressed by name like menu_item, resolved again now: a refused, missing or
        // greyed-out item is reported, and its keys are never posted instead.
        if action["type"] as? String == "hotkey", let path = menuRoute { try pressMenuPath(path, chord: normalizeChord(names)); return "menu" }
        var flags:CGEventFlags = [];for name in names {if name == "CMD"{flags.insert(.maskCommand)};if name == "CTRL"{flags.insert(.maskControl)};if name == "ALT"{flags.insert(.maskAlternate)};if name == "SHIFT"{flags.insert(.maskShift)}}
        var pressed:[CGKeyCode] = [];defer {for code in pressed.reversed(){postInput(CGEvent(keyboardEventSource:nil,virtualKey:code,keyDown:false))}}
        for name in names {try ensureRunning();let code = keys[name]!;let e = CGEvent(keyboardEventSource:nil,virtualKey:code,keyDown:true);e?.flags = flags;postInput(e);pressed.append(code)}
        return action["type"] as? String == "hotkey" ? "keys" : nil
    default: throw ControlError("Unknown native action.")
    }
    return nil
}
final class LaunchOutcome: @unchecked Sendable {
    let lock = NSLock(); var done = false; var failed = false
    func finish(_ error: Error?) { lock.lock(); done = true; failed = error != nil; lock.unlock() }
    func state() -> (Bool, Bool) { lock.lock(); defer { lock.unlock() }; return (done, failed) }
}
func dispatchOpen(_ path: String) -> LaunchOutcome {
    let outcome = LaunchOutcome(), configuration = NSWorkspace.OpenConfiguration()
    // Launch only: no arguments, documents, URLs or environment.
    configuration.activates = true; configuration.addsToRecentItems = false
    configuration.createsNewApplicationInstance = false; configuration.promptsUserIfNeeded = false
    NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: path, isDirectory: true), configuration: configuration) { _, error in outcome.finish(error) }
    return outcome
}
// open_app does not target pixels or controls, so it skips window/pixel
// revalidation but keeps the stop latch, protected-surface, currency, age and
// display checks, and launches exactly the bundle the policy evaluated.
@available(macOS 14.0, *)
func openApplication(_ action:[String:Any]) async throws -> [String:Any] {
    try ensureRunning(); try guardSurface()
    guard AXIsProcessTrusted() else { throw ControlError("Accessibility permission is required.") }
    guard let saved = getCurrentFrame(), let frame = saved["frame"] as? [String:Any], let g = frame["geometry"] as? [String:Any],
          let frameId = frame["id"] as? String, action["frame_id"] as? String == frameId else { throw changedScreen("Stale frame.") }
    guard ProcessInfo.processInfo.systemUptime*1000 - (frame["capturedAt"] as? Double ?? 0) < 30000 else { throw changedScreen("Frame expired.") }
    let b = CGDisplayBounds(displayID)
    guard b.width == g["width"] as? Double, b.height == g["height"] as? Double, b.origin.x == g["x"] as? Double, b.origin.y == g["y"] as? Double else { throw changedScreen("Display geometry changed.") }
    let name = normalizeAppName(action["name"] as? String ?? "")
    guard let bound = withState({ launchBinding }), bound.frameId == frameId, bound.name == name else { throw ControlError("The application was not verified for this observation.", code: "APP_UNRESOLVED") }
    // Independent re-check: the same resolution, a still-valid bundle at the
    // same place, and the denial rules as they are now.
    let appId: String, display: String, path: String
    switch resolveLaunch(query: name, candidates: applicationCandidates(), protectedApps: protectedApps) {
    case .refused: throw ControlError("That application must be opened manually.", code: "APP_REFUSED")
    case .resolved(let id, let resolvedName, let resolvedPath): appId = id; display = resolvedName; path = resolvedPath
    default: throw ControlError("The application no longer resolves to one verified application.", code: "APP_UNRESOLVED")
    }
    let allowed = allowedApplicationRealRoots()
    guard let current = applicationCandidate(at: path, rootIndex: 0, allowedRoots: allowed), current.bundleId == appId else { throw ControlError("The application changed after it was verified.", code: "APP_UNRESOLVED") }
    guard !launchCandidateDenied(current, protectedApps: protectedApps) else { throw ControlError("That application must be opened manually.", code: "APP_REFUSED") }
    guard appId == bound.bundleId, path == bound.path else { throw ControlError("The application changed after it was verified.", code: "APP_UNRESOLVED") }
    try ensureRunning()
    let running = NSRunningApplication.runningApplications(withBundleIdentifier: appId).first { !$0.isTerminated }
    let wasRunning = running != nil
    func frontmost() -> Bool { NSWorkspace.shared.frontmostApplication?.bundleIdentifier?.lowercased() == appId.lowercased() }
    var outcome: LaunchOutcome? = nil
    if let running = running {
        if running.isHidden { running.unhide() }
        running.activate(options: [])
    } else {
        outcome = dispatchOpen(path)
        // A cold launch reports completion once the process exists; bounded so
        // the request stays well inside the helper timeout.
        let deadline = ProcessInfo.processInfo.systemUptime + 6
        while ProcessInfo.processInfo.systemUptime < deadline {
            let (done, failed) = outcome!.state()
            if failed { throw ControlError("The application could not be opened.", code: "LAUNCH_FAILED") }
            if done || frontmost() { break }
            try await Task.sleep(nanoseconds: 50_000_000); try ensureRunning()
        }
    }
    let started = ProcessInfo.processInfo.systemUptime
    var reopened = false
    while !frontmost() && ProcessInfo.processInfo.systemUptime - started < 2.5 {
        try await Task.sleep(nanoseconds: 50_000_000); try ensureRunning()
        // Background activation can be declined; LaunchServices activation of the
        // same verified bundle is the reliable fallback (like a Dock click).
        // Only when the app already shows a window: a windowless app would answer
        // the reopen event with an Open panel or a new document.
        let elapsed = ProcessInfo.processInfo.systemUptime - started
        if launchReopenAllowed(wasRunning: wasRunning, alreadyReopened: reopened, elapsed: elapsed, onScreenWindows: 1) {
            // Checked once, when the fallback would first apply.
            reopened = true
            if launchReopenAllowed(wasRunning: wasRunning, alreadyReopened: false, elapsed: elapsed, onScreenWindows: running.map { onScreenWindowCount($0.processIdentifier) } ?? 0) { outcome = dispatchOpen(path) }
        }
        if let outcome = outcome, outcome.state().1 && !wasRunning { throw ControlError("The application could not be opened.", code: "LAUNCH_FAILED") }
    }
    var launched: [String:Any] = ["appId": appId, "name": display, "frontmost": frontmost(), "wasRunning": wasRunning]
    // A running app can come to the front with no window (live: Calendar),
    // leaving the screenshot to the app behind it; the reopen above is refused
    // for windowless apps, so its own Window menu shows the main window. Only
    // for an app that was running: a cold launch opens its own window, and its
    // count right now would only race it. An unhidden app's windows, or ones
    // on a Space macOS is still switching to, arrive a moment after it turns
    // frontmost, so none counts only once settled (LaunchSafety.swift). The
    // waits stay inside the timeout.
    if wasRunning, let running, frontmost() {
        let pid = running.processIdentifier, since = ProcessInfo.processInfo.systemUptime
        var windows = onScreenWindowCount(pid), restored = false
        while !windowCountSettled(windows: windows, waited: ProcessInfo.processInfo.systemUptime - since) {
            try await Task.sleep(nanoseconds: 50_000_000); try ensureRunning()
            windows = onScreenWindowCount(pid)
        }
        if windows == 0, try restoreMainWindow(pid: pid, bundleId: appId, appNames: [running.localizedName ?? "", display]) {
            let deadline = ProcessInfo.processInfo.systemUptime + 1.5
            while windows == 0 && ProcessInfo.processInfo.systemUptime < deadline {
                try await Task.sleep(nanoseconds: 50_000_000); try ensureRunning()
                windows = onScreenWindowCount(pid)
            }
            restored = windows > 0
        }
        launched["windows"] = windows; launched["restoredWindow"] = restored
    }
    withState { lastInputTime = ProcessInfo.processInfo.systemUptime; launchBinding = nil }
    return ["executed": true, "launched": launched]
}
final class FileOpenOutcome: @unchecked Sendable {
    let lock = NSLock(); var done = false; var failed = false; var appId: String? = nil
    func finish(_ app: NSRunningApplication?, _ error: Error?) { lock.lock(); done = true; failed = error != nil; appId = app?.bundleIdentifier; lock.unlock() }
    func state() -> (done: Bool, failed: Bool, appId: String?) { lock.lock(); defer { lock.unlock() }; return (done, failed, appId) }
}
// open_file mirrors open_app: stop latch, protected surface, currency, age and
// display checks, a binding made by surface() for this observation, and an
// independent re-resolution under the current rules (path and default
// application) before LaunchServices opens the item with exactly the
// application that was checked.
@available(macOS 14.0, *)
func openFile(_ action:[String:Any]) async throws -> [String:Any] {
    try ensureRunning(); try guardSurface()
    guard AXIsProcessTrusted() else { throw ControlError("Accessibility permission is required.") }
    guard let saved = getCurrentFrame(), let frame = saved["frame"] as? [String:Any], let g = frame["geometry"] as? [String:Any],
          let frameId = frame["id"] as? String, action["frame_id"] as? String == frameId else { throw changedScreen("Stale frame.") }
    guard ProcessInfo.processInfo.systemUptime*1000 - (frame["capturedAt"] as? Double ?? 0) < 30000 else { throw changedScreen("Frame expired.") }
    let b = CGDisplayBounds(displayID)
    guard b.width == g["width"] as? Double, b.height == g["height"] as? Double, b.origin.x == g["x"] as? Double, b.origin.y == g["y"] as? Double else { throw changedScreen("Display geometry changed.") }
    let requested = action["path"] as? String ?? ""
    let appName = action["app"] as? String
    guard let bound = withState({ fileBinding }), bound.frameId == frameId, bound.requested == requested, bound.app == appName.map(normalizeAppName) else { throw ControlError("The file was not verified for this observation.", code: "FILE_UNRESOLVED") }
    // A named application is resolved again under the rules as they are now,
    // like open_app does, and must be the one the policy saw.
    var named: LaunchCandidate? = nil
    if let appName {
        guard case .resolved(let appId, _, let path) = resolveLaunch(query: appName, candidates: applicationCandidates(), protectedApps: protectedApps) else { throw ControlError("That application must be opened manually.", code: "APP_REFUSED") }
        guard let candidate = applicationCandidate(at: path, rootIndex: 0, allowedRoots: allowedApplicationRealRoots()), candidate.bundleId == appId,
              !launchCandidateDenied(candidate, protectedApps: protectedApps) else { throw ControlError("That application must be opened manually.", code: "APP_REFUSED") }
        named = candidate
    }
    let plan: FileOpenPlan
    switch checkOpenFile(requested, in: named) {
    case .refused: throw ControlError("That item must be opened manually.", code: "FILE_REFUSED")
    case .unresolved: throw ControlError("The file no longer resolves to one verified item.", code: "FILE_UNRESOLVED")
    case .resolved(let current): plan = current
    }
    // Same item, same opened target and same default application as verified.
    guard plan == bound.plan else { throw ControlError("The file changed after it was verified.", code: "FILE_UNRESOLVED") }
    let path = plan.path, kind = plan.kind
    try ensureRunning()
    let outcome = FileOpenOutcome(), configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = true; configuration.addsToRecentItems = false; configuration.promptsUserIfNeeded = false
    NSWorkspace.shared.open([URL(fileURLWithPath: plan.opens, isDirectory: kind == .folder)], withApplicationAt: URL(fileURLWithPath: plan.handlerPath, isDirectory: true), configuration: configuration) { app, error in outcome.finish(app, error) }
    // The opened item's last-used date changed; the next index reads it fresh.
    withState { lastInputTime = ProcessInfo.processInfo.systemUptime; fileBinding = nil; indexRecentCache = nil }
    let deadline = ProcessInfo.processInfo.systemUptime + 6
    while ProcessInfo.processInfo.systemUptime < deadline {
        let state = outcome.state()
        if state.failed { throw ControlError("The item could not be opened.", code: "OPEN_FAILED") }
        if state.done { break }
        try await Task.sleep(nanoseconds: 50_000_000); try ensureRunning()
    }
    // Past the cap the request was still handed to LaunchServices; report what
    // is frontmost rather than a failure that may not be true.
    let state = outcome.state()
    let expected = (state.appId ?? plan.handlerId).lowercased()
    func settled() -> Bool { NSWorkspace.shared.frontmostApplication?.bundleIdentifier?.lowercased() == expected }
    let started = ProcessInfo.processInfo.systemUptime
    while !settled() && ProcessInfo.processInfo.systemUptime - started < 2 {
        try await Task.sleep(nanoseconds: 50_000_000); try ensureRunning()
    }
    withState { lastInputTime = ProcessInfo.processInfo.systemUptime }
    var opened: [String:Any] = ["path": path, "kind": kind.rawValue]
    if let front = NSWorkspace.shared.frontmostApplication?.bundleIdentifier { opened["appId"] = front }
    return ["executed": true, "opened": opened]
}
// MARK: watch
// A window bound for a detached watch: the frontmost application's focused
// window at the time, found on screen by its owner and bounds. The token is
// the only name a probe may use for it.
struct WatchBinding { let token: String; let pid: pid_t; let windowID: CGWindowID; let appId: String; let title: String }
struct OcrLine { let t: String; let x: Double; let y: Double; let w: Double; let h: Double }
// Applications a watch never reads or brings forward: the protected floor,
// terminals, launchers and this app itself.
func watchRefused(_ appId: String) -> Bool {
    let id = appId.lowercased()
    return id.isEmpty || protectedApps.contains { id.contains($0.lowercased()) } || terminalApp(id) || launchFloorDenied.contains(id)
        || launchRefusedPrefixes.contains { id.hasPrefix($0) } || id == "com.apple.spotlight"
}
// When the tap last saw the user's own input; a plain function so the async
// probe never holds the lock across a suspension point.
func lastManualInput() -> TimeInterval? { idleLock.lock(); defer { idleLock.unlock() }; return lastManualInputAt }
func screenLocked() -> Bool {
    let session = CGSessionCopyCurrentDictionary() as? [String: Any]
    return session?["CGSSessionScreenIsLocked"] as? Bool == true
}
private func nearly(_ a: CGRect, _ b: CGRect) -> Bool {
    abs(a.minX - b.minX) <= 2 && abs(a.minY - b.minY) <= 2 && abs(a.width - b.width) <= 2 && abs(a.height - b.height) <= 2
}
private func round3(_ value: Double) -> Double { (value * 1000).rounded() / 1000 }
// The bound window's accessibility element, found by its current bounds; nil
// once it is gone or cannot be told apart.
func watchWindowElement(pid: pid_t, windowID: CGWindowID) -> AXUIElement? {
    guard let info = (CGWindowListCopyWindowInfo(.optionIncludingWindow, windowID) as? [[String:Any]])?.first,
          let rawBounds = info[kCGWindowBounds as String] as? [String:Any], let rect = CGRect(dictionaryRepresentation: rawBounds as CFDictionary) else { return nil }
    let element = AXUIElementCreateApplication(pid)
    return (attribute(element, kAXWindowsAttribute) as? [AXUIElement] ?? []).first { elementRect($0).map { nearly($0, rect) } == true }
}
// The domain of the page a window shows, read the way surface() reads it for
// the focused window (its document, its URL, else its web area).
func windowDomain(_ window: AXUIElement) -> String? {
    if let url = attribute(window, "AXDocument") as? String, let host = URL(string: url)?.host?.lowercased(), !host.isEmpty { return host }
    if let url = attribute(window, "AXURL") as? URL, let host = url.host?.lowercased(), !host.isEmpty { return host }
    return webAreaHost(window)
}
// Whether the window shows a page a watch may not read; nil for a window that
// cannot be found, which is the caller's window_gone.
func watchWindowProtected(appId: String, window: AXUIElement?) -> Bool {
    let browser = browserAppIDs.contains(appId)
    guard browser else { return false }
    return watchDomainRefused(domain: window.flatMap(windowDomain), browser: true, protectedDomains: protectedDomains)
}
// Binds the frontmost application's focused window. Refuses what a capture
// would exclude, so a watch is never a way to read a protected window.
func bindWatch() throws -> [String:Any] {
    guard CGPreflightScreenCaptureAccess() else { throw ControlError("Grant Screen Recording permission and restart the app.") }
    guard AXIsProcessTrusted() else { throw ControlError("Accessibility permission is required.") }
    guard let app = NSWorkspace.shared.frontmostApplication, app.processIdentifier != getppid() else { throw ControlError("No application is in front.") }
    let appId = app.bundleIdentifier ?? ""
    guard !watchRefused(appId) else { throw ControlError("That application cannot be watched.", code: "SURFACE_BLOCKED") }
    guard withState({ watchBindings.count }) < watchBindingsMax else { throw ControlError("Too many windows are being watched.") }
    let element = AXUIElementCreateApplication(app.processIdentifier)
    guard let raw = attribute(element, kAXFocusedWindowAttribute) else { throw ControlError("No window is focused.") }
    let window = raw as! AXUIElement
    guard !watchWindowProtected(appId: appId, window: window) else { throw ControlError("That page cannot be watched.", code: "SURFACE_BLOCKED") }
    guard let bounds = elementRect(window), bounds.width > 40, bounds.height > 40 else { throw ControlError("The focused window has no usable bounds.") }
    let title = String((attribute(window, kAXTitleAttribute) as? String ?? "").prefix(300))
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String:Any]] else { throw ControlError("Windows could not be listed.") }
    var match: CGWindowID? = nil
    for info in list {
        guard (info[kCGWindowOwnerPID as String] as? Int) == Int(app.processIdentifier), (info[kCGWindowLayer as String] as? Int) == 0,
              let rawBounds = info[kCGWindowBounds as String] as? [String:Any], let rect = CGRect(dictionaryRepresentation: rawBounds as CFDictionary),
              let number = info[kCGWindowNumber as String] as? Int, nearly(rect, bounds) else { continue }
        match = CGWindowID(number); break
    }
    guard let windowID = match else { throw ControlError("The focused window could not be identified on screen.") }
    let token = UUID().uuidString.lowercased()
    withState { watchBindings[token] = WatchBinding(token: token, pid: app.processIdentifier, windowID: windowID, appId: appId, title: title) }
    return ["token": token, "appId": appId, "pid": Int(app.processIdentifier), "windowId": Int(windowID), "title": title]
}
// The binding a token names, and nothing else.
func boundWatch(_ token: String) -> WatchBinding? {
    guard let bound = withState({ watchBindings[token] }), watchProbeAllowed(token: token, bound: bound.token) else { return nil }
    return bound
}
// The part of the window to read, as fractions of it with the origin at the
// top left; nil reads the whole window.
func watchRegion(_ value: [String:Any]?) -> CGRect? {
    guard let value, let x = value["x"] as? Double, let y = value["y"] as? Double, let w = value["w"] as? Double, let h = value["h"] as? Double,
          x.isFinite, y.isFinite, w.isFinite, h.isFinite, x >= 0, y >= 0, x < 1, y < 1, w > 0.05, h > 0.05 else { return nil }
    return CGRect(x: x, y: y, width: min(w, 1 - x), height: min(h, 1 - y))
}
/**
 Text lines inside an image with their boxes as fractions of it (origin top
 left), top to bottom then left to right. The region, when given, is cropped
 out first so the boxes come back in the whole window's fractions whatever
 Vision does with a region of interest. Bounded: 400 lines of 200 characters.
 */
func recognizeLines(_ image: CGImage, region: CGRect?, maxLines: Int = 400, maxChars: Int = 200) -> [OcrLine] {
    var source = image, origin = CGRect(x: 0, y: 0, width: 1, height: 1)
    if let region {
        let pixels = CGRect(x: region.minX * CGFloat(image.width), y: region.minY * CGFloat(image.height), width: region.width * CGFloat(image.width), height: region.height * CGFloat(image.height)).integral
        if pixels.width >= 8, pixels.height >= 8, let cropped = image.cropping(to: pixels) { source = cropped; origin = region }
    }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    request.minimumTextHeight = 0.01
    guard (try? VNImageRequestHandler(cgImage: source).perform([request])) != nil else { return [] }
    let observations = (request.results ?? []).sorted {
        abs($0.boundingBox.midY - $1.boundingBox.midY) > 0.008 ? $0.boundingBox.midY > $1.boundingBox.midY : $0.boundingBox.minX < $1.boundingBox.minX
    }
    var lines = [OcrLine]()
    for observation in observations where lines.count < maxLines {
        guard let text = observation.topCandidates(1).first?.string.trimmingCharacters(in: .whitespaces), !text.isEmpty else { continue }
        let box = observation.boundingBox
        lines.append(OcrLine(t: String(text.prefix(maxChars)), x: round3(origin.minX + box.minX * origin.width), y: round3(origin.minY + (1 - box.maxY) * origin.height),
                             w: round3(box.width * origin.width), h: round3(box.height * origin.height)))
    }
    return lines
}
// One read of the bound window: its text as lines with boxes, and nothing
// else kept. No input is sent, no window is activated, the latch is not
// consulted (nothing here needs it), and the capture covers that window alone.
@available(macOS 14.0, *)
func probeWatch(token: String, region: [String:Any]?) async throws -> [String:Any] {
    guard let bound = boundWatch(token) else { throw ControlError("Unknown watch token.") }
    if IsSecureEventInputEnabled() { return ["ok": false, "code": "secure_input"] }
    if screenLocked() { return ["ok": false, "code": "screen_locked"] }
    guard let app = NSRunningApplication(processIdentifier: bound.pid), !app.isTerminated else { return ["ok": false, "code": "window_gone"] }
    let appId = app.bundleIdentifier ?? bound.appId
    if appId != bound.appId || watchRefused(appId) { return ["ok": false, "code": "protected"] }
    // A browser window is refused by the page it shows now, as a capture is:
    // the user may have opened their bank in the watched window since.
    if browserAppIDs.contains(appId) {
        guard let window = watchWindowElement(pid: bound.pid, windowID: bound.windowID) else { return ["ok": false, "code": "window_gone"] }
        if watchWindowProtected(appId: appId, window: window) { return ["ok": false, "code": "protected"] }
    }
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    guard let window = content.windows.first(where: { $0.windowID == bound.windowID && $0.owningApplication?.processID == bound.pid }) else { return ["ok": false, "code": "window_gone"] }
    guard window.isOnScreen, window.frame.width > 40, window.frame.height > 40 else { return ["ok": false, "code": "not_visible"] }
    let filter = SCContentFilter(desktopIndependentWindow: window)
    let config = SCStreamConfiguration()
    let ratio = min(2, 1600 / window.frame.width)
    config.width = Int(window.frame.width * ratio); config.height = Int(window.frame.height * ratio); config.showsCursor = false
    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
    let lines = recognizeLines(image, region: watchRegion(region))
    let lastManual = lastManualInput()
    let now = ProcessInfo.processInfo.systemUptime
    let hidIdle = CGEventType(rawValue: ~0).map { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) } ?? 0
    let idleMs = Int(max(0, (lastManual.map { now - $0 } ?? hidIdle) * 1000))
    return ["ok": true, "frontmost": NSWorkspace.shared.frontmostApplication?.processIdentifier == bound.pid, "title": String((window.title ?? "").prefix(300)),
            "lines": lines.map { ["t": $0.t, "x": $0.x, "y": $0.y, "w": $0.w, "h": $0.h] }, "idleMs": idleMs]
}
// Brings the bound window forward for the wake-up run: the application is
// activated and that window, found by its current bounds, raised. Refused for
// an application that has since become protected.
func focusWatch(token: String) async throws -> [String:Any] {
    guard let bound = boundWatch(token) else { throw ControlError("Unknown watch token.") }
    guard let app = NSRunningApplication(processIdentifier: bound.pid), !app.isTerminated, !watchRefused(app.bundleIdentifier ?? "") else { throw ControlError("The watched application is gone or protected.", code: "SURFACE_BLOCKED") }
    let window = watchWindowElement(pid: bound.pid, windowID: bound.windowID)
    guard !watchWindowProtected(appId: app.bundleIdentifier ?? bound.appId, window: window) else { throw ControlError("The watched page is protected.", code: "SURFACE_BLOCKED") }
    if app.isHidden { app.unhide() }
    app.activate(options: [])
    if let window { AXUIElementPerformAction(window, kAXRaiseAction as CFString) }
    try await Task.sleep(nanoseconds: 300_000_000)
    withState { lastInputTime = ProcessInfo.processInfo.systemUptime }
    return ["focused": NSWorkspace.shared.frontmostApplication?.processIdentifier == bound.pid]
}
// MARK: system index
struct IndexedApp { let name: String; let bundleId: String; let lastUsed: Date?; let useCount: Int? }
var indexAppsCache: (time: TimeInterval, list: [IndexedApp])?
// Raw recently used items for one home folder, cached for 30 seconds like the
// application list. Only a query that finished gathering is cached; the path
// rules are applied to the items on every request.
var indexRecentCache: (time: TimeInterval, home: String, items: [IndexItem])?
let indexCacheSeconds: TimeInterval = 30
let isoFormatter: ISO8601DateFormatter = { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime]; return f }()
// Permitted applications (the open_app enumeration minus denied and protected
// ones) with Spotlight usage metadata, cached for 30 seconds.
func indexedApplications() -> [IndexedApp] {
    let now = ProcessInfo.processInfo.systemUptime
    if let cached = withState({ indexAppsCache }), now - cached.time < indexCacheSeconds { return cached.list }
    var seen = Set<String>(), list = [IndexedApp]()
    let candidates = applicationCandidates().sorted(by: { $0.rootIndex < $1.rootIndex })
    let budget = ProcessInfo.processInfo.systemUptime + 0.3
    for candidate in candidates where !launchCandidateDenied(candidate, protectedApps: protectedApps) {
        guard seen.insert(candidate.bundleId.lowercased()).inserted else { continue }
        var lastUsed: Date? = nil, useCount: Int? = nil
        if ProcessInfo.processInfo.systemUptime < budget, let item = MDItemCreate(kCFAllocatorDefault, candidate.path as CFString) {
            lastUsed = MDItemCopyAttribute(item, kMDItemLastUsedDate) as? Date
            useCount = (MDItemCopyAttribute(item, "kMDItemUseCount" as CFString) as? NSNumber)?.intValue
        }
        list.append(IndexedApp(name: candidate.displayName, bundleId: candidate.bundleId, lastUsed: lastUsed, useCount: useCount))
    }
    list.sort { a, b in
        let da = a.lastUsed ?? .distantPast, db = b.lastUsed ?? .distantPast
        return da != db ? da > db : a.name.lowercased() < b.name.lowercased()
    }
    withState { indexAppsCache = (ProcessInfo.processInfo.systemUptime, list) }
    return list
}
// One bounded Spotlight metadata query (attributes from the index only; no file
// is opened). Runs on the main run loop and stops at the deadline, returning
// whatever was gathered and whether gathering completed.
final class SpotlightSearch: NSObject, @unchecked Sendable {
    let query = NSMetadataQuery()
    var finished = false
    var gathered = false
    var observer: NSObjectProtocol?
    var continuation: CheckedContinuation<(items: [IndexItem], complete: Bool), Never>?
    let maxItems: Int
    init(predicate: NSPredicate, scope: String, sortByLastUsed: Bool, maxItems: Int) {
        self.maxItems = maxItems
        super.init()
        query.predicate = predicate
        query.searchScopes = [scope]
        query.valueListAttributes = []
        if sortByLastUsed { query.sortDescriptors = [NSSortDescriptor(key: kMDItemLastUsedDate as String, ascending: false)] }
    }
    func finish() {
        guard !finished else { return }
        finished = true
        query.disableUpdates(); query.stop()
        if let observer = observer { NotificationCenter.default.removeObserver(observer) }
        var items = [IndexItem]()
        for index in 0..<min(query.resultCount, maxItems) {
            guard let result = query.result(at: index) as? NSMetadataItem, let path = result.value(forAttribute: kMDItemPath as String) as? String else { continue }
            items.append(IndexItem(path: path, types: result.value(forAttribute: kMDItemContentTypeTree as String) as? [String] ?? [], lastUsed: result.value(forAttribute: kMDItemLastUsedDate as String) as? Date))
        }
        continuation?.resume(returning: (items, gathered)); continuation = nil
    }
    func run(timeout: TimeInterval) async -> (items: [IndexItem], complete: Bool) {
        await withCheckedContinuation { (continuation: CheckedContinuation<(items: [IndexItem], complete: Bool), Never>) in
            DispatchQueue.main.async {
                self.continuation = continuation
                self.observer = NotificationCenter.default.addObserver(forName: .NSMetadataQueryDidFinishGathering, object: self.query, queue: nil) { [weak self] _ in
                    guard let self = self, !self.finished else { return }
                    self.gathered = true; self.finish()
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { self.finish() }
                if !self.query.start() { self.finish() }
            }
        }
    }
}
func systemIndex(query: String, limit: Int) async -> [String:Any] {
    // Spotlight reports canonical paths, so compare against the real home folder.
    let lexicalHome = FileManager.default.homeDirectoryForCurrentUser.path
    let home = realPath(lexicalHome) ?? lexicalHome
    // Specific name matches gather in about 0.2-1.0 s; a shorter cap would
    // return partial matches, which could make one of several same-named files
    // look unique. Broad fragments (TLDs, file extensions) are never queried.
    let timeout = 1.2
    // Spotlight searches start first and run while applications are enumerated.
    let started = ProcessInfo.processInfo.systemUptime
    var recentTask: Task<(items: [IndexItem], complete: Bool), Never>? = nil
    var recentItems = [IndexItem]()
    if let cached = withState({ indexRecentCache }), cached.home == home, started - cached.time < indexCacheSeconds {
        recentItems = cached.items
    } else {
        let cutoff = Date().addingTimeInterval(-30 * 86400)
        let recent = SpotlightSearch(predicate: NSPredicate(format: "%K >= %@", kMDItemLastUsedDate as String, cutoff as NSDate), scope: home, sortByLastUsed: true, maxItems: 60)
        recentTask = Task { await recent.run(timeout: timeout) }
    }
    let tokens = indexQueryTokens(query)
    var matchTask: Task<(items: [IndexItem], complete: Bool), Never>? = nil
    if !tokens.isEmpty, let predicate = NSPredicate(fromMetadataQueryString: indexMatchQuery(tokens)) {
        let search = SpotlightSearch(predicate: predicate, scope: home, sortByLastUsed: true, maxItems: 100)
        matchTask = Task { await search.run(timeout: timeout) }
    }
    let apps = indexedApplications()
    let fm = FileManager.default
    var folders = [[String:Any]]()
    for folder in indexStandardFolders {
        let lexical = lexicalHome + "/" + folder.relative
        var directory: ObjCBool = false
        guard fm.fileExists(atPath: lexical, isDirectory: &directory), directory.boolValue,
              let real = realPath(lexical), !indexExcluded(realPath: real, home: home),
              let relative = homeRelative(real, home: home) else { continue }
        // Case-insensitive volumes: show the folder's name as it is on disk.
        folders.append(["name": folder.relative == iCloudDriveRelative ? iCloudDriveName : (relative as NSString).lastPathComponent, "path": relative])
    }
    func encode(_ entries: [(name: String, path: String, kind: FileKind, lastUsed: Date?)]) -> [[String:Any]] {
        entries.map { entry in
            var item: [String:Any] = ["name": entry.name, "path": entry.path, "kind": entry.kind.rawValue]
            if let date = entry.lastUsed { item["lastUsed"] = isoFormatter.string(from: date) }
            return item
        }
    }
    if let recentTask = recentTask {
        let recent = await recentTask.value
        recentItems = recent.items
        if recent.complete { withState { indexRecentCache = (started, home, recent.items) } }
    }
    let recentFiles = encode(indexEntries(recentItems, home: home, limit: 20))
    var matches = [[String:Any]]()
    if let matchTask = matchTask { matches = encode(indexEntries(rankIndexMatches(await matchTask.value.items, tokens: tokens), home: home, limit: limit)) }
    return [
        "apps": apps.map { app -> [String:Any] in
            var item: [String:Any] = ["name": app.name, "bundleId": app.bundleId]
            if let date = app.lastUsed { item["lastUsed"] = isoFormatter.string(from: date) }
            if let count = app.useCount { item["useCount"] = count }
            return item
        },
        "folders": folders, "recentFiles": recentFiles, "matches": matches,
    ]
}
func handle(_ command:[String:Any]) async throws -> [String:Any] {
    switch command["method"] as? String {
    case "permissions":return ["screen":CGPreflightScreenCaptureAccess(),"accessibility":AXIsProcessTrusted(),"emergencyStop":tap != nil,"supported":ProcessInfo.processInfo.operatingSystemVersion.majorVersion>=14]
    case "requestPermissions":
        _ = CGRequestScreenCaptureAccess();_ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String:true] as CFDictionary);return ["requested":true]
    case "configure":
        if let apps = command["protectedApps"] as? [String]{protectedApps = apps};if let domains = command["protectedDomains"] as? [String]{protectedDomains = domains};if let id = command["displayId"] as? UInt32{displayID = id}
        if let notifications = command["notifications"] as? Bool {
            withState { notificationsEnabled = notifications; if !notifications { deliveredNotifications = [] } }
            if notifications { watchNotifications() }
        }
        return ["configured":true]
    case "surface":return surface(command["action"] as? [String:Any])
    // Read-only local system index: sends no input, so it needs no resume.
    case "index":return await systemIndex(query: command["query"] as? String ?? "", limit: indexLimit(command["limit"]))
    case "rememberForeground":
        if let app=NSWorkspace.shared.frontmostApplication,app.processIdentifier != getppid(),app.bundleIdentifier != "ai.coarena.openassist" {rememberedPID=app.processIdentifier};return ["remembered":true]
    case "restoreRemembered":
        if let pid=rememberedPID,NSWorkspace.shared.frontmostApplication?.processIdentifier != pid,let app=NSRunningApplication(processIdentifier:pid){app.activate(options:[]);try await Task.sleep(nanoseconds:300_000_000)};return ["restored":true]
    case "displays":var ids = [CGDirectDisplayID](repeating:0,count:16);var count:UInt32 = 0;CGGetActiveDisplayList(16,&ids,&count);return ["displays":ids.prefix(Int(count)).map{id in let b = CGDisplayBounds(id);return ["id":Int(id),"width":Int(b.width),"height":Int(b.height)]}]
    case "resume":guard AXIsProcessTrusted(),CGPreflightScreenCaptureAccess() else {throw ControlError("Grant Screen Recording and Accessibility permissions before starting.")};guard installTap() else {throw ControlError("Emergency stop could not be registered. Input remains disabled.")};latch(false);return ["resumed":true]
    case "stop":latch(true);return ["stopped":true]
    case "capture":if #available(macOS 14.0,*){return try await capture()}else{throw ControlError("macOS 14 or newer is required.")}
    case "execute":
        guard var action = command["action"] as? [String:Any] else {throw ControlError("Missing action.")}
        // Waiting and observing send no input and are not bound to a frame.
        if ["wait", "capture"].contains(action["type"] as? String ?? "") {try execute(action);return ["executed":true]}
        try ensureRunning()
        guard let previous = getCurrentFrame()?["frame"] as? [String:Any], action["frame_id"] as? String == previous["id"] as? String else {throw changedScreen("The observation is no longer current.")}
        // A hotkey's route is chosen once: one revalidated as a menu press is never posted as keys.
        // An approved step (the runner marks it) gets the full check whichever way it goes.
        var menuRoute: [String]? = nil
        if #available(macOS 14.0,*) {
            if action["type"] as? String == "open_app" {return try await openApplication(action)}
            if action["type"] as? String == "open_file" {return try await openFile(action)}
            let route = currentHotkeyRoute(action), approved = action["approved"] as? Bool == true
            if route == .refused { throw ControlError(menuRefusal, code: "TARGET_REFUSED") }
            menuRoute = route.menuPath
            let fresh = try await revalidate(action, menuRoute: menuRoute, approved: approved)
            // After the screen checks, so a changed application or window is reported as that.
            if route == .changed { throw changedScreen("The shortcut's menu item changed.") }
            action["frame_id"] = fresh["id"]
        } else {throw ControlError("macOS 14 required.")}
        var result: [String:Any] = ["executed":true]
        if let via = try execute(action, menuRoute: menuRoute) {result["via"] = via}
        return result
    case "revalidate":
        guard let action = command["action"] as? [String:Any] else { throw ControlError("Missing action.") }
        // The runner sends this only after the user approved the step: an approved
        // hotkey gets the full keyboard check, whichever way it is then pressed.
        if #available(macOS 14.0,*) { return try await revalidate(action, menuRoute: nil, approved: true) }
        throw ControlError("macOS 14 required.")
    // Detached watches: read-only reads of one bound window, a flag for the
    // Escape rule, and one activation before a wake-up run. None sends input.
    case "bindWatch": return try bindWatch()
    case "probe":
        guard let token = command["token"] as? String else { throw ControlError("Missing token.") }
        if #available(macOS 14.0, *) { return try await probeWatch(token: token, region: command["region"] as? [String:Any]) }
        throw ControlError("macOS 14 required.")
    case "unbindWatch":
        let token = command["token"] as? String ?? ""
        withState { watchBindings[token] = nil }
        return ["unbound": true]
    case "setWatchMode":
        let on = command["on"] as? Bool ?? false
        withState { watching = on; if !on { lastEscapeAt = nil } }
        return ["watching": on]
    case "focusWatch":
        guard let token = command["token"] as? String else { throw ControlError("Missing token.") }
        return try await focusWatch(token: token)
    case "restore":
        let framePID = getCurrentFrame()?["pid"] as? Int
        let candidate = framePID.flatMap { NSRunningApplication(processIdentifier:pid_t($0)) }
        let target: NSRunningApplication?
        if let candidate = candidate, candidate.processIdentifier != getppid(), candidate.bundleIdentifier != "ai.coarena.openassist" { target = candidate }
        else { target = rememberedPID.flatMap { NSRunningApplication(processIdentifier:$0) } }
        if let target=target,NSWorkspace.shared.frontmostApplication?.processIdentifier != target.processIdentifier {target.activate(options:[]);try await Task.sleep(nanoseconds:300_000_000)};return ["restored":true]
    default:throw ControlError("Unknown controller method.")
    }
}
var parentWatch: DispatchSourceProcess?
var parentTimer: DispatchSourceTimer?
// The helper must never outlive the app: input would continue unsupervised.
func terminateOrphan() -> Never { releaseHeldInputAndExit() }
@main struct ControllerMain {
static func main() {
signal(SIGUSR1,SIG_IGN)
signal(SIGTERM,SIG_IGN)
let terminateSignal = DispatchSource.makeSignalSource(signal:SIGTERM,queue:.global(qos:.userInteractive));terminateSignal.setEventHandler{releaseHeldInputAndExit(signal:SIGTERM)};terminateSignal.resume()
let stopSignal = DispatchSource.makeSignalSource(signal:SIGUSR1,queue:.global(qos:.userInteractive));stopSignal.setEventHandler{latch(true)};stopSignal.resume()
let parent = getppid()
parentWatch = DispatchSource.makeProcessSource(identifier:parent,eventMask:.exit,queue:.global(qos:.userInteractive))
parentWatch?.setEventHandler{terminateOrphan()};parentWatch?.resume()
parentTimer = DispatchSource.makeTimerSource(queue:.global(qos:.utility))
parentTimer?.schedule(deadline:.now()+1,repeating:1)
parentTimer?.setEventHandler{if getppid() != parent {terminateOrphan()}};parentTimer?.resume()
// Requests run strictly in order on one queue; the reader keeps reading so
// EOF (the app closed the pipe or died) is noticed while a request runs.
let commands = DispatchQueue(label:"ai.coarena.controller.commands")
DispatchQueue.global().async {
    while let line = readLine() {
        guard let data = line.data(using:.utf8), let command = try? JSONSerialization.jsonObject(with:data) as? [String:Any] else {continue}
        // Presence is polled during runs and has a short deadline in main. It
        // is read-only and answers in microseconds, so it is answered here,
        // ahead of the queue: a capture or paced typing in flight would
        // otherwise hold it past that deadline and leave main a stale report.
        if command["method"] as? String == "presence" {emit(["id":command["id"] ?? "","result":presence()]);continue}
        // The system index is read-only (Spotlight metadata, application names,
        // standard folders; caches under withState) and sends no input, so it is
        // answered off the queue too: memory recall at run start then overlaps the
        // first capture instead of holding it for up to a second.
        if command["method"] as? String == "index" {
            Task { do {let result = try await handle(command);emit(["id":command["id"] ?? "","result":result])}catch {emit(["id":command["id"] ?? "","error":(error as? ControlError)?.message ?? "Native controller failed."])} }
            continue
        }
        commands.async {
            let semaphore = DispatchSemaphore(value:0)
            Task { do {let result = try await handle(command);emit(["id":command["id"] ?? "","result":result])}catch {var result:[String:Any] = ["id":command["id"] ?? "","error":(error as? ControlError)?.message ?? "Native controller failed."];if let code = (error as? ControlError)?.code {result["code"] = code};if let change = (error as? ControlError)?.change {result["change"] = change};emit(result)};semaphore.signal() };semaphore.wait()
        }
    }
    latch(true)
    DispatchQueue.global().asyncAfter(deadline:.now()+2){releaseHeldInputAndExit()}
    commands.async{releaseHeldInputAndExit()}
}
RunLoop.main.run()
}
}
