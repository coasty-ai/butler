/**
 * Watching how the owner works (.data/design/observer.md §6), the app side:
 * pushes the "Watch how I work" setting and tier to the native stream
 * (controller.observe), receives its events (the controller's `observed`
 * hook) and writes them to the work log, which redacts, caps and encrypts;
 * pauses at once on the menu item or "stop watching" and resumes only on
 * the words or Settings; ticks the consolidator once a minute; offers a new
 * routine aloud at most once a day and never while a run is going; and
 * reports counts to the Watching pane. Nothing here acts on the screen.
 * Created with its dependencies handed in, so tests drive it with fakes.
 */
import type { ObserverTier, Settings, Snapshot } from "../src/core/schema";
import {
  errorDetails,
  trace,
  type DiagnosticSink,
} from "../src/core/diagnostics";
import type { MemoryData } from "../src/memory/types";
import type { WorkLog } from "../src/observer/log";
import type { Consolidator } from "../src/observer/consolidate";
import {
  observedEventSchema,
  type WatchingState,
  type WatchingStatus,
} from "../src/observer/types";
import { offerSentence } from "../src/observer/routines";
import { dayKey } from "../src/observer/log";
import type { ObserveOptions, ObserveState } from "./controller";
import type { Presence } from "./presence";

/** A frame at most this often while the owner is active (design §2). */
export const OBSERVE_EVERY_MS = 20_000;
/** The observer's clock: consolidation checks and offers. */
export const OBSERVER_TICK_MS = 60_000;
/** A typing burst this recent says the owner is typing in that application. */
export const TYPING_RECENT_MS = 30_000;
const TERMINAL = new Set(["completed", "cancelled", "failed"]);

export type { WatchingState, WatchingStatus };

export interface ObserverDeps {
  settings: () => Settings;
  /**
   * The native controller when one may be had (getNative(); may throw when
   * the helper is not built) or undefined off macOS. Starting the stream
   * spawns the helper; stopping one that never ran does nothing.
   */
  controller: () =>
    | {
        observe(o: ObserveOptions): Promise<ObserveState | void>;
        /** The run under way, so the stream marks its own frames (lane O1). */
        setObserveRun?(runId: string | undefined): void | Promise<void>;
      }
    | undefined;
  /** Whether a helper process exists already, so "off" need not spawn one. */
  helperRunning: () => boolean;
  log: WorkLog;
  consolidator: Consolidator;
  memory: () =>
    | { data(): MemoryData; update<T>(change: (data: MemoryData) => T): T }
    | undefined;
  runActive: () => boolean;
  presence: () => Presence;
  /** Speaks one line through the conversation (electron/conversation.ts say). */
  say: (text: string) => void;
  /** The menu bar and the pane follow the state. */
  onChange: () => void;
  trace?: DiagnosticSink;
  now?: () => Date;
  tickMs?: number;
}
export interface Observer {
  /** At startup: retention, the midnight pass, the clock, and the setting pushed to the helper. */
  start(): void;
  close(): void;
  /** Pushes the setting and tier in force to the stream; idempotent. */
  apply(): Promise<void>;
  /** The controller's `observed` hook. */
  observed(event: unknown): void;
  setPaused(paused: boolean): Promise<void>;
  readonly paused: boolean;
  state(): WatchingState;
  /** The menu-bar item's label, or undefined when watching is off. */
  menuLabel(): string | undefined;
  status(): WatchingStatus;
  forget(scope: "today" | "all"): WatchingStatus;
  /** Once a minute (the clock calls it; tests call it directly). */
  tick(): Promise<void>;
  /** The application the owner is typing in right now, when a burst was just seen. */
  typingIn(): string | undefined;
  onSnapshot(s: Snapshot): void;
}

