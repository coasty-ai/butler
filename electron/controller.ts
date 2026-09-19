import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { cleanScreenContext } from "../src/core/context";
import {
  HelperSlowError,
  HelperUnavailableError,
  NativeActionError,
  NativeStoppedError,
  ScreenChangedError,
  SurfaceBlockedError,
  TargetError,
  screenChange,
  targetCode,
  type NativeActionCode,
  type TargetCode,
} from "../src/core/errors";
import type { TakeoverScope } from "../src/core/runner";
import type { InputIdleReport } from "../src/core/resume";
import {
  errorDetails,
  trace,
  type DiagnosticSink,
} from "../src/core/diagnostics";
import type {
  Action,
  Controller,
  ExecutionResult,
  Frame,
  OcrLine,
  ProbeResult,
  Region,
  Rung,
  RunTarget,
  Settings,
  Surface,
  TargetSpec,
  WatchBinding,
} from "../src/core/schema";

export interface HelperHooks {
  /** The helper exited or hung unexpectedly; pending requests were rejected. */
  onUnavailable?: () => void;
  /** A replacement helper is running and needs its process-local setup again. */
  onRestart?: (pid: number | undefined) => void;
  /**
   * A request passed its deadline but the helper answered its liveness
   * probe, so the request waits on (waitedMs so far) instead of the helper
   * being restarted. Alive and busy, not dead.
   */
  onSlow?: (method: string, waitedMs: number) => void;
}
/** The liveness probe's own timeout message; never a helper's reply. */
const LIVENESS_UNANSWERED = "The liveness probe went unanswered.";
interface HelperOptions {
  /** Diagnostic event prefix: <name>Unavailable, <name>Closed, <name>Restarted. */
  name: string;
  /** Arguments the helper is spawned with (a replacement recognizer command); none for the app's own helpers. */
  args?: string[];
  diagnostics?: DiagnosticSink;
  hooks: HelperHooks;
  /** Handles unsolicited event lines. Returns true when the line was an event. */
  event: (line: any) => boolean;
  error: (line: any) => Error;
  restarting: string;
  exhausted: string;
  closed: string;
  /** Sent before SIGKILL so a hung native helper latches input off first. */
  stopSignal?: NodeJS.Signals;
  /**
   * How long a hung helper has between the stop signal and SIGKILL, so a
   * latched in-flight request can release buttons or keys it pressed.
   */
  stopGraceMs?: number;
  /**
   * A cheap request the helper answers off its serial work queue (the native
   * helper's presence, read on its reader thread). With one, a request past
   * its deadline is not taken for a dead helper at once: the probe is sent,
   * and an answer within timeoutMs means the helper is alive and busy, so
   * the request waits on (send's limitMs bounds the whole wait) and
   * `<name>Slow` is traced; a probe that goes unanswered restarts the helper
   * as before. Without one, a deadline restarts the helper at once.
   */
  liveness?: { method: string; timeoutMs: number };
}
const backoff = [500, 1000, 2000];
const restartLimit = 5;
const restartWindow = 60000;
/**
 * A sliding-window budget: 0 when another attempt may run now (the caller
 * records it), otherwise the delay until the oldest attempt leaves the window.
 */
export function budgetDelay(
  attempts: readonly number[],
  now: number,
  limit: number,
  windowMs: number,
): number {
  const recent = attempts.filter((t) => now - t < windowMs);
  if (recent.length < limit) return 0;
  return Math.max(1, Math.min(...recent) + windowMs - now);
}
/**
 * One JSON-lines helper process that is restarted in place. Callers keep the
 * same object (the Runner holds the controller), so a crash or hang becomes a
 * typed, recoverable error instead of a permanently dead bridge.
 */
