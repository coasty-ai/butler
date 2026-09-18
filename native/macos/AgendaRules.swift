import Foundation

/**
 What the user needs to get done.

 The agent knows what is on screen and what it did before; it did not know what
 is on the user's plate. Calendar events and open reminders are the user's own
 list of that, so with their permission the agenda helper reads a short window
 of them: the rest of today and tomorrow's events, and reminders that are due
 soon, overdue, or undated. These are the pure rules for what is kept and how
 it reads; Agenda.swift does the EventKit reads (docs/PRIVACY.md).
 */

let agendaEventLimit = 8
let agendaReminderLimit = 10
let agendaTitleLimit = 100
// Events from now to the end of tomorrow: enough to plan a day, not a month.
let agendaEventDays = 2
// Reminders due within this many days, plus every overdue and undated one.
let agendaReminderDays = 7

struct AgendaEvent {
    let title: String
    let start: Date
    let end: Date
    let allDay: Bool
    let calendar: String
}
struct AgendaReminder {
    let title: String
    let due: Date?
    let list: String
    let priority: Int // EventKit: 0 none, 1 high … 9 low
}

/**
 Events still ahead of `now` (an event in progress counts), earliest first,
 bounded. An event that has already ended is not something to get done.
 */
func upcomingEvents(_ events: [AgendaEvent], now: Date, limit: Int = agendaEventLimit) -> [AgendaEvent] {
    Array(events.filter { $0.end > now && !$0.title.trimmingCharacters(in: .whitespaces).isEmpty }
        .sorted { $0.start < $1.start }
        .prefix(limit))
}

/**
 Open reminders worth knowing about, most pressing first: overdue, then due
 soon by date, then undated ones by priority. Reminders due beyond the window
 are left out; an undated reminder has no date to be far away.
 */
func pressingReminders(_ reminders: [AgendaReminder], now: Date,
                       horizonDays: Int = agendaReminderDays,
                       limit: Int = agendaReminderLimit) -> [AgendaReminder] {
    let horizon = now.addingTimeInterval(Double(horizonDays) * 86_400)
    let kept = reminders.filter { reminder in
        guard !reminder.title.trimmingCharacters(in: .whitespaces).isEmpty else { return false }
        guard let due = reminder.due else { return true }
        return due <= horizon
    }
    // EventKit priority 0 means none; it ranks after any set priority.
    let rank = { (priority: Int) -> Int in priority == 0 ? 10 : priority }
    return Array(kept.sorted { a, b in
        switch (a.due, b.due) {
        case let (x?, y?): return x < y
        case (_?, nil): return true
        case (nil, _?): return false
        case (nil, nil): return rank(a.priority) < rank(b.priority)
        }
    }.prefix(limit))
}

private func clock(_ date: Date, calendar: Calendar) -> String {
    let hour = calendar.component(.hour, from: date), minute = calendar.component(.minute, from: date)
    let twelve = hour % 12 == 0 ? 12 : hour % 12
    let suffix = hour < 12 ? "AM" : "PM"
    return minute == 0 ? "\(twelve) \(suffix)" : String(format: "%d:%02d %@", twelve, minute, suffix)
}
private func dayWord(_ date: Date, now: Date, calendar: Calendar) -> String {
    if calendar.isDate(date, inSameDayAs: now) { return "Today" }
    if let tomorrow = calendar.date(byAdding: .day, value: 1, to: now), calendar.isDate(date, inSameDayAs: tomorrow) { return "Tomorrow" }
    if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) { return "Yesterday" }
    let formatter = DateFormatter()
    formatter.calendar = calendar; formatter.timeZone = calendar.timeZone
    formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.dateFormat = "EEE MMM d"
    return formatter.string(from: date)
}

/**
 One event as the model reads it: when, what, and which calendar ("Today 3 PM–
 3:30 PM: Standup (Work)"). Local wall-clock time in words the model can repeat
 to the user; an event already running says so.
 */
func agendaEventLine(_ event: AgendaEvent, now: Date, calendar: Calendar = .current) -> String {
    let title = String(event.title.trimmingCharacters(in: .whitespaces).prefix(agendaTitleLimit))
    let when: String
    if event.allDay { when = "\(dayWord(event.start, now: now, calendar: calendar)), all day" }
    else if event.start <= now { when = "Now until \(clock(event.end, calendar: calendar))" }
    else { when = "\(dayWord(event.start, now: now, calendar: calendar)) \(clock(event.start, calendar: calendar))–\(clock(event.end, calendar: calendar))" }
    let source = event.calendar.trimmingCharacters(in: .whitespaces)
    return source.isEmpty ? "\(when): \(title)" : "\(when): \(title) (\(String(source.prefix(40))))"
}

