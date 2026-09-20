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
    return titleElementName(element)
}
/**
 The text of the element that titles a control (Reveal.swift
 titleElementAttribute): a <label> wrapping or pointing at it in a web page,
 an AppKit field's label. WebKit leaves a control's own AXTitle empty when a
 label names it, so the mail fixture's radios ("Receipts" under "File under")
 and its Subject field and Reply text area had no name at all (probe of
 2026-09-20: 14 controls, no radio listed, 2 fields unlabelled). The label's
 value or title, else the first static text under it, two levels down and
 bounded; a label that is itself a field or a secure field gives its title
 only, never its contents.
 */
func titleElementName(_ element: AXUIElement) -> String {
    guard let raw = attribute(element, titleElementAttribute), CFGetTypeID(raw) == AXUIElementGetTypeID() else { return "" }
    let label = raw as! AXUIElement
    let role = attribute(label, kAXRoleAttribute) as? String ?? ""
    let field = ["AXTextField", "AXTextArea", "AXComboBox"].contains(role) || attribute(label, kAXSubroleAttribute) as? String == kAXSecureTextFieldSubrole
    let names = (field ? [kAXTitleAttribute, kAXDescriptionAttribute] : [kAXValueAttribute, kAXTitleAttribute, kAXDescriptionAttribute])
    let own = firstControlName(names.map { name in { attribute(label, name) as? String } })
    if !own.isEmpty { return String(own.prefix(120)) }
    var queue = [(label, 0)], index = 0
    while index < queue.count, index < 16 {
        let (node, depth) = queue[index]; index += 1
        if depth > 0, attribute(node, kAXRoleAttribute) as? String == "AXStaticText",
           let value = attribute(node, kAXValueAttribute) as? String {
            let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { return String(text.prefix(120)) }
        }
        guard depth < 2 else { continue }
        for child in (attribute(node, kAXChildrenAttribute) as? [AXUIElement] ?? []).prefix(6) { queue.append((child, depth + 1)) }
    }
    return ""
}
/// The group a radio button or check box sits in (a fieldset's legend, a
/// radio group's title), bounded: the first ancestor group above the
/// control's own label whose name differs from the control's, six levels up
/// at most, never past the page or the window. Nil for other roles.
func controlGroup(_ element: AXUIElement, role: String, own: String) -> String? {
    guard groupedControlRoles.contains(role) else { return nil }
    var node = attribute(element, kAXParentAttribute).map { $0 as! AXUIElement }
    for _ in 0..<6 {
        guard let current = node else { return nil }
        let currentRole = attribute(current, kAXRoleAttribute) as? String ?? ""
        if controlGroupStopRoles.contains(currentRole) { return nil }
        if controlGroupRoles.contains(currentRole) {
            let name = firstControlName([{ attribute(current, kAXTitleAttribute) as? String }, { attribute(current, kAXDescriptionAttribute) as? String }, { titleElementName(current) }])
            if !name.isEmpty, name != own { return utf16Prefix(name, 60) }
        }
        node = attribute(current, kAXParentAttribute).map { $0 as! AXUIElement }
    }
    return nil
}
/// The text that names a control's row (ListNames.swift): up from the
/// control, rowSearchDepth levels at most and never past the page or the
/// window (controlGroupStopRoles), to the nearest AXRow or list item; then,
/// over the row's children in order (its cells), the first static text (the
/// cell itself, or one two levels down) that is not the control's own name.
/// Empty when there is no row or no such text. Reads static text alone:
/// never a field's value.
func controlRowText(_ element: AXUIElement, own: String) -> String {
    let ownWords = own.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ").lowercased()
    for ancestor in ancestors(of: element, depth: rowSearchDepth) {
        let role = attribute(ancestor, kAXRoleAttribute) as? String ?? ""
        if controlGroupStopRoles.contains(role) { return "" }
        guard rowRoles.contains(role) || rowSubroles.contains(attribute(ancestor, kAXSubroleAttribute) as? String ?? "") else { continue }
        for cell in (attribute(ancestor, kAXChildrenAttribute) as? [AXUIElement] ?? []).prefix(8) {
            let text = firstStaticText(cell, depth: 2)
            if !text.isEmpty, text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ").lowercased() != ownWords { return text }
        }
        return ""
    }
    return ""
}
/// The first static text under an element (itself, or its descendants
/// breadth-first, `depth` levels down and twelve nodes at most), trimmed;
/// empty when there is none.
func firstStaticText(_ element: AXUIElement, depth: Int) -> String {
    var queue = [(element, 0)], index = 0
    while index < queue.count, index < 12 {
        let (node, level) = queue[index]; index += 1
        if attribute(node, kAXRoleAttribute) as? String == "AXStaticText", let value = attribute(node, kAXValueAttribute) as? String {
            let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { return text }
        }
        guard level < depth else { continue }
        for child in (attribute(node, kAXChildrenAttribute) as? [AXUIElement] ?? []).prefix(6) { queue.append((child, level + 1)) }
    }
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
    let editable = editableControlRoles.contains(role)
    // Title, description, value or placeholder, then the element that titles
    // it (Reveal.swift controlNameOrder): the last is what names a control
    // under a <label> in WebKit.
    let name = firstControlName(controlNameOrder(editable: editable).map { attributeName in
        attributeName == titleElementAttribute ? { titleElementName(element) } : { attribute(element, attributeName) as? String }
    })
    return name.isEmpty ? "" : utf16Prefix(name, controlNameChars)
}
// Visible controls of the focused window with their centers as screenshot
// fractions, so the model can click a listed control exactly instead of
// estimating pixel positions. Reuses the controls already walked for safety.
// Interactive elements inside the visible part of a browser's web area, found
// breadth-first with node and time budgets so capture latency stays bounded.
// Names only (modelControlName never returns field contents).
// One listed control with the element behind it, so a bound run can press what
// the model named without a second hit test.
struct ControlEntry { let item: [String:Any]; let element: AXUIElement }
func webControls(_ window: AXUIElement, display: CGRect, limit: Int = 45) -> [[String:Any]] {
    webControlEntries(window, display: display, limit: limit).map { $0.item }
}
func webControlEntries(_ window: AXUIElement, display: CGRect, limit: Int = 45) -> [ControlEntry] {
    let started = ProcessInfo.processInfo.systemUptime
    let interactive: Set<String> = ["AXLink","AXButton","AXTextField","AXTextArea","AXComboBox","AXCheckBox","AXRadioButton","AXPopUpButton","AXMenuButton","AXTab","AXIncrementor","AXSlider"]
    // Listed even without a name, since typed text lands in them: the text
    // fields and a number input (AXIncrementor). A nameless slider is not.
    let namelessListed: Set<String> = ["AXTextField","AXTextArea","AXComboBox","AXIncrementor"]
    let visible = (elementRect(window) ?? display).intersection(display)
    var queue: [(AXUIElement, Int)] = [(window, 0)], index = 0, result = [ControlEntry]()
    while index < queue.count && index < 2500 && result.count < limit {
        if ProcessInfo.processInfo.systemUptime - started > 0.25 { break }
        let (node, depth) = queue[index]; index += 1
        let role = attribute(node, kAXRoleAttribute) as? String ?? ""
        if attribute(node, kAXSubroleAttribute) as? String == kAXSecureTextFieldSubrole { continue }
        let rect = elementRect(node)
        // Skip subtrees that are scrolled out of view.
        if let rect = rect, depth > 2, rect.width > 0, rect.height > 0, !rect.intersects(visible) { continue }
        // WebKit wraps a number input's own text field inside the
        // AXIncrementor; the parent is the listed control, so it appears once.
        if role == "AXTextField", let parent = attribute(node, kAXParentAttribute), CFGetTypeID(parent) == AXUIElementGetTypeID(),
           attribute(parent as! AXUIElement, kAXRoleAttribute) as? String == "AXIncrementor" { continue }
        if interactive.contains(role), let rect = rect, rect.width >= 2, rect.height >= 2, visible.contains(CGPoint(x: rect.midX, y: rect.midY)) {
            let name = modelControlName(node, role: role)
            if !name.isEmpty || namelessListed.contains(role) {
                var item: [String:Any] = ["role": controlRoleWord(role: role),
                    "x": (Double(rect.midX - display.minX) / Double(display.width) * 1000).rounded() / 1000,
                    "y": (Double(rect.midY - display.minY) / Double(display.height) * 1000).rounded() / 1000]
                if !name.isEmpty { item["label"] = name }
                // A radio or check box carries its fieldset's legend, so
                // "Receipts" is known to be a folder under "File under".
                if let group = controlGroup(node, role: role, own: name) { item["group"] = group }
                if attribute(node, kAXEnabledAttribute) as? Bool == false { item["enabled"] = false }
                result.append(ControlEntry(item: item, element: node))
            }
        }
        guard depth < 40 else { continue }
        let children = (attribute(node, "AXVisibleChildren") ?? attribute(node, kAXChildrenAttribute)) as? [AXUIElement] ?? []
        for child in children.prefix(60) { queue.append((child, depth + 1)) }
    }
    // Names repeated in a list ("Details" in every row of the vendors table)
    // are told apart by their row (ListNames.swift, controlRowText), read
    // only for the entries that repeat and within rowReadSeconds in all, so
    // a page of distinct names costs nothing more. Before the entries are
    // stored: the name the model reads is the name a click_control resolves.
    let listed = result.map { (name: $0.item["label"] as? String ?? "", role: $0.item["role"] as? String ?? "") }
    let rowsStarted = ProcessInfo.processInfo.systemUptime
    let names = qualifiedListNames(listed) { index in
        ProcessInfo.processInfo.systemUptime - rowsStarted > rowReadSeconds ? "" : controlRowText(result[index].element, own: listed[index].name)
    }
    for index in result.indices where names[index] != listed[index].name {
        var item = result[index].item
        item["label"] = names[index]
        result[index] = ControlEntry(item: item, element: result[index].element)
    }
    return result
}
/**
 Where the page-text walk starts: the outermost web area over the centre of
 the visible rect when that point is in this window's page (one hit test and
 a climb to the window, some twenty attribute reads, where the window's chrome
 costs hundreds), else the first web area under the window in tree order
 (visitWebAreas), else the window itself. The climb ends at the window and
 compares it, so a sheet, a popover or another of the application's windows
 over the centre (a bound window may be covered) never lends its page.
 */
func webTextRoot(_ window: AXUIElement, visible: CGRect) -> (root: AXUIElement, web: Bool) {
    var pid: pid_t = 0
    if AXUIElementGetPid(window, &pid) == .success {
        var hit: AXUIElement?
        if AXUIElementCopyElementAtPosition(AXUIElementCreateApplication(pid), Float(visible.midX), Float(visible.midY), &hit) == .success {
            var node = hit, area: AXUIElement? = nil
            for _ in 0..<40 {
                guard let current = node else { break }
                let role = attribute(current, kAXRoleAttribute) as? String ?? ""
                if role == "AXWebArea" { area = current }
                if role == "AXWindow" { if let area, CFEqual(current, window) { return (area, true) }; break }
                node = attribute(current, kAXParentAttribute).map { $0 as! AXUIElement }
            }
        }
    }
    var found: AXUIElement? = nil
    visitWebAreas(window) { area in found = area; return true }
    if let found { return (found, true) }
    return (window, false)
}
/**
 The text a person can read in a browser page right now, in reading order,
 with the walk's account of itself (WebText: why it stopped early, its node
 count, its wall time). Web pages nest their text far deeper than the generic
 window walk goes, so a research task used to see only the title and had to
 guess from pixels. Depth first from the page (webTextRoot) so the order is
 the page's own; a child's frame is read before anything else about it and a
 child off-screen is left unvisited (two reads, not four); a run of siblings
 below the fold ends its parent's list; under a node the visible rect
 contains whole no frame is read at all; bounded in nodes, characters and
 wall time by TextWalkBudget (WebText.swift), whose marker line ends a text
 that was cut; and never reading a secure field.
 */
