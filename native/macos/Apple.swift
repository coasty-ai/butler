import AppKit
import CoreServices
import EventKit
import Foundation

/**
 coarena-apple: the Apple bridge, a small MCP stdio server the app ships. It
 reads and adds to Calendar, Reminders, Notes and Mail on the user's behalf,
 after the app has asked them (docs/TOOLS.md):

   (no arguments)        serve MCP on stdin/stdout, one JSON-RPC line each way,
                         one request at a time, until stdin closes
   status                which of the four consents macOS has granted; never prompts
   request <consent>     asks macOS for that one grant (the only prompting command;
                         Settings only; gives up after 120 s)

 Its own bundle identity (Apple-Info.plist, ai.coarena.openassist.apple) carries
 the usage strings, so its Calendars, Reminders and Automation grants are its
 own: separate from the controller's Screen Recording and Accessibility, and
 from coarena-agenda's read-only grant. Every Apple event to Notes or Mail is
 preceded by the non-prompting Automation preflight, so a run never hangs on a
 permission prompt; the targets are the two fixed bundle ids in AppleRules.

 Reads return titles, times, names, subjects and ages only: never a note body,
 a mail body, a location, an attendee or a URL. Adds are read back from the
 store before they are reported. Nothing is ever sent, moved or deleted, except
 that `undo` removes an item this very process added. The rules are pure in
 AppleRules.swift and the framing in AppleProtocol.swift; this file is the I/O.
 */

func emit(_ object: [String: Any]) {
    FileHandle.standardOutput.write((AppleServer.encode(object) + "\n").data(using: .utf8)!)
}

/// EventKit and Apple events, behind the store protocol the protocol layer uses.
final class LiveAppleStore: AppleStore {
    private let store = EKEventStore()
    /// How long one AppleScript may take; the client gives a call 20 s.
    private let scriptSeconds = 15
    /// How many inbox rows a mail read walks before sorting: enough to find
    /// the newest few without touching every message in a large mailbox.
    private let mailScan = 50

    var clock: AppleClock { AppleClock(now: Date(), calendar: Calendar.current) }

    // MARK: Access

