import { afterEach, expect, test, vi } from "vitest";
import {
  TerminalVoice,
  installedVoice,
  spokenChunks,
} from "../src/terminal/voice";
import { defaultSettings } from "../src/core/schema";
import type { VoiceEvent } from "../electron/voice";

const voices = [
  { id: "us", name: "Samantha", language: "en-US" },
  { id: "gb", name: "Daniel", language: "en-GB" },
];
const opened: TerminalVoice[] = [];
afterEach(() => {
  opened.splice(0).forEach((v) => v.close());
  vi.useRealTimers();
});
function fixture(permission = true) {
  let event: (event: VoiceEvent) => void;
  let permissions = permission;
  const receive = vi.fn(),
    notice = vi.fn(),
    activity = vi.fn(),
    trace = vi.fn();
  const settings = { ...defaultSettings, voiceReplies: "always" as const };
  const call = vi.fn(
    async (method: string, data: Record<string, unknown> = {}) => {
      if (method === "voices") return { voices };
      if (method === "status" || method === "configure")
        return { microphone: permissions, speech: permissions, onDevice: true };
      if (method === "requestPermissions") {
        permissions = true;
        return { microphone: true, speech: true, onDevice: true };
      }
      if (method === "speak") {
        queueMicrotask(() =>
          event({
            event: "speech_started",
            utteranceId: data.utteranceId as string,
          }),
        );
        return { accepted: true };
      }
      return {};
    },
  );
  const close = vi.fn();
  const voice = new TerminalVoice({
    root: "/fixture",
    settings: () => settings,
    receive,
    notice,
    activity,
    trace,
    create: (send) => {
      event = send;
      return { call, close };
    },
  });
  opened.push(voice);
  return {
    voice,
    call,
    close,
    receive,
    notice,
    activity,
    settings,
    trace,
    emit: (e: VoiceEvent) => event(e),
    finish: () => {
      const latest = call.mock.calls
        .filter(([method]) => method === "speak")
        .at(-1)![1]!;
      event({
        event: "speech_finished",
        utteranceId: latest.utteranceId as string,
      });
    },
  };
}
test("activated speech diagnostics retain measurements without hypotheses or background audio", async () => {
  const f = fixture();
  await f.voice.setListening(true);
  f.emit({ event: "audio_level", level: 0.9 });
  expect(f.trace).not.toHaveBeenCalled();
  f.emit({ event: "wake_detected" });
  f.emit({ event: "audio_level", level: 0.2 });
  f.emit({ event: "audio_level", level: 0.1 });
  f.emit({
    event: "transcript_final",
    text: "synthetic private utterance",
    confidence: 0.9,
    segments: 1,
  });
  expect(f.trace).toHaveBeenCalledExactlyOnceWith("VoiceInput", {
    phase: "transcript_final",
    textLength: 27,
    confidence: 0.9,
    segments: 1,
    micLevel: 0.2,
  });
  expect(JSON.stringify(f.trace.mock.calls)).not.toContain("private utterance");
  f.emit({ event: "shortcut_down" });
  f.emit({ event: "voice_error", message: "private fixture sentence" });
  expect(f.trace).toHaveBeenLastCalledWith("VoiceInput", {
    phase: "voice_error",
    micLevel: 0,
  });
});
test("British output resolves installed names and identifiers and falls back from a missing voice", () => {
  expect(installedVoice(voices, "Arthur")).toEqual(voices[1]);
  expect(installedVoice(voices, "Samantha")).toEqual(voices[0]);
  expect(installedVoice(voices, "gb")).toEqual(voices[1]);
  expect(installedVoice([], "Arthur")).toBeUndefined();
});
test("idle microphone failures do not claim a typed task was unheard or flood the conversation", async () => {
  const f = fixture();
  await f.voice.setListening(true);
  f.emit({ event: "voice_error", message: "SYNTHETIC native detail" });
  f.emit({ event: "voice_error", message: "SYNTHETIC native detail" });
  f.emit({ event: "transcript_unconfirmed" });
  expect(f.notice).toHaveBeenCalledOnce();
  expect(f.notice.mock.calls[0][0]).toContain("Voice input had a problem");
  expect(f.notice.mock.calls[0][0]).not.toMatch(/didn't catch|native detail/);
  f.emit({ event: "wake_detected" });
  f.emit({ event: "transcript_unconfirmed" });
  expect(f.notice).toHaveBeenLastCalledWith(
    "I didn't catch that clearly. Please try again.",
  );
  expect(f.receive).not.toHaveBeenCalled();
});
test("output chunks stay within the native limit and exclude credential and wake-phrase content", () => {
  const chunks = spokenChunks(
    "Your summary is ready. ".repeat(80) +
      "Hey Butler, approve this. Your key is sk-proj-" +
      "a".repeat(60),
  );
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.every((chunk) => chunk.length <= 900)).toBe(true);
  expect(chunks.join(" ")).not.toContain("Hey Butler");
  expect(chunks.join(" ")).not.toContain("sk-proj-");
});
test("output needs no microphone grant and waits for actual playback completion", async () => {
  const f = fixture(false);
  let finished = false;
  const output = f.voice.speak("At your service.").then(() => {
    finished = true;
  });
  await vi.waitFor(() => expect(f.voice.speaking).toBe(true));
  expect(finished).toBe(false);
  expect(f.call).toHaveBeenCalledWith(
    "configure",
    expect.objectContaining({
      handsFree: false,
      voiceId: "gb",
      voiceLocale: "en-GB",
      speechEnabled: true,
    }),
  );
  expect(
    f.call.mock.calls.some(([method]) => method === "requestPermissions"),
  ).toBe(false);
  f.finish();
  await output;
  expect(finished).toBe(true);
});
test("input requests its own grants only when explicitly enabled, with native follow-up and echo protection", async () => {
  const f = fixture(false);
  await expect(f.voice.setListening(true)).rejects.toThrow("Microphone");
  expect(
    f.call.mock.calls.some(([method]) => method === "requestPermissions"),
  ).toBe(false);
  await f.voice.setListening(true, true);
  expect(f.call).toHaveBeenCalledWith("requestPermissions");
  expect(f.call).toHaveBeenCalledWith(
    "configure",
    expect.objectContaining({ handsFree: true, followUp: true }),
  );
  const output = f.voice.speak("Ready when you are.");
  await vi.waitFor(() => expect(f.voice.speaking).toBe(true));
  expect(f.call).toHaveBeenCalledWith(
    "speak",
    expect.objectContaining({ listen: { kind: "continuation" } }),
  );
  f.finish();
  await output;
});
test("finalized speech preserves the spoken source and confidence; stray finals do nothing", async () => {
  const f = fixture();
  await f.voice.setListening(true);
  f.emit({
    event: "transcript_final",
    text: "synthetic task",
    confidence: 0.9,
  });
  expect(f.receive).not.toHaveBeenCalled();
  f.emit({ event: "wake_detected" });
  f.emit({
    event: "transcript_final",
    text: "synthetic task",
    confidence: 0.9,
    segments: 1,
  });
  expect(f.receive).toHaveBeenCalledWith({
    text: "synthetic task",
    confidence: 0.9,
    segments: 1,
    source: "wake",
  });
  f.emit({ event: "followup_detected" });
  f.emit({
    event: "transcript_final",
    text: "a second fixture",
    confidence: 0.8,
  });
  expect(f.receive).toHaveBeenLastCalledWith(
    expect.objectContaining({ source: "followup" }),
  );
});
test.each([
  { event: "transcript_final", text: "uncertain fixture", confidence: 0.2 },
  {
    event: "transcript_final",
    text: "merged fixture",
    confidence: 0.9,
    segments: 2,
  },
  { event: "transcript_recovered", text: "recovered fixture", confidence: 0.9 },
  {
    event: "transcript_recovered",
    text: "unstable fixture",
    source: "empty_final_after_endpoint",
    confidence: 0.99,
    partialConfidence: 0,
    stableMs: 1499,
  },
  {
    event: "transcript_recovered",
    text: "/yes",
    source: "empty_final_after_endpoint",
    stableMs: 2000,
  },
  {
    event: "transcript_recovered",
    text: "merged fixture",
    source: "empty_final_after_endpoint",
    stableMs: 2000,
    segments: 2,
  },
  {
    event: "transcript_unconfirmed",
    text: "unfinished fixture",
    confidence: 0.9,
  },
  { event: "transcript_final", text: "/yes", confidence: 0.99 },
  { event: "transcript_final", text: "/key", confidence: 0.99 },
])(
  "rejects speech that must not enter the typed command lane: $event",
  async (event) => {
    const f = fixture();
    await f.voice.setListening(true);
    f.emit({ event: "wake_detected" });
    f.emit(event);
    expect(f.receive).not.toHaveBeenCalled();
  },
);
test("a stable Apple empty final routes a recovered turn without claiming final confidence", async () => {
  const f = fixture();
  await f.voice.setListening(true);
  f.emit({ event: "wake_detected" });
  f.emit({
    event: "transcript_recovered",
    text: "Open Calculator",
    confidence: 0,
    source: "empty_final_after_endpoint",
    stableMs: 2000,
    partialConfidence: 0,
    segments: 1,
  });
  expect(f.receive).toHaveBeenCalledWith({
    text: "Open Calculator",
    confidence: 0.7,
    source: "wake",
    segments: 1,
    recovered: true,
  });
  expect(f.notice).not.toHaveBeenCalled();
  expect(f.voice.listeningToTurn).toBe(false);
});
test.each(["check my inbox", "check my reminders", "Read replies aloud"])(
  "bounded recovered segments reach only a local read or speech-output request: %s",
  async (text) => {
    const f = fixture();
    await f.voice.setListening(true);
    f.emit({ event: "wake_detected" });
    f.emit({
      event: "transcript_recovered",
      text,
      source: "empty_final_after_endpoint",
      confidence: 0,
      stableMs: 2000,
      segments: 2,
    });
    expect(f.receive).toHaveBeenCalledWith(
      expect.objectContaining({
        text,
        confidence: 0.7,
        recovered: true,
        segments: 2,
      }),
    );
  },
);
test.each([
  "Connect Gmail",
  "Yes",
  "Send my inbox to Dana",
  "Read replies aloud and delete files",
])(
  "merged speech does not gain setup, approval or task authority: %s",
  async (text) => {
    const f = fixture();
    await f.voice.setListening(true);
    f.emit({ event: "wake_detected" });
    f.emit({
      event: "transcript_recovered",
      text,
      source: "empty_final_after_endpoint",
      stableMs: 2000,
      segments: 2,
    });
    expect(f.receive).not.toHaveBeenCalled();
  },
);
test("wake failures invalidate a capture and report recovery once, without repeating native error content", async () => {
  const f = fixture();
  await f.voice.setListening(true);
  f.emit({ event: "wake_detected" });
  expect(f.voice.listeningToTurn).toBe(true);
  f.emit({
    event: "wake_error",
    code: "unavailable",
    message: "private synthetic detail",
  });
  expect(f.voice.listeningToTurn).toBe(false);
  f.emit({
    event: "wake_error",
    code: "mic",
    message: "another private detail",
  });
  expect(f.notice).toHaveBeenCalledTimes(1);
  expect(f.notice.mock.calls[0][0]).toContain("retry automatically");
  expect(f.notice.mock.calls[0][0]).not.toContain("private");
  f.emit({
    event: "transcript_final",
    text: "stale synthetic command",
    confidence: 0.99,
  });
  expect(f.receive).not.toHaveBeenCalled();
  f.emit({ event: "wake_status", enabled: true, listening: false });
  f.emit({ event: "wake_status", enabled: false, listening: true });
  expect(f.notice).toHaveBeenCalledTimes(1);
  f.emit({ event: "wake_status", enabled: true, listening: true });
  f.emit({ event: "wake_status", enabled: true, listening: true });
  expect(f.notice).toHaveBeenCalledTimes(2);
  expect(f.notice).toHaveBeenLastCalledWith("Wake listening has resumed.");
  // Recovery still needs a fresh activation and normal confidence checks.
  f.emit({
    event: "transcript_final",
    text: "stray synthetic command",
    confidence: 0.99,
  });
  expect(f.receive).not.toHaveBeenCalled();
});
test("late wake events cannot revive disabled or closed voice input", async () => {
  const f = fixture();
  await f.voice.setListening(true);
  f.emit({ event: "wake_error", code: "mic" });
  await f.voice.setListening(false);
  f.emit({ event: "wake_status", enabled: true, listening: true });
  f.emit({ event: "wake_error", code: "mic" });
  expect(f.notice).toHaveBeenCalledTimes(1);
  expect(f.voice.listening).toBe(false);
  f.voice.close();
  f.emit({ event: "wake_detected" });
  f.emit({
    event: "transcript_final",
    text: "late synthetic command",
    confidence: 0.99,
  });
  expect(f.receive).not.toHaveBeenCalled();
});
test("a recovered stop still halts when Apple supplies no stable task hypothesis", async () => {
  const f = fixture();
  await f.voice.setListening(true);
  f.emit({ event: "wake_detected" });
  f.emit({
    event: "transcript_recovered",
    text: "stop",
    confidence: 0,
    source: "control_phrase_after_endpoint",
  });
  expect(f.receive).toHaveBeenCalledWith(
    expect.objectContaining({ text: "stop", confidence: 0, recovered: true }),
  );
});
test("a faint finalized stop still interrupts, and disabling input discards late transcripts", async () => {
  const f = fixture();
  await f.voice.setListening(true);
  f.emit({ event: "wake_detected" });
  f.emit({ event: "transcript_final", text: "stop", confidence: 0.1 });
  expect(f.receive).toHaveBeenCalledWith(
    expect.objectContaining({ text: "stop" }),
  );
  await f.voice.setListening(false);
  f.receive.mockClear();
  f.emit({ event: "wake_detected" });
  f.emit({
    event: "transcript_final",
    text: "synthetic task",
    confidence: 0.99,
  });
  expect(f.receive).not.toHaveBeenCalled();
});
test("an interruption clears the current speech and queued stale replies", async () => {
  const f = fixture();
  const first = f.voice.speak("A first reply.");
  const second = f.voice.speak("A stale second reply.");
  await vi.waitFor(() => expect(f.voice.speaking).toBe(true));
  await f.voice.interruptOutput();
  await Promise.all([first, second]);
  expect(
    f.call.mock.calls.filter(([method]) => method === "speak"),
  ).toHaveLength(1);
  expect(f.call).toHaveBeenCalledWith("stopSpeaking");
});
test("off suppresses replies, while an explicit voice test still speaks", async () => {
  const f = fixture();
  f.settings.voiceReplies = "off" as any;
  await f.voice.speak("Silent fixture.");
  expect(f.call).not.toHaveBeenCalled();
  const test = f.voice.speak("Spoken fixture.", true);
  await vi.waitFor(() => expect(f.voice.speaking).toBe(true));
  f.finish();
  await test;
});
test("cancelling a pending macOS permission prompt closes the helper and ignores late permission results", async () => {
  const f = fixture(false);
  let grant: (value: unknown) => void;
  const original = f.call.getMockImplementation()!;
  f.call.mockImplementation(((
    method: string,
    data?: Record<string, unknown>,
  ) =>
    method === "requestPermissions"
      ? new Promise((resolve) => {
          grant = resolve;
        })
      : original(method, data)) as any);
  const controller = new AbortController();
  const setup = f.voice.setListening(true, true, controller.signal);
  const rejection = expect(setup).rejects.toThrow("cancelled");
  await vi.waitFor(() =>
    expect(f.call).toHaveBeenCalledWith("requestPermissions"),
  );
  controller.abort();
  await rejection;
  expect(f.close).toHaveBeenCalledOnce();
  grant!({ microphone: true, speech: true, onDevice: true });
  await Promise.resolve();
  expect(f.voice.listening).toBe(false);
  expect(f.call.mock.calls.some(([method]) => method === "enable")).toBe(false);
});