func webVisibleText(_ window: AXUIElement, display: CGRect, limit: Int = 4200, seconds: Double = TextWalkBudget.webSeconds) -> WebText {
    let started = ProcessInfo.processInfo.systemUptime
    let visible = (elementRect(window) ?? display).intersection(display)
    let start = webTextRoot(window, visible: visible)
    // One walk from a root: frames are read from the page's children down;
    // under a bare window the top two levels are chrome whose frames say
    // nothing about the text.
    func walk(_ root: AXUIElement, pruneDepth: Int, seconds: Double) -> (parts: [String], budget: TextWalkBudget) {
        let began = ProcessInfo.processInfo.systemUptime
        var budget = TextWalkBudget(seconds: seconds, maxNodes: TextWalkBudget.nodeCap, maxCharacters: limit)
        var parts = [String]()
        func visit(_ node: AXUIElement, _ depth: Int, _ contained: Bool) {
            guard depth < 60, budget.admit(elapsed: ProcessInfo.processInfo.systemUptime - began) else { return }
            let role = attribute(node, kAXRoleAttribute) as? String ?? ""
            if role == "AXStaticText" {
                if let value = attribute(node, kAXValueAttribute) as? String, let bounded = budget.take(value) { parts.append(bounded) }
                return
            }
            // A secure field publishes no static text, and nothing under it is read either.
            if role == "AXTextField", attribute(node, kAXSubroleAttribute) as? String == kAXSecureTextFieldSubrole { return }
            let children = (attribute(node, TextWalkBudget.childrenAttribute(role: role)) ?? attribute(node, kAXChildrenAttribute)) as? [AXUIElement] ?? []
            var below = 0
            for child in children.prefix(200) {
                guard budget.truncated == nil else { return }
                var inside = contained
                if depth + 1 >= pruneDepth, !contained {
                    switch TextWalkBudget.place(elementRect(child), in: visible) {
                    case .visible(let whole): inside = whole
                    case .above, .aside: below = 0; continue
                    case .below: below += 1; if below >= TextWalkBudget.belowStreak { return }; continue
                    }
                }
                below = 0
                visit(child, depth + 1, inside)
            }
        }
        visit(root, 0, false)
        return (parts, budget)
    }
    var result = walk(start.root, pruneDepth: start.web ? 1 : 3, seconds: seconds)
    var which = "page"
    // A page walk that finished small read a subtree that was not the page
    // (a hit test that landed beside it): walk from the window root as before
    // 091b033, within what is left of the budget, and keep the larger text.
    if start.web, TextWalkBudget.fellShort(nodes: result.budget.nodes, characters: result.budget.characters, truncated: result.budget.truncated) {
        let left = max(0.3, seconds - (ProcessInfo.processInfo.systemUptime - started))
        let again = walk(window, pruneDepth: 3, seconds: left)
        if again.budget.characters > result.budget.characters { result = again; which = "window" }
    }
    let elapsed = ProcessInfo.processInfo.systemUptime - started
    return WebText(text: result.budget.finish(result.parts), truncated: result.budget.truncated, nodes: result.budget.nodes, elapsedMs: Int((elapsed * 1000).rounded()), characters: result.budget.characters, walk: which)
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
// Controls listed once each, by role and position; `item` reads a control's dictionary.
func mergeControls<Control>(_ first: [Control], _ second: [Control], limit: Int, item: (Control) -> [String:Any]) -> [Control] {
    var seen = Set<String>(), merged = [Control]()
    for control in first + second where merged.count < limit {
        let fields = item(control)
        let key = "\(fields["role"] ?? "")|\(fields["x"] ?? "")|\(fields["y"] ?? "")"
        if seen.insert(key).inserted { merged.append(control) }
    }
    return merged
}
func groundedControls(_ state: WindowState, display: CGRect, limit: Int = 60) -> [[String:Any]] {
    groundedControlEntries(state, display: display, limit: limit).map { $0.item }
}
func groundedControlEntries(_ state: WindowState, display: CGRect, limit: Int = 60) -> [ControlEntry] {
    var result = [ControlEntry]()
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
        result.append(ControlEntry(item: item, element: control.element))
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
    return windowState(pid: pid, appId: running?.bundleIdentifier ?? "",
                       window: attribute(app, kAXFocusedWindowAttribute).map { $0 as! AXUIElement },
                       focused: attribute(app, kAXFocusedUIElementAttribute).map { $0 as! AXUIElement })
}
// The walk itself, over the window given: the frontmost application's focused
// window today, a bound window for a background run.
func windowState(pid: pid_t, appId: String, window: AXUIElement?, focused: AXUIElement?) -> WindowState {
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
    if appId == "com.apple.Spotlight" {controls.append("Spotlight selection:" + (spotlightState(AXUIElementCreateApplication(pid))["selectedResult"] ?? ""))}
    return WindowState(pid: pid, appId: appId, window: window, bounds: window.flatMap(elementRect),
        document: window.map { String(describing: attribute($0, "AXDocument") ?? attribute($0, "AXURL") ?? "" as CFString) } ?? "",
        focused: focused, focusedValue: focused.map { String(describing: attribute($0, kAXValueAttribute) ?? "" as CFString) } ?? "",
        focusedSignature:focused.map(focusSignature) ?? "",addressBar:focused.map{browserAddressField($0,appId:appId)} ?? false,
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
// Whether the expected control is on the path from the element under a point:
// system-wide (whatever is on top there) for the frontmost window, scoped to
// one application for a bound window another window may overlap.
func hitMatches(_ expected: AXUIElement, at point: CGPoint, application: AXUIElement = AXUIElementCreateSystemWide()) -> Bool {
    var hit: AXUIElement?
    guard AXUIElementCopyElementAtPosition(application, Float(point.x), Float(point.y), &hit) == .success else { return false }
    for _ in 0..<8 {
        guard let current = hit else { return false }
        if CFEqual(expected, current) { return true }
        hit = attribute(current, kAXParentAttribute).map { $0 as! AXUIElement }
    }
    return false
}
/// A control's ancestors, nearest first, at most `depth` of them.
func ancestors(of element: AXUIElement, depth: Int) -> [AXUIElement] {
    var found = [AXUIElement](), node = attribute(element, kAXParentAttribute).map { $0 as! AXUIElement }
    while let current = node, found.count < depth {
        found.append(current)
        node = attribute(current, kAXParentAttribute).map { $0 as! AXUIElement }
    }
    return found
}
/// What lies under a control's point once the reveal found it not clear
/// (Reveal.swift coveredBy): the element the route's hit test finds there
/// (system-wide in front, the application's own for a bound window) against
/// the control and its ancestors up to hitAncestorDepth, by identity. A
/// check box or radio drawn by its label hit-tests to the label's group or
/// the web area, its own ancestors: hitAncestor, not covered. Reads only.
func hitCover(_ control: AXUIElement, at point: CGPoint, application: AXUIElement) -> HitCover {
    var hit: AXUIElement?
    let found = AXUIElementCopyElementAtPosition(application, Float(point.x), Float(point.y), &hit) == .success ? hit : nil
    return coveredBy(hit: found, control: control, ancestors: ancestors(of: control, depth: hitAncestorDepth), same: { CFEqual($0, $1) })
}
// MARK: Revealing a covered control (Reveal.swift)

/// The Dock's frame on the display (its list of tiles) when it is on screen:
/// the system's own cover, which a window can extend under, and which the
/// system-wide hit test returns for a point inside it. Nil when the Dock is
/// hidden, on another display, or not running. Bounded messaging, so a
/// stalled Dock cannot hold a click.
func dockFrame(display: CGRect) -> CGRect? {
    guard let dock = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.dock").first else { return nil }
    let app = AXUIElementCreateApplication(dock.processIdentifier)
    _ = AXUIElementSetMessagingTimeout(app, 0.25)
    for child in (attribute(app, kAXChildrenAttribute) as? [AXUIElement] ?? []).prefix(6) where attribute(child, kAXRoleAttribute) as? String == "AXList" {
        if let rect = elementRect(child), rect.width > 0, rect.height > 0, rect.intersects(display) { return rect.intersection(display) }
    }
    return nil
}
/// Whether the element under a point, system-wide, belongs to the Dock.
func dockCovers(_ point: CGPoint) -> Bool {
    var hit: AXUIElement?
    guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &hit) == .success, let hit else { return false }
    var pid: pid_t = 0
    return AXUIElementGetPid(hit, &pid) == .success && NSRunningApplication(processIdentifier: pid)?.bundleIdentifier == "com.apple.dock"
}
/// The part of a window's content a click can land on: the window's frame
/// within the display and the screen's visible frame (which leaves out the
/// menu bar and a Dock that does not hide), minus the Dock's own frame when
/// it is on screen (clearContentRect).
func clearContent(window: AXUIElement?, display: CGRect) -> CGRect {
    let frame = (window.flatMap(elementRect) ?? display).intersection(display)
    guard !frame.isNull else { return .null }
    let screens = NSScreen.screens
    let primaryHeight = screens.first?.frame.height ?? display.height
    let visible = screens.map { topLeftRect(fromAppKit: $0.visibleFrame, primaryHeight: primaryHeight) }
        .max { $0.intersection(frame).area < $1.intersection(frame).area }
        .map { frame.intersection($0) } ?? frame
    return clearContentRect(visible: visible.isNull ? frame : visible, dock: dockFrame(display: display))
}
extension CGRect { var area: CGFloat { isNull ? 0 : width * height } }
/// The two ways a reveal moves a page, supplied by the route: an
/// accessibility action on an element (AXScrollToVisible), and a scroll of
/// the page by a distance, aimed at the clear rectangle. Nil while the helper
/// is stopped: the reveal then only reads.
struct RevealRoutes {
    let perform: (AXUIElement, String) throws -> Void
    let scroll: (CGFloat, CGRect) throws -> Void
}
/// The frontmost route's scrolls: the accessibility action behind the stop
/// latch, and a wheel event by the distance that clears the control, posted
/// after the pointer is moved into the clear part of the window (a wheel
/// event goes to the window under the pointer, which may be resting on the
/// Dock after a click near the bottom). Marked as the helper's own by
/// postInput like every other input.
func frontRevealRoutes() -> RevealRoutes {
    RevealRoutes(perform: { element, action in try ensureRunning(); _ = AXUIElementPerformAction(element, action as CFString) },
                 scroll: { delta, clear in
                     try ensureRunning()
                     let at = CGPoint(x: floor(clear.midX), y: floor(clear.midY))
                     postInput(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: at, mouseButton: .left))
                     Thread.sleep(forTimeInterval: 0.012)
                     try ensureRunning()
                     postScroll(dx: 0, dy: Int(delta))
                 })
}
/**
 The point a click by name lands on, once the control is in the clear
 (Reveal.swift): inside the clear rectangle of its window, with this control
 (or one of its own parts) under it by the hit test the route uses
 (system-wide in front, the application's own for a bound window). A control
 listed under the Dock, or scrolled away since the model read it, is first
 asked to scroll itself into view (AXScrollToVisible, on it or the nearest
 ancestor that offers it), then, when its frame still lies outside the clear
 rectangle, the page is scrolled by the distance that clears it and asked
 once more; when the page cannot move (a short page), the part of the
 control that is clear is the point instead. Each scroll is followed by one
 read of the frame after revealSettleMs; `scrolled` is true only when the
 frame moved. Nothing is done at all when the centre is clear already.
 */
func revealControl(_ element: AXUIElement, window: AXUIElement?, display: CGRect, application: AXUIElement, routes: RevealRoutes?) throws -> Reveal {
    let clear = clearContent(window: window, display: display)
    func centre(_ rect: CGRect) -> CGPoint { CGPoint(x: floor(rect.midX), y: floor(rect.midY)) }
    func isClear(_ point: CGPoint) -> Bool { pointClear(point, clear: clear) && hitMatches(element, at: point, application: application) }
    guard var frame = elementRect(element), frame.width > 0, frame.height > 0 else { return Reveal(point: nil, scrolled: false, clear: false) }
    var point = centre(frame), scrolled = false
    if isClear(point) { return Reveal(point: point, scrolled: false, clear: true, visible: true) }
    func reread() {
        Thread.sleep(forTimeInterval: Double(revealSettleMs) / 1000)
        guard let now = elementRect(element), now.width > 0, now.height > 0 else { return }
        if now != frame { frame = now; point = centre(frame); scrolled = true }
    }
    func scrollIntoView() throws -> Bool {
        var node: AXUIElement? = element
        for _ in 0..<7 {
            guard let current = node else { return false }
            if actionNames(current).contains(scrollToVisibleAction) { try routes?.perform(current, scrollToVisibleAction); return routes != nil }
            node = attribute(current, kAXParentAttribute).map { $0 as! AXUIElement }
        }
        return false
    }
    if let routes {
        if try scrollIntoView() { reread(); if isClear(point) { return Reveal(point: point, scrolled: scrolled, clear: true, visible: true) } }
        let delta = revealDelta(frame: frame, clear: clear)
        if delta != 0 {
            try routes.scroll(delta, clear); reread()
            if isClear(point) { return Reveal(point: point, scrolled: scrolled, clear: true, visible: true) }
            // A page-sized scroll may have carried the control past the top: its own action brings it back.
            if try scrollIntoView() { reread(); if isClear(point) { return Reveal(point: point, scrolled: scrolled, clear: true, visible: true) } }
        }
    }
    if let part = clearPoint(frame: frame, clear: clear), isClear(part) { return Reveal(point: part, scrolled: scrolled, clear: true, visible: true) }
    // Not clear: under the Dock or off the clear rectangle (not visible), or
    // inside it with something else under the hit test (visible; hitCover
    // says whether that something is the control's own ancestor).
    return Reveal(point: point, scrolled: scrolled, clear: false, visible: pointClear(point, clear: clear))
}
/// A screen point as the fractions of the display the model and the runner use.
func displayFraction(_ point: CGPoint, display: CGRect) -> (x: Double, y: Double) {
    (Double(point.x - display.minX) / Double(display.width), Double(point.y - display.minY) / Double(display.height))
}

// Breadth-first, bounded walk over the web areas under a window, in tree
// order, stopping at the first the visitor accepts. Toolbars can hold many
// nodes and never contain the page, so they are not entered. Safari holds its
// page under an AXTabGroup (the tab container), so tab groups are entered like
// any group: until 2026-09-19 they were skipped with toolbars and Safari, which
// sets no window-level URL, reported no host on any page (cycle
// 20260919-0816-a839d34, every Safari attempt). A web area is never descended
// into, so the page's own tree is not walked here.
func visitWebAreas(_ window: AXUIElement, _ accept: (AXUIElement) -> Bool) {
    let started = ProcessInfo.processInfo.systemUptime
    var queue: [(AXUIElement, Int)] = [(window, 0)], index = 0
    while index < queue.count && index < 1500 && ProcessInfo.processInfo.systemUptime - started < 0.12 {
        let (node, depth) = queue[index]; index += 1
        let role = attribute(node, kAXRoleAttribute) as? String ?? ""
        if role == "AXWebArea" { if accept(node) { return }; continue }
        guard depth < 12, role != "AXToolbar" else { continue }
        for child in (attribute(node, kAXChildrenAttribute) as? [AXUIElement] ?? []).prefix(40) { queue.append((child, depth + 1)) }
    }
}
// The first web area's URL host under a window. A hostless area (Web
// Inspector, a blank tab) is not the page; the walk keeps looking.
func webAreaHost(_ window: AXUIElement) -> String? {
    var host: String? = nil
    visitWebAreas(window) { area in host = pageHost(attribute(area, "AXURL")); return host != nil }
    return host
}
// The web page that contains an element (nearest AXWebArea ancestor), if any.
func enclosingWebArea(_ element: AXUIElement) -> AXUIElement? {
    var node: AXUIElement? = element
    for _ in 0..<40 {
        guard let current = node else { return nil }
        if attribute(current, kAXRoleAttribute) as? String == "AXWebArea" { return current }
        node = attribute(current, kAXParentAttribute).map { $0 as! AXUIElement }
    }
    return nil
}
// Host of the web page that contains an element.
func enclosingWebHost(_ element: AXUIElement) -> String? {
    enclosingWebArea(element).flatMap { pageHost(attribute($0, "AXURL")) }
}
/**
 The URLs a browser window's page may be read from, in the order
 browserPageAddress (InputSafety.swift) takes them for the frame context's
 browserAddress: the web area holding focus when it sits in this window
 (Safari's active tab), then the first web area under the window that names a
 host (the walk pageIdentity shares, with its budget), then the window's own
 document URL (Chromium publishes one). The address field is never read here:
 its text is browserPageAddress's last resort, and only while it is focused.
 */
func pageAddressCandidates(window: AXUIElement, focused: AXUIElement?) -> [Any?] {
    if let focused, let area = enclosingWebArea(focused) {
        let areaWindow = attribute(area, kAXWindowAttribute)
        if areaWindow == nil || CFEqual(areaWindow, window), let url = attribute(area, "AXURL"), pageHost(url) != nil { return [url] }
    }
    var walked: Any? = nil
    visitWebAreas(window) { area in
        let url = attribute(area, "AXURL")
        if pageHost(url) != nil { walked = url; return true }
        return false
    }
    return [walked, attribute(window, "AXDocument"), attribute(window, "AXURL")]
}
/**
 The page a window shows, for the policy's protected-website rule: its host,
 and whether a web area is there that published no readable URL at all. Read
 from the window's own document URL first (Chromium publishes one), else from
 the web area holding focus when it sits in this window (Safari's active tab,
 reached whatever the walk's budget finds; a web area of another window, an
 extension's popover, says nothing about this one), else the first web area
 under the window with a host. The address field is never a source: its value
 is what was typed there, by the user or by the run itself, not the page that
 is committed. `unreadable` is what pageHostUnknown turns into the surface's
 hostUnknown for a browser; a page whose URL names no host (about:blank, a
 file) is known local and a window with no web area shows no page.
 */
func pageIdentity(window: AXUIElement, focused: AXUIElement?) -> (host: String?, unreadable: Bool) {
    if let host = pageHost(attribute(window, "AXDocument")) ?? pageHost(attribute(window, "AXURL")) { return (host, false) }
    var unreadable = false
    func read(_ area: AXUIElement) -> String? {
        switch pageURL(attribute(area, "AXURL")) {
        case .host(let host): return host
        case .unreadable: unreadable = true; return nil
        case .local: return nil
        }
    }
    if let focused, let area = enclosingWebArea(focused) {
        let areaWindow = attribute(area, kAXWindowAttribute)
        if areaWindow == nil || CFEqual(areaWindow, window), let host = read(area) { return (host, false) }
    }
    var host: String? = nil
    visitWebAreas(window) { area in host = read(area); return host != nil }
    return (host, host == nil && unreadable)
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

 For a bound target the press goes through that application's own menu bar
 element, which AppKit keeps whether or not the application is in front. Its
 menu is never opened to re-check a greyed-out item (only the frontmost menu
 bar can show one), the target's floors stand in for the frontmost surface's,
 and the return code is advice only: applications report failure from actions
 they performed, so the postcondition read decides (AXUIElement.h).
 */
func pressMenuPath(_ path: [String], chord: String? = nil, target: TargetBinding? = nil) throws {
    if let refusal = menuPressRefusal(path: path, chord: chord, item: nil) { throw ControlError(refusal.message, code: refusal.code) }
    let pid: pid_t, appId: String
    if let target { pid = target.pid; appId = target.appId }
    else {
        guard let app = inputApplication() else { throw changedScreen("Foreground application changed.") }
        pid = app.processIdentifier; appId = app.bundleIdentifier ?? ""
    }
    let element = AXUIElementCreateApplication(pid)
    _ = AXUIElementSetMessagingTimeout(element, 2.0)
    var resolved = resolveMenuPath(element, path, chord: chord)
    if target == nil, resolved == nil || resolved?.enabled == false {
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
    try ensureRunning()
    if let target { try guardTarget(target, typing: false); try performTargetAction(item.item, kAXPressAction, bound: target) }
    else {
        try guardSurface()
        guard AXUIElementPerformAction(item.item, kAXPressAction as CFString) == .success else {
            pressEscape()
            throw ControlError("\(menuCommandName(path: path, chord: chord)) could not be chosen.", code: "INPUT_FAILED")
        }
    }
    withState { menuSnapshot = nil } // menus revalidate after their own command
    noteCommand(item.title, pid: pid, appId: appId)
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
    currentControlEntries().map {
        NamedControl(label: $0.item["label"] as? String ?? "", role: $0.item["role"] as? String ?? "",
                     x: $0.item["x"] as? Double ?? 0, y: $0.item["y"] as? Double ?? 0,
                     enabled: $0.item["enabled"] as? Bool ?? true)
    }
}
// The same controls with the element behind each, so a click by name can be
// read back against the control itself (ClickEffect.swift).
func currentControlEntries() -> [ControlEntry] {
    let display = CGDisplayBounds(displayID)
    let state = windowState()
    var entries = groundedControlEntries(state, display: display)
    if browserAppIDs.contains(state.appId), let window = state.window {
        entries = mergeControls(entries, webControlEntries(window, display: display), limit: 60) { $0.item }
    }
    return entries
}
func resolveNamedControlEntry(_ action: [String:Any]) -> (match: ControlMatch, entry: ControlEntry?, control: NamedControl?) {
    targetNamedControl(action, entries: currentControlEntries())
}

// MARK: Click effect (ClickEffect.swift): what a click by name changed.

/// The focused element as an identity: its hash (an AXUIElement hashes as it
/// compares, CFEqual), role and label; never its value.
func focusIdentity(_ element: AXUIElement?) -> String {
    guard let element else { return "" }
    let role = attribute(element, kAXRoleAttribute) as? String ?? ""
    let label = ["AXTextField", "AXTextArea", "AXComboBox"].contains(role) ? fieldLabel(element) : String(controlLabel(element).prefix(120))
    return "\(CFHash(element))|\(role)|\(label)"
}
/// The clicked control's own state: its value as a digest (a secure field's
/// is never read), whether it is selected and whether it is expanded.
func controlStateDigest(_ element: AXUIElement) -> String {
    let secure = attribute(element, kAXSubroleAttribute) as? String == kAXSecureTextFieldSubrole
    let value = secure ? "secure" : String(describing: attribute(element, kAXValueAttribute) ?? "" as CFString)
    let digest = SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    return [digest, String(describing: attribute(element, kAXSelectedAttribute) ?? "" as CFString),
            String(describing: attribute(element, "AXExpanded") ?? "" as CFString)].joined(separator: "|")
}
/// One reading of what a click can change, from a window state already walked.
func clickSnapshot(state: WindowState, control: AXUIElement) -> ClickSnapshot {
    ClickSnapshot(focus: focusIdentity(state.focused), controls: state.controls,
                  title: state.window.flatMap { attribute($0, kAXTitleAttribute) as? String } ?? "",
                  page: state.document, control: controlStateDigest(control),
                  windows: state.pid > 0 ? onScreenWindowCount(state.pid) : 0,
                  targetFocused: sameElement(control, state.focused))
}
/// The reads after an input in front (clickReadDelaysMs), the second only
/// when the first saw nothing. Reads alone: no input, no stop-latch check.
func readClickEffect(before: ClickSnapshot, control: AXUIElement, editable: Bool) -> ClickEffect {
    var effect = ClickEffect.none
    for delay in clickReadDelaysMs {
        Thread.sleep(forTimeInterval: Double(delay) / 1000)
        effect = clickEffect(before: before, after: clickSnapshot(state: windowState(), control: control), editable: editable)
        if effect != .none { break }
    }
    return effect
}
/**
 A click by name in the frontmost window, read back (ClickEffect.swift). A
 field is given focus by accessibility first, as deliverByPosting does before
 typing, and the read verifies the application's focused element is that
 field. Otherwise, or when that did not take, the pointer click lands at the
 control's centre through the HID tap as it always did, marked as the helper's
 own by postInput; when the reads see nothing, the control's own AXPress is
 tried and read again. The result carries the route that acted last and the
 final effect, or `scrolled` when the page was moved to reveal the control
 first (Reveal.swift). A point that is not clear (the control still under
 the Dock, or something else under the hit test) gets no pointer click at
 all: only the control's own focus or press. Every input keeps the
 stop-latch check (mouse, ensureRunning) behind the protected-surface walk
 execute ran first.
 */
func clickNamedControl(_ element: AXUIElement, at target: CGPoint, pointer: Bool = true, scrolled: Bool = false, pressFirst: Bool = false, mouse: (CGEventType, CGPoint) throws -> Void) throws -> [String:Any] {
    let role = attribute(element, kAXRoleAttribute) as? String ?? "", subrole = attribute(element, kAXSubroleAttribute) as? String ?? ""
    let editable = focusRequested(role: role, subrole: subrole)
    let before = clickSnapshot(state: windowState(), control: element)
    var via = pointer ? ClickRoute.pointer : .press, effect = ClickEffect.none
    if editable {
        try ensureRunning()
        via = .press
        if !before.targetFocused { _ = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue) }
        effect = readClickEffect(before: before, control: element, editable: true)
    }
    func click() throws {
        via = .pointer
        try mouse(.leftMouseDown, target)
        postInput(CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: target, mouseButton: .left))
        effect = readClickEffect(before: before, control: element, editable: editable)
    }
    func press() throws {
        try ensureRunning()
        via = .press
        _ = AXUIElementPerformAction(element, kAXPressAction as CFString)
        effect = readClickEffect(before: before, control: element, editable: editable)
    }
    let pressable = actionNames(element).contains(kAXPressAction)
    // A hit-invisible control (its point falls through to its own ancestor:
    // a check box or radio drawn by its label, HitCover.hitAncestor) is
    // pressed by its own action first (WebKit toggles a check box or radio
    // and activates a button on AXPress); the pointer click at the point,
    // which reaches the label and toggles it through its binding, is the
    // route only when the control offers no press or the press read as
    // nothing. Otherwise the pointer comes first, then the press.
    if pressFirst {
        if effect == .none, pressable { try press() }
        if effect == .none, pointer { try click() }
    } else {
        if effect == .none, pointer { try click() }
        if effect == .none, pressable { try press() }
    }
    return clickResult(effect: effect, via: revealRoute(scrolled: scrolled, route: via) ?? via)
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
    accessibilityLevel(window: attribute(element, kAXFocusedWindowAttribute).map { $0 as! AXUIElement }, focusedRole: focusedRole, hitTarget: hitTarget)
}
func accessibilityLevel(window: AXUIElement?, focusedRole: String, hitTarget: Bool) -> SurfaceAccessibility? {
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
    // A control under the Dock, or one the page has moved since the model read
    // it, is brought into the clear first (revealControl, Reveal.swift); the
    // hit test below then describes the point the click will land on. Under
    // the Dock still (a short page cannot scroll), the application's own
    // element at the point is what the click reaches, by accessibility alone
    // (clickNamedControl posts no pointer there), so it is what policy reads.
    // A control whose point falls through to its own ancestor (a check box or
    // radio drawn by its label: the hit test finds the label's group or the
    // web area) is hit-invisible, not covered (hitCover, Reveal.swift): the
    // control itself is reported as the target, with hitAncestor beside it,
    // and execute presses it by its own action.
    var hitScope = AXUIElementCreateSystemWide(), controlScrolled = false, hitAncestor: AXUIElement? = nil
    if requested?["type"] as? String == "click_control", let request = requested {
        let resolution = resolveNamedControlEntry(request)
        switch resolution.match {
        case .matched:
            if let control = resolution.control, let entry = resolution.entry {
                action?["x"] = control.x; action?["y"] = control.y
                if control.enabled, let window = attribute(element, kAXFocusedWindowAttribute).map({ $0 as! AXUIElement }) {
                    let b = CGDisplayBounds(displayID)
                    if let reveal = try? revealControl(entry.element, window: window, display: b, application: hitScope, routes: isStopped() ? nil : frontRevealRoutes()),
                       let point = reveal.point {
                        let fraction = displayFraction(point, display: b)
                        action?["x"] = fraction.x; action?["y"] = fraction.y
                        controlScrolled = reveal.scrolled
                        if !reveal.clear {
                            if dockCovers(point) { hitScope = element }
                            else if hitCover(entry.element, at: point, application: hitScope) == .hitAncestor { hitAncestor = entry.element }
                        }
                    }
                }
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
    let focusedWindow = attribute(element, kAXFocusedWindowAttribute).map { $0 as! AXUIElement }
    let focusedElement = attribute(element, kAXFocusedUIElementAttribute).map { $0 as! AXUIElement }
    // The page's host (Chromium's window document, else the web area: Safari
    // sets no window-level URL), and, in a browser, whether a page is there
    // whose address could not be read, which the policy never takes for safe.
    var domain: String? = nil, hostUnknown = false
    if let window = focusedWindow {
        let page = pageIdentity(window: window, focused: focusedElement)
        domain = page.host
        hostUnknown = pageHostUnknown(browser: browserAppIDs.contains(app.bundleIdentifier ?? ""), host: page.host, unreadableWebArea: page.unreadable)
    }
    var result: [String: Any] = ["appId":app.bundleIdentifier ?? "unknown", "pid":Int(app.processIdentifier), "secureInput":secure, "unknown":!AXIsProcessTrusted()]
    // Display name, so an approval question can name the application the user
    // sees ("Spotify") rather than its bundle identifier.
    if let name = app.localizedName, !name.isEmpty { result["appName"] = utf16Prefix(name, 100) }
    if modalContext(window: focusedWindow, element: focusedElement) { result["modal"] = true }
    if let domain = domain { result["domain"] = domain }
    if hostUnknown { result["hostUnknown"] = true }
    if let role = focusedRole {result["focusedRole"] = role}
    if let subrole = focusedSubrole, !subrole.isEmpty {result["focusedSubrole"] = subrole}
    if !focusedLabel.isEmpty {result["focusedLabel"] = focusedLabel}
    if terminalFocus {result["terminalFocus"] = true}
    result["addressBar"] = addressBar
    if addressBar {result["focusedValue"] = focusedValue}
    if app.bundleIdentifier == "com.apple.Spotlight" {result["launcher"] = spotlightState(element)}
    if let control = hitAncestor {
        for (key, value) in targetElementFacts(control, names: [elementText(control)] + targetNames(control)) { result[key] = value }
    } else if let a = action, let x = a["x"] as? Double,let y = a["y"] as? Double,x>=0,x<=1,y>=0,y<=1 {
        let b = CGDisplayBounds(displayID)
        for (key, value) in hitTargetFacts(hitScope, at: CGPoint(x: b.minX+x*b.width, y: b.minY+y*b.height)) { result[key] = value }
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
    for (key, value) in commandFacts(element, pid: app.processIdentifier, action: action) { result[key] = value }
    if let status = namedControl {
        result["controlStatus"] = status.status
        if let label = status.label { result["controlLabel"] = utf16Prefix(label, 120) }
        if controlScrolled { result["controlScrolled"] = true }
        if hitAncestor != nil { result["hitAncestor"] = true }
    }
    // Computed last: the hit test above is the pointer evidence that this
    // application publishes something at the requested position.
    if let level = accessibilityLevel(element, focusedRole: focusedRole ?? "", hitTarget: result["targetRole"] != nil) {
        result["accessibility"] = level.rawValue
    }
    return result
}
// The element under a point and the control it belongs to, as surface reports
// them for policy: hit-tested system-wide for the frontmost window, or within
// one application for a bound window.
func hitTargetFacts(_ application: AXUIElement, at point: CGPoint) -> [String:Any] {
    var target: AXUIElement?
    guard AXUIElementCopyElementAtPosition(application, Float(point.x), Float(point.y), &target) == .success, var target = target else { return [:] }
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
    return targetElementFacts(target, names: names)
}
// The target facts of one element as surface reports them: the element the
// hit walk settled on, or a hit-invisible control itself (hitCover).
func targetElementFacts(_ target: AXUIElement, names: [String]) -> [String:Any] {
    var result = [String:Any]()
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
    return result
}
// What an application's own commands say about a step: the search its command
// opened and what was typed there, a menu item's state, a chord's published
// item. Read from the application element given, frontmost or bound.
func commandFacts(_ element: AXUIElement, pid: pid_t, action: [String:Any]?) -> [String:Any] {
    var result = [String:Any]()
    if let command = withState({ searchCommand }),
       searchCommandCurrent(commandPid: command.pid, commandAt: command.at, pid: pid, now: ProcessInfo.processInfo.systemUptime) {
        result["searchOpenedBy"] = command.title
        // The agent's own typing, never the field's value: ENTER in a palette
        // runs whichever command that text selected. The state says when an
        // arrow key or an edit means the text is only the last known one.
        if let query = command.query { result["searchQuery"] = query }
        if let state = command.state { result["searchQueryState"] = state.rawValue }
    } else if let type = action?["type"] as? String, ["type_text", "key"].contains(type),
              let path = menuMap(element, pid: pid).searchPath {
        // Typing with nothing identified to type into: name the application's
        // own way to open a field, so the refusal is a route, not a dead end.
        result["searchCommand"] = path.map { utf16Prefix($0, 60) }
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
        let shortcuts = menuMap(element, pid: pid).shortcuts
        if let item = publishedShortcutItem(keys: names, shortcuts: shortcuts) { result["shortcutLabel"] = shortcutMenuLabel(item) }
        if let status = shortcutStatus(keys: names, shortcuts: shortcuts) { result["shortcutStatus"] = status }
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
    // The <label for> or AppKit label that titles the field, never its contents.
    return titleElementName(element)
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
    // A browser page whose address could not be read is not taken for safe:
    // refused while any domain is protected, as a watch is (watchDomainRefused).
    if s["hostUnknown"] as? Bool == true, watchDomainRefused(domain: nil, browser: true, protectedDomains: protectedDomains) { throw ControlError("The page's address could not be read. Take over manually.", code: "SURFACE_BLOCKED") }
}
// The text a window shows, shallow and bounded, never a secure field's.
func windowVisibleText(_ window: AXUIElement) -> String {
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
    visit(window,0)
    return String(text.joined(separator:"\n").prefix(4200))
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
        result["visibleText"]=windowVisibleText(window)
    }
    // In a browser the page is the content, whatever has focus: the find bar,
    // a menu or the address bar are separate windows or chrome around it.
    if browserAppIDs.contains(app.bundleIdentifier ?? ""),
       let main=attribute(element,kAXMainWindowAttribute) ?? attribute(element,kAXFocusedWindowAttribute) {
        let page=webVisibleText(main as! AXUIElement, display: CGDisplayBounds(displayID))
        if page.text.count > (result["visibleText"] as? String ?? "").count {result["visibleText"]=String(page.text.prefix(4200))}
        // The walk's account, whichever text won: a cut page is a fact of the frame.
        if let truncated = page.truncated {result["visibleTextTruncated"]=truncated}
        result["visibleTextNodes"]=page.nodes;result["visibleTextMs"]=page.elapsedMs;result["visibleTextWalk"]=page.walk
    }
    let focused=attribute(element,kAXFocusedUIElementAttribute).map{$0 as! AXUIElement}
    // The page's address, whatever has focus (browserPageAddress): the web
    // area's own URL, whole; the address field's text only while the field is
    // focused and no page URL was read. Until 2026-09-20 the field was the
    // only source, so a page with focus in its content had no address and
    // web__read_current_page was refused no_page on every research page.
    if browserAppIDs.contains(app.bundleIdentifier ?? ""),
       let window=(attribute(element,kAXMainWindowAttribute) ?? attribute(element,kAXFocusedWindowAttribute)).map({$0 as! AXUIElement}) {
        let field=focused.map{browserAddressField($0,appId:app.bundleIdentifier ?? "")} ?? false
        if let address=browserPageAddress(pageURLs:pageAddressCandidates(window:window,focused:focused),
                                          fieldValue:field ? focused.flatMap{attribute($0,kAXValueAttribute) as? String} : nil,fieldFocused:field) {result["browserAddress"] = address}
    }
    if let focused {
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
    heldInput.targetPid = nil
    heldInput.record(type:event.type,location:event.location,keyCode:CGKeyCode(truncatingIfNeeded:event.getIntegerValueField(.keyboardEventKeycode)))
    event.setIntegerValueField(.eventSourceUserData,value:inputMarker);event.post(tap:.cghidEventTap)
    stateLock.unlock()
}
// Releases anything still pressed and ends the process without unlocking, so
// no request thread can post input afterwards. With a signal, the default
// action is re-raised so the parent still observes that signal. Input posted
// to a bound process is released to that process, never to the HID stream.
func releaseHeldInputAndExit(signal terminating: Int32? = nil) -> Never {
    stateLock.lock()
    stopped = true
    let held = heldInput; heldInput = HeldInput()
    func post(_ event: CGEvent?) {
        event?.setIntegerValueField(.eventSourceUserData,value:inputMarker)
        if let pid = held.targetPid { event?.setIntegerValueField(.eventTargetUnixProcessID, value: Int64(pid)); event?.postToPid(pid) } else { event?.post(tap:.cghidEventTap) }
    }
    if let point = held.leftButton { post(CGEvent(mouseEventSource:nil,mouseType:.leftMouseUp,mouseCursorPosition:point,mouseButton:.left)) }
    if let point = held.rightButton { post(CGEvent(mouseEventSource:nil,mouseType:.rightMouseUp,mouseCursorPosition:point,mouseButton:.right)) }
    for code in held.keys.reversed() { post(CGEvent(keyboardEventSource:nil,virtualKey:code,keyDown:false)) }
    if let tap = tap { CGEvent.tapEnable(tap:tap, enable:false) }
    if let terminating = terminating { signal(terminating,SIG_DFL);kill(getpid(),terminating) }
    _exit(0)
}
// Notes one input event of the user's own and, for a press, drag, wheel or
// key, where it put their hands relative to the bound window (a hover moves
// nothing); cheap and lock-protected, safe on the event tap path.
func recordManualInput(_ kind: ManualInputKind?, placement: HandsPlacement? = nil) {
    guard let kind = kind else { return }
    let now = ProcessInfo.processInfo.systemUptime
    idleLock.lock(); manualInputEpisode.observe(kind: kind, at: now, placement: placement); lastManualInputAt = now; idleLock.unlock()
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
// One wheel movement in the scroll action's sign: delta_y positive moves down the page.
func postScroll(dx:Int,dy:Int) {
    postInput(CGEvent(scrollWheelEvent2Source:nil,units:.pixel,wheelCount:2,wheel1:Int32(-dy),wheel2:Int32(-dx),wheel3:0))
}
// MARK: - Continuous scrolling (a spoken "scroll down")
// The scroll under way, its timer and the window it scrolls (guarded by stateLock).
var scrollSession: ScrollSession?
var scrollTimer: DispatchSourceTimer?
var scrollTarget: (pid: pid_t, window: AXUIElement)?
var scrollSessions = 0
let scrollQueue = DispatchQueue(label:"ai.coarena.controller.scroll",qos:.userInteractive)
// Starts scrolling the window in front gently, or steers the scroll under way
// (a new direction or pace, a fresh lease). The latch lifts so the tap watches
// for the user's own input; every way the scroll ends latches again.
func startContinuousScroll(_ command:[String:Any]) throws -> [String:Any] {
    guard let direction = ScrollDirection(rawValue:command["direction"] as? String ?? "") else { throw ControlError("Invalid scroll direction.") }
    let pacing = ScrollPacing(direction:direction, speed:command["speed"] as? Double ?? 1)
    let now = ProcessInfo.processInfo.systemUptime
    if let steered = withState({ () -> ScrollSession? in scrollSession?.steer(pacing, now:now); return scrollSession }) {
        latch(false)
        return steered.started()
    }
    guard AXIsProcessTrusted() else { throw ControlError("Accessibility permission is required.") }
    guard installTap() else { throw ControlError("Emergency stop could not be registered. Input remains disabled.") }
    try guardSurface()
    guard let app = inputApplication(), app.processIdentifier != getppid(), app.bundleIdentifier != "ai.coarena.openassist" else { throw ControlError("No application is in front.") }
    guard let window = attribute(AXUIElementCreateApplication(app.processIdentifier),kAXFocusedWindowAttribute).map({ $0 as! AXUIElement }),
          let bounds = elementRect(window), !bounds.isEmpty else { throw ControlError("No window to scroll.") }
    latch(false)
    // The wheel goes to the window under the pointer: bring the pointer over
    // the window in front when it rests elsewhere (the pill, another display).
    if let pointer = CGEvent(source:nil)?.location, !bounds.contains(pointer) {
        postInput(CGEvent(mouseEventSource:nil,mouseType:.mouseMoved,mouseCursorPosition:CGPoint(x:bounds.midX,y:bounds.midY),mouseButton:.left))
    }
    let timer = DispatchSource.makeTimerSource(queue:scrollQueue)
    let session = withState { () -> ScrollSession in
        scrollSessions += 1
        let session = ScrollSession(id:scrollSessions, pacing:pacing, now:now)
        scrollSession = session; scrollTarget = (app.processIdentifier, window); scrollTimer = timer
        return session
    }
    timer.schedule(deadline: .now() + .milliseconds(ScrollPacing.tickMs), repeating: .milliseconds(ScrollPacing.tickMs), leeway: .milliseconds(10))
    timer.setEventHandler { scrollTick() }
    timer.resume()
    return session.started()
}
// One tick: the scroll ends on the latch (a stop; the user's own input ends it
// from the tap first), when another window came in front, at the lease's end,
// or on a surface the floors refuse; otherwise one wheel movement goes out.
func scrollTick() {
    stateLock.lock(); let current = scrollSession, target = scrollTarget; stateLock.unlock()
    guard let session = current, let target = target else { return }
    if isStopped() { endContinuousScroll(.stop); return }
    if session.expired(now:ProcessInfo.processInfo.systemUptime) { endContinuousScroll(.limit); return }
    let window = attribute(AXUIElementCreateApplication(target.pid),kAXFocusedWindowAttribute).map { $0 as! AXUIElement }
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == target.pid, sameElement(window, target.window) else { endContinuousScroll(.appChanged); return }
    if session.guardsSurface {
        do { try guardSurface() } catch { endContinuousScroll(.error, message:(error as? ControlError)?.message); return }
    }
    postScroll(dx:0, dy:session.pacing.deltaY)
    withState { scrollSession?.posted() }
}
// Ends the scroll once, whoever gets there first (the tap on the user's input,
// a stop request, the tick), and reports why and how far it got.
func endContinuousScroll(_ reason:ScrollEndReason, message:String? = nil) {
    stateLock.lock()
    let session = scrollSession, timer = scrollTimer
    scrollSession = nil; scrollTarget = nil; scrollTimer = nil
    stateLock.unlock()
    guard let session = session else { return }
    timer?.cancel()
    latch(true)
    emit(session.ended(reason, message:message))
}
// Tells main when the user's manual input has gone quiet (idleMs 1000, then
// 3000), so it can decide whether a paused run continues. Informational only:
// nothing here changes the stop latch.
func startIdleReporting() {
    guard idleTimer == nil else { return }
    let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
    timer.schedule(deadline: .now() + .milliseconds(150), repeating: .milliseconds(150), leeway: .milliseconds(30))
    timer.setEventHandler {
        // With a target bound the report says whether that application is in
        // front now and, read against that, whether the last counted input left
        // the hands in its window, so a hold there can end when the user leaves
        // it (design §3). Read before idleLock: the two locks are never nested.
        let frontmost = withState { targetBinding }.map { NSWorkspace.shared.frontmostApplication?.processIdentifier == $0.pid }
        idleLock.lock(); let reports = manualInputEpisode.tick(now: ProcessInfo.processInfo.systemUptime, targetFrontmost: frontmost); idleLock.unlock()
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
            else if !isStopped() {endContinuousScroll(.input);latch(true);emit(["event":"user_takeover","source":"tap_timeout","eventType":type.rawValue])}
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
        // The owner's own presses, keys and wheel reach the observer as facts copied here (Observer.swift); a move or a drag never does.
        observerSawInput(type:type, event:event)
        // Where the input landed relative to a bound window, read once for the
        // episode (the resume rule) and for the scope of a takeover (design §3).
        let aimed = userInputFacts(type:type, location:event.location)
        // Already stopped: no takeover to report (so the facts above skipped
        // the frontmost lookup a key otherwise costs), but note the input and
        // where it put the hands, so main learns when the user lets go and
        // whether they have left the window.
        if isStopped() {
            if escape {
                let now = ProcessInfo.processInfo.systemUptime
                let stop = withState { () -> Bool in let fire = emergencyEscape(now: now, lastEscapeAt: lastEscapeAt, watching: watching); lastEscapeAt = now; return fire }
                if stop {emit(["event":"emergency_stop"])}
            }
            // Our own Command-Space re-posted by Siri is not the user's input;
            // checked by its deadline alone, without the app lookup.
            let echoed = type == .keyDown && withState { forwardedSpotlightEvent(type:type,keyCode:event.getIntegerValueField(.keyboardEventKeycode),flags:event.flags,systemSiri:true,now:ProcessInfo.processInfo.systemUptime,deadline:forwardedSpotlightDeadline) }
            if !echoed {recordManualInput(manualInputKind(type:type, marked:marked), placement:aimed.placement)}
            return Unmanaged.passUnretained(event)
        }
        let source = NSRunningApplication(processIdentifier:pid_t(event.getIntegerValueField(.eventSourceUnixProcessID)))
        let systemSiri = source?.bundleIdentifier == "com.apple.Siri" && source?.executableURL?.path == "/System/Library/CoreServices/Siri.app/Contents/MacOS/Siri"
        stateLock.lock()
        let forwarded = forwardedSpotlightEvent(type:type,keyCode:event.getIntegerValueField(.keyboardEventKeycode),flags:event.flags,systemSiri:systemSiri,now:ProcessInfo.processInfo.systemUptime,deadline:forwardedSpotlightDeadline)
        if forwarded {forwardedSpotlightDeadline = 0}
        stateLock.unlock()
        if forwarded {emit(["event":"input_forwarded","source":"spotlight"]);return Unmanaged.passUnretained(event)}
        recordManualInput(manualInputKind(type:type, marked:marked), placement:aimed.placement)
        if escape {latch(true);emit(["event":"emergency_stop"])}
        // The user's own hand ends a spoken scroll before the takeover is reported.
        // With a target bound, only input aimed at that window is a takeover (design §3).
        else if !isStopped(), let scope = takeoverScope(type:type, inside:aimed.inside, bound:aimed.bound, handoff:aimed.handoff) {endContinuousScroll(.input);latch(true);emit(["event":"user_takeover","source":type == .mouseMoved ? "mouse_move" : type == .keyDown ? "key" : type == .scrollWheel ? "scroll" : "mouse_button_or_drag","scope":scope.rawValue,"delta_x":event.getIntegerValueField(.mouseEventDeltaX),"delta_y":event.getIntegerValueField(.mouseEventDeltaY),"sourcePid":event.getIntegerValueField(.eventSourceUnixProcessID),"eventType":type.rawValue,"flags":event.flags.rawValue,"pointerDistance":pointerDistance])}
        return Unmanaged.passUnretained(event)
    }, userInfo:nil)
    guard let tap = tap else { return false }
    let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
    CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes); CGEvent.tapEnable(tap:tap, enable:true)
    idleLock.lock(); tapInstalledAt = ProcessInfo.processInfo.systemUptime; idleLock.unlock()
    startIdleReporting()
    return true
}
func geometry(_ display: SCDisplay, width: Int, height: Int) -> [String:Any] { geometry(display.displayID, width: width, height: height) }
func geometry(_ id: CGDirectDisplayID, width: Int, height: Int) -> [String:Any] {
    let b = CGDisplayBounds(id)
    return ["display_id":Int(id),"x":Double(b.origin.x),"y":Double(b.origin.y),"width":Double(b.width),"height":Double(b.height),"native_width":CGDisplayPixelsWide(id),"native_height":CGDisplayPixelsHigh(id),"model_width":width,"model_height":height,"scale_factor":Double(CGDisplayPixelsWide(id))/Double(b.width)]
}
/// The frame's `preview`: the screenshot at most 1024 px wide as a JPEG at
/// quality 0.6, with its size, for steps whose accessibility context already
/// describes the screen (settings.visionMode; src/core/vision.ts). Image
/// tokens follow pixel area on every provider, so it costs about half the
/// PNG's. Nil when scaling or encoding fails; the step then sends the PNG.
func previewRendition(_ image: CGImage) -> [String:Any]? {
    let scale = min(1, 1024 / Double(image.width))
    let width = Int((Double(image.width) * scale).rounded()), height = Int((Double(image.height) * scale).rounded())
    guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue) else { return nil }
    context.interpolationQuality = .high
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    guard let scaled = context.makeImage(), let jpeg = NSBitmapImageRep(cgImage: scaled).representation(using: .jpeg, properties: [.compressionFactor: 0.6]) else { return nil }
    return ["image": "data:image/jpeg;base64," + jpeg.base64EncodedString(), "width": width, "height": height]
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
    // The PNG is only for the model: encode it, and its reduced rendition,
    // while accessibility is read.
    let encoding = Task { await offThread { NSBitmapImageRep(cgImage:image).representation(using:.png, properties:[:]) } }
    let previewing = Task { await offThread { previewRendition(image) } }
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
            controls = mergeControls(controls, webControls(window, display: bounds), limit: 60) { $0 }
        }
        context["controls"] = controls
    }
    mark("controls")
    if let reading { let text = await reading.value; if text.count > 40 { context["screenText"] = text } }
    mark("ocr")
    try ensureRunning()
    guard let png = await encoding.value else { throw ControlError("Screenshot encoding failed.") }
    let preview = await previewing.value
    mark("encode")
    timings["total"] = Int(((ProcessInfo.processInfo.systemUptime - startedAt) * 1000).rounded())
    var frame: [String:Any] = ["id":UUID().uuidString.lowercased(),"sha256":SHA256.hash(data:png).map{String(format:"%02x",$0)}.joined(),"image":"data:image/png;base64,"+png.base64EncodedString(),"geometry":geometry(display,width:config.width,height:config.height),"capturedAt":ProcessInfo.processInfo.systemUptime*1000,"synthetic":false,"appId":before["appId"] ?? "unknown","context":context,"timings":timings]
    if let preview { frame["preview"] = preview }
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
// Returns the result fields the step reports beside "executed": a hotkey's
// route ("via": menu or keys), a click by name's route and effect
// (ClickEffect.swift), nothing for the rest.
func execute(_ action:[String:Any], menuRoute: [String]? = nil) throws -> [String:Any] {
    try ensureRunning(); try guardSurface()
    // Waiting and observing send no input, so window transitions must not reject them.
    switch action["type"] as? String {
    case "wait": guard let ms = action["milliseconds"] as? Int, ms>=0,ms<=5000 else {throw ControlError("Invalid wait.")};for _ in 0..<(ms/10){try ensureRunning();Thread.sleep(forTimeInterval:0.01)};return [:]
    case "capture": return [:]
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
        postScroll(dx:dx,dy:dy)
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
        let resolution = resolveNamedControlEntry(action)
        guard case .matched = resolution.match, let control = resolution.control, let entry = resolution.entry else {
            switch resolution.match {
            case .ambiguous(let count):
                throw ControlError("\(count) controls are named that. Name a different control, or add the x and y from the context list.", code: "TARGET_AMBIGUOUS")
            default:
                throw ControlError("No control named that is on screen now. Choose one from the context list.", code: "TARGET_MISSING")
            }
        }
        guard control.enabled else { throw ControlError("That control is disabled.", code: "TARGET_DISABLED") }
        var target = CGPoint(x: b.minX+min(b.width-1, floor(control.x*b.width)), y: b.minY+min(b.height-1, floor(control.y*b.height)))
        // A control under the Dock, or moved since the model read it, is
        // brought into the clear first (Reveal.swift); a point still covered
        // gets no pointer click, only the control's own focus or press.
        let reveal = try revealControl(entry.element, window: savedWindow.window, display: b, application: AXUIElementCreateSystemWide(), routes: frontRevealRoutes())
        if let point = reveal.point { target = point }
        // A hit-invisible control (its point falls through to its own
        // ancestor, hitCover) is pressed by its own action first; the
        // pointer click is its second route only while the point is visible.
        let hitAncestor = !reveal.clear && reveal.point != nil && hitCover(entry.element, at: target, application: AXUIElementCreateSystemWide()) == .hitAncestor
        // Cycle 20260919-2044: five STUCK_LOOP runs were this click repeated on
        // an unchanged page, the step reported done with nothing read back.
        return try clickNamedControl(entry.element, at: target, pointer: reveal.clear || (hitAncestor && reveal.visible), scrolled: reveal.scrolled, pressFirst: hitAncestor) { type, point in try mouse(type, point) }
    case "key", "hotkey":
        let names = action["keys"] as? [String] ?? [action["key"] as? String ?? ""]
        guard names.count<=4,names.allSatisfy({keys[$0] != nil}) else {throw ControlError("Unsupported key.")}
        guard clipboardChordAllowed(names: names, paste: action["paste"] as? Bool == true) else {throw ControlError("Clipboard disabled.")}
        // Pressed by name like menu_item, resolved again now: a refused, missing or
        // greyed-out item is reported, and its keys are never posted instead.
        if action["type"] as? String == "hotkey", let path = menuRoute { try pressMenuPath(path, chord: normalizeChord(names)); return ["via": "menu"] }
        var flags:CGEventFlags = [];for name in names {if name == "CMD"{flags.insert(.maskCommand)};if name == "CTRL"{flags.insert(.maskControl)};if name == "ALT"{flags.insert(.maskAlternate)};if name == "SHIFT"{flags.insert(.maskShift)}}
        var pressed:[CGKeyCode] = [];defer {for code in pressed.reversed(){postInput(CGEvent(keyboardEventSource:nil,virtualKey:code,keyDown:false))}}
        for name in names {try ensureRunning();let code = keys[name]!;let e = CGEvent(keyboardEventSource:nil,virtualKey:code,keyDown:true);e?.flags = flags;postInput(e);pressed.append(code)}
        return action["type"] as? String == "hotkey" ? ["via": "keys"] : [:]
    default: throw ControlError("Unknown native action.")
    }
    return [:]
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
// the focused window (its document, its URL, else its web areas).
func windowDomain(_ window: AXUIElement) -> String? {
    pageIdentity(window: window, focused: nil).host
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
// MARK: target
/**
 A background run is bound to one window for its whole life (design §2.2). The
 token is the only name TypeScript has for it, minted here like a watch's;
 every posted event, tree read and menu press of the run addresses this
 process and this window, and nothing else. One target at a time, guarded by
 stateLock like the watch bindings.
 */
struct TargetBinding {
    let token: String
    let pid: pid_t
    let windowID: CGWindowID
    let appId: String
    let appName: String
    let title: String
    let window: AXUIElement
    let launchedAt: TimeInterval?
    let appClass: TargetAppClass
    var identity: TargetIdentity { TargetIdentity(pid: pid, bundleId: appId, launchedAt: launchedAt) }
}
var targetBinding: TargetBinding?
// The uncovered parts of the bound window's frame, for the tap's hit test:
// refreshed every 250 ms and when the window moves or resizes, off the tap
// thread, from the window server's list alone.
var targetUncovered = [CGRect]()
// Rung 3 is under way: the target was brought forward on purpose, so its
// activation is expected and the user's input pauses the run as it does today.
var targetHandoff = false
// Ends a handoff nobody closed (BackgroundInput.swift handoffIdleLimit).
var handoffWatch: DispatchSourceTimer?
var targetMisses = RungMisses()
var targetRectTimer: DispatchSourceTimer?
var targetObserver: AXObserver?
var targetActivationObserver: NSObjectProtocol?
// The application in front before the target activated itself, to give the
// front back to (never Butler or this helper).
var foregroundBeforeTarget: pid_t?
// What a delivery did: nothing (no route here), an action, or a text write
// with the value the field must now read as.
enum TargetDelivery: Equatable { case none, acted, wrote(String) }

func runningIdentity(_ app: NSRunningApplication) -> TargetIdentity {
    TargetIdentity(pid: app.processIdentifier, bundleId: app.bundleIdentifier ?? "", launchedAt: app.launchDate?.timeIntervalSince1970)
}
// Butler's own processes (the app this helper serves, and the helper): never
// a target, never the application given the front back, never counted as
// covering the target.
func butlerOwn(pid: pid_t) -> Bool {
    pid == getppid() || pid == getpid() || NSRunningApplication(processIdentifier: pid)?.bundleIdentifier == "ai.coarena.openassist"
}
func butlerOwn(_ app: NSRunningApplication) -> Bool { butlerOwn(pid: app.processIdentifier) }
// The application in front when the wake word ended or the command was typed
// (rememberForeground), while it still runs: an empty bind spec means it.
func rememberedApplication() -> NSRunningApplication? {
    guard let pid = rememberedPID, let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated, !butlerOwn(app) else { return nil }
    return app
}
// Electron ships its framework inside the bundle; the class decides which
// posted events are refused and which read-backs are trusted.
func electronFramework(_ app: NSRunningApplication) -> Bool {
    guard let url = app.bundleURL else { return false }
    return FileManager.default.fileExists(atPath: url.appendingPathComponent("Contents/Frameworks/Electron Framework.framework").path)
}
// One window as the window server lists it, on screen or not.
func windowInfo(_ id: CGWindowID) -> (owner: pid_t, bounds: CGRect, onScreen: Bool)? {
    guard let info = (CGWindowListCopyWindowInfo(.optionIncludingWindow, id) as? [[String:Any]])?.first,
          let owner = info[kCGWindowOwnerPID as String] as? Int,
          let raw = info[kCGWindowBounds as String] as? [String:Any], let rect = CGRect(dictionaryRepresentation: raw as CFDictionary) else { return nil }
    return (pid_t(owner), rect, info[kCGWindowIsOnscreen as String] as? Bool ?? false)
}
// The window server's id of an accessibility window, by its owner and bounds,
// minimized and other-Space windows included.
func windowID(of window: AXUIElement, pid: pid_t) -> CGWindowID? {
    guard let bounds = elementRect(window), let list = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String:Any]] else { return nil }
    for info in list {
        guard (info[kCGWindowOwnerPID as String] as? Int) == Int(pid), (info[kCGWindowLayer as String] as? Int) == 0,
              let raw = info[kCGWindowBounds as String] as? [String:Any], let rect = CGRect(dictionaryRepresentation: raw as CFDictionary),
              let number = info[kCGWindowNumber as String] as? Int, nearly(rect, bounds) else { continue }
        return CGWindowID(number)
    }
    return nil
}
// The running application the words name, resolved as open_app resolves a
// name (the launcher's rules over the installed applications, allow-listed
// folders and floors), then found among the running ones by bundle identifier.
// Words that are not an application are a plain refusal, so the runner tries
// its next candidate; an installed application that is not running is
// TARGET_GONE, so the run says so and opens it in front.
func runningApplication(named name: String) throws -> NSRunningApplication {
    guard !normalizeAppName(name).isEmpty else { throw ControlError("Name an application.") }
    let running = NSWorkspace.shared.runningApplications.filter { !$0.isTerminated && $0.activationPolicy == .regular }
    let resolution = resolveTargetName(resolveLaunch(query: name, candidates: applicationCandidates(), protectedApps: protectedApps),
                                       runningBundleIds: Set(running.compactMap { $0.bundleIdentifier?.lowercased() }))
    switch resolution {
    case .running(let bundleId, _):
        let instances = running.filter { $0.bundleIdentifier?.lowercased() == bundleId.lowercased() }
        guard let app = instances.first(where: { $0.isActive }) ?? instances.first else { throw ControlError("That application is not running.", code: TargetRefusal.gone.rawValue) }
        return app
    case .notRunning: throw ControlError("That application is not running.", code: TargetRefusal.gone.rawValue)
    case .protected: throw ControlError("That application cannot be worked in the background.", code: TargetRefusal.protected.rawValue)
    case .unknown: throw ControlError("No application is called that.")
    }
}
// The window a bound run works in: the one whose title the words name; else
// the application's focused window, else its main window, else the largest
// standard window it shows (the frontmost on ties, the list being in z-order).
func targetWindow(_ app: NSRunningApplication, element: AXUIElement, title: String?) -> AXUIElement? {
    let windows = attribute(element, kAXWindowsAttribute) as? [AXUIElement] ?? []
    if let title { return windows.first { targetTitleMatches(request: title, title: attribute($0, kAXTitleAttribute) as? String ?? "") } }
    if let window = (attribute(element, kAXFocusedWindowAttribute) ?? attribute(element, kAXMainWindowAttribute)).map({ $0 as! AXUIElement }) { return window }
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String:Any]] ?? []
    var largest: (area: Double, rect: CGRect)? = nil
    for info in list {
        guard (info[kCGWindowOwnerPID as String] as? Int) == Int(app.processIdentifier), (info[kCGWindowLayer as String] as? Int) == 0,
              let raw = info[kCGWindowBounds as String] as? [String:Any], let rect = CGRect(dictionaryRepresentation: raw as CFDictionary) else { continue }
        let area = Double(rect.width * rect.height)
        if largest.map({ area > $0.area }) ?? true { largest = (area, rect) }
    }
    guard let rect = largest?.rect else { return nil }
    return windows.first { elementRect($0).map { nearly($0, rect) } == true }
}
/**
 Binds the window a background run works in (design §2.2): named by its window
 id, its process, its application's name or its window title, else the
 frontmost application's focused window. Refuses what a watch refuses, so a
 protected application, a terminal, a launcher, Butler itself or a protected
 page is never a target, and a target is never brought forward by anything
 but the announced handoff. Binding another target releases the last.
 */
func bindTarget(_ spec: [String:Any]) throws -> [String:Any] {
    guard CGPreflightScreenCaptureAccess() else { throw ControlError("Grant Screen Recording permission and restart the app.") }
    guard AXIsProcessTrusted() else { throw ControlError("Accessibility permission is required.") }
    let requestedWindow = (spec["windowId"] as? Int).map { CGWindowID($0) }
    let app: NSRunningApplication
    if let id = requestedWindow, let info = windowInfo(id), let owner = NSRunningApplication(processIdentifier: info.owner) { app = owner }
    else if let pid = spec["pid"] as? Int, let running = NSRunningApplication(processIdentifier: pid_t(pid)) { app = running }
    else if let name = spec["app"] as? String { app = try runningApplication(named: name) }
    // Nothing named: the window focused when the wake word ended (design §2.2,
    // rule 3), even if the user Cmd-Tabbed away since; the front now only when
    // nothing was remembered.
    else if requestedWindow == nil, spec["pid"] == nil, let focused = rememberedApplication() ?? NSWorkspace.shared.frontmostApplication { app = focused }
    else { throw ControlError("That window is not open.", code: TargetRefusal.gone.rawValue) }
    let appId = app.bundleIdentifier ?? ""
    guard !app.isTerminated, !butlerOwn(app), !watchRefused(appId) else {
        throw ControlError("That application cannot be worked in the background.", code: TargetRefusal.protected.rawValue)
    }
    exposeAccessibilityTree(app)
    let element = AXUIElementCreateApplication(app.processIdentifier)
    _ = AXUIElementSetMessagingTimeout(element, 2.0)
    let window: AXUIElement
    if let id = requestedWindow {
        guard let found = watchWindowElement(pid: app.processIdentifier, windowID: id) else { throw ControlError("That window is not open.", code: TargetRefusal.gone.rawValue) }
        window = found
    } else {
        guard let found = targetWindow(app, element: element, title: spec["title"] as? String) else { throw ControlError("That application has no window to work in.", code: TargetRefusal.gone.rawValue) }
        window = found
    }
    _ = AXUIElementSetMessagingTimeout(window, 2.0)
    guard !watchWindowProtected(appId: appId, window: window) else { throw ControlError("That page cannot be worked in the background.", code: TargetRefusal.protected.rawValue) }
    guard let bounds = elementRect(window), bounds.width > 40, bounds.height > 40 else { throw ControlError("The window has no usable bounds.", code: TargetRefusal.gone.rawValue) }
    guard let windowID = requestedWindow ?? windowID(of: window, pid: app.processIdentifier) else { throw ControlError("The window could not be identified on screen.", code: TargetRefusal.gone.rawValue) }
    let binding = TargetBinding(token: UUID().uuidString.lowercased(), pid: app.processIdentifier, windowID: windowID, appId: appId,
                                appName: utf16Prefix(app.localizedName ?? "", 100), title: String((attribute(window, kAXTitleAttribute) as? String ?? "").prefix(300)),
                                window: window, launchedAt: app.launchDate?.timeIntervalSince1970,
                                appClass: targetAppClass(bundleId: appId, electronFramework: electronFramework(app)))
    releaseTarget()
    let front = NSWorkspace.shared.frontmostApplication
    withState {
        targetBinding = binding; targetMisses = RungMisses()
        foregroundBeforeTarget = front.flatMap { $0.processIdentifier != binding.pid && !butlerOwn($0) ? $0.processIdentifier : nil }
    }
    refreshTargetRects()
    startTargetTracking(binding)
    return ["token": binding.token, "pid": Int(binding.pid), "windowId": Int(windowID), "appId": appId, "appName": binding.appName, "title": binding.title]
}
// The binding a token names, still naming its process and its window; anything
// else is TARGET_GONE, released and never re-resolved by name. Thrown to a
// caller, the code travels in the reply and the runner acts on it there; the
// event is for a target that dies between calls (targetTracking).
func liveTarget(_ token: String) throws -> TargetBinding {
    guard let bound = withState({ targetBinding }), watchProbeAllowed(token: token, bound: bound.token) else { throw ControlError("Unknown target token.", code: TargetRefusal.gone.rawValue) }
    let running = NSRunningApplication(processIdentifier: bound.pid).flatMap { $0.isTerminated ? nil : runningIdentity($0) }
    guard targetLive(bound: bound.identity, running: running, windowOwner: windowInfo(bound.windowID)?.owner),
          attribute(bound.window, kAXRoleAttribute) != nil else { throw targetGone(bound) }
    return bound
}
@discardableResult
func targetGone(_ bound: TargetBinding, emitting: Bool = false) -> ControlError {
    releaseTarget()
    if emitting { emit(["event": "target_gone", "token": bound.token, "code": TargetRefusal.gone.rawValue]) }
    return ControlError("The target window is gone.", code: TargetRefusal.gone.rawValue)
}
// The floors of §4 on the target's own surface, never the frontmost
// application's: the application, the page its window shows, and secure input
// for anything that carries text (clicks carry none and go on).
func guardTarget(_ bound: TargetBinding, typing: Bool) throws {
    let appId = NSRunningApplication(processIdentifier: bound.pid)?.bundleIdentifier ?? bound.appId
    if appId.lowercased().contains("uninstall") || watchRefused(appId) { throw ControlError("Protected application. Take over manually.", code: TargetRefusal.protected.rawValue) }
    if watchWindowProtected(appId: appId, window: bound.window) { throw ControlError("Protected domain. Take over manually.", code: TargetRefusal.protected.rawValue) }
    if typing, IsSecureEventInputEnabled() { throw ControlError("Sensitive input is active; typing is paused.", code: "SURFACE_BLOCKED") }
}
// Every accessibility action and write of a bound run addresses an element of
// the bound process; anything else is refused before it is performed. The
// return code is advice only (AXUIElement.h: applications report failure from
// actions they performed), so the postcondition read decides.
func assertTargetElement(_ element: AXUIElement, bound: TargetBinding) throws {
    var pid: pid_t = 0
    guard AXUIElementGetPid(element, &pid) == .success, pid == bound.pid else { throw ControlError("That element is not in the target application.", code: TargetRefusal.gone.rawValue) }
    try ensureRunning()
}
func performTargetAction(_ element: AXUIElement, _ action: String, bound: TargetBinding) throws {
    try assertTargetElement(element, bound: bound)
    _ = AXUIElementPerformAction(element, action as CFString)
}
func setTargetAttribute(_ element: AXUIElement, _ name: String, _ value: CFTypeRef, bound: TargetBinding) throws {
    try assertTargetElement(element, bound: bound)
    _ = AXUIElementSetAttributeValue(element, name as CFString, value)
}
// Closes the handoff (restoreRemembered, restore, release) and its watch.
func endTargetHandoff() {
    let watch = withState { () -> DispatchSourceTimer? in targetHandoff = false; let held = handoffWatch; handoffWatch = nil; return held }
    watch?.cancel()
}

// The parts of the bound window the user can see, from the window server's
// z-ordered list: every drawn standard window in front of it, of any other
// application, covers what it overlaps. Butler's own pill and the overlays
// above the normal layer (the menu bar, the Dock, banners, Spotlight) cover
// nothing: they come and go without hiding the window from the user. No
// accessibility call, so a hung target cannot stall the tap's cache. A window
// not on screen has nothing to click and nothing fresh to show.
func targetCover(_ bound: TargetBinding) -> (frame: CGRect?, coverage: Double, uncovered: [CGRect]) {
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String:Any]] ?? []
    var above = [CGRect]()
    let own = [getppid(), getpid()]
    for info in list {
        guard let number = info[kCGWindowNumber as String] as? Int, let raw = info[kCGWindowBounds as String] as? [String:Any],
              let rect = CGRect(dictionaryRepresentation: raw as CFDictionary) else { continue }
        if CGWindowID(number) == bound.windowID { return (rect, coverage(of: rect, above: above), uncoveredRects(of: rect, above: above)) }
        guard (info[kCGWindowLayer as String] as? Int) == 0, let owner = info[kCGWindowOwnerPID as String] as? Int, !own.contains(pid_t(owner)) else { continue }
        if (info[kCGWindowAlpha as String] as? Double ?? 1) > 0 { above.append(rect) }
    }
    return (nil, 1, [])
}
// The tracking tick: the cover is refreshed, and a target that died between
// calls (its process ended or was replaced, its window closed) is reported
// once as target_gone, since no reply can carry the code to the runner then.
func refreshTargetRects() {
    guard let bound = withState({ targetBinding }) else { return }
    let running = NSRunningApplication(processIdentifier: bound.pid).flatMap { $0.isTerminated ? nil : runningIdentity($0) }
    guard targetLive(bound: bound.identity, running: running, windowOwner: windowInfo(bound.windowID)?.owner) else {
        if withState({ targetBinding?.token == bound.token }) { targetGone(bound, emitting: true) }
        return
    }
    let uncovered = targetCover(bound).uncovered
    withState { if targetBinding?.token == bound.token { targetUncovered = uncovered } }
}
// Keeps the cover fresh (a 250 ms timer, and the window's own moved and resized
// notifications on the main run loop) and watches activations for the target
// coming forward (design §3). Installed for the binding alive now; a binding
// released meanwhile installs nothing.
func startTargetTracking(_ bound: TargetBinding) {
    let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
    timer.schedule(deadline: .now() + .milliseconds(250), repeating: .milliseconds(250), leeway: .milliseconds(50))
    timer.setEventHandler { refreshTargetRects() }
    withState { targetRectTimer = timer }
    timer.resume()
    DispatchQueue.main.async {
        guard withState({ targetBinding?.token == bound.token }) else { return }
        var observer: AXObserver?
        if AXObserverCreate(bound.pid, { _, _, _, _ in refreshTargetRects() }, &observer) == .success, let observer {
            for name in [kAXWindowMovedNotification, kAXWindowResizedNotification] { AXObserverAddNotification(observer, bound.window, name as CFString, nil) }
            CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode)
        }
        let activation = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: nil) { targetActivated($0) }
        let kept = withState { () -> Bool in
            guard targetBinding?.token == bound.token else { return false }
            targetObserver = observer; targetActivationObserver = activation
            return true
        }
        if !kept {
            if let observer { CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode) }
            NSWorkspace.shared.notificationCenter.removeObserver(activation)
        }
    }
}
// Releases the bound target and everything that tracked it.
func releaseTarget() {
    let released = withState { () -> (DispatchSourceTimer?, AXObserver?, NSObjectProtocol?, DispatchSourceTimer?) in
        let held = (targetRectTimer, targetObserver, targetActivationObserver, handoffWatch)
        targetBinding = nil; targetUncovered = []; targetHandoff = false; foregroundBeforeTarget = nil
        targetRectTimer = nil; targetObserver = nil; targetActivationObserver = nil; handoffWatch = nil
        return held
    }
    released.0?.cancel()
    released.3?.cancel()
    guard released.1 != nil || released.2 != nil else { return }
    DispatchQueue.main.async {
        if let observer = released.1 { CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode) }
        if let activation = released.2 { NSWorkspace.shared.notificationCenter.removeObserver(activation) }
    }
}
// The target came to the front (design §3). By the user's hand (their own
// input within 0.3 s): the run pauses, scoped to the target. During the
// handoff: expected. Otherwise the application activated itself (Safari on a
// write, Electron on launch): the application in front before gets the front
// back at once and the run goes on. Any other activation is remembered as
// that front.
func targetActivated(_ notification: Notification) {
    guard let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
    let (bound, handoff) = withState { (targetBinding, targetHandoff) }
    guard let bound else { return }
    guard app.processIdentifier == bound.pid else {
        if !butlerOwn(app) { withState { foregroundBeforeTarget = app.processIdentifier } }
        return
    }
    switch targetActivation(lastManualInputAt: lastManualInput(), now: ProcessInfo.processInfo.systemUptime, handoff: handoff) {
    case .expected: break
    case .userEntered:
        if !isStopped() { endContinuousScroll(.input); latch(true); emit(["event": "user_takeover", "source": "target_activated", "scope": TakeoverScope.target.rawValue]) }
    case .selfActivated:
        if let previous = withState({ foregroundBeforeTarget }).flatMap({ NSRunningApplication(processIdentifier: $0) }), !previous.isTerminated { previous.activate(options: []) }
        emit(["event": "target_self_activated", "token": bound.token])
    }
}
// What the tap knows about one unmarked event and the bound window: whether a
// target is bound, whether its announced second in front is under way, where
// the input put the user's hands (recorded for the resume rule, going or held;
// a hover is nil), and whether it was aimed at the window (the scope of a
// takeover), from the hit test against the cached uncovered rectangles and,
// for a key while the run is going, one frontmost compare. A held run has no
// takeover to scope, so a key then costs no lookup: its place is read against
// the front when the idle report is written. No accessibility call here, so a
// hung target cannot stall the tap; nothing bound reads as nothing aimed, with
// the hands recorded wherever they are.
func userInputFacts(type: CGEventType, location: CGPoint) -> (bound: Bool, handoff: Bool, inside: Bool, placement: HandsPlacement?) {
    let (bound, handoff, uncovered) = withState { (targetBinding, targetHandoff, targetUncovered) }
    let placement = handsPlacement(type: type, location: location, uncovered: uncovered)
    guard let bound else { return (false, false, false, placement) }
    let frontmost = type == .keyDown && !isStopped() && NSWorkspace.shared.frontmostApplication?.processIdentifier == bound.pid
    return (true, handoff, handsInside(placement, targetFrontmost: frontmost), placement)
}

