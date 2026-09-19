import type { Settings } from "../src/core/schema";
import {
  KokoroError,
  kokoroSupported,
  type KokoroChunk,
  type KokoroVoice,
} from "./kokoro/client";

/**
 * Speech output adapter. Chooses the voice engine for every utterance:
 * - `system`: Apple on-device speech inside the voice helper (default).
 * - `kokoro`: the free on-device Kokoro voice (Apple Silicon, once downloaded),
 *   synthesized one sentence at a time in a utility process and relayed to the
 *   helper as 24 kHz s16le PCM. It always speaks at speed 1.0: voiceRate only
 *   applies to the system voice.
 * - `openai`: gpt-4o-mini-tts streamed as raw 24 kHz s16le PCM, relayed to the
 *   helper in ~100 ms chunks. Opt-in, PRIVATE_BYOM only, user's OpenAI key.
 * A Kokoro or cloud failure before audio reaches the helper silently falls
 * back to the system voice, but only while the helper still holds the
 * utterance: one it already dropped (barge-in, replacement) is never spoken
 * again. Traces are content-free: never the text, key or response body.
 */

export type SpeakPriority = "ack" | "result" | "urgent";
export type FollowUpKind = "answer" | "approval" | "continuation" | "scroll";
export type SpeechEngine = "system" | "kokoro" | "openai";
/**
 * How the cloud voice is asked to read a line: the persona for replies and
 * results, or plainly for approvals, questions and failures.
 */
export type SpeechStyle = "persona" | "clear";
export type Persona = "jarvis" | "friendly";
export interface SpeakRequest {
  utteranceId: string;
  text: string;
  priority: SpeakPriority;
  listen?: { kind: FollowUpKind; seconds: number };
  style?: SpeechStyle;
}
/**
 * A reply that arrives sentence by sentence (a streamed model reply). It is
 * spoken as ONE utterance so the helper's half-duplex guard stays closed
 * between sentences; each sentence is synthesized as soon as its text
 * arrives, and a sentence whose audio is not ready within the gap limit ends
 * the utterance rather than leaving the helper silent past its stall guard.
 */
export interface SpeakStreamRequest {
  utteranceId: string;
  sentences: AsyncIterable<string>;
  priority: SpeakPriority;
  style?: SpeechStyle;
  /** Each sentence as it is handed to the engine. */
  onSentence?: (text: string) => void;
}
export interface SpeakResult {
  accepted: boolean;
  reason?: string;
  engine: SpeechEngine;
}
export interface SpeechOutput {
  speak(request: SpeakRequest): Promise<SpeakResult>;
  /** The sentences actually handed to the engine come back as `spoken`. */
  speakStream(
    request: SpeakStreamRequest,
  ): Promise<SpeakResult & { spoken: string }>;
  /**
   * Aborts any in-flight Kokoro synthesis or cloud request with no fallback
   * and without calling stopSpeaking: for barge-in, when the helper already
   * stopped playback.
   */
  cancel(): void;
  /** Cancels like cancel(), then calls voiceCall("stopSpeaking"). */
  stop(): Promise<void>;
  /** Settings "Preview" with the current engine, priority urgent. */
  preview(text: string): Promise<SpeakResult>;
}
/** The settings this adapter reads; compiles before and after the schema keys land. */
export type SpeechSettings = Pick<Settings, "privacy"> & {
  voiceEngine?: SpeechEngine;
  cloudVoice?: string;
  /** The Kokoro voice pack; the client falls back to its base voice. */
  kokoroVoice?: string;
  /** Also the Kokoro speed, clamped to what the model renders well. */
  voiceRate?: number;
  persona?: Persona;
};
/** Passed through to Kokoro: an older client simply ignores them. */
export interface KokoroSpeakOptions {
  voice?: string;
  speed?: number;
}
/** The Kokoro client as this adapter uses it (client.ts widens synthesize). */
export interface KokoroSynth {
  status: KokoroVoice["status"];
  synthesize(
    text: string,
    signal?: AbortSignal,
    options?: KokoroSpeakOptions,
  ): AsyncIterable<KokoroChunk>;
}
export interface SpeechOutputDeps {
  settings: () => SpeechSettings;
  openaiKey: () => string;
  voiceCall: (method: string, data?: Record<string, unknown>) => Promise<any>;
  fetch: typeof fetch;
  /** The on-device Kokoro voice; without it "kokoro" speaks with the system voice. */
  kokoro?: KokoroSynth;
  /** Defaults to kokoroSupported() from ./kokoro/client (Apple Silicon only). */
  kokoroSupported?: () => boolean;
  now?: () => number;
  trace?: (event: string, data: Record<string, unknown>) => void;
}

/**
 * How gpt-4o-mini-tts is asked to read. Fixed strings that never carry user
 * content: the persona for replies, and a plain delivery for approvals and
 * questions, where every word must land.
 */
