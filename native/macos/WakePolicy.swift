import Foundation

// MARK: - The wake phrase: "Hey Butler", or just "Butler"
//
// The product is written Butler and answers to "Hey Butler" or to the bare name at the start
// of an utterance (the owner, 2026-09-19: "start phrase to be hey butler or butler"); the
// "Hey" is optional, never required. The matcher accepts every spelling a recognizer wrote
// for the name in the speech test, and nothing more (.data/names/butler-speech.log §4, §6;
// tests/fixtures/voice-phrases.json "wake" pins them for native and TypeScript alike).
// Biased toward the name, a recognizer writes "Hey, is a table free?" as "Hey Butler table
// free?", and a sentence about a butler can open with the word. So the name counts only when
// a pause (punctuation, or a hesitation such as "um"), the end of the utterance, a task verb,
// a control or reply word or a question opener follows it, with or without the "Hey".

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
// The wake phrase as spoken: the name after its lead, or the name alone.
let wakePhrasePattern = #"(?:\#(wakeHeyPattern)[\s,]+)?\#(wakeNamePattern)"#
let wakeOpeners = ["what", "whats", "when", "where", "who", "why", "how", "can", "could", "would", "will", "please",
    "tell", "give", "i", "im", "let", "lets",
    // Yes/no and status questions: "Hey Butler anything on my calendar", "is Slack open",
    // "do I have meetings", "should I leave now" (live trial 2026-09-18: "anything" went unheard).
    "anything", "any", "is", "are", "am", "was", "were", "do", "does", "did", "have", "has", "should", "which", "whose"]
// Control words pass the gate like task verbs: "Hey Butler stop" must never wait for a pause.
// (Every command in the speech test began with "open"; these are the ones a hands-free user
// most needs to say in one breath.)
let wakeControlWords = ["stop", "cancel", "pause", "wait", "hold", "continue", "resume", "yes", "no", "never"]
// Replies, greetings and the words people put before a request pass the same way: "Hey Butler,
// sure go for it", "Hey Butler thanks", "Hey Butler good morning", "Hey Butler actually cancel
// that" are each one breath, and a recognizer writes no comma after the name (live trial
// 2026-09-18: "sure go for it" went unheard). None of them follows the name in a sentence
// about someone else ("Hey Butler's on the phone" still fails: no space after the name).
let wakeReplyWords = ["sure", "yeah", "yep", "yup", "ok", "okay", "alright", "fine", "right", "correct", "nah", "nope",
    "not", "do", "thanks", "thank", "hello", "hi", "good", "morning", "afternoon", "evening", "night",
    "actually", "so", "also", "one", "quick", "quickly", "just", "now"]
