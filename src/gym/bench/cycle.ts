import { createHash } from "node:crypto";
import type { ProviderKind, Settings } from "../../core/schema";
import type { GateWaits } from "./cycle-report";
import {
  gateDecision,
  gatePassed,
  type GateReport,
  type GateState,
} from "./presence";
import { TASK_SKIPS, type AttemptResult } from "./report";
import type { BenchTask } from "./types";

/**
 * The plan of a cycle and the arithmetic around it: which cells run which
 * tasks in what order, how a plan is sharded across nights, what an attempt
 * may spend, how long the plan should take, and how a ledger resumes it.
 * Pure: the CLI does the file and process work.
 */

/** One provider:model pair the matrix names. */
export interface Cell {
  provider: ProviderKind;
  model: string;
  /** `${provider}:${model}` */
  cell: string;
}

const CLOUD: ProviderKind[] = ["openai", "anthropic", "google"];

/**
 * Parses `--matrix openai:gpt-5.4-mini,google,anthropic:claude-sonnet-5`. A
 * bare provider takes the catalog default. Only cloud providers with a key
 * import path are accepted, like bench.
 */
export function parseMatrix(
  text: string | undefined,
  defaults: Record<string, string>,
): { cells: Cell[]; unknown: string[] } {
  const cells: Cell[] = [];
  const unknown: string[] = [];
  const parts = (text ?? "openai")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  for (const part of parts) {
    const [provider, ...rest] = part.split(":");
    const model = rest.join(":").trim() || defaults[provider] || "";
    if (!CLOUD.includes(provider as ProviderKind) || !model) {
      unknown.push(part);
      continue;
    }
    const cell = `${provider}:${model}`;
    if (!cells.some((known) => known.cell === cell))
      cells.push({ provider: provider as ProviderKind, model, cell });
  }
  return { cells, unknown };
}

/** Dollars per million tokens, as Settings carries them. */
export interface Prices {
  inputPrice: number;
  outputPrice: number;
}

/** The provider catalog, as far as pricing a cell goes (src/providers/catalog.ts). */
export interface PriceCatalog {
  providerDefaults: Record<string, Prices & { model: string }>;
  /** Per-model rates, where the catalog carries them. */
  modelPrice?: (provider: ProviderKind, model: string) => Prices | undefined;
}

const priced = (prices: Prices | undefined): Prices | undefined =>
  prices && prices.inputPrice > 0 && prices.outputPrice > 0
    ? { inputPrice: prices.inputPrice, outputPrice: prices.outputPrice }
    : undefined;

/**
 * A cell's own token rates, or undefined when the catalog has none. Never the
 * provider default's rates for another model: every cost cap (the runner's
 * per-attempt budget, --max-cost-run, --max-cost-model, --max-cost) is checked
 * against this estimate, so a model charged at a cheaper model's rates would
 * spend several times every cap. A cell without rates is refused.
 */
export function cellPrices(
  cell: Pick<Cell, "provider" | "model">,
  catalog: PriceCatalog,
): Prices | undefined {
  const listed = priced(catalog.modelPrice?.(cell.provider, cell.model));
  if (listed) return listed;
  const fallback = catalog.providerDefaults[cell.provider];
  return fallback?.model === cell.model ? priced(fallback) : undefined;
}

/** A cell's settings: the provider's, with the cell's own model and rates. */
export function cellSettings<S extends Prices & { model: string }>(
  selected: S,
  cell: Pick<Cell, "model">,
  prices: Prices,
): S {
  return {
    ...selected,
    model: cell.model,
    inputPrice: prices.inputPrice,
    outputPrice: prices.outputPrice,
  };
}

/** The Settings pane's Autonomy choices, as `--autonomy` takes them. */
export const AUTONOMY_MODES = ["ask", "task", "flow", "all"] as const;
export type Autonomy = Settings["autonomy"];
/** What every cycle ran under before the flag existed: the schema's default. */
export const DEFAULT_AUTONOMY: Autonomy = "task";

/** `--autonomy <mode>`: the mode, or undefined for anything else. */
export function parseAutonomy(text: string | undefined): Autonomy | undefined {
  return (AUTONOMY_MODES as readonly string[]).includes(text ?? "")
    ? (text as Autonomy)
    : undefined;
}

/**
 * The two settings fields one `--autonomy` value sets, as the Settings pane
 * sets them (settings-voice.tsx autonomyChange): "all" carries the
 * acknowledgement the owner ticks beside "allow everything", without which
 * the policy treats "all" as "flow"; every other mode drops it.
 */
export function autonomySettings(
  autonomy: Autonomy,
): Pick<Settings, "autonomy" | "autonomyAllAcknowledged"> {
  return { autonomy, autonomyAllAcknowledged: autonomy === "all" };
}

/**
 * The regime a cycle's stored flags (plan.json, results.json `cycle.flags`)
 * say it ran under. A cycle from before the flag recorded none and ran the
 * default, so it reads as "task"; so does a value this build does not know.
 */
export function autonomyOf(flags: { autonomy?: string } | undefined): Autonomy {
  return parseAutonomy(flags?.autonomy) ?? DEFAULT_AUTONOMY;
}

