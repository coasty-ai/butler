/**
 * Failure analysis over the local diagnostics stream.
 *
 * The log this reads can contain the user's real screen and speech: with
 * verbose diagnostics on it carries task text, summaries, window titles, URLs
 * and file paths. Nothing in this module ever copies that into its output. The
 * report is built only from counts, event types, application bundle ids, action
 * types, durations and fixed reason codes, and every value that reaches it
 * passes through one of the narrow readers below (`code`, `bundleId`, `count`).
 * Free-form text is read in exactly one place, `budgetCode`, which compares a
 * message against a fixed table and returns a code or nothing.
 */

export interface DiagnosticLine {
  timestamp?: string;
  event: string;
  data: Record<string, unknown>;
}

/** A short fixed code; anything else (a sentence, a number) is dropped. */
function code(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(value)
    ? value
    : undefined;
}
/**
 * The declined-approval pattern with the question's code behind it:
 * APPROVAL_DECLINED_SAVE_CHANGES beside APPROVAL_DECLINED. The suffix is one
 * of src/core/approval-codes.ts's codes as the runner stamped it on the event.
 */
export const APPROVAL_DECLINED_PREFIX = "APPROVAL_DECLINED_";
/**
 * A step sent back, by the runner's reason code (src/core/decision-codes.ts
 * retryCode, stamped on ActionRetargetRequested as reasonCode): the code
 * rides beside the class as RETRY_CONTROL_COVERED, and a policy denial's by
 * its code as POLICY_DENIED_CREDENTIAL.
 */
export const RETRY_PREFIX = "RETRY_";
export const POLICY_DENIED_PREFIX = "POLICY_DENIED_";
/**
 * A frame whose page text the helper cut short, by the helper's reason
 * (FrameCaptured textTruncated: time, nodes or chars, native/macos/WebText.swift):
 * TEXT_TRUNCATED_TIME. Counted per frame, so a run that scrolled through a
 * long page shows how many of its readings were partial.
 */
export const TEXT_TRUNCATED_PREFIX = "TEXT_TRUNCATED_";
/**
 * The retry codes that name a cause other than an unidentified target, and
 * the class each is: a wait for the end of the user's sentence, an
 * application that did not resolve or has no window, a refused address, a
 * control or menu item that is not there as named, a refused tool call. Any
 * other code (a target, field or key the policy could not identify) keeps
 * the role-based class.
 */
const RETRY_CLASS: Record<string, string> = {
  WAITING_FOR_SENTENCE: "RETRY_SPEAKING",
  APP_ALREADY_FRONTMOST: "APP_ALREADY_FRONTMOST",
  APP_UNRESOLVED: "APP_UNRESOLVED",
  APP_AMBIGUOUS: "APP_AMBIGUOUS",
  WINDOWLESS: "WINDOWLESS_APP",
  WINDOWLESS_REPEAT: "WINDOWLESS_APP",
  BAD_URL: "BAD_URL",
  CONTROL_NOT_FOUND: "CONTROL_NOT_FOUND",
  CONTROL_AMBIGUOUS: "CONTROL_NOT_FOUND",
  CONTROL_DISABLED: "CONTROL_NOT_FOUND",
  CONTROL_COVERED: "CONTROL_NOT_FOUND",
  MENU_ITEM_MISSING: "CONTROL_NOT_FOUND",
  MENU_ITEM_DISABLED: "CONTROL_NOT_FOUND",
};
/** The classes above that group several codes, so the code beside them says which. */
const GROUPED_RETRY_CLASSES = new Set(
  Object.values(RETRY_CLASS).filter((name, i, all) => all.indexOf(name) !== i),
);
/** An upper-snake approval code, so the pattern built from it stays one. */
function approvalCodeOf(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{1,39}$/.test(value)
    ? value
    : undefined;
}
/** A bundle identifier; anything without the reverse-DNS shape is dropped. */
function bundleId(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(value) &&
    value.includes(".")
    ? value
    : undefined;
}
function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
/** An opaque correlation id, so a human can find the run in the log. */
function runIdOf(data: Record<string, unknown>): string | undefined {
  const value = data.runId;
  return typeof value === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      value,
    )
    ? value
    : undefined;
}

/**
 * The only place a message is looked at. It is compared against the runner's
 * fixed budget and policy messages and turned into a code; the text itself is
 * never stored, returned or printed. A log written without verbose diagnostics
 * has no message at all, and the caller falls back to structured events.
 */
export function budgetCode(message: unknown): string | undefined {
  if (typeof message !== "string") return undefined;
  const table: [string, string][] = [
    ["Action budget reached.", "ACTION_BUDGET"],
    // The runner's loop breaker failed an unattended run whose reflection
    // step did not break the loop (src/core/runner.ts LOOP_STUCK_MESSAGE).
    [
      "Stuck: the same steps kept repeating without progress, so the run stopped before the objective was done.",
      "STUCK_LOOP",
    ],
    ["Runtime budget reached.", "RUNTIME_BUDGET"],
    ["Estimated cost budget reached.", "COST_BUDGET"],
    ["Repeated policy violations.", "POLICY_VIOLATIONS"],
    ["Invalid usage accounting.", "USAGE_ACCOUNTING"],
  ];
  for (const [phrase, reason] of table) if (message === phrase) return reason;
  return undefined;
}

