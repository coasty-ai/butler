/**
 * The work log (.data/design/observer.md §3): an encrypted round trip under
 * the vault key with AAD "observer" (another AAD or key reads nothing), the
 * tier rules (words only at "text", a picture only at "pixels", an excluded
 * frame stripped to its code), redaction and the credential drop, the day's
 * byte cap, retention and the picture's 24 h expiry, pause, forget, and the
 * digest's counts in the shape the report reads.
 */
import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seal, unseal } from "../src/storage/vault";
import {
  carriesCredential,
  createWorkLog,
  dayKey,
  IMAGE_TTL_MS,
  MAX_DAY_BYTES,
  msUntilMidnight,
  OBSERVER_AAD,
  prepareEvent,
  shiftDay,
  type WorkLog,
} from "../src/observer/log";
import {
  emptyDayDigest,
  memoryDigest,
  observedEventSchema,
} from "../src/observer/types";
import { emptyMemory } from "../src/memory/store";
import type { ObserverTier } from "../src/core/schema";

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "oa-observer-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date(2026, 8, 19, 10, 30); // local time
const TODAY = dayKey(NOW);
const at = (h: number, m = 0) => new Date(2026, 8, 19, h, m).getTime();
const frame = (over: Record<string, unknown> = {}) => ({
  event: "observe_frame",
  atMs: at(9, 2),
  appId: "com.tinyspeck.slackmacgap",
  appName: "Slack",
  windowTitle: "general - Acme",
  focusedRole: "AXTextArea",
  focusedLabel: "Message #general",
  controls: [{ role: "AXButton", label: "Send" }],
  ...over,
});
const action = (over: Record<string, unknown> = {}) => ({
  event: "observe_action",
  atMs: at(9, 3),
  appId: "com.tinyspeck.slackmacgap",
  kind: "click",
  target: { role: "AXButton", label: "Send" },
  ...over,
});
function log(
  dir: string,
  key: Buffer,
  o: {
    tier?: ObserverTier;
    retentionDays?: number;
    now?: () => Date;
    onDayEnd?: (day: string) => void;
    memory?: () => ReturnType<typeof emptyMemory> | undefined;
  } = {},
): WorkLog {
  let tier = o.tier ?? "structure";
  const l = createWorkLog({
    directory: join(dir, "observer"),
    key,
    tier: () => tier,
    retentionDays: () => o.retentionDays ?? 14,
    now: o.now ?? (() => NOW),
    onDayEnd: o.onDayEnd,
    memory: o.memory,
  });
  (l as WorkLog & { setTier: (t: ObserverTier) => void }).setTier = (t) => {
    tier = t;
  };
  return l;
}

describe("work log encryption", () => {
  it("writes one sealed line per event under AAD observer and reads it back", () => {
    const dir = tempDir();
    const key = randomBytes(32);
    const l = log(dir, key);
    expect(l.append(frame())).toMatchObject({ written: true });
    expect(l.append(action())).toMatchObject({ written: true });
    const path = join(dir, "observer", `${TODAY}.jsonl.enc`);
    expect(existsSync(path)).toBe(true);
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("slack");
    expect(raw).not.toContain("general");
    const lines = raw.split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    const first = JSON.parse(
      unseal(key, Buffer.from(lines[0], "base64"), OBSERVER_AAD).toString(),
    );
    expect(first.appId).toBe("com.tinyspeck.slackmacgap");
    expect(first.windowTitle).toBe("general - Acme");
    expect(() =>
      unseal(key, Buffer.from(lines[0], "base64"), "memory"),
    ).toThrow();
    expect(() =>
      unseal(randomBytes(32), Buffer.from(lines[0], "base64"), OBSERVER_AAD),
    ).toThrow();
    const events = l.read(TODAY);
    expect(events.map((e) => e.event)).toEqual([
      "observe_frame",
      "observe_action",
    ]);
    // A new instance over the same folder reads the same day.
    expect(log(dir, key).read(TODAY)).toHaveLength(2);
    expect(log(dir, randomBytes(32)).read(TODAY)).toHaveLength(0);
  });

  it("skips a corrupt line and a line under another AAD", () => {
    const dir = tempDir();
    const key = randomBytes(32);
    const l = log(dir, key);
    l.append(frame());
    const path = join(dir, "observer", `${TODAY}.jsonl.enc`);
    writeFileSync(
      path,
      readFileSync(path, "utf8") +
        "not-base64-at-all\n" +
        seal(key, Buffer.from(JSON.stringify(frame())), "memory").toString(
          "base64",
        ) +
        "\n",
    );
    expect(l.read(TODAY)).toHaveLength(1);
  });
});

