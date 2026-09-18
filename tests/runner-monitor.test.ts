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
  type WatchBinding,
} from "../src/core/schema";
import { Runner, echoAction, type RunnerExtras } from "../src/core/runner";

type Decision = { kind: string; reason: string };
type Context = import("../src/core/policy").PolicyContext;
const policy = vi.hoisted(() => ({
  evaluate: undefined as
    | undefined
    | ((
        a: Action,
        s: Surface,
        st: Settings,
        synthetic: boolean,
        context?: Context,
      ) => Decision),
  contexts: [] as (Context | undefined)[],
}));
vi.mock("../src/core/policy", async (original) => {
  const actual = await original<typeof import("../src/core/policy")>();
  return {
    ...actual,
    evaluate: (
      a: Action,
      s: Surface,
      st: Settings,
      synthetic: boolean,
      context?: Context,
    ) => {
      policy.contexts.push(context);
      return (
        policy.evaluate?.(a, s, st, synthetic, context) ??
        actual.evaluate(a, s, st, synthetic, context)
      );
    },
  };
});
afterEach(() => {
  policy.evaluate = undefined;
  policy.contexts = [];
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
  appId: "com.microsoft.VSCode",
  pid: 42,
  secureInput: false,
  unknown: false,
};
const settings = structuredClone(defaultSettings);
const usage = { inputTokens: 0, outputTokens: 0, cost: 0 };
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
const binding: WatchBinding = {
  token: "tok-abcdef",
  appId: surface.appId,
  pid: 42,
  windowId: 9,
  title: "users.ts — project",
};
function controller(
  overrides: Partial<Controller> & { kind?: Controller["kind"] } = {},
): Controller {
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
      context: { appName: "Code", windowTitle: "users.ts — project" },
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
const monitor = act({
  type: "monitor",
  reason: "wait for Claude Code to finish the tests",
  every_s: 10,
  max_min: 20,
});
const watching = (
  c: Controller,
  extras: RunnerExtras,
  provider = scripted([monitor]),
) => {
  const m = journal();
  const runner = new Runner(
    c,
    provider,
    m.recorder,
    settings,
    () => {},
    [],
    undefined,
    extras,
  );
  return { runner, m, provider };
};

describe("monitor hands the window to the watch and completes the run", () => {
  it("binds the frontmost window natively, hands it over, and ends without any input", async () => {
    const bindWatch = vi.fn(async () => binding);
    const c = controller({ bindWatch });
    const onMonitor = vi.fn();
    const { runner, m } = watching(c, { onMonitor });
    await runner.start(
      "keep an eye on Claude Code and tell me when it's done",
      {
        origin: "voice",
        taskSource: "user_words",
      },
    );
    expect(runner.snapshot.run).toMatchObject({
      status: "completed",
      actions: 1,
      summary: "Keeping an eye on Code. I’ll let you know when it’s done.",
    });
    expect(bindWatch).toHaveBeenCalledTimes(1);
    expect(c.execute).not.toHaveBeenCalled();
    expect(onMonitor).toHaveBeenCalledTimes(1);
    const [bound, spec, run] = onMonitor.mock.calls[0];
    expect(bound).toEqual(binding);
    expect(spec).toEqual({
      reason: "wait for Claude Code to finish the tests",
      everyMs: 10000,
      maxMs: 20 * 60000,
      until: "done",
    });
    expect(run).toEqual({
      id: runner.snapshot.run!.id,
      task: "keep an eye on Claude Code and tell me when it's done",
      taskSource: "user_words",
      origin: "voice",
      appName: "Code",
      steps: [],
      corrections: [],
    });
    expect(m.of("MonitorStarted").map((e) => e.data)).toEqual([
      {
        appId: surface.appId,
        mode: "done",
        delayMs: 10000,
        durationMs: 20 * 60000,
      },
    ]);
    expect(m.of("ActionExecuted")).toHaveLength(1);
    expect(m.of("RunCompleted")).toHaveLength(1);
    expect(runner.settled).toBe(true);
  });

  it("words the summary by what the watch waits for", async () => {
    for (const [until, summary] of [
      ["input", "Keeping an eye on Code. I’ll let you know when it needs you."],
      ["change", "Keeping an eye on Code. I’ll let you know when it changes."],
    ] as const) {
      const { runner } = watching(
        controller({ bindWatch: vi.fn(async () => binding) }),
        { onMonitor: vi.fn() },
        scripted([act({ type: "monitor", reason: "r", until })]),
      );
      await runner.start("watch it");
      expect(runner.snapshot.run?.summary).toBe(summary);
    }
  });

  it("refuses monitor with a note when the helper or the watch is missing, and the run goes on", async () => {
    for (const [c, extras] of [
      [controller(), { onMonitor: vi.fn() }],
      [controller({ bindWatch: vi.fn(async () => binding) }), {}],
    ] as const) {
      const provider = scripted([monitor]);
      const { runner, m } = watching(c, extras, provider);
      await runner.start("watch it");
      expect(runner.snapshot.run).toMatchObject({
        status: "completed",
        actions: 0,
      });
      expect(provider.observations).toHaveLength(2);
      expect(provider.observations[1].history.at(-1)).toMatchObject({
        type: "monitor",
        action: { type: "monitor", every_s: 10, max_min: 20, until: "done" },
      });
      expect(provider.observations[1].history.at(-1)!.result).toContain(
        "Monitoring isn't available here",
      );
      expect(m.of("ActionFailed").map((e) => e.data)).toEqual([
        { code: "MONITOR_UNAVAILABLE" },
      ]);
      if ("onMonitor" in extras)
        expect(extras.onMonitor).not.toHaveBeenCalled();
    }
  });

  it("tells the model when the watch refuses the window, lets go of it, and the run goes on", async () => {
    const refused = Object.assign(
      new Error(
        "That window has already woken you 4 times in the last hour; watching it again is refused. Finish with done and tell the user what it shows now.",
      ),
      { code: "MONITOR_REFUSED" },
    );
    for (const [thrown, note] of [
      [refused, "woken you 4 times in the last hour"],
      [
        new Error("boom"),
        "The watch refused this window; use wait, or finish with done.",
      ],
    ] as const) {
      const unbindWatch = vi.fn(async () => {});
      const onMonitor = vi.fn(() => {
        throw thrown;
      });
      const provider = scripted([monitor]);
      const { runner, m } = watching(
        controller({ bindWatch: vi.fn(async () => binding), unbindWatch }),
        { onMonitor },
        provider,
      );
      await runner.start("watch it");
      expect(runner.snapshot.run).toMatchObject({
        status: "completed",
        actions: 0,
      });
      expect(unbindWatch).toHaveBeenCalledWith(binding.token);
      const last = provider.observations[1].history.at(-1)!;
      expect(last.result).toMatch(/^No input was sent\. /);
      expect(last.result).toContain(note);
      expect(last.result).not.toContain("boom");
      expect(m.of("ActionFailed").map((e) => e.data)).toEqual([
        { code: "MONITOR_REFUSED" },
      ]);
      expect(m.of("MonitorStarted")).toHaveLength(0);
      expect(m.of("ActionExecuted")).toHaveLength(0);
    }
  });

  it("never watches from the tutorial", async () => {
    const onMonitor = vi.fn();
    const { runner, m } = watching(
      controller({ kind: "tutorial", bindWatch: vi.fn(async () => binding) }),
      { onMonitor },
    );
    await runner.start("watch it");
    expect(runner.snapshot.run?.synthetic).toBe(true);
    expect(onMonitor).not.toHaveBeenCalled();
    expect(m.of("ActionFailed").map((e) => e.data)).toEqual([
      { code: "MONITOR_UNAVAILABLE" },
    ]);
  });

  it("lets go of a window that is not the one on the screenshot", async () => {
    const other = { ...binding, appId: "com.apple.Safari" };
    const unbindWatch = vi.fn(async () => {});
    const onMonitor = vi.fn();
    const provider = scripted([monitor]);
    const { runner, m } = watching(
      controller({ bindWatch: vi.fn(async () => other), unbindWatch }),
      { onMonitor },
      provider,
    );
    await runner.start("watch it");
    expect(onMonitor).not.toHaveBeenCalled();
    expect(unbindWatch).toHaveBeenCalledWith(other.token);
    expect(provider.observations[1].history.at(-1)!.result).toContain(
      "Another application came to the front",
    );
    // The kind of change is recorded as its code, never the app's name.
    expect(m.of("ActionFailed").map((e) => e.data)).toEqual([
      { code: "STATE_CHANGED", change: "APP_CHANGED" },
    ]);
    expect(runner.snapshot.run?.status).toBe("completed");
  });

  it("carries why a watch woke it to the model on every frame, and nowhere else", async () => {
    const provider = scripted([act({ type: "wait", milliseconds: 0 })]);
    const snapshots: string[] = [];
    const frames: string[] = [];
    const m = journal();
    m.recorder.frame = (_id, frame) => frames.push(JSON.stringify(frame));
    const runner = new Runner(
      controller(),
      provider,
      m.recorder,
      settings,
      (s) => snapshots.push(JSON.stringify(s)),
    );
    const watch = {
      cause: "done",
      agent: "claude-code",
      state: "idle",
      minutes: 12,
      lastChangeMinutes: 0,
      steps: ["opened Code"],
      panelText: "ask claude to edit... panel-text-fixture",
    };
    await runner.start("keep an eye on Claude Code", {
      origin: "watch",
      watch,
    });
    expect(provider.observations).toHaveLength(2);
    for (const o of provider.observations)
      expect(o.frame.context?.watch).toEqual(watch);
    // The panel's text never enters a Snapshot, a saved frame or the journal.
    expect(snapshots.length).toBeGreaterThan(2);
    expect(frames.length).toBe(2);
    for (const leaked of [...snapshots, ...frames, JSON.stringify(m.events)])
      expect(leaked).not.toContain("panel-text-fixture");
    expect(JSON.stringify(runner.snapshot)).not.toContain("panel-text-fixture");
    // An ordinary run carries none.
    const plain = scripted([]);
    const again = watching(controller(), {}, plain);
    await again.runner.start("open notes");
    expect(plain.observations[0].frame.context?.watch).toBeUndefined();
  });

  it("hands over the steps taken, the user's corrections and the chain", async () => {
    policy.evaluate = () => ({ kind: "ALLOW", reason: "Test." });
    const onMonitor = vi.fn();
    const provider = scripted([
      act({ type: "open_app", name: "Code" }),
      (o) => {
        // A correction the user made while the run was going.
        runner.snapshot.run!.corrections = [
          { text: "don't delete anything", after_action: 1, timestamp: "" },
        ];
        return monitor(o, new AbortController().signal);
      },
    ]);
    const { runner } = watching(
      controller({ bindWatch: vi.fn(async () => binding) }),
      { onMonitor },
      provider,
    );
    const chain = { startedAt: 5, wakes: 2, origin: "voice" as const };
    await runner.start("check on Claude Code", { origin: "watch", chain });
    const run = onMonitor.mock.calls[0][2];
    expect(run.steps).toEqual([
      expect.objectContaining({ type: "open_app", name: "Code" }),
    ]);
    expect(run.corrections).toEqual(["don't delete anything"]);
    expect(run.chain).toEqual(chain);
    // A run nobody's watch woke starts no chain of its own here.
    const fresh = vi.fn();
    const plain = watching(
      controller({ bindWatch: vi.fn(async () => binding) }),
      { onMonitor: fresh },
    );
    await plain.runner.start("watch it");
    expect(fresh.mock.calls[0][2]).not.toHaveProperty("chain");
  });

  it("tells the model when the helper cannot bind the window, and the run goes on", async () => {
    const provider = scripted([monitor]);
    const { runner, m } = watching(
      controller({
        bindWatch: vi.fn(async () => {
          throw new Error("Too many windows are being watched.");
        }),
      }),
      { onMonitor: vi.fn() },
      provider,
    );
    await runner.start("watch it");
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(provider.observations).toHaveLength(2);
    expect(provider.observations[1].history.at(-1)!.result).toBe(
      "No input was sent. The window could not be watched (Too many windows are being watched.); use wait, or finish with done.",
    );
    expect(m.of("ActionFailed").map((e) => e.data)).toEqual([
      { code: "MONITOR_REFUSED" },
    ]);
  });
});

describe("a wake-up run is a follow-up, not the request again", () => {
  const paste = act({ type: "hotkey", keys: ["CMD", "V"] });
  it("never reads its objective as the user asking for a paste or naming a folder", async () => {
    const task =
      "A watch on Safari woke you: the window changed. The earlier request, already carried out before the watch began: “Paste my tracking number into the search box”.";
    const contexts = async (
      origin: "watch" | "voice",
      taskSource?: "user_words",
    ) => {
      policy.contexts = [];
      const { runner } = watching(controller(), {}, scripted([paste]));
      await runner.start(task, { origin, taskSource });
      // The context the paste step was judged with.
      return policy.contexts[0];
    };
    expect(await contexts("watch", "user_words")).toEqual({
      pasteRequested: false,
    });
    expect(await contexts("voice", "user_words")).toEqual({
      pasteRequested: true,
      userWords: task,
    });
    // Words that are not the user's own never name a folder for them.
    expect(await contexts("voice")).toEqual({ pasteRequested: true });
  });
  it("still lets the user's own correction to it ask for a paste", async () => {
    const { runner } = watching(
      controller(),
      {},
      scripted([
        (o) => {
          runner.snapshot.run!.corrections = [
            { text: "paste it into the box", after_action: 0, timestamp: "" },
          ];
          return paste(o, new AbortController().signal);
        },
      ]),
    );
    await runner.start("A watch on Safari woke you.", { origin: "watch" });
    expect(policy.contexts[0]).toEqual({ pasteRequested: true });
  });
  it("neither recalls nor learns from memory", async () => {
    const memory = () => ({
      recall: vi.fn(async () => ({
        context: { preferences: [], episodes: [] },
      })),
      learn: vi.fn(),
    });
    const woke = memory();
    const m = journal();
    await new Runner(
      controller(),
      scripted([]),
      m.recorder,
      settings,
      () => {},
      [],
      woke,
    ).start("A watch on Code woke you.", { origin: "watch" });
    expect(woke.recall).not.toHaveBeenCalled();
    expect(woke.learn).not.toHaveBeenCalled();
    const asked = memory();
    await new Runner(
      controller(),
      scripted([]),
      journal().recorder,
      settings,
      () => {},
      [],
      asked,
    ).start("open notes", { origin: "voice" });
    expect(asked.recall).toHaveBeenCalledTimes(1);
    expect(asked.learn).toHaveBeenCalledTimes(1);
  });
});

describe("open_file with an application", () => {
  it("says which application opened the item", async () => {
    policy.evaluate = () => ({ kind: "ALLOW", reason: "Test." });
    const execute = vi.fn(async (_action: Action) => ({
      opened: {
        path: "~/Projects/rlenvforHUD1",
        kind: "folder" as const,
        appId: "com.microsoft.VSCode",
      },
    }));
    const provider = scripted([
      act({
        type: "open_file",
        path: "~/Projects/rlenvforHUD1",
        app: "Visual Studio Code",
      }),
    ]);
    const messages: string[] = [];
    const m = journal();
    const runner = new Runner(
      controller({ execute }),
      provider,
      m.recorder,
      settings,
      (s) => messages.push(s.message),
    );
    await runner.start("open the rlenvforHUD1 folder in VS Code");
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(execute.mock.calls[0][0]).toMatchObject({
      type: "open_file",
      path: "~/Projects/rlenvforHUD1",
      app: "Visual Studio Code",
    });
    expect(messages).toContain("Opening rlenvforHUD1 in Visual Studio Code.");
    expect(provider.observations[1].history.at(-1)!.result).toBe(
      "Opened ~/Projects/rlenvforHUD1 (folder) in com.microsoft.VSCode. Verify the next screenshot.",
    );
    expect(
      echoAction({ type: "open_file", path: "~/x", app: "Visual Studio Code" }),
    ).toEqual({ type: "open_file", app: "Visual Studio Code" });
    expect(echoAction({ type: "open_file", path: "~/x" })).toEqual({
      type: "open_file",
    });
  });
});
