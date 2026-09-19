/**
 * Decides what the assistant says out loud and when, and which short
 * follow-up listening windows to ask the voice helper for. It never speaks
 * over an open microphone, says each run moment once, lets urgent questions
 * preempt acknowledgements, mirrors how the user talked to it, and degrades
 * to the pill alone whenever speech is unavailable.
 */
import type { Snapshot } from "../src/core/schema";
import type { FollowUpKind } from "../src/voice/router";
import {
  PHRASES,
  approvalSuffix,
  pickPhrase,
  type PhraseKind,
  type PhraseMemory,
} from "../src/voice/phrases";
import {
  adaptContinueHint,
  speakableApproval,
  speakableQuestion,
  speakableReport,
  speakableSummary,
  speakableText,
} from "../src/voice/speakable";
import {
  followUpApprovalAllowed,
  followUpSeconds,
  type FollowUpWindow,
  type TurnPlan,
  type VoiceFragment,
  type VoiceLastTurn,
  type VoiceSource,
} from "../src/voice/turns";
import type { ProgressReport } from "../src/assistant/types";
import type { SpeakPriority, SpeechOutput, SpeechStyle } from "./speech-output";
import type { VoiceEvent } from "./voice";

export type VoiceReplies = "off" | "voice" | "always";
/** The settings Conversation reads (compatible with the full Settings). */
export interface ConversationSettings {
  handsFree: boolean;
  voiceReplies?: VoiceReplies;
  followUpListening?: boolean;
  /** How long the windows stay open (default "short"). */
  followUpWindow?: FollowUpWindow;
  voiceRate?: number;
  /**
   * "model": replies are written by the dialog model, step narration
   * ("Opening Spotify.") gives way to its replies and progress lines, and a
   * result is followed by a short listening window. "off": today's fixed
   * phrases and narration.
   */
  conversation?: "model" | "off";
  /** Spoken progress lines from the shared reporter during long runs. */
  spokenProgress?: boolean;
}
export interface ConversationOptions {
  settings: () => ConversationSettings;
  speech: SpeechOutput;
  /** The user took the floor: abort dialog streams still being written. */
  onInterrupted?: () => void;
  /**
   * Whether the dialog model can answer right now (main: the session is
   * available for voice). With conversation "model" but no usable model (no
   * key, local mode without a dialog model, over budget), narration and the
   * fixed done lines stay and no window opens after a result.
   */
  modelActive?: () => boolean;
  /** NativeVoice.call, for listen and endFollowUp. */
  voiceCall: (
    method: string,
    data?: Record<string, unknown>,
  ) => Promise<unknown>;
  now?: () => number;
  random?: () => number;
  trace?: (event: string, data: Record<string, unknown>) => void;
  /** Speaking or follow-up state changed: refresh pill.speaking/followUp. */
  onChange?: () => void;
  newId?: () => string;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}
export interface Listen {
  kind: FollowUpKind;
  seconds: number;
}
export interface SayOptions {
  priority?: SpeakPriority;
  listen?: Listen;
  /** Dedupe key: a key is said at most once. */
  key?: string;
  /** Whether the user is talking to it by voice (default true). */
  voiceTurn?: boolean;
  /** gateOf(snapshot) for an approval listen window. */
  gate?: string;
  /** What a free-text line is (reply, status, clarify); decides its style. */
  kind?: string;
}
/**
 * A model reply that main expects for a voice turn, created before the
 * decision is in so a filler can bridge a slow model. Once decided, the
 * reply's sentences (already filtered) are attached and spoken as one
 * utterance; an acting plan whose filler already played drops them, since
 * the filler was the acknowledgement.
 */
export interface ReplyHandle {
  readonly id: string;
  /** Something was, or is being, spoken for this turn. */
  readonly filled: boolean;
  attach(
    sentences: AsyncIterable<string> | undefined,
    o: {
      acting: boolean;
      /** Said when nothing else will be, for an acting plan. */
      cannedIfEmpty?: PhraseKind;
      /** A fixed line spoken at once instead of any stream (fast start). */
      line?: string;
    },
  ): void;
  cancel(): void;
  /**
   * The text the engine was handed, once the reply has been sent; with
   * spoken replies off, the text to show instead.
   */
  readonly spoken: Promise<string>;
}
export interface AcknowledgeContext {
  source?: VoiceSource;
  handsFree?: boolean;
  /** The run the plan started or changed, when main knows it. */
  runId?: string;
  /**
   * planContext().activationAt for this turn. Only that activation (and an
   * older detected window) is consumed, so a follow-up detected while main was
   * still executing this plan keeps its own source and window.
   */
  activationAt?: number;
  /**
   * The line main chose for a status or reply plan (a fixed template from the
   * run view, or a model reply later). Spoken as it is for voice turns; typed
   * turns read it on the pill.
   */
  text?: string;
  /** The model reply expected for this turn, when there was one. */
  reply?: ReplyHandle;
}
export interface PlanContext {
  source: VoiceSource;
  window?: FollowUpKind;
  turnMs?: number;
  fragment?: VoiceFragment;
  lastTurn?: VoiceLastTurn;
  /** When the activation this voice turn came from started. */
  activationAt?: number;
}

interface Utterance {
  id: string;
  kind: string;
  text: string;
  priority: SpeakPriority;
  listen?: Listen;
  /** Dedupe key; "" for one-off replies. */
  key: string;
  gate?: string;
  requestedAt: number;
  startedAt?: number;
  /** Snapshot moments stop when the run moves on. */
  valid?: (s: Snapshot | undefined) => boolean;
  /** A streamed reply: spoken sentence by sentence as one utterance. */
  stream?: AsyncIterable<string>;
  /** The reply this utterance belongs to (its filler or its stream). */
  reply?: Reply;
}
interface Reply {
  id: string;
  voiceTurn: boolean;
  filler?: PhraseKind;
  fillerTimer?: unknown;
  /** The filler, once it was requested. */
  fillerUtterance?: Utterance;
  /** The filler has finished playing. */
  fillerDone?: boolean;
  /** The streamed reply or fixed line, once attached. */
  utterance?: Utterance;
  attached: boolean;
  acting: boolean;
  cancelled: boolean;
  /** Set by acknowledge(): opened once the reply has finished playing. */
  listen?: Listen;
  handsFree: boolean;
  /** Runs when the reply's own utterance has finished or was never sent. */
  afterSpeech?: () => void;
  /** What the engine was handed. */
  spokenText: string;
  resolveSpoken: (text: string) => void;
  spoken: Promise<string>;
  /** speech_finished (or nothing to play) for the reply's utterance. */
  done: boolean;
}
interface Moment {
  key: string;
  kind: string;
  text: string;
  priority: SpeakPriority;
  listen?: Listen;
  gate?: string;
  suffix?: string;
  valid?: (s: Snapshot | undefined) => boolean;
}
interface Window {
  kind: FollowUpKind;
  state: "open" | "detected";
  gate?: string;
  at: number;
}
interface Fragment {
  text: string;
  /** FRAGMENT_TTL_MS after it was heard; asking never extends it. */
  until: number;
  /** When its question was asked (spoken, or its silent window requested). */
  askedAt?: number;
}

