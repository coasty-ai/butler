/**
 * Failure analysis over the local diagnostics stream.
 *
 * The log this reads can contain the user's real screen and speech: with
 * verbose diagnostics on it carries task text, summaries, window titles, URLs
 * and file paths. Nothing in this module ever copies that into its output. The
 * report is built only from counts, event types, application bundle ids, action
 * types, durations and fixed reason codes, and every value that reaches it
 * passes through one of the narrow readers below (`code`, `bundleId`, `count`).
 * Free-form text is read in exactly one place, `budgetCode`, which compares a
 * message against a fixed table and returns a code or nothing.
 */

export interface DiagnosticLine {
  timestamp?: string;
  event: string;
  data: Record<string, unknown>;
}

/** A short fixed code; anything else (a sentence, a number) is dropped. */
function code(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(value)
    ? value
    : undefined;
}
/** A bundle identifier; anything without the reverse-DNS shape is dropped. */
function bundleId(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(value) &&
    value.includes(".")
    ? value
    : undefined;
}
function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
/** An opaque correlation id, so a human can find the run in the log. */
function runIdOf(data: Record<string, unknown>): string | undefined {
  const value = data.runId;
  return typeof value === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      value,
    )
    ? value
    : undefined;
}

/**
 * The only place a message is looked at. It is compared against the runner's
 * fixed budget and policy messages and turned into a code; the text itself is
 * never stored, returned or printed. A log written without verbose diagnostics
 * has no message at all, and the caller falls back to structured events.
 */
export function budgetCode(message: unknown): string | undefined {
  if (typeof message !== "string") return undefined;
  const table: [string, string][] = [
    ["Action budget reached.", "ACTION_BUDGET"],
    ["Runtime budget reached.", "RUNTIME_BUDGET"],
    ["Estimated cost budget reached.", "COST_BUDGET"],
    ["Repeated policy violations.", "POLICY_VIOLATIONS"],
    ["Invalid usage accounting.", "USAGE_ACCOUNTING"],
  ];
  for (const [phrase, reason] of table) if (message === phrase) return reason;
  return undefined;
}

/** Parses a diagnostics JSONL file. Malformed lines are counted, not read. */
export function parseDiagnostics(text: string): {
  lines: DiagnosticLine[];
  skipped: number;
} {
  const lines: DiagnosticLine[] = [];
  let skipped = 0;
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        skipped++;
        continue;
      }
      const record = parsed as Record<string, unknown>;
      if (typeof record.event !== "string") {
        skipped++;
        continue;
      }
      lines.push({
        timestamp:
          typeof record.timestamp === "string" ? record.timestamp : undefined,
        event: record.event,
        data:
          record.data && typeof record.data === "object"
            ? (record.data as Record<string, unknown>)
            : {},
      });
    } catch {
      skipped++;
    }
  }
  return { lines, skipped };
}

/**
 * The friction codes one event contributes. Every branch reads structured,
 * allow-listed fields only.
 */
