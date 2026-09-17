import { describe, expect, it, vi } from "vitest";
import {
  Conversation,
  gateOf,
  isSilentPause,
  momentKey,
  type ConversationSettings,
} from "../electron/conversation";
import {
  createSpeechOutput,
  type SpeakRequest,
  type SpeakResult,
  type SpeechOutput,
} from "../electron/speech-output";
import type { VoiceEvent } from "../electron/voice";
import type { Snapshot } from "../src/core/schema";
import { PHRASES } from "../src/voice/phrases";
import { planVoiceTurn, type TurnPlan } from "../src/voice/turns";

type Status = NonNullable<Snapshot["run"]>["status"];

function snapshot(
  status: Status,
  over: Partial<Snapshot> & {
    id?: string;
    summary?: string;
    actions?: number;
  } = {},
): Snapshot {
  const { id = "run-1", summary = "", actions = 0, ...rest } = over;
  return {
    run: {
      id,
      task: "Open Google",
      createdAt: "2026-09-17T00:00:00.000Z",
      status,
      privacy: "PRIVATE_LOCAL",
      provider: "ollama",
      model: "m",
      synthetic: false,
      actions,
      frames: 0,
      usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
      summary,
    },
    frame: null,
    events: [],
    message: "",
    ...rest,
  };
}
const approval = (reason = "Send this message?", id = "run-1") =>
  snapshot("confirming", {
    id,
    pending: {
      action: { type: "click", frame_id: "f", x: 0.5, y: 0.5, button: "left" },
      reason,
    },
  });
const paused = (message: string, sequence: number) =>
  snapshot("paused", {
    message,
    events: [
      {
        event_id: `e${sequence}`,
        run_id: "run-1",
        sequence_number: sequence,
        monotonic_timestamp: 0,
        wall_clock_timestamp: "",
        schema_version: 1,
        type: "RunPaused",
        data: {},
      },
    ],
  });

function setup(overrides: Partial<ConversationSettings> = {}) {
  const settings: ConversationSettings = {
    handsFree: false,
    voiceReplies: "voice",
    followUpListening: true,
    voiceRate: 1,
    ...overrides,
  };
  let now = 10000;
  let id = 0;
  const spoken: SpeakRequest[] = [];
  const calls: { method: string; data?: Record<string, unknown> }[] = [];
  const timers: ({ fn: () => void; at: number } | undefined)[] = [];
  const traces: { event: string; data: Record<string, unknown> }[] = [];
  let stops = 0;
  let cancels = 0;
  let changes = 0;
  let listenResult: (data?: Record<string, unknown>) => unknown = () => ({
    opened: true,
  });
  let result: (
    request: SpeakRequest,
  ) => SpeakResult | Promise<SpeakResult> = () => ({
    accepted: true,
    engine: "system",
  });
  const speech: SpeechOutput = {
    speak: async (request) => {
      spoken.push(request);
      return result(request);
    },
    cancel: () => {
      cancels++;
    },
    stop: async () => {
      stops++;
    },
    preview: async () => ({ accepted: true, engine: "system" }),
  };
  const conversation = new Conversation({
    settings: () => settings,
    speech,
    voiceCall: async (method, data) => {
      calls.push({ method, data });
      return method === "listen" ? listenResult(data) : {};
    },
    now: () => now,
    random: () => 0,
    newId: () => `u${++id}`,
    trace: (event, data) => traces.push({ event, data }),
    onChange: () => changes++,
    setTimer: (fn, ms) => timers.push({ fn, at: now + ms }) - 1,
    clearTimer: (handle) => {
      timers[handle as number] = undefined;
    },
  });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const t = {
    conversation,
    settings,
    spoken,
    calls,
    traces,
    get stops() {
      return stops;
    },
    get cancels() {
      return cancels;
    },
    get changes() {
      return changes;
    },
    texts: () => spoken.map((s) => s.text),
    listens: () =>
      calls.filter((c) => c.method === "listen").map((c) => c.data),
    advance: (ms: number) => {
      now += ms;
      for (const [i, timer] of timers.entries())
        if (timer && timer.at <= now) {
          timers[i] = undefined;
          timer.fn();
        }
    },
    now: () => now,
    flush,
    reject: (fn: typeof result) => (result = fn),
    /** The helper's reply to listen requests. */
    listenReply: (fn: typeof listenResult) => (listenResult = fn),
    event: (e: VoiceEvent) => conversation.onVoiceEvent(e),
    render: (s: Snapshot, listening = false) =>
      conversation.onSnapshot(s, { listening }),
    /** A spoken turn that started run-1. */
    voiceStart(source: "ptt" | "wake" = settings.handsFree ? "wake" : "ptt") {
      t.event({ event: source === "ptt" ? "shortcut_down" : "wake_detected" });
      t.render(snapshot("capturing"));
      conversation.acknowledge({ kind: "start", text: "Open Google" });
    },
    typedStart() {
      conversation.noteInput("text");
      t.render(snapshot("capturing"));
      conversation.acknowledge(
        { kind: "start", text: "Open Google" },
        { source: "text" },
      );
    },
    /** The helper played the current utterance to the end. */
    play(index = spoken.length - 1) {
      const utteranceId = spoken[index].utteranceId;
      t.event({ event: "speech_started", utteranceId });
      t.event({ event: "speech_finished", utteranceId, interrupted: false });
    },
  };
  return t;
}

