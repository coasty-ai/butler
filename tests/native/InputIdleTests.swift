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

    // Where the hands went, for a hold in a bound window (design §3).
    check(handsInside(.pointerInside, targetFrontmost: false) && handsInside(.pointerInside, targetFrontmost: true), "a press, drag or wheel on the window leaves the hands in it whatever is in front")
    check(!handsInside(.pointerOutside, targetFrontmost: true) && !handsInside(.pointerOutside, targetFrontmost: false), "a press, drag or wheel elsewhere leaves them outside even with the target in front")
    check(handsInside(.key, targetFrontmost: true) && !handsInside(.key, targetFrontmost: false), "a key leaves them wherever the keyboard focus is now")
    check(!handsInside(nil, targetFrontmost: true) && !handsInside(nil, targetFrontmost: false), "no counted input yet reads as outside")
    idle = ManualInputEpisode()
    idle.observe(kind:.click, at:0, placement:.pointerInside)
    check(idle.placement == .pointerInside && idle.tick(now:1) == [IdleReport(idleMs:1000, kinds:["click"])], "with nothing bound the report carries no target facts")
    idle = ManualInputEpisode()
    idle.observe(kind:.click, at:0, placement:.pointerInside)
    check(idle.tick(now:1, targetFrontmost:true) == [IdleReport(idleMs:1000, kinds:["click"], target:TargetIdle(frontmost:true, lastInside:true))], "a click in the window with the target in front reports both flags true")
    idle.observe(kind:.mouseMove, at:1.5)
    check(idle.placement == .pointerInside && idle.tick(now:2.5, targetFrontmost:false) == [IdleReport(idleMs:1000, kinds:["click", "mouse_move"], target:TargetIdle(frontmost:false, lastInside:true))], "a hover moves nothing: the pointer drifting off the window is not leaving it, and a scroll or click there reads as inside while another application is in front")
    idle.observe(kind:.click, at:3, placement:.pointerOutside)
    check(idle.tick(now:4, targetFrontmost:false) == [IdleReport(idleMs:1000, kinds:["click", "mouse_move"], target:TargetIdle(frontmost:false, lastInside:false))], "the latest counted input decides: a click elsewhere takes the hands out")
    idle.observe(kind:.click, at:2.9, placement:.pointerInside)
    check(idle.tick(now:6.5, targetFrontmost:false).map { $0.target } == [TargetIdle(frontmost:false, lastInside:false), TargetIdle(frontmost:false, lastInside:false)], "an out-of-order input never moves the placement back, and frontmost is read at report time")
    check(!idle.isOpen && idle.placement == .pointerOutside, "closing the episode keeps where the hands went last")
    idle.observe(kind:.mouseMove, at:10)
    check(idle.tick(now:11, targetFrontmost:false) == [IdleReport(idleMs:1000, kinds:["mouse_move"], target:TargetIdle(frontmost:false, lastInside:false))], "a new episode of hovering reports the placement the last one left")
    idle = ManualInputEpisode()
    idle.observe(kind:.scroll, at:0, placement:.pointerInside)
    _ = idle.tick(now:3.5, targetFrontmost:false)
    idle.observe(kind:.mouseMove, at:5)
    check(idle.isOpen && idle.tick(now:6, targetFrontmost:false) == [IdleReport(idleMs:1000, kinds:["mouse_move"], target:TargetIdle(frontmost:false, lastInside:true))], "hovering after a scroll in a window behind still reads as inside: the hands have not gone anywhere else")
    idle = ManualInputEpisode()
    idle.observe(kind:.key, at:0, placement:.key)
    check(idle.tick(now:1, targetFrontmost:true) == [IdleReport(idleMs:1000, kinds:["key"], target:TargetIdle(frontmost:true, lastInside:true))], "a key with the target in front now reads as typing into it")
    check(idle.tick(now:3, targetFrontmost:false) == [IdleReport(idleMs:3000, kinds:["key"], target:TargetIdle(frontmost:false, lastInside:false))], "the same key reads as outside once the user has switched away: a Command-Tab out of the window ends the hold")
    idle = ManualInputEpisode()
    idle.observe(kind:.click, at:0)
    check(idle.tick(now:1, targetFrontmost:false) == [IdleReport(idleMs:1000, kinds:["click"], target:TargetIdle(frontmost:false, lastInside:false))], "an input observed without a placement reads as outside")

    let bound = IdleReport(idleMs:1000, kinds:["click"], target:TargetIdle(frontmost:true, lastInside:false)).event
    check(Set(bound.keys) == ["event", "idleMs", "kinds", "target"] && (bound["target"] as? [String: Bool]) == ["frontmost": true, "lastInside": false], "a bound report adds exactly the two target flags")
    if let data = try? JSONSerialization.data(withJSONObject:bound, options:[.sortedKeys]) {
        check(String(decoding:data, as:UTF8.self) == #"{"event":"user_input_idle","idleMs":1000,"kinds":["click"],"target":{"frontmost":true,"lastInside":false}}"#, "the bound report serializes with flags only, no coordinates or window titles")
    } else { check(false, "the bound report serializes") }
}

