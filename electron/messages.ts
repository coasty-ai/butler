/**
 * The iMessage channel: bounded updates out, a strict command vocabulary in.
 *
 * Off by default. When the owner turns it on and stores their own handle in
 * the encrypted config, Open Assist texts that one handle about the moments of
 * a run and reads replies from it as commands. Approvals never happen here:
 * they stay on the Mac, where the pill and the screen are.
 *
 * Everything the native helper cannot decide alone is decided here, and the
 * rules that matter are mirrored from native/macos/MessageSafety.swift so both
 * sides refuse the same things. The two test suites share fixture strings.
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
 * Canonical handle: "user@example.com" for an address, digits only for a
 * number. "" when the value cannot be a handle. Mirrors
 * normalizeMessageHandle in MessageSafety.swift.
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
  let body = trimmed.startsWith("tel:") ? trimmed.slice(4) : trimmed;
  if (body.startsWith("00")) body = "+" + body.slice(2);
  const digits = body.replace(/\D/g, "");
  if (!/^[+()\-. \u00a00-9]+$/.test(body)) return "";
  if (digits.length < 5 || digits.length > 16) return "";
  return digits;
}

/**
 * Same person? Numbers compare digit by digit; a bare ten-digit North
 * American number also matches its +1 form. Nothing else is fuzzy.
 */
