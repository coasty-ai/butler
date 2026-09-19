/**
 * Opt-in measurement of TypeSafe's Jev (a "System One" decision model, typed
 * answers with probabilities, no text) on Butler's own decisions,
 * through OpenRouter's alpha Decisions endpoint. It never runs under npm
 * test, and nothing in the app imports it or src/gym/jev.ts
 * (tests/boundaries.test.ts); this only measures whether Jev could.
 *
 * Eval "dialog": every case in tests/fixtures/dialog-eval.jsonl, with the
 * exact dialog state scripts/eval-dialog.mjs sends, asked as one Choice over
 * the nine acts in one or both question variants (original: the first run's
 * wording; aligned: worded as the dialog prompt reads). Scored as eval-dialog
 * scores it (a list of accepted acts), with accuracy on every case and on
 * the cases that reach a model, would-run on mustNotRun cases (act errors
 * and accepted acts apart), accuracy and coverage at p >= 0.8 and 0.9, a
 * 5-bin calibration table, cold and warm latency and cost. Next to it: the
 * router alone (what planVoiceTurn does with no model) and, given
 * --baseline, a dialog model's eval-dialog run scored the same way. Jev
 * decides only the act; the dialog model also writes TASK and SAY.
 *
 * Eval "panel": the 20 agentStates cases in tests/fixtures/ide-agents.json,
 * asked as one Choice over the 7 coding-agent panel states, next to what the
 * anchor tables in src/core/monitor.ts read (20 of 20 by construction: the
 * fixture pins them).
 *
 * Every question is asked --runs times (default 3), each run on a connection
 * of its own so its first call is a cold one, and reported as mean and range
 * with the cases that flipped between runs.
 *
 *   set -a; . ./.env; set +a; OPEN_ASSIST_JEV_EVAL=1 \
 *     node --import tsx scripts/eval-jev.mjs [--eval dialog|panel|all] \
 *     [--variant original|aligned|both] [--runs 3] [--max-cost 0.25] \
 *     [--baseline eval-dialog.log] [--model typesafe/jev-1.13] \
 *     [--served-model typesafe/jev-1.13-20260917] \
 *     [--key-env OPENROUTER_API_KEY] [--limit 200] [--only injection] \
 *     [--endpoint URL] [--verbose]
 *
 * The key is read from the named environment variable at run time and never
 * printed. It goes only over https, or over http to this machine (a local
 * stub), and an --endpoint other than OpenRouter's needs --key-env, so the
 * OpenRouter key is never sent anywhere else by default. Every call asks for
 * zero data retention with no fallback, and every answer not served by
 * TypeSafe (in the body and the x-provider-name header alike) on the
 * expected dated build is discarded and counted as an error. The report
 * carries ids, labels, probabilities, timings and cost, never state text;
 * --verbose adds one line per case with the full distribution. The cost cap
 * is checked with a pessimistic estimate before every attempt, retries
 * included, and an attempt whose response does not say what it cost (a
 * timeout, a 524, a body that is not JSON or has no usage) is charged that
 * estimate.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { fileURLToPath } from "node:url";
import { basename, join, dirname } from "node:path";
import { DIALOG_PROMPT_VERSION } from "../src/assistant/prompt.ts";
import { DIALOG_ACTS } from "../src/assistant/protocol.ts";
import {
  DECISIONS_ENDPOINT,
  DIALOG_VARIANTS,
  JEV_MODEL,
  JEV_PROVIDER,
  JEV_SERVED_MODEL,
  PANEL_STATES,
  RETRY_STATUS,
  acceptedActs,
  baselinePlan,
  byTag,
  caseJevState,
  confusion,
  decisionsRequest,
  dialogActQuestion,
  estimateCost,
  flips,
  mcnemar,
  mustNotRunReport,
  panelJevState,
  panelQuestion,
  plannedKind,
  probabilityShift,
  readBaseline,
  readChoice,
  readServed,
  readUsage,
  regexPanelState,
  round,
  routerAct,
  routerPlan,
  routerSettled,
  scoreAnswer,
  servedError,
  spread,
  summarize,
  tally,
  wouldRunReport,
  wrongList,
} from "../src/gym/jev.ts";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
if (process.env.OPEN_ASSIST_JEV_EVAL !== "1") {
  console.error(
    "This evaluation spends money on model calls. Set OPEN_ASSIST_JEV_EVAL=1 to run it.",
  );
  process.exit(2);
}
const model = flag("model", JEV_MODEL);
const expected = {
  provider: JEV_PROVIDER,
  model: flag("served-model", JEV_SERVED_MODEL),
};
const keyEnv = flag("key-env", "OPENROUTER_API_KEY");
const endpointFlag = flag("endpoint", DECISIONS_ENDPOINT);
const endpoint = URL.canParse(endpointFlag) ? new URL(endpointFlag) : undefined;
// The key rides in the Authorization header: in the clear over http, and to
// whoever --endpoint names.
const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);
if (
  !endpoint ||
  !(
    endpoint.protocol === "https:" ||
    (endpoint.protocol === "http:" && LOOPBACK.has(endpoint.hostname))
  )
) {
  console.error(
    "--endpoint must be an https URL, or http on this machine (127.0.0.1, ::1 or localhost).",
  );
  process.exit(2);
}
if (endpoint.href !== DECISIONS_ENDPOINT && !args.includes("--key-env")) {
  console.error(
    "An --endpoint other than OpenRouter's needs --key-env naming the key it may be sent.",
  );
  process.exit(2);
}
const maxCost = Number(flag("max-cost", "0.25"));
const limit = Number(flag("limit", "1000"));
const runs = Number(flag("runs", "3"));
const only = flag("only", "");
const which = flag("eval", "all");
const variantFlag = flag("variant", "aligned");
const baselinePath = flag("baseline", "");
const verbose = args.includes("--verbose");
if (
  !(maxCost > 0) ||
  !(limit > 0) ||
  !Number.isInteger(runs) ||
  runs < 1 ||
  runs > 20 ||
  !/^(?:dialog|panel|all)$/.test(which) ||
  !/^(?:original|aligned|both)$/.test(variantFlag)
) {
  console.error(
    "--max-cost and --limit must be positive, --runs 1 to 20; --eval is dialog, panel or all; --variant is original, aligned or both.",
  );
  process.exit(2);
}
const variants = variantFlag === "both" ? [...DIALOG_VARIANTS] : [variantFlag];
const key = process.env[keyEnv] ?? "";
if (!key) {
  console.error(`No key in $${keyEnv}.`);
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) =>
  readFileSync(join(here, "../tests/fixtures", name), "utf8");
const allDialogCases = fixture("dialog-eval.jsonl")
  .split("\n")
  .filter((line) => line.trim() && !line.startsWith("#"))
  .map((line) => JSON.parse(line));
let baseline;
if (baselinePath) {
  try {
    baseline = readBaseline(readFileSync(baselinePath, "utf8"), allDialogCases);
  } catch (error) {
    console.error(`--baseline: ${error?.message ?? "unreadable"}`);
    process.exit(2);
  }
}

/** What the cap counts: billed costs plus the estimates charged below. */
let spent = 0;
let billed = 0;
let estimated = 0;
let estimatedAttempts = 0;
let usageMissing = 0;
let capped = false;
let retries = 0;
const observed = {
  providers: {},
  providerHeaders: {},
  models: {},
  discarded: 0,
};
const count = (table, name) =>
  (table[name ?? "missing"] = (table[name ?? "missing"] ?? 0) + 1);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const transport = endpoint.protocol === "https:" ? https : http;

