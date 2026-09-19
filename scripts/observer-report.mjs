// What the observer recorded, learned and replayed, as counts, from the local
// diagnostics stream and the work log's own digest (.data/design/observer.md
// §7, lane O3).
//
//   node scripts/observer-report.mjs
//   node scripts/observer-report.mjs --days 7 .data/diagnostics/current.jsonl.1 .data/diagnostics/current.jsonl
//   node scripts/observer-report.mjs --json --digest output/observer/digest.json
//
// Read-only: it never calls a model, never touches the desktop and never
// writes to the log. Content-free: of an ObserverFrame row it reads the
// timestamp, the bundle id and the exclusion code; of an ObserverAction the
// kind; of an ObserverConsolidated the counts (frames, tokens, cost, routines,
// procedures, preferences, a duration); of a RoutineRun the routine's id and
// the outcome code. Of the digest the log exports (`--digest <file>`, the
// JSON of src/observer/log.ts digest()) it reads counts under known keys
// only: per day frames, actions, bytes written and dropped, frames dropped at
// the cap, exclusions by code and frames by bundle id; routines, procedures
// and preferences proposed/approved/retired; replays by outcome. A window
// title, a host, a label or any other text in either source is never read,
// so nothing here can print it; a bundle id that does not look like one is
// counted as "unknown", a code that is not on the design's list as "other".
//
// Days are the owner's calendar days in this machine's time zone (TZ=UTC
// makes them UTC days). The targets are §7's: at most 200,000 input tokens
// of consolidation per day, and the log's 50 MiB daily cap (§3), which
// shows as frames dropped.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    days: { type: "string", default: "14" },
    json: { type: "boolean", default: false },
    digest: { type: "string" },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  console.log(
    `Usage: node scripts/observer-report.mjs [--days N] [--json] [--digest <file>] [file...]

  Defaults to .data/diagnostics/current.jsonl and the last 14 days that carry
  observer rows (the raw log's retention). Rotated logs (current.jsonl.1 and so
  on) can be passed as extra files, oldest first. --digest <file> adds the work
  log's own counters (bytes written and dropped, routines proposed, approved
  and retired) from the JSON its digest() exports. Counts and codes only:
  never a title, a host, a label or any text.`,
  );
  process.exit(0);
}

/** §7: input tokens the consolidator may spend in a day. */
const INPUT_TOKENS_PER_DAY = 200_000;
/** §3: the work log's daily cap; frames beyond it are dropped and counted. */
const BYTES_PER_DAY = 50 * 1024 * 1024;
const EXCLUSIONS = new Set([
  "secure_input",
  "protected",
  "locked",
  "own_run",
  "idle",
]);
const KINDS = new Set([
  "click",
  "double_click",
  "right_click",
  "key_chord",
  "typing",
  "scroll",
  "app_switch",
  "menu_item",
]);
const OUTCOMES = new Set(["completed", "corrected", "undone", "declined"]);

const count = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
const money = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
const code = (value) =>
  typeof value === "string" && /^[a-zA-Z_-]{1,40}$/.test(value)
    ? value
    : undefined;
/** A reverse-DNS bundle id; anything with a space or no dot is not one. */
const bundleId = (value) =>
  typeof value === "string" &&
  value.length <= 128 &&
  /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$/.test(value)
    ? value
    : undefined;
const routineId = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(value)
    ? value
    : undefined;
const dayKey = (value) =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : undefined;
const pad = (n) => String(n).padStart(2, "0");
/** The calendar day of an instant in this machine's time zone. */
const localDay = (at) => {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const tally = (into, key, by = 1) => {
  into[key] = (into[key] ?? 0) + by;
  return into;
};
const sum = (list) => list.reduce((a, b) => a + b, 0);
const percentile = (list, p) => {
  if (!list.length) return undefined;
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
};
const stats = (list) =>
  list.length
    ? {
        n: list.length,
        p50: percentile(list, 0.5),
        p90: percentile(list, 0.9),
        max: Math.max(...list),
      }
    : { n: 0 };

// ---- The diagnostics stream ----------------------------------------------

const files = positionals.length
  ? positionals
  : [resolve(root, ".data/diagnostics/current.jsonl")];
const rows = [];
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
    const at = Date.parse(row?.timestamp);
    if (!Number.isFinite(at) || typeof row.event !== "string") continue;
    if (!row.event.startsWith("Observer") && row.event !== "RoutineRun")
      continue;
    rows.push({
      at,
      sequence: count(row.sequence) ?? 0,
      event: row.event,
      data: row.data && typeof row.data === "object" ? row.data : {},
    });
  }
}
rows.sort((a, b) => a.at - b.at || a.sequence - b.sequence);

