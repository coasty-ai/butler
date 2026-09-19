import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  actionSchema,
  defaultSettings,
  type Action,
  type Controller,
  type Frame,
  type JournalEvent,
  type Observation,
  type ProviderResult,
  type Recorder,
  type Run,
  type Settings,
  type Surface,
} from "../src/core/schema";
import { evaluate, UNDO_QUESTION } from "../src/core/policy";
import {
  NOTHING_TO_UNDO_MESSAGE,
  Runner,
  UNDO_MENU_PATH,
  UNDONE_MESSAGE,
} from "../src/core/runner";
import { describeAction } from "../src/voice/router";
import { speakableText } from "../src/voice/speakable";
import {
  clarifyFragment,
  isControlPhrase,
  planVoiceTurn,
  UNDO_WINDOW_MS,
  utteranceCompleteness,
  voiceIntent,
  type VoiceTurnInput,
  type VoiceTurnRun,
} from "../src/voice/turns";

/**
 * "Undo that" takes the last step back through the frontmost application's
 * own Edit > Undo: a steering command during a run, a short run of its own
 * right after one, and an ordinary request for the model any later.
 */
describe("the spoken undo: intent", () => {
  it.each([
    "undo",
    "Undo.",
    "undo that",
    "Undo that, please",
    "undo it",
    "undo this",
    "undo that one",
    "undo the last step",
    "undo the last change",
    "undo last action",
    "take that back",
    "take it back",
    "revert that",
    "revert the last change",
    "no, undo that",
    "oops, undo",
    "wait, undo that",
    "actually, undo that",
    "can you undo that",
    "press undo",
    "hit undo",
    "um, undo that",
    "undo undo",
    "u-u-undo that",
    "okay undo that now",
  ])("hears %j as an undo", (text) => {
    expect(voiceIntent(text).kind).toBe("undo");
  });

  it.each([
    ["don't undo that", "command"],
    ["undo the formatting in the second paragraph", "command"],
    ["undo everything", "command"],
    ["undo the last three steps", "command"],
    ["undo that and close the window", "command"],
    ["redo that", "command"],
    ["take back the message", "command"],
    ["wait", "pause"],
    ["stop", "stop"],
    ["never mind", "stop"],
  ])("keeps %j as %s", (text, kind) => {
    expect(voiceIntent(text).kind).toBe(kind);
  });

  it("is not a control phrase, ends like a finished command, and is never a fragment", () => {
    expect(isControlPhrase("undo that")).toBe(false);
    expect(utteranceCompleteness("undo that")).toBe("complete");
    expect(utteranceCompleteness("undo")).toBe("complete");
    expect(clarifyFragment("undo")).toBeUndefined();
  });

  it("is never something the assistant says, while its own report is", () => {
    expect(speakableText("Undo that.")).toBeUndefined();
    expect(speakableText(UNDONE_MESSAGE)).toBe(UNDONE_MESSAGE);
    expect(speakableText(NOTHING_TO_UNDO_MESSAGE)).toBe(
      NOTHING_TO_UNDO_MESSAGE,
    );
  });
});

