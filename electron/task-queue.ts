/**
 * Tasks waiting for the current run to end: "after that, check my email" by
 * voice, a texted task while something is running, a wake from a watch. One
 * queue for every channel, so the order is the order they were asked in. It
 * is small and short-lived on purpose: three tasks at most, forgotten after
 * two hours, and a user's stop drops all of them (main.ts clears it). It never
 * holds credentials: a queued task is spoken back, listed in the run view and
 * (from increment 3) shown to the dialog model, long before the start path
 * would refuse it.
 */
import { scanText } from "../src/core/sanitize";
import type { RunOrigin, TaskSource } from "../src/core/schema";
import type { QueuedTask } from "../src/assistant/types";

export type { QueuedTask };

export const TASK_QUEUE_MAX = 3;
export const TASK_QUEUE_TTL_MS = 2 * 60 * 60 * 1000;

export class TaskQueue {
  private tasks: QueuedTask[] = [];
  private counter = 0;

  /** Drops tasks older than the TTL; called before every read or write. */
  private prune(now: number) {
    this.tasks = this.tasks.filter((t) => now - t.at < TASK_QUEUE_TTL_MS);
  }

  add(
    text: string,
    origin: RunOrigin,
    now: number,
    taskSource?: TaskSource,
  ): { position: number } | { full: true } | { refused: "credentials" } {
    if (scanText(text).some((f) => f.action === "BLOCK_UPLOAD"))
      return { refused: "credentials" };
    this.prune(now);
    if (this.tasks.length >= TASK_QUEUE_MAX) return { full: true };
    this.tasks.push({
      id: `q${++this.counter}-${now.toString(36)}`,
      text: text.trim(),
      origin,
      ...(taskSource ? { taskSource } : {}),
      at: now,
    });
    return { position: this.tasks.length };
  }

  /** Takes the oldest live task off the queue. */
  next(now: number): QueuedTask | undefined {
    this.prune(now);
    return this.tasks.shift();
  }

  /** Empties the queue and says how many tasks were dropped. */
  clear(): number {
    const dropped = this.tasks.length;
    this.tasks = [];
    return dropped;
  }

  list(now: number): QueuedTask[] {
    this.prune(now);
    return this.tasks.map((t) => ({ ...t }));
  }
}
