import Foundation

/**
 The MCP face of coarena-apple: newline-delimited JSON-RPC 2.0 in, at most one
 line out per request; the catalogue of the nine tools the model may call and
 the hidden `undo`; every call checked by AppleRules before the store is
 touched. The store is a protocol, so the native tests drive every reply from
 the JSON fixtures under tests/fixtures/apple without EventKit or an Apple
 event, and the app's tests read the same fixtures for the shapes they parse
 (docs/TOOLS.md).

 Methods: initialize, notifications/initialized, ping, tools/list, tools/call.
 Anything else is -32601; a line that is not JSON is -32700; a request that is
 not an object is -32600; a tools/call without a known name is -32602. A
 refusal inside a tool is a result with isError and a "CODE: sentence" text.
 */

let appleProtocolVersion = "2025-06-18"
let appleServerName = "coarena-apple"
let appleServerVersion = "0.1.0"

/// What the bridge reads and writes, without saying how. Apple.swift is the
/// live store over EventKit and Apple events; the tests use a fixture.
protocol AppleStore: AnyObject {
    var clock: AppleClock { get }
    /// "granted", "denied", "restricted", "notDetermined" or "unknown"; for
    /// notes and mail the non-prompting Automation preflight, made before every call.
    func access(_ consent: AppleConsent) -> String
    func calendars() -> [AppleContainer]
    func events(in range: AppleEventRange) -> [AppleEvent]
    /// Saves and returns the store's identifier.
    func addEvent(_ request: AppleEventRequest, to container: AppleContainer) throws -> String
    func event(_ id: String) -> AppleEvent?
    func removeEvent(_ id: String) throws
    func lists() -> [AppleContainer]
    /// Open reminders, in one list or all of them.
    func reminders(in list: AppleContainer?) -> [AppleReminder]
    func addReminder(_ request: AppleReminderRequest, to container: AppleContainer) throws -> String
    func reminder(_ id: String) -> AppleReminder?
    func removeReminder(_ id: String) throws
    func searchNotes(_ query: String) throws -> [AppleNote]
    func addNote(_ request: AppleNoteRequest) throws -> AppleNote
    func removeNote(_ id: String) throws
    func unreadMail(limit: Int) throws -> [AppleMessage]
    func searchMail(_ query: AppleMailQuery) throws -> [AppleMessage]
    func addDraft(_ request: AppleDraftRequest) throws -> AppleDraft
    func removeDraft(_ id: String) throws
}

/// One tool as tools/list shows it.
struct AppleTool {
    let name: String
    let title: String
    let consent: AppleConsent
    let readOnly: Bool
    let idempotent: Bool
    let description: String
    let input: [String: Any]
    let output: [String: Any]

    var listed: [String: Any] {
        ["name": name, "title": title, "description": description, "inputSchema": input, "outputSchema": output,
         "annotations": ["readOnlyHint": readOnly, "destructiveHint": false, "idempotentHint": idempotent, "openWorldHint": false]]
    }
}

private func schema(_ properties: [String: Any], required: [String]) -> [String: Any] {
    ["type": "object", "properties": properties, "required": required, "additionalProperties": false]
}
private func text(_ description: String, max: Int, format: String? = nil) -> [String: Any] {
    var property: [String: Any] = ["type": "string", "description": description, "minLength": 1, "maxLength": max]
    if let format { property["format"] = format }
    return property
}
private func day(_ description: String) -> [String: Any] {
    ["type": "string", "format": "date", "description": description]
}
private func moment(_ description: String) -> [String: Any] {
    ["type": "string", "format": "date-time", "description": description]
}
/// What every read returns: the lines a voice can speak and how many more there were.
private let linesOutput = schema(
    ["lines": ["type": "array", "items": ["type": "string", "maxLength": AppleRules.lineLimit], "maxItems": AppleRules.linesLimit],
     "more": ["type": "integer", "minimum": 0]],
    required: ["lines", "more"])
/// What every add returns: the item as the store now holds it, read back, and its undo token.
private func createdOutput(_ properties: [String: Any], required: [String]) -> [String: Any] {
    var item = properties
    item["kind"] = ["type": "string"]
    return schema(["created": schema(item, required: ["kind"] + required), "verified": ["type": "boolean"], "undoToken": ["type": "string"]],
                  required: ["created", "verified", "undoToken"])
}

