/**
 * Acts on each clause of the sentence while the user is still speaking
 * (.data/design/streaming-execution.md §3.3). "Go to youtube and play a
 * midwest safety video": the clause stream (src/voice/stream.ts) commits
 * "go to youtube" the moment "and play" follows it, the fast decider
 * (src/voice/fast.ts) turns it into open_url of YouTube's home, and the
 * browser is told the address before the next clause is spoken; "play a
 * midwest safety video" commits by stability and loads the results page.
 * The run that starts at the final receives the steps (StartOptions.streamed)
 * and continues from the screen as they left it.
 *
 * What may run here is navigation and nothing else: open_url built from a
 * site recipe, open_app of a later clause's application, a continuous
 * scroll. Every fast action goes through evaluate() with speaking: true,
 * which allows exactly those and refuses a protected host outright, and is
 * executed only on ALLOW: no retry, no question, no hand-off. Nothing is
 * typed, clicked or sent, nothing is spoken while the user speaks, and the
 * pill alone says what is happening. The leading clause's application or
 * folder is the early start's step (electron/early-start.ts), which reads
 * the same partials and gives the run its prelude; opening it here too would
 * be the same launch twice, so an open_app on clause 0 is left to it. A
 * later clause's open_app takes the early step's own launcher checks
 * (verifyOpening) and runs on its native chain, so the helper's stop latch
 * is never lifted by one while the other's step is in flight.
 *
 * A clause the recognizer rewrites after its action ran (superseded), or one
 * the final no longer says (dropped), is navigation only: nothing to undo,
 * and the run is told it was done by mistake. A final the router does not
 * start (a question, a fragment) leaves what was opened as it is, and the
 * pill says so. Diagnostics carry codes and numbers, never a word or a URL.
 */
import type {
  Action,
  ExecutionResult,
  Frame,
  Settings,
  Surface,
} from "../src/core/schema";
import { actionSchema, webAddress } from "../src/core/schema";
import { evaluate, surfacePolicy } from "../src/core/policy";
import { nativeAction } from "../src/core/runner";
import { trace, type DiagnosticSink } from "../src/core/diagnostics";
import { scanText } from "../src/core/sanitize";
import {
  streamedPillLabel,
  streamedSummary,
  type StreamedStep,
} from "../src/core/streamed";
import { EARLY_LIMITS } from "../src/voice/early";
import {
  STREAM_LIMITS,
  createClauseStream,
  type Clause,
  type ClauseEvent,
  type ClauseStream,
} from "../src/voice/stream";
import { createJevClauseClient } from "../src/providers/jev-clause";
import {
  decideFast,
  decideFastWithJev,
  type FastAction,
  type FastContext,
  type JevClient,
} from "../src/voice/fast";
import {
  verifyOpening,
  type EarlyCode,
  type EarlyController,
  type EarlyStart,
} from "./early-start";

