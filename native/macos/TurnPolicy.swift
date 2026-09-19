import Foundation

// Pure turn-taking, speech-output and playback policy for coarena-voice.
// Nothing here touches audio, the microphone or the recognizer, so every rule is
// unit-tested in tests/native/TurnPolicyTests.swift. The TypeScript voice language
// (src/voice/turns.ts) mirrors the text rules; tests/fixtures/voice-phrases.json pins both.

// MARK: - Endpoint timing

enum Patience: String { case quick, normal, relaxed }
enum TurnContext: String { case command, answer, approval, continuation }
enum Completeness: String { case control, shortAnswer, complete, incomplete }

struct EndpointTiming: Equatable { let stable, quiet, textOnly: Double }

// A turn ends when the merged text has been stable AND the room quiet for the
// stable/quiet pair, or when the text alone has been stable for textOnly (steady
// background sound cannot hold the turn open). Quick is 0.7x, Relaxed 1.5x of Normal;
// control phrases and short answers never wait longer.
func endpointTiming(_ completeness: Completeness, patience: Patience) -> EndpointTiming {
    switch (completeness, patience) {
    case (.control, _), (.shortAnswer, _): return EndpointTiming(stable: 0.9, quiet: 0.7, textOnly: 2.0)
    case (.complete, .quick): return EndpointTiming(stable: 1.4, quiet: 1.05, textOnly: 2.8)
    case (.complete, .normal): return EndpointTiming(stable: 2.0, quiet: 1.5, textOnly: 4.0)
    case (.complete, .relaxed): return EndpointTiming(stable: 3.0, quiet: 2.25, textOnly: 6.0)
    case (.incomplete, .quick): return EndpointTiming(stable: 2.45, quiet: 1.75, textOnly: 4.55)
    case (.incomplete, .normal): return EndpointTiming(stable: 3.5, quiet: 2.5, textOnly: 6.5)
    case (.incomplete, .relaxed): return EndpointTiming(stable: 5.25, quiet: 3.75, textOnly: 9.75)
    }
}

func emptyTurnLimit(patience: Patience) -> Double {
    switch patience {
    case .quick: return 8
    case .normal: return 10
    case .relaxed: return 12
    }
}

let maxTurnSeconds = 45.0
let pushToTalkMaxSeconds = 120.0
let finalDeadlineSeconds = 1.8
let endpointNearSeconds = 0.7
private let timingEpsilon = 1e-6

enum TurnEndReason: String { case stableQuiet = "stable_quiet", textOnly = "text_only", max, release, empty }

// The reason a hands-free command turn ends now, or nil while it should keep listening.
func turnEndDecision(now: TimeInterval, started: TimeInterval, lastSpeech: TimeInterval, lastText: TimeInterval,
                     hasText: Bool, completeness: Completeness, patience: Patience) -> TurnEndReason? {
    guard hasText else { return now - started + timingEpsilon >= emptyTurnLimit(patience: patience) ? .empty : nil }
    let timing = endpointTiming(completeness, patience: patience)
    let stable = now - lastText + timingEpsilon, quiet = now - lastSpeech + timingEpsilon
    if stable >= timing.stable && quiet >= timing.quiet { return .stableQuiet }
    if stable >= timing.textOnly { return .textOnly }
    if now - started + timingEpsilon >= maxTurnSeconds { return .max }
    return nil
}

func turnEndpoint(now: TimeInterval, started: TimeInterval, lastSpeech: TimeInterval, lastText: TimeInterval,
                  hasText: Bool, completeness: Completeness, patience: Patience) -> VoiceEndpoint {
    switch turnEndDecision(now: now, started: started, lastSpeech: lastSpeech, lastText: lastText,
                           hasText: hasText, completeness: completeness, patience: patience) {
    case .none: return .none
    case .some(.empty): return .empty
    case .some: return .finish
    }
}

// Seconds left on the stable-and-quiet path.
func endpointRemaining(now: TimeInterval, lastSpeech: TimeInterval, lastText: TimeInterval,
                       completeness: Completeness, patience: Patience) -> Double {
    let timing = endpointTiming(completeness, patience: patience)
    return max(0, max(timing.stable - (now - lastText), timing.quiet - (now - lastSpeech)))
}

