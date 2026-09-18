import Foundation
import SQLite3

// Pure checks for MessageSafety.swift: who may command the Mac by text, which
// stored rows are readable at all, how a rich-text body is decoded, the wire
// shapes in tests/fixtures/messages-poll.json, and the database watch pacing.
// Then MessagesDatabase.swift against a synthetic chat.db: the SQL, the column
// mapping and the poll result the helper sends. Handle fixture strings are
// shared with tests/messages.test.ts.

/// A synthesized typedstream blob, shaped like a real attributedBody; never a
/// real message.
func typedstream(_ text: String, form: UInt8? = nil) -> [UInt8] {
    let body = Array(text.utf8), count = body.count
    var out: [UInt8] = [0x04, 0x0B] + Array("streamtyped".utf8) + [0x81, 0xE8, 0x03, 0x84, 0x01, 0x40, 0x84, 0x84, 0x84, 0x12]
    out += Array("NSAttributedString".utf8) + [0x00, 0x84, 0x84, 0x08] + Array("NSObject".utf8) + [0x00, 0x85, 0x92, 0x84, 0x84, 0x84, 0x08]
    out += Array("NSString".utf8) + [0x01, 0x94, 0x84, 0x01, 0x2B]
    switch form ?? (count < 0x80 ? 0 : count <= 0xFFFF ? 0x81 : 0x82) {
    case 0x81: out += [0x81, UInt8(count & 0xFF), UInt8(count >> 8 & 0xFF)]
    case 0x82: out += [0x82, UInt8(count & 0xFF), UInt8(count >> 8 & 0xFF), UInt8(count >> 16 & 0xFF), UInt8(count >> 24 & 0xFF)]
    default: out.append(UInt8(count))
    }
    out += body
    return out + [0x86, 0x84, 0x02, 0x69, 0x49, 0x01, 0x06, 0x92, 0x84, 0x84, 0x84, 0x0C] + Array("NSDictionary".utf8) + [0x00, 0x86, 0x86]
}

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
    check(normalizeMessageHandle("0015551234567") == "15551234567", "a 00 international prefix reads as +")
    check(messageHandlesMatch(owner, "+15551234567"), "the same number in two formats matches")
    // A number without its country code is somebody else somewhere: an Indian
    // mobile saved as "8123456789" must never admit the US +1 812 345 6789.
    check(normalizeMessageHandle("5551234567") == "", "a number without its country code is unusable")
    check(normalizeMessageHandle("tel:5551234567") == "", "a tel: number without its country code is unusable")
    check(!messageHandlesMatch("5551234567", "+15551234567"), "a bare ten-digit number never matches a +1 sender")
    check(!messageHandlesMatch("8123456789", "+18123456789"), "a national number from another country never matches the +1 number with its digits")
    check(!messageHandlesMatch("15512345678", "+15512345678"), "a bare eleven-digit number never matches the +1 number with its digits")
    check(messageHandlesMatch("+91 81234 56789", "+918123456789"), "a number with its country code matches its sender")
    check(!messageHandlesMatch("+555 123 4567", "+15551234567"), "a ten-digit international number is not the +1 number ending in it")
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

    // Text normalization (the vocabulary itself lives in electron/messages.ts)
    check(normalizeMessageText("do\n open  my   notes") == "do open my notes", "whitespace collapses")
    check(normalizeMessageText("  \u{0007} ") == "", "blank text normalizes to nothing")
    check(normalizeMessageText(String(repeating: "a", count: 2100)).count == messageMaxTextLength + 1, "oversized text is bounded just past the limit")

    // Which rows may be read
    let now = Date().timeIntervalSince1970
    let recent = Int64((now - 10 - 978307200) * 1_000_000_000)
    func row(_ patch: (inout MessageRow) -> Void = { _ in }) -> MessageRow {
        var r = MessageRow(rowId: 10, handle: "+15551234567", text: "status", appleDate: recent, fromMe: false,
                           groupChats: 0, directChats: 1, attachments: 0, itemType: 0, associatedType: 0, balloon: "",
                           service: "iMessage", handleService: "iMessage")
        patch(&r); return r
    }
    func accepted(_ r: MessageRow, since: Int64 = 5) -> Bool { messageRowAccepted(r, handle: owner, sinceRowId: since, now: now) }
    check(accepted(row()), "a fresh one-to-one iMessage from the owner is readable")
    check(!accepted(row(), since: 10), "a row at the baseline is already seen")
    check(!accepted(row { $0.fromMe = true }), "our own and other devices' outbound copies are never commands")
    check(!accepted(row { $0.handle = "+15559998888" }), "another sender is ignored")
    check(!accepted(row { $0.groupChats = 1 }), "group chats are ignored")
    check(!accepted(row { $0.groupChats = 1; $0.directChats = 1 }), "a row linked to a group chat is ignored even if also linked one-to-one")
    // Fail closed: a row with no chat link might be a group message whose link
    // is not stored yet, or a deleted message.
    check(!accepted(row { $0.directChats = 0 }), "a row with no chat link is never a command")
    func awaiting(_ r: MessageRow) -> Bool { messageRowAwaitingChat(r, handle: owner, sinceRowId: 5, now: now) }
    check(awaiting(row { $0.directChats = 0 }), "an owner command without its chat link yet is worth a brief wait")
    check(!awaiting(row()), "a linked row does not wait")
    check(!awaiting(row { $0.directChats = 0; $0.groupChats = 1 }), "a group row does not wait")
    check(!awaiting(row { $0.directChats = 0; $0.handle = "+15559998888" }), "another sender's unlinked row does not wait")
    check(!awaiting(row { $0.directChats = 0; $0.service = "SMS" }), "an unlinked SMS does not wait")
    check(!awaiting(row { $0.directChats = 0; $0.appleDate = Int64((now - 900 - 978307200) * 1_000_000_000) }), "a stale unlinked row does not wait")
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

    // Service: only iMessage authenticates the sender
    check(!accepted(row { $0.service = "SMS" }), "an SMS from the owner's number is never a command (caller ID can be spoofed)")
    check(!accepted(row { $0.service = "RCS" }), "an RCS message is never a command")
    check(!accepted(row { $0.service = "" }), "a NULL service in an existing column is unknown and refused")
    check(!accepted(row { $0.service = "imessage" }), "the service must be exactly iMessage")
    check(!accepted(row { $0.handleService = "SMS" }), "an SMS handle row vetoes the message")
    check(accepted(row { $0.handleService = nil }), "a database without handle.service still reads iMessage rows")
    check(accepted(row { $0.service = nil; $0.handleService = nil }), "a database with no service column passes through, unlabelled")
    check(!accepted(row { $0.service = nil; $0.handleService = "SMS" }), "without message.service, an SMS handle still vetoes")
    check(!accepted(row { $0.autoReply = true }), "a Focus or driving auto-reply is not the owner speaking")
    check(!accepted(row { $0.systemMessage = true }), "system messages are ignored")
    check(!accepted(row { $0.serviceMessage = true }), "service messages are ignored")

    // attributedBody: synthesized typedstream blobs, never real messages
    check(attributedBodyText(typedstream("status")) == "status", "a short attributedBody decodes")
    check(attributedBodyText(typedstream("do open my notes 👋")) == "do open my notes 👋", "multi-byte UTF-8 decodes")
    check(attributedBodyText(typedstream("pause", form: 0x81)) == "pause", "a two-byte length (0x81) decodes")
    check(attributedBodyText(typedstream("resume", form: 0x82)) == "resume", "a four-byte length (0x82) decodes")
    let long = String(repeating: "a", count: 300)
    check(attributedBodyText(typedstream(long)) == long, "a body over 127 bytes uses the 0x81 form and decodes")
    let valid = typedstream("status")
    check(attributedBodyText(Array(valid.dropFirst(2))) == nil, "no typedstream header is refused")
    check(attributedBodyText(valid.map { $0 == UInt8(ascii: "N") ? UInt8(ascii: "M") : $0 }) == nil, "no NSString class record is refused")
    let headerSize = 2 + "streamtyped".utf8.count
    let marker = (0 ..< valid.count - 9).first { Array(valid[$0 ..< $0 + 9]) == [0x08] + Array("NSString".utf8) }!
    let lengthAt = marker + 9 + 2 + 3
    check(marker > headerSize, "the test blob has its class record after the header")
    check(attributedBodyText(Array(valid.prefix(lengthAt + 3))) == nil, "a truncated body is refused")
    check(attributedBodyText(Array(valid.prefix(lengthAt))) == nil, "a blob cut before the length is refused")
    var overLong = valid; overLong[lengthAt] = 0x7F
    check(attributedBodyText(overLong) == nil, "a length past the end of the blob is refused")
    var zero = valid; zero[lengthAt] = 0
    check(attributedBodyText(zero) == nil, "a zero length is refused")
    var badTag = valid; badTag[lengthAt - 1] = UInt8(ascii: "@")
    check(attributedBodyText(badTag) == nil, "an object tag where the string tag belongs is refused")
    var badLength = valid; badLength[lengthAt] = 0x83
    check(attributedBodyText(badLength) == nil, "an unknown length form is refused")
    var huge = typedstream("status", form: 0x82); huge[lengthAt + 1 ..< lengthAt + 5] = [0xFF, 0xFF, 0xFF, 0xFF]
    check(attributedBodyText(huge) == nil, "a 4 GB length claim is refused without overflow")
    var invalid = valid; invalid[lengthAt + 1] = 0xC3; invalid[lengthAt + 2] = 0x28
    check(attributedBodyText(invalid) == nil, "invalid UTF-8 is refused")
    let padded = typedstream(String(repeating: "b", count: messageAttributedBodyLimit - 50))
    check(padded.count > messageAttributedBodyLimit && attributedBodyText(padded) == nil, "a blob over 64 KB is refused")
    let fits = typedstream(String(repeating: "c", count: messageAttributedBodyLimit - 200))
    check(fits.count <= messageAttributedBodyLimit && attributedBodyText(fits)?.count == messageAttributedBodyLimit - 200, "a blob just under 64 KB decodes")
    check(messageBodyText(text: "stop", attributedBody: typedstream("status")) == "stop", "the plain text column wins when it has text")
    check(messageBodyText(text: " \n", attributedBody: typedstream("  pause\n")) == "pause", "an empty text column falls back to attributedBody, normalized")
    check(messageBodyText(text: "", attributedBody: nil) == "", "no text and no attributedBody is no body")
    check(messageBodyText(text: "", attributedBody: badTag) == "", "an undecodable attributedBody is no body")
    check(messageBodyText(text: "", attributedBody: fits).count == messageMaxTextLength + 1, "a decoded body is bounded like any text")

    // Fuzz: attacker-influenced bytes never crash the decoder (arrays are
    // bounds-checked, so a bad index traps) and never yield more than came in.
    var random = SplitMix64(seed: 0x5EED_1B)
    var decoded = 0
    func fuzz(_ blob: [UInt8]) {
        let result = attributedBodyText(blob)
        if let result {
            decoded += 1
            if result.utf8.count > blob.count || result.utf8.count > messageAttributedBodyLimit {
                check(false, "fuzz output is bounded by its input (\(blob.count) bytes)")
            }
        }
        if messageBodyText(text: "", attributedBody: blob).count > messageMaxTextLength + 1 {
            check(false, "fuzz body text is bounded")
        }
    }
    let seeds = ["status", "stop", "do open my notes", String(repeating: "x", count: 200), "é👋"].map { typedstream($0) }
    for round in 0 ..< 20000 {
        switch round % 4 {
        case 0: // Pure noise, sometimes behind a real header and class record.
            var blob = (0 ..< random.below(160)).map { _ in UInt8(truncatingIfNeeded: random.next()) }
            if random.below(2) == 0 { blob = Array(valid.prefix(lengthAt)) + blob }
            fuzz(blob)
        case 1: // A valid blob with a few bytes flipped.
            var blob = seeds[random.below(seeds.count)]
            for _ in 0 ..< 1 + random.below(4) { blob[random.below(blob.count)] = UInt8(truncatingIfNeeded: random.next()) }
            fuzz(blob)
        case 2: // A valid blob cut anywhere.
            let blob = seeds[random.below(seeds.count)]
            fuzz(Array(blob.prefix(random.below(blob.count + 1))))
        default: // A valid prefix with a hostile length field and short tail.
            var blob = Array(valid.prefix(lengthAt))
            blob += [[0x81, 0x82, 0x7F, 0x80, 0xFF][random.below(5)]]
            blob += (0 ..< random.below(12)).map { _ in UInt8(truncatingIfNeeded: random.next()) }
            fuzz(blob)
        }
    }
    check(decoded > 0, "the fuzz reached the decoding path (\(decoded) decoded)")
    check(true, "20000 fuzzed attributedBody blobs: no crash, bounded output")

    // Wire contract: tests/fixtures/messages-poll.json is what the app's tests replay.
    let fixturePath = FileManager.default.currentDirectoryPath + "/tests/fixtures/messages-poll.json"
    guard let bytes = FileManager.default.contents(atPath: fixturePath),
          let fixture = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
          let poll = fixture["poll"] as? [String: Any],
          let fixtureRow = (poll["messages"] as? [[String: Any]])?.first,
          let configure = fixture["configure"] as? [String: Any],
          let changed = fixture["changed"] as? [String: Any]
    else { check(false, "messages poll fixture is readable from the repository root"); return }
    let wire = pollRowObject(rowId: 101, handle: "+15551234567", service: "iMessage", text: "status", at: 1_700_000_000)
    check(Set(wire.keys) == Set(fixtureRow.keys), "a poll row has exactly the fixture's keys: rowId, handle, service, text, at")
    check(Set(wire.keys) == ["rowId", "handle", "service", "text", "at"], "a poll row always carries the sender's handle and service")
    let roundTrip = (try? JSONSerialization.data(withJSONObject: ["messages": [wire]]))
        .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        .flatMap { ($0["messages"] as? [[String: Any]])?.first }
    check(roundTrip.map { NSDictionary(dictionary: $0).isEqual(to: fixtureRow) } ?? false, "a serialized poll row equals the fixture row")
    check(pollRowObject(rowId: 1, handle: "a@b.co", service: nil, text: "status", at: 1)["service"] as? String == "", "an unlabelled row says service \"\"")
    let result = MessagePoll(rowId: 101, messages: [PolledMessage(rowId: 101, handle: "+15551234567", service: "iMessage", text: "status", at: 1_700_000_000)], skipped: 0)
    check(NSDictionary(dictionary: result.object).isEqual(to: poll), "a poll result serializes to exactly the fixture's poll")
    check(NSDictionary(dictionary: messageChangedEvent).isEqual(to: changed), "the changed event matches the fixture")
    check(messageChangedEvent.count == 1, "the changed event carries no row id or content")
    let options = messageConfigureOptions(configure)
    check(options.handle == "+15551234567" && options.watch, "configure reads the fixture's handle and watch flag")
    check(!messageConfigureOptions(["handle": "+15551234567"]).watch, "no watch flag means no watch")
    check(!messageConfigureOptions(["handle": "", "watch": true]).watch, "no handle means no watch")
    check(!messageConfigureOptions(["handle": "+15551234567", "watch": "true"]).watch, "only a JSON true turns the watch on")

    // Database watch
    check(messageDatabaseFileChanged("/Users/x/Library/Messages/chat.db"), "a write to chat.db is a change")
    check(messageDatabaseFileChanged("/Users/x/Library/Messages/chat.db-wal"), "a write to the WAL is a change")
    check(!messageDatabaseFileChanged("/Users/x/Library/Messages/chat.db-shm"), "the shared-memory index every reader uses is ignored")
    check(!messageDatabaseFileChanged("/Users/x/Library/Messages/Attachments/ab/chat.db.png"), "other files are ignored")
    func scheduled(_ action: MessageChangeThrottle.Action, _ expected: Double) -> Bool {
        if case .schedule(let after) = action { return abs(after - expected) < 1e-9 }
        return false
    }
    var throttle = MessageChangeThrottle()
    check(throttle.signal(now: 10) == .emit, "the first change is announced at once")
    check(scheduled(throttle.signal(now: 10.01), 0.24), "a change inside 250 ms schedules one trailing line")
    check(throttle.signal(now: 10.05) == .absorbed, "more changes ride along with the scheduled line")
    throttle.fire(now: 10.25)
    check(scheduled(throttle.signal(now: 10.3), 0.2), "the interval restarts from the trailing line")
    throttle.fire(now: 10.5)
    check(throttle.signal(now: 11) == .emit, "a quiet period announces the next change at once")
    // Randomized: never two lines within 250 ms, and every change is followed
    // by a line within 250 ms of it.
    var paced = MessageChangeThrottle(), clock = 0.0, due: Double?
    var lines: [Double] = [], signals: [Double] = []
    for _ in 0 ..< 5000 {
        clock += Double(random.below(600)) / 1000
        if let at = due, at <= clock { paced.fire(now: at); lines.append(at); due = nil }
        signals.append(clock)
        switch paced.signal(now: clock) {
        case .emit: lines.append(clock)
        case .schedule(let after):
            if due != nil { check(false, "only one trailing line is ever scheduled") }
            due = clock + after
        case .absorbed:
            if due == nil { check(false, "a change is only absorbed by a scheduled line") }
        }
    }
    if let at = due { paced.fire(now: at); lines.append(at) }
    check(zip(lines, lines.dropFirst()).allSatisfy { $1 - $0 >= messageChangeInterval - 1e-9 }, "changed lines are at least 250 ms apart")
    var next = 0
    let covered = signals.allSatisfy { signal in
        while next < lines.count, lines[next] < signal { next += 1 }
        return next < lines.count && lines[next] - signal <= messageChangeInterval + 1e-9
    }
    check(covered, "every change is announced within 250 ms")
}

