/**
 * Where the deterministic router and the dialog model meet. The router has
 * already handled every control word, approval answer and fragment; only a
 * free-form turn reaches the model, and only these rules decide what its
 * answer may do. The model never approves, declines or stops. A task it
 * rewrote runs only when every word of it can be traced to something the
 * user said or was told, and every entity in it (an address, a number, a
 * handle) to the user's own words; otherwise the rewrite becomes an offer
 * ("Want me to …?") the user accepts under the approval rules.
 */
import type { TaskSource } from "../core/schema";
import { scanText } from "../core/sanitize";
import { PHRASES, type PhraseKind } from "../voice/phrases";
import {
  askWhatToDo,
  cleanTaskText,
  consequentialVerb,
  deicticTask,
  dropsCurrentTask,
  intentKey,
  pointsElsewhere,
  startsNewTask,
  type TurnPlan,
  type VoiceTurnRun,
} from "../voice/turns";
import { jevStartWords } from "../providers/jev";
import type { DialogHead } from "./protocol";
import type { Channel } from "./types";

const TERMINAL = new Set(["completed", "cancelled", "failed"]);

/** The plans the model may reconsider. */
export type EligiblePlan = Extract<
  TurnPlan,
  { kind: "start" | "revise" | "replace" | "status" | "clarify" }
>;
/**
 * Plans the model may reconsider; everything else is settled by the router.
 * A question about words that named no task ("do that") is among them: the
 * model may still trace "that" to something the user said themselves.
 */
export function dialogEligible(plan: TurnPlan): plan is EligiblePlan {
  return (
    plan.kind === "start" ||
    plan.kind === "revise" ||
    plan.kind === "replace" ||
    plan.kind === "status" ||
    (plan.kind === "clarify" && plan.words !== undefined)
  );
}

const WH_WORDS = new Set(
  "what whats when whens where wheres who whos why whys how hows which".split(
    " ",
  ),
);
const AUXILIARIES = new Set(
  "is are am do does did can could would will should shall have has had was were wont cant".split(
    " ",
  ),
);
const POLITE = new Set(["can", "could", "would", "will"]);

/**
 * Words that begin a request the router can start without waiting for the
 * model: the run's own model reads the words. Deliberately not tell, read,
 * show or get, which are often questions in disguise.
 */
export const FAST_START_VERBS: ReadonlySet<string> = new Set(
  "open launch start switch jump go play search find send email text message call write create make draft reply set remind add book schedule order type put check look".split(
    " ",
  ),
);
const LEADING = new Set(
  "can could would will you please hey ok okay now also then and so just".split(
    " ",
  ),
);
/** Words that point back at the conversation; the model resolves them. */
const REFERS_BACK = new Set(["that", "it", "again", "same", "them", "those"]);

/** "what's next?", "is it done?", but not "can you open Spotify". */
export function looksLikeQuestion(text: string): boolean {
  if (/\?\s*$/.test(text.trim())) return true;
  const key = intentKey(text).split(" ").filter(Boolean);
  const [first, second, third] = key;
  if (!first) return false;
  if (WH_WORDS.has(first)) return true;
  if (!AUXILIARIES.has(first)) return false;
  return !(
    POLITE.has(first) &&
    second === "you" &&
    third !== undefined &&
    FAST_START_VERBS.has(third)
  );
}

/**
 * A plain imperative with nothing running starts right away with the user's
 * own words and no model call, the way it does today. Never words that
 * only point elsewhere, and never a verb that sends, signs or spends on a
 * target named elsewhere ("email the link to Dana", "open the link and sign
 * in"): the model reads those with the notification in view.
 */
export function fastStart(plan: TurnPlan, text: string): boolean {
  if (plan.kind !== "start" || looksLikeQuestion(text) || deicticTask(text))
    return false;
  if (consequentialVerb(text) && pointsElsewhere(text)) return false;
  const key = intentKey(text).split(" ").filter(Boolean);
  const verb = key.find((word) => !LEADING.has(word));
  return (
    !!verb &&
    FAST_START_VERBS.has(verb) &&
    !key.some((word) => REFERS_BACK.has(word))
  );
}

/**
 * Verbs that ask for an answer in words. "tell me whether the invoice was
 * paid" reads as an imperative (looksLikeQuestion is about the first word)
 * but wants a report, and live Jev calls it a confident start. Only the
 * Jev candidate guard needs these: fastStart never allowed them as verbs.
 */
const REPORT_VERBS = new Set(["tell", "say", "know", "let", "report"]);
const REPORT_CLAUSE = new Set(["whether", "if"]);

