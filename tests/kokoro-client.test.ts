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
  pickKokoroStatus,
  type KokoroChunk,
  type KokoroVoiceStatus,
  type KokoroWorkerHandle,
} from "../electron/kokoro/client";
import {
  KOKORO_ACCENT_FILES,
  KOKORO_ALL_FILES,
  KOKORO_FILES,
  KOKORO_GB_PACK_BYTES,
  KOKORO_TOTAL_BYTES,
  KOKORO_VOICES,
  KOKORO_VOICE_FILES,
  KOKORO_VOICE_IDS,
  kokoroFileName,
  kokoroFilesFor,
  kokoroPackBytes,
  kokoroPaths,
  type KokoroFile,
  type KokoroRole,
  type KokoroVoiceId,
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

/**
 * A tiny manifest with the same shape as the pinned one: the base install
 * (American accent, af_heart) plus the British pack (GB accent, George and
 * Fable). `base` is what af_heart needs.
 */
function makeFiles() {
  const bodies = new Map<string, Uint8Array>();
  let seed = 0;
  const make = (
    role: KokoroRole,
    name: string,
    tags: Pick<KokoroFile, "accent" | "voice"> = {},
  ): KokoroFile => {
    seed++;
    const body = bytes(role === "model" ? 5000 : 700 + seed * 13, seed);
    const url = `https://models.test/${name}`;
    bodies.set(url, body);
    return {
      role,
      name,
      url,
      size: body.byteLength,
      sha256: sha(body),
      license: "Apache-2.0",
      ...tags,
    };
  };
  const files: KokoroFile[] = [
    ...roles.map((role) =>
      make(
        role,
        `${role}.bin`,
        role === "voice"
          ? { voice: "af_heart" }
          : ["lexicon", "bartConfig", "bartWeights"].includes(role)
            ? { accent: "us" }
            : {},
      ),
    ),
    make("lexicon", "gb-lexicon.bin", { accent: "gb" }),
    make("bartConfig", "gb-bartConfig.bin", { accent: "gb" }),
    make("bartWeights", "gb-bartWeights.bin", { accent: "gb" }),
    make("voice", "bm_george.bin", { voice: "bm_george" }),
    make("voice", "bm_fable.bin", { voice: "bm_fable" }),
  ];
  return { files, bodies, base: kokoroFilesFor("af_heart", files) };
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
    for (const file of KOKORO_ALL_FILES) {
      expect(file.url).toMatch(/\/(resolve|misaki)\/[0-9a-f]{40}\//);
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(file.size).toBeGreaterThan(0);
      expect(file.license).toBe("Apache-2.0");
      expect(kokoroFileName(file)).toBe(
        `${file.sha256.slice(0, 12)}-${file.name}`,
      );
    }
    expect(KOKORO_ALL_FILES.some((f) => /silver/.test(f.url))).toBe(false);
    expect(new Set(KOKORO_ALL_FILES.map(kokoroFileName)).size).toBe(
      KOKORO_ALL_FILES.length,
    );
    // The base install is unchanged: Settings quotes 332 MB.
    expect(KOKORO_TOTAL_BYTES).toBe(332_071_387);
  });

  it("pins the British pack: gb_gold, the GB BART and both voices, fetched and hashed 2026-09-17", () => {
    const pins = Object.fromEntries(
      KOKORO_ALL_FILES.map((f) => [f.name, [f.url, f.size, f.sha256]]),
    );
    const misaki =
      "https://raw.githubusercontent.com/hexgrad/misaki/fba1236595f2d2bf21d414ba6e57d25256afada3/misaki/data";
    const bartGb =
      "https://huggingface.co/PeterReid/graphemes_to_phonemes_en_gb/resolve/d8357d5067fa26a5c34134d6bbcf4bbf000c0ac8";
    const kokoro =
      "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231";
    expect(pins["gb_gold.json"]).toEqual([
      `${misaki}/gb_gold.json`,
      2_838_552,
      "29e62f4b60261c88f7f3c2c7811ca3825978948090b72d2b27d565b729282f71",
    ]);
    expect(pins["g2p-bart-gb-config.json"]).toEqual([
      `${bartGb}/config.json`,
      1_246,
      "e4f248e6af0cfb6cb54aea6ff0168d16b6f3cdabed438c487cde4ab0815d1bac",
    ]);
    expect(pins["g2p-bart-gb.safetensors"]).toEqual([
      `${bartGb}/model.safetensors`,
      3_011_692,
      "4994f474bb6f4584076a4e98189caaec11aa3f773a0d82d5bc263a03dd07e703",
    ]);
    expect(pins["bm_george.bin"]).toEqual([
      `${kokoro}/voices/bm_george.bin`,
      522_240,
      "c4b235a4c1f2cd3b939fed08b899ce9385638b763f7b73a59616c4fc9bd6c9bc",
    ]);
    expect(pins["bm_fable.bin"]).toEqual([
      `${kokoro}/voices/bm_fable.bin`,
      522_240,
      "f889083196807b4adb15e9204252165f503b8d33d3982e681c52443c49d798f1",
    ]);
    expect(KOKORO_GB_PACK_BYTES).toBe(6_373_730);
    expect(kokoroPackBytes("bm_fable")).toBe(6_373_730);
    expect(kokoroPackBytes("af_heart")).toBe(0);
  });

  it("tags every accent and voice file, and lists each voice's files", () => {
    for (const [accent, files] of Object.entries(KOKORO_ACCENT_FILES)) {
      expect(files.map((f) => f.role).sort()).toEqual([
        "bartConfig",
        "bartWeights",
        "lexicon",
      ]);
      for (const file of files) expect(file.accent).toBe(accent);
    }
    for (const id of KOKORO_VOICE_IDS) {
      const file = KOKORO_VOICE_FILES[id];
      expect(file).toMatchObject({
        role: "voice",
        voice: id,
        name: `${id}.bin`,
      });
      const own = kokoroFilesFor(id);
      expect(own.map((f) => f.role).sort()).toEqual([...roles].sort());
      expect(own).toContain(file);
      for (const other of KOKORO_ACCENT_FILES[
        KOKORO_VOICES[id].accent === "gb" ? "us" : "gb"
      ])
        expect(own).not.toContain(other);
    }
    expect(kokoroFilesFor("af_heart")).toEqual(KOKORO_FILES);
    expect(KOKORO_VOICES.af_heart.accent).toBe("us");
    expect(KOKORO_VOICES.bm_george.accent).toBe("gb");
    expect(KOKORO_VOICES.bm_fable.accent).toBe("gb");

    const paths = kokoroPaths("/m", KOKORO_ALL_FILES);
    expect(paths.model).toBe(`/m/${kokoroFileName(KOKORO_FILES[0])}`);
    expect(Object.keys(paths.voices).sort()).toEqual(
      [...KOKORO_VOICE_IDS].sort(),
    );
    expect(Object.keys(paths.accents).sort()).toEqual(["gb", "us"]);
    expect(paths.accents.gb?.lexicon).toMatch(/29e62f4b6026-gb_gold\.json$/);
    // A partial accent or a voice without its accent is a manifest bug.
    expect(() =>
      kokoroPaths(
        "/m",
        KOKORO_ALL_FILES.filter((f) => f.name !== "gb_gold.json"),
      ),
    ).toThrow(/partial gb accent/);
    expect(() =>
      kokoroPaths("/m", [...KOKORO_FILES, KOKORO_VOICE_FILES.bm_george]),
    ).toThrow(/bm_george without its accent/);
    expect(() => kokoroPaths("/m", KOKORO_FILES.slice(1))).toThrow(/model/);
    // A list that cannot serve a voice never reads as "nothing to fetch".
    expect(() => kokoroFilesFor("bm_george", KOKORO_FILES)).toThrow(
      /no pack for bm_george/,
    );
    expect(() =>
      kokoroFilesFor("bm_fable", [
        ...KOKORO_FILES,
        KOKORO_VOICE_FILES.bm_fable,
        KOKORO_ACCENT_FILES.gb[0],
      ]),
    ).toThrow(/lacks the gb accent for bm_fable/);
    expect(kokoroFilesFor("af_heart", KOKORO_FILES)).toEqual(KOKORO_FILES);
  });
});

