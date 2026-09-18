/**
 * The one progress reporter: it follows every run through its snapshots,
 * keeps the active clock, asks the text model for a summary when an update
 * is due, and hands one report to every sink (spoken replies, iMessage, the
 * phone remote). One summarizer call serves them all, and "how's it going?"
 * from any channel reuses the last answer for the same facts. The rules it
 * applies live in src/assistant/progress.ts; this file owns the clocks, the
 * in-flight call and the model client.
 */
import type { RunStatus, Settings, Snapshot, Usage } from "../src/core/schema";
import { terminal } from "../src/core/runner";
import {
  errorDetails,
  trace,
  type DiagnosticSink,
} from "../src/core/diagnostics";
import { completeText, textSettings } from "../src/providers/text";
import type {
  ProgressFacts,
  ProgressKind,
  ProgressReport,
  ProgressSink,
} from "../src/assistant/types";
import {
  HourlyBudget,
  PROGRESS_PROMPT,
  SUMMARY_DEADLINE_MS,
  SUMMARY_MAX_OUTPUT_TOKENS,
  WATCH_NEEDS_YOU,
  advanceActive,
  boundWatchFacts,
  filterSummary,
  finalDue,
  isActiveStatus,
  progressAudience,
  progressDue,
  progressFacts,
  safeProgressLine,
  summarizerAllowed,
  summaryInput,
  type ActiveTime,
} from "../src/assistant/progress";
import { momentKey } from "./conversation";
import type { PresenceService } from "./presence";

/** "How's it going?" asks the model at most this often per run. */
export const PROGRESS_REQUEST_MIN_MS = 30000;
/** Statuses in which the run waits for the owner. */
const HELD: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "confirming",
  "takeover",
  "paused",
]);
/** How a run, or the watched agent, ended; the sinks word it. */
function outcomeOf(f: ProgressFacts): "completed" | "failed" {
  const failed = f.watch ? f.watch.state === "error" : f.status === "failed";
  return failed ? "failed" : "completed";
}
/** The clock and the due check run this often while a run is active. */
export const PROGRESS_TICK_MS = 30000;

export type Summarize = (
  f: ProgressFacts,
  kind: ProgressKind,
  signal: AbortSignal,
) => Promise<{ text: string; usage?: Usage } | undefined>;

export interface ProgressReporterOptions {
  settings: () => Settings;
  presence: PresenceService;
  /**
   * Facts kept elsewhere for a run id, such as a detached watch's (increment
   * 5A). Consulted first by request(); the reporter builds its own facts
   * from snapshots for runs it followed.
   */
  facts?: (runId: string) => ProgressFacts | undefined;
  summarize: Summarize;
  /** Counts a summary's usage toward the run's maxCost (Runner.addUsage). */
  addUsage: (runId: string, usage: Usage) => void;
  sinks: ProgressSink[];
  now?: () => number;
  trace?: DiagnosticSink;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** What the reporter remembers about one run between snapshots. */
interface Track {
  runId: string;
  snapshot: Snapshot;
  /** The status last seen, to notice the run leaving the active states. */
  status?: RunStatus;
  time: ActiveTime;
  /** Facts seq of the last update sent, so "since last" starts after it. */
  lastSeq: number;
  lastUpdateMinutes: number;
  lastChangeMinutes: number;
  /** Change detection between updates, independent of the update itself. */
  lastActions: number;
  lastCorrections: number;
  /** run.actions when the last update went out: the raw count of new steps. */
  actionsAtUpdate: number;
  correctionsSeen: number;
  /**
   * Apps already reported, seeded with the ones present when the run was
   * first seen with a frame: the app it started in was not "entered".
   */
  appsSeen: Set<string>;
  appsSeeded: boolean;
  /**
   * The moment key of the hold the run is in (an approval, a takeover, a
   * pause; the sinks' own key, so a silent pause is none), and whether the
   * away owner still has to be told about it.
   */
  hold?: string;
  holdPending: boolean;
  previous?: string;
  heartbeatSent: boolean;
  finalDone: boolean;
  inflight?: {
    seq: number;
    kind: ProgressKind;
    abort: AbortController;
    promise: Promise<ProgressReport | undefined>;
  };
  lastRequestAt?: number;
  lastReport?: ProgressReport;
  /** Watch bookkeeping: the last watch minutes an update went out at. */
  watchUpdateMinutes?: number;
  watchStarted?: boolean;
}

export class ProgressReporter {
  private tracks = new Map<string, Track>();
  private timer?: unknown;
  private awaySince?: number;
  private closed = false;
  private readonly now: () => number;
  private readonly budget: HourlyBudget;
  constructor(private readonly options: ProgressReporterOptions) {
    this.now = options.now ?? Date.now;
    this.budget = new HourlyBudget(
      () => this.options.settings().dialogHourlyCost,
    );
  }