// Pure AXManualAccessibility eligibility and once-per-process checks.
func electronAccessibilityChecks(_ check: (Bool, String) -> Void) {
    let protected = ["com.1password", "com.apple.Passwords", "com.apple.keychainaccess", "com.bitwarden", "com.apple.Terminal", "com.googlecode.iterm2"]
    func eligible(_ pid: pid_t, _ bundle: String) -> Bool { manualAccessibilityEligible(pid:pid, bundleId:bundle, ownPid:100, parentPid:200, protectedApps:protected) }
    check(eligible(500, "com.tinyspeck.slackmacgap") && eligible(501, "com.hnc.Discord") && eligible(502, "notion.id"), "Electron apps get their accessibility tree switched on")
    check(eligible(503, "com.spotify.client") && eligible(504, "com.apple.finder") && eligible(505, ""), "apps that reject the attribute may still be attempted harmlessly")
    check(!eligible(200, "com.github.Electron") && !eligible(100, "") && !eligible(506, "ai.coarena.openassist"), "Butler and this helper are never switched")
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

// Pure presence report checks (InputSafety.swift): the counters main's
// presence rules read, and the wire shape they are sent in.
func presenceChecks(_ check: (Bool, String) -> Void) {
    func report(hid: Double = 5, installed: TimeInterval? = nil, manual: TimeInterval? = nil, now: TimeInterval = 100,
                screenLocked: Bool? = nil, onConsole: Bool? = nil, asleep: Bool = false, held: Bool = false) -> PresenceReport {
        presenceReport(hidIdleSeconds: hid, tapInstalledAt: installed, lastManualInputAt: manual, now: now,
                       screenLocked: screenLocked, onConsole: onConsole, displayAsleep: asleep, displayHeldAwake: held)
    }
    check(report().tapIdleSeconds == nil, "without a tap the tap idle age is unknown")
    check(report(installed: 40).tapIdleSeconds == 60, "a tap that saw no input yet counts idle from its installation")
    check(report(installed: 40, manual: 90).tapIdleSeconds == 10, "the tap idle age counts from the last manual input")
    check(report(installed: 40, manual: 30).tapIdleSeconds == 60, "manual input recorded before the tap was installed does not count")
    check(report(installed: 40, manual: 130).tapIdleSeconds == 0, "a clock that ran backwards reads as zero, never negative")
    check(report(hid: 3.5).hidIdleSeconds == 3.5, "the HID idle seconds pass through")
    check(report(hid: -2).hidIdleSeconds == 0 && report(hid: .nan).hidIdleSeconds == 0 && report(hid: .infinity).hidIdleSeconds == 0, "an unreadable HID counter reads as just active")
    check(!report().locked && !report(screenLocked: false, onConsole: true).locked, "an absent or clear session reads as unlocked and on console")
    check(report(screenLocked: true).locked, "a locked screen is locked")
    check(report(onConsole: false).locked, "a session off the console (fast user switching) counts as locked")
    check(report(screenLocked: true, onConsole: true).locked && report(screenLocked: false, onConsole: false).locked, "either flag alone locks")
    check(!report(asleep: false).displayAsleep && report(asleep: true).displayAsleep, "display sleep passes through")
    check(!report(held: false).displayHeldAwake && report(held: true).displayHeldAwake, "a display held awake passes through")
    check(report(hid: 500, held: true).hidIdleSeconds == 500 && report(hid: 500, held: true).displayHeldAwake, "a held display does not touch the idle counters: main decides what it means")

    let dictionary = report(hid: 3.5, installed: 40, manual: 90, screenLocked: true, held: true).dictionary
    check(Set(dictionary.keys) == ["hidIdleSeconds", "tapIdleSeconds", "locked", "displayAsleep", "displayHeldAwake"], "the report has exactly the five contract fields")
    check(dictionary["tapIdleSeconds"] as? Double == 10 && dictionary["hidIdleSeconds"] as? Double == 3.5 && dictionary["locked"] as? Bool == true && dictionary["displayAsleep"] as? Bool == false && dictionary["displayHeldAwake"] as? Bool == true, "the report fields carry their values")
    check(report().dictionary["tapIdleSeconds"] is NSNull, "an unknown tap idle age is sent as null, not omitted")
    if let data = try? JSONSerialization.data(withJSONObject: report(hid: 3.5).dictionary, options: [.sortedKeys]) {
        check(String(decoding: data, as: UTF8.self) == #"{"displayAsleep":false,"displayHeldAwake":false,"hidIdleSeconds":3.5,"locked":false,"tapIdleSeconds":null}"#, "the report serializes to the contract shape with no other data")
    } else { check(false, "the report serializes") }
}
