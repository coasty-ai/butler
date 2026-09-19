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
  type Surface,
  type Usage,
} from "../src/core/schema";
import { Runner } from "../src/core/runner";
import {
  DESCRIBED_CONTROLS,
  DESCRIBED_TEXT_CHARS,
  SCREENSHOT_EVERY,
  actionConfirmed,
  contextDigest,
  screenshotNote,
  screenshotUse,
  type ScreenshotInput,
} from "../src/core/vision";
import { buildRequest } from "../src/providers/http";

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
  native_width: 1440,
  native_height: 900,
  model_width: 1440,
  model_height: 900,
  scale_factor: 1,
};
const png = "data:image/png;base64,YWJj";
const preview = {
  image: "data:image/jpeg;base64,anBn",
  width: 1024,
  height: 640,
};
/** A screen the application describes: enough labeled controls and text. */
const described: ScreenContext = {
  appName: "Spotify",
  windowTitle: "Spotify Premium",
  accessibility: "full",
  visibleText: Array.from(
    { length: 30 },
    (_, i) => `Playlist ${i + 1}: songs for a long evening`,
  ).join("\n"),
  controls: Array.from({ length: 12 }, (_, i) => ({
    role: "button",
    label: `Control ${i + 1}`,
    x: 0.1,
    y: 0.05 * (i + 1),
  })),
};
const frame = (over: Partial<Frame> = {}): Frame => ({
  id: "f1",
  sha256: "sha-1",
  image: png,
  geometry,
  capturedAt: 0,
  synthetic: false,
  appId: "com.spotify.client",
  context: described,
  preview,
  ...over,
});
const surface = (over: Partial<Surface> = {}): Surface => ({
  appId: "com.spotify.client",
  pid: 7,
  secureInput: false,
  unknown: false,
  ...over,
});
const shownFrame = (f: Frame) => ({
  sha256: f.sha256,
  context: contextDigest(f),
});
const input = (over: Partial<ScreenshotInput> = {}): ScreenshotInput => ({
  mode: "auto",
  frame: frame(),
  surface: surface(),
  shown: shownFrame(frame({ sha256: "sha-0" })),
  sinceImage: 0,
  executed: { type: "click_control", confirmed: true },
  ...over,
});

