import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emptyLoopState, laneBrief, selectLanes } from "../src/gym/loop";
import {
  COST_WEIGHT,
  FAILURE_CODES,
  LOOP_OWNER,
  OWNER,
  classify,
  loopOwnerOf,
  noteFor,
  rankClasses,
  strictVoiceClass,
} from "../src/gym/voice/classify";
import {
  checkHolds,
  gradeTurn,
  heardVerdict,
  hidTakeover,
  medianLevel,
  outcomeMatches,
  quietThreshold,
  summarizeTurn,
  voiceGate,
  type DiagnosticEvent,
  type TurnGrade,
  type VoiceGateFacts,
} from "../src/gym/voice/grade";
import {
  buildResults,
  compareCycles,
  fixBrief,
  renderReport,
  toCycleResults,
  type PreflightFacts,
  type TurnRecord,
  type VoicePlan,
  type VoiceResults,
} from "../src/gym/voice/report";
import {
  TOKEN_RE,
  defaultTimeoutMs,
  estimateSeconds,
  fillPlaceholders,
  loadSuite,
  selectTasks,
  suiteHash,
  taskSkips,
  turnsOf,
  validateSuite,
  voiceToken,
  type VoiceSuite,
  type VoiceTask,
} from "../src/gym/voice/suite";

const root = new URL("..", import.meta.url).pathname;
const fixtureJson = readFileSync(
  join(root, "tests/fixtures/voice-suite.json"),
  "utf8",
);
const suite = loadSuite(fixtureJson);
const task = (id: string): VoiceTask => {
  const found = suite.tasks.find((t) => t.id === id);
  if (!found) throw new Error(`no task ${id}`);
  return found;
};

/* ------------------------------------------------- synthetic diagnostics */

/**
 * Event slices modelled on the 05:25 and 05:43 trials, with synthetic
 * transcripts. Every free-text field carries MARK so a leak into a result
 * or a report is unmistakable.
 */
const MARK = "MARKER_x";
const T0 = Date.parse("2026-09-19T05:25:00.000Z");
const RUN = "11111111-1111-4111-8111-111111111111";
const at = (ms: number) => new Date(T0 + ms).toISOString();
const ev = (
  ms: number,
  event: string,
  data: Record<string, unknown> = {},
): DiagnosticEvent => ({
  timestamp: at(ms),
  event,
  data,
});
const voice = (ms: number, phase: string, data: Record<string, unknown> = {}) =>
  ev(ms, "VoiceEvent", { phase, ...data });
const sorted = (events: DiagnosticEvent[]) =>
  [...events].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

/** The chatter every slice carries: heartbeats and standby levels. */
const chatter = (): DiagnosticEvent[] => [
  ev(500, "Heartbeat"),
  voice(1000, "standby_trace", {
    kind: "level",
    rms: 4,
    buffers: 51,
    engine: true,
  }),
  voice(6000, "standby_trace", {
    kind: "level",
    rms: 5,
    buffers: 51,
    engine: true,
  }),
  ev(12_000, "Heartbeat"),
  voice(0, "wake_status", { listening: true, enabled: true }),
];

/** A heard prompt up to the plan: wake at 2.5 s, transcript at 6 s. */
function heardPrompt(
  transcript: string,
  plan: string,
  decided: Record<string, unknown>,
): DiagnosticEvent[] {
  return [
    ...chatter(),
    voice(2500, "wake_detected"),
    voice(6000, "transcript_final", {
      confidence: 0.82,
      segments: 2,
      textLength: transcript.length,
    }),
    ev(6010, "Command", {
      text: `${MARK} ${transcript}`,
      fromVoice: true,
      confidence: 0.82,
      intent: "task",
    }),
    ev(6020, "TurnPlanned", {
      plan,
      source: "wake",
      segments: 2,
      confidence: 0.82,
      textLength: transcript.length,
    }),
    ev(6030, "DialogTurn", {
      phase: "decided",
      channel: "voice",
      actMs: 40,
      ...decided,
    }),
  ];
}

/** A fast start of "open notes": early open, run, one action, completed at 9 s. */
function fastStart(
  o: {
    transcript?: string;
    terminal?: string;
    task?: string;
    firstActionMs?: number;
  } = {},
) {
  const transcript = o.transcript ?? "open notes";
  return sorted([
    ...heardPrompt(transcript, "start", {
      code: "fast_start",
      act: "start",
      plan: "start",
    }),
    ev(3400, "EarlyStartExecuted", {
      code: "ok",
      settle: "frontmost",
      earlyMs: 900,
      durationMs: 400,
    }),
    ev(6040, "EarlyStartEnded", { phase: "kept", code: "ok", leadMs: 2600 }),
    ev(6050, "RunStarted", { runId: RUN }),
    ev(6100, "RunState", {
      runId: RUN,
      status: "capturing",
      provider: "openai",
      model: "gpt-5.4-mini",
      actions: 0,
      taskLength: 10,
      task: `${MARK} ${o.task ?? transcript}`,
    }),
    ev(6200, "SpeechOut", {
      phase: "requested",
      engine: "kokoro",
      priority: "ack",
      textLength: 8,
      latencyMs: 0,
    }),
    ev(6500, "FrameCaptured", {
      runId: RUN,
      data: { timings: { total: 700, shot: 300, ocr: 250, context: 100 } },
    }),
    ev(o.firstActionMs ?? 7000, "ActionExecuted", {
      runId: RUN,
      actionType: "open_app",
      launchedAppId: "com.apple.Notes",
    }),
    ev(9000, "RunState", {
      runId: RUN,
      status: o.terminal ?? "completed",
      provider: "openai",
      model: "gpt-5.4-mini",
      actions: 1,
      appId: "com.apple.Notes",
      message: `${MARK} opened`,
    }),
  ]);
}

/** An answer with no run: "what time is it". */
function answer(o: { replyMs?: number; transcript?: string } = {}) {
  return sorted([
    ...heardPrompt(o.transcript ?? "what time is it", "reply", {
      code: "answer",
      act: "answer",
      plan: "reply",
      jevUsed: true,
      jevAct: "answer",
      jevP: 0.9,
      jevMs: 300,
    }),
    ev(o.replyMs ?? 6300, "SpeechOut", {
      phase: "requested",
      engine: "kokoro",
      priority: "answer",
      textLength: 20,
      latencyMs: 0,
    }),
    voice(6900, "speech_started", { utteranceId: "u1" }),
    voice(8500, "speech_finished", { utteranceId: "u1", interrupted: false }),
  ]);
}

const spokenAt = T0;
const sayEndedAt = T0 + 2400;
const evidence = (value: string, exitCode = 0) => ({
  value,
  exitCode,
  ms: 120,
});
const grade = (
  t: VoiceTask,
  events: DiagnosticEvent[][],
  ev: Record<string, { value?: string; exitCode: number; ms: number }> = {},
  context = {},
) =>
  gradeTurn(
    t,
    events.map((slice) => summarizeTurn(slice, spokenAt, sayEndedAt)),
    ev,
    {
      verbose: true,
      fill: {
        token: "voiceloopab12",
        benchDir: "/tmp/b",
        wake: "Hey Butler",
        marker: "/tmp/m",
      },
      ...context,
    },
  );

/* ------------------------------------------------------------------ suite */

