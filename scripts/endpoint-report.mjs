// Hands-free turn endpoints and what an earlier cut would have done, from the
// local diagnostics stream.
//
//   node scripts/endpoint-report.mjs
//   node scripts/endpoint-report.mjs --turns 40 .data/diagnostics/current.jsonl.1 .data/diagnostics/current.jsonl
//   node scripts/endpoint-report.mjs --json output/voice/<cycle>/diagnostics/current.jsonl
//
// Read-only: it never calls a model, never touches the desktop and never
// writes to the log. Content-free: of a VoiceEvent row it reads the phase, the
// timestamp and the allow-listed measurements (textLength, stableMs, quietMs,
// completeness, endReason, patience, segments, source, confidence, kind, code);
// of the rows after a turn only their timestamps and codes (Command,
// TurnPlanned.plan, DialogTurn decided code and actMs, RunStarted,
// ActionExecuted.actionType, SpeechOut requested). The recognized text is never
// read, so nothing here can print it: whether an earlier cut would have changed
// the words is told from the text changing again after the cut (native reports
// a change only when the merged text differs) and from the length of the text
// at the cut against the length of the final.
//
// A turn is the rows from an activation (wake_detected, followup_detected,
// shortcut_down) to its outcome (transcript_final, transcript_recovered,
// transcript_unconfirmed, voice_error, voice_cancelled). Its text changes are
// the recognition_update rows (always logged) and the transcript_partial rows
// (verbose only); native writes the update and then the partial for one change,
// so a partial right after an update is that change, not a second one (changes
// can be 15 ms apart, so time cannot pair them). For each cut C the script finds
// the first moment the text had stood C ms unchanged before the endpoint, the
// moment a decider that waits C ms would have ended the turn.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    turns: { type: "string", default: "20" },
    json: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  console.log(
    `Usage: node scripts/endpoint-report.mjs [--turns N] [--json] [file...]

  Defaults to the last 20 turns in .data/diagnostics/current.jsonl. Rotated logs
  (current.jsonl.1 and so on) and a voice cycle's diagnostics/current.jsonl can
  be passed as extra files, oldest first.`,
  );
  process.exit(0);
}

const files = positionals.length
  ? positionals
  : [resolve(root, ".data/diagnostics/current.jsonl")];
/** The cuts tried, in ms of unchanged text; the last is the Quick patience's stable time. */
const CUTS = [600, 800, 1000, 1200, 1500];
const ACTIVATIONS = new Set([
  "wake_detected",
  "followup_detected",
  "shortcut_down",
]);
const OUTCOMES = new Set([
  "transcript_final",
  "transcript_recovered",
  "transcript_unconfirmed",
  "voice_error",
  "voice_cancelled",
]);
const CHANGES = new Set(["recognition_update", "transcript_partial"]);

const count = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
const code = (value) =>
  typeof value === "string" && /^[a-zA-Z_-]{1,40}$/.test(value)
    ? value
    : undefined;

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
    rows.push({
      at,
      sequence: count(row.sequence) ?? 0,
      event: row.event,
      data: row.data ?? {},
    });
  }
}
rows.sort((a, b) => a.at - b.at || a.sequence - b.sequence);

