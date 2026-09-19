/**
 * Opens the app a spoken request starts with while the user is still talking:
 * "open Slack and message Dana" brings Slack forward before the sentence ends.
 * src/voice/early.ts decides which clause qualifies and when it has settled;
 * this runs the one step, before any run exists, with the Runner's own native
 * sequence (surface, surfacePolicy, capture, surface(open_app), evaluate,
 * execute) and accepts ALLOW or nothing: no retry, approval, hand-off or
 * pause. The helper's stop latch, which holds all agent input while the user
 * talks, is lifted only inside resume → capture → stop and resume → execute
 * → stop, and closed again in finally whatever happened.
 *
 * When the final transcript still starts with the same clause and the turn
 * starts a run, the step is that run's prelude (src/core/runner.ts); otherwise
 * nothing is recorded or said and the app simply stays open. The early
 * screenshot stays in memory and is written only as the first frame of the
 * run it belongs to. Diagnostics carry codes and timings, never a name.
 */
import type {
  Action,
  ExecutionResult,
  Frame,
  Settings,
  Surface,
} from "../src/core/schema";
import { validateAction } from "../src/core/schema";
import { evaluate, normalizeAppName, surfacePolicy } from "../src/core/policy";
import { nativeAction, type RunPrelude } from "../src/core/runner";
import { trace, type DiagnosticSink } from "../src/core/diagnostics";
import { scanText } from "../src/core/sanitize";
import {
  ClauseTracker,
  EARLY_LIMITS,
  finalKeeps,
  type Settle,
  type TrackerEvent,
  EARLY_GENERIC_NAMES,
} from "../src/voice/early";

export type EarlyCode =
  | "ok"
  | "disabled"
  | "unavailable"
  | "blocked_run"
  | "blocked_approval"
  | "blocked_queue"
  | "blocked_starting"
  | "secret"
  | "surface"
  | "unresolved"
  | "ambiguous"
  | "refused"
  | "not_exact"
  | "policy"
  | "frontmost"
  | "screen_changed"
  | "user_input"
  | "native_error"
  | "veto"
  | "control"
  | "cancelled"
  | "reactivated"
  | "no_final"
  | "final_first"
  | "final_changed"
  | "plan_not_start"
  | "run_active_at_final";
/** The native calls the step makes; NativeController satisfies it. */
export interface EarlyController {
  configure(s: Settings): Promise<void>;
  surface(action?: Action): Promise<Surface>;
  capture(): Promise<Frame>;
  execute(
    a: Action,
    f: Frame,
    signal: AbortSignal,
  ): Promise<void | ExecutionResult>;
  resume(): Promise<void>;
  /** The stop latch (SIGUSR1): immediate, never queued behind a request. */
  stop(): void;
  request(method: "rememberForeground"): Promise<unknown>;
}
export interface EarlyStartDeps {
  /** undefined off macOS or without the helper. */
  controller(): EarlyController | undefined;
  settings(): Settings;
  /** main's own reasons not to act now (a run, an approval, the queue…). */
  blocked(): EarlyCode | undefined;
  /**
   * Whether these heard words are an installed app's exact name. The step
   * then runs without waiting for a boundary or a pause, which is what
   * "open Slack and …" asks for. Absent until the app list is known.
   */
  knownApp?(key: string): boolean;
  /** The app came forward; main shows it on the listening pill. */
  onOpened(name: string): void;
  trace: DiagnosticSink;
  now?(): number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(t: unknown): void;
}
/** The step a final transcript kept, for the run it starts. */
export interface EarlyClaim {
  /** The final words were exactly the step ("Open Slack."). */
  readonly completes: boolean;
  /** Marks the step kept; resolves to the prelude, or undefined if it failed. */
  take(): Promise<RunPrelude | undefined>;
  /** The turn did not hand the step to a run; a no-op after take(). */
  release(code: EarlyCode): void;
}
type Step = Omit<RunPrelude, "completes">;
type Primed = { frame: Frame; at: number };
type OpenApp = Extract<Action, { type: "open_app" }>;
interface EarlyTurn {
  invocation: number;
  /** main's voiceContext: rememberForeground for this activation. */
  ready: Promise<unknown>;
  tracker: ClauseTracker;
  /** Ends every wait of this turn and, best effort, an execute in flight. */
  abort: AbortController;
  primed?: Promise<Primed | undefined>;
  settle?: Settle;
  step?: Promise<Step | undefined>;
  /** The step passed its last gate: it is being sent, and cannot be called off. */
  executing?: boolean;
  /** The step has resolved; stepResult is what it resolved to. */
  stepDone?: boolean;
  stepResult?: Step;
  timer?: unknown;
  executedAt?: number;
  /** Why the turn gets no (further) early step; the first reason wins. */
  closed?: EarlyCode;
  /** Final, cancel or a new activation: no partial or timer acts any more. */
  ended?: boolean;
  /** The final transcript arrived (finish()). */
  finishedAt?: number;
}

