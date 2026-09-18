import { describe, expect, it } from "vitest";
import {
  AGENT_INPUT_MASK_MS,
  AWAY_AFTER_S,
  PRESENCE_REFRESH_MS,
  PRESENCE_STALE_MS,
  TAKE_SCREEN_IDLE_MS,
  USER_AT_MAC_IDLE_MS,
  createPresenceService,
  mayTakeScreen,
  parsePresenceReport,
  presenceOf,
  type PresenceReport,
} from "../electron/presence";

const report = (over: Partial<PresenceReport> = {}): PresenceReport => ({
  hidIdleSeconds: 5,
  tapIdleSeconds: 5,
  locked: false,
  displayAsleep: false,
  ...over,
});
/** Long after any input the agent posted itself. */
const quiet = AGENT_INPUT_MASK_MS * 10;

describe("presence rules", () => {
  it("locked or asleep is away", () => {
    expect(presenceOf(report({ locked: true }), quiet)).toBe("away");
    expect(presenceOf(report({ displayAsleep: true }), quiet)).toBe("away");
    // Even with fresh input: a locked screen has nobody at it.
    expect(presenceOf(report({ locked: true, tapIdleSeconds: 0 }), 0)).toBe(
      "away",
    );
  });

  it("tap idle decides during a run", () => {
    expect(presenceOf(report({ tapIdleSeconds: AWAY_AFTER_S - 1 }), 0)).toBe(
      "present",
    );
    expect(presenceOf(report({ tapIdleSeconds: AWAY_AFTER_S }), 0)).toBe(
      "away",
    );
    // The tap counts only the user's own input, so recent agent input does
    // not make it unknown.
    expect(
      presenceOf(report({ tapIdleSeconds: 1, hidIdleSeconds: 1 }), 0),
    ).toBe("present");
  });

  it("recent agent input makes HID idle unknown", () => {
    const noTap = report({ tapIdleSeconds: null, hidIdleSeconds: 1 });
    expect(presenceOf(noTap, AGENT_INPUT_MASK_MS - 1)).toBe("unknown");
    expect(presenceOf(noTap, AGENT_INPUT_MASK_MS)).toBe("present");
    expect(
      presenceOf(
        report({ tapIdleSeconds: null, hidIdleSeconds: AWAY_AFTER_S }),
        AGENT_INPUT_MASK_MS,
      ),
    ).toBe("away");
  });

  it("no report is unknown", () => {
    expect(presenceOf(undefined, 0)).toBe("unknown");
    expect(presenceOf(undefined, quiet)).toBe("unknown");
  });

  it("lets someone at the Mac hand over the screen after a short pause", () => {
    expect(mayTakeScreen("present", USER_AT_MAC_IDLE_MS, "user_at_mac")).toBe(
      "now",
    );
    expect(
      mayTakeScreen("present", USER_AT_MAC_IDLE_MS - 1, "user_at_mac"),
    ).toBe("wait");
    // No helper to ask: the user asked for it themselves.
    expect(mayTakeScreen("unknown", undefined, "user_at_mac")).toBe("now");
  });

  it("makes texted tasks and watches wait while the user is present", () => {
    for (const source of ["message", "watch"] as const) {
      expect(mayTakeScreen("present", 60_000, source)).toBe("wait");
      expect(mayTakeScreen("away", 0, source)).toBe("now");
      expect(mayTakeScreen("unknown", TAKE_SCREEN_IDLE_MS, source)).toBe("now");
      expect(mayTakeScreen("unknown", TAKE_SCREEN_IDLE_MS - 1, source)).toBe(
        "wait",
      );
      // An unknown pause (no helper, no report, a masked HID idle) is not
      // an absent user: the task waits for "go" at the Mac or a real absence.
      expect(mayTakeScreen("unknown", undefined, source)).toBe("wait");
      expect(mayTakeScreen("present", undefined, source)).toBe("wait");
      expect(mayTakeScreen("away", undefined, source)).toBe("now");
    }
  });

  it("accepts only a well-formed helper report", () => {
    expect(parsePresenceReport(report())).toEqual(report());
    expect(
      parsePresenceReport({ hidIdleSeconds: 3, tapIdleSeconds: null }),
    ).toEqual({
      hidIdleSeconds: 3,
      tapIdleSeconds: null,
      locked: false,
      displayAsleep: false,
    });
    for (const bad of [
      undefined,
      null,
      "present",
      {},
      { hidIdleSeconds: -1, tapIdleSeconds: null },
      { hidIdleSeconds: NaN, tapIdleSeconds: null },
      { hidIdleSeconds: 3, tapIdleSeconds: "soon" },
      { hidIdleSeconds: "3", tapIdleSeconds: null },
    ])
      expect(parsePresenceReport(bad)).toBeUndefined();
  });
});