/**
 One reminder as the model reads it: its title, when it is due or that it is
 overdue, and its list ("Send the deck to Prateek — overdue since Yesterday
 (Work)").
 */
func agendaReminderLine(_ reminder: AgendaReminder, now: Date, calendar: Calendar = .current) -> String {
    var line = String(reminder.title.trimmingCharacters(in: .whitespaces).prefix(agendaTitleLimit))
    if let due = reminder.due {
        line += due < now ? " — overdue since \(dayWord(due, now: now, calendar: calendar))"
                          : " — due \(dayWord(due, now: now, calendar: calendar))"
    }
    if reminder.priority >= 1 && reminder.priority <= 4 { line += ", high priority" }
    let list = reminder.list.trimmingCharacters(in: .whitespaces)
    return list.isEmpty ? line : "\(line) (\(String(list.prefix(40))))"
}

// MARK: - Benchmark items (docs/BENCHMARK.md)

/*
 The automation benchmark's long suite creates and removes calendar events and
 reminders through this helper. These pure rules bound what the helper may
 touch: it adds only an item whose title carries a benchmark marker, only into
 the containers it made in the local (non-syncing) source, and it removes only
 items whose title carries the marker it was given. A marker is "benchnote"
 plus four base-36 characters, a shape nothing of the user's is ever named in,
 which is what makes writing and deleting safe. Every command checks these
 rules before EventKit sees a request.
 */

/// The calendar and the reminders list the benchmark owns, in the local source.
let benchContainerName = "OpenAssistBench"
/// Events are searched this many days either side of now; EventKit needs a window.
let benchFindDays = 45
/// Removal, its verification and teardown search two years each way: EventKit
/// shortens any predicate to four years, so this is as far as it can see. An
/// event the model put months away, or a series it set to repeat, is still found.
let benchWideDays = 730
/// `find` returns at most this many items; an attempt makes one or two.
let benchFindLimit = 50
/// Events take at most this many of those rows, so a repeating event cannot
/// crowd every reminder out of the answer.
let benchFindEventLimit = 25

/// A benchmark token exactly: lowercase, one word, nothing else.
func benchMarker(_ token: String) -> Bool {
    token.range(of: "^benchnote[0-9a-z]{4}$", options: .regularExpression) != nil
}

/// A title the benchmark wrote or asked for: it carries a marker as a word of
/// its own, in any case, because Reminders capitalises the first letter.
func benchTitled(_ title: String) -> Bool {
    title.range(of: "(^|[^0-9a-z])benchnote[0-9a-z]{4}([^0-9a-z]|$)",
                options: [.regularExpression, .caseInsensitive]) != nil
}

/// The title carries this token (case-insensitive); false for a token that is not a marker.
func benchTitleCarries(_ title: String, token: String) -> Bool {
    benchMarker(token) && title.range(of: token, options: .caseInsensitive) != nil
}

struct BenchAgendaItem {
    enum Kind: String { case event, reminder }
    let kind: Kind
    let title: String
    var start: Date? = nil
    var end: Date? = nil
    var allDay = false
    var due: Date? = nil
    var completed = false
    var calendar = ""
    var recurring = false
}

/**
 What `remove` may do with one item whose title carries the token. The title
 alone does not make an item the benchmark's: a model that clicks into the
 user's "Buy milk" row and types the token has put the token on the user's
 reminder, possibly in a shared list. So only the benchmark's own local
 container is cleared outright; anywhere else an item goes only when this
 attempt made it (created at or after the attempt started), it invites nobody
 (removing an event with attendees sends them cancellations) and it does not
 repeat or belong to a series (removing one occurrence of the user's series,
 or a series the user owns, is not ours to do). Everything else is kept and
 counted, so a person checks it.
 */