export class HelperProcess {
  private child!: ChildProcessWithoutNullStreams;
  private pending = new Map<
    string,
    {
      resolve: (x: any) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      /** Whether its deadline may kill the helper: a request of the work queue. */
      kill: boolean;
    }
  >();
  private down = false;
  private closing = false;
  private exhausted = false;
  private restarts: number[] = [];
  private respawnTimer?: ReturnType<typeof setTimeout>;
  /** The liveness probe in flight, shared by every request waiting on it. */
  private probing?: Promise<boolean>;
  /**
   * A request was given up at its bound with the helper alive, and no
   * request of the work queue has been answered since: a second such request
   * means a reader alive over a wedged queue, which is dead for work.
   */
  private stalled = false;
  constructor(
    private binary: string,
    private options: HelperOptions,
  ) {
    this.spawn();
  }
  get pid() {
    return this.child.pid;
  }
  get alive() {
    return !this.down && !this.closing;
  }
  private spawn() {
    const child = spawn(this.binary, this.options.args ?? [], {
      stdio: "pipe",
    });
    this.child = child;
    this.down = false;
    this.exhausted = false;
    this.stalled = false;
    child.stderr.resume();
    // A write racing the helper's death reports EPIPE here; exit handles it.
    child.stdin.on("error", () => {});
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (child !== this.child) return;
      try {
        const obj = JSON.parse(line);
        if (!obj || typeof obj !== "object") return;
        if (this.options.event(obj)) return;
        const p = this.pending.get(obj.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(obj.id);
        // The work queue answered (a result or its own error alike).
        if (p.kill) this.stalled = false;
        obj.error ? p.reject(this.options.error(obj)) : p.resolve(obj.result);
      } catch {
        /* No untrusted helper output enters logs */
      }
    });
    let ended = false;
    const end = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (ended) return;
      ended = true;
      if (child === this.child) this.died(exitCode, signal);
    };
    child.on("exit", (code, signal) => end(code, signal));
    child.on("error", () => {
      // Spawn failures have no pid. Any other error (a failed kill) leaves a
      // live process; kill it so exactly one helper ever runs.
      if (child.pid === undefined) end(null, null);
      else if (child.exitCode === null && child.signalCode === null)
        try {
          child.kill("SIGKILL");
        } catch {}
    });
  }
  private rejectAll(error: () => Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error());
    }
    this.pending.clear();
  }
  private died(exitCode: number | null, signal: NodeJS.Signals | null) {
    this.down = true;
    const name = this.options.name;
    if (this.closing) {
      this.rejectAll(() => new Error(this.options.closed));
      trace(this.options.diagnostics, `${name}Closed`);
      return;
    }
    this.rejectAll(() => new HelperUnavailableError(this.options.restarting));
    trace(this.options.diagnostics, `${name}Unavailable`, {
      exitCode: exitCode ?? undefined,
      signal: signal ?? undefined,
    });
    this.scheduleRestart();
    try {
      this.options.hooks.onUnavailable?.();
    } catch {}
  }
  private scheduleRestart() {
    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < restartWindow);
    if (this.restarts.length >= restartLimit) {
      this.exhausted = true;
      return;
    }
    const delay = backoff[Math.min(this.restarts.length, backoff.length - 1)];
    this.restarts.push(now);
    this.respawnTimer = setTimeout(() => this.restart(), delay);
  }
  private restart() {
    if (this.closing) return;
    try {
      this.spawn();
    } catch {
      this.died(null, null);
      return;
    }
    trace(this.options.diagnostics, `${this.options.name}Restarted`, {
      pid: this.child.pid,
      restarts: this.restarts.length,
    });
    try {
      this.options.hooks.onRestart?.(this.child.pid);
    } catch {}
  }
  /**
   * Kills a helper that stopped answering; exit then drives the restart. A
   * helper with a stop signal latches input off first and gets a short grace
   * so an in-flight drag or key press can post its release before SIGKILL.
   */
  private hang(message: string) {
    const child = this.child;
    this.down = true;
    const alive = () =>
      !!child.pid && child.exitCode === null && child.signalCode === null;
    if (alive()) {
      const kill = () => {
        if (alive())
          try {
            child.kill("SIGKILL");
          } catch {}
      };
      if (this.options.stopSignal) {
        try {
          process.kill(child.pid!, this.options.stopSignal);
        } catch {}
        setTimeout(kill, this.options.stopGraceMs ?? 200);
      } else kill();
    }
    this.rejectAll(() => new HelperUnavailableError(message));
  }
  signal(signal: NodeJS.Signals) {
    // ChildProcess.kill marks `killed` even for a nonterminating signal, so
    // signal the pid directly and keep the helper reusable.
    const child = this.child;
    if (child.pid && child.exitCode === null && child.signalCode === null)
      try {
        process.kill(child.pid, signal);
      } catch {}
  }
  /**
   * Whether the helper answers its liveness probe: true on a reply of any
   * kind (its reader thread is alive, whatever holds its work queue), false
   * when the probe itself goes unanswered. One probe serves every request
   * waiting on it.
   */
  private checkAlive(): Promise<boolean> {
    const probe = this.options.liveness!;
    this.probing ??= this.send(probe.method, {}, probe.timeoutMs, {
      message: LIVENESS_UNANSWERED,
      kill: false,
    })
      .then(
        () => true,
        (error: Error) => error.message !== LIVENESS_UNANSWERED,
      )
      .finally(() => {
        this.probing = undefined;
      });
    return this.probing;
  }
  send(
    method: string,
    data: Record<string, unknown>,
    timeoutMs: number,
    timeout: {
      message: string;
      kill: boolean;
      /**
       * With a liveness probe configured and kill set: the most this request
       * may wait in all while the helper keeps answering the probe. Each
       * extension is another timeoutMs, cut to what is left of this bound.
       * Unset, the request has its one deadline as before.
       */
      limitMs?: number;
      /** What a request past limitMs fails with while the helper is alive. */
      slow?: string;
    },
  ): Promise<any> {
    if (this.closing) return Promise.reject(new Error(this.options.closed));
    if (this.down) {
      if (!this.exhausted)
        return Promise.reject(
          new HelperUnavailableError(this.options.restarting),
        );
      const now = Date.now();
      if (
        this.restarts.filter((t) => now - t < restartWindow).length >=
        restartLimit
      )
        return Promise.reject(new Error(this.options.exhausted));
      // The restart budget recovered; start a fresh helper for later requests.
      this.restarts.push(now);
      this.restart();
      return Promise.reject(
        new HelperUnavailableError(this.options.restarting),
      );
    }
    const id = crypto.randomUUID();
    const started = Date.now();
    const limitMs = Math.max(timeoutMs, timeout.limitMs ?? timeoutMs);
    return new Promise((resolve, reject) => {
      const expire = () => {
        const entry = this.pending.get(id);
        if (!entry) return;
        if (!timeout.kill) {
          this.pending.delete(id);
          reject(new Error(timeout.message));
          return;
        }
        // A helper that stopped answering, or one that never was asked to
        // prove otherwise: kill it, and exit drives the restart.
        const dead = () => {
          if (!this.pending.delete(id)) return;
          trace(this.options.diagnostics, `${this.options.name}TimedOut`, {
            method,
            waitedMs: Date.now() - started,
          });
          reject(new HelperUnavailableError(timeout.message));
          this.hang(timeout.message);
        };
        if (!this.options.liveness) return dead();
        void this.checkAlive().then((alive) => {
          // Answered, or rejected by an exit, while the probe was out.
          if (!this.pending.has(id)) return;
          if (!alive) return dead();
          const waitedMs = Date.now() - started;
          const remaining = limitMs - waitedMs;
          if (remaining <= 0) {
            // Alive at the bound: the request is given up, not the helper,
            // unless the queue has answered nothing since the last request
            // given up this way; then the reader is alive over a wedged
            // queue and the helper is dead for work.
            if (this.stalled) return dead();
            this.stalled = true;
            this.pending.delete(id);
            reject(new HelperSlowError(timeout.slow));
            return;
          }
          trace(this.options.diagnostics, `${this.options.name}Slow`, {
            method,
            waitedMs,
          });
          try {
            this.options.hooks.onSlow?.(method, waitedMs);
          } catch {}
          entry.timer = setTimeout(expire, Math.min(timeoutMs, remaining));
        });
      };
      this.pending.set(id, {
        resolve,
        reject,
        timer: setTimeout(expire, timeoutMs),
        kill: timeout.kill,
      });
      this.child.stdin.write(JSON.stringify({ id, method, ...data }) + "\n");
    });
  }
  close(before?: () => void) {
    if (this.closing) return;
    this.closing = true;
    clearTimeout(this.respawnTimer);
    const child = this.child;
    if (
      child.pid === undefined ||
      child.exitCode !== null ||
      child.signalCode !== null
    ) {
      this.rejectAll(() => new Error(this.options.closed));
      trace(this.options.diagnostics, `${this.options.name}Closed`);
      return;
    }
    before?.();
    try {
      child.kill("SIGTERM");
    } catch {}
    const escalate = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null)
        try {
          child.kill("SIGKILL");
        } catch {}
    }, 1500);
    escalate.unref?.();
  }
}

