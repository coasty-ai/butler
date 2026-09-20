import { describe, it, expect, vi, afterEach } from "vitest";
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
  type ScreenContext,
  type Settings,
  type Surface,
} from "../src/core/schema";
import {
  BUDGET_CONTEXT_FROM,
  LOOP_REVISITS,
  LOOP_STUCK_MESSAGE,
  LOOP_WINDOW,
  Runner,
  STUCK_PAUSE_MESSAGE,
  type StartOptions,
  TRANSITION_SETTLE_MS,
  loopWarning,
  reflectionNote,
  repetitionPeriod,
  screenKey,
} from "../src/core/runner";

/**
 * The loop breaker, the budget context and the settle rule of
 * fix/action-budget-20260919-1646: cycle 20260919-1646-09c5412 ran under
 * `--autonomy all` and 13 of 28 attempts spent their whole action budget;
 * five more were stopped while paused on "say continue with a hint", which
 * nobody at the bench can say. Every scripted sequence here is content-free:
 * action types, coordinates and fixed labels, never a task's text.
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
const settings: Settings = structuredClone(defaultSettings);
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
  const frames: Frame[] = [];
  let run: Run;
  const recorder: Recorder = {
    begin: (r) => {
      run = r;
    },
    save: (r) => {
      run = r;
    },
    frame: (_id, f) => frames.push(f),
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
  return { recorder, events, frames, of, getRun: () => run! };
}
/** A screen whose reading may change from capture to capture. */
function controller(
  overrides: Partial<Controller> = {},
  screen: (capture: number) => Partial<Frame> = () => ({}),
): Controller & { captures: () => number } {
  let captures = 0;
  return {
    kind: "native",
    surface: async () => surface,
    capture: vi.fn(async () => {
      const n = ++captures;
      return {
        id: `frame-${n}`,
        sha256: `sha-${n}`,
        image: "",
        geometry,
        capturedAt: 0,
        synthetic: false,
        appId: surface.appId,
        context: { appName: "App", windowTitle: "Window" },
        ...screen(n),
      };
    }),
    execute: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    stop: vi.fn(() => {}),
    captures: () => captures,
    ...overrides,
  };
}
/** Provider that plays scripted replies, then finishes the task. */
function scripted(
  replies: ((o: Observation) => Partial<ProviderResult> | Error)[],
) {
  const observations: Observation[] = [];
  const next = vi.fn(async (o: Observation, _signal: AbortSignal) => {
    observations.push(structuredClone(o));
    const reply = replies[observations.length - 1];
    const value = reply
      ? reply(o)
      : { action: { type: "done", summary: "Done", frame_id: o.frame.id } };
    if (value instanceof Error) throw value;
    return { usage, ...value } as ProviderResult;
  });
  return { next, observations };
}
const act =
  (action: Record<string, unknown>) =>
  (o: Observation): Partial<ProviderResult> => ({
    action: { ...action, frame_id: o.frame.id },
  });
const allowAll = () => {
  policy.evaluate = (a) =>
    a.type === "done"
      ? { kind: "ALLOW", reason: "" }
      : { kind: "ALLOW", reason: "Test." };
};
const a = act({ type: "click", x: 0.301, y: 0.5 });
const b = act({ type: "click", x: 0.7, y: 0.5 });
const c = act({ type: "click", x: 0.1, y: 0.9 });
const enter = act({ type: "key", key: "ENTER" });
/** The alternating cycle the period rule sees: warned at the fourth step, stuck at the eighth. */
const cycle = [a, b, a, b, a, b, a, b];
const settle = { transitionSettleMs: 10 };
const bench: StartOptions = { origin: "bench", taskSource: "user_words" };
const unattendedAll: Settings = {
  ...settings,
  autonomy: "all",
  autonomyAllAcknowledged: true,
};
const reflected = (o: Observation) =>
  o.history.filter((h) => h.result.includes(reflectionNote.trim())).length;

