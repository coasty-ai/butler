import { expect, test, vi } from "vitest";
import { Runner } from "../src/core/runner";
import {
  defaultSettings,
  type Action,
  type Controller,
  type Frame,
  type ExecutionResult,
  type Observation,
  type Recorder,
  type Run,
  type RunTarget,
  type Surface,
} from "../src/core/schema";
import { TargetError } from "../src/core/errors";
import { runView } from "../src/assistant/run-view";

// Protocol-only SYNTHETIC desktop. No native helper, UI or browser is accessed.
function fixture(actions: Record<string, unknown>[]) {
  const code: RunTarget = {
    token: "code-a",
    appId: "com.microsoft.VSCode",
    appName: "Code",
    pid: 41,
    windowId: 101,
    title: "SYNTHETIC project A",
  };
  const otherCode = {
    ...code,
    token: "code-b",
    windowId: 102,
    title: "SYNTHETIC project B — coding agent",
  };
  const chrome: RunTarget = {
    token: "chrome",
    appId: "com.google.Chrome",
    appName: "Google Chrome",
    pid: 42,
    windowId: 201,
    title: "SYNTHETIC browser",
  };
  const owner = {
    ...code,
    token: "owner",
    appId: "com.apple.mail",
    appName: "Mail",
    pid: 99,
    windowId: 301,
  };
  let front = owner,
    bound = code,
    focusedCode = code,
    frames = 0;
  const observations: Observation[] = [],
    events: { type: string; data: any }[] = [];
  let run: Run;
  const surface = (w: RunTarget, action?: Action): Surface => ({
    appId: w.appId,
    appName: w.appName,
    pid: w.pid,
    unknown: false,
    secureInput: false,
    ...(action?.type === "open_app" && {
      launcherStatus: "resolved",
      launcherName: action.name,
      launcherAppId:
        action.name === "Google Chrome" ? chrome.appId : code.appId,
    }),
    ...(action?.type === "menu_item" && {
      menuStatus: "resolved",
      menuLabel: action.path.at(-1),
    }),
  });
  const frame = (w: RunTarget): Frame => ({
    id: `f-${++frames}`,
    sha256: `s-${frames}`,
    image: "",
    synthetic: false,
    capturedAt: Date.now(),
    appId: w.appId,
    geometry: {
      display_id: 1,
      x: 0,
      y: 0,
      width: 800,
      height: 600,
      native_width: 800,
      native_height: 600,
      model_width: 800,
      model_height: 600,
      scale_factor: 1,
    },
    context: {
      appName: w.appName,
      windowTitle: w.title,
      menus: [
        "File: New Window",
        "Window: SYNTHETIC project A, SYNTHETIC project B",
      ],
      openApps: [
        "Code: SYNTHETIC project A, SYNTHETIC project B",
        "Google Chrome: SYNTHETIC browser",
      ],
    },
  });
  const controller: Controller = {
    kind: "native",
    surface: vi.fn(async (a) => surface(front, a)),
    capture: vi.fn(async () => frame(front)),
    captureTarget: vi.fn(async (token) => {
      expect(token).toBe(bound.token);
      return frame(bound);
    }),
    surfaceTarget: vi.fn(
      async (token: string, a?: Action): Promise<Surface> => {
        expect(token).toBe(bound.token);
        return {
          ...surface(bound, a),
          target: {
            bound: true,
            covered: false,
            minimized: false,
            focusedWindow: true,
            siblingWindows: 1,
          },
        };
      },
    ),
    bindTarget: vi.fn(async (spec) => {
      if (
        spec.pid === chrome.pid ||
        spec.app === "Google Chrome" ||
        spec.app === chrome.appId
      )
        bound = chrome;
      else bound = focusedCode;
      return { ...bound };
    }),
    foregroundTarget: vi.fn(async (token) => {
      expect(token).toBe(bound.token);
      front = bound;
      return { frontmost: true };
    }),
    restoreRemembered: vi.fn(async () => {
      front = owner;
    }),
    unbindTarget: vi.fn(async () => {}),
    executeTarget: vi.fn(async (token: string): Promise<ExecutionResult> => {
      expect(token).toBe(bound.token);
      return { rung: "ax", effect: "changed" };
    }),
    execute: vi.fn(async (a: Action, f: Frame): Promise<ExecutionResult> => {
      expect(f.appId).toBe(front.appId);
      expect(a.frame_id).toBe(f.id);
      if (a.type === "open_app") {
        front = a.name === "Google Chrome" ? chrome : focusedCode;
        return {
          launched: {
            appId: front.appId,
            name: front.appName,
            frontmost: true,
            wasRunning: true,
            windows: 1,
          },
        };
      }
      if (a.type === "open_url") {
        front = chrome;
        return {
          navigated: { appId: chrome.appId, host: "example.com", via: "open" },
        };
      }
      if (a.type === "menu_item") {
        focusedCode =
          a.path.at(-1) === "SYNTHETIC project A" ? code : otherCode;
        front = focusedCode;
      }
      return { effect: "changed" };
    }),
    stop: vi.fn(),
    resume: vi.fn(async () => {}),
    restore: vi.fn(async () => {}),
    revalidate: vi.fn(async (_a, f) => f),
  };
  const recorder: Recorder = {
    begin: (r) => {
      run = r;
    },
    save: (r) => {
      run = r;
    },
    frame: () => {},
    append: (id, type, data = {}) => {
      events.push({ type, data });
      return {
        event_id: crypto.randomUUID(),
        run_id: id,
        type,
        data,
        schema_version: 1,
        sequence_number: events.length,
        monotonic_timestamp: 0,
        wall_clock_timestamp: new Date().toISOString(),
      };
    },
  };
  const next = vi.fn(async (o: Observation) => {
    observations.push(structuredClone(o));
    const action = actions.shift() ?? {
      type: "done",
      summary: "SYNTHETIC complete",
    };
    return {
      action: { ...action, frame_id: o.frame.id } as Action,
      usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
    };
  });
  const runner = new Runner(
    controller,
    { next },
    recorder,
    {
      ...defaultSettings,
      memory: true,
      workInBackground: true,
      maxActions: 15,
    },
    () => {},
  );
  const start = (extra: object = {}) =>
    runner.start("SYNTHETIC workspace task", {
      origin: "typed",
      taskSource: "user_words",
      background: true,
      multiWindow: true,
      ...extra,
    });
  return {
    code,
    chrome,
    owner,
    runner,
    controller,
    observations,
    events,
    start,
    run: () => run!,
    front: () => front,
    setFront: (w: RunTarget) => {
      front = w;
    },
  };
}

