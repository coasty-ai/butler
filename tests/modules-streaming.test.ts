/**
 * The streaming executor through the module registry (design modules.md
 * §6; electron/streaming.ts with `modules` in its deps): the fast decider
 * and the URL opener are ports, the clause stream a port when the setting
 * names an adapter. A fake registry stands in: with the built-in decider
 * behind it the owner's sentence behaves as it does without a registry; a
 * decider adapter's reply is used, normalised and re-checked by the core
 * (the schema, the policy while speaking, the protected-host floor); a
 * failing adapter issues nothing and the next clause still runs; a
 * segmenter adapter's events commit clauses and the final is the core's.
 * Also the glue in electron/modules.ts: the stateless segmenter, the choose
 * port's question on the wire, the Jev client over the port, the built-ins.
 */
import { describe, expect, it, vi } from "vitest";
import {
  defaultSettings,
  type Action,
  type ExecutionResult,
  type Frame,
  type Settings,
  type Surface,
} from "../src/core/schema";
import {
  PortClauseStream,
  StreamingTurn,
  type StreamController,
} from "../electron/streaming";
import type {
  Clause,
  ClauseEvent,
  ClauseStream,
  PartialSample,
} from "../src/voice/stream";
import {
  CLAUSE_QUESTION,
  clauseOf,
  decideFast,
  type FastAction,
} from "../src/voice/fast";
import type {
  ModuleRegistry,
  PortAdapter,
  ModulePorts,
  BuiltinFn,
  Builtins,
} from "../src/modules/registry";
import {
  contracts,
  type PortInput,
  type PortName,
  type PortOutput,
} from "../src/modules/contracts";
import {
  choiceQuestionOf,
  fastActionOf,
  jevClientOverPort,
  jevQuestionOf,
  moduleBuiltins,
  segmentStateless,
} from "../electron/modules";

