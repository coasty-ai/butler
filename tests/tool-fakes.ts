import type {
  ToolAccess,
  ToolClock,
  ToolList,
  ToolOutcome,
  ToolPrepared,
  ToolQuestion,
  ToolSpec,
  ToolWords,
} from "../src/core/tools";
import { TOOL_LIMITS, TOOL_RESULT_TEXT } from "../src/core/tools";
import { asksToReplace } from "../src/tools/providers/files";

/**
 * A fake tool layer for the runner and policy tests: a builtin calendar and
 * reminders set (facts and lines), the built-in files tool (a read, an
 * append and a write over a ~/ path, grounded on the path alone as the real
 * one is), an untrusted filesystem server, a trusted open-world GitHub
 * server, a destructive scratch server and the coding agent's long-running
 * Agent. Outcomes are scripted per tool id; every call is recorded.
 */

/** Friday 18 September 2026, 5:50 PM in Los Angeles. */
export const CLOCK: ToolClock = {
  now: new Date("2026-09-19T00:50:00Z"),
  zone: "America/Los_Angeles",
};

const builtin = (
  name: string,
  title: string,
  tier: ToolSpec["tier"],
  dateKeys: string[],
  does: string,
  params: string,
): ToolSpec => ({
  id: `apple__${name}`,
  provider: "apple",
  name,
  title,
  does,
  params,
  tier,
  trusted: true,
  local: true,
  openWorld: false,
  undoable: tier === "additive",
  longRunning: false,
  transport: "builtin",
  timeoutMs: TOOL_LIMITS.callTimeoutMs,
  dateKeys,
  trace: { tool: name, server: "apple" },
});
const mcp = (
  provider: string,
  name: string,
  title: string,
  tier: ToolSpec["tier"],
  o: Partial<ToolSpec> = {},
): ToolSpec => ({
  id: `${provider}__${name}`,
  provider,
  name,
  title,
  does: `${name} on ${title}.`,
  params: "path (text)",
  tier,
  trusted: false,
  local: true,
  openWorld: false,
  undoable: false,
  longRunning: false,
  transport: "stdio",
  timeoutMs: TOOL_LIMITS.callTimeoutMs,
  dateKeys: [],
  trace: { tool: "t0123456789ab", server: "s0123456789ab" },
  ...o,
});

