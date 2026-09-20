/**
 * A run started with the fast actions taken while the user spoke
 * (StartOptions.streamed; src/core/streamed.ts): the steps are journaled as
 * their own content-free entry kind and as flagged executed rows, the
 * model's first observation opens with the prelude on a fresh frame, a
 * dropped clause is named done by mistake, nothing counts as a model
 * action (amendTask still accepts a longer task), and the model's own
 * open_url after the final runs through the controller like any step.
 */
import { describe, expect, it, vi } from "vitest";
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
  type Surface,
} from "../src/core/schema";
import {
  Runner,
  STREAMED_FRAME_ID,
  echoAction,
  modelHistory,
  streamedAction,
  type StreamedStep,
} from "../src/core/runner";
import {
  describeStreamed,
  searchTerms,
  siteName,
  streamedPillLabel,
  streamedPrelude,
  streamedStepSchema,
  streamedSummary,
  urlLabel,
} from "../src/core/streamed";
import { stepLine } from "../src/assistant/steps";

const SAFARI = "com.apple.Safari";
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
  let run: Run | undefined;
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
const frameOf = (id: string, appId: string): Frame => ({
  id,
  sha256: `sha-${id}`,
  image: "",
  geometry,
  capturedAt: 0,
  synthetic: false,
  appId,
  context: { appName: "Safari", windowTitle: "YouTube" },
});
/** The desktop the run sees after the fast actions: the browser in front. */
function desktop(
  front = SAFARI,
  // The page the prelude sent for is up at the first look unless a case
  // says otherwise: its address and a control on it.
  screen: (capture: number) => Partial<Frame> = () => ({
    context: {
      appName: "Safari",
      windowTitle: "YouTube",
      browserAddress: "https://www.youtube.com/results?search_query=q",
      controls: [{ role: "AXLink", label: "First", x: 0.5, y: 0.5 }],
    },
  }),
) {
  const calls: string[] = [];
  const executed: Action[] = [];
  let captures = 0;
  const controller: Controller = {
    kind: "native",
    surface: vi.fn(async (action?: Action) => {
      calls.push(action ? `surface(${action.type})` : "surface()");
      return {
        appId: front,
        pid: 1,
        secureInput: false,
        unknown: false,
        domain: "www.youtube.com",
      } as Surface;
    }),
    capture: vi.fn(async () => {
      calls.push("capture");
      const n = ++captures;
      return { ...frameOf(`run-frame-${n}`, front), ...screen(n) };
    }),
    execute: vi.fn(async (a: Action): Promise<void | ExecutionResult> => {
      calls.push(`execute(${a.type})`);
      executed.push(a);
      if (a.type === "open_url")
        return {
          navigated: {
            host: new URL(a.url).hostname,
            appId: SAFARI,
            via: "script",
          },
        };
    }),
    resume: vi.fn(async () => {
      calls.push("resume");
    }),
    stop: vi.fn(() => {
      calls.push("stop");
    }),
  };
  return { controller, calls, executed };
}
function scripted(
  replies: ((o: Observation) => Partial<ProviderResult>)[] = [],
) {
  const observations: Observation[] = [];
  const next = vi.fn(async (o: Observation) => {
    observations.push(structuredClone(o));
    const reply = replies[observations.length - 1];
    return {
      usage,
      ...(reply
        ? reply(o)
        : { action: { type: "done", summary: "Done", frame_id: o.frame.id } }),
    } as ProviderResult;
  });
  return { next, observations };
}
const HOME: StreamedStep = {
  clauseIndex: 0,
  action: {
    kind: "open_url",
    url: "https://www.youtube.com/",
    siteKey: "youtube",
    label: "YouTube",
  },
  atMs: 620,
  outcome: "done",
};
const RESULTS: StreamedStep = {
  clauseIndex: 1,
  action: {
    kind: "open_url",
    url: "https://www.youtube.com/results?search_query=midwest+safety",
    siteKey: "youtube",
    label: "YouTube search for midwest safety",
  },
  atMs: 1950,
  outcome: "done",
};
const SLACK: StreamedStep = {
  clauseIndex: 1,
  action: { kind: "open_app", name: "Slack" },
  atMs: 900,
  outcome: "done",
};
const OWNER = "go to youtube and play a midwest safety video";
type BuildOptions = {
  front?: string;
  replies?: ((o: Observation) => Partial<ProviderResult>)[];
  /** What each capture shows beyond the bare frame (the page's address, its controls). */
  screen?: (capture: number) => Partial<Frame>;
};
function build(o: BuildOptions = {}) {
  const j = journal();
  const desk = desktop(o.front, o.screen);
  const provider = scripted(o.replies);
  const runner = new Runner(
    desk.controller,
    { next: provider.next },
    j.recorder,
    { ...settings, memory: false },
    () => {},
    [],
    undefined,
    // The prelude's last page is waited for before the first capture; the
    // wait is shortened here and measured in its own case below.
    { transitionSettleMs: 10 },
  );
  return { ...j, ...desk, provider, runner };
}
async function run(
  task: string,
  streamed: StreamedStep[] | undefined,
  o: BuildOptions = {},
) {
  const r = build(o);
  await r.runner.start(task, {
    origin: "voice",
    taskSource: "user_words",
    ...(streamed ? { streamed } : {}),
  });
  await until(() => r.runner.settled);
  return r;
}

