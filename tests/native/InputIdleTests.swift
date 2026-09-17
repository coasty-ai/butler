import Foundation
import CoreGraphics

// Pure pointer jitter checks for pointerTakeover (InputSafety.swift).
func pointerJitterChecks(_ check: (Bool, String) -> Void) {
    let anchor = CGPoint(x:300, y:400)
    func takeover(_ x: Double, _ y: Double, _ dx: Int64, _ dy: Int64) -> [Bool] {
        [false, true].map { pointerTakeover(previous:anchor, current:CGPoint(x:x, y:y), deltaX:dx, deltaY:dy, graceActive:$0) }
    }
    check(takeover(301, 400.58, -1, 1) == [false, false], "logged 1.16 px resting-hand nudge is not takeover in or out of grace")
    check(takeover(302, 402, 2, 2) == [false, false], "2.8 px of travel with hardware delta 2 is not takeover in or out of grace")
    check(takeover(302.9, 400, 2, 0) == [false, false], "just under 3 px of travel is not takeover")
    check(takeover(300, 400, -2, 2) == [false, false], "hardware delta under 3 without travel is not takeover")
    check(takeover(303, 400, 1, 0) == [true, true], "3 px of travel with a small hardware delta is takeover in or out of grace")
    check(takeover(302.2, 402.1, 1, 1) == [true, true], "3 px of diagonal travel is takeover")
    check(takeover(303.5, 400, 2, 0) == [true, true], "logged 3.5 px movement still takes over")
    check(takeover(300.5, 400, 0, -3) == [true, true], "hardware delta of 3 in either direction is takeover without travel")
    // The tap keeps the anchor for ignored events, so drift accumulates.
    check(takeover(301, 400, 1, 0) == [false, false] && takeover(302, 400, 1, 0) == [false, false] && takeover(303, 400, 1, 0) == [true, true], "slow drift from a kept anchor takes over once it reaches 3 px")
}

