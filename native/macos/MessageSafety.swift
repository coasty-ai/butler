import Foundation

// Pure, testable rules for the iMessage channel: which stored message may ever
// be read as a command, which handle is the owner's, what the strict command
// vocabulary is, how often commands may arrive, and how text is escaped before
// it reaches AppleScript. Messages.swift does the I/O; this file decides.
// The TypeScript mirror lives in electron/messages.ts; the two test suites use
// the same fixture strings, so keep them in step.

// MARK: - Handles

/// Canonical form of a handle: "user@example.com" for an address, digits only
/// for a number ("+1 (555) 123-4567" -> "15551234567"). "" when unusable.
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
    // Numbers arrive as "+15551234567", "(555) 123-4567" or "tel:+1-555…".
    var body = trimmed
    if body.hasPrefix("tel:") { body = String(body.dropFirst(4)) }
    if body.hasPrefix("00") { body = "+" + body.dropFirst(2) }
    let digits = body.filter { $0.isNumber }
    let allowed = Set("+()-. \u{00a0}0123456789")
    guard body.allSatisfy({ allowed.contains($0) }), digits.count >= 5, digits.count <= 16
    else { return "" }
    return digits
}

/// True when two handles are the same person. Numbers compare digit by digit;
/// a bare 10-digit North American number also matches its +1 form, because
/// Messages stores one and people type the other. Nothing else is fuzzy.
func messageHandlesMatch(_ a: String, _ b: String) -> Bool {
    let left = normalizeMessageHandle(a), right = normalizeMessageHandle(b)
    guard !left.isEmpty, !right.isEmpty else { return false }
    if left == right { return true }
    if left.contains("@") || right.contains("@") { return false }
    let (short, long) = left.count <= right.count ? (left, right) : (right, left)
    return short.count == 10 && long.count == 11 && long.hasPrefix("1") && long.hasSuffix(short)
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

// MARK: - Command vocabulary

enum MessageCommandKind: String {
    case status, stop, pause, resume, start
    /// "yes"/"no"/"approve": refused on purpose, approvals stay on the Mac.
    case approval
    case unknown, empty, tooLong
}

struct MessageCommand: Equatable {
    let kind: MessageCommandKind
    let task: String
    init(_ kind: MessageCommandKind, task: String = "") { self.kind = kind; self.task = task }
}

/// The longest task a text may start, matching the typed command limit.
let messageMaxTextLength = 2000
private let messageApprovalWords: Set<String> = ["yes", "y", "yeah", "yep", "no", "n", "nope", "ok", "okay", "approve", "approved", "allow", "deny", "decline", "confirm", "cancel it"]
private let messageTrimmed = CharacterSet(charactersIn: ".!?,;:… \t")

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

/// The strict vocabulary: status, stop, pause, continue (or resume) on their
/// own, and "do <task>". Everything else is unknown and only ever earns a
/// one-line reply; nothing here is free-form control.
func parseMessageCommand(_ raw: String) -> MessageCommand {
    let text = normalizeMessageText(raw)
    if text.isEmpty { return MessageCommand(.empty) }
    if text.count > messageMaxTextLength { return MessageCommand(.tooLong) }
    let bare = text.trimmingCharacters(in: messageTrimmed).lowercased()
    switch bare {
    case "status": return MessageCommand(.status)
    case "stop": return MessageCommand(.stop)
    case "pause": return MessageCommand(.pause)
    case "continue", "resume": return MessageCommand(.resume)
    default: break
    }
    if messageApprovalWords.contains(bare) { return MessageCommand(.approval) }
    // "do <task>" only; "do" alone is not a task.
    let head = text.prefix(while: { !$0.isWhitespace })
    if ["do", "do:"].contains(head.lowercased()) {
        let task = text.dropFirst(head.count)
            .trimmingCharacters(in: .whitespaces)
            .trimmingCharacters(in: CharacterSet(charactersIn: ":"))
            .trimmingCharacters(in: .whitespaces)
        if !task.isEmpty { return MessageCommand(.start, task: task) }
    }
    return MessageCommand(.unknown)
}

// MARK: - Which stored rows may be read at all

/// One candidate row from chat.db. `text` is the only content ever copied and
/// it is dropped as soon as a command has been parsed from it.
struct MessageRow: Equatable {
    var rowId: Int64
    var handle: String
    var text: String
    /// Apple epoch value from message.date (seconds or nanoseconds).
    var appleDate: Int64
    var fromMe: Bool
    /// Rows in chats whose style is not a one-to-one conversation.
    var groupChats: Int
    var attachments: Int
    var itemType: Int
    var associatedType: Int
    var balloon: String
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

/// Every rule that decides whether a stored row is a command from the owner:
/// never one of ours or another device's outbound copy, never a group chat,
/// never an attachment, tapback, app balloon or system event, only the exact
/// configured handle, only newer than the baseline row, only recent.
func messageRowAccepted(_ row: MessageRow, handle: String, sinceRowId: Int64, now: Double) -> Bool {
    guard row.rowId > sinceRowId, !row.fromMe, row.groupChats == 0, row.attachments == 0,
          row.itemType == 0, row.associatedType == 0, row.balloon.isEmpty,
          !normalizeMessageText(row.text).isEmpty,
          messageHandlesMatch(handle, row.handle)
    else { return false }
    let sent = appleDateSeconds(row.appleDate)
    // A database without a usable date is not trusted to be recent.
    guard sent > 0 else { return false }
    return sent >= now - messageMaxAgeSeconds && sent <= now + 60
}

// MARK: - Rate limits

struct MessageRateLimits: Equatable {
    var perWindow = 6
    var windowSeconds = 60.0
    /// Unknown commands answered before the channel stops answering at all.
    var unknownLimit = 3
    var unknownWindowSeconds = 300.0
    var cooldownSeconds = 600.0
}

enum MessageAdmission: Equatable {
    case accept
    /// Over the per-minute limit. `reply` is true for the single "too many"
    /// answer allowed per window.
    case throttled(reply: Bool)
}

/// Sliding-window admission for incoming commands plus an unknown-command
/// cooldown, so a confused or automated sender cannot start a text ping-pong.
struct MessageRateState: Equatable {
    var limits = MessageRateLimits()
    private var accepted: [Double] = []
    private var unknowns: [Double] = []
    private var throttleReplyAt: Double?
    private var cooldownUntil: Double = 0

    init(limits: MessageRateLimits = MessageRateLimits()) { self.limits = limits }

    mutating func admit(now: Double) -> MessageAdmission {
        accepted.removeAll { now - $0 >= limits.windowSeconds }
        if accepted.count >= limits.perWindow {
            let replied = throttleReplyAt.map { now - $0 < limits.windowSeconds } ?? false
            if !replied { throttleReplyAt = now }
            return .throttled(reply: !replied)
        }
        accepted.append(now)
        return .accept
    }

    /// Whether an unknown command earns its one-line reply. After
    /// `unknownLimit` of them the channel goes quiet for the cooldown.
    mutating func answerUnknown(now: Double) -> Bool {
        if now < cooldownUntil { return false }
        unknowns.removeAll { now - $0 >= limits.unknownWindowSeconds }
        unknowns.append(now)
        if unknowns.count >= limits.unknownLimit {
            cooldownUntil = now + limits.cooldownSeconds
            unknowns.removeAll()
        }
        return true
    }

    var quietUntil: Double { cooldownUntil }
}
