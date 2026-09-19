/**
 * The dialog session: one text-only model call per free-form turn, started
 * early on the partial transcript when it can be, parsed as it streams so
 * the plan is settled on the ACT line and the first sentence is spoken while
 * the rest is still being written. It keeps a short in-memory thread, an
 * hourly budget, and the one offer ("Want me to …?") a "yes" may accept.
 *
 * What it can never do: approve, decline or stop anything. Those words never
 * reach it (the router handles them first), its grammar has no such act,
 * and arbitrate() maps whatever it says onto plans the router could have
 * produced itself. Every spoken sentence goes through speakableSentence.
 */
import type { Settings, TaskSource, Usage } from "../src/core/schema";
import { validateProviderEndpoint } from "../src/core/privacy";
import { trace, type DiagnosticSink } from "../src/core/diagnostics";
import { scanText } from "../src/core/sanitize";
import {
  streamText,
  textSettings,
  TextModelError,
  type TextOutcome,
} from "../src/providers/text";
import {
  arbitrate,
  dialogEligible,
  fastStart,
  jevStartCandidate,
  looksLikeQuestion,
} from "../src/assistant/arbitrate";
import { DIALOG_SYSTEM } from "../src/assistant/prompt";
import {
  DIALOG_ACTS,
  DialogParser,
  type DialogEvent,
  type DialogHead,
} from "../src/assistant/protocol";
import {
  APP_DIALOG_VARIANT,
  JEV_START_MIN_P,
  dialogActQuestion,
  jevState,
  type JevChoiceQuestion,
} from "../src/providers/jev";
import {
  JEV_ACT_QUESTION,
  askJevAct,
  jevEnabled,
  type JevFailure,
  type JevVerdict,
} from "./jev";
import {
  buildDialogState,
  dialogStateJson,
  type DialogState,
} from "../src/assistant/state";
import type {
  AssistantSessionApi,
  Channel,
  DecideInput,
  RunView,
  TurnDecision,
  TurnRecord,
} from "../src/assistant/types";
import { containsSecret, speakableSentence } from "../src/voice/speakable";
import {
  APPROVAL_MIN_CONFIDENCE,
  clarifyFragment,
  deicticTask,
  intentKey,
  isStatusQuestion,
  isWakePhraseOnly,
  voiceIntent,
  type TurnPlan,
} from "../src/voice/turns";

export const DIALOG_LIMITS = {
  /** How long the ACT line may take before the deterministic plan runs. */
  actDeadlineMs: 1500,
  questionActDeadlineMs: 3000,
  localActDeadlineMs: 2500,
  localQuestionActDeadlineMs: 4000,
  /** The filler plays this long after the final transcript with no sentence. */
  fillerAfterMs: 900,
  streamDeadlineMs: 6000,
  stateChars: 6000,
  localStateChars: 2500,
  turns: 8,
  turnTtlMs: 30 * 60_000,
  /** An early request older than this no longer matches the final words. */
  preemptTtlMs: 3000,
  hourlyCalls: 240,
  /** How long a "Want me to …?" offer stays open for a "yes". */
  proposalTtlMs: 30_000,
  voiceSentences: 2,
  textSentences: 3,
  maxOutputTokens: 300,
} as const;

export interface AssistantOptions {
  settings: () => Settings;
  /** The run provider's key: the dialog shares its credential scope. */
  providerKey: () => string;
  /**
   * The OpenRouter key for the opt-in Jev decider (electron/jev.ts); "" or
   * absent keeps it off whatever the setting says.
   */
  jevKey?: () => string;
  fetch: typeof fetch;
  view: () => RunView;
  /** Optional context, already gated by settings; never a helper call. */
  context: () => {
    agenda?: string[];
    notifications?: string[];
    openApps?: string[];
  };
  /** main.ts voiceHoldResumable(): the only hold a model resume may end. */
  heldByVoice: () => boolean;
  /** Dialog usage during a run counts toward that run's budget. */
  addUsage?: (usage: Usage) => void;
  trace?: DiagnosticSink;
  now?: () => number;
}

/** The reasoning effort a text call asks for, by model family. */
export function dialogEffort(
  model: string,
): "none" | "minimal" | "low" | undefined {
  if (/^gpt-5\.[1-9]/.test(model)) return "none";
  if (/^gpt-5(?:-|$)/.test(model)) return "minimal";
  if (/^o[1-9]/.test(model)) return "low";
  return undefined;
}

/**
 * Fixed lines for a rewrite that is neither run nor offered. Spoken as the
 * turn's reply; both pass speakableSentence (tests/assistant-session).
 */
