import Foundation
import CoreGraphics

// Pure checks for the observe stream (Observer.swift): what `observe`
// accepts, the exclusion rules and what an excluded frame carries, the
// redaction of titles, labels and digests, each tier's fields and what it
// never carries, the cadence, the byte caps, and the owner's input as
// content-free actions (presses, chords, typing bursts, wheel, switches,
// menu paths).
func observerChecks(_ check: (Bool, String) -> Void) {
    // Options.
    check(ObserveOptions(command: ["on": true])?.tier == .structure && ObserveOptions(command: ["on": true])?.everyMs == 20_000, "observe defaults to tier structure every 20 s")
    check(ObserveOptions(command: ["on": true, "tier": "pixels", "everyMs": 5000]) == ObserveOptions(command: ["on": true, "tier": "pixels", "everyMs": 5000.0]), "tier and cadence are read, as int or double")
    check(ObserveOptions(command: ["on": true, "everyMs": 10])?.everyMs == 1000 && ObserveOptions(command: ["on": true, "everyMs": 10_000_000])?.everyMs == 600_000, "the cadence is clamped to a second and ten minutes")
    check(ObserveOptions(command: ["on": true, "everyMs": Double.nan])?.everyMs == 20_000 && ObserveOptions(command: ["on": true, "everyMs": "soon"])?.everyMs == 20_000, "an unusable cadence is the default")
    check(ObserveOptions(command: ["on": false])?.on == false, "off is read")
    check(ObserveOptions(command: ["tier": "text"]) == nil && ObserveOptions(command: ["on": "yes"]) == nil, "on must be a flag")
    check(ObserveOptions(command: ["on": true, "tier": "everything"]) == nil && ObserveOptions(command: ["on": true, "tier": 2]) == nil, "an unknown tier is refused")
    check(ObserveTier.structure < .text && .text < .pixels, "tiers order structure, text, pixels")

    // Exclusions, in precedence order.
    func exclusion(secure: Bool = false, protected: Bool = false, locked: Bool = false, ownRun: Bool = false, idle: Double = 0) -> ObserveExclusion? {
        observeExclusion(secureInput: secure, protected: protected, locked: locked, ownRun: ownRun, idleSeconds: idle)
    }
    check(exclusion() == nil, "an active owner in an ordinary window is not excluded")
    check(exclusion(secure: true, protected: true, locked: true, ownRun: true, idle: 100) == .locked, "the lock screen comes first")
    check(exclusion(secure: true, protected: true, ownRun: true, idle: 100) == .ownRun, "Butler's own run comes before idle")
    check(exclusion(secure: true, protected: true, idle: 61) == .idle && exclusion(idle: 60) == nil, "idle is unmarked input older than 60 s, strictly")
    check(exclusion(secure: true, protected: true) == .secureInput, "secure input comes before a protected surface")
    check(exclusion(protected: true) == .protected, "a protected surface is excluded")
    check(Set(ObserveExclusion.allCases.map { $0.rawValue }) == ["secure_input", "protected", "locked", "own_run", "idle"], "the exclusion codes are exactly the design's five")
    check(observeTransitionStates == [.locked, .ownRun, .idle], "the lock screen, an own run and idle are said once and read nothing")

    // Redaction: the credential shapes are replaced, prose is kept, the cut comes after.
    check(redactSecrets("Login — Acme") == "Login — Acme", "a plain title is untouched")
    check(redactSecrets("password: hunter2!x") == observeSecretPlaceholder, "a password assignment is redacted")
    check(redactSecrets("Password: Tap") == "Password: Tap" && redactSecrets("password: enabled") == "password: enabled", "a UI word after password stays prose")
    check(redactSecrets("Authorization: Bearer abc123def456ghi and more") == "Authorization: [Sensitive text omitted] and more", "a bearer token is redacted and the rest kept")
    check(redactSecrets("the bearer of this letter") == "the bearer of this letter", "the word bearer in prose is not a token")
    check(redactSecrets("token eyJhbGciOi.eyJzdWIi.SflKxwRJ here") == "token [Sensitive text omitted] here", "a JWT is redacted")
    check(redactSecrets("key sk-abcdefghijklmnop") == "key [Sensitive text omitted]" && redactSecrets("AKIAABCDEFGHIJKLMNOP x") == "[Sensitive text omitted] x", "API keys are redacted")
    check(redactSecrets("otp = 123456") == observeSecretPlaceholder && redactSecrets("OTP = optional") == "OTP = optional", "a one-time code is redacted, the word optional is not")
    check(redactSecrets("-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----") == observeSecretPlaceholder, "a private key block is redacted")
    check(redactSecrets("-----BEGIN PRIVATE KEY-----\nabc") == observeSecretPlaceholder, "an unterminated private key block is redacted to the end")
    check(redactSecrets("password: hunter2!x password: hunter2!x") == observeSecretPlaceholder + " " + observeSecretPlaceholder, "every span is replaced")
    check(carriesSecret("password: hunter2!x") && !carriesSecret("Notes — Groceries"), "carriesSecret says whether any shape is there")
    check(observeText("  password: hunter2!x — Safari  ", limit: 120) == observeSecretPlaceholder + " — Safari", "a title is redacted then trimmed")
    let long = String(repeating: "é", count: 200)
    check(observeText(long, limit: 120).utf16.count == 120 && observeText(long, limit: 120).allSatisfy { $0 == "é" }, "a title is bounded by UTF-16 units without splitting a grapheme")
    check(observeText("family 👨‍👩‍👧 " + String(repeating: "x", count: 200), limit: 15) == "family 👨‍👩‍👧", "a bound never splits an emoji sequence")
    check(observeText("family 👨‍👩‍👧 " + String(repeating: "x", count: 200), limit: 12) == "family", "a bound that lands before a sequence leaves it out whole, and no trailing space")
    let secretTail = String(repeating: "a", count: 110) + " password: hunter2!x"
    check(!observeText(secretTail, limit: 120).contains("hunter2"), "redaction runs before the cut, so a cut never leaves half a secret")
    check(observeLabel("Password", secure: true) == observeSecureFieldLabel && observeLabel("Search", secure: false) == "Search", "a secure field is named as such, never by its label")

    // Frames by exclusion and tier.
    var readings = ObserveReadings()
    readings.appId = "com.apple.Notes"; readings.appName = "Notes"; readings.windowTitle = "Groceries — password: hunter2!x"
    readings.focusedRole = "AXTextArea"; readings.focusedLabel = "Note body"
    readings.controls = (0..<70).map { ObserveControl(role: "button", label: "Button \($0) password: hunter2!x") }
    readings.visibleText = "Milk\nEggs\npassword: hunter2!x\n" + String(repeating: "t", count: 2000)
    readings.images = [Data(repeating: 1, count: 3000), Data(repeating: 2, count: 500)]
    func keys(_ frame: [String: Any]) -> Set<String> { Set(frame.keys) }
    let locked = observeFrame(readings, tier: .pixels, exclusion: .locked, atMs: 5)
    check(keys(locked) == ["event", "atMs", "excluded"] && locked["excluded"] as? String == "locked", "a locked frame carries nothing but the code")
    let idle = observeFrame(readings, tier: .pixels, exclusion: .idle, atMs: 5)
    check(keys(idle) == ["event", "atMs", "excluded"] && idle["excluded"] as? String == "idle", "an idle frame carries nothing but the code")
    let ownRun = observeFrame(readings, tier: .pixels, exclusion: .ownRun, atMs: 5)
    check(keys(ownRun) == ["event", "atMs", "excluded"] && ownRun["excluded"] as? String == "own_run", "an own_run frame carries nothing but the code; main adds the runId")
    for code in [ObserveExclusion.secureInput, .protected] {
        let frame = observeFrame(readings, tier: .pixels, exclusion: code, atMs: 5)
        check(keys(frame) == ["event", "atMs", "excluded", "appId"] && frame["appId"] as? String == "com.apple.Notes" && frame["excluded"] as? String == code.rawValue, "a \(code.rawValue) frame carries the application and the code, nothing else")
    }
    var nameless = readings; nameless.appId = ""
    check(keys(observeFrame(nameless, tier: .structure, exclusion: .protected, atMs: 5)) == ["event", "atMs", "excluded"], "a protected frame with no application id carries the code alone")
    let structure = observeFrame(readings, tier: .structure, exclusion: nil, atMs: 7)
    check(keys(structure) == ["event", "atMs", "appId", "appName", "windowTitle", "focusedRole", "focusedLabel", "controls"], "tier structure carries the application, title, focus and controls, never a digest or a picture")
    check(structure["event"] as? String == "observe_frame" && structure["atMs"] as? Int == 7 && structure["appId"] as? String == "com.apple.Notes" && structure["appName"] as? String == "Notes", "the frame names its event, time and application")
    check(structure["windowTitle"] as? String == "Groceries — " + observeSecretPlaceholder, "the window title is redacted")
    check(structure["focusedRole"] as? String == "AXTextArea" && structure["focusedLabel"] as? String == "Note body", "the focused role and label are carried")
    let controls = structure["controls"] as? [[String: String]] ?? []
    check(controls.count == 60 && controls.allSatisfy { Set($0.keys) == ["role", "label"] } && controls[0]["label"] == "Button 0 " + observeSecretPlaceholder, "controls are at most 60, role and redacted label only")
    var secureFocus = readings; secureFocus.focusedSecure = true
    check(observeFrame(secureFocus, tier: .structure, exclusion: nil, atMs: 1)["focusedLabel"] as? String == observeSecureFieldLabel, "a secure field with focus is labelled as such")
    var bare = ObserveReadings(); bare.appId = "com.apple.finder"
    let bareFrame = observeFrame(bare, tier: .pixels, exclusion: nil, atMs: 1)
    check(keys(bareFrame) == ["event", "atMs", "appId", "controls"] && (bareFrame["controls"] as? [[String: String]])?.isEmpty == true, "empty readings leave their fields out, controls stays a list")
    check(observeFrame(ObserveReadings(), tier: .structure, exclusion: nil, atMs: 1)["appId"] as? String == "unknown", "no application id reads as unknown")
    let text = observeFrame(readings, tier: .text, exclusion: nil, atMs: 7)
    let digest = text["textDigest"] as? String ?? ""
    check(text["image"] == nil && digest.hasPrefix("Milk\nEggs\n" + observeSecretPlaceholder) && digest.utf16.count == observeTextLimit, "tier text adds the redacted digest, at most 1 500 units, and no picture")
    let pixels = observeFrame(readings, tier: .pixels, exclusion: nil, atMs: 7)
    check(pixels["image"] as? String == Data(repeating: 1, count: 3000).base64EncodedString() && pixels["textDigest"] != nil, "tier pixels adds the largest picture that fits as base64, beside the digest")
    var page = readings; page.browser = true; page.host = nil
    check(observeFrame(page, tier: .pixels, exclusion: nil, atMs: 7)["image"] == nil && observeFrame(page, tier: .pixels, exclusion: nil, atMs: 7)["host"] == nil, "a browser page whose host is unknown gets no picture")
    page.host = "docs.example.com"
    check(observeFrame(page, tier: .pixels, exclusion: nil, atMs: 7)["image"] != nil && observeFrame(page, tier: .pixels, exclusion: nil, atMs: 7)["host"] as? String == "docs.example.com", "a browser page with a host gets its picture and names the host")
    check(observeImageAllowed(browser: false, host: nil) && !observeImageAllowed(browser: true, host: "") && observeImageAllowed(browser: true, host: "a.b"), "the picture rule: never a hostless browser page")
    var heavy = readings; heavy.images = [Data(repeating: 1, count: 30_000), Data(repeating: 2, count: 12_000), Data(repeating: 3, count: 100)]
    let fitted = observeFrame(heavy, tier: .pixels, exclusion: nil, atMs: 7)
    check(fitted["image"] as? String == Data(repeating: 2, count: 12_000).base64EncodedString() && observeBytes(fitted) <= observeFrameMaxBytes, "the picture is the largest rendition that keeps the frame under 24 KB")
    heavy.images = [Data(repeating: 1, count: 30_000)]
    check(observeFrame(heavy, tier: .pixels, exclusion: nil, atMs: 7)["image"] == nil, "a picture that cannot fit is left out rather than the frame dropped")
    check(observeImageFitting([Data(), Data(repeating: 9, count: 30)], frameBytes: 100) == Data(repeating: 9, count: 30).base64EncodedString(), "an empty rendition is skipped")
    check(observeImageFitting([Data(repeating: 9, count: 30)], frameBytes: observeFrameMaxBytes - 20) == nil, "a rendition that would pass the cap is refused")
    check(observeSignature(appId: "a", windowTitle: "t", host: nil, focusedRole: nil) != observeSignature(appId: "a", windowTitle: "t", host: "h", focusedRole: nil), "the host is part of the change key")
    check(observeSignature(appId: "a", windowTitle: "t", host: nil, focusedRole: "AXButton") != observeSignature(appId: "a", windowTitle: "t", host: nil, focusedRole: "AXTextField"), "the focused role is part of the change key")

    // Cadence and the tracker.
    var tracker = ObserveTracker(everyMs: 20_000)
    check(tracker.decide(signature: "notes|a", exclusion: nil, now: 100) == .frame, "the first change is a frame at once")
    check(tracker.decide(signature: "notes|a", exclusion: nil, now: 101) == .nothing, "no change, no frame")
    check(tracker.decide(signature: "notes|b", exclusion: nil, now: 105) == .nothing, "a change inside the window waits")
    check(tracker.decide(signature: "notes|b", exclusion: nil, now: 119.9) == .nothing, "still inside the window")
    check(tracker.decide(signature: "notes|c", exclusion: nil, now: 120) == .frame, "the pending change goes out when the window opens, with what is there then")
    check(tracker.decide(signature: "notes|c", exclusion: .secureInput, now: 141) == .frame, "secure input taking over the same window is a change")
    check(tracker.decide(signature: "notes|c", exclusion: nil, now: 162) == .frame, "secure input ending is a change")
    check(tracker.decide(signature: "notes|c", exclusion: .idle, now: 163) == .transition(.idle), "entering idle is said once, outside the cadence")
    check(tracker.decide(signature: "", exclusion: .idle, now: 170) == .nothing && tracker.decide(signature: "", exclusion: .idle, now: 400) == .nothing, "nothing follows while idle lasts")
    check(tracker.decide(signature: "notes|c", exclusion: nil, now: 401) == .frame, "coming back from idle is a change, whatever the window shows")
    check(tracker.decide(signature: "notes|c", exclusion: .locked, now: 402) == .transition(.locked) && tracker.decide(signature: "", exclusion: .locked, now: 403) == .nothing, "the lock screen is said once")
    check(tracker.decide(signature: "", exclusion: .ownRun, now: 404) == .transition(.ownRun) && tracker.decide(signature: "", exclusion: .ownRun, now: 405) == .nothing, "an own run is said once as the state changes, then nothing")
    check(tracker.decide(signature: "", exclusion: .idle, now: 406) == .transition(.idle), "each transition state is its own announcement")
    var quick = ObserveTracker(everyMs: 1000)
    check(quick.decide(signature: "a", exclusion: nil, now: 0) == .frame && quick.decide(signature: "b", exclusion: nil, now: 0.5) == .nothing && quick.decide(signature: "b", exclusion: nil, now: 1) == .frame, "the cadence is everyMs")
    check(ObserveCadence(everyMs: 5).everyMs == 1000 && ObserveCadence(everyMs: 10_000_000).everyMs == 600_000, "the cadence clamps as the options do")
    var cadence = ObserveCadence(everyMs: 2000)
    check(!cadence.due(now: 0), "nothing pending, nothing due")
    cadence.changed(); check(cadence.due(now: 0), "a change with no frame yet is due at once")
    cadence.sent(at: 0); cadence.changed()
    check(!cadence.due(now: 1.9) && cadence.due(now: 2), "a change after a frame is due when the window opens")

    // Byte caps.
    var budget = ObserveBudget()
    check(budget.admit(bytes: 24 * 1024, now: 0) == .send, "a frame of exactly 24 KB passes")
    check(budget.admit(bytes: 24 * 1024 + 1, now: 1) == .drop(.frameTooLarge, notice: 1), "a frame over 24 KB is dropped and the first notice goes out")
    check(budget.admit(bytes: 24 * 1024 + 1, now: 2) == .drop(.frameTooLarge, notice: nil), "a second drop within the minute is counted quietly")
    check(budget.admit(bytes: 30_000, now: 61) == .drop(.frameTooLarge, notice: 2), "the next notice, a minute later, carries the drops since the last")
    budget = ObserveBudget()
    for i in 0..<8 { check(budget.admit(bytes: 24 * 1024, now: Double(i)) == .send, "frame \(i) fits the minute's 200 KB") }
    check(budget.admit(bytes: 24 * 1024, now: 9) == .drop(.minuteBudget, notice: 1), "the ninth 24 KB frame passes the minute's budget and is dropped")
    check(budget.admit(bytes: 8 * 1024, now: 10) == .send, "a smaller frame that still fits the minute passes")
    check(budget.admit(bytes: 24 * 1024, now: 60) == .send, "the next minute starts clean")
    check(budget.dropped == 1, "drops are counted")
    check(observeFrameMaxBytes == 24 * 1024 && observeMinuteBudgetBytes == 200 * 1024 && observeDroppedNoticeInterval == 60, "the caps are the design's")
    check(ObserveDropReason.frameTooLarge.rawValue == "frame_too_large" && ObserveDropReason.minuteBudget.rawValue == "minute_budget", "the drop reasons are fixed codes")

    // Presses.
    check(observePointerKind(type: .leftMouseDown, clickState: 1) == .click && observePointerKind(type: .leftMouseDown, clickState: 2) == .doubleClick, "a first press is a click, the second of a pair a double click")
    check(observePointerKind(type: .leftMouseDown, clickState: 3) == nil, "a third press is a selection gesture, not another action")
    check(observePointerKind(type: .rightMouseDown, clickState: 1) == .rightClick && observePointerKind(type: .otherMouseDown, clickState: 1) == .click, "right and other buttons")
    check(observePointerKind(type: .mouseMoved, clickState: 0) == nil && observePointerKind(type: .leftMouseDragged, clickState: 1) == nil && observePointerKind(type: .leftMouseUp, clickState: 1) == nil, "moves, drags and releases are not presses")
    func press(_ kind: ObservePointer, at: TimeInterval, app: String = "com.apple.Notes", dock: Bool = false, label: String = "Save") -> ObservePress {
        ObservePress(kind: kind, appId: app, target: ObserveControl(role: "AXButton", label: label), dock: dock, at: at, atMs: Int((at * 1000).rounded()))
    }
    var presses = ObservePressCoalescer()
    check(presses.press(press(.click, at: 10)) == nil && presses.flush(now: 10.2) == nil, "a click is held for the pair")
    check(presses.press(press(.doubleClick, at: 10.3)) == nil, "the second press folds the first in")
    let double = presses.flush(now: 10.3)
    check(double?.kind == .doubleClick && presses.flush(now: 20) == nil, "the double click goes out at once and nothing else does")
    let doubleEvent = double!.event
    check(doubleEvent["kind"] as? String == "double_click" && doubleEvent["event"] as? String == "observe_action" && doubleEvent["appId"] as? String == "com.apple.Notes" && doubleEvent["atMs"] as? Int == 10300 && (doubleEvent["target"] as? [String: String]) == ["role": "AXButton", "label": "Save"], "the action names its kind, time, application and hit-tested target")
    check(presses.press(press(.click, at: 20)) == nil && presses.flush(now: 20.4) == nil && presses.flush(now: 20.5)?.kind == .click, "a click alone goes out after the hold")
    check(presses.press(press(.click, at: 30)) == nil && presses.press(press(.click, at: 30.2, label: "Cancel"))?.target?.label == "Save", "a second click on something else sends the first")
    check(presses.press(press(.doubleClick, at: 31))?.target?.label == "Cancel", "a double click too late to pair sends the held click and stands alone")
    check(presses.flush(now: 31)?.kind == .doubleClick, "and goes out at once")
    check(presses.press(press(.rightClick, at: 40)) == nil && presses.flush(now: 40)?.kind == .rightClick, "a right click goes out at once")
    check(presses.press(press(.click, at: 50, app: "com.apple.dock", dock: true, label: "Slack")) == nil && presses.flush(now: 51.4) == nil, "a Dock press is held for the activation")
    check(presses.takeDockPress(now: 51.5)?.target?.label == "Slack" && presses.flush(now: 60) == nil, "the activation consumes the Dock press")
    check(presses.press(press(.click, at: 70, app: "com.apple.dock", dock: true)) == nil && presses.takeDockPress(now: 71.6) == nil && presses.flush(now: 71.6)?.kind == .click, "a Dock press nothing follows within 1.5 s is a click")
    check(presses.press(press(.click, at: 80)) == nil && presses.takeDockPress(now: 80) == nil, "an ordinary press is never taken as a Dock press")
    check(presses.flush(now: 80, force: true)?.kind == .click && presses.flush(now: 80, force: true) == nil, "a forced flush sends what is held")
    check(observeDoubleClickHold == 0.45 && observeDockHold == 1.5, "the holds are 0.45 s for a pair and 1.5 s for the Dock")

    // Keys.
    check(observeKey(keyCode: 1, flags: .maskCommand, layoutName: "s") == .chord("CMD+S"), "Command with a letter is a chord named by the layout, uppercased")
    check(observeKey(keyCode: 1, flags: [.maskCommand, .maskShift], layoutName: "s") == .chord("CMD+SHIFT+S"), "modifiers are named CMD, CTRL, ALT, SHIFT in that order")
    check(observeKey(keyCode: 117, flags: [.maskControl, .maskAlternate], layoutName: nil) == .chord("CTRL+ALT+DELETE"), "a command key with modifiers is named by its own name")
    check(observeKey(keyCode: 1, flags: .maskAlternate, layoutName: "ß") == .chord("ALT+S"), "a layout character that is not plain ASCII falls back to the US position")
    check(observeKey(keyCode: 200, flags: .maskCommand, layoutName: nil) == .chord("CMD+KEY"), "an unknown position with a modifier is still a chord, unnamed")
    check(observeKey(keyCode: 43, flags: .maskCommand, layoutName: ",") == .chord("CMD+,"), "punctuation names itself")
    check(observeKey(keyCode: 36, flags: [], layoutName: nil) == .chord("RETURN") && observeKey(keyCode: 48, flags: [], layoutName: nil) == .chord("TAB") && observeKey(keyCode: 53, flags: [], layoutName: nil) == .chord("ESC"), "Return, Tab and Escape alone are chords")
    check(observeKey(keyCode: 125, flags: .maskShift, layoutName: nil) == .chord("SHIFT+DOWN") && observeKey(keyCode: 122, flags: [], layoutName: nil) == .chord("F1"), "arrows and function keys alone are chords, with Shift when held")
    check(observeKey(keyCode: 0, flags: [], layoutName: nil) == .character && observeKey(keyCode: 0, flags: .maskShift, layoutName: "A") == .character, "a character key alone, or with Shift, is typing and is never named")
    check(observeKey(keyCode: 49, flags: [], layoutName: nil) == .character && observeKey(keyCode: 51, flags: [], layoutName: nil) == .character && observeKey(keyCode: 47, flags: [], layoutName: nil) == .character, "space, backspace and punctuation alone are typing")
    check(observeKey(keyCode: 55, flags: .maskCommand, layoutName: nil) == .ignored && observeKey(keyCode: 63, flags: [], layoutName: nil) == .ignored && observeKey(keyCode: 57, flags: [], layoutName: nil) == .ignored, "a modifier alone, fn and caps lock are nothing")
    check(observeKeyName(keyCode: 1, layoutName: " ") == "S" && observeKeyName(keyCode: 1, layoutName: "ab") == "S" && observeKeyName(keyCode: 1, layoutName: nil) == "S", "a blank, a multi-character or a missing layout name falls back to the position")
    check(observeSwitchChords == ["CMD+TAB", "CMD+SHIFT+TAB"], "the switch chords are CMD+TAB either way")
    var witness = ObserveSwitchWitness()
    check(!witness.saw(chord: "CMD+S", at: 0) && witness.cause(now: 0.5) == nil, "an ordinary chord is not a switch")
    check(witness.saw(chord: "CMD+TAB", at: 10) && witness.cause(now: 11.5) == "CMD+TAB" && witness.cause(now: 11.6) == nil, "CMD+TAB explains an activation within 1.5 s")
    witness.reset(); check(witness.cause(now: 10.1) == nil, "a consumed witness explains nothing")

    // Typing bursts: counts and a label, never a character.
    var typing = ObserveTypingAggregator()
    check(typing.key(appId: "com.apple.Notes", field: "Note body", at: 0, atMs: 1000) == nil, "the first key opens a burst")
    for i in 1...9 { check(typing.key(appId: "com.apple.Notes", field: "Note body", at: Double(i) * 0.2, atMs: 1000 + i * 200) == nil, "key \(i) joins the burst") }
    check(typing.flush(now: 3.29) == nil, "no burst goes out before 1.5 s of quiet")
    let burst = typing.flush(now: 3.31)
    check(burst?.chars == 10 && burst?.field == "Note body" && burst?.appId == "com.apple.Notes", "1.5 s of quiet ends the burst with its count")
    let typed = burst!.event
    check(typed["kind"] as? String == "typing" && typed["atMs"] as? Int == 1000 && (typed["typed"] as? [String: Any])?["chars"] as? Int == 10 && (typed["typed"] as? [String: Any])?["ms"] as? Int == 1800 && (typed["typed"] as? [String: Any])?["field"] as? String == "Note body", "the typing action carries the field, a count and a duration, at the burst's start")
    check(Set(typed.keys) == ["event", "atMs", "appId", "kind", "typed"] && Set((typed["typed"] as? [String: Any] ?? [:]).keys) == ["field", "chars", "ms"], "and nothing else")
    check(typing.key(appId: "com.apple.Notes", field: "Note body", at: 10, atMs: 0) == nil, "a new burst opens")
    let moved = typing.key(appId: "com.apple.Notes", field: "Title", at: 10.2, atMs: 0)
    check(moved?.chars == 1 && moved?.field == "Note body", "the focus moving to another field ends the burst")
    let switched = typing.key(appId: "com.apple.Safari", field: "Title", at: 10.4, atMs: 0)
    check(switched?.appId == "com.apple.Notes" && switched?.chars == 1, "another application ends the burst")
    check(typing.key(appId: "com.apple.Safari", field: "Title", at: 12.0, atMs: 0)?.chars == 1, "a key after a 1.5 s gap ends the burst even in the same field")
    check(typing.flush(now: 12.1, force: true)?.chars == 1 && typing.flush(now: 100, force: true) == nil, "a forced flush sends the open burst once")
    check(observeTypingGap == 1.5 && observeTypingMaxChars == 10_000, "a burst ends after 1.5 s and counts at most 10 000")

    // Wheel: ticks per second per direction.
    var scroll = ObserveScrollAggregator()
    check(scroll.wheel(appId: "com.apple.Safari", delta: -3, at: 0, atMs: 500) == nil && scroll.wheel(appId: "com.apple.Safari", delta: -1, at: 0.3, atMs: 800) == nil, "wheel movements down join one burst")
    check(scroll.wheel(appId: "com.apple.Safari", delta: 0, at: 0.4, atMs: 900) == nil && scroll.flush(now: 0.5) == nil, "a wheel event without movement is nothing")
    let down = scroll.wheel(appId: "com.apple.Safari", delta: 2, at: 0.6, atMs: 1100)
    check(down?.direction == "down" && down?.ticks == 2, "a change of direction ends the burst")
    let event = down!.event
    check(event["kind"] as? String == "scroll" && (event["scroll"] as? [String: Any])?["direction"] as? String == "down" && (event["scroll"] as? [String: Any])?["ticks"] as? Int == 2 && event["atMs"] as? Int == 500, "the scroll action carries a direction and ticks, at the burst's start")
    check(scroll.flush(now: 1.5) == nil && scroll.flush(now: 1.6)?.direction == "up", "a second's window ends the burst")
    for i in 0..<5 { _ = scroll.wheel(appId: "com.apple.Safari", delta: -1, at: 10 + Double(i) * 0.1, atMs: 0) }
    check(scroll.flush(now: 10.9) == nil && scroll.flush(now: 11.0)?.ticks == 5, "ticks count the wheel events with movement in the second")
    _ = scroll.wheel(appId: "com.apple.Safari", delta: -1, at: 20, atMs: 0)
    check(scroll.wheel(appId: "com.apple.Notes", delta: -1, at: 20.1, atMs: 0)?.appId == "com.apple.Safari", "another application ends the burst")
    check(scroll.flush(now: 20.2, force: true)?.appId == "com.apple.Notes", "a forced flush sends the open burst")
    _ = scroll.wheel(appId: "com.apple.Notes", delta: -1, at: 30, atMs: 0)
    check(scroll.flush(now: 30.99) == nil && scroll.flush(now: 31)?.ticks == 1, "a wheel that has gone quiet for a second goes out")
    check(observeScrollWindow == 1.0, "a scroll burst is one second")

    // Menu paths.
    let picked = [ObserveAncestor(role: "AXMenuItem", title: "Export as PDF…"), ObserveAncestor(role: "AXMenu", title: ""), ObserveAncestor(role: "AXMenuItem", title: "Export"),
                  ObserveAncestor(role: "AXMenu", title: ""), ObserveAncestor(role: "AXMenuBarItem", title: "File"), ObserveAncestor(role: "AXMenuBar", title: ""), ObserveAncestor(role: "AXApplication", title: "Notes")]
    check(observeMenuPath(picked) == ["File", "Export", "Export as PDF…"], "a menu pick reads as the path from the menu bar to the item")
    check(observeMenuPath([ObserveAncestor(role: "AXMenuItem", title: "Copy"), ObserveAncestor(role: "AXMenu", title: ""), ObserveAncestor(role: "AXWindow", title: "Doc")]) == ["Copy"], "a context menu's pick is the item alone")
    check(observeMenuPath([ObserveAncestor(role: "AXButton", title: "File"), ObserveAncestor(role: "AXMenuBarItem", title: "File")]) == nil, "a press that is not on a menu item is no menu pick")
    check(observeMenuPath([ObserveAncestor(role: "AXMenuItem", title: "password: hunter2!x")]) == [observeSecretPlaceholder], "menu titles are redacted")
    check(observeMenuPath([ObserveAncestor(role: "AXMenuItem", title: "")]) == nil, "an unnamed item yields no path")
    let deep = (0..<10).map { ObserveAncestor(role: "AXMenuItem", title: "Level \($0)") }
    check(observeMenuPath(deep)?.count == observeMenuDepth && observeMenuPath(deep)?.last == "Level 0", "a path is at most six deep, ending at the item")

    // Actions never carry more than their own fields.
    let chord = observeAction(kind: "key_chord", appId: "com.apple.Notes", atMs: 5, fields: ["chord": "CMD+S"])
    check(Set(chord.keys) == ["event", "atMs", "appId", "kind", "chord"] && chord["event"] as? String == "observe_action", "a chord action carries the chord beside the common fields")
}
