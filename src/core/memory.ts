import type { MemoryContext, RunStatus, Usage } from "./schema";
import type { ToolCode, ToolTier } from "./tools";

/**
 * The memory contract the run loop is written against. Implementations live in
 * src/memory (see docs/MEMORY.md); the storage shapes they persist stay there.
 * Core only needs these types, so an embedder can pass their own MemoryAccess
 * or none at all.
 */

/** Local system index returned by the native helper's "index" method. */
export interface SystemIndex {
  apps: {
    name: string;
    bundleId: string;
    lastUsed?: string;
    useCount?: number;
  }[];
  folders: { name: string; path: string }[];
  recentFiles: {
    name: string;
    path: string;
    kind: string;
    lastUsed?: string;
  }[];
  matches: { name: string; path: string; kind: string; lastUsed?: string }[];
}

/** A plan step resolved for this task (slots filled). */
export interface PlanStep {
  action: Record<string, unknown>;
  target?: { role: string; label: string };
  expectAppId?: string;
  /** For a tool_call: the tier it was learned at, for the outline's wording. */
  tool?: { tier: ToolTier };
}

export interface ReplayPlan {
  id: string;
  source: "skill" | "intent";
  /** replay: the runner proposes steps without model calls; hint: shown to the model only. */
  mode: "replay" | "hint";
  steps: PlanStep[];
  /**
   * Finish without a model call when this holds after the last step.
   * appId: that app is frontmost. host: the committed page host of the
   * frontmost browser window (Surface.domain) equals host or is a subdomain of
   * it; never the address-bar edit text. opened: the last open_file opened.
   */
  completeWhen?: { appId?: string; host?: string; opened?: boolean };
  /** Human-readable outline for MemoryContext.plan. */
  outline: string[];
}

export interface Recall {
  context: MemoryContext;
  plan?: ReplayPlan;
}

/** What the runner saw for one executed step (for learning). */
export interface TrajectoryStep {
  /** Executed action without frame_id. */
  action: Record<string, unknown>;
  /** Frontmost application when the step was proposed. */
  appId?: string;
  target?: { role?: string; label?: string };
  launchedAppId?: string;
  openedPath?: string;
  /** Set when a replay plan proposed this step (not the model). */
  fromPlan?: "skill" | "intent";
  /**
   * For a tool_call: the tool's id and tier, how the call ended, and the
   * argument keys that carry dates (a step with one is a hint, never
   * replayed: the date would be stale).
   */
  tool?: { id: string; tier: ToolTier; code: ToolCode; dateKeys: string[] };
}

export interface LearnInput {
  runId: string;
  task: string;
  status: RunStatus;
  synthetic: boolean;
  outcome?: boolean;
  summary: string;
  corrections: string[];
  steps: TrajectoryStep[];
  appsSeen: string[];
  /** Tool calls the run made; an episode records the count. */
  tools?: number;
  /**
   * True when the user acted during the run: a manual or policy takeover,
   * a request_user hand-off, or a correction. The trajectory then misses the
   * user's own steps, so no skill is learned or credited from it.
   */
  handsOn?: boolean;
  plan?: {
    id: string;
    source: "skill" | "intent";
    completedSteps: number;
    abandoned: boolean;
    /**
     * Why the plan was abandoned (runner reason code, e.g. paused, takeover,
     * interrupted, correction, declined, missing_control, stopped).
     */
    abandonReason?: string;
  };
  usage: Usage;
}

/** Runner-facing access. Implementations must never throw into the run. */
export interface MemoryAccess {
  recall(task: string, signal?: AbortSignal): Promise<Recall>;
  learn(input: LearnInput): void;
}