describe("the loop breaker when nobody can say continue", () => {
  it("gives a bench run one reflection step instead of pausing", async () => {
    allowAll();
    const m = memory();
    const p = scripted([...cycle]);
    const ctl = controller();
    const runner = new Runner(
      ctl,
      p,
      m.recorder,
      settings,
      () => {},
      [],
      undefined,
      settle,
    );
    await runner.start("test", bench);
    // The ninth reply is done: the run went on and completed, never paused.
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(m.of("RunPaused")).toHaveLength(0);
    expect(ctl.execute).toHaveBeenCalledTimes(8);
    expect(m.of("ActionLoopDetected").map((e) => e.data)).toEqual([
      { actionType: "click", period: 2 },
    ]);
    expect(m.of("ActionLoopBroken").map((e) => e.data)).toEqual([
      { episode: 1, outcome: "reflect" },
    ]);
    // The reflection rides on the eighth step's history line, once, and the
    // model's ninth observation is a fresh frame with it.
    const last = p.observations[8];
    expect(reflected(last)).toBe(1);
    expect(last.history.at(-1)!.result).toMatch(
      /^Executed\. Verify the next screenshot\. Stop and change course:/,
    );
    expect(last.history.at(-1)!.result).toContain("or fail with what blocks");
    expect(last.frame.id).toBe("frame-9");
  });
  it("fails the run honestly as stuck when the same loop forms again after the reflection", async () => {
    allowAll();
    const m = memory();
    const p = scripted([...cycle, a, b, a, b, a, b]);
    const ctl = controller();
    const runner = new Runner(
      ctl,
      p,
      m.recorder,
      settings,
      () => {},
      [],
      undefined,
      settle,
    );
    await runner.start("test", bench);
    expect(runner.snapshot.run?.status).toBe("failed");
    expect(runner.snapshot.run?.summary).toBe(LOOP_STUCK_MESSAGE);
    expect(runner.snapshot.message).toBe(LOOP_STUCK_MESSAGE);
    expect(m.of("RunPaused")).toHaveLength(0);
    // Eight steps to the reflection, then the cycle's four steps form it
    // again: detected at the twelfth and ended there, the two left unplayed.
    expect(ctl.execute).toHaveBeenCalledTimes(12);
    expect(m.of("ActionLoopBroken").map((e) => e.data)).toEqual([
      { episode: 1, outcome: "reflect" },
      { episode: 2, outcome: "fail" },
    ]);
    expect(m.of("RunFailed")).toHaveLength(1);
    // The one reflection step is the whole budget: no second note while the
    // loop ran on, and the run never claimed done.
    expect(reflected(p.observations.at(-1)!)).toBe(1);
    expect(m.of("RunCompleted")).toHaveLength(0);
  });
  it("gives a second episode on another signature its own reflection step", async () => {
    allowAll();
    const m = memory();
    const other = act({ type: "click", x: 0.55, y: 0.25 });
    const p = scripted([...cycle, c, other, c, other, c, other, c, other]);
    const ctl = controller();
    const runner = new Runner(
      ctl,
      p,
      m.recorder,
      settings,
      () => {},
      [],
      undefined,
      settle,
    );
    await runner.start("test", bench);
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(m.of("ActionLoopBroken").map((e) => e.data)).toEqual([
      { episode: 1, outcome: "reflect" },
      { episode: 2, outcome: "reflect" },
    ]);
    expect(ctl.execute).toHaveBeenCalledTimes(16);
  });
  it("treats a routine's replay the same way", async () => {
    allowAll();
    const m = memory();
    const p = scripted([...cycle]);
    const runner = new Runner(
      controller(),
      p,
      m.recorder,
      settings,
      () => {},
      [],
      undefined,
      settle,
    );
    await runner.start("test", { origin: "routine", taskSource: "user_words" });
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(m.of("RunPaused")).toHaveLength(0);
    expect(m.of("ActionLoopBroken").map((e) => e.data)).toEqual([
      { episode: 1, outcome: "reflect" },
    ]);
  });
  it("treats a voice run under autonomy all, acknowledged, the same way: the owner asked never to be asked", async () => {
    allowAll();
    const m = memory();
    const p = scripted([...cycle]);
    const runner = new Runner(
      controller(),
      p,
      m.recorder,
      unattendedAll,
      () => {},
      [],
      undefined,
      settle,
    );
    await runner.start("test", { origin: "voice", taskSource: "user_words" });
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(m.of("RunPaused")).toHaveLength(0);
    expect(m.of("ActionLoopBroken").map((e) => e.data)).toEqual([
      { episode: 1, outcome: "reflect" },
    ]);
  });
  it("still pauses a voice run with the owner present, and a typed one, as before", async () => {
    for (const origin of ["voice", "typed"] as const) {
      allowAll();
      const m = memory();
      const p = scripted([...cycle, a]);
      const ctl = controller();
      const runner = new Runner(
        ctl,
        p,
        m.recorder,
        settings,
        () => {},
        [],
        undefined,
        settle,
      );
      const running = runner.start("test", {
        origin,
        taskSource: "user_words",
      });
      await until(() => runner.snapshot.run?.status === "paused");
      expect(runner.snapshot.message).toBe(STUCK_PAUSE_MESSAGE);
      expect(ctl.execute).toHaveBeenCalledTimes(8);
      expect(m.of("ActionLoopBroken")).toHaveLength(0);
      expect(reflected(p.observations.at(-1)!)).toBe(0);
      await runner.resume();
      await running;
      expect(runner.snapshot.run?.status).toBe("completed");
      expect(m.of("RunPaused")).toHaveLength(1);
    }
  });
  it("pauses under autonomy all without the acknowledgement, which behaves as flow", async () => {
    allowAll();
    const m = memory();
    const p = scripted([...cycle, a]);
    const runner = new Runner(
      controller(),
      p,
      m.recorder,
      { ...settings, autonomy: "all", autonomyAllAcknowledged: false },
      () => {},
      [],
      undefined,
      settle,
    );
    const running = runner.start("test", { origin: "voice" });
    await until(() => runner.snapshot.run?.status === "paused");
    expect(runner.snapshot.message).toBe(STUCK_PAUSE_MESSAGE);
    expect(m.of("ActionLoopBroken")).toHaveLength(0);
    await runner.resume();
    await running;
  });
  it("journals the breaker's decision as codes alone", async () => {
    allowAll();
    const m = memory();
    const p = scripted([...cycle, a, b, a, b]);
    const runner = new Runner(
      controller(),
      p,
      m.recorder,
      settings,
      () => {},
      [],
      undefined,
      settle,
    );
    await runner.start("test", bench);
    for (const e of m.of("ActionLoopBroken")) {
      expect(Object.keys(e.data).sort()).toEqual(["episode", "outcome"]);
      expect(typeof e.data.episode).toBe("number");
      expect(["reflect", "fail"]).toContain(e.data.outcome);
    }
    // The stuck message names no step, no application and no text of the run.
    expect(LOOP_STUCK_MESSAGE).not.toMatch(/click|test|frame|0\.\d/);
  });
});

