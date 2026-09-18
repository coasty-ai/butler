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
 *
 * Packs: the base install is the model, the tokenizer, the American
 * pronunciation (misaki us_gold plus the US BART fallback) and af_heart. The
 * British pack adds misaki gb_gold, the GB BART fallback and the bm_george
 * and bm_fable voices; it is downloaded only when a British voice is chosen.
 * A voice's files are `kokoroFilesFor(voice)`.
 */
import type { KokoroVoiceId as SettingsKokoroVoiceId } from "../../src/core/schema";
import {
  DEFAULT_KOKORO_VOICE,
  KOKORO_VOICES,
  KOKORO_VOICE_IDS,
  type KokoroAccent,
  type KokoroVoiceId,
} from "../../src/voice/kokoro/voices";

export type {
  KokoroAccent,
  KokoroVoiceId,
  KokoroVoiceInfo,
} from "../../src/voice/kokoro/voices";
export {
  DEFAULT_KOKORO_VOICE,
  KOKORO_VOICES,
  KOKORO_VOICE_IDS,
} from "../../src/voice/kokoro/voices";

// settings.kokoroVoice (src/core/schema.ts) and this catalogue must agree;
// either drifting from the other fails to compile.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _voiceIdsMatchSettings: Same<KokoroVoiceId, SettingsKokoroVoiceId> = true;
void _voiceIdsMatchSettings;

export type KokoroRole =
  "model" | "voice" | "tokenizer" | "lexicon" | "bartConfig" | "bartWeights";

/** Roles that belong to one accent's pronunciation. */
export const KOKORO_ACCENT_ROLES: readonly KokoroRole[] = [
  "lexicon",
  "bartConfig",
  "bartWeights",
];

export interface KokoroFile {
  role: KokoroRole;
  /** Base file name; stored as `<sha256 prefix>-<name>`. */
  name: string;
  url: string;
  size: number;
  sha256: string;
  license: string;
  /** Set on lexicon and BART files; absent means the American set. */
  accent?: KokoroAccent;
  /** Set on voice packs; absent means af_heart. */
  voice?: KokoroVoiceId;
}

export const KOKORO_ONNX_REVISION = "1939ad2a8e416c0acfeecc08a694d14ef25f2231";
export const MISAKI_REVISION = "fba1236595f2d2bf21d414ba6e57d25256afada3";
export const BART_G2P_REVISION = "a5631b285d18d59483c32c0c3379cb9fac924f4b";
export const BART_G2P_GB_REVISION = "d8357d5067fa26a5c34134d6bbcf4bbf000c0ac8";

const KOKORO = `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/${KOKORO_ONNX_REVISION}`;
const MISAKI = `https://raw.githubusercontent.com/hexgrad/misaki/${MISAKI_REVISION}/misaki/data`;
const BART = `https://huggingface.co/PeterReid/graphemes_to_phonemes_en_us/resolve/${BART_G2P_REVISION}`;
const BART_GB = `https://huggingface.co/PeterReid/graphemes_to_phonemes_en_gb/resolve/${BART_G2P_GB_REVISION}`;

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

export const KOKORO_TOKENIZER: KokoroFile = {
  role: "tokenizer",
  name: "tokenizer.json",
  url: `${KOKORO}/tokenizer.json`,
  size: 3_497,
  sha256: "77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34",
  license: "Apache-2.0",
};

/** Pronunciation files per accent: misaki gold lexicon and the BART fallback. */
export const KOKORO_ACCENT_FILES: Readonly<
  Record<KokoroAccent, readonly KokoroFile[]>
