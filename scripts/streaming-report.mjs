// What acted while the user was still speaking, and what it cost, from the
// local diagnostics stream (design: .data/design/streaming-execution.md §3.4).
//
//   node scripts/streaming-report.mjs
//   node scripts/streaming-report.mjs --turns 40 .data/diagnostics/current.jsonl.1 .data/diagnostics/current.jsonl
//   node scripts/streaming-report.mjs --json output/voice/<cycle>/diagnostics/current.jsonl
//
// Read-only: it never calls a model, never touches the desktop and never
// writes to the log. Content-free: of a VoiceEvent row it reads the phase and
// the timestamp (the text changes are counted, an update and the partial
// native writes right after it as one); of the streaming
// rows their allow-listed codes and measurements alone (StreamClauseCommitted
// index/by/words/leadMs, StreamedAction kind/siteKey/clauseIndex/decideMs/
// issueMs, StreamedActionDropped kind/clauseIndex, StreamedRunStarted
// streamedSteps/dropped); of the rows around them only timestamps and codes
// (NativeRequest.method, RunStarted, ActionExecuted.actionType with its early
// flag, ModelRequestStarted, SpeculationStarted). The words, the URL and the
// app's name are never read, so nothing here can print them.
//
// A turn is the rows from an activation (wake_detected, followup_detected,
// shortcut_down) to its outcome (transcript_final, transcript_recovered,
// transcript_unconfirmed, voice_error, voice_cancelled); the rows after the
// outcome and before the next activation (the final's dropped clauses, the
// run's prelude, the run's own steps) belong to it too.
//
// Per fast action: its clause is the last StreamClauseCommitted with its
// clauseIndex at or before it; its request is the fast-route NativeRequest
// (execute, open_url, open_app, scrollContinuous) nearest the action's row
// between the commit and the row plus a small slack, each request claimed
// once, and commit -> issue is measured from the commit's row to that
// request's (issuedFrom "request") or, with none found, to the action's own
// row (issuedFrom "event"). A StreamedActionDropped names the latest earlier
// action of its index (and kind, when both say one) not yet dropped, so a
// reissue (a rewrite that dropped the earlier step and issued another) reads
// as one dropped and one kept. A run repeated a streamed step when, after its
// StreamedRunStarted, the run journals an ActionExecuted (not an early one)
// or the controller a NativeRequest of kind open_app or open_url matching a
// streamed action of the turn: the same kind and, when both rows carry a
// siteKey, the same key. The controller sends an open_app as `execute`, so a
// request row alone never names the kind; the journal's actionType does.
//
// Since 2026-09-19 (live: a growing clause re-committed and re-issued up to
// seven times an index) the rows also say: StreamClauseCommitted.superseded
// (a re-commit of an index), StreamedAction.nav (home: a site's front page;
// query: an address with an object in it) and StreamedAction.reissue (it
// replaced an earlier issue of the index), and the run's TransitionSettled
// {kind: navigated} after RunStarted is the first capture waiting for the
// prelude's last page. From these: commits per clause (p50 and max over
// every clause of every turn), issues per clause, navigations per sentence
// (open_url actions per turn), reissues, and the settle wait (RunStarted to
// that TransitionSettled). The commit -> issue target applies to site opens
// and to actions without a nav (older logs); a query is held for the words
// to stop growing and is read apart.
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
    `Usage: node scripts/streaming-report.mjs [--turns N] [--json] [file...]

  Defaults to the last 20 turns in .data/diagnostics/current.jsonl. Rotated logs
  (current.jsonl.1 and so on) and a voice cycle's diagnostics/current.jsonl can
  be passed as extra files, oldest first. Per turn: the committed clauses
  (index, by, words, lead, re-commits), the fast actions (kind, site key,
  home or query, decide, issue, commit -> request, reissue), whether the
  final kept each clause, whether the run repeated a streamed step, and how
  long its first capture waited for the prelude's last page. Summary: p50/p95
  of decideMs, issueMs and commit -> issue against the design's targets
  (250 ms p50, 600 ms p95, for site opens), queries apart, commits and issues
  per clause (p50, max), navigations per sentence, reissues, the settle
  wait, the fast-action, dropped and repeat rates, and the model requests
  before the final. Never the words.`,
  );
  process.exit(0);
}

const files = positionals.length
  ? positionals
  : [resolve(root, ".data/diagnostics/current.jsonl")];

