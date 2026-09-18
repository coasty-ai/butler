import Foundation
import CoreServices

// coarena-messages: the only process that touches Messages.
//
// Sending uses the Messages app through AppleScript and needs macOS Automation
// permission. Receiving reads ~/Library/Messages/chat.db read-only and needs
// Full Disk Access. Both permissions are the user's to grant; this helper
// detects a refusal and reports it upward instead of retrying blindly.
//
// It sends only to the one configured handle, never writes to the database,
// never reads a message body until MessageSafety.swift has accepted the row's
// metadata, and never logs message text. All decisions live in
// MessageSafety.swift, and the reading in MessagesDatabase.swift, so both can
// be tested without a Mac session.
//
// Two queues: sends run on the main queue (AppleScript needs its run loop, and
// a first send can sit in the Automation prompt for minutes); everything that
// touches the database runs on dbQueue, so a waiting send never holds a poll
// past the app's 8 s deadline.

let outputLock = NSLock()
func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
    outputLock.lock()
    FileHandle.standardOutput.write(data + Data([10]))
    outputLock.unlock()
}

// MARK: - Reading (MessagesDatabase.swift)

let messagesDirectory = NSHomeDirectory() + "/Library/Messages"
let messagesDatabasePath = messagesDirectory + "/chat.db"

// MARK: - Watching for new rows

/// Watches ~/Library/Messages for writes to chat.db or its WAL and emits the
/// content-free "changed" line, so the app polls within a fraction of a second
/// instead of on its next timer. The app's periodic poll stays the fallback:
/// FSEvents under the Messages privacy protection is not guaranteed. Watching
/// the directory, not the files, survives the WAL being deleted and recreated
/// when Messages quits. All state lives on its own queue.
final class DatabaseWatch {
    private let queue = DispatchQueue(label: "ai.coarena.messages.watch")
    private var stream: FSEventStreamRef?
    private var throttle = MessageChangeThrottle()

    func set(_ on: Bool) { queue.sync { on ? start() : stop() } }

    private func start() {
        guard stream == nil else { return }
        // The watch is a process-lifetime global, so an unretained pointer is safe.
        var context = FSEventStreamContext(version: 0, info: Unmanaged.passUnretained(self).toOpaque(),
                                           retain: nil, release: nil, copyDescription: nil)
        let callback: FSEventStreamCallback = { _, info, _, paths, _, _ in
            guard let info else { return }
            let names = Unmanaged<CFArray>.fromOpaque(paths).takeUnretainedValue() as? [String] ?? []
            guard names.contains(where: messageDatabaseFileChanged) else { return }
            Unmanaged<DatabaseWatch>.fromOpaque(info).takeUnretainedValue().changed()
        }
        let flags = FSEventStreamCreateFlags(kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagNoDefer | kFSEventStreamCreateFlagUseCFTypes)
        guard let created = FSEventStreamCreate(nil, callback, &context, [messagesDirectory] as CFArray,
                                                FSEventStreamEventId(kFSEventStreamEventIdSinceNow), 0.05, flags)
        else { return }
        FSEventStreamSetDispatchQueue(created, queue)
        guard FSEventStreamStart(created) else {
            FSEventStreamInvalidate(created)
            FSEventStreamRelease(created)
            return
        }
        stream = created
    }

    private func stop() {
        guard let stream else { return }
        FSEventStreamStop(stream)
        FSEventStreamInvalidate(stream)
        FSEventStreamRelease(stream)
        self.stream = nil
    }

    /// On `queue`. At most one line per 250 ms; a burst ends with one trailing
    /// line so the last write is never missed.
    private func changed() {
        switch throttle.signal(now: ProcessInfo.processInfo.systemUptime) {
        case .emit: emit(messageChangedEvent)
        case .schedule(let delay):
            queue.asyncAfter(deadline: .now() + delay) { [self] in
                throttle.fire(now: ProcessInfo.processInfo.systemUptime)
                // Switched off meanwhile: the app asked for silence.
                if stream != nil { emit(messageChangedEvent) }
            }
        case .absorbed: break
        }
    }
}

// MARK: - Sending

let messagesBundleId = "com.apple.MobileSMS"

/// Automation permission for Messages, without prompting.
func automationState() -> String {
    var target = AEAddressDesc()
    var created: OSStatus = -1
    messagesBundleId.withCString { pointer in
        created = OSStatus(AECreateDesc(typeApplicationBundleID, pointer, strlen(pointer), &target))
    }
    guard created == noErr else { return "unknown" }
    defer { AEDisposeDesc(&target) }
    switch AEDeterminePermissionToAutomateTarget(&target, typeWildCard, typeWildCard, false) {
    case noErr: return "granted"
    case OSStatus(errAEEventNotPermitted): return "denied"
    case OSStatus(errAEEventWouldRequireUserConsent): return "ask"
    case OSStatus(procNotFound): return "messages_closed"
    default: return "unknown"
    }
}

