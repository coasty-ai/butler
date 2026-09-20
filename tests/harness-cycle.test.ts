import { afterAll, describe, expect, it, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  defaultSettings,
  settingsSchema,
  type Action,
  type Observation,
  type ProviderResult,
  type Settings,
  type Snapshot,
  type Surface,
} from "../src/core/schema";
import { withoutAsking, type PolicyContext } from "../src/core/policy";
import { autonomyChange } from "../src/ui/settings-voice";
import { FILES_APPEND, fakeTools } from "./tool-fakes";
import { BENCH_TOOL_SETTINGS, createBenchTools } from "../src/gym/bench/tools";
import { LOOP_STUCK_MESSAGE } from "../src/core/runner";
import {
  createHarnessState,
  needsBenchDir,
  onEmergencyStop,
  onManualInput,
  runAttempt,
  safeRelative,
  unseenManualInput,
  type AttemptCell,
  type AttemptDeps,
  type BenchController,
} from "../src/gym/bench/attempt";
import {
  acquireDesktopLock,
  appProcesses,
  desktopLockPath,
  gateDecision,
  harnessProcesses,
  idleRequired,
  parseAssertions,
  parseBundleId,
  parseConsoleLocked,
  parseHidIdle,
  parseScreensaverIdle,
  parseSecureInputPid,
  preflight,
  readGate,
  readSecureInput,
  readSystem,
  releaseDesktopLock,
  unsettledRuns,
  type GateReport,
  type PreflightInput,
  type PresenceReport,
  type PresenceSource,
  type SurfaceRead,
} from "../src/gym/bench/presence";
import {
  AUTONOMY_MODES,
  DEFAULT_AUTONOMY,
  attemptCap,
  autonomyOf,
  autonomySettings,
  buildPlan,
  ceiling,
  cellPrices,
  cellSettings,
  defaultCycleId,
  designHash,
  estimateSeconds,
  fitsTimeBox,
  gateWaitsOf,
  harnessInput,
  ledgerResults,
  parseAutonomy,
  parseDuration,
  parseLedger,
  parseMatrix,
  parseShard,
  planHash,
  probeScope,
  remaining,
  rerunnable,
  cutByInput,
  runCycleLoop,
  shardOf,
  spent,
  type CycleCaps,
  type LedgerLine,
  type PlanEntry,
  type QueueEntry,
} from "../src/gym/bench/cycle";
import {
  binomialTail,
  mcnemarExact,
  normalCdf,
  powerN,
  twoProportionZ,
  wilson,
} from "../src/gym/bench/stats";
import {
  PROBE_INFORMATIONAL,
  SUPERSEDES,
  compareCycles,
  compareModels,
  familyKey,
  selectBaseline,
  timingCycles,
  type ComparableCycle,
} from "../src/gym/bench/compare";
import {
  HARNESS_VERSION,
  autonomyLine,
  approvalsByReason,
  buildCycleResults,
  catalogueHash,
  classRates,
  comparable,
  contentFree,
  failureClasses,
  probeLine,
  renderCycleReport,
  type CycleInfo,
} from "../src/gym/bench/cycle-report";
import {
  analyze,
  budgetCode,
  frictionCodes,
  noteFor,
  ownerOf,
  parseDiagnostics,
} from "../src/gym/bench/analyze";
import {
  TASK_SKIPS,
  aggregate,
  endingCode,
  leftoversLine,
  ran,
  renderSummary,
  renderTable,
  type AttemptResult,
} from "../src/gym/bench/report";
import type {
  BenchTask,
  Evidence,
  FixtureHandle,
  Grade,
  JournalStep,
  RunJournal,
  TakeoverSource,
} from "../src/gym/bench/types";
import {
  BROWSER_EXECUTABLES,
  REMEDY,
  agendaAccess,
  agendaSetupError,
  appsOpen,
  appsToWatch,
  benchOwnBrowser,
  chooseBrowser,
  ideBlind,
  installedApps,
  launchable,
  missingKey,
  openedByPerson,
  parseWindowFacts,
  presentKeyNames,
  readStartFacts,
  readWindowFacts,
  requiredApps,
  runningApps,
  runningDocumentApps,
  safeOpen,
  skipRemedy,
  startSkip,
  startSkipDetail,
  startSkipDetails,
  startSkips,
  taskGate,
  windowScript,
} from "../src/gym/bench/preflight";
import {
  MAX_CLEANUPS,
  RETRYABLE_LEFTOVERS,
  SPOTLIGHT_SETTLE_MS,
  TRANSIENT_LEFTOVERS,
  benchRootDirty,
  benchRootTokens,
  fileTokenLedger,
  remainingLeftovers,
  settleDelay,
  sweepTokens,
  tokenLedgerDir,
} from "../src/gym/bench/sweep";
import { LONG_CATALOGUE } from "../src/gym/bench/catalogue-long";
import { MARKET_CATALOGUE } from "../src/gym/bench/catalogue-market";
import { catalogueFor, selectSuite } from "../src/gym/bench/suites";
import { CATALOGUE } from "../src/gym/bench/catalogue";
import {
  APPROVAL_APPS,
  BROWSER_APPS,
  BROWSER_NAMES,
  BROWSER_PREFERENCE,
  CALCULATOR,
  FIXTURE_HOST,
  REPLACE_REASON,
  SUBMIT_REASON,
  TEXTEDIT,
  approvalInContext,
  approvesPrompt,
  chosenBrowsers,
  gradeTask,
  markerValues,
  namesBrowser,
  withBrowserCheck,
} from "../src/gym/bench/graders";
import {
  createReaders,
  sweepsStrayFiles,
  strayAction,
} from "../src/gym/bench/readers";
import { drawOrders, pages } from "../src/gym/bench/fixtures";
import { compareProbe } from "../src/gym/bench/compare";
import {
  graderFiles,
  probeClassRates,
  sameTemplates,
} from "../src/gym/bench/cycle-report";
import { seeded, shardsNeeded } from "../src/gym/bench/cycle";
import {
  modelPrice,
  providerDefaults,
  providerKeyEnv,
} from "../src/providers/catalog";
import { importEnvCredentials } from "../electron/credentials";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "oa-harness-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

type Decision = { kind: string; reason: string };
// Pins the policy's answer for a step so the harness's reaction to an
// approval prompt is tested apart from the policy vocabulary.
const policy = vi.hoisted(() => ({
  evaluate: undefined as undefined | ((a: Action) => Decision),
}));
vi.mock("../src/core/policy", async (original) => {
  const actual = await original<typeof import("../src/core/policy")>();
  return {
    ...actual,
    // Transparent unless a test scripts it: the context (the user's words,
    // a tool step's spec and validation) reaches the real policy.
    evaluate: (
      a: Action,
      s: Surface,
      st: Settings,
      synthetic: boolean,
      context?: PolicyContext,
    ): Decision =>
      policy.evaluate?.(a) ?? actual.evaluate(a, s, st, synthetic, context),
  };
});

/* --------------------------------------------------------------- fixtures */

const CALC = "com.apple.Calculator";
const TOKEN = /^benchnote[0-9a-z]{4}$/;
const geometry = {
  display_id: 1,
  x: 0,
  y: 0,
  width: 1440,
  height: 900,
  native_width: 2880,
  native_height: 1800,
  model_width: 1280,
  model_height: 720,
  scale_factor: 2,
};
const sources = (
  over: Partial<Record<TakeoverSource, number>> = {},
): Record<TakeoverSource, number> => ({
  manual_input: 0,
  request_user: 0,
  policy: 0,
  surface: 0,
  handoff: 0,
  ...over,
});

/**
 * A controller that behaves like the helper where it matters here: stop()
 * latches it, resume() clears the latch, and capture refuses while latched
 * (Controller.swift ensureRunning). Every call is logged in order.
 */
function fakeController(
  o: {
    appId?: string;
    /** What surface() reports on top of the frontmost app (modal, roles). */
    surface?: Partial<Surface>;
    presence?: () => Promise<PresenceReport>;
    onGradingCapture?: () => void;
  } = {},
) {
  const calls: string[] = [];
  let latched = false;
  let stops = 0;
  let frames = 0;
  const appId = o.appId ?? CALC;
  const controller: BenchController = {
    kind: "native",
    surface: async () => {
      calls.push("surface");
      return {
        appId,
        pid: 7,
        secureInput: false,
        unknown: false,
        ...o.surface,
      };
    },
    capture: async () => {
      calls.push("capture");
      if (latched) throw new Error("STOPPED");
      if (stops > 0) o.onGradingCapture?.();
      frames++;
      return {
        id: `frame-${frames}`,
        // One screen throughout: the runner re-captures after an approval
        // and refuses to act on a screen that changed.
        sha256: "sha",
        image: "",
        geometry,
        capturedAt: 0,
        synthetic: false,
        appId,
        context: { appName: "Calculator", windowTitle: "Calculator" },
      };
    },
    execute: async (action) => {
      calls.push(`execute:${action.type}`);
    },
    resume: async () => {
      calls.push("resume");
      latched = false;
    },
    stop: () => {
      calls.push("stop");
      latched = true;
      stops++;
    },
    request: async (method: string) => {
      calls.push(`request:${method}`);
      return {};
    },
    ...(o.presence ? { presence: o.presence } : {}),
  };
  return { controller, calls };
}

const usage = { inputTokens: 100, outputTokens: 20, cost: 0.002 };
/** A provider that plays its actions in order, then says done. */
function scripted(actions: Record<string, unknown>[] = []) {
  let i = 0;
  return {
    next: async (o: Observation): Promise<ProviderResult> => ({
      usage,
      action: {
        ...(actions[i++] ?? { type: "done", summary: "ok" }),
        frame_id: o.frame.id,
      },
    }),
  };
}

const CELL: AttemptCell = {
  provider: "openai",
  model: "gpt-test",
  cell: "openai:gpt-test",
  settings: structuredClone(defaultSettings),
};

/** A task graded on the frontmost app only, with hooks the tests fill in. */
function testTask(over: Partial<BenchTask> = {}): BenchTask {
  return {
    id: "test-open",
    instruction: "Open Calculator",
    apps: [CALC],
    category: "calculator",
    difficulty: "easy",
    maxCost: 0.05,
    maxActions: 8,
    maxSeconds: 60,
    safety: "test",
    verifies: "test",
    grade: (evidence) =>
      evidence.appId === CALC
        ? { status: "passed", checks: { frontmost: true } }
        : {
            status: "failed",
            checks: { frontmost: false },
            reason: "NOT_FRONTMOST",
          },
    ...over,
  };
}

function attemptDeps(
  controller: BenchController,
  over: Partial<AttemptDeps> = {},
) {
  const state = createHarnessState();
  const launches: string[] = [];
  const deps: AttemptDeps = {
    controller,
    clients: { [CELL.cell]: scripted() },
    state,
    // Never LaunchServices in a test: that would bring the Finder forward.
    launch: async (target, app) => {
      launches.push(`${app ?? "-"}:${target ?? "-"}`);
    },
    sleep: async () => {},
    settleMs: 0,
    // Never the user's home: a bench folder only ever lands in the OS temp dir.
    benchRoot: join(scratch, "bench"),
    ...over,
  };
  return { deps, state, launches };
}

const caps = { maxCost: 0.05, approveRoutine: false };

/* ------------------------------------------------------------ attempt.ts */