/**
 * "tell me whether …", "let me know if …", "say what …", "tell me how …":
 * a report verb first (after the polite lead-in) with "whether", "if" or a
 * WH word anywhere after it. "tell dana the meeting moved" names a task
 * and is not a report frame.
 */
function reportFrame(words: string[]): boolean {
  const at = words.findIndex((word) => !LEADING.has(word));
  if (at < 0 || !REPORT_VERBS.has(words[at])) return false;
  return words
    .slice(at + 1)
    .some((word) => REPORT_CLAUSE.has(word) || WH_WORDS.has(word));
}

/**
 * Whether a plain start may run on an early decider's say-so (the opt-in
 * Jev path in electron/assistant.ts): every guard a fast start passes
 * except the verb allow-list, so no question (nor a report frame that asks
 * one in an imperative's clothes), no word that points back at the
 * conversation, and words that name what to do on their own
 * (jevStartWords: no deictic word, at least three content words, under the
 * length cap). Anything that fails here waits for the text model, as today.
 */
export function jevStartCandidate(plan: TurnPlan, text: string): boolean {
  // Words that only point at something else are the router's question, never
  // an early start, whatever the plan says.
  if (plan.kind !== "start" || looksLikeQuestion(text) || deicticTask(text))
    return false;
  const key = intentKey(text);
  const words = key.split(" ").filter(Boolean);
  if (!words.length || words.some((word) => REFERS_BACK.has(word)))
    return false;
  if (reportFrame(words)) return false;
  return jevStartWords(key, text.trim());
}

const OPENERS = /^(?:open|launch|start)$/;
const SWITCHERS = /^(?:switch|jump|go)$/;
const TARGET_STOP = /^(?:and|then|,|;|so|please|for|with)$/;
const TARGET_LEAD = new Set(["to", "the", "up", "my", "a", "an", "in", "on"]);

/**
 * The filler a turn plays while the model is slow: none for a fast start
 * (its own line follows at once), a "let me check" for a question or for
 * words that named no task (a question may be all that comes of them), and
 * an acknowledgement for a request or a correction.
 */
export function turnFiller(
  base: TurnPlan,
  text: string,
): PhraseKind | undefined {
  if (fastStart(base, text)) return undefined;
  if (looksLikeQuestion(text) || base.kind === "clarify") return "thinking";
  return base.kind === "start" ? "ackStart" : "ackCorrection";
}

/**
 * The fixed line spoken the instant a fast start is dispatched: "Opening
 * Spotify." for an app, "Switching to Notes." for a switch, or nothing (the
 * canned acknowledgement plays instead) when the target is not a name.
 */
export function fastStartLine(text: string): string | undefined {
  const words = cleanTaskText(text)
    .replace(/[.!?]+$/, "")
    .split(/\s+/)
    .filter(Boolean);
  let at = 0;
  while (at < words.length && LEADING.has(words[at].toLowerCase())) at++;
  const verb = words[at]?.toLowerCase();
  if (!verb) return undefined;
  let target: string[] = [];
  const collect = (from: number) => {
    const out: string[] = [];
    let i = from;
    while (i < words.length && TARGET_LEAD.has(words[i].toLowerCase())) i++;
    for (; i < words.length; i++) {
      const word = words[i].replace(/[,;]+$/, "");
      if (TARGET_STOP.test(word.toLowerCase())) break;
      out.push(word);
      if (/[,;]$/.test(words[i])) break;
    }
    return out;
  };
  let lead = "Opening";
  if (OPENERS.test(verb)) target = collect(at + 1);
  else if (SWITCHERS.test(verb)) {
    lead = "Switching to";
    target = collect(at + 1);
  } else if (verb === "play") {
    // "play jazz on Spotify": the app is what follows "on" or "in".
    const on = words.findIndex((w, i) => i > at && /^(?:on|in)$/i.test(w));
    if (on === -1) return undefined;
    target = collect(on + 1);
  } else return undefined;
  if (!target.length || target.length > 4) return undefined;
  const name = target.join(" ");
  if (name.length > 40) return undefined;
  return `${lead} ${name[0].toUpperCase()}${name.slice(1)}.`;
}

// Grounding ----------------------------------------------------------------

