import type {
  ToolAccess,
  ToolClock,
  ToolList,
  ToolOutcome,
  ToolPrepared,
  ToolQuestion,
  ToolSpec,
} from "../src/core/tools";
import { TOOL_LIMITS, TOOL_RESULT_TEXT } from "../src/core/tools";

/**
 * A fake tool layer for the runner and policy tests: a builtin calendar and
 * reminders set (facts and lines), an untrusted filesystem server, a trusted
 * open-world GitHub server, a destructive scratch server and the coding
 * agent's long-running Agent. Outcomes are scripted per tool id; every call
 * is recorded.
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
  filesystem__list_directory: ["path"],
  filesystem__write_file: ["path", "content"],
  github__search_repositories: ["query"],
  scratch__notes_delete_all: [],
  "claude-code__Agent": ["prompt"],
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
/** The registry's synchronous validation, for the fake catalogue. */
export function prepare(
  spec: ToolSpec,
  args: Record<string, unknown>,
): ToolPrepared {
  const required = REQUIRED[spec.id] ?? [];
  if (required.some((k) => typeof args[k] !== "string"))
    return { ok: false, problem: "invalid_args" };
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
