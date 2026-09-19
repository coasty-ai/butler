/**
 * Acting on each clause while the user speaks (electron/streaming.ts;
 * .data/design/streaming-execution.md §3.3), driven with a fake controller,
 * a fake clause stream and a fake decider: the owner's sentence loads
 * YouTube then its results through the browser route, each fast action
 * passes the policy with speaking: true, the final hands the steps to the
 * run (or leaves them when it starts none), a clause the recognizer
 * rewrote or the final dropped is named done by mistake, and nothing the
 * policy refuses (a protected host, even under "all") ever runs.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
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
  StreamingTurn,
  jevClientFor,
  type StreamController,
  type StreamingDeps,
} from "../electron/streaming";
import type {
  Clause,
  ClauseEvent,
  ClauseStream,
  PartialSample,
} from "../src/voice/stream";
import type { FastAction, FastContext, JevClient } from "../src/voice/fast";
import { streamedPrelude } from "../src/core/streamed";
import type { PolicyContext } from "../src/core/policy";

// Every evaluate() call is recorded with its context, so a test reads that
// each fast action was judged while speaking; the real policy decides.
const seen = vi.hoisted(() => ({
  calls: [] as { type: string; context: PolicyContext | undefined }[],
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
      context?: PolicyContext,
    ) => {
      seen.calls.push({ type: a.type, context });
      return actual.evaluate(a, s, st, synthetic, context);
    },
  };
});
afterEach(() => {
  seen.calls.length = 0;
});

const VSCODE = "com.microsoft.VSCode";
const SAFARI = "com.apple.Safari";
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
const ticks = async (n = 16) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};
const YOUTUBE: FastAction = {
  kind: "open_url",
  url: "https://www.youtube.com/",
  siteKey: "youtube",
  label: "YouTube",
};
const RESULTS: FastAction = {
  kind: "open_url",
  url: "https://www.youtube.com/results?search_query=midwest+safety",
  siteKey: "youtube",
  label: "YouTube search for midwest safety",
};
const jevClient = (): JevClient => ({ ask: vi.fn(async () => undefined) });
const clause = (
  index: number,
  text: string,
  committedAtMs?: number,
): Clause => ({
  index,
  text,
  startWord: 0,
  endWord: text.split(" ").length,
  state: "committed",
  ...(committedAtMs !== undefined ? { committedAtMs } : {}),
});
const committed = (
  c: Clause,
  by: "boundary" | "stable" = "boundary",
): ClauseEvent => ({ kind: "committed", clause: c, by });

/** A stream whose events per push and per final the test scripts. */
function fakeStream() {
  const queue: ClauseEvent[][] = [];
  const pushed: PartialSample[] = [];
  const finals: { text: string; atMs: number }[] = [];
  let atFinal: ClauseEvent[] = [{ kind: "final", clauses: [], dropped: [] }];
  const stream: ClauseStream = {
    push: (sample) => {
      pushed.push(sample);
      return queue.shift() ?? [];
    },
    final: (text, atMs) => {
      finals.push({ text, atMs });
      return atFinal;
    },
    clauses: () => [],
  };
  return {
    stream,
    pushed,
    finals,
    /** The events the next push answers with. */
    next: (...events: ClauseEvent[]) => queue.push(events),
    dropAtFinal: (...dropped: Clause[]) => {
      atFinal = [{ kind: "final", clauses: [], dropped }];
    },
  };
}
type DeskOptions = {
  front?: Partial<Surface>;
  launcher?: Partial<Surface>;
  openUrl?: (a: Extract<Action, { type: "open_url" }>) => Promise<void>;
};
/** A desktop whose every call is logged in order. */
function desktop(o: DeskOptions = {}) {
  const calls: string[] = [];
  const executed: Action[] = [];
  const opened: string[] = [];
  let frames = 0;
  const base = (): Surface => ({
    appId: VSCODE,
    pid: 7,
    secureInput: false,
    unknown: false,
    ...o.front,
  });
  const controller: StreamController = {
    configure: vi.fn(async () => {
      calls.push("configure");
    }),
    surface: vi.fn(async (action?: Action) => {
      if (!action) {
        calls.push("surface()");
        return base();
      }
      calls.push(`surface(${action.type})`);
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
      return {
        id: `frame-${++frames}`,
        sha256: "sha",
        image: "data:image/png;base64,AAAA",
        geometry,
        capturedAt: 0,
        synthetic: false,
        appId: base().appId,
      };
    }),
    execute: vi.fn(async (a: Action): Promise<void | ExecutionResult> => {
      calls.push(`execute(${a.type})`);
      executed.push(a);
      return {
        launched: {
          appId: SLACK,
          name: "Slack",
          frontmost: true,
          wasRunning: true,
          windows: 1,
        },
      };
    }),
    openUrl: vi.fn(async (a) => {
      calls.push("openUrl");
      opened.push(a.url);
      if (o.openUrl) await o.openUrl(a);
      return {
        navigated: {
          host: new URL(a.url).hostname,
          appId: SAFARI,
          via: "open",
        },
      } as ExecutionResult;
    }),
    resume: vi.fn(async () => {
      calls.push("resume");
    }),
    stop: vi.fn(() => {
      calls.push("stop");
    }),
    request: vi.fn(async () => ({})),
  };
  return { controller, calls, executed, opened };
}
function setup(
  o: DeskOptions & {
    settings?: Partial<Settings>;
    blocked?: StreamingDeps["blocked"];
    decide?: Record<string, FastAction>;
    withJev?: (
      c: Clause,
      ctx: FastContext,
      jev: JevClient,
      signal?: AbortSignal,
    ) => Promise<FastAction>;
    jev?: JevClient;
    noController?: boolean;
  } = {},
) {
  const desk = desktop(o);
  const s = fakeStream();
  const traces: { event: string; data: Record<string, unknown> }[] = [];
  const labels: string[] = [];
  const left: string[] = [];
  const scrolls: string[] = [];
  const sections: string[] = [];
  let t = 0;
  const table = o.decide ?? {};
  const fast = vi.fn(
    (c: Clause, _ctx: FastContext): FastAction =>
      table[c.text] ?? { kind: "none", reason: "not_navigational" },
  );
  const withJev = vi.fn<
    (
      c: Clause,
      ctx: FastContext,
      jev: JevClient,
      signal?: AbortSignal,
    ) => Promise<FastAction>
  >(
    o.withJev ??
      (async (): Promise<FastAction> => ({ kind: "none", reason: "unsure" })),
  );
  const settings = { ...defaultSettings, earlyStart: true, ...o.settings };
  // A manual clock: the re-push timer fires only when advanced past.
  const timers = new Map<number, { at: number; fn: () => void }>();
  let timerId = 0;
  const turn = new StreamingTurn({
    controller: () => (o.noController ? undefined : desk.controller),
    settings: () => settings,
    blocked: o.blocked ?? (() => undefined),
    browser: () => "Safari",
    early: {
      section: async (fn) => {
        sections.push("open");
        try {
          return await fn();
        } finally {
          sections.push("close");
        }
      },
      engaged: () => false,
    },
    scroll: vi.fn(async (direction) => {
      scrolls.push(direction);
    }),
    jev: () => o.jev,
    onAction: (label) => labels.push(label),
    onLeft: (summary) => left.push(summary),
    trace: (event, data = {}) => traces.push({ event, data }),
    stream: () => s.stream,
    decide: { fast, withJev },
    now: () => t,
    setTimer: (fn, ms) => {
      timers.set(++timerId, { at: t + ms, fn });
      return timerId;
    },
    clearTimer: (id) => void timers.delete(id as number),
  });
  let invocation = 0;
  const of = (event: string) =>
    traces.filter((x) => x.event === event).map((x) => x.data);
  return {
    ...desk,
    ...s,
    turn,
    traces,
    labels,
    left,
    scrolls,
    sections,
    fast,
    withJev,
    of,
    at: (ms: number) => {
      t = ms;
    },
    timers,
    /** Advances the clock, firing due timers in order. */
    to: async (ms: number) => {
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, v]) => v.at <= ms)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = Math.max(t, due[1].at);
        due[1].fn();
        await ticks();
        await turn.idle();
      }
      t = Math.max(t, ms);
    },
    begin: () => turn.begin(++invocation, Promise.resolve()),
    /** A partial at a time, then the queued clause work runs. */
    say: async (text: string, ms: number) => {
      t = ms;
      turn.partial(invocation, text, ms);
      await ticks();
      await turn.idle();
    },
    finish: (text: string, ms: number) => {
      t = ms;
      return turn.finish(invocation, text);
    },
    get invocation() {
      return invocation;
    },
  };
}
const OWNER = "go to youtube and play a midwest safety video";
const c0 = clause(0, "go to youtube", 600);
const c1 = clause(1, "play a midwest safety video", 1900);
const speaking = () => seen.calls.filter((c) => c.context?.speaking);

