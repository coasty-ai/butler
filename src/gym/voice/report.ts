import type { CycleResults, FailureClass } from "../bench/cycle-report";
import { powerN, twoProportionZ, wilson } from "../bench/stats";
import {
  COST_WEIGHT,
  ENVIRONMENT_CODES,
  EVIDENCE,
  FAILURE_CODES,
  OWNER,
  isSoft,
  loopOwnerOf,
  noteFor,
  rankClasses,
  strictVoiceClass,
  type Classification,
  type FailureCode,
} from "./classify";
import { LATENCY, type TurnGrade, type TurnSummary } from "./grade";
import type { Outcome } from "./suite";

/**
 * results.json and report.md for one voice cycle, and the fix briefs. The
 * results file is a schema-2 superset: `failureClasses` are real
 * FailureClass rows, so `npm run loop -- --output output/voice` selects
 * lanes from it unchanged. Every string in either file is a code, an id, a
 * bundle id, the fixture's own catalogue text or a timestamp; the
 * transcript, the run's task text and its messages stay in the summaries
 * the script keeps locally, and a test feeds marked text through this
 * module to prove none of it comes out.
 */

export const VOICE_SCHEMA = 1;
export const HARNESS_VERSION = "1";

export interface PlanTask {
  id: string;
  category: string;
  tags: string[];
  say: string;
  expectOutcome: Outcome;
  timeoutMs: number;
}

export interface VoicePlan {
  id: string;
  startedAt: string;
  gitRev: string;
  gitBranch: string;
  dirty: boolean;
  host: { macos: string; arch: string };
  app: {
    path: string;
    bundleId: string;
    version: string;
    build: string;
    executableMtime: string;
  } | null;
  voice: string;
  rate: number;
  wake: string;
  idleSeconds: number;
  noisy: boolean;
  requireQuiet: boolean;
  suiteHash: string;
  tasks: PlanTask[];
  repeat: number;
}

export interface PreflightFacts {
  codes: string[];
  listening: boolean | null;
  permissions: Record<string, boolean> | null;
  verbose: boolean | null;
  quiet: {
    floor: number | null;
    speech: number | null;
    threshold: number | null;
    source: "trace" | "none";
  };
  volume: number | null;
  /** Tasks skipped by a probe, with the subcode. */
  skipped: Record<string, string>;
}

export interface GateWaits {
  count: number;
  totalSeconds: number;
  byReason: Record<string, number>;
  longestSeconds: number;
}

export interface TurnGateFacts {
  waitedMs: number;
  reasons: Record<string, number>;
  idleSeen: number | null;
  quietRms: number | null;
}

/** What the script records per turn; the row builder copies only codes and numbers. */
export interface TurnRecord {
  turnId: string;
  taskId: string;
  attempt: number;
  at: string;
  wallMs: number;
  grade: TurnGrade;
  classification: Classification;
  summaries: TurnSummary[];
  gate: TurnGateFacts;
}

export interface TurnRow {
  turnId: string;
  taskId: string;
  attempt: number;
  category: string;
  tags: string[];
  pass: boolean;
  code: string | null;
  softCode: string | null;
  subcode: string | null;
  heard: boolean;
  misheard: boolean;
  plan: string | null;
  decided: {
    code?: string;
    act?: string;
    plan?: string;
    actMs?: number;
  } | null;
  jev: { used?: boolean; act?: string; p?: number; ms?: number } | null;
  early: {
    code?: string;
    settle?: string;
    earlyMs?: number;
    ended?: string;
    leadMs?: number;
  } | null;
  run: {
    started: boolean;
    terminal: string | null;
    actions: number;
    actionTypes: string[];
    mutations: number;
    failures: Record<string, number>;
    confirmations: number;
    takeover: boolean;
    providerModel: string | null;
  };
  spoken: boolean;
  followup: {
    opened: boolean;
    detectedKind: string | null;
    closedMs: number | null;
  };
  latency: {
    sayMs: number | null;
    wakeMs: number | null;
    transcriptMs: number | null;
    endpointMs: number | null;
    firstActionMs: number | null;
    firstActionAfterTranscriptMs: number | null;
    replyMs: number | null;
    replyAfterTranscriptMs: number | null;
    stopToCancelledMs: number | null;
    capture: Record<string, number> | null;
  };
  state: Record<string, boolean | null>;
  gate: TurnGateFacts;
  at: string;
  wallMs: number;
}

