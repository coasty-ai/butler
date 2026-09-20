/**
 * The deliverable a task names: a file its words ask to write, which a
 * `done` is held to. Market cycle 20260919-1646-09c5412 said done six times
 * and five were false; four of the five tasks named the file in the
 * instruction ("write … into ~/OpenAssistBench/<token>/<token>-notes.txt,
 * then save") and the file had not been changed as asked. The runner reads
 * the file's existence, size and modification time as the run begins and
 * again at each done (src/core/runner.ts): unchanged, the claim is sent back
 * once with the fact; unchanged again, the run fails. Nothing here reads a
 * file's contents, writes, deletes or sends; this module is pure and the
 * reading is injected (RunnerExtras.deliverables; src/storage/files.ts).
 *
 * Content: a path is the user's own words, so the history line and the
 * failure message may carry it back to them. The journal carries codes
 * only (DONE_CHALLENGED with reason deliverable_unchanged; RunFailed with
 * DELIVERABLE_MISSING).
 */

/** The file kinds a task can name as its deliverable. */
export const DELIVERABLE_EXTENSIONS = [
  "txt",
  "csv",
  "md",
  "rtf",
  "pdf",
] as const;

/**
 * The verbs that write. A path is a deliverable only under one of these,
 * so "what does ~/notes.txt say" is never checked. `note`, `log` and
 * `record` are nouns too ("read the log in ~/x.txt"): the verb counts only
 * in the imperative position (LEAD_INS), and only with the path as its
 * destination (DESTINATIONS), so "the log in ~/x.txt" and "put ~/x.pdf in
 * the email" name a source, not a deliverable.
 */
export const WRITING_VERBS = [
  "write",
  "log",
  "add",
  "append",
  "save",
  "note",
  "record",
  "create",
  "rename",
  "fill",
  "put",
  "type",
  "jot",
  "export",
] as const;

/** A word before which a verb is an instruction: the clause's start or one of these. */
const LEAD_INS = [
  "and",
  "then",
  "also",
  "now",
  "please",
  "first",
  "next",
  "finally",
  "just",
];
/** The path after one of these, after the verb, is where the writing goes. */
const DESTINATIONS = [
  "in",
  "into",
  "to",
  "on",
  "onto",
  "at",
  "as",
  "under",
  "inside",
];
/**
 * A sentence opening with one of these makes the write conditional ("If
 * anything is down, write which service in … If everything is fine, leave
 * that file alone"): the file may rightly stay as it is, so a task with any
 * such sentence has no deliverable.
 */
const CONDITIONALS = ["if", "unless", "when", "whenever", "should", "only if"];
/** A path after one of these is an example of a name, not a file to write. */
const EXAMPLES = [
  "like",
  "such as",
  "for example",
  "for instance",
  "e.g.",
  "similar to",
];

const VERB = new RegExp(
  `(?:^|\\b(?:${LEAD_INS.join("|")})\\s+)(?:${WRITING_VERBS.map((verb) => verbForms(verb)).join("|")})\\b`,
  "i",
);
const DESTINATION = new RegExp(
  `\\b(?:${DESTINATIONS.join("|")})\\s+(?:\\S+\\s+){0,3}$`,
  "i",
);
const CONDITIONAL = new RegExp(`^(?:${CONDITIONALS.join("|")})\\b`, "i");
const EXAMPLE = new RegExp(
  `(?:${EXAMPLES.map((word) => word.replace(/\./g, "\\.")).join("|")})\\s*$`,
  "i",
);
/**
 * A path token: `~/…` or `/…` with no whitespace, ending in one of the
 * extensions, standing on its own (after the start, whitespace or an
 * opening quote or bracket; before the end, whitespace, a closing quote or
 * bracket, or punctuation that ends the phrase). A URL's slashes follow a
 * colon or another slash and never start one; a host has no leading slash.
 */
const PATH = new RegExp(
  `(?<=^|[\\s"'“‘(\\[])(?:~|\\/)[^\\s"'”’()\\[\\]<>]*\\.(?:${DELIVERABLE_EXTENSIONS.join("|")})(?=$|[\\s"'”’)\\]}]|[.,;:!?](?:\\s|$))`,
  "gi",
);
const SENTENCE_END = /(?<=[.!?])\s+/;
const CLAUSE_END = /[,;:]|\bthen\b/gi;
const SAVE_AFTER = /\bsav(?:e|es|ed|ing)\b/i;

function verbForms(verb: string): string {
  // write/writes/writing/written, log/logs/logging/logged, put/puts/putting,
  // create/creates/creating/created, type/types/typing/typed, ...
  const stem = verb.endsWith("e") ? verb.slice(0, -1) : verb;
  const doubled = /[^aeiou][aeiou][^aeiouwxy]$/.test(verb)
    ? `${verb}${verb.at(-1)}`
    : verb;
  const forms = new Set([
    verb,
    `${verb}s`,
    `${stem}ing`,
    `${doubled}ing`,
    `${stem}ed`,
    `${doubled}ed`,
    ...(verb === "write" ? ["wrote", "written"] : []),
  ]);
  return `(?:${[...forms].join("|")})`;
}

