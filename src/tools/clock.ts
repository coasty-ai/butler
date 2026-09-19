import type { ToolClock } from "../core/tools";

/**
 * The moment and time zone tool dates are read against: the fast-path
 * grammar and the model's `context.tools.now` both resolve "tomorrow at 6"
 * from this, never from Date.now() on their own.
 */
export function toolClock(now: Date = new Date()): ToolClock {
  return { now, zone: Intl.DateTimeFormat().resolvedOptions().timeZone };
}