describe("the revisit rule", () => {
  it("calls the same step from the same screen a loop on its third time, whatever comes between", async () => {
    allowAll();
    const m = memory();
    const p = scripted([a, b, a, c, a]);
    const runner = new Runner(
      controller(),
      p,
      m.recorder,
      settings,
      () => {},
      [],
      undefined,
      settle,
    );
    await runner.start("test");
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(m.of("ActionLoopDetected").map((e) => e.data)).toEqual([
      { actionType: "click", period: 0, revisits: LOOP_REVISITS },
    ]);
    const history = p.observations[5].history;
    expect(history.map((h) => h.result.includes(loopWarning.trim()))).toEqual([
      false,
      false,
      false,
      false,
      true,
    ]);
  });
  it("sees the loop the period rule missed: one document opened again and again with a capture between", async () => {
    allowAll();
    const m = memory();
    const open = act({ type: "open_file", path: "~/OpenAssistBench/a.txt" });
    const look = act({ type: "capture" });
    // Cycle 20260919-1646 files-receipts-to-csv: open_file ×3, capture, ×3,
    // capture … to the eightieth action, every warning reset by the capture.
    const p = scripted([
      open,
      open,
      open,
      look,
      open,
      open,
      open,
      look,
      open,
      open,
      open,
      open,
    ]);
    const ctl = controller();
    const runner = new Runner(
      ctl,
      p,
      m.recorder,
      settings,
      () => {},
      [],
      undefined,
      settle,
    );
    await runner.start("test", bench);
    // Warned at the third open; the captures between neither count nor
    // forget the warning (the window still holds the opens), so the seventh
    // open is the fourth cycling step after it and the run gets its
    // reflection at the ninth step. The window starts afresh; three more
    // opens form the loop again and the run is failed at the twelfth.
    expect(m.of("ActionLoopDetected").map((e) => e.data)).toEqual([
      { actionType: "open_file", period: 0, revisits: 3 },
      { actionType: "open_file", period: 0, revisits: 3 },
    ]);
    expect(m.of("ActionLoopBroken").map((e) => e.data)).toEqual([
      { episode: 1, outcome: "reflect" },
      { episode: 2, outcome: "fail" },
    ]);
    expect(runner.snapshot.run?.status).toBe("failed");
    expect(vi.mocked(ctl.execute)).toHaveBeenCalledTimes(12);
    expect(reflected(p.observations.at(-1)!)).toBe(1);
  });
  it("sees the application ping-pong the app-switch rule missed: a click on one window, open_app of the other", async () => {
    allowAll();
    const m = memory();
    const back = act({ type: "click", x: 0.2, y: 0.3 });
    const edit = act({ type: "open_app", name: "TextEdit" });
    // Cycle 20260919-1646 routine-heartbeat-exception-only: click Safari's
    // window, open_app TextEdit, eight times over. One open_app a turn, so
    // the app-switch rule (four open_app across two applications) saw one.
    const p = scripted([
      back,
      edit,
      back,
      edit,
      back,
      edit,
      back,
      edit,
      back,
      edit,
    ]);
    const runner = new Runner(
      controller(),
      p,
      m.recorder,
      settings,
      () => {},
      [],
      undefined,
      settle,
    );
    await runner.start("test", bench);
    expect(m.of("ActionLoopDetected").map((e) => e.data)).toEqual([
      { actionType: "open_app", period: 2 },
    ]);
    expect(m.of("ActionLoopBroken").map((e) => e.data)).toEqual([
      { episode: 1, outcome: "reflect" },
    ]);
  });
  it("is no loop when the screen reads differently each time: paging with Next", async () => {
    allowAll();
    const m = memory();
    const next = act({ type: "click_control", label: "Next" });
    const ctl = controller({}, (n) => ({
      context: {
        appName: "Safari",
        windowTitle: `Listing – page ${n}`,
        browserAddress: `https://example.test/listing?page=${n}`,
        controls: [{ role: "AXLink", label: "Next", x: 0.9, y: 0.9 }],
      },
    }));
    const p = scripted([next, next, next, next, next, next, next, next, next]);
    const runner = new Runner(
      ctl,
      p,
      m.recorder,
      settings,
      () => {},
      [],
      undefined,
      settle,
    );
    await runner.start("test", bench);
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(m.of("ActionLoopDetected")).toHaveLength(0);
    expect(m.of("ActionLoopBroken")).toHaveLength(0);
    expect(ctl.execute).toHaveBeenCalledTimes(9);
  });
  it("is no loop when the page's text moves on: adding items while the total changes", async () => {
    allowAll();
    const m = memory();
    const add = act({ type: "click_control", label: "Add" });
    const ctl = controller({}, (n) => ({
      context: {
        appName: "Safari",
        windowTitle: "Shop",
        visibleText: `Basket total ${n * 3} dollars`,
      },
    }));
    const p = scripted([add, add, add, add, add]);
    const runner = new Runner(
      ctl,
      p,
      m.recorder,
      settings,
      () => {},
      [],
      undefined,
      settle,
    );
    await runner.start("test", bench);
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(m.of("ActionLoopDetected")).toHaveLength(0);
  });
  it("never trips on typing lines: text then Return, three times", async () => {
    allowAll();
    const m = memory();
    const lines = [
      act({ type: "type_text", text: "first line" }),
      enter,
      act({ type: "type_text", text: "second line" }),
      enter,
      act({ type: "type_text", text: "third line" }),
      enter,
    ];
    // What is typed shows on the screen: each capture reads more text.
    const ctl = controller({}, (n) => ({
      context: {
        appName: "TextEdit",
        windowTitle: "Untitled",
        visibleText: Array.from({ length: n }, (_, i) => `line ${i}`).join(
          "\n",
        ),
      },
    }));
    const p = scripted(lines);
    const runner = new Runner(
      ctl,
      p,
      m.recorder,
      settings,
      () => {},
      [],
      undefined,
      settle,
    );
    await runner.start("test", bench);
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(m.of("ActionLoopDetected")).toHaveLength(0);
    expect(m.of("ActionLoopBroken")).toHaveLength(0);
    expect(JSON.stringify(p.observations.at(-1)!.history)).not.toContain(
      loopWarning.trim(),
    );
    // Even a screen that shows nothing of what is typed gets advice at most:
    // the Return comes round a third time, and no step is broken or failed.
    const blind = memory();
    const q = scripted(lines);
    const blindRunner = new Runner(
      controller(),
      q,
      blind.recorder,
      settings,
      () => {},
      [],
      undefined,
      settle,
    );
    await blindRunner.start("test", bench);
    expect(blindRunner.snapshot.run?.status).toBe("completed");
    expect(blind.of("ActionLoopBroken")).toHaveLength(0);
    expect(blind.of("RunPaused")).toHaveLength(0);
    expect(blind.of("ActionLoopDetected").length).toBeLessThanOrEqual(1);
  });
  it("forgets a warning only after four fresh steps in a row", async () => {
    allowAll();
    const m = memory();
    const fresh = [0.11, 0.22, 0.33, 0.44].map((x) =>
      act({ type: "click", x, y: 0.5 }),
    );
    // A warning, four fresh steps, and the same cycle again: two warnings,
    // no reflection. With three fresh steps the second cycle would be the
    // first warning's continuation.
    const p = scripted([a, b, a, b, ...fresh, a, b, a, b]);
    const runner = new Runner(
      controller(),
      p,
      m.recorder,
      settings,
      () => {},
      [],
      undefined,
      settle,
    );
    await runner.start("test", bench);
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(m.of("ActionLoopDetected")).toHaveLength(2);
    expect(m.of("ActionLoopBroken")).toHaveLength(0);
  });
  it("keys a step by what the screen reads, never by the screenshot's hash", () => {
    const frame = (
      over: Partial<Frame> & { context?: ScreenContext },
    ): Frame => ({
      id: "f",
      sha256: "one",
      image: "",
      geometry,
      capturedAt: 0,
      synthetic: false,
      appId: "com.apple.Safari",
      context: { appName: "Safari", windowTitle: "Shop" },
      ...over,
    });
    const base = screenKey(frame({}));
    expect(base).toMatch(/^[0-9a-f]{8}$/);
    expect(screenKey(frame({ sha256: "two" }))).toBe(base);
    expect(screenKey(frame({ appId: "com.apple.TextEdit" }))).not.toBe(base);
    expect(
      screenKey(
        frame({ context: { appName: "Safari", windowTitle: "Basket" } }),
      ),
    ).not.toBe(base);
    expect(
      screenKey(
        frame({
          context: {
            appName: "Safari",
            windowTitle: "Shop",
            browserAddress: "https://example.test/basket",
          },
        }),
      ),
    ).not.toBe(base);
    expect(
      screenKey(
        frame({
          context: {
            appName: "Safari",
            windowTitle: "Shop",
            controls: [{ role: "AXButton", label: "Add", x: 0.5, y: 0.5 }],
          },
        }),
      ),
    ).not.toBe(base);
    expect(
      screenKey(frame({}), { ...surface, focusedRole: "AXTextField" }),
    ).not.toBe(base);
    // The period rule reads the signature ahead of the NUL for its exclusions.
    const scroll = JSON.stringify(["scroll", "delta_y", 5]) + "\u0000abcd1234";
    expect(repetitionPeriod([scroll, scroll, scroll, scroll])).toBe(0);
    const click =
      JSON.stringify(["click", "x", 0.3, "y", 0.5]) + "\u0000abcd1234";
    expect(repetitionPeriod([click, click, click, click])).toBe(1);
    expect(LOOP_WINDOW).toBe(12);
  });
});

