import { describe, expect, it, vi } from "vitest";
import {
  actionSchema,
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
  type Surface,
} from "../src/core/schema";
import { Runner } from "../src/core/runner";
import { evaluate, focusedTextField } from "../src/core/policy";

/**
 * The dictation fast path: "type hello world" said with a text field focused
 * is typed on the first frame through the ordinary policy, and the run ends
 * without a model call. Anything else about the screen leaves the words to
 * the normal run. Which words are a dictation is tested in
 * voice-dictation.test.ts; this is the runner's part.
 */
const NOTES = "com.apple.Notes";
const SLACK = "com.tinyspeck.slackmacgap";
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
const usage = { inputTokens: 0, outputTokens: 0, cost: 0 };
const settings = { ...structuredClone(defaultSettings), memory: false };
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
  let run: Run | undefined;
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
/** The screen stands still: every capture of one desktop hashes the same. */
const frameOf = (id: string, appId: string): Frame => ({
  id,
  sha256: `sha-${appId}`,
  image: "",
  geometry,
  capturedAt: 0,
  synthetic: false,
  appId,
  context: { appName: "App", windowTitle: "Window" },
});
const noteField: Surface = {
  appId: NOTES,
  pid: 1,
  secureInput: false,
  unknown: false,
  appName: "Notes",
  focusedRole: "AXTextArea",
  focusedLabel: "Note",
};
const chatField: Surface = {
  ...noteField,
  appId: SLACK,
  appName: "Slack",
  focusedLabel: "Message to Dana",
};

function desktop(surface: Surface) {
  const calls: string[] = [];
  let captures = 0;
  const controller: Controller = {
    kind: "native",
    surface: vi.fn(async (action?: Action) => {
      calls.push(action ? `surface(${action.type})` : "surface()");
      return surface;
    }),
    capture: vi.fn(async () => {
      calls.push("capture");
      return frameOf(`frame-${++captures}`, surface.appId);
    }),
    execute: vi.fn(async (a: Action): Promise<void | ExecutionResult> => {
      calls.push(`execute(${a.type})`);
    }),
    resume: vi.fn(async () => {}),
    stop: vi.fn(() => {}),
  };
  return { controller, calls };
}
function scripted() {
  const observations: Observation[] = [];
  const next = vi.fn(async (o: Observation) => {
    observations.push(structuredClone(o));
    return {
      usage,
      action: { type: "done", summary: "Done", frame_id: o.frame.id },
    } as ProviderResult;
  });
  return { next, observations };
}
function start(task: string, surface: Surface, dictation?: string) {
  const j = journal();
  const desk = desktop(surface);
  const provider = scripted();
  const runner = new Runner(
    desk.controller,
    { next: provider.next },
    j.recorder,
    settings,
    () => {},
    [],
  );
  const started = runner.start(task, {
    origin: "voice",
    taskSource: "user_words",
    ...(dictation !== undefined ? { dictation } : {}),
  });
  return { ...j, ...desk, provider, runner, started };
}
async function run(task: string, surface: Surface, dictation?: string) {
  const r = start(task, surface, dictation);
  await r.started;
  await until(() => r.runner.settled);
  return r;
}

describe("focusedTextField", () => {
  const field = (surface: Partial<Surface>): Surface => ({
    ...noteField,
    ...surface,
  });
  it("is a known, non-secure text field, text area or combo box", () => {
    for (const role of ["AXTextField", "AXTextArea", "AXComboBox"]) {
      const surface = field({ focusedRole: role });
      expect(focusedTextField(surface)).toBe(true);
      // What the fast path types is what the ordinary rule allows.
      expect(
        evaluate(
          actionSchema.parse({
            type: "type_text",
            text: "Hello world",
            frame_id: "f",
          }),
          surface,
          settings,
          false,
        ).kind,
      ).toBe("ALLOW");
    }
  });
  it("is nothing else that can have the focus", () => {
    expect(focusedTextField(field({ focusedRole: "AXButton" }))).toBe(false);
    expect(focusedTextField(field({ focusedRole: "AXWebArea" }))).toBe(false);
    expect(focusedTextField(field({ focusedRole: undefined }))).toBe(false);
  });
  it("never counts a password field, secure input, a terminal or an unknown surface", () => {
    expect(
      focusedTextField(
        field({
          focusedRole: "AXTextField",
          focusedSubrole: "AXSecureTextField",
        }),
      ),
    ).toBe(false);
    expect(focusedTextField(field({ secureInput: true }))).toBe(false);
    expect(focusedTextField(field({ terminalFocus: true }))).toBe(false);
    expect(focusedTextField(field({ unknown: true }))).toBe(false);
  });
});

