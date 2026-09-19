import {
  TOOL_LIMITS,
  type AppleConsent,
  type BuiltinServer,
  type BuiltinTool,
  type ToolFacts,
  type ToolQuestion,
} from "../../core/tools";

/**
 * The Apple bridge (coarena-apple, native/macos/Apple.swift) as the tool
 * registry sees it: which of its tools the model may use, what each does,
 * its tier, the consent in settings.tools.apple it needs, the question a
 * write is approved from, and the exact shapes of what comes back. The
 * bridge also answers a tenth tool, undo; it is not here, so the model never
 * sees it and only ToolAccess.undoLast reaches it (docs/TOOLS.md).
 *
 * The parsers accept exactly the structuredContent shapes recorded in
 * tests/fixtures/apple, which the native tests hold the bridge to, and return
 * undefined for anything else: a changed or hostile shape yields no facts and
 * no spoken lines rather than wrong ones.
 */

/** A string argument as a question shows it: trimmed and bounded. */
const said = (value: unknown, limit = 200): string =>
  typeof value === "string" ? value.trim().slice(0, limit) : "";
const saidIfAny = (value: unknown, limit = 200): string | undefined =>
  said(value, limit) || undefined;
const isString = (value: unknown): value is string => typeof value === "string";

/** `value` as an object holding every one of `keys` and nothing beyond `keys` and `optional`. */
function shape(
  value: unknown,
  keys: string[],
  optional: string[] = [],
): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const object = value as Record<string, unknown>;
  if (keys.some((key) => !(key in object))) return undefined;
  if (
    Object.keys(object).some(
      (key) => !keys.includes(key) && !optional.includes(key),
    )
  )
    return undefined;
  return object;
}

/** A read's result: the lines a voice can speak, bounded as the bridge bounds them. */
function lines(structured: unknown): string[] | undefined {
  const object = shape(structured, ["lines", "more"]);
  if (!object || !Array.isArray(object.lines)) return undefined;
  if (object.lines.length > TOOL_LIMITS.lines) return undefined;
  if (
    !object.lines.every(
      (line) => isString(line) && line.length <= TOOL_LIMITS.lineChars,
    )
  )
    return undefined;
  if (!Number.isInteger(object.more) || (object.more as number) < 0)
    return undefined;
  return object.lines as string[];
}

/** An add's result: the item of one kind as the store now holds it, with its undo token. */
function created(
  structured: unknown,
  kind: string,
  keys: string[],
  optional: string[] = [],
): Record<string, unknown> | undefined {
  const object = shape(structured, ["created", "verified", "undoToken"]);
  if (!object || object.verified !== true || !isString(object.undoToken))
    return undefined;
  const item = shape(object.created, ["kind", ...keys], optional);
  return item?.kind === kind ? item : undefined;
}

function eventFacts(structured: unknown): ToolFacts | undefined {
  const item = created(structured, "event", [
    "title",
    "start",
    "end",
    "allDay",
    "calendar",
  ]);
  if (
    !item ||
    !isString(item.title) ||
    !isString(item.start) ||
    !isString(item.end) ||
    typeof item.allDay !== "boolean" ||
    !isString(item.calendar)
  )
    return undefined;
  return {
    kind: "event",
    title: item.title,
    start: item.start,
    end: item.end,
    allDay: item.allDay,
    calendar: item.calendar,
  };
}

function reminderFacts(structured: unknown): ToolFacts | undefined {
  const item = created(structured, "reminder", ["title", "list"], ["due"]);
  if (!item || !isString(item.title) || !isString(item.list)) return undefined;
  if (item.due !== undefined && !isString(item.due)) return undefined;
  return {
    kind: "reminder",
    title: item.title,
    list: item.list,
    ...(item.due !== undefined ? { due: item.due } : {}),
  };
}

function noteFacts(structured: unknown): ToolFacts | undefined {
  const item = created(structured, "note", ["title", "folder"]);
  if (!item || !isString(item.title) || !isString(item.folder))
    return undefined;
  return { kind: "note", title: item.title, folder: item.folder };
}

function draftFacts(structured: unknown): ToolFacts | undefined {
  const item = created(structured, "draft", ["subject", "recipients"]);
  if (
    !item ||
    !isString(item.subject) ||
    !Number.isInteger(item.recipients) ||
    (item.recipients as number) < 0
  )
    return undefined;
  return {
    kind: "draft",
    subject: item.subject,
    recipients: item.recipients as number,
  };
}