export interface PlanEntry {
  /** Position in the full plan, 0-based and stable across shards and resumes. */
  index: number;
  cell: string;
  taskId: string;
  /** 1-based repeat. */
  attempt: number;
}

/** A small deterministic PRNG (mulberry32) so a seeded plan is reproducible. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A 32-bit seed from any string (FNV-1a), for `--seed` defaults. */
export function seedOf(text: string): number {
  let hash = 0x811c9dc5;
  for (const char of text) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function shuffled<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * The interleaving. Every round shuffles the tasks (seeded, so the plan is
 * reproducible and no task is always first after the idle warm-up); every
 * task then runs on every model back to back, so the models meet the same
 * task under the same desktop drift within minutes of each other.
 *
 * The model that goes first advances by one task to task, except with two
 * models where it stays put: with two models any per-task rotation puts the
 * same model on both sides of a task boundary (A B | B A), and the property
 * that matters for a fair desktop, no model twice in a row, wins over
 * rotating who goes first. The counter runs across rounds for the same
 * reason: resetting it per round would collide at the round boundary.
 */
export function buildPlan(
  cells: string[],
  taskIds: string[],
  repeat: number,
  seed: number,
): PlanEntry[] {
  const plan: PlanEntry[] = [];
  const models = cells.length;
  if (!models || !taskIds.length) return plan;
  const random = seeded(seed);
  const step = models === 2 ? 0 : 1;
  let taskCounter = 0;
  for (let attempt = 1; attempt <= repeat; attempt++) {
    const order = shuffled(taskIds, random);
    for (const taskId of order) {
      const start = (taskCounter * step) % models;
      for (let k = 0; k < models; k++)
        plan.push({
          index: plan.length,
          cell: cells[(start + k) % models],
          taskId,
          attempt,
        });
      taskCounter++;
    }
  }
  return plan;
}

/** `--shard i/n`, 1-based i. */
export function parseShard(
  text: string | undefined,
): { index: number; count: number } | undefined | "invalid" {
  if (!text) return undefined;
  const match = /^(\d+)\/(\d+)$/.exec(text.trim());
  if (!match) return "invalid";
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (count < 1 || index < 1 || index > count) return "invalid";
  return { index, count };
}

/**
 * The slice of a plan one shard runs; indexes stay those of the full plan.
 * A plan is cut between (task, repeat) groups, never inside one: every model
 * of a task runs the same night, so the within-cycle model comparison still
 * has its pairs. Cutting by entry would send each model of a task to a
 * different night, and with as many shards as models a night would run one
 * model only.
 */
export function shardOf(
  plan: PlanEntry[],
  shard: { index: number; count: number } | undefined,
): PlanEntry[] {
  if (!shard) return plan;
  const groups = new Map<string, number>();
  return plan.filter((entry) => {
    const key = `${entry.attempt}|${entry.taskId}`;
    if (!groups.has(key)) groups.set(key, groups.size);
    return groups.get(key)! % shard.count === shard.index - 1;
  });
}

/** What a plan is made of; a resume refuses a ledger written for another. */
export function planHash(input: {
  matrix: string[];
  taskIds: string[];
  repeat: number;
  seed: number;
  shard?: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        matrix: input.matrix,
        taskIds: input.taskIds,
        repeat: input.repeat,
        seed: input.seed,
        shard: input.shard ?? null,
      }),
    )
    .digest("hex");
}

/**
 * Which attempts a plan holds, whatever their order: two cycles with the
 * same design run the same (cell, task, repeat) keys, so they can be paired.
 * The seed only orders a whole plan and is left out; a shard's seed decides
 * which tasks it holds, so it stays in.
 */
export function designHash(input: {
  matrix: string[];
  taskIds: string[];
  repeat: number;
  seed: number;
  shard?: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        matrix: [...input.matrix].sort(),
        taskIds: [...input.taskIds].sort(),
        repeat: input.repeat,
        shard: input.shard ?? null,
        seed: input.shard ? input.seed : null,
      }),
    )
    .digest("hex");
}

/* ------------------------------------------------------------------ caps */

export interface CapInput {
  taskMaxCost: number;
  /** --max-cost-run */
  runCap: number;
  cycleRemaining: number;
  modelRemaining: number;
}

/**
 * What one attempt may spend, or why it is skipped. A starved attempt is not
 * run: a run given a tenth of its task's cap ends in COST_BUDGET, which is
 * the harness's doing, not the model's. Half of the intended cap is the
 * floor; below it the attempt is recorded as BUDGET_EXHAUSTED.
 */
export function attemptCap(
  input: CapInput,
): { maxCost: number } | { skip: "BUDGET_EXHAUSTED" } {
  const intended = Math.min(input.taskMaxCost, input.runCap);
  const allowed = Math.min(
    intended,
    input.cycleRemaining,
    input.modelRemaining,
  );
  if (allowed < 0.5 * intended || allowed < 0.01)
    return { skip: "BUDGET_EXHAUSTED" };
  return { maxCost: Math.min(50, Math.max(0.01, allowed)) };
}