// Drives the pill's closing ring: the turn is about to end unless the user keeps talking.
func endpointNear(now: TimeInterval, started: TimeInterval, lastSpeech: TimeInterval, lastText: TimeInterval,
                  hasText: Bool, completeness: Completeness, patience: Patience) -> Bool {
    guard hasText, turnEndDecision(now: now, started: started, lastSpeech: lastSpeech, lastText: lastText,
                                   hasText: hasText, completeness: completeness, patience: patience) == nil else { return false }
    return endpointRemaining(now: now, lastSpeech: lastSpeech, lastText: lastText,
                             completeness: completeness, patience: patience) <= endpointNearSeconds + timingEpsilon
}

// MARK: - Voice key normalization (mirrors intentKey in src/voice/turns.ts)

let fillerWords: Set<String> = ["um", "uh", "uhm", "umm", "er", "erm", "hmm", "hm", "mm"]
private let realShortWords: Set<String> = ["a", "an", "i", "no", "so", "to", "on", "in", "it", "is", "at", "of", "or", "up",
    "go", "do", "be", "we", "me", "my", "by", "he", "us", "the", "and", "for", "not", "but"]
private let leadingDiscourseWords: Set<String> = ["ok", "okay", "alright", "so", "well", "hey", "oh"]

// Lowercase, apostrophes deleted ("don't" -> "dont"), other punctuation separates words,
// so hyphen-joined stutters ("s-s-stop", "St. St. Stop.") split like spoken ones.
func voiceTokens(_ text: String) -> [String] {
    let joined = text.lowercased().replacingOccurrences(of: "['’]", with: "", options: .regularExpression)
    let spaced = joined.replacingOccurrences(of: #"[^\p{L}\p{N}\s]"#, with: " ", options: .regularExpression)
    return spaced.split(whereSeparator: { $0.isWhitespace }).map(String.init)
}

// Steps 1-4 of the key: tokens, fillers removed, stutter fragments removed, immediate
// repeats of 1-3 word n-grams collapsed. Leading discourse and trailing politeness stay.
// Stutter removal and collapsing repeat to a fixed point: "s s stop" first loses the
// fragment before "stop", then the one that became adjacent. Every pass that changes
// anything removes a token, so the loop ends within tokens.count + 1 passes.
func voiceKeyBase(_ text: String) -> [String] {
    var tokens = voiceTokens(text).filter { !fillerWords.contains($0) }
    while true {
        var next: [String] = []
        for (index, token) in tokens.enumerated() {
            if index + 1 < tokens.count, token.count <= 3, !realShortWords.contains(token),
               tokens[index + 1].count > token.count, tokens[index + 1].hasPrefix(token) { continue }
            next.append(token)
        }
        next = collapseRepeatedNgrams(next)
        if next.count == tokens.count { break }
        tokens = next
    }
    return tokens
}

private func collapseRepeatedNgrams(_ input: [String]) -> [String] {
    var tokens = input
    var changed = true
    while changed {
        changed = false
        for size in 1...3 {
            var index = 0
            while index + 2 * size <= tokens.count {
                if Array(tokens[index..<index + size]) == Array(tokens[index + size..<index + 2 * size]) {
                    tokens.removeSubrange(index + size..<index + 2 * size); changed = true
                } else { index += 1 }
            }
        }
    }
    return tokens
}

func normalizeVoiceKey(_ text: String) -> String {
    var tokens = voiceKeyBase(text)
    while let first = tokens.first {
        if leadingDiscourseWords.contains(first) { tokens.removeFirst(); continue }
        if tokens.count >= 2 && first == "all" && tokens[1] == "right" { tokens.removeFirst(2); continue }
        break
    }
    while let last = tokens.last {
        if last == "please" || last == "thanks" { tokens.removeLast(); continue }
        if tokens.count >= 2 && last == "you" && tokens[tokens.count - 2] == "thank" { tokens.removeLast(2); continue }
        break
    }
    return tokens.joined(separator: " ")
}

// MARK: - Completeness (mirrors utteranceCompleteness in src/voice/turns.ts)

// A command that so far ends on a verb or connector ("Open", "search for", "go to") is
// almost certainly unfinished: people pause to think of the object.
let continuationWords: Set<String> = ["open", "launch", "start", "go", "search", "find", "look", "type", "write", "send", "play",
    "show", "create", "make", "set", "turn", "switch", "close", "delete", "compute", "calculate", "convert", "add", "move",
    "to", "for", "the", "a", "an", "and", "in", "on", "with", "into", "from", "of", "up", "my", "then", "please",
    "about", "at", "by", "but", "or", "so", "because", "like", "than", "as", "if", "when", "where", "which", "who", "your",
    "his", "her", "their", "our", "its", "some", "any", "every", "is", "are", "was", "were", "be", "been", "can", "could",
    "would", "should", "will", "may", "might", "must", "want", "wanna", "need", "gonna", "let", "lets", "also", "just",
    "maybe", "called", "named", "titled", "saying", "using", "via", "between", "through", "over", "under", "after",
    "before", "plus", "um", "uh", "er", "erm", "hmm"]
let continuationBigrams: Set<String> = ["can you", "could you", "would you", "will you", "i want", "i need", "id like",
    "want to", "need to", "have to", "going to", "help me", "tell me", "show me", "let me", "and then", "go to", "look up",
    "search for", "how do", "how to", "what is", "whats the"]
// "this" and "that" are deliberately absent: "close that" is a complete command.
let actionVerbs: Set<String> = ["open", "launch", "start", "close", "quit", "search", "find", "look", "play", "show", "type",
    "write", "send", "email", "message", "text", "call", "create", "make", "delete", "remove", "move", "copy", "paste", "go",
    "check", "read", "reply", "book", "order", "buy", "schedule", "remind", "set", "turn", "switch", "download", "upload",
    "share", "save", "rename", "print", "translate", "summarize", "compose"]
let resumeKeys: Set<String> = ["resume", "continue", "keep going", "go on", "carry on", "proceed", "you can continue"]
let approveKeys: Set<String> = ["yes", "yeah", "yep", "yup", "sure", "sure thing", "approve", "approved", "confirm", "send it",
    "do it", "go ahead", "yes go ahead", "yes do it", "yes send it", "yeah go ahead"]
let declineKeys: Set<String> = ["no", "nope", "nah", "no thanks", "no thank you", "deny", "dont", "do not", "dont send",
    "do not send", "dont do it", "not now", "not yet", "no dont"]
let acknowledgeKeys: Set<String> = ["okay", "mhm", "uh huh", "thanks", "thank you", "cool", "great", "got it", "fine"]

private func isReplyKey(key: String, base: String) -> Bool {
    for set in [resumeKeys, approveKeys, declineKeys, acknowledgeKeys] where set.contains(key) || set.contains(base) { return true }
    return false
}

func utteranceCompleteness(_ text: String, context: TurnContext) -> Completeness {
    if isControlPhrase(text) { return .control }
    let base = voiceKeyBase(text)
    let key = normalizeVoiceKey(text)
    let words = key.split(separator: " ").map(String.init)
    let reply = isReplyKey(key: key, base: base.joined(separator: " "))
    if (context == .answer || context == .approval) && reply { return .shortAnswer }
    guard let last = words.last else {
        // Only fillers ("um"): still thinking. "okay" / "please" alone: nothing more coming.
        return base.isEmpty && !voiceTokens(text).isEmpty ? .incomplete : .complete
    }
    // Native deviation (endpoint timing only): a bare reply such as "go on" is finished
    // even though its last word is a connector.
    if reply { return .complete }
    let unfinished = continuationWords.contains(last)
        || (words.count >= 2 && continuationBigrams.contains(words[words.count - 2] + " " + last))
        || (words.count == 1 && actionVerbs.contains(last))
    if unfinished { return .incomplete }
    // A short answer ("Safari") ends quickly, but not a fragment such as "can you" (live
    // use: an answer was cut after "can you").
    if (context == .answer || context == .approval) && words.count <= 2 { return .shortAnswer }
    return .complete
}

// MARK: - Adaptive noise floor

// Replaces the fixed 0.018 RMS threshold, under which soft trailing words were lost.
struct NoiseFloor: Equatable {
    var floor = 0.005
    var threshold: Double { min(max(floor * 3.0, 0.006), 0.20) }
    // One sample every ~80 ms from one buffer's RMS. Returns whether it counts as speech.
    mutating func observe(rms: Double) -> Bool {
        guard rms.isFinite, rms >= 0 else { return false }
        let speech = rms > threshold
        let rate = speech ? 0.01 : (rms < floor ? 0.5 : 0.05)
        floor = min(max(floor + (rms - floor) * rate, 0.001), 0.08)
        return speech
    }
}

// Continuous speech energy, tolerating one missed ~80 ms sample between syllables.
struct SpeechRun: Equatable {
    private(set) var start: TimeInterval?
    private(set) var last: TimeInterval = 0
    private(set) var longest: Double = 0
    @discardableResult
    mutating func observe(speech: Bool, at now: TimeInterval, sample: Double = 0.08, gapTolerance: Double = 0.2) -> Double {
        guard speech else { return longest }
        if start == nil || now - last > gapTolerance { start = now }
        last = now
        longest = max(longest, now - (start ?? now) + sample)
        return longest
    }
}

// MARK: - Segment accumulation

struct TurnTranscript: Equatable {
    var committed: [String] = []
    var confidences: [Double?] = []
    var current = ""
    var boundaryPending = false
    var text: String { requestSegments(self).map(\.text).joined(separator: " ") }
    // Every segment heard, a restart included: more than one never approves.
    var segmentCount: Int { committed.count + (current.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0 : 1) }
}

/**
 The segments the request is made of, oldest first, with their confidences (nil when
 never finalized). A later segment that opens with the wake phrase is the user starting
 over (live: the request, then "Assist open calendar and put an event…" merged into one
 doubled task), so only the words after the last one count. A wake phrase with nothing
 after it yet leaves the request as it was; the segment that follows it starts over.
 */
func requestSegments(_ transcript: TurnTranscript) -> [(text: String, confidence: Double?)] {
    let heard: [(String, Double?)] = zip(transcript.committed, transcript.confidences).map { ($0, $1) } + [(transcript.current, nil)]
    var kept = [(text: String, confidence: Double?)](), restarting = false
    for (segment, confidence) in heard {
        let clean = segment.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { continue }
        if !kept.isEmpty || restarting, let rest = commandAfterWakeRestart(clean) {
            if rest.isEmpty { restarting = true } else { kept = [(rest, confidence)]; restarting = false }
        } else if restarting {
            kept = [(clean, confidence)]; restarting = false
        } else {
            kept.append((clean, confidence))
        }
    }
    return kept
}

private func firstContentToken(_ text: String) -> String? { voiceTokens(text).first { !fillerWords.contains($0) } }

// Same first word, or one first word is a >= 3 character prefix of the other ("Chat" -> "ChatGPT").
func segmentRevision(_ previous: String, _ update: String) -> Bool {
    guard let a = firstContentToken(previous), let b = firstContentToken(update) else { return false }
    if a == b { return true }
    let (short, long) = a.count <= b.count ? (a, b) : (b, a)
    return short.count >= 3 && long.hasPrefix(short)
}

// Apple sometimes re-reports everything said so far: drop committed segments the update repeats.
private func dropReReported(_ transcript: inout TurnTranscript, update: String) {
    let words = voiceTokens(update)
    guard !words.isEmpty else { return }
    for start in transcript.committed.indices {
        let tail = transcript.committed[start...].flatMap { voiceTokens($0) }
        if !tail.isEmpty && words.count >= tail.count && Array(words.prefix(tail.count)) == tail {
            transcript.committed.removeSubrange(start...); transcript.confidences.removeSubrange(start...)
            return
        }
    }
}

// Apple sometimes starts a new segment after a pause without the empty callback: the
// update is much shorter than the current hypothesis and shares none of its words. A
// rewrite of the same speech keeps most of the words.
func looksLikeNewSegment(_ previous: String, _ update: String) -> Bool {
    let old = voiceTokens(previous), new = voiceTokens(update)
    guard old.count >= 2, !new.isEmpty, new.count * 2 <= old.count else { return false }
    return Set(old).isDisjoint(with: new.prefix(2))
}

// gap: seconds since the merged text last changed.
func absorbPartial(_ transcript: inout TurnTranscript, update: String, gap: Double) {
    let clean = update.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !clean.isEmpty else {
        // The recognizer's empty callback after ~1.5 s of silence marks a segment reset.
        if !transcript.current.isEmpty { transcript.boundaryPending = true }
        return
    }
    if transcript.current.isEmpty || segmentRevision(transcript.current, clean) {
        transcript.current = clean
    } else if transcript.boundaryPending || gap >= 1.0 || looksLikeNewSegment(transcript.current, clean) {
        transcript.committed.append(transcript.current); transcript.confidences.append(nil)
        transcript.current = clean
    } else {
        transcript.current = clean // Apple rewrote its hypothesis.
    }
    dropReReported(&transcript, update: clean)
    transcript.boundaryPending = false
}

// A recognizer final for the current request (the caller then rotates the request).
// Empty final text keeps the unconfirmed partial as a committed segment without confidence.
func absorbFinalSegment(_ transcript: inout TurnTranscript, text: String, confidence: Double?) {
    let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if clean.isEmpty {
        let partial = transcript.current.trimmingCharacters(in: .whitespacesAndNewlines)
        if !partial.isEmpty { transcript.committed.append(partial); transcript.confidences.append(nil) }
    } else {
        absorbPartial(&transcript, update: clean, gap: 0)
        transcript.committed.append(transcript.current); transcript.confidences.append(confidence)
    }
    transcript.current = ""
    transcript.boundaryPending = false
}

// 0 when any spoken segment was never finalized (merged or recovered speech can never
// approve); otherwise the word-weighted mean of the segment confidences. Segments a
// restart dropped are not part of the request, so they do not count either way.
func turnConfidence(_ transcript: TurnTranscript) -> Double {
    guard transcript.current.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return 0 }
    var words = 0.0, total = 0.0
    for (segment, confidence) in requestSegments(transcript) {
        let count = Double(voiceTokens(segment).filter { !fillerWords.contains($0) }.count)
        if count == 0 { continue }
        guard let confidence = confidence, confidence.isFinite else { return 0 }
        words += count; total += count * min(max(confidence, 0), 1)
    }
    return words > 0 ? total / words : 0
}

