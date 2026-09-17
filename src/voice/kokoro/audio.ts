/**
 * PCM helpers for the Kokoro voice: silence trimming and float -> s16 samples.
 * Kokoro clips carry ~300 ms of leading and ~500 ms of trailing silence; trimming
 * them to ~30 ms / ~150 ms cuts reply latency and keeps sentence gaps natural.
 * Pure: no I/O.
 */

export interface TrimOptions {
  /** Silence kept before the first audible frame. */
  leadMs?: number;
  /** Silence kept after the last audible frame. */
  trailMs?: number;
  /** A 10 ms frame at or above this RMS level counts as audible. */
  thresholdDb?: number;
  /** Linear fade applied at a cut edge to avoid clicks. */
  fadeMs?: number;
}

const FRAME_MS = 10;

/** Returns a trimmed copy; an all-silent clip becomes empty. */
export function trimSilence(
  samples: Float32Array,
  sampleRate: number,
  options: TrimOptions = {},
): Float32Array {
  const { leadMs = 30, trailMs = 150, thresholdDb = -50, fadeMs = 4 } = options;
  const frame = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000));
  const threshold = 10 ** (thresholdDb / 10); // mean square
  let first = -1;
  let last = -1;
  for (let at = 0; at < samples.length; at += frame) {
    const end = Math.min(samples.length, at + frame);
    let sum = 0;
    for (let i = at; i < end; i++) {
      const v = samples[i];
      if (Number.isFinite(v)) sum += v * v;
    }
    if (sum / (end - at) >= threshold) {
      if (first < 0) first = at;
      last = end;
    }
  }
  if (first < 0) return new Float32Array(0);
  const start = Math.max(0, first - Math.round((sampleRate * leadMs) / 1000));
  const stop = Math.min(
    samples.length,
    last + Math.round((sampleRate * trailMs) / 1000),
  );
  const out = samples.slice(start, stop);
  const fade = Math.min(
    Math.round((sampleRate * fadeMs) / 1000),
    Math.floor(out.length / 2),
  );
  for (let i = 0; i < fade; i++) {
    const gain = i / fade;
    if (start > 0) out[i] *= gain;
    if (stop < samples.length) out[out.length - 1 - i] *= gain;
  }
  return out;
}

/** Float32 [-1, 1] -> Int16 (clamped; non-finite samples become silence). */
export function toInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    if (!Number.isFinite(v)) continue;
    const scaled = Math.round(v * 32767);
    out[i] = scaled > 32767 ? 32767 : scaled < -32768 ? -32768 : scaled;
  }
  return out;
}