describe("conversation: when to speak", () => {
  it("says a run moment once however often it renders", () => {
    const t = setup();
    t.voiceStart();
    expect(t.texts()).toEqual(["On it."]);
    for (let i = 0; i < 10; i++) t.render(approval());
    expect(t.texts()).toEqual(["On it.", "Send this message?"]);
    expect(t.spoken[1]).toMatchObject({ priority: "urgent" });
    expect(t.spoken[1].listen).toBeUndefined();
  });

  it("never speaks while listening, and asks once listening ends if still pending", () => {
    const t = setup();
    t.voiceStart();
    t.play();
    t.render(approval(), true);
    t.render(approval(), true);
    expect(t.texts()).toEqual(["On it."]);
    t.render(approval(), false);
    expect(t.texts()).toEqual(["On it.", "Send this message?"]);

    const u = setup();
    u.voiceStart();
    u.play();
    u.render(approval(), true);
    // Answered by click before listening ended: nothing to say.
    u.render(snapshot("executing"), false);
    expect(u.texts()).toEqual(["On it."]);
  });

  it("re-evaluates when a turn is acknowledged, since listening has ended", () => {
    const t = setup();
    t.voiceStart();
    t.play();
    t.render(approval(), true);
    t.conversation.acknowledge({ kind: "acknowledge" }, { source: "ptt" });
    expect(t.texts()).toEqual(["On it.", "Send this message?"]);
  });

  it("does not read out a moment the user just answered", () => {
    const t = setup();
    t.voiceStart();
    t.play();
    // The approval appeared while the user was saying "yes".
    t.render(approval(), true);
    t.conversation.acknowledge({ kind: "approve" }, { source: "ptt" });
    expect(t.texts()).toEqual(["On it.", "Okay."]);
    t.render(approval());
    expect(t.texts()).toEqual(["On it.", "Okay."]);

    const u = setup();
    u.voiceStart();
    u.play();
    u.render(paused("I can’t identify the control. Say continue.", 4), true);
    u.conversation.acknowledge(
      { kind: "revise", text: "use Safari" },
      { source: "ptt" },
    );
    expect(u.texts()).toEqual(["On it.", "Got it."]);
  });

  it("keeps typed and spoken starts apart when they follow each other", () => {
    const t = setup();
    t.typedStart();
    t.render(snapshot("completed", { summary: "Opened Notes." }));
    t.event({ event: "shortcut_down" });
    t.render(snapshot("capturing", { id: "run-2" }));
    t.conversation.acknowledge({ kind: "start", text: "Open Safari" });
    t.play();
    t.render(snapshot("completed", { id: "run-2", summary: "Opened Safari." }));
    expect(t.texts()).toEqual(["On it.", "Opened Safari."]);
  });

  it("mirrors modality: silent for typed runs in voice mode", () => {
    const t = setup();
    t.typedStart();
    t.render(approval());
    t.render(snapshot("completed", { summary: "Opened Notes." }));
    expect(t.spoken).toHaveLength(0);
    // A voice turn in a typed run makes the replies spoken from then on.
    const u = setup();
    u.typedStart();
    u.event({ event: "shortcut_down" });
    u.conversation.acknowledge({ kind: "revise", text: "use Safari" });
    u.render(snapshot("completed", { summary: "Opened Notes." }));
    expect(u.texts()).toEqual(["Got it.", "Opened Notes."]);
  });

  it("never speaks when replies are off, keeping answer windows but no unasked approval window", () => {
    const t = setup({ voiceReplies: "off", handsFree: true });
    t.voiceStart("ptt");
    t.render(approval("Open Notes?"));
    t.conversation.acknowledge({ kind: "confirmAgain" }, { source: "wake" });
    // Nobody heard a question: an ambient "yeah" must not approve anything.
    expect(t.listens()).toEqual([]);
    expect(t.traces).toContainEqual({
      event: "FollowUp",
      data: { phase: "skipped", window: "approval", code: "unspoken" },
    });
    t.conversation.acknowledge({ kind: "decline" }, { source: "followup" });
    expect(t.listens()).toEqual([{ kind: "answer", seconds: 8 }]);
    t.render(paused("I can’t identify the control. Say continue.", 4));
    t.conversation.acknowledge(
      { kind: "revise", text: "use Safari" },
      { source: "wake" },
    );
    expect(t.listens()).toEqual([
      { kind: "answer", seconds: 8 },
      { kind: "answer", seconds: 8 },
      { kind: "continuation", seconds: 3 },
    ]);
    t.conversation.acknowledge({ kind: "nothingRunning" }, { source: "ptt" });
    t.render(snapshot("completed", { summary: "Opened Notes." }));
    expect(t.spoken).toHaveLength(0);
  });

  it("always mode speaks typed results, questions and failures but never typed acks", () => {
    const t = setup({ voiceReplies: "always" });
    t.typedStart();
    t.conversation.acknowledge({ kind: "stillWorking" }, { source: "text" });
    expect(t.spoken).toHaveLength(0);
    t.render(snapshot("takeover", { message: "What should I search for?" }));
    t.play();
    t.render(
      snapshot("completed", {
        summary: "Opened https://www.example.com/a/b. Then more.",
      }),
    );
    expect(t.texts()).toEqual([
      "What should I search for?",
      "Opened example.com.",
    ]);
    t.render(snapshot("failed", { id: "run-2", message: "x" }));
    // run-2 was never seen running: a stale snapshot is not announced.
    expect(t.spoken).toHaveLength(2);
  });

  it("stays quiet for user-caused pauses and stops, but explains budget stops", () => {
    expect(isSilentPause("Paused. Capture and input are stopped.")).toBe(true);
    expect(isSilentPause("Paused — you’re controlling the computer.")).toBe(
      true,
    );
    const t = setup();
    t.voiceStart();
    t.play();
    t.render(
      snapshot("paused", {
        message: "Paused — you’re controlling the computer.",
      }),
    );
    t.render(snapshot("cancelled", { message: "Stopped." }));
    expect(
      momentKey(snapshot("cancelled", { message: "Stopped." })),
    ).toBeUndefined();
    expect(t.texts()).toEqual(["On it."]);
    const u = setup();
    u.voiceStart();
    u.play();
    u.render(snapshot("cancelled", { message: "Runtime budget reached." }));
    expect(u.texts()).toEqual(["On it.", PHRASES.budgetStop[0]]);
  });

  it("falls back to generic phrases when run text is not speakable", () => {
    const t = setup();
    t.voiceStart();
    t.play();
    t.render(
      snapshot("completed", { summary: "Typed password: hunter22x in." }),
    );
    expect(t.texts()).toEqual(["On it.", "Done."]);
    const u = setup();
    u.voiceStart();
    u.play();
    u.render(snapshot("failed", { message: "" }));
    expect(u.texts()[1]).toBe(PHRASES.failGeneric[0]);
  });
});