export class EarlyStart {
  private turn?: EarlyTurn;
  /** Every native section runs on this chain, one at a time. */
  private chain: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;
  constructor(private readonly deps: EarlyStartDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      deps.clearTimer ??
      ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }
  /** A new voice activation; ends any previous turn (its opened app stays). */
  begin(invocation: number, ready: Promise<unknown>) {
    const previous = this.turn;
    if (previous && !previous.ended) this.end(previous, "reactivated");
    ready.catch(() => {});
    this.turn = {
      invocation,
      ready,
      tracker: new ClauseTracker((key) => this.deps.knownApp?.(key) ?? false),
      abort: new AbortController(),
    };
  }
  /** A partial transcript of the current activation. */
  partial(invocation: number, text: string) {
    const turn = this.turn;
    if (!turn || turn.invocation !== invocation || turn.ended || turn.closed)
      return;
    if (!this.deps.settings().earlyStart) return;
    this.handle(turn, turn.tracker.push(text, this.now()));
  }
  /** The turn ended without a final (Escape, stop, error, typed input). */
  cancel(code: EarlyCode) {
    const turn = this.turn;
    if (!turn || turn.ended) return;
    this.end(turn, code);
  }
  /**
   * The final transcript arrived. Returns a claim when an early step started
   * and the final words still begin with its clause; otherwise the turn ends
   * here, and an open app stays open with nothing said about it.
   */
  finish(invocation: number, finalText: string): EarlyClaim | undefined {
    const turn = this.turn;
    if (!turn || turn.invocation !== invocation || turn.ended) return undefined;
    turn.ended = true;
    turn.finishedAt = this.now();
    this.disarm(turn);
    const settle = turn.settle,
      step = turn.step;
    if (!settle || !step) {
      turn.abort.abort();
      this.conclude(turn, turn.closed ?? "final_first", "abandoned");
      return undefined;
    }
    const kept = finalKeeps(settle.clause, finalText);
    // A run is never started with credentials in its words.
    if (
      !kept.keeps ||
      scanText(finalText).some((f) => f.action === "BLOCK_UPLOAD")
    ) {
      turn.abort.abort();
      this.conclude(turn, "final_changed", "abandoned");
      return undefined;
    }
    if (turn.stepDone && !turn.stepResult) {
      this.conclude(turn, turn.closed ?? "native_error", "abandoned");
      return undefined;
    }
    // Settled, but the app was never opened (the screenshot or the lookup is
    // still running): nothing to keep, and nothing was said about it.
    if (!turn.executing && !turn.stepDone) {
      turn.abort.abort();
      this.conclude(turn, turn.closed ?? "final_first", "abandoned");
      return undefined;
    }
    let taken: Promise<RunPrelude | undefined> | undefined;
    let released = false;
    return {
      completes: kept.exact,
      take: () =>
        (taken ??= step.then(async (result) => {
          // The app the user is in is now the one just opened: main restores
          // the remembered app next, and must not bring the old one back.
          if (result) {
            try {
              await this.deps.controller()?.request("rememberForeground");
            } catch {}
          }
          this.conclude(turn, "ok", "kept");
          return result ? { ...result, completes: kept.exact } : undefined;
        })),
      release: (code) => {
        if (taken || released) return;
        released = true;
        this.conclude(turn, code, "released");
      },
    };
  }
  /** Resolves when no early native section is open or queued. */
  async idle(): Promise<void> {
    for (let last: Promise<void> | undefined; last !== this.chain;) {
      last = this.chain;
      await last;
    }
  }

