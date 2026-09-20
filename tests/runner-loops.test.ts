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
  CLICK_FOCUSED_NOTE,
  CLICK_NO_EFFECT_NOTE,
  DOWNLOAD_HINT,
  LOOP_REVISITS,
  LOOK_AGAIN_NOTE,
  LOOP_STUCK_MESSAGE,
  LOOP_WINDOW,
  MODEL_RESULT_CHARS,
  MODIFIER_HINT_ACTIONS,
  PAGE_SWITCHES,
  PAGE_TOOL_NOTE,
  PAGE_WINDOW,
  Runner,
  STUCK_PAUSE_MESSAGE,
  type StartOptions,
  TRANSITION_SETTLE_MS,
  actionSignature,
  downloadableClick,
  heldModifiers,
  loopWarning,
  modifierHint,
  moveKey,
  pageKey,
  pageSwitchWarning,
  readSpin,
  reflectionNote,
  repetitionPeriod,
  retracedMoves,
  screenKey,
  type PageStep,
} from "../src/core/runner";
import {
  FILES_APPEND,
  FILES_LIST,
  FILES_READ,
  FILES_TOOLS,
  fakeTools,
} from "./tool-fakes";

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

describe("a frame whose page text the helper cut short", () => {
  it("journals the stop code and the walk's counts on FrameCaptured, and nothing on a frame read whole", async () => {
    allowAll();
    const m = memory();
    const p = scripted([a]);
    // The first capture's page text was cut by wall time (the helper's
    // ScreenContext keys); the second was read whole.
    const ctl = controller({}, (n) =>
      n === 1
        ? {
            context: {
              appName: "Safari",
              windowTitle: "Site chat",
              visibleText: "line\n[page continues below; scroll to read more]",
              visibleTextTruncated: "time",
              visibleTextNodes: 212,
              visibleTextMs: 803,
            },
          }
        : {},
    );
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
    const captured = m.of("FrameCaptured").map((e) => e.data);
    expect(captured).toHaveLength(2);
    expect(captured[0]).toMatchObject({
      frame_id: "frame-1",
      textTruncated: "time",
      textNodes: 212,
      textMs: 803,
    });
    expect(captured[1].frame_id).toBe("frame-2");
    for (const key of ["textTruncated", "textNodes", "textMs"])
      expect(key in captured[1]).toBe(false);
    // The model's copy keeps the code beside the marker; the counts are not its business.
    const seen = p.observations[0].frame.context!;
    expect(seen.visibleTextTruncated).toBe("time");
  });
});

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
  it("never counts a capture as a revisit: looks between unlike steps on one screen", async () => {
    // Probe 20260919-2257, files-receipts-to-csv: the model read receipts
    // through the files tool and captured the Finder between reads; the
    // third capture from the unchanged screen was called a loop, the fifth
    // a stuck one, with the run fifteen actions in and progressing.
    allowAll();
    const m = memory();
    const look = act({ type: "capture" });
    const ctl = controller({}, () => ({
      context: {
        appName: "Finder",
        windowTitle: "Receipts",
        controls: [
          { role: "AXButton", label: "A", x: 0.1, y: 0.1 },
          { role: "AXButton", label: "B", x: 0.2, y: 0.1 },
          { role: "AXButton", label: "C", x: 0.3, y: 0.1 },
          { role: "AXButton", label: "D", x: 0.4, y: 0.1 },
        ],
      },
    }));
    const p = scripted([
      look,
      act({ type: "click_control", label: "A" }),
      look,
      act({ type: "click_control", label: "B" }),
      look,
      act({ type: "click_control", label: "C" }),
      look,
      act({ type: "click_control", label: "D" }),
      look,
    ]);
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
  });
  it("still calls captures back to back a loop, by the period rule", async () => {
    allowAll();
    const m = memory();
    const look = act({ type: "capture" });
    const ctl = controller({}, () => ({
      context: { appName: "Finder", windowTitle: "Receipts" },
    }));
    const p = scripted([look, look, look, look, look, look]);
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
    expect(m.of("ActionLoopDetected").length).toBeGreaterThan(0);
    expect(m.of("ActionLoopDetected")[0].data).toMatchObject({ period: 1 });
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

describe("read-only tool calls and the loop rules", () => {
  // Cycle 20260919-2044 files-receipts-to-csv #1 (autonomy all): the model
  // listed the folder and read receipts one at a time, and the third
  // list_directory of the same folder within twelve steps was the revisit
  // rule's loop while the run was still making progress (7 tool calls, 0
  // writes, STUCK_LOOP at 20 actions). Content-free: fixed paths.
  const FOLDER = "~/OpenAssistBench/benchnote0a1b";
  const tool = (id: string, args: Record<string, unknown>) =>
    act({ type: "tool_call", tool: id, args, finish: false });
  const list = tool(FILES_LIST.id, { path: FOLDER });
  const read = (n: number) =>
    tool(FILES_READ.id, { path: `${FOLDER}/receipt-${n}.txt` });
  const append = (n: number) =>
    tool(FILES_APPEND.id, { path: `${FOLDER}/x-expenses.csv`, text: `${n}` });
  const withTools = () => ({
    ...settle,
    tools: fakeTools({ tools: FILES_TOOLS }).access,
  });
  it("counts the same read coming round with other reads between as work, not a revisit", async () => {
    allowAll();
    const m = memory();
    // The receipts job: list, read one, list, read the next … four times
    // over, the same list_directory five times in twelve steps.
    const p = scripted([
      list,
      read(1),
      list,
      read(2),
      list,
      read(3),
      list,
      read(4),
      list,
      append(1),
    ]);
    const runner = new Runner(
      controller(),
      p,
      m.recorder,
      settings,
      () => {},
      [],
      undefined,
      withTools(),
    );
    await runner.start("test", bench);
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(m.of("ActionLoopDetected")).toHaveLength(0);
    expect(m.of("ActionLoopBroken")).toHaveLength(0);
    expect(
      p.observations
        .at(-1)!
        .history.some((h) => h.result.includes(loopWarning.trim())),
    ).toBe(false);
    expect(runner.snapshot.run?.tools).toEqual({ calls: 10, writes: 1 });
  });
  it("still calls the same read with the same arguments three times running a loop: the period rule for a spin", async () => {
    allowAll();
    const m = memory();
    const p = scripted([list, list, list, read(1)]);
    const runner = new Runner(
      controller(),
      p,
      m.recorder,
      settings,
      () => {},
      [],
      undefined,
      withTools(),
    );
    await runner.start("test", bench);
    // Warned at the third list (period 1, no revisit count), the warning on
    // its history line; the read after it is not a fourth cycling step.
    expect(m.of("ActionLoopDetected").map((e) => e.data)).toEqual([
      { actionType: "tool_call", period: 1 },
    ]);
    const history = p.observations.at(-1)!.history;
    expect(history.map((h) => h.result.includes(loopWarning.trim()))).toEqual([
      false,
      false,
      true,
      false,
    ]);
    expect(m.of("ActionLoopBroken")).toHaveLength(0);
    expect(runner.snapshot.run?.status).toBe("completed");
  });
  it("is not a spin when a write or another read comes between", async () => {
    allowAll();
    const m = memory();
    const p = scripted([list, list, append(1), list, list, read(1), list]);
    const runner = new Runner(
      controller(),
      p,
      m.recorder,
      settings,
      () => {},
      [],
      undefined,
      withTools(),
    );
    await runner.start("test", bench);
    expect(m.of("ActionLoopDetected")).toHaveLength(0);
    expect(runner.snapshot.run?.status).toBe("completed");
  });
  it("keeps a write with the same arguments a revisit, as any step", async () => {
    allowAll();
    const m = memory();
    const p = scripted([append(1), read(1), append(1), read(2), append(1)]);
    const runner = new Runner(
      controller(),
      p,
      m.recorder,
      settings,
      () => {},
      [],
      undefined,
      withTools(),
    );
    await runner.start("test", bench);
    expect(m.of("ActionLoopDetected").map((e) => e.data)).toEqual([
      { actionType: "tool_call", period: 0, revisits: LOOP_REVISITS },
    ]);
  });
  it("reads a spin off the last three signatures alone", () => {
    expect(readSpin([])).toBe(false);
    expect(readSpin(["a", "a"])).toBe(false);
    expect(readSpin(["a", "a", "a"])).toBe(true);
    expect(readSpin(["b", "a", "a", "a"])).toBe(true);
    expect(readSpin(["a", "a", "b"])).toBe(false);
    expect(readSpin(["a", "b", "a", "b"])).toBe(false);
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
  it("tells the controller a pinned run's browser on execute, and nothing on any other run", async () => {
    // Cycle 20260920-0415, home-dashboard-lights #1: the task named Safari
    // and the address went to the browser in front, the person's Chrome. A
    // run started with a browser carries it (Run.browser) and hands it to
    // execute as a fourth argument; every other run's call is unchanged.
    const safari = { name: "Safari", bundleId: "com.apple.Safari" };
    for (const browser of [safari, undefined]) {
      allowAll();
      const m = memory();
      const ctl = controller({
        execute: vi.fn(
          async (action: Action): Promise<void | ExecutionResult> =>
            action.type === "open_url"
              ? {
                  navigated: {
                    host: "example.test",
                    appId: safari.bundleId,
                    via: "open",
                  },
                }
              : undefined,
        ),
      });
      const p = scripted([
        act({ type: "open_url", url: "https://example.test/panel" }),
      ]);
      const runner = new Runner(
        ctl,
        p,
        m.recorder,
        settings,
        () => {},
        [],
        undefined,
        { transitionSettleMs: 1 },
      );
      await runner.start("test", {
        ...bench,
        ...(browser ? { browser } : {}),
      });
      expect(runner.snapshot.run?.status).toBe("completed");
      expect(runner.snapshot.run?.browser).toEqual(browser);
      const calls = vi.mocked(ctl.execute).mock.calls;
      expect(calls).toHaveLength(1);
      expect(calls[0][0].type).toBe("open_url");
      expect(calls[0].length).toBe(browser ? 4 : 3);
      expect(calls[0][3]).toEqual(browser ? { browser } : undefined);
      // The executed row names the browser the address went to (a bundle
      // id, for the diagnostics' appId), never the address or its host.
      const executed = m.of("ActionExecuted");
      expect(executed).toHaveLength(1);
      expect(executed[0].data.navigated).toEqual({ appId: safari.bundleId });
    }
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

/**
 * A click by name the helper read as no effect (native/macos/ClickEffect.swift):
 * cycle 20260919-2044-60630f0, five of eight STUCK_LOOP runs were click_control
 * repeated on an unchanged page, every step reading "Executed", the revisit
 * rule speaking on the third round. The helper now says what its reads found;
 * the runner journals it, says so in fixed words, and calls the second such
 * click from the same screen a loop at once. Fixed labels only.
 */
describe("a click by name that changed nothing", () => {
  const byName = act({ type: "click_control", label: "Next" });
  const other = act({ type: "click_control", label: "Previous" });
  const stillPointer = { effect: "none", via: "pointer" } as const;
  /** The surface names the control the way the helper does for a resolved click by name. */
  const named = async (action?: Action): Promise<Surface> =>
    action?.type === "click_control"
      ? {
          ...surface,
          controlStatus: "resolved",
          controlLabel: action.label,
          targetRole: "AXButton",
          targetLabel: action.label,
        }
      : surface;
  const runnerFor = (
    c: Controller,
    p: ReturnType<typeof scripted>,
    m: ReturnType<typeof memory>,
  ) =>
    new Runner(
      c,
      p,
      m.recorder,
      unattendedAll,
      () => {},
      [],
      undefined,
      settle,
    );
  it("journals the effect and the route, says so in fixed words, and is a loop at once the second time from the same screen", async () => {
    allowAll();
    const c = controller({
      surface: named,
      execute: vi.fn(async () => stillPointer),
    });
    const m = memory();
    const provider = scripted([byName, byName]);
    await runnerFor(c, provider, m).start("task", bench);
    const executed = m.of("ActionExecuted").map((e) => e.data);
    expect(executed).toHaveLength(2);
    for (const data of executed)
      expect(data).toMatchObject({ effect: "none", via: "pointer" });
    expect(executed[0].rung).toBeUndefined();
    // The first is a fresh step with the fixed sentence; the second, from the
    // same screen, is the loop (revisits 2, flagged) and carries the warning
    // the revisit rule used to give on the third round.
    const lines = provider.observations.map((o) => o.history.at(-1)?.result);
    expect(lines[1]).toBe(
      `Executed click on button “Next”. Verify the next screenshot.${CLICK_NO_EFFECT_NOTE}`,
    );
    expect(lines[1]).not.toContain(loopWarning.trim());
    expect(lines[2]).toBe(
      `Executed click on button “Next”. Verify the next screenshot.${CLICK_NO_EFFECT_NOTE}${loopWarning}`,
    );
    expect(m.of("ActionLoopDetected").map((e) => e.data)).toEqual([
      { actionType: "click_control", period: 0, revisits: 2, noEffect: true },
    ]);
    expect(m.of("ActionLoopBroken")).toHaveLength(0);
    expect(runner_status(m)).toBe("completed");
  });
  it("then runs the breaker as any loop: the reflection step four cycling clicks on, and an honest fail when it clicks again", async () => {
    allowAll();
    const c = controller({
      surface: named,
      execute: vi.fn(async () => stillPointer),
    });
    const m = memory();
    // Warned at the second click, stuck at the sixth (four cycling steps on)
    // with the reflection step; the seventh loops on a reflected signature
    // and ends the run. The eighth is never asked for.
    const provider = scripted(Array(8).fill(byName));
    await runnerFor(c, provider, m).start("task", bench);
    expect(runner_status(m)).toBe("failed");
    expect(m.getRun().summary).toBe(LOOP_STUCK_MESSAGE);
    expect(m.of("ActionExecuted")).toHaveLength(7);
    expect(m.of("ActionLoopDetected").map((e) => e.data)).toEqual([
      { actionType: "click_control", period: 0, revisits: 2, noEffect: true },
      { actionType: "click_control", period: 0, revisits: 7, noEffect: true },
    ]);
    expect(m.of("ActionLoopBroken").map((e) => e.data)).toEqual([
      { episode: 1, outcome: "reflect" },
      { episode: 2, outcome: "fail" },
    ]);
    expect(m.of("RunPaused")).toHaveLength(0);
    // The sixth click's line carries the reflection (the model's copy of a
    // long line is bounded, so its opening words are checked).
    expect(provider.observations[6].history.at(-1)?.result).toContain(
      "Stop and change course",
    );
    expect(provider.observations[6].history.at(-1)?.result).toContain(
      CLICK_NO_EFFECT_NOTE.trim(),
    );
  });
  it("is no loop when the click did something, when a different control is clicked, or from a different screen", async () => {
    allowAll();
    let calls = 0;
    const c = controller(
      {
        surface: named,
        execute: vi.fn(async (action: Action) =>
          action.type === "click_control" && action.label === "Next"
            ? calls++ < 2
              ? ({ effect: "changed", via: "pointer" } as const)
              : stillPointer
            : stillPointer,
        ),
      },
      // A click that changed something shows a different screen next (its
      // title here, like a page that paged); the last screen differs again.
      (n) => ({
        context: {
          appName: "App",
          windowTitle: ["A", "B", "C", "C", "D"][n - 1] ?? "E",
        },
      }),
    );
    const m = memory();
    // Two clicks that changed the screen, one on another control that did
    // not, one "Next" that did not (fresh), then the same from a new screen.
    const provider = scripted([byName, byName, other, byName, byName]);
    await runnerFor(c, provider, m).start("task", bench);
    expect(runner_status(m)).toBe("completed");
    expect(m.of("ActionLoopDetected")).toHaveLength(0);
    const lines = provider.observations.map((o) => o.history.at(-1)?.result);
    expect(lines[1]).toBe(
      "Executed click on button “Next”. Verify the next screenshot.",
    );
    expect(lines[3]).toBe(
      `Executed click on button “Previous”. Verify the next screenshot.${CLICK_NO_EFFECT_NOTE}`,
    );
    expect(lines[4]).toContain(CLICK_NO_EFFECT_NOTE.trim());
    expect(lines[5]).toContain(CLICK_NO_EFFECT_NOTE.trim());
    expect(lines[5]).not.toContain(loopWarning.trim());
    expect(m.of("ActionExecuted").map((e) => e.data.effect)).toEqual([
      "changed",
      "changed",
      "none",
      "none",
      "none",
    ]);
  });
  it("words a field that took focus, and leaves a click the helper did not read as it was", async () => {
    allowAll();
    const c = controller({
      surface: named,
      execute: vi.fn(async (action: Action) =>
        action.type === "click_control" && action.label === "Next"
          ? ({ effect: "focused", via: "press" } as const)
          : undefined,
      ),
    });
    const m = memory();
    const provider = scripted([byName, other]);
    await runnerFor(c, provider, m).start("task", bench);
    const lines = provider.observations.map((o) => o.history.at(-1)?.result);
    expect(lines[1]).toBe(
      `Executed click on button “Next”. Verify the next screenshot.${CLICK_FOCUSED_NOTE}`,
    );
    expect(lines[2]).toBe(
      "Executed click on button “Previous”. Verify the next screenshot.",
    );
    const executed = m.of("ActionExecuted").map((e) => e.data);
    expect(executed[0]).toMatchObject({ effect: "focused", via: "press" });
    expect(executed[1].effect).toBeUndefined();
    expect(executed[1].via).toBeUndefined();
    expect(m.of("ActionLoopDetected")).toHaveLength(0);
  });
  const runner_status = (m: ReturnType<typeof memory>) => m.getRun().status;
});

/**
 * A click on a link in a browser that reads as no page change may be a file
 * download: cycle 20260920-0957-bceb9cd (gpt-5.4-mini), mail-save-attachment
 * ended STUCK_LOOP three times in 17–32 actions, click_control on the
 * attachment link reading `focused` by pointer and by press alike, again and
 * again, while the server logged a fetch each time and the file lay in
 * ~/Downloads. The first such click on a control gets DOWNLOAD_HINT after the
 * click-effect note, once a run, and its row the flag; a button, a link that
 * changed the page, or a link outside a browser never does. Fixed labels only.
 */
describe("a link click in a browser that changed nothing on the page", () => {
  const onLink = act({ type: "click_control", label: "Invoice" });
  const onButton = act({ type: "click_control", label: "Send" });
  const roles: Record<string, string> = { Invoice: "AXLink", Send: "AXButton" };
  /** The surface names the control the way the helper does, in Safari. */
  const inBrowser = async (action?: Action): Promise<Surface> => ({
    ...surface,
    appId: "com.apple.Safari",
    ...(action?.type === "click_control"
      ? {
          controlStatus: "resolved" as const,
          controlLabel: action.label,
          targetRole: roles[action.label] ?? "AXButton",
          targetLabel: action.label,
        }
      : {}),
  });
  /** The frame shows a page in Safari. */
  const page = () => ({
    appId: "com.apple.Safari",
    context: {
      appName: "Safari",
      windowTitle: "Inbox",
      browserAddress: "https://mail.example.test/inbox",
    },
  });
  const linkLine =
    "Executed click on link “Invoice”. Verify the next screenshot.";
  const runnerFor = (
    c: Controller,
    p: ReturnType<typeof scripted>,
    m: ReturnType<typeof memory>,
  ) =>
    new Runner(
      c,
      p,
      m.recorder,
      unattendedAll,
      () => {},
      [],
      undefined,
      settle,
    );
  const flags = (m: ReturnType<typeof memory>) =>
    m.of("ActionExecuted").map((e) => e.data.downloadHint);
  it("says so once for a link that only took focus, flags the row, and leaves the retry with the click-effect note alone", async () => {
    allowAll();
    const c = controller(
      {
        surface: inBrowser,
        execute: vi.fn(
          async () => ({ effect: "focused", via: "pointer" }) as const,
        ),
      },
      page,
    );
    const m = memory();
    const provider = scripted([onLink, onLink]);
    await runnerFor(c, provider, m).start("task", bench);
    const lines = provider.observations.map((o) => o.history.at(-1)?.result);
    expect(lines[1]).toBe(`${linkLine}${CLICK_FOCUSED_NOTE}${DOWNLOAD_HINT}`);
    expect(lines[2]).toBe(`${linkLine}${CLICK_FOCUSED_NOTE}`);
    expect(flags(m)).toEqual([true, undefined]);
    for (const data of m.of("ActionExecuted").map((e) => e.data))
      expect(data).toMatchObject({ effect: "focused", via: "pointer" });
    expect(m.of("ActionLoopDetected")).toHaveLength(0);
    expect(m.getRun().status).toBe("completed");
  });
  it("puts the hint after the no-effect sentence for a link read as none, gives a button beside it none, and keeps the line under the model's cap with the loop warning", async () => {
    allowAll();
    const c = controller(
      {
        surface: inBrowser,
        execute: vi.fn(async (action: Action) =>
          action.type === "click_control" && action.label === "Invoice"
            ? ({ effect: "none", via: "press" } as const)
            : ({ effect: "focused", via: "pointer" } as const),
        ),
      },
      page,
    );
    const m = memory();
    const provider = scripted([onLink, onButton]);
    await runnerFor(c, provider, m).start("task", bench);
    const lines = provider.observations.map((o) => o.history.at(-1)?.result);
    expect(lines[1]).toBe(`${linkLine}${CLICK_NO_EFFECT_NOTE}${DOWNLOAD_HINT}`);
    expect(lines[2]).toBe(
      `Executed click on button “Send”. Verify the next screenshot.${CLICK_FOCUSED_NOTE}`,
    );
    expect(flags(m)).toEqual([true, undefined]);
    // The sentence's bound, and the line's with every note that can share it
    // on a first hint: the no-effect sentence (200) and the loop warning
    // (192) beside the hint (183) leave the line at 635 of 640, so the model
    // reads it whole; with the focus sentence in place of the no-effect one
    // it is 453.
    expect(DOWNLOAD_HINT.startsWith(" ")).toBe(true);
    expect(DOWNLOAD_HINT.trim().length).toBeLessThanOrEqual(200);
    expect(DOWNLOAD_HINT.length).toBe(183);
    expect(
      `${linkLine}${CLICK_NO_EFFECT_NOTE}${DOWNLOAD_HINT}${loopWarning}`.length,
    ).toBeLessThanOrEqual(MODEL_RESULT_CHARS);
    expect(
      `${linkLine}${CLICK_FOCUSED_NOTE}${DOWNLOAD_HINT}${loopWarning}`.length,
    ).toBeLessThanOrEqual(MODEL_RESULT_CHARS);
    expect(lines[1]!.length).toBeLessThan(MODEL_RESULT_CHARS);
  });
  it("gives no hint to a link whose click changed the page", async () => {
    allowAll();
    const c = controller(
      {
        surface: inBrowser,
        execute: vi.fn(
          async () => ({ effect: "changed", via: "pointer" }) as const,
        ),
      },
      page,
    );
    const m = memory();
    const provider = scripted([onLink]);
    await runnerFor(c, provider, m).start("task", bench);
    expect(provider.observations[1].history.at(-1)?.result).toBe(linkLine);
    expect(flags(m)).toEqual([undefined]);
  });
  it("gives no hint to a link outside a browser: the no-effect sentence alone", async () => {
    allowAll();
    const elsewhere = async (action?: Action): Promise<Surface> => ({
      ...(await inBrowser(action)),
      appId: surface.appId,
    });
    // The frame is the default application's, with no page address.
    const c = controller({
      surface: elsewhere,
      execute: vi.fn(async () => ({ effect: "none", via: "pointer" }) as const),
    });
    const m = memory();
    const provider = scripted([onLink]);
    await runnerFor(c, provider, m).start("task", bench);
    expect(provider.observations[1].history.at(-1)?.result).toBe(
      `${linkLine}${CLICK_NO_EFFECT_NOTE}`,
    );
    expect(flags(m)).toEqual([undefined]);
  });
  it("downloadableClick: a link by AXLink or by its plain role, in a browser by application or by page, read focused or none; nothing else", () => {
    const frame = {
      id: "f",
      sha256: "s",
      image: "",
      geometry,
      capturedAt: 0,
      synthetic: false,
      appId: "com.example.app",
      context: { appName: "App", windowTitle: "W" },
    } as Frame;
    const onPage = {
      ...frame,
      context: { ...frame.context, browserAddress: "https://example.test/a" },
    } as Frame;
    const byName = {
      type: "click_control",
      label: "L",
      frame_id: "f",
    } as Action;
    const byPoint = { type: "click", x: 0.5, y: 0.5, frame_id: "f" } as Action;
    const link = (role: string, appId = "com.apple.Safari"): Surface => ({
      ...surface,
      appId,
      targetRole: role,
      targetLabel: "L",
    });
    const focused = { effect: "focused" } as const;
    const none = { effect: "none" } as const;
    // The link, by either role spelling and either click, on either reading.
    expect(downloadableClick(byName, link("AXLink"), frame, focused)).toBe(
      true,
    );
    expect(downloadableClick(byName, link("link"), frame, none)).toBe(true);
    expect(downloadableClick(byPoint, link("AXLink"), frame, none)).toBe(true);
    // A browser by the frame's page when the surface's application is not one.
    expect(
      downloadableClick(
        byName,
        link("AXLink", "com.example.app"),
        onPage,
        focused,
      ),
    ).toBe(true);
    expect(
      downloadableClick(
        byName,
        link("AXLink", "com.example.app"),
        frame,
        focused,
      ),
    ).toBe(false);
    // Not a link.
    for (const role of [
      "AXButton",
      "AXTextField",
      "AXRadioButton",
      "AXImage",
      "",
    ])
      expect(downloadableClick(byName, link(role), frame, none)).toBe(false);
    // Read as a change, unverifiable, or not read.
    expect(
      downloadableClick(byName, link("AXLink"), frame, { effect: "changed" }),
    ).toBe(false);
    expect(
      downloadableClick(byName, link("AXLink"), frame, {
        effect: "unverifiable",
      }),
    ).toBe(false);
    expect(downloadableClick(byName, link("AXLink"), frame, {})).toBe(false);
    expect(downloadableClick(byName, link("AXLink"), frame, undefined)).toBe(
      false,
    );
    // Not a click.
    expect(
      downloadableClick(
        { type: "right_click", x: 0.5, y: 0.5, frame_id: "f" } as Action,
        link("AXLink"),
        frame,
        none,
      ),
    ).toBe(false);
  });
});

/**
 * The page-switch rule (trackPageSwitch): market shards 2/3 at abc24ae and
 * 3/3 at c8c9e10 (gpt-5.4-mini, autonomy all), ops-crm-data-entry #2 (52
 * actions, the budget) and #1 (24, STUCK_LOOP), research-compare-to-csv #2
 * and #3 in both shards (24-32 actions, the note never written) and
 * ops-support-ticket-draft #3 (60): click_control alternating between a
 * link on one page and one on the other, every click "changed", History >
 * Back and open_url between, the values never carried. Market 1/3 at
 * 55e4e83, shop-cart-within-budget #1 (64 actions, the budget): the shop,
 * its "Added" page and the basket round and round by another row's "Add to
 * basket" each time and the same "Back to the shop", warned twice for the
 * returns alone; a bounce is warned only when its moves retrace the same
 * controls. Every page here is a synthetic title on a loopback address;
 * every label a fixed word.
 */
/**
 * A modifier the session reports held (ScreenContext.modifiers: the helper's
 * read of the keyboard's state at capture). Live 2026-09-20: from 05:37 PT
 * every type_text into a Safari field lost its text while the field's click
 * read focused and the per-character focus check stayed silent
 * (checkin-flight-seat 3/3 -> 0/4, booking 3/3 -> 0/4); at 12:15 PT the
 * session's flags state read Fn held with the owner away, so each nil-source
 * key event had gone out as Globe+<char>. The helper now posts every event
 * with explicit flags; the runner tells the model once per held set, on the
 * first type_text, key or click under it, and never releases a key. Fixed
 * words only.
 */
describe("a frame that reports a modifier held", () => {
  const typing = act({ type: "type_text", text: "ab12" });
  const click = act({ type: "click", x: 0.5, y: 0.5 });
  const scroll = act({
    type: "scroll",
    x: 0.5,
    y: 0.5,
    delta_x: 0,
    delta_y: 100,
  });
  /** A frame whose context reports the given modifiers held (none when undefined). */
  const reporting =
    (held: (capture: number) => ScreenContext["modifiers"]) =>
    (capture: number) => ({
      context: {
        appName: "Safari",
        windowTitle: "Form",
        ...(held(capture) ? { modifiers: held(capture) } : {}),
      },
    });
  const runnerFor = (
    c: Controller,
    p: ReturnType<typeof scripted>,
    m: ReturnType<typeof memory>,
  ) =>
    new Runner(
      c,
      p,
      m.recorder,
      unattendedAll,
      () => {},
      [],
      undefined,
      settle,
    );
  const fnLine = modifierHint(["fn"]);
  const results = (p: ReturnType<typeof scripted>) =>
    p.observations.map((o) => o.history.at(-1)?.result ?? "");
  it("adds the sentence once to the first input step under a held fn, not to the key or click after it, and journals the frame's modifiers", async () => {
    allowAll();
    const c = controller(
      {},
      reporting(() => ["fn"]),
    );
    const m = memory();
    const provider = scripted([typing, enter, click]);
    await runnerFor(c, provider, m).start("task", bench);
    const lines = results(provider);
    expect(lines[1].endsWith(fnLine)).toBe(true);
    expect(lines[1].startsWith("Executed")).toBe(true);
    expect(lines[2]).not.toContain(fnLine.trim());
    expect(lines[3]).not.toContain(fnLine.trim());
    expect(
      provider.observations
        .at(-1)!
        .history.filter((h) => h.result.includes(fnLine.trim())),
    ).toHaveLength(1);
    expect(m.of("FrameCaptured").map((e) => e.data.modifiers)).toEqual(
      m.of("FrameCaptured").map(() => ["fn"]),
    );
    expect(m.of("FrameCaptured").length).toBeGreaterThanOrEqual(3);
    // The runner hands the provider the frame whole; the model's copy loses
    // the list in trimScreenContext (tests/context.test.ts): the line speaks.
    for (const o of provider.observations)
      expect(o.frame.context?.modifiers).toEqual(["fn"]);
    expect(m.getRun().status).toBe("completed");
    expect(fnLine).toBe(
      " The keyboard reports fn held down (the system, not this run); if typing or clicks misbehave, ask the user to press and release that key.",
    );
  });
  it("says nothing when the frame reports none held or Caps Lock alone; an empty report puts nothing on the row, Caps Lock still shows there", async () => {
    allowAll();
    for (const held of [undefined, [], ["capslock"]] as const) {
      const c = controller(
        {},
        reporting(() => (held ? [...held] : undefined)),
      );
      const m = memory();
      const provider = scripted([typing, enter]);
      await runnerFor(c, provider, m).start("task", bench);
      for (const line of results(provider))
        expect(line).not.toContain("held down");
      // A toggle that changes no posted event earns no line, but the trace
      // keeps the reading; no report and an empty one put nothing there.
      for (const e of m.of("FrameCaptured"))
        if (held?.length) expect(e.data.modifiers).toEqual([...held]);
        else expect(e.data).not.toHaveProperty("modifiers");
      expect(m.getRun().status).toBe("completed");
    }
  });
  it("names a second held set once in its own words, leaves a scroll alone, and keeps the line under the model's cap", async () => {
    allowAll();
    // Captures 1 and 2 report fn; from the third the session also holds
    // Shift: a new set, told once; the fourth typing under it reads plain.
    const c = controller(
      {},
      reporting((n) => (n <= 2 ? ["fn"] : ["shift", "fn"])),
    );
    const m = memory();
    const provider = scripted([typing, scroll, typing, typing]);
    await runnerFor(c, provider, m).start("task", bench);
    const lines = results(provider);
    const both = modifierHint(["fn", "shift"]);
    expect(lines[1].endsWith(fnLine)).toBe(true);
    expect(lines[2]).not.toContain("held down");
    expect(lines[3].endsWith(both)).toBe(true);
    expect(lines[4]).not.toContain("held down");
    expect(both).toContain("fn and shift held down");
    expect(both.endsWith("those keys.")).toBe(true);
    expect(m.of("FrameCaptured").map((e) => e.data.modifiers)).toEqual([
      ["fn"],
      ["fn"],
      ["shift", "fn"],
      ["shift", "fn"],
      ["shift", "fn"],
    ]);
    // The bound: the sentence under 160 for one word, and the typed step's
    // line with it and the loop warning within the model's 640.
    expect(fnLine.startsWith(" ")).toBe(true);
    expect(fnLine.trim().length).toBeLessThanOrEqual(160);
    expect(lines[1].length + loopWarning.length).toBeLessThanOrEqual(
      MODEL_RESULT_CHARS,
    );
    expect(m.getRun().status).toBe("completed");
  });
  it("reads the held set in the fixed order, once each, without Caps Lock, and hints the six input steps alone", () => {
    expect(heldModifiers(["capslock", "shift", "fn", "fn", "Globe"])).toEqual([
      "fn",
      "shift",
    ]);
    expect(heldModifiers([])).toEqual([]);
    expect(heldModifiers(["capslock"])).toEqual([]);
    expect(modifierHint([])).toBe("");
    expect(modifierHint(["capslock"])).toBe("");
    expect(modifierHint(["control", "command", "option"])).toContain(
      "command, option and control held down",
    );
    for (const type of [
      "type_text",
      "key",
      "click",
      "click_control",
      "double_click",
      "right_click",
    ])
      expect(MODIFIER_HINT_ACTIONS.has(type)).toBe(true);
    for (const type of ["scroll", "hotkey", "capture", "done", "open_app"])
      expect(MODIFIER_HINT_ACTIONS.has(type)).toBe(false);
  });
});
describe("the page-switch rule", () => {
  const page = (name: string): ScreenContext => ({
    appName: "Browser",
    windowTitle: `Page ${name}`,
    browserAddress: `http://127.0.0.1:8080/${name.toLowerCase()}`,
  });
  const A = page("A");
  const B = page("B");
  const C = page("C");
  const D = page("D");
  /**
   * The page each capture shows, in order; step n executes on capture n. The
   * last one holds. Each capture reads a little differently (its text), as
   * a live page does, so the same click from a page is no revisit and no
   * cycle to the loop rule, and only the page rule speaks.
   */
  const showing = (
    order: ScreenContext[],
    overrides: Partial<Controller> = {},
  ) =>
    controller(overrides, (n) => ({
      context: {
        ...order[Math.min(n, order.length) - 1],
        visibleText: `reading ${n}`,
      },
    }));
  /** A click by name with the model's position hint: the same control each time it is used. */
  const named = (label: string, x: number, y: number) =>
    act({ type: "click_control", label, x, y });
  /** The controls of a bounce: X on page A, Y on page B, Z and W elsewhere. */
  const X = named("Link X", 0.32, 0.14);
  const Y = named("Link Y", 0.42, 0.42);
  const Z = named("Link Z", 0.5, 0.5);
  const W = named("Link W", 0.6, 0.6);
  /** The shop's "Add" buttons: one name, another row each time; and the one way back. */
  const add = (row: number) => named("Add", 0.49, 0.33 + row * 0.07);
  const back = named("Back", 0.35, 0.45);
  /** Clicks by name, each with its own label. */
  const clicks = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      act({ type: "click_control", label: `Link ${i + 1}` }),
    );
  const run = async (
    ctl: ReturnType<typeof controller>,
    steps: ReturnType<typeof act>[],
    extras: ConstructorParameters<typeof Runner>[7] = settle,
  ) => {
    allowAll();
    const m = memory();
    const p = scripted(steps);
    const runner = new Runner(
      ctl,
      p,
      m.recorder,
      settings,
      () => {},
      [],
      undefined,
      extras,
    );
    await runner.start("test", bench);
    expect(runner.snapshot.run?.status).toBe("completed");
    // Each step's line, off the history the next observation carried (the
    // model's copy keeps the last six whole; the newest is always whole).
    const lines = p.observations.slice(1).map((o) => o.history.at(-1)!.result);
    return { m, lines, ctl };
  };
  const warned = (lines: string[]) =>
    lines.map((l) => l.includes(pageSwitchWarning));
  const events = (m: ReturnType<typeof memory>) =>
    m.of("ActionLoopDetected").map((e) => e.data);
  /** The rule's event for a bounce among `pages` pages whose moves retraced one control once. */
  const bounce = (pages: number, actionType = "click_control") => ({
    actionType,
    period: 0,
    pages,
    repeatedMoves: 1,
  });

  it("warns once on the fourth click when the run bounces A B A B by the same two controls, and journals the counts of pages and retraced moves", async () => {
    const { m, lines, ctl } = await run(showing([A, B, A, B, A]), [X, Y, X, Y]);
    expect(ctl.execute).toHaveBeenCalledTimes(4);
    expect(warned(lines)).toEqual([false, false, false, true]);
    expect(lines[3].endsWith(pageSwitchWarning)).toBe(true);
    expect(events(m)).toEqual([bounce(2)]);
    // Advice, never a loop: no breaker, no loop warning, no pause.
    expect(m.of("ActionLoopBroken")).toHaveLength(0);
    expect(m.of("RunPaused")).toHaveLength(0);
    expect(lines.some((l) => l.includes(loopWarning.trim()))).toBe(false);
  });
  it("stays quiet for the shop: another row's Add from the shop each time and the same Back from the basket, however long it goes on", async () => {
    // A B A B A B A B A: the same two pages, the same way back every time,
    // and a different button forward every time. A single repeated return
    // is not the pair; the forward moves are work.
    const shop = await run(showing([A, B, A, B, A, B, A, B, A]), [
      add(0),
      back,
      add(1),
      back,
      add(2),
      back,
      add(3),
      back,
    ]);
    expect(warned(shop.lines)).toEqual(Array(8).fill(false));
    expect(events(shop.m)).toEqual([]);
    // The rows added by clicks at their positions, each landing on a button
    // named "Add": the loop rule reads them as one step by that name, the
    // page rule tells the rows apart by where each click landed.
    const raw = (row: number) =>
      act({ type: "click", x: 0.49, y: 0.33 + row * 0.07 });
    const byPosition = await run(
      showing([A, B, A, B, A, B, A], {
        surface: async () => ({
          ...surface,
          targetRole: "AXButton",
          targetLabel: "Add",
        }),
      }),
      [raw(0), back, raw(1), back, raw(2), back],
    );
    expect(warned(byPosition.lines)).toEqual(Array(6).fill(false));
    expect(events(byPosition.m)).toEqual([]);
  });
  it("warns on the fourth step when the first control moves again over a single return, and not once the returns are known to differ", async () => {
    // X Y1 X: on the fourth step this reads as the CRM shape (the nav link
    // clicked again with one return between) and is warned like X Y X.
    const crm = await run(showing([A, B, A, B, A]), [X, Y, X, W]);
    expect(warned(crm.lines)).toEqual([false, false, false, true]);
    expect(events(crm.m)).toEqual([bounce(2)]);
    // Y1 X Y2 X: two controls on the way from B to A is work on B, whatever
    // X does from A.
    const known = await run(showing([B, A, B, A, B]), [Y, X, W, X]);
    expect(warned(known.lines)).toEqual([false, false, false, false]);
    expect(events(known.m)).toEqual([]);
  });
  it("sees the bounce with a look between each move, and a third page in the round", async () => {
    // A B B A A B B A A B: a click moves, a capture looks at where it
    // landed. The third move is seen by the look on B (the sixth step), and
    // a look after a move is no stay, so the bounce going on is warned once.
    const look = act({ type: "capture" });
    const between = await run(showing([A, B, B, A, A, B, B, A, A, B, B]), [
      X,
      look,
      Y,
      look,
      X,
      look,
      Y,
      look,
      X,
      look,
    ]);
    expect(warned(between.lines)).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
      false,
      false,
      false,
      false,
    ]);
    expect(between.lines[5].startsWith("Executed")).toBe(true);
    expect(events(between.m)).toEqual([bounce(2, "capture")]);
    // A B C A B: the listing, a lead, the form, and round again by the
    // same three controls.
    const three = await run(showing([A, B, C, A, B, C]), [X, Y, Z, X, Y]);
    expect(warned(three.lines)).toEqual([false, false, false, false, true]);
    expect(events(three.m)).toEqual([bounce(3)]);
  });
  it("stays quiet when every step lands on a new page (paging), on one page (the revisit rule's business), or between a listing and its items", async () => {
    const paging = await run(showing([A, B, C, D, A]), [X, Y, Z, W]);
    expect(warned(paging.lines)).toEqual([false, false, false, false]);
    expect(events(paging.m)).toEqual([]);
    const staying = await run(showing([A]), [X, Y, X, Y]);
    expect(warned(staying.lines)).toEqual([false, false, false, false]);
    expect(events(staying.m)).toEqual([]);
    // The same click from one unchanged page three times over is the
    // revisit rule's loop, with no page count on its event and no page
    // sentence.
    const same = act({ type: "click_control", label: "Same" });
    const revisit = await run(
      controller({}, () => ({ context: A })),
      [same, same, same],
    );
    expect(events(revisit.m)).toEqual([
      { actionType: "click_control", period: 0, revisits: LOOP_REVISITS },
    ]);
    expect(warned(revisit.lines)).toEqual([false, false, false]);
    // A listing and its items: A B A C A D A, four pages, one revisited,
    // by the same two controls throughout.
    const hub = await run(showing([A, B, A, C, A, D, A, A]), [
      X,
      Y,
      X,
      Y,
      X,
      Y,
      X,
    ]);
    expect(warned(hub.lines)).toEqual(Array(7).fill(false));
    expect(events(hub.m)).toEqual([]);
    // Each page reached by its own link: the pages recur, no control does.
    const links = await run(showing([A, B, A, B, A]), clicks(4));
    expect(warned(links.lines)).toEqual([false, false, false, false]);
    expect(events(links.m)).toEqual([]);
  });
  it("warns again for a fresh bounce once the run stayed on one page for two steps, and once while a bounce goes on", async () => {
    // Three moves warn on the fourth step; two clicks on the page it landed
    // on end the bounce; the next three moves are a fresh one, warned on
    // the step that completes the third.
    const fresh = await run(showing([A, B, A, B, A, A, A, B, A, B, A]), [
      X,
      Y,
      X,
      Y,
      W,
      W,
      X,
      Y,
      X,
      Y,
    ]);
    expect(warned(fresh.lines)).toEqual([
      false,
      false,
      false,
      true,
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
    expect(events(fresh.m)).toEqual([bounce(2), bounce(2)]);
    // Bouncing on without a stop is warned about once.
    const on = await run(showing([A, B, A, B, A, B, A, B, A]), [
      X,
      Y,
      X,
      Y,
      X,
      Y,
      X,
      Y,
    ]);
    expect(warned(on.lines)).toEqual([
      false,
      false,
      false,
      true,
      false,
      false,
      false,
      false,
    ]);
    expect(events(on.m)).toHaveLength(1);
  });
  it("records a tool step's page and never puts the sentence on its line", async () => {
    // A B A, a read through the files tool on B, a click on B, back to A:
    // the tool step's page completes the third move, its line carries no
    // sentence, and the click on B after it does. The tool step acted on
    // no control: the move off B is Y's, the click's.
    const read = act({
      type: "tool_call",
      tool: FILES_READ.id,
      args: { path: "~/OpenAssistBench/benchnote0a1b/receipt-1.txt" },
      finish: false,
    });
    const { m, lines } = await run(
      showing([A, B, A, B, B, A, B]),
      [X, Y, X, read, Y, X],
      { ...settle, tools: fakeTools({ tools: FILES_TOOLS }).access },
    );
    expect(warned(lines)).toEqual([false, false, false, false, true, false]);
    expect(events(m)).toEqual([bounce(2)]);
  });
  it("keeps a look's line under the model's cap with the page tool note, the loop warning and the page-switch warning", () => {
    const look = "Executed. Verify the next screenshot.";
    expect(
      (look + PAGE_TOOL_NOTE + loopWarning + pageSwitchWarning).length,
    ).toBeLessThanOrEqual(MODEL_RESULT_CHARS);
    expect(
      (look + LOOK_AGAIN_NOTE + loopWarning + pageSwitchWarning).length,
    ).toBeLessThanOrEqual(MODEL_RESULT_CHARS);
    expect(pageSwitchWarning).toHaveLength(190);
    expect(pageSwitchWarning.startsWith(" Warning: ")).toBe(true);
    expect(PAGE_WINDOW).toBe(8);
    expect(PAGE_SWITCHES).toBe(3);
  });
  it("puts each move down to the control that made it and counts the moves that retrace one", () => {
    const s = (page: string, by?: string, look = false): PageStep => ({
      page,
      look,
      ...(by ? { by } : {}),
    });
    // A B A B by X from A and Y from B: the third move is X's second; on
    // with Y's second it is two.
    expect(
      retracedMoves([s("a", "x"), s("b", "y"), s("a", "x"), s("b", "y")]),
    ).toBe(1);
    expect(
      retracedMoves([
        s("a", "x"),
        s("b", "y"),
        s("a", "x"),
        s("b", "y"),
        s("a", "x"),
      ]),
    ).toBe(2);
    // The shop: another Add from A each time, the same Back from B, is no
    // retrace, however many returns.
    expect(
      retracedMoves([
        s("a", "add1"),
        s("b", "back"),
        s("a", "add2"),
        s("b", "back"),
        s("a", "add3"),
        s("b", "back"),
      ]),
    ).toBe(0);
    // A B C A B by X, Y, Z and X again.
    expect(
      retracedMoves([
        s("a", "x"),
        s("b", "y"),
        s("c", "z"),
        s("a", "x"),
        s("b", "y"),
      ]),
    ).toBe(1);
    // A look after a click is the click's page still loading: the move is
    // the click's, and the looks that follow the arrival are no move.
    expect(
      retracedMoves([
        s("a", "x"),
        s("a", undefined, true),
        s("b", undefined, true),
        s("b", "y"),
        s("a", undefined, true),
        s("a", "x"),
        s("b", undefined, true),
      ]),
    ).toBe(1);
    // A tool step acted on no control: the move off its page is the last
    // click's on that page.
    expect(
      retracedMoves([
        s("a", "x"),
        s("b", "y"),
        s("a", "x"),
        s("b"),
        s("b", "y"),
        s("a", "x"),
      ]),
    ).toBe(2);
    // A move nothing in the window explains (its visit held only a look) is
    // no retrace, whatever follows.
    expect(
      retracedMoves([
        s("a", undefined, true),
        s("b", "y"),
        s("a", "x"),
        s("b", "y"),
        s("a", "x"),
      ]),
    ).toBe(0);
    // One control both ways is a retrace as much as two.
    expect(
      retracedMoves([s("a", "t"), s("b", "t"), s("a", "t"), s("b", "t")]),
    ).toBe(2);
    // Nothing moved; every move by a new control.
    expect(retracedMoves([s("a", "x"), s("a", "y")])).toBe(0);
    expect(
      retracedMoves([s("a", "x"), s("b", "y"), s("c", "z"), s("d", "w")]),
    ).toBe(0);
  });
  it("keys a move by the loop rule's signature with the pointer's position kept", () => {
    const target = { role: "AXButton", label: "Add" };
    const row1 = { type: "click", x: 0.49, y: 0.33, frame_id: "f" } as Action;
    const row2 = { type: "click", x: 0.49, y: 0.4, frame_id: "f" } as Action;
    // Two clicks landing on buttons of one name: one step to the loop rule,
    // two controls to the page rule.
    expect(actionSignature(row1, target)).toBe(actionSignature(row2, target));
    expect(moveKey(row1, target)).not.toBe(moveKey(row2, target));
    expect(moveKey(row1, target)).toBe(
      `${actionSignature(row1, target)}@0.49,0.33`,
    );
    // The model's hint on a click by name, rounded as the signature rounds
    // it; a key press has no position.
    const hinted = {
      type: "click_control",
      label: "Add",
      x: 0.489,
      y: 0.403,
      frame_id: "f",
    } as Action;
    expect(moveKey(hinted)).toBe(`${actionSignature(hinted)}@0.49,0.4`);
    expect(moveKey(hinted)).toBe(
      moveKey({ ...hinted, x: 0.491, y: 0.398 } as Action),
    );
    const key = { type: "key", key: "ENTER", frame_id: "f" } as Action;
    expect(moveKey(key)).toBe(actionSignature(key));
  });
  it("keys a page by application, title and address path, never its query, controls or screenshot", () => {
    const frame = (
      over: Partial<Frame> & { context?: ScreenContext },
    ): Frame => ({
      id: "f",
      sha256: "one",
      image: "",
      geometry,
      capturedAt: 0,
      synthetic: false,
      appId: "com.example.browser",
      context: {
        appName: "Browser",
        windowTitle: "Listing",
        browserAddress: "http://127.0.0.1:8080/listing?page=1",
      },
      ...over,
    });
    const context = frame({}).context!;
    const base = pageKey(frame({}));
    expect(base).toMatch(/^[0-9a-f]{8}$/);
    expect(pageKey(frame({ sha256: "two" }))).toBe(base);
    expect(
      pageKey(
        frame({
          context: {
            ...context,
            browserAddress: "http://127.0.0.1:8080/listing?page=2",
          },
        }),
      ),
    ).toBe(base);
    expect(
      pageKey(
        frame({
          context: {
            ...context,
            controls: [{ role: "AXButton", label: "Next", x: 0.5, y: 0.5 }],
            visibleText: "more",
          },
        }),
      ),
    ).toBe(base);
    expect(
      pageKey(
        frame({
          context: {
            ...context,
            browserAddress: "http://127.0.0.1:8080/form/new",
          },
        }),
      ),
    ).not.toBe(base);
    expect(
      pageKey(frame({ context: { ...context, windowTitle: "New entry" } })),
    ).not.toBe(base);
    expect(pageKey(frame({ appId: "com.example.editor" }))).not.toBe(base);
  });
});
