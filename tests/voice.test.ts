import { describe, it, expect } from "vitest";
import { voiceIntent, voiceCommandConfidence } from "../src/voice/router";
import { Runner } from "../src/core/runner";
import { TutorialController } from "../src/core/tutorial";
import {
  defaultSettings,
  settingsSchema,
  actionSchema,
  type JournalEvent,
  type Recorder,
  type Observation,
  type Controller,
} from "../src/core/schema";
import { evaluate } from "../src/core/policy";
import { prepareBundle } from "../src/contribution/bundle";
const tick = () => new Promise((r) => setTimeout(r, 3));
describe("hands-free preference", () => {
  it("keeps existing installs muted until the mode is explicitly selected", () => {
    const { handsFree: _, ...legacy } = defaultSettings;
    expect(settingsSchema.parse(legacy).handsFree).toBe(false);
    expect(settingsSchema.parse({ ...legacy, handsFree: true }).handsFree).toBe(
      true,
    );
    expect(() =>
      settingsSchema.parse({ ...legacy, handsFree: "true" }),
    ).toThrow();
  });
});
function memory() {
  const events: JournalEvent[] = [];
  let run: any;
  const recorder: Recorder = {
    begin: (r) => (run = r),
    save: (r) => (run = r),
    frame: () => {},
    append: (id, type, data = {}) => {
      const e: JournalEvent = {
        event_id: crypto.randomUUID(),
        run_id: id,
        sequence_number: events.length + 1,
        monotonic_timestamp: performance.now(),
        wall_clock_timestamp: new Date().toISOString(),
        schema_version: 1,
        type,
        data,
      };
      events.push(e);
      return e;
    },
  };
  return { recorder, events, run: () => run };
}
describe("voice intent boundary", () => {
  it("never treats a recovered approval as confident final speech", () => {
    for (const text of ["yes", "send it", "go ahead"]) {
      expect(voiceIntent(text).kind).toBe("approve");
      expect(
        voiceCommandConfidence({
          event: "transcript_recovered",
          confidence: 1,
        }),
      ).toBe(0);
    }
    expect(
      voiceCommandConfidence({ event: "transcript_final", confidence: 0.9 }),
    ).toBe(0.9);
    for (const confidence of [undefined, NaN, Infinity, -1, 2])
      expect(
        voiceCommandConfidence({ event: "transcript_final", confidence }),
      ).toBe(0);
    expect(
      voiceCommandConfidence({ event: "transcript_partial", confidence: 1 }),
    ).toBe(0);
  });
  it.each([
    ["Stop.", "stop"],
    ["Wait.", "pause"],
    ["Keep going", "resume"],
    ["Yes.", "approve"],
    ["No.", "decline"],
    ["No, use the September report.", "command"],
    ["Don't send anything yet.", "command"],
    ["Use Chrome, not Safari.", "command"],
    ["Skip this one.", "command"],
    ["Yesterday I said yes.", "command"],
  ])("routes %s exactly", (text, kind) =>
    expect(voiceIntent(text).kind).toBe(kind),
  );
  it("does not mistake a negated stop for a kill command", () =>
    expect(voiceIntent("Don't stop until it is ready.").kind).toBe("command"));
});
describe("voice steering inside a run", () => {
  it("keeps an approval through voice interruption and pauses when it is declined", async () => {
    const m = memory(),
      simulation = new TutorialController();
    let executed = 0;
    const controller: Controller = {
      kind: "native",
      surface: async () => ({
        ...(await simulation.surface()),
        targetRole: "AXButton",
        targetLabel: "Send",
      }),
      capture: () => simulation.capture(),
      stop: () => simulation.stop(),
      resume: () => simulation.resume(),
      execute: async () => {
        executed++;
      },
    };
    const runner = new Runner(
      controller,
      {
        next: async (o) => ({
          action: { type: "click", frame_id: o.frame.id, x: 0.5, y: 0.5 },
          usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
        }),
      },
      m.recorder,
      defaultSettings,
      () => {},
    );
    const running = runner.start("Prepare a message and ask before sending.");
    while (runner.snapshot.run?.status !== "confirming") await tick();
    const pending = runner.snapshot.pending;
    runner.manualTakeover();
    expect(runner.snapshot.pending).toBe(pending);
    await runner.approveFromVoice(false);
    expect(runner.snapshot.run?.status).toBe("paused");
    expect(executed).toBe(0);
    runner.stop();
    await running;
  });
  it("manual input pauses capture and invalidates a pending model response", async () => {
    const m = memory(),
      c = new TutorialController();
    let release: (value: any) => void = () => {};
    const runner = new Runner(
      c,
      {
        next: () =>
          new Promise<any>((resolve) => {
            release = resolve;
          }),
      },
      m.recorder,
      defaultSettings,
      () => {},
    );
    const running = runner.start("Prepare a report");
    while (runner.snapshot.run?.status !== "thinking") await tick();
    runner.manualTakeover();
    expect(runner.snapshot.run?.status).toBe("paused");
    expect(runner.snapshot.message).toContain("you’re controlling");
    expect(m.events.some((e) => e.type === "UserTakeoverStarted")).toBe(true);
    release({
      action: {
        type: "click",
        x: 0.5,
        y: 0.5,
        frame_id: runner.snapshot.frame!.id,
      },
      usage: { cost: 0, inputTokens: 0, outputTokens: 0 },
    });
    await tick();
    expect(runner.snapshot.run?.actions).toBe(0);
    expect(runner.snapshot.run?.status).toBe("paused");
    runner.stop();
    await running;
  });
  it("discards stale inference and includes finalized correction on a fresh observation", async () => {
    const m = memory(),
      c = new TutorialController(),
      observed: Observation[] = [];
    let release: (x: any) => void = () => {};
    const provider = {
      next: async (o: Observation) => {
        observed.push(o);
        if (observed.length === 1)
          return new Promise<any>((r) => (release = r));
        return {
          action: { type: "done", frame_id: o.frame.id, summary: "Done" },
          usage: { cost: 0, inputTokens: 0, outputTokens: 0 },
        };
      },
    };
    const runner = new Runner(
      c,
      provider,
      m.recorder,
      defaultSettings,
      () => {},
    );
    const running = runner.start("Find report; do not send it.");
    while (observed.length < 1) await tick();
    runner.interruptForVoice();
    await runner.revise("No, use the September report.");
    release({
      action: {
        type: "type_text",
        frame_id: observed[0].frame.id,
        text: "stale",
      },
      usage: { cost: 0, inputTokens: 0, outputTokens: 0 },
    });
    await running;
    expect(c.text).toBe("");
    expect(observed).toHaveLength(2);
    expect(observed[1].frame.id).not.toBe(observed[0].frame.id);
    expect(observed[1].task).toContain("do not send");
    expect(observed[1].task).toContain("September");
    expect(
      m.events.filter((e) => e.type === "UserCorrectionRecorded"),
    ).toHaveLength(1);
    expect(m.run().corrections[0].after_action).toBe(0);
  });
  it("does not approve with no pending action and rejects spoken secrets", async () => {
    const m = memory(),
      c = new TutorialController();
    let release: (x: any) => void = () => {};
    const runner = new Runner(
      c,
      { next: () => new Promise<any>((r) => (release = r)) },
      m.recorder,
      defaultSettings,
      () => {},
    );
    const running = runner.start("test");
    while (runner.snapshot.run?.status !== "thinking") await tick();
    await expect(runner.approveFromVoice(true)).rejects.toThrow(
      "Nothing to approve",
    );
    await expect(runner.revise("password=syntheticSECRET")).rejects.toThrow(
      "credentials",
    );
    runner.stop();
    release({
      action: {
        type: "done",
        frame_id: runner.snapshot.frame!.id,
        summary: "done",
      },
      usage: { cost: 0, inputTokens: 0, outputTokens: 0 },
    });
    await running;
    expect(JSON.stringify(m.events)).not.toContain("syntheticSECRET");
  });
  it("sanitizes correction text in contribution and omits it in statistics", () => {
    const m = memory(),
      run: any = {
        id: crypto.randomUUID(),
        task: "Find report",
        status: "completed",
        provider: "ollama",
        actions: 1,
        frames: 1,
        usage: { cost: 0, inputTokens: 0, outputTokens: 0 },
        synthetic: true,
        corrections: [
          {
            text: "Email jane@example.com instead",
            after_action: 1,
            timestamp: "private",
          },
        ],
      };
    const b = prepareBundle(run, [], [], {
      runId: run.id,
      level: "trajectory",
      excludedFrames: [],
      excludedEvents: [],
    });
    expect(b.corrections?.[0].text).not.toContain("jane@example.com");
    expect(b.corrections?.[0].after_action).toBe(1);
    expect(JSON.stringify(b)).not.toContain("timestamp");
    expect(
      prepareBundle(run, [], [], {
        runId: run.id,
        level: "statistics",
        excludedFrames: [],
        excludedEvents: [],
      }).corrections,
    ).toBeUndefined();
  });
});
describe("minimal approval policy", () => {
  const surface = {
    appId: "example",
    pid: 1,
    secureInput: false,
    unknown: false,
  };
  it.each([
    { type: "key", key: "ESC" },
    { type: "hotkey", keys: ["CMD", "SPACE"] },
    { type: "hotkey", keys: ["TAB", "CMD"] },
    { type: "hotkey", keys: ["SHIFT", "CMD", "TAB"] },
    { type: "hotkey", keys: ["CMD", "F"] },
  ])(
    "automates exact navigation actions without activating a focused Send button: %j",
    (input) => {
      const action = actionSchema.parse({ ...input, frame_id: "f" });
      expect(
        evaluate(
          action,
          { ...surface, targetLabel: "Send", focusedRole: "AXButton" },
          defaultSettings,
          false,
        ).kind,
      ).toBe("ALLOW");
      expect(
        evaluate(
          action,
          { ...surface, secureInput: true },
          defaultSettings,
          false,
        ).kind,
      ).toBe("USER_TAKEOVER");
      expect(
        evaluate(action, { ...surface, unknown: true }, defaultSettings, false)
          .kind,
      ).toBe("RETRY");
    },
  );
  it.each([
    { type: "key", key: "ENTER" },
    { type: "key", key: "SPACE" },
    { type: "hotkey", keys: ["CMD", "ENTER"] },
    { type: "hotkey", keys: ["CMD", "BACKSPACE"] },
    { type: "hotkey", keys: ["CMD", "SHIFT", "SPACE"] },
    { type: "hotkey", keys: ["CMD", "CMD", "SPACE"] },
  ])("gates activations and retries unidentified shortcuts: %j", (input) => {
    expect(
      evaluate(
        actionSchema.parse({ ...input, frame_id: "f" }),
        surface,
        defaultSettings,
        false,
      ).kind,
    ).toBe(
      input.type === "key" ||
        input.keys?.some((k) => ["ENTER", "BACKSPACE"].includes(k))
        ? "CONFIRM"
        : "RETRY",
    );
  });
  it("opens Spotlight results but never treats message-field Enter as navigation", () => {
    const action = actionSchema.parse({
      type: "key",
      key: "ENTER",
      frame_id: "f",
    });
    expect(
      evaluate(
        action,
        {
          ...surface,
          appId: "com.apple.Spotlight",
          focusedRole: "AXTextField",
          launcher: { query: "Notes", selectedResult: "Notes" },
        },
        defaultSettings,
        false,
      ).kind,
    ).toBe("ALLOW");
    expect(
      evaluate(
        action,
        {
          ...surface,
          appId: "com.tinyspeck.slackmacgap",
          focusedRole: "AXTextArea",
        },
        defaultSettings,
        false,
      ).kind,
    ).toBe("CONFIRM");
    expect(
      evaluate(
        action,
        { ...surface, appId: "com.apple.Spotlight" },
        defaultSettings,
        false,
      ).kind,
    ).toBe("CONFIRM");
  });
  it("limits browser focus, text selection, and delete to verified contexts", () => {
    const focus = actionSchema.parse({
      type: "hotkey",
      keys: ["CMD", "L"],
      frame_id: "f",
    });
    expect(
      evaluate(
        focus,
        { ...surface, appId: "com.google.Chrome" },
        defaultSettings,
        false,
      ).kind,
    ).toBe("ALLOW");
    expect(evaluate(focus, surface, defaultSettings, false).kind).toBe("DENY");
    for (const input of [
      { type: "hotkey", keys: ["CMD", "A"] },
      { type: "key", key: "DELETE" },
    ]) {
      const action = actionSchema.parse({ ...input, frame_id: "f" });
      expect(
        evaluate(
          action,
          { ...surface, focusedRole: "AXTextArea" },
          defaultSettings,
          false,
        ).kind,
      ).toBe("ALLOW");
      expect(
        evaluate(
          action,
          { ...surface, appId: "com.apple.finder", focusedRole: "AXOutline" },
          defaultSettings,
          false,
        ).kind,
      ).toBe(input.type === "key" ? "CONFIRM" : "RETRY");
    }
  });
  it.each([
    "Send",
    "Pay",
    "Delete",
    "Change password",
    "Share",
    "Install",
    "Confirm",
  ])("keeps approval for consequential controls: %s", (targetLabel) => {
    const action = actionSchema.parse({
      type: "click",
      x: 0.5,
      y: 0.5,
      frame_id: "f",
    });
    expect(
      evaluate(
        action,
        { ...surface, targetRole: "AXButton", targetLabel },
        defaultSettings,
        false,
      ).kind,
    ).toBe("CONFIRM");
  });
  it("allows known editing, confirms Send, and retries unknown controls", () => {
    expect(
      evaluate(
        { type: "type_text", frame_id: "f", text: "Thursday works." },
        { ...surface, focusedRole: "AXTextArea" },
        defaultSettings,
        false,
      ).kind,
    ).toBe("ALLOW");
    expect(
      evaluate(
        { type: "click", frame_id: "f", x: 0.5, y: 0.5, button: "left" },
        { ...surface, targetRole: "AXButton", targetLabel: "Reply" },
        defaultSettings,
        false,
      ).kind,
    ).toBe("ALLOW");
    const action = {
      type: "click" as const,
      frame_id: "f",
      x: 0.5,
      y: 0.5,
      button: "left" as const,
    };
    expect(
      evaluate(
        action,
        { ...surface, targetRole: "AXButton", targetLabel: "Send" },
        defaultSettings,
        false,
      ),
    ).toEqual({ kind: "CONFIRM", reason: "Send this message?" });
    expect(
      evaluate(action, { ...surface, unknown: true }, defaultSettings, false)
        .kind,
    ).toBe("RETRY");
    expect(
      evaluate(
        { type: "key", frame_id: "f", key: "ENTER" },
        surface,
        defaultSettings,
        false,
      ).kind,
    ).toBe("CONFIRM");
  });
});
