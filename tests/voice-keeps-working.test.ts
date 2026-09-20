import { readFileSync } from "node:fs";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  defaultSettings,
  type Action,
  type Controller,
  type JournalEvent,
  type Observation,
  type ProviderResult,
  type Recorder,
  type Run,
  type Settings,
  type Surface,
} from "../src/core/schema";
import { CORRECTION_NOTE, Runner } from "../src/core/runner";
import { arbitrate } from "../src/assistant/arbitrate";
import { voiceCommandConfidence } from "../src/voice/router";
import { PHRASES } from "../src/voice/phrases";
import type { TurnPlan, VoiceTurnRun } from "../src/voice/turns";

/**
 * Live 2026-09-19 19:41–19:45 (build 0fb99c8, autonomy "all" acknowledged,
 * conversation mode): every utterance during a run paused it (RunPaused on
 * followup_detected {kind: continuation}), the click in flight died
 * NativeStoppedError STOPPED, the aborted model call journaled after the
 * pause so the hold no longer read as this activation's, and a clear
 * 63-character request came back as "Should I stop it, or carry on?". These
 * tests pin the other behaviour: speech during a run holds nothing, a
 * correction applies live, a control word acts from the partial, a paused
 * run is replaced with a statement under "never ask", and every pause names
 * its reason.
 */

type Decision = { kind: string; reason: string };
const policy = vi.hoisted(() => ({
  evaluate: undefined as
    | undefined
    | ((a: Action, s: Surface, st: Settings, synthetic: boolean) => Decision),
}));
vi.mock("../src/core/policy", async (original) => {
  const actual = await original<typeof import("../src/core/policy")>();
  return {
    ...actual,
    evaluate: (a: Action, s: Surface, st: Settings, synthetic: boolean) =>
      policy.evaluate?.(a, s, st, synthetic) ??
      actual.evaluate(a, s, st, synthetic),
  };
});
afterEach(() => {
  policy.evaluate = undefined;
});
const allowAll = () => {
  policy.evaluate = () => ({ kind: "ALLOW", reason: "Test." });
};

const geometry = {
  display_id: 1,
  x: 0,
  y: 0,
  width: 1440,
  height: 900,
  native_width: 2880,
  native_height: 1800,
  model_width: 1280,
  model_height: 720,
  scale_factor: 2,
};
const surface: Surface = {
  appId: "com.example.app",
  pid: 42,
  secureInput: false,
  unknown: false,
};
const settings = structuredClone(defaultSettings);
const usage = { inputTokens: 0, outputTokens: 0, cost: 0 };
const tick = () => new Promise((r) => setTimeout(r, 5));
const until = async (condition: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error("Timed out waiting for condition.");
    await tick();
  }
};
function memory() {
  const events: JournalEvent[] = [];
  let run: Run;
  const recorder: Recorder = {
    begin: (r) => {
      run = r;
    },
    save: (r) => {
      run = r;
    },
    frame: () => {},
    append: (id, type, data = {}) => {
      const e: JournalEvent = {
        event_id: crypto.randomUUID(),
        run_id: id,
        type,
        data,
        sequence_number: events.length + 1,
        schema_version: 1,
        monotonic_timestamp: performance.now(),
        wall_clock_timestamp: new Date().toISOString(),
      };
      events.push(e);
      return e;
    },
  };
  const of = (type: string) => events.filter((e) => e.type === type);
  return { recorder, events, of };
}
let captures = 0;
function controller(overrides: Partial<Controller> = {}): Controller {
  return {
    kind: "native",
    surface: async () => surface,
    capture: async () => ({
      id: `frame-${++captures}`,
      sha256: "sha",
      image: "",
      geometry,
      capturedAt: 0,
      synthetic: false,
      appId: surface.appId,
    }),
    execute: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    stop: vi.fn(() => {}),
    ...overrides,
  };
}
/** A provider whose replies a test hands out one at a time. */
function gated() {
  const observations: Observation[] = [];
  const waiting: ((r: ProviderResult) => void)[] = [];
  const next = vi.fn(
    (o: Observation, signal: AbortSignal) =>
      new Promise<ProviderResult>((resolve, reject) => {
        observations.push(structuredClone(o));
        waiting.push(resolve);
        // A pause or stop aborts the call, as the real provider does.
        signal.addEventListener("abort", () => {
          waiting.splice(waiting.indexOf(resolve), 1);
          reject(new Error("Cancelled"));
        });
      }),
  );
  const reply = (partial: Record<string, unknown>) => {
    const o = observations[observations.length - 1];
    const resolve = waiting.shift()!;
    resolve({
      usage,
      action: { ...partial, frame_id: o.frame.id },
    } as ProviderResult);
  };
  return { next, observations, reply };
}
const click = { type: "click", x: 0.5, y: 0.5 };
const done = { type: "done", summary: "Done" };
const read = (path: string) => readFileSync(path, "utf8");
const between = (source: string, from: string, to: string) => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
};

