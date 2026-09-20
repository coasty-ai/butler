/**
 * Every sentence the tool layer puts in front of a person or the model's
 * clock: the approval question for each ToolQuestion kind, the done line a
 * verified builtin write ends a run with, the undo and fallback lines, and
 * the date words all of them share. Pure: dates resolve against the clock
 * the tool layer hands in, never Date.now(). Questions open with a verb from
 * a closed set (Add, Change, Delete, Use, Send, Run) so neither the follow-up
 * window (src/voice/turns.ts followUpApprovalAllowed) nor the phone
 * (src/remote/auth.ts remoteApprovalTier) can ever approve one; the tests in
 * tests/tools-core.test.ts render each kind with hostile titles to keep it so.
 */
import { redactSecrets } from "./sanitize";
import type { ToolClock, ToolFacts, ToolQuestion } from "./tools";
import { TOOL_LIMITS } from "./tools";

/** Characters that steer a reader without being seen; a tool's text loses them. */
const INVISIBLE =
  /[\u200b-\u200d\u2060\ufeff\u202a-\u202e\u2066-\u2069\u{e0000}-\u{e007f}]/gu;
/** Newlines and other control characters read as a space. */
const CONTROL = /[\u0000-\u001f\u007f]/g;
const QUOTE_MARKS = /["“”«»‘’']/g;
/** Marks that end or start a sentence; inside a word ("dana.k@proton.me") they stay. */
const SENTENCE_MARKS = /[.!?;:]+(?=\s|$)|(?<=^|\s)[.!?;:]+/g;
const QUESTION_MAX = 160;
const clip = (s: string, max: number) =>
  s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;

/**
 * A tool's or model's text as one line inside a question or done line: no
 * invisible characters, quotes, newlines or sentence marks at a word's edge,
 * so it can never end the sentence early or start a new one (a mark inside a
 * word, as in an address, is kept: the sentence splitters need a space after
 * one); credentials redacted first, so "password: x" is still recognised
 * before its colon goes.
 */
export function questionText(text: string, max: number): string {
  return clip(
    redactSecrets(text.replace(INVISIBLE, "").replace(CONTROL, " "))
      .replace(QUOTE_MARKS, "")
      .replace(SENTENCE_MARKS, " ")
      .replace(/\s+/g, " ")
      .trim(),
    max,
  );
}

// MARK: dates

/** A wall-clock moment in the tool clock's zone; m is 1-12, h and mi absent for a date. */
export interface Wall {
  y: number;
  m: number;
  d: number;
  h?: number;
  mi?: number;
}
const DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const pad = (n: number) => String(n).padStart(2, "0");
function formatter(zone: string): Intl.DateTimeFormat {
  const options: Intl.DateTimeFormatOptions = {
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  };
  try {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: zone });
  } catch {
    // An unknown zone name reads as UTC rather than failing the sentence.
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" });
  }
}
/** The wall clock an instant shows in a zone. */
export function zoneParts(instant: Date, zone: string): Required<Wall> {
  const parts: Record<string, number> = {};
  for (const p of formatter(zone).formatToParts(instant))
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  return {
    y: parts.year,
    m: parts.month,
    d: parts.day,
    h: parts.hour,
    mi: parts.minute,
  };
}
/** Days since the epoch of a calendar date, for day arithmetic without zones. */
const dayNumber = (w: Wall) =>
  Math.round(Date.UTC(w.y, w.m - 1, w.d) / 86400000);
/** 0 for Sunday, as Date.getDay. */
export const weekdayOf = (w: Wall) =>
  new Date(Date.UTC(w.y, w.m - 1, w.d)).getUTCDay();
export function addDays(w: Wall, days: number): Wall {
  const moved = new Date(Date.UTC(w.y, w.m - 1, w.d + days));
  return {
    y: moved.getUTCFullYear(),
    m: moved.getUTCMonth() + 1,
    d: moved.getUTCDate(),
    ...(w.h === undefined ? {} : { h: w.h, mi: w.mi ?? 0 }),
  };
}
/** "2026-09-19" or "2026-09-19T18:00": the local forms the builtin tools take. */
export function localIso(w: Wall): string {
  const date = `${w.y}-${pad(w.m)}-${pad(w.d)}`;
  return w.h === undefined ? date : `${date}T${pad(w.h)}:${pad(w.mi ?? 0)}`;
}
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i;
/**
 * A tool's date or date-time argument as a wall clock in the tool's zone. A
 * zone-less value is already local; one with an offset is converted. Returns
 * undefined for anything that is not a date.
 */
