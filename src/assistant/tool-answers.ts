/**
 * Requests one builtin tool answers or does outright, with no model call: a
 * question about the calendar or the reminders over at most a time window
 * (answered from the tool's lines), and an add to the calendar or the
 * reminders, or a request to the coding agent, said plainly enough to be one
 * tool step. The grammar is narrow on purpose: anything that points at the
 * screen ("add it"), carries a second clause or a credential, or names any
 * other thing falls through to the dialog and the run, where the model reads
 * the screen. Dates resolve against the tool layer's clock, never Date.now().
 */
import { scanText } from "../core/sanitize";
import type { ToolClock, ToolOutcome } from "../core/tools";
import {
  addDays,
  localIso,
  weekdayOf,
  zoneParts,
  type Wall,
} from "../core/tool-text";
import { speakableSentence } from "../voice/speakable";

export type ToolFastPath =
  | {
      kind: "answer";
      tool: string;
      args: Record<string, unknown>;
      say(o: ToolOutcome, c: ToolClock): string;
    }
  | { kind: "step"; tool: string; args: Record<string, unknown> };

const DAY_NAMES = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];
const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const WEEKDAY = String.raw`(?:mon|tues|wednes|thurs|fri|satur|sun)day`;
const MONTH = String.raw`(?:january|february|march|april|may|june|july|august|september|october|november|december)`;
/** A day the words name: relative, a weekday, or a day and month. */
const DAY = new RegExp(
  String.raw`\b(?:(?:for |on )?(today|tonight|tomorrow|this (?:morning|afternoon|evening))|(?:for |on )?(?:(this|next) )?(${WEEKDAY})|(?:for |on )?(?:the )?(\d{1,2})(?:st|nd|rd|th)?(?: of)? (${MONTH})|(?:for |on |in )?(${MONTH}) (?:the )?(\d{1,2})(?:st|nd|rd|th)?)\b`,
  "i",
);
/** A time of day: "at 6", "6 pm", "6:30", "noon"; a bare number needs "at" or a meridiem. */
const TIME = new RegExp(
  String.raw`\b(?:at (\d{1,2})(?::(\d{2}))?(?: ?(am|pm|a\.m\.|p\.m\.|o'?clock))?|(\d{1,2})(?::(\d{2}))? ?(am|pm|a\.m\.|p\.m\.|o'?clock)|(?:at )?(noon|midnight))(?: in the (morning|afternoon|evening))?\b`,
  "i",
);
const WEEK = /\b(this|next) week\b/i;
/** Words that point at the screen or at something said before; the model reads those. */
const DEICTIC =
  /\b(?:it|that|those|these|them|him|her|there|here|same|one|this|again)\b/i;
/** A second instruction in the same breath; the run's model handles those. */
const SECOND_CLAUSE =
  /\b(?:and then|then|after that|also|as well)\b|\band (?:add|put|create|schedule|book|remind|email|text|send|open|call|tell|ask|check|show|delete|move|cancel)\b/i;
const hasCredential = (text: string) =>
  scanText(text).some((f) => f.action === "BLOCK_UPLOAD");