describe("streaming execution: the owner's sentence", () => {
  it("loads YouTube on the first clause and its results on the second, through the browser route, each judged while speaking", async () => {
    const t = setup({
      decide: { [c0.text]: YOUTUBE, [c1.text]: RESULTS },
    });
    t.begin();
    t.next(committed(c0, "boundary"));
    await t.say("go to youtube and", 620);
    expect(t.opened).toEqual(["https://www.youtube.com/"]);
    // The front surface is read once for the clause (the context and the
    // policy's surface); the helper never executes and the latch stays.
    expect(t.calls).toEqual(["configure", "surface()", "openUrl"]);
    expect(t.labels).toEqual(["Opening YouTube…"]);
    t.next(committed(c1, "stable"));
    await t.say(OWNER, 1950);
    expect(t.opened).toEqual([
      "https://www.youtube.com/",
      "https://www.youtube.com/results?search_query=midwest+safety",
    ]);
    // The recipe's own label, with the pill's verb.
    expect(t.labels[1]).toBe("Searching YouTube for midwest safety…");
    expect(speaking().map((c) => c.type)).toEqual(["open_url", "open_url"]);
    expect(seen.calls.every((c) => c.context?.speaking === true)).toBe(true);
    // The decider saw the front application and the browser, then the host
    // and browser the first clause sent the page to.
    expect(t.fast.mock.calls[0][1]).toEqual({
      frontAppId: VSCODE,
      browser: "Safari",
      protectedHosts: defaultSettings.protectedDomains,
    });
    expect(t.fast.mock.calls[1][1]).toEqual({
      frontAppId: SAFARI,
      frontHost: "www.youtube.com",
      browser: "Safari",
      protectedHosts: defaultSettings.protectedDomains,
    });
    expect(t.of("StreamedAction")).toEqual([
      {
        kind: "open_url",
        siteKey: "youtube",
        clauseIndex: 0,
        decideMs: 0,
        issueMs: 20,
      },
      {
        kind: "open_url",
        siteKey: "youtube",
        clauseIndex: 1,
        decideMs: 0,
        issueMs: 50,
      },
    ]);
    const claim = t.finish(OWNER, 2600)!;
    expect(claim).toBeDefined();
    const steps = await claim.take();
    expect(steps).toEqual([
      { clauseIndex: 0, action: YOUTUBE, atMs: 620, outcome: "done" },
      { clauseIndex: 1, action: RESULTS, atMs: 1950, outcome: "done" },
    ]);
    expect(t.finals).toEqual([{ text: OWNER, atMs: 2600 }]);
    expect(t.of("StreamedRunStarted")).toEqual([
      { streamedSteps: 2, dropped: 0 },
    ]);
    expect(t.of("StreamClauseCommitted")).toEqual([
      { index: 0, by: "boundary", words: 3, leadMs: 2000 },
      { index: 1, by: "stable", words: 5, leadMs: 700 },
    ]);
    // What the run's first observation says (src/core/streamed.ts).
    expect(streamedPrelude(steps)).toBe(
      "Already done while you spoke: YouTube is loading; YouTube search for midwest safety is loading. Continue from this screen; do not repeat these.",
    );
    // Content-free: codes and numbers, never the words or the address.
    expect(JSON.stringify(t.traces)).not.toMatch(/midwest|https|safari/i);
    expect(t.left).toEqual([]);
  });
  it("executes nothing for a consequential clause, and nothing before the decider names an action", async () => {
    const t = setup({ decide: { [c0.text]: YOUTUBE } });
    t.begin();
    const send = clause(1, "send it", 900);
    t.next(committed(c0), committed(send));
    await t.say("go to youtube and send it", 950);
    expect(t.opened).toEqual(["https://www.youtube.com/"]);
    expect(t.fast).toHaveBeenCalledTimes(2);
    expect(t.of("StreamedAction")).toHaveLength(1);
    expect(t.calls.filter((c) => c === "execute(open_url)")).toEqual([]);
    const steps = await t.finish("go to youtube and send it", 1500)!.take();
    expect(steps.map((s) => s.clauseIndex)).toEqual([0]);
  });
  it("never opens a protected host, even with autonomy set to all", async () => {
    const t = setup({
      settings: { autonomy: "all", autonomyAllAcknowledged: true },
      decide: {
        [c0.text]: {
          kind: "open_url",
          url: "https://www.paypal.com/signin",
          siteKey: "paypal",
          label: "PayPal",
        },
      },
    });
    t.begin();
    t.next(committed(c0));
    await t.say("go to paypal and", 600);
    expect(t.opened).toEqual([]);
    expect(t.labels).toEqual([]);
    expect(t.of("StreamedAction")).toEqual([]);
    expect(speaking().map((c) => c.type)).toEqual(["open_url"]);
    expect(t.finish("go to paypal and pay the bill", 1200)).toBeUndefined();
  });
  it("names a clause the final dropped as done by mistake", async () => {
    const t = setup({ decide: { [c0.text]: YOUTUBE, [c1.text]: RESULTS } });
    t.begin();
    t.next(committed(c0), committed(c1, "stable"));
    await t.say(OWNER, 1950);
    t.dropAtFinal(c0);
    const steps = await t.finish("play a midwest safety video", 2600)!.take();
    expect(steps.map((s) => s.outcome)).toEqual(["dropped", "done"]);
    expect(t.of("StreamedActionDropped")).toEqual([
      { kind: "open_url", clauseIndex: 0 },
    ]);
    expect(t.of("StreamedRunStarted")).toEqual([
      { streamedSteps: 2, dropped: 1 },
    ]);
    expect(streamedPrelude(steps)).toBe(
      "Already done while you spoke: YouTube search for midwest safety is loading. Continue from this screen; do not repeat these. Done by mistake (the sentence changed): YouTube is loading; put it right if it matters.",
    );
  });
  it("commits a clause by stability in silence by pushing the last partial again after the stable time", async () => {
    const t = setup({ decide: { [c1.text]: RESULTS } });
    t.begin();
    t.next(committed(c0));
    await t.say("go to youtube and", 600);
    await t.say(OWNER, 1500);
    expect(t.pushed.map((p) => p.atMs)).toEqual([600, 1500]);
    // Silence: the timer re-pushes the unchanged partial once, 360 ms on.
    t.next(committed(c1, "stable"));
    await t.to(1860);
    expect(t.pushed).toEqual([
      { text: "go to youtube and", atMs: 600 },
      { text: OWNER, atMs: 1500 },
      { text: OWNER, atMs: 1860 },
    ]);
    expect(t.opened).toEqual([RESULTS.url]);
    // Once only, and a newer partial disarms the pending one.
    await t.to(5000);
    expect(t.pushed).toHaveLength(3);
    await t.say(OWNER + " please", 5100);
    expect(t.timers.size).toBe(1);
    t.finish(OWNER + " please", 5200);
    expect(t.timers.size).toBe(0);
  });
  it("decides a superseded clause's replacement afresh: a different action navigates again and drops the old step, an equal one stands", async () => {
    const gmail = clause(0, "go to gmail", 800);
    const t = setup({
      decide: {
        [c0.text]: YOUTUBE,
        [gmail.text]: {
          kind: "open_url",
          url: "https://mail.google.com/",
          siteKey: "gmail",
          label: "Gmail",
        },
      },
    });
    t.begin();
    t.next(committed(c0));
    await t.say("go to youtube and", 620);
    // The recognizer rewrote the committed words: the stream says so once,
    // with the clause now in their place, and no second commit follows.
    t.next({ kind: "superseded", clause: c0, replacement: gmail });
    await t.say("go to gmail and", 850);
    expect(t.opened).toEqual([
      "https://www.youtube.com/",
      "https://mail.google.com/",
    ]);
    const steps = await t
      .finish("go to gmail and read the first mail", 1500)!
      .take();
    expect(steps.map((s) => [s.action.kind, s.outcome])).toEqual([
      ["open_url", "dropped"],
      ["open_url", "done"],
    ]);
    expect(t.of("StreamedActionDropped")).toEqual([
      { kind: "open_url", clauseIndex: 0 },
    ]);
    // A clause that only grew ("play a midwest safety" → "… video") decides
    // to the same URL: nothing is issued again and the step stands.
    const short = clause(1, "play a midwest safety", 1700);
    const grown = clause(1, "play a midwest safety video", 1900);
    const g = setup({
      decide: { [short.text]: RESULTS, [grown.text]: RESULTS },
    });
    g.begin();
    g.next(committed(short, "stable"));
    await g.say("go to youtube and play a midwest safety", 1720);
    g.next({ kind: "superseded", clause: short, replacement: grown });
    await g.say(OWNER, 1950);
    expect(g.opened).toEqual([RESULTS.url]);
    expect(g.of("StreamedAction")).toHaveLength(1);
    expect(g.of("StreamedActionDropped")).toEqual([]);
    // The final knows the grown clause; a drop by the old words matches nothing.
    g.dropAtFinal(short);
    const kept = await g.finish(OWNER, 2600)!.take();
    expect(kept.map((s) => s.outcome)).toEqual(["done"]);
    // A replacement that decides to nothing leaves the old step done by mistake.
    const nothing = clause(0, "go to youtube settings", 900);
    const n = setup({ decide: { [c0.text]: YOUTUBE } });
    n.begin();
    n.next(committed(c0));
    await n.say("go to youtube and", 620);
    n.next({ kind: "superseded", clause: c0, replacement: nothing });
    await n.say("go to youtube settings", 950);
    expect(n.opened).toEqual([YOUTUBE.url]);
    expect(
      (await n.finish("go to youtube settings", 1500)!.take())[0].outcome,
    ).toBe("dropped");
  });
  it("leaves the steps where they are when the final is a question, and the pill says what was opened", async () => {
    const t = setup({ decide: { [c0.text]: YOUTUBE } });
    t.begin();
    t.next(committed(c0));
    await t.say("go to youtube and", 620);
    const claim = t.finish("go to youtube and what time is it", 1400)!;
    expect(claim.steps).toHaveLength(1);
    claim.release("plan_not_start");
    await ticks();
    expect(t.left).toEqual(["Opened YouTube."]);
    expect(t.of("StreamedRunStarted")).toEqual([]);
    // Released once: a take after it changes nothing, nor a second release.
    claim.release("plan_not_start");
    expect(t.left).toHaveLength(1);
  });
  it("hands nothing to a final that saw no fast action", async () => {
    const t = setup();
    t.begin();
    t.next(committed(clause(0, "what time is it", 500)));
    await t.say("what time is it", 520);
    expect(t.finish("what time is it", 900)).toBeUndefined();
    expect(t.of("StreamClauseCommitted")).toEqual([
      { index: 0, by: "boundary", words: 4, leadMs: 400 },
    ]);
  });
});

