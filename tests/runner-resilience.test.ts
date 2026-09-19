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
  type ScreenContext,
  type Settings,
  type Snapshot,
  type Surface,
} from "../src/core/schema";
import {
  Runner,
  TARGET_HANDOFF_MESSAGE,
  actionSignature,
  declinedResult,
  nativeAction,
  refusedTargetsWarning,
  repetitionPeriod,
  screenChangedResult,
  searchRoute,
} from "../src/core/runner";
import { PASTE_ALLOWED } from "../src/core/policy";
import type { MemoryAccess } from "../src/core/memory";
import {
  HelperUnavailableError,
  NativeActionError,
  NativeStoppedError,
  ProviderTransientError,
  ScreenChangedError,
  SurfaceBlockedError,
} from "../src/core/errors";

type Decision = { kind: string; reason: string };
// Lets a test pin the policy decision so the runner's reactions are tested
// independently of the policy vocabulary; unset tests use the real policy.
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
function memory() {
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
    frame: (_id, f) => frames.push(f),
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
let captures = 0;
function controller(overrides: Partial<Controller> = {}): Controller {
  return {
    kind: "native",
    surface: async () => surface,
    capture: async () => ({
      id: `frame-${++captures}`,
      sha256: "sha",
      image: "",
      geometry,
      capturedAt: 0,
      synthetic: false,
      appId: surface.appId,
    }),
    execute: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    stop: vi.fn(() => {}),
    ...overrides,
  };
}
/** Provider that plays scripted replies, then finishes the task. */
function scripted(
  replies: ((o: Observation) => Partial<ProviderResult> | Error)[],
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
const act =
  (action: Record<string, unknown>) =>
  (o: Observation): Partial<ProviderResult> => ({
    action: { ...action, frame_id: o.frame.id },
  });
const hang = (_o: Observation, signal: AbortSignal) =>
  new Promise<never>((_r, reject) =>
    signal.addEventListener("abort", () => reject(new Error("Cancelled"))),
  );
const allowAll = () => {
  policy.evaluate = (a) =>
    a.type === "done"
      ? { kind: "ALLOW", reason: "" }
      : { kind: "ALLOW", reason: "Test." };
};

describe("runner recovery from model output", () => {
  it("treats malformed output as a rejected step and still counts its usage", async () => {
    const m = memory();
    const p = scripted([
      () => ({
        action: undefined,
        problem: "Expected one action",
        usage: { inputTokens: 10, outputTokens: 5, cost: 0.01 },
      }),
    ]);
    const runner = new Runner(controller(), p, m.recorder, settings, () => {});
    await runner.start("Open Notes");
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(runner.snapshot.run?.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      cost: 0.01,
    });
    expect(m.of("ActionFailed")[0].data).toEqual({
      code: "MALFORMED_RESPONSE",
      problem: "Expected one action",
    });
    const last = p.observations[1].history.at(-1)!;
    expect(last.type).toBe("rejected");
    expect(last.result).toContain("Expected one action");
    expect(last.result).toContain("the frame_id from the current context");
    expect(JSON.stringify(p.observations[1].history)).not.toMatch(/frame-\d/);
  });
  // Live 2026-09-19 (two gpt-5.4-mini cycles, 11 of 733 model calls): the
  // provider answered "The action arguments were not valid JSON." and the
  // runner asked again with a generic line. The reply now carries the
  // provider's own remedy for its request format, the failure event carries
  // the fixed problem, and the corrected step runs on the very next call.
  it("asks again after a malformed reply with the provider's remedy, then executes the corrected step", async () => {
    allowAll();
    const m = memory();
    const c = controller();
    const p = scripted([
      () => ({
        action: undefined,
        problem: "The action arguments were not valid JSON.",
        remedy:
          "Call coarena_action once with action set to the action object itself.",
        usage: { inputTokens: 10, outputTokens: 5, cost: 0.01 },
      }),
      act({ type: "click", x: 0.5, y: 0.5 }),
    ]);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    await runner.start("test");
    expect(runner.snapshot.run?.status).toBe("completed");
    const watched = new Set([
      "ModelRequestStarted",
      "ModelResponseReceived",
      "ActionFailed",
      "ActionExecuted",
      "RunPaused",
    ]);
    expect(m.events.map((e) => e.type).filter((t) => watched.has(t))).toEqual([
      "ModelRequestStarted",
      "ModelResponseReceived",
      "ActionFailed",
      "ModelRequestStarted",
      "ModelResponseReceived",
      "ActionExecuted",
      "ModelRequestStarted",
      "ModelResponseReceived",
    ]);
    expect(m.of("ActionFailed")[0].data).toEqual({
      code: "MALFORMED_RESPONSE",
      problem: "The action arguments were not valid JSON.",
    });
    const rejection = p.observations[1].history.at(-1)!;
    expect(rejection.type).toBe("rejected");
    expect(rejection.result).toContain("not valid JSON");
    expect(rejection.result).toContain("action set to the action object");
    expect(rejection.result).toContain("the frame_id from the current context");
    expect(c.execute).toHaveBeenCalledTimes(1);
  });
  it("treats a repaired object the schema rejects as a malformed reply, not an invalid action", async () => {
    allowAll();
    const m = memory();
    const c = controller();
    const p = scripted([
      (o) => ({
        // The provider dug this out of prose or a fence: a guess, not a
        // clean reply, so a schema failure is the reply's fault.
        action: { type: "launch_rocket", frame_id: o.frame.id, payload: "x" },
        repaired: true,
        remedy: "Reply with one JSON action object and nothing else.",
      }),
      act({ type: "click", x: 0.5, y: 0.5 }),
    ]);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    await runner.start("test");
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(m.of("ActionFailed").map((e) => e.data.code)).toEqual([
      "MALFORMED_RESPONSE",
    ]);
    expect(typeof m.of("ActionFailed")[0].data.problem).toBe("string");
    const rejection = p.observations[1].history.at(-1)!;
    expect(rejection.type).toBe("rejected");
    expect(rejection.action).toBeUndefined();
    expect(rejection.result).toContain("not exactly one action");
    expect(rejection.result).toContain("one JSON action object");
    expect(JSON.stringify(p.observations[1].history)).not.toContain(
      "launch_rocket",
    );
    expect(c.execute).toHaveBeenCalledTimes(1);
  });
  it("keeps a clean invalid action an INVALID_ACTION with its cause, and pauses at the shared budget of four", async () => {
    const m = memory();
    const p = scripted([
      () => ({ action: undefined, problem: "No tool call" }),
      act({ type: "launch_rocket" }),
      () => ({ action: undefined, problem: "No tool call" }),
      act({ type: "launch_rocket" }),
      // Never reached before the pause: the budget is four, not five.
      act({ type: "launch_rocket" }),
    ]);
    const runner = new Runner(controller(), p, m.recorder, settings, () => {});
    const running = runner.start("test");
    await until(() => runner.snapshot.run?.status === "paused");
    expect(p.next).toHaveBeenCalledTimes(4);
    expect(m.of("ActionFailed").map((e) => e.data.code)).toEqual([
      "MALFORMED_RESPONSE",
      "INVALID_ACTION",
      "MALFORMED_RESPONSE",
      "INVALID_ACTION",
    ]);
    expect(m.of("ActionFailed")[1].data.cause).toBe("UNKNOWN_TYPE");
    expect(m.of("ActionFailed")[3].data.cause).toBe("UNKNOWN_TYPE");
    expect(m.of("RunPaused")).toHaveLength(1);
    await runner.resume();
    await running;
    expect(runner.snapshot.run?.status).toBe("completed");
  });
  it("pauses after four consecutive invalid replies instead of failing", async () => {
    const m = memory();
    const p = scripted(
      Array.from({ length: 4 }, () => () => ({
        action: undefined,
        problem: "No tool call",
      })),
    );
    const runner = new Runner(controller(), p, m.recorder, settings, () => {});
    const running = runner.start("test");
    await until(() => runner.snapshot.run?.status === "paused");
    expect(runner.snapshot.message).toContain(
      "keeps proposing invalid actions",
    );
    expect(p.next).toHaveBeenCalledTimes(4);
    await runner.resume();
    await running;
    expect(runner.snapshot.run?.status).toBe("completed");
  });
  it("normalizes pixel coordinates and executes the normalized click", async () => {
    allowAll();
    const m = memory();
    const c = controller();
    const p = scripted([act({ type: "click", x: 640, y: 360 })]);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    await runner.start("test");
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(c.execute).toHaveBeenCalledTimes(1);
    expect(vi.mocked(c.execute).mock.calls[0][0]).toMatchObject({
      type: "click",
      x: 0.5,
      y: 0.5,
    });
    expect(m.of("ActionNormalized")[0].data).toEqual({ actionType: "click" });
  });
  it("explains invalid actions by cause with a redacted echo", async () => {
    const m = memory();
    const p = scripted([
      () => ({
        action: { type: "type_text", text: "private words", frame_id: "old" },
      }),
      act({ type: "click", x: 1.5, y: 0.2 }),
      act({ type: "launch_rocket" }),
      act({ type: "scroll", delta_x: 0, delta_y: 10, script: "x" }),
    ]);
    const runner = new Runner(controller(), p, m.recorder, settings, () => {});
    const running = runner.start("test");
    // Four invalid replies in a row pause; continuing keeps the feedback.
    await until(() => runner.snapshot.run?.status === "paused");
    await runner.resume();
    await running;
    const history = p.observations[4].history;
    expect(history[0].result).toContain("old frame_id");
    expect(history[0].action).toEqual({ type: "type_text" });
    expect(history[1].result).toContain("divide pixel x by 1280");
    expect(history[1].action).toEqual({ type: "click", x: 1.5, y: 0.2 });
    expect(history[2].result).toContain("Unknown action type");
    expect(history[2].action).toEqual({ type: "unknown" });
    expect(history[3].result).toContain("does not accept: script");
    // Rejections never quote a concrete frame id that goes stale next step.
    for (const entry of history)
      expect(entry.result).toContain("the frame_id from the current context");
    expect(JSON.stringify(history)).not.toMatch(/frame-\d/);
    expect(JSON.stringify(p.observations)).not.toContain("private words");
    expect(JSON.stringify(m.events)).not.toContain("private words");
    expect(m.of("ActionFailed").map((e) => e.data.cause)).toEqual([
      "STALE_FRAME",
      "COORDINATES",
      "UNKNOWN_TYPE",
      "UNKNOWN_FIELD",
    ]);
  });
});

describe("runner recovery from provider outages", () => {
  it("retries a transient outage once on a fresh capture", async () => {
    const m = memory();
    const p = scripted([() => new ProviderTransientError("Connection reset.")]);
    const runner = new Runner(controller(), p, m.recorder, settings, () => {});
    await runner.start("test");
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(m.of("ProviderUnavailable")).toHaveLength(1);
    expect(p.observations[1].frame.id).not.toBe(p.observations[0].frame.id);
  });
  it("pauses after a second consecutive outage and resumes on continue", async () => {
    const m = memory();
    const p = scripted([
      () => new ProviderTransientError("Connection reset."),
      () => new ProviderTransientError("HTTP 503."),
    ]);
    const runner = new Runner(controller(), p, m.recorder, settings, () => {});
    const running = runner.start("test");
    await until(() => runner.snapshot.run?.status === "paused");
    expect(runner.snapshot.message).toBe(
      "I can’t reach the model service right now. Say continue to try again.",
    );
    await tick();
    expect(p.next).toHaveBeenCalledTimes(2);
    await runner.resume();
    await running;
    expect(runner.snapshot.run?.status).toBe("completed");
  });
  it("still fails for non-transient provider errors", async () => {
    const m = memory();
    const p = scripted([
      () => new Error("Add a provider API key in Settings."),
    ]);
    const runner = new Runner(controller(), p, m.recorder, settings, () => {});
    await runner.start("test");
    expect(runner.snapshot.run?.status).toBe("failed");
    expect(runner.snapshot.message).toBe("Add a provider API key in Settings.");
  });
});

describe("runner policy counters", () => {
  it("does not fail a run on mixed denials and invalid actions", async () => {
    policy.evaluate = (a) =>
      a.type === "key"
        ? {
            kind: "DENY",
            reason: "The selected Spotlight result is an installer.",
          }
        : undefined!;
    const m = memory();
    const p = scripted([
      act({ type: "key", key: "ENTER" }),
      act({ type: "click", x: 1.5, y: 1.5 }),
      act({ type: "key", key: "ENTER" }),
      act({ type: "click", x: 1.5, y: 1.5 }),
    ]);
    const runner = new Runner(controller(), p, m.recorder, settings, () => {});
    await runner.start("test");
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(p.observations[1].history[0]).toEqual({
      type: "key",
      action: { type: "key", key: "ENTER" },
      result:
        "No input was sent. The selected Spotlight result is an installer.",
    });
  });
  it("pauses with the reason after three non-credential denials", async () => {
    const reason = "Installers require manual operation.";
    policy.evaluate = (a) =>
      a.type === "key" ? { kind: "DENY", reason } : undefined!;
    const m = memory();
    const p = scripted(
      Array.from({ length: 3 }, () => act({ type: "key", key: "ENTER" })),
    );
    const runner = new Runner(controller(), p, m.recorder, settings, () => {});
    const running = runner.start("test");
    await until(() => runner.snapshot.run?.status === "paused");
    expect(runner.snapshot.message).toBe(reason);
    runner.stop();
    await running;
  });
  it("still fails repeated credential typing", async () => {
    const m = memory();
    const p = scripted(
      Array.from({ length: 3 }, () =>
        act({ type: "type_text", text: "sk-syntheticSECRETabcdefghijk" }),
      ),
    );
    const runner = new Runner(controller(), p, m.recorder, settings, () => {});
    await runner.start("test");
    expect(runner.snapshot.run?.status).toBe("failed");
    expect(runner.snapshot.message).toBe("Repeated policy violations.");
    expect(m.of("UserDenied")).toHaveLength(3);
    expect(JSON.stringify(p.observations)).not.toContain("syntheticSECRET");
  });
  it("takes over with an app-specific message when open_app cannot resolve", async () => {
    policy.evaluate = () => ({
      kind: "RETRY",
      reason: "No installed app matched. Candidates: Notes, Notion.",
    });
    const m = memory();
    const c = controller({
      surface: async (a) =>
        a?.type === "open_app"
          ? {
              ...surface,
              launcherStatus: "unresolved",
              launcherCandidates: ["Notes"],
            }
          : surface,
    });
    const p = scripted(
      Array.from({ length: 4 }, () => act({ type: "open_app", name: "Notez" })),
    );
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    const running = runner.start("test");
    await until(() => runner.snapshot.run?.status === "takeover");
    expect(runner.snapshot.message).toBe(
      "I couldn’t find that app. Open it yourself, then say continue.",
    );
    expect(m.of("ActionRetargetRequested")[0].data.launcherStatus).toBe(
      "unresolved",
    );
    expect(p.observations[2].history[0].action).toEqual({
      type: "open_app",
      name: "Notez",
    });
    runner.stop();
    await running;
  });
});

describe("runner recovery from native errors", () => {
  it("records a rejected native step and continues", async () => {
    allowAll();
    const m = memory();
    const c = controller({
      execute: vi
        .fn()
        .mockRejectedValueOnce(
          new NativeActionError(
            "LAUNCH_FAILED",
            "The application could not be opened.",
          ),
        ),
    });
    const p = scripted([act({ type: "open_app", name: "Notes" })]);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    await runner.start("test");
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(m.of("ActionFailed")[0].data).toEqual({ code: "LAUNCH_FAILED" });
    expect(p.observations[1].history[0]).toEqual({
      type: "open_app",
      action: { type: "open_app", name: "Notes" },
      result: "No input was sent. The application could not be opened.",
    });
    expect(runner.snapshot.run?.actions).toBe(0);
  });
  // Live 2026-09-18: six CMD+N refused because Calendar's focus moved, and the
  // trace said only STATE_CHANGED.
  it("records which kind of change refused a step and tells a shortcut to wait for focus", async () => {
    allowAll();
    const m = memory();
    const c = controller({
      execute: vi
        .fn()
        .mockRejectedValueOnce(
          new ScreenChangedError("The focused field changed.", "FOCUS_CHANGED"),
        ),
    });
    const p = scripted([act({ type: "hotkey", keys: ["CMD", "N"] })]);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    await runner.start("test");
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(m.of("ActionFailed").map((e) => e.data)).toEqual([
      { code: "STATE_CHANGED", change: "FOCUS_CHANGED" },
    ]);
    const rejected = p.observations[1].history[0];
    expect(rejected.type).toBe("rejected");
    expect(rejected.result).toBe(
      "No input was sent. The focused element changed between the screenshot and the input; choose an action from the new screenshot. Any earlier approval has expired. A shortcut goes to whichever element has focus: wait for the screen to settle and check where focus is in the new screenshot before pressing it again.",
    );
  });
  // Published chords are pressed through their menu items natively, so the
  // chords refused for focus are the ones kept as keys on purpose: a menu_item
  // hint would skip the focus check (and the paste rule) they rely on.
  it("never sends a shortcut refused for focus to its menu item", () => {
    for (const keys of [
      ["CMD", "V"],
      ["CMD", "Z"],
      ["CMD", "A"],
      ["CMD", "SHIFT", "Z"],
      ["CMD", "N"],
    ]) {
      const result = screenChangedResult("FOCUS_CHANGED", {
        type: "hotkey",
        keys,
        frame_id: "f",
      } as Action);
      expect(result).not.toMatch(/menu_item|context\.menus/);
      expect(result).toContain("wait for the screen to settle");
    }
  });
  it("names the change without the shortcut hint for other steps", async () => {
    allowAll();
    const m = memory();
    const c = controller({
      execute: vi
        .fn()
        .mockRejectedValueOnce(
          new ScreenChangedError(
            "The window's controls changed.",
            "CONTROLS_CHANGED",
          ),
        ),
    });
    const p = scripted([act({ type: "type_text", text: "hello" })]);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    await runner.start("test");
    expect(m.of("ActionFailed")[0].data).toEqual({
      code: "STATE_CHANGED",
      change: "CONTROLS_CHANGED",
    });
    const result = p.observations[1].history[0].result;
    expect(result).toContain(
      "The window's controls changed (something opened, closed or updated); choose an action",
    );
    expect(result).not.toContain("menu_item");
    // Without a code the step reads exactly as before.
    expect(screenChangedResult(undefined)).toBe(
      "No input was sent. The target or window changed; choose an action from the new screenshot. Any earlier approval has expired.",
    );
    expect(
      screenChangedResult("FOCUS_CHANGED", {
        type: "key",
        key: "ENTER",
        frame_id: "f",
      }),
    ).not.toContain("menu_item");
  });
  it("names another application coming forward while an approval was open", async () => {
    policy.evaluate = (a) =>
      a.type === "click"
        ? { kind: "CONFIRM", reason: "Send this message?" }
        : { kind: "ALLOW", reason: "" };
    const m = memory();
    const c = controller({
      revalidate: vi.fn(async (_a: Action, f: Frame) => ({
        ...f,
        id: "fresh",
        appId: "com.other.app",
      })),
    });
    const p = scripted([act({ type: "click", x: 0.5, y: 0.5 })]);
    let runner!: Runner;
    runner = new Runner(c, p, m.recorder, settings, (s: Snapshot) => {
      if (s.run?.status === "confirming" && s.pending)
        setTimeout(() => runner.confirm(true), 0);
    });
    await runner.start("test");
    expect(m.of("ActionFailed").map((e) => e.data)).toEqual([
      { code: "STATE_CHANGED", change: "APP_CHANGED" },
    ]);
    expect(p.observations[1].history[0].result).toContain(
      "Another application came to the front; choose an action",
    );
    expect(c.execute).not.toHaveBeenCalled();
  });
  it("records a hotkey pressed as its menu item and names that item", async () => {
    allowAll();
    const m = memory();
    const c = controller({
      surface: async (a?: Action) =>
        a?.type === "hotkey"
          ? { ...surface, shortcutLabel: "New Event" }
          : surface,
      execute: vi
        .fn()
        .mockResolvedValueOnce({ via: "menu" })
        .mockResolvedValueOnce({ via: "keys" })
        .mockResolvedValueOnce({ via: "menu" }),
    });
    const p = scripted([
      act({ type: "hotkey", keys: ["CMD", "N"] }),
      act({ type: "hotkey", keys: ["CMD", "T"] }),
      act({ type: "scroll", delta_x: 0, delta_y: 5 }),
    ]);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    await runner.start("test");
    const executed = m.of("ActionExecuted").map((e) => e.data.via);
    // Only a hotkey carries its route; anything else from the helper is ignored.
    expect(executed).toEqual(["menu", "keys", undefined]);
    const history = p.observations[3].history;
    expect(history[0].result).toBe(
      "Executed CMD+N as “New Event” in the menus. Verify the next screenshot shows the intended result before done.",
    );
    // Posted as keys: named as before.
    expect(history[1].result).toMatch(
      /^Executed\. Verify the next screenshot shows the intended result before done\./,
    );
  });
  // Review of the menu route: a menu command acts on whatever holds focus or
  // selection, so native must know a step was approved (to check it as strictly
  // as keys) and which item the user approved (to press no other).
  it("marks an approved hotkey and binds it to the item the user approved", async () => {
    policy.evaluate = (a) =>
      a.type === "hotkey" && a.keys.includes("BACKSPACE")
        ? {
            kind: "CONFIRM",
            reason: "This shortcut may send or delete content. Allow it?",
          }
        : { kind: "ALLOW", reason: "" };
    const m = memory();
    const execute = vi.fn(async () => ({ via: "menu" as const }));
    const c = controller({
      surface: async (a?: Action) =>
        a?.type === "hotkey"
          ? {
              ...surface,
              shortcutLabel: a.keys.includes("BACKSPACE")
                ? "Move to Trash"
                : "New Event",
            }
          : surface,
      revalidate: vi.fn(async (_a: Action, f: Frame) => ({
        ...f,
        id: "fresh",
      })),
      execute,
    });
    const p = scripted([
      act({ type: "hotkey", keys: ["CMD", "BACKSPACE"] }),
      act({ type: "hotkey", keys: ["CMD", "N"] }),
    ]);
    let runner!: Runner;
    runner = new Runner(c, p, m.recorder, settings, (s: Snapshot) => {
      if (s.run?.status === "confirming" && s.pending)
        setTimeout(() => runner.confirm(true), 0);
    });
    await runner.start("test");
    const sent = execute.mock.calls.map((call) => (call as unknown[])[0]);
    expect(sent[0]).toEqual({
      type: "hotkey",
      keys: ["CMD", "BACKSPACE"],
      frame_id: "fresh",
      approved: true,
      shortcutLabel: "Move to Trash",
    });
    // Allowed without asking: not approved, but still bound to the item policy
    // judged, so a menu that changed since cannot press another.
    expect(sent[1]).toMatchObject({
      type: "hotkey",
      keys: ["CMD", "N"],
      shortcutLabel: "New Event",
    });
    expect(sent[1]).not.toHaveProperty("approved");
    // The journal keeps the model's own step.
    expect(m.of("ActionExecuted")[0].data.action).toEqual({
      type: "hotkey",
      keys: ["CMD", "BACKSPACE"],
      frame_id: "fresh",
    });
  });
  it("sends native only what the decision and surface say", () => {
    const hotkey = {
      type: "hotkey",
      keys: ["CMD", "N"],
      frame_id: "f",
    } as Action;
    const confirm = { kind: "CONFIRM" as const, reason: "Delete it?" };
    expect(nativeAction(hotkey, confirm, surface)).toEqual({
      ...hotkey,
      approved: true,
    });
    const click = {
      type: "click",
      x: 1,
      y: 2,
      button: "left",
      frame_id: "f",
    } as Action;
    expect(
      nativeAction(click, confirm, { ...surface, shortcutLabel: "Delete" }),
    ).toEqual({ ...click, approved: true });
    const paste = {
      type: "hotkey",
      keys: ["CMD", "V"],
      frame_id: "f",
    } as Action;
    expect(
      nativeAction(paste, { kind: "ALLOW", reason: PASTE_ALLOWED }, surface),
    ).toEqual({ ...paste, paste: true });
    // Allowed: bound to the item policy judged, and never marked approved.
    expect(
      nativeAction(
        hotkey,
        { kind: "ALLOW", reason: "Routine." },
        {
          ...surface,
          shortcutLabel: "New Event",
        },
      ),
    ).toEqual({ ...hotkey, shortcutLabel: "New Event" });
    // Nothing judged and nothing approved: the step goes as the model sent it.
    expect(
      nativeAction(hotkey, { kind: "ALLOW", reason: "Routine." }, surface),
    ).toBe(hotkey);
    expect(
      nativeAction(
        click,
        { kind: "ALLOW", reason: "" },
        { ...surface, shortcutLabel: "New Event" },
      ),
    ).toBe(click);
    expect(screenChangedResult("MENU_CHANGED", hotkey)).toBe(
      "No input was sent. The application's menus no longer give this shortcut the command it was checked against; choose an action from the new screenshot. Any earlier approval has expired.",
    );
  });
  it("pauses when the native stop latch was set without a pause event", async () => {
    allowAll();
    const m = memory();
    const c = controller({
      execute: vi.fn().mockRejectedValue(new NativeStoppedError()),
    });
    const p = scripted([act({ type: "scroll", delta_x: 0, delta_y: 5 })]);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    const running = runner.start("test");
    await until(() => runner.snapshot.run?.status === "paused");
    expect(runner.snapshot.message).toBe(
      "Input was interrupted. Say continue when ready.",
    );
    runner.stop();
    await running;
  });
  it("keeps the takeover pause when its event arrives after the stop error", async () => {
    allowAll();
    const m = memory();
    let runner!: Runner;
    const c = controller({
      execute: vi.fn(async () => {
        setTimeout(() => runner.manualTakeover(), 100);
        throw new NativeStoppedError();
      }),
    });
    const p = scripted([act({ type: "scroll", delta_x: 0, delta_y: 5 })]);
    runner = new Runner(c, p, m.recorder, settings, () => {});
    const running = runner.start("test");
    await until(() => runner.snapshot.run?.status === "paused");
    await new Promise((r) => setTimeout(r, 600));
    expect(runner.snapshot.message).toContain("you’re controlling");
    expect(m.of("RunPaused")).toHaveLength(1);
    await runner.resume();
    await running;
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(m.of("ActionInterrupted")).toHaveLength(1);
    expect(p.observations[1].history).toContainEqual({
      type: "scroll",
      action: { type: "scroll", delta_x: 0, delta_y: 5 },
      result:
        "Interrupted by the user; it may or may not have taken effect. Check the next screenshot before repeating it.",
    });
  });
  it("records a possibly partial action when the stop error wins the race", async () => {
    allowAll();
    const m = memory();
    const c = controller({
      execute: vi.fn().mockRejectedValueOnce(new NativeStoppedError()),
    });
    const p = scripted([act({ type: "type_text", text: "hello world" })]);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    const running = runner.start("test");
    await until(() => runner.snapshot.run?.status === "paused");
    expect(runner.snapshot.message).toBe(
      "Input was interrupted. Say continue when ready.",
    );
    await runner.resume();
    await running;
    expect(runner.snapshot.run?.status).toBe("completed");
    const history = p.observations[1].history;
    expect(history).toHaveLength(1);
    expect(history[0].result).toContain("may or may not have taken effect");
    expect(runner.snapshot.run?.actions).toBe(0);
  });
  it("hands control to the user when the helper blocks a protected surface after approval", async () => {
    policy.evaluate = (a) =>
      a.type === "click"
        ? { kind: "CONFIRM", reason: "Send this message?" }
        : undefined!;
    const m = memory();
    const c = controller({
      revalidate: vi.fn(async () => {
        throw new SurfaceBlockedError(
          "Sensitive input is active. Capture is suspended until you resume.",
        );
      }),
    });
    const p = scripted([act({ type: "click", x: 0.5, y: 0.5 })]);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    const running = runner.start("test");
    await until(() => runner.snapshot.run?.status === "confirming");
    runner.confirm(true);
    await until(() => runner.snapshot.run?.status === "takeover");
    expect(runner.snapshot.message).toBe(
      "Sensitive input is active. Capture is suspended until you resume.",
    );
    expect(c.execute).not.toHaveBeenCalled();
    expect(m.of("RunFailed")).toHaveLength(0);
    runner.stop();
    await running;
    expect(runner.snapshot.run?.status).toBe("cancelled");
  });
  it("takes over instead of failing when native capture is blocked", async () => {
    const m = memory();
    let blocked = false;
    const base = controller();
    const c = controller({
      capture: async () => {
        if (!blocked) {
          blocked = true;
          throw new SurfaceBlockedError(
            "A protected application is active. Switch to a permitted application to resume.",
          );
        }
        return base.capture();
      },
    });
    const p = scripted([]);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    const running = runner.start("test");
    await until(() => runner.snapshot.run?.status === "takeover");
    expect(p.next).not.toHaveBeenCalled();
    await runner.resume();
    await running;
    expect(runner.snapshot.run?.status).toBe("completed");
  });
  it("pauses while the helper restarts and resumes on continue", async () => {
    const m = memory();
    let failed = false;
    const base = controller();
    const c = controller({
      capture: async () => {
        if (!failed) {
          failed = true;
          throw new HelperUnavailableError();
        }
        return base.capture();
      },
    });
    const p = scripted([]);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    const running = runner.start("test");
    await until(() => runner.snapshot.run?.status === "paused");
    expect(runner.snapshot.message).toBe(
      "Desktop control restarted. Say continue to resume.",
    );
    await runner.resume();
    await running;
    expect(runner.snapshot.run?.status).toBe("completed");
  });
  it("tells the model that an interrupted action may have happened", async () => {
    allowAll();
    const m = memory();
    let runner!: Runner;
    let executing = false;
    const c = controller({
      execute: vi.fn(
        (_a: Action, _f: Frame, signal: AbortSignal) =>
          new Promise<void>((_resolve, reject) => {
            executing = true;
            signal.addEventListener("abort", () =>
              reject(new NativeStoppedError()),
            );
          }),
      ),
    });
    const p = scripted([act({ type: "hotkey", keys: ["CMD", "N"] })]);
    runner = new Runner(c, p, m.recorder, settings, () => {});
    const running = runner.start("test");
    await until(() => executing);
    runner.manualTakeover();
    await tick();
    await runner.resume();
    await running;
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(m.of("ActionInterrupted")[0].data).toEqual({ actionType: "hotkey" });
    expect(p.observations[1].history.at(-1)).toEqual({
      type: "hotkey",
      action: { type: "hotkey", keys: ["CMD", "N"] },
      result:
        "Interrupted by the user; it may or may not have taken effect. Check the next screenshot before repeating it.",
    });
    expect(runner.snapshot.run?.actions).toBe(0);
  });
});

describe("runner pause, resume and budgets", () => {
  it("cannot resurrect a run stopped while resume is in flight", async () => {
    const m = memory();
    let release = () => {};
    const resume = vi.fn(async () => {});
    const c = controller({ resume });
    const p = scripted([]);
    p.next.mockImplementationOnce(hang);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    const running = runner.start("test");
    await until(() => runner.snapshot.run?.status === "thinking");
    runner.pause();
    resume.mockImplementationOnce(
      () => new Promise<void>((r) => (release = r)),
    );
    const resuming = runner.resume();
    runner.stop();
    release();
    // A texted "continue" reports this: it must not say the run went on.
    expect(await resuming).toBe(false);
    await running;
    expect(runner.snapshot.run?.status).toBe("cancelled");
    expect(m.of("UserTakeoverEnded")).toHaveLength(0);
  });
  it("keeps a pause that lands while resume is in flight", async () => {
    const m = memory();
    let release = () => {};
    const resume = vi.fn(async () => {});
    const stop = vi.fn();
    const c = controller({ resume, stop });
    const p = scripted([]);
    p.next.mockImplementationOnce(hang);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    const running = runner.start("test");
    await until(() => runner.snapshot.run?.status === "thinking");
    runner.pause();
    resume.mockImplementationOnce(
      () => new Promise<void>((r) => (release = r)),
    );
    const resuming = runner.resume();
    runner.manualTakeover();
    const stops = stop.mock.calls.length;
    release();
    expect(await resuming).toBe(false);
    expect(runner.snapshot.run?.status).toBe("paused");
    expect(stop.mock.calls.length).toBeGreaterThan(stops);
    runner.stop();
    await running;
  });
  it("excludes paused time from the runtime budget", async () => {
    const m = memory();
    const p = scripted([]);
    p.next.mockImplementationOnce(hang);
    const runner = new Runner(
      controller(),
      p,
      m.recorder,
      { ...settings, maxSeconds: 0.2 },
      () => {},
    );
    const running = runner.start("test");
    await until(() => runner.snapshot.run?.status === "thinking");
    runner.pause();
    await new Promise((r) => setTimeout(r, 350));
    expect(runner.snapshot.run?.status).toBe("paused");
    expect(await runner.resume()).toBe(true);
    // Nothing is held any more, so a second resume reports nothing resumed.
    expect(await runner.resume()).toBe(false);
    await running;
    expect(runner.snapshot.run?.status).toBe("completed");
  });
  it("still enforces the active runtime budget", async () => {
    const m = memory();
    const p = scripted([]);
    p.next.mockImplementation(hang);
    const runner = new Runner(
      controller(),
      p,
      m.recorder,
      { ...settings, maxSeconds: 0.1 },
      () => {},
    );
    await runner.start("test");
    expect(runner.snapshot.run?.status).toBe("cancelled");
    expect(runner.snapshot.message).toBe("Runtime budget reached.");
  });
  it("shows a capturing status after approval before revalidating", async () => {
    policy.evaluate = (a) =>
      a.type === "click"
        ? { kind: "CONFIRM", reason: "Send this message?" }
        : undefined!;
    const m = memory();
    const seen: { status?: string; message: string }[] = [];
    let runner!: Runner;
    const base = controller();
    const c = controller({
      revalidate: async () => {
        seen.push({
          status: runner.snapshot.run?.status,
          message: runner.snapshot.message,
        });
        return { ...(await base.capture()), id: "fresh" };
      },
    });
    const p = scripted([act({ type: "click", x: 0.5, y: 0.5 })]);
    runner = new Runner(c, p, m.recorder, settings, () => {});
    const running = runner.start("test");
    await until(() => runner.snapshot.run?.status === "confirming");
    runner.confirm(true);
    await running;
    expect(seen).toEqual([
      { status: "capturing", message: "Checking the screen before acting." },
    ]);
    expect(vi.mocked(c.execute).mock.calls[0][0].frame_id).toBe("fresh");
  });
  it("records a spoken decline in history before pausing", async () => {
    policy.evaluate = (a) =>
      a.type === "click"
        ? { kind: "CONFIRM", reason: "Send this message?" }
        : undefined!;
    const m = memory();
    const c = controller();
    const p = scripted([act({ type: "click", x: 0.25, y: 0.75 })]);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    const running = runner.start("test");
    await until(() => runner.snapshot.run?.status === "confirming");
    await runner.approveFromVoice(false);
    expect(runner.snapshot.run?.status).toBe("paused");
    await runner.resume();
    await running;
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(c.execute).not.toHaveBeenCalled();
    expect(p.observations[1].history.at(-1)).toEqual({
      type: "click",
      action: { type: "click", x: 0.25, y: 0.75 },
      result: declinedResult("Send this message?"),
    });
  });
  it("re-enables input for a pending approval without leaving confirmation", async () => {
    policy.evaluate = (a) =>
      a.type === "click"
        ? { kind: "CONFIRM", reason: "Send this message?" }
        : undefined!;
    const m = memory();
    const c = controller();
    const p = scripted([act({ type: "click", x: 0.5, y: 0.5 })]);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    const running = runner.start("test");
    await until(() => runner.snapshot.run?.status === "confirming");
    runner.manualTakeover();
    const resumes = vi.mocked(c.resume).mock.calls.length;
    await runner.resume();
    expect(vi.mocked(c.resume).mock.calls.length).toBe(resumes + 1);
    expect(runner.snapshot.run?.status).toBe("confirming");
    expect(runner.snapshot.pending).toBeDefined();
    await runner.approveFromVoice(true);
    await running;
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(vi.mocked(c.resume).mock.calls.length).toBe(resumes + 1);
    expect(c.execute).toHaveBeenCalledTimes(1);
  });
});

describe("runner refusals and live settings", () => {
  it("pauses immediately when the model declines a step", async () => {
    const m = memory();
    const p = scripted([
      () => ({
        action: undefined,
        refused: true,
        usage: { inputTokens: 7, outputTokens: 2, cost: 0.002 },
      }),
    ]);
    const runner = new Runner(controller(), p, m.recorder, settings, () => {});
    const running = runner.start("test");
    await until(() => runner.snapshot.run?.status === "paused");
    expect(runner.snapshot.message).toBe(
      "The model declined this step. Rephrase the request or take over.",
    );
    expect(p.next).toHaveBeenCalledTimes(1);
    expect(m.of("ActionFailed").map((e) => e.data)).toEqual([
      { code: "REFUSED" },
    ]);
    expect(runner.snapshot.run?.usage.cost).toBe(0.002);
    await runner.resume();
    await running;
    expect(runner.snapshot.run?.status).toBe("completed");
    // Not recorded as an invalid action.
    expect(p.observations[1].history).toEqual([]);
  });
  it("takes over on the next capture when an app becomes protected mid-run", async () => {
    allowAll();
    const m = memory();
    let runner!: Runner;
    const c = controller({
      execute: vi.fn(async () => {
        runner.updateSettings({
          ...settings,
          protectedApps: [...settings.protectedApps, "com.example.app"],
        });
      }),
    });
    const p = scripted([act({ type: "click", x: 0.5, y: 0.5 })]);
    runner = new Runner(c, p, m.recorder, settings, () => {});
    const running = runner.start("test");
    await until(() => runner.snapshot.run?.status === "takeover");
    expect(runner.snapshot.message).toContain("protected application");
    expect(p.next).toHaveBeenCalledTimes(1);
    runner.stop();
    await running;
  });
  it("stops the run when the action budget is lowered mid-run", async () => {
    allowAll();
    const m = memory();
    let runner!: Runner;
    const c = controller({
      execute: vi.fn(async () => {
        runner.updateSettings({ ...settings, maxActions: 1 });
      }),
    });
    const p = scripted([
      act({ type: "click", x: 0.5, y: 0.5 }),
      act({ type: "click", x: 0.2, y: 0.2 }),
    ]);
    runner = new Runner(c, p, m.recorder, settings, () => {});
    await runner.start("test");
    expect(runner.snapshot.message).toBe("Action budget reached.");
    expect(runner.snapshot.run?.status).not.toBe("completed");
    expect(c.execute).toHaveBeenCalledTimes(1);
  });
  it("reschedules the runtime timer when maxSeconds is lowered", async () => {
    const m = memory();
    const p = scripted([]);
    p.next.mockImplementation(hang);
    const runner = new Runner(controller(), p, m.recorder, settings, () => {});
    const running = runner.start("test");
    await until(() => runner.snapshot.run?.status === "thinking");
    runner.updateSettings({ ...settings, maxSeconds: 0.05 });
    await running;
    expect(runner.snapshot.run?.status).toBe("cancelled");
    expect(runner.snapshot.message).toBe("Runtime budget reached.");
  });
});

describe("runner repetition loops", () => {
  const warning =
    "Warning: you have repeated the same actions several times without finishing.";
  const a = act({ type: "click", x: 0.301, y: 0.5 });
  const b = act({ type: "click", x: 0.7, y: 0.5 });
  it("warns the model once after an alternating cycle of four actions", async () => {
    allowAll();
    const m = memory();
    const p = scripted([a, b, a, b]);
    const runner = new Runner(controller(), p, m.recorder, settings, () => {});
    await runner.start("test");
    expect(runner.snapshot.run?.status).toBe("completed");
    const history = p.observations[4].history;
    expect(history.map((h) => h.result.includes(warning))).toEqual([
      false,
      false,
      false,
      true,
    ]);
    expect(history[3].result).toMatch(
      /^Executed\. Verify the next screenshot\. Warning: .*context\.controls/,
    );
    expect(m.of("ActionLoopDetected").map((e) => e.data)).toEqual([
      { actionType: "click", period: 2 },
    ]);
  });
  it("pauses when the cycle continues after the warning and resets on continue", async () => {
    allowAll();
    const m = memory();
    const p = scripted([a, b, a, b, a, b, a, b, a]);
    const c = controller();
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    const running = runner.start("test");
    await until(() => runner.snapshot.run?.status === "paused");
    expect(runner.snapshot.message).toBe(
      "I seem to be stuck repeating the same steps. Say continue with a hint.",
    );
    expect(c.execute).toHaveBeenCalledTimes(8);
    await runner.resume();
    await running;
    expect(runner.snapshot.run?.status).toBe("completed");
    // The action after continue starts a new sequence without a warning.
    expect(p.observations[9].history.at(-1)!.result).toBe(
      "Executed. Verify the next screenshot.",
    );
    expect(m.of("ActionLoopDetected")).toHaveLength(1);
  });
  it("resets when the sequence breaks and ignores repeated scrolling", async () => {
    allowAll();
    const m = memory();
    const scroll = act({ type: "scroll", delta_x: 0, delta_y: 5 });
    const other = act({ type: "key", key: "ENTER" });
    const p = scripted([
      a,
      a,
      a,
      other,
      a,
      a,
      a,
      scroll,
      scroll,
      scroll,
      scroll,
    ]);
    const runner = new Runner(controller(), p, m.recorder, settings, () => {});
    await runner.start("test");
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(m.of("ActionLoopDetected")).toHaveLength(0);
    expect(JSON.stringify(p.observations.at(-1)!.history)).not.toContain(
      warning,
    );
  });
  it("asks the model to verify typed and keyed results before done", async () => {
    allowAll();
    const m = memory();
    const p = scripted([
      act({ type: "type_text", text: "12+7" }),
      act({ type: "key", key: "ENTER" }),
      act({ type: "hotkey", keys: ["CMD", "C"] }),
      act({ type: "click", x: 0.5, y: 0.5 }),
    ]);
    const runner = new Runner(controller(), p, m.recorder, settings, () => {});
    await runner.start("test");
    expect(p.observations[4].history.map((h) => h.result)).toEqual([
      "Executed. Verify the next screenshot shows the intended result before done.",
      "Executed. Verify the next screenshot shows the intended result before done.",
      "Executed. Verify the next screenshot shows the intended result before done.",
      "Executed. Verify the next screenshot.",
    ]);
  });
});

describe("runner open_app execution", () => {
  it.each([true, false])(
    "reports the launched application (frontmost=%s)",
    async (frontmost) => {
      allowAll();
      const m = memory();
      const messages: string[] = [];
      const c = controller({
        execute: vi.fn(async () => ({
          launched: {
            appId: "com.apple.Notes",
            name: "Notes",
            frontmost,
            wasRunning: false,
          },
        })),
      });
      const p = scripted([act({ type: "open_app", name: "Notes" })]);
      const runner = new Runner(c, p, m.recorder, settings, (s: Snapshot) =>
        messages.push(s.message),
      );
      await runner.start("Open Notes");
      expect(runner.snapshot.run?.status).toBe("completed");
      expect(messages).toContain("Opening Notes.");
      const executed = m.of("ActionExecuted")[0].data;
      expect(executed).toEqual({
        action: {
          type: "open_app",
          name: "Notes",
          frame_id: expect.any(String),
        },
        frame_id: expect.any(String),
        launched: { appId: "com.apple.Notes", frontmost, wasRunning: false },
      });
      expect(p.observations[1].history.at(-1)).toEqual({
        type: "open_app",
        action: { type: "open_app", name: "Notes" },
        result: frontmost
          ? "Opened Notes (com.apple.Notes); frontmost=true. Verify appId on the next screenshot; if no window is visible use the app's New shortcut."
          : "Launch requested for com.apple.Notes; not frontmost yet. Wait briefly before retrying.",
      });
      expect(runner.snapshot.run?.actions).toBe(1);
    },
  );
  it.each([
    [0, false, "Calendar is open but shows no window."],
    [1, true, "Opened Calendar (com.apple.iCal); frontmost=true."],
    // The helper's own restore claim wins over a count that has not caught up.
    [0, true, "Opened Calendar (com.apple.iCal); frontmost=true."],
    [2, false, "Opened Calendar (com.apple.iCal); frontmost=true."],
    [undefined, undefined, "Opened Calendar (com.apple.iCal); frontmost=true."],
  ])(
    "tells the model when the app it opened shows no window (windows=%s, restored=%s)",
    async (windows, restoredWindow, start) => {
      const { windowlessResult } = await import("../src/core/runner");
      allowAll();
      const m = memory();
      const c = controller({
        execute: vi.fn(async () => ({
          launched: {
            appId: "com.apple.iCal",
            name: "Calendar",
            frontmost: true,
            wasRunning: true,
            ...(windows !== undefined && { windows, restoredWindow }),
          },
        })),
      });
      const p = scripted([act({ type: "open_app", name: "Calendar" })]);
      const runner = new Runner(c, p, m.recorder, settings, () => {});
      await runner.start("Open Calendar");
      const result = p.observations[1].history.at(-1)!.result;
      expect(result.startsWith(start)).toBe(true);
      if (windows === 0 && !restoredWindow) {
        // Live: Calendar came up windowless and the model opened it again.
        expect(result).toBe(windowlessResult("Calendar"));
        expect(result).toBe(
          "Calendar is open but shows no window. Use its Window menu or File > New (its New shortcut) to show one; don't open it again.",
        );
      }
      // The journal carries the count and the flag, never more.
      expect(m.of("ActionExecuted")[0].data.launched).toEqual({
        appId: "com.apple.iCal",
        frontmost: true,
        wasRunning: true,
        ...(windows !== undefined && { windows, restoredWindow }),
      });
    },
  );
  // Live: Calendar came up windowless; policy lets open_app of a windowless
  // frontmost app through for one native restore, and every execution reset
  // the retry count, so repeats only met the loop tracker's eighth step.
  const windowlessCalendar: Surface = {
    ...surface,
    appId: "com.apple.iCal",
    appName: "Calendar",
    launcherStatus: "resolved",
    launcherAppId: "com.apple.iCal",
    launcherName: "Calendar",
    windowCount: 0,
  };
  // The real policy decides open_app; the other steps are allowed.
  const realOpenApp = () => {
    policy.evaluate = ((a: Action) =>
      a.type === "open_app"
        ? undefined
        : {
            kind: "ALLOW",
            reason: "Test.",
          }) as unknown as typeof policy.evaluate;
  };
  const opens = (execute: ReturnType<typeof vi.fn>) =>
    execute.mock.calls.filter(([a]) => (a as Action).type === "open_app")
      .length;
  it("refuses a second open_app of the app it just left windowless, until another step runs", async () => {
    const { windowlessRepeat } = await import("../src/core/runner");
    realOpenApp();
    const m = memory();
    const execute = vi.fn(async (a: Action) =>
      a.type === "open_app"
        ? {
            launched: {
              appId: "com.apple.iCal",
              name: "Calendar",
              frontmost: true,
              wasRunning: true,
              windows: 0,
              restoredWindow: false,
            },
          }
        : {},
    );
    const c = controller({ surface: async () => windowlessCalendar, execute });
    const open = act({ type: "open_app", name: "Calendar" });
    const p = scripted([open, open, act({ type: "key", key: "ENTER" }), open]);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    await runner.start("Open Calendar");
    expect(runner.snapshot.run?.status).toBe("completed");
    // The repeat is refused with no input; the step after another action is not.
    expect(p.observations[2].history.at(-1)).toEqual({
      type: "open_app",
      action: { type: "open_app", name: "Calendar" },
      result: windowlessRepeat("Calendar"),
    });
    expect(windowlessRepeat("Calendar")).toBe(
      "No input was sent. Calendar is open but shows no window, and opening it again will not show one. Use its Window menu or File > New.",
    );
    expect(opens(execute)).toBe(2);
    expect(m.of("ActionRetargetRequested")).toHaveLength(1);
  });
  it("hands over after four windowless repeats instead of looping", async () => {
    realOpenApp();
    const m = memory();
    const execute = vi.fn(async () => ({
      launched: {
        appId: "com.apple.iCal",
        name: "Calendar",
        frontmost: true,
        wasRunning: true,
        windows: 0,
        restoredWindow: false,
      },
    }));
    const c = controller({ surface: async () => windowlessCalendar, execute });
    const p = scripted(
      Array.from({ length: 5 }, () =>
        act({ type: "open_app", name: "Calendar" }),
      ),
    );
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    const running = runner.start("Open Calendar");
    await until(() => runner.snapshot.run?.status === "takeover");
    expect(runner.snapshot.message).toBe(TARGET_HANDOFF_MESSAGE);
    expect(opens(execute)).toBe(1);
    runner.stop();
    await running;
  });
  it.each([
    [
      "the window was restored",
      { windows: 1, restoredWindow: true },
      windowlessCalendar,
    ],
    // The helper's restore claim wins over a count that has not caught up.
    [
      "the helper restored a window it has not counted yet",
      { windows: 0, restoredWindow: true },
      windowlessCalendar,
    ],
    ["the count is unknown", {}, windowlessCalendar],
    [
      "another app is in front",
      { windows: 0, restoredWindow: false },
      { ...windowlessCalendar, appId: "com.apple.Notes" },
    ],
  ])("lets open_app run again when %s", async (_name, counts, frontSurface) => {
    realOpenApp();
    const m = memory();
    const execute = vi.fn(async () => ({
      launched: {
        appId: "com.apple.iCal",
        name: "Calendar",
        frontmost: true,
        wasRunning: true,
        ...counts,
      },
    }));
    const c = controller({
      surface: async () => frontSurface as Surface,
      execute,
    });
    const open = act({ type: "open_app", name: "Calendar" });
    const p = scripted([open, open]);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    await runner.start("Open Calendar");
    expect(opens(execute)).toBe(2);
    expect(m.of("ActionRetargetRequested")).toHaveLength(0);
  });
  it("keeps a policy refusal's own reason for a windowless repeat", async () => {
    // The first open_app is allowed and leaves Calendar windowless; policy
    // then refuses the second one, and that refusal is what the model reads.
    let opened = 0;
    policy.evaluate = (a) =>
      a.type === "open_app" && opened++ > 0
        ? { kind: "DENY", reason: "That application must be opened manually." }
        : { kind: "ALLOW", reason: "Test." };
    const m = memory();
    const execute = vi.fn(async () => ({
      launched: {
        appId: "com.apple.iCal",
        name: "Calendar",
        frontmost: true,
        wasRunning: true,
        windows: 0,
        restoredWindow: false,
      },
    }));
    const c = controller({ surface: async () => windowlessCalendar, execute });
    const open = act({ type: "open_app", name: "Calendar" });
    const p = scripted([open, open]);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    await runner.start("Open Calendar");
    expect(p.observations[2].history.at(-1)!.result).toBe(
      "No input was sent. That application must be opened manually.",
    );
    expect(m.of("UserDenied")).toHaveLength(1);
    expect(m.of("ActionRetargetRequested")).toHaveLength(0);
  });
});

describe("executed step memory", () => {
  it("names the verified control in history without field contents", async () => {
    const { executedTarget } = await import("../src/core/runner");
    const click = {
      type: "click",
      frame_id: "f",
      x: 0.1,
      y: 0.2,
      button: "left",
    } as const;
    const base = { appId: "a", pid: 1, secureInput: false, unknown: false };
    expect(
      executedTarget(click, {
        ...base,
        targetRole: "AXButton",
        targetLabel: "1",
      }),
    ).toBe(" click on button “1”");
    expect(
      executedTarget(click, {
        ...base,
        targetRole: "AXStaticText",
        targetText: "Weekly digest · Inbox",
      }),
    ).toBe(" click on static text “Weekly digest”");
    expect(executedTarget(click, { ...base, targetRole: "AXWebArea" })).toBe(
      " click on a web area",
    );
    expect(executedTarget(click, base)).toBe("");
    expect(
      executedTarget(click, {
        ...base,
        targetRole: "AXTextField",
        targetLabel: "4111 1111 1111 1111",
        targetText: "Card number",
      }),
    ).toBe(" click on text field “Card number”");
    expect(
      executedTarget(click, {
        ...base,
        targetRole: "AXTextArea",
        targetLabel: "private draft",
      }),
    ).toBe(" click on a text area");
    expect(
      executedTarget(
        { type: "type_text", frame_id: "f", text: "secret words" },
        { ...base, focusedLabel: "Search" },
      ),
    ).toBe(" typing into “Search”");
    expect(
      executedTarget(click, {
        ...base,
        targetRole: "AXButton",
        targetLabel: "token sk-fixtureSECRETabcdefgh123",
      }),
    ).not.toContain("fixtureSECRET");
  });
});

describe("application switching", () => {
  it("warns once when the model keeps switching between applications", async () => {
    const { appSwitchWarning } = await import("../src/core/runner");
    allowAll();
    const m = memory();
    const p = scripted([
      act({ type: "open_app", name: "Safari" }),
      act({ type: "click", x: 0.3, y: 0.3, button: "left" }),
      act({ type: "open_app", name: "Calculator" }),
      act({ type: "open_app", name: "Safari" }),
      act({ type: "click", x: 0.4, y: 0.4, button: "left" }),
      act({ type: "open_app", name: "Calculator" }),
      act({ type: "open_app", name: "Safari" }),
    ]);
    const c = controller({
      execute: vi.fn(async (action: { type: string; name?: string }) =>
        action.type === "open_app"
          ? {
              launched: {
                appId: `com.test.${action.name}`,
                name: action.name!,
                frontmost: true,
                wasRunning: true,
              },
            }
          : undefined,
      ) as Controller["execute"],
    });
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    await runner.start("switch");
    expect(runner.snapshot.run?.status).toBe("completed");
    const results = p.observations.at(-1)!.history.map((h) => h.result);
    expect(results.filter((r) => r.includes(appSwitchWarning))).toHaveLength(1);
    expect(results[5]).toContain(appSwitchWarning);
  });
});

/**
 * STOPPED_WHILE_PAUSED, the denials half (cycle 20260919-0226, five of twelve
 * runs): every question is declined, the model proposes a step of the same
 * kind again, and the third decline in a row pauses the run. The pause is
 * kept; what changes is what the model reads after a decline.
 */
describe("declined approvals", () => {
  const question = "Click “Zeta”?";
  const zeta = act({ type: "click_control", label: "Zeta" });
  const asks = () => {
    policy.evaluate = (a) =>
      a.type === "click_control"
        ? { kind: "CONFIRM", reason: question }
        : { kind: "ALLOW", reason: "Test." };
  };
  const declineEach = async (
    runner: Runner,
    m: ReturnType<typeof memory>,
    prompts: number,
  ) => {
    for (let asked = 1; asked <= prompts; asked++) {
      await until(() => m.of("PolicyConfirmationRequested").length === asked);
      runner.confirm(false);
    }
  };
  it("names the declined question and the honest finish, and still pauses on the third decline in a row", async () => {
    asks();
    const m = memory();
    const c = controller();
    const p = scripted([zeta, zeta, zeta]);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    const running = runner.start("test");
    await declineEach(runner, m, 3);
    await until(() => runner.snapshot.run?.status === "paused");
    expect(runner.snapshot.message).toBe(
      "You declined several actions. Say continue with a hint when ready.",
    );
    expect(c.execute).not.toHaveBeenCalled();
    expect(m.of("UserTakeoverStarted")).toHaveLength(0);
    // After the first decline the model reads which question was declined,
    // that the same kind of step asks again, and the two routes left; it is
    // never sent to request_user, which would hand the task off.
    const line = p.observations[1].history.at(-1)!;
    expect(line).toEqual({
      type: "click_control",
      action: { type: "click_control", label: "Zeta" },
      result: declinedResult(question),
    });
    expect(line.result).toContain(question);
    expect(line.result).toContain("Do not propose this step again");
    expect(line.result).toContain("fail and say what needed approval");
    expect(line.result).not.toContain("request_user");
    runner.stop();
    await running;
  });
  it("resets the count on an executed step between declines and never hands the task off", async () => {
    asks();
    const m = memory();
    const c = controller();
    const other = act({ type: "click", x: 0.5, y: 0.5 });
    const p = scripted([zeta, zeta, other, zeta, zeta]);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    const running = runner.start("test");
    await declineEach(runner, m, 4);
    await running;
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(m.of("UserDenied")).toHaveLength(4);
    expect(m.of("RunPaused")).toHaveLength(0);
    expect(m.of("UserTakeoverStarted")).toHaveLength(0);
    expect(c.execute).toHaveBeenCalledTimes(1);
  });
});

/**
 * STOPPED_WHILE_PAUSED, the loops half (six of the seven loop pauses in cycle
 * 20260919-0226): one open_app a step between the reading and the writing
 * application, because nothing carried the value the model had just read.
 */
describe("the model's note", () => {
  it("carries a value the model read into its next steps' history", async () => {
    allowAll();
    const m = memory();
    const p = scripted([
      act({ type: "open_app", name: "Zeta", note: "employees 142" }),
      act({ type: "click", x: 0.5, y: 0.5 }),
    ]);
    const runner = new Runner(controller(), p, m.recorder, settings, () => {});
    await runner.start("test");
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(p.observations[1].history[0].action).toMatchObject({
      type: "open_app",
      name: "Zeta",
      note: "employees 142",
    });
    expect(p.observations[2].history[0].action).toMatchObject({
      note: "employees 142",
    });
    expect(m.of("ActionFailed")).toHaveLength(0);
  });
  it("keeps the note on a step the user declined", async () => {
    policy.evaluate = (a) =>
      a.type === "click"
        ? { kind: "CONFIRM", reason: "Send this message?" }
        : undefined!;
    const m = memory();
    const c = controller();
    const p = scripted([
      act({ type: "click", x: 0.25, y: 0.75, note: "total 42" }),
    ]);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    const running = runner.start("test");
    await until(() => runner.snapshot.run?.status === "confirming");
    runner.confirm(false);
    await running;
    expect(c.execute).not.toHaveBeenCalled();
    expect(p.observations[1].history.at(-1)).toEqual({
      type: "click",
      action: { type: "click", x: 0.25, y: 0.75, note: "total 42" },
      result: declinedResult("Send this message?"),
    });
  });
  it("never hides a repeated cycle from the loop detector", async () => {
    allowAll();
    const m = memory();
    const c = controller();
    // The same two clicks over and over, each with a fresh note: still a loop.
    const p = scripted(
      Array.from({ length: 9 }, (_, i) =>
        act({
          type: "click",
          x: i % 2 ? 0.7 : 0.301,
          y: 0.5,
          note: `value ${i}`,
        }),
      ),
    );
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    const running = runner.start("test");
    await until(() => runner.snapshot.run?.status === "paused");
    expect(runner.snapshot.message).toBe(
      "I seem to be stuck repeating the same steps. Say continue with a hint.",
    );
    expect(c.execute).toHaveBeenCalledTimes(8);
    expect(m.of("ActionLoopDetected").map((e) => e.data)).toEqual([
      { actionType: "click", period: 2 },
    ]);
    runner.stop();
    await running;
  });
});

type Controls = NonNullable<ScreenContext["controls"]>;
/**
 * A screen whose one named button moves between captures, like an animating
 * page, and whose native input is refused the first time.
 */
function movingTarget(
  options: {
    controls?: (capture: number) => Controls;
    appId?: (capture: number) => string;
    /** Leading execute attempts that are refused with STATE_CHANGED. */
    rejects?: number;
    /** Overrides on the surface fetched for the action. */
    target?: Partial<Surface>;
    onCapture?: (capture: number) => void;
    revalidate?: boolean;
  } = {},
) {
  let captures = 0;
  let executes = 0;
  const target: Surface = {
    ...surface,
    targetRole: "AXButton",
    targetLabel: "Send",
    ...options.target,
  };
  const capture = vi.fn(async (): Promise<Frame> => {
    const n = ++captures;
    options.onCapture?.(n);
    return {
      id: `frame-${n}`,
      sha256: `sha-${n}`,
      image: "",
      geometry,
      capturedAt: 0,
      synthetic: false,
      appId: options.appId?.(n) ?? surface.appId,
      context: {
        appName: "App",
        windowTitle: "Window",
        controls: options.controls?.(n) ?? [
          { role: "AXButton", label: "Send", x: 0.5, y: n / 10, enabled: true },
        ],
      },
    };
  });
  return controller({
    surface: vi.fn(async (a?: Action) => (a ? target : surface)),
    capture,
    execute: vi.fn(async () => {
      if (++executes <= (options.rejects ?? 1)) throw new ScreenChangedError();
    }),
    ...(options.revalidate
      ? { revalidate: vi.fn(async (_a: Action, f: Frame) => f) }
      : {}),
  });
}
const executedActions = (c: Controller) =>
  vi.mocked(c.execute).mock.calls.map((call) => call[0]);

describe("automatic re-aim after a screen change", () => {
  it("re-aims a rejected click at the same control with no new model call", async () => {
    allowAll();
    const m = memory();
    const c = movingTarget();
    const p = scripted([act({ type: "click", x: 0.5, y: 0.1 })]);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    await runner.start("test");
    expect(runner.snapshot.run?.status).toBe("completed");
    // One model call for the click and one for done: the re-aim cost none.
    expect(p.next).toHaveBeenCalledTimes(2);
    expect(m.of("ActionReaimed")).toHaveLength(1);
    expect(m.of("ActionReaimed")[0].data).toEqual({ actionType: "click" });
    expect(m.of("ActionFailed")).toHaveLength(0);
    const executed = executedActions(c);
    expect(executed).toHaveLength(2);
    expect(executed[0]).toMatchObject({ x: 0.5, y: 0.1, frame_id: "frame-1" });
    // The same action at the control's new position, on the fresh frame.
    expect(executed[1]).toMatchObject({
      type: "click",
      x: 0.5,
      y: 0.2,
      frame_id: "frame-2",
    });
    expect(runner.snapshot.run?.actions).toBe(1);
    expect(runner.snapshot.run?.usage.cost).toBe(0);
    const history = p.observations[1].history;
    expect(history).toHaveLength(1);
    expect(history[0].type).toBe("click");
    expect(history[0].result).toContain(
      "re-aimed at the same control (same role and name)",
    );
    // Every other field of the model's own action is preserved as it was.
    expect(history[0].action).toEqual({
      type: "click",
      x: 0.5,
      y: 0.2,
      button: "left",
    });
  });
  it.each([
    ["the control is gone", { controls: () => [] as Controls }],
    [
      "two controls match",
      {
        controls: (n: number) =>
          n === 1
            ? [{ role: "AXButton", label: "Send", x: 0.5, y: 0.1 }]
            : [
                { role: "AXButton", label: "Send", x: 0.5, y: 0.2 },
                { role: "AXButton", label: "Send", x: 0.5, y: 0.6 },
              ],
      },
    ],
    [
      "the only match is disabled",
      {
        controls: (n: number) => [
          {
            role: "AXButton",
            label: "Send",
            x: 0.5,
            y: n / 10,
            enabled: n === 1,
          },
        ],
      },
    ],
    [
      "the fresh frame is another application",
      { appId: (n: number) => (n === 1 ? surface.appId : "com.other.app") },
    ],
    [
      "the target was never identified",
      { target: { targetRole: undefined, targetLabel: undefined } },
    ],
    [
      "the re-aim capture fails",
      {
        onCapture: (n: number) => {
          if (n === 2) throw new HelperUnavailableError();
        },
      },
    ],
  ])("asks the model again when %s", async (_why, options) => {
    allowAll();
    const m = memory();
    const c = movingTarget(options as Parameters<typeof movingTarget>[0]);
    const p = scripted([act({ type: "click", x: 0.5, y: 0.1 })]);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    await runner.start("test");
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(m.of("ActionReaimed")).toHaveLength(0);
    expect(m.of("ActionFailed")[0].data).toEqual({ code: "STATE_CHANGED" });
    const rejected = p.observations[1].history[0];
    expect(rejected.type).toBe("rejected");
    expect(rejected.result).toContain("No input was sent");
    expect(executedActions(c)).toHaveLength(1);
  });
  it.each(["drag", "type_text"])("never re-aims a %s action", async (type) => {
    allowAll();
    const m = memory();
    const c = movingTarget();
    const p = scripted([
      act(
        type === "drag"
          ? {
              type,
              start_x: 0.2,
              start_y: 0.2,
              end_x: 0.6,
              end_y: 0.6,
              duration_ms: 300,
            }
          : { type, text: "hello" },
      ),
    ]);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    await runner.start("test");
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(m.of("ActionReaimed")).toHaveLength(0);
    expect(m.of("ActionFailed")[0].data).toEqual({ code: "STATE_CHANGED" });
  });
  it("re-aims at most once per proposed action", async () => {
    allowAll();
    const m = memory();
    const c = movingTarget({ rejects: 2 });
    const p = scripted([
      act({ type: "click", x: 0.5, y: 0.1 }),
      act({ type: "click", x: 0.5, y: 0.3 }),
    ]);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    await runner.start("test");
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(m.of("ActionReaimed")).toHaveLength(1);
    expect(m.of("ActionFailed")).toHaveLength(1);
    expect(p.next).toHaveBeenCalledTimes(3);
    // The second attempt is the model's again, and its history is honest.
    expect(p.observations[1].history[0].type).toBe("rejected");
    expect(p.observations[2].history.at(-1)!.result).not.toContain("re-aimed");
  });
  it("asks for approval again instead of reusing it when the screen moves", async () => {
    policy.evaluate = (a) =>
      a.type === "click"
        ? { kind: "CONFIRM", reason: "Send this message?" }
        : { kind: "ALLOW", reason: "" };
    const m = memory();
    const c = movingTarget({ revalidate: true });
    const p = scripted([
      act({ type: "click", x: 0.5, y: 0.1 }),
      act({ type: "click", x: 0.5, y: 0.3 }),
    ]);
    let runner!: Runner;
    runner = new Runner(c, p, m.recorder, settings, (s: Snapshot) => {
      if (s.run?.status === "confirming" && s.pending)
        setTimeout(() => runner.confirm(true), 0);
    });
    await runner.start("test");
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(m.of("ActionReaimed")).toHaveLength(0);
    // Consent is asked for the second attempt, never carried over.
    expect(m.of("PolicyConfirmationRequested")).toHaveLength(2);
    expect(p.observations[1].history[0].result).toContain(
      "Any earlier approval has expired",
    );
  });
  it("never re-aims a replayed plan step", async () => {
    allowAll();
    const m = memory();
    const c = movingTarget();
    const p = scripted([]);
    // Replay resolves its own label on every frame, so it keeps today's
    // behavior: the plan is abandoned and the model takes over.
    const access: MemoryAccess = {
      recall: async () => ({
        context: { preferences: [], episodes: [] },
        plan: {
          id: "plan-1",
          source: "skill",
          mode: "replay",
          steps: [
            {
              action: { type: "click" },
              target: { role: "AXButton", label: "Send" },
            },
          ],
          outline: ["Click Send"],
        },
      }),
      learn: () => {},
    };
    const runner = new Runner(c, p, m.recorder, settings, () => {}, [], access);
    await runner.start("test");
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(m.of("PlanStepProposed")).toHaveLength(1);
    expect(m.of("ActionReaimed")).toHaveLength(0);
    expect(m.of("PlanAbandoned")[0].data).toEqual({
      index: 0,
      reason: "state_changed",
    });
    expect(m.of("ActionFailed")[0].data).toEqual({ code: "STATE_CHANGED" });
  });
  it("drops the re-aim when the user pauses while it captures", async () => {
    allowAll();
    const m = memory();
    let runner!: Runner;
    const c = movingTarget({
      onCapture: (n) => {
        if (n === 2) runner.pause();
      },
    });
    const p = scripted([act({ type: "click", x: 0.5, y: 0.1 })]);
    runner = new Runner(c, p, m.recorder, settings, () => {});
    const running = runner.start("test");
    await until(() => runner.snapshot.run?.status === "paused");
    expect(m.of("ActionReaimed")).toHaveLength(0);
    expect(executedActions(c)).toHaveLength(1);
    await runner.resume();
    await running;
    expect(runner.snapshot.run?.status).toBe("completed");
  });
});

describe("taking the application's own search route", () => {
  const type = {
    type: "type_text",
    frame_id: "f",
    text: "after hours",
  } as const;
  const surface = {
    appId: "com.spotify.client",
    pid: 1,
    secureInput: false,
    unknown: false,
  };
  it("opens the app's search when typing is refused with nothing focused", () => {
    expect(
      searchRoute(type, { ...surface, searchCommand: ["Edit", "Search"] }),
    ).toEqual(["Edit", "Search"]);
  });
  it("does nothing once a search is open, or without a published route", () => {
    expect(
      searchRoute(type, {
        ...surface,
        searchOpenedBy: "Search",
        searchCommand: ["Edit", "Search"],
      }),
    ).toBeUndefined();
    expect(searchRoute(type, surface)).toBeUndefined();
    expect(
      searchRoute(type, {
        ...surface,
        unknown: true,
        searchCommand: ["Edit", "Search"],
      }),
    ).toBeUndefined();
    expect(
      searchRoute(
        { type: "key", frame_id: "f", key: "ENTER" },
        { ...surface, searchCommand: ["Edit", "Search"] },
      ),
    ).toBeUndefined();
    expect(
      searchRoute(type, { ...surface, searchCommand: ["Search"] }),
    ).toBeUndefined();
  });
});

// Live: "anything on my calendar tomorrow" clicked "Saturday, September 19"
// thirty times at jittered positions until the action budget ran out; the
// coordinate-based signature never repeated, so the loop was never seen.
describe("loop detection by the control an action hits", () => {
  const click = (x: number) =>
    ({ type: "click", frame_id: "f", x, y: 0.434, button: "left" }) as const;
  const day = { role: "AXList", label: "Saturday, September 19" };
  it("sees jittered clicks on one identified control as one action", () => {
    const signatures = [0.961, 0.989, 0.994, 0.961].map((x) =>
      actionSignature(click(x), day),
    );
    expect(new Set(signatures).size).toBe(1);
    expect(repetitionPeriod(signatures)).toBe(1);
  });
  it("keeps different controls and unidentified targets apart", () => {
    expect(actionSignature(click(0.5), day)).not.toBe(
      actionSignature(click(0.5), { role: "AXButton", label: "Today" }),
    );
    expect(actionSignature(click(0.1), {})).not.toBe(
      actionSignature(click(0.9), {}),
    );
  });
  it("counts named targets and menu paths it used to ignore", () => {
    const named = (label: string) =>
      ({ type: "click_control", frame_id: "f", label }) as const;
    expect(actionSignature(named("Search"))).not.toBe(
      actionSignature(named("Play")),
    );
    const menu = (path: string[]) =>
      ({ type: "menu_item", frame_id: "f", path }) as const;
    expect(actionSignature(menu(["Edit", "Search"]))).not.toBe(
      actionSignature(menu(["Playback", "Play"])),
    );
    const same = Array.from({ length: 4 }, () =>
      actionSignature(menu(["Edit", "Search"])),
    );
    expect(repetitionPeriod(same)).toBe(1);
  });
});

// Cycle 20260919-0226, seven runs, none of which asked the user: three refused
// targets in a row (a path not in the local index, a chord with nothing
// verifiable in focus, a double-click on nothing) handed the task to a user
// who was not there, saying "click it for me" about a file no click could
// produce. The third refusal now asks the model to conclude; only a refused
// target after that hands over.
describe("the model's last word before a targeting hand-off", () => {
  const unidentified =
    "No input was sent. This target could not be identified.";
  const refuseAims = () => {
    policy.evaluate = (a) =>
      a.type === "double_click"
        ? { kind: "RETRY", reason: unidentified }
        : { kind: "ALLOW", reason: "Test." };
  };
  const aim = act({ type: "double_click", x: 0.5, y: 0.5 });
  const lastWord = (o: Observation) =>
    o.history.map((h) => h.result.endsWith(refusedTargetsWarning));
  it("asks the model to conclude at the third refused target, and its fail ends the run instead of a hand-off", async () => {
    refuseAims();
    const m = memory();
    const c = controller();
    const p = scripted([
      aim,
      aim,
      aim,
      act({ type: "fail", reason: "The file is not there." }),
    ]);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    await runner.start("test");
    expect(runner.snapshot.run?.status).toBe("failed");
    expect(runner.snapshot.message).toBe("The file is not there.");
    expect(m.of("UserTakeoverStarted")).toHaveLength(0);
    expect(m.of("ActionRetargetRequested")).toHaveLength(3);
    expect(c.execute).not.toHaveBeenCalled();
    // The first two refusals carry their reason alone; the third adds the
    // last word, which the fourth reply answered.
    expect(p.observations[3].history.map((h) => h.result)).toEqual([
      unidentified,
      unidentified,
      unidentified + refusedTargetsWarning,
    ]);
    expect(
      m.of("ActionProposed").map((e) => (e.data.action as Action).type),
    ).toEqual(["fail"]);
  });
  it("hands over when the last word is answered with a fourth refused target, and never pauses instead", async () => {
    refuseAims();
    const m = memory();
    const c = controller();
    const p = scripted(Array.from({ length: 4 }, () => aim));
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    const running = runner.start("test");
    await until(() => runner.snapshot.run?.status === "takeover");
    expect(runner.snapshot.message).toBe(TARGET_HANDOFF_MESSAGE);
    expect(m.of("UserTakeoverStarted").map((e) => e.data)).toEqual([
      { source: "handoff" },
    ]);
    expect(m.of("RunPaused")).toHaveLength(0);
    expect(m.of("ActionRetargetRequested")).toHaveLength(4);
    expect(c.execute).not.toHaveBeenCalled();
    expect(lastWord(p.observations[3])).toEqual([false, false, true]);
    runner.stop();
    await running;
    expect(runner.snapshot.run?.status).toBe("cancelled");
  });
  it("relaxes nothing: a route taken after the last word goes through policy, an aim after it is still refused, and only an executed step ends the streak", async () => {
    refuseAims();
    const m = memory();
    const c = controller();
    const p = scripted([
      aim,
      aim,
      aim,
      act({ type: "menu_item", path: ["File", "Open"] }),
      aim,
      aim,
      aim,
      act({ type: "fail", reason: "Not there." }),
    ]);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    await runner.start("test");
    expect(runner.snapshot.run?.status).toBe("failed");
    expect(c.execute).toHaveBeenCalledTimes(1);
    expect(vi.mocked(c.execute).mock.calls[0][0]).toMatchObject({
      type: "menu_item",
    });
    expect(m.of("UserTakeoverStarted")).toHaveLength(0);
    expect(m.of("RunPaused")).toHaveLength(0);
    expect(m.of("ActionRetargetRequested")).toHaveLength(6);
    // The executed route ended the streak: the next three refusals earned a
    // second last word, not a hand-off.
    expect(lastWord(p.observations[7])).toEqual([
      false,
      false,
      true,
      false,
      false,
      false,
      true,
    ]);
  });
});
