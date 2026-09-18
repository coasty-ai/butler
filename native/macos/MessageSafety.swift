import Foundation

// Pure, testable rules for the iMessage channel: which stored message may ever
// be read as a command, which handle is the owner's, how a body stored only as
// rich text is decoded, what a poll result looks like on the wire, how often
// the database watch may speak, and how text is escaped before it reaches
// AppleScript. MessagesDatabase.swift reads chat.db and Messages.swift does the
// rest of the I/O; this file decides.
// The command vocabulary and the rate limits live only in electron/messages.ts:
// the helper hands over text and never interprets it. Handle rules are
// mirrored there, and tests/fixtures/messages-poll.json is the wire contract
// both test suites read.

// MARK: - Handles

/// Canonical form of a handle: "user@example.com" for an address, the E.164
/// digits for a number ("+1 (555) 123-4567" -> "15551234567"). "" when
/// unusable, which includes a number without its country code.
func normalizeMessageHandle(_ raw: String) -> String {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !trimmed.isEmpty, trimmed.count <= 100 else { return "" }
    if trimmed.contains("@") {
        let parts = trimmed.split(separator: "@", omittingEmptySubsequences: false)
        guard parts.count == 2, !parts[0].isEmpty, parts[1].contains("."),
              !parts[1].hasPrefix("."), !parts[1].hasSuffix("."),
              !trimmed.contains(where: { $0.isWhitespace || $0 == "\"" || $0 == "\\" })
        else { return "" }
        return trimmed
    }
    // Numbers arrive as "+15551234567", "+1 (555) 123-4567" or "tel:+1-555…",
    // and must carry their country code. A national number is somebody else
    // in another country: "8123456789" saved in India is not the US number
    // +1 812 345 6789, and "15512345678" saved in China is not +1 551 234 5678,
    // yet both have the same digits. Messages stores senders in E.164.
    var body = trimmed
    if body.hasPrefix("tel:") { body = String(body.dropFirst(4)) }
    if body.hasPrefix("00") { body = "+" + body.dropFirst(2) }
    let digits = body.filter { $0.isNumber }
    let allowed = Set("()-. \u{00a0}0123456789")
    guard body.hasPrefix("+"), body.dropFirst().allSatisfy({ allowed.contains($0) }), digits.count >= 5, digits.count <= 16
    else { return "" }
    return digits
}

/// True when two handles are the same person: the same address, or the same
/// number with its country code. Nothing is fuzzy.
func messageHandlesMatch(_ a: String, _ b: String) -> Bool {
    let left = normalizeMessageHandle(a), right = normalizeMessageHandle(b)
    return !left.isEmpty && left == right
}

/// A configured handle must normalize; the raw value must also be safe to
/// place inside an AppleScript string literal without escaping surprises.
func messageHandleUsable(_ raw: String) -> Bool { !normalizeMessageHandle(raw).isEmpty }

// MARK: - AppleScript escaping

/// The inner text of an AppleScript string literal. Quotes and backslashes are
/// escaped, line breaks become \n, other control characters are dropped, so no
/// message body can close the literal or add statements.
func appleScriptLiteral(_ text: String) -> String {
    var out = ""
    out.reserveCapacity(text.count + 8)
    for scalar in text.unicodeScalars {
        switch scalar {
        case "\\": out += "\\\\"
        case "\"": out += "\\\""
        case "\n", "\r", "\u{2028}", "\u{2029}": out += "\\n"
        case "\t": out += " "
        default:
            if scalar.value < 0x20 || scalar.value == 0x7f { continue }
            out.unicodeScalars.append(scalar)
        }
    }
    return out
}

// MARK: - Message text

/// The longest text handed to the app, matching the typed command limit.
let messageMaxTextLength = 2000

/// Collapses whitespace, drops control characters and bounds the length.
func normalizeMessageText(_ raw: String) -> String {
    var out = ""
    out.reserveCapacity(min(raw.count, messageMaxTextLength + 1))
    var space = false
    for scalar in raw.unicodeScalars {
        let character = Character(scalar)
        if character.isWhitespace || character.isNewline || scalar.value < 0x20 || scalar.value == 0x7f {
            space = !out.isEmpty
            continue
        }
        if space { out.append(" "); space = false }
        out.unicodeScalars.append(scalar)
        if out.count > messageMaxTextLength { return out }
    }
    return out
}

/// attributedBody blobs larger than this are never read (the size bound is in
/// the query, see MessagesDatabase.swift), let alone decoded.
/// A command is at most 2000 characters; 64 KB leaves room for the archive
/// around it without letting a sender make the helper chew on megabytes.
let messageAttributedBodyLimit = 64 * 1024

private let typedStreamHeader: [UInt8] = [0x04, 0x0B] + Array("streamtyped".utf8)
/// The class name as the archive writes it: a length byte, then the name.
private let typedStreamStringClass: [UInt8] = [0x08] + Array("NSString".utf8)