export const PERSONA_INSTRUCTIONS: Record<Persona, string> = {
  jarvis:
    "Voice: composed, quietly confident and articulate, like a trusted butler who has worked for this person for years. Accent: educated southern British English, Received Pronunciation. Tone: understated and calm, with a light dry wit; never gushing, salesy or sing-song. Pacing: brisk but unhurried and even, with natural pauses at commas and a slight pause before a key name, time or number. Delivery: conversational, as if speaking to someone in the same room, not reading an announcement.",
  friendly:
    "Speak warmly and naturally, like a helpful friend. Keep a relaxed, conversational pace.",
};
export const CLEAR_INSTRUCTION =
  "Keep the same voice and accent. Speak clearly and evenly at a steady, moderate pace with a calm, attentive tone and no humor. Pronounce every word distinctly and slow slightly for names and numbers.";
export function instructionFor(style: SpeechStyle, persona: Persona): string {
  if (style === "persona") return PERSONA_INSTRUCTIONS[persona];
  return persona === "jarvis"
    ? `${CLEAR_INSTRUCTION} Accent: Received Pronunciation British English.`
    : CLEAR_INSTRUCTION;
}
export const openaiSpeech = {
  url: "https://api.openai.com/v1/audio/speech",
  model: "gpt-4o-mini-tts",
  /** The default persona's instruction; instructionFor() picks per request. */
  instructions: PERSONA_INSTRUCTIONS.jarvis,
  defaultVoice: "marin",
  sampleRate: 24000,
  /** 100 ms of 16-bit mono at 24 kHz. */
  chunkBytes: 9600,
  firstByteMs: 1200,
  /** Later sentences of a stream may take this long to their first byte. */
  laterFirstByteMs: 2000,
  deadlineMs: 15000,
} as const;
/**
 * Streamed replies: one utterance of at most a few sentences, with never
 * more than 2.0 s between the last audio of one sentence and the first of
 * the next, so the helper's stall guard (2.5 s) never fires and the echo
 * guard stays closed. The system voice, which cannot be fed piecewise,
 * collects for 2.5 s after the first sentence and speaks what it has.
 */
export const streamSpeech = {
  sentenceGapMs: 2000,
  maxSentences: 4,
  maxChars: 600,
  systemCollectMs: 2500,
} as const;
/** Kokoro speed from the voice rate: it renders cleanly only in this range. */
export function kokoroSpeed(rate: number | undefined): number {
  const value = typeof rate === "number" && Number.isFinite(rate) ? rate : 1;
  return Math.min(1.3, Math.max(0.8, Math.round(value * 100) / 100));
}
export const kokoroSpeech = {
  sampleRate: 24000,
  /** 100 ms of 16-bit mono at 24 kHz. */
  chunkBytes: 9600,
  /**
   * A cold worker needs ~1-2 s for the first sentence. This wait happens
   * before playPcmStart, because the helper's stall timer starts there.
   */
  firstAudioMs: 5000,
  deadlineMs: 15000,
} as const;
export const maxSpeechChars = 300;
// 300 characters can never legitimately produce a minute of audio.
const maxPcmBytes = openaiSpeech.sampleRate * 2 * 60;

/**
 * Kokoro only when chosen, supported on this Mac and downloaded; the cloud
 * voice only when opted in, bring-your-own-model, and keyed; otherwise the
 * system voice.
 */
export function selectSpeechEngine(
  settings: SpeechSettings,
  key: string,
  kokoro?: Pick<KokoroVoice, "status">,
  supported: () => boolean = kokoroSupported,
): SpeechEngine {
  if (settings.voiceEngine === "kokoro") {
    try {
      return kokoro && supported() && kokoro.status()?.installed === true
        ? "kokoro"
        : "system";
    } catch {
      return "system";
    }
  }
  return settings.voiceEngine === "openai" &&
    settings.privacy === "PRIVATE_BYOM" &&
    key.trim() !== ""
    ? "openai"
    : "system";
}

/** Strips control characters, collapses whitespace and caps the length. */
export function speechText(value: string): string {
  const clean = String(value ?? "")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= maxSpeechChars) return clean;
  let cut = "";
  for (const char of clean) {
    if (cut.length + char.length > maxSpeechChars) break;
    cut += char;
  }
  // Prefer ending on a word boundary so the voice does not clip a word.
  const space = cut.lastIndexOf(" ");
  return (space >= maxSpeechChars * 0.6 ? cut.slice(0, space) : cut).trimEnd();
}

/** Abort reasons and failure statuses: fixed, content-free tokens. */
class SpeechStop extends Error {
  constructor(readonly status: string) {
    super(status);
  }
}
type Cancel = "superseded" | "stopped" | "interrupted";
type PcmEngine = Exclude<SpeechEngine, "system">;
interface Flight {
  controller: AbortController;
  cancelled?: Cancel;
}
type Log = (
  phase: "requested" | "started" | "fallback" | "finished" | "error",
  data: { engine: SpeechEngine; fallback?: boolean; status?: string },
) => void;

const token = (value: unknown, otherwise: string) =>
  typeof value === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(value)
    ? value
    : otherwise;
const cloudVoice = (value: unknown) =>
  typeof value === "string" && /^[a-z][a-z0-9_-]{0,39}$/.test(value)
    ? value
    : openaiSpeech.defaultVoice;
