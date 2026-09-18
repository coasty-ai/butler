/**
 * Whether someone is at the Mac. It decides who hears or receives progress,
 * whether a texted task may take the screen right away, and when a watch may
 * bring a window forward. The rules are pure and tested; the service wraps
 * the native helper's "presence" method and treats a helper without it (or
 * one that fails), and a report older than two refreshes, as "unknown",
 * which every rule handles as "not away".
 */

export type Presence = "present" | "away" | "unknown";

/** The native helper's presence report (Controller.swift, "presence"). */
export interface PresenceReport {
  /** Seconds since any HID event, including ones the helper posted itself. */
  hidIdleSeconds: number;
  /** Seconds since unmarked manual input, or null with no event tap. */
  tapIdleSeconds: number | null;
  locked: boolean;
  displayAsleep: boolean;
}

/** Idle this long and the user counts as away. */
export const AWAY_AFTER_S = 120;
/** A texted or watched task may take the screen after this much idle time. */
export const TAKE_SCREEN_IDLE_MS = 20000;
/** Someone at the Mac may hand over the screen after this pause. */
export const USER_AT_MAC_IDLE_MS = 1000;
/** Our own posted input resets HID idle: within this window it says nothing. */
export const AGENT_INPUT_MASK_MS = 120000;
/** main.ts asks the helper this often while a run is active. */
export const PRESENCE_REFRESH_MS = 30000;
/**
 * A report older than this says nothing about now: the user may have come
 * back (or left) since the last refresh stopped with the run. Callers that
 * need an answer on an idle Mac call refresh() first.
 */
export const PRESENCE_STALE_MS = 2 * PRESENCE_REFRESH_MS;

/**
 * Presence from a report. A locked or sleeping Mac has nobody at it. The event
 * tap's idle time counts only unmarked input, so it decides outright; HID
 * idle counts the helper's own clicks and keys too, so it is unknown while
 * the agent has acted recently.
 */
export function presenceOf(
  r: PresenceReport | undefined,
  agentInputAgoMs: number,
): Presence {
  if (!r) return "unknown";
  if (r.locked || r.displayAsleep) return "away";
  if (r.tapIdleSeconds !== null)
    return r.tapIdleSeconds < AWAY_AFTER_S ? "present" : "away";
  if (agentInputAgoMs < AGENT_INPUT_MASK_MS) return "unknown";
  return r.hidIdleSeconds < AWAY_AFTER_S ? "present" : "away";
}

/**
 * Whether a task may take the screen now or should wait. Someone at the Mac
 * asked for it themselves (a click, a spoken turn), so it only waits for
 * their hands to leave the keyboard. A texted task or a watch that woke up
 * waits until the user is away; with presence unknown it waits for a long
 * pause it can see. An unknown pause (no helper, a masked or missing report)
 * keeps it waiting: nobody is at the Mac to notice a wrong guess, and the
 * user can always say "go" there or be away long enough.
 */
export function mayTakeScreen(
  p: Presence,
  idleMs: number | undefined,
  source: "user_at_mac" | "message" | "watch",
): "now" | "wait" {
  if (source === "user_at_mac")
    return idleMs === undefined || idleMs >= USER_AT_MAC_IDLE_MS
      ? "now"
      : "wait";
  if (p === "away") return "now";
  if (p === "present") return "wait";
  return idleMs !== undefined && idleMs >= TAKE_SCREEN_IDLE_MS ? "now" : "wait";
}

export interface PresenceService {
  current(): Presence;
  /** Milliseconds since the user's last input, when the helper can tell. */
  idleMs(): number | undefined;
  locked(): boolean;
  refresh(): Promise<Presence>;
}

/** A report from the helper, or undefined when the shape is not one. */
export function parsePresenceReport(
  value: unknown,
): PresenceReport | undefined {
  if (!value || typeof value !== "object") return undefined;
  const r = value as Record<string, unknown>;
  const seconds = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
  const hid = seconds(r.hidIdleSeconds);
  if (hid === undefined) return undefined;
  const tap =
    r.tapIdleSeconds === null || r.tapIdleSeconds === undefined
      ? null
      : seconds(r.tapIdleSeconds);
  if (tap === undefined) return undefined;
  return {
    hidIdleSeconds: hid,
    tapIdleSeconds: tap,
    locked: r.locked === true,
    displayAsleep: r.displayAsleep === true,
  };
}

export function createPresenceService(o: {
  /** NativeController.request; rejects until the helper has the method. */
  request: (method: string) => Promise<unknown>;
  /** When the agent last posted input itself, if it has. */
  agentInputAt: () => number | undefined;
  now?: () => number;
}): PresenceService {
  const now = o.now ?? Date.now;
  let report: PresenceReport | undefined;
  let reportAt = 0;
  const agentInputAgo = () => {
    const at = o.agentInputAt();
    return at === undefined ? Infinity : Math.max(0, now() - at);
  };
  // The last report, unless the refresh timer stopped long enough ago that it
  // may describe someone who has since come or gone.
  const fresh = () =>
    report && now() - reportAt < PRESENCE_STALE_MS ? report : undefined;
  return {
    current: () => presenceOf(fresh(), agentInputAgo()),
    idleMs: () => {
      const r = fresh();
      if (!r) return undefined;
      if (r.tapIdleSeconds !== null)
        return r.tapIdleSeconds * 1000 + (now() - reportAt);
      if (agentInputAgo() < AGENT_INPUT_MASK_MS) return undefined;
      return r.hidIdleSeconds * 1000 + (now() - reportAt);
    },
    locked: () => fresh()?.locked === true,
    async refresh() {
      try {
        report = parsePresenceReport(await o.request("presence"));
      } catch {
        // No method yet, or a helper restart: unknown, never a stale guess.
        report = undefined;
      }
      reportAt = now();
      return presenceOf(report, agentInputAgo());
    },
  };
}