export function createObserver(deps: ObserverDeps): Observer {
  const now = deps.now ?? (() => new Date());
  let paused = false;
  let applied: { on: boolean; tier: ObserverTier } | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastTyping: { appId: string; at: number } | undefined;
  let lastOfferDay = "";
  let applying: Promise<void> | undefined;
  let observeRun: string | undefined;
  const settings = () => deps.settings().observer;
  const state = (): WatchingState =>
    !settings().on ? "off" : paused ? "paused" : "on";
  const apply = async () => {
    const s = settings();
    const desired = { on: s.on && !paused, tier: s.tier };
    if (applied && applied.on === desired.on && applied.tier === desired.tier)
      return;
    // Turning the stream off needs no helper that is not running.
    if (!desired.on && !deps.helperRunning()) {
      applied = desired;
      return;
    }
    let controller: ReturnType<ObserverDeps["controller"]>;
    try {
      controller = deps.controller();
    } catch (error) {
      trace(deps.trace, "ObserverApplyFailed", errorDetails(error));
      return;
    }
    if (!controller) {
      applied = desired;
      return;
    }
    try {
      await controller.observe({
        on: desired.on,
        tier: desired.tier,
        everyMs: OBSERVE_EVERY_MS,
      });
      applied = desired;
      trace(deps.trace, "ObserverApplied", {
        on: desired.on,
        tier: desired.tier,
      });
    } catch (error) {
      trace(deps.trace, "ObserverApplyFailed", errorDetails(error));
    }
  };
  const applyOnce = () => {
    applying ??= apply().finally(() => {
      applying = undefined;
    });
    return applying;
  };
  const offer = () => {
    const memory = deps.memory();
    if (!memory || deps.runActive() || deps.presence() !== "present") return;
    const day = dayKey(now());
    if (lastOfferDay === day) return;
    const routine = memory
      .data()
      .routines.find((r) => r.status === "proposed" && !r.offeredAt);
    if (!routine) return;
    lastOfferDay = day;
    const stamp = now().toISOString();
    memory.update((data) => {
      const r = data.routines.find((x) => x.id === routine.id);
      if (r) r.offeredAt = stamp;
    });
    deps.say(offerSentence(routine));
    trace(deps.trace, "RoutineOffered", { routineId: routine.id });
  };
  const status = (): WatchingStatus => {
    const s = settings();
    const c = deps.consolidator.status();
    return {
      on: s.on,
      tier: s.tier,
      paused,
      state: state(),
      retentionDays: s.retentionDays,
      path: deps.log.directory,
      today: deps.log.dayDigest(),
      days: deps.log.days(),
      bytes: deps.log.bytes(),
      consolidation: {
        ...c,
        budget: s.dailyTokenBudget,
        idleMinutes: s.consolidateWhenIdleMin,
      },
    };
  };
  const observer: Observer = {
    start() {
      try {
        const { removed, imagesExpired } = deps.log.applyRetention();
        trace(deps.trace, "ObserverRetention", {
          removed: removed.length,
          imagesExpired,
        });
      } catch (error) {
        trace(deps.trace, "ObserverRetentionFailed", errorDetails(error));
      }
      deps.log.scheduleMidnight();
      if (!timer) {
        timer = setInterval(
          () => void observer.tick(),
          deps.tickMs ?? OBSERVER_TICK_MS,
        );
        timer.unref?.();
      }
      void applyOnce();
    },
    close() {
      if (timer) clearInterval(timer);
      timer = undefined;
      deps.log.close();
    },
    apply: applyOnce,
    observed(raw) {
      const parsed = observedEventSchema.safeParse(raw);
      if (!parsed.success) {
        trace(deps.trace, "ObserverEventInvalid");
        return;
      }
      const event = parsed.data;
      if (event.event === "observe_dropped") {
        const dropped = event.dropped ?? event.count ?? 1;
        trace(deps.trace, "ObserverDropped", {
          dropped,
          ...(event.reason ? { reason: event.reason } : {}),
        });
        deps.log.noteHelperDrop(dropped);
        return;
      }
      if (event.event === "observe_action" && event.kind === "typing")
        lastTyping = { appId: event.appId, at: now().getTime() };
      // With watching off or paused nothing is kept, whatever arrived late.
      const result =
        state() === "on"
          ? deps.log.append(event)
          : ({ written: false, reason: "paused" } as const);
      if (event.event === "observe_frame")
        trace(deps.trace, "ObserverFrame", {
          appId: event.appId,
          ...(event.excluded ? { excluded: event.excluded } : {}),
          ...(result.written ? { bytes: result.bytes } : {}),
        });
      else trace(deps.trace, "ObserverAction", { kind: event.kind });
      if (!result.written)
        trace(deps.trace, "ObserverFrameDropped", { reason: result.reason });
    },
    async setPaused(next) {
      if (paused === next) return;
      paused = next;
      if (next) deps.log.pause();
      else deps.log.resume();
      trace(deps.trace, next ? "ObserverPaused" : "ObserverResumed");
      await applyOnce();
      deps.onChange();
    },
    get paused() {
      return paused;
    },
    state,
    menuLabel() {
      switch (state()) {
        case "off":
          return undefined;
        case "on":
          return "Watching how you work (pause)";
        case "paused":
          return "Watching paused (resume)";
      }
    },
    status,
    forget(scope) {
      deps.log.forget(scope);
      trace(deps.trace, "ObserverForgotten", { scope });
      return status();
    },
    async tick() {
      await applyOnce();
      if (state() !== "on") return;
      try {
        await deps.consolidator.tick();
      } catch (error) {
        trace(deps.trace, "ObserverConsolidateFailed", errorDetails(error));
      }
      try {
        offer();
      } catch (error) {
        trace(deps.trace, "RoutineOfferFailed", errorDetails(error));
      }
    },
    typingIn() {
      if (!lastTyping) return undefined;
      return now().getTime() - lastTyping.at <= TYPING_RECENT_MS
        ? lastTyping.appId
        : undefined;
    },
    onSnapshot(s) {
      // The stream excludes Butler's own runs at the source (design §2) and
      // marks their frames with the run id the app hands it: set at the
      // run's start, cleared at its end, only while a helper exists.
      const run = s.run && !TERMINAL.has(s.run.status) ? s.run : null;
      const next = run?.id;
      if (next === observeRun) return;
      observeRun = next;
      if (!deps.helperRunning()) return;
      try {
        void Promise.resolve(deps.controller()?.setObserveRun?.(next)).catch(
          (error) =>
            trace(deps.trace, "ObserverRunFailed", errorDetails(error)),
        );
      } catch (error) {
        trace(deps.trace, "ObserverRunFailed", errorDetails(error));
      }
    },
  };
  return observer;
}
