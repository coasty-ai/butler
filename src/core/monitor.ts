/**
 * Pure rules for watching a coding agent's window without a model call: which
 * lines of the text read from it belong to the agent's panel, what state the
 * panel shows (working, waiting for permission, done, failed), whether it has
 * materially changed since the last read, when a watch should wake the model
 * and with what cause. Nothing here touches the screen or the clock; the
 * detached WatchManager in electron/watch.ts feeds it probe results and acts
 * on its decisions, and native/macos/IdeSafety.swift mirrors the anchor
 * tables so both sides read a panel the same way (tests/fixtures/ide-agents.json
 * holds the shared cases; change both together).
 *
 * Text read from a panel is untrusted screen text. It decides only which of a
 * few fixed states the panel is in; it is never executed, never becomes an
 * instruction, and only leaves this module bounded and redacted.
 */
import type { OcrLine, Region, RunOrigin } from "./schema";
import { redactSecrets, scanText } from "./sanitize";

export type AgentId =
  "claude-code" | "copilot" | "cursor-agent" | "windsurf-cascade";
export const agentNames: Record<AgentId, string> = {
  "claude-code": "Claude Code",
  copilot: "Copilot",
  "cursor-agent": "Cursor's Agent",
  "windsurf-cascade": "Cascade",
};
export type AgentState =
  | "idle"
  | "working"
  | "needs_permission"
  | "review_edits"
  | "done"
  | "error"
  | "unknown";
export type RelayKind =
  "command" | "edit" | "tool" | "plan" | "continue" | "review";
export type RelayDecline =
  | { type: "key"; key: "ESC" }
  | { type: "click_text"; label: string }
  | { type: "none" };
/** A permission question the agent is showing, ready to be relayed to the user. */
export interface RelayCandidate {
  /** FNV-1a of the kind and the normalized question, for de-duplication. */
  key: string;
  kind: RelayKind;
  /** At most 160 characters, one line, secrets redacted. */
  question: string;
  /** The exact on-screen label that allows it once; never a "don't ask again" one. */
  allowLabel: string;
  decline: RelayDecline;
}
export interface PanelDigest {
  /** Normalized panel lines, top to bottom. */
  lines: string[];
  text: string;
  hash: string;
  state: AgentState;
  mode: "auto" | "ask" | "unknown";
  relay?: RelayCandidate;
  region?: Region;
}

/**
 * OCR reads an ellipsis as three dots, curly quotes as straight ones and the
 * command glyph before "Esc" as "#" or "X"; anchors are matched against this
 * lowercase, single-spaced form.
 */