/** The design's targets for clause committed -> fast action issued. */
const TARGETS = { commitToIssueP50Ms: 250, commitToIssueP95Ms: 600 };
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
/** The helper methods a fast action issues through (open_app is `execute`). */
const FAST_METHODS = new Set([
  "execute",
  "open_url",
  "open_app",
  "scrollContinuous",
]);
/** The kinds a run may repeat after the prelude told it not to. */
const REPEATABLE = new Set(["open_app", "open_url"]);
/** How long after a StreamedAction row its own request may still be logged. */
const REQUEST_SLACK_MS = 250;

const count = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
const code = (value) =>
  typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(value)
    ? value
    : undefined;
const flag = (value) => value === true;

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

/** One activation's turn: its clauses, fast actions, drops, run and requests. */
const newTurn = (row, phase, d) => ({
  at: row.at,
  activation: phase,
  kind: code(d.kind),
  changes: 0,
  unpaired: false,
  clauses: [],
  actions: [],
  dropped: [],
  requests: [],
  executed: [],
  settles: [],
  modelRequestsBeforeFinal: 0,
  speculations: 0,
});
const turns = [];
let open;
for (const row of rows) {
  const d = row.data;
  if (row.event === "VoiceEvent") {
    const phase = code(d.phase);
    if (!phase) continue;
    if (ACTIVATIONS.has(phase)) {
      if (open) turns.push(open);
      open = newTurn(row, phase, d);
      continue;
    }
    if (!open) continue;
    if (CHANGES.has(phase)) {
      // Native writes the update and then the partial for one change, so a
      // partial right after an update is that change, not a second one.
      if (phase === "transcript_partial" && open.unpaired)
        open.unpaired = false;
      else {
        open.changes += 1;
        open.unpaired = phase === "recognition_update";
      }
    } else if (phase === "turn_endpoint") open.endpoint ??= row.at;
    else if (OUTCOMES.has(phase)) {
      open.outcome = { at: row.at, phase };
      turns.push(open);
      open = undefined;
    }
    continue;
  }
  // Streaming rows land in the open turn or, after its outcome (the final's
  // drops, the run's prelude and steps), in the turn just closed.
  const turn = open ?? turns.at(-1);
  if (!turn) continue;
  const speaking = Boolean(open);
  switch (row.event) {
    case "StreamClauseCommitted":
      turn.clauses.push({
        at: row.at,
        index: count(d.index),
        by: code(d.by),
        words: count(d.words),
        leadMs: count(d.leadMs),
        superseded: flag(d.superseded),
      });
      break;
    case "StreamedAction":
      turn.actions.push({
        at: row.at,
        kind: code(d.kind),
        siteKey: code(d.siteKey),
        nav: code(d.nav),
        clauseIndex: count(d.clauseIndex),
        decideMs: count(d.decideMs),
        issueMs: count(d.issueMs),
        reissue: flag(d.reissue),
      });
      break;
    case "TransitionSettled":
      if (code(d.kind) === "navigated") turn.settles.push(row.at);
      break;
    case "StreamedActionDropped":
      turn.dropped.push({
        at: row.at,
        kind: code(d.kind),
        clauseIndex: count(d.clauseIndex),
      });
      break;
    case "StreamedRunStarted":
      turn.run ??= {
        at: row.at,
        streamedSteps: count(d.streamedSteps),
        dropped: count(d.dropped),
      };
      break;
    case "RunStarted":
      turn.runStarted ??= row.at;
      break;
    case "NativeRequest": {
      const method = code(d.method);
      if (method && (FAST_METHODS.has(method) || REPEATABLE.has(method)))
        turn.requests.push({ at: row.at, method, siteKey: code(d.siteKey) });
      break;
    }
    case "ActionExecuted": {
      const type = code(d.actionType);
      if (type && REPEATABLE.has(type) && d.early !== true)
        turn.executed.push({
          at: row.at,
          kind: type,
          siteKey: code(d.siteKey),
        });
      break;
    }
    case "ModelRequestStarted":
      if (speaking) turn.modelRequestsBeforeFinal += 1;
      break;
    case "SpeculationStarted":
      if (speaking) turn.speculations += 1;
      break;
    default:
      break;
  }
}
if (open) turns.push(open);

/**
 * Pair each fast action with its clause and its request, mark the clauses the
 * final dropped, and find the run's repeats. Pure over one turn's rows.
 */