// The bound window's tree, walked as the frontmost window's is. Only a focused
// element inside the bound window is the run's: a sibling window's field is not.
func targetState(_ bound: TargetBinding) -> WindowState {
    let app = AXUIElementCreateApplication(bound.pid)
    let focused = attribute(app, kAXFocusedUIElementAttribute).map { $0 as! AXUIElement }
    let inWindow = focused.flatMap { attribute($0, kAXWindowAttribute) }.map { CFEqual($0, bound.window) } ?? false
    return windowState(pid: bound.pid, appId: bound.appId, window: bound.window, focused: inWindow ? focused : nil)
}
// What the ladder needs to know about the window now.
func targetFacts(_ bound: TargetBinding) -> TargetFacts {
    let app = AXUIElementCreateApplication(bound.pid)
    let windows = attribute(app, kAXWindowsAttribute) as? [AXUIElement] ?? []
    return TargetFacts(appClass: bound.appClass,
                       minimized: attribute(bound.window, kAXMinimizedAttribute) as? Bool == true,
                       onScreen: windowInfo(bound.windowID)?.onScreen == true,
                       focusedWindow: attribute(app, kAXFocusedWindowAttribute).map { CFEqual($0, bound.window) } ?? false,
                       siblingWindows: windows.filter { !CFEqual($0, bound.window) && attribute($0, kAXMinimizedAttribute) as? Bool != true }.count)
}
// The controls the model is shown for the bound window, centres as fractions
// of the window, with their elements: the same walk capture uses for the
// frontmost window, over the window's rectangle instead of the display's. Web
// content (a browser, Electron) nests its controls deeper than that walk goes.
func targetControlEntries(_ bound: TargetBinding, state: WindowState, frame: CGRect) -> [ControlEntry] {
    var entries = groundedControlEntries(state, display: frame)
    if bound.appClass.web { entries = mergeControls(entries, webControlEntries(bound.window, display: frame), limit: 60) { $0.item } }
    return entries
}
func targetNamedControl(_ action: [String:Any], entries: [ControlEntry]) -> (match: ControlMatch, entry: ControlEntry?, control: NamedControl?) {
    let controls = entries.map {
        NamedControl(label: $0.item["label"] as? String ?? "", role: $0.item["role"] as? String ?? "",
                     x: $0.item["x"] as? Double ?? 0, y: $0.item["y"] as? Double ?? 0, enabled: $0.item["enabled"] as? Bool ?? true)
    }
    let match = matchNamedControl(controls, label: action["label"] as? String ?? "", role: action["role"] as? String,
                                  hintX: action["x"] as? Double, hintY: action["y"] as? Double)
    if case .matched(let index) = match, controls.indices.contains(index) { return (match, entries[index], controls[index]) }
    return (match, nil, nil)
}
// Whether the element sits in web content (an AXWebArea ancestor), where a
// Chromium or Electron write can echo without rendering.
func insideWebArea(_ element: AXUIElement) -> Bool {
    var node: AXUIElement? = element
    for _ in 0..<40 {
        guard let current = node else { return false }
        if attribute(current, kAXRoleAttribute) as? String == "AXWebArea" { return true }
        node = attribute(current, kAXParentAttribute).map { $0 as! AXUIElement }
    }
    return false
}
// Whether a window holds web content at all (Mail's message view is WebKit,
// Safari's page sits under its tab group), which stops drawing while fully
// covered. The same bounded walk as webAreaHost.
func containsWebArea(_ window: AXUIElement) -> Bool {
    var found = false
    visitWebAreas(window) { _ in found = true; return true }
    return found
}
// The element of the bound application under a screen point, climbing to the
// nearest ancestor that offers the action (or the element itself with none
// asked), provided it belongs to the bound window: a sibling window of the
// same application overlapping the point is not the target.
func targetElement(at point: CGPoint, offering action: String?, bound: TargetBinding) -> AXUIElement? {
    var hit: AXUIElement?
    guard AXUIElementCopyElementAtPosition(AXUIElementCreateApplication(bound.pid), Float(point.x), Float(point.y), &hit) == .success else { return nil }
    var node = hit
    for _ in 0..<12 {
        guard let current = node else { return nil }
        if ["AXWindow", "AXApplication"].contains(attribute(current, kAXRoleAttribute) as? String ?? "") { return nil }
        if action.map({ actionNames(current).contains($0) }) ?? true {
            return attribute(current, kAXWindowAttribute).map { CFEqual($0, bound.window) } == true ? current : nil
        }
        node = attribute(current, kAXParentAttribute).map { $0 as! AXUIElement }
    }
    return nil
}
// The scroll area of the bound window under a point, for the accessibility scroll rung.
func targetScrollArea(at point: CGPoint, bound: TargetBinding) -> AXUIElement? {
    var hit: AXUIElement?
    guard AXUIElementCopyElementAtPosition(AXUIElementCreateApplication(bound.pid), Float(point.x), Float(point.y), &hit) == .success else { return nil }
    var node = hit
    for _ in 0..<20 {
        guard let current = node else { return nil }
        if attribute(current, kAXRoleAttribute) as? String == kAXScrollAreaRole {
            return attribute(current, kAXWindowAttribute).map { CFEqual($0, bound.window) } == true ? current : nil
        }
        node = attribute(current, kAXParentAttribute).map { $0 as! AXUIElement }
    }
    return nil
}
// The nearest row a cell or unlabelled control sits in, for selection by accessibility.
func rowAncestor(_ element: AXUIElement) -> AXUIElement? {
    var node: AXUIElement? = element
    for _ in 0..<8 {
        guard let current = node else { return nil }
        if attribute(current, kAXRoleAttribute) as? String == kAXRowRole { return current }
        node = attribute(current, kAXParentAttribute).map { $0 as! AXUIElement }
    }
    return nil
}
// The field a keyboard step goes to (design §2.6): the listed control the model
// named, else the bound window's focused element when it is a text role. A
// secure field is refused: the floor hands it to the user.
func typingField(_ bound: TargetBinding, action: [String:Any], state: WindowState, entries: [ControlEntry]) throws -> AXUIElement? {
    var field = state.focused
    if action["type"] as? String == "type_text", action["label"] as? String != nil {
        let resolution = targetNamedControl(action, entries: entries)
        guard case .matched = resolution.match, let entry = resolution.entry else { throw ControlError("No control named that is on screen now. Choose one from the context list.", code: "TARGET_MISSING") }
        field = entry.element
    }
    guard let field else { return nil }
    guard attribute(field, kAXSubroleAttribute) as? String != kAXSecureTextFieldSubrole else { throw ControlError("Sensitive input is active; capture and input are blocked.", code: "SURFACE_BLOCKED") }
    return ["AXTextField", "AXTextArea", "AXComboBox"].contains(attribute(field, kAXRoleAttribute) as? String ?? "") ? field : nil
}
// A query field that already holds text is replaced, not appended to, as type_text does today.
func replacesField(_ field: AXUIElement) -> Bool {
    replacesOnType(role: attribute(field, kAXRoleAttribute) as? String ?? "", subrole: attribute(field, kAXSubroleAttribute) as? String ?? "", label: fieldLabel(field))
        && !(attribute(field, kAXValueAttribute) as? String ?? "").isEmpty
}
// Text goes in by a write, not by keys (design §2.6): an insertion at the
// caret through the selected text when the field allows it, else the whole
// value with the text appended; a query field's text is replaced. The
// expectation is what the read-back must equal.
func writeText(_ text: String, into field: AXUIElement, replacing: Bool, bound: TargetBinding) throws -> TargetDelivery {
    let existing = attribute(field, kAXValueAttribute) as? String ?? ""
    let expected = replacing ? text : existing + text
    var settable = DarwinBoolean(false)
    if AXUIElementIsAttributeSettable(field, kAXSelectedTextAttribute as CFString, &settable) == .success, settable.boolValue {
        var range = replacing ? CFRange(location: 0, length: (existing as NSString).length) : CFRange(location: (existing as NSString).length, length: 0)
        if let value = AXValueCreate(.cfRange, &range) { try setTargetAttribute(field, kAXSelectedTextRangeAttribute, value, bound: bound) }
        try setTargetAttribute(field, kAXSelectedTextAttribute, text as CFString, bound: bound)
        return .wrote(expected)
    }
    if AXUIElementIsAttributeSettable(field, kAXValueAttribute as CFString, &settable) == .success, settable.boolValue {
        try setTargetAttribute(field, kAXValueAttribute, expected as CFString, bound: bound)
        return .wrote(expected)
    }
    return .none
}
/**
 The one way an event reaches a bound window (design §2.5): re-checks the
 binding, stamps the routing fields (the target process, the window under the
 pointer and the one that can handle it), marks the event as ours, records it
 as held to this pid, and posts it to the process alone. Never the HID tap:
 nothing here moves the cursor or activates anything. A release is posted even
 once the latch is on, so nothing stays pressed.
 */
