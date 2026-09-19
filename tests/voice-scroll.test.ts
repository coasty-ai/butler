import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  actionSchema,
  defaultSettings,
  type Settings,
  type Surface,
} from "../src/core/schema";
import { evaluate } from "../src/core/policy";
import { scrollEndReport, scrollPace } from "../electron/controller";
import {
  Conversation,
  SCROLL_WINDOW,
  type ConversationSettings,
} from "../electron/conversation";
import type { SpeechOutput } from "../electron/speech-output";
import { remoteReply } from "../src/remote/protocol";
import { speakableText } from "../src/voice/speakable";
import {
  APPROVAL_MIN_CONFIDENCE,
  isControlPhrase,
  planVoiceTurn,
  scrollRequest,
  utteranceCompleteness,
  voiceIntent,
  type ScrollRequest,
  type VoiceTurnInput,
  type VoiceTurnRun,
} from "../src/voice/turns";

/**
 * "Scroll down" scrolls the window in front until the user says stop: the
 * native helper paces it, main.ts starts it without a model call, and the
 * scroll's own listening window hears "stop", "faster", "slower", "scroll up".
 */
describe("the spoken scroll: intent", () => {
  const start = (direction?: "down" | "up", factor?: 2 | 0.5) =>
    ({
      act: "start",
      ...(direction && { direction }),
      ...(factor && { factor }),
    }) as ScrollRequest;
  it.each<[string, ScrollRequest]>([
    ["scroll down", start("down")],
    ["Scroll up.", start("up")],
    ["scroll down slowly", start("down")],
    ["scroll down gently", start("down")],
    ["scroll downwards", start("down")],
    ["keep scrolling", start()],
    ["keep scrolling down", start("down")],
    ["keep on scrolling", start()],
    ["continue scrolling", start()],
    ["start scrolling", start()],
    ["scroll", start()],
    ["scroll the page down", start("down")],
    ["scroll down the page", start("down")],
    ["scroll it up", start("up")],
    ["can you scroll down", start("down")],
    ["just scroll down", start("down")],
    ["um, scroll down please", start("down")],
    ["okay scroll up now", start("up")],
    ["s-s-scroll down", start("down")],
    ["scroll scroll down", start("down")],
    ["scroll down faster", start("down", 2)],
    ["scroll up slower", start("up", 0.5)],
    ["faster", { act: "speed", factor: 2 }],
    ["quicker", { act: "speed", factor: 2 }],
    ["a bit faster", { act: "speed", factor: 2 }],
    ["a little faster", { act: "speed", factor: 2 }],
    ["much faster", { act: "speed", factor: 2 }],
    ["speed up", { act: "speed", factor: 2 }],
    ["speed it up", { act: "speed", factor: 2 }],
    ["too slow", { act: "speed", factor: 2 }],
    ["that's too slow", { act: "speed", factor: 2 }],
    ["scroll faster", { act: "speed", factor: 2 }],
    ["go faster", { act: "speed", factor: 2 }],
    ["slower", { act: "speed", factor: 0.5 }],
    ["a bit slower", { act: "speed", factor: 0.5 }],
    ["slow down", { act: "speed", factor: 0.5 }],
    ["slow it down", { act: "speed", factor: 0.5 }],
    ["slowly", { act: "speed", factor: 0.5 }],
    ["more slowly", { act: "speed", factor: 0.5 }],
    ["too fast", { act: "speed", factor: 0.5 }],
    ["it's too fast", { act: "speed", factor: 0.5 }],
    ["stop scrolling", { act: "stop" }],
    ["Stop scrolling.", { act: "stop" }],
    ["stop the scroll", { act: "stop" }],
    ["stop the scrolling", { act: "stop" }],
    ["quit scrolling", { act: "stop" }],
    ["cancel scrolling", { act: "stop" }],
    ["end scrolling", { act: "stop" }],
    ["stop there", { act: "stop" }],
    ["stop here", { act: "stop" }],
    ["stop right there", { act: "stop" }],
    ["that's enough", { act: "stop" }],
    ["enough", { act: "stop" }],
    ["enough scrolling", { act: "stop" }],
    ["that's enough scrolling", { act: "stop" }],
    ["okay stop scrolling now", { act: "stop" }],
    ["no, stop scrolling", { act: "stop" }],
    ["stop scrolling please", { act: "stop" }],
  ])("hears %j as a scroll request", (text, request) => {
    expect(voiceIntent(text).kind).toBe("scroll");
    expect(scrollRequest(text)).toEqual(request);
    expect(isControlPhrase(text)).toBe(false);
  });

  it.each([
    ["scroll down a bit", "command"],
    ["scroll down a little", "command"],
    ["scroll down a page", "command"],
    ["scroll down twice", "command"],
    ["scroll down three lines", "command"],
    ["scroll to the bottom", "command"],
    ["scroll to the top", "command"],
    ["scroll all the way down", "command"],
    ["scroll down to the comments", "command"],
    ["page down", "command"],
    ["scroll the sidebar down", "command"],
    ["scroll down and click save", "command"],
    ["stop scrolling and click Save", "command"],
    ["don't scroll", "command"],
    ["don't stop scrolling", "command"],
    ["make it faster", "command"],
    ["faster horses", "command"],
    ["stop", "stop"],
    ["stop now", "stop"],
    ["cancel", "stop"],
    ["wait", "pause"],
    ["keep going", "resume"],
    ["undo that", "undo"],
  ])("leaves %j as %s", (text, kind) => {
    expect(voiceIntent(text).kind).toBe(kind);
    expect(scrollRequest(text)).toBeUndefined();
  });

  it("ends as fast as a stop only inside the scroll's own window", () => {
    for (const text of ["scroll up", "faster", "stop scrolling", "slow down"])
      expect([text, utteranceCompleteness(text, "scroll")]).toEqual([
        text,
        "control",
      ]);
    // "Scroll down… to the comments" may go on: a command's timing elsewhere.
    expect(utteranceCompleteness("scroll down", "command")).toBe("complete");
    expect(utteranceCompleteness("scroll up", "command")).toBe("incomplete");
    expect(utteranceCompleteness("open Safari", "scroll")).toBe("complete");
  });

  it("is never something the assistant says", () => {
    expect(speakableText("Scroll down.")).toBeUndefined();
    expect(speakableText("Faster.")).toBeUndefined();
    expect(speakableText("Stopped.")).toBe("Stopped.");
  });
});