/// The plain text inside a message.attributedBody blob, or nil.
///
/// Newer macOS versions often leave message.text empty and keep the body only
/// in this NSArchiver "typedstream". Nothing is unarchived: no class is ever
/// instantiated from these attacker-influenced bytes. The parser accepts one
/// narrow layout and refuses everything else: the typedstream header, the
/// NSString class record (name, version, superclass reference), the "+" type
/// tag, then a length (one byte below 0x80, or 0x81 + UInt16 LE, or 0x82 +
/// UInt32 LE) and exactly that many bytes of valid UTF-8. The output is never
/// longer than the input.
func attributedBodyText(_ blob: [UInt8]) -> String? {
    guard blob.count <= messageAttributedBodyLimit, blob.starts(with: typedStreamHeader),
          let marker = firstRange(of: typedStreamStringClass, in: blob, from: typedStreamHeader.count)
    else { return nil }
    // Skip the class version and the superclass reference; the "+" tag must follow.
    var index = marker + typedStreamStringClass.count + 2
    guard index <= blob.count - 4, blob[index] == 0x84, blob[index + 1] == 0x01, blob[index + 2] == 0x2B
    else { return nil }
    index += 3
    let length: Int
    switch blob[index] {
    case 0x81:
        guard index <= blob.count - 3 else { return nil }
        length = Int(blob[index + 1]) | Int(blob[index + 2]) << 8
        index += 3
    case 0x82:
        guard index <= blob.count - 5 else { return nil }
        length = Int(blob[index + 1]) | Int(blob[index + 2]) << 8 | Int(blob[index + 3]) << 16 | Int(blob[index + 4]) << 24
        index += 5
    case let small where small < 0x80:
        length = Int(small)
        index += 1
    default:
        return nil
    }
    // Subtracting keeps the bound check free of overflow for any length.
    guard length > 0, length <= blob.count - index else { return nil }
    return String(bytes: blob[index ..< index + length], encoding: .utf8)
}

private func firstRange(of needle: [UInt8], in haystack: [UInt8], from start: Int) -> Int? {
    guard !needle.isEmpty, haystack.count >= needle.count, start <= haystack.count - needle.count else { return nil }
    var index = start
    while index <= haystack.count - needle.count {
        if haystack[index] == needle[0], haystack[index ..< index + needle.count].elementsEqual(needle) { return index }
        index += 1
    }
    return nil
}

/// The body of an accepted row: the plain text column when it has anything,
/// otherwise whatever attributedBody decodes to. Always normalized.
func messageBodyText(text: String, attributedBody: [UInt8]?) -> String {
    let plain = normalizeMessageText(text)
    if !plain.isEmpty { return plain }
    guard let attributedBody, let decoded = attributedBodyText(attributedBody) else { return "" }
    return normalizeMessageText(decoded)
}

// MARK: - Which stored rows may be read at all

/// One candidate row from chat.db. `text` is only a placeholder for "has a
/// body" until every rule has accepted the row; the body is read after that.
struct MessageRow: Equatable {
    var rowId: Int64
    var handle: String
    var text: String
    /// Apple epoch value from message.date (seconds or nanoseconds).
    var appleDate: Int64
    var fromMe: Bool
    /// Rows in chats whose style is not a one-to-one conversation.
    var groupChats: Int
    /// Rows in one-to-one chats (style 45). A message needs one: without any
    /// chat link it cannot be shown to be private.
    var directChats = 0
    var attachments: Int
    var itemType: Int
    var associatedType: Int
    var balloon: String
    /// message.service ("iMessage", "SMS", "RCS", …); nil when the database
    /// has no such column. A NULL value in an existing column is "".
    var service: String? = nil
    /// handle.service for the sender's handle row; nil when absent.
    var handleService: String? = nil
    /// message.is_auto_reply: a Focus or driving auto-reply, not the owner.
    var autoReply = false
    /// message.is_system_message / is_service_message: generated rows.
    var systemMessage = false
    var serviceMessage = false
}

/// message.date is an Apple epoch (2001-01-01), in seconds on old databases
/// and nanoseconds on current ones. Returns Unix seconds.
func appleDateSeconds(_ value: Int64) -> Double {
    let epoch = 978307200.0
    if value <= 0 { return 0 }
    return (value > 100_000_000_000 ? Double(value) / 1_000_000_000 : Double(value)) + epoch
}

/// How old a message may be and still act. A command that arrives late (iCloud
/// sync catching up, the Mac waking) is stale, and stale automation is exactly
/// what nobody wants.
let messageMaxAgeSeconds = 300.0

/// Only iMessage authenticates the sender: Apple ties it to the account. An
/// SMS or RCS caller ID can be spoofed, so such a row never leaves the helper,
/// even from the owner's number. Every service value the database does record
/// (the message's and its handle's) must say iMessage; NULL counts as unknown
/// and is refused. Only a database with no service column at all passes
/// through unlabelled, as service "" in the poll row, and the app then limits
/// that row to a status reply.
func messageServiceAccepted(_ row: MessageRow) -> Bool {
    [row.service, row.handleService].allSatisfy { $0 == nil || $0 == "iMessage" }
}

