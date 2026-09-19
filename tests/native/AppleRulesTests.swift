import Foundation

// Pure bridge rules in AppleRules.swift, on a fixed calendar and clock.
func appleRulesChecks(_ check: (Bool, String) -> Void) {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "America/Los_Angeles")!
    func at(_ month: Int, _ day: Int, _ hour: Int = 0, _ minute: Int = 0) -> Date {
        calendar.date(from: DateComponents(year: 2026, month: month, day: day, hour: hour, minute: minute))!
    }
    let clock = AppleClock(now: at(9, 18, 10), calendar: calendar) // Friday 18 September, 10 AM
    func failure(_ body: () throws -> Any) -> String {
        do { _ = try body() } catch let failure as AppleFailure { return failure.code } catch { return "OTHER" }
        return ""
    }
    func message(_ body: () throws -> Any) -> String {
        do { _ = try body() } catch let failure as AppleFailure { return failure.message } catch { return "" }
        return ""
    }

    // Dates: local without an offset, offsets honoured, days that do not exist refused.
    check(AppleRules.date("2026-09-19T18:00", calendar: calendar) == AppleDateArgument(date: at(9, 19, 18), hasTime: true),
          "a local date-time parses in the clock's zone")
    check(AppleRules.date("2026-09-19", calendar: calendar) == AppleDateArgument(date: at(9, 19), hasTime: false), "a day alone has no time")
    check(AppleRules.date("2026-09-19 18:00:30", calendar: calendar)?.date == at(9, 19, 18).addingTimeInterval(30), "a space and seconds are accepted")
    check(AppleRules.date("2026-09-20T01:00:00Z", calendar: calendar)?.date == at(9, 19, 18), "Z is UTC")
    check(AppleRules.date("2026-09-19T21:00:00-04:00", calendar: calendar)?.date == at(9, 19, 18), "an offset is honoured")
    check(AppleRules.date("2026-09-19T21:00:00.250+0300", calendar: calendar) != nil, "fractions and a compact offset parse")
    for bad in ["", "tomorrow", "2026-02-30", "2026-13-01", "2026-09-19T24:00", "2026-09-19T18", "2026-09-19T18:60", "19/09/2026",
                "2026-09-19T18:00+25:00", "2026-09-19T18:00X", "2026-9-19"] {
        check(AppleRules.date(bad, calendar: calendar) == nil, "not a date: \(bad)")
    }

    // Arguments: unknown keys, types, bounds, one line.
    check(failure { try AppleRules.keys(["title": "x", "attendees": []], allowed: ["title"]) } == "BAD_ARGS", "an extra key is refused")
    check(message { try AppleRules.keys(["b": 1, "a": 1], allowed: ["a"]) }.hasPrefix("Unknown argument b."), "the refusal names the key")
    check(failure { try AppleRules.keys([:], allowed: ["title"], required: ["title"]) } == "BAD_ARGS", "a missing required key is refused")
    check(try! AppleRules.text(["title": "  Dentist "], "title", limit: 100) == "Dentist", "text is trimmed")
    check(try! AppleRules.text([:], "title", limit: 100) == nil, "an absent optional text is nil")
    check(failure { try AppleRules.text(["title": 5], "title", limit: 100) as Any } == "BAD_ARGS", "a number is not text")
    check(failure { try AppleRules.text(["title": "  "], "title", limit: 100) as Any } == "BAD_ARGS", "blank text is refused")
    check(failure { try AppleRules.text(["title": String(repeating: "x", count: 101)], "title", limit: 100) as Any } == "BAD_ARGS", "a title over 100 is refused")
    check(failure { try AppleRules.text(["title": "two\nlines"], "title", limit: 100) as Any } == "BAD_ARGS", "a title must be one line")
    check(failure { try AppleRules.text(["title": "two\u{2028}lines"], "title", limit: 100) as Any } == "BAD_ARGS", "a line separator is a line break too")
    check(try! AppleRules.text(["body": "two\nlines\tok"], "body", limit: 4000, oneLine: false) == "two\nlines\tok", "a body keeps its lines and tabs")
    check(failure { try AppleRules.text(["body": "bell\u{07}"], "body", limit: 4000, oneLine: false) as Any } == "BAD_ARGS", "a control character is refused")
    check(try! AppleRules.integer(["limit": 5], "limit", min: 1, max: 20) == 5, "a whole number parses")
    check(failure { try AppleRules.integer(["limit": 2.5], "limit", min: 1, max: 20) as Any } == "BAD_ARGS", "a fraction is not a count")
    check(failure { try AppleRules.integer(["limit": 21], "limit", min: 1, max: 20) as Any } == "BAD_ARGS", "a count above the limit is refused")
    check(failure { try AppleRules.integer(["limit": true], "limit", min: 1, max: 20) as Any } == "BAD_ARGS", "true is not a count")
    check(try! AppleRules.flag(["allDay": true], "allDay") == true, "a flag parses")
    check(failure { try AppleRules.flag(["allDay": 1], "allDay") } == "BAD_ARGS", "1 is not a flag")

    // calendar_list_events range: whole days, ordered, at most 31.
    let range = try! AppleRules.eventRange(["from": "2026-09-18", "to": "2026-09-21"], clock: clock)
    check(range == AppleEventRange(start: at(9, 18), end: at(9, 22)), "a range covers whole local days, end exclusive")
    check(try! AppleRules.eventRange(["from": "2026-09-18", "to": "2026-09-18"], clock: clock).end == at(9, 19), "one day is allowed")
    check(failure { try AppleRules.eventRange(["from": "2026-09-18", "to": "2026-09-17"], clock: clock) } == "BAD_ARGS", "to before from is refused")
    check(failure { try AppleRules.eventRange(["from": "2026-09-01", "to": "2026-10-02"], clock: clock) } == "BAD_ARGS", "32 days are too many")
    check(try! AppleRules.eventRange(["from": "2026-09-01", "to": "2026-10-01"], clock: clock).end == at(10, 2), "31 days are allowed")
    check(failure { try AppleRules.eventRange(["from": "2026-09-18T10:00", "to": "2026-09-18"], clock: clock) } == "BAD_ARGS", "a time in from is refused")
    check(failure { try AppleRules.eventRange(["from": "2026-09-18"], clock: clock) } == "BAD_ARGS", "to is required")

    // calendar_create_event: bounds on title, start, duration; extra keys; all-day.
    let dentist = try! AppleRules.eventRequest(["title": "Dentist", "start": "2026-09-19T18:00"], clock: clock)
    check(dentist == AppleEventRequest(title: "Dentist", start: at(9, 19, 18), end: at(9, 19, 19), allDay: false, calendar: nil),
          "end defaults to an hour after start")
    check(try! AppleRules.eventRequest(["title": "Dentist", "start": "2026-09-19T18:00", "end": "2026-09-19T18:30", "calendar": "Home"], clock: clock).end == at(9, 19, 18, 30),
          "a given end is kept")
    check(failure { try AppleRules.eventRequest(["title": "Dentist", "start": "2026-09-19T18:00", "end": "2026-09-19T18:00"], clock: clock) } == "BAD_ARGS", "a zero duration is refused")
    check(failure { try AppleRules.eventRequest(["title": "Dentist", "start": "2026-09-19T18:00", "end": "2026-09-20T18:01"], clock: clock) } == "BAD_ARGS", "over 24 hours is refused")
    check(try! AppleRules.eventRequest(["title": "Shift", "start": "2026-09-19T18:00", "end": "2026-09-20T18:00"], clock: clock).end == at(9, 20, 18), "exactly 24 hours is allowed")
    check(failure { try AppleRules.eventRequest(["title": "Dentist", "start": "2026-09-16T18:00"], clock: clock) } == "BAD_ARGS", "a start over a day ago is refused")
    check(try! AppleRules.eventRequest(["title": "Late", "start": "2026-09-17T11:00"], clock: clock).start == at(9, 17, 11), "a start within the past day is allowed")
    check(failure { try AppleRules.eventRequest(["title": "Dentist", "start": "2027-09-19T18:00"], clock: clock) } == "BAD_ARGS", "over a year ahead is refused")
    check(failure { try AppleRules.eventRequest(["title": "Dentist", "start": "2026-09-19"], clock: clock) } == "BAD_ARGS", "a timed event needs a time")
    check(failure { try AppleRules.eventRequest(["title": "Dentist", "start": "2026-09-19T18:00", "attendees": ["a@b.c"]], clock: clock) } == "BAD_ARGS", "attendees are refused")
    check(failure { try AppleRules.eventRequest(["title": "Dentist", "start": "2026-09-19T18:00", "url": "https://x"], clock: clock) } == "BAD_ARGS", "a URL is refused")
    check(failure { try AppleRules.eventRequest(["title": "Dentist", "start": "2026-09-19T18:00", "notes": "x"], clock: clock) } == "BAD_ARGS", "notes are refused")
    check(failure { try AppleRules.eventRequest(["title": "Dentist", "start": "2026-09-19T18:00", "allDay": "yes"], clock: clock) } == "BAD_ARGS", "allDay must be a boolean")
    check(failure { try AppleRules.eventRequest(["title": String(repeating: "x", count: 101), "start": "2026-09-19T18:00"], clock: clock) } == "BAD_ARGS", "a long title is refused")
    let offsite = try! AppleRules.eventRequest(["title": "Offsite", "start": "2026-09-21", "allDay": true], clock: clock)
    check(offsite == AppleEventRequest(title: "Offsite", start: at(9, 21), end: at(9, 22), allDay: true, calendar: nil), "an all-day event ends at the next day's start")
    check(try! AppleRules.eventRequest(["title": "Offsite", "start": "2026-09-21T09:00", "end": "2026-09-22", "allDay": true], clock: clock).end == at(9, 23),
          "an all-day end names its last day and a time is dropped")
    check(failure { try AppleRules.eventRequest(["title": "Offsite", "start": "2026-09-21", "end": "2026-10-25", "allDay": true], clock: clock) } == "BAD_ARGS", "an all-day event over 31 days is refused")
    check(failure { try AppleRules.eventRequest(["title": "Offsite", "start": "2026-09-21", "end": "2026-09-20", "allDay": true], clock: clock) } == "BAD_ARGS", "an all-day end before its start is refused")

    // reminders_create / reminders_list.
    let milk = try! AppleRules.reminderRequest(["title": "Buy milk", "due": "2026-09-25", "list": "Groceries"], clock: clock)
    check(milk == AppleReminderRequest(title: "Buy milk", due: at(9, 25), dueHasTime: false, list: "Groceries"), "a reminder due on a day has no time")
    check(try! AppleRules.reminderRequest(["title": "Call", "due": "2026-09-25T09:00"], clock: clock).dueHasTime, "a reminder due at a time keeps it")
    check(try! AppleRules.reminderRequest(["title": "Someday"], clock: clock).due == nil, "a reminder needs no due date")
    check(failure { try AppleRules.reminderRequest(["title": "x", "due": "2025-01-01"], clock: clock) } == "BAD_ARGS", "a due date long past is refused")
    check(failure { try AppleRules.reminderRequest(["title": "x", "priority": 1], clock: clock) } == "BAD_ARGS", "a priority is an extra key")
    let query = try! AppleRules.reminderQuery(["dueBefore": "2026-09-18"], clock: clock)
    check(query == AppleReminderQuery(list: nil, dueBefore: at(9, 19)), "dueBefore a day means before the next day's start")
    check(try! AppleRules.reminderQuery(["dueBefore": "2026-09-18T12:00", "list": "Work"], clock: clock) == AppleReminderQuery(list: "Work", dueBefore: at(9, 18, 12)),
          "dueBefore a time is that instant")
    check(try! AppleRules.reminderQuery([:], clock: clock) == AppleReminderQuery(list: nil, dueBefore: nil), "an empty query lists everything")

    // notes_search / notes_create.
    check(try! AppleRules.notesQuery(["query": "groceries"]) == "groceries", "a query parses")
    check(failure { try AppleRules.notesQuery([:]) } == "BAD_ARGS", "a query is required")
    check(failure { try AppleRules.notesQuery(["query": String(repeating: "q", count: 101)]) } == "BAD_ARGS", "a long query is refused")
    let note = try! AppleRules.noteRequest(["title": "Packing list", "body": "Socks\nCharger"])
    check(note == AppleNoteRequest(title: "Packing list", body: "Socks\nCharger", folder: nil), "a note keeps its body lines")
    check(try! AppleRules.noteRequest(["title": "Packing list"]).body == "", "a body is optional")
    check(try! AppleRules.noteRequest(["title": "t", "body": String(repeating: "b", count: 4000)]).body.count == 4000, "a 4000-character body is allowed")
    check(failure { try AppleRules.noteRequest(["title": "t", "body": String(repeating: "b", count: 4001)]) } == "BAD_ARGS", "a 4001-character body is refused")
    check(failure { try AppleRules.noteRequest(["title": "t", "attachment": "x"]) } == "BAD_ARGS", "an attachment is an extra key")

    // mail_unread / mail_search / mail_draft.
    check(try! AppleRules.mailLimit([:]) == 10, "unread defaults to ten")
    check(try! AppleRules.mailLimit(["limit": 20]) == 20, "twenty is the most")
    check(failure { try AppleRules.mailLimit(["limit": 0]) } == "BAD_ARGS", "zero is refused")
    check(failure { try AppleRules.mailLimit(["limit": 21]) } == "BAD_ARGS", "21 is refused")
    check(try! AppleRules.mailQuery(["from": "dana"], clock: clock) == AppleMailQuery(from: "dana", subject: nil, since: nil), "a sender query parses")
    check(try! AppleRules.mailQuery(["since": "2026-09-17"], clock: clock).since == at(9, 17), "since a day is that day's start")
    check(failure { try AppleRules.mailQuery([:], clock: clock) } == "BAD_ARGS", "an empty mail search is refused")
    check(failure { try AppleRules.mailQuery(["body": "x"], clock: clock) } == "BAD_ARGS", "searching bodies is not offered")
    let draft = try! AppleRules.draftRequest(["to": ["dana@example.com", " bob@example.com "], "subject": "Plan", "body": "Hi"])
    check(draft == AppleDraftRequest(to: ["dana@example.com", "bob@example.com"], subject: "Plan", body: "Hi"), "recipients are trimmed and kept")
    check(try! AppleRules.draftRequest(["to": ["dana@example.com"], "subject": "Plan"]).body == "", "a draft body is optional")
    check(failure { try AppleRules.draftRequest(["to": [], "subject": "Plan"]) } == "BAD_ARGS", "no recipients is refused")
    check(failure { try AppleRules.draftRequest(["to": "dana@example.com", "subject": "Plan"]) } == "BAD_ARGS", "to must be a list")
    check(failure { try AppleRules.draftRequest(["to": ["dana"], "subject": "Plan"]) } == "BAD_ARGS", "a bare name is not an address")
    check(failure { try AppleRules.draftRequest(["to": Array(repeating: "a@b.co", count: 21), "subject": "Plan"]) } == "BAD_ARGS", "21 recipients are too many")
    check(failure { try AppleRules.draftRequest(["to": ["a@b.co"], "subject": "Plan", "cc": ["c@d.co"]]) } == "BAD_ARGS", "cc is an extra key")
    check(failure { try AppleRules.draftRequest(["to": ["a@b.co"], "subject": "Plan", "body": String(repeating: "b", count: 4001)]) } == "BAD_ARGS", "a long draft body is refused")
    check(failure { try AppleRules.draftRequest(["to": ["a@b.co"], "subject": String(repeating: "s", count: 201)]) } == "BAD_ARGS", "a long subject is refused")
    for good in ["dana@example.com", "first.last+tag@sub.example.co.uk", "x@y.io"] { check(AppleRules.mailAddress(good), "an address: \(good)") }
    for bad in ["dana", "dana@example", "@example.com", "dana@.example.com", "dana@example.com.", "dana@exa..mple.com", "dana li@example.com",
                "dana@example.com,bob@example.com", "\"dana\"@example.com", "<dana@example.com>", "dana@exam_ple.com", "dana@example.com\n"] {
        check(!AppleRules.mailAddress(bad), "not an address: \(bad)")
    }

    // undo { token }.
    check(try! AppleRules.undoToken(["token": "undo-1"]) == "undo-1", "a token parses")
    check(failure { try AppleRules.undoToken(["token": "a b"]) } == "BAD_ARGS", "a token with a space is refused")
    check(failure { try AppleRules.undoToken(["token": "x", "force": true]) } == "BAD_ARGS", "force is an extra key")

    // Container choice: exact name, default when unnamed, never subscribed or birthdays.
    let home = AppleContainer(title: "Home", writable: true, isDefault: true, id: "c1")
    let work = AppleContainer(title: "Work", writable: true, id: "c2")
    let birthdays = AppleContainer(title: "Birthdays", writable: false, birthdays: true, id: "c3")
    let holidays = AppleContainer(title: "Holidays", writable: true, subscribed: true, id: "c4")
    let calendars = [work, birthdays, holidays, home]
    check(try! AppleRules.container(named: nil, among: calendars, kind: .calendar) == home, "no name means the default calendar")
    check(try! AppleRules.container(named: "Work", among: calendars, kind: .calendar) == work, "a name matches exactly")
    check(failure { try AppleRules.container(named: "work", among: calendars, kind: .calendar) } == "NO_CALENDAR", "a name in another case does not match")
    check(failure { try AppleRules.container(named: "Gym", among: calendars, kind: .calendar) } == "NO_CALENDAR", "an unknown calendar is refused")
    check(message { try AppleRules.container(named: "Gym", among: calendars, kind: .calendar) } == "The calendar Gym does not exist. Calendars: Home, Work.",
          "the refusal lists the calendars that accept items")
    check(failure { try AppleRules.container(named: "Holidays", among: calendars, kind: .calendar) } == "NO_CALENDAR", "a subscribed calendar is never written")
    check(failure { try AppleRules.container(named: "Birthdays", among: calendars, kind: .calendar) } == "NO_CALENDAR", "the birthdays calendar is never written")
    check(message { try AppleRules.container(named: "Birthdays", among: calendars, kind: .calendar) }.hasPrefix("The calendar Birthdays cannot be changed."),
          "an unwritable calendar says so")
    check(try! AppleRules.container(named: "Holidays", among: calendars, kind: .calendar, forWriting: false) == holidays, "a read may look at a subscribed calendar")
    check(try! AppleRules.container(named: nil, among: [work, birthdays], kind: .calendar) == work, "without a default, the first writable calendar")
    check(failure { try AppleRules.container(named: nil, among: [birthdays, holidays], kind: .list) } == "NO_LIST", "no writable list is a refusal")

    // Duplicates: title, start and container together.
    let saved = AppleEvent(id: "e1", title: "Dentist", start: at(9, 19, 18), end: at(9, 19, 19), allDay: false, calendar: "Home")
    check(AppleRules.duplicate(dentist, in: home, among: [saved]), "the same title and start in the same calendar is a duplicate")
    check(!AppleRules.duplicate(dentist, in: work, among: [saved]), "another calendar is not a duplicate")
    check(!AppleRules.duplicate(dentist, in: home, among: [AppleEvent(id: "e2", title: "Dentist", start: at(9, 19, 17), end: at(9, 19, 18), allDay: false, calendar: "Home")]),
          "another start is not a duplicate")
    check(!AppleRules.duplicate(dentist, in: home, among: [AppleEvent(id: "e3", title: "Dentist visit", start: at(9, 19, 18), end: at(9, 19, 19), allDay: false, calendar: "Home")]),
          "another title is not a duplicate")
    let groceries = AppleContainer(title: "Groceries", writable: true, id: "l1")
    let savedMilk = AppleReminder(id: "r1", title: "Buy milk", due: at(9, 25), list: "Groceries")
    check(AppleRules.duplicate(milk, in: groceries, among: [savedMilk]), "the same reminder title and due date in the list is a duplicate")
    check(!AppleRules.duplicate(milk, in: groceries, among: [AppleReminder(id: "r2", title: "Buy milk", due: nil, list: "Groceries")]), "an undated one is not")

    // Read-back: what came back is what was asked, or READBACK_MISMATCH follows.
    check(AppleRules.matches(dentist, saved, in: home, calendar: calendar), "a faithful read-back matches")
    check(!AppleRules.matches(dentist, AppleEvent(id: "e1", title: "Dentist (drifted)", start: at(9, 19, 18), end: at(9, 19, 19), allDay: false, calendar: "Home"), in: home, calendar: calendar),
          "a changed title does not match")
    check(!AppleRules.matches(dentist, AppleEvent(id: "e1", title: "Dentist", start: at(9, 19, 18), end: at(9, 19, 19), allDay: false, calendar: "Work"), in: home, calendar: calendar),
          "a changed calendar does not match")
    check(!AppleRules.matches(dentist, AppleEvent(id: "e1", title: "Dentist", start: at(9, 19, 18), end: at(9, 19, 19, 30), allDay: false, calendar: "Home"), in: home, calendar: calendar),
          "a changed end does not match")
    check(AppleRules.matches(offsite, AppleEvent(id: "e4", title: "Offsite", start: at(9, 21), end: at(9, 21, 23, 59).addingTimeInterval(59), allDay: true, calendar: "Home"), in: home, calendar: calendar),
          "an all-day event ending at its last second matches")
    check(AppleRules.matches(offsite, AppleEvent(id: "e4", title: "Offsite", start: at(9, 21), end: at(9, 22), allDay: true, calendar: "Home"), in: home, calendar: calendar),
          "an all-day event ending at the next midnight matches")
    check(!AppleRules.matches(offsite, AppleEvent(id: "e4", title: "Offsite", start: at(9, 21), end: at(9, 23), allDay: true, calendar: "Home"), in: home, calendar: calendar),
          "an all-day event that grew a day does not match")
    check(AppleRules.matches(milk, savedMilk, in: groceries), "a faithful reminder read-back matches")
    check(!AppleRules.matches(milk, AppleReminder(id: "r1", title: "Buy milk", due: at(9, 26), list: "Groceries"), in: groceries), "a moved due date does not match")

    // Undo: never an event with attendees or a repeating item.
    check(failure { try AppleRules.undoAllowed(saved) } == "", "a plain event may be taken back")
    check(failure { try AppleRules.undoAllowed(AppleEvent(id: "e1", title: "Dentist", start: at(9, 19, 18), end: at(9, 19, 19), allDay: false, calendar: "Home", hasAttendees: true)) } == "HAS_ATTENDEES",
          "an event with attendees stays")
    check(failure { try AppleRules.undoAllowed(AppleEvent(id: "e1", title: "Dentist", start: at(9, 19, 18), end: at(9, 19, 19), allDay: false, calendar: "Home", recurring: true)) } == "REPEATS",
          "a repeating event stays")
    check(failure { try AppleRules.undoAllowed(AppleReminder(id: "r1", title: "Water", due: nil, list: "Home", recurring: true)) } == "REPEATS", "a repeating reminder stays")

    // Lines: spoken shapes, bounded, no dashes between times.
    check(AppleRules.eventLine(saved, clock: clock) == "Sat 19 Sep, 6 PM to 7 PM: Dentist (Home)", "an event line says when, what and where")
    check(AppleRules.eventLine(AppleEvent(id: "e", title: "Standup", start: at(9, 18, 9, 45), end: at(9, 18, 10, 15), allDay: false, calendar: "Work"), clock: clock)
          == "Fri 18 Sep, 9:45 AM to 10:15 AM: Standup (Work)", "minutes are spoken when set")
    check(AppleRules.eventLine(AppleEvent(id: "e", title: "Offsite", start: at(9, 21), end: at(9, 21, 23, 59), allDay: true, calendar: ""), clock: clock)
          == "Mon 21 Sep, all day: Offsite", "an all-day event has no times and no empty calendar")
    check(AppleRules.eventLine(AppleEvent(id: "e", title: "Retreat", start: at(9, 21), end: at(9, 23), allDay: true, calendar: "Work"), clock: clock)
          == "Mon 21 Sep to Tue 22 Sep, all day: Retreat (Work)", "a multi-day all-day event names its last day")
    check(AppleRules.eventLine(AppleEvent(id: "e", title: "Flight", start: at(9, 19, 23), end: at(9, 20, 1), allDay: false, calendar: "Home"), clock: clock)
          == "Sat 19 Sep 11 PM to Sun 20 Sep 1 AM: Flight (Home)", "an overnight event names both days")
    check(AppleRules.eventLine(AppleEvent(id: "e", title: "  ", start: at(9, 19, 18), end: at(9, 19, 19), allDay: false, calendar: "Home"), clock: clock)
          == "Sat 19 Sep, 6 PM to 7 PM: Untitled (Home)", "a blank title reads as Untitled")
    check(AppleRules.eventLine(AppleEvent(id: "e", title: "Party", start: at(12, 31, 20), end: at(12, 31, 23), allDay: false, calendar: "Home"), clock: clock)
          == "Thu 31 Dec, 8 PM to 11 PM: Party (Home)", "this year's dates carry no year")
    let nextYear = calendar.date(from: DateComponents(year: 2027, month: 1, day: 2, hour: 9))!
    check(AppleRules.eventLine(AppleEvent(id: "e", title: "Kickoff", start: nextYear, end: nextYear.addingTimeInterval(3600), allDay: false, calendar: "Work"), clock: clock)
          == "Sat 2 Jan 2027, 9 AM to 10 AM: Kickoff (Work)", "another year's dates say the year")
    check(!AppleRules.eventLine(saved, clock: clock).contains("–"), "no en dash between times")
    check(AppleRules.reminderLine(AppleReminder(id: "r", title: "Pay rent", due: at(9, 16, 9), dueHasTime: true, list: "Home"), clock: clock)
          == "Pay rent, due Wed 16 Sep 9 AM (Home)", "a reminder line says its due time")
    check(AppleRules.reminderLine(AppleReminder(id: "r", title: "Send deck", due: at(9, 19), list: "Work"), clock: clock) == "Send deck, due Sat 19 Sep (Work)",
          "a reminder due on a day has no time")
    check(AppleRules.reminderLine(AppleReminder(id: "r", title: "Someday", due: nil, list: "Ideas"), clock: clock) == "Someday (Ideas)", "an undated reminder has no date")
    check(AppleRules.noteLine(AppleNote(id: "n", title: "Groceries", folder: "Notes")) == "Groceries (Notes)", "a note line is title and folder")
    check(AppleRules.mailLine(AppleMessage(sender: "Dana Li <dana@example.com>", subject: "Quarterly plan", received: at(9, 18, 8)), clock: clock)
          == "Dana Li: Quarterly plan, 2 h ago", "a mail line is sender name, subject and age")
    check(AppleRules.mailLine(AppleMessage(sender: "noreply@example.com", subject: "", received: at(9, 18, 9, 58)), clock: clock)
          == "noreply@example.com: (no subject), 2 min ago", "no display name falls back to the address; no subject says so")
    check(AppleRules.senderName("\"Li, Dana\" <dana@example.com>") == "Li, Dana", "a quoted display name loses its quotes")
    check(AppleRules.senderName("<dana@example.com>") == "dana@example.com", "an empty display name is the address")
    check(AppleRules.senderName("") == "Unknown sender", "no sender at all is named as unknown")
    check(AppleRules.age(of: at(9, 18, 9, 59).addingTimeInterval(30), clock: clock) == "just now", "under a minute is just now")
    check(AppleRules.age(of: at(9, 17, 12), clock: clock) == "yesterday", "yesterday is yesterday")
    check(AppleRules.age(of: at(9, 14, 12), clock: clock) == "4 days ago", "a few days ago is counted in days")
    check(AppleRules.age(of: at(9, 18, 0, 30), clock: clock) == "9 h ago", "earlier today is counted in hours")
    check(AppleRules.age(of: at(8, 1, 12), clock: clock) == "Sat 1 Aug", "older mail says its day")
    check(AppleRules.clean("Two  words\u{07}\n here", limit: 100) == "Two words here", "store text is collapsed and stripped")
    check(AppleRules.clean(String(repeating: "x", count: 300)).count == 100, "store text is bounded")
    let many = AppleRules.bounded((1 ... 25).map { "line \($0) " + String(repeating: "x", count: 300) })
    check(many.lines.count == 20 && many.more == 5, "lines are capped at 20 with a count of the rest")
    check(many.lines.allSatisfy { $0.count == 200 }, "every line is capped at 200 characters")
    check(AppleRules.iso(at(9, 19, 18), calendar: calendar) == "2026-09-19T18:00:00-07:00", "ISO output carries the local offset")

    // AppleScript escaping: nothing in a title or body can close the literal.
    check(AppleRules.appleScriptLiteral("say \"hi\"") == "say \\\"hi\\\"", "quotes are escaped")
    check(AppleRules.appleScriptLiteral("back\\slash") == "back\\\\slash", "backslashes are escaped")
    check(AppleRules.appleScriptLiteral("one\ntwo\rthree") == "one\\ntwo\\nthree", "line breaks become \\n")
    check(AppleRules.appleScriptLiteral("one\u{2028}two\u{2029}three") == "one\\ntwo\\nthree", "Unicode line and paragraph separators too")
    check(AppleRules.appleScriptLiteral("tab\there") == "tab here", "a tab becomes a space")
    check(AppleRules.appleScriptLiteral("bell\u{07}del\u{7f}") == "belldel", "other control characters are dropped")
    check(AppleRules.appleScriptLiteral("\" & (do shell script \"rm -rf ~\") & \"") == "\\\" & (do shell script \\\"rm -rf ~\\\") & \\\"",
          "an injected statement stays inside the literal")
    check(AppleRules.noteHTML(title: "A <b> & \"c\"", body: "x\n\ny>z") == "<div><h1>A &lt;b&gt; &amp; &quot;c&quot;</h1></div><div>x</div><div><br></div><div>y&gt;z</div>",
          "note HTML escapes markup and keeps blank lines")

    // Targets: the two fixed bundle ids, nothing else.
    check(AppleTarget.allCases.map(\.rawValue) == ["com.apple.Notes", "com.apple.mail"], "the Apple-events targets are Notes and Mail only")
    check(AppleConsent.allCases.map(\.rawValue) == ["calendar", "reminders", "notes", "mail"], "four consents, one per app")
}
