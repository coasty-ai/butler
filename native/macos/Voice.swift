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
// The input tap runs on an audio thread: it reads the live request and the barge-in mute under this lock.
let tapLock = NSLock()
var tapRequest: SFSpeechAudioBufferRecognitionRequest?
var tapMute = PreRollMute()
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
var patience = Patience.normal
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
// Standby: the hypothesis as last seen, when it last changed, where its latest utterance
// begins (utteranceBoundary), and the offset the activated turn strips as the room's words.
var standbyRaw = "", standbyChangedAt = 0.0, standbyBoundary = 0, wakeOffset = 0
func traceStandby(_ kind: String, _ raw: String? = nil, error: String? = nil, extra: [String: Any] = [:]) {
    guard !standbyTrace.isEmpty else { return }
    var event: [String: Any] = ["event": "standby_trace", "kind": kind, "sinceStartMs": Int(((uptime() - startedAt) * 1000).rounded())]
    if let raw { event["textLength"] = raw.count; if standbyTrace == "text" { event["text"] = raw } }
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
func setTapInput(_ live: SFSpeechAudioBufferRecognitionRequest?, muteSeconds: Double? = nil) {
    tapLock.lock(); tapRequest = live; if let muteSeconds = muteSeconds { tapMute = PreRollMute(seconds: muteSeconds) }; tapLock.unlock()
}
func stopAudio() {
    if engine.isRunning { engine.stop() }
    if audioTapInstalled { engine.inputNode.removeTap(onBus: 0); audioTapInstalled = false }
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
    cancelPendingWindow(reason)
    if mode == .followUp { clearSpeech(windowReason: reason) }
}
func ambientListeningAllowed() -> Bool {
    standbyAllowed(speaking: speaker.isActive, now: uptime(), echoGuardUntil: echoGuardUntil)
}
func scheduleStandby(_ delay: Double = 0.35) {
    restart?.cancel()
    guard handsFreeEnabled, !suspended, !keyHeld else { return }
    // Half-duplex: wait out the echo guard; while speaking, the end of speech restarts listening.
    let wait = max(delay, echoGuardUntil - uptime() + 0.02)
    let work = DispatchWorkItem {
        guard handsFreeEnabled, !suspended, !keyHeld, mode == nil, pendingWindow == nil, !speaker.isActive else { return }
        if uptime() < echoGuardUntil { scheduleStandby(0); return }
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
    if accepted && handsFree { acceptHandsFreeTurn() } else { scheduleStandby() }
}
// Pop, then a short continuation window catches "...and search" without the wake phrase.
func acceptHandsFreeTurn() {
    playEarcon("Pop")
    guard handsFreeEnabled, followUpEnabled else { scheduleStandby(); return }
    cancelPendingWindow("cancel")
    let work = DispatchWorkItem {
        pendingWindow = nil
        if !openWindow(.continuation, seconds: followUpSeconds(.continuation), announced: false) && mode == nil { scheduleStandby() }
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
@discardableResult
func startRecognition() -> Bool {
    guard let recognizer = speech else { return false }
    segmentGeneration += 1
    standbyRaw = ""; standbyBoundary = 0; wakeOffset = 0; standbyChangedAt = uptime()
    let session = generation, segment = segmentGeneration
    let next = SFSpeechAudioBufferRecognitionRequest()
    next.shouldReportPartialResults = true; next.requiresOnDeviceRecognition = true; next.taskHint = .dictation
    next.contextualStrings = recognizerContext(ambient: mode == .standby || mode == .followUp)
    request = next
    setTapInput(next)
    task = recognizer.recognitionTask(with: next) { result, error in
        DispatchQueue.main.async { recognized(result, error, session: session, segment: segment) }
    }
    return true
}
// Apple ends a recognition request on its own (a final after a pause). Keep the microphone
// running and continue in a fresh request; late callbacks from the old one are ignored.
func rotateRequest() {
    guard mode != nil else { return }
    if mode == .standby || mode == .followUp { traceStandby("rotate") }
    let oldTask = task, oldRequest = request
    guard startRecognition() else {
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
    if ambient { traceStandby("begin", extra: ["mode": nextMode == .standby ? "standby" : "followUp"]) }
    if let failure = startInput(muteSeconds: muteSeconds) {
        audioFailed(failure, code: "mic", ambient: ambient); return false
    }
    lastWakeError = ""
    if ambient { setWakeListening(true) } else { output(["event": "listening_ready"]) }
    return true
}
// Installs the tap for the input device's current format and starts the microphone for the
// current session. Returns the user-facing failure, or nil once capture runs.
func startInput(muteSeconds: Double) -> String? {
    let session = generation
    setTapInput(request, muteSeconds: muteSeconds)
    let input = engine.inputNode, format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else { return "Microphone unavailable. Check your input device." }
    var lastLevelAt: TimeInterval = 0
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
        let now = uptime()
        tapLock.lock(); let live = tapRequest, admitted = tapMute.admits(at: now); tapBuffers += 1; tapLock.unlock()
        // Pre-roll right after barge-in may still hold the reply's tail: never transcribe it.
        if !admitted { return }
        live?.append(buffer)
        guard now - lastLevelAt > 0.08 else { return }; lastLevelAt = now
        let count = Int(buffer.frameLength)
        guard let values = buffer.floatChannelData?[0], count > 0 else { return }
        var sum: Float = 0; for i in 0..<count { sum += values[i] * values[i] }
        let rms = Double(sqrt(sum / Float(count)))
        DispatchQueue.main.async { observeLevel(rms, at: now, session: session) }
    }
    audioTapInstalled = true
    do { engine.prepare(); try engine.start() } catch { return "Microphone could not start. Check your input device." }
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
    let isSpeech = noiseFloor.observe(rms: rms)
    lastRms = rms
    if isSpeech { lastSpeechAt = now }
    if current == .followUp { windowRun.observe(speech: isSpeech, at: now) }
    // Levels only for an activated turn: never in standby or before a window detects speech.
    if current == .handsFree || current == .pushToTalk { output(["event": "audio_level", "level": min(1, rms * 12)]) }
}
func recognized(_ result: SFSpeechRecognitionResult?, _ error: Error?, session: Int, segment: Int) {
    guard let current = mode, session == generation, segment == segmentGeneration else { return }
    if let result = result {
        let raw = result.bestTranscription.formattedString
        let now = uptime()
        switch current {
        case .standby:
            // Nearby conversation keeps one hypothesis running; words appended after a pause
            // in the partials begin a new utterance, and only that utterance is tested.
            if raw != standbyRaw {
                standbyBoundary = utteranceBoundary(previous: standbyRaw, current: raw, boundary: standbyBoundary, gapSeconds: now - standbyChangedAt)
                standbyRaw = raw; standbyChangedAt = now
            }
            let utterance = standbyBoundary > 0 ? String(raw.dropFirst(standbyBoundary)) : raw
            guard commandAfterWakePhrase(utterance, ended: result.isFinal) != nil else {
                // Do not emit background speech, partials, or microphone levels.
                traceStandby(result.isFinal ? "final" : "partial", raw, extra: ["segments": result.bestTranscription.segments.count, "boundary": standbyBoundary])
                if !trimmed(raw).isEmpty { lastTextAt = now }
                pendingWake = !result.isFinal && wakePhraseAwaitingPause(utterance)
                if pendingWake { wakeOffset = standbyBoundary }
                if result.isFinal { clearSpeech(); scheduleStandby() }
                return
            }
            traceStandby("wake", raw, extra: ["boundary": standbyBoundary])
            wakeOffset = standbyBoundary
            activateWake(context: .command, window: nil)
        case .followUp:
            if commandAfterWakePhrase(raw, ended: result.isFinal) != nil {
                activateWake(context: turnContext(for: windowKind), window: windowKind)
            } else if followUpOnset(text: raw, speechRun: windowRun.longest, kind: windowKind) {
                activateFollowUp()
            } else {
                if !trimmed(raw).isEmpty { lastTextAt = now }
                pendingWake = !result.isFinal && wakePhraseAwaitingPause(raw)
                // Keep the window open with a fresh request until its deadline.
                if result.isFinal { rotateRequest() }
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
        rotateRequest()
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
        if errorRotations <= 3 && windowDeadline - uptime() > 0.5 { rotateRequest() } else { clearSpeech(); scheduleStandby(1) }
    case .handsFree, .pushToTalk:
        if released { completeTurn(trimmed(turn.current).isEmpty ? .final : .deadline); return }
        if errorRotations <= 3 {
            // Keep what was heard so far and continue in a fresh request.
            if !trimmed(turn.current).isEmpty { absorbFinalSegment(&turn, text: "", confidence: nil) }
            rotateRequest()
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
    if mode == .followUp {
        windowKind = kind; windowDeadline = uptime() + seconds
        output(["event": "followup_open", "kind": kind.rawValue, "seconds": seconds])
        return true
    }
    guard mode == nil || mode == .standby, !speaker.isActive else { return refuse() }
    restart?.cancel()
    windowKind = kind
    guard beginAudio(.followUp) else { return refuse() }
    windowKind = kind; windowDeadline = uptime() + seconds
    output(["event": "followup_open", "kind": kind.rawValue, "seconds": seconds])
    return true
}
func listenRequest(_ command: [String: Any]) -> [String: Any] {
    guard let kind = FollowUpKind(rawValue: command["kind"] as? String ?? "") else { return ["opened": false, "reason": "invalid"] }
    let seconds = clampFollowUpSeconds(command["seconds"] as? Double, kind: kind)
    guard handsFreeEnabled && followUpEnabled else { return ["opened": false, "reason": "disabled"] }
    if suspended { return ["opened": false, "reason": "suspended"] }
    if keyHeld || mode == .handsFree || mode == .pushToTalk { return ["opened": false, "reason": "capturing"] }
    if speaker.isActive { return ["opened": false, "reason": "speaking"] }
    if mode == .followUp { openWindow(kind, seconds: seconds, announced: false); return ["opened": true] }
    if securePaused || IsSecureEventInputEnabled() { return ["opened": false, "reason": "secure_input"] }
    cancelPendingWindow("cancel")
    let wait = echoGuardUntil - uptime()
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
// Speaker finished, was stopped, or failed. Ambient listening resumes after the echo guard;
// a reply that asked for an answer opens its window with a fresh recognition request.
func speechEnded(listen: ListenRequest?) {
    // The guard only gates ambient listening, so the route is sampled only in hands-free mode.
    echoGuardUntil = max(echoGuardUntil, speaker.lastAudibleAt + echoGuard(bluetoothOutput: handsFreeEnabled && outputBluetooth))
    cancelPendingWindow("cancel")
    // A short delay avoids restarting the recognizer when a silent PCM abort is followed at once by its system-voice fallback.
    guard let listen = listen else { if mode == nil { scheduleStandby(0.15) }; return }
    guard handsFreeEnabled, followUpEnabled else {
        output(["event": "followup_closed", "kind": listen.kind.rawValue, "endReason": "cancel"])
        if mode == nil { scheduleStandby(0.15) }
        return
    }
    pendingWindowKind = listen.kind
    let work = DispatchWorkItem {
        pendingWindow = nil; pendingWindowKind = nil
        if !openWindow(listen.kind, seconds: listen.seconds, announced: true) && mode == nil { scheduleStandby() }
    }
    pendingWindow = work
    DispatchQueue.main.asyncAfter(deadline: .now() + max(0, echoGuardUntil - uptime()) + 0.02, execute: work)
}
func speakRequest(_ command: [String: Any], pcm: Bool) -> [String: Any] {
    func reject(_ reason: String) -> [String: Any] { ["accepted": false, "reason": reason] }
    guard let id = command["utteranceId"] as? String, !id.isEmpty, id.count <= 200,
          let priority = SpeakPriority(label: command["priority"] as? String ?? "") else { return reject("invalid") }
    var listen: ListenRequest?
    if let window = command["listen"] as? [String: Any] {
        guard let kind = FollowUpKind(rawValue: window["kind"] as? String ?? "") else { return reject("invalid") }
        listen = ListenRequest(kind: kind, seconds: clampFollowUpSeconds(window["seconds"] as? Double, kind: kind))
    }
    let source: SpokenUtterance.Source
    if pcm {
        guard command["format"] as? String == "s16le", let rate = command["sampleRate"] as? Double, validPcmSampleRate(rate) else {
            return reject("invalid")
        }
        source = .pcm(rate)
    } else {
        guard let text = command["text"] as? String, !trimmed(text).isEmpty, text.count <= 1000 else { return reject("invalid") }
        source = .system(trimmed(text))
    }
    if handsFreeEnabled { outputBluetooth = defaultOutputIsBluetooth() }
    let decision = speakDecision(enabled: speaker.enabled, capturing: keyHeld || mode == .handsFree || mode == .pushToTalk,
                                 suspended: suspended, current: speaker.currentPriority, incoming: priority)
    if case .reject(let reason) = decision { return reject(reason) }
    if !speechLanguageSupported(locale: speech?.locale.identifier ?? speaker.locale) { return reject("unsupported_language") }
    let utterance = SpokenUtterance(id: id, priority: priority, listen: listen, source: source)
    if decision == .queue { speaker.enqueue(utterance); return ["accepted": true, "queued": true] }
    // Half-duplex: ambient recognition stops before audio starts, so a reply can never
    // wake the assistant or answer its own question.
    restart?.cancel()
    cancelPendingWindow("speaking")
    if mode == .followUp { clearSpeech(windowReason: "speaking") } else if mode == .standby { clearSpeech() }
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
            "voiceName": voice?.name ?? "", "patience": patience.rawValue, "followUp": followUpEnabled]
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
        let ok = speaker.pcmChunk(id: command["utteranceId"] as? String ?? "", seq: command["seq"] as? Int, base64: command["data"] as? String ?? "")
        output(["id": id, "result": ["ok": ok]])
    case "playPcmEnd": output(["id": id, "result": ["ok": speaker.pcmEnd(id: command["utteranceId"] as? String ?? "")]])
    case "playPcmAbort":
        let result = speaker.pcmAbort(id: command["utteranceId"] as? String ?? "")
        output(["id": id, "result": ["aborted": result.aborted, "started": result.started]])
    case "stopSpeaking": output(["id": id, "result": ["stopped": speaker.stop(.cancel)]])
    case "listen": output(["id": id, "result": listenRequest(command)])
    case "endFollowUp":
        // For example after a click on Yes: no window, and no window after the current reply.
        let had = mode == .followUp || pendingWindow != nil || speaker.current?.listen != nil
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
        observers.append(NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { _ in
            inputConfigurationChanged()
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
                    traceStandby("level", extra: ["buffers": buffers, "rms": Int((lastRms * 1000).rounded()), "engine": engine.isRunning])
                }
                if standbyEndpoint(now: now, started: startedAt, lastText: lastTextAt) == .recycle { traceStandby("recycle"); clearSpeech(); scheduleStandby(0.1) }
            case .followUp:
                if IsSecureEventInputEnabled() { clearSpeech(windowReason: "cancel"); securePaused = true; return }
                if pendingWake && wakePauseElapsed(now: now, lastText: lastTextAt, lastSpeech: lastSpeechAt) {
                    activateWake(context: turnContext(for: windowKind), window: windowKind); return
                }
                if followUpExpired(now: now, deadline: windowDeadline, lastSpeech: lastSpeechAt) {
                    clearSpeech(windowReason: "timeout"); scheduleStandby(0.1)
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