describe("conversation: priority, staleness and failures", () => {
  it("lets an approval preempt an ack and stops a reply that went stale", () => {
    const t = setup();
    t.voiceStart();
    t.render(approval());
    expect(t.texts()).toEqual(["On it.", "Send this message?"]);
    t.event({ event: "speech_started", utteranceId: t.spoken[1].utteranceId });
    expect(t.conversation.speaking).toBe(true);
    // Approved by click while the question is still being read.
    t.render(snapshot("executing"));
    expect(t.stops).toBe(1);
    expect(t.conversation.speaking).toBe(false);
  });

  it("queues a lower-priority reply behind the current one, dropping stale acks", () => {
    const t = setup();
    t.voiceStart();
    t.play();
    t.render(approval());
    t.conversation.acknowledge(
      { kind: "needClick", reason: "gate" },
      { source: "ptt" },
    );
    // needClick is urgent too: it replaces.
    expect(t.texts()).toEqual([
      "On it.",
      "Send this message?",
      PHRASES.needClick[0],
    ]);
    t.conversation.acknowledge({ kind: "stillWorking" }, { source: "ptt" });
    expect(t.spoken).toHaveLength(3);
    t.play();
    expect(t.texts().at(-1)).toBe("Still on it.");

    const u = setup();
    u.voiceStart();
    u.play();
    u.render(approval());
    u.conversation.acknowledge({ kind: "approve" }, { source: "ptt" });
    expect(u.spoken).toHaveLength(2);
    u.advance(2000);
    u.play();
    expect(u.spoken).toHaveLength(2);
  });

  it("degrades silently when speech is rejected or fails", async () => {
    const t = setup({ handsFree: true });
    t.reject(() => ({
      accepted: false,
      reason: "unsupported_language",
      engine: "system",
    }));
    t.voiceStart("wake");
    t.render(approval("Open Notes?"));
    await t.flush();
    expect(t.conversation.speaking).toBe(false);
    // The question was never heard, so no approval window opens.
    expect(t.listens()).toEqual([]);
    t.render(snapshot("takeover", { message: "Which account?" }));
    await t.flush();
    // An unspoken question still gets its answer window.
    expect(t.listens()).toEqual([{ kind: "answer", seconds: 8 }]);
    // Nothing is stuck: the next reply is sent, not queued.
    t.conversation.acknowledge({ kind: "stillWorking" }, { source: "ptt" });
    expect(t.texts().at(-1)).toBe("Still on it.");

    const u = setup();
    u.reject(() => {
      throw new Error("helper gone");
    });
    u.voiceStart();
    await u.flush();
    u.conversation.acknowledge({ kind: "nothingRunning" }, { source: "ptt" });
    expect(u.texts()).toEqual(["On it.", PHRASES.nothingRunning[0]]);

    const v = setup();
    v.voiceStart();
    v.render(approval());
    v.conversation.acknowledge({ kind: "stillWorking" }, { source: "ptt" });
    v.event({
      event: "speech_error",
      utteranceId: v.spoken[1].utteranceId,
      message: "stalled",
    });
    expect(v.texts().at(-1)).toBe("Still on it.");
    expect(
      v.traces.some(
        (x) => x.event === "VoiceReply" && x.data.phase === "error",
      ),
    ).toBe(true);
    expect(JSON.stringify(v.traces)).not.toContain("Send this message");
  });

  it("retries a reply the helper refused while the user was talking", async () => {
    const t = setup();
    t.voiceStart();
    t.play();
    let busy = true;
    t.reject(() =>
      busy
        ? { accepted: false, reason: "capturing", engine: "system" }
        : { accepted: true, engine: "system" },
    );
    t.render(approval());
    await t.flush();
    busy = false;
    t.render(approval());
    expect(t.texts()).toEqual([
      "On it.",
      "Send this message?",
      "Send this message?",
    ]);
  });

  it("forgets pending replies when the user takes the floor", () => {
    const t = setup();
    t.voiceStart();
    t.render(approval());
    t.conversation.acknowledge({ kind: "stillWorking" }, { source: "ptt" });
    t.event({ event: "shortcut_down" });
    expect(t.conversation.speaking).toBe(false);
    t.play(1);
    expect(t.spoken).toHaveLength(2);
  });

  it("stopSpeaking clears replies and stops the engine", async () => {
    const t = setup();
    t.voiceStart();
    await t.conversation.stopSpeaking();
    expect(t.stops).toBe(1);
  });

  it("repeats a pause reason briefly within a minute", () => {
    const t = setup();
    t.voiceStart();
    t.play();
    const reason =
      "I can’t identify the control. Open the target app or field, then say continue.";
    t.render(paused(reason, 5));
    t.render(paused(reason, 5));
    expect(t.texts()[1]).toBe(
      "I can’t identify the control. Open the target app or field, then hold Option Space and say continue.",
    );
    t.play();
    t.render(snapshot("capturing"));
    t.advance(30000);
    t.render(paused(reason, 9));
    expect(t.texts()[2]).toBe(PHRASES.repeatReason[0]);
    t.play();
    t.render(snapshot("capturing"));
    t.advance(61000);
    t.render(paused(reason, 14));
    expect(t.texts()[3]).toBe(t.texts()[1]);
  });

  it("re-prompts an unclear approval answer at most twice", () => {
    const t = setup();
    t.voiceStart();
    t.render(approval());
    for (let i = 0; i < 4; i++)
      t.conversation.acknowledge({ kind: "confirmAgain" }, { source: "ptt" });
    expect(
      t.texts().filter((x) => PHRASES.confirmAgain.includes(x)),
    ).toHaveLength(2);
  });
});