describe("screenshot rules", () => {
  it("sends every screenshot at full size in always mode", () => {
    const same = frame();
    expect(
      screenshotUse(input({ mode: "always", shown: shownFrame(same) })),
    ).toEqual({ send: "full", reason: "always" });
  });
  it("never drops the first screenshot, a requested one, a blind surface or an OCR frame", () => {
    const same = frame();
    // Each case is otherwise an unchanged screen, which would send none.
    const unchanged = input({ shown: shownFrame(same) });
    expect(screenshotUse(unchanged)).toEqual({
      send: "none",
      reason: "unchanged",
    });
    expect(screenshotUse({ ...unchanged, shown: undefined })).toEqual({
      send: "full",
      reason: "first",
    });
    expect(
      screenshotUse({
        ...unchanged,
        executed: { type: "capture", confirmed: false },
      }),
    ).toEqual({ send: "full", reason: "requested" });
    for (const blind of [
      input({
        frame: frame({ context: undefined }),
        shown: shownFrame(frame({ context: undefined })),
      }),
      input({
        frame: frame({ context: { ...described, accessibility: "none" } }),
        shown: shownFrame(
          frame({ context: { ...described, accessibility: "none" } }),
        ),
      }),
      { ...unchanged, surface: surface({ unknown: true }) },
    ])
      expect(screenshotUse(blind)).toEqual({ send: "full", reason: "blind" });
    const ocr = frame({ context: { ...described, screenText: "read" } });
    expect(
      screenshotUse(input({ frame: ocr, shown: shownFrame(ocr) })),
    ).toEqual({ send: "full", reason: "ocr" });
    // Text-first mode drops no more than auto does.
    for (const mode of ["auto", "text-first"] as const) {
      expect(screenshotUse({ ...unchanged, mode, shown: undefined }).send).toBe(
        "full",
      );
      expect(
        screenshotUse({
          ...unchanged,
          mode,
          surface: surface({ unknown: true }),
        }).send,
      ).toBe("full");
    }
  });
  it("never drops the screenshot after an action native input could not verify", () => {
    const same = frame();
    expect(
      screenshotUse(
        input({
          shown: shownFrame(same),
          executed: { type: "scroll", confirmed: false },
        }),
      ),
    ).toEqual({ send: "full", reason: "unconfirmed" });
    // A verified target on an unchanged screen: nothing new to look at.
    expect(
      screenshotUse(
        input({
          shown: shownFrame(same),
          executed: { type: "click", confirmed: true },
        }),
      ).send,
    ).toBe("none");
    // No action at all (a rejected step) neither forces nor forbids one.
    expect(
      screenshotUse(input({ shown: shownFrame(same), executed: undefined })),
    ).toEqual({ send: "none", reason: "unchanged" });
  });
  it("sends a screenshot at least every fourth step", () => {
    const same = frame();
    for (let since = 0; since < SCREENSHOT_EVERY - 1; since++)
      expect(
        screenshotUse(input({ shown: shownFrame(same), sinceImage: since }))
          .send,
      ).toBe("none");
    expect(
      screenshotUse(
        input({ shown: shownFrame(same), sinceImage: SCREENSHOT_EVERY - 1 }),
      ),
    ).toEqual({ send: "full", reason: "cadence" });
  });
  it("sends none for an unchanged screen only when hash and context both match", () => {
    const same = frame();
    expect(screenshotUse(input({ shown: shownFrame(same) })).send).toBe("none");
    // Same pixels, a control moved: the accessibility context changed.
    const moved = frame({
      context: {
        ...described,
        controls: described.controls!.map((c, i) =>
          i === 0 ? { ...c, x: 0.9 } : c,
        ),
      },
    });
    expect(
      screenshotUse(input({ frame: moved, shown: shownFrame(same) })),
    ).toEqual({ send: "reduced", reason: "described" });
    // Same context, different pixels: something drew that accessibility
    // does not carry.
    expect(
      screenshotUse(
        input({ frame: frame({ sha256: "sha-2" }), shown: shownFrame(same) }),
      ),
    ).toEqual({ send: "reduced", reason: "described" });
  });
  it("reduces a described screen in auto mode and drops it in text-first", () => {
    const changed = input({ frame: frame({ sha256: "sha-2" }) });
    expect(screenshotUse(changed)).toEqual({
      send: "reduced",
      reason: "described",
    });
    expect(screenshotUse({ ...changed, mode: "text-first" })).toEqual({
      send: "none",
      reason: "described",
    });
    // One labeled control or one character short: a full screenshot.
    const thin = [
      frame({
        sha256: "sha-2",
        context: {
          ...described,
          controls: described.controls!.slice(0, DESCRIBED_CONTROLS - 1),
        },
      }),
      frame({
        sha256: "sha-2",
        context: {
          ...described,
          visibleText: "x".repeat(DESCRIBED_TEXT_CHARS - 1),
        },
      }),
      frame({
        sha256: "sha-2",
        context: {
          ...described,
          controls: described.controls!.map(({ label: _l, ...c }) => c),
        },
      }),
    ];
    for (const f of thin)
      for (const mode of ["auto", "text-first"] as const)
        expect(screenshotUse({ ...changed, mode, frame: f })).toEqual({
          send: "full",
          reason: "changed",
        });
  });
  it("tells which executed actions native input verified", () => {
    const s = surface();
    const field = surface({ focusedRole: "AXTextField" });
    const cases: [Action, Surface, void | Record<string, unknown>, boolean][] =
      [
        [
          { type: "menu_item", frame_id: "f", path: ["Edit", "Undo"] },
          s,
          undefined,
          true,
        ],
        [
          { type: "click_control", frame_id: "f", label: "Play" },
          s,
          undefined,
          true,
        ],
        [
          { type: "wait", frame_id: "f", milliseconds: 500 },
          s,
          undefined,
          true,
        ],
        [
          { type: "open_app", frame_id: "f", name: "Notes" },
          s,
          {
            launched: {
              appId: "com.apple.Notes",
              name: "Notes",
              frontmost: true,
              wasRunning: true,
            },
          },
          true,
        ],
        [
          { type: "open_app", frame_id: "f", name: "Notes" },
          s,
          {
            launched: {
              appId: "com.apple.Notes",
              name: "Notes",
              frontmost: false,
              wasRunning: false,
            },
          },
          false,
        ],
        [
          { type: "open_file", frame_id: "f", path: "~/a.pdf" },
          s,
          { opened: { path: "~/a.pdf", kind: "document" } },
          true,
        ],
        [
          { type: "open_file", frame_id: "f", path: "~/a.pdf" },
          s,
          undefined,
          false,
        ],
        [
          { type: "hotkey", frame_id: "f", keys: ["CMD", "N"] },
          s,
          { via: "menu" },
          true,
        ],
        [
          { type: "hotkey", frame_id: "f", keys: ["CMD", "N"] },
          s,
          { via: "keys" },
          false,
        ],
        [
          { type: "type_text", frame_id: "f", text: "hi" },
          field,
          undefined,
          true,
        ],
        [{ type: "type_text", frame_id: "f", text: "hi" }, s, undefined, false],
        [{ type: "key", frame_id: "f", key: "ENTER" }, field, undefined, true],
        [{ type: "key", frame_id: "f", key: "DOWN" }, s, undefined, false],
        [
          { type: "click", frame_id: "f", x: 0.5, y: 0.5, button: "left" },
          surface({ targetLabel: "Play" }),
          undefined,
          true,
        ],
        [
          { type: "click", frame_id: "f", x: 0.5, y: 0.5, button: "left" },
          s,
          undefined,
          false,
        ],
        [
          {
            type: "double_click",
            frame_id: "f",
            x: 0.5,
            y: 0.5,
            button: "left",
          },
          s,
          undefined,
          false,
        ],
        [
          { type: "scroll", frame_id: "f", delta_x: 0, delta_y: 100 },
          s,
          undefined,
          false,
        ],
        [{ type: "move", frame_id: "f", x: 0.5, y: 0.5 }, s, undefined, false],
        [
          {
            type: "drag",
            frame_id: "f",
            start_x: 0.1,
            start_y: 0.1,
            end_x: 0.5,
            end_y: 0.5,
            duration_ms: 300,
          },
          s,
          undefined,
          false,
        ],
        [{ type: "capture", frame_id: "f" }, s, undefined, false],
      ];
    for (const [action, sf, outcome, expected] of cases)
      expect(actionConfirmed(action, sf, outcome as never), action.type).toBe(
        expected,
      );
  });
  it("writes the note a step carries instead of its screenshot", () => {
    expect(screenshotNote({ send: "none", reason: "unchanged" })).toContain(
      "unchanged since your last step",
    );
    expect(screenshotNote({ send: "none", reason: "described" })).toContain(
      "context.controls and context.visibleText describe",
    );
    for (const use of [
      { send: "full", reason: "first" } as const,
      { send: "reduced", reason: "described" } as const,
    ])
      expect(screenshotNote(use)).toBeUndefined();
    // Both notes tell the model how to get one.
    for (const reason of ["unchanged", "described"] as const)
      expect(screenshotNote({ send: "none", reason })).toContain("capture");
  });
});