struct BenchItemFacts {
    /// The item is in a local container named OpenAssistBench (benchCalendarLabel).
    var inBenchContainer: Bool
    var created: Date?
    var hasAttendees = false
    var recurring = false
    /// An occurrence edited apart from its series.
    var detached = false
}
enum BenchRemoval: Equatable {
    /// Remove this item (one occurrence of an event).
    case remove
    /// Remove the whole series from its first occurrence.
    case removeSeries
    /// Not provably this attempt's: leave it and count it as foreign.
    case keep
}
func benchRemoval(_ item: BenchItemFacts, attemptStart: Date?) -> BenchRemoval {
    if item.inBenchContainer { return item.recurring || item.detached ? .removeSeries : .remove }
    guard let start = attemptStart, let created = item.created, created >= start,
          !item.hasAttendees, !item.recurring, !item.detached else { return .keep }
    return .remove
}

/// `find` rows: at most benchFindEventLimit events, then reminders up to benchFindLimit in all.
func benchFindCap(events: Int, reminders: Int) -> (events: Int, reminders: Int) {
    let keptEvents = min(events, benchFindEventLimit)
    return (keptEvents, min(reminders, benchFindLimit - keptEvents))
}

/// ISO 8601 with an offset, fractional seconds allowed ("2026-09-19T15:00:00.000Z").
func benchDate(_ text: String) -> Date? {
    let precise = ISO8601DateFormatter()
    precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = precise.date(from: text) { return date }
    let plain = ISO8601DateFormatter()
    plain.formatOptions = [.withInternetDateTime]
    return plain.date(from: text)
}

/// ISO 8601 with the zone's offset, so the grader sees local wall-clock time.
func benchDateString(_ date: Date, timeZone: TimeZone = .current) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    formatter.timeZone = timeZone
    return formatter.string(from: date)
}

/**
 An `add` payload as the harness sends it, checked field by field. nil when
 the JSON is not an object, the kind is unknown, the title does not carry a
 marker, an event lacks a parsable start or end or ends before it starts, or
 a reminder's due date does not parse. Nothing else is read from the payload.
 */
func parseBenchAdd(_ json: String) -> BenchAgendaItem? {
    guard let data = json.data(using: .utf8),
          let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let kind = (object["kind"] as? String).flatMap(BenchAgendaItem.Kind.init(rawValue:)),
          let title = object["title"] as? String else { return nil }
    // The marker is checked on the title as it will be saved: one cut past the
    // limit would lose it, and cleanup could never find the item again.
    let trimmed = String(title.trimmingCharacters(in: .whitespaces).prefix(agendaTitleLimit))
    guard benchTitled(trimmed) else { return nil }
    switch kind {
    case .event:
        guard let start = (object["start"] as? String).flatMap(benchDate),
              let end = (object["end"] as? String).flatMap(benchDate), end > start else { return nil }
        return BenchAgendaItem(kind: .event, title: trimmed, start: start, end: end,
                               allDay: object["allDay"] as? Bool ?? false)
    case .reminder:
        var due: Date? = nil
        if let text = object["due"] as? String {
            guard let parsed = benchDate(text) else { return nil }
            due = parsed
        }
        return BenchAgendaItem(kind: .reminder, title: trimmed, due: due)
    }
}

/// One found item as the helper prints it: kind, title, times, container, whether it
/// repeats. Never notes, locations or attendees.
func benchItemObject(_ item: BenchAgendaItem, timeZone: TimeZone = .current) -> [String: Any] {
    var object: [String: Any] = ["kind": item.kind.rawValue,
                                 "title": String(item.title.prefix(agendaTitleLimit)),
                                 "calendar": String(item.calendar.prefix(100)),
                                 "recurring": item.recurring]
    switch item.kind {
    case .event:
        if let start = item.start { object["start"] = benchDateString(start, timeZone: timeZone) }
        if let end = item.end { object["end"] = benchDateString(end, timeZone: timeZone) }
        object["allDay"] = item.allDay
    case .reminder:
        if let due = item.due { object["due"] = benchDateString(due, timeZone: timeZone) }
        object["completed"] = item.completed
    }
    return object
}

/// A container's name as `find` reports it. Only the benchmark's own local
/// container reads as "OpenAssistBench": a synced calendar that shares the name
/// would pass the grader's calendar check while copying the item to other devices.
func benchCalendarLabel(_ title: String, local: Bool) -> String {
    let name = String(title.prefix(100))
    return name == benchContainerName && !local ? "\(name) (synced)" : name
}

/// Teardown may delete a container only when nothing but bench-titled items are in it.
func benchContainerRemovable(titles: [String]) -> Bool {
    titles.allSatisfy(benchTitled)
}
