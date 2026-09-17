import Foundation

// Pure endpointing, segment accumulation, follow-up, speech-output and PCM checks
// for TurnPolicy.swift. Evidence replays use timelines from the local voice log.
func turnPolicyChecks(_ check: (Bool, String) -> Void) {
    func near(_ a: Double, _ b: Double, _ tolerance: Double = 1e-9) -> Bool { abs(a - b) <= tolerance }

    // Timing table: every completeness x patience pair.
    let table: [(Completeness, Patience, EndpointTiming)] = [
        (.control, .quick, EndpointTiming(stable: 0.9, quiet: 0.7, textOnly: 2.0)),
        (.control, .normal, EndpointTiming(stable: 0.9, quiet: 0.7, textOnly: 2.0)),
        (.control, .relaxed, EndpointTiming(stable: 0.9, quiet: 0.7, textOnly: 2.0)),
        (.shortAnswer, .quick, EndpointTiming(stable: 0.9, quiet: 0.7, textOnly: 2.0)),
        (.shortAnswer, .normal, EndpointTiming(stable: 0.9, quiet: 0.7, textOnly: 2.0)),
        (.shortAnswer, .relaxed, EndpointTiming(stable: 0.9, quiet: 0.7, textOnly: 2.0)),
        (.complete, .quick, EndpointTiming(stable: 1.4, quiet: 1.05, textOnly: 2.8)),
        (.complete, .normal, EndpointTiming(stable: 2.0, quiet: 1.5, textOnly: 4.0)),
        (.complete, .relaxed, EndpointTiming(stable: 3.0, quiet: 2.25, textOnly: 6.0)),
        (.incomplete, .quick, EndpointTiming(stable: 2.45, quiet: 1.75, textOnly: 4.55)),
        (.incomplete, .normal, EndpointTiming(stable: 3.5, quiet: 2.5, textOnly: 6.5)),
        (.incomplete, .relaxed, EndpointTiming(stable: 5.25, quiet: 3.75, textOnly: 9.75)),
    ]
    for (completeness, patience, timing) in table {
        check(endpointTiming(completeness, patience: patience) == timing, "endpoint timing \(completeness.rawValue) at \(patience.rawValue)")
    }
    check(emptyTurnLimit(patience: .quick) == 8 && emptyTurnLimit(patience: .normal) == 10 && emptyTurnLimit(patience: .relaxed) == 12, "empty wake limits are 8/10/12 s")
    check(maxTurnSeconds == 45 && pushToTalkMaxSeconds == 120, "hands-free turns cap at 45 s, push-to-talk at 120 s")
    check(echoGuardSeconds == 0.8 && bargeInMuteSeconds == 0.15 && pushToTalkTailSeconds == 0.3, "echo guard, barge-in mute and release tail constants")
    check(bargeInRecentSeconds == 0.25 && bargeInStopWaitSeconds == 0.05, "barge-in applies within 0.25 s of audible speech and waits at most 50 ms for output to stop")

    func endpoint(_ text: String, stable: Double, quiet: Double, patience: Patience = .normal, context: TurnContext = .command) -> VoiceEndpoint {
        turnEndpoint(now: 100, started: 90, lastSpeech: 100 - quiet, lastText: 100 - stable, hasText: !text.isEmpty,
                     completeness: utteranceCompleteness(text, context: context), patience: patience)
    }
    // Evidence replays: thinking pauses that used to end the turn at about 1.3 s.
    for pause in [1.20, 1.23, 1.47, 1.60, 1.86, 1.88] {
        check(endpoint("Open Google and go to chat GPT", stable: pause, quiet: pause) == .none, "a \(pause) s thinking pause after complete-looking words keeps listening")
    }
    check(endpoint("I want to send an email to my", stable: 2.19, quiet: 2.19) == .none, "2.19 s after \"my\" is still unfinished")
    check(endpoint("Open", stable: 3.02, quiet: 3.02) == .none, "\"Open\" survives a 3.02 s pause")
    check(endpoint("Hey Assist can you", stable: 1.36, quiet: 1.36) == .none && endpoint("can you", stable: 1.36, quiet: 1.36, context: .answer) == .none, "\"can you\" survives the pause that cut an answer")
    check(endpoint("open notes", stable: 2.0, quiet: 1.5) == .finish, "a complete command ends after 2.0 s stable and 1.5 s quiet")
    check(endpoint("open notes", stable: 1.9, quiet: 1.9) == .none, "a complete command waits for the full stable period")
    check(endpoint("open notes", stable: 4.0, quiet: 0) == .finish, "steady background sound cannot hold stable text open")
    check(endpoint("open notes", stable: 3.9, quiet: 0) == .none, "text-only endpoint waits for its full period while sound continues")
    check(endpoint("open notes", stable: 2.5, quiet: 1.2) == .none, "ongoing soft speech keeps a complete command open")
    check(endpoint("stop", stable: 0.9, quiet: 0.7) == .finish, "a stop ends after 0.9 s stable and 0.7 s quiet")
    check(endpoint("stop", stable: 0.8, quiet: 0.8) == .none, "a stop still waits 0.9 s")
    check(endpoint("Safari", stable: 0.9, quiet: 0.7, context: .answer) == .finish, "a short answer ends quickly")
    check(endpoint("open notes", stable: 1.4, quiet: 1.05, patience: .quick) == .finish, "quick patience ends at 1.4 s and 1.05 s")
    check(endpoint("open notes", stable: 2.9, quiet: 2.2, patience: .relaxed) == .none, "relaxed patience waits for 3.0 s")
    check(endpoint("Open", stable: 3.5, quiet: 2.5) == .finish, "an unfinished command still ends after 3.5 s and 2.5 s")
    check(endpoint("Open", stable: 6.5, quiet: 0) == .finish, "an unfinished command ends on text alone after 6.5 s")
    check(turnEndpoint(now: 10, started: 0, lastSpeech: 0, lastText: 0, hasText: false, completeness: .complete, patience: .normal) == .empty, "empty turn expires at 10 s")
    check(turnEndpoint(now: 9.9, started: 0, lastSpeech: 0, lastText: 0, hasText: false, completeness: .complete, patience: .normal) == .none, "empty turn waits 10 s at normal patience")
    check(turnEndpoint(now: 8, started: 0, lastSpeech: 0, lastText: 0, hasText: false, completeness: .complete, patience: .quick) == .empty, "empty turn expires at 8 s at quick patience")
    check(turnEndpoint(now: 45, started: 0, lastSpeech: 45, lastText: 45, hasText: true, completeness: .incomplete, patience: .relaxed) == .finish, "command capture has a 45 s hard limit")
    check(turnEndDecision(now: 10, started: 0, lastSpeech: 8.5, lastText: 8, hasText: true, completeness: .complete, patience: .normal) == .stableQuiet, "end reason stable_quiet")
    check(turnEndDecision(now: 10, started: 0, lastSpeech: 10, lastText: 6, hasText: true, completeness: .complete, patience: .normal) == .textOnly, "end reason text_only")
    check(turnEndDecision(now: 45, started: 0, lastSpeech: 45, lastText: 45, hasText: true, completeness: .complete, patience: .normal) == .max, "end reason max")
    check(turnEndDecision(now: 12, started: 0, lastSpeech: 0, lastText: 0, hasText: false, completeness: .complete, patience: .normal) == .empty, "end reason empty")
    check(TurnEndReason.stableQuiet.rawValue == "stable_quiet" && TurnEndReason.textOnly.rawValue == "text_only" && TurnEndReason.release.rawValue == "release", "end reason protocol names")

    // endpoint_near
    check(endpointNear(now: 10, started: 0, lastSpeech: 8.5, lastText: 8.7, hasText: true, completeness: .complete, patience: .normal), "endpoint is near with 0.7 s remaining")
    check(!endpointNear(now: 10, started: 0, lastSpeech: 8.5, lastText: 8.8, hasText: true, completeness: .complete, patience: .normal), "endpoint is not near with 0.8 s remaining")
    check(!endpointNear(now: 10, started: 0, lastSpeech: 8.5, lastText: 10, hasText: true, completeness: .complete, patience: .normal), "a text change resets the closing ring")
    check(!endpointNear(now: 10, started: 0, lastSpeech: 8.5, lastText: 10, hasText: true, completeness: .control, patience: .normal), "a text change is not near even for control phrases")
    check(!endpointNear(now: 10, started: 0, lastSpeech: 9.9, lastText: 8.0, hasText: true, completeness: .complete, patience: .normal), "ongoing sound is not near")
    check(!endpointNear(now: 10, started: 0, lastSpeech: 8.0, lastText: 8.0, hasText: true, completeness: .complete, patience: .normal), "an ended turn is not near")
    check(!endpointNear(now: 9, started: 0, lastSpeech: 0, lastText: 0, hasText: false, completeness: .complete, patience: .normal), "an empty turn has no closing ring")
    check(near(endpointRemaining(now: 10, lastSpeech: 9.0, lastText: 8.5, completeness: .complete, patience: .normal), 0.5), "remaining time uses the longer of stable and quiet")

    // NoiseFloor
    var room = NoiseFloor()
    for index in 0..<150 { _ = room.observe(rms: index % 2 == 0 ? 0.002 : 0.004) }
    check(room.floor <= 0.005, "quiet room floor converges to at most 0.005")
    check(room.threshold >= 0.006 && room.threshold < 0.018, "quiet room threshold drops below the old fixed 0.018")
    check(room.observe(rms: 0.013), "a soft trailing word at RMS 0.013 counts as speech")
    var fan = NoiseFloor()
    check(fan.observe(rms: 0.03), "new steady sound counts as speech at first")
    var fanSpeechSamples = 1
    while fanSpeechSamples < 400 && fan.observe(rms: 0.03) { fanSpeechSamples += 1 }
    check(fanSpeechSamples <= 150, "constant 0.03 stops counting as speech within 12 s of samples")
    for _ in 0..<150 { _ = fan.observe(rms: 0.03) }
    check(!fan.observe(rms: 0.03), "steady sound stays in the floor")
    var loud = NoiseFloor()
    for _ in 0..<5000 { _ = loud.observe(rms: 1.0) }
    check(loud.floor <= 0.08 && loud.threshold <= 0.20, "floor and threshold clamp at the top")
    var silent = NoiseFloor()
    for _ in 0..<200 { _ = silent.observe(rms: 0) }
    check(silent.floor >= 0.001 && silent.threshold == 0.006, "floor clamps at 0.001 and threshold at 0.006")
    var invalid = NoiseFloor()
    check(!invalid.observe(rms: .nan) && invalid == NoiseFloor(), "an invalid level is ignored")

    // SpeechRun
    var run = SpeechRun()
    run.observe(speech: true, at: 1.00); run.observe(speech: true, at: 1.08)
    check(near(run.longest, 0.16), "two speech samples are 0.16 s of energy")
    run.observe(speech: true, at: 1.16)
    check(near(run.longest, 0.24), "three consecutive speech samples reach the 0.24 s onset")
    var broken = SpeechRun()
    broken.observe(speech: true, at: 1.0); broken.observe(speech: true, at: 1.3); broken.observe(speech: true, at: 1.6)
    check(near(broken.longest, 0.08), "separate blips are not continuous speech")
    var syllables = SpeechRun()
    for time in [1.0, 1.08, 1.24, 1.32] { syllables.observe(speech: time != 1.16, at: time) }
    check(near(syllables.longest, 0.4), "one missed sample between syllables keeps the run")

    // TurnTranscript
    var reset = TurnTranscript()
    for (update, gap) in [("Open", 0.0), ("Open Google", 0.3), ("Open Google and", 0.4), ("", 1.5), ("Check", 0.3), ("Check the weather", 0.5)] {
        absorbPartial(&reset, update: update, gap: gap)
    }
    check(reset.text == "Open Google and Check the weather" && reset.committed == ["Open Google and"], "a recognizer segment reset no longer drops earlier words")
    check(reset.segmentCount == 2, "segment count includes the live segment")
    var revision = TurnTranscript()
    absorbPartial(&revision, update: "Open no", gap: 0); absorbPartial(&revision, update: "Open notes", gap: 0.2)
    check(revision.text == "Open notes" && revision.committed.isEmpty, "\"Open no\" to \"Open notes\" is a revision")
    var prefix = TurnTranscript()
    absorbPartial(&prefix, update: "Chat", gap: 0); absorbPartial(&prefix, update: "ChatGPT", gap: 1.4)
    check(prefix.text == "ChatGPT" && prefix.committed.isEmpty, "\"Chat\" to \"ChatGPT\" is a revision even after a pause")
    var sharedFirst = TurnTranscript()
    absorbPartial(&sharedFirst, update: "Open Google", gap: 0); absorbPartial(&sharedFirst, update: "Open Google and search", gap: 1.5)
    check(sharedFirst.text == "Open Google and search" && sharedFirst.committed.isEmpty, "a gap of at least 1.0 s with a shared first word is a revision")
    var longGap = TurnTranscript()
    absorbPartial(&longGap, update: "Open Google", gap: 0); absorbPartial(&longGap, update: "search cats", gap: 1.2)
    check(longGap.text == "Open Google search cats" && longGap.committed == ["Open Google"], "a new first word after a gap of at least 1.0 s is a new segment")
    // Live evidence (2026-09-17): after a 2 s pause Apple restarted with "Her" and no empty
    // callback, 0.2 s after rewriting the old hypothesis. The earlier words must survive.
    var silentReset = TurnTranscript()
    for (update, gap) in [("Check", 0.0), ("Check how good news research", 0.5), ("Check out good news research is", 0.2),
                          ("Check how good news research is", 1.8), ("Her", 0.2), ("Hermes", 0.2), ("Hermes agent is", 0.5)] {
        absorbPartial(&silentReset, update: update, gap: gap)
    }
    check(silentReset.text == "Check how good news research is Hermes agent is" && silentReset.committed == ["Check how good news research is"],
          "a much shorter unrelated hypothesis is a new segment even without the empty callback")
    check(looksLikeNewSegment("Open Google and check", "weather"), "short update sharing no words starts a segment")
    check(!looksLikeNewSegment("Open Google and check", "Opening Google"), "a rewrite that keeps words is not a new segment")
    check(!looksLikeNewSegment("Open notes", "notes"), "an update sharing a word is not a new segment")
    check(!looksLikeNewSegment("Hello", "Hi"), "a one-word hypothesis is rewritten, not committed")
    var rewrite = TurnTranscript()
    absorbPartial(&rewrite, update: "His cyst", gap: 0); absorbPartial(&rewrite, update: "Hey sis can you", gap: 0.3)
    check(rewrite.text == "Hey sis can you" && rewrite.committed.isEmpty, "a quick hypothesis rewrite replaces the live segment")
    var rereport = TurnTranscript()
    for (update, gap) in [("Open Google and", 0.0), ("", 1.6), ("Check the", 0.2), ("Open Google and check the weather", 0.2)] {
        absorbPartial(&rereport, update: update, gap: gap)
    }
    check(rereport.text == "Open Google and check the weather" && rereport.committed.isEmpty, "a re-reported full transcript is deduplicated")
    var flush = TurnTranscript()
    for update in ["Open", "Open Notes and write a longer draft", "Open Notes and write a note", "", "  "] { absorbPartial(&flush, update: update, gap: 0.2) }
    check(flush.text == "Open Notes and write a note" && flush.boundaryPending, "empty flushes keep the latest correction and mark a boundary")
    var merged = reset
    absorbFinalSegment(&merged, text: "Check the weather", confidence: 0.9)
    check(merged.text == "Open Google and Check the weather" && merged.current.isEmpty && merged.committed.count == 2, "a mid-turn final commits its segment")
    check(turnConfidence(merged) == 0, "merged speech with a committed partial can never approve")
    var finals = TurnTranscript()
    absorbPartial(&finals, update: "open notes", gap: 0)
    absorbFinalSegment(&finals, text: "open notes", confidence: 0.9)
    absorbPartial(&finals, update: "and write hello", gap: 0.4)
    absorbFinalSegment(&finals, text: "and write hello", confidence: 0.6)
    check(near(turnConfidence(finals), 0.72), "all-final segments give the word-weighted mean confidence")
    var filler = TurnTranscript()
    absorbPartial(&filler, update: "um", gap: 0); absorbPartial(&filler, update: "yes", gap: 1.2)
    absorbFinalSegment(&filler, text: "yes", confidence: 0.8)
    check(filler.committed == ["um", "yes"] && near(turnConfidence(filler), 0.8), "filler-only committed segments are ignored for confidence")
    var correction = TurnTranscript()
    absorbPartial(&correction, update: "Use the December report", gap: 0)
    absorbFinalSegment(&correction, text: "Use the September report", confidence: 0.7)
    check(correction.text == "Use the September report" && correction.committed.count == 1 && near(turnConfidence(correction), 0.7), "a final correction replaces its partial")
    var emptyFinal = TurnTranscript()
    absorbPartial(&emptyFinal, update: "open notes", gap: 0)
    absorbFinalSegment(&emptyFinal, text: "", confidence: nil)
    check(emptyFinal.text == "open notes" && emptyFinal.confidences == [nil] && turnConfidence(emptyFinal) == 0, "an empty final keeps the unconfirmed partial without confidence")
    var wakeOnly = TurnTranscript()
    absorbFinalSegment(&wakeOnly, text: "", confidence: nil)
    check(wakeOnly.text.isEmpty && wakeOnly.committed.isEmpty, "a wake-phrase-only final adds nothing")
    var live = TurnTranscript()
    absorbPartial(&live, update: "yes", gap: 0)
    check(turnConfidence(live) == 0, "an unfinalized live segment has no confidence")
    check(turnConfidence(TurnTranscript()) == 0, "an empty turn has no confidence")

    // Wake echo
    check(stripWakeEcho("His cyst un PT can you check") == "un PT can you check", "a misheard wake phrase from the log is stripped")
    check(stripWakeEcho("Hi, sis. Open notes") == "Open notes", "greeting variant stripped")
    check(stripWakeEcho("A sister told me") == "A sister told me", "a real word starting like the wake phrase is kept")
    check(stripWakeEcho("open notes") == "open notes", "text without a wake echo is unchanged")
    check(commandAfterWakePhrase("Hey assistant open Notes") == nil, "activation is not widened by wake echo stripping")
    check(strippedWordCount(raw: "Hey Assist, open notes", command: "open notes") == 2, "wake words are excluded from confidence")
    check(strippedWordCount(raw: "open notes", command: "open notes") == 0, "nothing excluded without a wake phrase")

    // Follow-up windows
    check(followUpSeconds(.continuation) == 3 && followUpSeconds(.answer) == 8 && followUpSeconds(.approval) == 8, "follow-up window lengths")
    check(clampFollowUpSeconds(nil, kind: .answer) == 8 && clampFollowUpSeconds(60, kind: .answer) == 15 && clampFollowUpSeconds(0, kind: .answer) == 0.5, "requested window lengths are bounded")
    check(followUpOnset(text: "and search", speechRun: 0.24, kind: .continuation), "a continuation starter with enough energy opens a turn")
    check(followUpOnset(text: "um, actually use Safari", speechRun: 0.4, kind: .continuation), "fillers before a starter are skipped")
    check(followUpOnset(text: "Stop", speechRun: 0.3, kind: .continuation), "a control phrase continues a turn")
    check(!followUpOnset(text: "and search", speechRun: 0.16, kind: .continuation), "a continuation needs 0.24 s of energy")
    check(!followUpOnset(text: "the weather is nice", speechRun: 1.0, kind: .continuation), "side conversation is not a continuation")
    // Live evidence: "Hey" opened an answer turn before "Assist" was recognized.
    check(!followUpOnset(text: "Hey", speechRun: 1.0, kind: .answer), "a lone wake lead word waits for the wake phrase")
    check(!followUpOnset(text: "Hey Assist", speechRun: 1.0, kind: .answer), "the wake phrase itself is not an answer")
    check(followUpOnset(text: "Hi there friend", speechRun: 1.0, kind: .answer), "a longer reply starting with hi still counts")
    check(!followUpOnset(text: "um", speechRun: 1.0, kind: .continuation) && !followUpOnset(text: "um", speechRun: 1.0, kind: .answer), "filler-only speech never counts")
    check(followUpOnset(text: "Safari", speechRun: 0.24, kind: .answer), "an answer accepts one word")
    check(followUpOnset(text: "yes", speechRun: 0.3, kind: .approval), "an approval window accepts one word")
    check(!followUpOnset(text: "", speechRun: 1.0, kind: .answer), "energy without words is not an answer")
    check(!followUpOnset(text: "yes", speechRun: 0.1, kind: .approval), "a click-like blip with text is not an answer")
    check(turnContext(for: .answer) == .answer && turnContext(for: .approval) == .approval && turnContext(for: .continuation) == .continuation, "window kinds map to turn contexts")
    check(!followUpExpired(now: 9.9, deadline: 10, lastSpeech: 0), "window open before its deadline")
    check(followUpExpired(now: 10, deadline: 10, lastSpeech: 5), "window closes at its deadline in silence")
    check(!followUpExpired(now: 10.5, deadline: 10, lastSpeech: 10.4), "speech starting at the deadline gets a short grace")
    check(followUpExpired(now: 11.5, deadline: 10, lastSpeech: 11.45), "the deadline grace is bounded")

    // Gating and selection
    check(speakDecision(enabled: true, capturing: false, suspended: false, current: nil, incoming: .ack) == .play, "speech plays when idle")
    check(speakDecision(enabled: true, capturing: true, suspended: false, current: nil, incoming: .urgent) == .reject("capturing"), "never speak over an open microphone")
    check(speakDecision(enabled: false, capturing: false, suspended: false, current: nil, incoming: .urgent) == .reject("disabled"), "disabled replies are rejected")
    check(speakDecision(enabled: true, capturing: false, suspended: true, current: nil, incoming: .urgent) == .reject("suspended"), "no speech while asleep")
    check(speakDecision(enabled: true, capturing: false, suspended: false, current: .result, incoming: .result) == .replace, "equal priority replaces")
    check(speakDecision(enabled: true, capturing: false, suspended: false, current: .ack, incoming: .urgent) == .replace, "higher priority replaces")
    check(speakDecision(enabled: true, capturing: false, suspended: false, current: .urgent, incoming: .ack) == .queue, "lower priority queues")
    check(SpeakPriority(label: "urgent") == .urgent && SpeakPriority(label: "loud") == nil && SpeakPriority.ack.label == "ack", "priority labels")
    check(queuedUtteranceStale(priority: .ack, queuedAt: 0, now: 1.6) && !queuedUtteranceStale(priority: .ack, queuedAt: 0, now: 1.4) && !queuedUtteranceStale(priority: .result, queuedAt: 0, now: 9), "queued acknowledgements expire after 1.5 s")
    check(!standbyAllowed(speaking: true, now: 100, echoGuardUntil: 0), "no ambient listening while speaking")
    check(!standbyAllowed(speaking: false, now: 10.79, echoGuardUntil: 10.8), "no ambient listening during the echo guard")
    check(standbyAllowed(speaking: false, now: 10.8, echoGuardUntil: 10.8), "ambient listening resumes after the echo guard")
    check(echoGuard(bluetoothOutput: false) == 0.8 && echoGuard(bluetoothOutput: true) == 1.2, "the echo guard is 0.8 s, 1.2 s on Bluetooth output")
    check(bluetoothTransport(0x626C_7565) && bluetoothTransport(0x626C_6561), "Bluetooth and Bluetooth LE transports are detected")
    check(!bluetoothTransport(0x626C_746E) && !bluetoothTransport(0x7573_6220) && !bluetoothTransport(0), "built-in, USB and unknown transports use the normal guard")

    // Barge-in pre-roll mute, counted from the first captured buffer.
    var preRoll = PreRollMute(seconds: bargeInMuteSeconds)
    check(!preRoll.admits(at: 10.40), "the first buffer after the microphone starts is discarded")
    check(!preRoll.admits(at: 10.54), "capture stays muted until 0.15 s after the microphone started")
    check(preRoll.admits(at: 10.56), "capture reaches the recognizer 0.15 s after the microphone started")
    var slowStart = PreRollMute(seconds: bargeInMuteSeconds)
    // Key-down at 10.0, microphone delivering from 10.30: a mute from key-down would already have ended.
    check(!slowStart.admits(at: 10.30) && !slowStart.admits(at: 10.40) && slowStart.admits(at: 10.46), "a slow microphone start does not shorten the mute")
    var noMute = PreRollMute()
    check(noMute.admits(at: 0) && noMute.admits(at: 0.01), "without recent speech nothing is discarded")
    var invalidMute = PreRollMute(seconds: .nan)
    check(invalidMute.admits(at: 5), "an invalid mute length discards nothing")
    check(speechLanguageSupported(locale: "en-GB") && speechLanguageSupported(locale: "en_US") && !speechLanguageSupported(locale: "fr-FR"), "spoken replies are English only")
    let voices = [
        VoiceInfo(id: "a", name: "Zoe", language: "en-US", quality: .premium),
        VoiceInfo(id: "b", name: "Alex", language: "en-US", quality: .standard),
        VoiceInfo(id: "c", name: "Daniel", language: "en-GB", quality: .enhanced),
        VoiceInfo(id: "d", name: "Moira", language: "en-IE", quality: .enhanced),
        VoiceInfo(id: "e", name: "Bells", language: "en-US", quality: .premium, novelty: true),
        VoiceInfo(id: "f", name: "Mine", language: "en-US", quality: .premium, personal: true),
        VoiceInfo(id: "g", name: "Amelie", language: "fr-FR", quality: .premium),
        VoiceInfo(id: "h", name: "Evan", language: "en-US", quality: .enhanced),
    ]
    check(rankVoices(voices, language: "en-US").map { $0.id } == ["a", "h", "c", "d", "b"], "voices rank premium, enhanced, default and exact region first")
    check(rankVoices(voices, language: "en_GB").map { $0.id } == ["a", "c", "h", "d", "b"], "exact region match wins within a quality")
    check(!rankVoices(voices, language: "en-US").contains { $0.novelty || $0.personal }, "novelty and personal voices are excluded")
    check(rankVoices(voices, language: "").isEmpty, "unknown language lists no voices")
    check(chooseVoice(voices, selected: "b", language: "en-US")?.id == "b", "the selected voice wins while installed")
    check(chooseVoice(voices, selected: "gone", language: "en-US")?.id == "a", "a removed voice falls back to the best voice")
    check(chooseVoice(voices, selected: "", language: "de-DE")?.id == "a", "no locale voice falls back to en-US")
    check(chooseVoice([], selected: "", language: "en-US") == nil, "no voices keeps replies visual")
    check(VoiceQuality.standard.rawValue == "default" && VoiceQuality.none.rawValue == "none", "voice quality protocol names")
    check(abs(speechRate(multiplier: 1) - 0.5) < 1e-6 && abs(speechRate(multiplier: 0.8) - 0.45) < 1e-6 && abs(speechRate(multiplier: 1.4) - 0.6) < 1e-6, "speech rate maps the multiplier")
    check(speechRate(multiplier: 5) == 0.62 && speechRate(multiplier: 0) == 0.40 && speechRate(multiplier: .nan) == 0.5, "speech rate clamps")
    check(!shouldEndOnOptionRelease(spaceStillDown: true), "releasing Option while Space is held keeps talking")
    check(shouldEndOnOptionRelease(spaceStillDown: false), "releasing Option after Space ends the turn")
    for event in ["speech_started", "speech_finished", "speech_error", "followup_open", "followup_detected", "followup_closed", "endpoint_near", "turn_endpoint", "transcript_unconfirmed"] {
        check(!shouldDropOutput(event: event, pending: 500), "\(event) is never dropped")
    }

    // PCM helpers
    var carry: UInt8?
    let samples = pcmSamplesFromS16LE(Data([0x00, 0x00, 0xff, 0x7f, 0x00, 0x80, 0x01]), carry: &carry)
    check(samples.count == 3 && samples[0] == 0 && samples[1] == Float(32767) / 32768 && samples[2] == -1 && carry == 0x01, "s16le converts to Float32 and carries an odd byte")
    let carried = pcmSamplesFromS16LE(Data([0x00]), carry: &carry)
    check(carried == [Float(1) / 32768] && carry == nil, "a carried byte joins the next chunk")
    check(pcmSamplesFromS16LE(Data(), carry: &carry).isEmpty && carry == nil, "an empty chunk adds no samples")
    check(pcmChunkAccepted(seq: 0, expected: 0) && pcmChunkAccepted(seq: 3, expected: 1) && !pcmChunkAccepted(seq: 1, expected: 2) && pcmChunkAccepted(seq: nil, expected: 5), "chunks play in order, duplicates are ignored")
    check(!pcmReadyToStart(bufferedSamples: 2400, sampleRate: 24000, ended: false), "100 ms is not enough prebuffer")
    check(pcmReadyToStart(bufferedSamples: 4800, sampleRate: 24000, ended: false), "playback starts after 200 ms of audio")
    check(pcmReadyToStart(bufferedSamples: 1200, sampleRate: 24000, ended: true), "a short reply starts at its end")
    check(!pcmReadyToStart(bufferedSamples: 0, sampleRate: 24000, ended: true), "no audio never starts")
    check(validPcmSampleRate(24000) && !validPcmSampleRate(4000) && !validPcmSampleRate(.infinity), "sample rate bounds")
    check(pcmStalled(now: 12.5, requested: 0, lastActivity: 10, started: true, ended: false, playedUntil: 11), "no chunk for 2.5 s after the audio ran out is a stall")
    check(!pcmStalled(now: 12.4, requested: 0, lastActivity: 10, started: true, ended: false, playedUntil: 11), "a short network gap is not a stall")
    check(!pcmStalled(now: 13, requested: 0, lastActivity: 10, started: true, ended: false, playedUntil: 14), "buffered audio keeps playing through a gap")
    check(!pcmStalled(now: 20, requested: 0, lastActivity: 10, started: true, ended: true, playedUntil: 0), "an ended stream is not stalled")
    // Before speech_started: a slow first 200 ms from the cloud is not a stall until 4.0 s after playPcmStart.
    check(pcmFirstAudioSeconds == 4.0 && pcmStallSeconds == 2.5, "stall limits are 4.0 s before playback and 2.5 s after")
    check(!pcmStalled(now: 12.6, requested: 10, lastActivity: 10, started: false, ended: false, playedUntil: 0), "no first chunk 2.6 s after playPcmStart is still waiting")
    check(!pcmStalled(now: 13.99, requested: 10, lastActivity: 10, started: false, ended: false, playedUntil: 0), "no first chunk just under 4.0 s is still waiting")
    check(pcmStalled(now: 14.0, requested: 10, lastActivity: 10, started: false, ended: false, playedUntil: 0), "no first chunk 4.0 s after playPcmStart is a stall")
    check(!pcmStalled(now: 14.5, requested: 10, lastActivity: 13.5, started: false, ended: false, playedUntil: 0), "a first chunk at 3.5 s gets the normal 2.5 s gap before playback starts")
    check(pcmStalled(now: 16.0, requested: 10, lastActivity: 13.5, started: false, ended: false, playedUntil: 0), "a stream that stops before its prebuffer fills still ends")
    check(!pcmStalled(now: 30, requested: 10, lastActivity: 10, started: false, ended: true, playedUntil: 0), "an ended stream before playback is not stalled")
    check(pcmStalled(now: 13.0, requested: 10, lastActivity: 10.4, started: true, ended: false, playedUntil: 10.6), "after speech_started the 2.5 s guard is unchanged")

    // Voice key normalization
    for (input, key) in [("st stop", "stop"), ("no notes", "no notes"), ("Wait, wait, stop", "wait stop"), ("OK, stop.", "stop"),
                         ("um stop", "stop"), ("Yes, please.", "yes"), ("all right open notes", "open notes"),
                         ("open the open the notes app", "open the notes app"), ("don’t", "dont"), ("thank you", ""),
                         ("s-s-stop", "stop"), ("S-s-stop", "stop"), ("c-c-cancel", "cancel"), ("w-w-wait", "wait"), ("n-n-no", "no"),
                         ("st st stop", "stop"), ("St. St. Stop.", "stop"), ("st-st-stop", "stop"), ("s s s s s s s s s s stop", "stop"),
                         ("s st sto stop", "stop"), ("h-hold up", "hold up"), ("please hold up", "please hold up"),
                         ("e-mail John", "e mail john"), ("no-notes", "no notes")] {
        check(normalizeVoiceKey(input) == key, "voice key \"\(input)\" is \"\(key)\"")
    }
    // Hyphens and spaces normalize identically, and stutter removal reaches a fixed point.
    for spoken in ["s s stop", "c c cancel", "w w wait", "n n no", "st st st stop", "o o o open notes", "t t the the notes"] {
        let hyphenated = spoken.split(separator: " ").dropLast().joined(separator: "-") + "-" + String(spoken.split(separator: " ").last!)
        let key = voiceKeyBase(spoken)
        check(voiceKeyBase(hyphenated) == key, "\"\(hyphenated)\" normalizes like \"\(spoken)\"")
        check(voiceKeyBase(key.joined(separator: " ")) == key, "stutter removal is a fixed point for \"\(spoken)\"")
    }
    check(normalizeVoiceKey("n-n-no") == "no" && !isControlPhrase("n-n-no") && utteranceCompleteness("n-n-no", context: .approval) == .shortAnswer, "a stuttered no is a decline, not a control phrase")
    check(utteranceCompleteness("um", context: .command) == .incomplete, "filler-only speech is still thinking")
    check(utteranceCompleteness("go on", context: .command) == .complete, "a bare reply is complete in command context")
    check(utteranceCompleteness("Safari", context: .answer) == .shortAnswer, "a one-word answer is a short answer")
    check(utteranceCompleteness("go to", context: .answer) == .incomplete, "an unfinished answer is not short")
    check(utteranceCompleteness("thanks", context: .approval) == .shortAnswer, "acknowledgement is a short answer")
    check(utteranceCompleteness("check", context: .command) == .incomplete, "a single action verb is unfinished")

    // Shared fixture parity with the TypeScript voice language.
    let fixturePath = FileManager.default.currentDirectoryPath + "/tests/fixtures/voice-phrases.json"
    guard let bytes = FileManager.default.contents(atPath: fixturePath),
          let fixture = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] else {
        check(false, "voice phrase fixture is readable from the repository root"); return
    }
    func phrases(_ key: String) -> [String] { fixture[key] as? [String] ?? [] }
    check(!phrases("stop").isEmpty && !phrases("pause").isEmpty && !phrases("incomplete").isEmpty, "voice phrase fixture has categories")
    for phrase in phrases("stop") + phrases("pause") { check(isControlPhrase(phrase), "fixture control phrase: \(phrase)") }
    for category in ["resume", "approve", "decline", "unclear", "acknowledge", "command"] {
        for phrase in phrases(category) { check(!isControlPhrase(phrase), "fixture \(category) is not a control phrase: \(phrase)") }
    }
    for category in ["resume", "approve", "decline", "acknowledge"] {
        for phrase in phrases(category) { check(utteranceCompleteness(phrase, context: .answer) == .shortAnswer, "fixture \(category) is a short answer: \(phrase)") }
    }
    for phrase in phrases("incomplete") { check(utteranceCompleteness(phrase, context: .command) == .incomplete, "fixture incomplete: \(phrase)") }
    for phrase in phrases("complete") {
        let completeness = utteranceCompleteness(phrase, context: .command)
        check(completeness == (isControlPhrase(phrase) ? .control : .complete), "fixture complete: \(phrase)")
    }
    let echoes = fixture["wakeEcho"] as? [[String: String]] ?? []
    check(!echoes.isEmpty, "fixture has wake echo cases")
    for echo in echoes { check(stripWakeEcho(echo["in"] ?? "") == echo["out"], "fixture wake echo: \(echo["in"] ?? "")") }
    for phrase in phrases("assistantPhrases") {
        check(commandAfterWakePhrase(phrase) == nil && !isControlPhrase(phrase) && phrase.range(of: "assist", options: .caseInsensitive) == nil,
              "assistant phrase cannot wake, stop or pause: \(phrase)")
    }
}
