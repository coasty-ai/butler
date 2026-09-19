import { describe, it, expect, vi, afterEach } from "vitest";
import {
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
import { Runner } from "../src/core/runner";
import { SurfaceBlockedError } from "../src/core/errors";

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
function journal() {
  const events: JournalEvent[] = [];
  const saved: Run[] = [];
  const recorder: Recorder = {
    begin: (r) => saved.push(structuredClone(r)),
    save: (r) => saved.push(structuredClone(r)),
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
  return { recorder, events, saved, of };
}
let captures = 0;
function controller(overrides: Partial<Controller> = {}): Controller {
  return {
    kind: "native",
    surface: vi.fn(async () => surface),
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
    ...overrides,
  };
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
const act =
  (action: Record<string, unknown>): Reply =>
  (o) => ({ action: { ...action, frame_id: o.frame.id } });
const click = act({ type: "click", x: 0.5, y: 0.5 });
const confirmClicks = () => {
  policy.evaluate = (a) =>
    a.type === "click"
      ? { kind: "CONFIRM", reason: "Send this message?" }
      : { kind: "ALLOW", reason: "Test." };
};

describe("run origin and task source", () => {
  it("start records the origin, and typed is the default", async () => {
    const m = journal();
    const runner = new Runner(
      controller(),
      scripted(),
      m.recorder,
      settings,
      () => {},
    );
    await runner.start("Open Notes");
    expect(runner.snapshot.run).toMatchObject({
      status: "completed",
      origin: "typed",
    });
    expect(runner.snapshot.run && "taskSource" in runner.snapshot.run).toBe(
      false,
    );
    expect(m.of("RunStarted")[0].data).toMatchObject({ origin: "typed" });
    expect(m.saved[0]).toMatchObject({ origin: "typed" });
  });

  it("keeps a texted origin and the words' provenance on the saved run", async () => {
    const m = journal();
    const runner = new Runner(
      controller(),
      scripted(),
      m.recorder,
      settings,
      () => {},
    );
    await runner.start("Open Notes", {
      origin: "message",
      taskSource: "user_words",
    });
    expect(runner.snapshot.run).toMatchObject({
      origin: "message",
      taskSource: "user_words",
    });
    expect(m.of("RunStarted")[0].data).toMatchObject({ origin: "message" });
    expect(m.saved.at(-1)).toMatchObject({
      origin: "message",
      taskSource: "user_words",
    });
    // A proposal's wording is never the user's words.
    const again = new Runner(
      controller(),
      scripted(),
      m.recorder,
      settings,
      () => {},
    );
    await again.start("Send the deck", {
      origin: "voice",
      taskSource: "proposal",
    });
    expect(again.snapshot.run).toMatchObject({
      origin: "voice",
      taskSource: "proposal",
    });
  });
});

describe("approval source", () => {
  it("journals who approved: voice, typed, pill or the default click", async () => {
    confirmClicks();
    for (const [answer, source] of [
      [(r: Runner) => r.approveFromVoice(true, "voice"), "voice"],
      [(r: Runner) => r.approveFromVoice(true), "voice"],
      // A "yes" typed in the command bar is not a click on the pill.
      [(r: Runner) => r.approveFromVoice(true, "typed"), "typed"],
      [(r: Runner) => r.approveFromVoice(true, "pill"), "pill"],
      [(r: Runner) => r.confirm(true), "pill"],
    ] as const) {
      const m = journal();
      const c = controller();
      const runner = new Runner(
        c,
        scripted([click]),
        m.recorder,
        settings,
        () => {},
      );
      const running = runner.start("test");
      await until(() => runner.snapshot.run?.status === "confirming");
      await answer(runner);
      await running;
      expect(runner.snapshot.run?.status).toBe("completed");
      expect(c.execute).toHaveBeenCalledTimes(1);
      expect(m.of("UserConfirmed").map((e) => e.data)).toEqual([{ source }]);
    }
  });

  it("journals who declined, by voice, text, phone or the pill", async () => {
    confirmClicks();
    for (const [answer, source] of [
      [(r: Runner) => r.approveFromVoice(false, "message"), "message"],
      [(r: Runner) => r.approveFromVoice(false, "remote"), "remote"],
      [(r: Runner) => r.approveFromVoice(false, "typed"), "typed"],
      [(r: Runner) => r.approveFromVoice(false), "voice"],
      [(r: Runner) => r.confirm(false), "pill"],
    ] as const) {
      const m = journal();
      const c = controller();
      const runner = new Runner(
        c,
        scripted([click]),
        m.recorder,
        settings,
        () => {},
      );
      const running = runner.start("test");
      await until(() => runner.snapshot.run?.status === "confirming");
      await answer(runner);
      // A spoken or texted "no" pauses; a pill decline lets the run go on.
      await until(
        () =>
          runner.snapshot.run?.status === "paused" ||
          runner.snapshot.run?.status === "completed",
      );
      if (runner.snapshot.run?.status === "paused") await runner.resume();
      await running;
      expect(c.execute).not.toHaveBeenCalled();
      // Beside who answered, the question as a code, never its text.
      expect(m.of("UserDenied").map((e) => e.data)).toEqual([
        { source, approvalCode: expect.stringMatching(/^[A-Z][A-Z0-9_]+$/) },
      ]);
    }
  });

  it("a second approval on the same run starts with a clean source", async () => {
    confirmClicks();
    const m = journal();
    const runner = new Runner(
      controller(),
      scripted([click, click]),
      m.recorder,
      settings,
      () => {},
    );
    const running = runner.start("test");
    await until(() => runner.snapshot.run?.status === "confirming");
    await runner.approveFromVoice(true, "voice");
    await until(
      () =>
        runner.snapshot.run?.status === "confirming" &&
        m.of("UserConfirmed").length === 1,
    );
    runner.confirm(true);
    await running;
    expect(m.of("UserConfirmed").map((e) => e.data)).toEqual([
      { source: "voice" },
      { source: "pill" },
    ]);
  });
});

describe("takeover source", () => {
  it("names the model's question and the policy hand-off", async () => {
    for (const [type, source] of [
      ["request_user", "request_user"],
      ["click", "policy"],
    ] as const) {
      policy.evaluate = (a) =>
        a.type === type
          ? { kind: "USER_TAKEOVER", reason: "Please take over." }
          : { kind: "ALLOW", reason: "Test." };
      const m = journal();
      const runner = new Runner(
        controller(),
        scripted([
          type === "request_user"
            ? act({ type: "request_user", reason: "Which account?" })
            : click,
        ]),
        m.recorder,
        settings,
        () => {},
      );
      const running = runner.start("test");
      await until(() => runner.snapshot.run?.status === "takeover");
      expect(m.of("UserTakeoverStarted").map((e) => e.data)).toEqual([
        { source },
      ]);
      runner.stop();
      await running;
    }
  });

  it("names a refused surface and a target it could not find", async () => {
    const m = journal();
    const c = controller({
      surface: vi.fn(async (action?: Action) => {
        if (action) throw new SurfaceBlockedError("Secure input is on.");
        return surface;
      }),
    });
    const runner = new Runner(
      c,
      scripted([click]),
      m.recorder,
      settings,
      () => {},
    );
    let running = runner.start("test");
    await until(() => runner.snapshot.run?.status === "takeover");
    expect(m.of("UserTakeoverStarted").map((e) => e.data)).toEqual([
      { source: "surface" },
    ]);
    runner.stop();
    await running;

    policy.evaluate = (a) =>
      a.type === "click"
        ? { kind: "RETRY", reason: "No control there." }
        : { kind: "ALLOW", reason: "Test." };
    const m2 = journal();
    const again = new Runner(
      controller(),
      scripted([click, click, click, click]),
      m2.recorder,
      settings,
      () => {},
    );
    running = again.start("test");
    await until(() => again.snapshot.run?.status === "takeover");
    expect(m2.of("UserTakeoverStarted").map((e) => e.data)).toEqual([
      { source: "handoff" },
    ]);
    again.stop();
    await running;
  });

  it("keeps the user's own takeover as manual input", async () => {
    let release!: () => void;
    const m = journal();
    const runner = new Runner(
      controller(),
      scripted([
        (o) =>
          new Promise((resolve) => {
            release = () =>
              resolve({
                action: { type: "done", summary: "Done", frame_id: o.frame.id },
              });
          }),
      ]),
      m.recorder,
      settings,
      () => {},
    );
    const running = runner.start("test");
    await until(() => runner.snapshot.run?.status === "thinking");
    runner.manualTakeover();
    expect(m.of("UserTakeoverStarted").map((e) => e.data)).toEqual([
      { source: "manual_input", scope: "screen" },
    ]);
    release();
    runner.stop();
    await running;
  });
});

describe("addUsage", () => {
  it("counts toward maxCost at the next check", async () => {
    let release!: () => void;
    const m = journal();
    const runner = new Runner(
      controller(),
      scripted([
        (o) =>
          new Promise((resolve) => {
            release = () =>
              resolve({
                action: { type: "done", summary: "Done", frame_id: o.frame.id },
              });
          }),
      ]),
      m.recorder,
      { ...settings, maxCost: 1 },
      () => {},
    );
    const running = runner.start("test");
    await until(() => runner.snapshot.run?.status === "thinking");
    runner.addUsage({ inputTokens: 100, outputTokens: 20, cost: 0.4 });
    runner.addUsage({ inputTokens: 100, outputTokens: 20, cost: 0.7 });
    // Nothing stops yet: the loop is what enforces the budget.
    expect(runner.snapshot.run?.status).toBe("thinking");
    expect(runner.snapshot.run?.usage).toEqual({
      inputTokens: 200,
      outputTokens: 40,
      cost: 1.1,
    });
    expect(m.of("UsageAdded").map((e) => e.data)).toEqual([
      { usage: { inputTokens: 100, outputTokens: 20, cost: 0.4 } },
      { usage: { inputTokens: 100, outputTokens: 20, cost: 0.7 } },
    ]);
    expect(m.saved.at(-1)?.usage.cost).toBeCloseTo(1.1);
    release();
    await running;
    expect(runner.snapshot.run?.status).toBe("failed");
    expect(runner.snapshot.message).toBe("Estimated cost budget reached.");
  });

  it("ignores usage with no live run or with broken numbers", async () => {
    let release!: () => void;
    const m = journal();
    const runner = new Runner(
      controller(),
      scripted([
        (o) =>
          new Promise((resolve) => {
            release = () =>
              resolve({
                action: { type: "done", summary: "Done", frame_id: o.frame.id },
              });
          }),
      ]),
      m.recorder,
      settings,
      () => {},
    );
    runner.addUsage({ inputTokens: 1, outputTokens: 1, cost: 1 });
    const running = runner.start("test");
    await until(() => runner.snapshot.run?.status === "thinking");
    const live = structuredClone(runner.snapshot.run?.usage);
    // A broken figure is dropped whole, never half-applied.
    runner.addUsage({ inputTokens: -1, outputTokens: 0, cost: 0 });
    runner.addUsage({ inputTokens: 5, outputTokens: NaN, cost: 0 });
    runner.addUsage({ inputTokens: 5, outputTokens: 5, cost: Infinity });
    expect(runner.snapshot.run?.usage).toEqual(live);
    release();
    await running;
    const after = structuredClone(runner.snapshot.run?.usage);
    runner.addUsage({ inputTokens: 1, outputTokens: 1, cost: 1 });
    expect(runner.snapshot.run?.usage).toEqual(after);
    expect(m.of("UsageAdded")).toHaveLength(0);
  });
});