/** Money spent so far, in total and by cell. */
export function spent(results: Pick<AttemptResult, "cell" | "cost">[]): {
  total: number;
  byCell: Record<string, number>;
} {
  const byCell: Record<string, number> = {};
  let total = 0;
  for (const result of results) {
    total += result.cost;
    byCell[result.cell] = (byCell[result.cell] ?? 0) + result.cost;
  }
  return { total, byCell };
}

/** The most a plan can spend: per attempt min(task cap, run cap), summed. */
export function ceiling(
  plan: PlanEntry[],
  tasks: Map<string, Pick<BenchTask, "maxCost">>,
  runCap: number,
): { total: number; byCell: Record<string, number> } {
  const byCell: Record<string, number> = {};
  let total = 0;
  for (const entry of plan) {
    const cap = Math.min(tasks.get(entry.taskId)?.maxCost ?? 0, runCap);
    total += cap;
    byCell[entry.cell] = (byCell[entry.cell] ?? 0) + cap;
  }
  return { total, byCell };
}

/* ------------------------------------------------------------------ time */

/** `4h`, `90m`, `300s` or a bare number of seconds. */
export function parseDuration(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const match = /^(\d+(?:\.\d+)?)\s*([hms]?)$/i.exec(text.trim());
  if (!match) return undefined;
  const value = Number(match[1]);
  const unit = { h: 3600, m: 60, s: 1, "": 1 }[match[2].toLowerCase()] ?? 1;
  return Math.round(value * unit);
}

/** Seconds of harness work around every attempt: neutral start, prepare, grading reads, cleanup. */
export const ATTEMPT_OVERHEAD_SECONDS = 20;

/**
 * How long the plan should take. With a baseline, twice its median per task
 * (bounded by the task's own budget); without one, the measured pace of
 * about three seconds per step. Plus the fixed overhead and the cooldown.
 */
export function estimateSeconds(
  plan: PlanEntry[],
  tasks: Map<string, Pick<BenchTask, "maxSeconds" | "maxActions">>,
  cooldownSeconds: number,
  medians: Record<string, number> = {},
): number {
  let total = 0;
  for (const entry of plan) {
    const task = tasks.get(entry.taskId);
    if (!task) continue;
    const median = medians[entry.taskId];
    const expected =
      median !== undefined
        ? Math.min(task.maxSeconds, 2 * median)
        : Math.min(task.maxSeconds, 3 * task.maxActions);
    total += expected + ATTEMPT_OVERHEAD_SECONDS + cooldownSeconds;
  }
  return total;
}

/** A plan must fit 80% of its time box, gate waits included. */
export function fitsTimeBox(estimate: number, timeBoxSeconds: number): boolean {
  return estimate <= 0.8 * timeBoxSeconds;
}

/**
 * The fewest nights a plan needs: the smallest n for which every shard i/n
 * fits the box, or undefined when even a night per (task, repeat) group
 * would not (one group alone outlasts the box). Every night must run the
 * same seed, or the shards would slice different plans.
 */
export function shardsNeeded(
  plan: PlanEntry[],
  tasks: Map<string, Pick<BenchTask, "maxSeconds" | "maxActions">>,
  cooldownSeconds: number,
  timeBoxSeconds: number,
  medians: Record<string, number> = {},
): number | undefined {
  const groups = new Set(plan.map((e) => `${e.attempt}|${e.taskId}`)).size;
  for (let count = 1; count <= groups; count++) {
    let fits = true;
    for (let index = 1; fits && index <= count; index++)
      fits = fitsTimeBox(
        estimateSeconds(
          shardOf(plan, { index, count }),
          tasks,
          cooldownSeconds,
          medians,
        ),
        timeBoxSeconds,
      );
    if (fits) return count;
  }
  return undefined;
}

/* ---------------------------------------------------------------- ledger */

export type LedgerLine =
  | {
      kind: "start";
      at: string;
      cycle: string;
      planHash: string;
      gitRev: string;
    }
  | {
      kind: "gate";
      at: string;
      /** The reason that held the attempt last. */
      reason: string;
      /** Every reason seen during the wait. */
      reasons?: string[];
      waitedSeconds: number;
      /** The wait passed --idle x 12 with someone at the Mac. */
      userPresentLong?: boolean;
      /** SECURE_INPUT: the bundle id of the application holding secure event input, when it could be told. */
      secureInputOwner?: string;
      /** SECURE_INPUT: fixture tabs the harness pointed at about:blank in its own browser before waiting on (the remedy). */
      browserReset?: number;
      /**
       * The harness asked its own browser to quit at this gate (the
       * escalation): true when its process had gone, false when it was
       * asked and still ran (or a sheet with no dismissive button kept the
       * quit from being sent). For SECURE_INPUT, the next read after the
       * reset still named that browser; for a bench-leftover browser
       * (browserQuitReason), the gate passed with an earlier cycle's browser
       * still running. Absent when no quit was asked.
       */
      browserQuit?: boolean;
      /**
       * LEFTOVER: the quit was of a browser an earlier cycle left, with only
       * blank, start-page or fixture tabs and no input of the person's
       * since it launched (browser-reset.ts benchLeftover), asked when the
       * gate passed. SHEET_UP: the quit was refused for a sheet the harness
       * would not dismiss (SHEET_UP on the earlier poll), and one poll later,
       * the same browser still holding the keyboard, the harness ended its
       * own browser's process itself (browser-reset.ts terminateBrowser;
       * browserQuitCode TERMINATED or KILLED, or STILL_RUNNING when even that
       * did not end it). Absent for a SECURE_INPUT quit by Apple Event, which
       * the line's reason already names. A line with LEFTOVER and
       * `reasons: []` records a quit at a gate that passed at once: it is no
       * wait (gateWaitsOf).
       */
      browserQuitReason?: "LEFTOVER" | "SHEET_UP";
      /**
       * The last quit's code (browser-reset.ts BrowserQuit.code: SHEET_UP,
       * STILL_RUNNING, TERMINATED, KILLED, UNREAD ...). Absent when the
       * browser went on the Apple Event, or the hook answered a bare flag.
       */
      browserQuitCode?: string;
    }
  | ({ kind: "attempt"; at: string } & AttemptResult)
  | { kind: "requeue"; at: string; planIndex: number; requeued: number }
  | { kind: "stop"; at: string; because?: string };

