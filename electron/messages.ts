/**
 * The iMessage channel: bounded updates out, a strict command vocabulary in.
 *
 * Off by default. When the owner turns it on and stores their own handle in
 * the encrypted config, Open Assist texts that one handle about the moments of
 * a run and reads replies from it as commands. Approvals never happen here:
 * they stay on the Mac, where the pill and the screen are.
 *
 * Everything the native helper cannot decide alone is decided here, and the
 * row rules that matter (handle, freshness, service) are re-checked against
 * native/macos/MessageSafety.swift so both sides refuse the same things. The
 * command vocabulary and the rate limits live only here. The wire contract is
 * tests/fixtures/messages-poll.json, which both test suites read.
 */
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { parseEnv } from "node:util";
import type { Settings, Snapshot } from "../src/core/schema";
import { scanText } from "../src/core/sanitize";
import {
  speakableApproval,
  speakableSummary,
  speakableText,
} from "../src/voice/speakable";
import { momentKey } from "./conversation";
import type { ProgressReport } from "../src/assistant/types";
import { textable } from "../src/assistant/progress";
import { terminal } from "../src/core/runner";
import { HelperProcess, type HelperHooks } from "./controller";
import {
  errorDetails,
  trace,
  type DiagnosticSink,
} from "../src/core/diagnostics";

/** How often the Messages database is read while the channel is listening. */
export const MESSAGE_POLL_MS = 4000;
/** Longest outgoing text. Updates are one short line, never a transcript. */
export const MESSAGE_MAX_SEND = 300;
/** Longest incoming message considered at all (matches the typed limit). */
export const MESSAGE_MAX_TEXT = 2000;
/** Updates per run, so a stuck loop cannot text somebody forty times. */
export const MESSAGE_RUN_LIMIT = 8;
/**
 * Progress updates per run, apart from the moments: the reporter paces them
 * (every few active minutes at most) and the hourly cap bounds the total,
 * and a busy run must still get its approval or takeover moment out.
 */
export const MESSAGE_PROGRESS_LIMIT = 40;
/** Outgoing texts per hour across every run and reply. */
export const MESSAGE_HOUR_LIMIT = 20;
/** A command older than this never runs: late sync is not consent. */
export const MESSAGE_MAX_AGE_MS = 300000;
/** The one-line answer to anything outside the vocabulary. */
export const MESSAGE_VOCABULARY =
  "I only understand: status, stop, pause, continue, or “do <task>”. Approvals stay on the Mac.";
/** The answer to “yes”, “no” and friends. */
export const MESSAGE_APPROVAL_REPLY =
  "I can’t approve anything by text. Approve or decline on the Mac.";

// MARK: handles

/**
 * Canonical handle: "user@example.com" for an address, the E.164 digits for a
 * number. "" when the value cannot be a handle, which includes a number
 * without its country code. Mirrors normalizeMessageHandle in
 * MessageSafety.swift.
 */
