import Foundation
import AppKit

func output(_ value: [String:Any]) {
    if let data = try? JSONSerialization.data(withJSONObject:value) { FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10])) }
}
class FixtureWindow: NSWindow { override var canBecomeKey: Bool { true }; override var canBecomeMain: Bool { true } }
// A clickable web-style container (<div aria-label="Delete">) around an
// unlabelled icon: the hit test lands on the icon, the name is on the group.
class LabelledGroup: NSView {
    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { .group }
    override func accessibilityLabel() -> String? { "Delete" }
}
class Fixture: NSObject, NSApplicationDelegate {
    var window: FixtureWindow!
    var second: NSWindow?
    let field = NSTextField(string:"Original")
    let other = NSTextField(string:"Other")
    let button = NSButton(title:"Continue",target:nil,action:nil)
    let clock = NSTextField(labelWithString:"Tick 0")
    // Calculator-style keypad key: a symbol title with a spoken description.
    let keypad = NSButton(title:"×",target:nil,action:nil)
    let trash = LabelledGroup()
    let trashIcon = NSImageView()
    var clicks = 0, tick = 0
    var shortcuts = 0
    var keyEvents = [[String: Any]]()
    var keyMonitor: Any?
    var timer: Timer?
    var animateVideo = false
    let video = NSView()
    let previous = NSWorkspace.shared.frontmostApplication
    func applicationDidFinishLaunching(_ notification: Notification) {
        let bounds = NSScreen.screens[0].frame
        window = FixtureWindow(contentRect:bounds,styleMask:[.borderless],backing:.buffered,defer:false)
        window.title = "Butler regression check"
        window.backgroundColor = NSColor(calibratedWhite:0.1,alpha:1)
        let title = NSTextField(labelWithString:"Butler · local input regression test")
        title.font = .systemFont(ofSize:28);title.textColor = .white;title.frame = NSRect(x:100,y:bounds.height-130,width:900,height:50)
        let subtitle = NSTextField(labelWithString:"Temporary test window. No model calls or personal screen uploads.")
        subtitle.textColor = .lightGray;subtitle.frame = NSRect(x:100,y:bounds.height-180,width:1000,height:40)
        field.frame = NSRect(x:100,y:bounds.height-300,width:500,height:45);field.font = .systemFont(ofSize:24)
        other.frame = NSRect(x:650,y:bounds.height-300,width:350,height:45);other.font = .systemFont(ofSize:24)
        button.frame = NSRect(x:100,y:bounds.height-410,width:180,height:60);button.bezelStyle = .rounded;button.target = self;button.action = #selector(clicked)
        clock.frame = NSRect(x:100,y:100,width:300,height:30);clock.textColor = .white
        keypad.frame = NSRect(x:700,y:bounds.height-410,width:60,height:60);keypad.bezelStyle = .rounded;keypad.setAccessibilityLabel("multiply")
        trash.frame = NSRect(x:820,y:bounds.height-410,width:60,height:60)
        trashIcon.frame = NSRect(x:6,y:6,width:48,height:48);trashIcon.image = NSImage(size:NSSize(width:48,height:48), flipped:false) { rect in NSColor.systemRed.setFill();rect.insetBy(dx:8,dy:8).fill();return true }
        trashIcon.setAccessibilityLabel("");trash.addSubview(trashIcon)
        video.frame=NSRect(x:430,y:80,width:700,height:300);video.wantsLayer=true;window.contentView!.addSubview(video)
        for view in [title,subtitle,field,other,button,clock,keypad,trash] { window.contentView!.addSubview(view) }
        let menu = NSMenu(), root = NSMenuItem(), submenu = NSMenu(title:"Fixture")
        let shortcut = NSMenuItem(title:"Fixture shortcut",action:#selector(shortcutInvoked),keyEquivalent:"k")
        shortcut.keyEquivalentModifierMask = [.command,.shift];shortcut.target = self
        submenu.addItem(shortcut)
        let selectAll = NSMenuItem(title:"Select All",action:#selector(NSText.selectAll(_:)),keyEquivalent:"a")
        selectAll.keyEquivalentModifierMask = [.command];submenu.addItem(selectAll)
        root.submenu = submenu;menu.addItem(root);NSApp.mainMenu = menu
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching:[.keyDown,.keyUp]) { [weak self] event in
            if let self = self, event.window == self.window {
                self.keyEvents.append(["code":Int(event.keyCode),"down":event.type == .keyDown,"flags":event.modifierFlags.intersection(.deviceIndependentFlagsMask).rawValue,"characters":event.characters ?? "","ignoringFlags":event.charactersIgnoringModifiers ?? ""])
                self.keyEvents = Array(self.keyEvents.suffix(20))
            }
            return event
        }
        window.makeKeyAndOrderFront(nil);NSApp.activate(ignoringOtherApps:true)
        focus(field)
        timer = Timer.scheduledTimer(withTimeInterval:0.1,repeats:true) { [weak self] _ in guard let self = self else{return};self.tick += 1;self.clock.stringValue = "Tick \(self.tick)";if self.animateVideo {self.video.layer?.backgroundColor=(self.tick % 2 == 0 ? NSColor.blue : NSColor.red).cgColor} }
        output(["event":"ready","pid":ProcessInfo.processInfo.processIdentifier])
        DispatchQueue.global().async { [weak self] in
            while let line = readLine() {
                guard let data = line.data(using:.utf8),let request = try? JSONSerialization.jsonObject(with:data) as? [String:Any] else {continue}
                DispatchQueue.main.async { self?.handle(request) }
            }
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }
    @objc func clicked() { clicks += 1 }
    @objc func shortcutInvoked() { shortcuts += 1 }
    func focus(_ target: NSTextField) {
        window.makeKeyAndOrderFront(nil);window.makeFirstResponder(target)
        (target.currentEditor() as? NSTextView)?.setSelectedRange(NSRange(location:target.stringValue.utf16.count,length:0))
    }
    func handle(_ request: [String:Any]) {
        switch request["method"] as? String {
        case "focus":focus(field)
        case "focusOther":focus(other)
        case "selectAll":(field.currentEditor() as? NSTextView)?.selectAll(nil)
        case "videoOn":animateVideo=true
        case "videoOff":animateVideo=false;video.layer?.backgroundColor=NSColor.clear.cgColor
        case "move":button.setFrameOrigin(NSPoint(x:button.frame.minX+180,y:button.frame.minY))
        case "relabel":button.title = "Delete"
        case "stationaryPointer", "echoPointer", "movePointer":
            // echoPointer imitates WindowServer re-emitting the pointer at a
            // slightly different fixed-point location with no hardware delta.
            let original = CGEvent(source:nil)?.location ?? CGPoint(x:400,y:400)
            let method = request["method"] as? String
            let offset: CGFloat = method == "movePointer" ? 8 : method == "echoPointer" ? 1 : 0
            let position = CGPoint(x:original.x+offset,y:original.y)
            let event = CGEvent(mouseEventSource:nil,mouseType:.mouseMoved,mouseCursorPosition:position,mouseButton:.left)
            event?.setIntegerValueField(.mouseEventDeltaX,value:method == "movePointer" ? 8 : 0)
            event?.setIntegerValueField(.mouseEventDeltaY,value:0)
            event?.post(tap:.cghidEventTap)
        case "longValue":field.stringValue = String(repeating:"x",count:5000) + "old"
        case "changeTail":field.stringValue = String(repeating:"x",count:5000) + "new"
        case "secondWindow":
            second = NSWindow(contentRect:NSRect(x:300,y:300,width:400,height:200),styleMask:[.titled],backing:.buffered,defer:false);second?.title = "Different window";second?.makeKeyAndOrderFront(nil)
        case "close":output(["id":request["id"] ?? "","result":[:]]);previous?.activate(options:[]);NSApp.terminate(nil);return
        default:break
        }
        let bounds = NSScreen.screens[0].frame
        let center = window.convertPoint(toScreen:NSPoint(x:button.frame.midX,y:button.frame.midY))
        let keypadCenter = window.convertPoint(toScreen:NSPoint(x:keypad.frame.midX,y:keypad.frame.midY))
        let trashCenter = window.convertPoint(toScreen:NSPoint(x:trash.frame.midX,y:trash.frame.midY))
        output(["id":request["id"] ?? "","result":["clicks":clicks,"shortcuts":shortcuts,"keyEvents":keyEvents,"selectionLength":(field.currentEditor() as? NSTextView)?.selectedRange().length ?? 0,"text":field.stringValue,"x":(center.x-bounds.minX)/bounds.width,"y":(bounds.maxY-center.y)/bounds.height,"keypadX":(keypadCenter.x-bounds.minX)/bounds.width,"keypadY":(bounds.maxY-keypadCenter.y)/bounds.height,"trashX":(trashCenter.x-bounds.minX)/bounds.width,"trashY":(bounds.maxY-trashCenter.y)/bounds.height]])
    }
}
let application = NSApplication.shared
let fixture = Fixture()
application.setActivationPolicy(.regular);application.delegate = fixture;application.run()
