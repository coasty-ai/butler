/**
 * Acting while the user is still talking (increment 1). The one step a spoken
 * turn may take before its final transcript is opening the app its leading
 * clause names: "open Slack and message Dana" brings Slack forward before the
 * user has finished the sentence. This module is the pure part: which leading
 * clause qualifies, when the partial transcripts have settled on it, and
 * whether the final words keep it. electron/early-start.ts runs the step
 * through the same native verification and policy as a run step.
 *
 * Grammar, after restartedTurn() and with fillers ("um", "uh") skipped:
 *
 *   lead*  verb  name  after
 *   lead  := ok okay so hey now just please also then and | can/could/would/will you
 *   verb  := open | open up | launch | pull up | bring up | switch to | switch over to
 *   name  := one to four plain words, or "the … app" ("the" and "app" dropped);
 *            a trailing "app"/"application" is dropped when a word remains
 *   after := boundary (and then also plus so , ;) | veto | end | more
 *
 * Pointers and descriptions ("open the message from Dana", "open my email",
 * "open it"), "go to", "start", typing, sending and every second clause are
 * outside the grammar, so they never run early.
 */
import { scanText } from "../core/sanitize";
import {
  WAKE_HEY,
  WAKE_NAME,
  isWakePhraseOnly,
  restartedTurn,
  voiceIntent,
} from "./turns";

export type EarlyVerb = "open" | "switch";
export interface EarlyClause {
  verb: EarlyVerb;
  /** The app name as heard: original casing, at most four words. */
  name: string;
  /** Lowercased name words; partials and the final compare verb and key. */
  key: string;
  /** What follows the name. Only "boundary" and "end" can ever settle. */
  next: "boundary" | "end" | "veto" | "more";
}
export const EARLY_LIMITS = {
  /** A boundary heard in one partial settles after this long unchanged. */
  confirmMs: 300,
  /** A clause that ends at the name settles after this long unchanged (about p75 of partial gaps). */
  pauseMs: 600,
  maxNameWords: 4,
  /** An older early screenshot is taken again before the step (native refuses at 30 s). */
  frameMaxAgeMs: 20_000,
} as const;

const wordSet = (list: string) => new Set(list.split(/\s+/).filter(Boolean));
const FILLERS = wordSet("um uh uhm umm er erm hmm hm mm");
const LEADS = wordSet("ok okay so hey now just please also then and");
const POLITE = wordSet("can could would will");
const BOUNDARY = wordSet("and then also plus so");
/**
 * A change of mind, a place or a website: "open Slack— no, Discord", "open
 * Slack in Chrome", "open Slack's settings". The turn gets no early step.
 */
const VETO = wordSet(`or no not nope actually wait sorry instead rather i
  in on at to from with for into via using website site page tab window dot com`);
/** Words that are never part of an app name heard early. */
const NOT_NAME = new Set([
  ...wordSet(`it that this these those them her him me my your our their his its
    a an the some any every new next last first another other same one
    stop cancel pause wait please now`),
  ...BOUNDARY,
  ...VETO,
]);
/**
 * Words that name something on nearly every Mac ("open settings and turn off
 * notifications" would open System Settings from the word "settings" alone).
 * They open early only when they are the app's exact display name.
 */
export const EARLY_GENERIC_NAMES = wordSet(
  "settings preferences system control panel finder files mail music photos home",
);
/** Said after the name without changing what it names: "open Slack please". */
const TRANSPARENT = wordSet("please now");
const APP_WORDS = wordSet("app application");
/** The activation phrase at the start, as native strips it (WakePolicy.swift). */
const LEADING_WAKE = new RegExp(
  String.raw`^\s*${WAKE_HEY}[\s,]+${WAKE_NAME}(?![a-z])[\s,.:;!?—-]*`,
  "iu",
);