const days = new Map();
const dayOf = (day) => {
  if (!days.has(day))
    days.set(day, {
      day,
      frames: 0,
      excluded: {},
      apps: {},
      actions: 0,
      kinds: {},
      consolidations: [],
      tokens: 0,
      outputTokens: 0,
      cost: 0,
      replays: {},
      bytesTraced: 0,
    });
  return days.get(day);
};
const byRoutine = {};
for (const row of rows) {
  const d = row.data;
  const day = dayOf(localDay(row.at));
  if (row.event === "ObserverFrame") {
    const excluded = code(d.excluded);
    if (excluded)
      tally(day.excluded, EXCLUSIONS.has(excluded) ? excluded : "other");
    else {
      day.frames++;
      tally(day.apps, bundleId(d.appId) ?? "unknown");
    }
    day.bytesTraced += count(d.bytes) ?? 0;
  } else if (row.event === "ObserverAction") {
    const kind = code(d.kind);
    day.actions++;
    tally(day.kinds, kind && KINDS.has(kind) ? kind : "other");
  } else if (row.event === "ObserverConsolidated") {
    const run = {
      at: row.at,
      frames: count(d.frames),
      tokens: count(d.tokens) ?? count(d.inputTokens),
      outputTokens: count(d.outputTokens),
      cost: money(d.cost),
      routines: count(d.routines),
      procedures: count(d.procedures),
      preferences: count(d.preferences),
      ms: count(d.durationMs) ?? count(d.ms),
    };
    day.consolidations.push(run);
    day.tokens += run.tokens ?? 0;
    day.outputTokens += run.outputTokens ?? 0;
    day.cost += run.cost ?? 0;
  } else if (row.event === "RoutineRun") {
    const outcome = code(d.outcome);
    const key = outcome && OUTCOMES.has(outcome) ? outcome : "other";
    tally(day.replays, key);
    const id = routineId(d.routineId) ?? "unknown";
    tally((byRoutine[id] ??= {}), key);
  }
}

// ---- The work log's digest -----------------------------------------------

/** Counts under the given keys, anything else dropped. */
const counts = (raw, keys) => {
  if (!raw || typeof raw !== "object") return undefined;
  const out = {};
  for (const key of keys)
    if (count(raw[key]) !== undefined) out[key] = raw[key];
  return Object.keys(out).length ? out : undefined;
};
/** A code → count table; codes off the list are summed under "other". */
const codeTally = (raw, allowed) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const n = count(value);
    if (n === undefined) continue;
    const c = code(key);
    tally(out, c && allowed.has(c) ? c : "other", n);
  }
  return out;
};
/** A bundle id → count table; anything that is not a bundle id is "unknown". */
const appTally = (raw) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const n = count(value);
    if (n !== undefined) tally(out, bundleId(key) ?? "unknown", n);
  }
  return out;
};
let digest;
if (values.digest) {
  const file = resolve(values.digest);
  if (!existsSync(file)) {
    console.error(`No such file: ${file}`);
    process.exit(2);
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    console.error(`Bad digest: ${file} is not JSON.`);
    process.exit(2);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    console.error(`Bad digest: ${file} is not a JSON object.`);
    process.exit(2);
  }
  digest = {
    days: (Array.isArray(raw.days) ? raw.days : [])
      .filter((d) => d && typeof d === "object" && dayKey(d.day))
      .map((d) => ({
        day: d.day,
        frames: count(d.frames),
        actions: count(d.actions),
        bytesWritten: count(d.bytesWritten) ?? count(d.bytes),
        bytesDropped: count(d.bytesDropped),
        framesDropped: count(d.framesDropped) ?? count(d.dropped),
        excluded: codeTally(d.excluded, EXCLUSIONS),
        apps: appTally(d.apps),
      })),
    routines: counts(raw.routines, ["proposed", "approved", "retired"]),
    procedures: counts(raw.procedures, ["proposed", "approved", "retired"]),
    preferences: counts(raw.preferences, [
      "proposed",
      "approved",
      "retired",
      "observed",
    ]),
    replays: codeTally(raw.replays, OUTCOMES),
  };
  for (const d of digest.days) dayOf(d.day).digest = d;
}

// ---- Summary -------------------------------------------------------------