describe("one attempt through the real runner", () => {
  it("resumes the latched helper before the grading capture, then latches it again", async () => {
    const { controller, calls } = fakeController();
    const { deps } = attemptDeps(controller);
    const result = await runAttempt(deps, CELL, testTask(), 1, caps);
    // The run's own finally latched the helper; a capture then would throw
    // and every attempt would grade NO_END_STATE.
    expect(result.status).toBe("passed");
    expect(result.reason).toBeUndefined();
    const runStop = calls.indexOf("stop");
    const tail = calls.slice(runStop);
    expect(tail).toEqual(["stop", "resume", "surface", "capture", "stop"]);
    expect(result.runStatus).toBe("completed");
    expect(result.claimed).toBe(true);
    expect(result.falseDone).toBe(false);
    expect(result.endingCode).toBe("COMPLETED");
    expect(result.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.cell).toBe(CELL.cell);
    expect(result.cost).toBeCloseTo(0.002);
  });

  /**
   * Cycle 20260919-1646-09c5412: memory-log-expense-ledger #1 said done
   * after three actions with the ledger unchanged (ROW_NOT_APPENDED). With
   * the reader wired, the same run is sent back once over the file and
   * fails at the second done: the row says so by reason and ending, and the
   * grade still says what the file lacked.
   */
  it("holds a done to the task's named file: challenged once, then failed by the runner, counted on the row", async () => {
    const { controller } = fakeController();
    const asked: string[] = [];
    const same = { exists: true, size: 64, mtimeMs: 1_700_000_000_000 };
    const { deps } = attemptDeps(controller, {
      deliverables: async (path) => {
        asked.push(path);
        return same;
      },
    });
    const task = testTask({
      id: "memory-log-expense-ledger",
      instruction:
        "Log an expense in {benchPath}/{token}-ledger.csv: today, taxi, 12 dollars. Keep the rows that are there.",
      // As the catalogue's tasks do: the folder and token the words are
      // filled with come from prepare.
      prepare: async (ctx) => ({
        token: ctx.token(),
        benchPath: ctx.benchPath,
      }),
      grade: () => ({
        status: "failed",
        checks: { appended: false },
        reason: "ROW_NOT_APPENDED",
      }),
    });
    const result = await runAttempt(deps, CELL, task, 1, caps);
    // The path the words named, filled with this attempt's folder and token,
    // read at the start and at each of the two dones; never the words.
    expect(asked).toHaveLength(3);
    expect(new Set(asked).size).toBe(1);
    expect(asked[0]).toMatch(/\/bench\/[a-z0-9]+\/[a-z0-9]+-ledger\.csv$/);
    expect(asked[0]).not.toContain("Log an expense");
    expect(result.runStatus).toBe("failed");
    expect(result.endingCode).toBe("DELIVERABLE_MISSING");
    expect(result.doneChallenged).toEqual({ DELIVERABLE_UNCHANGED: 1 });
    expect(result.failures).toMatchObject({ DONE_CHALLENGED: 1 });
    // No claim: an honest failure in the grader's books, with its reason.
    expect(result.claimed).toBe(false);
    expect(result.falseDone).toBe(false);
    expect(result.honestFailure).toBe(true);
    expect(result.modelFailed).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("ROW_NOT_APPENDED");
    // The same task with the file changed between the dones: the claim
    // repeated is graded as any, and the row keeps the one check.
    let reads = 0;
    const { deps: changing } = attemptDeps(controller, {
      deliverables: async () =>
        reads++ < 2 ? same : { ...same, size: 91, mtimeMs: same.mtimeMs + 1 },
    });
    const repeated = await runAttempt(changing, CELL, task, 1, caps);
    expect(repeated.runStatus).toBe("completed");
    expect(repeated.endingCode).toBe("COMPLETED");
    expect(repeated.doneChallenged).toEqual({ DELIVERABLE_UNCHANGED: 1 });
    expect(repeated.claimed).toBe(true);
    expect(repeated.falseDone).toBe(true);
    // Without the reader, or without a file in the words, nothing is asked
    // and the row carries no checks, as before.
    const { deps: unwired } = attemptDeps(controller);
    const bare = await runAttempt(unwired, CELL, task, 1, caps);
    expect(bare.runStatus).toBe("completed");
    expect(bare.doneChallenged).toBeUndefined();
    const plain: string[] = [];
    const { deps: noFile } = attemptDeps(controller, {
      deliverables: async (path) => {
        plain.push(path);
        return same;
      },
    });
    const opened = await runAttempt(noFile, CELL, testTask(), 1, caps);
    expect(plain).toEqual([]);
    expect(opened.doneChallenged).toBeUndefined();
    expect(opened.status).toBe("passed");
  });

  it("brings the Finder forward through LaunchServices before prepare", async () => {
    const order: string[] = [];
    const { controller } = fakeController();
    const { deps } = attemptDeps(controller, {
      launch: async (target, app) => {
        order.push(`launch:${app}:${target ?? "-"}`);
      },
    });
    await runAttempt(
      deps,
      CELL,
      testTask({
        prepare: async () => {
          order.push("prepare");
          return { a: "1" };
        },
      }),
      1,
      caps,
    );
    expect(order).toEqual(["launch:Finder:-", "prepare"]);
  });

  it("runs a note task's append through the tool layer it is given, in the default mode, and journals the step", async () => {
    const { controller } = fakeController({ appId: TEXTEDIT });
    const tools = fakeTools({ tools: [FILES_APPEND] });
    const path = "~/OpenAssistBench/benchnote0a1b/benchnote0a1b-notes.txt";
    let steps: unknown;
    const { deps } = attemptDeps(controller, {
      clients: {
        [CELL.cell]: scripted([
          {
            type: "tool_call",
            tool: "files__append_text_file",
            args: { path, text: "Q3 total 15,888" },
            finish: true,
          },
        ]),
      },
      tools: tools.access,
    });
    const result = await runAttempt(
      deps,
      CELL,
      testTask({
        apps: [TEXTEDIT],
        instruction: `Find the Q3 total and write it on a new line in ${path}. Save it.`,
        grade: (evidence) => {
          steps = evidence.journal.steps;
          return { status: "passed", checks: { noted: true } };
        },
      }),
      1,
      caps,
    );
    // The default "task" mode ran it on the task's own words: the path
    // grounds the call, and the verified write ended the run.
    expect(tools.calls).toEqual([
      {
        id: "files__append_text_file",
        args: { path, text: "Q3 total 15,888" },
      },
    ]);
    expect(result.runStatus).toBe("completed");
    expect(result.approvals).toBe(0);
    expect(result.status).toBe("passed");
    expect(steps).toEqual([
      { type: "tool_call", appId: TEXTEDIT, tool: "files__append_text_file" },
    ]);
    // Without a tool layer the same step is refused and the run goes on to the screen.
    const bare = fakeTools({ tools: [] });
    const { deps: none } = attemptDeps(controller, {
      clients: {
        [CELL.cell]: scripted([
          {
            type: "tool_call",
            tool: "files__append_text_file",
            args: { path, text: "x" },
            finish: true,
          },
        ]),
      },
    });
    let bareSteps: unknown;
    await runAttempt(
      none,
      CELL,
      testTask({
        grade: (evidence) => {
          bareSteps = evidence.journal.steps;
          return { status: "passed", checks: {} };
        },
      }),
      1,
      caps,
    );
    expect(bare.calls).toEqual([]);
    expect(bareSteps).toEqual([]);
  });

  it("stops the run outright on real input, even while it is confirming", async () => {
    policy.evaluate = (a) =>
      a.type === "click"
        ? { kind: "CONFIRM", reason: "Save these changes?" }
        : { kind: "ALLOW", reason: "" };
    try {
      const { controller, calls } = fakeController({ appId: TEXTEDIT });
      const state = createHarnessState();
      const touch = onManualInput(state);
      const { deps } = attemptDeps(controller, {
        state,
        clients: {
          [CELL.cell]: scripted([{ type: "click", x: 0.5, y: 0.5 }]),
        },
        // A person touches the Mac as the approval prompt appears; the
        // harness has already queued its yes by then.
        diagnostics: {
          snapshot: (s: Snapshot) => {
            if (s.run?.status === "confirming") setTimeout(touch, 0);
          },
        },
      });
      const result = await runAttempt(
        deps,
        CELL,
        testTask({ apps: [TEXTEDIT], approve: ["Save these changes?"] }),
        1,
        { maxCost: 0.05, approveRoutine: true },
      );
      expect(calls).not.toContain("execute:click");
      expect(result.status).toBe("unknown");
      expect(result.reason).toBe("MANUAL_TAKEOVER");
      expect(result.manualTakeover).toBe(true);
      expect(result.runStatus).toBe("cancelled");
      // Nothing is read back after real input: the screen is the person's,
      // and resuming would re-arm the helper on it.
      expect(calls.slice(calls.indexOf("stop"))).not.toContain("resume");
    } finally {
      policy.evaluate = undefined;
    }
  });

  it("approves only prompts the task lists, and only under --approve-routine", async () => {
    try {
      const run = async (reason: string, approveRoutine: boolean) => {
        policy.evaluate = (a) =>
          a.type === "click"
            ? { kind: "CONFIRM", reason }
            : { kind: "ALLOW", reason: "" };
        const { controller, calls } = fakeController({ appId: TEXTEDIT });
        const { deps } = attemptDeps(controller, {
          clients: {
            [CELL.cell]: scripted([{ type: "click", x: 0.5, y: 0.5 }]),
          },
        });
        const result = await runAttempt(
          deps,
          CELL,
          testTask({ apps: [TEXTEDIT], approve: ["Save these changes?"] }),
          1,
          { maxCost: 0.05, approveRoutine },
        );
        return { result, clicked: calls.includes("execute:click") };
      };
      const listed = await run("Save these changes?", true);
      expect(listed.clicked).toBe(true);
      expect(listed.result.approvalsDeclined).toBe(0);
      // The row says what was asked, as a code, and how it was answered.
      expect(listed.result.approvalCodes).toEqual({
        SAVE_CHANGES: { asked: 1, approved: 1, declined: 0 },
      });
      // Same shape of question, not on the list: declined, and answered
      // once although the runner publishes the prompt in two snapshots.
      const order = await run("Place this order?", true);
      expect(order.clicked).toBe(false);
      expect(order.result.approvals).toBe(1);
      expect(order.result.approvalsDeclined).toBe(1);
      expect(order.result.approvalCodes).toEqual({
        PLACE_ORDER: { asked: 1, approved: 0, declined: 1 },
      });
      const off = await run("Save these changes?", false);
      expect(off.clicked).toBe(false);
      expect(off.result.approvalsDeclined).toBe(1);
      expect(off.result.approvalCodes).toEqual({
        SAVE_CHANGES: { asked: 1, approved: 0, declined: 1 },
      });
      // A question the table does not know is counted, as OTHER.
      const other = await run("Feed the cat?", true);
      expect(other.clicked).toBe(false);
      expect(other.result.approvalCodes).toEqual({
        OTHER: { asked: 1, approved: 0, declined: 1 },
      });
      expect(JSON.stringify(other.result)).not.toContain("Feed the cat");
    } finally {
      policy.evaluate = undefined;
    }
  });

  it("approves a listed prompt only while one of the task's own applications is in front", async () => {
    try {
      policy.evaluate = (a) =>
        a.type === "click"
          ? { kind: "CONFIRM", reason: "Save these changes?" }
          : { kind: "ALLOW", reason: "" };
      const run = async (appId: string) => {
        const { controller, calls } = fakeController({ appId });
        const { deps } = attemptDeps(controller, {
          clients: {
            [CELL.cell]: scripted([{ type: "click", x: 0.5, y: 0.5 }]),
          },
        });
        const result = await runAttempt(
          deps,
          CELL,
          testTask({
            apps: [TEXTEDIT, CALC],
            approve: ["Save these changes?"],
          }),
          1,
          { maxCost: 0.05, approveRoutine: true },
        );
        return { result, clicked: calls.includes("execute:click") };
      };
      // In TextEdit, the task's own app: approved as before.
      const own = await run(TEXTEDIT);
      expect(own.clicked).toBe(true);
      expect(own.result.approvalsDeclined).toBe(0);
      // Calculator is the task's too, but a Save there is not a bench
      // document's: the reason is scoped to TextEdit.
      const scoped = await run(CALC);
      expect(scoped.clicked).toBe(false);
      expect(scoped.result.approvalsDeclined).toBe(1);
      // The same listed question with the Finder in front would save the
      // Finder's (or anyone's) document: declined, and counted.
      const other = await run("com.apple.finder");
      expect(other.clicked).toBe(false);
      expect(other.result.approvals).toBe(1);
      expect(other.result.approvalsDeclined).toBe(1);
    } finally {
      policy.evaluate = undefined;
    }
  });

  it("approves Replace only with no sheet or dialog in front", async () => {
    try {
      policy.evaluate = (a) =>
        a.type === "click"
          ? { kind: "CONFIRM", reason: "Replace the existing item?" }
          : { kind: "ALLOW", reason: "" };
      const run = async (modal: boolean) => {
        const { controller, calls } = fakeController({
          appId: TEXTEDIT,
          surface: modal ? { modal: true } : {},
        });
        const { deps } = attemptDeps(controller, {
          clients: {
            [CELL.cell]: scripted([{ type: "click", x: 0.5, y: 0.5 }]),
          },
        });
        const result = await runAttempt(
          deps,
          CELL,
          testTask({
            apps: [TEXTEDIT],
            approve: ["Save these changes?", "Replace the existing item?"],
          }),
          1,
          { maxCost: 0.05, approveRoutine: true },
        );
        return { result, clicked: calls.includes("execute:click") };
      };
      // The Find bar's Replace button: no sheet, approved.
      const findBar = await run(false);
      expect(findBar.clicked).toBe(true);
      expect(findBar.result.approvalsDeclined).toBe(0);
      // A Save panel's "already exists, replace it?" is a sheet: declined,
      // though the reason and the application are the same.
      const sheet = await run(true);
      expect(sheet.clicked).toBe(false);
      expect(sheet.result.approvalsDeclined).toBe(1);
    } finally {
      policy.evaluate = undefined;
    }
  });

  it("approves a Submit only on a page of the fixture server", async () => {
    try {
      policy.evaluate = (a) =>
        a.type === "click"
          ? { kind: "CONFIRM", reason: SUBMIT_REASON }
          : { kind: "ALLOW", reason: "" };
      const run = async (surface: Partial<Surface>) => {
        const { controller, calls } = fakeController({
          appId: "com.google.Chrome",
          surface,
        });
        const { deps } = attemptDeps(controller, {
          clients: {
            [CELL.cell]: scripted([{ type: "click", x: 0.5, y: 0.5 }]),
          },
        });
        const result = await runAttempt(
          deps,
          CELL,
          testTask({ apps: BROWSER_APPS, approve: [SUBMIT_REASON] }),
          1,
          { maxCost: 0.05, approveRoutine: true },
        );
        return { result, clicked: calls.includes("execute:click") };
      };
      // The loopback form: the surface the click was checked on says so.
      const local = await run({
        domain: FIXTURE_HOST,
        targetWebHost: FIXTURE_HOST,
      });
      expect(local.clicked).toBe(true);
      expect(local.result.approvalsDeclined).toBe(0);
      // The person's own browser restored a real site: its Authorize asks
      // the same question, and is declined.
      const real = await run({
        domain: "github.com",
        targetWebHost: "github.com",
      });
      expect(real.clicked).toBe(false);
      expect(real.result.approvalsDeclined).toBe(1);
      // No host known at all: no.
      const unknown = await run({});
      expect(unknown.clicked).toBe(false);
      expect(unknown.result.approvalsDeclined).toBe(1);
    } finally {
      policy.evaluate = undefined;
    }
  });

  it("asks for the agenda per attempt and hands prepare that attempt's answer", async () => {
    const asked: string[] = [];
    const answers = [true, false];
    const got: boolean[] = [];
    const agendaTask = testTask({
      id: "test-agenda",
      evidence: ["agenda"],
      prepare: async (context) => {
        got.push(!!context.agenda);
        return context.agenda ? { token: context.token() } : null;
      },
    });
    const { controller } = fakeController();
    const { deps } = attemptDeps(controller, {
      agendaFor: async (task) => {
        asked.push(task.id);
        return answers.shift() ? { add: async () => undefined } : undefined;
      },
    });
    const first = await runAttempt(deps, CELL, agendaTask, 1, caps);
    // The helper's answer changed between attempts (a teardown, a revoked
    // grant): the second attempt must not run on the first one's answer.
    const second = await runAttempt(deps, CELL, agendaTask, 2, caps);
    expect(asked).toEqual(["test-agenda", "test-agenda"]);
    expect(got).toEqual([true, false]);
    expect(first.reason).toBeUndefined();
    expect(second.reason).toBe("NO_PREPARED_TARGET");
  });

  it("keeps the token ledger around the attempt, and a failing ledger stops nothing", async () => {
    const benchRoot = join(scratch, "ledger-attempt");
    const events: string[] = [];
    const tokens = {
      open: (token: string, taskId: string) =>
        events.push(`open ${taskId} ${TOKEN.test(token)}`),
      started: (_token: string, at: number) =>
        events.push(`started ${Number.isFinite(at) && at > 0}`),
      close: (_token: string, leftovers: string[], failed: boolean) =>
        events.push(`close ${leftovers.join(",") || "clean"} ${failed}`),
    };
    const task = testTask({
      suite: "long",
      prepare: async (context) => {
        events.push("prepare");
        await context.write("a.txt", "x");
        return { token: context.token() };
      },
    });
    await runAttempt(
      attemptDeps(fakeController().controller, { benchRoot, tokens }).deps,
      CELL,
      task,
      1,
      caps,
    );
    // Open before anything carrying the token exists; the folder's birth
    // time once it does; close with what cleanup left (the default cleanup
    // keeps a folder with content).
    expect(events).toEqual([
      "open test-open true",
      "started true",
      "prepare",
      "close LEFTOVER_FILES false",
    ]);
    const broken = {
      open: () => {
        throw new Error("disk full");
      },
      started: () => {
        throw new Error("disk full");
      },
      close: () => {
        throw new Error("disk full");
      },
    };
    const result = await runAttempt(
      attemptDeps(fakeController().controller, {
        benchRoot,
        tokens: broken,
      }).deps,
      CELL,
      testTask(),
      1,
      caps,
    );
    expect(result.status).toBe("passed");
  });

  it("counts the retries a surface with no accessibility caused", async () => {
    try {
      policy.evaluate = (a) =>
        a.type === "type_text"
          ? { kind: "RETRY", reason: "No text field is focused." }
          : { kind: "ALLOW", reason: "" };
      const blind = await runAttempt(
        attemptDeps(fakeController().controller, {
          clients: {
            [CELL.cell]: scripted([{ type: "type_text", text: "hello" }]),
          },
        }).deps,
        CELL,
        testTask(),
        1,
        caps,
      );
      expect(blind.retries).toBe(1);
      expect(blind.blindRetries).toBe(1);
      // The same retry where the helper did see a focused field is not blind.
      const seen = await runAttempt(
        attemptDeps(
          fakeController({ surface: { focusedRole: "AXGroup" } }).controller,
          {
            clients: {
              [CELL.cell]: scripted([{ type: "type_text", text: "hello" }]),
            },
          },
        ).deps,
        CELL,
        testTask(),
        1,
        caps,
      );
      expect(seen.retries).toBe(1);
      expect(seen.blindRetries).toBeUndefined();
    } finally {
      policy.evaluate = undefined;
    }
  });

  it("grades input during the grading read as the environment's, read after the capture", async () => {
    const state = createHarnessState();
    const { controller } = fakeController({
      onGradingCapture: () => onManualInput(state)(),
    });
    const { deps } = attemptDeps(controller, { state });
    const result = await runAttempt(deps, CELL, testTask(), 1, caps);
    expect(result.status).toBe("unknown");
    expect(result.reason).toBe("MANUAL_TAKEOVER");
    expect(result.manualTakeover).toBe(true);
  });

  it("skips an attempt Escape reached during prepare, without starting a run", async () => {
    const state = createHarnessState();
    const { controller, calls } = fakeController();
    const { deps } = attemptDeps(controller, { state });
    const result = await runAttempt(
      deps,
      CELL,
      testTask({
        prepare: async () => {
          onEmergencyStop(state)();
          return { a: "1" };
        },
      }),
      1,
      caps,
    );
    expect(result.reason).toBe("SKIPPED");
    expect(result.runStatus).toBe("skipped");
    expect(result.endingCode).toBe("EMERGENCY_STOP");
    // Resuming would undo the latch Escape set.
    expect(calls).not.toContain("resume");
  });

  it("marks input the tap recorded but nobody reported as MANUAL_INPUT_UNSEEN", async () => {
    const started = Date.now();
    // Before the attempt, just before the run (still quiet), after it.
    const readings = [400, 400, 1];
    const { controller } = fakeController({
      presence: async () => ({
        hidIdleSeconds: 0,
        tapIdleSeconds: readings.shift() ?? 1,
        locked: false,
        displayAsleep: false,
        displayHeldAwake: true,
      }),
    });
    const { deps } = attemptDeps(controller);
    const cut = await runAttempt(deps, CELL, testTask(), 1, caps);
    expect(cut.status).toBe("unknown");
    expect(cut.reason).toBe("MANUAL_INPUT_UNSEEN");
    expect(cut.runStatus).toBe("completed");
    // A clock that kept running: nobody touched the Mac.
    const quiet = fakeController({
      presence: async () => ({
        hidIdleSeconds: 0,
        tapIdleSeconds: 400 + (Date.now() - started) / 1000,
        locked: false,
        displayAsleep: false,
        displayHeldAwake: true,
      }),
    });
    const clean = await runAttempt(
      attemptDeps(quiet.controller).deps,
      CELL,
      testTask(),
      1,
      caps,
    );
    expect(clean.status).toBe("passed");
  });

  it("stamps the agent's last input and feeds the cycle's diagnostics", async () => {
    const snapshots: string[] = [];
    const { controller } = fakeController();
    const { deps, state } = attemptDeps(controller, {
      clients: { [CELL.cell]: scripted([{ type: "key", key: "TAB" }]) },
      diagnostics: {
        snapshot: (s: Snapshot) => snapshots.push(s.run?.status ?? ""),
      },
    });
    const before = Date.now();
    const result = await runAttempt(deps, CELL, testTask(), 1, caps);
    expect(result.actions).toBe(1);
    expect(state.lastAgentInputAt).toBeGreaterThanOrEqual(before);
    expect(snapshots).toContain("completed");
    // The injected controller is wrapped, never patched.
    expect(Object.keys(controller)).not.toContain("journal");
  });

  it("gives declared readers their evidence and never runs them after real input", async () => {
    const reads: string[] = [];
    const { controller } = fakeController();
    const { deps } = attemptDeps(controller, {
      readEvidence: async (task, ctx) => {
        reads.push(ctx.token);
        return {
          files: { root: ctx.benchPath, entries: [] },
        };
      },
    });
    const seen: string[] = [];
    const task = testTask({
      suite: "long",
      evidence: ["files"],
      grade: (evidence) => {
        seen.push(evidence.files ? "files" : "none");
        return { status: "passed", checks: {} };
      },
    });
    await runAttempt(deps, CELL, task, 1, caps);
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatch(/^benchnote[0-9a-z]{4}$/);
    expect(seen).toEqual(["files"]);
    const state = createHarnessState();
    const touched = fakeController({
      onGradingCapture: () => onManualInput(state)(),
    });
    const after = attemptDeps(touched.controller, {
      state,
      readEvidence: async () => {
        reads.push("after-input");
        return {};
      },
    });
    await runAttempt(after.deps, CELL, task, 1, caps);
    expect(reads).not.toContain("after-input");
  });

  it("cleans up on every outcome, reports leftovers, and runs the task hook once", async () => {
    const benchRoot = join(scratch, "cleanup");
    mkdirSync(benchRoot, { recursive: true });
    const hooks: string[] = [];
    const writes = testTask({
      suite: "long",
      prepare: async (context) => {
        await context.write("notes/list.txt", "x");
        return { token: context.token() };
      },
      cleanup: async () => {
        hooks.push("task");
        return [];
      },
    });
    const { controller } = fakeController();
    const left = await runAttempt(
      attemptDeps(controller, { benchRoot }).deps,
      CELL,
      writes,
      1,
      caps,
    );
    // The default cleanup only removes an empty folder; content is reported.
    expect(left.leftovers).toEqual(["LEFTOVER_FILES"]);
    expect(hooks).toEqual(["task"]);
    // An attempt prepare skipped still cleans up.
    const skip = testTask({
      suite: "long",
      prepare: async () => null,
    });
    const skipped = await runAttempt(
      attemptDeps(fakeController().controller, { benchRoot }).deps,
      CELL,
      skip,
      1,
      caps,
    );
    expect(skipped.reason).toBe("NO_PREPARED_TARGET");
    expect(skipped.leftovers).toBeUndefined();
    // The suite's cleanup, when wired, owns the task hook.
    const suite: string[] = [];
    const wired = await runAttempt(
      attemptDeps(fakeController().controller, {
        benchRoot,
        cleanupAttempt: async (task, ctx) => {
          suite.push(ctx.token);
          rmSync(ctx.benchDir, { recursive: true, force: true });
          return [];
        },
      }).deps,
      CELL,
      writes,
      1,
      caps,
    );
    expect(suite).toHaveLength(1);
    expect(hooks).toEqual(["task"]);
    expect(wired.leftovers).toBeUndefined();
    // Only the one folder with content is left, and only inside the temp root.
    expect(readdirSync(benchRoot)).toHaveLength(1);
  });

  it("never starts a run after input during the settle or prepare", async () => {
    // The tap's clock restarted while prepare opened things: a person nudged
    // the trackpad and may be watching. The helper is latched, so nobody was
    // told; the run must not take the screen in front of them.
    const readings = [400, 1];
    const tapped = fakeController({
      presence: async () => ({
        hidIdleSeconds: 0,
        tapIdleSeconds: readings.shift() ?? 1,
        locked: false,
        displayAsleep: false,
        displayHeldAwake: true,
      }),
    });
    const cleaned: string[] = [];
    const prepared = testTask({
      suite: "long",
      prepare: async (context) => {
        await context.write("note.txt", "x");
        return { token: context.token() };
      },
    });
    const cut = await runAttempt(
      attemptDeps(tapped.controller, {
        cleanupAttempt: async (_task, ctx) => {
          cleaned.push(ctx.token);
          rmSync(ctx.benchDir, { recursive: true, force: true });
          return [];
        },
      }).deps,
      CELL,
      prepared,
      1,
      caps,
    );
    expect(cut).toMatchObject({
      status: "unknown",
      reason: "MANUAL_INPUT_UNSEEN",
      runStatus: "skipped",
      cost: 0,
    });
    expect(tapped.calls).not.toContain("resume");
    expect(tapped.calls.some((call) => call.startsWith("execute"))).toBe(false);
    expect(cleaned).toHaveLength(1);
    // Back to the queue, and the gate asks for the full --idle again.
    expect(cutByInput(cut)).toBe(true);
    // Input the helper did report during prepare stops it the same way.
    const state = createHarnessState();
    const flagged = fakeController();
    const touched = await runAttempt(
      attemptDeps(flagged.controller, { state }).deps,
      CELL,
      testTask({
        prepare: async () => {
          onManualInput(state)();
          return { a: "1" };
        },
      }),
      1,
      caps,
    );
    expect(touched).toMatchObject({
      reason: "MANUAL_TAKEOVER",
      runStatus: "skipped",
      manualTakeover: true,
    });
    expect(flagged.calls).not.toContain("resume");
    expect(cutByInput(touched)).toBe(true);
    // That input belonged to that attempt: the next one on the same state
    // runs once the gate has passed again.
    const next = await runAttempt(
      attemptDeps(fakeController().controller, { state }).deps,
      CELL,
      testTask(),
      1,
      caps,
    );
    expect(next.status).toBe("passed");
  });

  it("grades a grader that throws as GRADER_ERROR, with its cost, and still cleans up", async () => {
    const cleaned: string[] = [];
    const { controller } = fakeController();
    const { deps } = attemptDeps(controller, {
      // A reader that left its evidence out, as a failing reader does.
      readEvidence: async () => ({}),
      cleanupAttempt: async (_task, ctx) => {
        cleaned.push(ctx.token);
        return ["LEFTOVER_FILES"];
      },
    });
    const task = testTask({
      suite: "long",
      evidence: ["files"],
      prepare: async (context) => {
        await context.write("note.txt", "x");
        return { token: context.token() };
      },
      // A long-suite grader that trusts its reader.
      grade: (evidence) =>
        evidence.files!.entries.length
          ? { status: "passed", checks: {} }
          : { status: "failed", checks: {}, reason: "NO_NOTE" },
    });
    const result = await runAttempt(deps, CELL, task, 1, caps);
    expect(result).toMatchObject({
      status: "unknown",
      reason: "GRADER_ERROR",
      runStatus: "completed",
      claimed: true,
      unverifiableDone: true,
      leftovers: ["LEFTOVER_FILES"],
    });
    expect(result.cost).toBeCloseTo(0.002);
    expect(result.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(cleaned).toHaveLength(1);
    // Grader debt: it counts against success, and is the grader's to fix.
    expect(ran(result)).toBe(true);
    expect(ownerOf("GRADER_ERROR")).toBe("grader");
  });

  it("cleans up when something throws after the run, and checks the settings before anything exists", async () => {
    const benchRoot = join(scratch, "throws");
    const cleaned: string[] = [];
    let stops = 0;
    const { controller } = fakeController();
    const dying: BenchController = {
      ...controller,
      // The helper died while the grader read the end state back.
      stop: () => {
        controller.stop();
        if (++stops === 2) throw new Error("helper gone");
      },
    };
    const writes = testTask({
      suite: "long",
      prepare: async (context) => {
        await context.write("note.txt", "x");
        return { token: context.token() };
      },
    });
    await expect(
      runAttempt(
        attemptDeps(dying, {
          benchRoot,
          cleanupAttempt: async (_task, ctx) => {
            cleaned.push(ctx.token);
            rmSync(ctx.benchDir, { recursive: true, force: true });
            return [];
          },
        }).deps,
        CELL,
        writes,
        1,
        caps,
      ),
    ).rejects.toThrow("helper gone");
    expect(cleaned).toHaveLength(1);
    expect(readdirSync(benchRoot)).toEqual([]);
    // Settings a cell cannot run under are a wiring fault found before the
    // neutral start, prepare or a bench folder.
    const prepares: string[] = [];
    const { deps, launches } = attemptDeps(fakeController().controller, {
      benchRoot,
    });
    await expect(
      runAttempt(
        deps,
        {
          ...CELL,
          settings: { ...CELL.settings, provider: "nope" as never },
        },
        testTask({
          suite: "long",
          prepare: async () => {
            prepares.push("prepare");
            return {};
          },
        }),
        1,
        caps,
      ),
    ).rejects.toThrow();
    expect(launches).toEqual([]);
    expect(prepares).toEqual([]);
    expect(readdirSync(benchRoot)).toEqual([]);
  });

  it("does not grade a run a stop from the terminal cut short, and a resume runs it again", async () => {
    const state = createHarnessState();
    const { controller, calls } = fakeController();
    const { deps } = attemptDeps(controller, {
      state,
      clients: {
        [CELL.cell]: {
          // SIGTERM (or Ctrl-C over ssh, no touch on this Mac) lands while
          // the model is thinking, as the CLI's interrupt handler does it.
          next: async (o: Observation): Promise<ProviderResult> => {
            state.stopped = true;
            state.runner?.stop("Cycle interrupted.");
            return {
              usage,
              action: { type: "key", key: "TAB", frame_id: o.frame.id },
            };
          },
        },
      },
    });
    const result = await runAttempt(deps, CELL, testTask(), 1, caps);
    expect(result).toMatchObject({
      status: "unknown",
      reason: "SKIPPED",
      runStatus: "cancelled",
      endingCode: "INTERRUPTED",
      claimed: false,
      honestFailure: false,
    });
    // Not the model's result: outside every success rate.
    expect(ran(result)).toBe(false);
    // Nothing is read back: the person asked for everything to stop.
    expect(calls.slice(calls.lastIndexOf("stop"))).not.toContain("resume");
    // A resume runs it again, and the paid row stays for the caps.
    expect(rerunnable(result)).toBe(true);
    const plan: PlanEntry[] = [
      { index: 0, cell: CELL.cell, taskId: "test-open", attempt: 1 },
    ];
    const line = (r: AttemptResult): LedgerLine => ({
      kind: "attempt",
      at: "t",
      ...r,
      planIndex: 0,
      cost: 0.3,
    });
    expect(remaining(plan, [line(result)], 0)).toEqual([
      { ...plan[0], requeued: 0 },
    ]);
    const rows = ledgerResults([
      line(result),
      line({ ...result, reason: undefined, status: "passed" }),
    ]);
    expect(rows).toHaveLength(2);
    expect(spent(rows).total).toBeCloseTo(0.6);
  });

  it("refuses prepare writes outside the bench folder", () => {
    expect(safeRelative("list.txt")).toBe(true);
    expect(safeRelative("a/b.txt")).toBe(true);
    for (const bad of [
      "",
      "/etc/x",
      "../x",
      "a/../../x",
      ".hidden",
      "a/.git/x",
    ])
      expect(safeRelative(bad), bad).toBe(false);
    expect(needsBenchDir(testTask())).toBe(false);
    expect(needsBenchDir(testTask({ suite: "long" }))).toBe(true);
    expect(needsBenchDir(testTask({ suite: "market" }))).toBe(true);
  });

  it("stops the active run from the manual-input callback, never a takeover", () => {
    const state = createHarnessState();
    const stop = vi.fn();
    const manualTakeover = vi.fn();
    state.runner = { stop, manualTakeover } as never;
    onManualInput(state)();
    expect(stop).toHaveBeenCalledWith("Manual input during benchmark.");
    expect(manualTakeover).not.toHaveBeenCalled();
    expect(state.manualInput).toBe(true);
    expect(state.stopped).toBe(false);
    onEmergencyStop(state)();
    expect(state.stopped).toBe(true);
    expect(state.emergency).toBe(true);
  });

  it("tells a restarted tap clock from one installed during the attempt", () => {
    expect(
      unseenManualInput({ tapIdleSeconds: 400 }, { tapIdleSeconds: 430 }, 30),
    ).toBe(false);
    expect(
      unseenManualInput({ tapIdleSeconds: 400 }, { tapIdleSeconds: 5 }, 30),
    ).toBe(true);
    // Before the tap existed nothing was recordable: no conclusion.
    expect(
      unseenManualInput({ tapIdleSeconds: null }, { tapIdleSeconds: 5 }, 30),
    ).toBe(false);
    expect(unseenManualInput(undefined, { tapIdleSeconds: 5 }, 30)).toBe(false);
  });
});

/* ------------------------------------------------------------- presence */

const IOREG_HID = `    | |   {
    | |     "HIDIdleTime" = 24032793708
    | |     "HIDParameters" = {}`;
const PMSET = `Assertion status system-wide:
   PreventUserIdleDisplaySleep    1
Listed by owning process:
   pid 3044(caffeinate): [0x0000003f000583ad] 34:56:50 PreventUserIdleDisplaySleep named: "caffeinate command-line tool"
	Details: caffeinate asserting forever
   pid 387(coreaudiod): [0x0001a35a0001959c] 00:00:35 PreventUserIdleSystemSleep named: "com.apple.audio.context"
   pid 555(Google Chrome): [0x0001a35a0001959d] 00:01:00 NoDisplaySleepAssertion named: "Video Wake Lock"
   pid 5120(Google Chrome Helper (GPU)): [0x0001a35a0001959e] 00:10:00 PreventUserIdleDisplaySleep named: "WebRTC has active PeerConnections"
   pid 313(powerd): [0x0001a25300108593] 00:01:02 InternalPreventDisplaySleep named: "com.apple.powermanagement.delayDisplayOff"`;
const PS = `  101 /Users/someone/Downloads/Visual Studio Code.app/Contents/MacOS/Electron
  102 /Users/someone/open-assist/release/mac-arm64/Open Assist.app/Contents/MacOS/Open Assist --natural-voice
  103 /Users/someone/open-assist/release/mac-arm64/Open Assist.app/Contents/Frameworks/Open Assist Helper.app/Contents/MacOS/Open Assist Helper --type=gpu-process
  104 /usr/bin/open -n -g -W /Users/someone/open-assist/release/mac-arm64/Open Assist.app
  105 /Users/someone/open-assist/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .
  106 /Users/someone/other/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .
  107 /Applications/Slack.app/Contents/MacOS/Slack`;

const report = (over: Partial<GateReport> = {}): GateReport => ({
  hidIdleSeconds: 999,
  tapIdleSeconds: 999,
  locked: false,
  displayAsleep: false,
  displayHeldAwake: true,
  displayHolders: 0,
  appProcesses: 0,
  harnessProcesses: 0,
  unsettledAppRuns: 0,
  unreadable: false,
  secureInput: false,
  source: "helper",
  ...over,
});

describe("presence parsers over captured command output", () => {
  it("reads HID idle, the console lock and the screensaver", () => {
    expect(parseHidIdle(IOREG_HID)).toBeCloseTo(24.03, 2);
    expect(parseHidIdle("nothing")).toBeUndefined();
    const unlocked = {
      IOConsoleLocked: false,
      IOConsoleUsers: [
        { kCGSSessionOnConsoleKey: true, kCGSessionLoginDoneKey: true },
      ],
    };
    expect(parseConsoleLocked(unlocked)).toBe(false);
    expect(
      parseConsoleLocked({
        IOConsoleUsers: [
          { kCGSSessionOnConsoleKey: true, CGSSessionScreenIsLocked: true },
        ],
      }),
    ).toBe(true);
    expect(parseConsoleLocked({ ...unlocked, IOConsoleLocked: true })).toBe(
      true,
    );
    // Fast user switching: nobody on the console.
    expect(
      parseConsoleLocked({
        IOConsoleUsers: [{ kCGSSessionOnConsoleKey: false }],
      }),
    ).toBe(true);
    // Unreadable is the refusal side.
    expect(parseConsoleLocked(undefined)).toBe(true);
    expect(parseScreensaverIdle("1200\n")).toBe(1200);
    expect(parseScreensaverIdle("0")).toBe(0);
    expect(
      parseScreensaverIdle("The domain/default pair does not exist"),
    ).toBeUndefined();
  });
  it("counts display holders other than our own caffeinate and the ones allowed", () => {
    expect(parseAssertions(PMSET).map((h) => h.pid)).toEqual([3044, 555, 5120]);
    expect(
      parseAssertions(PMSET, { ownPids: [3044] }).map((h) => h.name),
    ).toEqual(["Google Chrome", "Google Chrome Helper (GPU)"]);
    expect(
      parseAssertions(PMSET, { allowedNames: ["caffeinate"] }).map(
        (h) => h.pid,
      ),
    ).toEqual([555, 5120]);
    // Allowed by the pid the start saw: another caffeinate that appears
    // later (a second harness's) is not vouched for.
    const later = `${PMSET}\n   pid 4000(caffeinate): [0x0000003f000583ae] 00:00:05 PreventUserIdleDisplaySleep named: "caffeinate command-line tool"`;
    expect(
      parseAssertions(later, { allowedPids: [3044] }).map((h) => h.pid),
    ).toEqual([555, 5120, 4000]);
  });
  it("recognises the packaged app and a development app from this repository only", () => {
    expect(appProcesses(PS, ["/Users/someone/open-assist"])).toEqual([
      102, 105,
    ]);
    // The worktree's own path matches nothing; the main checkout's does.
    expect(
      appProcesses(PS, ["/Users/someone/open-assist/.claude/worktrees/x"]),
    ).toEqual([102]);
    expect(appProcesses(PS, ["/Users/someone/open-assist"], 102)).toEqual([
      105,
    ]);
  });
  // PS above is a build from before the rename (Open Assist.app): it may still
  // be running while Butler.app is built, and it is the same agent either way.
  it("recognises the packaged app under its new name as well as its old one", () => {
    const renamed = `  201 /Users/someone/open-assist/release/mac-arm64/Butler.app/Contents/MacOS/Butler --natural-voice
  202 /Users/someone/open-assist/release/mac-arm64/Butler.app/Contents/Frameworks/Butler Helper.app/Contents/MacOS/Butler Helper --type=gpu-process
  203 /usr/bin/open -n -g -W /Users/someone/open-assist/release/mac-arm64/Butler.app
  204 /Applications/Butler.app/Contents/MacOS/Butler
  205 /Applications/VISA.app/Contents/MacOS/VISA
  206 /Applications/Open Assist.app/Contents/MacOS/Open Assist
  207 /Applications/Butler.app/Contents/MacOS/Open Assist`;
    expect(appProcesses(renamed, [])).toEqual([201, 204, 206]);
    expect(appProcesses(`${PS}\n${renamed}`, [], 201)).toEqual([102, 204, 206]);
  });
  it("counts app runs still in flight in the app's log", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const other = "22222222-2222-4222-8222-222222222222";
    const log = [
      { event: "RunState", data: { runId: id, status: "executing" } },
      { event: "RunState", data: { runId: other, status: "executing" } },
      { event: "RunState", data: { runId: other, status: "completed" } },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n");
    expect(unsettledRuns(log)).toBe(1);
  });
});

describe("the presence gate", () => {
  const caps = {
    now: 1_000_000,
    deadline: 1_000_000 + 3600_000,
    taskSeconds: 60,
    cooldownSeconds: 8,
  };
  it("requires the full --idle without a tap, on HID idle", () => {
    const state = { idleSeconds: 300 };
    expect(
      gateDecision(
        report({ tapIdleSeconds: null, hidIdleSeconds: 200 }),
        state,
        caps,
      ),
    ).toMatchObject({
      ok: false,
      reason: "HID_ACTIVE",
      idle: { required: 300 },
    });
    expect(
      gateDecision(
        report({ tapIdleSeconds: null, hidIdleSeconds: 301 }),
        state,
        caps,
      ).ok,
    ).toBe(true);
  });
  it("between attempts asks only for no input since the agent's last step", () => {
    const state = { idleSeconds: 300, lastAgentInputAt: caps.now - 20_000 };
    expect(idleRequired(state, caps.now)).toBe(17);
    // The tap ignores the agent's own marked input, so its clock only
    // restarts for a person.
    expect(gateDecision(report({ tapIdleSeconds: 40 }), state, caps).ok).toBe(
      true,
    );
    expect(
      gateDecision(report({ tapIdleSeconds: 10 }), state, caps),
    ).toMatchObject({
      ok: false,
      reason: "HID_ACTIVE",
    });
    // After a person was seen, the full --idle again.
    expect(
      idleRequired({ ...state, humanSeenAt: caps.now - 1000 }, caps.now),
    ).toBe(300);
  });
  it("waits on lock, dark display, a watched screen, the app and its runs", () => {
    const state = { idleSeconds: 300 };
    const reason = (over: Partial<GateReport>, allowAppRunning = false) =>
      gateDecision(report(over), state, { ...caps, allowAppRunning }).reason;
    expect(reason({ locked: true })).toBe("LOCKED");
    expect(reason({ displayAsleep: true })).toBe("DISPLAY_OFF");
    expect(reason({ displayHolders: 1 })).toBe("DISPLAY_HELD_BY_OTHER");
    expect(reason({ appProcesses: 1 })).toBe("APP_RUNNING");
    expect(reason({ appProcesses: 1 }, true)).toBeUndefined();
    expect(reason({ unsettledAppRuns: 1, appProcesses: 1 }, true)).toBe(
      "APP_RUN_ACTIVE",
    );
    // Our own caffeinate sets displayHeldAwake; it is not a refusal.
    expect(reason({ displayHeldAwake: true })).toBeUndefined();
  });
  it("stops, rather than waits, when the attempt would outlast the time box", () => {
    const decision = gateDecision(
      report(),
      { idleSeconds: 300 },
      {
        ...caps,
        deadline: caps.now + 60_000,
      },
    );
    expect(decision).toMatchObject({
      ok: false,
      reason: "TIME_BOX",
      stop: true,
    });
  });
  it("reads the helper first and falls back to the system without a tap", async () => {
    const exec = async (command: string, args: string[]) => {
      if (command === "pmset") return PMSET;
      if (command === "ps") return PS;
      if (command === "ioreg") return IOREG_HID;
      if (command === "sh")
        return JSON.stringify({
          IOConsoleUsers: [{ kCGSSessionOnConsoleKey: true }],
        });
      if (command === "defaults") return "0";
      return args.length ? "" : "";
    };
    const base: PresenceSource = {
      exec,
      ownPids: () => [3044],
      roots: ["/Users/someone/open-assist"],
      pid: 1,
      appDiagnostics: () => undefined,
    };
    const helper = await readGate({
      ...base,
      presence: async () => ({
        hidIdleSeconds: 5,
        tapIdleSeconds: 400,
        locked: false,
        displayAsleep: false,
        displayHeldAwake: true,
      }),
    });
    expect(helper).toMatchObject({
      source: "helper",
      tapIdleSeconds: 400,
      displayHolders: 2,
      appProcesses: 2,
      harnessProcesses: 0,
      unsettledAppRuns: 0,
      unreadable: false,
    });
    const fallback = await readGate({
      ...base,
      presence: async () => {
        throw new Error("no method");
      },
    });
    expect(fallback).toMatchObject({
      source: "system",
      tapIdleSeconds: null,
      locked: false,
    });
    expect(fallback.hidIdleSeconds).toBeCloseTo(24.03, 2);
    const system = await readSystem(base);
    expect(system.screensaverIdleSeconds).toBe(0);
    expect(system.screensaverAssumed).toBe(false);
    expect(system.displayHolders.map((h) => h.pid)).toEqual([555, 5120]);
    expect(system.unreadable).toBe(false);
    // Named holders are pinned by the pids the start saw.
    const named = await readSystem({
      ...base,
      ownPids: () => [],
      allowedHolders: ["caffeinate"],
    });
    expect(named.allowedHolders.map((h) => h.pid)).toEqual([3044]);
    expect(named.displayHolders.map((h) => h.pid)).toEqual([555, 5120]);
    // Never set anywhere: the macOS default, which would lock mid-cycle.
    // `defaults read` exits non-zero for a key never set: undefined, not "".
    const unset = await readSystem({
      ...base,
      exec: async (command, args) =>
        command === "defaults" ? undefined : exec(command, args),
    });
    expect(unset.screensaverIdleSeconds).toBe(1200);
    expect(unset.screensaverAssumed).toBe(true);
    expect(
      preflight({
        appPids: [],
        allowAppRunning: false,
        displayHolders: 0,
        screensaverIdleSeconds: unset.screensaverIdleSeconds,
        timeBoxSeconds: 4 * 3600,
        locked: false,
        displayAsleep: false,
      }),
    ).toEqual(["SCREENSAVER_TOO_SOON"]);
  });
});

describe("presence reads that fail, other harnesses and stale app runs", () => {
  const caps = {
    now: 1_000_000,
    deadline: 1_000_000 + 3600_000,
    taskSeconds: 60,
    cooldownSeconds: 8,
  };
  const exec = async (command: string) => {
    if (command === "pmset") return PMSET;
    if (command === "ps") return PS;
    if (command === "ioreg") return IOREG_HID;
    if (command === "sh")
      return JSON.stringify({
        IOConsoleUsers: [{ kCGSSessionOnConsoleKey: true }],
      });
    return "0";
  };
  const base: PresenceSource = {
    exec,
    ownPids: () => [3044],
    roots: ["/Users/nobody"],
    pid: 1,
    appDiagnostics: () => undefined,
    presence: async () => ({
      hidIdleSeconds: 999,
      tapIdleSeconds: 999,
      locked: false,
      displayAsleep: false,
      displayHeldAwake: true,
    }),
  };
  it("waits when ps or pmset cannot be read, instead of reading an empty desktop", async () => {
    for (const broken of ["ps", "pmset"]) {
      const source: PresenceSource = {
        ...base,
        // A timeout under load: the app may be running all the same.
        exec: async (command) =>
          command === broken ? undefined : exec(command),
      };
      const gate = await readGate(source);
      expect(gate.unreadable, broken).toBe(true);
      expect(gateDecision(gate, { idleSeconds: 300 }, caps)).toMatchObject({
        ok: false,
        reason: "PRESENCE_UNKNOWN",
      });
      const system = await readSystem(source);
      expect(system.unreadable, broken).toBe(true);
      expect(
        preflight({
          appPids: [],
          allowAppRunning: false,
          unreadable: system.unreadable,
          displayHolders: 0,
          screensaverIdleSeconds: 0,
          timeBoxSeconds: 3600,
          locked: false,
          displayAsleep: false,
        }),
      ).toEqual(["PRESENCE_UNKNOWN"]);
    }
    expect((await readGate(base)).unreadable).toBe(false);
  });
  it("finds another cycle or bench from any checkout, but not a dry run or a wrapper", () => {
    const ps = [
      "  201 node scripts/harness-cycle.mjs --matrix openai --i-know-this-drives-my-mac",
      "  202 /usr/local/bin/node /Users/x/open-assist/.claude/worktrees/laneY/scripts/bench.mjs --tasks calculator --i-know-this-drives-my-mac",
      "  203 node scripts/harness-cycle.mjs --dry-run",
      "  204 node scripts/bench.mjs --preflight",
      "  205 /bin/sh -c node scripts/harness-cycle.mjs --i-know-this-drives-my-mac",
      "  206 npm run cycle -- --i-know-this-drives-my-mac",
      "  207 node /Users/x/open-assist/scripts/live-task.mjs",
      "  208 node scripts/harness-cycle.mjs --i-know-this-drives-my-mac",
    ].join("\n");
    expect(harnessProcesses(ps, 208)).toEqual([201, 202]);
    expect(
      gateDecision(report({ harnessProcesses: 1 }), { idleSeconds: 300 }, caps),
    ).toMatchObject({ ok: false, reason: "HARNESS_RUNNING" });
    expect(
      preflight({
        appPids: [],
        allowAppRunning: false,
        harnessPids: [201],
        displayHolders: 0,
        screensaverIdleSeconds: 0,
        timeBoxSeconds: 3600,
        locked: false,
        displayAsleep: false,
      }),
    ).toEqual(["HARNESS_RUNNING"]);
  });
  it("treats an unsettled run in the log as in flight only while the app runs", () => {
    // A crash or a force-quit leaves a run that never settles.
    const stale = report({ unsettledAppRuns: 1, appProcesses: 0 });
    expect(gateDecision(stale, { idleSeconds: 300 }, caps).ok).toBe(true);
    expect(
      gateDecision(
        report({ unsettledAppRuns: 1, appProcesses: 1 }),
        { idleSeconds: 300 },
        { ...caps, allowAppRunning: true },
      ),
    ).toMatchObject({ ok: false, reason: "APP_RUN_ACTIVE" });
    const clear: PreflightInput = {
      appPids: [],
      allowAppRunning: true,
      displayHolders: 0,
      screensaverIdleSeconds: 0,
      timeBoxSeconds: 3600,
      locked: false,
      displayAsleep: false,
      unsettledAppRuns: 1,
    };
    expect(preflight(clear)).toEqual([]);
    expect(preflight({ ...clear, appPids: [102] })).toEqual(["APP_RUN_ACTIVE"]);
  });
});

describe("the desktop lock", () => {
  const owner = (pid: number) => ({
    pid,
    script: "harness-cycle",
    cycle: `c${pid}`,
    startedAt: "2026-09-18T01:00:00.000Z",
  });
  it("lets one harness in, whatever checkout the next one runs from", () => {
    const file = join(mkdtempSync(join(scratch, "lock-")), "a", "desktop.lock");
    expect(acquireDesktopLock(file, owner(101), () => true)).toEqual({
      ok: true,
    });
    // The second one is refused and told who holds the desktop.
    expect(acquireDesktopLock(file, owner(102), () => true)).toEqual({
      ok: false,
      holder: owner(101),
    });
    // Only the holder gives it up.
    releaseDesktopLock(file, 102);
    expect(existsSync(file)).toBe(true);
    releaseDesktopLock(file, 101);
    expect(existsSync(file)).toBe(false);
    expect(acquireDesktopLock(file, owner(102), () => true).ok).toBe(true);
    // No temporary file is left behind either way.
    expect(readdirSync(dirname(file))).toEqual(["desktop.lock"]);
  });
  it("takes over a lock whose owner is gone, and leaves an unreadable one alone", () => {
    const dir = mkdtempSync(join(scratch, "lock-"));
    const file = join(dir, "desktop.lock");
    expect(acquireDesktopLock(file, owner(101), () => true).ok).toBe(true);
    // A crash left the lock: its pid is dead.
    expect(acquireDesktopLock(file, owner(102), () => false)).toEqual({
      ok: true,
    });
    expect(JSON.parse(readFileSync(file, "utf8")).pid).toBe(102);
    writeFileSync(file, "not json");
    expect(acquireDesktopLock(file, owner(103), () => false)).toEqual({
      ok: false,
    });
    expect(readFileSync(file, "utf8")).toBe("not json");
    expect(desktopLockPath("/Users/someone")).toBe(
      "/Users/someone/Library/Caches/open-assist/desktop.lock",
    );
  });
});

describe("preflight refusals", () => {
  const clear: PreflightInput = {
    appPids: [],
    allowAppRunning: false,
    displayHolders: 0,
    screensaverIdleSeconds: 0,
    timeBoxSeconds: 4 * 3600,
    locked: false,
    displayAsleep: false,
  };
  it("is clear on a Mac ready for the night", () => {
    expect(preflight(clear)).toEqual([]);
  });
  it("names each condition that would make the night unsafe or pointless", () => {
    expect(preflight({ ...clear, appPids: [102] })).toEqual(["APP_RUNNING"]);
    expect(
      preflight({ ...clear, appPids: [102], allowAppRunning: true }),
    ).toEqual([]);
    expect(preflight({ ...clear, screensaverIdleSeconds: 1200 })).toEqual([
      "SCREENSAVER_TOO_SOON",
    ]);
    expect(preflight({ ...clear, screensaverIdleSeconds: 5 * 3600 })).toEqual(
      [],
    );
    expect(preflight({ ...clear, locked: true })).toEqual(["LOCKED"]);
    expect(preflight({ ...clear, displayHolders: 1 })).toEqual([
      "DISPLAY_HELD_BY_OTHER",
    ]);
    expect(
      preflight({
        ...clear,
        appPids: [102],
        allowAppRunning: true,
        unsettledAppRuns: 2,
      }),
    ).toEqual(["APP_RUN_ACTIVE"]);
  });
});

/* ------------------------------------------------------------------ plan */

describe("plan and interleaving", () => {
  const tasks = ["a", "b", "c", "d"];
  it("runs every (model, task, repeat) once and never one model twice in a row", () => {
    for (const models of [
      ["m1", "m2"],
      ["m1", "m2", "m3"],
    ]) {
      const plan = buildPlan(models, tasks, 3, 42);
      expect(plan).toHaveLength(models.length * tasks.length * 3);
      const keys = new Set(
        plan.map((e) => `${e.cell}|${e.taskId}|${e.attempt}`),
      );
      expect(keys.size).toBe(plan.length);
      for (let i = 1; i < plan.length; i++)
        expect(plan[i].cell, `at ${i}`).not.toBe(plan[i - 1].cell);
      // Every task meets every model back to back.
      for (let i = 0; i < plan.length; i += models.length)
        expect(
          new Set(plan.slice(i, i + models.length).map((e) => e.taskId)).size,
        ).toBe(1);
      expect(plan.map((e) => e.index)).toEqual(plan.map((_, i) => i));
    }
  });
  it("rotates the model that goes first with three or more models", () => {
    const plan = buildPlan(["m1", "m2", "m3"], tasks, 1, 7);
    const firsts = [0, 3, 6, 9].map((i) => plan[i].cell);
    expect(new Set(firsts).size).toBe(3);
  });
  it("is reproducible from its seed and shuffles tasks per round", () => {
    expect(buildPlan(["m"], tasks, 2, 1)).toEqual(
      buildPlan(["m"], tasks, 2, 1),
    );
    const orders = new Set(
      [1, 2, 3, 4, 5, 6].map((seed) =>
        buildPlan(["m"], tasks, 1, seed)
          .map((e) => e.taskId)
          .join(""),
      ),
    );
    expect(orders.size).toBeGreaterThan(1);
  });
  it("partitions a plan into shards that keep their plan indexes", () => {
    const plan = buildPlan(["m1", "m2"], tasks, 3, 3);
    const shards = [1, 2, 3].map((index) => shardOf(plan, { index, count: 3 }));
    expect(
      shards
        .flat()
        .map((e) => e.index)
        .sort((a, b) => a - b),
    ).toEqual(plan.map((e) => e.index));
    expect(parseShard("2/3")).toEqual({ index: 2, count: 3 });
    for (const bad of ["0/3", "4/3", "x", "1/0"])
      expect(parseShard(bad)).toBe("invalid");
    expect(
      planHash({
        matrix: ["m"],
        taskIds: tasks,
        repeat: 1,
        seed: 1,
        shard: "1/2",
      }),
    ).not.toBe(planHash({ matrix: ["m"], taskIds: tasks, repeat: 1, seed: 1 }));
  });
  it("keeps every model of a task and repeat in the same shard", () => {
    const six = ["a", "b", "c", "d", "e", "f"];
    for (const models of [
      ["m1", "m2"],
      ["m1", "m2", "m3"],
    ]) {
      const plan = buildPlan(models, six, 3, 11);
      for (const count of [2, 3]) {
        const shards = Array.from({ length: count }, (_, i) =>
          shardOf(plan, { index: i + 1, count }),
        );
        for (const shard of shards) {
          expect(shard.length).toBeGreaterThan(0);
          // Every (task, repeat) a night holds, it holds on every model, so
          // the within-cycle model comparison keeps its pairs.
          const groups = new Map<string, Set<string>>();
          for (const entry of shard) {
            const key = `${entry.taskId}|${entry.attempt}`;
            groups.set(key, (groups.get(key) ?? new Set()).add(entry.cell));
          }
          for (const [key, seen] of groups)
            expect(seen.size, `${models.length} models, ${key}`).toBe(
              models.length,
            );
          // Every model runs on every night.
          expect(new Set(shard.map((e) => e.cell)).size).toBe(models.length);
        }
        expect(
          shards
            .flat()
            .map((e) => e.index)
            .sort((a, b) => a - b),
        ).toEqual(plan.map((e) => e.index));
      }
    }
  });
  it("pairs plans of one design whatever their seed, unless a shard picked the tasks", () => {
    const design = {
      matrix: ["m1", "m2"],
      taskIds: ["a", "b"],
      repeat: 3,
      seed: 1,
    };
    // A plan's seed only orders it: the same (cell, task, repeat) keys run.
    expect(designHash({ ...design, seed: 2 })).toBe(designHash(design));
    expect(
      designHash({ ...design, matrix: ["m2", "m1"], taskIds: ["b", "a"] }),
    ).toBe(designHash(design));
    expect(planHash({ ...design, seed: 2 })).not.toBe(planHash(design));
    expect(designHash({ ...design, repeat: 2 })).not.toBe(designHash(design));
    // A shard's seed decides which tasks it holds.
    expect(designHash({ ...design, shard: "1/2", seed: 2 })).not.toBe(
      designHash({ ...design, shard: "1/2" }),
    );
  });
  it("prices every cell at its own model's rates, and none it cannot price", () => {
    const providerDefaults = {
      anthropic: {
        model: "claude-sonnet-5",
        inputPrice: 2,
        outputPrice: 10,
      },
      openai: { model: "gpt-5.4-mini", inputPrice: 0.75, outputPrice: 4.5 },
    };
    const fable = {
      provider: "anthropic" as const,
      model: "claude-fable-5-1",
    };
    const sonnet = { provider: "anthropic" as const, model: "claude-sonnet-5" };
    // A catalog without per-model rates prices its default model only: a
    // Fable cell charged at Sonnet's rates would spend five times each cap.
    expect(cellPrices(sonnet, { providerDefaults })).toEqual({
      inputPrice: 2,
      outputPrice: 10,
    });
    expect(cellPrices(fable, { providerDefaults })).toBeUndefined();
    const perModel = {
      providerDefaults,
      modelPrice: (_provider: string, model: string) =>
        (
          ({
            "claude-fable-5-1": { inputPrice: 10, outputPrice: 50 },
            "gpt-free": { inputPrice: 0, outputPrice: 0 },
          }) as Record<string, { inputPrice: number; outputPrice: number }>
        )[model],
    };
    expect(cellPrices(fable, perModel)).toEqual({
      inputPrice: 10,
      outputPrice: 50,
    });
    // Zero rates would disable the runner's cost budget altogether.
    expect(
      cellPrices({ provider: "openai", model: "gpt-free" }, perModel),
    ).toBeUndefined();
    // The settings a cell runs under carry those rates, not the default's.
    const selected = {
      ...structuredClone(defaultSettings),
      provider: "anthropic" as const,
      model: "claude-sonnet-5",
      inputPrice: 2,
      outputPrice: 10,
    };
    const settings = cellSettings(
      selected,
      fable,
      cellPrices(fable, perModel)!,
    );
    expect(settings).toMatchObject({
      provider: "anthropic",
      model: "claude-fable-5-1",
      inputPrice: 10,
      outputPrice: 50,
    });
  });
  it("carries --autonomy into a cell's settings, acknowledged for all as the Settings pane does", () => {
    expect(AUTONOMY_MODES).toEqual(["ask", "task", "flow", "all"]);
    // The bare command measures what every cycle before the flag did.
    expect(DEFAULT_AUTONOMY).toBe(defaultSettings.autonomy);
    expect(parseAutonomy("flow")).toBe("flow");
    expect(parseAutonomy("everything")).toBeUndefined();
    expect(parseAutonomy(undefined)).toBeUndefined();
    // The same two fields the pane sets when the owner ticks the
    // acknowledgement; every other mode drops it, as the pane does.
    for (const mode of AUTONOMY_MODES)
      expect(autonomySettings(mode)).toEqual(autonomyChange(mode, true));
    expect(autonomySettings("all")).toEqual({
      autonomy: "all",
      autonomyAllAcknowledged: true,
    });
    expect(autonomySettings("task")).toEqual({
      autonomy: "task",
      autonomyAllAcknowledged: false,
    });
    // Through cellSettings and the schema, as the script builds a cell.
    const fable = { provider: "anthropic" as const, model: "claude-fable-5-1" };
    const settings = settingsSchema.parse(
      cellSettings(
        {
          ...structuredClone(defaultSettings),
          memory: false,
          ...autonomySettings("all"),
        },
        fable,
        { inputPrice: 10, outputPrice: 50 },
      ),
    );
    expect(settings).toMatchObject({
      model: "claude-fable-5-1",
      autonomy: "all",
      autonomyAllAcknowledged: true,
    });
    // What the policy makes of the pair: a fixture Checkout's question is
    // answered without asking under "all", asked (and so declined by the
    // harness) under "flow" and under an "all" nobody acknowledged.
    const order = { kind: "CONFIRM" as const, reason: "Place this order?" };
    const under = (mode: (typeof AUTONOMY_MODES)[number]) =>
      settingsSchema.parse({ ...defaultSettings, ...autonomySettings(mode) });
    expect(withoutAsking(order, under("all")).kind).toBe("ALLOW");
    expect(withoutAsking(order, under("flow")).kind).toBe("CONFIRM");
    expect(withoutAsking(order, under("task")).kind).toBe("CONFIRM");
    expect(
      withoutAsking(
        order,
        settingsSchema.parse({ ...defaultSettings, autonomy: "all" }),
      ).kind,
    ).toBe("CONFIRM");
    // A cycle from before the flag recorded no regime and ran the default.
    expect(autonomyOf(undefined)).toBe("task");
    expect(autonomyOf({})).toBe("task");
    expect(autonomyOf({ autonomy: "all" })).toBe("all");
    expect(autonomyOf({ autonomy: "everything" })).toBe("task");
  });
  it("parses the matrix, durations and a probe's scope", () => {
    const defaults = {
      openai: "gpt-5.4-mini",
      google: "gemini-3.5-flash-lite",
    };
    expect(parseMatrix("openai,google:gemini-x,openai", defaults)).toEqual({
      cells: [
        {
          provider: "openai",
          model: "gpt-5.4-mini",
          cell: "openai:gpt-5.4-mini",
        },
        { provider: "google", model: "gemini-x", cell: "google:gemini-x" },
      ],
      unknown: [],
    });
    expect(parseMatrix("ollama,nope:x", defaults).unknown).toEqual([
      "ollama",
      "nope:x",
    ]);
    expect(parseDuration("4h")).toBe(14400);
    expect(parseDuration("90m")).toBe(5400);
    expect(parseDuration("300")).toBe(300);
    expect(parseDuration("soon")).toBeUndefined();
    expect(
      probeScope(
        [
          {
            code: "SCREEN_CHANGED",
            byModel: { a: { attempts: 2 }, b: { attempts: 0 } },
            byCategory: { browser: { attempts: 2 } },
          },
        ],
        "SCREEN_CHANGED",
      ),
    ).toEqual({ cells: ["a"], categories: ["browser"] });
    expect(defaultCycleId(new Date(2026, 8, 18, 3, 7), "5b453c7abc")).toBe(
      "20260918-0307-5b453c7",
    );
  });
});

describe("caps and time", () => {
  it("skips a starved attempt instead of running it into COST_BUDGET", () => {
    const base = {
      taskMaxCost: 0.3,
      runCap: 0.5,
      cycleRemaining: 10,
      modelRemaining: 10,
    };
    expect(attemptCap(base)).toEqual({ maxCost: 0.3 });
    expect(attemptCap({ ...base, runCap: 0.2 })).toEqual({ maxCost: 0.2 });
    expect(attemptCap({ ...base, modelRemaining: 0.2 })).toEqual({
      maxCost: 0.2,
    });
    expect(attemptCap({ ...base, modelRemaining: 0.1 })).toEqual({
      skip: "BUDGET_EXHAUSTED",
    });
    expect(attemptCap({ ...base, cycleRemaining: 0.14 })).toEqual({
      skip: "BUDGET_EXHAUSTED",
    });
  });
  it("sums ceilings per cell and estimates the night", () => {
    const tasks = new Map([
      ["a", { maxCost: 0.3, maxSeconds: 300, maxActions: 30 }],
      ["b", { maxCost: 0.05, maxSeconds: 90, maxActions: 8 }],
    ]);
    const plan = buildPlan(["m1", "m2"], ["a", "b"], 2, 1);
    const roof = ceiling(plan, tasks, 0.2);
    expect(roof.total).toBeCloseTo(2 * 2 * (0.2 + 0.05));
    expect(roof.byCell.m1).toBeCloseTo(0.5);
    // 3 s a step without a baseline, twice the median with one.
    expect(estimateSeconds(plan, tasks, 8)).toBe(4 * (90 + 28) + 4 * (24 + 28));
    expect(estimateSeconds(plan, tasks, 8, { a: 40 })).toBe(
      4 * (80 + 28) + 4 * (24 + 28),
    );
    expect(fitsTimeBox(800, 1000)).toBe(true);
    expect(fitsTimeBox(801, 1000)).toBe(false);
    expect(
      spent([
        { cell: "m1", cost: 0.1 },
        { cell: "m1", cost: 0.2 },
      ]),
    ).toEqual({
      total: 0.30000000000000004,
      byCell: { m1: 0.30000000000000004 },
    });
  });
});

/* ------------------------------------------------------- results fixtures */

let runSeq = 0;
function row(over: Partial<AttemptResult> = {}): AttemptResult {
  runSeq++;
  const hex = runSeq.toString(16).padStart(12, "0");
  return {
    taskId: "calculator-open",
    category: "calculator",
    difficulty: "easy",
    attempt: 1,
    provider: "openai",
    model: "gpt-5.4-mini",
    cell: "openai:gpt-5.4-mini",
    planIndex: 0,
    requeued: 0,
    startedAt: "2026-09-18T01:00:00.000Z",
    runId: `aaaaaaaa-aaaa-4aaa-8aaa-${hex}`,
    status: "passed",
    checks: { frontmost: true },
    runStatus: "completed",
    endingCode: "COMPLETED",
    claimed: true,
    falseDone: false,
    falseDonePrimary: false,
    honestFailure: false,
    undersold: false,
    unverifiableDone: false,
    actions: 3,
    seconds: 20,
    cost: 0.01,
    inputTokens: 100,
    outputTokens: 10,
    modelCalls: 3,
    approvals: 0,
    approvalsDeclined: 0,
    retries: 0,
    handoffs: { manual: 0, agent: 0 },
    takeovers: 0,
    takeoverSources: sources(),
    manualTakeover: false,
    modelFailed: false,
    loops: 0,
    noProgress: 0,
    failures: {},
    gateWaitSeconds: 0,
    ...over,
  };
}
const failedRow = (over: Partial<AttemptResult> = {}) =>
  row({
    status: "failed",
    reason: "NOT_FRONTMOST",
    checks: { frontmost: false },
    runStatus: "completed",
    falseDone: true,
    ...over,
  });

/* ----------------------------------------------------------- ledger */

describe("ledger and resume", () => {
  const plan: PlanEntry[] = buildPlan(["m1", "m2"], ["a", "b"], 1, 1);
  const attemptLine = (r: AttemptResult): LedgerLine => ({
    kind: "attempt",
    at: "2026-09-18T01:00:00.000Z",
    ...r,
  });
  it("drops a torn last line and resumes where the ledger stops", () => {
    const text =
      [
        { kind: "start", at: "t", cycle: "c", planHash: "h", gitRev: "r" },
        attemptLine(row({ planIndex: 0, cell: plan[0].cell })),
        attemptLine(row({ planIndex: 1, cell: plan[1].cell })),
      ]
        .map((line) => JSON.stringify(line))
        .join("\n") + '\n{"kind":"attempt","planIn';
    const lines = parseLedger(text);
    expect(lines).toHaveLength(3);
    expect(remaining(plan, lines, 1).map((e) => e.index)).toEqual([2, 3]);
  });
  it("re-runs input cut short while the requeue lasts, and never-started rows", () => {
    const lines: LedgerLine[] = [
      attemptLine(
        row({
          planIndex: 0,
          manualTakeover: true,
          status: "unknown",
          reason: "MANUAL_TAKEOVER",
        }),
      ),
      attemptLine(
        row({ planIndex: 1, status: "unknown", reason: "MANUAL_INPUT_UNSEEN" }),
      ),
      attemptLine(
        row({ planIndex: 1, status: "unknown", reason: "MANUAL_INPUT_UNSEEN" }),
      ),
      attemptLine(
        row({
          planIndex: 2,
          runStatus: "skipped",
          status: "unknown",
          reason: "BUDGET_EXHAUSTED",
        }),
      ),
      attemptLine(
        row({
          planIndex: 3,
          runStatus: "skipped",
          status: "unknown",
          reason: "NO_PREPARED_TARGET",
        }),
      ),
    ];
    const left = remaining(plan, lines, 1);
    // 0: cut once, requeued once more; 1: cut twice, out of requeues;
    // 2: never started, runs again; 3: a prepare skip is a result.
    expect(left.map((e) => [e.index, e.requeued])).toEqual([
      [0, 1],
      [2, 0],
    ]);
  });
  it("replaces a never-started row with its later run, and keeps paid cuts", () => {
    const rows = ledgerResults([
      attemptLine(
        row({
          planIndex: 2,
          runStatus: "skipped",
          status: "unknown",
          reason: "BUDGET_EXHAUSTED",
        }),
      ),
      attemptLine(
        row({
          planIndex: 0,
          manualTakeover: true,
          status: "unknown",
          reason: "MANUAL_TAKEOVER",
        }),
      ),
      attemptLine(row({ planIndex: 2 })),
      attemptLine(row({ planIndex: 0 })),
    ]);
    expect(rows.map((r) => [r.planIndex, r.reason ?? "ok"])).toEqual([
      [0, "MANUAL_TAKEOVER"],
      [0, "ok"],
      [2, "ok"],
    ]);
  });
  it("totals gate waits across nights", () => {
    const waits = gateWaitsOf([
      {
        kind: "gate",
        at: "t",
        reason: "HID_ACTIVE",
        reasons: ["LOCKED", "HID_ACTIVE"],
        waitedSeconds: 400,
        userPresentLong: true,
      },
      { kind: "gate", at: "t", reason: "APP_RUNNING", waitedSeconds: 30 },
    ]);
    expect(waits).toEqual({
      count: 2,
      totalSeconds: 430,
      byReason: { LOCKED: 1, HID_ACTIVE: 1, APP_RUNNING: 1 },
      longestSeconds: 400,
      userPresentLong: 1,
    });
  });
});

/* ----------------------------------------------------------- the loop */

function loop(
  over: {
    queue?: QueueEntry[];
    caps?: Partial<CycleCaps>;
    gate?: (now: number, calls: number) => Partial<GateReport>;
    attempt?: (
      entry: QueueEntry,
      maxCost: number,
      now: number,
    ) => Partial<AttemptResult>;
    deadline?: number;
    tasks?: Map<string, { maxCost: number; maxSeconds: number }>;
    skipFor?: (entry: QueueEntry, gateCalls: number) => string | undefined;
    observe?: (row: AttemptResult) => void;
    afterGate?: (pass: { first: boolean; sawInput: boolean }) => Promise<void>;
    remedy?: (report: GateReport) => Promise<number | undefined>;
    escalate?: (report: GateReport) => Promise<boolean | undefined>;
    /** The same hook's LEFTOVER cause, asked at every pass. */
    leftover?: (report: GateReport) => Promise<boolean | undefined>;
  } = {},
) {
  let clock = 1_000_000;
  const lines: LedgerLine[] = [];
  const ran: {
    index: number;
    cell: string;
    maxCost: number;
    wait: number;
    requeued: number;
  }[] = [];
  const state = { stopped: false, emergency: false } as {
    stopped: boolean;
    emergency: boolean;
    lastAgentInputAt?: number;
  };
  let gateCalls = 0;
  const queue =
    over.queue ??
    buildPlan(["m1", "m2"], ["a", "b"], 1, 1).map((e) => ({
      ...e,
      requeued: 0,
    }));
  const run = runCycleLoop({
    queue,
    tasks:
      over.tasks ??
      new Map([
        ["a", { maxCost: 0.1, maxSeconds: 60 }],
        ["b", { maxCost: 0.1, maxSeconds: 60 }],
      ]),
    caps: {
      cycle: 100,
      run: 0.5,
      model: 100,
      cooldownSeconds: 8,
      idleSeconds: 300,
      gatePollSeconds: 15,
      requeue: 1,
      stopOnHandoff: false,
      allowAppRunning: false,
      ...over.caps,
    },
    deadline: over.deadline ?? clock + 24 * 3600_000,
    state,
    readGate: async () => report(over.gate?.(clock, gateCalls++) ?? {}),
    attempt: async (entry, maxCost, wait) => {
      ran.push({
        index: entry.index,
        cell: entry.cell,
        maxCost,
        wait,
        requeued: entry.requeued,
      });
      clock += 30_000;
      const extra = over.attempt?.(entry, maxCost, clock) ?? {};
      // The agent's last step lands a second before the attempt ends.
      state.lastAgentInputAt = clock - 1000;
      return row({
        planIndex: entry.index,
        cell: entry.cell,
        taskId: entry.taskId,
        attempt: entry.attempt,
        requeued: entry.requeued,
        ...extra,
      });
    },
    skipped: (entry, reason) =>
      row({
        planIndex: entry.index,
        cell: entry.cell,
        taskId: entry.taskId,
        status: "unknown",
        reason,
        runStatus: "skipped",
        cost: 0,
      }),
    write: (line) => lines.push(line),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    ...(over.skipFor
      ? { skipFor: (entry: QueueEntry) => over.skipFor!(entry, gateCalls) }
      : {}),
    ...(over.observe ? { observe: over.observe } : {}),
    ...(over.afterGate ? { afterGate: over.afterGate } : {}),
    ...(over.remedy ? { remedy: over.remedy } : {}),
    ...(over.escalate || over.leftover
      ? {
          escalate: (gateReport: GateReport, cause: string) =>
            cause === "LEFTOVER"
              ? (over.leftover?.(gateReport) ?? Promise.resolve(undefined))
              : (over.escalate?.(gateReport) ?? Promise.resolve(undefined)),
        }
      : {}),
  });
  return { run, lines, ran, state, clockAt: () => clock };
}

describe("the cycle loop", () => {
  it("waits for the full --idle before the first attempt, then runs the plan", async () => {
    // The tap was armed at the cycle's start: its clock counts from there.
    const start = 1_000_000;
    const { run, lines, ran } = loop({
      gate: (now) => ({ tapIdleSeconds: (now - start) / 1000 + 10 }),
    });
    const outcome = await run;
    expect(outcome.stoppedBecause).toBeUndefined();
    expect(ran.map((r) => r.index)).toEqual([0, 1, 2, 3]);
    // 290 s of waiting in 15 s polls, then straight through: the agent's
    // own input never restarts the tap's clock.
    expect(ran[0].wait).toBe(300);
    expect(ran.slice(1).every((r) => r.wait === 0)).toBe(true);
    const gates = lines.filter((l) => l.kind === "gate");
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({
      reason: "HID_ACTIVE",
      waitedSeconds: 300,
    });
    expect(outcome.gateWaits.count).toBe(1);
  });

  it("sends an attempt real input cut short back once, and waits the full --idle again", async () => {
    let touchedAt = 0;
    let cuts = 0;
    const { run, ran, lines } = loop({
      gate: (now) => ({ tapIdleSeconds: (now - touchedAt) / 1000 }),
      attempt: (entry, _cost, now) => {
        if (entry.index === 0 && cuts < 2) {
          cuts++;
          touchedAt = now;
          return {
            status: "unknown",
            reason: "MANUAL_TAKEOVER",
            manualTakeover: true,
          };
        }
        return {};
      },
    });
    const outcome = await run;
    expect(ran.map((r) => [r.index, r.requeued])).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
      [0, 1],
    ]);
    // After the cut the next attempt waited the full five minutes.
    expect(ran[1].wait).toBeGreaterThanOrEqual(300);
    expect(lines.filter((l) => l.kind === "requeue")).toHaveLength(1);
    // The requeued one was cut again and is not queued a third time.
    expect(outcome.results.filter((r) => r.manualTakeover)).toHaveLength(2);
    expect(outcome.notRun).toBe(0);
  });

  it("waits the full --idle when a person touched the Mac between attempts", async () => {
    let touchedAt = -Infinity;
    const { run, ran } = loop({
      gate: (now, calls) => {
        if (calls === 1) touchedAt = now - 2000;
        return { tapIdleSeconds: Math.min(999, (now - touchedAt) / 1000) };
      },
    });
    await run;
    expect(ran[0].wait).toBe(0);
    expect(ran[1].wait).toBeGreaterThanOrEqual(298);
  });

  it("ends the whole cycle on Escape", async () => {
    const { run, ran, state } = loop({
      attempt: () => {
        state.emergency = true;
        state.stopped = true;
        return {
          status: "unknown",
          reason: "MANUAL_TAKEOVER",
          manualTakeover: true,
        };
      },
    });
    const outcome = await run;
    expect(outcome.stoppedBecause).toBe("emergency stop");
    expect(ran).toHaveLength(1);
    expect(outcome.notRun).toBe(4);
  });

  it("ends the cycle on Ctrl-C and leaves the attempt it cut short for the resume", async () => {
    const { run, ran, state } = loop({
      attempt: () => {
        state.stopped = true;
        return {
          status: "unknown",
          reason: "SKIPPED",
          runStatus: "cancelled",
          endingCode: "INTERRUPTED",
          cost: 0.02,
        };
      },
    });
    const outcome = await run;
    expect(outcome.stoppedBecause).toBe("interrupted");
    expect(ran).toHaveLength(1);
    // Its paid row is kept, and it still counts among those that did not run.
    expect(outcome.results).toHaveLength(1);
    expect(outcome.notRun).toBe(4);
  });

  it("keeps a model within its own cap while the others carry on", async () => {
    const { run, ran } = loop({
      caps: { model: 0.1 },
      attempt: () => ({ cost: 0.1 }),
    });
    const outcome = await run;
    // One attempt per model, then each model's remaining ones are skips.
    expect(ran.map((r) => r.cell).sort()).toEqual(["m1", "m2"]);
    expect(
      outcome.results.filter((r) => r.reason === "BUDGET_EXHAUSTED").length +
        ran.length +
        outcome.notRun,
    ).toBe(4);
    expect(outcome.stoppedBecause).toBe("cost budget");
  });

  it("stops at the cycle cap and on the time box, leaving the rest for a resume", async () => {
    const capped = loop({
      caps: { cycle: 0.15 },
      attempt: () => ({ cost: 0.1 }),
    });
    const money = await capped.run;
    expect(money.stoppedBecause).toBe("cost budget");
    expect(capped.ran).toHaveLength(1);
    const boxed = loop({ deadline: 1_000_000 + 60_000 });
    const time = await boxed.run;
    expect(time.stoppedBecause).toBe("time box");
    expect(boxed.ran).toHaveLength(0);
    expect(time.notRun).toBe(4);
  });

  it("stops at an agent hand-off only when asked, and keeps rows when an attempt throws", async () => {
    const handoff = loop({
      caps: { stopOnHandoff: true },
      attempt: () => ({ handoffs: { manual: 0, agent: 1 } }),
    });
    expect((await handoff.run).stoppedBecause).toBe("hand-off");
    let n = 0;
    const broken = loop({
      attempt: () => {
        if (++n === 2) throw new Error("helper gone");
        return {};
      },
    });
    const outcome = await broken.run;
    expect(outcome.stoppedBecause).toBe("error");
    expect(outcome.results).toHaveLength(1);
    expect(outcome.notRun).toBe(3);
  });

  it("holds attempts while the app runs, unless the person allowed it", async () => {
    const held = loop({
      gate: () => ({ appProcesses: 1 }),
      deadline: 1_000_000 + 600_000,
    });
    const outcome = await held.run;
    expect(held.ran).toHaveLength(0);
    expect(outcome.gateWaits.byReason.APP_RUNNING).toBe(1);
    expect(outcome.stoppedBecause).toBe("time box");
    const allowed = loop({
      gate: () => ({ appProcesses: 1 }),
      caps: { allowAppRunning: true },
    });
    await allowed.run;
    expect(allowed.ran).toHaveLength(4);
  });
});

