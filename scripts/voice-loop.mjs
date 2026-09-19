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
  benchDirFor,
  defaultTimeoutMs,
  DEFAULT_UNHEARD_MS,
  estimateSeconds,
  fillPlaceholders,
  loadSuite,
  selectTasks,
  suiteHash,
  taskSkips,
  turnsOf,
  validateSuite,
  voiceToken,
} = await import("../src/gym/voice/suite.ts");
const {
  SKIP,
  TERMINAL,
  gradeTurn,
  hidTakeover,
  isChatter,
  medianLevel,
  quietThreshold,
  summarizeTurn,
  voiceGate,
} = await import("../src/gym/voice/grade.ts");
const { ENVIRONMENT_CODES, classify } =
  await import("../src/gym/voice/classify.ts");
const { buildResults, fixBrief, renderReport } =
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
    "i-know-this-speaks-to-my-mac": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  console.log(
    `Usage: node scripts/voice-loop.mjs [--dry-run] [--only <ids,tags,categories>] [--noisy] [--repeat N] [--i-know-this-speaks-to-my-mac]

  Speaks the voice suite to the running Butler.app and grades what it did.

  --dry-run             Validate the suite, print the preflight facts and the plan. Speaks nothing, writes nothing.
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
const GATE_CAP_MS = 10 * 60 * 1000;
const STOP_WAIT_MS = 5000;
const NOISE_MAX_MS = 25_000;

const outDir = values["out-dir"]
  ? resolve(values["out-dir"])
  : join(root, "output", "voice");
const idleSeconds = Number(values["idle-seconds"]);
const rate = Number(values.rate);
const repeat = Math.max(1, Number(values.repeat) || 1);
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

/** One setup, cleanup or check step with its placeholders filled. */
async function runStep(step, fill) {
  const script = fillPlaceholders(step.script, fill);
  return step.kind === "osascript"
    ? osascript(script, step.timeoutMs ?? 10_000)
    : sh(script, step.timeoutMs ?? 10_000);
}

/** Speaks through the speakers; resolves when `say` has finished. */
function speak(text) {
  return new Promise((resolveSay, reject) => {
    const spokenAt = Date.now();
    const child = spawn("say", ["-v", values.voice, "-r", String(rate), text], {
      stdio: "ignore",
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolveSay({ spokenAt, sayEndedAt: Date.now() })
        : reject(new Error(`say exited ${code}`)),
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

/**
 * What the app is doing now, from every event the loop has read: listening,
 * speaking, open runs, open follow-up windows, the standby levels and when
 * it last did anything the gate should wait out.
 */
class AppWatch {
  constructor() {
    this.listening = null;
    this.lastEventAt = 0;
    this.speechFinishedAt = undefined;
    this.speaking = false;
    this.followupOpen = false;
    this.runs = new Map();
    this.lastActionAt = undefined;
    this.levels = [];
    this.heardTextAt = undefined;
    this.permissions = null;
    this.verbose = null;
    this.takeover = false;
  }
  feed(events) {
    for (const e of events) {
      const d = e.data ?? {};
      const at = Date.parse(e.timestamp);
      if (!isChatter(e)) this.lastEventAt = Math.max(this.lastEventAt, at);
      if (e.event === "VoiceEvent") {
        if (d.phase === "wake_status") this.listening = d.listening === true;
        if (d.phase === "speech_started") this.speaking = true;
        if (d.phase === "speech_finished") {
          this.speaking = false;
          this.speechFinishedAt = at;
        }
        if (d.phase === "followup_open") this.followupOpen = true;
        if (d.phase === "followup_closed") this.followupOpen = false;
        if (d.phase === "standby_trace") {
          if (d.kind === "level" && typeof d.rms === "number") {
            this.levels.push({ at, rms: d.rms });
            if (this.levels.length > 60) this.levels.shift();
          }
          if (typeof d.textLength === "number" && d.textLength > 0)
            this.heardTextAt = at;
        }
      }
      if (e.event === "Permissions" && d.permissions)
        this.permissions = d.permissions;
      if (e.event === "Command" && typeof d.text === "string")
        this.verbose = true;
      if (e.event === "RunState" && typeof d.task === "string")
        this.verbose = true;
      if (e.event === "RunState" && d.runId && d.status)
        this.runs.set(d.runId, d.status);
      if (e.event === "RunStarted" && d.runId && !this.runs.has(d.runId))
        this.runs.set(d.runId, "starting");
      if (e.event === "ActionExecuted") this.lastActionAt = at;
      if (e.event === "UserTakeoverStarted") {
        const source = d.source ?? d.data?.source;
        if (source === "manual_input" || source === undefined)
          this.takeover = true;
      }
      if (e.event === "NativeUserTakeover") this.takeover = true;
    }
  }
  get runOpen() {
    for (const status of this.runs.values())
      if (!TERMINAL.has(status)) return true;
    return false;
  }
  recentLevels(sinceMs, now = Date.now()) {
    return this.levels.filter((l) => now - l.at <= sinceMs).map((l) => l.rms);
  }
}

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
  const unsettled = tail.text === undefined ? 0 : unsettledRuns(tail.text);
  const hidIdleSeconds = await readHidIdle();
  const volume = await readVolume();
  const levels = watch.recentLevels(60_000);
  const shortcuts = await readOut("shortcuts", ["list"], 15_000);
  return {
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
};

/** Refusals of the whole cycle, from the facts. */
function preflightCodes(f) {
  const codes = [];
  if (!f.ps) codes.push("PRESENCE_UNKNOWN");
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
  "focus-shortcut": facts.focusShortcut === null ? true : facts.focusShortcut,
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
    } · quiet ${facts.levels.length >= 3 ? `trace, floor ${facts.quietFloor}` : "no trace (QUIET_UNKNOWN)"} · open runs ${facts.unsettled}`,
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
    "probes that may launch an app (Notes automation) run only for a real cycle.\n",
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
  const laneDir = join(cycleDir, "lanes");
  mkdirSync(laneDir, { recursive: true });
  for (const cls of results.failureClasses)
    if (!ENVIRONMENT_CODES.includes(cls.code) && cls.attempts > 0)
      writeFileSync(
        join(laneDir, `${cls.code}.md`),
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

function gateWaits(rows) {
  const byReason = {};
  let total = 0;
  let longest = 0;
  for (const row of rows) {
    total += row.waitedMs;
    longest = Math.max(longest, row.waitedMs);
    for (const [reason, n] of Object.entries(row.reasons ?? {}))
      byReason[reason] = (byReason[reason] ?? 0) + n;
  }
  return {
    count: rows.filter((r) => r.waitedMs > 0).length,
    totalSeconds: Math.round(total / 1000),
    byReason,
    longestSeconds: Math.round(longest / 1000),
  };
}

/* ------------------------------------------------------------- consent */

if (!values["i-know-this-speaks-to-my-mac"]) {
  console.error(
    `This speaks ${selection.tasks.length * repeat} prompt(s) to the running Butler.app, which will act on this Mac,\n` +
      `after it has been left alone for ${idleSeconds} s. Re-run with --i-know-this-speaks-to-my-mac,\n` +
      "or use --dry-run first.\n",
  );
  printFacts();
  process.exit(2);
}

console.log(
  `Voice cycle ${cycleId} at ${gitRev}${dirty ? " (dirty)" : ""}: ${selection.tasks.length} task(s) x ${repeat}.`,
);
const refusals = printFacts();
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

// Notes automation, probed now: the probe may launch Notes, so it is quit
// again only if it was not running.
{
  const wasRunning =
    (
      await osascript(
        'tell application "System Events" to return (exists process "Notes") as string',
      )
    ).stdout.trim() === "true";
  const probe = await osascript(
    'tell application "Notes" to count notes',
    20_000,
  );
  const denied =
    probe.code !== 0 && /-1743|not allowed|Not authorized/i.test(probe.stderr);
  if (probe.code !== 0 && !denied)
    console.log(
      "Notes probe failed for another reason; Notes tasks are skipped tonight.",
    );
  Object.assign(
    skips,
    taskSkips(selection.tasks, { "notes-automation": probe.code === 0 }),
  );
  if (!wasRunning)
    await osascript(
      'if application "Notes" is running then tell application "Notes" to quit',
    );
}
for (const [id, code] of Object.entries(skips))
  console.log(`skip ${id}: ${code}`);
if (!runnable().length) {
  console.error("NOTHING_TO_RUN: every selected task is skipped.");
  releaseLock();
  process.exit(2);
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
let quietThresholdValue = null;
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
  const reasons = {};
  let idleSeen = null;
  let quietRms = null;
  for (;;) {
    if (stopRequested) return { stop: "interrupted" };
    const f = await gateFacts();
    if (checkVolume) {
      const volume = await readVolume();
      if (volume)
        f.volume = { level: volume.level, muted: volume.muted, wanted: V };
    }
    if (f.now + defaultTimeoutMs(task) + 30_000 > deadline)
      return { stop: "TIME_BOX" };
    const decision = voiceGate(f);
    idleSeen = decision.idle?.seen ?? idleSeen;
    quietRms = f.quiet?.levels.at(-1) ?? quietRms;
    if (decision.ok) {
      humanSeenAt = undefined;
      return { waitedMs: Date.now() - started, reasons, idleSeen, quietRms };
    }
    reasons[decision.reason] = (reasons[decision.reason] ?? 0) + 1;
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
    if (Date.now() - started > GATE_CAP_MS) return { stop: "GATE_CAP" };
    await sleep(GATE_POLL_MS);
  }
}

/**
 * Says "stop" for a run still going or a pending confirmation (never for an
 * unheard prompt) and waits up to 5 s for a terminal RunState. Returns the
 * events it saw so the utterance's summary sees the end of the run.
 */
async function stopRun(into) {
  await speak(`${WAKE}, stop`);
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

  const gate = await waitGate(task);
  if (gate.stop) return { stop: gate.stop };
  gateRows.push({ turnId, ...gate });
  ledger({
    kind: "gate",
    turnId,
    waitedMs: gate.waitedMs,
    reasons: gate.reasons,
  });

  // Setup, then the gate once more (setup takes seconds and the owner may be back).
  for (const step of task.setup ?? []) {
    const result = await runStep(step, fill);
    if (result.code !== 0) {
      context.envSubcode = "SETUP_FAILED";
      console.log(`  ${turnId}: setup step exited ${result.code}`);
      break;
    }
    if (step.record) fill.state[step.record] = result.stdout.trim();
  }
  if (!context.envSubcode) {
    const again = await waitGate(task, { checkVolume: false });
    if (again.stop) {
      await cleanup(task, fill);
      return { stop: again.stop };
    }
  }

  if (!context.envSubcode) {
    writeFileSync(marker, "");
    feed();
    const noise = startNoise(task);
    await noise.before();
    const timeoutMs = defaultTimeoutMs(task);
    const unheardMs = task.unheardMs ?? DEFAULT_UNHEARD_MS;
    let turnDeadline = Date.now() + timeoutMs;
    let promptStartedAt = Date.now();
    let lastHid = { at: 0, idle: undefined };
    const anyRun = () =>
      utterances.some(
        (u) => summarizeTurn(u.events, u.spokenAt, u.sayEndedAt).runStarted,
      );

    outer: for (let i = 0; i < turns.length; i++) {
      const turn = turns[i];
      const previous = utterances.at(-1);
      if (i > 0) {
        // Fire on the trigger, then the delay; wait out the app's speech unless barging in.
        const trigger = turn.after;
        for (;;) {
          previous.events.push(...feed().filter((e) => !SKIP.has(e.event)));
          if (triggerFired(trigger, previous.events)) break;
          if (watch.takeover) {
            aborted = "TAKEOVER";
            break outer;
          }
          if (Date.now() > turnDeadline || stopRequested) {
            context.timedOut = watch.runOpen;
            break outer;
          }
          await sleep(POLL_MS);
        }
        await sleep(trigger.plus ?? 300);
        if (!turn.bargeIn) {
          const until = Date.now() + 15_000;
          while (
            (watch.speaking ||
              (watch.speechFinishedAt &&
                Date.now() - watch.speechFinishedAt < 800)) &&
            Date.now() < until
          ) {
            previous.events.push(...feed().filter((e) => !SKIP.has(e.event)));
            await sleep(POLL_MS);
          }
        }
      }
      const line = fillPlaceholders(turn.say, fill);
      const text = turn.withWake ? `${WAKE}, ${line}` : line;
      const { spokenAt, sayEndedAt } = await speak(text);
      if (i === 0) {
        promptStartedAt = spokenAt;
        turnDeadline = sayEndedAt + timeoutMs;
        noise.afterPromptStarted();
      }
      const utterance = { spokenAt, sayEndedAt, events: [] };
      utterances.push(utterance);
      const unheardDeadline = sayEndedAt + unheardMs;
      const isLast = i === turns.length - 1;
      let idleSince = Date.now();
      let noiseStopped = false;
      for (;;) {
        const fresh = feed();
        const kept = fresh.filter((e) => !SKIP.has(e.event));
        utterance.events.push(...kept);
        if (kept.some((e) => !isChatter(e))) idleSince = Date.now();
        const s = summarizeTurn(utterance.events, spokenAt, sayEndedAt);
        // Calibrate the quiet threshold against the loop's own first voice.
        if (speechLevel === null && preflightFacts.quiet.source === "trace") {
          const during = watch.levels
            .filter((l) => l.at >= spokenAt && l.at <= sayEndedAt + 2000)
            .map((l) => l.rms);
          const level = medianLevel(during);
          if (level !== undefined && facts.quietFloor !== undefined) {
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
        // A person at the Mac ends the cycle, and nothing more is said.
        if (Date.now() - lastHid.at > 1000)
          lastHid = { at: Date.now(), idle: await readHidIdle() };
        const hid = hidTakeover({
          now: Date.now(),
          hidIdleSeconds: lastHid.idle,
          promptStartedAt,
          lastActionAt: watch.lastActionAt,
        });
        if (s.takeover || watch.takeover || hid) {
          if (hid && !s.takeover) context.hidTakeover = true;
          aborted = "TAKEOVER";
          break outer;
        }
        // Never approve: a confirmation or a click asked for is declined with stop.
        if (
          (s.confirmations > 0 || s.needClick) &&
          !context.stoppedByLoop &&
          watch.runOpen
        ) {
          context.stoppedByLoop = true;
          await stopRun(utterance.events);
        }
        if (!isLast && triggerFired(turns[i + 1].after, utterance.events))
          break;
        if (isLast) {
          if (turn.expect.outcome === "silence") {
            if (Date.now() > unheardDeadline) break;
          } else {
            const arrived = turn.withWake
              ? s.wakeMs !== null
              : s.transcriptMs !== null;
            if (!arrived && Date.now() > unheardDeadline) break;
            if (s.terminal && anyRun()) break;
            if (
              turn.expect.outcome === "interrupt" &&
              s.speech.interrupted &&
              Date.now() - idleSince > 2000
            )
              break;
            if (
              arrived &&
              !anyRun() &&
              s.spoken &&
              Date.now() - idleSince > 6000
            )
              break;
            if (
              arrived &&
              !anyRun() &&
              !s.spoken &&
              s.plan &&
              Date.now() - idleSince > 12_000
            )
              break;
          }
        }
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
    if (!aborted && (heardAtAll || last.outcome === "silence")) {
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

  await cleanup(task, fill);
  // The loop needs the speakers at its own level after every task.
  const volume = await readVolume();
  if (volume && (volume.muted || Math.abs(volume.level - V) > 2))
    await setVolume(V, false);

  const summaries = utterances.map((u) =>
    summarizeTurn(u.events, u.spokenAt, u.sayEndedAt),
  );
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
  };
  records.push(record);
  ledger({ kind: "turn", record });
  // Transcripts, task text and messages: local only, for the engineer's eyes.
  appendFileSync(
    turnsPath,
    `${JSON.stringify({
      turnId,
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
  return {};
}

async function cleanup(task, fill) {
  for (const step of task.cleanup ?? []) {
    try {
      const result = await runStep(step, fill);
      if (result.code !== 0)
        console.log(`  cleanup step exited ${result.code}`);
    } catch (error) {
      console.log(`  cleanup step skipped: ${error.message}`);
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
} finally {
  releaseLock();
}
process.exit(exitCode);
