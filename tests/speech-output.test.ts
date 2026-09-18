import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KokoroError,
  type KokoroChunk,
  type KokoroVoice,
  type KokoroVoiceStatus,
} from "../electron/kokoro/client";
import {
  CLEAR_INSTRUCTION,
  PERSONA_INSTRUCTIONS,
  createSpeechOutput,
  instructionFor,
  kokoroSpeed,
  maxSpeechChars,
  openaiSpeech,
  selectSpeechEngine,
  streamSpeech,
  type SpeechSettings,
} from "../electron/speech-output";
import { cloudVoices } from "../src/core/schema";

const KEY = "sk-test-SECRET-key-1234567890";
const TEXT = "Your flight to Lisbon is confirmed for Tuesday";
const allowedTraceKeys = [
  "phase",
  "engine",
  "priority",
  "textLength",
  "latencyMs",
  "fallback",
  "status",
];

type Call = { method: string; data?: Record<string, unknown> };
type Helper = (method: string, data?: Record<string, unknown>) => unknown;

/** Bytes whose value depends on position, so reordering or loss is visible. */
function pattern(length: number, offset = 0) {
  return Uint8Array.from({ length }, (_, i) => (i + offset) % 251);
}
function closedStream(parts: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}
function openStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancelled = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    start: (c) => void (controller = c),
    cancel: cancelled,
  });
  return {
    stream,
    cancelled,
    push: (bytes: Uint8Array) => controller.enqueue(bytes),
    fail: () => controller.error(new Error("socket hang up")),
    close: () => controller.close(),
  };
}
const response = (body: ReadableStream<Uint8Array> | null, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, body }) as Response;

/** Ends a fake synthesis. */
const END = Symbol("end");
type Sentence = Int16Array | Error | typeof END;
interface Synthesis {
  text: string;
  signal: AbortSignal;
  /** Calls to the iterator's return(). */
  returns: number;
  /** The generator ran its finally block. */
  closed: boolean;
  push: (...items: Sentence[]) => void;
}
/** Position-dependent samples in a view with a non-zero byteOffset. */
function samples(count: number, offset = 0) {
  const view = new Int16Array(new ArrayBuffer(count * 2 + 4), 2, count);
  for (let i = 0; i < count; i++)
    view[i] = (((i + offset) * 37) % 32000) - 16000;
  return view;
}
const bytesOf = (pcm: Int16Array) =>
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);

/**
 * A Kokoro voice whose synthesize() is an async generator honoring its abort
 * signal. Call N starts with scripts[N]; more sentences can be pushed later.
 */
function fakeKokoro(scripts: Sentence[][] = [], installed = true) {
  const syntheses: Synthesis[] = [];
  const status = vi.fn((): KokoroVoiceStatus => ({
    installed,
    downloading: false,
    progress: installed ? 1 : 0,
    bytes: installed ? 100 : 0,
    totalBytes: 100,
    voice: "af_heart",
    voices: { af_heart: installed, bm_george: false, bm_fable: false },
    missingBytes: installed ? 0 : 100,
  }));
  const synthesize = vi.fn((text: string, signal?: AbortSignal) => {
    const queue = [...(scripts[syntheses.length] ?? [])];
    let wake: (() => void) | undefined;
    const synthesis: Synthesis = {
      text,
      signal: signal!,
      returns: 0,
      closed: false,
      push: (...items) => {
        queue.push(...items);
        const woken = wake;
        wake = undefined;
        woken?.();
      },
    };
    syntheses.push(synthesis);
    async function* run(): AsyncGenerator<KokoroChunk, void, undefined> {
      try {
        for (;;) {
          signal?.throwIfAborted();
          const item = queue.shift();
          if (item === undefined) {
            await new Promise<void>((resolve, reject) => {
              const onAbort = () => reject(signal?.reason);
              signal?.addEventListener("abort", onAbort, { once: true });
              wake = () => {
                signal?.removeEventListener("abort", onAbort);
                resolve();
              };
            });
            continue;
          }
          if (item === END) return;
          if (item instanceof Error) throw item;
          yield { pcm: item, sampleRate: 24000 };
        }
      } finally {
        synthesis.closed = true;
      }
    }
    const generator = run();
    const close = generator.return.bind(generator);
    generator.return = (value) => {
      synthesis.returns++;
      return close(value);
    };
    return generator;
  });
  return { kokoro: { status, synthesize }, syntheses, synthesize };
}