/// The nine tools, in the order tools/list gives them. `undo` is not here:
/// the model never sees it.
let appleTools: [AppleTool] = [
    AppleTool(name: "calendar_list_events", title: "Calendar", consent: .calendar, readOnly: true, idempotent: true,
              description: "Events between two local days, inclusive: when, title and calendar per line. At most 20 lines and 31 days.",
              input: schema(["from": day("First day, YYYY-MM-DD, local."), "to": day("Last day, inclusive; at most 31 days after from.")],
                            required: ["from", "to"]),
              output: linesOutput),
    AppleTool(name: "calendar_create_event", title: "Calendar", consent: .calendar, readOnly: false, idempotent: true,
              description: "Adds one event. Local times; end defaults to an hour after start; allDay takes days. An event with the same title and start in that calendar is refused as a duplicate.",
              input: schema(["title": text("One line, at most 100 characters.", max: AppleRules.titleLimit),
                             "start": moment("Local date-time like 2026-09-19T18:00; a day alone with allDay."),
                             "end": moment("Local date-time; 1 minute to 24 hours after start. With allDay, the last day."),
                             "allDay": ["type": "boolean", "description": "An all-day event; start and end are days."],
                             "calendar": text("An existing calendar's exact name; the default calendar when omitted.", max: AppleRules.titleLimit)],
                            required: ["title", "start"]),
              output: createdOutput(["title": ["type": "string"], "start": ["type": "string", "format": "date-time"],
                                     "end": ["type": "string", "format": "date-time"], "allDay": ["type": "boolean"], "calendar": ["type": "string"]],
                                    required: ["title", "start", "end", "allDay", "calendar"])),
    AppleTool(name: "reminders_list", title: "Reminders", consent: .reminders, readOnly: true, idempotent: true,
              description: "Open reminders, in one list or all, optionally only those due before a date: title, due date and list per line, at most 20.",
              input: schema(["list": text("An existing list's exact name.", max: AppleRules.titleLimit),
                             "dueBefore": moment("Only reminders due before this local date or date-time.")],
                            required: []),
              output: linesOutput),
    AppleTool(name: "reminders_create", title: "Reminders", consent: .reminders, readOnly: false, idempotent: true,
              description: "Adds one reminder, with an optional due date or date-time, to a list or the default list. The same title and due date in that list is refused as a duplicate.",
              input: schema(["title": text("One line, at most 100 characters.", max: AppleRules.titleLimit),
                             "due": moment("Local date (2026-09-25) or date-time (2026-09-25T09:00)."),
                             "list": text("An existing list's exact name; the default list when omitted.", max: AppleRules.titleLimit)],
                            required: ["title"]),
              output: createdOutput(["title": ["type": "string"], "due": ["type": "string", "format": "date-time"], "list": ["type": "string"]],
                                    required: ["title", "list"])),
    AppleTool(name: "notes_search", title: "Notes", consent: .notes, readOnly: true, idempotent: true,
              description: "Notes whose title contains the query: title and folder per line, at most 20. Bodies are never read.",
              input: schema(["query": text("Words of the title.", max: AppleRules.queryLimit)], required: ["query"]),
              output: linesOutput),
    AppleTool(name: "notes_create", title: "Notes", consent: .notes, readOnly: false, idempotent: false,
              description: "Adds one note with a title and an optional plain-text body to a folder or the default folder.",
              input: schema(["title": text("One line, at most 100 characters.", max: AppleRules.titleLimit),
                             "body": ["type": "string", "description": "Plain text, at most 4000 characters.", "maxLength": AppleRules.bodyLimit],
                             "folder": text("An existing folder's exact name; the default folder when omitted.", max: AppleRules.titleLimit)],
                            required: ["title"]),
              output: createdOutput(["title": ["type": "string"], "folder": ["type": "string"]], required: ["title", "folder"])),
    AppleTool(name: "mail_unread", title: "Mail", consent: .mail, readOnly: true, idempotent: true,
              description: "The newest unread inbox messages: sender name, subject and age per line, at most 20. Bodies are never read.",
              input: schema(["limit": ["type": "integer", "minimum": 1, "maximum": AppleRules.linesLimit, "description": "How many, 1 to 20; 10 when omitted."]],
                            required: []),
              output: linesOutput),
    AppleTool(name: "mail_search", title: "Mail", consent: .mail, readOnly: true, idempotent: true,
              description: "Inbox messages by sender, subject or date received (at least one): sender name, subject and age per line, at most 20. Bodies are never read.",
              input: schema(["from": text("Part of the sender's name or address.", max: AppleRules.queryLimit),
                             "subject": text("Part of the subject.", max: AppleRules.queryLimit),
                             "since": moment("Only messages received at or after this local date or date-time.")],
                            required: []),
              output: linesOutput),
    AppleTool(name: "mail_draft", title: "Mail", consent: .mail, readOnly: false, idempotent: false,
              description: "Creates a draft in Mail to the given addresses with a subject and an optional body. Nothing is sent; the user sends it from Mail.",
              input: schema(["to": ["type": "array", "items": ["type": "string", "format": "email"], "minItems": 1, "maxItems": AppleRules.recipientLimit,
                                    "description": "Recipient addresses."],
                             "subject": text("One line, at most 200 characters.", max: AppleRules.subjectLimit),
                             "body": ["type": "string", "description": "Plain text, at most 4000 characters.", "maxLength": AppleRules.bodyLimit]],
                            required: ["to", "subject"]),
              output: createdOutput(["subject": ["type": "string"], "recipients": ["type": "integer"]], required: ["subject", "recipients"])),
]