/** Parses a diagnostics JSONL file. Malformed lines are counted, not read. */
export function parseDiagnostics(text: string): {
  lines: DiagnosticLine[];
  skipped: number;
} {
  const lines: DiagnosticLine[] = [];
  let skipped = 0;
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        skipped++;
        continue;
      }
      const record = parsed as Record<string, unknown>;
      if (typeof record.event !== "string") {
        skipped++;
        continue;
      }
      lines.push({
        timestamp:
          typeof record.timestamp === "string" ? record.timestamp : undefined,
        event: record.event,
        data:
          record.data && typeof record.data === "object"
            ? (record.data as Record<string, unknown>)
            : {},
      });
    } catch {
      skipped++;
    }
  }
  return { lines, skipped };
}

/**
 * The friction codes one event contributes. Every branch reads structured,
 * allow-listed fields only.
 */
export function frictionCodes(line: DiagnosticLine): string[] {
  const d = line.data;
  switch (line.event) {
    case "ActionRetargetRequested": {
      const launcher = code(d.launcherStatus);
      const action = code(d.actionType);
      // The runner's reason code says why the step was sent back. A cause
      // other than an unidentified target is its own class, and the code
      // rides beside a class that groups several codes; the roles decide only
      // when the code names a target the policy could not identify, or when
      // an older trace carries no code. Only an upper-snake code counts: a
      // sentence in the field, or OTHER, adds nothing.
      const why = approvalCodeOf(d.reasonCode);
      const named = why ? RETRY_CLASS[why] : undefined;
      const beside = why && why !== "OTHER" ? [`${RETRY_PREFIX}${why}`] : [];
      if (named)
        return GROUPED_RETRY_CLASSES.has(named) && named !== why
          ? [named, ...beside]
          : [named];
      if (why?.startsWith("TOOL_")) return ["TOOL_REFUSED", ...beside];
      if (launcher === "resolved" && action === "open_app")
        return ["APP_ALREADY_FRONTMOST"];
      if (launcher === "unresolved") return ["APP_UNRESOLVED"];
      if (launcher === "ambiguous") return ["APP_AMBIGUOUS"];
      if (launcher === "refused") return ["APP_REFUSED"];
      // No target and no focused role: the surface reported no accessibility
      // information at all, so the policy had nothing to identify.
      const surface =
        !code(d.targetRole) && !code(d.focusedRole)
          ? "BLIND_SURFACE"
          : "UNIDENTIFIED_TARGET";
      return [surface, ...beside];
    }
    case "ActionFailed": {
      const failure = code(d.code);
      if (failure === "STATE_CHANGED") return ["SCREEN_CHANGED"];
      if (failure === "MALFORMED_RESPONSE") return ["MALFORMED_RESPONSE"];
      if (failure === "REFUSED") return ["MODEL_REFUSED"];
      // A done sent back over the task's own file, or over a requirement
      // the audit found unmet, is its own class beside the check as a
      // whole; the reason is the runner's fixed code.
      if (failure === "DONE_CHALLENGED") {
        const why = code(d.reason);
        return why === "deliverable_unchanged"
          ? ["DONE_CHALLENGED", "DONE_CHALLENGED_DELIVERABLE"]
          : why === "requirement_unmet"
            ? ["DONE_CHALLENGED", "DONE_CHALLENGED_REQUIREMENT"]
            : ["DONE_CHALLENGED"];
      }
      return [failure ?? "ACTION_FAILED"];
    }
    // The runner's own verdict on a run: a second done with the named file
    // still unchanged (DELIVERABLE_MISSING), or the model's own fail, an
    // honest give-up the runner journals under MODEL_FAILED. Any other
    // RunFailed is read from the status.
    case "RunFailed": {
      const failed = code(d.code);
      return failed === "DELIVERABLE_MISSING" || failed === "MODEL_FAILED"
        ? [failed]
        : [];
    }
    // A browser frame whose page text the helper cut short, by its reason.
    case "FrameCaptured": {
      const cut = code(d.textTruncated);
      return cut ? [`${TEXT_TRUNCATED_PREFIX}${cut.toUpperCase()}`] : [];
    }
    case "ActionLoopDetected":
      // The app-switch rule's event carries period 0 and no revisit count; a
      // revisit detection carries its count beside period 0.
      return count(d.period) === 0 &&
        count(d.revisits) === undefined &&
        code(d.actionType) === "open_app"
        ? ["APP_SWITCH_THRASH"]
        : ["ACTION_LOOP"];
    // The loop breaker: the reflection step given, or the run failed as stuck.
    case "ActionLoopBroken":
      return code(d.outcome) === "fail" ? ["LOOP_STUCK"] : ["LOOP_REFLECTED"];
    case "ActionInterrupted":
      return ["ACTION_INTERRUPTED"];
    // A recovery, not a failure: the runner re-aimed the same control itself.
    case "ActionReaimed":
      return ["ACTION_REAIMED"];
    // A click by name that changed nothing the helper could read after every
    // route it has (the pointer at the control's centre and its accessibility
    // press, or focus for a field): the step executed, its effect none.
    case "ActionExecuted":
      return code(d.effect) === "none" ? ["CLICK_NO_EFFECT"] : [];
    case "PolicyConfirmationRequested":
      return ["APPROVAL_REQUESTED"];
    case "UserDenied": {
      // A declined approval names who answered ("approval" in older journals,
      // now voice, pill, typed, message or remote); a policy denial carries
      // only the reason. The question's code (src/core/approval-codes.ts)
      // splits the declines by what was asked, never by its text.
      if (!code(d.source)) {
        // A policy denial's reason as the runner's code
        // (src/core/decision-codes.ts deniedCode), never its sentence.
        const why = approvalCodeOf(d.reasonCode);
        return why && why !== "OTHER"
          ? ["POLICY_DENIED", `${POLICY_DENIED_PREFIX}${why}`]
          : ["POLICY_DENIED"];
      }
      const asked = approvalCodeOf(d.approvalCode);
      return asked
        ? ["APPROVAL_DECLINED", `${APPROVAL_DECLINED_PREFIX}${asked}`]
        : ["APPROVAL_DECLINED"];
    }
    case "UserCorrectionRecorded":
      return ["USER_CORRECTION"];
    case "UserTakeoverStarted": {
      const source = code(d.source);
      if (source === "manual_input") return ["MANUAL_TAKEOVER"];
      // The diagnostics stream carries the hand-off's source as a code
      // (handoff, policy, request_user); a trace from before it did leaves a
      // bare event, which is ambiguous and says so. NativeUserTakeover in the
      // same run is what distinguishes real input from a hand-off there.
      return source ? ["HANDOFF_TAKEOVER"] : ["TAKEOVER_STARTED"];
    }
    case "NativeUserTakeover":
      return ["MANUAL_INPUT_DETECTED"];
    case "NativeEmergencyStop":
      return ["EMERGENCY_STOP"];
    case "NativeUnavailable":
      return ["HELPER_UNAVAILABLE"];
    // The helper answered its liveness probe while a request ran past its
    // deadline: alive and busy, the wait extended, nothing restarted.
    case "NativeSlow":
      return ["HELPER_SLOW"];
    case "RunPaused":
      return ["RUN_PAUSED"];
    case "PlanAbandoned":
      return ["PLAN_ABANDONED"];
    case "NativeError": {
      const failure = code(d.code);
      const name = code(d.name);
      if (failure === "STATE_CHANGED") return ["SCREEN_CHANGED_NATIVE"];
      if (failure === "STOPPED") return ["NATIVE_STOPPED"];
      if (name === "HelperUnavailableError") return ["HELPER_UNAVAILABLE"];
      // The extended wait ran out with the helper still alive; the run paused.
      if (name === "HelperSlowError") return ["HELPER_SLOW"];
      return ["NATIVE_ERROR"];
    }
    case "ProviderTransportError":
      return d.retryable === true
        ? ["PROVIDER_TRANSPORT_RETRYABLE"]
        : ["PROVIDER_TRANSPORT_FATAL"];
    case "ProviderRetry":
      return ["PROVIDER_RETRY"];
    case "ProviderMalformed":
      return ["MALFORMED_RESPONSE"];
    case "ProviderUnavailable":
      return ["PROVIDER_UNAVAILABLE"];
    // Advice the runner gives itself: same-type actions that changed nothing
    // on screen. It never ends a run, so a cycle report counts it as friction.
    case "NoProgressDetected":
      return ["NO_PROGRESS"];
    case "ProviderFailed": {
      if (d.cancelled === true) return ["MODEL_CALL_ABORTED"];
      if (d.timedOut === true) return ["PROVIDER_TIMEOUT"];
      return code(d.name) === "ProviderTransientError"
        ? ["PROVIDER_TRANSIENT"]
        : ["PROVIDER_FAILED"];
    }
    default:
      return [];
  }
}

