import { describe, expect, it } from "vitest";
import {
  aboutNotifications,
  buildDialogState,
  dialogStateJson,
  redactCodes,
  type DialogStateInput,
} from "../src/assistant/state";
import { runView } from "../src/assistant/run-view";
import type { RunView, TurnRecord } from "../src/assistant/types";
import type { Snapshot } from "../src/core/schema";

const now = new Date("2026-09-17T14:05:00Z");
const idle: RunView = {
  running: false,
  status: "idle",
  recent: [],
  queued: [],
  watches: [],
};
const turn = (
  role: TurnRecord["role"],
  text: string,
  untrusted = false,
): TurnRecord => ({
  role,
  channel: "voice",
  text,
  at: now.getTime(),
  untrusted,
});
const input = (over: Partial<DialogStateInput> = {}): DialogStateInput => ({
  channel: "voice",
  user: "how's it going?",
  view: idle,
  turns: [],
  heldByVoice: false,
  now,
  ...over,
});

function confirming(): Snapshot {
  return {
    run: {
      id: "run-1",
      task: "Email the report to Dana",
      createdAt: now.toISOString(),
      status: "confirming",
      privacy: "PRIVATE_BYOM",
      provider: "openai",
      model: "m",
      synthetic: false,
      actions: 4,
      frames: 4,
      usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
      summary: "",
    },
    frame: null,
    events: [
      {
        event_id: "e1",
        run_id: "run-1",
        sequence_number: 1,
        monotonic_timestamp: 0,
        wall_clock_timestamp: now.toISOString(),
        schema_version: 1,
        type: "ActionExecuted",
        data: {
          action: {
            type: "type_text",
            frame_id: "f",
            text: "hunter2 secret body",
          },
        },
      },
    ],
    message: "",
    pending: {
      action: { type: "click", frame_id: "f", x: 0.5, y: 0.5, button: "left" },
      reason: "Send this message?",
    },
  };
}

describe("dialog state", () => {
  it("never carries typed text, nor an approval's reason or action", () => {
    const view = runView(confirming(), {
      queued: [],
      watches: [],
      now: now.getTime(),
    });
    const json = dialogStateJson(buildDialogState(input({ view })), 6000);
    expect(json).toContain('"status":"waiting_for_approval"');
    expect(json).toContain("typed 19 characters");
    expect(json).not.toContain("hunter2");
    expect(json).not.toContain("Send this message");
    expect(json).not.toMatch(/"reason"|"action"|"pending"|"x":/);
  });

  it("includes notifications only for a question about them, with codes redacted", () => {
    const notifications = [
      "Messages, 1m ago: Your verification code is 482913",
      "Slack, 4m ago: Dana — can you look at this?",
    ];
    const asked = buildDialogState(
      input({ user: "any new messages?", notifications }),
    );
    expect(asked.notifications).toEqual([
      "Messages, 1m ago: Your verification code is [digits]",
      "Slack, 4m ago: Dana — can you look at this?",
    ]);
    const unrelated = buildDialogState(
      input({ user: "open the calendar", notifications }),
    );
    expect(unrelated.notifications).toBeUndefined();
    for (const text of [
      "did anyone text me",
      "what did I miss on slack",
      "read my notifications",
    ])
      expect([text, aboutNotifications(text)]).toEqual([text, true]);
    expect(aboutNotifications("play some jazz")).toBe(false);
    expect(redactCodes("code 1234 and 55 and 987-654")).toBe(
      "code [digits] and 55 and [digits]",
    );
  });

  it("includes agenda and open apps only when given, within their limits", () => {
    const state = buildDialogState(
      input({
        agenda: Array.from(
          { length: 12 },
          (_, i) => `${i}:00 Meeting ${"x".repeat(200)}`,
        ),
        openApps: Array.from({ length: 14 }, (_, i) => `App ${i}`),
      }),
    );
    expect(state.agenda).toHaveLength(8);
    expect(state.agenda![0].length).toBeLessThanOrEqual(160);
    expect(state.openApps).toHaveLength(10);
    expect(buildDialogState(input()).agenda).toBeUndefined();
    expect(buildDialogState(input()).openApps).toBeUndefined();
  });

  it("bounds turns to 8 × 240 and marks untrusted lines", () => {
    const turns = Array.from({ length: 12 }, (_, i) =>
      turn(
        i % 2 ? "assistant" : "user",
        `turn ${i} ${"y".repeat(300)}`,
        i === 11,
      ),
    );
    const state = buildDialogState(input({ turns }));
    expect(state.turns).toHaveLength(8);
    expect(state.turns[0].text.startsWith("turn 4")).toBe(true);
    for (const t of state.turns) expect(t.text.length).toBeLessThanOrEqual(240);
    expect(state.turns.at(-1)).toMatchObject({ untrusted: true });
    expect(state.turns[0].untrusted).toBeUndefined();
  });

  it("drops notifications, open apps, the agenda and then the oldest turns to fit", () => {
    const state = buildDialogState(
      input({
        user: "any messages?",
        notifications: ["Slack: hello there"],
        openApps: ["Safari", "Mail"],
        agenda: ["3:00 PM Design review"],
        turns: [
          turn("user", "one"),
          turn("assistant", "two"),
          turn("user", "three"),
        ],
      }),
    );
    const full = dialogStateJson(state, 10000);
    const keys = (json: string) => Object.keys(JSON.parse(json));
    expect(keys(full)).toEqual([
      "channel",
      "now",
      "user",
      "turns",
      "agenda",
      "notifications",
      "openApps",
    ]);
    const shorter = dialogStateJson(state, full.length - 1);
    expect(keys(shorter)).not.toContain("notifications");
    expect(keys(shorter)).toContain("openApps");
    const smaller = dialogStateJson(state, shorter.length - 1);
    expect(keys(smaller)).not.toContain("openApps");
    const tiny = dialogStateJson(state, 150);
    expect(keys(tiny)).not.toContain("agenda");
    const parsed = JSON.parse(tiny);
    expect(parsed.turns.length).toBeLessThan(3);
    expect(parsed.user).toBe("any messages?");
  });

  it("redacts secrets in turns, the previous reply and the user's own words", () => {
    const state = buildDialogState(
      input({
        user: "log in with password: Tr0ub4dor&3xyz and open the dashboard",
        turns: [turn("user", "my key is sk-abcdefghijklmnop1234567890")],
        previousReply:
          "Noted the token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      }),
    );
    expect(JSON.stringify(state)).not.toMatch(/sk-abcdef|ghp_abc|Tr0ub4dor/);
    expect(state.user).toMatch(/open the dashboard$/);
  });

  it("describes a run held only by this activation as working", () => {
    const view: RunView = {
      running: true,
      status: "working",
      task: "Find flights",
      minutes: 1,
      steps: 9,
      recent: ["opened Google Chrome"],
      queued: ["check my email"],
      watches: [],
    };
    const state = buildDialogState(input({ view, heldByVoice: true }));
    expect(state.run).toMatchObject({
      task: "Find flights",
      status: "working",
      steps: 9,
      heldByVoice: true,
    });
    expect(state.queued).toEqual(["check my email"]);
  });
});
