/**
 * Pinned downloads for the on-device Kokoro voice. Every file is fetched from
 * an exact revision, checked against its byte size and sha256, and stored
 * under a name prefixed with its hash so a manifest change never reuses a
 * stale file. Main picks the directory (userData/voices/kokoro), never
 * ~/.cache.
 *
 * Model variant: fp32. On an M2 (CPU EP, 4 threads, Electron 41) fp32 and q4
 * measured the same in interleaved runs: ~0.5 s for "Sure, opening
 * Calculator.", RTF ~0.29 against trimmed audio, ~1.2 s from fork to first
 * PCM, ~700 MB worker RSS. q4 saves only 20 MB of download (305 vs 326 MB),
 * so the reference fp32 export wins: no quantization risk to prosody, and its
 * output is sample-identical to the spike's Whisper-checked audio. q8 and fp16
 * were 1.4-2x slower on CPU in the spike.
 */

export type KokoroRole =
  "model" | "voice" | "tokenizer" | "lexicon" | "bartConfig" | "bartWeights";

export interface KokoroFile {
  role: KokoroRole;
  /** Base file name; stored as `<sha256 prefix>-<name>`. */
  name: string;
  url: string;
  size: number;
  sha256: string;
  license: string;
}

export const KOKORO_ONNX_REVISION = "1939ad2a8e416c0acfeecc08a694d14ef25f2231";
export const MISAKI_REVISION = "fba1236595f2d2bf21d414ba6e57d25256afada3";
export const BART_G2P_REVISION = "a5631b285d18d59483c32c0c3379cb9fac924f4b";

const KOKORO = `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/${KOKORO_ONNX_REVISION}`;
const MISAKI = `https://raw.githubusercontent.com/hexgrad/misaki/${MISAKI_REVISION}/misaki/data`;
const BART = `https://huggingface.co/PeterReid/graphemes_to_phonemes_en_us/resolve/${BART_G2P_REVISION}`;

export const KOKORO_FP32_MODEL: KokoroFile = {
  role: "model",
  name: "kokoro-v1.0-fp32.onnx",
  url: `${KOKORO}/onnx/model.onnx`,
  size: 325_532_232,
  sha256: "8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb",
  license: "Apache-2.0",
};

/** Same speed as fp32 on the spike; kept for benchmarking, not downloaded. */
export const KOKORO_Q4_MODEL: KokoroFile = {
  role: "model",
  name: "kokoro-v1.0-q4.onnx",
  url: `${KOKORO}/onnx/model_q4.onnx`,
  size: 305_215_966,
  sha256: "04cf570cf9c4153694f76347ed4b9a48c1b59ff1de0999e6605d123966b197c7",
  license: "Apache-2.0",
};

export const KOKORO_FILES: readonly KokoroFile[] = [
  KOKORO_FP32_MODEL,
  {
    role: "voice",
    name: "af_heart.bin",
    url: `${KOKORO}/voices/af_heart.bin`,
    size: 522_240,
    sha256: "d583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b",
    license: "Apache-2.0",
  },
  {
    role: "tokenizer",
    name: "tokenizer.json",
    url: `${KOKORO}/tokenizer.json`,
    size: 3_497,
    sha256: "77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34",
    license: "Apache-2.0",
  },
  {
    role: "lexicon",
    name: "us_gold.json",
    url: `${MISAKI}/us_gold.json`,
    size: 3_000_469,
    sha256: "dc414872a49a28ae6c141463d502fd945f3b2fde040484fdc47d00cc4612686f",
    license: "Apache-2.0",
  },
  {
    role: "bartConfig",
    name: "g2p-bart-config.json",
    url: `${BART}/config.json`,
    size: 1_257,
    sha256: "8deb3537fb29c63cd9f20d75515ae06e4c92f1b6db0703a2d45bca95b33a53a4",
    license: "Apache-2.0",
  },
  {
    role: "bartWeights",
    name: "g2p-bart.safetensors",
    url: `${BART}/model.safetensors`,
    size: 3_011_692,
    sha256: "dc4a02e62d4fcb4bb4097ecf00db89b8e1a12a549a52ab6adfbba220b80a55c5",
    license: "Apache-2.0",
  },
];

export const KOKORO_TOTAL_BYTES = KOKORO_FILES.reduce((n, f) => n + f.size, 0);

/** Stored name: the hash prefix keeps different revisions apart. */
export function kokoroFileName(file: KokoroFile): string {
  return `${file.sha256.slice(0, 12)}-${file.name}`;
}

/** Stored names look like this; anything else in the directory is not ours. */
export const KOKORO_STORED_NAME = /^[0-9a-f]{12}-[\w.-]+?(?:\.partial)?$/;

export type KokoroPaths = Record<KokoroRole, string>;

export function kokoroPaths(
  modelDir: string,
  files: readonly KokoroFile[] = KOKORO_FILES,
  join: (...parts: string[]) => string = (...parts) => parts.join("/"),
): KokoroPaths {
  const paths = {} as KokoroPaths;
  for (const file of files)
    paths[file.role] = join(modelDir, kokoroFileName(file));
  for (const role of [
    "model",
    "voice",
    "tokenizer",
    "lexicon",
    "bartConfig",
    "bartWeights",
  ] as const)
    if (!paths[role]) throw new Error(`Kokoro manifest is missing ${role}`);
  return paths;
}
