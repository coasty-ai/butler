/**
 * Kokoro v1.0 phoneme tokens: the onnx-community tokenizer.json vocabulary,
 * phoneme -> id mapping, the 510-token context split and the voice style row.
 * Pure: the caller passes tokenizer.json's text; no I/O happens here.
 */

export const KOKORO_SAMPLE_RATE = 24000;
/** Phoneme tokens per model call, excluding the two pad ids. */
export const KOKORO_MAX_TOKENS = 510;
export const KOKORO_STYLE_DIM = 256;
/** Rows in a voice pack (af_heart.bin is 510 x 1 x 256 float32). */
export const KOKORO_STYLE_ROWS = 510;
export const KOKORO_PAD_ID = 0;

export type KokoroVocab = ReadonlyMap<string, number>;

/** Reads `model.vocab` from onnx-community's Kokoro tokenizer.json. */
export function parseTokenizerVocab(
  json: string | unknown,
): Map<string, number> {
  const parsed = typeof json === "string" ? JSON.parse(json) : json;
  const vocab = (parsed as { model?: { vocab?: unknown } })?.model?.vocab;
  if (!vocab || typeof vocab !== "object")
    throw new Error("tokenizer.json has no model.vocab");
  const map = new Map<string, number>();
  for (const [symbol, id] of Object.entries(vocab as Record<string, unknown>)) {
    if (!Number.isInteger(id) || (id as number) < 0 || [...symbol].length !== 1)
      throw new Error("tokenizer.json vocab entry is malformed");
    map.set(symbol, id as number);
  }
  if (map.get("$") !== KOKORO_PAD_ID)
    throw new Error("tokenizer.json pad token is not $ = 0");
  return map;
}

/** Maps phonemes to ids; symbols outside the vocabulary are dropped. */
export function tokenize(
  phonemes: string,
  vocab: KokoroVocab,
): { ids: number[]; dropped: number } {
  const ids: number[] = [];
  let dropped = 0;
  for (const symbol of phonemes) {
    const id = vocab.get(symbol);
    if (id === undefined || id === KOKORO_PAD_ID) dropped++;
    else ids.push(id);
  }
  return { ids, dropped };
}

// Kokoro's pipeline "waterfall": prefer sentence ends, then clauses, then words.
const WATERFALL = [".!?…", ":;", ",—", " "];

/**
 * Soft cap per chunk (~7 s of speech, ~2 s to synthesize on an M2). The voice
 * helper fails a PCM utterance when no chunk arrives for 2.5 s after the
 * queued audio has played, so one very long sentence after a short one is
 * split at clause punctuation (never mid-clause) to keep chunks flowing.
 */
export const KOKORO_SOFT_TOKENS = 120;
const CLAUSE = ",;:—";
/** A soft split never leaves a fragment shorter than this. */
const MIN_CLAUSE_TOKENS = 16;

/**
 * Splits a phoneme string so every piece fits one model call (<= max tokens,
 * at sentence ends, then clauses, then words), then splits pieces longer than
 * `soft` tokens at clause punctuation only. Unknown symbols are removed first
 * so string positions equal token positions.
 */
export function splitPhonemes(
  phonemes: string,
  vocab: KokoroVocab,
  max = KOKORO_MAX_TOKENS,
  soft = KOKORO_SOFT_TOKENS,
): string[] {
  const chars = [...phonemes].filter((c) => {
    const id = vocab.get(c);
    return id !== undefined && id !== KOKORO_PAD_ID;
  });
  const pieces: string[] = [];
  let start = 0;
  const take = (cut: number) => {
    const piece = chars.slice(start, cut).join("").trim();
    if (piece) pieces.push(piece);
    start = cut;
    while (chars[start] === " ") start++;
  };
  while (chars.length - start > Math.min(max, soft)) {
    let cut = -1;
    if (chars.length - start > max) {
      for (const group of WATERFALL) {
        for (let i = start + max - 1; i > start; i--) {
          if (group.includes(chars[i])) {
            cut = i + 1;
            break;
          }
        }
        if (cut > start) break;
      }
      if (cut <= start) cut = start + max;
    }
    // Prefer the last clause break inside the soft window, else the first after it.
    const clause = (i: number) =>
      CLAUSE.includes(chars[i]) &&
      i + 1 - start >= MIN_CLAUSE_TOKENS &&
      chars.length - (i + 1) >= MIN_CLAUSE_TOKENS;
    const limit = cut > start ? cut : chars.length;
    let softCut = -1;
    if (limit - start > soft) {
      for (let i = start + soft - 1; i > start; i--)
        if (clause(i)) {
          softCut = i + 1;
          break;
        }
      for (let i = start + soft; softCut < 0 && i < limit - 1; i++)
        if (clause(i)) softCut = i + 1;
    }
    if (softCut > start) cut = softCut;
    if (cut <= start) break;
    take(cut);
  }
  take(chars.length);
  return pieces;
}

/** input_ids for one call: pad, ids, pad. */
export function inputIds(ids: readonly number[]): BigInt64Array {
  if (ids.length > KOKORO_MAX_TOKENS)
    throw new Error(`too many phoneme tokens (${ids.length})`);
  const out = new BigInt64Array(ids.length + 2);
  for (let i = 0; i < ids.length; i++) out[i + 1] = BigInt(ids[i]);
  return out;
}

/** Offset (in floats) of the style row for a call with `tokens` phoneme ids. */
export function styleOffset(tokens: number): number {
  const row = Math.min(Math.max(Math.floor(tokens), 0), KOKORO_STYLE_ROWS - 1);
  return row * KOKORO_STYLE_DIM;
}

/** The 256-dim style vector a voice pack uses for a call of `tokens` ids. */
export function styleFor(voice: Float32Array, tokens: number): Float32Array {
  if (voice.length < KOKORO_STYLE_ROWS * KOKORO_STYLE_DIM)
    throw new Error("voice pack is truncated");
  const offset = styleOffset(tokens);
  return voice.slice(offset, offset + KOKORO_STYLE_DIM);
}