describe("conversation: push-to-talk and hands-free", () => {
  const acks: [TurnPlan, string][] = [
    [{ kind: "start", text: "x" }, "On it."],
    [{ kind: "revise", text: "x" }, "Got it."],
    [{ kind: "stop" }, "Stopped."],
    [{ kind: "pause" }, "Paused."],
    [{ kind: "resume" }, "Continuing."],
  ];
  it.each(acks)(
    "speaks the %j acknowledgement in both modes, reopening the hands-free window",
    (plan, text) => {
      const t = setup();
      t.render(snapshot("thinking"));
      t.conversation.acknowledge(plan, { source: "ptt" });
      expect(t.spoken[0]).toMatchObject({ text, priority: "ack" });
      expect(t.spoken[0].listen).toBeUndefined();
      const u = setup({ handsFree: true });
      u.render(snapshot("thinking"));
      u.conversation.acknowledge(plan, { source: "wake" });
      expect(u.spoken[0]).toMatchObject({ text, priority: "ack" });
      // A hands-free turn keeps listening right after the reply.
      if (["start", "revise"].includes(plan.kind))
        expect(u.spoken[0].listen).toEqual({
          kind: "continuation",
          seconds: 3,
        });
      if (plan.kind === "pause")
        expect(u.spoken[0].listen).toEqual({ kind: "answer", seconds: 8 });
    },
  );

  it("speaks approve and decline acknowledgements in both modes", () => {
    const u = setup({ handsFree: true });
    u.render(approval());
    u.conversation.acknowledge({ kind: "approve" }, { source: "followup" });
    expect(u.texts()).toEqual(["Okay."]);
  });

  it("requests follow-up windows only when hands-free with follow-up listening on", () => {
    const on = setup({ handsFree: true });
    on.voiceStart();
    on.render(approval("Open Notes?"));
    expect(on.texts()[0]).toBe("On it.");
    expect(on.spoken.at(-1)).toMatchObject({
      text: "Open Notes? Say yes or no.",
      listen: { kind: "approval", seconds: 8 },
    });
    on.play();
    on.conversation.acknowledge({ kind: "pause" }, { source: "wake" });
    on.conversation.acknowledge({ kind: "decline" }, { source: "followup" });
    // Spoken acknowledgements carry their window instead of asking separately.
    expect(on.listens()).toEqual([]);
    expect(on.spoken.at(-1)).toMatchObject({
      listen: { kind: "answer", seconds: 8 },
    });

    const off = setup({ handsFree: true, followUpListening: false });
    off.voiceStart();
    off.render(approval("Open Notes?"));
    off.conversation.acknowledge({ kind: "pause" }, { source: "wake" });
    expect(off.spoken.every((u) => u.listen === undefined)).toBe(true);
    expect(off.texts()).toContain("Open Notes?");
    expect(off.listens()).toEqual([]);

    const ptt = setup({ handsFree: false });
    ptt.voiceStart();
    ptt.render(approval());
    ptt.render(snapshot("takeover", { message: "Which account?" }));
    expect(ptt.spoken.every((s) => !s.listen)).toBe(true);
    expect(ptt.listens()).toEqual([]);
  });

  it("adds the approval suffix only to the first hands-free question", () => {
    const t = setup({ handsFree: true });
    t.voiceStart();
    t.render(approval("Open Notes?"));
    t.play();
    t.render(snapshot("executing"));
    t.render(approval("Approve this transaction?"));
    expect(t.texts()).toEqual([
      "On it.",
      "Open Notes? Say yes or no.",
      "Approve this transaction?",
    ]);
  });

  it("waits a grace window before asking about a hands-free fragment", async () => {
    const t = setup({ handsFree: true });
    t.event({ event: "wake_detected" });
    t.conversation.acknowledge(
      { kind: "clarify", question: "Open what?", fragment: "Open" },
      { source: "wake" },
    );
    expect(t.conversation.fragment).toMatchObject({ text: "Open" });
    expect(t.listens()).toEqual([{ kind: "answer", seconds: 3 }]);
    expect(t.spoken).toHaveLength(0);
    t.event({ event: "followup_open", kind: "answer", seconds: 3 });
    expect(t.conversation.followUp).toBe("answer");
    t.event({ event: "followup_closed", kind: "answer", endReason: "timeout" });
    expect(t.spoken).toEqual([
      expect.objectContaining({
        text: "Open what?",
        priority: "urgent",
        listen: { kind: "answer", seconds: 8 },
      }),
    ]);
    // The fallback timer does not ask twice.
    t.advance(10000);
    expect(t.spoken).toHaveLength(1);
    expect(t.conversation.fragment).toMatchObject({ text: "Open" });
  });

  it("does not ask when the rest of the sentence arrives in the grace window", () => {
    const t = setup({ handsFree: true });
    t.event({ event: "wake_detected" });
    t.conversation.acknowledge(
      { kind: "clarify", question: "I’m listening.", fragment: "can you" },
      { source: "wake" },
    );
    t.event({ event: "followup_open", kind: "answer", seconds: 3 });
    t.event({ event: "followup_detected", kind: "answer" });
    t.event({
      event: "followup_closed",
      kind: "answer",
      endReason: "detected",
    });
    t.advance(10000);
    expect(t.spoken).toHaveLength(0);
    const context = t.conversation.planContext();
    expect(context).toMatchObject({ source: "followup", window: "answer" });
    const plan = planVoiceTurn({
      text: "open Safari",
      confidence: 0.9,
      gateMatches: false,
      now: t.now(),
      ...context,
    });
    expect(plan).toEqual({ kind: "start", text: "can you open Safari" });
  });

  it("asks anyway if the helper never reports the grace window", async () => {
    const t = setup({ handsFree: true });
    t.conversation.acknowledge(
      { kind: "clarify", question: "Open what?", fragment: "Open" },
      { source: "wake" },
    );
    t.advance(4999);
    expect(t.spoken).toHaveLength(0);
    t.advance(1);
    expect(t.texts()).toEqual(["Open what?"]);
  });

  it("asks push-to-talk fragments immediately and varies the generic question", () => {
    const t = setup();
    t.conversation.acknowledge(
      { kind: "clarify", question: "Open what?", fragment: "Open" },
      { source: "ptt" },
    );
    expect(t.spoken[0]).toMatchObject({
      text: "Open what?",
      priority: "urgent",
    });
    expect(t.spoken[0].listen).toBeUndefined();
    t.play();
    t.conversation.acknowledge(
      { kind: "clarify", question: PHRASES.goOn[0], fragment: "can you" },
      { source: "ptt" },
    );
    t.play();
    t.conversation.acknowledge(
      { kind: "clarify", question: PHRASES.goOn[0], fragment: "can you" },
      { source: "ptt" },
    );
    expect(t.texts().slice(1)).toEqual([PHRASES.goOn[0], PHRASES.goOn[1]]);
    // A fragment expires, and any executed plan clears it.
    t.advance(21000);
    expect(t.conversation.fragment).toBeUndefined();
    t.conversation.acknowledge(
      { kind: "clarify", question: "Open what?", fragment: "Open" },
      { source: "ptt" },
    );
    t.conversation.acknowledge(
      { kind: "start", text: "Open Safari" },
      { source: "ptt" },
    );
    expect(t.conversation.fragment).toBeUndefined();
  });

  it("captures the approval gate for a follow-up window", () => {
    const t = setup({ handsFree: true });
    t.voiceStart();
    const s = approval();
    t.render(s);
    t.play();
    expect(t.conversation.windowGate).toBeUndefined();
    t.event({ event: "followup_open", kind: "approval", seconds: 8 });
    expect(t.conversation.followUp).toBe("approval");
    expect(t.conversation.windowGate).toBe(gateOf(s));
    t.event({ event: "followup_detected", kind: "approval" });
    t.conversation.interrupted();
    expect(t.conversation.windowGate).toBe(gateOf(s));
    t.advance(900);
    const context = t.conversation.planContext();
    expect(context).toMatchObject({
      source: "followup",
      window: "approval",
      turnMs: 900,
    });
    t.conversation.acknowledge({ kind: "approve" });
    expect(t.conversation.windowGate).toBeUndefined();

    const u = setup({ handsFree: true });
    u.voiceStart();
    u.render(approval());
    u.play();
    u.event({ event: "followup_open", kind: "approval", seconds: 8 });
    u.event({
      event: "followup_closed",
      kind: "approval",
      endReason: "timeout",
    });
    expect(u.conversation.windowGate).toBeUndefined();
    expect(u.conversation.followUp).toBeUndefined();
  });

  it("merges a hands-free continuation into the task it just started", () => {
    const t = setup({ handsFree: true });
    t.event({ event: "wake_detected" });
    t.render(snapshot("capturing"));
    t.conversation.acknowledge({ kind: "start", text: "Open Google" });
    expect(t.conversation.lastTurn).toMatchObject({
      plan: "start",
      runId: "run-1",
    });
    t.render(snapshot("thinking"));
    t.advance(1200);
    t.event({ event: "followup_detected", kind: "continuation" });
    t.advance(1500);
    const plan = planVoiceTurn({
      text: "and check the weather",
      confidence: 0.9,
      gateMatches: false,
      now: t.now(),
      run: {
        id: "run-1",
        status: "thinking",
        actions: 0,
        held: false,
        task: "Open Google",
      },
      ...t.conversation.planContext(),
    });
    expect(plan).toEqual({
      kind: "amendTask",
      text: "Open Google and check the weather",
    });
  });

  it("binds a start plan to a run that appears afterwards", () => {
    const t = setup();
    t.event({ event: "shortcut_down" });
    t.conversation.acknowledge({ kind: "start", text: "Open Google" });
    t.render(snapshot("capturing", { id: "run-9" }));
    expect(t.conversation.lastTurn).toMatchObject({ runId: "run-9" });
    t.play();
    t.render(snapshot("completed", { id: "run-9", summary: "Opened Google." }));
    expect(t.texts()).toEqual(["On it.", "Opened Google."]);
  });

  it("holds the done pill until the spoken result ends", () => {
    const t = setup();
    t.voiceStart();
    t.play();
    t.render(
      snapshot("completed", { summary: "Checked the weather in Google." }),
    );
    const id = t.spoken[1].utteranceId;
    expect(t.conversation.doneHoldMs("run-1")).toBeGreaterThan(1800);
    expect(t.conversation.doneHoldMs("run-1")).toBeLessThanOrEqual(8000);
    t.advance(200);
    t.event({ event: "speech_started", utteranceId: id });
    t.advance(2800);
    t.event({ event: "speech_finished", utteranceId: id, interrupted: false });
    expect(t.conversation.doneHoldMs("run-1")).toBe(600);
    t.advance(600);
    expect(t.conversation.doneHoldMs("run-1")).toBe(0);
    expect(t.changes).toBeGreaterThan(0);

    const quiet = setup();
    quiet.typedStart();
    quiet.render(snapshot("completed", { summary: "Done." }));
    expect(quiet.conversation.doneHoldMs("run-1")).toBe(1800);
    quiet.advance(1000);
    expect(quiet.conversation.doneHoldMs("run-1")).toBe(800);
  });

  it("holds cards that belong to no run, or to an older run, for 1.8 s", () => {
    const t = setup();
    t.voiceStart();
    t.play();
    t.render(snapshot("completed", { summary: "Opened Google." }));
    t.play();
    t.advance(3000);
    // "Stopped.", "Nothing is running.", "Okay.", "Didn’t hear anything."
    expect(t.conversation.doneHoldMs()).toBe(1800);
    expect(t.conversation.doneHoldMs("run-2")).toBe(1800);
    expect(t.conversation.doneHoldMs("run-1")).toBe(0);
    t.advance(6000);
    expect(t.conversation.doneHoldMs()).toBe(1800);
    // The same run's card shown again after 8 s is a new card.
    expect(t.conversation.doneHoldMs("run-1")).toBe(1800);
  });
});

