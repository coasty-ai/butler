/**
 * Main-process API for the free on-device Kokoro voice.
 *
 * - Downloads pinned files (./manifest) into a directory main chooses, one
 *   verified file at a time: bytes go to `<name>.partial`, the sha256 and size
 *   are checked, then the file is renamed into place. An interrupted download
 *   resumes with an HTTP Range request, or restarts if the server ignores it.
 * - Synthesizes in a lazily forked utilityProcess (./worker) that is killed
 *   after 5 minutes idle, forked again after a crash (pending work is
 *   rejected with a KokoroError), and never runs onnxruntime in main.
 *
 * Traces are content-free: codes, counts and durations only, never the text.
 *
 * Playing it (speech-output.ts): use it only when kokoroSupported() and
 * status().installed. Await the FIRST chunk before playPcmStart (the helper
 * fails a PCM utterance that stays silent for 2.5 s, and a cold worker needs
 * ~1.2-2 s), then send each chunk's Int16 bytes as s16le playPcmChunk pieces
 * and finish with playPcmEnd. Abort the signal on stop or supersede. Any
 * error before the helper acknowledged audio falls back to the system voice.
 */
import { createHash, type Hash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import {
  mkdir,
  open,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  statfs,
} from "node:fs/promises";
import { join } from "node:path";
import * as electron from "electron";
import { KOKORO_SAMPLE_RATE } from "../../src/voice/kokoro/tokens";
import {
  KOKORO_FILES,
  KOKORO_STORED_NAME,
  kokoroFileName,
  kokoroPaths,
  type KokoroFile,
} from "./manifest";
import type {
  KokoroErrorCode,
  KokoroWorkerRequest,
  KokoroWorkerResponse,
} from "./protocol";

export type { KokoroErrorCode } from "./protocol";

export interface KokoroChunk {
  /** Mono s16 samples in platform (little-endian) order. */
  pcm: Int16Array;
  sampleRate: typeof KOKORO_SAMPLE_RATE;
}

export interface KokoroStatus {
  installed: boolean;
  downloading: boolean;
  /** 0-1 over all pinned files. */
  progress: number;
  bytes: number;
  totalBytes: number;
  error?: KokoroErrorCode;
}

export interface KokoroWorkerHandle {
  postMessage(message: KokoroWorkerRequest): void;
  on(
    event: "message",
    listener: (message: KokoroWorkerResponse) => void,
  ): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  kill(): unknown;
}

export type KokoroFork = (modulePath: string) => KokoroWorkerHandle;

export interface KokoroVoiceOptions {
  /** userData/voices/kokoro in the app. */
  modelDir: string;
  /** Defaults to Electron's utilityProcess.fork. */
  fork?: KokoroFork;
  /** Defaults to globalThis.fetch; main passes its desktop transport. */
  fetch?: typeof fetch;
  now?: () => number;
  trace?: (event: string, data: Record<string, unknown>) => void;
  /** Built worker; defaults to dist-electron/kokoro/worker.cjs. */
  workerPath?: string;
  files?: readonly KokoroFile[];
  idleMs?: number;
  readyTimeoutMs?: number;
  stallMs?: number;
}

export interface KokoroVoice {
  status(): KokoroStatus;
  /** Joins a download already in progress; any caller's signal cancels it. */
  download(
    onProgress?: (status: KokoroStatus) => void,
    signal?: AbortSignal,
  ): Promise<void>;
  remove(): Promise<void>;
  /** Starts the worker and runs one short synthesis. */
  warm(): Promise<void>;
  /**
   * One PCM chunk per sentence, first sentence first. Nothing starts until
   * iteration begins. Aborting rejects with `signal.reason` and cancels the
   * rest in the worker; failures reject with a {@link KokoroError}.
   */
  synthesize(text: string, signal?: AbortSignal): AsyncIterable<KokoroChunk>;
  dispose(): void;
}

export class KokoroError extends Error {
  constructor(readonly code: KokoroErrorCode) {
    super(code);
    this.name = "KokoroError";
  }
}

export const kokoroDefaults = {
  idleMs: 5 * 60_000,
  readyTimeoutMs: 60_000,
  /** No worker message for this long while a request is live means it hung. */
  stallMs: 30_000,
  threads: 4,
  crashLimit: 3,
  crashWindowMs: 2 * 60_000,
  crashCooldownMs: 60_000,
  progressIntervalMs: 100,
  /** Headroom kept free on disk beyond the remaining download. */
  spareBytes: 64 * 1024 * 1024,
  warmText: "Okay.",
} as const;

/** onnxruntime-node 1.30.0 ships no darwin-x64 binary; Intel Macs use Apple speech. */
export function kokoroSupported(
  platform: string = process.platform,
  arch: string = process.arch,
): boolean {
  return platform === "darwin" && arch === "arm64";
}

type Timer = ReturnType<typeof setTimeout>;

/** A single-consumer queue of chunks for one synthesis request. */
class ChunkQueue {
  private readonly items: KokoroChunk[] = [];
  private finished = false;
  private failure: unknown;
  private wake?: () => void;

  push(chunk: KokoroChunk) {
    if (this.finished) return;
    this.items.push(chunk);
    this.notify();
  }
  end() {
    this.finished = true;
    this.notify();
  }
  fail(error: unknown) {
    if (this.finished) return;
    this.failure = error;
    this.finished = true;
    this.notify();
  }
  private notify() {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }
  async next(signal?: AbortSignal): Promise<KokoroChunk | undefined> {
    for (;;) {
      signal?.throwIfAborted();
      if (this.items.length) return this.items.shift();
      if (this.finished) {
        if (this.failure !== undefined) throw this.failure;
        return undefined;
      }
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          this.wake = undefined;
          reject(signal?.reason);
        };
        this.wake = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }
}

interface Live {
  handle: KokoroWorkerHandle;
  ready: Promise<void>;
  settle: (error?: KokoroError) => void;
  exited: boolean;
  /** Set when we stop it on purpose, so its exit is not a crash. */
  stopped?: KokoroError;
  streams: Map<number, ChunkQueue>;
  readyTimer?: Timer;
  stallTimer?: Timer;
}

function untilAborted<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function pcmOf(value: unknown): Int16Array | undefined {
  if (value instanceof ArrayBuffer)
    return new Int16Array(value, 0, value.byteLength >> 1);
  if (ArrayBuffer.isView(value))
    return new Int16Array(
      value.buffer.slice(
        value.byteOffset,
        value.byteOffset + (value.byteLength & ~1),
      ),
    );
  return undefined;
}

const WORKER_ENV = ["HOME", "TMPDIR", "LANG", "LC_ALL", "PATH"];

function electronFork(modulePath: string): KokoroWorkerHandle {
  const utility = (
    electron as { utilityProcess?: typeof electron.utilityProcess }
  ).utilityProcess;
  if (!utility?.fork) throw new KokoroError("runtime_unavailable");
  // The worker needs no credentials, so it inherits almost no environment.
  const env: Record<string, string> = {};
  for (const key of WORKER_ENV)
    if (process.env[key]) env[key] = process.env[key]!;
  const child = utility.fork(modulePath, [], {
    serviceName: "Open Assist Voice",
    stdio: "ignore",
    env,
  });
  return {
    postMessage: (message) => child.postMessage(message),
    on: (event: "message" | "exit", listener: (value: any) => void) =>
      child.on(event as "exit", listener),
    kill: () => child.kill(),
  };
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return -1;
  }
}

