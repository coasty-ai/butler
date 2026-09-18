/**
 * One short line per executed action, for status answers and progress
 * updates. The line says what kind of thing happened, never what was typed:
 * type_text becomes "typed N characters", so a password or a message body
 * can never be read back over voice or texted to a phone.
 */
import type { Action } from "../core/schema";
import { redactSecrets } from "../core/sanitize";

const MAX_LINE = 100;
const MAX_LABEL = 60;

/** Coding agents a relayed request may name (increment 5B). */
const AGENT_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  copilot: "Copilot",
  "cursor-agent": "Cursor",
  "windsurf-cascade": "Cascade",
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
