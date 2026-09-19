import Foundation
import AppKit
import AVFoundation

// Spoken replies for coarena-voice. Text is synthesized on-device by the system voice,
// or arrives as in-memory PCM relayed by Electron; nothing is ever written to disk.
// All state belongs to the main thread. Slow work stays off it so the keyboard event tap
// never stalls: synthesizer creation and the voice list (measured 150-260 ms, and up to
// 1.5 s for a cold voice list) run on `work`, and the speaker's own output engine runs on
// `audio`. Under BUTLER_FULL_DUPLEX the PCM plays through the input engine instead
// (shareEngine), on the main thread with the microphone, so voice processing can cancel it.

struct ListenRequest: Equatable { let kind: FollowUpKind; let seconds: Double }
enum SpeechStopReason: String { case bargeIn = "barge_in", escape, replaced, cancel, sleep, disabled }

final class SpokenUtterance {
    enum Source { case system(String), pcm(Double) }
    let id: String
    let priority: SpeakPriority
    var listen: ListenRequest?
    let source: Source
    // The words being spoken: the system voice's sentence, or what Electron sent with a PCM
    // reply (playPcmStart, then each streamed sentence with its first chunk), for isSelfEcho.
    var text: String
    let createdAt: TimeInterval
    var requestedAt: TimeInterval
    var startedAt: TimeInterval = 0
    var started = false
    var audible = false
    var system: AVSpeechUtterance?
    // PCM playback state.
    var pending: [Float] = []
    var carry: UInt8?
    var expectedSeq = 0
    var ended = false
    var lastActivity: TimeInterval
    var totalSamples = 0
    var scheduled = 0
    var completed = 0
    var playedUntil: TimeInterval = 0

    init(id: String, priority: SpeakPriority, listen: ListenRequest?, source: Source, text: String) {
        self.id = id; self.priority = priority; self.listen = listen; self.source = source; self.text = text
        let now = uptime()
        createdAt = now; requestedAt = now; lastActivity = now
    }
    var sampleRate: Double? { if case .pcm(let rate) = source { return rate }; return nil }
}

// The rate Kokoro and the cloud voice send (electron/speech-output.ts), the shared player's first format.
private let sharedPcmSampleRate = 24000.0

// Where the PCM plays. The speaker's own engine (the default), used only on its audio queue:
// separate from the input engine, so stopping the microphone never cuts playback and vice
// versa. Or, `shared`, the input engine itself (BUTLER_FULL_DUPLEX): the player is a mixer
// input beside the microphone tap, so the input node's voice processing has the very audio
// it cancels from the microphone. Graph changes, starts and stops then happen on the main
// thread as the input's do, the engine runs while either side needs it (stopEngineIfIdle),
// and Voice.swift's configuration-change observer covers the input and the playback at once.
private final class PcmOutput {
    let engine: AVAudioEngine
    let shared: Bool
    let player = AVAudioPlayerNode()
    var format: AVAudioFormat?
    private var observer: NSObjectProtocol?
    // A route or format change stops and uninitializes an owned engine; the owner discards it.
    init(engine: AVAudioEngine = AVAudioEngine(), shared: Bool = false, onConfigurationChange: ((PcmOutput) -> Void)? = nil) {
        self.engine = engine; self.shared = shared
        engine.attach(player)
        if let onConfigurationChange = onConfigurationChange {
            observer = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] _ in
                if let self = self { onConfigurationChange(self) }
            }
        }
    }
    func discard() {
        if let observer = observer { NotificationCenter.default.removeObserver(observer); self.observer = nil }
        stop()
    }
    // The player's edge to the mixer, in the reply's format (the mixer resamples). A shared engine
    // keeps running through a change: only the player stops, and the mixer takes the new input live.
    func connect(sampleRate: Double) throws {
        guard format?.sampleRate != sampleRate else { return }
        player.stop()
        if !shared && engine.isRunning { engine.stop() }
        guard let next = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false) else {
            throw NSError(domain: "voice.speaker", code: 1)
        }
        engine.disconnectNodeOutput(player)
        engine.connect(player, to: engine.mainMixerNode, format: next)
        format = next
    }
    func prepare(sampleRate: Double) throws {
        try connect(sampleRate: sampleRate)
        if !engine.isRunning {
            if shared { try startEngine() } else { engine.prepare(); try engine.start() }
        }
        if !player.isPlaying { player.play() }
    }
    func schedule(_ samples: [Float], completion: @escaping () -> Void) -> Bool {
        guard let format = format, !samples.isEmpty,
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)),
              let channel = buffer.floatChannelData?[0] else { return false }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { source in
            if let base = source.baseAddress { channel.update(from: base, count: samples.count) }
        }
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { _ in completion() }
        return true
    }
    func stop() {
        player.stop()
        if !shared && engine.isRunning { engine.stop() }
    }
}

