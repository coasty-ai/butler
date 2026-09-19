import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The dialog prompt without its ACT rules: the act question cannot be built
 * from it. The mock is hoisted, so electron/assistant.ts and electron/jev.ts
 * both load over the broken prompt, as the app would after a prompt edit
 * that tests/eval-jev.test.ts had not caught. The decider must then stay
 * out of the way: nothing asked, nothing started, the stream untouched.
 */
vi.mock("../src/assistant/prompt", async (importOriginal) => {
  const real = (await importOriginal()) as { DIALOG_SYSTEM: string };
  return {
    ...real,
    DIALOG_SYSTEM: real.DIALOG_SYSTEM.replace(
      "How to choose ACT:",
      "How to pick ACT:",
    ),
  };
});

import { AssistantSession } from "../electron/assistant";
import { JEV_ACT_QUESTION } from "../electron/jev";
import { forgetUnsupportedOptions } from "../src/providers/text";
import {
  DECISIONS_ENDPOINT,
  JEV_SERVED_MODEL,
  dialogActQuestion,
} from "../src/providers/jev";
import { DIALOG_SYSTEM } from "../src/assistant/prompt";
import { DIALOG_ACTS } from "../src/assistant/protocol";
import type { RunView } from "../src/assistant/types";
import { defaultSettings, type Settings } from "../src/core/schema";
import type { TurnPlan } from "../src/voice/turns";

function sse(deltas: string[]) {
  const events = deltas.map(
    (delta, i) =>
      `event: response.output_text.delta\ndata: ${JSON.stringify({
        type: "response.output_text.delta",
        sequence_number: i,
        delta,
      })}\n\n`,
  );
  events.push(
    `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: {
        status: "completed",
        usage: { input_tokens: 400, output_tokens: 10 },
      },
    })}\n\n`,
  );
  return events.join("");
}
const idle: RunView = {
  running: false,
  status: "idle",
  recent: [],
  queued: [],
  watches: [],
};
const KEY = "sk-or-v1-PROMPT-TEST-KEY";
const text = "print the boarding pass for the denver flight";
const start: TurnPlan = { kind: "start", text, taskSource: "user_words" };

function setup() {
  const settings: Settings = {
    ...defaultSettings,
    privacy: "PRIVATE_BYOM",
    provider: "openai",
    endpoint: "https://api.openai.com",
    model: "gpt-5.4-mini",
    conversation: "model",
    decisions: "jev",
    inputPrice: 1,
    outputPrice: 2,
  };
  const requests: { url: string; signal: AbortSignal }[] = [];
  const traces: { event: string; data: Record<string, unknown> }[] = [];
  let now = 1_000_000;
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ url, signal: init.signal! });
    if (url === DECISIONS_ENDPOINT)
      return new Response(
        JSON.stringify({
          model: JEV_SERVED_MODEL,
          provider: "TypeSafe",
          answers: {
            act: {
              type: "choice",
              choice: "start",
              probabilities: Object.fromEntries(
                DIALOG_ACTS.map((a) => [a, a === "start" ? 0.97 : 0]),
              ),
              confidence: 0.97,
            },
          },
        }),
        { status: 200, headers: { "x-provider-name": "TypeSafe" } },
      );
    // The text model answers in words after 200 ms on the fake clock.
    await new Promise((resolve) => setTimeout(resolve, 200));
    return new Response(sse(["ACT: answer\n", "SAY: ", "It is printed."]), {
      status: 200,
    });
  });
  const session = new AssistantSession({
    settings: () => settings,
    providerKey: () => "SECRET-KEY",
    jevKey: () => KEY,
    fetch: fetch as unknown as typeof globalThis.fetch,
    view: () => idle,
    context: () => ({}),
    heldByVoice: () => false,
    addUsage: () => {},
    trace: (event, data) => traces.push({ event, data: data ?? {} }),
    now: () => now,
  });
  return { session, requests, traces, advance: (ms: number) => (now += ms) };
}

beforeEach(() => {
  vi.useFakeTimers();
  forgetUnsupportedOptions();
});
afterEach(() => vi.useRealTimers());

describe("jev: a dialog prompt the act question cannot be built from", () => {
  it("is what this file loads", () => {
    expect(DIALOG_SYSTEM).not.toContain("How to choose ACT:");
    expect(() =>
      dialogActQuestion("original", DIALOG_SYSTEM, DIALOG_ACTS),
    ).toThrow(/ACT rules/);
  });

  it("leaves the decider off at load instead of failing the turn: today's path, nothing started", async () => {
    expect(JEV_ACT_QUESTION).toBeUndefined();
    const t = setup();
    expect(() => t.session.preempt(text, "voice")).not.toThrow();
    const pending = t.session.decide({
      turnId: "t1",
      text,
      base: start,
      view: idle,
      channel: "voice",
      confidence: 0.9,
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(250);
    const decision = await pending;
    // The model's answer stands; the user's words did not start unheard.
    expect(decision).toMatchObject({
      plan: { kind: "reply", act: "answer" },
      acting: false,
      code: "model",
    });
    expect(t.requests.filter((r) => r.url === DECISIONS_ENDPOINT)).toHaveLength(
      0,
    );
    const stream = t.requests.find((r) => r.url !== DECISIONS_ENDPOINT);
    expect(stream?.signal.aborted).toBe(false);
    expect(
      t.traces.some(
        (x) => x.event === "DialogTurn" && x.data.phase === "failed",
      ),
    ).toBe(false);
    const jev = t.traces.filter(
      (x) => x.event === "DialogTurn" && x.data.phase === "jev",
    );
    expect(jev.length).toBeGreaterThan(0);
    for (const x of jev)
      expect(x.data).toMatchObject({ jevCode: "no_question", jevUsed: false });
    expect(JSON.stringify(t.traces)).not.toContain(KEY);
  });
});