export const REFUSED_LINES = {
  /** The rewrite would paste on the model's say-so. */
  clipboard:
    "I'll leave that one alone: it would paste something you didn't ask for.",
  /** The offer would lose details (a link, a number) when read out. */
  inexact:
    "That one has details I can't read out, so type it if you want it done.",
} as const;

/** A "yes" the router already turned into the offered task. */
function acceptedOffer(plan: TurnPlan): boolean {
  return (
    (plan.kind === "start" || plan.kind === "queue") &&
    plan.taskSource === "proposal"
  );
}

/** Words that must never leave the machine: the run path refuses them locally. */
function carriesCredential(text: string): boolean {
  return scanText(text).some((f) => f.action === "BLOCK_UPLOAD");
}

/** Plans that change a run: the filler alone acknowledges them. */
function actingPlan(plan: TurnPlan): boolean {
  return [
    "start",
    "revise",
    "replace",
    "queue",
    "resume",
    "pause",
    "amendTask",
  ].includes(plan.kind);
}

/** One model call and everything parsed from it so far. */
interface Flight {
  id: string;
  controller: AbortController;
  parser: DialogParser;
  events: DialogEvent[];
  head?: DialogHead;
  invalid?: string;
  ended: boolean;
  error?: string;
  outcome?: TextOutcome;
  startedAt: number;
  /**
   * The model saw notification text (buildDialogState sends it only for a
   * question about them): what it says is read out from it, so the turn is
   * kept as untrusted, like any line read out from a notification.
   */
  readOut: boolean;
  /** Wakes anyone waiting on new events. */
  wake: () => void;
}

/**
 * One Jev call for one set of words (the opt-in early decider), fired on
 * the partial like an early request or at decide(); matched to the final
 * words by the same intent key and freshness rule as an early request.
 */
interface JevAsk {
  intent: string;
  at: number;
  channel: Channel;
  controller: AbortController;
  verdict: Promise<JevVerdict>;
  /** Set the moment the verdict is in, for the turn's trace. */
  settled?: JevVerdict;
}

const TERMINAL_RUN = new Set(["completed", "cancelled", "failed"]);
/** What one turn launched, so a failure in the turn can end all of it. */
interface TurnLaunch {
  flight?: Flight;
  jev?: JevAsk;
}
/** The verdict's content-free trace fields, once it is in. */
function jevTrace(
  ask: JevAsk | undefined,
  used: boolean,
): Record<string, unknown> {
  if (!ask) return {};
  const v = ask.settled;
  if (!v) return { jevUsed: used };
  return v.ok
    ? { jevMs: Math.round(v.ms), jevAct: v.act, jevP: v.p, jevUsed: used }
    : { jevMs: Math.round(v.ms), jevCode: v.code, jevUsed: used };
}

export class AssistantSession implements AssistantSessionApi {
  private readonly now: () => number;
  private turns: TurnRecord[] = [];
  private calls: { at: number; cost: number }[] = [];
  /** Jev calls: their cost counts against the same hourly budget. */
  private jevCalls: { at: number; cost: number }[] = [];
  /** The ask fired on the partial, waiting for the final words. */
  private jevAsk?: JevAsk;
  /** Every ask still on the wire, so an interruption can end them all. */
  private jevLive = new Set<JevAsk>();
  private flights = new Set<Flight>();
  private early?: { key: string; at: number; channel: Channel; flight: Flight };
  private live?: { id: string; text: string; until: number };
  private previousReply?: string;
  private sequence = 0;
  /** Bumped whenever an open offer is superseded: a new turn or a reset. */
  private epoch = 0;

