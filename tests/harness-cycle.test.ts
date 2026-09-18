import { afterAll, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  defaultSettings,
  type Action,
  type Observation,
  type ProviderResult,
  type Settings,
  type Snapshot,
  type Surface,
} from "../src/core/schema";
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
  agendaLocalSource,
  appProcesses,
  desktopLockPath,
  gateDecision,
  harnessProcesses,
  idleRequired,
  parseAssertions,
  parseConsoleLocked,
  parseHidIdle,
  parseScreensaverIdle,
  preflight,
  readGate,
  readSystem,
  releaseDesktopLock,
  unsettledRuns,
  type GateReport,
  type PreflightInput,
  type PresenceReport,
  type PresenceSource,
} from "../src/gym/bench/presence";
import {
  attemptCap,
  buildPlan,
  ceiling,
  cellPrices,
  cellSettings,
  defaultCycleId,
  designHash,
  estimateSeconds,
  fitsTimeBox,
  gateWaitsOf,
  ledgerResults,
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
  compareCycles,
  compareModels,
  selectBaseline,
  type ComparableCycle,
} from "../src/gym/bench/compare";
import {
  HARNESS_VERSION,
  buildCycleResults,
  catalogueHash,
  classRates,
  comparable,
  failureClasses,
  renderCycleReport,
  type CycleInfo,
} from "../src/gym/bench/cycle-report";
import {
  analyze,
  frictionCodes,
  ownerOf,
  parseDiagnostics,
} from "../src/gym/bench/analyze";
import { ran, type AttemptResult } from "../src/gym/bench/report";
import type { BenchTask, TakeoverSource } from "../src/gym/bench/types";

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
    evaluate: (
      a: Action,
      s: Surface,
      st: Settings,
      synthetic: boolean,
    ): Decision => policy.evaluate?.(a) ?? actual.evaluate(a, s, st, synthetic),
  };
});

/* --------------------------------------------------------------- fixtures */

const CALC = "com.apple.Calculator";
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
      return { appId, pid: 7, secureInput: false, unknown: false };
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

  it("stops the run outright on real input, even while it is confirming", async () => {
    policy.evaluate = (a) =>
      a.type === "click"
        ? { kind: "CONFIRM", reason: "Save these changes?" }
        : { kind: "ALLOW", reason: "" };
    try {
      const { controller, calls } = fakeController();
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
        testTask({ approve: ["Save these changes?"] }),
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
        const { controller, calls } = fakeController();
        const { deps } = attemptDeps(controller, {
          clients: {
            [CELL.cell]: scripted([{ type: "click", x: 0.5, y: 0.5 }]),
          },
        });
        const result = await runAttempt(
          deps,
          CELL,
          testTask({ approve: ["Save these changes?"] }),
          1,
          { maxCost: 0.05, approveRoutine },
        );
        return { result, clicked: calls.includes("execute:click") };
      };
      const listed = await run("Save these changes?", true);
      expect(listed.clicked).toBe(true);
      expect(listed.result.approvalsDeclined).toBe(0);
      // Same shape of question, not on the list: declined, and answered
      // once although the runner publishes the prompt in two snapshots.
      const order = await run("Place this order?", true);
      expect(order.clicked).toBe(false);
      expect(order.result.approvals).toBe(1);
      expect(order.result.approvalsDeclined).toBe(1);
      const off = await run("Save these changes?", false);
      expect(off.clicked).toBe(false);
      expect(off.result.approvalsDeclined).toBe(1);
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

describe("the agenda helper's local source", () => {
  // Shapes coarena-agenda prints (native/macos/Agenda.swift): status carries
  // access only; setup carries the containers it made, or an error code.
  const access = { calendar: "granted", reminders: "granted" };
  it("reads status when it reports the source, and setup otherwise", () => {
    expect(agendaLocalSource({ access })).toBeUndefined();
    expect(agendaLocalSource({ access, localSource: true })).toBe(true);
    expect(agendaLocalSource({ access, localSource: false })).toBe(false);
    expect(
      agendaLocalSource(
        { access },
        {
          access,
          containers: {
            calendar: "OpenAssistBench",
            reminders: "OpenAssistBench",
          },
        },
      ),
    ).toBe(true);
    for (const error of ["NO_LOCAL_SOURCE", "NO_ACCESS", "SETUP_FAILED"])
      expect(agendaLocalSource({ access }, { access, error }), error).toBe(
        false,
      );
    // No helper output at all is a refusal at the start.
    expect(agendaLocalSource(undefined, null)).toBe(false);
    expect(agendaLocalSource(undefined, { access, containers: {} })).toBe(
      false,
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
    expect(preflight({ ...clear, agendaLocalSource: false })).toEqual([
      "NO_LOCAL_SOURCE",
    ]);
    expect(preflight({ ...clear, agendaLocalSource: true })).toEqual([]);
    expect(preflight({ ...clear, fixturePortFree: false })).toEqual([
      "FIXTURE_PORT",
    ]);
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
function traced(args: string[]) {
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
    { cwd: root, encoding: "utf8", timeout: 60000 },
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

  it("takes the one desktop lock before any wait, in both harnesses", () => {
    const cycle = readFileSync(join(root, "scripts/harness-cycle.mjs"), "utf8");
    const paid = cycle.indexOf(
      "// Nothing below this line is loaded by --dry-run",
    );
    const take = cycle.indexOf("acquireDesktopLock(lockFile");
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

  it("is wired as npm run cycle", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.scripts.cycle).toBe("node scripts/harness-cycle.mjs");
  });
});
