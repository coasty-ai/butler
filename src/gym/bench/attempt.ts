import { execFile } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import type { PresenceReport } from "../../../electron/controller";
import type { FileFactsReader } from "../../core/deliverables";
import type { MemoryAccess } from "../../core/memory";
import { nullRecorder } from "../../core/recorder";
import type { ToolAccess } from "../../core/tools";
import { approvalCode } from "../../core/approval-codes";
import { Runner, terminal } from "../../core/runner";
import {
  settingsSchema,
  type Action,
  type Controller,
  type Frame,
  type Provider,
  type Recorder,
  type Run,
  type Settings,
  type Snapshot,
} from "../../core/schema";
import { frictionCodes } from "./analyze";
import { benchToken } from "./catalogue";
import {
  BROWSER_ID_PARAM,
  BROWSER_PARAM,
  TOKEN_RE,
  approvalInContext,
  approvesPrompt,
  fillInstruction,
  gradeTask,
  markerValues,
  markersIn,
  namesBrowser,
  unverifiable,
  type ApprovalView,
} from "./graders";
import { needsBenchDir, type BrowserChoice } from "./preflight";
import { sweepsStrayFiles } from "./readers";
import {
  doneChallengeCode,
  endingCode,
  honesty,
  pausedAfterCode,
  type ApprovalTally,
  type AttemptResult,
} from "./report";
import type {
  AttemptContext,
  BenchTask,
  Cleanup,
  Evidence,
  EvidenceReaders,
  FixtureHandle,
  Grade,
  JournalStep,
  PrepareContext,
  RunJournal,
  TakeoverSource,
} from "./types";

/**
 * One benchmark attempt, with everything that drives the desktop or the
 * model injected. bench.mjs and harness-cycle.mjs both call runAttempt; the
 * tests call it with a fake controller and a fake provider through the real
 * Runner. Screenshots stay in memory, and nothing this module returns holds
 * screen text, a title, a URL or a path: a row is task ids, model ids,
 * counts, durations, cost and fixed codes.
 */

/** What the attempt needs from the controller beyond the Runner's contract. */
export interface BenchController extends Controller {
  request(method: string, data?: Record<string, unknown>): Promise<any>;
  presence?(): Promise<PresenceReport>;
}

/**
 * Shared between the controller's callbacks and the attempt: the callbacks
 * fire on the helper's thread of events, the attempt reads the flags at the
 * points where they matter.
 */
export interface HarnessState {
  /** A stop (Ctrl-C, Escape) reached the harness; no new run may start. */
  stopped: boolean;
  emergency: boolean;
  /** Real input on this Mac since the attempt began. */
  manualInput: boolean;
  /** The active runner, so a callback can stop it. */
  runner?: Runner;
  /** When the harness last posted input itself, for the presence gate. */
  lastAgentInputAt?: number;
}

export function createHarnessState(): HarnessState {
  return { stopped: false, emergency: false, manualInput: false };
}

/** The controller's emergency callback: Escape means stop everything, not just this attempt. */
export function onEmergencyStop(state: HarnessState): () => void {
  return () => {
    state.emergency = true;
    state.manualInput = true;
    state.stopped = true;
    state.runner?.stop("Native emergency stop activated.");
  };
}

/**
 * The controller's manual-input callback. Real input stops the run outright.
 * Asking the runner for a manual takeover would not: while the run is
 * confirming it only interrupts the prompt, and the approval this harness
 * has already queued would let the run continue after a person touched the
 * Mac.
 */
export function onManualInput(state: HarnessState): () => void {
  return () => {
    state.manualInput = true;
    state.runner?.stop("Manual input during benchmark.");
  };
}

/** Opens a target through LaunchServices: `open [-a app] [target]`. */
export type Launch = (target?: string, app?: string) => Promise<void>;

/**
 * The real opener. An activation through LaunchServices is not input: it
 * needs no frame, cannot trip the tap and asks for no permission, which is
 * why wrong-start setup and the neutral start never go through the
 * controller.
 */
export function launchServices(): Launch {
  return (target, app) =>
    new Promise((done, fail) => {
      const args = [...(app ? ["-a", app] : []), ...(target ? [target] : [])];
      if (!args.length) return done();
      execFile("open", args, (error) => (error ? fail(error) : done()));
    });
}