// Pure manual-input episode and idle reporting checks.
func inputIdleChecks(_ check: (Bool, String) -> Void) {
    check(manualInputKind(type:.mouseMoved, marked:false) == .mouseMove, "pointer movement is mouse_move input")
    check(manualInputKind(type:.scrollWheel, marked:false) == .scroll, "scroll wheel is scroll input")
    check([CGEventType.leftMouseDown, .rightMouseDown, .otherMouseDown, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged].allSatisfy { manualInputKind(type:$0, marked:false) == .click }, "mouse buttons and drags are click input")
    check(manualInputKind(type:.keyDown, marked:false) == .key, "key presses are key input")
    check([CGEventType.keyUp, .flagsChanged, .leftMouseUp, .tapDisabledByTimeout, .tapDisabledByUserInput].allSatisfy { manualInputKind(type:$0, marked:false) == nil }, "releases, modifiers and tap notices are not manual input")
    check([CGEventType.mouseMoved, .scrollWheel, .leftMouseDown, .keyDown].allSatisfy { manualInputKind(type:$0, marked:true) == nil }, "our own marked input never counts as manual input")
    check(ManualInputEpisode.thresholds.map { $0.idleMs } == [1000, 3000], "idle thresholds are 1000 and 3000 ms")
    check(Set(ManualInputKind.allCases.map { $0.rawValue }) == ["mouse_move", "scroll", "click", "key"], "reported kinds are exactly mouse_move, scroll, click and key")

    var idle = ManualInputEpisode()
    check(idle.tick(now:100).isEmpty && !idle.isOpen, "no input means no episode and no report")
    idle.observe(kind:.mouseMove, at:10)
    check(idle.isOpen && idle.tick(now:10.5).isEmpty, "no report before a second of quiet")
    check(idle.tick(now:11) == [IdleReport(idleMs:1000, kinds:["mouse_move"])], "one second of quiet reports idleMs 1000")
    check(idle.tick(now:11.15).isEmpty && idle.tick(now:12.9).isEmpty, "the 1000 report is sent once")
    check(idle.tick(now:13) == [IdleReport(idleMs:3000, kinds:["mouse_move"])], "three seconds of quiet reports idleMs 3000")
    check(!idle.isOpen && idle.kinds.isEmpty && idle.tick(now:20).isEmpty, "the 3000 report closes the episode and resets kinds")

    idle = ManualInputEpisode()
    idle.observe(kind:.click, at:0); idle.observe(kind:.mouseMove, at:0.25); idle.observe(kind:.click, at:0.5)
    idle.observe(kind:.scroll, at:0.5); idle.observe(kind:.key, at:0.75)
    check(idle.tick(now:1.5).isEmpty, "later input restarts the one second wait")
    check(idle.tick(now:1.75) == [IdleReport(idleMs:1000, kinds:["click", "key", "mouse_move", "scroll"])], "kinds are sorted and unique")

    idle = ManualInputEpisode()
    idle.observe(kind:.mouseMove, at:0)
    check(idle.tick(now:0.875).isEmpty, "quiet under a second is not reported")
    idle.observe(kind:.scroll, at:0.875)
    check(idle.tick(now:1.5).isEmpty && idle.tick(now:1.875) == [IdleReport(idleMs:1000, kinds:["mouse_move", "scroll"])], "input before the first threshold restarts timing and keeps kinds")

    idle = ManualInputEpisode()
    idle.observe(kind:.mouseMove, at:0)
    check(idle.tick(now:1) == [IdleReport(idleMs:1000, kinds:["mouse_move"])], "first quiet second is reported")
    idle.observe(kind:.click, at:2)
    check(idle.isOpen && idle.tick(now:2.5).isEmpty && idle.tick(now:3).map { $0.idleMs } == [1000], "input between the reports restarts timing, so 1000 is due again instead of 3000")
    check(idle.tick(now:3.5).isEmpty && idle.tick(now:5) == [IdleReport(idleMs:3000, kinds:["click", "mouse_move"])], "kinds accumulate until the episode closes")
    idle.observe(kind:.key, at:10)
    check(idle.tick(now:11) == [IdleReport(idleMs:1000, kinds:["key"])], "a new episode starts with only its own kinds")

    idle = ManualInputEpisode()
    idle.observe(kind:.scroll, at:0)
    check(idle.tick(now:3.5) == [IdleReport(idleMs:1000, kinds:["scroll"]), IdleReport(idleMs:3000, kinds:["scroll"])] && !idle.isOpen, "a late tick past both thresholds reports both in order and closes")

    idle = ManualInputEpisode()
    idle.observe(kind:.key, at:5); idle.observe(kind:.key, at:4.5)
    check(idle.lastInputAt == 5 && idle.tick(now:5.75).isEmpty && idle.tick(now:6).map { $0.idleMs } == [1000], "an out-of-order timestamp never moves the episode back")
    idle = ManualInputEpisode()
    idle.observe(kind:.click, at:10)
    check(idle.tick(now:9).isEmpty, "a tick earlier than the input does not report")

    let event = IdleReport(idleMs:3000, kinds:["click", "mouse_move"]).event
    check(Set(event.keys) == ["event", "idleMs", "kinds"] && event["event"] as? String == "user_input_idle" && event["idleMs"] as? Int == 3000 && event["kinds"] as? [String] == ["click", "mouse_move"], "idle event has exactly event, idleMs and kinds")
    if let data = try? JSONSerialization.data(withJSONObject:event, options:[.sortedKeys]) {
        check(String(decoding:data, as:UTF8.self) == #"{"event":"user_input_idle","idleMs":3000,"kinds":["click","mouse_move"]}"#, "idle event serializes with no coordinates, key codes or characters")
    } else { check(false, "idle event serializes") }
}

// Pure AXManualAccessibility eligibility and once-per-process checks.
func electronAccessibilityChecks(_ check: (Bool, String) -> Void) {
    let protected = ["com.1password", "com.apple.Passwords", "com.apple.keychainaccess", "com.bitwarden", "com.apple.Terminal", "com.googlecode.iterm2"]
    func eligible(_ pid: pid_t, _ bundle: String) -> Bool { manualAccessibilityEligible(pid:pid, bundleId:bundle, ownPid:100, parentPid:200, protectedApps:protected) }
    check(eligible(500, "com.tinyspeck.slackmacgap") && eligible(501, "com.hnc.Discord") && eligible(502, "notion.id"), "Electron apps get their accessibility tree switched on")
    check(eligible(503, "com.spotify.client") && eligible(504, "com.apple.finder") && eligible(505, ""), "apps that reject the attribute may still be attempted harmlessly")
    check(!eligible(200, "com.github.Electron") && !eligible(100, "") && !eligible(506, "ai.coarena.openassist"), "Open Assist and this helper are never switched")
    check(!eligible(0, "com.tinyspeck.slackmacgap") && !eligible(-1, "com.tinyspeck.slackmacgap"), "invalid pids are never switched")
    check(!eligible(507, "com.1password.1password") && !eligible(508, "com.bitwarden.desktop"), "protected Electron apps are never switched")
    check(!eligible(509, "com.microsoft.VSCode") && !eligible(510, "com.microsoft.VSCodeInsiders") && !eligible(511, "com.vscodium") && !eligible(512, "com.todesktop.230313mzl4w4u92"), "screen-reader-detecting editors are never switched")

    var attempts = ManualAccessibilityAttempts()
    check(attempts.claim(pid:500, launchedAt:1000), "first sight of a process is attempted")
    check(!attempts.claim(pid:500, launchedAt:1000), "the same process is attempted once")
    check(attempts.claim(pid:500, launchedAt:2000), "a reused pid with a new launch is a new process")
    check(attempts.claim(pid:501, launchedAt:nil) && !attempts.claim(pid:501, launchedAt:nil), "processes without a launch date are attempted once")
    for pid in 1000..<1400 { _ = attempts.claim(pid:pid_t(pid), launchedAt:nil) }
    check(attempts.seen.count <= ManualAccessibilityAttempts.limit, "attempted processes are bounded")
}