const VSCODE = "com.microsoft.VSCode";
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
const ticks = async (n = 24) => {
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
const OWNER = "go to youtube and play a midwest safety video";
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
const c0 = clause(0, "go to youtube", 600);
const c1 = clause(1, "play a midwest safety video", 1900);
const committed = (
  c: Clause,
  by: "boundary" | "stable" = "boundary",
): ClauseEvent => ({
  kind: "committed",
  clause: c,
  by,
});

/** A stream whose events per push the test scripts. */
function fakeStream() {
  const queue: ClauseEvent[][] = [];
  const pushed: PartialSample[] = [];
  const stream: ClauseStream = {
    push: (sample) => {
      pushed.push(sample);
      return queue.shift() ?? [];
    },
    final: () => [{ kind: "final", clauses: [], dropped: [] }],
    clauses: () => [],
  };
  return {
    stream,
    pushed,
    next: (...events: ClauseEvent[]) => queue.push(events),
  };
}
/** A desktop whose calls are logged in order. */
function desktop() {
  const calls: string[] = [];
  const opened: string[] = [];
  let frames = 0;
  const base = (): Surface => ({
    appId: VSCODE,
    pid: 7,
    secureInput: false,
    unknown: false,
  });
  const controller: StreamController = {
    configure: vi.fn(async () => {
      calls.push("configure");
    }),
    surface: vi.fn(async (action?: Action) => {
      calls.push(action ? `surface(${action.type})` : "surface()");
      return base();
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
        appId: VSCODE,
      };
    }),
    execute: vi.fn(async (): Promise<void | ExecutionResult> => {
      calls.push("execute");
    }),
    openUrl: vi.fn(async (a) => {
      calls.push("openUrl");
      opened.push(a.url);
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
  return { controller, calls, opened };
}
type Scripts = {
  decide?: (
    input: PortInput<"fastDecider">,
  ) => Promise<PortOutput<"fastDecider">> | PortOutput<"fastDecider">;
  open?: (
    input: PortInput<"urlOpener">,
  ) => Promise<PortOutput<"urlOpener">> | PortOutput<"urlOpener">;
  segment?: (
    input: PortInput<"clauseSegmenter">,
  ) => Promise<PortOutput<"clauseSegmenter">> | PortOutput<"clauseSegmenter">;
};
/** A registry whose ports the test scripts; every call is recorded by port. */
function fakeRegistry(scripts: Scripts) {
  const portCalls: { port: PortName; input: unknown }[] = [];
  const registry: ModulePorts = {
    port<P extends PortName>(name: P): PortAdapter<P> {
      return {
        call: async (input: PortInput<P>) => {
          portCalls.push({ port: name, input });
          switch (name) {
            case "fastDecider":
              return (await (
                scripts.decide ??
                (({ clause, context }) => decideFast(clause, context))
              )(input as PortInput<"fastDecider">)) as PortOutput<P>;
            case "urlOpener":
              return (await (
                scripts.open ?? (() => ({ navigated: true, method: "open" }))
              )(input as PortInput<"urlOpener">)) as PortOutput<P>;
            case "clauseSegmenter":
              return (await (
                scripts.segment ?? (() => ({ clauses: [], events: [] }))
              )(input as PortInput<"clauseSegmenter">)) as PortOutput<P>;
            default:
              throw new Error("not_scripted");
          }
        },
      };
    },
  };
  return {
    registry,
    portCalls,
    of: (port: PortName) =>
      portCalls.filter((c) => c.port === port).map((c) => c.input),
  };
}
function setup(
  o: Scripts & { settings?: Partial<Settings>; noRegistry?: boolean } = {},
) {
  const desk = desktop();
  const s = fakeStream();
  const reg = fakeRegistry(o);
  const traces: { event: string; data: Record<string, unknown> }[] = [];
  const labels: string[] = [];
  let t = 0;
  const settings: Settings = {
    ...defaultSettings,
    earlyStart: true,
    ...o.settings,
  };
  const timers = new Map<number, { at: number; fn: () => void }>();
  let timerId = 0;
  const turn = new StreamingTurn({
    controller: () => desk.controller,
    settings: () => settings,
    blocked: () => undefined,
    browser: () => "Safari",
    early: { section: async (fn) => fn(), engaged: () => false },
    scroll: vi.fn(async () => {}),
    modules: o.noRegistry ? undefined : () => reg.registry,
    onAction: (label) => labels.push(label),
    trace: (event, data = {}) => traces.push({ event, data }),
    stream: () => s.stream,
    now: () => t,
    setTimer: (fn, ms) => {
      timers.set(++timerId, { at: t + ms, fn });
      return timerId;
    },
    clearTimer: (id) => void timers.delete(id as number),
  });
  let invocation = 0;
  return {
    ...desk,
    ...s,
    ...reg,
    turn,
    traces,
    labels,
    events: (event: string) =>
      traces.filter((x) => x.event === event).map((x) => x.data),
    begin: () => turn.begin(++invocation, Promise.resolve()),
    say: async (text: string, ms: number) => {
      t = ms;
      turn.partial(invocation, text, ms);
      await ticks();
      await turn.idle();
      await ticks();
    },
    /** Advances the clock, firing due timers in order (the held query's among them). */
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
        await ticks();
      }
      t = Math.max(t, ms);
    },
    finish: (text: string, ms: number) => {
      t = ms;
      return turn.finish(invocation, text);
    },
  };
}

describe("streaming through the module registry", () => {
  it("with the built-in decider behind the port, the owner's sentence loads YouTube and its results through the urlOpener port, as without a registry", async () => {
    const t = setup({
      decide: ({ clause, context }) =>
        clause.text === c0.text
          ? YOUTUBE
          : clause.text === c1.text
            ? { ...RESULTS, ...(context.frontHost ? {} : {}) }
            : { kind: "none", reason: "unsure" },
    });
    t.begin();
    t.next(committed(c0));
    await t.say("go to youtube and", 620);
    // The decider port saw the front application and the browser; the
    // opener port the address and the browser; the controller's own route
    // was not taken (the registry's built-in is that route).
    expect(t.of("fastDecider")).toEqual([
      {
        clause: c0,
        context: {
          frontAppId: VSCODE,
          browser: "Safari",
          protectedHosts: defaultSettings.protectedDomains,
        },
      },
    ]);
    expect(t.of("urlOpener")).toEqual([
      { url: "https://www.youtube.com/", browser: "Safari" },
    ]);
    expect(t.opened).toEqual([]);
    expect(t.calls).toEqual(["configure", "surface()"]);
    expect(t.labels).toEqual(["Opening YouTube…"]);
    t.next(committed(c1, "stable"));
    await t.say(OWNER, 1950);
    // The second clause's context carries the host the first sent the browser to.
    expect(
      (t.of("fastDecider")[1] as PortInput<"fastDecider">).context.frontHost,
    ).toBe("www.youtube.com");
    // A query from a clause committed by stability is held for its words to
    // stop growing (STREAMING_LIMITS.queryHoldMs), then issued.
    expect(t.of("urlOpener")).toHaveLength(1);
    await t.to(2300);
    expect(
      t.of("urlOpener").map((i) => (i as PortInput<"urlOpener">).url),
    ).toEqual([
      "https://www.youtube.com/",
      "https://www.youtube.com/results?search_query=midwest+safety",
    ]);
    expect(t.labels[1]).toBe("Searching YouTube for midwest safety…");
    expect(t.events("StreamedAction")).toEqual([
      {
        kind: "open_url",
        siteKey: "youtube",
        nav: "home",
        clauseIndex: 0,
        decideMs: 0,
        issueMs: 20,
      },
      {
        kind: "open_url",
        siteKey: "youtube",
        nav: "query",
        clauseIndex: 1,
        decideMs: 0,
        issueMs: 400,
      },
    ]);
    const steps = await t.finish(OWNER, 2600)!.take();
    expect(steps).toEqual([
      { clauseIndex: 0, action: YOUTUBE, atMs: 620, outcome: "done" },
      { clauseIndex: 1, action: RESULTS, atMs: 2300, outcome: "done" },
    ]);
    expect(JSON.stringify(t.traces)).not.toMatch(/midwest|https|safari/i);
  });
  it("the real decideFast behind the port decides the owner's first clause exactly as the direct call does", async () => {
    const t = setup();
    t.begin();
    t.next(committed(c0));
    await t.say("go to youtube and", 620);
    expect(t.of("urlOpener")).toEqual([
      { url: "https://www.youtube.com/", browser: "Safari" },
    ]);
    const direct = setup({ noRegistry: true });
    direct.begin();
    direct.next(committed(c0));
    await direct.say("go to youtube and", 620);
    expect(direct.opened).toEqual(["https://www.youtube.com/"]);
    expect(direct.calls).toEqual(["configure", "surface()", "openUrl"]);
  });
  it("uses a decider adapter's reply, naming an open_url without a site code by its host", async () => {
    const t = setup({
      // An adapter's reply without a site code or label (the contract allows it).
      decide: () =>
        ({
          kind: "open_url",
          url: "https://www.youtube.com/results?search_query=cats",
        }) as unknown as FastAction,
    });
    t.begin();
    t.next(committed(clause(0, "fire up some cat videos", 600)));
    await t.say("fire up some cat videos and", 620);
    expect(t.of("urlOpener")).toEqual([
      {
        url: "https://www.youtube.com/results?search_query=cats",
        browser: "Safari",
      },
    ]);
    // Its site code is not a recipe's, so the address itself says it is a query.
    expect(t.events("StreamedAction")).toEqual([
      {
        kind: "open_url",
        siteKey: "youtube-com",
        nav: "query",
        clauseIndex: 0,
        decideMs: 0,
        issueMs: 20,
      },
    ]);
    expect(t.labels).toEqual(["Searching youtube.com for cats…"]);
  });
  it("re-checks any adapter's open_url as the core's: credentials, a scheme that is not http(s) and a protected host never load, even under all", async () => {
    const bad = [
      "https://user:secret@www.youtube.com/",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "https://www.paypal.com/signin",
      "https://secure.chase.com/",
    ];
    for (const url of bad) {
      const t = setup({
        decide: () => ({ kind: "open_url", url, siteKey: "x", label: "X" }),
        settings: { autonomy: "all", autonomyAllAcknowledged: true },
      });
      t.begin();
      t.next(committed(c0));
      await t.say("go to youtube and", 620);
      expect(t.of("urlOpener"), url).toEqual([]);
      expect(t.labels, url).toEqual([]);
      expect(t.events("StreamedAction"), url).toEqual([]);
    }
  });
  it("a failing decider adapter issues nothing and the next clause is decided; a failing opener marks the step failed", async () => {
    let n = 0;
    const t = setup({
      decide: ({ clause }) => {
        if (++n === 1) throw new Error("adapter_down");
        return clause.text === c1.text
          ? RESULTS
          : { kind: "none", reason: "unsure" };
      },
    });
    t.begin();
    t.next(committed(c0));
    await t.say("go to youtube and", 620);
    expect(t.of("urlOpener")).toEqual([]);
    t.next(committed(c1, "stable"));
    await t.say(OWNER, 1950);
    await t.to(2300);
    expect(
      t.of("urlOpener").map((i) => (i as PortInput<"urlOpener">).url),
    ).toEqual([RESULTS.url]);
    const steps = await t.finish(OWNER, 2600)!.take();
    expect(steps.map((s) => [s.clauseIndex, s.outcome])).toEqual([[1, "done"]]);

    const failing = setup({
      decide: () => YOUTUBE,
      open: () => {
        throw new Error("no_browser");
      },
    });
    failing.begin();
    failing.next(committed(c0));
    await failing.say("go to youtube and", 620);
    const failed = await failing.finish("go to youtube", 900)!.take();
    expect(failed.map((s) => s.outcome)).toEqual(["failed"]);
    const refused = setup({
      decide: () => YOUTUBE,
      open: () => ({ navigated: false, method: "none" }),
    });
    refused.begin();
    refused.next(committed(c0));
    await refused.say("go to youtube and", 620);
    expect(
      (await refused.finish("go to youtube", 900)!.take()).map(
        (s) => s.outcome,
      ),
    ).toEqual(["failed"]);
  });
  it("asks a segmenter adapter per partial with the clauses it answered last, commits on its events, and takes the final's clauses and drops from the core", async () => {
    const segments: PortInput<"clauseSegmenter">[] = [];
    const t = setup({
      settings: {
        modules: {
          clauseSegmenter: {
            kind: "mcp",
            server: "seg",
            tool: "segment_clauses",
            fallback: true,
          },
        },
      },
      segment: (input) => {
        segments.push(input);
        if (input.text === "go to gmail")
          return {
            clauses: [{ ...clause(0, "go to gmail", 300), state: "growing" }],
            events: [],
          };
        if (input.text === "go to gmail and")
          return {
            clauses: [clause(0, "go to gmail", 300)],
            events: [committed(clause(0, "go to gmail", 300))],
          };
        return { clauses: input.previous, events: [] };
      },
      decide: ({ clause: c }) =>
        c.text === "go to gmail"
          ? {
              kind: "open_url",
              url: "https://mail.google.com/",
              siteKey: "gmail",
              label: "Gmail",
            }
          : { kind: "none", reason: "unsure" },
    });
    t.begin();
    await t.say("go to gmail", 300);
    await t.say("go to gmail and", 400);
    // The stream fake was never used: the port was.
    expect(t.pushed).toEqual([]);
    expect(segments.map((s) => [s.text, s.previous.length])).toEqual([
      ["go to gmail", 0],
      ["go to gmail and", 1],
    ]);
    expect(segments[1].previous[0]).toMatchObject({
      text: "go to gmail",
      state: "growing",
    });
    expect(t.of("urlOpener")).toEqual([
      { url: "https://mail.google.com/", browser: "Safari" },
    ]);
    // The final says something else: the committed clause is dropped by the
    // core's own comparison, and the run is told.
    const steps = await t
      .finish("go to youtube and play a midwest safety video", 2600)!
      .take();
    expect(steps.map((s) => s.outcome)).toEqual(["dropped"]);
    expect(t.events("StreamedActionDropped")).toEqual([
      { kind: "open_url", clauseIndex: 0 },
    ]);
    expect(t.events("StreamedRunStarted")).toEqual([
      { streamedSteps: 1, dropped: 1 },
    ]);
    // A builtin choice, or no registry, keeps the built-in stream.
    const builtin = setup({
      settings: { modules: { clauseSegmenter: { kind: "builtin" } } },
    });
    builtin.begin();
    await builtin.say("go to youtube", 300);
    expect(builtin.pushed).toEqual([{ text: "go to youtube", atMs: 300 }]);
  });
});

describe("PortClauseStream", () => {
  it("keeps a committed clause the final still says and drops one it does not", () => {
    const port: PortAdapter<"clauseSegmenter"> = {
      call: async () => ({
        clauses: [c0, clause(1, "go to gmail", 800)],
        events: [],
      }),
    };
    const s = new PortClauseStream(port, () => {});
    s.push({ text: "go to youtube and go to gmail", atMs: 800 });
    return new Promise<void>((resolve) => setImmediate(resolve)).then(() => {
      const [final] = s.final(OWNER, 2600);
      expect(final.kind).toBe("final");
      if (final.kind !== "final") return;
      expect(final.clauses.map((c) => c.text)).toEqual([
        "go to youtube",
        "play a midwest safety video",
      ]);
      expect(final.dropped.map((c) => c.text)).toEqual(["go to gmail"]);
      expect(s.push({ text: "later", atMs: 3000 })).toEqual([]);
    });
  });
});

describe("electron/modules.ts", () => {
  it("segmentStateless commits by boundary, keeps a committed clause with its time and supersedes a rewrite", () => {
    const first = segmentStateless({
      text: "go to youtube and play",
      atMs: 500,
      previous: [],
    });
    expect(first.events).toEqual([
      {
        kind: "committed",
        clause: expect.objectContaining({
          index: 0,
          text: "go to youtube",
          state: "committed",
          committedAtMs: 500,
        }),
        by: "boundary",
      },
    ]);
    expect(first.clauses.map((c) => [c.text, c.state])).toEqual([
      ["go to youtube", "committed"],
      ["play", "growing"],
    ]);
    const second = segmentStateless({
      text: OWNER,
      atMs: 900,
      previous: first.clauses,
    });
    expect(second.events).toEqual([]);
    expect(second.clauses[0].committedAtMs).toBe(500);
    const rewrite = segmentStateless({
      text: "go to gmail and play a song",
      atMs: 1200,
      previous: second.clauses,
    });
    expect(rewrite.events).toEqual([
      {
        kind: "superseded",
        clause: expect.objectContaining({ text: "go to youtube" }),
        replacement: expect.objectContaining({
          text: "go to gmail",
          committedAtMs: 1200,
        }),
      },
    ]);
    expect(contracts.clauseSegmenter.output.parse(rewrite)).toEqual(rewrite);
  });
  it("carries a Jev question through the choose port's shape and back without loss", () => {
    const q = choiceQuestionOf(CLAUSE_QUESTION, "clause");
    expect(q.id).toBe("clause");
    expect(q.choices).toEqual(Object.keys(CLAUSE_QUESTION.criteria));
    expect(
      contracts.choiceModel.input.parse({
        question: q,
        state: { clause: "x" },
      }),
    ).toBeTruthy();
    expect(jevQuestionOf(q)).toEqual(CLAUSE_QUESTION);
    // A plain prompt (another adapter's question) becomes the instructions.
    expect(
      jevQuestionOf({
        id: "a",
        choices: ["yes", "no"],
        prompt: "Is it raining?",
      }),
    ).toEqual({
      type: "choice",
      instructions: "Is it raining?",
      criteria: { yes: "yes", no: "no" },
    });
  });
  it("jevClientOverPort answers with the port's choice at its probability, and nothing for a choice not asked or a failing port", async () => {
    const calls: PortInput<"choiceModel">[] = [];
    const port = (
      reply: () => PortOutput<"choiceModel">,
    ): PortAdapter<"choiceModel"> => ({
      call: async (input) => {
        calls.push(input);
        return reply();
      },
    });
    const clauseX = clauseOf("fire up slack");
    const answer = await jevClientOverPort(
      port(() => ({ choice: "open_app", p: 0.93 })),
    ).ask(CLAUSE_QUESTION, { clause: clauseX.text });
    expect(answer).toEqual({
      choice: "open_app",
      probabilities: {
        open_app: 0.93,
        open_site: 0,
        search_on_site: 0,
        scroll: 0,
        not_navigational: 0,
        unclear: 0,
      },
      confidence: 0.93,
    });
    expect(calls[0].question.id).toBe("clause");
    expect(calls[0].state).toEqual({ clause: "fire up slack" });
    expect(
      await jevClientOverPort(port(() => ({ choice: "buy", p: 0.99 }))).ask(
        CLAUSE_QUESTION,
        {},
      ),
    ).toBeUndefined();
    expect(
      await jevClientOverPort(
        port(() => {
          throw new Error("down");
        }),
      ).ask(CLAUSE_QUESTION, {}),
    ).toBeUndefined();
  });
  it("fastActionOf names an adapter's open_url by its host and passes the rest through", () => {
    expect(fastActionOf(undefined)).toEqual({ kind: "none", reason: "unsure" });
    expect(fastActionOf({ kind: "scroll", direction: "up" })).toEqual({
      kind: "scroll",
      direction: "up",
    });
    expect(
      fastActionOf({
        kind: "open_url",
        url: "https://en.wikipedia.org/w/index.php?search=x",
      } as unknown as FastAction),
    ).toEqual({
      kind: "open_url",
      url: "https://en.wikipedia.org/w/index.php?search=x",
      siteKey: "en-wikipedia-org",
      label: "",
    });
    expect(
      fastActionOf({
        kind: "open_url",
        url: "https://x.com/",
        siteKey: "x",
        label: "X",
      }),
    ).toEqual({
      kind: "open_url",
      url: "https://x.com/",
      siteKey: "x",
      label: "X",
    });
  });
  it("the built-ins: decideFast behind fastDecider (Jev only when on, through the registry's choice model), the route behind urlOpener, and tts answering not played", async () => {
    const opened: string[] = [];
    let enabled = false;
    const choice = vi.fn(async (): Promise<PortOutput<"choiceModel">> => ({
      choice: "open_app",
      p: 0.95,
    }));
    const registry: Pick<ModuleRegistry, "port"> = {
      port: (<P extends PortName>(name: P): PortAdapter<P> => ({
        call: (name === "choiceModel"
          ? choice
          : async () => {
              throw new Error("unused");
            }) as PortAdapter<P>["call"],
      })) as ModuleRegistry["port"],
    };
    const builtins = moduleBuiltins({
      controller: () => ({
        openUrl: async (a) => {
          opened.push(a.url);
          return {
            navigated: { host: new URL(a.url).hostname, via: "script" },
          } as ExecutionResult;
        },
      }),
      jev: () => ({ key: "k", enabled }),
      fetch: async () => {
        throw new Error("never");
      },
      registry: () => registry,
    });
    const b = builtins as Required<Omit<Builtins, "choiceModel">> & {
      choiceModel: BuiltinFn<"choiceModel">;
    };
    const ctx = { protectedHosts: defaultSettings.protectedDomains };
    expect(
      await b.fastDecider({
        clause: clauseOf("go to youtube"),
        context: ctx,
      }),
    ).toEqual(YOUTUBE);
    // Unsure and Jev off: unsure, the choice model never asked.
    expect(
      await b.fastDecider({
        clause: clauseOf("fire up slack"),
        context: ctx,
      }),
    ).toEqual({ kind: "none", reason: "unsure" });
    expect(choice).not.toHaveBeenCalled();
    enabled = true;
    expect(
      await b.fastDecider({
        clause: clauseOf("fire up slack"),
        context: ctx,
      }),
    ).toEqual({ kind: "open_app", name: "slack" });
    expect(choice).toHaveBeenCalledTimes(1);
    expect(await b.urlOpener({ url: "https://www.youtube.com/" })).toEqual({
      navigated: true,
      method: "script",
    });
    expect(opened).toEqual(["https://www.youtube.com/"]);
    await expect(
      b.urlOpener({ url: "https://user:pw@x.com/" }),
    ).rejects.toThrow();
    expect(await b.tts({ text: "hello" })).toEqual({
      played: false,
      ms: 0,
    });
    enabled = false;
    await expect(
      b.choiceModel({
        question: choiceQuestionOf(CLAUSE_QUESTION, "clause"),
        state: {},
      }),
    ).rejects.toThrow("jev_off");
  });
});