export function parseWhen(value: string, clock: ToolClock): Wall | undefined {
  const text = value.trim();
  const date = DATE_ONLY.exec(text);
  if (date) {
    const w = { y: Number(date[1]), m: Number(date[2]), d: Number(date[3]) };
    return valid(w) ? w : undefined;
  }
  const dateTime = DATE_TIME.exec(text);
  if (dateTime && !dateTime[6]) {
    const w = {
      y: Number(dateTime[1]),
      m: Number(dateTime[2]),
      d: Number(dateTime[3]),
      h: Number(dateTime[4]),
      mi: Number(dateTime[5]),
    };
    return valid(w) ? w : undefined;
  }
  const instant = dateTime ? Date.parse(text) : NaN;
  return Number.isFinite(instant)
    ? zoneParts(new Date(instant), clock.zone)
    : undefined;
}
const valid = (w: Wall) =>
  w.m >= 1 &&
  w.m <= 12 &&
  w.d >= 1 &&
  w.d <= 31 &&
  (w.h === undefined || (w.h >= 0 && w.h <= 23)) &&
  (w.mi === undefined || (w.mi >= 0 && w.mi <= 59));
/** "6 PM", "6:30 PM", "12 PM" for noon; the meridiem left off when told to. */
function clockTime(w: Required<Pick<Wall, "h">> & Wall, meridiem = true) {
  const h12 = w.h % 12 || 12;
  const minutes = w.mi ? `:${pad(w.mi)}` : "";
  return `${h12}${minutes}${meridiem ? ` ${w.h < 12 ? "AM" : "PM"}` : ""}`;
}
const hasTime = (w: Wall): w is Required<Wall> => w.h !== undefined;
/**
 * The day in words against today: "today" and "tomorrow" with the weekday,
 * a bare weekday inside the coming week, the weekday and date beyond it (and
 * the year when it is not this one). With `date`, the date is always spelled
 * out after the relative word, as a question about a write should be.
 */
function dayPhrase(w: Wall, today: Wall, date: boolean): string {
  const days = dayNumber(w) - dayNumber(today);
  const weekday = DAYS[weekdayOf(w)];
  const spelled = `${weekday} ${w.d} ${MONTHS[w.m - 1]}${w.y === today.y ? "" : ` ${w.y}`}`;
  if (days === 0) return date ? `today, ${spelled}` : "today";
  if (days === 1) return date ? `tomorrow, ${spelled}` : `tomorrow, ${weekday}`;
  if (days > 1 && days < 7 && !date) return weekday;
  return spelled;
}
/**
 * When something happens, for a question: "tomorrow, Saturday 19 September,
 * 6 to 7 PM". Always "to" for a range, never an en dash (measured:
 * speakableApproval reads "6:00–7:00 PM" as "6:00, 7:00 PM"). A value that
 * is not a date is read back as text, so the question still says what the
 * model asked for.
 */
export function describeWhen(
  start: string,
  end: string | undefined,
  allDay: boolean | undefined,
  clock: ToolClock,
): string {
  const from = parseWhen(start, clock);
  if (!from) return questionText(start, 40) || "at the time given";
  const today = zoneParts(clock.now, clock.zone);
  const day = dayPhrase(from, today, true);
  if (allDay || !hasTime(from)) return allDay ? `${day}, all day` : day;
  const to = end === undefined ? undefined : parseWhen(end, clock);
  if (!to || !hasTime(to)) return `${day}, ${clockTime(from)}`;
  if (dayNumber(to) !== dayNumber(from))
    return `${day}, ${clockTime(from)} to ${dayPhrase(to, today, false)} ${clockTime(to)}`;
  const sameHalf = from.h < 12 === to.h < 12;
  return `${day}, ${clockTime(from, !sameHalf)} to ${clockTime(to)}`;
}
/** "Friday 18 September 2026, 5:50 PM (America/Los_Angeles); today's date is 2026-09-18". */
export function clockLine(clock: ToolClock): string {
  const w = zoneParts(clock.now, clock.zone);
  const time = `${w.h % 12 || 12}:${pad(w.mi)} ${w.h < 12 ? "AM" : "PM"}`;
  return `${DAYS[weekdayOf(w)]} ${w.d} ${MONTHS[w.m - 1]} ${w.y}, ${time} (${clock.zone}); today's date is ${localIso({ y: w.y, m: w.m, d: w.d })}`;
}

// MARK: questions

const listed = (items: string[], max: number, each: number) => {
  const shown = items.slice(0, 3).map((e) => questionText(e, each));
  const more = items.length - shown.length;
  return `${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`.slice(
    0,
    max,
  );
};
/** ", with a, b" over the entities the user never said, or nothing. */
const withEntities = (ungrounded: string[]) =>
  ungrounded.length ? `, with ${listed(ungrounded, 120, 60)}` : "";