const nativeActionCodes = new Set<NativeActionCode>([
  "LAUNCH_FAILED",
  "APP_UNRESOLVED",
  "APP_REFUSED",
  "FILE_UNRESOLVED",
  "FILE_REFUSED",
  "OPEN_FAILED",
  "TARGET_MISSING",
  "TARGET_DISABLED",
  "TARGET_REFUSED",
  "TARGET_AMBIGUOUS",
]);
function nativeError(line: {
  error?: unknown;
  code?: unknown;
  change?: unknown;
}): Error {
  const message =
    typeof line.error === "string" && line.error
      ? line.error
      : "Native controller failed.";
  if (line.code === "STATE_CHANGED")
    return new ScreenChangedError(message, screenChange(line.change));
  if (line.code === "STOPPED") return new NativeStoppedError(message);
  if (line.code === "SURFACE_BLOCKED") return new SurfaceBlockedError(message);
  const target = targetCode(line.code);
  if (target) return new TargetError(target, message);
  if (
    typeof line.code === "string" &&
    nativeActionCodes.has(line.code as NativeActionCode)
  )
    return new NativeActionError(line.code as NativeActionCode, message);
  return new Error(message);
}
function launchedResult(value: unknown): ExecutionResult["launched"] {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.appId !== "string" || typeof v.name !== "string")
    return undefined;
  // Only a count the helper actually reported: a missing or malformed one
  // must not read as "no window" and tell the model the app is empty.
  const windows =
    typeof v.windows === "number" &&
    Number.isInteger(v.windows) &&
    v.windows >= 0
      ? Math.min(v.windows, 99)
      : undefined;
  return {
    appId: v.appId.slice(0, 255),
    name: v.name.slice(0, 120),
    frontmost: v.frontmost === true,
    wasRunning: v.wasRunning === true,
    ...(windows !== undefined && {
      windows,
      restoredWindow: v.restoredWindow === true,
    }),
  };
}
function openedResult(value: unknown): ExecutionResult["opened"] {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (
    typeof v.path !== "string" ||
    !v.path ||
    (v.kind !== "document" && v.kind !== "folder")
  )
    return undefined;
  return {
    path: v.path.slice(0, 500),
    kind: v.kind,
    ...(typeof v.appId === "string" && v.appId
      ? { appId: v.appId.slice(0, 255) }
      : {}),
  };
}
/**
 * What the helper knows about whether someone is at the Mac (§5 of the build
 * plan): seconds since the last HID input as the system counts it, the age of
 * the last unmarked input the emergency-stop tap saw (null while no tap is
 * installed), whether the session is locked or the display asleep, and
 * whether something holds the display awake (a call sharing the screen, a
 * video, a presentation: idle input then does not mean the user has left).
 * Read only: it sends no input and changes no focus. This is the one
 * declaration of the wire shape; electron/presence.ts imports it rather than
 * redeclaring it, so a field added here without a check in presenceReport
 * fails to compile instead of being dropped at the wire.
 */