/**
 * The file paths a task asks to write, in the order they appear, each once.
 * The rule, pinned by tests/deliverables.test.ts over the market and long
 * catalogues:
 *
 * 1. Only a `~/…` or absolute path with no whitespace ending in .txt, .csv,
 *    .md, .rtf or .pdf; never a URL, a host or a bare name.
 * 2. A task with a conditional sentence (If …, Unless …, When …) names no
 *    deliverable, and a path given as an example (like …, such as …) is
 *    not one.
 * 3. A path is written when, in its own clause (between commas, colons,
 *    semicolons or "then"), a writing verb in the imperative (opening the
 *    clause, or after and/then/also/…) precedes it with the path as the
 *    destination ("write … into <path>", "log an expense in <path>", "add …
 *    to <path>", "fill in <path>"), or when it is the only file the task
 *    names and the task says to save after naming it ("Open <path> in
 *    TextEdit, add a line, and save it"). "Open <path> and tell me the
 *    total", "read the log in <path>", "put <path> in the email" and
 *    "Open <path>, then add a reminder in Reminders" name none.
 */
export function deliverablePaths(task: string): string[] {
  const sentences = task.split(SENTENCE_END);
  if (sentences.some((sentence) => CONDITIONAL.test(sentence.trim())))
    return [];
  const candidates: { path: string; written: boolean; savedAfter: boolean }[] =
    [];
  let offset = 0;
  for (const sentence of sentences) {
    for (const match of sentence.matchAll(PATH)) {
      const at = match.index;
      const before = sentence.slice(0, at);
      if (EXAMPLE.test(before)) continue;
      const clause = before.slice(lastClauseEnd(before));
      const written = VERB.test(clause) && DESTINATION.test(clause);
      const savedAfter = SAVE_AFTER.test(
        task.slice(offset + at + match[0].length),
      );
      candidates.push({ path: match[0], written, savedAfter });
    }
    offset = task.indexOf(sentence, offset) + sentence.length;
  }
  const distinct = new Set(candidates.map((c) => c.path));
  const paths: string[] = [];
  for (const candidate of candidates) {
    if (paths.includes(candidate.path)) continue;
    if (candidate.written || (distinct.size === 1 && candidate.savedAfter))
      paths.push(candidate.path);
  }
  return paths;
}

function lastClauseEnd(text: string): number {
  let end = 0;
  for (const match of text.matchAll(CLAUSE_END))
    end = match.index + match[0].length;
  return end;
}

/**
 * What the reader says about a path: whether the file exists and, when it
 * does, its size in bytes and modification time. Never its contents.
 */
export interface FileFacts {
  exists: boolean;
  size: number;
  mtimeMs: number;
}
/**
 * Reads FileFacts for a path (`~` meaning the home folder). null when the
 * reader declines the path (outside the home folder) or cannot read it;
 * a missing file is a fact (exists false), not a refusal.
 */
export type FileFactsReader = (path: string) => Promise<FileFacts | null>;
/**
 * Reads a plain-text file's whole content by path (`~` meaning the home
 * folder) for the done audit's deliverable section (src/core/done-audit.ts
 * DoneEvidence): the files the run wrote through the files tool, and the
 * file the task names, read back at a claim so a fact missing from the file
 * is read off the file, not the summary. Under the files tool's own path
 * rules (src/tools/providers/files.ts deliverableTextReader); null when the
 * reader declines the path, the file is absent, not plain text or too
 * large, which the audit is told as "could not be read". Never writes.
 */
export type DeliverableTextReader = (path: string) => Promise<string | null>;

/** The same file as far as the check can tell: both absent, or same size and time. */
export function sameFacts(before: FileFacts, now: FileFacts): boolean {
  if (before.exists !== now.exists) return false;
  if (!before.exists) return true;
  return before.size === now.size && before.mtimeMs === now.mtimeMs;
}

/** A path the run watches, with what was true of it as the run began. */
export interface Deliverable {
  path: string;
  before: FileFacts;
}

const bound = (s: string, n: number) =>
  s.length > n ? s.slice(0, n) + "…" : s;
/** The paths, cut so the history line stays under MODEL_RESULT_CHARS. */
const named = (items: Deliverable[]) =>
  bound(items.map((item) => item.path).join(", "), 160);

/**
 * The history line for a done said with the named file unchanged: the fact
 * structurally (which file, and that it is still absent or has the same
 * size and modification time), the two routes left, and what a done's
 * summary must name. Never a screen's or a file's text.
 */
export function deliverableChallenge(unchanged: Deliverable[]): string {
  const several = unchanged.length > 1;
  const state = unchanged.every((item) => !item.before.exists)
    ? several
      ? "they still do not exist"
      : "it still does not exist"
    : several
      ? "they have the same size and modification time as when the run began"
      : "it has the same size and modification time as when the run began";
  return `Not accepted yet. The objective names ${named(unchanged)}, and ${state}, so the file has not changed since the run began. If the work is not in the file yet, continue: put it there and save, then say done with a summary that names what in the file or on screen shows the objective met. If it cannot be done, say fail and name what remains. A done said again with the file still unchanged fails the run.`;
}

/** The failed run's message: the fact, in the user's own words for the file. */
export function deliverableMissing(unchanged: Deliverable[]): string {
  return `Not done: ${named(unchanged)} ${unchanged.length > 1 ? "have" : "has"} not changed since the run began.`;
}

export const DELIVERABLE_MISSING = "DELIVERABLE_MISSING";
/**
 * The runner's own failure of a run whose done was said twice with the
 * named file unchanged. RunFailed carries the code; the message is spoken.
 */
export class DeliverableMissingError extends Error {
  readonly code = DELIVERABLE_MISSING;
  constructor(readonly unchanged: Deliverable[]) {
    super(deliverableMissing(unchanged));
    this.name = "DeliverableMissingError";
  }
}