export function frictionCodes(line: DiagnosticLine): string[] {
  const d = line.data;
  switch (line.event) {
    case "ActionRetargetRequested": {
      const launcher = code(d.launcherStatus);
      const action = code(d.actionType);
      if (launcher === "resolved" && action === "open_app")
        return ["APP_ALREADY_FRONTMOST"];
      if (launcher === "unresolved") return ["APP_UNRESOLVED"];
      if (launcher === "ambiguous") return ["APP_AMBIGUOUS"];
      if (launcher === "refused") return ["APP_REFUSED"];
      // No target and no focused role: the surface reported no accessibility
      // information at all, so the policy had nothing to identify.
      if (!code(d.targetRole) && !code(d.focusedRole)) return ["BLIND_SURFACE"];
      return ["UNIDENTIFIED_TARGET"];
    }
    case "ActionFailed": {
      const failure = code(d.code);
      if (failure === "STATE_CHANGED") return ["SCREEN_CHANGED"];
      if (failure === "MALFORMED_RESPONSE") return ["MALFORMED_RESPONSE"];
      if (failure === "REFUSED") return ["MODEL_REFUSED"];
      return [failure ?? "ACTION_FAILED"];
    }
    case "ActionLoopDetected":
      return count(d.period) === 0 && code(d.actionType) === "open_app"
        ? ["APP_SWITCH_THRASH"]
        : ["ACTION_LOOP"];
    case "ActionInterrupted":
      return ["ACTION_INTERRUPTED"];
    // A recovery, not a failure: the runner re-aimed the same control itself.
    case "ActionReaimed":
      return ["ACTION_REAIMED"];
    case "PolicyConfirmationRequested":
      return ["APPROVAL_REQUESTED"];
    case "UserDenied":
      // A declined approval names who answered ("approval" in older journals,
      // now voice, pill, typed, message or remote); a policy denial carries
      // only the reason.
      return code(d.source) ? ["APPROVAL_DECLINED"] : ["POLICY_DENIED"];
    case "UserCorrectionRecorded":
      return ["USER_CORRECTION"];
    case "UserTakeoverStarted": {
      const source = code(d.source);
      if (source === "manual_input") return ["MANUAL_TAKEOVER"];
      // The default diagnostics allow-list does not carry this event's source,
      // so a bare hand-off event is ambiguous and says so. NativeUserTakeover
      // in the same run is what distinguishes real input from a hand-off.
      return source ? ["HANDOFF_TAKEOVER"] : ["TAKEOVER_STARTED"];
    }
    case "NativeUserTakeover":
      return ["MANUAL_INPUT_DETECTED"];
    case "NativeEmergencyStop":
      return ["EMERGENCY_STOP"];
    case "NativeUnavailable":
      return ["HELPER_UNAVAILABLE"];
    case "RunPaused":
      return ["RUN_PAUSED"];
    case "PlanAbandoned":
      return ["PLAN_ABANDONED"];
    case "NativeError": {
      const failure = code(d.code);
      const name = code(d.name);
      if (failure === "STATE_CHANGED") return ["SCREEN_CHANGED_NATIVE"];
      if (failure === "STOPPED") return ["NATIVE_STOPPED"];
      if (name === "HelperUnavailableError") return ["HELPER_UNAVAILABLE"];
      return ["NATIVE_ERROR"];
    }
    case "ProviderTransportError":
      return d.retryable === true
        ? ["PROVIDER_TRANSPORT_RETRYABLE"]
        : ["PROVIDER_TRANSPORT_FATAL"];
    case "ProviderRetry":
      return ["PROVIDER_RETRY"];
    case "ProviderMalformed":
      return ["MALFORMED_RESPONSE"];
    case "ProviderUnavailable":
      return ["PROVIDER_UNAVAILABLE"];
    case "ProviderFailed": {
      if (d.cancelled === true) return ["MODEL_CALL_ABORTED"];
      if (d.timedOut === true) return ["PROVIDER_TIMEOUT"];
      return code(d.name) === "ProviderTransientError"
        ? ["PROVIDER_TRANSIENT"]
        : ["PROVIDER_FAILED"];
    }
    default:
      return [];
  }
}

/** Bundle ids this event names, if any. */
function appsOf(line: DiagnosticLine): string[] {
  const ids = [
    bundleId(line.data.appId),
    bundleId(line.data.launchedAppId),
    bundleId(line.data.openedAppId),
  ];
  return ids.filter((id): id is string => !!id);
}

interface Occurrence {
  count: number;
  runs: Set<string>;
  apps: Map<string, number>;
  actionTypes: Map<string, number>;
  at?: string;
  atRun?: string;
}

export interface RunState {
  runId: string;
  /** The most recent application this run named, for events that name none. */
  lastApp?: string;
  firstAt?: string;
  lastAt?: string;
  statuses: { status: string; at?: string }[];
  outcome: string;
  ending?: string;
  endingAt?: string;
  apps: Set<string>;
  actionTypes: Set<string>;
  frictions: Map<string, number>;
  actions: number;
  cost: number;
  approvals: number;
  /** Fixed codes seen while the run was ending, newest last. */
  tail: { code: string; at?: string }[];
  budget?: string;
}

const TERMINAL = ["completed", "cancelled", "failed"];

export interface PatternRow {
  code: string;
  /** Times the pattern occurred across every run. */
  events: number;
  /** Runs it occurred in. */
  runs: number;
  /** Runs it ended (run-ending rows only). */
  endedRuns?: number;
  apps: string[];
  actionTypes: string[];
  /** A timestamp and run id so a human can find it in the log. */
  at?: string;
  atRun?: string;
}