const all = [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
const recent = all.slice(-Math.max(1, Number(values.days) || 14));
const merge = (tables) => {
  const out = {};
  for (const table of tables)
    for (const [key, n] of Object.entries(table)) tally(out, key, n);
  return Object.fromEntries(
    Object.entries(out).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)),
  );
};
const runs = recent.flatMap((d) => d.consolidations);
const consolidated = recent.filter((d) => d.consolidations.length);
const tokenMissed = consolidated.filter((d) => d.tokens > INPUT_TOKENS_PER_DAY);
const heaviest = consolidated.reduce(
  (best, d) => (best && best.tokens >= d.tokens ? best : d),
  undefined,
);
const withBytes = recent.filter((d) => d.digest?.bytesWritten !== undefined);
const bytesMissed = withBytes.filter(
  (d) => d.digest.bytesWritten > BYTES_PER_DAY,
);
const capHit = recent.filter((d) => (d.digest?.framesDropped ?? 0) > 0);
const tracedBytes = sum(recent.map((d) => d.bytesTraced));
const replays = merge(recent.map((d) => d.replays));
const summary = {
  files,
  digest: values.digest ? resolve(values.digest) : undefined,
  timezone,
  days: all.length,
  shown: recent.length,
  from: recent[0]?.day,
  to: recent.at(-1)?.day,
  frames: {
    recorded: sum(recent.map((d) => d.frames)),
    excluded: sum(recent.map((d) => sum(Object.values(d.excluded)))),
    byExclusion: merge(recent.map((d) => d.excluded)),
    byApp: merge(recent.map((d) => d.apps)),
  },
  actions: {
    total: sum(recent.map((d) => d.actions)),
    byKind: merge(recent.map((d) => d.kinds)),
  },
  bytes: digest
    ? {
        source: "digest",
        written: sum(withBytes.map((d) => d.digest.bytesWritten)),
        dropped: sum(recent.map((d) => d.digest?.bytesDropped ?? 0)),
        framesDropped: sum(recent.map((d) => d.digest?.framesDropped ?? 0)),
      }
    : tracedBytes
      ? { source: "diagnostics", written: tracedBytes }
      : undefined,
  consolidations: {
    runs: runs.length,
    days: consolidated.length,
    tokens: sum(runs.map((r) => r.tokens ?? 0)),
    outputTokens: sum(runs.map((r) => r.outputTokens ?? 0)),
    cost: Number(sum(runs.map((r) => r.cost ?? 0)).toFixed(4)),
    tokensPerRun: stats(
      runs.map((r) => r.tokens).filter((t) => t !== undefined),
    ),
    tokensPerDay: stats(consolidated.map((d) => d.tokens)),
    produced: {
      routines: sum(runs.map((r) => r.routines ?? 0)),
      procedures: sum(runs.map((r) => r.procedures ?? 0)),
      preferences: sum(runs.map((r) => r.preferences ?? 0)),
    },
  },
  routines: digest?.routines,
  procedures: digest?.procedures,
  preferences: digest?.preferences,
  replays: {
    total: sum(Object.values(replays)),
    byOutcome: replays,
    corrections: replays.corrected ?? 0,
    routines: Object.keys(byRoutine).filter((id) => id !== "unknown").length,
    byRoutine,
    digest: digest?.replays,
  },
  targets: {
    inputTokensPerDay: {
      limit: INPUT_TOKENS_PER_DAY,
      measured: consolidated.length,
      met: consolidated.length - tokenMissed.length,
      missed: tokenMissed.length,
      missedDays: tokenMissed.map((d) => d.day),
      max: heaviest && { day: heaviest.day, tokens: heaviest.tokens },
    },
    bytesPerDay: digest
      ? {
          limit: BYTES_PER_DAY,
          measured: withBytes.length,
          met: withBytes.length - bytesMissed.length,
          missed: bytesMissed.length,
          capHitDays: capHit.map((d) => d.day),
        }
      : undefined,
  },
};
const shown = recent.map((d) => ({
  day: d.day,
  frames: d.frames,
  excluded: d.excluded,
  apps: merge([d.apps]),
  actions: d.actions,
  kinds: d.kinds,
  consolidations: d.consolidations.length,
  tokens: d.tokens,
  outputTokens: d.outputTokens,
  cost: Number(d.cost.toFixed(4)),
  replays: d.replays,
  digest: d.digest,
  tokensTarget: d.consolidations.length
    ? d.tokens > INPUT_TOKENS_PER_DAY
      ? "missed"
      : "met"
    : "no_run",
}));

