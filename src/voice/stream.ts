/**
 * The clause stream (streaming execution, .data/design/streaming-execution.md
 * §3.1): the growing partial transcript of one spoken turn, cut into clauses
 * as it arrives, so that "go to youtube and play a midwest safety video" is
 * two clauses the fast decider (./fast.ts) can act on while the user is still
 * speaking. Pure: no clock of its own, no timers, no I/O. The caller pushes
 * every partial with the time it was heard; to let a clause commit by
 * stability while the recognizer is silent it pushes the last partial again
 * (same text, later time), since the stream keeps no timer.
 *
 * Rules, as the design has them:
 *
 * - A clause is split at a connector and at a second imperative verb.
 *   `then`, `and then`, `after that`, `also`, `,`, `;` and `.` split by
 *   themselves. `and`, `so` and `plus` split only when a clause follows them:
 *   the first content word after them (leads such as "please", "now", "can
 *   you" skipped) is a verb of the early-start grammar, the action verbs of
 *   turns.ts or a media verb; otherwise the word is part of the object
 *   ("search for salt and pepper", "compute two plus two"). A correction
 *   ("no", "actually", "instead", "wait", "sorry", "never mind", "scratch
 *   that") followed by a verb-led clause discards the clause before it, so
 *   "go to youtube, no, go to gmail" is one clause, "go to gmail"; a clause
 *   already committed for youtube is then superseded by it.
 * - A second imperative verb with no connector splits when it is an
 *   unambiguous one (open, launch, go to, switch to, take me to, pull up,
 *   bring up, look up, scroll, search, quit) not preceded by a determiner or
 *   preposition ("the open tab", "how to open"), or when the words before it
 *   already form a whole early clause ("open youtube play midwest safety",
 *   "go to slack show me the general channel"). "play the daily show" is
 *   one clause: "show" follows an adjective inside an object.
 * - A clause commits by boundary the moment the following clause's first
 *   content word has arrived (for "go to youtube and play…" that word is
 *   "play"), or by stability when its words have stood unchanged for
 *   STREAM_LIMITS.stableMs and they parse as verb + object: at least two
 *   words, the first a verb phrase, the object not a lone determiner.
 * - A committed clause whose words a later partial changes beyond case and
 *   punctuation is superseded; the replacement is the clause now at its
 *   index, which commits again by the same rules and is decided afresh.
 *   Growth counts as change ("play a midwest" paused on, then "play a
 *   midwest safety"): the action taken for the shorter words may be stale,
 *   and the executor drops a replacement's action equal to the one issued.
 * - A fragment the recognizer's punctuation cut off the clause before it,
 *   with no verb of its own and no noun phrase beyond a determiner and one
 *   or two words ("play a midwest safety. Video", "…, the video"), is that
 *   clause's trailing words, not a clause: it is merged back, so the query
 *   grows instead of a lone noun standing as a search of its own. A
 *   verb-led clause after punctuation ("open Slack, message Dana"), a
 *   question or a pointer ("what time is it", "the one on the right") and
 *   anything after a hard connector ("then video") stay clauses.
 * - The final is segmented the same way; a committed clause is kept when
 *   its whole words stand, in order, inside one of the final's clauses, and
 *   dropped otherwise (the final never said them, or a correction removed
 *   them).
 *
 * Word offsets count every word token of the partial after the wake phrase
 * and any restart (turns.ts restartedTurn), fillers and connectors included,
 * so they index the recognizer's own words; `endWord` is exclusive. A
 * clause's `text` is its words as heard, fillers and connectors left out.
 */
import { leadingClause } from "./early";
import { ACTION_VERBS, WAKE_CALL, restartedTurn } from "./turns";