export interface AnalysisReport {
  files: number;
  lines: number;
  skipped: number;
  ignored: number;
  window: { from?: string; to?: string };
  runs: {
    total: number;
    byOutcome: Record<string, number>;
    medianActions: number;
    medianCost: number;
  };
  durations: {
    medianModelCallMs: number;
    medianCaptureMs: number;
    medianExecuteMs: number;
  };
  endings: PatternRow[];
  frictions: PatternRow[];
  fixNext: {
    rank: number;
    code: string;
    endedRuns: number;
    /** Occurrences of a friction pattern with the same name, if any. */
    events: number;
    owner: string;
    /** The friction patterns most common inside the runs that ended this way. */
    contributors: string[];
    note: string;
  }[];
}

function occurrence(map: Map<string, Occurrence>, key: string): Occurrence {
  let entry = map.get(key);
  if (!entry) {
    entry = {
      count: 0,
      runs: new Set(),
      apps: new Map(),
      actionTypes: new Map(),
    };
    map.set(key, entry);
  }
  return entry;
}

function bump(map: Map<string, number>, key: string | undefined): void {
  if (key) map.set(key, (map.get(key) ?? 0) + 1);
}

function top(map: Map<string, number>, limit = 4): string[] {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, value]) => `${key} ${value}`);
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Who can fix a pattern, which is what makes the ranking actionable. */
const OWNER: Record<string, string> = {
  COMPLETED: "none",
  USER_CANCELLED: "user",
  STOPPED_AFTER_MANUAL_TAKEOVER: "user",
  MANUAL_TAKEOVER: "user",
  MANUAL_INPUT_DETECTED: "user",
  EMERGENCY_STOP: "user",
  APPROVAL_DECLINED: "user",
  ACTION_REAIMED: "none",
  HELPER_UNAVAILABLE: "environment",
  NATIVE_ERROR: "environment",
  PROVIDER_FAILED: "environment",
  PROVIDER_TIMEOUT: "environment",
  PROVIDER_TRANSIENT: "environment",
  PROVIDER_TRANSPORT_RETRYABLE: "environment",
  PROVIDER_TRANSPORT_FATAL: "environment",
  PROVIDER_UNAVAILABLE: "environment",
};
/** Authored one-line explanations. None of this comes from the log. */
const NOTE: Record<string, string> = {
  ACTION_BUDGET: "The run used its whole action budget without finishing.",
  RUNTIME_BUDGET: "The run used its whole time budget without finishing.",
  COST_BUDGET: "The run used its whole cost budget without finishing.",
  POLICY_VIOLATIONS: "Too many proposed steps the policy would not allow.",
  HANDOFF_TAKEOVER:
    "The agent gave up and asked the user to act, usually after repeated unidentified targets.",
  TAKEOVER_STARTED:
    "The run handed control to the user. The log does not record whether real input or the agent caused it; a MANUAL_INPUT_DETECTED event in the same run means real input.",
  STOPPED_AFTER_HANDOFF:
    "The run was stopped while it was waiting for the user after a hand-off.",
  STOPPED_AFTER_MANUAL_TAKEOVER:
    "Real input on this Mac paused the run and it was then stopped.",
  STOPPED_WHILE_PAUSED: "The run was stopped while paused.",
  USER_CANCELLED: "The user stopped the run.",
  LEFT_IN_TAKEOVER:
    "The run was still waiting for the user when the log ended.",
  LEFT_PAUSED: "The run was still paused when the log ended.",
  LEFT_AWAITING_APPROVAL:
    "The run was still waiting for an approval when the log ended.",
  NOT_SETTLED: "The run never reached a terminal state in this log.",
  RUN_ERROR: "The run threw an error with no more specific code.",
  EMERGENCY_STOP: "The native emergency stop was triggered.",
  HELPER_UNAVAILABLE: "The native helper exited or stopped responding.",
  PROVIDER_FAILED: "The model call failed after its retries.",
  SCREEN_CHANGED:
    "The screen changed between the screenshot and the input, so the step was rejected.",
  SCREEN_CHANGED_NATIVE:
    "The native helper rejected input because the target moved or the window changed.",
  UNIDENTIFIED_TARGET:
    "The policy could not identify what the pointer would hit, so no input was sent.",
  BLIND_SURFACE:
    "The frontmost application reported no accessibility information, so every pointer step was refused.",
  APP_ALREADY_FRONTMOST:
    "open_app was proposed for the application that was already frontmost.",
  APP_UNRESOLVED: "No installed application matched the requested name.",
  APP_AMBIGUOUS: "Several installed applications matched the requested name.",
  APP_REFUSED: "The launch rules refused that application.",
  ACTION_LOOP: "The same short sequence of actions repeated.",
  APP_SWITCH_THRASH:
    "The run bounced between applications without reading them.",
  INVALID_ACTION: "The model returned an action the schema rejected.",
  MALFORMED_RESPONSE: "The model reply did not contain one usable action.",
  MODEL_REFUSED: "The model declined the step.",
  APPROVAL_REQUESTED: "The policy asked the user to approve a step.",
  APPROVAL_DECLINED: "An approval was declined.",
  POLICY_DENIED: "The policy denied a step outright.",
  MANUAL_TAKEOVER: "Real input on this Mac took the run over.",
  MANUAL_INPUT_DETECTED: "The native helper saw real mouse or key input.",
  RUN_PAUSED: "The run paused and waited for the user.",
  PLAN_ABANDONED: "A replayed memory plan was abandoned mid-way.",
  NATIVE_STOPPED: "Input was attempted while the native stop latch was set.",
  NATIVE_ERROR: "The native helper returned an error.",
  MODEL_CALL_ABORTED:
    "A model call was aborted, normally because the run stopped.",
  PROVIDER_TRANSIENT: "The provider failed transiently and the run paused.",
  PROVIDER_TIMEOUT: "A model call hit its deadline.",
  PROVIDER_RETRY: "A model call was retried.",
  PROVIDER_TRANSPORT_RETRYABLE:
    "A recoverable connection failure to the provider.",
  PROVIDER_TRANSPORT_FATAL:
    "An unrecoverable connection failure to the provider.",
  PROVIDER_UNAVAILABLE: "The provider was unavailable and the run paused.",
  ACTION_INTERRUPTED: "A step was interrupted while it was executing.",
  ACTION_REAIMED:
    "The screen moved after the screenshot and the app re-aimed the same control by itself, saving a model call.",
  USER_CORRECTION: "The user corrected the run while it was running.",
  ACTION_FAILED: "A step failed with a code this analyzer does not name yet.",
  UNCLASSIFIED: "The run ended without a recognizable reason in the log.",
};

