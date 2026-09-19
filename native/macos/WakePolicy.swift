import Foundation

// MARK: - The wake phrase: "Hey Butler"
//
// The product is written Butler and its wake phrase is "Hey Butler" (BUT-ler), but people read
// Butler aloud three ways: BUT-ler, EYE-sah and the letters Butler. The matcher accepts every
// spelling a recognizer wrote for any of the three in the speech test, and nothing more
// (.data/names/butler-speech.log §4, §6; tests/fixtures/voice-phrases.json "wake" pins them
// for native and TypeScript alike). "Butler" has the shape of "is a", "ice a", "eyes a" and
// "easy": biased toward the name, a recognizer writes "Hey, is a table free?" as "Hey Butler
// table free?". So the name counts only when a pause (punctuation, or a hesitation such
// as "um"), the end of the utterance, a task verb or a question opener follows it.

// The name as the recognizer writes it: Butler, Butler, Butler, Butler, and the BUT-ler and
// EYE-sah spellings. Never "is a", "Lisa", "Isaac", "Aisha", "ISO", "USA" or "the Butler".
// The spelled form keeps its own final dot ("Butler"), and cannot hand it back to the gate
// as a pause: a(?:\.|(?!\.)) is a possessive "a\.?" that JavaScript can express too.
let wakeNamePattern = #"(?:butt?l[ae]r|budler|butla|batala)"#
// "Hey" run into the name ("K-Butler", "P.Butler", "Haisa"): only at the very start, and
// never followed by a mere question opener ("Pisa, can I…" was "Hey sir, can I…").
// No spelling runs "Hey" into "Butler": the fused branch never matches.
let fusedWakePattern = #"(?!)"#
let wakeHeyPattern = #"(?:hey|hay|hi|hei)"#
let wakeOpeners = ["what", "whats", "when", "where", "who", "why", "how", "can", "could", "would", "will", "please",
    "tell", "give", "i", "im", "let", "lets"]