describe("voice suite: the fixture", () => {
  it("validates, has every category filled and at least 28 tasks", () => {
    expect(validateSuite(suite)).toEqual([]);
    expect(suite.tasks.length).toBeGreaterThanOrEqual(28);
    for (const category of suite.categories)
      expect(
        suite.tasks.some((t) => t.category === category),
        category,
      ).toBe(true);
    expect(new Set(suite.tasks.map((t) => t.id)).size).toBe(suite.tasks.length);
  });

  it("runs the default selection inside an hour and keeps noisy tasks behind --noisy", () => {
    const { tasks } = selectTasks(suite);
    expect(tasks.some((t) => t.tags.includes("noisy"))).toBe(false);
    expect(tasks.length).toBeGreaterThanOrEqual(30);
    expect(estimateSeconds(tasks) / 60).toBeLessThan(60);
    const noisy = selectTasks(suite, [], { noisy: true });
    expect(noisy.tasks.length).toBeGreaterThan(tasks.length);
    for (const t of tasks) {
      const timeout = defaultTimeoutMs(t);
      expect(timeout, t.id).toBeGreaterThanOrEqual(15_000);
      expect(timeout, t.id).toBeLessThanOrEqual(120_000);
    }
  });

  it("selects by id, tag and category, and reports unknown selectors", () => {
    expect(selectTasks(suite, "ask-time").tasks.map((t) => t.id)).toEqual([
      "ask-time",
    ]);
    const byTag = selectTasks(suite, "fast-start");
    expect(byTag.tasks.length).toBeGreaterThan(2);
    expect(byTag.tasks.every((t) => t.tags.includes("fast-start"))).toBe(true);
    const byCategory = selectTasks(suite, ["app", "nope"]);
    expect(byCategory.tasks.length).toBe(5);
    expect(byCategory.tasks.every((t) => t.category === "app")).toBe(true);
    expect(byCategory.unknown).toEqual(["nope"]);
    // A word that is both a tag and a category selects by either.
    const browsing = selectTasks(suite, "browsing").tasks;
    expect(
      browsing.every(
        (t) => t.category === "browsing" || t.tags.includes("browsing"),
      ),
    ).toBe(true);
    expect(browsing.map((t) => t.id)).toContain("multi-safari-then-textedit");
  });

  it("skips the tasks whose preflight probe failed, with the subcode", () => {
    const skips = taskSkips(suite.tasks, {
      "notes-automation": false,
      "focus-shortcut": true,
    });
    expect(skips["dictate-notes-line"]).toBe("NOTES_AUTOMATION");
    expect(skips["multi-notes-shopping-list"]).toBe("NOTES_AUTOMATION");
    expect(skips["sys-do-not-disturb"]).toBeUndefined();
    expect(
      taskSkips(suite.tasks, { "focus-shortcut": false })["sys-do-not-disturb"],
    ).toBe("SHORTCUT_MISSING");
  });

  it("fills placeholders, leaves AppleScript records alone and refuses unknown ones", () => {
    const fill = {
      token: "voiceloopab12",
      benchDir: "/Users/x/OpenAssistBench/voice-voiceloopab12",
      wake: "Hey Butler",
      marker: "/tmp/m",
      state: { win: "42" },
    };
    expect(
      fillPlaceholders(
        'make new note with properties {body:"Voice loop {token}"}',
        fill,
      ),
    ).toBe('make new note with properties {body:"Voice loop voiceloopab12"}');
    expect(
      fillPlaceholders(
        "close (every window whose id is {state.win}); rm -rf {benchDir}; touch {marker}; say {wake}",
        fill,
      ),
    ).toBe(
      "close (every window whose id is 42); rm -rf /Users/x/OpenAssistBench/voice-voiceloopab12; touch /tmp/m; say Hey Butler",
    );
    expect(fillPlaceholders("echo ${HOME}", fill)).toBe("echo ${HOME}");
    expect(() => fillPlaceholders("{tokn}", fill)).toThrow(
      /unknown placeholder/,
    );
    expect(() => fillPlaceholders("{state.nope}", fill)).toThrow(
      /no recorded value/,
    );
    for (let i = 0; i < 20; i++) expect(voiceToken()).toMatch(TOKEN_RE);
    expect(voiceToken(() => 0)).toBe("voiceloop0000");
  });

  it("refuses a task that could touch the owner's data or approve anything", () => {
    const bad = (over: Partial<VoiceTask>): string[] => {
      const copy: VoiceSuite = {
        ...suite,
        tasks: [
          ...suite.tasks,
          { ...task("ask-time"), id: "bad-task", ...over },
        ],
      };
      return validateSuite(copy).filter((p) => p.includes("bad-task"));
    };
    expect(bad({ say: "yes go ahead" }).join()).toMatch(/approval phrase/);
    expect(bad({ say: "send a message" }).join()).toMatch(/says "send"/);
    expect(
      bad({
        setup: [{ kind: "sh", script: "open -a Mail" }],
        cleanup: [{ kind: "sh", script: "true" }],
      }).join(),
    ).toMatch(/names mail/);
    expect(
      bad({ cleanup: [{ kind: "sh", script: "rm -rf ~/Documents" }] }).join(),
    ).toMatch(/deletes outside/);
    expect(bad({ setup: [{ kind: "sh", script: "true" }] }).join()).toMatch(
      /without cleanup/,
    );
    expect(bad({ tags: ["noisy", "question"] }).join()).toMatch(
      /noisy tag disagree/,
    );
    expect(bad({ category: "email" }).join()).toMatch(/unknown category/);
    expect(
      bad({
        turns: [
          {
            say: "open notes",
            withWake: true,
            heard: "notes",
            expect: { outcome: "run" },
          },
          {
            say: "and bold",
            withWake: false,
            after: { event: "RunStarted" },
            heard: "bold",
            expect: { outcome: "revise" },
          },
        ],
      }).join(),
    ).toMatch(/no wake and no follow-up window/);
    expect(
      bad({
        setup: [{ kind: "sh", script: "echo {state.win}" }],
        cleanup: [{ kind: "sh", script: "true" }],
      }).join(),
    ).toMatch(/never recorded/);
    const dup: VoiceSuite = {
      ...suite,
      tasks: [...suite.tasks, task("ask-time")],
    };
    expect(validateSuite(dup).join()).toMatch(/duplicate id/);
  });

  it("hashes the fixture with the grader sources, so a grader change is a new metric", () => {
    const a = suiteHash(fixtureJson, ["grade v1"]);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(suiteHash(fixtureJson, ["grade v2"])).not.toBe(a);
    expect(suiteHash(fixtureJson, ["grade v1"])).toBe(a);
  });
});

/* ------------------------------------------------------------------ grade */