/** Parses a ledger; malformed lines are dropped, never read. */
export function parseLedger(text: string): LedgerLine[] {
  const lines: LedgerLine[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof (parsed as { kind?: unknown }).kind === "string"
      )
        lines.push(parsed as LedgerLine);
    } catch {
      // A torn last line from an interruption: the attempt it described is
      // re-run, which is the safe direction.
    }
  }
  return lines;
}

/**
 * A row that is not the model's result: a stop kept the attempt from
 * starting or cut its run short (SKIPPED), or the money ran out before it. A
 * resume runs it again; a grade, a grader unknown or a prepare skip is a
 * result and stays.
 */
export const rerunnable = (row: Pick<AttemptResult, "reason">) =>
  row.reason === "SKIPPED" ||
  row.reason === "BUDGET_EXHAUSTED" ||
  // A task this Mac could not run that night: a resume after the grant, the
  // cleanup or the hour past midnight runs it.
  (TASK_SKIPS as readonly string[]).includes(row.reason ?? "");

/** A rerunnable row that never started a run, so it cost nothing. */
const neverStarted = (row: Pick<AttemptResult, "runStatus" | "reason">) =>
  row.runStatus === "skipped" && rerunnable(row);

/** Human input cut the attempt short; it goes back to the queue once. */
export const cutByInput = (
  row: Pick<AttemptResult, "manualTakeover" | "reason">,
) => row.manualTakeover || row.reason === "MANUAL_INPUT_UNSEEN";

/**
 * The attempt rows a ledger holds, in plan order. A never-started row that a
 * later row for the same plan index replaced is dropped, so a resumed cycle
 * does not count the same attempt twice; a row input or a stop cut short
 * stays, since that run happened and was paid for (it is a harness skip,
 * outside every success rate, and its cost counts against the caps).
 */
export function ledgerResults(lines: LedgerLine[]): AttemptResult[] {
  const rows = lines
    .filter(
      (line): line is Extract<LedgerLine, { kind: "attempt" }> =>
        line.kind === "attempt",
    )
    .map(({ kind: _kind, at: _at, ...result }) => result as AttemptResult);
  const last = new Map<number, number>();
  rows.forEach((row, position) => last.set(row.planIndex, position));
  return rows
    .filter(
      (row, position) =>
        !(neverStarted(row) && last.get(row.planIndex) !== position),
    )
    .sort((a, b) => a.planIndex - b.planIndex);
}

/**
 * What is left of a plan after a ledger. An index is done once it has a row
 * that is a result: a grade, a grader unknown, or a prepare skip. A row human
 * input cut short is re-queued while the requeue budget lasts; a row a stop
 * or an exhausted cap kept from starting or finishing is not a result at all.
 */
export function remaining(
  plan: PlanEntry[],
  lines: LedgerLine[],
  requeue: number,
): (PlanEntry & { requeued: number })[] {
  const rows = ledgerResults(lines);
  const out: (PlanEntry & { requeued: number })[] = [];
  for (const entry of plan) {
    const mine = rows.filter((row) => row.planIndex === entry.index);
    if (mine.some((row) => !cutByInput(row) && !rerunnable(row))) continue;
    const cut = mine.filter(cutByInput).length;
    if (cut > requeue) continue;
    out.push({ ...entry, requeued: cut });
  }
  return out;
}

/** Gate waits over a whole ledger, every night of a resumed cycle included. */
export function gateWaitsOf(lines: LedgerLine[]): GateWaits {
  const waits: GateWaits = {
    count: 0,
    totalSeconds: 0,
    byReason: {},
    longestSeconds: 0,
    userPresentLong: 0,
  };
  for (const line of lines) {
    if (line.kind !== "gate") continue;
    // A quit of a leftover browser at a gate that passed at once: no wait.
    if (line.reasons && !line.reasons.length) continue;
    const seconds = Number(line.waitedSeconds) || 0;
    waits.count++;
    waits.totalSeconds += seconds;
    waits.longestSeconds = Math.max(waits.longestSeconds, seconds);
    for (const reason of line.reasons ?? [line.reason])
      if (/^[A-Z][A-Z0-9_]*$/.test(reason))
        waits.byReason[reason] = (waits.byReason[reason] ?? 0) + 1;
    if (line.userPresentLong) waits.userPresentLong++;
  }
  return waits;
}

