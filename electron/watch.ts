/**
 * Detached watches of a window on the user's Mac, usually a coding agent's
 * panel in their editor (increment 5A). A monitor step binds the window
 * natively and hands it here, and its run completes: a two-hour watch must
 * not occupy the only runner, so every other voice or texted task can still
 * run while it ticks. Each tick asks the helper for the bound window's text
 * (no screenshot kept, no model call, no input), the pure rules in
 * src/core/monitor.ts decide what it means, and this manager acts: it tells
 * the reporter how things are going, surfaces the agent's permission
 * questions to the user (never answering them), and wakes the model with a
 * cause once the agent is done, stuck or gone. Every wake starts a new run
 * through main's queue with origin "watch", and every one waits for its turn
 * first: no run going on, nobody at the Mac (electron/presence.ts), the Mac
 * unlocked and room in the queue. Only then is the window brought forward,
 * and only for the causes that need it on screen.
 *
 * Text read from the panel never enters a WatchState or a trace: it reaches
 * the reporter and the wake-up run bounded and redacted, as ProgressFacts
 * and context.watch.panelText, and nowhere else, and only when the text
 * came from an agent's panel located in the window, never from the window
 * read whole. Only a VS Code-family editor is read for an agent at all:
 * anywhere else a "Continue" button is just a button.
 *
 * A wake-up run is a follow-up, not the request again: it gets the earlier
 * request quoted as already carried out (wakeTask), and a chain of watches
 * and wakes is bounded as a whole by watchMaxMinutes and a number of wakes.
 */
import type {
  Action,
  Controller,
  ProbeResult,
  Region,
  RunOrigin,
  Settings,
  TaskSource,
  WatchBinding,
} from "../src/core/schema";
import type {
  ProgressFacts,
  ProgressKind,
  ProgressReport,
  WatchState,
} from "../src/assistant/types";
import { stepLine } from "../src/assistant/steps";
import { trace, type DiagnosticSink } from "../src/core/diagnostics";
import { ideFamily } from "../src/core/ide";
import { mayTakeScreen, type PresenceService } from "./presence";
import {
  RELAY_POLL_MS,
  agentNames,
  digestPanel,
  materialChange,
  newWatchMemory,
  panelRegion,
  panelTail,
  resolveAgent,
  watchTick,
  type AgentId,
  type PanelDigest,
  type RelayDecline,
  type RelayKind,
  type WakeCause,
  type WatchChain,
  type WatchMemory,
  type WatchSpec,
} from "../src/core/monitor";

export type { WakeCause, WatchChain };

/** A permission question the agent is showing, for the user to answer. */
export interface RelayRequest {
  id: string;
  watchId: string;
  /** The run the watch came from, and a sequence it shares with the facts. */
  runId: string;
  seq: number;
  agent: AgentId;
  kind: RelayKind;
  question: string;
  allowLabel: string;
  decline: RelayDecline;
  key: string;
  /** How the request that began the watch was made. */
  origin?: RunOrigin;
}
/** Why a relayed question is no longer shown: answered in the editor, or the watch ended. */
export type RelayGone = "answered" | "ended";
/**
 * What the wake-up run is started with. The task is the watched run's own
 * request, for wakeTask to quote: it was carried out already, and a wake-up
 * run that got it back as its objective would do it all again.
 */
