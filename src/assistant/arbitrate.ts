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
import {
  cleanTaskText,
  intentKey,
  startsNewTask,
  type TurnPlan,
  type VoiceTurnRun,
} from "../voice/turns";
import type { DialogHead } from "./protocol";
import type { Channel } from "./types";

const TERMINAL = new Set(["completed", "cancelled", "failed"]);

/** The plans the model may reconsider. */
export type EligiblePlan = Extract<
  TurnPlan,
  { kind: "start" | "revise" | "replace" | "status" }
>;
/** Plans the model may reconsider; everything else is settled by the router. */
export function dialogEligible(plan: TurnPlan): plan is EligiblePlan {
  return (
    plan.kind === "start" ||
    plan.kind === "revise" ||
    plan.kind === "replace" ||
    plan.kind === "status"
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
 * own words and no model call, the way it does today.
 */
export function fastStart(plan: TurnPlan, text: string): boolean {
  if (plan.kind !== "start" || looksLikeQuestion(text)) return false;
  const key = intentKey(text).split(" ").filter(Boolean);
  const verb = key.find((word) => !LEADING.has(word));
  return (
    !!verb &&
    FAST_START_VERBS.has(verb) &&
    !key.some((word) => REFERS_BACK.has(word))
  );
}

const OPENERS = /^(?:open|launch|start)$/;
const SWITCHERS = /^(?:switch|jump|go)$/;
const TARGET_STOP = /^(?:and|then|,|;|so|please|for|with)$/;
const TARGET_LEAD = new Set(["to", "the", "up", "my", "a", "an", "in", "on"]);

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
      code: "entity" | "vocabulary" | "too_long" | "secret" | "clipboard";
    };

/**
 * Whether a model rewrite says only what the conversation supports. Every
 * content word must appear in the utterance, the recent turns, the run's
 * task or a short generic list; every entity must appear in text the user
 * wrote or said themselves, never in something the assistant repeated from
 * a notification or a screen; a paste must be the user's own request.
 */
export function groundedTask(
  rewrite: string,
  utterance: string,
  o: { context?: string[]; userWords?: string[] } = {},
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
  const allowed = contentTokens([own, ...(o.context ?? [])].join(" "));
  for (const token of contentTokens(task))
    if (!allowed.has(token) && !GENERIC.has(token) && !/^\d+$/.test(token))
      return { ok: false, code: "vocabulary" };
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
  const words = base.kind === "status" ? utterance : base.text;
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
  const grounded = rewrite
    ? groundedTask(rewrite, utterance, {
        context: i.context,
        userWords: i.userWords,
      })
    : ({ ok: false, code: "too_long" } as const);
  const own = !!rewrite && intentKey(rewrite) === intentKey(words);
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
  if (head.act === "revise")
    return {
      // An ungrounded correction falls back to the user's own words: a
      // correction is a hint to the run in the user's name.
      plan: { kind: "revise", text: task ?? words },
      speakSay: true,
      code: task ? "revise" : "revise_words",
    };
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
  if (!moveOn)
    return {
      plan: { kind: "revise", text: words },
      speakSay: true,
      code: "replace_refused",
    };
  if (task)
    return {
      plan: { kind: "replace", text: task },
      speakSay: true,
      taskSource: source,
      code: "replace",
    };
  return propose();
}