/** Bundle ids this event names, if any. */
function appsOf(line: DiagnosticLine): string[] {
  const ids = [
    bundleId(line.data.appId),
    bundleId(line.data.launchedAppId),
    bundleId(line.data.openedAppId),
  ];
  return ids.filter((id): id is string => !!id);
}

interface Occurrence {
  count: number;
  runs: Set<string>;
  apps: Map<string, number>;
  actionTypes: Map<string, number>;
  at?: string;
  atRun?: string;
}

export interface RunState {
  runId: string;
  /** The most recent application this run named, for events that name none. */
  lastApp?: string;
  firstAt?: string;
  lastAt?: string;
  statuses: { status: string; at?: string }[];
  outcome: string;
  ending?: string;
  endingAt?: string;
  apps: Set<string>;
  actionTypes: Set<string>;
  frictions: Map<string, number>;
  actions: number;
  cost: number;
  approvals: number;
  /** Fixed codes seen while the run was ending, newest last. */
  tail: { code: string; at?: string }[];
  budget?: string;
}

const TERMINAL = ["completed", "cancelled", "failed"];

export interface PatternRow {
  code: string;
  /** Times the pattern occurred across every run. */
  events: number;
  /** Runs it occurred in. */
  runs: number;
  /** Runs it ended (run-ending rows only). */
  endedRuns?: number;
  apps: string[];
  actionTypes: string[];
  /** A timestamp and run id so a human can find it in the log. */
  at?: string;
  atRun?: string;
}

