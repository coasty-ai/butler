/**
 * Routines, pure (.data/design/observer.md §5): when an approved routine is
 * due (its weekday and hour window, once a day, or a trigger), how a
 * replay's outcome moves its confidence (completed up, corrected down,
 * undone further down; two corrections in a row send it back to proposed
 * with the corrections attached), the task text a replay runs, and the one
 * sentence Butler offers a new routine with. electron/routines.ts runs the
 * clock; nothing here starts anything.
 */
import type { MemoryData, Procedure, Routine } from "../memory/types";
import { normalizeTask } from "../memory/skills";
import { redactSecrets } from "../core/sanitize";
import { bound } from "../memory/retrieve";
import { dayKey } from "./log";

export type RoutineOutcome =
  "completed" | "corrected" | "undone" | "declined" | "failed";
/** How each outcome moves confidence (0–1). */
export const OUTCOME_DELTA: Record<RoutineOutcome, number> = {
  completed: 0.1,
  corrected: -0.15,
  undone: -0.3,
  declined: -0.1,
  failed: -0.15,
};
/** Corrections in a row that send an approved routine back to proposed. */
export const CORRECTIONS_TO_PROPOSE = 2;
/** Below this, an approved routine waits for the owner rather than running. */
export const MIN_RUN_CONFIDENCE = 0.3;

export type RoutineTrigger =
  | { kind: "unlocked" }
  | { kind: "app_launched"; appId: string }
  | { kind: "spoken"; text: string };

/** Whether the moment falls in the routine's window (local weekday and hour). */
export function inWindow(routine: Routine, now: Date): boolean {
  const [from, to] = routine.when.hourRange;
  const hour = now.getHours() + now.getMinutes() / 60;
  return (
    routine.when.weekdays.includes(now.getDay()) && hour >= from && hour < to
  );
}
/** Already replayed today (local day). */
export function ranToday(routine: Routine, now: Date): boolean {
  if (!routine.lastRunAt) return false;
  const at = new Date(routine.lastRunAt);
  return Number.isFinite(at.getTime()) && dayKey(at) === dayKey(now);
}
/** Approved, confident enough, in its window, and not yet run today. */
export function isDue(routine: Routine, now: Date): boolean {
  return (
    routine.status === "approved" &&
    routine.confidence >= MIN_RUN_CONFIDENCE &&
    inWindow(routine, now) &&
    !ranToday(routine, now)
  );
}
export function dueRoutines(data: MemoryData, now: Date): Routine[] {
  return data.routines
    .filter((r) => isDue(r, now))
    .sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id));
}
/**
 * Whether a trigger names the routine: the owner said its name, the Mac
 * unlocked inside its window, or its first application was launched inside
 * its window. Only approved, confident routines that did not run today.
 */
export function triggeredBy(
  routine: Routine,
  trigger: RoutineTrigger,
  now: Date,
): boolean {
  if (
    routine.status !== "approved" ||
    routine.confidence < MIN_RUN_CONFIDENCE ||
    ranToday(routine, now)
  )
    return false;
  switch (trigger.kind) {
    case "spoken": {
      // "Run my morning check-in", "start the morning check-in routine".
      const strip = (text: string) =>
        normalizeTask(text)
          .replace(/^(?:run|start|do|begin|launch) /, "")
          .replace(/^(?:my|the) /, "")
          .replace(/ routine$/, "");
      const said = strip(trigger.text);
      const name = strip(routine.name);
      return !!name && said === name;
    }
    case "unlocked":
      return inWindow(routine, now);
    case "app_launched":
      return (
        inWindow(routine, now) && routine.steps[0]?.appId === trigger.appId
      );
  }
}

