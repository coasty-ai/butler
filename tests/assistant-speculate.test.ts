import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  SPECULATE_LIMITS,
  hypothesisKey,
  sameWords,
  speculationCandidate,
  speculationPlan,
} from "../src/assistant/speculate";
import { planVoiceTurn } from "../src/voice/turns";
import { defaultSettings, type Action, type Frame } from "../src/core/schema";
import { EarlyStart, type EarlyController } from "../electron/early-start";

/**
 * Thinking ahead while the user talks (docs/VOICE_PRODUCT.md): which stable
 * hypothesis the run's first step may be prepared for, whether the final
 * says the same words, and how electron/main.ts wires the preparation so
 * that nothing acts, speaks or shows before the final. The runner's part
 * is in runner-speculate.test.ts.
 */
const main = readFileSync(
  new URL("../electron/main.ts", import.meta.url),
  "utf8",
);
const between = (from: string, to: string) => {
  const start = main.indexOf(from);
  expect(start, from).toBeGreaterThan(-1);
  const end = main.indexOf(to, start + from.length);
  expect(end, to).toBeGreaterThan(start);
  return main.slice(start, end);
};

describe("the hypothesis a step may be prepared for", () => {
  it("keeps the design's stable time and frame age", () => {
    expect(SPECULATE_LIMITS.stableMs).toBe(800);
    expect(SPECULATE_LIMITS.frameMaxAgeMs).toBe(20_000);
  });
  it("accepts a finished-sounding command and nothing else", () => {
    expect(speculationCandidate("Search for cats")).toEqual({
      key: "search for cats",
    });
    expect(speculationCandidate("send Dana the notes from today")).toEqual({
      key: "send dana the notes from today",
    });
    const refused: [string, string][] = [
      ["", "empty"],
      ["   ", "empty"],
      ["Hey Butler", "wake_only"],
      ["Butler", "wake_only"],
      ["type password: hunter2x9", "secret"],
      ["stop", "control"],
      ["wait", "control"],
      ["yes", "not_command"],
      ["stop scrolling", "not_command"],
      ["no thanks", "not_command"],
      ["continue", "not_command"],
      ["undo that", "not_command"],
      ["scroll down", "not_command"],
      ["okay", "not_command"],
      ["how's it going", "status_question"],
      ["Open", "fragment"],
      ["can you", "fragment"],
      ["open the", "fragment"],
      ["search for cats and", "fragment"],
      ["um uh", "fragment"],
    ];
    for (const [text, code] of refused)
      expect(speculationCandidate(text), text).toEqual({ code });
  });
  it("compares words the way the router does: case, punctuation, fillers and the wake phrase aside", () => {
    expect(hypothesisKey("Search for cats.")).toBe("search for cats");
    expect(hypothesisKey("um, search for cats please")).toBe("search for cats");
    expect(hypothesisKey("Hey Butler, search for cats")).toBe(
      "search for cats",
    );
    expect(hypothesisKey("open notes Butler open notes and")).toBe(
      "open notes and",
    );
    expect(sameWords("Search for cats", "search for cats.")).toBe(true);
    expect(sameWords("okay search for cats", "search for cats please")).toBe(
      true,
    );
    expect(sameWords("search for cats", "search for cats and dogs")).toBe(
      false,
    );
    expect(sameWords("search for cats", "search for dogs")).toBe(false);
    expect(sameWords("", "")).toBe(false);
    expect(sameWords("um", "uh")).toBe(false);
  });
  it("prepares only for a start the router runs on the user's own words unaided", () => {
    const plan = (text: string) =>
      planVoiceTurn({
        text,
        confidence: 1,
        source: "wake",
        gateMatches: false,
        now: Date.now(),
      });
    expect(speculationPlan(plan("search for cats"), "search for cats")).toEqual(
      { task: "search for cats" },
    );
    expect(
      speculationPlan(
        plan("open the message from Dana"),
        "open the message from Dana",
      ),
    ).toEqual({ task: "open the message from Dana" });
    // Words the dialog model decides: its own preempt covers them.
    expect(
      speculationPlan(
        plan("tell me whether the invoice was paid"),
        "tell me whether the invoice was paid",
      ),
    ).toEqual({ code: "needs_model" });
    expect(
      speculationPlan(plan("what's on my calendar"), "what's on my calendar"),
    ).toEqual({
      code: "needs_model",
    });
    // Words that only point ("do that again") get a question, not a start.
    expect(speculationPlan(plan("do that again"), "do that again")).toEqual({
      code: "plan_not_start",
    });
    // Not a start at all.
    expect(speculationPlan({ kind: "stop" }, "stop")).toEqual({
      code: "plan_not_start",
    });
    expect(
      speculationPlan({ kind: "revise", text: "click Save" }, "click Save"),
    ).toEqual({
      code: "plan_not_start",
    });
    // An accepted offer's words are the assistant's.
    expect(
      speculationPlan(
        { kind: "start", text: "Send the notes", taskSource: "proposal" },
        "yes",
      ),
    ).toEqual({ code: "proposal" });
  });
});