/** Classifies why one run ended, from its statuses and its tail of events. */
export function endingCode(run: RunState): string {
  if (run.outcome === "completed") return "COMPLETED";
  const has = (pattern: string) => run.frictions.has(pattern);
  if (run.outcome === "failed") {
    if (run.budget) return run.budget;
    if (has("EMERGENCY_STOP")) return "EMERGENCY_STOP";
    const tail = run.tail.map((entry) => entry.code);
    for (const entry of tail.slice(-6).reverse()) {
      if (entry === "HELPER_UNAVAILABLE") return "HELPER_UNAVAILABLE";
      if (entry === "PROVIDER_FAILED" || entry === "PROVIDER_TIMEOUT")
        return entry;
    }
    return "RUN_ERROR";
  }
  if (run.outcome === "cancelled") {
    if (has("EMERGENCY_STOP")) return "EMERGENCY_STOP";
    if (has("MANUAL_TAKEOVER") || has("MANUAL_INPUT_DETECTED"))
      return "STOPPED_AFTER_MANUAL_TAKEOVER";
    if (has("HANDOFF_TAKEOVER") || has("TAKEOVER_STARTED"))
      return "STOPPED_AFTER_HANDOFF";
    if (has("RUN_PAUSED")) return "STOPPED_WHILE_PAUSED";
    return "USER_CANCELLED";
  }
  const last = run.statuses.at(-1)?.status;
  if (last === "takeover") return "LEFT_IN_TAKEOVER";
  if (last === "paused") return "LEFT_PAUSED";
  if (last === "confirming") return "LEFT_AWAITING_APPROVAL";
  return "NOT_SETTLED";
}

export interface AnalyzeOptions {
  /** ISO timestamp; lines before it are ignored. */
  since?: string;
  files?: number;
  /** Malformed lines the parser could not read. */
  skipped?: number;
}