function setup(
  options: {
    settings?: Partial<SpeechSettings>;
    key?: string;
    helper?: Helper;
    fetch?: (url: string, init: RequestInit) => Promise<Response>;
    kokoro?: Pick<KokoroVoice, "status" | "synthesize">;
    supported?: boolean;
    now?: () => number;
  } = {},
) {
  const settings: SpeechSettings = {
    privacy: "PRIVATE_BYOM",
    voiceEngine: "openai",
    cloudVoice: "cedar",
    ...options.settings,
  };
  const calls: Call[] = [];
  const traces: { event: string; data: Record<string, unknown> }[] = [];
  const requests: { url: string; init: RequestInit }[] = [];
  const defaults: Record<string, unknown> = {
    speak: { accepted: true },
    playPcmStart: { accepted: true },
    playPcmChunk: { ok: true },
    playPcmEnd: { ok: true },
    playPcmAbort: { aborted: true, started: false },
    stopSpeaking: {},
  };
  const voiceCall = vi.fn(
    async (method: string, data?: Record<string, unknown>) => {
      calls.push({ method, data });
      const custom = await options.helper?.(method, data);
      return custom ?? defaults[method];
    },
  );
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    return options.fetch
      ? options.fetch(url, init)
      : response(closedStream([pattern(9600)]));
  });
  const output = createSpeechOutput({
    settings: () => settings,
    openaiKey: () => options.key ?? KEY,
    voiceCall,
    fetch: fetch as unknown as typeof globalThis.fetch,
    kokoro: options.kokoro,
    kokoroSupported: () => options.supported ?? true,
    now: options.now,
    trace: (event, data) => traces.push({ event, data }),
  });
  const methods = () => calls.map((call) => call.method);
  const chunks = () =>
    calls
      .filter((call) => call.method === "playPcmChunk")
      .map((call) => call.data!);
  return { output, calls, traces, requests, fetch, methods, chunks, settings };
}
const request = (text = TEXT) => ({
  utteranceId: "u-1",
  text,
  priority: "result" as const,
});
function withKokoro(
  fake: ReturnType<typeof fakeKokoro>,
  options: Parameters<typeof setup>[0] = {},
) {
  return setup({
    ...options,
    settings: {
      privacy: "PRIVATE_LOCAL",
      voiceEngine: "kokoro",
      ...options.settings,
    },
    kokoro: fake.kokoro,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("speech output engine selection", () => {
  it("speaks through the system voice and passes the helper decision through", async () => {
    const t = setup({
      settings: { voiceEngine: "system" },
      helper: (method) =>
        method === "speak"
          ? { accepted: false, reason: "capturing" }
          : undefined,
    });
    const result = await t.output.speak({
      ...request(),
      listen: { kind: "answer", seconds: 8 },
    });
    expect(result).toEqual({
      accepted: false,
      reason: "capturing",
      engine: "system",
    });
    expect(t.calls).toEqual([
      {
        method: "speak",
        data: {
          utteranceId: "u-1",
          text: TEXT,
          priority: "result",
          listen: { kind: "answer", seconds: 8 },
        },
      },
    ]);
    expect(t.fetch).not.toHaveBeenCalled();
    expect(t.traces.map((trace) => trace.data.phase)).toEqual([
      "requested",
      "finished",
    ]);
  });

  it("never uses the cloud voice in PRIVATE_LOCAL or without a key", async () => {
    for (const [settings, key] of [
      [{ privacy: "PRIVATE_LOCAL" as const }, KEY],
      [{}, ""],
      [{}, "   "],
    ] as const) {
      const t = setup({ settings, key });
      const result = await t.output.speak(request());
      expect(result).toEqual({ accepted: true, engine: "system" });
      expect(t.methods()).toEqual(["speak"]);
      expect(t.fetch).not.toHaveBeenCalled();
    }
    expect(
      selectSpeechEngine(
        { privacy: "PRIVATE_BYOM", voiceEngine: "openai" },
        KEY,
      ),
    ).toBe("openai");
    expect(selectSpeechEngine({ privacy: "PRIVATE_BYOM" }, KEY)).toBe("system");
  });

  it("uses Kokoro only when chosen, supported, provided and installed", async () => {
    const installed = fakeKokoro().kokoro;
    const missing = fakeKokoro([], false).kokoro;
    const chosen: SpeechSettings = {
      privacy: "PRIVATE_LOCAL",
      voiceEngine: "kokoro",
    };
    const yes = () => true;
    const no = () => false;
    expect(selectSpeechEngine(chosen, "", installed, yes)).toBe("kokoro");
    expect(
      selectSpeechEngine(
        { ...chosen, privacy: "PRIVATE_BYOM" },
        KEY,
        installed,
        yes,
      ),
    ).toBe("kokoro");
    expect(selectSpeechEngine(chosen, "", missing, yes)).toBe("system");
    expect(selectSpeechEngine(chosen, "", installed, no)).toBe("system");
    expect(selectSpeechEngine(chosen, "")).toBe("system");
    const broken = {
      status: () => {
        throw new Error("stat failed");
      },
    };
    expect(selectSpeechEngine(chosen, "", broken, yes)).toBe("system");
    // Kokoro never changes the other engines' rules.
    expect(
      selectSpeechEngine(
        { privacy: "PRIVATE_BYOM", voiceEngine: "openai" },
        KEY,
        installed,
        yes,
      ),
    ).toBe("openai");
    expect(
      selectSpeechEngine(
        { privacy: "PRIVATE_BYOM", voiceEngine: "system" },
        KEY,
        installed,
        yes,
      ),
    ).toBe("system");

    // A keyed BYOM user who picked Kokoro gets the system voice, never the cloud.
    for (const [name, fake, supported] of [
      ["not installed", fakeKokoro([], false), true],
      ["unsupported", fakeKokoro(), false],
      ["missing dependency", undefined, true],
    ] as const) {
      const t = setup({
        settings: { privacy: "PRIVATE_BYOM", voiceEngine: "kokoro" },
        kokoro: fake?.kokoro,
        supported,
      });
      expect(await t.output.speak(request()), name).toEqual({
        accepted: true,
        engine: "system",
      });
      expect(t.methods()).toEqual(["speak"]);
      expect(t.fetch).not.toHaveBeenCalled();
      if (fake) expect(fake.synthesize).not.toHaveBeenCalled();
      expect(t.traces[0].data).toMatchObject({
        phase: "requested",
        engine: "system",
      });
    }
  });
});

describe("Kokoro on-device speech", () => {
  it("waits for audio, then streams each sentence as ordered 100 ms pieces and ends", async () => {
    const sentences = [samples(6000), samples(1000, 6000), samples(4800, 7000)];
    const fake = fakeKokoro([[...sentences, END]]);
    const t = withKokoro(fake);
    const result = await t.output.speak({
      ...request(),
      listen: { kind: "answer", seconds: 8 },
    });
    expect(result).toEqual({ accepted: true, engine: "kokoro" });
    expect(fake.synthesize).toHaveBeenCalledTimes(1);
    const synthesis = fake.syntheses[0];
    expect(synthesis.text).toBe(TEXT);
    expect(synthesis.signal).toBeInstanceOf(AbortSignal);
    expect(synthesis.signal.aborted).toBe(false);
    expect(synthesis.closed).toBe(true);
    expect(t.fetch).not.toHaveBeenCalled();
    expect(t.methods()).toEqual([
      "playPcmStart",
      "playPcmChunk",
      "playPcmChunk",
      "playPcmChunk",
      "playPcmChunk",
      "playPcmEnd",
    ]);
    expect(t.calls[0].data).toEqual({
      utteranceId: "u-1",
      priority: "result",
      listen: { kind: "answer", seconds: 8 },
      sampleRate: 24000,
      format: "s16le",
    });
    expect(t.calls.at(-1)!.data).toEqual({ utteranceId: "u-1" });
    const chunks = t.chunks();
    expect(chunks.map((chunk) => chunk.seq)).toEqual([0, 1, 2, 3]);
    expect(chunks.every((chunk) => chunk.utteranceId === "u-1")).toBe(true);
    const decoded = chunks.map((chunk) =>
      Buffer.from(chunk.data as string, "base64"),
    );
    // 12,000 bytes split at 9,600; each sentence ends on its own piece.
    expect(decoded.map((bytes) => bytes.length)).toEqual([
      9600, 2400, 2000, 9600,
    ]);
    expect(Buffer.concat(decoded)).toEqual(
      Buffer.concat(sentences.map(bytesOf)),
    );
    expect(t.traces.map((trace) => trace.data.phase)).toEqual([
      "requested",
      "started",
      "finished",
    ]);
    expect(t.traces.every((trace) => trace.data.engine === "kokoro")).toBe(
      true,
    );
    expect(t.traces.at(-1)!.data).toMatchObject({
      status: "ok",
      fallback: false,
    });
  });

  it("does not start helper playback until the first sentence is synthesized", async () => {
    const fake = fakeKokoro();
    const t = withKokoro(fake);
    const pending = t.output.speak(request());
    await vi.waitFor(() => expect(fake.syntheses).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(t.calls).toEqual([]);
    fake.syntheses[0].push(samples(100));
    await vi.waitFor(() => expect(t.chunks()).toHaveLength(1));
    expect(t.methods()).toEqual(["playPcmStart", "playPcmChunk"]);
    fake.syntheses[0].push(END);
    expect(await pending).toEqual({ accepted: true, engine: "kokoro" });
    expect(t.methods()).toEqual(["playPcmStart", "playPcmChunk", "playPcmEnd"]);
  });

  it("lets a cold worker take 2 s for its first sentence", async () => {
    vi.useFakeTimers();
    const fake = fakeKokoro();
    const t = withKokoro(fake);
    const pending = t.output.speak(request());
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.calls).toEqual([]);
    fake.syntheses[0].push(samples(100), END);
    expect(await pending).toEqual({ accepted: true, engine: "kokoro" });
    expect(t.methods()).not.toContain("speak");
  });

  it("falls back to the system voice when no audio arrives within 5 s", async () => {
    vi.useFakeTimers();
    const fake = fakeKokoro();
    const t = withKokoro(fake);
    let settled = false;
    const pending = t.output.speak(request()).finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(4999);
    expect(settled).toBe(false);
    expect(t.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ accepted: true, engine: "system" });
    const synthesis = fake.syntheses[0];
    expect(synthesis.signal.aborted).toBe(true);
    expect(synthesis.closed).toBe(true);
    // Nothing was started, so there is nothing to abort in the helper.
    expect(t.methods()).toEqual(["speak"]);
    expect(t.calls[0].data).toEqual({
      utteranceId: "u-1",
      text: TEXT,
      priority: "result",
    });
    expect(t.traces.map((trace) => trace.data)).toEqual([
      expect.objectContaining({ phase: "requested", engine: "kokoro" }),
      expect.objectContaining({
        phase: "fallback",
        engine: "kokoro",
        fallback: true,
        status: "first_audio_timeout",
      }),
      expect.objectContaining({
        phase: "finished",
        engine: "system",
        fallback: true,
        status: "accepted",
      }),
    ]);
  });

  it.each([
    ["a KokoroError", new KokoroError("worker_crashed"), "worker_crashed"],
    ["an empty result", END, "empty"],
    [
      "an unexpected error",
      new Error("onnx failed on Lisbon"),
      "synthesis_failed",
    ],
  ] as const)(
    "falls back to the system voice after %s before any audio",
    async (_name, item, status) => {
      const fake = fakeKokoro([[item]]);
      const t = withKokoro(fake);
      expect(await t.output.speak(request())).toEqual({
        accepted: true,
        engine: "system",
      });
      expect(t.methods()).toEqual(["speak"]);
      expect(t.traces.map((trace) => trace.data)).toEqual([
        expect.objectContaining({ phase: "requested", engine: "kokoro" }),
        expect.objectContaining({
          phase: "fallback",
          engine: "kokoro",
          fallback: true,
          status,
        }),
        expect.objectContaining({
          phase: "finished",
          engine: "system",
          fallback: true,
        }),
      ]);
      expect(JSON.stringify(t.traces)).not.toContain("onnx");
    },
  );

  it("returns the helper's refusal and ends synthesis", async () => {
    // The generator is still open: only return() can end it.
    const fake = fakeKokoro([[samples(100)]]);
    const t = withKokoro(fake, {
      helper: (method) =>
        method === "playPcmStart"
          ? { accepted: false, reason: "capturing" }
          : undefined,
    });
    expect(await t.output.speak(request())).toEqual({
      accepted: false,
      reason: "capturing",
      engine: "kokoro",
    });
    expect(t.methods()).toEqual(["playPcmStart"]);
    expect(fake.syntheses[0].returns).toBe(1);
    await vi.waitFor(() => expect(fake.syntheses[0].closed).toBe(true));
  });

  it("after playPcmStart but before any ack, falls back only while the helper holds the utterance", async () => {
    for (const [abort, expected, methods] of [
      [
        { aborted: true, started: false },
        { accepted: true, engine: "system" },
        ["playPcmStart", "playPcmChunk", "playPcmAbort", "speak"],
      ],
      [
        { aborted: false, started: false },
        { accepted: false, reason: "dropped", engine: "kokoro" },
        ["playPcmStart", "playPcmChunk", "playPcmAbort"],
      ],
    ] as const) {
      const fake = fakeKokoro([[samples(100), END]]);
      const t = withKokoro(fake, {
        helper: (method) => {
          if (method === "playPcmChunk") throw new Error("helper gone");
          return method === "playPcmAbort" ? abort : undefined;
        },
      });
      expect(await t.output.speak(request())).toEqual(expected);
      expect(t.methods()).toEqual(methods);
      if (expected.engine === "system")
        expect(t.traces[1].data).toMatchObject({
          phase: "fallback",
          engine: "kokoro",
          status: "helper",
        });
    }
  });

  it("stops the helper without fallback when synthesis fails after audio was acknowledged", async () => {
    const fake = fakeKokoro([[samples(100)]]);
    const t = withKokoro(fake, {
      helper: (method) =>
        method === "playPcmAbort"
          ? { aborted: true, started: true }
          : undefined,
    });
    const pending = t.output.speak(request());
    await vi.waitFor(() => expect(t.chunks()).toHaveLength(1));
    fake.syntheses[0].push(new KokoroError("worker_stalled"));
    expect(await pending).toEqual({ accepted: true, engine: "kokoro" });
    expect(t.methods()).toEqual([
      "playPcmStart",
      "playPcmChunk",
      "playPcmAbort",
    ]);
    expect(t.calls.at(-1)!.data).toEqual({ utteranceId: "u-1" });
    expect(t.traces.some((trace) => trace.data.phase === "fallback")).toBe(
      false,
    );
    expect(t.traces.at(-1)!.data).toMatchObject({
      phase: "error",
      engine: "kokoro",
      fallback: false,
      status: "worker_stalled",
    });
  });

  it("gives up at the 15 s deadline without a second voice", async () => {
    vi.useFakeTimers();
    const fake = fakeKokoro([[samples(100)]]);
    const t = withKokoro(fake, {
      helper: (method) =>
        method === "playPcmAbort"
          ? { aborted: true, started: true }
          : undefined,
    });
    let settled = false;
    const pending = t.output.speak(request()).finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).toBe(false);
    expect(t.chunks()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ accepted: true, engine: "kokoro" });
    expect(fake.syntheses[0].signal.aborted).toBe(true);
    expect(t.methods()).toEqual([
      "playPcmStart",
      "playPcmChunk",
      "playPcmAbort",
    ]);
    expect(t.traces.at(-1)!.data).toMatchObject({
      phase: "error",
      status: "timeout",
    });
  });

  it("stops synthesis without fallback when the helper drops the utterance", async () => {
    // 19,200 bytes in one open sentence; the helper drops the second piece.
    const fake = fakeKokoro([[samples(9600)]]);
    const t = withKokoro(fake, {
      helper: (method, data) =>
        method === "playPcmChunk" && data?.seq === 1
          ? { ok: false }
          : undefined,
    });
    expect(await t.output.speak(request())).toEqual({
      accepted: true,
      engine: "kokoro",
    });
    expect(t.methods()).toEqual([
      "playPcmStart",
      "playPcmChunk",
      "playPcmChunk",
    ]);
    const synthesis = fake.syntheses[0];
    expect(synthesis.signal.aborted).toBe(true);
    expect(synthesis.returns).toBe(1);
    await vi.waitFor(() => expect(synthesis.closed).toBe(true));
    expect(t.traces.at(-1)!.data).toMatchObject({
      phase: "finished",
      engine: "kokoro",
      fallback: false,
      status: "dropped",
    });

    // Dropped before anything was heard: still never a second voice.
    const early = fakeKokoro([[samples(100)]]);
    const u = withKokoro(early, {
      helper: (method) =>
        method === "playPcmChunk" ? { ok: false } : undefined,
    });
    expect(await u.output.speak(request())).toEqual({
      accepted: false,
      reason: "dropped",
      engine: "kokoro",
    });
    expect(u.methods()).toEqual(["playPcmStart", "playPcmChunk"]);
    expect(early.syntheses[0].returns).toBe(1);
  });

  it("stop() aborts synthesis before audio and never falls back", async () => {
    const fake = fakeKokoro();
    const t = withKokoro(fake);
    const pending = t.output.speak(request());
    await vi.waitFor(() => expect(fake.syntheses).toHaveLength(1));
    await t.output.stop();
    expect(fake.syntheses[0].signal.aborted).toBe(true);
    expect(await pending).toEqual({
      accepted: false,
      reason: "cancelled",
      engine: "kokoro",
    });
    expect(fake.syntheses[0].closed).toBe(true);
    expect(t.methods()).toEqual(["stopSpeaking"]);
    expect(t.traces.at(-1)!.data).toMatchObject({
      phase: "finished",
      engine: "kokoro",
      status: "stopped",
    });
  });

  it("cancel() aborts synthesis mid-utterance with no fallback and no stopSpeaking", async () => {
    const fake = fakeKokoro([[samples(100)]]);
    const t = withKokoro(fake);
    const pending = t.output.speak(request());
    await vi.waitFor(() => expect(t.chunks()).toHaveLength(1));
    t.output.cancel();
    expect(fake.syntheses[0].signal.aborted).toBe(true);
    // A sentence finishing after the cancel is never sent.
    fake.syntheses[0].push(samples(100, 100), END);
    expect(await pending).toEqual({
      accepted: false,
      reason: "cancelled",
      engine: "kokoro",
    });
    expect(fake.syntheses[0].closed).toBe(true);
    expect(t.methods()).toEqual([
      "playPcmStart",
      "playPcmChunk",
      "playPcmAbort",
    ]);
    expect(t.traces.at(-1)!.data).toMatchObject({
      phase: "finished",
      engine: "kokoro",
      status: "interrupted",
    });
  });

  it("a newer speak supersedes an older Kokoro flight", async () => {
    // Older still synthesizing its first sentence: it never reaches the helper.
    const fake = fakeKokoro([[], [samples(100), END]]);
    const t = withKokoro(fake);
    const older = t.output.speak(request());
    await vi.waitFor(() => expect(fake.syntheses).toHaveLength(1));
    const newer = t.output.speak({ ...request("Done."), utteranceId: "u-2" });
    expect(fake.syntheses[0].signal.aborted).toBe(true);
    expect(await older).toEqual({
      accepted: false,
      reason: "cancelled",
      engine: "kokoro",
    });
    expect(await newer).toEqual({ accepted: true, engine: "kokoro" });
    expect(fake.syntheses[1].text).toBe("Done.");
    expect(fake.syntheses[1].signal.aborted).toBe(false);
    expect(t.methods()).toEqual(["playPcmStart", "playPcmChunk", "playPcmEnd"]);
    expect(t.calls.every((call) => call.data?.utteranceId === "u-2")).toBe(
      true,
    );

    // Older already playing: its helper utterance is aborted, never re-spoken.
    const playing = fakeKokoro([[samples(100)], [samples(100), END]]);
    const u = withKokoro(playing);
    const first = u.output.speak(request());
    await vi.waitFor(() => expect(u.chunks()).toHaveLength(1));
    const second = u.output.speak({ ...request("Done."), utteranceId: "u-2" });
    expect(playing.syntheses[0].signal.aborted).toBe(true);
    expect(await first).toEqual({
      accepted: false,
      reason: "cancelled",
      engine: "kokoro",
    });
    expect(await second).toEqual({ accepted: true, engine: "kokoro" });
    expect(u.methods()).not.toContain("speak");
    expect(
      u.calls
        .filter((call) => call.method === "playPcmAbort")
        .map((call) => call.data),
    ).toEqual([{ utteranceId: "u-1" }]);
    expect(u.chunks().map((chunk) => chunk.utteranceId)).toEqual([
      "u-1",
      "u-2",
    ]);
  });
});

