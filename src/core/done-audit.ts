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
 * What counts as a requirement, and as evidence, is the prompt's whole
 * work, and the market sweep 1/3 at 55e4e83 (cycle 20260920-0514,
 * gpt-5.4-mini, autonomy all) taught it three readings it lacked. A clause
 * that names where or how ("Open the file in TextEdit and type …") is a
 * means: dictate-paragraph-punctuation #1 appended the sentence with the
 * files tool, the grader passed, and both audits held "open" unmet
 * (REQUIREMENTS_UNMET at 5 actions, the day's third undersold pass). A
 * clause that forbids ("keep it as a draft and don't do anything else with
 * it") is met by no step doing it: mail-draft-reply #2 kept the draft, the
 * grader passed, and both audits held one of five unmet (other, then
 * confirm) for want of a step. And the reply's room: every unusable reply
 * of the cycle, six of fourteen, used exactly the 700 output tokens the cap
 * allowed (the usable ones 212–586) — a reasoning model's thinking counts
 * against the cap on OpenAI and Gemini, and "file each message" lists a
 * requirement a message — so travel-hotel-shortlist #1 and
 * mail-triage-backlog #1 were cut on both attempts, read "unavailable",
 * and two false dones stood. The prompt now states the means rule, the
 * forbidding-clause rule, the control whose name is the action asked for
 * and the app or file a step opened as evidence, and asks for at most
 * DONE_AUDIT_MAX_REQUIREMENTS requirements, text in a few words and
 * evidence the step's number alone; the cap is DONE_AUDIT_MAX_OUTPUT_TOKENS,
 * and the retry's reminder asks for the same bounds.
 *
 * What the audit can see decides what it can catch. Sweep B at bceb9cd
 * (cycle 20260920-0957-bceb9cd, gpt-5.4-mini cell, the audit on gpt-5.4
 * through --audit-model), memory-link-to-note #1: a web read, four
 * captures and an append_text_file marked finish; the grader found the
 * title in the file and none of the three findings, and the audit (1,357
 * input, 1,490 output tokens) read seven requirements all met. It could
 * not do better: the appended text sat inside the append action's JSON in
 * one history line and the page's text inside the read's result line, both
 * cut at 1,200 characters (the model's copy of an older result at 640), so
 * no auditor could compare three facts against a page from that. The same
 * shape gave the day's false dones on msg-group-chat-digest (facts
 * missing), mail-draft-reply (the wrong sentence), ops-support-ticket-draft
 * (the wrong draft) and travel-hotel-shortlist (dates never searched): the
 * artifact the user gets was never shown whole. Since then the input
 * carries the run's deliverables (DoneEvidence): the files the run wrote
 * through the files tool, most recent first, then the file the task names,
 * at most DELIVERABLES_MAX, each read back at the claim and shown up to
 * DELIVERABLE_CHARS (a longer file its start and its end, since an append
 * lands at the end), or "could not be read"; and the newest ok web read's
 * result up to PAGE_READ_CHARS in place of its cut history line. The whole
 * input stays under AUDIT_INPUT_CHARS: the oldest steps give way first
 * (never under HISTORY_MIN_CHARS), then the page read. The prompt says a
 * fact absent from the deliverable is unmet whatever the summary says.
 *
 * Which claims are audited (auditApplies): never a synthetic run, a
 * routine's replay or a run of fewer than DONE_AUDIT_MIN_ACTIONS actions;
 * beyond that, an objective of more than one clause by structure
 * (multiClause), or any objective when a stronger auditor is configured
 * (strongAuditorConfigured: a dialogModel that is not the run model — the
 * cycle's --audit-model, or an owner's dialog model in the app). The
 * one-clause gate spares a trivial task ("open Safari") a model call and
 * a weak auditor's false challenge, and it cost a real one: sweep B 2/3 at
 * 2308fd9 (cycle 20260920-1049-2308fd9, gpt-5.4-mini cell, the audit on
 * gpt-5.4), files-rename-receipts #1 — a list, four reads and three
 * renames, the third marked finish, fourteen actions — ended RunCompleted
 * with no DoneAudited row, since "rename the receipts in {folder} to
 * <a pattern>" is one sentence with no join, and the grader read the three
 * files renamed to the wrong names. With a strong auditor the call costs
 * about $0.02 and its judgment is worth having on every claim that did
 * real work; with none, the gate stands as before.
 *
 * Content: the requirements' words travel to the model and into the
 * history line the encrypted journal keeps; a deliverable's content and the
 * page's text travel to the model only, as the history lines do; the trace
 * (DoneAudited) carries counts, a duration, a code, the unmet requirements'
 * kinds (a fixed vocabulary, REQUIREMENT_KINDS), how many deliverables were
 * shown and whether a page read was, never a word of any. This module is
 * pure and makes no call or read: the runner owns the call (Provider.text),
 * the reading (RunnerExtras.deliverableText) and the events.
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
/**
 * Room for the reply: a requirement written as {"text","kind","met",
 * "evidence"} with a sentence of evidence is about 90 tokens, so twelve
 * (DONE_AUDIT_MAX_REQUIREMENTS) are about 1,080, plus the object's own
 * words and a reasoning model's thinking, which OpenAI and Gemini count
 * against this cap. At 700, market 1/3 at 55e4e83 (gpt-5.4-mini, effort
 * low; the first cycle with `kind` in the shape) cut six of fourteen audit
 * replies at exactly the cap while the usable ones ran 212–586 tokens; two
 * runs were cut on both attempts and their false dones stood as
 * "unavailable" (abc24ae had 1 unavailable in 17, c8c9e10 1 in 13, this
 * cycle 4 in 15). With evidence the step's number a requirement is nearer
 * 40 tokens, so a dozen fit in 500 and the rest is thinking room.
 */
/**
 * 4,000 since cd48fe2 asked for medium effort: market 3/3 at 72ef8e4
 * (cycle 20260920-0631, checkin-flight-seat #1) spent exactly 1,400 output
 * tokens on both attempts — OpenAI counts the thinking against this cap and
 * medium thinking alone can pass 1,000 — so the reply was cut twice and a
 * false done stood as "unavailable". The reply itself stays near 500.
 */
export const DONE_AUDIT_MAX_OUTPUT_TOKENS = 4_000;
/** The whole call, retries included; the run's clock keeps running. */
export const DONE_AUDIT_DEADLINE_MS = 30_000;
/** The auditor's reasoning effort; see doneAuditCall for why not low. */
export const DONE_AUDIT_EFFORT = "medium" as const;
/** Requirements past this many are dropped from the reading and the line. */
export const DONE_AUDIT_MAX_REQUIREMENTS = 12;
/** The history the audit reads, in characters; oldest lines drop first. */
const HISTORY_CHARS = 8_000;
/**
 * The newest steps are kept to at least this many characters whatever the
 * evidence sections need: the write step and the claim are the steps the
 * audit cites as evidence numbers. Two or three whole lines at 1,200.
 */
export const HISTORY_MIN_CHARS = 2_500;
/**
 * The whole input, in characters (about 3,500 tokens): the objective (at
 * most 2,000), the steps, the screen at done (1,700), up to three
 * deliverables (about 1,750 each with the path and the cut marker), the
 * page read and the summary (600). The objective, screen, deliverables and
 * summary always fit (about 10,200 at most); the steps give way first, down
 * to HISTORY_MIN_CHARS, then the page read, down to PAGE_READ_MIN_CHARS,
 * and 10,200 + 2,500 + 300 stays under the budget.
 */
export const AUDIT_INPUT_CHARS = 14_000;
/**
 * Characters of a deliverable's content the audit reads. A longer file
 * shows its first DELIVERABLE_HEAD_CHARS and its end, with the cut counted
 * between: an append lands at the end of a file that may hold earlier
 * notes, and a head alone would show the auditor the old notes and hide
 * the new ones.
 */
export const DELIVERABLE_CHARS = 1_500;
export const DELIVERABLE_HEAD_CHARS = 500;
/** Files the audit reads back at a claim, most recently written first. */
export const DELIVERABLES_MAX = 3;
/**
 * Characters of the newest ok web read's result the audit gets, whole from
 * the tool layer's result (WEB_LIMITS.resultChars 30,400) rather than the
 * 1,200-character history line, and the least it keeps when the input is
 * full.
 */
export const PAGE_READ_CHARS = 2_500;
export const PAGE_READ_MIN_CHARS = 300;
/** A deliverable's path in its section. */
const PATH_CHARS = 200;
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
  /**
   * Whether the audit runs on a stronger model than the run's
   * (strongAuditorConfigured over the run's settings): then a one-clause
   * objective is audited too.
   */
  strongAuditor: boolean;
}

/**
 * Whether the settings put the audit on a model of its own: a dialogModel
 * that is a non-empty string and not the run model (the text path resolves
 * dialogModel || model, src/providers/text.ts textSettings; the cycle's
 * --audit-model sets it, and so does an owner's dialog model in the app).
 * Pure; reads two fields and nothing else.
 */
export function strongAuditorConfigured(settings: {
  model: string;
  dialogModel?: string;
}): boolean {
  const dialog = settings.dialogModel;
  return (
    typeof dialog === "string" && dialog !== "" && dialog !== settings.model
  );
}

/**
 * The audit runs in every autonomy mode and for bench, voice and typed runs
 * alike: it is a check, not a question. It is skipped for a synthetic run,
 * for an approved routine's replay (origin "routine": its steps are known),
 * for a run of fewer than DONE_AUDIT_MIN_ACTIONS executed actions, and when
 * the provider has no text path. Past those, every objective is audited
 * when a stronger auditor is configured (strongAuditor), and otherwise only
 * one of more than one clause (multiClause): the one-clause gate is there
 * to spare a trivial task a call and a weak auditor's false challenge, and
 * at 2308fd9 it let a fourteen-action rename run stand unaudited with its
 * files renamed wrong (the module header).
 */
export function auditApplies(scope: DoneAuditScope): boolean {
  if (scope.synthetic || !scope.hasText) return false;
  if (scope.origin === "routine") return false;
  if (scope.actions < DONE_AUDIT_MIN_ACTIONS) return false;
  return scope.strongAuditor || multiClause(scope.objective);
}

export const DONE_AUDIT_PROMPT = `You audit whether a computer-use run on a Mac finished its objective. You are given the objective, the run's steps in order (each as the model proposed it, with the result the runner reported) and the model's own summary at done.
List every requirement the objective states: each distinct outcome or step it asks for (a page or app to open, a value to enter, search or select, a fact to write, a file to save, a message to send, a condition to satisfy). Split a sentence that asks for several things into one requirement each; a fact the objective names is its own requirement. List at most ${DONE_AUDIT_MAX_REQUIREMENTS}.
For each requirement decide from the steps and the screen at done whether the run met it. met is true only when a step shows it happened (a typed or selected value, a clicked control whose name is the value or the action asked for, such as Keep draft, Apply, Save or Add to basket, a submitted form, a tool result, a saved file, a page reached, an app or file a step opened) or the screen at done shows its outcome (a confirmation, the value in place). A tool result reporting a file created, appended, replaced, renamed or moved is that file saved: a requirement to save it is met by that same step, and no further save step is needed. When the input shows a deliverable at done (the content of a file the run wrote) or the last page read, a requirement to write, add or note facts is met only when the deliverable's content shows those facts: a fact the objective asks for, named in it or read from the page, that is absent from the deliverable is unmet, whatever the summary says. A clause that only names where or how to do something (open a file or app, use an app, go to a page) is a means, not an outcome: when the outcome it serves is met by a tool result or on screen, the means is met too, with that step as evidence; a clause that is itself an outcome the user wants (a page left open, an app brought to the front, a file opened for them to read) stays a requirement. A clause that forbids something (do not send, do not change anything else, leave the rest untouched) is met when no step did it: answer met true with evidence null, never unmet for want of a step. A summary claiming it, a page merely opened where it could have been done, or a step whose result says no input was sent or no visible change, is not evidence.
Reply with strict JSON and nothing else, in this exact shape: {"requirements":[{"text":string,"kind":string,"met":boolean,"evidence":number|null}]}. text is the requirement in a few words from the objective; kind is one word from this list: open, navigate, read, enter, select, write, save, send, confirm, other; evidence is the number of the step that met it (an integer, nothing else), or null when unmet or when nothing needed doing. No prose, no code fence.`;

const historyLine = (entry: History[number], index: number): string => {
  const { frame_id: _frame, ...action } = entry.action ?? {};
  const shown = Object.keys(action).length ? " " + JSON.stringify(action) : "";
  return `${index + 1}. ${entry.type}${shown} -> ${entry.result}`;
};

/** Characters of the screen at done the audit reads (the window title and the visible text). */
export const SCREEN_CHARS = 1_500;
/** What the run's last frame showed when the claim was made, for the audit. */
export interface DoneScreen {
  title?: string;
  text?: string;
}
/**
 * A file the run wrote (or the objective names), read back at the claim
 * through RunnerExtras.deliverableText; text absent when it could not be
 * read (absent, not plain text, declined), which the section says.
 */
export interface DoneDeliverable {
  path: string;
  text?: string;
}
/**
 * What the run produced, read back at the claim (Runner.doneEvidence): the
 * files it wrote, most recent first, and the newest ok web read's result
 * whole as the tool layer returned it.
 */
export interface DoneEvidence {
  deliverables: DoneDeliverable[];
  pageRead?: string;
}
export const DELIVERABLE_LINE =
  "Deliverable at done (the file the run wrote, its content):";
export const PAGE_READ_LINE = "Last page read (the page's text the run had):";
export const DELIVERABLE_UNREAD =
  "(The file could not be read at the claim: it does not exist, is not a plain-text file, or is outside the home folder.)";
export const DELIVERABLE_EMPTY = "(The file is empty.)";

/**
 * A deliverable's content within DELIVERABLE_CHARS: whole when it fits,
 * else its first DELIVERABLE_HEAD_CHARS and its last (DELIVERABLE_CHARS −
 * DELIVERABLE_HEAD_CHARS), the cut counted between them.
 */
export function boundDeliverable(text: string): string {
  if (text.length <= DELIVERABLE_CHARS) return text;
  const tail = DELIVERABLE_CHARS - DELIVERABLE_HEAD_CHARS;
  return `${text.slice(0, DELIVERABLE_HEAD_CHARS)}\n[… ${text.length - DELIVERABLE_CHARS} characters cut …]\n${text.slice(-tail)}`;
}
const deliverableSection = (item: DoneDeliverable): string[] => [
  "",
  DELIVERABLE_LINE,
  bound(item.path, PATH_CHARS),
  item.text === undefined
    ? DELIVERABLE_UNREAD
    : item.text.trim() === ""
      ? DELIVERABLE_EMPTY
      : boundDeliverable(item.text),
];
/** The characters the lines take joined, each with its newline (one over, on purpose). */
const size = (lines: string[]) =>
  lines.reduce((total, line) => total + line.length + 1, 0);
/** Room the omitted-steps line may take beside the lines counted. */
const OMITTED_LINE_CHARS = 60;
/**
 * The history lines kept for the audit, newest first up to the budget,
 * then reversed to oldest first, with one line counting the steps dropped.
 */
function keptLines(history: History, budget: number): string[] {
  const lines = history.map(historyLine);
  const kept: string[] = [];
  let length = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = bound(lines[i], 1_200);
    if (length + line.length > budget) {
      kept.push(`… ${i + 1} earlier step${i + 1 === 1 ? "" : "s"} omitted.`);
      break;
    }
    kept.push(line);
    length += line.length + 1;
  }
  return kept.reverse();
}
/**
 * The call's input: the objective, the history lines the model already
 * reads (oldest first, the oldest dropped when over the history's budget),
 * the screen at done, the deliverables and the last page read (the
 * evidence), and the claimed summary. Never a screenshot. Under
 * AUDIT_INPUT_CHARS: the fixed sections (objective, screen, deliverables,
 * summary) are measured first, the steps get what is left up to
 * HISTORY_CHARS and never under HISTORY_MIN_CHARS, and the page read gets
 * what is left after them up to PAGE_READ_CHARS and never under
 * PAGE_READ_MIN_CHARS.
 */