export function normalizeHandle(raw: string): string {
  const trimmed = (raw ?? "").trim().toLowerCase();
  if (!trimmed || trimmed.length > 100) return "";
  if (trimmed.includes("@")) {
    const parts = trimmed.split("@");
    if (parts.length !== 2 || !parts[0] || /[\s"\\]/.test(trimmed)) return "";
    const domain = parts[1];
    if (!domain.includes(".") || domain.startsWith(".") || domain.endsWith("."))
      return "";
    return trimmed;
  }
  // A number must carry its country code. A national number is somebody
  // else in another country: "8123456789" saved in India is not the US number
  // +1 812 345 6789, yet the digits agree. Messages stores senders in E.164.
  let body = trimmed.startsWith("tel:") ? trimmed.slice(4) : trimmed;
  if (body.startsWith("00")) body = "+" + body.slice(2);
  if (!/^\+[()\-. \u00a00-9]+$/.test(body)) return "";
  const digits = body.replace(/\D/g, "");
  if (digits.length < 5 || digits.length > 16) return "";
  return digits;
}

/**
 * Same person: the same address, or the same number with its country code.
 * Nothing is fuzzy.
 */
export function handlesMatch(a: string, b: string): boolean {
  const left = normalizeHandle(a);
  return !!left && left === normalizeHandle(b);
}

/**
 * How far a row's delivery service is trusted. Only iMessage authenticates the
 * sender (Apple ties it to the account); an SMS or RCS caller ID can be
 * spoofed, so those never act, even from the owner's number. The helper
 * already drops them; this is the second check. "" means the database has no
 * service column at all: the sender cannot be vouched for, so such a row may
 * only ask for "status", which changes nothing and is texted to the owner's
 * own handle anyway.
 */
export function messageServiceTrust(
  service: string,
): "full" | "status" | "none" {
  if (service === "iMessage") return "full";
  return service === "" ? "status" : "none";
}

// MARK: vocabulary

export type MessageCommandKind =
  | "status"
  | "stop"
  | "pause"
  | "resume"
  | "start"
  | "approval"
  | "unknown"
  | "empty"
  | "too_long";
export interface MessageCommand {
  kind: MessageCommandKind;
  task: string;
}
const APPROVAL_WORDS = new Set([
  "yes",
  "y",
  "yeah",
  "yep",
  "no",
  "n",
  "nope",
  "ok",
  "okay",
  "approve",
  "approved",
  "allow",
  "deny",
  "decline",
  "confirm",
  "cancel it",
]);
/** Collapses whitespace, drops control characters, bounds the length. */
export function normalizeMessageText(raw: string): string {
  const text = (raw ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > MESSAGE_MAX_TEXT
    ? text.slice(0, MESSAGE_MAX_TEXT + 1)
    : text;
}
/**
 * The strict vocabulary: status, stop, pause, continue (or resume) alone, and
 * "do <task>". Everything else is unknown and earns at most one line back.
 */
export function parseMessageCommand(raw: string): MessageCommand {
  const text = normalizeMessageText(raw);
  if (!text) return { kind: "empty", task: "" };
  if (text.length > MESSAGE_MAX_TEXT) return { kind: "too_long", task: "" };
  const bare = text.replace(/^[.!?,;:…\s]+|[.!?,;:…\s]+$/g, "").toLowerCase();
  if (bare === "status") return { kind: "status", task: "" };
  if (bare === "stop") return { kind: "stop", task: "" };
  if (bare === "pause") return { kind: "pause", task: "" };
  if (bare === "continue" || bare === "resume")
    return { kind: "resume", task: "" };
  if (APPROVAL_WORDS.has(bare)) return { kind: "approval", task: "" };
  const head = text.split(" ")[0].toLowerCase();
  if (head === "do" || head === "do:") {
    const task = text
      .slice(head.length)
      .replace(/^[\s:]+/, "")
      .trim();
    if (task) return { kind: "start", task };
  }
  return { kind: "unknown", task: "" };
}

// MARK: rate limits

export interface MessageRateLimits {
  perWindow: number;
  windowMs: number;
  unknownLimit: number;
  unknownWindowMs: number;
  cooldownMs: number;
}
export const defaultRateLimits: MessageRateLimits = {
  perWindow: 6,
  windowMs: 60000,
  unknownLimit: 3,
  unknownWindowMs: 300000,
  cooldownMs: 600000,
};
/**
 * Sliding-window admission plus an unknown-command cooldown, so a confused or
 * automated sender cannot start a text ping-pong.
 */
export class MessageRate {
  private accepted: number[] = [];
  private unknowns: number[] = [];
  private throttleReplyAt?: number;
  private cooldownUntil = 0;
  constructor(private limits: MessageRateLimits = defaultRateLimits) {}
  /** Whether a command runs, and whether the one throttle reply is due. */
  admit(now: number): { accepted: boolean; reply: boolean } {
    this.accepted = this.accepted.filter((t) => now - t < this.limits.windowMs);
    if (this.accepted.length >= this.limits.perWindow) {
      const replied =
        this.throttleReplyAt !== undefined &&
        now - this.throttleReplyAt < this.limits.windowMs;
      if (!replied) this.throttleReplyAt = now;
      return { accepted: false, reply: !replied };
    }
    this.accepted.push(now);
    return { accepted: true, reply: false };
  }
  /** Whether an unknown command earns its one-line reply. */
  answerUnknown(now: number): boolean {
    if (now < this.cooldownUntil) return false;
    this.unknowns = this.unknowns.filter(
      (t) => now - t < this.limits.unknownWindowMs,
    );
    this.unknowns.push(now);
    if (this.unknowns.length >= this.limits.unknownLimit) {
      this.cooldownUntil = now + this.limits.cooldownMs;
      this.unknowns = [];
    }
    return true;
  }
}

// MARK: settings

/** The settings keys this channel reads. */
export type MessageSettings = Pick<
  Settings,
  "messages" | "messagesHandle" | "messagesCommands" | "messagesUpdates"
>;
/**
 * Rejects a settings save that would enable texting without a usable handle.
 * main.ts calls this in saveSettings, beside validateProviderEndpoint.
 */
export function validateMessageSettings(s: MessageSettings): void {
  if (!s.messages) return;
  if (normalizeHandle(s.messagesHandle)) return;
  // Digits without a leading "+": a number missing its country code.
  if (
    /^(tel:)?[()\-. \u00a00-9]*[0-9][()\-. \u00a00-9]*$/i.test(
      s.messagesHandle.trim(),
    )
  )
    throw new Error(
      "Add the country code to your number, for example +1 555 123 4567.",
    );
  throw new Error(
    "Add the phone number or iMessage address to text before turning messages on.",
  );
}
/** The live view of the settings, or undefined when the channel is off. */
export function messageTarget(s: MessageSettings):
  | {
      handle: string;
      commands: boolean;
      updates: Settings["messagesUpdates"];
    }
  | undefined {
  if (!s.messages) return undefined;
  const handle = normalizeHandle(s.messagesHandle);
  if (!handle) return undefined;
  return {
    handle: s.messagesHandle.trim(),
    commands: s.messagesCommands,
    updates: s.messagesUpdates,
  };
}

/**
 * Reads PHONE_NO from an already trusted .env file, the same convenience as
 * the provider keys: an import, never a runtime source. The value is stored in
 * the encrypted config and the channel still has to be switched on by hand.
 * Returns "" when the file has no usable number.
 */
export function importEnvHandle(file: string): string {
  try {
    if (!isAbsolute(file)) return "";
    const info = statSync(file);
    if (!info.isFile() || info.size > 64 * 1024) return "";
    const env = parseEnv(readFileSync(file, "utf8"));
    for (const name of ["PHONE_NO", "PHONE_NUMBER", "IMESSAGE_HANDLE"]) {
      const value = env[name];
      if (typeof value === "string" && normalizeHandle(value))
        return value.trim();
    }
    return "";
  } catch {
    // Never echo file contents, including a malformed line.
    return "";
  }
}

// MARK: run moments

/** A short, bounded line for one run moment, or undefined for nothing to say. */
export interface MessageMoment {
  key: string;
  text: string;
}
function bounded(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > MESSAGE_MAX_SEND
    ? clean.slice(0, MESSAGE_MAX_SEND - 1).trimEnd() + "…"
    : clean;
}
/** The task, short and never with credentials in it. */
export function taskLine(task: string): string {
  const safe = speakableText(task, 120)?.replace(/[.!?]+$/, "");
  return safe ? `“${safe}”` : "a task";
}
/**
 * What to text about this snapshot. The dedupe key is the spoken-reply moment
 * key, so texts and speech agree on what counts as one moment. Narration
 * ("Opening Spotify.") is deliberately not texted.
 */
export function messageMoment(
  s: Snapshot,
  started: boolean,
): MessageMoment | undefined {
  const run = s.run;
  if (!run) return undefined;
  if (started)
    return {
      key: `started:${run.id}`,
      text: bounded(`Started ${taskLine(run.task)}.`),
    };
  const key = momentKey(s);
  if (!key || key.startsWith("narrate:")) return undefined;
  switch (run.status) {
    case "confirming": {
      const reason = s.pending ? speakableApproval(s.pending) : undefined;
      return {
        key,
        text: bounded(
          `${reason ?? "It needs your approval to continue."} I can’t approve by text — approve on the Mac.`,
        ),
      };
    }
    case "takeover":
      return {
        key,
        text: bounded(
          `${speakableText(s.message) ?? "It needs you at the Mac."} It is waiting for you.`,
        ),
      };
    case "paused":
      return {
        key,
        text: bounded(`Paused. ${speakableText(s.message) ?? "It needs you."}`),
      };
    case "completed":
      return {
        key,
        text: bounded(
          `Done. ${speakableSummary(run.summary || s.message) ?? "The task finished."}`,
        ),
      };
    case "failed":
      return {
        key,
        text: bounded(
          `Couldn’t finish. ${speakableText(s.message) ?? "It stopped early."}`,
        ),
      };
    case "cancelled":
      return {
        key,
        text: bounded(`Stopped. ${speakableText(s.message) ?? ""}`),
      };
  }
  return undefined;
}
/** The reply to "status": what the Mac is doing right now. */
export function statusLine(s: Snapshot | undefined): string {
  const run = s?.run;
  if (!run || ["completed", "cancelled", "failed"].includes(run.status)) {
    if (!run) return "Nothing is running.";
    const ending =
      run.status === "completed"
        ? (speakableSummary(run.summary) ?? "the last task finished")
        : run.status === "cancelled"
          ? "the last task was stopped"
          : "the last task didn’t finish";
    return bounded(`Nothing is running — ${ending.replace(/[.!?]+$/, "")}.`);
  }
  if (run.status === "confirming")
    return "Waiting for your approval on the Mac.";
  if (run.status === "paused" || run.status === "takeover")
    return bounded(
      `Paused on ${taskLine(run.task)}. ${speakableText(s!.message) ?? ""}`,
    );
  return bounded(
    `Working on ${taskLine(run.task)} — ${run.actions} step${run.actions === 1 ? "" : "s"} so far.`,
  );
}
/**
 * The reply to "continue" when nothing resumed, from the live state. An
 * approval is not a pause, and "continue" by text never approves.
 */
export function notResumedLine(s: Snapshot | undefined): string {
  const status = s?.run?.status;
  if (!status || ["completed", "cancelled", "failed"].includes(status))
    return "Nothing is running.";
  if (status === "confirming")
    return "It’s waiting for your approval on the Mac, not paused. Approve or decline it there.";
  if (status === "paused" || status === "takeover")
    return "It’s still paused: something changed on the Mac. Text “status” to check.";
  return "It’s already working.";
}

// MARK: the native helper

export interface MessagesHelper {
  call(method: string, data?: Record<string, unknown>): Promise<any>;
  close(): void;
}
/** Codes the Swift helper reports; the UI turns them into setup guidance. */
export type MessagesAutomation =
  "granted" | "denied" | "ask" | "messages_closed" | "unknown" | "unavailable";
export type MessagesDatabaseState =
  | "ok"
  | "no_access"
  | "locked"
  | "missing"
  | "unsupported"
  | "unopened"
  | "off";
export interface MessagesStatus {
  /** The setting is on and the handle is usable. */
  enabled: boolean;
  /** A handle is stored (whether or not the channel is on). */
  configured: boolean;
  /** Reading replies is allowed by the user's settings. */
  commands: boolean;
  updates: Settings["messagesUpdates"];
  automation: MessagesAutomation;
  database: MessagesDatabaseState;
  /** The poller is running. */
  listening: boolean;
  /** Last readable failure, for Settings. Never message content. */
  error?: string;
}
const offStatus = (s: MessageSettings): MessagesStatus => ({
  enabled: false,
  configured: !!normalizeHandle(s.messagesHandle),
  commands: s.messagesCommands,
  updates: s.messagesUpdates,
  automation: "unknown",
  database: "off",
  listening: false,
});
/**
 * Classifies an unsolicited helper line. The only one is the content-free
 * {"event":"changed"} hint (chat.db or its WAL was written); any other event
 * is swallowed rather than mistaken for a reply.
 */
export function helperEvent(line: unknown): "changed" | "other" | undefined {
  if (!line || typeof line !== "object" || !("event" in line)) return undefined;
  return (line as { event: unknown }).event === "changed" ? "changed" : "other";
}
/** The coarena-messages helper as a restartable JSON-lines process. */
export function createMessagesHelper(
  binary: string,
  options: {
    diagnostics?: DiagnosticSink;
    hooks?: HelperHooks;
    /**
     * The database changed: poll now rather than on the next tick. Required,
     * so a caller that forgets it does not compile: the poll timer would hide
     * the loss, and texts would wait up to 4 s again.
     */
    onChanged: () => void;
  },
): MessagesHelper {
  const helper = new HelperProcess(binary, {
    name: "Messages",
    diagnostics: options.diagnostics,
    hooks: options.hooks ?? {},
    restarting: "The Messages helper restarted. Try again.",
    exhausted: "The Messages helper is unavailable.",
    closed: "The Messages helper is unavailable.",
    error: (data) => {
      const error = new Error(
        typeof data.error === "string" && data.error
          ? data.error
          : "The Messages helper failed.",
      );
      if (typeof data.code === "string")
        (error as Error & { code?: string }).code = data.code;
      return error;
    },
    // Unprompted, the helper only ever says "look again".
    event: (line) => {
      const kind = helperEvent(line);
      if (kind === "changed") options.onChanged();
      return kind !== undefined;
    },
  });
  return {
    call: (method, data = {}) =>
      helper.send(
        method,
        data,
        // A first send opens the macOS Automation prompt and waits for the
        // user; nothing else may block the helper for more than a moment.
        method === "send" ? 120000 : 8000,
        method === "send"
          ? { message: "Messages did not answer.", kill: false }
          : { message: "The Messages helper did not respond.", kill: true },
      ),
    close: () => helper.close(),
  };
}

/**
 * What a texted "continue" does in main: resume only a held run, and report
 * true only when the resume itself says the run is going again. An approval
 * waiting on the Mac is not held, so it is never touched.
 */
export async function resumeFromText(
  held: () => boolean,
  resumeHeld: (held: () => boolean) => Promise<boolean>,
): Promise<boolean> {
  if (!held()) return false;
  return (await resumeHeld(held)) === true;
}

export interface MessagesChannelOptions {
  settings: () => MessageSettings;
  /**
   * Created lazily, only once the channel is switched on. `onChanged` is the
   * helper's "changed" hint; the channel answers it with an immediate poll.
   */
  helper: (onChanged: () => void) => MessagesHelper;
  /**
   * Starts a task the way a typed command does, including the pill. Rejects
   * with a readable message (for example when a run is already active).
   */
  startTask: (task: string) => Promise<void>;
  control: {
    pause: () => void;
    stop: () => void;
    /** True only when a held run actually resumed (see resumeFromText). */
    resume: () => Promise<boolean>;
  };
  now?: () => number;
  trace?: DiagnosticSink;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Owns the conversation with one handle: schedules polls, decides which run
 * moments are worth a text, answers commands and keeps every limit.
 */
export class MessagesChannel {
  private helper?: MessagesHelper;
  private timer?: unknown;
  private lastRowId = 0;
  /**
   * The handle and watch flag the helper was last configured with, set only
   * once that configure read the database: until then there is no baseline
   * row and nothing is polled.
   */
  private baseline = "";
  private configuring?: { key: string; done: Promise<any> };
  private polling = false;
  /** A "changed" hint arrived mid-poll: poll once more when it ends. */
  private again = false;
  /** Texts go out one at a time, in order, and nothing waits for them. */
  private outbox: Promise<void> = Promise.resolve();
  /** Quitting: a text still in line must not spawn a fresh helper. */
  private closed = false;
  private snapshot?: Snapshot;
  private sentKeys: string[] = [];
  private runCounts = new Map<string, number>();
  private progressCounts = new Map<string, number>();
  private textedRuns = new Set<string>();
  private announced = new Set<string>();
  private pendingStart?: { at: number; task: string };
  private outgoing: number[] = [];
  private rate = new MessageRate();
  private state: MessagesStatus;
  private readonly now: () => number;
  constructor(private options: MessagesChannelOptions) {
    this.now = options.now ?? Date.now;
    this.state = offStatus(options.settings());
  }
  /** The cached state for AppInfo; never spawns the helper. */
  status(): MessagesStatus {
    return { ...this.state };
  }
  /**
   * Progress updates from the shared reporter. The reporter decided who gets
   * this one (`send`: a run the owner started by text, every run under
   * "all", and under "away" every run once the Mac has been left alone for
   * two minutes with no agent input for one, see src/assistant/progress.ts).
   * This side keeps the channel's own rules: a per-run cap of its own next
   * to the moments' (so updates never use up the approval or takeover
   * moment an away owner is waiting for), the hourly cap, the sentence
   * filter again, one text per kind and set of facts, and a run that got a
   * texted update is joined, so its ending is texted too. A final recap
   * follows the done moment, which emit() texts first, and carries its own
   * outcome: by the time it arrives the next queued run may be the one on
   * screen. A live run's needs-you report is the run's own moment instead,
   * worded here by messageMoment.
   */
  onProgress(r: ProgressReport): void {
    const target = messageTarget(this.options.settings());
    if (!target || !r.send) return;
    const live = this.snapshot?.run;
    if (
      r.kind === "needs_you" &&
      live?.id === r.runId &&
      !terminal(live.status)
    ) {
      // A joined run had the hold texted from its snapshot already; a run
      // started at the desk under "away" is joined now and hears it once.
      const joined = target.updates === "all" || this.textedRuns.has(r.runId);
      this.join(r.runId);
      if (!joined) this.sendMoment(this.snapshot!, false);
      return;
    }
    const key = `progress:${r.runId}:${r.kind}:${r.seq}`;
    if (this.sentKeys.includes(key)) return;
    let prefix = "";
    let moment: string | undefined;
    if (r.kind === "final") {
      const failed = r.outcome === "failed";
      moment = `${failed ? "failed" : "done"}:${r.runId}`;
      prefix = this.sentKeys.includes(moment)
        ? "Recap: "
        : failed
          ? "Couldn’t finish. "
          : "Done. ";
    }
    const reason = `progress:${r.kind}`;
    // Bounded apart from the prefix, so a four-sentence recap keeps its four.
    const safe = textable(r.text, MESSAGE_MAX_SEND - prefix.length, 4);
    if (!safe) {
      this.trace("MessageDropped", { reason, cause: "filtered" });
      return;
    }
    const count = this.progressCounts.get(r.runId) ?? 0;
    // The recap is the run's last word; everything else shares the cap.
    if (r.kind !== "final" && count >= MESSAGE_PROGRESS_LIMIT) {
      this.trace("MessageDropped", { reason, cause: "progress_limit" });
      return;
    }
    this.join(r.runId);
    this.remember(key);
    if (moment && prefix !== "Recap: ") this.remember(moment);
    this.progressCounts.set(r.runId, count + 1);
    this.send(prefix + safe, reason);
  }
  /**
   * Joined: a live run whose moments are texted from here on, and whose
   * terminal snapshot is its ending, not a run loaded from history
   * (onSnapshot's first-and-terminal rule).
   */
  private join(runId: string) {
    this.textedRuns.add(runId);
    this.announced.add(runId);
  }
  /**
   * Applies the saved settings: configures the helper, rebaselines the row
   * cursor and starts or stops polling. Rejects with a readable message; the
   * settings are still saved, the channel simply reports why it is not live.
   */
  async configure(): Promise<void> {
    const settings = this.options.settings();
    const target = messageTarget(settings);
    if (!target) {
      this.stopPolling();
      this.helper?.close();
      this.helper = undefined;
      this.baseline = "";
      this.state = offStatus(settings);
      return;
    }
    try {
      const result =
        (await this.ensureConfigured(target)) ??
        (await this.use().call("status"));
      this.state = {
        ...this.state,
        enabled: true,
        configured: true,
        commands: target.commands,
        updates: target.updates,
        automation: automationOf(result?.automation),
        database: databaseOf(result?.database),
        error: undefined,
      };
      if (target.commands) this.startPolling();
      else this.stopPolling();
    } catch (error) {
      this.stopPolling();
      this.state = {
        ...offStatus(settings),
        enabled: true,
        configured: true,
        error: readable(error),
      };
      throw new Error(readable(error));
    }
  }
  /** Call from emit(): decides whether this run moment is worth a text. */
  onSnapshot(s: Snapshot): void {
    this.snapshot = s;
    const run = s.run;
    if (!run) return;
    this.prune();
    const ended = terminal(run.status);
    // A run that appears just after a texted "do" belongs to that text.
    if (
      this.pendingStart &&
      !ended &&
      !this.announced.has(run.id) &&
      this.now() - this.pendingStart.at < 15000
    ) {
      this.textedRuns.add(run.id);
      this.pendingStart = undefined;
    }
    const target = messageTarget(this.options.settings());
    if (!target) return;
    // "away" adds updates once the user has left the Mac: the reporter's
    // first progress text joins the run (onProgress) and its later moments
    // follow here; until then it texts the same runs as "texted".
    if (target.updates !== "all" && !this.textedRuns.has(run.id)) return;
    const first = !this.announced.has(run.id);
    if (first) this.announced.add(run.id);
    if (first && ended) return; // A run loaded from history, not a new one.
    this.sendMoment(s, first);
  }
  /** Texts the snapshot's moment, once, within the run's moment cap. */
  private sendMoment(s: Snapshot, first: boolean) {
    const run = s.run!;
    const moment = messageMoment(s, first);
    if (!moment || this.sentKeys.includes(moment.key)) return;
    const count = this.runCounts.get(run.id) ?? 0;
    if (count >= MESSAGE_RUN_LIMIT) return;
    this.remember(moment.key);
    this.runCounts.set(run.id, count + 1);
    this.send(moment.text, `moment:${run.status}`);
  }
  /**
   * The helper saw chat.db change: poll now instead of on the next tick. A
   * hint during a poll earns exactly one more poll after it, so a burst of
   * hints never stacks up requests. The timer keeps running as the fallback.
   */
  kick(): void {
    if (!this.state.listening) return;
    if (this.polling) {
      this.again = true;
      return;
    }
    void this.pollOnce();
  }
  /** Resolves once every text queued so far has been handed to the helper. */
  settled(): Promise<void> {
    return this.outbox;
  }
  /**
   * Reads new messages once. The poll timer and kick() call this; so do tests.
   * Replies are queued, never awaited, so a send stuck on the Automation
   * prompt cannot hold up the next poll.
   */
  async pollOnce(): Promise<void> {
    const target = messageTarget(this.options.settings());
    if (!target || !target.commands || this.polling) return;
    this.polling = true;
    this.again = false;
    try {
      const configured = await this.ensureConfigured(target);
      if (configured)
        this.state = {
          ...this.state,
          database: databaseOf(configured.database),
        };
      // No baseline yet (Messages closed, no grant): reading now would start
      // from row 0 and run whatever is stored. The next poll configures again.
      if (this.baseline !== configuredKey(target)) return;
      const result = await this.use().call("poll", {
        sinceRowId: this.lastRowId,
      });
      const rowId = Number(result?.rowId ?? 0);
      const advanced = Number.isFinite(rowId) && rowId > this.lastRowId;
      if (advanced) this.lastRowId = rowId;
      // A full page means more rows are waiting: read them now, not in 4 s.
      if (advanced && Number(result?.skipped) > 0) this.again = true;
      this.state = {
        ...this.state,
        ...(typeof result?.database === "string"
          ? { database: databaseOf(result.database) }
          : {}),
        error: undefined,
      };
      const rows: unknown[] = Array.isArray(result?.messages)
        ? result.messages
        : [];
      for (const row of rows.slice(0, 20)) await this.receive(row, target);
    } catch (error) {
      this.forget(error);
      this.state = { ...this.state, error: readable(error) };
      this.trace("MessagesPollFailed", errorDetails(error));
    } finally {
      this.polling = false;
    }
    if (this.again) {
      this.again = false;
      await this.pollOnce();
    }
  }
  /** Settings' "Send a test message". Rejects with a readable message. */
  async sendTest(): Promise<void> {
    const target = messageTarget(this.options.settings());
    if (!target)
      throw new Error("Turn on texting and add your number to send a test.");
    await this.ensureConfigured(target);
    await this.use().call("send", {
      text: "Open Assist is set up. Text “status”, “stop”, “pause”, “continue” or “do <task>”.",
    });
    this.outgoing.push(this.now());
    this.state = { ...this.state, error: undefined };
  }
  /** Probes the helper for permission state (the Settings panel refresh). */
  async refresh(): Promise<MessagesStatus> {
    const target = messageTarget(this.options.settings());
    if (!target) return this.status();
    try {
      const result =
        (await this.ensureConfigured(target)) ??
        (await this.use().call("status"));
      this.state = {
        ...this.state,
        automation: automationOf(result?.automation),
        database: databaseOf(result?.database),
      };
    } catch (error) {
      this.state = { ...this.state, error: readable(error) };
    }
    return this.status();
  }
  close(): void {
    this.closed = true;
    this.stopPolling();
    this.helper?.close();
    this.helper = undefined;
  }

  // internals

  private use(): MessagesHelper {
    this.helper ??= this.options.helper(() => this.kick());
    return this.helper;
  }
  /**
   * Makes sure the helper knows the handle before anything is sent or read,
   * and watches the database only while replies are read. A new handle (or a
   * restarted helper) starts from the newest stored row, so a backlog of texts
   * can never execute. That row only counts when the helper read it: a
   * configure while the database is locked, missing or refused reports row 0,
   * which is no baseline at all, so the key stays unset and the next call
   * configures again. Returns the configure result, or undefined when the
   * helper was already configured this way. Polls and sends now run side by
   * side, so they share one configure call: two would each move the baseline,
   * and the second could jump past a row the first poll has not read yet.
   */
  private async ensureConfigured(target: {
    handle: string;
    commands: boolean;
  }): Promise<any | undefined> {
    const key = configuredKey(target);
    if (this.baseline === key) return undefined;
    if (this.configuring?.key === key) {
      await this.configuring.done;
      return undefined;
    }
    const done = this.use().call("configure", {
      handle: target.handle,
      watch: target.commands,
    });
    this.configuring = { key, done };
    try {
      const result = await done;
      const latest = Number(result?.latestRowId);
      const read =
        result?.database === "ok" &&
        Number.isSafeInteger(latest) &&
        latest >= 0;
      // Without texted control nothing is ever read, so no baseline is needed.
      if (read || !target.commands) {
        this.baseline = key;
        this.lastRowId = read ? latest : 0;
        this.rate = new MessageRate();
      }
      return result;
    } finally {
      if (this.configuring?.done === done) this.configuring = undefined;
    }
  }
  /** A restarted helper has forgotten the handle; configure it again next time. */
  private forget(error: unknown) {
    if ((error as { code?: string })?.code === "NOT_CONFIGURED")
      this.baseline = "";
  }
  private trace(event: string, data: Record<string, unknown> = {}) {
    trace(this.options.trace, event, data);
  }
  private remember(key: string) {
    this.sentKeys.push(key);
    if (this.sentKeys.length > 200) this.sentKeys.splice(0, 100);
  }
  /** Per-run bookkeeping is bounded; the newest entries (active runs) stay. */
  private prune() {
    if (this.announced.size > 200)
      this.announced = new Set([...this.announced].slice(-100));
    if (this.textedRuns.size > 200)
      this.textedRuns = new Set([...this.textedRuns].slice(-100));
    if (this.runCounts.size > 200)
      this.runCounts = new Map([...this.runCounts].slice(-100));
    if (this.progressCounts.size > 200)
      this.progressCounts = new Map([...this.progressCounts].slice(-100));
  }
  private startPolling() {
    if (this.timer !== undefined) return;
    this.state = { ...this.state, listening: true };
    const setTimer =
      this.options.setTimer ??
      ((fn: () => void, ms: number) => {
        const handle = setTimeout(fn, ms);
        handle.unref?.();
        return handle;
      });
    const loop = () => {
      this.timer = undefined;
      void this.pollOnce().finally(() => {
        if (this.state.listening) this.timer = setTimer(loop, MESSAGE_POLL_MS);
      });
    };
    this.timer = setTimer(loop, MESSAGE_POLL_MS);
  }
  private stopPolling() {
    const clear =
      this.options.clearTimer ??
      ((handle: unknown) =>
        clearTimeout(handle as ReturnType<typeof setTimeout>));
    if (this.timer !== undefined) clear(this.timer);
    this.timer = undefined;
    this.state = { ...this.state, listening: false };
  }
  /**
   * Queues one outgoing text inside the hourly budget and returns at once.
   * The budget is charged now, in arrival order; the helper call waits its
   * turn behind earlier texts. Never throws.
   */
  private send(text: string, reason: string): void {
    const target = messageTarget(this.options.settings());
    if (!target || !text.trim()) return;
    const now = this.now();
    this.outgoing = this.outgoing.filter((t) => now - t < 3600000);
    if (this.outgoing.length >= MESSAGE_HOUR_LIMIT) {
      this.trace("MessageDropped", { reason, cause: "hourly_limit" });
      return;
    }
    this.outgoing.push(now);
    this.outbox = this.outbox.then(() => this.deliver(text, reason));
  }
  private async deliver(text: string, reason: string): Promise<void> {
    // Switched off, or quitting, while this waited in line.
    const target = messageTarget(this.options.settings());
    if (!target || this.closed) return;
    try {
      await this.ensureConfigured(target);
      await this.use().call("send", { text: text.slice(0, MESSAGE_MAX_SEND) });
      this.trace("MessageSent", { reason, length: text.length });
      this.state = { ...this.state, error: undefined };
    } catch (error) {
      this.forget(error);
      this.state = { ...this.state, error: readable(error) };
      this.trace("MessageSendFailed", { reason, ...errorDetails(error) });
    }
  }
  /**
   * One candidate row from the helper, re-checked here before it can act.
   * Defence in depth: the helper already filtered by handle, freshness and
   * service. A row that does not match the contract in
   * tests/fixtures/messages-poll.json is dropped, and traced, never guessed at.
   */
  private async receive(
    row: unknown,
    target: { handle: string; commands: boolean },
  ): Promise<void> {
    const value = (row && typeof row === "object" ? row : {}) as {
      rowId?: unknown;
      handle?: unknown;
      service?: unknown;
      text?: unknown;
      at?: unknown;
    };
    if (
      typeof value.rowId !== "number" ||
      typeof value.handle !== "string" ||
      typeof value.service !== "string" ||
      typeof value.text !== "string" ||
      typeof value.at !== "number"
    ) {
      this.trace("MessageIgnored", { cause: "shape" });
      return;
    }
    if (!handlesMatch(target.handle, value.handle)) {
      this.trace("MessageIgnored", { cause: "sender" });
      return;
    }
    const at = value.at * 1000;
    const now = this.now();
    if (!at || at < now - MESSAGE_MAX_AGE_MS || at > now + 60000) {
      this.trace("MessageIgnored", { cause: "stale" });
      return;
    }
    const command = parseMessageCommand(value.text);
    const trust = messageServiceTrust(value.service);
    if (trust === "none" || (trust === "status" && command.kind !== "status")) {
      this.trace("MessageIgnored", { cause: "service", kind: command.kind });
      return;
    }
    const admission = this.rate.admit(now);
    if (!admission.accepted) {
      this.trace("MessageIgnored", { cause: "rate", kind: command.kind });
      if (admission.reply)
        this.send(
          "That’s a lot of messages at once. I’ll pick up again in a minute.",
          "throttled",
        );
      return;
    }
    this.trace("MessageCommand", { kind: command.kind });
    await this.run(command, target);
  }
  private async run(
    command: MessageCommand,
    target: { commands: boolean },
  ): Promise<void> {
    const now = this.now();
    switch (command.kind) {
      case "status":
        this.send(statusLine(this.snapshot), "status");
        return;
      case "approval":
        if (this.rate.answerUnknown(now))
          this.send(MESSAGE_APPROVAL_REPLY, "approval");
        return;
      case "unknown":
      case "empty":
      case "too_long":
        if (this.rate.answerUnknown(now))
          this.send(
            command.kind === "too_long"
              ? "That message is too long for me. " + MESSAGE_VOCABULARY
              : MESSAGE_VOCABULARY,
            "unknown",
          );
        return;
      case "stop": {
        if (!this.active()) {
          this.send("Nothing is running.", "stop");
          return;
        }
        this.options.control.stop();
        this.send("Stopped.", "stop");
        return;
      }
      case "pause": {
        if (!this.active()) {
          this.send("Nothing is running.", "pause");
          return;
        }
        this.options.control.pause();
        this.send(
          "Paused. Text “continue” when you want it to go on.",
          "pause",
        );
        return;
      }
      case "resume": {
        if (!this.active()) {
          this.send("Nothing is running.", "continue");
          return;
        }
        try {
          const resumed = await this.options.control.resume();
          // Only a run that really resumed earns "Continuing."; otherwise say
          // why from the state as it is now.
          this.send(
            resumed ? "Continuing." : notResumedLine(this.snapshot),
            "continue",
          );
        } catch (error) {
          this.send(
            `I couldn’t continue: ${readable(error)}`.slice(
              0,
              MESSAGE_MAX_SEND,
            ),
            "continue",
          );
        }
        return;
      }
      case "start": {
        if (!target.commands) return;
        if (scanText(command.task).some((f) => f.action === "BLOCK_UPLOAD")) {
          this.send(
            "I can’t take passwords or keys by message. Enter those on the Mac.",
            "refused",
          );
          return;
        }
        // The started moment is the acknowledgement, so the run is announced
        // exactly once whether it was started here or on the Mac.
        this.pendingStart = { at: now, task: command.task };
        try {
          await this.options.startTask(command.task);
        } catch (error) {
          this.pendingStart = undefined;
          this.send(
            `I couldn’t start that: ${readable(error)}`.slice(
              0,
              MESSAGE_MAX_SEND,
            ),
            "start",
          );
        }
        return;
      }
    }
  }
  private active(): boolean {
    const run = this.snapshot?.run;
    return !!run && !["completed", "cancelled", "failed"].includes(run.status);
  }
}

function configuredKey(target: { handle: string; commands: boolean }) {
  return `${target.handle}\n${target.commands}`;
}
function readable(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return message || "The Messages helper failed.";
}
function automationOf(value: unknown): MessagesAutomation {
  const known: MessagesAutomation[] = [
    "granted",
    "denied",
    "ask",
    "messages_closed",
    "unknown",
    "unavailable",
  ];
  return known.includes(value as MessagesAutomation)
    ? (value as MessagesAutomation)
    : "unknown";
}
function databaseOf(value: unknown): MessagesDatabaseState {
  const known: MessagesDatabaseState[] = [
    "ok",
    "no_access",
    "locked",
    "missing",
    "unsupported",
    "unopened",
    "off",
  ];
  return known.includes(value as MessagesDatabaseState)
    ? (value as MessagesDatabaseState)
    : "unopened";
}
