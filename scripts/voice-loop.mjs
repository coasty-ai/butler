// The voice loop: speaks the suite's prompts through the speakers into the
// running, packaged Butler.app, watches what it did from its own diagnostics
// and from the Mac's state, names each failure, and writes a content-free
// results.json and report.md that `npm run loop -- --output output/voice`
// turns into fix lanes. docs/VOICE_LOOP.md explains the cycle.
//
// REAL: the app acts on this Mac in response to what the loop says. Nothing
// is spoken without --i-know-this-speaks-to-my-mac, and no prompt starts
// until the Mac has been left alone for --idle-seconds and the app is
// settled and listening. --dry-run validates the suite, reads the preflight
// facts and prints the plan; it speaks nothing and writes nothing.
//
//   node scripts/voice-loop.mjs --dry-run
//   node scripts/voice-loop.mjs --dry-run --only fast-start,ask-time
//   node scripts/voice-loop.mjs --repeat 3 --i-know-this-speaks-to-my-mac
//   node scripts/voice-loop.mjs --noisy --idle-seconds 45 --voice Samantha --i-know-this-speaks-to-my-mac
//   node scripts/voice-loop.mjs --report-only 20260919-2200-75ed88e
//
// What it never does: approve anything (a confirmation is declined with
// "stop" and the run must end); speak after an unheard prompt or a takeover
// (a person at the Mac ends the cycle, silently, exit 3); launch, relaunch,
// quit or package the app (preflight refuses unless the packaged
// release/mac-arm64/Butler.app is the one running); delete anything that
// does not carry the attempt's token, live in its bench folder, or postdate
// its marker; or copy a transcript, a reply or a task text into
// results.json, report.md or a brief (those stay in the local turns.jsonl).
import { spawn } from "node:child_process";
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
import { arch, homedir, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

// Pure modules only: the suite, the grader, the classes, the report, the
// bench's presence readers and its cycle-id helpers. Never the controller,
// the runner or a provider. tsx is registered here so `node
// scripts/voice-loop.mjs` works on its own.
const { register } = await import("tsx/esm/api");
register();
const {
  AUTOMATION_PROBES,
  benchDirFor,
  defaultTimeoutMs,
  DEFAULT_UNHEARD_MS,
  estimateSeconds,
  fillPlaceholders,
  loadSuite,
  pollStepResult,
  pollUntilTrue,
  selectTasks,
  STEP,
  suiteHash,
  taskProbes,
  taskSkips,
  turnsOf,
  validateSuite,
  voiceToken,
} = await import("../src/gym/voice/suite.ts");
const {
  GATE_CAP_MS,
  GateWait,
  HidTakeoverTracker,
  SKIP,
  gradeTurn,
  isChatter,
  isSpeechSample,
  lastTurnDone,
  medianLevel,
  quietThreshold,
  summarizeTurn,
  summarizeUtterances,
  voiceGate,
} = await import("../src/gym/voice/grade.ts");
const { AppWatch, linesSince } = await import("../src/gym/voice/watch.ts");
const { ENVIRONMENT_CODES, classify } =
  await import("../src/gym/voice/classify.ts");
const { buildResults, fixBrief, renderReport, setupFailureDetail } =
  await import("../src/gym/voice/report.ts");
const {
  acquireDesktopLock,
  appProcesses,
  desktopLockPath,
  harnessProcesses,
  parseHidIdle,
  releaseDesktopLock,
  unsettledRuns,
} = await import("../src/gym/bench/presence.ts");
const { CYCLE_ID, defaultCycleId, parseDuration } =
  await import("../src/gym/bench/cycle.ts");

const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    only: { type: "string" },
    noisy: { type: "boolean", default: false },
    "idle-seconds": { type: "string", default: "45" },
    voice: { type: "string", default: "Samantha" },
    wake: { type: "string" },
    rate: { type: "string", default: "175" },
    repeat: { type: "string", default: "1" },
    "cycle-id": { type: "string" },
    "report-only": { type: "string" },
    "out-dir": { type: "string" },
    "time-box": { type: "string", default: "2h" },
    "require-quiet": { type: "boolean", default: false },
    rehearse: { type: "boolean", default: false },
    "i-know-this-speaks-to-my-mac": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  console.log(
    `Usage: node scripts/voice-loop.mjs [--dry-run] [--only <ids,tags,categories>] [--noisy] [--repeat N] [--i-know-this-speaks-to-my-mac]

  Speaks the voice suite to the running Butler.app and grades what it did.

  --dry-run             Validate the suite, print the preflight facts and the plan. Speaks nothing, writes nothing.
  --rehearse            Run each selected task's setup and cleanup once and print every step's exit code; speaks nothing
                        and needs no Butler.app, but opens and closes windows on this Mac, so the consent flag is required.
  --only <list>         Task ids, tags or categories, comma-separated.
  --noisy               Include the noisy-tagged tasks (a second voice reads in the background).
  --repeat N            Attempts per task (3 is the recommended real cycle).
  --idle-seconds N      Human idle required at the start and after any input (45).
  --voice <name>        The say voice (Samantha). --rate <wpm> (175). --wake "<phrase>" (the suite's).
  --cycle-id <id>       Output folder name (default <YYYYMMDD-HHMM>-<rev7>).
  --out-dir <dir>       Where cycles go (output/voice).
  --time-box <dur>      Stop starting tasks when the box would be exceeded (2h).
  --require-quiet       Refuse without a standby trace to judge the room by.
  --report-only <id>    Re-render results.json, report.md and lanes from a cycle's ledger.
  --i-know-this-speaks-to-my-mac   Required to run. The app will act on this Mac.

  The loop never approves a confirmation, never speaks after an unheard prompt or a takeover,
  and never launches or quits the app. See docs/VOICE_LOOP.md.`,
  );
  process.exit(0);
}

/* ------------------------------------------------------------ constants */

const DIAG = join(root, ".data", "diagnostics", "current.jsonl");
const PACKAGED_APP = join(root, "release", "mac-arm64", "Butler.app");
const BUNDLE_ID = "ai.coarena.openassist";
const FOCUS_SHORTCUT = "Butler Voice Loop: Focus Off";
const FRONTMOST_SCRIPT =
  'tell application "System Events" to return bundle identifier of first application process whose frontmost is true';
const POLL_MS = 250;
const GATE_POLL_MS = 1000;
const STOP_WAIT_MS = 5000;
const NOISE_MAX_MS = 25_000;

const outDir = values["out-dir"]
  ? resolve(values["out-dir"])
  : join(root, "output", "voice");
/** A numeric flag, validated like --time-box: NaN would pass every gate that compares against it. */
function numberFlag(name, { min = 0, integer = false } = {}) {
  const n = Number(values[name]);
  if (!Number.isFinite(n) || n < min || (integer && !Number.isInteger(n))) {
    console.error(
      `--${name} ${values[name]} is not ${integer ? "a whole number" : "a number"}${min > 0 ? ` of at least ${min}` : ""}.`,
    );
    process.exit(2);
  }
  return n;
}
const idleSeconds = numberFlag("idle-seconds");
const rate = numberFlag("rate", { min: 1, integer: true });
const repeat = numberFlag("repeat", { min: 1, integer: true });
const timeBoxSeconds = parseDuration(values["time-box"]);
if (!timeBoxSeconds) {
  console.error(
    `--time-box ${values["time-box"]} is not a duration (2h, 90m).`,
  );
  process.exit(2);
}

/* ---------------------------------------------------------------- suite */

const suitePath = join(root, "tests", "fixtures", "voice-suite.json");
const suiteJson = readFileSync(suitePath, "utf8");
const suite = loadSuite(suiteJson);
const problems = validateSuite(suite);
if (problems.length) {
  console.error("The voice suite is not safe to speak:");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(2);
}
const WAKE = values.wake ?? suite.wake;
const graderSources = ["grade.ts", "classify.ts"].map((name) =>
  readFileSync(join(root, "src", "gym", "voice", name), "utf8"),
);
const hash = suiteHash(suiteJson, graderSources);
const selection = selectTasks(suite, values.only ?? [], {
  noisy: values.noisy,
});
if (selection.unknown.length) {
  console.error(
    `Unknown task, tag or category: ${selection.unknown.join(", ")}.`,
  );
  process.exit(2);
}
if (!selection.tasks.length) {
  console.error("Nothing selected.");
  process.exit(2);
}