describe("a run started with streamed steps", () => {
  it("opens the model's first observation with the prelude on a fresh frame, and journals each step as its own kind and as a flagged executed row", async () => {
    const r = await run(OWNER, [HOME, RESULTS]);
    // The frame is the run's own capture: the screen as the actions left it.
    expect(r.calls.slice(0, 3)).toEqual(["resume", "surface()", "capture"]);
    const first = r.provider.observations[0];
    expect(first.frame.id).toBe("run-frame-1");
    expect(first.history).toEqual([
      {
        type: "streamed",
        result:
          "Already done while you spoke: YouTube is loading; YouTube search for midwest safety is loading. Continue from this screen; do not repeat these.",
      },
    ]);
    expect(first.task).toBe(OWNER);
    // Content-free entries: the kind, the site code, the clause, the outcome.
    expect(r.of("StreamedStep").map((e) => e.data)).toEqual([
      { kind: "open_url", siteKey: "youtube", clauseIndex: 0, outcome: "done" },
      { kind: "open_url", siteKey: "youtube", clauseIndex: 1, outcome: "done" },
    ]);
    // And the executed rows every reader of steps sees, flagged.
    expect(r.of("ActionExecuted").map((e) => e.data)).toEqual([
      {
        action: {
          type: "open_url",
          url: HOME.action.kind === "open_url" ? HOME.action.url : "",
          siteKey: "youtube",
          frame_id: STREAMED_FRAME_ID,
        },
        streamed: true,
        early: true,
        clauseIndex: 0,
        outcome: "done",
      },
      {
        action: {
          type: "open_url",
          url: "https://www.youtube.com/results?search_query=midwest+safety",
          siteKey: "youtube",
          frame_id: STREAMED_FRAME_ID,
        },
        streamed: true,
        early: true,
        clauseIndex: 1,
        outcome: "done",
      },
    ]);
    const types = r.events.map((e) => e.type);
    expect(types.slice(0, 5)).toEqual([
      "RunStarted",
      "StreamedStep",
      "ActionExecuted",
      "StreamedStep",
      "ActionExecuted",
    ]);
    // Not model actions: nothing counted, nothing executed again.
    expect(r.getRun().actions).toBe(0);
    expect(r.runner.actionsAttempted).toBe(0);
    expect(r.executed).toEqual([]);
    expect(r.getRun().status).toBe("completed");
  });
  it("waits for the prelude's last page before the first frame: one settle when the page is up, a second look when it is not yet, none without an open_url", async () => {
    // The browser answered the route at once while the page was still on
    // its way (live: the run's first click failed CONTROLS_CHANGED on a page
    // still loading). The page up at the first look: one wait, one capture.
    const loaded = (n: number): Partial<Frame> => ({
      context: {
        appName: "Safari",
        windowTitle: "YouTube",
        browserAddress: `https://www.youtube.com/results?search_query=q&n=${n}`,
        controls: [{ role: "AXLink", label: "First", x: 0.5, y: 0.5 }],
      },
    });
    const up = await run(OWNER, [HOME, RESULTS], { screen: loaded });
    expect(up.of("TransitionSettled").map((e) => e.data)).toEqual([
      { kind: "navigated" },
    ]);
    expect(up.provider.observations[0].frame.id).toBe("run-frame-1");
    expect(up.calls.filter((c) => c === "capture")).toHaveLength(1);
    // Not yet (no controls on the first look, or another host): one more
    // wait and one more look; the model's first frame is the second.
    const late = await run(OWNER, [HOME, RESULTS], {
      screen: (n) =>
        n === 1
          ? {
              context: {
                appName: "Safari",
                windowTitle: "",
                browserAddress: "https://www.youtube.com/",
                controls: [],
              },
            }
          : loaded(n),
    });
    expect(late.of("TransitionSettled").map((e) => e.data)).toEqual([
      { kind: "navigated" },
      { kind: "navigated" },
    ]);
    expect(late.provider.observations[0].frame.id).toBe("run-frame-2");
    expect(late.provider.observations[0].history[0]).toMatchObject({
      type: "streamed",
    });
    // Two looks at most: a page that never shows goes to the model as it is.
    const never = await run(OWNER, [HOME], {
      screen: () => ({ context: { appName: "Finder", windowTitle: "" } }),
    });
    expect(never.of("TransitionSettled")).toHaveLength(2);
    expect(never.provider.observations[0].frame.id).toBe("run-frame-2");
    // An open_app alone, or a failed open_url, sent for no page.
    const app = await run("open slack and scroll", [SLACK]);
    expect(app.of("TransitionSettled")).toEqual([]);
    const failed = await run(OWNER, [{ ...HOME, outcome: "failed" }]);
    expect(failed.of("TransitionSettled")).toEqual([]);
    // The wait is the runner's settle: measured against a short one.
    const t0 = performance.now();
    const timed = build({ screen: loaded });
    await timed.runner.start(OWNER, {
      origin: "voice",
      taskSource: "user_words",
      streamed: [HOME],
    });
    await until(() => timed.runner.settled);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(10);
    expect(timed.of("TransitionSettled")).toHaveLength(1);
  });
  it("names a dropped clause as done by mistake and leaves a failed step unnamed and without a row", async () => {
    const r = await run("play a midwest safety video", [
      { ...HOME, outcome: "dropped" },
      { ...RESULTS, outcome: "failed" },
      { ...SLACK, clauseIndex: 2, outcome: "done" },
    ]);
    expect(r.provider.observations[0].history[0].result).toBe(
      "Already done while you spoke: opened Slack. Continue from this screen; do not repeat these. Done by mistake (the sentence changed): YouTube is loading; put it right if it matters.",
    );
    expect(r.of("StreamedStep").map((e) => e.data.outcome)).toEqual([
      "dropped",
      "failed",
      "done",
    ]);
    expect(r.of("ActionExecuted").map((e) => e.data.action)).toEqual([
      {
        type: "open_url",
        url: "https://www.youtube.com/",
        siteKey: "youtube",
        frame_id: STREAMED_FRAME_ID,
      },
      { type: "open_app", name: "Slack", frame_id: STREAMED_FRAME_ID },
    ]);
  });
  it("puts nothing in front of the model when every step failed, and nothing at all without steps or on the tutorial", async () => {
    const failed = await run(OWNER, [{ ...HOME, outcome: "failed" }]);
    expect(failed.provider.observations[0].history).toEqual([]);
    expect(failed.of("StreamedStep")).toHaveLength(1);
    expect(failed.of("ActionExecuted")).toHaveLength(0);
    const none = await run(OWNER, []);
    expect(none.of("StreamedStep")).toHaveLength(0);
    expect(none.provider.observations[0].history).toEqual([]);
  });
  it("still accepts a longer task after streamed steps alone, and refuses once a model action ran", async () => {
    const r = build({
      replies: [
        (o) => ({
          action: { type: "wait", milliseconds: 0, frame_id: o.frame.id },
        }),
        (o) => ({
          action: { type: "wait", milliseconds: 0, frame_id: o.frame.id },
        }),
        (o) => ({
          action: { type: "done", summary: "Done", frame_id: o.frame.id },
        }),
      ],
    });
    // Hold the first model call so the task can grow before any action.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = r.provider.next.getMockImplementation()!;
    r.provider.next.mockImplementationOnce(async (o: Observation) => {
      await gate;
      return original(o);
    });
    const started = r.runner.start("go to youtube", {
      origin: "voice",
      taskSource: "user_words",
      streamed: [HOME],
    });
    await until(() => r.provider.next.mock.calls.length === 1);
    await r.runner.amendTask(OWNER);
    expect(r.of("TaskAmended").map((e) => e.data)).toEqual([
      { taskLength: OWNER.length },
    ]);
    release();
    await started;
    await until(() => r.runner.settled);
    expect(r.getRun().task).toBe(OWNER);
    expect(r.getRun().status).toBe("completed");
    // The prelude stays in front of the amended task's first request.
    const afterAmend = r.provider.observations.find((o) => o.task === OWNER)!;
    expect(afterAmend.history[0]).toMatchObject({ type: "streamed" });
    // Once a model action executed, the rule is the old one.
    await expect(r.runner.amendTask("something else")).rejects.toThrow(
      /No active run|already acted/,
    );
  });
  it("runs the model's own open_url after the final through the controller and tells it what loaded", async () => {
    const r = await run(OWNER, [HOME], {
      replies: [
        (o) => ({
          action: {
            type: "open_url",
            url: "https://www.youtube.com/results?search_query=midwest+safety",
            siteKey: "youtube",
            frame_id: o.frame.id,
          },
        }),
        (o) => ({
          action: { type: "done", summary: "Done", frame_id: o.frame.id },
        }),
      ],
    });
    expect(r.executed).toEqual([
      {
        type: "open_url",
        url: "https://www.youtube.com/results?search_query=midwest+safety",
        siteKey: "youtube",
        frame_id: "run-frame-1",
      },
    ]);
    const second = r.provider.observations[1];
    expect(second.history.at(-1)).toEqual({
      type: "open_url",
      action: {
        type: "open_url",
        url: "https://www.youtube.com/results?search_query=midwest+safety",
        siteKey: "youtube",
      },
      result:
        "Loading www.youtube.com in com.apple.Safari. Wait briefly if the page is not there yet, and verify the next screenshot.",
    });
    expect(r.of("PolicyAllowed").map((e) => e.data.reason)).toEqual([
      "Load a web address in the browser.",
    ]);
    expect(r.getRun().actions).toBe(1);
  });
  it("refuses the model's open_url of a protected host and tells it why", async () => {
    const r = await run("pay the bill", undefined, {
      replies: [
        (o) => ({
          action: {
            type: "open_url",
            url: "https://www.paypal.com/",
            frame_id: o.frame.id,
          },
        }),
        (o) => ({
          action: { type: "done", summary: "Done", frame_id: o.frame.id },
        }),
      ],
    });
    expect(r.executed).toEqual([]);
    const second = r.provider.observations[1];
    // A refusal keeps the step's own type; the echo names the host, never the path.
    expect(second.history.at(-1)).toMatchObject({
      type: "open_url",
      action: { type: "open_url", host: "www.paypal.com" },
    });
    expect(second.history.at(-1)!.result).toContain(
      "That website is protected",
    );
  });
});

