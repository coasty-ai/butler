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
  coveredStaleRetry,
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
  if (action.type === "click")
    return { targetRole: "AXButton", targetLabel: "Reply" };
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
 * A desktop with one Slack window to bind and the user's own app (Mail) in
 * front. The screen methods answer as whatever is in front; the target
 * methods as the bound window. foregroundTarget brings Slack in front when
 * the activation takes, and restoreRemembered gives Mail the front back.
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
  let front: { appId: string; pid: number; appName: string } = {
    appId: "com.apple.mail",
    pid: 9,
    appName: "Mail",
  };
  const mail = front;
  const deliver: Deliver =
    options.deliver ??
    ((_action, rungs) => ({ rung: rungs[0], effect: "changed" }));
  const controller = {
    kind: "native" as const,
    // The screen: whatever application is in front.
    surface: vi.fn(async (action?: Action): Promise<Surface> => ({
      appId: front.appId,
      pid: front.pid,
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
      appId: front.appId,
      context: { appName: front.appName, windowTitle: "Inbox" },
    })),
    execute: vi.fn(
      async (
        _action: Action,
        _frame: Frame,
        _signal: AbortSignal,
      ): Promise<void | ExecutionResult> => undefined,
    ),
    resume: vi.fn(async () => {}),
    stop: vi.fn(() => {}),
    restore: vi.fn(async () => {}),
    restoreRemembered: vi.fn(async () => {
      front = mail;
    }),
    revalidate: vi.fn(async (_a: Action, f: Frame) => f),
    inFront: () => front.appId,
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
    foregroundTarget: vi.fn(async (_token: string) => {
      const frontmost = options.frontmost ? await options.frontmost() : true;
      if (frontmost)
        front = { appId: SLACK, pid: target.pid, appName: target.appName };
      return { frontmost };
    }),
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
  it("counts misses by the kind of step: a click the window ignores never disables its menus", async () => {
    const c = desktop({
      deliver: (action, rungs) =>
        action.type === "menu_item"
          ? { rung: "ax", effect: "changed" }
          : { rung: rungs[rungs.length - 1], effect: "changed" },
    });
    const m = journal();
    const menu = step({ type: "menu_item", path: ["File", "New Message"] });
    await start(
      runnerWith(c, scripted([reply, reply, menu, reply]), m),
      "in Slack, reply",
    );
    expect(c.executeTarget.mock.calls.map((call) => call[3])).toEqual([
      ["ax", "post"],
      ["ax", "post"],
      // Two accessibility misses on clicks: the menu item still gets its press.
      ["ax"],
      ["post"],
    ]);
    expect(c.foregroundTarget).not.toHaveBeenCalled();
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
  it("says it needs the window, fronts it, acts as before, gives the window back, and returns to the background", async () => {
    const order: string[] = [];
    const c = desktop({ deliver: missesThenFront });
    const front = c.foregroundTarget.getMockImplementation()!;
    c.foregroundTarget.mockImplementation(async (token) => {
      order.push("front");
      return front(token);
    });
    c.executeTarget.mockImplementation(async (_t, action, _f, rungs) => {
      order.push(`execute:${rungs.join("+")}`);
      return missesThenFront(action, rungs, 0);
    });
    c.capture.mockImplementation(async () => {
      order.push(`capture:${c.inFront()}`);
      return {
        id: `screen-${order.length}`,
        sha256: "screen",
        image: "",
        geometry: display,
        capturedAt: 0,
        synthetic: false,
        appId: c.inFront(),
        context: { appName: "Slack", windowTitle: "Prateek (DM)" },
      };
    });
    c.execute.mockImplementation(async (action: Action, frame: Frame) => {
      order.push(`execute:screen:${frame.id}:${action.frame_id}`);
      return undefined;
    });
    const restore = c.restoreRemembered.getMockImplementation()!;
    c.restoreRemembered.mockImplementation(async () => {
      order.push("restore");
      return restore();
    });
    const m = journal();
    const messages: string[] = [];
    const provider = scripted([reply, reply]);
    const runner = runnerWith(c, provider, m, { messages });
    await start(runner, "in Slack, reply");
    // The helper never performs the foreground rung: the runner fronts the
    // window, captures the screen it now shows, acts on it the way every
    // step went before, and gives the user's application back.
    expect(order).toEqual([
      "execute:ax+post",
      "front",
      `capture:${SLACK}`,
      "execute:screen:screen-3:screen-3",
      "restore",
      "execute:ax+post",
      "front",
      `capture:${SLACK}`,
      "execute:screen:screen-8:screen-8",
      "restore",
    ]);
    expect(
      c.executeTarget.mock.calls.every(
        (call) => !call[3].includes("foreground"),
      ),
    ).toBe(true);
    // The point moved from the window image to the display.
    expect(c.execute.mock.calls[0][0]).toMatchObject({
      type: "click_control",
      label: "Reply",
    });
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
    // In front the step went as every step did before, with no read to report.
    expect(provider.observations[1].history.at(-1)?.result).toBe(
      "Executed click on button “Reply” with Slack in front for a second. Verify the next screenshot.",
    );
    // Still a background run afterwards; Mail has the front back.
    expect(m.getRun().target?.background).toBe(true);
    expect(c.inFront()).toBe("com.apple.mail");
    expect(c.restore).not.toHaveBeenCalled();
    expect(c.unbindTarget).toHaveBeenCalledTimes(1);
  });
  it("re-aims a point from the window image to the display for its second in front", async () => {
    const c = desktop({ deliver: missesThenFront });
    const m = journal();
    const provider = scripted([step({ type: "click", x: 0.5, y: 0.5 })]);
    await start(runnerWith(c, provider, m), "in Slack, click there");
    expect(c.execute).toHaveBeenCalledTimes(1);
    const [aimed, frame] = c.execute.mock.calls[0];
    // windowFrame is 900x600 at (100, 80) on a 1440x900 display.
    expect(aimed).toMatchObject({
      type: "click",
      x: (100 + 450) / 1440,
      y: (80 + 300) / 900,
      frame_id: frame.id,
    });
    expect(frame.geometry).toEqual(display);
  });
  it("hands over when the activation does not take, and the second still ends", async () => {
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
    expect(c.execute).not.toHaveBeenCalled();
    await until(() => c.restoreRemembered.mock.calls.length === 1);
    runner.stop();
    await running;
  });
  it("hands over, sending nothing, when another application took the front meanwhile", async () => {
    const c = desktop({ deliver: missesThenFront });
    c.capture.mockImplementationOnce(async () => ({
      id: "screen-x",
      sha256: "screen",
      image: "",
      geometry: display,
      capturedAt: 0,
      synthetic: false,
      appId: "com.apple.Notes",
      context: { appName: "Notes", windowTitle: "Groceries" },
    }));
    const m = journal();
    const runner = runnerWith(c, scripted([reply]), m);
    const running = start(runner, "in Slack, reply");
    await until(() => runner.snapshot.run?.status === "takeover");
    expect(runner.snapshot.message).toBe(foregroundHandoff("Slack"));
    expect(c.execute).not.toHaveBeenCalled();
    expect(c.restoreRemembered).toHaveBeenCalledTimes(1);
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
    expect(c.execute).toHaveBeenCalledTimes(1);
    expect(c.restoreRemembered).toHaveBeenCalledTimes(1);
    expect(m.of("ActionExecuted")).toHaveLength(1);
  });
  it("a covered window's stale picture refuses a point once with advice, then goes in front", async () => {
    const stale = () => {
      throw new TargetError(
        "TARGET_COVERED_STALE",
        "The window is fully covered, so its picture may be stale; use a listed control instead of a point.",
      );
    };
    const c = desktop({ deliver: stale });
    const m = journal();
    const click = step({ type: "click", x: 0.5, y: 0.5 });
    const provider = scripted([click, click]);
    await start(runnerWith(c, provider, m), "in Slack, click there");
    expect(provider.observations[1].history.at(-1)?.result).toBe(
      coveredStaleRetry("Slack"),
    );
    expect(m.of("ActionFailed").map((e) => e.data.code)).toEqual([
      "TARGET_COVERED_STALE",
    ]);
    // The repeat went in front; the first refusal never did.
    expect(c.foregroundTarget).toHaveBeenCalledTimes(1);
    expect(m.of("ForegroundRequested").map((e) => e.data.reason)).toEqual([
      "TARGET_COVERED_STALE",
    ]);
    expect(m.of("ActionExecuted")).toHaveLength(1);

    // With no control listed there is nothing to advise: in front at once.
    const bare = desktop({ deliver: stale, controls: [] });
    const m2 = journal();
    await start(runnerWith(bare, scripted([click]), m2), "in Slack, click");
    expect(bare.foregroundTarget).toHaveBeenCalledTimes(1);
    expect(m2.of("ActionExecuted")).toHaveLength(1);
  });
  it("a RUNG_NO_EFFECT the helper throws records no miss: nothing was tried", async () => {
    const c = desktop({
      deliver: (_a, rungs) => {
        if (rungs[0] === "foreground")
          return { rung: "foreground", effect: "changed" };
        throw new TargetError("RUNG_NO_EFFECT", "Every rung is skipped.");
      },
    });
    const m = journal();
    const memory = fakeMemory({ context: { preferences: [], episodes: [] } });
    await start(
      runnerWith(c, scripted([reply]), m, { memory: memory.access }),
      "in Slack, reply",
    );
    expect(c.foregroundTarget).toHaveBeenCalledTimes(1);
    expect(m.of("RungStepped")).toHaveLength(0);
    expect(memory.learned[0].background).toBeUndefined();
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
    // Three detours, each fronting the window once; the third left it in
    // front for good: the window was released, not given back.
    expect(c.foregroundTarget).toHaveBeenCalledTimes(3);
    expect(c.restoreRemembered).toHaveBeenCalledTimes(2);
    expect(c.inFront()).toBe(SLACK);
    // Released on the cap, and once more as the run ended.
    expect(c.unbindTarget.mock.calls).toEqual([[target.token], [target.token]]);
    // Three steps in front for a second, then the fourth the way every
    // step went before, and the screen that ended the run.
    expect(c.execute).toHaveBeenCalledTimes(4);
    expect(c.capture).toHaveBeenCalledTimes(5);
    // Two misses on each background rung pruned them before the third step.
    expect(c.executeTarget.mock.calls.map((call) => call[3])).toEqual([
      ["ax", "post"],
      ["ax", "post"],
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
    // The second ended with the takeover: nothing was sent, the handoff closed.
    expect(c.execute).not.toHaveBeenCalled();
    await until(() => c.restoreRemembered.mock.calls.length === 1);
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