export interface ClassDelta {
  before: { k: number; n: number; rate: number };
  after: { k: number; n: number; rate: number };
  verdict: "improved" | "regressed" | "inconclusive" | "new" | "gone";
  p: number;
  /** Attempts per cycle a 10-point change would need to show. */
  neededAttempts: number;
}

export interface VoiceResults {
  schema_version: 2;
  harnessVersion: string;
  voiceSchema: number;
  kind: "voice";
  cycle: VoicePlan & {
    finishedAt: string;
    probeCommand: string;
    matrix: { provider: string; model: string }[];
    stoppedBecause?: string;
  };
  preflight: PreflightFacts;
  results: TurnRow[];
  aggregate: {
    ran: number;
    passed: number;
    passRate: number;
    wilson95: [number, number];
    byCategory: Record<
      string,
      { ran: number; passed: number; rate: number; wilson95: [number, number] }
    >;
    byTag: Record<
      string,
      { ran: number; passed: number; rate: number; wilson95: [number, number] }
    >;
    handsFree: { rate: number; wilson95: [number, number] };
    latency: {
      p50: Record<string, number | null>;
      p95: Record<string, number | null>;
    };
  };
  failureClasses: FailureClass[];
  environment: {
    takeover: number;
    envNotReady: Record<string, number>;
    aborted: { code: string; turnId: string; at: string } | null;
  };
  gate: GateWaits;
  previous: {
    cycleId: string;
    suiteHash: string;
    classDelta: Record<string, ClassDelta>;
  } | null;
  regressions: never[];
  modelComparison: never[];
}

/* ---------------------------------------------------------------- rows */

const histogram = (items: string[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const item of items) out[item] = (out[item] ?? 0) + 1;
  return out;
};

/** A content-free row: only codes, ids, booleans and numbers are copied. */
export function turnRow(record: TurnRecord): TurnRow {
  const g = record.grade;
  const c = record.classification;
  const first = record.summaries[0];
  const last = record.summaries.at(-1);
  const stopTurn = record.summaries.find((s) => s.plan === "stop");
  const stopToCancelledMs =
    stopTurn && stopTurn.terminalMs !== null && stopTurn.wakeMs !== null
      ? stopTurn.terminalMs - stopTurn.wakeMs
      : null;
  return {
    turnId: record.turnId,
    taskId: record.taskId,
    attempt: record.attempt,
    category: g.category,
    tags: g.tags,
    pass: c.pass,
    code: c.code ?? null,
    softCode: c.softCode ?? null,
    subcode: c.subcode ?? null,
    heard: g.heard === "heard",
    misheard: g.heard === "misheard",
    plan: first?.plan ?? null,
    decided: first?.decided ?? null,
    jev: first?.jev ?? null,
    early: first?.earlyExecuted
      ? {
          code: first.earlyExecuted.code,
          settle: first.earlyExecuted.settle,
          earlyMs: first.earlyExecuted.earlyMs,
          ended: first.earlyEnded?.phase,
          leadMs: first.earlyEnded?.leadMs,
        }
      : null,
    run: {
      started: g.runStarted,
      terminal: g.terminal,
      actions: g.actions,
      actionTypes: record.summaries.flatMap((s) => s.actions),
      mutations: g.mutations,
      failures: histogram(g.failures),
      confirmations: g.confirmations,
      takeover: g.takeover,
      providerModel:
        record.summaries.map((s) => s.providerModel).find((x) => x) ?? null,
    },
    spoken: g.spoken,
    followup: {
      opened: record.summaries.some((s) => s.followup.openedMs !== null),
      detectedKind:
        record.summaries.map((s) => s.followup.detectedKind).find((x) => x) ??
        null,
      closedMs: last?.followup.closedMs ?? null,
    },
    latency: {
      sayMs: first?.sayMs ?? null,
      wakeMs: first?.wakeMs ?? null,
      transcriptMs: first?.transcriptMs ?? null,
      endpointMs: first?.endpointMs ?? null,
      firstActionMs: first?.firstActionMs ?? null,
      firstActionAfterTranscriptMs: g.firstActionAfterTranscriptMs,
      replyMs: first?.replyMs ?? null,
      replyAfterTranscriptMs: g.replyAfterTranscriptMs,
      stopToCancelledMs,
      capture: first?.captureTimings ?? null,
    },
    state: g.checks,
    gate: record.gate,
    at: record.at,
    wallMs: record.wallMs,
  };
}