export interface PartialSample {
  /** The partial as heard. */
  text: string;
  /** Monotonic time the partial was heard, in milliseconds. */
  atMs: number;
}
export type ClauseState = "growing" | "committed" | "superseded";
export interface Clause {
  /** 0-based order in the utterance. */
  index: number;
  /** This clause's words, connectors stripped. */
  text: string;
  /** Word offsets into the partial; endWord exclusive. */
  startWord: number;
  endWord: number;
  state: ClauseState;
  committedAtMs?: number;
}
export interface ClauseStream {
  /** Events since the last push. */
  push(sample: PartialSample): ClauseEvent[];
  final(text: string, atMs: number): ClauseEvent[];
  clauses(): Clause[];
}
export type ClauseEvent =
  | { kind: "committed"; clause: Clause; by: "boundary" | "stable" }
  /** The recognizer rewrote committed words. */
  | { kind: "superseded"; clause: Clause; replacement: Clause }
  /** dropped: committed clauses the final no longer contains. */
  | { kind: "final"; clauses: Clause[]; dropped: Clause[] };

export const STREAM_LIMITS = {
  /** A growing clause that parses as verb + object commits after this long unchanged. */
  stableMs: 350,
} as const;

// Words ---------------------------------------------------------------------

const wordSet = (list: string) => new Set(list.split(/\s+/).filter(Boolean));
const FILLERS = wordSet("um uh uhm umm er erm hmm hm mm");
/** Said before a request without changing it; skipped when looking for the verb. */
const LEADS = wordSet(
  "ok okay so hey now just please also then and can could would will you",
);
/** "and" and "so" split a clause only when a verb-led clause follows. */
const SOFT = wordSet("and so plus");
/** These split by themselves. */
const HARD = wordSet("then also");
const CORRECTION = wordSet("no nope actually instead wait sorry nevermind");
/**
 * Multiword verb phrases of the early-start grammar and the media verbs,
 * longest first; single-word verbs are the union below.
 */
const VERB_PHRASES: readonly string[][] = [
  ["switch", "over", "to"],
  ["take", "me", "to"],
  ["get", "directions", "to"],
  ["how", "do", "i", "get", "to"],
  ["go", "to"],
  ["show", "me"],
  ["switch", "to"],
  ["pull", "up"],
  ["bring", "up"],
  ["look", "up"],
  ["look", "for"],
  ["search", "for"],
  ["open", "up"],
  ["listen", "to"],
  ["directions", "to"],
  ["navigate", "to"],
];
const MEDIA_VERBS = wordSet(
  "play watch listen scroll google navigate visit browse",
);
const EARLY_VERBS = wordSet("open launch switch");
const VERBS: ReadonlySet<string> = new Set([
  ...EARLY_VERBS,
  ...ACTION_VERBS,
  ...MEDIA_VERBS,
]);
/**
 * Verbs that begin a clause wherever they stand, unless a determiner or a
 * preposition precedes them: "open", "go to", "scroll" are never objects.
 */
const STRONG_PHRASES = new Set([
  "open",
  "open up",
  "launch",
  "go to",
  "take me to",
  "switch to",
  "switch over to",
  "pull up",
  "bring up",
  "look up",
  "scroll",
  "search",
  "search for",
  "quit",
]);
/** After these a verb word is not a new clause ("how to open", "the open tab"). */
const NO_SPLIT_BEFORE = wordSet(`to the a an this that these those my your his
  her its our their some any no every each of for in on at with by from about
  into over under or but than as if when how what which who why where can
  could would will should shall dont not never please you i we they me let lets
  just only really always`);
const DETERMINERS = wordSet("a an the my your this that these those some it");
/** A fragment beginning with one of these is a question or a pointer, never the previous clause's trailing words. */
const NOT_A_TRAILER = wordSet(`what who where when why how which i you we they
  he she there here yes no not`);
/** A trailing fragment carries at most this many words after leads and a determiner. */
const TRAILER_WORDS = 2;