describe("voice grade: summaries and hearing", () => {
  it("summarizes a heard fast start the way the trials measured it", () => {
    const s = summarizeTurn(fastStart(), spokenAt, sayEndedAt);
    expect(s.wakeMs).toBe(2500);
    expect(s.transcriptMs).toBe(6000);
    expect(s.sayMs).toBe(2400);
    expect(s.endpointMs).toBe(3600);
    expect(s.plan).toBe("start");
    expect(s.decided).toMatchObject({ code: "fast_start", act: "start" });
    expect(s.earlyExecuted).toMatchObject({ code: "ok", atMs: 3400 });
    expect(s.earlyEnded).toMatchObject({ phase: "kept" });
    expect(s.runStarted).toBe(true);
    expect(s.actions).toEqual(["open_app"]);
    expect(s.mutations).toBe(0);
    expect(s.firstActionAfterTranscriptMs).toBe(1000);
    expect(s.replyAfterTranscriptMs).toBe(200);
    expect(s.terminal).toBe("completed");
    expect(s.captureTimings).toMatchObject({ total: 700 });
    expect(s.providerModel).toBe("openai:gpt-5.4-mini");
    expect(s.appId).toBe("com.apple.Notes");
    // Chatter is not counted as activity.
    expect(s.events).toBeLessThan(fastStart().length);
    expect(s.standby.levels).toHaveLength(2);
    expect(heardVerdict(turnsOf(task("app-open-notes"))[0], s)).toBe("heard");
    const g = grade(task("app-open-notes"), [fastStart()], {
      frontmost: evidence("com.apple.Notes"),
    });
    expect(classify(g)).toEqual({
      pass: true,
      softCode: undefined,
      subcode: undefined,
    });
    expect(g.checks.earlyStart).toBe(true);
  });

  it("tells an unheard prompt (chatter only) from a misheard one, and a noisy room from a quiet one", () => {
    const silent = summarizeTurn(sorted(chatter()), spokenAt, sayEndedAt);
    expect(heardVerdict(turnsOf(task("app-open-notes"))[0], silent)).toBe(
      "unheard",
    );
    expect(
      classify(grade(task("app-open-notes"), [sorted(chatter())])),
    ).toMatchObject({ code: "UNHEARD", pass: false });
    expect(
      classify(grade(task("noisy-open-notes"), [sorted(chatter())])),
    ).toMatchObject({ code: "UNHEARD_NOISY" });
    // "called" heard as "call": the words are there but not the task's.
    const misheard = summarizeTurn(
      fastStart({ transcript: "create a note call voice trial" }),
      spokenAt,
      sayEndedAt,
    );
    const t: VoiceTask = {
      ...task("app-open-notes"),
      id: "note-called",
      say: "create a note called voice trial",
      heard: "called",
    };
    expect(heardVerdict(turnsOf(t)[0], misheard)).toBe("misheard");
    expect(
      classify(
        grade(t, [fastStart({ transcript: "create a note call voice trial" })]),
      ),
    ).toMatchObject({ code: "MISHEARD" });
    // A wake after 15 s belongs to something else.
    const late = summarizeTurn(
      sorted([
        ...chatter(),
        voice(16_000, "wake_detected"),
        ev(18_000, "Command", { text: "open notes" }),
      ]),
      spokenAt,
    );
    expect(heardVerdict(turnsOf(task("app-open-notes"))[0], late)).toBe(
      "unheard",
    );
  });

  it("grades an answer without a run, and accepts the agenda as an answer or a run", () => {
    const g = grade(task("ask-time"), [answer()]);
    expect(g.planMatched).toBe(true);
    expect(g.spoken).toBe(true);
    expect(g.runStarted).toBe(false);
    expect(g.replyAfterTranscriptMs).toBe(300);
    expect(classify(g).pass).toBe(true);
    const agenda = task("ask-agenda");
    const asked = "anything on my calendar today";
    expect(classify(grade(agenda, [answer({ transcript: asked })])).pass).toBe(
      true,
    );
    // The same answer to the wrong words is misheard, not accepted.
    expect(classify(grade(agenda, [answer()]))).toMatchObject({
      code: "MISHEARD",
    });
    expect(
      classify(
        grade(agenda, [
          fastStart({ transcript: "anything on my calendar today" }),
        ]),
      ).pass,
    ).toBe(true);
    // A run where an answer was asked for is the wrong kind of thing.
    expect(
      classify(
        grade(task("ask-time"), [fastStart({ transcript: "what time is it" })]),
      ),
    ).toMatchObject({
      code: "WRONG_PLAN",
      subcode: "EXPECTED_ANSWER_GOT_RUN",
    });
  });

  it("names a refused resume against a paused run WRONG_PLAN (trial 05:43 #4)", () => {
    const refused = sorted([
      ...heardPrompt("create a new note called voice trial", "revise", {
        code: "resume_refused",
        act: "revise",
        plan: "revise",
      }),
      ev(6200, "SpeechOut", {
        phase: "requested",
        engine: "kokoro",
        priority: "ack",
        textLength: 30,
      }),
    ]);
    const t: VoiceTask = {
      ...task("app-open-notes"),
      id: "note-new",
      say: "create a new note called voice trial",
      heard: "note",
      expect: { outcome: "run" },
    };
    expect(classify(grade(t, [refused]))).toMatchObject({
      code: "WRONG_PLAN",
      subcode: "EXPECTED_RUN_GOT_REVISE",
    });
  });

  it("passes a stop that cancels within 3 s of its wake phrase and fails a late one", () => {
    const first = sorted([
      ...heardPrompt("scroll slowly through the whole page", "start", {
        code: "fast_start",
        act: "start",
      }),
      ev(6050, "RunStarted", { runId: RUN }),
      ev(6100, "RunState", {
        runId: RUN,
        status: "acting",
        task: `${MARK} scroll`,
      }),
      ev(7000, "ActionExecuted", {
        runId: RUN,
        actionType: "scroll",
        delta_y: 400,
      }),
    ]);
    const stopAt = (cancelledMs: number) =>
      sorted([
        voice(8000, "wake_detected"),
        voice(9500, "transcript_final", { textLength: 4 }),
        ev(9510, "Command", { text: `${MARK} stop`, fromVoice: true }),
        ev(9520, "TurnPlanned", { plan: "stop", source: "wake" }),
        ev(cancelledMs, "RunState", { runId: RUN, status: "cancelled" }),
      ]);
    const stop = turnsOf(task("steer-stop"))[1];
    const quick = summarizeTurn(stopAt(9800), T0 + 7500, T0 + 8200);
    expect(outcomeMatches(stop.expect, quick)).toMatchObject({
      ok: true,
      observed: "stop",
    });
    expect(
      classify(grade(task("steer-stop"), [first, stopAt(9800)])).pass,
    ).toBe(true);
    const slow = summarizeTurn(stopAt(12_000), T0 + 7500, T0 + 8200);
    expect(outcomeMatches(stop.expect, slow)).toMatchObject({
      ok: false,
      reason: "STOP_LATE",
    });
    expect(
      classify(grade(task("steer-stop"), [first, stopAt(12_000)])),
    ).toMatchObject({ code: "WRONG_PLAN", subcode: "STOP_LATE" });
  });

  it("reads a pause and a resume from the status timeline, each within 3 s", () => {
    const pause = sorted([
      voice(8000, "wake_detected"),
      ev(9500, "Command", { text: `${MARK} wait` }),
      ev(9510, "TurnPlanned", { plan: "pause" }),
      ev(9800, "RunState", { runId: RUN, status: "paused" }),
    ]);
    const resume = sorted([
      ev(12_000, "RunState", { runId: RUN, status: "paused" }),
      voice(13_000, "wake_detected"),
      ev(14_500, "Command", { text: `${MARK} continue` }),
      ev(14_510, "TurnPlanned", { plan: "resume" }),
      ev(14_900, "RunState", { runId: RUN, status: "acting" }),
    ]);
    const turns = turnsOf(task("steer-wait-continue"));
    const paused = summarizeTurn(pause, spokenAt);
    expect(paused.pausedMs).toBe(9800);
    expect(outcomeMatches(turns[1].expect, paused).ok).toBe(true);
    const resumed = summarizeTurn(resume, spokenAt);
    expect(resumed.resumedMs).toBe(14_900);
    expect(outcomeMatches(turns[2].expect, resumed).ok).toBe(true);
    const first = sorted([
      ...heardPrompt("scroll slowly through the whole page", "start", {
        code: "fast_start",
        act: "start",
      }),
      ev(6050, "RunStarted", { runId: RUN }),
      ev(7000, "ActionExecuted", { runId: RUN, actionType: "scroll" }),
    ]);
    // The loop stops the run at the end by design: cancelled by the loop is not a failure.
    const ended = sorted([
      ...resume,
      ev(20_000, "RunState", { runId: RUN, status: "cancelled" }),
    ]);
    expect(
      classify(
        grade(
          task("steer-wait-continue"),
          [first, pause, ended],
          {},
          { stoppedByLoop: true },
        ),
      ).pass,
    ).toBe(true);
  });

  it("hears a follow-up continuation without a wake phrase inside the 3 s window", () => {
    const first = sorted([
      ...heardPrompt("write hello there in the document", "start", {
        code: "fast_start",
        act: "start",
      }),
      ev(6050, "RunStarted", { runId: RUN }),
      voice(6100, "followup_open", { kind: "continuation" }),
    ]);
    const second = sorted([
      voice(7900, "followup_detected", { kind: "continuation" }),
      voice(7900, "followup_closed", {
        kind: "continuation",
        endReason: "detected",
      }),
      voice(8000, "transcript_final", { textLength: 16 }),
      ev(8010, "Command", { text: `${MARK} and make it bold` }),
      ev(8020, "TurnPlanned", { plan: "amendTask", source: "followup" }),
      ev(12_000, "RunState", { runId: RUN, status: "completed" }),
    ]);
    const turns = turnsOf(task("dictate-follow-up-bold"));
    const s = summarizeTurn(second, T0 + 6400);
    expect(s.followup.detectedKind).toBe("continuation");
    expect(heardVerdict(turns[1], s)).toBe("heard");
    expect(outcomeMatches(turns[1].expect, s)).toMatchObject({
      ok: true,
      observed: "revise",
    });
    const g = grade(task("dictate-follow-up-bold"), [first, second], {
      hasPhrase: evidence("Hello there"),
      isBold: evidence("Helvetica-Bold"),
    });
    expect(classify(g).pass).toBe(true);
    expect(g.checks).toEqual({ hasPhrase: true, isBold: true });
  });

  it("accepts a declined confirmation where the task expects one, and NEEDS_CLICK where it does not", () => {
    const confirming = sorted([
      ...heardPrompt("quit calculator", "start", {
        code: "fast_start",
        act: "start",
      }),
      ev(6050, "RunStarted", { runId: RUN }),
      ev(6100, "RunState", {
        runId: RUN,
        status: "acting",
        task: `${MARK} quit`,
      }),
      ev(7000, "PolicyConfirmationRequested", {
        runId: RUN,
        reason: `Quit this application? ${MARK}`,
        actionType: "hotkey",
      }),
      ev(7100, "RunState", { runId: RUN, status: "confirming" }),
      ev(9000, "RunState", { runId: RUN, status: "cancelled" }),
    ]);
    const g = grade(
      task("app-quit-calculator"),
      [confirming],
      { calculatorGone: evidence("false") },
      { stoppedByLoop: true },
    );
    expect(g.observed).toEqual(["confirmation"]);
    expect(g.planMatched).toBe(true);
    // The Calculator check applies only to the run path.
    expect(g.checks.calculatorGone).toBeUndefined();
    expect(classify(g).pass).toBe(true);
    // The same confirmation on a task that must not ask is a click asked for.
    const t: VoiceTask = {
      ...task("app-quit-calculator"),
      id: "quit-no-ask",
      expect: { outcome: "run" },
    };
    expect(
      classify(grade(t, [confirming], {}, { stoppedByLoop: true })),
    ).toMatchObject({ code: "NEEDS_CLICK", subcode: "CONFIRMATION" });
    // A needClick plan and a hand-off takeover are clicks too.
    const needClick = sorted([
      ...fastStart(),
      ev(6025, "TurnPlanned", { plan: "needClick" }),
    ]);
    expect(
      classify(
        grade(task("app-open-notes"), [needClick], {
          frontmost: evidence("com.apple.Notes"),
        }),
      ),
    ).toMatchObject({ code: "NEEDS_CLICK" });
    const handoff = sorted([
      ...fastStart(),
      ev(8000, "UserTakeoverStarted", {
        runId: RUN,
        data: { source: "request_user" },
      }),
    ]);
    expect(
      classify(
        grade(task("app-open-notes"), [handoff], {
          frontmost: evidence("com.apple.Notes"),
        }),
      ),
    ).toMatchObject({ code: "NEEDS_CLICK", subcode: "request_user" });
  });

  it("calls a completed run with a false primary check a false done, and an unreadable optional check unknown", () => {
    const t = task("browse-goto-example");
    const events = fastStart({ transcript: "go to example dot com" });
    const good = grade(t, [events], {
      urlIsExample: evidence("https://example.com/"),
      frontmost: evidence("com.apple.Safari"),
    });
    expect(classify(good).pass).toBe(true);
    const wrong = grade(t, [events], {
      urlIsExample: evidence("about:blank"),
      frontmost: evidence("com.apple.Safari"),
    });
    expect(classify(wrong)).toMatchObject({
      code: "WRONG_STATE",
      subcode: "FALSE_DONE",
    });
    expect(wrong.primaryFailed).toEqual(["urlIsExample"]);
    // Frontmost disagreeing is a wrong state too, and never a pass.
    const behind = grade(t, [events], {
      urlIsExample: evidence("https://example.com/"),
      frontmost: evidence("com.apple.TextEdit"),
    });
    expect(classify(behind)).toMatchObject({ code: "WRONG_STATE" });
    // An optional check that could not be read is unknown, not a failure.
    const scroll = task("browse-scroll-down");
    const scrolled = sorted([
      ...fastStart({ transcript: "scroll down" }),
      ev(7500, "ActionExecuted", { runId: RUN, actionType: "scroll" }),
    ]);
    const g = grade(scroll, [scrolled], { scrolled: evidence("", 1) });
    expect(g.checks.scrolled).toBeNull();
    expect(g.unreadable).toEqual([]);
    expect(classify(g).pass).toBe(true);
    // A required check that could not be read is grader debt.
    expect(
      classify(
        grade(t, [events], {
          urlIsExample: evidence("", 1),
          frontmost: evidence("com.apple.Safari"),
        }),
      ),
    ).toMatchObject({
      code: "ENV_NOT_READY",
      subcode: "STATE_UNREADABLE",
    });
  });

  it("separates a failed run, a run the loop had to stop, and the task's own words", () => {
    const t = task("app-open-notes");
    const front = { frontmost: evidence("com.apple.Notes") };
    expect(
      classify(grade(t, [fastStart({ terminal: "failed" })], front)),
    ).toMatchObject({ code: "RUN_FAILED" });
    // Cancelled by the app itself, not by the loop, is a failure.
    expect(
      classify(grade(t, [fastStart({ terminal: "cancelled" })], front)),
    ).toMatchObject({ code: "RUN_FAILED" });
    expect(
      classify(
        grade(t, [fastStart({ terminal: "cancelled" })], front, {
          stoppedByLoop: true,
          timedOut: true,
        }),
      ),
    ).toMatchObject({ code: "RUN_INCOMPLETE" });
    const open = fastStart().filter(
      (e) => !(e.event === "RunState" && e.data?.status === "completed"),
    );
    expect(classify(grade(t, [open], front))).toMatchObject({
      code: "RUN_INCOMPLETE",
    });
    // The wake-phrase restart: the run must be about Calendar, not Notes.
    const restart = task("wake-restart-mid-utterance");
    const cal = { frontmost: evidence("com.apple.iCal") };
    expect(
      classify(
        grade(
          restart,
          [fastStart({ transcript: "open calendar", task: "open calendar" })],
          cal,
        ),
      ).pass,
    ).toBe(true);
    expect(
      classify(
        grade(
          restart,
          [
            fastStart({
              transcript: "open calendar",
              task: "open notes and open calendar",
            }),
          ],
          cal,
        ),
      ),
    ).toMatchObject({
      code: "WRONG_PLAN",
      subcode: "TASK_WORDS",
    });
  });

  it("passes the false-wake test by hearing nothing, and fails it on a wake", () => {
    const t = task("wake-in-sentence-stays-asleep");
    expect(classify(grade(t, [sorted(chatter())])).pass).toBe(true);
    expect(
      classify(
        grade(t, [sorted([...chatter(), voice(3000, "wake_detected")])]),
      ),
    ).toMatchObject({ code: "WRONG_PLAN", subcode: "FALSE_WAKE" });
  });

  it("adds a soft latency class without failing the turn", () => {
    const slowAction = grade(
      task("app-open-notes"),
      [fastStart({ firstActionMs: 11_000 })],
      { frontmost: evidence("com.apple.Notes") },
    );
    expect(classify(slowAction)).toEqual({
      pass: true,
      softCode: "SLOW_FIRST_ACTION",
      subcode: undefined,
    });
    const slowReply = grade(task("ask-time"), [answer({ replyMs: 9500 })]);
    expect(classify(slowReply)).toEqual({
      pass: true,
      softCode: "SLOW_REPLY",
      subcode: "ANSWER",
    });
    expect(
      classify(grade(task("ask-time"), [answer({ replyMs: 7000 })])).softCode,
    ).toBeUndefined();
  });

  it("names a takeover from the event or from a HID reset the app cannot explain", () => {
    const manual = sorted([
      ...fastStart(),
      ev(8000, "UserTakeoverStarted", {
        runId: RUN,
        data: { source: "manual_input" },
      }),
    ]);
    expect(classify(grade(task("app-open-notes"), [manual]))).toMatchObject({
      code: "TAKEOVER",
    });
    expect(
      classify(
        grade(task("app-open-notes"), [fastStart()], {}, { hidTakeover: true }),
      ),
    ).toMatchObject({ code: "TAKEOVER" });
    expect(
      hidTakeover({ now: T0 + 10_000, hidIdleSeconds: 2, promptStartedAt: T0 }),
    ).toBe(true);
    // The app's own click a moment ago explains the reset.
    expect(
      hidTakeover({
        now: T0 + 10_000,
        hidIdleSeconds: 2,
        promptStartedAt: T0,
        lastActionAt: T0 + 8500,
      }),
    ).toBe(false);
    expect(
      hidTakeover({
        now: T0 + 10_000,
        hidIdleSeconds: 60,
        promptStartedAt: T0,
      }),
    ).toBe(false);
    expect(
      hidTakeover({
        now: T0 + 10_000,
        hidIdleSeconds: undefined,
        promptStartedAt: T0,
      }),
    ).toBe(false);
  });

  it("applies each check operator over normalized text, never returning a value", () => {
    const check = (
      expect_: Parameters<typeof checkHolds>[0]["expect"],
      value: string | number | [number, number],
      read: string,
    ) =>
      checkHolds(
        { name: "c", kind: "sh", script: "", expect: expect_, value },
        evidence(read),
      );
    expect(
      check("contains", "example com", "https://www.example.com/index.html"),
    ).toBe(true);
    expect(
      check(
        "contains",
        "lovelace",
        "https://en.wikipedia.org/wiki/Ada_Lovelace",
      ),
    ).toBe(true);
    expect(
      check(
        "notContains",
        "search",
        "https://en.wikipedia.org/wiki/Ada_Lovelace",
      ),
    ).toBe(true);
    expect(
      check(
        "equals",
        "Keep this line voiceloopab12",
        "Keep this line voiceloopab12\n",
      ),
    ).toBe(true);
    expect(
      check(
        "matches",
        "shopping .*milk.*eggs",
        "Shopping voiceloopab12\nmilk, eggs",
      ),
    ).toBe(true);
    expect(check("gt", 200, "312.5")).toBe(true);
    expect(check("lt", 50, "44")).toBe(true);
    expect(check("lt", 50, "50")).toBe(false);
    expect(
      check(
        "inRange",
        [300_000, 500_000],
        "Iceland voiceloopab12\n387,758 people",
      ),
    ).toBe(true);
    expect(check("inRange", [300_000, 500_000], "Iceland 12")).toBe(false);
    expect(check("nonempty", "", "  \n")).toBe(false);
    expect(
      checkHolds(
        { name: "c", kind: "sh", script: "", expect: "exitZero" },
        evidence("", 2),
      ),
    ).toBe(false);
    expect(
      checkHolds(
        { name: "c", kind: "sh", script: "", expect: "contains", value: "x" },
        undefined,
      ),
    ).toBeNull();
  });

  it("counts mutations like the bench grader and fails a look that changed something", () => {
    const typed = sorted([
      ...fastStart({ transcript: "what is on my screen" }),
      ev(7500, "ActionExecuted", {
        runId: RUN,
        actionType: "type_text",
        textLength: 5,
      }),
    ]);
    const g = grade(task("ask-screen"), [typed]);
    expect(g.mutations).toBe(1);
    expect(g.checks.noMutation).toBe(false);
    expect(g.checksFailed).toContain("noMutation");
    // The reply lacks the marker too, and that check is primary: a false done.
    expect(classify(g)).toMatchObject({
      code: "WRONG_STATE",
      subcode: "FALSE_DONE",
    });
    // With the marker in the reply and no mutation, it passes.
    const looked = sorted([
      ...fastStart({ transcript: "what is on my screen" }).filter(
        (e) => e.event !== "ActionExecuted",
      ),
      ev(8900, "RunState", {
        runId: RUN,
        status: "summarizing",
        message: `${MARK} the loop marker is voiceloopab12`,
      }),
    ]);
    expect(classify(grade(task("ask-screen"), [looked])).pass).toBe(true);
  });
});

