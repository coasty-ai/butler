/**
 * Turns run text (summaries, questions, pause reasons, policy questions) into
 * something safe to say out loud: short, no credentials, no full URLs or
 * paths, no coordinates or typed text, never the wake word, and never a
 * sentence the voice routers would act on.
 */
import type { Action } from "../core/schema";
import { redactSecrets } from "../core/sanitize";
import {
  WAKE_HEY,
  WAKE_NAME,
  intentKey,
  voiceIntent,
  type VoiceIntentKind,
} from "./turns";

const ACTIONABLE: ReadonlySet<VoiceIntentKind> = new Set([
  "stop",
  "pause",
  "resume",
  "undo",
  "scroll",
  "approve",
  "decline",
]);
const QUOTES = /["“”«»‘]|(?<!\p{L})['’]|['’](?!\p{L})/gu;
/**
 * "Hey Butler" in any spelling the wake matcher accepts, whatever follows it: the
 * assistant never says it, even where the listener's gate would not wake.
 */
const WAKE_PHRASE_SOURCE = String.raw`\b${WAKE_HEY}[\s,]+${WAKE_NAME}(?![a-z])`;
const WAKE_PHRASE = new RegExp(WAKE_PHRASE_SOURCE, "iu");
const WAKE_PHRASE_ALL = new RegExp(
  WAKE_PHRASE_SOURCE + String.raw`[\s,.:;!?]*`,
  "giu",
);
const LINK_END = /[.,;:!?)\]]+$/;

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const LINK_REST = String.raw`[^\s<>"“”‘’]*`;
/** A bare host, localhost or IPv4 address followed by a port or a path. */
const HOST_PORT_OR_PATH = new RegExp(
  String.raw`\b((?:[a-z0-9-]+\.)+[a-z]{2,}|localhost|\d{1,3}(?:\.\d{1,3}){3})` +
    String.raw`(?::\d{1,5}(?![\d.]*\d)(?:\/${LINK_REST})?|\/${LINK_REST})`,
  "gi",
);

function hostOf(url: string): string {
  const trail = url.match(LINK_END)?.[0] ?? "";
  const bare = trail ? url.slice(0, -trail.length) : url;
  try {
    const host = new URL(SCHEME.test(bare) ? bare : `http://${bare}`).hostname;
    // IPv6 literals ("[::1]") are not worth reading out.
    const site = host.startsWith("[") ? "" : host.replace(/^www\./i, "");
    return (site || "a link") + trail;
  } catch {
    return "a link" + trail;
  }
}

function baseName(path: string): string {
  const trail = path.match(/[.,;:!?)]+$/)?.[0] ?? "";
  const bare = (trail ? path.slice(0, -trail.length) : path).replace(
    /\/+$/,
    "",
  );
  const name = bare.split("/").filter(Boolean).pop();
  return (name && name !== "~" ? name : "your home folder") + trail;
}

/** "file:///Users/me/My%20Taxes.pdf" → "My Taxes.pdf". */
function fileLinkName(url: string): string {
  const path = url.replace(/^file:\/\/[^/\s]*/i, "").replace(/[?#].*$/, "");
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    /* Keep the raw name. */
  }
  return baseName(decoded || "/");
}

/**
 * Whether "a/b" is a relative path rather than prose ("24/7", "and/or",
 * "12/25/2025"): it has letters and a leading "./", three or more parts, a
 * file extension, or a trailing slash.
 */
function relativePath(path: string): boolean {
  const bare = path.replace(/[.,;:!?)]+$/, "");
  const parts = bare.split("/").filter(Boolean);
  return (
    /\p{L}/u.test(bare) &&
    parts.length >= 2 &&
    (/^\.{1,2}\//.test(bare) ||
      parts.length >= 3 ||
      /\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(parts.at(-1)!) ||
      bare.endsWith("/"))
  );
}

/** Replaces matches, capitalized when they start a sentence. */
function swap(
  text: string,
  pattern: RegExp,
  replacement: (group: string) => string,
): string {
  return text.replace(pattern, (...args) => {
    const [, group] = args;
    const offset = args.at(-2) as number;
    const value = replacement(typeof group === "string" ? group : "");
    return offset === 0 || /[.!?]\s*$/.test(text.slice(0, offset))
      ? value[0].toUpperCase() + value.slice(1)
      : value;
  });
}