/* ------------------------------------------------------------ aggregate */

const isEnvironment = (row: TurnRow): boolean =>
  !!row.code && (ENVIRONMENT_CODES as readonly string[]).includes(row.code);
/** Rows that count: the app was asked and answered, whatever it did. */
export const ranRows = (rows: TurnRow[]): TurnRow[] =>
  rows.filter((row) => !isEnvironment(row));

function rateOf(rows: TurnRow[]) {
  const passed = rows.filter((row) => row.pass).length;
  return {
    ran: rows.length,
    passed,
    rate: rows.length ? passed / rows.length : 0,
    wilson95: wilson(passed, rows.length),
  };
}

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(p * sorted.length) - 1),
  );
  return sorted[index];
}

const LATENCY_KEYS = [
  "wakeMs",
  "endpointMs",
  "firstActionAfterTranscriptMs",
  "replyAfterTranscriptMs",
] as const;

function latencyStats(
  rows: TurnRow[],
  p: number,
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const key of LATENCY_KEYS)
    out[key] = percentile(
      rows
        .map((row) => row.latency[key])
        .filter((v): v is number => v !== null),
      p,
    );
  out.captureTotal = percentile(
    rows
      .map((row) => row.latency.capture?.total)
      .filter((v): v is number => typeof v === "number"),
    p,
  );
  return out;
}

function failureClasses(rows: TurnRow[], ran: TurnRow[]): FailureClass[] {
  const ranIds = new Set(ran.map((row) => row.turnId));
  const categories = [...new Set(rows.map((row) => row.category))];
  const cells = [
    ...new Set(ran.map((row) => `app:${row.run.providerModel ?? "app"}`)),
  ];
  return rankClasses(rows).map((ranked) => {
    const hit = rows.filter(
      (row) => row.code === ranked.code || row.softCode === ranked.code,
    );
    const failedHits = hit.filter((row) => !row.pass && ranIds.has(row.turnId));
    const attempts = (ENVIRONMENT_CODES as readonly string[]).includes(
      ranked.code,
    )
      ? hit.length
      : failedHits.length;
    const denominator = ran.length || rows.length || 1;
    const rate = attempts / denominator;
    const byCategory: FailureClass["byCategory"] = {};
    for (const category of categories) {
      const inCategory = ran.filter((row) => row.category === category);
      const count = failedHits.filter(
        (row) => row.category === category,
      ).length;
      byCategory[category] = {
        attempts: count,
        rate: inCategory.length ? count / inCategory.length : 0,
      };
    }
    const byModel: FailureClass["byModel"] = {};
    for (const cell of cells) {
      const inCell = ran.filter(
        (row) => `app:${row.run.providerModel ?? "app"}` === cell,
      );
      const count = failedHits.filter(
        (row) => `app:${row.run.providerModel ?? "app"}` === cell,
      ).length;
      byModel[cell] = {
        attempts: count,
        rate: inCell.length ? count / inCell.length : 0,
      };
    }
    const subcodes = [
      ...new Set(hit.map((row) => row.subcode).filter((x): x is string => !!x)),
    ];
    const subcode = subcodes[0];
    const contributors = [
      `owner:${OWNER[ranked.code]}`,
      ...subcodes.map((s) => `subcode:${s}`),
      ...[...new Set(hit.flatMap((row) => row.tags))].map((t) => `tag:${t}`),
      ...(ranked.soft ? ["soft"] : []),
    ];
    return {
      rank: ranked.rank,
      code: ranked.code,
      source: "grade",
      owner: loopOwnerOf(ranked.code, subcode),
      attempts,
      attemptRate: rate,
      passedAttempts: hit.filter((row) => row.pass).length,
      wilson95: wilson(attempts, denominator),
      events: hit.length,
      byModel,
      byCategory,
      contributors,
      examples: hit.slice(0, 3).map((row) => ({
        runId: row.turnId,
        cell: `app:${row.run.providerModel ?? "app"}`,
        taskId: row.taskId,
        attempt: row.attempt,
        at: row.at,
      })),
      note: noteFor(ranked.code),
    };
  });
}

/* --------------------------------------------------------------- results */