describe("the request without or with a reduced screenshot", () => {
  const s = (provider: Settings["provider"]): Settings => ({
    ...defaultSettings,
    provider,
    privacy: provider === "ollama" ? "PRIVATE_LOCAL" : "PRIVATE_BYOM",
    endpoint: {
      openai: "https://api.openai.com",
      anthropic: "https://api.anthropic.com",
      google: "https://generativelanguage.googleapis.com",
      compatible: "https://openrouter.ai/api/v1",
      ollama: "http://127.0.0.1:11434",
    }[provider],
    model: "test",
    inputPrice: 1,
    outputPrice: 2,
  });
  const o: Observation = {
    task: "play something",
    frame: frame(),
    history: [],
  };
  /** The user content parts, and the step JSON, per provider. */
  const parts = (provider: Settings["provider"], body: any) => {
    if (provider === "ollama") {
      const [, step] = body.messages[1].content.split("\n");
      return { images: body.messages[1].images, step: JSON.parse(step) };
    }
    const content: any[] =
      provider === "openai"
        ? body.input[0].content
        : provider === "google"
          ? body.contents[0].parts
          : body.messages[body.messages.length - 1].content;
    const texts = content.filter((p) => typeof p.text === "string");
    return {
      images: content.filter((p) => typeof p.text !== "string"),
      step: JSON.parse(texts[1].text),
    };
  };
  const providers = Object.keys({
    openai: 0,
    anthropic: 0,
    google: 0,
    compatible: 0,
    ollama: 0,
  }) as Settings["provider"][];
  it("sends the PNG at its size when no decision was made or a full one was", () => {
    for (const provider of providers)
      for (const screenshot of [
        undefined,
        { send: "full", reason: "first" } as const,
      ]) {
        const r = buildRequest(s(provider), "K", { ...o, screenshot });
        const { images, step } = parts(provider, r.body);
        expect(JSON.stringify(images)).toContain("YWJj");
        expect(JSON.stringify(images)).not.toContain("anBn");
        expect(step.image_width_px).toBe(1440);
        expect(step.image_height_px).toBe(900);
        expect(step.screenshot).toBeUndefined();
      }
  });
  it("sends the helper's reduced rendition and its size for a reduced look", () => {
    for (const provider of providers) {
      const r = buildRequest(s(provider), "K", {
        ...o,
        screenshot: { send: "reduced", reason: "described" },
      });
      const { images, step } = parts(provider, r.body);
      expect(JSON.stringify(images)).toContain("anBn");
      expect(JSON.stringify(images)).not.toContain("YWJj");
      if (provider === "anthropic")
        expect(images[0].source.media_type).toBe("image/jpeg");
      expect(step.image_width_px).toBe(1024);
      expect(step.image_height_px).toBe(640);
    }
    // Without a rendition (a synthetic frame), the PNG goes at its size.
    const r = buildRequest(s("anthropic"), "K", {
      ...o,
      frame: frame({ preview: undefined }),
      screenshot: { send: "reduced", reason: "described" },
    });
    const { images, step } = parts("anthropic", r.body);
    expect(images[0].source.data).toBe("YWJj");
    expect(step.image_width_px).toBe(1440);
  });
  it("sends no image and one note when the screenshot is left out", () => {
    for (const provider of providers) {
      const r = buildRequest(s(provider), "K", {
        ...o,
        screenshot: { send: "none", reason: "unchanged" },
      });
      const { images, step } = parts(provider, r.body);
      expect(images ?? []).toEqual([]);
      expect(JSON.stringify(r.body)).not.toContain("YWJj");
      expect(JSON.stringify(r.body)).not.toContain("anBn");
      expect(step.screenshot).toContain("No screenshot");
      expect(step.screenshot).toContain("capture");
      // The frame's own size stays, so control fractions keep their meaning.
      expect(step.image_width_px).toBe(1440);
    }
    // The instruction tells the model what the note means.
    const instruction = buildRequest(s("openai"), "K", o).body.instructions;
    expect(instruction).toContain("The screenshot is left out when");
    expect(instruction).toContain("call capture only when you need to see");
  });
});

