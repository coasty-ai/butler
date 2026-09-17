import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  KokoroError,
  createKokoroVoice,
  kokoroDefaults,
  type KokoroChunk,
  type KokoroStatus,
  type KokoroWorkerHandle,
} from "../electron/kokoro/client";
import {
  KOKORO_FILES,
  KOKORO_TOTAL_BYTES,
  kokoroFileName,
  type KokoroFile,
  type KokoroRole,
} from "../electron/kokoro/manifest";
import type {
  KokoroWorkerRequest,
  KokoroWorkerResponse,
} from "../electron/kokoro/protocol";

const roles: KokoroRole[] = [
  "model",
  "voice",
  "tokenizer",
  "lexicon",
  "bartConfig",
  "bartWeights",
];
const bytes = (length: number, seed: number) =>
  Uint8Array.from({ length }, (_, i) => (i * 31 + seed) % 251);
const sha = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

/** A tiny manifest with the same shape as the pinned one. */
function makeFiles() {
  const bodies = new Map<string, Uint8Array>();
  const files: KokoroFile[] = roles.map((role, i) => {
    const body = bytes(role === "model" ? 5000 : 700 + i * 13, i + 1);
    const url = `https://models.test/${role}.bin`;
    bodies.set(url, body);
    return {
      role,
      name: `${role}.bin`,
      url,
      size: body.byteLength,
      sha256: sha(body),
      license: "Apache-2.0",
    };
  });
  return { files, bodies };
}

interface ServeOptions {
  honorRange?: boolean;
  status?: number;
  chunk?: number;
  corrupt?: string;
  oversize?: string;
  onRead?: (url: string, served: number, signal?: AbortSignal) => void;
  /** Called when a body has been fully streamed. */
  onEnd?: (url: string) => void;
}

function serve(bodies: Map<string, Uint8Array>, options: ServeOptions = {}) {
  const requests: { url: string; range: string | null }[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const range = new Headers(init?.headers).get("range");
    requests.push({ url, range });
    let body = bodies.get(url);
    if (!body || options.status)
      return new Response(null, { status: options.status ?? 404 });
    if (options.corrupt === url) body = body.map((b) => (b + 1) % 256);
    if (options.oversize === url) {
      const bigger = new Uint8Array(body.byteLength + 10);
      bigger.set(body);
      body = bigger;
    }
    let start = 0;
    let status = 200;
    const headers: Record<string, string> = {};
    if (range && options.honorRange !== false) {
      start = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0);
      status = 206;
      headers["content-range"] =
        `bytes ${start}-${body.byteLength - 1}/${body.byteLength}`;
    }
    const slice = body.subarray(start);
    const size = options.chunk ?? 512;
    let at = 0;
    const signal = init?.signal ?? undefined;
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (signal?.aborted) return controller.error(signal.reason);
          if (at >= slice.byteLength) {
            options.onEnd?.(url);
            return controller.close();
          }
          controller.enqueue(slice.slice(at, at + size));
          at += size;
          options.onRead?.(url, Math.min(at, slice.byteLength), signal);
        },
      }),
      { status, headers },
    );
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, requests };
}