describe("streaming execution: the other fast actions", () => {
  it("leaves the leading clause's app to the early start and opens a later clause's app with the early step's checks on its chain", async () => {
    const slackFirst = clause(0, "open slack", 300);
    const slackLater = clause(1, "open slack", 900);
    const t = setup({
      decide: { [slackFirst.text]: { kind: "open_app", name: "Slack" } },
    });
    t.begin();
    t.next(committed(slackFirst));
    await t.say("open slack and", 320);
    expect(t.executed).toEqual([]);
    expect(t.of("StreamedAction")).toEqual([]);
    t.next(committed(slackLater));
    await t.say("go to youtube and open slack and", 950);
    expect(t.sections).toEqual(["open", "close"]);
    expect(t.calls).toEqual([
      "configure",
      "surface()",
      // Inside the early start's section: the frame, then the launcher check.
      "surface()",
      "resume",
      "capture",
      "stop",
      "surface(open_app)",
      "resume",
      "execute(open_app)",
      "stop",
    ]);
    expect(t.executed).toEqual([
      { type: "open_app", name: "Slack", frame_id: "frame-1" },
    ]);
    expect(speaking().map((c) => c.type)).toEqual(["open_app"]);
    expect(t.labels).toEqual(["Opening Slack…"]);
    expect(t.of("StreamedAction")).toEqual([
      { kind: "open_app", clauseIndex: 1, decideMs: 0, issueMs: 50 },
    ]);
  });
  it("refuses a later clause's app whose heard name is not the installed one, as the early step does", async () => {
    const t = setup({
      launcher: { launcherName: "Google Chrome" },
      decide: { "open google": { kind: "open_app", name: "Google" } },
    });
    t.begin();
    t.next(committed(clause(1, "open google", 900), "stable"));
    await t.say("go to youtube and open google", 950);
    expect(t.executed).toEqual([]);
    expect(t.of("StreamedAction")).toEqual([]);
  });
  it("starts the continuous scroll for a scroll clause", async () => {
    const t = setup({
      decide: { "scroll down": { kind: "scroll", direction: "down" } },
    });
    t.begin();
    t.next(committed(clause(1, "scroll down", 700)));
    await t.say("open slack and scroll down", 720);
    expect(t.scrolls).toEqual(["down"]);
    expect(speaking().map((c) => c.type)).toEqual(["scroll"]);
    expect(t.labels).toEqual(["Scrolling down…"]);
    expect(t.of("StreamedAction")).toEqual([
      { kind: "scroll", clauseIndex: 1, decideMs: 0, issueMs: 20 },
    ]);
    const steps = await t.finish("open slack and scroll down", 1300)!.take();
    expect(steps[0]).toMatchObject({
      action: { kind: "scroll", direction: "down" },
      outcome: "done",
    });
  });
  it("asks Jev only when the rules are unsure and the decider is on, with the turn's abort signal, and acts on its answer", async () => {
    const jev = jevClient();
    const t = setup({
      decide: { [c0.text]: { kind: "none", reason: "unsure" } },
      withJev: async () => YOUTUBE,
      jev,
    });
    t.begin();
    t.next(committed(c0));
    await t.say("go to youtube and", 620);
    expect(t.withJev).toHaveBeenCalledTimes(1);
    expect(t.withJev.mock.calls[0][2]).toBe(jev);
    expect(t.withJev.mock.calls[0][3]).toBeInstanceOf(AbortSignal);
    expect(t.opened).toEqual(["https://www.youtube.com/"]);
  });
  it("never asks Jev when the decider is off or the rules were sure", async () => {
    const off = setup({
      decide: { [c0.text]: { kind: "none", reason: "unsure" } },
    });
    off.begin();
    off.next(committed(c0));
    await off.say("go to youtube and", 620);
    expect(off.withJev).not.toHaveBeenCalled();
    expect(off.opened).toEqual([]);
    const sure = setup({
      decide: { [c0.text]: { kind: "none", reason: "not_navigational" } },
      jev: jevClient(),
    });
    sure.begin();
    sure.next(committed(c0));
    await sure.say("go to youtube and", 620);
    expect(sure.withJev).not.toHaveBeenCalled();
  });
  it("records a route that failed as failed, which the prelude does not name", async () => {
    const t = setup({
      decide: { [c0.text]: YOUTUBE },
      openUrl: async () => {
        throw new Error("no browser");
      },
    });
    t.begin();
    t.next(committed(c0));
    await t.say("go to youtube and", 620);
    const steps = await t.finish(OWNER, 1500)!.take();
    expect(steps.map((s) => s.outcome)).toEqual(["failed"]);
    expect(t.of("StreamedRunStarted")).toEqual([
      { streamedSteps: 0, dropped: 0 },
    ]);
    expect(streamedPrelude(steps)).toBeUndefined();
  });
});