export function doneAuditInput(
  objective: string,
  history: History,
  summary: string,
  screen?: DoneScreen,
  evidence?: DoneEvidence,
): string {
  const head = [
    "Objective:",
    bound(objective, OBJECTIVE_CHARS),
    "",
    "Steps (oldest first):",
  ];
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
  const deliverables = (evidence?.deliverables ?? [])
    .slice(0, DELIVERABLES_MAX)
    .flatMap(deliverableSection);
  const tail = ["", "Summary at done:", bound(summary, SUMMARY_CHARS)];
  const fixed = size(head) + size(shown) + size(deliverables) + size(tail);
  const page = evidence?.pageRead
    ? bound(evidence.pageRead, PAGE_READ_CHARS)
    : "";
  const pageLabel = ["", PAGE_READ_LINE];
  const pageSize = page ? size(pageLabel) + page.length + 1 : 0;
  // What the steps and the page read may take between them, each line
  // with its newline: the budget less the fixed sections and one, so the
  // whole input stays below AUDIT_INPUT_CHARS when both are cut (the last
  // line has no newline, which pays for the one under).
  const room = AUDIT_INPUT_CHARS - 1 - fixed;
  const historyBudget = Math.max(
    HISTORY_MIN_CHARS,
    Math.min(HISTORY_CHARS, room - pageSize - OMITTED_LINE_CHARS),
  );
  const kept = keptLines(history, historyBudget);
  const steps = kept.length ? kept.join("\n") : "(none)";
  const pageShown = page
    ? [
        ...pageLabel,
        bound(
          page,
          Math.max(
            PAGE_READ_MIN_CHARS,
            Math.min(
              PAGE_READ_CHARS,
              room - (steps.length + 1) - size(pageLabel),
            ),
          ),
        ),
      ]
    : [];
  return [
    ...head,
    steps,
    ...shown,
    ...deliverables,
    ...pageShown,
    ...tail,
  ].join("\n");
}

