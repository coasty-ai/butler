import Foundation
import AppKit
import AVFoundation
import Speech
import Carbon

// State belongs to the main run loop. Audio is processed on-device, never saved.
let writeLock = NSLock()
func output(_ data: [String: Any]) {
    guard let bytes = try? JSONSerialization.data(withJSONObject: data) else { return }
    writeLock.lock(); defer { writeLock.unlock() }
    FileHandle.standardOutput.write(bytes); FileHandle.standardOutput.write(Data([10]))
}
enum ListenMode { case standby, handsFree, pushToTalk }
var speech = SFSpeechRecognizer(locale: Locale(identifier: Locale.preferredLanguages.first ?? "en-US"))
let engine = AVAudioEngine()
var request: SFSpeechAudioBufferRecognitionRequest?
var task: SFSpeechRecognitionTask?
var tap: CFMachPort?
var mode: ListenMode?
var keyHeld = false
var heldAt: TimeInterval = 0
var startedAt: TimeInterval = 0
var lastSpeechAt: TimeInterval = 0
var lastTextAt: TimeInterval = 0
var released = false
var generation = 0
var lastText = ""
var finalText: String?
var finalConfidence: Double = 0
var controllerPID: pid_t = 0
var delayedStart: DispatchWorkItem?
var finalDeadline: DispatchWorkItem?
var restart: DispatchWorkItem?
var audioTapInstalled = false
var handsFreeEnabled = false
var suspended = false
var containsWakePhrase = false
var lastWakeError = ""
var wakeListening = false
var maintenance: Timer?
var observers: [NSObjectProtocol] = []
func uptime() -> TimeInterval { ProcessInfo.processInfo.systemUptime }
func setWakeListening(_ value: Bool) {
    guard value != wakeListening else { return }
    wakeListening = value
    output(["event": "wake_status", "enabled": handsFreeEnabled, "listening": value])
}
func stopAudio() {
    if engine.isRunning { engine.stop() }
    if audioTapInstalled { engine.inputNode.removeTap(onBus: 0); audioTapInstalled = false }
    request?.endAudio()
}
func clearSpeech() {
    // Invalidate callbacks before stopping/cancelling the old recognizer.
    generation += 1; mode = nil
    stopAudio(); task?.cancel(); task = nil; request = nil
    finalDeadline?.cancel(); finalDeadline = nil
    setWakeListening(false)
}
func scheduleStandby(_ delay: Double = 0.35) {
    restart?.cancel()
    guard handsFreeEnabled, !suspended, !keyHeld else { return }
    let work = DispatchWorkItem {
        guard handsFreeEnabled, !suspended, !keyHeld, mode == nil else { return }
        beginAudio(.standby)
    }
    restart = work; DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
}
func finish(_ text: String, _ final: Bool, _ confidence: Double) {
    guard mode != nil else { return }
    let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
    clearSpeech()
    if final && !clean.isEmpty {
        output(["event": "transcript_final", "text": clean, "confidence": confidence])
    } else {
        output(["event": "voice_error", "message": clean.isEmpty ? "Didn’t catch that. Try again." : "Couldn’t finalize that. Try again."])
    }
    scheduleStandby()
}
func finishRecovered(_ text: String) {
    guard mode == .handsFree || mode == .pushToTalk, released else { return }
    clearSpeech()
    // This is the most recent nonempty hypothesis at an explicit endpoint,
    // not a confident final recognition. It can never approve a pending action.
    output(["event": "transcript_recovered", "text": text, "confidence": 0,
            "source": "empty_final_after_endpoint"])
    scheduleStandby()
}
func availabilityError() -> String? {
    guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized,
          SFSpeechRecognizer.authorizationStatus() == .authorized else {
        return "Enable microphone and speech access in Settings."
    }
    guard !IsSecureEventInputEnabled() else { return "Voice is unavailable in secure input fields." }
    guard let recognizer = speech, recognizer.isAvailable, recognizer.supportsOnDeviceRecognition else {
        return "On-device speech is unavailable for this language. Use a text command."
    }
    return nil
}
func audioFailed(_ message: String, standby: Bool) {
    clearSpeech()
    if !standby || message != lastWakeError {
        output(["event": standby ? "wake_error" : "voice_error", "message": message])
    }
    if standby { lastWakeError = message }
    scheduleStandby(5)
}
func endCommand() {
    guard mode == .handsFree || mode == .pushToTalk, !released else { return }
    released = true
    output(["event": "shortcut_up"])
    if let text = finalText { finish(text, true, finalConfidence); return }
    stopAudio()
    let session = generation
    let work = DispatchWorkItem {
        if mode != nil && session == generation { finish(lastText, false, 0) }
    }
    finalDeadline = work; DispatchQueue.main.asyncAfter(deadline: .now() + 1.8, execute: work)
}
func beginAudio(_ nextMode: ListenMode) {
    guard !suspended, nextMode != .pushToTalk || keyHeld else { return }
    if let message = availabilityError() { audioFailed(message, standby: nextMode == .standby); return }
    clearSpeech()
    mode = nextMode; released = false; lastText = ""; finalText = nil; finalConfidence = 0
    containsWakePhrase = false; startedAt = uptime(); lastSpeechAt = startedAt; lastTextAt = startedAt
    let session = generation
    let next = SFSpeechAudioBufferRecognitionRequest()
    next.shouldReportPartialResults = true; next.requiresOnDeviceRecognition = true; next.taskHint = .dictation
    next.contextualStrings = ["Hey Assist", "Hey Open Assist"]
    request = next
    task = speech!.recognitionTask(with: next) { result, error in
        DispatchQueue.main.async {
            guard mode != nil, session == generation else { return }
            if let result = result {
                let raw = result.bestTranscription.formattedString
                if mode == .standby {
                    guard let command = commandAfterWakePhrase(raw) else {
                        // Do not emit background speech, partials, or microphone levels.
                        if result.isFinal { clearSpeech(); scheduleStandby() }
                        return
                    }
                    mode = .handsFree; containsWakePhrase = true; startedAt = uptime()
                    setWakeListening(false)
                    if controllerPID > 0 { kill(controllerPID, SIGUSR1) }
                    output(["event": "wake_detected"])
                    lastText = command; lastTextAt = uptime()
                }
                // Wake detection already opened this bounded command window.
                // Apple may report the next speech segment without the wake prefix.
                let command = containsWakePhrase ? activatedVoiceCommand(raw) : raw
                if command != lastText || result.isFinal {
                    output(["event": result.isFinal ? "recognition_final" : "recognition_update",
                            "textLength": command.count,
                            "source": commandAfterWakePhrase(raw) == nil ? "command_segment" : "wake_prefixed_segment"])
                }
                let retained = retainVoiceHypothesis(previous: lastText, update: command)
                if retained != lastText {
                    lastText = retained; lastTextAt = uptime()
                }
                output(["event": "transcript_partial", "text": lastText])
                let normalized = lastText.lowercased().trimmingCharacters(in: CharacterSet.punctuationCharacters.union(.whitespacesAndNewlines))
                if ["stop", "stop now", "wait", "pause"].contains(normalized) {
                    if controllerPID > 0 { kill(controllerPID, SIGUSR1) }
                    output(["event": "voice_control", "command": normalized])
                }
                if result.isFinal {
                    let completion = resolveVoiceFinal(command: command, latest: lastText, released: released)
                    if case .recovered(let text) = completion { finishRecovered(text); return }
                    if case .missing = completion {
                        if mode == .handsFree && lastText.isEmpty && !released {
                            // A final wake phrase alone opens a fresh, bounded command window.
                            beginAudio(.handsFree)
                        } else {
                            // Do not relabel a partial as final before an endpoint.
                            finish(lastText, false, 0)
                        }
                        return
                    }
                    let segments = result.bestTranscription.segments
                    // Exclude the wake phrase from approval confidence.
                    let phraseWords = raw.lowercased().range(of: #"^\s*hey[\s,]+open\s+assist\b"#, options: .regularExpression) != nil ? 3 : 2
                    let relevant = containsWakePhrase && commandAfterWakePhrase(raw) != nil ? segments.suffix(max(0, segments.count - phraseWords)) : segments[...]
                    finalConfidence = relevant.isEmpty ? 0 : relevant.map { Double($0.confidence) }.reduce(0, +) / Double(relevant.count)
                    finalText = lastText; stopAudio()
                    if mode == .handsFree || released { finish(lastText, true, finalConfidence) }
                }
            }
            if error != nil && mode != nil && session == generation && finalText == nil {
                if mode == .standby { clearSpeech(); scheduleStandby(1) }
                else { finish(lastText, false, 0) }
            }
        }
    }
    let input = engine.inputNode, format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else {
        audioFailed("Microphone unavailable. Check your input device.", standby: nextMode == .standby); return
    }
    var lastLevelAt: TimeInterval = 0
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
        next.append(buffer)
        let now = uptime()
        guard now - lastLevelAt > 0.08 else { return }; lastLevelAt = now
        let count = Int(buffer.frameLength)
        guard let values = buffer.floatChannelData?[0], count > 0 else { return }
        var sum: Float = 0; for i in 0..<count { sum += values[i] * values[i] }
        let rms = Double(sqrt(sum / Float(count)))
        DispatchQueue.main.async {
            guard session == generation, mode != nil else { return }
            if rms > 0.018 { lastSpeechAt = now }
            if mode != .standby { output(["event": "audio_level", "level": min(1, rms * 12)]) }
        }
    }
    audioTapInstalled = true
    do {
        engine.prepare(); try engine.start(); lastWakeError = ""
        if nextMode == .standby { setWakeListening(true) }
        else { output(["event": "listening_ready"]) }
    } catch { audioFailed("Microphone could not start. Check your input device.", standby: nextMode == .standby) }
}
func cancelSpeech() {
    keyHeld = false; delayedStart?.cancel(); delayedStart = nil; restart?.cancel()
    clearSpeech(); scheduleStandby()
}
func down() {
    guard !keyHeld else { return }
    restart?.cancel(); clearSpeech(); keyHeld = true; heldAt = uptime()
    if controllerPID > 0 { kill(controllerPID, SIGUSR1) }
    NSHapticFeedbackManager.defaultPerformer.perform(.alignment, performanceTime: .now)
    output(["event": "shortcut_down"])
    let session = generation
    let work = DispatchWorkItem { if session == generation && keyHeld { beginAudio(.pushToTalk) } }
    delayedStart = work; DispatchQueue.main.asyncAfter(deadline: .now() + 0.16, execute: work)
}
func up() {
    guard keyHeld else { return }; keyHeld = false; delayedStart?.cancel(); delayedStart = nil
    if uptime() - heldAt < 0.16 { clearSpeech(); output(["event": "shortcut_tap"]); scheduleStandby(); return }
    guard mode == .pushToTalk else { scheduleStandby(); return }
    endCommand()
}
func installShortcut() -> Bool {
    if tap != nil { return true }
    let mask = CGEventMask((1 << CGEventType.keyDown.rawValue) | (1 << CGEventType.keyUp.rawValue) | (1 << CGEventType.flagsChanged.rawValue))
    tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap, eventsOfInterest: mask, callback: { _, type, event, _ in
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if controllerPID > 0 { kill(controllerPID, SIGUSR1) }; up()
            if let tap = tap { CGEvent.tapEnable(tap: tap, enable: true) }; return Unmanaged.passUnretained(event)
        }
        let code = event.getIntegerValueField(.keyboardEventKeycode)
        if event.getIntegerValueField(.eventSourceUserData) == 0x4f50454e41535354 { return Unmanaged.passUnretained(event) }
        if type == .keyDown && code == 53 && (keyHeld || mode == .handsFree || mode == .pushToTalk) {
            cancelSpeech(); if controllerPID > 0 { kill(controllerPID, SIGUSR1) }
            output(["event": "voice_cancelled"]); return Unmanaged.passUnretained(event)
        }
        if type == .keyDown && code == 49 && event.flags.contains(.maskAlternate) && !event.flags.contains(.maskCommand) && !event.flags.contains(.maskControl) { down(); return nil }
        if type == .keyUp && code == 49 && keyHeld { up(); return nil }
        if type == .flagsChanged && keyHeld && !event.flags.contains(.maskAlternate) { up() }
        return Unmanaged.passUnretained(event)
    }, userInfo: nil)
    guard let tap = tap else { return false }
    let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
    CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes); CGEvent.tapEnable(tap: tap, enable: true); return true
}
func status() -> [String: Any] {
    ["microphone": AVCaptureDevice.authorizationStatus(for: .audio) == .authorized,
     "speech": SFSpeechRecognizer.authorizationStatus() == .authorized,
     "onDevice": speech?.supportsOnDeviceRecognition ?? false, "shortcut": tap != nil,
     "locale": speech?.locale.identifier ?? "unknown", "handsFree": handsFreeEnabled, "wakeListening": wakeListening]
}
func handle(_ command: [String: Any]) {
    let id = command["id"] ?? ""
    switch command["method"] as? String {
    case "status": output(["id": id, "result": status()])
    case "configure":
        if let pid = command["controllerPID"] as? Int { controllerPID = pid_t(pid) }
        if let locale = command["locale"] as? String { speech = SFSpeechRecognizer(locale: Locale(identifier: locale)) }
        if let enabled = command["handsFree"] as? Bool, enabled != handsFreeEnabled {
            handsFreeEnabled = enabled; cancelSpeech()
            output(["event": "wake_status", "enabled": enabled, "listening": false])
        }
        output(["id": id, "result": status()])
    case "enable": output(["id": id, "result": ["enabled": installShortcut()]])
    case "requestPermissions":
        AVCaptureDevice.requestAccess(for: .audio) { _ in
            SFSpeechRecognizer.requestAuthorization { _ in DispatchQueue.main.async {
                _ = installShortcut(); scheduleStandby(); output(["id": id, "result": status()])
            } }
        }
    case "cancel": cancelSpeech(); output(["id": id, "result": ["cancelled": true]])
    default: output(["id": id, "error": "Unknown voice method."])
    }
}
@main enum VoiceMain {
    static func main() {
        maintenance = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
            guard let current = mode else { return }
            if IsSecureEventInputEnabled() {
                audioFailed("Voice is unavailable in secure input fields.", standby: current == .standby); return
            }
            guard !released, current != .pushToTalk else { return }
            switch voiceEndpoint(now: uptime(), started: startedAt, lastSpeech: lastSpeechAt,
                                 lastText: lastTextAt, awake: current == .handsFree, hasText: !lastText.isEmpty) {
            case .recycle: clearSpeech(); scheduleStandby(0.1)
            case .finish: endCommand()
            case .empty: finish("", false, 0)
            case .none: break
            }
        }
        let center = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.willSleepNotification, NSWorkspace.sessionDidResignActiveNotification] {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { _ in
                suspended = true
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
            DispatchQueue.main.async { handsFreeEnabled = false; restart?.cancel(); clearSpeech(); exit(0) }
        }
        RunLoop.main.run()
    }
}
