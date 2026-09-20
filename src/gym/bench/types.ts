import type { TakeoverSource } from "../../core/runner";
import type { ScreenContext } from "../../core/schema";

export type { TakeoverSource };

/** The kind of work a benchmark task exercises. */
export type BenchCategory =
  // The smoke suite.
  | "browser"
  | "notes"
  | "calculator"
  | "files"
  | "media"
  | "multi-app"
  // The long-horizon suite (browser, files, media and multi-app are shared).
  | "research-note"
  | "agenda"
  | "text-editing"
  | "ide"
  | "settings"
  | "recovery"
  // The market suite (files is shared with the suites above).
  | "messaging"
  | "routines"
  | "email"
  | "calendar"
  | "reminders"
  | "memory"
  | "research"
  | "shopping"
  | "coding"
  | "smart-home"
  | "business-ops"
  | "dictation";
export type BenchDifficulty = "easy" | "medium" | "hard";
export type BenchSuite = "smoke" | "long" | "market";
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
  /**
   * Attempt parameters (the token, a fixture name) that occur in the typed
   * text on their own, not as part of a longer parameter such as the bench
   * folder path. Never the text itself.
   */
  markers?: string[];
  /** Last element of a menu_item path, lowercased: the application's own menu title. */
  menuLeaf?: string;
  /**
   * A tool_call step's tool id, for a first-party tool only ("files__append_text_file");
   * a user server's id is not written, nor ever an argument or a result.
   */
  tool?: string;
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
  /** Hand-offs by what asked for them. The counts sum to `takeovers`. */
  takeoverSources: Record<TakeoverSource, number>;
  /** At least one hand-off came from real input on this Mac, not the policy. */
  manualTakeover: boolean;
  /**
   * The model proposed `fail`: an honest give-up, which the runner records as
   * a failed run. A task that expects a hand-off accepts it as one.
   */
  modelFailed: boolean;
  loops: number;
  /** Same-type actions that changed nothing on screen (NoProgressDetected). */
  noProgress: number;
  /** Clicks by name the helper read as no effect on every route (ActionExecuted effect none). */
  clickNoEffect?: number;
  /** Failure codes seen during the run (STATE_CHANGED, INVALID_ACTION, ...). */
  failures: Record<string, number>;
  /**
   * How the run ended, in the analyzer's vocabulary: COMPLETED, ACTION_BUDGET,
   * STOPPED_AFTER_HANDOFF, STOPPED_AFTER_MANUAL_TAKEOVER, RUN_ERROR, ...
   */
  endingCode: string;
  cost: number;
  seconds: number;
  /** Model calls the run made; a replayed plan makes none. */
  modelCalls: number;
}

/** One item under the attempt's bench folder. Dotfiles are never listed. */
export interface FileEntry {
  /** "/"-separated path relative to the bench folder. */
  path: string;
  kind: "file" | "folder";
  size: number;
  sha256: string;
  /** Lowercased plain text of .txt/.md/.csv/.rtf files up to 256 KB. */
  text?: string;
}
export interface FileEvidence {
  root: string;
  entries: FileEntry[];
}
export interface AgendaItem {
  kind: "event" | "reminder";
  title: string;
  /** Events: ISO 8601 with offset. */
  start?: string;
  end?: string;
  allDay?: boolean;
  /** Reminders. */
  due?: string;
  completed?: boolean;
  /** The calendar or list holding the item, so a stray write is detectable. */
  calendar?: string;
  /** The item repeats; `start` or `due` is then the first occurrence. */
  recurring?: boolean;
}
export interface AgendaEvidence {
  access: { calendar: string; reminders: string };
  /** Every event within a window and every reminder whose title carries the token. */
  items: AgendaItem[];
}
export interface MusicEvidence {
  available: boolean;
  player: "playing" | "paused" | "stopped" | "unknown";
  playlists: { name: string; tracks: number }[];
}
export interface FixtureEvidence {
  port: number;
  /** Paths the fixture server served for this token, in order ("/<token>/orders/ORD-4471"). */
  visits: string[];
  submissions: { path: string; fields: Record<string, string> }[];
}
/** End-state readers the harness runs after an attempt, on request only. */
export type EvidenceReader = "files" | "agenda" | "music" | "fixture";

/**
 * Everything a grader is allowed to look at: the end state read back through
 * the native controller, the run's own journal, and whichever readers the task
 * declared. Never a screenshot.
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
  files?: FileEvidence;
  agenda?: AgendaEvidence;
  music?: MusicEvidence;
  fixture?: FixtureEvidence;
}

/**
 * How a note task's file came to hold its text: through the files tool (a
 * `files__append_text_file` or `files__replace_file_text` step), through an
 * editor (a step with TextEdit in front), or neither. When both appear the
 * later one is the route: it is the write the file's text came from.
 */
export type NoteRoute = "tool" | "editor" | "none";

