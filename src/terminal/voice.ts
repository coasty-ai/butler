import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { NativeVoice, type VoiceEvent } from "../../electron/voice";
import type { Settings } from "../core/schema";
import { redactSecrets } from "../core/sanitize";
import { speakableText, splitSentences } from "../voice/speakable";
import { type VoiceSource, voiceIntent } from "../voice/turns";
import { voiceCommandConfidence } from "../voice/router";

export interface InstalledVoice {
  id: string;
  name: string;
  language: string;
}
type VoicePort = Pick<NativeVoice, "call" | "close">;
export interface SpokenInput {
  text: string;
  confidence: number;
  source: VoiceSource;
  segments: number;
  /** An Apple empty final recovered from a stable hypothesis; never approves. */
  recovered?: boolean;
}
interface Options {
  root: string;
  settings: () => Settings;
  receive: (input: SpokenInput) => void;
  notice: (message: string) => void;
  activity: (phase: "listening" | "speaking" | "idle") => void;
  create?: (receive: (event: VoiceEvent) => void) => VoicePort;
}

/** Resolve a name or identifier against the helper's installed voice inventory. */
export function installedVoice(voices: InstalledVoice[], requested: string) {
  const match = voices.find(
    (v) =>
      v.id === requested || v.name.toLowerCase() === requested.toLowerCase(),
  );
  return (
    match ||
    voices.find((v) => v.language === "en-GB" && v.name === "Daniel") ||
    voices.find((v) => v.language === "en-GB") ||
    voices.find((v) => v.language.startsWith("en")) ||
    voices[0]
  );
}

/** The native speaker limits each utterance to 1,000 characters. */
export function spokenChunks(text: string): string[] {
  const chunks: string[] = [];
  for (const sentence of splitSentences(redactSecrets(text))) {
    const safe = speakableText(sentence, 900);
    if (!safe) continue;
    const last = chunks.at(-1);
    if (last && last.length + safe.length + 1 <= 900)
      chunks[chunks.length - 1] = last + " " + safe;
    else chunks.push(safe);
  }
  return chunks;
}

