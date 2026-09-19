// Opt-in, PAID and REAL: drives this Mac's desktop with a cloud model until the
// task finishes. Run it only when you intend to watch the screen.
//   node --import tsx scripts/live-task.mjs --provider openai "Open Notes"
// Screenshots stay in memory; typed text and screenshots are never printed.
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { NativeController } from "../electron/controller.ts";
import { importEnvCredentials, providerKey } from "../electron/credentials.ts";
import { HttpProvider } from "../src/providers/http.ts";
import { selectProvider } from "../src/providers/catalog.ts";
import { defaultSettings, settingsSchema } from "../src/core/schema.ts";
import { Runner, terminal } from "../src/core/runner.ts";
import { nullRecorder } from "../src/core/recorder.ts";
import { describeAction } from "../src/voice/router.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { createMemoryAccess } from "../src/memory/access.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    provider: { type: "string" },
    model: { type: "string" },
    "max-cost": { type: "string", default: "0.25" },
    "max-actions": { type: "string", default: "30" },
    "max-seconds": { type: "string", default: "240" },
    "approve-routine": { type: "boolean", default: false },
    // Local learning between live runs: an encrypted MemoryStore in
    // --memory-dir (default: the OS temp folder). Its random key is kept next
    // to the store, so use a scratch directory, never a real profile.
    memory: { type: "boolean", default: false },
    "memory-dir": { type: "string" },
    // Local debugging only: writes every screenshot, model observation,
    // proposed action and native surface to this directory. Keep it outside
    // the repository and delete it afterwards; it contains screen content.
    "trace-dir": { type: "string" },
  },
});
const usage =
  'Usage: node --import tsx scripts/live-task.mjs --provider openai|anthropic|google [--model id] [--max-cost 0.25] [--max-actions 30] [--max-seconds 240] [--approve-routine] [--memory [--memory-dir dir]] "task text"';
const provider = values.provider;
const task = positionals.join(" ").trim();
if (!["openai", "anthropic", "google"].includes(provider) || !task) {
  console.error(usage);
  process.exit(2);
}
const binary = resolve("native/bin/coarena-controller");
if (!existsSync(binary)) {
  console.error("Build the native controller with npm run build:native.");
  process.exit(2);
}
// Priced at the chosen model's own catalog rates, so --max-cost holds for it;
// a model the catalog does not price gets zero rates and is refused below.
const selected = selectProvider(defaultSettings, provider, values.model);
const settings = settingsSchema.parse({
  ...selected,
  maxCost: Number(values["max-cost"]),
  maxActions: Number(values["max-actions"]),
  maxSeconds: Number(values["max-seconds"]),
});
const keys = importEnvCredentials(resolve(".env"), {});
let client;
try {
  client = new HttpProvider(settings, providerKey(keys, settings), fetch);
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Provider setup failed.",
  );
  process.exit(2);
}

// Journal and frame metadata only; frame images are dropped immediately.
let run = null;
let frames = 0;
const recorder = {
  ...nullRecorder(),
  begin: (r) => {
    run = r;
  },
  save: (r) => {
    run = r;
  },
  frame: () => {
    frames++;
  },
};

// Consequential words that --approve-routine never approves unattended.
const sensitive =
  /\b(send|delete|pay|purchase|publish|install|password|security)/i;
const safeDescription = (action) =>
  action.type === "type_text"
    ? `Type ${action.text.length} characters.`
    : describeAction(action);
const short = (value, n = 160) =>
  typeof value === "string" && value.length > n
    ? value.slice(0, n - 1) + "…"
    : value;
