import Foundation

/**
 Pure rules for coarena-apple, the Apple bridge: what each tool call may ask
 for, how its arguments are bounded and parsed, which calendar or list an add
 lands in, when an add is a duplicate of what is already there, whether the
 item read back after a save is the one asked for, what may be undone, how a
 result reads as short lines, and how text is escaped before it reaches
 AppleScript. Apple.swift does the EventKit and Apple-events I/O and
 AppleProtocol.swift frames the MCP messages; this file decides, and the
 native tests cover it without a store (docs/TOOLS.md).

 Every refusal here happens before the store is touched, as AgendaRules does
 for the benchmark commands.
 */

/// The four consents, one per app (settings.tools.apple).
enum AppleConsent: String, CaseIterable {
    case calendar, reminders, notes, mail
}

/// An application the bridge drives by Apple events. The bundle ids are
/// fixed here and nowhere else: no argument ever names a target.
enum AppleTarget: String, CaseIterable {
    case notes = "com.apple.Notes"
    case mail = "com.apple.mail"
}

/// The bridge's clock: the moment and the calendar (with its zone) every
/// date is read and printed in.
struct AppleClock {
    let now: Date
    let calendar: Calendar
}

struct AppleContainer: Equatable {
    let title: String
    let writable: Bool
    var subscribed = false
    var birthdays = false
    var isDefault = false
    /// The store's own identifier; never printed.
    var id = ""
}
struct AppleEvent: Equatable {
    let id: String
    let title: String
    let start: Date
    let end: Date
    let allDay: Bool
    let calendar: String
    var hasAttendees = false
    var recurring = false
}
struct AppleReminder: Equatable {
    let id: String
    let title: String
    let due: Date?
    var dueHasTime = false
    let list: String
    var recurring = false
}
struct AppleNote: Equatable {
    let id: String
    let title: String
    let folder: String
}
struct AppleMessage: Equatable {
    let sender: String
    let subject: String
    let received: Date
}
struct AppleDraft: Equatable {
    let id: String
    let subject: String
    let recipients: Int
}

/// A refusal or failure, as the tool result reports it: the code first, then
/// one sentence the model can act on. Never carries a store identifier.
struct AppleFailure: Error, Equatable {
    let code: String
    let message: String
}

struct AppleEventRange: Equatable {
    let start: Date
    /// Exclusive.
    let end: Date
}
struct AppleEventRequest: Equatable {
    let title: String
    let start: Date
    /// Exclusive; for an all-day event the start of the day after the last one.
    let end: Date
    let allDay: Bool
    let calendar: String?
}
struct AppleReminderQuery: Equatable {
    let list: String?
    let dueBefore: Date?
}
struct AppleReminderRequest: Equatable {
    let title: String
    let due: Date?
    let dueHasTime: Bool
    let list: String?
}
struct AppleNoteRequest: Equatable {
    let title: String
    let body: String
    let folder: String?
}
struct AppleMailQuery: Equatable {
    let from: String?
    let subject: String?
    let since: Date?
}
struct AppleDraftRequest: Equatable {
    let to: [String]
    let subject: String
    let body: String
}

/// A parsed date argument: the instant, and whether the text carried a time.
struct AppleDateArgument: Equatable {
    let date: Date
    let hasTime: Bool
}

enum AppleContainerKind {
    case calendar, list
    var word: String { self == .calendar ? "calendar" : "list" }
    var code: String { self == .calendar ? "NO_CALENDAR" : "NO_LIST" }
}

/// What one add made, remembered for undo by this process only.
enum AppleCreatedKind: String {
    case event, reminder, note, draft
}
struct AppleCreated: Equatable {
    let kind: AppleCreatedKind
    let id: String
}

enum AppleRules {
    static let titleLimit = 100
    static let subjectLimit = 200
    static let bodyLimit = 4000
    static let queryLimit = 100
    static let recipientLimit = 20
    static let lineLimit = 200
    static let linesLimit = 20
    static let mailDefaultLimit = 10
    /// calendar_list_events reads at most this many days at once.
    static let rangeDays = 31
    /// An add may start this long ago (a meeting that just started) and this far ahead.
    static let pastSeconds = 86_400.0
    static let futureSeconds = 365.0 * 86_400
    static let minDuration = 60.0
    static let maxDuration = 86_400.0
    static let allDayMaxDays = 31

