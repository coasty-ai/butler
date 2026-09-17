// Failure analysis over the local diagnostics stream.
//
//   node scripts/analyze-runs.mjs
//   node scripts/analyze-runs.mjs --since 24h .data/diagnostics/current.jsonl
//
// Read-only: it never calls a model, never touches the desktop and never writes
// to the log. The log it reads can contain the user's real screen and speech,
// so the report is built only from counts, event types, application bundle ids,
// action types, durations and fixed reason codes. No transcript, task text,
// summary, window title, URL or file path is ever printed. See
// src/gym/bench/analyze.ts for how that is enforced.
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const { register } = await import("tsx/esm/api");
register();
const { analyze, parseDiagnostics, renderAnalysis } =
  await import("../src/gym/bench/analyze.ts");

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    since: { type: "string" },
    json: { type: "boolean", default: false },
    out: { type: "string" },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  console.log(
    `Usage: node scripts/analyze-runs.mjs [--since <iso|24h|7d>] [--json] [--out file] [file...]

  Defaults to .data/diagnostics/current.jsonl. Rotated logs (current.jsonl.1 and
  so on) can be passed as extra files.`,
  );
  process.exit(0);
}

/** --since accepts an ISO timestamp or a relative window such as 24h or 7d. */
function sinceTimestamp(value) {
  if (!value) return undefined;
  const relative = /^(\d+)\s*([hdwm])$/i.exec(value.trim());
  if (relative) {
    const units = { h: 3600e3, d: 86400e3, w: 604800e3, m: 60e3 };
    return new Date(
      Date.now() - Number(relative[1]) * units[relative[2].toLowerCase()],
    ).toISOString();
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    console.error(
      `--since must be an ISO timestamp or a window like 24h: ${value}`,
    );
    process.exit(2);
  }
  return parsed.toISOString();
}

const files = (
  positionals.length ? positionals : [".data/diagnostics/current.jsonl"]
).map((file) => resolve(root, file));
const missing = files.filter((file) => !existsSync(file));
if (missing.length === files.length) {
  console.error(
    `No diagnostics log found. Looked for:\n  ${files.join("\n  ")}\nRun the app once, or pass a file.`,
  );
  process.exit(2);
}

const lines = [];
let skipped = 0;
let read = 0;
for (const file of files) {
  if (!existsSync(file)) {
    console.error(`Skipping missing file (${files.indexOf(file) + 1}).`);
    continue;
  }
  const parsed = parseDiagnostics(readFileSync(file, "utf8"));
  lines.push(...parsed.lines);
  skipped += parsed.skipped;
  read++;
}
// One stream ordered by time, so a run split across rotated files stays whole.
lines.sort((a, b) => ((a.timestamp ?? "") < (b.timestamp ?? "") ? -1 : 1));

const report = analyze(lines, {
  since: sinceTimestamp(values.since),
  files: read,
  skipped,
});

const text = renderAnalysis(report);
if (values.json) console.log(JSON.stringify(report, null, 2));
else console.log(text);

if (values.out) {
  const file = resolve(root, values.out);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    values.out.endsWith(".json")
      ? JSON.stringify(report, null, 2) + "\n"
      : text + "\n",
  );
  console.log(`\nWrote ${file}`);
}