// Control words pass the gate like task verbs: "Hey Butler stop" must never wait for a pause.
// (Every command in the speech test began with "open"; these are the ones a hands-free user
// most needs to say in one breath.)
let wakeControlWords = ["stop", "cancel", "pause", "wait", "hold", "continue", "resume", "yes", "no", "never"]
private let wakePause = #"(?:[,.:;!?—-]|(?:um|uh|uhm|umm|er|erm|hmm|hm|mm)\b)"#
private let wakeVerbs = (actionVerbs.sorted() + wakeControlWords).joined(separator: "|")
private let wakeOpenersPattern = wakeOpeners.joined(separator: "|")
private func wakeGate(openers: Bool, ended: Bool) -> String {
    let apart = ended ? #"(?=\s*(?:\#(wakePause)|$))"# : #"(?=\s*\#(wakePause))"#
    let verb = #"(?=\s+(?:\#(wakeVerbs))\b)"#
    // A question opener, or the wake phrase said again ("Hey Butler hey Butler open Safari").
    let opener = #"(?=\s+(?:\#(wakeOpenersPattern))\b|\s+\#(wakeHeyPattern)[\s,]+\#(wakeNamePattern)(?![a-z]))"#
    return "(?:" + apart + "|" + verb + (openers ? "|" + opener : "") + ")"
}
private func wakeRegex(_ pattern: String) -> NSRegularExpression {
    try! NSRegularExpression(pattern: pattern, options: .caseInsensitive)
}
private func activation(ended: Bool) -> NSRegularExpression {
    wakeRegex(#"^\s*(?:\#(wakeHeyPattern)[\s,]+\#(wakeNamePattern)(?![a-z])\#(wakeGate(openers: true, ended: ended))|\#(fusedWakePattern)(?![a-z])\#(wakeGate(openers: false, ended: ended)))[\s,.:;!?—-]*"#)
}
private let endedActivation = activation(ended: true)
private let liveActivation = activation(ended: false)
private let wakePrefix = wakeRegex(#"^\s*(?:\#(wakeHeyPattern)[\s,]+\#(wakeNamePattern)|\#(fusedWakePattern))(?![a-z])[\s,.:;!?—-]*"#)
private let wakeAlone = wakeRegex(#"^\s*(?:\#(wakeHeyPattern)[\s,]+\#(wakeNamePattern)|\#(fusedWakePattern))(?![a-z])\s*$"#)

private func textAfter(_ expression: NSRegularExpression, in text: String) -> String? {
    guard let match = expression.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
          let end = Range(match.range, in: text)?.upperBound else { return nil }
    return String(text[end...]).trimmingCharacters(in: .whitespacesAndNewlines)
}

// Background words never leave the voice process. The wake phrase must start an utterance;
// mentioning it inside a sentence cannot turn that sentence into a task. ended: the text is
// the whole utterance (a final result, or a finished segment). A live partial that stops
// right at the name is not "apart" yet: the next word may still be "table free?", so it
// waits for that word, a final, or a real pause (wakePhraseAwaitingPause).
func commandAfterWakePhrase(_ text: String, ended: Bool = true) -> String? {
    textAfter(ended ? endedActivation : liveActivation, in: text)
}

// A live partial that is the wake phrase and nothing else ("Hey Butler" said, then silence).
// The caller activates once wakePauseElapsed says the speaker really paused.
func wakePhraseAwaitingPause(_ text: String) -> Bool {
    wakeAlone.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
}

// The pause after a lone "Hey Butler": the text unchanged for 0.6 s and the room quiet for
// 0.3 s, or the text unchanged for 1.2 s whatever the noise (steady background sound must
// not hold a real wake phrase back, as in turnEndDecision).
let wakePauseStableSeconds = 0.6
let wakePauseQuietSeconds = 0.3
let wakePauseTextOnlySeconds = 1.2
func wakePauseElapsed(now: TimeInterval, lastText: TimeInterval, lastSpeech: TimeInterval) -> Bool {
    let stable = now - lastText + 1e-6, quiet = now - lastSpeech + 1e-6
    return (stable >= wakePauseStableSeconds && quiet >= wakePauseQuietSeconds) || stable >= wakePauseTextOnlySeconds
}

// Inside a turn that is already listening, a later segment that opens by addressing
// the assistant again is the user starting over: the wake phrase itself, or the bare
// name, which is how the recognizer reports a repeated "Hey Butler" at a segment start
// (live, with the old name: "…at 6 PM" then "Assist open calendar and put an event…").
// The bare name counts only when it stands apart (punctuation or nothing after it) or a
// task verb follows it, so "Butler's number is 555" and "ESA launched a satellite" are
// words. The echo spellings ("Hey sir", "I say", "I saw") never restart: they are
// ordinary speech, and only the first segment's echo strip, right after a real
// activation, may drop them. Activation from standby is not widened.
private let bareWakeName = wakeRegex(#"^\s*(?:\#(wakeNamePattern)|\#(fusedWakePattern))(?![a-z])"#)
func commandAfterWakeRestart(_ text: String) -> String? {
    if let rest = commandAfterWakePhrase(text) { return rest }
    guard let match = bareWakeName.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
          let end = Range(match.range, in: text)?.upperBound else { return nil }
    let after = text[end...].drop(while: { $0.isWhitespace })
    let rest = String(after.drop(while: { $0.isWhitespace || ",.:;!?—-".contains($0) })).trimmingCharacters(in: .whitespacesAndNewlines)
    // The letters form swallows its own final dot ("Butler"), so a dot here is a real pause.
    let apart = rest.isEmpty || after.first.map { ",.:;!?—-".contains($0) } == true
    let next = rest.split(whereSeparator: { $0.isWhitespace }).first.map { $0.lowercased().trimmingCharacters(in: .punctuationCharacters) } ?? ""
    return apart || actionVerbs.contains(next) ? rest : nil
}

// Once the wake phrase has opened a command window, the recognizer may report
// a new speech segment without repeating that prefix. Keep that command.
// Only call this inside an already activated hands-free session: the wake phrase
// already counted, so its prefix is dropped whatever follows it ("Hey Butler" and a
// pause, then "the weather in Denver").
func activatedVoiceCommand(_ text: String) -> String {
    textAfter(wakePrefix, in: text) ?? text.trimmingCharacters(in: .whitespacesAndNewlines)
}

// Recognizer bias toward the wake phrase, only while listening for it (standby and
// follow-up windows, where activation is gated). A command turn is left unbiased: biased
// toward "Butler", a recognizer writes "this is a test" as "this Butler test".
func recognizerContext(ambient: Bool) -> [String] { ambient ? ["Hey Butler"] : [] }

// Whether a recognizer result opens with the wake phrase, for diagnostics labels only.
func startsWithWakePhrase(_ text: String) -> Bool { textAfter(wakePrefix, in: text) != nil }

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
