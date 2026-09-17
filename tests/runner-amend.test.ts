import { describe, it, expect, vi, afterEach } from "vitest";
import {
  defaultSettings,
  type Action,
  type Controller,
  type Frame,
  type JournalEvent,
  type MemoryContext,
  type Observation,
  type ProviderResult,
  type Recorder,
  type Run,
  type Settings,
  type Surface,
} from "../src/core/schema";
import { Runner } from "../src/core/runner";
import type {
  LearnInput,
  MemoryAccess,
  Recall,
  ReplayPlan,
} from "../src/memory/types";

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

const first = "Open Google and";
const amended = "Open Google and check the weather";

function journal() {
  const events: JournalEvent[] = [];
  /** The task text at each save, in order. */
  const saved: string[] = [];
  const recorder: Recorder = {
    begin: () => {},
    save: (r: Run) => {
      saved.push(r.task);
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
/** Provider that plays scripted (possibly slow) replies, then finishes. */
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
const click: Reply = (o) => ({
  action: { type: "click", x: 0.5, y: 0.5, frame_id: o.frame.id },
});

const context: MemoryContext = {
  preferences: ["Use Safari for browsing"],
  episodes: [],
};
const enterPlan = (): ReplayPlan => ({
  id: "plan-1",
  source: "skill",
  mode: "replay",
  steps: [{ action: { type: "key", key: "ENTER" } }],
  outline: ["Press Enter"],
});
function fakeMemory(recall: Recall | (() => Promise<Recall>)) {
  const learned: LearnInput[] = [];
  const access: MemoryAccess = {
    recall: vi.fn(async () =>
      typeof recall === "function" ? recall() : structuredClone(recall),
    ),
    learn: vi.fn((input: LearnInput) => {
      learned.push(structuredClone(input));
    }),
  };
  return { access, learned };
}

describe("amending a task before any action runs", () => {
  it("replaces the task, discards stale inference and journals only the length", async () => {
    allowAll();
    const m = journal();
    const c = controller();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const p = scripted([
      async (o) => {
        // Answers for the old wording after the task was amended.
        await gate;
        return click(o, new AbortController().signal);
      },
    ]);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    const running = runner.start(first);
    await until(() => p.observations.length === 1);
    await runner.amendTask(`  ${amended}  `);
    expect(runner.snapshot.run?.task).toBe(amended);
    expect(m.saved.at(-1)).toBe(amended);
    release();
    await running;
    expect(runner.snapshot.run?.status).toBe("completed");
    // The stale click was dropped before accounting, policy or execution.
    expect(c.execute).not.toHaveBeenCalled();
    expect(m.of("ModelResponseReceived")).toHaveLength(1);
    expect(
      m.of("ActionProposed").map((e) => (e.data.action as Action).type),
    ).toEqual(["done"]);
    expect(p.observations.map((o) => o.task)).toEqual([first, amended]);
    expect(m.of("TaskAmended").map((e) => e.data)).toEqual([
      { taskLength: amended.length },
    ]);
    expect(m.of("UserCorrectionRecorded")).toHaveLength(0);
    expect(runner.snapshot.run?.corrections).toBeUndefined();
    expect(m.of("PlanAbandoned")).toHaveLength(0);
  });
  it("abandons a pending replay step and hands memory the amended task without a correction", async () => {
    allowAll();
    const m = journal();
    let calls = 0;
    let hold: (() => void) | undefined;
    const c = controller({
      surface: vi.fn(async (action?: Action) => {
        // Hold the policy lookup for the first proposed (plan) step.
        if (action && ++calls === 1) await new Promise<void>((r) => (hold = r));
        return surface;
      }),
    });
    const mem = fakeMemory({ context, plan: enterPlan() });
    const p = scripted();
    const runner = new Runner(
      c,
      p,
      m.recorder,
      settings,
      () => {},
      [],
      mem.access,
    );
    const running = runner.start(first);
    await until(() => hold !== undefined);
    expect(m.of("PlanStepProposed")).toHaveLength(1);
    await runner.amendTask(amended);
    hold!();
    await running;
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(c.execute).not.toHaveBeenCalled();
    expect(m.of("PlanAbandoned").map((e) => e.data)).toEqual([
      { index: 0, reason: "amended" },
    ]);
    expect(p.observations.map((o) => o.task)).toEqual([amended]);
    expect(m.of("UserCorrectionRecorded")).toHaveLength(0);
    expect(mem.access.recall).toHaveBeenCalledTimes(1);
    expect(mem.learned).toHaveLength(1);
    expect(mem.learned[0]).toMatchObject({
      task: amended,
      status: "completed",
      corrections: [],
      handsOn: false,
    });
    // A plan for the old wording is no evidence about its skill.
    expect(mem.learned[0].plan).toBeUndefined();
  });
  it("drops a plan recalled for the old wording when the task changed during recall", async () => {
    allowAll();
    const m = journal();
    const c = controller();
    let finish: ((r: Recall) => void) | undefined;
    const mem = fakeMemory(() => new Promise<Recall>((r) => (finish = r)));
    const p = scripted();
    const runner = new Runner(
      c,
      p,
      m.recorder,
      settings,
      () => {},
      [],
      mem.access,
    );
    const running = runner.start(first);
    await until(() => finish !== undefined);
    await runner.amendTask(amended);
    finish!({ context, plan: enterPlan() });
    await running;
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(m.of("PlanStepProposed")).toHaveLength(0);
    expect(m.of("PlanAbandoned").map((e) => e.data)).toEqual([
      { index: 0, reason: "amended" },
    ]);
    expect(c.execute).not.toHaveBeenCalled();
    expect(p.observations.map((o) => o.task)).toEqual([amended]);
    expect(mem.learned[0]).toMatchObject({ task: amended, handsOn: false });
    expect(mem.learned[0].plan).toBeUndefined();
  });
  it("resumes a run held for voice with the amended task", async () => {
    allowAll();
    const m = journal();
    const c = controller();
    const mem = fakeMemory({ context });
    const p = scripted([hang]);
    const runner = new Runner(
      c,
      p,
      m.recorder,
      settings,
      () => {},
      [],
      mem.access,
    );
    const running = runner.start(first);
    await until(() => runner.snapshot.run?.status === "thinking");
    // Main pauses the run as soon as the follow-up speech is detected.
    runner.interruptForVoice();
    expect(runner.snapshot.run?.status).toBe("paused");
    const resumes = vi.mocked(c.resume).mock.calls.length;
    await runner.amendTask(amended);
    expect(vi.mocked(c.resume).mock.calls.length).toBe(resumes + 1);
    expect(m.of("UserTakeoverEnded")).toHaveLength(1);
    await running;
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(p.observations.map((o) => o.task)).toEqual([first, amended]);
    expect(m.of("TaskAmended")).toHaveLength(1);
    expect(m.of("UserCorrectionRecorded")).toHaveLength(0);
    expect(mem.learned[0]).toMatchObject({
      task: amended,
      corrections: [],
      handsOn: false,
    });
  });
});

describe("questions the model asked", () => {
  it("remembers a request_user question so a plain continue does not loop", async () => {
    const m = journal();
    const c = controller();
    const ask: Reply = (o) => ({
      action: {
        type: "request_user",
        reason: "What would you like me to do with Hermes Agent?",
        frame_id: o.frame.id,
      },
    });
    const p = scripted([ask]);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    const running = runner.start("Hermes agent is");
    await until(() => runner.snapshot.run?.status === "takeover");
    await runner.resume();
    await until(() => p.observations.length === 2);
    const history = p.observations[1].history;
    expect(history.at(-1)).toMatchObject({
      type: "request_user",
      action: {
        type: "request_user",
        reason: "What would you like me to do with Hermes Agent?",
      },
    });
    expect(history.at(-1)?.result).toMatch(/do not ask the same thing again/);
    await running;
    expect(runner.snapshot.run?.status).toBe("completed");
  });
});
describe("amendTask refusals", () => {
  it("refuses once an action has executed", async () => {
    allowAll();
    const m = journal();
    const c = controller();
    const p = scripted([click, hang]);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    const running = runner.start(first);
    await until(
      () => runner.snapshot.run?.actions === 1 && p.observations.length === 2,
    );
    await expect(runner.amendTask(amended)).rejects.toThrow(/already acted/);
    expect(runner.snapshot.run?.task).toBe(first);
    expect(m.of("TaskAmended")).toHaveLength(0);
    runner.stop();
    await running;
    expect(runner.snapshot.run?.status).toBe("cancelled");
  });
  it("refuses once an action was attempted, even if it was interrupted", async () => {
    allowAll();
    const m = journal();
    let entered = false;
    const c = controller({
      execute: vi.fn(async (_action, _frame, signal: AbortSignal) => {
        entered = true;
        // The user's voice hold lands while the action is executing.
        await new Promise((resolve) =>
          signal.addEventListener("abort", resolve, { once: true }),
        );
        throw new Error("interrupted");
      }),
    });
    const p = scripted([click, hang]);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    const running = runner.start(first);
    await until(() => entered);
    runner.interruptForVoice();
    await until(() => runner.snapshot.run?.status === "paused");
    expect(runner.snapshot.run?.actions).toBe(0);
    expect(runner.actionsAttempted).toBe(1);
    await expect(runner.amendTask(amended)).rejects.toThrow(/already acted/);
    expect(runner.snapshot.run?.task).toBe(first);
    expect(m.of("TaskAmended")).toHaveLength(0);
    runner.stop();
    await running;
  });
  it("refuses while an approval is pending, even after a voice interrupt", async () => {
    policy.evaluate = (a) =>
      a.type === "click"
        ? { kind: "CONFIRM", reason: "Send this message?" }
        : { kind: "ALLOW", reason: "Test." };
    const m = journal();
    const c = controller();
    const p = scripted([click]);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    const running = runner.start(first);
    await until(() => runner.snapshot.run?.status === "confirming");
    await expect(runner.amendTask(amended)).rejects.toThrow(/pending approval/);
    runner.interruptForVoice();
    await expect(runner.amendTask(amended)).rejects.toThrow(/pending approval/);
    expect(runner.snapshot.run?.status).toBe("confirming");
    expect(runner.snapshot.pending).toBeDefined();
    expect(runner.snapshot.run?.task).toBe(first);
    expect(m.of("TaskAmended")).toHaveLength(0);
    runner.stop();
    await running;
    expect(c.execute).not.toHaveBeenCalled();
  });
  it("refuses credentials, empty or oversized text, and inactive runs", async () => {
    allowAll();
    const m = journal();
    const p = scripted([hang]);
    const runner = new Runner(controller(), p, m.recorder, settings, () => {});
    await expect(runner.amendTask(amended)).rejects.toThrow("No active run.");
    const running = runner.start(first);
    await until(() => runner.snapshot.run?.status === "thinking");
    await expect(
      runner.amendTask(`${first} log in with password: hunter22!`),
    ).rejects.toThrow(/credentials/);
    await expect(runner.amendTask("   ")).rejects.toThrow(/8,000/);
    await expect(runner.amendTask("x".repeat(8001))).rejects.toThrow(/8,000/);
    expect(runner.snapshot.run?.task).toBe(first);
    expect(m.of("TaskAmended")).toHaveLength(0);
    // The upper bound itself is accepted.
    await runner.amendTask("x".repeat(8000));
    expect(m.of("TaskAmended").map((e) => e.data)).toEqual([
      { taskLength: 8000 },
    ]);
    runner.stop();
    await running;
    await expect(runner.amendTask(amended)).rejects.toThrow("No active run.");
  });
});