// Misheard wake phrases at the start of the first segment of a session that the real
// wake phrase already activated: the name after a lead word, and the everyday words a
// recognizer wrote for "Hey Butler" in noise ("but a lot", "but Allah", "Budger";
// .data/names/butler-speech.log). Those are only ever stripped here, never used to wake:
// activation itself (commandAfterWakePhrase) is not widened.
private let wakeEcho = try! NSRegularExpression(
    pattern: #"^(?:(?:hey|hay|hi|hei|his|a)[\s,]+(?:\#(wakeNamePattern)|but\s+a\s+lot|but\s+allah|budger)|\#(fusedWakePattern))(?![a-z])[\s,.:;!?—-]*"#,
    options: .caseInsensitive)
func stripWakeEcho(_ text: String) -> String {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let match = wakeEcho.firstMatch(in: trimmed, range: NSRange(trimmed.startIndex..., in: trimmed)),
          let end = Range(match.range, in: trimmed)?.upperBound else { return trimmed }
    return String(trimmed[end...]).trimmingCharacters(in: .whitespacesAndNewlines)
}

// Words removed from the front of a recognizer result, so their confidences are excluded.
func strippedWordCount(raw: String, command: String) -> Int {
    max(0, raw.split(whereSeparator: { $0.isWhitespace }).count - command.split(whereSeparator: { $0.isWhitespace }).count)
}

