import Foundation

// Pure agenda rules in AgendaRules.swift, on a fixed calendar and clock.
func agendaRulesChecks(_ check: (Bool, String) -> Void) {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    func at(_ day: Int, _ hour: Int, _ minute: Int = 0) -> Date {
        calendar.date(from: DateComponents(year: 2026, month: 9, day: day, hour: hour, minute: minute))!
    }
    let now = at(18, 10) // Friday 10 AM

    // upcomingEvents
    let events = [
        AgendaEvent(title: "Breakfast", start: at(18, 8), end: at(18, 9), allDay: false, calendar: "Home"),
        AgendaEvent(title: "Standup", start: at(18, 9, 45), end: at(18, 10, 15), allDay: false, calendar: "Work"),
        AgendaEvent(title: "Review", start: at(19, 15), end: at(19, 16), allDay: false, calendar: "Work"),
        AgendaEvent(title: "Lunch", start: at(18, 12), end: at(18, 13), allDay: false, calendar: ""),
        AgendaEvent(title: "  ", start: at(18, 14), end: at(18, 15), allDay: false, calendar: "Work"),
    ]
    let upcoming = upcomingEvents(events, now: now)
    check(upcoming.map(\.title) == ["Standup", "Lunch", "Review"], "ended and untitled events are dropped, the rest in time order")
    check(upcomingEvents(Array(repeating: events[3], count: 20), now: now).count == agendaEventLimit, "events are bounded")

    // agendaEventLine
    check(agendaEventLine(upcoming[0], now: now, calendar: calendar) == "Now until 10:15 AM: Standup (Work)", "an event in progress says until when")
    check(agendaEventLine(upcoming[1], now: now, calendar: calendar) == "Today 12 PM–1 PM: Lunch", "today's event reads in wall-clock words, no empty calendar")
    check(agendaEventLine(upcoming[2], now: now, calendar: calendar) == "Tomorrow 3 PM–4 PM: Review (Work)", "tomorrow's event is named as tomorrow")
    let allDay = AgendaEvent(title: "Offsite", start: at(18, 0), end: at(19, 0), allDay: true, calendar: "Work")
    check(agendaEventLine(allDay, now: now, calendar: calendar) == "Today, all day: Offsite (Work)", "an all-day event has no times")

    // pressingReminders
    let reminders = [
        AgendaReminder(title: "Someday", due: nil, list: "Ideas", priority: 0),
        AgendaReminder(title: "Send deck", due: at(19, 9), list: "Work", priority: 0),
        AgendaReminder(title: "Pay rent", due: at(16, 9), list: "Home", priority: 1),
        AgendaReminder(title: "Far off", due: at(30, 9), list: "Work", priority: 0),
        AgendaReminder(title: "Urgent undated", due: nil, list: "Work", priority: 1),
        AgendaReminder(title: " ", due: nil, list: "Work", priority: 0),
    ]
    let pressing = pressingReminders(reminders, now: now)
    check(pressing.map(\.title) == ["Pay rent", "Send deck", "Urgent undated", "Someday"],
          "overdue first, then due soon, then undated by priority; far-off and untitled dropped")
    check(pressingReminders(Array(repeating: reminders[0], count: 30), now: now).count == agendaReminderLimit, "reminders are bounded")

    // agendaReminderLine
    check(agendaReminderLine(pressing[0], now: now, calendar: calendar) == "Pay rent — overdue since Wed Sep 16, high priority (Home)",
          "an overdue reminder says since when and its priority")
    check(agendaReminderLine(pressing[1], now: now, calendar: calendar) == "Send deck — due Tomorrow (Work)", "a reminder due soon says when")
    check(agendaReminderLine(pressing[3], now: now, calendar: calendar) == "Someday (Ideas)", "an undated reminder has no date")
    check(agendaReminderLine(AgendaReminder(title: String(repeating: "x", count: 300), due: nil, list: "", priority: 0), now: now, calendar: calendar).count
          == agendaTitleLimit, "reminder titles are bounded")
}