const reasonOf = (value: unknown) =>
  typeof value === "string" ? { reason: value } : {};
const persona = (settings: SpeechSettings): Persona =>
  settings.persona === "friendly" ? "friendly" : "jarvis";
const kokoroOptions = (settings: SpeechSettings): KokoroSpeakOptions => ({
  ...(typeof settings.kokoroVoice === "string" &&
  /^[a-z]{2}_[a-z]+$/.test(settings.kokoroVoice)
    ? { voice: settings.kokoroVoice }
    : {}),
  speed: kokoroSpeed(settings.voiceRate),
});

/** Races a promise against an abort signal, even if the promise ignores it. */
function until<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
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
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

function join(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (!a.byteLength) return b;
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a);
  out.set(b, a.byteLength);
  return out;
}

export function createSpeechOutput(deps: SpeechOutputDeps): SpeechOutput {
  const now = deps.now ?? (() => performance.now());
  let flight: Flight | undefined;

  const cancelFlight = (why: Cancel) => {
    const current = flight;
    flight = undefined;
    if (!current) return;
    current.cancelled = why;
    current.controller.abort(new SpeechStop(why));
  };

  const payload = (request: SpeakRequest) => ({
    utteranceId: request.utteranceId,
    priority: request.priority,
    ...(request.listen ? { listen: request.listen } : {}),
  });

  async function system(
    request: SpeakRequest,
    fallback: boolean,
    log: Log,
  ): Promise<SpeakResult> {
    try {
      const result = await deps.voiceCall("speak", {
        ...payload(request),
        text: request.text,
      });
      const accepted = result?.accepted === true;
      log("finished", {
        engine: "system",
        fallback,
        status: accepted ? "accepted" : token(result?.reason, "rejected"),
      });
      return { accepted, ...reasonOf(result?.reason), engine: "system" };
    } catch {
      log("error", { engine: "system", fallback, status: "helper" });
      return { accepted: false, reason: "unavailable", engine: "system" };
    }
  }

  /** One PCM utterance in the helper: the start, chunk, end and abort rules. */
  function pcmPlayback(
    request: SpeakRequest,
    engine: PcmEngine,
    mine: Flight,
    log: Log,
  ) {
    const { utteranceId } = request;
    const signal = mine.controller.signal;
    let seq = 0;
    let acked = false;
    const abortHelper = async () => {
      let result: any;
      try {
        result = await deps.voiceCall("playPcmAbort", { utteranceId });
      } catch {}
      // Whether the user heard anything decides if the helper will still
      // emit speech_finished for this utterance.
      return typeof result?.started === "boolean" ? result.started : acked;
    };
    const cancelled = async (): Promise<SpeakResult> => {
      const heard = await abortHelper();
      log("finished", { engine, status: mine.cancelled });
      return {
        accepted: heard,
        ...(heard ? {} : { reason: "cancelled" }),
        engine,
      };
    };
    const fallback = async (status: string): Promise<SpeakResult> => {
      let result: any;
      try {
        result = await deps.voiceCall("playPcmAbort", { utteranceId });
      } catch {
        // Unknown whether the helper still has it: silence beats a repeat.
        log(mine.cancelled ? "finished" : "error", {
          engine,
          status: mine.cancelled ?? "helper",
        });
        return {
          accepted: false,
          reason: mine.cancelled ? "cancelled" : "unavailable",
          engine,
        };
      }
      // With aborted and started both true the helper emits speech_finished.
      const heard = result?.aborted === true && result?.started === true;
      // A newer utterance or stop() must never be talked over by a fallback.
      if (mine.cancelled) {
        log("finished", { engine, status: mine.cancelled });
        return {
          accepted: heard,
          ...(heard ? {} : { reason: "cancelled" }),
          engine,
        };
      }
      // Fall back only if the helper still held the utterance and played none
      // of it. Otherwise it was dropped (barge-in, replacement, stop) or it is
      // already audible, and the system voice would say it again.
      if (result?.aborted !== true || result?.started !== false) {
        if (heard) log("error", { engine, status });
        else log("finished", { engine, status: "dropped" });
        return {
          accepted: heard,
          ...(heard ? {} : { reason: "dropped" }),
          engine,
        };
      }
      log("fallback", { engine, fallback: true, status });
      return system(request, true, log);
    };

    return {
      get acked() {
        return acked;
      },
      cancelled,
      fallback,
      start: (sampleRate: number) =>
        deps.voiceCall("playPcmStart", {
          ...payload(request),
          sampleRate,
          format: "s16le",
        }),
      /** False when the helper dropped the utterance. */
      async send(bytes: Uint8Array) {
        const ack = await deps.voiceCall("playPcmChunk", {
          utteranceId,
          seq: seq++,
          data: Buffer.from(
            bytes.buffer,
            bytes.byteOffset,
            bytes.byteLength,
          ).toString("base64"),
        });
        // ok:false means the helper dropped this utterance (barge-in or
        // replacement); it already handled playback, so only stop the source.
        if (ack?.ok !== true) return false;
        if (!acked) {
          acked = true;
          log("started", { engine });
        }
        signal.throwIfAborted();
        return true;
      },
      /** The helper dropped the utterance: stop the source, no fallback. */
      dropped(): SpeakResult {
        mine.controller.abort(new SpeechStop("dropped"));
        log("finished", { engine, status: "dropped" });
        return {
          accepted: acked,
          ...(acked ? {} : { reason: "dropped" }),
          engine,
        };
      },
      async end(): Promise<SpeakResult> {
        const end = await deps.voiceCall("playPcmEnd", { utteranceId });
        log("finished", {
          engine,
          status: end?.ok === true ? "ok" : "dropped",
        });
        return { accepted: true, engine };
      },
      /** After the helper accepted the utterance and the source failed. */
      async failed(status: string): Promise<SpeakResult> {
        if (mine.cancelled) return cancelled();
        if (!acked) return fallback(status);
        // Audio already reached the helper: stop it, never speak twice.
        const heard = await abortHelper();
        log("error", { engine, status });
        return {
          accepted: heard,
          ...(heard ? {} : { reason: "failed" }),
          engine,
        };
      },
    };
  }

  async function local(
    request: SpeakRequest,
    kokoro: Pick<KokoroSynth, "synthesize">,
    options: KokoroSpeakOptions,
    mine: Flight,
    log: Log,
  ): Promise<SpeakResult> {
    const signal = mine.controller.signal;
    const pcm = pcmPlayback(request, "kokoro", mine, log);
    let iterator: AsyncIterator<KokoroChunk> | undefined;
    let closed = false;
    let started = false;
    /** Ends synthesis in the worker; never awaited, so it cannot hold speech. */
    const release = () => {
      if (closed || !iterator) return;
      closed = true;
      try {
        Promise.resolve(iterator.return?.()).catch(() => {});
      } catch {}
    };
    const nextChunk = async (): Promise<KokoroChunk | undefined> => {
      for (;;) {
        let next: IteratorResult<KokoroChunk>;
        try {
          next = await until(iterator!.next(), signal);
        } catch (error) {
          if (signal.aborted || error instanceof KokoroError) throw error;
          throw new SpeechStop("synthesis_failed");
        }
        if (next.done) {
          closed = true;
          return undefined;
        }
        if (next.value?.pcm?.byteLength) return next.value;
      }
    };

    const deadline = setTimeout(
      () => mine.controller.abort(new SpeechStop("timeout")),
      kokoroSpeech.deadlineMs,
    );
    let firstAudio: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => mine.controller.abort(new SpeechStop("first_audio_timeout")),
      kokoroSpeech.firstAudioMs,
    );
    try {
      try {
        iterator = kokoro
          .synthesize(request.text, signal, options)
          [Symbol.asyncIterator]();
      } catch (error) {
        throw error instanceof KokoroError
          ? error
          : new SpeechStop("synthesis_failed");
      }
      // The helper fails a PCM utterance that stays silent after
      // playPcmStart, so wait for real audio before starting it.
      let chunk = await nextChunk();
      if (!chunk) throw new SpeechStop("empty");
      clearTimeout(firstAudio);
      firstAudio = undefined;
      signal.throwIfAborted();

      let start: any;
      try {
        start = await pcm.start(kokoroSpeech.sampleRate);
      } catch {
        release();
        return mine.cancelled ? pcm.cancelled() : pcm.fallback("helper");
      }
      if (start?.accepted !== true) {
        release();
        log("finished", {
          engine: "kokoro",
          status: token(start?.reason, "rejected"),
        });
        return {
          accepted: false,
          ...reasonOf(start?.reason),
          engine: "kokoro",
        };
      }
      started = true;
      if (mine.cancelled) {
        release();
        return pcm.cancelled();
      }

      let total = 0;
      do {
        const bytes = new Uint8Array(
          chunk.pcm.buffer,
          chunk.pcm.byteOffset,
          chunk.pcm.byteLength,
        );
        total += bytes.byteLength;
        if (total > maxPcmBytes) throw new SpeechStop("too_long");
        for (let at = 0; at < bytes.byteLength; at += kokoroSpeech.chunkBytes) {
          if (
            !(await pcm.send(bytes.subarray(at, at + kokoroSpeech.chunkBytes)))
          ) {
            const result = pcm.dropped();
            release();
            return result;
          }
        }
        chunk = await nextChunk();
      } while (chunk);
      return await pcm.end();
    } catch (error) {
      const status =
        signal.aborted && signal.reason instanceof SpeechStop
          ? signal.reason.status
          : error instanceof SpeechStop
            ? error.status
            : error instanceof KokoroError
              ? token(error.code, "synthesis_failed")
              : "helper";
      mine.controller.abort(new SpeechStop("failed"));
      release();
      if (started) return pcm.failed(status);
      // Nothing reached the helper, so there is nothing to abort there.
      if (mine.cancelled) {
        log("finished", { engine: "kokoro", status: mine.cancelled });
        return { accepted: false, reason: "cancelled", engine: "kokoro" };
      }
      log("fallback", { engine: "kokoro", fallback: true, status });
      return system(request, true, log);
    } finally {
      clearTimeout(deadline);
      if (firstAudio) clearTimeout(firstAudio);
      release();
    }
  }

  async function cloud(
    request: SpeakRequest,
    key: string,
    voice: string,
    instructions: string,
    mine: Flight,
    log: Log,
  ): Promise<SpeakResult> {
    const signal = mine.controller.signal;
    const pcm = pcmPlayback(request, "openai", mine, log);

    let start: any;
    try {
      start = await pcm.start(openaiSpeech.sampleRate);
    } catch {
      return mine.cancelled ? pcm.cancelled() : pcm.fallback("helper");
    }
    if (start?.accepted !== true) {
      log("finished", {
        engine: "openai",
        status: token(start?.reason, "rejected"),
      });
      return { accepted: false, ...reasonOf(start?.reason), engine: "openai" };
    }
    if (mine.cancelled) return pcm.cancelled();

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const deadline = setTimeout(
      () => mine.controller.abort(new SpeechStop("timeout")),
      openaiSpeech.deadlineMs,
    );
    let firstByte: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => mine.controller.abort(new SpeechStop("first_byte_timeout")),
      openaiSpeech.firstByteMs,
    );
    const dropped = (): SpeakResult => {
      const result = pcm.dropped();
      void reader?.cancel().catch(() => {});
      return result;
    };

    try {
      const response = await until(
        (async () =>
          deps.fetch(openaiSpeech.url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${key}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: openaiSpeech.model,
              voice,
              input: request.text,
              instructions,
              response_format: "pcm",
              stream_format: "audio",
            }),
            signal,
            redirect: "error",
          }))(),
        signal,
      );
      if (!response.ok) {
        // Never read or echo the error body; it can quote the request.
        void response.body?.cancel().catch(() => {});
        throw new SpeechStop(`http_${Number(response.status) || 0}`);
      }
      reader = response.body?.getReader();
      if (!reader) throw new SpeechStop("empty");
      let pending: Uint8Array = new Uint8Array(0);
      let total = 0;
      for (;;) {
        const { done, value } = await until(reader.read(), signal);
        if (done) break;
        if (!value?.byteLength) continue;
        if (firstByte) {
          clearTimeout(firstByte);
          firstByte = undefined;
        }
        total += value.byteLength;
        if (total > maxPcmBytes) throw new SpeechStop("too_long");
        pending = join(pending, value);
        while (pending.byteLength >= openaiSpeech.chunkBytes) {
          if (!(await pcm.send(pending.subarray(0, openaiSpeech.chunkBytes))))
            return dropped();
          pending = pending.subarray(openaiSpeech.chunkBytes);
        }
      }
      // A trailing odd byte is half a sample; drop it.
      const even = pending.byteLength - (pending.byteLength % 2);
      if (even > 0 && !(await pcm.send(pending.subarray(0, even))))
        return dropped();
      if (!pcm.acked) throw new SpeechStop("empty");
      return await pcm.end();
    } catch (error) {
      const status =
        signal.aborted && signal.reason instanceof SpeechStop
          ? signal.reason.status
          : error instanceof SpeechStop
            ? error.status
            : "network";
      mine.controller.abort(new SpeechStop("failed"));
      void reader?.cancel().catch(() => {});
      return pcm.failed(status);
    } finally {
      clearTimeout(deadline);
      if (firstByte) clearTimeout(firstByte);
    }
  }

  async function speak(input: SpeakRequest): Promise<SpeakResult> {
    // A newer utterance always replaces an older in-flight Kokoro or cloud one.
    cancelFlight("superseded");
    const started = now();
    const request: SpeakRequest = { ...input, text: speechText(input.text) };
    const settings = deps.settings();
    let key = "";
    try {
      key = String(deps.openaiKey() ?? "").trim();
    } catch {}
    const engine = selectSpeechEngine(
      settings,
      key,
      deps.kokoro,
      deps.kokoroSupported ?? kokoroSupported,
    );
    const log: Log = (phase, data) => {
      // Diagnostics must never interfere with speech.
      try {
        deps.trace?.("SpeechOut", {
          phase,
          engine: data.engine,
          priority: request.priority,
          textLength: request.text.length,
          latencyMs: Math.max(0, Math.round(now() - started)),
          fallback: data.fallback ?? false,
          ...(data.status ? { status: data.status } : {}),
        });
      } catch {}
    };
    log("requested", { engine });
    if (!request.text) {
      log("finished", { engine, status: "empty" });
      return { accepted: false, reason: "empty", engine };
    }
    if (engine === "system") return system(request, false, log);
    const mine: Flight = { controller: new AbortController() };
    flight = mine;
    try {
      return engine === "kokoro" && deps.kokoro
        ? await local(request, deps.kokoro, kokoroOptions(settings), mine, log)
        : await cloud(
            request,
            key,
            cloudVoice(settings.cloudVoice),
            instructionFor(request.style ?? "persona", persona(settings)),
            mine,
            log,
          );
    } finally {
      if (flight === mine) flight = undefined;
    }
  }

  /** One sentence's audio as it arrives, for a streamed utterance. */
  type Job = {
    text: string;
    pieces: Uint8Array[];
    bytes: number;
    done: boolean;
    /** Fixed failure token; set with done. */
    error?: string;
    controller: AbortController;
  };

  /**
   * Feeds a streamed reply into one PCM utterance. `produce` turns one
   * sentence into audio (Kokoro or the cloud); every sentence starts
   * synthesizing the moment its text arrives, and audio is sent in order.
   */
  async function streamPcm(
    request: SpeakStreamRequest,
    engine: PcmEngine,
    mine: Flight,
    log: Log,
    produce: (
      job: Job,
      index: number,
      signal: AbortSignal,
    ) => AsyncIterable<Uint8Array>,
    sampleRate: number,
    firstAudioMs: number,
    fallbackText: (
      texts: string[],
    ) => Promise<SpeakResult & { spoken: string }>,
  ): Promise<SpeakResult & { spoken: string }> {
    const signal = mine.controller.signal;
    const pcm = pcmPlayback(
      {
        utteranceId: request.utteranceId,
        text: "",
        priority: request.priority,
      },
      engine,
      mine,
      log,
    );
    const jobs: Job[] = [];
    let ended = false;
    let chars = 0;
    let wake = () => {};
    const notify = () => {
      const w = wake;
      wake = () => {};
      w();
    };
    const changed = () => new Promise<void>((resolve) => (wake = resolve));
    const spoken: string[] = [];
    const childSignal = () => {
      const controller = new AbortController();
      const onAbort = () => controller.abort(signal.reason);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      return controller;
    };
    const startJob = (text: string, index: number) => {
      const job: Job = {
        text,
        pieces: [],
        bytes: 0,
        done: false,
        controller: childSignal(),
      };
      void (async () => {
        try {
          for await (const bytes of produce(
            job,
            index,
            job.controller.signal,
          )) {
            if (!bytes.byteLength) continue;
            job.pieces.push(bytes);
            job.bytes += bytes.byteLength;
            notify();
          }
        } catch (error) {
          job.error =
            job.controller.signal.aborted &&
            job.controller.signal.reason instanceof SpeechStop
              ? job.controller.signal.reason.status
              : error instanceof SpeechStop
                ? error.status
                : error instanceof KokoroError
                  ? token(error.code, "synthesis_failed")
                  : "synthesis_failed";
        } finally {
          job.done = true;
          notify();
        }
      })();
      return job;
    };
    // The producer: every sentence starts its own synthesis at once.
    void (async () => {
      try {
        for await (const raw of request.sentences) {
          if (signal.aborted) break;
          const text = speechText(raw);
          if (!text) continue;
          if (
            jobs.length >= streamSpeech.maxSentences ||
            chars + text.length > streamSpeech.maxChars
          )
            break;
          chars += text.length;
          try {
            request.onSentence?.(text);
          } catch {}
          jobs.push(startJob(text, jobs.length));
          notify();
        }
      } catch {
        /* The reply stream failed: what arrived is still spoken. */
      } finally {
        ended = true;
        notify();
      }
    })();
    const stopJobs = (from: number) => {
      for (const job of jobs.slice(from))
        if (!job.done) job.controller.abort(new SpeechStop("superseded"));
    };
    // One abort promise for every wait, so the signal never collects a
    // listener per chunk.
    const aborted = new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    /** Waits until `ready()` is truthy, the deadline passes or the flight is aborted. */
    const waitUntil = async (ready: () => boolean, deadlineAt: number) => {
      while (!ready()) {
        signal.throwIfAborted();
        const left = deadlineAt - now();
        if (left <= 0) return false;
        const next = changed();
        let timer: ReturnType<typeof setTimeout> | undefined;
        // No deadline: only a change or the abort ends the wait. A timer of
        // Infinity would fire every millisecond (Node clamps it to 1 ms).
        const deadline = Number.isFinite(left)
          ? new Promise<void>((resolve) => (timer = setTimeout(resolve, left)))
          : undefined;
        await Promise.race(
          deadline ? [next, deadline, aborted] : [next, aborted],
        );
        clearTimeout(timer);
      }
      return true;
    };
    const overall = setTimeout(
      () => mine.controller.abort(new SpeechStop("timeout")),
      kokoroSpeech.deadlineMs,
    );
    let started = false;
    let total = 0;
    const result = (r: SpeakResult) => ({ ...r, spoken: spoken.join(" ") });
    try {
      let lastAudioAt: number | undefined;
      for (let index = 0; ; index++) {
        // The next sentence: its text must arrive, then its first audio, in
        // time. Before the first sentence only the overall deadline applies;
        // after it, the gap limit keeps the helper from stalling.
        const gapAt =
          lastAudioAt === undefined
            ? Infinity
            : lastAudioAt + streamSpeech.sentenceGapMs;
        const arrived = await waitUntil(() => !!jobs[index] || ended, gapAt);
        const job = jobs[index];
        if (!job) {
          if (!arrived) {
            log("finished", { engine, status: "sentence_late" });
            stopJobs(index);
          }
          break;
        }
        const firstAt = index === 0 ? now() + firstAudioMs : gapAt;
        const ready = await waitUntil(
          () => job.pieces.length > 0 || job.done,
          firstAt,
        );
        if (!job.pieces.length) {
          // No audio for this sentence: the first one falls back to the
          // system voice, a later one just ends the utterance here.
          const status = job.error ?? (ready ? "empty" : "first_audio_timeout");
          stopJobs(index);
          if (index === 0 && !started) {
            if (mine.cancelled) throw new SpeechStop(mine.cancelled);
            log("fallback", { engine, fallback: true, status });
            return await fallbackText(jobs.map((j) => j.text));
          }
          log("error", { engine, status });
          break;
        }
        if (!started) {
          let start: any;
          try {
            start = await pcm.start(sampleRate);
          } catch {
            stopJobs(0);
            return result(
              mine.cancelled
                ? await pcm.cancelled()
                : await pcm.fallback("helper"),
            );
          }
          if (start?.accepted !== true) {
            stopJobs(0);
            log("finished", {
              engine,
              status: token(start?.reason, "rejected"),
            });
            return result({
              accepted: false,
              ...reasonOf(start?.reason),
              engine,
            });
          }
          started = true;
          if (mine.cancelled) {
            stopJobs(0);
            return result(await pcm.cancelled());
          }
        }
        // Send this sentence's audio as it arrives, in 100 ms pieces.
        let sent = 0;
        let pending: Uint8Array = new Uint8Array(0);
        for (;;) {
          while (sent < job.pieces.length) {
            pending = join(pending, job.pieces[sent++]);
            total += pending.byteLength;
            if (total > maxPcmBytes) throw new SpeechStop("too_long");
            while (pending.byteLength >= openaiSpeech.chunkBytes) {
              if (
                !(await pcm.send(pending.subarray(0, openaiSpeech.chunkBytes)))
              ) {
                stopJobs(index);
                return result(pcm.dropped());
              }
              pending = pending.subarray(openaiSpeech.chunkBytes);
            }
          }
          if (job.done) break;
          await waitUntil(() => sent < job.pieces.length || job.done, Infinity);
        }
        const even = pending.byteLength - (pending.byteLength % 2);
        if (even > 0 && !(await pcm.send(pending.subarray(0, even)))) {
          stopJobs(index);
          return result(pcm.dropped());
        }
        if (job.error && !job.bytes) throw new SpeechStop(job.error);
        spoken.push(job.text);
        lastAudioAt = now();
        if (job.error) {
          // Cut off mid-sentence: end here rather than jump to the next one.
          log("error", { engine, status: job.error });
          stopJobs(index + 1);
          break;
        }
      }
      if (!started) {
        log("finished", { engine, status: "empty" });
        return result({ accepted: false, reason: "empty", engine });
      }
      const end = await pcm.end();
      log("finished", { engine, status: `sentences_${spoken.length}` });
      return result(end);
    } catch (error) {
      const status =
        signal.aborted && signal.reason instanceof SpeechStop
          ? signal.reason.status
          : error instanceof SpeechStop
            ? error.status
            : "helper";
      mine.controller.abort(new SpeechStop("failed"));
      stopJobs(0);
      if (started) return result(await pcm.failed(status));
      if (mine.cancelled) {
        log("finished", { engine, status: mine.cancelled });
        return result({ accepted: false, reason: "cancelled", engine });
      }
      log("error", { engine, status });
      return result({ accepted: false, reason: status, engine });
    } finally {
      clearTimeout(overall);
      stopJobs(0);
    }
  }

  async function speakStream(
    request: SpeakStreamRequest,
  ): Promise<SpeakResult & { spoken: string }> {
    cancelFlight("superseded");
    const started = now();
    const settings = deps.settings();
    let key = "";
    try {
      key = String(deps.openaiKey() ?? "").trim();
    } catch {}
    const engine = selectSpeechEngine(
      settings,
      key,
      deps.kokoro,
      deps.kokoroSupported ?? kokoroSupported,
    );
    let sentences = 0;
    const log: Log = (phase, data) => {
      try {
        deps.trace?.("SpeechOut", {
          phase,
          engine: data.engine,
          priority: request.priority,
          stream: true,
          sentences,
          latencyMs: Math.max(0, Math.round(now() - started)),
          fallback: data.fallback ?? false,
          ...(data.status ? { status: data.status } : {}),
        });
      } catch {}
    };
    log("requested", { engine });
    const counted: SpeakStreamRequest = {
      ...request,
      onSentence: (text) => {
        sentences++;
        request.onSentence?.(text);
      },
    };
    const mine: Flight = { controller: new AbortController() };
    flight = mine;
    const asSpeak = (text: string): SpeakRequest => ({
      utteranceId: request.utteranceId,
      text,
      priority: request.priority,
      style: request.style,
    });
    try {
      if (engine === "system") {
        // The Mac voice takes whole text: gather what arrives within the
        // collection window after the first sentence, then say it once.
        const texts = await collectSentences(counted, mine.controller.signal);
        const text = speechText(texts.join(" "));
        if (!text) {
          log("finished", { engine, status: "empty" });
          return { accepted: false, reason: "empty", engine, spoken: "" };
        }
        const r = await system(asSpeak(text), false, log);
        return { ...r, spoken: r.accepted ? text : "" };
      }
      const fallbackText = async (texts: string[]) => {
        const text = speechText(texts.join(" "));
        if (!text)
          return { accepted: false, reason: "empty", engine, spoken: "" };
        const r = await system(asSpeak(text), true, log);
        return { ...r, spoken: r.accepted ? text : "" };
      };
      if (engine === "kokoro" && deps.kokoro) {
        const kokoro = deps.kokoro;
        const options = kokoroOptions(settings);
        return await streamPcm(
          counted,
          "kokoro",
          mine,
          log,
          async function* (job, _index, signal) {
            for await (const chunk of kokoro.synthesize(
              job.text,
              signal,
              options,
            ))
              if (chunk?.pcm?.byteLength)
                yield new Uint8Array(
                  chunk.pcm.buffer,
                  chunk.pcm.byteOffset,
                  chunk.pcm.byteLength,
                );
          },
          kokoroSpeech.sampleRate,
          kokoroSpeech.firstAudioMs,
          fallbackText,
        );
      }
      const voice = cloudVoice(settings.cloudVoice);
      const instructions = instructionFor(
        request.style ?? "persona",
        persona(settings),
      );
      return await streamPcm(
        counted,
        "openai",
        mine,
        log,
        (job, index, signal) =>
          cloudSentence(job.text, key, voice, instructions, signal, index),
        openaiSpeech.sampleRate,
        openaiSpeech.firstByteMs,
        fallbackText,
      );
    } finally {
      if (flight === mine) flight = undefined;
    }
  }

  /** One cloud request for one sentence, with its own first-byte limit. */
  async function* cloudSentence(
    text: string,
    key: string,
    voice: string,
    instructions: string,
    signal: AbortSignal,
    index: number,
  ): AsyncIterable<Uint8Array> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    let firstByte: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => controller.abort(new SpeechStop("first_byte_timeout")),
      index === 0 ? openaiSpeech.firstByteMs : openaiSpeech.laterFirstByteMs,
    );
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await until(
        deps.fetch(openaiSpeech.url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: openaiSpeech.model,
            voice,
            input: text,
            instructions,
            response_format: "pcm",
            stream_format: "audio",
          }),
          signal: controller.signal,
          redirect: "error",
        }),
        controller.signal,
      );
      if (!response.ok) {
        // Never read or echo the error body; it can quote the request.
        void response.body?.cancel().catch(() => {});
        throw new SpeechStop(`http_${Number(response.status) || 0}`);
      }
      reader = response.body?.getReader();
      if (!reader) throw new SpeechStop("empty");
      for (;;) {
        const { done, value } = await until(reader.read(), controller.signal);
        if (done) break;
        if (!value?.byteLength) continue;
        if (firstByte) {
          clearTimeout(firstByte);
          firstByte = undefined;
        }
        yield value;
      }
    } catch (error) {
      void reader?.cancel().catch(() => {});
      if (
        controller.signal.aborted &&
        controller.signal.reason instanceof SpeechStop
      )
        throw controller.signal.reason;
      throw error instanceof SpeechStop ? error : new SpeechStop("network");
    } finally {
      if (firstByte) clearTimeout(firstByte);
      signal.removeEventListener("abort", onAbort);
    }
  }

  /** The sentences that arrive within the system voice's collection window. */
  async function collectSentences(
    request: SpeakStreamRequest,
    signal: AbortSignal,
  ): Promise<string[]> {
    const texts: string[] = [];
    let chars = 0;
    const iterator = request.sentences[Symbol.asyncIterator]();
    let deadline: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      for (;;) {
        const nextItem = iterator.next();
        const raced = await Promise.race([
          until(nextItem, signal).then((r) => ({ r })),
          ...(deadline ? [deadline.then(() => ({ late: true as const }))] : []),
        ]);
        if ("late" in raced) break;
        if (raced.r.done) break;
        const text = speechText(raced.r.value);
        if (!text) continue;
        if (
          texts.length >= streamSpeech.maxSentences ||
          chars + text.length > streamSpeech.maxChars
        )
          break;
        chars += text.length;
        texts.push(text);
        try {
          request.onSentence?.(text);
        } catch {}
        deadline ??= new Promise<void>(
          (resolve) =>
            (timer = setTimeout(resolve, streamSpeech.systemCollectMs)),
        );
      }
    } catch {
      /* Cancelled or the reply stream failed: say what arrived. */
    } finally {
      clearTimeout(timer);
      try {
        void Promise.resolve(iterator.return?.()).catch(() => {});
      } catch {}
    }
    return signal.aborted ? [] : texts;
  }

  return {
    speak,
    speakStream,
    cancel() {
      cancelFlight("interrupted");
    },
    async stop() {
      cancelFlight("stopped");
      try {
        await deps.voiceCall("stopSpeaking");
      } catch {}
    },
    preview(text: string) {
      return speak({
        utteranceId: crypto.randomUUID(),
        text,
        priority: "urgent",
        style: "persona",
      });
    },
  };
}