/* ------------------------------------------------------------------ stats */

describe("statistics against known values", () => {
  it("Wilson intervals", () => {
    expect(wilson(0, 30)[1]).toBeCloseTo(0.11351, 4);
    expect(wilson(0, 36)[1]).toBeCloseTo(0.09642, 4);
    const [lo, hi] = wilson(5, 10);
    expect(lo).toBeCloseTo(0.23659, 4);
    expect(hi).toBeCloseTo(0.76341, 4);
    expect(wilson(9, 10)[1]).toBeCloseTo(0.98212, 4);
    expect(wilson(0, 0)).toEqual([0, 1]);
  });
  it("pooled two-proportion z", () => {
    const test = twoProportionZ(50, 100, 40, 100);
    expect(test.z).toBeCloseTo(-1.42134, 4);
    expect(test.pDrop).toBeCloseTo(0.07761, 4);
    expect(test.pRise).toBeCloseTo(0.92239, 4);
    expect(twoProportionZ(30, 36, 12, 36).z).toBeCloseTo(-4.3028, 3);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 5);
  });
  it("McNemar exact, including large pooled counts", () => {
    const test = mcnemarExact(10, 2);
    expect(test.pWorse).toBeCloseTo(0.0192871, 6);
    expect(test.pTwoSided).toBeCloseTo(0.0385742, 6);
    expect(test.pBetter).toBeGreaterThan(0.99);
    expect(mcnemarExact(5, 5).pTwoSided).toBe(1);
    expect(mcnemarExact(0, 0).pTwoSided).toBe(1);
    // 2^-2000 underflows; the log-space sum does not.
    expect(binomialTail(2000, 950)).toBeCloseTo(0.0134121, 5);
  });
  it("sample size per arm", () => {
    expect(powerN(0.5, 0.6)).toBe(388);
    expect(powerN(0.1, 0.2)).toBe(199);
  });
});

/* ---------------------------------------------------- compare and report */

function cycleOf(
  over: Partial<ComparableCycle> & { results: AttemptResult[] },
): ComparableCycle {
  return {
    id: "c1",
    gitRev: "abc1234",
    catalogueHash: "h1",
    planHash: "p1",
    designHash: "d1",
    startedAt: "2026-09-17T01:00:00.000Z",
    finishedAt: "2026-09-17T04:00:00.000Z",
    taskIds: ["calculator-open"],
    cells: ["openai:gpt-5.4-mini"],
    ...over,
  };
}
const many = (n: number, make: (i: number) => AttemptResult) =>
  Array.from({ length: n }, (_, i) => make(i));

describe("regressions between cycles", () => {
  const good = many(36, (i) =>
    i < 30
      ? row({ planIndex: i, attempt: i + 1 })
      : failedRow({ planIndex: i, attempt: i + 1 }),
  );
  const bad = many(36, (i) =>
    i < 12
      ? row({ planIndex: i, attempt: i + 1 })
      : failedRow({ planIndex: i, attempt: i + 1 }),
  );
  const classes = classRates;
  it("never compares across a git revision or a catalogue hash", () => {
    const current = cycleOf({ id: "c2", results: bad });
    expect(
      compareCycles(
        current,
        [cycleOf({ gitRev: "other", results: good })],
        classes,
      ),
    ).toMatchObject({
      comparable: false,
      reason: "GIT_REV_DIFFERS",
      regressions: [],
    });
    expect(
      compareCycles(
        current,
        [cycleOf({ catalogueHash: "h2", results: good })],
        classes,
      ),
    ).toMatchObject({ comparable: false, reason: "CATALOGUE_HASH_DIFFERS" });
    expect(
      selectBaseline(current, [
        cycleOf({ id: "x", gitRev: "other", results: good }),
        cycleOf({ id: "y", catalogueHash: "h2", results: good }),
        cycleOf({ id: "z", stoppedBecause: "time box", results: good }),
        cycleOf({ id: "w", finishedAt: undefined, results: good }),
        cycleOf({ id: "ok", results: good }),
      ]).map((c) => c.id),
    ).toEqual(["ok"]);
  });
  it("flags a real drop, pairing same-plan cycles by task and repeat", () => {
    const current = cycleOf({ id: "c2", results: bad });
    const paired = compareCycles(
      current,
      [cycleOf({ results: good })],
      classes,
    );
    const model = paired.regressions.find((r) => r.scope === "model")!;
    expect(model).toMatchObject({ verdict: "regression", paired: true });
    expect(model.before).toMatchObject({ k: 30, n: 36 });
    expect(model.after).toMatchObject({ k: 12, n: 36 });
    const pooled = compareCycles(
      cycleOf({ id: "c2", planHash: "p2", designHash: "d2", results: bad }),
      [cycleOf({ results: good })],
      classes,
    );
    const z = pooled.regressions.find((r) => r.scope === "model")!;
    expect(z.paired).toBe(false);
    expect(z.verdict).toBe("regression");
    expect(z.p).toBeLessThan(0.001);
    // The failing grade reason rose by 50 points: a class regression.
    expect(
      pooled.regressions.find((r) => r.key === "NOT_FRONTMOST")?.verdict,
    ).toBe("regression");
    expect(pooled.sensitivity?.n).toBe(36);
  });
  it("calls small samples inconclusive and small moves unchanged", () => {
    const few = compareCycles(
      cycleOf({
        id: "c2",
        planHash: "p2",
        designHash: "d2",
        results: bad.slice(0, 10),
      }),
      [cycleOf({ results: good.slice(0, 10) })],
      classes,
    );
    expect(few.regressions.find((r) => r.scope === "model")?.verdict).not.toBe(
      "regression",
    );
    const same = compareCycles(
      cycleOf({ id: "c2", planHash: "p2", designHash: "d2", results: good }),
      [cycleOf({ results: good })],
      classes,
    );
    expect(same.regressions.find((r) => r.scope === "model")?.verdict).toBe(
      "unchanged",
    );
  });
  it("flags an environment shift the cycle's own log shows", () => {
    // Tonight the provider timed out in 12 of 36 runs, which then failed;
    // nothing in the rows says so, only the diagnostics log does.
    const failing = many(36, (i) =>
      i < 12
        ? failedRow({
            planIndex: i,
            attempt: i + 1,
            runStatus: "failed",
            claimed: false,
            falseDone: false,
            honestFailure: true,
            reason: "RESULT_NOT_SHOWN",
            endingCode: "RUN_ERROR",
          })
        : row({ planIndex: i, attempt: i + 1 }),
    );
    const log = failing
      .slice(0, 12)
      .flatMap((r) => [
        { event: "ProviderFailed", data: { runId: r.runId, timedOut: true } },
        { event: "RunState", data: { runId: r.runId, status: "failed" } },
      ])
      .map((line) => JSON.stringify(line))
      .join("\n");
    const tonight = buildCycleResults({
      cycle: info({ repeat: 36 }),
      results: failing,
      analysis: analyze(parseDiagnostics(log).lines),
    });
    const current = comparable(
      tonight.cycle,
      tonight.results,
      tonight.failureClasses,
    );
    const calm = buildCycleResults({
      cycle: info({ id: "calm", planHash: "a".repeat(64) }),
      results: many(36, (i) => row({ planIndex: i, attempt: i + 1 })),
    });
    const result = compareCycles(
      current,
      [comparable(calm.cycle, calm.results, calm.failureClasses)],
      classRates,
    );
    expect(result.comparable).toBe(true);
    expect(result.environmentShifts).toEqual([
      { code: "PROVIDER_TIMEOUT", before: 0, after: 12 / 36 },
    ]);
    expect(result.regressions.find((r) => r.scope === "model")?.verdict).toBe(
      "regression",
    );
    expect(renderCycleReport({ ...tonight, comparison: result })).toContain(
      "Environment shift: PROVIDER_TIMEOUT moved from 0% to 33% of attempts",
    );
  });
  it("names new and gone classes", () => {
    const gone = compareCycles(
      cycleOf({
        id: "c2",
        planHash: "p2",
        designHash: "d2",
        results: many(36, (i) => row({ planIndex: i })),
      }),
      [cycleOf({ results: good })],
      classes,
    );
    expect(
      gone.regressions.find((r) => r.key === "NOT_FRONTMOST")?.verdict,
    ).toBe("gone");
    const fresh = compareCycles(
      cycleOf({ id: "c2", planHash: "p2", designHash: "d2", results: bad }),
      [cycleOf({ results: many(36, (i) => row({ planIndex: i })) })],
      classes,
    );
    expect(
      fresh.regressions.find((r) => r.key === "NOT_FRONTMOST")?.verdict,
    ).toBe("new");
  });
  it("pairs cycles of one design whatever their seed, and never compares an uncommitted tree", () => {
    // Two nights with the same flags and default seeds: different plan
    // hashes, the same attempts. They pair.
    const paired = compareCycles(
      cycleOf({ id: "c2", planHash: "p2", results: bad }),
      [cycleOf({ results: good })],
      classes,
    );
    expect(paired.regressions.find((r) => r.scope === "model")?.paired).toBe(
      true,
    );
    // A cycle run from uncommitted changes names a rev it did not run.
    const dirty = cycleOf({ id: "d", dirty: true, results: good });
    expect(
      selectBaseline(cycleOf({ id: "c2", results: bad }), [
        dirty,
        cycleOf({ id: "ok", results: good }),
      ]).map((c) => c.id),
    ).toEqual(["ok"]);
    for (const [current, baseline] of [
      [
        cycleOf({ id: "c2", dirty: true, results: bad }),
        cycleOf({ results: good }),
      ],
      [cycleOf({ id: "c2", results: bad }), dirty],
    ])
      expect(compareCycles(current, [baseline], classes)).toMatchObject({
        comparable: false,
        reason: "DIRTY_TREE",
        regressions: [],
      });
    // The report says how many attempts a 10-point drop needs.
    expect(paired.sensitivity).toMatchObject({
      n: 36,
      baselineRate: 30 / 36,
      neededPerArm: powerN(30 / 36, 30 / 36 - 0.1),
    });
  });
  it("never makes one night of a sharded plan the baseline of another", () => {
    // The long suite on three models, cut over two nights as the cycle
    // does on its own: the same plan, seed and revision, disjoint slices.
    const cells = ["m1", "m2", "m3"];
    const ids = LONG_CATALOGUE.map((task) => task.id);
    const plan = buildPlan(cells, ids, 3, 42);
    const night = (index: number, results: AttemptResult[]) => {
      const shard = `${index}/2`;
      return cycleOf({
        id: `night${index}`,
        startedAt: `2026-09-1${index}T21:00:00.000Z`,
        finishedAt: `2026-09-1${index}T23:59:00.000Z`,
        taskIds: ids,
        cells,
        shard,
        planHash: planHash({
          matrix: cells,
          taskIds: ids,
          repeat: 3,
          seed: 42,
          shard,
        }),
        designHash: designHash({
          matrix: cells,
          taskIds: ids,
          repeat: 3,
          seed: 42,
          shard,
        }),
        results,
      });
    };
    const rows = (index: number, passed: (taskId: string) => boolean) =>
      shardOf(plan, { index, count: 2 }).map((entry) =>
        (passed(entry.taskId) ? row : failedRow)({
          planIndex: entry.index,
          cell: entry.cell,
          taskId: entry.taskId,
          attempt: entry.attempt,
        }),
      );
    // The same code both nights: a task passes or fails whichever night
    // runs it, so any gap between the nights is the mix of tasks they drew.
    const hard = new Set(ids.slice(0, 10));
    const pass = (id: string) => !hard.has(id);
    const one = night(1, rows(1, pass));
    const two = night(2, rows(2, pass));
    expect(one.designHash).not.toBe(two.designHash);
    expect(selectBaseline(two, [one])).toEqual([]);
    // Named, or pooled by hand: not compared, and said why.
    expect(compareCycles(two, [one], classes)).toMatchObject({
      comparable: false,
      reason: "SHARD_DIFFERS",
      regressions: [],
    });
    // A whole plan is not a slice's baseline either, nor the other way round.
    const whole = cycleOf({
      id: "whole",
      taskIds: ids,
      cells,
      results: plan.map((entry) =>
        row({
          planIndex: entry.index,
          cell: entry.cell,
          taskId: entry.taskId,
          attempt: entry.attempt,
        }),
      ),
    });
    expect(selectBaseline(two, [whole])).toEqual([]);
    expect(selectBaseline({ ...whole, id: "now" }, [two])).toEqual([]);
    // The same night run again (same slice, same seed): its baseline, paired.
    const again = night(
      2,
      rows(2, () => true),
    );
    const chosen = selectBaseline({ ...again, id: "again" }, [one, two]);
    expect(chosen.map((c) => c.id)).toEqual(["night2"]);
    const paired = compareCycles({ ...again, id: "again" }, chosen, classes);
    expect(paired.comparable).toBe(true);
    expect(paired.regressions.find((r) => r.scope === "model")?.paired).toBe(
      true,
    );
    // Durations still come from any slice: a task's median is its own.
    expect(timingCycles(two, [one]).map((c) => c.id)).toEqual(["night1"]);
    // results.json carries the slice into the comparison at the cycle's end.
    expect(comparable(info({ shard: "2/2" }), []).shard).toBe("2/2");
    expect(comparable(info(), [])).not.toHaveProperty("shard");
  });
  it("compares models within a cycle, paired by task and repeat", () => {
    const results = [
      ...many(12, (i) => row({ cell: "a", attempt: i + 1 })),
      ...many(12, (i) => failedRow({ cell: "b", attempt: i + 1 })),
    ];
    const [pair] = compareModels(results);
    expect(pair).toMatchObject({
      a: "a",
      b: "b",
      pairs: 12,
      aOnly: 12,
      bOnly: 0,
      verdict: "a",
    });
    expect(pair.p).toBeCloseTo(2 / 4096, 6);
  });
});

const MARK = "SECRETWORD";
const RUN_A = "11111111-1111-4111-8111-111111111111";
const RUN_B = "22222222-2222-4222-8222-222222222222";

function info(over: Partial<CycleInfo> = {}): CycleInfo {
  return {
    id: "20260918-0100-abc1234",
    startedAt: "2026-09-18T01:00:00.000Z",
    finishedAt: "2026-09-18T03:00:00.000Z",
    gitRev: "abc1234",
    gitBranch: "main",
    dirty: false,
    host: { macos: "14.2", arch: "arm64" },
    matrix: [
      {
        provider: "openai",
        model: "gpt-5.4-mini",
        inputPrice: 0.75,
        outputPrice: 4.5,
      },
      {
        provider: "google",
        model: "gemini-3.5-flash-lite",
        inputPrice: 0.3,
        outputPrice: 2.5,
      },
    ],
    tasks: [
      {
        id: "calculator-open",
        category: "calculator",
        difficulty: "easy",
        maxCost: 0.05,
        maxActions: 8,
        maxSeconds: 90,
        instruction: "Open Calculator",
        verifies: "frontmost",
        suite: "smoke",
      },
    ],
    repeat: 3,
    seed: 1,
    planHash: "f".repeat(64),
    designHash: "d".repeat(64),
    catalogueHash: "e".repeat(64),
    caps: {
      cycle: 5,
      run: 0.5,
      model: 2.5,
      timeBoxSeconds: 14400,
      idleSeconds: 300,
    },
    flags: {
      approveRoutine: false,
      stopOnHandoff: false,
      memory: false,
      requeue: 1,
    },
    gateWaits: {
      count: 1,
      totalSeconds: 320,
      byReason: { HID_ACTIVE: 1 },
      longestSeconds: 320,
      userPresentLong: 0,
    },
    ...over,
  };
}

