import { createHash } from "node:crypto";

/**
 * The voice suite: what the loop says to the running app, what it expects
 * to see, and the AppleScript that sets each task up and cleans it away.
 * Loaded from tests/fixtures/voice-suite.json and validated here at load
 * and in tests/voice-loop.test.ts, so a task that could touch the owner's
 * data (a delete without the token, a mail app, an approval phrase) never
 * reaches the speakers. Pure: no file, no clock, no shell.
 */

export const SUITE_SCHEMA = 1;
/** `voiceloop` plus four base-36 characters, filled into `{token}` per attempt. */
export const TOKEN_RE = /^voiceloop[0-9a-z]{4}$/;
export const TASK_ID = /^[a-z][a-z0-9-]{2,40}$/;
export const TIMEOUT_BOUNDS = { min: 15_000, max: 120_000 } as const;
/** Seconds the gate and setup take around every task, for the estimate. */
export const GATE_SECONDS = 12;
/** The default selection must fit in an hour so a cycle fits an evening. */
export const MAX_DEFAULT_MINUTES = 60;
/** After this long with no wake, the utterance was not heard. */
export const DEFAULT_UNHEARD_MS = 20_000;

export type Outcome =
  | "answer"
  | "run"
  | "question"
  | "stop"
  | "pause"
  | "resume"
  | "revise"
  | "confirmation"
  /** The wake phrase inside a sentence: nothing may wake. */
  | "silence"
  /** A wake phrase while the app speaks stops the speech. */
  | "interrupt";
export const OUTCOMES: readonly Outcome[] = [
  "answer",
  "run",
  "question",
  "stop",
  "pause",
  "resume",
  "revise",
  "confirmation",
  "silence",
  "interrupt",
];

export type CheckOp =
  | "contains"
  | "notContains"
  | "equals"
  | "matches"
  | "gt"
  | "lt"
  | "inRange"
  | "nonempty"
  | "exitZero";

export interface Script {
  kind: "osascript" | "sh";
  script: string;
  timeoutMs?: number;
  /** Store the step's stdout under `state.<name>` for later steps and checks. */
  record?: string;
  /**
   * Re-run the script every `intervalMs` until its stdout is exactly `true`,
   * bounded by `timeoutMs`: how a setup waits for a window honestly instead
   * of sleeping a guessed second. A failed try is "not yet", never an error.
   */
  poll?: boolean;
  intervalMs?: number;
}

/** A setup, cleanup or check step's wall time: the default and the bounds. */
export const STEP = {
  defaultTimeoutMs: 10_000,
  minTimeoutMs: 1000,
  maxTimeoutMs: 60_000,
} as const;
/** How a poll step retries: the pause between tries and the longest one try may hang. */
export const POLL = {
  intervalMs: 250,
  minIntervalMs: 100,
  attemptMs: 5000,
} as const;

export interface StateCheck {
  /** The check's key in results: a code, never a value. */
  name: string;
  kind: "osascript" | "sh";
  script: string;
  expect: CheckOp;
  value?: string | number | [number, number];
  /** A failed read makes the check unknown, not the turn. */
  optional?: boolean;
  /** Defines completion: a completed run with it false is a false done. */
  primary?: boolean;
  /** Only judged when the observed outcome is this one (alsoAccept tasks). */
  when?: Outcome;
}

export type TriggerEvent =
  | "followup_open"
  | "RunStarted"
  | "ActionExecuted"
  | "speech_started"
  | "speech_finished"
  /** SpeechOut{phase: requested}: the reply is on its way, ~0.8 s before speech_started (barge-in). */
  | "SpeechOut"
  | "transcript_final"
  | "RunState";

export interface Trigger {
  event: TriggerEvent;
  /** followup_open: continuation or answer. */
  kind?: string;
  /** RunState: the status to wait for. */
  status?: string;
  /** Milliseconds after the event before speaking (default 300). */
  plus?: number;
}

export interface Latency {
  firstActionAfterTranscriptMs?: number;
  replyAfterTranscriptMs?: number;
}