describe("a correction to a run under way applies live", () => {
  it("while the model thinks: no pause, native input kept, the stale proposal let go, the next step reads the words", async () => {
    allowAll();
    const m = memory();
    const c = controller();
    const p = gated();
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    const running = runner.start("first task");
    await until(() => p.observations.length === 1);
    expect(runner.snapshot.run?.status).toBe("thinking");
    await runner.revise("second thought");
    // Nothing held, nothing stopped: the run is still thinking.
    expect(runner.snapshot.run?.status).toBe("thinking");
    expect(m.of("RunPaused")).toHaveLength(0);
    expect(c.stop).not.toHaveBeenCalled();
    expect(m.of("UserCorrectionRecorded")).toHaveLength(1);
    expect(m.of("UserCorrectionRecorded")[0].data).toMatchObject({
      after_action: 0,
    });
    // The proposal for the old words is let go: the click never runs.
    p.reply(click);
    await until(() => p.observations.length === 2);
    expect(c.execute).not.toHaveBeenCalled();
    expect(m.of("ActionInterrupted")).toHaveLength(0);
    // The next step carries the words on the task and the note in history,
    // with the words themselves only on the task.
    const second = p.observations[1];
    expect(second.task).toContain("first task");
    expect(second.task).toContain("second thought");
    expect(second.history).toContainEqual({
      type: "correction",
      result: CORRECTION_NOTE,
    });
    expect(CORRECTION_NOTE).not.toContain("second thought");
    p.reply(done);
    await running;
    expect(runner.snapshot.run?.status).toBe("completed");
    // The controller's stop is the run's own end, nothing before it.
    expect(c.stop).toHaveBeenCalledTimes(1);
  });

  it("while a step executes: the step finishes and is recorded, the next step reads the words", async () => {
    allowAll();
    const m = memory();
    let release: () => void = () => {};
    const c = controller({
      execute: vi.fn(() => new Promise<void>((resolve) => (release = resolve))),
    });
    const p = gated();
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    const running = runner.start("first task");
    await until(() => p.observations.length === 1);
    p.reply(click);
    await until(() => runner.snapshot.run?.status === "executing");
    await runner.revise("second thought");
    expect(runner.snapshot.run?.status).toBe("executing");
    expect(m.of("RunPaused")).toHaveLength(0);
    expect(c.stop).not.toHaveBeenCalled();
    release();
    await until(() => p.observations.length === 2);
    // Executed, not interrupted: the model knows the click landed.
    expect(m.of("ActionExecuted")).toHaveLength(1);
    expect(m.of("ActionInterrupted")).toHaveLength(0);
    expect(runner.snapshot.run?.actions).toBe(1);
    expect(p.observations[1].task).toContain("second thought");
    // The note lands when the words arrive, the click's entry when it ends.
    expect(p.observations[1].history.map((h) => h.type)).toEqual([
      "correction",
      "click",
    ]);
    p.reply(done);
    await running;
    expect(runner.snapshot.run?.status).toBe("completed");
  });

  it("to a run waiting on an approval: pauses (reason control) and resumes with the words, as before", async () => {
    policy.evaluate = () => ({ kind: "CONFIRM", reason: "Test?" });
    const m = memory();
    const c = controller();
    const p = gated();
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    const running = runner.start("first task");
    await until(() => p.observations.length === 1);
    p.reply(click);
    await until(() => runner.snapshot.run?.status === "confirming");
    allowAll();
    await runner.revise("second thought");
    expect(m.of("RunPaused")).toHaveLength(1);
    expect(m.of("RunPaused")[0].data).toEqual({ reason: "control" });
    expect(runner.snapshot.pending).toBeUndefined();
    await until(() => p.observations.length === 2);
    expect(p.observations[1].task).toContain("second thought");
    p.reply(done);
    await running;
    expect(runner.snapshot.run?.status).toBe("completed");
  });

  it("to a held run: resumes it with the words, as before", async () => {
    allowAll();
    const m = memory();
    const c = controller();
    const p = gated();
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    const running = runner.start("first task");
    await until(() => p.observations.length === 1);
    runner.pause();
    expect(m.of("RunPaused")).toHaveLength(1);
    await runner.revise("second thought");
    expect(m.of("RunPaused")).toHaveLength(1);
    await until(() => p.observations.length === 2);
    expect(p.observations[1].task).toContain("second thought");
    p.reply(done);
    await running;
    expect(runner.snapshot.run?.status).toBe("completed");
  });
});

