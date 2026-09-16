import Foundation
import AppKit
import ScreenCaptureKit
import Vision
import CryptoKit
import Carbon

let outputLock = NSLock()
let stateLock = NSLock()
var stopped = true
var lastPointerPosition: CGPoint?
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
func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
    outputLock.lock(); FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10])); outputLock.unlock()
}
func latch(_ value: Bool) { let point = value ? nil : CGEvent(source:nil)?.location; stateLock.lock(); stopped = value; if !value { lastPointerPosition = point }; stateLock.unlock() }
func setCurrentFrame(_ value: [String:Any]) { stateLock.lock(); currentFrame = value; stateLock.unlock() }
func getCurrentFrame() -> [String:Any]? { stateLock.lock(); defer {stateLock.unlock()}; return currentFrame }
func isStopped() -> Bool { stateLock.lock(); defer { stateLock.unlock() }; return stopped }
func inputSettleRemaining() -> TimeInterval { stateLock.lock(); defer {stateLock.unlock()}; return lastInputTime + 0.25 - ProcessInfo.processInfo.systemUptime }
struct ControlError: Error { let message: String; let code: String?; init(_ message: String, code: String? = nil) { self.message = message; self.code = code } }
func changedScreen(_ reason: String) -> ControlError { ControlError(reason, code: "STATE_CHANGED") }
func ensureRunning() throws { if isStopped() { throw ControlError("Native input stopped. Explicitly resume to continue.") } }
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
struct TrackedControl { let element: AXUIElement; let bounds: CGRect; let signature:String }
struct WindowState {
    let pid: pid_t
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
                tracked.append(TrackedControl(element: node, bounds: bounds,signature:controlSignature(node)))
            }
        }
        let children = (attribute(node, "AXVisibleChildren") ?? attribute(node, kAXChildrenAttribute)) as? [AXUIElement] ?? []
        for child in children.prefix(100) { visit(child, depth + 1) }
    }
    if let window = window { visit(window, 0) }
    if running?.bundleIdentifier == "com.apple.Spotlight" {controls.append("Spotlight selection:" + (spotlightState(app)["selectedResult"] ?? ""))}
    return WindowState(pid: pid, window: window, bounds: window.flatMap(elementRect),
        document: window.map { String(describing: attribute($0, "AXDocument") ?? attribute($0, "AXURL") ?? "" as CFString) } ?? "",
        focused: focused, focusedValue: focused.map { String(describing: attribute($0, kAXValueAttribute) ?? "" as CFString) } ?? "",
        focusedSignature:focused.map(focusSignature) ?? "",addressBar:focused.map{browserAddressField($0,appId:running?.bundleIdentifier ?? "")} ?? false,
        controls: SHA256.hash(data: Data(controls.joined(separator: "\u{1}").utf8)).map { String(format: "%02x", $0) }.joined(), tracked: tracked)
}
func sameElement(_ a: AXUIElement?, _ b: AXUIElement?) -> Bool {
    if let a = a, let b = b { return CFEqual(a, b) }; return a == nil && b == nil
}
func sameWindow(_ a: WindowState, _ b: WindowState) -> Bool {
    a.pid == b.pid && sameElement(a.window, b.window) && a.bounds == b.bounds && a.document == b.document
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
func surface(_ action: [String:Any]? = nil) -> [String: Any] {
    guard let app = inputApplication() else { return ["appId":"unknown", "pid":0, "secureInput":true, "unknown":true] }
    let element = AXUIElementCreateApplication(app.processIdentifier)
    var secure = IsSecureEventInputEnabled()
    var focusedRole: String? = nil
    var addressBar = false
    var focusedValue = ""
    if let focused = attribute(element, kAXFocusedUIElementAttribute) {
        let el = focused as! AXUIElement
        focusedRole = attribute(el, kAXRoleAttribute) as? String
        addressBar = browserAddressField(el,appId:app.bundleIdentifier ?? "")
        if addressBar {focusedValue=String((attribute(el,kAXValueAttribute) as? String ?? "").prefix(2000))}
        secure = secure || (attribute(el, kAXSubroleAttribute) as? String == kAXSecureTextFieldSubrole)
    }
    var domain: String? = nil
    if let window = attribute(element, kAXFocusedWindowAttribute) {
        if let url = attribute(window as! AXUIElement, "AXDocument") as? String { domain = URL(string:url)?.host?.lowercased() }
        if domain == nil, let url = attribute(window as! AXUIElement, "AXURL") as? URL { domain = url.host?.lowercased() }
    }
    var result: [String: Any] = ["appId":app.bundleIdentifier ?? "unknown", "pid":Int(app.processIdentifier), "secureInput":secure, "unknown":!AXIsProcessTrusted()]
    if let domain = domain { result["domain"] = domain }
    if let role = focusedRole {result["focusedRole"] = role}
    result["addressBar"] = addressBar
    if addressBar {result["focusedValue"] = focusedValue}
    if app.bundleIdentifier == "com.apple.Spotlight" {result["launcher"] = spotlightState(element)}
    if let a = action, let x = a["x"] as? Double,let y = a["y"] as? Double,x>=0,x<=1,y>=0,y<=1 {
        let b = CGDisplayBounds(displayID);var target:AXUIElement?
        if AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(),Float(b.minX+x*b.width),Float(b.minY+y*b.height),&target) == .success,var target = target {
            for _ in 0..<6 {
                let role=attribute(target,kAXRoleAttribute) as? String ?? ""
                if ["AXButton","AXLink","AXTextField","AXTextArea","AXComboBox","AXTab","AXMenuBarItem","AXDockItem"].contains(role) {break}
                guard ["AXStaticText","AXImage","AXGroup"].contains(role),let parent=attribute(target,kAXParentAttribute) else{break}
                target=parent as! AXUIElement
            }
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
        }
    }
    return result
}
func guardSurface() throws {
    let s = surface(), app = (s["appId"] as? String ?? "").lowercased()
    if app.contains("uninstall") {throw ControlError("An uninstaller opened. Input stopped; close it manually before continuing.")}
    if s["secureInput"] as? Bool == true { throw ControlError("Sensitive input is active; capture and input are blocked.") }
    if protectedApps.contains(where:{ app.contains($0.lowercased()) }) { throw ControlError("Protected application. Switch applications and resume.") }
    if let domain = s["domain"] as? String, protectedDomains.contains(where:{ domain == $0 || domain.hasSuffix("."+$0) }) { throw ControlError("Protected domain. Take over manually.") }
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
    if let raw=attribute(element,kAXFocusedUIElementAttribute) {
        let focused=raw as! AXUIElement
        if browserAddressField(focused,appId:app.bundleIdentifier ?? "") {result["browserAddress"] = String((attribute(focused,kAXValueAttribute) as? String ?? "").prefix(2000))}
        if attribute(focused,kAXSubroleAttribute) as? String != kAXSecureTextFieldSubrole,let selection=attribute(focused,kAXSelectedTextAttribute) as? String {result["selectedText"]=String(selection.prefix(2000))}
    }
    var windows=recentWindows
    if let list=CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]] {
        for window in list where windows.count<12 {
            guard let pid=window[kCGWindowOwnerPID as String] as? Int,pid != Int(getppid()),let other=NSRunningApplication(processIdentifier:pid_t(pid)),!protectedApps.contains(where:{(other.bundleIdentifier ?? "").lowercased().contains($0.lowercased())}),let title=window[kCGWindowName as String] as? String,!title.isEmpty else{continue}
            let entry=["appName":other.localizedName ?? "", "title":String(title.prefix(300))]
            if !windows.contains(entry){windows.append(entry)}
        }
    }
    result["recentWindows"]=windows;result["recentFiles"]=recentFiles
    return result
}
func postInput(_ event:CGEvent?) {
    guard let event = event else {return}
    stateLock.lock()
    lastInputTime = ProcessInfo.processInfo.systemUptime
    if event.type == .keyDown && event.getIntegerValueField(.keyboardEventKeycode) == 49 && event.flags.intersection([.maskCommand,.maskControl,.maskAlternate,.maskShift]) == .maskCommand {
        forwardedSpotlightDeadline = lastInputTime + 0.15
    }
    stateLock.unlock()
    event.setIntegerValueField(.eventSourceUserData,value:inputMarker);event.post(tap:.cghidEventTap)
}
func installTap() -> Bool {
    if tap != nil { return true }
    let types:[CGEventType] = [.keyDown,.leftMouseDown,.rightMouseDown,.otherMouseDown,.mouseMoved,.leftMouseDragged,.rightMouseDragged,.scrollWheel]
    let mask = types.reduce(CGEventMask(0)){$0 | (1 << $1.rawValue)}
    tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly, eventsOfInterest: mask, callback: { _, type, event, _ in
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            latch(true); emit(["event":"emergency_stop"])
            if let tap = tap { CGEvent.tapEnable(tap:tap, enable:true) }
        }
        var stationary = false
        var pointerDistance:Double = 0
        if [.mouseMoved,.leftMouseDragged,.rightMouseDragged,.leftMouseDown,.rightMouseDown,.otherMouseDown].contains(type) {
            stateLock.lock()
            if let previous = lastPointerPosition {pointerDistance = hypot(event.location.x-previous.x,event.location.y-previous.y)}
            stationary = type == .mouseMoved && stationaryPointerEvent(previous:lastPointerPosition,current:event.location,deltaX:event.getIntegerValueField(.mouseEventDeltaX),deltaY:event.getIntegerValueField(.mouseEventDeltaY))
            lastPointerPosition = event.location
            stateLock.unlock()
        }
        if event.getIntegerValueField(.eventSourceUserData) == inputMarker || stationary {return Unmanaged.passUnretained(event)}
        let source = NSRunningApplication(processIdentifier:pid_t(event.getIntegerValueField(.eventSourceUnixProcessID)))
        let systemSiri = source?.bundleIdentifier == "com.apple.Siri" && source?.executableURL?.path == "/System/Library/CoreServices/Siri.app/Contents/MacOS/Siri"
        stateLock.lock()
        let forwarded = forwardedSpotlightEvent(type:type,keyCode:event.getIntegerValueField(.keyboardEventKeycode),flags:event.flags,systemSiri:systemSiri,now:ProcessInfo.processInfo.systemUptime,deadline:forwardedSpotlightDeadline)
        if forwarded {forwardedSpotlightDeadline = 0}
        stateLock.unlock()
        if forwarded {emit(["event":"input_forwarded","source":"spotlight"]);return Unmanaged.passUnretained(event)}
        if type == .keyDown && event.getIntegerValueField(.keyboardEventKeycode) == 53 {latch(true);emit(["event":"emergency_stop"])}
        else if !isStopped() {latch(true);emit(["event":"user_takeover","source":type == .mouseMoved ? "mouse_move" : type == .keyDown ? "key" : type == .scrollWheel ? "scroll" : "mouse_button_or_drag","delta_x":event.getIntegerValueField(.mouseEventDeltaX),"delta_y":event.getIntegerValueField(.mouseEventDeltaY),"sourcePid":event.getIntegerValueField(.eventSourceUnixProcessID),"eventType":type.rawValue,"flags":event.flags.rawValue,"pointerDistance":pointerDistance])}
        return Unmanaged.passUnretained(event)
    }, userInfo:nil)
    guard let tap = tap else { return false }
    let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
    CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes); CGEvent.tapEnable(tap:tap, enable:true)
    return true
}
func geometry(_ display: SCDisplay, width: Int, height: Int) -> [String:Any] {
    let b = CGDisplayBounds(display.displayID)
    return ["display_id":Int(display.displayID),"x":Double(b.origin.x),"y":Double(b.origin.y),"width":Double(b.width),"height":Double(b.height),"native_width":CGDisplayPixelsWide(display.displayID),"native_height":CGDisplayPixelsHigh(display.displayID),"model_width":width,"model_height":height,"scale_factor":Double(CGDisplayPixelsWide(display.displayID))/Double(b.width)]
}
@available(macOS 14.0, *)
func capture() async throws -> [String:Any] {
    try ensureRunning(); try guardSurface()
    // Observe after our own input has reached the app and its short transition
    // has settled. The event tap and stop signal remain active during the wait.
    while true {
        if inputSettleRemaining() <= 0 {break}
        try await Task.sleep(nanoseconds:20_000_000);try ensureRunning()
    }
    guard CGPreflightScreenCaptureAccess() else { throw ControlError("Grant Screen Recording permission and restart the app.") }
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly:true)
    guard let display = content.displays.first(where:{$0.displayID == displayID}) else { throw ControlError("Selected display is no longer connected.") }
    let excluded = content.applications.filter { app in protectedApps.contains(where: { app.bundleIdentifier.lowercased().contains($0.lowercased()) }) || app.processID == getppid() || app.bundleIdentifier == "ai.coarena.openassist" }
    let filter = SCContentFilter(display:display, excludingApplications:excluded, exceptingWindows:[])
    let bounds = CGDisplayBounds(displayID), ratio = min(1, 1440 / bounds.width)
    let config = SCStreamConfiguration();config.width = Int(bounds.width*ratio);config.height = Int(bounds.height*ratio);config.showsCursor = false
    let before = surface(), oldWindow = windowState()
    let image = try await SCScreenshotManager.captureImage(contentFilter:filter, configuration:config)
    try ensureRunning(); try guardSurface()
    let afterWindow = windowState()
    guard sameWindow(oldWindow, afterWindow), oldWindow.controls == afterWindow.controls, sameElement(oldWindow.focused,afterWindow.focused), oldWindow.focusedSignature == afterWindow.focusedSignature else { throw changedScreen("The active window changed during capture.") }
    let bitmap = NSBitmapImageRep(cgImage:image)
    guard let png = bitmap.representation(using:.png, properties:[:]) else { throw ControlError("Screenshot encoding failed.") }
    let context=screenContext();try ensureRunning()
    let frame: [String:Any] = ["id":UUID().uuidString.lowercased(),"sha256":SHA256.hash(data:png).map{String(format:"%02x",$0)}.joined(),"image":"data:image/png;base64,"+png.base64EncodedString(),"geometry":geometry(display,width:config.width,height:config.height),"capturedAt":ProcessInfo.processInfo.systemUptime*1000,"synthetic":false,"appId":before["appId"] ?? "unknown","context":context]
    guard let pixels = ScreenPixels(image) else { throw ControlError("Screenshot comparison failed.") }
    setCurrentFrame(["frame":frame,"pid":before["pid"] ?? 0,"window":afterWindow,"pixels":pixels])
    return frame
}
@available(macOS 14.0, *)
func revalidate(_ action: [String:Any]) async throws -> [String:Any] {
    try ensureRunning(); try guardSurface()
    guard let saved = getCurrentFrame(), let previous = saved["frame"] as? [String:Any],
          action["frame_id"] as? String == previous["id"] as? String,
          let oldWindow = saved["window"] as? WindowState, let oldPixels = saved["pixels"] as? ScreenPixels,
          let oldGeometry = previous["geometry"] as? [String:Any] else { throw changedScreen("The observation is no longer current.") }
    guard ProcessInfo.processInfo.systemUptime*1000 - (previous["capturedAt"] as? Double ?? 0) < 30000 else { throw changedScreen("The observation expired.") }
    // Check the ORIGINAL window before capture replaces currentFrame.
    guard sameWindow(oldWindow, windowState()) else { throw changedScreen("The active window moved or changed.") }
    let fresh = try await capture()
    guard let current = getCurrentFrame(), let newWindow = current["window"] as? WindowState,
          let pixels = current["pixels"] as? ScreenPixels, let geometry = fresh["geometry"] as? [String:Any],
          NSDictionary(dictionary: oldGeometry).isEqual(to: geometry), sameWindow(oldWindow, newWindow) else { throw changedScreen("The display or window changed.") }
    let appId = fresh["appId"] as? String ?? ""
    if independentNavigationShortcut(action,appId:appId) {try ensureRunning();return fresh}
    if ["type_text", "key", "hotkey"].contains(action["type"] as? String ?? "") {
        guard sameElement(oldWindow.focused, newWindow.focused), oldWindow.focusedValue == newWindow.focusedValue, oldWindow.focusedSignature == newWindow.focusedSignature else { throw changedScreen("The focused field changed.") }
        if let focused=newWindow.focused,elementRect(focused) != nil,["AXTextField","AXTextArea","AXComboBox"].contains(attribute(focused,kAXRoleAttribute) as? String ?? ""),focusedEditingAction(action) {try ensureRunning();return fresh}
        if action["type"] as? String == "key",action["key"] as? String == "ENTER",oldWindow.addressBar,newWindow.addressBar {try ensureRunning();return fresh}
    }
    guard oldWindow.controls == newWindow.controls else { throw changedScreen("The window's controls changed.") }
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
    for (xKey,yKey) in [("x","y"),("start_x","start_y"),("end_x","end_y")] {
        if let x = action[xKey] as? Double, let y = action[yKey] as? Double {
            guard x.isFinite, y.isFinite, x>=0, x<=1, y>=0, y<=1 else { throw ControlError("Invalid coordinates.") }
            let actual = CGPoint(x:display.minX+x*display.width,y:display.minY+y*display.height)
            if let control = stable.filter({$0.bounds.contains(actual)}).min(by:{$0.bounds.width*$0.bounds.height < $1.bounds.width*$1.bounds.height}) {
                guard hitMatches(control.element, at:actual) else { throw changedScreen("Another control covers the input target.") }
            }
            points.append(CGPoint(x:x*Double(oldPixels.width),y:y*Double(oldPixels.height)))
        }
    }
    guard !oldPixels.changed(comparedTo: pixels, in: region, target: false, ignoring:masks) else { throw changedScreen("The window content changed.") }
    guard !framePixelsChanged(oldPixels, pixels, window: region, points: points, stableControls:masks) else { throw changedScreen("The input target changed.") }
    try ensureRunning(); return fresh
}
let keys: [String:CGKeyCode] = ["A":0,"S":1,"D":2,"F":3,"H":4,"G":5,"Z":6,"X":7,"C":8,"V":9,"B":11,"Q":12,"W":13,"E":14,"R":15,"Y":16,"T":17,"1":18,"2":19,"3":20,"4":21,"6":22,"5":23,"9":25,"7":26,"8":28,"0":29,"O":31,"U":32,"I":34,"P":35,"ENTER":36,"L":37,"J":38,"K":40,"N":45,"M":46,"TAB":48,"SPACE":49,"BACKSPACE":51,"ESC":53,"CMD":55,"SHIFT":56,"ALT":58,"CTRL":59,"HOME":115,"PAGEUP":116,"DELETE":117,"END":119,"PAGEDOWN":121,"LEFT":123,"RIGHT":124,"DOWN":125,"UP":126]
func execute(_ action:[String:Any]) throws {
    try ensureRunning(); try guardSurface()
    guard AXIsProcessTrusted() else { throw ControlError("Accessibility permission is required.") }
    stateLock.lock(); let saved = currentFrame; stateLock.unlock()
    guard let frame = saved?["frame"] as? [String:Any], let g = frame["geometry"] as? [String:Any], action["frame_id"] as? String == frame["id"] as? String else { throw changedScreen("Stale frame.") }
    guard ProcessInfo.processInfo.systemUptime*1000 - (frame["capturedAt"] as? Double ?? 0) < 30000 else { throw changedScreen("Frame expired.") }
    guard surface()["pid"] as? Int == saved?["pid"] as? Int else { throw changedScreen("Foreground application changed.") }
    guard let savedWindow = saved?["window"] as? WindowState, sameWindow(savedWindow, windowState()) else { throw changedScreen("The active window changed before input.") }
    let b = CGDisplayBounds(displayID)
    guard b.width == g["width"] as? Double, b.height == g["height"] as? Double, b.origin.x == g["x"] as? Double, b.origin.y == g["y"] as? Double else { throw changedScreen("Display geometry changed.") }
    func point(_ x:String,_ y:String) throws -> CGPoint { guard let nx = action[x] as? Double, let ny = action[y] as? Double, nx.isFinite,ny.isFinite,nx >= 0,nx <= 1,ny >= 0,ny <= 1 else { throw ControlError("Invalid coordinates.") };return CGPoint(x:b.minX+min(b.width-1,floor(nx*b.width)),y:b.minY+min(b.height-1,floor(ny*b.height))) }
    func mouse(_ type:CGEventType,_ p:CGPoint,_ button:CGMouseButton = .left,_ count:Int64 = 1) throws { try ensureRunning();guard let e = CGEvent(mouseEventSource:nil, mouseType:type, mouseCursorPosition:p, mouseButton:button) else { throw ControlError("Input event failed.") };e.setIntegerValueField(.mouseEventClickState,value:count);postInput(e) }
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
        for character in text {try ensureRunning();try guardSurface();let utf16 = Array(String(character).utf16);let e = CGEvent(keyboardEventSource:nil,virtualKey:0,keyDown:true);e?.keyboardSetUnicodeString(stringLength:utf16.count,unicodeString:utf16);postInput(e);let up = CGEvent(keyboardEventSource:nil,virtualKey:0,keyDown:false);postInput(up)}
    case "key", "hotkey":
        let names = action["keys"] as? [String] ?? [action["key"] as? String ?? ""]
        guard names.count<=4,names.allSatisfy({keys[$0] != nil}) else {throw ControlError("Unsupported key.")}
        if names.contains(where:{["CMD","CTRL","ALT"].contains($0)}) && names.contains(where:{["C","V","X"].contains($0)}) {throw ControlError("Clipboard disabled.")}
        var flags:CGEventFlags = [];for name in names {if name == "CMD"{flags.insert(.maskCommand)};if name == "CTRL"{flags.insert(.maskControl)};if name == "ALT"{flags.insert(.maskAlternate)};if name == "SHIFT"{flags.insert(.maskShift)}}
        var pressed:[CGKeyCode] = [];defer {for code in pressed.reversed(){postInput(CGEvent(keyboardEventSource:nil,virtualKey:code,keyDown:false))}}
        for name in names {try ensureRunning();let code = keys[name]!;let e = CGEvent(keyboardEventSource:nil,virtualKey:code,keyDown:true);e?.flags = flags;postInput(e);pressed.append(code)}
    case "wait": guard let ms = action["milliseconds"] as? Int, ms>=0,ms<=5000 else {throw ControlError("Invalid wait.")};for _ in 0..<(ms/10){try ensureRunning();Thread.sleep(forTimeInterval:0.01)}
    case "capture": break
    default: throw ControlError("Unknown native action.")
    }
}
func handle(_ command:[String:Any]) async throws -> [String:Any] {
    switch command["method"] as? String {
    case "permissions":return ["screen":CGPreflightScreenCaptureAccess(),"accessibility":AXIsProcessTrusted(),"emergencyStop":tap != nil,"supported":ProcessInfo.processInfo.operatingSystemVersion.majorVersion>=14]
    case "requestPermissions":
        _ = CGRequestScreenCaptureAccess();_ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String:true] as CFDictionary);return ["requested":true]
    case "configure":
        if let apps = command["protectedApps"] as? [String]{protectedApps = apps};if let domains = command["protectedDomains"] as? [String]{protectedDomains = domains};if let id = command["displayId"] as? UInt32{displayID = id};return ["configured":true]
    case "surface":return surface(command["action"] as? [String:Any])
    case "rememberForeground":
        if let app=NSWorkspace.shared.frontmostApplication,app.processIdentifier != getppid(),app.bundleIdentifier != "ai.coarena.openassist" {rememberedPID=app.processIdentifier};return ["remembered":true]
    case "restoreRemembered":
        if let pid=rememberedPID,NSWorkspace.shared.frontmostApplication?.processIdentifier != pid,let app=NSRunningApplication(processIdentifier:pid){app.activate(options:[]);try await Task.sleep(nanoseconds:300_000_000)};return ["restored":true]
    case "displays":var ids = [CGDirectDisplayID](repeating:0,count:16);var count:UInt32 = 0;CGGetActiveDisplayList(16,&ids,&count);return ["displays":ids.prefix(Int(count)).map{id in let b = CGDisplayBounds(id);return ["id":Int(id),"width":Int(b.width),"height":Int(b.height)]}]
    case "resume":guard AXIsProcessTrusted(),CGPreflightScreenCaptureAccess() else {throw ControlError("Grant Screen Recording and Accessibility permissions before starting.")};guard installTap() else {throw ControlError("Emergency stop could not be registered. Input remains disabled.")};latch(false);return ["resumed":true]
    case "stop":latch(true);return ["stopped":true]
    case "capture":if #available(macOS 14.0,*){return try await capture()}else{throw ControlError("macOS 14 or newer is required.")}
    case "execute":
        guard var action = command["action"] as? [String:Any], let previous = getCurrentFrame()?["frame"] as? [String:Any], action["frame_id"] as? String == previous["id"] as? String else {throw ControlError("Missing action or stale frame.")}
        if #available(macOS 14.0,*) {
            if !["wait", "capture"].contains(action["type"] as? String ?? "") {
                let fresh = try await revalidate(action)
                action["frame_id"] = fresh["id"]
            }
        } else {throw ControlError("macOS 14 required.")}
        try execute(action);return ["executed":true]
    case "revalidate":
        guard let action = command["action"] as? [String:Any] else { throw ControlError("Missing action.") }
        if #available(macOS 14.0,*) { return try await revalidate(action) }
        throw ControlError("macOS 14 required.")
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
@main struct ControllerMain {
static func main() {
signal(SIGUSR1,SIG_IGN)
let stopSignal = DispatchSource.makeSignalSource(signal:SIGUSR1,queue:.global(qos:.userInteractive));stopSignal.setEventHandler{latch(true)};stopSignal.resume()
DispatchQueue.global().async {
    while let line = readLine() {
        guard let data = line.data(using:.utf8), let command = try? JSONSerialization.jsonObject(with:data) as? [String:Any] else {continue}
        let semaphore = DispatchSemaphore(value:0)
        Task { do {let result = try await handle(command);emit(["id":command["id"] ?? "","result":result])}catch {var result:[String:Any] = ["id":command["id"] ?? "","error":(error as? ControlError)?.message ?? "Native controller failed."];if let code = (error as? ControlError)?.code {result["code"] = code};emit(result)};semaphore.signal() };semaphore.wait()
    }
    latch(true);exit(0)
}
RunLoop.main.run()
}
}