/**
 * What the harness's own ledgers say about input since a browser launched,
 * for the leftover rule (browser-reset.ts inputSinceLaunch): the helper's
 * synthetic input moves HIDIdleTime like a hand would, so a browser a cycle
 * launched and then drove always shows input after its launch, and the
 * ledgers are what tell that input from a person's. `lastInputAgoSeconds`
 * is the age of the newest attempt row that ran (a skipped row posted
 * nothing; the row is written after the attempt's last step, so its input
 * is no later); `personSeenSinceLaunch` is any line at or after the launch
 * that saw a person: an attempt a takeover ended or real input cut short,
 * or a wait that refused on HID_ACTIVE. Over every ledger the caller reads,
 * this cycle's included.
 */
export function harnessInput(
  lines: LedgerLine[],
  launchedAt: number,
  now: number,
): { lastInputAgoSeconds?: number; personSeenSinceLaunch: boolean } {
  let lastInputAt: number | undefined;
  let personSeenSinceLaunch = false;
  for (const line of lines) {
    const at = Date.parse(line.at);
    if (!Number.isFinite(at)) continue;
    if (line.kind === "attempt") {
      if (line.runStatus === "skipped") continue;
      if (lastInputAt === undefined || at > lastInputAt) lastInputAt = at;
      if (
        at >= launchedAt &&
        (line.manualTakeover || line.reason === "MANUAL_INPUT_UNSEEN")
      )
        personSeenSinceLaunch = true;
    } else if (line.kind === "gate") {
      if (
        at >= launchedAt &&
        (line.reasons ?? [line.reason]).includes("HID_ACTIVE")
      )
        personSeenSinceLaunch = true;
    }
  }
  return {
    ...(lastInputAt !== undefined
      ? { lastInputAgoSeconds: Math.max(0, (now - lastInputAt) / 1000) }
      : {}),
    personSeenSinceLaunch,
  };
}

/* ------------------------------------------------------------ the loop */

export type StopReason =
  | "time box"
  | "cost budget"
  | "hand-off"
  | "emergency stop"
  | "interrupted"
  | "error";

export interface CycleCaps {
  /** --max-cost, dollars for the whole cycle. */
  cycle: number;
  /** --max-cost-run, the per-attempt ceiling under the task's own cap. */
  run: number;
  /** --max-cost-model, dollars per matrix cell. */
  model: number;
  cooldownSeconds: number;
  idleSeconds: number;
  gatePollSeconds: number;
  /** Times an attempt human input cut short goes back to the queue. */
  requeue: number;
  stopOnHandoff: boolean;
  allowAppRunning: boolean;
}

/** The part of the harness state the loop reads; the controller's callbacks write it. */
export interface LoopState {
  stopped: boolean;
  emergency: boolean;
  /** Stamped by the journaled execute after every step that posted input. */
  lastAgentInputAt?: number;
}

export type QueueEntry = PlanEntry & { requeued: number };

/**
 * Why the loop asks the escalation about the harness's own browser: to quit
 * it (SECURE_INPUT, LEFTOVER), or to end its process behind a sheet the
 * quit could not pass, a poll after that refusal (SHEET_UP).
 */
export type EscalationCause = "SECURE_INPUT" | "LEFTOVER" | "SHEET_UP";
/** The escalation's answer: browser-reset.ts BrowserQuit's flag and code (the hook keeps the sheets and the terminal line). */
export interface EscalationAnswer {
  quit: boolean;
  code?: string;
}
/** What the hook may answer: an answer with its code, a bare flag (a quit with no code), or nothing (it would not ask). */
export type EscalationReply = boolean | EscalationAnswer | undefined;
/** A reply as an answer; a bare flag carries no code, and nothing stays nothing. */
export function escalationAnswer(
  reply: EscalationReply,
): EscalationAnswer | undefined {
  if (reply === undefined) return undefined;
  return typeof reply === "boolean" ? { quit: reply } : reply;
}