describe("the spoken undo: planning", () => {
  const now = 100000;
  const run = (over: Partial<VoiceTurnRun> = {}): VoiceTurnRun => ({
    id: "run-1",
    status: "executing",
    actions: 2,
    held: false,
    task: "Fix the heading",
    ...over,
  });
  const plan = (over: Partial<VoiceTurnInput>) =>
    planVoiceTurn({
      text: "undo that",
      confidence: 0.9,
      source: "ptt",
      gateMatches: true,
      now,
      ...over,
    });
  const undo = { kind: "undo", words: "undo that" };

  it("steers a run under way whatever it is doing, and never answers its approval", () => {
    for (const status of ["capturing", "thinking", "executing"])
      expect(plan({ run: run({ status }) })).toEqual(undo);
    for (const status of ["paused", "takeover"])
      expect(plan({ run: run({ status, held: true, stalled: true }) })).toEqual(
        undo,
      );
    const approval = run({
      status: "confirming",
      pendingReason: "Send this message?",
    });
    expect(plan({ run: approval })).toEqual(undo);
    expect(
      plan({ run: approval, source: "followup", window: "approval" }),
    ).toEqual(undo);
    expect(plan({ run: approval, source: "wake", confidence: 1 })).toEqual(
      undo,
    );
  });

  it("means the run that ended within a minute; later it is a task for the model", () => {
    expect(plan({ lastRun: { endedAt: now - 30000 } })).toEqual(undo);
    expect(plan({ lastRun: { endedAt: now - UNDO_WINDOW_MS } })).toEqual(undo);
    // A run that ended is not the run; the window decides.
    expect(
      plan({
        run: run({ status: "completed" }),
        lastRun: { endedAt: now - 1000 },
      }),
    ).toEqual(undo);
    const task = { kind: "start", text: "undo that", taskSource: "user_words" };
    expect(plan({ lastRun: { endedAt: now - UNDO_WINDOW_MS - 1 } })).toEqual(
      task,
    );
    expect(plan({})).toEqual(task);
  });

  it("acts only on speech heard clearly: a final, or a hypothesis that stood still", () => {
    // The router gives a stable recovered hypothesis 0.7: enough to steer.
    expect(plan({ run: run(), confidence: 0.7, recovered: true })).toEqual(
      undo,
    );
    // Heard less clearly it is the correction or task it always was, and
    // the model reads it.
    expect(plan({ run: run(), confidence: 0 })).toEqual({
      kind: "revise",
      text: "undo that",
    });
    expect(plan({ run: run(), confidence: 0.5 })).toEqual({
      kind: "revise",
      text: "undo that",
    });
    expect(plan({ confidence: 0, lastRun: { endedAt: now - 1000 } })).toEqual({
      kind: "start",
      text: "undo that",
      taskSource: "user_words_unsure",
    });
    // Typed and texted words are the user's, whatever the confidence field says.
    for (const source of ["text", "message", "remote"] as const)
      expect(plan({ source, confidence: 0, run: run() })).toEqual(undo);
  });

  it("cleans speech like a correction, keeps typed words as written, and drops a fragment", () => {
    expect(plan({ text: "um, undo that", run: run() })).toEqual(undo);
    expect(plan({ text: " Undo that. ", source: "text", run: run() })).toEqual({
      kind: "undo",
      words: "Undo that.",
    });
    expect(
      plan({ run: run(), fragment: { text: "Open", until: now + 5000 } }),
    ).toEqual(undo);
  });

  it("still lets stop and pause win", () => {
    expect(plan({ text: "wait", run: run() })).toEqual({ kind: "pause" });
    expect(plan({ text: "stop", run: run() })).toEqual({ kind: "stop" });
  });
});

describe("the spoken undo: policy", () => {
  const base: Surface = {
    appId: "com.apple.TextEdit",
    pid: 7,
    secureInput: false,
    unknown: false,
  };
  const undoItem = actionSchema.parse({
    frame_id: "f",
    type: "menu_item",
    path: UNDO_MENU_PATH,
  });
  const decide = (
    surface: Partial<Surface>,
    autonomy: Settings["autonomy"],
    autonomyAllAcknowledged = false,
  ) =>
    evaluate(
      undoItem,
      { ...base, ...surface },
      {
        ...structuredClone(defaultSettings),
        autonomy,
        autonomyAllAcknowledged,
      },
      false,
    );
  const resolved = {
    menuStatus: "resolved" as const,
    menuLabel: "Undo Typing",
  };

  it("asks only in 'ask'; every other setting runs it and reports it", () => {
    expect(decide(resolved, "ask")).toEqual({
      kind: "CONFIRM",
      reason: UNDO_QUESTION,
    });
    for (const autonomy of ["task", "flow", "all"] as const) {
      const decision = decide(resolved, autonomy);
      expect([autonomy, decision.kind]).toEqual([autonomy, "ALLOW"]);
      expect(decision.reason).toMatch(/takes the last step back/);
    }
    expect(decide(resolved, "all", true).kind).toBe("ALLOW");
    // The words the user said change nothing: the step is reversible by itself.
    expect(
      evaluate(
        undoItem,
        { ...base, ...resolved },
        { ...structuredClone(defaultSettings), autonomy: "task" },
        false,
        { userWords: "fix the heading" },
      ).kind,
    ).toBe("ALLOW");
  });

  it("reports a greyed-out or missing Undo without pressing anything", () => {
    const disabled = decide(
      { menuStatus: "disabled", menuLabel: "Undo" },
      "ask",
    );
    expect(disabled.kind).toBe("RETRY");
    expect(disabled.reason).toMatch(/greyed out/);
    expect(decide({ menuStatus: "missing" }, "flow").kind).toBe("RETRY");
  });

  it("names the step on the approval pill", () => {
    expect(describeAction(undoItem)).toBe("Choose Edit › Undo.");
  });
});

