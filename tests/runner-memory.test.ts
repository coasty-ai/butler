import { describe, it, expect, vi, afterEach } from "vitest";
import {
  defaultSettings,
  type Action,
  type Controller,
  type ExecutionResult,
  type Frame,
  type JournalEvent,
  type MemoryContext,
  type Observation,
  type ProviderResult,
  type Recorder,
  type Run,
  type ScreenContext,
  type Settings,
  type Surface,
} from "../src/core/schema";
import {
  Runner,
  normalizeLabel,
  normalizeRole,
  pageHostMatches,
  planSummary,
  surfaceTarget,
} from "../src/core/runner";
import { TutorialController, TutorialProvider } from "../src/core/tutorial";
import {
  NativeActionError,
  ScreenChangedError,
  SurfaceBlockedError,
} from "../src/core/errors";
import type {
  LearnInput,
  MemoryAccess,
  Recall,
  ReplayPlan,
} from "../src/core/memory";

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
  return { recorder, events, of, getRun: () => run! };
}

/** A desktop whose frontmost app, address and controls tests can change. */
function desktop(
  options: {
    appId?: string;
    controls?: ScreenContext["controls"];
    browserAddress?: string;
    domain?: string;
    surface?: Partial<Surface>;
    execute?: (a: Action) => Promise<void | ExecutionResult>;
    /** Runs before each capture returns (1-based capture count). */
    onCapture?: (count: number) => void | Promise<void>;
  } = {},
) {
  const state = {
    appId: options.appId ?? "com.example.app",
    controls: options.controls ?? [],
    browserAddress: options.browserAddress,
    /** Committed page host reported by surface() (Surface.domain). */
    domain: options.domain,
  };
  let captures = 0;
  const c: Controller = {
    kind: "native",
    surface: vi.fn(async () => ({
      appId: state.appId,
      pid: 42,
      secureInput: false,
      unknown: false,
      ...(state.domain ? { domain: state.domain } : {}),
      ...options.surface,
    })),
    capture: vi.fn(async (): Promise<Frame> => {
      const id = `frame-${++captures}`;
      await options.onCapture?.(captures);
      return {
        id,
        sha256: "sha",
        image: "",
        geometry,
        capturedAt: 0,
        synthetic: false,
        appId: state.appId,
        context: {
          appName: "App",
          windowTitle: "Window",
          controls: state.controls,
          ...(state.browserAddress
            ? { browserAddress: state.browserAddress }
            : {}),
        },
      };
    }),
    execute: vi.fn(async (a: Action) => options.execute?.(a)),
    resume: vi.fn(async () => {}),
    stop: vi.fn(() => {}),
  };
  return { controller: c, state };
}