export interface WakeContext {
  task: string;
  taskSource?: TaskSource;
  /** The steps the watched run took, one line each, never typed text. */
  notes: string[];
  /** The user's corrections to the watched run, in order. */
  corrections: string[];
  /** At most 1500 characters, redacted; only from an agent's panel. */
  panelTail?: string;
  /** How the request that began the chain was made, so the answer comes back the same way. */
  origin?: RunOrigin;
  appName?: string;
  /** The chain this wake belongs to, this wake counted; the next watch carries it on. */
  chain: WatchChain;
}
export interface WatchStart extends WatchSpec {
  runId: string;
  task: string;
  taskSource?: TaskSource;
  origin?: RunOrigin;
  appName?: string;
  notes: string[];
  corrections?: string[];
  /** Set when a wake-up run starts this watch: the chain goes on from there. */
  chain?: WatchChain;
}
/** What holds a wake back, for the line that says so. */
export type WakeHold = "presence" | "locked" | "run" | "queue";
/** Why facts are being reported now, for a reporter that decides the wording. */
export interface FactsHint {
  kind: ProgressKind;
  cause?: WakeCause;
  held?: WakeHold;
  /** The wake waited for someone at the Mac for too long and was let go. */
  dropped?: boolean;
}
export interface WatchManagerOptions {
  controller: Required<
    Pick<Controller, "probe" | "unbindWatch" | "setWatchMode" | "focusWatch">
  >;
  presence: PresenceService;
  settings: () => Settings;
  onWake(w: WatchState, cause: WakeCause, ctx: WakeContext): void;
  onFacts(f: ProgressFacts, hint?: FactsHint): void;
  onRelay?(r: RelayRequest): void;
  onRelayGone?(id: string, reason: RelayGone): void;
  /** Whether main's queue can take a wake-up run now; a wake waits otherwise. */
  canWake?: () => boolean;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  trace?: DiagnosticSink;
}

/** How often a waiting wake re-checks whether it may take the screen. */
export const WAKE_RETRY_MS = 5000;
/** A wake nobody lets through (someone at the Mac all along) is dropped after this. */
export const WAKE_PENDING_MAX_MS = 30 * 60 * 1000;
/** Cadence while the window is minimized or on another Space. */
export const NOT_VISIBLE_MS = 30000;
/** A window whose panel showed no anchors is watched by the clock alone for this long. */
export const ANCHORLESS_TTL_MS = 30 * 60 * 1000;
/** With no anchors, the clock wakes the model this often at most. */
export const ANCHORLESS_MAX_MS = 15 * 60 * 1000;
/**
 * Wake-up runs one window may start in an hour, and all windows together.
 * Each wake is a paid model run that may watch again, so without a ceiling
 * a page that keeps changing (or screen text telling the model to keep
 * watching) would run the model every half minute for as long as the user
 * is away. A watch that does its job wakes the model once.
 */
export const WAKES_PER_WINDOW_HOURLY = 4;
export const WAKES_HOURLY = 10;
const WAKE_WINDOW_MS = 60 * 60 * 1000;
/** Every this many probes the whole window is read again to re-find the panel. */
const COLUMN_REFRESH_PROBES = 10;
/** Windows watched at once; the helper holds as many bindings (watchBindingsMax). */
export const WATCHES_MAX = 4;
/**
 * Wake-up runs one chain of watches may start in all. With watchMaxMinutes
 * over the chain as a whole, this is what ends watch → wake → watch again
 * while the user is away: each wake-up run has its own maxCost budget.
 */
export const CHAIN_WAKES_MAX = 6;
/** The quoted request in a wake-up objective is cut to this many characters. */
const WAKE_TASK_QUOTE = 600;
const WAKE_CORRECTION_QUOTE = 200;

/** A monitor step refused: the runner tells the model why and the run goes on. */
export class WatchRefusedError extends Error {
  readonly code = "MONITOR_REFUSED";
}

interface Watch {
  id: string;
  runId: string;
  task: string;
  taskSource?: TaskSource;
  origin?: RunOrigin;
  appName?: string;
  notes: string[];
  corrections: string[];
  chain: WatchChain;
  binding: WatchBinding;
  spec: WatchSpec;
  /** Only in a VS Code-family editor is the window read for an agent. */
  ide: boolean;
  agent?: AgentId;
  region?: Region;
  memory: WatchMemory;
  /**
   * The lines of the last read that came from inside a located panel, the
   * only text that may leave the watch; empty after a read of the window
   * whole, even once the agent is known (its panel may have closed).
   */
  panelLines: string[];
  probes: number;
  seq: number;
  timer?: unknown;
  ended: boolean;
  busy: boolean;
  pendingWake?: {
    cause: WakeCause;
    focus: boolean;
    /** What held it back when the reporter last heard; it hears again on a change. */
    held?: WakeHold;
    /** Since when someone at the Mac has held it back; reset by other holds. */
    since: number;
    panelTail?: string;
  };
  relay?: { id: string; key: string };
  /** Lines the last report was built from, for the change the next one reports. */
  factsLines: string[];
}

