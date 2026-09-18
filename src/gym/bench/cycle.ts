import { createHash } from "node:crypto";
import type { ProviderKind } from "../../core/schema";
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
    const close = () => {
      const seconds = (d.now() - started) / 1000;
      if (!reasons.size) return seconds;
      waits.count++;
      waits.totalSeconds += seconds;
      waits.longestSeconds = Math.max(waits.longestSeconds, seconds);
      for (const reason of reasons)
        waits.byReason[reason] = (waits.byReason[reason] ?? 0) + 1;
      d.write({
        kind: "gate",
        at: new Date(d.now()).toISOString(),
        reason: last ?? "UNKNOWN",
        reasons: [...reasons],
        waitedSeconds: Math.round(seconds),
        ...(longNoted ? { userPresentLong: true } : {}),
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
        return { seconds: close(), sawInput: sawInput() };
      }
      last = decision.reason;
      if (decision.reason) reasons.add(decision.reason);
      if (decision.stop)
        return { seconds: close(), stop: "time box", sawInput: sawInput() };
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