describe("the early step and the prepared step keep out of each other's way", () => {
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
  const ticks = async (n = 12) => {
    for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
  };
  function setup() {
    let now = 0;
    const timers: { fn: () => void; at: number }[] = [];
    const controller: EarlyController = {
      configure: vi.fn(async () => {}),
      surface: vi.fn(async (action?: Action) =>
        action
          ? {
              appId: "com.microsoft.VSCode",
              pid: 7,
              secureInput: false,
              unknown: false,
              launcherStatus: "resolved" as const,
              launcherAppId: "com.tinyspeck.slackmacgap",
              launcherName: "Slack",
              windowCount: 1,
            }
          : {
              appId: "com.microsoft.VSCode",
              pid: 7,
              secureInput: false,
              unknown: false,
            },
      ),
      capture: vi.fn(async (): Promise<Frame> => ({
        id: "frame-1",
        sha256: "sha",
        image: "",
        geometry,
        capturedAt: 0,
        synthetic: false,
        appId: "com.microsoft.VSCode",
      })),
      execute: vi.fn(async () => ({
        launched: {
          appId: "com.tinyspeck.slackmacgap",
          name: "Slack",
          frontmost: true,
          wasRunning: true,
          windows: 1,
        },
      })),
      resume: vi.fn(async () => {}),
      stop: vi.fn(),
      request: vi.fn(async () => undefined),
    };
    const early = new EarlyStart({
      controller: () => controller,
      settings: () => ({
        ...structuredClone(defaultSettings),
        earlyStart: true,
      }),
      knownApp: (key) => (key === "slack" ? "exact" : "none"),
      blocked: () => undefined,
      onOpened: () => {},
      trace: () => {},
      now: () => now,
      setTimer: (fn, ms) => {
        const t = { fn, at: now + ms };
        timers.push(t);
        return t;
      },
      clearTimer: (t) => {
        const i = timers.indexOf(t as (typeof timers)[number]);
        if (i >= 0) timers.splice(i, 1);
      },
    });
    return { early, controller, advance: (ms: number) => (now += ms) };
  }
  it("is engaged once the leading clause settled on a step, for that activation alone", async () => {
    const t = setup();
    t.early.begin(1, Promise.resolve());
    expect(t.early.engaged(1)).toBe(false);
    t.early.partial(1, "open");
    expect(t.early.engaged(1)).toBe(false);
    // An installed app's exact name settles at once.
    t.early.partial(1, "open Slack");
    expect(t.early.engaged(1)).toBe(true);
    expect(t.early.engaged(2)).toBe(false);
    await ticks();
    expect(t.controller.execute).toHaveBeenCalledTimes(1);
    expect(t.early.engaged(1)).toBe(true);
    t.early.finish(1, "open Slack and message Dana")?.release("plan_not_start");
    // A turn with no clause never engages.
    t.early.begin(2, Promise.resolve());
    t.early.partial(2, "search for cats");
    expect(t.early.engaged(2)).toBe(false);
    expect(t.early.engaged(1)).toBe(false);
  });
  it("is not engaged after a change of mind called the step off", async () => {
    const t = setup();
    t.early.begin(1, Promise.resolve());
    t.early.partial(1, "open Slack");
    expect(t.early.engaged(1)).toBe(true);
    t.early.cancel("cancelled");
    expect(t.early.engaged(1)).toBe(false);
    await ticks();
  });
});