export interface AttemptDeps {
  controller: BenchController;
  /** One provider per matrix cell, built up front so a bad key fails early. */
  clients: Record<string, Provider>;
  state: HarnessState;
  recorder?: Recorder;
  memoryAccess?: MemoryAccess;
  /**
   * The tool layer a run may call (RunnerExtras.tools): the harness hands
   * in the built-in files tool alone (tools.ts createBenchTools), so a note
   * task can write its file through one tool step as the product would.
   * Without it every tool_call is refused and the run drives the screen.
   */
  tools?: ToolAccess;
  /** The cycle's diagnostics log; bench runs are otherwise invisible to the analyzer. */
  diagnostics?: { snapshot(s: Snapshot): void };
  /** End-state readers from the suite lane; null until it lands. */
  readEvidence?: EvidenceReaders | null;
  cleanupAttempt?: Cleanup | null;
  /**
   * The runner's deliverable reader (src/storage/files.ts fileFactsReader),
   * handed to the Runner as RunnerExtras.deliverables: a done said while
   * the file the task asks to write is unchanged is sent back once and
   * fails the run the second time. Without it the runner checks no done
   * against a file, as in the app without the reader.
   */
  deliverables?: FileFactsReader;
  launch: Launch;
  fixture?: FixtureHandle;
  /**
   * PrepareContext.agenda for one task, asked per attempt (readers.ts
   * agendaFor): undefined unless every store the task writes is granted and
   * has its local container right now. One answer for the whole cycle would
   * outlive a teardown or a revoked grant.
   */
  agendaFor?: (task: BenchTask) => Promise<PrepareContext["agenda"]>;
  /** Tokens in flight, so a sweep can find what a crash left (sweep.ts). */
  tokens?: TokenLedger;
  /** Where bench folders live. Default ~/OpenAssistBench. */
  benchRoot?: string;
  token?: () => string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** How long the Finder gets to come forward before prepare, in ms. */
  settleMs?: number;
}

/**
 * Where the harness keeps the tokens of attempts that may have left
 * something behind. A crash between creating the bench folder and cleaning
 * up (a power cut, a kill -9) leaves no row and no cleanup; only this list
 * says which token's items a later `--cleanup-only` must look for, and since
 * when. Every method is best-effort: a ledger that fails never stops an
 * attempt.
 */
export interface TokenLedger {
  /** Before anything carrying the token exists. */
  open(token: string, taskId: string): void;
  /** The bench folder exists; `at` is its birth time, which dates the attempt. */
  started(token: string, at: number): void;
  /**
   * Cleanup ran and left these codes behind (none when it threw: `failed`).
   * `recheck`: keep the token for a later sweep even when clean. The
   * attempt's own cleanup passes it when it swept Spotlight for stray files,
   * which a save seconds earlier is not indexed for yet.
   */
  close(
    token: string,
    leftovers: string[],
    failed: boolean,
    recheck?: boolean,
  ): void;
}

export interface AttemptCell {
  provider: string;
  model: string;
  cell: string;
  /** Provider, model, prices and memory switch; budgets come from the task. */
  settings: Settings;
}

export interface AttemptCaps {
  /** The cost cap for this attempt, after the cycle and model caps. */
  maxCost: number;
  approveRoutine: boolean;
  planIndex?: number;
  requeued?: number;
  gateWaitSeconds?: number;
  /**
   * The browser the preflight chose for this attempt (preflight.ts
   * chooseBrowser): filled into the instruction's `{browser}` and the only
   * browser the graders accept. Ignored for a task that does not name one.
   */
  browser?: BrowserChoice;
}

export const noSources = (): Record<TakeoverSource, number> => ({
  manual_input: 0,
  request_user: 0,
  policy: 0,
  surface: 0,
  handoff: 0,
});

const defaultSleep = (ms: number) =>
  new Promise<void>((done) => setTimeout(done, ms));

function baseRow(
  cell: AttemptCell,
  task: BenchTask,
  attempt: number,
  caps: AttemptCaps,
  startedAt: string,
) {
  return {
    taskId: task.id,
    category: task.category,
    difficulty: task.difficulty,
    attempt,
    provider: cell.provider,
    model: cell.model,
    cell: cell.cell,
    planIndex: caps.planIndex ?? 0,
    requeued: caps.requeued ?? 0,
    startedAt,
    expectedSteps: task.steps,
    gateWaitSeconds: caps.gateWaitSeconds ?? 0,
  };
}

/**
 * A row for an attempt that never started: no run, no cost, nothing claimed.
 * The ending still says whether a stop, rather than the plan, kept it from
 * starting.
 */