  /** Call from emit(): follows the run, and reports when an update is due. */
  onSnapshot(s: Snapshot): void {
    const run = s.run;
    if (!run || this.closed) return;
    const now = this.now();
    this.observePresence(now);
    const track = this.track(run.id);
    const wasActive =
      track.status !== undefined && isActiveStatus(track.status);
    track.snapshot = s;
    track.status = run.status;
    track.time = advanceActive(track.time, run.status, now);
    // A new hold is news for an owner who is away; the same one is not.
    const hold = HELD.has(run.status) ? momentKey(s) : undefined;
    if (hold !== track.hold) {
      track.hold = hold;
      track.holdPending = hold !== undefined;
    }
    if (
      wasActive &&
      !isActiveStatus(run.status) &&
      track.inflight &&
      track.inflight.kind !== "final"
    ) {
      // A summary written for a working run would arrive stale once it waits
      // for the owner or ends; nothing is said, and nothing counts as sent.
      track.inflight.abort.abort();
    }
    if (terminal(run.status)) {
      const minutes = Math.floor(track.time.activeMs / 60000);
      if (!track.finalDone && finalDue(run.status, minutes)) {
        track.finalDone = true;
        void this.produce(track, "final", this.factsOf(track), {});
      }
      this.stopTimerIfIdle();
      // Forgotten once nothing is in flight; request() on a finished run
      // answers from the run view, not from here.
      if (!track.inflight) this.tracks.delete(run.id);
      return;
    }
    this.startTimer();
    this.evaluate(track);
  }

  /**
   * Facts pushed by a watcher (increment 5A) whenever it has something to
   * report; the watcher applies its own cadence. Deduplicated by seq, and
   * periodic kinds also by progressEveryMinutes, so a chatty watcher cannot
   * flood the phone.
   */
  onWatchFacts(raw: ProgressFacts): void {
    if (this.closed) return;
    const f = boundWatchFacts(raw);
    const track = this.track(f.runId);
    const state = f.watch?.state ?? "working";
    const every = this.options.settings().progressEveryMinutes;
    let kind: ProgressKind;
    if (!track.watchStarted) {
      track.watchStarted = true;
      kind = "started";
    } else if (state === "done" || state === "error") kind = "final";
    else if (WATCH_NEEDS_YOU.has(state)) kind = "needs_you";
    else if (f.watch && f.watch.change >= this.options.settings().stallMinutes)
      kind = "stalled";
    else kind = "summary";
    if (track.lastReport?.seq === f.seq) return;
    if (kind === "summary" || kind === "stalled") {
      if (every <= 0) return;
      const minutes = f.watch?.minutes ?? f.activeMinutes;
      if (
        track.watchUpdateMinutes !== undefined &&
        minutes - track.watchUpdateMinutes < every
      )
        return;
      track.watchUpdateMinutes = minutes;
    }
    if (kind === "started") track.watchUpdateMinutes = f.watch?.minutes ?? 0;
    void this.produce(track, kind, f, {});
  }

  /**
   * A report on demand, for "how's it going?" from any channel: at most one
   * model call per 30 s per run, and the same facts (runId, seq) always get
   * the same report, so a spoken and a texted question share one call. Not
   * delivered to the sinks: the asker delivers it. Undefined when nothing is
   * known about the run.
   */
  async request(
    runId: string,
    o: { audience: "voice" | "text"; force?: boolean },
  ): Promise<ProgressReport | undefined> {
    if (this.closed) return undefined;
    const now = this.now();
    const external = this.options.facts?.(runId);
    const track = this.tracks.get(runId);
    if (!external && !track) return undefined;
    const t = track ?? this.track(runId);
    const facts = external ?? this.factsOf(t);
    if (!facts) return undefined;
    const audience = (r: ProgressReport): ProgressReport => ({
      ...r,
      speak: o.audience === "voice",
      send: o.audience === "text",
    });
    // The same facts get the same report whatever kind first produced it:
    // a cadence update already written is the answer to the question.
    const cached = t.lastReport;
    if (cached && cached.seq === facts.seq) return audience(cached);
    if (t.inflight && t.inflight.seq === facts.seq) {
      const shared = await t.inflight.promise;
      return shared ? audience(shared) : undefined;
    }
    if (
      !o.force &&
      t.lastRequestAt !== undefined &&
      now - t.lastRequestAt < PROGRESS_REQUEST_MIN_MS
    )
      return cached ? audience(cached) : undefined;
    t.lastRequestAt = now;
    const report = await this.produce(t, "summary", facts, {
      deliver: false,
      // An explicit question gets an answer even when nothing changed.
      fallbackOnNoChange: true,
    });
    return report ? audience(report) : undefined;
  }