private let wakePause = #"(?:[,.:;!?—-]|(?:um|uh|uhm|umm|er|erm|hmm|hm|mm)\b)"#
private let wakeVerbs = (actionVerbs.sorted() + wakeControlWords + wakeReplyWords).joined(separator: "|")
private let wakeOpenersPattern = wakeOpeners.joined(separator: "|")
private func wakeGate(openers: Bool, ended: Bool) -> String {
    let apart = ended ? #"(?=\s*(?:\#(wakePause)|$))"# : #"(?=\s*\#(wakePause))"#
    let verb = #"(?=\s+(?:\#(wakeVerbs))\b)"#
    // A question opener, or the wake phrase said again ("Hey Butler hey Butler open Safari").
    let opener = #"(?=\s+(?:\#(wakeOpenersPattern))\b|\s+\#(wakePhrasePattern)(?![a-z]))"#
    return "(?:" + apart + "|" + verb + (openers ? "|" + opener : "") + ")"
}
private func wakeRegex(_ pattern: String) -> NSRegularExpression {
    try! NSRegularExpression(pattern: pattern, options: .caseInsensitive)
}
private func activation(ended: Bool) -> NSRegularExpression {
    wakeRegex(#"^\s*(?:\#(wakePhrasePattern)(?![a-z])\#(wakeGate(openers: true, ended: ended))|\#(fusedWakePattern)(?![a-z])\#(wakeGate(openers: false, ended: ended)))[\s,.:;!?—-]*"#)
}
private let endedActivation = activation(ended: true)
private let liveActivation = activation(ended: false)
private let wakePrefix = wakeRegex(#"^\s*(?:\#(wakePhrasePattern)|\#(fusedWakePattern))(?![a-z])[\s,.:;!?—-]*"#)
private let wakeAlone = wakeRegex(#"^\s*(?:\#(wakePhrasePattern)|\#(fusedWakePattern))(?![a-z])\s*$"#)

private func textAfter(_ expression: NSRegularExpression, in text: String) -> String? {
    guard let match = expression.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
          let end = Range(match.range, in: text)?.upperBound else { return nil }
    return String(text[end...]).trimmingCharacters(in: .whitespacesAndNewlines)
}

// Background words never leave the voice process. The wake phrase must start an utterance;
// mentioning it inside a sentence cannot turn that sentence into a task ("the butler did it",
// "my butler is late"). ended: the text is the whole utterance (a final result, or a finished
// segment). A live partial that stops right at the name is not "apart" yet: the next word may
// still be "table free?", so it waits for that word, a final, or a real pause
// (wakePhraseAwaitingPause). Inside a turn already listening, a later segment that opens this
// way is the user starting over (requestSegments, TurnPolicy.swift): the same test.
func commandAfterWakePhrase(_ text: String, ended: Bool = true) -> String? {
    textAfter(ended ? endedActivation : liveActivation, in: text)
}

// A live partial that is the wake phrase and nothing else ("Hey Butler", or "Butler", said,
// then silence). The caller activates once wakePauseElapsed says the speaker really paused.
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

// Apple's on-device request keeps one hypothesis running through nearby conversation, and its
// partial segments carry no real timing (10 ms each in the 2026-09-19 trace). The pause before
// a wake phrase shows in the partials' arrival instead: the text unchanged for
// standbyUtteranceGapSeconds, then more words appended. Those words begin a new utterance, and
// the wake phrase may start it, where it could never start the hypothesis.
let standbyUtteranceGapSeconds = 0.6
/// The offset in `current` at which the latest utterance begins. It moves to the end of
/// `previous` when whole new words were appended after a pause, unless the words since the
/// last boundary are "Hey" or the wake phrase itself, "Hey Butler" or the bare name (the
/// speaker, or the recognizer, paused there: live 2026-09-19, "Hey" arrived, the rest 0.8 s
/// later). A first word still being
/// spelled out ("He" then "Hey Butler") is the recognizer catching up, not a pause. A revision
/// of earlier text keeps the boundary while it still fits: a misplaced boundary can only miss.
func utteranceBoundary(previous: String, current: String, boundary: Int, gapSeconds: Double) -> Int {
    let kept = min(boundary, current.count)
    guard current.count > previous.count, current.hasPrefix(previous), !previous.isEmpty,
          gapSeconds >= standbyUtteranceGapSeconds,
          current[current.index(current.startIndex, offsetBy: previous.count)].isWhitespace else { return kept }
    let since = String(previous.dropFirst(min(boundary, previous.count)))
    if wakePhraseAwaitingPause(since) || wakeOpenerAlone(since) { return kept }
    return previous.count
}
private let openerAlone = wakeRegex(#"^\s*\#(wakeHeyPattern)[,.!?]*\s*$"#)
/// "Hey" and nothing else yet: the wake phrase may be on its way.
func wakeOpenerAlone(_ text: String) -> Bool {
    openerAlone.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
}

// Once the wake phrase has opened a command window, the recognizer may report
// a new speech segment without repeating that prefix. Keep that command.
// Only call this inside an already activated hands-free session: the wake phrase
// already counted, so its prefix is dropped whatever follows it ("Hey Butler" and a
// pause, then "the weather in Denver").
func activatedVoiceCommand(_ text: String) -> String {
    textAfter(wakePrefix, in: text) ?? text.trimmingCharacters(in: .whitespacesAndNewlines)
}

// Recognizer bias (SFSpeechRecognitionRequest.contextualStrings). Apple's documentation asks for
// brief phrases, "one or two words whenever possible", and says to "limit the total number of
// phrases to no more than 100":
// developer.apple.com/documentation/speech/sfspeechrecognitionrequest/contextualstrings
// Electron builds the vocabulary (src/voice/vocabulary.ts: the installed and most opened apps,
// Butler's own command words) and sends it through configure; it is sanitized again here, so the
// recognizer is never handed an empty, overlong, repeated or 91st phrase.
let recognizerVocabularyLimit = 90
let recognizerPhraseLimit = 40
func recognizerVocabulary(_ phrases: [String]) -> [String] {
    var seen = Set<String>(), kept = [String]()
    for phrase in phrases {
        let clean = phrase.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard !clean.isEmpty, clean.count <= recognizerPhraseLimit, seen.insert(clean.lowercased()).inserted else { continue }
        kept.append(clean)
        if kept.count == recognizerVocabularyLimit { break }
    }
    return kept
}

// While listening for the wake phrase (standby and follow-up windows, where activation is gated)
// the request is biased toward "Hey Butler" first, and toward the vocabulary as well: activateWake
// continues the standby request into the command turn rather than rotating it (the words after
// the name are already in flight), so a hands-free command is transcribed with the context its
// request began with; the 2026-09-19 voice loop's "quick calculator" was heard on such a request.
// Apple documents the strings as raising the likelihood of those phrases only; whether a bias
// toward app names costs any wake detections is for the live trial. A command turn (push-to-talk,
// or a rotation inside a turn) carries the vocabulary alone: the wake phrase is not a command
// word, and biased toward the name a recognizer once wrote "this is a test" as "this ISA test".
// The wake phrase is biased with and without its lead, since the bare name wakes too; with the
// vocabulary's 90 that is 92 phrases, within Apple's 100.
func recognizerContext(ambient: Bool, vocabulary: [String]) -> [String] { ambient ? ["Hey Butler", "Butler"] + vocabulary : vocabulary }

// Whether a recognizer result opens with the wake phrase: diagnostics labels, and the words the
// self-echo filter never drops (isSelfEcho). Activation itself keeps its gate.
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

// Standby also rotates on cadence. The on-device request keeps one hypothesis growing through
// nearby conversation, and the longer it grows the more a wake phrase inside it depends on the
// partials' timing (2026-09-19 trace: 21 segments, no activation). Past standbyRotateWords, or
// standbyRotateGrowthSeconds of text growth, without a wake phrase the request gives way to a
// fresh one that first hears the last standbyPreRollSeconds of capture (PreRollRing), so the
// words at the seam are not lost. Never while the text changed within the utterance gap: a wake
// phrase could be in flight, and words appended after that gap begin a new utterance anyway.
let standbyRotateWords = 12
let standbyRotateGrowthSeconds = 8.0
let standbyPreRollSeconds = 1.5
func standbyRotationDue(words: Int, secondsGrowing: TimeInterval, sinceLastChange: TimeInterval) -> Bool {
    sinceLastChange + 1e-6 >= standbyUtteranceGapSeconds && (words >= standbyRotateWords || secondsGrowing + 1e-6 >= standbyRotateGrowthSeconds)
}

/// The last `seconds` of capture, held in memory only (never written anywhere), so a request
/// begun mid-conversation can hear the words just spoken. Buffers arrive oldest to newest; once
/// the rest still covers `seconds`, the oldest is dropped. Draining returns them in arrival order
/// and empties the ring, so no buffer reaches a request twice.
struct PreRollRing<Buffer> {
    let seconds: Double
    private var buffers: [(buffer: Buffer, seconds: Double)] = []
    private(set) var heldSeconds = 0.0
    init(seconds: Double) { self.seconds = seconds }
    var count: Int { buffers.count }
    mutating func append(_ buffer: Buffer, seconds length: Double) {
        buffers.append((buffer, length)); heldSeconds += length
        while let oldest = buffers.first?.seconds, heldSeconds - oldest + 1e-9 >= seconds {
            buffers.removeFirst(); heldSeconds -= oldest
        }
    }
    mutating func drain() -> [Buffer] {
        let drained = buffers.map(\.buffer)
        buffers.removeAll(keepingCapacity: true); heldSeconds = 0
        return drained
    }
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

// Continuous scrolling, on the same key and patterns as scrollRequest in
// src/voice/turns.ts: "scroll down", "keep scrolling", "faster", "slower", "stop
// scrolling", "that's enough". The scroll window admits them (followUpOnset) and
// ends their turns as quickly as a stop (utteranceCompleteness in that context).
private let scrollLead = "(?:(?:can|could) you )?(?:(?:just|now) )?"
private let scrollObject = "(?: (?:it|(?:the |this )?(?:page|screen|window|list|feed|document)))?"
private let scrollUtterances = [
    "^(?:(?:no|and) )?(?:(?:stop|quit|cancel|end) (?:the )?scroll(?:ing)?|stop (?:right )?(?:there|here)|(?:thats )?enough(?: scrolling)?)(?: (?:now|for me))?$",
    "^(?:(?:scroll|go) )?(?:(?:a (?:bit|little)|much|even) )?(?:faster|quicker)$|^speed (?:it )?up$|^(?:thats |its )?too slow$",
    "^(?:(?:scroll|go) )?(?:(?:a (?:bit|little)|much|even) )?(?:slower|more slowly)$|^slow (?:it )?down$|^(?:thats |its )?too fast$|^slowly$",
    "^\(scrollLead)(?:(?:start|keep|keep on|continue) )?scroll(?:ing)?\(scrollObject)(?: (?:down|up)(?:wards?)?)?\(scrollObject)(?: (?:slowly|gently|for me|now|faster|quicker|slower|more slowly))*$",
]
func isScrollPhrase(_ text: String) -> Bool {
    let key = normalizeVoiceKey(text)
    guard !key.isEmpty else { return false }
    return scrollUtterances.contains { key.range(of: $0, options: .regularExpression) != nil }
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