export function neverRan(
  cell: AttemptCell,
  task: BenchTask,
  attempt: number,
  caps: AttemptCaps,
  reason: string,
  state: Pick<HarnessState, "stopped" | "emergency">,
  startedAt = new Date().toISOString(),
): AttemptResult {
  const grade: Grade = { status: "unknown", checks: {}, reason };
  return {
    ...baseRow(cell, task, attempt, caps, startedAt),
    status: "unknown",
    reason,
    checks: {},
    runStatus: "skipped",
    endingCode: endingCode({
      runStatus: "skipped",
      manualTakeover: false,
      agentHandoffs: 0,
      paused: false,
      emergencyStop: state.emergency,
      interrupted: state.stopped,
      modelFailed: false,
    }),
    ...honesty("skipped", grade),
    actions: 0,
    seconds: 0,
    cost: 0,
    inputTokens: 0,
    outputTokens: 0,
    modelCalls: 0,
    approvals: 0,
    approvalsDeclined: 0,
    retries: 0,
    handoffs: { manual: 0, agent: 0 },
    takeovers: 0,
    takeoverSources: noSources(),
    manualTakeover: false,
    modelFailed: false,
    loops: 0,
    noProgress: 0,
    failures: {},
  };
}

// The one rule for which tasks get a bench folder, shared with the preflight.
export { needsBenchDir };

/** A relative path prepare() may write: inside the folder, no dotfiles. */
export function safeRelative(relative: string): boolean {
  if (!relative || isAbsolute(relative)) return false;
  const parts = normalize(relative).split(/[\\/]/);
  return parts.every(
    (part) => part && part !== ".." && part !== "." && !part.startsWith("."),
  );
}

/**
 * The Runner's view of the controller: every method delegates, and execute
 * captures a journal step where the action, the frame and the native result
 * are all in hand. The steps stay in memory and hold lengths and ids, never
 * the text. The surface each proposed action is checked on (the runner asks
 * for it right before the policy, so it is the one a confirmation is about)
 * is kept as bundle ids, a modal flag and web hosts for the approval rule.
 * The injected controller is never mutated.
 */
function journaled(
  controller: BenchController,
  steps: JournalStep[],
  markers: string[],
  state: HarnessState,
  now: () => Date,
  seen: ApprovalView,
): Controller {
  return {
    kind: controller.kind,
    surface: async (action?: Action) => {
      const found = await controller.surface(action);
      if (action) {
        // Every field is overwritten, so nothing of an earlier action's
        // surface (its page's host) can vouch for this one.
        seen.appId = found?.appId;
        seen.targetAppId = found?.targetAppId;
        // The helper only ever sets the flag when a sheet or dialog is there.
        seen.modal = found?.modal === true;
        seen.domain = found?.domain;
        seen.targetWebHost = found?.targetWebHost;
      }
      return found;
    },
    capture: () => controller.capture(),
    stop: () => controller.stop(),
    resume: () => controller.resume(),
    ...(controller.restore
      ? { restore: (frame: Frame) => controller.restore!(frame) }
      : {}),
    ...(controller.revalidate
      ? {
          revalidate: (action: Action, frame: Frame) =>
            controller.revalidate!(action, frame),
        }
      : {}),
    execute: async (action, frame, signal) => {
      const result = await controller.execute(action, frame, signal);
      state.lastAgentInputAt = now().getTime();
      const text = (action as { text?: unknown }).text;
      const path = (action as { path?: unknown }).path;
      steps.push({
        type: action.type,
        appId: frame?.appId,
        textLength: typeof text === "string" ? text.length : undefined,
        // Which attempt parameters the text carried, never the text itself.
        markers:
          typeof text === "string" ? markersIn(text, markers) : undefined,
        menuLeaf:
          action.type === "menu_item" && Array.isArray(path)
            ? String(path.at(-1) ?? "").toLowerCase()
            : undefined,
        launchedAppId: result?.launched?.appId,
        launchedFrontmost: result?.launched?.frontmost,
        openedPath: result?.opened?.path,
        openedAppId: result?.opened?.appId,
      });
      return result;
    },
  };
}

/** The helper's presence report, or undefined when it has none or fails. */
async function presenceOf(
  controller: BenchController,
): Promise<PresenceReport | undefined> {
  if (!controller.presence) return undefined;
  try {
    return await controller.presence();
  } catch {
    return undefined;
  }
}

/**
 * Whether real input landed during an attempt without reaching the harness.
 * The tap's idle clock counts from max(installed, last unmarked input), so
 * with no input it grows with the wall clock; one that fell behind by more
 * than the slack restarted, which only a person can make it do. Without a
 * tap before the attempt the clock started at the runner's resume, and input
 * before then was invisible to it anyway: nothing can be concluded.
 */
