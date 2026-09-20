import {
  errorDetails,
  trace,
  type DiagnosticSink,
} from "../src/core/diagnostics";
import { HelperProcess, type HelperHooks } from "./controller";
export interface VoiceEvent {
  event: string;
  text?: string;
  message?: string;
  confidence?: number;
  level?: number;
  command?: string;
  enabled?: boolean;
  listening?: boolean;
  textLength?: number;
  source?: string;
  /** speech_started / speech_finished / speech_error. */
  utteranceId?: string;
  interrupted?: boolean;
  /** speech_finished: barge_in, escape, replaced, cancel, sleep, disabled. standby_trace rotate: final, error, cadence, vocabulary. */
  reason?: string;
  /** followup_open / followup_detected / followup_closed: the window kind. */
  kind?: string;
  seconds?: number;
  /** voice_error: empty, unfinalized, mic, permission, asleep, unavailable. */
  code?: string;
  /** transcript_final / turn_endpoint: recognizer segments in the turn. */
  segments?: number;
  /** endpoint_near. */
  remainingMs?: number;
  /** turn_endpoint (content-free) and followup_closed. */
  endReason?: string;
  stableMs?: number;
  /**
   * transcript_recovered (empty_final_after_endpoint): the word mean of the
   * last partial's segment confidences, 0 when the recognizer gave none.
   */
  partialConfidence?: number;
  /** standby_trace (BUTLER_TRACE_STANDBY, local trials only). */
  sinceStartMs?: number;
  buffers?: number;
  rms?: number;
  engine?: boolean;
  boundary?: number;
  /** standby_trace: the first words of a hypothesis that opened like a wake attempt. */
  wakeHead?: string;
  preRollMs?: number;
  /**
   * voice_processing (BUTLER_FULL_DUPLEX): echo cancellation on the microphone, with the
   * input format the tap gets, the channel of it the recognizer reads and that channel's
   * level (RMS x 1000) over the first 200 ms; or `enabled: false` with `reason` (off,
   * unsupported, start_failed, format, silent: an enabled report is followed by this one
   * when the processed input stayed at exactly 0 for 3 s). standby_trace level and begin
   * carry `voiceProcessing` too, beside the RMS scale it changes; begin carries the input's
   * channel count and the channel read.
   */
  sampleRate?: number;
  channels?: number;
  interleaved?: boolean;
  micChannel?: number;
  micLevel?: number;
  voiceProcessing?: boolean;
  quietMs?: number;
  completeness?: string;
  patience?: string;
  noiseFloor?: number;
  threshold?: number;
  /** vocabulary: how many phrases the recognizer is now biased toward (never the words). */
  count?: number;
}
/**
 * The recognizer port (.data/design/modules.md §2, §3): the voice helper is
 * a protocol, not a tool, and settings.modules.recognizer of kind "command"
 * spawns that command with its args in place of native/bin/coarena-voice
 * (electron/main.ts getVoice). The protocol, in one paragraph (lane MOD3's
 * docs/RECOGNIZER_PROTOCOL.md has the full account from Voice.swift): JSON
 * lines both ways over stdio. A request is one line `{"id", "method",
 * ...params}` and is answered by one line `{"id", "result"}` or `{"id",
 * "error"}`; the methods main asks are status, configure (the settings the
 * helper needs: hands-free, the wake phrase, patience, sounds, voice),
 * enable, requestPermissions (the command owns its own microphone and speech
 * grants and may take up to 120 s here), cancel, speak, playPcmStart /
 * playPcmChunk / playPcmEnd / playPcmAbort (a 16-bit PCM utterance in
 * base64 chunks), stopSpeaking, listen, endFollowUp, voices and vocabulary.
 * Events are unsolicited lines `{"event", ...}`: shortcut_down / shortcut_up /
 * shortcut_tap, wake_detected, listening_ready, transcript_partial {text},
 * transcript_final {text, confidence, segments}, transcript_unconfirmed,
 * transcript_recovered, turn_endpoint {endReason}, endpoint_near
 * {remainingMs}, voice_cancelled, voice_error {message, code}, wake_status
 * {enabled, listening}, audio_level {level}, speech_started /
 * speech_finished / speech_error {utteranceId}, followup_open /
 * followup_detected / followup_closed {kind}, and vocabulary {count}. Every
 * field VoiceEvent lists is one main reads; text is never traced.
 */
export class NativeVoice {
  private helper: HelperProcess;
  constructor(
    binary: string,
    receive: (event: VoiceEvent) => void,
    private diagnostics?: DiagnosticSink,
    hooks: HelperHooks = {},
    /** The replacement command's arguments; the app's own helper takes none. */
    args: string[] = [],
  ) {
    this.helper = new HelperProcess(binary, {
      name: "Voice",
      args,
      diagnostics,
      hooks,
      restarting: "Voice helper restarted. Try again.",
      exhausted: "Voice helper is unavailable.",
      closed: "Voice helper is unavailable.",
      error: (data) =>
        new Error(
          typeof data.error === "string" && data.error
            ? data.error
            : "Voice helper failed.",
        ),
      event: (data) => {
        if (typeof data.event !== "string") return false;
        receive(data);
        return true;
      },
    });
  }
  get pid() {
    return this.helper.pid;
  }
  call(method: string, data: Record<string, unknown> = {}): Promise<any> {
    const id = crypto.randomUUID();
    const started = performance.now();
    // The permission prompt legitimately waits for the user; anything else
    // that stalls means the helper's main thread is stuck, so restart it.
    const permission = method === "requestPermissions";
    return this.helper
      .send(
        method,
        data,
        permission ? 120000 : 5000,
        permission
          ? {
              message: "Voice setup is waiting for macOS permission.",
              kill: false,
            }
          : { message: "Voice helper did not respond.", kill: true },
      )
      .then(
        (result) => {
          trace(this.diagnostics, "VoiceResponse", {
            requestId: id,
            method,
            durationMs: Math.round(performance.now() - started),
          });
          return result;
        },
        (error) => {
          trace(this.diagnostics, "VoiceError", {
            requestId: id,
            method,
            durationMs: Math.round(performance.now() - started),
            ...errorDetails(error),
          });
          throw error;
        },
      );
  }
  close() {
    this.helper.close();
  }
}
/** How to continue a paused run with the current voice mode. */
export function continueHint(handsFree: boolean) {
  return handsFree ? "Say ‘continue’ or ‘stop’." : "Hold ⌥ Space to continue.";
}
/** How to answer a pending approval with the current voice mode. */
export function approvalHint(handsFree: boolean) {
  return handsFree
    ? "Say “yes” or “no”, or click."
    : "Hold ⌥ Space and say “yes”, or click once.";
}
/**
 * The paused pill label for an interruption that produced no usable command:
 * "Didn’t catch that. Try again." becomes "Paused — didn’t catch that."
 */
export function pausedLabel(message: string) {
  let reason = message
    .trim()
    .replace(/\s*Try again\.?$/i, "")
    .trim();
  if (!reason) return "Paused.";
  // Keep acronyms ("API key…") and proper casing beyond the first word.
  if (!/^[A-Z]{2}/.test(reason))
    reason = reason[0].toLowerCase() + reason.slice(1);
  if (!/[.!?…]$/.test(reason)) reason += ".";
  return `Paused — ${reason}`;
}