/** A replay's outcome applied: a new routine object, the input untouched. */
export function applyOutcome(
  routine: Routine,
  outcome: RoutineOutcome,
  now: Date,
  corrections: string[] = [],
): Routine {
  const next: Routine = {
    ...routine,
    runs: { ...routine.runs, [outcome]: routine.runs[outcome] + 1 },
    confidence: Math.min(
      1,
      Math.max(0, routine.confidence + OUTCOME_DELTA[outcome]),
    ),
    correctionStreak:
      outcome === "corrected" || outcome === "undone"
        ? routine.correctionStreak + 1
        : outcome === "completed"
          ? 0
          : routine.correctionStreak,
  };
  const clean = corrections
    .map((c) => bound(redactSecrets(c.replace(/\s+/g, " ").trim()), 300))
    .filter(Boolean);
  if (clean.length)
    next.corrections = [...(routine.corrections ?? []), ...clean].slice(-10);
  if (
    next.status === "approved" &&
    next.correctionStreak >= CORRECTIONS_TO_PROPOSE
  ) {
    next.status = "proposed";
    next.correctionStreak = 0;
    delete next.offeredAt;
  }
  return next;
}
export function applyOutcomeIn(
  data: MemoryData,
  id: string,
  outcome: RoutineOutcome,
  now: Date,
  corrections: string[] = [],
): Routine | undefined {
  const index = data.routines.findIndex((r) => r.id === id);
  if (index < 0) return undefined;
  const next = applyOutcome(data.routines[index], outcome, now, corrections);
  data.routines[index] = next;
  return next;
}
/** Marks the routine as started now, so its window runs once a day. */
export function markRunIn(
  data: MemoryData,
  id: string,
  now: Date,
): Routine | undefined {
  const routine = data.routines.find((r) => r.id === id);
  if (!routine) return undefined;
  routine.lastRunAt = now.toISOString();
  return routine;
}

/** How a finished run of origin "routine" counts. */
export function outcomeOf(run: {
  status: string;
  corrections?: unknown[];
}): RoutineOutcome | undefined {
  if (Array.isArray(run.corrections) && run.corrections.length)
    return "corrected";
  switch (run.status) {
    case "completed":
      return "completed";
    case "cancelled":
      return "declined";
    case "failed":
      return "failed";
    default:
      return undefined;
  }
}

const stepName = (s: Routine["steps"][number]) =>
  s.appName ?? s.appId.split(".").at(-1) ?? s.appId;
/**
 * The task a replay runs: the approved procedure's trigger when the routine
 * has one without open slots, else a sentence from its steps ("Open Slack,
 * then Mail, then Safari at youtube.com."). Always the owner-approved
 * shape, never the model's words from consolidation day.
 */
export function routineTask(
  routine: Routine,
  procedures: Procedure[] = [],
): string {
  const procedure = routine.procedureId
    ? procedures.find(
        (p) => p.id === routine.procedureId && p.status === "approved",
      )
    : undefined;
  if (procedure && !/\{slot\d+\}/.test(procedure.trigger))
    return procedure.trigger;
  const parts = routine.steps.map((s) => {
    const name = stepName(s);
    const where = s.host ? ` at ${s.host}` : "";
    return s.action ? `${s.action} in ${name}${where}` : `open ${name}${where}`;
  });
  const first = parts[0] ?? "";
  const rest = parts.slice(1);
  const sentence = rest.length
    ? `${first}, then ${rest.join(", then ")}`
    : first;
  return bound(
    sentence ? sentence[0].toUpperCase() + sentence.slice(1) + "." : "",
    500,
  );
}

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
/** "weekdays", "weekends", "every day" or the listed days. */
export function weekdaysPhrase(weekdays: number[]): string {
  const set = new Set(weekdays);
  if (set.size === 7) return "every day";
  if (set.size === 5 && [1, 2, 3, 4, 5].every((d) => set.has(d)))
    return "weekdays";
  if (set.size === 2 && set.has(0) && set.has(6)) return "weekends";
  return [...set]
    .sort((a, b) => a - b)
    .map((d) => DAY_NAMES[d] + "s")
    .join(", ");
}
const hourWord = (h: number) =>
  h === 0 || h === 24
    ? "midnight"
    : h === 12
      ? "noon"
      : h < 12
        ? `${h} in the morning`
        : h < 18
          ? `${h - 12} in the afternoon`
          : `${h - 12} in the evening`;
/** The one spoken offer for a new routine (design §4). */
export function offerSentence(routine: Routine): string {
  const names = routine.steps.map(stepName);
  const list =
    names.length > 1
      ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
      : (names[0] ?? "the same things");
  return `I noticed you open ${list} ${weekdaysPhrase(routine.when.weekdays)} around ${hourWord(routine.when.hourRange[0])}. Want that as a routine? You can approve it in Settings, under Watching.`;
}