/** One activation's turn: its text changes, endpoint, outcome and what followed. */
const turns = [];
let open;
for (const row of rows) {
  const d = row.data;
  if (row.event === "VoiceEvent") {
    const phase = code(d.phase);
    if (!phase) continue;
    if (ACTIVATIONS.has(phase)) {
      if (open) turns.push(open);
      open = {
        at: row.at,
        activation: phase,
        kind: code(d.kind),
        changes: [],
      };
      continue;
    }
    if (!open) continue;
    if (CHANGES.has(phase)) {
      const last = open.changes.at(-1);
      const length = count(d.textLength);
      if (phase === "transcript_partial" && last?.unpaired) {
        last.unpaired = false;
        last.length ??= length;
      } else
        open.changes.push({
          at: row.at,
          length,
          unpaired: phase === "recognition_update",
        });
    } else if (phase === "endpoint_near") {
      open.near ??= row.at;
    } else if (phase === "shortcut_up") {
      open.released ??= row.at;
    } else if (phase === "turn_endpoint") {
      open.endpoint ??= {
        at: row.at,
        endReason: code(d.endReason),
        stableMs: count(d.stableMs),
        quietMs: count(d.quietMs),
        completeness: code(d.completeness),
        patience: code(d.patience),
        segments: count(d.segments),
      };
    } else if (OUTCOMES.has(phase)) {
      open.outcome = {
        at: row.at,
        phase,
        source: code(d.source),
        code: code(d.code),
        confidence: count(d.confidence),
        length: count(d.textLength),
        segments: count(d.segments),
      };
      turns.push(open);
      open = undefined;
    }
    continue;
  }
  // Rows after the outcome and before the next activation belong to the turn.
  const turn = open ? undefined : turns.at(-1);
  if (!turn) continue;
  if (row.event === "Command") turn.command ??= row.at;
  else if (row.event === "TurnPlanned") turn.plan ??= code(d.plan);
  else if (row.event === "DialogTurn" && d.phase === "decided")
    turn.decided ??= { at: row.at, code: code(d.code), actMs: count(d.actMs) };
  else if (row.event === "RunStarted") turn.runStarted ??= row.at;
  else if (row.event === "ActionExecuted")
    turn.firstAction ??= { at: row.at, type: code(d.actionType) };
  else if (row.event === "SpeechOut" && d.phase === "requested")
    turn.speech ??= row.at;
}
if (open) turns.push(open);

/**
 * When a decider waiting `cut` ms of unchanged text would have ended the turn:
 * the first change that stood that long, before the next change or the
 * endpoint. `later`: the text changed again after it, so the words it had were
 * not the endpoint's. `lengthDiffers`: its text was not the final's length, so
 * the words certainly differ; the same length says nothing either way.
 */
function earlierCut(turn, cut) {
  const { changes, endpoint, outcome } = turn;
  for (let i = 0; i < changes.length; i++) {
    const next = i + 1 < changes.length ? changes[i + 1].at : endpoint.at;
    if (next - changes[i].at < cut) continue;
    const at = changes[i].at + cut;
    const length = changes[i].length;
    return {
      at,
      later: i + 1 < changes.length,
      lengthDiffers:
        length !== undefined && outcome?.length !== undefined
          ? length !== outcome.length
          : undefined,
      savingMs: endpoint.at - at,
    };
  }
  return undefined;
}

const heard = (turn) =>
  turn.endpoint &&
  turn.outcome &&
  turn.changes.length > 0 &&
  (turn.outcome.phase === "transcript_final" ||
    turn.outcome.phase === "transcript_recovered");
/** Patience ended these turns; a push-to-talk release or a cancel says nothing about it. */
const handsFree = (turn) => heard(turn) && turn.activation !== "shortcut_down";

const percentile = (list, p) => {
  if (!list.length) return undefined;
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
};
const stats = (list) =>
  list.length
    ? {
        n: list.length,
        p10: percentile(list, 0.1),
        p50: percentile(list, 0.5),
        p90: percentile(list, 0.9),
        p95: percentile(list, 0.95),
      }
    : { n: 0 };
const defined = (list) => list.filter((v) => v !== undefined);

