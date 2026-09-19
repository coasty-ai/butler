/**
 * What a coding agent's terminal shows, read without a model: working, asking
 * a yes-or-no or permission question, asking something in words, idle at its
 * prompt, finished (with what it said last), or failed. Two readers give the
 * same vocabulary: classifyPane for the text of a tmux pane, readStreamLine
 * for one JSON line of a CLI's non-interactive stream.
 *
 * Pane text is the agent's own output and whatever a repository made it
 * print: untrusted. It decides only which of a few fixed states the pane is
 * in, and the question or summary it hands back is quoted, bounded and left
 * for the speech filters to judge (src/coding/lines.ts). Nothing here answers
 * anything: the keys a prompt would take are named so the owner's own words
 * can press exactly one of them, and only theirs (electron/coding.ts).
 *
 * The prompt shapes come from the Claude Code and Codex CLIs as authored in
 * tests/coding-classify.test.ts; a live run tunes them.
 */
import type { CodingAgentId } from "./agents";

export type PaneStatus =
  | "working"
  | "asks_yes_no"
  | "asks_text"
  | "idle"
  | "finished"
  | "error"
  | "unknown";
/** The tmux key names that answer a yes-or-no prompt each way. */
export interface AnswerKeys {
  yes: string;
  no: string;
}
export interface PaneReading {
  status: PaneStatus;
  /** The agent's question, verbatim minus box glyphs; at most QUESTION_MAX characters. */
  question?: string;
  /** What the agent said last, for "read me the summary"; at most SUMMARY_MAX characters. */
  summary?: string;
  keys?: AnswerKeys;
}
export interface StreamReading extends PaneReading {
  /** The id a later turn resumes the conversation by. */
  resumeId?: string;
}

export const QUESTION_MAX = 240;
export const SUMMARY_MAX = 600;
/** The bottom of the pane that says what the agent is doing right now. */
const STATUS_TAIL = 8;

const BOX_GLYPHS = /[│┃║╭╮╯╰┌┐└┘├┤┬┴╔╗╚╝╠╣╦╩─━═┼▌▐]+/g;
/** A pane line with box drawing gone and spaces collapsed. */
function cleanLine(raw: string): string {
  return raw.replace(BOX_GLYPHS, " ").replace(/\s+/g, " ").trim();
}
/** The matching form: lowercase, an ellipsis as three dots. */
function norm(line: string): string {
  return line.toLowerCase().replace(/…/g, "...");
}
function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

