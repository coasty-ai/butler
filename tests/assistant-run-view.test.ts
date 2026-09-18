import { describe, expect, it } from "vitest";
import { actionSchema, type Run, type Snapshot } from "../src/core/schema";
import { stepLine } from "../src/assistant/steps";
import { runView, statusLine } from "../src/assistant/run-view";
import { voiceIntent } from "../src/voice/turns";

const action = (input: Record<string, unknown>) =>
  actionSchema.parse({ frame_id: "f", ...input });
const now = Date.parse("2026-09-17T12:10:00.000Z");
function run(over: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    task: "Email Dana the Q3 deck",
    createdAt: "2026-09-17T12:03:30.000Z",
    status: "executing",
    privacy: "PRIVATE_LOCAL",
    provider: "ollama",
    model: "m",
    synthetic: false,
    actions: 4,
    frames: 4,
    usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
    summary: "",
    ...over,
  };
}
function snapshot(
  over: Omit<Partial<Snapshot>, "run"> & { run?: Partial<Run> } = {},
): Snapshot {
  const { run: runOver, ...rest } = over;
  return {
    run: run(runOver),
    frame: null,
    events: [],
    message: "",
    ...rest,
  };
}
const executed = (
  input: Record<string, unknown>,
  at = "2026-09-17T12:05:00.000Z",
) => ({
  event_id: crypto.randomUUID(),
  run_id: "run-1",
  sequence_number: 1,
  monotonic_timestamp: 0,
  wall_clock_timestamp: at,
  schema_version: 1 as const,
  type: "ActionExecuted",
  data: { action: action(input), frame_id: "f" },
});
const empty = { queued: [], watches: [], now };

describe("step lines", () => {
  it("never include typed text, only its length", () => {
    const secret = "my password is hunter2 and my pin is 4821";
    const line = stepLine(action({ type: "type_text", text: secret }))!;
    expect(line).toBe(`typed ${secret.length} characters`);
    expect(line).not.toMatch(/hunter2|4821|password/);
    expect(stepLine(action({ type: "type_text", text: "x" }))).toBe(
      "typed 1 character",
    );
  });

  it("describe each action kind without coordinates or paths", () => {
    expect(stepLine(action({ type: "open_app", name: "Safari" }))).toBe(
      "opened Safari",
    );
    expect(
      stepLine(
        action({ type: "open_file", path: "~/Documents/Taxes/2025.pdf" }),
      ),
    ).toBe("opened 2025.pdf");
    expect(
      stepLine(action({ type: "menu_item", path: ["Playback", "Play"] })),
    ).toBe("chose Playback › Play");
    expect(
      stepLine(action({ type: "click_control", label: "Send message" })),
    ).toBe("clicked “Send message”");
    expect(
      stepLine(action({ type: "click_control", label: "x".repeat(80) })),
    ).toBe(`clicked “${"x".repeat(59)}…”`);
    expect(stepLine(action({ type: "key", key: "ENTER" }))).toBe(
      "pressed ENTER",
    );
    expect(stepLine(action({ type: "hotkey", keys: ["CMD", "S"] }))).toBe(
      "pressed CMD+S",
    );
    for (const type of ["click", "double_click", "right_click", "move"])
      expect(stepLine(action({ type, x: 0.25, y: 0.75 }))).toBe(
        "clicked on the screen",
      );
    expect(
      stepLine(
        action({
          type: "drag",
          start_x: 0,
          start_y: 0,
          end_x: 1,
          end_y: 1,
          duration_ms: 200,
        }),
      ),
    ).toBe("dragged");
    expect(stepLine(action({ type: "scroll", delta_x: 0, delta_y: 5 }))).toBe(
      "scrolled",
    );
    for (const input of [
      { type: "wait", milliseconds: 10 },
      { type: "capture" },
      { type: "done", summary: "Done." },
      { type: "fail", reason: "No." },
      { type: "request_user", reason: "Which one?" },
    ])
      expect(stepLine(action(input))).toBeUndefined();
  });

  it("redacts credentials in labels and names, and stays short", () => {
    expect(
      stepLine(action({ type: "open_app", name: "sk-abcdefghijklmnop1234" })),
    ).toBe("opened [omitted]");
    expect(
      stepLine(action({ type: "open_app", name: "A".repeat(100) })),
    ).toHaveLength(100);
  });

  it("names the coding agent a relayed request went to", () => {
    // Not in the action schema yet (increment 5B): the line is pinned now so
    // that lane inherits it.
    const relay = (agent?: string) =>
      ({
        type: "agent_prompt",
        text: "run the tests",
        agent,
        frame_id: "f",
      }) as unknown as Parameters<typeof stepLine>[0];
    expect(stepLine(relay("claude-code"))).toBe(
      "sent a request to Claude Code",
    );
    expect(stepLine(relay())).toBe("sent a request to the coding agent");
    expect(
      stepLine({ type: "something_new" } as unknown as Parameters<
        typeof stepLine
      >[0]),
    ).toBeUndefined();
  });
});