describe("OpenAI streamed speech", () => {
  it("streams ordered 100 ms PCM chunks, carrying odd bytes, then ends", async () => {
    // 19,205 bytes arriving in odd-sized network reads.
    const parts = [
      pattern(1),
      pattern(9600, 1),
      pattern(9601, 9601),
      pattern(3, 19202),
    ];
    let inFlight = 0;
    let maxInFlight = 0;
    const t = setup({
      fetch: async () => response(closedStream(parts)),
      helper: async (method) => {
        if (method !== "playPcmChunk") return undefined;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return { ok: true };
      },
    });
    const result = await t.output.speak({
      ...request(),
      listen: { kind: "approval", seconds: 5 },
    });
    expect(result).toEqual({ accepted: true, engine: "openai" });
    expect(t.methods()).toEqual([
      "playPcmStart",
      "playPcmChunk",
      "playPcmChunk",
      "playPcmChunk",
      "playPcmEnd",
    ]);
    expect(t.calls[0].data).toEqual({
      utteranceId: "u-1",
      priority: "result",
      listen: { kind: "approval", seconds: 5 },
      sampleRate: 24000,
      format: "s16le",
    });
    expect(t.calls[4].data).toEqual({ utteranceId: "u-1" });
    const chunks = t.chunks();
    expect(chunks.map((chunk) => chunk.seq)).toEqual([0, 1, 2]);
    expect(chunks.every((chunk) => chunk.utteranceId === "u-1")).toBe(true);
    const decoded = chunks.map((chunk) =>
      Buffer.from(chunk.data as string, "base64"),
    );
    expect(decoded.map((bytes) => bytes.length)).toEqual([9600, 9600, 4]);
    // Every sample boundary is preserved and the dangling half sample is dropped.
    expect(Buffer.concat(decoded)).toEqual(Buffer.from(pattern(19204)));
    expect(maxInFlight).toBe(1);

    expect(t.requests).toHaveLength(1);
    const { url, init } = t.requests[0];
    expect(url).toBe("https://api.openai.com/v1/audio/speech");
    expect(url).not.toContain(KEY);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).toEqual({
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init.body as string)).toEqual({
      model: "gpt-4o-mini-tts",
      voice: "cedar",
      input: TEXT,
      instructions: openaiSpeech.instructions,
      response_format: "pcm",
      stream_format: "audio",
    });
    expect(t.traces.map((trace) => trace.data.phase)).toEqual([
      "requested",
      "started",
      "finished",
    ]);
    expect(t.traces.at(-1)!.data).toMatchObject({
      engine: "openai",
      status: "ok",
      fallback: false,
    });
  });

  it("does not call the network when the helper refuses playback", async () => {
    const t = setup({
      helper: (method) =>
        method === "playPcmStart"
          ? { accepted: false, reason: "capturing" }
          : undefined,
    });
    const result = await t.output.speak(request());
    expect(result).toEqual({
      accepted: false,
      reason: "capturing",
      engine: "openai",
    });
    expect(t.fetch).not.toHaveBeenCalled();
    expect(t.methods()).toEqual(["playPcmStart"]);
  });

  it("falls back to the system voice after HTTP 401 without echoing the body", async () => {
    const body = openStream();
    body.push(
      new TextEncoder().encode('{"error":{"message":"bad key sk-leak"}}'),
    );
    const t = setup({ fetch: async () => response(body.stream, 401) });
    const result = await t.output.speak(request());
    expect(result).toEqual({ accepted: true, engine: "system" });
    expect(t.methods()).toEqual(["playPcmStart", "playPcmAbort", "speak"]);
    expect(t.calls[2].data).toEqual({
      utteranceId: "u-1",
      text: TEXT,
      priority: "result",
    });
    expect(body.cancelled).toHaveBeenCalled();
    expect(JSON.stringify(t.traces)).not.toContain("sk-leak");
    expect(t.traces.map((trace) => trace.data)).toEqual([
      expect.objectContaining({ phase: "requested", engine: "openai" }),
      expect.objectContaining({
        phase: "fallback",
        engine: "openai",
        fallback: true,
        status: "http_401",
      }),
      expect.objectContaining({
        phase: "finished",
        engine: "system",
        fallback: true,
        status: "accepted",
      }),
    ]);
  });

  it("falls back when no first byte arrives within 1,200 ms", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    // A fetch that ignores its signal still cannot hold the utterance hostage.
    const t = setup({
      fetch: (_url, init) => {
        signal = init.signal ?? undefined;
        return new Promise<Response>(() => {});
      },
    });
    let settled = false;
    const pending = t.output.speak(request()).finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(1199);
    expect(settled).toBe(false);
    expect(t.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result).toEqual({ accepted: true, engine: "system" });
    expect(signal?.aborted).toBe(true);
    expect(t.methods()).toEqual(["playPcmStart", "playPcmAbort", "speak"]);
    expect(t.traces[1].data).toMatchObject({
      phase: "fallback",
      status: "first_byte_timeout",
    });
  });

  it("falls back when headers arrive but the audio stream stays silent", async () => {
    vi.useFakeTimers();
    const body = openStream();
    const t = setup({ fetch: async () => response(body.stream) });
    const pending = t.output.speak(request());
    await vi.advanceTimersByTimeAsync(1200);
    expect(await pending).toEqual({ accepted: true, engine: "system" });
    expect(body.cancelled).toHaveBeenCalled();
    expect(t.methods()).toEqual(["playPcmStart", "playPcmAbort", "speak"]);
  });

  it("stops the stream without fallback when audio already reached the helper", async () => {
    const body = openStream();
    const t = setup({
      fetch: async () => response(body.stream),
      helper: (method) =>
        method === "playPcmAbort"
          ? { aborted: true, started: true }
          : undefined,
    });
    const pending = t.output.speak(request());
    await vi.waitFor(() => expect(t.fetch).toHaveBeenCalled());
    body.push(pattern(9600));
    await vi.waitFor(() => expect(t.chunks()).toHaveLength(1));
    body.fail();
    expect(await pending).toEqual({ accepted: true, engine: "openai" });
    expect(t.methods()).toEqual([
      "playPcmStart",
      "playPcmChunk",
      "playPcmAbort",
    ]);
    expect(t.traces.at(-1)!.data).toMatchObject({
      phase: "error",
      engine: "openai",
      fallback: false,
      status: "network",
    });
  });

  it("stops reading and aborts the fetch when the helper drops the utterance", async () => {
    const body = openStream();
    const t = setup({
      fetch: async () => response(body.stream),
      helper: (method, data) =>
        method === "playPcmChunk" && data?.seq === 1
          ? { ok: false }
          : undefined,
    });
    const pending = t.output.speak(request());
    await vi.waitFor(() => expect(t.fetch).toHaveBeenCalled());
    body.push(pattern(9600));
    body.push(pattern(9600));
    const result = await pending;
    expect(result).toEqual({ accepted: true, engine: "openai" });
    expect(t.requests[0].init.signal?.aborted).toBe(true);
    expect(body.cancelled).toHaveBeenCalled();
    expect(t.methods()).toEqual([
      "playPcmStart",
      "playPcmChunk",
      "playPcmChunk",
    ]);
    expect(t.traces.at(-1)!.data).toMatchObject({ status: "dropped" });
  });

  it("stop() aborts the in-flight request and never falls back", async () => {
    const body = openStream();
    const t = setup({ fetch: async () => response(body.stream) });
    const pending = t.output.speak(request());
    await vi.waitFor(() => expect(t.fetch).toHaveBeenCalled());
    await t.output.stop();
    expect(t.requests[0].init.signal?.aborted).toBe(true);
    expect(await pending).toEqual({
      accepted: false,
      reason: "cancelled",
      engine: "openai",
    });
    expect(t.methods()).toEqual([
      "playPcmStart",
      "stopSpeaking",
      "playPcmAbort",
    ]);
    expect(t.calls[1].data).toBeUndefined();
    expect(t.traces.at(-1)!.data).toMatchObject({ status: "stopped" });
  });

  it("a newer speak aborts the older cloud request", async () => {
    const first = openStream();
    const streams = [first.stream, closedStream([pattern(9600)])];
    const t = setup({ fetch: async () => response(streams.shift()!) });
    const older = t.output.speak(request());
    await vi.waitFor(() => expect(t.fetch).toHaveBeenCalledTimes(1));
    const newer = t.output.speak({ ...request("Done."), utteranceId: "u-2" });
    expect(t.requests[0].init.signal?.aborted).toBe(true);
    expect(await older).toEqual({
      accepted: false,
      reason: "cancelled",
      engine: "openai",
    });
    expect(await newer).toEqual({ accepted: true, engine: "openai" });
    expect(first.cancelled).toHaveBeenCalled();
    expect(t.methods()).not.toContain("speak");
    expect(
      t.calls
        .filter((call) => call.method === "playPcmAbort")
        .map((c) => c.data),
    ).toEqual([{ utteranceId: "u-1" }]);
    expect(t.chunks().map((chunk) => chunk.utteranceId)).toEqual(["u-2"]);
  });

  it("does not fall back over a newer utterance while aborting a failed one", async () => {
    let releaseAbort!: () => void;
    const t = setup({
      fetch: async () => response(null, 500),
      helper: (method, data) =>
        method === "playPcmAbort" && data?.utteranceId === "u-1"
          ? new Promise((resolve) => {
              releaseAbort = () => resolve({ aborted: true, started: false });
            })
          : undefined,
    });
    const older = t.output.speak(request());
    await vi.waitFor(() => expect(releaseAbort).toBeTypeOf("function"));
    const newer = t.output.speak({
      ...request("Done."),
      utteranceId: "u-2",
      priority: "urgent",
    });
    releaseAbort();
    expect(await older).toMatchObject({ accepted: false, reason: "cancelled" });
    await newer;
    expect(
      t.calls.filter(
        (call) => call.method === "speak" && call.data?.utteranceId === "u-1",
      ),
    ).toEqual([]);
  });
});

