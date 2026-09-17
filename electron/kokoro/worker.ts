/**
 * Kokoro speech worker: runs in an Electron utilityProcess (or, for scripts
 * and tests, a Node child process or worker thread). Loads onnxruntime-node
 * on the CPU execution provider, the Kokoro model, the af_heart voice, the
 * misaki gold lexicon and the BART fallback from paths main sends at start,
 * then synthesizes one request at a time, sentence by sentence, first
 * sentence first. Each sentence becomes one 24 kHz s16le PCM message with
 * leading silence trimmed to ~30 ms and trailing silence to ~150 ms.
 *
 * Never logs or echoes the text. Errors are fixed codes.
 */
import { readFile } from "node:fs/promises";
import { parentPort as threadPort } from "node:worker_threads";
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
import type { KokoroPaths } from "./manifest";
import type {
  KokoroErrorCode,
  KokoroWorkerRequest,
  KokoroWorkerResponse,
} from "./protocol";

interface Port {
  /** Resolves once the message has left this process. */
  send(message: KokoroWorkerResponse, transfer?: ArrayBuffer[]): Promise<void>;
  listen(receive: (message: KokoroWorkerRequest) => void): void;
}

interface ElectronParentPort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): void;
}

function connect(): Port {
  const electron = (process as unknown as { parentPort?: ElectronParentPort })
    .parentPort;
  if (electron)
    return {
      // Electron's parentPort cannot transfer ArrayBuffers; it clones once.
      send: async (message) => electron.postMessage(message),
      listen: (receive) =>
        electron.on("message", (event) =>
          receive(event.data as KokoroWorkerRequest),
        ),
    };
  if (threadPort) {
    const port = threadPort;
    return {
      send: async (message, transfer) => port.postMessage(message, transfer),
      listen: (receive) => port.on("message", receive),
    };
  }
  if (process.send) {
    process.on("disconnect", () => process.exit(0));
    return {
      // A large chunk may not fit the IPC socket at once; wait for the flush.
      send: (message) =>
        new Promise<void>((resolve) => {
          // The callback runs after the flush, or with an error once closed.
          if (!process.send) return resolve();
          process.send(message, undefined, undefined, () => resolve());
        }),
      listen: (receive) =>
        process.on("message", (m) => receive(m as KokoroWorkerRequest)),
    };
  }
  throw new Error("Kokoro worker has no parent");
}

class WorkerFailure extends Error {
  constructor(readonly code: KokoroErrorCode) {
    super(code);
  }
}

interface Engine {
  ort: typeof Ort;
  session: Ort.InferenceSession;
  voice: Float32Array;
  vocab: KokoroVocab;
  g2p: KokoroG2P;
  output: string;
}

type Job = Extract<KokoroWorkerRequest, { type: "synthesize" }>;

const INPUTS = ["input_ids", "style", "speed"];