export type StreamCode = EarlyCode | "ptt" | "window";
/** The native calls a fast action makes; NativeController satisfies it. */
export interface StreamController extends EarlyController {
  /** The browser is told the address (electron/open-url.ts); the helper is not asked. */
  openUrl(
    action: Extract<Action, { type: "open_url" }>,
  ): Promise<void | ExecutionResult>;
}
export interface StreamingDeps {
  /** undefined off macOS or without the helper. */
  controller(): StreamController | undefined;
  settings(): Settings;
  /** main's reasons not to act now: a run, an approval, the queue, push-to-talk, an answer window. */
  blocked(): StreamCode | undefined;
  /** The browser a web address opens in (the early start's rule), by name. */
  browser?(): string | undefined;
  /**
   * The early start of the same activation: its native chain (section) and
   * whether it is opening the leading clause's app itself (engaged).
   */
  early: Pick<EarlyStart, "section" | "engaged">;
  /** main's continuous scroll: the helper paces it until the user says stop. */
  scroll(direction: "down" | "up"): Promise<void>;
  /** The Jev client while the decider is on (--decide-with-jev or the setting). */
  jev?(): JevClient | undefined;
  /** A fast action was issued; main shows the line on the listening pill. Nothing speaks it. */
  onAction(label: string): void;
  /** The final started no run: the pill says what was opened. */
  onLeft?(summary: string): void;
  trace: DiagnosticSink;
  /** For tests: the stream, the deciders and the clock. */
  stream?(): ClauseStream;
  decide?: { fast: typeof decideFast; withJev: typeof decideFastWithJev };
  now?(): number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(t: unknown): void;
}
/** The steps a final kept, for the run it starts. */
export interface StreamClaim {
  /** The steps so far; more may still be in flight until take() resolves. */
  readonly steps: readonly StreamedStep[];
  /** The run takes the steps: resolves once every step in flight has ended. */
  take(): Promise<StreamedStep[]>;
  /** The turn started no run; what was opened stays as it is. */
  release(code: StreamCode | "plan_not_start" | "run_active_at_final"): void;
}
interface Recorded extends StreamedStep {
  clauseText: string;
}
interface Committed {
  clause: Clause;
  by: "boundary" | "stable";
  /** When the commit was heard (the stream's own time when it says). */
  at: number;
  /** The committed clause this one replaces (the recognizer rewrote or grew it). */
  replaces?: Clause;
}
interface StreamTurn {
  invocation: number;
  ready: Promise<unknown>;
  stream: ClauseStream;
  abort: AbortController;
  /** This turn's clause work, one at a time and in order. */
  chain: Promise<void>;
  inFlight: number;
  steps: Recorded[];
  committed: Committed[];
  /** Clauses rewritten or dropped: their queued work is skipped. */
  superseded: Set<string>;
  /** The front surface last read, for the next clause's context. */
  front?: Surface;
  /** Where the last open_url sent the browser: the next clause's front host and app. */
  sent?: { host: string; appId?: string };
  /** The last partial heard, re-pushed after STREAM_LIMITS.stableMs so a clause commits in silence. */
  lastPartial?: string;
  timer?: unknown;
  configured?: boolean;
  primed?: { frame: Frame; at: number };
  /** A fast action was issued: the prepared first step is stale. */
  acted?: boolean;
  ended?: boolean;
  finishedAt?: number;
}
/** The frame id a fast action carries: it has no frame of its own. */
const STREAM_FRAME = "streamed";
const clauseKey = (c: Clause) => `${c.index}:${c.text}`;
const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;
const none = (reason: "unsure"): FastAction => ({ kind: "none", reason });
/** The same navigation: a rewritten clause that decides to it changes nothing. */
function sameAction(a: FastAction, b: FastAction): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "open_url":
      return b.kind === "open_url" && a.url === b.url;
    case "open_app":
      return (
        b.kind === "open_app" && a.name.toLowerCase() === b.name.toLowerCase()
      );
    case "scroll":
      return b.kind === "scroll" && a.direction === b.direction;
    default:
      return false;
  }
}

