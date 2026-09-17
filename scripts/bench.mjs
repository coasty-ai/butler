// Open Assist automation benchmark.
//
// PAID and REAL: every attempt drives this Mac's desktop with a cloud model,
// exactly like `npm run test:live`. Nothing runs without
// --i-know-this-drives-my-mac. Use --dry-run first: it lists what would run and
// touches neither a provider nor the desktop.
//
//   node scripts/bench.mjs --dry-run
//   node scripts/bench.mjs --provider openai --tasks calculator \
//        --i-know-this-drives-my-mac
//
// Screenshots stay in memory, and nothing this script writes contains screen
// text, window titles, URLs or file paths: results hold task ids, counts,
// durations, cost and fixed reason codes.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

// The catalogue, graders and aggregation are TypeScript so the tests can check
// them directly. tsx is registered here rather than on the command line so
// `node scripts/bench.mjs` works on its own.
const { register } = await import("tsx/esm/api");
register();
const { CATALOGUE, CATEGORIES, benchToken, selectTasks } =
  await import("../src/gym/bench/catalogue.ts");
const { fillInstruction, gradeTask } =
  await import("../src/gym/bench/graders.ts");
const { aggregate, renderSummary, renderTable } =
  await import("../src/gym/bench/report.ts");

const { values } = parseArgs({
  options: {
    provider: { type: "string", default: "openai" },
    model: { type: "string" },
    tasks: { type: "string" },
    repeat: { type: "string", default: "1" },
    "max-cost": { type: "string" },
    memory: { type: "boolean", default: false },
    "memory-dir": { type: "string" },
    "dry-run": { type: "boolean", default: false },
    "i-know-this-drives-my-mac": { type: "boolean", default: false },
    "continue-on-takeover": { type: "boolean", default: false },
    // Unattended approval of routine, non-consequential steps, with the same
    // word filter the live harness uses. Off by default: a declined approval is
    // a real benchmark result.
    "approve-routine": { type: "boolean", default: false },
    out: { type: "string" },
    help: { type: "boolean", default: false },
  },
});

const usage = `Usage: node scripts/bench.mjs [options]

  --dry-run                    List what would run. No model call, no desktop.
  --i-know-this-drives-my-mac  Required to actually run. PAID and REAL.
  --provider openai|anthropic|google
  --model <id>
  --tasks <ids|categories>     Comma separated. Categories: ${CATEGORIES.join(", ")}
  --repeat <n>                 Attempts per task (default 1).
  --max-cost <dollars>         Total budget for the whole benchmark.
  --memory                     Use the learned-memory path (recall and skills).
  --memory-dir <dir>           Where that scratch memory store lives.
  --continue-on-takeover       Keep going after a hand-off instead of stopping.
  --approve-routine            Approve routine, non-consequential prompts.
  --out <file>                 Result file (default output/bench/<timestamp>.json).`;

if (values.help) {
  console.log(usage);
  process.exit(0);
}

const repeat = Number(values.repeat);
if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 20) {
  console.error("--repeat must be a whole number between 1 and 20.");
  process.exit(2);
}
const { tasks, unknown } = selectTasks(values.tasks, CATALOGUE);
if (unknown.length) {
  console.error(
    `Unknown task or category: ${unknown.join(", ")}. Known categories: ${CATEGORIES.join(", ")}.`,
  );
  process.exit(2);
}
if (!tasks.length) {
  console.error("No tasks selected.");
  process.exit(2);
}
const ceiling = tasks.reduce((total, task) => total + task.maxCost, 0) * repeat;
const budget = values["max-cost"] ? Number(values["max-cost"]) : ceiling;
if (!Number.isFinite(budget) || budget <= 0) {
  console.error("--max-cost must be a positive number of dollars.");
  process.exit(2);
}

const plan = [];
for (let attempt = 1; attempt <= repeat; attempt++)
  for (const task of tasks) plan.push({ task, attempt });

