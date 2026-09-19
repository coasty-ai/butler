import type { RunStatus } from "../core/schema";
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

/** A learned user preference (from corrections or repeated app choices). */
export interface Preference {
  id: string;
  kind: "preference";
  text: string;
  tokens: string[];
  weight: number;
  source: "correction" | "usage";
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
}

export interface MemoryData {
  version: 1;
  episodes: Episode[];
  preferences: Preference[];
  skills: Skill[];
  apps: Record<string, AppUsage>;
}