/** Standalone macOS speech; no Electron, cloud audio, or application bundle. */
export class TerminalVoice {
  private helper?: VoicePort;
  private setup?: Promise<void>;
  private config = "";
  private inventory?: InstalledVoice[];
  private queue = Promise.resolve();
  private generation = 0;
  private input = false;
  private wakeUnavailable = false;
  private capturing = false;
  private source: VoiceSource = "wake";
  private closed = false;
  private pending?: { id: string; finish: (error?: Error) => void };
  constructor(private options: Options) {}
  get speaking() {
    return !!this.pending;
  }
  get listening() {
    return this.input;
  }
  get listeningToTurn() {
    return this.capturing;
  }
  private getHelper() {
    if (this.closed) throw new Error("Voice is closed.");
    if (!this.helper) {
      const receive = (event: VoiceEvent) => this.event(event);
      if (this.options.create) this.helper = this.options.create(receive);
      else {
        const launcher = join(this.options.root, "native/bin/coarena-launch");
        const binary = join(this.options.root, "native/bin/coarena-voice");
        if (!existsSync(launcher) || !existsSync(binary))
          throw new Error(
            "Voice helper is missing. Run npm run install:terminal.",
          );
        // The embedded usage descriptions and microphone grant belong to the
        // standalone helper, rather than whichever terminal hosts Node.
        this.helper = new NativeVoice(
          launcher,
          receive,
          undefined,
          {
            onRestart: () => {
              this.config = "";
              this.setup = undefined;
              this.pending?.finish(
                new Error("Voice helper restarted. Try again."),
              );
              void this.configure().catch(() =>
                this.options.notice(
                  "Voice helper could not restart. Use /listen on to retry.",
                ),
              );
            },
            onUnavailable: () => {
              this.input = false;
              this.capturing = false;
              this.pending?.finish(new Error("Voice helper is unavailable."));
              this.options.notice(
                "Voice helper is unavailable. Use /listen on to retry.",
              );
            },
          },
          ["--", binary],
        );
      }
    }
    return this.helper;
  }
  async voices(): Promise<InstalledVoice[]> {
    if (!this.inventory)
      this.inventory = (await this.getHelper().call("voices")).voices;
    return this.inventory!;
  }
  status() {
    return this.getHelper().call("status");
  }
  private async configure() {
    if (this.setup) await this.setup.catch(() => {});
    const s = this.options.settings();
    const voice = installedVoice(await this.voices(), s.voiceId);
    const config = {
      handsFree: this.input,
      locale: "en-US",
      voiceLocale: "en-GB",
      voiceId: voice?.id || "",
      voiceRate: s.voiceRate,
      speechEnabled: true,
      sounds: false,
      patience: s.listeningPatience,
      followUp: s.followUpListening,
      followUpWindow: s.followUpWindow,
    };
    const key = JSON.stringify(config);
    if (key === this.config) return;
    const setup = this.getHelper()
      .call("configure", config)
      .then(() => {
        this.config = key;
      });
    this.setup = setup;
    try {
      await setup;
    } finally {
      if (this.setup === setup) this.setup = undefined;
    }
  }
  async setListening(
    enabled: boolean,
    requestPermission = false,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    if (!enabled) {
      this.input = false;
      this.wakeUnavailable = false;
      this.capturing = false;
      if (this.helper) await this.configure();
      return this.helper ? this.status() : { handsFree: false };
    }
    let status = await this.status();
    if ((!status.microphone || !status.speech) && requestPermission) {
      const permission = this.getHelper().call("requestPermissions");
      status = await new Promise<any>((resolve, reject) => {
        const abort = () => {
          this.input = false;
          this.capturing = false;
          this.pending?.finish(new Error("Voice setup cancelled."));
          this.helper?.close();
          this.helper = undefined;
          this.config = "";
          this.setup = undefined;
          reject(new Error("Voice setup cancelled."));
        };
        signal?.addEventListener("abort", abort, { once: true });
        permission
          .then(resolve, reject)
          .finally(() => signal?.removeEventListener("abort", abort));
        if (signal?.aborted) abort();
      });
    }
    signal?.throwIfAborted();
    if (!status.microphone || !status.speech) {
      this.input = false;
      this.capturing = false;
      await this.configure().catch(() => {});
      throw new Error(
        "Voice input needs Microphone and Speech Recognition access. Use /listen on and approve Butler's voice helper in the macOS prompts.",
      );
    }
    if (!status.onDevice) {
      this.input = false;
      this.capturing = false;
      await this.configure().catch(() => {});
      throw new Error(
        "On-device English speech recognition is unavailable. Enable or download English dictation in macOS Keyboard settings, then retry /listen on.",
      );
    }
    this.input = true;
    try {
      await this.configure();
      await this.getHelper().call("enable");
      return await this.status();
    } catch (error) {
      this.input = false;
      await this.configure().catch(() => {});
      throw error;
    }
  }
  speak(text: string, force = false, followUp = true): Promise<void> {
    const generation = this.generation;
    const deliver = async () => {
      if (
        this.closed ||
        generation !== this.generation ||
        (!force && this.options.settings().voiceReplies === "off")
      )
        return;
      await this.configure();
      for (const chunk of spokenChunks(text)) {
        if (this.closed || generation !== this.generation) return;
        await this.utterance(chunk, followUp);
      }
    };
    const work = this.queue.then(deliver);
    this.queue = work.catch(() => {});
    return work;
  }
  private async utterance(text: string, followUp: boolean) {
    const id = randomUUID();
    await new Promise<void>((resolve, reject) => {
      let finished = false;
      const timer = setTimeout(
        () => {
          void this.getHelper()
            .call("stopSpeaking")
            .catch(() => {});
          finish(
            new Error(
              "Spoken delivery timed out. The readable copy is available.",
            ),
          );
        },
        Math.max(30_000, text.length * 120),
      );
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (this.pending?.id === id) this.pending = undefined;
        this.options.activity("idle");
        error ? reject(error) : resolve();
      };
      this.pending = { id, finish };
      void this.getHelper()
        .call("speak", {
          utteranceId: id,
          priority: "result",
          text,
          ...(this.input && followUp
            ? { listen: { kind: "continuation" } }
            : {}),
        })
        .then(
          (result) => {
            if (!result.accepted)
              finish(
                new Error(
                  "Speech could not play. Use /voice test to check the output.",
                ),
              );
          },
          () =>
            finish(
              new Error(
                "Spoken delivery failed. The readable copy is available.",
              ),
            ),
        );
    });
  }
  async interruptOutput() {
    this.generation++;
    this.pending?.finish();
    if (this.helper) await this.helper.call("stopSpeaking").catch(() => {});
  }
  flush() {
    return this.queue;
  }
  async endFollowUp() {
    if (this.helper) await this.helper.call("endFollowUp");
  }
  private event(event: VoiceEvent) {
    if (this.closed) return;
    if (event.utteranceId === this.pending?.id) {
      if (event.event === "speech_started") this.options.activity("speaking");
      if (event.event === "speech_finished") this.pending?.finish();
      if (event.event === "speech_error")
        this.pending?.finish(
          new Error("Spoken delivery failed. Use /voice test to retry."),
        );
    }
    if (!this.input) return;
    if (event.event === "wake_error") {
      this.capturing = false;
      if (!this.speaking) this.options.activity("idle");
      if (!this.wakeUnavailable)
        this.options.notice(
          "Wake listening is unavailable. Butler will retry automatically; /listen status checks it and /listen on retries setup.",
        );
      this.wakeUnavailable = true;
      return;
    }
    if (
      event.event === "wake_status" &&
      event.enabled === true &&
      event.listening === true &&
      this.wakeUnavailable
    ) {
      this.wakeUnavailable = false;
      this.options.notice("Wake listening has resumed.");
      return;
    }
    if (
      ["wake_detected", "followup_detected", "shortcut_down"].includes(
        event.event,
      )
    ) {
      this.source =
        event.event === "shortcut_down"
          ? "ptt"
          : event.event === "followup_detected"
            ? "followup"
            : "wake";
      this.capturing = true;
      this.options.activity("listening");
    }
    if (
      ["transcript_final", "transcript_recovered"].includes(event.event) &&
      this.capturing &&
      typeof event.text === "string"
    ) {
      this.capturing = false;
      this.options.activity("idle");
      const text = event.text.trim();
      const confidence = voiceCommandConfidence(event);
      const segments = event.segments ?? 1;
      const intent = voiceIntent(text);
      // Stop/pause can always halt input. Other speech must be finalized or
      // recovered from Apple's stable empty final, and clearly heard. It
      // never enters the typed command lane or approves a pending action.
      if (
        !text ||
        text.length > 8192 ||
        text.startsWith("/") ||
        ((confidence < 0.65 || segments !== 1) &&
          !["stop", "pause"].includes(intent.kind))
      ) {
        this.options.notice("I didn't catch that clearly. Please try again.");
        return;
      }
      this.options.receive({
        text,
        confidence,
        source: this.source,
        segments,
        ...(event.event === "transcript_recovered" ? { recovered: true } : {}),
      });
      return;
    }
    if (
      ["voice_cancelled", "voice_error", "transcript_unconfirmed"].includes(
        event.event,
      )
    ) {
      this.capturing = false;
      this.options.activity("idle");
      if (event.event !== "voice_cancelled")
        this.options.notice(
          "I didn't catch that clearly. Please try again, or use /listen status.",
        );
    }
  }
  close() {
    this.closed = true;
    this.input = false;
    this.generation++;
    this.pending?.finish();
    this.helper?.close();
  }
}