    /// The date contract, as the inputSchema states it and the client (the
    /// MCP SDK's Ajv) checks it before a call: a day is `YYYY-MM-DD`; a moment
    /// is a day or a local date-time `YYYY-MM-DDTHH:MM[:SS[.fff]]`, with an
    /// optional `Z` or offset. No JSON Schema `format`: `date-time` would
    /// refuse the offset-less local form that `date(_:calendar:)` reads.
    /// Ranges (month 13, hour 24, an offset past 14 h) are this file's job.
    static let dayPattern = #"^\d{4}-\d{2}-\d{2}$"#
    static let momentPattern = #"^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$"#

    // MARK: - Arguments

    static func badArgs(_ message: String) -> AppleFailure { AppleFailure(code: "BAD_ARGS", message: message) }

    /// Every key must be known and every required key present: an attendee,
    /// alarm, URL or note smuggled in as an extra key is refused, not ignored.
    static func keys(_ args: [String: Any], allowed: Set<String>, required: Set<String> = []) throws {
        let given = Set(args.keys)
        if let extra = given.subtracting(allowed).sorted().first {
            throw badArgs("Unknown argument \(extra). Allowed: \(allowed.sorted().joined(separator: ", ")).")
        }
        if let missing = required.subtracting(given).sorted().first {
            throw badArgs("Missing argument \(missing).")
        }
    }