// MARK: - Follow-up windows

enum FollowUpKind: String { case answer, approval, continuation }
// The "Keep listening" setting (settings.followUpWindow), received through configure.
enum FollowUpWindow: String { case short, long, conversation }

let followUpOnsetSeconds = 0.24
let continuationWindowDelay = 0.25
let followUpGraceSeconds = 1.5
private let followUpStarters: Set<String> = ["and", "also", "oh", "actually", "wait", "no", "not", "stop", "then", "plus",
    "but", "instead", "sorry", "use", "with"]

// Continuation and answer windows grow with the setting (mirrors followUpSeconds in
// src/voice/turns.ts); an approval window stays bounded, since a "yes" inside it acts.
func followUpSeconds(_ kind: FollowUpKind, window: FollowUpWindow = .short) -> Double {
    switch (window, kind) {
    case (.short, .continuation): return 3.0
    case (.short, .answer), (.short, .approval): return 8.0
    case (.long, .continuation), (.long, .answer): return 20.0
    case (.long, .approval), (.conversation, .approval): return 12.0
    case (.conversation, .continuation), (.conversation, .answer): return 45.0
    }
}

// The longest window Electron may ask for under each setting.
func followUpCapSeconds(_ window: FollowUpWindow) -> Double {
    switch window {
    case .short: return 15
    case .long: return 20
    case .conversation: return 45
    }
}

