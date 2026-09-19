/**
 * One delegation: a coding agent at work in one project folder, as Butler
 * remembers it between reads of its pane or stream. The reducer here turns a
 * classifier reading into the next state and says whether anything worth
 * telling the owner changed; electron/coding.ts does the reading and acts on
 * the change. Pure, so a whole session is replayed in tests from authored
 * pane text alone.
 */
import type { CodingAgentId } from "./agents";
import type { AnswerKeys, PaneReading, StreamReading } from "./classify";
import type { RunOrigin } from "../core/schema";

export type CodingTransport = "tmux" | "print";
export type DelegationStatus =
  | "starting"
  | "working"
  | "asks_yes_no"
  | "asks_text"
  | "idle"
  | "finished"
  | "error"
  | "stopped"
  | "ended";
export interface Delegation {
  id: string;
  agent: CodingAgentId;
  dir: string;
  /** The words handed over, for the record and the reporter; never a pane's text. */
  task: string;
  origin?: RunOrigin;
  transport: CodingTransport;
  /** The tmux session and what to type to sit in on it; print mode has neither. */
  session?: string;
  attach?: string;
  status: DelegationStatus;
  startedAt: number;
  /** When the status last changed. */
  since: number;
  /** When the pane or stream last showed something new. */
  lastChangeAt: number;
  question?: string;
  keys?: AnswerKeys;
  summary?: string;
  resumeId?: string;
  /** Print mode: words the owner said during a turn, sent as the next one. */
  pending: string[];
  /** Counts every reported change, so no line or report repeats. */
  seq: number;
}

export interface Transition {
  next: Delegation;
  /** The status, question or (once finished) summary is new. */
  changed: boolean;
}

/**
 * The next state after a reading. An unknown reading changes nothing. A
 * session still starting shows its welcome text and prompt before any task
 * was typed: that reads as idle (ready for the task), never as finished.
 */
export function applyReading(
  d: Delegation,
  r: PaneReading | StreamReading,
  now: number,
): Transition {
  if (r.status === "unknown") return { next: d, changed: false };
  const status: DelegationStatus =
    d.status === "starting" && (r.status === "idle" || r.status === "finished")
      ? "idle"
      : r.status;
  const asks = status === "asks_yes_no" || status === "asks_text";
  const question = asks ? r.question : undefined;
  const keys = status === "asks_yes_no" ? r.keys : undefined;
  const summary =
    status === "idle" && d.status === "starting"
      ? undefined
      : (r.summary ?? d.summary);
  const resumeId = ("resumeId" in r && r.resumeId) || d.resumeId;
  const changed =
    status !== d.status ||
    question !== d.question ||
    (status === "finished" && summary !== d.summary);
  if (
    !changed &&
    summary === d.summary &&
    resumeId === d.resumeId &&
    keysEqual(keys, d.keys)
  )
    return { next: d, changed: false };
  return {
    next: {
      ...d,
      status,
      since: status === d.status ? d.since : now,
      lastChangeAt: changed ? now : d.lastChangeAt,
      seq: changed ? d.seq + 1 : d.seq,
      ...(question !== undefined ? { question } : {}),
      ...(keys ? { keys } : {}),
      ...(summary !== undefined ? { summary } : {}),
      ...(resumeId ? { resumeId } : {}),
      ...(question === undefined ? { question: undefined } : {}),
      ...(keys === undefined ? { keys: undefined } : {}),
      ...(summary === undefined ? { summary: undefined } : {}),
    },
    changed,
  };
}
const keysEqual = (a?: AnswerKeys, b?: AnswerKeys) =>
  a?.yes === b?.yes && a?.no === b?.no;

/**
 * The owner's words went in: the agent is working on them, and whatever it
 * said before is history. A new task replaces the recorded one; relayed
 * words leave it.
 */
export function markSent(
  d: Delegation,
  now: number,
  task?: string,
): Delegation {
  return {
    ...d,
    ...(task ? { task } : {}),
    status: "working",
    since: now,
    lastChangeAt: now,
    seq: d.seq + 1,
    question: undefined,
    keys: undefined,
    summary: undefined,
  };
}
/** A status the transport decided on its own: interrupted, ended, or failed to start. */
export function markStatus(
  d: Delegation,
  status: DelegationStatus,
  now: number,
): Delegation {
  if (d.status === status) return d;
  return {
    ...d,
    status,
    since: now,
    lastChangeAt: now,
    seq: d.seq + 1,
    question: undefined,
    keys: undefined,
  };
}
/**
 * The delegation's status in the words the progress reporter already knows
 * for a watched agent (src/assistant/progress.ts), so texted and phone
 * updates about a delegation read like those about a watch.
 */
export function watchState(status: DelegationStatus): string {
  switch (status) {
    case "starting":
    case "working":
      return "working";
    case "asks_yes_no":
      return "needs_permission";
    case "asks_text":
      return "needs_you";
    case "idle":
    case "stopped":
      return "idle";
    case "finished":
    case "ended":
      return "done";
    case "error":
      return "error";
  }
}
/** Whether the agent is doing something a new task would interrupt. */
export function busy(status: DelegationStatus): boolean {
  return (
    status === "starting" ||
    status === "working" ||
    status === "asks_yes_no" ||
    status === "asks_text"
  );
}
