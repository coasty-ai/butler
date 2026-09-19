// Butler harness cycle: an unattended, repeatable measurement across a
// matrix of models, run while nobody is at the Mac.
//
// PAID and REAL: every attempt drives this Mac's desktop with a cloud model,
// like `npm run bench`. Nothing runs without --i-know-this-drives-my-mac, and
// no attempt starts until the Mac has been left alone for --idle seconds
// (300 by default). --dry-run and --preflight touch neither a provider nor
// the desktop; they read a few system counters and print. --cleanup-only
// runs no task: it sweeps for benchmark items a crashed cycle left behind.
//
//   node scripts/harness-cycle.mjs --dry-run
//   node scripts/harness-cycle.mjs --dry-run --suite long
//   node scripts/harness-cycle.mjs --dry-run --suite market
//   node scripts/harness-cycle.mjs --preflight --time-box 4h
//   node scripts/harness-cycle.mjs --matrix openai,google --tasks calculator \
//        --repeat 2 --i-know-this-drives-my-mac
//   node scripts/harness-cycle.mjs --cleanup-only
//
// Screenshots stay in memory, and nothing this script writes contains screen
// text, window titles, URLs or file paths: results.json and report.md hold
// task templates, ids, counts, durations, cost and fixed codes, and the
// cycle's own diagnostics log is written without verbose content. The one
// exception is a row's strayDocuments: the home-relative path of a document
// an attempt itself saved outside ~/OpenAssistBench, which the harness never
// deletes and the person needs in order to (src/gym/bench/windows.ts).
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
import { arch, homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

// Pure modules only until the dry-run and preflight exits: the plan, the
// presence and preflight rules, the report and the price table. The suite's
// readers load here too: importing them runs nothing (a test checks), and
// the preflight asks them which stores a task writes. tsx is registered here
// so `node scripts/harness-cycle.mjs` works on its own.
const { register } = await import("tsx/esm/api");
register();
const { selectTasks } = await import("../src/gym/bench/catalogue.ts");
const { catalogueFor, categoriesFor, longHorizon, selectSuite, suiteOf } =
  await import("../src/gym/bench/suites.ts");
const { BROWSER_APPS, FIXTURE_HOST, FIXTURE_PORT } =
  await import("../src/gym/bench/graders.ts");
const { quitBrowser, resetFixtureTabs } =
  await import("../src/gym/bench/browser-reset.ts");
const {
  CYCLE_ID,
  DEFAULT_AUTONOMY,
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
  ledgerResults,
  parseAutonomy,
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
  shardsNeeded,
} = await import("../src/gym/bench/cycle.ts");
const {
  acquireDesktopLock,
  desktopLockPath,
  harnessProcesses,
  preflight,
  readGate,
  readSecureInput,
  readSystem,
  releaseDesktopLock,
} = await import("../src/gym/bench/presence.ts");
const {
  REMEDY,
  agendaSetupError,
  appsToWatch,
  benchOwnBrowser,
  chooseBrowser,
  missingKey,
  openedByPerson,
  presentKeyNames,
  readStartFacts,
  readWindowFacts,
  runningApps,
  skipRemedy,
  startSkipDetail,
  startSkips,
  taskGate,
} = await import("../src/gym/bench/preflight.ts");
const {
  AGENDA_BINARY,
  MUSIC_READER_ENV,
  agendaKinds,
  createReaders,
  parseAgendaSetup,
} = await import("../src/gym/bench/readers.ts");
const {
  benchRootDirty,
  fileTokenLedger,
  remainingLeftovers,
  sweepTokens,
  tokenLedgerDir,
} = await import("../src/gym/bench/sweep.ts");
const {
  attemptWindows,
  closeBenchWindows,
  describeWindowSweep,
  readWindowSnapshot,
  snapshotApps,
  strayDocumentsLine,
  withWindowFields,
} = await import("../src/gym/bench/windows.ts");
const {
  autonomyLine,
  buildCycleResults,
  catalogueHash,
  classRates,
  comparable,
  graderFiles,
  probeClassRates,
  renderCycleReport,
  sameTemplates,
} = await import("../src/gym/bench/cycle-report.ts");
const { compareCycles, compareProbe, selectBaseline, timingCycles } =
  await import("../src/gym/bench/compare.ts");
const { analyze, ownerOf, parseDiagnostics } =
  await import("../src/gym/bench/analyze.ts");
const { median, renderSummary } = await import("../src/gym/bench/report.ts");
// The whole module: its per-model price table, where it has one, prices the
// cells (cellPrices).
const catalog = await import("../src/providers/catalog.ts");
const { providerDefaults } = catalog;

const { values } = parseArgs({
  options: {
    matrix: { type: "string" },
    suite: { type: "string", default: "smoke" },
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
    // No default here: a resume must be able to tell the flag given from the
    // flag left out (the stored plan's regime is kept either way).
    autonomy: { type: "string" },
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
    "cleanup-only": { type: "boolean", default: false },
    "i-know-this-drives-my-mac": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

const usage = `Usage: node scripts/harness-cycle.mjs [options]     (npm run cycle -- [options])

Plan
  --matrix <provider[:model],...>  Cells. Default openai. A bare provider uses its default model.
  --suite <smoke|long|market|all>  The catalogue: the 12-task smoke suite (default), the long
                                   suite, the market suite, or all three. A plan holding long
                                   or market tasks that does not fit the time box is sharded
                                   over nights on its own.
  --tasks <ids|categories|all>     Within the suite; "long", "market" or "smoke" there names a
                                   whole suite.
                                   Categories: ${categoriesFor("all").join(", ")}. Default all.
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
  --allow-app-running              Start although the Butler app is running.
  --allow-display-holder <names>   Process names whose display-sleep assertion is not a person watching.
  --no-keep-awake                  Do not start caffeinate -d.
Behaviour
  --stop-on-handoff                End the cycle at the first agent hand-off.
  --requeue <n>                    Re-run an attempt real input cut short, at most n times (0-1). Default 1.
  --approve-routine                Approve only the prompts a task lists as routine.
  --autonomy <ask|task|flow|all>   The Settings pane's Autonomy the attempts run under. Default task:
                                   the strict measurement, every question the policy asks declined
                                   (or approved under --approve-routine). all is the owner's regime
                                   (never ask, allow everything, acknowledged): a fixture Checkout or
                                   Confirm is pressed, in the fixture only, and the graders mark it.
                                   A baseline and a probe compare only within one regime; a resume
                                   keeps the cycle's.
  --memory, --memory-dir <dir>     As bench.
Cycle
  --cycle <id>                     Name. Default <YYYYMMDD-HHMM>-<rev>.
  --resume <id>                    Continue an interrupted cycle from its ledger.
  --allow-rev-change               Resume at a different git revision.
  --baseline <id|auto|none>        Cycle to compare against. Default auto.
  --probe <CLASS_CODE>             Only the cells and categories the class touched in --baseline <id>,
                                   judged against it (exit 1 when the probe does not pass).
  --out-dir <dir>                  Default output/harness.
  --dry-run                        Print the plan, ceilings, estimate, gate state, skips and baseline.
  --preflight                      Check this Mac for an unattended night and exit.
  --cleanup-only                   Run no task: sweep every store for benchmark items that crashed
                                   or interrupted attempts left behind, then exit (1 if any remain).
                                   With --i-know-this-drives-my-mac it also closes the benchmark's
                                   own TextEdit documents and Finder windows (an Apple Event each).
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
// The regime the attempts run under. "task" is what every cycle before the
// flag ran, so a bare command measures what it always did; "all" is what the
// owner runs the product under, acknowledgement included (autonomySettings).
const autonomyFlag = parseAutonomy(values.autonomy ?? DEFAULT_AUTONOMY);
if (!autonomyFlag) fail("--autonomy takes ask, task, flow or all.");
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

/** Every task a token or a stored plan may name, by id. */
const allTasks = new Map(catalogueFor("all").map((task) => [task.id, task]));
const home = homedir();
/** Tokens of attempts that may have left something behind (sweep.ts). */
const tokenLedger = fileTokenLedger(tokenLedgerDir(home));
/** Said before a sweep waits for Spotlight to index the last attempt's saves. */
const spotlightWait = (ms) =>
  console.log(
    `Waiting ${Math.ceil(ms / 1000)} s for Spotlight to index the last attempt's files before sweeping.`,
  );

/* ---------------------------------------------------------- cleanup only */

if (values["cleanup-only"]) {
  // A dry run and a preflight write nothing, and a sweep deletes: asked
  // together, neither half can be honoured. A --dry-run process is also one
  // the other harnesses' ps check does not count as driving this desktop.
  if (values["dry-run"] || values.preflight)
    fail(
      "--cleanup-only deletes what it finds, so it does not combine with --dry-run or --preflight. Run it on its own.",
    );
  // No task, no model, no desktop input. The sweep deletes only what carries
  // a benchmark token, by the attempt's own cleanup rules and dated by the
  // attempt's start, and never while another harness runs: the folder of
  // the attempt it is in the middle of would go too.
  const ps = await run("ps", ["-axo", "pid=,command="]);
  if (ps === undefined)
    fail("Refusing to sweep: ps could not be read (PRESENCE_UNKNOWN).");
  if (harnessProcesses(ps, process.pid).length)
    fail(`Refusing to sweep: HARNESS_RUNNING. ${REMEDY.HARNESS_RUNNING}`);
  const lockFile = desktopLockPath(home);
  const lock = acquireDesktopLock(lockFile, {
    pid: process.pid,
    script: "harness-cycle",
    cycle: "cleanup-only",
    startedAt: new Date().toISOString(),
  });
  if (!lock.ok)
    fail(
      lock.holder
        ? `Refusing to sweep: ${lock.holder.script}${lock.holder.cycle ? " " + lock.holder.cycle : ""} is driving this desktop (pid ${lock.holder.pid}).`
        : `Refusing to sweep: the desktop lock ${lockFile} cannot be read. Remove it if no cycle or bench is running.`,
    );
  process.on("exit", () => releaseDesktopLock(lockFile, process.pid));
  let swept;
  try {
    swept = await sweepTokens({
      home,
      ledger: tokenLedger,
      tasks: allTasks,
      onWait: spotlightWait,
    });
  } catch {
    // The ledger or the bench root could not be read: nothing was answered.
    console.log(
      `SWEEP_FAILED: the token ledger (${tokenLedgerDir(home)}) or ~/OpenAssistBench could not be read; fix its permissions and sweep again.`,
    );
    releaseDesktopLock(lockFile, process.pid);
    process.exit(1);
  }
  for (const row of swept)
    console.log(
      `${row.token}  ${row.leftovers.length ? row.leftovers.join(", ") : "clean"}`,
    );
  // The windows earlier cycles left: TextEdit documents under the bench
  // folder and Finder windows on it, closed when they hold nothing (a
  // modified document never is). Closing is an Apple Event to each
  // application, the first of which from a terminal asks for consent, so it
  // takes the same flag as driving the desktop does; without it nothing is
  // asked and nothing is closed.
  let windows;
  if (values["i-know-this-drives-my-mac"]) {
    windows = await closeBenchWindows({
      home,
      run,
      running: runningApps(ps),
    });
    console.log(describeWindowSweep(windows));
  } else
    console.log(
      "Windows the attempts left open were not looked at: add --i-know-this-drives-my-mac to close the benchmark's own TextEdit documents and Finder windows too (an Apple Event to each application; the first from a new terminal asks for consent once).",
    );
  const left = remainingLeftovers([], swept, windows);
  console.log(
    swept.length
      ? `Swept ${swept.length} token(s). ${left.length ? `Left behind: ${left.join(", ")} (docs/BENCHMARK.md, Cleanup, says what each means; remove them by hand, then sweep again).` : "Nothing left behind."}`
      : `Nothing to sweep: no token folder under ~/OpenAssistBench and no token in the ledger.${left.length ? ` Left behind: ${left.join(", ")}.` : ""}`,
  );
  releaseDesktopLock(lockFile, process.pid);
  process.exit(left.length ? 1 : 0);
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
  autonomy: autonomyFlag,
};
const runCap = stored?.caps?.run ?? runCapFlag;
const requeue = flags.requeue;
/** The regime this cycle's attempts run under; a plan from before the flag ran "task". */
const autonomy = autonomyOf(flags);
// The other flags are silently kept on a resume; this one changes what every
// attempt does, so asking for another regime is refused rather than ignored.
if (stored && values.autonomy !== undefined && autonomyFlag !== autonomy)
  fail(
    `Cycle ${resuming} runs under --autonomy ${autonomy}, and a resume keeps it: attempts under ${autonomyFlag} would pool into the same numbers. Drop the flag, or start a new cycle.`,
  );

const defaults = Object.fromEntries(
  Object.entries(providerDefaults).map(([key, value]) => [key, value.model]),
);
if (!["smoke", "long", "market", "all"].includes(values.suite))
  fail("--suite takes smoke, long, market or all.");
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
  // Ids are unique across the suites, so a stored plan resolves whatever
  // suite it was drawn from.
  const selection = selectTasks(stored.taskIds.join(","), catalogueFor("all"));
  if (selection.unknown.length || !stored.taskIds.length)
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
  // `--tasks all` keeps its old meaning, every task of the chosen suite;
  // every suite is `--suite all` (or `--tasks smoke,long,market`).
  const selector = values.tasks?.trim() === "all" ? undefined : values.tasks;
  const selection = selectSuite(selector, values.suite);
  if (selection.unknown.length)
    fail(
      `Unknown task or category: ${selection.unknown.join(", ")}. Known categories: ${categoriesFor(values.suite).join(", ")}; a suite name (smoke, long, market, all) selects a whole suite.`,
    );
  tasks = selection.tasks;
}

const cycles = knownCycles();
/** Whether a finished cycle ran under this cycle's regime (one from before the flag ran "task"). */
const sameRegime = (cycle) => autonomyOf(cycle.data.cycle.flags) === autonomy;
if (!["auto", "none"].includes(values.baseline)) {
  // Like with like: a cycle that declined every question and one that never
  // asked measure different things, whatever the revision. A named baseline
  // of the other regime is refused here, for a probe and a plain cycle
  // alike; `auto` picks among cycles of this regime only (baselineFor).
  const named = cycles.find((cycle) => cycle.data.cycle.id === values.baseline);
  if (named && !sameRegime(named))
    fail(
      `Cycle ${values.baseline} ran under --autonomy ${autonomyOf(named.data.cycle.flags)}, and this ${values.probe ? "probe" : "cycle"} would run under ${autonomy}. Numbers are compared like with like: pass --autonomy ${autonomyOf(named.data.cycle.flags)}, or name a baseline of this regime.`,
    );
}
let probe = stored?.probe;
if (values.probe && !stored) {
  // A probe replays only where a class showed up in one named baseline: the
  // models it hit, and the baseline's own tasks in the categories it hit,
  // whichever suite they came from.
  const base = cycles.find((cycle) => cycle.data.cycle.id === values.baseline);
  if (!base) fail("--probe needs --baseline <cycle id> of a finished cycle.");
  const scope = probeScope(base.data.failureClasses ?? [], values.probe);
  if (!scope)
    fail(`Class ${values.probe} does not occur in cycle ${values.baseline}.`);
  cells = values.matrix
    ? cells.filter((cell) => scope.cells.includes(cell.cell))
    : parseMatrix(scope.cells.join(","), defaults).cells;
  const ids = (base.data.cycle.tasks ?? [])
    .filter((task) => scope.categories.includes(task.category))
    .map((task) => task.id);
  if (!ids.length)
    fail(`Cycle ${values.baseline} lists no task in the class's categories.`);
  const picked = selectTasks(ids.join(","), catalogueFor("all"));
  if (picked.unknown.length)
    fail(
      `The baseline ran tasks this catalogue no longer has (${picked.unknown.join(", ")}); a probe needs the same tasks.`,
    );
  tasks = picked.tasks;
  probe = { code: values.probe, baseline: values.baseline };
}
if (!cells.length) fail("No matrix cells selected.");
if (!tasks.length) fail("No tasks selected.");
/** What the selection holds, for plan.json and the report. */
const suite = stored?.suite ?? suiteOf(tasks);
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

/** A small text file, or undefined: the same bounds the key import applies. */
function readSmallText(file) {
  try {
    const info = statSync(file);
    return info.isFile() && info.size <= 64 * 1024
      ? readFileSync(file, "utf8")
      : undefined;
  } catch {
    return undefined;
  }
}
// Each cell's key, by the names the app imports it under, from the .env the
// real start imports. A value is only told from empty: nothing here keeps
// or prints one.
const keyNames = presentKeyNames(readSmallText(resolve(root, ".env")));
const missingKeys = cells
  .filter((cell) => missingKey(cell.provider, keyNames))
  .map((cell) => cell.cell);

const repeat = stored ? stored.repeat : number("repeat", 1, 20, true);
let shardText = stored ? stored.shard : values.shard;
let shard = parseShard(shardText);
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
const fullPlan = buildPlan(cellIds, taskIds, repeat, seed);
const byId = new Map(tasks.map((task) => [task.id, task]));

/**
 * Task templates and the grader source of exactly the suites selected: a
 * change there changes the metric, and a smoke, a long and a market cycle
 * never share a hash, so none is ever another's baseline.
 */
const graderSources = graderFiles(tasks)
  .map((file) => join(root, file))
  .filter((file) => existsSync(file))
  .map((file) => readFileSync(file, "utf8"));
const catalogue = catalogueHash(tasks, graderSources);

// Twice the baseline's median per task when there is one, the measured pace
// of about three seconds a step otherwise.
const medians = {};
// The pool `auto` chooses from: cycles of this regime, since the numbers are
// judged against the baseline; the timing medians take any (below), a
// duration being an estimate whatever the regime.
const baselineFor = (
  cycle,
  select = selectBaseline,
  pool = cycles.filter(sameRegime),
) => {
  if (values.baseline === "none") return [];
  if (values.baseline !== "auto") {
    const named = cycles.find((c) => c.data.cycle.id === values.baseline);
    return named ? [named.comparable] : [];
  }
  return select(
    cycle,
    pool.map((c) => c.comparable),
  );
};
// What a baseline is chosen by: revision, catalogue, tasks, cells, and
// (below, once the shard is known) the slice of the plan.
const draft = {
  id: cycleId,
  gitRev,
  catalogueHash: catalogue,
  planHash: "",
  dirty,
  startedAt: startedAt.toISOString(),
  taskIds,
  cells: cellIds,
  results: [],
};
// Any slice of any plan under any regime times a task: tonight's slice is
// not known yet, and it is chosen by these very medians.
const timing = baselineFor(draft, timingCycles, cycles);
for (const id of taskIds) {
  const seconds = timing
    .flatMap((cycle) => cycle.results)
    .filter((row) => row.taskId === id && row.runStatus !== "skipped")
    .map((row) => row.seconds);
  if (seconds.length) medians[id] = median(seconds);
}

// The long and market suites do not fit one night on three models. A plan
// holding their tasks that does not fit is cut into the fewest shards that
// each do, and this night runs the first; the others need the same --seed,
// or they would slice a differently ordered plan. A smoke plan is refused
// instead, as before: it is short enough that --repeat is the knob.
let autoShards;
if (
  !shardText &&
  tasks.some(longHorizon) &&
  !fitsTimeBox(
    estimateSeconds(fullPlan, byId, cooldownSeconds, medians),
    timeBoxSeconds,
  )
) {
  autoShards = shardsNeeded(
    fullPlan,
    byId,
    cooldownSeconds,
    timeBoxSeconds,
    medians,
  );
  if (autoShards) {
    shardText = `1/${autoShards}`;
    shard = parseShard(shardText);
  }
}
const plan = shardOf(fullPlan, shard);
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
// What the dry run names as the baseline: the one the end of the cycle
// will pick, the same slice of the same plan when tonight is a shard.
const baseline = baselineFor({
  ...draft,
  designHash: design,
  ...(shardText ? { shard: shardText } : {}),
});
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
const estimate = estimateSeconds(plan, byId, cooldownSeconds, medians);
const fits = fitsTimeBox(estimate, timeBoxSeconds);
/** The commands for the other nights of an automatically sharded plan. */
const shardNights = autoShards
  ? Array.from(
      { length: autoShards - 1 },
      (_, i) => `--shard ${i + 2}/${autoShards} --seed ${seed}`,
    )
  : [];

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

/** Whether the fixture port is free and bindable on the loopback address. */
async function fixturePortFree() {
  return new Promise((done) => {
    const server = createServer();
    server.once("error", () => done(false));
    server.listen(FIXTURE_PORT, "127.0.0.1", () =>
      server.close(() => done(true)),
    );
  });
}
const system = await readSystem(source);
allowedHolderPids = system.allowedHolders.map((holder) => holder.pid);
const unsettled = (() => {
  const log = appDiagnostics();
  if (log === undefined) return undefined;
  return analyze(parseDiagnostics(log).lines).runs.byOutcome.unsettled ?? 0;
})();
// What tonight can run, task by task, from read-only reads: the agenda
// helper's `status` (never `setup`, which writes, and runs only at the real
// start), Spotlight, ps, a bind on the fixture port, the bench root and the
// token ledger. A condition that concerns some tasks skips those tasks.
// An application a long task lists that is running is asked, through System
// Events, how many windows it has and how many are not the benchmark's: one
// an earlier attempt left open with only its own documents, or none, does
// not skip the task. That is an Apple Event (a consent prompt once, from a
// new terminal), so a dry run does not send it and reports every open
// application as a skip; --preflight, run attended, does.
const facts = await readStartFacts(tasks, {
  run,
  home,
  benchRootDirty: () => benchRootDirty(home, tokenLedger.entries()),
  ...(existsSync(AGENDA_BINARY) ? { agendaBinary: AGENDA_BINARY } : {}),
  fixture: fixturePortFree,
  appleEvents: !values["dry-run"],
});
/**
 * Whether secure event input is the person's to clear: on, and held by
 * anything but a browser that is the benchmark's own (not running, or with
 * no window of the person's), whose fixture tabs the gate points at
 * about:blank itself (the remedy below). A holder that could not be named is
 * the person's, since nothing could be reset for it.
 */
const personsSecureInput = (secure) =>
  secure.on &&
  !(
    secure.owner &&
    BROWSER_APPS.includes(secure.owner) &&
    benchOwnBrowser(secure.owner, facts)
  );
// After the start facts: the secure-input refusal reads the browsers'
// windows, which a dry run does not ask for (every running browser then
// counts as the person's, as with APPS_OPEN).
const codes = preflight({
  appPids: system.appPids,
  allowAppRunning: values["allow-app-running"],
  harnessPids: system.harnessPids,
  unreadable: system.unreadable,
  displayHolders: system.displayHolders.length,
  screensaverIdleSeconds: system.screensaverIdleSeconds,
  timeBoxSeconds,
  locked: system.locked,
  displayAsleep: false,
  unsettledAppRuns: unsettled,
  secureInput: personsSecureInput(system.secureInput),
});
/** The document applications and browsers running now; undefined when ps failed. */
const readRunning = async () => {
  const ps = await run("ps", ["-axo", "pid=,command="]);
  return ps === undefined ? undefined : runningApps(ps);
};
let skips = startSkips(tasks, facts);
const runnable = () => tasks.filter((task) => !skips.has(task.id));
/** A task's skip with what it was about (APPS_OPEN: the bundle ids open), from the facts so far. */
const skipDetail = (id, code) =>
  startSkipDetail(byId.get(id), facts) ?? { code };
/** The remedy for a task's skip, naming what was open for APPS_OPEN. */
const remedyFor = (id, code) => skipRemedy(skipDetail(id, code));
/** The browser this attempt uses, for a task that names one; the graders hold the run to it. */
const browserFor = (task) => {
  const browser = chooseBrowser(task, facts);
  return browser ? { browser } : {};
};

function printSkips() {
  const byCode = new Map();
  for (const [id, code] of skips)
    byCode.set(code, [...(byCode.get(code) ?? []), id]);
  if (!byCode.size) return;
  console.log("tasks skipped tonight (a resume retries them):");
  for (const [code, ids] of byCode)
    console.log(
      `  ${code} (${ids
        .map((id) => {
          const apps = skipDetail(id, code).apps;
          return apps?.length ? `${id} [${apps.join(" ")}]` : id;
        })
        .join(", ")}): ${REMEDY[code]}` +
        (code === "APPS_OPEN" && values["dry-run"]
          ? " A dry run does not look at their windows; the real start does."
          : ""),
    );
}
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
      `, secure input ${system.secureInput.on ? `on (${system.secureInput.owner ?? "holder unknown"}${personsSecureInput(system.secureInput) ? "" : ", the benchmark's browser: the gate resets its fixture tabs, and quits it should they be blank already"})` : "off"}` +
      `, app log ${appLog ? (unsettled ? `${unsettled} run(s) unsettled` : "settled") : "absent"}` +
      (facts.agendaAccess && runnable().some((task) => agendaKinds(task).length)
        ? ", agenda local source checked at the start (setup)"
        : ""),
  );
  if (codes.length || missingKeys.length || !runnable().length) {
    console.log("preflight refusals:");
    for (const code of codes) console.log(`  ${code}: ${REMEDY[code]}`);
    for (const cell of missingKeys)
      console.log(
        `  MISSING_KEY ${cell} (${catalog.providerKeyEnv[cell.split(":")[0]].join(" or ")} in ${resolve(root, ".env")}): ${REMEDY.MISSING_KEY}`,
      );
    if (!runnable().length)
      console.log(`  NOTHING_TO_RUN: ${REMEDY.NOTHING_TO_RUN}`);
  } else console.log("preflight: clear");
  printSkips();
}