/**
 * Open for the whole of a spoken scroll (the helper's 90 s limit and a little
 * over), for "stop", "faster", "slower" and "scroll up"; main.ts closes it
 * with the scroll.
 */
export const SCROLL_WINDOW: Listen = {
  kind: "scroll",
  seconds: followUpSeconds("scroll"),
};
/** After a spoken result, hands-free with the model on: no wake word needed. */
const AFTER_RESULT_SECONDS = 5;
/** A filler that already played gives the streamed answer this long to wait for it. */
export const FILLER_TAIL_MS = 1200;
/** A short run whose fast-start line just played gets no spoken "Done." on top. */
export const QUICK_RUN_MS = 10000;
const QUICK_RUN_ACTIONS = 3;
const QUICK_RUN_WORDS = 8;
/** Progress lines longer than this are cut to two sentences. */
const PROGRESS_MAX_CHARS = 220;
/** Hands-free fragments wait this long for the rest before asking. */
export const FRAGMENT_GRACE: Listen = { kind: "answer", seconds: 3 };
export const FRAGMENT_TTL_MS = 20000;
/**
 * Key-down closes an open window ("cancel") just before it reports
 * shortcut_down; a fragment ended by that close is the one being answered.
 */
const KEY_DOWN_CLOSE_MS = 500;
export const REPEAT_REASON_MS = 60000;
export const QUEUED_ACK_MAX_AGE_MS = 1500;
const MAX_CONFIRM_AGAIN = 2;
const DONE_MIN_HOLD_MS = 1800;
const DONE_MAX_HOLD_MS = 8000;
const DONE_TAIL_MS = 600;
/** An accepted utterance that never started is forgotten after this. */
const STUCK_MS = 20000;
/** How long a start plan's modality waits for its run to appear. */
const BIND_MS = 15000;
const rank: Record<SpeakPriority, number> = { ack: 0, result: 1, urgent: 2 };
const TERMINAL = new Set(["completed", "cancelled", "failed"]);
const DEFAULT_PAUSE = "Paused. Capture and input are stopped.";
/** Replies that do not act on the run, so a pending moment is still news. */
const PASSIVE_PLANS: ReadonlySet<TurnPlan["kind"]> = new Set([
  "acknowledge",
  "nothingToApprove",
  "nothingRunning",
  "stillWorking",
  "status",
  "reply",
  "queue",
]);

/** main.ts currentGate(): the identity of a pending approval. */
export function gateOf(s: Snapshot | undefined): string | undefined {
  return s?.pending && s.run
    ? JSON.stringify({ run: s.run.id, action: s.pending.action })
    : undefined;
}
function approvalKey(s: Snapshot | undefined) {
  return s?.run && s.run.status === "confirming" && s.pending
    ? `approval:${s.run.id}:${s.pending.reason}:${JSON.stringify(s.pending.action)}`
    : undefined;
}
function pauseSequence(s: Snapshot | undefined) {
  const events = s?.events ?? [];
  for (let i = events.length - 1; i >= 0; i--)
    if (events[i].type === "RunPaused") return events[i].sequence_number;
  return events.at(-1)?.sequence_number ?? 0;
}
/**
 * The dedupe key of the run moment worth saying in this snapshot (section
 * 3.1), or undefined when there is nothing to say. Narration of milestones
 * ("Opening Spotify.") is a moment only while the dialog model is off: with
 * it on, the model's own reply and the progress reporter say what is
 * happening, so `narrate: false` leaves the executing state silent.
 */