export interface CycleLoopDeps {
  queue: QueueEntry[];
  tasks: Map<string, Pick<BenchTask, "maxCost" | "maxSeconds">>;
  caps: CycleCaps;
  /** Rows a resumed ledger already holds: their cost counts against the caps. */
  prior?: AttemptResult[];
  /** Cycle deadline as a timestamp (ms). */
  deadline: number;
  state: LoopState;
  readGate: () => Promise<GateReport>;
  attempt: (
    entry: QueueEntry,
    maxCost: number,
    gateWaitSeconds: number,
  ) => Promise<AttemptResult>;
  /** A row for an attempt the caps or a task skip kept from starting. */
  skipped: (entry: QueueEntry, reason: string) => AttemptResult;
  /**
   * Why this Mac cannot run the attempt now (preflight.ts taskGate): asked
   * before the gate, so a skip never waits five minutes for idle, and again
   * after it, because the clock may have crossed into DAY_BOUNDARY meanwhile.
   */
  skipFor?: (entry: QueueEntry) => string | undefined;
  /**
   * After a gate pass, before skipFor is asked again and the attempt starts:
   * a chance to read this Mac again. `first` is this process's first pass
   * (nothing of the harness's has run on the desktop yet); `sawInput` says
   * the wait saw a person (HID_ACTIVE). The harness re-reads the open
   * applications here, since the start's reading can be hours old.
   */
  afterGate?: (pass: { first: boolean; sawInput: boolean }) => Promise<void>;
  /**
   * The harness's answer to a SECURE_INPUT refusal, asked once per wait the
   * first time the gate names it, with that report: it says on the terminal
   * what holds the keyboard and where, and when the holder is the
   * benchmark's own browser it points that browser's fixture tabs at
   * about:blank (browser-reset.ts) and answers how many. One or more tabs
   * reset means the gate is read again at once, without a poll's sleep;
   * anything else waits like any reason. Whether the holder is the
   * harness's to touch is the hook's rule (preflight.ts benchOwnBrowser);
   * the loop only carries its answer to the ledger.
   */
  remedy?: (report: GateReport) => Promise<number | undefined>;
  /**
   * The escalation, asked at most once per wait: after the remedy has
   * answered for the harness's own browser (a count, 0 included) and the
   * next read still names that same browser, the hook quits it (a blank
   * tab keeps the focused field's state until its window goes: cycle
   * 20260919-1522 waited 50 minutes on Safari with every tab already blank)
   * and answers true when it has gone, false when it was asked and still
   * runs, undefined when it would not ask (the holder is no longer the
   * harness's to touch). True means the gate is read again at once; anything
   * else waits like any reason, and the hook is not asked again this wait.
   * Never asked while an attempt runs: this is the gate between them.
   *
   * Asked once more, with cause LEFTOVER, each time the gate passes, before
   * the line is written and afterGate runs: the hook looks for a browser an
   * earlier cycle left (browser-reset.ts benchLeftover: only blank,
   * start-page or fixture tabs, and no input of the person's since it
   * launched), quits it, and answers true when it went, false when it was
   * asked and did not (a sheet with no Cancel button among the reasons),
   * undefined when there was nothing of the kind. A defined answer goes on
   * the gate line as browserQuit with browserQuitReason LEFTOVER, written
   * even when the gate passed at once (then with `reasons: []`, which no
   * tally counts as a wait). The pass is never held up by the answer.
   *
   * Asked once more, with cause SHEET_UP, on the poll after a SECURE_INPUT
   * quit answered with code SHEET_UP (a sheet the harness would not
   * dismiss kept the quit from being sent: Safari's save-password prompt,
   * two buttons with no name, the night of 2026-09-19, nine minutes until
   * the operator's `kill -TERM`), when the next read still names that same
   * browser: the hook ends its own browser's process (browser-reset.ts
   * terminateBrowser, SIGTERM then SIGKILL, under benchOwnBrowser again, so
   * never a browser of the person's) and answers with the code (TERMINATED,
   * KILLED, STILL_RUNNING). The answer goes on the line as browserQuit with
   * browserQuitReason SHEET_UP and browserQuitCode; a browser that went is
   * read again at once; anything else waits, and the hook is not asked
   * again this wait. A bare boolean reply carries no code, so no SHEET_UP
   * is seen in it and nothing escalates past the quit.
   */
  escalate?: (
    report: GateReport,
    cause: EscalationCause,
  ) => Promise<EscalationReply>;
  /** Every row the loop records, for rules that learn from results (IDE_BLIND). */
  observe?: (row: AttemptResult) => void;
  /** Appends one ledger line. */
  write: (line: LedgerLine) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** After every row: rewrite results.json and report.md. */
  onResult?: (all: AttemptResult[]) => void;
}

export interface CycleOutcome {
  /** The prior rows and this run's, in the order they were written. */
  results: AttemptResult[];
  stoppedBecause?: StopReason;
  gateWaits: GateWaits;
  /** Queue entries that never got a row. */
  notRun: number;
}

/**
 * The cycle: for each queued attempt, the caps, then the presence gate, then
 * the attempt, then the ledger. Real input ends the attempt it lands in (the
 * controller's callback stops the run outright) and sends it back to the
 * queue once, and the next attempt waits for the full --idle again: the
 * person may still be there. Escape ends the whole cycle. The gate waits
 * rather than stops, except when the time box would end mid-attempt.
 */
