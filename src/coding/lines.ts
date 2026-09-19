/**
 * What Butler says and shows about a delegation. The fixed parts are app
 * strings; the agent's question and summary are its own words, read from a
 * pane or stream, and reach the voice only through the same filters every
 * generated sentence passes (speakableReport): a question that coaches an
 * approval, asks for a code or carries a credential is not read aloud, and
 * the pill shows it instead.
 */
import { codingAgents } from "./agents";
import type { Delegation, DelegationStatus } from "./state";
import { speakableReport } from "../voice/speakable";

/** A spoken question or summary is cut here; the pill shows the whole. */
const SPOKEN_QUESTION_MAX = 240;
const SPOKEN_SUMMARY_MAX = 400;

export function agentName(d: Pick<Delegation, "agent">): string {
  return codingAgents[d.agent].name;
}
/** The project folder's own name: the owner's word for it, spoken as it is. */
export function folderName(dir: string): string {
  return dir.replace(/\/+$/, "").split("/").pop() || dir;
}
const where = (d: Delegation) => `in ${folderName(d.dir)}`;
const minutes = (from: number, now: number) => {
  const m = Math.floor(Math.max(0, now - from) / 60000);
  return m < 1 ? "just now" : `${m} minute${m === 1 ? "" : "s"} in`;
};

/** The agent's words, made safe to say, or undefined when they are not. */
function spokenQuestion(question?: string): string | undefined {
  return speakableReport(question, SPOKEN_QUESTION_MAX, 3);
}
function spokenSummary(summary?: string): string | undefined {
  return speakableReport(summary, SPOKEN_SUMMARY_MAX, 4);
}

/** The acknowledgement the moment the words are handed over. */
export function ackLine(d: Delegation): string {
  return `${agentName(d)} is on it ${where(d)}.`;
}
/** How to reach the session from a terminal, or why there is none to reach. */
export function attachHint(d: Delegation): string {
  return d.attach
    ? `Attach from a terminal: ${d.attach}`
    : "Running in print mode; install tmux to get sessions you can attach to.";
}
/** A question the agent asks, spoken: quoted when the filters allow, pointed at otherwise. */
export function questionLine(d: Delegation): string {
  const q = spokenQuestion(d.question);
  const name = agentName(d);
  if (d.status === "asks_yes_no") {
    const how =
      d.transport === "tmux"
        ? "Tell it yes or tell it no."
        : "Print mode already declined it; install tmux to answer such questions yourself.";
    return q
      ? `${name} is asking: ${q} ${how}`
      : `${name} is asking for permission ${where(d)}; the question is on the pill. ${how}`;
  }
  return q
    ? `${name} has a question: ${q} Tell it your answer.`
    : `${name} has a question for you ${where(d)}; it is on the pill. Tell it your answer.`;
}
/** The line for a status the delegation moved into. */
export function newsLine(d: Delegation, from: DelegationStatus): string {
  const name = agentName(d);
  switch (d.status) {
    case "starting":
      return `${name} is starting ${where(d)}.`;
    case "working":
      return from === "asks_yes_no" || from === "asks_text"
        ? `${name} is working again.`
        : `${name} is working ${where(d)}.`;
    case "asks_yes_no":
    case "asks_text":
      return questionLine(d);
    case "idle":
      return `${name} is waiting for input ${where(d)}.`;
    case "finished":
      return `${name} finished ${where(d)}. Ask me for the summary when you want it.`;
    case "error":
      return `${name} hit an error ${where(d)}.`;
    case "stopped":
      return `Interrupted ${name} ${where(d)}.`;
    case "ended":
      return `${name}’s session ${where(d)} has ended.`;
  }
}
/** The answer to "what's the coding agent doing?", from the state alone. */
export function statusLine(d: Delegation, now: number): string {
  const name = agentName(d);
  switch (d.status) {
    case "starting":
      return `${name} is starting up ${where(d)}.`;
    case "working":
      return `${name} is working ${where(d)}, ${minutes(d.since, now)}.`;
    case "asks_yes_no":
    case "asks_text":
      return questionLine(d);
    case "idle":
      return `${name} is idle ${where(d)}, waiting for input.`;
    case "finished":
      return `${name} finished ${where(d)}, ${minutes(d.since, now)}. Ask me for the summary when you want it.`;
    case "error":
      return `${name} stopped with an error ${where(d)}.`;
    case "stopped":
      return `${name} was interrupted ${where(d)} and is waiting.`;
    case "ended":
      return `${name}’s session ${where(d)} has ended.`;
  }
}
/** The answer to "read me the summary". */
export function summaryLine(d: Delegation): string {
  const name = agentName(d);
  if (d.status !== "finished" && d.status !== "error")
    return `${name} hasn’t finished yet; it is ${statusPhrase(d.status)}.`;
  if (!d.summary) return `${name} finished without saying anything.`;
  return (
    spokenSummary(d.summary) ??
    `${name}’s summary has text I won’t read aloud; it is on the pill.`
  );
}
function statusPhrase(status: DelegationStatus): string {
  switch (status) {
    case "starting":
      return "still starting";
    case "working":
      return "still working";
    case "asks_yes_no":
      return "waiting for a yes or no";
    case "asks_text":
      return "waiting for your answer";
    case "idle":
      return "idle at its prompt";
    case "stopped":
      return "interrupted";
    default:
      return "over";
  }
}