describe("the spoken scroll: planning", () => {
  const base: VoiceTurnInput = {
    text: "",
    confidence: 0.9,
    source: "wake",
    gateMatches: false,
    now: 1_000_000,
  };
  const plan = (o: Partial<VoiceTurnInput>) => planVoiceTurn({ ...base, ...o });
  const run = (o: Partial<VoiceTurnRun> = {}): VoiceTurnRun => ({
    id: "r1",
    status: "executing",
    actions: 2,
    held: false,
    task: "read the article",
    ...o,
  });
  const down = {
    kind: "scroll",
    request: { act: "start", direction: "down" },
  };

  it("starts a scroll with nothing running, and steers a run under way", () => {
    expect(plan({ text: "scroll down" })).toEqual(down);
    expect(plan({ text: "scroll down", run: run() })).toEqual(down);
    expect(plan({ text: "keep scrolling", run: run({ held: true }) })).toEqual({
      kind: "scroll",
      request: { act: "start" },
    });
  });

  it("is never an answer to a pending approval", () => {
    expect(
      plan({
        text: "scroll down",
        gateMatches: true,
        run: run({ status: "confirming", pendingReason: "Send this message?" }),
      }),
    ).toEqual(down);
  });

  it("needs the user's-words floor to start, as sending input does", () => {
    expect(
      plan({ text: "scroll down", confidence: APPROVAL_MIN_CONFIDENCE }),
    ).toEqual(down);
    // Heard less clearly it is the model's task, as before.
    expect(plan({ text: "scroll down", confidence: 0.3 })).toEqual({
      kind: "start",
      text: "scroll down",
      taskSource: "user_words_unsure",
    });
    expect(
      plan({ text: "scroll down", confidence: 0, recovered: true }),
    ).toEqual({
      kind: "start",
      text: "scroll down",
      taskSource: "user_words_unsure",
    });
    expect(plan({ text: "scroll down", confidence: 0, run: run() })).toEqual({
      kind: "revise",
      text: "scroll down",
    });
    // Typed at the Mac the words are the user's.
    expect(
      plan({ text: "scroll down", source: "text", confidence: 1 }),
    ).toEqual(down);
  });

  it("never scrolls for a phone: nobody is at the screen", () => {
    for (const source of ["remote", "message"] as const)
      expect(plan({ text: "scroll down", source, confidence: 1 })).toEqual({
        kind: "start",
        text: "scroll down",
        taskSource: "user_words",
      });
  });

  it("steers the scroll under way however faintly the words were heard", () => {
    expect(plan({ text: "faster", scrolling: true, confidence: 0 })).toEqual({
      kind: "scroll",
      request: { act: "speed", factor: 2 },
    });
    expect(
      plan({
        text: "stop scrolling",
        scrolling: true,
        recovered: true,
        confidence: 0,
      }),
    ).toEqual({ kind: "scroll", request: { act: "stop" } });
    expect(plan({ text: "scroll up", scrolling: true, run: run() })).toEqual({
      kind: "scroll",
      request: { act: "start", direction: "up" },
    });
    expect(
      plan({ text: "slow down", scrolling: true, source: "text" }),
    ).toEqual({
      kind: "scroll",
      request: { act: "speed", factor: 0.5 },
    });
  });

  it("lets stop, pause and continue win while scrolling", () => {
    expect(plan({ text: "stop", scrolling: true })).toEqual({ kind: "stop" });
    expect(plan({ text: "wait", scrolling: true, run: run() })).toEqual({
      kind: "pause",
    });
    expect(
      plan({ text: "continue", scrolling: true, run: run({ held: true }) }),
    ).toEqual({ kind: "resume" });
  });

  it("with nothing scrolling, steering words correct the run or have nothing to do", () => {
    // A model that scrolls is told to stop, exactly as before.
    expect(plan({ text: "stop scrolling", run: run() })).toEqual({
      kind: "revise",
      text: "stop scrolling",
    });
    expect(plan({ text: "faster", run: run() })).toEqual({
      kind: "revise",
      text: "faster",
    });
    expect(plan({ text: "stop scrolling" })).toEqual({
      kind: "nothingRunning",
    });
    expect(plan({ text: "slower" })).toEqual({ kind: "nothingRunning" });
    expect(plan({ text: "that's enough" })).toEqual({ kind: "nothingRunning" });
  });

  it("keeps 'stop scrolling and click Save' a correction", () => {
    expect(
      plan({
        text: "stop scrolling and click Save",
        run: run(),
        scrolling: true,
      }),
    ).toEqual({ kind: "revise", text: "stop scrolling and click Save" });
  });

  it("lets nothing but steering and control words act from the scroll's window", () => {
    const inWindow = (text: string, o: Partial<VoiceTurnInput> = {}) =>
      plan({
        text,
        source: "followup",
        window: "scroll",
        scrolling: true,
        turnMs: 800,
        ...o,
      });
    expect(inWindow("scroll up")).toEqual({
      kind: "scroll",
      request: { act: "start", direction: "up" },
    });
    expect(inWindow("stop")).toEqual({ kind: "stop" });
    expect(inWindow("continue", { run: run({ held: true }) })).toEqual({
      kind: "resume",
    });
    // Talk nearby that got through the onset rule starts nothing.
    expect(inWindow("what time is it")).toEqual({ kind: "acknowledge" });
    expect(inWindow("open Safari", { run: run({ held: true }) })).toEqual({
      kind: "acknowledge",
    });
    expect(inWindow("how's it going")).toEqual({ kind: "acknowledge" });
  });

  it("has a fixed line for the phone, which never reaches it", () => {
    expect(remoteReply("scroll")).toBe("Scrolling on the Mac.");
  });
});

