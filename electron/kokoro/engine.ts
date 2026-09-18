/**
 * The Kokoro engine the worker drives: the onnxruntime session and tokenizer
 * load at start; each accent's G2P (gold lexicon plus BART fallback) and each
 * voice's style pack are read the first time a request asks for them and
 * kept, so switching voices never restarts the worker and a pack downloaded
 * while it runs is picked up on the next sentence. A request for a voice
 * whose files are not there fails that request alone (`files_missing`).
 *
 * Separated from ./worker so the worker's transport stays thin and this can
 * run under a fake onnxruntime and fake files in unit tests. Never logs or
 * echoes the text. Errors are fixed codes.
 */
import { readFile } from "node:fs/promises";
import type * as Ort from "onnxruntime-node";
import { trimSilence, toInt16 } from "../../src/voice/kokoro/audio";
import { BartG2P, parseSafetensors } from "../../src/voice/kokoro/bart";
import { KokoroG2P } from "../../src/voice/kokoro/g2p";
import {
  normalizeText,
  splitSentences,
} from "../../src/voice/kokoro/normalize";
import {
  KOKORO_SAMPLE_RATE,
  KOKORO_STYLE_DIM,
  inputIds,
  parseTokenizerVocab,
  splitPhonemes,
  styleFor,
  tokenize,
  type KokoroVocab,
} from "../../src/voice/kokoro/tokens";
import {
  KOKORO_VOICES,
  isKokoroVoiceId,
  kokoroSpeed,
  type KokoroAccent,
  type KokoroVoiceId,
} from "../../src/voice/kokoro/voices";
import type { KokoroPaths } from "./manifest";
import type { KokoroErrorCode } from "./protocol";

export class WorkerFailure extends Error {
  constructor(readonly code: KokoroErrorCode) {
    super(code);
  }
}

export interface EngineDeps {
  /** Defaults to fs.readFile. */
  readFile?: (path: string) => Promise<Uint8Array>;
  /** Defaults to a plain require, which loads the unpacked addon in asar. */
  ort?: () => typeof Ort;
  now?: () => number;
}

export interface SynthesisRequest {
  text: string;
  voice: KokoroVoiceId;
  speed: number;
}

export interface SynthesisSink {
  /** One trimmed sentence; resolves once it has left the worker. */
  chunk(pcm: Int16Array, synthMs: number): Promise<void>;
  cancelled(): boolean;
}

export interface SynthesisStats {
  chunks: number;
  cancelled: boolean;
  synthMs: number;
  audioMs: number;
  fallbackWords: number;
}

export interface KokoroEngine {
  synthesize(
    request: SynthesisRequest,
    sink: SynthesisSink,
  ): Promise<SynthesisStats>;
}

const INPUTS = ["input_ids", "style", "speed"];

function requireOrt(): typeof Ort {
  return require("onnxruntime-node") as typeof Ort;
}