private let appNames: [AppleConsent: String] = [.calendar: "Calendar", .reminders: "Reminders", .notes: "Notes", .mail: "Mail"]

final class AppleServer {
    private let store: AppleStore
    private let version: String
    private let token: () -> String
    /// What this process added, by undo token. Dropped when the process ends.
    private var created = [String: AppleCreated]()

    init(store: AppleStore, version: String = appleServerVersion, token: @escaping () -> String = { UUID().uuidString.lowercased() }) {
        self.store = store
        self.version = version
        self.token = token
    }

    // MARK: - Framing

    /// One line in; the reply line, or nil for a blank line or a notification.
    func handle(line: String) -> String? {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard let data = trimmed.data(using: .utf8), let message = try? JSONSerialization.jsonObject(with: data) else {
            return AppleServer.encode(AppleServer.failure(id: NSNull(), code: -32700, message: "Parse error"))
        }
        return respond(to: message).map(AppleServer.encode)
    }

    /// One parsed message in; the reply object, or nil for a notification.
    func respond(to message: Any) -> [String: Any]? {
        guard let request = message as? [String: Any] else {
            return AppleServer.failure(id: NSNull(), code: -32600, message: "Invalid Request")
        }
        let id = request["id"]
        let isRequest = id != nil && !(id is NSNull)
        guard request["jsonrpc"] as? String == "2.0", let method = request["method"] as? String else {
            return isRequest ? AppleServer.failure(id: id!, code: -32600, message: "Invalid Request") : nil
        }
        guard isRequest, let id else { return nil }
        let params = request["params"] as? [String: Any] ?? [:]
        switch method {
        case "initialize":
            return AppleServer.reply(id: id, ["protocolVersion": appleProtocolVersion, "capabilities": ["tools": [String: Any]()],
                                              "serverInfo": ["name": appleServerName, "version": version]])
        case "ping":
            return AppleServer.reply(id: id, [String: Any]())
        case "tools/list":
            return AppleServer.reply(id: id, ["tools": appleTools.map(\.listed)])
        case "tools/call":
            guard let name = params["name"] as? String else { return AppleServer.failure(id: id, code: -32602, message: "Invalid params") }
            let arguments = params["arguments"]
            guard arguments == nil || arguments is NSNull || arguments is [String: Any] else {
                return AppleServer.failure(id: id, code: -32602, message: "Invalid params")
            }
            guard name == "undo" || appleTools.contains(where: { $0.name == name }) else {
                return AppleServer.failure(id: id, code: -32602, message: "Unknown tool")
            }
            return AppleServer.reply(id: id, call(name, arguments as? [String: Any] ?? [:]))
        default:
            return AppleServer.failure(id: id, code: -32601, message: "Method not found")
        }
    }