describe("the spoken scroll: policy", () => {
  const surface: Surface = {
    appId: "com.apple.Safari",
    pid: 7,
    secureInput: false,
    unknown: false,
  };
  const scroll = actionSchema.parse({
    frame_id: "f",
    type: "scroll",
    delta_x: 0,
    delta_y: 32,
  });
  const decide = (
    autonomy: Settings["autonomy"],
    s: Partial<Surface> = {},
    autonomyAllAcknowledged = false,
  ) =>
    evaluate(
      scroll,
      { ...surface, ...s },
      {
        ...structuredClone(defaultSettings),
        autonomy,
        autonomyAllAcknowledged,
      },
      false,
    );

  it("asks nothing under any autonomy setting: scrolling is read-only", () => {
    for (const autonomy of ["ask", "task", "flow", "all"] as const)
      expect([autonomy, decide(autonomy)]).toEqual([
        autonomy,
        { kind: "ALLOW", reason: "Pointer navigation." },
      ]);
    expect(decide("all", {}, true).kind).toBe("ALLOW");
  });

  it("keeps the surface floors: a protected surface is still never scrolled", () => {
    expect(decide("all", { secureInput: true }, true).kind).not.toBe("ALLOW");
    expect(
      decide("task", { appId: defaultSettings.protectedApps[0] }).kind,
    ).not.toBe("ALLOW");
  });
});