func clampFollowUpSeconds(_ seconds: Double?, kind: FollowUpKind, window: FollowUpWindow = .short) -> Double {
    guard let seconds = seconds, seconds.isFinite else { return followUpSeconds(kind, window: window) }
    return min(max(seconds, 0.5), followUpCapSeconds(window))
}

func turnContext(for kind: FollowUpKind) -> TurnContext {
    switch kind {
    case .answer: return .answer
    case .approval: return .approval
    case .continuation: return .continuation
    }
}

// Speech that turns an open window into a turn. A continuation must sound like one
// ("and search", "actually use Safari") so side conversation does not become a command,
// except under the conversation setting, where the user chose to have everything said in
// the room taken as addressed to Butler. Words that may be the start of the wake phrase
// ("Hey Butler"): a window waits for more text before treating them as the user's reply,
// so the wake phrase can take over.
let wakeLeadWords: Set<String> = ["hey", "hay", "hi", "hei"]

func followUpOnset(text: String, speechRun: Double, kind: FollowUpKind, window: FollowUpWindow = .short) -> Bool {
    let words = voiceTokens(text).filter { !fillerWords.contains($0) }
    guard speechRun + timingEpsilon >= followUpOnsetSeconds, let first = words.first else { return false }
    if wakeLeadWords.contains(first) && words.count < 3 { return false }
    switch kind {
    case .continuation: return window == .conversation || followUpStarters.contains(first) || isControlPhrase(text)
    case .answer, .approval: return true
    }
}