export interface Expect {
  outcome: Outcome;
  alsoAccept?: Outcome[];
  /** Terminal must be "completed" (default true for run and revise). */
  runCompleted?: boolean;
  /** Default true except for "confirmation": a confirmation or needClick fails it. */
  noConfirmation?: boolean;
  /** Regex on the confirmation reason (outcome "confirmation"). */
  confirmReason?: string;
  /** Regex the run's task text (verbose RunState.task) must match. */
  taskWords?: string;
  /** Regex the run's task text must not match. */
  taskWordsNot?: string;
  /** EarlyStartExecuted expected; recorded, never failing. */
  earlyStart?: boolean;
  /** No EarlyStartExecuted may happen (a fragment must open nothing). */
  noEarlyStart?: boolean;
  /** Action types the run must have executed (a scroll for "scroll down"). */
  actionTypes?: string[];
  maxActions?: number;
  noMutation?: boolean;
  frontmost?: string | string[];
  state?: StateCheck[];
  /** Regex on the run's messages (verbose); stored as a boolean only. */
  replyHas?: string;
  creates?: "notes" | "files" | "screenshots" | "windows";
  latency?: Latency;
}

export interface Turn {
  say: string;
  withWake: boolean;
  after?: Trigger;
  delayMs?: number;
  heard?: string;
  expect: Expect;
  /** Spoken over the app's speech on purpose (the barge-in test). */
  bargeIn?: boolean;
}

export interface Noise {
  voice: string;
  /** Key into the suite's `paragraphs`. */
  paragraph: string;
  /** Milliseconds the reading starts before the prompt. */
  leadMs: number;
  /** Apple speech-synthesis `[[volm]]` for the reading. */
  volm: number;
  /** before-prompt: the paragraph is read to the end first, then the prompt starts at once. */
  gapAt?: "before-prompt";
  /** A second reading started this long into the prompt. */
  second?: { paragraph: string; afterMs: number };
}

export type Probe =
  | "notes-automation"
  | "textedit-automation"
  | "safari-automation"
  | "focus-shortcut";

/**
 * Apps whose Apple Events need the terminal's Automation consent, and the
 * preflight probe that asks for it once, while the owner is still at the
 * keyboard. Cycle 1 (2026-09-19 00:55) hung four setups for their 10-15 s
 * on the consent prompt for TextEdit and Safari; tccd wrote the consent
 * only at 00:59:15, when the owner came back and clicked (the TAKEOVER
 * that ended the cycle).
 */
export const AUTOMATION_PROBES: Readonly<Record<string, Probe>> = {
  Notes: "notes-automation",
  TextEdit: "textedit-automation",
  Safari: "safari-automation",
};

export interface VoiceTask {
  id: string;
  category: string;
  /** What follows the wake phrase; shorthand for turns[0].say. */
  say?: string;
  /** Regex source, case-insensitive, over a transcript with no punctuation. */
  heard?: string;
  expect?: Expect;
  /** Spoken without the wake prefix (the false-wake test only). */
  withWake?: boolean;
  turns?: Turn[];
  noise?: Noise;
  setup?: Script[];
  cleanup?: Script[];
  timeoutMs?: number;
  unheardMs?: number;
  tags: string[];
  /** A person's step count, for maxActions = 2 x max. */
  steps?: [number, number];
  /** Preflight probes the task needs; skipped when one fails. */
  probes?: Probe[];
  /** The loop says stop after the last turn: the run is meant to be going. */
  stopRunAfter?: boolean;
  notes: string;
}

export interface VoiceSuite {
  schema: number;
  wake: string;
  categories: string[];
  tags: string[];
  /** Background reading for noisy tasks: weather and gardening, no verbs of command. */
  paragraphs?: Record<string, string>;
  tasks: VoiceTask[];
}

/* -------------------------------------------------------------- loading */

/** Parses the fixture text; throws when it is not a suite at all. */
export function loadSuite(json: string): VoiceSuite {
  const parsed = JSON.parse(json) as VoiceSuite;
  if (parsed?.schema !== SUITE_SCHEMA)
    throw new Error(
      `voice suite schema ${parsed?.schema}, expected ${SUITE_SCHEMA}`,
    );
  if (!Array.isArray(parsed.tasks)) throw new Error("voice suite has no tasks");
  return parsed;
}

