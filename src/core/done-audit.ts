/**
 * The done audit: the objective's own requirements, read one by one against
 * the run's steps at the model's first `done`, by one plain-text call to the
 * run's model. Probe cycle 20260919-2144-9714f98 (FALSE_DONE, autonomy all,
 * gpt-5.4-mini) still had three of four dones false with no done sent back:
 * the refused-step check had no refusal to hold to, and the file check
 * (src/core/deliverables.ts) saw the named file *changed*, since the model
 * had written a note, while a step the objective names was skipped (a search
 * form never filled: two hotel runs said done after five actions with no
 * type_text, missing both dates) or a fact was missing from what was
 * written (a digest said done after fifteen actions with two of three named
 * facts absent). Size and time cannot see a skipped clause; the words can.
 *
 * The audit asks the same model, with the objective, the compact history
 * lines it already reads and its own summary, for strict JSON: every
 * requirement the objective states, whether the history shows it met, and
 * the step that met it. Any requirement unmet sends the done back once
 * (DONE_CHALLENGED, reason requirement_unmet) with the unmet requirements
 * in the model's own words. The next claim, whatever the model did since,
 * is audited once more over the new summary: a requirement still unmet
 * ends the run as REQUIREMENTS_UNMET, all met lets it stand (market 2/3 at
 * abc24ae, code-ci-status-report #1: a finishing append was challenged
 * with three of four unmet, the model appended once more and said done,
 * and the done stood unaudited because a step had run since — a false
 * done the audit had already caught). Two audits at most per run, so no
 * run loops on it. A malformed or failed reply is "audit unavailable" and
 * the done stands: the audit's own error never fails a run, and no floor
 * moves.
 *
 * Content: the requirements' words travel to the model and into the
 * history line the encrypted journal keeps; the trace (DoneAudited) carries
 * counts, a duration, a code and the unmet requirements' kinds (a fixed
 * vocabulary, REQUIREMENT_KINDS) only. This module is pure and makes no
 * call: the runner owns the call (Provider.text) and the events.
 */
import { z } from "zod";
import type {
  Observation,
  ProviderTextCall,
  ProviderTextReply,
  RunOrigin,
} from "./schema";

/** Below this many executed actions a done is not audited: nothing to read. */
export const DONE_AUDIT_MIN_ACTIONS = 3;
/** Room for a dozen requirements with a line of evidence each. */
export const DONE_AUDIT_MAX_OUTPUT_TOKENS = 700;
/** The whole call, retries included; the run's clock keeps running. */
export const DONE_AUDIT_DEADLINE_MS = 30_000;
/** Requirements past this many are dropped from the reading and the line. */
export const DONE_AUDIT_MAX_REQUIREMENTS = 12;
/** The history the audit reads, in characters; oldest lines drop first. */
const HISTORY_CHARS = 8_000;
const SUMMARY_CHARS = 600;
const OBJECTIVE_CHARS = 2_000;
/** A requirement's words in the history line, and the whole list's. */
const REQUIREMENT_CHARS = 100;
const LIST_CHARS = 200;

export const REQUIREMENT_UNMET = "requirement_unmet";

/**
 * What kind of thing a requirement asks for, as the audit files it: a fixed
 * vocabulary the trace may carry (DoneAudited unmetKinds, RunFailed
 * unmetKinds on REQUIREMENTS_UNMET), so a cycle's report can say which
 * kind of requirement the audit fails on without a word of any of them.
 * Market 2/3 at abc24ae, research-below-fold-fact #3: the grader passed
 * every check and both audits read one of four unmet, and the trace could
 * not say whether that was the save, the read or the write.
 */
export const REQUIREMENT_KINDS = [
  "open",
  "navigate",
  "read",
  "enter",
  "select",
  "write",
  "save",
  "send",
  "confirm",
  "other",
] as const;
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number];
const KIND_SET: ReadonlySet<string> = new Set(REQUIREMENT_KINDS);
/** A kind off the list, missing or not a string reads as "other"; never a rejection. */
export const requirementKind = (value: unknown): RequirementKind =>
  typeof value === "string" && KIND_SET.has(value.trim().toLowerCase())
    ? (value.trim().toLowerCase() as RequirementKind)
    : "other";

type History = Observation["history"];

const bound = (s: string, n: number) =>
  s.length > n ? s.slice(0, n - 1) + "…" : s;

