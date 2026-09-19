/**
 * The public surface of the run loop: everything an embedder needs to drive
 * Butler against their own Controller, Provider and Recorder, and nothing
 * else. Re-exports only — no logic lives here.
 *
 * See docs/MODULARITY.md §7 for the fifteen-line example this exists to enable.
 * `src/core` depends on `zod` and on nothing else in the repository, which
 * `tests/boundaries.test.ts` enforces.
 */

// The state machine.
export {
  Runner,
  terminal,
  MANUAL_PAUSE_MESSAGE,
  TARGET_HANDOFF_MESSAGE,
  type TakeoverScope,
} from "./runner";

// Background runs: the note the model reads and the lines the pill shows.
export {
  BACKGROUND_NOTE,
  isForegroundRequest,
  spokenTargets,
} from "./background";

// Actions, settings and the geometry helpers.
export {
  actionSchema,
  validateAction,
  settingsSchema,
  defaultSettings,
  supportedKeys,
  normalizePixelCoordinates,
  sameGeometry,
  mapPoint,
} from "./schema";

// The safety policy.
export {
  evaluate,
  surfacePolicy,
  isInstallerName,
  INSTALLER_PATTERN,
} from "./policy";

// The tool layer's contract: ids, tiers, limits, texts and the runner-facing access.
export * from "./tools";

// Redaction and the private-endpoint rule.
export { scanText, sanitizeText, redactSecrets } from "./sanitize";
export { validateProviderEndpoint } from "./privacy";

// Auto-resume after manual input.
export { shouldAutoResume } from "./resume";

// The deterministic simulation, for a first run without permissions or a model.
export { TutorialController, TutorialProvider } from "./tutorial";

// A Recorder that persists nothing.
export { nullRecorder } from "./recorder";

// Control label and role rules, shared by learning and replay.
export {
  normalizeLabel,
  normalizeRole,
  labelMatches,
  utf16Prefix,
  CONTROL_LABEL_LIMIT,
  REPLAYABLE_ROLES,
} from "./labels";

// The error taxonomy.
export {
  ScreenChangedError,
  ProviderTransientError,
  NativeStoppedError,
  NativeActionError,
  HelperUnavailableError,
  SurfaceBlockedError,
  TargetError,
  screenChanges,
  screenChange,
  targetCodes,
  targetCode,
  type NativeActionCode,
  type ScreenChange,
  type TargetCode,
} from "./errors";

export type {
  Action,
  Settings,
  Controller,
  Provider,
  Recorder,
  Snapshot,
  Run,
  JournalEvent,
  Frame,
  Surface,
  Geometry,
  ScreenContext,
  Observation,
  Usage,
  ProviderResult,
  ExecutionResult,
  RunStatus,
  PrivacyMode,
  ProviderKind,
  MemoryContext,
  RunTarget,
  TargetSpec,
  Rung,
  BackgroundContext,
} from "./schema";

export type {
  MemoryAccess,
  Recall,
  ReplayPlan,
  PlanStep,
  TrajectoryStep,
  LearnInput,
  SystemIndex,
} from "./memory";
