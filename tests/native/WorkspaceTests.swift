import Foundation

// Pure workspace rules in Workspace.swift.
func workspaceChecks(_ check: (Bool, String) -> Void) {
    // openAppLines
    let lines = openAppLines([
        OpenApp(name: "Code", windows: ["open-assist", "notes.md", "README", "extra"], frontmost: true),
        OpenApp(name: "Slack", windows: ["Prateek J (DM)"], frontmost: false),
        OpenApp(name: "Finder", windows: [], frontmost: false),
    ])
    check(lines[0] == "Code (frontmost): open-assist | notes.md | README", "the frontmost app is marked and its windows are bounded")
    check(lines[1] == "Slack: Prateek J (DM)", "a background app lists its window titles")
    check(lines[2] == "Finder", "an app with no titled window is still listed")
    check(openAppLines((0..<30).map { OpenApp(name: "App\($0)", windows: [], frontmost: false) }).count == openAppListLimit,
          "the application list is bounded")
    check(openAppLines([OpenApp(name: "Long", windows: [String(repeating: "x", count: 500)], frontmost: false)])[0].count
          <= "Long: ".count + windowTitleLimit, "window titles are bounded")

    // mergeNotification
    let first = DeliveredNotification(at: 1000, app: "Slack", title: "Nitish", body: "ping")
    var list = mergeNotification([], first)
    check(list == [first], "a notification is recorded")
    list = mergeNotification(list, DeliveredNotification(at: 1001, app: "Slack", title: "Nitish", body: "ping"))
    check(list.count == 1 && list[0].at == 1001, "a banner republished while it animates is recorded once")
    list = mergeNotification(list, DeliveredNotification(at: 1002, app: "Mail", title: "Invoice", body: ""))
    check(list.count == 2 && list.last?.app == "Mail", "distinct notifications are kept in arrival order")
    check(mergeNotification(list, DeliveredNotification(at: 1003, app: "", title: "", body: "")) == list,
          "an empty banner is ignored")
    let later = DeliveredNotification(at: 1000 + notificationHorizonSeconds + 10, app: "Calendar", title: "Standup", body: "")
    check(mergeNotification(list, later) == [later], "notifications older than the horizon are dropped")
    var many = [DeliveredNotification]()
    for index in 0..<40 { many = mergeNotification(many, DeliveredNotification(at: Double(index), app: "A", title: "\(index)", body: "")) }
    check(many.count == notificationListLimit && many.last?.title == "39", "the list keeps only the most recent notifications")

    // notificationLine
    let now = 10_000.0
    check(notificationLine(DeliveredNotification(at: now - 30, app: "Slack", title: "Nitish", body: "can you look?"), now: now)
          == "Slack, just now: Nitish — can you look?", "a fresh notification reads as just now")
    check(notificationLine(DeliveredNotification(at: now - 600, app: "Mail", title: "Invoice", body: ""), now: now)
          == "Mail, 10m ago: Invoice", "minutes ago, and no dangling separator without a body")
    check(notificationLine(DeliveredNotification(at: now - 7300, app: "", title: "Reminder", body: ""), now: now)
          == "2h ago: Reminder", "hours ago, and no application when none was read")
    check(notificationLine(DeliveredNotification(at: now, app: "A", title: String(repeating: "y", count: 400), body: ""), now: now).count
          <= "A, just now: ".count + notificationTextLimit, "notification text is bounded")

    // notificationParts
    let parts = notificationParts(["Slack", "Slack", "Nitish Kovuru", "can you look at this?", "Close", "Reply"])
    check(parts.app == "Slack" && parts.title == "Nitish Kovuru" && parts.body == "can you look at this?",
          "a banner splits into app, title and body, without its buttons or repeats")
    check(notificationParts(["Calendar"]) == ("", "Calendar", ""), "a single text is the title")
    check(notificationParts([]) == ("", "", ""), "an empty banner has no parts")
    check(notificationParts(["  Messages  ", "Mom", "Call me\\nwhen you can"]).body == "Call me\\nwhen you can",
          "whitespace is collapsed and text kept")
}