/**
 * A keep-alive pool of one socket per run. A new pool per run makes the run's
 * first call pay for a new connection (DNS, TCP, TLS), the way a first voice
 * turn after idle would, and every later call reuse it; one shared pool
 * would make every run after the first look warm.
 */
const newConnection = () =>
  new transport.Agent({ keepAlive: true, maxSockets: 1 });

function post(body, agent) {
  return new Promise((resolve, reject) => {
    const request = transport.request(
      endpoint,
      {
        method: "POST",
        agent,
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        signal: AbortSignal.timeout(15000),
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            providerHeader: response.headers["x-provider-name"],
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

/**
 * An attempt that may have been billed without saying what it cost: charge
 * the pre-call estimate, so the cap holds even when usage never comes back.
 */
function chargeEstimate(estimate) {
  spent += estimate;
  estimated += estimate;
  estimatedAttempts++;
  return estimate;
}

/**
 * One Choice question over one state. Returns the answer and its timing, an
 * error code, or { capped } when an attempt could break the cost cap, and
 * `cost`, what its attempts were charged. Only the last attempt is timed;
 * 429, 529 and gateway errors are retried twice.
 */
async function decide(state, question, options, agent) {
  const request = decisionsRequest(state, { q: question }, model);
  const estimate = estimateCost(request);
  const body = JSON.stringify(request);
  let cost = 0;
  for (let attempt = 1; ; attempt++) {
    // Before every attempt, retries included: each one may be billed.
    if (spent + estimate > maxCost) {
      capped = true;
      return { capped: true };
    }
    if (attempt > 1) {
      retries++;
      await sleep(500 * 3 ** (attempt - 2));
    }
    const started = performance.now();
    let response;
    try {
      response = await post(body, agent);
    } catch (error) {
      // A timeout may have reached the model; a refused connection did not,
      // but the two are not always told apart, so both are charged.
      cost += chargeEstimate(estimate);
      if (attempt < 3) continue;
      const timeout =
        error?.name === "TimeoutError" || error?.cause?.name === "TimeoutError";
      return {
        error: timeout ? "timeout" : "network",
        attempts: attempt,
        cost,
      };
    }
    const latencyMs = performance.now() - started;
    // A gateway timeout: the model may have answered, and billed, behind it.
    if (response.status === 524) cost += chargeEstimate(estimate);
    if (RETRY_STATUS.has(response.status) && attempt < 3) continue;
    if (response.status !== 200)
      return {
        error: `http_${response.status}`,
        latencyMs,
        attempts: attempt,
        cost,
      };
    let parsed;
    try {
      parsed = JSON.parse(response.text);
    } catch {
      cost += chargeEstimate(estimate);
      return { error: "bad_json", latencyMs, attempts: attempt, cost };
    }
    // Billed whoever served it, so it counts against the cap either way.
    const usage = readUsage(parsed);
    if (usage.priced) {
      spent += usage.cost;
      billed += usage.cost;
      cost += usage.cost;
    } else {
      usageMissing++;
      cost += chargeEstimate(estimate);
    }
    const served = readServed(parsed, response.providerHeader);
    count(observed.providers, served.provider);
    count(observed.providerHeaders, served.providerHeader);
    count(observed.models, served.model);
    const wrong = servedError(served, expected);
    if (wrong) {
      observed.discarded++;
      return { error: wrong, latencyMs, usage, attempts: attempt, cost };
    }
    const read = readChoice(parsed, "q", options);
    if (!read.ok)
      return { error: read.code, latencyMs, usage, attempts: attempt, cost };
    return { answer: read.answer, latencyMs, usage, attempts: attempt, cost };
  }
}

const verboseLine = (label, row) => {
  if (!verbose) return;
  if (row.error) console.log(`${label} ${row.id}: error ${row.error}`);
  else
    console.log(
      `${label} ${row.id}: ${row.got} p=${row.p} conf=${row.confidence} ${
        row.right ? "right" : `WRONG (expected ${row.expected.join("|")})`
      }${row.plan ? ` plan=${row.plan}` : ""}${row.settled ? " settled" : ""} ${Math.round(
        row.latencyMs ?? 0,
      )}ms${row.cold ? " cold" : ""} ${JSON.stringify(row.probabilities)}`,
    );
};

/**
 * One run of one question over its cases, on a connection of its own.
 * `fields(c)` gives a case's fixed row fields (with `dialog`, the case, when
 * the act's plan is wanted); `stateOf(c)` the state Jev is shown.
 */
async function runOnce(label, cases, question, options, fields, stateOf) {
  const agent = newConnection();
  const rows = [];
  let inputTokens = 0;
  try {
    for (const c of cases) {
      const result = await decide(stateOf(c), question, options, agent);
      if (result.capped) {
        console.error(
          `Cost cap of $${maxCost} reached after ${rows.length} cases of ${label}.`,
        );
        break;
      }
      const base = fields(c);
      const row = {
        ...base,
        p: 0,
        confidence: 0,
        pAccepted: 0,
        right: false,
        cost: result.cost,
        latencyMs: result.latencyMs,
        // A retried first call was timed on the socket its first try opened.
        ...(rows.length === 0 && result.attempts === 1 ? { cold: true } : {}),
      };
      inputTokens += result.usage?.inputTokens ?? 0;
      if (result.error) row.error = result.error;
      else {
        Object.assign(row, scoreAnswer(row.expected, result.answer));
        row.probabilities = result.answer.probabilities;
        if (base.dialog) row.plan = plannedKind(base.dialog, row.got);
      }
      delete row.dialog;
      rows.push(row);
      verboseLine(label, row);
    }
  } finally {
    agent.destroy();
  }
  return { rows, inputTokens };
}

const ratio = (right, cases) => (cases ? right / cases : undefined);
const headline = (summaries, pick) =>
  spread(summaries.map(pick).filter((v) => typeof v === "number"));

async function runDialog() {
  const cases = allDialogCases
    .filter((c) => !only || (c.tags ?? []).includes(only))
    .slice(0, limit);
  const router = new Map(
    cases.map((c) => {
      const plan = routerPlan(c);
      return [
        c.id,
        {
          plan: plan.kind,
          act: routerAct(plan),
          settled: routerSettled(c, plan),
        },
      ];
    }),
  );
  const fields = (c) => ({
    id: c.id,
    expected: acceptedActs(c),
    tags: c.tags ?? [],
    ...(c.expect.mustNotRun ? { mustNotRun: true } : {}),
    ...(router.get(c.id).settled ? { settled: true } : {}),
    dialog: c,
  });
  const reachable = (rows) => rows.filter((r) => !r.settled);

  // The router alone: the plan with no model, as the head-timeout fallback.
  const routerRows = cases.map((c) => {
    const r = router.get(c.id);
    return {
      id: c.id,
      right: acceptedActs(c).includes(r.act),
      mustNotRun: c.expect.mustNotRun === true,
      settled: r.settled,
      plan: r.plan,
    };
  });
  const plans = {};
  for (const r of routerRows) count(plans, r.plan);

  let baselineRows;
  if (baseline) {
    baselineRows = cases
      .filter((c) => baseline.cases[c.id].right !== null)
      .map((c) => ({
        id: c.id,
        right: baseline.cases[c.id].right,
        mustNotRun: c.expect.mustNotRun === true,
        settled: router.get(c.id).settled,
        plan: baselinePlan(c, baseline.cases[c.id]),
      }));
  }

  // Runs outermost, so drift over the session falls on both variants alike.
  const byVariant = Object.fromEntries(variants.map((v) => [v, []]));
  for (let run = 1; run <= runs && !capped; run++)
    for (const variant of variants) {
      if (capped) break;
      const question = dialogActQuestion(variant);
      const { rows, inputTokens } = await runOnce(
        `${variant} r${run}`,
        cases,
        question,
        DIALOG_ACTS,
        fields,
        caseJevState,
      );
      byVariant[variant].push({ rows, inputTokens });
    }

  const variantReport = (variant) => {
    const done = byVariant[variant];
    const perRun = done.map(({ rows, inputTokens }) => {
      const s = summarize(rows, inputTokens);
      const paired = baselineRows && pairedWith(rows, baselineRows);
      return {
        ...s,
        reachable: tally(reachable(rows)),
        underHeadDeadline1500ms: rows.length
          ? round(
              rows.filter((r) => !r.error && r.latencyMs <= 1500).length /
                rows.length,
            )
          : 0,
        mustNotRun: mustNotRunReport(rows),
        ...(paired ? { pairedWithBaseline: paired } : {}),
        byTag: byTag(rows),
        confusion: confusion(rows),
        wrong: wrongList(rows),
      };
    });
    const allRows = done.flatMap((d) => d.rows);
    const warm = summarize(allRows).latencyMs;
    return {
      questionSha256: createHash("sha256")
        .update(JSON.stringify(dialogActQuestion(variant)))
        .digest("hex")
        .slice(0, 12),
      runs: perRun.length,
      headline: {
        // From the counts, not the rounded rates: a mean of rounded values
        // can be off in the fourth place.
        accuracy: headline(perRun, (s) => ratio(s.right, s.cases)),
        reachableAccuracy: headline(perRun, (s) =>
          ratio(s.reachable.right, s.reachable.cases),
        ),
        wouldRun: headline(perRun, (s) => s.mustNotRun.wouldRun.n),
        wouldRunActErrors: headline(
          perRun,
          (s) => s.mustNotRun.wouldRun.actErrors,
        ),
        wouldRunAcceptedActs: headline(
          perRun,
          (s) => s.mustNotRun.wouldRun.acceptedActs,
        ),
        wouldRunModelAttributable: headline(
          perRun,
          (s) => s.mustNotRun.wouldRun.modelAttributable,
        ),
        accuracyAtP80: headline(perRun, (s) => s.thresholds[0]?.accuracy),
        coverageAtP80: headline(perRun, (s) => s.thresholds[0]?.coverage),
        accuracyAtP90: headline(perRun, (s) => s.thresholds[1]?.accuracy),
        coverageAtP90: headline(perRun, (s) => s.thresholds[1]?.coverage),
        calibrationError: headline(perRun, (s) => s.calibrationError),
        errors: headline(perRun, (s) => s.errors),
        ...(baselineRows
          ? {
              pairedP: headline(perRun, (s) => s.pairedWithBaseline.all.p),
              pairedReachableP: headline(
                perRun,
                (s) => s.pairedWithBaseline.reachable.p,
              ),
            }
          : {}),
      },
      latencyMs: {
        warm,
        cold: perRun.flatMap((s) => s.coldMs),
      },
      flips: flips(done.map((d) => d.rows)),
      probabilityShift: probabilityShift(done.map((d) => d.rows)),
      cost: round(
        perRun.reduce((sum, s) => sum + s.cost, 0),
        6,
      ),
      perRun,
    };
  };

  const answers = Object.fromEntries(
    variants.map((v) => [
      v,
      byVariant[v].map(({ rows }) => new Map(rows.map((r) => [r.id, r]))),
    ]),
  );
  const table = cases.map((c) => {
    const r = router.get(c.id);
    const row = {
      id: c.id,
      expected: acceptedActs(c),
      ...(c.expect.mustNotRun ? { mustNotRun: true } : {}),
      router: r.plan,
      routerRight: acceptedActs(c).includes(r.act),
      settled: r.settled,
    };
    if (baseline) {
      row.baseline = baseline.cases[c.id].act;
      row.baselineRight = baseline.cases[c.id].right;
    }
    for (const variant of variants)
      row[variant] = answers[variant].map((run) => {
        const got = run.get(c.id);
        return !got ? null : got.error ? `error:${got.error}` : got.got;
      });
    return row;
  });

  const column = (rows) => ({
    ...tally(rows),
    reachable: tally(reachable(rows)),
    wouldRun: wouldRunReport(rows),
  });
  return {
    promptVersion: DIALOG_PROMPT_VERSION,
    cases: cases.length,
    routerSettled: routerRows.filter((r) => r.settled).length,
    router: { plans, ...column(routerRows) },
    ...(baseline
      ? {
          baseline: {
            source: basename(baselinePath),
            model: baseline.model,
            promptVersion: baseline.promptVersion,
            known: baselineRows.length,
            actsKnown: cases.filter((c) => baseline.cases[c.id].act !== null)
              .length,
            ...column(baselineRows),
          },
        }
      : {}),
    variants: Object.fromEntries(variants.map((v) => [v, variantReport(v)])),
    table,
  };
}

/** Paired right/wrong against the baseline on the cases both have. */
function pairedWith(rows, baselineRows) {
  const theirs = new Map(baselineRows.map((r) => [r.id, r.right]));
  const pair = (list) => {
    let jevOnly = 0;
    let baselineOnly = 0;
    for (const r of list) {
      if (!theirs.has(r.id)) continue;
      if (r.right && !theirs.get(r.id)) jevOnly++;
      if (!r.right && theirs.get(r.id)) baselineOnly++;
    }
    return { jevOnly, baselineOnly, p: mcnemar(jevOnly, baselineOnly) };
  };
  return { all: pair(rows), reachable: pair(rows.filter((r) => !r.settled)) };
}

async function runPanel() {
  const cases = JSON.parse(fixture("ide-agents.json"))
    .agentStates.slice(0, limit)
    .map((c, i) => ({ ...c, id: `panel-${i + 1}-${c.agent}` }));
  const regexRight = cases.filter((c) => regexPanelState(c) === c.state).length;
  const question = panelQuestion();
  const fields = (c) => ({ id: c.id, expected: [c.state], tags: [c.agent] });
  const done = [];
  for (let run = 1; run <= runs && !capped; run++)
    done.push(
      await runOnce(
        `panel r${run}`,
        cases,
        question,
        PANEL_STATES,
        fields,
        panelJevState,
      ),
    );
  const perRun = done.map(({ rows, inputTokens }) => {
    const answered = rows.filter((r) => !r.error);
    return {
      ...summarize(rows, inputTokens),
      // A missed permission question leaves the agent waiting unseen; a false
      // done or error wakes a paid vision run on the window.
      missedPermission: answered.filter(
        (r) =>
          r.expected[0] === "needs_permission" && r.got !== "needs_permission",
      ).length,
      falsePermission: answered.filter(
        (r) =>
          r.expected[0] !== "needs_permission" && r.got === "needs_permission",
      ).length,
      falseWake: answered.filter(
        (r) => ["done", "error"].includes(r.got) && r.got !== r.expected[0],
      ).length,
      byAgent: byTag(rows),
      confusion: confusion(rows),
      wrong: wrongList(rows),
    };
  });
  return {
    cases: cases.length,
    regexBaseline: { right: regexRight, cases: cases.length },
    runs: perRun.length,
    headline: {
      accuracy: headline(perRun, (s) => ratio(s.right, s.cases)),
      falseWake: headline(perRun, (s) => s.falseWake),
      missedPermission: headline(perRun, (s) => s.missedPermission),
    },
    latencyMs: {
      warm: summarize(done.flatMap((d) => d.rows)).latencyMs,
      cold: perRun.flatMap((s) => s.coldMs),
    },
    flips: flips(done.map((d) => d.rows)),
    probabilityShift: probabilityShift(done.map((d) => d.rows)),
    perRun,
  };
}

const report = {
  endpoint:
    endpoint.href === DECISIONS_ENDPOINT
      ? "openrouter alpha decisions"
      : "custom",
  model,
  // What was asked for; only `observed` says what served it.
  requestedProvider: decisionsRequest(null, {}, model).provider,
  expectedServed: expected,
  runs,
  variants,
  maxCost,
};
if (which === "dialog" || which === "all") report.dialog = await runDialog();
if (!capped && (which === "panel" || which === "all"))
  report.panel = await runPanel();
report.observed = observed;
report.retries = retries;
report.capped = capped;
// What the cap counted, and how much of it is an estimate rather than a bill.
report.totalCost = round(spent, 6);
report.costBasis = {
  billed: round(billed, 6),
  estimated: round(estimated, 6),
  estimatedAttempts,
  usageMissing,
};
const errors = [
  ...Object.values(report.dialog?.variants ?? {}).flatMap((v) =>
    v.perRun.map((s) => s.errors),
  ),
  ...(report.panel?.perRun ?? []).map((s) => s.errors),
].reduce((sum, n) => sum + n, 0);
// A measurement, not a gate: it fails only when it could not measure. The
// exit waits for the write: on macOS a pipe takes stdout asynchronously, and
// exiting at once would cut a report longer than the pipe's 64 KB buffer.
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`, () =>
  process.exit(errors || capped ? 1 : 0),
);