export interface AnalysisReport {
  files: number;
  lines: number;
  skipped: number;
  ignored: number;
  window: { from?: string; to?: string };
  runs: {
    total: number;
    byOutcome: Record<string, number>;
    medianActions: number;
    medianCost: number;
  };
  durations: {
    medianModelCallMs: number;
    medianCaptureMs: number;
    medianExecuteMs: number;
  };
  endings: PatternRow[];
  frictions: PatternRow[];
  /**
   * One row per run: its ending and the friction codes it saw, keyed by the
   * run id a cycle's attempt rows carry. Codes and counts only.
   */
  perRun: {
    runId: string;
    ending: string;
    frictions: Record<string, number>;
  }[];
  fixNext: {
    rank: number;
    code: string;
    endedRuns: number;
    /** Occurrences of a friction pattern with the same name, if any. */
    events: number;
    owner: string;
    /** The friction patterns most common inside the runs that ended this way. */
    contributors: string[];
    note: string;
  }[];
}

function occurrence(map: Map<string, Occurrence>, key: string): Occurrence {
  let entry = map.get(key);
  if (!entry) {
    entry = {
      count: 0,
      runs: new Set(),
      apps: new Map(),
      actionTypes: new Map(),
    };
    map.set(key, entry);
  }
  return entry;
}

function bump(map: Map<string, number>, key: string | undefined): void {
  if (key) map.set(key, (map.get(key) ?? 0) + 1);
}

function top(map: Map<string, number>, limit = 4): string[] {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, value]) => `${key} ${value}`);
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Who can fix a pattern, which is what makes the ranking actionable. A
 * benchmark cycle adds two owners the app log never needs: "grader" for an
 * attempt whose end state could not be read (debt in the graders, not a
 * model failure) and "harness" for an attempt the harness itself did not
 * give the model (a skip, a cap, a time box). Anything unlisted is the
 * agent's.
 */