describe("prepareEvent", () => {
  it("keeps the words only at tier text and above, the picture only at pixels", () => {
    const raw = frame({ textDigest: "hello team", image: "AAAA" });
    const structure = prepareEvent(raw, "structure");
    expect("event" in structure && structure.event).toMatchObject({
      appId: "com.tinyspeck.slackmacgap",
    });
    expect("event" in structure && structure.event).not.toHaveProperty(
      "textDigest",
    );
    expect("event" in structure && structure.event).not.toHaveProperty("image");
    const text = prepareEvent(raw, "text");
    expect("event" in text && text.event).toHaveProperty(
      "textDigest",
      "hello team",
    );
    expect("event" in text && text.event).not.toHaveProperty("image");
    const pixels = prepareEvent(raw, "pixels");
    expect("event" in pixels && pixels.event).toHaveProperty("image", "AAAA");
  });

  it("strips an excluded frame to its code, time, application and run id", () => {
    const r = prepareEvent(
      frame({ excluded: "own_run", runId: "run-1", textDigest: "secret" }),
      "text",
    );
    expect(r).toEqual({
      event: {
        event: "observe_frame",
        atMs: at(9, 2),
        excluded: "own_run",
        controls: [],
        appId: "com.tinyspeck.slackmacgap",
        runId: "run-1",
      },
    });
    const locked = prepareEvent(
      { event: "observe_frame", atMs: 1, excluded: "locked" },
      "pixels",
    );
    expect(locked).toEqual({
      event: {
        event: "observe_frame",
        atMs: 1,
        excluded: "locked",
        controls: [],
      },
    });
    // A run id on a frame that is not own_run is not kept.
    const stray = prepareEvent(frame({ runId: "run-2" }), "structure");
    expect("event" in stray && stray.event).not.toHaveProperty("runId");
  });

  it("redacts every string and drops a frame that carries a credential", () => {
    const token = "sk-" + "a".repeat(40);
    expect(carriesCredential({ a: [{ b: `key ${token}` }] })).toBe(true);
    expect(carriesCredential(frame())).toBe(false);
    expect(
      prepareEvent(frame({ windowTitle: `Notes ${token}` }), "text"),
    ).toEqual({
      drop: "credential",
    });
    expect(
      prepareEvent(frame({ textDigest: `password=hunter2hunter2` }), "text"),
    ).toEqual({ drop: "credential" });
    expect(
      prepareEvent(
        action({
          typed: { field: `pw ${token}`, chars: 3, ms: 10 },
          kind: "typing",
        }),
        "structure",
      ),
    ).toEqual({ drop: "credential" });
    // The picture is bytes, not text: a base64 run is not scanned as a secret.
    const picture = prepareEvent(
      frame({ image: "sk-" + "A".repeat(60) }),
      "pixels",
    );
    expect("event" in picture).toBe(true);
    // Nothing else of the stream is accepted.
    expect(prepareEvent({ event: "capture" }, "structure")).toEqual({
      drop: "invalid",
    });
    expect(prepareEvent(frame({ atMs: -1 }), "structure")).toEqual({
      drop: "invalid",
    });
    expect(prepareEvent(action({ kind: "keystroke" }), "structure")).toEqual({
      drop: "invalid",
    });
  });

  it("drops unknown keys from the source rather than refusing the frame", () => {
    const r = prepareEvent(frame({ extra: "field" }), "structure");
    expect("event" in r && r.event).not.toHaveProperty("extra");
    expect(observedEventSchema.safeParse(frame()).success).toBe(true);
  });
});