describe("presence service", () => {
  function service(
    reply: () => unknown,
    agentInputAt?: () => number | undefined,
  ) {
    let now = 100_000;
    const calls: string[] = [];
    const s = createPresenceService({
      request: async (method) => {
        calls.push(method);
        return reply();
      },
      agentInputAt: agentInputAt ?? (() => undefined),
      now: () => now,
    });
    return { s, calls, advance: (ms: number) => (now += ms) };
  }

  it("is unknown until the helper answers, and after it fails", async () => {
    const { s, calls } = service(() => {
      throw new Error("Unknown controller method.");
    });
    expect(s.current()).toBe("unknown");
    expect(s.idleMs()).toBeUndefined();
    expect(s.locked()).toBe(false);
    expect(await s.refresh()).toBe("unknown");
    expect(calls).toEqual(["presence"]);
    expect(s.current()).toBe("unknown");
  });

  it("reads the report and ages its idle time", async () => {
    let reply: unknown = report({ tapIdleSeconds: 2 });
    const { s, advance } = service(() =>
      typeof reply === "function" ? reply() : reply,
    );
    expect(await s.refresh()).toBe("present");
    expect(s.idleMs()).toBe(2000);
    advance(1500);
    expect(s.idleMs()).toBe(3500);
    reply = report({ tapIdleSeconds: 400, locked: true });
    expect(await s.refresh()).toBe("away");
    expect(s.locked()).toBe(true);
    // A failed refresh forgets the old report rather than keeping a stale one.
    reply = () => {
      throw new Error("Desktop control restarted.");
    };
    expect(await s.refresh()).toBe("unknown");
    expect(s.idleMs()).toBeUndefined();
    expect(s.locked()).toBe(false);
    reply = "garbage";
    expect(await s.refresh()).toBe("unknown");
  });

  it("forgets a report once the refresh timer has stopped for two intervals", async () => {
    // The run ended with the user away; refreshes stop with it. Half an hour
    // later a text must not find that "away" still on offer.
    expect(PRESENCE_STALE_MS).toBe(2 * PRESENCE_REFRESH_MS);
    const { s, advance } = service(() =>
      report({ tapIdleSeconds: 400, locked: true }),
    );
    expect(await s.refresh()).toBe("away");
    advance(PRESENCE_STALE_MS - 1);
    expect(s.current()).toBe("away");
    expect(s.idleMs()).toBe(400_000 + PRESENCE_STALE_MS - 1);
    expect(s.locked()).toBe(true);
    advance(1);
    expect(s.current()).toBe("unknown");
    expect(s.idleMs()).toBeUndefined();
    expect(s.locked()).toBe(false);
    // A refresh brings it back.
    expect(await s.refresh()).toBe("away");
    expect(s.current()).toBe("away");
  });

  it("hides HID idle time while the agent has just acted", async () => {
    let agentAt: number | undefined = 100_000 - 1000;
    const { s, advance } = service(
      () => report({ tapIdleSeconds: null, hidIdleSeconds: 1 }),
      () => agentAt,
    );
    expect(await s.refresh()).toBe("unknown");
    expect(s.idleMs()).toBeUndefined();
    agentAt = undefined;
    expect(s.current()).toBe("present");
    advance(500);
    expect(s.idleMs()).toBe(1500);
  });
});
