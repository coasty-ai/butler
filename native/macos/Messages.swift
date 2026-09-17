import Foundation
import SQLite3
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
// MessageSafety.swift so they can be tested without a Mac session.

let outputLock = NSLock()
func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
    outputLock.lock()
    FileHandle.standardOutput.write(data + Data([10]))
    outputLock.unlock()
}

struct MessageError: Error {
    let code: String
    let message: String
}

// MARK: - Reading

/// Codes reported for the database side, mirrored in electron/messages.ts.
enum DatabaseState: String {
    case ok, noAccess = "no_access", locked, missing, unsupported, unopened
}

let messagesDatabasePath = NSHomeDirectory() + "/Library/Messages/chat.db"
/// At most this many new rows are examined per poll; older extras are skipped.
let messagePollLimit = 20

final class MessagesDatabase {
    private var handle: OpaquePointer?
    private var columns = Set<String>()
    private(set) var state = DatabaseState.unopened

    deinit { close() }

    func close() {
        if let handle { sqlite3_close(handle) }
        handle = nil
    }

    /// Opens the database read-only. Distinguishes "Messages was never used"
    /// from "macOS refused the read", which is almost always Full Disk Access.
    @discardableResult func open() throws -> OpaquePointer {
        if let handle { return handle }
        guard FileManager.default.fileExists(atPath: messagesDatabasePath) else {
            state = .missing
            throw MessageError(code: "DATABASE_MISSING",
                               message: "No Messages database on this Mac. Open Messages and sign in to iMessage first.")
        }
        var db: OpaquePointer?
        // mode=ro is belt and braces with SQLITE_OPEN_READONLY: nothing this
        // helper does may ever modify the user's message history.
        let url = "file:" + messagesDatabasePath.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)! + "?mode=ro"
        let status = sqlite3_open_v2(url, &db, SQLITE_OPEN_READONLY | SQLITE_OPEN_URI, nil)
        guard status == SQLITE_OK, let opened = db else {
            if let db { sqlite3_close(db) }
            state = .noAccess
            throw MessageError(code: "FULL_DISK_ACCESS", message: fullDiskAccessMessage)
        }
        sqlite3_busy_timeout(opened, 1000)
        handle = opened
        do {
            columns = try tableColumns("message")
            let required = ["ROWID", "text", "date", "is_from_me", "handle_id"]
            let joins = try tableColumns("chat_message_join"), chats = try tableColumns("chat")
            guard required.allSatisfy({ columns.contains($0) }), joins.contains("message_id"),
                  chats.contains("style"), !(try tableColumns("handle")).isEmpty
            else {
                state = .unsupported
                throw MessageError(code: "DATABASE_UNSUPPORTED",
                                   message: "This macOS version stores messages differently. Texting control is unavailable.")
            }
            state = .ok
            return opened
        } catch {
            close()
            throw error
        }
    }

    private func tableColumns(_ table: String) throws -> Set<String> {
        var found = Set<String>()
        // PRAGMA takes no bindings; the table names here are literals.
        try each("PRAGMA table_info(\(table))") { statement in
            if let name = sqlite3_column_text(statement, 1) { found.insert(String(cString: name)) }
        }
        // sqlite_master always exists: an empty result means no such table.
        return found
    }

    /// Runs a statement, calling `row` for each result row.
    private func each(_ sql: String, bind: (OpaquePointer) -> Void = { _ in }, row: (OpaquePointer) -> Void) throws {
        guard let db = handle else { throw MessageError(code: "DATABASE_UNAVAILABLE", message: "The Messages database is not open.") }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let prepared = statement else {
            let code = sqlite3_errcode(db)
            sqlite3_finalize(statement)
            throw failure(code)
        }
        defer { sqlite3_finalize(prepared) }
        bind(prepared)
        while true {
            let step = sqlite3_step(prepared)
            if step == SQLITE_ROW { row(prepared); continue }
            if step == SQLITE_DONE { return }
            throw failure(step)
        }
    }

    private func failure(_ code: Int32) -> MessageError {
        switch code {
        case SQLITE_PERM, SQLITE_AUTH, SQLITE_CANTOPEN:
            state = .noAccess
            return MessageError(code: "FULL_DISK_ACCESS", message: fullDiskAccessMessage)
        case SQLITE_READONLY, SQLITE_BUSY, SQLITE_LOCKED:
            // A read-only connection cannot create the write-ahead index, so a
            // closed Messages app can leave the newest messages unreadable.
            state = .locked
            return MessageError(code: "DATABASE_LOCKED",
                                message: "Messages is not running, so its database cannot be read. Open the Messages app and leave it running.")
        default:
            state = .unsupported
            return MessageError(code: "DATABASE_UNAVAILABLE", message: "The Messages database could not be read.")
        }
    }

    /// The newest stored row. Commands are only ever read after this baseline,
    /// so a backlog can never run when the feature is switched on.
    func latestRowId() throws -> Int64 {
        try open()
        var latest: Int64 = 0
        try each("SELECT COALESCE(MAX(ROWID), 0) FROM message") { latest = sqlite3_column_int64($0, 0) }
        return latest
    }

    private func optional(_ name: String) -> String {
        columns.contains(name) ? "COALESCE(m.\(name), 0)" : "0"
    }

    /// New rows from the configured handle. Two passes on purpose: the first
    /// reads metadata and the text *length* only, and only a row that every
    /// rule accepts has its body read at all.
    func poll(handle owner: String, since: Int64, now: Double) throws -> (rowId: Int64, messages: [(rowId: Int64, text: String, at: Double)], skipped: Int) {
        try open()
        let balloon = columns.contains("balloon_bundle_id") ? "COALESCE(m.balloon_bundle_id, '')" : "''"
        let sql = """
        SELECT m.ROWID, COALESCE(h.id, ''), COALESCE(LENGTH(TRIM(m.text)), 0), COALESCE(m.date, 0), \
        COALESCE(m.is_from_me, 0), \(optional("cache_has_attachments")), \(optional("item_type")), \
        \(optional("associated_message_type")), \(balloon), \
        (SELECT COUNT(*) FROM chat_message_join j JOIN chat c ON c.ROWID = j.chat_id \
         WHERE j.message_id = m.ROWID AND COALESCE(c.style, 0) <> 45) \
        FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id \
        WHERE m.ROWID > ? ORDER BY m.ROWID ASC LIMIT ?
        """
        var rows: [(Int64, Bool)] = []
        var highest = since
        try each(sql, bind: { statement in
            sqlite3_bind_int64(statement, 1, since)
            sqlite3_bind_int(statement, 2, Int32(messagePollLimit))
        }) { statement in
            let rowId = sqlite3_column_int64(statement, 0)
            highest = max(highest, rowId)
            let sender = sqlite3_column_text(statement, 1).map { String(cString: $0) } ?? ""
            let length = sqlite3_column_int64(statement, 2)
            let row = MessageRow(
                rowId: rowId,
                handle: sender,
                // The body is not read here: only whether there is one.
                text: length > 0 ? "?" : "",
                appleDate: sqlite3_column_int64(statement, 3),
                fromMe: sqlite3_column_int64(statement, 4) != 0,
                groupChats: Int(sqlite3_column_int64(statement, 9)),
                attachments: Int(sqlite3_column_int64(statement, 5)),
                itemType: Int(sqlite3_column_int64(statement, 6)),
                associatedType: Int(sqlite3_column_int64(statement, 7)),
                balloon: sqlite3_column_text(statement, 8).map { String(cString: $0) } ?? "")
            rows.append((rowId, messageRowAccepted(row, handle: owner, sinceRowId: since, now: now)))
        }
        var messages: [(rowId: Int64, text: String, at: Double)] = []
        for (rowId, accepted) in rows where accepted {
            var text = "", date: Int64 = 0
            try each("SELECT COALESCE(text, ''), COALESCE(date, 0) FROM message WHERE ROWID = ?", bind: { statement in
                sqlite3_bind_int64(statement, 1, rowId)
            }) { statement in
                if let value = sqlite3_column_text(statement, 0) { text = String(cString: value) }
                date = sqlite3_column_int64(statement, 1)
            }
            let command = normalizeMessageText(text)
            guard !command.isEmpty else { continue }
            messages.append((rowId: rowId, text: command, at: appleDateSeconds(date)))
        }
        // A full page means more may be waiting; the caller polls again.
        return (rowId: highest, messages: messages, skipped: rows.count == messagePollLimit ? rows.count : 0)
    }
}