function resolveTurn(turn) {
  const claimed = new Set();
  // Each drop names the latest earlier action of its index (and kind) not
  // yet dropped: a reissue leaves the earlier step dropped and the new one kept.
  const droppedActions = new Set();
  for (const x of turn.dropped) {
    const target = turn.actions
      .filter(
        (a) =>
          !droppedActions.has(a) &&
          a.clauseIndex === x.clauseIndex &&
          a.at <= x.at &&
          (x.kind === undefined || a.kind === undefined || x.kind === a.kind),
      )
      .at(-1);
    if (target) droppedActions.add(target);
  }
  const actions = turn.actions.map((a) => {
    const commit = turn.clauses
      .filter((c) => c.index === a.clauseIndex && c.at <= a.at)
      .at(-1);
    let request;
    if (commit) {
      const candidates = turn.requests.filter(
        (r) =>
          FAST_METHODS.has(r.method) &&
          !claimed.has(r) &&
          r.at >= commit.at &&
          r.at <= a.at + REQUEST_SLACK_MS,
      );
      request = candidates.sort(
        (x, y) => Math.abs(x.at - a.at) - Math.abs(y.at - a.at),
      )[0];
      if (request) claimed.add(request);
    }
    return {
      clauseIndex: a.clauseIndex,
      kind: a.kind,
      siteKey: a.siteKey,
      ...(a.nav ? { nav: a.nav } : {}),
      decideMs: a.decideMs,
      issueMs: a.issueMs,
      commitToIssueMs: commit ? (request ?? a).at - commit.at : undefined,
      issuedFrom: commit ? (request ? "request" : "event") : undefined,
      kept: !droppedActions.has(a),
      ...(a.reissue ? { reissue: true } : {}),
      // The commit the action was measured from (not in the output).
      commitAt: commit?.at,
    };
  });
  // Each commit row carries the action issued off it, if one was; a clause
  // row is dropped when that action was, else when a drop names its index.
  const clauses = turn.clauses.map((c) => {
    const action = actions.find(
      (a) => a.clauseIndex === c.index && a.commitAt === c.at,
    );
    return {
      index: c.index,
      by: c.by,
      words: c.words,
      leadMs: c.leadMs,
      toFinalMs: turn.outcome ? turn.outcome.at - c.at : undefined,
      action,
      dropped: action
        ? !action.kept
        : turn.dropped.some((x) => x.clauseIndex === c.index),
      ...(c.superseded ? { superseded: true } : {}),
    };
  });
  for (const a of actions) delete a.commitAt;
  // Commits and issues per clause of the utterance (by index), and the
  // navigations of the sentence: what "once per thing asked" looks like.
  const perIndex = (list, key) => {
    const out = new Map();
    for (const item of list)
      if (item[key] !== undefined)
        out.set(item[key], (out.get(item[key]) ?? 0) + 1);
    return [...out.values()];
  };
  const commitsPerClause = perIndex(turn.clauses, "index");
  const issuesPerClause = perIndex(turn.actions, "clauseIndex");
  const navigations = actions.filter((a) => a.kind === "open_url");
  const shape = {
    clauses: commitsPerClause.length,
    commits: turn.clauses.length,
    supersededCommits: turn.clauses.filter((c) => c.superseded).length,
    commitsPerClause,
    issuesPerClause,
    navigations: navigations.length,
    siteOpens: navigations.filter((a) => a.nav === "home").length,
    queries: navigations.filter((a) => a.nav === "query").length,
    reissues: actions.filter((a) => a.reissue).length,
  };
  let run;
  if (turn.run) {
    const after = turn.run.at;
    // The first capture's wait for the prelude's last page: RunStarted to
    // the first TransitionSettled {kind: navigated} after it.
    const settledAt =
      turn.runStarted !== undefined
        ? turn.settles.find((t) => t >= turn.runStarted)
        : undefined;
    const matches = (candidate) =>
      turn.actions.some(
        (a) =>
          a.kind === candidate.kind &&
          (a.siteKey === undefined ||
            candidate.siteKey === undefined ||
            a.siteKey === candidate.siteKey),
      );
    // The journal names the kind; a request row does only when the route is
    // named for it, so requests are read when the journal has nothing.
    const executed = turn.executed.filter((e) => e.at >= after);
    const candidates = executed.length
      ? executed
      : turn.requests
          .filter((r) => r.at >= after && REPEATABLE.has(r.method))
          .map((r) => ({ at: r.at, kind: r.method, siteKey: r.siteKey }));
    run = {
      afterFinalMs: turn.outcome ? after - turn.outcome.at : undefined,
      streamedSteps: turn.run.streamedSteps,
      dropped: turn.run.dropped,
      repeats: candidates.filter(matches).map((c) => ({
        kind: c.kind,
        siteKey: c.siteKey,
        afterMs: c.at - after,
      })),
      settled: settledAt !== undefined,
      ...(settledAt !== undefined
        ? { settleWaitMs: settledAt - turn.runStarted }
        : {}),
    };
  }
  return { clauses, actions, shape, run };
}

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
        p95: percentile(list, 0.95),
      }
    : { n: 0 };