export function normalizeOcr(s: string): string {
  return s
    .replace(/…/g, "...")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/⌘/g, "cmd")
    .replace(/(^|\s)[#xX](?=\s?esc\b)/gi, "$1cmd")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// Regular expressions over normalized lines. The Claude Code strings come
// from its VS Code extension bundle (research-ide.md); Copilot's from VS
// Code's own message table; Cursor's and Cascade's are unverified community
// reports, kept short so a wrong guess costs a wake, never an input.
const anchors: Record<AgentId, Partial<Record<AgentState, RegExp[]>>> = {
  "claude-code": {
    needs_permission: [
      /do you want to proceed/,
      /tell claude what to do instead/,
      /claude needs your permission/,
      /waiting for your permission/,
      /claude is waiting for your decision/,
      /claude is requesting permission/,
      /no, keep planning/,
    ],
    working: [
      /queue another message/,
      /claude is working/,
      /esc to interrupt/,
      /compacting conversation/,
    ],
    idle: [
      /ask claude to edit/,
      /cmd ?esc to focus or unfocus claude/,
      /ready for your input/,
    ],
    done: [/^finished$/, /^stopped$/, /claude is waiting for your input/],
    error: [/\binterrupted\b/, /api error/, /^failed$/],
  },
  copilot: {
    needs_permission: [
      /\brun .{1,80} command\?/,
      /waiting for confirmation/,
      /continue to iterate\?/,
      /allow in this session/,
      /always allow/,
    ],
    review_edits: [/keep all edits/, /undo all edits/],
    working: [/^working\b/, /thinking\.\.\./, /waiting for tool/],
    idle: [/^chat input/, /ask copilot/, /press enter to send/],
    done: [/new chat response/],
    error: [/^retry$/],
  },
  "cursor-agent": {
    needs_permission: [/\brun\b.*\bskip\b/],
    review_edits: [/keep all/, /undo all/, /review next file/],
    working: [/^generating/],
  },
  "windsurf-cascade": {
    needs_permission: [/\baccept\b.*\breject\b/, /^continue$/],
    working: [/^generating/, /^running/],
  },
};
// When several states show at once, the one that needs the user wins, then
// a failure, then activity: a permission question sits above the "esc to
// interrupt" spinner while the agent waits for it.
const statePriority: AgentState[] = [
  "needs_permission",
  "review_edits",
  "error",
  "working",
  "done",
  "idle",
];
const agents = Object.keys(anchors) as AgentId[];

function matchesAny(patterns: RegExp[] | undefined, line: string): boolean {
  return !!patterns?.some((p) => p.test(line));
}
function classify(
  agent: AgentId,
  lines: readonly string[],
  states: readonly AgentState[] = statePriority,
): AgentState {
  for (const state of states)
    if (lines.some((line) => matchesAny(anchors[agent][state], line)))
      return state;
  return "unknown";
}
const askingStates: AgentState[] = ["needs_permission", "review_edits"];
const activityStates: AgentState[] = ["error", "working", "done", "idle"];
/**
 * The panel's state. A question for the user counts wherever it is: the
 * agent shows it once and takes it down when answered. The activity states
 * are read from the bottom of the panel first, where the placeholder, the
 * spinner and the status sit, because the transcript above may still quote
 * an "interrupted" from an earlier turn; the whole panel is read only when
 * the bottom says nothing.
 */
export function panelState(
  agent: AgentId,
  lines: readonly { t: string; y: number; h: number }[],
): AgentState {
  const all = lines.map((l) => l.t);
  const asking = classify(agent, all, askingStates);
  if (asking !== "unknown") return asking;
  const bottom = lines.filter((l) => l.y + l.h >= 0.6).map((l) => l.t);
  const fromBottom = classify(agent, bottom, activityStates);
  if (fromBottom !== "unknown") return fromBottom;
  return classify(agent, all, activityStates);
}
/** Whether any of the agent's anchors appears in the line. */
export function isAnchor(agent: AgentId, line: string): boolean {
  return statePriority.some((state) => matchesAny(anchors[agent][state], line));
}
/**
 * Which agent the window seems to hold, from its anchors alone: the agent
 * with the most anchor lines, or undefined when none shows one.
 */
export function resolveAgent(lines: readonly OcrLine[]): AgentId | undefined {
  let best: { agent: AgentId; hits: number } | undefined;
  for (const agent of agents) {
    const hits = lines.filter((l) => isAnchor(agent, normalizeOcr(l.t))).length;
    if (hits && (!best || hits > best.hits)) best = { agent, hits };
  }
  return best?.agent;
}

/**
 * The column of the window that holds the agent's panel, from where its
 * anchor lines start: a panel docked on the right runs from the anchors' left
 * margin to the window's edge, one on the left from the edge to just past
 * the anchors. Undefined when the anchors are in the middle or absent, in
 * which case the whole window is read.
 */
export function panelColumn(
  lines: readonly OcrLine[],
  agent?: AgentId,
): Region | undefined {
  const which = agent ? [agent] : agents;
  const hits = lines.filter((l) => {
    const t = normalizeOcr(l.t);
    return which.some((a) => isAnchor(a, t));
  });
  if (!hits.length) return undefined;
  const left = Math.min(...hits.map((l) => l.x));
  const right = Math.max(...hits.map((l) => l.x + l.w));
  if (left >= 0.4) {
    const x = round3(Math.max(0, left - 0.03));
    return { x, y: 0, w: round3(1 - x), h: 1 };
  }
  if (right <= 0.6)
    return { x: 0, y: 0, w: round3(Math.min(1, right + 0.05)), h: 1 };
  return undefined;
}
const round3 = (value: number) => Math.round(value * 1000) / 1000;
/** Rows of context kept above the topmost anchor of a panel that has no column. */
const BAND_ABOVE = 0.15;
/** And below its lowest one. */
const BAND_BELOW = 0.05;
/**
 * The part of the window whose text may leave the watch: the agent panel's
 * column when it is docked at a side, otherwise (a panel docked at the
 * bottom, or anchors mid-window) a band around the anchors a few rows tall.
 * Undefined when the window shows no anchors at all: the whole window is
 * then read for change detection, but none of its text leaves.
 */
export function panelRegion(
  lines: readonly OcrLine[],
  agent?: AgentId,
): Region | undefined {
  const column = panelColumn(lines, agent);
  if (column) return column;
  const which = agent ? [agent] : agents;
  const hits = lines.filter((l) => {
    const t = normalizeOcr(l.t);
    return which.some((a) => isAnchor(a, t));
  });
  if (!hits.length) return undefined;
  const top = Math.min(...hits.map((l) => l.y));
  const bottom = Math.max(...hits.map((l) => l.y + l.h));
  const y = round3(Math.max(0, top - BAND_ABOVE));
  return {
    x: 0,
    y,
    w: 1,
    h: round3(Math.min(1, bottom + BAND_BELOW) - y),
  };
}
/** A line is in the column when it starts inside it. */
export function inRegion(line: OcrLine, region: Region | undefined): boolean {
  if (!region) return true;
  return (
    line.x >= region.x - 0.001 &&
    line.x < region.x + region.w &&
    line.y >= region.y - 0.001 &&
    line.y < region.y + region.h
  );
}

/** FNV-1a over UTF-16 code units, as 8 hex digits; in-memory only. */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Share of lines that differ between two reads: 1 - |A∩B| / |A∪B|. */
export function materialChange(
  prev: readonly string[],
  next: readonly string[],
): number {
  const a = new Set(prev),
    b = new Set(next);
  if (!a.size && !b.size) return 0;
  let both = 0;
  for (const line of a) if (b.has(line)) both++;
  const union = a.size + b.size - both;
  return union ? 1 - both / union : 0;
}

/** Buttons that grant more than one use are never the allow route. */
export const FORBIDDEN_ALLOW_LABEL =
  /don'?t ask again|allow all|always allow|in this session|in this workspace|bypass|run everything|turbo|autopilot|auto[- ]?accept|auto approve/;
const optionLine =
  /^(?:\d+\.\s|yes\b|no\b|esc to cancel|tell claude what|allow\b|skip\b|keep\b|undo\b|continue\b|run\b|cancel\b|submit answers)/;
interface RelayRoute {
  allowLabel: string;
  decline: RelayDecline;
}
function relayRoute(agent: AgentId, kind: RelayKind): RelayRoute {
  if (agent === "claude-code")
    return kind === "plan"
      ? {
          allowLabel: "Yes, and manually approve edits",
          decline: { type: "click_text", label: "No, keep planning" },
        }
      : { allowLabel: "Yes", decline: { type: "key", key: "ESC" } };
  if (agent === "copilot") {
    if (kind === "continue")
      return { allowLabel: "Continue", decline: { type: "none" } };
    if (kind === "review")
      return { allowLabel: "Keep", decline: { type: "none" } };
    return {
      allowLabel: "Allow",
      decline: { type: "click_text", label: "Skip" },
    };
  }
  if (kind === "review")
    return { allowLabel: "Keep All", decline: { type: "none" } };
  return { allowLabel: "Run", decline: { type: "click_text", label: "Skip" } };
}
function relayKind(
  agent: AgentId,
  state: AgentState,
  anchor: string,
): RelayKind {
  if (state === "review_edits") return "review";
  if (/continue to iterate/.test(anchor)) return "continue";
  if (/keep planning/.test(anchor)) return "plan";
  if (/\bbash\b|\bcommand\b|\brun\b|\bshell\b|\bterminal\b/.test(anchor))
    return "command";
  if (/\b(edit|write|create|update|delete)\b/.test(anchor)) return "edit";
  return "tool";
}
/**
 * The question the agent is asking: its anchor line, up to three lines above
 * it and the lines below it up to the first option (the tool and its command
 * sit above the question in the CLI and below it in the editor card), minus
 * the option lines, redacted and bounded.
 */
function relayOf(
  agent: AgentId,
  state: AgentState,
  lines: readonly string[],
): RelayCandidate | undefined {
  const states: AgentState[] =
    state === "review_edits" ? ["review_edits"] : ["needs_permission"];
  const index = lines.findIndex((line) =>
    states.some((s) => matchesAny(anchors[agent][s], line)),
  );
  if (index < 0) return undefined;
  const anchor = lines[index];
  const kind = relayKind(agent, state, anchor);
  const below: string[] = [];
  for (const line of lines.slice(index + 1, index + 3)) {
    if (optionLine.test(line)) break;
    below.push(line);
  }
  const context = [
    ...lines
      .slice(Math.max(0, index - 3), index + 1)
      .filter((line) => line === anchor || !optionLine.test(line)),
    ...below,
  ];
  const question = redactSecrets(context.join(" "))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  const route = relayRoute(agent, kind);
  return {
    key: fnv1a(`${kind}|${question}`),
    kind,
    question,
    ...route,
  };
}
const autoMode =
  /bypass permissions|auto-accept edits|edit automatically|run everything|autopilot|turbo|allow all/;
const askMode = /ask before edits|\bmanual\b|plan mode/;

const SECRET_PLACEHOLDER = "[Sensitive text omitted]";
/**
 * The lines with every credential-like span replaced, found in the text as
 * read: several patterns depend on case (AKIA…, AIza…, the BEGIN line of a
 * private key) and a private key runs over many lines, so neither survives
 * normalizing first. A span over several lines leaves the placeholder on its
 * first and empties the rest, so every line keeps its own box.
 */
export function redactLines(texts: readonly string[]): string[] {
  const flat = texts.map((t) => t.replace(/[\r\n]+/g, " "));
  const joined = flat.join("\n");
  const secrets = scanText(joined).filter((f) => f.action === "BLOCK_UPLOAD");
  if (!secrets.length) return flat;
  let out = "",
    cursor = 0;
  for (const f of secrets) {
    if (f.end <= cursor) continue;
    const start = Math.max(cursor, f.start);
    const breaks = joined.slice(start, f.end).split("\n").length - 1;
    out +=
      joined.slice(cursor, start) + SECRET_PLACEHOLDER + "\n".repeat(breaks);
    cursor = f.end;
  }
  return (out + joined.slice(cursor)).split("\n");
}

/**
 * Everything the watch keeps from one read of the panel: the lines inside the
 * panel column, redacted and then normalized, a hash of them, the state they
 * show, the agent's permission mode and any question waiting for the user.
 */
export function digestPanel(
  lines: readonly OcrLine[],
  agent: AgentId | undefined,
  region?: Region,
): PanelDigest {
  const inside = lines.filter((l) => inRegion(l, region));
  const redacted = redactLines(inside.map((l) => l.t));
  const kept = inside
    .map((l, i) => ({ ...l, t: normalizeOcr(redacted[i] ?? "") }))
    .filter((l) => l.t);
  const texts = kept.map((l) => l.t);
  const text = texts.join("\n");
  const state = agent ? panelState(agent, kept) : "unknown";
  const mode = autoMode.test(text)
    ? "auto"
    : askMode.test(text)
      ? "ask"
      : "unknown";
  const relay =
    agent && (state === "needs_permission" || state === "review_edits")
      ? relayOf(agent, state, texts)
      : undefined;
  return {
    lines: texts,
    text,
    hash: fnv1a(text),
    state,
    mode,
    ...(relay ? { relay } : {}),
    ...(region ? { region } : {}),
  };
}

/** What a monitor action asked for, in milliseconds. */
export interface WatchSpec {
  reason: string;
  everyMs: number;
  maxMs: number;
  until: "done" | "input" | "change";
  /**
   * The window showed no anchors on an earlier watch: only the clock and,
   * for "change", the text can wake the model, never a state.
   */
  timersOnly?: boolean;
}
/**
 * A watch, the wake-up run it starts, the watch that run may start in turn,
 * and so on: counted from the request that began it. watchMaxMinutes and a
 * number of wakes bound the whole chain, since each wake-up run has its own
 * budget and could otherwise watch again for as long as the user is away.
 */
export interface WatchChain {
  /** When the first watch of the chain started. */
  startedAt: number;
  /** Wake-up runs the chain has started so far. */
  wakes: number;
  /** How the request that began it was made, so every answer comes back the same way. */
  origin?: RunOrigin;
}
export function watchSpec(action: {
  reason: string;
  every_s: number;
  max_min: number;
  until: "done" | "input" | "change";
}): WatchSpec {
  return {
    reason: redactSecrets(action.reason).slice(0, 200),
    everyMs: action.every_s * 1000,
    maxMs: action.max_min * 60000,
    until: action.until,
  };
}

export type WakeCause =
  | "done"
  | "error"
  | "idle"
  | "stalled"
  | "changed"
  | "expired"
  | "unknown"
  | "window_gone"
  | "probe_failed";
export type WatchDecision =
  | { kind: "sleep"; nextMs: number }
  | { kind: "summary"; progress: "summary" | "stalled" }
  | { kind: "relay"; relay: RelayCandidate }
  | { kind: "wake"; cause: WakeCause };
export interface WatchMemory {
  startedAt: number;
  state: AgentState;
  stateSince: number;
  lastChangeAt: number;
  unchangedTicks: number;
  unknownTicks: number;
  probeFailures: number;
  lastSummaryAt: number;
  summaryLines: string[];
  lastHash?: string;
  lastLines: string[];
  /** The agent was seen working at least once, so idle now means finished. */
  sawWorking: boolean;
  idleTicks: number;
  stalledReportedAt?: number;
  /** Relay keys already surfaced, by the time they were. */
  relayKeys: Record<string, number>;
  pendingRelayKey?: string;
}
export function newWatchMemory(now: number): WatchMemory {
  return {
    startedAt: now,
    state: "unknown",
    stateSince: now,
    lastChangeAt: now,
    unchangedTicks: 0,
    unknownTicks: 0,
    probeFailures: 0,
    lastSummaryAt: now,
    summaryLines: [],
    lastLines: [],
    sawWorking: false,
    idleTicks: 0,
    relayKeys: {},
  };
}
export interface WatchSettings {
  progressEveryMinutes: number;
  stallMinutes: number;
  watchMaxMinutes: number;
}
export interface WatchTick {
  memory: WatchMemory;
  decision: WatchDecision;
  stateChanged?: { from: AgentState; to: AgentState };
  /** A relayed question vanished from the panel: the user answered it there. */
  relayGone?: string;
  /** The read differed from the previous one. */
  changed: boolean;
}
/** Consecutive failed reads before the watch gives up. */
export const PROBE_FAILURE_LIMIT = 3;
/** Reads with no anchors before the model is told it cannot see the panel. */
export const UNKNOWN_TICK_LIMIT = 3;
/** A relayed question is surfaced again only after this long. */
export const RELAY_REPEAT_MS = 2 * 60 * 1000;
/** Probe cadence while a question waits for the user. */
export const RELAY_POLL_MS = 5000;
/** Longest the cadence backs off to while nothing changes. */
export const BACKOFF_MAX_MS = 30000;
/** Share of lines that must differ for an "until change" wake or a summary. */
export const MATERIAL_CHANGE = 0.15;
/** The first summary is due after five minutes whatever the cadence says. */
const FIRST_SUMMARY_MS = 5 * 60 * 1000;
// Idle after working means the agent finished; idle from the start needs a
// full minute (at the default cadence) because a prompt just sent can show
// the idle placeholder for a moment before the spinner appears.
const IDLE_AFTER_WORK_TICKS = 2;
const IDLE_FROM_START_TICKS = 6;

/**
 * One tick of a watch. Pure: returns the next memory and what to do, never
 * mutating the memory it was given. `digest` is undefined when the read
 * failed (the caller has already skipped reads that do not count, such as
 * secure input). Checks in priority order: expiry, failures, a question for
 * the user, a change the caller asked to be woken for, the agent's end
 * states, an unreadable panel, a stall, a summary, and otherwise sleep.
 */
export function watchTick(
  m: WatchMemory,
  digest: PanelDigest | undefined,
  now: number,
  spec: WatchSpec,
  s: WatchSettings,
): WatchTick {
  const memory: WatchMemory = { ...m, relayKeys: { ...m.relayKeys } };
  const maxMs = Math.min(spec.maxMs, s.watchMaxMinutes * 60000);
  if (now - memory.startedAt >= maxMs)
    return {
      memory,
      decision: { kind: "wake", cause: "expired" },
      changed: false,
    };
  if (!digest) {
    memory.probeFailures++;
    return memory.probeFailures >= PROBE_FAILURE_LIMIT
      ? {
          memory,
          decision: { kind: "wake", cause: "probe_failed" },
          changed: false,
        }
      : {
          memory,
          decision: { kind: "sleep", nextMs: spec.everyMs },
          changed: false,
        };
  }
  memory.probeFailures = 0;
  const first = memory.lastHash === undefined;
  const changed = !first && digest.hash !== memory.lastHash;
  const material = first ? 0 : materialChange(memory.lastLines, digest.lines);
  const previousLines = memory.lastLines;
  memory.lastHash = digest.hash;
  memory.lastLines = digest.lines;
  if (first || changed) {
    memory.lastChangeAt = now;
    memory.unchangedTicks = 0;
    memory.stalledReportedAt = undefined;
  } else memory.unchangedTicks++;
  let stateChanged: WatchTick["stateChanged"];
  if (digest.state !== memory.state) {
    stateChanged = { from: memory.state, to: digest.state };
    memory.state = digest.state;
    memory.stateSince = now;
  }
  if (digest.state === "working") memory.sawWorking = true;
  memory.idleTicks = digest.state === "idle" ? memory.idleTicks + 1 : 0;
  memory.unknownTicks =
    digest.state === "unknown" ? memory.unknownTicks + 1 : 0;
  const tick = (decision: WatchDecision, relayGone?: string): WatchTick => ({
    memory,
    decision,
    ...(stateChanged ? { stateChanged } : {}),
    ...(relayGone ? { relayGone } : {}),
    changed,
  });
  // A question on screen: surface it once, then poll quickly until it is
  // answered in the editor. Nothing else can wake the model past it.
  let relayGone: string | undefined;
  if (digest.relay) {
    const key = digest.relay.key;
    if (memory.pendingRelayKey === key)
      return tick({ kind: "sleep", nextMs: RELAY_POLL_MS });
    const seenAt = memory.relayKeys[key];
    if (seenAt !== undefined && now - seenAt < RELAY_REPEAT_MS)
      return tick({ kind: "sleep", nextMs: RELAY_POLL_MS });
    memory.relayKeys[key] = now;
    memory.pendingRelayKey = key;
    return tick({ kind: "relay", relay: digest.relay });
  }
  if (memory.pendingRelayKey) {
    relayGone = memory.pendingRelayKey;
    memory.pendingRelayKey = undefined;
  }
  if (
    spec.until === "change" &&
    previousLines.length &&
    material >= MATERIAL_CHANGE
  )
    return tick({ kind: "wake", cause: "changed" }, relayGone);
  if (!spec.timersOnly) {
    if (digest.state === "error")
      return tick({ kind: "wake", cause: "error" }, relayGone);
    if (digest.state === "done")
      return tick({ kind: "wake", cause: "done" }, relayGone);
    const settled =
      digest.state === "idle" &&
      memory.idleTicks >=
        (memory.sawWorking ? IDLE_AFTER_WORK_TICKS : IDLE_FROM_START_TICKS);
    if (settled)
      return tick(
        { kind: "wake", cause: spec.until === "input" ? "idle" : "done" },
        relayGone,
      );
    // A window with no agent in it is unreadable by design when the caller
    // asked to be woken by a change (a build, a download, a render): only
    // the change itself, or the clock, wakes the model then.
    if (spec.until !== "change" && memory.unknownTicks >= UNKNOWN_TICK_LIMIT)
      return tick({ kind: "wake", cause: "unknown" }, relayGone);
    // Working with the same text for stallMinutes: say so once, and wake the
    // model after as long again.
    const stallMs = s.stallMinutes * 60000;
    if (digest.state === "working" && now - memory.lastChangeAt >= stallMs) {
      if (memory.stalledReportedAt === undefined) {
        memory.stalledReportedAt = now;
        return tick({ kind: "summary", progress: "stalled" }, relayGone);
      }
      if (now - memory.stalledReportedAt >= stallMs)
        return tick({ kind: "wake", cause: "stalled" }, relayGone);
    }
  }
  if (s.progressEveryMinutes > 0) {
    const due =
      memory.summaryLines.length === 0
        ? now - memory.startedAt >= FIRST_SUMMARY_MS
        : now - memory.lastSummaryAt >= s.progressEveryMinutes * 60000;
    if (
      due &&
      materialChange(memory.summaryLines, digest.lines) >= MATERIAL_CHANGE
    ) {
      memory.lastSummaryAt = now;
      memory.summaryLines = digest.lines;
      return tick({ kind: "summary", progress: "summary" }, relayGone);
    }
  }
  // Back off while the panel does not change, so an hour of quiet work costs
  // a read every half minute rather than every ten seconds.
  const nextMs =
    digest.state === "working" && memory.unchangedTicks >= 3
      ? Math.min(
          BACKOFF_MAX_MS,
          spec.everyMs * 2 ** (memory.unchangedTicks - 2),
        )
      : spec.everyMs;
  return tick({ kind: "sleep", nextMs }, relayGone);
}

/** The last part of the panel, for a progress summary or a wake-up: bounded and redacted. */
export function panelTail(lines: readonly string[], limit = 1500): string {
  const text = redactSecrets(lines.join("\n"));
  return text.length > limit ? text.slice(text.length - limit) : text;
}