export interface PresenceReport {
  hidIdleSeconds: number;
  tapIdleSeconds: number | null;
  locked: boolean;
  displayAsleep: boolean;
  displayHeldAwake: boolean;
}
const finiteSeconds = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
const flag = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;
/** The helper's presence reply, or undefined when its shape is not trusted. */
export function presenceReport(value: unknown): PresenceReport | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const hidIdleSeconds = finiteSeconds(v.hidIdleSeconds);
  const tapIdleSeconds =
    v.tapIdleSeconds === null ? null : finiteSeconds(v.tapIdleSeconds);
  const locked = flag(v.locked);
  const displayAsleep = flag(v.displayAsleep);
  const displayHeldAwake = flag(v.displayHeldAwake);
  if (
    hidIdleSeconds === undefined ||
    tapIdleSeconds === undefined ||
    locked === undefined ||
    displayAsleep === undefined ||
    displayHeldAwake === undefined
  )
    return undefined;
  // An object literal of exactly the contract's keys: tsc rejects a missing
  // or unknown one, which ties this validator to the interface above.
  return {
    hidIdleSeconds,
    tapIdleSeconds,
    locked,
    displayAsleep,
    displayHeldAwake,
  } satisfies Record<keyof PresenceReport, unknown>;
}
/** The helper's watch methods (increment 5A); none of them sends input. */
const watchMethods = new Set([
  "bindWatch",
  "probe",
  "unbindWatch",
  "setWatchMode",
  "focusWatch",
]);
/**
 * A bounded copy of the helper's run target, or undefined when its shape is
 * not one. As with a watch binding, the token names the window only to the
 * helper (.data/design/background-actuation.md §2.2).
 */
export function runTarget(value: unknown): RunTarget | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (
    typeof v.token !== "string" ||
    !/^[A-Za-z0-9-]{8,64}$/.test(v.token) ||
    typeof v.appId !== "string" ||
    typeof v.appName !== "string" ||
    typeof v.pid !== "number" ||
    !Number.isInteger(v.pid) ||
    typeof v.windowId !== "number" ||
    !Number.isInteger(v.windowId)
  )
    return undefined;
  return {
    token: v.token,
    pid: v.pid,
    windowId: v.windowId,
    appId: v.appId.slice(0, 255),
    appName: v.appName.slice(0, 120),
    title: typeof v.title === "string" ? v.title.slice(0, 300) : "",
  };
}
const rungs = new Set<Rung>(["ax", "post", "foreground"]);
const effects = new Set<NonNullable<ExecutionResult["effect"]>>([
  "changed",
  "none",
  "unverifiable",
]);
/**
 * The helper's executeTarget reply: the rung that delivered the step and
 * what its postcondition read found, plus the launch and open results an
 * execute reply may carry. Undefined when the shape is not one; a reply that
 * says the step was not executed becomes a TargetError with the helper's
 * code, or RUNG_UNAVAILABLE when it names none the runner knows.
 */
export function targetResult(value: unknown): ExecutionResult | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (v.executed !== true)
    throw new TargetError(
      targetCode(v.code) ?? "RUNG_UNAVAILABLE",
      typeof v.error === "string" && v.error
        ? v.error.slice(0, 300)
        : "The step could not be delivered to the window.",
    );
  const rung = rungs.has(v.rung as Rung) ? (v.rung as Rung) : undefined;
  const effect = effects.has(v.effect as NonNullable<ExecutionResult["effect"]>)
    ? (v.effect as NonNullable<ExecutionResult["effect"]>)
    : undefined;
  const launched = launchedResult(v.launched),
    opened = openedResult(v.opened);
  return {
    ...(rung && { rung }),
    ...(effect && { effect }),
    ...(launched && { launched }),
    ...(opened && { opened }),
  };
}
/**
 * A bounded copy of the helper's watch binding, or undefined when its shape
 * is not one. The token is opaque: it names the window only to the helper.
 */
export function watchBinding(value: unknown): WatchBinding | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (
    typeof v.token !== "string" ||
    !/^[A-Za-z0-9-]{8,64}$/.test(v.token) ||
    typeof v.appId !== "string" ||
    typeof v.pid !== "number" ||
    !Number.isInteger(v.pid) ||
    typeof v.windowId !== "number" ||
    !Number.isInteger(v.windowId)
  )
    return undefined;
  return {
    token: v.token,
    appId: v.appId.slice(0, 255),
    pid: v.pid,
    windowId: v.windowId,
    title: typeof v.title === "string" ? v.title.slice(0, 300) : "",
  };
}
const fraction = (value: unknown): number | undefined =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 1
    ? value
    : undefined;