const GLUE = new Set(
  (
    "the a an and or but to for of in on at by with from into about over under after before as is are was were be been " +
    "am do does did can could would should will shall may might must have has had i me my you your it its this that " +
    "these those there here what which who whom whose when where why how not no yes so if then than too very just " +
    "also please thanks thank okay ok now some any all each every up down out off one ones up want wants wanted " +
    "need needs like lets let us we our they them their he she his her him"
  ).split(" "),
);
/**
 * Words a rewrite may add without having heard them: looking, opening and
 * time, never a verb that sends, spends, runs, removes or writes. The model
 * turning "read me the draft" into "send the draft" must fail this check.
 */
const GENERIC = new Set(
  (
    "open play show find search look check go switch use again instead other app window tab page " +
    "launch see read get tell new current latest recent next last " +
    "first same thing things something anything everything more less back forward ahead done finish " +
    "today tomorrow tonight morning afternoon evening week weekend month year time date day hour minute"
  ).split(" "),
);
/**
 * Words that unlock a policy allowance (Command-V is allowed only when the
 * user's words asked for a paste): they count only from the user's own
 * words, never from a rewrite, however well grounded the rest of it is.
 */
const USER_ONLY = /\b(?:paste|pastes|pasted|pasting|clipboard)\b/i;
const stem = (word: string) =>
  word.length > 4
    ? word.replace(/(?:ing|ed|es|s)$/, "")
    : word.length > 3
      ? word.replace(/s$/, "")
      : word;
function contentTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/['’]/g, "")
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 3 && !GLUE.has(w))
      .map(stem),
  );
}
/**
 * Addresses, links, numbers, handles and amounts: never invented. A host is
 * any dotted name with a letters-only last label, whatever its TLD (the same
 * shape speakable.ts reads out): a false match only turns a run into an
 * offer, which is the safe direction.
 */
const ENTITY =
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+|https?:\/\/\S+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b\S*|(?<![\w@])@[a-z0-9_.]{2,}|[$€£¥]\s?\d[\d,.]*|\b\d[\d,.]*\s?(?:dollars|euros|pounds|usd|eur|gbp|bucks)\b|\b\d[\d\s().-]{6,}\d\b|\b\d{3,}\b/gi;
export function entityTokens(text: string): string[] {
  return [...text.matchAll(ENTITY)].map((m) => normalizeEntity(m[0]));
}
/** Phone numbers compare by their digits; everything else as written. */
const normalizeEntity = (value: string) => {
  const bare = value
    .toLowerCase()
    .trim()
    .replace(/[.,;:!?)]+$/, "");
  return /^[\d\s().+-]+$/.test(bare) ? bare.replace(/\D/g, "") : bare;
};

export type GroundCheck =
  | { ok: true }
  | {
      ok: false;
      code:
        | "entity"
        | "vocabulary"
        | "referent"
        | "too_long"
        | "secret"
        | "clipboard";
    };

/**
 * Whether a model rewrite says only what the conversation supports. Every
 * content word must appear in the utterance, the recent turns, the run's
 * task or a short generic list; every entity must appear in text the user
 * wrote or said themselves, never in something the assistant repeated from
 * a notification or a screen; a paste must be the user's own request.
 *
 * `deictic`: the utterance only pointed at something ("do it again",
 * deicticTask), so the rewrite is what the model resolved the pointer to.
 * Then every content word, generic or not, must be the user's own, and at
 * least one must come from a task they gave before this utterance: the
 * thing pointed at. Earlier words that only pointed themselves ("call the
 * number in the note", asked about) gave no task and lend none. A rewrite
 * that still points ("send it to them in Safari", "call the note number")
 * resolved the pointer to nothing the user said, and fails as "referent".
 */
export function groundedTask(
  rewrite: string,
  utterance: string,
  o: { context?: string[]; userWords?: string[]; deictic?: boolean } = {},
): GroundCheck {
  const task = rewrite.trim();
  if (!task || task.length > 500) return { ok: false, code: "too_long" };
  if (scanText(task).some((f) => f.action === "BLOCK_UPLOAD"))
    return { ok: false, code: "secret" };
  const own = [utterance, ...(o.userWords ?? [])].join(" ");
  if (USER_ONLY.test(task) && !USER_ONLY.test(own))
    return { ok: false, code: "clipboard" };
  const ownEntities = new Set(entityTokens(own));
  for (const entity of entityTokens(task))
    if (!ownEntities.has(entity)) return { ok: false, code: "entity" };
  // A pointer resolved to words that still point ("send it to them in
  // Safari") was resolved to nothing.
  if (o.deictic && pointsElsewhere(task, false))
    return { ok: false, code: "referent" };
  const allowed = contentTokens(
    [own, ...(o.deictic ? [] : (o.context ?? []))].join(" "),
  );
  const tokens = contentTokens(task);
  for (const token of tokens)
    if (
      !allowed.has(token) &&
      (o.deictic || (!GENERIC.has(token) && !/^\d+$/.test(token)))
    )
      return { ok: false, code: "vocabulary" };
  if (o.deictic) {
    // The caller's user words may include the utterance itself (the session
    // notes a turn before deciding it): only the turns before it count, and
    // only those that named a task of their own.
    const key = intentKey(utterance);
    const before = contentTokens(
      (o.userWords ?? [])
        .filter((w) => intentKey(w) !== key && !deicticTask(w))
        .join(" "),
    );
    const now = contentTokens(utterance);
    if (![...tokens].some((t) => before.has(t) && !now.has(t)))
      return { ok: false, code: "referent" };
  }
  return { ok: true };
}

