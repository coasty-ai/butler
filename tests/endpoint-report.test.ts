import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// The endpoint report reads the diagnostics stream a voice turn leaves and says
// how long the turn waited after its last words and what a shorter wait would
// have done. It must print timings, counts and codes only: the fixture's text
// carries a sentinel that must never appear in any output.
const root = resolve(__dirname, "..");
const script = join(root, "scripts", "endpoint-report.mjs");
const SENTINEL = "zqxsentinel";

/** One diagnostics row at `at` ms after the fixture's epoch. */
const T0 = Date.parse("2026-09-19T10:00:00.000Z");
let sequence = 0;
const row = (at: number, event: string, data: Record<string, unknown>) =>
  JSON.stringify({
    timestamp: new Date(T0 + at).toISOString(),
    pid: 1,
    sequence: ++sequence,
    event,
    data,
  });
const voice = (at: number, phase: string, data: Record<string, unknown> = {}) =>
  row(at, "VoiceEvent", { phase, ...data });
/** A text change as a verbose stream logs it: both rows, the same instant. */
const change = (at: number, text: string) => [
  voice(at, "recognition_update", {
    textLength: text.length,
    source: "command_segment",
  }),
  voice(at + 2, "transcript_partial", { text, textLength: text.length }),
];

/**
 * Turn A (0 s): "open", a burst 15 ms later, then "open notes" 300 ms after
 * the first, endpoint 2050 ms after that, Apple's empty final recovered, a fast
 * start, one open_app action. A 0.8 s cut fires 800 ms after the third change
 * and changes nothing.
 * Turn B (20 s): "open calendar" then, 1100 ms later, more of the sentence, then
 * 300 ms later a lone partial (a recognizer final committed before the
 * endpoint, which native marks with the partial row alone); a 0.8 s cut would
 * have fired on the first clause, 2350 ms before the endpoint, with a text of
 * another length than the final's.
 * Turn C (40 s): push-to-talk, released; never in the cut table.
 * Turn D (60 s): a wake that was cancelled; listed, not measured.
 */
const stream = [
  voice(0, "wake_detected"),
  ...change(1000, `${SENTINEL} open`),
  ...change(1015, `${SENTINEL} open n`),
  ...change(1300, `${SENTINEL} open notes`),
  voice(2650, "endpoint_near", { remainingMs: 700 }),
  voice(3350, "shortcut_up"),
  voice(3350, "turn_endpoint", {
    endReason: "stable_quiet",
    stableMs: 2050,
    quietMs: 2600,
    completeness: "complete",
    segments: 1,
    patience: "normal",
    noiseFloor: 0.005,
    threshold: 0.015,
  }),
  voice(3400, "transcript_recovered", {
    text: `${SENTINEL} open notes`,
    textLength: `${SENTINEL} open notes`.length,
    confidence: 0,
    source: "empty_final_after_endpoint",
    segments: 1,
    stableMs: 2100,
  }),
  row(3402, "Command", {
    text: `${SENTINEL} open notes`,
    fromVoice: true,
    confidence: 0.7,
  }),
  row(3403, "TurnPlanned", { plan: "start", source: "voice", textLength: 22 }),
  row(3404, "DialogTurn", { phase: "decided", code: "fast_start", actMs: 0 }),
  row(3410, "SpeechOut", {
    phase: "requested",
    engine: "kokoro",
    textLength: 14,
  }),
  row(3520, "RunStarted", { runId: "r1" }),
  row(3900, "ActionExecuted", { runId: "r1", actionType: "open_app" }),
  row(3950, "Heartbeat", {}),

  voice(20000, "wake_detected"),
  ...change(20500, `${SENTINEL} open calendar`),
  ...change(21600, `${SENTINEL} open calendar and show me`),
  voice(21900, "transcript_partial", {
    text: `${SENTINEL} open calendar and show me today`,
    textLength: `${SENTINEL} open calendar and show me today`.length,
  }),
  voice(23650, "turn_endpoint", {
    endReason: "stable_quiet",
    stableMs: 2050,
    quietMs: 2700,
    completeness: "complete",
    segments: 1,
    patience: "normal",
  }),
  voice(23700, "transcript_final", {
    text: `${SENTINEL} open calendar and show me today`,
    textLength: `${SENTINEL} open calendar and show me today`.length,
    confidence: 0.9,
    segments: 1,
  }),
  row(23702, "Command", { fromVoice: true, confidence: 0.9 }),
  row(23705, "DialogTurn", { phase: "decided", code: "start", actMs: 420 }),
  row(24100, "RunStarted", { runId: "r2" }),

  voice(40000, "shortcut_down"),
  ...change(40900, `${SENTINEL} stop`),
  voice(41200, "shortcut_up"),
  voice(41200, "turn_endpoint", {
    endReason: "release",
    stableMs: 300,
    quietMs: 250,
    completeness: "control",
    segments: 1,
    patience: "normal",
  }),
  voice(41500, "transcript_final", {
    text: `${SENTINEL} stop`,
    textLength: 15,
    confidence: 0.95,
    segments: 1,
  }),

  voice(60000, "wake_detected"),
  voice(60800, "voice_cancelled"),
  "not json at all",
].join("\n");

