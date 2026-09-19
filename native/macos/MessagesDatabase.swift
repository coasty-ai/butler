import Foundation
import SQLite3

// The read-only chat.db reader behind coarena-messages. It lives apart from
// Messages.swift (stdin/stdout, AppleScript, FSEvents) so the native tests can
// run its SQL, column mapping and poll result against a synthetic database: a
// poll that silently lost a field once dropped every text sent to the Mac.
// MessageSafety.swift decides which rows count; this file only reads them.

struct MessageError: Error {
    let code: String
    let message: String
}

/// Codes reported for the database side, mirrored in electron/messages.ts.
enum DatabaseState: String {
    case ok, noAccess = "no_access", locked, missing, unsupported, unopened
}

/// At most this many new rows are examined per poll; older extras are skipped.
let messagePollLimit = 20

let fullDiskAccessMessage = "Butler cannot read Messages. Give it Full Disk Access in System Settings › Privacy & Security, then reopen the app."

/// Used only from one queue (dbQueue in the helper).
final class MessagesDatabase {
    let path: String
    private var handle: OpaquePointer?
    private var columns = Set<String>()
    private var handleColumns = Set<String>()
    private(set) var state = DatabaseState.unopened
    /// The newest row when the handle was configured. Nothing at or below it
    /// is ever read, whatever row the app asks to read from, so a backlog can
    /// never run. nil until a read succeeds: configuring while Messages is
    /// closed or the grant is missing must not leave the baseline at row 0.
    private(set) var baseline: Int64?
    /// An otherwise acceptable row still waiting for its chat link, and when
    /// that was first seen.
    private var awaiting: (rowId: Int64, since: Double)?

    init(path: String) { self.path = path }
    deinit { close() }

    func close() {
        if let handle { sqlite3_close(handle) }
        handle = nil
    }

    /// The handle was cleared: forget the database and the baseline with it.
    func reset() {
        close()
        baseline = nil
        awaiting = nil
    }

    /// A (new) handle was configured: rows up to now are history, never
    /// commands. Leaves the baseline unset when the database cannot be read,
    /// so the first poll that can read it takes the baseline instead.
    func rebaseline() {
        baseline = try? latestRowId()
        awaiting = nil
    }

    /// Opens the database read-only. Distinguishes "Messages was never used"
    /// from "macOS refused the read", which is almost always Full Disk Access.
    @discardableResult func open() throws -> OpaquePointer {
        if let handle { return handle }
        guard FileManager.default.fileExists(atPath: path) else {
            state = .missing
            throw MessageError(code: "DATABASE_MISSING",
                               message: "No Messages database on this Mac. Open Messages and sign in to iMessage first.")
        }
        var db: OpaquePointer?
        // mode=ro is belt and braces with SQLITE_OPEN_READONLY: nothing this
        // helper does may ever modify the user's message history.
        let url = "file:" + path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)! + "?mode=ro"
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
            handleColumns = try tableColumns("handle")
            guard required.allSatisfy({ columns.contains($0) }), joins.contains("message_id"),
                  chats.contains("style"), !handleColumns.isEmpty
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

    /// The newest stored row.
    func latestRowId() throws -> Int64 {
        try open()
        var latest: Int64 = 0
        try each("SELECT COALESCE(MAX(ROWID), 0) FROM message") { latest = sqlite3_column_int64($0, 0) }
        return latest
    }

    private func optional(_ name: String) -> String {
        columns.contains(name) ? "COALESCE(m.\(name), 0)" : "0"
    }

    /// A text column, or NULL when this database has none (read back as nil).
    private func optionalText(_ column: String, in table: Set<String>, as alias: String) -> String {
        table.contains(column) ? "COALESCE(\(alias).\(column), '')" : "NULL"
    }

