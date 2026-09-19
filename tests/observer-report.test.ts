import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { TARGETS } from "../src/gym/observer-eval";

// The observer report reads the diagnostics rows the observer leaves
// (ObserverFrame, ObserverAction, ObserverConsolidated, RoutineRun) and the
// work log's digest, and says what was recorded, learned and replayed as
// counts. It must print counts, bundle ids and codes only: every text field
// in the fixture carries a sentinel that must never appear in any output.
const root = resolve(__dirname, "..");
const script = join(root, "scripts", "observer-report.mjs");
const SENTINEL = "zqxsentinel";

/** One diagnostics row at `at` ms after the fixture's epoch (a UTC morning). */
const T0 = Date.parse("2026-09-14T09:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
let sequence = 0;
const row = (at: number, event: string, data: Record<string, unknown>) =>
  JSON.stringify({
    timestamp: new Date(T0 + at).toISOString(),
    pid: 1,
    sequence: ++sequence,
    event,
    data,
  });
/** Every text field §2 names, and a few it does not, all carrying the sentinel. */
const text = {
  windowTitle: `${SENTINEL} — Inbox`,
  host: `${SENTINEL}.example.com`,
  focusedLabel: SENTINEL,
  focusedRole: "textField",
  controls: [{ role: "button", label: SENTINEL }],
  textDigest: `${SENTINEL} ${SENTINEL}`,
  text: SENTINEL,
  path: `/Users/${SENTINEL}/Documents`,
  name: SENTINEL,
};
const frame = (
  at: number,
  appId: string,
  extra: Record<string, unknown> = {},
) => row(at, "ObserverFrame", { appId, ...text, ...extra });
const action = (
  at: number,
  kind: string,
  extra: Record<string, unknown> = {},
) =>
  row(at, "ObserverAction", {
    appId: "com.apple.Safari",
    kind,
    target: { role: "button", label: SENTINEL },
    typed: { field: SENTINEL, chars: 12, ms: 900 },
    menu: [SENTINEL, SENTINEL],
    ...extra,
  });

/**
 * Day 1 (2026-09-14): six recorded frames (Safari 3, Mail 2, one whose appId
 * is not a bundle id), three excluded (secure_input, locked, one off the
 * list), five actions (click 2, scroll, typing, one off the list), one
 * consolidation of 41,200 tokens, one completed replay.
 * Day 2: three frames (Safari 1, Linear 2), two consolidations totalling
 * 250,000 tokens (the target missed), a corrected replay and a declined one
 * whose routine id is not an id.
 * Day 3: one Slack frame, no consolidation, an undone replay.
 * Rows of other events and a line that is not JSON are ignored.
 */
const stream = [
  frame(0, "com.apple.Safari"),
  frame(20_000, "com.apple.Safari"),
  frame(40_000, "com.apple.mail"),
  frame(60_000, "com.apple.Safari"),
  frame(80_000, "com.apple.mail"),
  frame(100_000, `${SENTINEL} title with spaces`),
  row(120_000, "ObserverFrame", {
    appId: "com.apple.Safari",
    excluded: "secure_input",
  }),
  row(140_000, "ObserverFrame", { excluded: "locked" }),
  row(160_000, "ObserverFrame", {
    appId: "com.apple.Safari",
    excluded: SENTINEL,
  }),
  action(200_000, "click"),
  action(210_000, "click"),
  action(220_000, "scroll", { scroll: { direction: "down", ticks: 3 } }),
  action(230_000, "typing"),
  action(240_000, SENTINEL),
  row(300_000, "ObserverConsolidated", {
    frames: 6,
    tokens: 41_200,
    outputTokens: 900,
    cost: 0.021,
    routines: 1,
    procedures: 1,
    preferences: 2,
    durationMs: 5_400,
    names: [SENTINEL],
    summary: SENTINEL,
  }),
  row(400_000, "RoutineRun", {
    routineId: "rt_morning",
    outcome: "completed",
    name: SENTINEL,
    task: SENTINEL,
  }),
  row(410_000, "Heartbeat", { text: SENTINEL }),
  row(420_000, "VoiceEvent", { phase: "transcript_final", text: SENTINEL }),
  "not json at all",

  frame(DAY, "com.apple.Safari"),
  frame(DAY + 20_000, "com.linear"),
  frame(DAY + 40_000, "com.linear"),
  row(DAY + 300_000, "ObserverConsolidated", {
    frames: 3,
    tokens: 150_000,
    cost: 0.05,
    routines: 2,
    procedures: 0,
    preferences: 1,
  }),
  row(DAY + 400_000, "ObserverConsolidated", {
    frames: 3,
    inputTokens: 100_000,
    cost: 0.03,
    routines: 0,
    procedures: 1,
    preferences: 0,
  }),
  row(DAY + 500_000, "RoutineRun", {
    routineId: "rt_morning",
    outcome: "corrected",
  }),
  row(DAY + 510_000, "RoutineRun", {
    routineId: `${SENTINEL} is not an id`,
    outcome: "declined",
  }),

  frame(2 * DAY, "com.tinyspeck.slackmacgap"),
  row(2 * DAY + 100_000, "RoutineRun", {
    routineId: "rt_evening",
    outcome: "undone",
  }),
].join("\n");

/** The log's digest: counts under known keys, text under others, junk entries. */
const digest = {
  days: [
    {
      day: "2026-09-14",
      frames: 6,
      actions: 5,
      bytesWritten: 240_000,
      bytesDropped: 0,
      framesDropped: 0,
      excluded: { secure_input: 1, locked: 1, [SENTINEL]: 1 },
      apps: {
        "com.apple.Safari": 3,
        "com.apple.mail": 2,
        [`${SENTINEL} title`]: 1,
      },
      titles: [SENTINEL],
    },
    {
      day: "2026-09-15",
      frames: 3,
      bytesWritten: 60_000_000,
      bytesDropped: 1_200_000,
      framesDropped: 40,
    },
    { day: SENTINEL, frames: 99 },
    SENTINEL,
  ],
  routines: { proposed: 3, approved: 1, retired: 0, names: [SENTINEL] },
  procedures: { proposed: 2, approved: 1, retired: 1 },
  preferences: { observed: 6, texts: [SENTINEL] },
  replays: { completed: 3, corrected: 1, "bogus code!": 2 },
  note: SENTINEL,
};

describe("observer-report", () => {
  let file: string;
  let digestFile: string;
  let dir: string;
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [script, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 60000,
      // Days are the machine's calendar days; the fixture is written in UTC.
      env: { ...process.env, TZ: "UTC" },
    });
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "observer-report-"));
    file = join(dir, "current.jsonl");
    writeFileSync(file, stream + "\n");
    digestFile = join(dir, "digest.json");
    writeFileSync(digestFile, JSON.stringify(digest));
  });

  it("prints --help and refuses a missing file or a bad digest", () => {
    const help = run("--help");
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Usage");
    expect(help.stdout).toContain("--digest <file>");
    const missing = run(join(root, "no-such-stream.jsonl"));
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("No such file");
    expect(run("--digest", join(dir, "none.json"), file).status).toBe(2);
    const notJson = join(dir, "bad.json");
    writeFileSync(notJson, "{not json");
    const bad = run("--digest", notJson, file);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("Bad digest");
    const list = join(dir, "list.json");
    writeFileSync(list, "[1,2,3]");
    expect(run("--digest", list, file).stderr).toContain("not a JSON object");
  });

  it("counts frames, exclusions, actions, consolidations and replays per day, never the text", () => {
    const result = run("--json", file);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(SENTINEL);
    expect(result.stdout).not.toContain("Inbox");
    const report = JSON.parse(result.stdout);
    const s = report.summary;
    expect(s.days).toBe(3);
    expect(s.shown).toBe(3);
    expect(s.from).toBe("2026-09-14");
    expect(s.to).toBe("2026-09-16");
    expect(s.timezone).toBe("UTC");
    expect(s.frames).toEqual({
      recorded: 10,
      excluded: 3,
      byExclusion: { secure_input: 1, locked: 1, other: 1 },
      byApp: {
        "com.apple.Safari": 4,
        "com.apple.mail": 2,
        "com.linear": 2,
        "com.tinyspeck.slackmacgap": 1,
        unknown: 1,
      },
    });
    expect(s.actions).toEqual({
      total: 5,
      byKind: { click: 2, other: 1, scroll: 1, typing: 1 },
    });
    expect(s.bytes).toBeUndefined();
    expect(s.consolidations).toMatchObject({
      runs: 3,
      days: 2,
      tokens: 291_200,
      outputTokens: 900,
      cost: 0.101,
      produced: { routines: 3, procedures: 2, preferences: 3 },
    });
    expect(s.consolidations.tokensPerRun).toEqual({
      n: 3,
      p50: 100_000,
      p90: 150_000,
      max: 150_000,
    });
    expect(s.routines).toBeUndefined();
    expect(s.replays).toMatchObject({
      total: 4,
      byOutcome: { completed: 1, corrected: 1, declined: 1, undone: 1 },
      corrections: 1,
      routines: 2,
    });
    expect(s.replays.byRoutine).toEqual({
      rt_morning: { completed: 1, corrected: 1 },
      unknown: { declined: 1 },
      rt_evening: { undone: 1 },
    });
    expect(s.targets.inputTokensPerDay).toEqual({
      limit: TARGETS.inputTokensPerDay,
      measured: 2,
      met: 1,
      missed: 1,
      missedDays: ["2026-09-15"],
      max: { day: "2026-09-15", tokens: 250_000 },
    });
    expect(s.targets.bytesPerDay).toBeUndefined();

    const [a, b, c] = report.days;
    expect(a).toMatchObject({
      day: "2026-09-14",
      frames: 6,
      excluded: { secure_input: 1, locked: 1, other: 1 },
      apps: { "com.apple.Safari": 3, "com.apple.mail": 2, unknown: 1 },
      actions: 5,
      kinds: { click: 2, scroll: 1, typing: 1, other: 1 },
      consolidations: 1,
      tokens: 41_200,
      cost: 0.021,
      replays: { completed: 1 },
      tokensTarget: "met",
    });
    expect(a.digest).toBeUndefined();
    expect(b).toMatchObject({
      day: "2026-09-15",
      frames: 3,
      apps: { "com.linear": 2, "com.apple.Safari": 1 },
      consolidations: 2,
      tokens: 250_000,
      replays: { corrected: 1, declined: 1 },
      tokensTarget: "missed",
    });
    expect(c).toMatchObject({
      day: "2026-09-16",
      frames: 1,
      consolidations: 0,
      tokens: 0,
      replays: { undone: 1 },
      tokensTarget: "no_run",
    });
  });

  it("adds the digest's counters and the byte target, reading known keys only", () => {
    const result = run("--json", "--digest", digestFile, file);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(SENTINEL);
    const s = JSON.parse(result.stdout).summary;
    expect(s.bytes).toEqual({
      source: "digest",
      written: 60_240_000,
      dropped: 1_200_000,
      framesDropped: 40,
    });
    expect(s.routines).toEqual({ proposed: 3, approved: 1, retired: 0 });
    expect(s.procedures).toEqual({ proposed: 2, approved: 1, retired: 1 });
    expect(s.preferences).toEqual({ observed: 6 });
    expect(s.replays.digest).toEqual({ completed: 3, corrected: 1, other: 2 });
    expect(s.targets.bytesPerDay).toEqual({
      limit: 50 * 1024 * 1024,
      measured: 2,
      met: 1,
      missed: 1,
      capHitDays: ["2026-09-15"],
    });
    const days = JSON.parse(result.stdout).days;
    expect(days[0].digest).toEqual({
      day: "2026-09-14",
      frames: 6,
      actions: 5,
      bytesWritten: 240_000,
      bytesDropped: 0,
      framesDropped: 0,
      excluded: { secure_input: 1, locked: 1, other: 1 },
      apps: { "com.apple.Safari": 3, "com.apple.mail": 2, unknown: 1 },
    });
    expect(days[1].digest).toMatchObject({
      framesDropped: 40,
      excluded: {},
      apps: {},
    });
    expect(days[2].digest).toBeUndefined();
    // A digest alone, with no observer rows in the stream, still lists its days.
    const empty = join(dir, "empty.jsonl");
    writeFileSync(empty, row(0, "Heartbeat", {}) + "\n");
    const alone = JSON.parse(
      run("--json", "--digest", digestFile, empty).stdout,
    );
    expect(alone.summary.days).toBe(2);
    expect(alone.summary.frames.recorded).toBe(0);
    expect(alone.summary.bytes.written).toBe(60_240_000);
  });

  it("prints the same as text, the last N days only, still without the text", () => {
    const all = run("--digest", digestFile, file);
    expect(all.status).toBe(0);
    expect(all.stdout).not.toContain(SENTINEL);
    expect(all.stdout).toContain(
      "Observer: 3 day(s) with observer rows in 1 file(s) and a digest; showing the last 3 (2026-09-14..2026-09-16, days in UTC).",
    );
    expect(all.stdout).toContain(
      "Frames: 10 recorded, 3 excluded (locked 1, other 1, secure_input 1). Actions: 5 (click 2, other 1, scroll 1, typing 1).",
    );
    expect(all.stdout).toContain(
      "Bytes: 57.4 MB written, 1.1 MB dropped, 40 frame(s) dropped at the cap (digest).",
    );
    expect(all.stdout).toContain("Apps by frames: com.apple.Safari 4, ");
    expect(all.stdout).toContain(
      "  2026-09-15  3       0     0        2     250000    $0.0800   2        57.2 MB    missed",
    );
    expect(all.stdout).toContain(
      "  2026-09-16  1       0     0        0     0         $0.0000   1        —          no_run",
    );
    expect(all.stdout).toContain(
      "Consolidations: 3 run(s) on 2 day(s); input tokens 291200 (per run p50 100000, max 150000); cost $0.1010; produced 3 routine(s), 2 procedure(s), 3 preference(s).",
    );
    expect(all.stdout).toContain(
      "Routines: proposed 3, approved 1, retired 0; procedures: proposed 2, approved 1, retired 1; preferences: observed 6 (digest).",
    );
    expect(all.stdout).toContain(
      "Replays: 4 (completed 1, corrected 1, declined 1, undone 1); corrections 1; 2 routine(s) replayed; the digest counts completed 3, corrected 1, other 2.",
    );
    expect(all.stdout).toContain(
      `Targets: input tokens <= ${TARGETS.inputTokensPerDay}/day: met 1 of 2 consolidated day(s), missed on 2026-09-15; max 250000 on 2026-09-15. Bytes <= 50.0 MB/day: met 1 of 2; the cap dropped frames on 1 day(s).`,
    );

    const last = run("--days", "1", file);
    expect(last.status).toBe(0);
    expect(last.stdout).not.toContain(SENTINEL);
    expect(last.stdout).toContain("showing the last 1 (2026-09-16..2026-09-16");
    expect(last.stdout).toContain("Frames: 1 recorded, 0 excluded (none).");
    expect(last.stdout).toContain("Bytes: not available (pass --digest <file>");
    expect(last.stdout).toContain(
      "Routines: proposed/approved/retired need the digest",
    );
    expect(last.stdout).toContain("Replays: 1 (undone 1); corrections 0;");
    expect(last.stdout).not.toContain("2026-09-14");
  });
});