/// Sends one iMessage to the configured handle. The handle and the text are
/// escaped by MessageSafety; nothing else is interpolated into the script.
func sendMessage(handle: String, text: String) throws {
    let body = appleScriptLiteral(text)
    guard !body.isEmpty else { throw MessageError(code: "BAD_REQUEST", message: "Nothing to send.") }
    let target = appleScriptLiteral(handle)
    let source = """
    tell application "Messages"
        set theService to 1st service whose service type = iMessage
        set theBuddy to buddy "\(target)" of theService
        send "\(body)" to theBuddy
    end tell
    """
    guard let script = NSAppleScript(source: source) else {
        throw MessageError(code: "SEND_FAILED", message: "The message could not be prepared.")
    }
    var error: NSDictionary?
    script.executeAndReturnError(&error)
    guard let error else { return }
    let number = (error[NSAppleScript.errorNumber] as? Int) ?? 0
    switch number {
    case -1743, -10004:
        throw MessageError(code: "AUTOMATION_DENIED",
                           message: "macOS blocked Open Assist from using Messages. Allow it under Privacy & Security › Automation › Open Assist › Messages.")
    case -600, -609, -1728:
        throw MessageError(code: "HANDLE_UNKNOWN",
                           message: "Messages could not reach that number. Open Messages, sign in to iMessage and send it one message from this Mac first.")
    default:
        throw MessageError(code: "SEND_FAILED", message: "Messages did not send the update. Try again.")
    }
}

// MARK: - Request handling

/// Sends read the handle on the main queue while configure writes it on
/// dbQueue, so it sits behind a lock.
let handleLock = NSLock()
var storedHandle = ""
var configuredHandle: String {
    get { handleLock.lock(); defer { handleLock.unlock() }; return storedHandle }
    set { handleLock.lock(); storedHandle = newValue; handleLock.unlock() }
}
let dbQueue = DispatchQueue(label: "ai.coarena.messages.db")
let database = MessagesDatabase(path: messagesDatabasePath)
let databaseWatch = DatabaseWatch()

/// On dbQueue. `configure` reports the baseline it just took; `status` reads
/// the newest row for information only.
func statusResult(baseline: Bool = false) -> [String: Any] {
    var latest: Int64 = 0
    if baseline {
        latest = database.baseline ?? 0
    } else if !configuredHandle.isEmpty {
        latest = (try? database.latestRowId()) ?? 0
    }
    return [
        "automation": automationState(),
        // "ok" only after a good read: the app takes its baseline from this.
        "database": database.state.rawValue,
        "configured": !configuredHandle.isEmpty,
        "latestRowId": latest,
    ]
}

func handle(_ command: [String: Any]) {
    let id = command["id"] ?? ""
    func fail(_ error: Error) {
        let failure = error as? MessageError
        emit(["id": id, "error": failure?.message ?? "The Messages helper failed.", "code": failure?.code ?? "SEND_FAILED"])
    }
    switch command["method"] as? String {
    case "status":
        emit(["id": id, "result": statusResult()])
    case "configure":
        let requested = messageConfigureOptions(command)
        if requested.handle.isEmpty {
            configuredHandle = ""
            databaseWatch.set(false)
            database.reset()
            emit(["id": id, "result": statusResult()])
            return
        }
        guard messageHandleUsable(requested.handle) else {
            emit(["id": id, "error": "That is not a phone number with its country code or an iMessage address.", "code": "BAD_HANDLE"])
            return
        }
        configuredHandle = requested.handle
        database.rebaseline()
        databaseWatch.set(requested.watch)
        emit(["id": id, "result": statusResult(baseline: true)])
    case "send":
        // One read: a configure on dbQueue may change the handle meanwhile.
        let recipient = configuredHandle
        guard !recipient.isEmpty else {
            emit(["id": id, "error": "No handle is configured.", "code": "NOT_CONFIGURED"])
            return
        }
        let text = String(((command["text"] as? String) ?? "").prefix(600))
        do {
            try sendMessage(handle: recipient, text: text)
            emit(["id": id, "result": ["sent": true]])
        } catch { fail(error) }
    case "poll":
        guard !configuredHandle.isEmpty else {
            emit(["id": id, "error": "No handle is configured.", "code": "NOT_CONFIGURED"])
            return
        }
        let since = (command["sinceRowId"] as? NSNumber)?.int64Value ?? 0
        do {
            let result = try database.poll(handle: configuredHandle, since: since, now: Date().timeIntervalSince1970)
            emit(["id": id, "result": result.object])
        } catch { fail(error) }
    default:
        emit(["id": id, "error": "Unknown messages method.", "code": "BAD_REQUEST"])
    }
}

@main enum MessagesMain {
    static func main() {
        // Never outlive the app: an orphaned helper must not keep reading
        // messages or texting anybody.
        let parent = getppid()
        let watch = DispatchSource.makeProcessSource(identifier: parent, eventMask: .exit, queue: .main)
        watch.setEventHandler { exit(0) }
        watch.resume()
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + 1, repeating: 1)
        timer.setEventHandler { if getppid() != parent { exit(0) } }
        timer.resume()
        DispatchQueue.global().async {
            while let line = readLine() {
                guard let bytes = line.data(using: .utf8),
                      let command = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any]
                else { continue }
                // AppleScript needs the main thread and its run loop, and a first
                // send can wait minutes on the Automation prompt, so sends queue
                // there and everything else on dbQueue. Each queue answers in
                // arrival order.
                if command["method"] as? String == "send" {
                    DispatchQueue.main.async { handle(command) }
                } else {
                    dbQueue.async { handle(command) }
                }
            }
            // The app closed the pipe or died. Requests already queued still
            // answer (database requests first, then the main queue, both first
            // in, first out), and a hard deadline covers a main thread stuck in
            // an AppleScript prompt.
            DispatchQueue.global().asyncAfter(deadline: .now() + 2) { _exit(0) }
            dbQueue.async { DispatchQueue.main.async { exit(0) } }
        }
        RunLoop.main.run()
    }
}
