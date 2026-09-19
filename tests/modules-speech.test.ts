/**
 * The tts port in electron/speech-output.ts (design modules.md §6, §10):
 * with settings.modules.tts naming an adapter and a registry in the deps,
 * a sentence goes to modules.port("tts"); wav audio it returns is played
 * through the helper's PCM path at the wav's own rate, `played` is taken
 * at its word, and anything else falls back to the engines. In Private
 * local an adapter that reaches the internet is never asked. Also the wav
 * reader and the format sniff.
 */
import { describe, expect, it, vi } from "vitest";
import {
  audioFormat,
  createSpeechOutput,
  wavToPcm,
  type SpeechSettings,
} from "../electron/speech-output";
import type { ModuleRegistry, PortAdapter } from "../src/modules/registry";
import type { PortInput, PortName, PortOutput } from "../src/modules/contracts";
import { toolServerSchema, type ToolServer } from "../src/core/schema";

const TEXT = "Your flight to Lisbon is confirmed for Tuesday";
type Call = { method: string; data?: Record<string, unknown> };

/** A wav file: PCM integer (format 1) or float (format 3), interleaved frames. */
function wav(o: {
  sampleRate: number;
  channels: number;
  bits: 8 | 16 | 24 | 32;
  float?: boolean;
  frames: number[][];
}): Uint8Array {
  const bytesPerSample = o.bits / 8;
  const dataBytes = o.frames.length * o.channels * bytesPerSample;
  const out = new Uint8Array(44 + dataBytes);
  const v = new DataView(out.buffer);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i);
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, o.float ? 3 : 1, true);
  v.setUint16(22, o.channels, true);
  v.setUint32(24, o.sampleRate, true);
  v.setUint32(28, o.sampleRate * o.channels * bytesPerSample, true);
  v.setUint16(32, o.channels * bytesPerSample, true);
  v.setUint16(34, o.bits, true);
  ascii(36, "data");
  v.setUint32(40, dataBytes, true);
  let at = 44;
  for (const frame of o.frames)
    for (const sample of frame) {
      if (o.float) v.setFloat32(at, sample, true);
      else if (o.bits === 8) v.setUint8(at, sample);
      else if (o.bits === 16) v.setInt16(at, sample, true);
      else if (o.bits === 24) {
        v.setUint8(at, sample & 0xff);
        v.setUint8(at + 1, (sample >> 8) & 0xff);
        v.setUint8(at + 2, (sample >> 16) & 0xff);
      } else v.setInt32(at, sample, true);
      at += bytesPerSample;
    }
  return out;
}
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const pcmOf = (calls: Call[]) =>
  Buffer.concat(
    calls
      .filter((c) => c.method === "playPcmChunk")
      .map((c) => Buffer.from(c.data!.data as string, "base64")),
  );
const server = (over: Partial<ToolServer> = {}): ToolServer =>
  toolServerSchema.parse({
    id: "voice",
    name: "Voice server",
    transport: "stdio",
    command: "voice-mcp",
    enabled: true,
    network: "none",
    addedAt: 0,
    ...over,
  });

function setup(o: {
  reply?: (
    input: PortInput<"tts">,
  ) => Promise<PortOutput<"tts">> | PortOutput<"tts">;
  settings?: Partial<SpeechSettings>;
  helper?: (method: string, data?: Record<string, unknown>) => unknown;
  noRegistry?: boolean;
}) {
  const settings: SpeechSettings = {
    privacy: "PRIVATE_BYOM",
    voiceEngine: "system",
    modules: {
      tts: { kind: "http", url: "https://tts.example/speak", fallback: true },
    },
    tools: { servers: [] },
    ...o.settings,
  };
  const calls: Call[] = [];
  const asked: PortInput<"tts">[] = [];
  const traces: { event: string; data: Record<string, unknown> }[] = [];
  const defaults: Record<string, unknown> = {
    speak: { accepted: true },
    playPcmStart: { accepted: true },
    playPcmChunk: { ok: true },
    playPcmEnd: { ok: true },
    playPcmAbort: { aborted: true, started: false },
    stopSpeaking: {},
  };
  const registry: Pick<ModuleRegistry, "port"> = {
    port: (<P extends PortName>(name: P): PortAdapter<P> => ({
      call: async (input: PortInput<P>) => {
        if (name !== "tts") throw new Error("not tts");
        asked.push(input as PortInput<"tts">);
        return (await (o.reply ?? (() => ({ played: true, ms: 12 })))(
          input as PortInput<"tts">,
        )) as PortOutput<P>;
      },
    })) as ModuleRegistry["port"],
  };
  const output = createSpeechOutput({
    settings: () => settings,
    openaiKey: () => "",
    voiceCall: vi.fn(async (method: string, data?: Record<string, unknown>) => {
      calls.push({ method, data });
      return (await o.helper?.(method, data)) ?? defaults[method];
    }),
    fetch: async () => {
      throw new Error("no network");
    },
    kokoroSupported: () => false,
    modules: o.noRegistry ? undefined : () => registry,
    trace: (event, data) => traces.push({ event, data }),
  });
  return {
    output,
    calls,
    asked,
    traces,
    methods: () => calls.map((c) => c.method),
    phases: () =>
      traces.map((t) => [
        t.data.phase,
        t.data.engine,
        t.data.status,
        t.data.fallback,
      ]),
  };
}
const request = { utteranceId: "u-1", text: TEXT, priority: "result" as const };