describe("endpoint-report", () => {
  let file: string;
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [script, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 60000,
    });
  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), "endpoint-report-"));
    file = join(dir, "current.jsonl");
    writeFileSync(file, stream + "\n");
  });

  it("prints --help and refuses a missing file", () => {
    expect(run("--help").status).toBe(0);
    expect(run("--help").stdout).toContain("Usage");
    const missing = run(join(root, "no-such-stream.jsonl"));
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("No such file");
  });

  it("measures each turn's wait and what a 0.8 s cut would have done, without the text", () => {
    const result = run("--json", file);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(SENTINEL);
    expect(result.stdout).not.toContain("notes");
    const report = JSON.parse(result.stdout);
    expect(report.summary.turns).toBe(4);
    expect(report.summary.measured).toBe(2);
    expect(report.summary.activations).toEqual({
      wake_detected: 3,
      shortcut_down: 1,
    });
    expect(report.summary.outcomes).toEqual({
      "transcript_recovered:empty_final_after_endpoint": 1,
      transcript_final: 2,
      voice_cancelled: 1,
    });
    expect(report.summary.endReasons).toEqual({ stable_quiet: 2 });

    const [a, b, c, d] = report.turns;
    // Turn A: three changes (each logged twice, two of them 15 ms apart), the
    // endpoint 2050 ms after the last.
    expect(a.changes).toBe(3);
    expect(a.speakingMs).toBe(300);
    expect(a.endpoint.lastTextToEndpointMs).toBe(2050);
    expect(a.endpoint.stableMs).toBe(2050);
    expect(a.endpoint.toOutcomeMs).toBe(50);
    expect(a.outcome.phase).toBe("transcript_recovered");
    expect(a.outcome.text).toBeUndefined();
    expect(a.decided).toBe("fast_start");
    expect(a.firstActionMs).toBe(500);
    expect(a.firstActionType).toBe("open_app");
    // The first changes stood 15 and 285 ms, so the 0.8 s cut fires on the third,
    // 800 ms after it: nothing changed after, the length is the final's, 1250 ms
    // saved.
    expect(a.cuts["800"]).toEqual({
      later: false,
      lengthDiffers: false,
      savingMs: 1250,
    });
    // A 1.5 s cut fires on the same change, 550 ms before the endpoint.
    expect(a.cuts["1500"]).toEqual({
      later: false,
      lengthDiffers: false,
      savingMs: 550,
    });
    // Turn B: three changes, the lone partial counted once. The first clause
    // stood 1100 ms, so every cut up to 1.0 s fires on it; the text changed
    // after, and the final is longer.
    expect(b.changes).toBe(3);
    expect(b.cuts["800"]).toEqual({
      later: true,
      lengthDiffers: true,
      savingMs: 2350,
    });
    expect(b.cuts["1000"]).toEqual({
      later: true,
      lengthDiffers: true,
      savingMs: 2150,
    });
    // At 1.2 s only the final words (the lone partial's) stood long enough.
    expect(b.cuts["1200"]).toEqual({
      later: false,
      lengthDiffers: false,
      savingMs: 550,
    });
    expect(b.actMs).toBe(420);
    // Push-to-talk and a cancel carry no cut table.
    expect(c.activation).toBe("shortcut_down");
    expect(c.endpoint.endReason).toBe("release");
    expect(c.cuts).toBeUndefined();
    expect(d.outcome.phase).toBe("voice_cancelled");
    expect(d.endpoint).toBeUndefined();

    const cuts = report.summary.cuts;
    expect(cuts["800"]).toMatchObject({
      reached: 2,
      laterChange: 1,
      lengthDiffers: 1,
      lengthUnknown: 0,
    });
    expect(cuts["800"].savingMs.n).toBe(2);
    expect(cuts["800"].savingWhenSameMs).toMatchObject({ n: 1, p50: 1250 });
    expect(cuts["1200"]).toMatchObject({
      reached: 2,
      laterChange: 0,
      lengthDiffers: 0,
    });
    expect(report.summary.stages.lastTextToEndpoint).toMatchObject({
      n: 2,
      p50: 2050,
    });
    expect(report.summary.stages.outcomeToFirstAction).toMatchObject({
      n: 1,
      p50: 500,
    });
    expect(report.summary.finalSameLengthAsLastText).toBe(2);
  });

  it("prints the same as text, last N turns only, still without the text", () => {
    const result = run("--turns", "2", file);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(SENTINEL);
    expect(result.stdout).toContain("showing the last 2, 0 hands-free");
    expect(result.stdout).toContain("shortcut_down");
    expect(result.stdout).toContain("voice_cancelled");
    const all = run(file);
    expect(all.stdout).not.toContain(SENTINEL);
    expect(all.stdout).toContain(
      "0.8 s cut: text changed after no, final length differs no, 1250 ms sooner",
    );
    expect(all.stdout).toContain(
      "0.8 s cut: text changed after yes, final length differs yes, 2350 ms sooner",
    );
    expect(all.stdout).toContain("800 ms   2        1 (50%)");
  });
});
