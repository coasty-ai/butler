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
import {
  Runner,
  noProgressWarning,
  progressProbe,
  sameProbe,
} from "../src/core/runner";

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
const settings = structuredClone(defaultSettings);
const usage = { inputTokens: 0, outputTokens: 0, cost: 0 };

function memory() {
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
  return {
    recorder,
    events,
    of: (type: string) => events.filter((e) => e.type === type),
    getRun: () => run!,
  };
}

/** What the fake Mac shows; a test mutates it to make the screen change. */
type Screen = {
  sha: string;
  title: string;
  controls: number;
  focused?: string;
};
let captures = 0;
function controller(screen: Screen) {
  const c: Controller = {
    kind: "native",
    surface: async () => ({
      appId: "com.spotify.client",
      pid: 7,
      secureInput: false,
      unknown: false,
      ...(screen.focused ? { focusedRole: screen.focused } : {}),
    }),
    capture: async (): Promise<Frame> => ({
      id: `frame-${++captures}`,
      sha256: screen.sha,
      image: "",
      geometry,
      capturedAt: 0,
      synthetic: false,
      appId: "com.spotify.client",
      context: {
        appName: "Spotify",
        windowTitle: screen.title,
        controls: Array.from({ length: screen.controls }, () => ({
          role: "AXButton",
          x: 0.1,
          y: 0.1,
        })),
      },
    }),
    execute: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    stop: vi.fn(() => {}),
  };
  return c;
}
function scripted(replies: ((o: Observation) => Partial<ProviderResult>)[]) {
  const observations: Observation[] = [];
  const next = vi.fn(async (o: Observation, _signal: AbortSignal) => {
    observations.push(structuredClone(o));
    const reply = replies[observations.length - 1];
    const value = reply
      ? reply(o)
      : { action: { type: "done", summary: "Done", frame_id: o.frame.id } };
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
const click = act({ type: "click", x: 0.5, y: 0.5 });
const open = act({ type: "open_app", name: "Spotify" });
const warned = (h: Observation["history"]) =>
  h.map((entry) => entry.result.includes(noProgressWarning.trim()));

describe("no-progress observation probe", () => {
  const frame = (over: Partial<Frame> = {}): Frame => ({
    id: "f",
    sha256: "sha",
    image: "",
    geometry,
    capturedAt: 0,
    synthetic: false,
    appId: "com.spotify.client",
    context: { appName: "Spotify", windowTitle: "Home", controls: [] },
    ...over,
  });
  const surface = (over: Partial<Surface> = {}): Surface => ({
    appId: "com.spotify.client",
    pid: 7,
    secureInput: false,
    unknown: false,
    ...over,
  });
  it("uses the frame hash, app, window, focus and control count", () => {
    const before = progressProbe(frame(), surface({ focusedRole: "AXField" }));
    expect(before).toMatchObject({
      appId: "com.spotify.client",
      windowTitle: "Home",
      sha256: "sha",
      controls: 0,
    });
    expect(
      sameProbe(
        before,
        progressProbe(frame(), surface({ focusedRole: "AXField" })),
      ),
    ).toBe(true);
    // Any one of the five differing means the screen did change.
    const differs = [
      progressProbe(
        frame({ sha256: "other" }),
        surface({ focusedRole: "AXField" }),
      ),
      progressProbe(
        frame({ appId: "com.apple.Safari" }),
        surface({ focusedRole: "AXField" }),
      ),
      progressProbe(
        frame({
          context: { appName: "Spotify", windowTitle: "Search", controls: [] },
        }),
        surface({ focusedRole: "AXField" }),
      ),
      progressProbe(
        frame({
          context: {
            appName: "Spotify",
            windowTitle: "Home",
            controls: [{ role: "AXButton", x: 0.1, y: 0.2 }],
          },
        }),
        surface({ focusedRole: "AXField" }),
      ),
      progressProbe(frame(), surface({ focusedRole: "AXButton" })),
    ];
    for (const after of differs) expect(sameProbe(before, after)).toBe(false);
  });
  it("never reads field contents into the probe", () => {
    const probe = progressProbe(
      frame(),
      surface({ focusedRole: "AXTextField", focusedValue: "private words" }),
    );
    expect(JSON.stringify(probe)).not.toContain("private words");
  });
});

describe("runner no-progress advice", () => {
  it("tells the model once when two actions of a type change nothing", async () => {
    allowAll();
    const m = memory();
    const screen: Screen = { sha: "same", title: "Spotify", controls: 0 };
    const c = controller(screen);
    const p = scripted([open, open, open, open]);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    await runner.start("play something on spotify");
    // Advice, never a failure: the run keeps going and completes normally.
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(c.execute).toHaveBeenCalledTimes(4);
    expect(m.of("ActionFailed")).toHaveLength(0);
    const history = p.observations.at(-1)!.history;
    expect(warned(history)).toEqual([false, true, false, false]);
    expect(history[1].result).toContain("no visible change");
    expect(history[1].result).toContain("context.playbook");
    expect(history[1].result).toContain("request_user");
    expect(m.of("NoProgressDetected").map((e) => e.data)).toEqual([
      { actionType: "open_app" },
    ]);
  });
  it("stays silent while the screen keeps changing", async () => {
    allowAll();
    const m = memory();
    const screen: Screen = { sha: "s0", title: "Spotify", controls: 0 };
    let step = 0;
    const c = controller(screen);
    vi.mocked(c.execute).mockImplementation(async () => {
      screen.sha = `s${++step}`;
    });
    const p = scripted([open, open, open, open]);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    await runner.start("play something on spotify");
    expect(runner.snapshot.run?.status).toBe("completed");
    const history = p.observations.at(-1)!.history;
    expect(warned(history)).toEqual([false, false, false, false]);
    expect(m.of("NoProgressDetected")).toHaveLength(0);
  });
  it("stays silent when only the window, focus or controls moved", async () => {
    // The same screenshot hash is never enough on its own: a new window
    // title, a new focused element or a different control count is progress.
    for (const change of [
      (s: Screen, n: number) => (s.title = `Search ${n}`),
      (s: Screen, n: number) => (s.controls = n),
      (s: Screen, n: number) => (s.focused = `AXField${n}`),
    ]) {
      allowAll();
      const m = memory();
      const screen: Screen = { sha: "same", title: "Spotify", controls: 0 };
      const c = controller(screen);
      let step = 0;
      vi.mocked(c.execute).mockImplementation(async () => {
        change(screen, ++step);
      });
      const p = scripted([click, click, click]);
      const runner = new Runner(c, p, m.recorder, settings, () => {});
      await runner.start("open the search field");
      expect(warned(p.observations.at(-1)!.history)).toEqual([
        false,
        false,
        false,
      ]);
      expect(m.of("NoProgressDetected")).toHaveLength(0);
    }
  });
  it("requires two actions of the same type in a row", async () => {
    allowAll();
    const m = memory();
    const screen: Screen = { sha: "same", title: "Spotify", controls: 0 };
    const c = controller(screen);
    const p = scripted([click, open, click, open]);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    await runner.start("play something on spotify");
    expect(warned(p.observations.at(-1)!.history)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(m.of("NoProgressDetected")).toHaveLength(0);
  });
  it("advises again only after a new stall", async () => {
    allowAll();
    const m = memory();
    const screen: Screen = { sha: "same", title: "Spotify", controls: 0 };
    const c = controller(screen);
    let executed = 0;
    vi.mocked(c.execute).mockImplementation(async () => {
      // The third click works; the rest change nothing.
      if (++executed === 3) screen.sha = "moved";
    });
    const p = scripted([click, click, click, click, click, click]);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    await runner.start("press play");
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(warned(p.observations.at(-1)!.history)).toEqual([
      false,
      true,
      false,
      false,
      true,
      false,
    ]);
    expect(m.of("NoProgressDetected")).toHaveLength(2);
  });
  it("says nothing when an action was rejected instead of executed", async () => {
    policy.evaluate = (a) =>
      a.type === "done"
        ? { kind: "ALLOW", reason: "" }
        : { kind: "DENY", reason: "Not allowed here." };
    const m = memory();
    const screen: Screen = { sha: "same", title: "Spotify", controls: 0 };
    const c = controller(screen);
    const p = scripted([click, click]);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    await runner.start("press play");
    expect(c.execute).not.toHaveBeenCalled();
    // Two refused clicks, then the runner's one check of the done said
    // after them (runner-done.test.ts); none carries the advice.
    expect(warned(p.observations.at(-1)!.history)).toEqual([
      false,
      false,
      false,
    ]);
    expect(p.observations.at(-1)!.history.at(-1)?.type).toBe("rejected");
    expect(m.of("NoProgressDetected")).toHaveLength(0);
  });
});

describe("history the model sees", () => {
  it("sends the last six entries whole and sums up the steps before them", async () => {
    allowAll();
    const m = memory();
    const screen: Screen = { sha: "s0", title: "Spotify", controls: 0 };
    let step = 0;
    const c = controller(screen);
    vi.mocked(c.execute).mockImplementation(async () => {
      screen.sha = `s${++step}`;
    });
    // Nine different targets: the same click four times is a loop.
    const p = scripted(
      Array.from({ length: 9 }, (_, i) =>
        act({ type: "click", x: (i + 1) / 10, y: 0.5 }),
      ),
    );
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    await runner.start("click around");
    expect(runner.snapshot.run?.status).toBe("completed");
    // Six executed steps still arrive whole; the seventh call sums up.
    expect(p.observations[6].history).toHaveLength(6);
    expect(p.observations[6].history.map((h) => h.type)).not.toContain(
      "earlier_steps",
    );
    const history = p.observations[9].history;
    expect(history).toHaveLength(7);
    expect(history[0]).toEqual({
      type: "earlier_steps",
      result:
        "3 earlier steps, oldest first: click (done); click (done); click (done).",
    });
    for (const entry of history.slice(1))
      expect(entry).toMatchObject({
        type: "click",
        action: { type: "click", y: 0.5 },
        result: "Executed. Verify the next screenshot.",
      });
  });
});
