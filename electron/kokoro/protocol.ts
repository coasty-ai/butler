/**
 * Messages between the main-process Kokoro client and its utilityProcess
 * worker. Content-free except the text to synthesize, which only flows
 * main -> worker. PCM travels as an ArrayBuffer of s16le samples: transferred
 * where the transport allows it (worker_threads), otherwise one structured
 * clone per sentence (Electron parentPort, child_process "advanced").
 */
import type { KokoroPaths, KokoroVoiceId } from "./manifest";

export type KokoroErrorCode =
  | "not_installed"
  | "runtime_unavailable"
  | "files_missing"
  | "load_failed"
  | "load_timeout"
  | "model_mismatch"
  | "synthesis_failed"
  | "worker_crashed"
  | "worker_stalled"
  | "worker_unavailable"
  | "disposed"
  | "removed"
  | "network"
  | "checksum_mismatch"
  | "size_mismatch"
  | "disk_full"
  | `http_${number}`;

export type KokoroWorkerRequest =
  | {
      type: "init";
      paths: KokoroPaths;
      threads: number;
      /** Loaded before `ready` so the first sentence is not slower. */
      voice?: KokoroVoiceId;
    }
  | {
      type: "synthesize";
      id: number;
      text: string;
      voice: KokoroVoiceId;
      /** Already clamped by the client; the worker clamps again. */
      speed: number;
    }
  | { type: "cancel"; id: number };

export type KokoroWorkerResponse =
  | { type: "ready"; loadMs: number }
  | {
      type: "chunk";
      id: number;
      seq: number;
      sampleRate: number;
      pcm: ArrayBuffer;
      synthMs: number;
    }
  | {
      type: "done";
      id: number;
      chunks: number;
      cancelled: boolean;
      synthMs: number;
      audioMs: number;
      fallbackWords: number;
    }
  | { type: "error"; id?: number; code: KokoroErrorCode };