func postToTarget(_ bound: TargetBinding, _ event: CGEvent?) throws {
    guard let event else { throw ControlError("Input event failed.") }
    if ![.leftMouseUp, .rightMouseUp, .keyUp].contains(event.type) { try ensureRunning() }
    let running = NSRunningApplication(processIdentifier: bound.pid).flatMap { $0.isTerminated ? nil : runningIdentity($0) }
    guard targetLive(bound: bound.identity, running: running, windowOwner: windowInfo(bound.windowID)?.owner) else { throw targetGone(bound) }
    event.setIntegerValueField(.eventTargetUnixProcessID, value: Int64(bound.pid))
    event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(bound.windowID))
    event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(bound.windowID))
    event.setIntegerValueField(.eventSourceUserData, value: inputMarker)
    stateLock.lock()
    lastInputTime = ProcessInfo.processInfo.systemUptime
    heldInput.targetPid = bound.pid
    heldInput.record(type: event.type, location: event.location, keyCode: CGKeyCode(truncatingIfNeeded: event.getIntegerValueField(.keyboardEventKeycode)))
    event.postToPid(bound.pid)
    stateLock.unlock()
}
// A posted click at a screen point (design §2.5): a stamped mouseMoved primer,
// 12 ms, then down and up 28 ms apart; a double click is two pairs 80 ms
// apart with the click state counting up; a right click carries the right
// button's number, without which it lands as nothing.
func postClick(_ bound: TargetBinding, at point: CGPoint, right: Bool, double: Bool) throws {
    try postToTarget(bound, CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left))
    Thread.sleep(forTimeInterval: 0.012)
    for count in 1...(double ? 2 : 1) {
        for (type, release) in [(right ? CGEventType.rightMouseDown : .leftMouseDown, false), (right ? CGEventType.rightMouseUp : .leftMouseUp, true)] {
            let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: right ? .right : .left)
            event?.setIntegerValueField(.mouseEventClickState, value: Int64(count))
            if right { event?.setIntegerValueField(.mouseEventButtonNumber, value: 1) }
            try postToTarget(bound, event)
            if !release { Thread.sleep(forTimeInterval: 0.028) }
        }
        if double && count == 1 { Thread.sleep(forTimeInterval: 0.08) }
    }
}
func postKey(_ bound: TargetBinding, code: CGKeyCode, flags: CGEventFlags, down: Bool) throws {
    let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)
    event?.flags = flags
    try postToTarget(bound, event)
}
// One character as cua posts it: keycode 0 with the Unicode string, no flags.
func postCharacter(_ bound: TargetBinding, _ character: Character) throws {
    let utf16 = Array(String(character).utf16)
    let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
    down?.flags = []; down?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
    try postToTarget(bound, down)
    let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
    up?.flags = []
    try postToTarget(bound, up)
}
// Rung 1: the route that names the thing, with no event at all.
func deliverByAccessibility(_ bound: TargetBinding, _ action: [String:Any], control: ControlEntry?, point: CGPoint?, field: AXUIElement?, replacing: Bool, menuRoute: [String]?) throws -> TargetDelivery {
    switch action["type"] as? String ?? "" {
    case "click_control":
        guard let element = control?.element else { return .none }
        // A field's click asks for focus, given here as the write deliverByPosting
        // makes before typing; the postcondition read verifies it took (focused).
        if focusRequested(role: attribute(element, kAXRoleAttribute) as? String ?? "", subrole: attribute(element, kAXSubroleAttribute) as? String ?? "") {
            try setTargetAttribute(element, kAXFocusedAttribute, kCFBooleanTrue, bound: bound)
            return .acted
        }
        if actionNames(element).contains(kAXPressAction) { try performTargetAction(element, kAXPressAction, bound: bound); return .acted }
        // A row or cell with no press of its own is chosen by selecting its row.
        guard let row = rowAncestor(element) else { return .none }
        try setTargetAttribute(row, kAXSelectedAttribute, kCFBooleanTrue, bound: bound)
        return .acted
    case "click":
        guard let point, let element = targetElement(at: point, offering: kAXPressAction, bound: bound) else { return .none }
        try performTargetAction(element, kAXPressAction, bound: bound)
        return .acted
    case "right_click":
        guard let point, let element = targetElement(at: point, offering: kAXShowMenuAction, bound: bound) else { return .none }
        try performTargetAction(element, kAXShowMenuAction, bound: bound)
        return .acted
    case "scroll":
        // The scroll bar's page buttons under the window's scroll area: one page
        // per area height asked for, bounded.
        guard let point, let dy = action["delta_y"] as? Int, dy != 0, let area = targetScrollArea(at: point, bound: bound),
              let bar = attribute(area, kAXVerticalScrollBarAttribute), CFGetTypeID(bar) == AXUIElementGetTypeID() else { return .none }
        let subrole = dy > 0 ? kAXIncrementPageSubrole : kAXDecrementPageSubrole
        guard let button = (attribute(bar as! AXUIElement, kAXChildrenAttribute) as? [AXUIElement] ?? []).first(where: { attribute($0, kAXSubroleAttribute) as? String == subrole }) else { return .none }
        let pages = max(1, min(5, Int((Double(abs(dy)) / max(1, Double(elementRect(area)?.height ?? 400))).rounded(.up))))
        for _ in 0..<pages { try performTargetAction(button, kAXPressAction, bound: bound) }
        return .acted
    case "menu_item":
        guard let path = action["path"] as? [String], path.count >= 2, path.count <= 3,
              path.allSatisfy({ !$0.trimmingCharacters(in: .whitespaces).isEmpty }) else { throw ControlError("Invalid menu path.") }
        try pressMenuPath(path, target: bound)
        return .acted
    case "hotkey":
        guard let path = menuRoute, let names = action["keys"] as? [String] else { return .none }
        try pressMenuPath(path, chord: normalizeChord(names), target: bound)
        return .acted
    case "key":
        // ENTER confirms the focused field when it offers that, else presses the window's default button.
        guard action["key"] as? String == "ENTER" else { return .none }
        if let field, actionNames(field).contains(kAXConfirmAction) { try performTargetAction(field, kAXConfirmAction, bound: bound); return .acted }
        guard let button = attribute(bound.window, kAXDefaultButtonAttribute), CFGetTypeID(button) == AXUIElementGetTypeID() else { return .none }
        try performTargetAction(button as! AXUIElement, kAXPressAction, bound: bound)
        return .acted
    case "type_text":
        guard let field, let text = action["text"] as? String else { return .none }
        return try writeText(text, into: field, replacing: replacing, bound: bound)
    default: return .none
    }
}
// Rung 2: events posted to the bound process at window-relative points, with
// today's per-character checks for text (stop latch, secure input, focus).
func deliverByPosting(_ bound: TargetBinding, _ action: [String:Any], point: CGPoint?, field: AXUIElement?, replacing: Bool) throws -> TargetDelivery {
    let type = action["type"] as? String ?? ""
    switch type {
    case "click", "click_control", "double_click", "right_click":
        guard let point else { return .none }
        try postClick(bound, at: point, right: action["button"] as? String == "right" || type == "right_click", double: type == "double_click")
        return .acted
    case "scroll":
        guard let point, let dx = action["delta_x"] as? Int, let dy = action["delta_y"] as? Int, abs(dx) <= 1000, abs(dy) <= 1000 else { throw ControlError("Invalid scroll.") }
        // A background window can keep a stale hit-test location: the primer first.
        try postToTarget(bound, CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left))
        Thread.sleep(forTimeInterval: 0.012)
        let wheel = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: Int32(-dy), wheel2: Int32(-dx), wheel3: 0)
        wheel?.location = point
        try postToTarget(bound, wheel)
        return .acted
    case "type_text":
        guard let field, let text = action["text"] as? String else { return .none }
        // Keys land in the focused element: the field is given focus by
        // accessibility when it has none, and nothing is posted if that fails.
        let app = AXUIElementCreateApplication(bound.pid)
        func focused() -> AXUIElement? { attribute(app, kAXFocusedUIElementAttribute).map { $0 as! AXUIElement } }
        if !sameElement(field, focused()) {
            try setTargetAttribute(field, kAXFocusedAttribute, kCFBooleanTrue, bound: bound)
            guard sameElement(field, focused()) else { return .none }
        }
        if replacing, let existing = attribute(field, kAXValueAttribute) as? String {
            var range = CFRange(location: 0, length: (existing as NSString).length)
            if let value = AXValueCreate(.cfRange, &range) { try setTargetAttribute(field, kAXSelectedTextRangeAttribute, value, bound: bound) }
        }
        for character in text {
            let focus = focused()
            switch typingInterruption(secureInput: IsSecureEventInputEnabled(), focusUnchanged: sameElement(field, focus),
                                      secureField: focus.map { attribute($0, kAXSubroleAttribute) as? String == kAXSecureTextFieldSubrole } ?? false) {
            case .surfaceBlocked?: throw ControlError("Sensitive input is active; capture and input are blocked.", code: "SURFACE_BLOCKED")
            case .focusChanged?: throw changedScreen("The focused field changed while typing.")
            case nil: break
            }
            try postCharacter(bound, character)
            Thread.sleep(forTimeInterval: 0.008)
        }
        return .acted
    case "key", "hotkey":
        let names = action["keys"] as? [String] ?? [action["key"] as? String ?? ""]
        guard names.count <= 4, names.allSatisfy({ keys[$0] != nil }) else { throw ControlError("Unsupported key.") }
        guard clipboardChordAllowed(names: names, paste: action["paste"] as? Bool == true) else { throw ControlError("Clipboard disabled.") }
        var flags: CGEventFlags = []
        for name in names { if name == "CMD" { flags.insert(.maskCommand) }; if name == "CTRL" { flags.insert(.maskControl) }; if name == "ALT" { flags.insert(.maskAlternate) }; if name == "SHIFT" { flags.insert(.maskShift) } }
        var pressed = [CGKeyCode]()
        defer { for code in pressed.reversed() { try? postKey(bound, code: code, flags: flags, down: false) } }
        for name in names { let code = keys[name]!; try postKey(bound, code: code, flags: flags, down: true); pressed.append(code) }
        return .acted
    default: return .none
    }
}
// The bound window's image alone: the window filter excludes everything else on
// the desktop by construction, so a protected window overlapping it never
// appears, and a minimized or covered window still captures. Bounded to 1440 px
// wide like the display capture; no cursor.
@available(macOS 14.0, *)
func targetCaptureSetup(_ bound: TargetBinding) async throws -> (filter: SCContentFilter, config: SCStreamConfiguration) {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    guard let window = content.windows.first(where: { $0.windowID == bound.windowID && $0.owningApplication?.processID == bound.pid }) else { throw targetGone(bound) }
    guard window.frame.width > 40, window.frame.height > 40 else { throw ControlError("The window has no usable bounds.", code: TargetRefusal.gone.rawValue) }
    let config = SCStreamConfiguration(), ratio = min(2, 1440 / window.frame.width)
    config.width = Int(window.frame.width * ratio); config.height = Int(window.frame.height * ratio); config.showsCursor = false
    return (SCContentFilter(desktopIndependentWindow: window), config)
}
// One reading of the bound window for the postcondition: its tree's controls
// hash, the field's value, its window count and its image. A field's value is
// read only for the field the step acts on, never a secure one (those are
// refused before).
// A click by name (`control`) also reads the focus and the control's own state
// (ClickEffect.swift), so a press that only focused a field is seen.
@available(macOS 14.0, *)
func observeTarget(_ bound: TargetBinding, field: AXUIElement?, control: AXUIElement? = nil, setup: (filter: SCContentFilter, config: SCStreamConfiguration)) async -> TargetObservation {
    let state = targetState(bound)
    let image = try? await SCScreenshotManager.captureImage(contentFilter: setup.filter, configuration: setup.config)
    return TargetObservation(controls: state.controls, fieldValue: field.map { String(describing: attribute($0, kAXValueAttribute) ?? "" as CFString) },
                             windowCount: onScreenWindowCount(bound.pid), pixels: image.flatMap { ScreenPixels($0) },
                             focus: focusIdentity(state.focused), control: control.map(controlStateDigest) ?? "",
                             targetFocused: control.map { sameElement($0, state.focused) } ?? false)
}
// The "did it take" step (design §2.7): read 120 ms after the delivery and, if
// nothing moved, again at 400 ms.
@available(macOS 14.0, *)
func readPostcondition(_ bound: TargetBinding, before: TargetObservation, field: AXUIElement?, control: AXUIElement? = nil, targetRect: CGRect?, setup: (filter: SCContentFilter, config: SCStreamConfiguration)) async throws -> (read: PostconditionRead, after: TargetObservation) {
    var after = before, read = PostconditionRead()
    for delay in [120, 280] {
        try await Task.sleep(nanoseconds: UInt64(delay) * 1_000_000)
        after = await observeTarget(bound, field: field, control: control, setup: setup)
        read = postconditionRead(before: before, after: after, targetRect: targetRect)
        if read.any || read.focusChanged { break }
    }
    return (read, after)
}
// The model's context for a bound window (design §2.3): the window's own
// title, document, text, focused field and menus, and what else is open so
// the model does not start the task again elsewhere. Never the user's
// frontmost window, and never a title of theirs.
func targetContext(_ bound: TargetBinding, state: WindowState, frame: CGRect, facts: TargetFacts, coverage: Double) -> [String:Any] {
    let title = String((attribute(bound.window, kAXTitleAttribute) as? String ?? "").prefix(300))
    var result: [String:Any] = ["appName": bound.appName, "windowTitle": title]
    if let document = attribute(bound.window, "AXDocument") as? String, let url = URL(string: document), url.isFileURL { result["documentName"] = String(url.lastPathComponent.prefix(300)) }
    var text = windowVisibleText(bound.window)
    if bound.appClass.web {
        let page = webVisibleText(bound.window, display: frame)
        if page.text.count > text.count { text = String(page.text.prefix(4200)) }
        if let truncated = page.truncated { result["visibleTextTruncated"] = truncated }
        result["visibleTextNodes"] = page.nodes; result["visibleTextMs"] = page.elapsedMs; result["visibleTextWalk"] = page.walk
    }
    result["visibleText"] = text
    // The page's address for a browser's bound window, as the frontmost
    // context reports it (browserPageAddress): the web area's URL, else the
    // address field's text while that field is focused.
    if browserAppIDs.contains(bound.appId),
       let address = browserPageAddress(pageURLs: pageAddressCandidates(window: bound.window, focused: state.focused),
                                        fieldValue: state.addressBar ? state.focusedValue : nil, fieldFocused: state.addressBar) { result["browserAddress"] = address }
    // The field an accessibility write would go to is the surface's
    // (focusedRole, focusedLabel), as for the frontmost window: the context
    // carries only the keys the runner's schema knows, or it is dropped whole.
    var focusedRole = ""
    if let focused = state.focused {
        focusedRole = attribute(focused, kAXRoleAttribute) as? String ?? ""
        if ["AXTextField", "AXTextArea", "AXComboBox"].contains(focusedRole), attribute(focused, kAXSubroleAttribute) as? String != kAXSecureTextFieldSubrole,
           let selection = attribute(focused, kAXSelectedTextAttribute) as? String { result["selectedText"] = String(selection.prefix(2000)) }
    }
    result["windowCount"] = min(onScreenWindowCount(bound.pid), 99)
    let open = openAppLines(openApplications())
    if !open.isEmpty { result["openApps"] = open }
    if let level = accessibilityLevel(window: bound.window, focusedRole: focusedRole, hitTarget: false) { result["accessibility"] = level.rawValue }
    let menus = menuMap(AXUIElementCreateApplication(bound.pid), pid: bound.pid).lines
    if !menus.isEmpty { result["menus"] = menus }
    let covered = windowCovered(coverage)
    result["background"] = ["appName": bound.appName, "title": title, "covered": covered, "minimized": facts.minimized,
                            "staleRisk": staleRisk(covered: covered, appClass: bound.appClass, webArea: containsWebArea(bound.window))]
    return result
}
/**
 The observation of a bound run (design §2.3): the window's image alone with
 its geometry, the window's own tree as controls and text, and how covered it
 is. The frontmost surface plays no part; the target's own floors do. Two
 agreeing tree samples around the shot, as capture() waits for, and the window
 must not have moved under it.
 */
