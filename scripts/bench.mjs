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
const { CATALOGUE, CATEGORIES, selectTasks } =
  await import("../src/gym/bench/catalogue.ts");
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
    // Unattended approval of the prompts a task lists as routine, word for
    // word (BenchTask.approve). Off by default: a declined approval is a real
    // benchmark result.
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
  --continue-on-takeover       Keep going after an agent hand-off instead of
                               stopping. Real input on this Mac always stops.
  --approve-routine            Approve only the prompts a task lists as routine.
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
        "  prepare:  resolves per-attempt values (operands, a marker, an indexed file); skipped as unknown when nothing matches",
      );
    if (task.approve?.length)
      console.log(`  approve:  ${task.approve.join(" | ")}`);
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
const { MemoryStore } = await import("../src/memory/store.ts");
const { createMemoryAccess } = await import("../src/memory/access.ts");
// The attempt itself (neutral start, prepare, run, grading read, cleanup) is
// shared with harness-cycle.mjs; it loads the runner.
const {
  createHarnessState,
  launchServices,
  onEmergencyStop,
  onManualInput,
  runAttempt,
} = await import("../src/gym/bench/attempt.ts");

if (!["openai", "anthropic", "google"].includes(values.provider)) {
  console.error("--provider must be openai, anthropic or google.");
  process.exit(2);
}
// The model goes to selectProvider so it is priced at its own catalog rates:
// set afterwards, it would run at the provider default's rates, and every
// cost cap would be checked against that estimate. A model the catalog does
// not price gets zero rates, and the provider refuses it below.
const selected = selectProvider(defaultSettings, values.provider, values.model);
const baseSettings = { ...selected, memory: values.memory };
const cell = `${baseSettings.provider}:${baseSettings.model}`;
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
  `\nOpen Assist benchmark: ${plan.length} run(s) on this Mac with ${cell}.\n` +
    `Total cost ceiling $${budget.toFixed(2)}. Move the mouse or press a key to stop the benchmark;\n` +
    "it also stops at the first agent hand-off unless --continue-on-takeover.\n",
);

// One agent on this desktop at a time: the lock every cycle and bench on
// this Mac takes, from any checkout. Each harness's helper marks its own
// input, so neither's tap could see the other.
const { acquireDesktopLock, desktopLockPath, releaseDesktopLock } =
  await import("../src/gym/bench/presence.ts");
const lockFile = desktopLockPath();
const lock = acquireDesktopLock(lockFile, {
  pid: process.pid,
  script: "bench",
  startedAt: new Date().toISOString(),
});
if (!lock.ok) {
  console.error(
    lock.holder
      ? `Refusing to start: ${lock.holder.script}${lock.holder.cycle ? " " + lock.holder.cycle : ""} is driving this desktop (pid ${lock.holder.pid}).`
      : `Refusing to start: the desktop lock ${lockFile} cannot be read. Remove it if no cycle or bench is running.`,
  );
  process.exit(2);
}
process.on("exit", () => releaseDesktopLock(lockFile, process.pid));

// Shared with the controller's callbacks: Escape stops everything, real input
// stops the run outright (see attempt.ts for why not a manual takeover).
const state = createHarnessState();
process.on("SIGINT", () => {
  if (state.stopped) process.exit(130);
  state.stopped = true;
  try {
    state.runner?.stop("Benchmark interrupted from the terminal.");
  } catch {}
});
const controller = new NativeController(
  binary,
  onEmergencyStop(state),
  onManualInput(state),
);

let memoryStore;
let memoryAccess;
if (values.memory) {
  // A scratch store with its own random key, like the live harness: the
  // benchmark learns across its own attempts without touching a real profile.
  const memoryDir = resolve(
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

const deps = {
  controller,
  clients: { [cell]: client },
  state,
  memoryAccess,
  // The suite's end-state readers and cleanup arrive with the long suite; the
  // smoke tasks read nothing beyond the grading capture.
  readEvidence: null,
  cleanupAttempt: null,
  launch: launchServices(),
};
const attemptCell = {
  provider: baseSettings.provider,
  model: baseSettings.model,
  cell,
  settings: settingsSchema.parse(baseSettings),
};

const results = [];
let stoppedBecause;
try {
  await controller.configure(settingsSchema.parse(baseSettings));
  for (const [planIndex, { task, attempt }] of plan.entries()) {
    if (state.stopped) {
      stoppedBecause = state.emergency ? "emergency stop" : "interrupted";
      break;
    }
    const spent = results.reduce((total, result) => total + result.cost, 0);
    if (spent + 0.01 > budget) {
      stoppedBecause = "cost budget";
      break;
    }
    const result = await runAttempt(deps, attemptCell, task, attempt, {
      maxCost: Math.min(task.maxCost, budget - spent),
      approveRoutine: values["approve-routine"],
      planIndex,
    });
    results.push(result);
    console.log(
      `${result.taskId} #${result.attempt}  ${result.status}${result.reason ? " (" + result.reason + ")" : ""}  ${result.actions} actions  ${result.seconds.toFixed(1)}s  $${result.cost.toFixed(3)}`,
    );
    if (state.stopped) continue;
    // Someone is at the Mac. Nothing here can tell when they have left, so
    // the next attempt would re-arm the tap 1.5 s later and be cancelled
    // again, one capture and one model call at a time; the flag covers agent
    // hand-offs only. harness-cycle.mjs waits for them to leave instead.
    if (result.manualTakeover || result.reason === "MANUAL_INPUT_UNSEEN") {
      stoppedBecause = "manual input";
      break;
    }
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
      schema_version: 2,
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