final class Speaker: NSObject, AVSpeechSynthesizerDelegate {
    var enabled = false
    var voiceId = ""
    var rateMultiplier = 1.0
    var locale = Locale.preferredLanguages.first ?? "en-US"
    // Called when nothing is left to say, with the listen request of a naturally finished
    // reply. The echo guard is measured from lastAudibleAt.
    var onEnded: ((ListenRequest?) -> Void)?
    private(set) var current: SpokenUtterance?
    private(set) var queued: SpokenUtterance?
    private(set) var lastAudibleAt: TimeInterval = -1000
    // The reply heard last, for its words (spokenText) and its route (echoCancelled) after it ended.
    private(set) var lastAudible: SpokenUtterance?
    private var synthesizer: AVSpeechSynthesizer?
    private var voices: [VoiceInfo]?
    private var systemVoices: [String: AVSpeechSynthesisVoice] = [:]
    private var warming = false
    private var primedVoiceId = ""
    private var voiceWaiters: [([VoiceInfo]) -> Void] = []
    private var voiceObserver: NSObjectProtocol?
    private let work = DispatchQueue(label: "voice.speaker.work", qos: .userInitiated)
    private let audio = DispatchQueue(label: "voice.speaker.audio", qos: .userInteractive)
    private var pcmOutputEngine: PcmOutput? // Touched only on `audio`.
    private var sharedOutput: PcmOutput? // BUTLER_FULL_DUPLEX: the input engine, main thread only.
    private var playbackToken = 0
    // playbackToken as the audio queue sees it: work queued before a stop is skipped, so the
    // stop itself is not delayed behind engine starts and buffer scheduling for a reply that ended.
    private let tokenLock = NSLock()
    private var audioToken = 0
    // Signalled on `audio` once the latest requested output engine stop has run.
    private var outputStopDone: DispatchSemaphore?
    private var systemStopPending = false

    var isActive: Bool { current != nil }
    var currentPriority: SpeakPriority? { current?.priority }
    // Speech was audible now or within the barge-in window (the mic would hear its tail).
    var recentlyAudible: Bool { current?.audible == true || uptime() - lastAudibleAt <= bargeInRecentSeconds }
    // Full duplex: PCM plays through the input engine (shareEngine succeeded).
    var sharesEngine: Bool { sharedOutput != nil }
    // Full duplex: a PCM reply is playing through the shared engine, which must keep running.
    var holdsEngine: Bool { sharesEngine && current?.started == true && current?.sampleRate != nil }
    // Full duplex: the reply being heard, or just heard, played through the shared engine, so voice
    // processing had it as its reference. The system voice plays outside the engine: its replies
    // keep the half-duplex guard.
    var echoCancelled: Bool { sharesEngine && (current ?? lastAudible)?.sampleRate != nil }
    // The reply's words, spoken now or within selfEchoRecentSeconds, for isSelfEcho.
    func spokenText(at now: TimeInterval) -> String? {
        if let current = current { return current.text }
        return now - lastAudibleAt <= selfEchoRecentSeconds ? lastAudible?.text : nil
    }

    // BUTLER_FULL_DUPLEX: PCM plays through the input engine. Called once before that engine
    // first starts, so its output path exists from the first start on; at the rate Kokoro and the
    // cloud voice send (another rate reconnects the player live). A format the mixer refuses
    // leaves the speaker on its own engine, and the helper half duplex.
    func shareEngine(_ engine: AVAudioEngine) {
        let output = PcmOutput(engine: engine, shared: true)
        guard (try? output.connect(sampleRate: sharedPcmSampleRate)) != nil else { return }
        sharedOutput = output
    }

    // The shared engine stopped under a reply (a route or format change, or voice processing
    // turned off): as with its own engine, the reply ends as cancelled and a queued one plays next.
    func sharedEngineStopped() {
        guard sharesEngine else { return }
        outputRouteChanged()
    }

