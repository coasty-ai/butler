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
func voiceEndpoint(now: TimeInterval, started: TimeInterval, lastSpeech: TimeInterval,
                   lastText: TimeInterval, awake: Bool, hasText: Bool) -> VoiceEndpoint {
    if awake {
        if !hasText && now - started >= 8 { return .empty }
        if hasText && ((now - lastText >= 1.3 && now - lastSpeech >= 1.0) || now - started >= 30) { return .finish }
    } else if now - started >= 45 || (lastSpeech > started && now - lastSpeech >= 1.3) {
        return .recycle
    }
    return .none
}