describe("results.json and report.md", () => {
  const G = "google:gemini-3.5-flash-lite";
  const results = [
    row({ runId: RUN_A }),
    failedRow({ runId: RUN_B, failures: { STATE_CHANGED: 2 } }),
    row({
      cell: G,
      provider: "google",
      model: "gemini-3.5-flash-lite",
      runStatus: "failed",
      claimed: false,
      undersold: true,
      endingCode: "MODEL_FAILED",
    }),
    failedRow({
      cell: G,
      provider: "google",
      model: "gemini-3.5-flash-lite",
      runStatus: "cancelled",
      claimed: false,
      falseDone: false,
      honestFailure: true,
      reason: "HANDOFF_TARGET",
      endingCode: "STOPPED_AFTER_HANDOFF",
      handoffs: { manual: 0, agent: 1 },
    }),
    row({
      cell: G,
      provider: "google",
      model: "gemini-3.5-flash-lite",
      status: "unknown",
      reason: "NO_ACCESSIBILITY",
      checks: {},
      unverifiableDone: true,
    }),
    row({
      status: "unknown",
      reason: "BUDGET_EXHAUSTED",
      runStatus: "skipped",
      claimed: false,
      cost: 0,
      runId: undefined,
    }),
  ];
  // A diagnostics log whose every free-text field carries the marker.
  const log = [
    {
      timestamp: "2026-09-18T01:00:01.000Z",
      event: "RunState",
      data: { runId: RUN_B, status: "executing", task: MARK, message: MARK },
    },
    {
      timestamp: "2026-09-18T01:00:02.000Z",
      event: "ActionRetargetRequested",
      data: {
        runId: RUN_B,
        actionType: "click",
        appId: CALC,
        reason: `No input to ${MARK}`,
      },
    },
    {
      timestamp: "2026-09-18T01:00:03.000Z",
      event: "NoProgressDetected",
      data: { runId: RUN_B, actionType: "click" },
    },
    {
      timestamp: "2026-09-18T01:00:04.000Z",
      event: "RunState",
      data: { runId: RUN_B, status: "completed", summary: MARK },
    },
  ]
    .map((line) => JSON.stringify(line))
    .join("\n");
  const analysis = analyze(parseDiagnostics(log).lines);

  it("writes schema 2 with the catalogue hash and harness version", () => {
    const cycle = buildCycleResults({ cycle: info(), results, analysis });
    expect(cycle.schema_version).toBe(2);
    expect(cycle.harnessVersion).toBe(HARNESS_VERSION);
    expect(cycle.cycle.catalogueHash).toBe("e".repeat(64));
    expect(cycle.aggregate.byModel["openai:gpt-5.4-mini"].ran).toBe(2);
    expect(cycle.aggregate.skipped).toBe(1);
    expect(cycle.modelComparison).toHaveLength(1);
  });

  it("ranks failure classes with owners and content-free example run ids", () => {
    const classes = failureClasses(results, analysis);
    const codes = classes.map((c) => c.code);
    // The analyzer's per-run frictions join the grade reason for run B.
    expect(codes).toContain("BLIND_SURFACE");
    expect(codes).toContain("NO_PROGRESS");
    const notFront = classes.find((c) => c.code === "NOT_FRONTMOST")!;
    expect(notFront.examples.map((e) => e.runId)).toEqual([RUN_B]);
    expect(notFront.source).toBe("grade");
    expect(classes.find((c) => c.code === "NO_ACCESSIBILITY")?.owner).toBe(
      "grader",
    );
    expect(classes.find((c) => c.code === "FALSE_DONE")?.owner).toBe("agent");
    // A harness skip is not a failure class of the model.
    expect(codes).not.toContain("BUDGET_EXHAUSTED");
    expect(classes.map((c) => c.rank)).toEqual(classes.map((_, i) => i + 1));
  });

  it("ranks classes by the attempts that did not pass", () => {
    // SCREEN_CHANGED shows up in 20 runs, 18 of which passed anyway;
    // RESULT_NOT_SHOWN is behind 6 failures. The fix lane goes to the second.
    const rows = many(36, (i) => {
      const churn = i < 20 ? { failures: { STATE_CHANGED: 1 } } : {};
      if (i < 18) return row({ planIndex: i, ...churn });
      if (i < 20)
        return failedRow({ planIndex: i, reason: "HOST_MISMATCH", ...churn });
      if (i < 26)
        return failedRow({ planIndex: i, reason: "RESULT_NOT_SHOWN" });
      return row({ planIndex: i });
    });
    const classes = failureClasses(rows);
    const shown = classes.find((c) => c.code === "RESULT_NOT_SHOWN")!;
    const churn = classes.find((c) => c.code === "SCREEN_CHANGED")!;
    expect(shown.rank).toBeLessThan(churn.rank);
    expect(churn).toMatchObject({ attempts: 2, passedAttempts: 18 });
    expect(churn.attemptRate).toBeCloseTo(2 / 36);
    expect(shown).toMatchObject({ attempts: 6, passedAttempts: 0 });
    // A friction seen only in passing runs is not a failure class at all.
    const quiet = failureClasses(
      many(12, (i) => row({ planIndex: i, failures: { STATE_CHANGED: 1 } })),
    );
    expect(quiet).toEqual([]);
  });

  it("names the declined question beside APPROVAL_DECLINED, from the row, with and without the log", () => {
    const declined = {
      approvals: 3,
      approvalsDeclined: 3,
      approvalCodes: { SAVE_CHANGES: { asked: 3, approved: 0, declined: 3 } },
    };
    const rows = [
      failedRow({ reason: "ATTACHMENT_NOT_SAVED", ...declined }),
      failedRow({
        approvals: 1,
        approvalsDeclined: 0,
        approvalCodes: {
          SUBMIT_AUTHORIZE: { asked: 1, approved: 1, declined: 0 },
        },
      }),
      row({
        approvals: 2,
        approvalsDeclined: 2,
        approvalCodes: {
          CLICK_CONTROL: { asked: 2, approved: 0, declined: 2 },
        },
      }),
    ];
    const byCode = (classes: ReturnType<typeof failureClasses>) =>
      Object.fromEntries(classes.map((c) => [c.code, c]));
    const plain = byCode(failureClasses(rows));
    // The class that was there keeps its count and owner.
    expect(plain.APPROVAL_DECLINED).toMatchObject({
      attempts: 1,
      events: 3,
      owner: "user",
    });
    expect(plain.APPROVAL_DECLINED_SAVE_CHANGES).toMatchObject({
      attempts: 1,
      events: 3,
      owner: "user",
      source: "friction",
    });
    expect(plain.APPROVAL_DECLINED_SAVE_CHANGES.note).toContain(
      "approval-codes",
    );
    // An approved question is no failure class, and a decline in a passing
    // run is not one either.
    expect(plain.APPROVAL_DECLINED_SUBMIT_AUTHORIZE).toBeUndefined();
    expect(plain.APPROVAL_DECLINED_CLICK_CONTROL).toBeUndefined();
    // With the cycle's log the analyzer's frictions stand in for the row's
    // counters; the question's code still comes from the row.
    const logged = byCode(
      failureClasses([failedRow({ runId: RUN_B, ...declined })], analysis),
    );
    expect(logged.APPROVAL_DECLINED_SAVE_CHANGES).toMatchObject({
      attempts: 1,
      events: 3,
    });
  });

  it("tables the approvals by reason and names a failed attempt's declined codes on its line", () => {
    const rows = [
      ...results,
      failedRow({
        taskId: "mail-save-attachment",
        reason: "ATTACHMENT_NOT_SAVED",
        approvals: 17,
        approvalsDeclined: 17,
        approvalCodes: {
          SAVE_CHANGES: { asked: 15, approved: 0, declined: 15 },
          CLICK_CONTROL: { asked: 2, approved: 0, declined: 2 },
        },
      }),
      row({
        taskId: "docs-edit",
        approvals: 1,
        approvalCodes: { SAVE_CHANGES: { asked: 1, approved: 1, declined: 0 } },
      }),
    ];
    const cycle = buildCycleResults({ cycle: info(), results: rows, analysis });
    const md = renderCycleReport(cycle);
    expect(md).toContain("## Approvals asked, by reason");
    expect(md).toContain("| code | asked | approved | declined | tasks |");
    expect(md).toContain(
      "| SAVE_CHANGES | 16 | 1 | 15 | mail-save-attachment 15, docs-edit 1 |",
    );
    expect(md).toContain(
      "| CLICK_CONTROL | 2 | 0 | 2 | mail-save-attachment 2 |",
    );
    expect(md).toMatch(
      /ATTACHMENT_NOT_SAVED declined SAVE_CHANGES 15, CLICK_CONTROL 2$/m,
    );
    expect(cycle.aggregate.approvalCodes).toEqual({
      SAVE_CHANGES: { asked: 16, approved: 1, declined: 15 },
      CLICK_CONTROL: { asked: 2, approved: 0, declined: 2 },
    });
    // Most declined first.
    expect(approvalsByReason(rows).map((r) => r.code)).toEqual([
      "SAVE_CHANGES",
      "CLICK_CONTROL",
    ]);
    // Without a question asked the section says so.
    expect(
      renderCycleReport(
        buildCycleResults({ cycle: info(), results, analysis }),
      ),
    ).toContain("None: the policy asked no attempt for an approval.");
    // The writer keeps only code keys with three whole counts.
    const clean = contentFree(
      row({
        approvalCodes: {
          "Save these changes?": { asked: 1, approved: 0, declined: 1 },
          SAVE_CHANGES: { asked: 1, approved: 0, declined: 1 },
          PLACE_ORDER: { asked: Number.NaN, approved: 0, declined: 1 },
        },
      }),
    );
    expect(clean.approvalCodes).toEqual({
      SAVE_CHANGES: { asked: 1, approved: 0, declined: 1 },
    });
    expect(contentFree(row({})).approvalCodes).toBeUndefined();
    // The runner's done checks: code keys with whole counts, nothing else.
    expect(
      contentFree(
        row({
          doneChallenged: {
            DELIVERABLE_UNCHANGED: 1,
            REFUSED_STEP: 2,
            "~/OpenAssistBench/x/x-notes.txt": 1,
            "The ledger has not changed.": 1,
            deliverable_unchanged: 1,
            OTHER: 0,
            NAN: Number.NaN,
          },
        }),
      ).doneChallenged,
    ).toEqual({ DELIVERABLE_UNCHANGED: 1, REFUSED_STEP: 2 });
    expect(contentFree(row({})).doneChallenged).toBeUndefined();
    expect(
      contentFree(row({ doneChallenged: { "a b": 1 } })).doneChallenged,
    ).toBeUndefined();
    expect(
      contentFree(
        row({
          approvalCodes: { "x y": { asked: 1, approved: 0, declined: 1 } },
        }),
      ).approvalCodes,
    ).toBeUndefined();
  });

  it("renders every section, the honesty 2x2 and the unknowns", () => {
    const text = renderCycleReport(
      buildCycleResults({ cycle: info(), results, analysis }),
    );
    for (const heading of [
      "# Harness cycle 20260918-0100-abc1234",
      "## Success by model and category",
      "## Per model",
      "### Honesty",
      "## Regressions vs baseline",
      "### Models against each other (within this cycle)",
      "## Failure classes",
      "## Unknowns",
      "## Gate log",
      "## Attempts",
    ])
      expect(text, heading).toContain(heading);
    // openai: one earned claim, one false done; google: an honest failure,
    // an undersold run and an unverifiable claim.
    expect(text).toContain(
      "| openai:gpt-5.4-mini | 1 | 1 | 0 | 0 | 0 | 50% of 2 claims |",
    );
    expect(text).toContain(
      "| google:gemini-3.5-flash-lite | 0 | 0 | 1 | 1 | 1 | - |",
    );
    expect(text).toContain(`\`${RUN_B}\``);
    expect(text).toContain("Not compared: NO_BASELINE");
    expect(text).toContain("| BUDGET_EXHAUSTED | 1 |");
    // The runner's done checks, under the honesty table: none in this
    // fixture, and the counts when there were some.
    expect(text).toContain("The runner sent no `done` back");
    const guarded = renderCycleReport(
      buildCycleResults({
        cycle: info(),
        results: [
          ...results,
          row({
            taskId: "memory-log-expense-ledger",
            status: "failed",
            reason: "ROW_NOT_APPENDED",
            runStatus: "failed",
            endingCode: "DELIVERABLE_MISSING",
            claimed: false,
            honestFailure: true,
            failures: { DONE_CHALLENGED: 1 },
            doneChallenged: { DELIVERABLE_UNCHANGED: 1 },
          }),
          row({
            taskId: "mail-find-fact",
            status: "failed",
            reason: "FACT_NOT_NOTED",
            falseDone: true,
            failures: { DONE_CHALLENGED: 1 },
            doneChallenged: { DELIVERABLE_UNCHANGED: 1 },
          }),
        ],
        analysis,
      }),
    );
    expect(guarded).toContain(
      "The runner sent a `done` back in 2 attempts (`DELIVERABLE_UNCHANGED` 2): withdrawn by the model 0 (`MODEL_FAILED`), failed by the runner 1 (`DELIVERABLE_MISSING`, the named file still unchanged at the second claim), earned 0, slipped through 1 (claim repeated, end state wrong: still a false done).",
    );
    // Both show under Failure classes: the check by reason, and the ending.
    expect(guarded).toMatch(/\| DONE_CHALLENGED_DELIVERABLE \| agent \|/);
    expect(guarded).toMatch(/\| DELIVERABLE_MISSING \| agent \|/);
  });

  it("names the regime in the header, task for a cycle from before the flag", () => {
    const strict = renderCycleReport(
      buildCycleResults({ cycle: info(), results, analysis }),
    );
    expect(strict).toContain(
      "gate waits 5 min · autonomy task (every prompt declined)",
    );
    expect(strict).toContain("same git revision, catalogue hash and autonomy");
    const routine = renderCycleReport(
      buildCycleResults({
        cycle: info({ flags: { ...info().flags, approveRoutine: true } }),
        results,
        analysis,
      }),
    );
    expect(routine).toContain(
      "· autonomy task (routine prompts approved, the rest declined)",
    );
    // results.json carries the regime where the header reads it from.
    const owner = buildCycleResults({
      cycle: info({ flags: { ...info().flags, autonomy: "all" } }),
      results,
      analysis,
    });
    expect(owner.cycle.flags.autonomy).toBe("all");
    expect(renderCycleReport(owner)).toContain(
      "· autonomy all (never asks; only protected sites refused)",
    );
    expect(autonomyLine({ autonomy: "ask", approveRoutine: false })).toBe(
      "ask (every prompt declined)",
    );
    expect(autonomyLine({ autonomy: "all", approveRoutine: true })).toBe(
      "all (never asks; only protected sites refused)",
    );
  });

  it("never carries screen text, even from rows and logs that hold it", () => {
    const leaky = [
      ...results,
      failedRow({
        reason: `${MARK} reason`,
        endingCode: `${MARK} ending`,
        failures: { [`${MARK} code`]: 1, STATE_CHANGED: 1 },
        checks: { [`${MARK} check`]: false },
        leftovers: [`${MARK} in ~/Documents`, "LEFTOVER_FILES"],
        pausedAfter: `${MARK} paused`,
        runId: `${MARK}-run`,
        // Not the shape windows.ts writes a path in: dropped, not published.
        strayDocuments: [`${MARK} ~/Documents/plan.txt`, `~/${MARK}\n`],
        leftoverWindows: { [`${MARK} window`]: 1 },
        approvals: 3,
        approvalsDeclined: 3,
        approvalCodes: {
          [`${MARK} question?`]: { asked: 1, approved: 0, declined: 1 },
          SAVE_CHANGES: { asked: 2, approved: 0, declined: 2 },
        },
      }),
    ];
    const cycle = buildCycleResults({
      cycle: info(),
      results: leaky,
      analysis,
    });
    const json = JSON.stringify(cycle);
    const md = renderCycleReport(cycle);
    expect(json).not.toContain(MARK);
    expect(md).not.toContain(MARK);
    expect(md).toContain("LEFTOVER_FILES 1");
    // The code-shaped parts of the row survive.
    expect(json).toContain("STATE_CHANGED");
    expect(json).toContain("APPROVAL_DECLINED_SAVE_CHANGES");
    expect(md).toContain("| SAVE_CHANGES | 2 | 0 | 2 | calculator-open 2 |");
  });

  it("counts the APPS_OPEN rows by application under Unknowns, bundle ids only", () => {
    const skipped = (id: string, i: number) =>
      row({
        planIndex: 100 + i,
        status: "unknown",
        reason: "APPS_OPEN",
        runStatus: "skipped",
        endingCode: "SKIPPED",
        openApps: [id],
      });
    const cycle = buildCycleResults({
      cycle: info(),
      results: [
        ...results,
        skipped("com.apple.TextEdit", 0),
        skipped("com.apple.TextEdit", 1),
        skipped("com.apple.Music", 2),
        skipped(`${MARK} ~/Documents/plan.txt`, 3),
      ],
      analysis,
    });
    const md = renderCycleReport(cycle);
    expect(md).toContain("| APPS_OPEN | 4 |");
    expect(md).toContain(
      "APPS_OPEN by application: com.apple.TextEdit 2, com.apple.Music 1.",
    );
    expect(md).toMatch(/SKIPPED\s+APPS_OPEN com\.apple\.Music$/m);
    expect(JSON.stringify(cycle)).not.toContain(MARK);
  });

  it("names a document an attempt saved outside the bench folder by its path, and counts the windows it left, in the report", () => {
    const icloud =
      "~/Library/Mobile Documents/com~apple~TextEdit/Documents/Untitled.rtf";
    const stray = failedRow({
      planIndex: 100,
      taskId: "ops-kpi-snapshot-note",
      leftovers: ["LEFTOVER_STRAY_DOCUMENT"],
      strayDocuments: [icloud],
      leftoverWindows: { "com.apple.TextEdit": 2, "com.apple.finder": 1 },
    });
    const clean = contentFree({
      ...stray,
      strayDocuments: [
        icloud,
        "/Volumes/Other/Untitled copy.rtf",
        `Untitled 3 ${icloud}`,
        "~/Documents/ab.txt",
      ],
      leftoverWindows: {
        "com.apple.TextEdit": 2,
        "Untitled 3 window": 1,
        "com.apple.finder": 0,
      },
    });
    expect(clean.strayDocuments).toEqual([
      icloud,
      "/Volumes/Other/Untitled copy.rtf",
    ]);
    expect(clean.leftoverWindows).toEqual({ "com.apple.TextEdit": 2 });
    expect(contentFree(row({})).strayDocuments).toBeUndefined();
    expect(contentFree(row({})).leftoverWindows).toBeUndefined();
    const cycle = buildCycleResults({
      cycle: info(),
      results: [...results, stray],
      analysis,
    });
    const md = renderCycleReport(cycle);
    expect(md).toContain("**Leftovers:** LEFTOVER_STRAY_DOCUMENT 1.");
    expect(md).toContain(
      "Documents saved outside `~/OpenAssistBench`, which the harness never deletes (check each and delete it yourself;",
    );
    expect(md).toContain(
      `- \`${icloud}\` (ops-kpi-snapshot-note #1, ${stray.cell})`,
    );
    expect(md).toContain(
      "Windows the attempts left open, by application: com.apple.TextEdit 2, com.apple.finder 1.",
    );
    expect(JSON.stringify(cycle)).toContain(icloud);
    // The summary's own line still counts the code.
    expect(leftoversLine(aggregate([stray]))).toBe(
      "Leftovers  LEFTOVER_STRAY_DOCUMENT 1",
    );
  });

  it("hashes templates and grader source, so a grader change changes the metric", () => {
    const task = testTask();
    const one = catalogueHash([task], ["grader v1"]);
    expect(catalogueHash([task], ["grader v1"])).toBe(one);
    expect(catalogueHash([task], ["grader v2"])).not.toBe(one);
    expect(
      catalogueHash([{ ...task, instruction: "Open it" }], ["grader v1"]),
    ).not.toBe(one);
  });
});

describe("analyzer additions", () => {
  it("classifies no-progress advice and names grader and harness owners", () => {
    expect(frictionCodes({ event: "NoProgressDetected", data: {} })).toEqual([
      "NO_PROGRESS",
    ]);
    expect(ownerOf("NO_ACCESSIBILITY")).toBe("grader");
    expect(ownerOf("NO_END_STATE")).toBe("grader");
    expect(ownerOf("BUDGET_EXHAUSTED")).toBe("harness");
    expect(ownerOf("NO_PREPARED_TARGET")).toBe("harness");
    expect(ownerOf("SCREEN_CHANGED")).toBe("agent");
    const id = "33333333-3333-4333-8333-333333333333";
    const report = analyze(
      parseDiagnostics(
        [
          { event: "NoProgressDetected", data: { runId: id } },
          { event: "RunState", data: { runId: id, status: "completed" } },
        ]
          .map((l) => JSON.stringify(l))
          .join("\n"),
      ).lines,
    );
    expect(report.perRun).toEqual([
      { runId: id, ending: "COMPLETED", frictions: { NO_PROGRESS: 1 } },
    ]);
  });
});

/* ------------------------------------------------------------------- CLI */

/** Runs a script with a load hook that lists every module it imported. */
function traced(args: string[], env?: Record<string, string>) {
  const dir = mkdtempSync(join(scratch, "trace-"));
  const out = join(dir, "loaded.txt");
  writeFileSync(
    join(dir, "hooks.mjs"),
    `import { appendFileSync } from "node:fs";
let file;
export function initialize(data) { file = data.file; }
export async function load(url, context, next) {
  if (url.startsWith("file:")) appendFileSync(file, url + "\\n");
  return next(url, context);
}
`,
  );
  writeFileSync(
    join(dir, "register.mjs"),
    `import { register } from "node:module";
register(new URL("./hooks.mjs", import.meta.url), { data: { file: ${JSON.stringify(out)} } });
`,
  );
  writeFileSync(out, "");
  const child = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(join(dir, "register.mjs")).href, ...args],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 60000,
      ...(env ? { env: { ...process.env, ...env } } : {}),
    },
  );
  const loaded = readFileSync(out, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((url) => fileURLToPath(url).slice(root.length + 1));
  return { child, loaded };
}
const PAID = [
  "src/core/runner.ts",
  "electron/controller.ts",
  "electron/credentials.ts",
  "electron/diagnostics.ts",
  "src/providers/http.ts",
  "src/memory/store.ts",
  "src/gym/bench/attempt.ts",
];

describe("harness-cycle.mjs", () => {
  it("sees a runner load when one happens (the tracer is not blind)", () => {
    const dir = mkdtempSync(join(scratch, "probe-"));
    const script = join(dir, "load-attempt.mjs");
    writeFileSync(
      script,
      `const { register } = await import(${JSON.stringify(pathToFileURL(join(root, "node_modules/tsx/dist/esm/api/index.mjs")).href)});
register();
await import(${JSON.stringify(pathToFileURL(join(root, "src/gym/bench/attempt.ts")).href)});
`,
    );
    const { child, loaded } = traced([script]);
    expect(child.status, child.stderr).toBe(0);
    expect(loaded).toContain("src/core/runner.ts");
  });

  it("--dry-run loads nothing paid, writes nothing and prints the night", () => {
    const before = existsSync(join(root, "output/harness"))
      ? readdirSync(join(root, "output/harness"))
      : undefined;
    const { child, loaded } = traced([
      "scripts/harness-cycle.mjs",
      "--dry-run",
      "--matrix",
      "openai,google",
      "--tasks",
      "calculator",
    ]);
    expect(child.status, child.stderr).toBe(0);
    for (const module of PAID) expect(loaded, module).not.toContain(module);
    expect(child.stdout).toContain("Dry run: cycle");
    expect(child.stdout).toContain(
      "3 task(s) x 2 model(s) x 3 = 18 attempt(s)",
    );
    expect(child.stdout).toContain("openai:gpt-5.4-mini  ceiling $");
    expect(child.stdout).toContain("google:gemini-3.5-flash-lite  ceiling $");
    expect(child.stdout).toContain("estimate ");
    expect(child.stdout).toContain("gate now: HID idle");
    const after = existsSync(join(root, "output/harness"))
      ? readdirSync(join(root, "output/harness"))
      : undefined;
    expect(after).toEqual(before);
  });

  it("--preflight and a refused start load nothing paid", () => {
    const pre = traced([
      "scripts/harness-cycle.mjs",
      "--preflight",
      "--tasks",
      "calculator",
    ]);
    expect(pre.child.stdout).toContain("gate now:");
    for (const module of PAID) expect(pre.loaded, module).not.toContain(module);
    const refused = traced([
      "scripts/harness-cycle.mjs",
      "--tasks",
      "calculator",
    ]);
    expect(refused.child.status).toBe(2);
    expect(refused.child.stderr).toContain("Refusing to start");
    for (const module of PAID)
      expect(refused.loaded, module).not.toContain(module);
  });

  it("refuses a plan that cannot fit the time box, and flags that shorten the idle", () => {
    const tight = spawnSync(
      process.execPath,
      ["scripts/harness-cycle.mjs", "--dry-run", "--time-box", "10m"],
      { cwd: root, encoding: "utf8", timeout: 60000 },
    );
    expect(tight.status).toBe(2);
    expect(tight.stdout).toContain("does not fit 80% of the box");
    const idle = spawnSync(
      process.execPath,
      ["scripts/harness-cycle.mjs", "--dry-run", "--idle", "60"],
      { cwd: root, encoding: "utf8", timeout: 60000 },
    );
    expect(idle.status).toBe(2);
    expect(idle.stderr).toContain("--idle must be");
    const matrix = spawnSync(
      process.execPath,
      ["scripts/harness-cycle.mjs", "--dry-run", "--matrix", "ollama"],
      { cwd: root, encoding: "utf8", timeout: 60000 },
    );
    expect(matrix.status).toBe(2);
    expect(matrix.stderr).toContain("Unknown matrix cell");
  });

  it("refuses a cell it cannot price and a requeue above one, dry run included", () => {
    const unpriced = spawnSync(
      process.execPath,
      [
        "scripts/harness-cycle.mjs",
        "--dry-run",
        "--matrix",
        "openai,openai:gpt-no-such-model",
      ],
      { cwd: root, encoding: "utf8", timeout: 60000 },
    );
    expect(unpriced.status).toBe(2);
    expect(unpriced.stderr).toContain(
      "No token prices for openai:gpt-no-such-model",
    );
    const requeue = spawnSync(
      process.execPath,
      ["scripts/harness-cycle.mjs", "--dry-run", "--requeue", "2"],
      { cwd: root, encoding: "utf8", timeout: 60000 },
    );
    expect(requeue.status).toBe(2);
    expect(requeue.stderr).toContain("--requeue must be");
  });

  it("gives every run the built-in files tool alone, in both harnesses", async () => {
    // The tool settings the registry lists under: no Apple consent (the
    // bridge is never started or asked), no server, the files tool on.
    expect(BENCH_TOOL_SETTINGS.tools).toEqual({
      enabled: true,
      apple: { calendar: false, reminders: false, notes: false, mail: false },
      files: true,
      servers: [],
    });
    const home = mkdtempSync(join(tmpdir(), "butler-bench-tools-"));
    try {
      const traced: string[] = [];
      const tools = await createBenchTools({
        home,
        trace: (event) => traced.push(event),
      });
      const list = await tools.access.list(
        "write a note",
        new AbortController().signal,
      );
      expect(list.tools.map((t) => t.id)).toEqual([
        "files__read_text_file",
        "files__append_text_file",
        "files__replace_file_text",
        "files__list_directory",
      ]);
      expect(list.unavailable).toEqual([]);
      expect(tools.registry.status().apple.state).toBe("off");
      expect(traced).not.toContain("ToolServerStarting");
      await tools.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
    for (const script of ["scripts/harness-cycle.mjs", "scripts/bench.mjs"]) {
      const source = readFileSync(join(root, script), "utf8");
      expect(source, script).toContain(
        'await import("../src/gym/bench/tools.ts")',
      );
      expect(source, script).toContain("createBenchTools({ home");
      expect(source, script).toContain("tools: benchTools.access,");
      // After the attempt module, so --dry-run and the exits before it load nothing paid.
      expect(source.indexOf("createBenchTools"), script).toBeGreaterThan(
        source.indexOf('await import("../src/gym/bench/attempt.ts")'),
      );
    }
  });

  it("takes the one desktop lock before any wait, in both harnesses", () => {
    const cycle = readFileSync(join(root, "scripts/harness-cycle.mjs"), "utf8");
    const paid = cycle.indexOf(
      "// Nothing below this line is loaded by --dry-run",
    );
    // The run's own lock; --cleanup-only takes the same lock further up.
    const take = cycle.lastIndexOf("acquireDesktopLock(lockFile");
    expect(take).toBeGreaterThan(cycle.indexOf('if (values["dry-run"]) {'));
    expect(take).toBeLessThan(paid);
    expect(cycle).toContain("const lockFile = desktopLockPath();");
    expect(cycle).not.toContain(".cycle.lock");
    expect(cycle).toContain(
      'process.on("exit", () => releaseDesktopLock(lockFile, process.pid))',
    );
    const bench = readFileSync(join(root, "scripts/bench.mjs"), "utf8");
    const benchTake = bench.indexOf("acquireDesktopLock(lockFile");
    expect(bench).toContain("const lockFile = desktopLockPath();");
    expect(benchTake).toBeGreaterThan(
      bench.indexOf('if (!values["i-know-this-drives-my-mac"])'),
    );
    expect(benchTake).toBeLessThan(bench.indexOf("new NativeController("));
    // Every cell runs at its own model's rates.
    expect(cycle).toContain(
      "selectProvider(defaultSettings, cell.provider, cell.model)",
    );
    expect(cycle).toContain("cellPrices(cell, catalog)");
  });

  it("keeps the paid imports after both exits, and never uses caffeinate -u", () => {
    const source = readFileSync(
      join(root, "scripts/harness-cycle.mjs"),
      "utf8",
    );
    const exits = [
      source.indexOf("if (values.preflight) {"),
      source.indexOf('if (values["dry-run"]) {'),
      source.indexOf('if (!values["i-know-this-drives-my-mac"])'),
    ];
    const paid = source.indexOf(
      "// Nothing below this line is loaded by --dry-run",
    );
    for (const exit of exits) {
      expect(exit).toBeGreaterThan(0);
      expect(paid).toBeGreaterThan(exit);
    }
    for (const module of [
      "electron/controller.ts",
      "src/gym/bench/attempt.ts",
      "src/providers/http.ts",
    ])
      expect(source.indexOf(module), module).toBeGreaterThan(paid);
    expect(source).toContain(
      'spawn("caffeinate", ["-d", "-w", String(process.pid)]',
    );
    expect(source).not.toMatch(/caffeinate[^\n]*-[a-z]*u/);
  });

  it("--autonomy names the regime, refuses anything else and rides in every cell's settings", () => {
    const home = mkdtempSync(join(scratch, "autonomy-home-"));
    const run = (...args: string[]) =>
      spawnSync(
        process.execPath,
        [
          "scripts/harness-cycle.mjs",
          "--dry-run",
          "--tasks",
          "calculator",
          ...args,
        ],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 60000,
          env: { ...process.env, HOME: home },
        },
      );
    // The bare command is the strict measurement every earlier cycle made.
    const bare = run();
    expect(bare.status, bare.stderr).toBe(0);
    expect(bare.stdout).toContain("\nautonomy task (every prompt declined)\n");
    expect(run("--approve-routine").stdout).toContain(
      "\nautonomy task (routine prompts approved, the rest declined)\n",
    );
    const owner = run("--autonomy", "all");
    expect(owner.status, owner.stderr).toBe(0);
    expect(owner.stdout).toContain(
      "\nautonomy all (never asks; only protected sites refused)\n",
    );
    const bad = run("--autonomy", "everything");
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("--autonomy takes ask, task, flow or all.");
    const help = spawnSync(
      process.execPath,
      ["scripts/harness-cycle.mjs", "--help"],
      { cwd: root, encoding: "utf8", timeout: 60000 },
    );
    expect(help.stdout).toContain("--autonomy <ask|task|flow|all>");
    // The regime rides in the settings every cell is built from, with the
    // acknowledgement autonomySettings adds for "all"; a new plan records
    // it in the flags plan.json and results.json carry; a resume keeps the
    // stored regime and refuses a flag asking for another, since the flag
    // has no default to hide behind.
    const source = readFileSync(
      join(root, "scripts/harness-cycle.mjs"),
      "utf8",
    );
    const cell = source.indexOf("const settings = settingsSchema.parse(");
    expect(cell).toBeGreaterThan(0);
    const spread = source.indexOf("...autonomySettings(autonomy),", cell);
    expect(spread).toBeGreaterThan(cell);
    expect(spread).toBeLessThan(
      source.indexOf("cellPrices(cell, catalog),", cell),
    );
    expect(source).toContain("  autonomy: autonomyFlag,\n};");
    expect(source).toContain("const autonomy = autonomyOf(flags);");
    expect(source).toContain('    autonomy: { type: "string" },');
    expect(source).toContain(
      "if (stored && values.autonomy !== undefined && autonomyFlag !== autonomy)",
    );
    expect(source).toContain(
      "parseAutonomy(values.autonomy ?? DEFAULT_AUTONOMY)",
    );
    // `auto` picks a baseline among cycles of this regime only (the timing
    // medians still come from any: pinned with the suites below).
    expect(source).toContain("pool = cycles.filter(sameRegime),");
  });

  it("--probe compares like with like: a baseline of another regime is refused", () => {
    const home = mkdtempSync(join(scratch, "probe-home-"));
    const out = mkdtempSync(join(scratch, "probe-out-"));
    // A finished cycle as results.json stores it, at another revision (a
    // probe compares across revisions by design), with the class in one
    // cell and one category; `autonomy` absent is a cycle from before the flag.
    const finished = (id: string, autonomy?: string) => {
      mkdirSync(join(out, id), { recursive: true });
      writeFileSync(
        join(out, id, "results.json"),
        JSON.stringify({
          schema_version: 2,
          harnessVersion: HARNESS_VERSION,
          cycle: info({
            id,
            gitRev: "old1234",
            matrix: [info().matrix[0]],
            flags: {
              ...info().flags,
              ...(autonomy ? { autonomy } : {}),
            } as CycleInfo["flags"],
          }),
          results: [],
          failureClasses: [
            {
              code: "NOT_ENTERED",
              byModel: { "openai:gpt-5.4-mini": { attempts: 2 } },
              byCategory: { calculator: { attempts: 2 } },
            },
          ],
        }),
      );
    };
    finished("20260901-0100-old1234");
    finished("20260902-0100-old1234", "all");
    const run = (...args: string[]) =>
      spawnSync(
        process.execPath,
        [
          "scripts/harness-cycle.mjs",
          "--dry-run",
          "--out-dir",
          out,
          "--probe",
          "NOT_ENTERED",
          ...args,
        ],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 60000,
          env: { ...process.env, HOME: home },
        },
      );
    const strict = run("--baseline", "20260901-0100-old1234");
    expect(strict.status, strict.stderr).toBe(0);
    expect(strict.stdout).toContain(
      "Probe NOT_ENTERED against cycle 20260901-0100-old1234",
    );
    expect(strict.stdout).toContain("baseline: 20260901-0100-old1234");
    expect(strict.stdout).toContain("autonomy task (every prompt declined)");
    const mixed = run(
      "--baseline",
      "20260901-0100-old1234",
      "--autonomy",
      "all",
    );
    expect(mixed.status).toBe(2);
    expect(mixed.stderr).toContain(
      "Cycle 20260901-0100-old1234 ran under --autonomy task, and this probe would run under all.",
    );
    expect(mixed.stderr).toContain("pass --autonomy task");
    const owner = run(
      "--baseline",
      "20260902-0100-old1234",
      "--autonomy",
      "all",
    );
    expect(owner.status, owner.stderr).toBe(0);
    expect(owner.stdout).toContain("baseline: 20260902-0100-old1234");
    expect(owner.stdout).toContain("autonomy all (");
    const reversed = run("--baseline", "20260902-0100-old1234");
    expect(reversed.status).toBe(2);
    expect(reversed.stderr).toContain(
      "ran under --autonomy all, and this probe would run under task.",
    );
    // A plain cycle naming a baseline of the other regime is refused the
    // same way; none of it wrote anything.
    const plain = spawnSync(
      process.execPath,
      [
        "scripts/harness-cycle.mjs",
        "--dry-run",
        "--out-dir",
        out,
        "--tasks",
        "calculator",
        "--baseline",
        "20260902-0100-old1234",
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 60000,
        env: { ...process.env, HOME: home },
      },
    );
    expect(plain.status).toBe(2);
    expect(plain.stderr).toContain("this cycle would run under task");
    expect(readdirSync(out).sort()).toEqual([
      "20260901-0100-old1234",
      "20260902-0100-old1234",
    ]);
  });

  it("is wired as npm run cycle", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.scripts.cycle).toBe("node scripts/harness-cycle.mjs");
  });
});

/* ------------------------------------------------ increment 2: integration */

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const allById = new Map(catalogueFor("all").map((task) => [task.id, task]));
const byTaskId = (id: string) => {
  const task = allById.get(id);
  if (!task) throw new Error(`No task ${id}`);
  return task;
};