/// A small, seeded generator so a fuzz failure reproduces.
struct SplitMix64 {
    var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
    mutating func below(_ bound: Int) -> Int { bound <= 0 ? 0 : Int(next() % UInt64(bound)) }
}

// MARK: - The reader against a synthetic chat.db

/// MessagesDatabase.swift end to end, minus stdin/stdout: a database built
/// with the tables and columns macOS uses, owner commands among every kind of
/// row that must never act, and the poll result compared field for field with
/// tests/fixtures/messages-poll.json, which the app's tests replay.
func messageDatabaseChecks(_ check: (Bool, String) -> Void) {
    let fixturePath = FileManager.default.currentDirectoryPath + "/tests/fixtures/messages-poll.json"
    guard let bytes = FileManager.default.contents(atPath: fixturePath),
          let fixture = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
          let expected = fixture["poll"] as? [String: Any],
          let fixtureAt = ((expected["messages"] as? [[String: Any]])?.first?["at"] as? NSNumber)?.doubleValue
    else { check(false, "messages poll fixture is readable from the repository root"); return }
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("coarena-chat-\(UUID().uuidString)")
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let path = directory.appendingPathComponent("chat.db").path
    let store = MessagesDatabase(path: path)
    let owner = "+1 (555) 123-4567"

    // Configured while there is no database yet (Messages closed, never used,
    // or no grant): no baseline, rather than a baseline of row 0.
    store.rebaseline()
    check(store.baseline == nil && store.state == .missing, "configuring before the database can be read takes no baseline")
    check((try? store.poll(handle: owner, since: 0, now: fixtureAt)) == nil, "polling an unreadable database fails instead of guessing")

    var db: OpaquePointer?
    guard sqlite3_open(path, &db) == SQLITE_OK, let db else { check(false, "the synthetic chat.db opens"); return }
    defer { sqlite3_close(db) }
    func exec(_ sql: String) {
        if sqlite3_exec(db, sql, nil, nil, nil) != SQLITE_OK { check(false, "synthetic SQL runs: " + String(cString: sqlite3_errmsg(db))) }
    }
    exec("""
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT UNIQUE, id TEXT NOT NULL, service TEXT NOT NULL);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, style INTEGER, chat_identifier TEXT);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER, PRIMARY KEY (chat_id, message_id));
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT, text TEXT, handle_id INTEGER DEFAULT 0,
      service TEXT, date INTEGER, is_from_me INTEGER DEFAULT 0, cache_has_attachments INTEGER DEFAULT 0,
      item_type INTEGER DEFAULT 0, associated_message_type INTEGER DEFAULT 0, balloon_bundle_id TEXT,
      is_auto_reply INTEGER DEFAULT 0, is_system_message INTEGER DEFAULT 0, is_service_message INTEGER DEFAULT 0,
      attributedBody BLOB);
    INSERT INTO handle VALUES (1, '+15551234567', 'iMessage'), (2, '+15551234567', 'SMS'), (3, '+15559998888', 'iMessage');
    INSERT INTO chat VALUES (1, 45, '+15551234567'), (2, 43, 'chat-family'), (3, 45, '+15559998888');
    """)
    func appleDate(_ unix: Double) -> Int64 { Int64((unix - 978307200) * 1_000_000_000) }
    /// One incoming row; `extra` is more column assignments, `chats` its links.
    func insert(_ rowId: Int, text: String? = "status", handle: Int = 1, service: String = "iMessage",
                at: Double = fixtureAt, chats: [Int] = [1], extra: String = "", body: [UInt8]? = nil) {
        let value = text.map { "'\($0)'" } ?? "NULL"
        let blob = body.map { "X'" + $0.map { String(format: "%02X", $0) }.joined() + "'" } ?? "NULL"
        exec("INSERT INTO message (ROWID, text, handle_id, service, date, attributedBody) VALUES (\(rowId), \(value), \(handle), '\(service)', \(appleDate(at)), \(blob))")
        if !extra.isEmpty { exec("UPDATE message SET \(extra) WHERE ROWID = \(rowId)") }
        for chat in chats { exec("INSERT INTO chat_message_join VALUES (\(chat), \(rowId))") }
    }

    // A command stored before the database could be read is a backlog.
    insert(50, text: "do empty the trash")
    let first = try? store.poll(handle: owner, since: 0, now: fixtureAt + 10)
    check(first == MessagePoll(rowId: 50, messages: [], skipped: 0) && store.baseline == 50,
          "the first good read only takes the baseline: a command stored before it never runs")
    check((try? store.poll(handle: owner, since: 0, now: fixtureAt + 10)) == MessagePoll(rowId: 50, messages: [], skipped: 0),
          "a cursor behind the baseline is raised to it")

    // Every kind of row that must never act, then the fixture's command.
    insert(84, extra: "is_system_message = 1")
    insert(85, extra: "is_service_message = 1")
    insert(86, extra: "associated_message_type = 2000")
    insert(87, extra: "balloon_bundle_id = 'com.apple.messages.URLBalloonProvider'")
    insert(88, extra: "item_type = 1")
    insert(89, text: nil, body: typedstream(String(repeating: "x", count: messageAttributedBodyLimit)))
    insert(90, text: "stop", handle: 2, service: "SMS")
    insert(91, text: "stop", handle: 2)
    insert(92, text: "stop", service: "RCS")
    insert(93, text: "stop", extra: "is_auto_reply = 1")
    insert(94, text: "do you want pizza?", chats: [2])
    insert(95, text: "stop", chats: [1, 2])
    insert(96, text: "stop", handle: 3, chats: [3])
    insert(97, text: "stop", extra: "is_from_me = 1")
    insert(98, text: "stop", extra: "cache_has_attachments = 1")
    insert(99, text: "stop", at: fixtureAt - 900)
    insert(101)
    let polled = try? store.poll(handle: owner, since: 50, now: fixtureAt + 10)
    check(polled.map { NSDictionary(dictionary: $0.object).isEqual(to: expected) } ?? false,
          "a poll of the synthetic chat.db returns exactly the fixture's poll: only the one-to-one iMessage command from the owner")

    // A body stored only in attributedBody is read; a row whose chat link is
    // not stored yet waits for it instead of being passed over.
    insert(102, text: nil, body: typedstream("pause"))
    insert(103, text: "stop", chats: [])
    insert(104)
    let waiting = try? store.poll(handle: owner, since: 101, now: fixtureAt + 20)
    check(waiting?.messages.map(\.text) == ["pause"], "a body stored only in attributedBody is decoded")
    check(waiting?.rowId == 102 && waiting?.skipped == 0, "the cursor stops before a command whose chat link is missing")
    exec("INSERT INTO chat_message_join VALUES (1, 103)")
    let linked = try? store.poll(handle: owner, since: 102, now: fixtureAt + 20.5)
    check(linked?.messages.map(\.text) == ["stop", "status"] && linked?.rowId == 104, "once linked one-to-one, the command is read")
    insert(105, text: "stop", chats: [])
    insert(106)
    check((try? store.poll(handle: owner, since: 104, now: fixtureAt + 30))?.rowId == 104, "an unlinked command holds the cursor briefly")
    let expired = try? store.poll(handle: owner, since: 104, now: fixtureAt + 30 + messageChatWaitSeconds)
    check(expired?.messages.map(\.rowId) == [106] && expired?.rowId == 106, "a row still unlinked after the wait is refused and later rows go on")

    // A full page says so, and the next poll picks up the rest.
    for rowId in 107 ..< 132 { insert(rowId, handle: 3, chats: [3]) }
    let page = try? store.poll(handle: owner, since: 106, now: fixtureAt + 40)
    check(page?.rowId == 126 && page?.skipped == messagePollLimit, "a full page reports its rows as skipped")
    let rest = try? store.poll(handle: owner, since: 126, now: fixtureAt + 40)
    check(rest?.rowId == 131 && rest?.skipped == 0, "the next page finishes the backlog")

    // A new handle rebaselines at the newest row.
    insert(132)
    store.rebaseline()
    check(store.baseline == 132 && store.state == .ok, "configuring a readable database takes its newest row as the baseline")
    check((try? store.poll(handle: owner, since: 0, now: fixtureAt + 10))?.messages.isEmpty ?? false, "nothing at the new baseline is read")
    store.reset()
    check(store.baseline == nil, "clearing the handle forgets the baseline")
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
        messageDatabaseChecks(check)
    }
}
