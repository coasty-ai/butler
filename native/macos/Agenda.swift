import EventKit
import Foundation

/**
 coarena-agenda: reads the user's calendar and reminders, with their permission,
 for the model's "what needs doing" context. One command per process, one JSON
 object on stdout, then exit:

   status   which of Calendar and Reminders access is granted (never prompts)
   request  asks macOS for access (the only command that can show a prompt)
   read     upcoming events and pressing reminders as short lines

 Titles, times, calendar and list names only: never notes, locations, attendees
 or URLs. Its own bundle identity carries the usage strings, so granting it
 changes nothing about the controller's Screen Recording or Accessibility
 grants (docs/PRIVACY.md).

 The automation benchmark's long suite (docs/BENCHMARK.md) adds commands that
 write, bounded by the pure rules in AgendaRules.swift so that nothing of the
 user's can be touched: only items whose title carries a benchmark marker
 ("benchnote" plus four base-36 characters), added only to the OpenAssistBench
 calendar and list the helper itself creates in the local, non-syncing source,
 and removed elsewhere only when the attempt provably made them.

   setup                    create the OpenAssistBench calendar and/or list, per granted store (NO_LOCAL_SOURCE if none)
   find <token> [wide]      every event within 45 days (wide: two years) and every reminder titled with the token
   add <json>               one event or reminder titled with a marker, into those containers
   remove <token> [<start>] delete the token's items in those containers, and elsewhere only the ones created
                            since <start> (ISO 8601) with no attendees and no repetition; count the rest as foreign
   teardown                 delete the two containers, if they hold only marker-titled items

 The app never calls these; they exist for the benchmark harness.
 */
