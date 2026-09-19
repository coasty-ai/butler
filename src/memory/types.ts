import type { RunStatus } from "../core/schema";
import type { BackgroundVerdict } from "../core/memory";
import type { ToolTier } from "../core/tools";

/**
 * Local, encrypted, self-improving memory. See docs/MEMORY.md for the design.
 * Everything here stays on the Mac; only a bounded, task-relevant MemoryContext
 * is sent to the configured model.
 */

/** A completed or failed task, kept for recall and as skill evidence. */
export interface Episode {
  id: string;
  kind: "episode";
  task: string;
  tokens: string[];
  status: RunStatus;
  outcome?: boolean;
  apps: string[];
  summary: string;
  corrections: string[];
  actions: number;
  /** Tool calls among the actions, when there were any. */
  tools?: number;
  cost: number;
  createdAt: string;
}

/**
 * What the owner decided about something Butler proposed from watching
 * (.data/design/observer.md §4): proposed until approved; "never" is a
 * refusal that later consolidations respect; retired is unseen for 30 days.
 */
export type ProposalStatus = "proposed" | "approved" | "retired" | "never";

/**
 * A learned user preference (from corrections, repeated app choices, or
 * watching). An observed preference is proposed until the owner approves
 * it; only a preference with no status or "approved" reaches the model.
 */
export interface Preference {
  id: string;
  kind: "preference";
  text: string;
  tokens: string[];
  /** Evidence: how many runs or observations supported it. */
  weight: number;
  source: "correction" | "usage" | "observed";
  /** Only set by the observer; absent means in force. */
  status?: ProposalStatus;
  createdAt: string;
  updatedAt: string;
}

/** One replayable step: pointer steps target a control by role and label. */
export interface SkillStep {
  /** Action without frame_id; pointer steps omit x/y and use target. Text may contain {slotN}. */
  action: Record<string, unknown>;
  target?: { role: string; label: string };
  /** Frontmost application expected before this step, when known. */
  expectAppId?: string;
  /** For a tool_call: the tier it was learned at, for the outline's wording. */
  tool?: { tier: ToolTier };
}

/** A procedure learned from successful runs, keyed by a task template. */
export interface Skill {
  id: string;
  kind: "skill";
  /** Normalized task with {slotN} placeholders, e.g. "play {slot0} on youtube". */
  trigger: string;
  tokens: string[];
  slots: string[];
  steps: SkillStep[];
  /** True when some step could not be expressed by label (hint only). */
  hintOnly: boolean;
  successes: number;
  failures: number;
  createdAt: string;
  lastUsed: string;
}

export interface AppUsage {
  bundleId: string;
  name: string;
  count: number;
  lastUsed: string;
  background?: AppBackground;
}

/**
 * What background runs learned about this application
 * (.data/design/background-actuation.md §5): which routes deliver and which
 * it ignores, so the next run starts at the right rung. Verdicts only, never
 * text. An entry older than BACKGROUND_RETRY_DAYS is not applied, so the
 * route is tried once more and the verdict refreshed.
 */
export interface AppBackground {
  /** Rung-1 presses (click_control, click, menu items, scroll by accessibility). */
  press?: BackgroundVerdict;
  /** Rung-1 text written by accessibility. */
  write?: BackgroundVerdict;
  /** Rung-2 clicks and scrolls posted to the process. */
  post?: BackgroundVerdict;
  /** Rung-2 keys posted to the process. */
  keys?: BackgroundVerdict;
  /** ISO time of the last observation. */
  observedAt: string;
  /** CFBundleShortVersionString at observation, when the helper reported one. */
  appVersion?: string;
}

/** One step of an observed routine: an application, maybe a site, maybe what was done there. */
export interface RoutineStep {
  appId: string;
  /** Display name when the consolidator knew one; the task text reads better with it. */
  appName?: string;
  host?: string;
  action?: string;
}
/** When a routine is due: local weekdays (0 = Sunday) and an hour window [from, to). */
export interface RoutineWindow {
  weekdays: number[];
  hourRange: [number, number];
}
/** How an approved routine's replays went; the pane shows them. */
export interface RoutineRuns {
  completed: number;
  corrected: number;
  undone: number;
  declined: number;
  failed: number;
}
/**
 * A recurring sequence the consolidator saw (.data/design/observer.md §4),
 * proposed until the owner approves it, then replayed at its window as an
 * ordinary run with origin "routine" (electron/routines.ts).
 */
export interface Routine {
  id: string;
  kind: "routine";
  name: string;
  tokens: string[];
  when: RoutineWindow;
  steps: RoutineStep[];
  /** Days it was observed on. */
  seen: number;
  firstSeen: string;
  lastSeen: string;
  /** 0–1: the consolidator's, then moved by replay outcomes. */
  confidence: number;
  status: ProposalStatus;
  /** An approved procedure whose trigger is the task text of a replay. */
  procedureId?: string;
  runs: RoutineRuns;
  /** Consecutive corrected replays; two send it back to proposed. */
  correctionStreak: number;
  /** The owner's corrections from replays sent back to proposed. */
  corrections?: string[];
  /** The last replay's start, so a window runs once a day. */
  lastRunAt?: string;
  /** When Butler last offered it aloud. */
  offeredAt?: string;
}
/**
 * A step list observed at least three times, generalised with slots.
 * Approval turns it into a Skill (src/memory/skills.ts); the skill's own
 * successes and failures are its replay counts.
 */
export interface Procedure {
  id: string;
  kind: "procedure";
  /** Task template with {slotN} placeholders, like a Skill's trigger. */
  trigger: string;
  tokens: string[];
  slots: string[];
  steps: SkillStep[];
  observedRuns: number;
  lastSeen: string;
  confidence: number;
  status: ProposalStatus;
  /** The Skill approval created. */
  skillId?: string;
}

/**
 * Version 2 adds what watching proposes (routines and procedures) beside
 * what runs taught (episodes, preferences, skills, apps); the store reads a
 * version 1 file and keeps every record (docs/MEMORY.md).
 */
export interface MemoryData {
  version: 2;
  episodes: Episode[];
  preferences: Preference[];
  skills: Skill[];
  apps: Record<string, AppUsage>;
  routines: Routine[];
  procedures: Procedure[];
}