/* ------------------------------------------------------------------- gate */

describe("voice gate: pure decisions", () => {
  const settled: VoiceGateFacts = {
    now: T0 + 100_000,
    hidIdleSeconds: 60,
    idleSeconds: 45,
    listening: true,
    lastEventAt: T0 + 90_000,
    followupOpen: false,
    runOpen: false,
  };

  it("needs the full idle at the start and after a person, but only since the app's last action between tasks", () => {
    expect(voiceGate(settled)).toEqual({
      ok: true,
      idle: { required: 45, seen: 60 },
    });
    const start = voiceGate({ ...settled, hidIdleSeconds: 20 });
    expect(start).toEqual({
      ok: false,
      reason: "HID_ACTIVE",
      idle: { required: 45, seen: 20 },
    });
    // The app clicked 10 s ago: 7 s of idle (10 - 3 slack) is enough.
    const between = voiceGate({
      ...settled,
      hidIdleSeconds: 8,
      lastActionAt: T0 + 90_000,
    });
    expect(between.ok).toBe(true);
    expect(between.idle).toEqual({ required: 7, seen: 8 });
    // A person seen since asks for the full idle again.
    expect(
      voiceGate({
        ...settled,
        hidIdleSeconds: 8,
        lastActionAt: T0 + 90_000,
        humanSeenAt: T0 + 95_000,
      }),
    ).toMatchObject({
      ok: false,
      reason: "HID_ACTIVE",
    });
    expect(voiceGate({ ...settled, hidIdleSeconds: undefined })).toMatchObject({
      ok: false,
      reason: "HID_ACTIVE",
    });
  });

  it("waits for a settled, listening app before it looks at idle", () => {
    expect(voiceGate({ ...settled, runOpen: true })).toMatchObject({
      reason: "RUN_OPEN",
    });
    expect(voiceGate({ ...settled, followupOpen: true })).toMatchObject({
      reason: "FOLLOWUP_OPEN",
    });
    expect(
      voiceGate({ ...settled, speechFinishedAt: T0 + 99_500 }),
    ).toMatchObject({ reason: "SPEAKING" });
    expect(voiceGate({ ...settled, lastEventAt: T0 + 97_000 })).toMatchObject({
      reason: "BUSY",
    });
    expect(voiceGate({ ...settled, listening: false })).toMatchObject({
      reason: "NOT_LISTENING",
    });
    expect(voiceGate({ ...settled, listening: null })).toMatchObject({
      reason: "NOT_LISTENING",
    });
    expect(
      voiceGate({
        ...settled,
        volume: { level: 40, muted: false, wanted: 60 },
      }),
    ).toMatchObject({ reason: "VOLUME" });
    expect(
      voiceGate({ ...settled, volume: { level: 60, muted: true, wanted: 60 } }),
    ).toMatchObject({ reason: "VOLUME" });
    expect(
      voiceGate({ ...settled, volume: { level: 61, muted: false, wanted: 60 } })
        .ok,
    ).toBe(true);
  });

  it("calls the room quiet from the two newest standby levels under a calibrated threshold", () => {
    const threshold = quietThreshold(4, 40);
    expect(threshold).toBeCloseTo(16.6);
    expect(quietThreshold(10, 5)).toBe(10);
    expect(medianLevel([4, 9, 5])).toBe(5);
    expect(medianLevel([4, 6])).toBe(5);
    expect(medianLevel([])).toBeUndefined();
    expect(
      voiceGate({ ...settled, quiet: { levels: [4, 5, 4], threshold } }).ok,
    ).toBe(true);
    expect(
      voiceGate({ ...settled, quiet: { levels: [4, 5, 30], threshold } }),
    ).toMatchObject({ reason: "NOISE" });
    expect(
      voiceGate({ ...settled, quiet: { levels: [4], threshold } }),
    ).toMatchObject({ reason: "NOISE" });
    expect(
      voiceGate({
        ...settled,
        quiet: { levels: [4, 4], threshold, heardTextAt: T0 + 95_000 },
      }),
    ).toMatchObject({ reason: "NOISE" });
    expect(
      voiceGate({
        ...settled,
        quiet: { levels: [4, 4], threshold, heardTextAt: T0 + 80_000 },
      }).ok,
    ).toBe(true);
  });
});

