import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  defaultSettings,
  type Action,
  type ExecutionResult,
  type Frame,
  type Settings,
  type Surface,
} from "../src/core/schema";
import {
  EarlyStart,
  type EarlyCode,
  type EarlyController,
} from "../electron/early-start";
import { EARLY_LIMITS, type AppMatch } from "../src/voice/early";

const VSCODE = "com.microsoft.VSCode";
const SLACK = "com.tinyspeck.slackmacgap";
const SAFARI = "com.apple.Safari";
const FINDER = "com.apple.finder";
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
const ticks = async (n = 12) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};
function deferred<T = void>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

type DesktopOptions = {
  /** The frontmost app's surface. */
  front?: Partial<Surface>;
  /** What surface(open_app) reports about the named app. */
  launcher?: Partial<Surface>;
  /** What surface(open_file) reports about the path. */
  file?: Partial<Surface>;
  execute?: (a: Action, signal: AbortSignal) => Promise<void | ExecutionResult>;
  capture?: () => Promise<void>;
  resume?: () => Promise<void>;
  /** Runs while surface(open_app) looks the app up. */
  lookup?: () => Promise<void>;
};
/** A desktop whose every call is logged in order. */
function desktop(o: DesktopOptions = {}) {
  const calls: string[] = [];
  const state = { front: { ...o.front } as Partial<Surface>, frames: 0 };
  const executed: Action[] = [];
  const signals: AbortSignal[] = [];
  const base = (): Surface => ({
    appId: VSCODE,
    pid: 7,
    secureInput: false,
    unknown: false,
    ...state.front,
  });
  const controller: EarlyController = {
    configure: vi.fn(async () => {
      calls.push("configure");
    }),
    surface: vi.fn(async (action?: Action) => {
      if (!action) {
        calls.push("surface()");
        return base();
      }
      calls.push(`surface(${action.type}:${action.frame_id})`);
      await o.lookup?.();
      if (action.type === "open_file")
        return {
          ...base(),
          fileStatus: "resolved",
          fileKind: "folder",
          fileName: "Downloads",
          ...o.file,
        } as Surface;
      return {
        ...base(),
        launcherStatus: "resolved",
        launcherAppId: SLACK,
        launcherName: "Slack",
        windowCount: 1,
        ...o.launcher,
      } as Surface;
    }),
    capture: vi.fn(async (): Promise<Frame> => {
      calls.push("capture");
      await o.capture?.();
      return {
        id: `frame-${++state.frames}`,
        sha256: "sha",
        image: "data:image/png;base64,AAAA",
        geometry,
        capturedAt: 0,
        synthetic: false,
        appId: base().appId,
      };
    }),
    execute: vi.fn(async (a: Action, _f: Frame, signal: AbortSignal) => {
      calls.push("execute");
      executed.push(a);
      signals.push(signal);
      if (o.execute) return o.execute(a, signal);
      if (a.type === "open_file")
        return {
          opened: { path: a.path, kind: "folder" as const, appId: FINDER },
        };
      const name = o.launcher?.launcherName ?? "Slack";
      return {
        launched: {
          appId: o.launcher?.launcherAppId ?? SLACK,
          name,
          frontmost: true,
          wasRunning: true,
          windows: 1,
        },
      };
    }),
    resume: vi.fn(async () => {
      calls.push("resume");
      await o.resume?.();
    }),
    stop: vi.fn(() => {
      calls.push("stop");
    }),
    request: vi.fn(async (method: string) => {
      calls.push(`request(${method})`);
      return {};
    }),
  };
  return { controller, calls, state, executed, signals };
}

/** A manual clock: timers fire only when advanced past. */
function clock() {
  let t = 0,
    id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => {
      timers.set(++id, { at: t + ms, fn });
      return id;
    },
    clearTimer: (k: unknown) => void timers.delete(k as number),
    pending: () => timers.size,
    async to(at: number) {
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, v]) => v.at <= at)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = Math.max(t, due[1].at);
        due[1].fn();
        await ticks();
      }
      t = Math.max(t, at);
      await ticks();
    },
  };
}