/* ------------------------------------------------- the runner's decisions */

const settings: Settings = structuredClone(defaultSettings);
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
type Screen = { sha: string; context: ScreenContext; targetLabel?: string };
let captures = 0;
function controller(screen: Screen) {
  const c: Controller = {
    kind: "native",
    surface: async (action?: Action) => ({
      appId: "com.spotify.client",
      pid: 7,
      secureInput: false,
      unknown: false,
      ...(action && screen.targetLabel && { targetLabel: screen.targetLabel }),
    }),
    capture: async (): Promise<Frame> =>
      frame({
        id: `frame-${++captures}`,
        sha256: screen.sha,
        context: structuredClone(screen.context),
      }),
    execute: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    stop: vi.fn(() => {}),
  };
  return c;
}
function scripted(
  replies: ((o: Observation) => Partial<ProviderResult>)[],
  usage: Usage = { inputTokens: 0, outputTokens: 0, cost: 0 },
) {
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
  policy.evaluate = () => ({ kind: "ALLOW", reason: "Test." });
};
const named = act({ type: "click_control", label: "Control 1" });
const blind = act({ type: "click", x: 0.5, y: 0.5 });
const look = act({ type: "capture" });
const uses = (p: ReturnType<typeof scripted>) =>
  p.observations.map((o) => `${o.screenshot!.send}:${o.screenshot!.reason}`);