// Arbitration --------------------------------------------------------------

export interface Arbitrated {
  plan: TurnPlan;
  /** Whether the model's SAY may be spoken; false means the canned line. */
  speakSay: boolean;
  /** For a start or queue plan: whose words the task is. */
  taskSource?: TaskSource;
  /** The model's rewrite, offered instead of run: "Want me to …?". */
  proposal?: string;
  /** The rewrite is neither run nor offered: it would paste on the model's say-so. */
  refused?: "clipboard";
  code: string;
}
export interface ArbitrateInput {
  base: TurnPlan;
  head?: DialogHead;
  utterance: string;
  run?: VoiceTurnRun;
  /** Recent turns and tasks: content a rewrite may draw words from. */
  context?: string[];
  /** Text the user wrote or said: the only source of entities. */
  userWords?: string[];
  /**
   * The caller's provenance for the user's own words: "user_words_unsure"
   * for speech heard below the approval confidence. A rewrite that repeats
   * those words inherits it; the model never makes them surer.
   */
  heard?: TaskSource;
  channel: Channel;
  /** main.ts voiceHoldResumable(): the only hold a model resume may end. */
  heldByVoice: boolean;
}

const reply = (
  act: "answer" | "status" | "none",
  o: { resume?: boolean; repeatApproval?: boolean } = {},
): TurnPlan => ({
  kind: "reply",
  act,
  resume: o.resume ?? true,
  ...(o.repeatApproval ? { repeatApproval: true } : {}),
});