export function momentKey(
  s: Snapshot | undefined,
  o: { narrate?: boolean } = {},
): string | undefined {
  const run = s?.run;
  if (!s || !run) return undefined;
  switch (run.status) {
    case "confirming":
      return approvalKey(s);
    case "takeover":
      return `takeover:${run.id}:${s.message}`;
    case "paused":
      return isSilentPause(s.message)
        ? undefined
        : `paused:${run.id}:${pauseSequence(s)}`;
    case "executing":
      // Brief narration of visible milestones ("Opening Spotify.").
      return o.narrate !== false && /^Opening .{1,80}\.$/.test(s.message)
        ? `narrate:${run.id}:${s.message}`
        : undefined;
    case "completed":
      return `done:${run.id}`;
    case "failed":
      return `failed:${run.id}`;
    case "cancelled":
      // A user stop was already acknowledged; only a budget stop explains.
      return /budget reached/i.test(s.message)
        ? `cancelled:${run.id}`
        : undefined;
  }
  return undefined;
}
/** Pauses the user caused: acknowledged already, never read back. */
export function isSilentPause(message: string | undefined) {
  return (
    !message?.trim() ||
    message === DEFAULT_PAUSE ||
    /you[’']re controlling the computer/i.test(message)
  );
}

export class Conversation {
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly newId: () => string;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private snapshot?: Snapshot;
  private current?: Utterance;
  private queued?: Utterance;
  private said = new Set<string>();
  private memory: PhraseMemory = {};
  private runs = new Map<string, { voice?: boolean; firstSeen: number }>();
  /** Runs a start turn already attributed. */
  private claimed = new Set<string>();
  private active = new Set<string>();
  /** Modality for the next new run; `turn` when a start plan recorded it. */
  private pendingStart?: { voice: boolean; at: number; turn: boolean };
  private turn?: VoiceLastTurn;
  private fragmentValue?: Fragment;
  /** A fragment its answer window's cancel ended, kept for a key-down. */
  private cancelledFragment?: { value: Fragment; at: number };
  /** When planContext() last ran: older activations belong to that plan. */
  private plannedAt?: number;
  private activation?: {
    source: VoiceSource;
    window?: FollowUpKind;
    at: number;
  };
  private window?: Window;
  private approvalGate?: string;
  private clarifying?: { text: string; timer?: unknown };
  private suffixUsed = false;
  private confirmAgain = { key: "", count: 0 };
  private lastPause?: { runId: string; message: string; at: number };
  private done?: { runId: string; shownAt: number; finishedAt?: number };
  /** The model reply expected for the turn being decided. */
  private reply?: Reply;
  /** Each handle's record, for acknowledge() after the reply has played. */
  private replies = new WeakMap<ReplyHandle, Reply>();
  /** When a reply or acknowledgement last finished playing. */
  private lastReplyEndedAt?: number;

  constructor(private readonly options: ConversationOptions) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      options.clearTimer ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** Audio is playing (pill voice bars). */
  get speaking(): boolean {
    return this.current?.startedAt !== undefined;
  }
  /** The open follow-up window (pill glow). */
  get followUp(): FollowUpKind | undefined {
    return this.window?.state === "open" ? this.window.kind : undefined;
  }
  /**
   * The approval captured when the approval window was requested. Use it as
   * voiceGate for a followup_detected of kind "approval".
   */
  get windowGate(): string | undefined {
    return this.window?.kind === "approval" ? this.window.gate : undefined;
  }
  /** A clarified fragment still waiting for the rest of the command. */
  get fragment(): VoiceFragment | undefined {
    const f = this.fragmentValue;
    return f && this.now() < f.until
      ? { text: f.text, until: f.until }
      : undefined;
  }
  get lastTurn(): VoiceLastTurn | undefined {
    return this.turn ? { ...this.turn } : undefined;
  }
  /**
   * Forgets a clarified fragment and a question still waiting to be asked
   * (dismiss, typed commands).
   */
  clearFragment() {
    this.setFragment(undefined);
    this.cancelClarify();
  }

  /**
   * Records how the user gave input. With a run id, it marks that run as
   * voice- or text-initiated; without one, the next new run gets it.
   */
  noteInput(modality: "voice" | "text", runId?: string) {
    const voice = modality === "voice";
    if (!runId) {
      this.pendingStart = { voice, at: this.now(), turn: false };
      return;
    }
    const run = this.runs.get(runId);
    if (!run) this.runs.set(runId, { voice, firstSeen: this.now() });
    else if (voice) run.voice = true;
    else run.voice ??= false;
  }

  /** The Conversation-owned fields of planVoiceTurn's input. */
  planContext(fromVoice = true): PlanContext {
    const now = this.now();
    this.plannedAt = now;
    const activation = fromVoice ? this.activation : undefined;
    const source: VoiceSource = !fromVoice
      ? "text"
      : (activation?.source ??
        (this.options.settings().handsFree ? "wake" : "ptt"));
    const followup = source === "followup" && activation;
    return {
      source,
      window: followup ? activation.window : undefined,
      turnMs: followup ? now - activation.at : undefined,
      fragment: this.fragment,
      lastTurn: this.lastTurn,
      activationAt: activation?.at,
    };
  }

  /**
   * Call after main executed a turn plan. Records the turn and fragment and
   * replies: push-to-talk acknowledges out loud, hands-free relies on the
   * earcon and pill; questions and refusals are spoken in both.
   */
  acknowledge(plan: TurnPlan, ctx: AcknowledgeContext = {}) {
    const now = this.now();
    const settings = this.options.settings();
    // Activations after this plan's own belong to a newer turn.
    const planned = ctx.activationAt ?? this.plannedAt ?? Infinity;
    const own =
      this.activation && this.activation.at <= planned
        ? this.activation
        : undefined;
    const source = ctx.source ?? own?.source ?? "text";
    const handsFree = ctx.handsFree ?? settings.handsFree;
    const voice = source !== "text";
    const ptt = source === "ptt";
    const s = this.snapshot;
    const run = s?.run && !TERMINAL.has(s.run.status) ? s.run : undefined;

    let runId = ctx.runId;
    if (plan.kind === "start") {
      runId ??= this.unclaimedRun(now);
      if (runId) {
        // This turn created the run, so it decides how the run was started.
        this.claimed.add(runId);
        const known = this.runs.get(runId);
        if (known) known.voice = voice;
        else this.runs.set(runId, { voice, firstSeen: now });
      } else this.pendingStart = { voice, at: now, turn: true };
    } else {
      runId ??= run?.id;
      if (runId && voice) this.noteInput("voice", runId);
    }
    this.turn = {
      plan: plan.kind,
      runId,
      actionsAtEnd: plan.kind === "start" ? 0 : (run?.actions ?? 0),
      endedAt: now,
    };
    if (plan.kind === "clarify")
      this.setFragment({ text: plan.fragment, until: now + FRAGMENT_TTL_MS });
    else if (
      [
        "start",
        "revise",
        "amendTask",
        "stop",
        "pause",
        "resume",
        "undo",
        "scroll",
        "queue",
      ].includes(plan.kind)
    )
      this.setFragment(undefined);
    if (own) this.activation = undefined;
    if (this.window?.state === "detected" && this.window.at <= planned)
      this.window = undefined;
    const newerTurn = !!this.activation;
    // The user just acted on whatever the run was showing; reading that
    // moment out now would talk over the result of their own turn.
    const shown = this.keyOf(s);
    if (shown && !PASSIVE_PLANS.has(plan.kind)) this.remember(shown);

    // A model reply that is speaking (or spoke, as the filler) for this turn
    // replaces the canned phrase; the listening window that phrase would
    // have carried opens once the reply has finished playing instead.
    const model = ctx.reply ? this.replyOf(ctx.reply) : undefined;
    const spokenByModel = !!model && !model.cancelled && this.filled(model);
    const afterReply = (listen: Listen | undefined) => {
      if (!model) return;
      model.listen =
        listen && this.windowsAllowed(handsFree) ? listen : undefined;
      model.handsFree = handsFree;
      if (model.done) this.finishReply(model);
    };
    // Typed turns are answered on the pill only.
    if (voice && spokenByModel) {
      switch (plan.kind) {
        case "start":
        case "replace":
          afterReply(ptt ? undefined : this.listenWindow("continuation"));
          break;
        case "revise":
        case "queue":
          afterReply(this.listenWindow("continuation"));
          break;
        case "pause":
          afterReply(this.listenWindow("answer"));
          break;
        case "status":
          afterReply(undefined);
          this.repeatApproval(s);
          break;
        case "reply":
          // A reply that asks something waits for the answer.
          afterReply(undefined);
          if (plan.repeatApproval) this.repeatApproval(s);
          break;
        default:
          afterReply(undefined);
      }
    } else if (voice) {
      if (model) afterReply(undefined);
      const reply = (
        kind: PhraseKind,
        priority: SpeakPriority,
        speak: boolean,
        listen?: Listen,
        gate?: string,
      ) => {
        if (speak) this.say(kind, { priority, listen, voiceTurn: true, gate });
        else if (listen && this.windowsAllowed(handsFree))
          void this.listen(listen);
      };
      switch (plan.kind) {
        // Acknowledge out loud in every mode, like a person would. In
        // hands-free the follow-up window reopens right after the reply.
        case "start":
        case "replace":
          reply(
            "ackStart",
            "ack",
            true,
            ptt ? undefined : this.listenWindow("continuation"),
          );
          break;
        case "revise":
          reply(
            "ackCorrection",
            "ack",
            true,
            this.listenWindow("continuation"),
          );
          break;
        case "stop":
          reply("ackStop", "ack", true);
          break;
        case "pause":
          reply("ackPause", "ack", true, this.listenWindow("answer"));
          break;
        case "resume":
          reply("ackResume", "ack", true);
          break;
        case "approve":
          reply("ackApprove", "ack", true);
          break;
        case "decline":
          reply("ackDecline", "ack", true, this.listenWindow("answer"));
          break;
        case "needClick":
          reply("needClick", "urgent", true);
          break;
        case "confirmAgain": {
          const key = approvalKey(s) ?? "";
          if (this.confirmAgain.key !== key)
            this.confirmAgain = { key, count: 0 };
          // After two re-prompts the pill alone asks.
          if (++this.confirmAgain.count <= MAX_CONFIRM_AGAIN)
            reply(
              "confirmAgain",
              "urgent",
              true,
              this.listenWindow("approval"),
              gateOf(s),
            );
          // Under the conversation setting a bare "thanks" lands here, and the
          // helper, which heard a closing phrase and knows nothing of the
          // question, opened no window after it: the room stays open in a
          // continuation window (never an approval window nobody heard asked
          // for), whose "yes" passes the stricter follow-up gates. A spoken
          // re-ask's own approval window takes over from it.
          if (
            settings.followUpWindow === "conversation" &&
            this.windowsAllowed(handsFree)
          )
            void this.listen(this.listenWindow("continuation"));
          break;
        }
        case "nothingToApprove":
          reply(
            "nothingToApprove",
            "result",
            true,
            run && ["paused", "takeover"].includes(run.status)
              ? this.listenWindow("answer")
              : undefined,
          );
          break;
        case "nothingRunning":
          reply("nothingRunning", "result", true);
          break;
        case "stillWorking":
          reply("stillWorking", "result", true);
          break;
        case "clarify":
          this.clarify(plan.question, undefined, { source, handsFree });
          break;
        case "queue":
          reply("queued", "ack", true, this.listenWindow("continuation"));
          break;
        case "status":
          // The truthful line main built from the run view; without one, the
          // short answer the run's presence allows.
          if (ctx.text?.trim())
            this.say(
              { text: ctx.text },
              { priority: "result", voiceTurn: true, kind: "status" },
            );
          else reply(run ? "stillWorking" : "nothingRunning", "result", true);
          this.repeatApproval(s);
          break;
        case "reply":
          if (ctx.text?.trim())
            this.say(
              { text: ctx.text },
              { priority: "result", voiceTurn: true, kind: "reply" },
            );
          if (plan.repeatApproval) this.repeatApproval(s);
          break;
        case "amendTask":
        case "acknowledge":
        // "Thanks": main closed the window; nothing is said and none opens.
        case "endConversation":
          break;
        // The run reports the undo itself, a moment later: "Undone." or
        // "Nothing to undo." as its pause or its result.
        case "undo":
          break;
        // The page moving is the acknowledgement; its window opens below.
        case "scroll":
          break;
      }
    } else if (model) afterReply(undefined);
    // A scroll listens for its own steering words for as long as it may run,
    // whether it was spoken or typed; the window closes with the scroll.
    if (
      plan.kind === "scroll" &&
      plan.request.act !== "stop" &&
      this.windowsAllowed(handsFree)
    )
      void this.listen(SCROLL_WINDOW);
    // Listening has ended: a prompt held back while capturing may speak now,
    // unless a newer turn is already capturing (its end re-evaluates).
    if (s && !newerTurn) this.onSnapshot(s, { listening: false });
  }

  /**
   * Expects a model reply for the turn `turnId`, which main is about to
   * decide. With a filler, the filler plays if nothing has been attached by
   * `fillerAfterMs`, so a slow model never leaves a silence.
   */
  expectReply(
    turnId: string,
    o: { voiceTurn: boolean; filler?: PhraseKind; fillerAfterMs: number },
  ): ReplyHandle {
    if (this.reply && !this.reply.cancelled) this.cancelReply(this.reply);
    let resolveSpoken: (text: string) => void = () => {};
    const spoken = new Promise<string>((resolve) => (resolveSpoken = resolve));
    const reply: Reply = {
      id: turnId,
      voiceTurn: o.voiceTurn,
      filler: o.filler,
      attached: false,
      acting: false,
      cancelled: false,
      handsFree: this.options.settings().handsFree,
      spokenText: "",
      resolveSpoken,
      spoken,
      done: false,
    };
    this.reply = reply;
    if (o.voiceTurn && o.filler)
      reply.fillerTimer = this.setTimer(() => {
        reply.fillerTimer = undefined;
        if (reply.cancelled || reply.attached) return;
        const u = this.say(o.filler!, { priority: "ack", voiceTurn: true });
        if (u) {
          u.reply = reply;
          reply.fillerUtterance = u;
        }
        this.trace("DialogReply", { phase: "filler", kind: o.filler });
      }, o.fillerAfterMs);
    const self = this;
    const handle: ReplyHandle = {
      id: turnId,
      get filled() {
        return self.filled(reply);
      },
      attach: (sentences, a) => this.attachReply(reply, sentences, a),
      cancel: () => this.cancelReply(reply),
      spoken,
    };
    this.replies.set(handle, reply);
    return handle;
  }

  private replyOf(handle: ReplyHandle): Reply | undefined {
    return this.replies.get(handle);
  }

  /** Something plays, or played, for this turn: no canned phrase needed. */
  private filled(reply: Reply): boolean {
    return !!reply.utterance || (!!reply.fillerUtterance && reply.acting);
  }

  private attachReply(
    reply: Reply,
    sentences: AsyncIterable<string> | undefined,
    o: { acting: boolean; cannedIfEmpty?: PhraseKind; line?: string },
  ) {
    if (reply.cancelled || reply.attached) {
      void this.release(sentences);
      return;
    }
    reply.attached = true;
    reply.acting = o.acting;
    if (reply.fillerTimer !== undefined) {
      this.clearTimer(reply.fillerTimer);
      reply.fillerTimer = undefined;
    }
    const settle = (text: string) => {
      reply.spokenText = text;
      reply.resolveSpoken(text);
    };
    if (o.line) {
      // The fixed fast-start line: spoken this instant, no model involved.
      void this.release(sentences);
      const u = reply.voiceTurn
        ? this.say(
            { text: o.line },
            { priority: "ack", voiceTurn: true, kind: "reply" },
          )
        : undefined;
      if (u) {
        u.reply = reply;
        reply.utterance = u;
        settle(o.line);
      } else this.noReplySpeech(reply, "");
      return;
    }
    if (!sentences || !reply.voiceTurn) {
      void this.release(sentences);
      if (
        o.acting &&
        o.cannedIfEmpty &&
        !reply.fillerUtterance &&
        reply.voiceTurn
      ) {
        const u = this.say(o.cannedIfEmpty, {
          priority: "ack",
          voiceTurn: true,
        });
        if (u) {
          u.reply = reply;
          reply.utterance = u;
          settle(u.text);
          return;
        }
      }
      this.noReplySpeech(reply, "");
      return;
    }
    if ((this.options.settings().voiceReplies ?? "voice") === "off") {
      // Spoken replies are off: the same rule deliver() applies to every
      // phrase. The answer goes to the pill instead, like a typed turn's.
      this.trace("VoiceReply", {
        phase: "skipped",
        kind: "reply",
        priority: "result",
        code: "off",
      });
      void this.collect(sentences).then((text) =>
        this.noReplySpeech(reply, text),
      );
      return;
    }
    const stream = () => {
      if (reply.cancelled) {
        void this.release(sentences);
        return;
      }
      const u: Utterance = {
        id: this.newId(),
        kind: "reply",
        text: "",
        priority: "result",
        key: "",
        requestedAt: this.now(),
        stream: sentences,
        reply,
      };
      reply.utterance = u;
      this.request(u);
    };
    if (!reply.fillerUtterance) {
      stream();
      return;
    }
    if (o.acting) {
      // The filler was the acknowledgement; the model's line would repeat it.
      // Its window opens once the filler has played (now, if it already has).
      void this.release(sentences);
      this.trace("DialogReply", { phase: "dropped", code: "filler_spoke" });
      settle("");
      if (reply.fillerDone) this.finishReply(reply);
      return;
    }
    // An answer waits for its filler to end, briefly.
    const filler = reply.fillerUtterance;
    if (this.current !== filler) {
      stream();
      return;
    }
    let timer: unknown;
    reply.afterSpeech = () => {
      reply.afterSpeech = undefined;
      if (timer !== undefined) this.clearTimer(timer);
      stream();
    };
    timer = this.setTimer(() => {
      timer = undefined;
      reply.afterSpeech?.();
    }, FILLER_TAIL_MS);
  }

  /** The reply has nothing of its own to play: settle and open its window. */
  private noReplySpeech(reply: Reply, spoken: string) {
    reply.spokenText = spoken;
    reply.resolveSpoken(spoken);
    reply.done = true;
    if (reply.listen !== undefined || reply.attached) this.finishReply(reply);
  }

  /** The reply's utterance ended (or never played): its window may open. */
  private finishReply(reply: Reply) {
    reply.done = true;
    const listen =
      reply.listen ??
      (/\?\s*$/.test(reply.spokenText) && this.windowsAllowed(reply.handsFree)
        ? this.listenWindow("answer")
        : undefined);
    reply.listen = undefined;
    if (listen && !reply.cancelled) void this.listen(listen);
    if (this.reply === reply && reply.attached) this.reply = undefined;
  }

  private cancelReply(reply: Reply | undefined) {
    if (!reply || reply.cancelled) return;
    reply.cancelled = true;
    if (reply.fillerTimer !== undefined) this.clearTimer(reply.fillerTimer);
    reply.fillerTimer = undefined;
    reply.afterSpeech = undefined;
    reply.listen = undefined;
    reply.resolveSpoken(reply.spokenText);
    if (this.reply === reply) this.reply = undefined;
  }

  /** A reply's sentences as one line (the session bounds them). */
  private async collect(sentences: AsyncIterable<string>): Promise<string> {
    const parts: string[] = [];
    try {
      for await (const sentence of sentences) parts.push(sentence);
    } catch {}
    return parts.join(" ");
  }

  /** Lets a stream nobody will read end its model call. */
  private async release(sentences: AsyncIterable<string> | undefined) {
    const iterator = sentences?.[Symbol.asyncIterator]?.();
    try {
      await iterator?.return?.();
    } catch {}
  }

  /**
   * A status answer while an approval is pending ends with the question again,
   * gate and window included: the user asked instead of answering, and a "yes"
   * after the answer must have somewhere to land. Forgetting the moment lets
   * the re-evaluation at the end of acknowledge() say it once more.
   */
  private repeatApproval(s: Snapshot | undefined) {
    const key = approvalKey(s);
    if (key) this.said.delete(key);
  }

  /**
   * Asks a clarification question. Hands-free with follow-up listening first
   * waits a short grace window for the rest of the sentence, and asks only if
   * nothing was heard; push-to-talk asks immediately.
   */
  clarify(question: string, fragment?: string, ctx: AcknowledgeContext = {}) {
    const now = this.now();
    if (fragment !== undefined)
      this.setFragment({ text: fragment, until: now + FRAGMENT_TTL_MS });
    const handsFree = ctx.handsFree ?? this.options.settings().handsFree;
    const source = ctx.source ?? this.activation?.source ?? "ptt";
    const text = PHRASES.goOn.includes(question)
      ? pickPhrase("goOn", this.memory, this.random)
      : question;
    this.cancelClarify();
    if (source !== "ptt" && this.windowsAllowed(handsFree)) {
      const pending: { text: string; timer?: unknown } = { text };
      this.clarifying = pending;
      const ask = () => {
        if (this.clarifying === pending) this.askClarify();
      };
      // If the helper never reports the window closing, ask anyway.
      pending.timer = this.setTimer(ask, FRAGMENT_GRACE.seconds * 1000 + 2000);
      void this.listen(FRAGMENT_GRACE).then((ok) => {
        if (!ok) ask();
      });
      return;
    }
    this.markAsked();
    this.say(
      { text },
      {
        priority: "urgent",
        listen: this.listenWindow("answer"),
        kind: "clarify",
      },
    );
  }

  /**
   * Speaks a phrase or text now (subject to voiceReplies, priority and the
   * queue). A listen window follows when hands-free follow-up is on.
   */
  say(
    what: PhraseKind | { text: string },
    options: SayOptions = {},
  ): Utterance | undefined {
    const kind = typeof what === "string" ? what : (options.kind ?? "text");
    const text =
      typeof what === "string"
        ? pickPhrase(what, this.memory, this.random)
        : what.text.trim();
    if (!text) return undefined;
    if (options.key) {
      if (this.said.has(options.key)) return undefined;
      this.remember(options.key);
    }
    return this.deliver(
      {
        key: options.key ?? "",
        kind,
        text,
        priority: options.priority ?? defaultPriority(kind),
        listen: options.listen,
        gate: options.gate,
      },
      options.voiceTurn ?? true,
    );
  }

  /**
   * Call from emit() before its listening early return, and again with
   * listening false whenever listening ends.
   */
  onSnapshot(s: Snapshot, state: { listening: boolean; handsFree?: boolean }) {
    this.snapshot = s;
    const run = s.run;
    if (!run) return;
    const now = this.now();
    this.bind(run.id, now);
    if (!TERMINAL.has(run.status)) this.active.add(run.id);
    if (TERMINAL.has(run.status) && this.done?.runId !== run.id)
      this.done = { runId: run.id, shownAt: now };
    if (this.current?.valid && !this.current.valid(s)) this.stale(this.current);
    if (this.queued?.valid && !this.queued.valid(s)) this.queued = undefined;
    if (state.listening || !this.active.has(run.id)) return;
    const key = this.keyOf(s);
    if (!key || this.said.has(key)) return;
    const handsFree = state.handsFree ?? this.options.settings().handsFree;
    const moment = this.moment(s, key, handsFree);
    if (!moment) return;
    this.remember(key);
    this.deliver(moment, this.runs.get(run.id)?.voice === true, handsFree);
  }

  /**
   * Progress updates from the shared reporter (increment 4B): spoken once
   * each, for runs the user started by voice, while nothing more pressing (an
   * approval, a takeover) has the floor, and never while listening. A line
   * waits behind a reply that is still playing rather than cutting it off.
   */
  onProgress(report: ProgressReport): void {
    if (!report.speak || this.options.settings().spokenProgress === false)
      return;
    const s = this.snapshot;
    const run = s?.run;
    if (!run || run.id !== report.runId || TERMINAL.has(run.status)) return;
    if (!this.active.has(run.id)) return;
    if (run.status === "confirming" || run.status === "takeover") return;
    const key = `progress:${report.runId}:${report.seq}`;
    if (this.said.has(key)) return;
    // Built from screen or panel text: every sentence under the reply rules
    // (no coaching, no asking for a code), or nothing.
    const text = speakableReport(report.text, PROGRESS_MAX_CHARS);
    if (!text) return;
    this.remember(key);
    this.deliver(
      {
        key,
        kind: report.kind === "final" ? "recap" : "progress",
        text,
        priority: "result",
        valid: (x) => x?.run?.id === run.id && !TERMINAL.has(x.run.status),
      },
      this.runs.get(run.id)?.voice === true,
    );
  }

  /** momentKey with narration only while the dialog model is off. */
  private keyOf(s: Snapshot | undefined) {
    return momentKey(s, { narrate: !this.modelOn() });
  }

  /** The dialog model is on and can actually answer. */
  private modelOn(): boolean {
    return (
      this.options.settings().conversation === "model" &&
      (this.options.modelActive?.() ?? true)
    );
  }

  /** Speech and follow-up events from the voice helper. */
  onVoiceEvent(e: VoiceEvent) {
    const now = this.now();
    switch (e.event) {
      case "shortcut_down":
      case "wake_detected":
        if (e.event === "shortcut_down") this.restoreFragment(now);
        this.activation = {
          source: e.event === "wake_detected" ? "wake" : "ptt",
          at: now,
        };
        this.interrupted();
        return;
      case "speech_started": {
        const u = this.current;
        if (!u || u.id !== e.utteranceId) return;
        u.startedAt = now;
        this.trace("VoiceReply", {
          phase: "started",
          kind: u.kind,
          priority: u.priority,
          latencyMs: now - u.requestedAt,
        });
        if (u.valid && !u.valid(this.snapshot)) this.stale(u);
        this.changed();
        return;
      }
      case "speech_finished":
      case "speech_error": {
        const u = this.current;
        if (!u || u.id !== e.utteranceId) return;
        this.current = undefined;
        if (u.key.startsWith("done:") && this.done) this.done.finishedAt = now;
        if (u.kind === "reply" || u.kind.startsWith("ack"))
          this.lastReplyEndedAt = now;
        const error = e.event === "speech_error";
        this.replyEnded(u, error || e.interrupted === true);
        this.trace("VoiceReply", {
          phase: error ? "error" : "finished",
          kind: u.kind,
          priority: u.priority,
          durationMs: u.startedAt === undefined ? 0 : now - u.startedAt,
          interrupted: error || e.interrupted === true,
          ...(e.reason ? { code: e.reason } : {}),
        });
        // Speech that never played still owes its listening window.
        if (error && u.startedAt === undefined && u.listen)
          this.fallbackListen(u);
        if (e.interrupted && e.reason !== "replaced") this.queued = undefined;
        this.next();
        this.changed();
        return;
      }
      case "followup_open": {
        const kind = e.kind as FollowUpKind;
        this.window = {
          kind,
          state: "open",
          at: now,
          gate: kind === "approval" ? this.approvalGate : undefined,
        };
        this.trace("FollowUp", { phase: "open", window: kind });
        this.changed();
        return;
      }
      case "followup_detected": {
        const kind = (e.kind as FollowUpKind) ?? this.window?.kind;
        this.window = {
          kind,
          state: "detected",
          at: now,
          gate:
            kind === "approval"
              ? (this.window?.gate ?? this.approvalGate)
              : undefined,
        };
        this.activation = { source: "followup", window: kind, at: now };
        this.trace("FollowUp", { phase: "detected", window: kind });
        this.interrupted();
        this.changed();
        return;
      }
      case "followup_closed": {
        const kind = e.kind as FollowUpKind;
        const window = this.window;
        this.trace("FollowUp", {
          phase: "closed",
          window: kind,
          endReason: e.endReason,
          durationMs: window ? now - window.at : 0,
        });
        const fragment = this.fragmentValue;
        if (fragment && kind === "answer") {
          // The answer window of an asked question passed unanswered, or the
          // window was cancelled: the fragment is over. The grace window's
          // timeout is not an answer window yet; it asks below.
          const askedAt = fragment.askedAt;
          if (e.endReason === "cancel") this.endFragment(now, true);
          else if (
            e.endReason === "timeout" &&
            askedAt !== undefined &&
            window?.state === "open" &&
            window.kind === "answer" &&
            window.at >= askedAt
          )
            this.endFragment(now, false);
        }
        // Any close ends a window still open, including a wake phrase heard
        // inside it; a detected window stays until its turn is acknowledged.
        if (window?.state === "open") this.window = undefined;
        if (e.endReason !== "detected" && this.clarifying) {
          // Nothing more came: ask. A reply or a cancel takes the floor.
          if (e.endReason === "timeout" && kind === "answer") this.askClarify();
          else this.cancelClarify();
        }
        this.changed();
        return;
      }
    }
  }

  /**
   * The user took the floor (key-down, wake, follow-up speech). The helper
   * has already stopped playback; forget queued and pending replies.
   */
  interrupted() {
    const had = !!this.current;
    this.current = undefined;
    this.queued = undefined;
    this.cancelClarify();
    // A model reply still being written must not start, or fall back, later.
    this.cancelReply(this.reply);
    try {
      this.options.onInterrupted?.();
    } catch {}
    // A cloud reply still being fetched must not start, or fall back, later.
    this.cancelSpeech();
    if (had) this.changed();
  }

  /** The utterance of a reply (filler, line or stream) ended. */
  private replyEnded(u: Utterance, interrupted: boolean) {
    const reply = u.reply;
    if (!reply) return;
    if (u === reply.fillerUtterance) {
      reply.fillerDone = true;
      if (reply.afterSpeech && !interrupted) {
        reply.afterSpeech();
        return;
      }
      // For an acting plan the filler was the whole reply.
      if (reply.attached && !reply.utterance) {
        if (interrupted) this.cancelReply(reply);
        else this.finishReply(reply);
      }
      return;
    }
    if (u === reply.utterance) {
      if (interrupted) this.cancelReply(reply);
      else this.finishReply(reply);
    }
  }

  /**
   * The voice helper restarted or became unavailable: forget replies, the
   * window, a pending question and the activation it was handling. What was
   * already said stays remembered, so moments are not said again.
   */
  reset() {
    this.current = undefined;
    this.queued = undefined;
    this.window = undefined;
    this.approvalGate = undefined;
    this.activation = undefined;
    this.cancelledFragment = undefined;
    this.cancelClarify();
    this.cancelReply(this.reply);
    this.cancelSpeech();
    this.changed();
  }

  /** Stops any reply now (dismiss, click, stop, emergency stop). */
  async stopSpeaking(): Promise<void> {
    const had = !!this.current;
    this.current = undefined;
    this.queued = undefined;
    this.cancelClarify();
    this.cancelReply(this.reply);
    if (had) this.changed();
    try {
      await this.options.speech.stop();
    } catch {}
  }

  /**
   * How much longer a done card should stay. For the card of the run that
   * just finished (runId): at least 1.8 s after it appeared, until 0.6 s after
   * the spoken result ends, at most 8 s. Any other card: 1.8 s.
   */
  doneHoldMs(runId?: string): number {
    const now = this.now();
    const done = this.done;
    if (
      !done ||
      runId === undefined ||
      runId !== done.runId ||
      now - done.shownAt >= DONE_MAX_HOLD_MS
    )
      return DONE_MIN_HOLD_MS;
    let until = done.shownAt + DONE_MIN_HOLD_MS;
    const key = `done:${done.runId}`;
    const speaking = [this.current, this.queued].find((u) => u?.key === key);
    if (speaking)
      until = Math.max(
        until,
        (speaking.startedAt ?? now) +
          this.estimateMs(speaking.text) +
          DONE_TAIL_MS,
      );
    else if (done.finishedAt !== undefined)
      until = Math.max(until, done.finishedAt + DONE_TAIL_MS);
    until = Math.min(until, done.shownAt + DONE_MAX_HOLD_MS);
    return Math.max(0, until - now);
  }

  private moment(
    s: Snapshot,
    key: string,
    handsFree: boolean,
  ): Moment | undefined {
    const run = s.run!;
    const id = run.id;
    const phrase = (kind: PhraseKind) =>
      pickPhrase(kind, this.memory, this.random);
    switch (run.status) {
      case "confirming": {
        if (!s.pending) return;
        return {
          key,
          kind: "approval",
          text: speakableApproval(s.pending) ?? phrase("approvalGeneric"),
          suffix: approvalSuffix({
            first: !this.suffixUsed,
            handsFree,
            followUp: this.windowsAllowed(handsFree),
            restricted: !followUpApprovalAllowed(s.pending.reason),
          }),
          priority: "urgent",
          listen: this.listenWindow("approval"),
          gate: gateOf(s),
          valid: (x) => approvalKey(x) === key,
        };
      }
      case "takeover": {
        const message = s.message;
        return {
          key,
          kind: "question",
          text: speakableQuestion(message) ?? phrase("needHelp"),
          priority: "urgent",
          listen: this.listenWindow("answer"),
          valid: (x) =>
            x?.run?.id === id &&
            x.run.status === "takeover" &&
            x.message === message,
        };
      }
      case "paused": {
        const message = s.message;
        const sequence = pauseSequence(s);
        const now = this.now();
        const last = this.lastPause;
        const repeated =
          last?.runId === id &&
          last.message === message &&
          now - last.at <= REPEAT_REASON_MS;
        this.lastPause = { runId: id, message, at: now };
        return {
          key,
          kind: repeated ? "repeatReason" : "paused",
          text: repeated
            ? phrase("repeatReason")
            : (speakableText(adaptContinueHint(message, handsFree)) ??
              phrase("needHelp")),
          priority: "result",
          listen: this.listenWindow("answer"),
          valid: (x) =>
            x?.run?.id === id &&
            x.run.status === "paused" &&
            pauseSequence(x) === sequence,
        };
      }
      case "executing": {
        const text = speakableText(s.message);
        if (!text) return undefined;
        return {
          key,
          kind: "narrate",
          text,
          priority: "ack",
          valid: (x) => x?.run?.id === id && !TERMINAL.has(x.run.status),
        };
      }
      case "completed": {
        const model = this.modelOn();
        const summary = run.summary || s.message;
        const text =
          (model
            ? speakableSummary(summary, 220, 2)
            : speakableSummary(summary)) ?? phrase("doneGeneric");
        // A short run whose own start line ("Opening Spotify.") just played
        // has said enough: the pill shows the outcome.
        if (
          model &&
          this.lastReplyEndedAt !== undefined &&
          this.now() - this.lastReplyEndedAt < QUICK_RUN_MS &&
          run.actions <= QUICK_RUN_ACTIONS &&
          // A tool changed something: the words that say what were never
          // on screen, so "Added Milk to Reminders." is always spoken.
          !run.tools?.writes &&
          text.split(/\s+/).length <= QUICK_RUN_WORDS
        ) {
          this.trace("VoiceReply", {
            phase: "skipped",
            kind: "done",
            priority: "result",
            code: "quick_run",
          });
          return undefined;
        }
        return {
          key,
          kind: "done",
          text,
          priority: "result",
          ...(model
            ? { listen: this.listenWindow("answer", AFTER_RESULT_SECONDS) }
            : {}),
        };
      }
      case "failed":
        return {
          key,
          kind: "failed",
          text: speakableText(s.message) ?? phrase("failGeneric"),
          priority: "urgent",
        };
      case "cancelled":
        return {
          key,
          kind: "budgetStop",
          text: phrase("budgetStop"),
          priority: "result",
        };
    }
    return undefined;
  }

  private deliver(
    moment: Moment,
    voiceTurn: boolean,
    handsFree?: boolean,
  ): Utterance | undefined {
    const settings = this.options.settings();
    const replies = settings.voiceReplies ?? "voice";
    const speak = replies === "always" || (replies === "voice" && voiceTurn);
    const hands = handsFree ?? settings.handsFree;
    const listen =
      moment.listen && this.windowsAllowed(hands) && (voiceTurn || speak)
        ? moment.listen
        : undefined;
    if (!speak) {
      this.trace("VoiceReply", {
        phase: "skipped",
        kind: moment.kind,
        priority: moment.priority,
        code: replies === "off" ? "off" : "typed",
      });
      if (listen) void this.listen(listen);
      return undefined;
    }
    let text = moment.text;
    if (moment.suffix) {
      text = `${text} ${moment.suffix}`;
      this.suffixUsed = true;
    }
    if (listen?.kind === "approval" && moment.gate)
      this.approvalGate = moment.gate;
    const u: Utterance = {
      id: this.newId(),
      kind: moment.kind,
      text,
      priority: moment.priority,
      listen,
      key: moment.key,
      gate: moment.gate,
      requestedAt: this.now(),
      valid: moment.valid,
    };
    this.request(u);
    return u;
  }

  private request(u: Utterance) {
    const current = this.current;
    if (
      current &&
      current.startedAt === undefined &&
      u.requestedAt - current.requestedAt > STUCK_MS
    )
      this.current = undefined;
    if (
      this.current &&
      (rank[u.priority] < rank[this.current.priority] ||
        // A result never cuts a streamed reply short: the done line and
        // progress wait for it to finish. Urgent questions still preempt.
        (this.current.stream && u.priority !== "urgent"))
    ) {
      // One slot: a newer lower-priority reply replaces an older one.
      this.queued = u;
      this.trace("VoiceReply", {
        phase: "queued",
        kind: u.kind,
        priority: u.priority,
      });
      return;
    }
    this.send(u);
  }

  private send(u: Utterance) {
    u.requestedAt = this.now();
    this.current = u;
    const skip = (code: string) => {
      this.trace("VoiceReply", {
        phase: "skipped",
        kind: u.kind,
        priority: u.priority,
        code,
      });
      // Replaced or interrupted meanwhile: nothing left to do for it.
      if (this.current !== u) return;
      this.current = undefined;
      if (code === "capturing") {
        // The user is talking; say it once listening ends if still relevant.
        if (u.key) this.said.delete(u.key);
      } else if (u.listen) this.fallbackListen(u);
      this.next();
      this.changed();
    };
    let request: Promise<{
      accepted: boolean;
      reason?: string;
      spoken?: string;
    }>;
    try {
      request = Promise.resolve(
        u.stream
          ? this.options.speech.speakStream({
              utteranceId: u.id,
              sentences: u.stream,
              priority: u.priority,
              style: styleFor(u.kind),
              onSentence: (text) => {
                u.text = u.text ? `${u.text} ${text}` : text;
              },
            })
          : this.options.speech.speak({
              utteranceId: u.id,
              text: u.text,
              priority: u.priority,
              style: styleFor(u.kind),
              ...(u.listen ? { listen: u.listen } : {}),
            }),
      );
    } catch {
      skip("error");
      return;
    }
    request.then(
      (result) => {
        const reply = u.reply;
        if (reply && u === reply.utterance) {
          reply.spokenText = result?.spoken ?? u.text;
          reply.resolveSpoken(reply.spokenText);
        }
        if (!result?.accepted) {
          skip(result?.reason ?? "rejected");
          if (reply && u === reply.utterance && !reply.cancelled)
            this.finishReply(reply);
        }
      },
      () => {
        skip("error");
        const reply = u.reply;
        if (reply && u === reply.utterance && !reply.cancelled)
          this.finishReply(reply);
      },
    );
  }

  private next() {
    if (this.current) return;
    const q = this.queued;
    this.queued = undefined;
    if (!q) return;
    if (
      q.priority === "ack" &&
      this.now() - q.requestedAt > QUEUED_ACK_MAX_AGE_MS
    )
      return;
    if (q.valid && !q.valid(this.snapshot)) return;
    this.send(q);
  }

  private stale(u: Utterance) {
    this.trace("VoiceReply", {
      phase: "stale",
      kind: u.kind,
      priority: u.priority,
    });
    if (this.current === u) this.current = undefined;
    void this.options.speech.stop().catch(() => {});
    this.next();
    this.changed();
  }

  private fallbackListen(u: Utterance) {
    if (u.listen && this.windowsAllowed(this.options.settings().handsFree))
      void this.listen(u.listen);
  }

  private askClarify() {
    const pending = this.clarifying;
    this.cancelClarify();
    if (!pending) return;
    this.markAsked();
    this.say(
      { text: pending.text },
      {
        priority: "urgent",
        listen: this.listenWindow("answer"),
        kind: "clarify",
      },
    );
  }

  private cancelClarify() {
    const pending = this.clarifying;
    this.clarifying = undefined;
    if (pending?.timer !== undefined) this.clearTimer(pending.timer);
  }

  private setFragment(value: Fragment | undefined) {
    this.fragmentValue = value;
    this.cancelledFragment = undefined;
  }

  private markAsked() {
    if (this.fragmentValue) this.fragmentValue.askedAt ??= this.now();
  }

  /** restorable: a key-down right after may still be answering it. */
  private endFragment(now: number, restorable: boolean) {
    const value = this.fragmentValue;
    this.fragmentValue = undefined;
    this.cancelledFragment =
      restorable && value ? { value, at: now } : undefined;
  }

  private restoreFragment(now: number) {
    const ended = this.cancelledFragment;
    this.cancelledFragment = undefined;
    if (ended && !this.fragmentValue && now - ended.at <= KEY_DOWN_CLOSE_MS)
      this.fragmentValue = ended.value;
  }

  private cancelSpeech() {
    try {
      this.options.speech.cancel();
    } catch {}
  }

  /**
   * Requests a window with nothing spoken before it. Resolves true only when
   * the helper opened it (now, or deferred until its echo guard ends).
   */
  private async listen(listen: Listen): Promise<boolean> {
    if (listen.kind === "approval") {
      // An approval window nobody heard asked for invites an ambient "yeah".
      this.trace("FollowUp", {
        phase: "skipped",
        window: listen.kind,
        code: "unspoken",
      });
      return false;
    }
    this.trace("FollowUp", { phase: "requested", window: listen.kind });
    try {
      const result = (await this.options.voiceCall("listen", {
        kind: listen.kind,
        seconds: listen.seconds,
      })) as { opened?: unknown; reason?: unknown } | undefined;
      if (result?.opened === true) return true;
      this.trace("FollowUp", {
        phase: "refused",
        window: listen.kind,
        code:
          typeof result?.reason === "string" &&
          /^[a-z][a-z0-9_]{0,39}$/.test(result.reason)
            ? result.reason
            : "refused",
      });
      return false;
    } catch {
      return false;
    }
  }

  private windowsAllowed(handsFree: boolean) {
    return handsFree && this.options.settings().followUpListening !== false;
  }

  /**
   * A window of `kind` as long as the "Keep listening" setting makes it. A
   * caller's own short length (the 5 s after a result) applies under the
   * default setting only; the longer settings take the table's value.
   */
  listenWindow(kind: FollowUpKind, short = followUpSeconds(kind)): Listen {
    const setting = this.options.settings().followUpWindow ?? "short";
    return {
      kind,
      seconds: setting === "short" ? short : followUpSeconds(kind, setting),
    };
  }

  /** The run a start plan just created, when its snapshot came first. */
  private unclaimedRun(now: number) {
    const current = this.snapshot?.run;
    const run = current ? this.runs.get(current.id) : undefined;
    return current &&
      run &&
      !TERMINAL.has(current.status) &&
      !this.claimed.has(current.id) &&
      now - run.firstSeen <= BIND_MS
      ? current.id
      : undefined;
  }

  private bind(runId: string, now: number) {
    if (this.runs.has(runId)) return;
    const start = this.pendingStart;
    let voice: boolean | undefined;
    if (start && now - start.at <= BIND_MS) {
      voice = start.voice;
      this.pendingStart = undefined;
      if (start.turn) {
        this.claimed.add(runId);
        if (this.turn?.plan === "start" && !this.turn.runId)
          this.turn.runId = runId;
      }
    }
    if (this.runs.size > 100) {
      const oldest = this.runs.keys().next().value;
      if (oldest !== undefined) {
        this.runs.delete(oldest);
        this.active.delete(oldest);
        this.claimed.delete(oldest);
      }
    }
    this.runs.set(runId, { voice, firstSeen: now });
  }

  private remember(key: string) {
    if (this.said.size > 500) this.said.clear();
    this.said.add(key);
  }

  private estimateMs(text: string) {
    const rate = this.options.settings().voiceRate ?? 1;
    return 300 + (text.length * 65) / (rate > 0 ? rate : 1);
  }

  private changed() {
    try {
      this.options.onChange?.();
    } catch {}
  }

  private trace(event: string, data: Record<string, unknown>) {
    try {
      this.options.trace?.(event, data);
    } catch {}
  }
}

/**
 * How the cloud voice reads each kind of line: the persona for replies and
 * results, plainly for anything the user must catch every word of.
 */
export function styleFor(kind: string): SpeechStyle {
  return [
    "approval",
    "question",
    "confirmAgain",
    "needClick",
    "failed",
    "didntCatch",
    "clarify",
    "goOn",
    "repeatReason",
    "needHelp",
    "approvalGeneric",
    "text",
  ].includes(kind)
    ? "clear"
    : "persona";
}

function defaultPriority(kind: string): SpeakPriority {
  if (kind.startsWith("ack")) return "ack";
  if (
    [
      "confirmAgain",
      "needClick",
      "didntCatch",
      "goOn",
      "failGeneric",
      "needHelp",
      "approvalGeneric",
      "text",
    ].includes(kind)
  )
    return "urgent";
  return "result";
}
