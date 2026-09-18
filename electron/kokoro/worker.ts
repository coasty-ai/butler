/**
 * Kokoro speech worker: runs in an Electron utilityProcess (or, for scripts
 * and tests, a Node child process or worker thread). Loads the engine
 * (./engine: onnxruntime-node on the CPU execution provider, the Kokoro
 * model, one G2P per accent and one style pack per voice, read on demand)
 * from paths main sends at start, then synthesizes one request at a time,
 * sentence by sentence, first sentence first. Each sentence becomes one
 * 24 kHz s16le PCM message with leading silence trimmed to ~30 ms and
 * trailing silence to ~150 ms.
 *
 * Never logs or echoes the text. Errors are fixed codes.
 */
import { parentPort as threadPort } from "node:worker_threads";
import { KOKORO_SAMPLE_RATE } from "../../src/voice/kokoro/tokens";
import { WorkerFailure, loadEngine, type KokoroEngine } from "./engine";
import type { KokoroWorkerRequest, KokoroWorkerResponse } from "./protocol";

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

type Job = Extract<KokoroWorkerRequest, { type: "synthesize" }>;

const port = connect();
let engine: Promise<KokoroEngine> | undefined;
const queue: Job[] = [];
const cancelled = new Set<number>();
let running = false;
let current: number | undefined;

async function synthesize(job: Job): Promise<void> {
  const ready = await (engine ??
    Promise.reject(new WorkerFailure("load_failed")));
  let seq = 0;
  const stats = await ready.synthesize(
    { text: job.text, voice: job.voice, speed: job.speed },
    {
      cancelled: () => cancelled.has(job.id),
      chunk: (pcm, synthMs) =>
        port.send(
          {
            type: "chunk",
            id: job.id,
            seq: seq++,
            sampleRate: KOKORO_SAMPLE_RATE,
            pcm: pcm.buffer as ArrayBuffer,
            synthMs,
          },
          [pcm.buffer as ArrayBuffer],
        ),
    },
  );
  return port.send({ type: "done", id: job.id, ...stats });
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
      engine = loadEngine(message.paths, threads, {}, message.voice);
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