> = {
  us: [
    {
      role: "lexicon",
      name: "us_gold.json",
      url: `${MISAKI}/us_gold.json`,
      size: 3_000_469,
      sha256:
        "dc414872a49a28ae6c141463d502fd945f3b2fde040484fdc47d00cc4612686f",
      license: "Apache-2.0",
      accent: "us",
    },
    {
      role: "bartConfig",
      name: "g2p-bart-config.json",
      url: `${BART}/config.json`,
      size: 1_257,
      sha256:
        "8deb3537fb29c63cd9f20d75515ae06e4c92f1b6db0703a2d45bca95b33a53a4",
      license: "Apache-2.0",
      accent: "us",
    },
    {
      role: "bartWeights",
      name: "g2p-bart.safetensors",
      url: `${BART}/model.safetensors`,
      size: 3_011_692,
      sha256:
        "dc4a02e62d4fcb4bb4097ecf00db89b8e1a12a549a52ab6adfbba220b80a55c5",
      license: "Apache-2.0",
      accent: "us",
    },
  ],
  // misaki's gb_gold (no silver: that set was generated with espeak-ng) and
  // the GB twin of the BART network, both verified by hash on 2026-09-17.
  gb: [
    {
      role: "lexicon",
      name: "gb_gold.json",
      url: `${MISAKI}/gb_gold.json`,
      size: 2_838_552,
      sha256:
        "29e62f4b60261c88f7f3c2c7811ca3825978948090b72d2b27d565b729282f71",
      license: "Apache-2.0",
      accent: "gb",
    },
    {
      role: "bartConfig",
      name: "g2p-bart-gb-config.json",
      url: `${BART_GB}/config.json`,
      size: 1_246,
      sha256:
        "e4f248e6af0cfb6cb54aea6ff0168d16b6f3cdabed438c487cde4ab0815d1bac",
      license: "Apache-2.0",
      accent: "gb",
    },
    {
      role: "bartWeights",
      name: "g2p-bart-gb.safetensors",
      url: `${BART_GB}/model.safetensors`,
      size: 3_011_692,
      sha256:
        "4994f474bb6f4584076a4e98189caaec11aa3f773a0d82d5bc263a03dd07e703",
      license: "Apache-2.0",
      accent: "gb",
    },
  ],
};

/** One 510 x 1 x 256 float32 style pack per voice. */
export const KOKORO_VOICE_FILES: Readonly<Record<KokoroVoiceId, KokoroFile>> = {
  af_heart: {
    role: "voice",
    name: "af_heart.bin",
    url: `${KOKORO}/voices/af_heart.bin`,
    size: 522_240,
    sha256: "d583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b",
    license: "Apache-2.0",
    voice: "af_heart",
  },
  bm_george: {
    role: "voice",
    name: "bm_george.bin",
    url: `${KOKORO}/voices/bm_george.bin`,
    size: 522_240,
    sha256: "c4b235a4c1f2cd3b939fed08b899ce9385638b763f7b73a59616c4fc9bd6c9bc",
    license: "Apache-2.0",
    voice: "bm_george",
  },
  bm_fable: {
    role: "voice",
    name: "bm_fable.bin",
    url: `${KOKORO}/voices/bm_fable.bin`,
    size: 522_240,
    sha256: "f889083196807b4adb15e9204252165f503b8d33d3982e681c52443c49d798f1",
    license: "Apache-2.0",
    voice: "bm_fable",
  },
};

/** The base install: everything af_heart needs. */
export const KOKORO_FILES: readonly KokoroFile[] = [
  KOKORO_FP32_MODEL,
  KOKORO_VOICE_FILES.af_heart,
  KOKORO_TOKENIZER,
  ...KOKORO_ACCENT_FILES.us,
];

/** Base install plus the British pack. */
export const KOKORO_ALL_FILES: readonly KokoroFile[] = [
  ...KOKORO_FILES,
  ...KOKORO_ACCENT_FILES.gb,
  KOKORO_VOICE_FILES.bm_george,
  KOKORO_VOICE_FILES.bm_fable,
];

export const KOKORO_TOTAL_BYTES = KOKORO_FILES.reduce((n, f) => n + f.size, 0);

export const fileAccent = (file: KokoroFile): KokoroAccent | undefined =>
  KOKORO_ACCENT_ROLES.includes(file.role) ? (file.accent ?? "us") : undefined;
export const fileVoice = (file: KokoroFile): KokoroVoiceId | undefined =>
  file.role === "voice" ? (file.voice ?? DEFAULT_KOKORO_VOICE) : undefined;

/**
 * The files one voice needs: model, tokenizer, its accent, its pack. Throws
 * when `files` has no pack or no complete accent for the voice: a list that
 * cannot serve a voice must never read as "nothing left to fetch".
 */