describe("the actions left in the model's context", () => {
  it("appears once half of maxActions is spent, on the model's copy alone, and counts down", async () => {
    allowAll();
    const m = memory();
    const clicks = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6].map((x) =>
      act({ type: "click", x, y: 0.5 }),
    );
    const p = scripted(clicks);
    const runner = new Runner(
      controller(),
      p,
      m.recorder,
      { ...settings, maxActions: 6 },
      () => {},
      [],
      undefined,
      settle,
    );
    await runner.start("test", bench);
    expect(BUDGET_CONTEXT_FROM).toBe(0.5);
    // Observations 0..2 (0, 1, 2 actions spent) carry no budget; from the
    // fourth (3 of 6 spent) the integer counts down; the sixth action spends
    // the budget and the run ends before a seventh call.
    expect(p.observations.map((o) => o.frame.context?.budget)).toEqual([
      undefined,
      undefined,
      undefined,
      { actionsLeft: 3 },
      { actionsLeft: 2 },
      { actionsLeft: 1 },
    ]);
    expect(runner.snapshot.run?.status).toBe("failed");
    expect(runner.snapshot.message).toBe("Action budget reached.");
    // The frames of record never carry it.
    for (const f of m.frames) expect(f.context?.budget).toBeUndefined();
    expect(runner.snapshot.frame?.context?.budget).toBeUndefined();
  });
  it("is absent from a frame without screen context", async () => {
    allowAll();
    const m = memory();
    const ctl = controller({}, () => ({ context: undefined }));
    const p = scripted([a, b, c]);
    const runner = new Runner(
      ctl,
      p,
      m.recorder,
      { ...settings, maxActions: 4 },
      () => {},
      [],
      undefined,
      settle,
    );
    await runner.start("test", bench);
    for (const o of p.observations) expect(o.frame.context).toBeUndefined();
  });
});