if (values.json) {
  // Wait for the pipe to take the whole report: on macOS a pipe's stdout is
  // asynchronous, and process.exit right after console.log cut a report over
  // 8 KiB at its first chunk.
  await new Promise((done) =>
    process.stdout.write(
      JSON.stringify({ summary, days: shown }, null, 2) + "\n",
      done,
    ),
  );
  process.exit(0);
}

const list = (tallied) =>
  Object.entries(tallied)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ") || "none";
const bytes = (n) => {
  if (n === undefined) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};
const dollars = (n) => `$${n.toFixed(4)}`;
const c = summary.consolidations;

console.log(
  `Observer: ${all.length} day(s) with observer rows in ${files.length} file(s)${digest ? " and a digest" : ""}; showing the last ${recent.length}${recent.length ? ` (${summary.from}..${summary.to}, days in ${timezone})` : ""}.`,
);
console.log(
  `Frames: ${summary.frames.recorded} recorded, ${summary.frames.excluded} excluded (${list(summary.frames.byExclusion)}). Actions: ${summary.actions.total} (${list(summary.actions.byKind)}).`,
);
if (summary.bytes?.source === "digest")
  console.log(
    `Bytes: ${bytes(summary.bytes.written)} written, ${bytes(summary.bytes.dropped)} dropped, ${summary.bytes.framesDropped} frame(s) dropped at the cap (digest).`,
  );
else if (summary.bytes)
  console.log(`Bytes: ${bytes(summary.bytes.written)} written (traced).`);
else
  console.log(
    "Bytes: not available (pass --digest <file> for the log's counters).",
  );
console.log(
  `Apps by frames: ${list(
    Object.fromEntries(Object.entries(summary.frames.byApp).slice(0, 12)),
  )}.`,
);
console.log();
console.log("Per day:");
console.log(
  "  day         frames  excl  actions  runs  tokens    cost      replays  bytes      tokens/day",
);
for (const d of shown)
  console.log(
    `  ${d.day}  ${String(d.frames).padEnd(6)}  ${String(sum(Object.values(d.excluded))).padEnd(4)}  ${String(d.actions).padEnd(7)}  ${String(d.consolidations).padEnd(4)}  ${String(d.tokens).padEnd(8)}  ${dollars(d.cost).padEnd(8)}  ${String(sum(Object.values(d.replays))).padEnd(7)}  ${bytes(d.digest?.bytesWritten).padEnd(9)}  ${d.tokensTarget}`,
  );
console.log();
console.log(
  `Consolidations: ${c.runs} run(s) on ${c.days} day(s); input tokens ${c.tokens} (per run p50 ${c.tokensPerRun.p50 ?? "—"}, max ${c.tokensPerRun.max ?? "—"}); cost ${dollars(c.cost)}; produced ${c.produced.routines} routine(s), ${c.produced.procedures} procedure(s), ${c.produced.preferences} preference(s).`,
);
if (digest) {
  const lifecycle = (t) =>
    t
      ? `proposed ${t.proposed ?? "—"}, approved ${t.approved ?? "—"}, retired ${t.retired ?? "—"}`
      : "not in the digest";
  console.log(
    `Routines: ${lifecycle(digest.routines)}; procedures: ${lifecycle(digest.procedures)}; preferences: ${
      digest.preferences ? list(digest.preferences) : "not in the digest"
    } (digest).`,
  );
} else
  console.log(
    "Routines: proposed/approved/retired need the digest (pass --digest <file>).",
  );
console.log(
  `Replays: ${summary.replays.total} (${list(replays)}); corrections ${summary.replays.corrections}; ${summary.replays.routines} routine(s) replayed${
    digest ? `; the digest counts ${list(digest.replays)}` : ""
  }.`,
);
const t = summary.targets;
console.log(
  `Targets: input tokens <= ${INPUT_TOKENS_PER_DAY}/day: met ${t.inputTokensPerDay.met} of ${t.inputTokensPerDay.measured} consolidated day(s)${
    t.inputTokensPerDay.missed
      ? `, missed on ${t.inputTokensPerDay.missedDays.join(", ")}`
      : ""
  }${t.inputTokensPerDay.max ? `; max ${t.inputTokensPerDay.max.tokens} on ${t.inputTokensPerDay.max.day}` : ""}.${
    t.bytesPerDay
      ? ` Bytes <= ${bytes(BYTES_PER_DAY)}/day: met ${t.bytesPerDay.met} of ${t.bytesPerDay.measured}; the cap dropped frames on ${t.bytesPerDay.capHitDays.length} day(s).`
      : ""
  }`,
);
