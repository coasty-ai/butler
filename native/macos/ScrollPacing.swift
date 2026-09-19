import Foundation

// A spoken "scroll down": the controller scrolls the window in front gently
// until the user says stop, touches the mouse or keyboard, brings another
// window forward, or the lease runs out. The pacing rules here are pure;
// Controller.swift's scroll session applies them on a timer, and
// tests/native/ScrollPacingTests.swift pins them.

enum ScrollDirection: String { case down, up }
enum ScrollEndReason: String { case stop, input, appChanged, limit, error }

struct ScrollPacing: Equatable {
    /// Two lines of about sixteen pixels every 140 ms before any speed word: a
    /// reading pace, a screen in about four seconds.
    static let baseLinesPerTick = 2.0
    static let linePixels = 16.0
    static let tickMs = 140
    /// "Faster" doubles and "slower" halves, between a quarter and four times the base pace.
    static let minSpeed = 0.25, maxSpeed = 4.0
    let direction: ScrollDirection
    let speed: Double
    init(direction: ScrollDirection, speed: Double) {
        self.direction = direction
        self.speed = speed.isFinite ? min(max(speed, ScrollPacing.minSpeed), ScrollPacing.maxSpeed) : 1
    }
    var linesPerTick: Double { ScrollPacing.baseLinesPerTick * speed }
    /// The wheel movement one tick posts, in the scroll action's sign: positive moves down the page.
    var deltaY: Int { Int((linesPerTick * ScrollPacing.linePixels).rounded()) * (direction == .down ? 1 : -1) }
    var report: [String: Any] {
        ["direction": direction.rawValue, "speed": speed, "linesPerTick": linesPerTick, "tickMs": ScrollPacing.tickMs]
    }
}

/// One scroll from its spoken request to its end. The id ties the end report
/// to the start it answers, so a late report never ends the next scroll.
struct ScrollSession: Equatable {
    /// A scroll nobody steers ends on its own after this long; each spoken word renews it.
    static let leaseSeconds: TimeInterval = 90
    /// The protected-surface floors are checked again about once a second (every seventh tick).
    static let guardEvery = 7
    let id: Int
    private(set) var pacing: ScrollPacing
    private(set) var leaseUntil: TimeInterval
    private(set) var ticks = 0
    init(id: Int, pacing: ScrollPacing, now: TimeInterval) {
        self.id = id; self.pacing = pacing; leaseUntil = now + ScrollSession.leaseSeconds
    }
    /// New words while scrolling: the direction or pace changes and the lease starts over; the ticks keep counting.
    mutating func steer(_ pacing: ScrollPacing, now: TimeInterval) {
        self.pacing = pacing; leaseUntil = now + ScrollSession.leaseSeconds
    }
    func expired(now: TimeInterval) -> Bool { now >= leaseUntil }
    /// Whether the tick about to post first checks the surface again.
    var guardsSurface: Bool { ticks % ScrollSession.guardEvery == 0 }
    mutating func posted() { ticks += 1 }
    /// The reply to the request that started or steered this scroll.
    func started() -> [String: Any] {
        var result = pacing.report
        result["started"] = true; result["session"] = id
        return result
    }
    /// The event that reports its end: why, and how many wheel movements it posted.
    func ended(_ reason: ScrollEndReason, message: String? = nil) -> [String: Any] {
        var event: [String: Any] = ["event": "scroll_ended", "session": id, "reason": reason.rawValue, "ticks": ticks]
        if let message = message { event["message"] = message }
        return event
    }
}