/// Every rule that decides whether a stored row is a command from the owner:
/// never one of ours or another device's outbound copy, only in a one-to-one
/// chat and in no group chat (a row with no chat link at all fails closed:
/// it could be a group message whose link is not stored yet, or a deleted
/// one), never an attachment, tapback, app balloon, auto-reply or
/// system/service row, only over iMessage, only the exact configured handle,
/// only newer than the baseline row, only recent.
func messageRowAccepted(_ row: MessageRow, handle: String, sinceRowId: Int64, now: Double) -> Bool {
    guard row.rowId > sinceRowId, !row.fromMe, row.directChats > 0, row.groupChats == 0, row.attachments == 0,
          row.itemType == 0, row.associatedType == 0, row.balloon.isEmpty,
          !row.autoReply, !row.systemMessage, !row.serviceMessage,
          messageServiceAccepted(row),
          !normalizeMessageText(row.text).isEmpty,
          messageHandlesMatch(handle, row.handle)
    else { return false }
    let sent = appleDateSeconds(row.appleDate)
    // A database without a usable date is not trusted to be recent.
    guard sent > 0 else { return false }
    return sent >= now - messageMaxAgeSeconds && sent <= now + 60
}

/// How long a poll waits for the chat link of a row that is otherwise a
/// command. Messages may store a message before its chat link; a poll woken
/// by the database watch can land between the two, and passing the cursor
/// over the row would lose the command. A row still unlinked after this
/// (a deleted message) is refused, and later rows wait at most this long.
let messageChatWaitSeconds = 2.0

/// A row that every rule accepts except that it has no chat link yet.
func messageRowAwaitingChat(_ row: MessageRow, handle: String, sinceRowId: Int64, now: Double) -> Bool {
    guard row.directChats == 0, row.groupChats == 0 else { return false }
    var linked = row
    linked.directChats = 1
    return messageRowAccepted(linked, handle: handle, sinceRowId: sinceRowId, now: now)
}

// MARK: - Wire shapes (tests/fixtures/messages-poll.json)

/// One accepted message, ready for the poll result.
struct PolledMessage: Equatable {
    let rowId: Int64
    let handle: String
    let service: String?
    let text: String
    let at: Double
}

/// One poll: the row the app should read from next time, the accepted
/// messages, and how many rows a full page left for an immediate next poll.
struct MessagePoll: Equatable {
    let rowId: Int64
    let messages: [PolledMessage]
    let skipped: Int

    /// The poll result exactly as the helper sends it.
    var object: [String: Any] {
        ["rowId": rowId, "skipped": skipped,
         "messages": messages.map { pollRowObject(rowId: $0.rowId, handle: $0.handle, service: $0.service, text: $0.text, at: $0.at) }]
    }
}

/// One accepted message as the poll result carries it. The sender's handle is
/// what lets the app re-check the owner, so it is never optional; service is
/// "iMessage", or "" when the database cannot say.
func pollRowObject(rowId: Int64, handle: String, service: String?, text: String, at: Double) -> [String: Any] {
    ["rowId": rowId, "handle": handle, "service": service ?? "", "text": text, "at": at]
}

/// The one unsolicited line: no row id and no content, only "look again".
let messageChangedEvent: [String: Any] = ["event": "changed"]

/// What `configure` asks for. The watch only ever runs for a configured handle.
func messageConfigureOptions(_ command: [String: Any]) -> (handle: String, watch: Bool) {
    let handle = (command["handle"] as? String) ?? ""
    return (handle, !handle.isEmpty && (command["watch"] as? Bool) == true)
}

// MARK: - Database watch

/// The files whose change can mean a new message. chat.db-shm is the WAL's
/// shared-memory index that every reader uses, this helper included, so it is
/// not one of them.
func messageDatabaseFileChanged(_ path: String) -> Bool {
    let name = (path as NSString).lastPathComponent
    return name == "chat.db" || name == "chat.db-wal"
}

/// Seconds between two "changed" lines.
let messageChangeInterval = 0.25

/// At most one "changed" line per interval, and never a lost last change: a
/// change inside the interval schedules one trailing line instead of being
/// dropped, and further changes before it fires ride along with it.
struct MessageChangeThrottle: Equatable {
    enum Action: Equatable { case emit, schedule(after: Double), absorbed }
    var interval = messageChangeInterval
    private(set) var lastEmit = -Double.infinity
    private(set) var trailing = false

    mutating func signal(now: Double) -> Action {
        if trailing { return .absorbed }
        let wait = lastEmit + interval - now
        if wait <= 0 { lastEmit = now; return .emit }
        trailing = true
        return .schedule(after: wait)
    }

    /// The scheduled trailing line goes out now.
    mutating func fire(now: Double) {
        trailing = false
        lastEmit = now
    }
}
