import Foundation
import AppKit
import AVFoundation
import Speech
import Carbon
import CoreAudio

// State belongs to the main run loop. Audio is processed on-device, never saved.
// Writes go through one serial queue so a stalled stdout reader can never block the
// main thread or the keyboard event tap (macOS disables a tap that stops returning).
let outputQueue = DispatchQueue(label: "voice.output")
let pendingLock = NSLock()
var pendingOutput = 0
func output(_ data: [String: Any]) {
    pendingLock.lock()
    if shouldDropOutput(event: data["event"] as? String, pending: pendingOutput) { pendingLock.unlock(); return }
    pendingOutput += 1; pendingLock.unlock()
    guard let bytes = try? JSONSerialization.data(withJSONObject: data) else {
        pendingLock.lock(); pendingOutput -= 1; pendingLock.unlock(); return
    }
    outputQueue.async {
        FileHandle.standardOutput.write(bytes + Data([10]))
        pendingLock.lock(); pendingOutput -= 1; pendingLock.unlock()
    }
}
// standby: waiting for the wake phrase. followUp: a short window after a reply or a turn,
// before speech is detected (behaves like standby: nothing is emitted). handsFree and
// pushToTalk: an activated command turn.
enum ListenMode { case standby, followUp, handsFree, pushToTalk }
enum TurnCompletion { case final, emptyFinal, deadline, error }
var speech = SFSpeechRecognizer(locale: Locale(identifier: Locale.preferredLanguages.first ?? "en-US"))
let engine = AVAudioEngine()
var request: SFSpeechAudioBufferRecognitionRequest?
var task: SFSpeechRecognitionTask?
// The input tap runs on an audio thread: it reads the live request and the barge-in mute, and
// fills the pre-roll ring, under this lock.
let tapLock = NSLock()
var tapRequest: SFSpeechAudioBufferRecognitionRequest?
var tapMute = PreRollMute()
// The last 1.5 s of capture, in memory only, for a standby request rotated on cadence to hear first.
var tapRing = PreRollRing<AVAudioPCMBuffer>(seconds: standbyPreRollSeconds)
var tap: CFMachPort?
var mode: ListenMode?
var keyHeld = false
var heldAt: TimeInterval = 0
var startedAt: TimeInterval = 0
var lastSpeechAt: TimeInterval = 0
var lastTextAt: TimeInterval = 0
var rotatedAt: TimeInterval = 0
var released = false
var shortcutUpSent = false
var generation = 0
var segmentGeneration = 0
var wakeSegment = -1
var errorRotations = 0
var turn = TurnTranscript()
var turnContext = TurnContext.command
var noiseFloor = NoiseFloor()
var windowKind = FollowUpKind.continuation
var windowDeadline: TimeInterval = 0
var windowRun = SpeechRun()
var pendingWindow: DispatchWorkItem?
var pendingWindowKind: FollowUpKind?
// A reply closed a conversation-mode window (half duplex: no listening while Butler speaks) and
// asked for no window of its own: the window reopens when the reply ends (speechEnded). Cleared by
// the closes that are the user's (closeWindow: a key-down, a cancel, Electron's endFollowUp).
var resumeWindowAfterSpeech = false
var endpointNearSent = false
var completenessCache: (text: String, context: TurnContext, value: Completeness) = ("", .command, .complete)
var controllerPID: pid_t = 0
var delayedStart: DispatchWorkItem?
var finalDeadline: DispatchWorkItem?
var releaseTail: DispatchWorkItem?
var restart: DispatchWorkItem?
var audioTapInstalled = false
var handsFreeEnabled = false
// Off until Electron's configure turns them on, so an older main process that does not
// understand follow-up windows or earcons never gets them.
var followUpEnabled = false
var soundsEnabled = false
// The phrases every request is biased toward (recognizerContext), from Electron's configure.
var vocabulary: [String] = []
var patience = Patience.normal
var followUpWindow = FollowUpWindow.short
var suspended = false
var containsWakePhrase = false
// The latest ambient hypothesis is the wake phrase alone: it activates once the speaker pauses.
var pendingWake = false
var lastWakeError = ""
var wakeListening = false
var maintenance: Timer?
var observers: [NSObjectProtocol] = []
var wakeOffPending: DispatchWorkItem?
var pushAudioAttempted = false
var spaceSwallowed = false
var optionReleased = false
var spaceUpTicks = 0
var securePaused = false
// Local trial diagnostics only: BUTLER_TRACE_STANDBY in the helper's environment ("1", or
// "text" to include the words) reports what ambient listening saw and did, so an unheard
// wake phrase can be told from a deaf microphone. The packaged app never sets it; without it,
// background speech never leaves this process.
let standbyTrace = ProcessInfo.processInfo.environment["BUTLER_TRACE_STANDBY"] ?? ""
var tapBuffers = 0, lastRms = 0.0, lastStandbyTraceAt = 0.0
// Ambient listening: the hypothesis as last seen, when its text began and last changed, where
// its latest utterance begins (utteranceBoundary), and the offset the activated turn strips as
// the room's words.
var standbyRaw = "", standbyTextAt = 0.0, standbyChangedAt = 0.0, standbyBoundary = 0, wakeOffset = 0
private let traceOpener = try! NSRegularExpression(pattern: #"^\s*(?:\#(wakeHeyPattern)\b|\#(wakeNamePattern)(?![a-z]))"#, options: .caseInsensitive)
/// The first three words of an utterance that opens like a wake attempt ("Hey …", or the name
/// itself, which wakes on its own): speech addressed to Butler, never the room's, and only as
/// much as the wake matcher looked at, from the utterance boundary on. Cycle 2, 2026-09-19:
/// "Hey Butler, type …" grew to 15 characters, was revised, and never woke; lengths alone could
/// not say what the name became. A bare-name attempt the recognizer wrote as "Butlers" or
/// "Batala" shows here; one written as "but a lot" is the room's words to this trace.
func wakeHead(_ utterance: String) -> String? {
    guard traceOpener.firstMatch(in: utterance, range: NSRange(utterance.startIndex..., in: utterance)) != nil else { return nil }
    return utterance.split(whereSeparator: { $0.isWhitespace }).prefix(3).joined(separator: " ")
}
func traceStandby(_ kind: String, _ raw: String? = nil, error: String? = nil, extra: [String: Any] = [:]) {
    guard !standbyTrace.isEmpty else { return }
    var event: [String: Any] = ["event": "standby_trace", "kind": kind, "sinceStartMs": Int(((uptime() - startedAt) * 1000).rounded())]
    if let raw {
        event["textLength"] = raw.count
        if standbyTrace == "text" { event["text"] = raw } else if let head = wakeHead(standbyBoundary > 0 ? String(raw.dropFirst(standbyBoundary)) : raw) { event["wakeHead"] = head }
    }
    if let error { event["message"] = error }
    for (key, value) in extra { event[key] = value }
    output(event)
}
var shuttingDown = false
var parentExit: DispatchSourceProcess?
var echoGuardUntil: TimeInterval = 0
var inputRestart: DispatchWorkItem?
var inputRestarts: [TimeInterval] = []
// Sampled when a reply is accepted (main thread, never inside the event tap), used at its end.
var outputBluetooth = false
let speaker = Speaker()
let secureInputMessage = "Voice is unavailable in secure input fields."
func uptime() -> TimeInterval { ProcessInfo.processInfo.systemUptime }
func trimmed(_ text: String) -> String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
// BUTLER_FULL_DUPLEX=1 in the helper's environment (local A/B trials on one build): the speaker's
// PCM and the earcons play through the input engine, whose input node runs voice processing
// (echo cancellation against that very playback, noise suppression, gain control), so ambient
// listening continues while Butler speaks (standbyAllowed, isSelfEcho, interruptsSpeech). Unset,
// the default and the packaged app, the half-duplex path is untouched: listening pauses while
// Butler speaks and for the echo guard after. Voice processing is asked for once, before the
// engine first starts; a start that then fails (a microphone and a speaker that are different
// devices: err -10875) turns it off for good, and the helper is half duplex again.
let fullDuplexRequested = ProcessInfo.processInfo.environment["BUTLER_FULL_DUPLEX"] == "1"
var voiceProcessing = false
// The last outcome reported (voice_processing): enabled or not.
var voiceProcessingReported: Bool?
// The channel of voice processing's multi-channel input the tap reads (ChannelChoice), chosen in the
// first 200 ms of capture and kept for the sessions after; a device change chooses again. And the
// watch that turns voice processing off when what it delivers is silence (SilenceWatch).
var tapChoice = ChannelChoice()
var silenceWatch = SilenceWatch()
// Listening continues through a reply only when voice processing has that reply as its reference:
// PCM through the shared engine. The system voice plays outside it and keeps the half-duplex guard.
var listenWhileSpeaking: Bool { fullDuplexRequested && voiceProcessing && speaker.echoCancelled }
func enableFullDuplex() {
    speaker.shareEngine(engine)
    loadEngineEarcons(engine)
    do {
        try engine.inputNode.setVoiceProcessingEnabled(true)
        voiceProcessing = true
        // Voice processing ducks other audio by default: never the owner's music, for Butler's microphone.
        if #available(macOS 14.0, *) {
            engine.inputNode.voiceProcessingOtherAudioDuckingConfiguration = .init(enableAdvancedDucking: false, duckingLevel: .min)
        }
    } catch { reportVoiceProcessing(reason: "unsupported", error: error) }
}
// Starts the engine for whichever side needs it first: the microphone tap, or under full duplex
// a reply or an earcon. With voice processing on, the start itself is the test: a failure turns
// it off, reports once, and the engine starts again without it; a start that still fails is the
// caller's error, as before.
func startEngine() throws {
    engine.prepare()
    do { try engine.start() } catch {
        guard voiceProcessing else { throw error }
        disableVoiceProcessing(reason: "start_failed", error: error)
        engine.prepare(); try engine.start()
    }
    // Enabled is reported by the tap, once it has chosen the channel it reads (channelChosen).
    if !voiceProcessing { reportVoiceProcessing() }
}
// The engine stops when nothing needs it: the microphone tap, or under full duplex a reply or an
// earcon still playing.
func stopEngineIfIdle() {
    guard engine.isRunning, !audioTapInstalled, !speaker.holdsEngine, !earconSounding(at: uptime()) else { return }
    engine.stop()
}
// At each outcome, never the same one twice: enabled, with the format the tap gets and the channel
// it reads with that channel's level over the first 200 ms; or not, with why. Without the flag the
// reason is "off", so a trace says which arm of the A/B it comes from. A tap that turns out silent
// follows the enabled report with a disabled one ("silent").
func reportVoiceProcessing(reason: String? = nil, error: Error? = nil, format: AVAudioFormat? = nil, choice: ChannelChoice? = nil) {
    guard voiceProcessingReported != voiceProcessing else { return }
    voiceProcessingReported = voiceProcessing
    var event: [String: Any] = ["event": "voice_processing", "enabled": voiceProcessing]
    if let format, let choice {
        event["sampleRate"] = format.sampleRate; event["channels"] = Int(format.channelCount); event["interleaved"] = format.isInterleaved
        event["micChannel"] = choice.channel; event["micLevel"] = Int((choice.level * 1000).rounded())
    } else {
        event["reason"] = reason ?? "off"
        if let error = error { event["message"] = error.localizedDescription }
    }
    output(event)
}
// The tap's first 200 ms under voice processing chose the channel it reads: kept for the sessions
// after (the next tap starts decided), and the enabled outcome reported with it.
func channelChosen(_ choice: ChannelChoice, format: AVAudioFormat) {
    guard voiceProcessing else { return }
    tapChoice = choice
    reportVoiceProcessing(format: format, choice: choice)
}
// Nine minutes of buffers with an RMS of exactly 0 (2026-09-19): voice processing that delivers
// silence is turned off for good, and capture resumes in the input's own format (resumeInput: a
// fresh request, the tap in that format), on the engine a queued reply may already have started.
// The tap comes off first: the engine's next start must not find it in the format that is gone.
func voiceProcessingSilent() {
    if audioTapInstalled { engine.inputNode.removeTap(onBus: 0); audioTapInstalled = false }
    disableVoiceProcessing(reason: "silent")
    resumeInput()
}
// Voice processing can only change while the engine is stopped; a reply playing through it ends
// as cancelled, as it does when a route change stops the engine, and only after the change, since
// its queued successor may start the engine again at once.
func disableVoiceProcessing(reason: String, error: Error? = nil) {
    voiceProcessing = false
    let wasRunning = engine.isRunning
    if wasRunning { engine.stop() }
    try? engine.inputNode.setVoiceProcessingEnabled(false)
    reportVoiceProcessing(reason: reason, error: error)
    if wasRunning { speaker.sharedEngineStopped() }
}
// Full duplex only: half duplex never hears the reply, so the same words then are the owner's.
func selfEcho(_ utterance: String, now: TimeInterval) -> Bool {
    guard listenWhileSpeaking, let spoken = speaker.spokenText(at: now) else { return false }
    return isSelfEcho(utterance, spoken: spoken)
}
// How long ambient listening still has to wait for the reply's tail (nothing under full duplex).
func echoGuardWait() -> Double { listenWhileSpeaking ? 0 : max(0, echoGuardUntil - uptime()) }
// Internal standby restarts take a few hundred ms; only report "not listening" when
// it lasts, so the tray reflects real enable/disable/error transitions only.
func setWakeListening(_ value: Bool) {
    if value {
        wakeOffPending?.cancel(); wakeOffPending = nil
        guard !wakeListening else { return }
        wakeListening = true
        output(["event": "wake_status", "enabled": handsFreeEnabled, "listening": true])
        return
    }
    guard wakeListening, wakeOffPending == nil else { return }
    let work = DispatchWorkItem {
        wakeOffPending = nil
        guard wakeListening, mode != .standby, mode != .followUp else { return }
        wakeListening = false
        output(["event": "wake_status", "enabled": handsFreeEnabled, "listening": false])
    }
    wakeOffPending = work; DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: work)
}
func signalController() {
    // SIGUSR1 terminates processes without a handler: confirm the pid is still ours.
    guard controllerPID > 0, kill(controllerPID, 0) == 0 else { return }
    var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
    guard proc_pidpath(controllerPID, &buffer, UInt32(buffer.count)) > 0,
          validControllerPath(String(cString: buffer)) else { return }
    kill(controllerPID, SIGUSR1)
}
func shutdown() {
    guard !shuttingDown else { return }; shuttingDown = true
    // Arm the hard exit first: engine or recognizer teardown must not orphan the helper.
    DispatchQueue.global().asyncAfter(deadline: .now() + 0.3) { _exit(0) }
    handsFreeEnabled = false; restart?.cancel(); delayedStart?.cancel(); finalDeadline?.cancel()
    releaseTail?.cancel(); pendingWindow?.cancel(); maintenance?.invalidate()
    speaker.shutdown()
    if let tap = tap { CGEvent.tapEnable(tap: tap, enable: false) }
    generation += 1; mode = nil
    if engine.isRunning { engine.stop() }
}
// muteSeconds: capture discarded from the first buffer the microphone delivers (barge-in pre-roll).
// preRoll: the ring's last 1.5 s reach the request before the live buffers switch to it, in the
// same critical section, so no buffer is fed twice or skipped at the seam. Every other switch
// empties the ring: the capture behind a fresh request (or a reinstalled tap, in a new format)
// is never replayed.
func setTapInput(_ live: SFSpeechAudioBufferRecognitionRequest?, muteSeconds: Double? = nil, preRoll: Bool = false) {
    tapLock.lock()
    let held = tapRing.drain()
    if preRoll { for buffer in held { live?.append(buffer) } }
    tapRequest = live
    if let muteSeconds = muteSeconds { tapMute = PreRollMute(seconds: muteSeconds) }
    tapLock.unlock()
}
func stopAudio() {
    if audioTapInstalled { engine.inputNode.removeTap(onBus: 0); audioTapInstalled = false }
    stopEngineIfIdle()
    setTapInput(nil)
    request?.endAudio()
}
// windowReason: reported if an open follow-up window is closed by this call.
func clearSpeech(windowReason: String = "cancel") {
    if mode == .followUp {
        output(["event": "followup_closed", "kind": windowKind.rawValue, "endReason": windowReason])
    }
    // Invalidate callbacks before stopping/cancelling the old recognizer.
    generation += 1; mode = nil; pendingWake = false
    stopAudio(); task?.cancel(); task = nil; request = nil
    finalDeadline?.cancel(); finalDeadline = nil; releaseTail?.cancel(); releaseTail = nil
    setWakeListening(false)
}
// Pending (not yet open) windows: the automatic continuation after a turn, or one a reply
// or listen request asked for, which is reported closed so Electron never waits on it.
func cancelPendingWindow(_ reason: String) {
    pendingWindow?.cancel(); pendingWindow = nil
    if let kind = pendingWindowKind {
        pendingWindowKind = nil
        output(["event": "followup_closed", "kind": kind.rawValue, "endReason": reason])
    }
}
func closeWindow(_ reason: String) {
    resumeWindowAfterSpeech = false
    cancelPendingWindow(reason)
    if mode == .followUp { clearSpeech(windowReason: reason) }
}
// The window a reply about to play closes: the one open, or the one pending (the continuation
// after a turn, or a window a reply or a listen request deferred past the echo guard).
func closingWindowKind() -> FollowUpKind? {
    if mode == .followUp { return windowKind }
    return pendingWindow == nil ? nil : pendingWindowKind ?? .continuation
}
func ambientListeningAllowed() -> Bool {
    standbyAllowed(speaking: speaker.isActive, now: uptime(), echoGuardUntil: echoGuardUntil, fullDuplex: listenWhileSpeaking)
}
func scheduleStandby(_ delay: Double = 0.35) {
    restart?.cancel()
    guard handsFreeEnabled, !suspended, !keyHeld else { return }
    // Half-duplex: wait out the echo guard; while speaking, the end of speech restarts listening.
    // Full duplex listens through both.
    let wait = max(delay, echoGuardWait() + 0.02)
    let work = DispatchWorkItem {
        guard handsFreeEnabled, !suspended, !keyHeld, mode == nil, pendingWindow == nil, listenWhileSpeaking || !speaker.isActive else { return }
        if !ambientListeningAllowed() { scheduleStandby(0); return }
        beginAudio(.standby)
    }
    restart = work; DispatchQueue.main.asyncAfter(deadline: .now() + wait, execute: work)
}
func voiceError(_ message: String, _ code: String) {
    output(["event": "voice_error", "message": message, "code": code])
}
let emptyTurnMessage = "Didn’t catch that. Try again."
let unfinalizedMessage = "Couldn’t finalize that. Try again."
// Ends an activated turn. Only speech the recognizer finalized is transcript_final; merged
// segments carry confidence 0. Recovered and unconfirmed speech never approves.
func completeTurn(_ how: TurnCompletion) {
    guard let current = mode, current == .handsFree || current == .pushToTalk else { return }
    let handsFree = current == .handsFree
    let unconfirmed = !trimmed(turn.current).isEmpty
    if unconfirmed { absorbFinalSegment(&turn, text: "", confidence: nil) }
    let text = turn.text, segments = turn.committed.count, confidence = turnConfidence(turn)
    clearSpeech()
    var accepted = false
    if text.isEmpty {
        voiceError(emptyTurnMessage, "empty")
    } else if how == .error {
        voiceError(unfinalizedMessage, "unfinalized")
    } else if !unconfirmed {
        output(["event": "transcript_final", "text": text, "confidence": confidence, "segments": segments]); accepted = true
    } else if isControlPhrase(text) {
        // The recognizer missed its deadline after an explicit endpoint. A bounded stop/pause
        // utterance must still stop/pause, never surface as an error that would resume a
        // voice-held run. Confidence 0 cannot approve.
        output(["event": "transcript_recovered", "text": text, "confidence": 0,
                "source": "control_phrase_after_endpoint", "segments": segments]); accepted = true
    } else if how == .emptyFinal {
        // Apple's empty terminal marker after an endpoint: the latest hypothesis, not a
        // confident final. It can never approve a pending action.
        // stableMs: how long the hypothesis had stood unchanged when the endpoint came.
        // Electron treats a long-stable hypothesis as the user's words for starting a
        // task (never for approving one).
        output(["event": "transcript_recovered", "text": text, "confidence": 0,
                "source": "empty_final_after_endpoint", "segments": segments,
                "stableMs": Int(((uptime() - lastTextAt) * 1000).rounded())]); accepted = true
    } else {
        // Never routes by itself: Electron asks the user to confirm it.
        output(["event": "transcript_unconfirmed", "text": text, "source": "deadline_hypothesis", "segments": segments])
    }
    if handsFree { endHandsFreeTurn(text, accepted: accepted) } else { scheduleStandby() }
}
// Pop for a turn that was heard, then a continuation window as long as the Keep listening
// setting makes it catches "...and search" without the wake phrase. Under the conversation
// setting the window reopens after every turn, heard or not ("Hey Butler" alone opens it, and
// one missed word does not end the conversation); the phrase that ends it ("thanks") opens
// none, and Electron acts on nothing for it either.
func endHandsFreeTurn(_ text: String, accepted: Bool) {
    if accepted { playEarcon("Pop") }
    let reopens = followUpWindow == .conversation ? !(accepted && endsConversation(text)) : accepted
    guard handsFreeEnabled, followUpEnabled, reopens else { scheduleStandby(); return }
    cancelPendingWindow("cancel")
    let work = DispatchWorkItem {
        pendingWindow = nil
        if !openWindow(.continuation, seconds: followUpSeconds(.continuation, window: followUpWindow), announced: false) && mode == nil { scheduleStandby() }
    }
    pendingWindow = work; DispatchQueue.main.asyncAfter(deadline: .now() + continuationWindowDelay, execute: work)
}
/// A fresh install, or a rebuilt bundle macOS no longer recognizes, has never been asked
/// for the microphone or speech: ask once, then resume ambient listening, instead of
/// reporting a denial the user never made.
var permissionAsked = false
func permissionUndetermined() -> Bool {
    AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined ||
        SFSpeechRecognizer.authorizationStatus() == .notDetermined
}
func askPermissionsThenResume() {
    permissionAsked = true
    AVCaptureDevice.requestAccess(for: .audio) { _ in
        SFSpeechRecognizer.requestAuthorization { _ in DispatchQueue.main.async {
            if availabilityError() == nil { _ = installShortcut(); scheduleStandby() }
        } }
    }
}
func availabilityError() -> (message: String, code: String)? {
    guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized,
          SFSpeechRecognizer.authorizationStatus() == .authorized else {
        return ("Enable microphone and speech access in Settings.", "permission")
    }
    guard let recognizer = speech, recognizer.isAvailable, recognizer.supportsOnDeviceRecognition else {
        return ("On-device speech is unavailable for this language. Use a text command.", "unavailable")
    }
    return nil
}
func audioFailed(_ message: String, code: String, ambient: Bool) {
    clearSpeech()
    if !ambient || message != lastWakeError {
        output(["event": ambient ? "wake_error" : "voice_error", "message": message, "code": code])
    }
    if ambient { lastWakeError = message }
    scheduleStandby(5)
}
func emitTurnEndpoint(_ reason: TurnEndReason) {
    let now = uptime()
    output(["event": "turn_endpoint", "endReason": reason.rawValue,
            "stableMs": Int(((now - lastTextAt) * 1000).rounded()), "quietMs": Int(((now - lastSpeechAt) * 1000).rounded()),
            "completeness": currentCompleteness().rawValue, "segments": turn.segmentCount, "patience": patience.rawValue,
            "noiseFloor": (noiseFloor.floor * 10000).rounded() / 10000, "threshold": (noiseFloor.threshold * 10000).rounded() / 10000])
}
func currentCompleteness() -> Completeness {
    let text = turn.text
    if completenessCache.text != text || completenessCache.context != turnContext {
        completenessCache = (text, turnContext, utteranceCompleteness(text, context: turnContext))
    }
    return completenessCache.value
}
func endCommand(_ reason: TurnEndReason) {
    guard mode == .handsFree || mode == .pushToTalk, !released else { return }
    released = true
    if !shortcutUpSent { shortcutUpSent = true; output(["event": "shortcut_up"]) }
    emitTurnEndpoint(reason)
    // Everything was already finalized and nothing was said since the last request rotation.
    let nothingPending = trimmed(turn.current).isEmpty && rotatedAt > startedAt && lastSpeechAt < rotatedAt
    stopAudio()
    if nothingPending { completeTurn(.final); return }
    let session = generation
    let work = DispatchWorkItem {
        finalDeadline = nil
        if mode != nil && session == generation { completeTurn(.deadline) }
    }
    finalDeadline = work; DispatchQueue.main.asyncAfter(deadline: .now() + finalDeadlineSeconds, execute: work)
}
// preRoll: the fresh request hears the ring's last 1.5 s first (a cadence rotation).
@discardableResult
func startRecognition(preRoll: Bool = false) -> Bool {
    guard let recognizer = speech else { return false }
    segmentGeneration += 1
    standbyRaw = ""; standbyBoundary = 0; wakeOffset = 0; standbyChangedAt = uptime(); standbyTextAt = standbyChangedAt
    let session = generation, segment = segmentGeneration
    let next = SFSpeechAudioBufferRecognitionRequest()
    next.shouldReportPartialResults = true; next.requiresOnDeviceRecognition = true; next.taskHint = .dictation
    next.contextualStrings = recognizerContext(ambient: mode == .standby || mode == .followUp, vocabulary: vocabulary)
    request = next
    setTapInput(next, preRoll: preRoll)
    task = recognizer.recognitionTask(with: next) { result, error in
        DispatchQueue.main.async { recognized(result, error, session: session, segment: segment) }
    }
    return true
}
// Apple ends a recognition request on its own (a final after a pause, an error), and standby
// ends a long one on purpose (standbyRotationDue, with the ring's capture as pre-roll). Keep the
// microphone running and continue in a fresh request; late callbacks from the old one are ignored.
func rotateRequest(reason: String, preRoll: Bool = false) {
    guard mode != nil else { return }
    if mode == .standby || mode == .followUp {
        var extra: [String: Any] = ["reason": reason]
        if preRoll { tapLock.lock(); extra["preRollMs"] = Int((tapRing.heldSeconds * 1000).rounded()); tapLock.unlock() }
        traceStandby("rotate", extra: extra)
    }
    let oldTask = task, oldRequest = request
    guard startRecognition(preRoll: preRoll) else {
        if mode == .standby || mode == .followUp { clearSpeech(); scheduleStandby(1) } else { completeTurn(.error) }
        return
    }
    oldRequest?.endAudio(); oldTask?.cancel()
    rotatedAt = uptime()
}
@discardableResult
func beginAudio(_ nextMode: ListenMode, muteSeconds: Double = 0, knownAvailable: Bool = false) -> Bool {
    guard !shuttingDown, nextMode != .pushToTalk || keyHeld else { return false }
    let ambient = nextMode == .standby || nextMode == .followUp
    if ambient && !ambientListeningAllowed() { return false }
    if suspended {
        if !ambient { audioFailed("Voice is paused while the Mac is asleep.", code: "asleep", ambient: false) }
        return false
    }
    // Only ambient listening pauses for secure input; the maintenance timer resumes it.
    // Explicit commands are unrelated to keystroke privacy.
    if ambient && IsSecureEventInputEnabled() { clearSpeech(); securePaused = true; return false }
    if !knownAvailable, let failure = availabilityError() {
        // Asking is the answer to "never asked"; the system dialog is on screen, not an error.
        if failure.code == "permission" && !permissionAsked && permissionUndetermined() { askPermissionsThenResume(); return false }
        audioFailed(failure.message, code: failure.code, ambient: ambient); return false
    }
    clearSpeech()
    mode = nextMode; released = false; shortcutUpSent = false; turn = TurnTranscript(); turnContext = .command
    containsWakePhrase = false; wakeSegment = -1; errorRotations = 0; endpointNearSent = false; windowRun = SpeechRun()
    let now = uptime()
    startedAt = now; lastSpeechAt = now; lastTextAt = now; rotatedAt = now
    startRecognition()
    if ambient {
        var extra: [String: Any] = ["mode": nextMode == .standby ? "standby" : "followUp", "voiceProcessing": voiceProcessing,
                                    "channels": Int(engine.inputNode.outputFormat(forBus: 0).channelCount)]
        if voiceProcessing && tapChoice.decided { extra["micChannel"] = tapChoice.channel }
        traceStandby("begin", extra: extra)
    }
    if let failure = startInput(muteSeconds: muteSeconds) {
        audioFailed(failure, code: "mic", ambient: ambient); return false
    }
    lastWakeError = ""
    if ambient { setWakeListening(true) } else { output(["event": "listening_ready"]) }
    return true
}
// A tap buffer copied in its own format, for the pre-roll ring.
func copied(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
    guard buffer.frameLength > 0, let copy = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: buffer.frameLength) else { return nil }
    copy.frameLength = buffer.frameLength
    let source = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: buffer.audioBufferList))
    for (from, to) in zip(source, UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)) {
        memcpy(to.mData, from.mData, Int(min(from.mDataByteSize, to.mDataByteSize)))
    }
    return copy
}
// Voice processing's input, as one channel: each buffer's chosen channel (ChannelChoice) copied into
// a mono Float32 buffer at the node's sample rate, which the recognizer, the ring and the level read.
// Only from Float32 samples, the format the input node gives: the recognizer takes one format per
// request, and floatChannelData is nil for any other.
final class TapDownmix {
    let mono: AVAudioFormat
    var choice: ChannelChoice
    init?(_ format: AVAudioFormat, choice: ChannelChoice) {
        guard format.commonFormat == .pcmFormatFloat32, format.sampleRate > 0, format.channelCount > 0,
              let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: format.sampleRate, channels: 1, interleaved: false) else { return nil }
        self.mono = mono
        // A choice made on another channel count belongs to another device.
        self.choice = choice.channels == Int(format.channelCount) ? choice : ChannelChoice()
    }
    func convert(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        let frames = Int(buffer.frameLength)
        guard frames > 0, let data = buffer.floatChannelData, let out = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: buffer.frameLength),
              let target = out.floatChannelData?[0] else { return nil }
        let stride = Int(buffer.stride)
        let channels = (0..<Int(buffer.format.channelCount)).map { UnsafePointer(data[$0]) }
        let channel = choice.decided ? choice.channel
            : choice.observe(energies: channelEnergies(channels, stride: stride, frames: frames), frames: frames, sampleRate: buffer.format.sampleRate)
        copyChannel(channels[channel], stride: stride, frames: frames, into: target)
        out.frameLength = buffer.frameLength
        return out
    }
}
// Installs the tap for the input device's current format and starts the microphone for the
// current session. Returns the user-facing failure, or nil once capture runs.
func startInput(muteSeconds: Double) -> String? {
    let session = generation
    setTapInput(request, muteSeconds: muteSeconds)
    let input = engine.inputNode
    var format = input.outputFormat(forBus: 0)
    // Voice processing's format reaches the recognizer and the level as one channel; one the tap
    // cannot read that way leaves the input to half duplex.
    let downmix = voiceProcessing ? TapDownmix(format, choice: tapChoice) : nil
    if voiceProcessing && downmix == nil { disableVoiceProcessing(reason: "format"); format = input.outputFormat(forBus: 0) }
    guard format.sampleRate > 0, format.channelCount > 0 else { return "Microphone unavailable. Check your input device." }
    if voiceProcessing { silenceWatch = SilenceWatch() }
    let tapFormat = format
    var lastLevelAt: TimeInterval = 0
    var choiceReported = downmix?.choice.decided ?? true
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
        let now = uptime()
        // The engine reuses the tap's buffer once this returns: the ring keeps a copy (under voice
        // processing the mono buffer, which is the tap's own), appended beside the live request read
        // so a rotation between two callbacks sees every buffer once.
        let fed: AVAudioPCMBuffer, copy: AVAudioPCMBuffer?
        if let downmix {
            guard let mono = downmix.convert(buffer) else { return }
            fed = mono; copy = mono
        } else {
            fed = buffer; copy = copied(buffer)
        }
        tapLock.lock(); let live = tapRequest, admitted = tapMute.admits(at: now); tapBuffers += 1
        if admitted, let copy { tapRing.append(copy, seconds: Double(copy.frameLength) / copy.format.sampleRate) }
        tapLock.unlock()
        if let downmix, !choiceReported, downmix.choice.decided {
            choiceReported = true
            let choice = downmix.choice
            DispatchQueue.main.async { channelChosen(choice, format: tapFormat) }
        }
        // Pre-roll right after barge-in may still hold the reply's tail: never transcribe it.
        if !admitted { return }
        live?.append(fed)
        guard now - lastLevelAt > 0.08 else { return }; lastLevelAt = now
        let count = Int(fed.frameLength)
        guard let values = fed.floatChannelData?[0], count > 0 else { return }
        let level = rms(values, count: count)
        DispatchQueue.main.async { observeLevel(level, at: now, session: session) }
    }
    audioTapInstalled = true
    // Under full duplex a reply may already have the engine running: the tap joins it live.
    if !engine.isRunning {
        do { try startEngine() } catch { return "Microphone could not start. Check your input device." }
    }
    return nil
}
// The input device changed format or route (a headset, a Bluetooth profile switch when the
// microphone opens): the engine stopped itself and its tap no longer matches the hardware.
// Changes arrive in bursts, so capture resumes in place once the device settles; the mode,
// the turn and an open window's deadline are kept.
func inputConfigurationChanged() {
    guard let current = mode, !shuttingDown else { return }
    // After an endpoint the microphone is already off; the final deadline ends the turn.
    if (current == .handsFree || current == .pushToTalk) && released { return }
    if engine.isRunning { engine.stop() }
    if audioTapInstalled { engine.inputNode.removeTap(onBus: 0); audioTapInstalled = false }
    // Another device may carry the microphone on another channel.
    tapChoice = ChannelChoice()
    inputRestart?.cancel()
    let session = generation
    let work = DispatchWorkItem {
        inputRestart = nil
        guard session == generation, let mode = mode, !audioTapInstalled else { return }
        if (mode == .handsFree || mode == .pushToTalk) && released { return }
        resumeInput()
    }
    inputRestart = work; DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: work)
}
func resumeInput() {
    guard let current = mode else { return }
    let ambient = current == .standby || current == .followUp
    // A device that keeps flapping must not restart the microphone forever.
    let now = uptime()
    inputRestarts = inputRestarts.filter { now - $0 < 10 } + [now]
    if inputRestarts.count > 5 {
        inputRestarts = []
        audioFailed("Microphone keeps changing. Check your input device.", code: "mic", ambient: ambient); return
    }
    // What was heard stays in the turn, unconfirmed (it can never approve); capture continues
    // in a fresh request, since the old one was fed buffers in the previous format.
    if !ambient && !trimmed(turn.current).isEmpty { absorbFinalSegment(&turn, text: "", confidence: nil) }
    if ambient { traceStandby("input_restart") }
    let oldTask = task, oldRequest = request
    let started = startRecognition()
    oldRequest?.endAudio(); oldTask?.cancel()
    rotatedAt = uptime()
    if !started {
        audioFailed("Microphone changed. Try again.", code: "mic", ambient: ambient); return
    }
    if let failure = startInput(muteSeconds: 0) {
        // The turn cannot continue: report it without routing any partial text.
        audioFailed(ambient ? failure : "Microphone changed. Try again.", code: "mic", ambient: ambient)
    }
}
// Bluetooth output plays well behind the synthesizer's timeline. Two CoreAudio property reads
// (under 0.1 ms once the audio system is loaded in this process); unknown counts as built-in.
func defaultOutputIsBluetooth() -> Bool {
    var device = AudioObjectID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice,
                                             mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device) == noErr,
          device != kAudioObjectUnknown else { return false }
    var transport: UInt32 = 0
    size = UInt32(MemoryLayout<UInt32>.size)
    address.mSelector = kAudioDevicePropertyTransportType
    guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &transport) == noErr else { return false }
    return bluetoothTransport(transport)
}
func observeLevel(_ rms: Double, at now: TimeInterval, session: Int) {
    guard session == generation, let current = mode else { return }
    // Voice processing whose buffers are digital silence is deaf: half duplex hears.
    if voiceProcessing, silenceWatch.observe(rms: rms, at: now) { voiceProcessingSilent(); return }
    let isSpeech = noiseFloor.observe(rms: rms)
    lastRms = rms
    if isSpeech { lastSpeechAt = now }
    if current == .followUp { windowRun.observe(speech: isSpeech, at: now) }
    // Levels only for an activated turn: never in standby or before a window detects speech.
    if current == .handsFree || current == .pushToTalk { output(["event": "audio_level", "level": min(1, rms * 12)]) }
}
// Nearby conversation keeps one hypothesis running; words appended after a pause in the
// partials begin a new utterance (utteranceBoundary), and only that utterance is tested for the
// wake phrase, in standby and in a follow-up window alike.
func ambientUtterance(_ raw: String, now: TimeInterval) -> String {
    if raw != standbyRaw {
        if standbyRaw.isEmpty { standbyTextAt = now }
        standbyBoundary = utteranceBoundary(previous: standbyRaw, current: raw, boundary: standbyBoundary, gapSeconds: now - standbyChangedAt)
        standbyRaw = raw; standbyChangedAt = now
    }
    return standbyBoundary > 0 ? String(raw.dropFirst(standbyBoundary)) : raw
}
func recognized(_ result: SFSpeechRecognitionResult?, _ error: Error?, session: Int, segment: Int) {
    guard let current = mode, session == generation, segment == segmentGeneration else { return }
    if let result = result {
        let raw = result.bestTranscription.formattedString
        let now = uptime()
        switch current {
        case .standby:
            let utterance = ambientUtterance(raw, now: now)
            // Full duplex: Butler's own reply, as far as echo cancellation let it through, is never a
            // wake, nor a wake phrase waiting for its pause ("I'm Butler" heard back as "Butler").
            let echo = selfEcho(utterance, now: now)
            guard !echo, commandAfterWakePhrase(utterance, ended: result.isFinal) != nil else {
                // Do not emit background speech, partials, or microphone levels.
                traceStandby(echo ? "self_echo" : result.isFinal ? "final" : "partial", raw, extra: ["segments": result.bestTranscription.segments.count, "boundary": standbyBoundary])
                if !trimmed(raw).isEmpty { lastTextAt = now }
                pendingWake = !echo && !result.isFinal && wakePhraseAwaitingPause(utterance)
                if pendingWake { wakeOffset = standbyBoundary }
                // Full duplex: "stop", "wait" or "no" said over a reply silences it at once; from standby
                // the words route nowhere, as they never did without the wake phrase.
                if speaker.isActive && interruptsSpeech(utterance) { speaker.stop(.bargeIn) }
                if result.isFinal { clearSpeech(); scheduleStandby() }
                return
            }
            traceStandby("wake", raw, extra: ["boundary": standbyBoundary])
            wakeOffset = standbyBoundary
            activateWake(context: .command, window: nil)
        case .followUp:
            // Nearby talk swallows a wake phrase inside a window as it does in standby. A lone wake
            // phrase ("Butler", then silence) is not the reply's first word: followUpOnset refuses
            // it, and pendingWake activates it below with the window's context once the pause comes.
            let utterance = ambientUtterance(raw, now: now)
            let echo = selfEcho(utterance, now: now)
            if !echo, commandAfterWakePhrase(utterance, ended: result.isFinal) != nil {
                traceStandby("wake", raw, extra: ["boundary": standbyBoundary])
                wakeOffset = standbyBoundary
                activateWake(context: turnContext(for: windowKind), window: windowKind)
            } else if !echo, followUpOnset(text: raw, speechRun: windowRun.recentLongest(at: now), kind: windowKind, window: followUpWindow) {
                activateFollowUp()
            } else {
                traceStandby(echo ? "self_echo" : result.isFinal ? "final" : "partial", raw, extra: ["segments": result.bestTranscription.segments.count, "boundary": standbyBoundary])
                if !trimmed(raw).isEmpty { lastTextAt = now }
                pendingWake = !echo && !result.isFinal && wakePhraseAwaitingPause(utterance)
                if pendingWake { wakeOffset = standbyBoundary }
                // Keep the window open with a fresh request until its deadline.
                if result.isFinal { rotateRequest(reason: "final") }
                return
            }
        case .handsFree, .pushToTalk:
            break
        }
        absorbRecognition(result, raw: raw, now: now)
        return
    }
    if let error {
        if current == .standby { traceStandby("error", error: error.localizedDescription) }
        recognitionFailed()
    }
}
func activateWake(context: TurnContext, window: FollowUpKind?) {
    signalController()
    speaker.stop(.bargeIn)
    let now = uptime()
    mode = .handsFree; turnContext = context; containsWakePhrase = true; wakeSegment = segmentGeneration; pendingWake = false
    startedAt = now; lastTextAt = now; lastSpeechAt = now
    setWakeListening(false)
    output(["event": "wake_detected"])
    if let window = window { output(["event": "followup_closed", "kind": window.rawValue, "endReason": "detected"]) }
    playEarcon("Tink")
}
func activateFollowUp() {
    signalController()
    speaker.stop(.bargeIn)
    let kind = windowKind, now = uptime()
    mode = .handsFree; turnContext = turnContext(for: kind); containsWakePhrase = false; wakeSegment = -1; pendingWake = false
    startedAt = now; lastTextAt = now; lastSpeechAt = now
    setWakeListening(false)
    output(["event": "followup_detected", "kind": kind.rawValue])
    output(["event": "followup_closed", "kind": kind.rawValue, "endReason": "detected"])
}
func absorbRecognition(_ result: SFSpeechRecognitionResult, raw full: String, now: TimeInterval) {
    // A wake phrase that began a new utterance inside a running standby hypothesis: the words
    // before it were the room's, never part of the command (utteranceBoundary).
    let raw = containsWakePhrase && segmentGeneration == wakeSegment && wakeOffset > 0 && wakeOffset < full.count ? String(full.dropFirst(wakeOffset)) : full
    // A reply in a follow-up window that turns out to start with the wake phrase is a new
    // command: switch to wake timing and let main treat it as a wake activation.
    if mode == .handsFree, !containsWakePhrase, turn.text.isEmpty, commandAfterWakePhrase(raw, ended: result.isFinal) != nil {
        containsWakePhrase = true; wakeSegment = segmentGeneration; turnContext = .command
        lastTextAt = now; lastSpeechAt = now
        output(["event": "wake_detected"])
        playEarcon("Tink")
    }
    // Wake-activated sessions strip the phrase (and misheard echoes of it) from the first segment.
    let strip = containsWakePhrase && (segmentGeneration == wakeSegment || turn.text.isEmpty)
    let command = strip ? stripWakeEcho(activatedVoiceCommand(raw)) : trimmed(raw)
    let before = turn.text
    if result.isFinal {
        output(["event": "recognition_final", "textLength": command.count,
                "source": startsWithWakePhrase(raw) ? "wake_prefixed_segment" : "command_segment"])
        let segments = result.bestTranscription.segments
        let relevant = segments.dropFirst(min(strippedWordCount(raw: full, command: command), segments.count))
        let confidence = relevant.isEmpty ? 0 : relevant.map { Double($0.confidence) }.reduce(0, +) / Double(relevant.count)
        if released {
            if command.isEmpty { completeTurn(trimmed(turn.current).isEmpty ? .final : .emptyFinal); return }
            absorbFinalSegment(&turn, text: command, confidence: confidence)
            completeTurn(.final)
            return
        }
        // Before our endpoint a final only commits its segment: keep listening.
        absorbFinalSegment(&turn, text: command, confidence: command.isEmpty ? nil : confidence)
        if turn.text != before { textChanged(now) }
        rotateRequest(reason: "final")
        return
    }
    absorbPartial(&turn, update: command, gap: now - lastTextAt)
    if turn.text != before {
        output(["event": "recognition_update", "textLength": turn.text.count,
                "source": startsWithWakePhrase(raw) ? "wake_prefixed_segment" : "command_segment"])
        textChanged(now)
    }
}
// Stop/pause intents are routed from the final transcript only: a partial "Stop" is often
// the start of a longer correction. Input is already latched at shortcut_down/wake_detected.
func textChanged(_ now: TimeInterval) {
    lastTextAt = now; endpointNearSent = false
    output(["event": "transcript_partial", "text": turn.text])
}
func recognitionFailed() {
    guard let current = mode else { return }
    if uptime() - rotatedAt > 5 { errorRotations = 0 }
    errorRotations += 1
    switch current {
    case .standby:
        clearSpeech(); scheduleStandby(1)
    case .followUp:
        if errorRotations <= 3 && windowDeadline - uptime() > 0.5 { rotateRequest(reason: "error") } else { clearSpeech(); scheduleStandby(1) }
    case .handsFree, .pushToTalk:
        if released { completeTurn(trimmed(turn.current).isEmpty ? .final : .deadline); return }
        if errorRotations <= 3 {
            // Keep what was heard so far and continue in a fresh request.
            if !trimmed(turn.current).isEmpty { absorbFinalSegment(&turn, text: "", confidence: nil) }
            rotateRequest(reason: "error")
        } else {
            completeTurn(.error)
        }
    }
}
// A window before speech is detected: no partials, no levels; secure input and sleep close it.
@discardableResult
func openWindow(_ kind: FollowUpKind, seconds: Double, announced: Bool) -> Bool {
    func refuse() -> Bool {
        if announced { output(["event": "followup_closed", "kind": kind.rawValue, "endReason": "cancel"]) }
        return false
    }
    guard handsFreeEnabled, followUpEnabled, !suspended, !keyHeld, !shuttingDown else { return refuse() }
    if mode == .followUp { continueWindow(as: kind, seconds: seconds); return true }
    guard mode == nil || mode == .standby, listenWhileSpeaking || !speaker.isActive else { return refuse() }
    restart?.cancel()
    windowKind = kind
    guard beginAudio(.followUp) else { return refuse() }
    continueWindow(as: kind, seconds: seconds)
    return true
}
// The open window goes on as `kind` for `seconds`, in the same recognition request: a reply's or
// a listen request's window taking over from the one open, or the continuation window an expired
// approval leaves under the conversation setting.
func continueWindow(as kind: FollowUpKind, seconds: Double) {
    windowKind = kind; windowDeadline = uptime() + seconds
    output(["event": "followup_open", "kind": kind.rawValue, "seconds": seconds])
}
func listenRequest(_ command: [String: Any]) -> [String: Any] {
    guard let kind = FollowUpKind(rawValue: command["kind"] as? String ?? "") else { return ["opened": false, "reason": "invalid"] }
    let seconds = clampFollowUpSeconds(command["seconds"] as? Double, kind: kind, window: followUpWindow)
    guard handsFreeEnabled && followUpEnabled else { return ["opened": false, "reason": "disabled"] }
    if suspended { return ["opened": false, "reason": "suspended"] }
    if keyHeld || mode == .handsFree || mode == .pushToTalk { return ["opened": false, "reason": "capturing"] }
    if speaker.isActive && !listenWhileSpeaking { return ["opened": false, "reason": "speaking"] }
    if mode == .followUp { openWindow(kind, seconds: seconds, announced: false); return ["opened": true] }
    if securePaused || IsSecureEventInputEnabled() { return ["opened": false, "reason": "secure_input"] }
    cancelPendingWindow("cancel")
    let wait = echoGuardWait()
    if wait > 0 {
        // Right after speech: open once the echo guard ends.
        pendingWindowKind = kind
        let work = DispatchWorkItem {
            pendingWindow = nil; pendingWindowKind = nil
            if !openWindow(kind, seconds: seconds, announced: true) && mode == nil { scheduleStandby() }
        }
        pendingWindow = work; DispatchQueue.main.asyncAfter(deadline: .now() + wait + 0.02, execute: work)
        return ["opened": true, "deferred": true]
    }
    return openWindow(kind, seconds: seconds, announced: false) ? ["opened": true] : ["opened": false, "reason": "unavailable"]
}
// Speaker finished, was stopped, or failed. Ambient listening resumes after the echo guard; a
// reply that asked for an answer opens its window with a fresh recognition request, and under the
// conversation setting a reply that asked for none reopens the window it closed
// (resumeWindowAfterSpeech), unannounced like the continuation after a turn.
func speechEnded(listen: ListenRequest?) {
    // The guard only gates ambient listening, so the route is sampled only in hands-free mode.
    echoGuardUntil = max(echoGuardUntil, speaker.lastAudibleAt + echoGuard(bluetoothOutput: handsFreeEnabled && outputBluetooth))
    cancelPendingWindow("cancel")
    let resume = resumeWindowAfterSpeech
    resumeWindowAfterSpeech = false
    guard let listen = listen else {
        if resume && handsFreeEnabled && followUpEnabled {
            openWindowAfterSpeech(.continuation, seconds: followUpSeconds(.continuation, window: followUpWindow), announced: false)
        } else if mode == nil {
            // A short delay avoids restarting the recognizer when a silent PCM abort is followed at once by its system-voice fallback.
            scheduleStandby(0.15)
        }
        return
    }
    guard handsFreeEnabled, followUpEnabled else {
        output(["event": "followup_closed", "kind": listen.kind.rawValue, "endReason": "cancel"])
        if mode == nil { scheduleStandby(0.15) }
        return
    }
    openWindowAfterSpeech(listen.kind, seconds: listen.seconds, announced: true)
}
// Opens once the echo guard has passed, pending until then. announced: a window Electron asked
// for, reported closed if it is cancelled or refused so Electron never waits on it.
func openWindowAfterSpeech(_ kind: FollowUpKind, seconds: Double, announced: Bool) {
    if announced { pendingWindowKind = kind }
    let work = DispatchWorkItem {
        pendingWindow = nil; pendingWindowKind = nil
        if !openWindow(kind, seconds: seconds, announced: announced) && mode == nil { scheduleStandby() }
    }
    pendingWindow = work
    DispatchQueue.main.asyncAfter(deadline: .now() + echoGuardWait() + 0.02, execute: work)
}
func speakRequest(_ command: [String: Any], pcm: Bool) -> [String: Any] {
    func reject(_ reason: String) -> [String: Any] { ["accepted": false, "reason": reason] }
    guard let id = command["utteranceId"] as? String, !id.isEmpty, id.count <= 200,
          let priority = SpeakPriority(label: command["priority"] as? String ?? "") else { return reject("invalid") }
    var listen: ListenRequest?
    if let window = command["listen"] as? [String: Any] {
        guard let kind = FollowUpKind(rawValue: window["kind"] as? String ?? "") else { return reject("invalid") }
        listen = ListenRequest(kind: kind, seconds: clampFollowUpSeconds(window["seconds"] as? Double, kind: kind, window: followUpWindow))
    }
    let source: SpokenUtterance.Source, text: String
    if pcm {
        guard command["format"] as? String == "s16le", let rate = command["sampleRate"] as? Double, validPcmSampleRate(rate) else {
            return reject("invalid")
        }
        source = .pcm(rate)
        // The words behind the audio, for the self-echo filter; an older Electron sends none.
        let words = command["text"] as? String ?? ""
        text = words.count <= spokenTextLimit ? trimmed(words) : ""
    } else {
        guard let sentence = command["text"] as? String, !trimmed(sentence).isEmpty, sentence.count <= spokenTextLimit else { return reject("invalid") }
        source = .system(trimmed(sentence)); text = trimmed(sentence)
    }
    if handsFreeEnabled { outputBluetooth = defaultOutputIsBluetooth() }
    let decision = speakDecision(enabled: speaker.enabled, capturing: keyHeld || mode == .handsFree || mode == .pushToTalk,
                                 suspended: suspended, current: speaker.currentPriority, incoming: priority)
    if case .reject(let reason) = decision { return reject(reason) }
    if !speechLanguageSupported(locale: speech?.locale.identifier ?? speaker.locale) { return reject("unsupported_language") }
    let utterance = SpokenUtterance(id: id, priority: priority, listen: listen, source: source, text: text)
    if decision == .queue { speaker.enqueue(utterance); return ["accepted": true, "queued": true] }
    // Half-duplex: ambient recognition stops before audio starts, so a reply can never
    // wake the assistant or answer its own question. Full duplex keeps it running for a PCM
    // reply through the shared engine: voice processing cancels the playback, and isSelfEcho
    // drops what it lets through.
    if !(fullDuplexRequested && voiceProcessing && pcm && speaker.sharesEngine) {
        restart?.cancel()
        // Under the conversation setting the window this reply closes reopens once the reply ends.
        if let closing = closingWindowKind(), conversationWindowAfter(.speaking, kind: closing, window: followUpWindow) != nil {
            resumeWindowAfterSpeech = true
        }
        cancelPendingWindow("speaking")
        if mode == .followUp { clearSpeech(windowReason: "speaking") } else if mode == .standby { clearSpeech() }
    }
    speaker.play(utterance)
    return ["accepted": true]
}
func cancelSpeech(_ reason: SpeechStopReason = .cancel) {
    speaker.stop(reason)
    closeWindow("cancel")
    keyHeld = false; pushAudioAttempted = false; optionReleased = false; delayedStart?.cancel(); delayedStart = nil; restart?.cancel()
    clearSpeech(); scheduleStandby()
}
var machTimebase: mach_timebase_info_data_t = { var info = mach_timebase_info_data_t(); mach_timebase_info(&info); return info }()
func eventTime(_ event: CGEvent?) -> TimeInterval {
    let now = uptime()
    guard let event = event else { return now }
    return eventUptime(timestamp: event.timestamp, now: now, numer: machTimebase.numer, denom: machTimebase.denom).map { min($0, now) } ?? now
}
func down(at pressedAt: TimeInterval = uptime()) {
    guard !keyHeld else { return }
    // The input-stop latch comes first; nothing below may delay it.
    signalController()
    NSHapticFeedbackManager.defaultPerformer.perform(.alignment, performanceTime: .now)
    // Barge-in. This runs inside the event tap callback, so the stop never blocks: speech state
    // and speech_finished change now, the synthesizer and output engine stop right after return.
    let bargeIn = speaker.recentlyAudible
    speaker.stop(.bargeIn)
    restart?.cancel(); closeWindow("cancel"); clearSpeech()
    keyHeld = true; heldAt = pressedAt; pushAudioAttempted = false; optionReleased = false; spaceUpTicks = 0
    output(["event": "shortcut_down"])
    let session = generation
    func start(_ knownAvailable: Bool) {
        delayedStart = nil
        guard session == generation && keyHeld else { return }
        pushAudioAttempted = true
        // The reply's tail must not become this turn ("…allow it? yes"): output is stopped before the
        // microphone opens (a bounded wait), and the first 0.15 s the microphone delivers is discarded.
        if bargeIn { speaker.finishStopping(timeout: bargeInStopWaitSeconds) }
        beginAudio(.pushToTalk, muteSeconds: bargeIn ? bargeInMuteSeconds : 0, knownAvailable: knownAvailable)
    }
    // Capture starts at key-down, right after the tap callback returns, so a quick "yes" is
    // heard; a tap under 0.16 s discards it. When audio cannot start, keep the old delay so a
    // tap still opens text entry instead of an error. Availability is checked here, not in
    // the tap callback (it costs tens of ms).
    let work = DispatchWorkItem {
        guard session == generation && keyHeld else { return }
        if !suspended && availabilityError() == nil { start(true); return }
        let late = DispatchWorkItem { start(false) }
        delayedStart = late
        DispatchQueue.main.asyncAfter(deadline: .now() + max(0, 0.16 - (uptime() - pressedAt)), execute: late)
    }
    delayedStart = work
    DispatchQueue.main.async(execute: work)
}
func up(at releasedAt: TimeInterval = uptime()) {
    guard keyHeld else { return }; keyHeld = false; delayedStart?.cancel(); delayedStart = nil; optionReleased = false; spaceUpTicks = 0
    switch shortcutRelease(heldFor: releasedAt - heldAt, audioAttempted: pushAudioAttempted, pushToTalkActive: mode == .pushToTalk) {
    case .tap: clearSpeech(); output(["event": "shortcut_tap"]); scheduleStandby()
    case .end: releasePushToTalk()
    case .ignore: scheduleStandby()
    }
}
// Words often land just after release: keep capturing briefly, then end the request.
func releasePushToTalk() {
    guard mode == .pushToTalk, !released else { return }
    shortcutUpSent = true; output(["event": "shortcut_up"])
    let session = generation
    let work = DispatchWorkItem {
        releaseTail = nil
        if session == generation { endCommand(.release) }
    }
    releaseTail = work; DispatchQueue.main.asyncAfter(deadline: .now() + pushToTalkTailSeconds, execute: work)
}
func spacePhysicallyDown() -> Bool {
    CGEventSource.keyState(.hidSystemState, key: 49) || CGEventSource.keyState(.combinedSessionState, key: 49)
}
// After Option is released mid-hold, the turn ends on Space key-up; poll in case that key-up is never delivered.
func pollSpaceRelease() {
    guard keyHeld, optionReleased else { spaceUpTicks = 0; return }
    spaceUpTicks = spacePhysicallyDown() ? 0 : spaceUpTicks + 1
    if spaceUpTicks >= 2 { up() }
}
func installShortcut() -> Bool {
    if tap != nil { return true }
    let mask = CGEventMask((1 << CGEventType.keyDown.rawValue) | (1 << CGEventType.keyUp.rawValue) | (1 << CGEventType.flagsChanged.rawValue))
    tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap, eventsOfInterest: mask, callback: { _, type, event, _ in
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            // Key events may have been missed while disabled; do not eat a later Space.
            signalController(); spaceSwallowed = false; up()
            if let tap = tap, !shuttingDown { CGEvent.tapEnable(tap: tap, enable: true) }; return Unmanaged.passUnretained(event)
        }
        let code = event.getIntegerValueField(.keyboardEventKeycode)
        if event.getIntegerValueField(.eventSourceUserData) == 0x4f50454e41535354 { return Unmanaged.passUnretained(event) }
        if type == .keyDown && code == 53 {
            if keyHeld || mode == .handsFree || mode == .pushToTalk {
                signalController(); speaker.stop(.escape); cancelSpeech()
                output(["event": "voice_cancelled"]); return Unmanaged.passUnretained(event)
            }
            // Escape while only speaking silences the reply and leaves the run alone.
            if speaker.isActive { speaker.stop(.escape) }
            return Unmanaged.passUnretained(event)
        }
        let autorepeat = event.getIntegerValueField(.keyboardEventAutorepeat) != 0
        if type == .keyDown && code == 49 && spaceSwallowed && !autorepeat {
            // The consumed shortcut's keyUp was never delivered; this is a new press.
            spaceSwallowed = false
        }
        if (type == .keyDown || type == .keyUp) && shouldSwallowSpace(keyCode: code, consumed: spaceSwallowed, isKeyUp: type == .keyUp, autorepeat: autorepeat) {
            if type == .keyUp { spaceSwallowed = false; up(at: eventTime(event)) }
            return nil
        }
        if type == .keyDown && code == 49 && event.flags.contains(.maskAlternate) && !event.flags.contains(.maskCommand) && !event.flags.contains(.maskControl) { down(at: eventTime(event)); spaceSwallowed = true; return nil }
        if type == .keyUp && code == 49 && keyHeld { up(at: eventTime(event)); return nil }
        if type == .flagsChanged && keyHeld && !event.flags.contains(.maskAlternate) {
            // Letting go of Option first while still talking does not end the turn.
            if shouldEndOnOptionRelease(spaceStillDown: spacePhysicallyDown()) { up(at: eventTime(event)) } else { optionReleased = true }
        }
        return Unmanaged.passUnretained(event)
    }, userInfo: nil)
    guard let tap = tap else { return false }
    let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
    CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes); CGEvent.tapEnable(tap: tap, enable: true); return true
}
func status() -> [String: Any] {
    let voice = speaker.resolvedVoice
    return ["microphone": AVCaptureDevice.authorizationStatus(for: .audio) == .authorized,
            "speech": SFSpeechRecognizer.authorizationStatus() == .authorized,
            "onDevice": speech?.supportsOnDeviceRecognition ?? false, "shortcut": tap != nil,
            "locale": speech?.locale.identifier ?? "unknown", "handsFree": handsFreeEnabled, "wakeListening": wakeListening,
            "speaking": speaker.isActive, "voiceQuality": voice?.quality.rawValue ?? VoiceQuality.none.rawValue,
            "voiceName": voice?.name ?? "", "patience": patience.rawValue, "followUp": followUpEnabled,
            "followUpWindow": followUpWindow.rawValue, "voiceProcessing": fullDuplexRequested && voiceProcessing]
}
func voicesReply(_ id: Any) {
    speaker.withVoices { list in
        let ranked = rankVoices(list, language: speaker.locale).prefix(60)
        let selected = list.contains { $0.id == speaker.voiceId } ? speaker.voiceId : ""
        output(["id": id, "result": ["voices": ranked.map { ["id": $0.id, "name": $0.name, "language": $0.language, "quality": $0.quality.rawValue] },
                                     "selected": selected]])
    }
}
func handle(_ command: [String: Any]) {
    let id = command["id"] ?? ""
    switch command["method"] as? String {
    case "status": output(["id": id, "result": status()])
    case "configure":
        if let pid = command["controllerPID"] as? Int { controllerPID = pid_t(pid) }
        if let locale = command["locale"] as? String {
            speech = SFSpeechRecognizer(locale: Locale(identifier: locale)); speaker.locale = locale
        }
        if let value = command["patience"] as? String, let next = Patience(rawValue: value) { patience = next }
        if let value = command["sounds"] as? Bool { soundsEnabled = value }
        if let value = command["voiceId"] as? String, value.count <= 200 { speaker.voiceSelected(value) }
        if let value = command["voiceRate"] as? Double, value.isFinite { speaker.rateMultiplier = min(max(value, 0.8), 1.4) }
        if let value = command["followUp"] as? Bool, value != followUpEnabled {
            followUpEnabled = value
            if !value { closeWindow("cancel"); if mode == nil { scheduleStandby() } }
        }
        if let value = command["followUpWindow"] as? String, let next = FollowUpWindow(rawValue: value), next != followUpWindow {
            // A window opened under the old setting closes; the next one has the new length.
            followUpWindow = next
            closeWindow("cancel"); if mode == nil { scheduleStandby() }
        }
        if let value = command["vocabulary"] as? [String] {
            let next = recognizerVocabulary(value)
            if next != vocabulary {
                vocabulary = next
                output(["event": "vocabulary", "count": next.count])
                // A request keeps the context it began with: an idle standby request gives way to
                // one that has the words now, between utterances, not at its next cadence or recycle.
                if mode == .standby && !pendingWake && trimmed(standbyRaw).isEmpty { rotateRequest(reason: "vocabulary", preRoll: true) }
            }
        }
        if let value = command["speechEnabled"] as? Bool { speaker.setEnabled(value) }
        if let enabled = command["handsFree"] as? Bool, enabled != handsFreeEnabled {
            handsFreeEnabled = enabled; securePaused = false; cancelSpeech()
            // A real transition: report it once, now, instead of the debounced standby path.
            wakeOffPending?.cancel(); wakeOffPending = nil; wakeListening = false
            output(["event": "wake_status", "enabled": enabled, "listening": false])
        }
        if handsFreeEnabled && soundsEnabled { loadEarcons() }
        output(["id": id, "result": status()])
    case "enable": output(["id": id, "result": ["enabled": installShortcut()]])
    case "requestPermissions":
        AVCaptureDevice.requestAccess(for: .audio) { _ in
            SFSpeechRecognizer.requestAuthorization { _ in DispatchQueue.main.async {
                _ = installShortcut(); scheduleStandby(); output(["id": id, "result": status()])
            } }
        }
    case "cancel": cancelSpeech(); output(["id": id, "result": ["cancelled": true]])
    case "speak": output(["id": id, "result": speakRequest(command, pcm: false)])
    case "playPcmStart": output(["id": id, "result": speakRequest(command, pcm: true)])
    case "playPcmChunk":
        let ok = speaker.pcmChunk(id: command["utteranceId"] as? String ?? "", seq: command["seq"] as? Int, base64: command["data"] as? String ?? "",
                                  text: command["text"] as? String)
        output(["id": id, "result": ["ok": ok]])
    case "playPcmEnd": output(["id": id, "result": ["ok": speaker.pcmEnd(id: command["utteranceId"] as? String ?? "")]])
    case "playPcmAbort":
        let result = speaker.pcmAbort(id: command["utteranceId"] as? String ?? "")
        output(["id": id, "result": ["aborted": result.aborted, "started": result.started]])
    case "stopSpeaking": output(["id": id, "result": ["stopped": speaker.stop(.cancel)]])
    case "listen": output(["id": id, "result": listenRequest(command)])
    case "endFollowUp":
        // For example after a click on Yes: no window, and no window after the current reply.
        let had = mode == .followUp || pendingWindow != nil || speaker.current?.listen != nil || resumeWindowAfterSpeech
        speaker.clearListen()
        closeWindow("cancel")
        if mode == nil { scheduleStandby(0.1) }
        output(["id": id, "result": ["closed": had]])
    case "voices": voicesReply(id)
    default: output(["id": id, "error": "Unknown voice method."])
    }
}
@main enum VoiceMain {
    static func main() {
        // Electron may die without closing stdin cleanly (crash, SIGKILL); never outlive it.
        let parent = getppid()
        let source = DispatchSource.makeProcessSource(identifier: parent, eventMask: .exit, queue: .main)
        source.setEventHandler { shutdown() }; source.resume(); parentExit = source
        speaker.onEnded = { listen in speechEnded(listen: listen) }
        if fullDuplexRequested { enableFullDuplex() }
        observers.append(NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { _ in
            // The input first (it only schedules its restart), then the reply the stopped engine
            // was carrying, whose queued successor may start the engine again at once.
            inputConfigurationChanged()
            speaker.sharedEngineStopped()
        })
        maintenance = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
            if getppid() != parent { shutdown(); return }
            let now = uptime()
            speaker.tick(now)
            pollSpaceRelease()
            if securePaused && mode == nil {
                if !IsSecureEventInputEnabled() { securePaused = false; scheduleStandby(0.1) }
                return
            }
            guard let current = mode else { return }
            switch current {
            case .standby:
                if IsSecureEventInputEnabled() { clearSpeech(); securePaused = true; return }
                // "Hey Butler", then a pause: the wake phrase stood apart after all.
                if pendingWake && wakePauseElapsed(now: now, lastText: lastTextAt, lastSpeech: lastSpeechAt) {
                    activateWake(context: .command, window: nil); return
                }
                if !standbyTrace.isEmpty && now - lastStandbyTraceAt >= 5 {
                    lastStandbyTraceAt = now
                    tapLock.lock(); let buffers = tapBuffers; tapBuffers = 0; tapLock.unlock()
                    // The floor and threshold beside the level: voice processing changes the RMS scale, and
                    // an A/B on the flag must show by how much before anything in NoiseFloor is retuned.
                    traceStandby("level", extra: ["buffers": buffers, "rms": Int((lastRms * 1000).rounded()), "engine": engine.isRunning,
                                                  "noiseFloor": (noiseFloor.floor * 10000).rounded() / 10000, "threshold": (noiseFloor.threshold * 10000).rounded() / 10000,
                                                  "voiceProcessing": voiceProcessing, "speaking": speaker.isActive])
                }
                if standbyEndpoint(now: now, started: startedAt, lastText: lastTextAt) == .recycle {
                    traceStandby("recycle"); clearSpeech(); scheduleStandby(0.1)
                } else if !pendingWake && standbyRotationDue(words: standbyRaw.split(whereSeparator: \.isWhitespace).count,
                                                              secondsGrowing: standbyChangedAt - standbyTextAt, sinceLastChange: now - standbyChangedAt) {
                    // A long hypothesis without a wake phrase continues in a fresh request that hears the
                    // last 1.5 s first; not while a lone wake phrase waits for its pause in this request.
                    rotateRequest(reason: "cadence", preRoll: true)
                }
            case .followUp:
                if IsSecureEventInputEnabled() { clearSpeech(windowReason: "cancel"); securePaused = true; return }
                if pendingWake && wakePauseElapsed(now: now, lastText: lastTextAt, lastSpeech: lastSpeechAt) {
                    activateWake(context: turnContext(for: windowKind), window: windowKind); return
                }
                if followUpExpired(now: now, deadline: windowDeadline, lastSpeech: lastSpeechAt) {
                    if let next = conversationWindowAfter(.expired, kind: windowKind, window: followUpWindow) {
                        // An unanswered question is not the end of the conversation: the approval's
                        // 12 s are up, and listening for commands goes on.
                        output(["event": "followup_closed", "kind": windowKind.rawValue, "endReason": "timeout"])
                        continueWindow(as: next, seconds: followUpSeconds(next, window: followUpWindow))
                    } else {
                        clearSpeech(windowReason: "timeout"); scheduleStandby(0.1)
                    }
                } else if windowRotationDue(now: now, rotatedAt: rotatedAt, lastSpeech: lastSpeechAt) {
                    // A scroll's or a conversation's window outlives one request: continue in a fresh one.
                    rotateRequest(reason: "cadence", preRoll: true)
                }
            case .handsFree:
                if IsSecureEventInputEnabled() {
                    // A password field took the keyboard during a wake or follow-up turn: cancel it
                    // without transcribing or routing anything. Push-to-talk is held deliberately.
                    clearSpeech(); securePaused = true
                    voiceError(secureInputMessage, "secure_input")
                    return
                }
                guard !released else { return }
                let completeness = currentCompleteness(), hasText = !turn.text.isEmpty
                if let reason = turnEndDecision(now: now, started: startedAt, lastSpeech: lastSpeechAt, lastText: lastTextAt,
                                                hasText: hasText, completeness: completeness, patience: patience) {
                    if reason == .empty { emitTurnEndpoint(.empty); completeTurn(.final) } else { endCommand(reason) }
                } else if !endpointNearSent && endpointNear(now: now, started: startedAt, lastSpeech: lastSpeechAt, lastText: lastTextAt,
                                                            hasText: hasText, completeness: completeness, patience: patience) {
                    endpointNearSent = true
                    let remaining = endpointRemaining(now: now, lastSpeech: lastSpeechAt, lastText: lastTextAt, completeness: completeness, patience: patience)
                    output(["event": "endpoint_near", "remainingMs": Int((remaining * 1000).rounded())])
                }
            case .pushToTalk:
                if !released && now - startedAt >= pushToTalkMaxSeconds { endCommand(.max) }
            }
        }
        let center = NSWorkspace.shared.notificationCenter
        for (name, reason) in [(NSWorkspace.willSleepNotification, SpeechStopReason.sleep), (NSWorkspace.sessionDidResignActiveNotification, .sleep)] {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { _ in
                suspended = true
                speaker.stop(reason)
                let hadCommand = mode == .handsFree || mode == .pushToTalk
                cancelSpeech()
                if hadCommand { output(["event": "voice_cancelled"]) }
            })
        }
        for name in [NSWorkspace.didWakeNotification, NSWorkspace.sessionDidBecomeActiveNotification] {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { _ in suspended = false; scheduleStandby(1) })
        }
        DispatchQueue.global().async {
            while let line = readLine() {
                guard let bytes = line.data(using: .utf8), let command = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { continue }
                DispatchQueue.main.async { handle(command) }
            }
            // Hard deadline first: a blocked main thread must not leave an orphaned helper.
            DispatchQueue.global().asyncAfter(deadline: .now() + 2) { _exit(0) }
            DispatchQueue.main.async { shutdown() }
        }
        RunLoop.main.run()
    }
}