let fullDiskAccessMessage = "Open Assist cannot read Messages. Give it Full Disk Access in System Settings › Privacy & Security, then reopen the app."

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

var configuredHandle = ""
let database = MessagesDatabase()

func statusResult() -> [String: Any] {
    var latest: Int64 = 0
    var databaseState = database.state
    if !configuredHandle.isEmpty {
        do { latest = try database.latestRowId(); databaseState = database.state } catch {
            databaseState = database.state
        }
    }
    return [
        "automation": automationState(),
        "database": databaseState.rawValue,
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
        let requested = (command["handle"] as? String) ?? ""
        if requested.isEmpty {
            configuredHandle = ""
            database.close()
            emit(["id": id, "result": statusResult()])
            return
        }
        guard messageHandleUsable(requested) else {
            emit(["id": id, "error": "That is not a phone number or iMessage address.", "code": "BAD_HANDLE"])
            return
        }
        configuredHandle = requested
        emit(["id": id, "result": statusResult()])
    case "send":
        guard !configuredHandle.isEmpty else {
            emit(["id": id, "error": "No handle is configured.", "code": "NOT_CONFIGURED"])
            return
        }
        let text = String(((command["text"] as? String) ?? "").prefix(600))
        do {
            try sendMessage(handle: configuredHandle, text: text)
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
            emit(["id": id, "result": [
                "rowId": result.rowId,
                "skipped": result.skipped,
                "messages": result.messages.map { ["rowId": $0.rowId, "text": $0.text, "at": $0.at] },
            ]])
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
                // AppleScript needs the main thread and its run loop; requests
                // are handled one at a time in arrival order.
                DispatchQueue.main.async { handle(command) }
            }
            // The app closed the pipe or died. Requests already queued still
            // answer (the main queue is first in, first out), and a hard
            // deadline covers a main thread stuck in an AppleScript prompt.
            DispatchQueue.global().asyncAfter(deadline: .now() + 2) { _exit(0) }
            DispatchQueue.main.async { exit(0) }
        }
        RunLoop.main.run()
    }
}
