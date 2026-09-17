import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { cleanScreenContext } from "../src/core/context";
import {
  HelperUnavailableError,
  NativeActionError,
  NativeStoppedError,
  ScreenChangedError,
  SurfaceBlockedError,
  type NativeActionCode,
} from "../src/core/errors";
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
  Settings,
  Surface,
} from "../src/core/schema";

export interface HelperHooks {
  /** The helper exited or hung unexpectedly; pending requests were rejected. */
  onUnavailable?: () => void;
  /** A replacement helper is running and needs its process-local setup again. */
  onRestart?: (pid: number | undefined) => void;
}
interface HelperOptions {
  /** Diagnostic event prefix: <name>Unavailable, <name>Closed, <name>Restarted. */
  name: string;
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
    }
  >();
  private down = false;
  private closing = false;
  private exhausted = false;
  private restarts: number[] = [];
  private respawnTimer?: ReturnType<typeof setTimeout>;
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
    const child = spawn(this.binary, [], { stdio: "pipe" });
    this.child = child;
    this.down = false;
    this.exhausted = false;
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
  send(
    method: string,
    data: Record<string, unknown>,
    timeoutMs: number,
    timeout: { message: string; kill: boolean },
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
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        if (timeout.kill) {
          trace(this.options.diagnostics, `${this.options.name}TimedOut`, {
            method,
          });
          reject(new HelperUnavailableError(timeout.message));
          this.hang(timeout.message);
        } else reject(new Error(timeout.message));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
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
]);
function nativeError(line: { error?: unknown; code?: unknown }): Error {
  const message =
    typeof line.error === "string" && line.error
      ? line.error
      : "Native controller failed.";
  if (line.code === "STATE_CHANGED") return new ScreenChangedError(message);
  if (line.code === "STOPPED") return new NativeStoppedError(message);
  if (line.code === "SURFACE_BLOCKED") return new SurfaceBlockedError(message);
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
  return {
    appId: v.appId.slice(0, 255),
    name: v.name.slice(0, 120),
    frontmost: v.frontmost === true,
    wasRunning: v.wasRunning === true,
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
/** Per-request deadlines. Typing is paced natively, so it scales with length. */
export function nativeTimeout(
  method: string,
  data: Record<string, unknown> = {},
): number {
  if (method === "capture" || method === "revalidate") return 25000;
  // Spotlight metadata lookups are fast; memory recall never waits long.
  if (method === "index") return 3000;
  if (method === "execute") {
    const action = data.action as Partial<Action> | undefined;
    if (action?.type === "type_text" && typeof action.text === "string")
      return 15000 + 40 * action.text.length;
    if (action?.type === "open_app") return 20000;
    if (action?.type === "open_file") return 12000;
  }
  return 15000;
}

export class NativeController implements Controller {
  kind = "native" as const;
  private helper: HelperProcess;
  private timeout: typeof nativeTimeout;
  constructor(
    binary: string,
    emergency: () => void,
    manualInput: () => void = () => {},
    private diagnostics?: DiagnosticSink,
    hooks: HelperHooks & { timeout?: typeof nativeTimeout } = {},
  ) {
    this.timeout = hooks.timeout ?? nativeTimeout;
    this.helper = new HelperProcess(binary, {
      name: "Native",
      diagnostics,
      hooks,
      stopSignal: "SIGUSR1",
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
        if (obj.event === "user_takeover") {
          trace(this.diagnostics, "NativeUserTakeover", {
            source: obj.source,
            delta_x: obj.delta_x,
            delta_y: obj.delta_y,
            sourcePid: obj.sourcePid,
            eventType: obj.eventType,
            flags: obj.flags,
            pointerDistance: obj.pointerDistance,
          });
          manualInput();
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
        // A slow Spotlight lookup only loses memory context for this run; it
        // must not restart the helper (and pause the run) like a stuck input.
        method === "index"
          ? { message: "The system index did not answer in time.", kill: false }
          : {
              message: "Desktop control stopped responding and is restarting.",
              kill: true,
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
    const stop = () => this.stop();
    signal.addEventListener("abort", stop, { once: true });
    try {
      const result = await this.request("execute", { action });
      const launched = launchedResult(result?.launched),
        opened = openedResult(result?.opened);
      return launched || opened
        ? { ...(launched && { launched }), ...(opened && { opened }) }
        : undefined;
    } finally {
      signal.removeEventListener("abort", stop);
    }
  }
  async revalidate(action: Action, _frame: Frame): Promise<Frame> {
    const frame: Frame = await this.request("revalidate", { action });
    frame.context = cleanScreenContext(frame.context);
    return frame;
  }
  stop() {
    this.helper.signal("SIGUSR1");
  }
  async resume() {
    await this.request("resume");
  }
  async restore() {
    await this.request("restore");
  }
  close() {
    this.helper.close(() => this.stop());
  }
}