// What ends a conversation-mode window without acting (mirrors endsConversation in
// src/voice/turns.ts; tests/fixtures/voice-phrases.json "endConversation" pins both):
// "that's all", "that'll be all", "that's it", "goodbye", "bye", "good night", "stop
// listening", each with the name or "for now" allowed after it, or "thanks" followed by the
// name. A bare "thanks" stays a back-channel word.
private let conversationCloser = "(?:(?:thats|that is|thatll be|that will be) (?:all|it)|good ?bye|bye(?: bye)?|good ?night|(?:you can )?stop listening)(?: for now| now)?"
private let conversationThanks = "(?:thanks|thank you)"
private let conversationEnd = try! NSRegularExpression(
    pattern: "^(?:\(conversationThanks) (?:\(wakeNamePattern) )?)?\(conversationCloser)(?: \(wakeNamePattern))?$|^\(conversationThanks) \(wakeNamePattern)$")
func endsConversation(_ text: String) -> Bool {
    let key = normalizeVoiceKey(text)
    return conversationEnd.firstMatch(in: key, range: NSRange(key.startIndex..., in: key)) != nil
}

// A window closes at its deadline, unless speech energy is still arriving (the user
// started just before it closed); that grace is bounded.
func followUpExpired(now: TimeInterval, deadline: TimeInterval, lastSpeech: TimeInterval) -> Bool {
    guard now >= deadline else { return false }
    return !(now - lastSpeech < 0.3 && now < deadline + followUpGraceSeconds)
}

// MARK: - Echo and barge-in

let echoGuardSeconds = 0.8
let bluetoothEchoGuardSeconds = 1.2
let bargeInMuteSeconds = 0.15
let bargeInRecentSeconds = 0.25
let bargeInStopWaitSeconds = 0.05
let pushToTalkTailSeconds = 0.3