describe("the streamed step's words", () => {
  it("describes each kind for the model, the pill and the idle card", () => {
    expect(describeStreamed(HOME.action)).toBe("YouTube is loading");
    expect(describeStreamed(RESULTS.action)).toBe(
      "YouTube search for midwest safety is loading",
    );
    expect(describeStreamed(SLACK.action)).toBe("opened Slack");
    expect(describeStreamed({ kind: "scroll", direction: "up" })).toBe(
      "scrolled up",
    );
    expect(streamedPillLabel(HOME.action)).toBe("Opening YouTube…");
    expect(streamedPillLabel(RESULTS.action)).toBe(
      "Searching YouTube for midwest safety…",
    );
    expect(streamedPillLabel(SLACK.action)).toBe("Opening Slack…");
    expect(streamedPillLabel({ kind: "scroll", direction: "down" })).toBe(
      "Scrolling down…",
    );
    expect(streamedSummary([HOME, RESULTS])).toBe(
      "Searched YouTube for midwest safety.",
    );
    expect(streamedSummary([HOME])).toBe("Opened YouTube.");
    expect(streamedSummary([{ ...HOME, outcome: "failed" }])).toBeUndefined();
    expect(streamedPrelude([])).toBeUndefined();
  });
  it("names an address by the recipe's label first, else by the site and the search read from the address", () => {
    const at = (url: string, siteKey: string, label: string) =>
      ({ kind: "open_url", url, siteKey, label }) as const;
    expect(
      urlLabel(
        at(
          "https://www.youtube.com/results?search_query=x",
          "youtube",
          "YouTube search for x",
        ),
      ),
    ).toBe("YouTube search for x");
    expect(
      urlLabel(
        at(
          "https://www.youtube.com/results?search_query=weather+in+austin",
          "youtube",
          "",
        ),
      ),
    ).toBe("YouTube search for weather in austin");
    expect(urlLabel(at("https://www.youtube.com/", "youtube", ""))).toBe(
      "YouTube",
    );
    expect(urlLabel(at("https://www.example.org/", "custom", ""))).toBe(
      "example.org",
    );
    expect(
      streamedPillLabel(
        at(
          "https://maps.google.com/maps?q=cafes",
          "google_maps",
          "Google Maps search for cafes",
        ),
      ),
    ).toBe("Searching Google Maps for cafes…");
    expect(
      streamedPillLabel(at("https://mail.google.com/", "gmail", "Gmail")),
    ).toBe("Opening Gmail…");
  });
  it("names sites by their key, then by the label, then by the host, and reads the search from the recipes' parameters", () => {
    expect(
      siteName({
        kind: "open_url",
        url: "https://mail.google.com/",
        siteKey: "gmail",
        label: "",
      }),
    ).toBe("Gmail");
    expect(
      siteName({
        kind: "open_url",
        url: "https://maps.google.com/",
        siteKey: "google_maps",
        label: "",
      }),
    ).toBe("Google Maps");
    expect(
      siteName({
        kind: "open_url",
        url: "https://example.org/",
        siteKey: "custom",
        label: "Example",
      }),
    ).toBe("Example");
    expect(
      siteName({
        kind: "open_url",
        url: "https://www.example.org/",
        siteKey: "custom",
        label: "",
      }),
    ).toBe("example.org");
    expect(
      searchTerms("https://www.google.com/search?q=weather+in+austin"),
    ).toBe("weather in austin");
    expect(searchTerms("https://www.amazon.com/s?k=usb+c+cable")).toBe(
      "usb c cable",
    );
    expect(
      searchTerms("https://mail.google.com/mail/u/0/#search/rent%20receipt"),
    ).toBe("rent receipt");
    expect(searchTerms("https://www.youtube.com/")).toBeUndefined();
    expect(searchTerms("not a url")).toBeUndefined();
  });
  it("validates the steps a start receives and shapes their executed rows", () => {
    expect(streamedStepSchema.parse(HOME)).toEqual(HOME);
    expect(() =>
      streamedStepSchema.parse({ ...HOME, outcome: "maybe" }),
    ).toThrow();
    expect(() =>
      streamedStepSchema.parse({
        ...HOME,
        action: { kind: "click", x: 1, y: 1 },
      }),
    ).toThrow();
    expect(streamedAction(HOME)).toEqual({
      type: "open_url",
      url: "https://www.youtube.com/",
      siteKey: "youtube",
      frame_id: STREAMED_FRAME_ID,
    });
    expect(
      streamedAction({ ...SLACK, action: { kind: "scroll", direction: "up" } }),
    ).toEqual({
      type: "scroll",
      delta_x: 0,
      delta_y: -300,
      frame_id: STREAMED_FRAME_ID,
    });
    // A URL the schema refuses (no scheme) makes no row.
    expect(
      streamedAction({
        ...HOME,
        action: { ...HOME.action, url: "youtube.com" } as never,
      }),
    ).toBeUndefined();
    // Its step line names the host alone, never the search.
    expect(stepLine(streamedAction(RESULTS)!)).toBe("opened youtube.com");
  });
  it("echoes a rejected open_url by site code and host, never the query, and compacts the prelude like any entry", () => {
    expect(
      echoAction({
        type: "open_url",
        url: "https://www.youtube.com/results?search_query=secret+thing",
        siteKey: "youtube",
        frame_id: "f",
      }),
    ).toEqual({
      type: "open_url",
      siteKey: "youtube",
      host: "www.youtube.com",
    });
    const compacted = modelHistory([
      {
        type: "streamed",
        result: "Already done while you spoke: YouTube is loading.",
      },
      ...Array.from({ length: 7 }, (_, i) => ({
        type: "wait",
        action: { type: "wait", milliseconds: i },
        result: "Executed.",
      })),
    ]);
    expect(compacted[0].type).toBe("earlier_steps");
    expect(compacted[0].result).toContain("streamed");
  });
});