describe("a run with a dictation", () => {
  it("types the words into the focused field and finishes without the model", async () => {
    const r = await run("type hello world", noteField, "Hello world");
    expect(r.provider.next).not.toHaveBeenCalled();
    expect(r.calls).toEqual([
      "surface()",
      "capture",
      "surface(type_text)",
      "execute(type_text)",
    ]);
    expect(r.controller.execute).toHaveBeenCalledWith(
      { type: "type_text", text: "Hello world", frame_id: "frame-1" },
      expect.objectContaining({ id: "frame-1" }),
      expect.anything(),
    );
    expect(r.events.map((e) => e.type)).toEqual([
      "RunStarted",
      "FrameCaptured",
      "DictationStepProposed",
      "ActionProposed",
      "PolicyAllowed",
      "ActionExecuted",
      "RunCompleted",
    ]);
    expect(r.of("PolicyAllowed")[0].data.reason).toBe(
      "Write in the Notes document editor.",
    );
    const finished = r.getRun();
    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Typed it.");
    expect(finished.actions).toBe(1);
    expect(finished.frames).toBe(1);
    expect(finished.usage).toEqual(usage);
  });

  it("types into an ordinary text field of any app the same way", async () => {
    const r = await run(
      "type hello world",
      { ...chatField, focusedRole: "AXTextField" },
      "Hello world",
    );
    expect(r.provider.next).not.toHaveBeenCalled();
    expect(r.of("PolicyAllowed")[0].data.reason).toBe(
      "Type in a known non-secure text field.",
    );
    expect(r.getRun().summary).toBe("Typed it.");
  });

  it("leaves the words to the model when no text field is focused", async () => {
    const r = await run(
      "type hello world",
      { ...noteField, focusedRole: "AXButton", focusedLabel: "Done" },
      "Hello world",
    );
    expect(r.of("DictationStepProposed")).toHaveLength(0);
    expect(r.calls).not.toContain("execute(type_text)");
    expect(r.provider.next).toHaveBeenCalledTimes(1);
    // The task as it was said, not the written-out text.
    expect(r.provider.observations[0].task).toBe("type hello world");
    expect(r.getRun().status).toBe("completed");
  });

  it("is only ever tried on the first frame", async () => {
    // A blind chat window: nothing focused is reported, so the model works
    // from the words; a field that appears later is its to type into.
    const r = await run(
      "type hello world",
      { ...chatField, focusedRole: undefined, accessibility: "none" },
      "Hello world",
    );
    expect(r.of("DictationStepProposed")).toHaveLength(0);
    expect(r.provider.next).toHaveBeenCalledTimes(1);
  });

  it("never types into a password field", async () => {
    const r = start(
      "type hello world",
      {
        ...chatField,
        secureInput: true,
        focusedRole: "AXTextField",
        focusedSubrole: "AXSecureTextField",
      },
      "Hello world",
    );
    await until(() => r.runner.snapshot.run?.status === "takeover");
    expect(r.calls).toEqual(["surface()"]);
    expect(r.controller.execute).not.toHaveBeenCalled();
    expect(r.provider.next).not.toHaveBeenCalled();
    expect(r.of("DictationStepProposed")).toHaveLength(0);
    r.runner.stop();
    await r.started;
    await until(() => r.runner.settled);
  });

  it("asks before typing line breaks where Enter sends, then finishes", async () => {
    const r = start("type hello new line world", chatField, "Hello\nWorld");
    await until(() => r.runner.snapshot.run?.status === "confirming");
    expect(r.runner.snapshot.pending?.reason).toMatch(/line breaks/);
    expect(r.controller.execute).not.toHaveBeenCalled();
    r.runner.confirm(true);
    await r.started;
    await until(() => r.runner.settled);
    expect(r.provider.next).not.toHaveBeenCalled();
    // Typed on the fresh frame the approval was checked against, as approved.
    expect(r.controller.execute).toHaveBeenCalledWith(
      {
        type: "type_text",
        text: "Hello\nWorld",
        frame_id: "frame-2",
        approved: true,
      },
      expect.objectContaining({ id: "frame-2" }),
      expect.anything(),
    );
    expect(r.of("UserConfirmed")).toHaveLength(1);
    expect(r.getRun().summary).toBe("Typed it.");
  });

  it("writes line breaks in a document editor without asking", async () => {
    const r = await run("type hello new line world", noteField, "Hello\nWorld");
    expect(r.of("PolicyConfirmationRequested")).toHaveLength(0);
    expect(r.calls).toContain("execute(type_text)");
    expect(r.getRun().summary).toBe("Typed it.");
  });

  it("leaves a declined step to the model", async () => {
    const r = start("type hello new line world", chatField, "Hello\nWorld");
    await until(() => r.runner.snapshot.run?.status === "confirming");
    r.runner.confirm(false);
    await r.started;
    await until(() => r.runner.settled);
    expect(r.calls).not.toContain("execute(type_text)");
    // The model's bare done over the declined dictation is checked once
    // against a fresh screenshot (runner-done.test.ts); said again, it stands.
    expect(r.provider.next).toHaveBeenCalledTimes(2);
    const check = r.provider.next.mock.calls[1][0].history.at(-1)!;
    expect(check.type).toBe("rejected");
    expect(check.action).toEqual({ type: "done" });
    expect(check.result).toContain("fresh screenshot");
    expect(r.getRun().status).toBe("completed");
    expect(r.getRun().summary).toBe("Done");
  });

  it("never types detected credentials", async () => {
    const r = await run(
      "type the token",
      noteField,
      "Token sk-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ",
    );
    expect(r.calls).not.toContain("execute(type_text)");
    expect(r.of("UserDenied")).toHaveLength(1);
    // A done after the refused step is checked once, like after a decline.
    expect(r.provider.next).toHaveBeenCalledTimes(2);
    expect(r.provider.next.mock.calls[1][0].history.at(-1)).toMatchObject({
      type: "rejected",
      action: { type: "done" },
    });
  });

  it("runs as before without a dictation", async () => {
    const r = await run("type hello world", noteField);
    expect(r.of("DictationStepProposed")).toHaveLength(0);
    expect(r.provider.next).toHaveBeenCalledTimes(1);
  });
});
