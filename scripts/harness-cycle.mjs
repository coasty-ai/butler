// Open Assist harness cycle: an unattended, repeatable measurement across a
// matrix of models, run while nobody is at the Mac.
//
// PAID and REAL: every attempt drives this Mac's desktop with a cloud model,
// like `npm run bench`. Nothing runs without --i-know-this-drives-my-mac, and
// no attempt starts until the Mac has been left alone for --idle seconds
// (300 by default). --dry-run and --preflight touch neither a provider nor
// the desktop; they read a few system counters and print.
//
//   node scripts/harness-cycle.mjs --dry-run
//   node scripts/harness-cycle.mjs --preflight --time-box 4h
//   node scripts/harness-cycle.mjs --matrix openai,google --tasks calculator \
//        --repeat 2 --i-know-this-drives-my-mac
//
// Screenshots stay in memory, and nothing this script writes contains screen
// text, window titles, URLs or file paths: results.json and report.md hold
// task templates, ids, counts, durations, cost and fixed codes, and the
// cycle's own diagnostics log is written without verbose content.
// See docs/HARNESS_LOOP.md.
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { arch, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

// Pure modules only until the dry-run and preflight exits: the plan, the
// presence rules, the report and the price table. tsx is registered here so
// `node scripts/harness-cycle.mjs` works on its own.
const { register } = await import("tsx/esm/api");
register();
const { CATALOGUE, CATEGORIES, selectTasks } =
  await import("../src/gym/bench/catalogue.ts");
const {
  CYCLE_ID,
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
  runCycleLoop,
  seedOf,
  shardOf,
} = await import("../src/gym/bench/cycle.ts");
const {
  acquireDesktopLock,
  agendaLocalSource,
  desktopLockPath,
  preflight,
  readGate,
  readSystem,
  releaseDesktopLock,
} = await import("../src/gym/bench/presence.ts");
const {
  buildCycleResults,
  catalogueHash,
  classRates,
  comparable,
  renderCycleReport,
} = await import("../src/gym/bench/cycle-report.ts");
const { compareCycles, selectBaseline } =
  await import("../src/gym/bench/compare.ts");
const { analyze, parseDiagnostics } =
  await import("../src/gym/bench/analyze.ts");
const { median, renderSummary } = await import("../src/gym/bench/report.ts");
// The whole module: its per-model price table, where it has one, prices the
// cells (cellPrices).
const catalog = await import("../src/providers/catalog.ts");
const { providerDefaults } = catalog;

const { values } = parseArgs({
  options: {
    matrix: { type: "string" },
    tasks: { type: "string" },
    repeat: { type: "string", default: "3" },
    seed: { type: "string" },
    shard: { type: "string" },
    "max-cost": { type: "string" },
    "max-cost-run": { type: "string", default: "0.50" },
    "max-cost-model": { type: "string" },
    "time-box": { type: "string", default: "4h" },
    cooldown: { type: "string", default: "8" },
    idle: { type: "string", default: "300" },
    "gate-poll": { type: "string", default: "15" },
    "app-diagnostics": { type: "string" },
    "no-keep-awake": { type: "boolean", default: false },
    "allow-app-running": { type: "boolean", default: false },
    "allow-display-holder": { type: "string" },
    "stop-on-handoff": { type: "boolean", default: false },
    requeue: { type: "string", default: "1" },
    "approve-routine": { type: "boolean", default: false },
    memory: { type: "boolean", default: false },
    "memory-dir": { type: "string" },
    cycle: { type: "string" },
    resume: { type: "string" },
    baseline: { type: "string", default: "auto" },
    probe: { type: "string" },
    "out-dir": { type: "string", default: "output/harness" },
    "allow-rev-change": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    preflight: { type: "boolean", default: false },
    "i-know-this-drives-my-mac": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

const usage = `Usage: node scripts/harness-cycle.mjs [options]     (npm run cycle -- [options])

Plan
  --matrix <provider[:model],...>  Cells. Default openai. A bare provider uses its default model.
  --tasks <ids|categories|all>     Categories: ${CATEGORIES.join(", ")}. Default all.
  --repeat <n>                     Attempts per task per model, 1-20. Default 3.
  --seed <n>                       Interleaving seed. Default: a hash of the cycle id.
  --shard <i/n>                    Run slice i of n of the same plan.
Money and time
  --max-cost <dollars>             Cycle cap. Default: the plan's ceiling.
  --max-cost-run <dollars>         Per-attempt cap under the task's own. Default 0.50.
  --max-cost-model <dollars>       Per-model cap. Default: the cycle cap split evenly.
  --time-box <4h|90m|...>          Wall clock for the whole cycle, gate waits included. Default 4h.
  --cooldown <seconds>             Gap between attempts. Default 8.
Presence
  --idle <seconds>                 Idle required at the start and after any input; 300 or more. Default 300.
  --gate-poll <seconds>            Re-check interval while waiting. Default 15.
  --app-diagnostics <file>         The app's log, for "no active app run".
  --allow-app-running              Start although the Open Assist app is running.
  --allow-display-holder <names>   Process names whose display-sleep assertion is not a person watching.
  --no-keep-awake                  Do not start caffeinate -d.
Behaviour
  --stop-on-handoff                End the cycle at the first agent hand-off.
  --requeue <n>                    Re-run an attempt real input cut short, at most n times (0-1). Default 1.
  --approve-routine                Approve only the prompts a task lists as routine.
  --memory, --memory-dir <dir>     As bench.
Cycle
  --cycle <id>                     Name. Default <YYYYMMDD-HHMM>-<rev>.
  --resume <id>                    Continue an interrupted cycle from its ledger.
  --allow-rev-change               Resume at a different git revision.
  --baseline <id|auto|none>        Cycle to compare against. Default auto.
  --probe <CLASS_CODE>             Only the cells and categories the class touched in --baseline <id>.
  --out-dir <dir>                  Default output/harness.
  --dry-run                        Print the plan, ceilings, estimate, gate state and baseline.
  --preflight                      Check this Mac for an unattended night and exit.
  --i-know-this-drives-my-mac      Required to run. PAID and REAL.`;

if (values.help) {
  console.log(usage);
  process.exit(0);
}
const fail = (message) => {
  console.error(message);
  process.exit(2);
};

/* ------------------------------------------------------------- arguments */

const number = (flag, min, max, integer = false) => {
  const value = Number(values[flag]);
  if (
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isSafeInteger(value))
  )
    fail(
      `--${flag} must be ${integer ? "a whole number" : "a number"} between ${min} and ${max}.`,
    );
  return value;
};
const runCapFlag = number("max-cost-run", 0.01, 50);
const cooldownSeconds = number("cooldown", 0, 600);
// The floor is the point: an unattended run starts only after five minutes
// nobody touched the Mac, and a flag must not be able to shorten that.
const idleSeconds = number("idle", 300, 7200);
const gatePollSeconds = number("gate-poll", 1, 600);
// At most once: every re-run of an attempt input cut short is paid again.
const requeueFlag = number("requeue", 0, 1, true);
const timeBoxSeconds = parseDuration(values["time-box"]);
if (!timeBoxSeconds || timeBoxSeconds < 60)
  fail("--time-box must be a duration such as 4h, 90m or 3600.");
const allowedHolders = (values["allow-display-holder"] ?? "")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);

const outDir = resolve(root, values["out-dir"]);
// undefined when the command failed or timed out: an empty ps is not an
// empty desktop, so the presence rules must be able to tell the two apart.
const run = (command, args) =>
  new Promise((done) =>
    execFile(
      command,
      args,
      { cwd: root, timeout: 10000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => done(error ? undefined : String(stdout)),
    ),
  );
const gitRev =
  (await run("git", ["rev-parse", "--short", "HEAD"]))?.trim() || "unknown";
const gitBranch =
  (await run("git", ["rev-parse", "--abbrev-ref", "HEAD"]))?.trim() ||
  "unknown";
// A tree git cannot read counts as dirty: such a cycle never becomes a baseline.
const porcelain = await run("git", ["status", "--porcelain"]);
const dirty = porcelain === undefined || porcelain.trim() !== "";

/** This checkout and, for a worktree, the checkout its node_modules lives in. */
const roots = [root];
try {
  const modules = realpathSync(join(root, "node_modules"));
  if (!roots.includes(dirname(modules))) roots.push(dirname(modules));
} catch {}

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};
/** Every finished cycle's results.json under --out-dir, for baselines. */
function knownCycles() {
  if (!existsSync(outDir)) return [];
  const out = [];
  for (const name of readdirSync(outDir)) {
    if (!CYCLE_ID.test(name)) continue;
    const data = readJson(join(outDir, name, "results.json"));
    if (data?.schema_version !== 2 || !data.cycle) continue;
    out.push({
      data,
      comparable: comparable(
        data.cycle,
        data.results ?? [],
        data.failureClasses,
      ),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ plan */

const resuming = values.resume;
if (resuming && !CYCLE_ID.test(resuming)) fail("--resume takes a cycle id.");
const stored = resuming
  ? readJson(join(outDir, resuming, "plan.json"))
  : undefined;
if (resuming && !stored) fail(`No plan.json for cycle ${resuming}.`);

// A resume keeps the stored caps and behaviour flags: attempts run under
// other rules would pool into the same numbers.
const flags = stored?.flags ?? {
  approveRoutine: values["approve-routine"],
  stopOnHandoff: values["stop-on-handoff"],
  memory: values.memory,
  requeue: requeueFlag,
};
const runCap = stored?.caps?.run ?? runCapFlag;
const requeue = flags.requeue;

const defaults = Object.fromEntries(
  Object.entries(providerDefaults).map(([key, value]) => [key, value.model]),
);
let cells;
let tasks;
if (stored) {
  // A resume runs the stored plan, whatever the flags say: a different plan
  // under the same name would pool results that do not belong together.
  const matrix = parseMatrix(
    stored.matrix.map((m) => m.cell).join(","),
    defaults,
  );
  cells = matrix.cells;
  const selection = selectTasks(stored.taskIds.join(","), CATALOGUE);
  if (selection.unknown.length)
    fail(
      `The stored plan names tasks this catalogue no longer has: ${selection.unknown.join(", ")}.`,
    );
  tasks = selection.tasks;
} else {
  const matrix = parseMatrix(values.matrix, defaults);
  if (matrix.unknown.length)
    fail(
      `Unknown matrix cell: ${matrix.unknown.join(", ")}. Use openai, anthropic or google, optionally with :model.`,
    );
  cells = matrix.cells;
  const selection = selectTasks(values.tasks, CATALOGUE);
  if (selection.unknown.length)
    fail(
      `Unknown task or category: ${selection.unknown.join(", ")}. Known categories: ${CATEGORIES.join(", ")}.`,
    );
  tasks = selection.tasks;
}

const cycles = knownCycles();
if (values.probe && !stored) {
  // A probe replays only where a class showed up in one named baseline.
  const base = cycles.find((cycle) => cycle.data.cycle.id === values.baseline);
  if (!base) fail("--probe needs --baseline <cycle id> of a finished cycle.");
  const scope = probeScope(base.data.failureClasses ?? [], values.probe);
  if (!scope)
    fail(`Class ${values.probe} does not occur in cycle ${values.baseline}.`);
  cells = values.matrix
    ? cells.filter((cell) => scope.cells.includes(cell.cell))
    : parseMatrix(scope.cells.join(","), defaults).cells;
  tasks = tasks.filter((task) => scope.categories.includes(task.category));
}
if (!cells.length) fail("No matrix cells selected.");
if (!tasks.length) fail("No tasks selected.");
// Every cost cap (the run's own budget, --max-cost-run, --max-cost-model,
// --max-cost) is checked against the cell's estimated spend. A model charged
// at its provider default's rates can spend several times each cap, so a
// cell the catalog cannot price does not run, dry run included.
const unpriced = cells.filter((cell) => !cellPrices(cell, catalog));
if (unpriced.length)
  fail(
    `No token prices for ${unpriced.map((cell) => cell.cell).join(", ")} in src/providers/catalog.ts. ` +
      "Every cost cap is checked against a model's own rates: price the model there, or pick one the catalog prices.",
  );

const repeat = stored ? stored.repeat : number("repeat", 1, 20, true);
const shardText = stored ? stored.shard : values.shard;
const shard = parseShard(shardText);
if (shard === "invalid") fail("--shard takes i/n, for example 1/3.");
const startedAt = new Date();
const cycleId = resuming ?? values.cycle ?? defaultCycleId(startedAt, gitRev);
if (!CYCLE_ID.test(cycleId))
  fail("--cycle may hold letters, digits, dots, dashes and underscores.");
const seed = stored
  ? stored.seed
  : values.seed !== undefined
    ? Number(values.seed) >>> 0
    : seedOf(cycleId);
const taskIds = tasks.map((task) => task.id);
const cellIds = cells.map((cell) => cell.cell);
const plan = shardOf(buildPlan(cellIds, taskIds, repeat, seed), shard);
const hash = planHash({
  matrix: cellIds,
  taskIds,
  repeat,
  seed,
  shard: shardText,
});
const design = designHash({
  matrix: cellIds,
  taskIds,
  repeat,
  seed,
  shard: shardText,
});
const byId = new Map(tasks.map((task) => [task.id, task]));
const roof = ceiling(plan, byId, runCap);
const cycleCap = stored
  ? stored.caps.cycle
  : values["max-cost"] !== undefined
    ? number("max-cost", 0.01, 1000)
    : roof.total;
const modelCap = stored
  ? stored.caps.model
  : values["max-cost-model"] !== undefined
    ? number("max-cost-model", 0.01, 1000)
    : cycleCap / cells.length;

/** Task templates and grader source: a change here changes the metric. */
const graderSources = [
  "src/gym/bench/graders.ts",
  "src/gym/bench/catalogue.ts",
  "src/gym/bench/catalogue-long.ts",
  "src/gym/bench/readers.ts",
]
  .map((file) => join(root, file))
  .filter((file) => existsSync(file))
  .map((file) => readFileSync(file, "utf8"));
const catalogue = catalogueHash(tasks, graderSources);

// Twice the baseline's median per task when there is one, the measured pace
// of about three seconds a step otherwise.
const medians = {};
const baselineFor = (cycle) => {
  if (values.baseline === "none") return [];
  if (values.baseline !== "auto") {
    const named = cycles.find((c) => c.data.cycle.id === values.baseline);
    return named ? [named.comparable] : [];
  }
  return selectBaseline(
    cycle,
    cycles.map((c) => c.comparable),
  );
};
const draft = {
  id: cycleId,
  gitRev,
  catalogueHash: catalogue,
  planHash: hash,
  designHash: design,
  dirty,
  startedAt: startedAt.toISOString(),
  taskIds,
  cells: cellIds,
  results: [],
};
const baseline = baselineFor(draft);
for (const id of taskIds) {
  const seconds = baseline
    .flatMap((cycle) => cycle.results)
    .filter((row) => row.taskId === id && row.runStatus !== "skipped")
    .map((row) => row.seconds);
  if (seconds.length) medians[id] = median(seconds);
}
const estimate = estimateSeconds(plan, byId, cooldownSeconds, medians);
const fits = fitsTimeBox(estimate, timeBoxSeconds);

/* ------------------------------------------------------------- the Mac */

const appLog = (() => {
  const candidates = values["app-diagnostics"]
    ? [resolve(root, values["app-diagnostics"])]
    : roots.map((r) => join(r, ".data/diagnostics/current.jsonl"));
  return candidates.find((file) => existsSync(file));
})();
/** The last 2 MB of the app's log: enough for any run still in flight. */
function appDiagnostics() {
  if (!appLog) return undefined;
  try {
    const size = statSync(appLog).size;
    const length = Math.min(size, 2 * 1024 * 1024);
    const buffer = Buffer.alloc(length);
    const fd = openSync(appLog, "r");
    try {
      readSync(fd, buffer, 0, length, size - length);
    } finally {
      closeSync(fd);
    }
    const text = buffer.toString("utf8");
    // A cut first line is dropped rather than misread.
    return size > length ? text.slice(text.indexOf("\n") + 1) : text;
  } catch {
    return undefined;
  }
}

let caffeinate;
// The holders --allow-display-holder named, by the pids the start saw: a
// holder of the same name that appears later (another harness's caffeinate)
// was never vouched for.
let allowedHolderPids = [];
const source = {
  exec: run,
  ownPids: () => (caffeinate?.pid ? [caffeinate.pid] : []),
  allowedHolders,
  allowedHolderPids: () => allowedHolderPids,
  roots,
  pid: process.pid,
  appDiagnostics,
};

const needs = (reader) => tasks.some((task) => task.evidence?.includes(reader));
const agendaHelper = join(root, "native/bin/coarena-agenda");
/**
 * Whether a local (never synced) calendar source exists, as far as the
 * read-only `status` can say: false without the helper, undefined when it
 * does not report one. The start then asks `setup`, which fails with
 * NO_LOCAL_SOURCE; a bench event in a synced calendar would reach other
 * people before cleanup removed it.
 */
async function agendaStatus() {
  if (!needs("agenda")) return undefined;
  if (!existsSync(agendaHelper)) return false;
  return agendaLocalSource(readJsonText(await run(agendaHelper, ["status"])));
}
function readJsonText(text) {
  try {
    return JSON.parse(text ?? "");
  } catch {
    return undefined;
  }
}
/** Whether the fixture port is free on the loopback address. */
async function fixturePortFree() {
  if (!needs("fixture")) return undefined;
  return new Promise((done) => {
    const server = createServer();
    server.once("error", () => done(false));
    server.listen(47831, "127.0.0.1", () => server.close(() => done(true)));
  });
}
const system = await readSystem(source);
allowedHolderPids = system.allowedHolders.map((holder) => holder.pid);
const agendaLocal = await agendaStatus();
const unsettled = (() => {
  const log = appDiagnostics();
  if (log === undefined) return undefined;
  return analyze(parseDiagnostics(log).lines).runs.byOutcome.unsettled ?? 0;
})();
const codes = preflight({
  appPids: system.appPids,
  allowAppRunning: values["allow-app-running"],
  harnessPids: system.harnessPids,
  unreadable: system.unreadable,
  displayHolders: system.displayHolders.length,
  screensaverIdleSeconds: system.screensaverIdleSeconds,
  timeBoxSeconds,
  agendaLocalSource: agendaLocal,
  fixturePortFree: await fixturePortFree(),
  locked: system.locked,
  displayAsleep: false,
  unsettledAppRuns: unsettled,
});
const REMEDY = {
  APP_RUNNING:
    "Quit the Open Assist app (a texted task would start a second agent on this desktop), or pass --allow-app-running.",
  HARNESS_RUNNING:
    "Another cycle or bench is driving this desktop (from this or another checkout); let it finish or stop it first.",
  SCREENSAVER_TOO_SOON:
    "Set Lock Screen > Start Screen Saver to Never (or beyond the time box) for the night; the lock that follows would stall the gate.",
  NO_LOCAL_SOURCE:
    "An agenda task needs a local, unsynced calendar. Run native/bin/coarena-agenda request in this terminal and grant Calendar and Reminders; NO_LOCAL_SOURCE from native/bin/coarena-agenda setup means this Mac has no On My Mac source, and the agenda tasks cannot run.",
  FIXTURE_PORT:
    "Port 47831 on 127.0.0.1 is in use; the fixture server needs it.",
  LOCKED: "The session is locked or not on the console.",
  DISPLAY_OFF: "The display is asleep.",
  DISPLAY_HELD_BY_OTHER:
    "Something else holds the display awake (a call, a video, a caffeinate): end it, or name it with --allow-display-holder.",
  APP_RUN_ACTIVE:
    "The running app's log shows a run still in flight; let it finish or quit the app.",
  PRESENCE_UNKNOWN:
    "ps or pmset could not be read, so nothing can say whether another agent or a watched screen is here; try again.",
};

function printGate() {
  console.log(
    `gate now: HID idle ${system.hidIdleSeconds === undefined ? "unknown" : Math.round(system.hidIdleSeconds) + " s"} (needs ${idleSeconds} s before the first attempt)` +
      `, ${system.locked ? "locked" : "unlocked"}` +
      `, screensaver ${system.screensaverIdleSeconds ? system.screensaverIdleSeconds + " s" : "never"}${system.screensaverAssumed ? " (not set: the macOS default assumed)" : ""}` +
      `, display holders ${system.displayHolders.map((h) => `${h.name} (pid ${h.pid})`).join(", ") || "none"}` +
      (system.allowedHolders.length
        ? ` (allowed: ${system.allowedHolders.map((h) => `${h.name} (pid ${h.pid})`).join(", ")})`
        : "") +
      `, app processes ${system.appPids.length}` +
      `, other harnesses ${system.harnessPids.length}` +
      `, app log ${appLog ? (unsettled ? `${unsettled} run(s) unsettled` : "settled") : "absent"}` +
      (agendaLocal === undefined && needs("agenda")
        ? ", agenda local source checked at the start (setup)"
        : ""),
  );
  if (codes.length) {
    console.log("preflight refusals:");
    for (const code of codes) console.log(`  ${code}: ${REMEDY[code]}`);
  } else console.log("preflight: clear");
}

if (values.preflight) {
  printGate();
  process.exit(codes.length ? 2 : 0);
}

if (values["dry-run"]) {
  console.log(
    `Dry run: cycle ${cycleId} at ${gitRev}${dirty ? " (dirty)" : ""}: ${tasks.length} task(s) x ${cells.length} model(s) x ${repeat} = ${plan.length} attempt(s)` +
      (shard ? ` (shard ${shardText})` : "") +
      ".",
  );
  console.log(
    "No provider call, no desktop input and no file written in a dry run.\n",
  );
  for (const cell of cells) {
    const price = cellPrices(cell, catalog);
    console.log(
      `${cell.cell}  ceiling $${(roof.byCell[cell.cell] ?? 0).toFixed(2)}, cap $${Math.min(modelCap, roof.byCell[cell.cell] ?? 0).toFixed(2)}` +
        `  prices $${price.inputPrice}/$${price.outputPrice} per Mtok`,
    );
  }
  console.log(
    `cycle ceiling $${roof.total.toFixed(2)}, cap $${cycleCap.toFixed(2)}; per attempt min(task cap, $${runCap.toFixed(2)})`,
  );
  console.log(
    `estimate ${Math.round(estimate / 60)} min of a ${Math.round(timeBoxSeconds / 60)} min time box` +
      (Object.keys(medians).length
        ? " (baseline medians)"
        : " (about 3 s a step)") +
      (fits
        ? ""
        : ": does not fit 80% of the box. Shard it (--shard 1/2) or cut --repeat."),
  );
  console.log(
    `baseline: ${values.baseline === "none" ? "none" : baseline.length ? baseline.map((c) => c.id).join(", ") : "none found at this revision and catalogue"}`,
  );
  console.log(
    `catalogue ${catalogue.slice(0, 12)}, plan ${hash.slice(0, 12)}\n`,
  );
  printGate();
  console.log("\nplan (first 12):");
  for (const entry of plan.slice(0, 12))
    console.log(
      `  ${entry.index}  ${entry.cell}  ${entry.taskId} #${entry.attempt}`,
    );
  process.exit(fits ? 0 : 2);
}

if (!values["i-know-this-drives-my-mac"])
  fail(
    "Refusing to start.\n" +
      "A cycle clicks, types and launches applications on this Mac for hours and\n" +
      "calls a paid model for every step. It waits until nobody has touched the Mac\n" +
      `for ${idleSeconds} s before every first attempt. Re-run with --i-know-this-drives-my-mac,\n` +
      "or use --dry-run and --preflight first.\n\n" +
      usage,
  );
if (!fits)
  fail(
    `The plan needs about ${Math.round(estimate / 60)} min, more than 80% of the ${Math.round(timeBoxSeconds / 60)} min time box. Shard it or cut --repeat.`,
  );
if (codes.length) {
  printGate();
  fail("\nRefusing to start: fix the refusals above first.");
}
const binary = resolve(root, "native/bin/coarena-controller");
if (!existsSync(binary))
  fail("Build the native controller with npm run build:native.");

const cycleDir = join(outDir, cycleId);
if (!stored && existsSync(cycleDir))
  fail(`Cycle ${cycleId} exists; use --resume ${cycleId} or another --cycle.`);

// Two harnesses at once would be two agents on one desktop, and each one's
// helper marks its input, so neither tap would see the other. One lock for
// the whole Mac (any checkout, any --out-dir, bench.mjs too), taken before
// any wait; a process that never took it is caught by the ps check above.
const lockFile = desktopLockPath();
const lock = acquireDesktopLock(lockFile, {
  pid: process.pid,
  script: "harness-cycle",
  cycle: cycleId,
  startedAt: new Date().toISOString(),
});
if (!lock.ok)
  fail(
    lock.holder
      ? `Refusing to start: ${lock.holder.script}${lock.holder.cycle ? " " + lock.holder.cycle : ""} is driving this desktop (pid ${lock.holder.pid}).`
      : `Refusing to start: the desktop lock ${lockFile} cannot be read. Remove it if no cycle or bench is running.`,
  );
// However the process ends from here, exit included.
process.on("exit", () => releaseDesktopLock(lockFile, process.pid));

// setup makes the benchmark's calendar and list in the local source, or
// fails with NO_LOCAL_SOURCE; idempotent, and the only way the helper as it
// stands can say whether an unsynced source exists.
if (needs("agenda") && agendaLocal !== true) {
  const setup = existsSync(agendaHelper)
    ? readJsonText(await run(agendaHelper, ["setup"]))
    : undefined;
  if (agendaLocalSource(undefined, setup ?? null) !== true)
    fail(`Refusing to start: NO_LOCAL_SOURCE. ${REMEDY.NO_LOCAL_SOURCE}`);
}

/* --------------------------------------------------------- the paid part */
// Nothing below this line is loaded by --dry-run or --preflight.
const { NativeController } = await import("../electron/controller.ts");
const { importEnvCredentials, providerKey } =
  await import("../electron/credentials.ts");
const { LocalDiagnostics } = await import("../electron/diagnostics.ts");
const { HttpProvider } = await import("../src/providers/http.ts");
const { selectProvider } = await import("../src/providers/catalog.ts");
const { defaultSettings, settingsSchema } =
  await import("../src/core/schema.ts");
const { MemoryStore } = await import("../src/memory/store.ts");
const { createMemoryAccess } = await import("../src/memory/access.ts");
const {
  createHarnessState,
  launchServices,
  neverRan,
  onEmergencyStop,
  onManualInput,
  runAttempt,
} = await import("../src/gym/bench/attempt.ts");

if (stored) {
  if (stored.planHash !== hash)
    fail("The stored plan does not match its own hash.");
  if (stored.catalogueHash !== catalogue)
    fail(
      "Tasks or graders changed since this cycle started; its results would not pool. Start a new cycle.",
    );
  if (stored.gitRev !== gitRev && !values["allow-rev-change"])
    fail(
      `This cycle ran at ${stored.gitRev}, this checkout is ${gitRev}. Pass --allow-rev-change to pool them anyway.`,
    );
}

const keys = importEnvCredentials(resolve(root, ".env"), {});
const secrets = () => Object.values(keys).filter(Boolean);
mkdirSync(cycleDir, { recursive: true, mode: 0o700 });
// Non-verbose: the allow-list keeps codes, bundle ids and counts, never text.
// Nothing goes to the terminal; a cycle's log is read by the analyzer.
const diagnostics = new LocalDiagnostics(
  join(cycleDir, "diagnostics"),
  secrets,
  () => {},
  64 * 1024 * 1024,
  false,
);

// One provider per cell, built before the gate so a bad key fails now, not
// after five minutes of waiting.
const cellInfo = new Map();
const clients = {};
for (const cell of cells) {
  // The cell's own model at its own rates (cellPrices refused the start
  // above for a model it cannot price). selectProvider takes the model too
  // where the catalog prices per model.
  const settings = settingsSchema.parse(
    cellSettings(
      {
        ...selectProvider(defaultSettings, cell.provider, cell.model),
        memory: flags.memory,
      },
      cell,
      cellPrices(cell, catalog),
    ),
  );
  try {
    clients[cell.cell] = new HttpProvider(
      settings,
      providerKey(keys, settings),
      fetch,
      diagnostics.write,
    );
  } catch (error) {
    fail(
      `${cell.cell}: ${error instanceof Error ? error.message : "provider setup failed."}`,
    );
  }
  cellInfo.set(cell.cell, {
    provider: cell.provider,
    model: cell.model,
    cell: cell.cell,
    settings,
  });
}

const planFile = join(cycleDir, "plan.json");
if (!stored)
  writeFileSync(
    planFile,
    JSON.stringify(
      {
        cycle: cycleId,
        startedAt: startedAt.toISOString(),
        matrix: cells.map((cell) => ({
          cell: cell.cell,
          provider: cell.provider,
          model: cell.model,
        })),
        taskIds,
        repeat,
        seed,
        shard: shardText ?? null,
        planHash: hash,
        designHash: design,
        catalogueHash: catalogue,
        gitRev,
        gitBranch,
        dirty,
        caps: { cycle: cycleCap, run: runCap, model: modelCap },
        flags,
        entries: plan.length,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );

const ledgerFile = join(cycleDir, "ledger.jsonl");
const priorLines = existsSync(ledgerFile)
  ? parseLedger(readFileSync(ledgerFile, "utf8"))
  : [];
const write = (line) =>
  appendFileSync(ledgerFile, JSON.stringify(line) + "\n", { mode: 0o600 });
const queue = remaining(plan, priorLines, requeue);
const prior = ledgerResults(priorLines);
const macos = (await run("sw_vers", ["-productVersion"])).trim() || "unknown";

const cycleInfo = (extra = {}) => ({
  id: cycleId,
  startedAt: stored?.startedAt ?? startedAt.toISOString(),
  gitRev,
  gitBranch,
  dirty,
  host: { macos, arch: arch() },
  matrix: cells.map((cell) => {
    const settings = cellInfo.get(cell.cell).settings;
    return {
      provider: cell.provider,
      model: cell.model,
      inputPrice: settings.inputPrice,
      outputPrice: settings.outputPrice,
    };
  }),
  tasks: tasks.map((task) => ({
    id: task.id,
    category: task.category,
    difficulty: task.difficulty,
    maxCost: task.maxCost,
    maxActions: task.maxActions,
    maxSeconds: task.maxSeconds,
    // The template: a filled instruction can name one of the user's files.
    instruction: task.instruction,
    verifies: task.verifies,
    suite: task.suite ?? "smoke",
  })),
  repeat,
  seed,
  ...(shardText ? { shard: shardText } : {}),
  planHash: hash,
  designHash: design,
  catalogueHash: catalogue,
  caps: {
    cycle: cycleCap,
    run: runCap,
    model: modelCap,
    timeBoxSeconds,
    idleSeconds,
  },
  flags,
  gateWaits: gateWaitsOf(
    existsSync(ledgerFile) ? parseLedger(readFileSync(ledgerFile, "utf8")) : [],
  ),
  ...extra,
});
function writeReports(results, extra = {}, analysis, comparison) {
  const cycle = buildCycleResults({
    cycle: cycleInfo(extra),
    results,
    analysis,
    ...(comparison ? { baseline: comparison } : {}),
  });
  writeFileSync(
    join(cycleDir, "results.json"),
    JSON.stringify(cycle, null, 2) + "\n",
    { mode: 0o600 },
  );
  writeFileSync(join(cycleDir, "report.md"), renderCycleReport(cycle), {
    mode: 0o600,
  });
  return cycle;
}

console.warn(
  `\nOpen Assist cycle ${cycleId}: ${queue.length} attempt(s) left of ${plan.length}, ${cells.map((c) => c.cell).join(", ")}.\n` +
    `Cost cap $${cycleCap.toFixed(2)} (per model $${modelCap.toFixed(2)}), time box ${Math.round(timeBoxSeconds / 60)} min.\n` +
    `No attempt starts until nobody has touched this Mac for ${idleSeconds} s. Touching it ends the\n` +
    "current attempt and the cycle waits again; Escape ends the cycle; Ctrl-C twice exits.\n",
);

const state = createHarnessState();
// A sleep the stop wakes, so Ctrl-C during a 15 s gate poll acts at once.
let wake = () => {};
const sleep = (ms) =>
  new Promise((done) => {
    const timer = setTimeout(done, ms);
    wake = () => {
      clearTimeout(timer);
      done();
    };
  });
let signalled = false;
const interrupt = () => {
  if (signalled) process.exit(130);
  signalled = true;
  state.stopped = true;
  try {
    state.runner?.stop("Cycle interrupted.");
  } catch {}
  wake();
};
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);

const controller = new NativeController(
  binary,
  onEmergencyStop(state),
  onManualInput(state),
  diagnostics.write,
);

let memoryStore;
let memoryAccess;
if (flags.memory) {
  // A scratch store with its own random key, as bench: never a real profile.
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

if (!values["no-keep-awake"]) {
  // -d only: the display stays on, which keeps the Mac awake with it. Never
  // -u, which declares user activity and would feed the idle counter the
  // gate reads. -w ends it with this process, however this process ends.
  caffeinate = spawn("caffeinate", ["-d", "-w", String(process.pid)], {
    stdio: "ignore",
  });
  caffeinate.on("error", () => {
    caffeinate = undefined;
  });
}

const deps = {
  controller,
  clients,
  state,
  memoryAccess,
  diagnostics,
  // The suite's end-state readers and cleanup arrive with the long suite.
  readEvidence: null,
  cleanupAttempt: null,
  launch: launchServices(),
};
const deadline = Date.now() + timeBoxSeconds * 1000;
let outcome = { results: prior, gateWaits: undefined, notRun: queue.length };
let stoppedBecause;
try {
  await controller.configure(cellInfo.get(cells[0].cell).settings);
  // Arm the emergency tap now, latched: from here on its idle clock counts
  // every unmarked input, so the first gate and the first attempt's
  // unseen-input check read the same clock as every later one. It needs the
  // Accessibility and Screen Recording grants, which fail here rather than
  // after the first wait.
  await controller.resume();
  controller.stop();
  try {
    await controller.presence();
  } catch {
    console.warn(
      "The native helper has no presence method: every attempt waits the full --idle on HID idle time. Run npm run build:native.",
    );
  }
  write({
    kind: "start",
    at: new Date().toISOString(),
    cycle: cycleId,
    planHash: hash,
    gitRev,
  });
  outcome = await runCycleLoop({
    queue,
    tasks: byId,
    caps: {
      cycle: cycleCap,
      run: runCap,
      model: modelCap,
      cooldownSeconds,
      idleSeconds,
      gatePollSeconds,
      requeue,
      stopOnHandoff: flags.stopOnHandoff,
      allowAppRunning: values["allow-app-running"],
    },
    prior,
    deadline,
    state,
    readGate: () =>
      readGate({ ...source, presence: () => controller.presence() }),
    attempt: async (entry, maxCost, gateWaitSeconds) => {
      const result = await runAttempt(
        deps,
        cellInfo.get(entry.cell),
        byId.get(entry.taskId),
        entry.attempt,
        {
          maxCost,
          approveRoutine: flags.approveRoutine,
          planIndex: entry.index,
          requeued: entry.requeued,
          gateWaitSeconds,
        },
      );
      console.log(
        `${result.cell}  ${result.taskId} #${result.attempt}  ${result.status}${result.reason ? " (" + result.reason + ")" : ""}  ${result.endingCode}  ${result.actions} actions  ${result.seconds.toFixed(1)}s  $${result.cost.toFixed(3)}`,
      );
      return result;
    },
    skipped: (entry, reason) =>
      neverRan(
        cellInfo.get(entry.cell),
        byId.get(entry.taskId),
        entry.attempt,
        {
          maxCost: 0,
          approveRoutine: false,
          planIndex: entry.index,
          requeued: entry.requeued,
        },
        reason,
        state,
      ),
    write,
    now: () => Date.now(),
    sleep,
    // From the ledger, so a re-run row replaces the skip it supersedes.
    onResult: () =>
      writeReports(
        ledgerResults(parseLedger(readFileSync(ledgerFile, "utf8"))),
      ),
  });
  stoppedBecause = outcome.stoppedBecause;
} catch (error) {
  stoppedBecause = "error";
  console.error(
    JSON.stringify({
      error: error instanceof Error ? error.name : "Cycle failed.",
    }),
  );
} finally {
  try {
    memoryStore?.flush();
  } catch {}
  controller.close();
  caffeinate?.kill();
  write({
    kind: "stop",
    at: new Date().toISOString(),
    because: stoppedBecause,
  });
  releaseDesktopLock(lockFile, process.pid);
}

// The cycle's own log, rotations included, through the same analyzer the
// app's runs use: its per-run frictions make the failure classes richer.
const logDir = join(cycleDir, "diagnostics");
const logText = [
  "current.jsonl.3",
  "current.jsonl.2",
  "current.jsonl.1",
  "current.jsonl",
]
  .map((name) => join(logDir, name))
  .filter((file) => existsSync(file))
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");
const parsed = parseDiagnostics(logText);
const analysis = analyze(parsed.lines, { skipped: parsed.skipped });

const results = ledgerResults(parseLedger(readFileSync(ledgerFile, "utf8")));
const finishedAt = new Date().toISOString();
// Compared as results.json will store it: its failure classes carry the
// analyzer's frictions (PROVIDER_* among them), which the rows cannot
// rebuild, and the baselines' stored classes carry theirs.
const unCompared = buildCycleResults({
  cycle: cycleInfo({ finishedAt, stoppedBecause }),
  results,
  analysis,
});
const current = comparable(
  unCompared.cycle,
  unCompared.results,
  unCompared.failureClasses,
);
const base = baselineFor(current);
const comparison = base.length
  ? { cycles: base, comparison: compareCycles(current, base, classRates) }
  : undefined;
const final = writeReports(
  results,
  { finishedAt, ...(stoppedBecause ? { stoppedBecause } : {}) },
  analysis,
  comparison,
);

console.log("");
console.log(renderSummary(final.aggregate));
if (stoppedBecause)
  console.log(
    `\nStopped early: ${stoppedBecause}. ${outcome.notRun} attempt(s) did not run; --resume ${cycleId} continues.`,
  );
const regressions = final.regressions.filter(
  (row) => row.verdict === "regression",
);
if (regressions.length)
  console.log(
    `\nRegressions: ${regressions.map((row) => `${row.scope} ${row.key}`).join(", ")}`,
  );
const leftovers = results.filter(
  (row) => row.leftovers?.length || row.cleanupFailed,
);
if (leftovers.length)
  console.log(
    `\nLeftovers after ${leftovers.length} attempt(s): see report.md.`,
  );
console.log(`\nWrote ${join(cycleDir, "results.json")} and report.md`);
process.exit(
  signalled
    ? 130
    : stoppedBecause
      ? 3
      : regressions.length || leftovers.length
        ? 1
        : 0,
);
