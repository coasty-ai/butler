import Foundation

// Background words never leave the voice process. A wake phrase must start an
// utterance; mentioning it inside a sentence cannot turn that sentence into a task.
func commandAfterWakePhrase(_ text: String) -> String? {
    let expression = try! NSRegularExpression(pattern: #"^\s*hey[\s,]+(?:open\s+)?assist\b[\s,.:;!?—-]*"#, options: .caseInsensitive)
    let range = NSRange(text.startIndex..., in: text)
    guard let match = expression.firstMatch(in: text, range: range),
          let end = Range(match.range, in: text)?.upperBound else { return nil }
    return String(text[end...]).trimmingCharacters(in: .whitespacesAndNewlines)
}

// Once the wake phrase has opened a command window, the recognizer may report
// a new speech segment without repeating that prefix. Keep that command.
// Only call this inside an already activated hands-free session.
func activatedVoiceCommand(_ text: String) -> String {
    commandAfterWakePhrase(text) ?? text.trimmingCharacters(in: .whitespacesAndNewlines)
}

enum VoiceFinalResult: Equatable {
    case recognized(String)
    case recovered(String)
    case missing
}

func retainVoiceHypothesis(previous: String, update: String) -> String {
    update.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? previous : update
}

// Apple's on-device recognizer may send a nonempty correction followed by an
// empty isFinal result after endAudio(). That terminal marker must not erase
// the utterance. Recovery is allowed only after push-to-talk release or our
// silence endpoint, never for an arbitrary partial/background utterance.
func resolveVoiceFinal(command: String, latest: String, released: Bool) -> VoiceFinalResult {
    let clean = command.trimmingCharacters(in: .whitespacesAndNewlines)
    if !clean.isEmpty { return .recognized(clean) }
    let retained = latest.trimmingCharacters(in: .whitespacesAndNewlines)
    if released && !retained.isEmpty { return .recovered(retained) }
    return .missing
}

enum VoiceEndpoint: Equatable { case none, recycle, finish, empty }

// Standby only rotates its recognizer periodically, deferred while speech is still
// arriving, so ambient sound never makes the recognizer deaf mid-wake-phrase.
// Command turns end through turnEndpoint (TurnPolicy.swift).
func standbyEndpoint(now: TimeInterval, started: TimeInterval, lastText: TimeInterval) -> VoiceEndpoint {
    now - started >= 45 && !(lastText > started && now - lastText < 1.5) ? .recycle : .none
}

func commandLooksIncomplete(_ text: String) -> Bool {
    utteranceCompleteness(text, context: .command) == .incomplete
}

// A consumed Option+Space keeps swallowing Space (autorepeat and the trailing keyUp,
// whatever modifiers remain) until the physical keyUp, so nothing leaks to the app.
// A fresh (non-autorepeat) Space keyDown proves that keyUp was missed (for example
// secure input hid it from the tap); it is a new press and must not be eaten.
func shouldSwallowSpace(keyCode: Int64, consumed: Bool, isKeyUp: Bool, autorepeat: Bool) -> Bool {
    consumed && keyCode == 49 && (isKeyUp || autorepeat)
}

// Lowercase, drop punctuation, collapse whitespace.
func normalizeVoicePhrase(_ text: String) -> String {
    let lowered = text.lowercased().replacingOccurrences(of: #"[^\p{L}\p{N}\s']"#, with: " ", options: .regularExpression)
    return lowered.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

// Bounded stop/pause utterances only, on the same key and with the same patterns as
// voiceIntent in src/voice/turns.ts (STOP_UTTERANCE, STOP_PHRASES, STOP_WORDS,
// PAUSE_UTTERANCE). Used after an explicit endpoint when the recognizer produced no
// usable final, so a spoken "Stop" is never turned into an error that resumes the run,
// and to keep stop/pause endpoints short.
private let stopUtterance = #"^(?:please )?(?:stop|cancel)(?: (?:it|that|this|now|please|everything|the task|right now|stop|cancel))*$"#
// "hold up", "just a sec" and "give me a second" are heads, so they combine like the others
// ("please hold up", "hold up wait", "just a sec wait").
private let pauseHead = "wait(?: a (?:sec|second|minute))?|pause|hold on|hold up|hang on|one moment|one sec|one second|just a moment|just a sec|give me a second"
private let pauseFiller = "please|now|wait|a sec|a second|a minute|a moment|for me"
private let pauseUtterance = "^(?:no )?(?:please )?(?:\(pauseHead))(?: (?:\(pauseHead)|\(pauseFiller)))*$"
private let stopKeys: Set<String> = ["never mind", "nevermind", "forget it", "cancel task", "abort"]
private let stopTokens: Set<String> = ["stop", "cancel", "wait", "no", "it", "that", "this", "now", "everything", "right", "please"]
func isControlPhrase(_ text: String) -> Bool {
    let key = normalizeVoiceKey(text)
    guard !key.isEmpty else { return false }
    let tokens = key.split(separator: " ").map(String.init)
    if key.range(of: stopUtterance, options: .regularExpression) != nil || stopKeys.contains(key) { return true }
    if tokens.count <= 4 && tokens.contains(where: { $0 == "stop" || $0 == "cancel" }) && tokens.allSatisfy({ stopTokens.contains($0) }) {
        return true
    }
    return key.range(of: pauseUtterance, options: .regularExpression) != nil
}

// The input-stop latch is only ever sent to our own controller helper, never to a
// recycled pid that now belongs to an unrelated process.
func validControllerPath(_ path: String) -> Bool {
    !path.isEmpty && (path as NSString).lastPathComponent == "coarena-controller"
}

// A key event's own time on the systemUptime clock. Hold length is measured from event times
// because the microphone now starts at key-down, which can keep the main thread (and so the
// tap callback for the key-up) busy for a few hundred ms; a quick tap must stay a tap.
// CGEvent timestamps are nanoseconds since boot, or mach ticks on some Apple Silicon
// builds: accept whichever lands near now, otherwise fall back to the callback time.
func eventUptime(timestamp: UInt64, now: TimeInterval, numer: UInt32, denom: UInt32) -> TimeInterval? {
    guard timestamp > 0, denom > 0 else { return nil }
    let nanoseconds = Double(timestamp) / 1e9
    if abs(nanoseconds - now) < 2 { return nanoseconds }
    let ticks = Double(timestamp) * Double(numer) / Double(denom) / 1e9
    if abs(ticks - now) < 2 { return ticks }
    return nil
}

enum ShortcutRelease: Equatable { case tap, end, ignore }
// Every shortcut_down must be followed by an event Electron can act on. A hold whose
// push-to-talk audio never started is a tap; one whose start already failed reported
// voice_error, and one whose audio already ended reported its own result.
func shortcutRelease(heldFor: TimeInterval, audioAttempted: Bool, pushToTalkActive: Bool) -> ShortcutRelease {
    if heldFor < 0.16 || !audioAttempted { return .tap }
    return pushToTalkActive ? .end : .ignore
}

// Output is written off the main thread; level meters are the first thing dropped
// when Electron stops draining stdout. Speech, window and transcript events never are.
func shouldDropOutput(event: String?, pending: Int) -> Bool { event == "audio_level" && pending > 20 }