@available(macOS 14.0, *)
func captureTarget(token: String) async throws -> [String:Any] {
    try ensureRunning()
    let bound = try liveTarget(token)
    try guardTarget(bound, typing: false)
    if screenLocked() { throw ControlError("The screen is locked.", code: "SURFACE_BLOCKED") }
    let startedAt = ProcessInfo.processInfo.systemUptime
    var timings = [String:Int](), stageAt = startedAt
    func mark(_ stage: String) { let now = ProcessInfo.processInfo.systemUptime; timings[stage] = Int(((now - stageAt) * 1000).rounded()); stageAt = now }
    while true {
        if inputSettleRemaining() <= 0 { break }
        try await Task.sleep(nanoseconds: 20_000_000); try ensureRunning()
    }
    mark("settle")
    guard CGPreflightScreenCaptureAccess() else { throw ControlError("Grant Screen Recording permission and restart the app.") }
    let setup = try await targetCaptureSetup(bound)
    mark("content")
    let stableDeadline = ProcessInfo.processInfo.systemUptime + 1.5
    func settledSample() async throws -> WindowState {
        var sample = targetState(bound)
        while ProcessInfo.processInfo.systemUptime < stableDeadline {
            try await Task.sleep(nanoseconds: 100_000_000); try ensureRunning()
            let next = targetState(bound)
            if stableWindow(sample, next) { return next }
            sample = next
        }
        return sample
    }
    func attempt() async throws -> (WindowState, CGImage, CGRect)? {
        let oldWindow = try await settledSample()
        guard let frame = windowInfo(bound.windowID)?.bounds else { throw targetGone(bound) }
        let image = try await SCScreenshotManager.captureImage(contentFilter: setup.filter, configuration: setup.config)
        try ensureRunning()
        let afterWindow = targetState(bound)
        return stableWindow(oldWindow, afterWindow) && windowInfo(bound.windowID)?.bounds == frame ? (afterWindow, image, frame) : nil
    }
    var captured = try await attempt()
    for _ in 0..<2 where captured == nil { captured = try await attempt() }
    guard let (state, image, frame) = captured else { throw changedScreen("The active window changed during capture.") }
    mark("shot")
    let encoding = Task { await offThread { NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) } }
    let facts = targetFacts(bound), cover = targetCover(bound)
    withState { if targetBinding?.token == bound.token { targetUncovered = cover.uncovered } }
    var context = targetContext(bound, state: state, frame: frame, facts: facts, coverage: cover.coverage)
    try ensureRunning()
    mark("context")
    var reading: Task<String, Never>?
    if (context["visibleText"] as? String ?? "").count < 600 {
        reading = Task { await offThread { recognizeScreenText(image, window: nil, display: frame) } }
    }
    context["controls"] = targetControlEntries(bound, state: state, frame: frame).map { $0.item }
    mark("controls")
    if let reading { let text = await reading.value; if text.count > 40 { context["screenText"] = text } }
    mark("ocr")
    try ensureRunning()
    guard let png = await encoding.value else { throw ControlError("Screenshot encoding failed.") }
    mark("encode")
    timings["total"] = Int(((ProcessInfo.processInfo.systemUptime - startedAt) * 1000).rounded())
    var geometry = geometry(displayID, width: setup.config.width, height: setup.config.height)
    geometry["window"] = ["id": Int(bound.windowID), "x": Double(frame.minX), "y": Double(frame.minY), "width": Double(frame.width), "height": Double(frame.height)]
    geometry["scale_factor"] = Double(setup.config.width) / Double(frame.width)
    let observation: [String:Any] = ["id": UUID().uuidString.lowercased(), "sha256": SHA256.hash(data: png).map { String(format: "%02x", $0) }.joined(),
                                     "image": "data:image/png;base64," + png.base64EncodedString(), "geometry": geometry,
                                     "capturedAt": ProcessInfo.processInfo.systemUptime * 1000, "synthetic": false, "appId": bound.appId, "context": context, "timings": timings]
    guard let pixels = ScreenPixels(image) else { throw ControlError("Screenshot comparison failed.") }
    let stale = (context["background"] as? [String:Any])?["staleRisk"] as? Bool ?? false
    setCurrentFrame(["frame": observation, "pid": Int(bound.pid), "window": state, "pixels": pixels, "token": token, "windowFrame": frame, "facts": facts, "staleRisk": stale])
    return observation
}
/**
 The target's surface for policy (design §4): the bound application and
 window's own facts (the page, the focused field, the modal state, the named
 control, the menu item, the shortcut, the element under a point) and what the
 runner needs to plan the rungs. The user's frontmost application plays no part.
 */