// A numbered option as both CLIs draw one: "❯ 1. Yes", "  2. Yes, and don't
// ask again …", "3. No, and tell Claude what to do differently (esc)",
// "› 1. Yes (y)". The marker before the number is the highlighted choice,
// and a prompt always has one: a numbered list in the agent's prose does not.
const OPTION = /^(?:[❯›>▸•]\s*)?(\d)\.\s+(.+)$/;
const HIGHLIGHTED = /^[❯›▸]\s*\d\.\s/;
const YES_OPTION = /^yes\b/;
const NO_OPTION = /^no\b/;
const DONT_ASK_AGAIN = /don'?t ask again|always|for this session/;
/** A line that is the agent's input prompt, empty or showing its placeholder. */
const PROMPT: Record<CodingAgentId, RegExp> = {
  "claude-code": /^>\s*(?:try ["“].*["”]\s*)?$/,
  codex: /^›\s*(?:ask codex.*)?$/,
};
/** Hints drawn under an idle prompt. */
const PROMPT_HINTS = [
  /\? for shortcuts/,
  /⏎ send/,
  /accept edits on/,
  /plan mode on/,
  /bypass permissions on/,
];
const WORKING = [
  /esc to interrupt/,
  /ctrl\+c to interrupt/,
  // A spinner's verb: "✻ thinking… (3s · ↑ 1.2k tokens)", "· working…",
  // "compacting conversation…". One or two words: a sentence of the agent's
  // own ("⏺ Let me look at the tests…") is not a spinner.
  /^(?![⏺●•])\W{0,3}[a-z]+(?: [a-z]+)?\.\.\.(?:\s*\(.*)?$/,
  /^[•▌]?\s*working(?:\s*\(|\b)/,
];
// After Escape: the agent stopped and waits; the owner knows why.
const INTERRUPTED = /interrupted · what should \w+ do instead\?/;
const ERROR = [
  /^(?:⎿\s*)?api error/,
  /^error[: ]/,
  /rate limit/,
  /connection (?:lost|failed|refused)/,
  /stream (?:error|disconnected)/,
  /^reconnecting/,
  /^failed to /,
];
// The echo of what the user typed, above the agent's answer.
const USER_ECHO = /^[>›]\s+\S/;
// Claude Code's tool calls and their results: "⏺ Bash(npm test)", "⎿ 3 tests
// passed". Codex's activity lines: "• Ran npm test", "• Edited src/a.ts".
const TOOL_CALL = /^[⏺●]\s+[A-Z][A-Za-z]*\(/;
/** Lines that are markers of the agent's activity, not context for a question. */
const MARKED = /^[⏺●•⎿›>└├]/;
const TOOL_RESULT = /^⎿/;
const CODEX_ACTIVITY =
  /^•\s+(?:ran|edited|explored|read|searched|listed|added|removed|updated|wrote|created|deleted|viewed|checked|applied|installed|working|thinking)\b/i;
const CODEX_LABEL = /^(?:codex|user)$/;
/** Continuation of the line above: indented, or a tree/result glyph. */
const CONTINUATION = /^(?:\s{2,}|[└├│┃⎿]\s)/;

interface Line {
  text: string;
  key: string;
  raw: string;
}
function lines(pane: string): Line[] {
  return pane
    .split(/\r?\n/)
    .map((raw) => {
      const text = cleanLine(raw);
      return { text, key: norm(text), raw };
    })
    .filter((line) => line.text);
}

/**
 * A yes-or-no prompt on screen: an option block with a Yes and a No, and the
 * question above it. The question is the nearest line ending in "?" within a
 * few lines above the options, with the lines between the box's start (or a
 * few lines up) and it as context: the tool, the command or the file.
 */
function yesNoPrompt(
  agent: CodingAgentId,
  all: Line[],
): Pick<PaneReading, "question" | "keys"> | undefined {
  const tail = all.slice(-24);
  const options = tail
    .map((line, i) => ({ i, m: OPTION.exec(line.text) }))
    .filter((o): o is { i: number; m: RegExpExecArray } => !!o.m);
  if (
    options.length < 2 ||
    !options.some((o) => HIGHLIGHTED.test(tail[o.i].text))
  )
    return undefined;
  const labelled = options.map((o) => ({
    i: o.i,
    n: o.m[1],
    key: norm(o.m[2]),
  }));
  // The plain yes is the only yes ever pressed: never a "don't ask again".
  const yes = labelled.find(
    (o) => YES_OPTION.test(o.key) && !DONT_ASK_AGAIN.test(o.key),
  );
  const no = labelled.find((o) => NO_OPTION.test(o.key));
  if (!yes || !no) return undefined;
  const first = Math.min(...labelled.map((o) => o.i));
  let q = -1;
  for (let i = first - 1; i >= Math.max(0, first - 8); i--)
    if (tail[i].text.endsWith("?")) {
      q = i;
      break;
    }
  if (q < 0) return undefined;
  const context = tail
    .slice(Math.max(0, q - 5), q)
    .filter(
      (line) =>
        !OPTION.test(line.text) &&
        !MARKED.test(line.text) &&
        !MARKED.test(line.raw.trim()),
    )
    .map((line) => line.text);
  const question = clip([...context, tail[q].text].join(" — "), QUESTION_MAX);
  // Codex names its keys in the options ("(y)", "(n)"); Claude Code takes
  // the option's number, and Escape for "No, and tell Claude what to do
  // differently (esc)".
  const yesHint = /\((y)\)\s*$/.exec(yes.key);
  const noHint = /\((n|esc)\)\s*$/.exec(no.key);
  const keys: AnswerKeys = {
    yes: yesHint ? "y" : yes.n,
    no: noHint
      ? noHint[1] === "esc"
        ? "Escape"
        : "n"
      : agent === "claude-code"
        ? "Escape"
        : no.n,
  };
  return { question, keys };
}

/** Whether the bottom of the pane shows the agent's own input prompt. */
function promptVisible(agent: CodingAgentId, tail: Line[]): boolean {
  return tail.some(
    (line) =>
      PROMPT[agent].test(line.key) ||
      PROMPT_HINTS.some((hint) => hint.test(line.key)),
  );
}

/** The lines after the echo of what the user last typed: the agent's answer to it. */
function sinceLastUser(agent: CodingAgentId, all: Line[]): Line[] {
  for (let i = all.length - 1; i >= 0; i--)
    if (USER_ECHO.test(all[i].text) && !PROMPT[agent].test(all[i].key))
      return all.slice(i + 1);
  return all;
}

/**
 * The agent's own words, as blocks: a marker line ("⏺ …" for Claude Code, a
 * plain or "• …" line for Codex) with its indented continuation. Tool calls,
 * their results and Codex's activity lines are not words to the user and are
 * left out.
 */
function speechBlocks(agent: CodingAgentId, since: Line[]): string[] {
  const blocks: string[] = [];
  let skipping = false;
  for (const line of since) {
    const t = line.text;
    if (
      PROMPT[agent].test(line.key) ||
      PROMPT_HINTS.some((hint) => hint.test(line.key)) ||
      OPTION.test(t) ||
      CODEX_LABEL.test(line.key) ||
      WORKING.some((w) => w.test(line.key))
    )
      continue;
    if (CONTINUATION.test(line.raw) || TOOL_RESULT.test(t)) {
      if (!skipping && blocks.length)
        blocks[blocks.length - 1] += ` ${t.replace(/^[└├│┃⎿]\s*/, "")}`;
      continue;
    }
    if (TOOL_CALL.test(t) || (agent === "codex" && CODEX_ACTIVITY.test(t))) {
      skipping = true;
      continue;
    }
    skipping = false;
    blocks.push(t.replace(/^[⏺●•]\s*/, ""));
  }
  return blocks.filter(Boolean);
}

/** The state of a pane, from its text. */
export function classifyPane(agent: CodingAgentId, pane: string): PaneReading {
  const all = lines(pane);
  if (!all.length) return { status: "unknown" };
  const tail = all.slice(-STATUS_TAIL);
  const prompt = yesNoPrompt(agent, all);
  if (prompt) return { status: "asks_yes_no", ...prompt };
  if (tail.some((line) => WORKING.some((w) => w.test(line.key))))
    return { status: "working" };
  const since = sinceLastUser(agent, all);
  // A highlighted numbered choice with no yes and no: the agent asks the
  // user to pick one. It replaces the input box while it shows.
  const recent = since.slice(-16);
  const choice = recent
    .filter((line) => OPTION.test(line.text))
    .map((line) => line.text);
  if (choice.length >= 2 && choice.some((text) => HIGHLIGHTED.test(text))) {
    const asked = recent
      .map((line) => line.text)
      .filter((text) => text.endsWith("?") && !OPTION.test(text))
      .at(-1);
    return {
      status: "asks_text",
      question: clip(
        [asked, ...choice].filter(Boolean).join(" "),
        QUESTION_MAX,
      ),
    };
  }
  if (promptVisible(agent, tail)) {
    if (since.some((line) => INTERRUPTED.test(line.key)))
      return { status: "idle" };
    const blocks = speechBlocks(agent, since);
    const last = blocks.at(-1);
    if (!last) return { status: "idle" };
    if (last.endsWith("?"))
      return { status: "asks_text", question: clip(last, QUESTION_MAX) };
    if (blocks.length === 1 && ERROR.some((e) => e.test(norm(last))))
      return { status: "error", summary: clip(last, SUMMARY_MAX) };
    return { status: "finished", summary: clip(last, SUMMARY_MAX) };
  }
  if (tail.some((line) => ERROR.some((e) => e.test(line.key))))
    return {
      status: "error",
      summary: clip(
        tail.filter((line) => ERROR.some((e) => e.test(line.key))).at(-1)!.text,
        SUMMARY_MAX,
      ),
    };
  return { status: "unknown" };
}

// What Claude Code prints in `-p` mode when a tool needed a permission the
// non-interactive session could not ask for.
const PERMISSION_REFUSED =
  /requested permissions? to use|permission (?:denied|required|not granted)|haven'?t granted|hasn'?t been granted|requires? (?:your )?(?:approval|permission)/i;

const text = (value: unknown): string =>
  typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value
          .map((part) =>
            part && typeof part === "object" && "text" in part
              ? String((part as { text: unknown }).text ?? "")
              : "",
          )
          .filter(Boolean)
          .join("\n")
      : "";
const str = (value: unknown): string | undefined =>
  typeof value === "string" && value ? value : undefined;

function readClaudeEvent(
  e: Record<string, unknown>,
): StreamReading | undefined {
  const message = (e.message ?? {}) as { content?: unknown };
  switch (e.type) {
    case "system":
      return e.subtype === "init"
        ? { status: "working", resumeId: str(e.session_id) }
        : undefined;
    case "assistant": {
      const content = Array.isArray(message.content) ? message.content : [];
      const ask = content.find(
        (c) =>
          c &&
          typeof c === "object" &&
          (c as { type?: unknown }).type === "tool_use" &&
          (c as { name?: unknown }).name === "AskUserQuestion",
      ) as { input?: { questions?: unknown } } | undefined;
      if (ask) {
        const first = Array.isArray(ask.input?.questions)
          ? (ask.input!.questions[0] as {
              question?: unknown;
              options?: { label?: unknown }[];
            })
          : undefined;
        const options = Array.isArray(first?.options)
          ? first!.options.map((o) => str(o?.label)).filter(Boolean)
          : [];
        return {
          status: "asks_text",
          question: clip(
            [str(first?.question) ?? "", ...options].join(" "),
            QUESTION_MAX,
          ),
        };
      }
      const said = text(
        content.filter(
          (c) =>
            c &&
            typeof c === "object" &&
            (c as { type?: unknown }).type === "text",
        ),
      );
      return {
        status: "working",
        ...(said ? { summary: clip(said, SUMMARY_MAX) } : {}),
      };
    }
    case "user": {
      const content = Array.isArray(message.content) ? message.content : [];
      const refused = content
        .map((c) =>
          c &&
          typeof c === "object" &&
          (c as { type?: unknown }).type === "tool_result"
            ? text((c as { content?: unknown }).content)
            : "",
        )
        .find((t) => PERMISSION_REFUSED.test(t));
      return refused
        ? { status: "asks_yes_no", question: clip(refused, QUESTION_MAX) }
        : { status: "working" };
    }
    case "result": {
      const failed = e.is_error === true || e.subtype !== "success";
      const said =
        str(e.result) ??
        (Array.isArray(e.errors) ? e.errors.map(String).join(" ") : undefined);
      return {
        status: failed ? "error" : "finished",
        ...(said ? { summary: clip(said, SUMMARY_MAX) } : {}),
        resumeId: str(e.session_id),
      };
    }
    default:
      return undefined;
  }
}

function readCodexEvent(e: Record<string, unknown>): StreamReading | undefined {
  const item = (e.item ?? {}) as Record<string, unknown>;
  switch (e.type) {
    case "thread.started":
      return { status: "working", resumeId: str(e.thread_id) };
    case "turn.started":
      return { status: "working" };
    case "item.started":
    case "item.updated":
    case "item.completed":
      if (item.type === "agent_message" && str(item.text))
        return {
          status: "working",
          summary: clip(str(item.text)!, SUMMARY_MAX),
        };
      if (item.type === "error")
        return {
          status: "error",
          ...(str(item.message)
            ? { summary: clip(str(item.message)!, SUMMARY_MAX) }
            : {}),
        };
      return { status: "working" };
    case "turn.completed":
      return { status: "finished" };
    case "turn.failed":
    case "error": {
      const error = (e.error ?? {}) as { message?: unknown };
      const said = str(error.message) ?? str(e.message);
      return {
        status: "error",
        ...(said ? { summary: clip(said, SUMMARY_MAX) } : {}),
      };
    }
    default:
      return undefined;
  }
}

/**
 * One line of a CLI's JSON stream (`claude -p --output-format stream-json`,
 * `codex exec --json`), or undefined for anything that is not one of its
 * events. A "working" reading may carry the agent's latest words as the
 * summary candidate; "finished" without one keeps the last candidate.
 */
export function readStreamLine(
  agent: CodingAgentId,
  line: string,
): StreamReading | undefined {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!event || typeof event !== "object" || Array.isArray(event))
    return undefined;
  const e = event as Record<string, unknown>;
  const reading =
    agent === "claude-code" ? readClaudeEvent(e) : readCodexEvent(e);
  if (!reading) return undefined;
  // Drop undefined fields so a reading spreads cleanly over a delegation.
  return Object.fromEntries(
    Object.entries(reading).filter(([, v]) => v !== undefined),
  ) as StreamReading;
}