describe("work log rules", () => {
  it("counts a credential drop and a paused frame and writes neither", () => {
    const dir = tempDir();
    const l = log(dir, randomBytes(32));
    const token = "sk-" + "b".repeat(40);
    expect(l.append(frame({ windowTitle: token }))).toEqual({
      written: false,
      reason: "credential",
    });
    l.pause();
    expect(l.paused).toBe(true);
    expect(l.append(frame())).toEqual({ written: false, reason: "paused" });
    l.resume();
    expect(l.append(frame())).toMatchObject({ written: true });
    expect(l.append({ nonsense: true })).toEqual({
      written: false,
      reason: "invalid",
    });
    const d = l.dayDigest();
    expect(d.frames).toBe(1);
    expect(d.dropped).toEqual({
      size: 0,
      credential: 1,
      invalid: 1,
      paused: 1,
      helper: 0,
    });
    expect(d.framesDropped).toBe(3);
    expect(d.bytesDropped).toBeGreaterThan(0);
    expect(l.read(TODAY)).toHaveLength(1);
  });

  it("drops frames past the day's byte cap and counts them", () => {
    const dir = tempDir();
    const l = log(dir, randomBytes(32));
    // A frame near the cap: the schema admits a picture up to 600 KB; a few
    // of them at tier pixels cross 50 MB quickly enough for a test.
    (l as WorkLog & { setTier: (t: ObserverTier) => void }).setTier("pixels");
    const big = "A".repeat(600_000);
    let written = 0;
    let dropped = 0;
    for (let i = 0; i < 90; i++) {
      const r = l.append(frame({ image: big, atMs: at(9) + i }));
      if (r.written) written += 1;
      else {
        expect(r.reason).toBe("size");
        dropped += 1;
      }
    }
    expect(dropped).toBeGreaterThan(0);
    const d = l.dayDigest();
    expect(d.frames).toBe(written);
    expect(d.dropped.size).toBe(dropped);
    expect(d.bytesWritten).toBeLessThanOrEqual(MAX_DAY_BYTES);
    expect(d.images).toBe(written);
  }, 60_000);

  it("deletes days past retention and strips pictures older than 24 h", () => {
    const dir = tempDir();
    const key = randomBytes(32);
    let now = new Date(2026, 8, 5, 9);
    const l = log(dir, key, { tier: "pixels", now: () => now });
    // Day 1: a frame with a picture.
    expect(
      l.append(frame({ image: "PIC1", atMs: now.getTime() })),
    ).toMatchObject({ written: true });
    const day1 = dayKey(now);
    // 13 days later: still kept, picture gone.
    now = new Date(2026, 8, 18, 9);
    const l2 = log(dir, key, { tier: "pixels", now: () => now });
    l2.append(frame({ image: "PIC2", atMs: now.getTime() }));
    const day2 = dayKey(now);
    expect(l2.days()).toEqual([day1, day2]);
    const pass = l2.applyRetention();
    expect(pass.removed).toEqual([]);
    expect(pass.imagesExpired).toBe(1);
    const old = l2.read(day1);
    expect(old).toHaveLength(1);
    expect(old[0]).not.toHaveProperty("image");
    expect(l2.read(day2)[0]).toHaveProperty("image", "PIC2");
    expect(l2.dayDigest(day1).images).toBe(0);
    expect(l2.dayDigest().images).toBe(1);
    // One more day: day1 is the 15th day back and goes.
    now = new Date(2026, 8, 19, 0, 0, 2);
    const l3 = log(dir, key, { tier: "pixels", now: () => now });
    const pass3 = l3.applyRetention();
    expect(pass3.removed).toEqual([day1]);
    expect(l3.days()).toEqual([day2]);
    // A shorter retention takes more.
    const l4 = log(dir, key, { retentionDays: 1, now: () => now });
    expect(l4.applyRetention().removed).toEqual([day2]);
    expect(readdirSync(join(dir, "observer"))).toEqual([]);
  });

  it("expires a picture past IMAGE_TTL_MS within the same file and keeps the frame", () => {
    const dir = tempDir();
    const key = randomBytes(32);
    let now = new Date(2026, 8, 19, 1);
    const l = log(dir, key, { tier: "pixels", now: () => now });
    l.append(frame({ image: "OLD", atMs: now.getTime() }));
    now = new Date(now.getTime() + IMAGE_TTL_MS + 60_000);
    // Same local day only if the TTL kept us there; use the file whatever the day.
    const day = l.days()[0];
    const before = l.read(day);
    expect(before[0]).toHaveProperty("image", "OLD");
    expect(l.applyRetention().imagesExpired).toBe(1);
    const after = l.read(day);
    expect(after).toHaveLength(1);
    expect(after[0]).toHaveProperty("appId", "com.tinyspeck.slackmacgap");
    expect(after[0]).not.toHaveProperty("image");
  });

  it("forgets today or everything and restarts the counts", () => {
    const dir = tempDir();
    const key = randomBytes(32);
    let now = new Date(2026, 8, 18, 9);
    const l = log(dir, key, { now: () => now });
    l.append(frame({ atMs: now.getTime() }));
    const yesterday = dayKey(now);
    now = NOW;
    l.append(frame());
    l.append(action());
    expect(l.days()).toEqual([yesterday, TODAY]);
    expect(l.bytes()).toBeGreaterThan(0);
    l.forget("today");
    expect(l.days()).toEqual([yesterday]);
    expect(l.dayDigest().frames).toBe(0);
    expect(l.read(TODAY)).toEqual([]);
    l.append(frame());
    expect(l.dayDigest().frames).toBe(1);
    l.forget("all");
    expect(l.days()).toEqual([]);
    expect(l.bytes()).toBe(0);
    expect(() => l.forget("../../etc")).toThrow("Invalid day.");
    expect(() => l.read("2026-09")).toThrow("Invalid day.");
  });

  it("digest() carries every day and memory's counts in the report's shape", () => {
    const dir = tempDir();
    const key = randomBytes(32);
    const memory = emptyMemory();
    memory.routines.push(
      {
        id: "routine-a",
        kind: "routine",
        name: "Morning",
        tokens: [],
        when: { weekdays: [1], hourRange: [9, 10] },
        steps: [{ appId: "com.apple.mail" }],
        seen: 3,
        firstSeen: "2026-09-01T00:00:00.000Z",
        lastSeen: "2026-09-18T00:00:00.000Z",
        confidence: 0.8,
        status: "approved",
        runs: { completed: 2, corrected: 1, undone: 0, declined: 0, failed: 0 },
        correctionStreak: 0,
      },
      {
        id: "routine-b",
        kind: "routine",
        name: "Evening",
        tokens: [],
        when: { weekdays: [1], hourRange: [18, 19] },
        steps: [{ appId: "com.apple.Music" }],
        seen: 1,
        firstSeen: "2026-09-01T00:00:00.000Z",
        lastSeen: "2026-09-18T00:00:00.000Z",
        confidence: 0.5,
        status: "proposed",
        runs: { completed: 0, corrected: 0, undone: 0, declined: 0, failed: 0 },
        correctionStreak: 0,
      },
    );
    memory.preferences.push({
      id: "pref-1",
      kind: "preference",
      text: "opens PDFs in Preview",
      tokens: [],
      weight: 4,
      source: "observed",
      status: "proposed",
      createdAt: "2026-09-18T00:00:00.000Z",
      updatedAt: "2026-09-18T00:00:00.000Z",
    });
    memory.preferences.push({
      id: "pref-2",
      kind: "preference",
      text: "a correction",
      tokens: [],
      weight: 1,
      source: "correction",
      createdAt: "2026-09-18T00:00:00.000Z",
      updatedAt: "2026-09-18T00:00:00.000Z",
    });
    let now = new Date(2026, 8, 18, 9);
    const l = log(dir, key, { now: () => now, memory: () => memory });
    l.append(frame({ atMs: now.getTime() }));
    l.append(frame({ atMs: now.getTime() + 1, excluded: "protected" }));
    now = NOW;
    l.append(frame());
    l.append(frame({ appId: "com.apple.mail", appName: "Mail" }));
    l.append(action());
    l.append(
      action({
        kind: "typing",
        typed: { field: "Message", chars: 12, ms: 900 },
      }),
    );
    l.noteHelperDrop(2);
    const digest = l.digest();
    expect(digest.days.map((d) => d.day)).toEqual([
      dayKey(new Date(2026, 8, 18)),
      TODAY,
    ]);
    expect(digest.days[0]).toMatchObject({
      frames: 1,
      actions: 0,
      excluded: { protected: 1 },
      apps: { "com.tinyspeck.slackmacgap": 1 },
    });
    expect(digest.days[1]).toMatchObject({
      frames: 2,
      actions: 2,
      framesDropped: 0,
      apps: { "com.tinyspeck.slackmacgap": 1, "com.apple.mail": 1 },
      actionKinds: { click: 1, typing: 1 },
      dropped: { size: 0, credential: 0, invalid: 0, paused: 0, helper: 2 },
    });
    expect(digest.days[1].bytesWritten).toBeGreaterThan(0);
    expect(digest.routines).toEqual({
      proposed: 1,
      approved: 1,
      retired: 0,
      observed: 2,
    });
    expect(digest.procedures).toEqual({
      proposed: 0,
      approved: 0,
      retired: 0,
      observed: 0,
    });
    expect(digest.preferences).toEqual({
      proposed: 1,
      approved: 0,
      retired: 0,
      observed: 1,
    });
    expect(digest.replays).toEqual({ completed: 2, corrected: 1 });
    // Content never appears in a digest.
    const text = JSON.stringify(digest);
    expect(text).not.toContain("general");
    expect(text).not.toContain("Message");
    expect(text).not.toContain("Morning");
    // Without memory the counts are zero, and a day without a file is today's empty digest.
    expect(memoryDigest(undefined).routines.observed).toBe(0);
    expect(log(tempDir(), key).digest().days).toEqual([
      { ...emptyDayDigest(TODAY) },
    ]);
  });

  it("rebuilds today's live counts from the file after a restart", () => {
    const dir = tempDir();
    const key = randomBytes(32);
    const l = log(dir, key);
    l.append(frame());
    l.append(action());
    const again = log(dir, key);
    expect(again.dayDigest()).toMatchObject({ frames: 1, actions: 1 });
    again.append(frame());
    expect(again.dayDigest().frames).toBe(2);
  });

  it("names days in local time and knows midnight", () => {
    expect(dayKey(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDay("2026-12-31", 1)).toBe("2027-01-01");
    const ms = msUntilMidnight(new Date(2026, 8, 19, 23, 0));
    expect(ms).toBeGreaterThan(59 * 60_000);
    expect(ms).toBeLessThanOrEqual(60 * 60_000 + 1000);
  });
});