interface Token {
  raw: string;
  /** Lowercase, apostrophes removed; empty for punctuation. */
  word: string;
  punct?: "," | ";" | "." | "!" | "?" | "—";
}
// Words keep inner apostrophes, dots and hyphens ("Slack's", "slack.com",
// "Wi-Fi"); a comma, semicolon, sentence mark or dash is its own token.
const TOKEN = /[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*|[,;.!?—–-]/gu;

function tokens(text: string): Token[] {
  const out: Token[] = [];
  for (const [raw] of text.replace(LEADING_WAKE, "").matchAll(TOKEN)) {
    if (/^[\p{L}\p{N}]/u.test(raw)) {
      const word = raw.toLowerCase().replace(/['’]/g, "");
      if (!FILLERS.has(word)) out.push({ raw, word });
    } else
      out.push({
        raw,
        word: "",
        punct: /^[—–-]$/.test(raw) ? "—" : (raw as Token["punct"]),
      });
  }
  return out;
}
const possessive = (t: Token) => /['’]s$/i.test(t.raw);
const dotted = (t: Token) => t.raw.includes(".");

/**
 * "and no", "and stop", ", never mind", "and actually": the boundary is
 * followed by a change of mind, so the clause is vetoed rather than settled.
 */
const CORRECTION = wordSet(
  "no not nope never stop cancel forget wait actually instead rather sorry",
);
function correctionFollows(t: Token[], from: number): boolean {
  for (let k = from, seen = 0; k < t.length && seen < 2; k++) {
    const w = t[k];
    if (w.punct) continue;
    if (FILLERS.has(w.word)) continue;
    if (CORRECTION.has(w.word)) return true;
    seen++;
  }
  return false;
}
/** What the words after the name make of the clause. */
function following(t: Token[], from: number): EarlyClause["next"] {
  let dash = false;
  for (let k = from; k < t.length; k++) {
    const w = t[k];
    if (w.punct === "—") {
      dash = true;
      continue;
    }
    if (w.punct === "," || w.punct === ";")
      return correctionFollows(t, k + 1) ? "veto" : "boundary";
    if (w.punct === "?") return "veto";
    // A full stop ends the clause; words after it start the next sentence.
    if (w.punct)
      return t.slice(k + 1).some((x) => !x.punct)
        ? correctionFollows(t, k + 1)
          ? "veto"
          : "boundary"
        : "end";
    if (TRANSPARENT.has(w.word)) continue;
    if (possessive(w) || dotted(w)) return "veto";
    if (BOUNDARY.has(w.word))
      return correctionFollows(t, k + 1) ? "veto" : "boundary";
    if (VETO.has(w.word)) return "veto";
    return "more";
  }
  // A dash with nothing after it is a sentence still being corrected.
  return dash ? "more" : "end";
}

function parse(text: string): { lead: boolean; clause?: EarlyClause } {
  const t = tokens(text);
  const at = (k: number) => t[k]?.word;
  let i = 0;
  let hey = false;
  for (;;) {
    const w = t[i];
    if (!w || w.punct === "?") break;
    if (w.punct || LEADS.has(w.word)) {
      hey = w.word === "hey";
      i++;
    } else if (POLITE.has(w.word) && at(i + 1) === "you") i += 2;
    else break;
  }
  // "Hey Butl…" is the wake phrase still arriving: not a request yet. ("Hey,
  // open Notes" after an activation is one, and primes as usual.)
  if (
    hey &&
    at(i) !== undefined &&
    "butler".startsWith(at(i)!) &&
    at(i + 1) === undefined
  )
    return { lead: false };
  let verb: EarlyVerb | undefined;
  if (at(i) === "open") {
    verb = "open";
    i += at(i + 1) === "up" ? 2 : 1;
  } else if (at(i) === "launch") {
    verb = "open";
    i += 1;
  } else if ((at(i) === "pull" || at(i) === "bring") && at(i + 1) === "up") {
    verb = "open";
    i += 2;
  } else if (at(i) === "switch" && at(i + 1) === "to") {
    verb = "switch";
    i += 2;
  } else if (at(i) === "switch" && at(i + 1) === "over" && at(i + 2) === "to") {
    verb = "switch";
    i += 3;
  }
  if (!verb) return { lead: false };
  while (t[i]?.punct === "," || t[i]?.punct === "—") i++;
  const the = at(i) === "the";
  if (the) i++;
  const name: Token[] = [];
  let j = i;
  for (; j < t.length && !t[j].punct; j++) {
    const w = t[j];
    if (NOT_NAME.has(w.word) || possessive(w) || dotted(w)) break;
    name.push(w);
  }
  let next: EarlyClause["next"];
  const stop = t[j];
  const stem = stop && possessive(stop) ? stop.raw.slice(0, -2) : "";
  if (
    stop &&
    !stop.punct &&
    (dotted(stop) || (stem && !NOT_NAME.has(stem.toLowerCase())))
  ) {
    // "Slack's settings", "slack.com": part of the name, and never an app.
    name.push(stem ? { raw: stem, word: stem.toLowerCase() } : stop);
    next = "veto";
  } else next = following(t, j);
  if (!name.length) return { lead: true };
  if (the) {
    // "the Notes app" names an app; "the Notes" or "the message" does not.
    if (name.length < 2 || !APP_WORDS.has(name[name.length - 1].word))
      return { lead: true };
    name.pop();
  } else if (name.length > 1 && APP_WORDS.has(name[name.length - 1].word))
    name.pop();
  if (name.length > EARLY_LIMITS.maxNameWords) return { lead: true };
  return {
    lead: true,
    clause: {
      verb,
      name: name.map((w) => w.raw).join(" "),
      key: name.map((w) => w.word).join(" "),
      next,
    },
  };
}

/** The words begin with an early verb, name or no name yet ("Open…", "switch to…"). */
export function earlyLead(text: string): boolean {
  return parse(text).lead;
}
/** The leading clause a step may run for, if the words have one. */
export function leadingClause(text: string): EarlyClause | undefined {
  return parse(text).clause;
}
/**
 * Whether the final transcript still opens with the clause the step ran for
 * (same verb and name, no change of mind after it), and whether that clause
 * is the whole request ("Open Slack."), which the run then completes at once.
 */
export function finalKeeps(
  clause: EarlyClause,
  finalText: string,
): { keeps: boolean; exact: boolean } {
  const heard = leadingClause(restartedTurn(finalText.trim()).text);
  const keeps =
    !!heard &&
    heard.verb === clause.verb &&
    heard.key === clause.key &&
    heard.next !== "veto";
  return { keeps, exact: keeps && heard!.next === "end" };
}

export interface Settle {
  clause: EarlyClause;
  /**
   * "boundary": a boundary followed the name; "pause": the words stopped at
   * it; "eager": the name alone is an installed app's exact name, so the app
   * opens while the user is still speaking, before the "and".
   */
  by: "boundary" | "pause" | "eager";
  /** When the settled clause first appeared. */
  firstAt: number;
  at: number;
}
export type TrackerEvent =
  /** The first partial with an early verb: the read-only screenshot may start. */
  | { kind: "prime" }
  | { kind: "settled"; settle: Settle }
  /** The turn gets no early step. */
  | { kind: "closed"; code: "veto" | "control" | "secret" }
  /** Call tick() at this time: the confirm or pause window may have passed. */
  | { kind: "timer"; at: number };

/**
 * Follows one turn's partial transcripts. A clause settles once: at once when
 * the name alone is an installed app's exact name (knownApp, so "open Slack
 * and…" opens Slack before the "and"), when a boundary follows the name and
 * two partials agreed on it (or one stayed unchanged for confirmMs), or when
 * the words end at the name and stay unchanged for pauseMs. A veto, a stop or
 * pause, or a credential closes the turn. It keeps reading partials after it
 * settles, because the step may not have run yet: a change of mind heard in
 * that gap still closes the turn. Only the final transcript decides whether
 * a step that did run is kept.
 */
export class ClauseTracker {
  private primed = false;
  private done = false;
  private settled?: string;
  constructor(private readonly knownApp?: (key: string) => boolean) {}
  private candidate?: {
    clause: EarlyClause;
    key: string;
    count: number;
    firstAt: number;
    lastAt: number;
  };
  push(partial: string, at: number): TrackerEvent[] {
    if (this.done) return [];
    // A wake phrase said again starts the request over, as for the final.
    const text = restartedTurn(partial).text;
    if (!text.trim() || isWakePhraseOnly(text)) return [];
    const intent = voiceIntent(text).kind;
    if (intent === "stop" || intent === "pause") return this.close("control");
    if (scanText(text).some((f) => f.action === "BLOCK_UPLOAD"))
      return this.close("secret");
    const parsed = parse(text);
    const clause = parsed.clause;
    if (clause?.next === "veto") return this.close("veto");
    // Settled, but the step may still be on its way: a change of mind now
    // still closes the turn (electron/early-start.ts stops a step that has
    // not reached the point of no return).
    if (this.settled !== undefined) {
      const key = clause && `${clause.verb} ${clause.key}`;
      return clause && key !== this.settled ? this.close("veto") : [];
    }
    const events: TrackerEvent[] = [];
    if (parsed.lead && !this.primed) {
      this.primed = true;
      events.push({ kind: "prime" });
    }
    if (!clause) {
      this.candidate = undefined;
      return events;
    }
    const key = `${clause.verb} ${clause.key}`;
    if (this.candidate?.key !== key)
      this.candidate = { clause, key, count: 0, firstAt: at, lastAt: at };
    const c = this.candidate;
    c.count++;
    c.clause = clause;
    c.lastAt = at;
    if (clause.next === "boundary") {
      if (c.count >= 2) return [...events, this.settle("boundary", at)];
      events.push({ kind: "timer", at: at + EARLY_LIMITS.confirmMs });
    } else if (clause.next === "end") {
      // The name alone already names an installed app: open it now, which is
      // what "open Slack and …" asks for, rather than waiting for the "and".
      if (this.knownApp?.(clause.key))
        return [...events, this.settle("eager", at)];
      events.push({ kind: "timer", at: at + EARLY_LIMITS.pauseMs });
    }
    return events;
  }
  tick(at: number): TrackerEvent[] {
    const c = this.candidate;
    if (this.done || this.settled !== undefined || !c) return [];
    if (c.clause.next === "boundary" && at - c.lastAt >= EARLY_LIMITS.confirmMs)
      return [this.settle("boundary", at)];
    if (c.clause.next === "end" && at - c.lastAt >= EARLY_LIMITS.pauseMs)
      return [this.settle("pause", at)];
    return [];
  }
  private settle(by: Settle["by"], at: number): TrackerEvent {
    const c = this.candidate!;
    this.settled = c.key;
    return {
      kind: "settled",
      settle: { clause: c.clause, by, firstAt: c.firstAt, at },
    };
  }
  private close(code: "veto" | "control" | "secret"): TrackerEvent[] {
    this.done = true;
    this.candidate = undefined;
    return [{ kind: "closed", code }];
  }
}