/* -------------------------------------------------------------- helpers */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs a command and returns its output, exit code and duration; a timeout
 * or a spawn error is a non-zero code, never an empty success.
 */
function run(command, args, { input, timeoutMs = 10_000 } = {}) {
  return new Promise((resolveRun) => {
    const started = Date.now();
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      resolveRun({ stdout, stderr, code, ms: Date.now() - started });
    };
    let child;
    try {
      child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      finish(127);
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(124);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", () => {
      clearTimeout(timer);
      finish(127);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code ?? 1);
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}
/** stdout of a read-only command, or undefined when it failed. */
async function readOut(command, args, timeoutMs = 10_000) {
  const result = await run(command, args, { timeoutMs });
  return result.code === 0 ? result.stdout : undefined;
}
const osascript = (script, timeoutMs = 10_000) =>
  run("osascript", [], { input: script, timeoutMs });
const sh = (script, timeoutMs = 10_000) =>
  run("sh", ["-c", script], { timeoutMs });

/**
 * One setup, cleanup or check step with its placeholders filled. A step's
 * timeout is its own (STEP.defaultTimeoutMs when it names none): the child
 * is killed at it and the step comes back 124, so no step can hold the
 * loop past what the suite said. A `poll` step is re-run until it says
 * `true`, bounded by that same timeout, with every try bounded too.
 */
async function runStep(step, fill) {
  const script = fillPlaceholders(step.script, fill);
  const timeoutMs = step.timeoutMs ?? STEP.defaultTimeoutMs;
  const exec = (ms) =>
    step.kind === "osascript" ? osascript(script, ms) : sh(script, ms);
  if (!step.poll) return exec(timeoutMs);
  return pollStepResult(
    await pollUntilTrue(exec, {
      timeoutMs,
      intervalMs: step.intervalMs,
      sleep,
    }),
  );
}
/** `step N (kind[ poll])`, for the console. */
const stepName = (index, step) =>
  `step ${index} (${step.kind}${step.poll ? " poll" : ""})`;

/**
 * Speaks through the speakers; resolves when `say` has finished. Never
 * rejects: a missing voice or a lost output device comes back as `failed`,
 * so the task records SAY_FAILED, cleans up and the cycle stops in order.
 */
function speak(text) {
  return new Promise((resolveSay) => {
    const spokenAt = Date.now();
    let child;
    try {
      child = spawn("say", ["-v", values.voice, "-r", String(rate), text], {
        stdio: "ignore",
      });
    } catch (error) {
      resolveSay({ spokenAt, sayEndedAt: Date.now(), failed: error.message });
      return;
    }
    child.on("error", (error) =>
      resolveSay({ spokenAt, sayEndedAt: Date.now(), failed: error.message }),
    );
    child.on("close", (code) =>
      resolveSay({
        spokenAt,
        sayEndedAt: Date.now(),
        failed: code === 0 ? undefined : `say exited ${code}`,
      }),
    );
  });
}

async function readHidIdle() {
  return parseHidIdle(
    (await readOut("ioreg", ["-c", "IOHIDSystem", "-d", "4"])) ?? "",
  );
}
async function readVolume() {
  const text = await readOut("osascript", ["-e", "get volume settings"]);
  const level = /output volume:(\d+)/.exec(text ?? "");
  const muted = /output muted:(true|false)/.exec(text ?? "");
  if (!level || !muted) return undefined;
  return { level: Number(level[1]), muted: muted[1] === "true" };
}
async function setVolume(level, muted) {
  await osascript(
    `set volume output volume ${level}\nset volume output muted ${muted}`,
  );
}

/* ---------------------------------------------------- diagnostics reader */

/**
 * Byte offsets, never character offsets: the log carries curly quotes and
 * dashes, and a partial trailing line is kept for the next read (the trial
 * prototype's reader, kept as it was).
 */
class Tail {
  constructor(file) {
    this.file = file;
    this.offset = existsSync(file) ? statSync(file).size : 0;
    this.carry = "";
  }
  read() {
    if (!existsSync(this.file)) return [];
    const size = statSync(this.file).size;
    if (size < this.offset) {
      // Rotated: start over from the top of the new file.
      this.offset = 0;
      this.carry = "";
    }
    if (size <= this.offset) return [];
    const buffer = Buffer.alloc(size - this.offset);
    const fd = openSync(this.file, "r");
    try {
      readSync(fd, buffer, 0, buffer.length, this.offset);
    } finally {
      closeSync(fd);
    }
    this.offset = size;
    const text = this.carry + buffer.toString("utf8");
    const lines = text.split("\n");
    this.carry = lines.pop() ?? "";
    return parseLines(lines);
  }
}
function parseLines(lines) {
  return lines
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .filter(
      (e) =>
        e && typeof e.event === "string" && typeof e.timestamp === "string",
    );
}
/** The last `bytes` of the log, as events, for the preflight facts. */
function readTail(file, bytes = 4 * 1024 * 1024) {
  if (!existsSync(file)) return { text: undefined, events: [] };
  const size = statSync(file).size;
  const start = Math.max(0, size - bytes);
  const buffer = Buffer.alloc(size - start);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buffer, 0, buffer.length, start);
  } finally {
    closeSync(fd);
  }
  const text = buffer.toString("utf8");
  const lines = text.split("\n");
  if (start > 0) lines.shift();
  return { text, events: parseLines(lines) };
}

// What the app is doing now is read by src/gym/voice/watch.ts AppWatch, fed
// with every event the loop reads: listening, speaking, open runs, the open
// follow-up window, the standby levels, its last action and the last takeover.

/* ------------------------------------------------------------ preflight */

