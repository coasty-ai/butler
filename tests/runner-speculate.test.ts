import { describe, expect, it, vi } from "vitest";
import {
  defaultSettings,
  type Action,
  type Controller,
  type ExecutionResult,
  type Frame,
  type JournalEvent,
  type Observation,
  type ProviderResult,
  type Recorder,
  type Run,
  type Surface,
} from "../src/core/schema";
import {
  PREPARED_FRAME_MAX_AGE_MS,
  Runner,
  type RunPrelude,
} from "../src/core/runner";
import type { MemoryAccess, ReplayPlan } from "../src/core/memory";

/**
 * The first step prepared before the words are final (Runner.prepare):
 * the capture and the model's first request are made for the hypothesis
 * and held, with nothing journaled, shown or executed, until start()
 * adopts the step for the final words or discard() lets it go. What
 * qualifies a hypothesis is tested in assistant-speculate.test.ts; this is the
 * runner's part.
 */
const VSCODE = "com.microsoft.VSCode";
const SLACK = "com.tinyspeck.slackmacgap";
const NOTES = "com.apple.Notes";
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
const usage = { inputTokens: 120, outputTokens: 8, cost: 0.0004 };
const settings = { ...structuredClone(defaultSettings), memory: false };
const tick = () => new Promise((r) => setTimeout(r, 5));
const until = async (condition: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error("Timed out waiting for condition.");
    await tick();
  }
};
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

function journal() {
  const events: JournalEvent[] = [];
  const frames: Frame[] = [];
  let run: Run | undefined;
  const recorder: Recorder = {
    begin: vi.fn((r: Run) => {
      run = r;
    }),
    save: vi.fn((r: Run) => {
      run = r;
    }),
    frame: vi.fn((_id: string, f: Frame) => {
      frames.push(f);
    }),
    append: vi.fn((id: string, type: string, data = {}) => {
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
    }),
  };
  const of = (type: string) => events.filter((e) => e.type === type);
  return { recorder, events, frames, of, getRun: () => run! };
}
const frameOf = (id: string, appId: string): Frame => ({
  id,
  sha256: `sha-${id}`,
  image: "",
  geometry,
  capturedAt: 0,
  synthetic: false,
  appId,
  context: { appName: "App", windowTitle: "Window" },
});
const editor: Surface = {
  appId: VSCODE,
  pid: 7,
  secureInput: false,
  unknown: false,
  appName: "Code",
};
const noteField: Surface = {
  appId: NOTES,
  pid: 1,
  secureInput: false,
  unknown: false,
  appName: "Notes",
  focusedRole: "AXTextArea",
  focusedLabel: "Note",
};
/** A desktop whose every call is logged in order; the app in front can change. */
function desktop(o: { front?: Surface; later?: Surface } = {}) {
  const calls: string[] = [];
  let captures = 0;
  const state = { front: o.front ?? editor };
  const signals: AbortSignal[] = [];
  const controller: Controller = {
    kind: "native",
    surface: vi.fn(async (action?: Action) => {
      calls.push(action ? `surface(${action.type})` : "surface()");
      const s = state.front;
      if (action?.type === "open_app")
        return {
          ...s,
          launcherStatus: "resolved" as const,
          launcherAppId: SLACK,
          launcherName: "Slack",
          windowCount: 1,
        };
      return s;
    }),
    capture: vi.fn(async () => {
      calls.push("capture");
      return frameOf(`frame-${++captures}`, state.front.appId);
    }),
    execute: vi.fn(
      async (
        a: Action,
        _f: Frame,
        signal: AbortSignal,
      ): Promise<void | ExecutionResult> => {
        calls.push(`execute(${a.type})`);
        signals.push(signal);
        if (a.type === "open_app")
          return {
            launched: {
              appId: SLACK,
              name: "Slack",
              frontmost: true,
              wasRunning: true,
              windows: 1,
            },
          };
      },
    ),
    resume: vi.fn(async () => {
      calls.push("resume");
    }),
    stop: vi.fn(() => {
      calls.push("stop");
    }),
  };
  return {
    controller,
    calls,
    signals,
    switchTo: (s: Surface) => {
      state.front = s;
    },
  };
}
/** A model that answers from a script, or holds an answer until told. */
function scripted(
  replies: ((o: Observation) => Partial<ProviderResult>)[] = [],
  hold?: { promise: Promise<Partial<ProviderResult>> },
) {
  const observations: Observation[] = [];
  const signals: AbortSignal[] = [];
  const next = vi.fn(async (o: Observation, signal: AbortSignal) => {
    observations.push(structuredClone(o));
    signals.push(signal);
    let reply: Partial<ProviderResult> | undefined;
    if (hold && observations.length === 1) {
      reply = await Promise.race([
        hold.promise,
        new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
          if (signal.aborted) reject(new Error("aborted"));
        }),
      ]);
    } else reply = replies[observations.length - 1]?.(o);
    return {
      usage,
      ...(reply ?? {
        action: { type: "done", summary: "Done", frame_id: o.frame.id },
      }),
    } as ProviderResult;
  });
  return { next, observations, signals };
}
const openSlack = (o: Observation): Partial<ProviderResult> => ({
  action: { type: "open_app", name: "Slack", frame_id: o.frame.id },
});
const done = (o: Observation): Partial<ProviderResult> => ({
  action: { type: "done", summary: "Opened it.", frame_id: o.frame.id },
});
function setup(
  o: {
    replies?: ((o: Observation) => Partial<ProviderResult>)[];
    hold?: { promise: Promise<Partial<ProviderResult>> };
    front?: Surface;
    memory?: MemoryAccess;
    settingsPatch?: Partial<typeof settings>;
  } = {},
) {
  const j = journal();
  const desk = desktop({ front: o.front });
  const provider = scripted(o.replies, o.hold);
  const emit = vi.fn();
  const runner = new Runner(
    desk.controller,
    { next: provider.next },
    j.recorder,
    { ...settings, ...(o.memory ? { memory: true } : {}), ...o.settingsPatch },
    emit,
    [{ task: "Earlier task", status: "completed" }],
    o.memory,
  );
  return { ...j, ...desk, provider, emit, runner };
}
const slackPrelude: RunPrelude = {
  frame: frameOf("early-frame", VSCODE),
  surface: {
    ...editor,
    launcherStatus: "resolved",
    launcherAppId: SLACK,
    launcherName: "Slack",
    windowCount: 1,
  },
  action: { type: "open_app", name: "Slack", frame_id: "early-frame" },
  reason: "Open a verified installed application.",
  outcome: {
    launched: {
      appId: SLACK,
      name: "Slack",
      frontmost: true,
      wasRunning: true,
      windows: 1,
    },
  },
  completes: false,
};