/**
 * The verbs a task gives in the imperative. After a joining word ("and
 * save", "then tell me", "or fail") one of these opens a second clause; a
 * noun after the join ("the name and price") does not. `name`, `price`,
 * `note` and `file` are nouns as often as verbs and are left out.
 */
const IMPERATIVE_VERBS = [
  "open",
  "close",
  "quit",
  "write",
  "save",
  "send",
  "reply",
  "forward",
  "click",
  "press",
  "type",
  "enter",
  "find",
  "search",
  "look",
  "read",
  "check",
  "add",
  "log",
  "append",
  "create",
  "make",
  "rename",
  "move",
  "copy",
  "paste",
  "delete",
  "remove",
  "fill",
  "put",
  "record",
  "jot",
  "export",
  "download",
  "upload",
  "attach",
  "book",
  "buy",
  "order",
  "pick",
  "choose",
  "select",
  "compare",
  "sort",
  "filter",
  "scroll",
  "go",
  "navigate",
  "visit",
  "tell",
  "say",
  "report",
  "list",
  "count",
  "sum",
  "total",
  "confirm",
  "submit",
  "post",
  "draft",
  "compose",
  "archive",
  "mark",
  "flag",
  "star",
  "set",
  "turn",
  "update",
  "edit",
  "change",
  "print",
  "schedule",
  "remind",
  "review",
  "verify",
  "leave",
  "keep",
  "stop",
  "wait",
  "switch",
  "show",
  "reload",
  "refresh",
  "sign",
  "register",
  "cancel",
  "accept",
  "decline",
  "approve",
  "join",
  "call",
  "message",
  "email",
  "share",
  "invite",
  "play",
  "pause",
  "install",
  "start",
  "launch",
  "restart",
  "translate",
  "summarize",
  "extract",
  "calculate",
  "convert",
  "take",
  "capture",
  "reserve",
  "get",
  "give",
  "let",
  "bring",
  "drag",
  "hover",
  "answer",
  "ask",
  "remember",
  "note",
] as const;

const SENTENCE_END = /(?<=[.!?])\s+/;
const JOINS = ["and", "or", "then", "also", "afterwards", "after that"];
/** A joining word followed by an imperative: a second clause. */
const VERB_AFTER_JOIN = new RegExp(
  `(?:^|[\\s,;])(?:${JOINS.join("|")})\\s+(?:please\\s+|also\\s+)?(?:${IMPERATIVE_VERBS.join("|")})\\b`,
  "i",
);
/** "then" anywhere orders two steps. */
const THEN = /\bthen\b/i;
/** Three or more items: two commas and a closing "and"/"or" in one sentence. */
const COMMA_LIST = /,[^,.;:!?]+,[^,.;:!?]*\b(?:and|or)\b/i;

/**
 * Whether the objective states more than one clause, by structure alone:
 * two or more sentences, "then", an imperative verb after a joining word
 * ("and save", "or tell me"), or a comma list closed by "and"/"or". No
 * dictionary beyond the verbs above and no model call. "Open Safari",
 * "type the name", "In Safari, open the hotels page" and "Write the name
 * and price of the best hotel in ~/x.txt" are one clause; "Read the chat
 * and write a summary", "Find a hotel for A to B. Write its name and save."
 * and "… the time, the count, and the alert" are more.
 */
export function multiClause(objective: string): boolean {
  const sentences = objective
    .split(SENTENCE_END)
    .map((s) => s.trim())
    .filter((s) => /\w/.test(s));
  if (sentences.length >= 2) return true;
  const sentence = sentences[0] ?? "";
  return (
    THEN.test(sentence) ||
    VERB_AFTER_JOIN.test(sentence) ||
    COMMA_LIST.test(sentence)
  );
}

/** What decides whether a done is audited; every part is a fact the runner holds. */
export interface DoneAuditScope {
  objective: string;
  origin?: RunOrigin;
  /** The tutorial and any other synthetic run: never audited. */
  synthetic: boolean;
  /** Actions executed this run (run.actions), tool calls included. */
  actions: number;
  /** Whether the run's provider has a text path at all (Provider.text). */
  hasText: boolean;
}

/**
 * The audit runs in every autonomy mode and for bench, voice and typed runs
 * alike: it is a check, not a question. It is skipped for a synthetic run,
 * for an approved routine's replay (origin "routine": its steps are known),
 * for a run of fewer than DONE_AUDIT_MIN_ACTIONS executed actions, for a
 * one-clause objective, and when the provider has no text path.
 */