// Ambient listening (standby and follow-up windows) never runs while the assistant speaks,
// nor for the echo guard afterwards.
func standbyAllowed(speaking: Bool, now: TimeInterval, echoGuardUntil: TimeInterval) -> Bool {
    !speaking && now >= echoGuardUntil
}

// CoreAudio kAudioDeviceTransportTypeBluetooth ('blue') and ...BluetoothLE ('blea').
func bluetoothTransport(_ transport: UInt32) -> Bool { transport == 0x626C_7565 || transport == 0x626C_6561 }

// Bluetooth output plays well behind the synthesizer's timeline, so its tail lasts longer.
func echoGuard(bluetoothOutput: Bool) -> Double { bluetoothOutput ? bluetoothEchoGuardSeconds : echoGuardSeconds }

// Barge-in pre-roll: the first bargeInMuteSeconds of capture may still hold the reply's
// tail. Counted from the first buffer the microphone delivers, not from key-down: the
// engine start after key-down can take longer than the mute itself.
struct PreRollMute: Equatable {
    private(set) var pending: Double
    private(set) var until: TimeInterval = 0
    init(seconds: Double = 0) { pending = max(0, seconds.isFinite ? seconds : 0) }
    // Whether a buffer captured now reaches the recognizer and the level meter.
    mutating func admits(at now: TimeInterval) -> Bool {
        if pending > 0 { until = now + pending; pending = 0 }
        return now >= until
    }
}

// Option released while Space is still held does not end push-to-talk.
func shouldEndOnOptionRelease(spaceStillDown: Bool) -> Bool { !spaceStillDown }

// MARK: - Speech output decisions

enum SpeakPriority: Int {
    case ack, result, urgent
    init?(label: String) {
        switch label {
        case "ack": self = .ack
        case "result": self = .result
        case "urgent": self = .urgent
        default: return nil
        }
    }
    var label: String {
        switch self {
        case .ack: return "ack"
        case .result: return "result"
        case .urgent: return "urgent"
        }
    }
}

enum SpeakDecision: Equatable { case reject(String), play, replace, queue }

// Never talk over an open microphone. Equal or higher priority replaces the current
// utterance; lower priority waits in the single queue slot.
func speakDecision(enabled: Bool, capturing: Bool, suspended: Bool, current: SpeakPriority?, incoming: SpeakPriority) -> SpeakDecision {
    if !enabled { return .reject("disabled") }
    if suspended { return .reject("suspended") }
    if capturing { return .reject("capturing") }
    guard let current = current else { return .play }
    return incoming.rawValue >= current.rawValue ? .replace : .queue
}

let queuedAckMaxAge = 1.5
func queuedUtteranceStale(priority: SpeakPriority, queuedAt: TimeInterval, now: TimeInterval) -> Bool {
    priority == .ack && now - queuedAt > queuedAckMaxAge
}

// The name is written Butler and said BUT-ler. Every macOS voice reads the written "Butler" as
// EYE-sa (one says EE-sa) and "Butler" either way, but "Eesa" as BUT-ler in all six voices
// measured (.data/names/butler-speech.log §2). Applied only to the text handed to the system
// synthesizer: the same sentence reaches iMessage and the phone written as Butler, and Kokoro
// has its own lexicon entry (src/voice/kokoro/g2p.ts).
// "Butler" is an English word: every voice says it as written, so nothing is respelled.
func systemVoiceText(_ text: String) -> String { text }

// The phrase inventory is English; other locales keep replies visual.
func speechLanguageSupported(locale: String) -> Bool { voiceLanguageParts(locale).language == "en" }

// MARK: - Voice selection

enum VoiceQuality: String {
    case none, standard = "default", enhanced, premium
    var rank: Int {
        switch self {
        case .none: return 0
        case .standard: return 1
        case .enhanced: return 2
        case .premium: return 3
        }
    }
}

struct VoiceInfo: Equatable {
    let id: String
    let name: String
    let language: String
    let quality: VoiceQuality
    var novelty = false
    var personal = false
}

