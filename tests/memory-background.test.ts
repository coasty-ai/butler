import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryAccess } from "../src/memory/access";
import { learnFromRun } from "../src/memory/learn";
import {
  BACKGROUND_RETRY_DAYS,
  MemoryStore,
  backgroundKnowledge,
  emptyMemory,
  recordBackgroundIn,
} from "../src/memory/store";
import type { BackgroundObservation, LearnInput } from "../src/core/memory";

const SLACK = "com.tinyspeck.slackmacgap";
const NOW = new Date("2026-09-19T12:00:00.000Z");
const daysAgo = (n: number) =>
  new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
const seen = (
  route: BackgroundObservation["route"],
  verdict: BackgroundObservation["verdict"],
): BackgroundObservation => ({
  appId: SLACK,
  appName: "Slack",
  route,
  verdict,
});
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("what a background run teaches memory (design §5)", () => {
  it("stores works after one observation and noop only after two consistent ones", () => {
    const data = emptyMemory();
    expect(
      recordBackgroundIn(data, SLACK, "Slack", [seen("write", "noop")], NOW),
    ).toBeUndefined();
    expect(data.apps[SLACK]).toBeUndefined();
    expect(
      recordBackgroundIn(
        data,
        SLACK,
        "Slack",
        [seen("write", "noop"), seen("write", "noop"), seen("press", "works")],
        NOW,
      ),
    ).toEqual({ write: "noop", press: "works", observedAt: NOW.toISOString() });
    expect(data.apps[SLACK]).toMatchObject({ name: "Slack", count: 1 });
  });
  it("lets one works outweigh misses, keeps other routes and refreshes the time", () => {
    const data = emptyMemory();
    recordBackgroundIn(
      data,
      SLACK,
      "Slack",
      [seen("write", "noop"), seen("write", "noop")],
      new Date(daysAgo(3)),
    );
    recordBackgroundIn(
      data,
      SLACK,
      undefined,
      [seen("post", "noop"), seen("post", "works"), seen("keys", "echo")],
      NOW,
    );
    expect(data.apps[SLACK].background).toEqual({
      write: "noop",
      post: "works",
      observedAt: NOW.toISOString(),
    });
    expect(data.apps[SLACK].count).toBe(1);
  });
  it("gives the runner the routes to skip, and retries a verdict after thirty days", () => {
    const data = emptyMemory();
    recordBackgroundIn(
      data,
      SLACK,
      "Slack",
      [seen("write", "noop"), seen("write", "noop"), seen("press", "works")],
      NOW,
    );
    recordBackgroundIn(
      data,
      "com.apple.Notes",
      "Notes",
      [seen("press", "works")],
      NOW,
    );
    recordBackgroundIn(
      data,
      "com.apple.TextEdit",
      "TextEdit",
      [seen("keys", "noop"), seen("keys", "noop")],
      new Date(daysAgo(BACKGROUND_RETRY_DAYS + 1)),
    );
    expect(backgroundKnowledge(data, NOW)).toEqual({
      [SLACK]: { write: "noop" },
    });
    expect(
      backgroundKnowledge(data, new Date(daysAgo(BACKGROUND_RETRY_DAYS - 1))),
    ).toEqual({
      [SLACK]: { write: "noop" },
      "com.apple.TextEdit": { keys: "noop" },
    });
  });
  it("learns from a run whatever became of it, and survives a save", () => {
    const dir = mkdtempSync(join(tmpdir(), "oa-memory-bg-"));
    dirs.push(dir);
    const key = randomBytes(32);
    const store = new MemoryStore(dir, key, () => NOW);
    const input: LearnInput = {
      runId: "11111111-1111-4111-8111-111111111111",
      task: "tell prateek i'm late in slack",
      status: "failed",
      synthetic: false,
      summary: "Runtime budget reached.",
      corrections: [],
      steps: [],
      appsSeen: [SLACK],
      usage: { inputTokens: 1, outputTokens: 1, cost: 0 },
      background: [
        seen("write", "noop"),
        seen("write", "noop"),
        seen("press", "works"),
        { appId: "", route: "post", verdict: "noop" },
      ],
    };
    store.update((data) => learnFromRun(data, input, NOW));
    store.flush();
    const again = new MemoryStore(dir, key, () => NOW).data();
    expect(again.apps[SLACK].background).toEqual({
      write: "noop",
      press: "works",
      observedAt: NOW.toISOString(),
    });
    expect(Object.keys(again.apps)).toEqual([SLACK]);
  });
  it("recall carries the knowledge beside the model's context, never inside it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oa-memory-bg-"));
    dirs.push(dir);
    const store = new MemoryStore(dir, randomBytes(32), () => NOW);
    store.update((data) =>
      recordBackgroundIn(
        data,
        SLACK,
        "Slack",
        [seen("write", "noop"), seen("write", "noop")],
        NOW,
      ),
    );
    const access = createMemoryAccess(store, async () => undefined, {
      now: () => NOW,
    });
    const recall = await access.recall("reply to prateek in slack");
    expect(recall.background).toEqual({ [SLACK]: { write: "noop" } });
    expect(JSON.stringify(recall.context)).not.toContain("noop");
    const empty = createMemoryAccess(
      new MemoryStore(dir, randomBytes(32), () => NOW),
      async () => undefined,
    );
    expect((await empty.recall("anything")).background).toBeUndefined();
  });
});
