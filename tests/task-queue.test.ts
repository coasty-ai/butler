import { describe, expect, it } from "vitest";
import {
  TASK_QUEUE_MAX,
  TASK_QUEUE_TTL_MS,
  TaskQueue,
} from "../electron/task-queue";

describe("task queue", () => {
  const now = 1_000_000;

  it("caps at three", () => {
    const q = new TaskQueue();
    expect(TASK_QUEUE_MAX).toBe(3);
    expect(q.add("one", "voice", now)).toEqual({ position: 1 });
    expect(q.add("two", "message", now + 1)).toEqual({ position: 2 });
    expect(q.add("three", "voice", now + 2)).toEqual({ position: 3 });
    expect(q.add("four", "voice", now + 3)).toEqual({ full: true });
    expect(q.list(now + 3).map((t) => t.text)).toEqual(["one", "two", "three"]);
    // A slot frees up once one is taken.
    q.next(now + 4);
    expect(q.add("four", "voice", now + 5)).toEqual({ position: 3 });
  });

  it("expires after two hours", () => {
    const q = new TaskQueue();
    expect(TASK_QUEUE_TTL_MS).toBe(2 * 60 * 60 * 1000);
    q.add("old", "voice", now);
    q.add("fresh", "voice", now + 60_000);
    expect(q.list(now + TASK_QUEUE_TTL_MS - 1).map((t) => t.text)).toEqual([
      "old",
      "fresh",
    ]);
    expect(q.list(now + TASK_QUEUE_TTL_MS).map((t) => t.text)).toEqual([
      "fresh",
    ]);
    // Expired tasks never come back out, and never count against the cap.
    expect(q.next(now + TASK_QUEUE_TTL_MS + 60_000)).toBeUndefined();
    q.add("a", "voice", now);
    q.add("b", "voice", now);
    q.add("c", "voice", now);
    expect(q.add("d", "voice", now + TASK_QUEUE_TTL_MS)).toEqual({
      position: 1,
    });
  });

  it("clear returns the count", () => {
    const q = new TaskQueue();
    expect(q.clear()).toBe(0);
    q.add("one", "voice", now);
    q.add("two", "voice", now);
    expect(q.clear()).toBe(2);
    expect(q.list(now)).toEqual([]);
    expect(q.next(now)).toBeUndefined();
  });

  it("next is first in, first out and keeps each task's provenance", () => {
    const q = new TaskQueue();
    q.add("  first  ", "voice", now, "user_words_unsure");
    q.add("second", "message", now + 1, "user_words");
    q.add("third", "voice", now + 2);
    const first = q.next(now + 3);
    expect(first).toMatchObject({
      text: "first",
      origin: "voice",
      taskSource: "user_words_unsure",
      at: now,
    });
    expect(first?.id).toMatch(/^q1-/);
    expect(q.next(now + 3)).toMatchObject({
      text: "second",
      origin: "message",
      taskSource: "user_words",
    });
    const third = q.next(now + 3);
    expect(third).toMatchObject({ text: "third", origin: "voice" });
    expect(third && "taskSource" in third).toBe(false);
    expect(q.next(now + 3)).toBeUndefined();
  });

  it("never holds credentials", () => {
    // A queued task is spoken back, listed in the run view and later shown
    // to the dialog model, so the start path's refusal comes too late.
    const q = new TaskQueue();
    expect(
      q.add("log in to the bank, password: hunter2!", "voice", now),
    ).toEqual({ refused: "credentials" });
    expect(
      q.add("use api_key=sk-abcdefghijklmnop to fetch it", "message", now),
    ).toEqual({ refused: "credentials" });
    expect(q.list(now)).toEqual([]);
    // Prose that only mentions a password is a task like any other.
    expect(q.add("change my password in Settings", "voice", now)).toEqual({
      position: 1,
    });
    // The refusal comes before the cap, so a full queue still says why.
    q.add("two", "voice", now);
    q.add("three", "voice", now);
    expect(q.add("password: hunter2!", "voice", now)).toEqual({
      refused: "credentials",
    });
  });

  it("hands out copies, so callers cannot edit the queue", () => {
    const q = new TaskQueue();
    q.add("one", "voice", now);
    const listed = q.list(now);
    listed[0].text = "changed";
    listed.length = 0;
    expect(q.list(now).map((t) => t.text)).toEqual(["one"]);
  });
});