const probeFailures = new Set([
  "window_gone",
  "not_visible",
  "protected",
  "secure_input",
  "screen_locked",
  "failed",
]);
/** At most this many lines of at most this many characters leave the helper. */
export const PROBE_MAX_LINES = 400;
export const PROBE_MAX_CHARS = 200;
/**
 * The helper's probe reply, bounded, or undefined when the shape is not one.
 * Lines are text read from the watched window: they go to the watch's pure
 * rules and never into a Snapshot or a trace.
 */
export function probeResult(value: unknown): ProbeResult | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (v.ok === false)
    return typeof v.code === "string" && probeFailures.has(v.code)
      ? {
          ok: false,
          code: v.code as Exclude<ProbeResult, { ok: true }>["code"],
        }
      : { ok: false, code: "failed" };
  if (v.ok !== true || !Array.isArray(v.lines)) return undefined;
  const lines: OcrLine[] = [];
  for (const raw of v.lines.slice(0, PROBE_MAX_LINES)) {
    if (!raw || typeof raw !== "object") continue;
    const l = raw as Record<string, unknown>;
    const x = fraction(l.x),
      y = fraction(l.y),
      w = fraction(l.w),
      h = fraction(l.h);
    if (
      typeof l.t !== "string" ||
      x === undefined ||
      y === undefined ||
      w === undefined ||
      h === undefined
    )
      continue;
    const t = l.t.slice(0, PROBE_MAX_CHARS);
    if (t.trim()) lines.push({ t, x, y, w, h });
  }
  const idleMs = Number(v.idleMs);
  return {
    ok: true,
    frontmost: v.frontmost === true,
    title: typeof v.title === "string" ? v.title.slice(0, 300) : "",
    lines,
    idleMs: Number.isFinite(idleMs) && idleMs >= 0 ? idleMs : 0,
  };
}
export type ScrollDirection = "down" | "up";
/**
 * The pace the helper confirmed for a continuous scroll: which session it
 * is (its end report names the same one), the speed factor it clamped, and
 * what one tick posts (native ScrollPacing).
 */
export interface ScrollPace {
  session: number;
  speed: number;
  linesPerTick: number;
  tickMs: number;
}
const paceValue = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
const sessionId = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
export function scrollPace(value: unknown): ScrollPace | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const session = sessionId(v.session),
    speed = paceValue(v.speed),
    linesPerTick = paceValue(v.linesPerTick),
    tickMs = paceValue(v.tickMs);
  if (
    session === undefined ||
    speed === undefined ||
    linesPerTick === undefined ||
    tickMs === undefined
  )
    return undefined;
  return { session, speed, linesPerTick, tickMs };
}
/**
 * Why a continuous scroll ended: the stop latch (a spoken stop, a new
 * activation, Escape), the user's own mouse or keyboard, the window in front
 * changing, the helper's time limit, or a surface it must not scroll.
 */
export type ScrollEndReason =
  "stop" | "input" | "appChanged" | "limit" | "error";
const scrollEndReasons = new Set<ScrollEndReason>([
  "stop",
  "input",
  "appChanged",
  "limit",
  "error",
]);
export interface ScrollEndReport {
  session: number;
  reason: ScrollEndReason;
  ticks: number;
  /** The helper's sentence for an error, bounded. */
  message?: string;
}
export function scrollEndReport(value: unknown): ScrollEndReport | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const session = sessionId(v.session);
  if (
    session === undefined ||
    typeof v.reason !== "string" ||
    !scrollEndReasons.has(v.reason as ScrollEndReason) ||
    typeof v.ticks !== "number" ||
    !Number.isInteger(v.ticks) ||
    v.ticks < 0
  )
    return undefined;
  return {
    session,
    reason: v.reason as ScrollEndReason,
    ticks: v.ticks,
    ...(typeof v.message === "string" && v.message
      ? { message: v.message.slice(0, 300) }
      : {}),
  };
}
/**
 * The requests that read the screen or a bound window into a frame: a
 * screenshot, accessibility walks, Vision text and the encoding, each of
 * which waits on a busy Mac or a busy application.
 */
const screenReads = new Set([
  "capture",
  "revalidate",
  "captureTarget",
  "revalidateTarget",
]);
/** Per-request deadlines. Typing is paced natively, so it scales with length. */
export function nativeTimeout(
  method: string,
  data: Record<string, unknown> = {},
): number {
  // A bound window is captured and checked like the screen.
  if (screenReads.has(method)) return 25000;
  // Spotlight metadata lookups are fast; memory recall never waits long.
  if (method === "index") return 3000;
  // A probe is one window capture and its OCR; binding and focusing list the
  // windows on screen and activate one; the rest flip a flag.
  if (method === "probe") return 10000;
  if (
    ["bindWatch", "focusWatch", "bindTarget", "foregroundTarget"].includes(
      method,
    )
  )
    return 8000;
  if (["unbindWatch", "setWatchMode", "unbindTarget"].includes(method))
    return 3000;
  // The helper answers presence on its reader thread, ahead of its command
  // queue, so it never waits behind a capture or paced typing and answers in
  // milliseconds; a slow answer means a wedged helper, not a long request.
  if (method === "presence") return 2000;
  if (method === "execute" || method === "executeTarget") {
    const action = data.action as Partial<Action> | undefined;
    if (action?.type === "type_text" && typeof action.text === "string")
      return 15000 + 40 * action.text.length;
    if (action?.type === "open_app") return 20000;
    if (action?.type === "open_file") return 12000;
  }
  return 15000;
}
/**
 * The most a request may wait in all while the helper keeps answering its
 * liveness probe; nativeTimeout is its first deadline and each extension
 * another such deadline, cut to this bound. Cycle 20260919-0816-a839d34: 12
 * captures of 2451 requests passed 25 s on a loaded Mac while the helper
 * was idle when sampled, and each restart cost the run a pause and a frame.
 * A capture may wait a minute; everything else gets one more deadline, and
 * a request with no liveness probe (kill: false) is never extended.
 */
