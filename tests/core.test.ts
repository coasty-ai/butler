import { describe, it, expect, vi } from "vitest";
import {
  defaultSettings,
  validateAction,
  sameGeometry,
  mapPoint,
  actionSchema,
  type Frame,
  type Run,
  type JournalEvent,
  type Recorder,
  type Snapshot,
  type Controller,
} from "../src/core/schema";
import { evaluate, surfacePolicy } from "../src/core/policy";
import { telemetrySchema, validateProviderEndpoint } from "../src/core/privacy";
import { sanitizeText, scanText } from "../src/core/sanitize";
import { Runner } from "../src/core/runner";
import { ScreenChangedError } from "../src/core/errors";
import { TutorialController, TutorialProvider } from "../src/core/tutorial";
import { nullRecorder } from "../src/core/recorder";
const g = {
  display_id: 2,
  x: -1920,
  y: 100,
  width: 1920,
  height: 1080,
  native_width: 3840,
  native_height: 2160,
  model_width: 1280,
  model_height: 720,
  scale_factor: 2,
};
const frame: Frame = {
  id: "frame-1",
  sha256: "abc",
  image: "",
  geometry: g,
  capturedAt: 0,
  synthetic: false,
};
const surface = { appId: "test", pid: 42, secureInput: false, unknown: false };
const settings = structuredClone(defaultSettings);
describe("action boundary", () => {
  it("applies the same policy to single-key hotkeys and keys", () => {
    for (const key of ["ESC", "ENTER"] as const) {
      const action = validateAction(
        { type: "hotkey", keys: [key], frame_id: frame.id },
        frame,
      );
      expect(action).toEqual({ type: "key", key, frame_id: frame.id });
      expect(evaluate(action, surface, settings, false).kind).toBe(
        key === "ESC" ? "ALLOW" : "CONFIRM",
      );
    }
  });
  it.each([
    { type: "shell", command: "ls" },
    { type: "click", x: 1.01, y: 0 },
    { type: "click", x: NaN, y: 0 },
    { type: "key", key: "UNSUPPORTED" },
    { type: "type_text", text: "x".repeat(2001) },
    { type: "click", x: 0, y: 0, script: "malicious" },
    { type: "hotkey", keys: ["CMD", "A", "B", "C", "D"] },
  ])("rejects invalid input %j", (a) =>
    expect(() => validateAction({ ...a, frame_id: frame.id }, frame)).toThrow(),
  );
  it("carries a short note on any action, through the single-key rewrite, and refuses a long one", () => {
    const note = "employees 142";
    expect(
      validateAction(
        { type: "open_app", name: "Notes", note, frame_id: frame.id },
        frame,
      ),
    ).toMatchObject({ type: "open_app", note });
    expect(
      validateAction(
        { type: "hotkey", keys: ["ENTER"], note, frame_id: frame.id },
        frame,
      ),
    ).toEqual({ type: "key", key: "ENTER", frame_id: frame.id, note });
    expect(() =>
      validateAction(
        { type: "capture", note: "x".repeat(201), frame_id: frame.id },
        frame,
      ),
    ).toThrow();
  });
  it("rejects stale frames and batches", () => {
    expect(() =>
      validateAction({ type: "capture", frame_id: "old" }, frame),
    ).toThrow("STALE_FRAME");
    expect(() =>
      validateAction([{ type: "capture", frame_id: frame.id }], frame),
    ).toThrow();
  });
  it("accepts the complete small vocabulary", () => {
    for (const a of [
      { type: "capture" },
      { type: "click", x: 0, y: 1 },
      { type: "double_click", x: 0.5, y: 0.5 },
      { type: "right_click", x: 0.2, y: 0.3 },
      { type: "move", x: 1, y: 1 },
      {
        type: "drag",
        start_x: 0,
        start_y: 0,
        end_x: 1,
        end_y: 1,
        duration_ms: 200,
      },
      { type: "scroll", delta_x: 0, delta_y: 100 },
      { type: "type_text", text: "hello" },
      { type: "key", key: "ENTER" },
      { type: "hotkey", keys: ["CMD", "A"] },
      { type: "wait", milliseconds: 10 },
      { type: "request_user", reason: "Login" },
      { type: "done", summary: "Done" },
      { type: "fail", reason: "Unavailable" },
      { type: "open_app", name: "Notes" },
      { type: "open_file", path: "~/Documents/Q3.xlsx" },
    ])
      expect(actionSchema.safeParse({ ...a, frame_id: frame.id }).success).toBe(
        true,
      );
  });
  it("maps Retina, negative monitor origins and inclusive edges", () => {
    expect(mapPoint(g, 0.5, 0.5)).toEqual({ x: -960, y: 640 });
    expect(mapPoint(g, 1, 1)).toEqual({ x: -1, y: 1179 });
    expect(() => mapPoint(g, Infinity, 0)).toThrow();
  });
});
describe("hard policy", () => {
  it("navigates a verified browser address bar without approving ordinary form Enter", () => {
    const action = {
      type: "key" as const,
      key: "ENTER" as const,
      frame_id: frame.id,
    };
    const address = {
      ...surface,
      appId: "com.google.Chrome",
      focusedRole: "AXTextField",
      addressBar: true,
      focusedValue: "https://www.youtube.com/results?search_query=The+Weeknd",
    };
    expect(evaluate(action, address, settings, false).kind).toBe("ALLOW");
    for (const s of [
      { ...address, addressBar: false },
      { ...address, appId: "com.tinyspeck.slackmacgap" },
      { ...address, unknown: true },
      { ...address, focusedValue: "" },
    ])
      expect(evaluate(action, s, settings, false).kind).toBe("CONFIRM");
    for (const focusedValue of [
      "javascript:alert(1)",
      "data:text/html,test",
      "file:///tmp/task.sh",
    ])
      expect(
        evaluate(action, { ...address, focusedValue }, settings, false).kind,
      ).toBe("DENY");
  });
  it("allows verified video navigation and playback while keeping purchases gated", () => {
    const action = {
      type: "click" as const,
      button: "left" as const,
      frame_id: frame.id,
      x: 0.5,
      y: 0.5,
    };
    expect(
      evaluate(
        action,
        {
          ...surface,
          targetRole: "AXLink",
          targetURL: "https://www.youtube.com/watch?v=test",
        },
        settings,
        false,
      ).kind,
    ).toBe("ALLOW");
    // Any ordinary web link is routine navigation; executable and local-file
    // schemes are denied and protected sites still need approval.
    for (const [targetURL, kind] of [
      ["https://www.youtube.com.evil.test/watch?v=test", "ALLOW"],
      ["javascript:alert(1)", "DENY"],
      ["file:///tmp/task.command", "DENY"],
      ["https://www.paypal.com/myaccount", "CONFIRM"],
    ])
      expect(
        evaluate(
          action,
          { ...surface, targetRole: "AXLink", targetURL },
          settings,
          false,
        ).kind,
      ).toBe(kind);
    expect(
      evaluate(
        action,
        { ...surface, targetRole: "AXButton", targetLabel: "Play (k)" },
        settings,
        false,
      ).kind,
    ).toBe("ALLOW");
    expect(
      evaluate(
        action,
        { ...surface, targetRole: "AXButton", targetLabel: "Buy" },
        settings,
        false,
      ).kind,
    ).toBe("CONFIRM");
  });
  it.each([
    {
      launcher: {
        query: "Chrome",
        selectedResult: "Chrome Remote Desktop Host Uninstaller",
      },
      kind: "DENY",
    },
    {
      launcher: { query: "Notes", selectedResult: "Notes Installer" },
      kind: "DENY",
    },
    {
      launcher: { query: "Chrome", selectedResult: "Google Chrome" },
      kind: "ALLOW",
    },
    {
      launcher: {
        query: "Chrome",
        selectedResult: "Chrome Remote Desktop Host",
      },
      kind: "RETRY",
    },
    { launcher: { query: "Chrome" }, kind: "RETRY" },
    { launcher: { query: "", selectedResult: "Google Chrome" }, kind: "RETRY" },
  ])("verifies the Spotlight launch selection: %j", ({ launcher, kind }) => {
    const decision = evaluate(
      { type: "key", key: "ENTER", frame_id: frame.id },
      {
        ...surface,
        appId: "com.apple.Spotlight",
        focusedRole: "AXTextField",
        launcher,
      },
      settings,
      false,
    );
    expect(decision.kind).toBe(kind);
    if (kind === "RETRY") expect(decision.reason).toContain("open_app");
  });
  it("allows the full matching app name and stops an unexpected uninstaller", () => {
    expect(
      evaluate(
        { type: "key", key: "ENTER", frame_id: frame.id },
        {
          ...surface,
          appId: "com.apple.Spotlight",
          focusedRole: "AXTextField",
          launcher: { query: "Google Chrome", selectedResult: "Google Chrome" },
        },
        settings,
        false,
      ).kind,
    ).toBe("ALLOW");
    const uninstaller = {
      ...surface,
      appId: "com.google.chromeremotedesktop.me2me-host-uninstaller",
    };
    expect(surfacePolicy(uninstaller, settings).kind).toBe("USER_TAKEOVER");
    expect(
      evaluate(
        { type: "click", frame_id: frame.id, x: 0.64, y: 0.34, button: "left" },
        uninstaller,
        settings,
        false,
      ).kind,
    ).toBe("USER_TAKEOVER");
    expect(
      evaluate(
        { type: "click", frame_id: frame.id, x: 0.64, y: 0.34, button: "left" },
        { ...surface, targetLabel: "Uninstall" },
        settings,
        false,
      ).kind,
    ).toBe("DENY");
  });
  it("takes over before capture on protected apps, sites and secure inputs", () => {
    for (const s of [
      { ...surface, appId: "com.1password.1password" },
      { ...surface, secureInput: true },
      { ...surface, domain: "secure.paypal.com" },
    ])
      expect(surfacePolicy(s, settings).kind).toBe("USER_TAKEOVER");
  });
  it("retries unidentified input and confirms potentially destructive keys", () => {
    for (const a of [
      { type: "click", x: 0.5, y: 0.5 },
      { type: "key", key: "ENTER" },
      { type: "type_text", text: "Send now" },
      { type: "hotkey", keys: ["CMD", "BACKSPACE"] },
    ])
      expect(
        evaluate(
          actionSchema.parse({ ...a, frame_id: frame.id }),
          surface,
          settings,
          false,
        ).kind,
      ).toBe(["key", "hotkey"].includes(a.type) ? "CONFIRM" : "RETRY");
  });
  it("redirects verified Dock launches to open_app without allowing documents, Trash or lookalikes", () => {
    const click = {
      type: "click" as const,
      button: "left" as const,
      frame_id: frame.id,
      x: 0.5,
      y: 0.9,
    };
    const dock = {
      ...surface,
      targetAppId: "com.apple.dock",
      targetRole: "AXDockItem",
      targetSubrole: "AXApplicationDockItem",
      launcherAppId: "com.apple.Notes",
      targetLabel: "Notes",
    };
    const redirected = evaluate(click, dock, settings, false);
    expect(redirected.kind).toBe("RETRY");
    expect(redirected.reason).toContain("open_app");
    for (const changed of [
      { targetAppId: "com.fake.dock" },
      { targetSubrole: "AXTrashDockItem" },
      { targetSubrole: "AXDocumentDockItem" },
      { launcherAppId: undefined },
      { unknown: true },
    ])
      expect(
        evaluate(click, { ...dock, ...changed }, settings, false).kind,
      ).toBe("RETRY");
    expect(
      evaluate(
        click,
        { ...dock, launcherAppId: "com.apple.Terminal" },
        settings,
        false,
      ).kind,
    ).toBe("USER_TAKEOVER");
    expect(
      evaluate(
        click,
        {
          ...dock,
          launcherAppId: "com.example.installer",
          targetLabel: "Installer",
        },
        settings,
        false,
      ).kind,
    ).toBe("DENY");
    expect(
      evaluate(click, { ...dock, targetEnabled: false }, settings, false).kind,
    ).toBe("RETRY");
    expect(
      evaluate({ ...click, button: "right" }, dock, settings, false).kind,
    ).toBe("RETRY");
  });
  it("writes multiline Notes drafts without approving, while keeping message sending gated", () => {
    const note = {
      ...surface,
      appId: "com.apple.Notes",
      focusedRole: "AXTextArea",
    };
    for (const action of [
      { type: "hotkey", keys: ["CMD", "N"] },
      { type: "type_text", text: "Test note\nSecond line" },
      { type: "key", key: "ENTER" },
    ]) {
      const a = actionSchema.parse({ ...action, frame_id: frame.id });
      expect(evaluate(a, note, settings, false).kind).toBe("ALLOW");
      // CMD+N is a routine shortcut in every application.
      if (a.type !== "hotkey")
        expect(
          evaluate(
            a,
            { ...note, appId: "com.tinyspeck.slackmacgap" },
            settings,
            false,
          ).kind,
        ).not.toBe("ALLOW");
      expect(
        evaluate(a, { ...note, secureInput: true }, settings, false).kind,
      ).toBe("USER_TAKEOVER");
    }
    const click = {
      type: "click" as const,
      button: "left" as const,
      frame_id: frame.id,
      x: 0.5,
      y: 0.5,
    };
    expect(
      evaluate(
        click,
        {
          ...note,
          targetAppId: "com.apple.Notes",
          targetRole: "AXButton",
          targetLabel: "Create a new note",
        },
        settings,
        false,
      ).kind,
    ).toBe("ALLOW");
    for (const label of ["New Note", "Create a note"])
      expect(
        evaluate(
          click,
          { ...note, targetRole: "AXButton", targetLabel: label },
          settings,
          false,
        ).kind,
      ).toBe("ALLOW");
    for (const label of ["Send", "Delete", "Share", "Buy", "Change password"])
      expect(
        evaluate(
          click,
          { ...note, targetRole: "AXButton", targetLabel: label },
          settings,
          false,
        ).kind,
      ).toBe("CONFIRM");
  });
  it("distinguishes focusing a field from activating its consequential button", () => {
    const click = {
      type: "click" as const,
      button: "left" as const,
      frame_id: frame.id,
      x: 0.5,
      y: 0.5,
    };
    const field = {
      ...surface,
      targetRole: "AXTextArea",
      targetLabel: "Send a message",
    };
    expect(evaluate(click, field, settings, false).kind).toBe("ALLOW");
    expect(
      evaluate(click, { ...field, targetRole: "AXButton" }, settings, false)
        .kind,
    ).toBe("CONFIRM");
    expect(
      evaluate(
        click,
        { ...field, targetAppId: "com.apple.Terminal" },
        settings,
        false,
      ).kind,
    ).toBe("USER_TAKEOVER");
    expect(
      evaluate(click, { ...field, secureInput: true }, settings, false).kind,
    ).toBe("USER_TAKEOVER");
  });
  it("blocks credentials and clipboard even on a trusted surface", () => {
    expect(
      evaluate(
        {
          type: "type_text",
          frame_id: frame.id,
          text: "sk-syntheticTESTsecret123456",
        },
        surface,
        settings,
        true,
      ).kind,
    ).toBe("DENY");
    expect(
      evaluate(
        { type: "hotkey", frame_id: frame.id, keys: ["CMD", "V"] },
        surface,
        settings,
        true,
      ).kind,
    ).toBe("DENY");
  });
  it("does not treat lookalike domain suffixes as a match", () =>
    expect(
      surfacePolicy({ ...surface, domain: "notpaypal.com" }, settings).kind,
    ).toBe("ALLOW"));
});
describe("privacy boundary", () => {
  it.each([
    "https://example.com",
    "http://localhost:11434",
    "http://127.0.0.1.evil.test",
    "http://user:secret@127.0.0.1",
    "http://127.0.0.1?key=secret",
  ])("rejects local egress: %s", (endpoint) =>
    expect(() => validateProviderEndpoint({ ...settings, endpoint })).toThrow(),
  );
  it("accepts literal loopback and rejects cloud Ollama routing", () => {
    expect(validateProviderEndpoint(settings).hostname).toBe("127.0.0.1");
    expect(() =>
      validateProviderEndpoint({ ...settings, model: "qwen3-vl:cloud" }),
    ).toThrow();
  });
  it("rejects unapproved telemetry and custom content in provider field", () => {
    const event = {
      app_version: "0.1.0",
      os: "darwin",
      provider: "ollama",
      duration_ms: 1,
      actions: 2,
      input_tokens: 0,
      output_tokens: 0,
      confirmations: 0,
      success: true,
    };
    expect(telemetrySchema.safeParse(event).success).toBe(true);
    for (const field of [
      "screenshot",
      "prompt",
      "typed_text",
      "filename",
      "url",
      "clipboard",
    ])
      expect(
        telemetrySchema.safeParse({ ...event, [field]: "secret" }).success,
      ).toBe(false);
    expect(
      telemetrySchema.safeParse({ ...event, provider: "my-private-folder" })
        .success,
    ).toBe(false);
  });
  it("redacts identifiers and blocks secrets without echoing values", () => {
    const text =
      "Contact jane@example.com at +1 415 555 0100. Token sk-testabcdefghijklmnopqrstuvwxyz at https://site.test/?token=x";
    const result = sanitizeText(text);
    expect(result.text).not.toContain("jane@example.com");
    expect(result.text).not.toContain("sk-test");
    expect(result.text).not.toContain("site.test");
    expect(result.findings.some((f) => f.action === "BLOCK_UPLOAD")).toBe(true);
    expect(JSON.stringify(result.findings)).not.toContain("jane");
  });
});
function memory() {
  const events: JournalEvent[] = [];
  const frames: Frame[] = [];
  let run: Run;
  const base = nullRecorder();
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
        ...base.append(id, type, data),
        sequence_number: events.length + 1,
      };
      events.push(e);
      return e;
    },
  };
  return { recorder, events, frames, getRun: () => run! };
}
const tick = () => new Promise((r) => setTimeout(r, 5));
describe("run loop", () => {
  it("recovers unidentified navigation without approvals or executing the blind action", async () => {
    const m = memory();
    let calls = 0;
    const execute = vi.fn();
    const c: Controller = {
      kind: "native",
      surface: async () => surface,
      capture: async () => ({ ...frame, id: crypto.randomUUID() }),
      execute,
      resume: async () => {},
      stop: () => {},
    };
    const runner = new Runner(
      c,
      {
        next: async (o) => {
          calls++;
          if (calls === 2)
            expect(o.history.at(-1)?.result).toContain("No input was sent");
          return {
            action: {
              ...(calls === 1
                ? { type: "click", x: 0.5, y: 0.5 }
                : calls === 2
                  ? { type: "hotkey", keys: ["CMD", "SPACE"] }
                  : { type: "done", summary: "Opened" }),
              frame_id: o.frame.id,
            },
            usage: { cost: 0, inputTokens: 0, outputTokens: 0 },
          };
        },
      },
      m.recorder,
      settings,
      () => {},
    );
    await runner.start("Open Notes");
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0].type).toBe("hotkey");
    expect(m.events.some((e) => e.type === "PolicyConfirmationRequested")).toBe(
      false,
    );
    expect(
      m.events.filter((e) => e.type === "ActionRetargetRequested"),
    ).toHaveLength(1);
  });
  it("bounds unidentified-target recovery and pauses without a generic approval loop", async () => {
    const m = memory();
    const execute = vi.fn();
    const c: Controller = {
      kind: "native",
      surface: async () => surface,
      capture: async () => ({ ...frame, id: crypto.randomUUID() }),
      execute,
      resume: async () => {},
      stop: () => {},
    };
    const next = vi.fn(async (o) => ({
      action: { type: "click", x: 0.5, y: 0.5, frame_id: o.frame.id },
      usage: { cost: 0, inputTokens: 0, outputTokens: 0 },
    }));
    const runner = new Runner(c, { next }, m.recorder, settings, () => {});
    const running = runner.start("Open Notes");
    while (runner.snapshot.run?.status !== "takeover") await tick();
    await tick();
    // Three refused targets, the third with the last word, then the fourth hands over.
    expect(next).toHaveBeenCalledTimes(4);
    expect(next.mock.calls[3][0].history.at(-1)?.result).toMatch(
      /refused and nothing was sent/,
    );
    expect(execute).not.toHaveBeenCalled();
    expect(runner.snapshot.pending).toBeUndefined();
    expect(m.events.some((e) => e.type === "PolicyConfirmationRequested")).toBe(
      false,
    );
    runner.stop();
    await running;
  });
  it("retains executed shortcut and text arguments without stale frame IDs", async () => {
    const m = memory(),
      c = new TutorialController();
    vi.spyOn(c, "execute").mockResolvedValue();
    const observations: import("../src/core/schema").Observation[] = [];
    const actions = [
      { type: "hotkey", keys: ["CMD", "SPACE"] },
      { type: "type_text", text: "Notes" },
      { type: "done", summary: "Opened" },
    ];
    const runner = new Runner(
      c,
      {
        next: async (o) => {
          observations.push(structuredClone(o));
          return {
            action: {
              ...actions[observations.length - 1],
              frame_id: o.frame.id,
            },
            usage: { cost: 0, inputTokens: 0, outputTokens: 0 },
          };
        },
      },
      m.recorder,
      settings,
      () => {},
    );
    await runner.start("Open Notes");
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(observations[2].history.map((h) => h.action)).toEqual(
      actions.slice(0, 2),
    );
    expect(JSON.stringify(observations[2].history)).not.toContain("frame_id");
  });
  it("re-observes after a changed target without replaying the rejected action", async () => {
    const m = memory(),
      c = new TutorialController();
    const execute = vi
      .spyOn(c, "execute")
      .mockRejectedValueOnce(new ScreenChangedError());
    const runner = new Runner(
      c,
      {
        next: async (o) => ({
          action: c.focused
            ? {
                type: "done",
                frame_id: o.frame.id,
                summary: "Focused the field.",
              }
            : { type: "click", frame_id: o.frame.id, x: 0.2, y: 0.85 },
          usage: { cost: 0, inputTokens: 0, outputTokens: 0 },
        }),
      },
      m.recorder,
      settings,
      () => {},
    );
    await runner.start("test");
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(execute.mock.calls[0][0].frame_id).not.toEqual(
      execute.mock.calls[1][0].frame_id,
    );
    expect(
      m.events.filter(
        (e) => e.type === "ActionFailed" && e.data.code === "STATE_CHANGED",
      ),
    ).toHaveLength(1);
    expect(c.focused).toBe(true);
    expect(m.events.filter((e) => e.type === "ActionExecuted")).toHaveLength(1);
  });
  it("pauses a repeatedly changing target with no further model calls until resumed", async () => {
    const m = memory(),
      c = new TutorialController();
    vi.spyOn(c, "execute").mockRejectedValue(new ScreenChangedError());
    const next = vi.fn(async (o) => ({
      action: { type: "click", frame_id: o.frame.id, x: 0.5, y: 0.5 },
      usage: { inputTokens: 1, outputTokens: 1, cost: 0.001 },
    }));
    const runner = new Runner(c, { next }, m.recorder, settings, () => {});
    const running = runner.start("test");
    while (runner.snapshot.run?.status !== "paused") await tick();
    expect(next).toHaveBeenCalledTimes(3);
    await tick();
    expect(next).toHaveBeenCalledTimes(3);
    expect(runner.snapshot.run?.actions).toBe(0);
    runner.stop();
    await running;
  });
  it.each([false, true])(
    "accepts native-revalidated approval despite hash changes and reordered geometry=%s",
    async (reordered) => {
      const m = memory();
      let captures = 0,
        executed = false;
      const execute = vi.fn(
        async (..._args: Parameters<Controller["execute"]>) => {
          executed = true;
        },
      );
      const c: Controller = {
        kind: "native",
        surface: async () => ({
          ...surface,
          targetRole: "AXButton",
          targetLabel: "Send",
        }),
        capture: async () => ({ ...frame, id: `frame-${++captures}` }),
        revalidate: async () => ({
          ...frame,
          id: "fresh-approved",
          sha256: "caret-blink",
          geometry: reordered
            ? (Object.fromEntries(
                Object.entries(frame.geometry).reverse(),
              ) as Frame["geometry"])
            : frame.geometry,
        }),
        execute,
        resume: async () => {},
        stop: () => {},
      };
      const runner = new Runner(
        c,
        {
          next: async (o) => ({
            action: executed
              ? { type: "done", frame_id: o.frame.id, summary: "done" }
              : { type: "click", frame_id: o.frame.id, x: 0.5, y: 0.5 },
            usage: { cost: 0, inputTokens: 0, outputTokens: 0 },
          }),
        },
        m.recorder,
        settings,
        () => {},
      );
      const running = runner.start("test");
      while (runner.snapshot.run?.status !== "confirming") await tick();
      runner.confirm(true);
      await running;
      expect(runner.snapshot.run?.status).toBe("completed");
      expect(execute.mock.calls[0][0]).toMatchObject({
        frame_id: "fresh-approved",
      });
    },
  );
  it("compares every geometry value and rejects missing or added fields", () => {
    expect(
      sameGeometry(
        g,
        Object.fromEntries(Object.entries(g).reverse()) as typeof g,
      ),
    ).toBe(true);
    for (const field of Object.keys(g) as (keyof typeof g)[]) {
      expect(sameGeometry(g, { ...g, [field]: g[field] + 1 })).toBe(false);
      const missing = { ...g } as Partial<typeof g>;
      delete missing[field];
      expect(sameGeometry(g, missing as typeof g)).toBe(false);
    }
    expect(sameGeometry(g, { ...g, unexpected: 1 } as typeof g)).toBe(false);
  });
  it("a changed approval requires a fresh proposal and new approval", async () => {
    const m = memory();
    let proposals = 0;
    const execute = vi.fn();
    const c: Controller = {
      kind: "native",
      surface: async () => ({
        ...surface,
        targetRole: "AXButton",
        targetLabel: "Send",
      }),
      capture: async () => ({ ...frame, id: crypto.randomUUID() }),
      revalidate: async () => {
        throw new ScreenChangedError();
      },
      execute,
      resume: async () => {},
      stop: () => {},
    };
    const runner = new Runner(
      c,
      {
        next: async (o) => {
          proposals++;
          return {
            action: { type: "click", frame_id: o.frame.id, x: 0.5, y: 0.5 },
            usage: { cost: 0, inputTokens: 0, outputTokens: 0 },
          };
        },
      },
      m.recorder,
      settings,
      () => {},
    );
    const running = runner.start("test");
    while (runner.snapshot.run?.status !== "confirming") await tick();
    runner.confirm(true);
    while (proposals < 2 || runner.snapshot.run?.status !== "confirming")
      await tick();
    expect(execute).not.toHaveBeenCalled();
    expect(m.events.filter((e) => e.type === "UserConfirmed")).toHaveLength(1);
    runner.stop();
    await running;
  });
  it("completes GUI tutorial with fresh observations and no network", async () => {
    const m = memory(),
      controller = new TutorialController();
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Network disabled"));
    const runner = new Runner(
      controller,
      new TutorialProvider(0),
      m.recorder,
      settings,
      () => {},
    );
    await runner.start("Move the card and add a note.");
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(controller.moved).toBe(true);
    expect(controller.text).toContain("Done");
    expect(m.frames.length).toBe(4);
    expect(m.events.filter((e) => e.type === "ActionExecuted")).toHaveLength(3);
    expect(request).not.toHaveBeenCalled();
    request.mockRestore();
  });
  it("emergency stop interrupts a pending provider without late actions", async () => {
    const m = memory(),
      c = new TutorialController();
    let release: (v: any) => void = () => {};
    const provider = { next: () => new Promise<any>((r) => (release = r)) };
    const runner = new Runner(c, provider, m.recorder, settings, () => {});
    const running = runner.start("test");
    while (runner.snapshot.run?.status !== "thinking") await tick();
    runner.stop();
    release({
      action: {
        type: "type_text",
        frame_id: runner.snapshot.frame!.id,
        text: "late",
      },
      usage: { cost: 0, inputTokens: 0, outputTokens: 0 },
    });
    await running;
    expect(runner.snapshot.run?.status).toBe("cancelled");
    expect(c.text).toBe("");
    expect(m.events.some((e) => e.type === "ActionExecuted")).toBe(false);
  });
  it("pause aborts inference and resume captures a fresh frame", async () => {
    const m = memory(),
      runner = new Runner(
        new TutorialController(),
        new TutorialProvider(20),
        m.recorder,
        settings,
        () => {},
      );
    const running = runner.start("test");
    while (runner.snapshot.run?.status !== "thinking") await tick();
    runner.pause();
    const count = m.frames.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(m.frames).toHaveLength(count);
    expect(runner.snapshot.run?.status).toBe("paused");
    await runner.resume();
    await running;
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(m.frames.length).toBeGreaterThan(count);
  });
  it("protected app suspends capture until explicit resume", async () => {
    const m = memory(),
      c = new TutorialController();
    let secure = true;
    c.surface = async () => ({ ...surface, secureInput: secure });
    const runner = new Runner(
      c,
      new TutorialProvider(0),
      m.recorder,
      settings,
      () => {},
    );
    const running = runner.start("test");
    while (runner.snapshot.run?.status !== "takeover") await tick();
    expect(m.frames).toHaveLength(0);
    secure = false;
    await runner.resume();
    await running;
    expect(runner.snapshot.run?.status).toBe("completed");
  });
  it("terminates repeated prohibited proposals without logging secret text", async () => {
    const m = memory(),
      c = new TutorialController();
    const runner = new Runner(
      c,
      {
        next: async (o) => ({
          action: {
            type: "type_text",
            frame_id: o.frame.id,
            text: "sk-syntheticSECRETabcdefghijk",
          },
          usage: { cost: 0, inputTokens: 0, outputTokens: 0 },
        }),
      },
      m.recorder,
      settings,
      () => {},
    );
    await runner.start("test");
    expect(runner.snapshot.run?.status).toBe("failed");
    expect(JSON.stringify(m.events)).not.toContain("syntheticSECRET");
    expect(m.events.filter((e) => e.type === "UserDenied")).toHaveLength(3);
  });
  it("enforces action and estimated cost budgets", async () => {
    for (const limit of ["actions", "cost"]) {
      const m = memory(),
        runner = new Runner(
          new TutorialController(),
          limit === "actions"
            ? new TutorialProvider(0)
            : {
                next: async (o) => ({
                  action: {
                    type: "done",
                    frame_id: o.frame.id,
                    summary: "done",
                  },
                  usage: { cost: 2, inputTokens: 1, outputTokens: 1 },
                }),
              },
          m.recorder,
          { ...settings, maxActions: 1, maxCost: 1 },
          () => {},
        );
      await runner.start("test");
      expect(runner.snapshot.run?.status).toBe("failed");
      expect(runner.snapshot.run!.actions).toBeLessThanOrEqual(1);
    }
  });
});
