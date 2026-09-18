/**
 * Pure language rules for spoken turns: normalization, intents, how finished
 * an utterance looks, fragment questions, and the per-turn routing plan that
 * electron/main.ts executes. The stop/pause and completeness rules mirror
 * native/macos (normalizeVoiceKey, isControlPhrase, utteranceCompleteness);
 * tests/fixtures/voice-phrases.json pins both sides.
 */
import type { FollowUpKind } from "./router";
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
export type TurnContext = "command" | "answer" | "approval" | "continuation";

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

export type VoiceSource = "ptt" | "wake" | "followup" | "text";
export type NeedClickReason = "confidence" | "gate" | "restricted";
export type TurnPlan =
  | { kind: "stop" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "approve" }
  | { kind: "decline" }
  | { kind: "confirmAgain" }
  | { kind: "needClick"; reason: NeedClickReason }
  | { kind: "nothingToApprove" }
  | { kind: "nothingRunning" }
  | { kind: "stillWorking" }
  | { kind: "acknowledge" }
  | { kind: "clarify"; question: string; fragment: string }
  | { kind: "amendTask"; text: string }
  | { kind: "revise"; text: string }
  | { kind: "start"; text: string }
  // A new, unrelated request while the current run is stalled or paused: stop
  // that run and start this one instead of treating it as a correction.
  | { kind: "replace"; text: string };
export type TurnPlanKind = TurnPlan["kind"];

export interface VoiceTurnRun {
  id: string;
  status: string;
  actions: number;
  /** Paused or in takeover (main.ts runHeld). */
  held: boolean;
  /** The policy question while an approval is pending. */
  pendingReason?: string;
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
  /** Recognizer segments merged into this turn; more than one never approves. */
  segments?: number;
  /** Milliseconds from follow-up detection to this final. */
  turnMs?: number;
  /** The approval captured when listening started still matches. */
  gateMatches: boolean;
  now: number;
  run?: VoiceTurnRun;
  fragment?: VoiceFragment;
  lastTurn?: VoiceLastTurn;
}

export const APPROVAL_MIN_CONFIDENCE = 0.65;
export const FOLLOW_UP_APPROVAL_MIN_CONFIDENCE = 0.75;
export const CONTINUATION_WINDOW_MS = 3000;
export const MAX_TURN_MS = 45000;
const TERMINAL = new Set(["completed", "cancelled", "failed"]);

/**
 * Decides what a finished turn does. Pure: main.ts executes the plan and then
 * calls Conversation.acknowledge(plan).
 */
/** A turn that is only the wake phrase, or a misheard echo of it ("Hey sis"). */
export function isWakePhraseOnly(text: string): boolean {
  return /^(?:(?:hey|hay|hi|his|a)\s+)?(?:open\s+)?(?:assist(?:ant|s)?|a\s?sis|sis|cyst)$/.test(
    intentKey(text),
  );
}

export function planVoiceTurn(input: VoiceTurnInput): TurnPlan {
  const { text, source, now } = input;
  // "Hey Assist" alone never becomes a task, correction or answer.
  if (source !== "text" && isWakePhraseOnly(text))
    return { kind: "acknowledge" };
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
    if (!run || !pending) return { kind: "nothingToApprove" };
    if (source === "text") return { kind: intent.kind };
    const confidence = (input.segments ?? 1) > 1 ? 0 : input.confidence;
    const minimum =
      source === "followup"
        ? FOLLOW_UP_APPROVAL_MIN_CONFIDENCE
        : APPROVAL_MIN_CONFIDENCE;
    const confident =
      Number.isFinite(confidence) && confidence > 0 && confidence >= minimum;
    // Declining only pauses, so it needs no gate; an uncertain "no" is asked
    // again rather than sent to the Yes button.
    if (intent.kind === "decline")
      return confident ? { kind: "decline" } : { kind: "confirmAgain" };
    if (!(confidence > 0)) return { kind: "needClick", reason: "confidence" };
    if (!input.gateMatches) return { kind: "needClick", reason: "gate" };
    if (!confident) return { kind: "needClick", reason: "confidence" };
    if (source === "followup" && !followUpApprovalAllowed(run.pendingReason))
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
  // 5. The spoken answer to a clarification question. Typed text is never
  // joined: text that repeats the fragment ("open Safari" after "Open")
  // already carries it, and anything else ("check my email") is its own
  // request, so both run exactly as typed below.
  const fragment = input.fragment;
  if (fragment && now < fragment.until && source !== "text") {
    const joined = joinUtterances(fragment.text, text);
    const question = clarifyFragment(joined);
    if (question) return { kind: "clarify", question, fragment: joined };
    if (joined)
      return run
        ? { kind: "revise", text: joined }
        : { kind: "start", text: joined };
  }
  // 6. A fragment gets a question instead of a run or correction.
  if (source !== "text") {
    const question = clarifyFragment(text);
    if (question) return { kind: "clarify", question, fragment: text.trim() };
  }
  // 7. "…and check the weather" before the run acted extends the task.
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
  // 8–9. A correction or a new task. Typed text runs exactly as typed; only
  // speech is cleaned. Fillers alone ("um uh") do nothing.
  const task = source === "text" ? text.trim() : cleanTaskText(text);
  if (!task || tokenize(task).every((w) => FILLERS.has(w)))
    return { kind: "acknowledge" };
  // A run that stalled is waiting for a hint; a request about something else
  // entirely is the user moving on, not a hint.
  // One waiting on an approval is waiting for yes or no, which were handled
  // above; a request about something else is the user moving on.
  if (run?.stalled && startsNewTask(task, run.task))
    return { kind: "replace", text: task };
  return run ? { kind: "revise", text: task } : { kind: "start", text: task };
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