export const OWNER: Record<string, string> = {
  COMPLETED: "none",
  USER_CANCELLED: "user",
  STOPPED_AFTER_MANUAL_TAKEOVER: "user",
  MANUAL_TAKEOVER: "user",
  MANUAL_INPUT_DETECTED: "user",
  EMERGENCY_STOP: "user",
  APPROVAL_DECLINED: "user",
  ACTION_REAIMED: "none",
  // A step held until the user's sentence ended: nobody's failure.
  RETRY_SPEAKING: "none",
  HELPER_UNAVAILABLE: "environment",
  HELPER_SLOW: "environment",
  NATIVE_ERROR: "environment",
  PROVIDER_FAILED: "environment",
  PROVIDER_TIMEOUT: "environment",
  PROVIDER_TRANSIENT: "environment",
  PROVIDER_TRANSPORT_RETRYABLE: "environment",
  PROVIDER_TRANSPORT_FATAL: "environment",
  PROVIDER_UNAVAILABLE: "environment",
  NO_ACCESSIBILITY: "grader",
  NO_END_STATE: "grader",
  NO_BROWSER_ADDRESS: "grader",
  NO_FRONTMOST_INFO: "grader",
  NO_OPERANDS: "grader",
  NO_MARKER: "grader",
  NO_TARGET_FILE: "grader",
  RUN_NOT_SETTLED: "grader",
  GRADER_ERROR: "grader",
  NO_PREPARED_TARGET: "harness",
  BUDGET_EXHAUSTED: "harness",
  TIME_BOX: "harness",
  SKIPPED: "harness",
  INTERRUPTED: "harness",
  MANUAL_INPUT_UNSEEN: "user",
};
/** The owner of a code: listed, or the agent's. A declined question's is its decline's. */
export function ownerOf(code: string): string {
  return (
    OWNER[code] ??
    (code.startsWith(APPROVAL_DECLINED_PREFIX)
      ? OWNER.APPROVAL_DECLINED
      : "agent")
  );
}
/** Authored one-line explanations. None of this comes from the log. */
const NOTE: Record<string, string> = {
  ACTION_BUDGET: "The run used its whole action budget without finishing.",
  STUCK_LOOP:
    "The run kept repeating the same steps after its one reflection step, and with nobody to give a hint it failed honestly instead of pausing.",
  RUNTIME_BUDGET: "The run used its whole time budget without finishing.",
  COST_BUDGET: "The run used its whole cost budget without finishing.",
  POLICY_VIOLATIONS: "Too many proposed steps the policy would not allow.",
  HANDOFF_TAKEOVER:
    "The agent gave up and asked the user to act, usually after repeated unidentified targets.",
  TAKEOVER_STARTED:
    "The run handed control to the user. The log does not record whether real input or the agent caused it; a MANUAL_INPUT_DETECTED event in the same run means real input.",
  STOPPED_AFTER_HANDOFF:
    "The run was stopped while it was waiting for the user after a hand-off.",
  STOPPED_AFTER_MANUAL_TAKEOVER:
    "Real input on this Mac paused the run and it was then stopped.",
  STOPPED_WHILE_PAUSED: "The run was stopped while paused.",
  USER_CANCELLED: "The user stopped the run.",
  LEFT_IN_TAKEOVER:
    "The run was still waiting for the user when the log ended.",
  LEFT_PAUSED: "The run was still paused when the log ended.",
  LEFT_AWAITING_APPROVAL:
    "The run was still waiting for an approval when the log ended.",
  NOT_SETTLED: "The run never reached a terminal state in this log.",
  RUN_ERROR: "The run threw an error with no more specific code.",
  EMERGENCY_STOP: "The native emergency stop was triggered.",
  HELPER_UNAVAILABLE: "The native helper exited or stopped responding.",
  HELPER_SLOW:
    "The native helper was alive (it answered its liveness probe) while a request, normally a capture on a loaded Mac, ran past its deadline, so the wait was extended instead of restarting the helper. A NativeError named HelperSlowError in the same run is the bounded wait running out too, and the run pausing with the helper kept.",
  PROVIDER_FAILED: "The model call failed after its retries.",
  SCREEN_CHANGED:
    "The screen changed between the screenshot and the input, so the step was rejected.",
  SCREEN_CHANGED_NATIVE:
    "The native helper rejected input because the target moved or the window changed.",
  UNIDENTIFIED_TARGET:
    "The policy could not identify what the pointer would hit, so no input was sent.",
  CONTROL_NOT_FOUND:
    "A control or menu item named by the model was not there as named (missing, several of that name, disabled or covered), so no input was sent; the RETRY_ pattern beside it says which.",
  BAD_URL:
    "The address the model gave was not a full http or https address without credentials, so nothing was loaded.",
  WINDOWLESS_APP:
    "The application the model opened has no window, and opening it again shows none; the route is its Window menu or File > New.",
  RETRY_SPEAKING:
    "The step was proposed while the user was still speaking and held for the end of the sentence; it is not a grounding problem.",
  TOOL_REFUSED:
    "A tool call the policy sent back (an unknown tool, bad arguments, a path the files tool may not touch); the RETRY_ pattern beside it says which.",
  BLIND_SURFACE:
    "The frontmost application reported no accessibility information, so every pointer step was refused.",
  APP_ALREADY_FRONTMOST:
    "open_app was proposed for the application that was already frontmost.",
  APP_UNRESOLVED: "No installed application matched the requested name.",
  APP_AMBIGUOUS: "Several installed applications matched the requested name.",
  APP_REFUSED: "The launch rules refused that application.",
  ACTION_LOOP: "The same short sequence of actions repeated.",
  APP_SWITCH_THRASH:
    "The run bounced between applications without reading them.",
  INVALID_ACTION: "The model returned an action the schema rejected.",
  // A menu Copy, Cut or Paste with nothing to act on: the runner answered it
  // with a fixed line and counted an invalid step, never a revisit (probe
  // 20260919-2339-54b99b3: ops-crm-data-entry carried the lead's values in
  // its note, clicked no field and typed nothing in 36 actions).
  MENU_NEEDS_FOCUS:
    "Edit > Paste (or a variant such as Paste and Match Style) was proposed through the menus with no editable field focused, so the runner answered it without pressing it: click the field by name, then type_text the value from the note. Counted as an invalid step, never a revisit.",
  MENU_NEEDS_SELECTION:
    "Edit > Copy or Cut was proposed through the menus with nothing selected and no editable field focused, so the runner answered it without pressing it: a value read from a page is typed into the form from the note, not copied. Counted as an invalid step, never a revisit.",
  MALFORMED_RESPONSE: "The model reply did not contain one usable action.",
  MODEL_REFUSED: "The model declined the step.",
  APPROVAL_REQUESTED: "The policy asked the user to approve a step.",
  APPROVAL_DECLINED: "An approval was declined.",
  POLICY_DENIED: "The policy denied a step outright.",
  MANUAL_TAKEOVER: "Real input on this Mac took the run over.",
  MANUAL_INPUT_DETECTED: "The native helper saw real mouse or key input.",
  RUN_PAUSED: "The run paused and waited for the user.",
  PLAN_ABANDONED: "A replayed memory plan was abandoned mid-way.",
  NATIVE_STOPPED: "Input was attempted while the native stop latch was set.",
  NATIVE_ERROR: "The native helper returned an error.",
  MODEL_CALL_ABORTED:
    "A model call was aborted, normally because the run stopped.",
  PROVIDER_TRANSIENT: "The provider failed transiently and the run paused.",
  PROVIDER_TIMEOUT: "A model call hit its deadline.",
  PROVIDER_RETRY: "A model call was retried.",
  PROVIDER_TRANSPORT_RETRYABLE:
    "A recoverable connection failure to the provider.",
  PROVIDER_TRANSPORT_FATAL:
    "An unrecoverable connection failure to the provider.",
  PROVIDER_UNAVAILABLE: "The provider was unavailable and the run paused.",
  ACTION_INTERRUPTED: "A step was interrupted while it was executing.",
  ACTION_REAIMED:
    "The screen moved after the screenshot and the app re-aimed the same control by itself, saving a model call.",
  USER_CORRECTION: "The user corrected the run while it was running.",
  ACTION_FAILED: "A step failed with a code this analyzer does not name yet.",
  NO_PROGRESS:
    "Same-type actions changed nothing on screen; the run was told and kept going.",
  CLICK_NO_EFFECT:
    "A control clicked by name (click_control) changed nothing the helper could read within 300 ms, by the pointer at its centre and by its accessibility press (focus, for a field): no focus move, no change of the control's own state or of the window's title, page or controls. The step still counts as executed; its history line says so and sends the model to click(x, y), another control or the keyboard, and a second such click on the same control from the same screen is a loop at once.",
  LOOP_REFLECTED:
    "A loop continued past its warning with nobody to give a hint; the run got one reflection step instead of a pause.",
  LOOP_STUCK:
    "A loop formed again after the reflection step; the run was failed as stuck.",
  DONE_CHALLENGED:
    "The model said done and the runner sent the claim back once: after a step of the run was declined or refused (with a fresh screenshot), with the file the task asks to write unchanged since the run began (DONE_CHALLENGED_DELIVERABLE), or with a requirement of the objective the done audit found unmet in the run's steps (DONE_CHALLENGED_REQUIREMENT). The run's ending says what followed: COMPLETED is the claim repeated, MODEL_FAILED the claim withdrawn, DELIVERABLE_MISSING the runner's own verdict at a second done with the file still unchanged.",
  DONE_CHALLENGED_DELIVERABLE:
    "The model said done while the file the task asks to write (a ~/… path in the words) still had the size and modification time it had as the run began, or still did not exist; the runner sent the claim back once with that fact. Only existence, size and time were read, never the contents.",
  DONE_CHALLENGED_REQUIREMENT:
    "The model said done on an objective of more than one clause after three or more actions, and one text call to the same model (the done audit, src/core/done-audit.ts) read the objective's requirements against the run's steps and found at least one unmet: a value never entered, a form never submitted, a named fact absent from what was written. The claim was sent back once with the unmet requirements in the audit's words; the next done stands on the model's word and is graded as any. A malformed audit reply leaves the done standing (DoneAudited code unavailable). The trace carries counts only.",
  DELIVERABLE_MISSING:
    "The model said done a second time with the task's named file still unchanged since the run began, and the runner failed the run itself: a false done turned into an honest failure. The grader's own reason names what the file lacked.",
  MODEL_FAILED:
    "The model gave up honestly with fail instead of claiming done.",
  FALSE_DONE:
    "The model said done and the verified end state was wrong: a claim it did not earn.",
  NO_ACCESSIBILITY:
    "The frontmost window reported no accessibility text, so the grader could not read the result.",
  NO_END_STATE: "The end state could not be read back after the run.",
  NO_BROWSER_ADDRESS: "The browser reported no committed page address.",
  NO_FRONTMOST_INFO:
    "The controller did not say which application was in front.",
  GRADER_ERROR:
    "The task's grader threw on the evidence it was given (a reader left something out); the run still counts, its result is unknown.",
  NO_PREPARED_TARGET:
    "prepare() found nothing to work on; the attempt was skipped, not run.",
  BUDGET_EXHAUSTED:
    "The cycle or model cost cap left too little for a fair attempt; skipped, not run.",
  TIME_BOX: "The time box ended the cycle before this attempt.",
  SKIPPED:
    "A stop reached the harness before this attempt's run started, or cut the run short; a resume runs it again.",
  INTERRUPTED: "The harness stopped the run from the terminal.",
  HANDOFF_REQUEST_USER: "The model asked the user to act (request_user).",
  HANDOFF_TARGET:
    "The runner handed off after repeated targets it could not identify.",
  HANDOFF_POLICY: "The policy handed control to the user.",
  HANDOFF_SURFACE:
    "The frontmost surface could not be driven (secure input, a protected app or site, a browser page whose address could not be read), so the run handed off.",
  MANUAL_INPUT_UNSEEN:
    "The tap saw real input around the attempt that no event reported; the attempt is the environment's.",
  UNCLASSIFIED: "The run ended without a recognizable reason in the log.",
};
/** The authored note for a code, or the unclassified one. */
export function noteFor(code: string): string {
  if (code in NOTE) return NOTE[code];
  if (code.startsWith(RETRY_PREFIX))
    return `A step was sent back; the suffix is the policy's reason as a code (src/core/decision-codes.ts retryCode), which tells a missing control from a refused address or a wait for the end of the sentence without the sentence.`;
  if (code.startsWith(POLICY_DENIED_PREFIX))
    return `A policy denial; the suffix is the policy's reason as a code (src/core/decision-codes.ts deniedCode): a protected application or site, a credential, a terminal, an installer.`;
  if (code.startsWith(APPROVAL_DECLINED_PREFIX))
    return `An approval was declined; the suffix is the policy's question as a code (src/core/approval-codes.ts). Declined on a task that lists no such approval, it is the task's design; asked and declined attempt after attempt for a control the policy should have classified (CLICK_CONTROL, ACTIVATE_CONTROL), it is a policy false positive.`;
  if (code.startsWith(TEXT_TRUNCATED_PREFIX))
    return `A browser frame's page text stopped short of what was on screen; the suffix is the helper's reason (native/macos/WebText.swift TextWalkBudget): TIME its wall-time budget for the walk, NODES its node budget, CHARS the 4,200-character cap. The text ends with the marker line and the instruction tells the model to scroll on. Counted per frame; many TIME cuts on one task mean a page too slow to read whole within the budget, not a model that failed to scroll.`;
  return NOTE.UNCLASSIFIED;
}