/** The installed app list as main.ts answers for it. */
function installed(names: string[]): (key: string) => AppMatch {
  return (key) => {
    if (names.includes(key)) return "exact";
    const begins = names.filter((n) => n.startsWith(key + " ")).length;
    return begins === 1 ? "prefix" : begins ? "ambiguous" : "none";
  };
}
function setup(
  o: DesktopOptions & {
    settings?: Partial<Settings>;
    blocked?: EarlyCode;
    noController?: boolean;
    knownApps?: string[];
    /** The browser for a site; null when none is known. */
    browser?: string | null;
  } = {},
) {
  const desk = desktop(o);
  const clk = clock();
  const traces: { event: string; data: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const config = {
    settings: { ...defaultSettings, earlyStart: true, ...o.settings },
    blocked: o.blocked,
  };
  const early = new EarlyStart({
    controller: () => (o.noController ? undefined : desk.controller),
    settings: () => config.settings,
    blocked: () => config.blocked,
    ...(o.knownApps ? { knownApp: installed(o.knownApps) } : {}),
    browser: () => (o.browser === null ? undefined : (o.browser ?? "Safari")),
    onOpened: (name) => opened.push(name),
    trace: (event, data = {}) => traces.push({ event, data }),
    now: clk.now,
    setTimer: clk.setTimer,
    clearTimer: clk.clearTimer,
  });
  let invocation = 0;
  const begin = (ready: Promise<unknown> = Promise.resolve()) =>
    early.begin(++invocation, ready);
  /** Timed partials of the current activation, timers firing in between. */
  const say = async (...steps: [string, number][]) => {
    for (const [text, at] of steps) {
      await clk.to(at);
      early.partial(invocation, text);
      await ticks();
    }
  };
  const of = (event: string) =>
    traces.filter((t) => t.event === event).map((t) => t.data);
  return {
    ...desk,
    early,
    clk,
    traces,
    opened,
    config,
    begin,
    say,
    of,
    get invocation() {
      return invocation;
    },
  };
}
/** Every resume() is followed by a stop() before the next resume(). */
function latchedAfterEveryResume(calls: string[]) {
  let open = false;
  for (const call of calls) {
    if (call === "resume") {
      if (open) return false;
      open = true;
    } else if (call === "stop") open = false;
  }
  return !open;
}
const KEEP = "Open Slack and message Dana hi";
/** "Open" · "Open Slack" · "Open Slack and": settles on the boundary at 600. */
const openSlackAnd: [string, number][] = [
  ["Open", 0],
  ["Open Slack", 300],
  ["Open Slack and", 600],
];

describe("early start: the step", () => {
  it("opens Slack before the sentence ends, in the Runner's native order", async () => {
    const t = setup();
    t.begin();
    await t.say(...openSlackAnd);
    await t.early.idle();
    expect(t.calls).toEqual([
      "configure",
      "surface()",
      "resume",
      "capture",
      "stop",
      "surface(open_app:frame-1)",
      "resume",
      "execute",
      "stop",
    ]);
    expect(t.executed).toEqual([
      { type: "open_app", name: "Slack", frame_id: "frame-1" },
    ]);
    expect(t.opened).toEqual(["Slack"]);
    expect(t.of("EarlyStartExecuted")).toEqual([
      {
        code: "ok",
        settle: "boundary",
        target: "app",
        earlyMs: expect.any(Number),
        durationMs: expect.any(Number),
      },
    ]);
    // Settled at 600 on the clause first heard at 300.
    expect(t.of("EarlyStartExecuted")[0].earlyMs).toBe(300);
    const claim = t.early.finish(t.invocation, KEEP)!;
    expect(claim.completes).toBe(false);
    const prelude = await claim.take();
    expect(prelude).toMatchObject({
      frame: { id: "frame-1", appId: VSCODE },
      surface: { launcherStatus: "resolved", launcherAppId: SLACK },
      action: { type: "open_app", name: "Slack", frame_id: "frame-1" },
      reason: "Open a verified installed application.",
      outcome: { launched: { appId: SLACK, frontmost: true } },
      completes: false,
    });
    await ticks();
    expect(t.of("EarlyStartEnded")).toEqual([
      { phase: "kept", code: "ok", target: "app", leadMs: expect.any(Number) },
    ]);
    // Content-free: no app, name, bundle or words.
    expect(JSON.stringify(t.traces)).not.toMatch(/slack|dana|tinyspeck/i);
  });
  it("brings the browser forward for a site the moment its name is heard", async () => {
    const t = setup({
      browser: "Safari",
      launcher: { launcherName: "Safari", launcherAppId: SAFARI },
    });
    t.begin();
    await t.say(["Go to", 0], ["Go to youtube", 300]);
    await t.early.idle();
    // The address is never entered early: only the browser opens.
    expect(t.executed).toEqual([
      { type: "open_app", name: "Safari", frame_id: "frame-1" },
    ]);
    expect(t.opened).toEqual(["Safari"]);
    expect(t.of("EarlyStartExecuted")).toEqual([
      {
        code: "ok",
        settle: "eager",
        target: "site",
        earlyMs: 0,
        durationMs: expect.any(Number),
      },
    ]);
    // Kept for any site the final names, and never as the whole request:
    // the run still loads the page.
    const claim = t.early.finish(
      t.invocation,
      "Go to youtube dot com and play lofi.",
    )!;
    expect(claim.completes).toBe(false);
    expect(await claim.take()).toMatchObject({
      action: { type: "open_app", name: "Safari" },
      outcome: { launched: { appId: SAFARI } },
      completes: false,
    });
    await ticks();
    expect(t.of("EarlyStartEnded")).toEqual([
      { phase: "kept", code: "ok", target: "site", leadMs: expect.any(Number) },
    ]);
    expect(JSON.stringify(t.traces)).not.toMatch(/youtube|safari/i);
    // "Go to youtube." alone is not complete either.
    const alone = setup({
      launcher: { launcherName: "Safari", launcherAppId: SAFARI },
    });
    alone.begin();
    await alone.say(["Go to youtube", 0]);
    await alone.early.idle();
    expect(
      alone.early.finish(alone.invocation, "Go to youtube.")!.completes,
    ).toBe(false);
  });
  it("opens nothing for a site without a known browser", async () => {
    const t = setup({ browser: null });
    t.begin();
    await t.say(["Go to youtube", 0]);
    await t.early.idle();
    expect(t.executed).toEqual([]);
    expect(t.of("EarlyStartExecuted")).toEqual([
      { code: "unresolved", settle: "eager", target: "site" },
    ]);
  });
  it("opens a standard folder in Finder the moment its name is heard", async () => {
    const t = setup();
    t.begin();
    await t.say(["Open", 0], ["Open downloads", 300]);
    await t.early.idle();
    expect(t.calls).toEqual([
      "configure",
      "surface()",
      "resume",
      "capture",
      "stop",
      "surface(open_file:frame-1)",
      "resume",
      "execute",
      "stop",
    ]);
    expect(t.executed).toEqual([
      { type: "open_file", path: "~/Downloads", frame_id: "frame-1" },
    ]);
    expect(t.opened).toEqual(["Downloads"]);
    expect(t.of("EarlyStartExecuted")).toEqual([
      {
        code: "ok",
        settle: "eager",
        target: "folder",
        earlyMs: 0,
        durationMs: expect.any(Number),
      },
    ]);
    const claim = t.early.finish(t.invocation, "Open downloads.")!;
    expect(claim.completes).toBe(true);
    expect(await claim.take()).toMatchObject({
      action: { type: "open_file", path: "~/Downloads", frame_id: "frame-1" },
      surface: { fileStatus: "resolved", fileKind: "folder" },
      reason: "Open a document or folder from the local index.",
      outcome: {
        opened: { path: "~/Downloads", kind: "folder", appId: FINDER },
      },
      completes: true,
    });
    await ticks();
    expect(t.of("EarlyStartEnded")).toEqual([
      {
        phase: "kept",
        code: "ok",
        target: "folder",
        leadMs: expect.any(Number),
      },
    ]);
    expect(JSON.stringify(t.traces)).not.toMatch(/downloads|finder/i);
    // With more words the folder opens and the run goes on from there.
    const more = setup();
    more.begin();
    await more.say(["Open my downloads", 0]);
    await more.early.idle();
    expect(
      more.early.finish(
        more.invocation,
        "Open my downloads and find the report",
      )!.completes,
    ).toBe(false);
  });
  for (const [label, file, code] of [
    [
      "a path the helper does not resolve",
      { fileStatus: "unresolved" },
      "unresolved",
    ],
    ["a refused path", { fileStatus: "refused" }, "refused"],
    [
      "a document where a folder was named",
      { fileKind: "document" },
      "unresolved",
    ],
  ] as [string, Partial<Surface>, EarlyCode][])
    it(`opens nothing for ${label}`, async () => {
      const t = setup({ file });
      t.begin();
      await t.say(["Open downloads", 0]);
      await t.early.idle();
      expect(t.executed).toEqual([]);
      expect(t.of("EarlyStartExecuted")).toEqual([
        { code, settle: "eager", target: "folder" },
      ]);
    });
  it("opens the one installed app whose name begins with the words", async () => {
    const idea = {
      launcher: {
        launcherName: "IntelliJ IDEA",
        launcherAppId: "com.jetbrains.intellij",
      },
      knownApps: ["intellij idea", "slack"],
    };
    const t = setup(idea);
    t.begin();
    await t.say(["Open", 0], ["Open IntelliJ", 300]);
    await t.early.idle();
    expect(t.executed).toEqual([
      { type: "open_app", name: "IntelliJ", frame_id: "frame-1" },
    ]);
    expect(t.of("EarlyStartExecuted")[0]).toMatchObject({
      code: "ok",
      settle: "eager",
      target: "app",
    });
    // The final names the app in full, or only its first word: kept either way.
    const claim = t.early.finish(
      t.invocation,
      "Open IntelliJ IDEA and run the tests",
    )!;
    expect(claim.completes).toBe(false);
    expect(await claim.take()).toMatchObject({ action: { name: "IntelliJ" } });
    const whole = setup(idea);
    whole.begin();
    await whole.say(["Open IntelliJ", 0]);
    await whole.early.idle();
    expect(
      whole.early.finish(whole.invocation, "Open IntelliJ IDEA.")!.completes,
    ).toBe(true);
    // Another app beginning the same way: the step is not kept.
    const other = setup(idea);
    other.begin();
    await other.say(["Open IntelliJ", 0]);
    await other.early.idle();
    expect(
      other.early.finish(other.invocation, "Open IntelliJ Community"),
    ).toBeUndefined();
    await ticks();
    expect(other.of("EarlyStartEnded")).toEqual([
      { phase: "abandoned", code: "final_changed", target: "app" },
    ]);
    // The helper resolves the words to some other app: nothing opens.
    const differs = setup({ knownApps: ["intellij idea"] });
    differs.begin();
    await differs.say(["Open IntelliJ", 0]);
    await differs.early.idle();
    expect(differs.executed).toEqual([]);
    expect(differs.of("EarlyStartExecuted")).toEqual([
      { code: "not_exact", settle: "eager", target: "app" },
    ]);
  });
  it("starts the screenshot at the first 'open', before the name arrives", async () => {
    const gate = deferred();
    const t = setup({ capture: () => gate.promise });
    t.begin();
    await t.say(["Open", 0]);
    expect(t.calls).toEqual(["configure", "surface()", "resume", "capture"]);
    gate.resolve();
    await t.early.idle();
    expect(t.calls.at(-1)).toBe("stop");
    // Nothing settled: the frame stays in memory and nothing else happens.
    expect(t.executed).toEqual([]);
  });
  it("completes when the final words were only the clause", async () => {
    const t = setup();
    t.begin();
    await t.say(["Open", 0], ["Open Slack", 300]);
    await t.clk.to(300 + EARLY_LIMITS.pauseMs);
    await t.early.idle();
    expect(t.of("EarlyStartExecuted")[0]).toMatchObject({
      code: "ok",
      settle: "pause",
    });
    const claim = t.early.finish(t.invocation, "Open Slack.")!;
    expect(claim.completes).toBe(true);
    expect((await claim.take())?.completes).toBe(true);
  });

  const refusals: [
    string,
    DesktopOptions & { steps?: [string, number][] },
    EarlyCode,
  ][] = [
    ["secure input in front", { front: { secureInput: true } }, "surface"],
    [
      "a terminal in front",
      { front: { appId: "com.apple.Terminal" } },
      "surface",
    ],
    [
      "a password manager in front",
      { front: { appId: "com.1password.1password" } },
      "surface",
    ],
  ];
  for (const [label, options, code] of refusals)
    it(`never captures with ${label}`, async () => {
      const t = setup(options);
      t.begin();
      await t.say(...openSlackAnd);
      await t.early.idle();
      expect(t.calls).toEqual(["configure", "surface()"]);
      expect(t.early.finish(t.invocation, KEEP)).toBeUndefined();
      await ticks();
      expect(t.of("EarlyStartEnded")).toEqual([{ phase: "abandoned", code }]);
    });

  const noOpen: [string, DesktopOptions, EarlyCode][] = [
    [
      "an ambiguous name",
      { launcher: { launcherStatus: "ambiguous" } },
      "ambiguous",
    ],
    [
      "an unknown name",
      { launcher: { launcherStatus: "unresolved" } },
      "unresolved",
    ],
    ["a refused app", { launcher: { launcherStatus: "refused" } }, "refused"],
    [
      "an installer",
      {
        launcher: {
          launcherName: "Install macOS",
          launcherAppId: "com.apple.InstallAssistant.macOS",
        },
      },
      "policy",
    ],
    [
      "a protected app",
      {
        launcher: {
          launcherAppId: "com.bitwarden.desktop",
          launcherName: "Bitwarden",
        },
      },
      "policy",
    ],
    [
      "the app already in front with a window",
      { front: { appId: SLACK }, launcher: { windowCount: 2 } },
      "frontmost",
    ],
    ["untrusted accessibility", { launcher: { unknown: true } }, "policy"],
  ];
  for (const [label, options, code] of noOpen)
    it(`opens nothing for ${label}`, async () => {
      const t = setup(options);
      t.begin();
      await t.say(...openSlackAnd);
      await t.early.idle();
      expect(t.executed).toEqual([]);
      expect(t.calls).toContain("surface(open_app:frame-1)");
      expect(latchedAfterEveryResume(t.calls)).toBe(true);
      expect(t.of("EarlyStartExecuted")).toEqual([
        { code, settle: "boundary", target: "app" },
      ]);
      expect(t.opened).toEqual([]);
      expect(t.early.finish(t.invocation, KEEP)).toBeUndefined();
      await ticks();
      expect(t.of("EarlyStartEnded")).toEqual([
        { phase: "skipped", code, target: "app" },
      ]);
    });
  it("shows the main window of the app in front with none", async () => {
    const t = setup({ front: { appId: SLACK }, launcher: { windowCount: 0 } });
    t.begin();
    await t.say(...openSlackAnd);
    await t.early.idle();
    expect(t.executed).toHaveLength(1);
  });
  it("needs the exact name after a pause, not after a boundary", async () => {
    const chrome = {
      launcher: {
        launcherName: "Google Chrome",
        launcherAppId: "com.google.Chrome",
      },
    };
    const paused = setup(chrome);
    paused.begin();
    await paused.say(["Open", 0], ["Open Chrome", 300]);
    await paused.clk.to(2000);
    await paused.early.idle();
    expect(paused.executed).toEqual([]);
    expect(paused.of("EarlyStartExecuted")).toEqual([
      { code: "not_exact", settle: "pause", target: "app" },
    ]);
    const bounded = setup(chrome);
    bounded.begin();
    await bounded.say(
      ["Open", 0],
      ["Open Chrome", 300],
      ["Open Chrome and", 600],
    );
    await bounded.early.idle();
    expect(bounded.executed).toEqual([
      { type: "open_app", name: "Chrome", frame_id: "frame-1" },
    ]);
  });
  it("needs the exact name for an everyday word, boundary or not", async () => {
    // "open settings and turn off notifications": the launcher resolves
    // "settings" to System Settings, which the user did not name.
    const t = setup({
      launcher: {
        launcherName: "System Settings",
        launcherAppId: "com.apple.systempreferences",
      },
    });
    t.begin();
    await t.say(
      ["Open", 0],
      ["Open settings", 300],
      ["Open settings and", 600],
    );
    await t.early.idle();
    expect(t.executed).toEqual([]);
    expect(t.of("EarlyStartExecuted")).toEqual([
      { code: "not_exact", settle: "boundary", target: "app" },
    ]);
  });
  it("keeps nothing when the final arrives before the app was opened", async () => {
    // The screenshot is still running: the step never reached execute, so
    // there is nothing to hand the run, and nothing was said about it.
    const gate = deferred();
    const t = setup({ capture: () => gate.promise });
    t.begin();
    await t.say(...openSlackAnd);
    expect(t.early.finish(t.invocation, KEEP)).toBeUndefined();
    gate.resolve();
    await t.early.idle();
    expect(t.executed).toEqual([]);
    // "skipped": it settled but opened nothing.
    expect(t.of("EarlyStartEnded")).toEqual([
      { phase: "skipped", code: "final_first", target: "app" },
    ]);
  });
  it("opens nothing when the user switched apps since the screenshot", async () => {
    const t = setup();
    t.begin();
    await t.say(["Open", 0], ["Open Slack", 300]);
    await t.early.idle();
    t.state.front.appId = "com.apple.Safari";
    await t.say(["Open Slack and", 600]);
    await t.early.idle();
    expect(t.executed).toEqual([]);
    expect(t.of("EarlyStartExecuted")).toEqual([
      { code: "screen_changed", settle: "boundary", target: "app" },
    ]);
  });
  it("gives up when the user touches the mouse or keys during the step", async () => {
    const t = setup({
      execute: async () => {
        throw Object.assign(new Error("Native input stopped."), {
          code: "STOPPED",
        });
      },
    });
    t.begin();
    await t.say(...openSlackAnd);
    await t.early.idle();
    expect(t.calls.slice(-2)).toEqual(["execute", "stop"]);
    expect(t.calls).not.toContain("request(rememberForeground)");
    expect(t.of("EarlyStartExecuted")[0]).toMatchObject({ code: "user_input" });
    expect(t.opened).toEqual([]);
    expect(t.early.finish(t.invocation, KEEP)).toBeUndefined();
  });
  it("takes the screenshot again when it is older than frameMaxAgeMs", async () => {
    const t = setup();
    t.begin();
    await t.say(["Open", 0]);
    await t.early.idle();
    const late = EARLY_LIMITS.frameMaxAgeMs + 1000;
    await t.say(["Open Slack", late], ["Open Slack and", late + 300]);
    await t.early.idle();
    expect(t.calls.filter((c) => c === "capture")).toHaveLength(2);
    expect(t.executed).toEqual([
      { type: "open_app", name: "Slack", frame_id: "frame-2" },
    ]);
    expect(latchedAfterEveryResume(t.calls)).toBe(true);
  });
});

describe("early start: gates", () => {
  for (const code of [
    "blocked_run",
    "blocked_approval",
    "blocked_queue",
    "blocked_starting",
    "unavailable",
    "cancelled",
  ] as EarlyCode[])
    it(`makes no native call while ${code}`, async () => {
      const t = setup({ blocked: code });
      t.begin();
      await t.say(...openSlackAnd);
      await t.early.idle();
      expect(t.calls).toEqual([]);
      t.early.finish(t.invocation, KEEP);
      await ticks();
      // Refused at the screenshot: nothing ever settled.
      expect(t.of("EarlyStartEnded")).toEqual([{ phase: "abandoned", code }]);
    });
  it("makes no native call with the setting off", async () => {
    const t = setup({ settings: { earlyStart: false } });
    t.begin();
    await t.say(...openSlackAnd);
    await t.early.idle();
    expect(t.calls).toEqual([]);
    expect(t.early.finish(t.invocation, KEEP)).toBeUndefined();
    expect(t.traces).toEqual([]);
  });
  it("refuses the step when the setting is turned off mid-turn", async () => {
    const t = setup();
    t.begin();
    await t.say(["Open", 0], ["Open Slack", 300]);
    await t.early.idle();
    t.config.settings = { ...t.config.settings, earlyStart: false };
    await t.say(["Open Slack and", 600]);
    await t.clk.to(2000);
    await t.early.idle();
    expect(t.executed).toEqual([]);
  });
  it("makes no native call without the helper", async () => {
    const t = setup({ noController: true });
    t.begin();
    await t.say(...openSlackAnd);
    await t.early.idle();
    expect(t.calls).toEqual([]);
  });
  it("waits for the activation's rememberForeground before any call", async () => {
    const ready = deferred();
    const t = setup();
    t.begin(ready.promise);
    await t.say(...openSlackAnd);
    expect(t.calls).toEqual([]);
    ready.resolve();
    await t.early.idle();
    expect(t.executed).toHaveLength(1);
  });
  it("never acts on the wake phrase, a stop or a credential", async () => {
    for (const steps of [
      [
        ["Hey Butler", 0],
        ["Hey Butler", 900],
      ],
      [["stop", 0]],
      [
        ["Open Slack and type password: hunter2x9", 0],
        ["Open Slack and type password: hunter2x9 now", 200],
      ],
    ] as [string, number][][]) {
      const t = setup();
      t.begin();
      await t.say(...steps);
      await t.clk.to(5000);
      await t.early.idle();
      expect(t.calls, JSON.stringify(steps)).toEqual([]);
    }
  });
  it("never opens after a veto, even when the words settle later", async () => {
    const t = setup();
    t.begin();
    await t.say(
      ["Open Slack", 0],
      ["Open Slack no", 200],
      ["Open Slack no Discord and", 400],
      ["Open Slack no Discord and go", 600],
    );
    await t.clk.to(5000);
    await t.early.idle();
    expect(t.executed).toEqual([]);
    expect(t.calls.filter((c) => c.startsWith("surface(open_app"))).toEqual([]);
  });
});

describe("early start: the turn", () => {
  it("aborts a screenshot in flight on cancel and never executes", async () => {
    const gate = deferred();
    const t = setup({ capture: () => gate.promise });
    t.begin();
    await t.say(...openSlackAnd);
    t.early.cancel("cancelled");
    gate.resolve();
    await t.early.idle();
    expect(t.executed).toEqual([]);
    expect(t.calls.at(-1)).toBe("stop");
    expect(latchedAfterEveryResume(t.calls)).toBe(true);
    await ticks();
    expect(t.of("EarlyStartEnded")).toEqual([
      { phase: "skipped", code: "cancelled", target: "app" },
    ]);
  });
  it("opens nothing when the turn is cancelled while the app is looked up", async () => {
    const gate = deferred();
    const t = setup({ lookup: () => gate.promise });
    t.begin();
    await t.say(...openSlackAnd);
    expect(t.calls.at(-1)).toBe("surface(open_app:frame-1)");
    t.early.cancel("cancelled");
    gate.resolve();
    await t.early.idle();
    expect(t.executed).toEqual([]);
    expect(t.calls.at(-1)).toBe("surface(open_app:frame-1)");
    expect(t.of("EarlyStartExecuted")).toEqual([
      { code: "cancelled", settle: "boundary", target: "app" },
    ]);
  });
  it("opens nothing when a run starts while the app is looked up", async () => {
    const gate = deferred();
    const t = setup({ lookup: () => gate.promise });
    t.begin();
    await t.say(...openSlackAnd);
    t.config.blocked = "blocked_starting";
    gate.resolve();
    await t.early.idle();
    expect(t.executed).toEqual([]);
    expect(t.of("EarlyStartExecuted")).toEqual([
      { code: "blocked_starting", settle: "boundary", target: "app" },
    ]);
  });
  it("makes no native call on a cancel after the app opened", async () => {
    const t = setup();
    t.begin();
    await t.say(...openSlackAnd);
    await t.early.idle();
    const before = t.calls.length;
    t.early.cancel("cancelled");
    await t.early.idle();
    expect(t.calls).toHaveLength(before);
    await ticks();
    expect(t.of("EarlyStartEnded")).toEqual([
      { phase: "abandoned", code: "cancelled", target: "app" },
    ]);
  });
  it("lets the final win the race: a timer after it does nothing", async () => {
    const t = setup();
    t.begin();
    await t.say(["Open", 0], ["Open Slack", 300]);
    expect(t.early.finish(t.invocation, "Open Slack")).toBeUndefined();
    await t.clk.to(5000);
    await t.early.idle();
    expect(t.calls.filter((c) => c.startsWith("surface(open_app"))).toEqual([]);
    expect(t.executed).toEqual([]);
    expect(t.of("EarlyStartEnded")).toEqual([
      { phase: "abandoned", code: "final_first" },
    ]);
  });
  it("keeps nothing when the final words changed, and the app stays", async () => {
    const t = setup();
    t.begin();
    await t.say(...openSlackAnd);
    await t.early.idle();
    expect(t.early.finish(t.invocation, "Open Slate and message Dana")).toBe(
      undefined,
    );
    await ticks();
    expect(t.of("EarlyStartEnded")).toEqual([
      { phase: "abandoned", code: "final_changed", target: "app" },
    ]);
    // Never undone, and the app the user was in is still the remembered one:
    // only a kept step re-remembers (in take()), so the restore still works.
    expect(t.calls.at(-1)).toBe("stop");
    expect(t.calls).not.toContain("request(rememberForeground)");
  });
  it("aborts a step still on its way when the final changed", async () => {
    const gate = deferred();
    const t = setup({ resume: () => gate.promise });
    t.begin();
    await t.say(...openSlackAnd);
    expect(t.early.finish(t.invocation, "Open Discord")).toBeUndefined();
    gate.resolve();
    await t.early.idle();
    expect(t.executed).toEqual([]);
    expect(latchedAfterEveryResume(t.calls)).toBe(true);
  });
  it("hands an in-flight cold launch to the run that keeps it", async () => {
    const launch = deferred<ExecutionResult>();
    const t = setup({ execute: () => launch.promise });
    t.begin();
    await t.say(...openSlackAnd);
    const claim = t.early.finish(t.invocation, KEEP)!;
    expect(claim).toBeDefined();
    let prelude: unknown;
    void claim.take().then((p) => (prelude = p));
    await ticks();
    expect(prelude).toBeUndefined();
    launch.resolve({
      launched: {
        appId: SLACK,
        name: "Slack",
        frontmost: true,
        wasRunning: false,
      },
    });
    await t.early.idle();
    await ticks();
    expect(prelude).toMatchObject({ action: { name: "Slack" } });
    expect(t.signals[0].aborted).toBe(false);
  });
  it("records one end per turn: release after take is a no-op", async () => {
    const t = setup();
    t.begin();
    await t.say(...openSlackAnd);
    await t.early.idle();
    const claim = t.early.finish(t.invocation, KEEP)!;
    await claim.take();
    claim.release("plan_not_start");
    await ticks();
    expect(t.of("EarlyStartEnded")).toEqual([
      { phase: "kept", code: "ok", target: "app", leadMs: expect.any(Number) },
    ]);
    // A turn that did not start a run releases the step instead.
    const other = setup();
    other.begin();
    await other.say(...openSlackAnd);
    await other.early.idle();
    other.early.finish(other.invocation, KEEP)!.release("plan_not_start");
    await ticks();
    expect(other.of("EarlyStartEnded")).toEqual([
      { phase: "released", code: "plan_not_start", target: "app" },
    ]);
  });
  it("ends the old turn on a new activation during the step", async () => {
    const launch = deferred<void>();
    const t = setup({ execute: () => launch.promise });
    t.begin();
    await t.say(...openSlackAnd);
    expect(t.calls.at(-1)).toBe("execute");
    t.begin();
    expect(t.signals[0].aborted).toBe(true);
    launch.resolve();
    await t.early.idle();
    await ticks();
    expect(t.of("EarlyStartEnded")).toEqual([
      { phase: "abandoned", code: "reactivated", target: "app" },
    ]);
    // The old turn's words no longer count.
    t.early.partial(t.invocation - 1, "Open Notes and");
    await t.clk.to(5000);
    await t.early.idle();
    expect(t.executed).toHaveLength(1);
  });
  it("resolves idle() only after the step's stop()", async () => {
    const launch = deferred<void>();
    const t = setup({ execute: () => launch.promise });
    t.begin();
    await t.say(...openSlackAnd);
    let idle = false;
    void t.early.idle().then(() => (idle = true));
    await ticks();
    expect(idle).toBe(false);
    launch.resolve();
    await t.early.idle();
    expect(idle).toBe(true);
    expect(t.calls.slice(t.calls.indexOf("execute"))).toEqual([
      "execute",
      "stop",
    ]);
  });

  it("keeps the latch closed and only opens apps and standard folders, whatever happens (property)", async () => {
    // A small seeded generator: failures and interleavings are reproducible.
    let seed = 20260918;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const texts = [
      "Open",
      "Open Slack",
      "Open Slack and",
      "Open Slack and message",
      "Open Slate and",
      "Open Slack no",
      "open the",
      "stop",
      "Switch to Safari and",
      "Hey Butler",
      "Open Notes",
      "Go to youtube",
      "go to github dot com and",
      "Open downloads",
      "open my downloads folder and",
      "open Visual",
    ];
    const maybe = async (what: string) => {
      for (let i = Math.floor(random() * 3); i > 0; i--) await ticks(1);
      if (random() < 0.12)
        throw Object.assign(new Error(`${what} failed`), {
          code: random() < 0.5 ? "STOPPED" : "NATIVE",
        });
    };
    for (let round = 0; round < 60; round++) {
      const t = setup({
        capture: () => maybe("capture"),
        resume: () => maybe("resume"),
        execute: async () => {
          await maybe("execute");
          return undefined;
        },
        knownApps: ["visual studio code", "slack"],
      });
      const lookups = new Map<number, number>();
      const surface = t.controller.surface;
      t.controller.surface = async (action?: Action) => {
        if (action)
          lookups.set(t.invocation, (lookups.get(t.invocation) ?? 0) + 1);
        return surface(action);
      };
      t.begin();
      let at = 0;
      for (let step = 0; step < 14; step++) {
        const r = random();
        at += Math.floor(random() * 700);
        if (r < 0.62)
          await t.say([texts[Math.floor(random() * texts.length)], at]);
        else if (r < 0.72) await t.clk.to(at);
        else if (r < 0.8) t.early.cancel("cancelled");
        else if (r < 0.88) {
          const claim = t.early.finish(t.invocation, KEEP);
          if (claim && random() < 0.5) await claim.take();
          else claim?.release("plan_not_start");
        } else t.begin();
      }
      await t.clk.to(at + 5000);
      await t.early.idle();
      expect(latchedAfterEveryResume(t.calls), t.calls.join(",")).toBe(true);
      for (const a of t.executed)
        if (a.type === "open_file") expect(a.path).toBe("~/Downloads");
        else expect(a.type).toBe("open_app");
      // One settle per turn: at most one app lookup, whatever the partials.
      for (const n of lookups.values()) expect(n).toBeLessThanOrEqual(2);
    }
  });
});

describe("early start: main.ts wiring", () => {
  // main.ts is not loaded in tests; the wiring is pinned by reading it.
  const source = readFileSync(
    new URL("../electron/main.ts", import.meta.url),
    "utf8",
  );
  const receive = source.slice(source.indexOf("async function receiveVoice("));
  const branch = (event: string) => {
    const start = receive.indexOf(`event.event === "${event}"`);
    const next = receive.indexOf("} else if (", start + 1);
    const end = next > 0 ? next : receive.indexOf("} catch (error) {", start);
    expect([event, start > 0 && end > start]).toEqual([event, true]);
    return receive.slice(start, end);
  };
  const fn = (name: string) => {
    const start = source.indexOf(`function ${name}(`);
    expect([name, start > 0]).toEqual([name, true]);
    return source.slice(start, source.indexOf("\n}\n", start));
  };
  it("feeds partials of the current activation and ends the turn on every non-final", () => {
    const activation = receive.slice(
      receive.indexOf('event.event === "shortcut_down"'),
      receive.indexOf('event.event === "shortcut_tap"'),
    );
    expect(activation).toMatch(
      /voiceContext = getNative\(\)\.request\("rememberForeground"\);\s*(?:\/\/.*\n\s*)*early\.begin\(invocation, voiceContext\);/,
    );
    expect(branch("transcript_partial")).toContain(
      "early.partial(voiceInvocation, lastPartial);",
    );
    expect(branch("voice_cancelled")).toContain('early.cancel("cancelled");');
    expect(branch("transcript_unconfirmed")).toContain(
      'early.cancel("no_final");',
    );
    expect(branch("voice_error")).toContain('early.cancel("no_final");');
    expect(fn("cancelVoiceCapture")).toContain('early.cancel("cancelled");');
    expect(branch("transcript_recovered")).toMatch(
      /if \(!heard\.text\) \{\s*early\.cancel\("no_final"\);/,
    );
    const whole = fn("receiveVoice");
    expect(whole.slice(whole.lastIndexOf("} catch (error) {"))).toContain(
      'early.cancel("native_error");',
    );
    const helper = fn("getVoice");
    expect(
      helper.slice(
        helper.indexOf("onUnavailable"),
        helper.indexOf("onRestart"),
      ),
    ).toContain('early.cancel("cancelled");');
  });
  it("hands the final and its activation to command, which settles the step first", () => {
    expect(branch("transcript_recovered")).toMatch(
      /command\(heard\.text, true, voiceCommandConfidence\(event\), \{\s*segments: heard\.segments,\s*invocation,/,
    );
    const command = fn("command");
    expect(command).toMatch(
      /const turnInvocation = extra\.invocation \?\? voiceInvocation;\s*const claim = fromVoice \? early\.finish\(turnInvocation, text\) : undefined;/,
    );
    expect(command).toMatch(
      /try \{\s*await planCommand\([^)]*claim,\s*turnInvocation,?\s*\);\s*\} finally \{\s*(?:\/\/.*\n\s*)*claim\?\.release\("plan_not_start"\);/,
    );
  });
  it("never announces an already opened app as opening", () => {
    expect(fn("planCommand")).toMatch(
      /line: claim\s*\? undefined\s*: decision\.code === "fast_start" \|\| decision\.code === "jev_start"\s*\? fastStartLine\(text\)/,
    );
  });
  it("takes the step before the restore and passes it only to the voice start", () => {
    const run = fn("runPlan");
    const start = run.slice(run.indexOf('case "start": {'));
    const take = start.indexOf("await ctx.early.take()");
    const restore = start.indexOf('await native?.request("restoreRemembered")');
    expect(take).toBeGreaterThan(0);
    expect(restore).toBeGreaterThan(take);
    expect(start).toContain('ctx.early?.release("run_active_at_final");');
    expect(start).toMatch(/await startRun\([\s\S]*?prelude,\s*\);/);
  });
  it("starts a Runner only once the early sections are closed", () => {
    const startRun = fn("startRun");
    const idle = startRun.indexOf("await early.idle();");
    expect(startRun.indexOf("startingRun = true;")).toBeLessThan(idle);
    expect(idle).toBeGreaterThan(0);
    expect(startRun.indexOf("new Runner(")).toBeGreaterThan(idle);
    expect(startRun).toMatch(/finally \{\s*startingRun = false;/);
    // The IPC, queue, remote and watch entry never passes a prelude.
    const dispatch = source.slice(
      source.indexOf(
        'case "start": {',
        source.indexOf("async function dispatch("),
      ),
    );
    expect(dispatch.slice(0, dispatch.indexOf("return;"))).toMatch(
      /await startRun\(task, tutorial, args\[2\]\);/,
    );
  });
  it("gates the step on everything that runs, waits or starts", () => {
    const gate = source.slice(
      source.indexOf("const early = new EarlyStart("),
      source.indexOf("trace: debug,"),
    );
    for (const code of [
      '"unavailable"',
      '"cancelled"',
      '"blocked_run"',
      '"blocked_approval"',
      '"blocked_queue"',
      '"blocked_starting"',
    ])
      expect(gate).toContain(code);
    expect(gate).toContain("runActive() || (runner && !runner.settled)");
    // The pill says so while listening, and only then.
    expect(gate).toMatch(
      /if \(listening && pill\.phase === "listening"\)\s*setPill\(\{ label: `Opened \$\{name\.slice\(0, 40\)\} · Listening…` \}\);/,
    );
    expect(gate).toContain("taskQueue.list(Date.now()).length");
  });
});
