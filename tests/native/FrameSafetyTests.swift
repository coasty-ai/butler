import Foundation
import CoreGraphics

@main struct FrameSafetyTests {
    static func main() {
        let width = 1000, height = 640
        let base = [UInt8](repeating: 80, count: width * height * 4)
        let original = ScreenPixels(width: width, height: height, rgba: base)
        let window = CGRect(x: 50, y: 80, width: 900, height: 500)
        let target = CGPoint(x: 500, y: 300)
        func edited(_ rect: CGRect, value: UInt8 = 255) -> ScreenPixels {
            var data = base
            for y in Int(rect.minY)..<Int(rect.maxY) { for x in Int(rect.minX)..<Int(rect.maxX) {
                for channel in 0..<3 { data[(y * width + x) * 4 + channel] = value }
            } }
            return ScreenPixels(width: width, height: height, rgba: data)
        }
        func check(_ condition: Bool, _ name: String) { if !condition { fatalError(name) }; print("PASS: " + name) }
        wakePolicyChecks(check)
        turnPolicyChecks(check)
        launchSafetyChecks(check)
        fileSafetyChecks(check)
        inputIdleChecks(check)
        electronAccessibilityChecks(check)
        namedTargetChecks(check)
        searchCommandChecks(check)
        queryFieldChecks(check)
        workspaceChecks(check)
        agendaRulesChecks(check)
        // Blind surfaces: Spotify (Chromium/CEF) publishes a real window and
        // nothing inside it; a loading window or an empty desktop must not be
        // reported blind, and a tree too large to finish is never blind.
        func level(trusted: Bool = true, w: Double = 1200, h: Double = 800, role: String = "",
                   actionable: Int = 0, complete: Bool = true, hit: Bool = false) -> SurfaceAccessibility? {
            surfaceAccessibility(trusted: trusted, windowWidth: w, windowHeight: h, focusedRole: role,
                                 actionable: actionable, walkComplete: complete, hitTarget: hit)
        }
        check(level() == SurfaceAccessibility.none, "a sized window with nothing actionable, focused or hit is blind")
        check(level(role: "AXTextField", actionable: 3) == .full, "a focused field and controls is full accessibility")
        check(level(actionable: 7) == .partial, "controls without a focused element is partial")
        check(level(role: "AXTextField") == .partial, "a focused field without controls is partial")
        check(level(hit: true) == .partial, "a pointer target found by hit test is not blind")
        check(level(role: "AXWindow") == SurfaceAccessibility.none, "a focused window or unnamed container identifies nothing")
        check(level(role: "AXGroup") == SurfaceAccessibility.none, "a focused unnamed group identifies nothing")
        check(level(complete: false) == .partial, "a walk that ran out of budget is never called blind")
        check(level(trusted: false) == nil, "without Accessibility permission there is no verdict")
        check(level(w: 0, h: 0) == nil, "an empty desktop with no window is not blind")
        check(level(w: 1200, h: 60) == nil, "a window too small to judge is not blind")
        check(level(w: 180, h: 800, role: "AXTextField") == .partial, "a small window that does publish is partial")
        check(level(w: 200, h: 120) == SurfaceAccessibility.none, "the minimum window size is enough to judge")
        let cursor = CGPoint(x:300,y:400)
        check(hitWalkStopsAt(role:"AXGroup",description:"Delete",actions:[]), "hit walk stops at an ancestor with its own accessible description")
        check(hitWalkStopsAt(role:"AXGroup",description:"",actions:["AXShowMenu","AXPress"]), "hit walk stops at a pressable ancestor")
        check(hitWalkStopsAt(role:"AXButton",description:"",actions:[]), "hit walk stops at an actionable role")
        check(!hitWalkStopsAt(role:"AXGroup",description:"  ",actions:["AXShowMenu"]), "hit walk climbs through unlabelled, unpressable containers")
        check(hitWalkClimbRoles.contains("AXImage") && !hitWalkClimbRoles.contains("AXRow"), "hit walk climbs only from text, images and groups")
        check(joinedTargetText(["", "Delete", "delete", "Message   row"]) == "Delete · Message row", "target text joins visited names without blanks or duplicates")
        check(joinedTargetText([String(repeating:"a",count:200), String(repeating:"b",count:200)]).count == 240, "target text is bounded to 240 characters")
        check(typingInterruption(secureInput:false,focusUnchanged:true,secureField:false) == nil, "typing continues in the same non-secure field")
        check(typingInterruption(secureInput:true,focusUnchanged:true,secureField:false) == .surfaceBlocked, "secure input mid-text hands control to the user")
        check(typingInterruption(secureInput:false,focusUnchanged:false,secureField:true) == .surfaceBlocked, "focus moving into a password field hands control to the user")
        check(typingInterruption(secureInput:false,focusUnchanged:false,secureField:false) == .focusChanged, "focus moving to another field stops typing")
        var held = HeldInput()
        held.record(type:.leftMouseDown,location:cursor,keyCode:0)
        held.record(type:.leftMouseDragged,location:CGPoint(x:320,y:400),keyCode:0)
        held.record(type:.keyDown,location:cursor,keyCode:55);held.record(type:.keyDown,location:cursor,keyCode:0)
        check(held.leftButton == CGPoint(x:320,y:400) && held.keys == [55,0], "held input tracks a drag position and pressed keys in order")
        held.record(type:.keyUp,location:cursor,keyCode:0);held.record(type:.leftMouseUp,location:cursor,keyCode:0)
        check(held.leftButton == nil && held.keys == [55] && !held.isEmpty, "released input is no longer held")
        held.record(type:.keyUp,location:cursor,keyCode:55)
        check(held.isEmpty, "nothing is held once every press is released")
        check(independentNavigationShortcut(["type":"hotkey","keys":["CMD","L"]],appId:"com.google.Chrome"), "browser address shortcut does not depend on video pixels")
        check(!independentNavigationShortcut(["type":"hotkey","keys":["CMD","L"]],appId:"com.apple.finder"), "address shortcut exception is browser-specific")
        check(!independentNavigationShortcut(["type":"hotkey","keys":["CMD","ENTER"]],appId:"com.google.Chrome"), "send shortcut retains full validation")
        check(!independentNavigationShortcut(["type":"key","key":"ENTER"],appId:"com.google.Chrome"), "generic Enter retains target validation")
        check(focusedEditingAction(["type":"type_text","text":"query"]), "typing validates its exact focused field")
        check(!focusedEditingAction(["type":"hotkey","keys":["CMD","BACKSPACE"]]), "destructive shortcut is not text navigation")
        check(forwardedSpotlightEvent(type:.keyDown,keyCode:49,flags:.maskCommand,systemSiri:true,now:1.02,deadline:1.15), "own Spotlight shortcut forwarded by system Siri")
        check(!forwardedSpotlightEvent(type:.keyDown,keyCode:49,flags:.maskCommand,systemSiri:false,now:1.02,deadline:1.15), "physical or unrelated app input still interrupts")
        check(!forwardedSpotlightEvent(type:.keyDown,keyCode:53,flags:.maskCommand,systemSiri:true,now:1.02,deadline:1.15), "different forwarded key still interrupts")
        check(!forwardedSpotlightEvent(type:.keyDown,keyCode:49,flags:[.maskCommand,.maskShift],systemSiri:true,now:1.02,deadline:1.15), "different shortcut modifiers still interrupt")
        check(!forwardedSpotlightEvent(type:.keyDown,keyCode:49,flags:.maskCommand,systemSiri:true,now:1.16,deadline:1.15), "forwarding exception expires after 150 milliseconds")
        check(!forwardedSpotlightEvent(type:.keyDown,keyCode:49,flags:.maskCommand,systemSiri:true,now:1.02,deadline:0), "consumed forwarding allowance cannot be reused")
        check(!pointerTakeover(previous:cursor,current:cursor,deltaX:0,deltaY:0,graceActive:false), "stationary mouse notification is not takeover")
        check(!pointerTakeover(previous:cursor,current:CGPoint(x:301,y:400),deltaX:0,deltaY:0,graceActive:false), "1 px zero-delta echo is not takeover")
        check(!pointerTakeover(previous:cursor,current:CGPoint(x:300.1,y:400.2),deltaX:0,deltaY:0,graceActive:false), "subpixel fixed-point echo is not takeover")
        check(!pointerTakeover(previous:cursor,current:CGPoint(x:302,y:401),deltaX:0,deltaY:0,graceActive:false), "zero-delta echo under 3 px is never takeover")
        check(pointerTakeover(previous:cursor,current:CGPoint(x:303,y:400),deltaX:0,deltaY:0,graceActive:true), "3 px pointer movement is takeover even during grace")
        check(pointerTakeover(previous:cursor,current:cursor,deltaX:3,deltaY:0,graceActive:true), "hardware movement at display edge is takeover")
        check(!pointerTakeover(previous:cursor,current:CGPoint(x:301,y:400),deltaX:1,deltaY:0,graceActive:false), "1 px hardware nudge outside grace is not takeover")
        check(!pointerTakeover(previous:cursor,current:CGPoint(x:301,y:400),deltaX:1,deltaY:0,graceActive:true), "small hardware echo right after resume or own input is not takeover")
        pointerJitterChecks(check)
        check(!pointerTakeover(previous:nil,current:cursor,deltaX:5,deltaY:0,graceActive:false), "unknown previous pointer only seeds the anchor")
        check(independentNavigationShortcut(["type":"open_app","name":"Notes"],appId:"com.apple.finder"), "open_app skips pixel revalidation")
        check(!framePixelsChanged(original, original, window: window, points: [target]), "identical rendered pixels")
        check(!framePixelsChanged(original, edited(CGRect(x: 501, y: 290, width: 2, height: 24)), window: window, points: [target]), "blinking caret at input target")
        check(!framePixelsChanged(original, edited(CGRect(x: 780, y: 5, width: 90, height: 20)), window: window, points: [target]), "menu clock outside active window")
        check(!framePixelsChanged(original, edited(CGRect(x: 810, y: 95, width: 10, height: 10)), window: window, points: [target]), "small off-target spinner")
        check(!framePixelsChanged(original, edited(CGRect(x: 50, y: 80, width: 900, height: 500), value: 82), window: window, points: [target]), "minor rendering noise")
        check(framePixelsChanged(original, edited(CGRect(x: 490, y: 295, width: 12, height: 10)), window: window, points: [target]), "small label change at click target")
        check(!framePixelsChanged(original, edited(CGRect(x: 450, y: 275, width: 100, height: 50)), window: window, points: [target], stableControls: [CGRect(x: 444, y: 269, width: 112, height: 62)]), "verified control focus/hover animation")
        check(framePixelsChanged(original, edited(CGRect(x: 600, y: 300, width: 90, height: 50)), window: window, points: [target]), "window layout change")
        check(framePixelsChanged(original, edited(CGRect(x: 490, y: 295, width: 12, height: 10)), window: window, points: [CGPoint(x:100,y:100), target]), "drag destination change")
        check(!targetPixelsChanged(original, edited(CGRect(x: 600, y: 300, width: 90, height: 50)), points: [target], stableControls: [CGRect(x: 444, y: 269, width: 112, height: 62)]), "animation away from a verified stable control target does not block")
        check(targetPixelsChanged(original, edited(CGRect(x: 490, y: 295, width: 12, height: 10)), points: [target]), "target-local change still blocks without a whole-window check")
        check(framePixelsChanged(original, original, window: .null, points: []), "invalid or off-display window fails closed")
        check(original.changed(comparedTo: ScreenPixels(width: 10, height: 10, rgba: []), in: window, target: false), "changed display geometry fails closed")
    }
}
