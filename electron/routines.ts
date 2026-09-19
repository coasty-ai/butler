/**
 * The routine scheduler (.data/design/observer.md §5): once a minute, an
 * approved routine that is due (its weekday and hour window, once a day)
 * starts as an ordinary run with origin "routine" and the routine's task
 * text, only while watching is on, no run is going, nobody is listening,
 * the Mac is unlocked, the owner is not typing in the routine's
 * application, and the presence rules allow (background mode when the
 * setting allows it, else only with the owner away or the Mac idle long
 * enough). Every replay's end feeds back: RoutineRun {routineId, outcome}
 * is traced and the routine's confidence moves (src/observer/routines.ts);
 * an undo right after counts as undone. Triggers (the Mac unlocked, an
 * application launched, the owner saying the routine's name) go through
 * trigger(). The policy, approvals and the journal apply as to any run.
 */
import type { Settings, Snapshot } from "../src/core/schema";
import {
  errorDetails,
  trace,
  type DiagnosticSink,
} from "../src/core/diagnostics";
import type { MemoryData } from "../src/memory/types";
import {
  applyOutcomeIn,
  dueRoutines,
  markRunIn,
  outcomeOf,
  routineTask,
  triggeredBy,
  type RoutineOutcome,
  type RoutineTrigger,
} from "../src/observer/routines";
import { mayTakeScreen, type Presence } from "./presence";

/** An undo this soon after a routine's run ended counts against the routine. */
export const UNDO_AFTER_MS = 60_000;
const TERMINAL = new Set(["completed", "cancelled", "failed"]);

export interface RoutineStart {
  origin: "routine";
  taskSource: "user_words";
}
export interface RoutineSchedulerDeps {
  settings: () => Settings;
  memory: () =>
    | { data(): MemoryData; update<T>(change: (data: MemoryData) => T): T }
    | undefined;
  runActive: () => boolean;
  listening: () => boolean;
  presence: {
    current(): Presence;
    idleMs(): number | undefined;
    locked(): boolean;
  };
  /** The application the owner is typing in right now (electron/observer.ts). */
  typingIn: () => string | undefined;
  /** main.ts startRun with the routine's provenance. */
  start: (task: string, source: RoutineStart) => Promise<void>;
  trace?: DiagnosticSink;
  now?: () => Date;
}
export interface RoutineScheduler {
  /** Once a minute. Starts at most one routine. */
  tick(): Promise<boolean>;
  /** A trigger fired; starts the first routine it names. */
  trigger(event: RoutineTrigger): Promise<boolean>;
  /** Follows runs to record each replay's outcome. */
  onSnapshot(s: Snapshot): void;
  /** An undo run is starting: the routine run that just ended was undone. */
  noteUndo(): void;
  /** The replay under way, when one is. */
  pending(): { routineId: string; runId?: string } | undefined;
}

export function createRoutineScheduler(
  deps: RoutineSchedulerDeps,
): RoutineScheduler {
  const now = deps.now ?? (() => new Date());
  let pending:
    { routineId: string; runId?: string; startedAt: number } | undefined;
  let lastEnded: { routineId: string; at: number; runId: string } | undefined;
  const record = (
    routineId: string,
    outcome: RoutineOutcome,
    corrections: string[] = [],
  ) => {
    deps
      .memory()
      ?.update((data) =>
        applyOutcomeIn(data, routineId, outcome, now(), corrections),
      );
    trace(deps.trace, "RoutineRun", { routineId, outcome });
  };
  const mayStart = (appIds: string[]) => {
    const s = deps.settings();
    if (!s.observer.on || !s.memory) return false;
    if (pending || deps.runActive() || deps.listening()) return false;
    if (deps.presence.locked()) return false;
    const typing = deps.typingIn();
    if (typing && appIds.includes(typing)) return false;
    return (
      s.workInBackground ||
      mayTakeScreen(
        deps.presence.current(),
        deps.presence.idleMs(),
        "watch",
      ) === "now"
    );
  };
  const launch = async (routineId: string) => {
    const memory = deps.memory();
    if (!memory) return false;
    const data = memory.data();
    const routine = data.routines.find((r) => r.id === routineId);
    if (!routine) return false;
    const task = routineTask(routine, data.procedures);
    if (!task) return false;
    memory.update((d) => markRunIn(d, routineId, now()));
    pending = { routineId, startedAt: now().getTime() };
    trace(deps.trace, "RoutineStarted", { routineId });
    try {
      await deps.start(task, { origin: "routine", taskSource: "user_words" });
      return true;
    } catch (error) {
      pending = undefined;
      trace(deps.trace, "RoutineStartFailed", {
        routineId,
        ...errorDetails(error),
      });
      record(routineId, "failed");
      return false;
    }
  };
  return {
    async tick() {
      const memory = deps.memory();
      if (!memory) return false;
      const due = dueRoutines(memory.data(), now());
      for (const routine of due)
        if (mayStart(routine.steps.map((s) => s.appId)))
          return launch(routine.id);
      return false;
    },
    async trigger(event) {
      const memory = deps.memory();
      if (!memory) return false;
      const at = now();
      const routine = memory
        .data()
        .routines.find((r) => triggeredBy(r, event, at));
      if (!routine) return false;
      // The owner asked for it by name: their own words override the
      // typing and presence checks, as a spoken task would.
      if (
        event.kind !== "spoken" &&
        !mayStart(routine.steps.map((s) => s.appId))
      )
        return false;
      if (event.kind === "spoken" && (pending || deps.runActive()))
        return false;
      return launch(routine.id);
    },
    onSnapshot(s) {
      const run = s.run;
      if (!pending || !run || run.origin !== "routine") return;
      const created = Date.parse(run.createdAt);
      if (!pending.runId) {
        if (Number.isFinite(created) && created + 5_000 < pending.startedAt)
          return;
        pending.runId = run.id;
      }
      if (pending.runId !== run.id || !TERMINAL.has(run.status)) return;
      const outcome = outcomeOf(run);
      const routineId = pending.routineId;
      pending = undefined;
      if (!outcome) return;
      lastEnded = { routineId, at: now().getTime(), runId: run.id };
      record(
        routineId,
        outcome,
        (run.corrections ?? [])
          .map((c) => c.text)
          .filter((t): t is string => typeof t === "string"),
      );
    },
    noteUndo() {
      if (!lastEnded || now().getTime() - lastEnded.at > UNDO_AFTER_MS) return;
      const { routineId } = lastEnded;
      lastEnded = undefined;
      record(routineId, "undone");
    },
    pending() {
      return pending
        ? { routineId: pending.routineId, runId: pending.runId }
        : undefined;
    },
  };
}