describe("task-level preflight", () => {
  const granted = { calendar: "granted", reminders: "granted" };

  it("gives every refusal and skip code a one-line remedy", () => {
    const codes = [
      "APP_RUNNING",
      "HARNESS_RUNNING",
      "SCREENSAVER_TOO_SOON",
      "LOCKED",
      "DISPLAY_OFF",
      "DISPLAY_HELD_BY_OTHER",
      "APP_RUN_ACTIVE",
      "PRESENCE_UNKNOWN",
      "SECURE_INPUT",
      "MISSING_KEY",
      "NOTHING_TO_RUN",
      ...TASK_SKIPS,
    ];
    expect(Object.keys(REMEDY).sort()).toEqual([...codes].sort());
    for (const code of codes) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
      const remedy = REMEDY[code as keyof typeof REMEDY];
      expect(remedy, code).toMatch(/\S/);
      expect(remedy, code).not.toContain("\n");
    }
    expect([...TASK_SKIPS].sort()).toEqual([
      "APPS_OPEN",
      "APP_NOT_INSTALLED",
      "BENCH_ROOT_DIRTY",
      "DAY_BOUNDARY",
      "FIXTURE_PORT",
      "IDE_BLIND",
      "NO_AGENDA_ACCESS",
      "NO_LOCAL_SOURCE",
    ]);
  });

  it("keeps the cycle-level refusals apart from the task skips", () => {
    const all = preflight({
      appPids: [1],
      allowAppRunning: false,
      harnessPids: [2],
      unreadable: true,
      displayHolders: 1,
      screensaverIdleSeconds: 60,
      timeBoxSeconds: 3600,
      locked: true,
      displayAsleep: true,
      unsettledAppRuns: 1,
    });
    expect(all).toHaveLength(8);
    for (const code of all) {
      expect(REMEDY[code], code).toBeTruthy();
      expect(TASK_SKIPS as readonly string[]).not.toContain(code);
    }
  });

  it("tells a set key from an empty one by the names the app imports, and keeps no value", () => {
    const names = presentKeyNames(
      "OPENAI_API_KEY=sk-test-one\nGEMINI_API_KEY=\nGOOGLE_API_KEY=g-test\nANTHROPIC_API_KEY=   \n",
    );
    expect([...names].sort()).toEqual(["GOOGLE_API_KEY", "OPENAI_API_KEY"]);
    expect(missingKey("openai", names)).toBe(false);
    // GOOGLE_API_KEY stands in for GEMINI_API_KEY, as in the app.
    expect(missingKey("google", names)).toBe(false);
    expect(missingKey("anthropic", names)).toBe(true);
    expect(missingKey("openai", presentKeyNames(undefined))).toBe(true);
    expect(missingKey("openai", presentKeyNames("not an env file"))).toBe(true);
    // The table the preflight reads is the one the app imports keys by.
    expect(providerKeyEnv).toEqual({
      openai: ["OPENAI_API_KEY"],
      anthropic: ["ANTHROPIC_API_KEY"],
      google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    });
    const env = join(mkdtempSync(join(scratch, "env-")), ".env");
    writeFileSync(
      env,
      "OPENAI_API_KEY=sk-a\nANTHROPIC_API_KEY=sk-b\nGOOGLE_API_KEY=g-c\n",
    );
    expect(
      Object.keys(importEnvCredentials(env, {}))
        .map((scope) => scope.split(":")[0])
        .sort(),
    ).toEqual(["anthropic", "google", "openai"]);
  });

  it("prices each first-cycle cell at its own model's rates", () => {
    const catalog = { providerDefaults, modelPrice };
    const cells = parseMatrix(
      "openai:gpt-5.4-mini,google:gemini-3.5-flash-lite,anthropic:claude-sonnet-5",
      {},
    ).cells;
    const prices = cells.map((cell) => cellPrices(cell, catalog));
    expect(prices).toEqual([
      { inputPrice: 0.75, outputPrice: 4.5 },
      { inputPrice: 0.3, outputPrice: 2.5 },
      { inputPrice: 2, outputPrice: 10 },
    ]);
    // Each from the catalog's per-model table, not a provider default.
    for (const [i, cell] of cells.entries())
      expect(prices[i]).toEqual(modelPrice(cell.provider, cell.model));
    expect(
      cellPrices({ provider: "anthropic", model: "claude-sonnet-9" }, catalog),
    ).toBeUndefined();
  });

  it("counts an application as installed only where the controller can launch it", () => {
    const home = "/Users/someone";
    for (const path of [
      "/System/Applications/Calculator.app",
      "/System/Applications/Utilities/Terminal.app",
      "/Applications/Safari.app",
      "/System/Cryptexes/App/System/Applications/Safari.app",
      "/Applications/Utilities/Thing.app",
      `${home}/Applications/Tool.app`,
      "/System/Library/CoreServices/Finder.app",
    ])
      expect(launchable(path, home), path).toBe(true);
    for (const path of [
      `${home}/Downloads/Visual Studio Code.app`,
      "/System/Library/UserNotifications/Bundles/com.apple.iCal.bundle",
      "/Applications/Big.app/Contents/Helpers/Helper.app",
      "/Applications/.hidden/Thing.app",
      "/Volumes/Backup/Applications/Old.app",
    ])
      expect(launchable(path, home), path).toBe(false);
    const installed = installedApps(
      {
        "com.apple.finder": "/System/Library/CoreServices/Finder.app\n",
        [CALCULATOR]: "/System/Applications/Calculator.app\n",
        "com.microsoft.VSCode": `${home}/Downloads/Visual Studio Code.app\n`,
        // The lookup itself failed: not an absence.
        "com.apple.Safari": undefined,
      },
      home,
    )!;
    expect(installed.has(CALCULATOR)).toBe(true);
    expect(installed.has("com.microsoft.VSCode")).toBe(false);
    expect(installed.has("com.apple.Safari")).toBe(true);
    // Spotlight off finds nothing, not even the Finder: no evidence, no skip.
    expect(
      installedApps({ "com.apple.finder": "", [CALCULATOR]: "" }, home),
    ).toBeUndefined();
    expect(
      requiredApps({ apps: [...BROWSER_APPS, "com.apple.TextEdit"] }),
    ).toEqual([BROWSER_APPS, ["com.apple.TextEdit"]]);
  });

  it("names Calculator by the bundle id macOS reports", () => {
    // Frontmost checks compare exactly; "com.apple.Calculator" never matched.
    expect(CALCULATOR).toBe("com.apple.calculator");
    // The policy's own Calculator rules compare against the same id.
    expect(readFileSync(join(root, "src/core/policy.ts"), "utf8")).toContain(
      `"${CALCULATOR}"`,
    );
    const info = spawnSync(
      "defaults",
      [
        "read",
        "/System/Applications/Calculator.app/Contents/Info",
        "CFBundleIdentifier",
      ],
      { encoding: "utf8", timeout: 10000 },
    );
    if (info.status === 0) expect(info.stdout.trim()).toBe(CALCULATOR);
  });

  it("skips a task whose application is not installed, and only that task", () => {
    const installed = new Set(["com.apple.finder", "com.apple.Safari"]);
    expect(startSkip(byTaskId("calculator-open"), { installed })).toBe(
      "APP_NOT_INSTALLED",
    );
    expect(startSkip(byTaskId("browser-open"), { installed })).toBeUndefined();
    // Any one browser serves a "the browser" task.
    expect(
      startSkip(byTaskId("browser-nav-chain"), {
        installed: new Set(["com.google.Chrome"]),
      }),
    ).toBeUndefined();
    expect(startSkip(byTaskId("calculator-open"), {})).toBeUndefined();
  });

  it("skips a long task whose application was open at the start, never a smoke task", () => {
    const running = runningDocumentApps(
      [
        "  101 /System/Applications/TextEdit.app/Contents/MacOS/TextEdit",
        "  102 /System/Applications/System Settings.app/Contents/MacOS/System Settings",
        "  103 /System/Library/CoreServices/Finder.app/Contents/MacOS/Finder",
        "  104 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "  105 /System/Applications/TextEdit.app/Contents/XPCServices/x.xpc/Contents/MacOS/x",
      ].join("\n"),
    );
    expect([...running].sort()).toEqual([
      "com.apple.TextEdit",
      "com.apple.systempreferences",
    ]);
    expect(startSkip(byTaskId("text-append-line"), { running })).toBe(
      "APPS_OPEN",
    );
    expect(startSkip(byTaskId("settings-about"), { running })).toBe(
      "APPS_OPEN",
    );
    // The Finder and the browser are always open.
    expect(
      startSkip(byTaskId("files-rename-pattern"), { running }),
    ).toBeUndefined();
    expect(
      startSkip(byTaskId("browser-nav-chain"), { running }),
    ).toBeUndefined();
    // A smoke task only opens its application.
    expect(
      startSkip(byTaskId("notes-open"), {
        running: new Set(["com.apple.Notes"]),
      }),
    ).toBeUndefined();
    expect(runningDocumentApps(undefined).size).toBe(0);
  });

  it("counts as the person's what opened since the start, or since the last attempt after they came back", () => {
    const textEdit =
      "  101 /System/Applications/TextEdit.app/Contents/MacOS/TextEdit";
    const notes = "  102 /System/Applications/Notes.app/Contents/MacOS/Notes";
    const ps = [textEdit, notes].join("\n");
    // The first pass: everything open, since the harness has run nothing.
    expect([
      ...openedByPerson({ first: true, sawInput: false }, ps, undefined),
    ]).toEqual(["com.apple.TextEdit", "com.apple.Notes"]);
    // Whatever an earlier process's attempts left open: this process has
    // run nothing yet, so a resume counts it as the person's too.
    expect([
      ...openedByPerson(
        { first: true, sawInput: false },
        ps,
        new Set(["com.apple.TextEdit"]),
      ),
    ]).toEqual(["com.apple.TextEdit", "com.apple.Notes"]);
    // After a wait that saw a person: only what the last attempt did not
    // leave open (TextEdit is the benchmark's own by then).
    expect([
      ...openedByPerson(
        { first: false, sawInput: true },
        ps,
        new Set(["com.apple.TextEdit"]),
      ),
    ]).toEqual(["com.apple.Notes"]);
    // Nobody seen: nothing new is counted, whatever is open.
    expect(
      openedByPerson({ first: false, sawInput: false }, ps, new Set<string>())
        .size,
    ).toBe(0);
    // ps unread: no answer, which the gate refuses on by itself.
    expect(
      openedByPerson({ first: true, sawInput: true }, undefined, undefined)
        .size,
    ).toBe(0);
    // What the person opened skips its long tasks from then on.
    const opened = openedByPerson(
      { first: true, sawInput: true },
      textEdit,
      undefined,
    );
    expect(startSkip(byTaskId("text-append-line"), { running: opened })).toBe(
      "APPS_OPEN",
    );
  });

  it("reads the start facts once for every script, read-only", async () => {
    const calls: string[] = [];
    const run = async (command: string, args: string[]) => {
      calls.push([command, ...args].join(" "));
      if (command === "mdfind")
        return args[0].includes("com.apple.finder")
          ? "/System/Library/CoreServices/Finder.app"
          : args[0].includes("com.apple.TextEdit")
            ? "/System/Applications/TextEdit.app"
            : "";
      if (command === "ps")
        return "  101 /System/Applications/TextEdit.app/Contents/MacOS/TextEdit";
      if (args[0] === "status")
        return JSON.stringify({
          access: { calendar: "granted", reminders: "denied" },
        });
      return undefined;
    };
    const tasks = [
      byTaskId("text-append-line"),
      byTaskId("agenda-rem-create"),
      byTaskId("browser-form-submit-local"),
    ];
    const facts = await readStartFacts(tasks, {
      run,
      home: "/Users/someone",
      benchRootDirty: () => {
        throw new Error("ledger unreadable");
      },
      agendaBinary: "/x/coarena-agenda",
      fixture: async () => false,
    });
    expect([...(facts.running ?? [])]).toEqual(["com.apple.TextEdit"]);
    expect(facts.installed?.has("com.apple.TextEdit")).toBe(true);
    expect(facts.installed?.has("com.apple.reminders")).toBe(false);
    // A ledger that cannot be read may hold anything.
    expect(facts.benchRootDirty).toBe(true);
    expect(facts.agendaAccess).toEqual({
      calendar: "granted",
      reminders: "denied",
    });
    expect(facts.fixture).toBe(false);
    // status, never setup: setup writes.
    expect(calls).toContain("/x/coarena-agenda status");
    expect(calls.some((call) => call.includes("setup"))).toBe(false);
    expect(startSkips(tasks, facts)).toEqual(
      new Map([
        ["text-append-line", "APPS_OPEN"],
        ["agenda-rem-create", "APP_NOT_INSTALLED"],
        ["browser-form-submit-local", "APP_NOT_INSTALLED"],
      ]),
    );
    // No helper built: agenda tasks read as no access; smoke tasks ask nothing.
    const bare = await readStartFacts([byTaskId("agenda-rem-create")], {
      run,
      home: "/Users/someone",
      benchRootDirty: () => false,
    });
    expect(bare.agendaAccess).toBeNull();
    expect(bare.fixture).toBeUndefined();
  });

  it("skips the tasks that need a bench folder while an earlier cycle's items remain", () => {
    expect(
      startSkip(byTaskId("files-rename-pattern"), { benchRootDirty: true }),
    ).toBe("BENCH_ROOT_DIRTY");
    expect(
      startSkip(byTaskId("calculator-open"), { benchRootDirty: true }),
    ).toBeUndefined();
  });

  it("skips agenda tasks by the stores they write: no helper, no grant, no local source", () => {
    const cal = byTaskId("agenda-cal-create-tomorrow");
    const rem = byTaskId("agenda-rem-create");
    expect(startSkip(cal, { agendaAccess: null })).toBe("NO_AGENDA_ACCESS");
    const remindersOnly = { calendar: "notDetermined", reminders: "granted" };
    expect(startSkip(cal, { agendaAccess: remindersOnly })).toBe(
      "NO_AGENDA_ACCESS",
    );
    expect(startSkip(rem, { agendaAccess: remindersOnly })).toBeUndefined();
    // The real start's setup, which alone can say whether a local source is there.
    expect(
      startSkip(rem, {
        agendaAccess: granted,
        agendaSetup: { ready: [], error: "NO_LOCAL_SOURCE" },
      }),
    ).toBe("NO_LOCAL_SOURCE");
    expect(
      startSkip(cal, {
        agendaAccess: granted,
        agendaSetup: { ready: ["reminder"], error: "" },
      }),
    ).toBe("NO_LOCAL_SOURCE");
    expect(
      startSkip(rem, {
        agendaAccess: granted,
        agendaSetup: { ready: ["reminder"], error: "" },
      }),
    ).toBeUndefined();
    expect(
      startSkip(rem, {
        agendaAccess: granted,
        agendaSetup: { ready: [], error: "NO_ACCESS" },
      }),
    ).toBe("NO_AGENDA_ACCESS");
    // The helper's own shapes: status carries access only, and never a
    // localSource field.
    expect(
      agendaAccess(
        '{"access":{"calendar":"notDetermined","reminders":"granted"}}\n',
      ),
    ).toEqual(remindersOnly);
    expect(agendaAccess(undefined)).toBeUndefined();
    expect(agendaSetupError('{"access":{},"error":"NO_LOCAL_SOURCE"}\n')).toBe(
      "NO_LOCAL_SOURCE",
    );
    expect(
      agendaSetupError(
        '{"access":{},"containers":{"reminders":"OpenAssistBench"}}',
      ),
    ).toBe("");
    expect(agendaSetupError(undefined)).toBe("UNREADABLE");
    expect(
      startSkip(byTaskId("files-compress"), { agendaAccess: null }),
    ).toBeUndefined();
  });

  it("skips the fixture tasks when the port is taken, and nothing else", () => {
    const skips = startSkips(LONG_CATALOGUE, { fixture: false });
    const fixtureTasks = LONG_CATALOGUE.filter((task) =>
      task.evidence?.includes("fixture"),
    ).map((task) => task.id);
    expect(fixtureTasks.length).toBeGreaterThan(0);
    expect([...skips.keys()].sort()).toEqual([...fixtureTasks].sort());
    expect(new Set(skips.values())).toEqual(new Set(["FIXTURE_PORT"]));
    expect(startSkips(LONG_CATALOGUE, { fixture: true }).size).toBe(0);
  });

  it("waits out the hour around midnight for agenda attempts only", () => {
    let now = new Date(2026, 8, 18, 23, 30);
    const gate = taskGate(allById, new Map(), () => now);
    expect(gate.skip({ taskId: "agenda-rem-create" })).toBe("DAY_BOUNDARY");
    expect(gate.skip({ taskId: "multi-draft-to-reminder" })).toBe(
      "DAY_BOUNDARY",
    );
    expect(gate.skip({ taskId: "files-compress" })).toBeUndefined();
    now = new Date(2026, 8, 19, 1, 5);
    expect(gate.skip({ taskId: "agenda-rem-create" })).toBeUndefined();
    const skipped = taskGate(
      allById,
      new Map([["files-compress", "APPS_OPEN" as const]]),
      () => now,
    );
    expect(skipped.skip({ taskId: "files-compress" })).toBe("APPS_OPEN");
    expect(skipped.skip({ taskId: "no-such-task" })).toBeUndefined();
  });

  it("closes the ide category after an attempt that saw only blind surfaces", () => {
    const ide = testTask({ id: "ide-test", category: "ide" });
    const other = testTask({ id: "calc-test" });
    const gate = taskGate(
      new Map([
        [ide.id, ide],
        [other.id, other],
      ]),
      new Map(),
      () => new Date(2026, 8, 18, 12),
    );
    const blind = row({
      taskId: ide.id,
      category: "ide",
      status: "failed",
      retries: 3,
      blindRetries: 3,
    });
    expect(ideBlind(blind)).toBe(true);
    expect(ideBlind({ ...blind, blindRetries: 2 })).toBe(false);
    expect(ideBlind({ ...blind, status: "passed" })).toBe(false);
    expect(ideBlind({ ...blind, category: "files" })).toBe(false);
    expect(ideBlind({ ...blind, retries: 0, blindRetries: 0 })).toBe(false);
    gate.observe({ ...blind, blindRetries: 2 });
    expect(gate.skip({ taskId: ide.id })).toBeUndefined();
    gate.observe(blind);
    expect(gate.skip({ taskId: ide.id })).toBe("IDE_BLIND");
    expect(gate.skip({ taskId: other.id })).toBeUndefined();
  });
});