describe("run view", () => {
  it("is idle with no run, and remembers what finished last", () => {
    expect(runView(undefined, empty)).toEqual({
      running: false,
      status: "idle",
      recent: [],
      queued: [],
      watches: [],
    });
    const done = run({
      status: "completed",
      summary: "Sent the deck to Dana.",
      createdAt: "2026-09-17T12:00:00.000Z",
    });
    const view = runView(
      snapshot({
        run: done,
        events: [
          executed({ type: "key", key: "ENTER" }, "2026-09-17T12:07:00.000Z"),
        ],
      }),
      empty,
    );
    expect(view.status).toBe("idle");
    expect(view.lastFinished).toEqual({
      task: "Email Dana the Q3 deck",
      outcome: "completed",
      summary: "Sent the deck to Dana.",
      minutesAgo: 3,
    });
    // An older run only knows when it started, so the floor is honest.
    expect(
      runView(undefined, { ...empty, lastFinished: done }).lastFinished,
    ).toMatchObject({ minutesAgo: 10 });
    expect(
      runView(snapshot({ run: { status: "cancelled" } }), empty).lastFinished,
    ).toMatchObject({ outcome: "stopped" });
    expect(
      runView(snapshot({ run: { status: "failed" } }), empty).lastFinished,
    ).toMatchObject({ outcome: "failed" });
  });

  it("omits a summary about typed or quoted text", () => {
    const view = runView(
      snapshot({
        run: { status: "completed", summary: 'Typed "hunter2" into the form.' },
      }),
      empty,
    );
    expect(view.lastFinished && "summary" in view.lastFinished).toBe(false);
  });

  it("maps the run's state and carries only safe facts", () => {
    const s = snapshot({
      frame: {
        id: "f",
        sha256: "",
        image: "",
        geometry: {
          display_id: 1,
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          native_width: 1,
          native_height: 1,
          model_width: 1,
          model_height: 1,
          scale_factor: 1,
        },
        capturedAt: 0,
        synthetic: false,
        context: { appName: "Mail", windowTitle: "Q3 deck — secret budget" },
      },
      events: [
        executed({ type: "open_app", name: "Mail" }),
        executed({ type: "type_text", text: "the password is hunter2" }),
        executed({ type: "click", x: 0.1, y: 0.2 }),
        executed({ type: "key", key: "TAB" }),
        executed({ type: "key", key: "ENTER" }),
        executed({ type: "scroll", delta_x: 0, delta_y: 1 }),
        executed({ type: "click_control", label: "Attach" }),
      ],
    });
    const view = runView(s, {
      queued: [{ id: "q1", text: "check my email", origin: "voice", at: 0 }],
      watches: [],
      now,
    });
    expect(view).toEqual({
      running: true,
      status: "working",
      task: "Email Dana the Q3 deck",
      minutes: 6,
      steps: 4,
      app: "Mail",
      recent: [
        "typed 23 characters",
        "clicked on the screen",
        "pressed TAB",
        "pressed ENTER",
        "scrolled",
        "clicked “Attach”",
      ],
      queued: ["check my email"],
      watches: [],
    });
    expect(JSON.stringify(view)).not.toMatch(/hunter2|secret budget/);
  });

  it("reports an approval as waiting, with neither its action nor its reason", () => {
    const view = runView(
      snapshot({
        run: { status: "confirming" },
        pending: {
          action: action({ type: "type_text", text: "wire 5000 dollars" }),
          reason: "Send this message?",
        },
        message: "Send this message?",
      }),
      empty,
    );
    expect(view.status).toBe("waiting_for_approval");
    expect(view.question).toBeUndefined();
    expect(JSON.stringify(view)).not.toMatch(/wire|5000|Send this/);
  });

  it("carries the run's question while it waits for the user, and pauses", () => {
    expect(
      runView(
        snapshot({
          run: { status: "takeover" },
          message: "Which account should I use?",
        }),
        empty,
      ),
    ).toMatchObject({
      status: "waiting_for_you",
      question: "Which account should I use?",
    });
    expect(
      runView(snapshot({ run: { status: "paused" } }), empty),
    ).toMatchObject({ status: "paused" });
    for (const status of ["capturing", "thinking"] as const)
      expect(runView(snapshot({ run: { status } }), empty)).toMatchObject({
        status: "working",
      });
  });

  it("counts a run paused only by the asking activation as working", () => {
    // "Hey Assist, how's it going?" pauses the run to listen; it resumes once
    // answered, so the answer says it is still on it, not waiting.
    const held = snapshot({
      run: { status: "paused" },
      message: "Paused. Capture and input are stopped.",
      frame: { context: { appName: "Mail" } } as Snapshot["frame"],
    });
    const view = runView(held, { ...empty, heldByVoice: true });
    expect(view).toMatchObject({ status: "working", steps: 4, app: "Mail" });
    expect(statusLine(view)).toBe("Still on it. I’m in Mail, 4 steps so far.");
    expect(statusLine(runView(held, { ...empty, heldByVoice: false }))).toBe(
      "It’s paused, waiting for you.",
    );
    expect(statusLine(runView(held, empty))).toBe(
      "It’s paused, waiting for you.",
    );
    // The flag describes a pause only; a takeover or approval is what it is.
    expect(
      runView(snapshot({ run: { status: "takeover" } }), {
        ...empty,
        heldByVoice: true,
      }),
    ).toMatchObject({ status: "waiting_for_you" });
  });
});