if (values["dry-run"]) {
  console.log(
    `Dry run: ${tasks.length} task(s) x ${repeat} attempt(s) = ${plan.length} runs.`,
  );
  console.log(
    `Cost ceiling ${"$" + budget.toFixed(2)} (the sum of the per-task caps${values["max-cost"] ? ", capped by --max-cost" : ""}).`,
  );
  console.log("No provider call and no desktop input happen in a dry run.\n");
  for (const task of tasks) {
    console.log(
      `${task.id}  [${task.category}/${task.difficulty}]  cap $${task.maxCost.toFixed(2)}, ${task.maxActions} actions, ${task.maxSeconds}s`,
    );
    console.log(`  say:      ${task.instruction}`);
    const apps = task.apps.length
      ? task.apps.slice(0, 3).join(", ") +
        (task.apps.length > 3 ? ` (+${task.apps.length - 3} more)` : "")
      : "resolved at run time";
    console.log(`  apps:     ${apps}`);
    console.log(`  verifies: ${task.verifies}`);
    console.log(`  safety:   ${task.safety}`);
    if (task.prepare)
      console.log(
        "  prepare:  resolves per-attempt values from the system index; skipped as unknown when nothing matches",
      );
  }
  process.exit(0);
}

if (!values["i-know-this-drives-my-mac"]) {
  console.error(
    "Refusing to start.\n" +
      "This benchmark clicks, types and launches applications on this Mac, and it\n" +
      "calls a paid model for every step. Watch the screen while it runs.\n" +
      "Re-run with --i-know-this-drives-my-mac, or use --dry-run first.\n\n" +
      usage,
  );
  process.exit(2);
}

const binary = resolve(root, "native/bin/coarena-controller");
if (!existsSync(binary)) {
  console.error("Build the native controller with npm run build:native.");
  process.exit(2);
}

// Nothing below this line is loaded by --dry-run.
const { NativeController } = await import("../electron/controller.ts");
const { importEnvCredentials, providerKey } =
  await import("../electron/credentials.ts");
const { HttpProvider } = await import("../src/providers/http.ts");
const { selectProvider } = await import("../src/providers/catalog.ts");
const { defaultSettings, settingsSchema } =
  await import("../src/core/schema.ts");
const { Runner, terminal } = await import("../src/core/runner.ts");
const { MemoryStore } = await import("../src/memory/store.ts");
const { createMemoryAccess } = await import("../src/memory/access.ts");

if (!["openai", "anthropic", "google"].includes(values.provider)) {
  console.error("--provider must be openai, anthropic or google.");
  process.exit(2);
}
const selected = selectProvider(defaultSettings, values.provider);
const baseSettings = {
  ...selected,
  model: values.model ?? selected.model,
  memory: values.memory,
};
const keys = importEnvCredentials(resolve(root, ".env"), {});
let client;
try {
  client = new HttpProvider(
    settingsSchema.parse(baseSettings),
    providerKey(keys, settingsSchema.parse(baseSettings)),
    fetch,
  );
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Provider setup failed.",
  );
  process.exit(2);
}

console.warn(
  `\nOpen Assist benchmark: ${plan.length} run(s) on this Mac with ${baseSettings.provider}/${baseSettings.model}.\n` +
    `Total cost ceiling $${budget.toFixed(2)}. Move the mouse or press a key to take over;\n` +
    "the benchmark stops at the first hand-off unless --continue-on-takeover.\n",
);

let stopped = false;
let runner;
let controller;
const interrupt = () => {
  stopped = true;
  try {
    runner?.stop("Benchmark interrupted from the terminal.");
  } catch {}
};
process.on("SIGINT", () => {
  if (stopped) process.exit(130);
  interrupt();
});

let manualInput = false;
controller = new NativeController(
  binary,
  () => {
    manualInput = true;
    runner?.stop("Native emergency stop activated.");
  },
  () => {
    manualInput = true;
    runner?.manualTakeover();
  },
);

// Executed steps, captured where the controller already has the action, the
// frame and the native result. Stays in memory; never written to the report.
let steps = [];
const execute = controller.execute.bind(controller);
controller.execute = async (action, frame, signal) => {
  const result = await execute(action, frame, signal);
  steps.push({
    type: action.type,
    appId: frame?.appId,
    textLength:
      typeof action.text === "string" ? action.text.length : undefined,
    launchedAppId: result?.launched?.appId,
    launchedFrontmost: result?.launched?.frontmost,
    openedPath: result?.opened?.path,
    openedAppId: result?.opened?.appId,
  });
  return result;
};

