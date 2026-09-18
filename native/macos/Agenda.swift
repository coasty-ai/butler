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
        default:
            emit(["error": "Unknown agenda command."])
        }
    }
}
