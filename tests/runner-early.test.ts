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
import { Runner, type RunPrelude } from "../src/core/runner";
import type { MemoryAccess, ReplayPlan } from "../src/core/memory";
import { EarlyStart, type EarlyController } from "../electron/early-start";

const VSCODE = "com.microsoft.VSCode";
const SLACK = "com.tinyspeck.slackmacgap";
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
const usage = { inputTokens: 0, outputTokens: 0, cost: 0 };
const settings = structuredClone(defaultSettings);
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
  const frames: Frame[] = [];
  let run: Run | undefined;
  const recorder: Recorder = {
    begin: (r) => {
      run = r;
    },
    save: (r) => {
      run = r;
    },
    frame: (_id, f) => {
      frames.push(f);
    },
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
/** The desktop the run sees after the early step: Slack in front. */
function desktop(front = SLACK) {
  const calls: string[] = [];
  let captures = 0;
  const controller: Controller = {
    kind: "native",
    surface: vi.fn(async (action?: Action) => {
      calls.push(action ? `surface(${action.type})` : "surface()");
      return {
        appId: front,
        pid: 1,
        secureInput: false,
        unknown: false,
        ...(action?.type === "open_app"
          ? {
              launcherStatus: "resolved" as const,
              launcherAppId: SLACK,
              launcherName: "Slack",
              windowCount: 1,
            }
          : {}),
      };
    }),
    capture: vi.fn(async () => {
      calls.push("capture");
      return frameOf(`run-frame-${++captures}`, front);
    }),
    execute: vi.fn(async (a: Action): Promise<void | ExecutionResult> => {
      calls.push(`execute(${a.type})`);
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
    }),
    resume: vi.fn(async () => {
      calls.push("resume");
    }),
    stop: vi.fn(() => {
      calls.push("stop");
    }),
  };
  return { controller, calls };
}
function scripted(
  replies: ((o: Observation) => Partial<ProviderResult>)[] = [],
) {
  const observations: Observation[] = [];
  const next = vi.fn(async (o: Observation) => {
    observations.push(structuredClone(o));
    const reply = replies[observations.length - 1];
    return {
      usage,
      ...(reply
        ? reply(o)
        : { action: { type: "done", summary: "Done", frame_id: o.frame.id } }),
    } as ProviderResult;
  });
  return { next, observations };
}
const earlyFrame = frameOf("early-frame", VSCODE);
const earlySurface: Surface = {
  appId: VSCODE,
  pid: 1,
  secureInput: false,
  unknown: false,
  launcherStatus: "resolved",
  launcherAppId: SLACK,
  launcherName: "Slack",
  windowCount: 1,
};
function prelude(completes = false): RunPrelude {
  return {
    frame: structuredClone(earlyFrame),
    surface: earlySurface,
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
    completes,
  };
}
function memoryWith(plan?: ReplayPlan): MemoryAccess {
  return {
    recall: vi.fn(async () => ({
      context: { preferences: [], episodes: [] },
      ...(plan ? { plan } : {}),
    })),
    learn: vi.fn(),
  };
}
async function run(
  task: string,
  o: {
    prelude?: RunPrelude;
    memory?: MemoryAccess;
    front?: string;
    replies?: ((o: Observation) => Partial<ProviderResult>)[];
    memoryOff?: boolean;
  } = {},
) {
  const j = journal();
  const desk = desktop(o.front);
  const provider = scripted(o.replies);
  const runner = new Runner(
    desk.controller,
    { next: provider.next },
    j.recorder,
    { ...settings, memory: !o.memoryOff },
    () => {},
    [],
    o.memory,
  );
  await runner.start(task, {
    origin: "voice",
    taskSource: "user_words",
    ...(o.prelude ? { prelude: o.prelude } : {}),
  });
  await until(() => runner.settled);
  return { ...j, ...desk, provider, runner };
}

describe("a run with a prelude", () => {
  it("journals the early step as its own first frame and step", async () => {
    const r = await run("Open Slack and message Dana hi", {
      prelude: prelude(),
    });
    const types = r.events.map((e) => e.type);
    expect(types.slice(0, 5)).toEqual([
      "RunStarted",
      "FrameCaptured",
      "ActionProposed",
      "PolicyAllowed",
      "ActionExecuted",
    ]);
    expect(r.of("FrameCaptured")[0].data.frame_id).toBe("early-frame");
    expect(r.frames[0].id).toBe("early-frame");
    expect(r.of("PolicyAllowed")[0].data.reason).toBe(
      "Open a verified installed application.",
    );
    expect(r.of("ActionExecuted")[0].data).toMatchObject({
      early: true,
      frame_id: "early-frame",
      action: { type: "open_app", name: "Slack" },
      launched: { appId: SLACK, frontmost: true },
    });
    // Nothing is opened again by the run itself.
    expect(r.calls).not.toContain("execute(open_app)");
    expect(r.getRun().actions).toBe(1);
    expect(r.runner.actionsAttempted).toBe(1);
    expect(r.getRun().frames).toBe(2);
  });
  it("tells the model the app is already open", async () => {
    const r = await run("Open Slack and message Dana hi", {
      prelude: prelude(),
    });
    expect(r.provider.next).toHaveBeenCalledTimes(1);
    const history = r.provider.observations[0].history;
    expect(history[0]).toEqual({
      type: "open_app",
      action: { type: "open_app", name: "Slack" },
      result: expect.stringMatching(
        /^Opened Slack \(com\.tinyspeck\.slackmacgap\); frontmost=true\./,
      ),
    });
    // The model's first look is its own fresh capture, not the early frame.
    expect(r.provider.observations[0].frame.id).toBe("run-frame-1");
  });
  it("finishes the built-in 'open X' intent without a model call or a second open", async () => {
    const intent: ReplayPlan = {
      id: "intent:app:slack",
      source: "intent",
      mode: "replay",
      steps: [{ action: { type: "open_app", name: "Slack" } }],
      completeWhen: { appId: SLACK },
      outline: ["Open Slack"],
    };
    const r = await run("Open Slack", {
      prelude: prelude(),
      memory: memoryWith(intent),
    });
    expect(r.provider.next).not.toHaveBeenCalled();
    expect(r.controller.execute).not.toHaveBeenCalled();
    expect(r.of("PlanCompleted")).toHaveLength(1);
    expect(r.getRun().status).toBe("completed");
  });
  it("continues a learned plan at its second step", async () => {
    const skill: ReplayPlan = {
      id: "skill-1",
      source: "skill",
      mode: "replay",
      steps: [
        { action: { type: "open_app", name: "slack" } },
        { action: { type: "hotkey", keys: ["CMD", "K"] }, expectAppId: SLACK },
      ],
      outline: ["Open Slack", "Press Cmd+K"],
    };
    const r = await run("Open Slack and jump to Dana", {
      prelude: prelude(),
      memory: memoryWith(skill),
    });
    // The plan's own open_app would be refused as already frontmost and
    // abandon the plan; it starts at the shortcut instead.
    expect(r.of("PlanStepProposed").map((e) => e.data.index)).toEqual([1]);
    expect(r.of("PlanAbandoned").map((e) => e.data.index)).not.toContain(0);
    expect(r.calls).not.toContain("surface(open_app)");
    expect(r.calls).not.toContain("execute(open_app)");
  });
  it("completes on the first capture when the words were only the step", async () => {
    const r = await run("Open Slack.", {
      prelude: prelude(true),
      memoryOff: true,
    });
    expect(r.provider.next).not.toHaveBeenCalled();
    expect(r.getRun()).toMatchObject({
      status: "completed",
      summary: "Opened Slack.",
    });
    expect(r.calls).toEqual(["resume", "surface()", "capture", "stop"]);
  });
  it("asks the model when the app is not in front after all", async () => {
    const r = await run("Open Slack.", {
      prelude: prelude(true),
      memoryOff: true,
      front: VSCODE,
    });
    expect(r.provider.next).toHaveBeenCalledTimes(1);
  });
  it("counts the step, so words added later are a correction", async () => {
    const j = journal();
    const thinking = vi.fn(
      (_o: Observation, signal: AbortSignal) =>
        new Promise<ProviderResult>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
    );
    const runner = new Runner(
      desktop().controller,
      { next: thinking },
      j.recorder,
      { ...settings, memory: false },
      () => {},
    );
    void runner.start("Open Slack and", { prelude: prelude() });
    await until(() => thinking.mock.calls.length > 0);
    await expect(runner.amendTask("check the weather")).rejects.toThrow(
      /already acted/,
    );
    runner.stop();
    await until(() => runner.settled);
  });
});

describe("the early step and the run loop", () => {
  it("make the same native calls in the same order", async () => {
    // The loop, for a model-proposed open_app.
    const loop = desktop(VSCODE);
    const r = new Runner(
      loop.controller,
      scripted([
        (o) => ({
          action: { type: "open_app", name: "Slack", frame_id: o.frame.id },
        }),
      ]),
      journal().recorder,
      { ...settings, memory: false },
      () => {},
    );
    await r.start("Open Slack and message Dana hi");
    await until(() => r.settled);
    const firstStep = loop.calls.slice(
      0,
      loop.calls.indexOf("execute(open_app)") + 1,
    );
    // The early step, on the same desktop.
    const calls: string[] = [];
    const fake = desktop(VSCODE);
    const record =
      (name: string, fn: (...a: never[]) => unknown) =>
      (...a: never[]) => {
        calls.push(name);
        return fn(...a);
      };
    const controller: EarlyController = {
      configure: async () => {},
      surface: (a?: Action) => (
        calls.push(a ? `surface(${a.type})` : "surface()"),
        fake.controller.surface(a)
      ),
      capture: record(
        "capture",
        fake.controller.capture,
      ) as () => Promise<Frame>,
      execute: (a: Action, f: Frame, s: AbortSignal) => (
        calls.push(`execute(${a.type})`),
        fake.controller.execute(a, f, s)
      ),
      resume: async () => {},
      stop: () => {},
      request: async () => ({}),
    };
    const early = new EarlyStart({
      controller: () => controller,
      settings: () => ({ ...settings, earlyStart: true }),
      blocked: () => undefined,
      onOpened: () => {},
      trace: () => {},
    });
    early.begin(1, Promise.resolve());
    early.partial(1, "Open Slack and");
    early.partial(1, "Open Slack and message");
    await early.idle();
    const without = (list: string[]) =>
      list.filter((c) => !["resume", "stop"].includes(c));
    expect(calls).toEqual([
      "surface()",
      "capture",
      "surface(open_app)",
      "execute(open_app)",
    ]);
    expect(calls).toEqual(without(firstStep));
  });
});