    /// A string argument: absent → nil; present → trimmed, non-empty, within
    /// the limit, one line unless `oneLine` is false, free of control characters.
    static func text(_ args: [String: Any], _ key: String, limit: Int, oneLine: Bool = true) throws -> String? {
        guard let value = args[key] else { return nil }
        guard let raw = value as? String else { throw badArgs("\(key) must be text.") }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw badArgs("\(key) must not be empty.") }
        guard trimmed.count <= limit else { throw badArgs("\(key) must be at most \(limit) characters.") }
        for scalar in trimmed.unicodeScalars {
            if Character(scalar).isNewline {
                if oneLine { throw badArgs("\(key) must be one line.") }
                continue
            }
            if scalar == "\t" && !oneLine { continue }
            if scalar.value < 0x20 || scalar.value == 0x7f { throw badArgs("\(key) must be plain text.") }
        }
        return trimmed
    }

    /// JSON true/false arrives as a CFBoolean; a number never does, and 1 is not true.
    static func isBoolean(_ value: Any) -> Bool { CFGetTypeID(value as CFTypeRef) == CFBooleanGetTypeID() }

    static func integer(_ args: [String: Any], _ key: String, min: Int, max: Int) throws -> Int? {
        guard let value = args[key] else { return nil }
        guard !isBoolean(value), let number = value as? NSNumber, number.doubleValue == number.doubleValue.rounded(),
              let count = Int(exactly: number.doubleValue), count >= min, count <= max
        else { throw badArgs("\(key) must be a whole number from \(min) to \(max).") }
        return count
    }

    static func flag(_ args: [String: Any], _ key: String) throws -> Bool {
        guard let value = args[key] else { return false }
        guard isBoolean(value), let bool = value as? Bool else { throw badArgs("\(key) must be true or false.") }
        return bool
    }

    /// YYYY-MM-DD, or YYYY-MM-DD(T| )HH:MM[:SS[.fraction]] with an optional
    /// Z or ±HH[:]MM offset. Without an offset the text is local time in the
    /// clock's zone. nil for anything else, including a day that does not exist.
    static func date(_ text: String, calendar: Calendar) -> AppleDateArgument? {
        let chars = Array(text)
        guard chars.count >= 10, chars.count <= 35 else { return nil }
        func digits(_ from: Int, _ count: Int) -> Int? {
            guard from + count <= chars.count else { return nil }
            var value = 0
            for index in from ..< from + count {
                guard let digit = chars[index].wholeNumberValue, chars[index].isASCII else { return nil }
                value = value * 10 + digit
            }
            return value
        }
        guard let year = digits(0, 4), chars[4] == "-", let month = digits(5, 2), chars[7] == "-", let day = digits(8, 2)
        else { return nil }
        var components = DateComponents(year: year, month: month, day: day)
        var hasTime = false
        var index = 10
        if index < chars.count, chars[index] == "T" || chars[index] == " " {
            guard let hour = digits(11, 2), chars.count > 13, chars[13] == ":", let minute = digits(14, 2),
                  hour < 24, minute < 60
            else { return nil }
            components.hour = hour
            components.minute = minute
            hasTime = true
            index = 16
            if index < chars.count, chars[index] == ":" {
                guard let second = digits(17, 2), second < 61 else { return nil }
                components.second = second
                index = 19
                if index < chars.count, chars[index] == "." {
                    index += 1
                    var fraction = 0
                    while index < chars.count, chars[index].isASCII, chars[index].isNumber { index += 1; fraction += 1 }
                    guard fraction > 0 else { return nil }
                }
            }
        }
        var zone = calendar.timeZone
        if index < chars.count {
            let rest = String(chars[index...])
            if rest == "Z" {
                zone = TimeZone(secondsFromGMT: 0)!
            } else {
                let sign: Int
                switch rest.first {
                case "+": sign = 1
                case "-": sign = -1
                default: return nil
                }
                let body = rest.dropFirst().replacingOccurrences(of: ":", with: "")
                guard body.count == 4, let hours = Int(body.prefix(2)), let minutes = Int(body.suffix(2)),
                      hours <= 14, minutes < 60, let offset = TimeZone(secondsFromGMT: sign * (hours * 3600 + minutes * 60))
                else { return nil }
                zone = offset
            }
        }
        guard (1 ... 12).contains(month), (1 ... 31).contains(day) else { return nil }
        var inZone = calendar
        inZone.timeZone = zone
        guard let date = inZone.date(from: components) else { return nil }
        // A day that does not exist (30 February) rolls over; the round trip catches it.
        let back = inZone.dateComponents([.year, .month, .day], from: date)
        guard back.year == year, back.month == month, back.day == day else { return nil }
        return AppleDateArgument(date: date, hasTime: hasTime)
    }

    static func dateArgument(_ args: [String: Any], _ key: String, calendar: Calendar) throws -> AppleDateArgument? {
        guard let value = args[key] else { return nil }
        guard let text = value as? String, let parsed = date(text, calendar: calendar) else {
            throw badArgs("\(key) must be a date like 2026-09-19 or a local date-time like 2026-09-19T18:00.")
        }
        return parsed
    }

    // MARK: - Reads

    /// calendar_list_events { from, to }: whole local days, to ≥ from, at most 31 days.
    static func eventRange(_ args: [String: Any], clock: AppleClock) throws -> AppleEventRange {
        try keys(args, allowed: ["from", "to"], required: ["from", "to"])
        guard let from = try dateArgument(args, "from", calendar: clock.calendar),
              let to = try dateArgument(args, "to", calendar: clock.calendar) else { throw badArgs("Missing argument from.") }
        guard !from.hasTime, !to.hasTime else { throw badArgs("from and to are days (YYYY-MM-DD), not times.") }
        let start = clock.calendar.startOfDay(for: from.date)
        guard let end = clock.calendar.date(byAdding: .day, value: 1, to: clock.calendar.startOfDay(for: to.date)),
              end > start else { throw badArgs("to must be the same day as from or later.") }
        guard let days = clock.calendar.dateComponents([.day], from: start, to: end).day, days <= rangeDays else {
            throw badArgs("from and to may span at most \(rangeDays) days.")
        }
        return AppleEventRange(start: start, end: end)
    }

    /// reminders_list { list?, dueBefore? }.
    static func reminderQuery(_ args: [String: Any], clock: AppleClock) throws -> AppleReminderQuery {
        try keys(args, allowed: ["list", "dueBefore"])
        let list = try text(args, "list", limit: titleLimit)
        let dueBefore = try dateArgument(args, "dueBefore", calendar: clock.calendar)
        let before = dueBefore.map { $0.hasTime ? $0.date : clock.calendar.date(byAdding: .day, value: 1, to: clock.calendar.startOfDay(for: $0.date))! }
        return AppleReminderQuery(list: list, dueBefore: before)
    }

    /// notes_search { query }.
    static func notesQuery(_ args: [String: Any]) throws -> String {
        try keys(args, allowed: ["query"], required: ["query"])
        return try text(args, "query", limit: queryLimit)!
    }

    /// mail_unread { limit? }: 1 to 20, ten when unsaid.
    static func mailLimit(_ args: [String: Any]) throws -> Int {
        try keys(args, allowed: ["limit"])
        return try integer(args, "limit", min: 1, max: linesLimit) ?? mailDefaultLimit
    }

    /// mail_search { from?, subject?, since? }: at least one of them.
    static func mailQuery(_ args: [String: Any], clock: AppleClock) throws -> AppleMailQuery {
        try keys(args, allowed: ["from", "subject", "since"])
        let query = AppleMailQuery(from: try text(args, "from", limit: queryLimit),
                                   subject: try text(args, "subject", limit: queryLimit),
                                   since: try dateArgument(args, "since", calendar: clock.calendar)?.date)
        guard query.from != nil || query.subject != nil || query.since != nil else {
            throw badArgs("Give at least one of from, subject or since.")
        }
        return query
    }

    // MARK: - Adds

    /// calendar_create_event { title, start, end?, allDay?, calendar? }.
    static func eventRequest(_ args: [String: Any], clock: AppleClock) throws -> AppleEventRequest {
        try keys(args, allowed: ["title", "start", "end", "allDay", "calendar"], required: ["title", "start"])
        let title = try text(args, "title", limit: titleLimit)!
        let allDay = try flag(args, "allDay")
        let calendarName = try text(args, "calendar", limit: titleLimit)
        guard let startArgument = try dateArgument(args, "start", calendar: clock.calendar) else { throw badArgs("Missing argument start.") }
        let endArgument = try dateArgument(args, "end", calendar: clock.calendar)
        let start: Date, end: Date
        if allDay {
            start = clock.calendar.startOfDay(for: startArgument.date)
            let lastDay = clock.calendar.startOfDay(for: endArgument?.date ?? start)
            guard let after = clock.calendar.date(byAdding: .day, value: 1, to: lastDay) else { throw badArgs("end is out of range.") }
            end = after
            guard let days = clock.calendar.dateComponents([.day], from: start, to: end).day, days >= 1, days <= allDayMaxDays else {
                throw badArgs("An all-day event spans 1 to \(allDayMaxDays) days; end is its last day.")
            }
        } else {
            guard startArgument.hasTime else { throw badArgs("start needs a time (2026-09-19T18:00), or set allDay.") }
            start = startArgument.date
            end = endArgument?.date ?? start.addingTimeInterval(3600)
            let duration = end.timeIntervalSince(start)
            guard duration >= minDuration, duration <= maxDuration else {
                throw badArgs("end must be 1 minute to 24 hours after start.")
            }
        }
        try withinReach(start, clock: clock, key: "start")
        return AppleEventRequest(title: title, start: start, end: end, allDay: allDay, calendar: calendarName)
    }

    /// reminders_create { title, due?, list? }.
    static func reminderRequest(_ args: [String: Any], clock: AppleClock) throws -> AppleReminderRequest {
        try keys(args, allowed: ["title", "due", "list"], required: ["title"])
        let title = try text(args, "title", limit: titleLimit)!
        let due = try dateArgument(args, "due", calendar: clock.calendar)
        if let due { try withinReach(due.hasTime ? due.date : clock.calendar.startOfDay(for: due.date), clock: clock, key: "due") }
        return AppleReminderRequest(title: title, due: due?.date, dueHasTime: due?.hasTime ?? false,
                                    list: try text(args, "list", limit: titleLimit))
    }

    /// notes_create { title, body?, folder? }.
    static func noteRequest(_ args: [String: Any]) throws -> AppleNoteRequest {
        try keys(args, allowed: ["title", "body", "folder"], required: ["title"])
        return AppleNoteRequest(title: try text(args, "title", limit: titleLimit)!,
                                body: try text(args, "body", limit: bodyLimit, oneLine: false) ?? "",
                                folder: try text(args, "folder", limit: titleLimit))
    }

    /// mail_draft { to[], subject, body? }: every recipient a well-formed address.
    static func draftRequest(_ args: [String: Any]) throws -> AppleDraftRequest {
        try keys(args, allowed: ["to", "subject", "body"], required: ["to", "subject"])
        guard let to = args["to"] as? [Any], !to.isEmpty else { throw badArgs("to must be a list of addresses.") }
        guard to.count <= recipientLimit else { throw badArgs("to may hold at most \(recipientLimit) addresses.") }
        var recipients = [String]()
        for entry in to {
            guard let address = (entry as? String)?.trimmingCharacters(in: .whitespaces), mailAddress(address) else {
                throw badArgs("Every recipient must be an address like name@example.com.")
            }
            recipients.append(address)
        }
        return AppleDraftRequest(to: recipients, subject: try text(args, "subject", limit: subjectLimit)!,
                                 body: try text(args, "body", limit: bodyLimit, oneLine: false) ?? "")
    }

    /// undo { token }.
    static func undoToken(_ args: [String: Any]) throws -> String {
        try keys(args, allowed: ["token"], required: ["token"])
        guard let token = args["token"] as? String, !token.isEmpty, token.count <= 64,
              token.unicodeScalars.allSatisfy({ $0.isASCII && (CharacterSet.alphanumerics.contains($0) || $0 == "-") })
        else { throw badArgs("token must be the undo token of an earlier add.") }
        return token
    }

    /// One address: local part, one @, a dotted domain, no whitespace, quotes,
    /// brackets or commas that could smuggle a second recipient.
    static func mailAddress(_ raw: String) -> Bool {
        guard raw.count >= 3, raw.count <= 254 else { return false }
        let parts = raw.split(separator: "@", omittingEmptySubsequences: false)
        guard parts.count == 2, !parts[0].isEmpty, parts[1].contains("."),
              !parts[1].hasPrefix("."), !parts[1].hasSuffix("."), !parts[1].contains(".."),
              !raw.contains(where: { $0.isWhitespace || "\"'<>,;()[]\\".contains($0) || $0.asciiValue.map { $0 < 0x21 || $0 == 0x7f } ?? true })
        else { return false }
        return parts[1].allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "." }
    }

    private static func withinReach(_ date: Date, clock: AppleClock, key: String) throws {
        guard date >= clock.now.addingTimeInterval(-pastSeconds) else { throw badArgs("\(key) is in the past.") }
        guard date <= clock.now.addingTimeInterval(futureSeconds) else { throw badArgs("\(key) is more than a year ahead.") }
    }

    // MARK: - Containers, duplicates, read-back, undo

    /// The calendar or list an add lands in, or a read looks at. A name must
    /// match one exactly; no name means the store's default. For writing, the
    /// container must accept changes and be neither subscribed nor birthdays.
    static func container(named name: String?, among containers: [AppleContainer], kind: AppleContainerKind,
                          forWriting: Bool = true) throws -> AppleContainer {
        let usable = containers.filter { !forWriting || ($0.writable && !$0.subscribed && !$0.birthdays) }
        if let name {
            if let match = usable.first(where: { $0.title == name }) { return match }
            let names = usable.map(\.title).filter { !$0.isEmpty }.sorted().prefix(linesLimit).joined(separator: ", ")
            let reason = containers.contains(where: { $0.title == name }) ? "cannot be changed" : "does not exist"
            throw AppleFailure(code: kind.code, message: "The \(kind.word) \(name) \(reason). \(kind.word.capitalized)s: \(names).")
        }
        guard let chosen = usable.first(where: \.isDefault) ?? usable.first else {
            throw AppleFailure(code: kind.code, message: "No \(kind.word) accepts new items.")
        }
        return chosen
    }

    /// The same title, start and calendar already there: a retry after a
    /// timeout must not add a second one.
    static func duplicate(_ request: AppleEventRequest, in container: AppleContainer, among events: [AppleEvent]) -> Bool {
        events.contains { $0.calendar == container.title && $0.title == request.title && $0.start == request.start }
    }
    static func duplicate(_ request: AppleReminderRequest, in container: AppleContainer, among reminders: [AppleReminder]) -> Bool {
        reminders.contains { $0.list == container.title && $0.title == request.title && $0.due == request.due }
    }

    /// The saved item read back by identifier is what was asked for. An
    /// all-day event compares by day: stores keep its end at the last day's
    /// midnight or its last second, and either is the same day.
    static func matches(_ request: AppleEventRequest, _ event: AppleEvent, in container: AppleContainer, calendar: Calendar) -> Bool {
        guard event.title == request.title, event.calendar == container.title, event.allDay == request.allDay else { return false }
        if request.allDay {
            let lastDay = request.end.addingTimeInterval(-1)
            return calendar.isDate(event.start, inSameDayAs: request.start)
                && (calendar.isDate(event.end, inSameDayAs: lastDay) || event.end == request.end)
        }
        return event.start == request.start && event.end == request.end
    }
    static func matches(_ request: AppleReminderRequest, _ reminder: AppleReminder, in container: AppleContainer) -> Bool {
        reminder.title == request.title && reminder.list == container.title && reminder.due == request.due
    }

    /// Only an item this process made goes, and only when taking it back
    /// touches nobody else: an event with attendees would send cancellations,
    /// and a repeating item is a series someone should look at.
    static func undoAllowed(_ event: AppleEvent) throws {
        if event.hasAttendees { throw AppleFailure(code: "HAS_ATTENDEES", message: "The event has attendees; remove it in Calendar.") }
        if event.recurring { throw AppleFailure(code: "REPEATS", message: "The event repeats; remove it in Calendar.") }
    }
    static func undoAllowed(_ reminder: AppleReminder) throws {
        if reminder.recurring { throw AppleFailure(code: "REPEATS", message: "The reminder repeats; remove it in Reminders.") }
    }

    // MARK: - Lines

    private static let weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    private static let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

    /// "Sat 19 Sep", with the year when it is not this year.
    static func dayWords(_ date: Date, clock: AppleClock) -> String {
        let calendar = clock.calendar
        let parts = calendar.dateComponents([.weekday, .day, .month, .year], from: date)
        var words = "\(weekdays[(parts.weekday ?? 1) - 1]) \(parts.day ?? 0) \(months[(parts.month ?? 1) - 1])"
        if parts.year != calendar.component(.year, from: clock.now) { words += " \(parts.year ?? 0)" }
        return words
    }
    /// "6 PM", "6:30 PM".
    static func clockWords(_ date: Date, calendar: Calendar) -> String {
        let hour = calendar.component(.hour, from: date), minute = calendar.component(.minute, from: date)
        let twelve = hour % 12 == 0 ? 12 : hour % 12
        let suffix = hour < 12 ? "AM" : "PM"
        return minute == 0 ? "\(twelve) \(suffix)" : String(format: "%d:%02d %@", twelve, minute, suffix)
    }
    /// When an event happens, in words a voice can read ("to", never a dash).
    static func when(start: Date, end: Date, allDay: Bool, clock: AppleClock) -> String {
        let calendar = clock.calendar
        if allDay {
            let lastDay = end > start.addingTimeInterval(1) ? end.addingTimeInterval(-1) : start
            return calendar.isDate(start, inSameDayAs: lastDay)
                ? "\(dayWords(start, clock: clock)), all day"
                : "\(dayWords(start, clock: clock)) to \(dayWords(lastDay, clock: clock)), all day"
        }
        if calendar.isDate(start, inSameDayAs: end) {
            return "\(dayWords(start, clock: clock)), \(clockWords(start, calendar: calendar)) to \(clockWords(end, calendar: calendar))"
        }
        return "\(dayWords(start, clock: clock)) \(clockWords(start, calendar: calendar)) to \(dayWords(end, clock: clock)) \(clockWords(end, calendar: calendar))"
    }

    /// Text from a store, made safe for one line: control characters dropped,
    /// whitespace collapsed, bounded.
    static func clean(_ text: String, limit: Int = titleLimit) -> String {
        var out = ""
        var space = false
        for scalar in text.unicodeScalars {
            if Character(scalar).isWhitespace || scalar.value < 0x20 || scalar.value == 0x7f {
                space = !out.isEmpty
                continue
            }
            if space { out.append(" "); space = false }
            out.unicodeScalars.append(scalar)
            if out.count >= limit { break }
        }
        return out
    }

    static func eventLine(_ event: AppleEvent, clock: AppleClock) -> String {
        let title = clean(event.title)
        var line = "\(when(start: event.start, end: event.end, allDay: event.allDay, clock: clock)): \(title.isEmpty ? "Untitled" : title)"
        let calendar = clean(event.calendar)
        if !calendar.isEmpty { line += " (\(calendar))" }
        return line
    }
    static func reminderLine(_ reminder: AppleReminder, clock: AppleClock) -> String {
        let title = clean(reminder.title)
        var line = title.isEmpty ? "Untitled" : title
        if let due = reminder.due {
            line += ", due \(dayWords(due, clock: clock))"
            if reminder.dueHasTime { line += " \(clockWords(due, calendar: clock.calendar))" }
        }
        let list = clean(reminder.list)
        if !list.isEmpty { line += " (\(list))" }
        return line
    }
    static func noteLine(_ note: AppleNote) -> String {
        let title = clean(note.title)
        let folder = clean(note.folder)
        return (title.isEmpty ? "Untitled" : title) + (folder.isEmpty ? "" : " (\(folder))")
    }
    /// "Dana Li: Quarterly plan, 2 h ago". Never a body.
    static func mailLine(_ message: AppleMessage, clock: AppleClock) -> String {
        let subject = clean(message.subject)
        return "\(senderName(message.sender)): \(subject.isEmpty ? "(no subject)" : subject), \(age(of: message.received, clock: clock))"
    }
    /// The display name of "Dana Li <dana@example.com>"; the address when there is none.
    static func senderName(_ sender: String) -> String {
        let whole = clean(sender)
        guard let open = whole.firstIndex(of: "<") else { return whole.isEmpty ? "Unknown sender" : whole }
        let name = whole[..<open].trimmingCharacters(in: CharacterSet(charactersIn: " \"'"))
        if !name.isEmpty { return name }
        let address = whole[whole.index(after: open)...].trimmingCharacters(in: CharacterSet(charactersIn: " >"))
        return address.isEmpty ? "Unknown sender" : address
    }
    /// How long ago, in the words a person would use: minutes and hours within
    /// today, then whole days, then the date.
    static func age(of date: Date, clock: AppleClock) -> String {
        let seconds = clock.now.timeIntervalSince(date)
        if seconds < 60 { return "just now" }
        let calendar = clock.calendar
        if calendar.isDate(date, inSameDayAs: clock.now) {
            return seconds < 3600 ? "\(Int(seconds / 60)) min ago" : "\(Int(seconds / 3600)) h ago"
        }
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: clock.now)).day ?? 0
        if days == 1 { return "yesterday" }
        if days < 7 { return "\(days) days ago" }
        return dayWords(date, clock: clock)
    }

    /// At most 20 lines of at most 200 characters; the rest is a count.
    static func bounded(_ lines: [String]) -> (lines: [String], more: Int) {
        (lines.prefix(linesLimit).map { String($0.prefix(lineLimit)) }, max(0, lines.count - linesLimit))
    }

    /// ISO 8601 with the clock's offset: "2026-09-19T18:00:00-07:00".
    static func iso(_ date: Date, calendar: Calendar) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        formatter.timeZone = calendar.timeZone
        return formatter.string(from: date)
    }

    // MARK: - AppleScript

    /// The inner text of an AppleScript string literal. Quotes and backslashes
    /// are escaped, line breaks become \n, other control characters are
    /// dropped, so no title or body can close the literal or add statements
    /// (the MessageSafety precedent).
    static func appleScriptLiteral(_ text: String) -> String {
        var out = ""
        out.reserveCapacity(text.count + 8)
        for scalar in text.unicodeScalars {
            switch scalar {
            case "\\": out += "\\\\"
            case "\"": out += "\\\""
            case "\n", "\r", "\u{2028}", "\u{2029}": out += "\\n"
            case "\t": out += " "
            default:
                if scalar.value < 0x20 || scalar.value == 0x7f { continue }
                out.unicodeScalars.append(scalar)
            }
        }
        return out
    }

    /// A note's HTML body: the title as its first line, then the body one
    /// paragraph per line, every character that HTML could read escaped.
    static func noteHTML(title: String, body: String) -> String {
        func escaped(_ text: String) -> String {
            var out = ""
            for character in text {
                switch character {
                case "&": out += "&amp;"
                case "<": out += "&lt;"
                case ">": out += "&gt;"
                case "\"": out += "&quot;"
                default: out.append(character)
                }
            }
            return out
        }
        var html = "<div><h1>\(escaped(title))</h1></div>"
        for line in body.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline) {
            html += line.isEmpty ? "<div><br></div>" : "<div>\(escaped(String(line)))</div>"
        }
        return html
    }
}
