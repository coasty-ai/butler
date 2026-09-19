import Foundation

// The MCP framing in AppleProtocol.swift over a fixture store, and the shapes
// the app's tests read: every file under tests/fixtures/apple is a store plus
// an exchange of lines, and each reply must come back byte for byte (keys
// sorted). tests/tools-apple.test.ts parses the same replies.

/// A store built from a fixture's "store" object. Adds append, read-backs
/// return what was stored (or a drifted title when "drift" is set), and undo
/// tokens come from the fixture's list.
final class FixtureStore: AppleStore {
    let clock: AppleClock
    private var access: [String: String]
    private var calendarList: [AppleContainer]
    private var eventList: [AppleEvent]
    private var listList: [AppleContainer]
    private var reminderList: [AppleReminder]
    private var folders: [String]
    private var noteList: [AppleNote]
    private var mailList: [(message: AppleMessage, read: Bool)]
    private var drafts = [String: AppleDraft]()
    private var tokens: [String]
    private let drift: Bool
    private var counter = 0

    init(_ fixture: [String: Any]) {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: fixture["zone"] as? String ?? "America/Los_Angeles")!
        func date(_ value: Any?) -> AppleDateArgument? { (value as? String).flatMap { AppleRules.date($0, calendar: calendar) } }
        clock = AppleClock(now: date(fixture["now"])?.date ?? Date(timeIntervalSince1970: 0), calendar: calendar)
        access = fixture["access"] as? [String: String] ?? [:]
        func containers(_ key: String) -> [AppleContainer] {
            (fixture[key] as? [[String: Any]] ?? []).enumerated().map { index, entry in
                AppleContainer(title: entry["title"] as? String ?? "", writable: entry["writable"] as? Bool ?? true,
                               subscribed: entry["subscribed"] as? Bool ?? false, birthdays: entry["birthdays"] as? Bool ?? false,
                               isDefault: entry["default"] as? Bool ?? false, id: "\(key)-\(index)")
            }
        }
        calendarList = containers("calendars")
        listList = containers("lists")
        eventList = (fixture["events"] as? [[String: Any]] ?? []).compactMap { entry in
            guard let start = date(entry["start"]), let end = date(entry["end"]) else { return nil }
            return AppleEvent(id: entry["id"] as? String ?? "", title: entry["title"] as? String ?? "", start: start.date, end: end.date,
                              allDay: entry["allDay"] as? Bool ?? false, calendar: entry["calendar"] as? String ?? "",
                              hasAttendees: entry["hasAttendees"] as? Bool ?? false, recurring: entry["recurring"] as? Bool ?? false)
        }
        reminderList = (fixture["reminders"] as? [[String: Any]] ?? []).map { entry in
            let due = date(entry["due"])
            return AppleReminder(id: entry["id"] as? String ?? "", title: entry["title"] as? String ?? "", due: due?.date,
                                 dueHasTime: due?.hasTime ?? false, list: entry["list"] as? String ?? "",
                                 recurring: entry["recurring"] as? Bool ?? false)
        }
        folders = fixture["folders"] as? [String] ?? ["Notes"]
        noteList = (fixture["notes"] as? [[String: Any]] ?? []).map {
            AppleNote(id: $0["id"] as? String ?? "", title: $0["title"] as? String ?? "", folder: $0["folder"] as? String ?? "")
        }
        mailList = (fixture["mail"] as? [[String: Any]] ?? []).compactMap { entry in
            guard let received = date(entry["received"]) else { return nil }
            return (AppleMessage(sender: entry["sender"] as? String ?? "", subject: entry["subject"] as? String ?? "", received: received.date),
                    entry["read"] as? Bool ?? false)
        }
        tokens = fixture["tokens"] as? [String] ?? []
        drift = fixture["drift"] as? Bool ?? false
    }

    func nextToken() -> String { tokens.isEmpty ? "undo-none" : tokens.removeFirst() }
    private func nextId(_ prefix: String) -> String { counter += 1; return "\(prefix)-new-\(counter)" }
    private func drifted(_ title: String) -> String { drift ? title + " (drifted)" : title }

    func access(_ consent: AppleConsent) -> String { access[consent.rawValue] ?? "granted" }
    func calendars() -> [AppleContainer] { calendarList }
    func events(in range: AppleEventRange) -> [AppleEvent] { eventList.filter { $0.start < range.end && $0.end > range.start } }
    func addEvent(_ request: AppleEventRequest, to container: AppleContainer) throws -> String {
        let id = nextId("e")
        eventList.append(AppleEvent(id: id, title: drifted(request.title), start: request.start, end: request.end, allDay: request.allDay,
                                    calendar: container.title))
        return id
    }
    func event(_ id: String) -> AppleEvent? { eventList.first { $0.id == id } }
    func removeEvent(_ id: String) throws { eventList.removeAll { $0.id == id } }
    func lists() -> [AppleContainer] { listList }
    func reminders(in list: AppleContainer?) -> [AppleReminder] { reminderList.filter { list == nil || $0.list == list!.title } }
    func addReminder(_ request: AppleReminderRequest, to container: AppleContainer) throws -> String {
        let id = nextId("r")
        reminderList.append(AppleReminder(id: id, title: drifted(request.title), due: request.due, dueHasTime: request.dueHasTime, list: container.title))
        return id
    }
    func reminder(_ id: String) -> AppleReminder? { reminderList.first { $0.id == id } }
    func removeReminder(_ id: String) throws { reminderList.removeAll { $0.id == id } }
    func searchNotes(_ query: String) throws -> [AppleNote] { noteList.filter { $0.title.lowercased().contains(query.lowercased()) } }
    func addNote(_ request: AppleNoteRequest) throws -> AppleNote {
        if let folder = request.folder, !folders.contains(folder) {
            throw AppleFailure(code: "NO_FOLDER", message: "Notes has no folder named \(folder). Folders: \(folders.sorted().joined(separator: ", ")).")
        }
        let note = AppleNote(id: nextId("n"), title: drifted(request.title), folder: request.folder ?? folders[0])
        noteList.append(note)
        return note
    }
    func removeNote(_ id: String) throws { noteList.removeAll { $0.id == id } }
    func unreadMail(limit: Int) throws -> [AppleMessage] { mailList.filter { !$0.read }.map(\.message) }
    func searchMail(_ query: AppleMailQuery) throws -> [AppleMessage] {
        mailList.map(\.message).filter { message in
            (query.from.map { message.sender.lowercased().contains($0.lowercased()) } ?? true)
                && (query.subject.map { message.subject.lowercased().contains($0.lowercased()) } ?? true)
                && (query.since.map { message.received >= $0 } ?? true)
        }
    }
    func addDraft(_ request: AppleDraftRequest) throws -> AppleDraft {
        let draft = AppleDraft(id: nextId("d"), subject: drifted(request.subject), recipients: request.to.count)
        drafts[draft.id] = draft
        return draft
    }
    func removeDraft(_ id: String) throws {
        guard drafts.removeValue(forKey: id) != nil else { throw AppleFailure(code: "NOT_FOUND", message: "The draft is no longer there.") }
    }
}