/* --------------------------------------------------------------- classify */

/** A passing grade to break one field at a time. */
function passing(over: Partial<TurnGrade> = {}): TurnGrade {
  return {
    taskId: "app-open-notes",
    category: "app",
    tags: ["fast-start"],
    noisy: false,
    heard: "heard",
    unheardUtterance: null,
    expectOutcome: "run",
    observed: ["run"],
    planMatched: true,
    planReasons: [],
    taskWordsOk: null,
    runStarted: true,
    terminal: "completed",
    runCompletedRequired: true,
    noConfirmationRequired: true,
    confirmations: 0,
    needClick: false,
    handoffSources: [],
    takeover: false,
    stoppedByLoop: false,
    timedOut: false,
    envSubcode: null,
    failures: [],
    actions: 1,
    mutations: 0,
    checks: {},
    checksFailed: [],
    primaryFailed: [],
    unreadable: [],
    firstActionAfterTranscriptMs: 1000,
    replyAfterTranscriptMs: 200,
    firstActionLimitMs: 4000,
    replyLimitMs: 2000,
    replyIsAck: true,
    spoken: true,
    ...over,
  };
}

describe("voice classify: precedence, owners and ranking", () => {
  it("decides the class in the design's order, first match wins", () => {
    const everything: Partial<TurnGrade> = {
      envSubcode: "NOT_LISTENING",
      takeover: true,
      heard: "unheard",
      planMatched: false,
      planReasons: ["EXPECTED_RUN_GOT_ANSWER"],
      confirmations: 1,
      terminal: "failed",
      timedOut: true,
      checksFailed: ["frontmost"],
    };
    const order: [keyof TurnGrade, unknown, string][] = [
      ["envSubcode", null, "TAKEOVER"],
      ["takeover", false, "UNHEARD"],
      ["heard", "misheard", "MISHEARD"],
      ["heard", "heard", "WRONG_PLAN"],
      ["planMatched", true, "NEEDS_CLICK"],
      ["confirmations", 0, "RUN_FAILED"],
      ["terminal", null, "RUN_INCOMPLETE"],
      ["timedOut", false, "RUN_INCOMPLETE"],
      ["terminal", "completed", "WRONG_STATE"],
      ["checksFailed", [], "pass"],
    ];
    let over = { ...everything };
    expect(classify(passing(over)).code).toBe("ENV_NOT_READY");
    for (const [field, value, expected] of order) {
      over = { ...over, [field]: value };
      const c = classify(passing(over));
      expect(
        expected === "pass" ? c.pass : c.code,
        `${field}=${String(value)}`,
      ).toBe(expected === "pass" ? true : expected);
    }
    expect(classify(passing({ unreadable: ["urlIsExample"] }))).toMatchObject({
      code: "ENV_NOT_READY",
      subcode: "STATE_UNREADABLE",
    });
    expect(classify(passing({ heard: "unheard", noisy: true })).code).toBe(
      "UNHEARD_NOISY",
    );
    expect(
      classify(
        passing({
          runCompletedRequired: true,
          terminal: "cancelled",
          stoppedByLoop: true,
        }),
      ),
    ).toMatchObject({ code: "RUN_INCOMPLETE", subcode: "cancelled" });
    // Soft classes only on a turn that otherwise passed, and never both at once.
    expect(
      classify(
        passing({
          firstActionAfterTranscriptMs: 5000,
          replyAfterTranscriptMs: 5000,
        }),
      ),
    ).toEqual({
      pass: true,
      softCode: "SLOW_FIRST_ACTION",
      subcode: undefined,
    });
    expect(
      classify(
        passing({ firstActionAfterTranscriptMs: 5000, checksFailed: ["x"] }),
      ).softCode,
    ).toBeUndefined();
  });

  it("maps fine owners to loop owners and writes the note laneBrief prints", () => {
    for (const code of FAILURE_CODES) {
      expect(OWNER[code]).toBeTruthy();
      expect(["agent", "harness", "grader", "user"]).toContain(
        LOOP_OWNER[code],
      );
      expect(noteFor(code)).toMatch(
        new RegExp(`^\\[${OWNER[code].replace("/", "\\/")}`),
      );
    }
    expect(LOOP_OWNER.TAKEOVER).toBe("user");
    expect(LOOP_OWNER.UNHEARD).toBe("agent");
    expect(loopOwnerOf("ENV_NOT_READY", "STATE_UNREADABLE")).toBe("grader");
    expect(loopOwnerOf("ENV_NOT_READY", "NOT_LISTENING")).toBe("harness");
    expect(noteFor("UNHEARD")).toMatch(/native\/macos\/Voice\.swift/);
    expect(noteFor("NEEDS_CLICK")).toMatch(/src\/core\/policy\.ts/);
    expect(noteFor("NEEDS_CLICK")).toMatch(/refusal may not be removed/i);
    expect(strictVoiceClass("NEEDS_CLICK")).toBe(true);
    expect(strictVoiceClass("WRONG_STATE")).toBe(true);
    expect(strictVoiceClass("UNHEARD")).toBe(false);
    expect(COST_WEIGHT.NEEDS_CLICK).toBeGreaterThan(COST_WEIGHT.WRONG_STATE);
    expect(COST_WEIGHT.SLOW_REPLY).toBe(1);
  });

  it("ranks classes by count x cost, with the design's order as the tie-break", () => {
    const ranked = rankClasses([
      { code: "UNHEARD" },
      { code: "UNHEARD" },
      { code: "UNHEARD" },
      { code: "UNHEARD" },
      { code: "NEEDS_CLICK" },
      { code: "MISHEARD" },
      { code: "MISHEARD" },
      { code: null, softCode: "SLOW_REPLY" },
    ]);
    expect(ranked.map((c) => c.code)).toEqual([
      "UNHEARD",
      "NEEDS_CLICK",
      "MISHEARD",
      "SLOW_REPLY",
    ]);
    expect(ranked[0]).toMatchObject({
      count: 4,
      score: 12,
      rank: 1,
      soft: false,
    });
    expect(ranked[1]).toMatchObject({ count: 1, score: 10, rank: 2 });
    expect(ranked[3]).toMatchObject({ soft: true });
    // Equal scores (3 x 2 and 2 x 3) keep the design's row order: UNHEARD_NOISY is row 3, UNHEARD row 4.
    const tie = rankClasses([
      { code: "UNHEARD_NOISY" },
      { code: "UNHEARD_NOISY" },
      { code: "UNHEARD_NOISY" },
      { code: "UNHEARD" },
      { code: "UNHEARD" },
    ]);
    expect(tie.map((c) => c.code)).toEqual(["UNHEARD_NOISY", "UNHEARD"]);
    expect(tie[0].score).toBe(tie[1].score);
  });
});