/** The utterances of a task: the top-level say/heard/expect, then `turns[1..]`. */
export function turnsOf(task: VoiceTask): Turn[] {
  if (task.turns?.length) return task.turns;
  return [
    {
      say: task.say ?? "",
      withWake: task.withWake ?? true,
      heard: task.heard,
      expect: task.expect ?? { outcome: "run" },
    },
  ];
}

/** The wall clock a turn may take from the end of `say` to a settled app. */
export function defaultTimeoutMs(task: VoiceTask): number {
  if (task.timeoutMs) return task.timeoutMs;
  if (task.category === "multi-step") return 90_000;
  const outcome = turnsOf(task).at(-1)?.expect.outcome ?? "run";
  return ["answer", "question", "silence"].includes(outcome) ? 25_000 : 60_000;
}

/* ----------------------------------------------------------- invariants */

/** Applications the suite never names: anything that sends. */
const FORBIDDEN_APPS = [
  "messages",
  "imessage",
  "mail",
  "facetime",
  "com.apple.mobilesms",
  "com.apple.mail",
  "com.apple.ichat",
  "com.apple.facetime",
];
/** Words that would make a spoken line or a script consequential. */
const FORBIDDEN_WORDS = [
  "send",
  " pay ",
  "purchase",
  "publish",
  "install",
  "delete my",
  "empty trash",
  "password",
];
/**
 * Approval phrases the loop never speaks. "sure go for it" is the one
 * exception, allowed only on the task that pins it to a question.
 */
const APPROVAL =
  /\b(yes|yeah|yep|sure|go ahead|do it|approve|confirm|okay|ok)\b/i;
const APPROVAL_EXEMPT = new Set(["ask-deictic"]);
/**
 * A delete or rm in a cleanup must be scoped on the same line to the token,
 * the bench folder, the task's marker, or a Notes creation-time window with
 * content words: the rules of the design's self-cleaning section.
 */
const DELETES = /\b(delete|rm)\b/i;
const SCOPED = [
  /\{token\}/,
  /\{benchDir\}/,
  /-newer "?\{marker\}"?/,
  /\{state\.startedAt\}.*plaintext contains/,
];
/**
 * Apps a setup may script only once System Events has seen a window of
 * theirs: an Apple Event to an app still launching, behind a consent
 * prompt or a panel, waits for it and ran out the step's timeout (cycle 1,
 * 2026-09-19: exit 124 on `count windows` after `open -a TextEdit` and on
 * Safari's `make new document` at cold launch). The window is watched
 * through System Events, the document opened through LaunchServices.
 */
const WINDOW_FIRST_APPS = ["TextEdit", "Safari"];
/**
 * Apps that take no Apple Events at all: Calculator has no scripting
 * terminology and a probe hung more than 12 s. Launched with `open`, seen
 * through System Events, ended with `pkill -x Calculator`.
 */
const UNSCRIPTABLE_APPS = ["Calculator"];
/** The one kill a script may carry: Calculator by exact name, only when the loop launched it. */
const KILLS = /\b(p?kill(all)?)\b/;
const ALLOWED_KILL = /pkill -x Calculator\b/;
const tellsApp = (script: string, app: string): boolean =>
  script.includes(`tell application "${app}"`);
const guardedByRunning = (script: string, app: string): boolean =>
  script.includes(`application "${app}" is running`);

/** Every script a task runs: setup, cleanup and the state checks, in that order. */
function scriptsOf(task: VoiceTask): Script[] {
  return [
    ...(task.setup ?? []),
    ...(task.cleanup ?? []),
    ...turnsOf(task).flatMap((turn) => turn.expect.state ?? []),
  ];
}