function clean(text: string): string {
  let s = text.replace(/[\u0000-\u001f\u007f]+/g, " ");
  // Links: keep the site only, or the file name of a file link.
  s = s.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"“”‘’]*/gi, (link) =>
    /^file:/i.test(link) ? fileLinkName(link) : hostOf(link),
  );
  s = s.replace(/\bwww\.[^\s<>"“”‘’]+/gi, hostOf);
  // Bare hosts, localhost and IP addresses: drop the port and the path.
  s = s.replace(
    HOST_PORT_OR_PATH,
    (link, host: string) => host + (link.match(LINK_END)?.[0] ?? ""),
  );
  // Paths: keep the file or folder name only.
  s = s.replace(
    /(^|[\s("“‘'])(~?\/[^\s/"“”‘’)]+(?:\/[^\s"“”‘’)]*)*)/g,
    (_, lead: string, path: string) => lead + baseName(path),
  );
  s = s.replace(
    /(^|[\s("“‘'])((?:\.{1,2}\/)?[^\s/"“”‘’()<>]+(?:\/[^\s/"“”‘’()<>]+)+\/?)/g,
    (match, lead: string, path: string) =>
      relativePath(path) ? lead + baseName(path) : match,
  );
  // Phone and account numbers, then any long digit run.
  s = s.replace(/(?<![\w-])\+?\(?\d[\d ()-]{7,}\d(?![\w-])/g, (m) =>
    m.replace(/\D/g, "").length >= 9 ? "a number" : m,
  );
  s = s.replace(/\d{7,}/g, "a number");
  // Coordinates.
  s = s.replace(/\s*\(\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*\)/g, "");
  s = s.replace(/\b[xy]\s*[=:]\s*-?\d+(?:\.\d+)?,?/gi, "");
  s = s.replace(
    /\s*\bat \d+% across,? \d+% down(?: the selected screen)?/gi,
    "",
  );
  // Symbols the synthesizer reads badly.
  s = s
    .replace(/⌥/g, " Option ")
    .replace(/⌘/g, " Command ")
    .replace(/⇧/g, " Shift ")
    .replace(/⌃/g, " Control ")
    .replace(/↩/g, " Return ")
    .replace(/…/g, ".")
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(QUOTES, "");
  // Never the wake phrase itself. The product name ("I'm Butler") is fine:
  // listening pauses while replies play, and the wake phrase must start an
  // utterance with "hey". The name is never respelled for the ear here: this
  // text also goes to iMessage and the phone, where it must read Butler.
  s = s.replace(WAKE_PHRASE_ALL, "");
  return s
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/([,;:])(?=[.!?])/g, "")
    .replace(/,\s*,/g, ",")
    .replace(/\s+/g, " ")
    .replace(/^[\s,;:.]+/, "")
    .trim();
}

const ABBREVIATIONS = new Set([
  "mr",
  "mrs",
  "ms",
  "dr",
  "st",
  "vs",
  "etc",
  "inc",
  "ltd",
  "jr",
  "sr",
  "e.g",
  "i.e",
  "approx",
]);
/**
 * The sentences that have certainly ended: . ! ? followed by whitespace,
 * except after an initial or initialism ("Y.C.", "U.S.") or a common
 * abbreviation ("Dr.", "e.g."). `rest` is whatever is still being written,
 * so a streaming reply can be spoken sentence by sentence while the model is
 * still producing the next one.
 */
export function completeSentences(text: string): {
  done: string[];
  rest: string;
} {
  const done: string[] = [];
  let start = 0;
  const boundary = /[.!?]+\s+/g;
  for (let m = boundary.exec(text); m; m = boundary.exec(text)) {
    const before = text.slice(start, m.index + 1);
    const lastWord = (before.match(/(\S+)$/)?.[1] ?? "").toLowerCase();
    const bare = lastWord.replace(/[.!?]+$/, "");
    if (
      m[0].startsWith(".") &&
      (/^(?:[a-z]\.)*[a-z]$/.test(bare) || ABBREVIATIONS.has(bare))
    )
      continue;
    done.push(text.slice(start, m.index + m[0].trimEnd().length));
    start = m.index + m[0].length;
  }
  return { done, rest: text.slice(start) };
}

/** Sentences split as completeSentences does, the unfinished tail included. */
export function splitSentences(text: string): string[] {
  const { done, rest } = completeSentences(text);
  if (rest) done.push(rest);
  return done;
}

function speakable(
  text: string | undefined,
  max: number,
  sentences: number,
): string | undefined {
  if (!text?.trim()) return undefined;
  // Anything credential-like makes the whole text unspeakable.
  if (redactSecrets(text) !== text) return undefined;
  const cleaned = clean(text);
  if (!cleaned) return undefined;
  const parts = splitSentences(cleaned)
    .map((p) => p.trim())
    .filter((p) => p && !ACTIONABLE.has(voiceIntent(p).kind));
  if (!parts.length || parts[0].length > max) return undefined;
  let out = parts[0];
  for (const part of parts.slice(1, sentences)) {
    if (out.length + 1 + part.length > max) break;
    out += " " + part;
  }
  return out;
}

/** At most two sentences within `max` characters, or undefined. */
export function speakableText(
  text: string | undefined,
  max = 140,
): string | undefined {
  return speakable(text, max, 2);
}

const TYPED_CONTENT =
  /\b(?:typed|typing|entered|entering|pasted|pasting|wrote|written|filled (?:in|out)|filling (?:in|out))\b/i;
const QUOTED_CONTENT =
  /["“”«»]|(?<![\p{L}\p{N}])['‘][^'’\n]*['’](?![\p{L}\p{N}])/u;

/**
 * The first sentence of a run summary, up to 120 characters (or as many
 * sentences and characters as asked for). A summary about typed or entered
 * text, or with anything quoted, is never read aloud: the generic done
 * phrase is used instead.
 */
export function speakableSummary(
  summary: string | undefined,
  max = 120,
  sentences = 1,
): string | undefined {
  if (
    summary &&
    (TYPED_CONTENT.test(summary) ||
      QUOTED_CONTENT.test(summary) ||
      ASKS_FOR_SECRET.test(summary))
  )
    return undefined;
  return speakable(summary, max, sentences);
}

/**
 * A progress line built from screen or panel text, under the reply rules:
 * every sentence must pass speakableSentence, or the whole line is dropped
 * (a coaching or phishing sentence never rides in on a harmless first one).
 */
export function speakableReport(
  text: string | undefined,
  max = 220,
  sentences = 2,
): string | undefined {
  if (!text?.trim() || containsSecret(text)) return undefined;
  const parts: string[] = [];
  for (const part of splitSentences(text.replace(/\s+/g, " ").trim())) {
    if (!part.trim()) continue;
    const clean = speakableSentence(part, max);
    if (!clean) return undefined;
    parts.push(clean);
  }
  if (!parts.length) return undefined;
  let out = parts[0];
  for (const part of parts.slice(1, sentences)) {
    if (out.length + 1 + part.length > max) break;
    out += " " + part;
  }
  return out;
}

/**
 * Generated replies that tell the user how to answer, or claim an approval
 * happened. Approvals are asked by the run's own gated question, never by
 * the dialog model, so a reply that coaches "say yes" or "click Allow" is
 * dropped whole.
 */
export const REPLY_FORBIDDEN =
  /\b(?:say|text|reply|answer)\s+(?:yes|no|yeah|continue|stop|go ahead)\b|\bclick\s+(?:yes|allow|approve|accept|confirm)\b|\b(?:approve|confirm)\s+(?:it|this|that)\b|\bi(?:['’]ve| have)\s+approved\b/i;

/**
 * Lines that ask the user for a credential or a code, or to sign in: the
 * assistant never needs one, so such a line came from a page, a panel or a
 * notification the model echoed. Dropped whole wherever generated or
 * summarized text is read out (replies, progress lines, done lines).
 */
export const ASKS_FOR_SECRET =
  /\b(?:enter|type|input|send|text|share|provide|give|tell|paste|confirm|verify|reply with|respond with)\b[^.!?]{0,60}?\b(?:passwords?|passcodes?|passphrases?|pins?|(?:verification|one[- ]time|security|2fa|login|sign[- ]in|auth(?:entication)?)\s+codes?)\b|\bsign(?:ing)? in with\b/i;

/** Whether the text carries anything credential-like. */
export function containsSecret(text: string): boolean {
  return redactSecrets(text) !== text;
}

/** Markdown the model may slip in despite the prompt; the voice reads words. */
function stripMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]+/g, "")
    .replace(/^\s*(?:#{1,6}\s+|[-•]\s+|\d+[.)]\s+)/g, "");
}

/**
 * One generated sentence, made safe to say: cleaned like run text, dropped
 * whole when it carries a credential, an actionable phrase (a router would
 * act on "Go ahead." echoed back) or a REPLY_FORBIDDEN phrase, and cut at a
 * comma or space when it runs past `max`. Every spoken model sentence goes
 * through here; nothing else reaches the voice.
 */
export function speakableSentence(
  sentence: string,
  max = 180,
): string | undefined {
  if (!sentence?.trim() || containsSecret(sentence)) return undefined;
  // A generated line carrying the wake phrase was not written for the
  // user: it is dropped whole rather than read out with the phrase cut.
  if (WAKE_PHRASE.test(sentence)) return undefined;
  let s = clean(stripMarkdown(sentence));
  if (
    !s ||
    ACTIONABLE.has(voiceIntent(s).kind) ||
    REPLY_FORBIDDEN.test(s) ||
    ASKS_FOR_SECRET.test(s)
  )
    return undefined;
  // "Sure, the meeting is at four." keeps its substance; "Sure, go ahead."
  // has none left once the leading answer word goes.
  for (;;) {
    const comma = s.indexOf(",");
    if (comma <= 0) break;
    const lead = voiceIntent(s.slice(0, comma)).kind;
    if (!ACTIONABLE.has(lead) && lead !== "acknowledge") break;
    s = s.slice(comma + 1).trim();
    if (s) s = s[0].toUpperCase() + s.slice(1);
  }
  if (!s || !intentKey(s) || ACTIONABLE.has(voiceIntent(s).kind))
    return undefined;
  if (s.length > max) {
    const head = s.slice(0, max);
    const at = Math.max(head.lastIndexOf(","), head.lastIndexOf(" "));
    s = (at >= max * 0.6 ? head.slice(0, at) : head).replace(/[,;:\s]+$/, "");
    if (!s) return undefined;
    if (!/[.!?]$/.test(s)) s += ".";
  }
  return s;
}

/**
 * The same rules as speakableSentence for a texted reply: at most four
 * sentences and 480 characters, each sentence filtered on its own.
 */
export function textable(text: string | undefined): string | undefined {
  if (!text?.trim() || containsSecret(text)) return undefined;
  const parts = splitSentences(text.replace(/\s+/g, " ").trim())
    .map((part) => speakableSentence(part, 480))
    .filter((part): part is string => !!part);
  if (!parts.length) return undefined;
  let out = parts[0];
  for (const part of parts.slice(1, 4)) {
    if (out.length + 1 + part.length > 480) break;
    out += " " + part;
  }
  return out;
}

/**
 * The policy question for a pending action. Never describeAction: that
 * carries coordinates and typed text.
 */
export function speakableApproval(pending: {
  action: Action;
  reason: string;
}): string | undefined {
  let reason = pending.reason.trim();
  if (pending.action.type === "open_app")
    reason = reason.replace(/\bthis application\b/gi, pending.action.name);
  if (/^this shortcut may send or delete content\. allow it\?$/i.test(reason))
    reason = "That shortcut might send or delete something. Allow it?";
  reason = reason.replace(/\S*%\S*/g, "");
  return speakable(reason, 160, 2);
}

/** A model question or takeover reason, up to 160 characters. */
export function speakableQuestion(
  message: string | undefined,
): string | undefined {
  return speakable(message, 160, 2);
}

/**
 * Runner messages say "Say continue…". That is literally true in hands-free
 * mode (an answer window follows); push-to-talk needs the shortcut first.
 */
export function adaptContinueHint(message: string, handsFree: boolean): string {
  if (handsFree) return message;
  return message.replace(
    /\b([Ss])ay(\s+[‘'"“]?continue)/g,
    (_, s: string, rest: string) =>
      `${s === "S" ? "H" : "h"}old Option Space and say${rest}`,
  );
}