/** Everything the preflight reads; every command here is read-only. */
async function readFacts() {
  const ps = await readOut("ps", ["-axo", "pid=,command="]);
  const pids = ps === undefined ? [] : appProcesses(ps, [root], process.pid);
  const lines = (ps ?? "").split("\n");
  const commandOf = (pid) => {
    const line = lines.find((l) => new RegExp(`^\\s*${pid}\\s`).test(l));
    return line ? line.replace(/^\s*\d+\s+/, "") : "";
  };
  let packagedPath;
  try {
    packagedPath = realpathSync(PACKAGED_APP);
  } catch {
    packagedPath = undefined;
  }
  const apps = pids.map((pid) => {
    const command = commandOf(pid);
    const match = /^(.*\/(?:Butler|Open Assist)\.app)\/Contents\/MacOS\//.exec(
      command,
    );
    let bundle = match ? match[1] : undefined;
    try {
      if (bundle) bundle = realpathSync(bundle);
    } catch {
      /* keep the unresolved path */
    }
    return {
      pid,
      bundle,
      packaged: !!bundle && !!packagedPath && bundle === packagedPath,
    };
  });
  const app = apps.find((a) => a.packaged);
  let appStart = 0;
  if (app) {
    const lstart = await readOut("ps", [
      "-o",
      "lstart=",
      "-p",
      String(app.pid),
    ]);
    appStart = lstart ? Date.parse(lstart.trim()) || 0 : 0;
  }
  // The app's own environment says whether its diagnostics are verbose; only
  // that one variable is looked for, and nothing of the environment is kept.
  let verboseEnv = null;
  if (app) {
    const env = await readOut("ps", [
      "-p",
      String(app.pid),
      "-wwE",
      "-o",
      "command=",
    ]);
    if (env !== undefined)
      verboseEnv = /\bCOARENA_DIAGNOSTICS_VERBOSE=1\b/.test(env);
  }
  const plist = join(PACKAGED_APP, "Contents", "Info.plist");
  const plistValue = async (key) =>
    existsSync(plist)
      ? (
          (await readOut("plutil", ["-extract", key, "raw", plist])) ?? ""
        ).trim()
      : "";
  const bundleId = await plistValue("CFBundleIdentifier");
  const version = await plistValue("CFBundleShortVersionString");
  const build = await plistValue("CFBundleVersion");
  const executable = join(PACKAGED_APP, "Contents", "MacOS", "Butler");
  const executableMtime = existsSync(executable)
    ? statSync(executable).mtime.toISOString()
    : "";

  const tail = readTail(DIAG);
  const watch = new AppWatch();
  watch.feed(tail.events.filter((e) => Date.parse(e.timestamp) >= appStart));
  const verboseLog = tail.events
    .filter((e) => Date.parse(e.timestamp) >= appStart)
    .filter((e) => e.event === "Command" || e.event === "RunState")
    .map(
      (e) =>
        typeof e.data?.text === "string" || typeof e.data?.task === "string",
    )
    .at(-1);
  const verbose =
    verboseEnv === true || verboseLog === true
      ? true
      : verboseEnv === false || verboseLog === false
        ? false
        : null;
  // Open runs since the app's own start only: a run a crash or force-quit
  // cut off in an earlier session is not this app's, and it would refuse
  // every cycle until the log grew past it.
  const sinceStart =
    tail.text === undefined ? undefined : linesSince(tail.text, appStart);
  const unsettled = sinceStart === undefined ? 0 : unsettledRuns(sinceStart);
  const hidIdleSeconds = await readHidIdle();
  const volume = await readVolume();
  const levels = watch.recentLevels(60_000);
  const shortcuts = await readOut("shortcuts", ["list"], 15_000);
  // Setup waits for app windows through System Events, which needs the
  // terminal's own Accessibility grant; Finder always has a process to ask.
  const ax = await osascript(
    'tell application "System Events" to tell process "Finder" to return (count windows) as string',
  );
  const terminalAccessibility =
    ax.code === 0
      ? true
      : /assistive access|-25211|-1719/i.test(ax.stderr)
        ? false
        : null;
  return {
    terminalAccessibility,
    ps: ps !== undefined,
    apps,
    app,
    appStart,
    bundleId,
    version,
    build,
    executableMtime,
    harnessPids: ps === undefined ? [] : harnessProcesses(ps, process.pid),
    listening: watch.listening,
    permissions: watch.permissions,
    verbose,
    unsettled,
    hidIdleSeconds,
    volume,
    levels,
    quietFloor: medianLevel(levels),
    focusShortcut:
      shortcuts === undefined ? null : shortcuts.includes(FOCUS_SHORTCUT),
  };
}

const REMEDY = {
  NOT_PACKAGED_APP: `Launch ${PACKAGED_APP} yourself (the loop never launches it); a dev Electron or a second copy is refused.`,
  HARNESS_RUNNING:
    "Another cycle, bench or voice loop is driving this desktop. Wait for it or stop it.",
  DIAGNOSTICS_NOT_VERBOSE:
    "Relaunch Butler.app with COARENA_DIAGNOSTICS_VERBOSE=1 so transcripts and task text are readable.",
  NOT_LISTENING: 'Turn on "Hey Butler" in the tray and check the microphone.',
  PERMISSIONS:
    "Open Butler's Settings once so it records its permissions, and grant screen, accessibility, microphone and speech.",
  VOLUME: "Unmute and raise the output volume to at least 35.",
  RUN_LEFT_OPEN:
    "The app has a run in flight. Say stop to it yourself or wait; the loop never starts into someone else's run.",
  QUIET:
    "No standby trace to judge the room by (BUTLER_TRACE_STANDBY=1 in the app's environment), and --require-quiet was given.",
  PRESENCE_UNKNOWN:
    "ps could not be read, so nothing says whether another agent is here. Try again.",
  TERMINAL_ACCESSIBILITY:
    "Grant this terminal Accessibility (System Settings > Privacy & Security > Accessibility): setup waits for app windows through System Events and cannot see them without it.",
};
/** The refusals that matter with no app to speak to: a rehearsal only opens and closes windows. */
const REHEARSAL_CODES = [
  "PRESENCE_UNKNOWN",
  "HARNESS_RUNNING",
  "TERMINAL_ACCESSIBILITY",
];

/** Refusals of the whole cycle, from the facts. */
function preflightCodes(f) {
  const codes = [];
  if (!f.ps) codes.push("PRESENCE_UNKNOWN");
  if (f.terminalAccessibility === false) codes.push("TERMINAL_ACCESSIBILITY");
  if (!f.app || f.apps.length !== 1 || f.bundleId !== BUNDLE_ID)
    codes.push("NOT_PACKAGED_APP");
  if (f.harnessPids.length) codes.push("HARNESS_RUNNING");
  if (f.verbose !== true) codes.push("DIAGNOSTICS_NOT_VERBOSE");
  if (f.listening !== true) codes.push("NOT_LISTENING");
  const p = f.permissions;
  if (!p || !(p.screen && p.accessibility && p.microphone && p.speech))
    codes.push("PERMISSIONS");
  if (!f.volume || f.volume.muted || f.volume.level < 35) codes.push("VOLUME");
  if (f.unsettled > 0 && f.app) codes.push("RUN_LEFT_OPEN");
  if (values["require-quiet"] && f.levels.length < 3) codes.push("QUIET");
  return codes;
}

/* --------------------------------------------------------------- plan */

const gitOut = async (args) => ((await readOut("git", args)) ?? "").trim();
const gitRev = (await gitOut(["rev-parse", "--short", "HEAD"])) || "nogit";
const gitBranch = (await gitOut(["rev-parse", "--abbrev-ref", "HEAD"])) || "";
const dirty = (await gitOut(["status", "--porcelain"])) !== "";
const macos = (
  (await readOut("sw_vers", ["-productVersion"])) ?? release()
).trim();

const facts = await readFacts();
const skips = taskSkips(selection.tasks, {
  // A `shortcuts list` that failed or timed out is not a shortcut present:
  // the task's cleanup could not turn Focus off again (SHORTCUT_UNKNOWN).
  "focus-shortcut": facts.focusShortcut,
  // Notes automation is probed only for a real run: the probe may launch Notes.
});
const runnable = () => selection.tasks.filter((t) => !skips[t.id]);
const estimate = estimateSeconds(runnable(), repeat);
const cycleId =
  values["report-only"] ??
  values["cycle-id"] ??
  defaultCycleId(new Date(), gitRev);
if (!CYCLE_ID.test(cycleId)) {
  console.error(`--cycle-id ${cycleId} is not a folder name.`);
  process.exit(2);
}
const cycleDir = join(outDir, cycleId);

function planTask(t) {
  const first = turnsOf(t)[0];
  return {
    id: t.id,
    category: t.category,
    tags: t.tags,
    say: first.say,
    expectOutcome: turnsOf(t).at(-1).expect.outcome,
    timeoutMs: defaultTimeoutMs(t),
  };
}
const plan = {
  id: cycleId,
  startedAt: new Date().toISOString(),
  gitRev,
  gitBranch,
  dirty,
  host: { macos, arch: arch() },
  app: facts.app
    ? {
        path: PACKAGED_APP.replace(root + "/", ""),
        bundleId: facts.bundleId,
        version: facts.version,
        build: facts.build,
        executableMtime: facts.executableMtime,
      }
    : null,
  voice: values.voice,
  rate,
  wake: WAKE,
  idleSeconds,
  noisy: values.noisy,
  requireQuiet: values["require-quiet"],
  suiteHash: hash,
  tasks: selection.tasks.map(planTask),
  repeat,
};

function printFacts() {
  const codes = preflightCodes(facts);
  console.log(
    `app: ${facts.app ? `packaged ${facts.bundleId} ${facts.version} (${facts.build}), pid ${facts.app.pid}` : facts.apps.length ? `${facts.apps.length} process(es), none the packaged bundle` : "not running"}`,
  );
  console.log(
    `listening ${facts.listening ?? "unknown"} · verbose ${facts.verbose ?? "unknown"} · permissions ${
      facts.permissions
        ? Object.entries(facts.permissions)
            .map(([k, v]) => `${k}=${v}`)
            .join(" ")
        : "not recorded"
    }`,
  );
  console.log(
    `idle ${facts.hidIdleSeconds === undefined ? "unknown" : `${Math.round(facts.hidIdleSeconds)} s`} (need ${idleSeconds}) · volume ${
      facts.volume
        ? `${facts.volume.level}${facts.volume.muted ? " muted" : ""}`
        : "unknown"
    } · quiet ${facts.levels.length >= 3 ? `trace, floor ${facts.quietFloor}` : "no trace (QUIET_UNKNOWN)"} · open runs ${facts.unsettled} · terminal accessibility ${facts.terminalAccessibility ?? "unknown"}`,
  );
  console.log(`preflight: ${codes.length ? codes.join(", ") : "ready"}`);
  for (const code of codes) console.log(`  ${code}: ${REMEDY[code]}`);
  return codes;
}

