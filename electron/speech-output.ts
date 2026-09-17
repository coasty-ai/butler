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
export type FollowUpKind = "answer" | "approval" | "continuation";
export type SpeechEngine = "system" | "kokoro" | "openai";
export interface SpeakRequest {
  utteranceId: string;
  text: string;
  priority: SpeakPriority;
  listen?: { kind: FollowUpKind; seconds: number };
}
export interface SpeakResult {
  accepted: boolean;
  reason?: string;
  engine: SpeechEngine;
}
export interface SpeechOutput {
  speak(request: SpeakRequest): Promise<SpeakResult>;
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
};
export interface SpeechOutputDeps {
  settings: () => SpeechSettings;
  openaiKey: () => string;
  voiceCall: (method: string, data?: Record<string, unknown>) => Promise<any>;
  fetch: typeof fetch;
  /** The on-device Kokoro voice; without it "kokoro" speaks with the system voice. */
  kokoro?: Pick<KokoroVoice, "status" | "synthesize">;
  /** Defaults to kokoroSupported() from ./kokoro/client (Apple Silicon only). */
  kokoroSupported?: () => boolean;
  now?: () => number;
  trace?: (event: string, data: Record<string, unknown>) => void;
}

export const openaiSpeech = {
  url: "https://api.openai.com/v1/audio/speech",
  model: "gpt-4o-mini-tts",
  instructions:
    "Speak warmly and naturally, like a helpful friend. Keep a relaxed, conversational pace.",
  defaultVoice: "marin",
  sampleRate: 24000,
  /** 100 ms of 16-bit mono at 24 kHz. */
  chunkBytes: 9600,
  firstByteMs: 1200,
  deadlineMs: 15000,
} as const;
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
    kokoro: Pick<KokoroVoice, "synthesize">,
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
          .synthesize(request.text, signal)
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
              instructions: openaiSpeech.instructions,
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
        ? await local(request, deps.kokoro, mine, log)
        : await cloud(request, key, cloudVoice(settings.cloudVoice), mine, log);
    } finally {
      if (flight === mine) flight = undefined;
    }
  }

  return {
    speak,
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
      });
    },
  };
}