describe("conversation: interruptions, windows and fragments", () => {
  it("cancels an in-flight cloud reply when the user takes the floor", () => {
    const t = setup({ handsFree: true });
    for (const e of [
      { event: "shortcut_down" },
      { event: "wake_detected" },
      { event: "followup_detected", kind: "answer" },
    ] as VoiceEvent[]) {
      const before = t.cancels;
      t.event(e);
      expect(t.cancels).toBe(before + 1);
    }
    expect(t.stops).toBe(0);
  });

  it("never speaks an interrupted cloud reply when its request fails afterwards", async () => {
    const helper: string[] = [];
    let respond!: (response: Response) => void;
    let signal: AbortSignal | undefined;
    const speech = createSpeechOutput({
      settings: () => ({ privacy: "PRIVATE_BYOM", voiceEngine: "openai" }),
      openaiKey: () => "sk-test",
      voiceCall: async (method) => {
        helper.push(method);
        if (method === "playPcmStart") return { accepted: true };
        // Key-down already dropped the utterance inside the helper.
        if (method === "playPcmAbort")
          return { aborted: false, started: false };
        return { accepted: true };
      },
      fetch: ((_url: string, init: RequestInit) => {
        signal = init.signal ?? undefined;
        return new Promise<Response>((resolve) => (respond = resolve));
      }) as unknown as typeof fetch,
    });
    let id = 0;
    const conversation = new Conversation({
      settings: () => ({ handsFree: true, voiceReplies: "voice" }),
      speech,
      voiceCall: async (method) => {
        helper.push(method);
        return { opened: true };
      },
      newId: () => `u${++id}`,
    });
    conversation.onVoiceEvent({ event: "wake_detected" });
    conversation.noteInput("voice");
    conversation.onSnapshot(snapshot("capturing"), { listening: false });
    conversation.onSnapshot(approval("Open Notes?"), { listening: false });
    await vi.waitFor(() => expect(signal).toBeDefined());
    conversation.onVoiceEvent({ event: "shortcut_down" });
    expect(signal?.aborted).toBe(true);
    respond({ ok: false, status: 503, body: null } as Response);
    await vi.waitFor(() => expect(helper).toContain("playPcmAbort"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(helper).toEqual(["playPcmStart", "playPcmAbort"]);
  });

  it("turns the follow-up glow off when a wake phrase is heard inside a window", () => {
    const t = setup({ handsFree: true });
    t.event({ event: "followup_open", kind: "answer", seconds: 8 });
    expect(t.conversation.followUp).toBe("answer");
    t.event({ event: "wake_detected" });
    t.event({
      event: "followup_closed",
      kind: "answer",
      endReason: "detected",
    });
    expect(t.conversation.followUp).toBeUndefined();
    t.advance(30000);
    expect(t.conversation.followUp).toBeUndefined();
    expect(t.conversation.planContext()).toMatchObject({ source: "wake" });

    // A detected window outlives its own close until the turn is acknowledged.
    const u = setup({ handsFree: true });
    u.event({ event: "followup_open", kind: "answer", seconds: 8 });
    u.event({ event: "followup_detected", kind: "answer" });
    u.event({
      event: "followup_closed",
      kind: "answer",
      endReason: "detected",
    });
    expect(u.conversation.followUp).toBeUndefined();
    expect(u.conversation.planContext()).toMatchObject({
      source: "followup",
      window: "answer",
    });
  });

  it("asks a hands-free question at once when the helper refuses its grace window", async () => {
    for (const reason of ["speaking", "disabled", "secure_input"]) {
      const t = setup({ handsFree: true });
      t.listenReply(() => ({ opened: false, reason }));
      t.event({ event: "wake_detected" });
      t.conversation.acknowledge(
        { kind: "clarify", question: "Open what?", fragment: "Open" },
        { source: "wake" },
      );
      expect(t.spoken).toHaveLength(0);
      await t.flush();
      expect(t.texts()).toEqual(["Open what?"]);
      expect(t.traces).toContainEqual({
        event: "FollowUp",
        data: { phase: "refused", window: "answer", code: reason },
      });
      // The fallback timer does not ask twice.
      t.advance(10000);
      expect(t.spoken).toHaveLength(1);
    }
    // A window deferred until the echo guard ends is open, not refused.
    const d = setup({ handsFree: true });
    d.listenReply(() => ({ opened: true, deferred: true }));
    d.event({ event: "wake_detected" });
    d.conversation.acknowledge(
      { kind: "clarify", question: "Open what?", fragment: "Open" },
      { source: "wake" },
    );
    await d.flush();
    expect(d.spoken).toHaveLength(0);
  });

  it("clearFragment forgets the fragment and a question not yet asked", async () => {
    const t = setup({ handsFree: true });
    t.event({ event: "wake_detected" });
    t.conversation.acknowledge(
      { kind: "clarify", question: "Open what?", fragment: "Open" },
      { source: "wake" },
    );
    t.event({ event: "followup_open", kind: "answer", seconds: 3 });
    // Dismissed, or a typed command.
    t.conversation.clearFragment();
    expect(t.conversation.planContext(false).fragment).toBeUndefined();
    t.event({ event: "followup_closed", kind: "answer", endReason: "timeout" });
    t.advance(10000);
    expect(t.spoken).toHaveLength(0);
  });

  it("ends a hands-free fragment when its asked question goes unanswered", () => {
    const t = setup({ handsFree: true });
    t.event({ event: "wake_detected" });
    t.conversation.acknowledge(
      { kind: "clarify", question: "Open what?", fragment: "Open" },
      { source: "wake" },
    );
    t.event({ event: "followup_open", kind: "answer", seconds: 3 });
    t.event({ event: "followup_closed", kind: "answer", endReason: "timeout" });
    // The grace window's timeout asks; it does not end the fragment.
    expect(t.texts()).toEqual(["Open what?"]);
    expect(t.conversation.fragment).toMatchObject({ text: "Open" });
    t.play();
    t.event({ event: "followup_open", kind: "answer", seconds: 8 });
    expect(t.conversation.fragment).toMatchObject({ text: "Open" });
    t.advance(8000);
    t.event({ event: "followup_closed", kind: "answer", endReason: "timeout" });
    expect(t.conversation.fragment).toBeUndefined();
    expect(t.conversation.planContext(false).fragment).toBeUndefined();
    expect(t.conversation.planContext().fragment).toBeUndefined();

    // An answer detected in the window keeps it for the plan.
    const u = setup({ handsFree: true });
    u.event({ event: "wake_detected" });
    u.conversation.acknowledge(
      { kind: "clarify", question: "Open what?", fragment: "Open" },
      { source: "wake" },
    );
    u.event({ event: "followup_open", kind: "answer", seconds: 3 });
    u.event({ event: "followup_closed", kind: "answer", endReason: "timeout" });
    u.play();
    u.event({ event: "followup_open", kind: "answer", seconds: 8 });
    u.event({ event: "followup_detected", kind: "answer" });
    u.event({
      event: "followup_closed",
      kind: "answer",
      endReason: "detected",
    });
    expect(u.conversation.planContext().fragment).toMatchObject({
      text: "Open",
    });
  });

  it("ends a fragment when its window is cancelled, unless the key-down is the answer", () => {
    const t = setup({ handsFree: true });
    t.event({ event: "wake_detected" });
    t.conversation.acknowledge(
      { kind: "clarify", question: "Open what?", fragment: "Open" },
      { source: "wake" },
    );
    t.event({ event: "followup_open", kind: "answer", seconds: 3 });
    // Secure input or a click closed the grace window.
    t.event({ event: "followup_closed", kind: "answer", endReason: "cancel" });
    expect(t.conversation.fragment).toBeUndefined();
    t.advance(10000);
    expect(t.spoken).toHaveLength(0);
    // A later key-down does not bring it back.
    t.event({ event: "shortcut_down" });
    expect(t.conversation.fragment).toBeUndefined();

    // Option-Space inside the asked window closes it just before shortcut_down.
    const u = setup({ handsFree: true });
    u.event({ event: "wake_detected" });
    u.conversation.acknowledge(
      { kind: "clarify", question: "Open what?", fragment: "Open" },
      { source: "wake" },
    );
    u.event({ event: "followup_open", kind: "answer", seconds: 3 });
    u.event({ event: "followup_closed", kind: "answer", endReason: "timeout" });
    u.play();
    u.event({ event: "followup_open", kind: "answer", seconds: 8 });
    u.advance(2000);
    u.event({ event: "followup_closed", kind: "answer", endReason: "cancel" });
    u.event({ event: "shortcut_down" });
    u.advance(1500);
    const context = u.conversation.planContext();
    expect(context).toMatchObject({
      source: "ptt",
      fragment: { text: "Open" },
    });
    expect(
      planVoiceTurn({
        text: "Safari",
        confidence: 0.9,
        gateMatches: false,
        now: u.now(),
        ...context,
      }),
    ).toEqual({ kind: "start", text: "Open Safari" });
  });

  it("never extends a fragment past 20 s by asking its question", () => {
    const t = setup({ handsFree: true });
    const heard = t.now();
    t.event({ event: "wake_detected" });
    t.conversation.acknowledge(
      { kind: "clarify", question: "Open what?", fragment: "Open" },
      { source: "wake" },
    );
    t.event({ event: "followup_open", kind: "answer", seconds: 3 });
    t.advance(3000);
    t.event({ event: "followup_closed", kind: "answer", endReason: "timeout" });
    expect(t.texts()).toEqual(["Open what?"]);
    expect(t.conversation.fragment?.until).toBe(heard + 20000);
    t.advance(16999);
    expect(t.conversation.fragment).toMatchObject({ text: "Open" });
    t.advance(1);
    expect(t.conversation.fragment).toBeUndefined();

    // The fallback timer asks without extending it either.
    const u = setup({ handsFree: true });
    const start = u.now();
    u.conversation.acknowledge(
      { kind: "clarify", question: "Open what?", fragment: "Open" },
      { source: "wake" },
    );
    u.advance(5000);
    expect(u.texts()).toEqual(["Open what?"]);
    expect(u.conversation.fragment?.until).toBe(start + 20000);
  });

  it("keeps a follow-up detected while main still executes the previous plan", () => {
    const t = setup({ handsFree: true });
    t.event({ event: "wake_detected" });
    t.render(snapshot("capturing"));
    const first = t.conversation.planContext();
    expect(first).toMatchObject({ source: "wake", activationAt: t.now() });
    t.advance(400);
    // The continuation is heard before main acknowledges the start.
    t.event({ event: "followup_open", kind: "continuation", seconds: 3 });
    t.event({ event: "followup_detected", kind: "continuation" });
    t.event({
      event: "followup_closed",
      kind: "continuation",
      endReason: "detected",
    });
    t.conversation.acknowledge(
      { kind: "start", text: "Open Google" },
      {
        source: first.source,
        handsFree: true,
        activationAt: first.activationAt,
      },
    );
    t.render(snapshot("thinking"));
    t.advance(1500);
    const second = t.conversation.planContext();
    expect(second).toMatchObject({
      source: "followup",
      window: "continuation",
      turnMs: 1500,
      activationAt: t.now() - 1500,
    });
    const plan = planVoiceTurn({
      text: "and check the weather",
      confidence: 0.9,
      gateMatches: false,
      now: t.now(),
      run: {
        id: "run-1",
        status: "thinking",
        actions: 0,
        held: false,
        task: "Open Google",
      },
      ...second,
    });
    expect(plan).toEqual({
      kind: "amendTask",
      text: "Open Google and check the weather",
    });
    t.conversation.acknowledge(plan, {
      source: second.source,
      activationAt: second.activationAt,
    });
    expect(t.conversation.planContext()).toMatchObject({ source: "wake" });
    expect(t.conversation.planContext().activationAt).toBeUndefined();

    // Without activationAt, only activations from before planContext are used up.
    const u = setup({ handsFree: true });
    u.voiceStart();
    u.render(approval("Open Notes?"));
    u.play();
    u.event({ event: "shortcut_down" });
    const legacy = u.conversation.planContext();
    u.advance(300);
    u.event({ event: "followup_open", kind: "approval", seconds: 8 });
    u.event({ event: "followup_detected", kind: "approval" });
    const gate = u.conversation.windowGate;
    expect(gate).toBe(gateOf(approval("Open Notes?")));
    u.conversation.acknowledge(
      { kind: "stillWorking" },
      { source: legacy.source },
    );
    expect(u.conversation.windowGate).toBe(gate);
    expect(u.conversation.planContext()).toMatchObject({
      source: "followup",
      window: "approval",
    });
    u.conversation.acknowledge({ kind: "approve" }, { source: "followup" });
    expect(u.conversation.windowGate).toBeUndefined();
    expect(u.conversation.planContext().source).toBe("wake");
  });

  it("reset forgets what the helper was doing but not what was said", () => {
    const t = setup({ handsFree: true });
    t.voiceStart();
    const s = approval("Open Notes?");
    t.render(s);
    expect(t.texts()[0]).toBe("On it.");
    const approvalUtterance = t.spoken.at(-1)!;
    t.event({
      event: "speech_started",
      utteranceId: approvalUtterance.utteranceId,
    });
    t.conversation.acknowledge({ kind: "stillWorking" }, { source: "wake" });
    expect(t.spoken).toHaveLength(2);
    expect(t.conversation.speaking).toBe(true);
    const changes = t.changes;
    const cancels = t.cancels;
    t.conversation.reset();
    expect(t.conversation.speaking).toBe(false);
    expect(t.changes).toBe(changes + 1);
    expect(t.cancels).toBe(cancels + 1);
    // Nothing queued is sent later, and the approval is not asked again.
    t.event({
      event: "speech_finished",
      utteranceId: approvalUtterance.utteranceId,
      interrupted: true,
    });
    t.render(s);
    expect(t.spoken).toHaveLength(2);
    // Nothing is stuck either: the next reply goes straight out.
    t.conversation.acknowledge({ kind: "stillWorking" }, { source: "wake" });
    expect(t.texts()).toEqual([
      "On it.",
      "Open Notes? Say yes or no.",
      "Still on it.",
    ]);

    const u = setup({ handsFree: true });
    u.event({ event: "followup_open", kind: "approval", seconds: 8 });
    u.event({ event: "shortcut_down" });
    u.conversation.clarify("Open what?", "Open", { source: "wake" });
    expect(u.conversation.followUp).toBe("approval");
    expect(u.conversation.planContext().source).toBe("ptt");
    u.conversation.reset();
    expect(u.conversation.followUp).toBeUndefined();
    expect(u.conversation.windowGate).toBeUndefined();
    expect(u.conversation.planContext().source).toBe("wake");
    u.advance(10000);
    expect(u.spoken).toHaveLength(0);
  });
});