function scripted(
  replies: ((o: Observation) => Partial<ProviderResult> | Error)[] = [],
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

const context: MemoryContext = {
  preferences: ["Use Safari for browsing"],
  episodes: ["Opened Calculator (completed)"],
  apps: [{ name: "Calculator", bundleId: "com.apple.calculator" }],
  files: [{ name: "Q3.xlsx", path: "~/Documents/Q3.xlsx", kind: "document" }],
};
function plan(overrides: Partial<ReplayPlan>): ReplayPlan {
  return {
    id: "plan-1",
    source: "skill",
    mode: "replay",
    steps: [],
    outline: [],
    ...overrides,
  };
}
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
const runnerWith = (
  c: Controller,
  p: { next: ReturnType<typeof scripted>["next"] },
  m: ReturnType<typeof journal>,
  memory?: MemoryAccess,
  s: Settings = settings,
) => new Runner(c, p, m.recorder, s, () => {}, [], memory);

describe("memory normalization helpers", () => {
  it("normalizes labels and roles for replay matching", () => {
    expect(normalizeLabel("  Save   As…  ")).toBe("save as");
    expect(normalizeLabel("Export...")).toBe("export");
    expect(normalizeLabel("New\n Note")).toBe("new note");
    expect(normalizeRole("AXButton")).toBe("button");
    expect(normalizeRole("button")).toBe("button");
    expect(normalizeRole("AXMenuItem")).toBe("menuitem");
  });
  it("matches a committed page host or its subdomains only", () => {
    expect(pageHostMatches("youtube.com", "youtube.com")).toBe(true);
    expect(pageHostMatches("www.YouTube.com", "youtube.com")).toBe(true);
    expect(pageHostMatches("m.youtube.com", "youtube.com")).toBe(true);
    expect(pageHostMatches("youtube.com", "www.youtube.com")).toBe(true);
    expect(pageHostMatches("x.company.com", "x.com")).toBe(false);
    expect(pageHostMatches("notyoutube.com", "youtube.com")).toBe(false);
    expect(pageHostMatches("youtube.com.evil.net", "youtube.com")).toBe(false);
    expect(pageHostMatches(undefined, "youtube.com")).toBe(false);
    expect(pageHostMatches("youtube.com", "")).toBe(false);
  });
  it("summarizes a completed plan from its outline", () => {
    expect(planSummary({ outline: ["Open Calculator"] })).toBe(
      "Opened Calculator.",
    );
    expect(
      planSummary({
        outline: ["Open Safari", "Press Command-L", "Type youtube.com."],
      }),
    ).toBe("Opened Safari, pressed Command-L, typed youtube.com.");
    expect(planSummary({ outline: [] })).toBe("Done.");
  });
  it("takes target role and label from the surface, never field values", () => {
    const click = { type: "click", x: 0.1, y: 0.1, frame_id: "f" } as Action;
    expect(
      surfaceTarget(click, {
        appId: "a",
        pid: 1,
        secureInput: false,
        unknown: false,
        targetRole: "AXButton",
        targetLabel: "Save",
      }),
    ).toEqual({ role: "AXButton", label: "Save" });
    expect(
      surfaceTarget(click, {
        appId: "a",
        pid: 1,
        secureInput: false,
        unknown: false,
        targetRole: "AXTextField",
        targetLabel: "typed secret value",
        targetText: "Email · extra",
      }),
    ).toEqual({ role: "AXTextField", label: "Email" });
    // Long labels stay whole (no ellipsis); learning cuts them natively.
    const long =
      "Read the complete quarterly report on regional sales performance and the outlook for next year";
    expect(
      surfaceTarget(click, {
        appId: "a",
        pid: 1,
        secureInput: false,
        unknown: false,
        targetRole: "AXLink",
        targetLabel: long,
      }),
    ).toEqual({ role: "AXLink", label: long });
    expect(
      surfaceTarget({ type: "type_text", text: "x", frame_id: "f" }, {
        appId: "a",
        pid: 1,
        secureInput: false,
        unknown: false,
        targetRole: "AXButton",
        targetLabel: "Save",
      } as Surface),
    ).toBeUndefined();
  });
});

describe("runner memory recall", () => {
  it("passes recalled context to every provider observation", async () => {
    allowAll();
    const m = journal();
    const { controller } = desktop();
    const mem = fakeMemory({ context });
    const p = scripted([
      (o) => ({ action: { type: "key", key: "ENTER", frame_id: o.frame.id } }),
    ]);
    const runner = runnerWith(controller, p, m, mem.access);
    await runner.start("Open Q3 spreadsheet");
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(mem.access.recall).toHaveBeenCalledTimes(1);
    expect(vi.mocked(mem.access.recall).mock.calls[0][0]).toBe(
      "Open Q3 spreadsheet",
    );
    expect(vi.mocked(mem.access.recall).mock.calls[0][1]).toBeInstanceOf(
      AbortSignal,
    );
    expect(p.observations).toHaveLength(2);
    for (const o of p.observations) expect(o.memory).toEqual(context);
    expect(m.of("MemoryRecalled")[0].data).toEqual({
      preferences: 1,
      episodes: 1,
      apps: 1,
      files: 1,
      plan: "none",
      mode: "none",
    });
    // Counts only: no memory text in the journal.
    expect(JSON.stringify(m.of("MemoryRecalled"))).not.toContain("Safari");
  });
  it("keeps observations unchanged without memory", async () => {
    const m = journal();
    const { controller } = desktop();
    const p = scripted();
    const runner = runnerWith(controller, p, m);
    await runner.start("test");
    expect(p.observations[0]).not.toHaveProperty("memory");
    expect(m.of("MemoryRecalled")).toHaveLength(0);
  });
  it("does not recall or learn when the memory setting is off", async () => {
    const m = journal();
    const { controller } = desktop();
    const mem = fakeMemory({ context });
    const p = scripted();
    const runner = runnerWith(controller, p, m, mem.access, {
      ...settings,
      memory: false,
    });
    await runner.start("test");
    expect(mem.access.recall).not.toHaveBeenCalled();
    expect(mem.access.learn).not.toHaveBeenCalled();
    expect(p.observations[0]).not.toHaveProperty("memory");
  });
  it("never recalls or learns for synthetic tutorial runs", async () => {
    const m = journal();
    const mem = fakeMemory({
      context,
      plan: plan({
        steps: [{ action: { type: "key", key: "ENTER" } }],
        outline: ["Press Enter"],
      }),
    });
    const runner = new Runner(
      new TutorialController(),
      new TutorialProvider(0),
      m.recorder,
      settings,
      () => {},
      [],
      mem.access,
    );
    await runner.start("Tutorial");
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(mem.access.recall).not.toHaveBeenCalled();
    expect(mem.access.learn).not.toHaveBeenCalled();
    expect(m.of("MemoryRecalled")).toHaveLength(0);
    expect(m.of("PlanStepProposed")).toHaveLength(0);
  });
  it("does not let a hanging recall block the run", async () => {
    const m = journal();
    const { controller } = desktop();
    let signal: AbortSignal | undefined;
    const learned: LearnInput[] = [];
    const access: MemoryAccess = {
      recall: vi.fn(
        (_task: string, s?: AbortSignal) =>
          new Promise<Recall>(() => {
            signal = s;
          }),
      ),
      learn: (i) => learned.push(i),
    };
    const p = scripted();
    const runner = runnerWith(controller, p, m, access);
    const started = Date.now();
    await runner.start("test");
    const elapsed = Date.now() - started;
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(elapsed).toBeGreaterThanOrEqual(1900);
    expect(elapsed).toBeLessThan(3500);
    expect(signal?.aborted).toBe(true);
    expect(p.observations[0]).not.toHaveProperty("memory");
    expect(m.of("MemoryRecalled")).toHaveLength(0);
    expect(learned).toHaveLength(1);
  });
  it("stopping during recall ends the run without enabling input", async () => {
    const m = journal();
    const { controller } = desktop();
    const access: MemoryAccess = {
      recall: (_t, s) =>
        new Promise<Recall>((_r, reject) =>
          s?.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
      learn: vi.fn(),
    };
    const p = scripted();
    const runner = runnerWith(controller, p, m, access);
    const running = runner.start("test");
    await tick();
    runner.stop();
    await running;
    expect(runner.snapshot.run?.status).toBe("cancelled");
    expect(controller.resume).not.toHaveBeenCalled();
    expect(p.next).not.toHaveBeenCalled();
    expect(access.learn).toHaveBeenCalledTimes(1);
    expect(runner.settled).toBe(true);
  });
  it("ignores a recall that throws", async () => {
    const m = journal();
    const { controller } = desktop();
    const access: MemoryAccess = {
      recall: () => Promise.reject(new Error("boom")),
      learn: vi.fn(),
    };
    const p = scripted();
    const runner = runnerWith(controller, p, m, access);
    await runner.start("test");
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(access.learn).toHaveBeenCalledTimes(1);
  });
});

describe("runner replay plans", () => {
  it("completes a built-in open_app intent with zero provider calls", async () => {
    allowAll();
    const m = journal();
    const d = desktop({
      execute: async (a) => {
        if (a.type !== "open_app") return;
        d.state.appId = "com.apple.calculator";
        return {
          launched: {
            appId: "com.apple.calculator",
            name: "Calculator",
            frontmost: true,
            wasRunning: false,
          },
        };
      },
    });
    const mem = fakeMemory({
      context,
      plan: plan({
        id: "intent:open_app",
        source: "intent",
        steps: [{ action: { type: "open_app", name: "Calculator" } }],
        completeWhen: { appId: "com.apple.calculator" },
        outline: ["Open Calculator"],
      }),
    });
    const p = scripted();
    const runner = runnerWith(d.controller, p, m, mem.access);
    await runner.start("open calculator");
    const run = runner.snapshot.run!;
    expect(run.status).toBe("completed");
    expect(run.summary).toBe("Opened Calculator.");
    expect(runner.snapshot.message).toBe("Opened Calculator.");
    expect(p.next).not.toHaveBeenCalled();
    expect(run.usage).toEqual(usage);
    expect(run.actions).toBe(1);
    expect(d.controller.execute).toHaveBeenCalledTimes(1);
    expect(vi.mocked(d.controller.execute).mock.calls[0][0]).toMatchObject({
      type: "open_app",
      name: "Calculator",
    });
    expect(m.of("MemoryRecalled")[0].data).toMatchObject({
      plan: "intent",
      mode: "replay",
    });
    expect(m.of("PlanStepProposed").map((e) => e.data)).toEqual([
      { source: "intent", index: 0 },
    ]);
    expect(m.of("PlanCompleted").map((e) => e.data)).toEqual([
      { source: "intent" },
    ]);
    expect(m.of("ModelRequestStarted")).toHaveLength(0);
    // The replayed step went through the same policy boundary.
    expect(m.of("ActionProposed")).toHaveLength(1);
    expect(m.of("PolicyAllowed")).toHaveLength(1);
    const types = m.events.map((e) => e.type);
    expect(types.indexOf("PlanCompleted")).toBeLessThan(
      types.indexOf("RunCompleted"),
    );
    expect(mem.learned).toHaveLength(1);
    expect(mem.learned[0]).toMatchObject({
      status: "completed",
      synthetic: false,
      plan: {
        id: "intent:open_app",
        source: "intent",
        completedSteps: 1,
        abandoned: false,
      },
      handsOn: false,
      steps: [
        {
          action: { type: "open_app", name: "Calculator" },
          appId: "com.example.app",
          launchedAppId: "com.apple.calculator",
          fromPlan: "intent",
        },
      ],
    });
    expect(mem.learned[0].appsSeen).toEqual(
      expect.arrayContaining(["com.example.app", "com.apple.calculator"]),
    );
  });
  it("uses the real policy for a replayed open_app step", async () => {
    const m = journal();
    const d = desktop({
      surface: {
        launcherStatus: "resolved",
        launcherName: "Calculator",
        launcherAppId: "com.apple.calculator",
      },
      execute: async () => {
        d.state.appId = "com.apple.calculator";
        return {
          launched: {
            appId: "com.apple.calculator",
            name: "Calculator",
            frontmost: true,
            wasRunning: true,
          },
        };
      },
    });
    const mem = fakeMemory({
      context,
      plan: plan({
        source: "intent",
        steps: [{ action: { type: "open_app", name: "Calculator" } }],
        completeWhen: { appId: "com.apple.calculator" },
        outline: ["Open Calculator"],
      }),
    });
    const p = scripted();
    const runner = runnerWith(d.controller, p, m, mem.access);
    await runner.start("open calculator");
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(p.next).not.toHaveBeenCalled();
    expect(m.of("PlanCompleted")).toHaveLength(1);
  });
  it("resolves a pointer step by role and label from context.controls", async () => {
    allowAll();
    const m = journal();
    const d = desktop({
      appId: "com.apple.TextEdit",
      controls: [
        { role: "AXButton", label: "Cancel", x: 0.1, y: 0.2 },
        { role: "AXButton", label: "  Save… ", x: 0.3, y: 0.4 },
        { role: "AXStaticText", label: "Save", x: 0.9, y: 0.9 },
      ],
      surface: { targetRole: "AXButton", targetLabel: "Save" },
    });
    const mem = fakeMemory({
      context,
      plan: plan({
        steps: [
          {
            // Learned coordinates are ignored even if present.
            action: { type: "click", x: 0.99, y: 0.99, button: "left" },
            target: { role: "button", label: "save" },
            expectAppId: "com.apple.TextEdit",
          },
        ],
        outline: ["Click Save"],
      }),
    });
    const p = scripted();
    const runner = runnerWith(d.controller, p, m, mem.access);
    await runner.start("save the document");
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(d.controller.execute).toHaveBeenCalledTimes(1);
    const executed = vi.mocked(d.controller.execute).mock.calls[0][0];
    expect(executed).toMatchObject({ type: "click", x: 0.3, y: 0.4 });
    expect(executed.frame_id).toBe("frame-1");
    // No completeWhen: the model is asked to verify and finish with a hint.
    expect(p.next).toHaveBeenCalledTimes(1);
    expect(p.observations[0].memory?.plan).toEqual({
      source: "skill",
      note: "Known plan steps were executed; verify the result on the current screen and finish",
      steps: ["Click Save"],
    });
    expect(p.observations[0].history.at(-1)?.result).toContain(
      "click on button “Save”",
    );
    expect(m.of("PlanAbandoned")).toHaveLength(0);
    expect(mem.learned[0].steps[0]).toEqual({
      action: { type: "click", x: 0.3, y: 0.4, button: "left" },
      appId: "com.apple.TextEdit",
      target: { role: "AXButton", label: "Save" },
      fromPlan: "skill",
    });
    expect(mem.learned[0].handsOn).toBe(false);
    expect(mem.learned[0].plan).toMatchObject({
      completedSteps: 1,
      abandoned: false,
    });
  });
  it("abandons on a missing control and the model continues with a hint", async () => {
    allowAll();
    const m = journal();
    const d = desktop({
      controls: [{ role: "AXButton", label: "Cancel", x: 0.1, y: 0.2 }],
    });
    const mem = fakeMemory({
      context,
      plan: plan({
        steps: [
          { action: { type: "key", key: "ENTER" } },
          {
            action: { type: "click", button: "left" },
            target: { role: "AXButton", label: "Save" },
          },
          { action: { type: "key", key: "TAB" } },
        ],
        outline: ["Press Enter", "Click Save", "Press Tab"],
      }),
    });
    const p = scripted();
    const runner = runnerWith(d.controller, p, m, mem.access);
    await runner.start("save");
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(d.controller.execute).toHaveBeenCalledTimes(1);
    expect(m.of("PlanStepProposed").map((e) => e.data.index)).toEqual([0]);
    expect(m.of("PlanAbandoned").map((e) => e.data)).toEqual([
      { index: 1, reason: "missing_control" },
    ]);
    expect(p.next).toHaveBeenCalledTimes(1);
    expect(p.observations[0].memory?.plan).toEqual({
      source: "skill",
      note: "Known plan interrupted at step 2; continue from the current screen",
      steps: ["Click Save", "Press Tab"],
    });
    // The recalled context is otherwise preserved.
    expect(p.observations[0].memory?.preferences).toEqual(context.preferences);
    expect(mem.learned[0].plan).toMatchObject({
      completedSteps: 1,
      abandoned: true,
    });
  });
  it("abandons when two controls match the same label", async () => {
    allowAll();
    const m = journal();
    const d = desktop({
      controls: [
        { role: "AXButton", label: "OK", x: 0.1, y: 0.2 },
        { role: "button", label: "ok", x: 0.5, y: 0.2 },
      ],
    });
    const mem = fakeMemory({
      context,
      plan: plan({
        steps: [
          {
            action: { type: "click", button: "left" },
            target: { role: "AXButton", label: "OK" },
          },
        ],
        outline: ["Click OK"],
      }),
    });
    const p = scripted();
    const runner = runnerWith(d.controller, p, m, mem.access);
    await runner.start("ok");
    expect(d.controller.execute).not.toHaveBeenCalled();
    expect(m.of("PlanAbandoned")[0].data).toEqual({
      index: 0,
      reason: "ambiguous_control",
    });
  });
  it("abandons when the expected app is not frontmost", async () => {
    allowAll();
    const m = journal();
    const d = desktop({ appId: "com.apple.Safari" });
    const mem = fakeMemory({
      context,
      plan: plan({
        steps: [
          {
            action: { type: "key", key: "ENTER" },
            expectAppId: "com.apple.Notes",
          },
        ],
        outline: ["Press Enter"],
      }),
    });
    const p = scripted();
    const runner = runnerWith(d.controller, p, m, mem.access);
    await runner.start("x");
    expect(d.controller.execute).not.toHaveBeenCalled();
    expect(m.of("PlanAbandoned")[0].data).toEqual({
      index: 0,
      reason: "app_mismatch",
    });
    expect(p.next).toHaveBeenCalledTimes(1);
  });
  it("never replays terminal steps or label-less pointer steps", async () => {
    allowAll();
    for (const step of [
      { action: { type: "done", summary: "x" } },
      { action: { type: "click", x: 0.5, y: 0.5 } },
    ]) {
      const m = journal();
      const d = desktop();
      const mem = fakeMemory({
        context,
        plan: plan({ steps: [step], outline: ["Step"] }),
      });
      const p = scripted();
      const runner = runnerWith(d.controller, p, m, mem.access);
      await runner.start("x");
      expect(d.controller.execute).not.toHaveBeenCalled();
      expect(m.of("PlanAbandoned")).toHaveLength(1);
      expect(p.next).toHaveBeenCalledTimes(1);
    }
  });
  it("abandons an invalid replayed action at validation", async () => {
    allowAll();
    const m = journal();
    const d = desktop();
    const mem = fakeMemory({
      context,
      plan: plan({
        steps: [{ action: { type: "key", key: "NOT_A_KEY" } }],
        outline: ["Press"],
      }),
    });
    const p = scripted();
    const runner = runnerWith(d.controller, p, m, mem.access);
    await runner.start("x");
    expect(d.controller.execute).not.toHaveBeenCalled();
    expect(m.of("PlanAbandoned")[0].data).toEqual({
      index: 0,
      reason: "invalid_action",
    });
    expect(runner.snapshot.run?.status).toBe("completed");
  });
  it("still requires approval for a replayed step and a decline abandons", async () => {
    policy.evaluate = (a) =>
      a.type === "click"
        ? { kind: "CONFIRM", reason: "Sending a message needs approval." }
        : { kind: "ALLOW", reason: "Test." };
    const m = journal();
    const d = desktop({
      controls: [{ role: "AXButton", label: "Send", x: 0.6, y: 0.7 }],
    });
    d.controller.revalidate = vi.fn(async (_a: Action, f: Frame) => ({
      ...f,
      id: "fresh",
    }));
    const mem = fakeMemory({
      context,
      plan: plan({
        steps: [
          {
            action: { type: "click", button: "left" },
            target: { role: "AXButton", label: "Send" },
          },
        ],
        outline: ["Click Send"],
      }),
    });
    const p = scripted();
    const runner = runnerWith(d.controller, p, m, mem.access);
    const running = runner.start("send it");
    await until(() => runner.snapshot.run?.status === "confirming");
    expect(runner.snapshot.pending?.action).toMatchObject({
      type: "click",
      x: 0.6,
      y: 0.7,
    });
    expect(p.next).not.toHaveBeenCalled();
    runner.confirm(false);
    await running;
    expect(d.controller.execute).not.toHaveBeenCalled();
    expect(m.of("PlanAbandoned").map((e) => e.data)).toEqual([
      { index: 0, reason: "declined" },
    ]);
    expect(m.of("UserDenied")).toHaveLength(1);
    expect(p.next).toHaveBeenCalledTimes(1);
    expect(p.observations[0].memory?.plan?.note).toContain(
      "interrupted at step 1",
    );
    expect(mem.learned[0].plan?.abandoned).toBe(true);
  });
  it("executes an approved replayed step after native revalidation", async () => {
    policy.evaluate = (a) =>
      a.type === "click"
        ? { kind: "CONFIRM", reason: "Needs approval." }
        : { kind: "ALLOW", reason: "Test." };
    const m = journal();
    const d = desktop({
      controls: [{ role: "AXButton", label: "Send", x: 0.6, y: 0.7 }],
    });
    d.controller.revalidate = vi.fn(async (_a: Action, f: Frame) => ({
      ...f,
      id: "fresh",
    }));
    const mem = fakeMemory({
      context,
      plan: plan({
        steps: [
          {
            action: { type: "click", button: "left" },
            target: { role: "AXButton", label: "Send" },
          },
        ],
        outline: ["Click Send"],
      }),
    });
    const p = scripted();
    const runner = runnerWith(d.controller, p, m, mem.access);
    const running = runner.start("send it");
    await until(() => runner.snapshot.run?.status === "confirming");
    runner.confirm(true);
    await running;
    expect(d.controller.revalidate).toHaveBeenCalledTimes(1);
    expect(d.controller.execute).toHaveBeenCalledTimes(1);
    expect(vi.mocked(d.controller.execute).mock.calls[0][0].frame_id).toBe(
      "fresh",
    );
    expect(m.of("PlanAbandoned")).toHaveLength(0);
    expect(mem.learned[0].plan).toMatchObject({
      completedSteps: 1,
      abandoned: false,
    });
  });
  it("abandons on a denied replayed step", async () => {
    policy.evaluate = (a) =>
      a.type === "type_text"
        ? { kind: "DENY", reason: "Not allowed." }
        : { kind: "ALLOW", reason: "Test." };
    const m = journal();
    const d = desktop();
    const mem = fakeMemory({
      context,
      plan: plan({
        steps: [{ action: { type: "type_text", text: "hello" } }],
        outline: ["Type hello"],
      }),
    });
    const p = scripted();
    const runner = runnerWith(d.controller, p, m, mem.access);
    await runner.start("x");
    expect(d.controller.execute).not.toHaveBeenCalled();
    expect(m.of("PlanAbandoned")[0].data).toEqual({
      index: 0,
      reason: "deny",
    });
  });
  it("abandons on STATE_CHANGED and never resumes the plan", async () => {
    allowAll();
    const m = journal();
    let calls = 0;
    const d = desktop({
      execute: async () => {
        if (++calls === 1) throw new ScreenChangedError();
      },
    });
    const mem = fakeMemory({
      context,
      plan: plan({
        steps: [
          { action: { type: "key", key: "ENTER" } },
          { action: { type: "key", key: "TAB" } },
        ],
        outline: ["Press Enter", "Press Tab"],
      }),
    });
    const p = scripted([
      (o) => ({ action: { type: "key", key: "ESC", frame_id: o.frame.id } }),
    ]);
    const runner = runnerWith(d.controller, p, m, mem.access);
    await runner.start("x");
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(m.of("PlanAbandoned").map((e) => e.data)).toEqual([
      { index: 0, reason: "state_changed" },
    ]);
    expect(m.of("PlanStepProposed")).toHaveLength(1);
    expect(p.next).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(d.controller.execute).mock.calls.map((c) => c[0].type),
    ).toEqual(["key", "key"]);
    expect(vi.mocked(d.controller.execute).mock.calls[1][0]).toMatchObject({
      key: "ESC",
    });
    expect(mem.learned[0].plan).toMatchObject({
      completedSteps: 0,
      abandoned: true,
    });
  });
  it("abandons on a native action error", async () => {
    allowAll();
    const m = journal();
    const d = desktop({
      execute: async () => {
        throw new NativeActionError("OPEN_FAILED", "Could not open.");
      },
    });
    const mem = fakeMemory({
      context,
      plan: plan({
        source: "intent",
        steps: [{ action: { type: "open_file", path: "~/Documents/Q3.xlsx" } }],
        completeWhen: { opened: true },
        outline: ["Open Q3.xlsx"],
      }),
    });
    const p = scripted();
    const runner = runnerWith(d.controller, p, m, mem.access);
    await runner.start("open q3");
    expect(m.of("PlanAbandoned")[0].data).toEqual({
      index: 0,
      reason: "native_error",
    });
    expect(m.of("ActionFailed")[0].data).toEqual({ code: "OPEN_FAILED" });
    expect(p.next).toHaveBeenCalledTimes(1);
  });
  it("completes an open_file plan when the file opened", async () => {
    allowAll();
    const m = journal();
    const d = desktop({
      execute: async () => ({
        opened: {
          path: "~/Documents/Q3.xlsx",
          kind: "document",
          appId: "com.microsoft.Excel",
        },
      }),
    });
    const mem = fakeMemory({
      context,
      plan: plan({
        source: "intent",
        steps: [{ action: { type: "open_file", path: "~/Documents/Q3.xlsx" } }],
        completeWhen: { opened: true },
        outline: ["Open Q3.xlsx"],
      }),
    });
    const p = scripted();
    const runner = runnerWith(d.controller, p, m, mem.access);
    await runner.start("open q3");
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(runner.snapshot.run?.summary).toBe("Opened Q3.xlsx.");
    expect(p.next).not.toHaveBeenCalled();
    const executed = m.of("ActionExecuted")[0].data;
    expect(executed.opened).toEqual({ kind: "document" });
    // The path appears only inside data.action.
    const { action: _action, ...rest } = executed;
    expect(JSON.stringify(rest)).not.toContain("Q3");
    expect(mem.learned[0].steps[0]).toMatchObject({
      action: { type: "open_file", path: "~/Documents/Q3.xlsx" },
      openedPath: "~/Documents/Q3.xlsx",
    });
  });
  it("tells the model what a model-proposed open_file opened", async () => {
    allowAll();
    const m = journal();
    const d = desktop({
      execute: async () => ({
        opened: { path: "~/Documents/Reports", kind: "folder" },
      }),
    });
    const p = scripted([
      (o) => ({
        action: {
          type: "open_file",
          path: "~/Documents/Reports",
          frame_id: o.frame.id,
        },
      }),
    ]);
    const runner = runnerWith(d.controller, p, m);
    await runner.start("open reports");
    expect(p.observations[1].history.at(-1)?.result).toMatch(
      /^Opened ~\/Documents\/Reports \(folder\)/,
    );
    expect(m.of("ActionExecuted")[0].data.opened).toEqual({ kind: "folder" });
  });
  it("completes a URL plan when the committed page host matches", async () => {
    allowAll();
    const m = journal();
    let executed = 0;
    const d = desktop({
      appId: "com.apple.Safari",
      domain: "www.google.com",
      execute: async () => {
        // Focus moves into the page after ENTER, so the frame carries no
        // browserAddress; only the page host tells that navigation happened.
        if (++executed === 3) d.state.domain = "www.YouTube.com";
      },
    });
    const mem = fakeMemory({
      context,
      plan: plan({
        source: "intent",
        steps: [
          {
            action: { type: "hotkey", keys: ["CMD", "L"] },
            expectAppId: "com.apple.Safari",
          },
          { action: { type: "type_text", text: "youtube.com" } },
          { action: { type: "key", key: "ENTER" } },
        ],
        completeWhen: { host: "youtube.com" },
        outline: ["Press Command-L", "Type youtube.com", "Press Enter"],
      }),
    });
    const p = scripted();
    const runner = runnerWith(d.controller, p, m, mem.access);
    await runner.start("go to youtube");
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(p.next).not.toHaveBeenCalled();
    expect(m.of("PlanCompleted")).toHaveLength(1);
    // Three step captures and one completion check, no rechecks.
    expect(d.controller.capture).toHaveBeenCalledTimes(4);
    expect(m.of("PlanStepProposed").map((e) => e.data.index)).toEqual([
      0, 1, 2,
    ]);
    expect(runner.snapshot.run?.summary).toBe(
      "Pressed Command-L, typed youtube.com, pressed Enter.",
    );
  });
  it("rechecks a bounded number of times, then asks the model", async () => {
    allowAll();
    const m = journal();
    const d = desktop();
    const mem = fakeMemory({
      context,
      plan: plan({
        source: "intent",
        steps: [{ action: { type: "open_app", name: "Calculator" } }],
        completeWhen: { appId: "com.apple.calculator" },
        outline: ["Open Calculator"],
      }),
    });
    const p = scripted();
    const runner = runnerWith(d.controller, p, m, mem.access);
    await runner.start("open calculator");
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(m.of("PlanCompleted")).toHaveLength(0);
    expect(p.next).toHaveBeenCalledTimes(1);
    // One step capture, the first check and three rechecks.
    expect(d.controller.capture).toHaveBeenCalledTimes(5);
    expect(p.observations[0].memory?.plan?.note).toContain("verify");
    expect(p.observations[0].memory?.plan?.steps).toEqual(["Open Calculator"]);
    expect(mem.learned[0].plan).toMatchObject({
      completedSteps: 1,
      abandoned: false,
    });
  });
  it("marks the plan abandoned when the run stops mid-plan", async () => {
    policy.evaluate = () => ({ kind: "CONFIRM", reason: "Approve." });
    const m = journal();
    const d = desktop();
    const mem = fakeMemory({
      context,
      plan: plan({
        steps: [{ action: { type: "key", key: "ENTER" } }],
        outline: ["Press Enter"],
      }),
    });
    const p = scripted();
    const runner = runnerWith(d.controller, p, m, mem.access);
    const running = runner.start("x");
    await until(() => runner.snapshot.run?.status === "confirming");
    runner.stop();
    await running;
    expect(runner.snapshot.run?.status).toBe("cancelled");
    expect(m.of("PlanAbandoned")).toHaveLength(1);
    expect(mem.learned).toHaveLength(1);
    expect(mem.learned[0]).toMatchObject({
      status: "cancelled",
      plan: { abandoned: true, completedSteps: 0 },
    });
  });
  it("abandons the plan when the user corrects the task", async () => {
    policy.evaluate = () => ({ kind: "CONFIRM", reason: "Approve." });
    const m = journal();
    const d = desktop();
    const mem = fakeMemory({
      context,
      plan: plan({
        steps: [{ action: { type: "key", key: "ENTER" } }],
        outline: ["Press Enter"],
      }),
    });
    const p = scripted();
    const runner = runnerWith(d.controller, p, m, mem.access);
    const running = runner.start("x");
    await until(() => runner.snapshot.run?.status === "confirming");
    policy.evaluate = () => ({ kind: "ALLOW", reason: "Test." });
    await runner.revise("Use the other button");
    await running;
    expect(m.of("PlanAbandoned").map((e) => e.data)).toEqual([
      { index: 0, reason: "correction" },
    ]);
    expect(d.controller.execute).not.toHaveBeenCalled();
    expect(mem.learned[0].corrections).toEqual(["Use the other button"]);
    expect(mem.learned[0].handsOn).toBe(true);
  });
  it("marks a correction after a fully replayed plan as hands-on", async () => {
    allowAll();
    const m = journal();
    const d = desktop();
    const mem = fakeMemory({
      context,
      plan: plan({
        steps: [{ action: { type: "key", key: "ENTER" } }],
        outline: ["Press Enter"],
      }),
    });
    let runner!: Runner;
    const p = scripted([
      () => {
        // The plan was already cleared; the correction still counts.
        void runner.revise("No, the other one");
        return new Error("superseded");
      },
      (o) => ({
        action: { type: "done", summary: "Done", frame_id: o.frame.id },
      }),
    ]);
    runner = runnerWith(d.controller, p, m, mem.access);
    await runner.start("x");
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(m.of("PlanAbandoned")).toHaveLength(0);
    expect(mem.learned[0].plan).toMatchObject({
      completedSteps: 1,
      abandoned: false,
    });
    expect(mem.learned[0].handsOn).toBe(true);
  });
});

describe("replay plans and the user's hands", () => {
  const urlPlan = () =>
    plan({
      source: "intent",
      steps: [
        {
          action: { type: "hotkey", keys: ["CMD", "L"] },
          expectAppId: "com.google.Chrome",
        },
        { action: { type: "type_text", text: "youtube.com" } },
        { action: { type: "key", key: "ENTER" } },
      ],
      completeWhen: { host: "youtube.com" },
      outline: ["Press Command-L", "Type youtube.com", "Press Enter"],
    });
  it("a manual takeover between steps ends the replay for good", async () => {
    allowAll();
    const m = journal();
    let runner!: Runner;
    const d = desktop({
      appId: "com.google.Chrome",
      onCapture: (count) => {
        // The user touches the mouse during the capture after CMD+L.
        if (count === 2) runner.manualTakeover();
      },
    });
    const mem = fakeMemory({ context, plan: urlPlan() });
    const p = scripted();
    runner = runnerWith(d.controller, p, m, mem.access);
    const running = runner.start("go to youtube.com");
    await until(() => runner.snapshot.run?.status === "paused");
    // The user clicks into a chat box, then continues.
    d.state.controls = [
      { role: "AXTextArea", label: "Message #general", x: 0.5, y: 0.9 },
    ];
    await runner.resume();
    await running;
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(m.of("PlanStepProposed").map((e) => e.data.index)).toEqual([0]);
    expect(m.of("PlanAbandoned").map((e) => e.data)).toEqual([
      { index: 1, reason: "paused" },
    ]);
    expect(
      vi.mocked(d.controller.execute).mock.calls.map((c) => c[0].type),
    ).toEqual(["hotkey"]);
    expect(p.next).toHaveBeenCalledTimes(1);
    expect(p.observations[0].memory?.plan).toEqual({
      source: "intent",
      note: "Known plan interrupted at step 2; continue from the current screen",
      steps: ["Type youtube.com", "Press Enter"],
    });
    expect(mem.learned[0]).toMatchObject({
      handsOn: true,
      plan: { completedSteps: 1, abandoned: true },
    });
  });
  it("a plain pause between steps also ends the replay", async () => {
    allowAll();
    const m = journal();
    let runner!: Runner;
    const d = desktop({
      appId: "com.google.Chrome",
      onCapture: (count) => {
        if (count === 2) runner.pause();
      },
    });
    const mem = fakeMemory({ context, plan: urlPlan() });
    const p = scripted();
    runner = runnerWith(d.controller, p, m, mem.access);
    const running = runner.start("go to youtube.com");
    await until(() => runner.snapshot.run?.status === "paused");
    await runner.resume();
    await running;
    expect(m.of("PlanStepProposed")).toHaveLength(1);
    expect(m.of("PlanAbandoned")[0].data).toEqual({
      index: 1,
      reason: "paused",
    });
    expect(d.controller.execute).toHaveBeenCalledTimes(1);
    // A pause alone is not the user acting.
    expect(mem.learned[0].handsOn).toBe(false);
  });
  it("a surface takeover between steps ends the replay", async () => {
    allowAll();
    const m = journal();
    const d = desktop({
      appId: "com.google.Chrome",
      onCapture: (count) => {
        if (count === 2) throw new SurfaceBlockedError("Protected. Take over.");
      },
    });
    const mem = fakeMemory({ context, plan: urlPlan() });
    const p = scripted();
    const runner = runnerWith(d.controller, p, m, mem.access);
    const running = runner.start("go to youtube.com");
    await until(() => runner.snapshot.run?.status === "takeover");
    await runner.resume();
    await running;
    expect(m.of("PlanAbandoned").map((e) => e.data)).toEqual([
      { index: 1, reason: "takeover" },
    ]);
    expect(d.controller.execute).toHaveBeenCalledTimes(1);
    expect(p.next).toHaveBeenCalledTimes(1);
    expect(mem.learned[0].handsOn).toBe(true);
  });
  it("keeps replaying after a capture-time STATE_CHANGED", async () => {
    allowAll();
    const m = journal();
    let executed = 0;
    const d = desktop({
      appId: "com.google.Chrome",
      onCapture: (count) => {
        // The window changes right after CMD+L: expected, not a reason to stop.
        if (count === 2) throw new ScreenChangedError();
      },
      execute: async () => {
        if (++executed === 3) d.state.domain = "youtube.com";
      },
    });
    const mem = fakeMemory({ context, plan: urlPlan() });
    const p = scripted();
    const runner = runnerWith(d.controller, p, m, mem.access);
    await runner.start("go to youtube.com");
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(m.of("PlanAbandoned")).toHaveLength(0);
    expect(m.of("PlanStepProposed").map((e) => e.data.index)).toEqual([
      0, 1, 2,
    ]);
    expect(m.of("PlanCompleted")).toHaveLength(1);
    expect(p.next).not.toHaveBeenCalled();
    expect(mem.learned[0]).toMatchObject({
      handsOn: false,
      plan: { completedSteps: 3, abandoned: false },
    });
    expect(mem.learned[0].steps.map((s) => s.fromPlan)).toEqual([
      "intent",
      "intent",
      "intent",
    ]);
  });
  it("marks a request_user hand-off as hands-on", async () => {
    const m = journal();
    const d = desktop();
    const mem = fakeMemory({ context });
    const p = scripted([
      (o) => ({
        action: {
          type: "request_user",
          reason: "Pick the conversation.",
          frame_id: o.frame.id,
        },
      }),
    ]);
    const runner = runnerWith(d.controller, p, m, mem.access);
    const running = runner.start("text hello to mom");
    await until(() => runner.snapshot.run?.status === "takeover");
    await runner.resume();
    await running;
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(mem.learned[0].handsOn).toBe(true);
  });
  it("records model steps after an abandoned plan without fromPlan", async () => {
    allowAll();
    const m = journal();
    const d = desktop();
    const mem = fakeMemory({
      context,
      plan: plan({
        steps: [
          { action: { type: "key", key: "ENTER" } },
          {
            action: { type: "click", button: "left" },
            target: { role: "AXButton", label: "Save" },
          },
        ],
        outline: ["Press Enter", "Click Save"],
      }),
    });
    const p = scripted([
      (o) => ({ action: { type: "key", key: "TAB", frame_id: o.frame.id } }),
    ]);
    const runner = runnerWith(d.controller, p, m, mem.access);
    await runner.start("save");
    expect(mem.learned[0].steps).toEqual([
      {
        action: { type: "key", key: "ENTER" },
        appId: "com.example.app",
        fromPlan: "skill",
      },
      { action: { type: "key", key: "TAB" }, appId: "com.example.app" },
    ]);
  });
});

describe("replay completion by page host", () => {
  const searchPlan = (host: string, text: string) =>
    plan({
      source: "intent",
      steps: [
        {
          action: { type: "hotkey", keys: ["CMD", "L"] },
          expectAppId: "com.apple.Safari",
        },
        { action: { type: "type_text", text } },
        { action: { type: "key", key: "ENTER" } },
      ],
      completeWhen: { host },
      outline: ["Press Command-L", `Type ${text}`, "Press Enter"],
    });
  it("never completes from the address-bar edit text", async () => {
    allowAll();
    const m = journal();
    let executed = 0;
    const d = desktop({
      appId: "com.apple.Safari",
      execute: async () => {
        // Inline autocomplete: the field text contains the domain, but the
        // committed page is elsewhere.
        if (++executed === 3) {
          d.state.browserAddress = "https://x.com/";
          d.state.domain = "x.company.com";
        }
      },
    });
    const mem = fakeMemory({ context, plan: searchPlan("x.com", "x.com") });
    const p = scripted();
    const runner = runnerWith(d.controller, p, m, mem.access);
    await runner.start("go to x.com");
    expect(m.of("PlanCompleted")).toHaveLength(0);
    expect(p.next).toHaveBeenCalledTimes(1);
    expect(p.observations[0].memory?.plan?.note).toContain("verify");
  });
  it("completes when the page host arrives during a recheck", async () => {
    allowAll();
    const m = journal();
    let captureSurfaces = 0;
    const d = desktop({ appId: "com.apple.Safari", domain: "apple.com" });
    vi.mocked(d.controller.surface).mockImplementation(async (action) => {
      // capture() asks without an action: three step captures, the first
      // completion check, then rechecks. The page commits at recheck two.
      if (!action && ++captureSurfaces === 6) d.state.domain = "www.google.com";
      return {
        appId: d.state.appId,
        pid: 42,
        secureInput: false,
        unknown: false,
        ...(d.state.domain ? { domain: d.state.domain } : {}),
      };
    });
    const mem = fakeMemory({
      context,
      plan: searchPlan("google.com", "usb c cables"),
    });
    const p = scripted();
    const runner = runnerWith(d.controller, p, m, mem.access);
    await runner.start("search google for usb c cables");
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(m.of("PlanCompleted")).toHaveLength(1);
    expect(p.next).not.toHaveBeenCalled();
    expect(d.controller.capture).toHaveBeenCalledTimes(6);
  });
  it("requires the page host to belong to the captured frontmost app", async () => {
    allowAll();
    const m = journal();
    const d = desktop({ appId: "com.apple.Safari", domain: "google.com" });
    vi.mocked(d.controller.surface).mockImplementation(async () => ({
      appId: "com.google.Chrome",
      pid: 7,
      secureInput: false,
      unknown: false,
      domain: "google.com",
    }));
    const mem = fakeMemory({
      context,
      plan: plan({
        source: "intent",
        steps: [{ action: { type: "key", key: "ENTER" } }],
        completeWhen: { host: "google.com" },
        outline: ["Press Enter"],
      }),
    });
    const p = scripted();
    const runner = runnerWith(d.controller, p, m, mem.access);
    await runner.start("search");
    expect(m.of("PlanCompleted")).toHaveLength(0);
    expect(p.next).toHaveBeenCalledTimes(1);
  });
  it("a pause while checking the result hands off a verify hint", async () => {
    allowAll();
    const m = journal();
    const d = desktop({ appId: "com.apple.Safari" });
    const mem = fakeMemory({
      context,
      plan: searchPlan("google.com", "usb c cables"),
    });
    const p = scripted();
    const runner = runnerWith(d.controller, p, m, mem.access);
    const running = runner.start("search google for usb c cables");
    await until(() => runner.snapshot.message === "Checking the result.");
    runner.pause();
    const capturesAtPause = vi.mocked(d.controller.capture).mock.calls.length;
    await tick();
    expect(d.controller.capture).toHaveBeenCalledTimes(capturesAtPause);
    await runner.resume();
    await running;
    expect(m.of("PlanAbandoned").map((e) => e.data)).toEqual([
      { index: 3, reason: "paused" },
    ]);
    expect(p.next).toHaveBeenCalledTimes(1);
    expect(p.observations[0].memory?.plan).toEqual({
      source: "intent",
      note: "Known plan steps were executed; verify the result on the current screen and finish",
      steps: ["Press Command-L", "Type usb c cables", "Press Enter"],
    });
  });
});

describe("replay control labels", () => {
  it("resolves a learned label longer than the native label limit", async () => {
    allowAll();
    const m = journal();
    const long =
      "Read the complete quarterly report on regional sales performance and the outlook for next year";
    expect(long.length).toBeGreaterThan(80);
    const d = desktop({
      controls: [
        { role: "AXLink", label: long.slice(0, 80), x: 0.4, y: 0.5 },
        { role: "AXLink", label: "Read", x: 0.1, y: 0.1 },
      ],
    });
    const mem = fakeMemory({
      context,
      plan: plan({
        steps: [
          {
            action: { type: "click", button: "left" },
            target: { role: "AXLink", label: long },
          },
        ],
        outline: ["Click the report link"],
      }),
    });
    const p = scripted();
    const runner = runnerWith(d.controller, p, m, mem.access);
    await runner.start("open the report");
    expect(m.of("PlanAbandoned")).toHaveLength(0);
    expect(vi.mocked(d.controller.execute).mock.calls[0][0]).toMatchObject({
      type: "click",
      x: 0.4,
      y: 0.5,
    });
  });
  it("abandons when two cut labels match a long learned label", async () => {
    allowAll();
    const m = journal();
    const long =
      "Read the complete quarterly report on regional sales performance and the outlook for next year";
    const d = desktop({
      controls: [
        { role: "AXLink", label: long.slice(0, 80), x: 0.4, y: 0.5 },
        { role: "AXLink", label: long.slice(0, 80), x: 0.4, y: 0.9 },
      ],
    });
    const mem = fakeMemory({
      context,
      plan: plan({
        steps: [
          {
            action: { type: "click", button: "left" },
            target: { role: "AXLink", label: long },
          },
        ],
        outline: ["Click the report link"],
      }),
    });
    const p = scripted();
    const runner = runnerWith(d.controller, p, m, mem.access);
    await runner.start("open the report");
    expect(d.controller.execute).not.toHaveBeenCalled();
    expect(m.of("PlanAbandoned")[0].data).toEqual({
      index: 0,
      reason: "ambiguous_control",
    });
  });
  it("does not treat a short live label as a prefix of a learned label", async () => {
    allowAll();
    const m = journal();
    const d = desktop({
      controls: [{ role: "AXButton", label: "Save", x: 0.4, y: 0.5 }],
    });
    const mem = fakeMemory({
      context,
      plan: plan({
        steps: [
          {
            action: { type: "click", button: "left" },
            target: { role: "AXButton", label: "Save and close" },
          },
        ],
        outline: ["Click Save and close"],
      }),
    });
    const p = scripted();
    const runner = runnerWith(d.controller, p, m, mem.access);
    await runner.start("save and close");
    expect(d.controller.execute).not.toHaveBeenCalled();
    expect(m.of("PlanAbandoned")[0].data).toEqual({
      index: 0,
      reason: "missing_control",
    });
  });
});

describe("runner learning", () => {
  it("calls learn once with trajectory, targets, apps and outcome", async () => {
    allowAll();
    const m = journal();
    const d = desktop({
      appId: "com.apple.Notes",
      surface: { targetRole: "AXButton", targetLabel: "New Note" },
    });
    const p = scripted([
      (o) => ({
        action: { type: "click", x: 0.2, y: 0.3, frame_id: o.frame.id },
        usage: { inputTokens: 10, outputTokens: 2, cost: 0.01 },
      }),
      (o) => ({
        action: { type: "type_text", text: "groceries", frame_id: o.frame.id },
      }),
    ]);
    const mem = fakeMemory({ context });
    const runner = runnerWith(d.controller, p, m, mem.access);
    await runner.start("new note groceries");
    expect(mem.access.learn).toHaveBeenCalledTimes(1);
    const input = mem.learned[0];
    expect(input).toMatchObject({
      runId: runner.snapshot.run!.id,
      task: "new note groceries",
      status: "completed",
      synthetic: false,
      summary: "Done",
      corrections: [],
      appsSeen: ["com.apple.Notes"],
      usage: { inputTokens: 10, outputTokens: 2, cost: 0.01 },
    });
    expect(input).not.toHaveProperty("plan");
    expect(input.handsOn).toBe(false);
    expect(input.steps).toEqual([
      {
        action: { type: "click", x: 0.2, y: 0.3, button: "left" },
        appId: "com.apple.Notes",
        target: { role: "AXButton", label: "New Note" },
      },
      {
        action: { type: "type_text", text: "groceries" },
        appId: "com.apple.Notes",
      },
    ]);
    for (const step of input.steps)
      expect(step.action).not.toHaveProperty("frame_id");
  });
  it("learns failed runs once too", async () => {
    const m = journal();
    const d = desktop();
    const p = scripted([
      (o) => ({
        action: { type: "fail", reason: "Nope", frame_id: o.frame.id },
      }),
    ]);
    const mem = fakeMemory({ context });
    const runner = runnerWith(d.controller, p, m, mem.access);
    await runner.start("x");
    expect(runner.snapshot.run?.status).toBe("failed");
    expect(mem.access.learn).toHaveBeenCalledTimes(1);
    expect(mem.learned[0].status).toBe("failed");
  });
  it("a throwing learn does not affect the run", async () => {
    const m = journal();
    const d = desktop();
    const access: MemoryAccess = {
      recall: async () => ({ context }),
      learn: vi.fn(() => {
        throw new Error("disk full");
      }),
    };
    const p = scripted();
    const runner = runnerWith(d.controller, p, m, access);
    await expect(runner.start("x")).resolves.toBeUndefined();
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(runner.settled).toBe(true);
    expect(access.learn).toHaveBeenCalledTimes(1);
    // A later run still works and learns again.
    await runner.start("y");
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(access.learn).toHaveBeenCalledTimes(2);
  });
  it("a rejecting async learn is swallowed", async () => {
    const m = journal();
    const d = desktop();
    const access = {
      recall: async () => ({ context }),
      learn: vi.fn(() => Promise.reject(new Error("later"))),
    } as unknown as MemoryAccess;
    const p = scripted();
    const runner = runnerWith(d.controller, p, m, access);
    await runner.start("x");
    await tick();
    expect(runner.snapshot.run?.status).toBe("completed");
  });
});