// Runner harness, as in runner-amend.test.ts: a journal, a native controller
// whose menu resolution is scripted, and a provider that plays replies.
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
  appId: "com.apple.TextEdit",
  pid: 42,
  secureInput: false,
  unknown: false,
};
const usage = { inputTokens: 0, outputTokens: 0, cost: 0 };
const tick = () => new Promise((r) => setTimeout(r, 5));
const until = async (condition: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error("Timed out waiting for condition.");
    await tick();
  }
};
function journal() {
  const events: JournalEvent[] = [];
  const recorder: Recorder = {
    begin: () => {},
    save: () => {},
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
/** A controller whose Edit > Undo resolves as given. */
function controller(menu: Pick<Surface, "menuStatus" | "menuLabel">) {
  const c: Controller = {
    kind: "native",
    surface: vi.fn(async (action?: Action) =>
      action?.type === "menu_item" ? { ...surface, ...menu } : surface,
    ),
    capture: vi.fn(async (): Promise<Frame> => ({
      id: `frame-${++captures}`,
      sha256: "sha",
      image: "",
      geometry,
      capturedAt: 0,
      synthetic: false,
      appId: surface.appId,
    })),
    execute: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    stop: vi.fn(() => {}),
  };
  return c;
}
type Reply = (
  o: Observation,
  signal: AbortSignal,
) => Partial<ProviderResult> | Promise<Partial<ProviderResult>>;
function scripted(replies: Reply[] = []) {
  const observations: Observation[] = [];
  const next = vi.fn(async (o: Observation, signal: AbortSignal) => {
    observations.push(structuredClone(o));
    const reply = replies[observations.length - 1];
    const value = reply
      ? await reply(o, signal)
      : { action: { type: "done", summary: "Done", frame_id: o.frame.id } };
    return { usage, ...value } as ProviderResult;
  });
  return { next, observations };
}
const hang: Reply = (_o, signal) =>
  new Promise<never>((_r, reject) =>
    signal.addEventListener("abort", () => reject(new Error("Cancelled"))),
  );
const executedTypes = (c: Controller) =>
  (c.execute as ReturnType<typeof vi.fn>).mock.calls.map(
    (call) => (call[0] as Action).type,
  );
const withAutonomy = (autonomy: Settings["autonomy"]): Settings => ({
  ...structuredClone(defaultSettings),
  autonomy,
});
const voice = { origin: "voice" as const, taskSource: "user_words" as const };

describe("the spoken undo: the run under way", () => {
  it("pauses, presses Edit > Undo as its next step without a model call, reports and waits", async () => {
    const m = journal();
    const c = controller({ menuStatus: "resolved", menuLabel: "Undo Typing" });
    const p = scripted([hang]);
    const runner = new Runner(c, p, m.recorder, withAutonomy("task"), () => {});
    const running = runner.start("Fix the heading", voice);
    await until(() => p.observations.length === 1);
    await runner.undo("undo that");
    await until(
      () =>
        runner.snapshot.run?.status === "paused" &&
        runner.snapshot.message === UNDONE_MESSAGE,
    );
    expect(c.execute).toHaveBeenCalledTimes(1);
    expect((c.execute as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual({
      type: "menu_item",
      frame_id: expect.any(String),
      path: UNDO_MENU_PATH,
    });
    // Recorded as the user's own correction and as an executed step; the
    // model was never asked, and the run is waiting.
    expect(p.next).toHaveBeenCalledTimes(1);
    expect(runner.snapshot.run?.corrections?.map((x) => x.text)).toEqual([
      "undo that",
    ]);
    expect(m.of("UserCorrectionRecorded")).toHaveLength(1);
    expect(m.of("ActionExecuted")).toHaveLength(1);
    expect(m.of("PolicyAllowed").map((e) => e.data.reason)).toEqual([
      expect.stringMatching(/takes the last step back/),
    ]);
    expect(m.of("RunPaused")).toHaveLength(2);
    expect(runner.snapshot.run?.actions).toBe(1);
    runner.stop();
    await running;
  });

  it("says there is nothing to undo when the item is greyed out, and waits", async () => {
    const m = journal();
    const c = controller({ menuStatus: "disabled", menuLabel: "Undo" });
    const p = scripted([hang]);
    const runner = new Runner(c, p, m.recorder, withAutonomy("flow"), () => {});
    const running = runner.start("Fix the heading", voice);
    await until(() => p.observations.length === 1);
    await runner.undo("take that back");
    await until(
      () =>
        runner.snapshot.run?.status === "paused" &&
        runner.snapshot.message === NOTHING_TO_UNDO_MESSAGE,
    );
    expect(c.execute).not.toHaveBeenCalled();
    expect(p.next).toHaveBeenCalledTimes(1);
    expect(m.of("ActionRetargetRequested")).toHaveLength(0);
    runner.stop();
    await running;
  });

  it("in 'ask', asks first; a no drops the undo and the run goes on as before", async () => {
    const m = journal();
    const c = controller({ menuStatus: "resolved", menuLabel: "Undo" });
    const p = scripted([hang]);
    const runner = new Runner(c, p, m.recorder, withAutonomy("ask"), () => {});
    const running = runner.start("Fix the heading", voice);
    await until(() => p.observations.length === 1);
    await runner.undo("undo that");
    await until(() => runner.snapshot.run?.status === "confirming");
    expect(runner.snapshot.pending).toEqual({
      action: {
        type: "menu_item",
        frame_id: expect.any(String),
        path: UNDO_MENU_PATH,
      },
      reason: UNDO_QUESTION,
    });
    await runner.approveFromVoice(false, "voice");
    expect(runner.snapshot.run?.status).toBe("paused");
    expect(c.execute).not.toHaveBeenCalled();
    // "Continue": the next step is the model's again, not the undo.
    expect(await runner.resume()).toBe(true);
    await running;
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(p.next).toHaveBeenCalledTimes(2);
    expect(c.execute).not.toHaveBeenCalled();
  });

  it("in 'ask', a yes presses it and the run waits", async () => {
    const m = journal();
    const c = controller({ menuStatus: "resolved", menuLabel: "Undo" });
    const p = scripted([hang]);
    const runner = new Runner(c, p, m.recorder, withAutonomy("ask"), () => {});
    const running = runner.start("Fix the heading", voice);
    await until(() => p.observations.length === 1);
    await runner.undo("undo that");
    await until(() => runner.snapshot.run?.status === "confirming");
    await runner.approveFromVoice(true, "voice");
    await until(
      () =>
        runner.snapshot.run?.status === "paused" &&
        runner.snapshot.message === UNDONE_MESSAGE,
    );
    expect(executedTypes(c)).toEqual(["menu_item"]);
    expect(m.of("UserConfirmed")).toHaveLength(1);
    runner.stop();
    await running;
  });
});

describe("the spoken undo: a run of its own", () => {
  it("presses Edit > Undo and ends with 'Undone.' without a model call", async () => {
    const m = journal();
    const c = controller({ menuStatus: "resolved", menuLabel: "Undo Typing" });
    const p = scripted();
    const runner = new Runner(c, p, m.recorder, withAutonomy("task"), () => {});
    await runner.start("undo that", { ...voice, undo: true });
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(runner.snapshot.run?.summary).toBe(UNDONE_MESSAGE);
    expect(executedTypes(c)).toEqual(["menu_item"]);
    expect(p.next).not.toHaveBeenCalled();
    expect(m.of("ActionExecuted")).toHaveLength(1);
    expect(m.of("RunCompleted")).toHaveLength(1);
  });

  it("ends with 'Nothing to undo.' when the item is greyed out or missing", async () => {
    for (const menu of [
      { menuStatus: "disabled" as const, menuLabel: "Undo" },
      { menuStatus: "missing" as const },
    ]) {
      const m = journal();
      const c = controller(menu);
      const p = scripted();
      const runner = new Runner(
        c,
        p,
        m.recorder,
        withAutonomy("ask"),
        () => {},
      );
      await runner.start("undo that", { ...voice, undo: true });
      expect(runner.snapshot.run?.status).toBe("completed");
      expect(runner.snapshot.run?.summary).toBe(NOTHING_TO_UNDO_MESSAGE);
      expect(c.execute).not.toHaveBeenCalled();
      expect(p.next).not.toHaveBeenCalled();
    }
  });

  it("in 'ask', asks first; a no ends the run with nothing done", async () => {
    const m = journal();
    const c = controller({ menuStatus: "resolved", menuLabel: "Undo" });
    const p = scripted();
    const runner = new Runner(c, p, m.recorder, withAutonomy("ask"), () => {});
    const running = runner.start("undo that", { ...voice, undo: true });
    await until(() => runner.snapshot.run?.status === "confirming");
    expect(runner.snapshot.pending?.reason).toBe(UNDO_QUESTION);
    await runner.approveFromVoice(false, "pill");
    await running;
    expect(runner.snapshot.run?.status).toBe("cancelled");
    expect(c.execute).not.toHaveBeenCalled();
    expect(p.next).not.toHaveBeenCalled();
  });

  it("in 'ask', a yes presses it and the run ends with 'Undone.'", async () => {
    const m = journal();
    const c = controller({ menuStatus: "resolved", menuLabel: "Undo" });
    const p = scripted();
    const runner = new Runner(c, p, m.recorder, withAutonomy("ask"), () => {});
    const running = runner.start("undo that", { ...voice, undo: true });
    await until(() => runner.snapshot.run?.status === "confirming");
    await runner.approveFromVoice(true, "voice");
    await running;
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(runner.snapshot.run?.summary).toBe(UNDONE_MESSAGE);
    expect(executedTypes(c)).toEqual(["menu_item"]);
    expect(p.next).not.toHaveBeenCalled();
  });
});

describe("the spoken undo: main.ts wiring", () => {
  // main.ts is not loaded in tests; the wiring is pinned by reading it.
  const source = readFileSync(
    new URL("../electron/main.ts", import.meta.url),
    "utf8",
  );

  it("steers the run under way, or starts a run of its own, in the app the user was in", () => {
    const start = source.indexOf('case "undo": {');
    expect(start).toBeGreaterThan(0);
    const block = source.slice(
      start,
      source.indexOf('case "acknowledge":', start),
    );
    expect(block).toContain('await native?.request("restoreRemembered");');
    expect(block).toMatch(/if \(active\) await runner!\.undo\(plan\.words\);/);
    expect(block).toMatch(
      /await startRun\(plan\.words, false, \{\s*origin: ctx\.origin,\s*taskSource: ctx\.taskSource,\s*undo: true,\s*\}\);/,
    );
  });

  it("tells the planner when the last run ended, on the Mac, from the phone and for the hypothesis a first step is prepared for", () => {
    expect(source.match(/lastRun: lastRunInput\(\),/g)).toHaveLength(3);
    expect(source).toContain("lastFinishedAt = Date.now();");
    expect(source).toContain("...(from?.undo ? { undo: true } : {}),");
  });
});