export function auditApplies(scope: DoneAuditScope): boolean {
  if (scope.synthetic || !scope.hasText) return false;
  if (scope.origin === "routine") return false;
  if (scope.actions < DONE_AUDIT_MIN_ACTIONS) return false;
  return multiClause(scope.objective);
}

export const DONE_AUDIT_PROMPT = `You audit whether a computer-use run on a Mac finished its objective. You are given the objective, the run's steps in order (each as the model proposed it, with the result the runner reported) and the model's own summary at done.
List every requirement the objective states: each distinct outcome or step it asks for (a page or app to open, a value to enter, search or select, a fact to write, a file to save, a message to send, a condition to satisfy). Split a sentence that asks for several things into one requirement each; a fact the objective names is its own requirement.
For each requirement decide from the steps and the screen at done whether the run met it. met is true only when a step shows it happened (a typed or selected value, a clicked control whose name is the value, a submitted form, a tool result, a saved file, a page reached) or the screen at done shows its outcome (a confirmation, the value in place). A tool result reporting a file created, appended, replaced, renamed or moved is that file saved: a requirement to save it is met by that same step, and no further save step is needed. A summary claiming it, a page merely opened where it could have been done, or a step whose result says no input was sent or no visible change, is not evidence.
Reply with strict JSON and nothing else, in this exact shape: {"requirements":[{"text":string,"kind":string,"met":boolean,"evidence":string|null}]}. text is the requirement in a few words from the objective; kind is one word from this list: open, navigate, read, enter, select, write, save, send, confirm, other; evidence is the step that met it (its number and action) or null when unmet. No prose, no code fence.`;

const historyLine = (entry: History[number], index: number): string => {
  const { frame_id: _frame, ...action } = entry.action ?? {};
  const shown = Object.keys(action).length ? " " + JSON.stringify(action) : "";
  return `${index + 1}. ${entry.type}${shown} -> ${entry.result}`;
};

/**
 * The call's input: the objective, the history lines the model already
 * reads (oldest first, the oldest dropped when over HISTORY_CHARS) and the
 * claimed summary. Never a screenshot.
 */
/** Characters of the screen at done the audit reads (the window title and the visible text). */
export const SCREEN_CHARS = 1_500;
/** What the run's last frame showed when the claim was made, for the audit. */
export interface DoneScreen {
  title?: string;
  text?: string;
}
export function doneAuditInput(
  objective: string,
  history: History,
  summary: string,
  screen?: DoneScreen,
): string {
  const lines = history.map(historyLine);
  const kept: string[] = [];
  let length = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = bound(lines[i], 1_200);
    if (length + line.length > HISTORY_CHARS) {
      kept.push(`… ${i + 1} earlier step${i + 1 === 1 ? "" : "s"} omitted.`);
      break;
    }
    kept.push(line);
    length += line.length + 1;
  }
  kept.reverse();
  // The screen when the claim was made: the steps' result lines say only
  // that a step executed, so a confirmation page or a value in place shows
  // here or nowhere (market 1/3 at 5e7d433: two check-ins the grader scored
  // complete were failed by audits that could not see the confirmation).
  const shown =
    screen && (screen.title || screen.text)
      ? [
          "",
          "Screen at done (window title, then visible text):",
          bound(screen.title ?? "", 200),
          bound(screen.text ?? "", SCREEN_CHARS),
        ]
      : [];
  return [
    "Objective:",
    bound(objective, OBJECTIVE_CHARS),
    "",
    "Steps (oldest first):",
    kept.length ? kept.join("\n") : "(none)",
    ...shown,
    "",
    "Summary at done:",
    bound(summary, SUMMARY_CHARS),
  ].join("\n");
}

/** The text call the runner makes, ready for Provider.text. */
/**
 * The line appended to the input on the one retry after an unusable reply
 * (prose, a fence with no object, a wrong shape): market 1/3 at 5e7d433,
 * travel-hotel-shortlist #1 — the first audit answered nothing usable and
 * the done stood with the dates never searched.
 */
export const DONE_AUDIT_REMINDER =
  'Reply with the JSON object only, nothing before or after it: {"requirements":[{"text":"…","kind":"…","met":true,"evidence":"…"}]}.';
export function doneAuditCall(
  objective: string,
  history: History,
  summary: string,
  retry = false,
  screen?: DoneScreen,
): ProviderTextCall {
  return {
    system: DONE_AUDIT_PROMPT,
    input:
      doneAuditInput(objective, history, summary, screen) +
      (retry ? `\n\n${DONE_AUDIT_REMINDER}` : ""),
    maxOutputTokens: DONE_AUDIT_MAX_OUTPUT_TOKENS,
    effort: "low",
    deadlineMs: DONE_AUDIT_DEADLINE_MS,
  };
}

