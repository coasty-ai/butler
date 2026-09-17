import Foundation

// Pure checks for MessageSafety.swift: who may command the Mac by text, what
// the vocabulary is, which stored rows are readable at all, and the limits.
// The fixture strings are shared with tests/messages.test.ts.
func messageSafetyChecks(_ check: (Bool, String) -> Void) {
    let owner = "+1 (555) 123-4567"

    // Handles
    check(normalizeMessageHandle(owner) == "15551234567", "a formatted number normalizes to digits")
    check(normalizeMessageHandle("tel:+1-555-123-4567") == "15551234567", "a tel: handle normalizes")
    check(normalizeMessageHandle("  Owner@Example.COM ") == "owner@example.com", "an address normalizes to lower case")
    check(normalizeMessageHandle("") == "", "an empty handle is unusable")
    check(normalizeMessageHandle("Mom") == "", "a contact name is not a handle")
    check(normalizeMessageHandle("owner@example") == "", "an address without a dotted domain is unusable")
    check(normalizeMessageHandle("+1 555") == "", "a too-short number is unusable")
    check(normalizeMessageHandle("+1555123456789012345") == "", "a too-long number is unusable")
    check(normalizeMessageHandle("+1555\"123") == "", "a quoted number is unusable")
    check(messageHandlesMatch(owner, "+15551234567"), "the same number in two formats matches")
    check(messageHandlesMatch("5551234567", "+15551234567"), "a bare ten-digit number matches its +1 form")
    check(!messageHandlesMatch("+445551234567", "+15551234567"), "another country code does not match")
    check(!messageHandlesMatch("+15551234567", "+15559998888"), "a different number does not match")
    check(!messageHandlesMatch("owner@example.com", "+15551234567"), "an address never matches a number")
    check(messageHandlesMatch("Owner@example.com", "owner@EXAMPLE.com"), "addresses match case-insensitively")
    check(!messageHandlesMatch("", "+15551234567"), "an unconfigured handle matches nothing")
    check(!messageHandlesMatch("+15551234567", ""), "an empty sender matches nothing")

    // AppleScript escaping
    check(appleScriptLiteral("Done: \"3\" of 4") == "Done: \\\"3\\\" of 4", "quotes are escaped")
    check(appleScriptLiteral("a\\b") == "a\\\\b", "backslashes are escaped")
    check(appleScriptLiteral("one\ntwo") == "one\\ntwo", "line breaks become an escape, never a new statement")
    check(appleScriptLiteral("bad\u{0007}char") == "badchar", "control characters are dropped")
    // Every quote left in the literal is escaped, so nothing can close it.
    func literalIsClosed(_ value: String) -> Bool {
        var iterator = value.makeIterator()
        while let character = iterator.next() {
            if character == "\\" { _ = iterator.next(); continue }
            if character == "\"" { return false }
        }
        return true
    }
    check(literalIsClosed(appleScriptLiteral("\" & (do shell script \"id\") & \"")), "an injected literal cannot close the string")

    // Vocabulary
    check(parseMessageCommand("status") == MessageCommand(.status), "status is a command")
    check(parseMessageCommand("  STATUS.  ") == MessageCommand(.status), "commands ignore case, spacing and trailing punctuation")
    check(parseMessageCommand("stop") == MessageCommand(.stop), "stop is a command")
    check(parseMessageCommand("pause") == MessageCommand(.pause), "pause is a command")
    check(parseMessageCommand("continue") == MessageCommand(.resume), "continue is a command")
    check(parseMessageCommand("resume") == MessageCommand(.resume), "resume is the same command")
    check(parseMessageCommand("do open my notes") == MessageCommand(.start, task: "open my notes"), "do starts a task")
    check(parseMessageCommand("Do: open my notes") == MessageCommand(.start, task: "open my notes"), "do: starts a task")
    check(parseMessageCommand("do\n open  my   notes") == MessageCommand(.start, task: "open my notes"), "task whitespace collapses")
    check(parseMessageCommand("do") == MessageCommand(.unknown), "do without a task is not a task")
    check(parseMessageCommand("stop the download") == MessageCommand(.unknown), "a sentence is never a control command")
    check(parseMessageCommand("please stop") == MessageCommand(.unknown), "only the bare word controls the run")
    check(parseMessageCommand("open my notes") == MessageCommand(.unknown), "a bare sentence never starts a task")
    check(parseMessageCommand("") == MessageCommand(.empty), "empty text is not a command")
    check(parseMessageCommand("   ") == MessageCommand(.empty), "blank text is not a command")
    check(parseMessageCommand("do " + String(repeating: "a", count: 2100)).kind == .tooLong, "an oversized message is refused")
    for word in ["yes", "no", "ok", "approve", "deny", "confirm", "Yes!"] {
        check(parseMessageCommand(word).kind == .approval, "\(word) is an approval word, never acted on")
    }
    check(parseMessageCommand("do approve the invoice").kind == .start, "an approval word inside a task is still a task")

    // Which rows may be read
    let now = Date().timeIntervalSince1970
    let recent = Int64((now - 10 - 978307200) * 1_000_000_000)
    func row(_ patch: (inout MessageRow) -> Void = { _ in }) -> MessageRow {
        var r = MessageRow(rowId: 10, handle: "+15551234567", text: "status", appleDate: recent, fromMe: false,
                           groupChats: 0, attachments: 0, itemType: 0, associatedType: 0, balloon: "")
        patch(&r); return r
    }
    func accepted(_ r: MessageRow, since: Int64 = 5) -> Bool { messageRowAccepted(r, handle: owner, sinceRowId: since, now: now) }
    check(accepted(row()), "a fresh one-to-one text from the owner is readable")
    check(!accepted(row(), since: 10), "a row at the baseline is already seen")
    check(!accepted(row { $0.fromMe = true }), "our own and other devices' outbound copies are never commands")
    check(!accepted(row { $0.handle = "+15559998888" }), "another sender is ignored")
    check(!accepted(row { $0.groupChats = 1 }), "group chats are ignored")
    check(!accepted(row { $0.attachments = 1 }), "attachments are ignored")
    check(!accepted(row { $0.itemType = 1 }), "system events are ignored")
    check(!accepted(row { $0.associatedType = 2000 }), "tapbacks and edits are ignored")
    check(!accepted(row { $0.balloon = "com.apple.messages.URLBalloonProvider" }), "app balloons are ignored")
    check(!accepted(row { $0.text = "  " }), "an empty body is ignored")
    check(!accepted(row { $0.appleDate = 0 }), "a row without a usable date is ignored")
    check(!accepted(row { $0.appleDate = Int64((now - 900 - 978307200) * 1_000_000_000) }), "a stale command never runs")
    check(!accepted(row { $0.appleDate = Int64((now + 600 - 978307200) * 1_000_000_000) }), "a future-dated row never runs")
    check(accepted(row { $0.appleDate = Int64(now - 10 - 978307200) }), "seconds-based dates on older databases still work")
    check(abs(appleDateSeconds(Int64(1_000_000_000)) - (1_000_000_000 + 978307200)) < 1, "seconds convert from the Apple epoch")
    check(abs(appleDateSeconds(700_000_000_000_000_000) - (700_000_000 + 978307200)) < 1, "nanoseconds convert from the Apple epoch")

    // Rate limits
    var rate = MessageRateState()
    var clock = 1000.0
    for _ in 0..<6 { check(rate.admit(now: clock) == .accept, "the first six commands in a minute are accepted") }
    check(rate.admit(now: clock) == .throttled(reply: true), "the seventh is throttled and answered once")
    check(rate.admit(now: clock) == .throttled(reply: false), "further throttled commands are silent")
    clock += 61
    check(rate.admit(now: clock) == .accept, "the window slides")
    var unknown = MessageRateState()
    check(unknown.answerUnknown(now: 0), "the first unknown command is answered")
    check(unknown.answerUnknown(now: 10), "the second unknown command is answered")
    check(unknown.answerUnknown(now: 20), "the third unknown command is answered and starts the cooldown")
    check(!unknown.answerUnknown(now: 30), "a fourth unknown command is ignored in silence")
    check(!unknown.answerUnknown(now: 500), "the cooldown holds")
    check(unknown.answerUnknown(now: 20 + 601), "answers resume after the cooldown")
    var spaced = MessageRateState()
    check(spaced.answerUnknown(now: 0) && spaced.answerUnknown(now: 400) && spaced.answerUnknown(now: 800),
          "unknown commands spread over time never trip the cooldown")
}

// Its own entry point: the messaging rules build into a separate test binary
// so the existing frame/voice suite keeps its single @main.
@main struct MessageSafetyTests {
    static func main() {
        func check(_ condition: Bool, _ name: String) {
            if !condition { fatalError(name) }
            print("PASS: " + name)
        }
        messageSafetyChecks(check)
    }
}