describe("preparing the first step", () => {
  it("captures once and asks the model, with nothing executed, journaled or shown", async () => {
    const t = setup({ replies: [openSlack] });
    const step = t.runner.prepare("Search for cats", {
      origin: "voice",
      taskSource: "user_words",
    });
    expect(step.kind).toBe("frame");
    await step.ready;
    // The latch is lifted for the read-only capture alone and closed again.
    expect(t.calls).toEqual(["surface()", "resume", "capture", "stop"]);
    expect(t.provider.next).toHaveBeenCalledTimes(1);
    const seen = t.provider.observations[0];
    expect(seen.task).toBe("Search for cats");
    expect(seen.frame.id).toBe("frame-1");
    expect(seen.frame.context?.recentTasks).toEqual([
      { task: "Earlier task", status: "completed" },
    ]);
    expect(seen.screenshot).toEqual({ send: "full", reason: "first" });
    expect(step.kind).toBe("model");
    await until(() => step.usage !== undefined);
    // The model answered with a step: still nothing happens without the final.
    expect(t.controller.execute).not.toHaveBeenCalled();
    expect(t.emit).not.toHaveBeenCalled();
    expect(t.recorder.begin).not.toHaveBeenCalled();
    expect(t.recorder.append).not.toHaveBeenCalled();
    expect(t.recorder.frame).not.toHaveBeenCalled();
    expect(t.recorder.save).not.toHaveBeenCalled();
    expect(t.runner.settled).toBe(true);
    expect(step.code).toBeUndefined();
    expect(step.usage).toEqual(usage);
    step.discard("plan_not_start");
  });
  it("adopts the frame and the proposal for the final words and executes it through policy", async () => {
    const t = setup({ replies: [openSlack, done] });
    const step = t.runner.prepare("Search for cats", {
      origin: "voice",
      taskSource: "user_words",
    });
    await until(() => step.usage !== undefined);
    const before = t.calls.length;
    await t.runner.start("search for cats.", {
      origin: "voice",
      taskSource: "user_words",
      prepared: step,
    });
    await until(() => t.runner.settled);
    // One check that the same application is still in front, then the run:
    // no second capture before the step, no second request for it.
    expect(t.calls.slice(before)).toEqual([
      "surface()",
      "resume",
      "surface(open_app)",
      "execute(open_app)",
      "surface()",
      "capture",
      "surface(done)",
      "stop",
    ]);
    expect(t.provider.next).toHaveBeenCalledTimes(2);
    expect(t.provider.observations[1].history[0]).toMatchObject({
      type: "open_app",
      action: { type: "open_app", name: "Slack" },
    });
    const types = t.events.map((e) => e.type);
    expect(types.slice(0, 5)).toEqual([
      "RunStarted",
      "FrameCaptured",
      "ModelRequestStarted",
      "SpeculationAdopted",
      "ModelResponseReceived",
    ]);
    expect(types).toContain("PolicyAllowed");
    expect(t.of("FrameCaptured")[0].data.frame_id).toBe("frame-1");
    expect(t.frames[0].id).toBe("frame-1");
    expect(t.of("ModelRequestStarted")[0].data).toEqual({
      screenshot: "full",
      screenshotReason: "first",
      early: true,
    });
    const adopted = t.of("SpeculationAdopted")[0].data;
    expect(adopted.kind).toBe("model");
    expect(adopted.leadMs).toBeGreaterThanOrEqual(0);
    expect(adopted.savedMs).toBeGreaterThanOrEqual(0);
    expect(adopted.savedMs).toBeLessThanOrEqual(adopted.leadMs as number);
    expect(adopted.frameAgeMs).toBeGreaterThanOrEqual(0);
    expect(t.of("ActionExecuted")[0].data).toMatchObject({
      frame_id: "frame-1",
      action: { type: "open_app", name: "Slack" },
    });
    // The prepared request's cost is the run's.
    const run = t.getRun();
    expect(run.task).toBe("search for cats.");
    expect(run.usage.inputTokens).toBe(240);
    expect(run.frames).toBe(2);
    expect(run.status).toBe("completed");
    expect(t.of("SpeculationDiscarded")).toHaveLength(0);
  });
  it("waits for a proposal still in flight instead of asking again, and a stop aborts it", async () => {
    const hold = deferred<Partial<ProviderResult>>();
    const t = setup({ hold, replies: [] });
    const step = t.runner.prepare("Search for cats", { origin: "voice" });
    await step.ready;
    expect(step.kind).toBe("model");
    expect(step.usage).toBeUndefined();
    void t.runner.start("Search for cats", { origin: "voice", prepared: step });
    await until(() => t.of("SpeculationAdopted").length === 1);
    expect(t.provider.next).toHaveBeenCalledTimes(1);
    expect(t.getRun().status).toBe("thinking");
    expect(t.provider.signals[0].aborted).toBe(false);
    t.runner.stop("Stopped.");
    await until(() => t.runner.settled);
    expect(t.provider.signals[0].aborted).toBe(true);
    expect(t.controller.execute).not.toHaveBeenCalled();
    expect(t.getRun().status).toBe("cancelled");
  });
  it("takes an adopted proposal to the same approval as any model step", async () => {
    const quit = (o: Observation): Partial<ProviderResult> => ({
      action: { type: "hotkey", keys: ["CMD", "Q"], frame_id: o.frame.id },
    });
    const t = setup({
      replies: [quit, done],
      settingsPatch: { autonomy: "ask" },
    });
    const step = t.runner.prepare("Quit this app", { origin: "voice" });
    await until(() => step.usage !== undefined);
    void t.runner.start("Quit this app", { origin: "voice", prepared: step });
    await until(() => t.getRun()?.status === "confirming");
    expect(t.controller.execute).not.toHaveBeenCalled();
    expect(t.of("PolicyConfirmationRequested")[0].data).toMatchObject({
      actionType: "hotkey",
      reason: "Quit this application?",
    });
    t.runner.confirm(false);
    await until(() => t.runner.settled, 6000);
    expect(t.controller.execute).not.toHaveBeenCalled();
    expect(t.of("UserDenied").length).toBeGreaterThan(0);
  });
  it("discard aborts the request and leaves no trace; the next run starts clean", async () => {
    const hold = deferred<Partial<ProviderResult>>();
    const t = setup({ hold, replies: [done] });
    const step = t.runner.prepare("Search for cats", { origin: "voice" });
    await step.ready;
    step.discard("text_changed");
    expect(step.code).toBe("text_changed");
    expect(t.provider.signals[0].aborted).toBe(true);
    step.discard("cancelled");
    expect(step.code).toBe("text_changed");
    expect(t.recorder.begin).not.toHaveBeenCalled();
    expect(t.recorder.append).not.toHaveBeenCalled();
    expect(t.emit).not.toHaveBeenCalled();
    expect(t.runner.snapshot.run).toBeNull();
    // A run for other words: a fresh capture, a fresh request, no adoption.
    await t.runner.start("Search for dogs", { origin: "voice" });
    await until(() => t.runner.settled);
    expect(t.calls.filter((c) => c === "capture")).toHaveLength(2);
    expect(t.provider.next).toHaveBeenCalledTimes(2);
    expect(t.provider.observations[1].task).toBe("Search for dogs");
    expect(t.of("SpeculationAdopted")).toHaveLength(0);
    expect(t.of("SpeculationDiscarded")).toHaveLength(0);
    expect(t.getRun().status).toBe("completed");
  });
  it("lets a prepared step go when the run's words differ, journaling why", async () => {
    const t = setup({ replies: [openSlack, done] });
    const step = t.runner.prepare("Search for cats", { origin: "voice" });
    await until(() => step.usage !== undefined);
    await t.runner.start("Search for cats and dogs", {
      origin: "voice",
      prepared: step,
    });
    await until(() => t.runner.settled);
    expect(t.of("SpeculationDiscarded")[0].data).toEqual({
      code: "text_changed",
      kind: "model",
      usage,
    });
    expect(t.of("SpeculationAdopted")).toHaveLength(0);
    // The run captured and asked for itself; the wasted request cost it nothing.
    expect(t.calls.filter((c) => c === "capture")).toHaveLength(2);
    expect(t.provider.next).toHaveBeenCalledTimes(2);
    expect(t.provider.observations[1].task).toBe("Search for cats and dogs");
    expect(t.getRun().usage.inputTokens).toBe(120);
    expect(t.of("FrameCaptured")[0].data.frame_id).toBe("frame-2");
  });
  it("lets it go when another application came in front, or the frame grew old", async () => {
    for (const change of ["app", "age"] as const) {
      const t = setup({ replies: [done] });
      const step = t.runner.prepare("Search for cats", { origin: "voice" });
      await until(() => step.usage !== undefined);
      const now = Date.now();
      const spy =
        change === "age"
          ? vi
              .spyOn(Date, "now")
              .mockImplementation(() => now + PREPARED_FRAME_MAX_AGE_MS + 1)
          : undefined;
      if (change === "app") t.switchTo(noteField);
      try {
        await t.runner.start("Search for cats", {
          origin: "voice",
          prepared: step,
        });
        await until(() => t.runner.settled);
      } finally {
        spy?.mockRestore();
      }
      expect(t.of("SpeculationDiscarded")[0].data).toMatchObject({
        code: change === "app" ? "screen_changed" : "stale",
        kind: "model",
      });
      expect(t.of("SpeculationAdopted")).toHaveLength(0);
      expect(t.calls.filter((c) => c === "capture")).toHaveLength(2);
      expect(t.getRun().status).toBe("completed");
    }
  });
  it("never joins an early step: a prelude drops it", async () => {
    const t = setup({ replies: [done] });
    const step = t.runner.prepare("Open Slack and message Dana", {
      origin: "voice",
    });
    await until(() => step.usage !== undefined);
    await t.runner.start("Open Slack and message Dana", {
      origin: "voice",
      prepared: step,
      prelude: slackPrelude,
    });
    await until(() => t.runner.settled);
    expect(t.of("SpeculationDiscarded")[0].data).toMatchObject({
      code: "early_step",
    });
    const types = t.events.map((e) => e.type);
    expect(types.slice(0, 5)).toEqual([
      "RunStarted",
      "SpeculationDiscarded",
      "FrameCaptured",
      "ActionProposed",
      "PolicyAllowed",
    ]);
    expect(t.of("FrameCaptured")[0].data.frame_id).toBe("early-frame");
  });
  it("a start without the step, or for another preparation, lets it go", async () => {
    const t = setup({ replies: [done, done] });
    const step = t.runner.prepare("Search for cats", { origin: "voice" });
    await until(() => step.usage !== undefined);
    expect(() => t.runner.prepare("Search for dogs")).toThrow(
      "A run is already active.",
    );
    await t.runner.start("Search for cats", { origin: "voice" });
    await until(() => t.runner.settled);
    expect(step.code).toBe("superseded");
    expect(t.of("SpeculationAdopted")).toHaveLength(0);
    expect(t.of("SpeculationDiscarded")).toHaveLength(0);
    expect(t.calls.filter((c) => c === "capture")).toHaveLength(2);
    // The next run is free to prepare again.
    const again = t.runner.prepare("Search for birds", { origin: "voice" });
    await again.ready;
    expect(again.code).toBeUndefined();
    again.discard("cancelled");
    expect(t.runner.snapshot.run).toBeNull();
  });
  it("prepares the frame alone for a dictation into a focused field, and the run types it", async () => {
    const t = setup({ front: noteField });
    const step = t.runner.prepare("type hello there", {
      origin: "voice",
      taskSource: "user_words",
      dictation: "Hello there",
    });
    await step.ready;
    expect(step.kind).toBe("frame");
    expect(t.provider.next).not.toHaveBeenCalled();
    expect(t.controller.execute).not.toHaveBeenCalled();
    await t.runner.start("type hello there", {
      origin: "voice",
      taskSource: "user_words",
      dictation: "Hello there",
      prepared: step,
    });
    await until(() => t.runner.settled);
    expect(t.provider.next).not.toHaveBeenCalled();
    expect(t.of("SpeculationAdopted")[0].data).toMatchObject({
      kind: "frame",
    });
    expect(t.of("DictationStepProposed")).toHaveLength(1);
    expect(t.of("ActionExecuted")[0].data).toMatchObject({
      frame_id: "frame-1",
      action: { type: "type_text" },
    });
    expect(t.calls.filter((c) => c === "capture")).toHaveLength(1);
    expect(t.getRun().summary).toBe("Typed it.");
  });
  it("prepares the frame alone when a plan is recalled, and the plan runs on it", async () => {
    const intent: ReplayPlan = {
      id: "intent:app:slack",
      source: "intent",
      mode: "replay",
      steps: [{ action: { type: "open_app", name: "Slack" } }],
      completeWhen: { appId: SLACK },
      outline: ["Open Slack"],
    };
    const memory: MemoryAccess = {
      recall: vi.fn(async () => ({
        context: { preferences: [], episodes: [] },
        plan: intent,
      })),
      learn: vi.fn(),
    };
    const t = setup({ memory, replies: [done] });
    const step = t.runner.prepare("Open Slack", { origin: "voice" });
    await step.ready;
    expect(step.kind).toBe("frame");
    expect(memory.recall).toHaveBeenCalledTimes(1);
    expect(t.provider.next).not.toHaveBeenCalled();
    await t.runner.start("Open Slack", { origin: "voice", prepared: step });
    await until(() => t.runner.settled);
    expect(memory.recall).toHaveBeenCalledTimes(1);
    const types = t.events.map((e) => e.type);
    expect(types.slice(0, 4)).toEqual([
      "RunStarted",
      "MemoryRecalled",
      "FrameCaptured",
      "SpeculationAdopted",
    ]);
    expect(t.of("PlanStepProposed")).toHaveLength(1);
    expect(t.of("ActionExecuted")[0].data).toMatchObject({
      frame_id: "frame-1",
      action: { type: "open_app", name: "Slack" },
    });
  });
  it("gives up on a protected surface without capturing, and the run then says so itself", async () => {
    const t = setup({
      front: { ...editor, secureInput: true },
      replies: [done],
    });
    const step = t.runner.prepare("Search for cats", { origin: "voice" });
    await step.ready;
    expect(step.code).toBe("surface");
    expect(step.kind).toBe("frame");
    expect(t.controller.capture).not.toHaveBeenCalled();
    expect(t.controller.resume).not.toHaveBeenCalled();
    expect(t.provider.next).not.toHaveBeenCalled();
    expect(t.emit).not.toHaveBeenCalled();
    expect(t.recorder.begin).not.toHaveBeenCalled();
    // It stays this runner's until the final says what became of it.
    expect(() => t.runner.prepare("Search for dogs")).toThrow(
      "A run is already active.",
    );
    void t.runner.start("Search for cats", { origin: "voice", prepared: step });
    await until(() => t.getRun()?.status === "takeover");
    expect(t.of("SpeculationDiscarded")[0].data).toEqual({
      code: "surface",
      kind: "frame",
    });
    t.runner.stop();
    await until(() => t.runner.settled);
  });
  it("refuses to prepare while a run is active", async () => {
    const hold = deferred<Partial<ProviderResult>>();
    const t = setup({ hold });
    void t.runner.start("Search for cats", { origin: "voice" });
    await until(() => t.getRun()?.status === "thinking");
    expect(() => t.runner.prepare("Search for dogs")).toThrow(
      "A run is already active.",
    );
    t.runner.stop();
    await until(() => t.runner.settled);
  });
});