export const probeCommandFor = (): string =>
  "npm run voice:loop -- --only <IDS> --repeat 3 --cycle-id probe-<CODE>-<id> --i-know-this-speaks-to-my-mac";

export function buildResults(o: {
  plan: VoicePlan;
  turns: TurnRecord[];
  preflight: PreflightFacts;
  gate: GateWaits;
  previous: VoiceResults | null;
  finishedAt: string;
  aborted?: { code: string; turnId: string; at: string } | null;
  stoppedBecause?: string;
}): VoiceResults {
  const rows = o.turns.map(turnRow);
  const ran = ranRows(rows);
  const overall = rateOf(ran);
  const byCategory: VoiceResults["aggregate"]["byCategory"] = {};
  for (const category of [...new Set(ran.map((row) => row.category))].sort())
    byCategory[category] = rateOf(
      ran.filter((row) => row.category === category),
    );
  const byTag: VoiceResults["aggregate"]["byTag"] = {};
  for (const tag of [...new Set(ran.flatMap((row) => row.tags))].sort())
    byTag[tag] = rateOf(ran.filter((row) => row.tags.includes(tag)));
  // Hands-free: passed with no confirmation and no click asked for.
  const handsFree = ran.filter(
    (row) =>
      row.pass && row.run.confirmations === 0 && row.subcode !== "NEED_CLICK",
  );
  const classes = failureClasses(rows, ran);
  const envNotReady = histogram(
    rows
      .filter((row) => row.code === "ENV_NOT_READY")
      .map((row) => row.subcode ?? "UNKNOWN"),
  );
  const providers = [
    ...new Set(
      ran.map((row) => row.run.providerModel).filter((x): x is string => !!x),
    ),
  ];
  const results: VoiceResults = {
    schema_version: 2,
    harnessVersion: HARNESS_VERSION,
    voiceSchema: VOICE_SCHEMA,
    kind: "voice",
    cycle: {
      ...o.plan,
      finishedAt: o.finishedAt,
      probeCommand: probeCommandFor(),
      matrix: (providers.length ? providers : ["app"]).map((model) => ({
        provider: "app",
        model,
      })),
      ...(o.stoppedBecause ? { stoppedBecause: o.stoppedBecause } : {}),
    },
    preflight: o.preflight,
    results: rows,
    aggregate: {
      ran: overall.ran,
      passed: overall.passed,
      passRate: overall.rate,
      wilson95: overall.wilson95,
      byCategory,
      byTag,
      handsFree: {
        rate: ran.length ? handsFree.length / ran.length : 0,
        wilson95: wilson(handsFree.length, ran.length),
      },
      latency: { p50: latencyStats(ran, 0.5), p95: latencyStats(ran, 0.95) },
    },
    failureClasses: classes,
    environment: {
      takeover: rows.filter((row) => row.code === "TAKEOVER").length,
      envNotReady,
      aborted: o.aborted ?? null,
    },
    gate: o.gate,
    previous: null,
    regressions: [],
    modelComparison: [],
  };
  if (o.previous && o.previous.cycle.suiteHash === o.plan.suiteHash)
    results.previous = {
      cycleId: o.previous.cycle.id,
      suiteHash: o.previous.cycle.suiteHash,
      classDelta: compareCycles(o.previous, results),
    };
  return results;
}

/**
 * The shape scripts/harness-loop.mjs and src/gym/loop.ts read: schema 2,
 * `cycle.id`, `cycle.gitRev` and `failureClasses`. The voice file is a
 * superset already; this only narrows the type.
 */
export function toCycleResults(results: VoiceResults): CycleResults {
  return results as unknown as CycleResults;
}

/* --------------------------------------------------------------- compare */

