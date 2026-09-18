/**
 * The Kokoro voice catalogue: which voice packs exist, which pronunciation
 * (lexicon and fallback network) each one needs, and the speed range the
 * model was trained for. Pure: shared by the main-process client, the
 * utilityProcess worker and Settings without any I/O.
 *
 * Voice grades are hexgrad/Kokoro-82M VOICES.md: af_heart is the only A;
 * both British men are C (minutes of training data), so Heart stays the
 * default and the British voices are an opt-in pack.
 */

export type KokoroAccent = "us" | "gb";

export const KOKORO_VOICE_IDS = ["af_heart", "bm_george", "bm_fable"] as const;
export type KokoroVoiceId = (typeof KOKORO_VOICE_IDS)[number];

export const DEFAULT_KOKORO_VOICE: KokoroVoiceId = "af_heart";

export interface KokoroVoiceInfo {
  accent: KokoroAccent;
  label: string;
  /** VOICES.md overall grade. */
  grade: "A" | "C";
  /** What Settings plays as a preview; every word is in the voice's lexicon. */
  sample: string;
}

export const KOKORO_VOICES: Readonly<Record<KokoroVoiceId, KokoroVoiceInfo>> = {
  af_heart: {
    accent: "us",
    label: "Heart (American)",
    grade: "A",
    sample: "Hello. I'm the natural voice on this Mac, ready when you are.",
  },
  bm_george: {
    accent: "gb",
    label: "George (British)",
    grade: "C",
    sample:
      "Good afternoon. Shall I open your calendar, or read the news first?",
  },
  bm_fable: {
    accent: "gb",
    label: "Fable (British)",
    grade: "C",
    sample:
      "Good afternoon. Shall I open your calendar, or read the news first?",
  },
};

export function isKokoroVoiceId(value: unknown): value is KokoroVoiceId {
  return (
    typeof value === "string" &&
    (KOKORO_VOICE_IDS as readonly string[]).includes(value)
  );
}

/**
 * Kokoro's `speed` input: 1 is the trained pace, above it is faster. Outside
 * 0.8-1.3 the prosody falls apart (syllables smear or clip), so the user's
 * voice rate (0.8-1.4 for the Mac voice) is clamped here.
 */
export const KOKORO_SPEED = { min: 0.8, max: 1.3, default: 1 } as const;

/** A usable speed for any input: NaN and non-numbers become the default. */
export function kokoroSpeed(value: unknown): number {
  const speed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(speed)) return KOKORO_SPEED.default;
  const clamped = Math.min(KOKORO_SPEED.max, Math.max(KOKORO_SPEED.min, speed));
  // Two decimals: enough for a slider, and a stable phrase-cache key.
  return Math.round(clamped * 100) / 100;
}