/** p50 and the largest value: for counts that should be one. */
const spread = (list) =>
  list.length
    ? { n: list.length, p50: percentile(list, 0.5), max: Math.max(...list) }
    : { n: 0 };
const defined = (list) => list.filter((v) => v !== undefined);
const tally = (list, key) => {
  const out = {};
  for (const item of list) {
    const k = key(item) ?? "unknown";
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
};
const rate = (part, whole) => (whole ? part / whole : undefined);

const recent = turns.slice(-Math.max(1, Number(values.turns) || 20));
const shown = recent.map((t) => ({ turn: t, ...resolveTurn(t) }));
const streamed = shown.filter((s) => s.clauses.length > 0);
const allActions = streamed.flatMap((s) => s.actions);
const withRun = streamed.filter((s) => s.run);
const repeated = withRun.filter((s) => s.run.repeats.length > 0);
const commitToIssue = stats(defined(allActions.map((a) => a.commitToIssueMs)));
// The target is for a site open; a query is held for the words to stop
// growing. An action without a nav (an older log) counts with the site opens.
const siteOpenActions = allActions.filter((a) => a.nav !== "query");
const queryActions = allActions.filter((a) => a.nav === "query");
const commitToIssueSiteOpens = stats(
  defined(siteOpenActions.map((a) => a.commitToIssueMs)),
);
const shapes = streamed.map((s) => s.shape);
const settledRuns = withRun.filter((s) => s.run.settled);
const summary = {
  files,
  turns: turns.length,
  shown: shown.length,
  streamedTurns: streamed.length,
  clauses: {
    committed: streamed.reduce((n, s) => n + s.clauses.length, 0),
    // Distinct clauses (by index) against commits: a re-commit is the same
    // clause grown or rewritten and committed again.
    distinct: shapes.reduce((n, s) => n + s.clauses, 0),
    superseded: shapes.reduce((n, s) => n + s.supersededCommits, 0),
    commitsPerClause: spread(shapes.flatMap((s) => s.commitsPerClause)),
    issuesPerClause: spread(shapes.flatMap((s) => s.issuesPerClause)),
    by: tally(
      streamed.flatMap((s) => s.clauses),
      (c) => c.by,
    ),
    wordsPerClause: stats(
      defined(streamed.flatMap((s) => s.clauses.map((c) => c.words))),
    ),
    leadMs: stats(
      defined(streamed.flatMap((s) => s.clauses.map((c) => c.leadMs))),
    ),
    commitToFinalMs: stats(
      defined(streamed.flatMap((s) => s.clauses.map((c) => c.toFinalMs))),
    ),
  },
  fastActions: {
    total: allActions.length,
    byKind: tally(allActions, (a) => a.kind),
    perTurn: stats(streamed.map((s) => s.actions.length)),
    turnsWithOne: streamed.filter((s) => s.actions.length > 0).length,
    turnRate: rate(
      streamed.filter((s) => s.actions.length > 0).length,
      streamed.length,
    ),
    issuedFrom: tally(allActions, (a) => a.issuedFrom),
    decideMs: stats(defined(allActions.map((a) => a.decideMs))),
    issueMs: stats(defined(allActions.map((a) => a.issueMs))),
    commitToIssueMs: commitToIssue,
    commitToIssueSiteOpensMs: commitToIssueSiteOpens,
    commitToIssueQueriesMs: stats(
      defined(queryActions.map((a) => a.commitToIssueMs)),
    ),
    targets: TARGETS,
    withinTargets: commitToIssueSiteOpens.n
      ? commitToIssueSiteOpens.p50 <= TARGETS.commitToIssueP50Ms &&
        commitToIssueSiteOpens.p95 <= TARGETS.commitToIssueP95Ms
      : undefined,
  },
  navigations: {
    total: shapes.reduce((n, s) => n + s.navigations, 0),
    siteOpens: shapes.reduce((n, s) => n + s.siteOpens, 0),
    queries: shapes.reduce((n, s) => n + s.queries, 0),
    reissues: shapes.reduce((n, s) => n + s.reissues, 0),
    perTurn: spread(shapes.map((s) => s.navigations)),
  },
  dropped: {
    actions: allActions.filter((a) => !a.kept).length,
    rate: rate(allActions.filter((a) => !a.kept).length, allActions.length),
  },
  runs: {
    withPrelude: withRun.length,
    streamedSteps: withRun.reduce((n, s) => n + (s.run.streamedSteps ?? 0), 0),
    droppedInPrelude: withRun.reduce((n, s) => n + (s.run.dropped ?? 0), 0),
    repeated: repeated.length,
    repeatedActions: repeated.reduce((n, s) => n + s.run.repeats.length, 0),
    repeatRate: rate(repeated.length, withRun.length),
    afterFinalMs: stats(defined(withRun.map((s) => s.run.afterFinalMs))),
    settled: settledRuns.length,
    settleWaitMs: stats(defined(settledRuns.map((s) => s.run.settleWaitMs))),
  },
  modelRequestsBeforeFinal: streamed.reduce(
    (n, s) => n + s.turn.modelRequestsBeforeFinal,
    0,
  ),
  speculationsBeforeFinal: streamed.reduce(
    (n, s) => n + s.turn.speculations,
    0,
  ),
};

if (values.json) {
  const turnsOut = shown.map(({ turn: t, clauses, actions, shape, run }) => ({
    at: new Date(t.at).toISOString(),
    activation: t.activation,
    kind: t.kind,
    outcome: t.outcome?.phase,
    changes: t.changes,
    clauses: clauses.map(({ action, ...c }) => c),
    actions,
    dropped: t.dropped.map((x) => ({
      kind: x.kind,
      clauseIndex: x.clauseIndex,
    })),
    shape,
    run,
    modelRequestsBeforeFinal: t.modelRequestsBeforeFinal,
    speculations: t.speculations,
  }));
  // Wait for the pipe to take the whole report: on macOS a pipe's stdout is
  // asynchronous, and process.exit right after console.log cut a report over
  // 8 KiB at its first chunk.
  await new Promise((done) =>
    process.stdout.write(
      JSON.stringify({ summary, turns: turnsOut }, null, 2) + "\n",
      done,
    ),
  );
  process.exit(0);
}

const ms = (value) => (value === undefined ? "—" : `${Math.round(value)} ms`);
const pct = (value) =>
  value === undefined ? "—" : `${Math.round(100 * value)}%`;
const range = (s) =>
  s.n ? `n=${s.n} p50 ${ms(s.p50)} p95 ${ms(s.p95)}` : "n=0";
const list = (tallied) =>
  Object.entries(tallied)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ") || "none";
const site = (a) => (a.siteKey ? ` ${a.siteKey}` : "");

console.log(
  `Turns: ${turns.length} in ${files.length} file(s); showing the last ${shown.length}, ${streamed.length} with a committed clause, ${summary.fastActions.turnsWithOne} with a fast action, ${withRun.length} whose run started with a prelude.`,
);
console.log(
  `Clauses: ${summary.clauses.committed} committed (${list(summary.clauses.by)}); words per clause p50 ${summary.clauses.wordsPerClause.p50 ?? "—"}; commit -> final ${range(summary.clauses.commitToFinalMs)}.`,
);
const perClause = (s) => (s.n ? `p50 ${s.p50} max ${s.max}` : "n=0");
console.log(
  `Once per thing asked: ${summary.clauses.distinct} clauses in ${summary.clauses.committed} commits (${summary.clauses.superseded} re-commits); commits per clause ${perClause(summary.clauses.commitsPerClause)}; issues per clause ${perClause(summary.clauses.issuesPerClause)}; navigations per sentence ${perClause(summary.navigations.perTurn)} (${summary.navigations.siteOpens} site opens, ${summary.navigations.queries} queries, ${summary.navigations.reissues} reissues); first capture settled in ${summary.runs.settled} of ${withRun.length} runs (${range(summary.runs.settleWaitMs)}).`,
);
console.log(
  `Fast actions: ${allActions.length} (${list(summary.fastActions.byKind)}); ${summary.dropped.actions} dropped by the final (${pct(summary.dropped.rate)}); ${repeated.length} of ${withRun.length} runs repeated a streamed step (${pct(summary.runs.repeatRate)}); ${summary.modelRequestsBeforeFinal} model requests before the final (${summary.speculationsBeforeFinal} speculative).`,
);
console.log();
for (const [
  index,
  { turn: t, clauses, actions, shape, run },
] of shown.entries()) {
  const head = `#${index + 1} ${new Date(t.at).toISOString().slice(11, 19)} ${t.activation}${t.kind ? `:${t.kind}` : ""}`;
  if (!clauses.length) {
    console.log(
      `${head}  ${t.outcome ? t.outcome.phase : "no outcome"}; no streamed clause`,
    );
    continue;
  }
  console.log(
    `${head}  ${t.outcome?.phase ?? "no outcome"}; clauses ${shape.clauses}${shape.commits !== shape.clauses ? ` (${shape.commits} commits, ${shape.supersededCommits} re-commits)` : ""}, fast actions ${actions.length}, navigations ${shape.navigations}${shape.reissues ? ` (${shape.reissues} reissued)` : ""}, dropped ${clauses.filter((c) => c.dropped).length}${run ? `, prelude ${run.streamedSteps ?? "?"} steps, repeats ${run.repeats.length}` : ", no prelude"}`,
  );
  for (const c of clauses) {
    let line = `   clause ${c.index ?? "?"} by ${c.by ?? "?"}${c.superseded ? " (re-commit)" : ""}, ${c.words ?? "?"} words, lead ${ms(c.leadMs)}, -> final ${ms(c.toFinalMs)}: `;
    const a = c.action;
    if (!a) line += "no fast action";
    else
      line += `${a.kind ?? "?"}${site(a)}${a.nav ? ` ${a.nav}` : ""} decide ${ms(a.decideMs)}, issue ${ms(a.issueMs)}, commit -> ${a.issuedFrom === "request" ? "request" : "issued"} ${ms(a.commitToIssueMs)}${a.reissue ? ", reissued" : ""}`;
    line += c.dropped ? "; dropped by the final" : "; kept";
    console.log(line);
  }
  if (run)
    console.log(
      `   run ${ms(run.afterFinalMs)} after the final with ${run.streamedSteps ?? "?"} streamed steps (${run.dropped ?? "?"} dropped); ${
        run.repeats.length
          ? `repeated ${run.repeats.map((r) => `${r.kind}${site(r)} ${ms(r.afterMs)} in`).join(", ")}`
          : "no repeat"
      }; first capture ${run.settled ? `settled ${ms(run.settleWaitMs)} in` : "not settled"}`,
    );
  if (t.modelRequestsBeforeFinal)
    console.log(
      `   model requests before the final: ${t.modelRequestsBeforeFinal} (${t.speculations} speculative)`,
    );
}
console.log();
console.log(`Summary (${streamed.length} turns with a committed clause):`);
const f = summary.fastActions;
console.log(`  ${"decideMs".padEnd(22)} ${range(f.decideMs)}`);
console.log(`  ${"issueMs".padEnd(22)} ${range(f.issueMs)}`);
console.log(
  `  ${"commit -> issue".padEnd(22)} ${range(f.commitToIssueMs)}  (target p50 <= ${TARGETS.commitToIssueP50Ms} ms, p95 <= ${TARGETS.commitToIssueP95Ms} ms for site opens: ${f.withinTargets === undefined ? "no data" : f.withinTargets ? "met" : "missed"}; site opens ${range(f.commitToIssueSiteOpensMs)}; queries, held for the words ${range(f.commitToIssueQueriesMs)}; from a request ${f.issuedFrom.request ?? 0}, from the event ${f.issuedFrom.event ?? 0})`,
);
console.log(
  `  ${"fast actions per turn".padEnd(22)} ${f.perTurn.n ? `p50 ${f.perTurn.p50} p95 ${f.perTurn.p95}` : "n=0"}; turns with one ${f.turnsWithOne} of ${streamed.length} (${pct(f.turnRate)})`,
);
console.log(
  `  ${"dropped".padEnd(22)} ${summary.dropped.actions} of ${allActions.length} fast actions (${pct(summary.dropped.rate)})`,
);
console.log(
  `  ${"repeats".padEnd(22)} ${repeated.length} of ${withRun.length} runs with a prelude (${pct(summary.runs.repeatRate)}), ${summary.runs.repeatedActions} steps; run start after the final ${range(summary.runs.afterFinalMs)}`,
);
console.log(
  `  ${"before the final".padEnd(22)} ${summary.modelRequestsBeforeFinal} model requests (${summary.speculationsBeforeFinal} speculative) in ${streamed.length} turns`,
);
