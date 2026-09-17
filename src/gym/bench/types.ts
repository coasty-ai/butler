import type { ScreenContext } from "../../core/schema";

/** The kind of work a benchmark task exercises. */
export type BenchCategory =
  "browser" | "notes" | "calculator" | "files" | "media" | "multi-app";
export type BenchDifficulty = "easy" | "medium" | "hard";
/**
 * "unknown" is a first-class outcome: a grader that cannot read the end state
 * says so instead of guessing. Only verified end state is ever "passed".
 */
export type GradeStatus = "passed" | "failed" | "unknown";

/** One executed action, reduced to what a grader may read. */
export interface JournalStep {
  type: string;
  /** Frontmost application when the step executed. */
  appId?: string;
  textLength?: number;
  launchedAppId?: string;
  launchedFrontmost?: boolean;
  openedPath?: string;
  openedAppId?: string;
}

/** A finished run, summarised for grading and for the results table. */
export interface RunJournal {
  /** Terminal run status, or the last status the run reached. */
  status: string;
  /** The run settled on its own (completed, cancelled or failed). */
  settled: boolean;
  actions: number;
  steps: JournalStep[];
  /** Approvals the policy asked for. */
  approvals: number;
  approvalsDeclined: number;
  /** Unidentified-target retries (ActionRetargetRequested). */
  retries: number;
  /** Hand-offs to the user, whatever their source. */
  takeovers: number;
  /** At least one hand-off came from real input on this Mac, not the policy. */
  manualTakeover: boolean;
  loops: number;
  /** Failure codes seen during the run (STATE_CHANGED, INVALID_ACTION, ...). */
  failures: Record<string, number>;
  cost: number;
  seconds: number;
  /** Model calls the run made; a replayed plan makes none. */
  modelCalls: number;
}

/**
 * Everything a grader is allowed to look at: the end state read back through
 * the native controller, and the run's own journal. Never a screenshot.
 */
export interface Evidence {
  /** Frontmost bundle id after the run. */
  appId?: string;
  /** Accessibility context of the frontmost window. */
  context?: ScreenContext;
  /** Committed page host from Surface.domain, when a browser is frontmost. */
  domain?: string;
  journal: RunJournal;
  /** Values prepare() resolved for this attempt (a token, a file path). */
  parameters: Record<string, string>;
}

export interface Grade {
  status: GradeStatus;
  /** Named boolean checks, so a failure says which condition did not hold. */
  checks: Record<string, boolean>;
  /** A fixed reason code. Never screen text, a title, a path or a URL. */
  reason?: string;
}

/** What prepare() may use to resolve per-attempt parameters. */
export interface PrepareContext {
  /** The native system index (apps, folders, recent files, name matches). */
  index(query: string): Promise<{
    apps?: { name: string; bundleId: string }[];
    folders?: { name: string; path: string }[];
    recentFiles?: {
      name: string;
      path: string;
      kind: string;
      lastUsed?: string;
    }[];
    matches?: { name: string; path: string; kind: string }[];
  }>;
  /** A short unique marker for self-cleaning tasks. */
  token(): string;
}

export interface BenchTask {
  id: string;
  /**
   * The spoken instruction. `{name}` placeholders are filled from the
   * parameters prepare() resolved. Only this template is ever reported: a
   * filled instruction can contain the user's own file names.
   */
  instruction: string;
  /** Bundle ids the task needs on this Mac. */
  apps: string[];
  category: BenchCategory;
  difficulty: BenchDifficulty;
  /** Hard cost cap for one attempt, in dollars. */
  maxCost: number;
  /** Action budget for one attempt. */
  maxActions: number;
  /** Wall-clock budget for one attempt, in seconds. */
  maxSeconds: number;
  /** Why this task is safe to run unattended. */
  safety: string;
  /** What the grader verifies, in one line, for docs and --dry-run. */
  verifies: string;
  /**
   * Resolves per-attempt parameters. Returning null skips the attempt as
   * "unknown" (for example: nothing in the index to open).
   */
  prepare?: (context: PrepareContext) => Promise<Record<string, string> | null>;
  grade: (evidence: Evidence) => Grade;
}