const recent = turns.slice(-Math.max(1, Number(values.turns) || 20));
const measured = recent.filter(handsFree);
const stages = {
  activationToFirstText: stats(measured.map((t) => t.changes[0].at - t.at)),
  firstToLastText: stats(
    measured.map((t) => t.changes.at(-1).at - t.changes[0].at),
  ),
  gapBetweenChanges: stats(
    measured.flatMap((t) =>
      t.changes.slice(1).map((c, i) => c.at - t.changes[i].at),
    ),
  ),
  lastTextToEndpoint: stats(
    measured.map((t) => t.endpoint.at - t.changes.at(-1).at),
  ),
  stableMs: stats(defined(measured.map((t) => t.endpoint.stableMs))),
  quietMs: stats(defined(measured.map((t) => t.endpoint.quietMs))),
  endpointToOutcome: stats(measured.map((t) => t.outcome.at - t.endpoint.at)),
  outcomeToCommand: stats(
    defined(measured.map((t) => t.command && t.command - t.outcome.at)),
  ),
  decidedActMs: stats(defined(measured.map((t) => t.decided?.actMs))),
  outcomeToRunStarted: stats(
    defined(measured.map((t) => t.runStarted && t.runStarted - t.outcome.at)),
  ),
  outcomeToFirstAction: stats(
    defined(
      measured.map((t) => t.firstAction && t.firstAction.at - t.outcome.at),
    ),
  ),
  outcomeToSpeechRequested: stats(
    defined(measured.map((t) => t.speech && t.speech - t.outcome.at)),
  ),
  activationToOutcome: stats(measured.map((t) => t.outcome.at - t.at)),
};
const tally = (list, key) => {
  const out = {};
  for (const item of list)
    out[key(item) ?? "unknown"] = (out[key(item) ?? "unknown"] ?? 0) + 1;
  return out;
};
const cuts = {};
for (const cut of CUTS) {
  const found = measured.map((t) => earlierCut(t, cut)).filter(Boolean);
  const same = found.filter((c) => !c.later);
  cuts[cut] = {
    reached: found.length,
    laterChange: found.filter((c) => c.later).length,
    lengthDiffers: found.filter((c) => c.lengthDiffers === true).length,
    lengthUnknown: found.filter((c) => c.lengthDiffers === undefined).length,
    savingMs: stats(found.map((c) => c.savingMs)),
    savingWhenSameMs: stats(same.map((c) => c.savingMs)),
  };
}
const summary = {
  files,
  turns: turns.length,
  shown: recent.length,
  measured: measured.length,
  activations: tally(
    recent,
    (t) => t.activation + (t.kind ? `:${t.kind}` : ""),
  ),
  outcomes: tally(
    recent.filter((t) => t.outcome),
    (t) => t.outcome.phase + (t.outcome.source ? `:${t.outcome.source}` : ""),
  ),
  endReasons: tally(measured, (t) => t.endpoint.endReason),
  completeness: tally(measured, (t) => t.endpoint.completeness),
  patience: tally(measured, (t) => t.endpoint.patience),
  changesPerTurn: stats(measured.map((t) => t.changes.length)),
  finalSameLengthAsLastText: measured.filter(
    (t) =>
      t.outcome.length !== undefined &&
      t.outcome.length === t.changes.at(-1).length,
  ).length,
  stages,
  cuts,
};

if (values.json) {
  const shown = recent.map((t) => ({
    at: new Date(t.at).toISOString(),
    activation: t.activation,
    kind: t.kind,
    changes: t.changes.length,
    speakingMs: t.changes.length
      ? t.changes.at(-1).at - t.changes[0].at
      : undefined,
    endpoint: t.endpoint && {
      ...t.endpoint,
      at: undefined,
      lastTextToEndpointMs: t.changes.length
        ? t.endpoint.at - t.changes.at(-1).at
        : undefined,
      toOutcomeMs: t.outcome ? t.outcome.at - t.endpoint.at : undefined,
    },
    outcome: t.outcome && { ...t.outcome, at: undefined },
    plan: t.plan,
    decided: t.decided?.code,
    actMs: t.decided?.actMs,
    firstActionMs:
      t.firstAction && t.outcome ? t.firstAction.at - t.outcome.at : undefined,
    firstActionType: t.firstAction?.type,
    cuts: handsFree(t)
      ? Object.fromEntries(
          CUTS.map((cut) => {
            const c = earlierCut(t, cut);
            return [cut, c && { ...c, at: undefined }];
          }),
        )
      : undefined,
  }));
  console.log(JSON.stringify({ summary, turns: shown }, null, 2));
  process.exit(0);
}