/** Display name for the fixed lines below; "It" for a window with no agent. */
export function agentLabel(agent: string | undefined): string {
  return (agent && agentNames[agent as AgentId]) || "It";
}
/**
 * The line the reporter, the voice and the phone get for a relayed question:
 * a fixed sentence by kind, never the question itself. The question is text
 * read from the screen; spoken or texted it would sound like the assistant
 * asking, and a repository can make an agent ask for anything. It shows on
 * the pill card only, where the editor is a glance away.
 */
export function relayLine(r: Pick<RelayRequest, "agent" | "kind">): string {
  const what =
    r.kind === "command"
      ? "run a command"
      : r.kind === "edit"
        ? "make an edit"
        : r.kind === "plan"
          ? "go ahead with its plan"
          : r.kind === "continue"
            ? "continue"
            : r.kind === "review"
              ? "have its edits reviewed"
              : "use a tool";
  return `${agentLabel(r.agent)} is asking to ${what}. Answer it in the editor.`;
}
/**
 * The fixed line for facts the reporter (increment 4B) has not yet learned to
 * word: what happened and what the watch waits for. Nothing for a check-in
 * or a summary, which say nothing without a summarizer.
 */
export function factsLine(
  f: Pick<ProgressFacts, "watch">,
  hint: FactsHint,
): string | undefined {
  if (hint.kind === "checkin" || hint.kind === "summary") return undefined;
  const agent = agentLabel(f.watch?.agent);
  if (hint.kind === "stalled")
    return `${agent} hasn’t changed anything for ${f.watch?.minutes ?? 0} minutes.`;
  const news =
    hint.cause === "done"
      ? `${agent} looks finished.`
      : hint.cause === "error"
        ? `${agent} looks stuck or failed.`
        : hint.cause === "changed"
          ? `${agent} changed.`
          : `${agent} needs you.`;
  if (hint.dropped) return `${news} You were at the Mac, so I left it to you.`;
  const then =
    hint.held === "run"
      ? "once the current task is done"
      : hint.held === "queue"
        ? "once the queue has room"
        : hint.held === "locked"
          ? "once the Mac is unlocked"
          : "when you step away";
  return `${news} I’ll take a look ${then}.`;
}
/** The line for a wake main could not turn into a run: the window is the user's. */
export function droppedLine(w: Pick<WatchState, "agent">, cause: WakeCause) {
  const agent = agentLabel(w.agent);
  const news =
    cause === "done"
      ? `${agent} looks finished`
      : cause === "error"
        ? `${agent} looks stuck or failed`
        : `${agent} needs you`;
  return `${news}, but I couldn’t start a follow-up. The window is yours.`;
}

/** Why the watch woke, in the words of a wake-up objective. */
const wakeWords: Record<WakeCause, string> = {
  done: "it looks finished",
  error: "it looks stuck or failed",
  idle: "it is waiting for input",
  stalled: "nothing on it has changed for a while",
  changed: "the window changed",
  expired: "the watch ran out of time",
  unknown: "its panel could not be read",
  window_gone: "the window closed",
  probe_failed: "the window could not be read",
};
const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};
/**
 * The objective of a wake-up run: a follow-up on the watch, with the request
 * that began it quoted as already carried out. The request itself as the
 * objective would hand the wake-up run all of its authority again (a "paste"
 * in it allows Command-V, memory would replay its steps), while nobody may be
 * at the Mac. The user's corrections keep their say as constraints.
 */
