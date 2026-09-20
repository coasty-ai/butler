import Foundation
import CoreGraphics

// Pure checks for a bound run (BackgroundInput.swift): the ladder's decision,
// the misses that prune it, the postcondition and write verdicts, the
// coordinate maths, the cover of a window and the user's hit test against it,
// the target's activations, and the binding's validity.
func backgroundInputChecks(_ check: (Bool, String) -> Void) {
    check(Set(TargetRefusal.allCases.map { $0.rawValue }) == ["TARGET_GONE", "TARGET_PROTECTED", "TARGET_MINIMIZED", "TARGET_OFF_SPACE", "TARGET_COVERED_STALE", "RUNG_NO_EFFECT", "RUNG_UNAVAILABLE", "KEYBOARD_AMBIGUOUS"], "the refusal codes are exactly the design's eight")
    check(Rung.allCases.map { $0.rawValue } == ["ax", "post", "foreground"], "the rungs are ax, post and foreground in ladder order")

    // Application classes decide which posted events are refused and which read-backs are trusted.
    check(targetAppClass(bundleId: "com.apple.Notes", electronFramework: false) == .appKit, "a native application is AppKit")
    check(targetAppClass(bundleId: "com.apple.Safari", electronFramework: false) == .webKit, "Safari is WebKit")
    check(targetAppClass(bundleId: "com.google.Chrome", electronFramework: false) == .chromium && targetAppClass(bundleId: "org.mozilla.firefox", electronFramework: false) == .chromium, "Chrome and Firefox take the multi-process browser rules")
    check(targetAppClass(bundleId: "com.tinyspeck.slackmacgap", electronFramework: true) == .electron, "an application shipping the Electron framework is Electron")
    check(TargetAppClass.chromium.multiprocessWeb && TargetAppClass.electron.multiprocessWeb && !TargetAppClass.webKit.multiprocessWeb && !TargetAppClass.appKit.multiprocessWeb, "only Chromium and Electron render out of process")
    check(TargetAppClass.webKit.web && TargetAppClass.electron.web && !TargetAppClass.appKit.web, "everything but AppKit is web content")

    // The ladder's decision function.
    let both: [Rung] = [.ax, .post]
    func plan(_ action: [String: Any], requested: [Rung] = both, facts: TargetFacts = TargetFacts(), menuShortcut: Bool = false, skipped: Set<Rung> = []) -> (rungs: [Rung], code: TargetRefusal?) {
        backgroundRungs(action, requested: requested, facts: facts, menuShortcut: menuShortcut, skipped: skipped)
    }
    check(plan(["type": "click_control", "label": "Send"]).rungs == [.ax, .post] && plan(["type": "click", "x": 0.5, "y": 0.5]).rungs == [.ax, .post], "a named control and a point try accessibility, then a posted click")
    check(plan(["type": "right_click", "x": 0.5, "y": 0.5]).rungs == [.ax, .post], "a right click tries the element's menu action, then a posted right pair")
    check(plan(["type": "double_click", "x": 0.5, "y": 0.5]).rungs == [.post], "a double click has no accessibility route")
    check(plan(["type": "menu_item", "path": ["File", "New"]]).rungs == [.ax] && plan(["type": "menu_item", "path": ["File", "New"]]).code == nil, "a menu item is an accessibility press only")
    check(plan(["type": "type_text", "text": "hi"]).rungs == [.ax, .post], "text is written first, then posted as keys")
    check(plan(["type": "key", "key": "ENTER"]).rungs == [.ax, .post], "ENTER tries the default button or confirm, then a posted key")
    check(plan(["type": "key", "key": "TAB"]).rungs == [.post] && plan(["type": "key", "key": "DOWN"]).rungs == [.post], "other keys can only be posted")
    check(plan(["type": "hotkey", "keys": ["CMD", "N"]], menuShortcut: true).rungs == [.ax, .post], "a published shortcut is pressed as its menu item first")
    check(plan(["type": "hotkey", "keys": ["CMD", "A"]]).rungs == [.post], "a chord no menu publishes can only be posted")
    check(plan(["type": "scroll", "delta_x": 0, "delta_y": 300]).rungs == [.ax, .post], "a scroll tries the scroll bar, then a posted wheel")
    for type in ["drag", "move", "open_app", "open_file", "monitor", "wait", "capture", "done"] {
        let result = plan(["type": type])
        check(result.rungs.isEmpty && result.code == .unavailable, "\(type) has no background route")
    }
    check(plan(["type": "nonsense"]).code == .unavailable, "an unknown action has no background route")
    var electron = TargetFacts(); electron.appClass = .electron
    check(plan(["type": "scroll", "delta_x": 0, "delta_y": 300], facts: electron).rungs == [.ax], "a posted wheel is refused for Electron")
    var chromium = TargetFacts(); chromium.appClass = .chromium
    check(plan(["type": "scroll", "delta_x": 0, "delta_y": 300], facts: chromium).rungs == [.ax], "a posted wheel is refused for Chromium")
    var safari = TargetFacts(); safari.appClass = .webKit
    check(plan(["type": "scroll", "delta_x": 0, "delta_y": 300], facts: safari).rungs == [.ax, .post], "a posted wheel reaches WebKit")
    check(plan(["type": "click", "x": 0.5, "y": 0.5], facts: electron).rungs == [.ax, .post], "posted clicks are still tried for Electron; the postcondition decides")
    var minimized = TargetFacts(); minimized.minimized = true; minimized.onScreen = false
    check(plan(["type": "click", "x": 0.5, "y": 0.5], facts: minimized).rungs == [.ax], "a minimized window takes accessibility actions but no pointer events")
    let minimizedDouble = plan(["type": "double_click", "x": 0.5, "y": 0.5], facts: minimized)
    check(minimizedDouble.rungs.isEmpty && minimizedDouble.code == .minimized, "a pointer-only action on a minimized window says so")
    var offSpace = TargetFacts(); offSpace.onScreen = false
    let offSpaceDouble = plan(["type": "double_click", "x": 0.5, "y": 0.5], facts: offSpace)
    check(offSpaceDouble.rungs.isEmpty && offSpaceDouble.code == .offSpace, "a window on another Space has no on-screen bounds for pointer events")
    check(plan(["type": "type_text", "text": "hi"], facts: minimized).rungs == [.ax, .post], "a minimized window still takes writes and keys posted to the process")
    var siblings = TargetFacts(); siblings.siblingWindows = 1
    check(plan(["type": "type_text", "text": "hi"], facts: siblings).rungs == [.ax], "keys are never posted to an application with another window open")
    let ambiguous = plan(["type": "key", "key": "TAB"], facts: siblings)
    check(ambiguous.rungs.isEmpty && ambiguous.code == .keyboardAmbiguous, "a key that can only be posted is refused as ambiguous with a sibling window")
    var unfocused = TargetFacts(); unfocused.focusedWindow = false
    check(plan(["type": "key", "key": "TAB"], facts: unfocused).code == .keyboardAmbiguous, "keys are never posted when the bound window is not the application's focused one")
    check(plan(["type": "click", "x": 0.5, "y": 0.5], facts: siblings).rungs == [.ax, .post], "sibling windows do not stop pointer events, which carry their point")
    check(plan(["type": "click", "x": 0.5, "y": 0.5], requested: [.post]).rungs == [.post] && plan(["type": "click", "x": 0.5, "y": 0.5], requested: [.ax]).rungs == [.ax], "only the rungs the runner allows are tried")
    check(plan(["type": "click", "x": 0.5, "y": 0.5], requested: [.foreground]).code == .unavailable, "the helper never performs the foreground rung itself")
    check(plan(["type": "menu_item", "path": ["File", "New"]], requested: [.post]).code == .unavailable, "a menu item cannot be posted")
    check(plan(["type": "click", "x": 0.5, "y": 0.5], skipped: [.ax]).rungs == [.post], "a rung that missed twice is skipped")
    let allSkipped = plan(["type": "click", "x": 0.5, "y": 0.5], skipped: [.ax, .post])
    check(allSkipped.rungs.isEmpty && allSkipped.code == .noEffect, "with every rung skipped the background has no effect here")
    check(plan(["type": "double_click", "x": 0.5, "y": 0.5], requested: [.post], facts: minimized).code == .minimized, "the reason a wanted rung was dropped is the code")

    var misses = RungMisses()
    check(misses.skipped(appId: "com.apple.Notes", type: "click").isEmpty, "nothing is skipped before a miss")
    misses.record(appId: "com.apple.Notes", type: "click", rung: .post)
    check(misses.skipped(appId: "com.apple.Notes", type: "click").isEmpty, "one miss does not skip a rung")
    misses.record(appId: "com.apple.notes", type: "click", rung: .post)
    check(misses.skipped(appId: "com.apple.Notes", type: "click") == [.post], "two misses skip that rung for the rest of the run, whatever the identifier's case")
    check(misses.skipped(appId: "com.apple.Notes", type: "type_text").isEmpty && misses.skipped(appId: "com.apple.TextEdit", type: "click").isEmpty, "misses are per application and action kind")
    check(RungMisses.limit == 2, "two misses are the limit")

    // Postcondition reads and verdicts.
    let width = 200, height = 100
    let base = [UInt8](repeating: 80, count: width * height * 4)
    let blank = ScreenPixels(width: width, height: height, rgba: base)
    func edited(_ rect: CGRect) -> ScreenPixels {
        var data = base
        for y in Int(rect.minY)..<Int(rect.maxY) { for x in Int(rect.minX)..<Int(rect.maxX) { for channel in 0..<3 { data[(y * width + x) * 4 + channel] = 255 } } }
        return ScreenPixels(width: width, height: height, rgba: data)
    }
    let before = TargetObservation(controls: "a", fieldValue: "hello", windowCount: 1, pixels: blank)
    let target = CGRect(x: 90, y: 40, width: 20, height: 20)
    let same = postconditionRead(before: before, after: before, targetRect: target)
    check(!same.any && postconditionVerdict(same) == RungEffect.none, "an identical reading is no effect")
    check(postconditionRead(before: before, after: TargetObservation(controls: "b", fieldValue: "hello", windowCount: 1, pixels: blank), targetRect: target).controlsChanged, "a changed controls hash is observed")
    check(postconditionRead(before: before, after: TargetObservation(controls: "a", fieldValue: "hello!", windowCount: 1, pixels: blank), targetRect: target).fieldChanged, "a changed field value is observed")
    check(postconditionRead(before: before, after: TargetObservation(controls: "a", fieldValue: "hello", windowCount: 2, pixels: blank), targetRect: target).windowCountChanged, "a sheet or new window is observed")
    let atTarget = postconditionRead(before: before, after: TargetObservation(controls: "a", fieldValue: "hello", windowCount: 1, pixels: edited(CGRect(x: 95, y: 45, width: 4, height: 4))), targetRect: target)
    check(atTarget.targetPixelsChanged && !atTarget.windowPixelsChanged && postconditionVerdict(atTarget) == .changed, "a small change at the target counts even when the whole window barely changed")
    let elsewhere = postconditionRead(before: before, after: TargetObservation(controls: "a", fieldValue: "hello", windowCount: 1, pixels: edited(CGRect(x: 10, y: 10, width: 60, height: 40))), targetRect: target)
    check(elsewhere.windowPixelsChanged && !elsewhere.targetPixelsChanged && postconditionVerdict(elsewhere) == .changed, "a change elsewhere in the window counts as delivered")
    check(!postconditionRead(before: before, after: TargetObservation(controls: "a", fieldValue: "hello", windowCount: 1, pixels: nil), targetRect: target).any, "a missing image is not evidence of change")
    check(!postconditionRead(before: before, after: before, targetRect: nil).any, "with no target rectangle only the whole window is compared")
    check(Set(same.dictionary.keys) == ["controls", "field", "windows", "targetPixels", "windowPixels", "focus", "control"] && same.dictionary.values.allSatisfy { $0 as? Bool == false }, "the observed read reports exactly its seven flags")

    check(writeVerdict(readBack: "hello world", expected: "hello world", echoRisk: false, fieldPixelsChanged: false) == .changed, "a read-back equal to the expectation confirms a write")
    check(writeVerdict(readBack: "hello", expected: "hello world", echoRisk: false, fieldPixelsChanged: true) == RungEffect.none, "a read-back that differs is no effect, whatever the pixels")
    check(writeVerdict(readBack: nil, expected: "hello world", echoRisk: false, fieldPixelsChanged: false) == RungEffect.none, "no read-back is no effect")
    check(writeVerdict(readBack: "hello world", expected: "hello world", echoRisk: true, fieldPixelsChanged: false) == .unverifiable, "an echo from a Chromium or Electron web area without a visible change is unverifiable")
    check(writeVerdict(readBack: "hello world", expected: "hello world", echoRisk: true, fieldPixelsChanged: true) == .changed, "an echo with the field's pixels changed is confirmed")

    let delivered = targetResult(rung: .ax, effect: .changed, code: nil, read: atTarget)
    check(delivered["executed"] as? Bool == true && delivered["rung"] as? String == "ax" && delivered["effect"] as? String == "changed" && delivered["code"] == nil && (delivered["observed"] as? [String: Any])?["targetPixels"] as? Bool == true, "a delivered step reports its rung, effect and observation")
    let refused = targetResult(rung: nil, effect: nil, code: .minimized, read: nil)
    check(refused["executed"] as? Bool == false && refused["code"] as? String == "TARGET_MINIMIZED" && refused["rung"] == nil && refused["effect"] == nil && refused["observed"] == nil, "a refused step reports only its code")
    let missed = targetResult(rung: .post, effect: RungEffect.none, code: .noEffect, read: same)
    check(missed["executed"] as? Bool == true && missed["effect"] as? String == "none" && missed["code"] as? String == "RUNG_NO_EFFECT", "a step that read as no effect says so with the last rung tried")

    // Coordinates: fractions of the window image map through the window's frame now.
    let window = CGRect(x: 100, y: 50, width: 800, height: 600)
    check(windowPoint(x: 0, y: 0, in: window) == CGPoint(x: 100, y: 50), "the top left fraction is the frame's origin")
    check(windowPoint(x: 0.5, y: 0.5, in: window) == CGPoint(x: 500, y: 350), "the centre maps to the frame's centre")
    check(windowPoint(x: 1, y: 1, in: window) == CGPoint(x: 899, y: 649), "the far edge lands on the last row and column, inside the window")
    check(windowPoint(x: 0.5, y: 0.5, in: window.offsetBy(dx: 300, dy: 0)) == CGPoint(x: 800, y: 350), "a window the user dragged aside moves the point with it")
    check(windowPoint(x: 1.2, y: 0.5, in: window) == nil && windowPoint(x: -0.1, y: 0.5, in: window) == nil && windowPoint(x: .nan, y: 0.5, in: window) == nil, "fractions outside the image or not finite are invalid")
    check(windowPoint(x: 0.5, y: 0.5, in: CGRect(x: 0, y: 0, width: 0.5, height: 100)) == nil, "a frame under a point wide has no points")
    let scaled = imageRect(CGRect(x: 300, y: 200, width: 100, height: 50), window: window, imageWidth: 1600, imageHeight: 1200)
    check(scaled == CGRect(x: 400, y: 300, width: 200, height: 100), "a screen rectangle maps to image pixels relative to the frame at the image's scale")
    check(imageRect(CGRect(x: 300, y: 200, width: 100, height: 50), window: .zero, imageWidth: 10, imageHeight: 10).isNull, "an empty frame maps nothing")

    // Cover: the parts of the window other windows hide, from the z-ordered list.
    let frame = CGRect(x: 0, y: 0, width: 1000, height: 500)
    check(uncoveredRects(of: frame, above: []) == [frame] && coverage(of: frame, above: []) == 0, "nothing above leaves the whole window uncovered")
    check(uncoveredRects(of: frame, above: [frame]).isEmpty && coverage(of: frame, above: [frame]) == 1, "a window the same size on top covers everything")
    check(uncoveredRects(of: frame, above: [CGRect(x: -100, y: -100, width: 2000, height: 1000)]).isEmpty, "a larger window on top covers everything")
    let half = coverage(of: frame, above: [CGRect(x: 500, y: 0, width: 500, height: 500)])
    check(abs(half - 0.5) < 0.0001, "half covered is 0.5")
    check(abs(coverage(of: frame, above: [CGRect(x: 500, y: 0, width: 500, height: 500), CGRect(x: 600, y: 100, width: 200, height: 200)]) - 0.5) < 0.0001, "overlapping windows above are counted once")
    check(abs(coverage(of: frame, above: [CGRect(x: 0, y: 0, width: 500, height: 500), CGRect(x: 500, y: 0, width: 500, height: 500)]) - 1) < 0.0001, "two windows that together cover everything cover everything")
    check(coverage(of: frame, above: [CGRect(x: 2000, y: 2000, width: 100, height: 100)]) == 0, "a window elsewhere on the desktop covers nothing")
    let left = uncoveredRects(of: frame, above: [CGRect(x: 500, y: 0, width: 500, height: 500)])
    check(left == [CGRect(x: 0, y: 0, width: 500, height: 500)], "the uncovered part is the frame minus the window above")
    let hole = uncoveredRects(of: frame, above: [CGRect(x: 400, y: 200, width: 200, height: 100)])
    check(hole.count == 4 && abs(hole.reduce(0.0) { $0 + Double($1.width * $1.height) } - (500000 - 20000)) < 0.001, "a window in the middle leaves the rest, merged along rows, with the right area")
    check(hole.allSatisfy { !$0.intersects(CGRect(x: 400, y: 200, width: 200, height: 100).insetBy(dx: 1, dy: 1)) }, "no uncovered rectangle overlaps the window above")
    check(uncoveredRects(of: .zero, above: []).isEmpty && coverage(of: .zero, above: []) == 1, "a window without size is treated as fully covered")
    check(windowCovered(0.98) && windowCovered(1) && !windowCovered(0.979), "covered means 98 percent or more")
    check(coveredThreshold == 0.98, "the threshold is the design's")
    check(!staleRisk(covered: false, appClass: .chromium, webArea: true), "an uncovered window is never stale")
    check(staleRisk(covered: true, appClass: .webKit, webArea: false) && staleRisk(covered: true, appClass: .chromium, webArea: false) && staleRisk(covered: true, appClass: .electron, webArea: false), "a covered browser or Electron window may show a stale picture")
    check(!staleRisk(covered: true, appClass: .appKit, webArea: false), "a covered AppKit window keeps drawing")
    check(staleRisk(covered: true, appClass: .appKit, webArea: true), "a covered AppKit window with web content in it may be stale")

    // The tap's hit test and the meaning of the user's input.
    let visible = [CGRect(x: 0, y: 0, width: 500, height: 500)]
    check(pointerInsideTarget(CGPoint(x: 250, y: 250), rects: visible), "a point inside the uncovered part is inside the target")
    check(!pointerInsideTarget(CGPoint(x: 750, y: 250), rects: visible), "a point in the covered part is not inside the target")
    check(!pointerInsideTarget(CGPoint(x: 250, y: 250), rects: []), "a fully covered or off-screen window has no inside")
    func scope(_ type: CGEventType, at point: CGPoint = CGPoint(x: 250, y: 250), bound: Bool = true, handoff: Bool = false, frontmost: Bool = false) -> TakeoverScope? {
        takeoverScope(type: type, location: point, bound: bound, handoff: handoff, uncovered: visible, targetFrontmost: frontmost)
    }
    check([CGEventType.mouseMoved, .leftMouseDown, .keyDown, .scrollWheel, .leftMouseDragged].allSatisfy { scope($0, at: CGPoint(x: 900, y: 900), bound: false) == .screen }, "with nothing bound any input is a takeover of the screen, as today")
    check([CGEventType.mouseMoved, .leftMouseDown, .keyDown].allSatisfy { scope($0, at: CGPoint(x: 900, y: 900), handoff: true) == .screen }, "during the foreground handoff any input is a takeover of the screen, as today")
    check(scope(.leftMouseDown) == .target && scope(.rightMouseDown) == .target && scope(.otherMouseDown) == .target, "a press inside the visible part of the bound window is a takeover of the target")
    check(scope(.leftMouseDragged) == .target && scope(.scrollWheel) == .target, "a drag or wheel inside it is a takeover of the target")
    check(scope(.leftMouseDown, at: CGPoint(x: 750, y: 250)) == nil && scope(.scrollWheel, at: CGPoint(x: 900, y: 900)) == nil, "a press or wheel elsewhere, or over the part another window covers, is normal life")
    check(scope(.mouseMoved) == nil && scope(.mouseMoved, frontmost: true) == nil, "hovering over the bound window is not working in it")
    check(scope(.keyDown, frontmost: true) == .target, "a key while the target is frontmost is the user typing into it")
    check(scope(.keyDown, frontmost: false) == nil, "a key anywhere else is normal life")
    check(scope(.keyUp) == nil && scope(.flagsChanged, frontmost: true) == nil, "releases and modifiers are never a takeover of the target")
    // Where the input put the hands, for the resume rule: a press, drag or wheel lands on the visible part of the window or elsewhere, a key wherever the focus is, and a hover, a release or a modifier says nothing.
    let halfCovered = uncoveredRects(of: CGRect(x: 0, y: 0, width: 500, height: 500), above: [CGRect(x: 250, y: 0, width: 250, height: 500)])
    func placed(_ type: CGEventType, at point: CGPoint = CGPoint(x: 100, y: 100), rects: [CGRect] = visible) -> HandsPlacement? {
        handsPlacement(type: type, location: point, uncovered: rects)
    }
    check([CGEventType.leftMouseDown, .rightMouseDown, .otherMouseDown, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .scrollWheel].allSatisfy { placed($0) == .pointerInside }, "a press, drag or wheel over the visible part of the window puts the hands in it")
    check(placed(.leftMouseDown, rects: halfCovered) == .pointerInside && placed(.leftMouseDown, at: CGPoint(x: 400, y: 100), rects: halfCovered) == .pointerOutside, "a press on the half another window covers is in that window, not the target")
    check(placed(.scrollWheel, at: CGPoint(x: 900, y: 900)) == .pointerOutside && placed(.leftMouseDown, rects: []) == .pointerOutside, "a press or wheel elsewhere, or over a window nothing of which is visible, is outside")
    check(placed(.keyDown) == .key && placed(.keyDown, at: CGPoint(x: 900, y: 900)) == .key, "a key is a key wherever the pointer is: its place is the focus, read when asked")
    check(placed(.mouseMoved) == nil && placed(.mouseMoved, at: CGPoint(x: 900, y: 900)) == nil && placed(.keyUp) == nil && placed(.flagsChanged) == nil && placed(.leftMouseUp) == nil, "hovering over the window or away from it, releases and modifiers say nothing about where the hands are")
    // Whether one event is aimed at the window is the same question asked of its placement and the front at that moment.
    func inside(_ type: CGEventType, at point: CGPoint = CGPoint(x: 100, y: 100), rects: [CGRect] = visible, frontmost: Bool = false) -> Bool {
        inputInsideTarget(type: type, location: point, uncovered: rects, targetFrontmost: frontmost)
    }
    check(inside(.leftMouseDown) && inside(.rightMouseDown) && inside(.scrollWheel) && inside(.leftMouseDragged), "a press, drag or wheel over the visible part of the window is aimed at it")
    check(!inside(.mouseMoved) && !inside(.mouseMoved, frontmost: true), "hovering over the window is aimed at nothing, so it never records the hands as inside")
    check(!inside(.scrollWheel, at: CGPoint(x: 900, y: 900)) && !inside(.leftMouseDown, rects: []), "a pointer elsewhere, or over a window nothing of which is visible, is outside")
    check(inside(.keyDown, frontmost: true) && !inside(.keyDown, frontmost: false) && inside(.keyDown, at: CGPoint(x: 900, y: 900), frontmost: true), "a key is aimed at the target exactly when its application is frontmost, wherever the pointer is")
    check(!inside(.keyUp, frontmost: true) && !inside(.flagsChanged, frontmost: true), "releases and modifiers are aimed at nothing")
    for type in [CGEventType.mouseMoved, .leftMouseDown, .scrollWheel, .keyDown, .keyUp] {
        for (point, frontmost) in [(CGPoint(x: 100, y: 100), false), (CGPoint(x: 900, y: 900), false), (CGPoint(x: 100, y: 100), true)] {
            check(inside(type, at: point, frontmost: frontmost) == handsInside(placed(type, at: point), targetFrontmost: frontmost), "aimed at the window and hands inside agree for event \(type.rawValue) at \(Int(point.x)),\(Int(point.y)) frontmost \(frontmost)")
        }
    }
    // The scope from the facts the tap reads once agrees with the scope from the location.
    check(takeoverScope(type: .leftMouseDown, inside: true, bound: true, handoff: false) == .target && takeoverScope(type: .keyDown, inside: true, bound: true, handoff: false) == .target, "a press or key aimed at the target is a takeover of it")
    check(takeoverScope(type: .mouseMoved, inside: true, bound: true, handoff: false) == nil, "hovering aimed at the target is still not working in it")
    check(takeoverScope(type: .leftMouseDown, inside: false, bound: true, handoff: false) == nil && takeoverScope(type: .keyDown, inside: false, bound: true, handoff: false) == nil, "input aimed elsewhere is normal life")
    check(takeoverScope(type: .leftMouseDown, inside: false, bound: false, handoff: false) == .screen && takeoverScope(type: .mouseMoved, inside: false, bound: true, handoff: true) == .screen, "nothing bound, or the handoff under way, keeps today's rule")
    for type in [CGEventType.mouseMoved, .leftMouseDown, .rightMouseDown, .leftMouseDragged, .scrollWheel, .keyDown] {
        for (point, frontmost) in [(CGPoint(x: 250, y: 250), false), (CGPoint(x: 750, y: 250), false), (CGPoint(x: 250, y: 250), true), (CGPoint(x: 900, y: 900), true)] {
            let byLocation = takeoverScope(type: type, location: point, bound: true, handoff: false, uncovered: visible, targetFrontmost: frontmost)
            let byFacts = takeoverScope(type: type, inside: inputInsideTarget(type: type, location: point, uncovered: visible, targetFrontmost: frontmost), bound: true, handoff: false)
            check(byLocation == byFacts, "the scope from the location and from the facts agree for event \(type.rawValue) at \(Int(point.x)),\(Int(point.y)) frontmost \(frontmost)")
        }
    }

    check(targetActivation(lastManualInputAt: 99.9, now: 100, handoff: false) == .userEntered, "the target coming forward within 0.3 s of the user's input is the user entering it")
    check(targetActivation(lastManualInputAt: 99.75, now: 100, handoff: false) == .userEntered, "a quarter second after the user's input still counts as theirs")
    check(targetActivation(lastManualInputAt: 99.6, now: 100, handoff: false) == .selfActivated, "the target coming forward with no recent input activated itself")
    check(targetActivation(lastManualInputAt: nil, now: 100, handoff: false) == .selfActivated, "with no input ever seen the activation is the application's own")
    check(targetActivation(lastManualInputAt: 99.9, now: 100, handoff: true) == .expected && targetActivation(lastManualInputAt: nil, now: 100, handoff: true) == .expected, "during the handoff the activation is expected, whatever the user did")
    check(targetActivation(lastManualInputAt: 100.5, now: 100, handoff: false) == .selfActivated, "an input timestamp after now is not recent input")
    check(selfActivationWindow == 0.3, "the window is the design's 300 ms")

    // The words name an application the launcher's way; only a bundle identifier finds the running one.
    let installed = [LaunchCandidate(path: "/Applications/Slack.app", bundleId: "com.tinyspeck.slackmacgap", names: ["Slack"], displayName: "Slack", running: true, rootIndex: 1),
                     LaunchCandidate(path: "/System/Applications/Notes.app", bundleId: "com.apple.Notes", names: ["Notes"], displayName: "Notes", running: false, rootIndex: 0),
                     LaunchCandidate(path: "/Applications/1Password.app", bundleId: "com.1password.1password", names: ["1Password"], displayName: "1Password", running: true, rootIndex: 1)]
    let runningNow: Set<String> = ["com.tinyspeck.slackmacgap", "com.1password.1password", "com.apple.finder"]
    func named(_ words: String) -> TargetNameResolution { resolveTargetName(resolveLaunch(query: words, candidates: installed, protectedApps: []), runningBundleIds: runningNow) }
    check(named("Slack") == .running(bundleId: "com.tinyspeck.slackmacgap", name: "Slack") && named("slack") == .running(bundleId: "com.tinyspeck.slackmacgap", name: "Slack"), "an installed, running application the words name is found by its bundle identifier")
    check(named("Notes") == .notRunning(name: "Notes"), "an installed application that is not running is not running, so the run says so (TARGET_GONE)")
    check(named("1Password") == .protected, "a protected application the words name is protected (TARGET_PROTECTED)")
    check(named("Slack about lunch") == .unknown && named("Finder") == .unknown && named("the morning") == .unknown, "words that name no installed application are unknown, however a running process is called")
    check(resolveTargetName(.ambiguous(["Slack", "Slack Beta"]), runningBundleIds: runningNow) == .unknown, "words that name several applications are unknown, so the next candidate is tried")
    check(resolveTargetName(.resolved(appId: "com.apple.Notes", name: "Notes", path: "/x"), runningBundleIds: ["com.apple.notes"]) == .running(bundleId: "com.apple.Notes", name: "Notes"), "the running set is compared without case")

    // A handoff nobody closed ends on its own once the helper's own input has been quiet for the limit.
    check(handoffIdleLimit == 20, "the handoff's idle limit is twenty seconds")
    check(!handoffExpired(handoff: false, lastInputAt: 0, now: 100), "no handoff, nothing to expire")
    check(!handoffExpired(handoff: true, lastInputAt: 90, now: 100) && handoffExpired(handoff: true, lastInputAt: 80, now: 100), "an open handoff expires at the limit after the helper's last input, not before")
    check(!handoffExpired(handoff: true, lastInputAt: 100, now: 100), "input just sent keeps the handoff open")

    // The binding names one process and its window; a recycled pid is never the same target.
    let bound = TargetIdentity(pid: 500, bundleId: "com.apple.Notes", launchedAt: 1000)
    check(targetLive(bound: bound, running: bound, windowOwner: 500), "the same process owning the window is live")
    check(!targetLive(bound: bound, running: nil, windowOwner: 500), "a process that ended is gone")
    check(!targetLive(bound: bound, running: TargetIdentity(pid: 500, bundleId: "com.apple.Notes", launchedAt: 2000), windowOwner: 500), "a relaunched process with the same pid is gone")
    check(!targetLive(bound: bound, running: TargetIdentity(pid: 500, bundleId: "com.apple.TextEdit", launchedAt: 1000), windowOwner: 500), "a different bundle at the same pid is gone")
    check(!targetLive(bound: bound, running: bound, windowOwner: nil) && !targetLive(bound: bound, running: bound, windowOwner: 501), "a window that closed or belongs to another process is gone")
    check(!targetLive(bound: bound, running: TargetIdentity(pid: 500, bundleId: "com.apple.Notes", launchedAt: nil), windowOwner: 500), "a process whose launch time is no longer known is not the same process")

    // The helper's wiring (design §4): a bound run posts to one pid through one
    // function, never to the HID stream, hit-tests within the bound application
    // only, captures the window alone, and activates nothing before the
    // announced handoff.
    let root = FileManager.default.currentDirectoryPath
    guard let source = try? String(contentsOfFile: root + "/native/macos/Controller.swift", encoding: .utf8) else { check(false, "the helper source is readable from the repository root"); return }
    func section(_ from: String, _ to: String) -> Substring {
        guard let start = source.range(of: from), let end = source.range(of: to, range: start.upperBound..<source.endIndex) else { return "" }
        return source[start.lowerBound..<end.lowerBound]
    }
    let targetSection = section("// MARK: target", "// MARK: system index")
    check(!targetSection.isEmpty && !targetSection.contains(".cghidEventTap") && !targetSection.contains("postInput(") && !targetSection.contains("postScroll("), "a bound run never posts to the HID stream")
    check(source.components(separatedBy: "postToPid(").count == 3 && targetSection.components(separatedBy: ".postToPid(").count == 2 && section("func releaseHeldInputAndExit(", "\n}").contains("postToPid(pid)"), "events reach a pid only through postToTarget, and their release goes to the same pid")
    check(section("func postToTarget(", "\n}").contains("targetLive(bound: bound.identity") && section("func postToTarget(", "\n}").contains(".eventTargetUnixProcessID") && section("func postToTarget(", "\n}").contains(".mouseEventWindowUnderMousePointerThatCanHandleThisEvent"), "every posted event re-checks the binding and carries the routing fields")
    check(!targetSection.contains("AXUIElementCreateSystemWide"), "a bound run hit-tests within the bound application only")
    check(targetSection.contains("SCContentFilter(desktopIndependentWindow: window)") && !targetSection.contains("SCContentFilter(display:"), "a bound run captures the window alone")
    let beforeHandoff = section("// MARK: target", "func foregroundTarget(")
    check(!beforeHandoff.contains("app.activate(") && !beforeHandoff.contains("kAXRaiseAction") && !beforeHandoff.contains("unhide()"), "nothing before the announced handoff activates or raises the target")
    let handoff = section("func foregroundTarget(", "\n}")
    check(handoff.contains("startHandoffWatch()") && handoff.contains("kAXMinimizedAttribute, kCFBooleanFalse") && handoff.contains("!butlerOwn(front)"), "the handoff starts its watch, unminimizes the window before raising it, and never remembers Butler as the application to give the front back to")
    let watch = section("func startHandoffWatch(", "\n}")
    check(watch.contains("handoffExpired(handoff: targetHandoff, lastInputAt: lastInputTime") && watch.contains("endTargetHandoff()") && watch.contains("rememberedApplication()"), "the watch ends an expired handoff and gives the remembered application the front back")
    check(section("func endTargetHandoff(", "\n}").contains("handoffWatch = nil") && section("func releaseTarget(", "\n}").contains("handoffWatch = nil"), "closing the handoff or releasing the target stops the watch")
    // The context of a bound window carries only keys the runner's schema knows (src/core/context.ts), or it is dropped whole.
    let contextSection = section("func targetContext(", "\n}")
    let contextKeys = Set(contextSection.components(separatedBy: "result[\"").dropFirst().compactMap { $0.split(separator: "\"", maxSplits: 1).first.map(String.init) })
    check(contextSection.contains("[\"appName\": bound.appName, \"windowTitle\": title]") && contextKeys == ["documentName", "visibleText", "selectedText", "windowCount", "openApps", "accessibility", "menus", "background"], "targetContext writes exactly the keys the runner's schema accepts: \(contextKeys.sorted())")
    check(!targetSection.contains("focusedField"), "the field a write goes to is the surface's, never a context key")
    // Naming and binding.
    check(section("func runningApplication(named", "\n}").contains("resolveLaunch(query: name, candidates: applicationCandidates()") && section("func runningApplication(named", "\n}").contains("resolveTargetName("), "a spoken application resolves through the launcher's rules, then to a running instance")
    check(section("func bindTarget(", "\n}").contains("rememberedApplication() ?? NSWorkspace.shared.frontmostApplication"), "an empty bind spec means the application remembered when the wake word ended, the front now only when nothing was remembered")
    check(section("func rememberedApplication(", "\n}").contains("!butlerOwn(app)"), "Butler itself is never the remembered application")
    // The cover: standard windows of other applications only.
    let cover = section("func targetCover(", "\n}")
    check(cover.contains("kCGWindowLayer as String] as? Int) == 0") && cover.contains("[getppid(), getpid()]"), "the cover counts standard-layer windows that are not Butler's own")
    // TARGET_GONE reaches the runner once: in the reply when a call finds the binding dead, as an event only from the tracking tick.
    check(targetSection.components(separatedBy: "emitting: true").count == 2 && section("func refreshTargetRects(", "\n}").contains("targetGone(bound, emitting: true)"), "the target_gone event is emitted only where no reply can carry the code")
    check(section("func targetGone(", "\n}").contains("if emitting { emit("), "a thrown TARGET_GONE carries its code in the reply and emits nothing")
    check(section("func performTargetAction(", "\n}").contains("assertTargetElement(element, bound: bound)") && section("func setTargetAttribute(", "\n}").contains("assertTargetElement(element, bound: bound)"), "every accessibility action and write asserts the element is the bound process's")
    // The tap (design §3): the facts are read once per event, every input's
    // placement is recorded for the resume rule whether the run is going or
    // held, the scope comes from the same facts, and Escape is untouched.
    let tap = section("func installTap(", "\n}")
    check(tap.components(separatedBy: "userInputFacts(type:type, location:event.location)").count == 2, "the tap reads where the input landed once per event")
    check(tap.components(separatedBy: "placement:aimed.placement)").count == 3 && !tap.contains("inTarget:"), "every unmarked input, held or going, is recorded with where it put the hands")
    check(tap.contains("takeoverScope(type:type, inside:aimed.inside, bound:aimed.bound, handoff:aimed.handoff)") && tap.contains("\"scope\":scope.rawValue"), "the tap scopes the user's input from the same facts and reports the scope, never a coordinate")
    check(tap.contains("if escape {latch(true);emit([\"event\":\"emergency_stop\"])}") && tap.contains("emergencyEscape(now: now, lastEscapeAt: lastEscapeAt, watching: watching)"), "Escape is the emergency stop before any scope is read, going or held")
    let facts = section("func userInputFacts(", "\n}")
    check(facts.contains("withState { (targetBinding, targetHandoff, targetUncovered) }") && facts.contains("type == .keyDown && !isStopped() && NSWorkspace.shared.frontmostApplication?.processIdentifier == bound.pid") && !facts.contains("AXUIElement"), "the tap's facts come from the cached rectangles and one frontmost compare for a key while the run is going, with no accessibility call")
    check(facts.contains("let placement = handsPlacement(type: type, location: location, uncovered: uncovered)") && facts.contains("return (false, false, false, placement)") && facts.contains("handsInside(placement, targetFrontmost: frontmost), placement)"), "the hands' placement is read from the same hit test, recorded whether or not a target is bound, and the aim is that placement against the front now")
    check(!section("func refreshTargetRects(", "\n}").contains("AXUIElement") && !section("func targetCover(", "\n}").contains("AXUIElement") && section("func targetCover(", "\n}").contains("CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements]"), "the rectangle cache is refreshed from the window server's list alone, so a hung target cannot stall the tap")
    let tracking = section("func startTargetTracking(", "\n}")
    check(tracking.contains(".milliseconds(250), repeating: .milliseconds(250)") && tracking.contains("[kAXWindowMovedNotification, kAXWindowResizedNotification]") && tracking.contains("queue: .global(qos: .utility)"), "the cache is refreshed every 250 ms and when the window moves or resizes, off the tap thread")
    // The idle report carries the target facts, and a hold in the window ends with nothing to give back.
    let idle = section("func startIdleReporting(", "\n}")
    check(idle.contains("withState { targetBinding }.map { NSWorkspace.shared.frontmostApplication?.processIdentifier == $0.pid }") && idle.contains("tick(now: ProcessInfo.processInfo.systemUptime, targetFrontmost: frontmost)"), "the idle report says whether the target is in front when one is bound")
    let restore = section("case \"restore\":", "default:throw")
    check(restore.contains("let background = withState { targetBinding != nil && !targetHandoff }") && restore.contains("endTargetHandoff()") && restore.contains("if background { return [\"restored\": true] }"), "restore gives nothing back for a bound run outside its announced second: the window the user left stays where it is")
    // The target's own activation is undone and never the user's.
    let activated = section("func targetActivated(", "\n}")
    check(!activated.contains("recordManualInput") && activated.contains("case .selfActivated:") && activated.contains("previous.activate(options: [])") && activated.contains("emit([\"event\": \"target_self_activated\", \"token\": bound.token])"), "a self-activation is undone and reported, and records no input of the user's")
    check(activated.contains("case .userEntered:") && activated.contains("\"source\": \"target_activated\", \"scope\": TakeoverScope.target.rawValue"), "the target brought forward by the user's hand is a takeover of the target")
}