describe("Kokoro download", () => {
  it("verifies each file and renames it into place only when complete", async () => {
    const { files, bodies, base } = makeFiles();
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
    const progress: KokoroVoiceStatus[] = [];
    const pending = voice.download((s) => progress.push(s));
    expect(voice.status().downloading).toBe(true);
    await pending;
    expect(seenFinal).toEqual([]);
    expect(requests.every((r) => r.range === null)).toBe(true);
    // The default download is the base install: no British pack.
    expect(requests.map((r) => r.url).sort()).toEqual(
      base.map((f) => f.url).sort(),
    );
    for (const file of base) {
      const target = join(modelDir, kokoroFileName(file));
      expect(sha(readFileSync(target))).toBe(file.sha256);
    }
    expect(readdirSync(modelDir).some((n) => n.endsWith(".partial"))).toBe(
      false,
    );
    const total = base.reduce((n, f) => n + f.size, 0);
    expect(voice.status()).toEqual({
      installed: true,
      downloading: false,
      progress: 1,
      bytes: total,
      totalBytes: total,
      voice: "af_heart",
      voices: { af_heart: true, bm_george: false, bm_fable: false },
      missingBytes: 0,
    });
    const fractions = progress.map((s) => s.progress);
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
    expect(fractions.at(-1)).toBe(1);

    // Already installed: nothing is fetched again.
    await voice.download();
    expect(requests.length).toBe(base.length);
  });

  it("downloads only what a British voice still lacks and reports it per voice", async () => {
    const { files, bodies, base } = makeFiles();
    const modelDir = tempDir();
    const { fetch, requests } = serve(bodies);
    const voice = createKokoroVoice({ modelDir, files, fetch });
    await voice.download();
    const george = kokoroFilesFor("bm_george", files);
    const pack = george.filter((f) => !base.includes(f));
    const packBytes = pack.reduce((n, f) => n + f.size, 0);
    expect(pack.map((f) => f.name).sort()).toEqual([
      "bm_george.bin",
      "gb-bartConfig.bin",
      "gb-bartWeights.bin",
      "gb-lexicon.bin",
    ]);
    expect(voice.status("bm_george")).toMatchObject({
      installed: false,
      downloading: false,
      progress: 0,
      bytes: 0,
      totalBytes: george.reduce((n, f) => n + f.size, 0),
    });
    expect(voice.status("bm_george")).toMatchObject({
      voice: "bm_george",
      installed: false,
      voices: { af_heart: true, bm_george: false, bm_fable: false },
      missingBytes: packBytes,
    });

    const progress: KokoroVoiceStatus[] = [];
    requests.length = 0;
    await voice.download((s) => progress.push(s), undefined, "bm_george");
    // Only the pack was fetched, and progress ran over the pack alone.
    expect(requests.map((r) => r.url).sort()).toEqual(
      pack.map((f) => f.url).sort(),
    );
    // ...and every event describes the voice being fetched, not the base.
    expect(
      progress.every(
        (s) => s.totalBytes === packBytes && s.voice === "bm_george",
      ),
    ).toBe(true);
    expect(progress.at(-1)).toMatchObject({ progress: 1, bytes: packBytes });
    expect(voice.status("bm_george")).toMatchObject({
      installed: true,
      voices: { af_heart: true, bm_george: true, bm_fable: false },
      missingBytes: 0,
    });
    // Fable shares the accent files: only its own pack is left.
    expect(voice.status("bm_fable").missingBytes).toBe(
      files.find((f) => f.name === "bm_fable.bin")!.size,
    );
    // The base install is untouched by the pack download.
    expect(voice.status()).toMatchObject({ installed: true });
    expect(readdirSync(modelDir).sort()).toEqual(
      [...base, ...pack].map(kokoroFileName).sort(),
    );
  });

  it("joins a base download in progress and then continues with the pack", async () => {
    const { files, bodies, base } = makeFiles();
    const modelDir = tempDir();
    const { fetch, requests } = serve(bodies);
    const voice = createKokoroVoice({ modelDir, files, fetch });
    const first = voice.download();
    const george = voice.download(undefined, undefined, "bm_george");
    expect(voice.status().downloading).toBe(true);
    await first;
    expect(voice.status("bm_george").installed).toBe(false);
    await george;
    expect(voice.status("bm_george").installed).toBe(true);
    const wanted = kokoroFilesFor("bm_george", files);
    expect(requests.map((r) => r.url).sort()).toEqual(
      [...new Set([...base, ...wanted])].map((f) => f.url).sort(),
    );
  });

  it("lets a joiner abort without stopping the download the first caller started", async () => {
    const { files, bodies, base } = makeFiles();
    const modelDir = tempDir();
    const model = files[0];
    const picker = new AbortController();
    const reason = new Error("voice changed back");
    const { fetch, requests } = serve(bodies, {
      onRead: (url, served) => {
        if (url === model.url && served >= 2048) picker.abort(reason);
      },
    });
    const voice = createKokoroVoice({ modelDir, files, fetch });
    const settingsProgress: KokoroVoiceStatus[] = [];
    const pickerProgress: KokoroVoiceStatus[] = [];
    // Settings starts the base install; the voice picker joins it for George
    // and then drops its request. The install the user asked for must go on.
    const install = voice.download(
      (s) => settingsProgress.push(s),
      new AbortController().signal,
    );
    const pack = voice.download(
      (s) => pickerProgress.push(s),
      picker.signal,
      "bm_george",
    );
    await expect(pack).rejects.toBe(reason);
    expect(voice.status().downloading).toBe(true);
    const seen = pickerProgress.length;
    await install;
    expect(voice.status()).toMatchObject({
      installed: true,
      downloading: false,
    });
    expect(voice.status().error).toBeUndefined();
    expect(settingsProgress.at(-1)).toMatchObject({ progress: 1 });
    // A caller that left hears nothing more.
    expect(pickerProgress.length).toBe(seen);
    // Only the base was fetched: George's pack was never asked for.
    expect(requests.map((r) => r.url).sort()).toEqual(
      base.map((f) => f.url).sort(),
    );
    expect(voice.status("bm_george").installed).toBe(false);
  });

  it("cancels the download only when the last waiting caller aborts", async () => {
    const { files, bodies } = makeFiles();
    const modelDir = tempDir();
    const model = files[0];
    const first = new AbortController();
    const second = new AbortController();
    const { fetch } = serve(bodies, {
      onRead: (url, served) => {
        if (url !== model.url) return;
        if (served >= 1024) first.abort(new Error("first left"));
        if (served >= 2048) second.abort(new Error("second left"));
      },
    });
    const voice = createKokoroVoice({ modelDir, files, fetch });
    const a = voice.download(undefined, first.signal);
    const b = voice.download(undefined, second.signal, "bm_george");
    await expect(a).rejects.toThrow("first left");
    expect(voice.status().downloading).toBe(true);
    // The last one out stops the job and gets its reason once it has.
    await expect(b).rejects.toThrow("second left");
    expect(voice.status()).toMatchObject({
      downloading: false,
      installed: false,
    });
    expect(voice.status().error).toBeUndefined();
    // Cancelled, not failed: the partial file stays for the next attempt.
    const partial = join(modelDir, `${kokoroFileName(model)}.partial`);
    expect(readFileSync(partial).byteLength).toBeGreaterThanOrEqual(1536);
  });

  it("fails closed on a corrupt pack file and leaves the base install usable", async () => {
    const { files, bodies } = makeFiles();
    const modelDir = tempDir();
    const bad = files.find((f) => f.name === "bm_george.bin")!;
    const voice = createKokoroVoice({
      modelDir,
      files,
      fetch: serve(bodies, { corrupt: bad.url }).fetch,
    });
    await voice.download();
    await expect(
      voice.download(undefined, undefined, "bm_george"),
    ).rejects.toMatchObject({ code: "checksum_mismatch" });
    expect(existsSync(join(modelDir, kokoroFileName(bad)))).toBe(false);
    expect(voice.status("bm_george")).toMatchObject({
      installed: false,
      error: "checksum_mismatch",
      voices: { af_heart: true, bm_george: false },
    });
    expect(voice.status()).toMatchObject({ installed: true });
    await expect(
      voice.download(undefined, undefined, "nope" as KokoroVoiceId),
    ).rejects.toMatchObject({ code: "not_installed" });
  });

  it("status(voice) carries the voices map; pickKokoroStatus() keeps the renderer's key list", async () => {
    const { files } = makeFiles();
    const voice = createKokoroVoice({ modelDir: tempDir(), files });
    const status = voice.status("bm_fable");
    expect(status).toMatchObject({
      installed: false,
      downloading: false,
      voice: "bm_fable",
      voices: { af_heart: false, bm_george: false, bm_fable: false },
    });
    expect(status.missingBytes).toBe(status.totalBytes);
    expect(voice.status().voice).toBe("af_heart");
    expect(voice.status("nope" as KokoroVoiceId).voice).toBe("af_heart");
    // main.ts projects onto the keys AppInfo.voice.kokoro has always had
    // (docs/MODULARITY.md §9; desktop-smoke deep-equals that list).
    expect(Object.keys(pickKokoroStatus(status)).sort()).toEqual([
      "bytes",
      "downloading",
      "installed",
      "progress",
      "totalBytes",
    ]);
    expect(pickKokoroStatus({ ...status, error: "network" })).toEqual({
      installed: false,
      downloading: false,
      progress: 0,
      bytes: 0,
      totalBytes: status.totalBytes,
      error: "network",
    });
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

  it("remove() deletes only the voice files, every pack included", async () => {
    const { files, bodies } = makeFiles();
    const modelDir = tempDir();
    const voice = createKokoroVoice({
      modelDir,
      files,
      fetch: serve(bodies).fetch,
    });
    await voice.download();
    await voice.download(undefined, undefined, "bm_george");
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
    for (const file of files) install(file);
    workers = [];
    clock = 0;
    traces = [];
  });
  const install = (file: KokoroFile) =>
    writeFileSync(
      join(modelDir, kokoroFileName(file)),
      new Uint8Array(file.size),
    );
  const uninstall = (name: string) =>
    rmSync(join(modelDir, kokoroFileName(files.find((f) => f.name === name)!)));
  const synthRequests = (worker: FakeWorker) =>
    worker.messages.flatMap((m) =>
      m.type === "synthesize" ? [[m.text, m.voice, m.speed]] : [],
    );

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

  it("replays warmed phrases from memory instead of the worker", async () => {
    const voice = create();
    await voice.warm(["On it.", "Done."]);
    const warmRequests = workers[0].messages.filter(
      (m) => (m as { type?: string }).type === "synthesize",
    ).length;
    expect(warmRequests).toBe(3); // warm text plus the two phrases
    expect(await collect(voice.synthesize("On it."))).toEqual([
      [1, 2, 3],
      [4, 5],
    ]);
    expect(await collect(voice.synthesize("Done."))).toHaveLength(2);
    expect(
      workers[0].messages.filter(
        (m) => (m as { type?: string }).type === "synthesize",
      ).length,
    ).toBe(warmRequests);
    // Anything else still goes to the worker.
    await collect(voice.synthesize("Opening Spotify."));
    expect(
      workers[0].messages.filter(
        (m) => (m as { type?: string }).type === "synthesize",
      ).length,
    ).toBe(warmRequests + 1);
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
    expect(init).toMatchObject({ type: "init", threads: 4, voice: "af_heart" });
    expect(init.type === "init" && init.paths.model).toBe(
      join(modelDir, kokoroFileName(files[0])),
    );
    expect(init.type === "init" && init.paths.voices.bm_george).toBe(
      join(
        modelDir,
        kokoroFileName(files.find((f) => f.name === "bm_george.bin")!),
      ),
    );
    expect(request).toEqual({
      type: "synthesize",
      id: 1,
      text: "Hello there. How are you?",
      voice: "af_heart",
      speed: 1,
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

  it("sends the requested voice and clamped speed, defaulting to the user's settings", async () => {
    let prefs: { kokoroVoice?: KokoroVoiceId; voiceRate?: number } = {};
    const voice = create(speaking, { settings: () => prefs });
    await collect(voice.synthesize("Hi."));
    prefs = { kokoroVoice: "bm_george", voiceRate: 1.4 };
    await collect(voice.synthesize("Hi."));
    await collect(
      voice.synthesize("Hi.", undefined, { voice: "bm_fable", speed: 0.5 }),
    );
    await collect(voice.synthesize("Hi.", undefined, { speed: Number.NaN }));
    await collect(
      voice.synthesize("Hi.", undefined, { voice: "nope" as KokoroVoiceId }),
    );
    expect(synthRequests(workers[0])).toEqual([
      ["Hi.", "af_heart", 1],
      ["Hi.", "bm_george", 1.3],
      ["Hi.", "bm_fable", 0.8],
      ["Hi.", "bm_george", 1],
      ["Hi.", "bm_george", 1.3],
    ]);
    // One worker serves every voice; it was told the first voice up front.
    expect(workers.length).toBe(1);
    expect(workers[0].messages[0]).toMatchObject({
      type: "init",
      voice: "af_heart",
    });
    voice.dispose();
  });

  it("rejects an explicit voice whose pack is missing without forking", async () => {
    uninstall("bm_fable.bin");
    const voice = create();
    await expect(
      collect(voice.synthesize("Hi.", undefined, { voice: "bm_fable" })),
    ).rejects.toMatchObject({ code: "not_installed" });
    expect(workers.length).toBe(0);
    await expect(collect(voice.preview("bm_fable"))).rejects.toMatchObject({
      code: "not_installed",
    });
    expect(await collect(voice.synthesize("Hi."))).toHaveLength(2);
    voice.dispose();
  });

  it("never reads a voice the file list cannot serve as installed", async () => {
    // A base-only list (the shape of KOKORO_FILES) with every file present.
    const base = kokoroFilesFor("af_heart", files);
    const voice = create(speaking, { files: base });
    expect(voice.status().voices).toEqual({
      af_heart: true,
      bm_george: false,
      bm_fable: false,
    });
    expect(() => voice.status("bm_george")).toThrow(/no pack for bm_george/);
    await expect(
      collect(voice.synthesize("Hi.", undefined, { voice: "bm_george" })),
    ).rejects.toMatchObject({ code: "not_installed" });
    expect(workers.length).toBe(0);
    await expect(
      voice.download(undefined, undefined, "bm_george"),
    ).rejects.toThrow(/no pack for bm_george/);
    // The settings voice falls back to Heart instead of failing.
    const preferring = create(speaking, {
      files: base,
      settings: () => ({ kokoroVoice: "bm_george" }),
    });
    expect(await collect(preferring.synthesize("Hi."))).toHaveLength(2);
    expect(synthRequests(workers[0]).map((r) => r[1])).toEqual(["af_heart"]);
    voice.dispose();
    preferring.dispose();
  });

  it("falls back from a settings voice with no pack to af_heart, and traces it once", async () => {
    uninstall("gb-lexicon.bin");
    const voice = create(speaking, {
      settings: () => ({ kokoroVoice: "bm_george" }),
    });
    await collect(voice.synthesize("Hi."));
    await collect(voice.synthesize("Again."));
    // An unknown explicit voice is no voice at all: settings, then fallback.
    await collect(
      voice.synthesize("Odd.", undefined, { voice: "nope" as KokoroVoiceId }),
    );
    expect(synthRequests(workers[0]).map((r) => r[1])).toEqual([
      "af_heart",
      "af_heart",
      "af_heart",
    ]);
    expect(traces.filter((t) => t.phase === "voice_fallback")).toEqual([
      { event: "KokoroVoice", phase: "voice_fallback", voice: "bm_george" },
    ]);
    // Once the pack is there the next sentence uses it, no restart needed.
    install(files.find((f) => f.name === "gb-lexicon.bin")!);
    await collect(voice.synthesize("Now."));
    expect(synthRequests(workers[0]).at(-1)).toEqual(["Now.", "bm_george", 1]);
    expect(workers.length).toBe(1);
    voice.dispose();
  });

  it("caches warmed phrases per voice and speed", async () => {
    const voice = create();
    await voice.warm(["On it."], { voice: "af_heart" });
    expect(synthRequests(workers[0])).toEqual([
      [kokoroDefaults.warmText, "af_heart", 1],
      ["On it.", "af_heart", 1],
    ]);
    expect(await collect(voice.synthesize("On it."))).toEqual([
      [1, 2, 3],
      [4, 5],
    ]);
    expect(synthRequests(workers[0])).toHaveLength(2);
    // Another voice or pace is another cache entry.
    await collect(
      voice.synthesize("On it.", undefined, { voice: "bm_george" }),
    );
    await collect(voice.synthesize("On it.", undefined, { speed: 1.2 }));
    expect(synthRequests(workers[0]).slice(2)).toEqual([
      ["On it.", "bm_george", 1],
      ["On it.", "af_heart", 1.2],
    ]);
    await voice.warm(["On it."], { voice: "bm_george", speed: 1.15 });
    expect(synthRequests(workers[0]).slice(4)).toEqual([
      [kokoroDefaults.warmText, "bm_george", 1.15],
      ["On it.", "bm_george", 1.15],
    ]);
    await collect(
      voice.synthesize("On it.", undefined, {
        voice: "bm_george",
        speed: 1.15,
      }),
    );
    await collect(voice.synthesize("On it."));
    expect(synthRequests(workers[0])).toHaveLength(6);
    voice.dispose();
  });

  it("drops the oldest cached phrase when the cache is full", async () => {
    const voice = create();
    const phrases = Array.from({ length: 96 }, (_, i) => `Phrase ${i}.`);
    await voice.warm(phrases);
    expect(synthRequests(workers[0])).toHaveLength(97);
    await voice.warm(["Phrase 96."]);
    expect(synthRequests(workers[0])).toHaveLength(99);
    await collect(voice.synthesize("Phrase 96."));
    await collect(voice.synthesize("Phrase 1."));
    expect(synthRequests(workers[0])).toHaveLength(99);
    await collect(voice.synthesize("Phrase 0."));
    expect(synthRequests(workers[0])).toHaveLength(100);
    voice.dispose();
  });

  it("preview() speaks the voice's sample sentence in that voice", async () => {
    const voice = create(speaking, { settings: () => ({ voiceRate: 1.2 }) });
    expect(await collect(voice.preview("bm_fable"))).toHaveLength(2);
    await collect(voice.preview("af_heart", undefined, { speed: 0.9 }));
    expect(synthRequests(workers[0])).toEqual([
      [KOKORO_VOICES.bm_fable.sample, "bm_fable", 1.2],
      [KOKORO_VOICES.af_heart.sample, "af_heart", 0.9],
    ]);
    await expect(
      collect(voice.preview("nope" as KokoroVoiceId)),
    ).rejects.toMatchObject({ code: "not_installed" });
    voice.dispose();
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