describe("streaming execution: gates", () => {
  it("acts on nothing while a run is active, held, queued or starting, on push-to-talk or in an answer window", async () => {
    for (const code of ["blocked_run", "ptt", "window"] as const) {
      const t = setup({ decide: { [c0.text]: YOUTUBE }, blocked: () => code });
      t.begin();
      t.next(committed(c0));
      await t.say("go to youtube and", 620);
      expect(t.opened, code).toEqual([]);
      expect(t.calls, code).toEqual([]);
    }
  });
  it("acts on nothing with the early start setting off, without a helper, or with a credential in the clause", async () => {
    const off = setup({
      decide: { [c0.text]: YOUTUBE },
      settings: { earlyStart: false },
    });
    off.begin();
    off.next(committed(c0));
    await off.say("go to youtube and", 620);
    expect(off.pushed).toEqual([]);
    expect(off.opened).toEqual([]);
    const none = setup({ decide: { [c0.text]: YOUTUBE }, noController: true });
    none.begin();
    none.next(committed(c0));
    await none.say("go to youtube and", 620);
    expect(none.fast).not.toHaveBeenCalled();
    const secret = clause(0, "type password: hunter2x9", 600);
    const leak = setup({ decide: { [secret.text]: YOUTUBE } });
    leak.begin();
    leak.next(committed(secret));
    await leak.say("type password: hunter2x9 and", 620);
    expect(leak.fast).not.toHaveBeenCalled();
    expect(leak.opened).toEqual([]);
  });
  it("ends the turn on cancel and on a new activation: later commits act no more, and what was opened stays", async () => {
    const t = setup({ decide: { [c0.text]: YOUTUBE, [c1.text]: RESULTS } });
    t.begin();
    t.next(committed(c0));
    await t.say("go to youtube and", 620);
    t.turn.cancel("cancelled");
    t.next(committed(c1));
    await t.say(OWNER, 1950);
    expect(t.opened).toEqual(["https://www.youtube.com/"]);
    expect(t.turn.finish(t.invocation, OWNER)).toBeUndefined();
    // The commit is still reported, without a lead: no final came.
    expect(t.of("StreamClauseCommitted")).toEqual([
      { index: 0, by: "boundary", words: 3 },
    ]);
    // A new activation starts clean; the old invocation's partials are ignored.
    t.begin();
    t.turn.partial(t.invocation - 1, "stale", 3000);
    expect(t.pushed).toHaveLength(1);
  });
  it("reports whether a fast action was issued for the activation, for the prepared step to stand down", async () => {
    const t = setup({ decide: { [c0.text]: YOUTUBE } });
    t.begin();
    expect(t.turn.engaged(t.invocation)).toBe(false);
    t.next(committed(c0));
    await t.say("go to youtube and", 620);
    expect(t.turn.engaged(t.invocation)).toBe(true);
    expect(t.turn.engaged(t.invocation + 1)).toBe(false);
  });
  it("builds a Jev client on the wire only when the decider is on and a key is stored", () => {
    expect(jevClientFor(false, "k", 600)).toBeUndefined();
    expect(jevClientFor(true, "  ", 600)).toBeUndefined();
    const client = jevClientFor(true, "k", 600)!;
    expect(typeof client.ask).toBe("function");
  });
});