const counts = {};
const pauses = [];
let printed = 0;
let lastPending;
let lastHeld;
let runner;
const emit = (snapshot) => {
  const status = snapshot.run?.status;
  for (const event of snapshot.events.slice(printed)) {
    counts[event.type] = (counts[event.type] ?? 0) + 1;
    const d = event.data ?? {};
    const line = {
      t: new Date(event.wall_clock_timestamp).toISOString().slice(11, 23),
      type: event.type,
      status,
      actionType: d.actionType ?? d.action?.type,
      code: d.code,
      cause: d.cause,
      reason: short(d.reason),
      launched: d.launched,
      source: d.source,
      index: d.index,
      plan: d.plan,
      mode: d.mode,
      preferences: d.preferences,
      episodes: d.episodes,
      apps: d.apps,
      files: d.files,
      usage: d.usage,
      period: d.period,
    };
    console.log(
      JSON.stringify(
        Object.fromEntries(Object.entries(line).filter(([, v]) => v != null)),
      ),
    );
    if (event.type === "ActionLoopDetected")
      console.log(
        JSON.stringify({
          loop: `repeating ${d.actionType} (period ${d.period})`,
        }),
      );
    if (event.type === "PlanStepProposed")
      console.log(
        JSON.stringify({ replay: `step ${d.index + 1} from ${d.source}` }),
      );
    if (event.type === "PlanAbandoned")
      console.log(
        JSON.stringify({
          replay: `abandoned at step ${d.index + 1} (${d.reason})`,
        }),
      );
    if (event.type === "PlanCompleted")
      console.log(
        JSON.stringify({ replay: `completed from ${d.source}; no model call` }),
      );
    if (event.type === "MemoryRecalled")
      console.log(
        JSON.stringify({
          memory: `${d.preferences} preferences, ${d.episodes} episodes, ${d.apps} apps, ${d.files} files; plan ${d.plan} (${d.mode})`,
        }),
      );
    if (event.type === "ActionFailed" && d.code === "REFUSED")
      console.log(JSON.stringify({ refused: "The model declined this step." }));
  }
  printed = snapshot.events.length;
  if (
    status === "confirming" &&
    snapshot.pending &&
    snapshot.pending !== lastPending
  ) {
    const pending = snapshot.pending;
    lastPending = pending;
    const approve =
      values["approve-routine"] && !sensitive.test(pending.reason);
    console.log(
      JSON.stringify({
        approval: approve ? "approve" : "decline",
        reason: short(pending.reason),
        action: safeDescription(pending.action),
      }),
    );
    // The runner installs its approval resolver right after this emit.
    setTimeout(() => runner.confirm(approve), 0);
  }
  if (status !== "confirming") lastPending = undefined;
  if (status === "paused" || status === "takeover") {
    if (lastHeld === snapshot.message) return;
    lastHeld = snapshot.message;
    pauses.push({ status, message: snapshot.message });
    console.log(JSON.stringify({ held: status, message: snapshot.message }));
    // Nobody is there to say continue in an unattended run.
    setTimeout(
      () =>
        runner.stop(`Live harness stopped at ${status}: ${snapshot.message}`),
      0,
    );
  } else lastHeld = undefined;
};