/** The text call the runner makes, ready for Provider.text. */
/**
 * The line appended to the input on the one retry after an unusable reply
 * (prose, a fence with no object, a wrong shape, an empty list, a reply cut
 * at the output cap): market 1/3 at 5e7d433, travel-hotel-shortlist #1 —
 * the first audit answered nothing usable and the done stood with the
 * dates never searched. It asks for brevity too: at 55e4e83 the replies the
 * cap cut were retried at the same cap and cut again (two runs, both
 * attempts), so the retry names the bound, a few words of text and the
 * step's number as evidence.
 */
export const DONE_AUDIT_REMINDER = `Reply with the JSON object only, nothing before or after it, at most ${DONE_AUDIT_MAX_REQUIREMENTS} requirements, text in a few words and evidence the step's number: {"requirements":[{"text":"…","kind":"…","met":true,"evidence":1}]}.`;
export function doneAuditCall(
  objective: string,
  history: History,
  summary: string,
  retry = false,
  screen?: DoneScreen,
  evidence?: DoneEvidence,
): ProviderTextCall {
  return {
    system: DONE_AUDIT_PROMPT,
    input:
      doneAuditInput(objective, history, summary, screen, evidence) +
      (retry ? `\n\n${DONE_AUDIT_REMINDER}` : ""),
    maxOutputTokens: DONE_AUDIT_MAX_OUTPUT_TOKENS,
    // Medium, not low: at low effort the auditor read a hotel search whose
    // dates were never entered as five requirements all met (market 2/3 at
    // f926928, travel-hotel-shortlist #1, 634 output tokens) where the same
    // model at abc24ae had listed the dates unmet; one call a run, so the
    // extra thinking costs little and the cap leaves room for it.
    effort: DONE_AUDIT_EFFORT,
    deadlineMs: DONE_AUDIT_DEADLINE_MS,
  };
}

export interface Requirement {
  text: string;
  /** One of REQUIREMENT_KINDS; "other" when the reply gave none or one off the list. */
  kind: RequirementKind;
  met: boolean;
  /**
   * The number of the step that met it, as the prompt asks; a short string
   * when the model wrote one anyway (bounded, never rejected); null when
   * unmet or when nothing needed doing. Nothing reads it but the reply's
   * own shape: the trace never carried it.
   */
  evidence: number | string | null;
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
  // A step number as asked, or a short string when the model wrote one.
  evidence: z
    .union([z.number(), z.string()])
    .nullable()
    .optional()
    .transform((value) => value ?? null),
});
export const doneAuditSchema = z.object({
  // Any objective audited states at least one requirement (a one-clause
  // one, audited under a strong auditor, no fewer), so an empty list is
  // not an audit ("all met" by saying nothing) but an
  // unusable reply, retried once with the reminder and then unavailable;
  // a requirement with no text fails the shape the same way.
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
      evidence:
        typeof r.evidence === "string" ? bound(r.evidence, 200) : r.evidence,
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
