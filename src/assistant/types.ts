/**
 * The shared vocabulary of the conversational layer: which channel a turn
 * came in on, what the assistant may know about the run, and the shapes the
 * dialog session, progress reporter and watchers exchange. Types only, so
 * every layer (voice, iMessage, the phone remote, coding-agent watches) reads
 * the same run and the same decision, and none of them depends on Electron.
 * The contracts are pinned in the integrated build plan, increment 2.
 */
import type { RunOrigin, RunStatus, TaskSource } from "../core/schema";
import type { TurnPlan, VoiceTurnRun } from "../voice/turns";

/**
 * Where a turn came from. "app" is typed on the Mac; "message" is iMessage
 * and "remote" the phone remote over the tailnet. Only "voice" and "app" can
 * ever approve a step: the other two have nobody at the screen.
 */
export type Channel = "voice" | "app" | "message" | "remote";

/**
 * One line of the conversation. `untrusted` marks assistant lines built from
 * screen, notification or panel text: they may be repeated back, never used
 * as the user's words when a task is grounded.
 */
export interface TurnRecord {
  role: "user" | "assistant";
  channel: Channel;
  text: string;
  at: number;
  untrusted: boolean;
}

/** A detached watch of a coding agent's window (increment 5). */
export interface WatchState {
  id: string;
  runId: string;
  app: string;
  agent?: string;
  state: string;
  startedAt: number;
  lastChangeAt: number;
  minutes: number;
}

/** A task waiting for the current run to end (electron/task-queue.ts). */
export interface QueuedTask {
  id: string;
  text: string;
  origin: RunOrigin;
  taskSource?: TaskSource;
  at: number;
}

/**
 * What the Mac is doing, sanitized for anyone asking: never an approval's
 * action or reason, never typed text, never a full URL or path. Built by
 * runView() from a Snapshot; the same view answers voice and text.
 */
export interface RunView {
  running: boolean;
  status:
    "working" | "waiting_for_approval" | "waiting_for_you" | "paused" | "idle";
  task?: string;
  minutes?: number;
  steps?: number;
  app?: string;
  /** The last few stepLine() values, oldest first. */
  recent: string[];
  /** The run's own question while it waits for the user. */
  question?: string;
  queued: string[];
  watches: WatchState[];
  lastFinished?: {
    task: string;
    outcome: "completed" | "failed" | "stopped";
    summary?: string;
    minutesAgo: number;
  };
}

export type ProgressKind =
  "started" | "checkin" | "summary" | "stalled" | "needs_you" | "final";

/** The facts a progress update is written from (increment 4B). */
export interface ProgressFacts {
  runId: string;
  seq: number;
  task: string;
  origin?: RunOrigin;
  status: RunStatus | "watching";
  activeMinutes: number;
  actions: number;
  sinceLast: string[];
  apps: string[];
  app?: string;
  /** "detailed" only. */
  window?: string;
  corrections: string[];
  previous?: string;
  detail: "brief" | "detailed";
  watch?: {
    agent?: string;
    state: string;
    minutes: number;
    change: number;
    /** At most 1500 characters, redacted; never part of a Snapshot. */
    panelTail?: string;
  };
}

export interface ProgressReport {
  runId: string;
  seq: number;
  kind: ProgressKind;
  text: string;
  at: number;
  speak: boolean;
  send: boolean;
  /** The fixed line was used because no summary was available. */
  fallback: boolean;
  /**
   * Set on a "final" report: how the run, or the watched agent, ended. The
   * sinks prefix their outcome word from this, never from whatever is
   * running when the recap arrives.
   */
  outcome?: "completed" | "failed";
}

/** Anything that delivers progress: spoken replies, texts, the phone remote. */
export interface ProgressSink {
  onProgress(r: ProgressReport): void;
}

/** What the dialog session decides a free-form turn from (increment 3A). */
export interface DecideInput {
  turnId: string;
  text: string;
  /** planVoiceTurn's deterministic plan for the same words. */
  base: TurnPlan;
  run?: VoiceTurnRun;
  view: RunView;
  channel: Channel;
  confidence: number;
  signal: AbortSignal;
}

export interface TurnDecision {
  /** Never approve, decline or stop: those stay deterministic. */
  plan: TurnPlan;
  taskSource?: TaskSource;
  /** The plan changes a run, so a filler is the whole acknowledgement. */
  acting: boolean;
  /** Already filtered: speakableSentence for voice, textable for texts. */
  sentences?: AsyncIterable<string>;
  proposal?: { id: string; text: string; until: number };
  code:
    "model" | "fast_start" | "timeout" | "invalid" | "error" | "off" | "budget";
}

/** Implemented by electron/assistant.ts in increment 3A. */
export interface AssistantSessionApi {
  available(channel: Channel): boolean;
  preempt(partial: string, channel: Channel): void;
  /** Never throws: a failure is a decision with its code. */
  decide(i: DecideInput): Promise<TurnDecision>;
  proposal(): { id: string; text: string; until: number } | undefined;
  noteUser(text: string, channel: Channel): void;
  noteAssistant(
    text: string,
    channel: Channel,
    o?: { untrusted?: boolean },
  ): void;
  interrupt(): void;
  reset(): void;
}