let dirs: string[] = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "kokoro-client-"));
  dirs.push(dir);
  return join(dir, "voices", "kokoro");
}
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("Kokoro manifest", () => {
  it("pins every file by revision, size and sha256", () => {
    expect(KOKORO_FILES.map((f) => f.role).sort()).toEqual([...roles].sort());
    for (const file of KOKORO_FILES) {
      expect(file.url).toMatch(/\/(resolve|misaki)\/[0-9a-f]{40}\//);
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(file.size).toBeGreaterThan(0);
      expect(file.license).toBe("Apache-2.0");
      expect(kokoroFileName(file)).toBe(
        `${file.sha256.slice(0, 12)}-${file.name}`,
      );
    }
    expect(KOKORO_FILES.some((f) => f.url.includes("us_silver"))).toBe(false);
    expect(KOKORO_TOTAL_BYTES).toBe(332_071_387);
  });
});

describe("Kokoro download", () => {
  it("verifies each file and renames it into place only when complete", async () => {
    const { files, bodies } = makeFiles();
    const modelDir = tempDir();
    const seenFinal: string[] = [];
    const { fetch, requests } = serve(bodies, {
      onEnd: (url) => {
        const file = files.find((f) => f.url === url)!;
        const target = join(modelDir, kokoroFileName(file));
        if (existsSync(target)) seenFinal.push(file.role);
        expect(existsSync(`${target}.partial`)).toBe(true);
      },
    });
    let clock = 0;
    const voice = createKokoroVoice({
      modelDir,
      files,
      fetch,
      now: () => (clock += 1000),
      fork: () => {
        throw new Error("no worker during download");
      },
    });
    expect(voice.status()).toMatchObject({
      installed: false,
      downloading: false,
      progress: 0,
    });
    const progress: KokoroStatus[] = [];
    const pending = voice.download((s) => progress.push(s));
    expect(voice.status().downloading).toBe(true);
    await pending;
    expect(seenFinal).toEqual([]);
    expect(requests.every((r) => r.range === null)).toBe(true);
    for (const file of files) {
      const target = join(modelDir, kokoroFileName(file));
      expect(sha(readFileSync(target))).toBe(file.sha256);
    }
    expect(readdirSync(modelDir).some((n) => n.endsWith(".partial"))).toBe(
      false,
    );
    const total = files.reduce((n, f) => n + f.size, 0);
    expect(voice.status()).toEqual({
      installed: true,
      downloading: false,
      progress: 1,
      bytes: total,
      totalBytes: total,
    });
    const fractions = progress.map((s) => s.progress);
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
    expect(fractions.at(-1)).toBe(1);

    // Already installed: nothing is fetched again.
    await voice.download();
    expect(requests.length).toBe(files.length);
  });

  it("rejects a wrong hash, removes the partial file and keeps verified files", async () => {
    const { files, bodies } = makeFiles();
    const modelDir = tempDir();
    const bad = files.find((f) => f.role === "bartWeights")!;
    const voice = createKokoroVoice({
      modelDir,
      files,
      fetch: serve(bodies, { corrupt: bad.url }).fetch,
    });
    await expect(voice.download()).rejects.toMatchObject({
      code: "checksum_mismatch",
    });
    const target = join(modelDir, kokoroFileName(bad));
    expect(existsSync(target)).toBe(false);
    expect(existsSync(`${target}.partial`)).toBe(false);
    expect(voice.status()).toMatchObject({
      installed: false,
      downloading: false,
      error: "checksum_mismatch",
    });

    const retry = serve(bodies);
    const again = createKokoroVoice({ modelDir, files, fetch: retry.fetch });
    await again.download();
    expect(retry.requests.map((r) => r.url)).toEqual([bad.url]);
    expect(again.status()).toMatchObject({ installed: true });
    expect(again.status().error).toBeUndefined();
  });

  it("resumes a partial file with a Range request", async () => {
    const { files, bodies } = makeFiles();
    const modelDir = tempDir();
    const model = files[0];
    mkdirSync(modelDir, { recursive: true });
    const partial = join(modelDir, `${kokoroFileName(model)}.partial`);
    writeFileSync(partial, bodies.get(model.url)!.subarray(0, 1234));
    const { fetch, requests } = serve(bodies);
    const voice = createKokoroVoice({ modelDir, files, fetch });
    await voice.download();
    expect(requests[0]).toEqual({ url: model.url, range: "bytes=1234-" });
    expect(sha(readFileSync(join(modelDir, kokoroFileName(model))))).toBe(
      model.sha256,
    );
    expect(existsSync(partial)).toBe(false);
  });

  it("restarts from zero when the server ignores Range", async () => {
    const { files, bodies } = makeFiles();
    const modelDir = tempDir();
    const model = files[0];
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(
      join(modelDir, `${kokoroFileName(model)}.partial`),
      bodies.get(model.url)!.subarray(0, 2000),
    );
    const voice = createKokoroVoice({
      modelDir,
      files,
      fetch: serve(bodies, { honorRange: false }).fetch,
    });
    await voice.download();
    const stored = readFileSync(join(modelDir, kokoroFileName(model)));
    expect(stored.byteLength).toBe(model.size);
    expect(sha(stored)).toBe(model.sha256);
  });

  it("discards a stale partial that fails verification, then succeeds from scratch", async () => {
    const { files, bodies } = makeFiles();
    const modelDir = tempDir();
    const model = files[0];
    mkdirSync(modelDir, { recursive: true });
    const partial = join(modelDir, `${kokoroFileName(model)}.partial`);
    writeFileSync(partial, new Uint8Array(1000).fill(7));
    const voice = createKokoroVoice({
      modelDir,
      files,
      fetch: serve(bodies).fetch,
    });
    await expect(voice.download()).rejects.toMatchObject({
      code: "checksum_mismatch",
    });
    expect(existsSync(partial)).toBe(false);
    await voice.download();
    expect(voice.status().installed).toBe(true);
  });

  it("keeps the partial file when cancelled so the next download resumes", async () => {
    const { files, bodies } = makeFiles();
    const modelDir = tempDir();
    const model = files[0];
    const controller = new AbortController();
    const reason = new Error("user cancelled");
    const voice = createKokoroVoice({
      modelDir,
      files,
      fetch: serve(bodies, {
        onRead: (url, served) => {
          if (url === model.url && served >= 2048) controller.abort(reason);
        },
      }).fetch,
    });
    await expect(voice.download(undefined, controller.signal)).rejects.toBe(
      reason,
    );
    const partial = join(modelDir, `${kokoroFileName(model)}.partial`);
    expect(readFileSync(partial).byteLength).toBeGreaterThanOrEqual(1536);
    expect(voice.status()).toMatchObject({
      downloading: false,
      installed: false,
    });
    expect(voice.status().error).toBeUndefined();

    const resumed = serve(bodies);
    const again = createKokoroVoice({ modelDir, files, fetch: resumed.fetch });
    await again.download();
    expect(resumed.requests[0].range).toMatch(/^bytes=\d+-$/);
    expect(again.status().installed).toBe(true);
  });

  it("reports HTTP failures and oversized bodies as codes", async () => {
    const { files, bodies } = makeFiles();
    const modelDir = tempDir();
    const notFound = createKokoroVoice({
      modelDir,
      files,
      fetch: serve(bodies, { status: 404 }).fetch,
    });
    await expect(notFound.download()).rejects.toMatchObject({
      code: "http_404",
    });
    expect(notFound.status().error).toBe("http_404");

    const model = files[0];
    const tooBig = createKokoroVoice({
      modelDir,
      files,
      fetch: serve(bodies, { oversize: model.url }).fetch,
    });
    await expect(tooBig.download()).rejects.toMatchObject({
      code: "size_mismatch",
    });
    expect(existsSync(join(modelDir, `${kokoroFileName(model)}.partial`))).toBe(
      false,
    );
  });

  it("remove() deletes only the voice files", async () => {
    const { files, bodies } = makeFiles();
    const modelDir = tempDir();
    const voice = createKokoroVoice({
      modelDir,
      files,
      fetch: serve(bodies).fetch,
    });
    await voice.download();
    writeFileSync(join(modelDir, "notes.txt"), "keep me");
    writeFileSync(join(modelDir, "0123456789ab-old-model.onnx"), "stale");
    await voice.remove();
    expect(readdirSync(modelDir)).toEqual(["notes.txt"]);
    expect(voice.status()).toMatchObject({ installed: false, bytes: 0 });
  });
});

class FakeWorker extends EventEmitter {
  readonly messages: KokoroWorkerRequest[] = [];
  killed = false;
  constructor(
    private readonly script: (
      worker: FakeWorker,
      message: KokoroWorkerRequest,
    ) => void,
  ) {
    super();
  }
  postMessage(message: KokoroWorkerRequest) {
    this.messages.push(message);
    queueMicrotask(() => this.script(this, message));
  }
  reply(message: KokoroWorkerResponse) {
    this.emit("message", message);
  }
  kill() {
    if (this.killed) return false;
    this.killed = true;
    queueMicrotask(() => this.emit("exit", 0));
    return true;
  }
  crash(code = 1) {
    this.emit("exit", code);
  }
  synthesizeIds() {
    return this.messages.flatMap((m) =>
      m.type === "synthesize" ? [m.id] : [],
    );
  }
}

const pcm = (...samples: number[]) => Int16Array.from(samples).buffer;
const chunk = (id: number, seq: number, ...samples: number[]) =>
  ({
    type: "chunk",
    id,
    seq,
    sampleRate: 24000,
    pcm: pcm(...samples),
    synthMs: 5,
  }) as const;
const done = (id: number, chunks = 2) =>
  ({
    type: "done",
    id,
    chunks,
    cancelled: false,
    synthMs: 10,
    audioMs: 100,
    fallbackWords: 0,
  }) as const;

/** Answers init with ready and each request with two sentences. */
const speaking = (worker: FakeWorker, message: KokoroWorkerRequest) => {
  if (message.type === "init") worker.reply({ type: "ready", loadMs: 42 });
  if (message.type === "synthesize") {
    worker.reply(chunk(message.id, 0, 1, 2, 3));
    worker.reply(chunk(message.id, 1, 4, 5));
    worker.reply(done(message.id));
  }
};

async function collect(stream: AsyncIterable<KokoroChunk>) {
  const out: number[][] = [];
  for await (const item of stream) {
    expect(item.sampleRate).toBe(24000);
    expect(item.pcm).toBeInstanceOf(Int16Array);
    out.push([...item.pcm]);
  }
  return out;
}

describe("Kokoro worker lifecycle", () => {
  let modelDir: string;
  let files: KokoroFile[];
  let workers: FakeWorker[];
  let clock: number;
  let traces: Record<string, unknown>[];

  beforeEach(() => {
    ({ files } = makeFiles());
    modelDir = tempDir();
    mkdirSync(modelDir, { recursive: true });
    for (const file of files)
      writeFileSync(
        join(modelDir, kokoroFileName(file)),
        new Uint8Array(file.size),
      );
    workers = [];
    clock = 0;
    traces = [];
  });

  const create = (
    script = speaking,
    extra: Partial<Parameters<typeof createKokoroVoice>[0]> = {},
  ) =>
    createKokoroVoice({
      modelDir,
      files,
      workerPath: "/app/dist-electron/kokoro/worker.cjs",
      now: () => clock,
      trace: (event, data) => traces.push({ event, ...data }),
      fork: (path) => {
        expect(path).toBe("/app/dist-electron/kokoro/worker.cjs");
        const worker = new FakeWorker(script);
        workers.push(worker);
        return worker as unknown as KokoroWorkerHandle;
      },
      ...extra,
    });

  it("forks lazily on first iteration and reuses the worker", async () => {
    const voice = create();
    voice.status();
    const stream = voice.synthesize("Hello there. How are you?");
    expect(workers.length).toBe(0);
    expect(await collect(stream)).toEqual([
      [1, 2, 3],
      [4, 5],
    ]);
    expect(workers.length).toBe(1);
    const [init, request] = workers[0].messages;
    expect(init).toMatchObject({ type: "init", threads: 4 });
    expect(init.type === "init" && init.paths.model).toBe(
      join(modelDir, kokoroFileName(files[0])),
    );
    expect(request).toEqual({
      type: "synthesize",
      id: 1,
      text: "Hello there. How are you?",
    });
    expect(await collect(voice.synthesize("Again."))).toHaveLength(2);
    expect(workers.length).toBe(1);
    expect(workers[0].synthesizeIds()).toEqual([1, 2]);
    // Traces never carry the text.
    expect(JSON.stringify(traces)).not.toContain("Hello");
    expect(await collect(voice.synthesize("   "))).toEqual([]);
    voice.dispose();
  });

  it("refuses to start without the model files", async () => {
    rmSync(join(modelDir, kokoroFileName(files[0])));
    const voice = create();
    await expect(collect(voice.synthesize("Hi."))).rejects.toMatchObject({
      code: "not_installed",
    });
    expect(workers.length).toBe(0);
  });

  it("kills the worker after five idle minutes and forks again on demand", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const voice = create();
    await collect(voice.synthesize("One."));
    vi.advanceTimersByTime(kokoroDefaults.idleMs - 1);
    expect(workers[0].killed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(workers[0].killed).toBe(true);
    await Promise.resolve();
    expect(await collect(voice.synthesize("Two."))).toHaveLength(2);
    expect(workers.length).toBe(2);
    expect(traces.some((t) => t.phase === "crashed")).toBe(false);
    voice.dispose();
  });

  it("does not idle-kill while a request is streaming, but stops a stalled worker", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const voice = create((worker, message) => {
      if (message.type === "init") worker.reply({ type: "ready", loadMs: 1 });
      if (message.type === "synthesize") worker.reply(chunk(message.id, 0, 9));
    });
    const iterator = voice.synthesize("Slow.")[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.pcm[0]).toBe(9);
    const next = iterator.next();
    vi.advanceTimersByTime(kokoroDefaults.stallMs - 1);
    expect(workers[0].killed).toBe(false);
    vi.advanceTimersByTime(1);
    await expect(next).rejects.toMatchObject({ code: "worker_stalled" });
    expect(workers[0].killed).toBe(true);
    expect(voice.status().error).toBe("worker_stalled");
  });

  it("rejects pending work when the worker crashes and restarts on the next request", async () => {
    let crashNext = true;
    const voice = create((worker, message) => {
      if (message.type === "init") worker.reply({ type: "ready", loadMs: 1 });
      if (message.type === "synthesize") {
        worker.reply(chunk(message.id, 0, 7));
        if (crashNext) {
          crashNext = false;
          worker.crash(134);
        } else worker.reply(done(message.id, 1));
      }
    });
    const received: number[] = [];
    const failure = await (async () => {
      try {
        for await (const item of voice.synthesize("Crash please."))
          received.push(...item.pcm);
      } catch (error) {
        return error;
      }
    })();
    expect(received).toEqual([7]);
    expect(failure).toBeInstanceOf(KokoroError);
    expect((failure as KokoroError).code).toBe("worker_crashed");
    expect(voice.status().error).toBe("worker_crashed");
    expect(await collect(voice.synthesize("Recovered."))).toEqual([[7]]);
    expect(workers.length).toBe(2);
    expect(voice.status().error).toBeUndefined();
    expect(traces.find((t) => t.phase === "crashed")).toMatchObject({
      exitCode: 134,
    });
    voice.dispose();
  });

  it("stops forking after repeated crashes until the cooldown passes", async () => {
    const voice = create((worker, message) => {
      if (message.type === "init") worker.crash(1);
    });
    for (let i = 0; i < kokoroDefaults.crashLimit; i++)
      await expect(collect(voice.synthesize("Hi."))).rejects.toMatchObject({
        code: "worker_crashed",
      });
    await expect(collect(voice.synthesize("Hi."))).rejects.toMatchObject({
      code: "worker_unavailable",
    });
    expect(workers.length).toBe(kokoroDefaults.crashLimit);
    clock += kokoroDefaults.crashCooldownMs;
    await expect(collect(voice.synthesize("Hi."))).rejects.toMatchObject({
      code: "worker_crashed",
    });
    expect(workers.length).toBe(kokoroDefaults.crashLimit + 1);
  });

  it("aborting mid-stream rejects with the reason and cancels the request in the worker", async () => {
    const voice = create((worker, message) => {
      if (message.type === "init") worker.reply({ type: "ready", loadMs: 1 });
      if (message.type === "synthesize" && message.id === 1)
        worker.reply(chunk(1, 0, 1));
      if (message.type === "synthesize" && message.id === 2) {
        worker.reply(chunk(2, 0, 2));
        worker.reply(done(2, 1));
      }
    });
    const controller = new AbortController();
    const reason = new Error("superseded");
    const iterator = voice
      .synthesize("First reply. Second sentence.", controller.signal)
      [Symbol.asyncIterator]();
    expect([...(await iterator.next()).value!.pcm]).toEqual([1]);
    const pending = iterator.next();
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(workers[0].messages.at(-1)).toEqual({ type: "cancel", id: 1 });
    // A late chunk for the cancelled request is ignored.
    workers[0].reply(chunk(1, 1, 99));
    expect(await collect(voice.synthesize("Next."))).toEqual([[2]]);
    expect(workers.length).toBe(1);
    voice.dispose();
  });

  it("aborting while the worker loads rejects without sending the text", async () => {
    let ready: (() => void) | undefined;
    const voice = create((worker, message) => {
      if (message.type === "init")
        ready = () => worker.reply({ type: "ready", loadMs: 900 });
    });
    const controller = new AbortController();
    const pending = collect(
      voice.synthesize("Private text.", controller.signal),
    );
    await vi.waitFor(() => expect(ready).toBeDefined());
    controller.abort(new Error("stop"));
    await expect(pending).rejects.toThrow("stop");
    expect(workers[0].synthesizeIds()).toEqual([]);
    ready?.();
    voice.dispose();
  });

  it("surfaces worker load errors as codes and stops that worker", async () => {
    const voice = create((worker, message) => {
      if (message.type === "init")
        worker.reply({ type: "error", code: "files_missing" });
    });
    await expect(collect(voice.synthesize("Hi."))).rejects.toMatchObject({
      code: "files_missing",
    });
    expect(workers[0].killed).toBe(true);
    expect(voice.status().error).toBe("files_missing");
    expect(traces.some((t) => t.phase === "crashed")).toBe(false);
  });

  it("fails one request on a synthesis error and keeps serving", async () => {
    const voice = create((worker, message) => {
      if (message.type === "init") worker.reply({ type: "ready", loadMs: 1 });
      if (message.type === "synthesize" && message.id === 1)
        worker.reply({ type: "error", id: 1, code: "synthesis_failed" });
      if (message.type === "synthesize" && message.id === 2) {
        worker.reply(chunk(2, 0, 3));
        worker.reply(done(2, 1));
      }
    });
    await expect(collect(voice.synthesize("Bad."))).rejects.toMatchObject({
      code: "synthesis_failed",
    });
    expect(await collect(voice.synthesize("Good."))).toEqual([[3]]);
    expect(workers.length).toBe(1);
    voice.dispose();
  });

  it("warm() loads the worker with one short synthesis", async () => {
    const voice = create();
    await voice.warm();
    expect(workers.length).toBe(1);
    expect(workers[0].messages[1]).toMatchObject({
      type: "synthesize",
      text: kokoroDefaults.warmText,
    });
    voice.dispose();
  });

  it("dispose() kills the worker and rejects pending and later work", async () => {
    const voice = create((worker, message) => {
      if (message.type === "init") worker.reply({ type: "ready", loadMs: 1 });
    });
    const pending = collect(voice.synthesize("Waiting."));
    await vi.waitFor(() => expect(workers[0]?.synthesizeIds()).toEqual([1]));
    voice.dispose();
    await expect(pending).rejects.toMatchObject({ code: "disposed" });
    expect(workers[0].killed).toBe(true);
    await expect(collect(voice.synthesize("Later."))).rejects.toMatchObject({
      code: "disposed",
    });
    await expect(voice.download()).rejects.toMatchObject({ code: "disposed" });
  });
});