const controller = new NativeController(
  binary,
  () => runner?.stop("Native emergency stop activated."),
  () => runner?.manualTakeover(),
  (event, data) => {
    if (
      [
        "NativeUserTakeover",
        "NativeEmergencyStop",
        "NativeSlow",
        "NativeUnavailable",
        "NativeRestarted",
      ].includes(event)
    )
      console.log(JSON.stringify({ native: event, ...data }));
  },
);
let model = client;
if (values["trace-dir"]) {
  const dir = resolve(values["trace-dir"]);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const trace = (record) =>
    appendFileSync(`${dir}/trace.jsonl`, JSON.stringify(record) + "\n", {
      mode: 0o600,
    });
  let step = 0;
  model = {
    next: async (observation, signal) => {
      const n = ++step;
      const { frame } = observation;
      writeFileSync(
        `${dir}/step-${String(n).padStart(3, "0")}.png`,
        Buffer.from(frame.image.split(",")[1], "base64"),
        { mode: 0o600 },
      );
      const result = await client.next(observation, signal);
      trace({
        step: n,
        appId: frame.appId,
        geometry: frame.geometry,
        context: frame.context && {
          appName: frame.context.appName,
          windowTitle: frame.context.windowTitle,
          launcher: frame.context.launcher,
          selectedText: frame.context.selectedText,
          controls: frame.context.controls?.length,
        },
        history: observation.history.slice(-4),
        action: result.action,
        problem: result.problem,
        refused: result.refused,
        usage: result.usage,
      });
      return result;
    },
  };
  const surface = controller.surface.bind(controller);
  controller.surface = async (action) => {
    const value = await surface(action);
    if (action) trace({ step, surfaceFor: action.type, surface: value });
    return value;
  };
}
let memoryStore;
let memoryAccess;
let memoryDir;
if (values.memory) {
  memoryDir = resolve(
    values["memory-dir"] ?? join(tmpdir(), "open-assist-live-memory"),
  );
  mkdirSync(memoryDir, { recursive: true, mode: 0o700 });
  const keyFile = join(memoryDir, "live-memory.key");
  if (!existsSync(keyFile))
    writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
  memoryStore = new MemoryStore(memoryDir, readFileSync(keyFile), undefined, {
    onError: (error) =>
      console.log(
        JSON.stringify({
          memoryError: error instanceof Error ? short(error.message) : "error",
        }),
      ),
  });
  memoryAccess = createMemoryAccess(
    memoryStore,
    (query) => controller.request("index", { query }),
    {
      onError: (error) =>
        console.log(
          JSON.stringify({
            memoryError:
              error instanceof Error ? short(error.message) : "Memory error.",
          }),
        ),
    },
  );
  console.log(JSON.stringify({ memoryDir }));
}
runner = new Runner(
  controller,
  model,
  recorder,
  settings,
  emit,
  [],
  memoryAccess,
);
let interrupted = false;
process.on("SIGINT", () => {
  if (interrupted) process.exit(130);
  interrupted = true;
  runner.stop("Interrupted from the terminal.");
  controller.close();
});

const started = Date.now();
try {
  await controller.configure(settings);
  console.log(
    JSON.stringify({
      start: task.slice(0, 60),
      provider,
      model: settings.model,
      maxCost: settings.maxCost,
      maxActions: settings.maxActions,
      maxSeconds: settings.maxSeconds,
    }),
  );
  await runner.start(task);
} catch (error) {
  console.error(
    JSON.stringify({
      error: error instanceof Error ? short(error.message) : "Run failed.",
    }),
  );
} finally {
  try {
    memoryStore?.flush();
  } catch (error) {
    console.error(
      JSON.stringify({
        memoryError:
          error instanceof Error ? short(error.message) : "Flush failed.",
      }),
    );
  }
  controller.close();
}
const status = run?.status ?? "failed";
const summary = {
  task: task.slice(0, 60),
  provider,
  model: settings.model,
  status: terminal(status) ? status : `${status} (not settled)`,
  summary: short(run?.summary || runner.snapshot.message || "", 500),
  actions: run?.actions ?? 0,
  frames,
  usage: run?.usage ?? { inputTokens: 0, outputTokens: 0, cost: 0 },
  durationMs: Date.now() - started,
  pauses,
  memory: values.memory
    ? {
        dir: memoryDir,
        recalled: counts.MemoryRecalled ?? 0,
        planSteps: counts.PlanStepProposed ?? 0,
        planAbandoned: counts.PlanAbandoned ?? 0,
        planCompleted: counts.PlanCompleted ?? 0,
      }
    : undefined,
  events: counts,
};
console.log(JSON.stringify(summary, null, 2));
mkdirSync("output/qa", { recursive: true });
const file = `output/qa/live-task-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(file, JSON.stringify(summary, null, 2) + "\n");
console.log(`Wrote ${file}`);
process.exit(status === "completed" ? 0 : 1);