  private handle(turn: EarlyTurn, events: TrackerEvent[]) {
    for (const event of events) {
      if (turn.ended || turn.closed) return;
      if (event.kind === "prime")
        turn.primed = this.enqueue(() => this.prime(turn));
      else if (event.kind === "timer") this.arm(turn, event.at);
      else if (event.kind === "closed") {
        this.disarm(turn);
        this.close(turn, event.code);
        // Settled but not yet sent: a change of mind still calls it off.
        if (turn.settle && !turn.executing) turn.abort.abort();
      } else {
        this.disarm(turn);
        turn.settle = event.settle;
        const settle = event.settle;
        turn.step = this.enqueue(() => this.step(turn, settle)).then(
          (result) => {
            turn.stepDone = true;
            turn.stepResult = result;
            return result;
          },
        );
      }
    }
  }
  private arm(turn: EarlyTurn, at: number) {
    this.disarm(turn);
    turn.timer = this.setTimer(
      () => {
        turn.timer = undefined;
        if (turn.ended || turn.closed || this.turn !== turn) return;
        this.handle(turn, turn.tracker.tick(Math.max(this.now(), at)));
      },
      Math.max(0, at - this.now()),
    );
  }
  private disarm(turn: EarlyTurn) {
    if (turn.timer === undefined) return;
    this.clearTimer(turn.timer);
    turn.timer = undefined;
  }
  private close(turn: EarlyTurn, code: EarlyCode) {
    turn.closed ??= code;
  }
  private end(turn: EarlyTurn, code: EarlyCode) {
    turn.ended = true;
    this.disarm(turn);
    turn.abort.abort();
    this.close(turn, code);
    this.conclude(turn, code, "abandoned");
  }
  /**
   * One EarlyStartEnded per turn that primed or settled, once its step (if
   * any) has resolved: "kept", "released" or "abandoned" with the given code
   * when the app was opened, "skipped" when a settled step opened nothing,
   * and "abandoned" with the turn's own reason when nothing settled.
   */
  private conclude(
    turn: EarlyTurn,
    code: EarlyCode,
    phase: "kept" | "released" | "abandoned",
  ) {
    if (!turn.primed && !turn.settle) return;
    const report = () => {
      const opened = turn.executedAt !== undefined;
      trace(this.deps.trace, "EarlyStartEnded", {
        phase: opened ? phase : turn.settle ? "skipped" : "abandoned",
        code: opened ? code : (turn.closed ?? code),
        ...(opened && phase === "kept" && turn.finishedAt !== undefined
          ? { leadMs: turn.finishedAt - turn.executedAt! }
          : {}),
      });
    };
    if (turn.step) void turn.step.then(report, report);
    else report();
  }
  private enqueue<T>(fn: () => Promise<T | undefined>) {
    const run = this.chain.then(fn).catch(() => undefined);
    this.chain = run.then(() => undefined);
    return run;
  }
  /** Why nothing may run for this turn now, if anything. */
  private gate(turn: EarlyTurn): EarlyCode | undefined {
    if (turn.finishedAt !== undefined) return "final_first";
    if (turn.ended || turn.abort.signal.aborted || this.turn !== turn)
      return turn.closed ?? "cancelled";
    if (turn.closed) return turn.closed;
    if (!this.deps.settings().earlyStart) return "disabled";
    return this.deps.blocked();
  }
  /**
   * The read-only capture, started on the first "open…" partial while the
   * name is still arriving: it is the slow part (about half a second).
   */
  private async prime(turn: EarlyTurn): Promise<Primed | undefined> {
    if (turn.ended || turn.closed) return undefined;
    await turn.ready.catch(() => undefined);
    const blocked = this.gate(turn);
    if (blocked) return this.fail(turn, blocked);
    const c = this.deps.controller();
    if (!c) return this.fail(turn, "unavailable");
    try {
      const settings = this.deps.settings();
      await c.configure(settings);
      const current = await c.surface();
      // As Runner.capture(): never while a protected, terminal or secure
      // input surface is in front.
      if (surfacePolicy(current, settings).kind !== "ALLOW")
        return this.fail(turn, "surface");
      const again = this.gate(turn);
      if (again) return this.fail(turn, again);
      let frame: Frame;
      try {
        await c.resume();
        frame = await c.capture();
      } finally {
        c.stop();
      }
      return { frame, at: this.now() };
    } catch (error) {
      return this.fail(turn, this.failure(turn, error));
    }
  }
  /** The one early open_app of this turn; ALLOW or nothing. */
  private async step(
    turn: EarlyTurn,
    settle: Settle,
  ): Promise<Step | undefined> {
    const refuse = (code: EarlyCode, extra: Record<string, unknown> = {}) => {
      this.close(turn, code);
      trace(this.deps.trace, "EarlyStartExecuted", {
        code,
        settle: settle.by,
        ...extra,
      });
      return undefined;
    };
    let primed = turn.primed ? await turn.primed : undefined;
    // No capture yet (or it failed without closing the turn): take it now.
    if (!primed && !turn.closed && !turn.ended) primed = await this.prime(turn);
    // A long preamble: native refuses a frame over 30 s old.
    if (primed && this.now() - primed.at > EARLY_LIMITS.frameMaxAgeMs)
      primed = await this.prime(turn);
    if (!primed) return refuse(this.gate(turn) ?? "native_error");
    const blocked = this.gate(turn);
    if (blocked) return refuse(blocked);
    const c = this.deps.controller();
    if (!c) return refuse("unavailable");
    const settings = this.deps.settings();
    let action: OpenApp;
    try {
      const valid = validateAction(
        {
          type: "open_app",
          name: settle.clause.name,
          frame_id: primed.frame.id,
        },
        primed.frame,
      );
      // Built here and only here: nothing else can ever run early.
      if (valid.type !== "open_app") return refuse("policy");
      action = valid;
    } catch {
      return refuse("unresolved");
    }
    let surface: Surface;
    try {
      surface = await c.surface(action);
    } catch (error) {
      return refuse(this.failure(turn, error));
    }
    // The user switched apps since the screenshot.
    if (surface.appId !== primed.frame.appId) return refuse("screen_changed");
    if (surface.launcherStatus !== "resolved")
      return refuse(surface.launcherStatus ?? "unresolved");
    // Without a boundary the name may be unfinished ("open Visual…", "open
    // Google…"), so only the app's exact display name counts; a boundary
    // proves the name was finished, so "Chrome and…" may be Google Chrome.
    // Everyday words ("settings") always need the exact name, whatever
    // followed them: "open settings and…" must not open System Settings.
    if (
      (settle.by !== "boundary" ||
        EARLY_GENERIC_NAMES.has(settle.clause.key)) &&
      normalizeAppName(surface.launcherName ?? "") !==
        normalizeAppName(settle.clause.name)
    )
      return refuse("not_exact");
    const decision = evaluate(action, surface, settings, false);
    if (decision.kind !== "ALLOW")
      return refuse(
        surface.launcherAppId && surface.launcherAppId === surface.appId
          ? "frontmost"
          : "policy",
      );
    const again = this.gate(turn);
    if (again) return refuse(again);
    // Past this point the open is on its way and cannot be called off.
    turn.executing = true;
    const started = this.now();
    const timing = () => ({
      earlyMs: started - settle.firstAt,
      durationMs: this.now() - started,
    });
    let outcome: void | ExecutionResult;
    try {
      await c.resume();
      outcome = await c.execute(
        nativeAction(action, decision, surface),
        primed.frame,
        turn.abort.signal,
      );
    } catch (error) {
      return refuse(this.failure(turn, error), timing());
    } finally {
      c.stop();
    }
    turn.executedAt = this.now();
    const executed = timing();
    // Only the turn still being spoken owns the pill; after the final (or a
    // newer activation) the line would land on somebody else's turn.
    if (!turn.ended && this.turn === turn)
      this.deps.onOpened(outcome?.launched?.name || settle.clause.name);
    trace(this.deps.trace, "EarlyStartExecuted", {
      code: "ok",
      settle: settle.by,
      ...executed,
    });
    return {
      frame: primed.frame,
      surface,
      action,
      reason: decision.reason,
      ...(outcome ? { outcome } : {}),
    };
  }
  private fail(turn: EarlyTurn, code: EarlyCode): undefined {
    this.close(turn, code);
    return undefined;
  }
  private failure(turn: EarlyTurn, error: unknown): EarlyCode {
    if (turn.abort.signal.aborted) return turn.closed ?? "cancelled";
    return (error as { code?: unknown } | undefined)?.code === "STOPPED"
      ? "user_input"
      : "native_error";
  }
}