func surfaceTarget(token: String, action requested: [String:Any]?) throws -> [String:Any] {
    let bound = try liveTarget(token)
    guard let frame = windowInfo(bound.windowID)?.bounds else { throw targetGone(bound) }
    let element = AXUIElementCreateApplication(bound.pid)
    let state = targetState(bound), facts = targetFacts(bound), cover = targetCover(bound)
    var action = requested
    var namedControl: (status: String, label: String?)? = nil
    var controlScrolled = false, hitAncestor: AXUIElement? = nil
    if requested?["type"] as? String == "click_control", let request = requested {
        let resolution = targetNamedControl(request, entries: targetControlEntries(bound, state: state, frame: frame))
        switch resolution.match {
        case .matched:
            if let control = resolution.control, let entry = resolution.entry {
                action?["x"] = control.x; action?["y"] = control.y
                // Brought into the clear of the bound window first (Reveal.swift),
                // so the hit test below reads the point the posted click lands on.
                // A point that falls through to the control's own ancestor
                // (hitCover) is the control's: the accessibility rung presses it.
                if control.enabled, frame.width > 0, frame.height > 0,
                   let reveal = try? revealControl(entry.element, window: bound.window, display: frame, application: element, routes: isStopped() ? nil : targetRevealRoutes(bound)),
                   let point = reveal.point {
                    let fraction = displayFraction(point, display: frame)
                    action?["x"] = fraction.x; action?["y"] = fraction.y
                    controlScrolled = reveal.scrolled
                    if !reveal.clear, hitCover(entry.element, at: point, application: element) == .hitAncestor { hitAncestor = entry.element }
                }
                namedControl = (control.enabled ? "resolved" : "disabled", control.label)
            }
        case .ambiguous: namedControl = ("ambiguous", nil)
        case .missing: namedControl = ("missing", nil)
        }
    }
    var secure = IsSecureEventInputEnabled(), focusedRole = ""
    var result: [String:Any] = ["appId": bound.appId, "pid": Int(bound.pid), "appName": bound.appName, "unknown": !AXIsProcessTrusted(), "addressBar": state.addressBar]
    if let focused = state.focused {
        focusedRole = attribute(focused, kAXRoleAttribute) as? String ?? ""
        let subrole = attribute(focused, kAXSubroleAttribute) as? String ?? ""
        let secureField = subrole == kAXSecureTextFieldSubrole
        secure = secure || secureField
        result["focusedRole"] = focusedRole
        if !subrole.isEmpty { result["focusedSubrole"] = subrole }
        // Describes the field (e.g. "Search"), never its contents.
        if !secureField { let label = fieldLabel(focused); if !label.isEmpty { result["focusedLabel"] = label } }
        if state.addressBar { result["focusedValue"] = String(state.focusedValue.prefix(2000)) }
        if terminalFocusEvidence(roleDescription: attribute(focused, kAXRoleDescriptionAttribute) as? String ?? "", label: fieldLabel(focused),
                                 domClasses: attribute(focused, "AXDOMClassList") as? [String] ?? [], ide: ideFamily(bound.appId) != nil) { result["terminalFocus"] = true }
    }
    result["secureInput"] = secure
    let page = pageIdentity(window: bound.window, focused: state.focused)
    if let domain = page.host { result["domain"] = domain }
    if pageHostUnknown(browser: browserAppIDs.contains(bound.appId), host: page.host, unreadableWebArea: page.unreadable) { result["hostUnknown"] = true }
    if modalContext(window: bound.window, element: state.focused) { result["modal"] = true }
    if let control = hitAncestor {
        for (key, value) in targetElementFacts(control, names: [elementText(control)] + targetNames(control)) { result[key] = value }
    } else if let a = action, let x = a["x"] as? Double, let y = a["y"] as? Double, let point = windowPoint(x: x, y: y, in: frame) {
        for (key, value) in hitTargetFacts(element, at: point) { result[key] = value }
    }
    for (key, value) in commandFacts(element, pid: bound.pid, action: action) { result[key] = value }
    if let status = namedControl {
        result["controlStatus"] = status.status
        if let label = status.label { result["controlLabel"] = utf16Prefix(label, 120) }
        if controlScrolled { result["controlScrolled"] = true }
        if hitAncestor != nil { result["hitAncestor"] = true }
    }
    if let level = accessibilityLevel(window: bound.window, focusedRole: focusedRole, hitTarget: result["targetRole"] != nil) { result["accessibility"] = level.rawValue }
    result["windowCount"] = min(onScreenWindowCount(bound.pid), 99)
    result["target"] = ["bound": true, "covered": windowCovered(cover.coverage), "minimized": facts.minimized, "focusedWindow": facts.focusedWindow, "siblingWindows": facts.siblingWindows]
    return result
}
/**
 Revalidation for a bound run (design §2.7): the binding is live, a fresh
 capture shows the same window (its bounds may change: the user may drag it
 aside, and every point maps through the frame as it is now), a pointer target
 hit-tests within the bound application to that window and to the control it
 was aimed at, and a keyboard target is the same focused field. A window fully
 covered whose picture may be stale refuses a pixel-aimed click: the listed
 controls are the truth there.
 */
@available(macOS 14.0, *)
func revalidateTarget(token: String, action: [String:Any]) async throws -> [String:Any] {
    try ensureRunning()
    let bound = try liveTarget(token)
    let type = action["type"] as? String ?? ""
    try guardTarget(bound, typing: ["type_text", "key", "hotkey"].contains(type))
    guard let saved = getCurrentFrame(), saved["token"] as? String == token, let previous = saved["frame"] as? [String:Any],
          action["frame_id"] as? String == previous["id"] as? String, let oldWindow = saved["window"] as? WindowState,
          let oldPixels = saved["pixels"] as? ScreenPixels, let oldFrame = saved["windowFrame"] as? CGRect else { throw changedScreen("The observation is no longer current.") }
    guard sameWindow(oldWindow, targetState(bound), ignoringBounds: true) else { throw changedScreen("The active window moved or changed.") }
    let menuRoute = type == "hotkey" ? (action["keys"] as? [String]).flatMap { hotkeyRoute(keys: $0, shortcuts: menuMap(AXUIElementCreateApplication(bound.pid), pid: bound.pid).shortcuts, approved: false, label: nil).menuPath } : nil
    let named = revalidatesByName(type: type, menuRoute: menuRoute, approved: action["approved"] as? Bool == true)
    if named, ProcessInfo.processInfo.systemUptime * 1000 - (previous["capturedAt"] as? Double ?? 0) < 20000 { return previous }
    let fresh = try await captureTarget(token: token)
    guard let current = getCurrentFrame(), let newWindow = current["window"] as? WindowState, let pixels = current["pixels"] as? ScreenPixels,
          let newFrame = current["windowFrame"] as? CGRect, let facts = current["facts"] as? TargetFacts, let stale = current["staleRisk"] as? Bool,
          sameWindow(oldWindow, newWindow, ignoringBounds: true) else { throw changedScreen("The display or window changed.") }
    if named || type == "scroll" || (type == "key" && action["key"] as? String == "ESC") { return fresh }
    let keyboard = ["type_text", "key", "hotkey"].contains(type)
    if keyboard {
        guard sameElement(oldWindow.focused, newWindow.focused), oldWindow.focusedValue == newWindow.focusedValue, oldWindow.focusedSignature == newWindow.focusedSignature else { throw changedScreen("The focused field changed.") }
        if let focused = newWindow.focused, elementRect(focused) != nil, ["AXTextField", "AXTextArea", "AXComboBox"].contains(attribute(focused, kAXRoleAttribute) as? String ?? ""), focusedEditingAction(action) { return fresh }
        if let command = withState({ searchCommand }), searchCommandCurrent(commandPid: command.pid, commandAt: command.at, pid: bound.pid, now: ProcessInfo.processInfo.systemUptime) { return fresh }
    }
    guard oldWindow.controls == newWindow.controls else { throw changedScreen("The window's controls changed.") }
    if keyboard, newWindow.focused != nil { return fresh }
    // Pointer targets: the point maps through the window's frame now; the
    // controls' geometry is compared relative to the frame, so a window the
    // user nudged still matches.
    guard let x = action["x"] as? Double, let y = action["y"] as? Double else { return fresh }
    guard let point = windowPoint(x: x, y: y, in: newFrame) else { throw ControlError("Invalid coordinates.") }
    if stale, facts.onScreen, !facts.minimized {
        throw ControlError("The window is fully covered, so its picture may be stale; use a listed control instead of a point.", code: TargetRefusal.coveredStale.rawValue)
    }
    let relative = { (rect: CGRect, frame: CGRect) in rect.offsetBy(dx: -frame.minX, dy: -frame.minY) }
    let stable = oldWindow.tracked.filter { old in
        newWindow.tracked.contains { CFEqual(old.element, $0.element) && relative(old.bounds, oldFrame) == relative($0.bounds, newFrame) && old.signature == $0.signature }
    }
    let masks = stable.map { imageRect($0.bounds.insetBy(dx: -6, dy: -6), window: oldFrame, imageWidth: oldPixels.width, imageHeight: oldPixels.height) }
    let imagePoint = CGPoint(x: x * Double(oldPixels.width), y: y * Double(oldPixels.height))
    if facts.onScreen, !facts.minimized {
        guard targetElement(at: point, offering: nil, bound: bound) != nil else { throw changedScreen("Another control covers the input target.") }
        if let control = stable.filter({ $0.bounds.contains(point) }).min(by: { $0.bounds.width * $0.bounds.height < $1.bounds.width * $1.bounds.height }) {
            guard hitMatches(control.element, at: point, application: AXUIElementCreateApplication(bound.pid)) else { throw changedScreen("Another control covers the input target.") }
            guard !targetPixelsChanged(oldPixels, pixels, points: [imagePoint], stableControls: masks) else { throw changedScreen("The input target changed.") }
            return fresh
        }
    }
    let whole = CGRect(x: 0, y: 0, width: oldPixels.width, height: oldPixels.height)
    guard !oldPixels.changed(comparedTo: pixels, in: whole, target: false, ignoring: masks) else { throw changedScreen("The window content changed.") }
    guard !framePixelsChanged(oldPixels, pixels, window: whole, points: [imagePoint], stableControls: masks) else { throw changedScreen("The input target changed.") }
    return fresh
}
/**
 One step in the bound window, down the ladder (design §2.5): accessibility
 first, then events posted to the process, each followed by the postcondition
 read of §2.7, whose verdict travels back so the runner decides the next rung.
 Nothing here activates, raises or moves the cursor; rung 3 is
 foregroundTarget, only ever after the runner has announced it. A rung with no
 route here (no pressable element under the point, a key no menu publishes)
 is passed over without a miss; one that read as no effect is a miss, and two
 skip it for the rest of the run.
 */