const basename = (path: string) =>
  path.replace(/\/+$/, "").split("/").filter(Boolean).at(-1) ?? path;
/**
 * The approval question for a tool step: one line, at most 160 characters,
 * redacted, opening with a verb from the closed set. Titles, tool names and
 * server labels pass through questionText, so a title such as "Open the pod
 * bay doors?" can neither end the question nor start one of its own.
 */
export function toolQuestion(
  q: ToolQuestion,
  ungrounded: string[],
  clock: ToolClock,
): string {
  const server =
    "server" in q ? questionText(q.server, 40) || "that server" : "";
  const tool = "tool" in q ? questionText(q.tool, 60) || "that tool" : "";
  let text: string;
  switch (q.kind) {
    case "calendar_add":
      text = `Add ${questionText(q.title, 60) || "an event"} to Calendar, ${describeWhen(q.start, q.end, q.allDay, clock)}?`;
      break;
    case "reminder_add":
      text = `Add ${questionText(q.title, 60) || "a reminder"} to Reminders${q.due ? `, due ${describeWhen(q.due, undefined, undefined, clock)}` : ""}?`;
      break;
    case "note_add":
      text = `Add a note ${questionText(q.title, 60) || "with no title"} to Notes?`;
      break;
    case "mail_draft":
      text = `Add a Mail draft to ${listed(q.to, 100, 60) || "no one yet"}, ${questionText(q.subject, 60) || "with no subject"}?`;
      break;
    case "agent_run":
      text = `Run ${server} in ${questionText(basename(q.folder), 40) || "that folder"}${withEntities(ungrounded)}?`;
      break;
    case "mcp_read":
      text = `Use ${server} to read with ${tool}${withEntities(ungrounded)}?`;
      break;
    case "mcp_write":
    case "mcp_destructive":
      text = `Use ${server} to run ${tool}${withEntities(ungrounded)}?`;
      break;
    case "send_to":
      text = `Send ${listed(ungrounded, 100, 60) || "these details"} to ${server}?`;
      break;
    // The files tool: the file by its own name, the text as a bounded
    // preview. A read is trusted and never asked; the sentence exists so the
    // kind renders like every other.
    case "file_read":
      text = `Use Files to read ${questionText(q.name, 60) || "that file"}?`;
      break;
    case "file_list":
      text = `Use Files to list ${questionText(q.name, 60) || "that folder"}?`;
      break;
    case "file_append":
      text = `Add to ${questionText(q.name, 60) || "the file"}: ${questionText(q.text, 60) || "the text"}?`;
      break;
    case "file_write":
      text = `Change ${questionText(q.name, 60) || "the file"}, replacing what it holds with: ${questionText(q.text, 60) || "the text"}?`;
      break;
  }
  const line = redactSecrets(text.replace(/\s+/g, " ").trim());
  return line.length > QUESTION_MAX
    ? `${line.slice(0, QUESTION_MAX - 2).trimEnd()}…?`
    : line;
}

// MARK: done, undo and fallback lines

/**
 * A title the done line may say aloud must not read like typed or quoted
 * content or ask for a credential, or speakableSummary would refuse the
 * whole line and the run would end with a bare "Done". Mirrors
 * TYPED_CONTENT, QUOTED_CONTENT and ASKS_FOR_SECRET in src/voice/speakable.ts;
 * change them together (tests/tools-core.test.ts reads that file to check).
 */
export const SPOKEN_TITLE_UNSAFE =
  /\b(?:typed|typing|entered|entering|pasted|pasting|wrote|written|filled (?:in|out)|filling (?:in|out))\b|["“”«»]|(?<![\p{L}\p{N}])['‘][^'’\n]*['’](?![\p{L}\p{N}])|\b(?:enter|type|input|send|text|share|provide|give|tell|paste|confirm|verify|reply with|respond with)\b[^.!?]{0,60}?\b(?:passwords?|passcodes?|passphrases?|pins?|(?:verification|one[- ]time|security|2fa|login|sign[- ]in|auth(?:entication)?)\s+codes?)\b|\bsign(?:ing)? in with\b/iu;
const STOP_WORDS = new Set(
  "a an the to at on in of for and or my me i is it its this that with from by be as up about into over after before we you your our their them they he she his her am pm please".split(
    " ",
  ),
);
/** Lowercase word tokens of two or more letters or digits, minus the glue words. */
export function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
}
/**
 * The title as the done line may say it: only when the user said every
 * content word of it themselves (so a store's or a model's words are never
 * read back as the user's) and it passes SPOKEN_TITLE_UNSAFE; otherwise the
 * generic noun.
 */