test("a task leaves Code, navigates a browser, creates another Code window and returns with separate context", async () => {
  const f = fixture([
    { type: "capture", note: "SYNTHETIC A: waiting for review" },
    { type: "open_app", name: "Google Chrome" },
    { type: "open_url", url: "https://example.com/synthetic" },
    { type: "open_app", name: "Code" },
    { type: "menu_item", path: ["File", "New Window"] },
    { type: "capture", note: "SYNTHETIC B: agent working" },
    { type: "menu_item", path: ["Window", "SYNTHETIC project A"] },
  ]);
  await f.start();
  expect(f.run().status).toBe("completed");
  expect(f.run().actions).toBe(7);
  expect(f.controller.execute).toHaveBeenCalledTimes(5);
  expect(
    vi
      .mocked(f.controller.execute)
      .mock.calls.find(([a]) => a.type === "open_url")?.[3],
  ).toEqual({
    browser: { name: "Google Chrome", bundleId: "com.google.Chrome" },
  });
  expect(f.controller.executeTarget).not.toHaveBeenCalled();
  expect(f.front()).toEqual(f.owner);
  expect(f.observations.at(-1)?.frame.context?.background?.canNavigate).toBe(
    true,
  );
  const windows = f.observations.at(-1)!.windows!;
  expect(windows.map((w) => w.windowId).sort()).toEqual([101, 102, 201]);
  expect(windows.find((w) => w.windowId === 101)?.facts).toEqual([
    "SYNTHETIC A: waiting for review",
  ]);
  expect(windows.find((w) => w.windowId === 102)?.facts).toEqual([
    "SYNTHETIC B: agent working",
  ]);
  expect(JSON.stringify(windows)).not.toContain('"token"');
  expect(
    runView(undefined, {
      queued: [],
      watches: [],
      lastFinished: f.run(),
      now: Date.now(),
    }).windows,
  ).toHaveLength(3);
  const resumed = fixture([]);
  await resumed.start({ windows });
  expect(resumed.observations[0].windows).toHaveLength(3);
  expect(resumed.controller.bindTarget).toHaveBeenCalledExactlyOnceWith({});
});