  constructor(private readonly options: AssistantOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Why the model cannot be asked right now, or "ok". */
  availability(_channel: Channel): "ok" | "off" | "budget" {
    const s = this.options.settings();
    if (s.conversation !== "model") return "off";
    // Local mode runs the dialog only on a text model chosen for it: the
    // vision model would be slow and the endpoint stays loopback either way.
    if (s.privacy === "PRIVATE_LOCAL" && !s.dialogModel) return "off";
    const ts = textSettings(s);
    if (ts.provider !== "ollama" && !this.options.providerKey().trim())
      return "off";
    try {
      validateProviderEndpoint(ts);
    } catch {
      return "off";
    }
    return this.underBudget() ? "ok" : "budget";
  }

  available(channel: Channel): boolean {
    return this.availability(channel) === "ok";
  }

  /**
   * Starts the model call on the partial transcript so the answer is under
   * way before the endpoint closes. Only for words that would reach the
   * model anyway: not control words, status questions, fragments or a
   * fast start, which needs no model.
   */
  preempt(partial: string, channel: Channel): void {
    const text = partial.trim();
    if (!text || !this.available(channel)) return;
    // A credential never leaves the machine, not even in a partial.
    if (carriesCredential(text)) return;
    if (
      voiceIntent(text).kind !== "command" ||
      isWakePhraseOnly(text) ||
      isStatusQuestion(text) ||
      clarifyFragment(text) !== undefined
    )
      return;
    const key = intentKey(text);
    if (!key) return;
    const now = this.now();
    if (
      this.early &&
      this.early.key === key &&
      this.early.channel === channel &&
      now - this.early.at <= DIALOG_LIMITS.preemptTtlMs
    )
      return;
    this.dropEarly();
    if (
      !this.options.view().running &&
      fastStart({ kind: "start", text }, text)
    )
      return;
    const state = this.stateFor(text, channel);
    const flight = this.launch(state, "preempt");
    this.early = { key, at: now, channel, flight };
    this.jevPreempt(state, text, key, channel);
  }

  async decide(i: DecideInput): Promise<TurnDecision> {
    const launched: TurnLaunch = {};
    try {
      return await this.decideInner(i, launched);
    } catch (error) {
      // Nothing this turn launched may speak, act or bill after it failed.
      if (launched.flight) this.abort(launched.flight);
      if (launched.jev) this.abortJev(launched.jev);
      this.log("failed", codeOf(error));
      return { plan: i.base, acting: actingPlan(i.base), code: "error" };
    }
  }

  private async decideInner(
    i: DecideInput,
    launched: TurnLaunch = {},
  ): Promise<TurnDecision> {
    const base = i.base;
    /** The base plan as decided without the model; `traced` names why. */
    const settled = (
      code: TurnDecision["code"],
      traced: string = code,
    ): TurnDecision => {
      this.dropEarly();
      this.log("decided", {
        code: traced,
        channel: i.channel,
        actMs: 0,
        preempt: false,
      });
      return {
        plan: base,
        acting: code === "interrupted" ? false : actingPlan(base),
        code,
      };
    };
    if (acceptedOffer(base)) {
      // The router settled a "yes" on the open offer: the task runs exactly
      // as offered, with the offer's provenance, and the model is not asked
      // (it would re-ground the offer against "yes" and offer it again).
      this.noteUser(i.text, i.channel);
      return { ...settled("off", "proposal_accepted"), taskSource: "proposal" };
    }
    // A new turn supersedes any offer still open; only "yes" accepts one,
    // and that was handled above.
    this.live = undefined;
    this.epoch++;
    if (i.signal.aborted) return settled("interrupted");
    const ready = this.availability(i.channel);
    if (ready !== "ok" || !dialogEligible(base)) {
      this.dropEarly();
      return {
        plan: base,
        acting: actingPlan(base),
        code: ready === "budget" ? "budget" : "off",
      };
    }
    // A credential in the words themselves is never uploaded: the base plan
    // reaches the run path, which refuses it locally with nothing sent, and
    // the words stay out of the thread.
    if (carriesCredential(i.text)) return settled("off", "secret");
    if (fastStart(base, i.text)) {
      // The user's own words run right away; no model call at all.
      this.dropEarly();
      this.noteUser(i.text, i.channel);
      this.log("decided", {
        code: "fast_start",
        channel: i.channel,
        actMs: 0,
        preempt: false,
      });
      return {
        plan: base,
        taskSource: base.kind === "start" ? base.taskSource : undefined,
        acting: true,
        code: "fast_start",
      };
    }
    const question = looksLikeQuestion(i.text);
    const s = this.options.settings();
    const local = textSettings(s).provider === "ollama";
    const deadlineMs = local
      ? question
        ? DIALOG_LIMITS.localQuestionActDeadlineMs
        : DIALOG_LIMITS.localActDeadlineMs
      : question
        ? DIALOG_LIMITS.questionActDeadlineMs
        : DIALOG_LIMITS.actDeadlineMs;
    const reused = this.takeEarly(i.text, i.channel);
    const flight =
      reused ?? this.launch(this.stateFor(i.text, i.channel), "turn");
    launched.flight = flight;
    // The opt-in decider runs beside the stream, never before it; its one
    // use is an early start, and only for words that pass every guard.
    const jev = this.jevFor(i, base);
    launched.jev = jev;
    const started = this.now();
    this.noteUser(i.text, i.channel);
    const outcome = jev
      ? await this.raceJev(flight, deadlineMs, i.signal, jev)
      : await this.awaitHead(flight, deadlineMs, i.signal);
    const actMs = this.now() - started;
    if ("jev" in outcome) {
      // Jev said start, confidently, before the ACT line: the user's own
      // words run now, exactly as a fast start, and the stream is cut off.
      this.abort(flight);
      this.log("decided", {
        code: "jev_start",
        channel: i.channel,
        actMs,
        preempt: !!reused,
        ...jevTrace(jev, true),
      });
      return {
        plan: base,
        taskSource: "user_words",
        acting: true,
        code: "jev_start",
      };
    }
    if (!("head" in outcome)) {
      this.abort(flight);
      this.log("decided", {
        code: outcome.code,
        channel: i.channel,
        actMs,
        preempt: !!reused,
        ...jevTrace(jev, false),
      });
      // The user took the floor meanwhile: a stale plan never runs.
      const interrupted = outcome.code === "interrupted";
      return {
        plan: base,
        acting: interrupted ? false : actingPlan(base),
        code: outcome.code,
      };
    }
    const head = outcome.head;
    // Typed words are the user's; speech counts only when heard clearly.
    const heard: TaskSource =
      i.channel === "voice" && i.confidence < APPROVAL_MIN_CONFIDENCE
        ? "user_words_unsure"
        : "user_words";
    const a = arbitrate({
      base,
      head,
      utterance: i.text,
      run: i.run,
      context: this.contextWords(),
      userWords: this.userWords(),
      heard,
      channel: i.channel,
      heldByVoice: this.options.heldByVoice(),
    });
    this.log("decided", {
      code: a.code,
      act: head.act,
      plan: a.plan.kind,
      channel: i.channel,
      actMs,
      preempt: !!reused,
      ...jevTrace(jev, false),
    });
    const decision: TurnDecision = {
      plan: a.plan,
      ...(a.taskSource ? { taskSource: a.taskSource } : {}),
      acting: actingPlan(a.plan),
      code: "model",
    };
    if (a.refused) {
      // Neither run nor offered: the fixed line says why.
      this.abort(flight);
      this.log("decided", { code: `proposal_${a.refused}` });
      return {
        ...decision,
        sentences: this.fixedLine(REFUSED_LINES[a.refused], i.channel),
      };
    }
    if (a.proposal !== undefined) {
      // The rewrite is offered, not run: what it says is spoken as a
      // question the user answers under the approval rules.
      this.abort(flight);
      const line = proposalLine(a.proposal);
      if (!line) {
        this.log("decided", { code: "proposal_unspeakable" });
        return decision;
      }
      // What the user accepts must be the exact task that would run. The
      // voice reads links as hosts and long numbers as "a number", so an
      // offer that loses detail out loud is not made by voice; a screen
      // (the pill, a text) shows the task word for word.
      const spoken = i.channel === "voice";
      if (spoken && !offerIsExact(line, a.proposal)) {
        this.log("decided", { code: "proposal_inexact" });
        return {
          ...decision,
          sentences: this.fixedLine(REFUSED_LINES.inexact, i.channel),
        };
      }
      const proposal = {
        id: `p${++this.sequence}`,
        text: a.proposal,
        until: this.now() + DIALOG_LIMITS.proposalTtlMs,
      };
      this.live = proposal;
      const said = spoken ? line : exactOfferLine(a.proposal);
      const session = this;
      return {
        ...decision,
        proposal,
        sentences: (async function* () {
          yield said;
          // The offer repeats a rewrite the user never said: its words are
          // not vocabulary for a later rewrite, whether or not it is taken.
          session.noteAssistant(said, i.channel, { untrusted: true });
        })(),
      };
    }
    if (!a.speakSay) {
      this.abort(flight);
      return decision;
    }
    // An answer that offers in words to go and look ("I can check it on the
    // Mac if you like") is held to it: the user's own request, heard
    // clearly, becomes the offer a "yes" accepts. Words that only point
    // elsewhere ("do what she asked") are no request to offer: accepted,
    // the run would resolve them from the screen.
    const offer =
      head.act === "answer" &&
      a.plan.kind === "reply" &&
      heard === "user_words" &&
      !deicticTask(i.text)
        ? i.text
        : undefined;
    return {
      ...decision,
      sentences: this.sentences(flight, i.channel, offer),
    };
  }

  proposal(): { id: string; text: string; until: number } | undefined {
    const live = this.live;
    if (!live) return undefined;
    if (this.now() >= live.until) {
      this.live = undefined;
      return undefined;
    }
    return { ...live };
  }

  noteUser(text: string, channel: Channel): void {
    // The user spoke again: any open offer is answered or superseded.
    this.live = undefined;
    this.epoch++;
    this.remember({
      role: "user",
      channel,
      text,
      at: this.now(),
      untrusted: false,
    });
  }

  noteAssistant(
    text: string,
    channel: Channel,
    o: { untrusted?: boolean } = {},
  ): void {
    const clean = text.trim();
    if (!clean) return;
    if (!o.untrusted) this.previousReply = clean;
    this.remember({
      role: "assistant",
      channel,
      text: clean,
      at: this.now(),
      untrusted: o.untrusted === true,
    });
  }

  /** The user took the floor: nothing in flight may speak or act later. */
  interrupt(): void {
    this.early = undefined;
    for (const flight of [...this.flights]) this.abort(flight);
    this.dropJev();
    for (const ask of [...this.jevLive]) this.abortJev(ask);
  }

  /** Provider, privacy or model changed: the thread starts over. */
  reset(): void {
    this.interrupt();
    this.turns = [];
    this.live = undefined;
    this.epoch++;
    this.previousReply = undefined;
  }

  // Internals ---------------------------------------------------------------

  /** One fixed sentence of the assistant's own as the turn's reply. */
  private fixedLine(line: string, channel: Channel): AsyncIterable<string> {
    const session = this;
    return (async function* () {
      yield line;
      session.noteAssistant(line, channel);
    })();
  }

  private remember(turn: TurnRecord) {
    this.turns.push({ ...turn, text: turn.text.trim() });
    this.prune();
  }

  private prune() {
    const cutoff = this.now() - DIALOG_LIMITS.turnTtlMs;
    this.turns = this.turns
      .filter((t) => t.at > cutoff)
      .slice(-DIALOG_LIMITS.turns);
  }

  /**
   * Words a rewrite may draw on: the recent thread and the run's tasks. A
   * line the assistant repeated from a notification or a screen is not
   * vocabulary: an instruction planted there must come back as an offer.
   */
  private contextWords(): string[] {
    this.prune();
    const view = this.options.view();
    return [
      ...this.turns
        .slice(-4)
        .filter((t) => !t.untrusted)
        .map((t) => t.text),
      ...(view.task ? [view.task] : []),
      ...(view.lastFinished ? [view.lastFinished.task] : []),
      ...view.queued,
    ];
  }

  /** Text the user wrote or said themselves: the only source of entities. */
  private userWords(): string[] {
    this.prune();
    return this.turns
      .filter((t) => t.role === "user")
      .slice(-4)
      .map((t) => t.text);
  }

  private stateFor(text: string, channel: Channel): DialogState {
    this.prune();
    const s = this.options.settings();
    let context: ReturnType<AssistantOptions["context"]> = {};
    try {
      context = this.options.context() ?? {};
    } catch {}
    return buildDialogState({
      channel,
      user: text,
      view: this.options.view(),
      turns: this.turns,
      addressAs: s.addressAs,
      previousReply: this.previousReply,
      agenda: context.agenda,
      notifications: context.notifications,
      openApps: context.openApps,
      heldByVoice: this.options.heldByVoice(),
      now: new Date(this.now()),
    });
  }

  private underBudget(): boolean {
    const cutoff = this.now() - 3_600_000;
    this.calls = this.calls.filter((c) => c.at > cutoff);
    this.jevCalls = this.jevCalls.filter((c) => c.at > cutoff);
    if (this.calls.length >= DIALOG_LIMITS.hourlyCalls) return false;
    const cap = this.options.settings().dialogHourlyCost;
    const spent = [...this.calls, ...this.jevCalls].reduce(
      (sum, c) => sum + c.cost,
      0,
    );
    return !(typeof cap === "number" && Number.isFinite(cap) && spent >= cap);
  }

  // The opt-in Jev decider ---------------------------------------------------

  /**
   * Fires the act question on the partial transcript, beside the early
   * request, when the decider is on and these words could start on its
   * verdict alone. Nothing about the turn changes if it never answers.
   */
  private jevPreempt(
    state: DialogState,
    text: string,
    intent: string,
    channel: Channel,
  ): void {
    try {
      const key = this.options.jevKey?.() ?? "";
      if (!jevEnabled(this.options.settings(), key)) return;
      if (this.options.view().running) return;
      if (!jevStartCandidate({ kind: "start", text }, text)) return;
      if (!JEV_ACT_QUESTION) return this.jevFailed(channel, "no_question");
      this.jevAsk = this.askJev(state, key, intent, channel);
    } catch {
      // The decider's own path failed (a vault read, the state): the early
      // request stands on its own, as it does with the decider off.
      this.jevFailed(channel, "error");
    }
  }

  /**
   * The decider could not ask: today's path, untouched, with the code (never
   * the error's words) on a "jev" trace line so the failure is visible.
   */
  private jevFailed(channel: Channel, code: JevFailure): void {
    this.log("jev", { channel, jevCode: code, jevUsed: false });
  }

  /**
   * The ask for this turn, when every condition for an early start holds:
   * the decider is on, the router's own plan is start with the user's own
   * words (typed, or heard at least as clearly as an approval), nothing is
   * running, the words pass the fast-start guards minus the verb list, and
   * the budget allows. A fresh ask fired on the partial for the same intent
   * is reused; otherwise one is fired now, beside the stream.
   */
  private jevFor(i: DecideInput, base: TurnPlan): JevAsk | undefined {
    const ask = this.jevAsk;
    this.jevAsk = undefined;
    try {
      const key = this.options.jevKey?.() ?? "";
      const eligible =
        jevEnabled(this.options.settings(), key) &&
        base.kind === "start" &&
        base.taskSource === "user_words" &&
        (i.channel !== "voice" || i.confidence >= APPROVAL_MIN_CONFIDENCE) &&
        !i.view.running &&
        !(i.run && !TERMINAL_RUN.has(i.run.status)) &&
        jevStartCandidate(base, i.text) &&
        this.underBudget();
      if (!eligible) {
        if (ask) this.abortJev(ask);
        return undefined;
      }
      if (!JEV_ACT_QUESTION) {
        if (ask) this.abortJev(ask);
        this.jevFailed(i.channel, "no_question");
        return undefined;
      }
      const intent = intentKey(i.text);
      if (
        ask &&
        ask.channel === i.channel &&
        ask.intent === intent &&
        this.now() - ask.at <= DIALOG_LIMITS.preemptTtlMs &&
        !ask.controller.signal.aborted
      )
        return ask;
      if (ask) this.abortJev(ask);
      return this.askJev(
        this.stateFor(i.text, i.channel),
        key,
        intent,
        i.channel,
      );
    } catch {
      // Whatever the decider's own path threw, the turn goes on as it would
      // with the decider off: the stream decides, nothing starts unheard.
      if (ask) this.abortJev(ask);
      this.jevFailed(i.channel, "error");
      return undefined;
    }
  }

  /** One call, with the same bounded state string the stream was sent. */
  private askJev(
    state: DialogState,
    key: string,
    intent: string,
    channel: Channel,
  ): JevAsk {
    const question = JEV_ACT_QUESTION;
    if (!question) throw new Error("jev: no act question");
    const s = textSettings(this.options.settings());
    const record = { at: this.now(), cost: 0 };
    this.jevCalls.push(record);
    const controller = new AbortController();
    this.log("jev_ask", { channel });
    const ask: JevAsk = {
      intent,
      at: record.at,
      channel,
      controller,
      verdict: Promise.resolve({
        ok: false,
        code: "cancelled",
        ms: 0,
        cost: 0,
      }),
    };
    ask.verdict = askJevAct({
      fetch: this.options.fetch,
      key,
      state: jevState(
        dialogStateJson(
          state,
          s.provider === "ollama"
            ? DIALOG_LIMITS.localStateChars
            : DIALOG_LIMITS.stateChars,
        ),
      ),
      question,
      signal: controller.signal,
      now: this.now,
    })
      .catch((): JevVerdict => ({ ok: false, code: "network", ms: 0, cost: 0 }))
      .then((verdict) => {
        ask.settled = verdict;
        this.jevLive.delete(ask);
        record.cost = Number.isFinite(verdict.cost) ? verdict.cost : 0;
        this.log("jev", { channel, ...jevTrace(ask, false) });
        return verdict;
      });
    this.jevLive.add(ask);
    return ask;
  }

  /**
   * Waits for the head as awaitHead does, unless Jev answers first with a
   * confident start: then that is the outcome, and the head is left to the
   * caller to abort. Any other verdict (another act, a low probability, an
   * error, a timeout) changes nothing: the head is awaited as before.
   */
  private async raceJev(
    flight: Flight,
    deadlineMs: number,
    signal: AbortSignal,
    ask: JevAsk,
  ): Promise<
    { head: DialogHead } | { code: HeadFailure } | { jev: JevVerdict }
  > {
    const head = this.awaitHead(flight, deadlineMs, signal);
    const verdict = await Promise.race([
      head.then((): undefined => undefined),
      ask.verdict,
    ]);
    if (
      verdict?.ok &&
      verdict.act === "start" &&
      verdict.p >= JEV_START_MIN_P &&
      !signal.aborted &&
      // The user took the floor (interrupt) or the head is already in: the
      // stream's own outcome decides, as it would without Jev.
      !flight.controller.signal.aborted &&
      !flight.ended &&
      !flight.head
    )
      return { jev: verdict };
    return head;
  }

  private abortJev(ask: JevAsk) {
    if (!ask.controller.signal.aborted) ask.controller.abort();
  }

  private dropJev() {
    const ask = this.jevAsk;
    this.jevAsk = undefined;
    if (ask) this.abortJev(ask);
  }

  private launch(state: DialogState, phase: "preempt" | "turn"): Flight {
    const s = textSettings(this.options.settings());
    const flight: Flight = {
      id: `d${++this.sequence}`,
      controller: new AbortController(),
      parser: new DialogParser(),
      events: [],
      ended: false,
      startedAt: this.now(),
      readOut: !!state.notifications?.length,
      wake: () => {},
    };
    this.flights.add(flight);
    this.calls.push({ at: flight.startedAt, cost: 0 });
    const record = this.calls.at(-1)!;
    const notify = () => {
      const wake = flight.wake;
      flight.wake = () => {};
      wake();
    };
    const push = (events: DialogEvent[]) => {
      for (const event of events) {
        if (event.type === "head") flight.head = event.head;
        if (event.type === "invalid") flight.invalid = event.code;
        flight.events.push(event);
      }
      if (events.length) notify();
    };
    this.log(phase, { channel: state.channel });
    let sawText = false;
    void (async () => {
      try {
        const stream = streamText(
          s,
          this.options.providerKey(),
          {
            system: DIALOG_SYSTEM,
            input: dialogStateJson(
              state,
              s.provider === "ollama"
                ? DIALOG_LIMITS.localStateChars
                : DIALOG_LIMITS.stateChars,
            ),
            maxOutputTokens: DIALOG_LIMITS.maxOutputTokens,
            effort: dialogEffort(s.model),
          },
          this.options.fetch,
          flight.controller.signal,
          {
            deadlineMs: DIALOG_LIMITS.streamDeadlineMs,
            diagnostics: this.options.trace,
          },
        );
        for (;;) {
          const next = await stream.next();
          if (next.done) {
            flight.outcome = next.value;
            break;
          }
          sawText = true;
          push(flight.parser.push(next.value));
        }
        push(flight.parser.end());
      } catch (error) {
        // An abort of our own (interrupt, a superseded early request) is a
        // cancel whatever the transport says.
        flight.error = flight.controller.signal.aborted
          ? "cancelled"
          : codeOf(error).code;
        // What was parsed before the failure still stands (an aborted
        // stream after the head keeps its sentences); a call that produced
        // nothing is an error, not a malformed reply.
        if (sawText) push(flight.parser.end());
      } finally {
        flight.ended = true;
        this.flights.delete(flight);
        const usage = flight.outcome?.usage;
        if (usage) {
          record.cost = Number.isFinite(usage.cost) ? usage.cost : 0;
          try {
            this.options.addUsage?.(usage);
          } catch {}
        }
        notify();
      }
    })();
    return flight;
  }

  private abort(flight: Flight) {
    if (this.early?.flight === flight) this.early = undefined;
    if (!flight.controller.signal.aborted) flight.controller.abort();
    this.flights.delete(flight);
  }

  private dropEarly() {
    const early = this.early;
    this.early = undefined;
    if (early) this.abort(early.flight);
    this.dropJev();
  }

  /** The early request for these exact words, if it is still fresh. */
  private takeEarly(text: string, channel: Channel): Flight | undefined {
    const early = this.early;
    if (!early) return undefined;
    this.early = undefined;
    if (
      early.channel === channel &&
      early.key === intentKey(text) &&
      this.now() - early.at <= DIALOG_LIMITS.preemptTtlMs &&
      !early.flight.controller.signal.aborted
    )
      return early.flight;
    this.abort(early.flight);
    return undefined;
  }

  /**
   * Waits for the head, the deadline, or an interruption: the caller's
   * abort, or interrupt() ending the flight before its head arrived.
   */
  private awaitHead(
    flight: Flight,
    deadlineMs: number,
    signal: AbortSignal,
  ): Promise<{ head: DialogHead } | { code: HeadFailure }> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (value: { head: DialogHead } | { code: HeadFailure }) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onAbort = () => finish({ code: "interrupted" });
      const check = (): boolean => {
        if (flight.head) {
          finish({ head: flight.head });
          return true;
        }
        if (flight.invalid) {
          finish({ code: "invalid" });
          return true;
        }
        if (flight.ended) {
          finish({
            code:
              flight.error === "timeout"
                ? "timeout"
                : flight.error === "cancelled"
                  ? "interrupted"
                  : "error",
          });
          return true;
        }
        return false;
      };
      const wait = () => {
        if (check()) return;
        const previous = flight.wake;
        flight.wake = () => {
          previous();
          wait();
        };
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => finish({ code: "timeout" }), deadlineMs);
      wait();
    });
  }

  /**
   * The reply's sentences, filtered as they arrive: at most two for voice
   * (three for a text), each through speakableSentence; a credential ends
   * the reply. Whatever was handed out becomes the assistant's turn; when
   * it offers in words to go and look, `offer` (the user's own request)
   * becomes the open offer, unless the user has spoken since.
   */
  private sentences(
    flight: Flight,
    channel: Channel,
    offer?: string,
  ): AsyncIterable<string> {
    const session = this;
    const epoch = this.epoch;
    const spokenChannel = channel === "voice" || channel === "app";
    const max = spokenChannel
      ? DIALOG_LIMITS.voiceSentences
      : DIALOG_LIMITS.textSentences;
    const filter = (text: string) =>
      spokenChannel ? speakableSentence(text) : speakableSentence(text, 480);
    return {
      [Symbol.asyncIterator]() {
        let index = 0;
        let count = 0;
        let dropped = 0;
        const spoken: string[] = [];
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          session.abort(flight);
          // Read out from notifications, it is their words, not ours: never
          // vocabulary for a later rewrite (contextWords).
          if (spoken.length)
            session.noteAssistant(spoken.join(" "), channel, {
              untrusted: flight.readOut,
            });
          const said = spoken.join(" ");
          if (offer?.trim() && session.epoch === epoch && offersInWords(said)) {
            session.live = {
              id: `p${++session.sequence}`,
              text: offer.trim(),
              until: session.now() + DIALOG_LIMITS.proposalTtlMs,
            };
            session.log("decided", { code: "offer_in_words" });
          }
          session.log("spoken", {
            sentences: count,
            dropped,
            durationMs: session.now() - flight.startedAt,
          });
        };
        const next = async (): Promise<IteratorResult<string>> => {
          for (;;) {
            if (finished) return { done: true, value: undefined };
            while (index < flight.events.length) {
              const event = flight.events[index++];
              if (event.type === "sentence") {
                if (containsSecret(event.text)) {
                  session.log("spoken", { code: "secret" });
                  finish();
                  return { done: true, value: undefined };
                }
                const clean = filter(event.text);
                if (!clean) {
                  dropped++;
                  continue;
                }
                spoken.push(clean);
                count++;
                if (count >= max) finish();
                return { done: false, value: clean };
              }
              if (event.type === "end" || event.type === "invalid") {
                finish();
                return { done: true, value: undefined };
              }
            }
            if (flight.ended) {
              finish();
              return { done: true, value: undefined };
            }
            await new Promise<void>((resolve) => {
              const previous = flight.wake;
              flight.wake = () => {
                previous();
                resolve();
              };
            });
          }
        };
        return {
          next,
          async return() {
            finish();
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  private log(phase: string, data: Record<string, unknown> = {}) {
    trace(this.options.trace, "DialogTurn", { phase, ...data });
  }
}

type HeadFailure = "timeout" | "invalid" | "error" | "interrupted";

const OFFER_IN_WORDS =
  /\b(?:if you(?:'d| would)? (?:like|want|wish|prefer)|want me to|would you like me to|shall i|should i|i (?:can|could) (?:go (?:and )?)?(?:check|look|find|open|search|pull|see|take a look|have a look))\b/i;
/** "If you want, I can check it on the Mac." is an offer; "It's at three." is not. */
export function offersInWords(text: string): boolean {
  return OFFER_IN_WORDS.test(text.replace(/[’‘]/g, "'"));
}

/** "Send the Q3 deck to Dana" → "Want me to send the Q3 deck to Dana?" */
export function proposalLine(task: string): string | undefined {
  const text = exactOfferLine(task);
  return text ? speakableSentence(text, 240) : undefined;
}

/** The offer word for word, as a screen shows it; "" for an empty task. */
export function exactOfferLine(task: string): string {
  const text = task.trim().replace(/[.!?]+$/, "");
  if (!text) return "";
  const lead = /^\p{Lu}\p{Ll}/u.test(text)
    ? text[0].toLowerCase() + text.slice(1)
    : text;
  return `Want me to ${lead}?`;
}

/**
 * Whether the spoken offer carries every detail of the task: the same
 * letters and digits in the same order, so a link read as its host, a
 * number read as "a number" or a line cut for length is not exact. Case,
 * punctuation and quotes may differ.
 */
export function offerIsExact(line: string, task: string): boolean {
  const bare = (text: string) =>
    text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  return bare(line) === bare(exactOfferLine(task));
}

function codeOf(error: unknown): { code: string } {
  if (error instanceof TextModelError) return { code: error.code };
  if (error instanceof Error && /cancel/i.test(error.message))
    return { code: "cancelled" };
  return { code: "error" };
}