export class StreamingTurn {
  private turn?: StreamTurn;
  private readonly now: () => number;
  private readonly stream: () => ClauseStream;
  private readonly decide: {
    fast: typeof decideFast;
    withJev: typeof decideFastWithJev;
  };
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;
  constructor(private readonly deps: StreamingDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.stream = deps.stream ?? createClauseStream;
    this.decide = deps.decide ?? {
      fast: decideFast,
      withJev: decideFastWithJev,
    };
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      deps.clearTimer ??
      ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }
  /** A new voice activation; ends any previous turn (what it opened stays). */
  begin(invocation: number, ready: Promise<unknown>) {
    const previous = this.turn;
    if (previous && !previous.ended) this.end(previous, "reactivated");
    ready.catch(() => {});
    this.turn = {
      invocation,
      ready,
      stream: this.stream(),
      abort: new AbortController(),
      chain: Promise.resolve(),
      inFlight: 0,
      steps: [],
      committed: [],
      superseded: new Set(),
    };
  }
  /** A partial transcript of the current activation. */
  partial(invocation: number, text: string, atMs = this.now()) {
    const turn = this.turn;
    if (!turn || turn.invocation !== invocation || turn.ended) return;
    if (!this.deps.settings().earlyStart) return;
    turn.lastPartial = text;
    this.disarm(turn);
    this.handle(turn, turn.stream.push({ text, atMs }));
    // The stream has no clock of its own: a clause that ends the words so
    // far commits by stability only when it is pushed again unchanged, so
    // the last partial is pushed once more when the recognizer stays silent.
    if (turn.ended) return;
    turn.timer = this.setTimer(() => {
      turn.timer = undefined;
      if (turn.ended || this.turn !== turn || turn.lastPartial !== text) return;
      this.handle(turn, turn.stream.push({ text, atMs: this.now() }));
    }, STREAM_LIMITS.stableMs + 10);
  }
  private disarm(turn: StreamTurn) {
    if (turn.timer === undefined) return;
    this.clearTimer(turn.timer);
    turn.timer = undefined;
  }
  /** The turn ended without a final (Escape, stop, error, typed input). */
  cancel(code: StreamCode) {
    const turn = this.turn;
    if (!turn || turn.ended) return;
    this.end(turn, code);
  }
  /**
   * The final transcript arrived. Returns the claim when a fast action was
   * issued (or is being issued); otherwise the turn ends here with nothing
   * to hand on. Clauses that commit only now are the run's to do.
   */
  finish(invocation: number, finalText: string): StreamClaim | undefined {
    const turn = this.turn;
    if (!turn || turn.invocation !== invocation || turn.ended) return undefined;
    turn.ended = true;
    turn.finishedAt = this.now();
    this.disarm(turn);
    for (const event of turn.stream.final(finalText, turn.finishedAt))
      if (event.kind === "final") this.drop(turn, event.dropped);
    this.report(turn);
    if (!turn.steps.length && !turn.inFlight) return undefined;
    let taken: Promise<StreamedStep[]> | undefined;
    let released = false;
    const steps = () =>
      turn.steps.map(({ clauseText: _text, ...step }) => step);
    return {
      get steps() {
        return steps();
      },
      take: () =>
        (taken ??= turn.chain.then(() => {
          const all = steps();
          trace(this.deps.trace, "StreamedRunStarted", {
            streamedSteps: all.filter((s) => s.outcome !== "failed").length,
            dropped: all.filter((s) => s.outcome === "dropped").length,
          });
          return all;
        })),
      release: () => {
        if (taken || released) return;
        released = true;
        void turn.chain.then(() => {
          const summary = streamedSummary(steps());
          if (summary) this.deps.onLeft?.(summary);
        });
      },
    };
  }
  /** Whether a fast action of this activation was issued: the screen is no longer what a prepared step saw. */
  engaged(invocation: number): boolean {
    const turn = this.turn;
    return !!turn && turn.invocation === invocation && !!turn.acted;
  }
  /** Resolves when no clause work of the current turn is open or queued. */
  async idle(): Promise<void> {
    const turn = this.turn;
    if (!turn) return;
    for (let last: Promise<void> | undefined; last !== turn.chain;) {
      last = turn.chain;
      await last;
    }
  }

