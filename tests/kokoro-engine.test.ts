import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type * as Ort from "onnxruntime-node";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadEngine, type SynthesisSink } from "../electron/kokoro/engine";
import {
  KOKORO_ALL_FILES,
  kokoroFileName,
  kokoroPaths,
  type KokoroVoiceId,
} from "../electron/kokoro/manifest";
import {
  KOKORO_STYLE_DIM,
  KOKORO_STYLE_ROWS,
} from "../src/voice/kokoro/tokens";
import { tinyBart } from "./kokoro-fakes";

const fixtures = fileURLToPath(new URL("./fixtures/kokoro/", import.meta.url));
const modelDir = "/models/kokoro";
const paths = kokoroPaths(modelDir, KOKORO_ALL_FILES, join);
const stored = (name: string) =>
  join(
    modelDir,
    kokoroFileName(KOKORO_ALL_FILES.find((f) => f.name === name)!),
  );

/** A style pack whose every value is `marker`, so feeds show which voice ran. */
const pack = (marker: number) =>
  new Uint8Array(
    new Float32Array(KOKORO_STYLE_ROWS * KOKORO_STYLE_DIM).fill(marker).buffer,
  );

interface Run {
  ids: bigint[];
  style: number;
  speed: number;
}

function fakeOrt(runs: Run[], options: { inputs?: string[] } = {}) {
  class Tensor {
    constructor(
      readonly type: string,
      readonly data: BigInt64Array | Float32Array,
      readonly dims: number[],
    ) {}
  }
  const create = vi.fn(async () => ({
    inputNames: options.inputs ?? ["input_ids", "style", "speed"],
    outputNames: ["waveform"],
    run: async (feeds: Record<string, Tensor>) => {
      runs.push({
        ids: [...(feeds.input_ids.data as BigInt64Array)],
        style: Number(feeds.style.data[0]),
        speed: Number(feeds.speed.data[0]),
      });
      // 300 ms of a 220 Hz tone at 24 kHz: survives the silence trimmer.
      const audio = new Float32Array(7200).map(
        (_, i) => 0.5 * Math.sin((2 * Math.PI * 220 * i) / 24000),
      );
      return { waveform: { data: audio, dispose: vi.fn() } };
    },
  }));
  return {
    ort: { Tensor, InferenceSession: { create } } as unknown as typeof Ort,
    create,
  };
}

