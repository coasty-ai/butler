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
  /** speech_finished: barge_in, escape, replaced, cancel, sleep, disabled. standby_trace rotate: final, error, cadence. */
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
   * voice_processing, once per helper run (BUTLER_FULL_DUPLEX): echo cancellation on the
   * microphone, with the input format it gives the recognizer, or `enabled: false` with
   * `reason` (off, unsupported, start_failed, format). standby_trace level and begin carry
   * `voiceProcessing` too, beside the RMS scale it changes.
   */
  sampleRate?: number;
  channels?: number;
  voiceProcessing?: boolean;
  quietMs?: number;
  completeness?: string;
  patience?: string;
  noiseFloor?: number;
  threshold?: number;
}
export class NativeVoice {
  private helper: HelperProcess;
  constructor(
    binary: string,
    receive: (event: VoiceEvent) => void,
    private diagnostics?: DiagnosticSink,
    hooks: HelperHooks = {},
  ) {
    this.helper = new HelperProcess(binary, {
      name: "Voice",
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
