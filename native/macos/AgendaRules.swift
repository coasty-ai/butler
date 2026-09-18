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
