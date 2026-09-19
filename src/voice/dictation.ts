/**
 * Dictation: typing what the user said without a model call. "type hello
 * world", "dictate see you at six" and "write 'back in five'" name text and
 * nothing else, so the run types it into the focused text field on its first
 * frame and is over (src/core/runner.ts, gated by focusedTextField in
 * src/core/policy.ts). This module is the pure part: which utterance is a
 * dictation, and how spoken punctuation becomes written text.
 *
 * Grammar, after restartedTurn() and with leads skipped:
 *
 *   lead*  verb  text
 *   lead := ok okay so hey now just please also then and | can/could/would/will you
 *   verb := type | dictate | write | write down
 *   text := the rest of the words, unquoted when they were said in quotes
 *
 * A destination stays a task for the model: "in", "into", "on" or "to" right
 * after the verb ("type in Notes hello"), or "in/into/on [the] place" at the
 * end ("write 'see you at six' in the note"). So does something to compose
 * rather than words to put down ("write an email to Dana", "write back"), a
 * pointer alone ("type that again"), and any mention of a password.
 */
import { WAKE_HEY, WAKE_NAME, restartedTurn } from "./turns";

/**
 * Spoken marks, of one or two words, and what they write. Every quote phrase
 * writes the same character; which side it sits on is read from the phrase.
 */
const MARKS: Record<string, string> = {
  comma: ",",
  period: ".",
  "full stop": ".",
  "question mark": "?",
  "exclamation mark": "!",
  "exclamation point": "!",
  colon: ":",
  semicolon: ";",
  dash: "—",
  hyphen: "-",
  "new line": "\n",
  "line break": "\n",
  newline: "\n",
  "new paragraph": "\n\n",
  quote: '"',
  "open quote": '"',
  "open quotes": '"',
  "begin quote": '"',
  "close quote": '"',
  "close quotes": '"',
  "end quote": '"',
  unquote: '"',
};
const OPENING = /^(?:open|begin)\b/;
const SENTENCE_END = /[.!?]$/;
/** A word a sentence capital applies to: letters only, never "github.com" or "6pm". */
const PLAIN_WORD = /^\p{L}[\p{L}'’]*$/u;

/**
 * Written text from spoken words: "see you at six comma maybe seven period
 * new line bring the notes" becomes "See you at six, maybe seven.\nBring the
 * notes". Marks sit against the word before them and a space follows; a
 * hyphen joins; a quote opens against the next word and closes against the
 * last; a new line or paragraph starts a sentence. Sentences start with a
 * capital, and nothing else changes case: the recognizer's own "I", names
 * and digits stay as heard, and numbers stay as it wrote them.
 */
export function normalizeDictation(text: string): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  let out = "";
  let space = false;
  let capital = true;
  let quoted = false;
  const mark = (phrase: string, written: string) => {
    if (written === '"') {
      const opens = OPENING.test(phrase) || (phrase === "quote" && !quoted);
      if (opens) {
        if (out && space) out += " ";
        out += written;
        space = false;
      } else {
        out = out.trimEnd() + written;
        space = true;
      }
      quoted = opens;
    } else if (written === "-") {
      out = out.trimEnd() + written;
      space = false;
    } else if (written === "—") {
      out = out.trimEnd() + (out ? " " : "") + written;
      space = true;
    } else if (written.startsWith("\n")) {
      out = out.trimEnd() + written;
      space = false;
      capital = true;
    } else {
      out = out.trimEnd() + written;
      space = true;
      if (SENTENCE_END.test(written)) capital = true;
    }
  };
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const pair = `${word} ${words[i + 1] ?? ""}`.toLowerCase();
    const single = word.toLowerCase();
    if (MARKS[pair]) {
      mark(pair, MARKS[pair]);
      i++;
      continue;
    }
    if (MARKS[single]) {
      mark(single, MARKS[single]);
      continue;
    }
    if (out && space) out += " ";
    out +=
      capital && PLAIN_WORD.test(word)
        ? word[0].toUpperCase() + word.slice(1)
        : word;
    space = true;
    capital = SENTENCE_END.test(word);
  }
  return out.trim();
}

/** The activation phrase at the start, as native strips it (WakePolicy.swift). */
const LEADING_WAKE = new RegExp(
  String.raw`^\s*${WAKE_HEY}[\s,]+${WAKE_NAME}(?![a-z])[\s,.:;!?—-]*`,
  "iu",
);
const LEAD =
  /^(?:(?:ok|okay|so|hey|now|just|please|also|then|and|(?:can|could|would|will) you)[,\s]+)*/i;
/** "type up my notes" composes, as "write up" does (COMPOSE); it is no verb here. */
const VERB = /^(type(?!\s+up\b)|dictate|write(?:\s+down)?)\b[\s:,—–-]*/i;
/** A place named right after the verb: "type in Notes hello", "write to Dana". */
const LEADING_PLACE = /^(?:in|into|on|to)\b/i;
/** A place named at the end: "in the note", "into Slack", "on the page". */
const TRAILING_PLACE =
  /\s(?:in|into|on)\s+(?:(?:the|my|a|an|this|that)\s+)?[\p{L}\p{N}'’.-]+(?:\s+[\p{L}\p{N}'’.-]+)?[.!?]*$/iu;
/** Said in quotes: the words between them are the text, whatever they are. */
const QUOTED = /^["“'‘«](.+)["”'’»][.!?]*$/su;
/** After "write": something to compose, not words to put down. */
const COMPOSE = new Set(
  `a an the my our your his her their this that these those some another
   me us him them it back about up`.split(/\s+/),
);
/** The whole text points at something instead of saying it. */
const POINTERS = new Set(
  "it this that them these those same again something anything text".split(" "),
);
/** Words about a secret: what to type is then for the model and its refusals. */
const SECRET = /\b(?:password|passcode|passphrase|pin|otp|credentials?)\b/i;

/**
 * The text a dictation asks to type, written out, or undefined when the words
 * are not one (a place, a composition, a pointer, a secret, or no text at
 * all). Never over 2000 characters, the type_text limit.
 */
export function dictationRequest(text: string): string | undefined {
  const words = restartedTurn(text.trim())
    .text.replace(LEADING_WAKE, "")
    .replace(LEAD, "");
  const verb = VERB.exec(words);
  if (!verb) return undefined;
  let rest = words.slice(verb[0].length).trim();
  if (!rest || LEADING_PLACE.test(rest)) return undefined;
  const quoted = QUOTED.exec(rest);
  if (quoted) rest = quoted[1].trim();
  else {
    if (TRAILING_PLACE.test(rest) || SECRET.test(rest)) return undefined;
    const said = rest
      .toLowerCase()
      .split(/\s+/)
      .map((word) => word.replace(/[.!?,:;]+$/, ""))
      .filter(Boolean);
    if (verb[1].toLowerCase() === "write" && COMPOSE.has(said[0]))
      return undefined;
    const pointed = said.filter((word) => word !== "the");
    if (pointed.length <= 3 && pointed.every((word) => POINTERS.has(word)))
      return undefined;
  }
  const written = normalizeDictation(rest);
  return written && written.length <= 2000 ? written : undefined;
}