async function hashInto(path: string, hash: Hash, signal: AbortSignal) {
  for await (const chunk of createReadStream(path, { signal }))
    hash.update(chunk as Buffer);
}

export function createKokoroVoice(options: KokoroVoiceOptions): KokoroVoice {
  const modelDir = options.modelDir;
  const files = options.files ?? KOKORO_FILES;
  const paths = kokoroPaths(modelDir, files, join);
  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  const fork = options.fork ?? electronFork;
  const doFetch =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const now = options.now ?? (() => performance.now());
  const idleMs = options.idleMs ?? kokoroDefaults.idleMs;
  const readyTimeoutMs =
    options.readyTimeoutMs ?? kokoroDefaults.readyTimeoutMs;
  const stallMs = options.stallMs ?? kokoroDefaults.stallMs;
  // main.cjs and kokoro/worker.cjs are both emitted into dist-electron.
  const workerPath = () =>
    options.workerPath ??
    join(
      typeof __dirname === "string" ? __dirname : ".",
      "kokoro",
      "worker.cjs",
    );

  let live: Live | undefined;
  let active = 0;
  let sequence = 0;
  let idleTimer: Timer | undefined;
  let disposed = false;
  let lastError: KokoroErrorCode | undefined;
  let crashes: number[] = [];
  let cooldownUntil = -Infinity;
  let job:
    | {
        promise: Promise<void>;
        controller: AbortController;
        listeners: Set<(status: KokoroStatus) => void>;
        bytes: number;
        lastEmit: number;
      }
    | undefined;

  const trace = (data: Record<string, unknown>) => {
    try {
      options.trace?.("KokoroVoice", data);
    } catch {}
  };

  function installed(): boolean {
    return files.every((file) => {
      try {
        return (
          statSync(join(modelDir, kokoroFileName(file))).size === file.size
        );
      } catch {
        return false;
      }
    });
  }

  function status(): KokoroStatus {
    const ready = installed();
    const bytes = job ? job.bytes : ready ? totalBytes : 0;
    return {
      installed: ready,
      downloading: Boolean(job),
      progress: totalBytes ? Math.min(1, bytes / totalBytes) : 1,
      bytes,
      totalBytes,
      ...(lastError ? { error: lastError } : {}),
    };
  }

  // Worker lifecycle -------------------------------------------------------

  function post(target: Live, message: KokoroWorkerRequest) {
    try {
      target.handle.postMessage(message);
    } catch {}
  }

  function clearIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
  }

  function scheduleIdle() {
    clearIdle();
    if (active > 0 || !live || disposed) return;
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      if (active === 0 && live) {
        trace({ phase: "idle_stop" });
        stop(live, new KokoroError("worker_unavailable"));
      }
    }, idleMs);
    (idleTimer as { unref?: () => void }).unref?.();
  }

  function armStall(target: Live) {
    if (target.stallTimer) clearTimeout(target.stallTimer);
    target.stallTimer = undefined;
    if (!target.streams.size || target.exited) return;
    target.stallTimer = setTimeout(() => {
      if (target !== live || !target.streams.size) return;
      lastError = "worker_stalled";
      trace({ phase: "stalled" });
      stop(target, new KokoroError("worker_stalled"));
    }, stallMs);
  }

  function fail(target: Live, error: KokoroError) {
    if (target.readyTimer) clearTimeout(target.readyTimer);
    if (target.stallTimer) clearTimeout(target.stallTimer);
    target.readyTimer = target.stallTimer = undefined;
    target.settle(error);
    for (const stream of target.streams.values()) stream.fail(error);
    target.streams.clear();
  }

  /** Stops a worker on purpose: its exit is not counted as a crash. */
  function stop(target: Live, reason: KokoroError) {
    target.stopped ??= reason;
    if (live === target) live = undefined;
    fail(target, reason);
    if (!target.exited) {
      try {
        target.handle.kill();
      } catch {}
    }
  }

  function onExit(target: Live, code: number) {
    if (target.exited) return;
    target.exited = true;
    if (live === target) live = undefined;
    if (target.stopped) {
      fail(target, target.stopped);
      return;
    }
    const at = now();
    crashes = [
      ...crashes.filter((t) => at - t < kokoroDefaults.crashWindowMs),
      at,
    ];
    if (crashes.length >= kokoroDefaults.crashLimit)
      cooldownUntil = at + kokoroDefaults.crashCooldownMs;
    lastError = "worker_crashed";
    trace({
      phase: "crashed",
      exitCode: Number(code) || 0,
      crashes: crashes.length,
    });
    fail(target, new KokoroError("worker_crashed"));
  }

  function onMessage(target: Live, message: KokoroWorkerResponse) {
    if (target !== live || !message || typeof message !== "object") return;
    armStall(target);
    switch (message.type) {
      case "ready":
        if (target.readyTimer) clearTimeout(target.readyTimer);
        target.readyTimer = undefined;
        target.settle();
        lastError = undefined;
        trace({ phase: "ready", loadMs: Number(message.loadMs) || 0 });
        return;
      case "chunk": {
        const pcm = pcmOf(message.pcm);
        if (pcm?.length)
          target.streams
            .get(message.id)
            ?.push({ pcm, sampleRate: KOKORO_SAMPLE_RATE });
        return;
      }
      case "done": {
        const stream = target.streams.get(message.id);
        target.streams.delete(message.id);
        stream?.end();
        armStall(target);
        if (!message.cancelled)
          trace({
            phase: "synthesized",
            chunks: message.chunks,
            synthMs: message.synthMs,
            audioMs: message.audioMs,
            fallbackWords: message.fallbackWords,
          });
        return;
      }
      case "error": {
        const error = new KokoroError(message.code);
        if (message.id === undefined) {
          lastError = message.code;
          trace({ phase: "load_error", status: message.code });
          stop(target, error);
          return;
        }
        const stream = target.streams.get(message.id);
        target.streams.delete(message.id);
        stream?.fail(error);
        armStall(target);
        trace({ phase: "error", status: message.code });
        return;
      }
    }
  }

  function ensureWorker(): Live {
    if (live && !live.exited) return live;
    let settle!: (error?: KokoroError) => void;
    const ready = new Promise<void>((resolve, reject) => {
      let done = false;
      settle = (error) => {
        if (done) return;
        done = true;
        if (error) reject(error);
        else resolve();
      };
    });
    ready.catch(() => {});
    let handle: KokoroWorkerHandle;
    try {
      handle = fork(workerPath());
    } catch (error) {
      const code =
        error instanceof KokoroError ? error.code : "runtime_unavailable";
      lastError = code;
      throw new KokoroError(code);
    }
    const target: Live = {
      handle,
      ready,
      settle,
      exited: false,
      streams: new Map(),
    };
    live = target;
    handle.on("message", (message) => onMessage(target, message));
    handle.on("exit", (code) => onExit(target, code));
    target.readyTimer = setTimeout(() => {
      if (target !== live) return;
      lastError = "load_timeout";
      trace({ phase: "load_error", status: "load_timeout" });
      stop(target, new KokoroError("load_timeout"));
    }, readyTimeoutMs);
    trace({ phase: "spawned" });
    post(target, { type: "init", paths, threads: kokoroDefaults.threads });
    return target;
  }

  async function* run(
    text: string,
    signal?: AbortSignal,
  ): AsyncGenerator<KokoroChunk, void, undefined> {
    signal?.throwIfAborted();
    if (disposed) throw new KokoroError("disposed");
    if (!installed()) throw new KokoroError("not_installed");
    if (now() < cooldownUntil) throw new KokoroError("worker_unavailable");
    const clean = String(text ?? "").trim();
    if (!clean) return;
    active++;
    clearIdle();
    let target: Live | undefined;
    let id = 0;
    let complete = false;
    try {
      target = ensureWorker();
      await untilAborted(target.ready, signal);
      if (target.exited || target !== live)
        throw target.stopped ?? new KokoroError("worker_crashed");
      id = ++sequence;
      const queue = new ChunkQueue();
      target.streams.set(id, queue);
      post(target, { type: "synthesize", id, text: clean });
      armStall(target);
      for (;;) {
        const chunk = await queue.next(signal);
        if (!chunk) {
          complete = true;
          return;
        }
        yield chunk;
      }
    } finally {
      if (target && id) {
        const known = target.streams.delete(id);
        if (!complete && known && !target.exited)
          post(target, { type: "cancel", id });
        armStall(target);
      }
      active--;
      scheduleIdle();
    }
  }

  // Download ---------------------------------------------------------------

  function emit(force = false) {
    if (!job) return;
    const at = now();
    if (!force && at - job.lastEmit < kokoroDefaults.progressIntervalMs) return;
    job.lastEmit = at;
    const snapshot = status();
    for (const listener of job.listeners) {
      try {
        listener(snapshot);
      } catch {}
    }
  }

  async function fetchFile(
    file: KokoroFile,
    state: NonNullable<typeof job>,
  ): Promise<void> {
    const signal = state.controller.signal;
    const target = join(modelDir, kokoroFileName(file));
    const partial = `${target}.partial`;
    for (let attempt = 0; ; attempt++) {
      let offset = Math.max(0, await sizeOf(partial));
      if (offset > file.size) {
        await rm(partial, { force: true });
        offset = 0;
      }
      let hash = createHash("sha256");
      if (offset > 0) await hashInto(partial, hash, signal);
      state.bytes += offset;
      emit();
      if (offset < file.size) {
        const response = await doFetch(file.url, {
          headers: offset > 0 ? { Range: `bytes=${offset}-` } : {},
          redirect: "follow",
          signal,
        });
        let append = false;
        if (offset > 0 && response.status === 206) {
          const start = /^bytes (\d+)-/.exec(
            response.headers.get("content-range") ?? "",
          );
          append = Number(start?.[1]) === offset;
        }
        if (
          !append &&
          offset > 0 &&
          (response.status === 206 || response.status === 416)
        ) {
          // The server cannot resume from here: start this file over.
          void response.body?.cancel().catch(() => {});
          state.bytes -= offset;
          await rm(partial, { force: true });
          if (attempt > 0) throw new KokoroError(`http_${response.status}`);
          continue;
        }
        if (!append && response.status !== 200) {
          void response.body?.cancel().catch(() => {});
          throw new KokoroError(`http_${Number(response.status) || 0}`);
        }
        if (!append && offset > 0) {
          // Full body despite the Range header: restart the hash and file.
          state.bytes -= offset;
          offset = 0;
          hash = createHash("sha256");
        }
        const reader = response.body?.getReader();
        if (!reader) throw new KokoroError("network");
        const handle = await open(partial, append ? "a" : "w");
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value?.byteLength) continue;
            if (offset + value.byteLength > file.size) {
              void reader.cancel().catch(() => {});
              throw new KokoroError("size_mismatch");
            }
            await handle.write(value);
            hash.update(value);
            offset += value.byteLength;
            state.bytes += value.byteLength;
            emit();
          }
          await handle.sync();
        } catch (error) {
          if (error instanceof KokoroError) {
            await handle.close().catch(() => {});
            await rm(partial, { force: true });
            state.bytes -= offset;
            throw error;
          }
          if (signal.aborted) throw signal.reason;
          throw new KokoroError(
            (error as NodeJS.ErrnoException)?.code === "ENOSPC"
              ? "disk_full"
              : "network",
          );
        } finally {
          await handle.close().catch(() => {});
        }
        // A short body stays as a partial file and resumes next time.
        if (offset < file.size) throw new KokoroError("network");
      }
      if (hash.digest("hex") !== file.sha256) {
        await rm(partial, { force: true });
        state.bytes -= offset;
        throw new KokoroError("checksum_mismatch");
      }
      await rename(partial, target);
      emit(true);
      return;
    }
  }

  async function ensureSpace(needed: number) {
    try {
      const fs = await statfs(modelDir);
      if (fs.bavail * fs.bsize < needed + kokoroDefaults.spareBytes)
        throw new KokoroError("disk_full");
    } catch (error) {
      if (error instanceof KokoroError) throw error;
    }
  }

  async function removeStale(keep: Set<string>) {
    let names: string[] = [];
    try {
      names = await readdir(modelDir);
    } catch {
      return;
    }
    for (const name of names)
      if (!keep.has(name) && KOKORO_STORED_NAME.test(name))
        await rm(join(modelDir, name), { force: true }).catch(() => {});
  }

  async function runDownload(state: NonNullable<typeof job>) {
    const started = now();
    trace({ phase: "download_started" });
    try {
      await mkdir(modelDir, { recursive: true });
      const pending: KokoroFile[] = [];
      let partialBytes = 0;
      for (const file of files) {
        const name = join(modelDir, kokoroFileName(file));
        if ((await sizeOf(name)) === file.size) state.bytes += file.size;
        else {
          pending.push(file);
          partialBytes += Math.max(0, await sizeOf(`${name}.partial`));
        }
      }
      emit(true);
      const remaining = pending.reduce((n, f) => n + f.size, 0) - partialBytes;
      if (remaining > 0) await ensureSpace(remaining);
      for (const file of pending) {
        state.controller.signal.throwIfAborted();
        await fetchFile(file, state);
      }
      await removeStale(new Set(files.map(kokoroFileName)));
      lastError = undefined;
      trace({
        phase: "download_finished",
        bytes: state.bytes,
        durationMs: Math.round(now() - started),
      });
    } catch (error) {
      const signal = state.controller.signal;
      if (signal.aborted) {
        trace({ phase: "download_cancelled" });
        throw signal.reason;
      }
      const code = error instanceof KokoroError ? error.code : "network";
      lastError = code;
      trace({ phase: "download_failed", status: code });
      throw error instanceof KokoroError ? error : new KokoroError(code);
    }
  }

  async function download(
    onProgress?: (status: KokoroStatus) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    if (disposed) throw new KokoroError("disposed");
    signal?.throwIfAborted();
    if (!job) {
      lastError = undefined;
      const state = {
        controller: new AbortController(),
        listeners: new Set<(status: KokoroStatus) => void>(),
        bytes: 0,
        lastEmit: -Infinity,
        promise: Promise.resolve(),
      };
      job = state;
      state.promise = runDownload(state).finally(() => {
        if (job === state) job = undefined;
        for (const listener of state.listeners) {
          try {
            listener(status());
          } catch {}
        }
      });
    }
    const current = job;
    if (onProgress) current.listeners.add(onProgress);
    const onAbort = () => current.controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await current.promise;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async function remove(): Promise<void> {
    if (job) {
      const running = job;
      running.controller.abort(new KokoroError("removed"));
      await running.promise.catch(() => {});
    }
    if (live) stop(live, new KokoroError("removed"));
    await removeStale(new Set());
    for (const file of files) {
      const name = join(modelDir, kokoroFileName(file));
      await rm(name, { force: true }).catch(() => {});
      await rm(`${name}.partial`, { force: true }).catch(() => {});
    }
    await rmdir(modelDir).catch(() => {});
    lastError = undefined;
    trace({ phase: "removed" });
  }

  return {
    status,
    download,
    remove,
    async warm() {
      for await (const _chunk of run(kokoroDefaults.warmText));
    },
    synthesize: (text, signal) => run(text, signal),
    dispose() {
      if (disposed) return;
      disposed = true;
      clearIdle();
      job?.controller.abort(new KokoroError("disposed"));
      if (live) stop(live, new KokoroError("disposed"));
    },
  };
}