/* ----------------------------------------------------------------- report */

const plan: VoicePlan = {
  id: "20260919-2200-75ed88e",
  startedAt: at(0),
  gitRev: "75ed88e",
  gitBranch: "feat/memory-voice-natural-speech",
  dirty: false,
  host: { macos: "14.2", arch: "arm64" },
  app: {
    path: "release/mac-arm64/Butler.app",
    bundleId: "ai.coarena.openassist",
    version: "0.1.0",
    build: "1",
    executableMtime: at(-3_600_000),
  },
  voice: "Samantha",
  rate: 175,
  wake: "Hey Butler",
  idleSeconds: 45,
  noisy: false,
  requireQuiet: false,
  suiteHash: suiteHash(fixtureJson, ["g"]),
  tasks: suite.tasks.slice(0, 5).map((t) => ({
    id: t.id,
    category: t.category,
    tags: t.tags,
    say: turnsOf(t)[0].say,
    expectOutcome: turnsOf(t)[0].expect.outcome,
    timeoutMs: defaultTimeoutMs(t),
  })),
  repeat: 1,
};
const preflight: PreflightFacts = {
  codes: [],
  listening: true,
  permissions: {
    screen: true,
    accessibility: true,
    microphone: true,
    speech: true,
  },
  verbose: true,
  quiet: { floor: 4, speech: 40, threshold: 16.6, source: "trace" },
  volume: 60,
  skipped: { "dictate-notes-line": "NOTES_AUTOMATION" },
};
const gate = {
  count: 2,
  totalSeconds: 30,
  byReason: { HID_ACTIVE: 1, BUSY: 1 },
  longestSeconds: 20,
};

