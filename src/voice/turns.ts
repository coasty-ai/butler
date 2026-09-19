/**
 * Pure language rules for spoken turns: normalization, intents, how finished
 * an utterance looks, fragment questions, and the per-turn routing plan that
 * electron/main.ts executes. The stop/pause and completeness rules mirror
 * native/macos (normalizeVoiceKey, isControlPhrase, utteranceCompleteness);
 * tests/fixtures/voice-phrases.json pins both sides.
 */
import type { FollowUpKind } from "./router";
import type { TaskSource } from "../core/schema";
import { PHRASES, clarificationTemplate } from "./phrases";

const FILLERS = new Set([
  "um",
  "uh",
  "uhm",
  "umm",
  "er",
  "erm",
  "hmm",
  "hm",
  "mm",
]);
/** Short real words that are never stutter fragments ("no notes"). */
const SHORT_WORDS = new Set(
  "a an i no so to on in it is at of or up go do be we me my by he us the and for not but".split(
    " ",
  ),
);
const DISCOURSE = new Set(["ok", "okay", "alright", "so", "well", "hey", "oh"]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/** Drops "st" in "st stop": a short non-word that the next word extends. */
function isStutter(word: string, next: string | undefined) {
  return (
    !!word &&
    !!next &&
    word.length <= 3 &&
    next.length > word.length &&
    next.startsWith(word) &&
    !SHORT_WORDS.has(word)
  );
}

/**
 * Removes the first copy of an immediately repeated n-gram, so the speaker's
 * restart ("open the, open the notes") is what remains.
 */
function collapseRepeats<T>(
  items: T[],
  keyOf: (item: T) => string,
  allow: (n: number, first: string) => boolean,
  maxN: number,
): T[] {
  const out = [...items];
  for (let i = 0; i < out.length;) {
    let removed = false;
    for (
      let n = Math.min(maxN, Math.floor((out.length - i) / 2));
      n >= 1;
      n--
    ) {
      let same = true;
      for (let j = 0; j < n && same; j++)
        same = keyOf(out[i + j]) === keyOf(out[i + n + j]);
      if (same && allow(n, keyOf(out[i]))) {
        out.splice(i, n);
        removed = true;
        break;
      }
    }
    // Re-check the same position: "stop stop stop" collapses fully.
    if (!removed) i++;
  }
  return out;
}

function keyParts(text: string) {
  const raw = tokenize(text);
  let base = raw.filter((w) => !FILLERS.has(w));
  // Repeat to a fixed point, like native voiceKeyBase: "st st stop" and
  // "s-s-stop" (hyphens split tokens) need a second pass. Every pass only
  // removes words, so an unchanged length means nothing changed.
  for (;;) {
    const next = collapseRepeats(
      base.filter((w, i) => !isStutter(w, base[i + 1])),
      (w) => w,
      () => true,
      3,
    );
    if (next.length === base.length) break;
    base = next;
  }
  const key = [...base];
  for (;;) {
    if (key[0] === "all" && key[1] === "right") key.splice(0, 2);
    else if (key.length && DISCOURSE.has(key[0])) key.shift();
    else break;
  }
  for (;;) {
    if (key.at(-1) === "please" || key.at(-1) === "thanks") key.pop();
    else if (key.at(-2) === "thank" && key.at(-1) === "you") key.splice(-2);
    else break;
  }
  return { raw, base, key };
}

/**
 * The normalized words used for intent matching: lowercase, no punctuation,
 * fillers and stutters removed, repeats collapsed, leading "okay/so/hey" and
 * trailing "please/thanks" stripped.
 */
export function intentKey(text: string): string {
  return keyParts(text).key.join(" ");
}

export type VoiceIntentKind =
  | "stop"
  | "pause"
  | "resume"
  | "undo"
  | "scroll"
  | "approve"
  | "decline"
  | "unclear"
  | "acknowledge"
  | "command";
export type VoiceIntent = { kind: VoiceIntentKind; text: string };

// Whole-utterance patterns only: "stop scrolling and click Save" is a
// correction, not a stop. Filler words may follow but no other content.
const stopFiller =
  "it|that|this|now|please|everything|the task|right now|stop|cancel";
const STOP_UTTERANCE = new RegExp(
  `^(?:please )?(?:stop|cancel)(?: (?:${stopFiller}))*$`,
);
const STOP_PHRASES = new Set([
  "never mind",
  "nevermind",
  "forget it",
  "cancel task",
  "abort",
]);
const STOP_WORDS = new Set(
  "stop cancel wait no it that this now everything right please".split(" "),
);
const pauseHead =
  "wait(?: a (?:sec|second|minute))?|pause|hold on|hold up|hang on|one moment|one sec|one second|just a moment|just a sec|give me a second";
const pauseFiller = "please|now|wait|a sec|a second|a minute|a moment|for me";
const PAUSE_UTTERANCE = new RegExp(
  `^(?:no )?(?:please )?(?:${pauseHead})(?: (?:${pauseHead}|${pauseFiller}))*$`,
);
// Whole-utterance too: "undo that", "take it back", "revert the last step"
// ask for the last step back and nothing else. "Undo the formatting" names
// something of its own and "don't undo that" is negated: both stay commands
// for the model, as does "redo".
const undoObject =
  "it|that|this|that one|(?:the )?last (?:one|step|action|change|edit)|(?:that|this) (?:step|action|change|edit)";
const UNDO_UTTERANCE = new RegExp(
  `^(?:(?:no|oops|wait|actually) )?(?:(?:can|could) you )?(?:(?:undo|revert)(?: (?:${undoObject}))?|take (?:it|that|this) back|(?:press|hit) undo)(?: (?:now|for me))?$`,
);
// Continuous scrolling, whole-utterance like stop (native isScrollPhrase
// mirrors these): "scroll down", "keep scrolling", "scroll up slowly" start
// it; "faster", "slower", "speed up" change its pace; "stop scrolling", "stop
// there", "that's enough" end it. "Scroll down a bit", "scroll to the bottom",
// "page down" and "stop scrolling and click Save" name a step or a correction
// of their own and stay commands for the model.
const scrollLead = "(?:(?:can|could) you )?(?:(?:just|now) )?";
const scrollObject =
  "(?: (?:it|(?:the |this )?(?:page|screen|window|list|feed|document)))?";
const scrollPace = "faster|quicker|slower|more slowly";
const SCROLL_START = new RegExp(
  `^${scrollLead}(?:(?:start|keep|keep on|continue) )?scroll(?:ing)?${scrollObject}(?: (down|up)(?:wards?)?)?${scrollObject}(?: (?:slowly|gently|for me|now|${scrollPace}))*$`,
);
const SCROLL_FASTER = new RegExp(
  `^(?:(?:scroll|go) )?(?:(?:a (?:bit|little)|much|even) )?(?:faster|quicker)$|^speed (?:it )?up$|^(?:thats |its )?too slow$`,
);
const SCROLL_SLOWER = new RegExp(
  `^(?:(?:scroll|go) )?(?:(?:a (?:bit|little)|much|even) )?(?:slower|more slowly)$|^slow (?:it )?down$|^(?:thats |its )?too fast$|^slowly$`,
);
const SCROLL_STOP = new RegExp(
  `^(?:(?:no|and) )?(?:(?:stop|quit|cancel|end) (?:the )?scroll(?:ing)?|stop (?:right )?(?:there|here)|(?:thats )?enough(?: scrolling)?)(?: (?:now|for me))?$`,
);
/**
 * What a spoken scroll asks for: a start (with the direction named, if any,
 * and a pace word said with it), a change of pace, or its end. The direction
 * is left open by "keep scrolling" and "scroll": whoever runs it keeps the
 * current one or defaults to down.
 */
export type ScrollRequest =
  | { act: "start"; direction?: "down" | "up"; factor?: 2 | 0.5 }
  | { act: "speed"; factor: 2 | 0.5 }
  | { act: "stop" };
function scrollRequestOf(key: string): ScrollRequest | undefined {
  if (SCROLL_STOP.test(key)) return { act: "stop" };
  if (SCROLL_FASTER.test(key)) return { act: "speed", factor: 2 };
  if (SCROLL_SLOWER.test(key)) return { act: "speed", factor: 0.5 };
  const start = SCROLL_START.exec(key);
  if (!start) return undefined;
  const direction = start[1] as "down" | "up" | undefined;
  const factor = /\b(?:faster|quicker)\b/.test(key)
    ? 2
    : /\b(?:slower|more slowly)\b/.test(key)
      ? 0.5
      : undefined;
  return {
    act: "start",
    ...(direction && { direction }),
    ...(factor && { factor }),
  };
}
/** The scroll request in the words, or undefined when they are not one. */
export function scrollRequest(text: string): ScrollRequest | undefined {
  return scrollRequestOf(intentKey(text));
}
const APPROVE_TOKENS = new Set(["yes", "yeah", "yep", "sure"]);
const DECLINE_TOKENS = new Set(["no", "nope", "dont"]);
const RESUME = new Set([
  "resume",
  "continue",
  "keep going",
  "go on",
  "carry on",
  "proceed",
  "you can continue",
]);
const APPROVE = new Set([
  "yes",
  "yeah",
  "yep",
  "yup",
  "sure",
  "sure thing",
  "approve",
  "approved",
  "confirm",
  "send it",
  "do it",
  "go ahead",
  "yes go ahead",
  "yes do it",
  "yes send it",
  "yeah go ahead",
]);
const DECLINE = new Set([
  "no",
  "nope",
  "nah",
  "no thanks",
  "no thank you",
  "deny",
  "dont",
  "do not",
  "dont send",
  "do not send",
  "dont do it",
  "not now",
  "not yet",
  "no dont",
]);
/** Back-channel replies, matched before "okay" and "thanks" are stripped. */
const ACKNOWLEDGE_RAW = new Set([
  "okay",
  "ok",
  "mhm",
  "uh huh",
  "mm hmm",
  "thanks",
  "thank you",
  "cool",
  "great",
  "got it",
  "fine",
]);
const ACKNOWLEDGE_KEY = new Set(["mhm", "cool", "great", "got it", "fine"]);
const ACKNOWLEDGE_WORDS = new Set(["okay", "ok", "alright", "thanks", "thank"]);

/**
 * Routes a final transcript. Bare "okay" and "thanks" acknowledge and never
 * approve; "yeah, no" is unclear; everything else with content is a command.
 */
export function voiceIntent(text: string): VoiceIntent {
  const { raw, base, key } = keyParts(text);
  const k = key.join(" ");
  const result = (kind: VoiceIntentKind): VoiceIntent => ({
    kind,
    text: text.trim(),
  });
  if (
    STOP_UTTERANCE.test(k) ||
    STOP_PHRASES.has(k) ||
    (key.length > 0 &&
      key.length <= 4 &&
      key.some((w) => w === "stop" || w === "cancel") &&
      key.every((w) => STOP_WORDS.has(w)))
  )
    return result("stop");
  if (PAUSE_UTTERANCE.test(k)) return result("pause");
  if (UNDO_UTTERANCE.test(k)) return result("undo");
  if (scrollRequestOf(k)) return result("scroll");
  if (
    key.length <= 5 &&
    key.some((w) => APPROVE_TOKENS.has(w)) &&
    key.some((w) => DECLINE_TOKENS.has(w))
  )
    return result("unclear");
  if (RESUME.has(k)) return result("resume");
  if (APPROVE.has(k)) return result("approve");
  if (DECLINE.has(k)) return result("decline");
  if (
    ACKNOWLEDGE_RAW.has(raw.join(" ")) ||
    ACKNOWLEDGE_KEY.has(k) ||
    (!key.length && base.some((w) => ACKNOWLEDGE_WORDS.has(w)))
  )
    return result("acknowledge");
  return result("command");
}

/** True exactly for spoken stop and pause utterances (native parity). */
export function isControlPhrase(text: string): boolean {
  const kind = voiceIntent(text).kind;
  return kind === "stop" || kind === "pause";
}

export type Completeness =
  "control" | "shortAnswer" | "complete" | "incomplete";
/** "scroll": the window open while a spoken scroll runs (native FollowUpKind.scroll). */
export type TurnContext =
  "command" | "answer" | "approval" | "continuation" | "scroll";

export const CONTINUATION_WORDS: ReadonlySet<string> = new Set(
  // Existing native list.
  (
    "open launch start go search find look type write send play show create make set turn switch close delete " +
    "compute calculate convert add move to for the a an and in on with into from of up my then please " +
    // Additions.
    "about at by but or so because like than as if when where which who your his her their our its some any every " +
    "is are was were be been can could would should will may might must want wanna need gonna let lets also just " +
    "maybe called named titled saying using via between through over under after before plus um uh er erm hmm"
  ).split(" "),
);
export const CONTINUATION_BIGRAMS: ReadonlySet<string> = new Set([
  "can you",
  "could you",
  "would you",
  "will you",
  "i want",
  "i need",
  "id like",
  "want to",
  "need to",
  "have to",
  "going to",
  "help me",
  "tell me",
  "show me",
  "let me",
  "and then",
  "go to",
  "look up",
  "search for",
  "how do",
  "how to",
  "what is",
  "whats the",
]);
export const ACTION_VERBS: ReadonlySet<string> = new Set(
  (
    "open launch start close quit search find look play show type write send email message text call create make " +
    "delete remove move copy paste go check read reply book order buy schedule remind set turn switch download " +
    "upload share save rename print translate summarize compose"
  ).split(" "),
);

/**
 * How finished an utterance looks. Decides how long the native endpoint waits
 * and whether a voice turn is a fragment. An utterance of fillers only is
 * incomplete.
 */
export function utteranceCompleteness(
  text: string,
  context: TurnContext = "command",
): Completeness {
  const intent = voiceIntent(text);
  if (intent.kind === "stop" || intent.kind === "pause") return "control";
  // While a page scrolls, "scroll up" and "faster" must land as quickly as
  // "stop" does; said anywhere else, "scroll down" may go on ("…to the
  // comments") and keeps a command's timing.
  if (context === "scroll" && intent.kind === "scroll") return "control";
  const key = keyParts(text).key;
  const last = key.at(-1);
  const bigram =
    key.length >= 2 && CONTINUATION_BIGRAMS.has(key.slice(-2).join(" "));
  if (context === "answer" || context === "approval") {
    if (["approve", "decline", "resume", "acknowledge"].includes(intent.kind))
      return "shortAnswer";
    if (last && key.length <= 2 && !CONTINUATION_WORDS.has(last) && !bigram)
      return "shortAnswer";
  }
  if (!last) return intent.kind === "acknowledge" ? "complete" : "incomplete";
  if (
    CONTINUATION_WORDS.has(last) ||
    bigram ||
    (key.length === 1 && ACTION_VERBS.has(last))
  )
    return "incomplete";
  return "complete";
}

/**
 * Words after which a multi-word utterance cannot end. Narrower than
 * CONTINUATION_WORDS: particles, verbs, copulas, modals and object pronouns
 * end real commands ("turn it up", "log in", "call her", "save as"), so those
 * only lengthen the endpoint and never trigger a question.
 */
const DANGLING = new Set(
  (
    "to for the a an and with into from of my then about by but or because than if your his their our its " +
    "some any every wanna gonna let lets called named titled saying using via between plus"
  ).split(" "),
);
/** Bare verbs that are complete imperatives on their own. */
const SELF_CONTAINED = new Set(["save", "print", "copy", "paste"]);
/** Leading request frames removed before matching a fragment verb. */
const REQUEST_FRAMES = [
  ["can", "you"],
  ["could", "you"],
  ["would", "you"],
  ["will", "you"],
  ["please"],
  ["i", "want", "to"],
  ["i", "need", "to"],
  ["id", "like", "to"],
];

/**
 * The question to ask when a voice turn is only a fragment ("Open" → "Open
 * what?", "can you" → "I'm listening."), or undefined when it should run.
 */
export function clarifyFragment(text: string): string | undefined {
  if (!text.trim()) return undefined;
  if (voiceIntent(text).kind !== "command") return undefined;
  if (utteranceCompleteness(text, "command") !== "incomplete") return undefined;
  const goOn = PHRASES.goOn[0];
  let key = keyParts(text).key;
  if (!key.length) return goOn;
  for (let stripped = true; stripped;) {
    stripped = false;
    for (const frame of REQUEST_FRAMES)
      if (
        key.length > frame.length &&
        frame.every((word, i) => key[i] === word)
      ) {
        key = key.slice(frame.length);
        stripped = true;
      }
  }
  const [verb, particle] = key;
  if (key.length === 1 || key.length === 2) {
    const template =
      key.length === 1
        ? clarificationTemplate(verb)
        : (verb === "search" || verb === "look") &&
            (particle === "for" || particle === "up")
          ? clarificationTemplate("search")
          : verb === "go" && particle === "to"
            ? clarificationTemplate("go")
            : undefined;
    if (template) return template;
  }
  const last = key.at(-1)!;
  if (key.length === 1)
    return ACTION_VERBS.has(last) && !SELF_CONTAINED.has(last)
      ? goOn
      : undefined;
  if (CONTINUATION_BIGRAMS.has(key.slice(-2).join(" ")) || DANGLING.has(last))
    return goOn;
  return undefined;
}

/**
 * Words that make a policy question unsafe for a follow-up "yes": money,
 * deletion, credentials, installs, protected sites, running programs, and
 * anything that sends, publishes, submits, signs, replaces or disables.
 */
const RESTRICTED_APPROVAL = new RegExp(
  `\\b(?:${[
    // Money.
    "transaction|payment|purchase|order|checkout|pay|buy|transfer",
    // Deletion, replacement and resets.
    "delet\\w*|remov\\w*|eras\\w*|trash|discard\\w*|replac\\w*|overwrit\\w*|reset|format|archiv\\w*",
    // Credentials, accounts, settings and protected sites.
    "protected|password|security|account|setting\\w*|revok\\w*|disabl\\w*|deactivat\\w*",
    // Installs, programs and the system.
    "install\\w*|uninstall\\w*|program\\w*|run\\w*|execut\\w*|script\\w*|shut down|restart|force quit",
    // Anything that sends, publishes, submits, signs or commits.
    "send\\w*|sent|publish\\w*|post\\w*|comment\\w*|shar\\w*|upload\\w*|invit\\w*|declin\\w*|call\\w*|dial\\w*",
    "submit\\w*|authori[sz]\\w*|accept\\w*|agree\\w*|sign\\w*|subscri\\w*|sav\\w*",
  ].join("|")})\\b`,
  "i",
);
/**
 * Whether a policy question names something that must never be approved
 * without the person at the screen (the list above). The phone remote uses
 * it beside followUpApprovalAllowed, so its "never by phone" tier is the same
 * rule the follow-up window applies.
 */
export function restrictedApproval(reason: string | undefined): boolean {
  return RESTRICTED_APPROVAL.test((reason ?? "").trim());
}

/**
 * Follow-up approvals are allowed only for questions shown to be benign
 * navigation or opening. Every CONFIRM reason in src/core/policy.ts is
 * enumerated in tests/voice-turns.test.ts.
 */
const FOLLOW_UP_ALLOWED = [
  /^Quit this application\?$/,
  /^Open [^.?!]{1,80}\?$/,
  /^Activate this control\?$/,
];
const CLICK_REASON = /^Click “(.{1,60})”\?$/u;
/**
 * Labels that only navigate or reveal. Policy already runs its own benign
 * labels ("Next", "Show more", "Open …") without asking, so these are the
 * navigation labels that still reach a "Click “…”?" question.
 */
const FOLLOW_UP_BENIGN_LABELS = new Set([
  "learn more",
  "read more",
  "see more",
  "see all",
  "more info",
  "more information",
  "load more",
  "next page",
  "previous page",
  "back to top",
  "scroll to top",
  "expand all",
  "collapse all",
  "close tab",
  "close window",
  "continue reading",
]);

/**
 * Whether a follow-up window "yes" (no wake phrase) may approve this policy
 * question. Only benign navigation or opening qualifies; everything else needs
 * the wake phrase, push-to-talk or a click.
 */
export function followUpApprovalAllowed(reason: string | undefined): boolean {
  const text = (reason ?? "").trim();
  if (!text || RESTRICTED_APPROVAL.test(text)) return false;
  if (FOLLOW_UP_ALLOWED.some((pattern) => pattern.test(text))) return true;
  const label = text.match(CLICK_REASON)?.[1];
  return (
    !!label &&
    FOLLOW_UP_BENIGN_LABELS.has(
      label
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ")
        .replace(/(?:\.{3}|…|:)$/, ""),
    )
  );
}

const CLEAN_SINGLE_REPEATS = new Set(
  "the a an to and i my in on of for".split(" "),
);
const wordKey = (token: string) =>
  token
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");

/** The letters of a token without surrounding punctuation ("um," → "um"). */
const coreOf = (token: string) =>
  token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
const OPEN_QUOTE = /^[([{]*["“‘'«]/u;
const CLOSE_QUOTE = /["”’'»][)\]}.,;:!?…]*$/u;

/** Which tokens sit inside quotes; an unclosed quote runs to the end. */
function quotedTokens(tokens: string[]): boolean[] {
  let open = false;
  return tokens.map((token) => {
    if (open) {
      if (CLOSE_QUOTE.test(token)) open = false;
      return true;
    }
    if (!OPEN_QUOTE.test(token)) return false;
    open = !CLOSE_QUOTE.test(token.replace(OPEN_QUOTE, ""));
    return true;
  });
}

/**
 * "s-s-stop," → "stop,": fragments of one to three lowercase letters (the
 * first may carry a sentence capital) that each start the final word. A single
 * two- or three-letter fragment is a real prefix ("re-read"), so it stays.
 */
function hyphenStutter(token: string): string | undefined {
  const lead = token.match(/^[^\p{L}]*/u)![0];
  const trail = token.match(/[^\p{L}]*$/u)![0];
  const parts = token
    .slice(lead.length, token.length - trail.length)
    .split("-");
  if (parts.length < 2) return undefined;
  const word = parts.pop()!;
  const first = parts[0];
  const capital = /^\p{Lu}/u.test(first);
  const fragments = parts.map((p, i) =>
    i === 0 && capital ? p.toLowerCase() : p,
  );
  if (
    !/^\p{L}+$/u.test(word) ||
    (capital && !/^\p{L}\p{Ll}*$/u.test(first)) ||
    !fragments.every(
      (f) =>
        /^\p{Ll}{1,3}$/u.test(f) &&
        word.length > f.length &&
        word.toLowerCase().startsWith(f),
    ) ||
    (parts.length === 1 && first.length > 1)
  )
    return undefined;
  const spoken = capital ? word[0].toUpperCase() + word.slice(1) : word;
  return lead + spoken + trail;
}

/**
 * The task text the model receives from speech: fillers, stutters and
 * repeated phrases removed, casing and punctuation otherwise kept ("bye bye"
 * stays). A filler-looking token next to a number ("25 mm"), in capitals
 * ("ER") or inside quotes stays; only a lowercase fragment of up to three
 * letters before a plain word is a stutter ("Al Alvarez", "ab abc.txt" stay).
 * Typed text never goes through here.
 */
export function cleanTaskText(text: string): string {
  const original = text.trim().split(/\s+/).filter(Boolean);
  const capitalized = /^\p{Lu}/u.test(original[0] ?? "");
  const quoted = quotedTokens(original);
  const hasDigit = (token: string | undefined) => /\p{N}/u.test(token ?? "");
  type Token = { text: string; quoted: boolean; index: number };
  let tokens: Token[] = original.flatMap((t, index) => {
    const item = { text: t, quoted: quoted[index], index };
    if (item.quoted) return [item];
    const letters = t.replace(/[^\p{L}]/gu, "");
    const allCaps = letters.length >= 2 && letters === letters.toUpperCase();
    if (
      FILLERS.has(wordKey(t)) &&
      !allCaps &&
      !hasDigit(original[index - 1]) &&
      !hasDigit(original[index + 1])
    )
      return [];
    const unstuttered = hyphenStutter(t);
    return [unstuttered ? { ...item, text: unstuttered } : item];
  });
  const stutter = (token: Token, next: Token | undefined) => {
    if (!next || token.quoted || next.quoted) return false;
    const core = coreOf(token.text);
    return (
      /^\p{Ll}{1,3}$/u.test(core) &&
      /^\p{L}+(?:['’]\p{L}+)?$/u.test(coreOf(next.text)) &&
      isStutter(core, wordKey(next.text))
    );
  };
  // Fixed point, as in intentKey: "n n notes" needs two passes.
  for (;;) {
    const next = collapseRepeats(
      tokens.filter((t, i) => !stutter(t, tokens[i + 1])),
      // Quoted words are never collapsed ("Type 'bye bye bye'").
      (t) => (t.quoted ? `quoted:${t.index}` : wordKey(t.text) || t.text),
      (n, first) => n >= 2 || CLEAN_SINGLE_REPEATS.has(first),
      8,
    );
    if (next.length === tokens.length) break;
    tokens = next;
  }
  const out = tokens.map((t) => t.text).join(" ");
  // Keep a sentence-initial capital when the first words were removed.
  return capitalized && /^\p{Ll}/u.test(out)
    ? out[0].toUpperCase() + out.slice(1)
    : out;
}

const LEADING_JOIN_FILLERS = new Set(["um", "uh", "oh"]);
const MAX_JOINED = 2000;

/** Whether every word of `a` appears in `b`, in order. */
function containsInOrder(a: string[], b: string[]): boolean {
  let at = 0;
  for (const word of b) if (word === a[at]) at++;
  return at === a.length;
}

/**
 * Joins a fragment or task with its spoken continuation: "Open" + "Safari" →
 * "Open Safari", "Open" + "open Safari" → "open Safari", "open the notes" +
 * "the notes app" → "open the notes app". Only the spoken continuation is
 * cleaned; with `keepFirst` (the run's existing task) the first part is used
 * verbatim apart from trailing punctuation, and is never replaced by a
 * continuation that drops any of its words.
 */
export function joinUtterances(
  first: string,
  second: string,
  options: { keepFirst?: boolean } = {},
): string {
  const a = (options.keepFirst ? first : cleanTaskText(first))
    .trim()
    .replace(/[\s.,;:!?…—–-]+$/u, "")
    .trim();
  let bTokens = cleanTaskText(second).split(/\s+/).filter(Boolean);
  while (bTokens.length && LEADING_JOIN_FILLERS.has(wordKey(bTokens[0])))
    bTokens.shift();
  const b = bTokens.join(" ");
  const cap = (s: string) => s.slice(0, MAX_JOINED).trim();
  if (!a) return cap(b);
  if (!b) return cap(a);
  const ka = intentKey(a).split(" ").filter(Boolean),
    kb = intentKey(b).split(" ").filter(Boolean);
  if (ka.length && ka.every((w, i) => kb[i] === w)) {
    // The continuation restates the first part. Use it when it keeps every
    // word; otherwise keep the first part and add only what follows the
    // restatement ("Email the ER team" + "email the team at noon").
    if (containsInOrder(tokenize(a), tokenize(b))) return cap(b);
    const restated = ka.join(" ");
    for (let j = 1; j <= bTokens.length; j++)
      if (intentKey(bTokens.slice(0, j).join(" ")) === restated) {
        const rest = bTokens.slice(j).join(" ");
        return cap(rest ? `${a} ${rest}` : a);
      }
  }
  const aWords = a.split(/\s+/).map(wordKey);
  for (let k = Math.min(4, aWords.length, bTokens.length); k >= 1; k--) {
    const tail = aWords.slice(-k),
      head = bTokens.slice(0, k).map(wordKey);
    if (tail.every((w, i) => w && w === head[i])) {
      bTokens = bTokens.slice(k);
      break;
    }
  }
  return cap(bTokens.length ? `${a} ${bTokens.join(" ")}` : a);
}

/**
 * Where a turn came from. "text" is typed on the Mac; "message" is a text
 * from the owner's phone and "remote" a phone remote over the tailnet. Those
 * two never approve anything: an approval needs the person at the Mac.
 */
export type VoiceSource =
  "ptt" | "wake" | "followup" | "text" | "message" | "remote";
export type NeedClickReason = "confidence" | "gate" | "restricted" | "channel";
export type TurnPlan =
  | { kind: "stop" }
  | { kind: "pause" }
  | { kind: "resume" }
  // "Undo that": Edit > Undo in the frontmost application, as the next step
  // of the run under way (which pauses, undoes, reports and waits) or of a
  // short run of its own right after one ended. `words` are the user's own,
  // for that run's record.
  | { kind: "undo"; words: string }
  // "Scroll down": the helper scrolls the window in front until the user says
  // stop, with no model call; "faster", "slower" and "scroll up" steer it and
  // "stop scrolling" ends it. A run under way pauses and waits for "continue".
  | { kind: "scroll"; request: ScrollRequest }
  | { kind: "approve" }
  | { kind: "decline" }
  | { kind: "confirmAgain" }
  | { kind: "needClick"; reason: NeedClickReason }
  | { kind: "nothingToApprove" }
  | { kind: "nothingRunning" }
  | { kind: "stillWorking" }
  | { kind: "acknowledge" }
  // "That's all", "stop listening", "goodbye", "thanks Butler" under the
  // conversation setting: the open window closes and nothing else happens.
  | { kind: "endConversation" }
  // `words`: the user's own words when they named no task of their own
  // ("do that", "go for it"); the dialog model may still resolve them to
  // something the user said, so the plan stays open to it.
  | { kind: "clarify"; question: string; fragment: string; words?: string }
  | { kind: "amendTask"; text: string }
  | { kind: "revise"; text: string }
  | { kind: "start"; text: string; taskSource?: TaskSource }
  // A new, unrelated request while the current run is stalled or paused: stop
  // that run and start this one instead of treating it as a correction.
  | { kind: "replace"; text: string }
  // "How's it going?": answered from the run view, never a correction.
  | { kind: "status" }
  // "After that, …": runs once the current run ends. An accepted proposal
  // queues with the assistant's provenance, like a start would carry it.
  | { kind: "queue"; text: string; taskSource?: TaskSource }
  // A spoken or texted line decided by the dialog model (increment 3); the
  // deterministic router never produces one.
  | {
      kind: "reply";
      act: "answer" | "status" | "none";
      resume: boolean;
      repeatApproval?: boolean;
    };
export type TurnPlanKind = TurnPlan["kind"];

export interface VoiceTurnRun {
  id: string;
  status: string;
  actions: number;
  /** Paused or in takeover (main.ts runHeld). */
  held: boolean;
  /** The policy question while an approval is pending. */
  pendingReason?: string;
  /**
   * What the pending approval is: a run action, or a coding agent's request
   * relayed from a watch (a command needs a click; the rest may be spoken).
   */
  pendingKind?: "action" | "relay_command" | "relay_other";
  task: string;
  /**
   * Held because it stalled or was paused (stuck, handed back, paused by the
   * user), not because it asked the user a question or needs an approval.
   */
  stalled?: boolean;
}
export interface VoiceFragment {
  text: string;
  until: number;
}
export interface VoiceLastTurn {
  plan: TurnPlanKind;
  runId?: string;
  actionsAtEnd: number;
  endedAt: number;
}
export interface VoiceTurnInput {
  text: string;
  /** voiceCommandConfidence(event): 0 for recovered or unconfirmed speech. */
  confidence: number;
  source: VoiceSource;
  /** The follow-up window the turn was detected in (source "followup"). */
  window?: FollowUpKind;
  /** The "Keep listening" setting: only "conversation" has closing phrases. */
  followUpWindow?: FollowUpWindow;
  /** Recognizer segments merged into this turn; more than one never approves. */
  segments?: number;
  /**
   * The recognizer never finalized this text; it is its last hypothesis
   * (transcript_recovered). It may start or steer a task, never approve one.
   */
  recovered?: boolean;
  /** Milliseconds from follow-up detection to this final. */
  turnMs?: number;
  /** The approval captured when listening started still matches. */
  gateMatches: boolean;
  /**
   * The autonomy setting trusts a clearly heard "yes" for any question
   * ("flow", or "all" acknowledged): the follow-up allow-list does not apply.
   * Live 2026-09-19: "Yes" to Calendar's Return prompt was sent to a click.
   */
  approvesAnyByVoice?: boolean;
  now: number;
  run?: VoiceTurnRun;
  fragment?: VoiceFragment;
  lastTurn?: VoiceLastTurn;
  /** When the last run ended, whatever its outcome: an undo said soon after refers to it. */
  lastRun?: { endedAt: number };
  /**
   * A spoken scroll is under way (or was just latched by this activation and
   * waits for its words): "faster", "slower", "scroll up" and "stop scrolling"
   * steer it instead of the run.
   */
  scrolling?: boolean;
  /**
   * A task the assistant offered ("Want me to …?") that a "yes" accepts while
   * no approval is pending. Its text is the assistant's, so the run it starts
   * is marked taskSource "proposal", never the user's own words.
   */
  proposal?: { id: string; text: string; until: number };
}

export const APPROVAL_MIN_CONFIDENCE = 0.65;
export const FOLLOW_UP_APPROVAL_MIN_CONFIDENCE = 0.75;
export const CONTINUATION_WINDOW_MS = 3000;
export const MAX_TURN_MS = 45000;
/** How long after a run ended "undo that" still means its last step. */
export const UNDO_WINDOW_MS = 60000;
const TERMINAL = new Set(["completed", "cancelled", "failed"]);

/**
 * Decides what a finished turn does. Pure: main.ts executes the plan and then
 * calls Conversation.acknowledge(plan).
 */
/**
 * The wake name as a recognizer writes it, exactly as native wakeNamePattern
 * (WakePolicy.swift): the speech test's accept list
 * (.data/names/butler-speech.log §6). tests/fixtures/voice-phrases.json "wake"
 * pins both sides. Never "but a lot", "butter", "bottle", "Butlers" or "Butler's".
 */
export const WAKE_NAME = String.raw`(?:butt?l[ae]r|budler|butla|batala)`;
/** No spelling runs "Hey" into "Butler": mirrors native fusedWakePattern. */
export const FUSED_WAKE = String.raw`(?!)`;
/** The words that may lead the name. */
export const WAKE_HEY = "(?:hey|hay|hi|hei)";
/**
 * The wake phrase as spoken, "Hey Butler" or just "Butler": the name after its
 * lead, or the name alone (native wakePhrasePattern). The lead is optional,
 * never required.
 */
export const WAKE_CALL = String.raw`(?:${WAKE_HEY}[\s,]+)?${WAKE_NAME}`;
const WAKE_FOLLOWERS = [
  ...ACTION_VERBS,
  // Control words (native wakeControlWords): "Hey Butler stop" never waits.
  ..."stop cancel pause wait hold continue resume yes no never".split(" "),
  // Replies, greetings and lead-in words (native wakeReplyWords): "Hey Butler
  // sure go for it" is one breath, and a recognizer writes no comma after the name.
  ..."sure yeah yep yup ok okay alright fine right correct nah nope not do thanks thank hello hi good morning afternoon evening night actually so also one quick quickly just now".split(
    " ",
  ),
  // Question openers (native wakeOpeners), including yes/no and status
  // questions: "Hey Butler anything on my calendar", "is Slack open".
  ..."what whats when where who why how can could would will please tell give i im let lets anything any is are am was were do does did have has should which whose".split(
    " ",
  ),
];
/**
 * The gate: "Butler" has the shape of "is a", so a biased recognizer writes
 * "Hey, is a table free?" as "Hey Butler table free?", and a sentence about a
 * butler can open with the word. The name counts only when a pause
 * (punctuation, or a hesitation such as "um"), the end, a task or control
 * verb, a question opener or the wake phrase again follows it (native wakeGate).
 */
const WAKE_GATE = String.raw`(?=\s*(?:[,.:;!?—-]|(?:um|uh|uhm|umm|er|erm|hmm|hm|mm)\b|$)|\s+(?:${WAKE_FOLLOWERS.join("|")})\b|\s+${WAKE_CALL}(?![a-z]))`;

/**
 * A turn that is only the wake phrase, in any accepted spelling ("Hey Butler",
 * "Hi Buttler", or the bare "Butler"), matched on intentKey, which has already
 * dropped a leading "hey".
 */
const WAKE_ONLY =
  /^(?:(?:hay|hi|hei|his|a)\s+)?(?:butler|buttler|butlar|budler|butla|batala)$/;
/**
 * What ends a conversation-mode window without acting (native endsConversation,
 * TurnPolicy.swift; the "endConversation" fixture pins both): "that's all",
 * "that'll be all", "that's it", "goodbye", "bye", "good night", "stop
 * listening", each with the name or "for now" allowed after it, or "thanks"
 * followed by the name. A bare "thanks" stays a back-channel word.
 */
const CONVERSATION_CLOSER = String.raw`(?:(?:thats|that is|thatll be|that will be) (?:all|it)|good ?bye|bye(?: bye)?|good ?night|(?:you can )?stop listening)(?: for now| now)?`;
const CONVERSATION_THANKS = "(?:thanks|thank you)";
const CONVERSATION_END = new RegExp(
  `^(?:${CONVERSATION_THANKS} (?:${WAKE_NAME} )?)?${CONVERSATION_CLOSER}(?: ${WAKE_NAME})?$|^${CONVERSATION_THANKS} ${WAKE_NAME}$`,
);
export function endsConversation(text: string): boolean {
  return CONVERSATION_END.test(intentKey(text));
}

export type FollowUpWindow = "short" | "long" | "conversation";
/**
 * How long a follow-up window stays open, by kind and the "Keep listening"
 * setting (native followUpSeconds, TurnPolicy.swift). Continuation and answer
 * windows grow with the setting; an approval window stays bounded, since a
 * "yes" inside it acts.
 */
export function followUpSeconds(
  kind: FollowUpKind,
  window: FollowUpWindow = "short",
): number {
  // A scroll window lasts the controller's lease whatever the setting.
  if (kind === "scroll") return 95;
  if (window === "short") return kind === "continuation" ? 3 : 8;
  if (kind === "approval") return 12;
  return window === "long" ? 20 : 45;
}

export function isWakePhraseOnly(text: string): boolean {
  return WAKE_ONLY.test(intentKey(text));
}

/**
 * The wake phrase with its lead anywhere in spoken text, gated as native
 * commandAfterWakePhrase (WakePolicy.swift) gates it at the start. Native
 * also takes the bare name at the start of an utterance; inside a sentence
 * the bare name is a word unless the request repeats after it (BARE_NAME).
 */
const WAKE_PHRASE = new RegExp(
  String.raw`\b${WAKE_HEY}[\s,]+${WAKE_NAME}(?![a-z])${WAKE_GATE}[\s,.:;!?—-]*`,
  "iu",
);
/** The name alone inside a sentence: a restart only when the request repeats after it. */
const BARE_NAME = new RegExp(
  String.raw`\b(?:${WAKE_NAME}|${FUSED_WAKE})(?![a-z])[\s,.:;!?—-]*`,
  "giu",
);
const spokenWords = (text: string) =>
  tokenize(text).filter((w) => !FILLERS.has(w));
/**
 * A spoken turn in which the user started over by saying the wake phrase
 * again. Native keeps only the restart when it opens a new recognizer segment
 * (requestSegments in TurnPolicy.swift); said without a pause it arrives
 * inside one segment ("…at 6 PM hey butler open calendar and…"), so here too
 * only the words after the last wake phrase are the request, and a wake
 * phrase with nothing after it leaves the words before it. The bare name
 * counts inside a sentence only when the words after it repeat the request's
 * own opening words (live, with the old name: "open calendar and put an event
 * … at 6 PM Assist open calendar and put an event…"); otherwise the name is a
 * word ("tell Butler I'm late"). A turn changed this way counts as more than one
 * segment, so it can never approve.
 */
export function restartedTurn(
  text: string,
  segments?: number,
): { text: string; segments?: number } {
  const parts = text.split(WAKE_PHRASE);
  // A wake phrase before any words is the activation, not a restart; the
  // request after it is where a repeat is looked for.
  while (parts.length > 1 && !spokenWords(parts[0]).length) parts.shift();
  const request =
    parts.length < 2
      ? parts[0]
      : (parts
          .slice(1)
          .reverse()
          .find((part) => spokenWords(part).length) ?? parts[0]);
  const repeated = repeatedAfterName(request);
  if (parts.length < 2 && repeated === undefined) return { text, segments };
  return {
    text: (repeated ?? request).trim(),
    segments: Math.max(2, segments ?? 1),
  };
}
/** The words after the last bare name that repeats the opening words before it. */
function repeatedAfterName(text: string): string | undefined {
  let kept: string | undefined;
  for (const match of text.matchAll(BARE_NAME)) {
    const at = match.index ?? 0;
    // Two or three words are enough to tell a repeat from a sentence.
    const opening = spokenWords(text.slice(0, at)).slice(0, 3);
    const after = text.slice(at + match[0].length);
    const next = spokenWords(after);
    if (opening.length >= 2 && opening.every((word, i) => next[i] === word))
      kept = after;
  }
  return kept;
}
/**
 * What a finished voice transcript asks for, as main.ts hands it on: the words
 * after any restart and the segment count that goes with them, never the raw
 * transcript.
 */
export function transcriptRequest(event: {
  text?: string;
  segments?: number;
}): { text: string; segments?: number } {
  return restartedTurn((event.text ?? "").trim(), event.segments);
}

/**
 * Status questions, matched against intentKey(text): "how's it going?",
 * "status", "are you done yet?". Checked only after stop, pause, approval
 * answers, acknowledgements and resume, so a question never outranks a
 * control or an answer, and before fragments and corrections, so it is never
 * mistaken for a hint to the run.
 */
const STATUS_QUESTION = new RegExp(
  `^(?:${[
    "status(?: update)?|update|progress|any (?:news|update)",
    "hows? (?:it|that|things) (?:going|coming(?: along)?)",
    "how (?:is|are) (?:it|that|things) (?:going|coming(?: along)?)",
    "how are we doing|how far along are you|how much longer",
    "whats? (?:the )?status|what is the status",
    "where are (?:you|we)(?: at)?",
    "what are you (?:doing|up to|working on|stuck on)",
    "whats? (?:happening|going on)|what is (?:happening|going on)",
    "are you (?:done|finished|stuck|nearly done|almost done)(?: yet)?",
    "done yet|(?:are )?you still working(?: on it)?|still working",
  ].join("|")})$`,
);
export function isStatusQuestion(text: string): boolean {
  return STATUS_QUESTION.test(intentKey(text));
}

/**
 * "After that, check my email" / "check my email when you're done": the words
 * that ask for a task to wait for the current run, in front or at the end.
 */
const DONE =
  "(?:you(?:'re|’re| are) (?:done|finished)|that(?:'s|’s| is) (?:done|finished)|this is done)(?: with (?:that|this one|this|it))?";
const QUEUE_LEAD = new RegExp(
  `^(?:and\\s+|then\\s+)?(?:after (?:that|this one|this|${DONE})|when ${DONE}|once ${DONE})(\\s*[,:]\\s*|\\s+)(.+)$`,
  "iu",
);
const QUEUE_TAIL =
  /^(.+?)[,\s]+(?:after (?:that|this one|this)|when (?:you(?:'re|’re| are) (?:done|finished)|that(?:'s|’s| is) (?:done|finished))|once (?:you(?:'re|’re| are) (?:done|finished)|that(?:'s|’s| is) (?:done|finished)))[.!?]*$/iu;
/**
 * The task a queue request asks for, or undefined when the text is not one.
 * The returned text is the utterance minus the queueing words, otherwise
 * untouched, so speech still goes through cleanTaskText afterwards.
 *
 * "After this call, text Dana" and "after that meeting, send the notes" are
 * times, not queue requests: without a pause after the lead, the request must
 * begin right away with a request verb, and a short phrase before the first
 * comma belongs to the lead. A control word ("after that, stop") is never a
 * task to queue either.
 */
export function queueRequest(text: string): string | undefined {
  const trimmed = text.trim();
  const lead = QUEUE_LEAD.exec(trimmed);
  let rest = lead?.[2].trim();
  if (lead && !/[,:]/.test(lead[1])) {
    const clause = rest!.split(/[,:]/, 1)[0];
    const words = tokenize(rest!);
    const first = words.find((w) => !LEADING.has(w) && !FILLERS.has(w));
    if (
      (clause !== rest && tokenize(clause).length <= 3) ||
      !first ||
      !TASK_VERBS.has(first)
    )
      rest = undefined;
  }
  rest ??= QUEUE_TAIL.exec(trimmed)?.[1]?.trim();
  if (!rest || !tokenize(rest).some((w) => !FILLERS.has(w))) return undefined;
  return voiceIntent(rest).kind === "command" ? rest : undefined;
}

/**
 * Whether speech was heard clearly enough to answer for the user: one
 * segment, and confidence at or above the approval floor (higher in a
 * follow-up window, where ambient speech is more likely).
 */
function heardClearly(input: VoiceTurnInput): boolean {
  if (input.recovered) return false;
  const confidence = (input.segments ?? 1) > 1 ? 0 : input.confidence;
  const minimum =
    input.source === "followup"
      ? FOLLOW_UP_APPROVAL_MIN_CONFIDENCE
      : APPROVAL_MIN_CONFIDENCE;
  return Number.isFinite(confidence) && confidence > 0 && confidence >= minimum;
}

/** A source with no one at the Mac: texted or relayed from a phone. */
export function isRemoteSource(source: VoiceSource): boolean {
  return source === "message" || source === "remote";
}

export function planVoiceTurn(input: VoiceTurnInput): TurnPlan {
  const { text, source, now } = input;
  // Typed or texted words: never cleaned as speech, never fragments.
  const typed =
    source === "text" || source === "message" || source === "remote";
  const remote = isRemoteSource(source);
  // "Hey Butler" alone never becomes a task, correction or answer.
  if (!typed && isWakePhraseOnly(text)) return { kind: "acknowledge" };
  // Under the conversation setting, "that's all" closes the window that would
  // otherwise reopen after every reply; it runs, resumes and approves nothing.
  if (
    !typed &&
    input.followUpWindow === "conversation" &&
    endsConversation(text)
  )
    return { kind: "endConversation" };
  const intent = voiceIntent(text);
  const run =
    input.run && !TERMINAL.has(input.run.status) ? input.run : undefined;
  const pending =
    !!run && run.status === "confirming" && run.pendingReason !== undefined;
  // 1. Control intents are never merged; stop and pause always win.
  if (intent.kind === "stop") return { kind: "stop" };
  if (intent.kind === "pause") return { kind: "pause" };
  // 2. Answers to an approval.
  if (intent.kind === "approve" || intent.kind === "decline") {
    if (!run || !pending) {
      // A "yes" to the assistant's own offer starts that task; the task is
      // the assistant's wording, so the run never counts as the user's words.
      const proposal = input.proposal;
      if (proposal && now < proposal.until && proposal.text.trim()) {
        if (intent.kind === "decline") return { kind: "acknowledge" };
        // The offer may repeat words the user never said (a notification, a
        // page), so accepting it needs the same clear hearing as an approval.
        if (!typed && !heardClearly(input)) return { kind: "confirmAgain" };
        // With a run under way the offer waits its turn: applied to the run
        // it would become a correction in the user's name.
        return run
          ? { kind: "queue", text: proposal.text, taskSource: "proposal" }
          : { kind: "start", text: proposal.text, taskSource: "proposal" };
      }
      return { kind: "nothingToApprove" };
    }
    // Nobody is at the Mac to see what a texted "yes" would approve. A "no"
    // only pauses, and only when it answers the question that was relayed.
    if (remote)
      return intent.kind === "approve"
        ? { kind: "needClick", reason: "channel" }
        : input.gateMatches
          ? { kind: "decline" }
          : { kind: "confirmAgain" };
    if (source === "text") return { kind: intent.kind };
    const confidence = (input.segments ?? 1) > 1 ? 0 : input.confidence;
    const confident = heardClearly(input);
    // Declining only pauses, so it needs no gate; an uncertain "no" is asked
    // again rather than sent to the Yes button.
    if (intent.kind === "decline")
      return confident ? { kind: "decline" } : { kind: "confirmAgain" };
    if (!(confidence > 0)) return { kind: "needClick", reason: "confidence" };
    if (!input.gateMatches) return { kind: "needClick", reason: "gate" };
    if (!confident) return { kind: "needClick", reason: "confidence" };
    if (
      source === "followup" &&
      !input.approvesAnyByVoice &&
      !followUpApprovalAllowed(run.pendingReason)
    )
      return { kind: "needClick", reason: "restricted" };
    return { kind: "approve" };
  }
  // 3. Mixed answers and back-channel replies never act.
  if (intent.kind === "unclear")
    return pending ? { kind: "confirmAgain" } : { kind: "nothingToApprove" };
  if (intent.kind === "acknowledge")
    return pending ? { kind: "confirmAgain" } : { kind: "acknowledge" };
  // 4. Continue.
  if (intent.kind === "resume") {
    if (!run) return { kind: "nothingRunning" };
    if (pending) return { kind: "confirmAgain" };
    if (!run.held) return { kind: "stillWorking" };
    return { kind: "resume" };
  }
  // 4b. "Undo that" takes the last step back through Edit > Undo: the run
  // under way, whatever it is doing (an approval it is waiting on is not
  // answered by it), or the run that ended less than a minute ago. It sends
  // input, so speech needs the confidence the user's own words need, which
  // a recovered hypothesis that stood still long enough has; heard less
  // clearly, or long after any run, it is a correction or task the model
  // reads like any other.
  if (
    intent.kind === "undo" &&
    (typed || input.confidence >= APPROVAL_MIN_CONFIDENCE) &&
    (run || (input.lastRun && now - input.lastRun.endedAt <= UNDO_WINDOW_MS))
  )
    return { kind: "undo", words: typed ? text.trim() : cleanTaskText(text) };
  // 4c. "Scroll down" scrolls the window in front until the user says stop,
  // with no model call; a run under way pauses and waits for "continue".
  // While it scrolls, "faster", "slower", "scroll up" and "stop scrolling"
  // steer it, however faintly heard (ending or slowing a scroll is always
  // safe). Starting one sends input, so speech needs the user's-words floor;
  // heard less clearly, or asked from a phone with nobody at the screen, it
  // is the model's task as before. Steering words with nothing scrolling
  // correct the run under way ("stop scrolling" to a model that scrolls), or
  // have nothing to act on.
  if (intent.kind === "scroll" && !remote) {
    const request = scrollRequest(text)!;
    if (input.scrolling) return { kind: "scroll", request };
    if (request.act !== "start") {
      if (!run) return { kind: "nothingRunning" };
    } else if (typed || input.confidence >= APPROVAL_MIN_CONFIDENCE)
      return { kind: "scroll", request };
  }
  // The scroll's own window admits only its steering words and the control
  // words above; anything else that reached it (talk nearby) does nothing.
  if (source === "followup" && input.window === "scroll")
    return { kind: "acknowledge" };
  // 5. "How's it going?" is answered, with or without a run, and never
  // becomes a correction to the run.
  if (isStatusQuestion(text)) return { kind: "status" };
  // The user's own words carry their provenance: typed and texted words are
  // theirs; speech counts only when it was heard clearly enough to approve.
  const taskSource: TaskSource =
    typed || input.confidence >= APPROVAL_MIN_CONFIDENCE
      ? "user_words"
      : "user_words_unsure";
  // 6. "After that, …" waits for the current run. A queue request that is
  // only a fragment ("after that, open") is asked about like any fragment;
  // its answer is joined and routed below. Without a run it is a request
  // like any other, minus the queueing words (see route).
  const queue = (task: string): TurnPlan | undefined => {
    const queued = queueRequest(task);
    if (!queued || !run) return undefined;
    const question = !typed && clarifyFragment(queued);
    if (question) return { kind: "clarify", question, fragment: task.trim() };
    const text = typed ? queued : cleanTaskText(queued);
    return deicticTask(text) ? askWhatToDo(text) : { kind: "queue", text };
  };
  const route = (task: string): TurnPlan => {
    const later = queue(task);
    if (later) return later;
    task = typed ? task.trim() : cleanTaskText(queueRequest(task) ?? task);
    // 8–9. A correction or a new task. Fillers alone ("um uh") do nothing.
    if (!task || tokenize(task).every((w) => FILLERS.has(w)))
      return { kind: "acknowledge" };
    // Words that only point at another text ("do what she asked", "call the
    // number in the note") never start, queue or replace anything in the
    // user's name: the run would resolve "that" from the screen or a
    // notification, and whoever wrote it would speak with the user's voice.
    // A correction to a run under way stays one; it answers the run.
    const vague = deicticTask(task);
    // A run that stalled is waiting for a hint; a request about something
    // else entirely is the user moving on, not a hint. One waiting on an
    // approval is waiting for yes or no, which were handled above; a request
    // about something else is the user moving on.
    if (run?.stalled && startsNewTask(task, run.task))
      return vague ? askWhatToDo(task) : { kind: "replace", text: task };
    if (run) return { kind: "revise", text: task };
    return vague
      ? askWhatToDo(task)
      : { kind: "start", text: task, taskSource };
  };
  const later = queue(text);
  if (later) return later;
  // 7a. The spoken answer to a clarification question. Typed text is never
  // joined: text that repeats the fragment ("open Safari" after "Open")
  // already carries it, and anything else ("check my email") is its own
  // request, so both run exactly as typed below.
  const fragment = input.fragment;
  if (fragment && now < fragment.until && !typed) {
    const joined = joinUtterances(fragment.text, text);
    const question = clarifyFragment(joined);
    if (question) return { kind: "clarify", question, fragment: joined };
    if (joined) return route(joined);
  }
  // 7b. A fragment gets a question instead of a run or correction.
  if (!typed) {
    const question = clarifyFragment(text);
    if (question) return { kind: "clarify", question, fragment: text.trim() };
  }
  // 7c. "…and check the weather" before the run acted extends the task.
  const last = input.lastTurn;
  if (
    source === "followup" &&
    input.window === "continuation" &&
    run &&
    !pending &&
    last &&
    (last.plan === "start" || last.plan === "amendTask") &&
    last.runId === run.id &&
    run.actions === 0 &&
    now - last.endedAt <= CONTINUATION_WINDOW_MS + (input.turnMs ?? MAX_TURN_MS)
  )
    return {
      kind: "amendTask",
      text: joinUtterances(run.task, text, { keepFirst: true }),
    };
  return route(text);
}

// Words that begin a request, and words that carry no subject of their own.
const TASK_VERBS = new Set(
  "open go jump switch launch start write create make send search find play check show text email message call look set remind add draft reply read tell get put type book schedule order".split(
    " ",
  ),
);
const LEADING = new Set(
  "can could would will you please hey ok okay now also then and so just".split(
    " ",
  ),
);
const GLUE = new Set(
  "to and the a an for me my in on of with at up it this that please can you could would will i want like some by from into about".split(
    " ",
  ),
);
const CORRECTION =
  /\b(?:instead|actually|rather|i meant|i mean|not that|wrong)\b|^no\b/;
// Request verbs that are also things a request is about ("email", "text"):
// they start a request but still count as its subject.
const NOUN_VERBS = new Set([
  "email",
  "text",
  "message",
  "call",
  "book",
  "order",
]);
const stem = (word: string) =>
  word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word;
const subjectWords = (text: string) =>
  new Set(
    tokenize(text)
      .filter(
        (w) =>
          w.length >= 3 &&
          (!TASK_VERBS.has(w) || NOUN_VERBS.has(w)) &&
          !GLUE.has(w) &&
          !FILLERS.has(w) &&
          !STOP_WORDS.has(w),
      )
      .map(stem),
  );
/**
 * Whether a command to a stalled run is a new request rather than a hint for
 * it: it begins with a request verb, says nothing like "instead" or "actually",
 * names a subject of its own, and shares no subject with the stalled task. "Go
 * to Notes and write a note" is new while "play after hours" is stuck; "search
 * for after hours" or "use the search" is a hint.
 */
export function startsNewTask(text: string, task: string): boolean {
  const lowered = text.toLowerCase().trim();
  if (CORRECTION.test(lowered)) return false;
  const words = tokenize(lowered);
  const first = words.find((w) => !LEADING.has(w));
  if (!first || !TASK_VERBS.has(first)) return false;
  const mine = subjectWords(text);
  if (!mine.size) return false;
  const theirs = subjectWords(task);
  return ![...mine].some((word) => theirs.has(word));
}

// Words that point elsewhere -------------------------------------------------

const wordSet = (list: string) => new Set(list.split(/\s+/).filter(Boolean));

/**
 * Agreement, politeness, hedges and fillers, a few from other languages as
 * people mix them in ("sí, do it"): they say go ahead, never with what.
 */
const AGREEING = wordSet(`
  yes yeah yep yup ya yea yah yas aye sure ok okay okey oki okie kk alright right fine cool great good
  nice perfect sounds works absolutely definitely certainly totally course indeed gladly please pls plz
  thanks thank thx ty cheers lets let just well so oh hey now then also too really want wanna like need
  no nope actually instead rather maybe mind have think guess suppose reckon lol
  si sí oui ja da vale claro dale bueno haan acha achha theek hai
`);
/**
 * When, how and how often ("one more time"): never what to do.
 */
const MANNER = wordSet(`
  quick quickly fast asap immediately soon straight away today tonight tomorrow later first real
  properly carefully anyway anyways already behalf more once time times
`);
/**
 * What the user calls the assistant: hollow at the edge of an utterance
 * ("do it buddy"), a person in the middle or after "my" ("send that to my
 * boss").
 */
const VOCATIVES = wordSet("buddy mate dude man bro boss pal babe");
/** The user speaking for themselves: after a verb that sends, a message they dictate. */
const FIRST_PERSON = wordSet("i im ill id ive we were weve wed");
/** Verbs that stand in for an action named somewhere else. */
const PRO_VERBS = wordSet(`
  do does did doing done go going proceed handle take care deal carry follow act try make happen get
  finish complete repeat redo pick choose select hazlo haz mach fais
`);
/**
 * The stand-in verbs whose object is the whole request: "do that in
 * Chrome" still does whatever "that" was. Not "make" or "get": "make it
 * louder" and "get that file" say what they want.
 */
const STAND_INS = wordSet(`
  do does doing done go going proceed handle handling take deal carry follow act try repeat redo finish
  complete hazlo haz mach fais
`);
/** Words between a stand-in verb and its object: "go ahead with", "take care of". */
const STAND_IN_PARTICLES = wordSet(
  "for with ahead care of out up on along through me us just please now then",
);
/** Words that end an object: what follows says where, when or how. */
const OBJECT_ENDS = wordSet(`
  in on at from with for to by via using and then but so or before after when once while until because
  if as through into onto over under about like
`);
/**
 * Words that point at something said or shown elsewhere, among them the
 * answers to a menu ("the second option", "option two") and the clitics
 * other languages hang on a verb ("envoie-le", "schick es").
 */
const POINTERS = wordSet(`
  that thats it this those these them what whats whatever whatevers which whichever whoever whomever
  wherever same again one ones thing things stuff so such before earlier above last latest previous
  something anything everything there here
  first second third fourth fifth sixth seventh eighth ninth tenth two three four five six seven
  eight nine ten
  eso esto das es ça cela lo la le les los las
`);
/** People named only by a pronoun: whoever the other text came from. */
const PERSONS = wordSet(
  "she shes he hes they theyre her him them his hers their theirs someone somebody",
);
/** Verbs that report what another text says, asks for or carries. */
const REPORTED = wordSet(`
  asked asks said says told tells wanted wants requested requests suggested suggests mentioned mentions
  wrote writes written sent sends meant means needed needs listed lists showed shows gave gives left
  shared posted forwarded texted emailed messaged provided included attached
`);
/**
 * Things whose value is written somewhere else and would be the run's input:
 * which number to call, which link to open, which code to enter.
 */
const VALUES = wordSet(`
  number numbers address addresses link links url urls code codes amount amounts account accounts
  details info information instructions steps contact money funds
`);
/**
 * Things another text proposes, shown on the screen as they are: which
 * invite, which button, which update. Acted on, they are what the user
 * sees, so a verb the user names with one of them for its object is a task
 * on the screen (deicticTask); named alone they still point elsewhere.
 */
const PROPOSED = wordSet(`
  request requests suggestion suggestions task tasks plan option options choice choices button buttons
  item items invite invitation invitations transaction transactions transfer transfers booking bookings
  attachment attachments installer installers update updates payment
`);
const REFERENTS = new Set([...VALUES, ...PROPOSED]);
/**
 * Pointers at a thing on the screen: the words for things ("that", "them",
 * "this one"), a place in what is shown ("the second one", "the last one")
 * and the proposed things above. Never a person, a report of another text
 * or a value: those name whoever or whatever the other text says.
 */
const THINGS = new Set([
  ...wordSet(`
    that thats it this those these them one ones thing things stuff something anything everything
    same again before earlier above last latest previous
    first second third fourth fifth sixth seventh eighth ninth tenth two three four five six seven
    eight nine ten
  `),
  ...PROPOSED,
]);
/** Where on the screen ("paste it here"): neither a thing nor another text. */
const PLACES = wordSet("here there");
/** "My number" is the user's own, not another text's. */
const OWNED = wordSet("my our");
/** Function words: no request of their own. */
const FUNCTION_WORDS = wordSet(`
  the a an to for of with at on in from about by into out through as is be me my you your i im ill id
  ive us our we its and or ahead according all both can could would will should shall must might may
  gotta
`);
/**
 * Verbs whose object decides what they do to the world: sending, calling,
 * paying, installing, deleting, agreeing, pressing, signing in, giving out.
 * With only a pointer for an object ("send that", "call her back"), or none
 * at all ("go ahead and accept"), the other text decides. A few from other
 * languages, with the clitic people attach ("envíalo").
 */
const CONSEQUENTIAL = wordSet(`
  send forward reply respond answer call dial ring phone text message email mail dm ping pay transfer
  wire venmo buy purchase order book install download upload run execute delete remove erase trash
  approve accept confirm sign submit share post publish invite schedule click press tap
  give tell enter type paste agree authorize authorise allow permit enable disable activate
  deactivate unlock verify validate authenticate login log signin join add uninstall wipe reset
  format clear grant renew subscribe unsubscribe donate tip checkout
  envía envia envíalo envialo envíala enviala envíaselo manda mándalo mandalo mándala llama llámalo
  llamalo llámala llámale paga págalo pagalo págala envoie appelle paie réponds reponds schick
  schicke sende ruf zahl bezahl antworte
`);
/**
 * The verbs among them that take a message the user dictates: "text her
 * that I'm on my way", "reply that works".
 */
const CLAUSE_VERBS = wordSet("reply respond answer text message tell email dm");
/**
 * Verbs whose "them" is whoever the other text is from ("pay them", "text
 * them yes"); after any other verb "them" is things ("delete them all").
 */
const RECIPIENT_VERBS = new Set([
  ...CLAUSE_VERBS,
  ...wordSet("call dial ring phone ping pay venmo give invite tip"),
]);
/** Prepositions that make the pronoun after them a recipient: "send it to them". */
const RECIPIENT_LEADS = wordSet("to for with");
/**
 * Looking and opening: their pointers are theirs to keep ("open it", "play
 * that again"), unless a verb that sends or signs follows ("open the link
 * and sign in").
 */
const LOOKING = wordSet(`
  open launch play show read look watch listen see view find search check visit browse preview
`);
/** Words a second verb follows: "open the link and sign in". */
const JOINERS = wordSet("and then or also");
/** Particles that finish such a verb: "call her back", "send it over". */
const PARTICLES = wordSet("back up over along off on in out");
/** "In the note", "on the screen": where another text lives. */
const SOURCE_LEADS = wordSet(
  "in on at from inside within under per off according",
);
const SOURCE_DETS = wordSet(
  "to the this that these those my your his her their its a an",
);
const SOURCE_KINDS = wordSet(
  "last latest new newest recent previous first same other top pinned",
);
const SOURCES = wordSet(`
  note notes message messages msg email emails mail text texts notification notifications screen page
  doc docs document documents file files chat chats thread dm dms banner alert alerts popup window tab
  reminder reminders invite invitation post comment comments letter pdf attachment voicemail card inbox
  conversation
`);
/** "What Dana asked", "the number Sam sent": a report of another text. */
const REPORT_LEADS = new Set([
  ...wordSet("what whatever as like thing things stuff one ones"),
  ...REFERENTS,
]);
/** Requests put as questions: "why don't you …", "how about …". */
const ASKING_FRAMES = [
  ["why", "dont", "you"],
  ["why", "not"],
  ["how", "about"],
  ["what", "about"],
];
const QUESTION_WORDS = wordSet("what who whom whose where when why how which");
const QUESTION_CONTRACTIONS = wordSet("whats whos wheres whens whys hows");
const AUXILIARIES = wordSet(`
  is are am was were do does did can could would will should shall has have had isnt arent wasnt
  werent doesnt didnt cant couldnt wont wouldnt shouldnt hasnt havent
`);
const POLITE = wordSet("can could would will");
const ASKED_ABOUT = wordSet("i we they he she it you that this there");
const ASKED_BY_DO = wordSet("i we they he she");

/**
 * Whether words ask rather than tell: "what's that?", "did she reply?",
 * "who is she?", "should I approve it?". "Can you do that" and "what she
 * asked" are requests; "do that" is an imperative.
 */
function asksQuestion([first, second = ""]: string[]): boolean {
  if (QUESTION_CONTRACTIONS.has(first)) return true;
  if (QUESTION_WORDS.has(first)) return AUXILIARIES.has(second);
  if (!AUXILIARIES.has(first)) return false;
  if (POLITE.has(first) && second === "you") return false;
  // "Do you mind …" is a request; "do it" and "do what …" are imperatives.
  if (first === "do") return ASKED_BY_DO.has(second);
  // "Have you …?", but "have at it".
  if (first === "have" || first === "has" || first === "had")
    return ASKED_ABOUT.has(second);
  return true;
}

/**
 * Marks the words that name another text: "in the note", "what Dana asked",
 * and with `referents` a thing whose value is written there ("the number").
 */
function pointsAt(words: string[], referents = true): boolean[] {
  const elsewhere = words.map(() => false);
  for (let i = 0; i < words.length; i++) {
    if (!SOURCE_LEADS.has(words[i])) continue;
    let j = i + 1;
    while (j < words.length && SOURCE_DETS.has(words[j])) j++;
    while (j < words.length && SOURCE_KINDS.has(words[j])) j++;
    if (j < words.length && SOURCES.has(words[j]))
      for (let k = i; k <= j; k++) elsewhere[k] = true;
  }
  // Whoever wrote the other text: one name at most between the lead and the
  // report ("what Dana asked", "what my boss said"), never a thing of the
  // user's own ("all the photos she sent" keeps its photos).
  for (let i = 0; i < words.length; i++) {
    if (!REPORT_LEADS.has(words[i])) continue;
    const j = words.findIndex((w, at) => at > i && REPORTED.has(w));
    if (j === -1 || j - i > 3) continue;
    const named = words
      .slice(i + 1, j)
      .filter(
        (w) =>
          !PERSONS.has(w) &&
          !SOURCE_DETS.has(w) &&
          !SOURCES.has(w) &&
          !POINTERS.has(w),
      ).length;
    if (named <= 1) for (let k = i + 1; k < j; k++) elsewhere[k] = true;
  }
  return words.map(
    (word, i) =>
      elsewhere[i] ||
      POINTERS.has(word) ||
      PERSONS.has(word) ||
      REPORTED.has(word) ||
      (referents && REFERENTS.has(word) && !OWNED.has(words[i - 1] ?? "")),
  );
}

/** Whether the word at `i` says nothing of its own. */
function hollowAt(words: string[], i: number): boolean {
  const word = words[i];
  return (
    AGREEING.has(word) ||
    MANNER.has(word) ||
    PRO_VERBS.has(word) ||
    FUNCTION_WORDS.has(word) ||
    (VOCATIVES.has(word) &&
      (i === 0 || i === words.length - 1) &&
      !OWNED.has(words[i - 1] ?? ""))
  );
}

/**
 * A stand-in verb whose object only points ("do that in Chrome", "take care
 * of what she sent for me"): whatever follows the object says where or
 * when, never what.
 */
function standInPoints(words: string[], points: boolean[]): boolean {
  for (let i = 0; i < words.length; i++) {
    if (!STAND_INS.has(words[i])) continue;
    let j = i + 1;
    while (j < words.length && STAND_IN_PARTICLES.has(words[j])) j++;
    let pointed = false;
    let hollow = j < words.length;
    for (
      ;
      j < words.length && !(OBJECT_ENDS.has(words[j]) && !points[j]);
      j++
    ) {
      if (points[j]) pointed = true;
      else if (!hollowAt(words, j)) hollow = false;
    }
    if (pointed && hollow) return true;
  }
  return false;
}

/** The words before a noun: "the email", "that text", "my last message". */
const OBJECT_DETS = new Set([...SOURCE_DETS, ...SOURCE_KINDS, ...OWNED]);

/**
 * Whether a task's words only point at something said or shown elsewhere:
 * nothing but agreement, a stand-in verb and pointers ("sure, go for it",
 * "okay do what she asked", "yeah do that", "do it again", "the second
 * option"), a stand-in verb whose object only points ("do what it says in
 * Chrome", "pick the first one"), or a verb that sends, pays, installs,
 * deletes, agrees or signs in with nothing for an object ("go ahead and
 * accept", "reply yes", "call back", "click ok") or with only what another
 * text names: whoever it is from ("call her back", "send it to her", "text
 * them yes") or a value written in it ("call the number in the note",
 * "enter the code", "wire the money"). Such words carry no task: a run
 * would take its substance from the screen, a notification or whatever the
 * assistant last read out, in the user's name.
 *
 * One word of the user's own (an app, a name, a thing, a message they
 * dictate) makes it a task: "do the dishes list in Notes", "open that
 * folder called Taxes", "text her that I'm late", "text Dana yes", "reply
 * to that email" (the email is the thing, not a verb). With `screen`, so
 * does a verb the user names with a thing on the screen for its object
 * ("send that", "delete this", "accept the invite", "reply yes to that",
 * "click the button", "delete the second one"): the user is pointing at
 * what they see, the runner sees the same frame, and its policy asks before
 * the step that sends, pays or deletes. The allowance is for the user's own
 * words; a model rewrite (`screen` false) gets none, since the model never
 * saw the screen and may have taken the thing from a text it was shown.
 * Looking and opening verbs keep their pointers ("play that again", "open
 * it"): they cannot send or spend on another text's say-so, unless such a
 * verb follows them ("open the link and sign in"). Questions ("what's
 * that?", "did she call?") ask rather than tell.
 */
export function deicticTask(text: string, screen = true): boolean {
  let words = keyParts(text).key;
  const frame = ASKING_FRAMES.find((f) => f.every((w, i) => words[i] === w));
  if (frame) words = words.slice(frame.length);
  else if (asksQuestion(words)) return false;
  if (!words.length) return false;
  const points = pointsAt(words);
  if (standInPoints(words, points)) return true;
  let verb: string | undefined;
  let verbAt = -1;
  let looking = false;
  /** A pointer at a thing on the screen, and one at what another text names. */
  let thing = false;
  let elsewhere = false;
  for (const [i, word] of words.entries()) {
    const prev = words[i - 1] ?? "";
    // After a verb that takes a message, "that" begins the message the
    // user dictates ("reply that works", "text her that I'm on my way"),
    // unless the message itself only points ("reply that to them").
    if (
      verb &&
      CLAUSE_VERBS.has(verb) &&
      (word === "that" || word === "thats") &&
      (i - 1 === verbAt || PERSONS.has(prev)) &&
      i + 1 < words.length &&
      !points.slice(i + 1).some(Boolean)
    )
      return false;
    if (points[i]) {
      if (PLACES.has(word)) continue;
      // "Her" before a thing ("accept her invite") is its determiner, not
      // a person; "them" is people only after a verb or a preposition that
      // takes a recipient ("pay them", "send it to them").
      if (
        PERSONS.has(word) &&
        OBJECT_DETS.has(word) &&
        REFERENTS.has(words[i + 1] ?? "")
      )
        continue;
      const recipient =
        word === "them" &&
        ((!!verb && RECIPIENT_VERBS.has(verb)) || RECIPIENT_LEADS.has(prev));
      if (THINGS.has(word) && !recipient) thing = true;
      else elsewhere = true;
      continue;
    }
    if (CONSEQUENTIAL.has(word)) {
      // The first verb, one joined to it ("open the link and sign in") or
      // the button it names ("click allow", "press accept"). After a verb,
      // "email", "text", "call" and the like following "the", "that" or
      // "my" are the thing acted on: the user's own word.
      if (
        (!verb && !looking && !OBJECT_DETS.has(prev)) ||
        JOINERS.has(prev) ||
        i - 1 === verbAt
      ) {
        verb = word;
        verbAt = i;
        continue;
      }
      return false;
    }
    if (!verb && LOOKING.has(word)) {
      looking = true;
      continue;
    }
    if (verb && CLAUSE_VERBS.has(verb) && FIRST_PERSON.has(word)) return false;
    if (verb && PARTICLES.has(word)) continue;
    if (hollowAt(words, i)) continue;
    return false;
  }
  // A verb that sends with nothing for an object, or only what another text
  // names, is as vague as agreement alone, which points at whatever was
  // said last; with a thing on the screen for its object it is the user's
  // task on that thing. Looking verbs keep their pointers.
  if (verb) return !(screen && thing && !elsewhere);
  return !looking;
}

/**
 * Whether words point at something said or shown elsewhere at all: a
 * pointer, a pronoun for a person, a report of another text and, with
 * `referents`, a thing whose value is written elsewhere ("the link"). A
 * task resolved from a pointer ("do that") may not keep one ("send it to
 * them in Safari"), though it may name a thing whose value it gives or is
 * offered for ("wire $900 to account 55440011"); "again" only repeats a
 * task the words name in full.
 */
export function pointsElsewhere(text: string, referents = true): boolean {
  const words = keyParts(text).key.filter((w) => w !== "again");
  return pointsAt(words, referents).some(Boolean);
}

/**
 * The question for words that name no task (deicticTask). The answer stands
 * alone: it is never joined to words that pointed elsewhere.
 */
export function askWhatToDo(words: string): TurnPlan {
  return {
    kind: "clarify",
    question: PHRASES.whatToDo[0],
    fragment: "",
    words,
  };
}

/**
 * A phrase that lets go of a task, on its own: at the end of the words or
 * before a pause or a joining word ("forget that, …", "never mind and …").
 * "Skip this song" and "book something else for Friday" name an object.
 */
const LETS_GO = new RegExp(
  `(?:^|[\\s,;:.!?—-])(?:${[
    "forget (?:about )?(?:it|that|this)",
    "never ?mind",
    "(?:scrap|drop|ditch|abandon|skip) (?:it|that|this)",
    "(?:stop|cancel|end) (?:it|that|this|the task)",
    "something else|(?:a )?change of plans?|start over",
  ].join(
    "|",
  )})(?=\\s*$|\\s*[,;:.!?—-]|\\s+(?:and|instead|actually|just|now|lets|let)\\b)`,
);
const INSTEAD = /\b(?:instead|rather)\b/;
/**
 * Whether the user's own words let go of the task they had under way
 * ("forget that, instead …", "never mind, …", "start over"), or ask for a
 * different one in its place ("read the note instead" while a song was
 * stuck). Only then may the model's reading that they moved on end a run
 * they paused. "Use the search instead" is a hint to that run, and "I'd
 * rather use Chrome" a preference: neither lets go of anything.
 */
export function dropsCurrentTask(text: string, task = ""): boolean {
  const lowered = text.toLowerCase().replace(/['’]/g, "");
  if (LETS_GO.test(lowered)) return true;
  if (!task || !INSTEAD.test(lowered)) return false;
  return startsNewTask(lowered.replace(new RegExp(INSTEAD, "g"), " "), task);
}

/** Whether the words hold a verb that sends, spends, installs, deletes or agrees. */
export function consequentialVerb(text: string): boolean {
  return keyParts(text).key.some((w) => CONSEQUENTIAL.has(w));
}
