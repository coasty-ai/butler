import { describe, expect, it } from "vitest";
import {
  arbitrate,
  dialogEligible,
  fastStart,
  turnFiller,
} from "../src/assistant/arbitrate";
import { mediaCommand } from "../src/assistant/media";
import {
  cleanTaskText,
  planVoiceTurn,
  voiceIntent,
  type VoiceTurnRun,
} from "../src/voice/turns";

// Live 2026-09-19 07:09Z: "Pause the current video" with nothing running;
// the dialog model chose pause and the app answered "Nothing's running".
const MEDIA = [
  "Pause the current video",
  "pause the video",
  "stop the music",
  "pause the song",
  "resume the video",
  "resume the podcast",
  "continue the movie",
  "mute this",
  "mute it",
  "mute",
  "unmute the call",
  "skip this ad",
  "skip this",
  "skip this song",
  "turn the volume down",
  "turn down the volume",
  "lower the volume",
  "Stop the music in Spotify",
  "pause what's playing on YouTube",
  "stop the timer",
  "cancel the alarm",
  "stop the download",
  "stop sharing my screen",
  "end the call",
  "can you pause the video",
  "could you please stop the music",
  "okay, pause the video please",
  "volume down",
  "next track",
  "play the next episode",
];
/** Butler's own controls: the router's, and the ones it leaves to the model. */
const CONTROLS = [
  "pause",
  "stop",
  "wait",
  "hold on",
  "continue",
  "stop it",
  "pause it",
  "pause that",
  "pause the task",
  "pause that for now",
  "resume it",
  "resume the task",
  "hold that thought for a minute",
  "give me a moment before you keep going",
  "wait until I'm back at my desk",
  "okay carry on with the flights",
  "you can keep going now",
  "go on then",
  "carry on with it",
  "continue where you left off",
  "wait for me, I'll be right back",
  "hold on a second, I need to check something",
];
/** Neither: hints to a run, other requests, and questions about a thing. */
const OTHERS = [
  "pause the flights search",
  "stop scrolling and click Save",
  "stop and open Safari",
  "Don't stop",
  "turn it down",
  "is the music still playing",
  "why did the video stop",
  "did you pause the download",
  "open Spotify",
  "play some jazz",
  "start the search again",
  "play it again",
  "",
];

const run = (over: Partial<VoiceTurnRun> = {}): VoiceTurnRun => ({
  id: "run-1",
  status: "executing",
  actions: 3,
  held: false,
  task: "Find flights to Denver on Friday",
  ...over,
});
const plan = (text: string, r?: VoiceTurnRun) =>
  planVoiceTurn({
    text,
    confidence: 0.9,
    source: "wake",
    gateMatches: false,
    now: 1,
    run: r,
  });
const decide = (
  text: string,
  act: "pause" | "resume",
  r?: VoiceTurnRun,
  heldByVoice = false,
) => {
  const base = plan(text, r);
  return {
    base,
    a: arbitrate({
      base,
      head: { act },
      utterance: text,
      run: r,
      channel: "voice",
      heldByVoice,
    }),
  };
};

describe("media and device controls", () => {
  it("names a control on a thing of its own, never Butler's own control or a hint", () => {
    for (const text of MEDIA)
      expect([text, mediaCommand(text)]).toEqual([text, true]);
    for (const text of [...CONTROLS, ...OTHERS])
      expect([text, mediaCommand(text)]).toEqual([text, false]);
  });

  it("is a command to the router, a start with nothing running and a correction to a run", () => {
    for (const text of MEDIA) {
      expect([text, voiceIntent(text).kind]).toEqual([text, "command"]);
      const idle = plan(text);
      expect([text, idle]).toEqual([
        text,
        { kind: "start", text: cleanTaskText(text), taskSource: "user_words" },
      ]);
      // No model call at all: the run's model sees the player.
      expect([text, fastStart(idle, text)]).toEqual([text, true]);
      expect([text, turnFiller(idle, text)]).toEqual([text, undefined]);
      expect([text, plan(text, run())]).toEqual([
        text,
        { kind: "revise", text: cleanTaskText(text) },
      ]);
    }
    // Butler's own controls are the router's, or reach the model as before.
    for (const text of CONTROLS) {
      const kind = voiceIntent(text).kind;
      expect([
        text,
        ["stop", "pause", "resume", "command"].includes(kind),
      ]).toEqual([text, true]);
      if (kind === "command")
        expect([text, fastStart(plan(text), text)]).toEqual([text, false]);
    }
  });

  it("the model's pause or resume for one leaves the router's plan standing", () => {
    for (const text of MEDIA)
      for (const act of ["pause", "resume"] as const) {
        const idle = decide(text, act);
        expect([text, act, idle.a]).toEqual([
          text,
          act,
          { plan: idle.base, speakSay: false, code: "media_command" },
        ]);
        const working = decide(text, act, run());
        expect([text, act, working.base.kind, working.a.plan]).toEqual([
          text,
          act,
          "revise",
          working.base,
        ]);
        // Not even the hold this activation caused ends on "resume the video".
        const paused = decide(
          text,
          act,
          run({ status: "paused", held: true }),
          true,
        );
        expect([text, act, paused.a.plan]).toEqual([text, act, paused.base]);
      }
  });

  it("a bare control that reaches the model still pauses or resumes Butler's own task", () => {
    // "Go on then" is a fragment to the router, so the model never sees it.
    for (const text of CONTROLS.filter((t) => dialogEligible(plan(t)))) {
      expect([text, decide(text, "pause", run()).a.plan]).toEqual([
        text,
        { kind: "pause" },
      ]);
      expect([text, decide(text, "pause").a.plan]).toEqual([
        text,
        { kind: "nothingRunning" },
      ]);
      expect([
        text,
        decide(text, "resume", run({ status: "paused", held: true }), true).a
          .plan,
      ]).toEqual([text, { kind: "resume" }]);
    }
  });
});