function record(
  t: VoiceTask,
  events: DiagnosticEvent[][],
  ev: Record<string, { value?: string; exitCode: number; ms: number }> = {},
  context = {},
  attempt = 1,
): TurnRecord {
  const summaries = events.map((slice) =>
    summarizeTurn(slice, spokenAt, sayEndedAt),
  );
  const g = gradeTurn(t, summaries, ev, { verbose: true, ...context });
  return {
    turnId: `${t.id}#${attempt}`,
    taskId: t.id,
    attempt,
    at: at(0),
    wallMs: 12_000,
    grade: g,
    classification: classify(g),
    summaries,
    gate: { waitedMs: 0, reasons: {}, idleSeen: 60, quietRms: 4 },
  };
}

function cycleOf(
  turns: TurnRecord[],
  previous: VoiceResults | null = null,
): VoiceResults {
  return buildResults({
    plan,
    turns,
    preflight,
    gate,
    previous,
    finishedAt: at(3_600_000),
  });
}

const front = { frontmost: evidence("com.apple.Notes") };
const unheardRows = (n: number, from = 1) =>
  Array.from({ length: n }, (_, i) =>
    record(task("app-open-notes"), [sorted(chatter())], {}, {}, from + i),
  );

describe("voice report: results, lanes and the brief", () => {
  const turns = [
    record(task("app-open-notes"), [fastStart()], front),
    record(task("ask-time"), [answer()]),
    ...unheardRows(3, 2),
    record(
      task("ask-time"),
      [fastStart({ transcript: "what time is it" })],
      {},
      {},
      2,
    ),
    record(task("app-open-notes"), [fastStart()], {}, { hidTakeover: true }, 5),
    record(
      task("app-open-notes"),
      [fastStart({ firstActionMs: 12_000 })],
      front,
      {},
      6,
    ),
  ];
  const results = cycleOf(turns);

  it("aggregates ran turns without the environment's, and ranks the classes", () => {
    // 8 rows; the takeover is the room's, so 7 ran.
    expect(results.results).toHaveLength(8);
    expect(results.aggregate.ran).toBe(7);
    expect(results.aggregate.passed).toBe(3);
    expect(results.aggregate.handsFree.rate).toBeCloseTo(3 / 7);
    expect(results.environment.takeover).toBe(1);
    expect(results.failureClasses.map((c) => c.code)).toEqual([
      "UNHEARD",
      "WRONG_PLAN",
      "SLOW_FIRST_ACTION",
      "TAKEOVER",
    ]);
    const unheard = results.failureClasses[0];
    expect(unheard).toMatchObject({
      attempts: 3,
      owner: "agent",
      source: "grade",
      rank: 1,
    });
    expect(unheard.attemptRate).toBeCloseTo(3 / 7);
    expect(unheard.byCategory.app.attempts).toBe(3);
    expect(unheard.examples.map((e) => e.runId)).toEqual([
      "app-open-notes#2",
      "app-open-notes#3",
      "app-open-notes#4",
    ]);
    expect(unheard.contributors).toContain("owner:recognizer/gate");
    const soft = results.failureClasses.find(
      (c) => c.code === "SLOW_FIRST_ACTION",
    )!;
    expect(soft.attempts).toBe(0);
    expect(soft.passedAttempts).toBe(1);
    expect(results.aggregate.latency.p50.firstActionAfterTranscriptMs).toBe(
      1000,
    );
    expect(results.cycle.matrix).toEqual([
      { provider: "app", model: "openai:gpt-5.4-mini" },
    ]);
    expect(results.schema_version).toBe(2);
    expect(results.kind).toBe("voice");
  });

  it("feeds the real selectLanes and laneBrief without any loop change", () => {
    const cycle = toCycleResults(results);
    const lanes = selectLanes(cycle, emptyLoopState());
    expect(lanes.map((l) => l.code)).toEqual(["UNHEARD"]);
    expect(lanes[0].owner).toBe("agent");
    expect(lanes[0].examples).toEqual([
      "app-open-notes#2",
      "app-open-notes#3",
      "app-open-notes#4",
    ]);
    const brief = laneBrief(lanes[0], cycle, {
      probeCommand: results.cycle.probeCommand,
      suites: ["npm test"],
    });
    expect(brief).toMatch(
      /Analyzer note: \[recognizer\/gate: native\/macos\/Voice\.swift/,
    );
    expect(brief).toMatch(/npm run voice:loop/);
    // TAKEOVER is the user's and never a lane; a one-off WRONG_PLAN is too small.
    expect(lanes.map((l) => l.code)).not.toContain("TAKEOVER");
    expect(lanes.map((l) => l.code)).not.toContain("WRONG_PLAN");
  });

  it("keeps every transcript, task text and message out of results.json, report.md and the briefs", () => {
    const json = JSON.stringify(results);
    const report = renderReport(results);
    const briefs = results.failureClasses
      .map((c) => fixBrief(c, results))
      .join("\n");
    for (const text of [json, report, briefs]) {
      expect(text).not.toContain(MARK);
      expect(text).not.toMatch(/Quit this application/);
    }
    // The summaries did carry it, so the test is real.
    expect(JSON.stringify(turns[0].summaries)).toContain(MARK);
    // The fixture's own catalogue text is allowed: it is the loop's, not the user's.
    expect(json).toContain('"say":"open Notes"');
  });

  it("renders every section of the report and prints the fine owner and evidence", () => {
    const report = renderReport(results);
    for (const heading of [
      "# Voice cycle",
      "## North star",
      "## Pass rate by category and tag",
      "## Failure classes by count x cost",
      "## Environment",
      "## Against the previous cycle",
      "## Turns",
      "## Gate",
      "## Preflight",
    ])
      expect(report).toContain(heading);
    expect(report).toMatch(/\*\*UNHEARD\*\* — recognizer\/gate; 3 turn\(s\)/);
    expect(report).toMatch(/Evidence: standby_trace levels/);
    expect(report).toMatch(/\*\*SLOW_FIRST_ACTION\*\* \*\(soft\)\*/);
    expect(report).toMatch(/Hands-free success .*\*\*42\.9%\*\*/);
    expect(report).toMatch(/floor 4 \/ speech 40 \/ threshold 16\.6/);
    expect(report).toMatch(/dictate-notes-line: NOTES_AUTOMATION/);
    expect(report).toMatch(
      /\| app-open-notes#1 \| yes \| start -> fast_start \| completed \| 1 \| 0 \| 1000 ms \| 200 ms \| pass \|/,
    );
    expect(report).toMatch(/No earlier cycle at this suite hash/);
  });

  it("writes a brief that names the floors, the probe with the class's tasks, and never a merge", () => {
    const brief = fixBrief(results.failureClasses[0], results);
    expect(brief).toMatch(/^# Voice fix lane: UNHEARD/);
    expect(brief).toMatch(/Fine owner: recognizer\/gate/);
    expect(brief).toMatch(
      /src\/core\/policy\.ts, src\/voice\/turns\.ts, native\/macos\/WakePolicy\.swift, native\/macos\/TurnPolicy\.swift/,
    );
    expect(brief).toMatch(/never merges/);
    expect(brief).toMatch(
      /--only app-open-notes --repeat 3 --cycle-id probe-unheard-<id>/,
    );
    expect(brief).toMatch(/voiceTurn/);
    expect(brief).toMatch(/Fixed at or below 10\.0%/);
    expect(fixBrief(results.failureClasses[1], results)).toMatch(
      /Fixed at or below 10\.0%/,
    );
    const strict = { ...results.failureClasses[0], code: "NEEDS_CLICK" };
    expect(fixBrief(strict, results)).toMatch(/Fixed at or below 5\.0%/);
  });

  it("compares cycles at the same suite hash and calls small differences inconclusive", () => {
    const before = cycleOf([
      record(task("app-open-notes"), [fastStart()], front),
      ...unheardRows(4, 2),
    ]);
    const after = cycleOf(
      [
        record(task("app-open-notes"), [fastStart()], front),
        ...unheardRows(2, 2),
        record(task("ask-time"), [
          fastStart({ transcript: "what time is it" }),
        ]),
      ],
      before,
    );
    expect(after.previous?.cycleId).toBe(before.cycle.id);
    const delta = after.previous!.classDelta;
    expect(delta.UNHEARD.verdict).toBe("inconclusive");
    expect(delta.UNHEARD.before).toEqual({ k: 4, n: 5, rate: 0.8 });
    expect(delta.UNHEARD.after.k).toBe(2);
    expect(delta.UNHEARD.neededAttempts).toBeGreaterThan(5);
    expect(delta.WRONG_PLAN.verdict).toBe("new");
    // Gone needs enough attempts to mean anything.
    const gone = compareCycles(
      before,
      cycleOf(
        Array.from({ length: 12 }, (_, i) =>
          record(task("app-open-notes"), [fastStart()], front, {}, i + 1),
        ),
      ),
    );
    expect(gone.UNHEARD.verdict).toBe("gone");
    // A different suite hash is never compared.
    const other = buildResults({
      plan: { ...plan, suiteHash: "different" },
      turns: [],
      preflight,
      gate,
      previous: before,
      finishedAt: at(1),
    });
    expect(other.previous).toBeNull();
    expect(renderReport(after)).toMatch(
      /\| UNHEARD \| 4\/5 \| 2\/4 \| inconclusive/,
    );
  });
});

/* ----------------------------------------------------------------- script */

describe("voice loop: the script", () => {
  const source = readFileSync(join(root, "scripts/voice-loop.mjs"), "utf8");

  it(
    "prints the plan for --dry-run without speaking, and exits 0",
    { timeout: 90_000 },
    () => {
      const result = spawnSync(
        "node",
        [
          join(root, "scripts/voice-loop.mjs"),
          "--dry-run",
          "--only",
          "fast-start",
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, NODE_OPTIONS: "" },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/Dry run/);
      expect(result.stdout).toMatch(/app-open-notes/);
      expect(result.stdout).toMatch(/fast-start/);
      expect(result.stdout).toMatch(/estimate/i);
      expect(result.stdout).toMatch(/suite [0-9a-f]{12}/);
      expect(result.stdout).toMatch(/nothing spoken/i);
      expect(result.stdout).not.toMatch(/noisy-open-notes/);
    },
  );

  it("never launches, quits or speaks to the app on its own, and needs the consent flag to run", () => {
    expect(source).toMatch(/--i-know-this-speaks-to-my-mac/);
    expect(source).not.toMatch(/open -a Butler|open", \["-a", "Butler/);
    expect(source).not.toMatch(/process\.kill\(\s*appPid|killall/);
    expect(source).not.toMatch(/"merge"|git merge|git push/);
    // Pure modules and the presence readers only; never the controller, runner or providers.
    expect(source).not.toMatch(
      /electron\/controller|src\/core\/runner|src\/providers|electron\/credentials|\.env\b/,
    );
    // A "stop" is spoken only for a run still going or a confirmation.
    expect(source).toMatch(/stopRun\(/);
    // A takeover ends the cycle with nothing said.
    expect(source).toMatch(/TAKEOVER/);
    expect(source).toMatch(/exitCode = 3/);
    expect(source).toMatch(/nothing more is said/);
    expect(source).toMatch(/acquireDesktopLock/);
  });

  it("is registered as a script and documented", () => {
    const pkg = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts["voice:loop"]).toBe("node scripts/voice-loop.mjs");
    const docs = readFileSync(join(root, "docs/VOICE_LOOP.md"), "utf8");
    expect(docs).toMatch(/voice-loop\.mjs/);
    expect(docs).toMatch(/--dry-run/);
    for (const code of FAILURE_CODES) expect(docs, code).toContain(code);
    expect(docs).toMatch(/never approve/i);
    expect(docs).toMatch(/npm run loop -- --output output\/voice/);
  });
});