export function wakeTask(
  w: Pick<WatchState, "agent" | "app">,
  cause: WakeCause,
  ctx: Pick<WakeContext, "task" | "corrections">,
): string {
  const what = w.agent ? agentLabel(w.agent) : clip(w.app, 60) || "a window";
  const corrections = ctx.corrections.length
    ? "\nUser corrections to that request, in order. Preserve these constraints:\n" +
      ctx.corrections.map((c) => clip(c, WAKE_CORRECTION_QUOTE)).join("\n")
    : "";
  return (
    `A watch on ${what} woke you: ${wakeWords[cause]}. ` +
    `The earlier request, already carried out before the watch began: “${clip(ctx.task, WAKE_TASK_QUOTE)}”.` +
    corrections +
    "\nLook at the window as it is now and tell the user what it shows; do not repeat the earlier request's steps."
  );
}
/** The watched run's steps for the wake-up run: the last few, one line each, never typed text. */
export function handoffNotes(actions: readonly Action[]): string[] {
  return actions
    .map((a) => stepLine(a))
    .filter((line): line is string => !!line)
    .slice(-5);
}
/**
 * A fixed watch line for the progress sinks, until increment 4B's reporter
 * words watch facts and decides who hears them. It is spoken only when the
 * watch was asked for by voice, and never texted: whether the phone gets it
 * (messagesUpdates, presence) is the reporter's decision alone.
 */
export function fallbackReport(o: {
  runId: string;
  seq: number;
  kind: ProgressKind;
  text: string;
  origin?: RunOrigin;
  at: number;
}): ProgressReport {
  return {
    runId: o.runId,
    seq: o.seq,
    kind: o.kind,
    text: o.text,
    at: o.at,
    speak: o.origin === "voice",
    send: false,
    fallback: true,
  };
}
/**
 * The watch's latest line or relay card the pill had no room for (a run or
 * the microphone had it), kept until the pill is free: an agent's question
 * asked during another task is still seen after it. The newest wins, and a
 * relayed question answered or ended meanwhile is never shown late.
 */
export class HeldNews<T> {
  private held?: { item: T; relay?: string };
  /** The item to show now, or undefined when busy (it is kept instead). */
  offer(item: T, busy: boolean, relay?: string): T | undefined {
    if (busy) {
      this.held = { item, ...(relay ? { relay } : {}) };
      return undefined;
    }
    this.held = undefined;
    return item;
  }
  forget(relay: string) {
    if (this.held?.relay === relay) this.held = undefined;
  }
  /** The kept item, once, when the pill is free. */
  take(busy: boolean): { item: T; relay?: string } | undefined {
    if (busy || !this.held) return undefined;
    const held = this.held;
    this.held = undefined;
    return held;
  }
  clear() {
    this.held = undefined;
  }
}

