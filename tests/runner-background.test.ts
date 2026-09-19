import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
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
  type Rung,
  type RunTarget,
  type ScreenContext,
  type Settings,
  type Surface,
  type TargetSpec,
} from "../src/core/schema";
import {
  MANUAL_PAUSE_MESSAGE,
  Runner,
  type RunPrelude,
} from "../src/core/runner";
import {
  BACKGROUND_NOTE,
  finishInFront,
  foregroundHandoff,
  foregroundRequest,
  noWindowInFront,
  routeSkipped,
  targetGoneMessage,
  targetHold,
} from "../src/core/background";
import { TargetError } from "../src/core/errors";
import type { LearnInput, MemoryAccess, Recall } from "../src/core/memory";

/**
 * A run bound to a window the user is not looking at
 * (.data/design/background-actuation.md), driven against a fake controller
 * that answers the §6.5 contract: where the run binds, which rungs it tries
 * and in what order, what it remembers, what it tells the model, when the
 * user's own hands pause it, and when it asks for the window.
 */
const SLACK = "com.tinyspeck.slackmacgap";
const target: RunTarget = {
  token: "tok-slack-0001",
  pid: 501,
  windowId: 77,
  appId: SLACK,
  appName: "Slack",
  title: "Prateek (DM)",
};
const display = {
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
const windowFrame = { id: 77, x: 100, y: 80, width: 900, height: 600 };
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
  let run: Run;
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

/** The surface the bound window reports for one step. */
function surfaceFor(action?: Action): Partial<Surface> {
  if (!action) return {};
  if (action.type === "click_control")
    return {
      controlStatus: "resolved",
      controlLabel: action.label,
      targetRole: "AXButton",
      targetLabel: action.label,
    };
  if (action.type === "type_text") return { focusedRole: "AXTextArea" };
  if (action.type === "menu_item")
    return { menuStatus: "resolved", menuLabel: action.path.at(-1) };
  if (action.type === "open_app")
    return {
      launcherStatus: "resolved",
      launcherAppId: "com.apple.Notes",
      launcherName: action.name,
    };
  return {};
}
type Deliver = (
  action: Action,
  rungs: Rung[],
  call: number,
) => ExecutionResult | Promise<ExecutionResult>;
/**
 * A desktop with one Slack window to bind and the user's own app in front.
 * The screen methods answer as the user's app; the target methods as the
 * bound window.
 */
function desktop(
  options: {
    bind?: (spec: TargetSpec) => RunTarget | Promise<RunTarget>;
    deliver?: Deliver;
    frontmost?: () => boolean | Promise<boolean>;
    surface?: Partial<Surface>;
    controls?: ScreenContext["controls"];
  } = {},
) {
  let captures = 0;
  let deliveries = 0;
  const deliver: Deliver =
    options.deliver ??
    ((_action, rungs) => ({ rung: rungs[0], effect: "changed" }));
  const controller = {
    kind: "native" as const,
    // The screen: the user's own application.
    surface: vi.fn(async (action?: Action): Promise<Surface> => ({
      appId: "com.apple.mail",
      pid: 9,
      secureInput: false,
      unknown: false,
      ...surfaceFor(action),
    })),
    capture: vi.fn(async (): Promise<Frame> => ({
      id: `screen-${++captures}`,
      sha256: "screen",
      image: "",
      geometry: display,
      capturedAt: 0,
      synthetic: false,
      appId: "com.apple.mail",
      context: { appName: "Mail", windowTitle: "Inbox" },
    })),
    execute: vi.fn(async (): Promise<void | ExecutionResult> => undefined),
    resume: vi.fn(async () => {}),
    stop: vi.fn(() => {}),
    restore: vi.fn(async () => {}),
    revalidate: vi.fn(async (_a: Action, f: Frame) => f),
    // The bound window.
    bindTarget: vi.fn(async (spec: TargetSpec) =>
      options.bind ? options.bind(spec) : target,
    ),
    captureTarget: vi.fn(async (): Promise<Frame> => ({
      id: `window-${++captures}`,
      sha256: "window",
      image: "",
      geometry: { ...display, window: { ...windowFrame } },
      capturedAt: 0,
      synthetic: false,
      appId: SLACK,
      context: {
        appName: "Slack",
        windowTitle: "Prateek (DM)",
        controls: options.controls ?? [
          { role: "button", label: "Reply", x: 0.9, y: 0.9 },
          { role: "button", label: "Send", x: 0.95, y: 0.9 },
        ],
        background: {
          appName: "Slack",
          title: "Prateek (DM)",
          covered: false,
          staleRisk: true,
          minimized: false,
        },
      },
    })),
    surfaceTarget: vi.fn(
      async (_token: string, action?: Action): Promise<Surface> => ({
        appId: SLACK,
        appName: "Slack",
        pid: 501,
        secureInput: false,
        unknown: false,
        target: {
          bound: true,
          covered: false,
          minimized: false,
          focusedWindow: true,
          siblingWindows: 0,
        },
        ...surfaceFor(action),
        ...options.surface,
      }),
    ),
    revalidateTarget: vi.fn(async (_t: string, _a: Action, f: Frame) => ({
      ...f,
      id: `window-${++captures}`,
      // The user nudged the window meanwhile.
      geometry: {
        ...display,
        window: { ...windowFrame, x: windowFrame.x + 40 },
      },
    })),
    executeTarget: vi.fn(
      async (_t: string, action: Action, _f: Frame, rungs: Rung[]) =>
        deliver(action, rungs, ++deliveries),
    ),
    foregroundTarget: vi.fn(async () => ({
      frontmost: options.frontmost ? await options.frontmost() : true,
    })),
    unbindTarget: vi.fn(async () => {}),
  };
  return controller as typeof controller & Controller;
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
const step = (action: Record<string, unknown>) => (o: Observation) => ({
  action: { ...action, frame_id: o.frame.id },
});
const reply = step({ type: "click_control", label: "Reply" });
const typing = step({ type: "type_text", text: "running ten minutes late" });
function fakeMemory(recall: Recall) {
  const learned: LearnInput[] = [];
  const access: MemoryAccess = {
    recall: vi.fn(async () => structuredClone(recall)),
    learn: vi.fn((input: LearnInput) => {
      learned.push(structuredClone(input));
    }),
  };
  return { access, learned };
}
function runnerWith(
  c: Controller,
  p: { next: ReturnType<typeof scripted>["next"] },
  m: ReturnType<typeof journal>,
  o: { memory?: MemoryAccess; settings?: Settings; messages?: string[] } = {},
) {
  return new Runner(
    c,
    p,
    m.recorder,
    o.settings ?? settings,
    // Each message once, however many snapshots carried it.
    (s) => {
      if (o.messages && o.messages.at(-1) !== s.message)
        o.messages.push(s.message);
    },
    [],
    o.memory,
  );
}
const start = (runner: Runner, task: string, extra: object = {}) =>
  runner.start(task, {
    origin: "voice",
    taskSource: "user_words",
    background: true,
    ...extra,
  });

describe("binding the window (design §2.2)", () => {
  it("binds the window the words name and works there, never on the screen", async () => {
    const c = desktop();
    const m = journal();
    const provider = scripted([reply]);
    const memory = fakeMemory({ context: { preferences: [], episodes: [] } });
    const runner = runnerWith(c, provider, m, { memory: memory.access });
    await start(runner, "In Slack, tell Prateek I'm running late");
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(c.bindTarget).toHaveBeenCalledWith({ app: "Slack" });
    expect(m.of("TargetBound").map((e) => e.data)).toEqual([
      { appId: SLACK, windowId: 77, by: "words" },
    ]);
    expect(m.getRun().target).toEqual({ ...target, background: true });
    // Every observation and every input went to the bound window.
    expect(c.capture).not.toHaveBeenCalled();
    expect(c.surface).not.toHaveBeenCalled();
    expect(c.execute).not.toHaveBeenCalled();
    expect(c.captureTarget).toHaveBeenCalledTimes(2);
    expect(c.executeTarget).toHaveBeenCalledTimes(1);
    expect(c.executeTarget.mock.calls[0].slice(0, 2)).toEqual([
      target.token,
      expect.objectContaining({ type: "click_control", label: "Reply" }),
    ]);
    expect(c.executeTarget.mock.calls[0][3]).toEqual(["ax", "post"]);
    // The model reads the standing note on its copy alone.
    const observed = provider.observations[0].frame.context?.background;
    expect(observed).toMatchObject({
      appName: "Slack",
      covered: false,
      staleRisk: true,
      note: BACKGROUND_NOTE,
    });
    expect(m.frames[0].context?.background?.note).toBeUndefined();
    expect(runner.snapshot.frame?.context?.background?.note).toBeUndefined();
    // The history names the rung and what the read found; the journal too.
    expect(provider.observations[1].history.at(-1)?.result).toBe(
      "Executed click on button “Reply” by accessibility; the window changed. Verify the next screenshot.",
    );
    expect(m.of("ActionExecuted")[0].data).toMatchObject({
      rung: "ax",
      effect: "changed",
    });
    expect(c.unbindTarget).toHaveBeenCalledWith(target.token);
    expect(memory.learned[0].background).toEqual([
      { appId: SLACK, appName: "Slack", route: "press", verdict: "works" },
    ]);
  });
  it("a named application with no window is said so, and the run takes the screen", async () => {
    const c = desktop({
      bind: async () => {
        throw new TargetError("TARGET_GONE", "Zoom has no window.");
      },
    });
    const m = journal();
    const messages: string[] = [];
    const runner = runnerWith(c, scripted(), m, { messages });
    await start(runner, "tell Prateek I'm late in Zoom");
    // Never the window the user happens to be in instead of the one asked for.
    expect(c.bindTarget.mock.calls.map(([spec]) => spec)).toEqual([
      { app: "Zoom" },
    ]);
    expect(m.of("TargetBound")).toHaveLength(0);
    expect(messages).toContain(noWindowInFront("Zoom"));
    expect(c.capture).toHaveBeenCalled();
    expect(m.getRun().target).toBeUndefined();
  });
  it("skips words that are not an application, then binds the prelude's or the focused window", async () => {
    const c = desktop({
      bind: async (spec) => {
        if (spec.app) throw new Error("No such application.");
        return target;
      },
    });
    const m = journal();
    await start(runnerWith(c, scripted(), m), "tell Prateek I'm late in Zoom");
    expect(c.bindTarget.mock.calls.map(([spec]) => spec)).toEqual([
      { app: "Zoom" },
      {},
    ]);
    expect(m.of("TargetBound")[0].data).toMatchObject({ by: "focus" });

    const prelude: RunPrelude = {
      frame: {
        id: "early-1",
        sha256: "e",
        image: "",
        geometry: display,
        capturedAt: 0,
        synthetic: false,
        appId: "com.apple.Notes",
      },
      surface: {
        appId: "com.apple.Notes",
        pid: 3,
        secureInput: false,
        unknown: false,
      },
      action: { type: "open_app", name: "Notes", frame_id: "early-1" },
      reason: "Open a verified installed application.",
      outcome: {
        launched: {
          appId: "com.apple.Notes",
          name: "Notes",
          frontmost: true,
          wasRunning: true,
        },
      },
      completes: false,
    };
    const opened = desktop();
    const m2 = journal();
    await start(runnerWith(opened, scripted(), m2), "open Notes and add milk", {
      prelude,
    });
    expect(opened.bindTarget).toHaveBeenCalledWith({ app: "Notes" });
    expect(m2.of("TargetBound")[0].data).toMatchObject({ by: "prelude" });
  });
  it("a texted task binds by its words alone, and takes the screen when nothing binds", async () => {
    const c = desktop({
      bind: async () => {
        throw new Error("No such application.");
      },
    });
    const m = journal();
    const runner = runnerWith(c, scripted(), m);
    await start(runner, "tell Prateek I'm late in Zoom", { origin: "message" });
    expect(c.bindTarget.mock.calls.map(([spec]) => spec)).toEqual([
      { app: "Zoom" },
    ]);
    expect(m.getRun().target).toBeUndefined();
    expect(m.of("TargetBound")).toHaveLength(0);
    expect(c.capture).toHaveBeenCalled();
    expect(c.captureTarget).not.toHaveBeenCalled();
  });
  it("never binds when the setting is off, for a helper without targets, or unasked", async () => {
    const off = desktop();
    await start(
      runnerWith(off, scripted(), journal(), {
        settings: { ...settings, workInBackground: false },
      }),
      "in Slack, say hi",
    );
    expect(off.bindTarget).not.toHaveBeenCalled();
    const unasked = desktop();
    await runnerWith(unasked, scripted(), journal()).start("in Slack, say hi");
    expect(unasked.bindTarget).not.toHaveBeenCalled();
    const { bindTarget: _b, ...plain } = desktop();
    const m = journal();
    await start(
      runnerWith(plain as Controller, scripted(), m),
      "in Slack, say hi",
    );
    expect(m.getRun().target).toBeUndefined();
    expect(plain.capture).toHaveBeenCalled();
  });
});

describe("the ladder and what it remembers (design §2.5, §2.7, §5)", () => {
  it("steps down a rung on no effect, remembers the miss, and skips the rung after two", async () => {
    const c = desktop({
      deliver: (_a, rungs) => ({
        rung: rungs[rungs.length - 1],
        effect: "changed",
      }),
    });
    const m = journal();
    const provider = scripted([reply, reply, reply]);
    const memory = fakeMemory({ context: { preferences: [], episodes: [] } });
    const runner = runnerWith(c, provider, m, { memory: memory.access });
    await start(runner, "in Slack, reply");
    expect(c.executeTarget.mock.calls.map((call) => call[3])).toEqual([
      ["ax", "post"],
      ["ax", "post"],
      ["post"],
    ]);
    expect(m.of("RungStepped").map((e) => e.data)).toEqual([
      { from: "ax", to: "post", actionType: "click_control" },
      { from: "ax", to: "post", actionType: "click_control" },
    ]);
    expect(provider.observations[1].history.at(-1)?.result).toContain(
      "by events posted to Slack; the window changed",
    );
    expect(memory.learned[0].background).toEqual([
      { appId: SLACK, appName: "Slack", route: "press", verdict: "noop" },
      { appId: SLACK, appName: "Slack", route: "post", verdict: "works" },
      { appId: SLACK, appName: "Slack", route: "press", verdict: "noop" },
      { appId: SLACK, appName: "Slack", route: "post", verdict: "works" },
      { appId: SLACK, appName: "Slack", route: "post", verdict: "works" },
    ]);
  });
  it("starts at the right rung from memory and names it once", async () => {
    const c = desktop();
    const m = journal();
    const messages: string[] = [];
    const memory = fakeMemory({
      context: { preferences: [], episodes: [] },
      background: { [SLACK]: { write: "noop" } },
    });
    const runner = runnerWith(c, scripted([typing, typing, reply]), m, {
      memory: memory.access,
      messages,
    });
    await start(runner, "in Slack, tell Prateek I'm late");
    expect(c.executeTarget.mock.calls.map((call) => call[3])).toEqual([
      ["post"],
      ["post"],
      ["ax", "post"],
    ]);
    expect(m.of("BackgroundRouteSkipped").map((e) => e.data)).toEqual([
      { route: "write" },
    ]);
    expect(
      messages.filter((t) => t === routeSkipped("Slack", "write")),
    ).toHaveLength(1);
  });
  it("reports an unverifiable write honestly and remembers nothing from it", async () => {
    const c = desktop({
      deliver: () => ({ rung: "ax", effect: "unverifiable" }),
    });
    const m = journal();
    const provider = scripted([typing]);
    const memory = fakeMemory({ context: { preferences: [], episodes: [] } });
    await start(
      runnerWith(c, provider, m, { memory: memory.access }),
      "in Slack, type",
    );
    expect(provider.observations[1].history.at(-1)?.result).toContain(
      "by an accessibility write; whether it took could not be read",
    );
    expect(c.foregroundTarget).not.toHaveBeenCalled();
    expect(memory.learned[0].background).toBeUndefined();
  });
  it("a menu item is pressed by accessibility and never asks for the window", async () => {
    const c = desktop({ deliver: () => ({ rung: "ax", effect: "none" }) });
    const m = journal();
    const provider = scripted([
      step({ type: "menu_item", path: ["File", "New Message"] }),
    ]);
    await start(runnerWith(c, provider, m), "in Slack, start a message");
    expect(c.executeTarget.mock.calls[0][3]).toEqual(["ax"]);
    expect(c.foregroundTarget).not.toHaveBeenCalled();
    expect(provider.observations[1].history.at(-1)?.result).toContain(
      "nothing changed, so Slack may ignore this route",
    );
    expect(m.of("ActionExecuted")).toHaveLength(1);
  });
});

describe("rung 3: the announced foreground hand-off (design §2.8)", () => {
  const missesThenFront: Deliver = (_a, rungs) =>
    rungs[0] === "foreground"
      ? { rung: "foreground", effect: "changed" }
      : { rung: rungs[rungs.length - 1], effect: "none" };
  it("says it needs the window, fronts it, acts as before, and returns to the background", async () => {
    const order: string[] = [];
    const c = desktop({ deliver: missesThenFront });
    c.foregroundTarget.mockImplementation(async () => {
      order.push("front");
      return { frontmost: true };
    });
    c.executeTarget.mockImplementation(async (_t, action, _f, rungs) => {
      order.push(`execute:${rungs.join("+")}`);
      return missesThenFront(action, rungs, 0);
    });
    const m = journal();
    const messages: string[] = [];
    const provider = scripted([reply, reply]);
    const runner = runnerWith(c, provider, m, { messages });
    await start(runner, "in Slack, reply");
    expect(order).toEqual([
      "execute:ax+post",
      "front",
      "execute:foreground",
      "execute:ax+post",
      "front",
      "execute:foreground",
    ]);
    expect(messages).toContain(foregroundRequest("Slack"));
    expect(m.of("ForegroundRequested").map((e) => e.data)).toEqual([
      { reason: "no_effect", actionType: "click_control" },
      { reason: "no_effect", actionType: "click_control" },
    ]);
    expect(m.of("RungStepped").map((e) => e.data)).toEqual([
      { from: "ax", to: "post", actionType: "click_control" },
      { from: "post", to: "foreground", actionType: "click_control" },
      { from: "ax", to: "post", actionType: "click_control" },
      { from: "post", to: "foreground", actionType: "click_control" },
    ]);
    expect(provider.observations[1].history.at(-1)?.result).toBe(
      "Executed click on button “Reply” with Slack in front for a second; the window changed. Verify the next screenshot.",
    );
    // Still a background run afterwards; the user's app was restored natively.
    expect(m.getRun().target?.background).toBe(true);
    expect(c.restore).not.toHaveBeenCalled();
  });
  it("hands over when the activation does not take", async () => {
    const c = desktop({ deliver: missesThenFront, frontmost: () => false });
    const m = journal();
    const runner = runnerWith(c, scripted([reply]), m);
    const running = start(runner, "in Slack, reply");
    await until(() => runner.snapshot.run?.status === "takeover");
    expect(runner.snapshot.message).toBe(foregroundHandoff("Slack"));
    expect(m.of("UserTakeoverStarted").map((e) => e.data)).toEqual([
      { source: "handoff" },
    ]);
    expect(c.executeTarget.mock.calls.map((call) => call[3])).toEqual([
      ["ax", "post"],
    ]);
    runner.stop();
    await running;
  });
  it("goes in front for a step the helper has no background route for", async () => {
    const c = desktop({
      deliver: (_a, rungs) => {
        if (rungs[0] === "foreground")
          return { rung: "foreground", effect: "changed" };
        throw new TargetError(
          "KEYBOARD_AMBIGUOUS",
          "Two Slack windows are open.",
        );
      },
    });
    const m = journal();
    await start(runnerWith(c, scripted([typing]), m), "in Slack, type it");
    expect(m.of("ForegroundRequested")[0].data).toMatchObject({
      reason: "KEYBOARD_AMBIGUOUS",
    });
    expect(c.foregroundTarget).toHaveBeenCalledTimes(1);
    expect(m.of("ActionExecuted")).toHaveLength(1);
  });
  it("past three detours in ten steps it says so and finishes in front", async () => {
    const c = desktop({ deliver: missesThenFront });
    const m = journal();
    const messages: string[] = [];
    const runner = runnerWith(c, scripted([reply, reply, reply, reply]), m, {
      messages,
    });
    await start(runner, "in Slack, reply");
    expect(m.of("ForegroundRequested").map((e) => e.data.final)).toEqual([
      undefined,
      undefined,
      true,
    ]);
    expect(messages).toContain(finishInFront("Slack"));
    expect(m.of("TargetLeft").map((e) => e.data)).toEqual([{ reason: "cap" }]);
    expect(m.getRun().target?.background).toBe(false);
    // The third detour brought the window back in front for good.
    expect(c.foregroundTarget).toHaveBeenCalledTimes(4);
    // The fourth step went the way every step went before.
    expect(c.execute).toHaveBeenCalledTimes(1);
    expect(c.capture).toHaveBeenCalled();
    // Two misses on each background route pruned them before the third step.
    expect(c.executeTarget.mock.calls.map((call) => call[3])).toEqual([
      ["ax", "post"],
      ["foreground"],
      ["ax", "post"],
      ["foreground"],
      ["foreground"],
    ]);
    expect(m.of("ForegroundRequested").map((e) => e.data.reason)).toEqual([
      "no_effect",
      "no_effect",
      "pruned",
    ]);
  });
});

describe("the user's hands (design §3)", () => {
  async function thinking(c: Controller, m = journal(), extra = {}) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const provider = scripted([
      (o) => {
        return {
          action: { type: "done", summary: "Done", frame_id: o.frame.id },
        };
      },
    ]);
    provider.next.mockImplementationOnce(async (o) => {
      await gate;
      return {
        usage,
        action: { type: "done", summary: "Done", frame_id: o.frame.id },
      };
    });
    const runner = runnerWith(c, provider, m, extra);
    const running = start(runner, "in Slack, reply");
    await until(() => runner.snapshot.run?.status === "thinking");
    return { runner, running, release, m };
  }
  it("elsewhere is normal life; in the bound window it pauses; unbound it pauses as before", async () => {
    const { runner, running, release, m } = await thinking(desktop());
    runner.manualTakeover("screen");
    await tick();
    expect(runner.snapshot.run?.status).toBe("thinking");
    expect(m.of("UserTakeoverStarted")).toHaveLength(0);
    runner.manualTakeover("target");
    expect(runner.snapshot.run?.status).toBe("paused");
    expect(runner.snapshot.message).toBe(targetHold("Slack"));
    expect(m.of("UserTakeoverStarted").map((e) => e.data)).toEqual([
      { source: "manual_input", scope: "target" },
    ]);
    release();
    runner.stop();
    await running;

    const c = desktop({
      bind: async () => {
        throw new Error("No such application.");
      },
    });
    const plain = await thinking(c);
    plain.runner.manualTakeover("screen");
    expect(plain.runner.snapshot.message).toBe(MANUAL_PAUSE_MESSAGE);
    expect(plain.m.of("UserTakeoverStarted").map((e) => e.data)).toEqual([
      { source: "manual_input", scope: "screen" },
    ]);
    plain.release();
    plain.runner.stop();
    await plain.running;
  });
  it("while the window is in front for a step, input anywhere pauses the run", async () => {
    let runner!: Runner;
    const c = desktop({
      deliver: (_a, rungs) => ({
        rung: rungs[rungs.length - 1],
        effect: "none",
      }),
      frontmost: () => {
        runner.manualTakeover("screen");
        return true;
      },
    });
    const m = journal();
    runner = runnerWith(c, scripted([reply]), m);
    const running = start(runner, "in Slack, reply");
    await until(() => runner.snapshot.run?.status === "paused");
    expect(runner.snapshot.message).toBe(MANUAL_PAUSE_MESSAGE);
    expect(c.executeTarget.mock.calls.map((call) => call[3])).toEqual([
      ["ax", "post"],
    ]);
    runner.stop();
    await running;
  });
  it("a self-activation is journaled; a window that went away pauses and then the run continues in front", async () => {
    const { runner, running, release, m } = await thinking(desktop());
    runner.targetSelfActivated();
    expect(runner.snapshot.run?.status).toBe("thinking");
    expect(m.of("TargetSelfActivated")).toHaveLength(1);
    runner.targetGone("TARGET_GONE");
    expect(runner.snapshot.run?.status).toBe("paused");
    expect(runner.snapshot.message).toBe(targetGoneMessage("Slack"));
    expect(m.of("TargetLeft").map((e) => e.data)).toEqual([
      { reason: "gone", code: "TARGET_GONE" },
    ]);
    expect(m.getRun().target?.background).toBe(false);
    release();
    await runner.resume();
    await running;
    expect(runner.snapshot.run?.status).toBe("completed");
    const c = runner["controller"] as ReturnType<typeof desktop>;
    expect(c.capture).toHaveBeenCalled();
    expect(c.unbindTarget).toHaveBeenCalledWith(target.token);
  });
});

describe("policy and approvals on the bound window (design §4)", () => {
  it("asks as in front, revalidates the window where it is, and forgives a nudge", async () => {
    const c = desktop();
    const m = journal();
    const runner = runnerWith(
      c,
      scripted([step({ type: "click_control", label: "Send" })]),
      m,
    );
    const running = start(runner, "in Slack, send it");
    await until(() => runner.snapshot.run?.status === "confirming");
    expect(runner.snapshot.pending?.reason).toBe("Send this message?");
    runner.confirm(true);
    await running;
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(c.revalidateTarget).toHaveBeenCalledTimes(1);
    expect(c.restore).not.toHaveBeenCalled();
    expect(c.revalidate).not.toHaveBeenCalled();
    expect(m.of("ActionFailed")).toHaveLength(0);
    expect(c.executeTarget.mock.calls[0][1]).toMatchObject({ approved: true });
  });
  it("refuses a surface from another process and an open_app, sending nothing", async () => {
    const c = desktop({ surface: { pid: 999 } });
    const m = journal();
    const provider = scripted([reply]);
    await start(runnerWith(c, provider, m), "in Slack, reply");
    expect(c.executeTarget).not.toHaveBeenCalled();
    expect(m.of("UserDenied")).toHaveLength(1);
    expect(provider.observations[1].history.at(-1)?.result).toContain(
      "not the Slack window this run is bound to",
    );
    const opens = desktop();
    const m2 = journal();
    const p2 = scripted([step({ type: "open_app", name: "Notes" })]);
    await start(runnerWith(opens, p2, m2), "in Slack, reply");
    expect(opens.executeTarget).not.toHaveBeenCalled();
    expect(p2.observations[1].history.at(-1)?.result).toContain(
      "already the window in the screenshot",
    );
  });
  it("a protected target hands over; a route the helper refuses is reported", async () => {
    const c = desktop({
      deliver: () => {
        throw new TargetError(
          "TARGET_PROTECTED",
          "A protected website is active.",
        );
      },
    });
    const m = journal();
    const runner = runnerWith(c, scripted([reply]), m);
    const running = start(runner, "in Slack, reply");
    await until(() => runner.snapshot.run?.status === "takeover");
    expect(m.of("UserTakeoverStarted")[0].data).toEqual({ source: "surface" });
    runner.stop();
    await running;

    const menu = desktop({
      deliver: () => {
        throw new TargetError(
          "RUNG_UNAVAILABLE",
          "Menus are not readable here.",
        );
      },
    });
    const m2 = journal();
    const p2 = scripted([
      step({ type: "menu_item", path: ["File", "New Message"] }),
    ]);
    await start(runnerWith(menu, p2, m2), "in Slack, start a message");
    expect(menu.foregroundTarget).not.toHaveBeenCalled();
    expect(m2.of("ActionFailed").map((e) => e.data.code)).toEqual([
      "RUNG_UNAVAILABLE",
    ]);
    expect(p2.observations[1].history.at(-1)?.result).toBe(
      "No input was sent. Menus are not readable here.",
    );
  });
  it("move sends nothing, wait waits, monitor and a screen capture are refused or empty", async () => {
    const c = desktop();
    const m = journal();
    const provider = scripted([
      step({ type: "move", x: 0.5, y: 0.5 }),
      step({ type: "wait", milliseconds: 1 }),
      step({ type: "monitor", reason: "watch it" }),
    ]);
    const runner = new Runner(
      c,
      provider,
      m.recorder,
      settings,
      () => {},
      [],
      undefined,
      {
        onMonitor: vi.fn(),
      },
    );
    await start(runner, "in Slack, wait");
    expect(c.executeTarget).not.toHaveBeenCalled();
    expect(c.bindWatch).toBeUndefined();
    expect(provider.observations[1].history.at(-1)?.result).toContain(
      "There is no cursor to move in a background window",
    );
    expect(
      m.of("ActionExecuted").map((e) => (e.data.action as Action).type),
    ).toEqual(["wait"]);
    expect(provider.observations[3].history.at(-1)?.result).toContain(
      "Monitoring isn't available here",
    );
  });
});

describe("main.ts wiring", () => {
  // main.ts is not loaded in tests; the wiring is pinned by reading it.
  const source = readFileSync(
    new URL("../electron/main.ts", import.meta.url),
    "utf8",
  );
  const fn = (name: string) => {
    const at = source.indexOf(`function ${name}(`);
    expect([name, at > 0]).toEqual([name, true]);
    return source.slice(at, source.indexOf("\n}\n", at));
  };
  it("passes the tap's scope to the runner and the target events to it", () => {
    const native = fn("getNative");
    expect(native).toMatch(
      /\(scope\) => \{[\s\S]*runner\?\.manualTakeover\(scope\);/,
    );
    expect(native).toContain(
      "targetSelfActivated: () => runner?.targetSelfActivated(),",
    );
    expect(native).toContain(
      "targetGone: (_token, code) => runner?.targetGone(code),",
    );
  });
  it("asks for the background when the setting is on and the user is at the Mac", () => {
    const run = fn("startRun");
    expect(run).toMatch(
      /const background =\s*!tutorial &&\s*settings\.workInBackground &&\s*presence\.current\(\) !== "away" &&\s*!from\?\.watch &&\s*!from\?\.undo;/,
    );
    expect(run).toContain("...(background ? { background: true } : {}),");
  });
  it("the pill names the window and what the run last did there", () => {
    const pill = fn("renderPill");
    expect(pill).toContain(
      "const background = s.run?.target?.background ? s.run.target : undefined;",
    );
    expect(pill).toContain(
      ": `Working in ${background.appName} in the background`",
    );
    expect(pill).toMatch(/isForegroundRequest\(s\.message\)\s*\?\s*s\.message/);
    expect(pill).toMatch(/background\s*\?\s*lastStepLine\(s\)/);
    expect(fn("lastStepLine")).toContain("stepLine(parsed.data)");
  });
});