describe("Kokoro engine", () => {
  let files: Map<string, Uint8Array>;
  let reads: string[];
  let runs: Run[];
  const readFile = async (path: string) => {
    reads.push(path);
    const body = files.get(path);
    if (!body) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return body;
  };
  /** Collects chunk lengths; cancels once `cancelAfter` have arrived. */
  const sink = (cancelAfter = Infinity) => {
    const chunks: number[] = [];
    const out: SynthesisSink & { chunks: number[] } = {
      chunks,
      chunk: async (pcm) => {
        chunks.push(pcm.length);
      },
      cancelled: () => chunks.length >= cancelAfter,
    };
    return out;
  };

  beforeEach(() => {
    const us = tinyBart([0, 0, 5, 0, 0, 0]);
    const gb = tinyBart([0, 0, 5, 0, 0, 0]);
    files = new Map<string, Uint8Array>([
      [
        stored("tokenizer.json"),
        readFileSync(join(fixtures, "tokenizer.json")),
      ],
      [
        stored("us_gold.json"),
        readFileSync(join(fixtures, "us_gold_subset.json")),
      ],
      [stored("g2p-bart-config.json"), us.config],
      [stored("g2p-bart.safetensors"), us.safetensors],
      [
        stored("gb_gold.json"),
        readFileSync(join(fixtures, "gb_gold_subset.json")),
      ],
      [stored("g2p-bart-gb-config.json"), gb.config],
      [stored("g2p-bart-gb.safetensors"), gb.safetensors],
      [stored("af_heart.bin"), pack(1)],
      [stored("bm_george.bin"), pack(2)],
      // bm_fable is not installed.
    ]);
    reads = [];
    runs = [];
  });

  const load = (preload?: KokoroVoiceId, inputs?: string[]) => {
    const fake = fakeOrt(runs, { inputs });
    return {
      engine: loadEngine(paths, 3, { readFile, ort: () => fake.ort }, preload),
      create: fake.create,
    };
  };
  const request = (voice: KokoroVoiceId, text = "Three.", speed = 1) => ({
    text,
    voice,
    speed,
  });

  it("loads the model and tokenizer at start, and a voice only when it is asked for", async () => {
    const { engine, create } = load();
    const ready = await engine;
    expect(create).toHaveBeenCalledWith(
      paths.model,
      expect.objectContaining({ intraOpNumThreads: 3 }),
    );
    expect(reads).toEqual([paths.tokenizer]);
    const first = sink();
    const stats = await ready.synthesize(request("af_heart"), first);
    expect(first.chunks).toHaveLength(1);
    expect(stats).toMatchObject({
      chunks: 1,
      cancelled: false,
      fallbackWords: 0,
    });
    expect(stats.audioMs).toBeGreaterThan(200);
    expect(reads.slice(1).sort()).toEqual(
      [
        stored("af_heart.bin"),
        stored("us_gold.json"),
        stored("g2p-bart-config.json"),
        stored("g2p-bart.safetensors"),
      ].sort(),
    );
    expect(runs[0].style).toBe(1);
    // Cached: the second sentence reads nothing.
    await ready.synthesize(request("af_heart"), sink());
    expect(reads).toHaveLength(5);
  });

  it("loads the British pack on demand, pronounces with gb_gold and caches it", async () => {
    const { engine } = load();
    const ready = await engine;
    await ready.synthesize(request("af_heart"), sink());
    const before = reads.length;
    await ready.synthesize(request("bm_george"), sink());
    expect(reads.slice(before).sort()).toEqual(
      [
        stored("bm_george.bin"),
        stored("gb_gold.json"),
        stored("g2p-bart-gb-config.json"),
        stored("g2p-bart-gb.safetensors"),
      ].sort(),
    );
    expect(runs.map((r) => r.style)).toEqual([1, 2]);
    // "three" is θɹˈi in us_gold and θɹˈiː in gb_gold: one token longer.
    expect(runs[1].ids.length).toBe(runs[0].ids.length + 1);
    await ready.synthesize(request("bm_george"), sink());
    expect(reads.length).toBe(before + 4);
    expect(runs[2].style).toBe(2);
  });

  it("preloads the voice named at init so ready means ready", async () => {
    const { engine } = load("bm_george");
    await engine;
    expect(reads.sort()).toEqual(
      [
        paths.tokenizer,
        stored("bm_george.bin"),
        stored("gb_gold.json"),
        stored("g2p-bart-gb-config.json"),
        stored("g2p-bart-gb.safetensors"),
      ].sort(),
    );
    await expect(load("bm_fable").engine).rejects.toMatchObject({
      code: "files_missing",
    });
  });

  it("fails only the request whose voice is missing, and retries once it appears", async () => {
    const ready = await load().engine;
    await expect(
      ready.synthesize(request("bm_fable"), sink()),
    ).rejects.toMatchObject({ code: "files_missing" });
    await expect(
      ready.synthesize(request("nope" as KokoroVoiceId), sink()),
    ).rejects.toMatchObject({ code: "files_missing" });
    expect(await ready.synthesize(request("af_heart"), sink())).toMatchObject({
      chunks: 1,
    });
    // A truncated pack is a load failure, not cached as one.
    files.set(stored("bm_fable.bin"), pack(3).subarray(0, 100));
    await expect(
      ready.synthesize(request("bm_fable"), sink()),
    ).rejects.toMatchObject({ code: "load_failed" });
    files.set(stored("bm_fable.bin"), pack(3));
    await ready.synthesize(request("bm_fable"), sink());
    expect(runs.at(-1)?.style).toBe(3);
  });

  it("feeds the clamped speed to the model", async () => {
    const ready = await load().engine;
    for (const speed of [2, 0.5, Number.NaN, 1.15])
      await ready.synthesize(request("af_heart", "Three.", speed), sink());
    expect(runs.map((r) => r.speed)).toEqual([
      1.2999999523162842, 0.800000011920929, 1, 1.149999976158142,
    ]);
  });

  it("stops after the current sentence when cancelled", async () => {
    const ready = await load().engine;
    const stats = await ready.synthesize(
      request("af_heart", "Three. Three. Three."),
      sink(1),
    );
    expect(stats).toMatchObject({ chunks: 1, cancelled: true });
    expect(runs).toHaveLength(1);
  });

  it("reports load problems as codes", async () => {
    files.delete(paths.tokenizer);
    await expect(load().engine).rejects.toMatchObject({
      code: "files_missing",
    });
    files.set(paths.tokenizer, new TextEncoder().encode("{}"));
    await expect(load().engine).rejects.toMatchObject({ code: "load_failed" });
    files.set(paths.tokenizer, readFileSync(join(fixtures, "tokenizer.json")));
    await expect(load(undefined, ["input_ids"]).engine).rejects.toMatchObject({
      code: "model_mismatch",
    });
    await expect(
      loadEngine(paths, 4, {
        readFile,
        ort: () => {
          throw new Error("no addon");
        },
      }),
    ).rejects.toMatchObject({ code: "runtime_unavailable" });
  });
});