let memoryStore;
let memoryAccess;
let memoryDir;
if (values.memory) {
  // A scratch store with its own random key, like the live harness: the
  // benchmark learns across its own attempts without touching a real profile.
  memoryDir = resolve(
    values["memory-dir"] ?? join(tmpdir(), "open-assist-bench-memory"),
  );
  mkdirSync(memoryDir, { recursive: true, mode: 0o700 });
  const keyFile = join(memoryDir, "bench-memory.key");
  if (!existsSync(keyFile))
    writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
  memoryStore = new MemoryStore(memoryDir, readFileSync(keyFile), undefined, {
    onError: () => console.log(JSON.stringify({ memoryError: true })),
  });
  memoryAccess = createMemoryAccess(
    memoryStore,
    (query) => controller.request("index", { query }),
    { onError: () => console.log(JSON.stringify({ memoryError: true })) },
  );
}

const sensitive =
  /\b(send|delete|pay|purchase|publish|install|password|security)/i;
const results = [];

/** One attempt: run the task, read the end state back, grade it. */
async function runAttempt(task, attempt) {
  const counters = {
    approvals: 0,
    approvalsDeclined: 0,
    retries: 0,
    takeovers: 0,
    loops: 0,
    modelCalls: 0,
    failures: {},
  };
  let parameters = {};
  if (task.prepare) {
    const resolved = await task.prepare({
      index: (query) => controller.request("index", { query }),
      token: () => benchToken(),
    });
    if (!resolved)
      return {
        taskId: task.id,
        category: task.category,
        difficulty: task.difficulty,
        attempt,
        status: "unknown",
        reason: "NO_PREPARED_TARGET",
        checks: {},
        runStatus: "skipped",
        actions: 0,
        seconds: 0,
        cost: 0,
        modelCalls: 0,
        approvals: 0,
        approvalsDeclined: 0,
        retries: 0,
        takeovers: 0,
        loops: 0,
        failures: {},
      };
    parameters = resolved;
  }
  const spent = results.reduce((total, result) => total + result.cost, 0);
  const settings = settingsSchema.parse({
    ...baseSettings,
    maxActions: task.maxActions,
    maxSeconds: task.maxSeconds,
    maxCost: Math.max(0.01, Math.min(task.maxCost, budget - spent)),
  });
  let run = null;
  let printed = 0;
  let lastPending;
  let held;
  const recorder = {
    begin: (r) => {
      run = r;
    },
    save: (r) => {
      run = r;
    },
    frame: () => {},
    append: (runId, type, data = {}) => ({
      event_id: crypto.randomUUID(),
      run_id: runId,
      sequence_number: 0,
      monotonic_timestamp: performance.now(),
      wall_clock_timestamp: new Date().toISOString(),
      schema_version: 1,
      type,
      data,
    }),
  };
  const emit = (snapshot) => {
    for (const event of snapshot.events.slice(printed)) {
      const d = event.data ?? {};
      if (event.type === "ModelRequestStarted") counters.modelCalls++;
      if (event.type === "ActionRetargetRequested") counters.retries++;
      if (event.type === "PolicyConfirmationRequested") counters.approvals++;
      if (event.type === "UserTakeoverStarted") counters.takeovers++;
      if (event.type === "ActionLoopDetected") counters.loops++;
      if (event.type === "ActionFailed" && typeof d.code === "string")
        counters.failures[d.code] = (counters.failures[d.code] ?? 0) + 1;
      if (event.type === "UserDenied" && d.source === "approval")
        counters.approvalsDeclined++;
    }
    printed = snapshot.events.length;
    const status = snapshot.run?.status;
    if (
      status === "confirming" &&
      snapshot.pending &&
      snapshot.pending !== lastPending
    ) {
      lastPending = snapshot.pending;
      const approve =
        values["approve-routine"] && !sensitive.test(snapshot.pending.reason);
      if (!approve) counters.approvalsDeclined++;
      setTimeout(() => runner.confirm(approve), 0);
    }
    if (status !== "confirming") lastPending = undefined;
    if (status === "paused" || status === "takeover") {
      if (held === status) return;
      held = status;
      // Nobody is there to say continue during an unattended benchmark.
      setTimeout(() => runner.stop(`Benchmark stopped at ${status}.`), 0);
    }
  };
  steps = [];
  manualInput = false;
  runner = new Runner(
    controller,
    client,
    recorder,
    settings,
    emit,
    [],
    memoryAccess,
  );
  const started = Date.now();
  try {
    await runner.start(fillInstruction(task.instruction, parameters));
  } catch (error) {
    // A thrown start is already recorded in the run status; keep going.
  }
  const seconds = (Date.now() - started) / 1000;
  const journal = {
    status: run?.status ?? "failed",
    settled: terminal(run?.status ?? "failed"),
    actions: run?.actions ?? 0,
    steps,
    approvals: counters.approvals,
    approvalsDeclined: counters.approvalsDeclined,
    retries: counters.retries,
    takeovers: counters.takeovers,
    manualTakeover: manualInput,
    loops: counters.loops,
    failures: counters.failures,
    cost: run?.usage?.cost ?? 0,
    seconds,
    modelCalls: counters.modelCalls,
  };
  // The end state, read back through the native controller: frontmost bundle
  // id, the committed page host and the window's accessibility text. No pixels.
  let evidence = { journal, parameters };
  try {
    const surface = await controller.surface();
    const frame = await controller.capture();
    evidence = {
      journal,
      parameters,
      appId: frame?.appId ?? surface?.appId,
      context: frame?.context,
      domain: surface?.domain,
    };
  } catch {
    evidence = { journal, parameters, reason: "NO_END_STATE" };
  }
  const grade = evidence.appId
    ? gradeTask(task, evidence)
    : { status: "unknown", checks: {}, reason: "NO_END_STATE" };
  return {
    taskId: task.id,
    category: task.category,
    difficulty: task.difficulty,
    attempt,
    status: grade.status,
    reason: grade.reason,
    checks: grade.checks,
    runStatus: journal.status,
    actions: journal.actions,
    seconds,
    cost: journal.cost,
    modelCalls: journal.modelCalls,
    approvals: journal.approvals,
    approvalsDeclined: journal.approvalsDeclined,
    retries: journal.retries,
    takeovers: journal.takeovers,
    loops: journal.loops,
    failures: journal.failures,
  };
}