/** A read: trusted, never asked about, spoken from its lines. */
function read(
  title: BuiltinTool["title"],
  tool: string,
  consent: AppleConsent,
  does: string,
  dateKeys: string[] = [],
): BuiltinTool {
  return {
    title,
    does,
    tier: "read",
    undoable: false,
    consent,
    dateKeys,
    question: () => ({ kind: "mcp_read", server: title, tool }),
    lines,
  };
}

/** An add: additive and undoable, approved from a question built of its arguments. */
function add(
  title: BuiltinTool["title"],
  consent: AppleConsent,
  does: string,
  dateKeys: string[],
  question: (args: Record<string, unknown>) => ToolQuestion,
  facts: (structured: unknown) => ToolFacts | undefined,
): BuiltinTool {
  return {
    title,
    does,
    tier: "additive",
    undoable: true,
    consent,
    dateKeys,
    question,
    facts,
  };
}

export const APPLE: BuiltinServer = {
  id: "apple",
  helper: "coarena-apple",
  args: [],
  tools: {
    calendar_list_events: read(
      "Calendar",
      "calendar_list_events",
      "calendar",
      "Lists the events between two days: when, title and calendar per line, up to 20 lines and 31 days.",
      ["from", "to"],
    ),
    calendar_create_event: add(
      "Calendar",
      "calendar",
      "Adds one event with a title, a start, an optional end (an hour later by default), an all-day flag and a calendar name. Refuses a duplicate.",
      ["start", "end"],
      (args) => ({
        kind: "calendar_add",
        title: said(args.title, 100),
        start: said(args.start, 40),
        ...(saidIfAny(args.end, 40) ? { end: said(args.end, 40) } : {}),
        ...(args.allDay === true ? { allDay: true } : {}),
        ...(saidIfAny(args.calendar, 100)
          ? { calendar: said(args.calendar, 100) }
          : {}),
      }),
      eventFacts,
    ),
    reminders_list: read(
      "Reminders",
      "reminders_list",
      "reminders",
      "Lists open reminders, in one list or all, optionally only those due before a date: title, due date and list per line.",
      ["dueBefore"],
    ),
    reminders_create: add(
      "Reminders",
      "reminders",
      "Adds one reminder with a title, an optional due date or time, and a list (the default list when omitted). Refuses a duplicate.",
      ["due"],
      (args) => ({
        kind: "reminder_add",
        title: said(args.title, 100),
        ...(saidIfAny(args.due, 40) ? { due: said(args.due, 40) } : {}),
        ...(saidIfAny(args.list, 100) ? { list: said(args.list, 100) } : {}),
      }),
      reminderFacts,
    ),
    notes_search: read(
      "Notes",
      "notes_search",
      "notes",
      "Finds notes whose title contains the query: title and folder per line, up to 20. Bodies are never read.",
    ),
    notes_create: add(
      "Notes",
      "notes",
      "Adds one note with a title and an optional plain-text body to a folder (the default folder when omitted).",
      [],
      (args) => ({
        kind: "note_add",
        title: said(args.title, 100),
        ...(saidIfAny(args.folder, 100)
          ? { folder: said(args.folder, 100) }
          : {}),
      }),
      noteFacts,
    ),
    mail_unread: read(
      "Mail",
      "mail_unread",
      "mail",
      "Lists the newest unread inbox messages: sender name, subject and age per line, up to 20. Bodies are never read.",
    ),
    mail_search: read(
      "Mail",
      "mail_search",
      "mail",
      "Finds inbox messages by sender, subject or date received: sender name, subject and age per line, up to 20. Bodies are never read.",
      ["since"],
    ),
    mail_draft: add(
      "Mail",
      "mail",
      "Creates a draft in Mail to the given addresses with a subject and an optional body. Nothing is sent; the user sends it from Mail.",
      [],
      (args) => ({
        kind: "mail_draft",
        subject: said(args.subject, 200),
        to: Array.isArray(args.to)
          ? args.to.map((address) => said(address, 254)).filter(Boolean)
          : [],
      }),
      draftFacts,
    ),
  },
};