/** Classifies why one run ended, from its statuses and its tail of events. */
export function endingCode(run: RunState): string {
  if (run.outcome === "completed") return "COMPLETED";
  const has = (pattern: string) => run.frictions.has(pattern);
  if (run.outcome === "failed") {
    if (run.budget) return run.budget;
    if (has("EMERGENCY_STOP")) return "EMERGENCY_STOP";
    if (has("DELIVERABLE_MISSING")) return "DELIVERABLE_MISSING";
    if (has("MODEL_FAILED")) return "MODEL_FAILED";
    const tail = run.tail.map((entry) => entry.code);
    for (const entry of tail.slice(-6).reverse()) {
      if (entry === "HELPER_UNAVAILABLE") return "HELPER_UNAVAILABLE";
      if (entry === "PROVIDER_FAILED" || entry === "PROVIDER_TIMEOUT")
        return entry;
    }
    return "RUN_ERROR";
  }
  if (run.outcome === "cancelled") {
    if (has("EMERGENCY_STOP")) return "EMERGENCY_STOP";
    if (has("MANUAL_TAKEOVER") || has("MANUAL_INPUT_DETECTED"))
      return "STOPPED_AFTER_MANUAL_TAKEOVER";
    if (has("HANDOFF_TAKEOVER") || has("TAKEOVER_STARTED"))
      return "STOPPED_AFTER_HANDOFF";
    if (has("RUN_PAUSED")) return "STOPPED_WHILE_PAUSED";
    return "USER_CANCELLED";
  }
  const last = run.statuses.at(-1)?.status;
  if (last === "takeover") return "LEFT_IN_TAKEOVER";
  if (last === "paused") return "LEFT_PAUSED";
  if (last === "confirming") return "LEFT_AWAITING_APPROVAL";
  return "NOT_SETTLED";
}