func voiceLanguageParts(_ identifier: String) -> (language: String, full: String) {
    let base = identifier.split(separator: "@", maxSplits: 1).first.map(String.init) ?? ""
    let full = base.replacingOccurrences(of: "_", with: "-").lowercased()
    return (full.split(separator: "-").first.map(String.init) ?? "", full)
}

// Best voices first: premium > enhanced > default, then exact region, then name.
func rankVoices(_ voices: [VoiceInfo], language: String) -> [VoiceInfo] {
    let wanted = voiceLanguageParts(language)
    guard !wanted.language.isEmpty else { return [] }
    return voices.filter { !$0.novelty && !$0.personal && voiceLanguageParts($0.language).language == wanted.language }
        .sorted { a, b in
            if a.quality.rank != b.quality.rank { return a.quality.rank > b.quality.rank }
            let aExact = voiceLanguageParts(a.language).full == wanted.full, bExact = voiceLanguageParts(b.language).full == wanted.full
            if aExact != bExact { return aExact }
            if a.name != b.name { return a.name < b.name }
            return a.id < b.id
        }
}

// Fallback chain: the selected voice if still installed, the best voice for the locale
// language, any en-US voice, or nothing (replies stay visual).
func chooseVoice(_ voices: [VoiceInfo], selected: String, language: String) -> VoiceInfo? {
    if !selected.isEmpty, let voice = voices.first(where: { $0.id == selected }) { return voice }
    if let best = rankVoices(voices, language: language).first { return best }
    return rankVoices(voices, language: "en-US").first { voiceLanguageParts($0.language).full == "en-us" }
}

// Apple's rate scale: 0.5 is the default speaking rate.
func speechRate(multiplier: Double) -> Float {
    guard multiplier.isFinite else { return 0.5 }
    return Float(min(max(0.5 + (multiplier - 1) * 0.25, 0.40), 0.62))
}

// MARK: - PCM playback

let pcmPrebufferSeconds = 0.2
let pcmStallSeconds = 2.5
let pcmFirstAudioSeconds = 4.0
let pcmMaxSeconds = 300.0

func validPcmSampleRate(_ rate: Double) -> Bool { rate.isFinite && rate >= 8000 && rate <= 48000 }

// 16-bit little-endian mono to Float32 in [-1, 1). An odd trailing byte is carried to the next chunk.
func pcmSamplesFromS16LE(_ data: Data, carry: inout UInt8?) -> [Float] {
    var bytes = [UInt8](data)
    if let pending = carry { bytes.insert(pending, at: 0); carry = nil }
    if bytes.count % 2 == 1 { carry = bytes.removeLast() }
    var samples = [Float](repeating: 0, count: bytes.count / 2)
    for index in samples.indices {
        let value = Int16(bitPattern: UInt16(bytes[2 * index]) | (UInt16(bytes[2 * index + 1]) << 8))
        samples[index] = Float(value) / 32768.0
    }
    return samples
}

// Chunks arrive in order (Electron awaits each ack); a repeated or older seq is ignored,
// a gap is tolerated so one lost line cannot silence the rest of the reply.
func pcmChunkAccepted(seq: Int?, expected: Int) -> Bool {
    guard let seq = seq else { return true }
    return seq >= expected
}

func pcmReadyToStart(bufferedSamples: Int, sampleRate: Double, ended: Bool) -> Bool {
    bufferedSamples > 0 && (ended || Double(bufferedSamples) >= sampleRate * pcmPrebufferSeconds - timingEpsilon)
}

// After speech_started: no chunk and no end for 2.5 s, once the audio already buffered has
// run out. Before it, a cloud stream may take a while to deliver its first 200 ms, so the
// guard waits at least 4.0 s from playPcmStart (requested) and 2.5 s from the last chunk.
func pcmStalled(now: TimeInterval, requested: TimeInterval, lastActivity: TimeInterval, started: Bool, ended: Bool,
                playedUntil: TimeInterval) -> Bool {
    guard !ended, now - lastActivity + timingEpsilon >= pcmStallSeconds else { return false }
    return started ? now >= playedUntil : now - requested + timingEpsilon >= pcmFirstAudioSeconds
}