describe("OpenAI speech: fallback only while the helper holds the utterance", () => {
  it("never re-speaks an utterance the helper dropped before a late HTTP 503", async () => {
    vi.useFakeTimers();
    const t = setup({
      // Dropped by barge-in or replacement while the request was pending.
      helper: (method) =>
        method === "playPcmAbort"
          ? { aborted: false, started: false }
          : undefined,
      fetch: () =>
        new Promise<Response>((resolve) =>
          setTimeout(() => resolve(response(null, 503)), 700),
        ),
    });
    const pending = t.output.speak({
      ...request(),
      listen: { kind: "approval", seconds: 8 },
    });
    await vi.advanceTimersByTimeAsync(700);
    expect(await pending).toEqual({
      accepted: false,
      reason: "dropped",
      engine: "openai",
    });
    expect(t.methods()).toEqual(["playPcmStart", "playPcmAbort"]);
    expect(t.traces.map((trace) => trace.data)).toEqual([
      expect.objectContaining({ phase: "requested", engine: "openai" }),
      expect.objectContaining({
        phase: "finished",
        engine: "openai",
        fallback: false,
        status: "dropped",
      }),
    ]);
  });

  const branches: [string, unknown, Record<string, unknown>, string[]][] = [
    [
      "held and silent: falls back",
      { aborted: true, started: false },
      { accepted: true, engine: "system" },
      ["playPcmStart", "playPcmAbort", "speak"],
    ],
    [
      "not held: dropped",
      { aborted: false, started: false },
      { accepted: false, reason: "dropped", engine: "openai" },
      ["playPcmStart", "playPcmAbort"],
    ],
    [
      "already audible: no second voice",
      { aborted: true, started: true },
      { accepted: true, engine: "openai" },
      ["playPcmStart", "playPcmAbort"],
    ],
    [
      "unrecognized reply: dropped",
      { ok: true },
      { accepted: false, reason: "dropped", engine: "openai" },
      ["playPcmStart", "playPcmAbort"],
    ],
    [
      "abort call fails: silent",
      new Error("helper gone"),
      { accepted: false, reason: "unavailable", engine: "openai" },
      ["playPcmStart", "playPcmAbort"],
    ],
  ];
  it.each(branches)(
    "after a failure before the first chunk, abort reply %s",
    async (_name, abort, expected, methods) => {
      const t = setup({
        fetch: async () => response(null, 503),
        helper: (method) => {
          if (method !== "playPcmAbort") return undefined;
          if (abort instanceof Error) throw abort;
          return abort;
        },
      });
      expect(await t.output.speak(request())).toEqual(expected);
      expect(t.methods()).toEqual(methods);
      const last = t.traces.at(-1)!.data;
      if (expected.engine === "system")
        expect(last).toMatchObject({ engine: "system", fallback: true });
      else expect(last).toMatchObject({ engine: "openai", fallback: false });
    },
  );

  it("cancel() aborts the in-flight request with no fallback and no stopSpeaking", async () => {
    let respond!: (value: Response) => void;
    const t = setup({
      fetch: () => new Promise<Response>((resolve) => (respond = resolve)),
    });
    const pending = t.output.speak(request());
    await vi.waitFor(() => expect(t.fetch).toHaveBeenCalled());
    t.output.cancel();
    expect(t.requests[0].init.signal?.aborted).toBe(true);
    // The request fails after the cancel: still nothing is spoken.
    respond(response(null, 503));
    expect(await pending).toEqual({
      accepted: false,
      reason: "cancelled",
      engine: "openai",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(t.methods()).toEqual(["playPcmStart", "playPcmAbort"]);
    expect(t.traces.at(-1)!.data).toMatchObject({
      phase: "finished",
      status: "interrupted",
    });

    // Cancelled while playPcmStart is still pending: no network at all.
    let accept!: (value: unknown) => void;
    const u = setup({
      helper: (method) =>
        method === "playPcmStart"
          ? new Promise((resolve) => (accept = resolve))
          : undefined,
    });
    const early = u.output.speak(request());
    await vi.waitFor(() => expect(accept).toBeTypeOf("function"));
    u.output.cancel();
    accept({ accepted: true });
    expect(await early).toMatchObject({ accepted: false, reason: "cancelled" });
    expect(u.fetch).not.toHaveBeenCalled();
    expect(u.methods()).toEqual(["playPcmStart", "playPcmAbort"]);

    // Nothing in flight: no helper call.
    const idle = setup();
    idle.output.cancel();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(idle.calls).toEqual([]);
  });
});

describe("speech output hygiene", () => {
  it("never traces the text or the key", async () => {
    const happy = setup();
    await happy.output.speak(request());
    const failing = setup({ fetch: async () => response(null, 401) });
    await failing.output.speak(request());
    const local = setup({ settings: { privacy: "PRIVATE_LOCAL" } });
    await local.output.speak(request());
    const kokoro = withKokoro(fakeKokoro([[samples(100), END]]));
    await kokoro.output.speak(request());
    const kokoroFallback = withKokoro(
      fakeKokoro([[new KokoroError("synthesis_failed")]]),
    );
    await kokoroFallback.output.speak(request());
    const kokoroDropped = withKokoro(fakeKokoro([[samples(100)]]), {
      helper: (method) =>
        method === "playPcmChunk" ? { ok: false } : undefined,
    });
    await kokoroDropped.output.speak(request());
    for (const t of [
      happy,
      failing,
      local,
      kokoro,
      kokoroFallback,
      kokoroDropped,
    ]) {
      const serialized = JSON.stringify(t.traces);
      expect(serialized).not.toContain(KEY);
      expect(serialized).not.toContain("Lisbon");
      for (const { event, data } of t.traces) {
        expect(event).toBe("SpeechOut");
        expect(
          Object.keys(data).every((k) => allowedTraceKeys.includes(k)),
        ).toBe(true);
        expect(data.textLength).toBe(TEXT.length);
      }
    }
  });

  it("strips control characters and caps input at 300 characters", async () => {
    const long = `Hello  there\n\tfriend. ${"word ".repeat(400)}`;
    const cloud = setup();
    await cloud.output.speak(request(long));
    const input = JSON.parse(cloud.requests[0].init.body as string).input;
    expect(input.length).toBeLessThanOrEqual(maxSpeechChars);
    expect(input.length).toBeGreaterThan(250);
    expect(input).toMatch(/^Hello there friend\. word word/);
    expect(input).not.toMatch(/\p{Cc}/u);
    expect(input.endsWith("word")).toBe(true);

    const system = setup({ settings: { voiceEngine: "system" } });
    await system.output.speak(request(long));
    expect(system.calls[0].data?.text).toBe(input);
    expect(system.traces[0].data.textLength).toBe(input.length);

    const fake = fakeKokoro([[samples(100), END]]);
    const kokoro = withKokoro(fake);
    await kokoro.output.speak(request(long));
    expect(fake.syntheses[0].text).toBe(input);
    expect(kokoro.traces[0].data.textLength).toBe(input.length);
  });

  it("previews with the current engine at urgent priority", async () => {
    const t = setup();
    const result = await t.output.preview("Hi. I'll speak up when I need you.");
    expect(result).toEqual({ accepted: true, engine: "openai" });
    expect(t.calls[0]).toMatchObject({
      method: "playPcmStart",
      data: { priority: "urgent" },
    });
    expect(typeof t.calls[0].data?.utteranceId).toBe("string");
  });
});

/** Sentences that are all available at once. */
async function* sentences(...texts: string[]) {
  for (const text of texts) yield text;
}
const stream = (texts: string[], over: Record<string, unknown> = {}) => ({
  utteranceId: "u-1",
  sentences: sentences(...texts),
  priority: "result" as const,
  ...over,
});

describe("streamed replies: one utterance, sentence by sentence", () => {
  it("kokoro: one playPcmStart, both sentences' chunks in order, one playPcmEnd", async () => {
    const fake = fakeKokoro([
      [samples(6000), END],
      [samples(1000, 6000), END],
    ]);
    let synthesesAtFirstChunk = 0;
    const t = withKokoro(fake, {
      helper: (method) => {
        if (method === "playPcmChunk" && !synthesesAtFirstChunk)
          synthesesAtFirstChunk = fake.syntheses.length;
        return undefined;
      },
    });
    const result = await t.output.speakStream(
      stream(["First sentence.", "Second sentence."]),
    );
    expect(result).toEqual({
      accepted: true,
      engine: "kokoro",
      spoken: "First sentence. Second sentence.",
    });
    expect(t.methods()).toEqual([
      "playPcmStart",
      "playPcmChunk",
      "playPcmChunk",
      "playPcmChunk",
      "playPcmEnd",
    ]);
    expect(t.calls[0].data).toMatchObject({
      utteranceId: "u-1",
      priority: "result",
      sampleRate: 24000,
    });
    const decoded = t
      .chunks()
      .map((chunk) => Buffer.from(chunk.data as string, "base64"));
    expect(decoded.map((bytes) => bytes.length)).toEqual([9600, 2400, 2000]);
    expect(Buffer.concat(decoded)).toEqual(
      Buffer.concat([samples(6000), samples(1000, 6000)].map(bytesOf)),
    );
    // The second sentence was already being synthesized while the first
    // was being sent.
    expect(synthesesAtFirstChunk).toBe(2);
    expect(fake.syntheses.map((x) => x.text)).toEqual([
      "First sentence.",
      "Second sentence.",
    ]);
    expect((fake.synthesize.mock.calls[0] as unknown[])[2]).toEqual({
      speed: 1,
    });
    expect(t.traces.at(-1)!.data).toMatchObject({
      engine: "kokoro",
      status: "sentences_2",
      stream: true,
      sentences: 2,
    });
    for (const trace of t.traces) expect(trace.data).not.toHaveProperty("text");
  });

  it("a failing second sentence ends the utterance without a second voice", async () => {
    const fake = fakeKokoro([[samples(6000), END], [new Error("boom")]]);
    const t = withKokoro(fake);
    const result = await t.output.speakStream(
      stream(["First sentence.", "Second sentence."]),
    );
    expect(result).toEqual({
      accepted: true,
      engine: "kokoro",
      spoken: "First sentence.",
    });
    expect(t.methods()).toEqual([
      "playPcmStart",
      "playPcmChunk",
      "playPcmChunk",
      "playPcmEnd",
    ]);
    expect(t.methods()).not.toContain("speak");
  });

  it("a failing first sentence falls back to the system voice with what it has", async () => {
    const fake = fakeKokoro([[new Error("boom")], [samples(1000), END]]);
    const t = withKokoro(fake);
    const result = await t.output.speakStream(
      stream(["First sentence.", "Second sentence."]),
    );
    expect(result.engine).toBe("system");
    expect(result.accepted).toBe(true);
    expect(t.methods()).toEqual(["speak"]);
    expect(String(t.calls[0].data!.text)).toMatch(/^First sentence\./);
    expect(result.spoken).toBe(t.calls[0].data!.text);
    expect(
      t.traces.some(
        (x) => x.data.phase === "fallback" && x.data.fallback === true,
      ),
    ).toBe(true);
  });

  it("ends the utterance when the next sentence's audio is more than 2 s away", async () => {
    vi.useFakeTimers();
    const fake = fakeKokoro([[samples(6000), END], []]);
    const t = withKokoro(fake, { now: () => Date.now() });
    const pending = t.output.speakStream(stream(["First.", "Second."]));
    await vi.advanceTimersByTimeAsync(streamSpeech.sentenceGapMs - 1);
    expect(t.methods()).not.toContain("playPcmEnd");
    await vi.advanceTimersByTimeAsync(2);
    const result = await pending;
    expect(result).toEqual({
      accepted: true,
      engine: "kokoro",
      spoken: "First.",
    });
    expect(t.methods().at(-1)).toBe("playPcmEnd");
    expect(t.methods()).not.toContain("speak");
    // The abandoned sentence's synthesis was released.
    expect(fake.syntheses[1].signal.aborted).toBe(true);
  });

  it("waits for audio with no deadline without arming a timer (an Infinity timer fires every millisecond)", async () => {
    const spy = vi.spyOn(globalThis, "setTimeout");
    try {
      const fake = fakeKokoro([[samples(6000)]]);
      const t = withKokoro(fake);
      const pending = t.output.speakStream(stream(["First sentence."]));
      // Audio that arrives only after the utterance has been waiting for it.
      for (let i = 0; i < 5; i++) await Promise.resolve();
      fake.syntheses[0].push(samples(1000, 6000), END);
      const result = await pending;
      expect(result.spoken).toBe("First sentence.");
      const delays = spy.mock.calls.map((call) => call[1]);
      expect(delays.some((ms) => !Number.isFinite(ms))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("openai: one request per sentence with the persona's instructions, the second fetched ahead", async () => {
    const bodies = [openStream(), openStream()];
    const t = setup({
      settings: { persona: "friendly" },
      fetch: async () => response(bodies[t.requests.length - 1].stream),
    });
    const pending = t.output.speakStream(stream(["One.", "Two."]));
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Both requests are out before any audio was sent.
    expect(t.requests).toHaveLength(2);
    expect(t.methods()).toEqual([]);
    for (const [i, input] of ["One.", "Two."].entries())
      expect(JSON.parse(t.requests[i].init.body as string)).toEqual({
        model: "gpt-4o-mini-tts",
        voice: "cedar",
        input,
        instructions: PERSONA_INSTRUCTIONS.friendly,
        response_format: "pcm",
        stream_format: "audio",
      });
    bodies[0].push(pattern(9600));
    bodies[1].push(pattern(4800, 9600));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(t.methods()).toEqual(["playPcmStart", "playPcmChunk"]);
    for (const body of bodies) body.close();
    const result = await pending;
    expect(result).toEqual({
      accepted: true,
      engine: "openai",
      spoken: "One. Two.",
    });
    expect(t.methods()).toEqual([
      "playPcmStart",
      "playPcmChunk",
      "playPcmChunk",
      "playPcmEnd",
    ]);
  });

  it("the system voice speaks the joined sentences once", async () => {
    const t = setup({ settings: { voiceEngine: "system" } });
    const result = await t.output.speakStream(stream(["One.", "Two."]));
    expect(result).toEqual({
      accepted: true,
      engine: "system",
      spoken: "One. Two.",
    });
    expect(t.calls).toEqual([
      {
        method: "speak",
        data: { utteranceId: "u-1", text: "One. Two.", priority: "result" },
      },
    ]);
  });
});

describe("voices, styles and persona", () => {
  it("passes the Kokoro voice through and clamps the speed to 0.8–1.3", async () => {
    const fake = fakeKokoro([[samples(1000), END]]);
    const t = withKokoro(fake, {
      settings: { kokoroVoice: "bm_george", voiceRate: 1.4 },
    });
    await t.output.speak(request());
    expect((fake.synthesize.mock.calls[0] as unknown[])[2]).toEqual({
      voice: "bm_george",
      speed: 1.3,
    });
    expect(kokoroSpeed(0.5)).toBe(0.8);
    expect(kokoroSpeed(1.1)).toBe(1.1);
    expect(kokoroSpeed(undefined)).toBe(1);
    expect(kokoroSpeed(NaN)).toBe(1);
  });

  it("chooses the instruction by style and persona; the plain style keeps the accent", () => {
    expect(instructionFor("persona", "jarvis")).toBe(
      PERSONA_INSTRUCTIONS.jarvis,
    );
    expect(instructionFor("persona", "friendly")).toBe(
      PERSONA_INSTRUCTIONS.friendly,
    );
    expect(instructionFor("clear", "friendly")).toBe(CLEAR_INSTRUCTION);
    expect(instructionFor("clear", "jarvis")).toBe(
      `${CLEAR_INSTRUCTION} Accent: Received Pronunciation British English.`,
    );
    expect(PERSONA_INSTRUCTIONS.jarvis).toMatch(
      /butler|Received Pronunciation/,
    );
    expect(openaiSpeech.instructions).toBe(PERSONA_INSTRUCTIONS.jarvis);
  });

  it("sends the plain instruction for a clear-style line", async () => {
    const t = setup();
    await t.output.speak({ ...request("Send this message?"), style: "clear" });
    expect(JSON.parse(t.requests[0].init.body as string).instructions).toBe(
      instructionFor("clear", "jarvis"),
    );
  });

  it("accepts the five new cloud voices", async () => {
    for (const voice of ["ballad", "fable", "ash", "echo", "onyx"] as const) {
      expect(cloudVoices).toContain(voice);
      const t = setup({ settings: { cloudVoice: voice } });
      await t.output.speak(request());
      expect(JSON.parse(t.requests[0].init.body as string).voice).toBe(voice);
    }
  });
});