/** The rules a task's steps must satisfy so that no setup can hang or kill outside its scope. */
function stepProblems(task: VoiceTask): string[] {
  const problems: string[] = [];
  for (const step of scriptsOf(task)) {
    if (step.timeoutMs !== undefined) {
      if (
        step.timeoutMs < STEP.minTimeoutMs ||
        step.timeoutMs > STEP.maxTimeoutMs
      )
        problems.push(`step timeoutMs ${step.timeoutMs} out of bounds`);
    }
    if (
      step.intervalMs !== undefined &&
      (!step.poll || step.intervalMs < POLL.minIntervalMs)
    )
      problems.push(`step intervalMs ${step.intervalMs} needs a poll step`);
    for (const app of UNSCRIPTABLE_APPS)
      if (tellsApp(step.script, app))
        problems.push(`sends Apple Events to ${app}, which takes none`);
    for (const line of step.script.split("\n"))
      if (
        KILLS.test(line) &&
        !(ALLOWED_KILL.test(line) && /\{state\.[a-zA-Z0-9]+\}/.test(line))
      )
        problems.push(
          "kills outside pkill -x Calculator guarded by a recorded was-running value",
        );
  }
  // Setup talks to an app only after a window of its exists: a poll step on
  // its System Events process must come first, unless the script itself is
  // guarded by `application "X" is running` (an app already up is up).
  const seen = new Set<string>();
  for (const [index, step] of (task.setup ?? []).entries()) {
    if (step.poll) {
      for (const app of [...WINDOW_FIRST_APPS, ...UNSCRIPTABLE_APPS])
        if (step.script.includes(`process "${app}"`)) seen.add(app);
      continue;
    }
    if (step.kind !== "osascript") continue;
    for (const app of WINDOW_FIRST_APPS)
      if (
        tellsApp(step.script, app) &&
        !seen.has(app) &&
        !guardedByRunning(step.script, app)
      )
        problems.push(
          `setup step ${index} scripts ${app} before a window of its exists (poll System Events first)`,
        );
  }
  return problems;
}

/** Everything a task can say or run, lowercased, for the word rules. */
function taskText(task: VoiceTask): string {
  const scripts = [
    ...(task.setup ?? []),
    ...(task.cleanup ?? []),
    ...turnsOf(task).flatMap((turn) => turn.expect.state ?? []),
  ].map((step) => step.script);
  return [...turnsOf(task).map((turn) => turn.say), ...scripts]
    .join(" ")
    .toLowerCase();
}

/**
 * Every rule a task must satisfy before the loop may speak it; the list is
 * empty for a good suite. Tested against the real fixture.
 */