const ms = (value) => (value === undefined ? "—" : `${Math.round(value)} ms`);
const range = (s) =>
  s.n ? `n=${s.n} p50 ${ms(s.p50)} p90 ${ms(s.p90)} p95 ${ms(s.p95)}` : "n=0";
const yesNo = (value) => (value === undefined ? "?" : value ? "yes" : "no");
const list = (tallied) =>
  Object.entries(tallied)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ") || "none";

console.log(
  `Turns: ${turns.length} in ${files.length} file(s); showing the last ${recent.length}, ${measured.length} hands-free with text and an endpoint.`,
);
console.log(
  `Activations: ${list(summary.activations)}. Outcomes: ${list(summary.outcomes)}.`,
);
console.log(
  `End reasons: ${list(summary.endReasons)}. Completeness at the endpoint: ${list(summary.completeness)}. Patience: ${list(summary.patience)}.`,
);
console.log(
  `Text changes per turn: p50 ${summary.changesPerTurn.p50 ?? "—"}, p90 ${summary.changesPerTurn.p90 ?? "—"}.`,
);
console.log();
for (const [index, t] of recent.entries()) {
  const head = `#${index + 1} ${new Date(t.at).toISOString().slice(11, 19)} ${t.activation}${t.kind ? `:${t.kind}` : ""}`;
  if (!t.endpoint || !t.outcome) {
    console.log(
      `${head}  ${t.outcome ? t.outcome.phase : "no endpoint"}${t.outcome?.code ? `:${t.outcome.code}` : ""}`,
    );
    continue;
  }
  const speaking = t.changes.length
    ? t.changes.at(-1).at - t.changes[0].at
    : undefined;
  const e = t.endpoint;
  let line = `${head}  changes ${t.changes.length}, spoke ${ms(speaking)}; last text -> endpoint ${ms(t.changes.length ? e.at - t.changes.at(-1).at : undefined)} (stable ${ms(e.stableMs)}, quiet ${ms(e.quietMs)}, ${e.completeness ?? "?"}, ${e.endReason ?? "?"}); -> ${t.outcome.phase}${t.outcome.source ? `:${t.outcome.source}` : ""} ${ms(t.outcome.at - e.at)}`;
  if (t.decided)
    line += `; decided ${t.decided.code ?? "?"} ${ms(t.decided.actMs)}`;
  if (t.firstAction)
    line += `; first action ${ms(t.firstAction.at - t.outcome.at)}`;
  if (handsFree(t)) {
    const c = earlierCut(t, 800);
    line += c
      ? `; 0.8 s cut: text changed after ${yesNo(c.later)}, final length differs ${yesNo(c.lengthDiffers)}, ${ms(c.savingMs)} sooner`
      : "; 0.8 s cut: never stable that long";
  }
  console.log(line);
}
console.log();
console.log("Stages (hands-free turns with text and an endpoint):");
for (const [name, s] of Object.entries(stages))
  console.log(`  ${name.padEnd(26)} ${range(s)}`);
console.log(
  `  final same length as last text: ${summary.finalSameLengthAsLastText} of ${measured.length}`,
);
console.log();
console.log(
  "Earlier cuts (first moment the text had stood this long before the endpoint):",
);
console.log(
  "  cut      reached  text changed after  final length differs  saving p50 (all / when the text stood)",
);
for (const [cut, c] of Object.entries(cuts)) {
  const pct = (n) =>
    c.reached ? ` (${((100 * n) / c.reached).toFixed(0)}%)` : "";
  console.log(
    `  ${`${cut} ms`.padEnd(8)} ${String(c.reached).padEnd(8)} ${`${c.laterChange}${pct(c.laterChange)}`.padEnd(19)} ${`${c.lengthDiffers}${pct(c.lengthDiffers)}${c.lengthUnknown ? ` +${c.lengthUnknown} unknown` : ""}`.padEnd(21)} ${ms(c.savingMs.p50)} / ${ms(c.savingWhenSameMs.p50)}`,
  );
}