describe("runner screenshot decisions", () => {
  it("sends the first screenshot, none while the screen stays the same, and one at least every fourth step", async () => {
    allowAll();
    const m = memory();
    const c = controller({ sha: "same", context: described });
    const p = scripted([named, named, named, named, named]);
    await new Runner(c, p, m.recorder, settings, () => {}).start("play");
    expect(uses(p)).toEqual([
      "full:first",
      "none:unchanged",
      "none:unchanged",
      "none:unchanged",
      "full:cadence",
      "none:unchanged",
    ]);
    // The decision is journaled as codes, so the token report can read it.
    expect(m.of("ModelRequestStarted").map((e) => e.data)).toEqual(
      uses(p).map((use) => {
        const [screenshot, screenshotReason] = use.split(":");
        return { screenshot, screenshotReason };
      }),
    );
    // No history entry ever carries an image.
    expect(JSON.stringify(p.observations.at(-1)!.history)).not.toContain(
      "data:image",
    );
  });
  it("sends a full screenshot after a step native input could not verify, and after capture", async () => {
    allowAll();
    const m = memory();
    const c = controller({ sha: "same", context: described });
    const p = scripted([blind, named, look, named]);
    await new Runner(c, p, m.recorder, settings, () => {}).start("play");
    expect(uses(p)).toEqual([
      "full:first",
      "full:unconfirmed",
      "none:unchanged",
      "full:requested",
      "none:unchanged",
    ]);
    // The same blind click on an identified control is verified.
    const seen = controller({
      sha: "same",
      context: described,
      targetLabel: "Control 1",
    });
    const q = scripted([blind, named]);
    await new Runner(seen, q, memory().recorder, settings, () => {}).start(
      "play",
    );
    expect(uses(q)).toEqual(["full:first", "none:unchanged", "none:unchanged"]);
  });
  it("reduces a described screen that changed, and leaves it out in text-first", async () => {
    for (const [mode, expected] of [
      ["auto", "reduced:described"],
      ["text-first", "none:described"],
      ["always", "full:always"],
    ] as const) {
      allowAll();
      const screen: Screen = { sha: "s0", context: described };
      const c = controller(screen);
      let step = 0;
      vi.mocked(c.execute).mockImplementation(async () => {
        screen.sha = `s${++step}`;
      });
      const p = scripted([named, named]);
      await new Runner(
        c,
        p,
        memory().recorder,
        { ...settings, visionMode: mode },
        () => {},
      ).start("play");
      expect(uses(p), mode).toEqual([
        mode === "always" ? "full:always" : "full:first",
        expected,
        expected,
      ]);
    }
  });
  it("never drops the screenshot on a blind surface or an OCR frame", async () => {
    for (const context of [
      { ...described, accessibility: "none" as const },
      { ...described, screenText: "read off the screenshot" },
    ]) {
      allowAll();
      const c = controller({ sha: "same", context });
      const p = scripted([named, named]);
      await new Runner(c, p, memory().recorder, settings, () => {}).start(
        "play",
      );
      expect(uses(p).every((use) => use.startsWith("full:"))).toBe(true);
    }
  });
  it("adds the provider's cached token count to the run", async () => {
    allowAll();
    const m = memory();
    const c = controller({ sha: "same", context: described });
    const p = scripted([named, named], {
      inputTokens: 1000,
      outputTokens: 20,
      cachedInputTokens: 700,
      cost: 0.001,
    });
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    await runner.start("play");
    expect(runner.snapshot.run?.usage).toMatchObject({
      inputTokens: 3000,
      cachedInputTokens: 2100,
      outputTokens: 60,
    });
    // A provider that reports no cache leaves the run without the field.
    const q = scripted([named]);
    const plain = new Runner(
      controller({ sha: "same", context: described }),
      q,
      memory().recorder,
      settings,
      () => {},
    );
    await plain.start("play");
    expect(plain.snapshot.run?.usage).not.toHaveProperty("cachedInputTokens");
  });
});