describe("status lines", () => {
  const actionable = new Set(["stop", "pause", "resume", "approve", "decline"]);
  const safe = (text: string) => {
    for (const sentence of text.split(/(?<=[.!?])\s+/))
      expect([sentence, actionable.has(voiceIntent(sentence).kind)]).toEqual([
        sentence,
        false,
      ]);
    expect(text).not.toMatch(/\bassist\b/i);
    expect(text.split(/(?<=[.!?])\s+/).length).toBeLessThanOrEqual(3);
  };

  it("are truthful for every state and never actionable", () => {
    const base = {
      running: true as const,
      recent: [],
      queued: [],
      watches: [],
    };
    const lines = {
      working: statusLine({
        ...base,
        status: "working",
        steps: 3,
        app: "Mail",
      }),
      workingNoApp: statusLine({ ...base, status: "working", steps: 1 }),
      approval: statusLine({ ...base, status: "waiting_for_approval" }),
      you: statusLine({
        ...base,
        status: "waiting_for_you",
        question: "Which account should I use?",
      }),
      youNoQuestion: statusLine({ ...base, status: "waiting_for_you" }),
      paused: statusLine({ ...base, status: "paused" }),
      idle: statusLine({ ...base, running: false, status: "idle" }),
      finished: statusLine({
        ...base,
        running: false,
        status: "idle",
        lastFinished: { task: "t", outcome: "completed", minutesAgo: 3 },
      }),
      stopped: statusLine({
        ...base,
        running: false,
        status: "idle",
        lastFinished: { task: "t", outcome: "stopped", minutesAgo: 0 },
      }),
      failed: statusLine({
        ...base,
        running: false,
        status: "idle",
        lastFinished: { task: "t", outcome: "failed", minutesAgo: 1 },
      }),
      queued: statusLine({
        ...base,
        status: "working",
        steps: 2,
        queued: ["a", "b"],
      }),
    };
    expect(lines).toEqual({
      working: "Still on it. I’m in Mail, 3 steps so far.",
      workingNoApp: "Still on it. 1 step so far.",
      approval: "I’m waiting for your okay on the next step.",
      you: "I need you for this one: Which account should I use?",
      youNoQuestion: "I need you at the Mac for this one.",
      paused: "It’s paused, waiting for you.",
      idle: "Nothing’s running right now.",
      finished: "Nothing’s running. The last task finished 3 minutes ago.",
      stopped: "Nothing’s running. The last task was stopped just now.",
      failed: "Nothing’s running. The last task didn’t finish 1 minute ago.",
      queued: "Still on it. 2 steps so far. 2 more tasks waiting after this.",
    });
    for (const line of Object.values(lines)) safe(line);
  });
});