if (values["dry-run"]) {
  console.log(
    `Dry run: voice cycle ${cycleId} at ${gitRev}${dirty ? " (dirty)" : ""}: ${selection.tasks.length} task(s) x ${repeat} = ${selection.tasks.length * repeat} turn(s), ${values.noisy ? "noisy on" : "noisy off"}.`,
  );
  console.log(
    "Nothing spoken, no file written and nothing on this Mac touched in a dry run.\n",
  );
  printFacts();
  console.log(
    `suite ${hash.slice(0, 12)} · estimate ${Math.round(estimate / 60)} min of a ${Math.round(timeBoxSeconds / 60)} min time box`,
  );
  if (Object.keys(skips).length)
    console.log(
      `skipped: ${Object.entries(skips)
        .map(([id, code]) => `${id} (${code})`)
        .join(", ")}`,
    );
  console.log(
    `automation consent probes (${Object.keys(AUTOMATION_PROBES).join(", ")}; they may launch the app) run only for a real cycle or --rehearse.\n`,
  );
  console.log("plan:");
  for (const t of selection.tasks) {
    const turns = turnsOf(t);
    console.log(
      `  ${t.id}  [${t.category}; ${t.tags.join(", ")}]  expects ${turns.at(-1).expect.outcome}, ${Math.round(defaultTimeoutMs(t) / 1000)} s${skips[t.id] ? `  SKIP ${skips[t.id]}` : ""}`,
    );
    for (const turn of turns)
      console.log(
        `      say: ${turn.withWake ? `${WAKE}, ` : ""}${turn.say.replaceAll("{wake}", WAKE)}`,
      );
    console.log(`      ${t.notes}`);
  }
  process.exit(0);
}

/* ------------------------------------------------------------ report-only */

function writeOutputs(results) {
  mkdirSync(cycleDir, { recursive: true });
  writeFileSync(
    join(cycleDir, "results.json"),
    `${JSON.stringify(results, null, 2)}\n`,
  );
  writeFileSync(join(cycleDir, "report.md"), `${renderReport(results)}\n`);
  // `<CODE>.voice.md`: the fix loop writes its own `<code>.md` into the same
  // folder, and on a case-insensitive disk `UNHEARD.md` and `unheard.md` are
  // one file. The voice brief carries the voice probe; the loop's, the bench's.
  const laneDir = join(cycleDir, "lanes");
  mkdirSync(laneDir, { recursive: true });
  for (const cls of results.failureClasses)
    if (!ENVIRONMENT_CODES.includes(cls.code) && cls.attempts > 0)
      writeFileSync(
        join(laneDir, `${cls.code}.voice.md`),
        `${fixBrief(cls, results)}\n`,
      );
}