interface Tok {
  raw: string;
  /** Lowercase, apostrophes removed; empty for punctuation. */
  word: string;
  /** Position among the word tokens; -1 for punctuation. */
  at: number;
  punct?: string;
}
const TOKEN = /[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*|[,;.!?]/gu;
const LEADING_WAKE = new RegExp(
  String.raw`^\s*${WAKE_CALL}(?![a-z])[\s,.:;!?—-]*`,
  "iu",
);

/** The request in a partial: after a restart, without the wake phrase. */
function requestText(text: string): string {
  return restartedTurn(text).text.replace(LEADING_WAKE, "");
}

function tokens(text: string): Tok[] {
  const out: Tok[] = [];
  let at = 0;
  for (const [raw] of requestText(text).matchAll(TOKEN)) {
    if (/^[\p{L}\p{N}]/u.test(raw)) {
      out.push({ raw, word: raw.toLowerCase().replace(/['’]/g, ""), at });
      at++;
    } else out.push({ raw, word: "", at: -1, punct: raw });
  }
  return out;
}

/** The length of the verb phrase starting at word k of `words`, or 0. */
function verbPhraseAt(words: readonly string[], k: number): number {
  for (const phrase of VERB_PHRASES)
    if (phrase.every((w, i) => words[k + i] === w)) return phrase.length;
  return words[k] !== undefined && VERBS.has(words[k]) ? 1 : 0;
}
/** Whether a verb-led clause begins at k, leads skipped; undefined while only leads have arrived. */
function clauseFollows(
  words: readonly string[],
  k: number,
): boolean | undefined {
  let i = k;
  while (i < words.length && (LEADS.has(words[i]) || FILLERS.has(words[i])))
    i++;
  if (i >= words.length) return undefined;
  return verbPhraseAt(words, i) > 0;
}

interface Segment {
  toks: Tok[];
  startWord: number;
  endWord: number;
  /** What cut this segment off the one before it; undefined for the first. */
  cut?: "punct" | "hard" | "soft" | "correction" | "verb";
}
type Cut =
  | { kind: "hard"; len: number }
  | { kind: "soft"; len: number }
  | { kind: "correction"; len: number };
function cutAt(words: readonly string[], k: number): Cut | undefined {
  const w = words[k];
  const next = words[k + 1];
  if (w === "and") {
    if (next === "then" || next === "also") return { kind: "hard", len: 2 };
    if (next === "after" && words[k + 2] === "that")
      return { kind: "hard", len: 3 };
    return { kind: "soft", len: 1 };
  }
  if (w === "after" && next === "that") return { kind: "hard", len: 2 };
  if (HARD.has(w)) return { kind: "hard", len: 1 };
  if (SOFT.has(w)) return { kind: "soft", len: 1 };
  if (w === "never" && next === "mind") return { kind: "correction", len: 2 };
  if (w === "scratch" && next === "that") return { kind: "correction", len: 2 };
  if (w === "i" && (next === "mean" || next === "meant"))
    return { kind: "correction", len: 2 };
  if (CORRECTION.has(w)) return { kind: "correction", len: 1 };
  return undefined;
}

/** The words of a segment, lowercased and normalized. */
const wordsOf = (seg: Segment) => seg.toks.map((t) => t.word);
const textOf = (seg: Segment) => seg.toks.map((t) => t.raw).join(" ");

/**
 * Whether a verb at word k of the utterance starts a new clause although no
 * connector precedes it.
 */
function secondVerbSplits(
  words: readonly string[],
  k: number,
  current: Segment,
): boolean {
  const len = verbPhraseAt(words, k);
  if (!len || !current.toks.length) return false;
  const prev = words[k - 1];
  if (prev !== undefined && NO_SPLIT_BEFORE.has(prev)) return false;
  const phrase = words.slice(k, k + len).join(" ");
  if (STRONG_PHRASES.has(phrase)) return true;
  // "open youtube play …", "go to slack show me …": the words so far are a
  // whole early clause and a media verb follows.
  const early = leadingClause(textOf(current));
  return !!early && early.next === "end";
}

/**
 * Cut the words of one partial into clauses. In a final nothing more is
 * coming, so a trailing connector or correction is a word of its clause
 * ("search for dr no") rather than left waiting.
 */
function segment(text: string, final = false): Segment[] {
  const toks = tokens(text);
  const words = toks.filter((t) => !t.punct).map((t) => t.word);
  const out: Segment[] = [];
  let cur: Segment = { toks: [], startWord: 0, endWord: 0 };
  /** What cut the segment now open off the one before it. */
  let opened: Segment["cut"];
  const close = (by: NonNullable<Segment["cut"]>) => {
    if (cur.toks.length) out.push(cur);
    cur = { toks: [], startWord: 0, endWord: 0 };
    opened = by;
  };
  const discard = () => {
    cur = { toks: [], startWord: 0, endWord: 0 };
    opened = "correction";
  };
  let i = 0;
  while (i < toks.length) {
    const t = toks[i];
    if (t.punct) {
      close("punct");
      i++;
      continue;
    }
    if (FILLERS.has(t.word)) {
      i++;
      continue;
    }
    const k = t.at;
    const cut = cutAt(words, k);
    if (cut) {
      if (!cur.toks.length) {
        // A connector before any words is a lead ("and open slack"); a hard
        // one or a correction still opens what follows as a clause of its
        // own ("open slack. then the video").
        if (cut.kind === "hard") opened = "hard";
        else if (cut.kind === "correction") opened = "correction";
        i += cut.len;
        continue;
      }
      if (cut.kind === "hard") {
        close("hard");
        i += cut.len;
        continue;
      }
      const follows = clauseFollows(words, k + cut.len);
      if (follows === undefined && !final) {
        // "go to youtube and": the connector waits for the next word and is
        // not yet part of anything.
        break;
      }
      if (follows) {
        if (cut.kind === "correction") discard();
        else close("soft");
        i += cut.len;
        continue;
      }
      // "salt and pepper", "dr no": the word belongs to the object.
    } else if (secondVerbSplits(words, k, cur)) close("verb");
    if (!cur.toks.length) {
      cur.startWord = k;
      cur.cut = opened;
    }
    cur.toks.push(t);
    cur.endWord = k + 1;
    i++;
  }
  close("punct");
  return mergeTrailers(out);
}

/**
 * Whether a segment is the previous clause's trailing words cut off by
 * punctuation: no verb of its own, at most TRAILER_WORDS words after leads
 * and a determiner, none of them a question word or a pointer.
 */
function trailerOf(words: readonly string[]): boolean {
  let i = 0;
  while (i < words.length && LEADS.has(words[i])) i++;
  if (i < words.length && DETERMINERS.has(words[i])) i++;
  const rest = words.slice(i);
  if (!rest.length || rest.length > TRAILER_WORDS) return false;
  if (verbPhraseAt(words, i) > 0) return false;
  return !rest.some((w) => NOT_A_TRAILER.has(w) || VERBS.has(w));
}
/** Folds each punctuation-cut trailer into the segment before it. */
function mergeTrailers(segs: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const seg of segs) {
    const prev = out[out.length - 1];
    if (prev && seg.cut === "punct" && trailerOf(wordsOf(seg))) {
      prev.toks.push(...seg.toks);
      prev.endWord = seg.endWord;
    } else out.push(seg);
  }
  return out;
}

/** Verb + object: at least two words, the first a verb phrase, the object more than a determiner. */
function verbObject(words: readonly string[]): boolean {
  let i = 0;
  while (i < words.length && LEADS.has(words[i])) i++;
  const len = verbPhraseAt(words, i);
  if (!len) return false;
  const object = words.slice(i + len);
  if (!object.length) return false;
  return !(object.length === 1 && DETERMINERS.has(object[0]));
}
/** The next clause has begun: a word of its own, leads not counted. */
function hasContentWord(words: readonly string[]): boolean {
  return words.some((w) => !LEADS.has(w));
}
const sameWords = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((w, i) => w === b[i]);
/** Whether `part` stands whole and in order inside `whole`. */
function contains(whole: readonly string[], part: readonly string[]): boolean {
  if (!part.length) return false;
  for (let i = 0; i + part.length <= whole.length; i++)
    if (part.every((w, j) => whole[i + j] === w)) return true;
  return false;
}

interface Tracked {
  clause: Clause;
  words: string[];
}
const snapshot = (c: Clause): Clause => ({ ...c });

export function createClauseStream(): ClauseStream {
  let list: Tracked[] = [];
  /** When the words at each index last changed. */
  const changedAt = new Map<number, number>();
  let finished = false;
  return {
    push(sample) {
      if (finished) return [];
      const segs = segment(sample.text);
      const events: ClauseEvent[] = [];
      const next: Tracked[] = segs.map((seg, k) => {
        const words = wordsOf(seg);
        const clause: Clause = {
          index: k,
          text: textOf(seg),
          startWord: seg.startWord,
          endWord: seg.endWord,
          state: "growing",
        };
        const old = list[k];
        if (old && sameWords(old.words, words)) {
          if (old.clause.state === "committed") {
            clause.state = "committed";
            clause.committedAtMs = old.clause.committedAtMs;
          }
        } else {
          changedAt.set(k, sample.atMs);
          if (old?.clause.state === "committed")
            events.push({
              kind: "superseded",
              clause: { ...old.clause, state: "superseded" },
              replacement: snapshot(clause),
            });
        }
        return { clause, words };
      });
      // Committed clauses past the end of a shorter rewrite: superseded by
      // what now stands last, or by nothing when the partial emptied.
      for (let k = segs.length; k < list.length; k++) {
        changedAt.delete(k);
        const old = list[k];
        if (old.clause.state !== "committed") continue;
        const last = next[next.length - 1]?.clause;
        events.push({
          kind: "superseded",
          clause: { ...old.clause, state: "superseded" },
          replacement: last
            ? snapshot(last)
            : {
                index: k,
                text: "",
                startWord: 0,
                endWord: 0,
                state: "growing",
              },
        });
      }
      for (let k = 0; k < next.length; k++) {
        const { clause, words } = next[k];
        if (clause.state === "committed") continue;
        let by: "boundary" | "stable" | undefined;
        if (k < next.length - 1 && hasContentWord(next[k + 1].words))
          by = "boundary";
        else if (
          sample.atMs - (changedAt.get(k) ?? sample.atMs) >=
            STREAM_LIMITS.stableMs &&
          verbObject(words)
        )
          by = "stable";
        if (!by) continue;
        clause.state = "committed";
        clause.committedAtMs = sample.atMs;
        events.push({ kind: "committed", clause: snapshot(clause), by });
      }
      list = next;
      return events;
    },
    final(text, atMs) {
      if (finished) return [];
      finished = true;
      const segs = segment(text, true);
      const committed = list.filter((t) => t.clause.state === "committed");
      const kept = new Set<Tracked>();
      const next: Tracked[] = segs.map((seg, k) => {
        const words = wordsOf(seg);
        // The committed clause this one carries, whole: its commit time stays.
        const carried = committed.find(
          (t) => !kept.has(t) && contains(words, t.words),
        );
        if (carried) kept.add(carried);
        const clause: Clause = {
          index: k,
          text: textOf(seg),
          startWord: seg.startWord,
          endWord: seg.endWord,
          state: "committed",
          committedAtMs: carried?.clause.committedAtMs ?? atMs,
        };
        return { clause, words };
      });
      const dropped = committed
        .filter((t) => !kept.has(t))
        .map((t) => snapshot(t.clause));
      list = next;
      return [
        {
          kind: "final",
          clauses: next.map((t) => snapshot(t.clause)),
          dropped,
        },
      ];
    },
    clauses() {
      return list.map((t) => snapshot(t.clause));
    },
  };
}

/**
 * The clauses of one finished text, each committed at `atMs`: for a caller
 * that has a final and no stream (a typed request, a test).
 */
export function clausesOf(text: string, atMs = 0): Clause[] {
  return segment(text, true).map((seg, k) => ({
    index: k,
    text: textOf(seg),
    startWord: seg.startWord,
    endWord: seg.endWord,
    state: "committed",
    committedAtMs: atMs,
  }));
}