export function analyze(
  lines: DiagnosticLine[],
  options: AnalyzeOptions = {},
): AnalysisReport {
  const since = options.since;
  const runs = new Map<string, RunState>();
  const frictions = new Map<string, Occurrence>();
  const endings = new Map<string, Occurrence>();
  const modelCallMs: number[] = [];
  const captureMs: number[] = [];
  const executeMs: number[] = [];
  let ignored = 0;
  let from: string | undefined;
  let to: string | undefined;
  for (const line of lines) {
    if (since && line.timestamp && line.timestamp < since) {
      ignored++;
      continue;
    }
    if (line.timestamp) {
      if (!from || line.timestamp < from) from = line.timestamp;
      if (!to || line.timestamp > to) to = line.timestamp;
    }
    // Native and provider timings are useful even outside a run.
    if (line.event === "NativeResponse") {
      const ms = count(line.data.durationMs);
      const method = code(line.data.method);
      if (ms !== undefined && method === "capture") captureMs.push(ms);
      if (ms !== undefined && method === "execute") executeMs.push(ms);
    }
    if (line.event === "ProviderResponse") {
      const ms = count(line.data.durationMs);
      if (ms !== undefined) modelCallMs.push(ms);
    }
    const runId = runIdOf(line.data);
    if (!runId) {
      ignored++;
      continue;
    }
    let run = runs.get(runId);
    if (!run) {
      run = {
        runId,
        firstAt: line.timestamp,
        statuses: [],
        outcome: "unsettled",
        apps: new Set(),
        actionTypes: new Set(),
        frictions: new Map(),
        actions: 0,
        cost: 0,
        approvals: 0,
        tail: [],
      };
      runs.set(runId, run);
    }
    run.lastAt = line.timestamp ?? run.lastAt;
    const named = appsOf(line);
    for (const app of named) run.apps.add(app);
    if (named.length) run.lastApp = named[0];
    const actionType = code(line.data.actionType);
    if (actionType) run.actionTypes.add(actionType);
    if (line.event === "RunState") {
      const status = code(line.data.status);
      if (status) {
        run.statuses.push({ status, at: line.timestamp });
        if (TERMINAL.includes(status)) run.outcome = status;
        if (status === "failed" && !run.budget)
          run.budget =
            budgetCode(line.data.message) ?? budgetCode(line.data.error);
      }
      run.actions = count(line.data.actions) ?? run.actions;
      const usage = line.data.usage;
      if (usage && typeof usage === "object")
        run.cost = count((usage as Record<string, unknown>).cost) ?? run.cost;
      continue;
    }
    for (const friction of frictionCodes(line)) {
      run.frictions.set(friction, (run.frictions.get(friction) ?? 0) + 1);
      run.tail.push({ code: friction, at: line.timestamp });
      if (run.tail.length > 24) run.tail.shift();
      const entry = occurrence(frictions, friction);
      entry.count++;
      entry.runs.add(runId);
      // Many events carry no bundle id; the run's most recent one is the
      // application the step was aimed at, which is what a reader needs.
      for (const app of named.length ? named : run.lastApp ? [run.lastApp] : [])
        bump(entry.apps, app);
      bump(entry.actionTypes, actionType);
      if (!entry.at) {
        entry.at = line.timestamp;
        entry.atRun = runId;
      }
      if (friction === "APPROVAL_REQUESTED") run.approvals++;
    }
  }
  const byOutcome: Record<string, number> = {};
  for (const run of runs.values()) {
    byOutcome[run.outcome] = (byOutcome[run.outcome] ?? 0) + 1;
    run.ending = endingCode(run);
    run.endingAt = run.statuses.at(-1)?.at ?? run.lastAt;
    const entry = occurrence(endings, run.ending);
    entry.count++;
    entry.runs.add(run.runId);
    for (const app of run.apps) bump(entry.apps, app);
    for (const type of run.actionTypes) bump(entry.actionTypes, type);
    if (!entry.at) {
      entry.at = run.endingAt;
      entry.atRun = run.runId;
    }
  }
  const rows = (map: Map<string, Occurrence>, ending: boolean): PatternRow[] =>
    [...map.entries()]
      .map(([key, entry]) => ({
        code: key,
        events: entry.count,
        runs: entry.runs.size,
        ...(ending ? { endedRuns: entry.count } : {}),
        apps: top(entry.apps),
        actionTypes: top(entry.actionTypes),
        at: entry.at,
        atRun: entry.atRun,
      }))
      .sort((a, b) => b.events - a.events || (a.code < b.code ? -1 : 1));
  const endingRows = rows(endings, true);
  const fixNext = endingRows
    .filter((row) => row.code !== "COMPLETED")
    .map((row, index) => {
      const inside = new Map<string, number>();
      for (const run of runs.values()) {
        if (run.ending !== row.code) continue;
        for (const [pattern, seen] of run.frictions)
          if (pattern !== row.code)
            inside.set(pattern, (inside.get(pattern) ?? 0) + seen);
      }
      return {
        rank: index + 1,
        code: row.code,
        endedRuns: row.endedRuns ?? row.runs,
        events: frictions.get(row.code)?.count ?? 0,
        owner: OWNER[row.code] ?? "agent",
        contributors: top(inside, 3),
        note: NOTE[row.code] ?? NOTE.UNCLASSIFIED,
      };
    });
  const runList = [...runs.values()];
  return {
    files: options.files ?? 1,
    lines: lines.length,
    skipped: options.skipped ?? 0,
    ignored,
    window: { from, to },
    runs: {
      total: runList.length,
      byOutcome,
      medianActions: median(runList.map((run) => run.actions)),
      medianCost: median(runList.map((run) => run.cost)),
    },
    durations: {
      medianModelCallMs: median(modelCallMs),
      medianCaptureMs: median(captureMs),
      medianExecuteMs: median(executeMs),
    },
    endings: endingRows,
    frictions: rows(frictions, false),
    fixNext,
  };
}