export async function runCycleLoop(d: CycleLoopDeps): Promise<CycleOutcome> {
  const results = [...(d.prior ?? [])];
  const queue = [...d.queue];
  const gate: GateState = { idleSeconds: d.caps.idleSeconds };
  const waits: GateWaits = {
    count: 0,
    totalSeconds: 0,
    byReason: {},
    longestSeconds: 0,
    userPresentLong: 0,
  };
  const record = (row: AttemptResult) => {
    results.push(row);
    d.write({ kind: "attempt", at: new Date(d.now()).toISOString(), ...row });
    d.observe?.(row);
    d.onResult?.(results);
  };
  const capFor = (entry: QueueEntry) => {
    const money = spent(results);
    return attemptCap({
      taskMaxCost: d.tasks.get(entry.taskId)?.maxCost ?? 0,
      runCap: d.caps.run,
      cycleRemaining: d.caps.cycle - money.total,
      modelRemaining: d.caps.model - (money.byCell[entry.cell] ?? 0),
    });
  };
  const halted = (): StopReason | undefined =>
    d.state.stopped
      ? d.state.emergency
        ? "emergency stop"
        : "interrupted"
      : undefined;

  /** Polls until the gate passes; a wait is one ledger line and one tally. */
  const waitForGate = async (
    taskSeconds: number,
  ): Promise<{ seconds: number; stop?: StopReason; sawInput: boolean }> => {
    const started = d.now();
    const reasons = new Set<string>();
    let last: string | undefined;
    let longNoted = false;
    /** SECURE_INPUT: the first holder named, what the remedy did, and whether the escalation quit the browser. */
    let secureInputOwner: string | undefined;
    let browserReset: number | undefined;
    let remedied = false;
    let browserQuit: boolean | undefined;
    let browserQuitReason: "LEFTOVER" | "SHEET_UP" | undefined;
    let browserQuitCode: string | undefined;
    let escalated = false;
    /** The quit was refused for a sheet (code SHEET_UP): the next poll that still names the browser ends its process, once. */
    let sheetUp = false;
    let terminated = false;
    const close = () => {
      const seconds = (d.now() - started) / 1000;
      // A wait is tallied by its reasons; a quit of a leftover browser at a
      // gate that passed at once is written, as the record of the quit, and
      // tallied as nothing.
      if (!reasons.size && browserQuitReason === undefined) return seconds;
      if (reasons.size) {
        waits.count++;
        waits.totalSeconds += seconds;
        waits.longestSeconds = Math.max(waits.longestSeconds, seconds);
        for (const reason of reasons)
          waits.byReason[reason] = (waits.byReason[reason] ?? 0) + 1;
      }
      d.write({
        kind: "gate",
        at: new Date(d.now()).toISOString(),
        reason: last ?? "NONE",
        reasons: [...reasons],
        waitedSeconds: Math.round(seconds),
        ...(longNoted ? { userPresentLong: true } : {}),
        ...(secureInputOwner ? { secureInputOwner } : {}),
        ...(browserReset !== undefined ? { browserReset } : {}),
        ...(browserQuit !== undefined ? { browserQuit } : {}),
        ...(browserQuitReason ? { browserQuitReason } : {}),
        ...(browserQuitCode ? { browserQuitCode } : {}),
      });
      return seconds;
    };
    const sawInput = () => reasons.has("HID_ACTIVE");
    for (;;) {
      const stop = halted();
      if (stop) return { seconds: close(), stop, sawInput: sawInput() };
      const report = await d.readGate();
      const now = d.now();
      gate.lastAgentInputAt = d.state.lastAgentInputAt;
      const decision = gateDecision(report, gate, {
        now,
        deadline: d.deadline,
        taskSeconds,
        cooldownSeconds: d.caps.cooldownSeconds,
        allowAppRunning: d.caps.allowAppRunning,
      });
      if (decision.ok) {
        gatePassed(gate);
        // The gate passed: a browser an earlier cycle left with only blank
        // tabs and nobody's input since it launched is the harness's to
        // quit now, before the line is written and the attempt is chosen
        // its browser. Nothing of the kind: undefined, and the line as
        // before.
        if (d.escalate) {
          const quit = escalationAnswer(await d.escalate(report, "LEFTOVER"));
          if (quit !== undefined) {
            browserQuit = quit.quit;
            browserQuitReason = "LEFTOVER";
            browserQuitCode = quit.code;
          }
        }
        return { seconds: close(), sawInput: sawInput() };
      }
      last = decision.reason;
      if (decision.reason) reasons.add(decision.reason);
      if (decision.stop)
        return { seconds: close(), stop: "time box", sawInput: sawInput() };
      // A password field has the keyboard with nobody at the Mac. Once per
      // wait the harness may clear the one case it made itself (a fixture
      // sign-in tab in its own browser); a tab reset is read again at once,
      // and a field of the person's is waited on like anything else. When
      // the remedy answered for the harness's own browser (0 tabs included:
      // they were blank already) and the next read still names that same
      // browser, the escalation quits it, once per wait; a quit is read
      // again at once, and whatever holds the keyboard after that is waited
      // on, the holder named on the line.
      if (decision.reason === "SECURE_INPUT") {
        secureInputOwner ??= report.secureInputOwner;
        if (!remedied && d.remedy) {
          remedied = true;
          browserReset = await d.remedy(report);
          if (browserReset) continue;
          // Blank already, and a quit can follow: the confirming read now,
          // not after a poll's sleep.
          if (browserReset !== undefined && d.escalate) continue;
        } else if (
          remedied &&
          browserReset !== undefined &&
          d.escalate &&
          secureInputOwner !== undefined &&
          report.secureInputOwner === secureInputOwner &&
          (!escalated || (sheetUp && !terminated))
        ) {
          // The first time, the quit. When that answered SHEET_UP (a sheet
          // the harness would not dismiss kept the quit from being sent)
          // and the poll slept since still finds the same browser holding
          // the keyboard, the process is ended instead (the hook's
          // terminateBrowser, under benchOwnBrowser again), once per wait;
          // a browser that went is read again at once either time.
          const cause: EscalationCause = escalated
            ? "SHEET_UP"
            : "SECURE_INPUT";
          if (escalated) terminated = true;
          escalated = true;
          const answer = escalationAnswer(await d.escalate(report, cause));
          if (answer !== undefined) {
            browserQuit = answer.quit;
            browserQuitCode = answer.code;
            if (cause === "SHEET_UP") browserQuitReason = "SHEET_UP";
          }
          if (cause === "SECURE_INPUT") sheetUp = answer?.code === "SHEET_UP";
          if (answer?.quit) continue;
        }
      }
      // A refusal for input needs no "person seen" flag: the tap's clock
      // then trails the time since the agent's last step for good, so the
      // rule keeps refusing until that clock reaches the full --idle.
      if (
        !longNoted &&
        decision.reason === "HID_ACTIVE" &&
        now - started >= d.caps.idleSeconds * 12 * 1000
      ) {
        longNoted = true;
        waits.userPresentLong++;
      }
      await d.sleep(d.caps.gatePollSeconds * 1000);
    }
  };

  let stoppedBecause: StopReason | undefined;
  let passes = 0;
  while (queue.length) {
    stoppedBecause = halted();
    if (stoppedBecause) break;
    const entry = queue[0];
    const cap = capFor(entry);
    if ("skip" in cap) {
      // Only this cell may be out of money; the others carry on. When no
      // queued attempt can run any more, the cycle is over.
      if (queue.every((other) => "skip" in capFor(other))) {
        stoppedBecause = "cost budget";
        break;
      }
      queue.shift();
      record(d.skipped(entry, cap.skip));
      continue;
    }
    const early = d.skipFor?.(entry);
    if (early) {
      queue.shift();
      record(d.skipped(entry, early));
      continue;
    }
    const wait = await waitForGate(d.tasks.get(entry.taskId)?.maxSeconds ?? 0);
    if (wait.stop) {
      stoppedBecause = wait.stop;
      break;
    }
    queue.shift();
    await d.afterGate?.({ first: passes++ === 0, sawInput: wait.sawInput });
    const late = d.skipFor?.(entry);
    if (late) {
      record(d.skipped(entry, late));
      continue;
    }
    let result: AttemptResult;
    try {
      result = await d.attempt(entry, cap.maxCost, Math.round(wait.seconds));
    } catch {
      // A helper that died or a wiring fault: the rows so far stand, the
      // attempt goes back to the front so a resume runs it, and nothing
      // else runs tonight.
      queue.unshift(entry);
      stoppedBecause = "error";
      break;
    }
    gate.lastAgentInputAt = d.state.lastAgentInputAt;
    record(result);
    if (cutByInput(result)) {
      gate.humanSeenAt = d.now();
      if (entry.requeued < d.caps.requeue) {
        queue.push({ ...entry, requeued: entry.requeued + 1 });
        d.write({
          kind: "requeue",
          at: new Date(d.now()).toISOString(),
          planIndex: entry.index,
          requeued: entry.requeued + 1,
        });
      }
    }
    stoppedBecause = halted();
    if (stoppedBecause) {
      // The stop cut this attempt short (or kept it from starting): not a
      // result, so it is one of the attempts that did not run tonight and
      // a resume runs it again.
      if (rerunnable(result)) queue.unshift(entry);
      break;
    }
    if (d.caps.stopOnHandoff && result.handoffs.agent > 0) {
      stoppedBecause = "hand-off";
      break;
    }
    if (queue.length) await d.sleep(d.caps.cooldownSeconds * 1000);
  }
  return {
    results,
    stoppedBecause,
    gateWaits: waits,
    notRun: queue.length,
  };
}

/* ----------------------------------------------------------------- probe */

/**
 * --probe CODE: the cells and categories a failure class touched in the
 * baseline, and nothing else. A probe is evidence for a merge, never for
 * "fixed": its task set is the one the fix was tuned on.
 */
export function probeScope(
  classes: {
    code: string;
    byModel: Record<string, { attempts: number }>;
    byCategory: Record<string, { attempts: number }>;
  }[],
  code: string,
): { cells: string[]; categories: string[] } | undefined {
  const found = classes.find((row) => row.code === code);
  if (!found) return undefined;
  const hit = (entries: Record<string, { attempts: number }>) =>
    Object.entries(entries)
      .filter(([, value]) => value.attempts > 0)
      .map(([key]) => key)
      .sort();
  return { cells: hit(found.byModel), categories: hit(found.byCategory) };
}

/** `<YYYYMMDD-HHMM>-<rev7>` in local time. */
export function defaultCycleId(date: Date, gitRev: string): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}` +
    `-${two(date.getHours())}${two(date.getMinutes())}-${gitRev.slice(0, 7)}`
  );
}

/** A cycle id is a directory name: letters, digits, dot, dash, underscore. */
export const CYCLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