export class WatchManager {
  private watches = new Map<string, Watch>();
  /**
   * Watches that decided to wake and are bringing their window forward: out
   * of the map already, so nothing reads them, but a stop still ends them.
   */
  private waking = new Set<Watch>();
  private counter = 0;
  private paused = false;
  private runActive = false;
  private mode = false;
  /** Windows that showed no anchors, by when the model was told so. */
  private anchorless = new Map<string, number>();
  /** Wake-up runs started in the last hour, by window. */
  private wakes: { key: string; at: number }[] = [];
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  constructor(private o: WatchManagerOptions) {
    this.now = o.now ?? Date.now;
    this.setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      o.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /**
   * Takes a bound window from a monitor step; the first read comes after one
   * interval. Throws WatchRefusedError when as many windows as the helper
   * binds are watched already, when this window or watching as a whole has
   * woken the model too often in the last hour, or when the chain this watch
   * would continue has run as long, or woken the model as often, as it may:
   * the chain watch → wake → watch again has no other end.
   */
  start(binding: WatchBinding, spec: WatchStart): string {
    const now = this.now();
    const key = this.key(binding);
    const chain: WatchChain = spec.chain
      ? { ...spec.chain }
      : {
          startedAt: now,
          wakes: 0,
          ...(spec.origin ? { origin: spec.origin } : {}),
        };
    const chainLeftMs =
      this.settings().watchMaxMinutes * 60000 - (now - chain.startedAt);
    const refusal = this.refusal(key, now, chain, chainLeftMs);
    if (refusal) {
      trace(this.o.trace, "WatchRefused", { appId: binding.appId });
      throw new WatchRefusedError(refusal);
    }
    const anchorlessAt = this.anchorless.get(key);
    const timersOnly =
      anchorlessAt !== undefined && now - anchorlessAt < ANCHORLESS_TTL_MS;
    const w: Watch = {
      id: `w${++this.counter}`,
      runId: spec.runId,
      task: spec.task,
      ...(spec.taskSource ? { taskSource: spec.taskSource } : {}),
      ...(spec.origin ? { origin: spec.origin } : {}),
      ...(spec.appName ? { appName: spec.appName } : {}),
      notes: spec.notes.slice(-5),
      corrections: (spec.corrections ?? []).slice(-5),
      chain,
      binding,
      spec: {
        reason: spec.reason,
        everyMs: spec.everyMs,
        // A panel the rules cannot read is watched by the clock alone, and
        // not for long: the model already heard once that it cannot see it.
        // Nor does any watch outlast what is left of its chain.
        maxMs: Math.min(
          timersOnly ? Math.min(spec.maxMs, ANCHORLESS_MAX_MS) : spec.maxMs,
          chainLeftMs,
        ),
        until: spec.until,
        ...(timersOnly ? { timersOnly } : {}),
      },
      ide: !!ideFamily(binding.appId),
      memory: newWatchMemory(now),
      panelLines: [],
      probes: 0,
      seq: 0,
      ended: false,
      busy: false,
      factsLines: [],
    };
    this.watches.set(w.id, w);
    this.updateMode();
    trace(this.o.trace, "WatchStarted", {
      appId: binding.appId,
      mode: w.spec.until,
      delayMs: w.spec.everyMs,
      durationMs: w.spec.maxMs,
      fallback: timersOnly,
    });
    this.schedule(w, w.spec.everyMs);
    return w.id;
  }

  /** Stops ticking without ending the watches; resume() picks them back up. */
  pause() {
    this.paused = true;
    for (const w of this.watches.values()) this.unschedule(w);
  }
  resume() {
    if (!this.paused) return;
    this.paused = false;
    for (const w of this.watches.values()) this.schedule(w, 1000);
  }
  /**
   * Ends one watch or all of them; returns how many ended. A watch already
   * bringing its window forward for a wake is ended too, before its run is
   * queued.
   */
  stop(id?: string): number {
    const waking = [...this.waking].filter((w) => !id || w.id === id);
    for (const w of waking) {
      this.waking.delete(w);
      w.ended = true;
    }
    const targets = id
      ? [this.watches.get(id)].filter((w): w is Watch => !!w)
      : [...this.watches.values()];
    for (const w of [...targets, ...waking]) {
      this.remove(w);
      if (w.relay) this.o.onRelayGone?.(w.relay.id, "ended");
      void this.o.controller.unbindWatch(w.binding.token).catch(() => {});
      trace(this.o.trace, "WatchStopped", {
        appId: w.binding.appId,
        durationMs: this.now() - w.memory.startedAt,
      });
    }
    return targets.length + waking.length;
  }
  /**
   * The helper's Escape stop. While a watch is the only thing going on the
   * helper emits it for two Escapes within 0.8 s; during a run, for the one
   * Escape that stops the run. Either way it is the user's emergency stop,
   * and it ends every watch: it must never be weaker than a spoken "stop".
   */
  onEmergencyStop(): number {
    return this.stop();
  }
  list(): WatchState[] {
    return [...this.watches.values()].map((w) => this.state(w));
  }
  /** The facts as they stand; reading them changes nothing a report is measured against. */
  facts(id: string): ProgressFacts | undefined {
    const w = this.watches.get(id);
    return w ? this.factsOf(w) : undefined;
  }
  /**
   * Main says when a run is active. A wake waits for the run to end before
   * it takes the screen, and the double-Escape rule holds only while a watch
   * is the only thing going on: during a run, one Escape stays the emergency
   * stop it has always been.
   */
  setRunActive(active: boolean) {
    this.runActive = active;
    this.updateMode();
  }

  private key(binding: WatchBinding) {
    return `${binding.appId}:${binding.windowId}`;
  }
  /** Why a watch may not start now, or undefined. */
  private refusal(
    key: string,
    now: number,
    chain: WatchChain,
    chainLeftMs: number,
  ): string | undefined {
    if (this.watches.size >= WATCHES_MAX)
      return `${this.watches.size} windows are already being watched, the most at once; watching another is refused. Finish with done.`;
    if (chain.wakes >= CHAIN_WAKES_MAX)
      return `This watch has already woken you ${chain.wakes} times since the user asked; watching again is refused. Finish with done and tell the user what it shows now.`;
    // Less than a minute left is not worth a watch.
    if (chainLeftMs < 60000)
      return `Watching has gone on for ${Math.floor((now - chain.startedAt) / 60000)} minutes since the user asked, as long as the settings allow; watching again is refused. Finish with done and tell the user what it shows now.`;
    this.wakes = this.wakes.filter((k) => now - k.at < WAKE_WINDOW_MS);
    const window = this.wakes.filter((k) => k.key === key).length;
    if (window >= WAKES_PER_WINDOW_HOURLY)
      return `That window has already woken you ${window} times in the last hour; watching it again is refused. Finish with done and tell the user what it shows now.`;
    if (this.wakes.length >= WAKES_HOURLY)
      return `Watches have woken you ${this.wakes.length} times in the last hour; watching is refused until that settles. Finish with done.`;
    return undefined;
  }
  private updateMode() {
    const on = this.watches.size > 0 && !this.runActive;
    if (on === this.mode) return;
    this.mode = on;
    this.o.controller.setWatchMode(on).catch((error) => {
      trace(this.o.trace, "WatchModeFailed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  private schedule(w: Watch, ms: number) {
    if (w.ended || this.paused) return;
    this.unschedule(w);
    w.timer = this.setTimer(() => void this.tick(w), ms);
  }
  private unschedule(w: Watch) {
    if (w.timer !== undefined) this.clearTimer(w.timer);
    w.timer = undefined;
  }
  private remove(w: Watch) {
    w.ended = true;
    this.unschedule(w);
    this.watches.delete(w.id);
    this.updateMode();
  }
  private settings() {
    const s = this.o.settings();
    return {
      progressEveryMinutes: s.progressEveryMinutes,
      stallMinutes: s.stallMinutes,
      watchMaxMinutes: s.watchMaxMinutes,
    };
  }
  private maxMs(w: Watch) {
    return Math.min(w.spec.maxMs, this.settings().watchMaxMinutes * 60000);
  }
  private minutes(w: Watch) {
    return Math.max(0, Math.floor((this.now() - w.memory.startedAt) / 60000));
  }
  private state(w: Watch): WatchState {
    return {
      id: w.id,
      runId: w.runId,
      app: w.appName ?? w.binding.appId,
      ...(w.agent ? { agent: w.agent } : {}),
      state: w.memory.state,
      startedAt: w.memory.startedAt,
      lastChangeAt: w.memory.lastChangeAt,
      minutes: this.minutes(w),
    };
  }
  /**
   * The facts now. The change is measured against the last report, which
   * only report() moves on; the tail is the last read's lines from inside a
   * located panel, and there is none after a read of the window whole.
   */
  private factsOf(w: Watch): ProgressFacts {
    const change = materialChange(w.factsLines, w.memory.lastLines);
    const minutes = this.minutes(w);
    // How the chain was asked for, not "watch": who hears the news is the
    // same however many wakes later.
    const origin = w.chain.origin ?? w.origin;
    return {
      runId: w.runId,
      seq: ++w.seq,
      task: w.task,
      ...(origin ? { origin } : {}),
      status: "watching",
      activeMinutes: minutes,
      actions: 0,
      sinceLast: [],
      apps: [w.binding.appId],
      ...(w.appName ? { app: w.appName } : {}),
      corrections: [...w.corrections],
      detail: this.o.settings().messagesDetail,
      watch: {
        ...(w.agent ? { agent: w.agent } : {}),
        state: w.memory.state,
        minutes,
        change,
        ...(w.agent && w.panelLines.length
          ? { panelTail: panelTail(w.panelLines) }
          : {}),
      },
    };
  }
  private report(w: Watch, hint: FactsHint) {
    const facts = this.factsOf(w);
    w.factsLines = w.memory.lastLines;
    this.o.onFacts(facts, hint);
  }

  private async tick(w: Watch) {
    if (w.ended || this.paused || w.busy) return;
    w.busy = true;
    try {
      if (w.pendingWake) await this.tryWake(w);
      else await this.probe(w);
    } finally {
      w.busy = false;
    }
  }
  private async probe(w: Watch) {
    // The whole window is read on the first probe and every tenth one, so a
    // panel that moved or opened late is found again; in between only its
    // region is read. A whole read only locates the panel: what is kept of
    // it is the panel's part, like every other read. Outside a VS Code-family
    // editor there is no panel to find: the window is read whole, for change
    // and time alone.
    const full = !w.region || w.probes % COLUMN_REFRESH_PROBES === 0;
    w.probes++;
    let result: ProbeResult;
    try {
      result = await this.o.controller.probe(
        w.binding.token,
        full ? undefined : w.region,
      );
    } catch (error) {
      trace(this.o.trace, "WatchProbeFailed", {
        error: error instanceof Error ? error.message : String(error),
      });
      result = { ok: false, code: "failed" };
    }
    if (w.ended) return;
    const now = this.now();
    const expired = now - w.memory.startedAt >= this.maxMs(w);
    let digest: PanelDigest | undefined;
    if (!result.ok) {
      trace(this.o.trace, "WatchProbeSkipped", { code: result.code });
      switch (result.code) {
        case "secure_input":
        case "screen_locked":
          // Nothing to read right now, and nothing wrong with the window;
          // the clock still runs.
          if (expired) return this.wake(w, "expired", { focus: true });
          this.schedule(w, w.spec.everyMs);
          return;
        case "not_visible":
          if (expired) return this.wake(w, "expired", { focus: true });
          this.schedule(w, NOT_VISIBLE_MS);
          return;
        case "window_gone":
          return this.wake(w, "window_gone", { focus: false });
        case "protected":
          // The app became one the assistant must not read or bring forward.
          return this.wake(w, "probe_failed", { focus: false });
        case "failed":
          break;
      }
    } else {
      if (w.ide) {
        if (full) w.region = panelRegion(result.lines, w.agent);
        if (!w.agent) w.agent = resolveAgent(result.lines);
      }
      digest = digestPanel(result.lines, w.agent, w.region);
      // Only a read confined to a located panel may speak for it; a full
      // read that found no anchors (the panel closed) keeps nothing.
      w.panelLines = digest.region ? digest.lines : [];
    }
    const t = watchTick(w.memory, digest, now, w.spec, this.settings());
    w.memory = t.memory;
    if (t.stateChanged) {
      trace(this.o.trace, "WatchStateChanged", { status: t.stateChanged.to });
      this.report(w, { kind: "checkin" });
    }
    if (t.relayGone && w.relay?.key === t.relayGone) {
      trace(this.o.trace, "WatchRelayAnswered", { source: "on_screen" });
      this.o.onRelayGone?.(w.relay.id, "answered");
      w.relay = undefined;
    }
    const d = t.decision;
    switch (d.kind) {
      case "sleep":
        this.schedule(w, d.nextMs);
        return;
      case "summary":
        this.report(w, { kind: d.progress });
        this.schedule(w, w.spec.everyMs);
        return;
      case "relay": {
        const id = `r${++this.counter}`;
        w.relay = { id, key: d.relay.key };
        trace(this.o.trace, "WatchRelayRequested", {
          kind: d.relay.kind,
          source: w.agent,
        });
        this.o.onRelay?.({
          id,
          watchId: w.id,
          runId: w.runId,
          seq: ++w.seq,
          agent: w.agent!,
          kind: d.relay.kind,
          question: d.relay.question,
          allowLabel: d.relay.allowLabel,
          decline: d.relay.decline,
          key: d.relay.key,
          ...(w.chain.origin ? { origin: w.chain.origin } : {}),
        });
        this.schedule(w, RELAY_POLL_MS);
        return;
      }
      case "wake":
        return this.wake(w, d.cause, {
          focus: true,
          ...(w.agent && w.panelLines.length
            ? { panelTail: panelTail(w.panelLines) }
            : {}),
        });
    }
  }
  private async wake(
    w: Watch,
    cause: WakeCause,
    o: { focus: boolean; panelTail?: string },
  ) {
    if (cause === "unknown")
      this.anchorless.set(this.key(w.binding), this.now());
    w.pendingWake = {
      cause,
      focus: o.focus,
      since: this.now(),
      ...(o.panelTail ? { panelTail: o.panelTail } : {}),
    };
    trace(this.o.trace, "WatchWake", { cause, status: w.memory.state });
    await this.tryWake(w);
  }
  /** What holds a wake back right now, or undefined when it may go ahead. */
  private async hold(w: Watch): Promise<WakeHold | undefined> {
    if (this.runActive) return "run";
    let presence = this.o.presence.current();
    try {
      presence = await this.o.presence.refresh();
    } catch {
      presence = "unknown";
    }
    if (w.ended) return undefined;
    // A run may have started while presence was being asked.
    if (this.runActive) return "run";
    if (this.o.presence.locked()) return "locked";
    if (mayTakeScreen(presence, this.o.presence.idleMs(), "watch") !== "now")
      return "presence";
    if (this.o.canWake && !this.o.canWake()) return "queue";
    return undefined;
  }
  /**
   * Every wake starts a run that takes the screen, so every one waits for its
   * turn: no run going on, the Mac unlocked, nobody at it (right away when
   * nobody is, otherwise once the user has been away long enough), and room
   * in the queue. While it waits the reporter hears why, again whenever that
   * changes (the task that held it ended, but now the user is at the Mac),
   * and the watch checks every few seconds instead of reading the panel. A
   * wake let go because the user stayed at the Mac says so too. Whether the
   * window is brought forward first is the cause's business alone.
   */
  private async tryWake(w: Watch) {
    const pending = w.pendingWake;
    if (!pending || w.ended) return;
    const held = await this.hold(w);
    if (w.ended) return;
    const kind: ProgressKind =
      pending.cause === "done" || pending.cause === "error"
        ? "final"
        : "needs_you";
    if (held) {
      if (pending.held !== held) {
        pending.held = held;
        trace(this.o.trace, "WatchWakeWaiting", { cause: pending.cause });
        this.report(w, { kind, cause: pending.cause, held });
      }
      // Only someone at the Mac counts toward giving up: they heard about
      // it and the window is theirs. A run, a lock or a full queue ends.
      if (held !== "presence") pending.since = this.now();
      else if (this.now() - pending.since >= WAKE_PENDING_MAX_MS) {
        trace(this.o.trace, "WatchWakeDropped", { cause: pending.cause });
        this.report(w, { kind, cause: pending.cause, dropped: true });
        this.remove(w);
        if (w.relay) this.o.onRelayGone?.(w.relay.id, "ended");
        void this.o.controller.unbindWatch(w.binding.token).catch(() => {});
        return;
      }
      this.schedule(w, WAKE_RETRY_MS);
      return;
    }
    this.remove(w);
    this.waking.add(w);
    if (w.relay) this.o.onRelayGone?.(w.relay.id, "ended");
    w.relay = undefined;
    this.wakes.push({ key: this.key(w.binding), at: this.now() });
    if (pending.focus)
      try {
        await this.o.controller.focusWatch(w.binding.token);
      } catch (error) {
        trace(this.o.trace, "WatchFocusFailed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    try {
      await this.o.controller.unbindWatch(w.binding.token);
    } catch {}
    // A stop while the window was coming forward ends the wake here: the
    // user said stop after the watch decided, but before any run was queued.
    if (!this.waking.delete(w)) return;
    trace(this.o.trace, "WatchWoke", {
      cause: pending.cause,
      status: w.memory.state,
      durationMs: this.now() - w.memory.startedAt,
    });
    const origin = w.chain.origin ?? w.origin;
    this.o.onWake(this.state(w), pending.cause, {
      task: w.task,
      ...(w.taskSource ? { taskSource: w.taskSource } : {}),
      notes: [...w.notes],
      corrections: [...w.corrections],
      ...(pending.panelTail ? { panelTail: pending.panelTail } : {}),
      ...(origin ? { origin } : {}),
      ...(w.appName ? { appName: w.appName } : {}),
      chain: { ...w.chain, wakes: w.chain.wakes + 1 },
    });
  }
}