/** Per-class before/after at the same suite hash; small n reads inconclusive. */
export function compareCycles(
  prev: VoiceResults,
  cur: VoiceResults,
): Record<string, ClassDelta> {
  const out: Record<string, ClassDelta> = {};
  const n1 = ranRows(prev.results).length;
  const n2 = ranRows(cur.results).length;
  const count = (results: VoiceResults, code: string) =>
    results.failureClasses.find((c) => c.code === code)?.attempts ?? 0;
  const codes = new Set([
    ...prev.failureClasses.map((c) => c.code),
    ...cur.failureClasses.map((c) => c.code),
  ]);
  for (const code of codes) {
    if ((ENVIRONMENT_CODES as readonly string[]).includes(code)) continue;
    const k1 = count(prev, code);
    const k2 = count(cur, code);
    const before = { k: k1, n: n1, rate: n1 ? k1 / n1 : 0 };
    const after = { k: k2, n: n2, rate: n2 ? k2 / n2 : 0 };
    const test = twoProportionZ(k1, n1, k2, n2);
    let verdict: ClassDelta["verdict"] = "inconclusive";
    if (k1 === 0 && k2 > 0) verdict = "new";
    else if (k1 > 0 && k2 === 0 && n2 >= 12) verdict = "gone";
    else if (test.pDrop < 0.05) verdict = "improved";
    else if (test.pRise < 0.05) verdict = "regressed";
    const needed = powerN(before.rate, Math.max(0, before.rate - 0.1) || 0.01);
    out[code] = {
      before,
      after,
      verdict,
      p: Math.min(test.pDrop, test.pRise),
      neededAttempts: Number.isFinite(needed) ? needed : 0,
    };
  }
  return out;
}

/* ---------------------------------------------------------------- report */

const pct = (rate: number): string => `${(rate * 100).toFixed(1)}%`;
const interval = ([lo, hi]: [number, number]): string =>
  `[${pct(lo)}, ${pct(hi)}]`;
const ms = (v: number | null | undefined): string =>
  v === null || v === undefined ? "-" : `${Math.round(v)} ms`;
const small = (text: string, n: number): string =>
  n < 12 ? `*${text}*` : text;