  private handle(turn: StreamTurn, events: ClauseEvent[]) {
    for (const event of events) {
      if (turn.ended) return;
      if (event.kind === "committed") {
        const committed: Committed = {
          clause: event.clause,
          by: event.by,
          at: event.clause.committedAtMs ?? this.now(),
        };
        turn.committed.push(committed);
        this.enqueue(turn, () => this.act(turn, committed));
      } else if (event.kind === "superseded") {
        // The recognizer rewrote or grew a committed clause: its queued work
        // is skipped and the replacement decided afresh (act), where an equal
        // action stands and a different one drops the old step.
        turn.superseded.add(clauseKey(event.clause));
        const replacement: Committed = {
          clause: event.replacement,
          by: "stable",
          at: event.replacement.committedAtMs ?? this.now(),
          replaces: event.clause,
        };
        turn.committed.push(replacement);
        this.enqueue(turn, () => this.act(turn, replacement));
      } else this.drop(turn, event.dropped);
    }
  }
  /** Clauses rewritten or no longer said: their steps were done by mistake, their queued work is skipped. */
  private drop(turn: StreamTurn, clauses: Clause[]) {
    for (const clause of clauses) {
      turn.superseded.add(clauseKey(clause));
      for (const step of turn.steps)
        if (
          step.clauseIndex === clause.index &&
          step.clauseText === clause.text &&
          step.outcome === "done"
        ) {
          step.outcome = "dropped";
          trace(this.deps.trace, "StreamedActionDropped", {
            kind: step.action.kind,
            clauseIndex: step.clauseIndex,
          });
        }
    }
  }
  private end(turn: StreamTurn, _code: StreamCode) {
    turn.ended = true;
    this.disarm(turn);
    turn.abort.abort();
    this.report(turn);
  }
  /** One StreamClauseCommitted per committed clause, with its lead on the final when one came. */
  private report(turn: StreamTurn) {
    for (const c of turn.committed)
      trace(this.deps.trace, "StreamClauseCommitted", {
        index: c.clause.index,
        by: c.by,
        words: wordCount(c.clause.text),
        ...(turn.finishedAt !== undefined
          ? { leadMs: Math.max(0, turn.finishedAt - c.at) }
          : {}),
      });
  }
  private enqueue(turn: StreamTurn, fn: () => Promise<void>) {
    turn.inFlight++;
    turn.chain = turn.chain
      .then(fn)
      .catch(() => undefined)
      .then(() => {
        turn.inFlight--;
      });
  }
  /** Why nothing may run for this turn now, if anything. */
  private gate(turn: StreamTurn): StreamCode | undefined {
    if (turn.finishedAt !== undefined) return "final_first";
    if (turn.ended || turn.abort.signal.aborted || this.turn !== turn)
      return "cancelled";
    if (!this.deps.settings().earlyStart) return "disabled";
    return this.deps.blocked();
  }
  /** The front surface, read once per clause (the helper answers it off its queue). */
  private async front(
    turn: StreamTurn,
    c: StreamController,
    settings: Settings,
  ): Promise<Surface> {
    if (!turn.configured) {
      await c.configure(settings);
      turn.configured = true;
    }
    const surface = await c.surface();
    turn.front = surface;
    return surface;
  }
  /**
   * What the decider knows of the screen: the browser and host the last
   * open_url sent it to (so "play a midwest safety video" after "go to
   * youtube" is a YouTube search without Jev), else the surface's own.
   */
  private context(turn: StreamTurn, settings: Settings): FastContext {
    const frontAppId = turn.sent?.appId ?? turn.front?.appId;
    const frontHost = turn.sent?.host ?? turn.front?.domain;
    const browser = this.deps.browser?.();
    return {
      ...(frontAppId ? { frontAppId } : {}),
      ...(frontHost ? { frontHost } : {}),
      ...(browser ? { browser } : {}),
      protectedHosts: settings.protectedDomains,
    };
  }
  /** The one fast action of a committed clause, ALLOW or nothing. */
  private async act(turn: StreamTurn, committed: Committed) {
    const { clause, by } = committed;
    const skip = () =>
      turn.ended ||
      this.turn !== turn ||
      turn.superseded.has(clauseKey(clause));
    if (skip() || this.gate(turn)) return;
    // A clause with a credential is never a fast action (design §3.2).
    if (scanText(clause.text).some((f) => f.action === "BLOCK_UPLOAD")) return;
    await turn.ready.catch(() => undefined);
    const c = this.deps.controller();
    if (!c) return;
    const settings = this.deps.settings();
    await this.front(turn, c, settings);
    if (skip() || this.gate(turn)) return;
    const decideStart = this.now();
    const ctx = this.context(turn, settings);
    let action = this.decide.fast(clause, ctx);
    if (action.kind === "none" && action.reason === "unsure") {
      const jev = this.deps.jev?.();
      if (jev)
        action = await this.decide
          .withJev(clause, ctx, jev, turn.abort.signal)
          .catch(() => none("unsure"));
    }
    const decideMs = this.now() - decideStart;
    if (turn.ended || this.turn !== turn) return;
    // A rewritten clause: the action already issued for it stands when the
    // new words decide to the same one; otherwise it was done by mistake.
    if (committed.replaces) {
      const previous = turn.steps.filter(
        (s) => s.clauseIndex === clause.index && s.outcome === "done",
      );
      const same = previous.find((s) => sameAction(s.action, action));
      if (same) {
        same.clauseText = clause.text;
        return;
      }
      for (const step of previous) {
        step.outcome = "dropped";
        trace(this.deps.trace, "StreamedActionDropped", {
          kind: step.action.kind,
          clauseIndex: step.clauseIndex,
        });
      }
    }
    if (action.kind === "none" || skip() || this.gate(turn)) return;
    // The leading clause's app is the early start's step and the run's
    // prelude (electron/early-start.ts): never the same launch twice.
    if (action.kind === "open_app" && clause.index === 0) return;
    const issue = (a: Exclude<FastAction, { kind: "none" }>): Recorded => {
      const at = this.now();
      turn.acted = true;
      trace(this.deps.trace, "StreamedAction", {
        kind: a.kind,
        ...(a.kind === "open_url" ? { siteKey: a.siteKey } : {}),
        clauseIndex: clause.index,
        decideMs,
        issueMs: Math.max(0, at - committed.at),
      });
      const step: Recorded = {
        clauseIndex: clause.index,
        clauseText: clause.text,
        action: a,
        atMs: at,
        outcome: "done",
      };
      turn.steps.push(step);
      this.deps.onAction(streamedPillLabel(a));
      return step;
    };
    const speaking = { speaking: true } as const;
    if (action.kind === "open_url") {
      const built = actionSchema.parse({
        type: "open_url",
        url: action.url,
        siteKey: action.siteKey,
        frame_id: STREAM_FRAME,
      });
      if (built.type !== "open_url") return;
      const decision = evaluate(built, turn.front!, settings, false, speaking);
      if (decision.kind !== "ALLOW") return;
      const step = issue(action);
      try {
        const result = await c.openUrl(built);
        const host =
          result?.navigated?.host ?? webAddress(action.url)?.hostname ?? "";
        if (host)
          turn.sent = {
            host,
            ...(result?.navigated?.appId
              ? { appId: result.navigated.appId }
              : {}),
          };
      } catch {
        step.outcome = "failed";
      }
      return;
    }
    if (action.kind === "scroll") {
      const built = actionSchema.parse({
        type: "scroll",
        delta_x: 0,
        delta_y: action.direction === "down" ? 300 : -300,
        frame_id: STREAM_FRAME,
      });
      const decision = evaluate(built, turn.front!, settings, false, speaking);
      if (decision.kind !== "ALLOW") return;
      const step = issue(action);
      try {
        await this.deps.scroll(action.direction);
      } catch {
        step.outcome = "failed";
      }
      return;
    }
    // open_app of a later clause: the early step's own checks, on its chain.
    const opening = action;
    await this.deps.early.section(async () => {
      if (skip() || this.gate(turn)) return;
      const primed = await this.prime(turn, c, settings, turn.front!);
      if (!primed) return;
      // A boundary proved the name finished ("Chrome and…" may be Google
      // Chrome); a clause committed by stability alone did not, so only the
      // exact installed name counts, as the early step's pause rule has it.
      const verified = await verifyOpening(
        c,
        settings,
        primed.frame,
        {
          type: "open_app",
          name: opening.name,
          key: opening.name.toLowerCase(),
          by: by === "boundary" ? "boundary" : "pause",
        },
        speaking,
      ).catch(() => undefined);
      if (!verified?.ok || skip() || this.gate(turn)) return;
      const step = issue(opening);
      try {
        await c.resume();
        await c.execute(
          nativeAction(
            verified.action,
            { kind: "ALLOW", reason: verified.reason },
            verified.surface,
          ),
          primed.frame,
          turn.abort.signal,
        );
      } catch {
        step.outcome = "failed";
      } finally {
        c.stop();
      }
    });
  }
  /**
   * The frame an open_app is verified against: read-only, under the latch
   * lifted for the capture alone, and kept while native accepts its age.
   */
  private async prime(
    turn: StreamTurn,
    c: StreamController,
    settings: Settings,
    current: Surface,
  ): Promise<{ frame: Frame; at: number } | undefined> {
    if (
      turn.primed &&
      this.now() - turn.primed.at <= EARLY_LIMITS.frameMaxAgeMs
    )
      return turn.primed;
    // As Runner.capture(): never while a protected, terminal or secure
    // input surface is in front.
    if (surfacePolicy(current, settings).kind !== "ALLOW") return undefined;
    let frame: Frame;
    try {
      await c.resume();
      frame = await c.capture();
    } finally {
      c.stop();
    }
    turn.primed = { frame, at: this.now() };
    return turn.primed;
  }
}
/** The Jev client for the fast decider, on the wire, when the decider is on (src/providers/jev-clause.ts). */
export function jevClientFor(
  enabled: boolean,
  key: string,
  timeoutMs: number,
): JevClient | undefined {
  if (!enabled || !key.trim()) return undefined;
  return createJevClauseClient({
    fetch: globalThis.fetch.bind(globalThis),
    key,
    timeoutMs,
  });
}