export const CALENDAR_LIST = builtin(
  "calendar_list_events",
  "Calendar",
  "read",
  ["from", "to"],
  "Titles and times of events between two dates.",
  "from (date-time, local), to (date-time, local)",
);
export const CALENDAR_ADD = builtin(
  "calendar_create_event",
  "Calendar",
  "additive",
  ["start", "end"],
  "Create one event in the user's calendar.",
  "title (text), start (date-time, local), end? (date-time), allDay? (boolean), calendar? (text)",
);
export const REMINDERS_LIST = builtin(
  "reminders_list",
  "Reminders",
  "read",
  ["dueBefore"],
  "Open reminders, optionally due before a time.",
  "dueBefore? (date-time, local), list? (text)",
);
export const REMINDER_ADD = builtin(
  "reminders_create",
  "Reminders",
  "additive",
  ["due"],
  "Create one reminder.",
  "title (text), due? (date-time, local), list? (text)",
);
/** The in-process files tool: builtin, trusted, closed-world (src/tools/providers/files.ts). */
const files = (
  name: string,
  tier: ToolSpec["tier"],
  undoable: boolean,
  does: string,
  params: string,
): ToolSpec => ({
  ...builtin(name, "Files", tier, [], does, params),
  id: `files__${name}`,
  provider: "files",
  undoable,
  trace: { tool: name, server: "files" },
});
export const FILES_READ = files(
  "read_text_file",
  "read",
  false,
  "Reads a plain-text file inside your home folder.",
  "path (text, a ~/ path)",
);
export const FILES_APPEND = files(
  "append_text_file",
  "additive",
  true,
  "Adds text to the end of a plain-text file on its own line.",
  "path (text, a ~/ path), text (text), newline? (boolean)",
);
export const FILES_REPLACE = files(
  "replace_file_text",
  "write",
  true,
  "Replaces everything a plain-text file holds with the text, erasing what it held.",
  "path (text, a ~/ path), text (text)",
);
export const FILES_LIST = files(
  "list_directory",
  "read",
  false,
  "Lists the visible files and folders inside a folder in your home folder.",
  "path (text, a ~/ path)",
);
export const FILES_RENAME = files(
  "rename_file",
  "write",
  true,
  "Renames a file in your home folder in place; never over an existing file.",
  "path (text, a ~/ path), newName (text, a file name with no slash)",
);
export const FILES_MOVE = files(
  "move_file",
  "write",
  true,
  "Moves a file in your home folder into another folder there, keeping its name.",
  "path (text, a ~/ path), toFolder (text, a ~/ folder path)",
);
export const FILES_TOOLS = [
  FILES_READ,
  FILES_APPEND,
  FILES_REPLACE,
  FILES_LIST,
  FILES_RENAME,
  FILES_MOVE,
];
/** The in-process web tool: builtin, trusted, closed-world reads with their own result cap (src/tools/providers/web.ts). */
const web = (name: string, does: string, params: string): ToolSpec => ({
  ...builtin(name, "Web", "read", [], does, params),
  id: `web__${name}`,
  provider: "web",
  undoable: false,
  trace: { tool: name, server: "web" },
  resultChars: 30_400,
});
export const WEB_READ = web(
  "read_page_text",
  "Reads a public web page at an http(s) address and returns its whole text.",
  "url (text, a full http or https address), maxChars? (integer)",
);
export const WEB_CURRENT = web(
  "read_current_page",
  "Reads the whole text of the web page in front.",
  "maxChars? (integer)",
);
export const WEB_TOOLS_FAKE = [WEB_READ, WEB_CURRENT];
/** The hosts the fake treats as protected, as defaultSettings.protectedDomains has them. */
const FAKE_PROTECTED = ["paypal.com", "chase.com"];
/** The home folder the fakes stand in for: an absolute path under it grounds as its ~/ form. */
export const FAKE_HOME = "/Users/me";
/** The one file the fake home holds with text in it (what FILES_READ reads); every other path is absent or empty. */
export const FAKE_NOTES =
  "~/OpenAssistBench/benchnote0a1b/benchnote0a1b-notes.txt";
const homeRelative = (path: unknown) =>
  typeof path === "string" && path.startsWith(`${FAKE_HOME}/`)
    ? `~/${path.slice(FAKE_HOME.length + 1)}`
    : String(path ?? "");
const baseName = (path: unknown) =>
  homeRelative(path).split("/").filter(Boolean).at(-1) ?? "";
/** An untrusted stdio server declared local: reads still ask. */
export const FS_LIST = mcp(
  "filesystem",
  "list_directory",
  "Filesystem",
  "read",
);
export const FS_WRITE = mcp("filesystem", "write_file", "Filesystem", "write");
/** A trusted, open-world remote server: entities the user never said ask as send_to. */
export const GH_SEARCH = mcp(
  "github",
  "search_repositories",
  "GitHub",
  "read",
  {
    trusted: true,
    openWorld: true,
    local: false,
    transport: "http",
    params: "query (text)",
  },
);
export const SCRATCH_DELETE = mcp(
  "scratch",
  "notes_delete_all",
  "Scratch",
  "destructive",
);
/** The coding agent: destructive and long-running. */
export const AGENT = mcp("claude-code", "Agent", "Claude Code", "destructive", {
  longRunning: true,
  local: false,
  timeoutMs: TOOL_LIMITS.longRunningTimeoutMs,
  params: "prompt (text), description? (text)",
});
/** A shell by another name: the registry never lists it; policy refuses it anyway. */
export const SHELL = mcp("scratch", "bash", "Scratch", "read", {
  trusted: true,
});

export const CATALOGUE: ToolSpec[] = [
  CALENDAR_LIST,
  CALENDAR_ADD,
  REMINDERS_LIST,
  REMINDER_ADD,
  FS_LIST,
  FS_WRITE,
  GH_SEARCH,
  SCRATCH_DELETE,
  AGENT,
];