@available(macOS 14.0, *)
func executeTarget(token: String, action: [String:Any], rungs requested: [Rung]) async throws -> [String:Any] {
    try ensureRunning()
    let bound = try liveTarget(token)
    let type = action["type"] as? String ?? ""
    guard AXIsProcessTrusted() else { throw ControlError("Accessibility permission is required.") }
    try guardTarget(bound, typing: ["type_text", "key", "hotkey"].contains(type))
    guard let saved = getCurrentFrame(), saved["token"] as? String == token, let observation = saved["frame"] as? [String:Any],
          action["frame_id"] as? String == observation["id"] as? String, let savedWindow = saved["window"] as? WindowState else { throw changedScreen("Stale frame.") }
    guard ProcessInfo.processInfo.systemUptime * 1000 - (observation["capturedAt"] as? Double ?? 0) < 30000 else { throw changedScreen("Frame expired.") }
    guard sameWindow(savedWindow, targetState(bound), ignoringBounds: true) else { throw changedScreen("The active window changed before input.") }
    guard let frame = windowInfo(bound.windowID)?.bounds else { throw targetGone(bound) }
    if type == "type_text" { guard let text = action["text"] as? String, text.count <= 2000 else { throw ControlError("Invalid text.") } }
    let element = AXUIElementCreateApplication(bound.pid)
    // A hotkey's route is decided once, by the bound application's own menus.
    var menuRoute: [String]? = nil
    if type == "hotkey", let names = action["keys"] as? [String] {
        let route = hotkeyRoute(keys: names, shortcuts: menuMap(element, pid: bound.pid).shortcuts, approved: action["approved"] as? Bool == true, label: action["shortcutLabel"] as? String)
        if route == .refused { throw ControlError(menuRefusal, code: "TARGET_REFUSED") }
        if route == .changed { throw changedScreen("The shortcut's menu item changed.") }
        menuRoute = route.menuPath
    }
    let plan = backgroundRungs(action, requested: requested, facts: targetFacts(bound), menuShortcut: menuRoute != nil,
                               skipped: withState { targetMisses.skipped(appId: bound.appId, type: type) })
    guard !plan.rungs.isEmpty else { return targetResult(rung: nil, effect: nil, code: plan.code, read: nil) }
    let state = targetState(bound)
    let entries = targetControlEntries(bound, state: state, frame: frame)
    // What the step acts on: the control it named, the point it gave (the
    // window's centre for a scroll), the field it types into.
    var control: ControlEntry? = nil, point: CGPoint? = nil, revealed = false
    if type == "click_control" {
        let resolution = targetNamedControl(action, entries: entries)
        guard case .matched = resolution.match, let entry = resolution.entry, let named = resolution.control else {
            if case .ambiguous(let count) = resolution.match { throw ControlError("\(count) controls are named that. Name a different control, or add the x and y from the context list.", code: "TARGET_AMBIGUOUS") }
            throw ControlError("No control named that is on screen now. Choose one from the context list.", code: "TARGET_MISSING")
        }
        guard named.enabled else { throw ControlError("That control is disabled.", code: "TARGET_DISABLED") }
        control = entry; point = windowPoint(x: named.x, y: named.y, in: frame)
        // Brought into the clear of the bound window first (Reveal.swift), by
        // the window's own scroll bar; the posted click then lands on it.
        let reveal = try revealControl(entry.element, window: bound.window, display: frame, application: element, routes: targetRevealRoutes(bound))
        if let shown = reveal.point { point = shown }
        revealed = reveal.scrolled
    } else if type == "scroll" { point = CGPoint(x: frame.midX, y: frame.midY) }
    else if let x = action["x"] as? Double, let y = action["y"] as? Double {
        guard let mapped = windowPoint(x: x, y: y, in: frame) else { throw ControlError("Invalid coordinates.") }
        point = mapped
    }
    let field = ["type_text", "key"].contains(type) ? try typingField(bound, action: action, state: state, entries: entries) : control?.element
    let replacing = type == "type_text" && field.map(replacesField) == true
    // A click by name is read back against the control itself: its focus and
    // its own state beside the window (ClickEffect.swift); a field's click
    // counts as taken when the field holds focus.
    let clicked = type == "click_control" ? control?.element : nil
    let editable = clicked.map { focusRequested(role: attribute($0, kAXRoleAttribute) as? String ?? "", subrole: attribute($0, kAXSubroleAttribute) as? String ?? "") } ?? false
    let setup = try await targetCaptureSetup(bound)
    let rect = field.flatMap(elementRect) ?? point.map { CGRect(x: $0.x - 48, y: $0.y - 32, width: 96, height: 64) }
    let targetRect = rect.map { imageRect($0, window: frame, imageWidth: setup.config.width, imageHeight: setup.config.height) }
    // The search context follows the step as execute() keeps it: ENTER, TAB and
    // ESC end it, arrows move it, other keys edit it; a chord no menu publishes
    // replaces it with the search its item opens, or nothing.
    switch type {
    case "key": withState { searchCommand = nextSearchContext(searchCommand, .key(action["key"] as? String ?? "")) }
    case "hotkey" where menuRoute == nil:
        if let names = action["keys"] as? [String] { noteCommand(menuMap(element, pid: bound.pid).shortcuts[normalizeChord(names)]?.last, pid: bound.pid, appId: bound.appId) }
    case "type_text", "menu_item", "hotkey": break
    default: withState { searchCommand = nil }
    }
    let text = action["text"] as? String ?? ""
    let typedInto = type == "type_text" ? withState { () -> SearchContext? in
        let before = searchCommand; searchCommand = nextSearchContext(searchCommand, .interrupted(text, replaced: replacing)); return before
    } : nil
    var last: (rung: Rung, effect: RungEffect, read: PostconditionRead)? = nil
    for rung in plan.rungs {
        try ensureRunning()
        let before = await observeTarget(bound, field: field, control: clicked, setup: setup)
        let delivery: TargetDelivery
        switch rung {
        case .ax: delivery = try deliverByAccessibility(bound, action, control: control, point: point, field: field, replacing: replacing, menuRoute: menuRoute)
        case .post: delivery = try deliverByPosting(bound, action, point: point, field: field, replacing: replacing)
        case .foreground: continue
        }
        guard delivery != .none else { continue }
        let (read, after) = try await readPostcondition(bound, before: before, field: field, control: clicked, targetRect: targetRect, setup: setup)
        var effect = postconditionVerdict(read, editable: editable)
        if case .wrote(let expected) = delivery {
            effect = writeVerdict(readBack: after.fieldValue, expected: expected, echoRisk: bound.appClass.multiprocessWeb && field.map(insideWebArea) == true, fieldPixelsChanged: read.targetPixelsChanged)
        }
        if effect == .changed || effect == .focused {
            // Only the same context (not one a pause or another command replaced) learns the finished text.
            if let before = typedInto { withState { if searchCommand?.pid == before.pid, searchCommand?.at == before.at { searchCommand = nextSearchContext(before, .typed(text, replaced: replacing)) } } }
            return targetResult(rung: rung, effect: effect, code: nil, read: read, via: revealRoute(scrolled: revealed, route: clickRoute(type: type, rung: rung)))
        }
        withState { targetMisses.record(appId: bound.appId, type: type, rung: rung) }
        last = (rung, effect, read)
    }
    guard let last else { return targetResult(rung: nil, effect: nil, code: .unavailable, read: nil) }
    return targetResult(rung: last.rung, effect: last.effect, code: .noEffect, read: last.read, via: revealRoute(scrolled: revealed, route: clickRoute(type: type, rung: last.rung)))
}
/// A bound window's scrolls for a reveal: its own elements' actions
/// (assertTargetElement keeps them to the bound window) and its scroll bar's
/// page button under the clear rectangle's centre, one page in the control's
/// direction, as the accessibility scroll rung presses it; the control's own
/// action then corrects an overshoot (revealControl).
func targetRevealRoutes(_ bound: TargetBinding) -> RevealRoutes {
    RevealRoutes(perform: { element, action in try performTargetAction(element, action, bound: bound) },
                 scroll: { delta, clear in
                     guard let area = targetScrollArea(at: CGPoint(x: clear.midX, y: clear.midY), bound: bound),
                           let bar = attribute(area, kAXVerticalScrollBarAttribute), CFGetTypeID(bar) == AXUIElementGetTypeID() else { return }
                     let subrole = delta > 0 ? kAXIncrementPageSubrole : kAXDecrementPageSubrole
                     guard let button = (attribute(bar as! AXUIElement, kAXChildrenAttribute) as? [AXUIElement] ?? []).first(where: { attribute($0, kAXSubroleAttribute) as? String == subrole }) else { return }
                     try performTargetAction(button, kAXPressAction, bound: bound)
                 })
}
/**
 Rung 3 (design §2.8), only after the runner has announced it: the application
 in front is remembered for restoreRemembered, the target is unhidden and
 unminimized, activated and its window raised, and the helper waits up to
 700 ms for it to be frontmost. Activation is intent-driven on macOS 14, so it
 may not take; the result says. The handoff ends with restoreRemembered or
 restore, or on its own once the helper has sent no input for
 handoffIdleLimit seconds, giving the remembered application the front back.
 */
