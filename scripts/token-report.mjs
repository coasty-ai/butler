// Tokens per step and per run, from the local diagnostics stream.
//
//   node scripts/token-report.mjs
//   node scripts/token-report.mjs --runs 20 .data/diagnostics/current.jsonl.1 .data/diagnostics/current.jsonl
//
// Read-only: it never calls a model, never touches the desktop and never
// writes to the log. It reads only the usage fields of ProviderResponse and
// ProviderMalformed rows (inputTokens, cachedInputTokens, outputTokens, cost),
// the model id, the run id and the screenshot codes on ModelRequestStarted
// (full, reduced, none, and why: src/core/vision.ts). No task text, screen
// text, window title, URL or file path is read or printed.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    runs: { type: "string", default: "10" },
    json: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  console.log(
    `Usage: node scripts/token-report.mjs [--runs N] [--json] [file...]

  Defaults to the last 10 runs in .data/diagnostics/current.jsonl. Rotated logs
  (current.jsonl.1 and so on) can be passed as extra files, oldest first.`,
  );
  process.exit(0);
}

const files = positionals.length
  ? positionals
  : [resolve(root, ".data/diagnostics/current.jsonl")];
const count = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
const code = (value) =>
  typeof value === "string" && /^[a-z-]{1,20}$/.test(value) ? value : undefined;

/** One run's model steps, in order, with the usage of each and its screenshot code. */
const runs = new Map();
for (const file of files) {
  if (!existsSync(file)) {
    console.error(`No such file: ${file}`);
    process.exit(2);
  }
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const data = row?.data;
    if (!data || typeof data.runId !== "string") continue;
    const run = runs.get(data.runId) ?? {
      id: data.runId,
      model: undefined,
      steps: [],
      screenshots: [],
    };
    if (row.event === "ModelRequestStarted") {
      const send = code(data.screenshot),
        reason = code(data.screenshotReason);
      if (send) run.screenshots.push(reason ? `${send}:${reason}` : send);
    } else if (
      row.event === "ProviderResponse" ||
      row.event === "ProviderMalformed"
    ) {
      const usage = data.usage;
      if (!usage || typeof usage !== "object") continue;
      run.model = code(data.provider)
        ? `${data.provider}/${String(data.model ?? "").slice(0, 40)}`
        : run.model;
      run.steps.push({
        input: count(usage.inputTokens) ?? 0,
        cached: count(usage.cachedInputTokens),
        output: count(usage.outputTokens) ?? 0,
        cost: count(usage.cost) ?? 0,
      });
    } else continue;
    runs.set(data.runId, run);
  }
}

const wanted = Math.max(1, Number.parseInt(values.runs, 10) || 10);
const recent = [...runs.values()]
  .filter((run) => run.steps.length)
  .slice(-wanted);
if (!recent.length) {
  console.log("No model steps with usage in the given files.");
  process.exit(0);
}

const sum = (list, pick) => list.reduce((total, item) => total + pick(item), 0);
const summarize = (run) => {
  const steps = run.steps.length;
  const input = sum(run.steps, (s) => s.input);
  const reported = run.steps.filter((s) => s.cached !== undefined);
  const cached = reported.length ? sum(reported, (s) => s.cached) : undefined;
  const mix = {};
  for (const shot of run.screenshots) mix[shot] = (mix[shot] ?? 0) + 1;
  return {
    id: run.id.slice(0, 8),
    model: run.model,
    steps,
    perStep: {
      input: Math.round(input / steps),
      cached: cached === undefined ? undefined : Math.round(cached / steps),
      output: Math.round(sum(run.steps, (s) => s.output) / steps),
    },
    session: {
      input,
      cached,
      output: sum(run.steps, (s) => s.output),
      cost: Number(sum(run.steps, (s) => s.cost).toFixed(4)),
    },
    screenshots: mix,
  };
};
const rows = recent.map(summarize);
const all = {
  runs: rows.length,
  steps: sum(rows, (r) => r.steps),
  perStep: {
    input: Math.round(
      sum(rows, (r) => r.session.input) / sum(rows, (r) => r.steps),
    ),
    cached: rows.some((r) => r.session.cached !== undefined)
      ? Math.round(
          sum(rows, (r) => r.session.cached ?? 0) / sum(rows, (r) => r.steps),
        )
      : undefined,
    output: Math.round(
      sum(rows, (r) => r.session.output) / sum(rows, (r) => r.steps),
    ),
  },
  perRun: {
    input: Math.round(sum(rows, (r) => r.session.input) / rows.length),
    cost: Number((sum(rows, (r) => r.session.cost) / rows.length).toFixed(4)),
  },
};

if (values.json) {
  console.log(JSON.stringify({ runs: rows, all }, null, 2));
  process.exit(0);
}
const num = (value, width = 6) =>
  String(value === undefined ? "-" : value).padStart(width);
console.log(
  `Last ${rows.length} runs with model steps (${files.length} file${files.length === 1 ? "" : "s"}).\n`,
);
console.log(
  `${"run".padEnd(9)}${"model".padEnd(28)}${"steps".padStart(5)}  ${"in/step".padStart(7)} ${"cached".padStart(6)} ${"out".padStart(5)}  ${"in/run".padStart(7)} ${"cost".padStart(7)}  screenshots`,
);
for (const r of rows) {
  const shots = Object.entries(r.screenshots)
    .sort(([, a], [, b]) => b - a)
    .map(([shot, n]) => `${shot} ${n}`)
    .join(", ");
  console.log(
    `${r.id.padEnd(9)}${String(r.model ?? "?")
      .slice(0, 27)
      .padEnd(
        28,
      )}${num(r.steps, 5)}  ${num(r.perStep.input, 7)} ${num(r.perStep.cached)} ${num(r.perStep.output, 5)}  ${num(r.session.input, 7)} ${num(r.session.cost.toFixed(4), 7)}  ${shots}`,
  );
}
console.log(
  `\nAll: ${all.steps} steps in ${all.runs} runs; ${all.perStep.input} input tokens a step (${all.perStep.cached === undefined ? "cache not reported" : `${all.perStep.cached} of them cached`}), ${all.perStep.output} out; ${all.perRun.input} input tokens and $${all.perRun.cost} a run.`,
);
if (all.perStep.cached === undefined)
  console.log(
    "Cached counts appear once the app runs a build that reports usage.cachedInputTokens.",
  );