    // MARK: Voices

    func setEnabled(_ value: Bool) {
        enabled = value
        if value { warmUp(); prime() } else { stop(.disabled) }
    }

    // Creates the synthesizer and loads the voice list off the main thread, without speaking.
    func warmUp() {
        guard !warming, synthesizer == nil || voices == nil else { return }
        warming = true
        work.async {
            let synthesizer = AVSpeechSynthesizer()
            let list = AVSpeechSynthesisVoice.speechVoices().map(Speaker.info)
            DispatchQueue.main.async {
                self.warming = false
                if self.synthesizer == nil { synthesizer.delegate = self; self.synthesizer = synthesizer }
                self.voices = list
                self.observeVoiceChanges()
                self.prefetchVoice()
                let waiters = self.voiceWaiters; self.voiceWaiters = []
                waiters.forEach { $0(list) }
                if let current = self.current, case .system(let text) = current.source, current.system == nil {
                    self.startSystem(current, text: text)
                }
            }
        }
    }

    private static func info(_ voice: AVSpeechSynthesisVoice) -> VoiceInfo {
        var quality = VoiceQuality.standard
        if voice.quality == .enhanced { quality = .enhanced }
        if #available(macOS 13.0, *), voice.quality == .premium { quality = .premium }
        var novelty = false, personal = false
        if #available(macOS 14.0, *) {
            novelty = voice.voiceTraits.contains(.isNoveltyVoice)
            personal = voice.voiceTraits.contains(.isPersonalVoice)
        }
        return VoiceInfo(id: voice.identifier, name: voice.name, language: voice.language, quality: quality, novelty: novelty, personal: personal)
    }

    // A Premium download takes effect without a restart.
    private func observeVoiceChanges() {
        guard voiceObserver == nil, #available(macOS 14.0, *) else { return }
        voiceObserver = NotificationCenter.default.addObserver(forName: AVSpeechSynthesizer.availableVoicesDidChangeNotification,
                                                               object: nil, queue: .main) { [weak self] _ in
            guard let self = self else { return }
            self.work.async {
                let list = AVSpeechSynthesisVoice.speechVoices().map(Speaker.info)
                DispatchQueue.main.async { self.voices = list; self.systemVoices = [:]; self.prefetchVoice() }
            }
        }
    }

    func withVoices(timeout: Double = 3, _ reply: @escaping ([VoiceInfo]) -> Void) {
        if let voices = voices { reply(voices); return }
        var answered = false
        let once: ([VoiceInfo]) -> Void = { list in if !answered { answered = true; reply(list) } }
        voiceWaiters.append(once)
        warmUp()
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { once(self.voices ?? []) }
    }

    var resolvedVoice: VoiceInfo? {
        guard let voices = voices else { warmUp(); return nil }
        return chooseVoice(voices, selected: voiceId, language: locale)
    }

    func voiceSelected(_ id: String) {
        voiceId = id
        prefetchVoice()
    }

    // Resolving a voice object costs a few ms the first time; do it before it is needed.
    private func prefetchVoice() {
        guard let info = resolvedVoice else { return }
        guard systemVoices[info.id] == nil else { prime(); return }
        work.async {
            let voice = AVSpeechSynthesisVoice(identifier: info.id)
            DispatchQueue.main.async { if let voice = voice { self.systemVoices[info.id] = voice }; self.prime() }
        }
    }

    // A voice's first synthesis took about 630 ms here and later ones about 12 ms. Render a short
    // phrase into discarded in-memory buffers (write, never speak) so the first reply starts
    // promptly. Nothing plays and nothing is saved.
    private func prime() {
        guard enabled, current == nil, let synthesizer = synthesizer, let info = resolvedVoice,
              primedVoiceId != info.id, let voice = systemVoices[info.id] else { return }
        flushSystemStop()
        primedVoiceId = info.id
        let warmup = AVSpeechUtterance(string: "Okay.")
        warmup.voice = voice
        warmup.volume = 0
        synthesizer.write(warmup) { _ in }
    }

    // MARK: Utterances

    // Starts now, replacing any current reply (the caller already applied speakDecision).
    func play(_ utterance: SpokenUtterance) {
        if let old = current {
            current = nil
            halt(old)
            finished(old, interrupted: true, reason: .replaced)
            if old.audible { audibleEnded(old) }
        }
        begin(utterance)
    }

    func enqueue(_ utterance: SpokenUtterance) {
        if let old = queued { queued = nil; finished(old, interrupted: true, reason: .replaced) }
        queued = utterance
    }

    // Stops playback and clears the queue. Barge-in, Escape, cancel, sleep and disabling all land here.
    // Never blocks: it runs inside the keyboard event tap (barge-in, Escape). State and events
    // change now; the synthesizer and output engine stop right after the callback returns.
    @discardableResult
    func stop(_ reason: SpeechStopReason) -> Bool {
        let active = current, waiting = queued
        current = nil; queued = nil
        if let active = active {
            halt(active)
            finished(active, interrupted: true, reason: reason)
            if active.audible { audibleEnded(active) }
        }
        if let waiting = waiting { finished(waiting, interrupted: true, reason: reason) }
        if active != nil { onEnded?(nil) }
        return active != nil || waiting != nil
    }

    // Drops a pending window request if the reply is still playing (a click already answered it).
    func clearListen() {
        current?.listen = nil
        queued?.listen = nil
    }

    // Barge-in, before the microphone starts: completes a pending synthesizer stop now and waits,
    // at most `timeout`, until the output engine has stopped, so the reply's tail cannot reach
    // the new turn. Runs on the main thread after the event tap callback has returned.
    func finishStopping(timeout: Double) {
        flushSystemStop()
        guard let done = outputStopDone else { return }
        outputStopDone = nil
        _ = done.wait(timeout: .now() + max(0, timeout))
    }

    func shutdown() {
        current = nil; queued = nil
        systemStopPending = false
        synthesizer?.stopSpeaking(at: .immediate)
        stopPlayer()
    }

    private func begin(_ utterance: SpokenUtterance) {
        current = utterance
        utterance.requestedAt = uptime()
        switch utterance.source {
        case .system(let text): startSystem(utterance, text: text)
        case .pcm(let rate):
            if pcmReadyToStart(bufferedSamples: utterance.pending.count, sampleRate: rate, ended: utterance.ended) { startPcm(utterance) }
            else if utterance.ended { fail(utterance, "empty") }
        }
    }

    private func halt(_ utterance: SpokenUtterance) {
        switch utterance.source {
        case .system: if utterance.system != nil { requestSystemStop() }
        case .pcm: if utterance.started { stopPlayer() }
        }
    }

    // stopSpeaking may wait on the speech service (measured under 0.1 ms while rendering to
    // memory, but a playing utterance could not be measured without sound), and halt can run
    // inside the event tap. It runs on the next main-queue turn instead; startSystem and prime
    // complete a pending stop first, so a late stop can never cut a newer reply.
    private func requestSystemStop() {
        guard !systemStopPending else { return }
        systemStopPending = true
        DispatchQueue.main.async { self.flushSystemStop() }
    }

    private func flushSystemStop() {
        guard systemStopPending else { return }
        systemStopPending = false
        synthesizer?.stopSpeaking(at: .immediate)
    }

    private func finished(_ utterance: SpokenUtterance, interrupted: Bool, reason: SpeechStopReason?) {
        var event: [String: Any] = ["event": "speech_finished", "utteranceId": utterance.id, "interrupted": interrupted]
        if let reason = reason { event["reason"] = reason.rawValue }
        output(event)
    }

    // A reply that was heard just ended: the echo guard, and the self-echo filter, count from here.
    private func audibleEnded(_ utterance: SpokenUtterance) {
        lastAudibleAt = uptime()
        lastAudible = utterance
    }

    private func markStarted(_ utterance: SpokenUtterance) {
        guard !utterance.started else { return }
        utterance.started = true
        utterance.startedAt = uptime()
        output(["event": "speech_started", "utteranceId": utterance.id,
                "latencyMs": Int(((utterance.startedAt - utterance.requestedAt) * 1000).rounded())])
    }

    // Natural end or error: play the queued reply, or hand listening back.
    private func advance(listen: ListenRequest?) {
        let now = uptime()
        while let next = queued {
            queued = nil
            if queuedUtteranceStale(priority: next.priority, queuedAt: next.createdAt, now: now) {
                finished(next, interrupted: true, reason: .cancel); continue
            }
            begin(next) // A reply that fails at once advances again itself.
            return
        }
        onEnded?(listen)
    }

    private func completeNaturally(_ utterance: SpokenUtterance) {
        guard current === utterance else { return }
        current = nil
        if utterance.sampleRate != nil { stopPlayer() }
        finished(utterance, interrupted: false, reason: nil)
        audibleEnded(utterance)
        advance(listen: utterance.listen)
    }

    private func fail(_ utterance: SpokenUtterance, _ message: String) {
        output(["event": "speech_error", "utteranceId": utterance.id, "message": message])
        if queued === utterance { queued = nil; finished(utterance, interrupted: true, reason: .cancel); return }
        guard current === utterance else { return }
        current = nil
        halt(utterance)
        finished(utterance, interrupted: true, reason: .cancel)
        if utterance.audible { audibleEnded(utterance) }
        advance(listen: nil)
    }

    // MARK: System engine

    private func startSystem(_ utterance: SpokenUtterance, text: String) {
        guard let synthesizer = synthesizer, voices != nil else { warmUp(); return } // Starts when warm.
        guard let info = resolvedVoice else { fail(utterance, "unavailable"); return }
        let voice = systemVoices[info.id] ?? AVSpeechSynthesisVoice(identifier: info.id)
        guard let voice = voice else { fail(utterance, "unavailable"); return }
        systemVoices[info.id] = voice
        let spoken = AVSpeechUtterance(string: systemVoiceText(text))
        spoken.voice = voice
        spoken.rate = speechRate(multiplier: rateMultiplier)
        spoken.pitchMultiplier = 1.0
        spoken.volume = 1.0
        spoken.prefersAssistiveTechnologySettings = false
        spoken.preUtteranceDelay = 0
        spoken.postUtteranceDelay = 0
        utterance.system = spoken
        utterance.audible = true
        utterance.requestedAt = uptime()
        flushSystemStop()
        synthesizer.speak(spoken)
    }

    private func onMain(_ body: @escaping () -> Void) {
        if Thread.isMainThread { body() } else { DispatchQueue.main.async(execute: body) }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        onMain {
            guard let current = self.current, current.system === utterance else { return }
            self.markStarted(current)
        }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        onMain {
            // A stopped utterance may also report didFinish; identity keeps it from ending its replacement.
            guard let current = self.current, current.system === utterance else { return }
            self.markStarted(current)
            self.completeNaturally(current)
        }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        onMain {
            guard let current = self.current, current.system === utterance else { return }
            self.current = nil
            self.finished(current, interrupted: true, reason: .cancel)
            self.audibleEnded(current)
            self.advance(listen: nil)
        }
    }

    // MARK: PCM engine

    private func matching(_ id: String) -> SpokenUtterance? {
        if let current = current, current.id == id { return current }
        if let queued = queued, queued.id == id { return queued }
        return nil
    }

    // text: the words of the sentence this chunk begins (a streamed reply), appended to the reply's.
    func pcmChunk(id: String, seq: Int?, base64: String, text: String?) -> Bool {
        guard let utterance = matching(id), let rate = utterance.sampleRate, !utterance.ended,
              pcmChunkAccepted(seq: seq, expected: utterance.expectedSeq),
              base64.utf8.count <= 4_000_000, let data = Data(base64Encoded: base64) else { return false }
        utterance.expectedSeq = (seq ?? utterance.expectedSeq) + 1
        utterance.lastActivity = uptime()
        if let text = text, !text.isEmpty, text.count <= spokenTextLimit {
            utterance.text += (utterance.text.isEmpty ? "" : " ") + text
        }
        let samples = pcmSamplesFromS16LE(data, carry: &utterance.carry)
        guard Double(utterance.totalSamples + samples.count) <= rate * pcmMaxSeconds else { fail(utterance, "too_long"); return false }
        utterance.totalSamples += samples.count
        guard utterance === current else { utterance.pending += samples; return true }
        if utterance.started { schedule(samples, for: utterance); return true }
        utterance.pending += samples
        if pcmReadyToStart(bufferedSamples: utterance.pending.count, sampleRate: rate, ended: false) { startPcm(utterance) }
        return true
    }

    func pcmEnd(id: String) -> Bool {
        guard let utterance = matching(id), utterance.sampleRate != nil, !utterance.ended else { return false }
        utterance.ended = true
        utterance.lastActivity = uptime()
        guard utterance === current else { return true }
        if !utterance.started {
            if utterance.pending.isEmpty { fail(utterance, "empty") } else { startPcm(utterance) }
        } else if utterance.completed >= utterance.scheduled {
            completeNaturally(utterance)
        }
        return true
    }

    // Before any audio played, an abort is silent so the same reply can fall back to the system voice.
    func pcmAbort(id: String) -> (aborted: Bool, started: Bool) {
        if let waiting = queued, waiting.id == id, waiting.sampleRate != nil { queued = nil; return (true, false) }
        guard let utterance = current, utterance.id == id, utterance.sampleRate != nil else { return (false, false) }
        current = nil
        if utterance.started {
            halt(utterance)
            finished(utterance, interrupted: true, reason: .cancel)
            audibleEnded(utterance)
            if let waiting = queued { queued = nil; finished(waiting, interrupted: true, reason: .cancel) }
            onEnded?(nil)
            return (true, true)
        }
        advance(listen: nil)
        return (true, false)
    }

    private func startPcm(_ utterance: SpokenUtterance) {
        guard utterance === current, !utterance.started, !utterance.pending.isEmpty else { return }
        let samples = utterance.pending
        utterance.pending = []
        utterance.audible = true
        markStarted(utterance)
        schedule(samples, for: utterance)
    }

    private func schedule(_ samples: [Float], for utterance: SpokenUtterance) {
        guard let rate = utterance.sampleRate, !samples.isEmpty else { return }
        let token = playbackToken
        utterance.scheduled += 1
        utterance.playedUntil = max(utterance.playedUntil, uptime()) + Double(samples.count) / rate
        if let shared = sharedOutput {
            // Full duplex: the input engine's graph is the main thread's (Voice.swift), so this runs
            // here; a start that fails (the input's own failure path) ends the reply loudly.
            let ok = (try? shared.prepare(sampleRate: rate)) != nil
                && shared.schedule(samples) { DispatchQueue.main.async { self.bufferPlayed(utterance, token: token) } }
            if !ok { fail(utterance, "output_unavailable") }
            return
        }
        audio.async {
            // Stopped meanwhile: skip, so the queued stop runs at once.
            guard self.audioTokenIs(token) else { return }
            var ok = true
            let engine = self.pcmOutputEngine ?? PcmOutput { [weak self] output in self?.outputConfigurationChanged(output) }
            self.pcmOutputEngine = engine
            do { try engine.prepare(sampleRate: rate) } catch { ok = false }
            if ok {
                ok = engine.schedule(samples) {
                    DispatchQueue.main.async { self.bufferPlayed(utterance, token: token) }
                }
            }
            if !ok { DispatchQueue.main.async { if token == self.playbackToken { self.fail(utterance, "output_unavailable") } } }
        }
    }

    private func bufferPlayed(_ utterance: SpokenUtterance, token: Int) {
        guard token == playbackToken, current === utterance else { return }
        utterance.completed += 1
        if utterance.ended && utterance.completed >= utterance.scheduled { completeNaturally(utterance) }
    }

    private func audioTokenIs(_ token: Int) -> Bool {
        tokenLock.lock(); defer { tokenLock.unlock() }
        return token == audioToken
    }

    private func stopPlayer() {
        playbackToken += 1 // Completion callbacks of flushed buffers are ignored.
        let token = playbackToken
        tokenLock.lock(); audioToken = token; tokenLock.unlock()
        if let shared = sharedOutput {
            // The player stops now (cheap, so it can run inside the event tap); the engine, if no one
            // else needs it, on the next main-queue turn, after a barge-in has installed its tap.
            shared.stop()
            DispatchQueue.main.async { stopEngineIfIdle() }
            return
        }
        let done = DispatchSemaphore(value: 0)
        outputStopDone = done
        // Work for a newer reply is always queued behind this block, so stopping here never cuts it.
        audio.async {
            self.pcmOutputEngine?.stop()
            done.signal()
        }
    }

    // A route or format change (headphones, a Bluetooth profile switch) stopped the output
    // engine and dropped its buffers. The engine is rebuilt on the next reply; a reply that
    // was playing ends as cancelled (no speech_error), and a queued one plays next.
    private func outputConfigurationChanged(_ output: PcmOutput) {
        audio.async {
            guard self.pcmOutputEngine === output else { return }
            self.pcmOutputEngine = nil
            output.discard()
            DispatchQueue.main.async { self.outputRouteChanged() }
        }
    }

    private func outputRouteChanged() {
        guard let utterance = current, utterance.sampleRate != nil, utterance.started else { return }
        current = nil
        stopPlayer()
        finished(utterance, interrupted: true, reason: .cancel)
        audibleEnded(utterance)
        advance(listen: nil)
    }

    // MARK: Watchdogs (maintenance tick, main thread)

    func tick(_ now: TimeInterval) {
        if let waiting = queued, queuedUtteranceStale(priority: waiting.priority, queuedAt: waiting.createdAt, now: now) {
            queued = nil; finished(waiting, interrupted: true, reason: .cancel)
        }
        guard let utterance = current else { return }
        switch utterance.source {
        case .pcm:
            if utterance.ended {
                // Completion callbacks can be lost when the output device changes.
                if utterance.started && now > utterance.playedUntil + 1.5 { completeNaturally(utterance) }
            } else if pcmStalled(now: now, requested: utterance.requestedAt, lastActivity: utterance.lastActivity,
                                 started: utterance.started, ended: false, playedUntil: utterance.playedUntil) {
                fail(utterance, "stalled")
            }
        case .system(let text):
            // A synthesizer that never reports back must not keep the microphone paused.
            // didStart is not relied on alone: a long reply without it is bounded by its length.
            let limit = 10 + Double(text.count) * 0.15 / max(rateMultiplier, 0.5)
            if utterance.system == nil {
                if now - utterance.requestedAt > 6 { fail(utterance, "unavailable") }
            } else if !utterance.started && now - utterance.requestedAt > 5 && synthesizer?.isSpeaking != true {
                fail(utterance, "no_start")
            } else if now - (utterance.started ? utterance.startedAt : utterance.requestedAt) > limit {
                fail(utterance, "timeout")
            }
        }
    }
}