export function handlesMatch(a: string, b: string): boolean {
  const left = normalizeHandle(a),
    right = normalizeHandle(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.includes("@") || right.includes("@")) return false;
  const [short, long] =
    left.length <= right.length ? [left, right] : [right, left];
  return (
    short.length === 10 &&
    long.length === 11 &&
    long.startsWith("1") &&
    long.endsWith(short)
  );
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
 * Mirrors parseMessageCommand in MessageSafety.swift.
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
 * automated sender cannot start a text ping-pong. Mirrors MessageRateState.
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
  if (!normalizeHandle(s.messagesHandle))
    throw new Error(
      "Add the phone number or iMessage address to text before turning messages on.",
    );
}
/** The live view of the settings, or undefined when the channel is off. */
export function messageTarget(
  s: MessageSettings,
):
  { handle: string; commands: boolean; updates: "texted" | "all" } | undefined {
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
  updates: "texted" | "all";
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
/** The coarena-messages helper as a restartable JSON-lines process. */
export function createMessagesHelper(
  binary: string,
  options: { diagnostics?: DiagnosticSink; hooks?: HelperHooks } = {},
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
    // The helper never speaks unless spoken to.
    event: () => false,
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

export interface MessagesChannelOptions {
  settings: () => MessageSettings;
  /** Created lazily, only once the channel is switched on. */
  helper: () => MessagesHelper;
  /**
   * Starts a task the way a typed command does, including the pill. Rejects
   * with a readable message (for example when a run is already active).
   */
  startTask: (task: string) => Promise<void>;
  control: {
    pause: () => void;
    stop: () => void;
    resume: () => Promise<void>;
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
  private baselineHandle = "";
  private polling = false;
  private snapshot?: Snapshot;
  private sentKeys: string[] = [];
  private runCounts = new Map<string, number>();
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
      this.baselineHandle = "";
      this.state = offStatus(settings);
      return;
    }
    try {
      const result =
        (await this.ensureConfigured(target.handle)) ??
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
    const terminal = ["completed", "cancelled", "failed"].includes(run.status);
    // A run that appears just after a texted "do" belongs to that text.
    if (
      this.pendingStart &&
      !terminal &&
      !this.announced.has(run.id) &&
      this.now() - this.pendingStart.at < 15000
    ) {
      this.textedRuns.add(run.id);
      this.pendingStart = undefined;
    }
    const target = messageTarget(this.options.settings());
    if (!target) return;
    if (target.updates === "texted" && !this.textedRuns.has(run.id)) return;
    const first = !this.announced.has(run.id);
    if (first) this.announced.add(run.id);
    if (first && terminal) return; // A run loaded from history, not a new one.
    const moment = messageMoment(s, first);
    if (!moment || this.sentKeys.includes(moment.key)) return;
    const count = this.runCounts.get(run.id) ?? 0;
    if (count >= MESSAGE_RUN_LIMIT) return;
    this.remember(moment.key);
    this.runCounts.set(run.id, count + 1);
    void this.send(moment.text, `moment:${run.status}`);
  }
  /** Reads new messages once. The poll timer calls this; so do tests. */
  async pollOnce(): Promise<void> {
    const target = messageTarget(this.options.settings());
    if (!target || !target.commands || this.polling) return;
    this.polling = true;
    try {
      await this.ensureConfigured(target.handle);
      const result = await this.use().call("poll", {
        sinceRowId: this.lastRowId,
      });
      const rowId = Number(result?.rowId ?? 0);
      if (Number.isFinite(rowId) && rowId > this.lastRowId)
        this.lastRowId = rowId;
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
  }
  /** Settings' "Send a test message". Rejects with a readable message. */
  async sendTest(): Promise<void> {
    const target = messageTarget(this.options.settings());
    if (!target)
      throw new Error("Turn on texting and add your number to send a test.");
    await this.ensureConfigured(target.handle);
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
        (await this.ensureConfigured(target.handle)) ??
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
    this.stopPolling();
    this.helper?.close();
    this.helper = undefined;
  }

  // internals

  private use(): MessagesHelper {
    this.helper ??= this.options.helper();
    return this.helper;
  }
  /**
   * Makes sure the helper knows the handle before anything is sent or read.
   * A new handle (or a restarted helper) starts from the newest stored row, so
   * a backlog of texts can never execute. Returns the configure result, or
   * undefined when the helper was already configured for this handle.
   */
  private async ensureConfigured(handle: string): Promise<any | undefined> {
    if (this.baselineHandle === handle) return undefined;
    const result = await this.use().call("configure", { handle });
    const latest = Number(result?.latestRowId ?? 0);
    this.baselineHandle = handle;
    this.lastRowId = Number.isFinite(latest) ? latest : 0;
    this.rate = new MessageRate();
    return result;
  }
  /** A restarted helper has forgotten the handle; configure it again next time. */
  private forget(error: unknown) {
    if ((error as { code?: string })?.code === "NOT_CONFIGURED")
      this.baselineHandle = "";
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
  /** One outgoing text, inside the hourly budget. Never throws. */
  private async send(text: string, reason: string): Promise<void> {
    const target = messageTarget(this.options.settings());
    if (!target || !text.trim()) return;
    const now = this.now();
    this.outgoing = this.outgoing.filter((t) => now - t < 3600000);
    if (this.outgoing.length >= MESSAGE_HOUR_LIMIT) {
      this.trace("MessageDropped", { reason, cause: "hourly_limit" });
      return;
    }
    this.outgoing.push(now);
    try {
      await this.ensureConfigured(target.handle);
      await this.use().call("send", { text: text.slice(0, MESSAGE_MAX_SEND) });
      this.trace("MessageSent", { reason, length: text.length });
      this.state = { ...this.state, error: undefined };
    } catch (error) {
      this.forget(error);
      this.state = { ...this.state, error: readable(error) };
      this.trace("MessageSendFailed", { reason, ...errorDetails(error) });
    }
  }
  /** One candidate row from the helper, re-checked here before it can act. */
  private async receive(
    row: unknown,
    target: { handle: string; commands: boolean },
  ): Promise<void> {
    if (!row || typeof row !== "object") return;
    const value = row as { handle?: unknown; text?: unknown; at?: unknown };
    // Defence in depth: the helper already filtered by handle and freshness.
    if (typeof value.handle !== "string" || typeof value.text !== "string")
      return;
    if (!handlesMatch(target.handle, value.handle)) {
      this.trace("MessageIgnored", { cause: "sender" });
      return;
    }
    const at = typeof value.at === "number" ? value.at * 1000 : 0;
    const now = this.now();
    if (!at || at < now - MESSAGE_MAX_AGE_MS || at > now + 60000) {
      this.trace("MessageIgnored", { cause: "stale" });
      return;
    }
    const command = parseMessageCommand(value.text);
    const admission = this.rate.admit(now);
    if (!admission.accepted) {
      this.trace("MessageIgnored", { cause: "rate", kind: command.kind });
      if (admission.reply)
        await this.send(
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
        await this.send(statusLine(this.snapshot), "status");
        return;
      case "approval":
        if (this.rate.answerUnknown(now))
          await this.send(MESSAGE_APPROVAL_REPLY, "approval");
        return;
      case "unknown":
      case "empty":
      case "too_long":
        if (this.rate.answerUnknown(now))
          await this.send(
            command.kind === "too_long"
              ? "That message is too long for me. " + MESSAGE_VOCABULARY
              : MESSAGE_VOCABULARY,
            "unknown",
          );
        return;
      case "stop": {
        if (!this.active()) {
          await this.send("Nothing is running.", "stop");
          return;
        }
        this.options.control.stop();
        await this.send("Stopped.", "stop");
        return;
      }
      case "pause": {
        if (!this.active()) {
          await this.send("Nothing is running.", "pause");
          return;
        }
        this.options.control.pause();
        await this.send(
          "Paused. Text “continue” when you want it to go on.",
          "pause",
        );
        return;
      }
      case "resume": {
        if (!this.active()) {
          await this.send("Nothing is running.", "continue");
          return;
        }
        try {
          await this.options.control.resume();
          await this.send("Continuing.", "continue");
        } catch (error) {
          await this.send(
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
          await this.send(
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
          await this.send(
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
