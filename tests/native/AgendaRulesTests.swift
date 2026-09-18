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

    benchAgendaChecks(check)
}

// The benchmark's write commands (setup/find/add/remove/teardown): what they may touch.
func benchAgendaChecks(_ check: (Bool, String) -> Void) {
    // benchMarker: the exact token shape, nothing looser.
    check(benchMarker("benchnote0a9z"), "a benchmark token is a marker")
    for bad in ["", "benchnote", "benchnote0a9", "benchnote0a9zz", "Benchnote0a9z", "benchnote0A9Z",
                "xbenchnote0a9z", "benchnote0a9z ", "benchnote0a-z", "benchnote*", "benchnote.*"] {
        check(!benchMarker(bad), "not a marker: \(bad)")
    }

    // benchTitled: the marker as a word of its own, in any case.
    check(benchTitled("benchnote0a9z sync"), "a marker at the start is a bench title")
    check(benchTitled("Benchnote0a9z water the plants"), "Reminders' capital first letter still counts")
    check(benchTitled("Call about benchnote0a9z-report"), "a marker followed by punctuation counts")
    check(!benchTitled("Dentist"), "a user's title is not a bench title")
    check(!benchTitled("mybenchnote0a9z"), "a marker glued to a longer word is not one")
    check(!benchTitled("benchnote0a9zq"), "five characters after the prefix is not a marker")

    // benchTitleCarries: find and remove match only the token they were given.
    check(benchTitleCarries("Benchnote0a9z sync", token: "benchnote0a9z"), "the token is found in any case")
    check(!benchTitleCarries("benchnote0a9y sync", token: "benchnote0a9z"), "another attempt's token is not this one")
    check(!benchTitleCarries("anything", token: ""), "an empty token matches nothing")
    check(!benchTitleCarries("Weekly sync", token: "sync"), "a token that is not a marker matches nothing")

    // parseBenchAdd: only a marker-titled item with sane times gets through.
    let event = parseBenchAdd(#"{"kind":"event","title":"benchnote0a9z sync","start":"2026-09-19T10:00:00.000Z","end":"2026-09-19T11:00:00Z"}"#)
    check(event?.kind == .event && event?.title == "benchnote0a9z sync", "an event add parses")
    check(event.map { $0.end!.timeIntervalSince($0.start!) } == 3600, "fractional and plain ISO times both parse")
    check(event?.allDay == false, "allDay defaults to false")
    let reminder = parseBenchAdd(#"{"kind":"reminder","title":"benchnote0a9z water the plants","due":"2026-09-18T09:00:00Z"}"#)
    check(reminder?.kind == .reminder && reminder?.due != nil, "a reminder add parses")
    check(parseBenchAdd(#"{"kind":"reminder","title":"benchnote0a9z undated"}"#)?.due == nil, "a reminder may be undated")
    check(parseBenchAdd(#"{"kind":"event","title":"Dentist","start":"2026-09-19T10:00:00Z","end":"2026-09-19T11:00:00Z"}"#) == nil,
          "an add without a marker is refused")
    check(parseBenchAdd(#"{"kind":"event","title":"benchnote0a9z","start":"2026-09-19T11:00:00Z","end":"2026-09-19T10:00:00Z"}"#) == nil,
          "an event that ends before it starts is refused")
    check(parseBenchAdd(#"{"kind":"event","title":"benchnote0a9z","start":"tomorrow"}"#) == nil, "an event without parsable times is refused")
    check(parseBenchAdd(#"{"kind":"reminder","title":"benchnote0a9z","due":"soon"}"#) == nil, "an unparsable due date is refused")
    check(parseBenchAdd(#"{"kind":"note","title":"benchnote0a9z"}"#) == nil, "an unknown kind is refused")
    check(parseBenchAdd(#"["benchnote0a9z"]"#) == nil, "a payload that is not an object is refused")
    check(parseBenchAdd("not json") == nil, "malformed JSON is refused")
    let longTitle = String(repeating: "x", count: agendaTitleLimit) + " benchnote0a9z"
    check(parseBenchAdd(#"{"kind":"reminder","title":"\#(longTitle)"}"#) == nil,
          "a marker the length limit would cut off is refused, so cleanup can always find what was added")

    // benchItemObject: kind, title, times with the zone's offset, container; nothing else.
    let tokyo = TimeZone(identifier: "Asia/Tokyo")!
    let printed = benchItemObject(event!, timeZone: tokyo)
    check(printed["start"] as? String == "2026-09-19T19:00:00+09:00", "event times carry the local offset")
    check(Set(printed.keys) == ["kind", "title", "calendar", "recurring", "start", "end", "allDay"],
          "an event prints only its bounded fields")
    check(printed["recurring"] as? Bool == false, "a one-off event says it does not repeat")
    var weekly = event!
    weekly.recurring = true
    check(benchItemObject(weekly)["recurring"] as? Bool == true, "a repeating event says so")
    var done = reminder!
    done.completed = true
    let printedReminder = benchItemObject(done, timeZone: tokyo)
    check(printedReminder["completed"] as? Bool == true && printedReminder["due"] as? String == "2026-09-18T18:00:00+09:00",
          "a reminder prints its due date and completion")
    check(Set(printedReminder.keys) == ["kind", "title", "calendar", "recurring", "due", "completed"],
          "a reminder prints only its bounded fields")

    // benchRemoval: the title alone never makes an item the benchmark's to delete.
    let start = benchDate("2026-09-18T12:00:00Z")!
    let after = start.addingTimeInterval(90), before = start.addingTimeInterval(-86_400)
    check(benchRemoval(BenchItemFacts(inBenchContainer: true, created: before), attemptStart: start) == .remove,
          "anything carrying the token in the benchmark's own container goes")
    check(benchRemoval(BenchItemFacts(inBenchContainer: true, created: nil), attemptStart: nil) == .remove,
          "the benchmark's container is cleared even without a start time")
    check(benchRemoval(BenchItemFacts(inBenchContainer: true, created: after, recurring: true), attemptStart: start) == .removeSeries,
          "a repeating event in the benchmark's container goes as a whole series, not one window of it")
    check(benchRemoval(BenchItemFacts(inBenchContainer: false, created: after), attemptStart: start) == .remove,
          "an item this attempt made in another calendar or list goes")
    check(benchRemoval(BenchItemFacts(inBenchContainer: false, created: start), attemptStart: start) == .remove,
          "made at the very moment the attempt started still counts as the attempt's")
    check(benchRemoval(BenchItemFacts(inBenchContainer: false, created: before), attemptStart: start) == .keep,
          "a user's older item the model typed the token into is kept, not deleted")
    check(benchRemoval(BenchItemFacts(inBenchContainer: false, created: nil), attemptStart: start) == .keep,
          "an item with no creation date cannot be shown to be the attempt's")
    check(benchRemoval(BenchItemFacts(inBenchContainer: false, created: after), attemptStart: nil) == .keep,
          "without a start time nothing outside the benchmark's container goes")
    check(benchRemoval(BenchItemFacts(inBenchContainer: false, created: after, hasAttendees: true), attemptStart: start) == .keep,
          "an event with attendees is kept: removing it would send them cancellations")
    check(benchRemoval(BenchItemFacts(inBenchContainer: false, created: after, recurring: true), attemptStart: start) == .keep,
          "a repeating item outside the benchmark's container is kept for a person to check")
    check(benchRemoval(BenchItemFacts(inBenchContainer: false, created: after, detached: true), attemptStart: start) == .keep,
          "one occurrence split off a user's series is kept")

    // benchFindCap: a repeating event cannot push every reminder out of find's answer.
    check(benchFindCap(events: 200, reminders: 3) == (benchFindEventLimit, 3), "events are capped, reminders still listed")
    check(benchFindCap(events: 2, reminders: 200) == (2, benchFindLimit - 2), "reminders fill the rest")
    check(benchFindCap(events: 0, reminders: 0) == (0, 0), "nothing found, nothing listed")
    check(benchWideDays * 2 <= 4 * 366, "the wide window is within EventKit's four-year span")

    // benchCalendarLabel: only the local container reads as the benchmark's.
    check(benchCalendarLabel(benchContainerName, local: true) == "OpenAssistBench", "the local container keeps its name")
    check(benchCalendarLabel(benchContainerName, local: false) == "OpenAssistBench (synced)",
          "a synced calendar with the same name does not pass for the benchmark's")
    check(benchCalendarLabel("Work", local: false) == "Work", "other calendars read as themselves")

    // benchContainerRemovable: teardown never deletes a container holding a user's item.
    check(benchContainerRemovable(titles: []), "an empty container may go")
    check(benchContainerRemovable(titles: ["benchnote0a9z sync", "Benchnote1b2c water"]), "a container of bench items may go")
    check(!benchContainerRemovable(titles: ["benchnote0a9z sync", "Dentist"]), "a container holding a user's item stays")
}