// MARK: - Earcons (hands-free only, soft)

private let earconNames = ["Tink", "Pop"]
private let earconVolume: Float = 0.25
private var earcons: [String: NSSound] = [:]
// BUTLER_FULL_DUPLEX: the same system sounds, read into memory once, as mixer inputs of the
// input engine (a player per sound, in the file's own format), so voice processing cancels
// them from the microphone too. earconUntil keeps the engine running until the sound has played.
private var engineEarcons: [String: (player: AVAudioPlayerNode, buffer: AVAudioPCMBuffer)] = [:]
private var earconUntil: TimeInterval = 0
func earconSounding(at now: TimeInterval) -> Bool { now < earconUntil }
func loadEarcons() {
    guard !fullDuplexRequested else { return }
    for name in earconNames where earcons[name] == nil {
        if let sound = NSSound(named: NSSound.Name(name)) { sound.volume = earconVolume; earcons[name] = sound }
    }
}
// Before the shared engine first starts, so the mixer has every input from the first start on.
func loadEngineEarcons(_ engine: AVAudioEngine) {
    for name in earconNames where engineEarcons[name] == nil {
        guard let file = try? AVAudioFile(forReading: URL(fileURLWithPath: "/System/Library/Sounds/\(name).aiff")),
              let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)),
              (try? file.read(into: buffer)) != nil else { continue }
        let player = AVAudioPlayerNode()
        player.volume = earconVolume
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: buffer.format)
        engineEarcons[name] = (player, buffer)
    }
}
func playEarcon(_ name: String) {
    guard soundsEnabled, handsFreeEnabled else { return }
    if fullDuplexRequested {
        guard let (player, buffer) = engineEarcons[name], engine.isRunning || (try? startEngine()) != nil else { return }
        player.stop()
        player.scheduleBuffer(buffer, completionHandler: nil)
        player.play()
        let length = Double(buffer.frameLength) / buffer.format.sampleRate
        earconUntil = uptime() + length
        DispatchQueue.main.asyncAfter(deadline: .now() + length + 0.05) { stopEngineIfIdle() }
        return
    }
    loadEarcons()
    guard let sound = earcons[name] else { return }
    if sound.isPlaying { sound.stop() }
    sound.volume = earconVolume
    sound.play()
}