func foregroundTarget(token: String) async throws -> [String:Any] {
    try ensureRunning()
    let bound = try liveTarget(token)
    try guardTarget(bound, typing: false)
    guard let app = NSRunningApplication(processIdentifier: bound.pid) else { throw targetGone(bound) }
    if let front = NSWorkspace.shared.frontmostApplication, front.processIdentifier != bound.pid, !butlerOwn(front) {
        rememberedPID = front.processIdentifier
    }
    withState { targetHandoff = true; lastInputTime = ProcessInfo.processInfo.systemUptime }
    startHandoffWatch()
    if app.isHidden { app.unhide() }
    if attribute(bound.window, kAXMinimizedAttribute) as? Bool == true { try setTargetAttribute(bound.window, kAXMinimizedAttribute, kCFBooleanFalse, bound: bound) }
    app.activate(options: [])
    try performTargetAction(bound.window, kAXRaiseAction, bound: bound)
    let deadline = ProcessInfo.processInfo.systemUptime + 0.7
    while NSWorkspace.shared.frontmostApplication?.processIdentifier != bound.pid, ProcessInfo.processInfo.systemUptime < deadline {
        try await Task.sleep(nanoseconds: 50_000_000); try ensureRunning()
    }
    withState { lastInputTime = ProcessInfo.processInfo.systemUptime }
    return ["frontmost": NSWorkspace.shared.frontmostApplication?.processIdentifier == bound.pid]
}
// A handoff the runner never closed (it died mid-step, or its restore never
// arrived) would leave the target in front and the tap treating every input as
// a takeover of the screen. Once the helper's own input has been quiet for
// handoffIdleLimit the watch closes it and gives the remembered application the
// front back, exactly as restoreRemembered would. A step under way keeps
// posting, so a long typing step is never cut short.
func startHandoffWatch() {
    let watch = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
    watch.schedule(deadline: .now() + 1, repeating: 1, leeway: .milliseconds(200))
    watch.setEventHandler {
        let expired = withState { handoffExpired(handoff: targetHandoff, lastInputAt: lastInputTime, now: ProcessInfo.processInfo.systemUptime) }
        guard expired else { return }
        endTargetHandoff()
        if let app = rememberedApplication(), NSWorkspace.shared.frontmostApplication?.processIdentifier != app.processIdentifier { app.activate(options: []) }
    }
    let previous = withState { () -> DispatchSourceTimer? in let held = handoffWatch; handoffWatch = watch; return held }
    previous?.cancel()
    watch.resume()
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
// MARK: observe
/**
 Watching how the owner works (.data/design/observer.md §2; the rules in
 Observer.swift). One stream on this channel: observe_frame (what is in
 front, on a change and at most once per everyMs), observe_action (what the
 owner did, from the tap's unmarked events, content-free) and observe_dropped
 (frames the byte caps refused). `observe {on:false}` is answered on the
 reader thread like presence, ahead of anything queued behind a capture, and
 every write reads the flag under the output lock the answer takes, so
 nothing built earlier goes out after that answer; `on:true` runs on the command queue,
 where the tap is installed (without lifting the latch). Everything else runs
 on observerQueue, never on the tap's thread: the tap copies an event's facts
 (kind, point, key code, flags, click count, wheel delta, a chord's key name)
 and hands them over, so an accessibility read on a hung application can
 delay an action, never disable the tap. The observer sets nothing on any
 application (it never asks an Electron application to publish its tree, as
 a capture does), sends no input and activates nothing; while the lock
 screen, Butler's own run or idle lasts it reads nothing from the front.
 */
let observerLock = NSLock()
var observerOn = false
var observerGeneration = 0
var observerTier = ObserveTier.structure
let observerQueue = DispatchQueue(label: "ai.coarena.controller.observe", qos: .utility)
// The stream's state, touched on observerQueue only.
var observerTimer: DispatchSourceTimer?
var observerActivation: NSObjectProtocol?
var observerTracker = ObserveTracker(everyMs: observeEveryMsDefault)
var observerBudget = ObserveBudget()
var observerTyping = ObserveTypingAggregator()
var observerScroll = ObserveScrollAggregator()
var observerPresses = ObservePressCoalescer()
var observerSwitch = ObserveSwitchWitness()
var observerFront: ObserveFront? = nil
var observerBuilding = false

/// The facts of one unmarked event, copied on the tap's thread.
struct ObserveInput {
    let type: CGEventType
    let location: CGPoint
    let keyCode: Int64
    let flags: CGEventFlags
    let clickState: Int64
    let wheel: Double
    let layoutName: String?
    let at: TimeInterval
    let atMs: Int
}
/// The light reading the sampler takes of what is in front.
struct ObserveFront {
    let at: TimeInterval
    let pid: pid_t
    let appId: String
    let appName: String
    let window: AXUIElement?
    let bounds: CGRect?
    let title: String
    let browser: Bool
    let host: String?
    let protected: Bool
    let focused: AXUIElement?
    let focusedRole: String?
    let focusedLabel: String
    let focusedSecure: Bool
}
/// The moment's exclusion facts, read without touching any application.
struct ObserveMoment { let locked: Bool; let secure: Bool; let ownRun: Bool; let idleSeconds: Double }

func wallMs() -> Int { Int((Date().timeIntervalSince1970 * 1000).rounded()) }
func observerLive(_ generation: Int) -> Bool { observerLock.lock(); defer { observerLock.unlock() }; return observerOn && observerGeneration == generation }
/// `observe {on:false}`: the stream stops here and now (the flag), the machinery after.
func stopObserving() -> [String: Any] {
    observerLock.lock(); observerOn = false; observerGeneration += 1; observerLock.unlock()
    observerQueue.async { stopObserverMachinery() }
    return ["observing": false]
}
/// `observe {on:true, tier, everyMs}`: needs Accessibility (the reads) and
/// the tap (the owner's own input); the tap is installed without lifting
/// the latch, so nothing here enables input.
func startObserving(_ options: ObserveOptions) throws -> [String: Any] {
    guard AXIsProcessTrusted() else { throw ControlError("Accessibility permission is required.") }
    guard installTap() else { throw ControlError("The input tap could not be installed.") }
    observerLock.lock(); observerOn = true; observerGeneration += 1; observerTier = options.tier; let generation = observerGeneration; observerLock.unlock()
    observerQueue.async { startObserverMachinery(options, generation: generation) }
    return ["observing": true, "tier": options.tier.rawValue, "everyMs": options.everyMs]
}
func startObserverMachinery(_ options: ObserveOptions, generation: Int) {
    stopObserverMachinery()
    observerTracker = ObserveTracker(everyMs: options.everyMs)
    observerBudget = ObserveBudget()
    let timer = DispatchSource.makeTimerSource(queue: observerQueue)
    timer.schedule(deadline: .now() + .milliseconds(200), repeating: .seconds(1), leeway: .milliseconds(100))
    timer.setEventHandler { observerTick(generation: generation) }
    timer.resume()
    observerTimer = timer
    // Frames are event-driven: an activation is read at once rather than at the next second.
    observerActivation = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: nil) { note in
        let appId = (note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.bundleIdentifier ?? ""
        observerQueue.async { observerActivated(appId: appId, generation: generation) }
    }
}
func stopObserverMachinery() {
    observerTimer?.cancel(); observerTimer = nil
    if let activation = observerActivation { NSWorkspace.shared.notificationCenter.removeObserver(activation); observerActivation = nil }
    observerTyping = ObserveTypingAggregator(); observerScroll = ObserveScrollAggregator(); observerPresses = ObservePressCoalescer(); observerSwitch = ObserveSwitchWitness()
    observerFront = nil; observerBuilding = false
}
/// Writes one event of the stream while it is on for this generation. A
/// frame passes the byte caps first; a refused one becomes the notice when
/// one is due. The output lock is taken before the flag is read, and the
/// answer to `on:false` takes that same lock after the flag has flipped, so
/// the answer follows the last event out and never precedes one; the flag's
/// own lock is never held across a write, so the tap's snapshot of it never
/// waits on the pipe.
func observerWrite(_ object: [String: Any], frame: Bool, generation: Int) {
    guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
    if frame {
        switch observerBudget.admit(bytes: data.count, now: ProcessInfo.processInfo.systemUptime) {
        case .send: break
        case .drop(let reason, let notice):
            if let notice, let line = try? JSONSerialization.data(withJSONObject: ["event": "observe_dropped", "atMs": wallMs(), "reason": reason.rawValue, "dropped": notice]) {
                observerSend(line, generation: generation)
            }
            return
        }
    }
    observerSend(data, generation: generation)
}
func observerSend(_ data: Data, generation: Int) {
    outputLock.lock(); defer { outputLock.unlock() }
    observerLock.lock(); let live = observerOn && observerGeneration == generation; observerLock.unlock()
    guard live else { return }
    FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
}
/// The tap saw one of the owner's own events: copied as facts and handed to
/// the observer off the tap's thread. Only a chord's key is read from the
/// layout (a command modifier down); a character typed alone never is.
func observerSawInput(type: CGEventType, event: CGEvent) {
    observerLock.lock(); let on = observerOn, generation = observerGeneration; observerLock.unlock()
    guard on, [CGEventType.keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel].contains(type) else { return }
    let flags = event.flags
    var layoutName: String? = nil
    if type == .keyDown, !flags.intersection([.maskCommand, .maskControl, .maskAlternate]).isEmpty {
        var length = 0, units = [UniChar](repeating: 0, count: 4)
        event.keyboardGetUnicodeString(maxStringLength: 4, actualStringLength: &length, unicodeString: &units)
        if length > 0 { layoutName = String(utf16CodeUnits: units, count: length) }
    }
    let input = ObserveInput(type: type, location: event.location, keyCode: event.getIntegerValueField(.keyboardEventKeycode), flags: flags,
                             clickState: event.getIntegerValueField(.mouseEventClickState), wheel: event.getDoubleValueField(.scrollWheelEventFixedPtDeltaAxis1),
                             layoutName: layoutName, at: ProcessInfo.processInfo.systemUptime, atMs: wallMs())
    observerQueue.async { observerHandleInput(input, generation: generation) }
}
func observerMoment(now: TimeInterval) -> ObserveMoment {
    let hidIdle = CGEventType(rawValue: ~0).map { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) } ?? 0
    let idle = lastManualInput().map { now - $0 } ?? hidIdle
    // Butler acts: the latch is lifted, a window is bound for a background run, or a spoken scroll is under way.
    let ownRun = !isStopped() || withState { targetBinding != nil || scrollSession != nil }
    return ObserveMoment(locked: screenLocked(), secure: IsSecureEventInputEnabled(), ownRun: ownRun, idleSeconds: idle.isFinite ? max(0, idle) : 0)
}
/// What is in front, lightly: the application (inputApplication, so a
/// Spotlight panel reads as Spotlight, which a watch refuses), its focused
/// window's title and bounds, the page's host in a browser (pageIdentity),
/// the focused element's role and label (fieldLabel: never a value), and
/// whether a watch would refuse it: watchRefused for the application,
/// watchDomainRefused for a browser page, which refuses one whose host
/// cannot be read while any domain is protected.
func observerReadFront(now: TimeInterval) -> ObserveFront {
    let app = inputApplication()
    let pid = app?.processIdentifier ?? 0, appId = app?.bundleIdentifier ?? ""
    let element = AXUIElementCreateApplication(pid)
    let window = pid > 0 ? attribute(element, kAXFocusedWindowAttribute).map { $0 as! AXUIElement } : nil
    let focused = pid > 0 ? attribute(element, kAXFocusedUIElementAttribute).map { $0 as! AXUIElement } : nil
    let browser = browserAppIDs.contains(appId)
    let host = browser ? window.flatMap { pageIdentity(window: $0, focused: focused).host } : nil
    let protected = (app.map { butlerOwn($0) } ?? true) || watchRefused(appId) || (browser && watchDomainRefused(domain: host, browser: true, protectedDomains: protectedDomains))
    return ObserveFront(at: now, pid: pid, appId: appId, appName: app?.localizedName ?? "", window: window, bounds: window.flatMap(elementRect),
                        title: window.flatMap { attribute($0, kAXTitleAttribute) as? String } ?? "", browser: browser, host: host, protected: protected,
                        focused: focused, focusedRole: focused.flatMap { attribute($0, kAXRoleAttribute) as? String },
                        focusedLabel: focused.map(fieldLabel) ?? "",
                        focusedSecure: focused.map { attribute($0, kAXSubroleAttribute) as? String == kAXSecureTextFieldSubrole } ?? false)
}
/// The last light reading when it is under two seconds old, else a fresh one.
func observerFrontFacts(now: TimeInterval) -> ObserveFront {
    if let front = observerFront, now - front.at < 2 { return front }
    let front = observerReadFront(now: now)
    observerFront = front
    return front
}
/// The field with focus now: its label and whether it is secure.
func observerFocus(pid: pid_t) -> (label: String, secure: Bool) {
    guard pid > 0, let raw = attribute(AXUIElementCreateApplication(pid), kAXFocusedUIElementAttribute) else { return ("", false) }
    let focused = raw as! AXUIElement
    return (fieldLabel(focused), attribute(focused, kAXSubroleAttribute) as? String == kAXSecureTextFieldSubrole)
}
/// Bursts and held presses that are due go out.
func observerFlushActions(now: TimeInterval, generation: Int) {
    if let burst = observerTyping.flush(now: now) { observerWrite(burst.event, frame: false, generation: generation) }
    if let burst = observerScroll.flush(now: now) { observerWrite(burst.event, frame: false, generation: generation) }
    if let press = observerPresses.flush(now: now) { observerWrite(press.event, frame: false, generation: generation) }
}
/// One second: flush what is due, read the moment, and decide a frame. The
/// lock screen, Butler's own run and idle are said once and read nothing;
/// otherwise the front is read lightly and a frame is built (off this
/// queue) when the tracker says one is due.
func observerTick(generation: Int) {
    guard observerLive(generation) else { return }
    let now = ProcessInfo.processInfo.systemUptime, atMs = wallMs()
    observerFlushActions(now: now, generation: generation)
    observerLock.lock(); let tier = observerTier; observerLock.unlock()
    let moment = observerMoment(now: now)
    if let state = observeExclusion(secureInput: false, protected: false, locked: moment.locked, ownRun: moment.ownRun, idleSeconds: moment.idleSeconds) {
        observerFront = nil
        if case .transition(let code) = observerTracker.decide(signature: "", exclusion: state, now: now) {
            observerWrite(observeFrame(ObserveReadings(), tier: tier, exclusion: code, atMs: atMs), frame: true, generation: generation)
        }
        return
    }
    // A frame is being built: the change stays pending for the next second.
    guard !observerBuilding else { return }
    let front = observerReadFront(now: now)
    observerFront = front
    let exclusion = observeExclusion(secureInput: moment.secure || front.focusedSecure, protected: front.protected, locked: false, ownRun: false, idleSeconds: moment.idleSeconds)
    let signature = observeSignature(appId: front.appId, windowTitle: front.title, host: front.host, focusedRole: front.focusedRole)
    guard observerTracker.decide(signature: signature, exclusion: exclusion, now: now) == .frame else { return }
    if let exclusion {
        var readings = ObserveReadings()
        readings.appId = front.appId
        observerWrite(observeFrame(readings, tier: tier, exclusion: exclusion, atMs: atMs), frame: true, generation: generation)
        return
    }
    observerBuilding = true
    Task {
        let readings = await observerFullReadings(front, tier: tier)
        observerQueue.async {
            observerBuilding = false
            guard observerLive(generation) else { return }
            observerWrite(observeFrame(readings, tier: tier, exclusion: nil, atMs: atMs), frame: true, generation: generation)
        }
    }
}
/// The full reading behind one frame: the controls the capture would list
/// (the same walk, names only: modelControlName never returns a field's
/// contents), the window's text for tier text, and for text and pixels one
/// screenshot excluding protected applications as capture's does: OCR when
/// accessibility gave little text, the picture scaled to 512 px for pixels.
func observerFullReadings(_ front: ObserveFront, tier: ObserveTier) async -> ObserveReadings {
    var readings = ObserveReadings()
    readings.appId = front.appId; readings.appName = front.appName; readings.windowTitle = front.title
    readings.host = front.host; readings.browser = front.browser
    readings.focusedRole = front.focusedRole; readings.focusedLabel = front.focusedLabel; readings.focusedSecure = front.focusedSecure
    let display = CGDisplayBounds(displayID)
    let walked: (controls: [ObserveControl], text: String) = await offThread {
        guard let window = front.window else { return ([], "") }
        let state = windowState(pid: front.pid, appId: front.appId, window: window, focused: front.focused)
        var controls = groundedControls(state, display: display, limit: observeControlLimit)
        if front.browser { controls = mergeControls(controls, webControls(window, display: display), limit: observeControlLimit) { $0 } }
        let named = controls.map { ObserveControl(role: $0["role"] as? String ?? "", label: $0["label"] as? String ?? "") }
        var text = ""
        if tier >= .text {
            text = windowVisibleText(window)
            if front.browser { let page = webVisibleText(window, display: display).text; if page.count > text.count { text = page } }
        }
        return (named, text)
    }
    readings.controls = walked.controls
    readings.visibleText = walked.text
    guard tier >= .text, #available(macOS 14.0, *), CGPreflightScreenCaptureAccess(), tier == .pixels || walked.text.count < 600 else { return readings }
    guard let image = try? await observerScreenshot() else { return readings }
    if walked.text.count < 600 {
        let read = await offThread { recognizeScreenText(image, window: front.bounds, display: display, limit: observeTextLimit) }
        if read.count > walked.text.count { readings.visibleText = read }
    }
    if tier == .pixels { readings.images = await offThread { observeJpegRenditions(image) } }
    return readings
}
/// One screenshot of the display as capture takes it: protected applications,
/// terminals and Butler's own windows excluded, no cursor.
@available(macOS 14.0, *)
func observerScreenshot() async throws -> CGImage {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    guard let display = content.displays.first(where: { $0.displayID == displayID }) else { throw ControlError("Selected display is no longer connected.") }
    let excluded = content.applications.filter { app in
        protectedApps.contains(where: { app.bundleIdentifier.lowercased().contains($0.lowercased()) }) || terminalApp(app.bundleIdentifier)
            || app.processID == getppid() || app.bundleIdentifier == "ai.coarena.openassist"
    }
    let filter = SCContentFilter(display: display, excludingApplications: excluded, exceptingWindows: [])
    let bounds = CGDisplayBounds(displayID), ratio = min(1, 1440 / bounds.width)
    let config = SCStreamConfiguration()
    config.width = Int(bounds.width * ratio); config.height = Int(bounds.height * ratio); config.showsCursor = false
    return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
}
/// JPEG renditions at most 512 px wide, largest first, for observeImageFitting.
func observeJpegRenditions(_ image: CGImage) -> [Data] {
    var result = [Data]()
    for (width, quality) in [(observeImageMaxWidth, 0.5), (observeImageMaxWidth, 0.35), (384, 0.35), (256, 0.3)] {
        let scale = min(1, Double(width) / Double(image.width))
        let w = max(1, Int((Double(image.width) * scale).rounded())), h = max(1, Int((Double(image.height) * scale).rounded()))
        guard let context = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue) else { continue }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        guard let scaled = context.makeImage(), let jpeg = NSBitmapImageRep(cgImage: scaled).representation(using: .jpeg, properties: [.compressionFactor: quality]) else { continue }
        result.append(jpeg)
    }
    return result
}
/// The element under the owner's press and the control it belongs to, walked
/// as hitTargetFacts walks (the same roles stop the climb; a card's link or
/// button is preferred to its unlabelled group), named by its label alone:
/// an editable field by title, description or placeholder (elementText), a
/// secure field as "secure field". The menu path when the press was on a
/// menu item; whether it was on an application's Dock tile.
struct ObserveHit { let appId: String; let role: String; let label: String; let menu: [String]?; let dock: Bool }
func observerHitTarget(at point: CGPoint) -> ObserveHit? {
    var hit: AXUIElement?
    guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &hit) == .success, var target = hit else { return nil }
    var pid: pid_t = 0
    let appId = AXUIElementGetPid(target, &pid) == .success ? (NSRunningApplication(processIdentifier: pid)?.bundleIdentifier ?? "") : ""
    var ancestry = [ObserveAncestor](), node: AXUIElement? = target
    for _ in 0..<12 {
        guard let current = node else { break }
        ancestry.append(ObserveAncestor(role: attribute(current, kAXRoleAttribute) as? String ?? "", title: attribute(current, kAXTitleAttribute) as? String ?? ""))
        node = attribute(current, kAXParentAttribute).map { $0 as! AXUIElement }
    }
    let menu = observeMenuPath(ancestry)
    var role = attribute(target, kAXRoleAttribute) as? String ?? ""
    for _ in 0..<6 where !hitWalkControlRoles.contains(role) {
        guard hitWalkClimbRoles.contains(role), let parent = attribute(target, kAXParentAttribute), CFGetTypeID(parent) == AXUIElementGetTypeID() else { break }
        target = parent as! AXUIElement
        role = attribute(target, kAXRoleAttribute) as? String ?? ""
        if hitWalkStopsAt(role: role, description: attribute(target, kAXDescriptionAttribute) as? String ?? "", actions: actionNames(target)) { break }
    }
    if ["AXGroup", "AXImage", "AXStaticText"].contains(role) {
        var ancestor = attribute(target, kAXParentAttribute).map { $0 as! AXUIElement }
        for _ in 0..<8 {
            guard let current = ancestor else { break }
            let above = attribute(current, kAXRoleAttribute) as? String ?? ""
            if ["AXWebArea", "AXWindow", "AXApplication"].contains(above) { break }
            if ["AXLink", "AXButton"].contains(above) { target = current; role = above; break }
            ancestor = attribute(current, kAXParentAttribute).map { $0 as! AXUIElement }
        }
    }
    let subrole = attribute(target, kAXSubroleAttribute) as? String ?? ""
    let secure = subrole == kAXSecureTextFieldSubrole
    return ObserveHit(appId: appId, role: role, label: observeLabel(secure ? "" : elementText(target), secure: secure), menu: menu,
                      dock: appId == "com.apple.dock" && subrole == "AXApplicationDockItem")
}
/// One of the owner's own events, on observerQueue. Nothing of the owner's
/// is said from behind the lock screen, during Butler's own run, under
/// secure input, in a protected application or page, or in a secure field.
func observerHandleInput(_ input: ObserveInput, generation: Int) {
    guard observerLive(generation) else { return }
    let now = input.at
    observerFlushActions(now: now, generation: generation)
    let moment = observerMoment(now: now)
    guard !moment.locked, !moment.ownRun, !moment.secure else { return }
    let front = observerFrontFacts(now: now)
    guard !front.protected else { return }
    switch input.type {
    case .keyDown:
        let focus = observerFocus(pid: front.pid)
        guard !focus.secure else { return }
        switch observeKey(keyCode: input.keyCode, flags: input.flags, layoutName: input.layoutName) {
        case .ignored: return
        case .chord(let name):
            // CMD+TAB is the switch it causes, said as app_switch on the activation.
            if observerSwitch.saw(chord: name, at: now) { return }
            observerWrite(observeAction(kind: "key_chord", appId: front.appId, atMs: input.atMs, fields: ["chord": name]), frame: false, generation: generation)
        case .character:
            if let ended = observerTyping.key(appId: front.appId, field: observeLabel(focus.label, secure: false), at: now, atMs: input.atMs) {
                observerWrite(ended.event, frame: false, generation: generation)
            }
        }
    case .scrollWheel:
        if let ended = observerScroll.wheel(appId: front.appId, delta: input.wheel, at: now, atMs: input.atMs) {
            observerWrite(ended.event, frame: false, generation: generation)
        }
    case .leftMouseDown, .rightMouseDown, .otherMouseDown:
        guard let kind = observePointerKind(type: input.type, clickState: input.clickState) else { return }
        let hit = observerHitTarget(at: input.location)
        // A press in a protected application's own window (a palette over the front one) is not said either.
        if let hit, !hit.appId.isEmpty, hit.appId != front.appId, watchRefused(hit.appId) { return }
        let appId = hit.map { $0.appId.isEmpty ? front.appId : $0.appId } ?? front.appId
        if let hit, let menu = hit.menu {
            if let out = observerPresses.flush(now: now, force: true) { observerWrite(out.event, frame: false, generation: generation) }
            observerWrite(observeAction(kind: "menu_item", appId: appId, atMs: input.atMs, fields: ["menu": menu, "target": ["role": hit.role, "label": hit.label]]), frame: false, generation: generation)
            return
        }
        let press = ObservePress(kind: kind, appId: appId, target: hit.map { ObserveControl(role: $0.role, label: $0.label) }, dock: hit?.dock ?? false, at: now, atMs: input.atMs)
        if let out = observerPresses.press(press) { observerWrite(out.event, frame: false, generation: generation) }
        if let out = observerPresses.flush(now: now) { observerWrite(out.event, frame: false, generation: generation) }
    default: return
    }
}
/// An application came forward: the switch the owner caused by CMD+TAB or a
/// Dock press is said (never into a protected application), and the front
/// is read now rather than at the next second.
func observerActivated(appId: String, generation: Int) {
    guard observerLive(generation) else { return }
    let now = ProcessInfo.processInfo.systemUptime, atMs = wallMs()
    let moment = observerMoment(now: now)
    if !moment.locked, !moment.ownRun, !moment.secure, !watchRefused(appId) {
        if let dock = observerPresses.takeDockPress(now: now) {
            var fields = [String: Any]()
            if let target = dock.target { fields["target"] = ["role": target.role, "label": target.label] }
            observerWrite(observeAction(kind: "app_switch", appId: appId, atMs: atMs, fields: fields), frame: false, generation: generation)
        } else if let chord = observerSwitch.cause(now: now) {
            observerWrite(observeAction(kind: "app_switch", appId: appId, atMs: atMs, fields: ["chord": chord]), frame: false, generation: generation)
        }
    }
    observerSwitch.reset()
    observerTick(generation: generation)
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
        endTargetHandoff()
        if let pid=rememberedPID,NSWorkspace.shared.frontmostApplication?.processIdentifier != pid,let app=NSRunningApplication(processIdentifier:pid){app.activate(options:[]);try await Task.sleep(nanoseconds:300_000_000)};return ["restored":true]
    case "displays":var ids = [CGDirectDisplayID](repeating:0,count:16);var count:UInt32 = 0;CGGetActiveDisplayList(16,&ids,&count);return ["displays":ids.prefix(Int(count)).map{id in let b = CGDisplayBounds(id);return ["id":Int(id),"width":Int(b.width),"height":Int(b.height)]}]
    case "resume":guard AXIsProcessTrusted(),CGPreflightScreenCaptureAccess() else {throw ControlError("Grant Screen Recording and Accessibility permissions before starting.")};guard installTap() else {throw ControlError("Emergency stop could not be registered. Input remains disabled.")};latch(false);return ["resumed":true]
    case "stop":latch(true);return ["stopped":true]
    // A spoken "scroll down": gentle wheel movements until stopped (scrollStop is answered off the queue).
    case "scrollContinuous":return try startContinuousScroll(command)
    case "capture":if #available(macOS 14.0,*){return try await capture()}else{throw ControlError("macOS 14 or newer is required.")}
    case "execute":
        guard var action = command["action"] as? [String:Any] else {throw ControlError("Missing action.")}
        // Waiting and observing send no input and are not bound to a frame.
        if ["wait", "capture"].contains(action["type"] as? String ?? "") {_ = try execute(action);return ["executed":true]}
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
        for (key, value) in try execute(action, menuRoute: menuRoute) { result[key] = value }
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
    // Watching how the owner works (Observer.swift, MARK: observe): on installs
    // the tap without lifting the latch; off is also answered on the reader thread.
    case "observe":
        guard let options = ObserveOptions(command: command) else { throw ControlError("Invalid observe options.") }
        if options.on { return try startObserving(options) }
        return stopObserving()
    case "focusWatch":
        guard let token = command["token"] as? String else { throw ControlError("Missing token.") }
        return try await focusWatch(token: token)
    // A bound run (background actuation, design §6.1): one window, named by its
    // token alone. Nothing here takes the screen except foregroundTarget, which
    // the runner calls only after announcing it.
    case "bindTarget": return try bindTarget(command)
    case "captureTarget":
        guard let token = command["token"] as? String else { throw ControlError("Missing token.") }
        if #available(macOS 14.0, *) { return try await captureTarget(token: token) }
        throw ControlError("macOS 14 required.")
    case "surfaceTarget":
        guard let token = command["token"] as? String else { throw ControlError("Missing token.") }
        return try surfaceTarget(token: token, action: command["action"] as? [String:Any])
    case "revalidateTarget":
        guard let token = command["token"] as? String, let action = command["action"] as? [String:Any] else { throw ControlError("Missing token or action.") }
        if #available(macOS 14.0, *) { return try await revalidateTarget(token: token, action: action) }
        throw ControlError("macOS 14 required.")
    case "executeTarget":
        guard let token = command["token"] as? String, var action = command["action"] as? [String:Any] else { throw ControlError("Missing token or action.") }
        // Waiting and observing send no input and are not bound to a frame; the
        // frontmost surface plays no part in a bound run, so neither goes through execute.
        if action["type"] as? String == "wait" {
            guard let ms = action["milliseconds"] as? Int, ms >= 0, ms <= 5000 else { throw ControlError("Invalid wait.") }
            for _ in 0..<(ms/10) { try ensureRunning(); try await Task.sleep(nanoseconds: 10_000_000) }
            return ["executed": true]
        }
        if action["type"] as? String == "capture" { return ["executed": true] }
        try ensureRunning()
        let rungs = (command["rungs"] as? [String] ?? ["ax", "post"]).compactMap(Rung.init(rawValue:))
        if #available(macOS 14.0, *) {
            let fresh = try await revalidateTarget(token: token, action: action)
            action["frame_id"] = fresh["id"]
            return try await executeTarget(token: token, action: action, rungs: rungs)
        }
        throw ControlError("macOS 14 required.")
    case "foregroundTarget":
        guard let token = command["token"] as? String else { throw ControlError("Missing token.") }
        return try await foregroundTarget(token: token)
    case "unbindTarget":
        if let token = command["token"] as? String, withState({ targetBinding?.token == token }) { releaseTarget() }
        return ["unbound": true]
    case "restore":
        // A run bound to a background window never took the front, so a hold
        // in that window ends with nothing to give back: activating the
        // frame's application here would put the window the user just left
        // in front again (design §3). Its announced second in front is
        // closed and restored as every step's screen is.
        let background = withState { targetBinding != nil && !targetHandoff }
        endTargetHandoff()
        if background { return ["restored": true] }
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
        // Stopping the observer must not wait behind a capture: the flag flips
        // here, so nothing goes out after this answer (.data/design/observer.md §2).
        if command["method"] as? String == "observe", command["on"] as? Bool == false {emit(["id":command["id"] ?? "","result":stopObserving()]);continue}
        // A spoken stop must not wait behind a capture or paced typing: the
        // scroll ends here, off the queue, under its own locks.
        if command["method"] as? String == "scrollStop" {endContinuousScroll(.stop);emit(["id":command["id"] ?? "","result":["stopped":true]]);continue}
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
// Vision loads its text model on first use (about half a second on the first capture of a
// session, 2026-09-19 trial: ocr 558 ms cold, 136 ms warm). Warm it on a blank image now so
// the first frame pays only the recognition.
DispatchQueue.global(qos: .utility).async {
    if let context = CGContext(data: nil, width: 64, height: 64, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue), let image = context.makeImage() {
        _ = recognizeLines(image, region: nil, maxLines: 1)
    }
}
RunLoop.main.run()
}
}