describe("the spoken scroll: the helper's replies", () => {
  it("reads the pace the helper settled on, and nothing malformed", () => {
    expect(
      scrollPace({
        started: true,
        session: 2,
        direction: "down",
        speed: 2,
        linesPerTick: 4,
        tickMs: 140,
      }),
    ).toEqual({ session: 2, speed: 2, linesPerTick: 4, tickMs: 140 });
    expect(
      scrollPace({ session: 2, speed: 2, linesPerTick: 4 }),
    ).toBeUndefined();
    expect(
      scrollPace({ session: 0, speed: 2, linesPerTick: 4, tickMs: 140 }),
    ).toBeUndefined();
    expect(
      scrollPace({ session: 2, speed: -1, linesPerTick: 4, tickMs: 140 }),
    ).toBeUndefined();
    expect(scrollPace("started")).toBeUndefined();
  });

  it("reads why a scroll ended, with its session and ticks", () => {
    expect(
      scrollEndReport({
        event: "scroll_ended",
        session: 2,
        reason: "input",
        ticks: 41,
      }),
    ).toEqual({ session: 2, reason: "input", ticks: 41 });
    expect(
      scrollEndReport({
        session: 3,
        reason: "error",
        ticks: 0,
        message: "Protected application. Switch applications and resume.",
      }),
    ).toEqual({
      session: 3,
      reason: "error",
      ticks: 0,
      message: "Protected application. Switch applications and resume.",
    });
    expect(
      scrollEndReport({
        session: 3,
        reason: "error",
        ticks: 0,
        message: "x".repeat(400),
      })!.message,
    ).toHaveLength(300);
    expect(
      scrollEndReport({ session: 2, reason: "bored", ticks: 1 }),
    ).toBeUndefined();
    expect(
      scrollEndReport({ session: 2, reason: "stop", ticks: -1 }),
    ).toBeUndefined();
    expect(
      scrollEndReport({ session: 2, reason: "stop", ticks: 1.5 }),
    ).toBeUndefined();
    expect(scrollEndReport({ reason: "stop", ticks: 1 })).toBeUndefined();
  });
});

describe("the spoken scroll: the listening window", () => {
  function setup(overrides: Partial<ConversationSettings> = {}) {
    const settings: ConversationSettings = {
      handsFree: true,
      voiceReplies: "voice",
      followUpListening: true,
      voiceRate: 1,
      ...overrides,
    };
    const spoken: string[] = [];
    const calls: { method: string; data?: Record<string, unknown> }[] = [];
    const speech: SpeechOutput = {
      speak: async (request) => {
        spoken.push(request.text);
        return { accepted: true, engine: "system" };
      },
      speakStream: async () => ({
        accepted: true,
        engine: "system",
        spoken: "",
      }),
      cancel: () => {},
      stop: async () => {},
      preview: async () => ({ accepted: true, engine: "system" }),
    };
    const conversation = new Conversation({
      settings: () => settings,
      speech,
      voiceCall: async (method, data) => {
        calls.push({ method, data });
        return method === "listen" ? { opened: true } : {};
      },
      now: () => 10000,
      random: () => 0,
      newId: () => "u1",
    });
    return {
      conversation,
      spoken,
      listens: () =>
        calls.filter((c) => c.method === "listen").map((c) => c.data),
    };
  }
  const start = {
    kind: "scroll",
    request: { act: "start", direction: "down" },
  } as const;

  it("opens the long scroll window after a start or a steer, saying nothing", () => {
    const t = setup();
    t.conversation.acknowledge(start, { source: "wake" });
    expect(t.listens()).toEqual([SCROLL_WINDOW]);
    expect(SCROLL_WINDOW).toEqual({ kind: "scroll", seconds: 95 });
    expect(t.spoken).toEqual([]);
    t.conversation.acknowledge(
      { kind: "scroll", request: { act: "speed", factor: 2 } },
      { source: "followup" },
    );
    expect(t.listens()).toHaveLength(2);
  });

  it("opens it for a typed 'scroll down' too, so a spoken stop still lands", () => {
    const t = setup();
    t.conversation.acknowledge(start, { source: "text" });
    expect(t.listens()).toEqual([SCROLL_WINDOW]);
  });

  it("opens nothing for a stop, with hands-free off, or with follow-up listening off", () => {
    const stop = setup();
    stop.conversation.acknowledge(
      { kind: "scroll", request: { act: "stop" } },
      { source: "followup" },
    );
    expect(stop.listens()).toEqual([]);
    const ptt = setup({ handsFree: false });
    ptt.conversation.acknowledge(start, { source: "ptt" });
    expect(ptt.listens()).toEqual([]);
    const quiet = setup({ followUpListening: false });
    quiet.conversation.acknowledge(start, { source: "wake" });
    expect(quiet.listens()).toEqual([]);
  });
});