export function unseenManualInput(
  before: Pick<PresenceReport, "tapIdleSeconds"> | undefined,
  after: Pick<PresenceReport, "tapIdleSeconds"> | undefined,
  elapsedSeconds: number,
  slackSeconds = 2,
): boolean {
  if (before?.tapIdleSeconds == null || after?.tapIdleSeconds == null)
    return false;
  return (
    after.tapIdleSeconds + slackSeconds < before.tapIdleSeconds + elapsedSeconds
  );
}

/** The tool ids the journal keeps: the app's own providers (src/core/tools.ts RESERVED_PROVIDERS "apple", "files"), never a user server's. */
const FIRST_PARTY_TOOL = /^(?:apple|files)__[A-Za-z0-9_.-]{1,128}$/;
/** What cleanup adds to a row. */
type Cleaned = Pick<AttemptResult, "leftovers" | "cleanupFailed">;

/**
 * One attempt: neutral start, prepare, run the task, read the end state back,
 * grade it, clean up. Cleanup runs on every way out, a throw included: a
 * wiring fault still throws, but never leaves the bench folder or the suite's
 * items behind.
 */
export async function runAttempt(
  deps: AttemptDeps,
  cell: AttemptCell,
  task: BenchTask,
  attempt: number,
  caps: AttemptCaps,
): Promise<AttemptResult> {
  const { state, controller } = deps;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const startedAt = now().toISOString();
  const base = baseRow(cell, task, attempt, caps, startedAt);
  // Wiring errors in the caller, not outcomes: a row would count them against
  // the model as grader unknowns. All three are checked before anything
  // exists that cleanup would have to remove.
  const client = deps.clients[cell.cell];
  if (!client) throw new Error(`No provider client for ${cell.cell}.`);
  const settings = settingsSchema.parse({
    ...cell.settings,
    maxActions: task.maxActions,
    maxSeconds: task.maxSeconds,
    maxCost: Math.min(50, Math.max(0.01, caps.maxCost)),
  });
  const token = (deps.token ?? benchToken)();
  // Cleanup deletes by token, so a token outside the marker namespace could
  // name something of the user's.
  if (!TOKEN_RE.test(token)) throw new Error("Bench token outside benchnote*.");
  const counters = {
    approvals: 0,
    approvalsDeclined: 0,
    /** By the policy's question as a code, never its text. */
    approvalCodes: {} as Record<string, ApprovalTally>,
    retries: 0,
    blindRetries: 0,
    takeovers: 0,
    takeoverSources: noSources(),
    loops: 0,
    noProgress: 0,
    clickNoEffect: 0,
    modelCalls: 0,
    modelFailed: false,
    paused: false,
    pausedAfter: undefined as string | undefined,
    failures: {} as Record<string, number>,
    /** The runner's checks of a done, by reason as a code (report.ts doneChallengeCode). */
    doneChallenged: {} as Record<string, number>,
    /** RunFailed's code: DELIVERABLE_MISSING when the runner failed the run itself. */
    runFailedCode: undefined as string | undefined,
  };
  // Input reported during an earlier attempt belonged to that attempt. From
  // here on the flag is this one's, so input during the settle or prepare
  // keeps this run from starting.
  state.manualInput = false;

  // The tap's idle clock before anything happens, so input between the gate
  // and the runner's own resume can be told from the tap being installed.
  const before = await presenceOf(controller);
  const beforeAt = now().getTime();
  const elapsed = () => (now().getTime() - beforeAt) / 1000;

  // The Finder comes forward through LaunchServices before every attempt,
  // so no task's target application is frontmost when it starts: "Open
  // Calculator" must not pass because the previous attempt left Calculator
  // in front. It comes before prepare: a task's wrong-start setup opens
  // things on purpose and must not be undone.
  try {
    await deps.launch(undefined, "Finder");
  } catch {
    // A missing Finder activation costs nothing the grader relies on.
  }
  await sleep(deps.settleMs ?? 1500);

  const home = homedir();
  const benchRoot = resolve(deps.benchRoot ?? join(home, "OpenAssistBench"));
  const benchDir = join(benchRoot, token);
  const benchPath = benchDir.startsWith(home + "/")
    ? "~" + benchDir.slice(home.length)
    : benchDir;
  // The ledger is bookkeeping for a later sweep: it never stops an attempt.
  const note = (write: (ledger: TokenLedger) => void) => {
    try {
      if (deps.tokens) write(deps.tokens);
    } catch {
      // A sweep then finds the folder by its name instead.
    }
  };
  let created = false;
  const ensureBenchDir = () => {
    if (created) return;
    mkdirSync(benchDir, { recursive: true, mode: 0o700 });
    created = true;
    // Cleanup dates the attempt by this birth time; once the folder is gone
    // only the ledger remembers it.
    note((ledger) => ledger.started(token, lstatSync(benchDir).birthtimeMs));
  };
  const ctx: AttemptContext = {
    token,
    benchDir,
    benchPath,
    ...(deps.fixture ? { fixture: deps.fixture } : {}),
  };
  // The harness default when the suite lane's cleanup is not wired: remove
  // the folder only when it is still empty. rmdir never follows a symlink
  // and refuses anything with content, so nothing of the user's is at risk;
  // content the task wrote is reported as a leftover for the real sweep.
  const defaultCleanup = (): string[] => {
    if (!created || !existsSync(benchDir)) return [];
    try {
      if (lstatSync(benchDir).isSymbolicLink()) return ["LEFTOVER_FILES"];
      if (readdirSync(benchDir).length) return ["LEFTOVER_FILES"];
      rmdirSync(benchDir);
      return [];
    } catch {
      return ["LEFTOVER_FILES"];
    }
  };

  // Leftover codes name what stayed behind, and a cleanup that throws is
  // recorded, never hidden. The suite's cleanup receives the task and runs
  // its own hook as one of its steps, so the hook is called here only on the
  // default path, never twice.
  const cleanup = async (): Promise<Cleaned> => {
    const leftovers: string[] = [];
    try {
      if (deps.cleanupAttempt)
        leftovers.push(...(await deps.cleanupAttempt(task, ctx)));
      else {
        if (task.cleanup)
          leftovers.push(...(await task.cleanup({ benchDir, token })));
        leftovers.push(...defaultCleanup());
      }
    } catch {
      note((ledger) => ledger.close(token, leftovers, true));
      return {
        ...(leftovers.length ? { leftovers } : {}),
        cleanupFailed: true,
      };
    }
    note((ledger) =>
      ledger.close(token, leftovers, false, sweepsStrayFiles(task)),
    );
    return leftovers.length ? { leftovers } : {};
  };
  // Once, whichever way out gets there first: a row carries what cleanup
  // left behind, and the finally below is the way a throw takes.
  let cleaning: Promise<Cleaned> | undefined;
  const cleanupOnce = () => (cleaning ??= cleanup());
  /** A row for an attempt that never started, after its cleanup. */
  const notStarted = async (
    reason: string,
    extra: Partial<AttemptResult> = {},
  ): Promise<AttemptResult> => ({
    ...neverRan(cell, task, attempt, caps, reason, state, startedAt),
    ...extra,
    ...(await cleanupOnce()),
  });

  // Before anything carrying the token exists: from here on a crash leaves
  // an entry for --cleanup-only.
  note((ledger) => ledger.open(token, task.id));
  try {
    if (needsBenchDir(task)) ensureBenchDir();
    let parameters: Record<string, string> = {};
    if (task.prepare) {
      // Asked now, for this task: setup must report the task's own stores
      // ready at this moment, or an agenda task's prepare skips.
      let agenda: PrepareContext["agenda"];
      try {
        agenda = await deps.agendaFor?.(task);
      } catch {
        agenda = undefined;
      }
      const context: PrepareContext = {
        index: (query) => controller.request("index", { query }),
        token: () => token,
        benchDir,
        benchPath,
        write: async (relative, content) => {
          if (!safeRelative(relative))
            throw new Error("Refusing to write outside the bench folder.");
          ensureBenchDir();
          const file = join(benchDir, relative);
          mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
          writeFileSync(file, content, { mode: 0o600 });
        },
        ...(agenda ? { agenda } : {}),
        ...(deps.fixture
          ? {
              fixture: {
                url: deps.fixture.url,
                register: (pages: Record<string, string>) =>
                  deps.fixture!.register(token, pages),
              },
            }
          : {}),
        openWithLaunchServices: (target, app) => deps.launch(target, app),
        now,
      };
      let resolved: Record<string, string> | null = null;
      try {
        resolved = await task.prepare(context);
      } catch {
        resolved = null;
      }
      if (!resolved) return await notStarted("NO_PREPARED_TARGET");
      parameters = resolved;
    }
    // The browser is the harness's choice, never the model's: the one not in
    // the person's use, named in the instruction and held to by the graders.
    if (caps.browser && namesBrowser(task))
      parameters = {
        ...parameters,
        [BROWSER_PARAM]: caps.browser.name,
        [BROWSER_ID_PARAM]: caps.browser.id,
      };
    // An Escape or Ctrl-C during the settle or prepare found no run to stop:
    // the previous runner was already terminal. Starting now would resume the
    // helper, undoing the latch the Escape set, and drive the desktop until
    // the person pressed it again. Skip instead; the loop then ends the cycle.
    if (state.stopped) return await notStarted("SKIPPED");
    // A person touched the Mac during the settle or prepare, which can take
    // seconds when prepare opens applications. The helper is latched, so the
    // tap recorded it and told nobody; starting now would resume the helper
    // and hand the desktop to the model in front of them. The attempt goes
    // back to the queue instead, and the gate asks for the full --idle again.
    if (state.manualInput)
      return await notStarted("MANUAL_TAKEOVER", {
        manualTakeover: true,
        handoffs: { manual: 1, agent: 0 },
      });
    if (unseenManualInput(before, await presenceOf(controller), elapsed()))
      return await notStarted("MANUAL_INPUT_UNSEEN");

    let run: Run | null = null;
    let message: string | undefined;
    let printed = 0;
    let answered = 0;
    let held: string | undefined;
    const inner = deps.recorder ?? nullRecorder();
    // The null recorder numbers nothing (sequence 0), and the cycle's log
    // (LocalDiagnostics.snapshot) writes only an event whose sequence is past
    // the last one written: every journal row of every bench run was dropped
    // (cycle 20260919-2044-60630f0: RunState, Native* and Provider* rows
    // alone), so the analyzer's frictions (ACTION_LOOP, LOOP_STUCK,
    // CLICK_NO_EFFECT) never reached the failure classes. Numbered here, per
    // attempt, when the recorder left them at 0.
    let sequence = 0;
    const recorder: Recorder = {
      ...inner,
      begin: (r) => {
        run = r;
        inner.begin(r);
      },
      save: (r) => {
        run = r;
        inner.save(r);
      },
      append: (id, type, data) => {
        const event = inner.append(id, type, data);
        return event.sequence_number > 0
          ? event
          : { ...event, sequence_number: ++sequence };
      },
    };
    let runner: Runner;
    // The last proposed action's surface, for the approval rule.
    const seen: ApprovalView = {};
    const steps: JournalStep[] = [];
    const emit = (snapshot: Snapshot) => {
      deps.diagnostics?.snapshot(snapshot);
      for (const event of snapshot.events.slice(printed)) {
        const d = event.data ?? {};
        if (event.type === "ModelRequestStarted") counters.modelCalls++;
        if (event.type === "ActionRetargetRequested") {
          counters.retries++;
          // The analyzer's own rule, so IDE_BLIND means what BLIND_SURFACE does.
          if (
            frictionCodes({ event: event.type, data: d }).includes(
              "BLIND_SURFACE",
            )
          )
            counters.blindRetries++;
        }
        if (event.type === "PolicyConfirmationRequested") counters.approvals++;
        if (event.type === "UserTakeoverStarted") {
          counters.takeovers++;
          const source = typeof d.source === "string" ? d.source : "handoff";
          if (source in counters.takeoverSources)
            counters.takeoverSources[source as TakeoverSource]++;
        }
        if (event.type === "ActionLoopDetected") counters.loops++;
        if (event.type === "NoProgressDetected") counters.noProgress++;
        // A click by name the helper read as no effect on every route.
        if (event.type === "ActionExecuted" && d.effect === "none")
          counters.clickNoEffect++;
        if (
          event.type === "ActionProposed" &&
          (d.action as { type?: unknown } | undefined)?.type === "fail"
        )
          counters.modelFailed = true;
        if (event.type === "RunPaused") counters.paused = true;
        if (event.type === "ActionFailed" && typeof d.code === "string")
          counters.failures[d.code] = (counters.failures[d.code] ?? 0) + 1;
        // A tool step never reaches the controller (the runner runs it
        // beside monitor), so the journal learns of it here: its type, the
        // frontmost app and, for a first-party tool, the tool's fixed id.
        // Never its arguments or its result.
        if (event.type === "ActionExecuted") {
          const action = d.action as
            { type?: unknown; tool?: unknown } | undefined;
          if (action?.type === "tool_call")
            steps.push({
              type: "tool_call",
              appId: snapshot.frame?.appId,
              ...(typeof action.tool === "string" &&
              FIRST_PARTY_TOOL.test(action.tool)
                ? { tool: action.tool }
                : {}),
            });
        }
        // A done the runner sent back, by why: a step refused earlier, or
        // the file the task asks to write unchanged since the run began.
        if (event.type === "ActionFailed" && d.code === "DONE_CHALLENGED") {
          const why = doneChallengeCode(d.reason);
          counters.doneChallenged[why] =
            (counters.doneChallenged[why] ?? 0) + 1;
        }
        if (event.type === "RunFailed" && typeof d.code === "string")
          counters.runFailedCode = d.code;
      }
      printed = snapshot.events.length;
      message = snapshot.message;
      const status = snapshot.run?.status;
      // The runner publishes RunPaused before it sets the pause message, so
      // the cause is read from the first snapshot that carries the paused
      // status.
      if (status === "paused")
        counters.pausedAfter ??= pausedAfterCode(snapshot.message);
      // One answer per prompt. Every snapshot is a fresh clone, so the
      // pending object is never the same twice: the prompt is counted by its
      // PolicyConfirmationRequested event instead, which the runner journals
      // once per question, after the confirming status it answers.
      if (
        status === "confirming" &&
        snapshot.pending &&
        counters.approvals > answered
      ) {
        answered = counters.approvals;
        const reason = snapshot.pending.reason;
        const approve =
          approvesPrompt(task, reason, caps.approveRoutine) &&
          approvalInContext(task, reason, {
            ...seen,
            frameAppId: snapshot.frame?.appId,
          });
        if (!approve) counters.approvalsDeclined++;
        // What was asked, as a code, and how it was answered: the ledger
        // otherwise says only how many questions were declined, which cannot
        // tell a task's own unlisted Save from a policy false positive.
        const tally = (counters.approvalCodes[approvalCode(reason)] ??= {
          asked: 0,
          approved: 0,
          declined: 0,
        });
        tally.asked++;
        if (approve) tally.approved++;
        else tally.declined++;
        setTimeout(() => runner.confirm(approve), 0);
      }
      if (status === "paused" || status === "takeover") {
        if (held === status) return;
        held = status;
        // Nobody is there to say continue during an unattended benchmark.
        setTimeout(() => runner.stop(`Benchmark stopped at ${status}.`), 0);
      }
    };
    const markers = markerValues(parameters);
    runner = new Runner(
      journaled(controller, steps, markers, state, now, seen),
      client,
      recorder,
      settings,
      emit,
      [],
      deps.memoryAccess,
      // The files tool and the reader: a bench run has no monitor hook.
      {
        ...(deps.tools ? { tools: deps.tools } : {}),
        ...(deps.deliverables ? { deliverables: deps.deliverables } : {}),
      },
    );
    state.runner = runner;
    const started = now().getTime();
    try {
      // The instruction stands for what the user typed or said, so the
      // policy's "task" setting reads it as their words (a typed command
      // starts the same way in electron/main.ts); without it every undoable
      // step the words asked for asked anyway (cycle 20260919-0739).
      await runner.start(fillInstruction(task.instruction, parameters), {
        origin: "bench",
        taskSource: "user_words",
      });
    } catch {
      // A thrown start is already recorded in the run status; keep going.
    }
    const seconds = (now().getTime() - started) / 1000;
    state.runner = undefined;

    const currentRun = run as Run | null;
    const runStatus = currentRun?.status ?? "failed";
    const agentHandoffs =
      counters.takeovers - counters.takeoverSources.manual_input;
    const ending = () =>
      endingCode({
        runStatus,
        message,
        manualTakeover: state.manualInput,
        agentHandoffs,
        paused: counters.paused,
        emergencyStop: state.emergency,
        interrupted: state.stopped,
        modelFailed: counters.modelFailed,
        deliverableMissing: counters.runFailedCode === "DELIVERABLE_MISSING",
      });
    // A stop from the terminal (SIGTERM, or Ctrl-C with no touch on this
    // Mac) cut the run short and nothing else explains the ending: the model
    // never got to finish, so the partial end state is not graded, the row is
    // the harness's, and a resume runs the attempt again. Nothing is read
    // back either: the person asked for everything to stop, and reading
    // would resume the helper.
    const interrupted = ending() === "INTERRUPTED";

    // The end state, read back through the native controller: frontmost
    // bundle id, the committed page host and the window's accessibility text.
    // No pixels. The run's own finally latched the helper and capture refuses
    // while latched, so the helper is resumed first; that also re-arms the
    // tap, so a person touching the Mac while the grader reads still marks
    // the attempt. After real input (or Escape) there is nothing to read: the
    // grade is MANUAL_TAKEOVER whatever the screen shows, and resuming would
    // let the tap re-arm on whatever the person switched to.
    let endState:
      | { appId?: string; context?: Frame["context"]; domain?: string }
      | undefined;
    let unseenInput = false;
    if (!state.manualInput && !interrupted) {
      try {
        await controller.resume();
        const surface = await controller.surface();
        const frame = await controller.capture();
        endState = {
          appId: frame?.appId ?? surface?.appId,
          context: frame?.context,
          domain: surface?.domain,
        };
      } catch {
        endState = undefined;
      } finally {
        controller.stop();
      }
      // Input while the helper is latched (between the gate and the runner's
      // own resume, and around the grading read) is recorded by the tap but
      // reported to nobody. The tap counts unmarked input only, so an idle
      // clock that restarted during the attempt means a person.
      if (!state.manualInput)
        unseenInput = unseenManualInput(
          before,
          await presenceOf(controller),
          elapsed(),
        );
    }
    const journal: RunJournal = {
      status: runStatus,
      settled: terminal(runStatus),
      actions: currentRun?.actions ?? 0,
      steps,
      approvals: counters.approvals,
      approvalsDeclined: counters.approvalsDeclined,
      retries: counters.retries,
      takeovers: counters.takeovers,
      takeoverSources: counters.takeoverSources,
      // Read after the grading capture, so input during grading counts too.
      manualTakeover: state.manualInput,
      modelFailed: counters.modelFailed,
      loops: counters.loops,
      noProgress: counters.noProgress,
      clickNoEffect: counters.clickNoEffect,
      failures: counters.failures,
      endingCode: ending(),
      cost: currentRun?.usage?.cost ?? 0,
      seconds,
      modelCalls: counters.modelCalls,
    };
    const evidence: Evidence = { journal, parameters, ...endState };
    // The readers the task declared, from the suite lane. A reader that
    // throws leaves its evidence absent and the task's grader says unknown.
    if (
      task.evidence?.length &&
      deps.readEvidence &&
      !state.manualInput &&
      !interrupted
    ) {
      try {
        Object.assign(evidence, await deps.readEvidence(task, ctx));
      } catch {
        // Unknown, never a pass.
      }
    }
    // Real input first: when it lands during the grading read the capture
    // refuses and there is no end state, but the attempt is still the
    // environment's, not a grader unknown counted against the model.
    let grade: Grade;
    if (state.manualInput) grade = unverifiable("MANUAL_TAKEOVER");
    else if (interrupted) grade = unverifiable("SKIPPED");
    else if (unseenInput) grade = unverifiable("MANUAL_INPUT_UNSEEN");
    else if (!evidence.appId)
      grade = { status: "unknown", checks: {}, reason: "NO_END_STATE" };
    else {
      // A grader that throws (evidence a reader left out, a shape it did not
      // expect) is debt in the grader, not the end of the cycle: the run
      // happened and was paid for, so it still gets a row with its cost.
      try {
        grade = gradeTask(task, evidence);
      } catch {
        grade = unverifiable("GRADER_ERROR");
      }
    }

    return {
      ...base,
      runId: currentRun?.id,
      status: grade.status,
      reason: grade.reason,
      ...(grade.missingFacts?.length
        ? { missingFacts: grade.missingFacts }
        : {}),
      ...(grade.noteRoute ? { noteRoute: grade.noteRoute } : {}),
      checks: grade.checks,
      partial: grade.partial,
      runStatus: journal.status,
      endingCode: journal.endingCode,
      pausedAfter: counters.pausedAfter,
      ...honesty(journal.status, grade, task),
      actions: journal.actions,
      seconds,
      cost: journal.cost,
      inputTokens: currentRun?.usage?.inputTokens ?? 0,
      outputTokens: currentRun?.usage?.outputTokens ?? 0,
      cachedInputTokens: currentRun?.usage?.cachedInputTokens,
      modelCalls: journal.modelCalls,
      approvals: journal.approvals,
      approvalsDeclined: journal.approvalsDeclined,
      ...(Object.keys(counters.approvalCodes).length
        ? { approvalCodes: counters.approvalCodes }
        : {}),
      retries: journal.retries,
      ...(counters.blindRetries ? { blindRetries: counters.blindRetries } : {}),
      handoffs: {
        manual: Math.max(
          counters.takeoverSources.manual_input,
          state.manualInput ? 1 : 0,
        ),
        agent: agentHandoffs,
      },
      takeovers: journal.takeovers,
      takeoverSources: journal.takeoverSources,
      manualTakeover: journal.manualTakeover,
      modelFailed: journal.modelFailed,
      loops: journal.loops,
      noProgress: journal.noProgress,
      ...(journal.clickNoEffect
        ? { clickNoEffect: journal.clickNoEffect }
        : {}),
      failures: journal.failures,
      ...(Object.keys(counters.doneChallenged).length
        ? { doneChallenged: counters.doneChallenged }
        : {}),
      ...(await cleanupOnce()),
    };
  } finally {
    await cleanupOnce();
  }
}