/** The newest earlier voice cycle at the same suite hash, for the comparison. */
function previousCycle() {
  if (!existsSync(outDir)) return null;
  const candidates = readdirSync(outDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter(
      (name) =>
        name !== cycleId && existsSync(join(outDir, name, "results.json")),
    )
    .sort()
    .reverse();
  for (const name of candidates) {
    try {
      const parsed = JSON.parse(
        readFileSync(join(outDir, name, "results.json"), "utf8"),
      );
      if (parsed.kind === "voice" && parsed.cycle?.suiteHash === hash)
        return parsed;
    } catch {
      /* not a cycle */
    }
  }
  return null;
}

if (values["report-only"]) {
  const ledgerPath = join(cycleDir, "ledger.jsonl");
  const planPath = join(cycleDir, "plan.json");
  if (!existsSync(ledgerPath) || !existsSync(planPath)) {
    console.error(`No ledger for cycle ${cycleId} in ${outDir}.`);
    process.exit(2);
  }
  const stored = JSON.parse(readFileSync(planPath, "utf8"));
  const rows = parseLines(readFileSync(ledgerPath, "utf8").split("\n"));
  const turns = rows.filter((r) => r.kind === "turn").map((r) => r.record);
  const abort = rows.find((r) => r.kind === "abort");
  const stop = rows.find((r) => r.kind === "stop");
  const results = buildResults({
    plan: stored.plan,
    turns,
    preflight: stored.preflight,
    gate: gateWaits(rows.filter((r) => r.kind === "gate")),
    previous: previousCycle(),
    finishedAt: new Date().toISOString(),
    aborted: abort
      ? { code: abort.code, turnId: abort.turnId, at: abort.at }
      : null,
    stoppedBecause: stop?.reason,
  });
  writeOutputs(results);
  console.log(
    `Rewrote ${join(cycleDir, "results.json")} and report.md from the ledger.`,
  );
  process.exit(0);
}

/** Seconds by reason from milliseconds by reason, rounded. */
const secondsByReason = (byReasonMs) =>
  Object.fromEntries(
    Object.entries(byReasonMs ?? {}).map(([reason, ms]) => [
      reason,
      Math.round(ms / 1000),
    ]),
  );

/** The cycle's gate account: waits that refused at least once, their time by reason, and the wait that gave up, if one did. */
function gateWaits(rows) {
  const byReason = {};
  const byReasonMs = {};
  let total = 0;
  let longest = 0;
  let gaveUp = null;
  for (const row of rows) {
    total += row.waitedMs ?? 0;
    longest = Math.max(longest, row.waitedMs ?? 0);
    for (const [reason, n] of Object.entries(row.reasons ?? {}))
      byReason[reason] = (byReason[reason] ?? 0) + n;
    for (const [reason, ms] of Object.entries(row.byReasonMs ?? {}))
      byReasonMs[reason] = (byReasonMs[reason] ?? 0) + ms;
    if (row.stop && !gaveUp)
      gaveUp = {
        turnId: row.turnId,
        code: row.stop,
        waitedSeconds: Math.round((row.waitedMs ?? 0) / 1000),
        on: row.on ?? null,
        byReasonSeconds: secondsByReason(row.byReasonMs),
        evidence: row.evidence ?? null,
      };
  }
  return {
    count: rows.filter((r) => Object.keys(r.reasons ?? {}).length > 0).length,
    totalSeconds: Math.round(total / 1000),
    byReason,
    byReasonSeconds: secondsByReason(byReasonMs),
    longestSeconds: Math.round(longest / 1000),
    gaveUp,
  };
}

/* ------------------------------------------------------------- consent */

if (!values["i-know-this-speaks-to-my-mac"]) {
  console.error(
    values.rehearse
      ? `A rehearsal runs ${selection.tasks.length} task setup(s) and cleanup(s) on this Mac: it opens and closes windows and speaks nothing.\n` +
          "Re-run with --i-know-this-speaks-to-my-mac.\n"
      : `This speaks ${selection.tasks.length * repeat} prompt(s) to the running Butler.app, which will act on this Mac,\n` +
          `after it has been left alone for ${idleSeconds} s. Re-run with --i-know-this-speaks-to-my-mac,\n` +
          "or use --dry-run first.\n",
  );
  printFacts();
  process.exit(2);
}

console.log(
  values.rehearse
    ? `Rehearsal at ${gitRev}${dirty ? " (dirty)" : ""}: setup and cleanup of ${selection.tasks.length} task(s), nothing spoken.`
    : `Voice cycle ${cycleId} at ${gitRev}${dirty ? " (dirty)" : ""}: ${selection.tasks.length} task(s) x ${repeat}.`,
);
// A rehearsal needs no app to speak to: only another agent on the desktop
// or a terminal that cannot see windows refuses it.
const refusals = printFacts().filter(
  (code) => !values.rehearse || REHEARSAL_CODES.includes(code),
);
if (refusals.length) process.exit(2);

// One agent on the desktop: the same lock the cycle and the bench take.
const lockFile = desktopLockPath();
const lock = acquireDesktopLock(lockFile, {
  pid: process.pid,
  script: "voice-loop",
  cycle: cycleId,
  startedAt: plan.startedAt,
});
if (!lock.ok) {
  console.error(
    `HARNESS_RUNNING: ${lock.holder ? `${lock.holder.script} (pid ${lock.holder.pid}) holds ${lockFile}` : `${lockFile} cannot be read; remove it yourself`}.`,
  );
  process.exit(2);
}
const releaseLock = () => releaseDesktopLock(lockFile, process.pid);

// Automation consent, probed now for every app the runnable tasks' setups or
// checks send Apple Events to (Notes, TextEdit, Safari). The first event to
// an app raises macOS's consent prompt for this terminal, and cycle 1
// (2026-09-19 00:55) hung four setups on it with nobody at the Mac; asked
// here, while the owner is still at the keyboard, a denial or an unanswered
// prompt skips those tasks with a subcode instead. The probe obeys the
// suite's own rule: an app that is not running is launched through
// LaunchServices (TextEdit with a probe document, so no open panel), its
// window awaited through System Events, and only then sent the event. It is
// quit again only if it was not running: through Apple Events when the
// consent came, TextEdit (holding only the probe document) with pkill when
// it did not; Notes and Safari are then left as the prompt left them.
const PROBE_FILE = "/tmp/butler-voice-loop-probe.txt";
const PROBE = {
  Notes: {
    launch: "open -a Notes",
    event: 'tell application "Notes" to count notes',
  },
  TextEdit: {
    launch: `printf 'Butler voice loop probe\\n' > "${PROBE_FILE}" && open -a TextEdit "${PROBE_FILE}"`,
    event: 'tell application "TextEdit" to count documents',
  },
  Safari: {
    launch: "open -a Safari",
    event: 'tell application "Safari" to count windows',
  },
};
async function probeAutomation(app) {
  const wasRunning =
    (
      await osascript(
        `tell application "System Events" to return (exists process "${app}") as string`,
      )
    ).stdout.trim() === "true";
  let windowSeen = true;
  if (!wasRunning) {
    await sh(PROBE[app].launch);
    windowSeen = (
      await pollUntilTrue(
        (ms) =>
          osascript(
            `tell application "System Events" to return (exists (window 1 of process "${app}")) as string`,
            ms,
          ),
        { timeoutMs: 20_000, sleep },
      )
    ).ok;
  }
  const probe = windowSeen
    ? await osascript(PROBE[app].event, 20_000)
    : { code: 124, ms: 20_000, stderr: "no window after launch" };
  const denied =
    probe.code !== 0 && /-1743|not allowed|Not authorized/i.test(probe.stderr);
  const consent = probe.code === 0 ? true : denied ? false : null;
  if (consent !== true)
    console.log(
      `${app} automation ${consent === false ? "denied" : `unknown (the probe exited ${probe.code} after ${probe.ms} ms; a consent prompt may be waiting on screen)`}; its tasks are skipped.`,
    );
  if (!wasRunning) {
    if (consent === true)
      await osascript(
        `if application "${app}" is running then tell application "${app}" to quit${app === "TextEdit" ? " saving no" : ""}`,
      );
    else if (app === "TextEdit") await sh("pkill -x TextEdit; true");
  }
  if (app === "TextEdit") await sh(`rm -f "${PROBE_FILE}"`);
  return consent;
}
{
  const needed = new Set(runnable().flatMap(taskProbes));
  const consents = {};
  for (const [app, probe] of Object.entries(AUTOMATION_PROBES))
    if (needed.has(probe)) consents[probe] = await probeAutomation(app);
  Object.assign(skips, taskSkips(selection.tasks, consents));
}
for (const [id, code] of Object.entries(skips))
  console.log(`skip ${id}: ${code}`);
if (!runnable().length) {
  console.error("NOTHING_TO_RUN: every selected task is skipped.");
  releaseLock();
  process.exit(2);
}

/* ------------------------------------------------------------ rehearsal */

/**
 * Runs every selected task's setup, then its cleanup, once, and prints each
 * step's exit code and time: the way to prove a setup cannot hang before a
 * cycle spends an evening on it. Nothing is spoken and no cycle folder is
 * written; the markers go under /tmp like a cycle's.
 */
async function rehearse() {
  const rehearsalDir = join("/tmp", "voice-loop", "rehearsal");
  mkdirSync(rehearsalDir, { recursive: true });
  let failed = 0;
  for (const task of runnable()) {
    const token = voiceToken();
    const fill = {
      token,
      benchDir: benchDirFor(homedir(), token),
      wake: WAKE,
      marker: join(rehearsalDir, `${task.id}.marker`),
      state: {},
    };
    writeFileSync(fill.marker, "");
    const started = Date.now();
    let failure = null;
    try {
      for (const [index, step] of (task.setup ?? []).entries()) {
        const result = await runStep(step, fill);
        console.log(
          `  ${task.id} setup ${stepName(index, step)}: exit ${result.code} in ${result.ms} ms`,
        );
        if (result.code !== 0) {
          failure = setupFailureDetail(index, step, result, homedir());
          break;
        }
        if (step.record) fill.state[step.record] = result.stdout.trim();
      }
    } finally {
      await cleanup(task, fill);
    }
    if (failure) {
      failed++;
      console.log(`  ${task.id}: SETUP_FAILED ${JSON.stringify(failure)}`);
    } else
      console.log(
        `  ${task.id}: setup and cleanup ok in ${Date.now() - started} ms`,
      );
  }
  console.log(
    failed
      ? `${failed} setup(s) failed; every cleanup ran.`
      : "Every setup ran and was cleaned up.",
  );
  return failed ? 1 : 0;
}

if (values.rehearse) {
  let code = 1;
  try {
    code = await rehearse();
  } finally {
    releaseLock();
  }
  process.exit(code);
}

/* --------------------------------------------------------------- output */

mkdirSync(cycleDir, { recursive: true });
mkdirSync(join(cycleDir, "diagnostics"), { recursive: true });
const markerDir = join("/tmp", "voice-loop", cycleId);
mkdirSync(markerDir, { recursive: true });
const ledgerPath = join(cycleDir, "ledger.jsonl");
const turnsPath = join(cycleDir, "turns.jsonl");
const diagCopy = join(cycleDir, "diagnostics", "current.jsonl");
const ledger = (row) =>
  appendFileSync(
    ledgerPath,
    `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`,
  );

const preflightFacts = {
  codes: [],
  listening: facts.listening,
  permissions: facts.permissions,
  verbose: facts.verbose,
  quiet: {
    floor: facts.quietFloor ?? null,
    speech: null,
    threshold: null,
    source: facts.levels.length >= 3 ? "trace" : "none",
  },
  volume: facts.volume?.level ?? null,
  skipped: skips,
};
writeFileSync(
  join(cycleDir, "plan.json"),
  `${JSON.stringify({ plan, preflight: preflightFacts }, null, 2)}\n`,
);
ledger({
  kind: "start",
  cycle: cycleId,
  tasks: runnable().map((t) => t.id),
  repeat,
});

/* -------------------------------------------------------------- the loop */

const tail = new Tail(DIAG);
const watch = new AppWatch();
watch.feed(
  readTail(DIAG).events.filter(
    (e) => Date.parse(e.timestamp) >= facts.appStart,
  ),
);
const V = facts.volume.level;
const deadline = Date.now() + timeBoxSeconds * 1000;
const records = [];
const gateRows = [];
let humanSeenAt;
let speechLevel = null;
// The quiet gate starts from the floor alone (max(3 x floor, floor + 4)) and
// tightens to floor + 0.35 x (speech - floor) once a real sample of the
// loop's own voice is captured; a pre-speech room sample never calibrates it.
let quietThresholdValue =
  preflightFacts.quiet.source === "trace" && facts.quietFloor !== undefined
    ? quietThreshold(facts.quietFloor)
    : null;
preflightFacts.quiet.threshold = quietThresholdValue;
let interrupts = 0;
let stopRequested = false;
let stoppedBecause;
process.on("SIGINT", () => {
  interrupts++;
  if (interrupts >= 2) {
    releaseLock();
    process.exit(130);
  }
  stopRequested = true;
  console.log("\nStopping after this turn (Ctrl-C again to exit at once).");
});

const feed = () => {
  const fresh = tail.read();
  watch.feed(fresh);
  return fresh;
};

/** The current gate facts, from the log and two read-only commands. */
async function gateFacts() {
  feed();
  const now = Date.now();
  const quiet =
    quietThresholdValue !== null
      ? {
          levels: watch.recentLevels(15_000, now),
          threshold: quietThresholdValue,
          heardTextAt: watch.heardTextAt,
        }
      : undefined;
  return {
    now,
    hidIdleSeconds: await readHidIdle(),
    idleSeconds,
    humanSeenAt,
    lastActionAt: watch.lastActionAt,
    listening: watch.listening,
    lastEventAt: watch.lastEventAt,
    speechFinishedAt: watch.speechFinishedAt,
    followupOpen: watch.followupOpen,
    runOpen: watch.runOpen,
    quiet,
    volume: undefined,
  };
}

/**
 * Waits for the gate: a settled, listening app, a quiet room, the volume
 * as calibrated and nobody at the Mac. Returns the wait facts, or a stop
 * when the time box or the cap is reached.
 */
async function waitGate(task, { checkVolume = true } = {}) {
  const started = Date.now();
  // Every refused poll is accounted to its reason (grade.ts GateWait): the
  // cap counts refused time only, one reason held two minutes without a
  // break is the app's own fault (RUN_LEFT_OPEN, WINDOW_STUCK,
  // NOT_LISTENING), and the row is logged whether the gate opened or gave
  // up. Cycle 3 (2026-09-19 09:07) waited ten minutes on a person at the
  // Mac and the report could not say so.
  const wait = new GateWait(started);
  const opensAtStart = watch.followupOpens;
  let idleSeen = null;
  let quietRms = null;
  const row = (extra = {}) => ({
    waitedMs: Date.now() - started,
    ...wait.summary(),
    reasons: wait.byReasonPolls,
    idleSeen,
    quietRms,
    ...extra,
  });
  /** What the app was stuck on, for the ledger: statuses, kinds and milliseconds only. */
  const evidence = (stop, now) => {
    if (stop === "RUN_LEFT_OPEN") return { runs: watch.openRuns(now) };
    if (stop === "WINDOW_STUCK")
      return {
        kind: watch.followupKind,
        openMs:
          watch.followupOpenedAt === undefined
            ? null
            : now - watch.followupOpenedAt,
        opens: watch.followupOpens - opensAtStart,
      };
    if (stop === "NOT_LISTENING")
      return {
        listening: watch.listening,
        sinceMs:
          watch.listeningAt === undefined ? null : now - watch.listeningAt,
      };
    return undefined;
  };
  for (;;) {
    if (stopRequested) return row({ stop: "interrupted" });
    const f = await gateFacts();
    if (checkVolume) {
      const volume = await readVolume();
      if (volume)
        f.volume = { level: volume.level, muted: volume.muted, wanted: V };
    }
    if (f.now + defaultTimeoutMs(task) + 30_000 > deadline)
      return row({ stop: "TIME_BOX" });
    const decision = voiceGate(f);
    idleSeen = decision.idle?.seen ?? idleSeen;
    quietRms = f.quiet?.levels.at(-1) ?? quietRms;
    if (decision.ok) {
      humanSeenAt = undefined;
      return row();
    }
    wait.refuse(decision.reason, Date.now());
    if (
      decision.reason === "HID_ACTIVE" &&
      humanSeenAt === undefined &&
      (f.hidIdleSeconds ?? 0) < 5
    ) {
      // Input just now, and the app did nothing to explain it: a person.
      const appActed =
        watch.lastActionAt !== undefined && f.now - watch.lastActionAt < 5000;
      if (!appActed) humanSeenAt = f.now;
    }
    if (
      decision.reason === "VOLUME" &&
      f.volume &&
      !f.volume.muted &&
      Math.abs(f.volume.level - V) > 2
    ) {
      // A previous task or the owner moved it; the loop needs its own level to be heard.
      await setVolume(V, false);
    }
    const stop = wait.verdict(Date.now(), { capMs: GATE_CAP_MS });
    if (stop) {
      const now = Date.now();
      console.log(
        `  gate gave up (${stop}) after ${Math.round((now - started) / 1000)} s: ${Object.entries(
          wait.byReasonMs,
        )
          .map(([reason, ms]) => `${reason} ${Math.round(ms / 1000)} s`)
          .join(", ")}`,
      );
      return row({ stop, evidence: evidence(stop, now) ?? null });
    }
    await sleep(GATE_POLL_MS);
  }
}

/** The ledger's gate row: the wait's account, and the stop with its evidence when it gave up. */
function gateLedgerRow(turnId, gate, phase) {
  return {
    kind: "gate",
    turnId,
    ...(phase ? { phase } : {}),
    waitedMs: gate.waitedMs,
    polls: gate.polls,
    refusedMs: gate.refusedMs,
    reasons: gate.reasons,
    byReasonMs: gate.byReasonMs,
    ...(gate.stop
      ? { stop: gate.stop, on: gate.on, evidence: gate.evidence ?? null }
      : {}),
  };
}

/**
 * A gate that gave up: the cap, the time box and Ctrl-C stop the cycle in
 * order; the app's own fault (a run left open, a window that never closed,
 * a helper that stopped listening) aborts it with its own code and the
 * evidence, as a run left open after a turn does, and nothing more is said.
 */
function gateOutcome(gate, turnId) {
  return ["GATE_CAP", "TIME_BOX", "interrupted"].includes(gate.stop)
    ? { stop: gate.stop }
    : { abort: gate.stop, turnId };
}

/**
 * Says "stop" for a run still going or a pending confirmation (never for an
 * unheard prompt) and waits up to 5 s for a terminal RunState. Returns the
 * events it saw so the utterance's summary sees the end of the run.
 */
async function stopRun(into) {
  const said = await speak(`${WAKE}, stop`);
  if (said.failed) return false;
  const until = Date.now() + STOP_WAIT_MS;
  while (Date.now() < until) {
    into.push(...feed().filter((e) => !SKIP.has(e.event)));
    if (!watch.runOpen) break;
    await sleep(POLL_MS);
  }
  return !watch.runOpen;
}

/** Whether a later turn's trigger has fired in the current utterance's events. */
function triggerFired(trigger, events) {
  return events.some((e) => {
    const d = e.data ?? {};
    switch (trigger.event) {
      case "followup_open":
        return (
          e.event === "VoiceEvent" &&
          d.phase === "followup_open" &&
          (!trigger.kind || d.kind === trigger.kind)
        );
      case "speech_started":
      case "speech_finished":
      case "transcript_final":
        return e.event === "VoiceEvent" && d.phase === trigger.event;
      case "SpeechOut":
        return e.event === "SpeechOut" && d.phase === "requested";
      case "RunStarted":
      case "ActionExecuted":
        return e.event === trigger.event;
      case "RunState":
        return (
          e.event === "RunState" &&
          (!trigger.status || d.status === trigger.status)
        );
    }
    return false;
  });
}

/** Background reading for a noisy task; `stop()` kills whatever is still going. */
function startNoise(task) {
  const procs = [];
  const timers = [];
  const text = (key) =>
    `[[volm ${task.noise?.volm ?? 0.45}]] ${suite.paragraphs[key]}`;
  const read = (key, foreground = false) =>
    new Promise((resolveRead) => {
      const child = spawn(
        "say",
        ["-v", task.noise.voice, "-r", "170", text(key)],
        { stdio: "ignore" },
      );
      procs.push(child);
      child.on("close", () => resolveRead());
      child.on("error", () => resolveRead());
      if (!foreground) resolveRead();
    });
  return {
    async before() {
      if (!task.noise) return;
      if (task.noise.gapAt === "before-prompt")
        await read(task.noise.paragraph, true);
      else {
        await read(task.noise.paragraph);
        await sleep(task.noise.leadMs);
      }
      timers.push(setTimeout(() => this.stop(), NOISE_MAX_MS));
    },
    afterPromptStarted() {
      if (task.noise?.second)
        timers.push(
          setTimeout(
            () => read(task.noise.second.paragraph),
            task.noise.second.afterMs,
          ),
        );
    },
    onTranscript() {
      timers.push(setTimeout(() => this.stop(), 3000));
    },
    stop() {
      for (const t of timers) clearTimeout(t);
      for (const p of procs) if (p.exitCode === null) p.kill();
    },
  };
}

/** Strips the verbose text a summary carries before it goes to the ledger. */
function contentFree(summary) {
  return {
    ...summary,
    transcript: null,
    task: null,
    messages: [],
    confirmReason: null,
  };
}

async function runTask(task, attempt) {
  const turns = turnsOf(task);
  const turnId = `${task.id}#${attempt}`;
  const token = voiceToken();
  const marker = join(markerDir, `${task.id}-${attempt}.marker`);
  const fill = {
    token,
    benchDir: benchDirFor(homedir(), token),
    wake: WAKE,
    marker,
    state: {},
  };
  const startedAt = new Date().toISOString();
  const wallStart = Date.now();
  const utterances = [];
  const context = { verbose: true, fill };
  const evidence = {};
  let aborted = null;
  let sayFailed = false;
  let noise;
  let setupFailure = null;
  let setupStderr = null;

  // The wait is logged whether the gate opened or gave up, so the report
  // says what it waited on and for how long either way.
  const gate = await waitGate(task);
  gateRows.push({ turnId, ...gate });
  ledger(gateLedgerRow(turnId, gate));
  if (gate.stop) return gateOutcome(gate, turnId);

  // Setup and cleanup are paired in try/finally: whatever ends the task, a
  // crash included, its window is closed and the speakers are put back.
  try {
    // Setup, then the gate once more (setup takes seconds and the owner may be back).
    // A failed step is recorded with its index, exit code, time and what it
    // said, content-free, so the report names the reason and not just the code.
    for (const [index, step] of (task.setup ?? []).entries()) {
      const result = await runStep(step, fill);
      if (result.code !== 0) {
        context.envSubcode = "SETUP_FAILED";
        setupFailure = setupFailureDetail(index, step, result, homedir());
        setupStderr = result.stderr;
        console.log(
          `  ${turnId}: setup ${stepName(index, step)} exited ${result.code} after ${result.ms} ms${setupFailure.said ? `: ${setupFailure.said}` : ""}`,
        );
        break;
      }
      if (step.record) fill.state[step.record] = result.stdout.trim();
    }
    if (!context.envSubcode) {
      const again = await waitGate(task, { checkVolume: false });
      if (again.polls || again.stop) {
        gateRows.push({ turnId, phase: "after-setup", ...again });
        ledger(gateLedgerRow(turnId, again, "after-setup"));
      }
      if (again.stop) return gateOutcome(again, turnId);
    }

    if (!context.envSubcode) {
      writeFileSync(marker, "");
      feed();
      noise = startNoise(task);
      await noise.before();
      const timeoutMs = defaultTimeoutMs(task);
      const unheardMs = task.unheardMs ?? DEFAULT_UNHEARD_MS;
      let turnDeadline = Date.now() + timeoutMs;
      let promptStartedAt = Date.now();
      let lastHid = { at: 0, idle: undefined };
      const hidTracker = new HidTakeoverTracker();
      const anyRun = () =>
        summarizeUtterances(utterances).some((s) => s.runStarted);
      // Only a takeover since this prompt is this turn's: the log tail fed at
      // startup holds every earlier one of the session.
      const personHere = () => watch.takeoverSince(promptStartedAt);

      outer: for (let i = 0; i < turns.length; i++) {
        const turn = turns[i];
        const previous = utterances.at(-1);
        if (i > 0) {
          const trigger = turn.after;
          const followup = trigger.event === "followup_open";
          for (;;) {
            previous.events.push(...feed().filter((e) => !SKIP.has(e.event)));
            if (personHere()) {
              aborted = "TAKEOVER";
              break outer;
            }
            if (Date.now() > turnDeadline || stopRequested) {
              context.timedOut = watch.runOpen;
              break outer;
            }
            if (followup) {
              // The window the app opens right after the transcript is closed
              // ~300 ms later for its own ack (trial 05:43 #2); the line goes
              // into a window that is open, with no reply pending, before
              // and after the delay, on fresh events each time.
              if (watch.followupReady(trigger.kind)) {
                await sleep(trigger.plus ?? 300);
                previous.events.push(
                  ...feed().filter((e) => !SKIP.has(e.event)),
                );
                if (watch.followupReady(trigger.kind)) break;
              }
            } else if (triggerFired(trigger, previous.events)) {
              await sleep(trigger.plus ?? 300);
              break;
            }
            await sleep(POLL_MS);
          }
          if (!turn.bargeIn) {
            // Wait out the app's speech and its echo guard, read fresh.
            const until = Date.now() + 15_000;
            for (;;) {
              previous.events.push(...feed().filter((e) => !SKIP.has(e.event)));
              const quiet =
                !watch.speaking &&
                !(
                  watch.speechFinishedAt &&
                  Date.now() - watch.speechFinishedAt < 800
                );
              if (quiet || Date.now() >= until) break;
              await sleep(POLL_MS);
            }
          }
        }
        const line = fillPlaceholders(turn.say, fill);
        const text = turn.withWake ? `${WAKE}, ${line}` : line;
        const said = await speak(text);
        if (said.failed) {
          console.log(`  ${turnId}: say failed (${said.failed})`);
          context.envSubcode = "SAY_FAILED";
          sayFailed = true;
          break;
        }
        const { spokenAt, sayEndedAt } = said;
        if (i === 0) {
          promptStartedAt = spokenAt;
          turnDeadline = sayEndedAt + timeoutMs;
          noise.afterPromptStarted();
        }
        const utterance = { spokenAt, sayEndedAt, events: [] };
        utterances.push(utterance);
        // The run status the earlier lines left: the app writes RunState only
        // on a change, so a pause the last line caused is never re-emitted.
        const carried =
          i > 0
            ? summarizeUtterances(utterances.slice(0, -1)).at(-1).lastStatus
            : null;
        const unheardDeadline = sayEndedAt + unheardMs;
        const isLast = i === turns.length - 1;
        let idleSince = Date.now();
        let noiseStopped = false;
        for (;;) {
          const fresh = feed();
          const kept = fresh.filter((e) => !SKIP.has(e.event));
          utterance.events.push(...kept);
          if (kept.some((e) => !isChatter(e))) idleSince = Date.now();
          const s = summarizeTurn(
            utterance.events,
            spokenAt,
            sayEndedAt,
            carried,
          );
          // Calibrate the quiet threshold against the loop's own voice, once
          // a level inside its say window is clearly speech, not the room.
          if (speechLevel === null && quietThresholdValue !== null) {
            const during = watch.levels
              .filter((l) => l.at >= spokenAt && l.at <= sayEndedAt + 2000)
              .map((l) => l.rms);
            const level = during.length ? Math.max(...during) : undefined;
            if (
              level !== undefined &&
              isSpeechSample(facts.quietFloor, level)
            ) {
              speechLevel = level;
              quietThresholdValue = quietThreshold(facts.quietFloor, level);
              preflightFacts.quiet.speech = level;
              preflightFacts.quiet.threshold = quietThresholdValue;
            }
          }
          if (s.transcriptMs !== null && !noiseStopped) {
            noise.onTranscript();
            noiseStopped = true;
          }
          // A person at the Mac ends the cycle, and nothing more is said. A
          // HID reset is a suspect first, and a person only when the app's
          // own ActionExecuted has not explained it a few seconds later.
          if (Date.now() - lastHid.at > 1000)
            lastHid = { at: Date.now(), idle: await readHidIdle() };
          const hid = hidTracker.observe({
            now: lastHid.at,
            hidIdleSeconds: lastHid.idle,
            promptStartedAt,
            lastActionAt: watch.lastActionAt,
            runOpen: watch.runOpen,
          });
          if (s.takeover || personHere() || hid) {
            if (hid && !s.takeover) context.hidTakeover = true;
            aborted = "TAKEOVER";
            break outer;
          }
          // Never approve: a confirmation, a click or a hand asked for is
          // declined with stop, so the run ends now and not at the timeout.
          if (
            (s.confirmations > 0 || s.needClick || s.handoffSources.length) &&
            !context.stoppedByLoop &&
            watch.runOpen
          ) {
            context.stoppedByLoop = true;
            await stopRun(utterance.events);
          }
          if (!isLast && triggerFired(turns[i + 1].after, utterance.events))
            break;
          if (
            isLast &&
            lastTurnDone(turn, s, {
              anyRun: anyRun(),
              quietMs: Date.now() - idleSince,
              elapsedMs: Date.now() - spokenAt,
              pastUnheardDeadline: Date.now() > unheardDeadline,
              stopRunAfter: !!task.stopRunAfter,
            })
          )
            break;
          if (Date.now() > turnDeadline || stopRequested) {
            context.timedOut = watch.runOpen;
            break outer;
          }
          await sleep(POLL_MS);
        }
      }
      noise.stop();

      if (!aborted) {
        // The end of a steering task, or a timeout: stop only a run still going.
        if (watch.runOpen && (task.stopRunAfter || context.timedOut)) {
          context.stoppedByLoop = true;
          await stopRun(utterances.at(-1).events);
        }
        if (watch.runOpen) {
          context.envSubcode = "RUN_LEFT_OPEN";
          aborted = "RUN_LEFT_OPEN";
        }
      }
      // The state, read back only when the prompt reached the app.
      const last = turns.at(-1).expect;
      const heardAtAll =
        utterances.length &&
        summarizeTurn(
          utterances[0].events,
          utterances[0].spokenAt,
          utterances[0].sayEndedAt,
        ).wakeMs !== null;
      if (
        !aborted &&
        !sayFailed &&
        (heardAtAll || last.outcome === "silence")
      ) {
        const checks = turns.flatMap((t) => t.expect.state ?? []);
        for (const check of checks) {
          const result = await runStep(check, fill);
          evidence[check.name] = {
            value: result.code === 0 ? result.stdout : undefined,
            exitCode: result.code,
            ms: result.ms,
          };
        }
        if (last.frontmost) {
          const result = await osascript(FRONTMOST_SCRIPT);
          evidence.frontmost = {
            value: result.code === 0 ? result.stdout : undefined,
            exitCode: result.code,
            ms: result.ms,
          };
        }
      }
    }
  } finally {
    noise?.stop();
    await cleanup(task, fill);
    // The loop needs the speakers at its own level after every task.
    const volume = await readVolume();
    if (volume && (volume.muted || Math.abs(volume.level - V) > 2))
      await setVolume(V, false);
  }

  const summaries = summarizeUtterances(utterances);
  const grade = gradeTurn(task, summaries, evidence, context);
  const classification = classify(grade);
  const record = {
    turnId,
    taskId: task.id,
    attempt,
    at: startedAt,
    wallMs: Date.now() - wallStart,
    grade,
    classification,
    summaries: summaries.map(contentFree),
    gate: {
      waitedMs: gate.waitedMs,
      reasons: gate.reasons,
      idleSeen: gate.idleSeen,
      quietRms: gate.quietRms,
    },
    setup: setupFailure,
  };
  records.push(record);
  ledger({ kind: "turn", record });
  // Transcripts, task text, messages and a failed setup's whole stderr:
  // local only, for the engineer's eyes.
  appendFileSync(
    turnsPath,
    `${JSON.stringify({
      turnId,
      setupStderr,
      utterances: summaries.map((s) => ({
        transcript: s.transcript,
        task: s.task,
        messages: s.messages,
        confirmReason: s.confirmReason,
      })),
    })}\n`,
  );
  for (const [index, u] of utterances.entries())
    for (const e of u.events)
      appendFileSync(
        diagCopy,
        `${JSON.stringify({ ...e, voiceTurn: utterances.length > 1 ? `${turnId}/t${index + 1}` : turnId })}\n`,
      );
  const ms = (v) =>
    v === null || v === undefined ? "-" : `${Math.round(v)} ms`;
  const first = summaries[0];
  console.log(
    `${classification.pass ? "PASS" : "FAIL"} ${turnId}${classification.code ? ` ${classification.code}${classification.subcode ? `/${classification.subcode}` : ""}` : ""}${classification.softCode ? ` +${classification.softCode}` : ""}` +
      `  heard ${grade.heard} · wake ${ms(first?.wakeMs)} · transcript ${ms(first?.transcriptMs)} · plan ${first?.plan ?? "-"} · run ${grade.runStarted ? (grade.terminal ?? "open") : "none"} · actions ${grade.actions} · confirmations ${grade.confirmations}`,
  );
  writeResults();
  if (aborted) {
    ledger({ kind: "abort", code: aborted, turnId });
    return { abort: aborted, turnId };
  }
  // A voice that cannot speak will not speak the next prompt either.
  if (sayFailed) return { stop: "SAY_FAILED" };
  return {};
}

async function cleanup(task, fill) {
  for (const [index, step] of (task.cleanup ?? []).entries()) {
    try {
      const result = await runStep(step, fill);
      if (result.code !== 0)
        console.log(
          `  ${task.id} cleanup ${stepName(index, step)} exited ${result.code} after ${result.ms} ms${
            result.stderr.trim()
              ? `: ${setupFailureDetail(index, step, result, homedir()).said}`
              : ""
          }`,
        );
    } catch (error) {
      // A value a failed setup never recorded: the step had nothing to undo.
      console.log(
        `  ${task.id} cleanup ${stepName(index, step)} skipped: ${error.message}`,
      );
    }
  }
}

function writeResults(aborted = null) {
  const results = buildResults({
    plan,
    turns: records,
    preflight: preflightFacts,
    gate: gateWaits(gateRows),
    previous: previousCycle(),
    finishedAt: new Date().toISOString(),
    aborted,
    stoppedBecause,
  });
  writeOutputs(results);
  return results;
}

let exitCode = 0;
let abortedOn = null;
try {
  outerLoop: for (let attempt = 1; attempt <= repeat; attempt++) {
    for (const task of runnable()) {
      if (stopRequested) {
        stoppedBecause = "interrupted";
        break outerLoop;
      }
      const outcome = await runTask(task, attempt);
      if (outcome.stop) {
        stoppedBecause = outcome.stop;
        console.log(`Stopping: ${outcome.stop}.`);
        break outerLoop;
      }
      if (outcome.abort) {
        // A person is at the Mac, or a run was left open: the cycle ends
        // here, and the loop says nothing more.
        stoppedBecause = outcome.abort;
        abortedOn = {
          code: outcome.abort,
          turnId: outcome.turnId,
          at: new Date().toISOString(),
        };
        console.log(
          `Aborted on ${outcome.abort} at ${outcome.turnId}; nothing more is said.`,
        );
        exitCode = 3;
        break outerLoop;
      }
    }
  }
  if (stoppedBecause) ledger({ kind: "stop", reason: stoppedBecause });
  const results = writeResults(abortedOn);
  console.log(
    `\n${results.aggregate.passed}/${results.aggregate.ran} passed · hands-free ${(results.aggregate.handsFree.rate * 100).toFixed(1)}% · ${join(cycleDir, "report.md")}`,
  );
  if (results.failureClasses.length)
    console.log(
      `Next: npm run loop -- --output ${outDir} (lanes from this cycle's failure classes).`,
    );
} catch (error) {
  // A crash mid-cycle still leaves results.json saying why it stopped; the
  // task's own cleanup already ran in runTask's finally.
  stoppedBecause = "CRASHED";
  console.error(`Stopping: the loop crashed.\n${error?.stack ?? error}`);
  try {
    ledger({ kind: "stop", reason: stoppedBecause });
    writeResults(abortedOn);
  } catch {
    /* the disk is the problem; the lock is still released */
  }
  exitCode = 1;
} finally {
  releaseLock();
}
process.exit(exitCode);