export interface Grade {
  status: GradeStatus;
  /**
   * Named boolean checks, so a failure says which condition did not hold. A
   * check with several facts in it (`noted`) carries each as a sub-check
   * named `<check>.<fact>` (`noted.hour`), so the row says which fact was
   * missing, never what it was.
   */
  checks: Record<string, boolean>;
  /** A fixed reason code. Never screen text, a title, a path or a URL. */
  reason?: string;
  /** Hard checks passed / hard checks total. Partial credit for long tasks; never a pass. */
  partial?: number;
  /**
   * The false sub-checks of the check `reason` names, by fact name
   * (`["hour", "alert"]`). Set only when that check has sub-checks. The
   * names are the grader's own constants, never a drawn value or the file's text.
   */
  missingFacts?: string[];
  /** For a task that writes a note: how the note was produced (see NoteRoute). */
  noteRoute?: NoteRoute;
}

/** The loopback fixture server, when the harness started one. */
export interface FixtureHandle {
  port: number;
  /** Base URL, "http://127.0.0.1:<port>". */
  url: string;
  /** Registers a token's pages; returns that token's base URL. */
  register(token: string, pages: Record<string, string>): string;
  /** What the server saw for a token since it was registered or reset. */
  read(token: string): FixtureEvidence;
  reset(token: string): void;
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
  /** This attempt's marker: "benchnote" + 4 base-36 characters. */
  token(): string;
  /** The attempt's bench folder, created empty before prepare: absolute. */
  benchDir: string;
  /** The same folder as the instruction says it: "~/OpenAssistBench/<token>". */
  benchPath: string;
  /** Writes a fixture file inside benchDir. Refuses "..", absolute paths and dotfiles. */
  write(relative: string, content: string): Promise<void>;
  /**
   * Creates a calendar event or reminder carrying the token in the local
   * OpenAssistBench containers. Absent when the agenda helper is unavailable;
   * prepare returns null to skip the attempt.
   */
  agenda?: { add(item: AgendaItem): Promise<void> };
  /** This token's view of the fixture server. Absent when none is running. */
  fixture?: { url: string; register(pages: Record<string, string>): string };
  /**
   * Wrong-start setup through LaunchServices (`open`), never through the
   * controller: a bench path, a URL, or a file in a named application. No
   * synthetic input, no frame, no permission prompt.
   */
  openWithLaunchServices(target: string, app?: string): Promise<void>;
  now(): Date;
}

export interface CleanupContext {
  benchDir: string;
  token: string;
}

export interface BenchTask {
  id: string;
  /**
   * The spoken instruction. `{name}` placeholders are filled from the
   * parameters prepare() resolved; `{browser}` from the harness's browser
   * choice (preflight.ts chooseBrowser), which every long or market task
   * that lists browsers must carry. Only this template is ever reported: a
   * filled instruction can contain the user's own file names.
   */
  instruction: string;
  /**
   * Bundle ids the task needs on this Mac. Browsers (graders.ts
   * BROWSER_APPS) and VS Code builds are alternatives: any one installed
   * serves, and the harness picks the browser that is not in the person's
   * use. Every other id is required as itself, and a long or market task is
   * skipped (APPS_OPEN) while one of them is open with a window that could
   * hold the person's work.
   */
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
  /** Default "smoke". */
  suite?: BenchSuite;
  /** "watch" is reserved for tasks that observe a coding agent; never run through Runner.start. */
  kind?: "run" | "watch";
  /** Executed steps a competent run needs: [human-paced minimum, generous maximum]. */
  steps?: [number, number];
  /** Readers the harness runs after the attempt; a task never reads outside its declaration. */
  evidence?: EvidenceReader[];
  /** Checks that define completion. runStatus "completed" with any of them false is a false done. */
  primary?: string[];
  /** The correct outcome is a hand-off (or an honest fail) with no mutation; hand-offs are not failures. */
  expectsHandoff?: boolean;
  /**
   * Exact approval reasons the harness may answer yes to under
   * --approve-routine ("Save these changes?"). Anything else is declined.
   */
  approve?: string[];
  /** Extra cleanup on top of the harness default. Returns leftover codes. */
  cleanup?: (context: CleanupContext) => Promise<string[]>;
}

/*
 * The contract between the suite lane (readers, fixtures, cleanup) and the
 * cycle lane (attempt, presence, cycle). Fixed here; neither lane edits it.
 */
export interface AttemptContext {
  token: string;
  benchDir: string;
  benchPath: string;
  fixture?: FixtureHandle;
}
export type EvidenceReaders = (
  task: BenchTask,
  ctx: AttemptContext,
) => Promise<Partial<Evidence>>;
/** Returns leftover codes (LEFTOVER_FILES, LEFTOVER_EVENT, ...). */
export type Cleanup = (
  task: BenchTask,
  ctx: AttemptContext,
) => Promise<string[]>;