describe("main wires the prepared step so nothing acts before the final", () => {
  it("arms the stable timer on every partial and lets a changed hypothesis go at once", () => {
    const partial = between(
      'event.event === "transcript_partial") {',
      'event.event === "audio_level"',
    );
    expect(partial).toContain("early.partial(voiceInvocation, lastPartial);");
    expect(partial).toContain("watchHypothesis(voiceInvocation, lastPartial);");
    const watch = between(
      "function watchHypothesis(",
      "function onStableHypothesis(",
    );
    expect(watch).toContain("clearTimeout(speculationTimer)");
    expect(watch).toContain(
      'hypothesisKey(text) !== s.key)\n    discardSpeculation("text_changed")',
    );
    expect(watch).toContain("SPECULATE_LIMITS.stableMs");
    const stable = between(
      "function onStableHypothesis(",
      "async function speculate(",
    );
    // The dialog's early request moves to the stable moment too (design E2 a).
    expect(stable).toContain('assistant.preempt(text, "voice")');
    expect(stable).toContain("void speculate(invocation, text)");
    expect(stable).toContain(
      "if (!listening || invocation !== voiceInvocation) return;",
    );
  });
  it("prepares at most once a turn, only for a fast start, never in an approval or answer window, on push-to-talk, over a run or beside an early step", () => {
    const speculate = between(
      "async function speculate(",
      "function discardSpeculation(",
    );
    const order = [
      "if (speculatedInvocation === invocation) return;",
      "speculatedInvocation = invocation;",
      'if (!settings.earlyStart) return skip("disabled");',
      'if (activationSource === "ptt") return skip("ptt");',
      'if (activationWindow === "approval" || activationWindow === "answer")',
      'if (earlyBlocked()) return skip("blocked");',
      'if (early.engaged(invocation)) return skip("early_step");',
      "const candidate = speculationCandidate(text);",
      'if (codingRequest(text)) return skip("coding");',
      "const base = planVoiceTurn({",
      "const plan = speculationPlan(base, text);",
      'if (fast?.kind === "answer") return skip("tool_answer");',
      "await early.idle();",
      "prepared = await buildRunner(false);",
      "const step = prepared.prepare(task, {",
      'debug("SpeculationStarted", {});',
    ];
    let at = -1;
    for (const line of order) {
      const next = speculate.indexOf(line, at + 1);
      expect(next, line).toBeGreaterThan(at);
      at = next;
    }
    // The preparation never executes, starts, speaks or touches the pill.
    for (const forbidden of [
      ".execute(",
      ".start(",
      "setPill(",
      "conversation.say(",
      "speak(",
      "startRun(",
    ])
      expect(speculate, forbidden).not.toContain(forbidden);
    // The words it plans with are the router's own facts, as planCommand gives them.
    expect(speculate).toContain("run: planRun(),");
    expect(speculate).toContain("proposal: assistant.proposal(),");
    expect(speculate).toContain("followUpWindow: settings.followUpWindow,");
    // A preparation that gave up on its own is logged as let go.
    expect(speculate).toContain(
      "discardSpeculation(step.code as SpeculationCode)",
    );
  });
  it("hands the step to the run only for a start of the same words in the same activation, with no early step", () => {
    const claim = between("function claimSpeculation(", "/** The OpenAI key");
    expect(claim).toContain('discardSpeculation("superseded")');
    expect(claim).toContain('discardSpeculation("early_step")');
    expect(claim).toContain(
      'if (!sameWords(task, s.step.task)) {\n    discardSpeculation("text_changed")',
    );
    // Exactly one caller, in runPlan's start case, after the prelude and the
    // reactivation check, and never for a revise or over a run.
    expect(main.match(/claimSpeculation\(/g)).toHaveLength(2);
    const start = between(
      'case "revise":\n    case "start": {',
      "      return;\n    }\n  }\n}",
    );
    expect(start).toContain(
      'plan.kind === "start" && !active\n          ? claimSpeculation(ctx.invocation, plan.text, prelude !== undefined)',
    );
    expect(start.indexOf("await ctx.early.take()")).toBeLessThan(
      start.indexOf("claimSpeculation("),
    );
    expect(start.indexOf("ctx.invocation !== voiceInvocation")).toBeLessThan(
      start.indexOf("claimSpeculation("),
    );
    expect(start).toContain(
      'if (!adopt) discardSpeculation("plan_not_start");',
    );
    expect(start).toContain("prelude,\n          adopt,\n        );");
    // startRun alone passes it on, as `prepared`, on the runner that made it.
    const startRun = between(
      "async function startRun(",
      "async function dispatch(",
    );
    expect(startRun).toContain(
      "runner = adopt && !tutorial ? adopt.runner : await buildRunner(tutorial);",
    );
    expect(startRun).toContain(
      "...(adopt && !tutorial ? { prepared: adopt.step } : {}),",
    );
    expect(startRun).toContain('adopt?.step.discard("not_started");');
    expect(main.match(/prepared: adopt\.step/g)).toHaveLength(1);
  });
  it("lets the step go on every other end of the turn", () => {
    const receive = between(
      "async function receiveVoice(",
      "function planRun() {",
    );
    const activation = between(
      'event.event === "followup_detected"\n    ) {',
      'event.event === "shortcut_tap"',
    );
    expect(activation).toContain('discardSpeculation("reactivated");');
    expect(activation).toContain("clearTimeout(speculationTimer);");
    expect(activation).toContain("activationSource =");
    expect(activation).toContain("activationWindow =");
    expect(
      between('event.event === "voice_cancelled") {', "listeningEnded();"),
    ).toContain('discardSpeculation("cancelled");');
    expect(
      between(
        'event.event === "transcript_unconfirmed") {',
        "if (!listening) return;",
      ),
    ).toContain('discardSpeculation("no_final");');
    expect(
      between(
        'event.event === "voice_error" || event.event === "wake_error") {',
        "listening = false;",
      ),
    ).toContain('discardSpeculation("no_final");');
    expect(receive.slice(receive.lastIndexOf("} catch (error) {"))).toContain(
      'discardSpeculation("native_error");',
    );
    expect(
      between(
        "function cancelVoiceCapture() {",
        "function interruptForVoice() {",
      ),
    ).toContain('discardSpeculation("cancelled");');
    // A final whose plan is not a start (a control word, an answer, a question).
    expect(
      between("async function command(", "async function planCommand("),
    ).toContain(
      'if (speculation?.invocation === turnInvocation)\n      discardSpeculation("plan_not_start");',
    );
  });
  it("logs the trade content-free: codes, kind and usage only", () => {
    const discard = between(
      "function discardSpeculation(",
      "function claimSpeculation(",
    );
    expect(discard).toContain(
      'debug("SpeculationDiscarded", {\n    code,\n    kind: s.step.kind,',
    );
    expect(discard).toContain("usage: s.step.usage");
    expect(discard).not.toContain("text");
    expect(discard).not.toContain("task");
  });
});
