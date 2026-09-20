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
 * One navigation per thing asked (live findings 2026-09-19 19:41–19:43: a
 * clause growing word by word re-committed by stability up to seven times
 * at the same index, and each commit that decided to a recipe URL was
 * issued, three YouTube search pages in 1.2 s and four in 7 s, the run's
 * first click then failing on a page still loading). The rules:
 *
 * - The stream's `superseded` event (the recognizer grew or rewrote a
 *   committed clause) decides nothing by itself: it lets go of a query held
 *   for that index and skips the old words' queued work; the clause is
 *   decided again only when it commits again (by boundary or 350 ms
 *   stability), and that commit is traced with `superseded: true`.
 * - A site open (a recipe's front page) issues at the first commit that
 *   names the site, never twice in one sentence for the same site.
 * - A query (a search or directions URL) issues once per clause index: at
 *   once when the clause committed by boundary (the next clause has begun,
 *   so its words are whole), else held STREAMING_LIMITS.queryHoldMs after
 *   the stable commit, so the words have stood 700 ms in all, and issued
 *   then, or by the final that still says them. Growth before the issue
 *   replaces the held query with the new words; a re-commit after the issue
 *   never navigates again: the run is told which query is on screen and
 *   continues from it. An equal action already issued this sentence, from
 *   whatever clause, stands.
 * - A re-commit that decides to another destination (a correction to
 *   another site or application) drops the earlier step as done by mistake
 *   and issues the new one, traced `reissue: true`.
 *
 * A clause the final no longer says (dropped), or a step whose words no
 * longer stand whole in the final, is navigation only: nothing to undo,
 * and the run is told it was done by mistake. A final the router does not
 * start (a question, a fragment) leaves what was opened as it is, and the
 * pill says so. Diagnostics carry codes and numbers, never a word or a URL.
 *
 * Modules (.data/design/modules.md §6): with a registry in the deps, the
 * clause stream, the fast decider and the URL opener are ports. The decider
 * and the opener always go through modules.port("fastDecider" | "urlOpener"),
 * whose built-in adapters are today's code (electron/modules.ts). The stream
 * port is stateless (the caller keeps the clauses), so the exact built-in
 * stream, whose stability rule needs the timing of every partial, is used
 * directly while settings.modules.clauseSegmenter is builtin, and the port
 * is asked once per partial otherwise, with the clauses it answered last;
 * the final's segmentation and its dropped clauses are always the core's
 * (clausesOf), never an adapter's. Whatever an adapter answers is judged as
 * the built-in's answer would be: the action schema, the policy while
 * speaking, the protected-host floor; without a registry (tests) the
 * deciders and the controller's route are called directly.
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
import { homeUrl, siteByKey } from "../src/voice/recipes";
import {
  STREAM_LIMITS,
  clausesOf,
  createClauseStream,
  type Clause,
  type ClauseEvent,
  type ClauseStream,
  type PartialSample,
} from "../src/voice/stream";
import { createJevClauseClient } from "../src/providers/jev-clause";
import {
  decideFast,
  decideFastWithJev,
  type FastAction,
  type FastContext,
  type JevClient,
} from "../src/voice/fast";
import type {
  ModuleRegistry,
  PortAdapter,
  ModulePorts,
} from "../src/modules/registry";
import { fastActionOf } from "./modules";
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
  /** The Jev client while the decider is on (--decide-with-jev or the setting); unused with a registry. */
  jev?(): JevClient | undefined;
  /** The module registry (electron/main.ts getModules): the ports above. */
  modules?(): ModulePorts | undefined;
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
  /** A re-commit: this index was committed before, and grew or was rewritten since. */
  again: boolean;
}
type OpenUrl = Extract<FastAction, { kind: "open_url" }>;
/** An open_url decided and checked, ready to issue; a query may be held first. */
interface Navigation {
  clause: Clause;
  committed: Committed;
  action: OpenUrl;
  built: Extract<Action, { type: "open_url" }>;
  decideMs: number;
  ctx: FastContext;
  /** It replaces an earlier step of the same index (a rewrite to another destination). */
  reissue: boolean;
}
interface Held extends Navigation {
  timer?: unknown;
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
  /** Indexes committed at least once: a later commit of one is a re-commit. */
  committedIndexes: Set<number>;
  /** A query per clause index waiting for its words to stop growing. */
  held: Map<number, Held>;
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
export const STREAMING_LIMITS = {
  /**
   * How long a query decided from a clause committed by stability is held
   * for the words to stop growing: with STREAM_LIMITS.stableMs before it,
   * the words have stood 700 ms unchanged when the query issues.
   */
  queryHoldMs: 350,
} as const;
/** The frame id a fast action carries: it has no frame of its own. */
const STREAM_FRAME = "streamed";
/**
 * A site open (the recipe's front page, or a dictated domain's) or a query
 * (a URL with an object in it). Read from the recipe table when the site is
 * known; else a bare origin is a site open and anything more a query.
 */
export function navigationKind(action: OpenUrl): "home" | "query" {
  const site = siteByKey(action.siteKey);
  if (site) return homeUrl(site) === action.url ? "home" : "query";
  const parsed = webAddress(action.url);
  if (!parsed) return "query";
  return parsed.search || parsed.hash || parsed.pathname !== "/"
    ? "query"
    : "home";
}
/** The words of a text, lowercased, punctuation dropped. */
const wordsOfText = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
/** Whether `needle` stands whole and in order inside `hay`. */
function inside(needle: readonly string[], hay: readonly string[]): boolean {
  if (!needle.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++)
    if (needle.every((w, k) => hay[i + k] === w)) return true;
  return false;
}
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
    const turn: StreamTurn = {
      invocation,
      ready,
      stream: this.stream(),
      abort: new AbortController(),
      chain: Promise.resolve(),
      inFlight: 0,
      steps: [],
      committed: [],
      superseded: new Set(),
      committedIndexes: new Set(),
      held: new Map(),
    };
    // A segmenter adapter: the port is asked per partial and its events
    // arrive later, in order; the built-in stream answers at the push.
    const modules = this.deps.modules?.();
    const choice = this.deps.settings().modules?.clauseSegmenter?.kind;
    if (modules && choice && choice !== "builtin")
      turn.stream = new PortClauseStream(
        modules.port("clauseSegmenter"),
        (events) => {
          if (this.turn === turn && !turn.ended) this.handle(turn, events);
        },
        turn.abort.signal,
      );
    this.turn = turn;
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
    this.disarm(turn);
    const finishedAt = this.now();
    const events = turn.stream.final(finalText, finishedAt);
    // A held query the final still says is issued now, the final being the
    // commit that makes its words whole; one the final no longer says is
    // let go, nothing having been issued for it.
    const finalWords = wordsOfText(finalText);
    for (const [index, held] of [...turn.held]) {
      this.release(turn, index);
      if (!inside(wordsOfText(held.clause.text), finalWords)) continue;
      if (this.deps.blocked()) continue;
      this.enqueue(turn, async () => {
        if (this.turn !== turn || turn.abort.signal.aborted) return;
        const c = this.deps.controller();
        if (!c) return;
        await this.navigate(turn, held, c, this.deps.settings());
      });
    }
    turn.ended = true;
    turn.finishedAt = finishedAt;
    for (const event of events)
      if (event.kind === "final") this.drop(turn, event.dropped);
    this.judge(turn, finalWords);
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
        const again = turn.committedIndexes.has(event.clause.index);
        turn.committedIndexes.add(event.clause.index);
        const committed: Committed = {
          clause: event.clause,
          by: event.by,
          at: event.clause.committedAtMs ?? this.now(),
          again,
        };
        turn.committed.push(committed);
        this.enqueue(turn, () => this.act(turn, committed));
      } else if (event.kind === "superseded") {
        // The recognizer rewrote or grew a committed clause: its queued work
        // is skipped and a query held for it is let go (the words changed
        // before it was issued). Nothing is decided until the clause commits
        // again, by boundary or by standing still.
        turn.superseded.add(clauseKey(event.clause));
        this.release(turn, event.clause.index);
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
  /** A step whose words the final no longer says whole was done by mistake. */
  private judge(turn: StreamTurn, finalWords: readonly string[]) {
    for (const step of turn.steps)
      if (
        step.outcome === "done" &&
        !inside(wordsOfText(step.clauseText), finalWords)
      ) {
        step.outcome = "dropped";
        trace(this.deps.trace, "StreamedActionDropped", {
          kind: step.action.kind,
          clauseIndex: step.clauseIndex,
        });
      }
  }
  /** Lets go of the query held for an index, if any: nothing was issued for it. */
  private release(turn: StreamTurn, index: number) {
    const held = turn.held.get(index);
    if (!held) return;
    turn.held.delete(index);
    if (held.timer !== undefined) this.clearTimer(held.timer);
    held.timer = undefined;
  }
  private end(turn: StreamTurn, _code: StreamCode) {
    turn.ended = true;
    this.disarm(turn);
    for (const index of [...turn.held.keys()]) this.release(turn, index);
    turn.abort.abort();
    this.report(turn);
  }
  /**
   * One StreamClauseCommitted per commit, with its lead on the final when
   * one came; a re-commit of an index (the clause grew or was rewritten and
   * committed again) is flagged superseded.
   */
  private report(turn: StreamTurn) {
    for (const c of turn.committed)
      trace(this.deps.trace, "StreamClauseCommitted", {
        index: c.clause.index,
        by: c.by,
        words: wordCount(c.clause.text),
        ...(turn.finishedAt !== undefined
          ? { leadMs: Math.max(0, turn.finishedAt - c.at) }
          : {}),
        ...(c.again ? { superseded: true } : {}),
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
    const modules = this.deps.modules?.();
    let action: FastAction;
    if (modules) {
      // The port (its built-in is decideFast, then Jev over the choice
      // model); a failed call decides nothing.
      action = fastActionOf(
        await modules
          .port("fastDecider")
          .call({ clause, context: ctx }, turn.abort.signal)
          .catch(() => undefined),
      );
    } else {
      action = this.decide.fast(clause, ctx);
      if (action.kind === "none" && action.reason === "unsure") {
        const jev = this.deps.jev?.();
        if (jev)
          action = await this.decide
            .withJev(clause, ctx, jev, turn.abort.signal)
            .catch(() => none("unsure"));
      }
    }
    const decideMs = this.now() - decideStart;
    if (turn.ended || this.turn !== turn) return;
    if (action.kind === "none") return;
    // What this sentence already did stands: an equal navigation (the same
    // address, application or direction), whichever clause decided to it,
    // is never issued again; a re-commit that decides to it keeps its step
    // under the words as they now are, for the final to judge.
    const equal = turn.steps.find(
      (s) => s.outcome === "done" && sameAction(s.action, action),
    );
    if (equal) {
      if (equal.clauseIndex === clause.index) equal.clauseText = clause.text;
      return;
    }
    const prior = turn.steps.filter(
      (s) => s.clauseIndex === clause.index && s.outcome === "done",
    );
    let nav: "home" | "query" | undefined;
    if (action.kind === "open_url") {
      nav = navigationKind(action);
      // One site open per sentence for a site, from whichever clause named
      // it first; one query per clause index, so a clause that grew after
      // its query issued is the run's to refine, told which query is on
      // screen by the prelude.
      if (
        nav === "home" &&
        turn.steps.some(
          (s) =>
            s.outcome === "done" &&
            s.action.kind === "open_url" &&
            s.action.siteKey === action.siteKey &&
            navigationKind(s.action) === "home",
        )
      )
        return;
      if (
        nav === "query" &&
        prior.some(
          (s) =>
            s.action.kind === "open_url" &&
            navigationKind(s.action) === "query",
        )
      )
        return;
    }
    if (skip() || this.gate(turn)) return;
    // The leading clause's app is the early start's step and the run's
    // prelude (electron/early-start.ts): never the same launch twice.
    if (action.kind === "open_app" && clause.index === 0) return;
    // A re-commit to another destination (a correction to another site or
    // application) drops the earlier step as done by mistake when the new
    // one issues. A query after the site's own open at the same index is no
    // correction ("go to youtube" grown into "go to youtube midwest
    // safety"): the open stands and the results load over it.
    const reissue = nav === "query" ? false : prior.length > 0;
    const speaking = { speaking: true } as const;
    if (action.kind === "open_url") {
      // The core's own check of any open_url, an adapter's included: a full
      // http(s) address without credentials (the schema); the policy while
      // speaking, which refuses a protected host outright, judges it at the
      // issue (navigate).
      const parsed = actionSchema.safeParse({
        type: "open_url",
        url: action.url,
        siteKey: action.siteKey,
        frame_id: STREAM_FRAME,
      });
      if (!parsed.success || parsed.data.type !== "open_url") return;
      const navigation: Navigation = {
        clause,
        committed,
        action,
        built: parsed.data,
        decideMs,
        ctx,
        reissue,
      };
      // A query from a clause that stood still STREAM_LIMITS.stableMs may
      // still be growing ("play a midwest" → "… safety"): it is held
      // queryHoldMs more and issued when the words have not changed, let go
      // when they have, or issued at once by a final that keeps them. A site
      // open, or a query the next clause's first word made whole (boundary),
      // issues now.
      if (nav === "query" && by === "stable") {
        this.hold(turn, navigation);
        return;
      }
      await this.navigate(turn, navigation, c, settings);
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
      const step = this.issue(turn, committed, action, decideMs, reissue);
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
      const step = this.issue(turn, committed, opening, decideMs, reissue);
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
   * Holds a query for its clause's words to stop growing: issued after
   * STREAMING_LIMITS.queryHoldMs unless the clause is superseded first
   * (release) or the final comes (finish issues or lets it go).
   */
  private hold(turn: StreamTurn, navigation: Navigation) {
    const { index } = navigation.clause;
    this.release(turn, index);
    const held: Held = { ...navigation };
    held.timer = this.setTimer(() => {
      held.timer = undefined;
      if (turn.held.get(index) !== held) return;
      turn.held.delete(index);
      this.enqueue(turn, async () => {
        if (
          turn.ended ||
          this.turn !== turn ||
          turn.superseded.has(clauseKey(held.clause)) ||
          this.gate(turn)
        )
          return;
        const c = this.deps.controller();
        if (!c) return;
        await this.navigate(turn, held, c, this.deps.settings());
      });
    }, STREAMING_LIMITS.queryHoldMs);
    turn.held.set(index, held);
  }
  /** Issues an open_url: the policy while speaking, the step, the route. */
  private async navigate(
    turn: StreamTurn,
    n: Navigation,
    c: StreamController,
    settings: Settings,
  ) {
    const decision = evaluate(n.built, turn.front!, settings, false, {
      speaking: true,
    });
    if (decision.kind !== "ALLOW") return;
    const step = this.issue(turn, n.committed, n.action, n.decideMs, n.reissue);
    const modules = this.deps.modules?.();
    try {
      if (modules) {
        const out = await modules.port("urlOpener").call(
          {
            url: n.built.url,
            ...(n.ctx.browser ? { browser: n.ctx.browser } : {}),
          },
          turn.abort.signal,
        );
        if (!out.navigated) step.outcome = "failed";
        const host = webAddress(n.action.url)?.hostname ?? "";
        if (host && out.navigated) turn.sent = { host };
      } else {
        const result = await c.openUrl(n.built);
        const host =
          result?.navigated?.host ?? webAddress(n.action.url)?.hostname ?? "";
        if (host)
          turn.sent = {
            host,
            ...(result?.navigated?.appId
              ? { appId: result.navigated.appId }
              : {}),
          };
      }
    } catch {
      step.outcome = "failed";
    }
  }
  /**
   * Records an issued fast action: the trace (kind, site code, whether a
   * site open or a query, clause, timings, and reissue when it replaces an
   * earlier step of the index, which is dropped here), the step and the
   * pill's line.
   */
  private issue(
    turn: StreamTurn,
    committed: Committed,
    a: Exclude<FastAction, { kind: "none" }>,
    decideMs: number,
    reissue: boolean,
  ): Recorded {
    const { clause } = committed;
    const at = this.now();
    turn.acted = true;
    if (reissue)
      for (const step of turn.steps)
        if (step.clauseIndex === clause.index && step.outcome === "done") {
          step.outcome = "dropped";
          trace(this.deps.trace, "StreamedActionDropped", {
            kind: step.action.kind,
            clauseIndex: step.clauseIndex,
          });
        }
    trace(this.deps.trace, "StreamedAction", {
      kind: a.kind,
      ...(a.kind === "open_url"
        ? { siteKey: a.siteKey, nav: navigationKind(a) }
        : {}),
      clauseIndex: clause.index,
      decideMs,
      issueMs: Math.max(0, at - committed.at),
      ...(reissue ? { reissue: true } : {}),
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
/**
 * A ClauseStream over the clauseSegmenter port (design §3: stateless, the
 * caller keeps the clauses). Each push asks the adapter with the clauses it
 * answered last and hands its events on when they arrive, one call at a
 * time and in order, so a slow adapter never reorders commits; push itself
 * answers nothing. The final is the core's: clausesOf cuts the final text,
 * and a committed clause whose words no longer stand in order inside one of
 * its clauses is dropped, exactly as the built-in stream decides it.
 */
export class PortClauseStream implements ClauseStream {
  private kept: Clause[] = [];
  private chain: Promise<void> = Promise.resolve();
  private ended = false;
  constructor(
    private readonly port: PortAdapter<"clauseSegmenter">,
    private readonly onEvents: (events: ClauseEvent[]) => void,
    private readonly signal?: AbortSignal,
  ) {}
  push(sample: PartialSample): ClauseEvent[] {
    if (this.ended) return [];
    this.chain = this.chain.then(async () => {
      if (this.ended) return;
      try {
        const out = await this.port.call(
          { text: sample.text, atMs: sample.atMs, previous: this.kept },
          this.signal,
        );
        if (this.ended) return;
        this.kept = out.clauses;
        if (out.events.length) this.onEvents(out.events);
      } catch {
        // The registry already fell back or answered none; nothing commits.
      }
    });
    return [];
  }
  final(text: string, atMs: number): ClauseEvent[] {
    this.ended = true;
    const clauses = clausesOf(text, atMs);
    const dropped = this.kept.filter(
      (c) =>
        c.state === "committed" &&
        !clauses.some((f) => inside(wordsOfText(c.text), wordsOfText(f.text))),
    );
    return [{ kind: "final", clauses, dropped }];
  }
  clauses(): Clause[] {
    return this.kept;
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
