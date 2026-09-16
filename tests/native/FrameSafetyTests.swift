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
        check(commandAfterWakePhrase("Hey Assist, open Notes.") == "open Notes.", "wake phrase stripped from command")
        check(commandAfterWakePhrase(" HEY, OPEN ASSIST! Stop.") == "Stop.", "case and punctuation in wake phrase")
        check(commandAfterWakePhrase("Hey Assist") == "", "wake phrase alone opens command window")
        check(commandAfterWakePhrase("Say Hey Assist to open it") == nil, "embedded wake phrase does not activate")
        check(commandAfterWakePhrase("Hey assistant open Notes") == nil, "partial word does not activate")
        check(commandAfterWakePhrase("Yes") == nil, "ambient approval cannot wake assistant")
        check(commandAfterWakePhrase("Stop") == nil, "ambient command cannot wake assistant")
        check(activatedVoiceCommand("Hey Assist, open Notes") == "open Notes", "activated session strips repeated wake prefix")
        check(activatedVoiceCommand("Open Notes") == "Open Notes", "activated session retains a new command-only speech segment")
        check(activatedVoiceCommand("Yes") == "Yes", "activated approval remains available for final confidence gating")
        check(resolveVoiceFinal(command:"", latest:"Open Notes and write a note", released:true) == .recovered("Open Notes and write a note"), "empty final marker retains an endpointed command")
        check(resolveVoiceFinal(command:"  \n", latest:"Open Notes", released:true) == .recovered("Open Notes"), "whitespace final marker does not erase speech")
        check(resolveVoiceFinal(command:"", latest:"", released:true) == .missing, "empty utterance never fabricates a command")
        check(resolveVoiceFinal(command:"", latest:"Open Notes", released:false) == .missing, "empty final before release cannot execute a partial")
        check(resolveVoiceFinal(command:"Use the September report", latest:"Use the December report", released:true) == .recognized("Use the September report"), "nonempty final correction supersedes the partial")
        check(resolveVoiceFinal(command:"", latest:"Use September", released:true) == .recovered("Use September"), "recovery retains the latest correction, not the longest hypothesis")
        check(resolveVoiceFinal(command:"Yes", latest:"Yes", released:true) == .recognized("Yes"), "real final approval remains distinguishable")
        check(resolveVoiceFinal(command:"", latest:"Yes", released:true) == .recovered("Yes"), "recovered approval is marked separately for confidence rejection")
        var hypothesis = ""
        for update in ["Open", "Open Notes and write a longer draft", "Open Notes and write a note", "", "  "] {
            hypothesis = retainVoiceHypothesis(previous:hypothesis, update:update)
        }
        check(hypothesis == "Open Notes and write a note", "live callback sequence preserves the last correction across empty flushes")
        check(resolveVoiceFinal(command:"", latest:hypothesis, released:true) == .recovered("Open Notes and write a note"), "recorded failure sequence produces a recoverable command instead of missing speech")
        check(voiceEndpoint(now: 10, started: 0, lastSpeech: 8.7, lastText: 8.6, awake: true, hasText: true) == .finish, "command ends after stable text and silence")
        check(voiceEndpoint(now: 10, started: 0, lastSpeech: 9.5, lastText: 8, awake: true, hasText: true) == .none, "ongoing speech prevents submission")
        check(voiceEndpoint(now: 10, started: 0, lastSpeech: 8, lastText: 9.5, awake: true, hasText: true) == .none, "late recognition update postpones submission")
        check(voiceEndpoint(now: 8, started: 0, lastSpeech: 0, lastText: 0, awake: true, hasText: false) == .empty, "empty wake expires without command")
        check(voiceEndpoint(now: 30, started: 0, lastSpeech: 30, lastText: 30, awake: true, hasText: true) == .finish, "command capture has a hard time limit")
        check(voiceEndpoint(now: 3, started: 0, lastSpeech: 1, lastText: 0, awake: false, hasText: false) == .recycle, "background utterance discarded at silence")
        check(voiceEndpoint(now: 44, started: 0, lastSpeech: 0, lastText: 0, awake: false, hasText: false) == .none, "silence does not constantly restart recognition")
        check(voiceEndpoint(now: 45, started: 0, lastSpeech: 0, lastText: 0, awake: false, hasText: false) == .recycle, "standby recognition rotates before one minute")
        let cursor = CGPoint(x:300,y:400)
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
        check(stationaryPointerEvent(previous:cursor,current:cursor,deltaX:0,deltaY:0), "stationary mouse notification is not takeover")
        check(!stationaryPointerEvent(previous:cursor,current:CGPoint(x:301,y:400),deltaX:0,deltaY:0), "changed position with zero delta is takeover")
        check(!stationaryPointerEvent(previous:cursor,current:cursor,deltaX:1,deltaY:0), "hardware movement at display edge is takeover")
        check(!stationaryPointerEvent(previous:cursor,current:CGPoint(x:300.1,y:400),deltaX:0,deltaY:0), "subpixel movement is takeover")
        check(!stationaryPointerEvent(previous:nil,current:cursor,deltaX:0,deltaY:0), "unknown previous pointer fails closed")
        check(!framePixelsChanged(original, original, window: window, points: [target]), "identical rendered pixels")
        check(!framePixelsChanged(original, edited(CGRect(x: 501, y: 290, width: 2, height: 24)), window: window, points: [target]), "blinking caret at input target")
        check(!framePixelsChanged(original, edited(CGRect(x: 780, y: 5, width: 90, height: 20)), window: window, points: [target]), "menu clock outside active window")
        check(!framePixelsChanged(original, edited(CGRect(x: 810, y: 95, width: 10, height: 10)), window: window, points: [target]), "small off-target spinner")
        check(!framePixelsChanged(original, edited(CGRect(x: 50, y: 80, width: 900, height: 500), value: 82), window: window, points: [target]), "minor rendering noise")
        check(framePixelsChanged(original, edited(CGRect(x: 490, y: 295, width: 12, height: 10)), window: window, points: [target]), "small label change at click target")
        check(!framePixelsChanged(original, edited(CGRect(x: 450, y: 275, width: 100, height: 50)), window: window, points: [target], stableControls: [CGRect(x: 444, y: 269, width: 112, height: 62)]), "verified control focus/hover animation")
        check(framePixelsChanged(original, edited(CGRect(x: 600, y: 300, width: 90, height: 50)), window: window, points: [target]), "window layout change")
        check(framePixelsChanged(original, edited(CGRect(x: 490, y: 295, width: 12, height: 10)), window: window, points: [CGPoint(x:100,y:100), target]), "drag destination change")
        check(framePixelsChanged(original, original, window: .null, points: []), "invalid or off-display window fails closed")
        check(original.changed(comparedTo: ScreenPixels(width: 10, height: 10, rgba: []), in: window, target: false), "changed display geometry fails closed")
    }
}