describe("streaming execution: main.ts wiring", () => {
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
  it("creates the turn beside the early start, gated the same way plus push-to-talk and the answer windows", () => {
    const deps = source.slice(
      source.indexOf("const streaming = new StreamingTurn("),
      source.indexOf("function streamingBlocked()"),
    );
    expect(deps).toContain("blocked: () => streamingBlocked(),");
    expect(deps).toContain("early,");
    expect(deps).toContain("scroll: (direction) => streamScroll(direction),");
    expect(deps).toContain(
      "jevEnabled(settings, jevKey(credentials)),\n      jevKey(credentials),\n      JEV_TIMEOUT_MS,",
    );
    // The pill says what is loading while listening; the prepared step stands down.
    expect(deps).toMatch(
      /if \(listening && pill\.phase === "listening"\)\s*setPill\(\{ label: `\$\{label\.slice\(0, 48\)\} · Listening…` \}\);/,
    );
    expect(deps).toContain('discardSpeculation("streamed");');
    // Nothing speaks a fast action.
    expect(deps).not.toContain("conversation.say(");
    expect(deps).not.toContain("speak(");
    const gate = fn("streamingBlocked");
    expect(gate).toContain("earlyBlocked() ??");
    expect(gate).toContain('activationSource === "ptt"');
    expect(gate).toContain(
      'activationWindow === "approval" || activationWindow === "answer"',
    );
  });
  it("feeds every partial of the activation and ends the turn on every non-final, as the early start does", () => {
    const activation = receive.slice(
      receive.indexOf('event.event === "shortcut_down"'),
      receive.indexOf('event.event === "shortcut_tap"'),
    );
    expect(activation).toMatch(
      /early\.begin\(invocation, voiceContext\);\s*streaming\.begin\(invocation, voiceContext\);/,
    );
    expect(branch("transcript_partial")).toMatch(
      /early\.partial\(voiceInvocation, lastPartial\);\s*streaming\.partial\(voiceInvocation, lastPartial\);/,
    );
    expect(branch("voice_cancelled")).toContain(
      'streaming.cancel("cancelled");',
    );
    expect(branch("transcript_unconfirmed")).toContain(
      'streaming.cancel("no_final");',
    );
    expect(branch("voice_error")).toContain('streaming.cancel("no_final");');
    expect(branch("transcript_recovered")).toMatch(
      /if \(!heard\.text\) \{\s*early\.cancel\("no_final"\);\s*streaming\.cancel\("no_final"\);/,
    );
    expect(fn("cancelVoiceCapture")).toContain(
      'streaming.cancel("cancelled");',
    );
    const whole = fn("receiveVoice");
    expect(whole.slice(whole.lastIndexOf("} catch (error) {"))).toContain(
      'streaming.cancel("native_error");',
    );
    const helper = fn("getVoice");
    expect(
      helper.slice(
        helper.indexOf("onUnavailable"),
        helper.indexOf("onRestart"),
      ),
    ).toContain('streaming.cancel("cancelled");');
  });
  it("settles the steps at the final beside the early claim, hands them to the voice start alone and releases them otherwise", () => {
    const command = fn("command");
    expect(command).toMatch(
      /const claim = fromVoice \? early\.finish\(turnInvocation, text\) : undefined;\s*(?:\/\/.*\n\s*)*const streamed = fromVoice\s*\? streaming\.finish\(turnInvocation, text\)\s*: undefined;/,
    );
    expect(command).toMatch(
      /claim\?\.release\("plan_not_start"\);\s*(?:\/\/.*\n\s*)*streamed\?\.release\("plan_not_start"\);/,
    );
    const run = fn("runPlan");
    const start = run.slice(run.indexOf('case "start": {'));
    expect(start).toContain('ctx.streamed?.release("run_active_at_final");');
    expect(start).toMatch(
      /const streamed =\s*!active && ctx\.streamed \? await ctx\.streamed\.take\(\) : undefined;/,
    );
    expect(start.indexOf("await ctx.streamed.take()")).toBeLessThan(
      start.indexOf('await native?.request("restoreRemembered")'),
    );
    expect(start).toContain("...(streamed?.length ? { streamed } : {}),");
    // startRun passes them to the runner; the tutorial never gets them.
    const startRun = fn("startRun");
    expect(startRun).toContain(
      "...(from?.streamed?.length && !tutorial\n          ? { streamed: from.streamed }\n          : {}),",
    );
    expect(source).toContain(
      "streamed: z.array(streamedStepSchema).max(20).optional(),",
    );
    // The IPC, queue, remote and watch entry never passes them.
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
  it("stands the prepared first step down once a fast action changed the screen", () => {
    const speculate = source.slice(
      source.indexOf("async function speculate("),
      source.indexOf("function discardSpeculation("),
    );
    expect(speculate).toContain(
      'if (streaming.engaged(invocation)) return skip("streamed");',
    );
    const claim = source.slice(
      source.indexOf("function claimSpeculation("),
      source.indexOf("/** The OpenAI key"),
    );
    expect(claim).toContain(
      'if (streaming.engaged(invocation)) {\n    discardSpeculation("streamed");',
    );
  });
  it("routes open_url through the browser opener on the native controller, and the fast scroll through the helper's own scroll with nothing restored", () => {
    const native = fn("getNative");
    expect(native).toMatch(
      /openUrl: \(action\) =>\s*urlOpener\.open\(\s*action\.url,\s*preferredBrowser\(installedApps, memory\?\.data\(\)\),\s*\),/,
    );
    const scroll = fn("streamScroll");
    expect(scroll).toContain(
      "const pace = await getNative().scroll(direction, 1);",
    );
    expect(scroll).not.toContain("restoreRemembered");
    expect(scroll).not.toContain("hide()");
    expect(scroll).toMatch(
      /debug\("ScrollStarted", \{\s*direction,\s*linesPerTick: pace\.linesPerTick,\s*tickMs: pace\.tickMs,\s*\}\);/,
    );
  });
});