if (values.preflight) {
  printGate();
  process.exit(
    codes.length || missingKeys.length || !runnable().length ? 2 : 0,
  );
}

if (values["dry-run"]) {
  console.log(
    `Dry run: cycle ${cycleId} at ${gitRev}${dirty ? " (dirty)" : ""}, ${suite} suite: ${tasks.length} task(s) x ${cells.length} model(s) x ${repeat} = ${plan.length} attempt(s)` +
      (shard ? ` (shard ${shardText})` : "") +
      ".",
  );
  if (autoShards)
    console.log(
      `The whole plan (${fullPlan.length} attempts) needs ${autoShards} nights to fit the time box: tonight runs shard 1/${autoShards} with --seed ${seed};` +
        ` the other nights run ${shardNights.join(", then ")}.`,
    );
  if (probe)
    console.log(
      `Probe ${probe.code} against cycle ${probe.baseline}: the models and categories the class touched there.`,
    );
  console.log(`autonomy ${autonomyLine(flags)}`);
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
  if (skips.size)
    console.log(
      `${runnable().length} of ${tasks.length} task(s) can run tonight; the estimate and ceiling still count every task.`,
    );
  console.log(
    `baseline: ${values.baseline === "none" ? "none" : baseline.length ? baseline.map((c) => c.id).join(", ") : "none found at this revision, catalogue and autonomy"}`,
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
if (codes.length || missingKeys.length || !runnable().length) {
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

// setup makes the benchmark's calendar and list in the local source for each
// granted store, or fails with NO_LOCAL_SOURCE; idempotent, and the only way
// the helper can say whether an unsynced source exists, which is why it runs
// here and never in a dry run or a preflight. The agenda tasks it cannot
// serve are skipped, not the cycle; every agenda attempt asks again
// (readers.ts agendaFor) before its prepare.
if (runnable().some((task) => agendaKinds(task).length)) {
  const answer = await run(AGENDA_BINARY, ["setup"]);
  const before = new Set(skips.keys());
  // Kept with the other facts: a later recount (the fixture server failing)
  // must not forget what setup said.
  facts.agendaSetup = {
    ready: parseAgendaSetup(answer ?? ""),
    error: agendaSetupError(answer),
  };
  skips = startSkips(tasks, facts);
  for (const [id, code] of skips)
    if (!before.has(id))
      console.warn(`${id}: skipped, ${code}. ${remedyFor(id, code)}`);
  if (!runnable().length) {
    printGate();
    fail("\nRefusing to start: fix the refusals above first.");
  }
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
  // where the catalog prices per model. The regime rides in the settings,
  // as it does in the product: the policy reads autonomy and, for "all",
  // the acknowledgement from the same object the runner is given.
  const settings = settingsSchema.parse(
    cellSettings(
      {
        ...selectProvider(defaultSettings, cell.provider, cell.model),
        memory: flags.memory,
        ...autonomySettings(autonomy),
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
        suite,
        ...(probe ? { probe } : {}),
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
  suite,
  ...(probe ? { probe } : {}),
  ...extra,
});
function writeReports(results, extra = {}, analysis, comparison, verdict) {
  const cycle = buildCycleResults({
    cycle: cycleInfo(extra),
    results,
    analysis,
    ...(comparison ? { baseline: comparison } : {}),
    ...(verdict ? { probe: verdict } : {}),
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
  `\nButler cycle ${cycleId}: ${queue.length} attempt(s) left of ${plan.length}, ${cells.map((c) => c.cell).join(", ")}, ${suite} suite, autonomy ${autonomyLine(flags)}.\n` +
    (autoShards
      ? `The whole plan needs ${autoShards} nights: this is shard 1/${autoShards}; the others run ${shardNights.join(", then ")}.\n`
      : "") +
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

// The long and market suites' end-state readers and cleanup. Music stays off unless
// OPEN_ASSIST_BENCH_MUSIC=1: its first Apple Event shows an Automation
// prompt, which must never sit on screen during an unattended night.
const readers = createReaders({ music: process.env[MUSIC_READER_ENV] === "1" });
let fixture;
/**
 * The fixture server's URL, for the tab reset's origin: the running server's
 * or, before one runs tonight (a tab an earlier cycle left), the port every
 * fixture server binds. Nothing else is ever an origin the reset compares.
 */
const fixtureUrl = () =>
  fixture?.url ?? `http://${FIXTURE_HOST}:${FIXTURE_PORT}`;
const deps = {
  controller,
  clients,
  state,
  memoryAccess,
  diagnostics,
  // The fixture log is flushed first, so the last page the model opened is
  // in the evidence the grader reads.
  readEvidence: async (task, ctx) => {
    if (task.evidence?.includes("fixture")) await fixture?.flush();
    return readers.readEvidence(task, ctx);
  },
  cleanupAttempt: readers.cleanupAttempt,
  // Asked per attempt: the task's own stores, ready right now.
  agendaFor: readers.agendaFor,
  tokens: tokenLedger,
  launch: launchServices(),
};
const deadline = Date.now() + timeBoxSeconds * 1000;
let outcome = { results: prior, gateWaits: undefined, notRun: queue.length };
let stoppedBecause;
let swept = [];
/** The window sweep's answer at the end; undefined until it ran. */
let windowSweep;
// TextEdit documents the attempts of this process created (windows.ts
// attemptWindows): in memory only, for the final sweep to close the ones
// that hold nothing. A document saved outside the bench folder is also on
// its row (strayDocuments), which is how a resumed cycle still knows it.
const attemptDocuments = [];
try {
  // The fixture server runs as a child process for the cycle, on the
  // loopback address only, when a task that can run tonight reads its log.
  // A port taken since the preflight skips those tasks, not the cycle.
  if (runnable().some((task) => task.evidence?.includes("fixture"))) {
    const { spawnFixtureServer } = await import("./bench-fixtures.mjs");
    try {
      fixture = await spawnFixtureServer({ port: FIXTURE_PORT });
      deps.fixture = fixture;
    } catch {
      const before = new Set(skips.keys());
      facts.fixture = false;
      skips = startSkips(tasks, facts);
      for (const [id, code] of skips)
        if (!before.has(id))
          console.warn(`${id}: skipped, ${code}. ${remedyFor(id, code)}`);
    }
  }
  const gate = taskGate(byId, skips, () => new Date());
  // What was open when the last attempt ended: the benchmark's own from
  // then on (an attempt leaves what it opened open).
  let runningAfterLast;
  /**
   * Quits the harness's own browser when its fixture tabs, blank already,
   * still hold secure event input: a blank tab's WebContent keeps the
   * focused field's state until its window goes (cycle 20260919-1522 waited
   * 50 minutes on Safari that way, until the operator quit it by hand).
   * browser-reset.ts quitBrowser applies the benchOwnBrowser rule itself
   * over the facts, so a browser of the person's is never quit and no other
   * application ever is. The terminal says what was quit and why, the
   * diagnostics trace BrowserQuit with the bundle id, the flag and the code
   * (never a title), and once the browser has gone it is forgotten as
   * running, as at a cycle's start: chooseBrowser treats it as not running
   * (safe), and a relaunch by a person during a wait counts as theirs
   * (openedByPerson compares with what ran after the last attempt).
   */
  const quitOwnBrowser = async (id, where) => {
    let quit;
    try {
      quit = await quitBrowser(run, id, facts);
    } catch {
      quit = { quit: false, code: "UNREAD" };
    }
    diagnostics.write("BrowserQuit", {
      browser: id,
      quit: quit.quit,
      ...(quit.code ? { code: quit.code } : {}),
    });
    console.warn(
      `${where}: secure event input is still on in ${id}, the benchmark's own browser, with its fixture tabs already blank (a blank tab keeps the field's state until its window goes): ${quit.quit ? "quit it to release the keyboard" : `asked it to quit, but it did not go (${quit.code})`}.`,
    );
    if (quit.quit) {
      facts.running?.delete(id);
      runningAfterLast?.delete(id);
      if (facts.windows) delete facts.windows[id];
    }
    return quit;
  };
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
    // The surface is the runner's own read of secure input (a password
    // field with the keyboard), answered while the helper is latched.
    readGate: () =>
      readGate({
        ...source,
        presence: () => controller.presence(),
        surface: () => controller.surface(),
      }),
    // SECURE_INPUT with nobody at the Mac: a password field has the
    // keyboard, so the runner's first surface read would hand off at once
    // (cycle 20260919-0957: the sign-in fixture's field, left focused in
    // Safari, cost 14 of 15 attempts). Said once per wait. When the holder
    // is the benchmark's own browser, its fixture tabs are pointed at
    // about:blank and the gate reads again; a field of the person's
    // (Terminal at a sudo prompt, a password manager, their own browser) is
    // never touched, only named, and the gate waits.
    remedy: async (report) => {
      const owner = report.secureInputOwner;
      const ours =
        owner && BROWSER_APPS.includes(owner) && benchOwnBrowser(owner, facts);
      if (!ours) {
        console.warn(
          `gate: secure event input is on${owner ? ` in ${owner}` : " (holder unknown)"}: a password field has the keyboard, and every attempt would hand off at once. Waiting; click somewhere else or close it.`,
        );
        return undefined;
      }
      let reset;
      try {
        reset = await resetFixtureTabs(run, owner, fixtureUrl());
      } catch {
        reset = undefined;
      }
      console.warn(
        `gate: secure event input is on in ${owner}, the benchmark's own browser: ${reset ? `${reset.tabs} fixture tab(s) pointed at about:blank${reset.code ? ` (${reset.code})` : ""}` : "the reset failed"}.`,
      );
      return reset?.tabs;
    },
    // The reset is not always enough: a blank tab keeps the focused field's
    // state until its window goes (cycle 20260919-1522: Safari held secure
    // input for 50 minutes with every tab on about:blank, until the operator
    // quit it). So once per wait, when the reset has run for the harness's
    // own browser and the next read still names that browser, the loop asks
    // this: the browser is quit (quitOwnBrowser: the benchOwnBrowser rule
    // again, never a browser of the person's, never another application)
    // and the gate reads again at once. Whatever holds the keyboard after
    // that is named and waited on as today. Never during an attempt.
    escalate: async (report) => {
      const owner = report.secureInputOwner;
      const ours =
        owner && BROWSER_APPS.includes(owner) && benchOwnBrowser(owner, facts);
      if (!ours) return undefined;
      const quit = await quitOwnBrowser(owner, "gate");
      return quit.quit;
    },
    // The start read ps once, and the gate may then wait for hours while
    // the person keeps working: a document they opened meanwhile may hold
    // unsaved work a long task would type into. Read again at the first
    // pass and after any wait that saw a person; what they opened skips
    // its tasks (APPS_OPEN) from this attempt on.
    afterGate: async (pass) => {
      if (!pass.first && !pass.sawInput) return;
      const opened = openedByPerson(
        pass,
        await run("ps", ["-axo", "pid=,command="]),
        runningAfterLast,
      );
      if (!opened.size) return;
      facts.running = new Set([...(facts.running ?? []), ...opened]);
      // Their windows too: one they opened and closed again, or a browser
      // with no window, holds nothing of theirs.
      facts.windows = {
        ...facts.windows,
        ...(await readWindowFacts(run, appsToWatch(tasks, opened))),
      };
      // In place: the task gate holds this map.
      for (const [id, code] of startSkips(tasks, facts))
        if (!skips.has(id)) {
          skips.set(id, code);
          console.warn(`${id}: skipped, ${code}. ${remedyFor(id, code)}`);
        }
    },
    attempt: async (entry, maxCost, gateWaitSeconds) => {
      const task = byId.get(entry.taskId);
      // Chosen now, from the facts so far: a browser the person opened
      // during a wait is theirs from this attempt on.
      const browser = browserFor(task);
      // The windows of the task's applications (and the Finder, which the
      // neutral start activates) before and after: what is there after and
      // was not before is this attempt's, for the final sweep to close and
      // the row to count. Titles stay in memory; TextEdit is asked for its
      // documents' paths only while it runs.
      const watched = snapshotApps(task, browser.browser?.id);
      const before = await readWindowSnapshot(
        run,
        watched,
        await readRunning(),
      );
      const result = await runAttempt(
        deps,
        cellInfo.get(entry.cell),
        task,
        entry.attempt,
        {
          maxCost,
          approveRoutine: flags.approveRoutine,
          planIndex: entry.index,
          requeued: entry.requeued,
          gateWaitSeconds,
          ...browser,
        },
      );
      console.log(
        `${result.cell}  ${result.taskId} #${result.attempt}  ${result.status}${result.reason ? " (" + result.reason + ")" : ""}  ${result.endingCode}  ${result.actions} actions  ${result.seconds.toFixed(1)}s  $${result.cost.toFixed(3)}`,
      );
      runningAfterLast = await readRunning();
      const left = attemptWindows(
        before,
        await readWindowSnapshot(run, watched, runningAfterLast),
      );
      attemptDocuments.push(...left.documents);
      // The fixture tab the attempt leaves may hold a focused password field
      // (the sign-in fixture), which keeps secure event input on for the
      // whole session and hands every later attempt off at once (cycle
      // 20260919-0957, 14 of 15 attempts): the browser chosen for the
      // attempt, the benchmark's own by chooseBrowser's rule, has its
      // fixture-host tabs pointed at about:blank, and no other tab. Not after
      // real input or a stop: the person asked for nothing more to happen,
      // and the gate's remedy clears it once the Mac is idle again. When the
      // reset leaves secure input on and the read that the gate makes
      // (the session's pid, else the surface's frontmost application) still
      // names this browser, it is quit here too, so the next attempt never
      // meets the gate on it; the row says so (browserReset.quit).
      let browserReset;
      if (
        browser.browser &&
        !result.manualTakeover &&
        result.reason !== "MANUAL_INPUT_UNSEEN" &&
        !state.stopped
      ) {
        try {
          browserReset = await resetFixtureTabs(
            run,
            browser.browser.id,
            fixtureUrl(),
          );
        } catch {
          browserReset = undefined;
        }
        if (browserReset && !browserReset.code) {
          const secure = await readSecureInput(run, () => controller.surface());
          if (secure.on && secure.owner === browser.browser.id) {
            const quit = await quitOwnBrowser(
              browser.browser.id,
              `${task.id} #${entry.attempt}`,
            );
            if (quit.quit) browserReset = { ...browserReset, quit: true };
          }
        }
      }
      return withWindowFields(
        { ...result, ...(browserReset ? { browserReset } : {}) },
        left,
        home,
      );
    },
    skipped: (entry, reason) => {
      const row = neverRan(
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
      );
      // Which application kept it from running, by bundle id, so the
      // report's line says what to quit.
      const apps =
        reason === "APPS_OPEN" ? skipDetail(entry.taskId, reason).apps : [];
      return apps?.length ? { ...row, openApps: apps } : row;
    },
    // A fixture server that died mid-cycle serves nothing more tonight.
    skipFor: (entry) =>
      gate.skip(entry) ??
      (fixture &&
      !fixture.alive() &&
      byId.get(entry.taskId)?.evidence?.includes("fixture")
        ? "FIXTURE_PORT"
        : undefined),
    // Skips are rows like any other, and said out loud.
    observe: (row) => {
      gate.observe(row);
      if (row.runStatus === "skipped")
        console.log(
          `${row.cell}  ${row.taskId} #${row.attempt}  skipped (${row.reason})`,
        );
    },
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
    await fixture?.close();
  } catch {}
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
  // The final sweep, still under the lock (a harness starting beside it
  // would lose its attempt's folder): every token still in the ledger (every
  // attempt that swept for stray files, once Spotlight has had time to
  // index them; a check that got no answer; a crashed earlier cycle) and
  // every token folder, through the attempt's own cleanup rules. A sweep
  // that fails answers nothing: undefined, and every leftover the rows
  // reported stands.
  try {
    swept = await sweepTokens({
      home,
      ledger: tokenLedger,
      tasks: allTasks,
      onWait: spotlightWait,
    });
  } catch {
    swept = undefined;
  }
  // Then the windows, still under the lock: Finder windows on the bench
  // folder, TextEdit documents under it or that an attempt created (this
  // process's, and the paths every row of the ledger names, so a resumed
  // cycle closes what its earlier nights saved), each only while unmodified.
  // Nothing outside the bench folder is deleted; a modified document, a
  // dialog in TextEdit or an application that did not answer is reported.
  try {
    const ps = await run("ps", ["-axo", "pid=,command="]);
    windowSweep = await closeBenchWindows({
      home,
      run,
      documents: attemptDocuments,
      paths: ledgerResults(
        parseLedger(readFileSync(ledgerFile, "utf8")),
      ).flatMap((row) => row.strayDocuments ?? []),
      running: runningApps(ps),
    });
  } catch {
    windowSweep = undefined;
  }
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
// A probe answers to its named baseline, across revisions by design; any
// other cycle to the baselines at its own revision and catalogue.
const probeBase = probe
  ? cycles.find((cycle) => cycle.data.cycle.id === probe.baseline)
  : undefined;
const verdict = probeBase
  ? compareProbe(current, probeBase.comparable, probe.code, {
      templatesMatch: sameTemplates(
        probeBase.data.cycle.tasks ?? [],
        unCompared.cycle.tasks,
      ),
      classes: probeClassRates(probe.code),
      owner: ownerOf,
    })
  : undefined;
const base = probeBase ? [probeBase.comparable] : baselineFor(current);
const comparison = verdict
  ? { cycles: base, comparison: verdict.comparison }
  : base.length
    ? { cycles: base, comparison: compareCycles(current, base, classRates) }
    : undefined;
const final = writeReports(
  results,
  { finishedAt, ...(stoppedBecause ? { stoppedBecause } : {}) },
  analysis,
  comparison,
  verdict,
);

console.log("");
console.log(renderSummary(final.aggregate));
const skippedByCode = {};
for (const row of results)
  if (row.runStatus === "skipped" && row.reason)
    skippedByCode[row.reason] = (skippedByCode[row.reason] ?? 0) + 1;
if (Object.keys(skippedByCode).length)
  console.log(
    `Skipped   ${Object.entries(skippedByCode)
      .map(([code, n]) => `${code} ${n}`)
      .join("  ")}`,
  );
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
if (verdict)
  console.log(
    `\nProbe ${verdict.code}: ${verdict.pass ? "pass" : "FAIL"} (class ${verdict.before.k}/${verdict.before.n} before, ${verdict.after.k}/${verdict.after.n} now)` +
      (verdict.reasons.length
        ? `: ${verdict.reasons.map((r) => (r.key ? `${r.code} ${r.key}` : r.code)).join(", ")}`
        : ""),
  );
// What is still on this Mac after the final sweep: what no sweep can clear
// (a file of the person's, a refused folder, a document saved outside the
// bench folder) and what this one could not, windows included.
const left = remainingLeftovers(results, swept, windowSweep);
if (!swept)
  console.log(
    `\nThe final sweep failed: the token ledger (${tokenLedgerDir(home)}) or ~/OpenAssistBench could not be read, so every leftover the attempts reported stands.`,
  );
if (windowSweep) console.log(`\n${describeWindowSweep(windowSweep)}`);
const strays = strayDocumentsLine(results);
if (left.length)
  console.log(
    `\nLeftovers after the final sweep: ${left.join(", ")}. ${strays ? strays + " " : ""}See report.md and docs/BENCHMARK.md (Cleanup); npm run cycle -- --cleanup-only sweeps again.`,
  );
if (autoShards && !stoppedBecause)
  console.log(
    `\nShard 1/${autoShards} done. The other nights: ${shardNights.join(", then ")}.`,
  );
console.log(`\nWrote ${join(cycleDir, "results.json")} and report.md`);
process.exit(
  signalled
    ? 130
    : stoppedBecause
      ? 3
      : regressions.length || left.length || (verdict && !verdict.pass)
        ? 1
        : 0,
);