export function validateSuite(suite: VoiceSuite): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const categories = new Set(suite.categories);
  const tags = new Set(suite.tags);
  if (suite.tasks.length < 28)
    problems.push(`only ${suite.tasks.length} tasks; at least 28 needed`);
  for (const category of suite.categories)
    if (!suite.tasks.some((task) => task.category === category))
      problems.push(`category ${category} has no task`);
  for (const task of suite.tasks) {
    const at = `task ${task.id}`;
    if (!TASK_ID.test(task.id)) problems.push(`${at}: bad id`);
    if (seen.has(task.id)) problems.push(`${at}: duplicate id`);
    seen.add(task.id);
    if (!categories.has(task.category))
      problems.push(`${at}: unknown category ${task.category}`);
    for (const tag of task.tags)
      if (!tags.has(tag)) problems.push(`${at}: unknown tag ${tag}`);
    if (!task.notes) problems.push(`${at}: no notes`);
    if (!task.turns?.length && !(task.say && task.expect))
      problems.push(`${at}: neither say/expect nor turns`);
    const turns = turnsOf(task);
    for (const [index, turn] of turns.entries()) {
      if (!OUTCOMES.includes(turn.expect.outcome))
        problems.push(
          `${at}: turn ${index} has outcome ${turn.expect.outcome}`,
        );
      for (const also of turn.expect.alsoAccept ?? [])
        if (!OUTCOMES.includes(also))
          problems.push(`${at}: turn ${index} alsoAccept ${also}`);
      if (turn.heard) {
        try {
          new RegExp(turn.heard, "i");
        } catch {
          problems.push(`${at}: turn ${index} heard is not a regex`);
        }
        // The recognizer writes no punctuation, so a comma or an apostrophe
        // in the pattern could never match.
        if (/[,!;'"]/.test(turn.heard))
          problems.push(`${at}: turn ${index} heard carries punctuation`);
      } else if (turn.expect.outcome !== "silence")
        problems.push(`${at}: turn ${index} has no heard words`);
      if (index === 0) {
        // Only the false-wake test speaks without the wake phrase.
        if (turn.withWake === false && turn.expect.outcome !== "silence")
          problems.push(`${at}: first turn without wake is not a silence test`);
      } else {
        if (!turn.after) problems.push(`${at}: turn ${index} has no trigger`);
        // A line without the wake phrase is heard only in a follow-up window.
        const followup = turn.after?.event === "followup_open";
        if (turn.withWake === false && !followup)
          problems.push(
            `${at}: turn ${index} has no wake and no follow-up window`,
          );
        if (turn.withWake !== false && followup)
          problems.push(
            `${at}: turn ${index} waits for a follow-up window but says the wake phrase`,
          );
      }
      if (APPROVAL.test(turn.say) && !APPROVAL_EXEMPT.has(task.id))
        problems.push(`${at}: turn ${index} speaks an approval phrase`);
    }
    if (APPROVAL_EXEMPT.has(task.id) && turns[0].expect.outcome !== "question")
      problems.push(`${at}: the deictic task must expect a question`);
    const text = taskText(task);
    for (const app of FORBIDDEN_APPS)
      if (text.includes(app)) problems.push(`${at}: names ${app}`);
    for (const word of FORBIDDEN_WORDS)
      if (text.includes(word)) problems.push(`${at}: says "${word.trim()}"`);
    const creates = turns.some((turn) => turn.expect.creates);
    if ((task.setup?.length || creates) && !task.cleanup?.length)
      problems.push(`${at}: setup or creates without cleanup`);
    for (const step of task.cleanup ?? [])
      for (const line of step.script.split("\n"))
        if (DELETES.test(line) && !SCOPED.some((rule) => rule.test(line)))
          problems.push(
            `${at}: cleanup deletes outside the token, bench folder or marker`,
          );
    const noisy = task.tags.includes("noisy");
    if (!!task.noise !== noisy)
      problems.push(`${at}: noise and the noisy tag disagree`);
    for (const key of [task.noise?.paragraph, task.noise?.second?.paragraph])
      if (key && !suite.paragraphs?.[key])
        problems.push(`${at}: unknown noise paragraph ${key}`);
    const timeout = defaultTimeoutMs(task);
    if (timeout < TIMEOUT_BOUNDS.min || timeout > TIMEOUT_BOUNDS.max)
      problems.push(`${at}: timeoutMs ${timeout} out of bounds`);
    for (const check of turns.flatMap((turn) => turn.expect.state ?? []))
      if (!/^[a-zA-Z][a-zA-Z0-9]{1,40}$/.test(check.name))
        problems.push(`${at}: check name ${check.name} is not a code`);
    problems.push(...stepProblems(task).map((p) => `${at}: ${p}`));
    problems.push(...placeholderProblems(task).map((p) => `${at}: ${p}`));
  }
  for (const [key, text] of Object.entries(suite.paragraphs ?? {}))
    if (
      /\b(hey|open|close|type|click|notes|safari|calendar|stop|butler)\b/i.test(
        text,
      )
    )
      problems.push(`paragraph ${key} carries a command word or an app name`);
  return problems;
}

/** Placeholders a script may use; anything else in `{…}` is a typo. */
const PLACEHOLDER =
  /(?<!\$)\{([a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)?)\}/g;
const KNOWN = new Set(["token", "benchDir", "wake", "marker"]);

function placeholderProblems(task: VoiceTask): string[] {
  const problems: string[] = [];
  const recorded = new Set(
    (task.setup ?? []).flatMap((s) => (s.record ? [s.record] : [])),
  );
  const scripts = [
    ...(task.setup ?? []).map((s) => s.script),
    ...(task.cleanup ?? []).map((s) => s.script),
    ...turnsOf(task).flatMap((turn) => [
      turn.say,
      ...(turn.expect.state ?? []).map((c) => c.script),
    ]),
  ];
  for (const script of scripts)
    for (const match of script.matchAll(PLACEHOLDER)) {
      const name = match[1];
      if (KNOWN.has(name)) continue;
      if (name.startsWith("state.")) {
        if (!recorded.has(name.slice(6)))
          problems.push(`{${name}} was never recorded`);
        continue;
      }
      problems.push(`unknown placeholder {${name}}`);
    }
  return problems;
}

/* ------------------------------------------------------------ selection */

export interface Selection {
  tasks: VoiceTask[];
  /** Selectors that matched no id, tag or category. */
  unknown: string[];
}

/**
 * Tasks by id, tag or category (comma-separated or an array); everything
 * runnable when empty. Noisy tasks only with `noisy`. Order is the suite's.
 */
export function selectTasks(
  suite: VoiceSuite,
  only: string | string[] = [],
  options: { noisy?: boolean } = {},
): Selection {
  const wanted = (Array.isArray(only) ? only : only.split(","))
    .map((s) => s.trim())
    .filter(Boolean);
  const matches = (task: VoiceTask, selector: string) =>
    task.id === selector ||
    task.category === selector ||
    task.tags.includes(selector);
  const unknown = wanted.filter((s) => !suite.tasks.some((t) => matches(t, s)));
  const tasks = suite.tasks.filter(
    (task) =>
      (!wanted.length || wanted.some((s) => matches(task, s))) &&
      (options.noisy || !task.tags.includes("noisy")),
  );
  return { tasks, unknown };
}

/**
 * Subcodes for tasks whose preflight probe failed (`false`) or could not be
 * read (`null`), by task id. A failed read is not a pass: a task whose
 * cleanup needs the probed thing must not run on a guess.
 */
export function taskSkips(
  tasks: VoiceTask[],
  probes: Partial<Record<Probe, boolean | null>>,
): Record<string, string> {
  const subcode: Record<Probe, { failed: string; unknown: string }> = {
    "notes-automation": {
      failed: "NOTES_AUTOMATION",
      unknown: "NOTES_AUTOMATION_UNKNOWN",
    },
    "textedit-automation": {
      failed: "TEXTEDIT_AUTOMATION",
      unknown: "TEXTEDIT_AUTOMATION_UNKNOWN",
    },
    "safari-automation": {
      failed: "SAFARI_AUTOMATION",
      unknown: "SAFARI_AUTOMATION_UNKNOWN",
    },
    "focus-shortcut": {
      failed: "SHORTCUT_MISSING",
      unknown: "SHORTCUT_UNKNOWN",
    },
  };
  const skips: Record<string, string> = {};
  for (const task of tasks)
    for (const probe of taskProbes(task)) {
      const result = probes[probe];
      if (result === true || result === undefined || skips[task.id]) continue;
      skips[task.id] =
        result === null ? subcode[probe].unknown : subcode[probe].failed;
    }
  return skips;
}

/**
 * The probes a task needs: those it lists, plus the Automation consent for
 * every app its setup or its state checks send Apple Events to. A cleanup
 * that scripts an app is not counted: a quit it cannot send is logged,
 * never a reason to skip the task.
 */
export function taskProbes(task: VoiceTask): Probe[] {
  const probes = new Set<Probe>(task.probes ?? []);
  const scripts = [
    ...(task.setup ?? []),
    ...turnsOf(task).flatMap((turn) => turn.expect.state ?? []),
  ];
  for (const [app, probe] of Object.entries(AUTOMATION_PROBES))
    if (scripts.some((step) => tellsApp(step.script, app))) probes.add(probe);
  return [...probes];
}

/** Wall time for a selection: every timeout plus the gate around each task. */
export function estimateSeconds(tasks: VoiceTask[], repeat = 1): number {
  return (
    repeat *
    tasks.reduce(
      (sum, task) => sum + defaultTimeoutMs(task) / 1000 + GATE_SECONDS,
      0,
    )
  );
}

/* ---------------------------------------------------------- placeholders */

export interface Fill {
  token: string;
  benchDir: string;
  wake: string;
  marker: string;
  state?: Record<string, string>;
}

/**
 * Fills `{token}`, `{benchDir}`, `{wake}`, `{marker}` and `{state.<name>}`;
 * an unknown placeholder or an unrecorded state name throws, so a script
 * never runs with a literal brace where a value should be. AppleScript
 * records (`{name:"…"}`) and shell `${VAR}` are not placeholders.
 */
export function fillPlaceholders(text: string, fill: Fill): string {
  return text.replace(PLACEHOLDER, (whole, name: string) => {
    if (name === "token") return fill.token;
    if (name === "benchDir") return fill.benchDir;
    if (name === "wake") return fill.wake;
    if (name === "marker") return fill.marker;
    if (name.startsWith("state.")) {
      const value = fill.state?.[name.slice(6)];
      if (value === undefined)
        throw new Error(`no recorded value for ${whole}`);
      return value;
    }
    throw new Error(`unknown placeholder ${whole}`);
  });
}

/** `voiceloop` plus four base-36 characters from the given random source. */
export function voiceToken(random: () => number = Math.random): string {
  let suffix = "";
  for (let i = 0; i < 4; i++)
    suffix += Math.floor(random() * 36)
      .toString(36)
      .slice(-1);
  return `voiceloop${suffix}`;
}

/** The bench folder for one attempt, under the shared bench root. */
export const benchDirFor = (home: string, token: string): string =>
  `${home}/OpenAssistBench/voice-${token}`;

/**
 * The metric's identity: the fixture and the grader sources, hashed.
 * Cycles at different hashes are never compared.
 */
export function suiteHash(json: string, graderSources: string[]): string {
  const hash = createHash("sha256");
  hash.update(json);
  for (const source of graderSources) hash.update(source);
  return hash.digest("hex");
}

/* ------------------------------------------------------------------ poll */

/** What one run of a step came back with. */
export interface StepResult {
  code: number;
  stdout: string;
  stderr: string;
  ms: number;
}

export interface PollOutcome {
  ok: boolean;
  attempts: number;
  ms: number;
  /** The last try, for the detail when the poll gave up. */
  last: StepResult | null;
}

/**
 * Runs `attempt` until it exits 0 with stdout `true`, every `intervalMs`,
 * for at most `timeoutMs` in all; one try may hang at most `attemptMs`
 * (or what is left), so a stuck osascript is killed and tried again, and
 * the poll as a whole ends when it said it would. The clock and the sleep
 * are injected so the rule is tested without waiting.
 */
export async function pollUntilTrue(
  attempt: (timeoutMs: number) => Promise<StepResult>,
  options: {
    timeoutMs: number;
    intervalMs?: number;
    attemptMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<PollOutcome> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const intervalMs = options.intervalMs ?? POLL.intervalMs;
  const attemptMs = options.attemptMs ?? POLL.attemptMs;
  const started = now();
  let attempts = 0;
  let last: StepResult | null = null;
  for (;;) {
    const remaining = options.timeoutMs - (now() - started);
    if (remaining <= 0) break;
    last = await attempt(Math.min(attemptMs, remaining));
    attempts++;
    if (last.code === 0 && last.stdout.trim() === "true")
      return { ok: true, attempts, ms: now() - started, last };
    const left = options.timeoutMs - (now() - started);
    if (left <= 0) break;
    await sleep(Math.min(intervalMs, left));
  }
  return { ok: false, attempts, ms: now() - started, last };
}

/**
 * A poll as one step result: exit 0 and `true` when it was satisfied, else
 * exit 124 with a stderr that says how many tries in how long and what the
 * last try said, so the ledger's detail names the reason.
 */
export function pollStepResult(outcome: PollOutcome): StepResult {
  if (outcome.ok)
    return { code: 0, stdout: "true", stderr: "", ms: outcome.ms };
  const last = outcome.last;
  const said = last
    ? last.stderr.trim() || last.stdout.trim() || `exit ${last.code}`
    : "never tried";
  return {
    code: 124,
    stdout: last?.stdout ?? "",
    stderr: `poll ${outcome.attempts}x/${outcome.ms} ms: ${said}`,
    ms: outcome.ms,
  };
}