let stoppedBecause;
try {
  await controller.configure(settingsSchema.parse(baseSettings));
  for (const { task, attempt } of plan) {
    if (stopped) {
      stoppedBecause = "interrupted";
      break;
    }
    const spent = results.reduce((total, result) => total + result.cost, 0);
    if (spent + 0.01 > budget) {
      stoppedBecause = "cost budget";
      break;
    }
    const result = await runAttempt(task, attempt);
    results.push(result);
    console.log(
      `${result.taskId} #${result.attempt}  ${result.status}${result.reason ? " (" + result.reason + ")" : ""}  ${result.actions} actions  ${result.seconds.toFixed(1)}s  $${result.cost.toFixed(3)}`,
    );
    if (result.takeovers > 0 && !values["continue-on-takeover"]) {
      stoppedBecause = "hand-off";
      break;
    }
  }
} catch (error) {
  stoppedBecause = "error";
  console.error(
    JSON.stringify({
      error: error instanceof Error ? error.name : "Benchmark failed.",
    }),
  );
} finally {
  try {
    memoryStore?.flush();
  } catch {}
  controller.close();
}

const totals = aggregate(results);
console.log("");
console.log(renderTable(results));
console.log("");
console.log(renderSummary(totals));
if (stoppedBecause)
  console.log(
    `\nStopped early: ${stoppedBecause}. ${plan.length - results.length} attempt(s) did not run.`,
  );

const file = resolve(
  root,
  values.out ??
    `output/bench/${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
);
mkdirSync(dirname(file), { recursive: true });
writeFileSync(
  file,
  JSON.stringify(
    {
      schema_version: 1,
      startedAt: new Date().toISOString(),
      provider: baseSettings.provider,
      model: baseSettings.model,
      memory: values.memory,
      repeat,
      budget,
      selected: tasks.map((task) => task.id),
      stoppedBecause,
      // Task instructions are recorded as their template. A filled instruction
      // can name one of the user's own files.
      catalogue: tasks.map((task) => ({
        id: task.id,
        category: task.category,
        difficulty: task.difficulty,
        maxCost: task.maxCost,
        instruction: task.instruction,
        verifies: task.verifies,
      })),
      results,
      aggregate: totals,
    },
    null,
    2,
  ) + "\n",
);
console.log(`\nWrote ${file}`);
process.exit(totals.failed === 0 && !stoppedBecause ? 0 : 1);
