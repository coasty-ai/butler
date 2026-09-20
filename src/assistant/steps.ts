/**
 * One short line per executed action, for status answers and progress
 * updates. The line says what kind of thing happened, never what was typed:
 * type_text becomes "typed N characters", so a password or a message body
 * can never be read back over voice or texted to a phone.
 */
import { webAddress, type Action } from "../core/schema";
import { redactSecrets } from "../core/sanitize";
import { builtinToolTitle } from "../core/tool-text";

const MAX_LINE = 100;
const MAX_LABEL = 60;

/** Coding agents a relayed request may name (increment 5B). */
const AGENT_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  copilot: "Copilot",
  "cursor-agent": "Cursor",
  "windsurf-cascade": "Cascade",
};

/**
 * What a builtin tool did, by its id: fixed words, never its arguments, so
 * an event title or a search never rides into a progress line.
 */
const TOOL_STEPS: Record<string, string> = {
  apple__calendar_list_events: "read your calendar",
  apple__calendar_create_event: "added an event to Calendar",
  apple__reminders_list: "read your reminders",
  apple__reminders_create: "added a reminder",
  apple__notes_search: "searched your notes",
  apple__notes_create: "added a note in Notes",
  apple__mail_unread: "read your mail",
  apple__mail_search: "read your mail",
  apple__mail_draft: "drafted an email in Mail",
  files__read_text_file: "read a file",
  files__list_directory: "listed a folder",
  files__append_text_file: "added a line to a file",
  files__write_text_file: "replaced a file's contents",
  "claude-code__Agent": "sent a request to Claude Code",
};

const clip = (text: string, max: number) => {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
};
const basename = (path: string) =>
  path.replace(/\/+$/, "").split("/").filter(Boolean).at(-1) ?? path;

/**
 * The line for one action, or undefined for actions that are not steps
 * (waits, captures, the run's own end). Redacted and at most 100 characters.
 */
export function stepLine(action: Action): string | undefined {
  const line = describe(action);
  return line === undefined
    ? undefined
    : clip(redactSecrets(line, "[omitted]"), MAX_LINE);
}

function describe(action: Action): string | undefined {
  switch (action.type) {
    case "open_app":
      return `opened ${action.name}`;
    case "open_file":
      return `opened ${basename(action.path)}`;
    case "open_url":
      // The host alone: the address may carry the words of a search.
      return `opened ${webAddress(action.url)?.hostname.replace(/^www\./, "") ?? "a web page"}`;
    case "menu_item":
      return `chose ${action.path.join(" › ")}`;
    case "click_control":
      return `clicked “${clip(action.label, MAX_LABEL)}”`;
    case "type_text":
      // The count is the only thing the text contributes.
      return `typed ${action.text.length} character${action.text.length === 1 ? "" : "s"}`;
    case "key":
      return `pressed ${action.key}`;
    case "hotkey":
      return `pressed ${action.keys.join("+")}`;
    case "click":
    case "double_click":
    case "right_click":
    case "move":
      return "clicked on the screen";
    case "drag":
      return "dragged";
    case "scroll":
      return "scrolled";
    case "tool_call": {
      const app = builtinToolTitle(action.tool);
      return TOOL_STEPS[action.tool] ?? (app ? `used ${app}` : "used a tool");
    }
    case "wait":
    case "capture":
    case "done":
    case "fail":
    case "request_user":
      return undefined;
    default: {
      // Actions added by later increments: a relayed request to a coding
      // agent is named by the agent; anything else is not a step.
      const other = action as { type?: string; agent?: unknown };
      if (other.type === "agent_prompt")
        return `sent a request to ${
          (typeof other.agent === "string" && AGENT_NAMES[other.agent]) ||
          "the coding agent"
        }`;
      return undefined;
    }
  }
}