@main struct AgendaMain {
    static func access(_ type: EKEntityType) -> String {
        switch EKEventStore.authorizationStatus(for: type) {
        case .fullAccess: return "granted"
        case .writeOnly: return "writeOnly"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "notDetermined"
        @unknown default: return "unknown"
        }
    }
    static func emit(_ object: [String: Any]) -> Never {
        if let data = try? JSONSerialization.data(withJSONObject: object) {
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data([10]))
        }
        exit(0)
    }
    static func status() -> [String: Any] {
        ["access": ["calendar": access(.event), "reminders": access(.reminder)]]
    }
    static func failure(_ code: String) -> Never {
        emit(status().merging(["error": code]) { _, new in new })
    }

    // MARK: benchmark containers

    /// The benchmark's calendar or list, in the local source only.
    static func benchContainer(_ store: EKEventStore, _ type: EKEntityType) -> EKCalendar? {
        store.calendars(for: type).first {
            $0.title == benchContainerName && $0.source?.sourceType == .local
        }
    }
    /// The benchmark's container for one kind of item, made in the local source when
    /// missing. nil without a local source. One kind at a time: each needs its own
    /// grant, and a reminders-only grant must still be able to add a reminder.
    static func ensureBenchContainer(_ store: EKEventStore, _ type: EKEntityType) throws -> EKCalendar? {
        if let existing = benchContainer(store, type) { return existing }
        guard let local = store.sources.first(where: { $0.sourceType == .local }) else { return nil }
        let calendar = EKCalendar(for: type, eventStore: store)
        calendar.title = benchContainerName
        calendar.source = local
        try store.saveCalendar(calendar, commit: true)
        return calendar
    }
    static func entityType(_ kind: BenchAgendaItem.Kind) -> EKEntityType {
        kind == .event ? .event : .reminder
    }

    // MARK: benchmark items

    static func benchEvents(_ store: EKEventStore, days: Int = benchFindDays) -> [EKEvent] {
        guard access(.event) == "granted" else { return [] }
        let now = Date()
        let span = Double(days) * 86_400
        let predicate = store.predicateForEvents(withStart: now.addingTimeInterval(-span),
                                                 end: now.addingTimeInterval(span), calendars: nil)
        return store.events(matching: predicate)
    }
    static func benchReminders(_ store: EKEventStore) async -> [EKReminder] {
        guard access(.reminder) == "granted" else { return [] }
        // Completed reminders included: a completion task must see the completed one.
        let predicate = store.predicateForReminders(in: nil)
        return await withCheckedContinuation { continuation in
            store.fetchReminders(matching: predicate) { continuation.resume(returning: $0 ?? []) }
        }
    }
    /// The container as the grader sees it: a synced calendar that happens to share
    /// the benchmark's name is not the benchmark's container.
    static func container(_ calendar: EKCalendar?) -> String {
        benchCalendarLabel(calendar?.title ?? "", local: calendar?.source?.sourceType == .local)
    }
    static func item(_ event: EKEvent) -> BenchAgendaItem {
        BenchAgendaItem(kind: .event, title: event.title ?? "", start: event.startDate, end: event.endDate,
                        allDay: event.isAllDay, calendar: container(event.calendar),
                        recurring: event.hasRecurrenceRules)
    }
    static func item(_ reminder: EKReminder) -> BenchAgendaItem {
        BenchAgendaItem(kind: .reminder, title: reminder.title ?? "",
                        due: reminder.dueDateComponents.flatMap { Calendar.current.date(from: $0) },
                        completed: reminder.isCompleted, calendar: container(reminder.calendar),
                        recurring: reminder.hasRecurrenceRules)
    }
    /// What the removal rule needs to know about one item, read from EventKit.
    static func facts(_ item: EKCalendarItem, detached: Bool = false) -> BenchItemFacts {
        BenchItemFacts(inBenchContainer: container(item.calendar) == benchContainerName,
                       created: item.creationDate, hasAttendees: item.hasAttendees,
                       recurring: item.hasRecurrenceRules, detached: detached)
    }
    /// Every event within `days` and every reminder whose title carries the token, with the
    /// store objects for removal. Unbounded: callers that print cap it with benchFindCap.
    static func benchFind(_ store: EKEventStore, token: String,
                          days: Int = benchFindDays) async -> (events: [EKEvent], reminders: [EKReminder]) {
        let events = benchEvents(store, days: days).filter { benchTitleCarries($0.title ?? "", token: token) }
        let reminders = await benchReminders(store).filter { benchTitleCarries($0.title ?? "", token: token) }
        return (events, reminders)
    }
    static func tokenArgument() -> String {
        let token = CommandLine.arguments.dropFirst(2).first ?? ""
        guard benchMarker(token) else { failure("BAD_TOKEN") }
        return token
    }

    static func main() async {
        let command = CommandLine.arguments.dropFirst().first ?? "status"
        let store = EKEventStore()
        switch command {
        case "status":
            emit(status())
        case "request":
            _ = try? await store.requestFullAccessToEvents()
            _ = try? await store.requestFullAccessToReminders()
            emit(status())
        case "read":
            let now = Date()
            var lines = [String: [String]]()
            if access(.event) == "granted" {
                let calendar = Calendar.current
                let end = calendar.date(byAdding: .day, value: agendaEventDays,
                                        to: calendar.startOfDay(for: now)) ?? now.addingTimeInterval(172_800)
                let predicate = store.predicateForEvents(withStart: now.addingTimeInterval(-43_200), end: end, calendars: nil)
                let events = store.events(matching: predicate).map {
                    AgendaEvent(title: $0.title ?? "", start: $0.startDate, end: $0.endDate,
                                allDay: $0.isAllDay, calendar: $0.calendar?.title ?? "")
                }
                lines["events"] = upcomingEvents(events, now: now).map { agendaEventLine($0, now: now) }
            }
            if access(.reminder) == "granted" {
                let predicate = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: nil)
                let reminders: [AgendaReminder] = await withCheckedContinuation { continuation in
                    store.fetchReminders(matching: predicate) { found in
                        continuation.resume(returning: (found ?? []).prefix(500).map {
                            AgendaReminder(title: $0.title ?? "",
                                           due: $0.dueDateComponents.flatMap { Calendar.current.date(from: $0) },
                                           list: $0.calendar?.title ?? "",
                                           priority: $0.priority)
                        })
                    }
                }
                lines["reminders"] = pressingReminders(reminders, now: now).map { agendaReminderLine($0, now: now) }
            }
            emit(status().merging(lines.mapValues { $0 as Any }) { _, lines in lines })

        // Benchmark commands. Each one refuses before EventKit sees anything
        // outside the marker namespace.
        case "setup":
            // Whichever stores are granted; a store without a grant is left alone.
            let granted = [(EKEntityType.event, "calendar"), (EKEntityType.reminder, "reminders")]
                .filter { access($0.0) == "granted" }
            guard !granted.isEmpty else { failure("NO_ACCESS") }
            var made = [String: String]()
            do {
                for (type, key) in granted {
                    guard let container = try ensureBenchContainer(store, type) else { failure("NO_LOCAL_SOURCE") }
                    made[key] = container.title
                }
            } catch { failure("SETUP_FAILED") }
            emit(status().merging(["containers": made]) { _, new in new })
        case "find":
            let token = tokenArgument()
            // "wide" is cleanup's verification: as far either side as EventKit searches.
            let wide = CommandLine.arguments.dropFirst(3).first == "wide"
            let found = await benchFind(store, token: token, days: wide ? benchWideDays : benchFindDays)
            let cap = benchFindCap(events: found.events.count, reminders: found.reminders.count)
            let items = found.events.prefix(cap.events).map(item) + found.reminders.prefix(cap.reminders).map(item)
            emit(status().merging(["items": items.map { benchItemObject($0) }]) { _, new in new })
        case "add":
            guard let payload = CommandLine.arguments.dropFirst(2).first,
                  let request = parseBenchAdd(payload) else { failure("BAD_ITEM") }
            guard access(entityType(request.kind)) == "granted" else { failure("NO_ACCESS") }
            do {
                guard let container = try ensureBenchContainer(store, entityType(request.kind)) else {
                    failure("NO_LOCAL_SOURCE")
                }
                switch request.kind {
                case .event:
                    let event = EKEvent(eventStore: store)
                    event.title = request.title
                    event.startDate = request.start
                    event.endDate = request.end
                    event.isAllDay = request.allDay
                    event.calendar = container
                    try store.save(event, span: .thisEvent, commit: true)
                case .reminder:
                    let reminder = EKReminder(eventStore: store)
                    reminder.title = request.title
                    reminder.calendar = container
                    if let due = request.due {
                        reminder.dueDateComponents = Calendar.current.dateComponents(
                            [.year, .month, .day, .hour, .minute], from: due)
                    }
                    try store.save(reminder, commit: true)
                }
                emit(["added": request.kind.rawValue])
            } catch { failure("ADD_FAILED") }
        case "remove":
            let token = tokenArgument()
            // When the attempt started. Without it nothing outside the benchmark's own
            // containers can be shown to be the attempt's, so all of it is kept.
            let startText = CommandLine.arguments.dropFirst(3).first
            let start = startText.flatMap(benchDate)
            if startText != nil && start == nil { failure("BAD_START") }
            let found = await benchFind(store, token: token, days: benchWideDays)
            var removed = 0, foreign = 0
            var series = Set<String>()
            do {
                for event in found.events {
                    switch benchRemoval(facts(event, detached: event.isDetached), attemptStart: start) {
                    case .keep:
                        foreign += 1
                    case .remove:
                        try store.remove(event, span: .thisEvent, commit: false)
                        removed += 1
                    case .removeSeries:
                        // Occurrences share the identifier; the first occurrence with
                        // .futureEvents removes the whole series, not just this window.
                        guard let id = event.eventIdentifier, series.insert(id).inserted else { continue }
                        try store.remove(store.event(withIdentifier: id) ?? event, span: .futureEvents, commit: false)
                        removed += 1
                    }
                }
                for reminder in found.reminders {
                    if benchRemoval(facts(reminder), attemptStart: start) == .keep { foreign += 1; continue }
                    try store.remove(reminder, commit: false)
                    removed += 1
                }
                try store.commit()
            } catch { failure("REMOVE_FAILED") }
            emit(["removed": removed, "foreign": foreign])
        case "teardown":
            // Only a container that holds nothing but marker-titled items goes; a
            // store without a grant is left alone (benchEvents/benchReminders read
            // nothing without one, so its container would look empty).
            var removed = [String: Bool]()
            do {
                if access(.event) == "granted", let calendar = benchContainer(store, .event) {
                    // Two years each way is the widest window EventKit searches; a
                    // container this helper made holds nothing older.
                    let titles = benchEvents(store, days: benchWideDays).filter { $0.calendar == calendar }.map { $0.title ?? "" }
                    guard benchContainerRemovable(titles: titles) else { failure("CONTAINER_HOLDS_USER_ITEMS") }
                    try store.removeCalendar(calendar, commit: true)
                    removed["calendar"] = true
                }
                if access(.reminder) == "granted", let list = benchContainer(store, .reminder) {
                    let titles = await benchReminders(store).filter { $0.calendar == list }.map { $0.title ?? "" }
                    guard benchContainerRemovable(titles: titles) else { failure("CONTAINER_HOLDS_USER_ITEMS") }
                    try store.removeCalendar(list, commit: true)
                    removed["reminders"] = true
                }
            } catch { failure("TEARDOWN_FAILED") }
            emit(status().merging(["removed": removed]) { _, new in new })
        default:
            emit(["error": "Unknown agenda command."])
        }
    }
}
