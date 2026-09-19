import Foundation

// Pure wake-phrase, final-recognition and endpoint checks for Voice.swift.
func wakePolicyChecks(_ check: (Bool, String) -> Void) {
    // The full accept, gate and never-accept lists are fixture-driven in TurnPolicyTests.swift
    // (tests/fixtures/voice-phrases.json "wake"); these are the rules, one case each.
    check(commandAfterWakePhrase("Hey Butler, open Notes.") == "open Notes.", "wake phrase stripped from command")
    check(commandAfterWakePhrase(" HEY, Butler! Stop.") == "Stop.", "case and punctuation in wake phrase")
    check(commandAfterWakePhrase("Hey Butler") == "", "wake phrase alone opens command window")
    check(commandAfterWakePhrase("Say Hey Butler to open it") == nil, "embedded wake phrase does not activate")
    check(commandAfterWakePhrase("Hey Butlerson open Notes") == nil && commandAfterWakePhrase("Hey Lisa, open Notes") == nil, "a longer name or another name does not activate")
    check(commandAfterWakePhrase("Hey Assist, open Notes") == nil, "the old wake phrase no longer activates")
    check(commandAfterWakePhrase("Hey Butler table free?") == nil && commandAfterWakePhrase("Hey, is a table free?") == nil,
          "the name followed by an ordinary word is \"hey, is a…\": the gate keeps it asleep")
    check(commandAfterWakePhrase("Hey Butler open Safari") == "open Safari" && commandAfterWakePhrase("Hey Butler can you open Safari") == "can you open Safari",
          "a task verb or a question opener after the name passes the gate")
    check(commandAfterWakePhrase("Yes") == nil, "ambient approval cannot wake assistant")
    check(commandAfterWakePhrase("Stop") == nil, "ambient command cannot wake assistant")
    // Live partials: a hypothesis that stops right at the name waits for the next word or a pause.
    check(commandAfterWakePhrase("Hey Butler", ended: false) == nil && wakePhraseAwaitingPause("Hey Butler"), "a live \"Hey Butler\" waits")
    check(commandAfterWakePhrase("Hey Butler open", ended: false) == "open", "a task verb arriving activates at once")
    check(commandAfterWakePhrase("Hey Butler,", ended: false) == "", "recognizer punctuation is a pause")
    check(!wakePhraseAwaitingPause("Hey Butler table") && !wakePhraseAwaitingPause("Butler") && !wakePhraseAwaitingPause("Hey"), "only the wake phrase alone waits for a pause")
    check(!wakePauseElapsed(now: 10.59, lastText: 10, lastSpeech: 10) && wakePauseElapsed(now: 10.6, lastText: 10, lastSpeech: 10.3),
          "a lone wake phrase activates after 0.6 s of unchanged text and 0.3 s of quiet")
    check(!wakePauseElapsed(now: 11.1, lastText: 10, lastSpeech: 11.0), "speech still arriving keeps it waiting")
    check(wakePauseElapsed(now: 11.2, lastText: 10, lastSpeech: 11.2), "steady background sound cannot hold it past 1.2 s of unchanged text")
    // Standby: words appended after a pause in the partials begin a new utterance (2026-09-19:
    // one hypothesis ran through a whole conversation and swallowed every wake phrase in it).
    check(utteranceBoundary(previous: "the meeting moved to Thursday", current: "the meeting moved to Thursday Hey Butler", boundary: 0, gapSeconds: 0.7) == 29,
          "words appended after a 0.6 s pause begin a new utterance")
    check(utteranceBoundary(previous: "the meeting moved", current: "the meeting moved to Thursday", boundary: 0, gapSeconds: 0.2) == 0,
          "words appended without a pause continue the utterance")
    check(utteranceBoundary(previous: "the meeting moved Hey Butler", current: "the meeting moved Hey Butler open Notes", boundary: 18, gapSeconds: 0.9) == 18,
          "a pause after a lone wake phrase keeps the utterance at the wake phrase")
    check(utteranceBoundary(previous: "", current: "Hey Butler", boundary: 0, gapSeconds: 5) == 0, "the first words start at the start")
    check(utteranceBoundary(previous: "Hey", current: "Hey Butler what time is it", boundary: 0, gapSeconds: 0.8) == 0,
          "a stall after \"Hey\" keeps the utterance whole (live 2026-09-19)")
    check(utteranceBoundary(previous: "He", current: "Hey Butler", boundary: 0, gapSeconds: 0.8) == 0,
          "a first word still being spelled out is the recognizer catching up, not a pause")
    check(utteranceBoundary(previous: "So", current: "So Hey Butler open Notes", boundary: 0, gapSeconds: 0.8) == 2,
          "a whole word, a pause, then the wake phrase begins a new utterance")
    check(utteranceBoundary(previous: "the meeting moved Hey", current: "the meeting moved Hey Butler open", boundary: 18, gapSeconds: 0.9) == 18,
          "a pause after \"Hey\" inside a conversation keeps the utterance at the \"Hey\"")
    check(utteranceBoundary(previous: "the meeting moved to Thursday Hey Butler", current: "the meeting moved to Tuesday Hey Butler open", boundary: 29, gapSeconds: 0.1) == 29,
          "a revision of earlier words keeps the boundary while it fits")
    check(commandAfterWakePhrase(String("the meeting moved to Thursday Hey Butler open Notes".dropFirst(29)), ended: false) == "open Notes",
          "the utterance after the boundary activates as if it had started the hypothesis")
    check(recognizerContext(ambient: true) == ["Hey Butler"] && recognizerContext(ambient: false).isEmpty,
          "the recognizer is biased toward the wake phrase only while listening for it")
    check(commandAfterWakeRestart("Butler open calendar and put an event") == "open calendar and put an event", "the bare name restarts a turn already listening")
    check(commandAfterWakeRestart("Butler, open Notes.") == "open Notes.", "restart ignores case and punctuation")
    check(commandAfterWakeRestart("Hey, Butler! Stop.") == "Stop.", "the full wake phrase restarts")
    check(commandAfterWakeRestart("Butler. Open Safari") == "Open Safari" && commandAfterWakeRestart("Butler — open, then close") == "open, then close", "the name set apart restarts")
    check(commandAfterWakeRestart("Butler") == "" && commandAfterWakeRestart("Butler.") == "", "a lone wake phrase leaves nothing yet")
    check(commandAfterWakeRestart("Butler open Safari") == "open Safari" && commandAfterWakeRestart("Butler in the UK, the allowance is twenty thousand pounds") == nil,
          "the letters form keeps its own final dot, so a sentence about the savings account is not a restart")
    check(commandAfterWakeRestart("Butler the weather in Denver") == nil && commandAfterWakeRestart("Esa launched a new satellite") == nil,
          "the bare name followed by anything but a task verb is a word")
    check(commandAfterWakeRestart("Butler's number is 555") == nil, "a possessive is a word")
    check(commandAfterWakeRestart("Hey sir, can I help you with that?") == nil && commandAfterWakeRestart("I say we leave at six") == nil,
          "an echo spelling never restarts")
    check(commandAfterWakeRestart("go to Butler settings") == nil && commandAfterWakeRestart("ask it to assist") == nil, "the name inside a request does not restart")
    check(commandAfterWakePhrase("Butler open Notes") == nil, "activation is not widened by restarts")
    check(activatedVoiceCommand("Hey Butler, open Notes") == "open Notes", "activated session strips repeated wake prefix")
    check(activatedVoiceCommand("Hey Butler the weather in Denver") == "the weather in Denver",
          "after a real activation the prefix goes whatever follows it (\"Hey Butler\", a pause, then the request)")
    check(startsWithWakePhrase("Hey Butler table") && !startsWithWakePhrase("open notes"), "diagnostics label wake-prefixed segments")
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
    check(turnEndpoint(now: 10, started: 0, lastSpeech: 8.5, lastText: 8.0, hasText: true, completeness: .complete, patience: .normal) == .finish, "command ends after stable text and silence")
    check(commandLooksIncomplete("Open"), "a lone verb is an unfinished command")
    check(commandLooksIncomplete("search the web for"), "a trailing connector is unfinished")
    check(commandLooksIncomplete("can you"), "a trailing request bigram is unfinished")
    check(!commandLooksIncomplete("Open Calculator"), "a verb with its object is complete")
    check(!commandLooksIncomplete("close that"), "a demonstrative object is complete")
    check(!commandLooksIncomplete("stop"), "control phrases are never held open")
    check(!commandLooksIncomplete(""), "empty text is not treated as unfinished")
    check(turnEndpoint(now: 10, started: 0, lastSpeech: 8.7, lastText: 8.6, hasText: true, completeness: .incomplete, patience: .normal) == .none, "an unfinished command survives a short pause")
    check(turnEndpoint(now: 12, started: 0, lastSpeech: 9.4, lastText: 8.5, hasText: true, completeness: .incomplete, patience: .normal) == .finish, "an unfinished command still ends after a long pause")
    check(turnEndpoint(now: 10, started: 0, lastSpeech: 9.5, lastText: 8, hasText: true, completeness: .complete, patience: .normal) == .none, "ongoing speech prevents submission")
    check(turnEndpoint(now: 10, started: 0, lastSpeech: 8, lastText: 9.5, hasText: true, completeness: .complete, patience: .normal) == .none, "late recognition update postpones submission")
    check(turnEndpoint(now: 10, started: 0, lastSpeech: 0, lastText: 0, hasText: false, completeness: .complete, patience: .normal) == .empty, "empty wake expires without command")
    check(turnEndpoint(now: 45, started: 0, lastSpeech: 45, lastText: 45, hasText: true, completeness: .complete, patience: .normal) == .finish, "command capture has a hard time limit")
    check(turnEndpoint(now: 10, started: 0, lastSpeech: 10, lastText: 6.0, hasText: true, completeness: .complete, patience: .normal) == .finish, "steady background sound cannot hold stable text open")
    check(turnEndpoint(now: 10, started: 0, lastSpeech: 10, lastText: 6.1, hasText: true, completeness: .complete, patience: .normal) == .none, "text-driven endpoint waits for a longer pause while sound continues")
    check(turnEndpoint(now: 10, started: 0, lastSpeech: 9.1, lastText: 8.0, hasText: true, completeness: .complete, patience: .normal) == .none, "fast path needs a full quiet period")
    check(standbyEndpoint(now: 3, started: 0, lastText: 0) == .none, "ambient sound does not restart standby recognition")
    check(standbyEndpoint(now: 20, started: 0, lastText: 18) == .none, "background utterance keeps the standby recognizer running")
    check(standbyEndpoint(now: 45, started: 0, lastText: 44) == .none, "standby rotation defers while partial text is arriving")
    check(standbyEndpoint(now: 45.6, started: 0, lastText: 44) == .recycle, "standby rotation resumes once partial text settles")
    check(standbyEndpoint(now: 46, started: 10, lastText: 10) == .none, "rotation measured from the standby session start")
    check(standbyEndpoint(now: 44, started: 0, lastText: 0) == .none, "silence does not constantly restart recognition")
    check(standbyEndpoint(now: 45, started: 0, lastText: 0) == .recycle, "standby recognition rotates before one minute")
    check(shouldSwallowSpace(keyCode: 49, consumed: true, isKeyUp: true, autorepeat: false), "consumed shortcut swallows the trailing Space keyUp")
    check(shouldSwallowSpace(keyCode: 49, consumed: true, isKeyUp: false, autorepeat: true), "consumed shortcut swallows Space autorepeat")
    check(!shouldSwallowSpace(keyCode: 49, consumed: true, isKeyUp: false, autorepeat: false), "fresh Space press after a missed keyUp is not eaten")
    check(!shouldSwallowSpace(keyCode: 49, consumed: false, isKeyUp: false, autorepeat: false), "ordinary Space passes through")
    check(!shouldSwallowSpace(keyCode: 49, consumed: false, isKeyUp: true, autorepeat: false), "ordinary Space keyUp passes through")
    check(!shouldSwallowSpace(keyCode: 0, consumed: true, isKeyUp: true, autorepeat: true), "other keys pass through while Space is held")
    for phrase in ["Stop", "stop.", "Stop now!", "Cancel", "cancel task", "OK, stop.", "stop it please", "Wait", "Pause.", "Hold on", "hang on", "One moment", "one sec", "One second, please", "Just a moment", "wait a sec", "Wait a minute.", "  STOP  ", "Hey stop", "Okay stop", "please stop", "No, cancel", "never mind", "hold up"] {
        check(isControlPhrase(phrase), "control phrase recognized after endpoint: \(phrase)")
    }
    // Pause heads combine like src/voice/turns.ts PAUSE_UTTERANCE, not only as exact keys.
    for phrase in ["please hold up", "hold up wait", "wait hold up", "just a sec wait", "please just a sec", "Hold up, hold up.",
                   "no, just a sec", "give me a second please", "wait, give me a second", "hold up a sec", "no please hold up",
                   "one sec, just a sec", "just a sec for me"] {
        check(isControlPhrase(phrase), "pause head combines: \(phrase)")
    }
    // Hyphen-joined and dotted stutters normalize like spoken ones.
    for phrase in ["s-s-stop", "S-s-stop", "c-c-cancel", "w-w-wait", "st st stop", "St. St. Stop.", "st-st-stop", "h-hold on", "p-p-pause"] {
        check(isControlPhrase(phrase), "stutter control phrase: \(phrase)")
    }
    for phrase in ["", "Open Notes", "Stop the music in Spotify", "Don't stop", "wait for the download then open it", "Yes", "resume", "stop and open Safari", "pause the video", "No", "no notes", "okay", "thank you", "stop sharing my screen now",
                   "hold up the sign", "just a second ago I opened it", "give me a second option", "n-n-no", "hold upstairs", "wait-list the email"] {
        check(!isControlPhrase(phrase), "arbitrary text is not a control phrase: \(phrase)")
    }
    check(normalizeVoicePhrase(" Hold,  on! ") == "hold on", "normalization strips punctuation and collapses spaces")
    check(validControllerPath("/Applications/Butler.app/Contents/Resources/coarena-controller"), "packaged controller path accepted")
    check(validControllerPath("/Users/me/open-assist/native/bin/coarena-controller"), "development controller path accepted")
    check(!validControllerPath("/usr/bin/coarena-controller-helper"), "similar executable name rejected")
    check(!validControllerPath("/Applications/Safari.app/Contents/MacOS/Safari"), "recycled pid owned by another app rejected")
    check(!validControllerPath(""), "unresolvable pid path rejected")
    check(eventUptime(timestamp: 2_621_020_095_458, now: 2621.3, numer: 125, denom: 3) == 2621.020095458, "nanosecond event timestamps map to uptime")
    check(abs((eventUptime(timestamp: 62_904_482_291, now: 2621.3, numer: 125, denom: 3) ?? 0) - 2621.020095458) < 1e-3, "mach tick event timestamps map to uptime")
    check(eventUptime(timestamp: 0, now: 2621.3, numer: 125, denom: 3) == nil, "missing event timestamp falls back to callback time")
    check(eventUptime(timestamp: 5_000_000_000, now: 2621.3, numer: 125, denom: 3) == nil, "implausible event timestamp falls back to callback time")
    check(eventUptime(timestamp: 2_621_000_000_000, now: 2621.3, numer: 1, denom: 1) == 2621.0, "Intel timebase is nanoseconds")
    check(shortcutRelease(heldFor: 2621.08 - 2621.0, audioAttempted: true, pushToTalkActive: true) == .tap, "a quick tap stays a tap while the microphone starts")
    check(shortcutRelease(heldFor: 0.1, audioAttempted: false, pushToTalkActive: false) == .tap, "quick press opens text entry")
    check(shortcutRelease(heldFor: 0.17, audioAttempted: false, pushToTalkActive: false) == .tap, "hold released before audio started is not silent")
    check(shortcutRelease(heldFor: 1, audioAttempted: true, pushToTalkActive: true) == .end, "push-to-talk release ends the command")
    check(shortcutRelease(heldFor: 1, audioAttempted: true, pushToTalkActive: false) == .ignore, "failed audio start already reported its error")
    check(!shouldDropOutput(event: "audio_level", pending: 20), "levels flow while output keeps up")
    check(shouldDropOutput(event: "audio_level", pending: 21), "levels dropped when stdout backs up")
    check(!shouldDropOutput(event: "transcript_final", pending: 500), "transcripts are never dropped")
}