async function load(paths: KokoroPaths, threads: number): Promise<Engine> {
  let ort: typeof Ort;
  try {
    // A plain require resolves inside app.asar and loads the unpacked addon.
    ort = require("onnxruntime-node") as typeof Ort;
  } catch {
    throw new WorkerFailure("runtime_unavailable");
  }
  let files: Buffer[];
  try {
    files = await Promise.all(
      [
        paths.voice,
        paths.tokenizer,
        paths.lexicon,
        paths.bartConfig,
        paths.bartWeights,
      ].map((path) => readFile(path)),
    );
  } catch {
    throw new WorkerFailure("files_missing");
  }
  const [voiceBytes, tokenizer, lexicon, bartConfig, bartWeights] = files;
  let engine: Omit<Engine, "session" | "output" | "ort">;
  try {
    const voice = new Float32Array(voiceBytes.byteLength / 4);
    new Uint8Array(voice.buffer).set(voiceBytes);
    const bart = new BartG2P(
      JSON.parse(bartConfig.toString("utf8")),
      parseSafetensors(bartWeights),
    );
    engine = {
      voice,
      vocab: parseTokenizerVocab(tokenizer.toString("utf8")),
      g2p: new KokoroG2P({
        gold: JSON.parse(lexicon.toString("utf8")),
        fallback: (word) => bart.predict(word),
      }),
    };
    styleFor(voice, 0); // throws if the voice pack is truncated
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
  return { ...engine, ort, session, output: session.outputNames[0] };
}

async function infer(engine: Engine, ids: number[]): Promise<Float32Array> {
  const { ort, session } = engine;
  const input = inputIds(ids);
  const feeds = {
    input_ids: new ort.Tensor("int64", input, [1, input.length]),
    style: new ort.Tensor("float32", styleFor(engine.voice, ids.length), [
      1,
      KOKORO_STYLE_DIM,
    ]),
    speed: new ort.Tensor("float32", Float32Array.of(1), [1]),
  };
  const result = await session.run(feeds);
  const waveform = result[engine.output];
  // Copy out of the ORT-owned buffer before the tensor is released.
  const audio = new Float32Array(waveform.data as Float32Array);
  for (const tensor of Object.values(result)) tensor.dispose?.();
  return audio;
}

const port = connect();
let engine: Promise<Engine> | undefined;
const queue: Job[] = [];
const cancelled = new Set<number>();
let running = false;
let current: number | undefined;

async function synthesize(job: Job): Promise<void> {
  const ready = await (engine ??
    Promise.reject(new WorkerFailure("load_failed")));
  const started = performance.now();
  let seq = 0;
  let samples = 0;
  let fallbackWords = 0;
  const done = (wasCancelled: boolean) =>
    port.send({
      type: "done",
      id: job.id,
      chunks: seq,
      cancelled: wasCancelled,
      synthMs: Math.round(performance.now() - started),
      audioMs: Math.round((samples / KOKORO_SAMPLE_RATE) * 1000),
      fallbackWords,
    });
  for (const sentence of splitSentences(normalizeText(job.text))) {
    const { phonemes, words } = ready.g2p.phonemize(sentence, {
      normalize: false,
    });
    fallbackWords += words.filter((w) => w.source !== "lexicon").length;
    for (const piece of splitPhonemes(phonemes, ready.vocab)) {
      if (cancelled.has(job.id)) return done(true);
      const { ids } = tokenize(piece, ready.vocab);
      if (!ids.length) continue;
      const sentenceStarted = performance.now();
      const audio = await infer(ready, ids);
      if (cancelled.has(job.id)) return done(true);
      const pcm = toInt16(trimSilence(audio, KOKORO_SAMPLE_RATE));
      if (!pcm.length) continue;
      samples += pcm.length;
      await port.send(
        {
          type: "chunk",
          id: job.id,
          seq: seq++,
          sampleRate: KOKORO_SAMPLE_RATE,
          pcm: pcm.buffer as ArrayBuffer,
          synthMs: Math.round(performance.now() - sentenceStarted),
        },
        [pcm.buffer as ArrayBuffer],
      );
      // onnxruntime-node runs inference synchronously and blocks this event
      // loop; yield so pending IPC writes and cancel messages are handled.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  return done(false);
}

async function pump(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (let job = queue.shift(); job; job = queue.shift()) {
      try {
        if (cancelled.has(job.id))
          port.send({
            type: "done",
            id: job.id,
            chunks: 0,
            cancelled: true,
            synthMs: 0,
            audioMs: 0,
            fallbackWords: 0,
          });
        else {
          current = job.id;
          await synthesize(job);
        }
      } catch (error) {
        port.send({
          type: "error",
          id: job.id,
          code:
            error instanceof WorkerFailure ? error.code : "synthesis_failed",
        });
      } finally {
        current = undefined;
        cancelled.delete(job.id);
      }
    }
  } finally {
    running = false;
  }
}

port.listen((message) => {
  if (!message || typeof message !== "object") return;
  switch (message.type) {
    case "init": {
      if (engine) return;
      const started = performance.now();
      const threads = Math.max(
        1,
        Math.min(8, Math.floor(message.threads) || 4),
      );
      engine = load(message.paths, threads);
      engine.then(
        () =>
          port.send({
            type: "ready",
            loadMs: Math.round(performance.now() - started),
          }),
        (error) =>
          port.send({
            type: "error",
            code: error instanceof WorkerFailure ? error.code : "load_failed",
          }),
      );
      return;
    }
    case "synthesize":
      if (typeof message.text !== "string" || !Number.isInteger(message.id))
        return;
      queue.push(message);
      void pump();
      return;
    case "cancel":
      // Only live jobs are remembered, so late cancels cannot accumulate.
      if (message.id === current || queue.some((job) => job.id === message.id))
        cancelled.add(message.id);
      return;
  }
});