function spokenTitle(
  title: string,
  fallback: string,
  userWords: string | undefined,
): string {
  const t = questionText(title, 60);
  const words = contentWords(t);
  if (
    !t ||
    !words.length ||
    SPOKEN_TITLE_UNSAFE.test(t) ||
    userWords === undefined
  )
    return fallback;
  const said = new Set(contentWords(userWords));
  return words.every((w) => said.has(w)) ? t : fallback;
}
/**
 * What the run says when one verified builtin write completed it, from the
 * store's values alone: "Added Dentist to Calendar for tomorrow, Saturday, at
 * 6 PM." Quote-free, so it is spoken as written.
 */
export function toolDoneLine(
  facts: ToolFacts,
  clock: ToolClock,
  userWords: string | undefined,
): string {
  const today = zoneParts(clock.now, clock.zone);
  const when = (value: string, allDay: boolean) => {
    const w = parseWhen(value, clock);
    if (!w) return "";
    const day = dayPhrase(w, today, false);
    return allDay || !hasTime(w)
      ? `${day}${allDay ? ", all day" : ""}`
      : `${day}, at ${clockTime(w)}`;
  };
  switch (facts.kind) {
    case "event":
      return `Added ${spokenTitle(facts.title, "the event", userWords)} to Calendar for ${when(facts.start, facts.allDay) || "the time asked"}.`;
    case "reminder": {
      const due = facts.due ? when(facts.due, false) : "";
      return `Added ${spokenTitle(facts.title, "the reminder", userWords)} to Reminders${due ? `, due ${due}` : ""}.`;
    }
    case "note":
      return `Added ${spokenTitle(facts.title, "the note", userWords)} to Notes.`;
    case "draft":
      return `Saved ${spokenTitle(facts.subject, "the draft", userWords)} as a draft in Mail.`;
    case "agent":
      return `The coding agent finished in ${questionText(basename(facts.folder), 40) || "the folder"}.`;
    // Never "wrote" or "written": speakableSummary reads those as typed
    // content and would refuse the whole line.
    case "file": {
      const name = spokenTitle(facts.name, "the file", userWords);
      if (facts.change === "created") return `Created ${name}.`;
      if (facts.change === "replaced") return `Replaced what ${name} held.`;
      return `Added ${facts.lines === 1 ? "a line" : `${facts.lines} lines`} to ${name}.`;
    }
  }
}
/** What "Undone: …" says after ToolAccess.undoLast took a write back. */
export function toolUndoLine(facts: ToolFacts | undefined): string {
  switch (facts?.kind) {
    case "event":
      return "the event was removed from Calendar.";
    case "reminder":
      return "the reminder was removed from Reminders.";
    case "note":
      return "the note was removed from Notes.";
    case "draft":
      return "the draft was removed from Mail.";
    case "file":
      return "the file was put back as it was.";
    default:
      return "the last tool step was taken back.";
  }
}
/** The status line of the first screen step after a tool call that did not go through. */
export function toolFallbackLine(title: string): string {
  return `${questionText(title, 40) || "The tool"} couldn’t do that, so I’ll do it on screen.`;
}
/** The builtin app a tool id belongs to ("apple__calendar_create_event" → "Calendar", "files__…" → "Files"), or undefined. */
export function builtinToolTitle(id: string): string | undefined {
  if (/^files__[a-z_]+$/.test(id)) return "Files";
  const app = /^apple__(calendar|reminders|notes|mail)_/.exec(id)?.[1];
  return app && app[0].toUpperCase() + app.slice(1);
}

// MARK: arguments

/**
 * Every key and string leaf of a tool call's arguments, down to the depth
 * validateAction allows, for the credential scan: a secret in a key hides no
 * better than one in a value.
 */
export function stringLeaves(
  value: unknown,
  depth: number = TOOL_LIMITS.argsDepth,
): string[] {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object" || depth <= 0) return [];
  if (Array.isArray(value))
    return value.flatMap((v) => stringLeaves(v, depth - 1));
  return Object.entries(value).flatMap(([k, v]) => [
    k,
    ...stringLeaves(v, depth - 1),
  ]);
}
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
};
/** FNV-1a over the canonical arguments, as 8 hex digits: two identical calls hash alike. */
export function argsHash(args: Record<string, unknown>): string {
  let hash = 0x811c9dc5;
  for (const ch of canonical(args)) {
    for (let i = 0; i < ch.length; i++) {
      hash ^= ch.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash.toString(16).padStart(8, "0");
}