describe("the settle after a transition", () => {
  const timeline = () => {
    const at: { event: string; t: number }[] = [];
    return {
      at,
      mark: (event: string) => at.push({ event, t: performance.now() }),
    };
  };
  it("waits after an open_url the browser was told before the next capture", async () => {
    allowAll();
    const m = memory();
    const tl = timeline();
    const ctl = controller({
      execute: vi.fn(
        async (action: Action): Promise<void | ExecutionResult> => {
          tl.mark(`execute ${action.type}`);
          if (action.type === "open_url")
            return {
              navigated: {
                host: "example.test",
                appId: "com.apple.Safari",
                via: "script",
              },
            };
        },
      ),
    });
    const capture = vi.mocked(ctl.capture);
    const inner = capture.getMockImplementation()!;
    capture.mockImplementation(async () => {
      tl.mark("capture");
      return inner();
    });
    const p = scripted([
      act({ type: "open_url", url: "https://example.test/shop" }),
    ]);
    const runner = new Runner(
      ctl,
      p,
      m.recorder,
      settings,
      () => {},
      [],
      undefined,
      {
        transitionSettleMs: 60,
      },
    );
    await runner.start("test", bench);
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(m.of("TransitionSettled").map((e) => e.data)).toEqual([
      { kind: "navigated" },
    ]);
    const executed = tl.at.find((x) => x.event === "execute open_url")!;
    const after = tl.at.filter(
      (x) => x.event === "capture" && x.t > executed.t,
    );
    expect(after).toHaveLength(1);
    expect(after[0].t - executed.t).toBeGreaterThanOrEqual(55);
    expect(ctl.captures()).toBe(2);
  });
  it("waits after a cold launch whose window is on its way, not after a warm one", async () => {
    for (const [launched, kinds] of [
      [
        {
          appId: "com.apple.Notes",
          name: "Notes",
          frontmost: true,
          wasRunning: false,
        },
        ["launched"],
      ],
      [
        {
          appId: "com.apple.Notes",
          name: "Notes",
          frontmost: true,
          wasRunning: true,
          windows: 1,
        },
        [],
      ],
      [
        {
          appId: "com.apple.Notes",
          name: "Notes",
          frontmost: false,
          wasRunning: false,
        },
        [],
      ],
    ] as const) {
      allowAll();
      const m = memory();
      const ctl = controller({
        execute: vi.fn(async (): Promise<ExecutionResult> => ({ launched })),
      });
      const p = scripted([act({ type: "open_app", name: "Notes" })]);
      const runner = new Runner(
        ctl,
        p,
        m.recorder,
        settings,
        () => {},
        [],
        undefined,
        settle,
      );
      await runner.start("test", bench);
      expect(runner.snapshot.run?.status).toBe("completed");
      expect(m.of("TransitionSettled").map((e) => e.data.kind)).toEqual(kinds);
    }
  });
  it("looks again after a click that brought another application or page up", async () => {
    allowAll();
    const m = memory();
    // The click's frame is the Finder; the capture after it shows TextEdit.
    const ctl = controller({}, (n) => ({
      appId: n === 1 ? "com.apple.finder" : "com.apple.TextEdit",
    }));
    const p = scripted([act({ type: "double_click", x: 0.5, y: 0.5 })]);
    const runner = new Runner(
      ctl,
      p,
      m.recorder,
      settings,
      () => {},
      [],
      undefined,
      settle,
    );
    await runner.start("test", bench);
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(m.of("TransitionSettled").map((e) => e.data)).toEqual([
      { kind: "switched" },
    ]);
    // One capture for the click, one that showed the switch, one after the
    // wait: the model saw the third, and no extra model call was made.
    expect(ctl.captures()).toBe(3);
    expect(p.observations[1].frame.id).toBe("frame-3");
    expect(p.next).toHaveBeenCalledTimes(2);
  });
  it("looks again when a page's host changed, and not when the same page stayed", async () => {
    for (const [hosts, kinds, captures] of [
      [["shop.test", "pay.test"], ["switched"], 3],
      [["shop.test", "shop.test"], [], 2],
    ] as const) {
      allowAll();
      const m = memory();
      const ctl = controller({}, (n) => ({
        appId: "com.apple.Safari",
        context: {
          appName: "Safari",
          windowTitle: "Page",
          browserAddress: `https://${hosts[Math.min(n, 2) - 1]}/path/${n}`,
        },
      }));
      const p = scripted([act({ type: "click_control", label: "Checkout" })]);
      const runner = new Runner(
        ctl,
        p,
        m.recorder,
        settings,
        () => {},
        [],
        undefined,
        settle,
      );
      await runner.start("test", bench);
      expect(m.of("TransitionSettled").map((e) => e.data.kind)).toEqual(kinds);
      expect(ctl.captures()).toBe(captures);
    }
  });
  it("never waits after a step that moved nothing, and defaults to three quarters of a second", async () => {
    allowAll();
    const m = memory();
    const ctl = controller();
    const p = scripted([a, b, act({ type: "type_text", text: "x" }), enter]);
    const runner = new Runner(
      ctl,
      p,
      m.recorder,
      settings,
      () => {},
      [],
      undefined,
      settle,
    );
    await runner.start("test", bench);
    expect(m.of("TransitionSettled")).toHaveLength(0);
    expect(ctl.captures()).toBe(5);
    expect(TRANSITION_SETTLE_MS).toBe(750);
  });
  it("tells the model, after a pointer click refused for changed controls, to aim by name", async () => {
    const { screenChangedResult } = await import("../src/core/runner");
    const click = { type: "click", x: 0.5, y: 0.5, frame_id: "f" } as Action;
    expect(screenChangedResult("CONTROLS_CHANGED", click)).toContain(
      "click_control(label)",
    );
    expect(
      screenChangedResult("CONTROLS_CHANGED", {
        type: "click_control",
        label: "Add",
        frame_id: "f",
      } as Action),
    ).not.toContain("Aim by name");
    expect(screenChangedResult("FOCUS_CHANGED", click)).not.toContain(
      "Aim by name",
    );
  });
});