  close(): void {
    this.closed = true;
    this.stopTimer();
    for (const t of this.tracks.values()) t.inflight?.abort.abort();
    this.tracks.clear();
  }

  // internals

  private track(runId: string): Track {
    let t = this.tracks.get(runId);
    if (!t) {
      t = {
        runId,
        snapshot: { run: null, frame: null, events: [], message: "" },
        time: { activeMs: 0 },
        lastSeq: 0,
        lastUpdateMinutes: 0,
        lastChangeMinutes: 0,
        lastActions: 0,
        lastCorrections: 0,
        actionsAtUpdate: 0,
        correctionsSeen: 0,
        appsSeen: new Set(),
        appsSeeded: false,
        holdPending: false,
        heartbeatSent: false,
        finalDone: false,
      };
      this.tracks.set(runId, t);
      // Bounded: a finished run is dropped above; this only guards a leak.
      if (this.tracks.size > 20)
        this.tracks.delete(this.tracks.keys().next().value!);
    }
    return t;
  }
  private factsOf(t: Track): ProgressFacts | undefined {
    if (!t.snapshot.run) return undefined;
    return progressFacts(t.snapshot, {
      sinceSeq: t.lastSeq,
      correctionsSeen: t.correctionsSeen,
      previous: t.previous,
      detail: this.options.settings().messagesDetail,
      activeMs: t.time.activeMs,
    });
  }
  /** Notes changes since the last look, then reports if an update is due. */
  private evaluate(t: Track) {
    const run = t.snapshot.run;
    if (!run || t.inflight) return;
    const facts = this.factsOf(t);
    if (!facts) return;
    if (t.holdPending) this.notifyHold(t, facts);
    const corrections = run.corrections?.length ?? 0;
    if (!t.appsSeeded && facts.app) {
      for (const app of facts.apps) t.appsSeen.add(app);
      t.appsSeeded = true;
    }
    const newApp = facts.apps.some((a) => !t.appsSeen.has(a));
    if (
      run.actions !== t.lastActions ||
      corrections !== t.lastCorrections ||
      newApp
    ) {
      t.lastChangeMinutes = facts.activeMinutes;
      t.heartbeatSent = false;
    }
    t.lastActions = run.actions;
    t.lastCorrections = corrections;
    const kind = progressDue({
      everyMinutes: this.options.settings().progressEveryMinutes,
      status: run.status,
      activeMinutes: facts.activeMinutes,
      lastUpdateMinutes: t.lastUpdateMinutes,
      lastChangeMinutes: t.lastChangeMinutes,
      changed: {
        // Raw: four presses of the same key are one line but four steps.
        actions: run.actions - t.actionsAtUpdate,
        newApp,
        corrections: facts.corrections.length,
      },
      heartbeatSent: t.heartbeatSent,
    });
    if (!kind) return;
    void this.produce(t, kind, facts, {
      unchangedMinutes: facts.activeMinutes - t.lastChangeMinutes,
    });
  }
  /**
   * A run that stopped for the owner is a run moment: every sink says it
   * itself, in its own words, so this report is never spoken and a joined
   * run's sink ignores it. It exists for the owner who is away from a run
   * they started at the desk, whom no sink has joined yet: one fixed line
   * per hold, sent as soon as the away rule allows, with no model call. The
   * steps stay untold, so the next check-in still covers them.
   */
  private notifyHold(t: Track, facts: ProgressFacts) {
    const now = this.now();
    const { send } = progressAudience({
      kind: "needs_you",
      origin: facts.origin,
      presence: this.options.presence.current(),
      awayForMs: this.awayFor(now),
      agentInputAgoMs: this.agentInputAgo(t, now),
      settings: this.options.settings(),
    });
    if (!send) return;
    t.holdPending = false;
    const text = safeProgressLine(facts, "needs_you");
    this.trace("ProgressReported", {
      runId: t.runId,
      kind: "needs_you",
      code: "fixed",
      textLength: text.length,
      sequence: facts.seq,
    });
    this.deliver({
      runId: t.runId,
      seq: facts.seq,
      kind: "needs_you",
      text,
      at: now,
      speak: false,
      send: true,
      fallback: true,
    });
  }
  /**
   * One report: the model's summary when allowed and usable, the fixed line
   * otherwise. Delivered to every sink unless the caller delivers it. The
   * facts are marked as told either way, so a refused or failed summary is
   * not retried on the next snapshot.
   */
  private produce(
    t: Track,
    kind: ProgressKind,
    facts: ProgressFacts | undefined,
    o: {
      deliver?: boolean;
      fallbackOnNoChange?: boolean;
      unchangedMinutes?: number;
    },
  ): Promise<ProgressReport | undefined> {
    if (!facts) return Promise.resolve(undefined);
    // One model call per set of facts: a question while a cadence update is
    // being written shares it (and the update still reaches the sinks).
    if (t.inflight && t.inflight.seq === facts.seq) return t.inflight.promise;
    const abort = new AbortController();
    const promise = this.write(t, kind, facts, abort.signal, o).finally(() => {
      if (t.inflight?.abort === abort) t.inflight = undefined;
      if (t.snapshot.run && terminal(t.snapshot.run.status))
        this.tracks.delete(t.runId);
    });
    t.inflight = { seq: facts.seq, kind, abort, promise };
    return promise;
  }
  private async write(
    t: Track,
    kind: ProgressKind,
    facts: ProgressFacts,
    signal: AbortSignal,
    o: {
      deliver?: boolean;
      fallbackOnNoChange?: boolean;
      unchangedMinutes?: number;
    },
  ): Promise<ProgressReport | undefined> {
    const settings = this.options.settings();
    const now = this.now();
    let text: string | undefined;
    let code = "fixed";
    // The fixed lines never need the model: a watch start is a sentence.
    const ask =
      kind !== "started" &&
      summarizerAllowed(settings) &&
      this.budget.allows(now);
    if (ask) {
      try {
        // The abort wins even over a summarizer that ignores its signal: the
        // run's reporting must never wait on a call that will not return.
        const answer = await new Promise<Awaited<ReturnType<Summarize>>>(
          (resolve, reject) => {
            if (signal.aborted) return resolve(undefined);
            signal.addEventListener("abort", () => resolve(undefined), {
              once: true,
            });
            this.options.summarize(facts, kind, signal).then(resolve, reject);
          },
        );
        if (signal.aborted) return undefined;
        if (answer?.usage) {
          this.budget.spend(answer.usage, this.now());
          this.options.addUsage(t.runId, answer.usage);
        }
        const filtered = filterSummary(answer?.text, kind);
        code = filtered.code;
        if (filtered.code === "ok") text = filtered.text;
        else if (filtered.code === "no_change" && !o.fallbackOnNoChange) {
          // Nothing worth saying: told, so the next look starts from here.
          this.told(t, facts, kind);
          this.trace("ProgressSkipped", { runId: t.runId, kind, code });
          return undefined;
        }
      } catch (error) {
        if (signal.aborted) return undefined;
        code = "error";
        this.trace("ProgressSummaryFailed", {
          runId: t.runId,
          kind,
          ...errorDetails(error),
        });
      }
    } else if (kind !== "started") code = "off";
    if (signal.aborted) return undefined;
    const fallback = text === undefined;
    if (kind === "final" && fallback && !facts.watch) {
      // Every sink already gives the run's own summary as its done moment;
      // the fixed recap would only repeat it. A watch's fixed ending is its
      // only ending (the run completed at the handoff), so that one stands.
      this.told(t, facts, kind);
      this.trace("ProgressSkipped", { runId: t.runId, kind, code });
      return undefined;
    }
    // The fixed line is built from model-chosen labels, so it is checked
    // like the model's own text and shortened rather than trusted.
    const line =
      text ??
      safeProgressLine(facts, kind, { unchangedMinutes: o.unchangedMinutes });
    const presence = this.options.presence.current();
    const audience = progressAudience({
      kind,
      origin: facts.origin,
      presence,
      awayForMs: this.awayFor(this.now()),
      agentInputAgoMs: this.agentInputAgo(t, this.now()),
      settings,
    });
    const report: ProgressReport = {
      runId: t.runId,
      seq: facts.seq,
      kind,
      text: line,
      at: this.now(),
      ...audience,
      fallback,
      ...(kind === "final" ? { outcome: outcomeOf(facts) } : {}),
    };
    this.told(t, facts, kind);
    t.previous = line;
    t.lastReport = report;
    this.trace("ProgressReported", {
      runId: t.runId,
      kind,
      code: fallback ? code : "model",
      textLength: line.length,
      sequence: facts.seq,
    });
    if (o.deliver !== false) this.deliver(report);
    return report;
  }
  private deliver(report: ProgressReport) {
    for (const sink of this.options.sinks)
      try {
        sink.onProgress(report);
      } catch (error) {
        this.trace("ProgressSinkFailed", errorDetails(error));
      }
  }
  /** The facts were reported (or deliberately not): start the next window. */
  private told(t: Track, facts: ProgressFacts, kind: ProgressKind) {
    t.lastSeq = facts.seq;
    t.lastUpdateMinutes = facts.activeMinutes;
    t.actionsAtUpdate = facts.actions;
    t.correctionsSeen += facts.corrections.length;
    for (const app of facts.apps) t.appsSeen.add(app);
    if (kind === "stalled") t.heartbeatSent = true;
  }
  /** Presence is sampled on every look; "away" must hold without a break. */
  private observePresence(now: number) {
    if (this.options.presence.current() === "away") this.awaySince ??= now;
    else this.awaySince = undefined;
  }
  private awayFor(now: number): number {
    this.observePresence(now);
    return this.awaySince === undefined ? 0 : now - this.awaySince;
  }
  /** When the run last posted input itself, from its own journal. */
  private agentInputAgo(t: Track, now: number): number {
    const events = t.snapshot.events;
    for (let i = events.length - 1; i >= 0; i--)
      if (events[i].type === "ActionExecuted") {
        const at = Date.parse(events[i].wall_clock_timestamp);
        return Number.isFinite(at) ? Math.max(0, now - at) : Infinity;
      }
    return Infinity;
  }
  private startTimer() {
    if (this.timer !== undefined) return;
    const setTimer =
      this.options.setTimer ??
      ((fn: () => void, ms: number) => {
        const handle = setTimeout(fn, ms);
        handle.unref?.();
        return handle;
      });
    const tick = () => {
      this.timer = undefined;
      if (this.closed) return;
      const now = this.now();
      let active = false;
      for (const t of this.tracks.values()) {
        const run = t.snapshot.run;
        if (!run || terminal(run.status)) continue;
        active = true;
        t.time = advanceActive(t.time, run.status, now);
        this.evaluate(t);
      }
      if (active) this.timer = setTimer(tick, PROGRESS_TICK_MS);
    };
    this.timer = setTimer(tick, PROGRESS_TICK_MS);
  }
  private stopTimerIfIdle() {
    for (const t of this.tracks.values())
      if (t.snapshot.run && !terminal(t.snapshot.run.status)) return;
    this.stopTimer();
  }
  private stopTimer() {
    const clear =
      this.options.clearTimer ??
      ((handle: unknown) =>
        clearTimeout(handle as ReturnType<typeof setTimeout>));
    if (this.timer !== undefined) clear(this.timer);
    this.timer = undefined;
  }
  private trace(event: string, data: Record<string, unknown> = {}) {
    trace(this.options.trace, event, data);
  }
}

/**
 * The summarizer main passes in: one completeText call on the dialog model
 * (or the run model) with the progress prompt, an 8 s deadline and one
 * retry, since it is off the run's critical path. Content never reaches
 * diagnostics; the text client traces timings and codes only.
 */
export function createProgressSummarizer(o: {
  settings: () => Settings;
  key: () => string;
  fetch: typeof globalThis.fetch;
  trace?: DiagnosticSink;
}): Summarize {
  return async (facts, kind, signal) => {
    const result = await completeText(
      textSettings(o.settings()),
      o.key(),
      {
        system: PROGRESS_PROMPT,
        input: summaryInput(facts, kind),
        maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
        effort: "low",
      },
      o.fetch,
      signal,
      { deadlineMs: SUMMARY_DEADLINE_MS, retry: true, diagnostics: o.trace },
    );
    if (result.code === "refused" || result.code === "empty")
      return { text: "", usage: result.usage };
    return { text: result.text, usage: result.usage };
  };
}