export function renderReport(r: VoiceResults): string {
  const ran = ranRows(r.results);
  const lines: string[] = [];
  const quiet =
    r.preflight.quiet.source === "trace"
      ? `floor ${r.preflight.quiet.floor} / speech ${r.preflight.quiet.speech} / threshold ${r.preflight.quiet.threshold}`
      : "no trace";
  lines.push(
    `# Voice cycle ${r.cycle.id}`,
    "",
    `Revision ${r.cycle.gitRev}${r.cycle.dirty ? " (dirty)" : ""} on ${r.cycle.gitBranch}; app ${
      r.cycle.app
        ? `${r.cycle.app.version} (${r.cycle.app.build}), executable ${r.cycle.app.executableMtime}`
        : "unknown"
    }.`,
    `Voice ${r.cycle.voice} at ${r.cycle.rate} wpm, wake "${r.cycle.wake}", idle ${r.cycle.idleSeconds} s, noisy ${
      r.cycle.noisy ? "on" : "off"
    }, quiet ${quiet}, suite ${r.cycle.suiteHash.slice(0, 12)}.`,
    `${r.cycle.startedAt} to ${r.cycle.finishedAt}; gate waited ${r.gate.count} time(s), ${r.gate.totalSeconds} s in all.` +
      (r.cycle.stoppedBecause
        ? ` Stopped early: ${r.cycle.stoppedBecause}.`
        : ""),
    "",
    "## North star",
    "",
    `Hands-free success (passed with no confirmation and no click asked): **${pct(r.aggregate.handsFree.rate)}** ${interval(
      r.aggregate.handsFree.wilson95,
    )} of ${r.aggregate.ran} ran turn(s). Pass rate ${pct(r.aggregate.passRate)} ${interval(r.aggregate.wilson95)}.`,
    "",
    "| measure | p50 | p95 | target |",
    "| --- | --- | --- | --- |",
    `| first action after transcript | ${ms(r.aggregate.latency.p50.firstActionAfterTranscriptMs)} | ${ms(
      r.aggregate.latency.p95.firstActionAfterTranscriptMs,
    )} | ${LATENCY.firstActionTargetMs} ms |`,
    `| reply after transcript | ${ms(r.aggregate.latency.p50.replyAfterTranscriptMs)} | ${ms(
      r.aggregate.latency.p95.replyAfterTranscriptMs,
    )} | ${LATENCY.replyTargetMs} ms |`,
    `| wake after say start | ${ms(r.aggregate.latency.p50.wakeMs)} | ${ms(r.aggregate.latency.p95.wakeMs)} | ${
      LATENCY.wakeTargetMs
    } ms |`,
    `| endpoint after say end | ${ms(r.aggregate.latency.p50.endpointMs)} | ${ms(r.aggregate.latency.p95.endpointMs)} | ${
      LATENCY.endpointTargetMs
    } ms |`,
    `| capture total | ${ms(r.aggregate.latency.p50.captureTotal)} | ${ms(r.aggregate.latency.p95.captureTotal)} | ${
      LATENCY.captureTargetMs
    } ms |`,
    "",
    "## Pass rate by category and tag",
    "",
    "| facet | ran | passed | rate |",
    "| --- | --- | --- | --- |",
  );
  for (const [name, v] of Object.entries(r.aggregate.byCategory))
    lines.push(
      `| ${name} | ${v.ran} | ${v.passed} | ${small(`${pct(v.rate)} ${interval(v.wilson95)}`, v.ran)} |`,
    );
  for (const [name, v] of Object.entries(r.aggregate.byTag))
    lines.push(
      `| #${name} | ${v.ran} | ${v.passed} | ${small(`${pct(v.rate)} ${interval(v.wilson95)}`, v.ran)} |`,
    );
  lines.push("", "## Failure classes by count x cost", "");
  const app = r.failureClasses.filter(
    (c) => !(ENVIRONMENT_CODES as readonly string[]).includes(c.code),
  );
  if (!app.length) lines.push("None.");
  for (const c of app) {
    const code = c.code as FailureCode;
    const secondsLost = Math.round(
      r.results
        .filter((row) => row.code === c.code)
        .reduce((sum, row) => sum + row.wallMs, 0) / 1000,
    );
    const categories = Object.entries(c.byCategory)
      .filter(([, v]) => v.attempts > 0)
      .map(([name]) => name);
    lines.push(
      `${c.rank}. **${c.code}**${isSoft(c.code) ? " *(soft)*" : ""} — ${OWNER[code]}; ${c.attempts} turn(s), ${pct(
        c.attemptRate,
      )} ${interval(c.wilson95)}, weight ${COST_WEIGHT[code]}, ${secondsLost} s lost; categories ${
        categories.join(", ") || "-"
      }; examples ${c.examples.map((e) => e.runId).join(", ") || "-"}.`,
      `   ${c.note}`,
      `   Evidence: ${EVIDENCE[code].join("; ")}.`,
    );
  }
  const env = r.failureClasses.filter((c) =>
    (ENVIRONMENT_CODES as readonly string[]).includes(c.code),
  );
  lines.push("", "## Environment", "");
  if (!env.length && !r.environment.aborted)
    lines.push("Nothing: no takeover, every turn ready.");
  for (const c of env)
    lines.push(
      `- ${c.code}: ${c.attempts} turn(s) (${c.contributors.filter((x) => x.startsWith("subcode:")).join(", ") || "-"}).`,
    );
  if (r.environment.aborted)
    lines.push(
      `- Aborted on ${r.environment.aborted.code} at turn ${r.environment.aborted.turnId} (${r.environment.aborted.at}).`,
    );
  lines.push("", "## Against the previous cycle", "");
  if (!r.previous) lines.push("No earlier cycle at this suite hash.");
  else {
    lines.push(
      `Cycle ${r.previous.cycleId}, same suite hash.`,
      "",
      "| class | before | after | verdict |",
      "| --- | --- | --- | --- |",
    );
    for (const [code, d] of Object.entries(r.previous.classDelta))
      lines.push(
        `| ${code} | ${d.before.k}/${d.before.n} | ${d.after.k}/${d.after.n} | ${d.verdict}${
          d.verdict === "inconclusive" && d.neededAttempts
            ? ` (a 10-point change needs about ${d.neededAttempts} attempts)`
            : ""
        } |`,
      );
    lines.push(
      "",
      "At about 33 turns most verdicts are inconclusive; run --repeat 3 for a class to earn a lane.",
    );
  }
  lines.push(
    "",
    "## Turns",
    "",
    "| turn | heard | plan -> decided | terminal | act | conf | first action | reply | class |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const row of r.results)
    lines.push(
      `| ${row.turnId} | ${row.heard ? "yes" : row.misheard ? "misheard" : "no"} | ${row.plan ?? "-"} -> ${
        row.decided?.code ?? row.decided?.act ?? "-"
      } | ${row.run.terminal ?? "-"} | ${row.run.actions} | ${row.run.confirmations} | ${ms(
        row.latency.firstActionAfterTranscriptMs,
      )} | ${ms(row.latency.replyAfterTranscriptMs)} | ${row.pass ? "pass" : (row.code ?? "-")}${
        row.softCode ? ` +${row.softCode}` : ""
      } |`,
    );
  lines.push("", "## Gate", "");
  lines.push(
    `${r.gate.count} wait(s), ${r.gate.totalSeconds} s in all, longest ${r.gate.longestSeconds} s. By reason: ${
      Object.entries(r.gate.byReason)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ") || "-"
    }.`,
  );
  lines.push("", "## Preflight", "");
  lines.push(
    `Codes: ${r.preflight.codes.join(", ") || "none"}. Listening ${r.preflight.listening}; verbose ${
      r.preflight.verbose
    }; volume ${r.preflight.volume ?? "-"}; permissions ${
      r.preflight.permissions
        ? Object.entries(r.preflight.permissions)
            .map(([k, v]) => `${k}=${v}`)
            .join(" ")
        : "not recorded"
    }.`,
  );
  const skipped = Object.entries(r.preflight.skipped);
  if (skipped.length)
    lines.push(
      "",
      "Skipped:",
      ...skipped.map(
        ([id, code]) =>
          `- ${id}: ${code} (${SKIP_REMEDY[code] ?? "see docs/VOICE_LOOP.md"})`,
      ),
    );
  return lines.join("\n");
}

export const SKIP_REMEDY: Record<string, string> = {
  NOTES_AUTOMATION:
    "allow the terminal to control Notes when macOS asks, or run the loop from a terminal that already may",
  SHORTCUT_MISSING:
    'create a Shortcuts shortcut named "Butler Voice Loop: Focus Off" that turns Focus off',
};

/* ------------------------------------------------------------- the brief */

/** Floors a voice lane may add to and never subtract from. */
export const VOICE_FLOORS = [
  "src/core/policy.ts",
  "src/voice/turns.ts",
  "native/macos/WakePolicy.swift",
  "native/macos/TurnPolicy.swift",
];

/**
 * The voice brief for one class: the mechanism note, the evidence to open,
 * the example turns (resolvable by `voiceTurn` in the cycle's diagnostics
 * copy), the two rules and the probe. Content-free like laneBrief.
 */
export function fixBrief(cls: FailureClass, r: VoiceResults): string {
  const code = cls.code as FailureCode;
  const known = (FAILURE_CODES as readonly string[]).includes(cls.code);
  const ids = [...new Set(cls.examples.map((e) => e.taskId))];
  const probe = r.cycle.probeCommand
    .replace("<IDS>", ids.join(",") || "<IDS>")
    .replace(/<CODE>/g, cls.code.toLowerCase());
  return [
    `# Voice fix lane: ${cls.code}`,
    "",
    `Cycle ${r.cycle.id} at ${r.cycle.gitRev}; ${cls.attempts} of ${r.aggregate.ran} ran turn(s) (${pct(cls.attemptRate)} ${interval(
      cls.wilson95,
    )}). Fine owner: ${known ? OWNER[code] : cls.owner}. Fixed at or below ${pct(strictVoiceClass(cls.code) ? 0.05 : 0.1)} with the interval under it.`,
    "",
    `Mechanism: ${cls.note}`,
    "",
    "## Evidence to open",
    ...(known
      ? EVIDENCE[code].map((e) => `- ${e}`)
      : ["- the cycle's results.json row"]),
    `- Example turns: ${cls.examples.map((e) => e.runId).join(", ") || "-"} (grep \`voiceTurn\` in output/voice/${r.cycle.id}/diagnostics/current.jsonl; transcripts in the local turns.jsonl only).`,
    `- Categories hit: ${
      Object.entries(cls.byCategory)
        .filter(([, v]) => v.attempts > 0)
        .map(([name]) => name)
        .join(", ") || "-"
    }.`,
    "",
    "## Rules",
    `- A safety floor is never relaxed: ${VOICE_FLOORS.join(", ")} and the other FLOOR_PATHS may gain a rule, never lose one. A refusal that costs a class stays; the route must avoid the control or the owner accepts it.`,
    "- The loop never merges: leave the branch for review.",
    "- Content-free: never add a transcript, a reply or a screen to a test fixture.",
    "",
    "## Probe",
    `Rebuild and relaunch Butler.app yourself, then: ${probe}`,
    "Compare against this cycle at the same suite hash.",
  ].join("\n");
}