    func access(_ consent: AppleConsent) -> String {
        switch consent {
        case .calendar: return eventKitAccess(.event)
        case .reminders: return eventKitAccess(.reminder)
        case .notes: return automationAccess(.notes, launch: true)
        case .mail: return automationAccess(.mail, launch: true)
        }
    }
    /// For `status`: nothing is launched, so a target that is not running reads as unknown.
    func report() -> [String: String] {
        ["calendar": eventKitAccess(.event), "reminders": eventKitAccess(.reminder),
         "notes": automationAccess(.notes, launch: false), "mail": automationAccess(.mail, launch: false)]
    }
    private func eventKitAccess(_ type: EKEntityType) -> String {
        switch EKEventStore.authorizationStatus(for: type) {
        case .fullAccess: return "granted"
        // Write-only cannot read back what it added, so it is not enough.
        case .writeOnly, .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "notDetermined"
        @unknown default: return "unknown"
        }
    }
    /// The Automation preflight (Messages.swift precedent): noErr granted,
    /// -1743 denied, -1744 not yet asked; -600 means the target is not running.
    private func preflight(_ target: AppleTarget, ask: Bool) -> OSStatus {
        var address = AEAddressDesc()
        var created: OSStatus = -1
        target.rawValue.withCString { pointer in
            created = OSStatus(AECreateDesc(typeApplicationBundleID, pointer, strlen(pointer), &address))
        }
        guard created == noErr else { return created }
        defer { AEDisposeDesc(&address) }
        return AEDeterminePermissionToAutomateTarget(&address, typeWildCard, typeWildCard, ask)
    }
    private func automationAccess(_ target: AppleTarget, launch: Bool) -> String {
        var status = preflight(target, ask: false)
        if status == OSStatus(procNotFound), launch, launched(target) { status = preflight(target, ask: false) }
        switch status {
        case noErr: return "granted"
        case OSStatus(errAEEventNotPermitted): return "denied"
        case OSStatus(errAEEventWouldRequireUserConsent): return "notDetermined"
        default: return "unknown"
        }
    }
    /// Starts the target in the background when it is not running, and waits
    /// (at most eight seconds) until Apple events can reach it.
    private func launched(_ target: AppleTarget) -> Bool {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: target.rawValue) else { return false }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false
        configuration.addsToRecentItems = false
        NSWorkspace.shared.openApplication(at: url, configuration: configuration) { _, _ in }
        let deadline = Date().addingTimeInterval(8)
        while Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
            if preflight(target, ask: false) != OSStatus(procNotFound) { return true }
        }
        return false
    }
    /// The one prompting path. EventKit shows its own sheet; for Notes and
    /// Mail the target is started first, then macOS asks about Automation.
    func request(_ consent: AppleConsent) async {
        switch consent {
        case .calendar: _ = try? await store.requestFullAccessToEvents()
        case .reminders: _ = try? await store.requestFullAccessToReminders()
        case .notes: if launched(.notes) { _ = preflight(.notes, ask: true) }
        case .mail: if launched(.mail) { _ = preflight(.mail, ask: true) }
        }
    }

    // MARK: Calendar

    private func container(_ calendar: EKCalendar, type: EKEntityType) -> AppleContainer {
        let fallback = type == .event ? store.defaultCalendarForNewEvents : store.defaultCalendarForNewReminders()
        return AppleContainer(title: calendar.title, writable: calendar.allowsContentModifications,
                              subscribed: calendar.source?.sourceType == .subscribed, birthdays: calendar.type == .birthday,
                              isDefault: calendar.calendarIdentifier == fallback?.calendarIdentifier, id: calendar.calendarIdentifier)
    }
    private func item(_ event: EKEvent) -> AppleEvent {
        AppleEvent(id: event.eventIdentifier ?? "", title: event.title ?? "", start: event.startDate, end: event.endDate,
                   allDay: event.isAllDay, calendar: event.calendar?.title ?? "", hasAttendees: event.hasAttendees,
                   recurring: event.hasRecurrenceRules)
    }
    func calendars() -> [AppleContainer] { store.calendars(for: .event).map { container($0, type: .event) } }
    func events(in range: AppleEventRange) -> [AppleEvent] {
        store.events(matching: store.predicateForEvents(withStart: range.start, end: range.end, calendars: nil)).map(item)
    }
    func addEvent(_ request: AppleEventRequest, to container: AppleContainer) throws -> String {
        guard let calendar = store.calendar(withIdentifier: container.id) else { throw AppleFailure(code: "NO_CALENDAR", message: "The calendar is gone.") }
        let event = EKEvent(eventStore: store)
        event.title = request.title
        event.calendar = calendar
        event.isAllDay = request.allDay
        event.startDate = request.start
        // Calendar keeps an all-day event's end inside its last day.
        event.endDate = request.allDay ? request.end.addingTimeInterval(-1) : request.end
        do { try store.save(event, span: .thisEvent, commit: true) } catch {
            throw AppleFailure(code: "SAVE_FAILED", message: "Calendar did not save the event.")
        }
        return event.eventIdentifier ?? ""
    }
    func event(_ id: String) -> AppleEvent? { store.event(withIdentifier: id).map(item) }
    func removeEvent(_ id: String) throws {
        guard let event = store.event(withIdentifier: id) else { throw AppleFailure(code: "NOT_FOUND", message: "The event is no longer there.") }
        do { try store.remove(event, span: .thisEvent, commit: true) } catch {
            throw AppleFailure(code: "REMOVE_FAILED", message: "Calendar did not remove the event.")
        }
    }

    // MARK: Reminders

    private func item(_ reminder: EKReminder) -> AppleReminder {
        let components = reminder.dueDateComponents
        return AppleReminder(id: reminder.calendarItemIdentifier, title: reminder.title ?? "",
                             due: components.flatMap { Calendar.current.date(from: $0) }, dueHasTime: components?.hour != nil,
                             list: reminder.calendar?.title ?? "", recurring: reminder.hasRecurrenceRules)
    }
    func lists() -> [AppleContainer] { store.calendars(for: .reminder).map { container($0, type: .reminder) } }
    func reminders(in list: AppleContainer?) -> [AppleReminder] {
        let calendars = list.flatMap { store.calendar(withIdentifier: $0.id) }.map { [$0] }
        let predicate = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: calendars)
        // The completion arrives on EventKit's own queue; the bridge handles one
        // request at a time, so waiting here is the whole of its work.
        let done = DispatchSemaphore(value: 0)
        var found = [EKReminder]()
        store.fetchReminders(matching: predicate) { found = $0 ?? []; done.signal() }
        _ = done.wait(timeout: .now() + .seconds(scriptSeconds))
        return found.prefix(500).map(item)
    }
    func addReminder(_ request: AppleReminderRequest, to container: AppleContainer) throws -> String {
        guard let calendar = store.calendar(withIdentifier: container.id) else { throw AppleFailure(code: "NO_LIST", message: "The list is gone.") }
        let reminder = EKReminder(eventStore: store)
        reminder.title = request.title
        reminder.calendar = calendar
        if let due = request.due {
            let units: Set<Calendar.Component> = request.dueHasTime ? [.year, .month, .day, .hour, .minute] : [.year, .month, .day]
            reminder.dueDateComponents = Calendar.current.dateComponents(units, from: due)
        }
        do { try store.save(reminder, commit: true) } catch {
            throw AppleFailure(code: "SAVE_FAILED", message: "Reminders did not save the reminder.")
        }
        return reminder.calendarItemIdentifier
    }
    func reminder(_ id: String) -> AppleReminder? { (store.calendarItem(withIdentifier: id) as? EKReminder).map(item) }
    func removeReminder(_ id: String) throws {
        guard let reminder = store.calendarItem(withIdentifier: id) as? EKReminder else {
            throw AppleFailure(code: "NOT_FOUND", message: "The reminder is no longer there.")
        }
        do { try store.remove(reminder, commit: true) } catch {
            throw AppleFailure(code: "REMOVE_FAILED", message: "Reminders did not remove the reminder.")
        }
    }

    // MARK: Apple events

    /// Runs one fixed script against one fixed target. Only AppleRules-escaped
    /// literals and integers are ever interpolated into a script.
    private func run(_ body: String, in target: AppleTarget, app: String) throws -> NSAppleEventDescriptor {
        let source = """
        tell application id "\(target.rawValue)"
            with timeout of \(scriptSeconds) seconds
        \(body)
            end timeout
        end tell
        """
        guard let script = NSAppleScript(source: source) else {
            throw AppleFailure(code: "FAILED", message: "The \(app) request could not be prepared.")
        }
        var error: NSDictionary?
        let result = script.executeAndReturnError(&error)
        guard let error else { return result }
        switch (error[NSAppleScript.errorNumber] as? Int) ?? 0 {
        case -1743, -10004:
            throw AppleFailure(code: "NO_ACCESS", message: "macOS has not allowed Butler to use \(app).")
        case -1712:
            throw AppleFailure(code: "TIMEOUT", message: "\(app) did not answer in time.")
        case -1728:
            throw AppleFailure(code: "NOT_FOUND", message: "\(app) has no such item.")
        default:
            throw AppleFailure(code: "FAILED", message: "\(app) did not complete the request.")
        }
    }
    private func literal(_ text: String) -> String { "\"" + AppleRules.appleScriptLiteral(text) + "\"" }
    /// A list of lists of scalars, as the scripts here return.
    private func rows(_ descriptor: NSAppleEventDescriptor) -> [[NSAppleEventDescriptor]] {
        (0 ..< descriptor.numberOfItems).compactMap { index -> [NSAppleEventDescriptor]? in
            guard let row = descriptor.atIndex(index + 1) else { return nil }
            return (0 ..< row.numberOfItems).compactMap { row.atIndex($0 + 1) }
        }
    }

    // MARK: Notes

    func searchNotes(_ query: String) throws -> [AppleNote] {
        let result = try run("""
                set found to {}
                repeat with n in (every note whose name contains \(literal(query)))
                    set end of found to {id of n, name of n, name of container of n}
                    if (count of found) >= \(AppleRules.linesLimit) then exit repeat
                end repeat
                return found
        """, in: .notes, app: "Notes")
        return rows(result).compactMap { row in
            guard row.count == 3, let id = row[0].stringValue else { return nil }
            return AppleNote(id: id, title: row[1].stringValue ?? "", folder: row[2].stringValue ?? "")
        }
    }
    func addNote(_ request: AppleNoteRequest) throws -> AppleNote {
        let target: String
        if let folder = request.folder {
            let exists = try run("return exists folder \(literal(folder)) of default account", in: .notes, app: "Notes")
            guard exists.booleanValue else {
                let names = try run("return name of every folder of default account", in: .notes, app: "Notes")
                let list = (0 ..< names.numberOfItems).compactMap { names.atIndex($0 + 1)?.stringValue }.sorted()
                    .prefix(AppleRules.linesLimit).joined(separator: ", ")
                throw AppleFailure(code: "NO_FOLDER", message: "Notes has no folder named \(folder). Folders: \(list).")
            }
            target = "folder \(literal(folder)) of default account"
        } else {
            target = "default folder of default account"
        }
        let html = AppleRules.noteHTML(title: request.title, body: request.body)
        let result = try run("""
                set n to make new note at (\(target)) with properties {body:\(literal(html))}
                return {id of n, name of n, name of container of n}
        """, in: .notes, app: "Notes")
        let row = rows(result).first ?? []
        guard row.count == 3, let id = row[0].stringValue, !id.isEmpty else {
            throw AppleFailure(code: "SAVE_FAILED", message: "Notes did not save the note.")
        }
        return AppleNote(id: id, title: row[1].stringValue ?? "", folder: row[2].stringValue ?? "")
    }
    func removeNote(_ id: String) throws {
        _ = try run("delete note id \(literal(id))", in: .notes, app: "Notes")
    }

    // MARK: Mail

    private func messages(whose clause: String, limit: Int) throws -> [AppleMessage] {
        let result = try run("""
                set found to {}
                repeat with m in (messages of inbox whose \(clause))
                    set end of found to {sender of m, subject of m, date received of m}
                    if (count of found) >= \(limit) then exit repeat
                end repeat
                return found
        """, in: .mail, app: "Mail")
        return rows(result).compactMap { row in
            guard row.count == 3, let received = row[2].dateValue else { return nil }
            return AppleMessage(sender: row[0].stringValue ?? "", subject: row[1].stringValue ?? "", received: received)
        }
    }
    func unreadMail(limit: Int) throws -> [AppleMessage] {
        try messages(whose: "read status is false", limit: max(limit, mailScan))
    }
    func searchMail(_ query: AppleMailQuery) throws -> [AppleMessage] {
        var clauses = [String]()
        if let from = query.from { clauses.append("(sender contains \(literal(from)))") }
        if let subject = query.subject { clauses.append("(subject contains \(literal(subject)))") }
        if let since = query.since {
            // A relative date: AppleScript's date literals depend on the user's locale.
            clauses.append("(date received >= ((current date) - \(Int(max(0, Date().timeIntervalSince(since))))))")
        }
        return try messages(whose: clauses.joined(separator: " and "), limit: mailScan)
    }
    func addDraft(_ request: AppleDraftRequest) throws -> AppleDraft {
        let recipients = request.to.map { "        make new to recipient at end of to recipients with properties {address:\(literal($0))}" }
        let result = try run("""
                set m to make new outgoing message with properties {subject:\(literal(request.subject)), content:\(literal(request.body)), visible:true}
                tell m
        \(recipients.joined(separator: "\n"))
                end tell
                try
                    save m
                end try
                return {id of m, subject of m, count of to recipients of m}
        """, in: .mail, app: "Mail")
        let row = rows(result).first ?? []
        guard row.count == 3, let id = row[0].stringValue, !id.isEmpty else {
            throw AppleFailure(code: "SAVE_FAILED", message: "Mail did not create the draft.")
        }
        return AppleDraft(id: id, subject: row[1].stringValue ?? "", recipients: Int(row[2].int32Value))
    }
    func removeDraft(_ id: String) throws {
        guard let number = Int(id) else { throw AppleFailure(code: "NOT_FOUND", message: "The draft is no longer there.") }
        _ = try run("delete outgoing message id \(number)", in: .mail, app: "Mail")
    }
}

@main struct AppleMain {
    static func main() async {
        let arguments = Array(CommandLine.arguments.dropFirst())
        let store = LiveAppleStore()
        switch arguments.first {
        case nil:
            let server = AppleServer(store: store)
            while let line = readLine(strippingNewline: true) {
                if let reply = server.handle(line: line) {
                    FileHandle.standardOutput.write((reply + "\n").data(using: .utf8)!)
                }
            }
            exit(0)
        case "status":
            emit(["access": store.report()])
            exit(0)
        case "request":
            guard let consent = arguments.dropFirst().first.flatMap(AppleConsent.init(rawValue:)) else {
                emit(["error": "BAD_CONSENT"])
                exit(64)
            }
            // A prompt nobody answers must not hold Settings forever.
            DispatchQueue.global().asyncAfter(deadline: .now() + 120) {
                emit(["access": store.report()])
                exit(0)
            }
            await store.request(consent)
            emit(["access": store.report()])
            exit(0)
        default:
            emit(["error": "Unknown apple command."])
            exit(64)
        }
    }
}