func appleProtocolChecks(_ check: (Bool, String) -> Void) {
    // The catalogue: nine tools, schemas and annotations, undo unlisted.
    let names = appleTools.map(\.name)
    check(names == ["calendar_list_events", "calendar_create_event", "reminders_list", "reminders_create", "notes_search", "notes_create",
                    "mail_unread", "mail_search", "mail_draft"], "tools/list has exactly the nine model-facing tools, in order")
    check(!names.contains("undo"), "undo is never listed")
    for tool in appleTools {
        let listed = tool.listed
        let annotations = listed["annotations"] as? [String: Any] ?? [:]
        let reads = tool.name.hasSuffix("_list") || tool.name.hasSuffix("_search") || tool.name.hasSuffix("_events") || tool.name == "mail_unread"
        check(annotations["readOnlyHint"] as? Bool == reads, "\(tool.name) readOnlyHint says whether it reads")
        check(annotations["destructiveHint"] as? Bool == false, "\(tool.name) is never destructive")
        check(annotations["openWorldHint"] as? Bool == false, "\(tool.name) is closed-world")
        let input = listed["inputSchema"] as? [String: Any] ?? [:]
        check(input["type"] as? String == "object" && input["additionalProperties"] as? Bool == false, "\(tool.name) input is a closed object")
        check(!(input["properties"] as? [String: Any] ?? [:]).isEmpty, "\(tool.name) declares its parameters")
        // The date contract: a date argument is stated by pattern (AppleRules.dayPattern or
        // momentPattern), never by a JSON Schema format the client would read as RFC 3339 and refuse
        // the local form with. from and to are days; every other date takes a day or a local time.
        let dayKeys: Set<String> = tool.name == "calendar_list_events" ? ["from", "to"] : []
        let momentKeys: Set<String> = ["start", "end", "due", "dueBefore", "since"]
        for (key, property) in input["properties"] as? [String: [String: Any]] ?? [:] {
            let format = property["format"] as? String
            check(format != "date" && format != "date-time" && format != "time", "\(tool.name).\(key) carries no date format")
            let expected = dayKeys.contains(key) ? AppleRules.dayPattern : momentKeys.contains(key) ? AppleRules.momentPattern : nil
            check(property["pattern"] as? String == expected, "\(tool.name).\(key) carries \(expected == nil ? "no date pattern" : "its date pattern")")
        }
        check((listed["outputSchema"] as? [String: Any])?["type"] as? String == "object", "\(tool.name) declares its result")
        check(tool.description.count <= 200, "\(tool.name) description fits the model's context line")
    }

    // Every fixture: build the store, replay the exchange, compare bytes.
    let directory = FileManager.default.currentDirectoryPath + "/tests/fixtures/apple"
    let files = ((try? FileManager.default.contentsOfDirectory(atPath: directory)) ?? []).filter { $0.hasSuffix(".json") }.sorted()
    check(files.count >= 12, "the fixtures are present (\(files.count))")
    var calls = Set<String>()
    for file in files {
        guard let bytes = FileManager.default.contents(atPath: directory + "/" + file),
              let fixture = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any],
              let exchange = fixture["exchange"] as? [[String: Any]], !exchange.isEmpty
        else { check(false, "\(file) is a fixture with an exchange"); continue }
        let store = FixtureStore(fixture["store"] as? [String: Any] ?? [:])
        let server = AppleServer(store: store, version: "0.1.0", token: store.nextToken)
        for (index, step) in exchange.enumerated() {
            let line: String
            if let raw = step["in"] as? String { line = raw } else { line = AppleServer.encode(step["in"] ?? [:]) }
            if let request = step["in"] as? [String: Any], request["method"] as? String == "tools/call",
               let name = (request["params"] as? [String: Any])?["name"] as? String { calls.insert(name) }
            let expected = (step["out"] == nil || step["out"] is NSNull) ? nil : AppleServer.encode(step["out"]!)
            let actual = server.handle(line: line)
            if actual != expected {
                print("MISMATCH \(file) step \(index)\n  expected: \(expected ?? "nil")\n  actual:   \(actual ?? "nil")")
            }
            check(actual == expected, "\(file) step \(index) replies as recorded")
        }
    }
    for name in names { check(calls.contains(name), "a fixture calls \(name)") }
    check(calls.contains("undo"), "a fixture calls undo")
}

@main struct AppleBridgeTests {
    static func main() {
        func check(_ condition: Bool, _ name: String) { if !condition { fatalError(name) }; print("PASS: " + name) }
        appleRulesChecks(check)
        appleProtocolChecks(check)
        launchChecks(check)
    }
}