export function kokoroFilesFor(
  voice: KokoroVoiceId,
  files: readonly KokoroFile[] = KOKORO_ALL_FILES,
): readonly KokoroFile[] {
  const accent = KOKORO_VOICES[voice].accent;
  const own = files.filter((file) => {
    if (file.role === "voice") return fileVoice(file) === voice;
    const theirs = fileAccent(file);
    return theirs === undefined || theirs === accent;
  });
  if (!own.some((file) => file.role === "voice"))
    throw new Error(`Kokoro manifest has no pack for ${voice}`);
  if (!KOKORO_ACCENT_ROLES.every((role) => own.some((f) => f.role === role)))
    throw new Error(`Kokoro manifest lacks the ${accent} accent for ${voice}`);
  return own;
}

/** What a British voice adds on top of the base install. */
export function kokoroPackBytes(
  voice: KokoroVoiceId,
  files: readonly KokoroFile[] = KOKORO_ALL_FILES,
): number {
  const base = new Set(kokoroFilesFor(DEFAULT_KOKORO_VOICE, files));
  return kokoroFilesFor(voice, files)
    .filter((file) => !base.has(file))
    .reduce((n, f) => n + f.size, 0);
}

/** The British pack with George: gb_gold, the GB BART and bm_george.bin. */
export const KOKORO_GB_PACK_BYTES = kokoroPackBytes("bm_george");

/** Stored name: the hash prefix keeps different revisions apart. */
export function kokoroFileName(file: KokoroFile): string {
  return `${file.sha256.slice(0, 12)}-${file.name}`;
}

/** Stored names look like this; anything else in the directory is not ours. */
export const KOKORO_STORED_NAME = /^[0-9a-f]{12}-[\w.-]+?(?:\.partial)?$/;

export interface KokoroAccentPaths {
  lexicon: string;
  bartConfig: string;
  bartWeights: string;
}

/**
 * Where the worker finds each file. Accents and voices are listed whether or
 * not they are installed yet: the worker reads them on demand, so a pack
 * downloaded while it runs is picked up without a restart.
 */
export interface KokoroPaths {
  model: string;
  tokenizer: string;
  accents: Partial<Record<KokoroAccent, KokoroAccentPaths>>;
  voices: Partial<Record<KokoroVoiceId, string>>;
}

export function kokoroPaths(
  modelDir: string,
  files: readonly KokoroFile[] = KOKORO_ALL_FILES,
  join: (...parts: string[]) => string = (...parts) => parts.join("/"),
): KokoroPaths {
  const paths: KokoroPaths = {
    model: "",
    tokenizer: "",
    accents: {},
    voices: {},
  };
  const accents: Partial<Record<KokoroAccent, Partial<KokoroAccentPaths>>> = {};
  for (const file of files) {
    const path = join(modelDir, kokoroFileName(file));
    const accent = fileAccent(file);
    const voice = fileVoice(file);
    if (accent)
      (accents[accent] ??= {})[file.role as keyof KokoroAccentPaths] = path;
    else if (voice) paths.voices[voice] = path;
    else paths[file.role as "model" | "tokenizer"] = path;
  }
  for (const [accent, set] of Object.entries(accents) as [
    KokoroAccent,
    Partial<KokoroAccentPaths>,
  ][]) {
    if (!set.lexicon || !set.bartConfig || !set.bartWeights)
      throw new Error(`Kokoro manifest has a partial ${accent} accent`);
    paths.accents[accent] = set as KokoroAccentPaths;
  }
  if (!paths.model) throw new Error("Kokoro manifest is missing model");
  if (!paths.tokenizer) throw new Error("Kokoro manifest is missing tokenizer");
  if (!paths.voices[DEFAULT_KOKORO_VOICE])
    throw new Error(`Kokoro manifest is missing ${DEFAULT_KOKORO_VOICE}`);
  if (!paths.accents[KOKORO_VOICES[DEFAULT_KOKORO_VOICE].accent])
    throw new Error("Kokoro manifest is missing the default accent");
  for (const voice of KOKORO_VOICE_IDS)
    if (paths.voices[voice] && !paths.accents[KOKORO_VOICES[voice].accent])
      throw new Error(`Kokoro manifest has ${voice} without its accent`);
  return paths;
}