    /// New rows from the configured handle, never from at or below the
    /// baseline. Two passes on purpose: the first reads metadata and the body
    /// *lengths* only, and only a row that every rule accepts has its body read
    /// at all.
    func poll(handle owner: String, since requested: Int64, now: Double) throws -> MessagePoll {
        try open()
        guard let floor = baseline else {
            // Configured while the database could not be read. This first
            // good read only takes the baseline: whatever is stored already
            // arrived before the channel could listen, and is not consent.
            let latest = try latestRowId()
            baseline = latest
            return MessagePoll(rowId: latest, messages: [], skipped: 0)
        }
        let since = max(requested, floor)
        let balloon = columns.contains("balloon_bundle_id") ? "COALESCE(m.balloon_bundle_id, '')" : "''"
        let rich = columns.contains("attributedBody")
        let sql = """
        SELECT m.ROWID, COALESCE(h.id, ''), COALESCE(LENGTH(TRIM(m.text)), 0), COALESCE(m.date, 0), \
        COALESCE(m.is_from_me, 0), \(optional("cache_has_attachments")), \(optional("item_type")), \
        \(optional("associated_message_type")), \(balloon), \
        (SELECT COUNT(*) FROM chat_message_join j JOIN chat c ON c.ROWID = j.chat_id \
         WHERE j.message_id = m.ROWID AND COALESCE(c.style, 0) <> 45), \
        (SELECT COUNT(*) FROM chat_message_join j JOIN chat c ON c.ROWID = j.chat_id \
         WHERE j.message_id = m.ROWID AND c.style = 45), \
        \(optionalText("service", in: columns, as: "m")), \(optionalText("service", in: handleColumns, as: "h")), \
        \(optional("is_auto_reply")), \(optional("is_system_message")), \(optional("is_service_message")), \
        \(rich ? "COALESCE(LENGTH(m.attributedBody), 0)" : "0") \
        FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id \
        WHERE m.ROWID > ? ORDER BY m.ROWID ASC LIMIT ?
        """
        var rows: [(row: MessageRow, accepted: Bool, richLength: Int64)] = []
        var highest = since, examined = 0, held = false
        try each(sql, bind: { statement in
            sqlite3_bind_int64(statement, 1, since)
            sqlite3_bind_int(statement, 2, Int32(messagePollLimit))
        }) { statement in
            examined += 1
            // Rows come in order; once one waits, everything after it waits too.
            if held { return }
            let length = sqlite3_column_int64(statement, 2)
            let richLength = sqlite3_column_int64(statement, 16)
            let row = MessageRow(
                rowId: sqlite3_column_int64(statement, 0),
                handle: sqlite3_column_text(statement, 1).map { String(cString: $0) } ?? "",
                // The body is not read here: only whether there is one. An
                // oversized attributedBody counts as none, so it is never read.
                text: length > 0 || (richLength > 0 && richLength <= messageAttributedBodyLimit) ? "?" : "",
                appleDate: sqlite3_column_int64(statement, 3),
                fromMe: sqlite3_column_int64(statement, 4) != 0,
                groupChats: Int(sqlite3_column_int64(statement, 9)),
                directChats: Int(sqlite3_column_int64(statement, 10)),
                attachments: Int(sqlite3_column_int64(statement, 5)),
                itemType: Int(sqlite3_column_int64(statement, 6)),
                associatedType: Int(sqlite3_column_int64(statement, 7)),
                balloon: sqlite3_column_text(statement, 8).map { String(cString: $0) } ?? "",
                service: sqlite3_column_text(statement, 11).map { String(cString: $0) },
                handleService: sqlite3_column_text(statement, 12).map { String(cString: $0) },
                autoReply: sqlite3_column_int64(statement, 13) != 0,
                systemMessage: sqlite3_column_int64(statement, 14) != 0,
                serviceMessage: sqlite3_column_int64(statement, 15) != 0)
            // A command whose chat link is not stored yet may be read in the
            // middle of Messages writing it. Wait for it briefly instead of
            // passing the cursor over it; a row that never gets a link (a
            // deleted message) is refused once the wait is over.
            if messageRowAwaitingChat(row, handle: owner, sinceRowId: since, now: now) {
                let first = awaiting?.rowId == row.rowId ? awaiting!.since : now
                awaiting = (row.rowId, first)
                if now - first < messageChatWaitSeconds { held = true; return }
            }
            highest = row.rowId
            rows.append((row, messageRowAccepted(row, handle: owner, sinceRowId: since, now: now), richLength))
        }
        var messages: [PolledMessage] = []
        for (row, accepted, richLength) in rows where accepted {
            var text = "", date: Int64 = 0
            try each("SELECT COALESCE(text, ''), COALESCE(date, 0) FROM message WHERE ROWID = ?", bind: { statement in
                sqlite3_bind_int64(statement, 1, row.rowId)
            }) { statement in
                if let value = sqlite3_column_text(statement, 0) { text = String(cString: value) }
                date = sqlite3_column_int64(statement, 1)
            }
            var attributed: [UInt8]?
            // The blob is read only when the text column has nothing, and the
            // size bound sits in the query itself, so SQLite never loads an
            // oversized blob either. The decoder is pure and bounded.
            if rich, normalizeMessageText(text).isEmpty, richLength > 0, richLength <= messageAttributedBodyLimit {
                try each("SELECT attributedBody FROM message WHERE ROWID = ? AND LENGTH(attributedBody) BETWEEN 1 AND ?", bind: { statement in
                    sqlite3_bind_int64(statement, 1, row.rowId)
                    sqlite3_bind_int(statement, 2, Int32(messageAttributedBodyLimit))
                }) { statement in
                    let size = Int(sqlite3_column_bytes(statement, 0))
                    if size > 0, size <= messageAttributedBodyLimit, let bytes = sqlite3_column_blob(statement, 0) {
                        attributed = Array(UnsafeRawBufferPointer(start: bytes, count: size))
                    }
                }
            }
            let command = messageBodyText(text: text, attributedBody: attributed)
            guard !command.isEmpty else { continue }
            messages.append(PolledMessage(rowId: row.rowId, handle: row.handle, service: row.service, text: command, at: appleDateSeconds(date)))
        }
        // A full page means more may be waiting and the app polls again at
        // once. A page that stopped at a waiting row is not full: polling
        // again right away would only find the same row still waiting.
        return MessagePoll(rowId: highest, messages: messages, skipped: !held && examined == messagePollLimit ? examined : 0)
    }
}