const REQUIRED: Record<string, string[]> = {
  apple__calendar_list_events: ["from", "to"],
  apple__calendar_create_event: ["title", "start"],
  apple__reminders_list: [],
  apple__reminders_create: ["title"],
  files__read_text_file: ["path"],
  files__append_text_file: ["path", "text"],
  files__replace_file_text: ["path", "text"],
  files__list_directory: ["path"],
  files__rename_file: ["path", "newName"],
  files__move_file: ["path", "toFolder"],
  filesystem__list_directory: ["path"],
  filesystem__write_file: ["path", "content"],
  github__search_repositories: ["query"],
  scratch__notes_delete_all: [],
  "claude-code__Agent": ["prompt"],
  web__read_page_text: ["url"],
  web__read_current_page: [],
};
const leaves = (value: unknown, skip: Set<string>, out: string[] = []) => {
  if (typeof value === "string" || typeof value === "number")
    out.push(String(value));
  else if (Array.isArray(value)) for (const v of value) leaves(v, skip, out);
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value))
      if (!skip.has(k)) leaves(v, skip, out);
  return out;
};
const questionOf = (
  spec: ToolSpec,
  args: Record<string, unknown>,
): ToolQuestion => {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  switch (spec.id) {
    case CALENDAR_ADD.id:
      return {
        kind: "calendar_add",
        title: s(args.title),
        start: s(args.start),
        ...(typeof args.end === "string" ? { end: args.end } : {}),
        ...(typeof args.allDay === "boolean" ? { allDay: args.allDay } : {}),
      };
    case REMINDER_ADD.id:
      return {
        kind: "reminder_add",
        title: s(args.title),
        ...(typeof args.due === "string" ? { due: args.due } : {}),
      };
    case AGENT.id:
      return {
        kind: "agent_run",
        server: spec.title,
        folder: "/Users/me/butler-app",
      };
    case FILES_READ.id:
      return { kind: "file_read", name: baseName(args.path) };
    case FILES_APPEND.id:
      return {
        kind: "file_append",
        name: baseName(args.path),
        text: s(args.text),
      };
    case FILES_REPLACE.id:
      return {
        kind: "file_write",
        name: baseName(args.path),
        text: s(args.text),
      };
    case FILES_LIST.id:
      return { kind: "file_list", name: baseName(args.path) };
    case FILES_RENAME.id:
      return {
        kind: "file_rename",
        name: baseName(args.path),
        newName: s(args.newName),
      };
    case FILES_MOVE.id:
      return {
        kind: "file_move",
        name: baseName(args.path),
        folder: baseName(args.toFolder),
      };
    case WEB_READ.id:
    case WEB_CURRENT.id:
      return { kind: "web_read", host: s(args.url) };
    default:
      return {
        kind:
          spec.tier === "read"
            ? "mcp_read"
            : spec.tier === "destructive"
              ? "mcp_destructive"
              : "mcp_write",
        server: spec.title,
        tool: spec.name,
      };
  }
};
/** The registry's synchronous validation, for the fake catalogue; the words as the runner hands them (ToolWords). */
export function prepare(
  spec: ToolSpec,
  args: Record<string, unknown>,
  words?: ToolWords,
): ToolPrepared {
  const required = REQUIRED[spec.id] ?? [];
  if (required.some((k) => typeof args[k] !== "string"))
    return { ok: false, problem: "invalid_args" };
  // The web tool judges the address (or the page in front, from the words)
  // before policy: not http(s) or on this Mac is bad_url, a protected host
  // protected_site, no page in front no_page; an accepted one grounds on
  // its host and asks the web_read kind, which a trusted read never renders.
  if (spec.provider === "web") {
    const address =
      spec.id === WEB_READ.id ? String(args.url) : words?.pageAddress;
    if (!address) return { ok: false, problem: "no_page" };
    let url: URL;
    try {
      url = new URL(address);
    } catch {
      return { ok: false, problem: "bad_url" };
    }
    if (!/^https?:$/.test(url.protocol) || url.username)
      return { ok: false, problem: "bad_url" };
    if (
      FAKE_PROTECTED.some(
        (d) => url.hostname === d || url.hostname.endsWith("." + d),
      )
    )
      return { ok: false, problem: "protected_site" };
    if (/^(?:127\.|localhost$|10\.|192\.168\.)/.test(url.hostname))
      return { ok: false, problem: "bad_url" };
    return {
      ok: true,
      question: { kind: "web_read", host: url.hostname },
      groundText: [url.hostname],
      argsBytes: JSON.stringify(args).length,
    };
  }
  // The files tool refuses a path outside the rules before policy, and
  // grounds the call on the ~/ path alone (the text is the file's content).
  if (spec.provider === "files") {
    const path = String(args.path);
    if (!path.startsWith("~/") && !path.startsWith(`${FAKE_HOME}/`))
      return { ok: false, problem: "bad_path" };
    if (/(?:^|\/)\.|\/\.\.(?:\/|$)|^~\/Library\//.test(homeRelative(path)))
      return { ok: false, problem: "bad_path" };
    // The real tool's content-keeping rule (src/tools/providers/files.ts):
    // a replace of the one file that holds text needs a replacing word.
    if (
      spec.id === FILES_REPLACE.id &&
      homeRelative(path) === FAKE_NOTES &&
      !asksToReplace(words?.userWords)
    )
      return { ok: false, problem: "would_erase" };

    // A move grounds on the file and the folder it goes to; a rename's new
    // name is content, like a write's text.
    return {
      ok: true,
      question: questionOf(spec, args),
      groundText: [
        homeRelative(path),
        ...(spec.id === FILES_MOVE.id ? [homeRelative(args.toFolder)] : []),
      ],
      argsBytes: JSON.stringify(args).length,
    };
  }
  return {
    ok: true,
    question: questionOf(spec, args),
    groundText: leaves(args, new Set(spec.dateKeys)),
    argsBytes: JSON.stringify(args).length,
  };
}

export const ok = (
  spec: ToolSpec,
  body: string,
  extra: Partial<ToolOutcome> = {},
): ToolOutcome => ({
  code: "ok",
  text: TOOL_RESULT_TEXT[extra.verified ? "ok_verified" : "ok"]
    .replace("{id}", spec.id)
    .replace("{body}", body),
  resultBytes: body.length,
  resultItems: 1,
  durationMs: 12,
  ...extra,
});
export const failed = (
  spec: ToolSpec,
  code: Exclude<ToolOutcome["code"], "ok">,
): ToolOutcome => ({
  code,
  text: (
    TOOL_RESULT_TEXT[code as keyof typeof TOOL_RESULT_TEXT] ??
    TOOL_RESULT_TEXT.error
  )
    .replace("{id}", spec.id)
    .replace("{title}", spec.title)
    .replace("{seconds}", "20")
    .replace("{body}", "it did not work"),
  resultBytes: 0,
  resultItems: 0,
  durationMs: 20000,
});
/** The event the bridge reads back after "add dentist tomorrow at 6 PM". */
export const DENTIST_FACTS = {
  kind: "event" as const,
  title: "Dentist",
  start: "2026-09-19T18:00",
  end: "2026-09-19T19:00",
  allDay: false,
  calendar: "Home",
};
const defaultOutcome = (
  spec: ToolSpec,
  args: Record<string, unknown>,
): ToolOutcome => {
  switch (spec.id) {
    case CALENDAR_LIST.id:
      return ok(spec, "Design review at 3 · Dentist at 6", {
        lines: ["Design review at 3", "Dentist at 6"],
        resultItems: 2,
      });
    case CALENDAR_ADD.id:
      return ok(spec, "Sat 19 Sep 6:00 PM to 7:00 PM · Dentist (Home)", {
        verified: true,
        facts: { ...DENTIST_FACTS, title: String(args.title ?? "Dentist") },
        undoToken: "u-1",
      });
    case REMINDER_ADD.id:
      return ok(spec, "Call Dana · due Sat 19 Sep 9:00 AM", {
        verified: true,
        facts: {
          kind: "reminder",
          title: String(args.title ?? ""),
          due: "2026-09-19T09:00",
          list: "Reminders",
        },
        undoToken: "u-2",
      });
    case FILES_READ.id:
      return ok(spec, "Research notes for benchnote0a1b");
    case FILES_APPEND.id:
      return ok(
        spec,
        `Added 1 line to ${homeRelative(args.path)}; it now holds 2 lines.`,
        {
          verified: true,
          facts: {
            kind: "file",
            name: baseName(args.path),
            change: "appended",
            lines: 1,
          },
          undoToken: "u-3",
        },
      );
    case FILES_REPLACE.id:
      return ok(spec, `Replaced the contents of ${homeRelative(args.path)}.`, {
        verified: true,
        facts: {
          kind: "file",
          name: baseName(args.path),
          change: "replaced",
          lines: 1,
        },
        undoToken: "u-4",
      });
    case FILES_LIST.id:
      return ok(spec, "receipt-1.txt (48 bytes)\nreceipt-2.txt (50 bytes)", {
        lines: ["receipt-1.txt (48 bytes)", "receipt-2.txt (50 bytes)"],
        resultItems: 2,
      });
    case WEB_READ.id:
    case WEB_CURRENT.id:
      return ok(
        spec,
        "Page: Listings, page 1 — shop.example, 64 characters of text.\n\n# Listings\nId | Price\nLST-1 | $12.00\nNext page (/tok/listings/2)",
        {
          facts: {
            kind: "page",
            title: "Listings, page 1",
            host: "shop.example",
            chars: 64,
            truncated: false,
          },
        },
      );
    case FILES_RENAME.id:
      return ok(
        spec,
        `Renamed ${homeRelative(args.path)} to ${String(args.newName ?? "")}.`,
        {
          verified: true,
          facts: {
            kind: "file",
            name: String(args.newName ?? ""),
            change: "renamed",
            from: baseName(args.path),
          },
          undoToken: "u-5",
        },
      );
    case FILES_MOVE.id:
      return ok(
        spec,
        `Moved ${homeRelative(args.path)} to ${homeRelative(args.toFolder)}/.`,
        {
          verified: true,
          facts: {
            kind: "file",
            name: baseName(args.path),
            change: "moved",
            folder: baseName(args.toFolder),
          },
          undoToken: "u-6",
        },
      );
    default:
      return ok(spec, "done");
  }
};

export type Scripted = (
  args: Record<string, unknown>,
  signal: AbortSignal,
) => ToolOutcome | Promise<ToolOutcome>;
export interface FakeTools {
  access: ToolAccess;
  calls: { id: string; args: Record<string, unknown> }[];
  listCalls: string[];
  /** Script the next outcomes of one tool; the default outcome otherwise. */
  script(id: string, next: Scripted): void;
  undo?: ToolOutcome;
  undoCalls: number;
}
export function fakeTools(
  o: {
    tools?: ToolSpec[];
    unavailable?: ToolList["unavailable"];
    list?: (task: string, signal: AbortSignal) => Promise<ToolList>;
    clock?: ToolClock;
  } = {},
): FakeTools {
  const scripts = new Map<string, Scripted>();
  const fake: FakeTools = {
    calls: [],
    listCalls: [],
    undoCalls: 0,
    script: (id, next) => scripts.set(id, next),
    access: {
      clock: () => o.clock ?? CLOCK,
      list: async (task, signal) => {
        fake.listCalls.push(task);
        if (o.list) return o.list(task, signal);
        return {
          tools: o.tools ?? CATALOGUE,
          unavailable: o.unavailable ?? [],
        };
      },
      prepare,
      call: async (spec, args, signal) => {
        fake.calls.push({ id: spec.id, args });
        const scripted = scripts.get(spec.id);
        return scripted ? scripted(args, signal) : defaultOutcome(spec, args);
      },
      undoLast: async () => {
        fake.undoCalls++;
        return fake.undo;
      },
    },
  };
  return fake;
}