describe("every pause names its reason", () => {
  it("manual by default, control for a voice interruption, takeover for the user's hands", async () => {
    allowAll();
    for (const [how, reason] of [
      [(r: Runner) => r.pause(), "manual"],
      [(r: Runner) => r.pause("A message.", "system"), "system"],
      [(r: Runner) => r.interruptForVoice(), "control"],
      [(r: Runner) => r.manualTakeover(), "takeover"],
    ] as const) {
      const m = memory();
      const c = controller();
      const p = gated();
      const runner = new Runner(c, p, m.recorder, settings, () => {});
      const running = runner.start("first task");
      await until(() => p.observations.length === 1);
      how(runner);
      expect(runner.snapshot.run?.status).toBe("paused");
      expect(m.of("RunPaused").map((e) => e.data)).toEqual([{ reason }]);
      expect(Object.keys(m.of("RunPaused")[0].data)).toEqual(["reason"]);
      runner.stop();
      await running;
    }
  });

  it("approval for a declined question; a voice interruption of a confirming run holds nothing", async () => {
    policy.evaluate = () => ({ kind: "CONFIRM", reason: "Test?" });
    const m = memory();
    const c = controller();
    const p = gated();
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    const running = runner.start("first task");
    await until(() => p.observations.length === 1);
    p.reply(click);
    await until(() => runner.snapshot.run?.status === "confirming");
    // The approval window's semantics: input let go for the answer, no pause.
    runner.interruptForVoice();
    expect(runner.snapshot.run?.status).toBe("confirming");
    expect(m.of("RunPaused")).toHaveLength(0);
    expect(c.stop).toHaveBeenCalledTimes(1);
    await runner.approveFromVoice(false);
    expect(m.of("RunPaused").map((e) => e.data)).toEqual([
      { reason: "approval" },
    ]);
    runner.stop();
    await running;
  });
});