const pad = (value: string, width: number, right = false) =>
  right ? value.padStart(width) : value.padEnd(width);

function table(header: string[], rows: string[][]): string {
  const widths = header.map((name, column) =>
    Math.max(name.length, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, column) => pad(cell ?? "", widths[column]))
      .join("  ")
      .trimEnd();
  return [
    line(header),
    line(widths.map((width) => "-".repeat(width))),
    ...rows.map(line),
  ].join("\n");
}

/** Renders the report. Every value printed here is a count, code or timestamp. */
export function renderAnalysis(report: AnalysisReport): string {
  const out: string[] = [];
  out.push(
    `Open Assist run analysis: ${report.runs.total} runs over ${report.lines} events from ${report.files} file(s).`,
  );
  if (report.window.from)
    out.push(`window ${report.window.from} .. ${report.window.to}`);
  out.push(
    "outcomes  " +
      Object.entries(report.runs.byOutcome)
        .sort((a, b) => b[1] - a[1])
        .map(([outcome, runs]) => `${outcome} ${runs}`)
        .join("  "),
  );
  out.push(
    `median actions per run ${report.runs.medianActions}  median cost per run $${report.runs.medianCost.toFixed(3)}`,
  );
  out.push(
    `median model call ${Math.round(report.durations.medianModelCallMs)} ms  capture ${Math.round(report.durations.medianCaptureMs)} ms  execute ${Math.round(report.durations.medianExecuteMs)} ms`,
  );
  out.push("");
  out.push("How runs ended");
  out.push(
    table(
      ["reason", "runs", "apps", "action types", "first seen", "run id"],
      report.endings.map((row) => [
        row.code,
        String(row.runs),
        row.apps.join(", "),
        row.actionTypes.join(", "),
        row.at ?? "",
        row.atRun ?? "",
      ]),
    ),
  );
  out.push("");
  out.push("Friction inside runs");
  out.push(
    table(
      [
        "pattern",
        "events",
        "runs",
        "apps",
        "action types",
        "first seen",
        "run id",
      ],
      report.frictions.map((row) => [
        row.code,
        String(row.events),
        String(row.runs),
        row.apps.join(", "),
        row.actionTypes.join(", "),
        row.at ?? "",
        row.atRun ?? "",
      ]),
    ),
  );
  const reaimed = report.frictions.find((row) => row.code === "ACTION_REAIMED");
  if (reaimed)
    out.push(
      `\nrecovered without a model call: ACTION_REAIMED ${reaimed.events} in ${reaimed.runs} run(s)`,
    );
  out.push("");
  out.push("What to fix next (ranked by how often the pattern ended a run)");
  for (const item of report.fixNext) {
    out.push(
      `${item.rank}. ${item.code} - ended ${item.endedRuns} run(s)` +
        (item.events ? `, ${item.events} event(s)` : "") +
        `, owner: ${item.owner}`,
    );
    out.push(`   ${item.note}`);
    if (item.contributors.length)
      out.push(`   inside those runs: ${item.contributors.join(", ")}`);
  }
  return out.join("\n");
}