export interface AnalyzeOptions {
  /** ISO timestamp; lines before it are ignored. */
  since?: string;
  files?: number;
  /** Malformed lines the parser could not read. */
  skipped?: number;
}

export function analyze(
  lines: DiagnosticLine[],
  options: AnalyzeOptions = {},
): AnalysisReport {
  const since = options.since;
  const runs = new Map<string, RunState>();
  const frictions = new Map<string, Occurrence>();
  const endings = new Map<string, Occurrence>();
  const modelCallMs: number[] = [];
  const captureMs: number[] = [];
  const executeMs: number[] = [];
  let ignored = 0;
  let from: string | undefined;
  let to: string | undefined;
  for (const line of lines) {
    if (since && line.timestamp && line.timestamp < since) {
      ignored++;
      continue;
    }
    if (line.timestamp) {
      if (!from || line.timestamp < from) from = line.timestamp;
      if (!to || line.timestamp > to) to = line.timestamp;
    }
    // Native and provider timings are useful even outside a run.
    if (line.event === "NativeResponse") {
      const ms = count(line.data.durationMs);
      const method = code(line.data.method);
      if (ms !== undefined && method === "capture") captureMs.push(ms);
      if (ms !== undefined && method === "execute") executeMs.push(ms);
    }
    if (line.event === "ProviderResponse") {
      const ms = count(line.data.durationMs);
      if (ms !== undefined) modelCallMs.push(ms);
    }
    const runId = runIdOf(line.data);
    if (!runId) {
      ignored++;
      continue;
    }
    let run = runs.get(runId);
    if (!run) {
      run = {
        runId,
        firstAt: line.timestamp,
        statuses: [],
        outcome: "unsettled",
        apps: new Set(),
        actionTypes: new Set(),
        frictions: new Map(),
        actions: 0,
        cost: 0,
        approvals: 0,
        tail: [],
      };
      runs.set(runId, run);
    }
    run.lastAt = line.timestamp ?? run.lastAt;
    const named = appsOf(line);
    for (const app of named) run.apps.add(app);
    if (named.length) run.lastApp = named[0];
    const actionType = code(line.data.actionType);
    if (actionType) run.actionTypes.add(actionType);
    if (line.event === "RunState") {
      const status = code(line.data.status);
      if (status) {
        run.statuses.push({ status, at: line.timestamp });
        if (TERMINAL.includes(status)) run.outcome = status;
        if (status === "failed" && !run.budget)
          run.budget =
            budgetCode(line.data.message) ?? budgetCode(line.data.error);
      }
      run.actions = count(line.data.actions) ?? run.actions;
      const usage = line.data.usage;
      if (usage && typeof usage === "object")
        run.cost = count((usage as Record<string, unknown>).cost) ?? run.cost;
      continue;
    }
    for (const friction of frictionCodes(line)) {
      run.frictions.set(friction, (run.frictions.get(friction) ?? 0) + 1);
      run.tail.push({ code: friction, at: line.timestamp });
      if (run.tail.length > 24) run.tail.shift();
      const entry = occurrence(frictions, friction);
      entry.count++;
      entry.runs.add(runId);
      // Many events carry no bundle id; the run's most recent one is the
      // application the step was aimed at, which is what a reader needs.
      for (const app of named.length ? named : run.lastApp ? [run.lastApp] : [])
        bump(entry.apps, app);
      bump(entry.actionTypes, actionType);
      if (!entry.at) {
        entry.at = line.timestamp;
        entry.atRun = runId;
      }
      if (friction === "APPROVAL_REQUESTED") run.approvals++;
    }
  }
  const byOutcome: Record<string, number> = {};
  for (const run of runs.values()) {
    byOutcome[run.outcome] = (byOutcome[run.outcome] ?? 0) + 1;
    run.ending = endingCode(run);
    run.endingAt = run.statuses.at(-1)?.at ?? run.lastAt;
    const entry = occurrence(endings, run.ending);
    entry.count++;
    entry.runs.add(run.runId);
    for (const app of run.apps) bump(entry.apps, app);
    for (const type of run.actionTypes) bump(entry.actionTypes, type);
    if (!entry.at) {
      entry.at = run.endingAt;
      entry.atRun = run.runId;
    }
  }
  const rows = (map: Map<string, Occurrence>, ending: boolean): PatternRow[] =>
    [...map.entries()]
      .map(([key, entry]) => ({
        code: key,
        events: entry.count,
        runs: entry.runs.size,
        ...(ending ? { endedRuns: entry.count } : {}),
        apps: top(entry.apps),
        actionTypes: top(entry.actionTypes),
        at: entry.at,
        atRun: entry.atRun,
      }))
      .sort((a, b) => b.events - a.events || (a.code < b.code ? -1 : 1));
  const endingRows = rows(endings, true);
  const fixNext = endingRows
    .filter((row) => row.code !== "COMPLETED")
    .map((row, index) => {
      const inside = new Map<string, number>();
      for (const run of runs.values()) {
        if (run.ending !== row.code) continue;
        for (const [pattern, seen] of run.frictions)
          if (pattern !== row.code)
            inside.set(pattern, (inside.get(pattern) ?? 0) + seen);
      }
      return {
        rank: index + 1,
        code: row.code,
        endedRuns: row.endedRuns ?? row.runs,
        events: frictions.get(row.code)?.count ?? 0,
        owner: ownerOf(row.code),
        contributors: top(inside, 3),
        note: noteFor(row.code),
      };
    });
  const runList = [...runs.values()];
  const perRun = runList.map((run) => ({
    runId: run.runId,
    ending: run.ending ?? "NOT_SETTLED",
    frictions: Object.fromEntries(run.frictions),
  }));
  return {
    files: options.files ?? 1,
    lines: lines.length,
    skipped: options.skipped ?? 0,
    ignored,
    window: { from, to },
    runs: {
      total: runList.length,
      byOutcome,
      medianActions: median(runList.map((run) => run.actions)),
      medianCost: median(runList.map((run) => run.cost)),
    },
    durations: {
      medianModelCallMs: median(modelCallMs),
      medianCaptureMs: median(captureMs),
      medianExecuteMs: median(executeMs),
    },
    endings: endingRows,
    frictions: rows(frictions, false),
    perRun,
    fixNext,
  };
}