export async function loadEngine(
  paths: KokoroPaths,
  threads: number,
  deps: EngineDeps = {},
  preload?: KokoroVoiceId,
): Promise<KokoroEngine> {
  const read = deps.readFile ?? ((path) => readFile(path));
  const now = deps.now ?? (() => performance.now());
  let ort: typeof Ort;
  try {
    ort = (deps.ort ?? requireOrt)();
  } catch {
    throw new WorkerFailure("runtime_unavailable");
  }
  let tokenizer: Uint8Array;
  try {
    tokenizer = await read(paths.tokenizer);
  } catch {
    throw new WorkerFailure("files_missing");
  }
  let vocab: KokoroVocab;
  try {
    vocab = parseTokenizerVocab(Buffer.from(tokenizer).toString("utf8"));
  } catch {
    throw new WorkerFailure("load_failed");
  }
  let session: Ort.InferenceSession;
  try {
    session = await ort.InferenceSession.create(paths.model, {
      executionProviders: ["cpu"],
      intraOpNumThreads: threads,
      interOpNumThreads: 1,
      graphOptimizationLevel: "all",
    });
  } catch {
    throw new WorkerFailure("load_failed");
  }
  if (
    INPUTS.some((name) => !session.inputNames.includes(name)) ||
    !session.outputNames.length
  )
    throw new WorkerFailure("model_mismatch");
  const output = session.outputNames[0];

  // Promises are cached so two requests never read the same file twice; a
  // failure is dropped so a pack installed later is found on the next try.
  const voices = new Map<KokoroVoiceId, Promise<Float32Array>>();
  const accents = new Map<KokoroAccent, Promise<KokoroG2P>>();

  function voiceFor(voice: KokoroVoiceId): Promise<Float32Array> {
    const path = paths.voices[voice];
    if (!path) return Promise.reject(new WorkerFailure("files_missing"));
    let pending = voices.get(voice);
    if (!pending) {
      pending = (async () => {
        let bytes: Uint8Array;
        try {
          bytes = await read(path);
        } catch {
          throw new WorkerFailure("files_missing");
        }
        try {
          const pack = new Float32Array(bytes.byteLength >> 2);
          new Uint8Array(pack.buffer).set(bytes.subarray(0, pack.byteLength));
          styleFor(pack, 0); // throws if the pack is truncated
          return pack;
        } catch {
          throw new WorkerFailure("load_failed");
        }
      })();
      voices.set(voice, pending);
      pending.catch(() => voices.delete(voice));
    }
    return pending;
  }

  function g2pFor(accent: KokoroAccent): Promise<KokoroG2P> {
    const set = paths.accents[accent];
    if (!set) return Promise.reject(new WorkerFailure("files_missing"));
    let pending = accents.get(accent);
    if (!pending) {
      pending = (async () => {
        let files: Uint8Array[];
        try {
          files = await Promise.all(
            [set.lexicon, set.bartConfig, set.bartWeights].map(read),
          );
        } catch {
          throw new WorkerFailure("files_missing");
        }
        try {
          const [lexicon, bartConfig, bartWeights] = files;
          const bart = new BartG2P(
            JSON.parse(Buffer.from(bartConfig).toString("utf8")),
            parseSafetensors(bartWeights),
          );
          return new KokoroG2P({
            gold: JSON.parse(Buffer.from(lexicon).toString("utf8")),
            british: accent === "gb",
            fallback: (word) => bart.predict(word),
          });
        } catch {
          throw new WorkerFailure("load_failed");
        }
      })();
      accents.set(accent, pending);
      pending.catch(() => accents.delete(accent));
    }
    return pending;
  }

  /** The init preload: a voice's pack and accent, so `ready` means warm. */
  async function prepare(voice: KokoroVoiceId): Promise<void> {
    if (!isKokoroVoiceId(voice)) throw new WorkerFailure("files_missing");
    await Promise.all([voiceFor(voice), g2pFor(KOKORO_VOICES[voice].accent)]);
  }

  async function infer(
    ids: number[],
    pack: Float32Array,
    speed: number,
  ): Promise<Float32Array> {
    const input = inputIds(ids);
    const feeds = {
      input_ids: new ort.Tensor("int64", input, [1, input.length]),
      style: new ort.Tensor("float32", styleFor(pack, ids.length), [
        1,
        KOKORO_STYLE_DIM,
      ]),
      speed: new ort.Tensor("float32", Float32Array.of(speed), [1]),
    };
    const result = await session.run(feeds);
    const waveform = result[output];
    // Copy out of the ORT-owned buffer before the tensor is released.
    const audio = new Float32Array(waveform.data as Float32Array);
    for (const tensor of Object.values(result)) tensor.dispose?.();
    return audio;
  }

  async function synthesize(
    request: SynthesisRequest,
    sink: SynthesisSink,
  ): Promise<SynthesisStats> {
    const started = now();
    let chunks = 0;
    let samples = 0;
    let fallbackWords = 0;
    const stats = (cancelled: boolean): SynthesisStats => ({
      chunks,
      cancelled,
      synthMs: Math.round(now() - started),
      audioMs: Math.round((samples / KOKORO_SAMPLE_RATE) * 1000),
      fallbackWords,
    });
    if (!isKokoroVoiceId(request.voice))
      throw new WorkerFailure("files_missing");
    const [pack, g2p] = await Promise.all([
      voiceFor(request.voice),
      g2pFor(KOKORO_VOICES[request.voice].accent),
    ]);
    const speed = kokoroSpeed(request.speed);
    for (const sentence of splitSentences(normalizeText(request.text))) {
      const { phonemes, words } = g2p.phonemize(sentence, {
        normalize: false,
      });
      fallbackWords += words.filter((w) => w.source !== "lexicon").length;
      for (const piece of splitPhonemes(phonemes, vocab)) {
        if (sink.cancelled()) return stats(true);
        const { ids } = tokenize(piece, vocab);
        if (!ids.length) continue;
        const sentenceStarted = now();
        const audio = await infer(ids, pack, speed);
        if (sink.cancelled()) return stats(true);
        const pcm = toInt16(trimSilence(audio, KOKORO_SAMPLE_RATE));
        if (!pcm.length) continue;
        samples += pcm.length;
        chunks++;
        await sink.chunk(pcm, Math.round(now() - sentenceStarted));
        // onnxruntime-node runs inference synchronously and blocks this event
        // loop; yield so pending IPC writes and cancel messages are handled.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    return stats(false);
  }

  if (preload) await prepare(preload);
  return { synthesize };
}
