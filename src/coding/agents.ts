/**
 * Coding agents Butler hands work to by voice, and the exact commands that
 * drive them. Strings only: nothing here runs tmux or a CLI, so every argv
 * is pinned by a test without touching a terminal.
 *
 * Two transports share one vocabulary. With tmux installed, each (agent,
 * project) pair gets a detached session the owner can attach to from any
 * terminal; the task is typed into the agent's own interactive CLI and its
 * pane is read back. Without tmux (this Mac today), the CLIs' non-interactive
 * modes run one turn per process and stream JSON lines that the same
 * classifier reads. Neither transport passes a flag that widens the CLI's
 * permissions: the agent asks what it would ask anyone, and only the owner
 * answers (electron/coding.ts).
 */

export type CodingAgentId = "claude-code" | "codex";
export interface CodingAgent {
  id: CodingAgentId;
  /** Spoken and shown. */
  name: string;
  /** The executable's basename; resolved against binaryCandidates. */
  binary: string;
  /** The short form in a tmux session name. */
  short: string;
}
export const codingAgents: Record<CodingAgentId, CodingAgent> = {
  "claude-code": {
    id: "claude-code",
    name: "Claude Code",
    binary: "claude",
    short: "claude",
  },
  codex: { id: "codex", name: "Codex", binary: "codex", short: "codex" },
};
export const DEFAULT_CODING_AGENT: CodingAgentId = "claude-code";

/**
 * How the recognizer hears the agents' names: Claude Code arrives as "claude",
 * "claud", "clawed" or "cloud", Codex as "codecs" or "code x". The generic
 * forms ("the coding agent", "the agent") name whichever agent is at work,
 * or the default when none is.
 */
const CLAUDE_WORDS = String.raw`(?:claude|claud|clawed|cloud)(?: code)?`;
const CODEX_WORDS = String.raw`(?:codex|codecs|code ?x)`;
const GENERIC_AGENT_WORDS = String.raw`(?:the )?(?:coding (?:agent|assistant)|code agent|agent)`;
export const AGENT_WORDS = `(?:${CLAUDE_WORDS}|${CODEX_WORDS}|${GENERIC_AGENT_WORDS})`;
const CLAUDE = new RegExp(`^${CLAUDE_WORDS}$`);
const CODEX = new RegExp(`^${CODEX_WORDS}$`);

/** The agent the words name, or undefined for the generic forms. */
export function agentFromWords(words: string): CodingAgentId | undefined {
  const w = words.trim().toLowerCase().replace(/\s+/g, " ");
  if (CLAUDE.test(w)) return "claude-code";
  if (CODEX.test(w)) return "codex";
  return undefined;
}

/** The project folder's basename as a tmux-safe slug: "open-assist", "my-app". */
export function projectSlug(dir: string): string {
  const base = dir.replace(/\/+$/, "").split("/").pop() ?? "";
  return (
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24)
      .replace(/-+$/, "") || "project"
  );
}
/** One session per (agent, project): butler-claude-open-assist. */
export function sessionName(agent: CodingAgentId, dir: string): string {
  return `butler-${codingAgents[agent].short}-${projectSlug(dir)}`;
}
/** What the owner types in a terminal to sit in on the session. */
export function attachCommand(session: string): string {
  return `tmux attach -t ${session}`;
}

export interface Argv {
  command: string;
  args: string[];
}

/**
 * Where the CLIs live, in the order they are looked for: the user-level
 * installs first (`claude` and `codex` install to ~/.local/bin), then
 * Homebrew and the system paths. Fixed, so a directory the task text names
 * can never supply the binary.
 */
export function binaryDirs(home: string): string[] {
  return [
    `${home}/.local/bin`,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
}
export function binaryCandidates(binary: string, home: string): string[] {
  return binaryDirs(home).map((dir) => `${dir}/${binary}`);
}

/**
 * The text typed into a pane: one line, because Enter submits, and never
 * beginning with a dash, which send-keys would read as an option of its own.
 */
export function paneText(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.startsWith("-") ? ` ${flat}` : flat;
}
/** Lines the pane is read back with: enough for a permission box and its context. */
const CAPTURE_LINES = 200;
/** A detached session's size; wide enough that prompts do not wrap. */
const PANE_COLUMNS = "160";
const PANE_ROWS = "50";

/** `tmux new-session -d -s <session> -c <dir> <agent binary>`: the agent's own interactive CLI, detached. */
export function tmuxNewSession(
  session: string,
  dir: string,
  binary: string,
): Argv {
  return {
    command: "tmux",
    args: [
      "new-session",
      "-d",
      "-s",
      session,
      "-c",
      dir,
      "-x",
      PANE_COLUMNS,
      "-y",
      PANE_ROWS,
      binary,
    ],
  };
}
export function tmuxHasSession(session: string): Argv {
  return { command: "tmux", args: ["has-session", "-t", session] };
}
/** The words, typed literally, then Enter: two commands so a "-l" text is never a key name. */
export function tmuxSendText(session: string, text: string): Argv[] {
  return [
    {
      command: "tmux",
      args: ["send-keys", "-t", session, "-l", paneText(text)],
    },
    { command: "tmux", args: ["send-keys", "-t", session, "Enter"] },
  ];
}
/** One named key: Enter, Escape, C-c, or a single character such as "y" or "1". */
export function tmuxSendKey(session: string, key: string): Argv {
  return { command: "tmux", args: ["send-keys", "-t", session, key] };
}
/** Ctrl-C: interrupts the agent's current turn; the session stays. */
export const INTERRUPT_KEY = "C-c";
export function tmuxCapture(session: string): Argv {
  return {
    command: "tmux",
    args: [
      "capture-pane",
      "-p",
      "-J",
      "-S",
      `-${CAPTURE_LINES}`,
      "-t",
      session,
    ],
  };
}
export function tmuxKillSession(session: string): Argv {
  return { command: "tmux", args: ["kill-session", "-t", session] };
}

/**
 * One non-interactive turn, for a Mac without tmux. Claude Code prints its
 * stream as JSON lines (`--verbose` is what `--output-format stream-json`
 * needs under `-p`); Codex does the same with `codex exec --json`. A later
 * turn in the same conversation resumes by the id the first turn printed.
 * The prompt follows `--`, so words that begin with a dash are still words.
 */
export function printTurn(
  agent: CodingAgentId,
  task: string,
  resume?: string,
): Argv {
  const text = task.trim();
  if (agent === "claude-code")
    return {
      command: "claude",
      args: [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        ...(resume ? ["--resume", resume] : []),
        "--",
        text,
      ],
    };
  return {
    command: "codex",
    args: resume
      ? ["exec", "--json", "resume", resume, "--", text]
      : ["exec", "--json", "--", text],
  };
}

/**
 * Flags that would widen what a coding CLI may do without asking, or change
 * its configuration. None is ever constructed here: tests/coding-agents.test.ts
 * checks every argv above against this list, tests/coding-delegate.test.ts
 * every source file for the strings, and docs/CODING_AGENTS.md promises it.
 */
export const WIDENING_FLAGS: readonly string[] = [
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
  "--permission-mode",
  "--allowedTools",
  "--allowed-tools",
  "--disallowedTools",
  "--disallowed-tools",
  "--tools",
  "--settings",
  "--bare",
  "--approve-for-me",
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
  "--sandbox",
  "-s",
  "--full-auto",
  "--ask-for-approval",
  "-a",
  "--config",
  "-c",
  "--enable",
  "--disable",
  "--ignore-rules",
];