describe("main.ts keeps the run working while the owner talks", () => {
  const main = read("electron/main.ts");
  const activation = between(
    main,
    'event.event === "followup_detected"\n    ) {',
    'event.event === "shortcut_tap"',
  );

  it("interrupts the run on a follow-up detection only when the window holds it", () => {
    // One interruption in the activation branch, and only behind the guard.
    expect(activation.match(/interruptForVoice\(/g)).toHaveLength(1);
    expect(activation).toContain(
      'if (\n        event.event !== "followup_detected" ||\n        followUpHoldsRun(activationWindow, snapshot.run?.status)\n      )\n        interruptForVoice("control");',
    );
    expect(activation).not.toContain("interruptForVoice();");
    // The guard reads the window kind this very event set.
    expect(activation.indexOf("activationWindow =")).toBeLessThan(
      activation.indexOf("followUpHoldsRun("),
    );
    expect(main).toContain("  followUpHoldsRun,\n  leadingControlWord,\n");
  });

  it("reads a control word off the partials and holds the run within the partial", () => {
    const partial = between(
      main,
      'event.event === "transcript_partial") {',
      'event.event === "audio_level"',
    );
    expect(partial).toContain("controlPartial(voiceInvocation, lastPartial);");
    const control = between(
      main,
      "function controlPartial(invocation: number, text: string) {",
      "function watchHypothesis(",
    );
    expect(control).toContain(
      "if (controlledInvocation === invocation) return;",
    );
    expect(control).toContain(
      'if (!runActive() || runHeld() || snapshot.run!.status === "confirming")',
    );
    expect(control).toContain(
      'if (activationWindow === "approval" || scrolling) return;',
    );
    expect(control).toContain("const word = leadingControlWord(text);");
    expect(control).toContain('debug("ControlPartial", { code: word });');
    expect(control).toContain('interruptForVoice("control");');
  });

  it("gives every pause a reason and passes the interruption's on", () => {
    expect(main).not.toMatch(/runner[?!]\.pause\(\)/);
    expect(main).toContain(
      'function interruptForVoice(reason: PauseReason = "control") {',
    );
    expect(main).toContain("runner?.interruptForVoice(reason);");
    expect(main).toContain('runner?.pause(helperPause, "system");');
  });

  it("speaks a replacement as a statement", () => {
    const conversation = read("electron/conversation.ts");
    expect(conversation).toContain(
      'case "replace":\n          reply(\n            "ackReplace",',
    );
    expect(PHRASES.ackReplace).toEqual(["Stopped for your new task."]);
  });
});

describe("the helper latches input only where a hold belongs", () => {
  it("skips the stop latch for a continuation or answer window and keeps it elsewhere", () => {
    const voice = read("native/macos/Voice.swift");
    const followUp = between(
      voice,
      "func activateFollowUp() {",
      "func absorbRecognition(",
    );
    expect(followUp).toContain(
      "if followUpLatchesInput(kind) { signalController() }",
    );
    expect(followUp).not.toMatch(/^\s*signalController\(\)\s*$/m);
    // The wake activation still latches, as do the key handlers.
    const wake = between(voice, "func activateWake(", "func activateFollowUp(");
    expect(wake).toContain("    signalController()\n");
    const policy = read("native/macos/TurnPolicy.swift");
    expect(policy).toContain(
      "func followUpLatchesInput(_ kind: FollowUpKind) -> Bool {\n    kind == .approval || kind == .scroll\n}",
    );
    // The controller's latch itself is untouched: SIGUSR1 still stops input.
    const controller = read("native/macos/Controller.swift");
    expect(controller).toContain("stopSignal.setEventHandler{latch(true)}");
    expect(controller).toContain(
      'func ensureRunning() throws { if isStopped() { throw ControlError("Native input stopped. Explicitly resume to continue.", code: "STOPPED") } }',
    );
  });

  it("sends the last partial's confidence with an empty-final recovery", () => {
    const voice = read("native/macos/Voice.swift");
    expect(voice).toContain('"partialConfidence": partialConfidence]');
    expect(voice).toContain("lastPartialConfidence = meanConfidence(");
    expect(voice).toContain("let partialConfidence = lastPartialConfidence");
    expect(read("electron/voice.ts")).toContain("partialConfidence?: number;");
  });
});

describe("a recovered hypothesis keeps its partial's confidence", () => {
  const recovered = {
    event: "transcript_recovered",
    confidence: 0,
    source: "empty_final_after_endpoint",
  };
  it("takes the partial's confidence, never above a stable hypothesis's, else the standing time", () => {
    expect(
      voiceCommandConfidence({
        ...recovered,
        stableMs: 200,
        partialConfidence: 0.4,
      }),
    ).toBe(0.4);
    expect(
      voiceCommandConfidence({
        ...recovered,
        stableMs: 200,
        partialConfidence: 0.9,
      }),
    ).toBe(0.7);
    expect(
      voiceCommandConfidence({
        ...recovered,
        stableMs: 1500,
        partialConfidence: 0.4,
      }),
    ).toBe(0.7);
    expect(
      voiceCommandConfidence({
        ...recovered,
        stableMs: 1500,
        partialConfidence: 0,
      }),
    ).toBe(0.7);
    expect(voiceCommandConfidence({ ...recovered, stableMs: 200 })).toBe(0);
    for (const partialConfidence of [0, -0.5, 1.5, NaN, Infinity])
      expect(
        voiceCommandConfidence({
          ...recovered,
          stableMs: 200,
          partialConfidence,
        }),
      ).toBe(0);
    // Other recoveries and finals are as before.
    expect(
      voiceCommandConfidence({
        ...recovered,
        source: "control_phrase_after_endpoint",
        partialConfidence: 0.9,
      }),
    ).toBe(0);
    expect(
      voiceCommandConfidence({
        event: "transcript_final",
        confidence: 0.9,
        partialConfidence: 0.2,
      }),
    ).toBe(0.9);
  });
});

describe("a clear command to a held run under 'never ask' replaces it, unasked", () => {
  const held = (over: Partial<VoiceTurnRun> = {}): VoiceTurnRun => ({
    id: "run-1",
    status: "paused",
    actions: 3,
    held: true,
    stalled: true,
    task: "Find flights to Denver on Friday",
    ...over,
  });
  const base: TurnPlan = { kind: "revise", text: "read the note" };
  const decide = (over: Record<string, unknown>) =>
    arbitrate({
      base,
      head: { act: "start", task: "Read the note" },
      utterance: base.text,
      channel: "voice",
      heldByVoice: false,
      run: held(),
      context: ["read the note"],
      ...over,
    });
  it("replaces at confidence 0.5 and above, with a statement and no question", () => {
    for (const confidence of [0.5, 0.7, 1]) {
      const a = decide({ neverAsks: true, confidence });
      expect([confidence, a.plan, a.code, a.speakSay]).toEqual([
        confidence,
        { kind: "replace", text: "Read the note" },
        "replace_unasked",
        false,
      ]);
    }
    // Typed words carry no confidence and are the user's.
    expect(decide({ neverAsks: true }).code).toBe("replace_unasked");
  });
  it("still asks below the floor, under any other setting, and in takeover", () => {
    const ask = {
      kind: "clarify",
      question: PHRASES.pausedFirst[0],
      fragment: "",
    };
    expect(decide({ neverAsks: true, confidence: 0.49 }).plan).toEqual(ask);
    expect(decide({ neverAsks: true, confidence: 0 }).plan).toEqual(ask);
    expect(decide({ neverAsks: false, confidence: 1 }).plan).toEqual(ask);
    expect(decide({ confidence: 1 }).plan).toEqual(ask);
    expect(decide({ confidence: 1 }).code).toBe("replace_held");
    // A held run in takeover is the user's hands: the same rule.
    expect(
      decide({
        neverAsks: true,
        confidence: 0.9,
        run: held({ status: "takeover" }),
      }).code,
    ).toBe("replace_unasked");
  });
});
