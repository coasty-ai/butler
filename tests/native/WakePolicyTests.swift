import Foundation

// Pure wake-phrase, final-recognition and endpoint checks for Voice.swift.
func wakePolicyChecks(_ check: (Bool, String) -> Void) {
    check(commandAfterWakePhrase("Hey Assist, open Notes.") == "open Notes.", "wake phrase stripped from command")
    check(commandAfterWakePhrase(" HEY, OPEN ASSIST! Stop.") == "Stop.", "case and punctuation in wake phrase")
    check(commandAfterWakePhrase("Hey Assist") == "", "wake phrase alone opens command window")
    check(commandAfterWakePhrase("Say Hey Assist to open it") == nil, "embedded wake phrase does not activate")
    check(commandAfterWakePhrase("Hey assistant open Notes") == nil, "partial word does not activate")
    check(commandAfterWakePhrase("Yes") == nil, "ambient approval cannot wake assistant")
    check(commandAfterWakePhrase("Stop") == nil, "ambient command cannot wake assistant")
    check(activatedVoiceCommand("Hey Assist, open Notes") == "open Notes", "activated session strips repeated wake prefix")
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
    check(validControllerPath("/Applications/Open Assist.app/Contents/Resources/coarena-controller"), "packaged controller path accepted")
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