describe("the spoken scroll: main.ts wiring", () => {
  // main.ts is not loaded in tests; the wiring is pinned by reading it.
  const source = readFileSync(
    new URL("../electron/main.ts", import.meta.url),
    "utf8",
  );
  const block = (from: string, to: string) => {
    const start = source.indexOf(from);
    expect(start).toBeGreaterThan(0);
    return source.slice(start, source.indexOf(to, start));
  };

  it("starts the helper's scroll without a model call and shows the pill", () => {
    const scroll = block('case "scroll": {', 'case "acknowledge":');
    // The user's own pause (the default message), which nothing narrates.
    expect(scroll).toMatch(/if \(active && !runHeld\(\)\) runner!\.pause\(\);/);
    expect(scroll).toContain('await native?.request("restoreRemembered");');
    expect(scroll).toMatch(
      /const pace = await getNative\(\)\.scroll\(direction, speed\);/,
    );
    expect(scroll).toContain("label: `Scrolling ${direction}… say stop.`,");
    expect(scroll).toMatch(
      /debug\("ScrollStarted", \{\s*direction,\s*linesPerTick: pace\.linesPerTick,\s*tickMs: pace\.tickMs,\s*\}\);/,
    );
    // "Stop scrolling" ends only the scroll; the run stays paused.
    expect(scroll).toMatch(
      /if \(request\.act === "stop"\) \{\s*await endScroll\(\);\s*if \(runActive\(\)\) render\(\);\s*else idleCard\("Stopped\."\);\s*return;/,
    );
  });

  it("ends the scroll on any other plan, and a bare stop with nothing running stops only it", () => {
    const guard = block(
      'if (scrolling && plan.kind !== "scroll") {',
      "switch (plan.kind) {",
    );
    expect(guard).toContain(
      'const only = plan.kind === "stop" && !runActive();',
    );
    expect(guard).toMatch(/await endScroll\(\);/);
    expect(guard).toMatch(
      /if \(only\) \{[\s\S]*idleCard\("Stopped\."\);\s*return;/,
    );
  });

  it("tells the planner a scroll is under way, on the Mac and from the phone", () => {
    expect(source.match(/scrolling: !!scrolling,/g)).toHaveLength(2);
  });

  it("logs the helper's end report and waits for the words after a latch", () => {
    const ended = block("function scrollEnded(", "function finishScroll(");
    expect(ended).toContain(
      'debug("ScrollEnded", { reason: report.reason, ticks: report.ticks });',
    );
    expect(ended).toContain("report.session !== scrolling.session");
    expect(ended).toMatch(/scrolling\.held = true;/);
    expect(source).toMatch(
      /inputIdle: \(report\) => void resumeAfterManualInput\(report\),\s*scrollEnded,/,
    );
    expect(block("function listeningEnded()", "\n}\n")).toContain(
      "if (scrolling?.held) finishScroll();",
    );
    // A queued or texted task never starts over a helper still scrolling.
    expect(block("async function startRun(", "task = z.string()")).toContain(
      "await endScroll();",
    );
  });
});