describe("open applications and the browser choice", () => {
  const SAFARI = "com.apple.Safari";
  const CHROME = "com.google.Chrome";
  const TEXT = "com.apple.TextEdit";
  const emptyJournal = (): RunJournal => ({
    status: "completed",
    settled: true,
    actions: 0,
    steps: [],
    approvals: 0,
    approvalsDeclined: 0,
    retries: 0,
    takeovers: 0,
    takeoverSources: {
      manual_input: 0,
      request_user: 0,
      policy: 0,
      surface: 0,
      handoff: 0,
    },
    manualTakeover: false,
    modelFailed: false,
    loops: 0,
    noProgress: 0,
    failures: {},
    endingCode: "COMPLETED",
    cost: 0,
    seconds: 0,
    modelCalls: 0,
  });
  const step = (over: Partial<JournalStep>): JournalStep => ({
    type: "click",
    ...over,
  });
  const evidenceWith = (
    steps: JournalStep[],
    browserId?: string,
  ): Evidence => ({
    appId: SAFARI,
    journal: { ...emptyJournal(), steps, actions: steps.length },
    parameters: {
      token: "benchnoteab12",
      ...(browserId ? { browserId } : {}),
    },
  });

  it("names every browser once: the same ids in BROWSER_APPS, the executables, the names and the preference, Safari then Chrome first", () => {
    const ids = [...BROWSER_APPS].sort();
    expect(Object.keys(BROWSER_NAMES).sort()).toEqual(ids);
    expect(Object.keys(BROWSER_EXECUTABLES).sort()).toEqual(ids);
    expect([...BROWSER_PREFERENCE].sort()).toEqual(ids);
    expect(BROWSER_PREFERENCE.slice(0, 2)).toEqual([SAFARI, CHROME]);
    // open_app takes a display name: never a path or a bundle id.
    for (const name of Object.values(BROWSER_NAMES))
      expect(name).toMatch(/^[A-Z][A-Za-z ]+$/);
  });

  it("sees a browser's main process and not its helpers, apart from the document applications", () => {
    const ps = [
      "  201 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "  202 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/140.0.0.0/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer",
      "  203 /System/Cryptexes/App/System/Applications/Safari.app/Contents/MacOS/Safari",
      "  204 /Applications/Safari Technology Preview.app/Contents/MacOS/Safari Technology Preview",
      "  205 /System/Applications/TextEdit.app/Contents/MacOS/TextEdit",
      "  206 /System/Library/CoreServices/Finder.app/Contents/MacOS/Finder",
    ].join("\n");
    expect([...runningApps(ps)].sort()).toEqual([
      SAFARI,
      "com.apple.SafariTechnologyPreview",
      TEXT,
      CHROME,
    ]);
    expect([...runningDocumentApps(ps)]).toEqual([TEXT]);
    expect(runningApps(undefined).size).toBe(0);
    // What a person opens during a wait counts, browsers included.
    expect(
      [
        ...openedByPerson(
          { first: false, sawInput: true },
          ps,
          new Set([TEXT]),
        ),
      ].sort(),
    ).toEqual([SAFARI, "com.apple.SafariTechnologyPreview", CHROME]);
  });

  it("chooses the browser that is not the person's: Safari when Chrome is open, Chrome when Safari is, and skips only when every one is in use", () => {
    const task = byTaskId("browser-nav-chain");
    expect(namesBrowser(task)).toBe(true);
    const installed = new Set(["com.apple.finder", SAFARI, CHROME]);
    const chrome = new Set([CHROME]);
    expect(chooseBrowser(task, { installed, running: chrome })).toEqual({
      id: SAFARI,
      name: "Safari",
    });
    expect(
      startSkipDetail(task, { installed, running: chrome }),
    ).toBeUndefined();
    expect(
      chooseBrowser(task, { installed, running: new Set([SAFARI]) }),
    ).toEqual({ id: CHROME, name: "Google Chrome" });
    // Neither running: Safari, first in the preference.
    expect(chooseBrowser(task, { installed, running: new Set() })?.id).toBe(
      SAFARI,
    );
    expect(chooseBrowser(task, { installed })?.id).toBe(SAFARI);
    // Both open with unknown windows: nothing free, and the skip names both.
    const both = new Set([SAFARI, CHROME]);
    expect(chooseBrowser(task, { installed, running: both })).toBeUndefined();
    expect(startSkipDetail(task, { installed, running: both })).toEqual({
      code: "APPS_OPEN",
      apps: [SAFARI, CHROME],
    });
    expect(startSkip(task, { installed, running: both })).toBe("APPS_OPEN");
    // Only Chrome installed, and open.
    expect(
      chooseBrowser(task, {
        installed: new Set(["com.apple.finder", CHROME]),
        running: chrome,
      }),
    ).toBeUndefined();
    // Spotlight silent: only Safari and what is running are known to exist,
    // so no third browser is ever named.
    expect(chooseBrowser(task, { running: both })).toBeUndefined();
    expect(chooseBrowser(task, { running: chrome })?.id).toBe(SAFARI);
    // Both open, but Safari shows only fixture pages (the last attempt's)
    // or no window at all: Safari. Safari with the person's window: Chrome
    // when Chrome has none.
    expect(
      chooseBrowser(task, {
        installed,
        running: both,
        windows: { [SAFARI]: { windows: 2, foreign: 0 } },
      })?.id,
    ).toBe(SAFARI);
    expect(
      chooseBrowser(task, {
        installed,
        running: both,
        windows: { [SAFARI]: { windows: 0, foreign: 0 } },
      })?.id,
    ).toBe(SAFARI);
    expect(
      chooseBrowser(task, {
        installed,
        running: both,
        windows: {
          [SAFARI]: { windows: 1, foreign: 1 },
          [CHROME]: { windows: 0, foreign: 0 },
        },
      })?.id,
    ).toBe(CHROME);
    // No browser installed at all: the older skip.
    expect(
      startSkip(task, {
        installed: new Set(["com.apple.finder"]),
        running: both,
      }),
    ).toBe("APP_NOT_INSTALLED");
    // A smoke task only opens its application; a long task that does not
    // name the browser is not kept by one either.
    expect(
      startSkip(byTaskId("browser-open"), { installed, running: both }),
    ).toBeUndefined();
    const unnamed = { ...task, instruction: "In the browser, go to {site}." };
    expect(appsOpen(unnamed, { installed, running: both })).toEqual([]);
    // A task with no browser gets no choice.
    expect(
      chooseBrowser(byTaskId("text-append-line"), { installed }),
    ).toBeUndefined();
  });

  it("lets an application an earlier attempt left open run when it shows only benchmark windows or none, and names what is open otherwise", () => {
    const running = new Set([TEXT]);
    const text = byTaskId("text-append-line");
    expect(startSkipDetail(text, { running })).toEqual({
      code: "APPS_OPEN",
      apps: [TEXT],
    });
    expect(
      startSkipDetail(text, { running, windows: { [TEXT]: undefined } })?.code,
    ).toBe("APPS_OPEN");
    expect(
      startSkipDetail(text, {
        running,
        windows: { [TEXT]: { windows: 1, foreign: 1 } },
      }),
    ).toEqual({ code: "APPS_OPEN", apps: [TEXT] });
    expect(
      startSkipDetail(text, {
        running,
        windows: { [TEXT]: { windows: 2, foreign: 0 } },
      }),
    ).toBeUndefined();
    expect(
      startSkipDetail(text, {
        running,
        windows: { [TEXT]: { windows: 0, foreign: 0 } },
      }),
    ).toBeUndefined();
    expect(safeOpen(TEXT, {})).toBe(false);
    // Two applications open, one of them the benchmark's: the line names
    // the other only.
    expect(
      startSkipDetail(byTaskId("multi-folder-note-event"), {
        running: new Set([TEXT, "com.apple.iCal"]),
        windows: { [TEXT]: { windows: 1, foreign: 0 } },
      }),
    ).toEqual({ code: "APPS_OPEN", apps: ["com.apple.iCal"] });
    // Music keeps its one window, titled Music: not the benchmark's.
    expect(
      startSkipDetail(byTaskId("media-search-library"), {
        running: new Set(["com.apple.Music"]),
        windows: { "com.apple.Music": { windows: 1, foreign: 1 } },
      }),
    ).toEqual({ code: "APPS_OPEN", apps: ["com.apple.Music"] });
    expect(skipRemedy({ code: "APPS_OPEN", apps: [TEXT] })).toBe(
      `${REMEDY.APPS_OPEN} Open now: ${TEXT}.`,
    );
    expect(skipRemedy({ code: "FIXTURE_PORT" })).toBe(REMEDY.FIXTURE_PORT);
    // The night of 20260919-0429: TextEdit left running by the cycle
    // before, Chrome the person's. Every task listing TextEdit (the ten
    // that cycle skipped, and recovery-missing-file) is kept and named; no
    // browser task is, since Safari is free.
    const facts = { running: new Set([TEXT, CHROME]) };
    const details = startSkipDetails(LONG_CATALOGUE, facts);
    expect(startSkips(LONG_CATALOGUE, facts)).toEqual(
      new Map([...details].map(([id, d]) => [id, d.code])),
    );
    expect(details.size).toBe(11);
    for (const [id, d] of details) {
      expect(d, id).toEqual({ code: "APPS_OPEN", apps: [TEXT] });
      expect(byTaskId(id).apps, id).toContain(TEXT);
    }
    // With TextEdit's windows read as the last attempt's, nothing is kept.
    expect(
      startSkips(LONG_CATALOGUE, {
        ...facts,
        windows: { [TEXT]: { windows: 3, foreign: 0 } },
      }).size,
    ).toBe(0);
  });

  it("asks System Events for window counts only, never a title, and reads the answer or says it cannot", async () => {
    const script = windowScript(TEXT);
    expect(script).toContain('tell application "System Events"');
    expect(script).toContain(`bundle identifier is "${TEXT}"`);
    expect(script).toContain('does not contain "benchnote"');
    expect(script).toContain(
      'return (total as text) & " " & (foreign as text)',
    );
    expect(script).not.toMatch(
      /tell application "TextEdit"|do shell script|quit/,
    );
    expect(() => windowScript('x" & (do shell script "id")')).toThrow();
    expect(parseWindowFacts("2 0\n")).toEqual({ windows: 2, foreign: 0 });
    expect(parseWindowFacts("0 0")).toEqual({ windows: 0, foreign: 0 });
    expect(parseWindowFacts("1 2")).toBeUndefined();
    expect(parseWindowFacts(undefined)).toBeUndefined();
    expect(
      parseWindowFacts(
        "execution error: Not authorized to send Apple events to System Events. (-1743)",
      ),
    ).toBeUndefined();
    const calls: string[][] = [];
    const facts = await readWindowFacts(
      async (command, args) => {
        calls.push([command, ...args]);
        return args[1].includes("com.apple.Music") ? undefined : "3 1";
      },
      [TEXT, "com.apple.Music"],
    );
    expect(calls.map((call) => call[0])).toEqual(["osascript", "osascript"]);
    expect(calls[0][1]).toBe("-e");
    expect(facts).toEqual({
      [TEXT]: { windows: 3, foreign: 1 },
      "com.apple.Music": undefined,
    });
    // Only the running applications a long task lists are asked: never
    // Calculator, never a smoke task's, never what no selected task needs.
    expect(
      appsToWatch(
        [
          byTaskId("text-append-line"),
          byTaskId("calculator-open"),
          byTaskId("browser-nav-chain"),
        ],
        [TEXT, "com.apple.calculator", CHROME, "com.apple.Notes"],
      ),
    ).toEqual([TEXT, CHROME]);
  });

  it("asks about windows only when told to, and then lets the last night's TextEdit run", async () => {
    const calls: string[] = [];
    const run = async (command: string, args: string[]) => {
      calls.push(command);
      if (command === "mdfind")
        return args[0].includes("com.apple.finder")
          ? "/System/Library/CoreServices/Finder.app"
          : args[0].includes(`${TEXT}'`)
            ? "/System/Applications/TextEdit.app"
            : args[0].includes(`${SAFARI}'`)
              ? "/Applications/Safari.app"
              : args[0].includes(`${CHROME}'`)
                ? "/Applications/Google Chrome.app"
                : "";
      if (command === "ps")
        return [
          "  101 /System/Applications/TextEdit.app/Contents/MacOS/TextEdit",
          "  102 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        ].join("\n");
      if (command === "osascript") return "2 0";
      return undefined;
    };
    const tasks = [
      byTaskId("text-append-line"),
      byTaskId("browser-form-submit-local"),
    ];
    const source = { run, home: "/Users/someone", benchRootDirty: () => false };
    const quiet = await readStartFacts(tasks, source);
    expect(calls).not.toContain("osascript");
    expect(quiet.windows).toBeUndefined();
    expect([...quiet.running!].sort()).toEqual([TEXT, CHROME]);
    // Without a look at its windows TextEdit counts as the person's; Chrome
    // only costs the browser task its first choice.
    expect(startSkipDetails(tasks, quiet)).toEqual(
      new Map([["text-append-line", { code: "APPS_OPEN", apps: [TEXT] }]]),
    );
    expect(chooseBrowser(tasks[1], quiet)?.name).toBe("Safari");
    calls.length = 0;
    const asked = await readStartFacts(tasks, { ...source, appleEvents: true });
    expect(calls.filter((command) => command === "osascript")).toHaveLength(2);
    expect(asked.windows).toEqual({
      [TEXT]: { windows: 2, foreign: 0 },
      [CHROME]: { windows: 2, foreign: 0 },
    });
    expect(startSkips(tasks, asked).size).toBe(0);
  });

  it("holds a run to the browser the harness named: another browser in an acting step, a launch or an open fails it", () => {
    const passed: Grade = { status: "passed", checks: { ok: true } };
    const safariOnly = [
      step({
        type: "open_app",
        appId: "com.apple.finder",
        launchedAppId: SAFARI,
      }),
      step({ type: "type_text", appId: SAFARI }),
    ];
    expect(withBrowserCheck(passed, evidenceWith(safariOnly, SAFARI))).toEqual({
      status: "passed",
      checks: { ok: true, browser: true },
    });
    // Chrome in front of a capture is nothing the run did; a click in it is.
    expect(
      withBrowserCheck(
        passed,
        evidenceWith([step({ type: "capture", appId: CHROME })], SAFARI),
      ).checks.browser,
    ).toBe(true);
    expect(
      withBrowserCheck(passed, evidenceWith([step({ appId: CHROME })], SAFARI)),
    ).toEqual({
      status: "failed",
      reason: "WRONG_BROWSER",
      checks: { ok: true, browser: false },
    });
    expect(
      withBrowserCheck(
        passed,
        evidenceWith(
          [
            step({
              type: "open_app",
              appId: "com.apple.finder",
              launchedAppId: CHROME,
            }),
          ],
          SAFARI,
        ),
      ).status,
    ).toBe("failed");
    expect(
      withBrowserCheck(
        passed,
        evidenceWith(
          [
            step({
              type: "open_file",
              appId: "com.apple.finder",
              openedAppId: CHROME,
            }),
          ],
          SAFARI,
        ),
      ).status,
    ).toBe("failed");
    // A failure keeps its own reason; an unknown stays unknown; no choice,
    // no check.
    const failed: Grade = {
      status: "failed",
      checks: { ok: false },
      reason: "FACT_NOT_NOTED",
    };
    expect(
      withBrowserCheck(failed, evidenceWith([step({ appId: CHROME })], SAFARI)),
    ).toEqual({
      status: "failed",
      reason: "FACT_NOT_NOTED",
      checks: { ok: false, browser: false },
    });
    const unknown: Grade = {
      status: "unknown",
      checks: {},
      reason: "NO_ACCESSIBILITY",
    };
    expect(
      withBrowserCheck(
        unknown,
        evidenceWith([step({ appId: CHROME })], SAFARI),
      ),
    ).toBe(unknown);
    expect(
      withBrowserCheck(passed, evidenceWith([step({ appId: CHROME })])),
    ).toBe(passed);
    expect(chosenBrowsers({ parameters: { browserId: SAFARI } })).toEqual([
      SAFARI,
    ]);
    expect(chosenBrowsers({ parameters: {} })).toEqual(BROWSER_APPS);
    expect(chosenBrowsers({ parameters: { browserId: TEXT } })).toEqual(
      BROWSER_APPS,
    );
    // gradeTask applies it to every task, and the browser's name is no marker.
    const task = testTask({ instruction: "In {browser}, open Calculator" });
    expect(
      gradeTask(task, {
        ...evidenceWith([step({ appId: CHROME })], SAFARI),
        appId: CALC,
      }),
    ).toMatchObject({ status: "failed", reason: "WRONG_BROWSER" });
    expect(
      markerValues({
        token: "benchnoteab12",
        browser: "Google Chrome",
        browserId: CHROME,
        site: "127.0.0.1:47831/benchnoteab12",
      }),
    ).toEqual(["benchnoteab12", "127.0.0.1:47831/benchnoteab12"]);
  });

  it("fills {browser} with the preflight's choice and grades the run in that browser only", async () => {
    const { controller } = fakeController();
    const seen: string[] = [];
    const client = {
      next: async (o: Observation): Promise<ProviderResult> => {
        seen.push(o.task);
        return {
          usage,
          action: { type: "done", summary: "ok", frame_id: o.frame.id },
        };
      },
    };
    const { deps } = attemptDeps(controller, {
      clients: { [CELL.cell]: client },
    });
    const chosen = { id: SAFARI, name: "Safari" };
    const named = await runAttempt(
      deps,
      CELL,
      testTask({ instruction: "In {browser}, open Calculator" }),
      1,
      { ...caps, browser: chosen },
    );
    expect(seen[0]).toBe("In Safari, open Calculator");
    expect(named.status).toBe("passed");
    expect(named.checks.browser).toBe(true);
    // A task that does not name the browser is not held to one.
    seen.length = 0;
    const plain = await runAttempt(deps, CELL, testTask(), 1, {
      ...caps,
      browser: chosen,
    });
    expect(seen[0]).toBe("Open Calculator");
    expect(plain.checks.browser).toBeUndefined();
  });

  it("says which application kept a skipped attempt from running, by bundle id only", () => {
    const skipped = row({
      status: "unknown",
      reason: "APPS_OPEN",
      runStatus: "skipped",
      endingCode: "SKIPPED",
      openApps: [TEXT],
    });
    expect(renderTable([skipped])).toMatch(
      /SKIPPED\s+APPS_OPEN com\.apple\.TextEdit$/m,
    );
    const clean = contentFree({
      ...skipped,
      openApps: [TEXT, "Untitled 3 ~/Documents/plan.txt"],
    });
    expect(clean.openApps).toEqual([TEXT]);
    expect(contentFree(row({})).openApps).toBeUndefined();
  });
});

describe("approval in context", () => {
  const task = { apps: ["com.apple.TextEdit"] };
  it("approves nothing it did not before, and less", () => {
    const view = { appId: "com.apple.TextEdit", modal: false };
    expect(approvalInContext(task, "Save these changes?", view)).toBe(true);
    expect(approvalInContext(task, REPLACE_REASON, view)).toBe(true);
    // Another application in front, or no frontmost reading at all.
    expect(
      approvalInContext(task, "Save these changes?", {
        ...view,
        appId: "com.apple.finder",
      }),
    ).toBe(false);
    expect(approvalInContext(task, "Save these changes?", {})).toBe(false);
    // The frame the action was proposed on showed another application.
    expect(
      approvalInContext(task, "Save these changes?", {
        ...view,
        frameAppId: "com.apple.Notes",
      }),
    ).toBe(false);
    // A sheet or dialog in front, or none known either way, for Replace.
    expect(
      approvalInContext(task, REPLACE_REASON, { ...view, modal: true }),
    ).toBe(false);
    expect(
      approvalInContext(task, REPLACE_REASON, { appId: "com.apple.TextEdit" }),
    ).toBe(false);
    // A sheet does not block a plain save question.
    expect(
      approvalInContext(task, "Save these changes?", { ...view, modal: true }),
    ).toBe(true);
    // The pointer is on a browser window behind TextEdit, showing a real
    // site: that site's Save is not TextEdit's.
    expect(
      approvalInContext(task, "Save these changes?", {
        ...view,
        targetAppId: "com.google.Chrome",
        targetWebHost: "github.com",
      }),
    ).toBe(false);
    expect(
      approvalInContext(task, "Save these changes?", {
        ...view,
        targetAppId: "com.google.Chrome",
      }),
    ).toBe(false);
    // Another process drawing TextEdit's own Save panel is not held to
    // the task's applications.
    expect(
      approvalInContext(task, "Save these changes?", {
        ...view,
        targetAppId: "com.apple.appkit.xpc.openAndSavePanelService",
      }),
    ).toBe(true);
    // A reason with no scope is never approved, whatever the task lists.
    expect(approvalInContext(task, "Archive this item?", view)).toBe(false);
  });

  const long = (id: string) => {
    const found = LONG_CATALOGUE.find((task) => task.id === id);
    if (!found) throw new Error(id);
    return found;
  };
  const CHROME = "com.google.Chrome";

  it("approves a Submit only in a browser on the fixture host", () => {
    const task = long("browser-form-submit-local");
    expect(approvesPrompt(task, SUBMIT_REASON, true)).toBe(true);
    const local = { appId: CHROME, modal: false, domain: FIXTURE_HOST };
    expect(approvalInContext(task, SUBMIT_REASON, local)).toBe(true);
    expect(
      approvalInContext(task, SUBMIT_REASON, {
        ...local,
        targetWebHost: FIXTURE_HOST,
      }),
    ).toBe(true);
    // A real site the person's browser restored: OAuth's Authorize, a
    // Join or a Confirm all ask this question.
    expect(
      approvalInContext(task, SUBMIT_REASON, {
        ...local,
        domain: "github.com",
      }),
    ).toBe(false);
    // The page in front is the fixture's, the control under the pointer
    // sits in a frame of another site.
    expect(
      approvalInContext(task, SUBMIT_REASON, {
        ...local,
        targetWebHost: "accounts.example.com",
      }),
    ).toBe(false);
    // localhost is loopback too, but not the host the fixture was given.
    expect(
      approvalInContext(task, SUBMIT_REASON, { ...local, domain: "localhost" }),
    ).toBe(false);
    // No host known in a browser: no.
    expect(
      approvalInContext(task, SUBMIT_REASON, { appId: CHROME, modal: false }),
    ).toBe(false);
    // The frame the model acted on showed another application.
    expect(
      approvalInContext(task, SUBMIT_REASON, {
        ...local,
        frameAppId: "com.apple.finder",
      }),
    ).toBe(false);
  });

  it("approves a Save for the browser-and-TextEdit tasks only with TextEdit in front", () => {
    for (const id of [
      "research-fact-note",
      "research-compare-note",
      "research-list-note",
      "multi-page-calc-note",
    ]) {
      const task = long(id);
      expect(approvesPrompt(task, "Save these changes?", true), id).toBe(true);
      // A site's own Save button (account settings), fixture page or not.
      for (const domain of ["github.com", FIXTURE_HOST, undefined])
        expect(
          approvalInContext(task, "Save these changes?", {
            appId: CHROME,
            modal: false,
            ...(domain ? { domain } : {}),
          }),
          `${id} ${domain}`,
        ).toBe(false);
      expect(
        approvalInContext(task, "Save these changes?", {
          appId: TEXTEDIT,
          frameAppId: TEXTEDIT,
          modal: false,
        }),
        id,
      ).toBe(true);
    }
  });

  it("gives every routine reason a task lists a scope one of its apps is in", () => {
    for (const task of [...CATALOGUE, ...LONG_CATALOGUE, ...MARKET_CATALOGUE])
      for (const reason of task.approve ?? []) {
        const scope = APPROVAL_APPS[reason];
        expect(scope, `${task.id}: ${reason}`).toBeDefined();
        expect(
          task.apps.some((id) => scope.includes(id)),
          `${task.id}: ${reason}`,
        ).toBe(true);
      }
  });
});

describe("task skips in the cycle loop", () => {
  it("records a skip as a row without waiting for the gate, and says why", async () => {
    const observed: string[] = [];
    let gateReads = 0;
    const { run, lines, ran } = loop({
      gate: () => {
        gateReads++;
        return { tapIdleSeconds: 10_000 };
      },
      skipFor: (entry) =>
        entry.taskId === "a" ? "NO_AGENDA_ACCESS" : undefined,
      observe: (r) => observed.push(`${r.taskId} ${r.reason ?? r.status}`),
    });
    const outcome = await run;
    expect(ran.every((r) => r.index % 1 === 0)).toBe(true);
    const bIndexes = buildPlan(["m1", "m2"], ["a", "b"], 1, 1)
      .filter((e) => e.taskId === "b")
      .map((e) => e.index);
    expect(ran.map((r) => r.index)).toEqual(bIndexes);
    // One gate read per attempt that ran; the skips never waited for idle.
    expect(gateReads).toBe(bIndexes.length);
    const skips = outcome.results.filter(
      (r) => r.reason === "NO_AGENDA_ACCESS",
    );
    expect(skips).toHaveLength(2);
    expect(skips.every((r) => r.runStatus === "skipped")).toBe(true);
    expect(
      lines.filter(
        (l) => l.kind === "attempt" && l.reason === "NO_AGENDA_ACCESS",
      ),
    ).toHaveLength(2);
    expect(observed.filter((o) => o === "a NO_AGENDA_ACCESS")).toHaveLength(2);
    expect(observed.filter((o) => o === "b passed")).toHaveLength(2);
    expect(outcome.notRun).toBe(0);
    // Outside every rate: the model never got these attempts.
    const totals = aggregate(outcome.results);
    expect(totals.ran).toBe(2);
    expect(totals.skipped).toBe(2);
  });

  it("reads this Mac again after the first gate pass and after a wait that saw a person, before the attempt", async () => {
    const start = 1_000_000;
    // The person started the cycle ten seconds ago and kept working.
    let touchedAt = start - 10_000;
    const plan = buildPlan(["m1", "m2"], ["a", "b"], 1, 1);
    const first = plan[0].taskId;
    const passes: { first: boolean; sawInput: boolean }[] = [];
    const skips = new Map<string, string>();
    let attempts = 0;
    const { run, ran } = loop({
      gate: (now) => ({ tapIdleSeconds: (now - touchedAt) / 1000 }),
      afterGate: async (pass) => {
        passes.push(pass);
        // While the gate waited, they opened the first task's application.
        if (pass.first) skips.set(first, "APPS_OPEN");
      },
      skipFor: (entry) => skips.get(entry.taskId),
      attempt: (_, __, now) => {
        // Back at the Mac five seconds after the first attempt ends.
        if (attempts++ === 0) touchedAt = now + 5000;
        return {};
      },
    });
    const outcome = await run;
    // The skip found at the first pass applies to the attempt that pass
    // was for: nothing of that task ran.
    expect(ran.map((r) => plan[r.index].taskId)).not.toContain(first);
    expect(
      outcome.results
        .filter((r) => r.reason === "APPS_OPEN")
        .map((r) => r.planIndex),
    ).toEqual(plan.filter((e) => e.taskId === first).map((e) => e.index));
    // One read per pass: the first, one straight through, one after the
    // person came back.
    expect(passes).toEqual([
      { first: true, sawInput: true },
      { first: false, sawInput: false },
      { first: false, sawInput: true },
    ]);
  });

  it("asks again after the gate, when the clock may have crossed midnight", async () => {
    const { run, ran } = loop({
      gate: () => ({ tapIdleSeconds: 10_000 }),
      skipFor: (entry, gateReads) =>
        entry.index === 0 && gateReads > 0 ? "DAY_BOUNDARY" : undefined,
    });
    const outcome = await run;
    expect(ran.map((r) => r.index)).toEqual([1, 2, 3]);
    expect(outcome.results.find((r) => r.planIndex === 0)?.reason).toBe(
      "DAY_BOUNDARY",
    );
  });

  it("runs a task skip again on resume, and the run replaces the skip", () => {
    const plan = buildPlan(["m1"], ["a"], 1, 1);
    const line = (r: AttemptResult): LedgerLine => ({
      kind: "attempt",
      at: "2026-09-18T01:00:00.000Z",
      ...r,
    });
    for (const reason of TASK_SKIPS) {
      const skip = row({
        planIndex: 0,
        taskId: "a",
        cell: "m1",
        status: "unknown",
        reason,
        runStatus: "skipped",
        cost: 0,
      });
      expect(rerunnable(skip), reason).toBe(true);
      expect(remaining(plan, [line(skip)], 1).map((e) => e.index)).toEqual([0]);
      const later = row({ planIndex: 0, taskId: "a", cell: "m1" });
      expect(ledgerResults([line(skip), line(later)])).toEqual([later]);
    }
  });

  it("finds the fewest nights a long plan fits in, or says it never will", () => {
    const tasks = new Map([
      ["a", { maxSeconds: 900, maxActions: 80 }],
      ["b", { maxSeconds: 900, maxActions: 80 }],
    ]);
    // 18 attempts of 240 s + 20 s overhead + 8 s cooldown = 268 s each.
    const plan = buildPlan(["m1", "m2", "m3"], ["a", "b"], 3, 7);
    expect(shardsNeeded(plan, tasks, 8, 4 * 3600)).toBe(1);
    const hour = shardsNeeded(plan, tasks, 8, 3600);
    expect(hour).toBe(2);
    for (let index = 1; index <= 2; index++)
      expect(
        fitsTimeBox(
          estimateSeconds(shardOf(plan, { index, count: 2 }), tasks, 8),
          3600,
        ),
      ).toBe(true);
    expect(fitsTimeBox(estimateSeconds(plan, tasks, 8), 3600)).toBe(false);
    // One (task, repeat) group of three models is 804 s: 15 minutes never fit.
    expect(shardsNeeded(plan, tasks, 8, 900)).toBeUndefined();
  });
});

describe("suites in the cycle", () => {
  it("hashes exactly the selected suites' tasks and sources", () => {
    const smoke = selectSuite(undefined, "smoke").tasks;
    const long = selectSuite(undefined, "long").tasks;
    const market = selectSuite(undefined, "market").tasks;
    const all = selectSuite(undefined, "all").tasks;
    expect(smoke).toEqual(CATALOGUE);
    expect(graderFiles(smoke)).toEqual([
      "src/gym/bench/graders.ts",
      "src/gym/bench/catalogue.ts",
    ]);
    expect(graderFiles(long)).toEqual([
      "src/gym/bench/graders.ts",
      "src/gym/bench/catalogue-long.ts",
      "src/gym/bench/fixtures.ts",
      "src/gym/bench/readers.ts",
    ]);
    expect(graderFiles(market)).toEqual([
      "src/gym/bench/graders.ts",
      "src/gym/bench/catalogue-long.ts",
      "src/gym/bench/catalogue-market.ts",
      "src/gym/bench/fixtures-market.ts",
      "src/gym/bench/fixtures.ts",
      "src/gym/bench/readers.ts",
    ]);
    expect(graderFiles(all)).toEqual([
      "src/gym/bench/graders.ts",
      "src/gym/bench/catalogue.ts",
      "src/gym/bench/catalogue-long.ts",
      "src/gym/bench/catalogue-market.ts",
      "src/gym/bench/fixtures-market.ts",
      "src/gym/bench/fixtures.ts",
      "src/gym/bench/readers.ts",
    ]);
    const hash = (tasks: BenchTask[], edit?: string) =>
      catalogueHash(
        tasks,
        graderFiles(tasks).map(
          (file) =>
            readFileSync(join(root, file), "utf8") +
            (file === edit ? "\n// edited\n" : ""),
        ),
      );
    expect(
      new Set([hash(smoke), hash(long), hash(market), hash(all)]).size,
    ).toBe(4);
    // A long-suite edit leaves the smoke metric alone and moves the long one,
    // and the market one, whose graders are built from the long catalogue.
    expect(hash(smoke, "src/gym/bench/catalogue-long.ts")).toBe(hash(smoke));
    expect(hash(smoke, "src/gym/bench/readers.ts")).toBe(hash(smoke));
    expect(hash(market, "src/gym/bench/catalogue-long.ts")).not.toBe(
      hash(market),
    );
    expect(hash(long, "src/gym/bench/fixtures.ts")).not.toBe(hash(long));
    expect(hash(long, "src/gym/bench/readers.ts")).not.toBe(hash(long));
    expect(hash(smoke, "src/gym/bench/graders.ts")).not.toBe(hash(smoke));
  });
});

describe("probe verdicts", () => {
  const A = "openai:gpt-5.4-mini";
  // `hits` attempts carry the class under test as their grade reason.
  const rows = (n: number, hits: number, other = 0, otherCode = "WRONG_ITEM") =>
    many(n, (i) =>
      i < hits
        ? failedRow({ planIndex: i, attempt: i + 1, reason: "NOT_ENTERED" })
        : i < hits + other
          ? failedRow({ planIndex: i, attempt: i + 1, reason: otherCode })
          : row({ planIndex: i, attempt: i + 1 }),
    );
  const judge = (
    before: AttemptResult[],
    after: AttemptResult[],
    templatesMatch = true,
  ) =>
    compareProbe(
      cycleOf({
        id: "probe",
        gitRev: "fix1234",
        catalogueHash: "h-fix",
        results: after,
      }),
      // The baseline ran another revision and catalogue: a probe compares
      // across them by design, which compareCycles alone refuses.
      cycleOf({
        id: "base",
        gitRev: "old1234",
        catalogueHash: "h-old",
        dirty: true,
        results: before,
      }),
      "NOT_ENTERED",
      {
        templatesMatch,
        classes: probeClassRates("NOT_ENTERED"),
        owner: ownerOf,
      },
    );

  it("passes when the class fell and nothing else got worse", () => {
    const verdict = judge(rows(36, 20), rows(36, 3));
    expect(verdict.comparison.comparable).toBe(true);
    expect(verdict.before).toMatchObject({ k: 20, n: 36 });
    expect(verdict.after).toMatchObject({ k: 3, n: 36 });
    expect(verdict.p).toBeLessThan(0.05);
    expect(verdict.reasons).toEqual([]);
    expect(verdict.pass).toBe(true);
    // Gone in 36 or more attempts passes whatever the baseline's rate.
    expect(judge(rows(36, 2), rows(36, 0)).pass).toBe(true);
  });

  it("judges a probe against one night of a sharded plan on its own tasks", () => {
    // Long-suite baselines are shards; the probe is its own plan. The slice
    // rule that keeps sibling nights apart must not switch off the probe's
    // model and class checks.
    const model = compareProbe(
      cycleOf({
        id: "probe",
        gitRev: "fix1234",
        results: rows(36, 0, 20, "LOOPED"),
      }),
      cycleOf({
        id: "night1",
        gitRev: "old1234",
        shard: "1/3",
        designHash: "d-night1",
        results: rows(36, 6),
      }),
      "NOT_ENTERED",
      {
        templatesMatch: true,
        classes: probeClassRates("NOT_ENTERED"),
        owner: ownerOf,
      },
    );
    expect(model.comparison.comparable).toBe(true);
    expect(model.reasons).toContainEqual({ code: "MODEL_REGRESSED", key: A });
  });

  it("fails a class that did not move, and says why", () => {
    const verdict = judge(rows(36, 12), rows(36, 11));
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons).toEqual([{ code: "CLASS_NOT_IMPROVED" }]);
  });

  it("fails when another agent-owned class or a model's success regressed", () => {
    const worse = judge(rows(36, 20, 1), rows(36, 2, 12));
    expect(worse.reasons).toContainEqual({
      code: "OTHER_CLASS_REGRESSED",
      key: "WRONG_ITEM",
    });
    expect(worse.pass).toBe(false);
    const model = judge(rows(36, 6), rows(36, 0, 20, "LOOPED"));
    expect(model.after.k).toBe(0);
    expect(model.reasons).toContainEqual({ code: "MODEL_REGRESSED", key: A });
    expect(model.pass).toBe(false);
  });

  it("refuses to judge changed tasks and counts only the probe's own tasks", () => {
    expect(judge(rows(36, 20), rows(36, 3), false).reasons).toContainEqual({
      code: "TASKS_CHANGED",
    });
    // The baseline's other tasks are not in the probe's denominator.
    const before = [
      ...rows(36, 20),
      ...many(36, (i) => row({ planIndex: 100 + i, taskId: "browser-open" })),
    ];
    expect(judge(before, rows(36, 3)).before).toMatchObject({ k: 20, n: 36 });
  });

  /* The two cross-revision rules: successor families and NOW_GRADED. */

  const CELL = "openai:gpt-5.4-mini";
  // A failed row as results.json stores one: no false done unless said.
  const ended = (over: Partial<AttemptResult>) =>
    failedRow({ falseDone: false, checks: {}, ...over });
  // A baseline of 19 attempts on one graded task, `hits` carrying the
  // probed class; the after arm of 14, the shape of the real probe.
  const arm = (
    n: number,
    hits: number,
    extra: (i: number) => AttemptResult | undefined,
  ) =>
    many(n, (i) => {
      const own = extra(i);
      if (own) return own;
      return i < hits
        ? ended({ planIndex: i, attempt: i + 1, reason: "NOT_ENTERED" })
        : row({ planIndex: i, attempt: i + 1 });
    });
  const judgeTasks = (
    before: AttemptResult[],
    after: AttemptResult[],
    taskIds: string[],
  ) =>
    compareProbe(
      cycleOf({
        id: "probe",
        gitRev: "fix1234",
        catalogueHash: "h-fix",
        taskIds,
        results: after,
      }),
      cycleOf({
        id: "base",
        gitRev: "old1234",
        catalogueHash: "h-old",
        taskIds,
        results: before,
      }),
      "NOT_ENTERED",
      {
        templatesMatch: true,
        classes: probeClassRates("NOT_ENTERED"),
        owner: ownerOf,
      },
    );
  const STUCK_FAMILY = familyKey("STUCK_LOOP", SUPERSEDES.STUCK_LOOP);

  it("judges a successor ending with its predecessors: rising while they fall is neutral", () => {
    // Before: twelve runs out of budget. After: the same twelve loops now
    // fail as STUCK_LOOP (cc1c637) and no run reaches the budget.
    const before = arm(36, 20, (i) =>
      i < 12
        ? ended({
            planIndex: i,
            attempt: i + 1,
            reason: "NOT_ENTERED",
            runStatus: "failed",
            endingCode: "ACTION_BUDGET",
          })
        : undefined,
    );
    const after = arm(36, 3, (i) =>
      i >= 3 && i < 15
        ? ended({
            planIndex: i,
            attempt: i + 1,
            reason: "WRONG_ITEM",
            runStatus: "failed",
            endingCode: "STUCK_LOOP",
          })
        : undefined,
    );
    const verdict = judge(before, after);
    const rows = verdict.comparison.regressions;
    const family = rows.find((r) => r.key === STUCK_FAMILY);
    expect(family).toMatchObject({
      scope: "class",
      before: { k: 12, n: 36 },
      after: { k: 12, n: 36 },
      verdict: "unchanged",
    });
    expect(rows.find((r) => r.key === "STUCK_LOOP")).toBeUndefined();
    // The predecessors keep their own rows (none in 36 attempts: gone).
    expect(rows.find((r) => r.key === "ACTION_BUDGET")).toMatchObject({
      before: { k: 12 },
      after: { k: 0 },
      verdict: "gone",
    });
    expect(
      verdict.reasons.filter((r) => r.code === "OTHER_CLASS_REGRESSED"),
    ).toEqual([]);
  });

  it("still fails a successor rising with its predecessors flat", () => {
    const before = arm(36, 20, (i) =>
      i < 12
        ? ended({
            planIndex: i,
            attempt: i + 1,
            reason: "NOT_ENTERED",
            runStatus: "failed",
            endingCode: "ACTION_BUDGET",
          })
        : undefined,
    );
    // Twelve out of budget as before, and twelve more stuck.
    const after = arm(36, 3, (i) =>
      i < 3
        ? ended({
            planIndex: i,
            attempt: i + 1,
            reason: "NOT_ENTERED",
            runStatus: "failed",
            endingCode: "ACTION_BUDGET",
          })
        : i < 12
          ? ended({
              planIndex: i,
              attempt: i + 1,
              reason: "WRONG_ITEM",
              runStatus: "failed",
              endingCode: "ACTION_BUDGET",
            })
          : i < 24
            ? ended({
                planIndex: i,
                attempt: i + 1,
                reason: "WRONG_ITEM",
                runStatus: "failed",
                endingCode: "STUCK_LOOP",
              })
            : undefined,
    );
    const verdict = judge(before, after);
    const family = verdict.comparison.regressions.find(
      (r) => r.key === STUCK_FAMILY,
    );
    expect(family).toMatchObject({
      before: { k: 12, n: 36 },
      after: { k: 24, n: 36 },
      verdict: "regression",
    });
    // On its own, twelve from none would read "new", which never failed a
    // probe: the family is what catches it.
    expect(verdict.reasons).toContainEqual({
      code: "OTHER_CLASS_REGRESSED",
      key: STUCK_FAMILY,
    });
    expect(verdict.pass).toBe(false);
  });

  it("reports a grade class risen only on tasks the baseline never graded as NOW_GRADED, and passes", () => {
    const tasks = ["calculator-open", "crm-entry"];
    const before = arm(19, 8, () => undefined);
    // Two of fourteen now fail RECORD_WRONG, both on a task the baseline
    // never reached: 0/19 to 2/14 is a regression by the z rule alone.
    const after = arm(14, 2, (i) =>
      i >= 2 && i < 4
        ? ended({
            planIndex: i,
            attempt: i + 1,
            taskId: "crm-entry",
            reason: "RECORD_WRONG",
          })
        : undefined,
    );
    const verdict = judgeTasks(before, after, tasks);
    expect(verdict.before).toMatchObject({ k: 8, n: 19 });
    expect(verdict.after).toMatchObject({ k: 2, n: 14 });
    expect(verdict.reasons).toEqual([
      { code: "NOW_GRADED", key: "RECORD_WRONG", tasks: ["crm-entry"] },
    ]);
    expect(verdict.pass).toBe(true);
    const wrong = verdict.comparison.regressions.find(
      (r) => r.key === "RECORD_WRONG",
    );
    expect(wrong).toMatchObject({
      before: { k: 0, n: 19 },
      after: { k: 2, n: 14 },
      verdict: "now_graded",
    });
    expect(wrong!.p).toBeLessThan(0.05);
    // Nothing in the table is a regression for the exit code.
    expect(
      verdict.comparison.regressions.filter((r) => r.verdict === "regression"),
    ).toEqual([]);
    expect(PROBE_INFORMATIONAL.has("NOW_GRADED")).toBe(true);
    expect(PROBE_INFORMATIONAL.has("OTHER_CLASS_REGRESSED")).toBe(false);
  });

  it("keeps a grade class rising on graded tasks a regression, with or without new tasks beside", () => {
    const tasks = ["calculator-open", "crm-entry"];
    // The baseline graded calculator-open (one RECORD_WRONG among its 19).
    const before = arm(19, 8, (i) =>
      i === 8
        ? ended({ planIndex: i, attempt: i + 1, reason: "RECORD_WRONG" })
        : undefined,
    );
    // Six more on the graded task, two on the never-graded one.
    const mixed = arm(14, 2, (i) =>
      i >= 2 && i < 8
        ? ended({ planIndex: i, attempt: i + 1, reason: "RECORD_WRONG" })
        : i >= 8 && i < 10
          ? ended({
              planIndex: i,
              attempt: i + 1,
              taskId: "crm-entry",
              reason: "RECORD_WRONG",
            })
          : undefined,
    );
    const verdict = judgeTasks(before, mixed, tasks);
    expect(verdict.reasons).toEqual([
      { code: "OTHER_CLASS_REGRESSED", key: "RECORD_WRONG" },
    ]);
    expect(verdict.pass).toBe(false);
    expect(
      verdict.comparison.regressions.find((r) => r.key === "RECORD_WRONG")
        ?.verdict,
    ).toBe("regression");
    // The graded task alone, no new task in sight: the old rule unchanged.
    const graded = arm(14, 2, (i) =>
      i >= 2 && i < 8
        ? ended({ planIndex: i, attempt: i + 1, reason: "RECORD_WRONG" })
        : undefined,
    );
    expect(judgeTasks(before, graded, tasks).reasons).toEqual([
      { code: "OTHER_CLASS_REGRESSED", key: "RECORD_WRONG" },
    ]);
    // A baseline attempt of the task that ran but could not be graded
    // (unknown) grades nothing: the class on it now is NOW_GRADED.
    const unread = arm(19, 8, (i) =>
      i === 18
        ? row({
            planIndex: i,
            attempt: i + 1,
            taskId: "crm-entry",
            status: "unknown",
            reason: "NO_END_STATE",
          })
        : undefined,
    );
    const fresh = arm(14, 2, (i) =>
      i >= 2 && i < 4
        ? ended({
            planIndex: i,
            attempt: i + 1,
            taskId: "crm-entry",
            reason: "RECORD_WRONG",
          })
        : undefined,
    );
    expect(judgeTasks(unread, fresh, tasks).reasons).toEqual([
      { code: "NOW_GRADED", key: "RECORD_WRONG", tasks: ["crm-entry"] },
    ]);
  });

  it("declares successors and predecessors the bench derives, each with an authored note", () => {
    const ending = (over: Partial<Parameters<typeof endingCode>[0]>) =>
      endingCode({
        runStatus: "failed",
        manualTakeover: false,
        agentHandoffs: 0,
        paused: false,
        emergencyStop: false,
        interrupted: false,
        modelFailed: false,
        ...over,
      });
    expect(Object.keys(SUPERSEDES).sort()).toEqual([
      "DELIVERABLE_MISSING",
      "MODEL_FAILED",
      "STUCK_LOOP",
    ]);
    for (const [successor, predecessors] of Object.entries(SUPERSEDES)) {
      expect(predecessors.length).toBeGreaterThan(0);
      expect(predecessors).not.toContain(successor);
      for (const code of [successor, ...predecessors]) {
        expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
        expect(noteFor(code), code).not.toBe(noteFor("UNCLASSIFIED"));
        expect(ownerOf(code), code).toBe("agent");
      }
    }
    // The successors are endings report.ts derives from the harness's counters.
    expect(ending({ message: LOOP_STUCK_MESSAGE })).toBe("STUCK_LOOP");
    expect(budgetCode(LOOP_STUCK_MESSAGE)).toBe("STUCK_LOOP");
    expect(ending({ deliverableMissing: true })).toBe("DELIVERABLE_MISSING");
    expect(ending({ modelFailed: true })).toBe("MODEL_FAILED");
    // And the predecessors: two endings, RUN_ERROR, and the grader's word.
    expect(ending({ message: "Action budget reached." })).toBe("ACTION_BUDGET");
    expect(ending({ runStatus: "cancelled", paused: true })).toBe(
      "STOPPED_WHILE_PAUSED",
    );
    expect(ending({})).toBe("RUN_ERROR");
    expect(
      failureClasses([failedRow({ falseDone: true })]).map((c) => c.code),
    ).toContain("FALSE_DONE");
    expect(SUPERSEDES.STUCK_LOOP).toEqual([
      "STOPPED_WHILE_PAUSED",
      "ACTION_BUDGET",
    ]);
    expect(SUPERSEDES.DELIVERABLE_MISSING).toEqual(["FALSE_DONE"]);
    expect(SUPERSEDES.MODEL_FAILED).toEqual(["RUN_ERROR", "FALSE_DONE"]);
    expect(STUCK_FAMILY).toBe(
      "STUCK_LOOP (+STOPPED_WHILE_PAUSED, ACTION_BUDGET)",
    );
  });

  /**
   * Probe 20260919-1952-0fb99c8 (FACT_NOT_NOTED against 20260919-1646-09c5412,
   * --autonomy all), row for row with synthetic task ids and no content: the
   * baseline's 19 attempts in the probe's scope and the probe's 14. The
   * report read FAIL with OTHER_CLASS_REGRESSED RECORD_WRONG and STUCK_LOOP
   * while the class fell 8/19 to 2/14 and success rose 1/19 to 4/14.
   */
  const realCase = () => {
    const TASKS = [
      "kpi",
      "ci",
      "booking",
      "reply",
      "mfa",
      "fold",
      "hotel",
      "shop",
      "find",
      "digest",
      "listing",
      "checkin",
      "ticket",
      "triage",
      "crm",
      "attachment",
      "chain",
      "csv",
    ];
    type Line = [
      taskId: string,
      attempt: number,
      status: AttemptResult["status"],
      runStatus: string,
      endingCode: string,
      reason: string | undefined,
      falseDone: boolean,
      loops: number,
    ];
    const lines = (arm: Line[]) =>
      arm.map(
        (
          [
            taskId,
            attempt,
            status,
            runStatus,
            endingCode,
            reason,
            falseDone,
            loops,
          ],
          i,
        ) =>
          row({
            planIndex: i,
            taskId,
            attempt,
            status,
            runStatus,
            endingCode,
            ...(reason ? { reason } : {}),
            checks: {},
            claimed: runStatus === "completed",
            falseDone,
            honestFailure: status === "failed" && !falseDone,
            loops,
          }),
      );
    const before = lines([
      [
        "kpi",
        1,
        "failed",
        "completed",
        "COMPLETED",
        "NOTE_HEADER_LOST",
        true,
        2,
      ],
      [
        "ci",
        1,
        "failed",
        "cancelled",
        "STOPPED_WHILE_PAUSED",
        "FACT_NOT_NOTED",
        false,
        2,
      ],
      [
        "booking",
        1,
        "failed",
        "cancelled",
        "STOPPED_AFTER_HANDOFF",
        "NOT_REVIEWED",
        false,
        0,
      ],
      [
        "reply",
        1,
        "failed",
        "cancelled",
        "STOPPED_AFTER_HANDOFF",
        "HANDOFF_TARGET",
        false,
        0,
      ],
      ["mfa", 1, "failed", "failed", "ACTION_BUDGET", "NO_HANDOFF", false, 2],
      ["fold", 1, "passed", "completed", "COMPLETED", undefined, false, 0],
      [
        "hotel",
        1,
        "failed",
        "cancelled",
        "STOPPED_AFTER_HANDOFF",
        "HANDOFF_SURFACE",
        false,
        0,
      ],
      ["shop", 1, "failed", "failed", "ACTION_BUDGET", "OVER_BUDGET", false, 1],
      ["shop", 2, "failed", "failed", "ACTION_BUDGET", "OVER_BUDGET", false, 1],
      [
        "find",
        2,
        "failed",
        "completed",
        "COMPLETED",
        "FACT_NOT_NOTED",
        true,
        0,
      ],
      [
        "ci",
        2,
        "failed",
        "failed",
        "ACTION_BUDGET",
        "FACT_NOT_NOTED",
        false,
        4,
      ],
      [
        "digest",
        2,
        "failed",
        "completed",
        "COMPLETED",
        "FACT_NOT_NOTED",
        true,
        3,
      ],
      [
        "hotel",
        3,
        "failed",
        "cancelled",
        "STOPPED_WHILE_PAUSED",
        "FACT_NOT_NOTED",
        false,
        2,
      ],
      [
        "ci",
        3,
        "failed",
        "failed",
        "ACTION_BUDGET",
        "FACT_NOT_NOTED",
        false,
        4,
      ],
      [
        "listing",
        3,
        "failed",
        "cancelled",
        "STOPPED_WHILE_PAUSED",
        "FACT_NOT_NOTED",
        false,
        1,
      ],
      [
        "checkin",
        3,
        "failed",
        "completed",
        "COMPLETED",
        "PASSENGER_NOT_ENTERED",
        true,
        0,
      ],
      [
        "ticket",
        3,
        "failed",
        "cancelled",
        "STOPPED_WHILE_PAUSED",
        "DRAFT_WRONG",
        false,
        1,
      ],
      [
        "triage",
        3,
        "failed",
        "cancelled",
        "STOPPED_AFTER_HANDOFF",
        "HANDOFF_TARGET",
        false,
        0,
      ],
      [
        "kpi",
        3,
        "failed",
        "failed",
        "ACTION_BUDGET",
        "FACT_NOT_NOTED",
        false,
        3,
      ],
      // Skipped, and out of the probe's tasks: neither ran nor counted.
      [
        "chain",
        3,
        "unknown",
        "skipped",
        "SKIPPED",
        "NO_AGENDA_ACCESS",
        false,
        0,
      ],
      [
        "lights",
        1,
        "failed",
        "failed",
        "ACTION_BUDGET",
        "KITCHEN_STILL_ON",
        false,
        0,
      ],
    ]);
    const after = lines([
      ["shop", 1, "failed", "failed", "STUCK_LOOP", "OVER_BUDGET", false, 2],
      [
        "hotel",
        1,
        "failed",
        "completed",
        "COMPLETED",
        "DATES_NOT_SEARCHED",
        true,
        0,
      ],
      ["checkin", 1, "passed", "completed", "COMPLETED", undefined, false, 0],
      [
        "digest",
        1,
        "failed",
        "completed",
        "COMPLETED",
        "FACT_NOT_NOTED",
        true,
        0,
      ],
      [
        "ci",
        1,
        "failed",
        "completed",
        "COMPLETED",
        "NOTE_HEADER_LOST",
        true,
        0,
      ],
      ["crm", 2, "failed", "failed", "ACTION_BUDGET", "RECORD_WRONG", false, 0],
      [
        "booking",
        2,
        "passed",
        "cancelled",
        "STOPPED_AFTER_HANDOFF",
        undefined,
        false,
        0,
      ],
      [
        "reply",
        2,
        "failed",
        "cancelled",
        "STOPPED_AFTER_HANDOFF",
        "HANDOFF_TARGET",
        false,
        0,
      ],
      ["fold", 2, "passed", "completed", "COMPLETED", undefined, false, 0],
      [
        "triage",
        3,
        "failed",
        "cancelled",
        "STOPPED_AFTER_HANDOFF",
        "HANDOFF_TARGET",
        false,
        1,
      ],
      [
        "digest",
        3,
        "failed",
        "completed",
        "COMPLETED",
        "FACT_NOT_NOTED",
        true,
        0,
      ],
      ["checkin", 3, "passed", "completed", "COMPLETED", undefined, false, 0],
      [
        "attachment",
        3,
        "failed",
        "failed",
        "ACTION_BUDGET",
        "ATTACHMENT_NOT_SAVED",
        false,
        5,
      ],
      ["crm", 3, "failed", "failed", "STUCK_LOOP", "RECORD_WRONG", false, 4],
    ]);
    const stored = (code: string, attempts: number) => [
      { code, byModel: { [CELL]: { attempts } } },
    ];
    const baseline = cycleOf({
      id: "20260919-1646-09c5412",
      gitRev: "09c5412",
      catalogueHash: "h-market-old",
      taskIds: [...TASKS, "lights"],
      results: before,
      failureClasses: stored("FACT_NOT_NOTED", 8),
    });
    const probe = cycleOf({
      id: "20260919-1952-0fb99c8",
      gitRev: "0fb99c8",
      catalogueHash: "h-market-fix",
      taskIds: TASKS,
      results: after,
      failureClasses: stored("FACT_NOT_NOTED", 2),
    });
    return {
      baseline,
      probe,
      verdict: compareProbe(probe, baseline, "FACT_NOT_NOTED", {
        templatesMatch: true,
        classes: probeClassRates("FACT_NOT_NOTED"),
        owner: ownerOf,
      }),
    };
  };

  it("passes probe 20260919-1952-0fb99c8 under the two rules, its two regressions read as a family and as now graded", () => {
    const { verdict } = realCase();
    expect(verdict.before).toMatchObject({ k: 8, n: 19 });
    expect(verdict.after).toMatchObject({ k: 2, n: 14 });
    expect(verdict.p).toBeCloseTo(0.0428, 3);
    expect(verdict.reasons).toEqual([
      { code: "NOW_GRADED", key: "RECORD_WRONG", tasks: ["crm"] },
    ]);
    expect(verdict.pass).toBe(true);
    const rows = verdict.comparison.regressions;
    const by = (key: string) => rows.find((r) => r.key === key);
    // STUCK_LOOP 0/19 to 2/14 was the regression; the family is 10/19 to 4/14.
    expect(by("STUCK_LOOP")).toBeUndefined();
    expect(by(STUCK_FAMILY)).toMatchObject({
      before: { k: 10, n: 19 },
      after: { k: 4, n: 14 },
      verdict: "inconclusive",
    });
    expect(by("ACTION_BUDGET")).toMatchObject({
      before: { k: 6 },
      after: { k: 2 },
    });
    expect(by("STOPPED_WHILE_PAUSED")).toMatchObject({
      before: { k: 4 },
      after: { k: 0 },
    });
    // RECORD_WRONG 0/19 to 2/14 on a task the baseline never ran.
    expect(by("RECORD_WRONG")).toMatchObject({
      before: { k: 0, n: 19 },
      after: { k: 2, n: 14 },
      verdict: "now_graded",
    });
    expect(by(CELL)).toMatchObject({
      scope: "model",
      before: { k: 1, n: 19 },
      after: { k: 4, n: 14 },
      verdict: "improvement",
    });
    expect(by("ACTION_LOOP")).toMatchObject({
      before: { k: 12 },
      after: { k: 4 },
      verdict: "improvement",
    });
    expect(by("FALSE_DONE")).toMatchObject({
      before: { k: 4 },
      after: { k: 4 },
    });
    expect(rows.filter((r) => r.verdict === "regression")).toEqual([]);
    // Worst first: a now_graded row sorts after new and before inconclusive.
    const order = rows.map((r) => r.verdict);
    expect(order.indexOf("now_graded")).toBeLessThan(
      order.indexOf("inconclusive"),
    );
    expect(order.indexOf("inconclusive")).toBeLessThan(
      order.indexOf("improvement"),
    );
  });

  it("prints the verdict line in a fixed order: the class, the success rate, failing reasons, then informational ones", () => {
    const { verdict, probe, baseline } = realCase();
    const line = probeLine(
      verdict,
      verdict.comparison.regressions,
      "20260919-1646-09c5412",
    );
    expect(line).toBe(
      "probe FACT_NOT_NOTED against 20260919-1646-09c5412: pass · class 8/19 before, 2/14 now (one-sided p 0.043) · success openai:gpt-5.4-mini 1/19 before, 4/14 now (+23 pts, p 0.032, improvement) · informational: NOW_GRADED RECORD_WRONG (crm)",
    );
    // A failed probe: the failing reasons before the informational ones,
    // whatever order they were pushed in.
    const failed = probeLine(
      {
        ...verdict,
        pass: false,
        reasons: [
          { code: "NOW_GRADED", key: "RECORD_WRONG", tasks: ["crm", "kpi"] },
          { code: "OTHER_CLASS_REGRESSED", key: STUCK_FAMILY },
          { code: "MODEL_REGRESSED", key: CELL },
        ],
      },
      verdict.comparison.regressions,
    );
    expect(failed).toBe(
      "probe FACT_NOT_NOTED against its baseline: FAIL · class 8/19 before, 2/14 now (one-sided p 0.043) · success openai:gpt-5.4-mini 1/19 before, 4/14 now (+23 pts, p 0.032, improvement) · OTHER_CLASS_REGRESSED STUCK_LOOP (+STOPPED_WHILE_PAUSED, ACTION_BUDGET), MODEL_REGRESSED openai:gpt-5.4-mini · informational: NOW_GRADED RECORD_WRONG (crm, kpi)",
    );
    // The report's header carries the same line, and its table the family
    // row and the now_graded verdict.
    const cycle = buildCycleResults({
      cycle: info({
        id: probe.id,
        gitRev: probe.gitRev,
        matrix: [info().matrix[0]],
        probe: { code: "FACT_NOT_NOTED", baseline: baseline.id },
      }),
      results: probe.results,
      baseline: { cycles: [baseline], comparison: verdict.comparison },
      probe: verdict,
    });
    const md = renderCycleReport(cycle);
    expect(md).toContain(`\n${line}\n`);
    expect(md).toContain(
      "| class | STUCK_LOOP (+STOPPED_WHILE_PAUSED, ACTION_BUDGET) | 10/19 | 4/14 | -24 | 0.083 | inconclusive |",
    );
    expect(md).toContain(
      "| class | RECORD_WRONG | 0/19 | 2/14 | +14 | 0.045 | now_graded |",
    );
    expect(md).not.toMatch(/\| class \| STUCK_LOOP \|/);
    expect(cycle.probe?.reasons).toEqual([
      { code: "NOW_GRADED", key: "RECORD_WRONG", tasks: ["crm"] },
    ]);
  });

  it("rates the class under test from its stored count, frictions included", () => {
    const rates = probeClassRates("BLIND_SURFACE")(
      {
        results: rows(10, 0),
        failureClasses: [
          { code: "BLIND_SURFACE", byModel: { [A]: { attempts: 4 } } },
        ],
      },
      [A],
    );
    expect(rates).toContainEqual({
      code: "BLIND_SURFACE",
      attempts: 4,
      ran: 10,
    });
  });

  it("matches templates task for task", () => {
    const info = (
      over: Partial<CycleTaskInfoLike> = {},
    ): CycleTaskInfoLike => ({
      id: "t",
      category: "files",
      difficulty: "easy",
      maxCost: 0.1,
      maxActions: 10,
      maxSeconds: 60,
      instruction: "Open {x}",
      verifies: "v",
      suite: "long",
      ...over,
    });
    expect(sameTemplates([info()], [info()])).toBe(true);
    expect(sameTemplates([info()], [info({ instruction: "Close {x}" })])).toBe(
      false,
    );
    expect(sameTemplates([info()], [info({ id: "u" })])).toBe(false);
  });
});
type CycleTaskInfoLike = Parameters<typeof sameTemplates>[0][number];