describe("the tts port", () => {
  it("plays wav audio an adapter returns through the helper at the wav's rate, as one PCM utterance", async () => {
    const audio = wav({
      sampleRate: 22050,
      channels: 2,
      bits: 16,
      frames: [
        [1000, 3000],
        [-2000, 2000],
        [32767, 32767],
      ],
    });
    const t = setup({ reply: () => ({ audio: base64(audio), ms: 40 }) });
    expect(await t.output.speak(request)).toEqual({
      accepted: true,
      engine: "module",
    });
    expect(t.asked).toEqual([{ text: TEXT }]);
    expect(t.methods()).toEqual(["playPcmStart", "playPcmChunk", "playPcmEnd"]);
    expect(t.calls[0].data).toEqual({
      utteranceId: "u-1",
      priority: "result",
      sampleRate: 22050,
      format: "s16le",
      text: TEXT,
    });
    // Stereo averaged to mono, 16-bit little-endian.
    const pcm = pcmOf(t.calls);
    expect([
      pcm.readInt16LE(0),
      pcm.readInt16LE(2),
      pcm.readInt16LE(4),
    ]).toEqual([2000, 0, 32767]);
    expect(t.phases()).toEqual([
      ["requested", "system", undefined, false],
      ["started", "module", undefined, false],
      ["finished", "module", "ok", false],
    ]);
    // The trace never carries the audio or the words.
    expect(JSON.stringify(t.traces)).not.toMatch(/Lisbon|UklGR/);
  });
  it("takes `played` at its word, with nothing sent to the helper", async () => {
    const t = setup({ reply: () => ({ played: true, ms: 80 }) });
    expect(await t.output.speak(request)).toEqual({
      accepted: true,
      engine: "module",
    });
    expect(t.methods()).toEqual([]);
    expect(t.phases().at(-1)).toEqual(["finished", "module", "played", false]);
  });
  it("falls back to the engines when the adapter fails, returns nothing playable, mp3, or `played: false`", async () => {
    const cases: [string, () => PortOutput<"tts">][] = [
      [
        "adapter_failed",
        () => {
          throw new Error("down");
        },
      ],
      ["not_played", () => ({ played: false, ms: 5 })],
      [
        "mp3_unsupported",
        () => ({
          audio: Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]).toString(
            "base64",
          ),
          ms: 5,
        }),
      ],
      [
        "audio_unknown",
        () => ({ audio: Buffer.from("hello there").toString("base64"), ms: 5 }),
      ],
      [
        "wav_invalid",
        () => ({
          audio: base64(
            wav({ sampleRate: 4000, channels: 1, bits: 16, frames: [[1]] }),
          ),
          ms: 5,
        }),
      ],
    ];
    for (const [status, reply] of cases) {
      const t = setup({ reply });
      expect(await t.output.speak(request), status).toEqual({
        accepted: true,
        engine: "system",
      });
      expect(t.methods(), status).toEqual(["speak"]);
      expect(t.phases(), status).toContainEqual([
        "fallback",
        "module",
        status,
        true,
      ]);
    }
  });
  it("in Private local never asks an adapter that reaches the internet, and asks a local one", async () => {
    const remote = setup({
      settings: {
        privacy: "PRIVATE_LOCAL",
        modules: {
          tts: {
            kind: "http",
            url: "https://tts.example/speak",
            fallback: true,
          },
        },
      },
    });
    expect(await remote.output.speak(request)).toEqual({
      accepted: true,
      engine: "system",
    });
    expect(remote.asked).toEqual([]);
    expect(remote.phases()).toContainEqual([
      "fallback",
      "module",
      "private_local",
      true,
    ]);
    const loopback = setup({
      settings: {
        privacy: "PRIVATE_LOCAL",
        modules: {
          tts: {
            kind: "http",
            url: "http://127.0.0.1:5002/speak",
            fallback: true,
          },
        },
      },
    });
    expect(await loopback.output.speak(request)).toEqual({
      accepted: true,
      engine: "module",
    });
    expect(loopback.asked).toHaveLength(1);
    const localServer = setup({
      settings: {
        privacy: "PRIVATE_LOCAL",
        modules: {
          tts: { kind: "mcp", server: "voice", tool: "speak", fallback: true },
        },
        tools: { servers: [server()] },
      },
    });
    expect(await localServer.output.speak(request)).toEqual({
      accepted: true,
      engine: "module",
    });
    const internetServer = setup({
      settings: {
        privacy: "PRIVATE_LOCAL",
        modules: {
          tts: { kind: "mcp", server: "voice", tool: "speak", fallback: true },
        },
        tools: { servers: [server({ network: "internet" })] },
      },
    });
    expect(await internetServer.output.speak(request)).toEqual({
      accepted: true,
      engine: "system",
    });
    expect(internetServer.asked).toEqual([]);
  });
  it("with the choice builtin or no registry the engines speak as before", async () => {
    const builtin = setup({
      settings: { modules: { tts: { kind: "builtin" } } },
    });
    expect(await builtin.output.speak(request)).toEqual({
      accepted: true,
      engine: "system",
    });
    expect(builtin.asked).toEqual([]);
    const none = setup({ noRegistry: true });
    expect(await none.output.speak(request)).toEqual({
      accepted: true,
      engine: "system",
    });
    expect(none.asked).toEqual([]);
  });
  it("speaks a streamed reply through the adapter once its sentences are gathered", async () => {
    vi.useFakeTimers();
    try {
      const t = setup({ reply: () => ({ played: true, ms: 10 }) });
      async function* sentences() {
        yield "Your flight is confirmed.";
        yield "It leaves at nine.";
      }
      const pending = t.output.speakStream({
        utteranceId: "u-2",
        sentences: sentences(),
        priority: "result",
      });
      await vi.advanceTimersByTimeAsync(5000);
      expect(await pending).toEqual({
        accepted: true,
        engine: "module",
        spoken: "Your flight is confirmed. It leaves at nine.",
      });
      expect(t.asked).toEqual([
        { text: "Your flight is confirmed. It leaves at nine." },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("wav reading", () => {
  it("sniffs wav, mp3 and anything else", () => {
    expect(
      audioFormat(
        wav({ sampleRate: 16000, channels: 1, bits: 16, frames: [[1]] }),
      ),
    ).toBe("wav");
    expect(audioFormat(new Uint8Array([0x49, 0x44, 0x33, 3, 0]))).toBe("mp3");
    expect(audioFormat(new Uint8Array([0xff, 0xfb, 0x90, 0x00]))).toBe("mp3");
    expect(audioFormat(new Uint8Array([1, 2, 3]))).toBe("unknown");
  });
  it("reads 8, 16, 24 and 32-bit integer and float samples into mono s16le, and refuses what it cannot", () => {
    const read = (bytes: Uint8Array) => {
      const out = wavToPcm(bytes)!;
      const view = Buffer.from(out.pcm);
      return {
        rate: out.sampleRate,
        samples: Array.from({ length: view.length / 2 }, (_, i) =>
          view.readInt16LE(i * 2),
        ),
      };
    };
    expect(
      read(
        wav({
          sampleRate: 16000,
          channels: 1,
          bits: 16,
          frames: [[-32768], [0], [32767]],
        }),
      ),
    ).toEqual({
      rate: 16000,
      samples: [-32768, 0, 32767],
    });
    expect(
      read(
        wav({
          sampleRate: 8000,
          channels: 1,
          bits: 8,
          frames: [[0], [128], [255]],
        }),
      ).samples,
    ).toEqual([-32768, 0, 32512]);
    expect(
      read(
        wav({
          sampleRate: 48000,
          channels: 1,
          bits: 24,
          frames: [[0x400000], [-0x400000 & 0xffffff]],
        }),
      ).samples,
    ).toEqual([16384, -16384]);
    expect(
      read(
        wav({
          sampleRate: 24000,
          channels: 1,
          bits: 32,
          frames: [[1 << 30], [-(1 << 30)]],
        }),
      ).samples,
    ).toEqual([16384, -16384]);
    expect(
      read(
        wav({
          sampleRate: 24000,
          channels: 1,
          bits: 32,
          float: true,
          frames: [[0.5], [-1], [2]],
        }),
      ).samples,
    ).toEqual([16384, -32768, 32767]);
    expect(
      wavToPcm(
        wav({ sampleRate: 96000, channels: 1, bits: 16, frames: [[1]] }),
      ),
    ).toBeUndefined();
    expect(wavToPcm(new Uint8Array(3))).toBeUndefined();
    const compressed = wav({
      sampleRate: 16000,
      channels: 1,
      bits: 16,
      frames: [[1]],
    });
    new DataView(compressed.buffer).setUint16(20, 85, true); // MPEG layer 3 in a wav
    expect(wavToPcm(compressed)).toBeUndefined();
  });
});
