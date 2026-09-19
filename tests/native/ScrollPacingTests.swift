import Foundation

// Pure pacing checks for a spoken scroll (ScrollPacing.swift): the tick
// schedule, the speed words' bounds, the lease and the reports.
func scrollPacingChecks(_ check: (Bool, String) -> Void) {
    func near(_ a: Double, _ b: Double) -> Bool { abs(a - b) <= 1e-9 }
    let down = ScrollPacing(direction: .down, speed: 1)
    check(ScrollPacing.tickMs == 140 && near(ScrollPacing.baseLinesPerTick, 2) && near(ScrollPacing.linePixels, 16), "two lines of sixteen pixels every 140 ms")
    check(near(down.linesPerTick, 2) && down.deltaY == 32, "the base pace posts 32 pixels a tick, positive down the page")
    check(ScrollPacing(direction: .up, speed: 1).deltaY == -32, "scrolling up posts the same movement with the opposite sign")
    // About 230 px/s: a 900 px window passes in under four seconds, over three.
    let perSecond = Double(down.deltaY) * 1000 / Double(ScrollPacing.tickMs)
    check(perSecond > 200 && perSecond < 260, "the base pace is a reading pace (\(Int(perSecond)) px/s)")
    check(ScrollPacing(direction: .down, speed: 2).deltaY == 64 && near(ScrollPacing(direction: .down, speed: 2).linesPerTick, 4), "\"faster\" doubles the movement per tick")
    check(ScrollPacing(direction: .down, speed: 0.5).deltaY == 16, "\"slower\" halves it")
    check(near(ScrollPacing(direction: .down, speed: 32).speed, 4) && ScrollPacing(direction: .down, speed: 32).deltaY == 128, "the pace never exceeds four times the base")
    check(near(ScrollPacing(direction: .down, speed: 0.01).speed, 0.25) && ScrollPacing(direction: .down, speed: 0.01).deltaY == 8, "the pace never drops under a quarter of the base")
    check(near(ScrollPacing(direction: .down, speed: .nan).speed, 1) && near(ScrollPacing(direction: .down, speed: .infinity).speed, 1), "a speed that is not a number is the base pace")
    check(down.report["direction"] as? String == "down" && down.report["speed"] as? Double == 1 && down.report["linesPerTick"] as? Double == 2 && down.report["tickMs"] as? Int == 140,
          "the pace report carries direction, speed, lines per tick and the tick")

    var session = ScrollSession(id: 3, pacing: down, now: 100)
    check(ScrollSession.leaseSeconds == 90 && !session.expired(now: 189.9) && session.expired(now: 190), "a scroll nobody steers ends after 90 s")
    check(session.ticks == 0 && session.guardsSurface, "the first tick checks the surface before anything is posted")
    for _ in 0..<6 { session.posted() }
    check(session.ticks == 6 && !session.guardsSurface, "ticks in between post without the check")
    session.posted()
    check(session.guardsSurface && ScrollSession.guardEvery == 7, "every seventh tick (about once a second) checks the surface again")
    // Over a whole lease the base pace covers about 20,000 px, some twenty screens.
    let ticksInLease = Int(ScrollSession.leaseSeconds * 1000) / ScrollPacing.tickMs
    check(ticksInLease == 642 && ticksInLease * down.deltaY > 20000 && ticksInLease * down.deltaY < 21000, "a full lease is 642 ticks, about 20,500 px")
    session.steer(ScrollPacing(direction: .up, speed: 2), now: 150)
    check(session.pacing == ScrollPacing(direction: .up, speed: 2) && session.ticks == 7 && !session.expired(now: 239.9) && session.expired(now: 240), "steering flips or speeds the scroll, keeps the count and renews the lease")

    let started = session.started()
    check(started["started"] as? Bool == true && started["session"] as? Int == 3 && started["direction"] as? String == "up" && started["speed"] as? Double == 2, "the start reply names the session and its pace")
    let ended = session.ended(.input)
    check(ended["event"] as? String == "scroll_ended" && ended["session"] as? Int == 3 && ended["reason"] as? String == "input" && ended["ticks"] as? Int == 7 && ended["message"] == nil, "the end event names the session, the reason and the ticks")
    let failed = session.ended(.error, message: "Protected application. Switch applications and resume.")
    check(failed["reason"] as? String == "error" && failed["message"] as? String == "Protected application. Switch applications and resume.", "an error carries the helper's sentence")
    check(Set([ScrollEndReason.stop, .input, .appChanged, .limit, .error].map { $0.rawValue }) == ["stop", "input", "appChanged", "limit", "error"], "the end reasons are exactly stop, input, appChanged, limit and error")
    if let data = try? JSONSerialization.data(withJSONObject: ended, options: [.sortedKeys]) {
        check(String(decoding: data, as: UTF8.self) == #"{"event":"scroll_ended","reason":"input","session":3,"ticks":7}"#, "the end event serializes with no coordinates or window names")
    } else { check(false, "the end event serializes") }
}