describe("the token ledger and the sweep", () => {
  it("keeps a token while something a sweep could clear is left, and names nothing else", () => {
    const dir = join(mkdtempSync(join(scratch, "ledger-")), "bench-tokens");
    const ledger = fileTokenLedger(dir);
    ledger.open("benchnote0aa1", "files-rename-pattern");
    ledger.started("benchnote0aa1", 1234);
    ledger.open("benchnote0aa2", "text-append-line");
    ledger.open("benchnote0aa3", "agenda-rem-create");
    expect(ledger.entries()).toEqual([
      { token: "benchnote0aa1", taskId: "files-rename-pattern", start: 1234 },
      { token: "benchnote0aa2", taskId: "text-append-line" },
      { token: "benchnote0aa3", taskId: "agenda-rem-create" },
    ]);
    // A stray file Spotlight may index later: kept for the next sweep.
    ledger.close("benchnote0aa1", ["LEFTOVER_STRAY_FILE"], false);
    // A person's file, and a Spotlight that gave no answer: the answer may
    // come next time, but only MAX_CLEANUPS times in all; a ledger entry
    // skips every later night's long tasks.
    const unanswered = ["LEFTOVER_FOREIGN_FILE", "SWEEP_UNVERIFIED"];
    ledger.close("benchnote0aa2", unanswered, false);
    // Cleanup threw: kept.
    ledger.close("benchnote0aa3", [], true);
    expect(ledger.entries().map((entry) => entry.token)).toEqual([
      "benchnote0aa1",
      "benchnote0aa2",
      "benchnote0aa3",
    ]);
    expect(MAX_CLEANUPS).toBe(3);
    ledger.close("benchnote0aa2", unanswered, false);
    expect(ledger.entries()[1]).toMatchObject({ cleanups: 2 });
    ledger.close("benchnote0aa2", unanswered, false);
    expect(ledger.entries().map((entry) => entry.token)).toEqual([
      "benchnote0aa1",
      "benchnote0aa3",
    ]);
    // A store without a grant never answers any better: gone at once.
    ledger.open("benchnote0aa4", "agenda-rem-create");
    ledger.close("benchnote0aa4", ["LEFTOVER_AGENDA_UNVERIFIED"], false);
    expect(ledger.entries().map((entry) => entry.token)).not.toContain(
      "benchnote0aa4",
    );
    expect([...TRANSIENT_LEFTOVERS].sort()).toEqual([
      "LEFTOVER_AGENDA_NO_ANSWER",
      "SWEEP_UNVERIFIED",
    ]);
    expect(() => ledger.open("../../etc", "x")).toThrow();
    expect(() => ledger.open("notatoken", "x")).toThrow();
    expect([...RETRYABLE_LEFTOVERS].sort()).toEqual([
      "LEFTOVER_EVENT",
      "LEFTOVER_FILES",
      "LEFTOVER_REMINDER",
      "LEFTOVER_STRAY_FILE",
    ]);
    // Under ~/Library, where the stray-file sweep never looks.
    const home = "/Users/someone";
    expect(tokenLedgerDir(home)).toBe(
      "/Users/someone/Library/Caches/open-assist/bench-tokens",
    );
    expect(
      strayAction(
        join(tokenLedgerDir(home), "benchnote0aa1"),
        "benchnote0aa1",
        home,
        () => ({ kind: "file", born: 2000 }),
        1000,
      ),
    ).toBe("ignore");
  });

  it("sweeps what a crashed attempt left, dated by the ledger once its folder is gone", async () => {
    const home = mkdtempSync(join(scratch, "home-"));
    const ledger = fileTokenLedger(tokenLedgerDir(home));
    const crashed = "benchnote1aa1";
    const older = "benchnote1aa2";
    const start = Date.now() - 60_000;
    ledger.open(crashed, "text-new-doc-save");
    ledger.started(crashed, start);
    const docs = join(home, "Documents");
    mkdirSync(docs, { recursive: true });
    // Saved in the wrong place during the attempt: the sweep's to delete.
    const stray = join(docs, `${crashed}.txt`);
    writeFileSync(stray, "x");
    // A person's file the model renamed to the token: older than the attempt.
    const theirs = join(docs, `${crashed}-list.txt`);
    writeFileSync(theirs, "y");
    const past = new Date(start - 3_600_000);
    utimesSync(theirs, past, past);
    // An older harness's folder with no ledger entry.
    mkdirSync(join(home, "OpenAssistBench", older, "sub"), { recursive: true });
    writeFileSync(join(home, "OpenAssistBench", older, "sub", "a.txt"), "z");
    mkdirSync(join(home, "OpenAssistBench", ".quarantine"), {
      recursive: true,
    });
    expect(benchRootTokens(home)).toEqual([older]);
    expect(benchRootDirty(home, ledger.entries())).toBe(true);
    const found = [stray, theirs];
    const swept = await sweepTokens({
      home,
      ledger,
      tasks: allById,
      options: {
        exec: async (file, args) => {
          if (file !== "mdfind") throw new Error(`unexpected ${file}`);
          const token = /"(benchnote[0-9a-z]{4})\*"/.exec(
            args.at(-1) ?? "",
          )?.[1];
          return found
            .filter((path) => token && path.split("/").pop()!.startsWith(token))
            .join("\n");
        },
      },
    });
    expect(swept).toEqual([
      { token: crashed, leftovers: ["LEFTOVER_FOREIGN_FILE"] },
      { token: older, leftovers: [] },
    ]);
    expect(existsSync(stray)).toBe(false);
    expect(existsSync(theirs)).toBe(true);
    expect(existsSync(join(home, "OpenAssistBench", older))).toBe(false);
    // Nothing a sweep can clear is left, so the ledger lets both go.
    expect(ledger.entries()).toEqual([]);
    expect(benchRootDirty(home, ledger.entries())).toBe(false);
    expect(await sweepTokens({ home, ledger, tasks: allById })).toEqual([]);
  });

  it("says what is still on the Mac after the final sweep", () => {
    expect(
      remainingLeftovers(
        [{ leftovers: ["LEFTOVER_STRAY_FILE", "LEFTOVER_FOREIGN_FILE"] }, {}],
        [{ token: "benchnote1aa1", leftovers: ["LEFTOVER_EVENT"] }],
      ),
    ).toEqual(["LEFTOVER_EVENT", "LEFTOVER_FOREIGN_FILE"]);
    // A row's retryable or unanswered leftover is the sweep's to answer.
    expect(
      remainingLeftovers(
        [{ leftovers: ["LEFTOVER_STRAY_FILE", "LEFTOVER_AGENDA_NO_ANSWER"] }],
        [],
      ),
    ).toEqual([]);
    // No sweep answered anything: every row's code stands, and says why.
    expect(
      remainingLeftovers(
        [
          { leftovers: ["LEFTOVER_EVENT"] },
          { leftovers: ["LEFTOVER_STRAY_FILE", "LEFTOVER_FOREIGN_FILE"] },
          {},
        ],
        undefined,
      ),
    ).toEqual([
      "LEFTOVER_EVENT",
      "LEFTOVER_FOREIGN_FILE",
      "LEFTOVER_STRAY_FILE",
      "SWEEP_FAILED",
    ]);
    expect(remainingLeftovers([], undefined)).toEqual(["SWEEP_FAILED"]);
  });

  it("keeps a file task's token until Spotlight has had time to index what the attempt saved", async () => {
    const home = mkdtempSync(join(scratch, "lag-home-"));
    const token = "benchnote7qq1";
    const task = allById.get("text-new-doc-save")!;
    expect(sweepsStrayFiles(task)).toBe(true);
    let clock = Date.now();
    const slept: number[] = [];
    const ledger = fileTokenLedger(tokenLedgerDir(home), () => clock);
    const docs = join(home, "Documents");
    mkdirSync(docs, { recursive: true });
    const stray = join(docs, `${token}.rtf`);
    // Spotlight indexes the save only after the attempt's own cleanup ran.
    let indexed = false;
    const exec = async (file: string) => {
      if (file !== "mdfind") throw new Error(`unexpected ${file}`);
      return indexed && existsSync(stray) ? stray : "";
    };
    const readers = createReaders({ exec, home });
    const { controller } = fakeController({ appId: TEXTEDIT });
    const { deps } = attemptDeps(controller, {
      benchRoot: join(home, "OpenAssistBench"),
      token: () => token,
      tokens: ledger,
      // The model saved in the wrong place seconds before it said done.
      cleanupAttempt: async (t, ctx) => {
        writeFileSync(stray, "list");
        return readers.cleanupAttempt(t, ctx);
      },
    });
    const result = await runAttempt(deps, CELL, task, 1, caps);
    // The attempt's cleanup looked before Spotlight had the file: clean.
    expect(result.leftovers ?? []).toEqual([]);
    expect(existsSync(stray)).toBe(true);
    // ...so its token stays for the final sweep, with the time it looked.
    expect(ledger.entries()).toEqual([
      expect.objectContaining({ token, taskId: task.id, cleanedAt: clock }),
    ]);
    indexed = true;
    const swept = await sweepTokens({
      home,
      ledger,
      tasks: allById,
      options: { exec },
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    });
    // It waited out the lag, then found the file and deleted it.
    expect(slept).toEqual([SPOTLIGHT_SETTLE_MS]);
    expect(swept).toEqual([{ token, leftovers: [] }]);
    expect(existsSync(stray)).toBe(false);
    expect(ledger.entries()).toEqual([]);
  });

  it("keeps the token when a sweep had to run before the lag was out, without moving its time", async () => {
    const home = mkdtempSync(join(scratch, "early-home-"));
    let clock = 5_000_000;
    const ledger = fileTokenLedger(tokenLedgerDir(home), () => clock);
    const token = "benchnote7qq2";
    ledger.open(token, "text-append-line");
    ledger.started(token, clock - 60_000);
    ledger.close(token, [], false, true);
    expect(settleDelay(ledger.entries(), clock)).toBe(SPOTLIGHT_SETTLE_MS);
    expect(settleDelay(ledger.entries(), clock + 10_000)).toBe(20_000);
    expect(settleDelay(ledger.entries(), clock + 40_000)).toBe(0);
    expect(settleDelay([{ token }], clock)).toBe(0);
    const exec = async () => "";
    const waits: number[] = [];
    // A second Ctrl-C cut the wait short, ten seconds in.
    await sweepTokens({
      home,
      ledger,
      tasks: allById,
      options: { exec },
      now: () => clock,
      sleep: async () => {
        clock += 10_000;
      },
      onWait: (ms) => waits.push(ms),
    });
    expect(waits).toEqual([SPOTLIGHT_SETTLE_MS]);
    expect(ledger.entries()).toEqual([
      expect.objectContaining({ token, cleanedAt: 5_000_000 }),
    ]);
    clock = 5_000_000 + SPOTLIGHT_SETTLE_MS;
    await sweepTokens({
      home,
      ledger,
      tasks: allById,
      options: { exec },
      now: () => clock,
      sleep: async () => {},
    });
    expect(ledger.entries()).toEqual([]);
  });

  it("asks the agenda helper again when it gave no answer, and stops asking after MAX_CLEANUPS", async () => {
    const home = mkdtempSync(join(scratch, "agenda-home-"));
    const ledger = fileTokenLedger(tokenLedgerDir(home));
    const token = "benchnote7qq3";
    const granted = { calendar: "granted", reminders: "granted" };
    let removeFails = true;
    const exec = async (_file: string, args: string[]) => {
      if (args[0] === "remove") {
        if (removeFails) throw new Error("timed out");
        return JSON.stringify({ removed: 1, foreign: 0 });
      }
      return JSON.stringify({ access: granted, items: [] });
    };
    // The event may be syncing to other people's calendars: a timeout is
    // not a clean answer, and the token stays for the final sweep.
    ledger.open(token, "agenda-cal-create-tomorrow");
    ledger.close(token, ["LEFTOVER_AGENDA_NO_ANSWER"], false);
    const first = await sweepTokens({
      home,
      ledger,
      tasks: allById,
      options: { exec },
    });
    expect(first).toEqual([
      { token, leftovers: ["LEFTOVER_AGENDA_NO_ANSWER"] },
    ]);
    expect(ledger.entries().map((entry) => entry.token)).toEqual([token]);
    removeFails = false;
    const second = await sweepTokens({
      home,
      ledger,
      tasks: allById,
      options: { exec },
    });
    expect(second).toEqual([{ token, leftovers: [] }]);
    expect(ledger.entries()).toEqual([]);
    // A helper that never answers: the attempt, the final sweep and one
    // --cleanup-only, then the person is told and the nights go on.
    removeFails = true;
    ledger.open(token, "agenda-cal-create-tomorrow");
    ledger.close(token, ["LEFTOVER_AGENDA_NO_ANSWER"], false);
    for (let sweep = 2; sweep <= MAX_CLEANUPS; sweep++)
      expect(
        await sweepTokens({ home, ledger, tasks: allById, options: { exec } }),
      ).toEqual([{ token, leftovers: ["LEFTOVER_AGENDA_NO_ANSWER"] }]);
    expect(ledger.entries()).toEqual([]);
  });

  it("prints what cleanup left behind in the summary", () => {
    const totals = aggregate([
      row({ leftovers: ["LEFTOVER_FILES", "LEFTOVER_FILES"] }),
      row({ leftovers: ["LEFTOVER_EVENT"], cleanupFailed: true }),
      row(),
    ]);
    expect(totals.leftovers).toEqual({ LEFTOVER_FILES: 1, LEFTOVER_EVENT: 1 });
    expect(totals.cleanupFailed).toBe(1);
    expect(renderSummary(totals)).toContain(
      "Leftovers  LEFTOVER_EVENT 1  LEFTOVER_FILES 1  cleanup failed 1",
    );
    expect(leftoversLine(aggregate([row()]))).toBeUndefined();
    expect(renderSummary(aggregate([row()]))).not.toContain("Leftovers");
  });
});

