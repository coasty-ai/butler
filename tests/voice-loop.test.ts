import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emptyLoopState, laneBrief, selectLanes } from "../src/gym/loop";
import {
  COST_WEIGHT,
  FAILURE_CODES,
  LOOP_OWNER,
  OWNER,
  SOFT_CODES,
  classify,
  loopOwnerOf,
  noteFor,
  rankClasses,
  strictVoiceClass,
} from "../src/gym/voice/classify";
import {
  GATE_CAP_MS,
  GATE_REASON_MEANS,
  GATE_STUCK_MS,
  GateWait,
  HID_CONFIRM_MS,
  HID_CONFIRM_RUN_MS,
  HidTakeoverTracker,
  STUCK_STOP,
  checkHolds,
  followupReady,
  gradeTurn,
  heardVerdict,
  hidTakeover,
  isSpeechSample,
  lastTurnDone,
  medianLevel,
  outcomeMatches,
  quietThreshold,
  summarizeTurn,
  summarizeUtterances,
  voiceGate,
  type DiagnosticEvent,
  type TurnGrade,
  type VoiceGateFacts,
  type VoiceGateReason,
} from "../src/gym/voice/grade";
import {
  SETUP_SAID_CHARS,
  SKIP_REMEDY,
  buildResults,
  compareCycles,
  fixBrief,
  renderReport,
  setupFailureDetail,
  toCycleResults,
  type PreflightFacts,
  type TurnRecord,
  type VoicePlan,
  type VoiceResults,
} from "../src/gym/voice/report";
import { AppWatch, linesSince } from "../src/gym/voice/watch";
import {
  AUTOMATION_PROBES,
  POLL,
  STEP,
  TOKEN_RE,
  defaultTimeoutMs,
  estimateSeconds,
  fillPlaceholders,
  loadSuite,
  pollStepResult,
  pollUntilTrue,
  selectTasks,
  suiteHash,
  taskProbes,
  taskSkips,
  turnsOf,
  validateSuite,
  voiceToken,
  type Script,
  type StepResult,
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
    // Chained like the script does it: each utterance seeded with the run
    // status the one before it left.
    summarizeUtterances(
      events.map((slice) => ({ events: slice, spokenAt, sayEndedAt })),
    ),
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
    // A probe that could not be read (`shortcuts list` timed out) is a
    // failed probe, never a pass: the task's cleanup needs the shortcut.
    const unknown = taskSkips(suite.tasks, {
      "focus-shortcut": null,
      "notes-automation": null,
    });
    expect(unknown["sys-do-not-disturb"]).toBe("SHORTCUT_UNKNOWN");
    expect(unknown["dictate-notes-line"]).toBe("NOTES_AUTOMATION_UNKNOWN");
    expect(SKIP_REMEDY.SHORTCUT_UNKNOWN).toMatch(/shortcuts list/);
    expect(SKIP_REMEDY.NOTES_AUTOMATION_UNKNOWN).toBeTruthy();
    // An unprobed thing (undefined) skips nothing.
    expect(taskSkips(suite.tasks, {})).toEqual({});
  });

  it("finds and deletes the dictation note by its body, never its name", () => {
    // Notes names a note after its first line: a line typed above the token
    // would rename it, error the check (STATE_UNREADABLE) and orphan it.
    const t = task("dictate-notes-line");
    const scripts = [
      ...(t.expect?.state ?? []).map((c) => c.script),
      ...(t.cleanup ?? []).map((c) => c.script),
    ].filter((script) => script.includes("{token}"));
    expect(scripts.length).toBeGreaterThanOrEqual(3);
    for (const script of scripts) {
      expect(script).toMatch(/plaintext contains "\{token\}"/);
      expect(script).not.toMatch(/name contains/);
    }
  });

  it("starts the barge-in at SpeechOut requested, over an answer long enough to still be playing", () => {
    const [question, stop] = turnsOf(task("steer-stop-while-speaking"));
    expect(stop.after).toEqual({ event: "SpeechOut", plus: 0 });
    expect(stop.bargeIn).toBe(true);
    // Wake detection takes 2.2-3 s from say start; a one-word answer is over by then.
    expect(question.say).toMatch(/planets/);
    expect(question.heard).toBe("planets");
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

  it("opens its own documents through LaunchServices and scripts an app only once System Events saw a window of its", () => {
    // Cycle 1 (2026-09-19 00:55): four setups exited 124 on the first Apple
    // Event to a TextEdit or Safari that was launching, or behind the
    // terminal's consent prompt. No setup step guesses with a sleep any more,
    // an `open -a TextEdit <file>` is always followed by a poll on the window,
    // and Calculator is never sent an Apple Event.
    const scripts = (t: VoiceTask): Script[] => [
      ...(t.setup ?? []),
      ...(t.cleanup ?? []),
      ...turnsOf(t).flatMap((turn) => turn.expect.state ?? []),
    ];
    for (const t of suite.tasks) {
      for (const step of t.setup ?? [])
        expect(step.script, `${t.id} sleeps`).not.toMatch(/\bsleep\b/);
      for (const [index, step] of (t.setup ?? []).entries())
        if (/open -a TextEdit "/.test(step.script))
          expect(
            (t.setup ?? [])
              .slice(index + 1)
              .some((s) => s.poll && s.script.includes('process "TextEdit"')),
            `${t.id} step ${index} opens a document and never waits for its window`,
          ).toBe(true);
      for (const step of scripts(t))
        expect(step.script, t.id).not.toMatch(/tell application "Calculator"/);
    }
    const newWindow = task("app-new-window-textedit").setup ?? [];
    expect(newWindow[1].script).toMatch(
      /open -a TextEdit "\/tmp\/butler-voice-loop-\{token\}\.txt"/,
    );
    expect(newWindow[2]).toMatchObject({ kind: "osascript", poll: true });
    expect(newWindow[2].script).toMatch(
      /System Events.*process "TextEdit" whose name contains "\{token\}"/,
    );
    expect(newWindow[2].timeoutMs).toBeLessThanOrEqual(STEP.maxTimeoutMs);
    const safari = task("browse-goto-example").setup ?? [];
    expect(safari.map((s) => s.kind)).toEqual([
      "osascript",
      "osascript",
      "osascript",
      "osascript",
    ]);
    // Safari found running with zero windows gets one (the first rehearsal,
    // 2026-09-19, waited 20 s for a window `open -a Safari` never made), and
    // the task then uses that window, so closing it leaves Safari as found.
    expect(safari[1]).toMatchObject({ record: "safariLaunchWindow" });
    expect(safari[1].script).toMatch(/count windows of process "Safari"/);
    expect(safari[1].script).toMatch(
      /if n is 0 then\n  do shell script "open -a Safari about:blank"\n  return "true"/,
    );
    expect(safari[2]).toMatchObject({ poll: true });
    expect(safari[3].script).toMatch(
      /if "\{state\.safariLaunchWindow\}" is "true" then\n    set URL of current tab of window 1 to "about:blank"\n  else\n    make new document with properties \{URL:"about:blank"\}\n  end if/,
    );
    for (const t of suite.tasks) {
      const setup = t.setup ?? [];
      const tells = setup.findIndex(
        (s) =>
          !s.poll &&
          s.script.includes('tell application "Safari"') &&
          !s.script.includes('application "Safari" is running'),
      );
      if (tells < 0) continue;
      expect(
        setup.slice(0, tells).some((s) => s.record === "safariLaunchWindow"),
        `${t.id} scripts Safari without giving it a window first`,
      ).toBe(true);
      expect(setup[tells].script, t.id).toMatch(
        /\{state\.safariLaunchWindow\}/,
      );
    }
    const calc = task("app-quit-calculator");
    expect(calc.setup?.[1].script).toBe("open -a Calculator");
    expect(calc.setup?.[2]).toMatchObject({ poll: true });
    expect(calc.cleanup?.[0].script).toMatch(
      /"\{state\.calcWasRunning\}" = "false".*pkill -x Calculator/,
    );
    // The rich-text file for the bold follow-up is written with %s, so printf
    // never reads its \r and \f as control characters.
    expect(task("dictate-follow-up-bold").setup?.[1].script).toMatch(
      /printf '%s' '\{\\rtf1/,
    );
    // The invariants behind those facts.
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
    const cleanup = [{ kind: "sh", script: "true" } as Script];
    const tellTextEdit: Script = {
      kind: "osascript",
      script: 'tell application "TextEdit" to return (count windows) as string',
    };
    const pollTextEdit: Script = {
      kind: "osascript",
      poll: true,
      timeoutMs: 20_000,
      script:
        'tell application "System Events" to return (exists (window 1 of process "TextEdit")) as string',
    };
    expect(bad({ setup: [tellTextEdit], cleanup }).join()).toMatch(
      /step 0 scripts TextEdit before a window of its exists/,
    );
    expect(bad({ setup: [pollTextEdit, tellTextEdit], cleanup })).toEqual([]);
    expect(
      bad({
        setup: [
          {
            kind: "osascript",
            script:
              'if application "TextEdit" is running then tell application "TextEdit" to return (count windows) as string',
          },
        ],
        cleanup,
      }),
    ).toEqual([]);
    expect(
      bad({
        cleanup: [
          {
            kind: "osascript",
            script: 'tell application "Calculator" to quit',
          },
        ],
      }).join(),
    ).toMatch(/Apple Events to Calculator, which takes none/);
    expect(
      bad({ cleanup: [{ kind: "sh", script: "pkill -x Safari" }] }).join(),
    ).toMatch(/kills outside/);
    expect(
      bad({ cleanup: [{ kind: "sh", script: "pkill -x Calculator" }] }).join(),
    ).toMatch(/kills outside/);
    expect(
      bad({
        setup: [
          {
            kind: "osascript",
            script:
              'tell application "System Events" to return (exists process "Calculator") as string',
            record: "calcWasRunning",
          },
        ],
        cleanup: [
          {
            kind: "sh",
            script:
              'if [ "{state.calcWasRunning}" = "false" ]; then pkill -x Calculator; fi; true',
          },
        ],
      }),
    ).toEqual([]);
    expect(
      bad({
        cleanup: [{ kind: "sh", script: "true", timeoutMs: 90_000 }],
      }).join(),
    ).toMatch(/timeoutMs 90000 out of bounds/);
    expect(
      bad({
        cleanup: [{ kind: "sh", script: "true", intervalMs: 250 }],
      }).join(),
    ).toMatch(/needs a poll step/);
  });

  it("polls until a step says true, bounded in all and per try, and reports a failed poll as exit 124 with what the last try said", async () => {
    let clock = 0;
    const now = () => clock;
    const slept: number[] = [];
    const sleep = async (ms: number) => {
      slept.push(ms);
      clock += ms;
    };
    const answers = ["false", "", "true"];
    const tries: number[] = [];
    const attempt = async (timeoutMs: number): Promise<StepResult> => {
      tries.push(timeoutMs);
      clock += 40;
      const stdout = answers.shift() ?? "true";
      return {
        code: stdout ? 0 : 1,
        stdout,
        stderr: stdout ? "" : "Can't get process",
        ms: 40,
      };
    };
    const ok = await pollUntilTrue(attempt, { timeoutMs: 20_000, now, sleep });
    expect(ok).toMatchObject({ ok: true, attempts: 3 });
    // A failed try is "not yet": the poll waits the interval and asks again.
    expect(slept).toEqual([POLL.intervalMs, POLL.intervalMs]);
    expect(tries).toEqual([POLL.attemptMs, POLL.attemptMs, POLL.attemptMs]);
    expect(pollStepResult(ok)).toEqual({
      code: 0,
      stdout: "true",
      stderr: "",
      ms: ok.ms,
    });
    // Never true: the poll ends when it said it would, and no try is
    // started with less than POLL.minTryMs left. The first rehearsal
    // (2026-09-19) gave its last try the 4 ms that remained; the kill read
    // as `exit 124` and the detail blamed a hang for a window that never came.
    clock = 0;
    slept.length = 0;
    tries.length = 0;
    const never = await pollUntilTrue(
      async (timeoutMs) => {
        tries.push(timeoutMs);
        clock += 100;
        return {
          code: 1,
          stdout: "",
          stderr:
            'execution error: System Events got an error: Can’t get process "TextEdit". (-1728)',
          ms: 100,
        };
      },
      { timeoutMs: 1000, intervalMs: 300, now, sleep },
    );
    expect(never.ok).toBe(false);
    expect(never.attempts).toBe(2);
    expect(never.ms).toBe(800);
    expect(tries).toEqual([1000, 600]);
    expect(Math.min(...tries)).toBeGreaterThanOrEqual(POLL.minTryMs);
    expect(never.hung).toBe(0);
    const failed = pollStepResult(never);
    expect(failed.code).toBe(124);
    expect(failed.stderr).toMatch(
      /^poll 2x\/800 ms: execution error: System Events got an error/,
    );
    // A try that hangs is killed at POLL.attemptMs (2 s), never given the
    // whole budget, and the detail reports the last try that answered plus
    // the count of hung tries; when every try hung it says so.
    clock = 0;
    tries.length = 0;
    const script: (124 | "false")[] = [124, 124, "false"];
    const mixed = await pollUntilTrue(
      async (timeoutMs) => {
        tries.push(timeoutMs);
        const next = script.shift() ?? "false";
        if (next === 124) {
          clock += timeoutMs;
          return { code: 124, stdout: "", stderr: "", ms: timeoutMs };
        }
        clock += 100;
        return { code: 0, stdout: next, stderr: "", ms: 100 };
      },
      { timeoutMs: 5000, now, sleep },
    );
    expect(tries).toEqual([POLL.attemptMs, POLL.attemptMs, 500]);
    expect(mixed).toMatchObject({ ok: false, attempts: 3, hung: 2 });
    expect(pollStepResult(mixed).stderr).toBe(
      `poll 3x/${mixed.ms} ms: false (2 tries hung)`,
    );
    clock = 0;
    tries.length = 0;
    const allHung = await pollUntilTrue(
      async (timeoutMs) => {
        tries.push(timeoutMs);
        clock += timeoutMs;
        return { code: 124, stdout: "", stderr: "", ms: timeoutMs };
      },
      { timeoutMs: 7000, now, sleep },
    );
    expect(tries).toEqual([POLL.attemptMs, POLL.attemptMs, POLL.attemptMs]);
    expect(allHung).toMatchObject({ attempts: 3, hung: 3, ms: 6750 });
    expect(pollStepResult(allHung).stderr).toBe(
      "poll 3x/6750 ms: every try hung at 2000 ms",
    );
    expect(
      pollStepResult({
        ok: false,
        attempts: 0,
        ms: 0,
        last: null,
        lastAnswer: null,
        hung: 0,
        tryMs: POLL.attemptMs,
      }).stderr,
    ).toMatch(/never tried/);
  });

  it("derives the automation consent probe from the apps a setup or check scripts, and skips their tasks when it is denied or unknown", () => {
    expect(Object.keys(AUTOMATION_PROBES)).toEqual([
      "Notes",
      "TextEdit",
      "Safari",
    ]);
    expect(taskProbes(task("dictate-textedit-sentence"))).toEqual([
      "textedit-automation",
    ]);
    expect(taskProbes(task("browse-goto-example"))).toEqual([
      "safari-automation",
    ]);
    expect(taskProbes(task("multi-safari-then-textedit")).sort()).toEqual([
      "safari-automation",
      "textedit-automation",
    ]);
    expect(taskProbes(task("dictate-notes-line"))).toEqual([
      "notes-automation",
    ]);
    // A cleanup that quits an app is not a need: the quit is logged, never a skip.
    expect(taskProbes(task("app-open-notes"))).toEqual([]);
    // Calculator is never scripted, so its tasks need no consent at all.
    expect(taskProbes(task("app-quit-calculator"))).toEqual([]);
    expect(taskProbes(task("ask-time"))).toEqual([]);
    const denied = taskSkips(suite.tasks, {
      "textedit-automation": false,
      "safari-automation": null,
    });
    expect(denied["dictate-textedit-sentence"]).toBe("TEXTEDIT_AUTOMATION");
    expect(denied["app-new-window-textedit"]).toBe("TEXTEDIT_AUTOMATION");
    expect(denied["browse-goto-example"]).toBe("SAFARI_AUTOMATION_UNKNOWN");
    expect(denied["app-quit-calculator"]).toBeUndefined();
    expect(denied["ask-time"]).toBeUndefined();
    for (const code of [
      "TEXTEDIT_AUTOMATION",
      "TEXTEDIT_AUTOMATION_UNKNOWN",
      "SAFARI_AUTOMATION",
      "SAFARI_AUTOMATION_UNKNOWN",
    ])
      expect(SKIP_REMEDY[code], code).toMatch(/consent|allow the terminal/);
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
    // The run still opened Notes: heard as other words, yet done, so the
    // turn passes with the soft tag; the same words with a failed outcome
    // (an answer where a run was expected) are MISHEARD.
    expect(
      classify(
        grade(
          t,
          [fastStart({ transcript: "create a note call voice trial" })],
          { frontmost: evidence("com.apple.Notes") },
        ),
      ),
    ).toMatchObject({ softCode: "MISHEARD_DONE", pass: true });
    expect(
      classify(
        grade(t, [answer({ transcript: "create a note call voice trial" })]),
      ),
    ).toMatchObject({ code: "MISHEARD", pass: false });
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
    // The same answer to the wrong words: heard as other words, yet the
    // right kind of thing was done, so it passes with the soft tag.
    expect(classify(grade(agenda, [answer()]))).toMatchObject({
      softCode: "MISHEARD_DONE",
      pass: true,
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
    // The app writes RunState only on a change (diagnostics.ts dedups by
    // status), so the resume slice never re-emits `paused`: the status is
    // carried from the pause utterance.
    const resume = sorted([
      voice(13_000, "wake_detected"),
      ev(14_500, "Command", { text: `${MARK} continue` }),
      ev(14_510, "TurnPlanned", { plan: "resume" }),
      ev(14_900, "RunState", { runId: RUN, status: "acting" }),
    ]);
    const turns = turnsOf(task("steer-wait-continue"));
    const paused = summarizeTurn(pause, spokenAt);
    expect(paused.pausedMs).toBe(9800);
    expect(paused.lastStatus).toBe("paused");
    expect(outcomeMatches(turns[1].expect, paused).ok).toBe(true);
    // Read alone the resume is invisible; seeded with the pause it counts.
    expect(summarizeTurn(resume, spokenAt).resumedMs).toBeNull();
    const resumed = summarizeTurn(resume, spokenAt, spokenAt, "paused");
    expect(resumed.resumedMs).toBe(14_900);
    expect(resumed.lastStatus).toBe("acting");
    expect(outcomeMatches(turns[2].expect, resumed).ok).toBe(true);
    const chained = summarizeUtterances([
      { events: pause, spokenAt },
      { events: resume, spokenAt },
    ]);
    expect(chained[1].resumedMs).toBe(14_900);
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
    const g = grade(
      task("steer-wait-continue"),
      [first, pause, ended],
      {},
      { stoppedByLoop: true },
    );
    expect(g.planMatched).toBe(true);
    expect(classify(g).pass).toBe(true);
  });

  it("ends the last turn of a run meant to keep going once its steering outcome has settled", () => {
    // steer-wait-continue: the run scrolls on after the resume, so a
    // terminal never comes; without this exit the turn ran to its timeout
    // and was classed RUN_INCOMPLETE though pause and resume both passed.
    const turns = turnsOf(task("steer-wait-continue"));
    const resume = sorted([
      voice(2500, "wake_detected"),
      ev(4000, "Command", { text: `${MARK} continue` }),
      ev(4010, "TurnPlanned", { plan: "resume" }),
      ev(4400, "RunState", { runId: RUN, status: "acting" }),
      ev(5000, "ActionExecuted", { runId: RUN, actionType: "scroll" }),
    ]);
    const s = summarizeTurn(resume, spokenAt, sayEndedAt, "paused");
    const facts = {
      anyRun: true,
      quietMs: 250,
      pastUnheardDeadline: false,
      stopRunAfter: true,
    };
    expect(lastTurnDone(turns[2], s, { ...facts, elapsedMs: 5000 })).toBe(
      false,
    );
    expect(lastTurnDone(turns[2], s, { ...facts, elapsedMs: 6500 })).toBe(true);
    // A run meant to finish waits for its terminal.
    expect(
      lastTurnDone(turns[2], s, {
        ...facts,
        stopRunAfter: false,
        elapsedMs: 30_000,
      }),
    ).toBe(false);
    // The other exits: a terminal run, a settled answer, nothing heard.
    const done = summarizeTurn(fastStart(), spokenAt, sayEndedAt);
    expect(
      lastTurnDone(turnsOf(task("app-open-notes"))[0], done, {
        anyRun: true,
        quietMs: 0,
        elapsedMs: 9500,
        pastUnheardDeadline: false,
      }),
    ).toBe(true);
    const answered = summarizeTurn(answer(), spokenAt, sayEndedAt);
    const askTime = turnsOf(task("ask-time"))[0];
    expect(
      lastTurnDone(askTime, answered, {
        anyRun: false,
        quietMs: 5000,
        elapsedMs: 14_000,
        pastUnheardDeadline: false,
      }),
    ).toBe(false);
    expect(
      lastTurnDone(askTime, answered, {
        anyRun: false,
        quietMs: 6500,
        elapsedMs: 15_000,
        pastUnheardDeadline: false,
      }),
    ).toBe(true);
    const silent = summarizeTurn(sorted(chatter()), spokenAt, sayEndedAt);
    expect(
      lastTurnDone(askTime, silent, {
        anyRun: false,
        quietMs: 20_000,
        elapsedMs: 20_000,
        pastUnheardDeadline: false,
      }),
    ).toBe(false);
    expect(
      lastTurnDone(askTime, silent, {
        anyRun: false,
        quietMs: 23_000,
        elapsedMs: 23_000,
        pastUnheardDeadline: true,
      }),
    ).toBe(true);
  });

  it("names a barge-in the loop started after the reply had ended as the harness's, not the dialog's", () => {
    const t = task("steer-stop-while-speaking");
    const question = sorted([
      ...heardPrompt("what are the planets in order from the sun", "reply", {
        code: "answer",
        act: "answer",
        plan: "reply",
      }),
      ev(6300, "SpeechOut", {
        phase: "requested",
        engine: "kokoro",
        priority: "answer",
        textLength: 80,
      }),
    ]);
    // The stop utterance's slice: speech ended, uninterrupted, before the wake landed.
    const late = sorted([
      voice(500, "speech_started", { utteranceId: "u1" }),
      voice(2100, "speech_finished", { utteranceId: "u1", interrupted: false }),
      voice(2500, "wake_detected"),
      voice(4000, "transcript_final", { textLength: 4 }),
      ev(4010, "Command", { text: `${MARK} stop` }),
      ev(4020, "TurnPlanned", { plan: "stop" }),
    ]);
    expect(classify(grade(t, [question, late]))).toMatchObject({
      code: "ENV_NOT_READY",
      subcode: "SPEECH_ENDED_BEFORE_WAKE",
    });
    // The wake over the speech, and the speech cut within 1.5 s: a pass.
    const cut = sorted([
      voice(500, "speech_started", { utteranceId: "u1" }),
      voice(2500, "wake_detected"),
      voice(3200, "speech_finished", { utteranceId: "u1", interrupted: true }),
      voice(4000, "transcript_final", { textLength: 4 }),
      ev(4010, "Command", { text: `${MARK} stop` }),
      ev(4020, "TurnPlanned", { plan: "stop" }),
    ]);
    expect(classify(grade(t, [question, cut])).pass).toBe(true);
    // Speech that played on past the wake is the dialog's failure.
    const ignored = sorted([
      voice(500, "speech_started", { utteranceId: "u1" }),
      voice(2500, "wake_detected"),
      voice(6000, "speech_finished", { utteranceId: "u1", interrupted: false }),
      voice(4000, "transcript_final", { textLength: 4 }),
      ev(4010, "Command", { text: `${MARK} stop` }),
      ev(4020, "TurnPlanned", { plan: "stop" }),
    ]);
    expect(classify(grade(t, [question, ignored]))).toMatchObject({
      code: "WRONG_PLAN",
      subcode: "NOT_INTERRUPTED",
    });
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
    // Input just before the prompt (the gate's business) is not this turn's.
    expect(
      hidTakeover({ now: T0 + 4000, hidIdleSeconds: 5, promptStartedAt: T0 }),
    ).toBe(false);
  });

  it("does not read the app's own typing followed by seconds of thinking as a person", () => {
    // dictate-textedit-sentence: type_text at prompt+12 s resets HIDIdleTime;
    // the next poll at +15.5 s reads idle 3.5 s while the model thinks. The
    // old rule (idle < time since prompt, no action in 3 s) aborted the cycle.
    expect(
      hidTakeover({
        now: T0 + 15_500,
        hidIdleSeconds: 3.5,
        promptStartedAt: T0,
        lastActionAt: T0 + 12_000,
      }),
    ).toBe(false);
    // 4-10 s of thinking after the action: still the app's own reset.
    for (const gap of [4000, 6000, 8000, 10_000])
      expect(
        hidTakeover({
          now: T0 + 12_000 + gap,
          hidIdleSeconds: gap / 1000,
          promptStartedAt: T0,
          lastActionAt: T0 + 12_000,
        }),
        `gap ${gap}`,
      ).toBe(false);
    // A person 8 s after the app's last action, though: idle 1 s cannot be the app's.
    expect(
      hidTakeover({
        now: T0 + 20_000,
        hidIdleSeconds: 1,
        promptStartedAt: T0,
        lastActionAt: T0 + 12_000,
      }),
    ).toBe(true);
  });

  it("confirms a HID reset only when the app's ActionExecuted has not explained it a few seconds later", () => {
    // The helper posts the click at +10.0 s; ActionExecuted lands in the log
    // at +11.5 s after the settle sampling. A poll in between sees a reset
    // nothing explains yet.
    const tracker = new HidTakeoverTracker();
    const prompt = T0;
    expect(
      tracker.observe({
        now: prompt + 10_200,
        hidIdleSeconds: 0.2,
        promptStartedAt: prompt,
        lastActionAt: prompt + 5000,
      }),
    ).toBe(false);
    expect(tracker.suspectAt).toBe(prompt + 10_200);
    // Next second: the ActionExecuted has landed and explains the reset.
    expect(
      tracker.observe({
        now: prompt + 11_600,
        hidIdleSeconds: 1.6,
        promptStartedAt: prompt,
        lastActionAt: prompt + 11_500,
      }),
    ).toBe(false);
    expect(tracker.suspectAt).toBeUndefined();
    // A person: the reset stays unexplained and is confirmed after HID_CONFIRM_MS.
    const person = new HidTakeoverTracker();
    const touch = prompt + 20_000;
    for (let at = touch + 200; at < touch + HID_CONFIRM_MS; at += 1000)
      expect(
        person.observe({
          now: at,
          hidIdleSeconds: (at - touch) / 1000,
          promptStartedAt: prompt,
          lastActionAt: prompt + 5000,
        }),
        `at +${at - touch}`,
      ).toBe(false);
    expect(
      person.observe({
        now: touch + 200 + HID_CONFIRM_MS,
        hidIdleSeconds: (200 + HID_CONFIRM_MS) / 1000,
        promptStartedAt: prompt,
        lastActionAt: prompt + 5000,
      }),
    ).toBe(true);
    // While a run is open the app may be typing: the log explains it only
    // when the step returns, so the confirmation waits HID_CONFIRM_RUN_MS.
    const typing = new HidTakeoverTracker();
    let confirmed = false;
    for (
      let at = touch + 200;
      at <= touch + HID_CONFIRM_RUN_MS - 1000;
      at += 1000
    )
      confirmed ||= typing.observe({
        now: at,
        hidIdleSeconds: 0.1,
        promptStartedAt: prompt,
        lastActionAt: prompt + 5000,
        runOpen: true,
      });
    expect(confirmed).toBe(false);
    // The type_text lands: cleared.
    expect(
      typing.observe({
        now: touch + HID_CONFIRM_RUN_MS,
        hidIdleSeconds: 0.5,
        promptStartedAt: prompt,
        lastActionAt: touch + HID_CONFIRM_RUN_MS - 400,
        runOpen: true,
      }),
    ).toBe(false);
    expect(typing.suspectAt).toBeUndefined();
  });

  it("counts a takeover only since the current prompt, never one from the session's history", () => {
    // The loop feeds the log tail since the app's start; the owner nudged the
    // mouse during a typed run an hour earlier (trial log: 8 manual_input and
    // 17 NativeUserTakeover rows in 6 h). A latch aborted the first turn.
    const watch = new AppWatch();
    const promptAt = T0 + 3_600_000;
    watch.feed([
      ev(0, "NativeUserTakeover", {}),
      ev(1000, "UserTakeoverStarted", {
        runId: RUN,
        data: { source: "manual_input" },
      }),
      ev(2000, "RunState", { runId: RUN, status: "cancelled" }),
    ]);
    expect(watch.takeoverAt).toBe(T0 + 1000);
    expect(watch.takeoverSince(promptAt)).toBe(false);
    // A hand-off is the app asking, not a person taking over.
    watch.feed([
      ev(3_605_000, "UserTakeoverStarted", {
        runId: RUN,
        data: { source: "request_user" },
      }),
    ]);
    expect(watch.takeoverSince(promptAt)).toBe(false);
    watch.feed([ev(3_610_000, "NativeUserTakeover", {})]);
    expect(watch.takeoverSince(promptAt)).toBe(true);
    // The next prompt starts clean without any reset.
    expect(watch.takeoverSince(T0 + 3_700_000)).toBe(false);
  });

  it("speaks a follow-up only into a window the app is not about to close for its own ack (trial 05:43 #2)", () => {
    // The trial's timeline, in ms after the transcript: followup_open 17461,
    // followup_closed{speaking} 17794, speech_started 17830, speech_finished
    // 19125, followup_open 20044. The old trigger fired on the first open and
    // spoke "and make it bold" into a closed microphone.
    const base = 17_000;
    const watch = new AppWatch();
    watch.feed([
      voice(0, "transcript_final", { textLength: 30 }),
      ev(10, "TurnPlanned", { plan: "start" }),
      ev(50, "RunStarted", { runId: RUN }),
      ev(base, "SpeechOut", { phase: "requested", priority: "ack" }),
      voice(base + 461, "followup_open", { kind: "continuation" }),
    ]);
    // Open, but a reply is pending: not yet.
    expect(watch.followupOpen).toBe(true);
    expect(watch.followupReady("continuation", T0 + base + 500)).toBe(false);
    expect(followupReady(watch.followupFacts(T0 + base + 500))).toBe(false);
    watch.feed([
      voice(base + 794, "followup_closed", {
        kind: "continuation",
        endReason: "speaking",
      }),
      voice(base + 830, "speech_started", { utteranceId: "u1" }),
    ]);
    expect(watch.followupReady("continuation", T0 + base + 900)).toBe(false);
    watch.feed([
      voice(base + 2125, "speech_finished", {
        utteranceId: "u1",
        interrupted: false,
      }),
    ]);
    // Not speaking, but no window either.
    expect(watch.followupReady("continuation", T0 + base + 2200)).toBe(false);
    watch.feed([voice(base + 3044, "followup_open", { kind: "continuation" })]);
    expect(watch.followupReady("continuation", T0 + base + 3100)).toBe(true);
    // The wrong kind of window is not the trigger's.
    expect(watch.followupReady("answer", T0 + base + 3100)).toBe(false);
    expect(watch.followupReady(undefined, T0 + base + 3100)).toBe(true);
    // A request that never played (empty text) stops blocking after 5 s.
    expect(
      followupReady({
        now: T0 + 10_000,
        followupOpen: true,
        speaking: false,
        speechRequestedAt: T0 + 1000,
      }),
    ).toBe(true);
    expect(
      followupReady({
        now: T0 + 3000,
        followupOpen: true,
        speaking: false,
        speechRequestedAt: T0 + 1000,
      }),
    ).toBe(false);
  });

  it("reads the preflight's open runs from the running app's session only", () => {
    const lines = [
      JSON.stringify(ev(0, "RunStarted", { runId: "old" })),
      JSON.stringify(ev(1000, "RunState", { runId: "old", status: "acting" })),
      "not json at all",
      JSON.stringify(ev(60_000, "Heartbeat")),
      JSON.stringify(ev(61_000, "VoiceEvent", { phase: "wake_status" })),
    ].join("\n");
    const since = linesSince(lines, T0 + 30_000);
    expect(since).toBeDefined();
    expect(since).not.toContain('"old"');
    expect(since!.split("\n")).toHaveLength(2);
    expect(linesSince(lines, T0)).toBe(lines);
    expect(linesSince(lines, T0 + 120_000)).toBeUndefined();
    expect(linesSince("", T0)).toBeUndefined();
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
    // Without a real speech sample the threshold is the floor's own multiple,
    // never the floor: the standby engine stops emitting levels at
    // wake_detected, so the say window usually holds only a pre-speech room
    // sample (trial: floor 2, "speech" 2, threshold 2, then NOISE on rms 3-5).
    expect(quietThreshold(2)).toBe(6);
    expect(quietThreshold(2, 2)).toBe(6);
    expect(quietThreshold(2, 3)).toBe(6);
    expect(quietThreshold(10, 5)).toBe(30);
    expect(quietThreshold(2, 28)).toBeCloseTo(11.1);
    expect(isSpeechSample(2, 4)).toBe(false);
    expect(isSpeechSample(2, 28)).toBe(true);
    expect(isSpeechSample(4, 8)).toBe(false);
    expect(isSpeechSample(4, 9)).toBe(true);
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

describe("voice gate: the wait's account", () => {
  it("accounts every refused poll to its reason, counts only refused time toward the cap, and names the dominant reason (cycle 3: ten minutes on a person at the Mac)", () => {
    // Cycle 3 (2026-09-19 09:07): app-open-notes passed, the follow-up
    // window stayed open 45 s, then a person used the Mac until the cap,
    // and the report said "gate waited 1 time(s), 0 s in all".
    const wait = new GateWait(T0);
    let now = T0;
    for (let i = 0; i < 45; i++) wait.refuse("FOLLOWUP_OPEN", (now += 1000));
    expect(wait.verdict(now)).toBeUndefined();
    while (wait.refusedMs < GATE_CAP_MS) {
      wait.refuse("HID_ACTIVE", (now += 1000));
      if (now - T0 < GATE_CAP_MS) expect(wait.verdict(now)).toBeUndefined();
    }
    expect(wait.verdict(now)).toBe("GATE_CAP");
    const s = wait.summary();
    expect(s.polls).toBe(600);
    expect(s.refusedMs).toBe(GATE_CAP_MS);
    expect(s.byReasonMs).toEqual({
      FOLLOWUP_OPEN: 45_000,
      HID_ACTIVE: 555_000,
    });
    expect(s.byReasonPolls).toEqual({ FOLLOWUP_OPEN: 45, HID_ACTIVE: 555 });
    expect(s.on).toBe("HID_ACTIVE");
    expect(s.streak).toEqual({ reason: "HID_ACTIVE", sinceMs: T0 + 46_000 });
    // Time before the first poll (reading the facts) is the first reason's;
    // a poll that comes back at the same instant costs nothing.
    const quick = new GateWait(T0);
    quick.refuse("BUSY", T0 + 300);
    quick.refuse("BUSY", T0 + 300);
    expect(quick.summary()).toMatchObject({
      polls: 2,
      refusedMs: 300,
      byReasonMs: { BUSY: 300 },
    });
    expect(new GateWait(T0).summary()).toMatchObject({
      polls: 0,
      refusedMs: 0,
      on: null,
      streak: null,
    });
    expect(GATE_REASON_MEANS.HID_ACTIVE).toMatch(/person's input/);
  });

  it("names the app's own fault when one reason holds two minutes without a break, and the cap otherwise", () => {
    const held = (reason: VoiceGateReason, seconds: number) => {
      const wait = new GateWait(T0);
      let now = T0;
      for (let i = 0; i < seconds; i++) wait.refuse(reason, (now += 1000));
      return { wait, now };
    };
    for (const [reason, stop] of [
      ["RUN_OPEN", "RUN_LEFT_OPEN"],
      ["FOLLOWUP_OPEN", "WINDOW_STUCK"],
      ["NOT_LISTENING", "NOT_LISTENING"],
    ] as [VoiceGateReason, string][]) {
      const short = held(reason, 119);
      expect(short.wait.verdict(short.now), reason).toBeUndefined();
      const long = held(reason, 121);
      expect(long.wait.verdict(long.now), reason).toBe(stop);
    }
    expect(STUCK_STOP).toEqual({
      RUN_OPEN: "RUN_LEFT_OPEN",
      FOLLOWUP_OPEN: "WINDOW_STUCK",
      NOT_LISTENING: "NOT_LISTENING",
    });
    // The room's reasons never read as the app stuck: they run to the cap.
    for (const reason of [
      "HID_ACTIVE",
      "NOISE",
      "BUSY",
      "SPEAKING",
      "VOLUME",
    ] as VoiceGateReason[]) {
      const long = held(reason, 300);
      expect(long.wait.verdict(long.now), reason).toBeUndefined();
      expect(long.wait.verdict(long.now, { capMs: 300_000 }), reason).toBe(
        "GATE_CAP",
      );
    }
    // A break restarts the streak: a window that closed for one poll and
    // reopened is not stuck yet, however long the two halves add up to.
    const broken = new GateWait(T0);
    let now = T0;
    for (let i = 0; i < 100; i++) broken.refuse("FOLLOWUP_OPEN", (now += 1000));
    broken.refuse("BUSY", (now += 1000));
    for (let i = 0; i < 100; i++) broken.refuse("FOLLOWUP_OPEN", (now += 1000));
    expect(broken.verdict(now)).toBeUndefined();
    expect(broken.summary().streak).toEqual({
      reason: "FOLLOWUP_OPEN",
      sinceMs: T0 + 102_000,
    });
    // The stuck bound is checked before the cap, and both are injectable.
    const both = held("RUN_OPEN", 121);
    expect(both.wait.verdict(both.now, { capMs: 60_000 })).toBe(
      "RUN_LEFT_OPEN",
    );
    expect(both.wait.verdict(both.now, { stuckMs: 200_000 })).toBeUndefined();
    expect(GATE_STUCK_MS).toBe(120_000);
    expect(GATE_CAP_MS).toBe(600_000);
  });

  it("keeps the timestamps the stuck evidence needs: when the window opened and how often, each run's last change, the last wake_status", () => {
    const w = new AppWatch();
    w.feed(
      sorted([
        voice(1000, "wake_status", { listening: true }),
        ev(2000, "RunStarted", { runId: RUN }),
        ev(2500, "RunState", { runId: RUN, status: "capturing" }),
        voice(3000, "followup_open", { kind: "continuation" }),
      ]),
    );
    expect(w.listeningAt).toBe(T0 + 1000);
    expect(w.followupOpenedAt).toBe(T0 + 3000);
    expect(w.followupOpens).toBe(1);
    expect(w.openRuns(T0 + 10_000)).toEqual([
      { status: "capturing", silentMs: 7500 },
    ]);
    // A conversation window that closes and reopens counts its opens; the
    // opened-at is the latest open's.
    w.feed(
      sorted([
        voice(4000, "followup_closed", { kind: "continuation" }),
        voice(4100, "followup_open", { kind: "continuation" }),
        ev(5000, "RunState", { runId: RUN, status: "completed" }),
      ]),
    );
    expect(w.followupOpen).toBe(true);
    expect(w.followupOpenedAt).toBe(T0 + 4100);
    expect(w.followupOpens).toBe(2);
    expect(w.openRuns(T0 + 10_000)).toEqual([]);
    w.feed([voice(6000, "followup_closed", { kind: "continuation" })]);
    expect(w.followupOpenedAt).toBeUndefined();
  });
});

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

  it("passes a turn heard as other words when the outcome and checks passed, with the soft MISHEARD_DONE, and keeps MISHEARD when the outcome failed", () => {
    // Cycle 2 (2026-09-19 01:11): "open a new text window" and "quick
    // calculator" were transcribed, each run completed in one action and
    // every check was true, yet both turns were graded MISHEARD.
    const newWindow = task("app-new-window-textedit");
    const said = "open a new text window";
    const ok = {
      frontmost: evidence("com.apple.TextEdit"),
      windowGrew: evidence("true"),
    };
    const done = grade(newWindow, [fastStart({ transcript: said })], ok);
    expect(done.heard).toBe("misheard");
    expect(done.checksFailed).toEqual([]);
    expect(classify(done)).toMatchObject({
      softCode: "MISHEARD_DONE",
      pass: true,
    });
    expect(
      classify(
        grade(
          task("app-quit-calculator"),
          [fastStart({ transcript: "quick calculator" })],
          { calculatorGone: evidence("true") },
        ),
      ),
    ).toMatchObject({ softCode: "MISHEARD_DONE", pass: true });
    // The same words with the primary check false, or with no run at all:
    // the outcome failed, so MISHEARD stays the class and the turn fails.
    expect(
      classify(
        grade(newWindow, [fastStart({ transcript: said })], {
          ...ok,
          windowGrew: evidence("false"),
        }),
      ),
    ).toMatchObject({ code: "MISHEARD", pass: false });
    expect(
      classify(grade(newWindow, [answer({ transcript: said })])),
    ).toMatchObject({ code: "MISHEARD", pass: false });
    // A heard turn with the same outcome carries no tag at all.
    expect(
      classify(
        grade(
          newWindow,
          [fastStart({ transcript: "open a new textedit window" })],
          ok,
        ),
      ),
    ).toEqual({ pass: true });
    expect(SOFT_CODES).toContain("MISHEARD_DONE");
    expect(OWNER.MISHEARD_DONE).toBe("recognizer/gate");
    expect(COST_WEIGHT.MISHEARD_DONE).toBeLessThan(COST_WEIGHT.MISHEARD);
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
  byReasonSeconds: { HID_ACTIVE: 20, BUSY: 10 },
  longestSeconds: 20,
  gaveUp: null,
};

function record(
  t: VoiceTask,
  events: DiagnosticEvent[][],
  ev: Record<string, { value?: string; exitCode: number; ms: number }> = {},
  context = {},
  attempt = 1,
): TurnRecord {
  const summaries = summarizeUtterances(
    events.map((slice) => ({ events: slice, spokenAt, sayEndedAt })),
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
    // A soft class counts its passed turns over budget: they are its lane,
    // and the pass rate never moves for them.
    const soft = results.failureClasses.find(
      (c) => c.code === "SLOW_FIRST_ACTION",
    )!;
    expect(soft.attempts).toBe(1);
    expect(soft.passedAttempts).toBe(1);
    expect(soft.attemptRate).toBeCloseTo(1 / 7);
    expect(soft.byCategory.app.attempts).toBe(1);
    expect(results.aggregate.passed).toBe(3);
    expect(fixBrief(soft, results)).toMatch(/1 of 7 ran turn\(s\)/);
    expect(renderReport(results)).toMatch(
      /\*\*SLOW_FIRST_ACTION\*\* \*\(soft\)\* — runner\/policy; 1 passed turn\(s\) over budget/,
    );
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

  it("counts a turn heard as other words yet done as passed and hands-free, and lists MISHEARD_DONE as a soft class", () => {
    const results = cycleOf([
      record(
        task("app-new-window-textedit"),
        [fastStart({ transcript: "open a new text window" })],
        {
          frontmost: evidence("com.apple.TextEdit"),
          windowGrew: evidence("true"),
        },
      ),
    ]);
    expect(results.aggregate).toMatchObject({ ran: 1, passed: 1 });
    expect(results.aggregate.handsFree.rate).toBe(1);
    const cls = results.failureClasses.find((c) => c.code === "MISHEARD_DONE");
    expect(cls?.attempts).toBe(1);
    expect(cls?.contributors).toContain("soft");
    expect(renderReport(results)).toMatch(
      /\*\*MISHEARD_DONE\*\* \*\(soft\)\* — recognizer\/gate; 1 passed turn\(s\) heard as other words/,
    );
    expect(renderReport(results)).toMatch(
      /\| app-new-window-textedit#1 \| misheard \|.*\| pass \+MISHEARD_DONE \|/,
    );
  });

  it("says which turn the gate gave up on, how long it waited on what, and what the app was stuck on", () => {
    const gaveUp = {
      turnId: "app-switch-safari#1",
      code: "GATE_CAP",
      waitedSeconds: 600,
      on: "HID_ACTIVE",
      byReasonSeconds: { FOLLOWUP_OPEN: 45, HID_ACTIVE: 555 },
      evidence: null,
    };
    const results = buildResults({
      plan,
      turns: [record(task("app-open-notes"), [fastStart()], front)],
      preflight,
      gate: {
        count: 1,
        totalSeconds: 600,
        byReason: { FOLLOWUP_OPEN: 45, HID_ACTIVE: 555 },
        byReasonSeconds: { FOLLOWUP_OPEN: 45, HID_ACTIVE: 555 },
        longestSeconds: 600,
        gaveUp,
      },
      previous: null,
      finishedAt: at(700_000),
      stoppedBecause: "GATE_CAP",
    });
    expect(results.gate.gaveUp).toEqual(gaveUp);
    const report = renderReport(results);
    expect(report).toContain(
      "Stopped early: GATE_CAP (app-switch-safari#1 waited 600 s: HID_ACTIVE 555 s, FOLLOWUP_OPEN 45 s).",
    );
    expect(report).toContain(
      "Gave up at app-switch-safari#1 with GATE_CAP after 600 s: HID_ACTIVE 555 s, FOLLOWUP_OPEN 45 s; a person's input on the Mac",
    );
    expect(report).toMatch(
      /By reason: .*poll\(s\); HID_ACTIVE 555 s, FOLLOWUP_OPEN 45 s\./,
    );
    // The app's own fault carries its evidence: statuses, kinds and milliseconds.
    const stuck = buildResults({
      plan,
      turns: [],
      preflight,
      gate: {
        count: 1,
        totalSeconds: 121,
        byReason: { FOLLOWUP_OPEN: 121 },
        byReasonSeconds: { FOLLOWUP_OPEN: 121 },
        longestSeconds: 121,
        gaveUp: {
          turnId: "ask-time#1",
          code: "WINDOW_STUCK",
          waitedSeconds: 121,
          on: "FOLLOWUP_OPEN",
          byReasonSeconds: { FOLLOWUP_OPEN: 121 },
          evidence: { kind: "continuation", openMs: 125_000, opens: 0 },
        },
      },
      previous: null,
      finishedAt: at(200_000),
      aborted: { code: "WINDOW_STUCK", turnId: "ask-time#1", at: at(121_000) },
      stoppedBecause: "WINDOW_STUCK",
    });
    const stuckReport = renderReport(stuck);
    expect(stuckReport).toContain(
      'Gave up at ask-time#1 with WINDOW_STUCK after 121 s: FOLLOWUP_OPEN 121 s; the app\'s follow-up window was open; evidence {"kind":"continuation","openMs":125000,"opens":0}.',
    );
    expect(stuckReport).toContain("Aborted on WINDOW_STUCK at turn ask-time#1");
    // No wait gave up: the header and the gate line say nothing of it.
    expect(renderReport(cycleOf([]))).not.toMatch(/Gave up|waited \d+ s:/);
  });

  it("records why a setup failed, content-free, and the report says it under Environment", () => {
    const step: Script = {
      kind: "osascript",
      poll: true,
      timeoutMs: 20_000,
      script:
        'tell application "System Events" to return (exists (window 1 of process "Safari")) as string',
    };
    const home = "/Users/owner";
    const detail = setupFailureDetail(
      2,
      step,
      {
        code: 124,
        stdout: "",
        stderr: `poll 78x/20004 ms: ${home}/OpenAssistBench/voice-voiceloopab12 not open:\n   System Events got an error: Can’t get process "Safari" ${"x".repeat(100)}`,
        ms: 20_004,
      },
      home,
    );
    expect(detail).toMatchObject({
      step: 2,
      kind: "osascript",
      poll: true,
      exitCode: 124,
      ms: 20_004,
    });
    expect(detail.said.length).toBe(SETUP_SAID_CHARS);
    expect(detail.said).not.toContain("\n");
    expect(detail.said).toContain("~/OpenAssistBench");
    expect(detail.said).not.toContain(home);
    // stdout stands in when stderr is empty; a silent kill says nothing.
    expect(
      setupFailureDetail(
        0,
        { kind: "sh", script: "true" },
        {
          code: 1,
          stdout: "false",
          stderr: "",
          ms: 12,
        },
      ).said,
    ).toBe("false");
    expect(
      setupFailureDetail(
        0,
        { kind: "sh", script: "true" },
        {
          code: 124,
          stdout: "",
          stderr: "",
          ms: 10_001,
        },
      ).said,
    ).toBe("");
    const failed: TurnRecord = {
      ...record(
        task("browse-goto-example"),
        [],
        {},
        {
          envSubcode: "SETUP_FAILED",
        },
      ),
      setup: detail,
    };
    const ready = record(task("ask-time"), [answer()]);
    const results = cycleOf([failed, ready]);
    expect(results.results[0].setup).toEqual(detail);
    expect(results.results[1].setup).toBeNull();
    expect(results.aggregate.ran).toBe(1);
    const report = renderReport(results);
    expect(report).toContain(
      "- browse-goto-example#1: ENV_NOT_READY/SETUP_FAILED; setup step 2 (osascript poll) exited 124 after 20004 ms: poll 78x/20004 ms: ~/OpenAssistBench",
    );
    expect(report).not.toContain(home);
    // A ledger from before the detail (cycle 1) still renders.
    const legacy = record(
      task("ask-time"),
      [],
      {},
      { envSubcode: "SETUP_FAILED" },
    );
    expect(renderReport(cycleOf([legacy]))).toContain(
      "- ask-time#1: ENV_NOT_READY/SETUP_FAILED\n",
    );
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

  it(
    "refuses a numeric flag that is not a number instead of letting NaN pass every gate",
    { timeout: 90_000 },
    () => {
      const result = spawnSync(
        "node",
        [
          join(root, "scripts/voice-loop.mjs"),
          "--dry-run",
          "--idle-seconds",
          "45s",
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, NODE_OPTIONS: "" },
        },
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/--idle-seconds 45s is not a number/);
      expect(result.stdout).not.toMatch(/Dry run/);
    },
  );

  it(
    "re-renders a cycle from its ledger with --report-only, a gate that gave up included (the first run of that path crashed on a const read before its line)",
    { timeout: 90_000 },
    () => {
      const outDir = mkdtempSync(join(tmpdir(), "voice-report-only-"));
      const cycleId = "20260101-0000-abc1234";
      const dir = join(outDir, cycleId);
      mkdirSync(dir);
      writeFileSync(
        join(dir, "plan.json"),
        JSON.stringify({ plan: { ...plan, id: cycleId }, preflight }),
      );
      const rows = [
        {
          at: at(0),
          kind: "start",
          cycle: cycleId,
          tasks: ["app-open-notes"],
          repeat: 1,
        },
        {
          at: at(100),
          kind: "gate",
          turnId: "app-open-notes#1",
          waitedMs: 158,
          polls: 0,
          refusedMs: 0,
          reasons: {},
          byReasonMs: {},
        },
        {
          at: at(9000),
          kind: "turn",
          record: record(task("app-open-notes"), [fastStart()], front),
        },
        {
          at: at(609_000),
          kind: "gate",
          turnId: "app-switch-safari#1",
          waitedMs: 600_100,
          polls: 600,
          refusedMs: 600_000,
          reasons: { FOLLOWUP_OPEN: 45, HID_ACTIVE: 555 },
          byReasonMs: { FOLLOWUP_OPEN: 45_000, HID_ACTIVE: 555_000 },
          stop: "GATE_CAP",
          on: "HID_ACTIVE",
          evidence: null,
        },
        { at: at(609_100), kind: "stop", reason: "GATE_CAP" },
      ];
      writeFileSync(
        join(dir, "ledger.jsonl"),
        rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
      );
      const result = spawnSync(
        "node",
        [
          join(root, "scripts/voice-loop.mjs"),
          "--report-only",
          cycleId,
          "--out-dir",
          outDir,
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, NODE_OPTIONS: "" },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      const report = readFileSync(join(dir, "report.md"), "utf8");
      expect(report).toContain(
        "gate waited 1 time(s), 600 s in all. Stopped early: GATE_CAP (app-switch-safari#1 waited 600 s: HID_ACTIVE 555 s, FOLLOWUP_OPEN 45 s).",
      );
      expect(report).toContain(
        "Gave up at app-switch-safari#1 with GATE_CAP after 600 s: HID_ACTIVE 555 s, FOLLOWUP_OPEN 45 s; a person's input on the Mac",
      );
      const results = JSON.parse(
        readFileSync(join(dir, "results.json"), "utf8"),
      ) as VoiceResults;
      expect(results.gate.gaveUp?.code).toBe("GATE_CAP");
      expect(results.gate.byReasonSeconds).toEqual({
        FOLLOWUP_OPEN: 45,
        HID_ACTIVE: 555,
      });
      expect(results.aggregate.ran).toBe(1);
      expect(results.cycle.stoppedBecause).toBe("GATE_CAP");
      rmSync(outDir, { recursive: true, force: true });
      // The ledger is read by its own parser: parseLines wants a
      // diagnostics event's `event` and `timestamp` and dropped every row.
      expect(source).toMatch(
        /parseLedger\(readFileSync\(ledgerPath, "utf8"\)\)/,
      );
      expect(source).not.toMatch(/parseLines\(readFileSync\(ledgerPath/);
    },
  );

  it("declines a hand-off, writes the voice brief apart from the loop's, and stops in order when say fails", () => {
    // A hand-off (request_user) is declined with stop like a confirmation.
    expect(source).toMatch(
      /s\.confirmations > 0 \|\| s\.needClick \|\| s\.handoffSources\.length/,
    );
    // lanes/<CODE>.voice.md: never the same file as the fix loop's <code>.md on APFS.
    expect(source).toMatch(/\$\{cls\.code\}\.voice\.md/);
    expect(source).not.toMatch(/\$\{cls\.code\}\.md/);
    // say never rejects into an unhandled crash; a crash still writes results.
    expect(source).toMatch(/SAY_FAILED/);
    expect(source).toMatch(/stoppedBecause = "CRASHED"/);
    expect(source).not.toMatch(/reject\(new Error\(`say exited/);
    // A takeover is a timestamp since the prompt, never a latch from history.
    expect(source).toMatch(/watch\.takeoverSince\(promptStartedAt\)/);
    expect(source).not.toMatch(/watch\.takeover\b(?!Since|At)/);
    // The HID rule is the tracker, the follow-up rule and the last-turn rule are the grader's.
    expect(source).toMatch(/new HidTakeoverTracker\(\)/);
    expect(source).toMatch(/watch\.followupReady\(trigger\.kind\)/);
    expect(source).toMatch(/lastTurnDone\(turn, s, \{/);
    // Open runs are counted since the app's start, and the quiet threshold
    // starts from the floor alone.
    expect(source).toMatch(/linesSince\(tail\.text, appStart\)/);
    expect(source).toMatch(/quietThreshold\(facts\.quietFloor\)/);
    expect(source).toMatch(/isSpeechSample\(facts\.quietFloor, level\)/);
    // A shortcut probe that could not be read is passed through as unknown, not assumed present.
    expect(source).toMatch(/"focus-shortcut": facts\.focusShortcut,/);
    expect(source).not.toMatch(/focusShortcut === null \? true/);
  });

  it("waits for windows with the poll rule, records why a setup failed, probes consent for every scripted app, and rehearses setups without speaking", () => {
    // A poll step is the pure driver, bounded by the step's own timeout; a
    // step with no timeout gets the suite's default, never a literal.
    expect(source).toMatch(/pollStepResult\(\s*await pollUntilTrue\(exec, \{/);
    expect(source).toMatch(/step\.timeoutMs \?\? STEP\.defaultTimeoutMs/);
    expect(source).not.toMatch(/step\.timeoutMs \?\? 10_000/);
    // The failed step's detail goes into the turn record (the ledger), the
    // whole stderr only into the local turns.jsonl.
    expect(source).toMatch(
      /setupFailure = setupFailureDetail\(index, step, result, homedir\(\)\)/,
    );
    expect(source).toMatch(/setup: setupFailure,/);
    expect(source).toMatch(/setupStderr,/);
    // Consent is probed for every app the runnable tasks script, not Notes alone.
    expect(source).toMatch(/runnable\(\)\.flatMap\(taskProbes\)/);
    expect(source).toMatch(/Object\.entries\(AUTOMATION_PROBES\)/);
    expect(source).not.toMatch(/"notes-automation": probe\.code === 0/);
    // The terminal's own Accessibility is a preflight fact and a refusal.
    expect(source).toMatch(/TERMINAL_ACCESSIBILITY/);
    expect(source).toMatch(/assistive access/);
    // A gate wait is accounted by the pure GateWait, logged whether it
    // opened or gave up, the cap and the stuck bound decided there, and the
    // app's own fault aborts like a run left open after a turn.
    expect(source).toMatch(/const wait = new GateWait\(started\)/);
    expect(source).toMatch(/wait\.refuse\(decision\.reason, Date\.now\(\)\)/);
    expect(source).toMatch(
      /wait\.verdict\(Date\.now\(\), \{ capMs: GATE_CAP_MS \}\)/,
    );
    expect(source).not.toMatch(/const GATE_CAP_MS =/);
    expect(source).not.toMatch(/Date\.now\(\) - started > GATE_CAP_MS/);
    expect(source).toMatch(
      /ledger\(gateLedgerRow\(turnId, gate\)\);\n  if \(gate\.stop\) return gateOutcome\(gate, turnId\);/,
    );
    expect(source).toMatch(/\{ abort: gate\.stop, turnId \}/);
    expect(source).toMatch(/watch\.openRuns\(now\)/);
    // A rehearsal needs the consent flag, takes the lock, and speaks nothing.
    expect(source).toMatch(/rehearse: \{ type: "boolean"/);
    expect(source).toMatch(/REHEARSAL_CODES\.includes\(code\)/);
    const rehearsal = source.slice(
      source.indexOf("async function rehearse()"),
      source.indexOf("if (values.rehearse)"),
    );
    expect(rehearsal).not.toMatch(/speak\(|say/);
    expect(rehearsal).toMatch(/await cleanup\(task, fill\)/);
  });

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
    expect(docs).toMatch(/lanes\/<CLASS>\.voice\.md/);
    for (const code of [
      "SHORTCUT_UNKNOWN",
      "SAY_FAILED",
      "SPEECH_ENDED_BEFORE_WAKE",
      "followupReady",
      "summarizeUtterances",
      "lastTurnDone",
      "TERMINAL_ACCESSIBILITY",
      "TEXTEDIT_AUTOMATION",
      "SAFARI_AUTOMATION",
      "--rehearse",
      "setup talks to apps only after a window exists",
      "pkill -x Calculator",
      "GATE_CAP",
      "WINDOW_STUCK",
      "GateWait",
    ])
      expect(docs, code).toContain(code);
  });
});