    static func reply(id: Any, _ result: [String: Any]) -> [String: Any] { ["jsonrpc": "2.0", "id": id, "result": result] }
    static func failure(id: Any, code: Int, message: String) -> [String: Any] {
        ["jsonrpc": "2.0", "id": id, "error": ["code": code, "message": message]]
    }
    /// One line, keys sorted, so a reply is the same bytes every time.
    static func encode(_ object: Any) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes]),
              let text = String(data: data, encoding: .utf8) else { return "{}" }
        return text
    }

    // MARK: - Tools

    /// The tools/call result for one tool: content, structuredContent and isError.
    func call(_ name: String, _ args: [String: Any]) -> [String: Any] {
        do {
            switch name {
            case "calendar_list_events": return try listEvents(args)
            case "calendar_create_event": return try createEvent(args)
            case "reminders_list": return try listReminders(args)
            case "reminders_create": return try createReminder(args)
            case "notes_search": return try searchNotes(args)
            case "notes_create": return try createNote(args)
            case "mail_unread": return try unreadMail(args)
            case "mail_search": return try searchMail(args)
            case "mail_draft": return try createDraft(args)
            case "undo": return try undo(args)
            default: return AppleServer.refusal(AppleFailure(code: "UNKNOWN_TOOL", message: "No such tool."))
            }
        } catch let failure as AppleFailure {
            return AppleServer.refusal(failure)
        } catch {
            return AppleServer.refusal(AppleFailure(code: "FAILED", message: "The request failed."))
        }
    }

    private static func refusal(_ failure: AppleFailure) -> [String: Any] {
        ["content": [["type": "text", "text": "\(failure.code): \(failure.message)"]], "isError": true]
    }
    private static func result(_ text: String, _ structured: [String: Any]) -> [String: Any] {
        ["content": [["type": "text", "text": text]], "structuredContent": structured, "isError": false]
    }
    private static func lines(_ lines: [String], empty: String) -> [String: Any] {
        let bounded = AppleRules.bounded(lines)
        var text = bounded.lines.isEmpty ? empty : bounded.lines.joined(separator: "\n")
        if bounded.more > 0 { text += "\n+\(bounded.more) more" }
        return result(text, ["lines": bounded.lines, "more": bounded.more])
    }

    private func granted(_ consent: AppleConsent) throws {
        guard store.access(consent) == "granted" else {
            throw AppleFailure(code: "NO_ACCESS", message: "macOS has not allowed Butler to use \(appNames[consent]!).")
        }
    }
    private func remember(_ kind: AppleCreatedKind, _ id: String) -> String {
        let token = self.token()
        created[token] = AppleCreated(kind: kind, id: id)
        return token
    }
    private var clock: AppleClock { store.clock }

    private func listEvents(_ args: [String: Any]) throws -> [String: Any] {
        try granted(.calendar)
        let range = try AppleRules.eventRange(args, clock: clock)
        let events = store.events(in: range).sorted { $0.start < $1.start }
        return AppleServer.lines(events.map { AppleRules.eventLine($0, clock: clock) }, empty: "No events in that range.")
    }

    private func createEvent(_ args: [String: Any]) throws -> [String: Any] {
        try granted(.calendar)
        let request = try AppleRules.eventRequest(args, clock: clock)
        let container = try AppleRules.container(named: request.calendar, among: store.calendars(), kind: .calendar)
        let around = store.events(in: AppleEventRange(start: request.start, end: request.end))
        if AppleRules.duplicate(request, in: container, among: around) {
            throw AppleFailure(code: "DUPLICATE", message: "An event titled \(request.title) at that time is already in \(container.title).")
        }
        let id = try store.addEvent(request, to: container)
        guard let saved = store.event(id), AppleRules.matches(request, saved, in: container, calendar: clock.calendar) else {
            throw AppleFailure(code: "READBACK_MISMATCH", message: "Calendar did not store the event as asked; check it in Calendar.")
        }
        let when = AppleRules.when(start: saved.start, end: saved.end, allDay: saved.allDay, clock: clock)
        return AppleServer.result("Added event \(saved.title) to \(saved.calendar): \(when).",
                                  ["created": ["kind": "event", "title": saved.title, "start": AppleRules.iso(saved.start, calendar: clock.calendar),
                                               "end": AppleRules.iso(saved.end, calendar: clock.calendar), "allDay": saved.allDay, "calendar": saved.calendar],
                                   "verified": true, "undoToken": remember(.event, id)])
    }

    private func listReminders(_ args: [String: Any]) throws -> [String: Any] {
        try granted(.reminders)
        let query = try AppleRules.reminderQuery(args, clock: clock)
        let list = try query.list.map { try AppleRules.container(named: $0, among: store.lists(), kind: .list, forWriting: false) }
        var reminders = store.reminders(in: list)
        if let before = query.dueBefore { reminders = reminders.filter { $0.due.map { $0 < before } ?? false } }
        reminders.sort { a, b in
            switch (a.due, b.due) {
            case let (x?, y?): return x < y
            case (_?, nil): return true
            case (nil, _?): return false
            case (nil, nil): return a.title < b.title
            }
        }
        return AppleServer.lines(reminders.map { AppleRules.reminderLine($0, clock: clock) }, empty: "No open reminders.")
    }

    private func createReminder(_ args: [String: Any]) throws -> [String: Any] {
        try granted(.reminders)
        let request = try AppleRules.reminderRequest(args, clock: clock)
        let container = try AppleRules.container(named: request.list, among: store.lists(), kind: .list)
        if AppleRules.duplicate(request, in: container, among: store.reminders(in: container)) {
            throw AppleFailure(code: "DUPLICATE", message: "A reminder titled \(request.title) with that due date is already in \(container.title).")
        }
        let id = try store.addReminder(request, to: container)
        guard let saved = store.reminder(id), AppleRules.matches(request, saved, in: container) else {
            throw AppleFailure(code: "READBACK_MISMATCH", message: "Reminders did not store the reminder as asked; check it in Reminders.")
        }
        var created: [String: Any] = ["kind": "reminder", "title": saved.title, "list": saved.list]
        var text = "Added reminder \(saved.title) to \(saved.list)"
        if let due = saved.due {
            created["due"] = AppleRules.iso(due, calendar: clock.calendar)
            text += ", due \(AppleRules.dayWords(due, clock: clock))"
            if saved.dueHasTime { text += " \(AppleRules.clockWords(due, calendar: clock.calendar))" }
        }
        return AppleServer.result(text + ".", ["created": created, "verified": true, "undoToken": remember(.reminder, id)])
    }

    private func searchNotes(_ args: [String: Any]) throws -> [String: Any] {
        try granted(.notes)
        let query = try AppleRules.notesQuery(args)
        return AppleServer.lines(try store.searchNotes(query).map(AppleRules.noteLine), empty: "No notes match.")
    }

    private func createNote(_ args: [String: Any]) throws -> [String: Any] {
        try granted(.notes)
        let request = try AppleRules.noteRequest(args)
        let note = try store.addNote(request)
        // Notes names a note after its first line and may tidy its spaces.
        guard AppleRules.clean(note.title) == AppleRules.clean(request.title) else {
            throw AppleFailure(code: "READBACK_MISMATCH", message: "Notes did not store the note as asked; check it in Notes.")
        }
        return AppleServer.result("Added note \(note.title) to \(note.folder).",
                                  ["created": ["kind": "note", "title": note.title, "folder": note.folder], "verified": true,
                                   "undoToken": remember(.note, note.id)])
    }

    private func unreadMail(_ args: [String: Any]) throws -> [String: Any] {
        try granted(.mail)
        let limit = try AppleRules.mailLimit(args)
        let messages = try store.unreadMail(limit: limit).sorted { $0.received > $1.received }.prefix(limit)
        return AppleServer.lines(messages.map { AppleRules.mailLine($0, clock: clock) }, empty: "No unread mail.")
    }

    private func searchMail(_ args: [String: Any]) throws -> [String: Any] {
        try granted(.mail)
        let query = try AppleRules.mailQuery(args, clock: clock)
        let messages = try store.searchMail(query).sorted { $0.received > $1.received }
        return AppleServer.lines(messages.map { AppleRules.mailLine($0, clock: clock) }, empty: "No mail matches.")
    }

    private func createDraft(_ args: [String: Any]) throws -> [String: Any] {
        try granted(.mail)
        let request = try AppleRules.draftRequest(args)
        let draft = try store.addDraft(request)
        guard draft.subject == request.subject, draft.recipients == request.to.count else {
            throw AppleFailure(code: "READBACK_MISMATCH", message: "Mail did not create the draft as asked; check Mail.")
        }
        let recipients = draft.recipients == 1 ? "1 recipient" : "\(draft.recipients) recipients"
        return AppleServer.result("Created a Mail draft to \(recipients): \(draft.subject). Nothing was sent.",
                                  ["created": ["kind": "draft", "subject": draft.subject, "recipients": draft.recipients], "verified": true,
                                   "undoToken": remember(.draft, draft.id)])
    }

    /// Takes back one add this process made. Never listed; the app calls it
    /// with the token an add returned.
    private func undo(_ args: [String: Any]) throws -> [String: Any] {
        let token = try AppleRules.undoToken(args)
        guard let entry = created[token] else {
            throw AppleFailure(code: "NOT_CREATED_HERE", message: "Nothing this session added carries that token.")
        }
        let missing = AppleFailure(code: "NOT_FOUND", message: "The \(entry.kind.rawValue) is no longer there.")
        switch entry.kind {
        case .event:
            try granted(.calendar)
            guard let event = store.event(entry.id) else { throw missing }
            try AppleRules.undoAllowed(event)
            try store.removeEvent(entry.id)
        case .reminder:
            try granted(.reminders)
            guard let reminder = store.reminder(entry.id) else { throw missing }
            try AppleRules.undoAllowed(reminder)
            try store.removeReminder(entry.id)
        case .note:
            try granted(.notes)
            try store.removeNote(entry.id)
        case .draft:
            try granted(.mail)
            try store.removeDraft(entry.id)
        }
        created.removeValue(forKey: token)
        return AppleServer.result("Removed the \(entry.kind.rawValue).", ["removed": ["kind": entry.kind.rawValue]])
    }
}