export interface Requirement {
  text: string;
  /** One of REQUIREMENT_KINDS; "other" when the reply gave none or one off the list. */
  kind: RequirementKind;
  met: boolean;
  evidence: string | null;
}
export interface DoneAudit {
  requirements: Requirement[];
  unmet: Requirement[];
}

const requirementSchema = z.object({
  text: z.string().trim().min(1),
  // Any value or none: read as a kind below, never a reason to reject.
  kind: z.unknown().optional(),
  met: z.boolean(),
  evidence: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
});
export const doneAuditSchema = z.object({
  requirements: z.array(requirementSchema).min(1),
});

/**
 * The reply's JSON object, whatever surrounds it: a code fence, a lead-in,
 * a trailing remark. The first "{" to the last "}".
 */
function jsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  return text.slice(start, end + 1);
}

/**
 * The audit the reply states, or undefined when the reply is not one:
 * not JSON, not the shape, a non-boolean `met`, no requirement at all, or a
 * reply the provider marked refused or empty. undefined is "audit
 * unavailable": the done stands.
 */
export function parseDoneAudit(
  reply: Pick<ProviderTextReply, "text" | "code">,
): DoneAudit | undefined {
  if (reply.code === "refused" || reply.code === "empty") return undefined;
  const json = jsonObject(reply.text);
  if (!json) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return undefined;
  }
  const parsed = doneAuditSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const requirements = parsed.data.requirements
    .slice(0, DONE_AUDIT_MAX_REQUIREMENTS)
    .map((r) => ({
      text: bound(r.text, 200),
      kind: requirementKind(r.kind),
      met: r.met,
      evidence: r.evidence === null ? null : bound(r.evidence, 200),
    }));
  return { requirements, unmet: requirements.filter((r) => !r.met) };
}

/**
 * The history line for a done sent back with requirements unmet: the
 * requirements in the audit's own words (each bounded, the list bounded),
 * the two routes left, and what the next done's summary must name. Once
 * per run; the line says so, and that the next done is checked once more
 * against these requirements and ends the run if one is still unmet.
 */
export function requirementChallenge(unmet: Requirement[]): string {
  const names = bound(
    unmet.map((r) => `“${bound(r.text, REQUIREMENT_CHARS)}”`).join("; "),
    LIST_CHARS,
  );
  const several = unmet.length > 1;
  return `Not accepted yet. The objective's requirements were read against this run's steps and ${unmet.length} ${several ? "were" : "was"} not met: ${names}. If ${several ? "they are" : "it is"} still to do, continue: do ${several ? "them" : "it"} (enter, select or write what the objective names, then save or submit) and say done with a summary that names the step that met each. If ${several ? "one" : "it"} cannot be done, say fail and name what blocks it. The next done is checked once more; one still unmet ends the run as not done.`;
}

/**
 * The runner's own ending for a claim repeated after a requirement
 * challenge whose second audit still finds a requirement unmet: the model
 * was told what the objective still asked for and said done again with it
 * still undone. Probe 20260920-0055-a897a04, travel-hotel-shortlist #1:
 * the audit read seven requirements with two unmet (the dates were never
 * searched), the claim was sent back, the model captured once and said
 * done again, and the second done stood — graded DATES_NOT_SEARCHED. The
 * hearing first covered a claim with nothing but looks since; market 2/3
 * at abc24ae (code-ci-status-report #1) showed one append after the
 * challenge let a false done stand unaudited, so every claim after the
 * challenge is audited once more, whatever ran since. A false done becomes
 * an honest fail; a claim the second audit finds complete stands.
 */
export const REQUIREMENTS_UNMET = "REQUIREMENTS_UNMET";
export function requirementsUnmet(unmet: Requirement[]): string {
  const names = bound(
    unmet.map((r) => `“${bound(r.text, REQUIREMENT_CHARS)}”`).join("; "),
    LIST_CHARS,
  );
  const several = unmet.length > 1;
  return `Not done: ${unmet.length} requirement${several ? "s" : ""} of the objective ${several ? "were" : "was"} still not met after the check: ${names}.`;
}
export class RequirementsUnmetError extends Error {
  readonly code = REQUIREMENTS_UNMET;
  constructor(readonly unmet: Requirement[]) {
    super(requirementsUnmet(unmet));
    this.name = "RequirementsUnmetError";
  }
}
