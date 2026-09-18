/**
 * The sanitized view of the run that every channel answers "how's it going?"
 * from, and the fixed status lines built from it. One view for voice, iMessage
 * and the phone remote, so they never disagree about what the Mac is doing,
 * and one place that decides what is safe to repeat: a pending approval is
 * reported as waiting, never with its action or reason; steps come from
 * stepLine(), which never carries typed text.
 */
import type { Action, Run, Snapshot } from "../core/schema";
import { redactSecrets } from "../core/sanitize";
import { speakableQuestion, speakableSummary } from "../voice/speakable";
import { stepLine } from "./steps";
import type { QueuedTask, RunView, WatchState } from "./types";

const TERMINAL = new Set(["completed", "cancelled", "failed"]);
const RECENT_STEPS = 6;
const MAX_TASK = 300;
const MAX_APP = 80;

const clip = (text: string, max: number) => {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
};
const minutesBetween = (from: number, to: number) =>
  Math.max(0, Math.floor((to - from) / 60000));
const startedAt = (run: Run) => {
  const at = Date.parse(run.createdAt);
  return Number.isFinite(at) ? at : undefined;
};

/**
 * When a run ended, as far as the snapshot knows: the last journal entry when
 * it is the snapshot's own run, otherwise when it started (a Run records no
 * end time, so an old run's "minutes ago" is a floor, never an overstatement
 * of how recent it is).
 */
function finishedAt(run: Run, s: Snapshot | undefined): number | undefined {
  if (s?.run?.id === run.id) {
    const last = s.events.at(-1)?.wall_clock_timestamp;
    const at = last ? Date.parse(last) : NaN;
    if (Number.isFinite(at)) return at;
  }
  return startedAt(run);
}

export function runView(
  s: Snapshot | undefined,
  o: {
    queued: QueuedTask[];
    watches: WatchState[];
    lastFinished?: Run;
    now: number;
    /**
     * The run is paused only because the user's own activation interrupted
     * it to listen (main.ts voiceHoldResumable). It carries on once answered,
     * so to the user it is still working, not waiting for them.
     */
    heldByVoice?: boolean;
  },
): RunView {
  const run = s?.run ?? undefined;
  const queued = o.queued.map((q) => clip(redactSecrets(q.text), MAX_TASK));
  const finished =
    o.lastFinished ?? (run && TERMINAL.has(run.status) ? run : undefined);
  const lastFinished = finished
    ? {
        task: clip(redactSecrets(finished.task), MAX_TASK),
        outcome:
          finished.status === "completed"
            ? ("completed" as const)
            : finished.status === "failed"
              ? ("failed" as const)
              : ("stopped" as const),
        ...(speakableSummary(finished.summary)
          ? { summary: speakableSummary(finished.summary) }
          : {}),
        minutesAgo: minutesBetween(finishedAt(finished, s) ?? o.now, o.now),
      }
    : undefined;
  if (!run || TERMINAL.has(run.status))
    return {
      running: false,
      status: "idle",
      recent: [],
      queued,
      watches: o.watches,
      ...(lastFinished ? { lastFinished } : {}),
    };
  const status =
    run.status === "confirming"
      ? "waiting_for_approval"
      : run.status === "takeover"
        ? "waiting_for_you"
        : run.status === "paused" && !o.heldByVoice
          ? "paused"
          : "working";
  const recent: string[] = [];
  for (const e of s!.events)
    if (e.type === "ActionExecuted") {
      const line = stepLine(e.data.action as Action);
      if (line) recent.push(line);
    }
  const app = s!.frame?.context?.appName;
  const question =
    run.status === "takeover" ? speakableQuestion(s!.message) : undefined;
  const began = startedAt(run);
  return {
    running: true,
    status,
    task: clip(redactSecrets(run.task), MAX_TASK),
    minutes: began === undefined ? 0 : minutesBetween(began, o.now),
    steps: run.actions,
    ...(app ? { app: clip(app, MAX_APP) } : {}),
    recent: recent.slice(-RECENT_STEPS),
    ...(question ? { question } : {}),
    queued,
    watches: o.watches,
    ...(lastFinished ? { lastFinished } : {}),
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const ago = (minutes: number) =>
  minutes < 1 ? "just now" : `${plural(minutes, "minute")} ago`;

/**
 * The fixed answer to a status question, one or two short sentences with
 * nothing a voice router would act on. Truthful from the view alone: it
 * never claims progress the snapshot does not show.
 */
export function statusLine(v: RunView): string {
  const more = v.queued.length
    ? ` ${plural(v.queued.length, "more task")} waiting after this.`
    : "";
  switch (v.status) {
    case "working":
      return (
        `Still on it. ${v.app ? `I’m in ${v.app}, ` : ""}${plural(v.steps ?? 0, "step")} so far.` +
        more
      );
    case "waiting_for_approval":
      return "I’m waiting for your okay on the next step." + more;
    case "waiting_for_you":
      return (
        (v.question
          ? `I need you for this one: ${v.question}`
          : "I need you at the Mac for this one.") + more
      );
    case "paused":
      return "It’s paused, waiting for you." + more;
    case "idle": {
      const last = v.lastFinished;
      if (!last) return "Nothing’s running right now." + more;
      const ending =
        last.outcome === "completed"
          ? "finished"
          : last.outcome === "stopped"
            ? "was stopped"
            : "didn’t finish";
      return `Nothing’s running. The last task ${ending} ${ago(last.minutesAgo)}.`;
    }
  }
}
