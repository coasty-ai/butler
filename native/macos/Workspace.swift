import Foundation

/**
 What else is going on.

 An assistant that only sees the frontmost window keeps starting work the user
 already has open, and never knows what just arrived. The workspace context is
 the rest of the picture: which applications are running and what their windows
 are called, the notifications that appeared while the Mac was in use, and the
 few system facts a model cannot infer from a screenshot. These are the pure
 rules; the helper does the accessibility and AppKit reads.

 All of it is screen-derived, untrusted data, bounded and redacted like every
 other context field, and notifications can be switched off (docs/PRIVACY.md).
 */

// Enough of the workspace to plan with, not enough to flood the model.
let openAppListLimit = 14
let openAppWindowLimit = 3
let windowTitleLimit = 120
let notificationListLimit = 12
let notificationTextLimit = 140
// Notifications older than this are history, not context.
let notificationHorizonSeconds = 4.0 * 3600

struct OpenApp {
    let name: String
    let windows: [String]
    let frontmost: Bool
}
/**
 One line per application: its name, whether it is in front, and the titles of
 the windows it has open. Applications keep the order they are given (most
 recently used first); windows and titles are bounded.
 */
func openAppLines(_ apps: [OpenApp], limit: Int = openAppListLimit) -> [String] {
    apps.prefix(limit).map { app in
        var line = String(app.name.prefix(windowTitleLimit))
        if app.frontmost { line += " (frontmost)" }
        let titles = app.windows
            .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
            .prefix(openAppWindowLimit)
            .map { String($0.prefix(windowTitleLimit)) }
        return titles.isEmpty ? line : line + ": " + titles.joined(separator: " | ")
    }
}

struct DeliveredNotification: Equatable {
    let at: TimeInterval
    let app: String
    let title: String
    let body: String
}
/**
 Adds a notification to the recent list.

 macOS republishes a banner's accessibility window as it animates, so the same
 notification arrives several times within a second or two: an entry with the
 same application and text inside that window replaces the earlier one rather
 than repeating. Entries older than the horizon are dropped, and the list is
 capped, so a busy morning cannot grow without bound.
 */
func mergeNotification(_ existing: [DeliveredNotification], _ entry: DeliveredNotification,
                       limit: Int = notificationListLimit,
                       horizon: TimeInterval = notificationHorizonSeconds) -> [DeliveredNotification] {
    guard !entry.app.isEmpty || !entry.title.isEmpty || !entry.body.isEmpty else { return existing }
    var kept = existing.filter { entry.at - $0.at <= horizon }
    kept.removeAll { $0.app == entry.app && $0.title == entry.title && $0.body == entry.body }
    kept.append(entry)
    return Array(kept.suffix(limit))
}
/**
 One notification as the model reads it: how long ago, from which application,
 then its title and body. Relative time keeps the line useful whenever the
 observation is made, and bounded text keeps a long message from crowding out
 the rest of the context.
 */
func notificationLine(_ entry: DeliveredNotification, now: TimeInterval) -> String {
    let elapsed = max(0, now - entry.at)
    let ago: String
    if elapsed < 90 { ago = "just now" }
    else if elapsed < 3600 { ago = "\(Int(elapsed / 60))m ago" }
    else { ago = "\(Int(elapsed / 3600))h ago" }
    let text = [entry.title, entry.body]
        .map { $0.trimmingCharacters(in: .whitespaces) }
        .filter { !$0.isEmpty }
        .joined(separator: " — ")
    let app = entry.app.trimmingCharacters(in: .whitespaces)
    let head = app.isEmpty ? ago : "\(app), \(ago)"
    return text.isEmpty ? head : "\(head): " + String(text.prefix(notificationTextLimit))
}

/**
 The accessibility texts of a notification banner, split into what it is from,
 its title and its body. Banners put the application name first, then the
 title, then the message; anything beyond that (actions such as "Close",
 repeated values) is dropped. Duplicates neighbouring entries are collapsed
 because a banner exposes the same string on more than one element.
 */
func notificationParts(_ texts: [String]) -> (app: String, title: String, body: String) {
    var seen = Set<String>(), ordered = [String]()
    for raw in texts {
        let text = raw.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        guard !text.isEmpty, text.count <= 400, seen.insert(text.lowercased()).inserted else { continue }
        // Banner furniture, not content.
        guard !["close", "options", "show", "reply", "notification", "dismiss"].contains(text.lowercased()) else { continue }
        ordered.append(text)
        if ordered.count >= 4 { break }
    }
    guard !ordered.isEmpty else { return ("", "", "") }
    if ordered.count == 1 { return ("", ordered[0], "") }
    return (ordered[0], ordered[1], ordered.count > 2 ? ordered[2...].joined(separator: " ") : "")
}