export function arbitrate(i: ArbitrateInput): Arbitrated {
  const { base, head, utterance } = i;
  const run = i.run && !TERMINAL.has(i.run.status) ? i.run : undefined;
  const confirming = !!run && run.status === "confirming";
  const settle = (plan: TurnPlan, code: string): Arbitrated => ({
    plan,
    speakSay: false,
    code,
  });
  if (!head) return settle(base, "no_head");
  if (!dialogEligible(base)) return settle(base, "ineligible");
  const baseSource: TaskSource | undefined =
    base.kind === "start" ? base.taskSource : undefined;
  /** The user's own cleaned words, as the router would have run them. */
  const words =
    base.kind === "status"
      ? utterance
      : base.kind === "clarify"
        ? (base.words ?? utterance)
        : base.text;
  switch (head.act) {
    case "none":
    case "answer":
      return { plan: reply(head.act), speakSay: true, code: head.act };
    case "status":
      if (confirming)
        return settle(reply("status", { repeatApproval: true }), "status");
      if (run) return { plan: reply("status"), speakSay: true, code: "status" };
      return { plan: reply("answer"), speakSay: true, code: "status" };
    case "resume":
      if (!run) return settle({ kind: "nothingRunning" }, "resume");
      if (confirming || !run.held)
        return settle({ kind: "stillWorking" }, "resume");
      // Only the hold this activation caused; the user's own pause, a
      // takeover or a helper restart never end on the model's say-so.
      if (!i.heldByVoice) return settle(base, "resume_refused");
      return { plan: { kind: "resume" }, speakSay: true, code: "resume" };
    case "pause":
      if (!run || confirming)
        return settle({ kind: "nothingRunning" }, "pause");
      return { plan: { kind: "pause" }, speakSay: true, code: "pause" };
    case "start":
    case "revise":
    case "replace":
    case "queue":
      break;
  }
  // A status question stays a status question: the model choosing a task
  // act for it is a misroute, and the fixed status line answers instead.
  if (base.kind === "status") return settle(base, "task_refused");
  // A task act. The rewrite runs only when it is grounded.
  const rewrite = head.task?.trim() ?? "";
  // Words that only point elsewhere ("sure go for it", "call the number in
  // the note") name no task, so a TASK that repeats them, or points
  // elsewhere itself, neither runs nor is offered: the run would resolve
  // "that" from the screen or a notification in the user's name. The
  // router's question stands, or its correction to the run under way.
  const vague = deicticTask(words);
  const unclear = (code: string): Arbitrated =>
    settle(
      base.kind === "revise" || base.kind === "clarify"
        ? base
        : askWhatToDo(words),
      code,
    );
  // The screen allowance is the user's, never the model's: a rewrite in
  // their own words keeps it, but one that points at a thing on the screen
  // in the model's words ("Send it" for "send Dana the report", "Install
  // the update" for "yeah do that") is as vague as agreement.
  const own = !!rewrite && intentKey(rewrite) === intentKey(words);
  if (rewrite && deicticTask(rewrite, own))
    return vague ? unclear("vague") : settle(base, "rewrite_vague");
  if (vague && !rewrite) return unclear("vague");
  // The pointer resolved to words that still point ("send it to them in
  // Safari", "do what Dana asked in Safari"): not even offered, since
  // accepted it would resolve them from the screen all the same. A thing
  // with its value ("wire $900 to account 55440011") is offered out loud.
  if (vague && pointsElsewhere(rewrite, false))
    return unclear("rewrite_points");
  const grounded = rewrite
    ? groundedTask(
        rewrite,
        utterance,
        // Vague words lend a rewrite no authority of their own: what it
        // resolved "that" to runs only when every word of it is the user's
        // own and some of it is what they said before ("open Safari" … "do
        // it again"), never because the assistant said it (a notification it
        // read out, a page, its own offer), never on a generic word the model
        // added ("open the latest tab" from a note) and never on the vague
        // words alone reshuffled. Otherwise it is offered.
        vague
          ? { userWords: i.userWords, deictic: true }
          : { context: i.context, userWords: i.userWords },
      )
    : ({ ok: false, code: "too_long" } as const);
  const source: TaskSource = own
    ? (baseSource ?? i.heard ?? "user_words")
    : "model_rewrite";
  const task = grounded.ok ? rewrite : undefined;
  const propose = (): Arbitrated =>
    !grounded.ok && grounded.code === "clipboard"
      ? {
          plan: reply("none"),
          speakSay: false,
          refused: "clipboard",
          code: "proposal_clipboard",
        }
      : {
          plan: reply("none"),
          speakSay: false,
          proposal: rewrite,
          code: `proposal_${grounded.ok ? "ok" : grounded.code}`,
        };
  if (!run) {
    // Nothing running: every task act starts, or offers, the task.
    if (task)
      return {
        plan: { kind: "start", text: task, taskSource: source },
        speakSay: true,
        taskSource: source,
        code: "start",
      };
    return propose();
  }
  if (head.act === "revise") {
    // Vague words the router asked about are not a correction either.
    if (!task && base.kind === "clarify") return unclear("vague");
    return {
      // An ungrounded correction falls back to the user's own words: a
      // correction is a hint to the run in the user's name.
      plan: { kind: "revise", text: task ?? words },
      speakSay: true,
      code: task ? "revise" : "revise_words",
    };
  }
  if (head.act === "queue") {
    if (task)
      return {
        plan: { kind: "queue", text: task, taskSource: source },
        speakSay: true,
        taskSource: source,
        code: "queue",
      };
    return propose();
  }
  // start or replace with a run under way: a healthy run is never replaced.
  const moveOn = run.stalled === true || startsNewTask(utterance, run.task);
  // Nor do vague words the router asked about become a correction.
  if (!moveOn && base.kind === "clarify") return unclear("vague");
  if (!moveOn)
    return {
      plan: { kind: "revise", text: words },
      speakSay: true,
      code: "replace_refused",
    };
  if (task) {
    // A run the user paused or took over is theirs to end: the model reading
    // them as moving on never stops it silently. Unless their own words let
    // go of it ("forget that, instead …", "read the note instead"), they
    // are asked first; a hint to the run ("use the search instead") is no
    // such thing. The hold this very activation caused is not such a pause,
    // and the router's own replace (a new request in the user's words to a
    // stuck run) is theirs.
    if (
      run.held &&
      !i.heldByVoice &&
      base.kind !== "replace" &&
      !dropsCurrentTask(utterance, run.task)
    )
      return settle(
        {
          kind: "clarify",
          question: PHRASES.pausedFirst[0],
          fragment: "",
        },
        "replace_held",
      );
    return {
      plan: { kind: "replace", text: task },
      speakSay: true,
      taskSource: source,
      code: "replace",
    };
  }
  return propose();
}