test("a task with no opening window binds the window it launches", async () => {
  const f = fixture([{ type: "open_app", name: "Google Chrome" }]);
  vi.mocked(f.controller.bindTarget!).mockRejectedValueOnce(
    new TargetError("TARGET_GONE", "SYNTHETIC no window"),
  );
  await f.start();
  expect(f.run().target?.appId).toBe(f.chrome.appId);
  expect(f.run().windows?.map((w) => w.windowId)).toEqual([201]);
});

test("browser script navigation binds its explicit browser while the source app stays foreground", async () => {
  const f = fixture([
    { type: "open_url", url: "https://example.com/synthetic" },
  ]);
  vi.mocked(f.controller.execute).mockResolvedValueOnce({
    navigated: { host: "example.com", appId: f.chrome.appId, via: "script" },
  });
  await f.start();
  expect(f.run().status).toBe("completed");
  expect(f.run().target?.appId).toBe(f.chrome.appId);
  expect(f.controller.bindTarget).toHaveBeenLastCalledWith({
    app: f.chrome.appId,
  });
});

test.each(["focus", "protected", "secure", "destination", "binding"])(
  "navigation refuses a changed %s before further input",
  async (mode) => {
    const f = fixture([
      { type: "open_app", name: "Google Chrome" },
      { type: "key", key: "ENTER" },
    ]);
    if (mode === "binding")
      vi.mocked(f.controller.bindTarget!)
        .mockImplementationOnce(async () => f.code)
        .mockResolvedValueOnce(f.owner);
    else if (mode === "destination")
      vi.mocked(f.controller.execute).mockImplementationOnce(async () => {
        f.setFront(f.owner);
        return {
          launched: {
            appId: f.chrome.appId,
            name: f.chrome.appName,
            frontmost: true,
            wasRunning: true,
          },
        };
      });
    else
      vi.mocked(f.controller.surface).mockResolvedValueOnce({
        appId:
          mode === "protected"
            ? "com.apple.systempreferences"
            : mode === "focus"
              ? f.owner.appId
              : f.code.appId,
        pid: mode === "focus" ? f.owner.pid : f.code.pid,
        unknown: false,
        secureInput: mode === "secure",
      });
    const work = f.start();
    await vi.waitFor(() =>
      expect(f.runner.snapshot.run?.status).toBe("takeover"),
    );
    expect(f.controller.execute).toHaveBeenCalledTimes(
      ["destination", "binding"].includes(mode) ? 1 : 0,
    );
    expect(f.controller.executeTarget).not.toHaveBeenCalled();
    f.runner.stop();
    await work;
    expect(f.front()).toEqual(f.owner);
  },
);

test("window context does not auto-answer a coding agent's approval", async () => {
  const f = fixture([
    { type: "menu_item", path: ["Window", "SYNTHETIC project B"] },
    { type: "key", key: "ENTER" },
    { type: "request_user", reason: "SYNTHETIC agent needs your approval" },
  ]);
  const normal = f.controller.surfaceTarget!;
  f.controller.surfaceTarget = vi.fn(async (token, a) => ({
    ...(await normal(token, a)),
    ...(a?.type === "key" && {
      terminalFocus: true,
      focusedRole: "AXTextArea",
    }),
  }));
  const work = f.start();
  await vi.waitFor(() =>
    expect(f.runner.snapshot.run?.status).toBe("takeover"),
  );
  expect(f.controller.execute).toHaveBeenCalledTimes(1);
  expect(f.controller.executeTarget).not.toHaveBeenCalled();
  f.runner.stop();
  await work;
});
test("stopping during a foreground handoff restores focus and sends no action", async () => {
  const f = fixture([{ type: "open_app", name: "Google Chrome" }]);
  const raise = f.controller.foregroundTarget!;
  f.controller.foregroundTarget = vi.fn(async (token) => {
    const result = await raise(token);
    f.runner.stop();
    return result;
  });
  await f.start();
  expect(f.run().status).toBe("cancelled");
  expect(f.controller.execute).not.toHaveBeenCalled();
  expect(f.front()).toEqual(f.owner);
});
test("foreground mode does not acquire a background binding after opening an app", async () => {
  const f = fixture([{ type: "open_app", name: "Google Chrome" }]);
  await f.start({ background: false });
  expect(f.run().status).toBe("completed");
  expect(f.run().target).toBeUndefined();
  expect(f.controller.bindTarget).not.toHaveBeenCalled();
  expect(f.controller.execute).toHaveBeenCalledOnce();
});