const pad = (value: string, width: number, right = false) =>
  right ? value.padStart(width) : value.padEnd(width);

function table(header: string[], rows: string[][]): string {
  const widths = header.map((name, column) =>
    Math.max(name.length, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, column) => pad(cell ?? "", widths[column]))
      .join("  ")
      .trimEnd();
  return [
    line(header),
    line(widths.map((width) => "-".repeat(width))),
    ...rows.map(line),
  ].join("\n");
}

/** Renders the report. Every value printed here is a count, code or timestamp. */
export function renderAnalysis(report: AnalysisReport): string {
  const out: string[] = [];
  out.push(
    `Butler run analysis: ${report.runs.total} runs over ${report.lines} events from ${report.files} file(s).`,
  );
  if (report.window.from)
    out.push(`window ${report.window.from} .. ${report.window.to}`);
  out.push(
    "outcomes  " +
      Object.entries(report.runs.byOutcome)
        .sort((a, b) => b[1] - a[1])
        .map(([outcome, runs]) => `${outcome} ${runs}`)
        .join("  "),
  );
  out.push(
    `median actions per run ${report.runs.medianActions}  median cost per run $${report.runs.medianCost.toFixed(3)}`,
  );
  out.push(
    `median model call ${Math.round(report.durations.medianModelCallMs)} ms  capture ${Math.round(report.durations.medianCaptureMs)} ms  execute ${Math.round(report.durations.medianExecuteMs)} ms`,
  );
  out.push("");
  out.push("How runs ended");
  out.push(
    table(
      ["reason", "runs", "apps", "action types", "first seen", "run id"],
      report.endings.map((row) => [
        row.code,
        String(row.runs),
        row.apps.join(", "),
        row.actionTypes.join(", "),
        row.at ?? "",
        row.atRun ?? "",
      ]),
    ),
  );
  out.push("");
  out.push("Friction inside runs");
  out.push(
    table(
      [
        "pattern",
        "events",
        "runs",
        "apps",
        "action types",
        "first seen",
        "run id",
      ],
      report.frictions.map((row) => [
        row.code,
        String(row.events),
        String(row.runs),
        row.apps.join(", "),
        row.actionTypes.join(", "),
        row.at ?? "",
        row.atRun ?? "",
      ]),
    ),
  );
  const reaimed = report.frictions.find((row) => row.code === "ACTION_REAIMED");
  if (reaimed)
    out.push(
      `\nrecovered without a model call: ACTION_REAIMED ${reaimed.events} in ${reaimed.runs} run(s)`,
    );
  out.push("");
  out.push("What to fix next (ranked by how often the pattern ended a run)");
  for (const item of report.fixNext) {
    out.push(
      `${item.rank}. ${item.code} - ended ${item.endedRuns} run(s)` +
        (item.events ? `, ${item.events} event(s)` : "") +
        `, owner: ${item.owner}`,
    );
    out.push(`   ${item.note}`);
    if (item.contributors.length)
      out.push(`   inside those runs: ${item.contributors.join(", ")}`);
  }
  return out.join("\n");
}