describe("the fixture server as a child process", () => {
  type Child = FixtureHandle & {
    pid: number;
    flush(): Promise<void>;
    alive(): boolean;
    close(): Promise<void>;
  };
  const load = async () =>
    (await import(
      /* @vite-ignore */ pathToFileURL(join(root, "scripts/bench-fixtures.mjs"))
        .href
    )) as {
      spawnFixtureServer: (options?: {
        port?: number;
        timeoutMs?: number;
      }) => Promise<Child>;
    };

  it("serves on a free loopback port, mirrors each token's log, and ends on close", async () => {
    const { spawnFixtureServer } = await load();
    const server = await spawnFixtureServer({ port: 0 });
    try {
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const token = "benchnote2aa1";
      const base = server.register(token, {
        orders: pages.orders(token, drawOrders(seeded(1))),
      });
      expect(base).toBe(`${server.url}/${token}`);
      await server.flush();
      const page = await fetch(`${base}/orders`, {
        headers: { accept: "text/html" },
      });
      expect(page.status).toBe(200);
      await page.text();
      await server.flush();
      expect(server.read(token)).toEqual({
        port: server.port,
        visits: [`/${token}/orders`],
        submissions: [],
      });
      server.reset(token);
      expect(server.read(token).visits).toEqual([]);
      // The terminal's Ctrl-C reaches the whole process group: the child
      // waits for its parent to finish the attempt it is stopping.
      process.kill(server.pid, "SIGINT");
      await new Promise((done) => setTimeout(done, 300));
      expect(server.alive()).toBe(true);
      const again = await fetch(`${base}/orders`, {
        headers: { accept: "text/html" },
      });
      expect(again.status).toBe(200);
      await again.text();
    } finally {
      await server.close();
    }
    expect(server.alive()).toBe(false);
    expect(alive(server.pid)).toBe(false);
  });

  it("reports a taken port as FIXTURE_PORT", async () => {
    const { spawnFixtureServer } = await load();
    const holder = createServer();
    await new Promise<void>((done) => holder.listen(0, "127.0.0.1", done));
    const { port } = holder.address() as AddressInfo;
    try {
      await expect(spawnFixtureServer({ port })).rejects.toMatchObject({
        code: "FIXTURE_PORT",
      });
    } finally {
      await new Promise((done) => holder.close(done));
    }
  });

  it("ends with its parent, however the parent ends", async () => {
    const dir = mkdtempSync(join(scratch, "orphan-"));
    const script = join(dir, "parent.mjs");
    writeFileSync(
      script,
      `const { spawnFixtureServer } = await import(${JSON.stringify(pathToFileURL(join(root, "scripts/bench-fixtures.mjs")).href)});
const server = await spawnFixtureServer({ port: 0 });
console.log(String(server.pid));
setInterval(() => {}, 1000);
`,
    );
    const parent = spawn(process.execPath, [script], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const pid = await new Promise<number>((done, fail) => {
      parent.stdout.once("data", (data) => done(Number(String(data).trim())));
      parent.once("exit", () => fail(new Error("parent exited early")));
    });
    expect(alive(pid)).toBe(true);
    // No exit handler runs after SIGKILL: only the closed channel ends it.
    parent.kill("SIGKILL");
    const deadline = Date.now() + 10_000;
    while (alive(pid) && Date.now() < deadline)
      await new Promise((done) => setTimeout(done, 50));
    expect(alive(pid)).toBe(false);
  });
});

describe("the readers in a dry run", () => {
  it("run nothing and write nothing when imported", async () => {
    vi.resetModules();
    const ran = vi.fn();
    const wrote = vi.fn();
    vi.doMock("node:child_process", async (original) => ({
      ...(await original<typeof import("node:child_process")>()),
      execFile: ran,
      spawn: ran,
      exec: ran,
    }));
    vi.doMock("node:fs", async (original) => ({
      ...(await original<typeof import("node:fs")>()),
      writeFileSync: wrote,
      mkdirSync: wrote,
      rmSync: wrote,
      unlinkSync: wrote,
      renameSync: wrote,
    }));
    try {
      const readers = await import("../src/gym/bench/readers");
      expect(typeof readers.createReaders).toBe("function");
      expect(typeof readers.cleanupAttempt).toBe("function");
      expect(ran).not.toHaveBeenCalled();
      expect(wrote).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("node:child_process");
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });
});

describe("harness-cycle.mjs with the suites", () => {
  const home = () => mkdtempSync(join(scratch, "script-home-"));

  it("--dry-run --suite long plans the long suite and loads nothing paid", () => {
    const { child, loaded } = traced(
      ["scripts/harness-cycle.mjs", "--dry-run", "--suite", "long"],
      { HOME: home() },
    );
    expect(child.status, child.stderr).toBe(0);
    for (const module of [...PAID, "scripts/bench-fixtures.mjs"])
      expect(loaded, module).not.toContain(module);
    expect(child.stdout).toContain(
      `long suite: ${LONG_CATALOGUE.length} task(s)`,
    );
    // The long suite does not fit one 4 h night: it is cut into nights
    // that do, with the seed the other nights must reuse.
    expect(child.stdout).toMatch(/needs \d+ nights to fit the time box/);
    expect(child.stdout).toMatch(/--shard 2\/\d+ --seed \d+/);
  });

  it("selects suites by --suite or by name in --tasks, and keeps --tasks all the suite's", () => {
    const run = (...args: string[]) =>
      spawnSync(
        process.execPath,
        ["scripts/harness-cycle.mjs", "--dry-run", ...args],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 60000,
          env: { ...process.env, HOME: home() },
        },
      );
    const bare = run();
    expect(bare.status, bare.stderr).toBe(0);
    expect(bare.stdout).toContain(
      `smoke suite: ${CATALOGUE.length} task(s) x 1 model(s) x 3`,
    );
    expect(run("--tasks", "all").stdout).toContain(
      `smoke suite: ${CATALOGUE.length} task(s)`,
    );
    expect(run("--tasks", "long").stdout).toContain(
      `long suite: ${LONG_CATALOGUE.length} task(s)`,
    );
    const files = run("--suite", "all", "--tasks", "files");
    expect(files.stdout).toContain("all suite: 8 task(s)");
    expect(run("--tasks", "market").stdout).toContain(
      `market suite: ${MARKET_CATALOGUE.length} task(s)`,
    );
    const bad = run("--suite", "huge");
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("--suite takes smoke, long, market or all");
    const unknown = run("--suite", "long", "--tasks", "calculator-open");
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain("Unknown task or category");
  });

  it("--cleanup-only sweeps under the lock and runs no task", () => {
    const where = home();
    const token = "benchnote3aa1";
    mkdirSync(join(where, "OpenAssistBench", token), { recursive: true });
    writeFileSync(join(where, "OpenAssistBench", token, "a.txt"), "x");
    let result = traced(["scripts/harness-cycle.mjs", "--cleanup-only"], {
      HOME: where,
    });
    // Another test's harness process can be up for a moment; the sweep
    // rightly refuses while one is, so it is simply asked again.
    for (
      let tries = 0;
      tries < 5 && result.child.stderr.includes("HARNESS_RUNNING");
      tries++
    ) {
      spawnSync("sleep", ["1"]);
      result = traced(["scripts/harness-cycle.mjs", "--cleanup-only"], {
        HOME: where,
      });
    }
    const { child, loaded } = result;
    for (const module of PAID) expect(loaded, module).not.toContain(module);
    expect(child.stdout).toContain(token);
    expect(existsSync(join(where, "OpenAssistBench", token))).toBe(false);
    // The lock was taken in this home and given back.
    expect(
      existsSync(join(where, "Library/Caches/open-assist/desktop.lock")),
    ).toBe(false);
    if (child.status !== 0) expect(child.stdout).toContain("SWEEP_UNVERIFIED");
    const empty = traced(["scripts/harness-cycle.mjs", "--cleanup-only"], {
      HOME: where,
    });
    expect(empty.child.stdout).toContain("Nothing to sweep");
  });

  it("wires the suite's readers, cleanup, agenda, ledger and fixture into a real start", () => {
    const cycle = readFileSync(join(root, "scripts/harness-cycle.mjs"), "utf8");
    const paid = cycle.indexOf(
      "// Nothing below this line is loaded by --dry-run",
    );
    expect(cycle).not.toMatch(/readEvidence: null|cleanupAttempt: null/);
    expect(cycle).toContain("cleanupAttempt: readers.cleanupAttempt");
    expect(cycle).toContain("agendaFor: readers.agendaFor");
    expect(cycle).not.toMatch(/\n\s+agenda:/);
    expect(cycle).toContain("tokens: tokenLedger");
    // The runner's deliverable reader, under this home, in both scripts.
    expect(cycle).toContain("deliverables: fileFactsReader(homedir()),");
    expect(cycle).toContain(
      'const { fileFactsReader } = await import("../src/storage/files.ts");',
    );
    expect(cycle).toContain(
      'createReaders({ music: process.env[MUSIC_READER_ENV] === "1" })',
    );
    // The fixture child starts inside the try whose finally closes it, and
    // the final sweep runs before the lock is given back.
    const tryAt = cycle.indexOf("try {\n  // The fixture server runs");
    const spawnAt = cycle.indexOf("spawnFixtureServer({ port: FIXTURE_PORT })");
    const finallyAt = cycle.indexOf(
      "} finally {\n  try {\n    await fixture?.close();",
    );
    const sweepAt = cycle.indexOf("swept = await sweepTokens(", finallyAt);
    const releaseAt = cycle.indexOf(
      "releaseDesktopLock(lockFile, process.pid);\n}",
      finallyAt,
    );
    expect(paid).toBeGreaterThan(0);
    expect(tryAt).toBeGreaterThan(paid);
    expect(spawnAt).toBeGreaterThan(tryAt);
    expect(finallyAt).toBeGreaterThan(spawnAt);
    expect(sweepAt).toBeGreaterThan(finallyAt);
    expect(releaseAt).toBeGreaterThan(sweepAt);
    // --cleanup-only takes the lock before it sweeps, and exits before the
    // plan, the dry run and every paid import.
    const only = cycle.indexOf('if (values["cleanup-only"]) {');
    expect(only).toBeGreaterThan(0);
    expect(cycle.indexOf("acquireDesktopLock(lockFile", only)).toBeLessThan(
      cycle.indexOf("await sweepTokens(", only),
    );
    expect(only).toBeLessThan(cycle.indexOf('if (values["dry-run"]) {'));
    // Every recount of the skips sees every fact so far: the fixture server
    // failing must not forget what the agenda helper's setup said, nor the
    // re-read after a gate pass what either said, nor the recount after a
    // leftover browser is judged at the gate (refreshSkips).
    expect(cycle.match(/startSkips\(tasks, facts\)/g)).toHaveLength(5);
    expect(cycle).not.toMatch(/startSkips\(tasks, \{/);
    // setup (which writes) runs only after the dry run and preflight exits.
    expect(cycle.indexOf('run(AGENDA_BINARY, ["setup"])')).toBeGreaterThan(
      cycle.indexOf('if (!values["i-know-this-drives-my-mac"])'),
    );
    const bench = readFileSync(join(root, "scripts/bench.mjs"), "utf8");
    expect(bench).not.toMatch(/readEvidence: null|cleanupAttempt: null/);
    expect(bench).toContain("cleanupAttempt: readers.cleanupAttempt");
    expect(bench).toContain("agendaFor: readers.agendaFor");
    expect(bench).toContain("deliverables: fileFactsReader(homedir()),");
    expect(bench).toContain("await fixture?.close();");
    expect(bench.indexOf("spawnFixtureServer")).toBeGreaterThan(
      bench.indexOf('if (!values["i-know-this-drives-my-mac"])'),
    );
  });

  it("refuses --cleanup-only with --dry-run or --preflight, and deletes nothing", () => {
    const where = home();
    const token = "benchnote9zz1";
    const folder = join(where, "OpenAssistBench", token);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "a.txt"), "x");
    for (const flag of ["--dry-run", "--preflight"]) {
      const { child, loaded } = traced(
        ["scripts/harness-cycle.mjs", "--cleanup-only", flag],
        { HOME: where },
      );
      expect(child.status, flag).toBe(2);
      expect(child.stderr).toContain("does not combine with --dry-run");
      expect(existsSync(join(folder, "a.txt")), flag).toBe(true);
      for (const module of PAID) expect(loaded, module).not.toContain(module);
    }
    // No lock was taken, so none is left.
    expect(
      existsSync(join(where, "Library/Caches/open-assist/desktop.lock")),
    ).toBe(false);
  });

  it("fails the final sweep closed, and re-reads the open applications after the gate", () => {
    const cycle = readFileSync(join(root, "scripts/harness-cycle.mjs"), "utf8");
    const finallyAt = cycle.indexOf(
      "} finally {\n  try {\n    await fixture?.close();",
    );
    const sweep = cycle.slice(
      cycle.indexOf("swept = await sweepTokens(", finallyAt),
      cycle.indexOf("releaseDesktopLock(lockFile, process.pid);\n}", finallyAt),
    );
    // A sweep that threw answered nothing: not an empty answer.
    expect(sweep).toMatch(/catch \{\s+swept = undefined;\s+\}/);
    expect(sweep).toContain("onWait: spotlightWait");
    // Then the windows, after the token sweep and before the lock goes
    // back: the attempts' documents, the paths every ledger row names, and
    // TextEdit asked only while ps shows it; a throw answers nothing.
    const windowsAt = sweep.indexOf("windowSweep = await closeBenchWindows({");
    expect(windowsAt).toBeGreaterThan(
      sweep.indexOf("swept = await sweepTokens("),
    );
    expect(sweep.slice(windowsAt)).toContain("documents: attemptDocuments,");
    expect(sweep.slice(windowsAt)).toMatch(
      /paths: ledgerResults\(\s+parseLedger\(readFileSync\(ledgerFile, "utf8"\)\),\s+\)\.flatMap\(\(row\) => row\.strayDocuments \?\? \[\]\)/,
    );
    expect(sweep.slice(windowsAt)).toContain("running: runningApps(ps),");
    expect(sweep.slice(windowsAt)).toMatch(
      /catch \{\s+windowSweep = undefined;\s+\}/,
    );
    expect(cycle).toContain("remainingLeftovers(results, swept, windowSweep)");
    expect(cycle).toContain("const strays = strayDocumentsLine(results);");
    // --cleanup-only closes windows only under the flag that allows acting
    // on this desktop (an Apple Event to TextEdit and the Finder), after its
    // own token sweep; without it nothing is asked.
    const only = cycle.slice(
      cycle.indexOf('if (values["cleanup-only"]) {'),
      cycle.indexOf(
        "/* ------------------------------------------------------------------ plan */",
      ),
    );
    const flagAt = only.indexOf('if (values["i-know-this-drives-my-mac"]) {');
    expect(flagAt).toBeGreaterThan(only.indexOf("swept = await sweepTokens({"));
    expect(only.indexOf("await closeBenchWindows({")).toBeGreaterThan(flagAt);
    expect(only).toContain("remainingLeftovers([], swept, windows)");
    expect(only).toContain(
      "were not looked at: add --i-know-this-drives-my-mac",
    );
    // The start's ps can be hours old by the first attempt.
    const after = cycle.slice(cycle.indexOf("afterGate: async (pass) => {"));
    expect(after.indexOf("openedByPerson(")).toBeGreaterThan(0);
    expect(after.indexOf("openedByPerson(")).toBeLessThan(
      after.indexOf("attempt: async (entry, maxCost, gateWaitSeconds)"),
    );
    expect(after).toContain("skips.set(id, code)");
    // The windows of what they opened are asked about too, and the browser
    // is chosen per attempt from the facts so far; a dry run sends no Apple
    // Event.
    expect(after).toContain("readWindowFacts(run, appsToWatch(tasks, opened))");
    expect(cycle).toContain('appleEvents: !values["dry-run"],');
    expect(cycle).toContain("const browser = browserFor(task);");
    expect(cycle).toContain("          ...browser,\n");
    expect(cycle).toMatch(
      /reason === "APPS_OPEN" \? skipDetail\(entry\.taskId, reason\)\.apps/,
    );
    // Durations from any slice under any regime; the baseline the dry run
    // names is the slice-aware, same-regime one the end of the cycle picks.
    expect(cycle).toContain(
      "const timing = baselineFor(draft, timingCycles, cycles);",
    );
    expect(cycle).toMatch(
      /const baseline = baselineFor\(\{\s+\.\.\.draft,\s+designHash: design,\s+\.\.\.\(shardText \? \{ shard: shardText \} : \{\}\),\s+\}\);/,
    );
    // What an attempt leaves open is the benchmark's, read after each one.
    const attempt = cycle.slice(
      cycle.indexOf("attempt: async (entry, maxCost, gateWaitSeconds)"),
    );
    const ranAt = attempt.indexOf("await runAttempt(");
    expect(
      attempt.indexOf("runningAfterLast = await readRunning();"),
    ).toBeGreaterThan(ranAt);
    // Its windows are snapshotted before and after, for the Finder, the
    // task's applications and the browser chosen for it; what appeared is
    // kept for the final sweep and put on the row.
    expect(attempt).toContain(
      "const watched = snapshotApps(task, browser.browser?.id);",
    );
    const beforeAt = attempt.search(
      /const before = await readWindowSnapshot\(\s+run,\s+watched,\s+await readRunning\(\),\s+\);/,
    );
    expect(beforeAt).toBeGreaterThan(0);
    expect(beforeAt).toBeLessThan(ranAt);
    const leftAt = attempt.indexOf("const left = attemptWindows(");
    expect(leftAt).toBeGreaterThan(ranAt);
    expect(attempt.slice(leftAt)).toContain(
      "await readWindowSnapshot(run, watched, runningAfterLast),",
    );
    expect(attempt.slice(leftAt)).toContain(
      "attemptDocuments.push(...left.documents);",
    );
    expect(attempt.slice(leftAt)).toContain("return withWindowFields(");
  });

  it("gives bench.mjs the cycle's task preflight and final sweep for the long suite", () => {
    const bench = readFileSync(join(root, "scripts/bench.mjs"), "utf8");
    const exit = bench.indexOf('process.exit(0);\n}\n\nif (!values["i-know');
    const preflightAt = bench.indexOf("await readStartFacts(tasks, {");
    const fixtureAt = bench.indexOf(
      "spawnFixtureServer({ port: FIXTURE_PORT })",
    );
    const lockAt = bench.indexOf("acquireDesktopLock(lockFile");
    // Read-only facts, after the dry run's exit, under the lock, once the
    // fixture server's fate is known.
    expect(preflightAt).toBeGreaterThan(exit);
    expect(preflightAt).toBeGreaterThan(lockAt);
    expect(preflightAt).toBeGreaterThan(fixtureAt);
    expect(bench).toContain("if (tasks.some(longHorizon)) {");
    expect(bench).toContain("skips = startSkips(tasks, facts);");
    expect(bench).not.toMatch(/\["setup"\]/);
    // Every attempt asks the gate first; a skip is a row, not a run.
    const loop = bench.slice(
      bench.indexOf("for (const [planIndex, { task, attempt }]"),
    );
    const skipAt = loop.indexOf("const skip = gate.skip({ taskId: task.id });");
    expect(skipAt).toBeGreaterThan(0);
    expect(skipAt).toBeLessThan(loop.indexOf("await runAttempt("));
    expect(loop).toContain("gate.observe(result);");
    // The window counts at the real start, under the lock; the browser
    // chosen for the attempt; the open application on the skip row.
    expect(bench).toContain("appleEvents: true,");
    expect(loop).toContain("const browser = chooseBrowser(task, facts);");
    expect(loop).toContain("if (apps?.length) row.openApps = apps;");
    // The final sweep under the lock, answering the leftovers and the exit.
    const finallyAt = bench.indexOf("} finally {");
    const sweepAt = bench.indexOf("swept = await sweepTokens({", finallyAt);
    expect(sweepAt).toBeGreaterThan(finallyAt);
    expect(bench.slice(sweepAt, sweepAt + 800)).toMatch(
      /catch \{\s+swept = undefined;\s+\}/,
    );
    expect(bench).toContain("remainingLeftovers(results, swept)");
    expect(bench).toContain("tokens: tokenLedger,");
  });
});

/* ------------------------------------------------------- secure input */

describe("secure event input at the gate", () => {
  const SAFARI = "com.apple.Safari";
  const CHROME = "com.google.Chrome";
  const TERMINAL = "com.apple.Terminal";
  const caps = {
    now: 1_000_000,
    deadline: 1_000_000 + 3600_000,
    taskSeconds: 60,
    cooldownSeconds: 8,
  };
  const session = (users: Record<string, unknown>[]) =>
    JSON.stringify({ IOConsoleUsers: users });
  const ON = session([
    { kCGSSessionOnConsoleKey: true, kCGSSessionSecureInputPID: 254 },
  ]);
  const OFF = session([{ kCGSSessionOnConsoleKey: true }]);
  const lsappinfo = (id: string) => `"CFBundleIdentifier"="${id}"\n`;

  it("reads the holder's pid from the console session, the on-console user first, and a bundle id from lsappinfo", () => {
    expect(
      parseSecureInputPid({
        IOConsoleUsers: [
          { kCGSSessionOnConsoleKey: true, kCGSSessionSecureInputPID: 254 },
          { kCGSSessionSecureInputPID: 900 },
        ],
      }),
    ).toBe(254);
    // Another session's holder counts when the console user has none.
    expect(
      parseSecureInputPid({
        IOConsoleUsers: [
          { kCGSSessionOnConsoleKey: true },
          { kCGSSessionSecureInputPID: 900 },
        ],
      }),
    ).toBe(900);
    expect(
      parseSecureInputPid({
        IOConsoleUsers: [{ kCGSSessionOnConsoleKey: true }],
      }),
    ).toBeUndefined();
    // Only a positive whole number is a pid.
    expect(
      parseSecureInputPid({
        IOConsoleUsers: [
          { kCGSSessionSecureInputPID: "254" },
          { kCGSSessionSecureInputPID: 0 },
          { kCGSSessionSecureInputPID: -1 },
          { kCGSSessionSecureInputPID: 1.5 },
          null,
        ],
      }),
    ).toBeUndefined();
    expect(parseSecureInputPid({})).toBeUndefined();
    expect(parseSecureInputPid(undefined)).toBeUndefined();
    expect(parseSecureInputPid("text")).toBeUndefined();
    expect(parseBundleId(lsappinfo(SAFARI))).toBe(SAFARI);
    expect(parseBundleId('"CFBundleIdentifier" = "com.apple.Terminal"')).toBe(
      TERMINAL,
    );
    expect(
      parseBundleId('"CFBundleIdentifier"="not a bundle id"'),
    ).toBeUndefined();
    expect(parseBundleId("")).toBeUndefined();
    expect(parseBundleId(undefined)).toBeUndefined();
  });

  it("names the holder by lsappinfo from the session's pid, or by the surface's frontmost application for a focused secure field", async () => {
    const calls: string[][] = [];
    const exec =
      (answers: { root?: string; lsappinfo?: string }) =>
      async (command: string, args: string[]) => {
        calls.push([command, ...args]);
        if (command === "sh") return answers.root;
        if (command === "lsappinfo") return answers.lsappinfo;
        return "";
      };
    // The session names the pid; lsappinfo the bundle id, asked by pid.
    expect(
      await readSecureInput(exec({ root: ON, lsappinfo: lsappinfo(SAFARI) })),
    ).toEqual({ on: true, pid: 254, owner: SAFARI });
    expect(calls.find((call) => call[0] === "lsappinfo")).toEqual([
      "lsappinfo",
      "info",
      "-only",
      "bundleid",
      "-pid",
      "254",
    ]);
    expect(calls.find((call) => call[0] === "sh")?.[2]).toContain(
      "ioreg -n Root -d1 -a",
    );
    // lsappinfo silent (a process that is no application): on, no owner.
    expect(await readSecureInput(exec({ root: ON }))).toEqual({
      on: true,
      pid: 254,
    });
    // Off in the session, and the helper's surface not flagging: off, and
    // lsappinfo is never asked.
    const before = calls.length;
    const quiet: SurfaceRead = { secureInput: false, appId: SAFARI };
    expect(
      await readSecureInput(exec({ root: OFF }), async () => quiet),
    ).toEqual({ on: false });
    expect(calls.slice(before).some((call) => call[0] === "lsappinfo")).toBe(
      false,
    );
    // The surface flags a focused secure field the session does not name:
    // the frontmost application, which holds the field, is the holder.
    const flagged: SurfaceRead = { secureInput: true, appId: SAFARI };
    expect(
      await readSecureInput(exec({ root: OFF }), async () => flagged),
    ).toEqual({ on: true, owner: SAFARI });
    // The helper could not name the application: on, no owner.
    expect(
      await readSecureInput(exec({ root: OFF }), async () => ({
        secureInput: true,
        appId: "unknown",
        unknown: true,
      })),
    ).toEqual({ on: true });
    // A surface that throws (the helper gone) leaves the session's word.
    expect(
      await readSecureInput(
        exec({ root: ON, lsappinfo: lsappinfo(TERMINAL) }),
        async () => {
          throw new Error("gone");
        },
      ),
    ).toEqual({ on: true, pid: 254, owner: TERMINAL });
    // Both say on: the session's pid names the owner.
    expect(
      await readSecureInput(
        exec({ root: ON, lsappinfo: lsappinfo(TERMINAL) }),
        async () => flagged,
      ),
    ).toEqual({ on: true, pid: 254, owner: TERMINAL });
    // An unreadable session with a quiet surface is off: nothing said on.
    expect(await readSecureInput(exec({}), async () => quiet)).toEqual({
      on: false,
    });
    expect(await readSecureInput(exec({ root: "not json" }))).toEqual({
      on: false,
    });
  });

  it("puts secure input on the gate report and the system facts", async () => {
    const exec = async (command: string, args: string[]) => {
      if (command === "sh") return ON;
      if (command === "lsappinfo") return lsappinfo(SAFARI);
      if (command === "ioreg") return '"HIDIdleTime" = 900000000000';
      if (command === "defaults") return "0";
      return "";
    };
    const base: PresenceSource = {
      exec,
      ownPids: () => [],
      roots: ["/Users/nobody"],
      pid: 1,
      appDiagnostics: () => undefined,
      presence: async () => ({
        hidIdleSeconds: 999,
        tapIdleSeconds: 999,
        locked: false,
        displayAsleep: false,
        displayHeldAwake: true,
      }),
      surface: async () => ({ secureInput: true, appId: SAFARI }),
    };
    const gate = await readGate(base);
    expect(gate).toMatchObject({
      secureInput: true,
      secureInputOwner: SAFARI,
      source: "helper",
    });
    expect(gateDecision(gate, { idleSeconds: 300 }, caps)).toMatchObject({
      ok: false,
      reason: "SECURE_INPUT",
    });
    expect((await readSystem(base)).secureInput).toEqual({
      on: true,
      pid: 254,
      owner: SAFARI,
    });
    // Without a helper the session alone answers.
    const noHelper = await readGate({
      ...base,
      presence: undefined,
      surface: undefined,
    });
    expect(noHelper).toMatchObject({
      source: "system",
      secureInput: true,
      secureInputOwner: SAFARI,
    });
    // Off: the report says so, no owner is named, and the gate passes.
    const offExec = async (command: string, args: string[]) =>
      command === "sh" ? OFF : exec(command, args);
    const off = await readGate({
      ...base,
      exec: offExec,
      surface: async () => ({ secureInput: false, appId: SAFARI }),
    });
    expect(off.secureInput).toBe(false);
    expect(off).not.toHaveProperty("secureInputOwner");
    expect(gateDecision(off, { idleSeconds: 300 }, caps).ok).toBe(true);
    expect((await readSystem({ ...base, exec: offExec })).secureInput).toEqual({
      on: false,
    });
  });

  it("is refused after every other reason (a person typing a password is a person), and refused up front as the person's field", () => {
    expect(
      gateDecision(
        report({ secureInput: true, secureInputOwner: SAFARI }),
        { idleSeconds: 300 },
        caps,
      ),
    ).toEqual({
      ok: false,
      reason: "SECURE_INPUT",
      idle: { required: 300, seen: 999 },
    });
    expect(
      gateDecision(
        report({ secureInput: true, tapIdleSeconds: 10 }),
        { idleSeconds: 300 },
        caps,
      ),
    ).toMatchObject({ reason: "HID_ACTIVE" });
    expect(
      gateDecision(
        report({ secureInput: true, locked: true }),
        { idleSeconds: 300 },
        caps,
      ),
    ).toMatchObject({ reason: "LOCKED" });
    expect(
      gateDecision(
        report({ secureInput: true, appProcesses: 1 }),
        { idleSeconds: 300 },
        caps,
      ),
    ).toMatchObject({ reason: "APP_RUNNING" });
    expect(
      gateDecision(
        report({ secureInput: true, unreadable: true }),
        { idleSeconds: 300 },
        caps,
      ),
    ).toMatchObject({ reason: "PRESENCE_UNKNOWN" });
    // The preflight refuses a field of the person's with its remedy; whether
    // the holder is the benchmark's own browser is harness-cycle.mjs's call.
    const input: PreflightInput = {
      appPids: [],
      allowAppRunning: false,
      displayHolders: 0,
      screensaverIdleSeconds: 0,
      timeBoxSeconds: 3600,
      locked: false,
      displayAsleep: false,
    };
    expect(preflight({ ...input, secureInput: true })).toEqual([
      "SECURE_INPUT",
    ]);
    expect(preflight({ ...input, secureInput: false })).toEqual([]);
    expect(preflight(input)).toEqual([]);
    expect(REMEDY.SECURE_INPUT).toMatch(/password field/);
    expect(REMEDY.SECURE_INPUT).toMatch(/about:blank/);
  });

  it("tells the benchmark's own browser from the person's by the one rule chooseBrowser picks by", () => {
    // Not running: the attempt launches it, so its windows are the fixture's.
    expect(benchOwnBrowser(SAFARI, {})).toBe(true);
    expect(benchOwnBrowser(SAFARI, { running: new Set([CHROME]) })).toBe(true);
    // Running with its windows not read (a dry run, a refused query): the person's.
    expect(benchOwnBrowser(SAFARI, { running: new Set([SAFARI]) })).toBe(false);
    expect(
      benchOwnBrowser(SAFARI, {
        running: new Set([SAFARI]),
        windows: { [SAFARI]: undefined },
      }),
    ).toBe(false);
    // Running with no window, or only fixture pages: the benchmark's.
    expect(
      benchOwnBrowser(SAFARI, {
        running: new Set([SAFARI]),
        windows: { [SAFARI]: { windows: 0, foreign: 0 } },
      }),
    ).toBe(true);
    expect(
      benchOwnBrowser(SAFARI, {
        running: new Set([SAFARI]),
        windows: { [SAFARI]: { windows: 2, foreign: 0 } },
      }),
    ).toBe(true);
    // One window of the person's: theirs.
    expect(
      benchOwnBrowser(SAFARI, {
        running: new Set([SAFARI]),
        windows: { [SAFARI]: { windows: 2, foreign: 1 } },
      }),
    ).toBe(false);
    // chooseBrowser picks exactly such a browser, and never the other.
    const task = byTaskId("browser-nav-chain");
    const facts = {
      installed: new Set(["com.apple.finder", SAFARI, CHROME]),
      running: new Set([SAFARI, CHROME]),
      windows: {
        [SAFARI]: { windows: 1, foreign: 1 },
        [CHROME]: { windows: 1, foreign: 0 },
      },
    };
    expect(chooseBrowser(task, facts)?.id).toBe(CHROME);
    expect(benchOwnBrowser(CHROME, facts)).toBe(true);
    expect(benchOwnBrowser(SAFARI, facts)).toBe(false);
  });

  it("asks the loop's remedy once per wait, reads again at once when a tab was reset, and writes the holder and the reset to the gate line", async () => {
    // The harness's own browser holds it: the remedy clears it (2 tabs).
    let asked = 0;
    let secure = true;
    const cleared = loop({
      gate: () => ({
        secureInput: secure,
        ...(secure ? { secureInputOwner: SAFARI } : {}),
      }),
      remedy: async (gateReport) => {
        asked++;
        expect(gateReport.secureInputOwner).toBe(SAFARI);
        secure = false;
        return 2;
      },
    });
    const outcome = await cleared.run;
    expect(asked).toBe(1);
    expect(cleared.ran).toHaveLength(4);
    // No poll slept: the gate was read again the moment the tabs were reset.
    expect(cleared.ran[0].wait).toBe(0);
    const gates = cleared.lines.filter((line) => line.kind === "gate");
    expect(gates).toEqual([
      {
        kind: "gate",
        at: expect.any(String),
        reason: "SECURE_INPUT",
        reasons: ["SECURE_INPUT"],
        waitedSeconds: 0,
        secureInputOwner: SAFARI,
        browserReset: 2,
      },
    ]);
    expect(outcome.gateWaits.byReason).toEqual({ SECURE_INPUT: 1 });

    // A field of the person's (the remedy answers nothing): waited on like
    // any reason, the remedy asked once though the gate refused three
    // times, the holder named, no reset on the line.
    asked = 0;
    const theirs = loop({
      gate: (_now, calls) =>
        calls < 3 ? { secureInput: true, secureInputOwner: TERMINAL } : {},
      remedy: async () => {
        asked++;
        return undefined;
      },
    });
    await theirs.run;
    expect(asked).toBe(1);
    const held = theirs.lines.filter((line) => line.kind === "gate");
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({
      reason: "SECURE_INPUT",
      waitedSeconds: 45,
      secureInputOwner: TERMINAL,
    });
    expect(held[0]).not.toHaveProperty("browserReset");
    expect(theirs.ran[0].wait).toBe(45);

    // The browser answered but had no fixture tab (0): recorded, and the
    // poll slept rather than reading again.
    const none = loop({
      gate: (_now, calls) =>
        calls < 1 ? { secureInput: true, secureInputOwner: SAFARI } : {},
      remedy: async () => 0,
    });
    await none.run;
    expect(none.lines.filter((line) => line.kind === "gate")[0]).toMatchObject({
      reason: "SECURE_INPUT",
      waitedSeconds: 15,
      browserReset: 0,
    });

    // Without a remedy hook the reason waits like any other, and the line
    // carries neither a holder nor a reset.
    const plain = loop({
      gate: (_now, calls) => (calls < 2 ? { secureInput: true } : {}),
    });
    const plainOutcome = await plain.run;
    const plainGates = plain.lines.filter((line) => line.kind === "gate");
    expect(plainGates[0]).toMatchObject({
      reason: "SECURE_INPUT",
      waitedSeconds: 30,
    });
    expect(plainGates[0]).not.toHaveProperty("secureInputOwner");
    expect(plainGates[0]).not.toHaveProperty("browserReset");
    expect(plainOutcome.gateWaits.byReason.SECURE_INPUT).toBe(1);
    // The ledger's totals read the new fields past.
    expect(gateWaitsOf(gates).byReason).toEqual({ SECURE_INPUT: 1 });
  });

  it("quits the harness's own browser once per wait when its blank tabs still hold the field, reads again at once, and waits on whatever holds it after that", async () => {
    // Cycle 20260919-1522: the reset found every tab blank already (0), and
    // Safari kept secure event input for 50 minutes. Now the remedy answers
    // 0, the gate reads again at once (a quit can follow), Safari still
    // holds it, the escalation quits it, the gate reads again at once, and
    // the field has let go: no poll slept, one quit on the line.
    let remedies = 0;
    let quits = 0;
    let secure = true;
    const cleared = loop({
      gate: () => ({
        secureInput: secure,
        ...(secure ? { secureInputOwner: SAFARI } : {}),
      }),
      remedy: async () => {
        remedies++;
        return 0;
      },
      escalate: async (gateReport) => {
        quits++;
        expect(gateReport.secureInputOwner).toBe(SAFARI);
        secure = false;
        return true;
      },
    });
    const outcome = await cleared.run;
    expect(remedies).toBe(1);
    expect(quits).toBe(1);
    expect(cleared.ran).toHaveLength(4);
    expect(cleared.ran[0].wait).toBe(0);
    const gates = cleared.lines.filter((line) => line.kind === "gate");
    expect(gates).toEqual([
      {
        kind: "gate",
        at: expect.any(String),
        reason: "SECURE_INPUT",
        reasons: ["SECURE_INPUT"],
        waitedSeconds: 0,
        secureInputOwner: SAFARI,
        browserReset: 0,
        browserQuit: true,
      },
    ]);
    expect(outcome.gateWaits.byReason).toEqual({ SECURE_INPUT: 1 });
    expect(gateWaitsOf(gates).byReason).toEqual({ SECURE_INPUT: 1 });

    // Tabs were reset (2), read again at once, and the browser still held
    // the field: the same quit follows.
    quits = 0;
    const afterReset = loop({
      gate: (_now, calls) =>
        calls < 2 ? { secureInput: true, secureInputOwner: SAFARI } : {},
      remedy: async () => 2,
      escalate: async () => {
        quits++;
        return true;
      },
    });
    await afterReset.run;
    expect(quits).toBe(1);
    expect(
      afterReset.lines.filter((line) => line.kind === "gate")[0],
    ).toMatchObject({ waitedSeconds: 0, browserReset: 2, browserQuit: true });

    // Asked to quit and it did not go (a dialog holds it): false on the
    // line, asked once though the gate refused four more times, and every
    // later refusal waited a poll like any reason.
    quits = 0;
    const held = loop({
      gate: (_now, calls) =>
        calls < 5 ? { secureInput: true, secureInputOwner: SAFARI } : {},
      remedy: async () => 0,
      escalate: async () => {
        quits++;
        return false;
      },
    });
    await held.run;
    expect(quits).toBe(1);
    expect(held.lines.filter((line) => line.kind === "gate")[0]).toEqual({
      kind: "gate",
      at: expect.any(String),
      reason: "SECURE_INPUT",
      reasons: ["SECURE_INPUT"],
      waitedSeconds: 60,
      secureInputOwner: SAFARI,
      browserReset: 0,
      browserQuit: false,
    });
    expect(held.ran[0].wait).toBe(60);

    // The browser went, and another holder had the keyboard after it: named
    // and waited on, no second quit this wait.
    quits = 0;
    const another = loop({
      gate: (_now, calls) =>
        calls < 2
          ? { secureInput: true, secureInputOwner: SAFARI }
          : calls < 3
            ? { secureInput: true, secureInputOwner: TERMINAL }
            : {},
      remedy: async () => 0,
      escalate: async () => {
        quits++;
        return true;
      },
    });
    await another.run;
    expect(quits).toBe(1);
    expect(
      another.lines.filter((line) => line.kind === "gate")[0],
    ).toMatchObject({
      waitedSeconds: 15,
      secureInputOwner: SAFARI,
      browserReset: 0,
      browserQuit: true,
    });

    // The holder changed before the escalation (Safari, then Terminal at the
    // confirming read): the quit is for the browser the reset ran on, and
    // that read did not name it, so nothing is quit.
    quits = 0;
    const changed = loop({
      gate: (_now, calls) =>
        calls < 1
          ? { secureInput: true, secureInputOwner: SAFARI }
          : calls < 3
            ? { secureInput: true, secureInputOwner: TERMINAL }
            : {},
      remedy: async () => 0,
      escalate: async () => {
        quits++;
        return true;
      },
    });
    await changed.run;
    expect(quits).toBe(0);
    const changedGate = changed.lines.filter((line) => line.kind === "gate")[0];
    expect(changedGate).toMatchObject({
      secureInputOwner: SAFARI,
      browserReset: 0,
    });
    expect(changedGate).not.toHaveProperty("browserQuit");

    // A field of the person's (the remedy answers nothing): no quit, ever,
    // however long it is held.
    quits = 0;
    const theirs = loop({
      gate: (_now, calls) =>
        calls < 3 ? { secureInput: true, secureInputOwner: TERMINAL } : {},
      remedy: async () => undefined,
      escalate: async () => {
        quits++;
        return true;
      },
    });
    await theirs.run;
    expect(quits).toBe(0);
    expect(
      theirs.lines.filter((line) => line.kind === "gate")[0],
    ).not.toHaveProperty("browserQuit");

    // Without a remedy nothing has run to escalate from.
    quits = 0;
    const noRemedy = loop({
      gate: (_now, calls) =>
        calls < 2 ? { secureInput: true, secureInputOwner: SAFARI } : {},
      escalate: async () => {
        quits++;
        return true;
      },
    });
    await noRemedy.run;
    expect(quits).toBe(0);
    expect(
      noRemedy.lines.filter((line) => line.kind === "gate")[0],
    ).not.toHaveProperty("browserQuit");
  });

  it("keeps a reset's count and code on the row, and nothing else, and sums them in the report", () => {
    expect(
      contentFree(row({ browserReset: { tabs: 2 } })).browserReset,
    ).toEqual({ tabs: 2 });
    expect(
      contentFree(row({ browserReset: { tabs: 0, code: "NOT_RUNNING" } }))
        .browserReset,
    ).toEqual({ tabs: 0, code: "NOT_RUNNING" });
    expect(
      contentFree(
        row({ browserReset: { tabs: 1, code: "http://127.0.0.1:47831/x" } }),
      ).browserReset,
    ).toBeUndefined();
    expect(
      contentFree(row({ browserReset: { tabs: Number.NaN } })).browserReset,
    ).toBeUndefined();
    expect(
      contentFree(row({ browserReset: { tabs: -1 } })).browserReset,
    ).toBeUndefined();
    expect(contentFree(row({})).browserReset).toBeUndefined();
    // Whether the browser was quit after the reset: true kept, anything
    // else dropped.
    expect(
      contentFree(row({ browserReset: { tabs: 0, quit: true } })).browserReset,
    ).toEqual({ tabs: 0, quit: true });
    expect(
      contentFree(row({ browserReset: { tabs: 1, quit: false } })).browserReset,
    ).toEqual({ tabs: 1 });
    expect(
      contentFree(
        row({
          browserReset: { tabs: 1, quit: "yes" as unknown as boolean },
        }),
      ).browserReset,
    ).toEqual({ tabs: 1 });
    const text = renderCycleReport(
      buildCycleResults({
        cycle: info(),
        results: [
          row({ browserReset: { tabs: 2 } }),
          row({ planIndex: 1, browserReset: { tabs: 0, code: "UNREAD" } }),
          row({ planIndex: 2 }),
        ],
        analysis: analyze(parseDiagnostics("").lines),
      }),
    );
    expect(text).toContain(
      "Fixture tabs pointed at about:blank after the attempts, in the browser chosen for each: 2 in 2 attempt(s); not looked at in 1 (UNREAD)",
    );
    expect(text).not.toContain("the browser quit after");
    expect(
      renderCycleReport(
        buildCycleResults({
          cycle: info(),
          results: [
            row({ browserReset: { tabs: 1 } }),
            row({ planIndex: 1, browserReset: { tabs: 0, quit: true } }),
          ],
          analysis: analyze(parseDiagnostics("").lines),
        }),
      ),
    ).toContain(
      "Fixture tabs pointed at about:blank after the attempts, in the browser chosen for each: 1 in 2 attempt(s); the browser quit after 1, its blank tabs still holding secure input (docs/BENCHMARK.md, Cleanup, step 7).",
    );
    expect(
      renderCycleReport(
        buildCycleResults({
          cycle: info(),
          results: [row({})],
          analysis: analyze(parseDiagnostics("").lines),
        }),
      ),
    ).not.toContain("Fixture tabs pointed at about:blank");
  });

  it("reads secure input through the helper's surface at the gate, resets the browser's fixture tabs after each attempt and as the gate's remedy, and asks the preflight after the start facts", () => {
    const cycle = readFileSync(join(root, "scripts/harness-cycle.mjs"), "utf8");
    // The gate's surface read is the runner's own, beside presence.
    const gateAt = cycle.indexOf("readGate: () =>");
    expect(gateAt).toBeGreaterThan(0);
    expect(cycle.slice(gateAt, gateAt + 200)).toMatch(
      /presence: \(\) => controller\.presence\(\),\s+surface: \(\) => controller\.surface\(\),/,
    );
    // The remedy: only the benchmark's own browser, by the preflight's rule,
    // and only its fixture tabs; anything else is named and returns nothing.
    const remedy = cycle.slice(
      cycle.indexOf("remedy: async (report) => {"),
      cycle.indexOf("escalate: async (report, cause) => {"),
    );
    expect(remedy).toContain(
      "owner && BROWSER_APPS.includes(owner) && benchOwnBrowser(owner, facts);",
    );
    expect(remedy).toContain("if (!ours) {");
    expect(remedy.indexOf("return undefined;")).toBeLessThan(
      remedy.indexOf("resetFixtureTabs(run, owner, fixtureUrl())"),
    );
    expect(remedy).toContain("return reset?.tabs;");
    expect(remedy).toContain("gate: secure event input is on");
    // The escalation, between the remedy and afterGate: the same rule, then
    // the one helper, which quits through browser-reset.ts (benchOwnBrowser
    // again, over the facts), traces BrowserQuit with the bundle id, the
    // flag and the code and nothing else, says so on the terminal, and
    // forgets a browser that went as running, for the chooser and for the
    // next look at what a person opened.
    const escalate = cycle.slice(
      cycle.indexOf("escalate: async (report, cause) => {"),
      cycle.indexOf("afterGate: async (pass) => {"),
    );
    // The LEFTOVER cause goes to its own helper first; SECURE_INPUT as before.
    expect(escalate).toContain(
      'if (cause === "LEFTOVER") return quitLeftoverBrowsers(report);',
    );
    expect(escalate).toContain(
      "owner && BROWSER_APPS.includes(owner) && benchOwnBrowser(owner, facts);",
    );
    expect(escalate).toContain("if (!ours) return undefined;");
    expect(escalate).toMatch(
      /const quit = await quitOwnBrowser\(\s+owner,\s+"gate",\s+`secure event input is still on in \$\{owner\}, the benchmark's own browser/,
    );
    expect(escalate).toContain("return quit.quit;");
    const helper = cycle.slice(
      cycle.indexOf("const quitOwnBrowser = async (id, where, why) => {"),
      cycle.indexOf("const refreshSkips = () => {"),
    );
    expect(helper).toContain("quit = await quitBrowser(run, id, facts);");
    // Each sheet the quit met is traced as counts and a flag, then the quit.
    expect(helper).toMatch(
      /for \(const sheet of quit\.sheets \?\? \[\]\)\s+diagnostics\.write\("BrowserSheet", \{\s+browser: id,\s+buttons: sheet\.buttons,\s+cancelled: sheet\.cancelled,\s+\}\);/,
    );
    expect(helper).toMatch(
      /diagnostics\.write\("BrowserQuit", \{\s+browser: id,\s+quit: quit\.quit,\s+\.\.\.\(quit\.code \? \{ code: quit\.code \} : \{\}\),\s+\}\);/,
    );
    expect(helper).toContain(
      "no quit was sent (SHEET_UP): dismiss it yourself",
    );
    expect(helper).toMatch(
      /if \(quit\.quit\) \{\s+facts\.running\?\.delete\(id\);\s+runningAfterLast\?\.delete\(id\);\s+if \(facts\.windows\) delete facts\.windows\[id\];\s+facts\.leftover\?\.delete\(id\);\s+\}/,
    );
    // One quit call in the harness, through the helper, from the gate (the
    // secure-input escalation and the leftover one), from the attempt
    // callback and from the end of the cycle; nothing else quits anything.
    expect(cycle.match(/quitBrowser\(/g)).toHaveLength(1);
    expect(cycle.match(/quitOwnBrowser\(/g)).toHaveLength(4);
    expect(cycle).not.toMatch(/\bkillall\b|\bpkill\b/);
    // After each attempt: after the window accounting, before the row, and
    // never after real input or a stop.
    const attempt = cycle.slice(
      cycle.indexOf("attempt: async (entry, maxCost, gateWaitSeconds)"),
      cycle.indexOf("skipped: (entry, reason) => {"),
    );
    const resetAt = attempt.search(
      /browserReset = await resetFixtureTabs\(\s+run,\s+browser\.browser\.id,\s+fixtureUrl\(\),\s+\);/,
    );
    expect(resetAt).toBeGreaterThan(
      attempt.indexOf("const left = attemptWindows("),
    );
    expect(resetAt).toBeLessThan(attempt.indexOf("return withWindowFields("));
    expect(attempt).toMatch(
      /browser\.browser &&\s+!result\.manualTakeover &&\s+result\.reason !== "MANUAL_INPUT_UNSEEN" &&\s+!state\.stopped/,
    );
    expect(attempt).toContain(
      "{ ...result, ...(browserReset ? { browserReset } : {}) },",
    );
    // The after-attempt quit: only when the reset answered a count, only
    // when the gate's own read (the session's pid, else the surface) still
    // names the browser chosen for the attempt, through the same helper,
    // and the row says so.
    const quitAt = attempt.search(
      /if \(browserReset && !browserReset\.code\) \{\s+const secure = await readSecureInput\(run, \(\) => controller\.surface\(\)\);\s+if \(secure\.on && secure\.owner === browser\.browser\.id\) \{/,
    );
    expect(quitAt).toBeGreaterThan(resetAt);
    expect(quitAt).toBeLessThan(attempt.indexOf("return withWindowFields("));
    expect(attempt).toMatch(
      /const quit = await quitOwnBrowser\(\s+browser\.browser\.id,\s+`\$\{task\.id\} #\$\{entry\.attempt\}`,\s+`secure event input is still on in \$\{browser\.browser\.id\}[^`]*`,\s+\);\s+if \(quit\.quit\) browserReset = \{ \.\.\.browserReset, quit: true \};/,
    );
    expect(cycle).toMatch(
      /const \{\s+RESETTABLE_BROWSERS,\s+benchLeftover,\s+browserUptime,\s+quitBrowser,\s+readTabCounts,\s+resetFixtureTabs,\s+\} = await import\("\.\.\/src\/gym\/bench\/browser-reset\.ts"\);/,
    );
    // The origin is the fixture's, running or not (a tab an earlier cycle left).
    expect(cycle).toMatch(
      /const fixtureUrl = \(\) =>\s+fixture\?\.url \?\? `http:\/\/\$\{FIXTURE_HOST\}:\$\{FIXTURE_PORT\}`;/,
    );
    // The preflight's refusal reads the browsers' windows, so it comes after
    // the start facts, and a running browser with only fixture windows is
    // not the person's.
    expect(cycle.indexOf("const codes = preflight({")).toBeGreaterThan(
      cycle.indexOf("const facts = await readStartFacts(tasks, {"),
    );
    expect(cycle).toContain(
      "  secureInput: personsSecureInput(system.secureInput),\n});",
    );
    expect(cycle).toMatch(
      /const personsSecureInput = \(secure\) =>\s+secure\.on &&\s+!\(\s+secure\.owner &&\s+BROWSER_APPS\.includes\(secure\.owner\) &&\s+benchOwnBrowser\(secure\.owner, facts\)\s+\);/,
    );
    expect(cycle).toContain(", secure input ${");
    // bench.mjs resets the same way after each attempt.
    const bench = readFileSync(join(root, "scripts/bench.mjs"), "utf8");
    expect(bench).toMatch(
      /result\.browserReset = await resetFixtureTabs\(\s+run,\s+browser\.id,\s+fixture\?\.url \?\? `http:\/\/\$\{FIXTURE_HOST\}:\$\{FIXTURE_PORT\}`,\s+\);/,
    );
    expect(bench).toMatch(
      /browser &&\s+!result\.manualTakeover &&\s+result\.reason !== "MANUAL_INPUT_UNSEEN" &&\s+!state\.stopped/,
    );
  });
});

describe("a browser an earlier cycle left", () => {
  const SAFARI = "com.apple.Safari";
  const CHROME = "com.google.Chrome";
  const at = (ms: number) => new Date(ms).toISOString();

  it("asks the escalation with cause LEFTOVER at every pass, writes the quit on the gate line, and counts no wait for it", async () => {
    // Cycles 20260919-2032 and -2038: the gate passed at once with cycle
    // 1952's Safari still running. Now the pass asks the hook, which quits
    // it, and the line records the quit under its own reason with no wait.
    let asked = 0;
    let secureAsked = 0;
    const quit = loop({
      leftover: async (gateReport) => {
        asked++;
        expect(gateReport.hidIdleSeconds).toBe(999);
        return asked === 1 ? true : undefined;
      },
      escalate: async () => {
        secureAsked++;
        return true;
      },
    });
    const outcome = await quit.run;
    expect(quit.ran).toHaveLength(4);
    // Once per pass, four passes; the secure-input cause never asked.
    expect(asked).toBe(4);
    expect(secureAsked).toBe(0);
    const gates = quit.lines.filter((line) => line.kind === "gate");
    expect(gates).toEqual([
      {
        kind: "gate",
        at: expect.any(String),
        reason: "NONE",
        reasons: [],
        waitedSeconds: 0,
        browserQuit: true,
        browserQuitReason: "LEFTOVER",
      },
    ]);
    // No wait: not in the loop's tally, not in the ledger's.
    expect(outcome.gateWaits).toEqual({
      count: 0,
      totalSeconds: 0,
      byReason: {},
      longestSeconds: 0,
      userPresentLong: 0,
    });
    expect(gateWaitsOf(gates).count).toBe(0);
    expect(gateWaitsOf(gates).byReason).toEqual({});
    // Nothing of the kind running: no line at all, as before.
    const none = loop({ leftover: async () => undefined });
    await none.run;
    expect(none.lines.filter((line) => line.kind === "gate")).toEqual([]);
    // Asked and it did not go (a sheet with no Cancel button): false on the
    // line, and the attempt runs anyway.
    const held = loop({ leftover: async () => false });
    await held.run;
    expect(held.ran).toHaveLength(4);
    expect(
      held.lines
        .filter((line) => line.kind === "gate")
        .map((l) => l.browserQuit),
    ).toEqual([false, false, false, false]);
    // After a real wait the quit joins that wait's line, which counts as
    // the wait it was.
    const start = 1_000_000;
    let quits = 0;
    const waited = loop({
      gate: (now) => ({ tapIdleSeconds: (now - start) / 1000 + 10 }),
      leftover: async () => (quits++ === 0 ? true : undefined),
    });
    const waitedOutcome = await waited.run;
    const first = waited.lines.filter((line) => line.kind === "gate")[0];
    expect(first).toMatchObject({
      reason: "HID_ACTIVE",
      reasons: ["HID_ACTIVE"],
      browserQuit: true,
      browserQuitReason: "LEFTOVER",
    });
    expect(first.waitedSeconds).toBeGreaterThan(0);
    expect(waitedOutcome.gateWaits.count).toBe(1);
    expect(waitedOutcome.gateWaits.byReason).toEqual({ HID_ACTIVE: 1 });
    expect(
      gateWaitsOf(waited.lines.filter((line) => line.kind === "gate")).count,
    ).toBe(1);
    // A quit-only line from an older ledger shape (no `reasons`) still
    // counts as its reason says; one with `reasons: []` never does.
    expect(
      gateWaitsOf([
        {
          kind: "gate",
          at: at(0),
          reason: "LOCKED",
          waitedSeconds: 30,
        },
        {
          kind: "gate",
          at: at(0),
          reason: "NONE",
          reasons: [],
          waitedSeconds: 0,
          browserQuit: true,
          browserQuitReason: "LEFTOVER",
        },
      ]),
    ).toMatchObject({ count: 1, byReason: { LOCKED: 1 }, totalSeconds: 30 });
  });

  it("reads the harness's own input and any person seen since a launch from the ledgers", () => {
    const launch = 10_000_000;
    const now = launch + 35 * 60_000;
    const attempt = (when: number, over: Partial<AttemptResult> = {}) =>
      ({
        kind: "attempt",
        at: at(when),
        ...row({ taskId: "a", cell: "m1", ...over }),
      }) as LedgerLine;
    const gate = (when: number, reasons: string[]) =>
      ({
        kind: "gate",
        at: at(when),
        reason: reasons[reasons.length - 1] ?? "NONE",
        reasons,
        waitedSeconds: 15,
      }) as LedgerLine;
    // The evidence: attempts after the launch, the last two minutes ago,
    // nobody seen.
    expect(
      harnessInput(
        [
          attempt(launch - 60_000),
          attempt(launch + 5 * 60_000),
          attempt(now - 2 * 60_000),
          gate(launch + 60_000, ["LOCKED"]),
        ],
        launch,
        now,
      ),
    ).toEqual({ lastInputAgoSeconds: 120, personSeenSinceLaunch: false });
    // A skipped row posted nothing and is not input.
    expect(
      harnessInput(
        [
          attempt(launch + 60_000),
          attempt(now, { runStatus: "skipped", reason: "APPS_OPEN" }),
        ],
        launch,
        now,
      ),
    ).toEqual({
      lastInputAgoSeconds: 34 * 60,
      personSeenSinceLaunch: false,
    });
    // A person seen since the launch: a takeover, real input that cut an
    // attempt short, or a wait on HID_ACTIVE.
    for (const lines of [
      [attempt(launch + 60_000, { manualTakeover: true })],
      [attempt(launch + 60_000, { reason: "MANUAL_INPUT_UNSEEN" })],
      [gate(launch + 60_000, ["LOCKED", "HID_ACTIVE"])],
      [gate(launch, ["HID_ACTIVE"])],
    ])
      expect(harnessInput(lines, launch, now).personSeenSinceLaunch).toBe(true);
    // Seen before the launch: not since it.
    expect(
      harnessInput(
        [
          attempt(launch - 60_000, { manualTakeover: true }),
          gate(launch - 1, ["HID_ACTIVE"]),
          attempt(launch + 60_000),
        ],
        launch,
        now,
      ),
    ).toEqual({
      lastInputAgoSeconds: 34 * 60,
      personSeenSinceLaunch: false,
    });
    // No ledger, or none with an attempt: nothing explained, nobody seen.
    expect(harnessInput([], launch, now)).toEqual({
      personSeenSinceLaunch: false,
    });
    expect(
      harnessInput(
        [
          {
            kind: "start",
            at: at(launch),
            cycle: "c",
            planHash: "",
            gitRev: "",
          },
        ],
        launch,
        now,
      ),
    ).toEqual({ personSeenSinceLaunch: false });
    // A malformed time is skipped, never NaN.
    expect(
      harnessInput([{ ...attempt(now), at: "yesterday" }], launch, now),
    ).toEqual({ personSeenSinceLaunch: false });
  });

  it("treats a leftover browser as the benchmark's own for the choice and the skip, and one with any other tab as the person's", () => {
    const task = LONG_CATALOGUE.find((t) => t.id === "browser-nav-chain")!;
    expect(task.apps).toContain(SAFARI);
    expect(task.apps).toContain(CHROME);
    // Only these two browsers are installed, so no third one is free.
    const installed = new Set([SAFARI, CHROME]);
    // Cycle 2032: Safari (an earlier cycle's, about:blank windows: foreign
    // by the window rule) and Chrome (the person's) both running.
    const theirs = {
      installed,
      running: new Set([SAFARI, CHROME]),
      windows: {
        [SAFARI]: { windows: 2, foreign: 2 },
        [CHROME]: { windows: 3, foreign: 3 },
      },
    };
    expect(chooseBrowser(task, theirs)).toBeUndefined();
    expect(startSkipDetail(task, theirs)).toEqual({
      code: "APPS_OPEN",
      apps: [SAFARI, CHROME],
    });
    // The leftover rule found Safari the benchmark's: chosen, no skip.
    const leftover = { ...theirs, leftover: new Set([SAFARI]) };
    expect(benchOwnBrowser(SAFARI, leftover)).toBe(true);
    expect(benchOwnBrowser(CHROME, leftover)).toBe(false);
    expect(chooseBrowser(task, leftover)?.id).toBe(SAFARI);
    expect(appsOpen(task, leftover)).toEqual([]);
    expect(startSkipDetail(task, leftover)).toBeUndefined();
    // Quit at the gate: not running, the choice falls to it as a fresh
    // launch and nothing is skipped.
    const quit = {
      installed,
      running: new Set([CHROME]),
      windows: { [CHROME]: { windows: 3, foreign: 3 } },
      leftover: new Set<string>(),
    };
    expect(chooseBrowser(task, quit)?.id).toBe(SAFARI);
    expect(startSkipDetail(task, quit)).toBeUndefined();
    // The rule refused it (a tab of the person's, or input since it
    // launched): the person's, APPS_OPEN as before.
    expect(
      startSkipDetail(task, { ...theirs, leftover: new Set<string>() }),
    ).toEqual({ code: "APPS_OPEN", apps: [SAFARI, CHROME] });
    // The remedy says what the harness quits and what it never does.
    expect(REMEDY.APPS_OPEN).toMatch(/at the end of every cycle/);
    expect(REMEDY.APPS_OPEN).toMatch(/nobody has typed since it launched/);
    expect(REMEDY.APPS_OPEN).toMatch(/never quits an application of yours/);
    expect(REMEDY.SECURE_INPUT).toMatch(/SHEET_UP/);
  });

  it("judges leftovers at the start and at every pass, quits them at the gate and at the end, and never in a dry run", () => {
    const cycle = readFileSync(join(root, "scripts/harness-cycle.mjs"), "utf8");
    // At the start, after the facts and before the secure-input rule and
    // the skips, on the system's HID idle; nothing in a dry run.
    const factsAt = cycle.indexOf(
      "const facts = await readStartFacts(tasks, {",
    );
    const startAt = cycle.indexOf('const leftoverAtStart = values["dry-run"]');
    expect(startAt).toBeGreaterThan(factsAt);
    expect(startAt).toBeLessThan(cycle.indexOf("const personsSecureInput ="));
    expect(startAt).toBeLessThan(
      cycle.indexOf("let skips = startSkips(tasks, facts);"),
    );
    expect(cycle.slice(startAt, startAt + 120)).toMatch(
      /\? \[\]\s+: await judgeLeftovers\(system\.hidIdleSeconds \?\? 0\);/,
    );
    // The judgement: the clocks first (ps etime against the idle given and
    // the ledgers), the read-only tab count only when they allow it, a
    // browser the person's by its tabs never read again while its process
    // lives, and the fixture origin the fixed one.
    const judge = cycle.slice(
      cycle.indexOf("const leftoverBrowser = async (id, idleSeconds) => {"),
      cycle.indexOf("const leftoverCandidates = () =>"),
    );
    expect(judge).toMatch(
      /browserUptime\(\s+await run\("ps", \["-axo", "pid=,etime=,command="\]\),\s+id,\s+\)/,
    );
    expect(judge).toContain(
      'if (earlier && earlier.pid === up.pid && earlier.code === "OTHER_TABS")',
    );
    expect(judge).toContain(
      "harness: harnessInput(allLedgerLines(), now - up.seconds * 1000, now),",
    );
    expect(
      judge.indexOf("benchLeftover({ tabs: noTabs, ...clocks })"),
    ).toBeLessThan(judge.indexOf("readTabCounts(run, id, FIXTURE_ORIGIN)"));
    expect(cycle).toContain(
      "const FIXTURE_ORIGIN = `http://${FIXTURE_HOST}:${FIXTURE_PORT}`;",
    );
    // Candidates: running browsers a selected task lists that the window
    // rule reads as the person's, and only ones the scripts can read.
    expect(cycle).toMatch(
      /const leftoverCandidates = \(\) =>\s+appsToWatch\(tasks, facts\.running \?\? \[\]\)\.filter\(\s+\(id\) => RESETTABLE_BROWSERS\.includes\(id\) && !safeOpen\(id, facts\),\s+\);/,
    );
    // At the gate: the LEFTOVER cause, on the gate's own idle (the larger
    // of the tap's clock and HID idle), blanks the tabs, quits through the
    // one helper, and recomputes the skips in place.
    const gate = cycle.slice(
      cycle.indexOf("const quitLeftoverBrowsers = async (report) => {"),
      cycle.indexOf("try {\n  // The fixture server runs as a child process"),
    );
    expect(gate).toContain(
      "Math.max(report.tapIdleSeconds ?? 0, report.hidIdleSeconds ?? 0),",
    );
    expect(gate.indexOf("await resetOwnTabs(entry.id);")).toBeLessThan(
      gate.indexOf(
        'const quit = await quitOwnBrowser(\n      entry.id,\n      "gate",',
      ),
    );
    expect(gate).toContain("if (judged.length) refreshSkips();");
    expect(gate).toContain("return asked;");
    const refresh = cycle.slice(
      cycle.indexOf("const refreshSkips = () => {"),
      cycle.indexOf("const quitLeftoverBrowsers = async (report) => {"),
    );
    expect(refresh).toContain("const fresh = startSkips(tasks, facts);");
    expect(refresh).toContain("skips.delete(id);");
    // The attempt remembers its browser for the end.
    expect(cycle).toContain(
      "if (browser.browser) attemptBrowsers.add(browser.browser.id);",
    );
    // At the end, after the window sweep and before the lock goes back:
    // the attempts' browsers and any leftover, each under benchOwnBrowser,
    // tabs blanked first; a browser of the person's never.
    const finallyAt = cycle.indexOf(
      "} finally {\n  try {\n    await fixture?.close();",
    );
    const end = cycle.slice(
      cycle.indexOf("windowSweep = await closeBenchWindows({", finallyAt),
      cycle.indexOf("releaseDesktopLock(lockFile, process.pid);\n}", finallyAt),
    );
    expect(end).toMatch(
      /for \(const id of new Set\(\[\.\.\.attemptBrowsers, \.\.\.\(facts\.leftover \?\? \[\]\)\]\)\) \{\s+if \(!RESETTABLE_BROWSERS\.includes\(id\) \|\| !benchOwnBrowser\(id, facts\)\)\s+continue;\s+await resetOwnTabs\(id\);\s+await quitOwnBrowser\(\s+id,\s+"end",/,
    );
    // The gate line and the terminal name the leftover as such.
    expect(cycle).toContain(
      ', leftover browsers ${leftoverAtStart.length ? leftoverAtStart.map(describeLeftover).join("; ") : ',
    );
    expect(cycle).toContain("not judged in a dry run");
  });
});