const normalize = (text: string) =>
  text
    .replace(/[“”"]/g, "")
    .replace(/[’]/g, "'")
    .replace(/[.,!?;:]+(?=\s|$)/g, "")
    .replace(/\s+/g, " ")
    .trim();
const capitalize = (text: string) =>
  text ? text[0].toUpperCase() + text.slice(1) : text;

// MARK: when

/** The clock's today, as a date without a time. */
const today = (clock: ToolClock): Wall => {
  const { y, m, d } = zoneParts(clock.now, clock.zone);
  return { y, m, d };
};
const withTime = (w: Wall, h: number, mi = 0): Wall => ({
  y: w.y,
  m: w.m,
  d: w.d,
  h,
  mi,
});
/** The date a day match names, resolved against the clock. */
function dayOf(m: RegExpMatchArray, clock: ToolClock): Wall | undefined {
  const now = today(clock);
  const [, relative, which, weekday, dayNum, month, month2, dayNum2] = m;
  if (relative) return relative === "tomorrow" ? addDays(now, 1) : now;
  if (weekday) {
    // "next Friday" means this week's or the next one's depending on who
    // says it: a question or the model settles that, never a guess here.
    if (which?.toLowerCase() === "next") return undefined;
    const target = DAY_NAMES.indexOf(weekday.toLowerCase());
    return addDays(now, (target - weekdayOf(now) + 7) % 7);
  }
  const day = Number(dayNum ?? dayNum2);
  const monthIndex = MONTH_NAMES.indexOf((month ?? month2).toLowerCase());
  if (!(day >= 1 && day <= 31)) return undefined;
  const date: Wall = { y: now.y, m: monthIndex + 1, d: day };
  // A day already past this year means next year.
  return Date.UTC(date.y, date.m - 1, date.d) <
    Date.UTC(now.y, now.m - 1, now.d)
    ? { ...date, y: now.y + 1 }
    : date;
}
/** The hour and minute a time match names; bare hours read as a person would say them. */
function timeOf(
  m: RegExpMatchArray,
  evening: boolean,
): { h: number; mi: number } | undefined {
  const [, h1, mi1, mer1, h2, mi2, mer2, word, part] = m;
  if (word) return { h: word.toLowerCase() === "noon" ? 12 : 0, mi: 0 };
  const hour = Number(h1 ?? h2);
  const mi = Number(mi1 ?? mi2 ?? 0);
  if (!(hour >= 0 && hour <= 23) || !(mi >= 0 && mi <= 59)) return undefined;
  const meridiem = (mer1 ?? mer2 ?? "").toLowerCase().replace(/\./g, "");
  if (hour > 12 || hour === 0) return { h: hour, mi };
  if (meridiem === "am" || part?.toLowerCase() === "morning")
    return { h: hour % 12, mi };
  if (meridiem === "pm" || part || evening) return { h: (hour % 12) + 12, mi };
  // "at 9" is the morning, "at 6" the evening, "at 12" noon.
  return { h: hour >= 7 && hour <= 11 ? hour : (hour % 12) + 12, mi };
}
/**
 * The day and time phrases in the words, with what is left once they are
 * taken out. The time needs a day to mean anything ("at 6" alone is left to
 * the model); the day may stand alone.
 */
function extractWhen(
  body: string,
  clock: ToolClock,
): { when?: Wall; rest: string; timed: boolean } | undefined {
  const day = DAY.exec(body);
  const time = TIME.exec(body);
  if (time && !day) return undefined;
  let rest = body;
  if (day) rest = rest.replace(day[0], " ");
  if (time) rest = rest.replace(time[0], " ");
  rest = rest
    .replace(/\s+/g, " ")
    .replace(/^(?:for|on|at|to)\s+|\s+(?:for|on|at|to)$/gi, "")
    .trim();
  if (!day) return { rest, timed: false };
  const date = dayOf(day, clock);
  if (!date) return undefined;
  if (!time) return { when: date, rest, timed: false };
  const evening = /^tonight$|evening$/i.test(day[1] ?? "");
  const at = timeOf(time, evening);
  if (!at) return undefined;
  return { when: withTime(date, at.h, at.mi), rest, timed: true };
}

// MARK: answers

const REMINDERS_NOUN =
  /\b(?:reminders?|to[- ]?dos?|to[- ]?do list|tasks?|due)\b/i;
const ASKS =
  /^(?:what's|whats|what is|what do i have|what have i got|do i have|is there|anything|check|show me|show|tell me|read me|read|list)\b/i;
/** Words a question about the calendar or the reminders is made of, besides the window. */
const FILL = new Set(
  "what's whats what is do i have got there any anything something on in for my the a an at of up coming scheduled planned due left going happening happen check show tell read list me and today's this that's".split(
    " ",
  ),
);
const NOUN_WORDS = new Set(
  "calendar schedule agenda meeting meetings event events appointment appointments reminder reminders to-do to-dos todo todos task tasks list".split(
    " ",
  ),
);
/**
 * The days a question covers, as the bridge reads them (calendar_list_events
 * takes whole days, YYYY-MM-DD), and for "tonight", "this morning" and "this
 * afternoon" the hours of that day the answer keeps (sayLines filters the
 * lines; the bridge is never sent a time).
 */
interface Window {
  from: Wall;
  to: Wall;
  /** Start hours kept, [from, to); absent for whole days. */
  hours?: { from: number; to: number };
  label: string;
}
/** The window a question names, or the whole of today when it names none. */
function windowOf(
  text: string,
  clock: ToolClock,
): { window: Window; rest: string } | undefined {
  const now = today(clock);
  const wholeDay = (d: Wall, label: string): Window => ({
    from: d,
    to: d,
    label,
  });
  const week = WEEK.exec(text);
  if (week) {
    const monday = addDays(now, -((weekdayOf(now) + 6) % 7));
    const start = week[1].toLowerCase() === "next" ? addDays(monday, 7) : now;
    const end = addDays(monday, week[1].toLowerCase() === "next" ? 13 : 6);
    return {
      window: {
        from: start,
        to: end,
        label: `${capitalize(week[1].toLowerCase())} week`,
      },
      rest: text.replace(week[0], " "),
    };
  }
  const day = DAY.exec(text);
  if (!day) return { window: wholeDay(now, "Today"), rest: text };
  const date = dayOf(day, clock);
  if (!date) return undefined;
  const rest = text.replace(day[0], " ");
  const relative = (day[1] ?? "").toLowerCase();
  if (relative === "tonight" || relative === "this evening")
    return {
      window: {
        ...wholeDay(date, capitalize(relative)),
        hours: { from: 17, to: 24 },
      },
      rest,
    };
  if (relative === "this morning")
    return {
      window: {
        ...wholeDay(date, "This morning"),
        hours: { from: 0, to: 12 },
      },
      rest,
    };
  if (relative === "this afternoon")
    return {
      window: {
        ...wholeDay(date, "This afternoon"),
        hours: { from: 12, to: 17 },
      },
      rest,
    };
  const label = relative
    ? capitalize(relative)
    : day[3]
      ? capitalize(DAY_NAMES[weekdayOf(date)])
      : `${DAY_NAMES[weekdayOf(date)][0].toUpperCase()}${DAY_NAMES[weekdayOf(date)].slice(1)} ${date.d} ${capitalize(MONTH_NAMES[date.m - 1])}`;
  return { window: wholeDay(date, label), rest };
}
/**
 * The hour an event line starts at, from the bridge's own shape
 * ("Sat 19 Sep, 3 PM to 4 PM: Review (Work)", "Fri 18 Sep, 9:45 AM to …");
 * undefined for an all-day line or any other shape, which a part-day window
 * keeps rather than hides.
 */
const LINE_START = /^[^,]*,\s*(\d{1,2})(?::\d{2})?\s*(AM|PM)\b/i;
function startHour(line: string): number | undefined {
  const m = LINE_START.exec(line);
  if (!m) return undefined;
  const hour = Number(m[1]);
  if (!(hour >= 1 && hour <= 12)) return undefined;
  return (hour % 12) + (m[2].toUpperCase() === "PM" ? 12 : 0);
}
/** The lines whose start falls in the window's hours; every line when it has none. */
function inHours(lines: string[], hours: Window["hours"]): string[] {
  if (!hours) return lines;
  return lines.filter((line) => {
    const hour = startHour(line);
    return hour === undefined || (hour >= hours.from && hour < hours.to);
  });
}
const joinList = (items: string[]) =>
  items.length <= 1
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
/**
 * The spoken answer from a read's lines: at most four items, each through
 * speakableSentence (one that fails is "a private event"), then how many
 * more. Never a quote.
 */
function sayLines(
  o: ToolOutcome,
  label: string,
  noun: "calendar" | "reminders",
  hours?: Window["hours"],
): string {
  if (o.code !== "ok")
    return o.code === "denied"
      ? `I don’t have access to your ${noun}.`
      : `I couldn’t read your ${noun} right now.`;
  const lines = inHours(
    (o.lines ?? []).filter((l) => l.trim()),
    hours,
  );
  if (!lines.length)
    return noun === "calendar"
      ? `${label}’s clear.`
      : `Nothing’s due ${label.toLowerCase()}.`;
  const items = lines.slice(0, 4).map((line) => {
    const clean = speakableSentence(line.replace(/[.!?]+$/, ""), 100);
    return clean
      ? clean.replace(/[.!?]+$/, "").replace(/[“”"]/g, "")
      : noun === "calendar"
        ? "a private event"
        : "a private reminder";
  });
  const more = lines.length - items.length;
  return `${noun === "calendar" ? label : `Due ${label.toLowerCase()}`}: ${joinList(items)}${more > 0 ? `, and ${more} more` : ""}.`;
}
function answer(
  text: string,
  asked: boolean,
  clock: ToolClock,
): ToolFastPath | undefined {
  if (!ASKS.test(text) && !asked) return undefined;
  const reminders = REMINDERS_NOUN.test(text);
  // "Anything tomorrow?" is about the calendar; a noun only says which.
  const calendar = !reminders;
  const found = windowOf(text, clock);
  if (!found) return undefined;
  const { window, rest } = found;
  const other = rest
    .toLowerCase()
    .split(/[^a-z'-]+/)
    .filter((w) => w && !FILL.has(w) && !NOUN_WORDS.has(w));
  if (other.length) return undefined;
  // Whole days, as the bridge takes them: a day in dueBefore means before
  // the next day's start, so the window's last day is included.
  if (calendar)
    return {
      kind: "answer",
      tool: "apple__calendar_list_events",
      args: { from: localIso(window.from), to: localIso(window.to) },
      say: (o) => sayLines(o, window.label, "calendar", window.hours),
    };
  return {
    kind: "answer",
    tool: "apple__reminders_list",
    args: { dueBefore: localIso(window.to) },
    say: (o) => sayLines(o, window.label, "reminders"),
  };
}

// MARK: steps

const CALENDAR_ADD =
  /^(?:add|put|create|schedule|book)\s+(?:(?:an?|the|a new)\s+)?(?:(?:event|appointment|meeting)\s+(?:called|named|for|titled)\s+)?(.+?)\s+(?:to|on|in|into|onto)\s+(?:my\s+|the\s+)?calendar\b(.*)$/i;
const REMIND = /^remind me\s+(.+)$/i;
const REMINDER_ADD =
  /^(?:add|put)\s+(?:(?:a|the)\s+)?(?:reminder\s+(?:to|for)\s+)?(.+?)\s+(?:to|on|in|into|onto)\s+(?:my\s+|the\s+)?(?:reminders?|to[- ]?do list|to[- ]?dos?)\b(.*)$/i;
const AGENT =
  /^(?:ask|tell|have|get)\s+(?:the\s+)?(?:coding agent|claude code|claude)\s+to\s+(.+)$/i;
/** A title from the words that is one thing, said outright. */
const plainTitle = (text: string): string | undefined => {
  const title = text
    .replace(/^(?:an?|the)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return title && !DEICTIC.test(title) && !SECOND_CLAUSE.test(title)
    ? capitalize(title)
    : undefined;
};
function step(text: string, clock: ToolClock): ToolFastPath | undefined {
  const agent = AGENT.exec(text);
  if (agent) {
    const prompt = agent[1].trim();
    if (DEICTIC.test(prompt) || SECOND_CLAUSE.test(prompt)) return undefined;
    return {
      kind: "step",
      tool: "claude-code__Agent",
      args: {
        prompt: capitalize(prompt),
        description: prompt.split(" ").slice(0, 5).join(" "),
      },
    };
  }
  const event = CALENDAR_ADD.exec(text);
  if (event) {
    const when = extractWhen(`${event[1]} ${event[2]}`, clock);
    if (!when?.when || !when.timed) return undefined;
    const title = plainTitle(when.rest);
    if (!title) return undefined;
    return {
      kind: "step",
      tool: "apple__calendar_create_event",
      args: { title, start: localIso(when.when) },
    };
  }
  const remind = REMIND.exec(text);
  const reminder = remind ? undefined : REMINDER_ADD.exec(text);
  if (remind || reminder) {
    const body = remind ? remind[1] : `${reminder![1]} ${reminder![2]}`;
    const when = extractWhen(body, clock);
    if (!when) return undefined;
    const title = plainTitle(when.rest.replace(/^to\s+/i, ""));
    if (!title) return undefined;
    return {
      kind: "step",
      tool: "apple__reminders_create",
      args: { title, ...(when.when ? { due: localIso(when.when) } : {}) },
    };
  }
  return undefined;
}

/**
 * A request one builtin tool answers or does outright, or undefined when the
 * words say anything more: the dialog and the run take those.
 */
export function toolFastPath(
  text: string,
  clock: ToolClock,
): ToolFastPath | undefined {
  // Credentials are looked for in the words as said: normalising would take
  // the colon out of "password: …" first.
  if (hasCredential(text)) return undefined;
  const words = normalize(text);
  if (!words || words.length > 200) return undefined;
  return answer(words, /\?\s*$/.test(text), clock) ?? step(words, clock);
}