export function nativeSlowLimit(
  method: string,
  data: Record<string, unknown> = {},
): number {
  const deadline = nativeTimeout(method, data);
  return screenReads.has(method) ? Math.max(deadline, 60000) : deadline * 2;
}
/** Whether a request reads the screen or the front window rather than acting on it. */
const readsScreen = (method: string) =>
  screenReads.has(method) || method === "surface" || method === "surfaceTarget";
/** What a request past its bound fails with while the helper is alive; the run pauses with it. */
export function slowMessage(method: string): string {
  return readsScreen(method)
    ? "Reading the screen is taking too long. Say continue to try again."
    : "Desktop control is taking too long. Say continue to try again.";
}
/** The pill's line while a slow request waits on; nothing speaks it. */
export function slowNotice(method: string): string {
  return readsScreen(method)
    ? "Reading the screen is slow…"
    : "Desktop control is slow…";
}

export class NativeController implements Controller {
  kind = "native" as const;
  private helper: HelperProcess;
  private timeout: typeof nativeTimeout;
  private slowLimit: typeof nativeSlowLimit;
  private urlRoute?: (
    action: Extract<Action, { type: "open_url" }>,
  ) => Promise<ExecutionResult["navigated"]>;
  constructor(
    binary: string,
    emergency: () => void,
    /**
     * The user's own input, with where it landed for a background run: in
     * the bound window ("target") or anywhere else ("screen", also every
     * report from a helper that knows no targets).
     */
    manualInput: (scope: TakeoverScope) => void = () => {},
    private diagnostics?: DiagnosticSink,
    hooks: HelperHooks & {
      timeout?: typeof nativeTimeout;
      /** The whole wait a request may have while the helper answers presence. */
      slowLimit?: typeof nativeSlowLimit;
      /**
       * Manual input went idle (after 1 s, then 3 s) with the kinds seen and,
       * for a bound run, whether the target is in front and the user's hands
       * are in its window (their last press, scroll or key, read against the
       * front now).
       */
      inputIdle?: (report: InputIdleReport) => void;
      /** A continuous scroll ended, with why and how many ticks it posted. */
      scrollEnded?: (report: ScrollEndReport) => void;
      /** The bound application activated itself and the helper put the user's back. */
      targetSelfActivated?: (token: string) => void;
      /** The binding behind the token died or became protected. */
      targetGone?: (token: string, code: TargetCode) => void;
      /**
       * The open_url route (electron/open-url.ts): the browser is told the
       * address by Apple Event or LaunchServices, never through the helper.
       * Without it open_url fails as a step no route can take.
       */
      openUrl?: (
        action: Extract<Action, { type: "open_url" }>,
      ) => Promise<ExecutionResult["navigated"]>;
    } = {},
  ) {
    this.timeout = hooks.timeout ?? nativeTimeout;
    this.slowLimit = hooks.slowLimit ?? nativeSlowLimit;
    this.urlRoute = hooks.openUrl;
    this.helper = new HelperProcess(binary, {
      name: "Native",
      diagnostics,
      hooks,
      stopSignal: "SIGUSR1",
      // Presence is answered on the helper's reader thread, ahead of its
      // serial command queue, and touches no window: it says the helper is
      // alive while a capture or a step still holds the queue.
      liveness: { method: "presence", timeoutMs: this.timeout("presence") },
      restarting: "Desktop control restarted. Say continue to resume.",
      exhausted: "Native controller unavailable. Run npm run build:native.",
      closed: "Native controller is not running.",
      error: nativeError,
      event: (obj) => {
        if (obj.event === "input_forwarded") {
          trace(this.diagnostics, "NativeInputForwarded", {
            source: obj.source,
          });
          return true;
        }
        if (obj.event === "emergency_stop") {
          trace(this.diagnostics, "NativeEmergencyStop");
          emergency();
          return true;
        }
        if (obj.event === "user_input_idle") {
          const kinds = Array.isArray(obj.kinds)
            ? obj.kinds.filter(
                (k: unknown): k is string =>
                  typeof k === "string" &&
                  ["mouse_move", "scroll", "click", "key"].includes(k),
              )
            : [];
          const idleMs = Number(obj.idleMs);
          if (!Number.isFinite(idleMs)) return true;
          // Where the hands are relative to a bound window: two flags, or
          // nothing when the shape is not exactly that.
          const target =
            obj.target &&
            typeof obj.target === "object" &&
            typeof obj.target.frontmost === "boolean" &&
            typeof obj.target.lastInside === "boolean"
              ? {
                  frontmost: obj.target.frontmost as boolean,
                  lastInside: obj.target.lastInside as boolean,
                }
              : undefined;
          trace(this.diagnostics, "NativeInputIdle", {
            durationMs: idleMs,
            kind: kinds.join("_") || "none",
            ...(target
              ? {
                  targetFrontmost: target.frontmost,
                  lastInsideTarget: target.lastInside,
                }
              : {}),
          });
          hooks.inputIdle?.({ idleMs, kinds, ...(target ? { target } : {}) });
          return true;
        }
        if (obj.event === "user_takeover") {
          const scope: TakeoverScope =
            obj.scope === "target" ? "target" : "screen";
          trace(this.diagnostics, "NativeUserTakeover", {
            source: obj.source,
            scope,
            delta_x: obj.delta_x,
            delta_y: obj.delta_y,
            sourcePid: obj.sourcePid,
            eventType: obj.eventType,
            flags: obj.flags,
            pointerDistance: obj.pointerDistance,
          });
          manualInput(scope);
          return true;
        }
        if (obj.event === "target_self_activated") {
          trace(this.diagnostics, "NativeTargetSelfActivated");
          if (typeof obj.token === "string")
            hooks.targetSelfActivated?.(obj.token);
          return true;
        }
        if (obj.event === "target_gone") {
          const code = targetCode(obj.code) ?? "TARGET_GONE";
          trace(this.diagnostics, "NativeTargetGone", { code });
          if (typeof obj.token === "string")
            hooks.targetGone?.(obj.token, code);
          return true;
        }
        if (obj.event === "scroll_ended") {
          const report = scrollEndReport(obj);
          if (report) hooks.scrollEnded?.(report);
          return true;
        }
        return typeof obj.event === "string";
      },
    });
  }
  request(method: string, data: Record<string, unknown> = {}): Promise<any> {
    const id = crypto.randomUUID();
    const started = performance.now();
    trace(this.diagnostics, "NativeRequest", { requestId: id, method });
    return this.helper
      .send(
        method,
        data,
        this.timeout(method, data),
        // A slow Spotlight lookup only loses memory context for this run, and
        // a slow presence read only delays a status decision; neither may
        // restart the helper (and pause the run) like a stuck input.
        method === "index"
          ? { message: "The system index did not answer in time.", kill: false }
          : method === "presence"
            ? { message: "Presence did not answer in time.", kill: false }
            : watchMethods.has(method)
              ? // A slow probe costs one read of a background window; a
                // restart would pause whatever run is going on.
                { message: "The watch did not answer in time.", kill: false }
              : method === "unbindTarget"
                ? // Releasing a binding at the end of a run is never worth a restart.
                  { message: "The target did not answer in time.", kill: false }
                : {
                    message:
                      "Desktop control stopped responding and is restarting.",
                    kill: true,
                    // Alive and busy is not dead: while the helper answers
                    // presence the wait is extended up to this bound, then
                    // the request fails with its own sentence and the
                    // helper, its bindings and its tap are kept.
                    limitMs: this.slowLimit(method, data),
                    slow: slowMessage(method),
                  },
      )
      .then(
        (result) => {
          trace(this.diagnostics, "NativeResponse", {
            requestId: id,
            method,
            durationMs: Math.round(performance.now() - started),
            // Verbose-only (not allow-listed): the surface/policy inputs and
            // execution result. Frames are recorded separately.
            ...(["surface", "execute"].includes(method) && {
              request: data,
              result,
            }),
          });
          return result;
        },
        (error) => {
          trace(this.diagnostics, "NativeError", {
            requestId: id,
            method,
            durationMs: Math.round(performance.now() - started),
            ...errorDetails(error),
          });
          throw error;
        },
      );
  }
  async configure(s: Settings) {
    await this.request("configure", {
      protectedApps: s.protectedApps,
      protectedDomains: s.protectedDomains,
      notifications: s.notifications,
      ...(s.displayId ? { displayId: s.displayId } : {}),
    });
  }
  surface(action?: Action): Promise<Surface> {
    return this.request("surface", action ? { action } : {});
  }
  get pid() {
    return this.helper.pid;
  }
  get alive() {
    return this.helper.alive;
  }
  async capture(): Promise<Frame> {
    const frame: Frame = await this.request("capture");
    frame.context = cleanScreenContext(frame.context);
    return frame;
  }
  async execute(
    action: Action,
    _frame: Frame,
    signal: AbortSignal,
  ): Promise<void | ExecutionResult> {
    signal.throwIfAborted();
    // A web address never reaches the helper: the browser is told it.
    if (action.type === "open_url") return this.openUrl(action);
    const stop = () => this.stop();
    signal.addEventListener("abort", stop, { once: true });
    try {
      const result = await this.request("execute", { action });
      const launched = launchedResult(result?.launched),
        opened = openedResult(result?.opened),
        via =
          result?.via === "menu" || result?.via === "keys"
            ? (result.via as "menu" | "keys")
            : undefined;
      return launched || opened || via
        ? {
            ...(via && { via }),
            ...(launched && { launched }),
            ...(opened && { opened }),
          }
        : undefined;
    } finally {
      signal.removeEventListener("abort", stop);
    }
  }
  /**
   * Loads a web address in the chosen browser (electron/open-url.ts), by
   * Apple Event on the app's own front tab or by LaunchServices; no key,
   * no click, and no request to the helper, whose stop latch stays as it
   * is. The result names the host and the browser.
   */
  async openUrl(
    action: Extract<Action, { type: "open_url" }>,
  ): Promise<ExecutionResult> {
    if (!this.urlRoute)
      throw new Error("No browser route is configured for web addresses.");
    const navigated = await this.urlRoute(action);
    return navigated ? { navigated } : {};
  }
  async revalidate(action: Action, _frame: Frame): Promise<Frame> {
    const frame: Frame = await this.request("revalidate", { action });
    frame.context = cleanScreenContext(frame.context);
    return frame;
  }
  stop() {
    this.helper.signal("SIGUSR1");
  }
  /**
   * Whether someone seems to be at the Mac, from the helper's counters. A
   * malformed reply is reported as an error rather than trusted as a report.
   */
  async presence(): Promise<PresenceReport> {
    const report = presenceReport(await this.request("presence"));
    if (!report) throw new Error("Native controller returned no presence.");
    return report;
  }
  async resume() {
    await this.request("resume");
  }
  async restore() {
    await this.request("restore");
  }
  /** The application remembered before a turn or a hand-off comes back in front; the hand-off ends. */
  async restoreRemembered() {
    await this.request("restoreRemembered");
  }
  /** Binds the frontmost window for a detached watch; the helper mints the token. */
  async bindWatch(): Promise<WatchBinding> {
    const binding = watchBinding(await this.request("bindWatch"));
    if (!binding)
      throw new Error("Native controller returned no watch binding.");
    return binding;
  }
  /** One read of the bound window's text; only the token names the window. */
  async probe(token: string, region?: Region): Promise<ProbeResult> {
    const result = probeResult(
      await this.request("probe", { token, ...(region ? { region } : {}) }),
    );
    if (!result) throw new Error("Native controller returned no probe result.");
    return result;
  }
  async unbindWatch(token: string) {
    await this.request("unbindWatch", { token });
  }
  async setWatchMode(on: boolean) {
    await this.request("setWatchMode", { on });
  }
  async focusWatch(token: string) {
    await this.request("focusWatch", { token });
  }
  /**
   * Background runs (.data/design/background-actuation.md §6.5). The helper
   * binds the window and mints the token; every later call names it by the
   * token alone, and the helper re-checks what is behind it before acting.
   */
  async bindTarget(spec: TargetSpec): Promise<RunTarget> {
    const target = runTarget(await this.request("bindTarget", { ...spec }));
    if (!target) throw new Error("Native controller returned no run target.");
    return target;
  }
  async captureTarget(token: string): Promise<Frame> {
    const frame: Frame = await this.request("captureTarget", { token });
    frame.context = cleanScreenContext(frame.context);
    return frame;
  }
  surfaceTarget(token: string, action?: Action): Promise<Surface> {
    return this.request("surfaceTarget", {
      token,
      ...(action ? { action } : {}),
    });
  }
  async revalidateTarget(
    token: string,
    action: Action,
    _frame: Frame,
  ): Promise<Frame> {
    const frame: Frame = await this.request("revalidateTarget", {
      token,
      action,
    });
    frame.context = cleanScreenContext(frame.context);
    return frame;
  }
  async executeTarget(
    token: string,
    action: Action,
    _frame: Frame,
    rungs: Rung[],
    signal: AbortSignal,
  ): Promise<ExecutionResult> {
    signal.throwIfAborted();
    const stop = () => this.stop();
    signal.addEventListener("abort", stop, { once: true });
    try {
      const result = targetResult(
        await this.request("executeTarget", { token, action, rungs }),
      );
      if (!result)
        throw new Error("Native controller returned no target result.");
      return result;
    } finally {
      signal.removeEventListener("abort", stop);
    }
  }
  async foregroundTarget(token: string): Promise<{ frontmost: boolean }> {
    const result = await this.request("foregroundTarget", { token });
    return { frontmost: result?.frontmost === true };
  }
  async unbindTarget(token: string) {
    await this.request("unbindTarget", { token });
  }
  /**
   * Scrolls the window in front gently until stopped (a spoken "scroll
   * down"), or steers the scroll already under way; the helper reports the
   * end as a scroll_ended event. Returns the pace it settled on.
   */
  async scroll(direction: ScrollDirection, speed: number): Promise<ScrollPace> {
    const pace = scrollPace(
      await this.request("scrollContinuous", { direction, speed }),
    );
    if (!pace) throw new Error("Native controller returned no scroll pace.");
    return pace;
  }
  async scrollStop() {
    await this.request("scrollStop");
  }
  close() {
    this.helper.close(() => this.stop());
  }
}
