import type {
  Action,
  Controller,
  ExecutionResult,
  Frame,
  Provider,
  ProviderResult,
  Recorder,
  Run,
  RunOrigin,
  RunStatus,
  RunTarget,
  Rung,
  Settings,
  Snapshot,
  ScreenContext,
  Observation,
  Surface,
  ScreenshotUse,
  MemoryContext,
  TargetSpec,
  TaskSource,
  Usage,
  WatchBinding,
  WatchContext,
} from "./schema";
import type {
  BackgroundKnowledge,
  BackgroundObservation,
  BackgroundRoute,
  MemoryAccess,
  Recall,
  ReplayPlan,
  TrajectoryStep,
} from "./memory";
import {
  validateAction,
  sameGeometry,
  normalizePixelCoordinates,
  withoutWindow,
} from "./schema";
import {
  MISS_LIMIT,
  NO_BACKGROUND_ROUTE,
  aimAtDisplay,
  backgroundLadder,
  backgroundResult,
  backgroundRoute,
  coveredStaleRetry,
  finishInFront,
  foregroundCapReached,
  foregroundHandoff,
  foregroundRequest,
  missKey,
  noWindowInFront,
  routeSkipped,
  spokenTargets,
  targetGoneMessage,
  targetHold,
} from "./background";
import {
  labelMatches,
  normalizeLabel,
  normalizeRole,
  utf16Prefix,
} from "./labels";
import {
  evaluate,
  focusedTextField,
  normalizeAppName,
  surfacePolicy,
  PASTE_ALLOWED,
  type Decision,
} from "./policy";
import { approvalCode } from "./approval-codes";
import { watchSpec, type WatchChain, type WatchSpec } from "./monitor";
import {
  TOOL_LIMITS,
  TOOL_REFUSALS,
  TOOL_RESULT_TEXT,
  type ToolAccess,
  type ToolClock,
  type ToolList,
  type ToolOutcome,
  type ToolPrepared,
  type ToolSpec,
} from "./tools";
import {
  argsHash,
  clockLine,
  toolDoneLine,
  toolFallbackLine,
  toolUndoLine,
} from "./tool-text";
import { entityTokens } from "./entities";
import { actionConfirmed, contextDigest, screenshotUse } from "./vision";
import { redactSecrets, scanText } from "./sanitize";
import {
  HelperUnavailableError,
  NativeActionError,
  NativeStoppedError,
  ProviderTransientError,
  ScreenChangedError,
  SurfaceBlockedError,
  TargetError,
  type ScreenChange,
  type TargetCode,
} from "./errors";
export const terminal = (s: RunStatus) =>
  ["completed", "cancelled", "failed"].includes(s);
type History = Observation["history"];
const actionTypes = new Set([
  "capture",
  "click",
  "double_click",
  "right_click",
  "move",
  "drag",
  "scroll",
  "type_text",
  "key",
  "hotkey",
  "open_app",
  "open_file",
  "menu_item",
  "click_control",
  "wait",
  "monitor",
  "tool_call",
  "request_user",
  "done",
  "fail",
]);
const numericEcho = [
  "x",
  "y",
  "start_x",
  "start_y",
  "end_x",
  "end_y",
  "delta_x",
  "delta_y",
] as const;
const coordinateFields = new Set<string>(numericEcho.slice(0, 6));
const keyName = (v: unknown) =>
  typeof v === "string" && /^[A-Za-z0-9]{1,12}$/.test(v) ? v : undefined;
const bound = (s: string, n: number) =>
  s.length > n ? s.slice(0, n - 1) + "…" : s;
/**
 * A content-free echo of a proposed action so the model can see what was
 * rejected. Never includes text, summary or reason payloads.
 */
export function echoAction(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const a = input as Record<string, unknown>;
  const echo: Record<string, unknown> = {};
  if (typeof a.type === "string")
    echo.type = actionTypes.has(a.type) ? a.type : "unknown";
  for (const field of numericEcho)
    if (typeof a[field] === "number" && Number.isFinite(a[field]))
      echo[field] = a[field];
  const key = keyName(a.key);
  if (key) echo.key = key;
  if (Array.isArray(a.keys))
    echo.keys = a.keys.slice(0, 4).map((k) => keyName(k) ?? "?");
  if (a.type === "open_app" && typeof a.name === "string")
    echo.name = bound(a.name, 100);
  if (a.type === "open_file" && typeof a.app === "string")
    echo.app = bound(a.app, 100);
  if (a.type === "monitor")
    for (const field of ["every_s", "max_min", "until"] as const)
      if (["number", "string"].includes(typeof a[field]))
        echo[field] =
          typeof a[field] === "string" ? bound(String(a[field]), 12) : a[field];
  if (a.type === "menu_item" && Array.isArray(a.path))
    echo.path = a.path
      .slice(0, 3)
      .map((part) => (typeof part === "string" ? bound(part, 60) : "?"));
  if (a.type === "click_control" && typeof a.label === "string")
    echo.label = bound(a.label, 120);
  // The tool's id only: its arguments are the step's content.
  if (a.type === "tool_call" && typeof a.tool === "string")
    echo.tool = bound(a.tool, 170);
  // The model's own note rides along: a value it read for a later step is
  // still needed when the step that carried it was rejected or declined.
  if (typeof a.note === "string") echo.note = bound(a.note, 200);
  return echo;
}
const knownType = (input: unknown) => {
  const type = (input as { type?: unknown } | null)?.type;
  return typeof type === "string" && actionTypes.has(type) ? type : "unknown";
};
/** History entries the model sees whole; the steps before them become one line. */
export const MODEL_HISTORY_FULL = 6;
/**
 * The longest result line a whole entry carries to the model: room for an
 * executed step's line with two of the advice notes, never a runaway one.
 */
export const MODEL_RESULT_CHARS = 640;
/**
 * The model's copy of the history: the last MODEL_HISTORY_FULL entries whole
 * (rejections with their echoed actions, refusals, the loop and no-progress
 * notes), behind one line naming every earlier step and how it ended. Twelve
 * whole entries were 1.1-1.5k input tokens a step on the 2026-09-19 runs (a
 * 24-step run grew from 7.5k to 9.7k). Typed text never enters the line, no
 * entry carries an image, and every result is cut at MODEL_RESULT_CHARS.
 */
export function modelHistory(history: History): History {
  const whole = history.slice(-MODEL_HISTORY_FULL).map((entry) => ({
    ...entry,
    result: bound(entry.result, MODEL_RESULT_CHARS),
  }));
  if (history.length <= MODEL_HISTORY_FULL) return whole;
  return [
    {
      type: "earlier_steps",
      result: summarizeSteps(history.slice(0, -MODEL_HISTORY_FULL)),
    },
    ...whole,
  ];
}
function summarizeSteps(entries: History): string {
  // Newest first, so a long run drops its oldest steps behind an ellipsis.
  const parts: string[] = [];
  let length = 0;
  for (const entry of entries.slice().reverse()) {
    const part = describeStep(entry);
    if (length + part.length > 400) {
      parts.push("…");
      break;
    }
    parts.push(part);
    length += part.length + 2;
  }
  return `${entries.length} earlier steps, oldest first: ${parts.reverse().join("; ")}.`;
}
/** One step as "type detail (outcome)": names the model chose, never text it typed. */
function describeStep(entry: History[number]): string {
  const a = entry.action ?? {};
  const type =
    typeof a.type === "string"
      ? a.type
      : entry.type === "rejected"
        ? "reply"
        : entry.type;
  const detail =
    type === "open_app" && typeof a.name === "string"
      ? ` ${bound(a.name, 40)}`
      : type === "open_file" && typeof a.path === "string"
        ? ` ${bound(a.path.split("/").pop() ?? "", 40)}`
        : type === "menu_item" && Array.isArray(a.path)
          ? ` ${bound(a.path.map(String).join(" > "), 60)}`
          : type === "click_control" && typeof a.label === "string"
            ? ` “${bound(a.label, 40)}”`
            : type === "hotkey" && Array.isArray(a.keys)
              ? ` ${a.keys.map(String).join("+")}`
              : type === "key" && typeof a.key === "string"
                ? ` ${a.key}`
                : type === "tool_call" && typeof a.tool === "string"
                  ? ` ${bound(a.tool, 40)}`
                  : "";
  const outcome =
    entry.type === "rejected"
      ? "rejected"
      : entry.type === "request_user"
        ? "asked the user"
        : /^No (?:input was|answer from)/.test(entry.result)
          ? "no input"
          : /^Interrupted/.test(entry.result)
            ? "interrupted"
            : /^Tool \S+: error/.test(entry.result)
              ? "error"
              : entry.result.includes("no visible change")
                ? "no visible change"
                : "done";
  return `${type}${detail} (${outcome})`;
}
/**
 * The line the model reads after a reply that was not one action: the fixed
 * problem, the provider's remedy for its own request format, and the frame
 * rule. Never a concrete frame id.
 */
function malformedRejection(problem: string, remedy?: string): string {
  return `No input was executed. Your last reply was not exactly one action (${bound(problem, 200)}). ${remedy ? bound(remedy, 300) + " " : ""}Return exactly one action object using the frame_id from the current context.`;
}
/**
 * A repaired reply (ProviderResult.repaired) whose object the schema then
 * rejected: the guess was wrong, so the reply was malformed rather than the
 * model having chosen an invalid action.
 */
const REPAIRED_INVALID =
  "The reply's action had to be dug out of surrounding text, and it was not a valid action.";
/** Explain a validateAction failure by cause without echoing model text. */
function invalidReason(
  error: unknown,
  input: unknown,
  frame: Frame,
): { cause: string; message: string } {
  // Never quote a concrete frame id: it is stale by the next capture.
  const fix = "Return one action using the frame_id from the current context.";
  if (error instanceof Error && error.message === "STALE_FRAME")
    return {
      cause: "STALE_FRAME",
      message: `No input was executed. The action used an old frame_id. ${fix}`,
    };
  if (!input || typeof input !== "object" || Array.isArray(input))
    return {
      cause: "SHAPE",
      message: `No input was executed. Return exactly one action object, not a list or text. ${fix}`,
    };
  const issues = ((error as { issues?: unknown })?.issues ?? []) as {
    code?: string;
    path?: PropertyKey[];
    keys?: unknown[];
    message?: string;
  }[];
  const field = (i: (typeof issues)[number]) => String(i.path?.[0] ?? "");
  if (issues.some((i) => coordinateFields.has(field(i))))
    return {
      cause: "COORDINATES",
      message: `No input was executed. All x/y coordinates must be fractions from 0 to 1, never pixels: divide pixel x by ${frame.geometry.model_width} and pixel y by ${frame.geometry.model_height}. ${fix}`,
    };
  if (issues.some((i) => field(i) === "type"))
    return {
      cause: "UNKNOWN_TYPE",
      message: `No input was executed. Unknown action type. Use one of: ${[...actionTypes].join(", ")}. ${fix}`,
    };
  const unknownKeys = issues
    .filter((i) => i.code === "unrecognized_keys")
    .flatMap((i) => i.keys ?? [])
    .filter((k): k is string => typeof k === "string")
    .map((k) => (/^[A-Za-z0-9_]{1,30}$/.test(k) ? k : "?"))
    .slice(0, 5);
  if (unknownKeys.length)
    return {
      cause: "UNKNOWN_FIELD",
      message: `No input was executed. This action type does not accept: ${unknownKeys.join(", ")}. Remove those fields. ${fix}`,
    };
  if (issues.some((i) => field(i) === "frame_id"))
    return {
      cause: "STALE_FRAME",
      message: `No input was executed. frame_id is missing. ${fix}`,
    };
  const detail = issues
    .slice(0, 3)
    .map((i) =>
      i.code === "invalid_value"
        ? `${field(i)}: unsupported value`
        : `${field(i)}: ${bound(String(i.message ?? "invalid"), 80)}`,
    )
    .join("; ");
  return {
    cause: "INVALID_FIELD",
    message: `No input was executed. Invalid action fields (${detail || "unknown"}). ${fix}`,
  };
}
/** Period-1 repeats of these are normal progress (scrolling, list navigation). */
const repeatable = new Set([
  "UP",
  "DOWN",
  "LEFT",
  "RIGHT",
  "TAB",
  "PAGEUP",
  "PAGEDOWN",
  "BACKSPACE",
  "DELETE",
]);
/**
 * In-memory identity of an executed action for loop detection; never
 * journaled. A pointer action that hit an identified control is identified by
 * that control, not its coordinates: live, eight clicks on "Saturday,
 * September 19" at x 0.961, 0.989 and 0.994 were three different signatures
 * and the loop was never seen.
 */
export function actionSignature(
  action: Action,
  target?: { role?: string; label?: string },
): string {
  const a = action as Record<string, unknown>;
  const parts: unknown[] = [action.type];
  const label = normalizeLabel(target?.label ?? "");
  const pointer = ["click", "double_click", "right_click", "move"].includes(
    action.type,
  );
  if (pointer && label) {
    parts.push("target", normalizeRole(target?.role ?? ""), label);
    if (typeof a.button === "string") parts.push("button", a.button);
    return JSON.stringify(parts);
  }
  for (const f of numericEcho) {
    const v = a[f];
    if (typeof v === "number") parts.push(f, Math.round(v * 100) / 100);
  }
  if (typeof a.label === "string") parts.push("label", normalizeLabel(a.label));
  if (Array.isArray(a.path)) parts.push("path", a.path.join(">"));
  if (typeof a.key === "string") parts.push("key", a.key);
  if (Array.isArray(a.keys)) parts.push("keys", a.keys.join("+"));
  if (typeof a.text === "string")
    parts.push("text", a.text.length, a.text.slice(0, 20));
  if (typeof a.name === "string") parts.push("name", a.name);
  if (typeof a.path === "string") parts.push("path", a.path);
  // The same tool with the same arguments is the same step, however the
  // arguments are ordered; the hash keeps the arguments out of memory.
  if (action.type === "tool_call")
    parts.push("tool", action.tool, argsHash(action.args));
  return JSON.stringify(parts);
}
/** Returns the cycle period (1 or 2) formed by the last four signatures. */
export function repetitionPeriod(signatures: string[]): 0 | 1 | 2 {
  if (signatures.length < 4) return 0;
  const [a, b, c, d] = signatures.slice(-4);
  if (a !== c || b !== d) return 0;
  if (a !== b) return 2;
  const parts = JSON.parse(a) as unknown[];
  if (parts[0] === "scroll" || parts[0] === "wait") return 0;
  if (
    parts[0] === "key" &&
    parts[1] === "key" &&
    repeatable.has(String(parts[2]))
  )
    return 0;
  return 1;
}
export const loopWarning =
  " Warning: you have repeated the same actions several times without finishing. The last steps did not make progress; re-read the screenshot and context.controls and choose a different approach.";
export const appSwitchWarning =
  " Warning: you keep switching between applications. Switching again will not show new information. Read the values you need from the current screenshot and context now and carry them in your next action's note (history keeps it for later steps), then finish the step in this application.";
/**
 * The history line for an approval the user declined: the question they said
 * no to, so the model knows which kind of step asks, and the two routes left
 * (one that needs no approval, or an honest finish). It never suggests
 * request_user: the user has just answered, and asking again hands the task
 * off. Live (cycle 20260919-0226), five runs proposed the same kind of step
 * three times running after "choose a different approach" and paused.
 */
export const declinedResult = (question: string) =>
  `The user declined: ${question} Do not propose this step again; a step of the same kind asks again. Take a route that needs no approval (a listed control, a menu item from context.menus, the application's own shortcut), or finish: fail and say what needed approval. Done only when the objective is already visibly complete: it is checked once more against a fresh screenshot, and its summary must say what on screen shows it.`;
/**
 * The history line for a done said after a step of this run was declined or
 * refused. The runner cannot tell a route taken around the refusal from a
 * claim made over it (cycle 20260919-0816-a839d34: two rename runs pressed
 * on after six declined Returns each and said done with the files not
 * renamed), so the claim is not accepted bare: the model reads the refusal
 * again with a fresh screenshot and says done again, with what shows it, or
 * fail. Once per refusal; the run is never failed by the runner's own hand,
 * which would only move a false done into the honest-failure column.
 */
export const doneChallenge = (refusal: string) =>
  `Not accepted yet. Earlier in this run a step was not allowed (${bound(refusal, 240)}), so this done is checked once against a fresh screenshot. If the outcome the objective asked for is visible on it, say done again with a summary that leads with what on screen shows it. If that step was needed to finish, say fail and name what needed approval; never claim done for work the screen does not show.`;
/**
 * The history result for an open_app that brought a running application to
 * the front with no window, after its own Window menu showed none either
 * (live: Calendar). Without it the model read the app behind as the one it
 * opened, or opened it again. Content-free apart from the display name.
 */
export const windowlessResult = (name: string) =>
  `${name} is open but shows no window. Use its Window menu or File > New (its New shortcut) to show one; don't open it again.`;
/**
 * The refusal of a second open_app for an application the last executed step
 * already brought up windowless. Policy allows open_app of a windowless
 * frontmost app so the helper can restore its window once; after that the
 * same call returns the same result, and each execution resets the retry
 * count, so only this keeps the targeting hand-off within reach.
 */
export const windowlessRepeat = (name: string) =>
  `No input was sent. ${name} is open but shows no window, and opening it again will not show one. Use its Window menu or File > New.`;
/**
 * What one observation looked like, for the no-progress check. It is compared
 * in memory only: never journaled, never sent and never stored.
 */
export interface ProgressProbe {
  appId?: string;
  windowTitle?: string;
  sha256: string;
  /** Identity (not contents) of the focused element, from the same surface. */
  focused?: string;
  controls: number;
}
/** Reuses the fields the runner already has; it costs no extra native call. */
export function progressProbe(frame: Frame, surface?: Surface): ProgressProbe {
  return {
    appId: frame.appId,
    windowTitle: frame.context?.windowTitle,
    sha256: frame.sha256,
    focused: surface
      ? [
          surface.focusedRole ?? "",
          surface.focusedSubrole ?? "",
          surface.focusedLabel ?? "",
        ].join("\u0000")
      : undefined,
    controls: frame.context?.controls?.length ?? 0,
  };
}
/** True when nothing the runner can see changed between the two observations. */
export function sameProbe(a: ProgressProbe, b: ProgressProbe): boolean {
  return (
    a.sha256 === b.sha256 &&
    a.appId === b.appId &&
    a.windowTitle === b.windowTitle &&
    a.focused === b.focused &&
    a.controls === b.controls
  );
}
/**
 * Advice added to the last history entry when two actions of the same type in
 * a row changed nothing on screen. It is advice, not a failure: the run keeps
 * going, policy still decides every step, and it is added once per stall.
 */
export const noProgressWarning =
  " Note: this action produced no visible change (same application, window, screenshot and focus), and the one before it did not either. Repeating it will not work: take a different route now, such as a keyboard shortcut from context.playbook, the menu bar, or request_user to ask the user.";
/**
 * Refused targets in a row, since the last executed step, before the model is
 * asked to conclude; one more after that hands the task to the user.
 */
const REFUSED_TARGETS_LAST_WORD = 3;
/**
 * Advice added to the third refused target in a row. The user's click resolves
 * a control the helper cannot identify, not a path that is not in the index or
 * a chord nothing verifiable holds focus for, and the bench has nobody to
 * click at all (cycle 20260919-0226: seven runs handed off this way, three of
 * them with no step executed, none had asked the user). So before the hand-off
 * the model gets one step to conclude: a route it has not tried, an honest
 * fail, or a question only the user can answer. Advice like noProgressWarning:
 * no decision changes, and a refused target after it hands over as before.
 */
export const refusedTargetsWarning =
  " Three targets in a row were refused and nothing was sent. Do not aim at another. Take a route you have not tried (context.menus, context.controls, context.playbook); if what the objective needs is not there (a file, a folder, a control, an application), stop with fail and say what is missing; request_user only for a step only the user can do.";
/**
 * What moved when native refused a step, in the model's terms, so it changes
 * approach instead of proposing the same step again (live: six identical
 * CMD+N refused while Calendar's focus settled after launch).
 */
const screenChangeDetail: Record<ScreenChange, string> = {
  FOCUS_CHANGED:
    "The focused element changed between the screenshot and the input",
  APP_CHANGED: "Another application came to the front",
  WINDOW_CHANGED: "The window moved, resized or was replaced",
  DISPLAY_CHANGED: "The display changed",
  CONTROLS_CHANGED:
    "The window's controls changed (something opened, closed or updated)",
  TARGET_COVERED: "Another control now covers the target",
  PIXELS_CHANGED:
    "The content at the target changed (it may still be loading or animating)",
  STALE_FRAME: "A newer screenshot replaced the one this step was chosen from",
  FRAME_EXPIRED: "The screenshot this step was chosen from is too old",
  MENU_CHANGED:
    "The application's menus no longer give this shortcut the command it was checked against",
};
export function screenChangedResult(
  change: ScreenChange | undefined,
  action?: Action,
): string {
  const detail = change
    ? screenChangeDetail[change]
    : "The target or window changed";
  // A shortcut the application lists in its menus is already pressed as that
  // item, so one refused here went as keys: a text or clipboard chord, an
  // unpublished one, or an approved one. Sending the model to menu_item would
  // skip the focus check (and, for a paste, the paste rule) those keep.
  const hint =
    change === "FOCUS_CHANGED" && action?.type === "hotkey"
      ? " A shortcut goes to whichever element has focus: wait for the screen to settle and check where focus is in the new screenshot before pressing it again."
      : "";
  return `No input was sent. ${detail}; choose an action from the new screenshot. Any earlier approval has expired.${hint}`;
}
/**
 * The step as native executes it. Native refuses every clipboard chord unless
 * policy marked this one as the paste the user asked for. A hotkey carries the
 * menu item policy judged it by (surface's shortcutLabel, absent when the chord
 * named none), so a chord that names another item by the time it is pressed is
 * refused instead of pressing an item policy never saw. An approved step is
 * marked so native checks it as strictly as keys after the approval (a menu
 * command acts on whatever holds focus or selection).
 */
export function nativeAction(
  action: Action,
  decision: Decision,
  surface: Surface,
): Action {
  if (decision.reason === PASTE_ALLOWED)
    return { ...action, paste: true } as unknown as Action;
  const label =
    action.type === "hotkey" && surface.shortcutLabel
      ? { shortcutLabel: surface.shortcutLabel }
      : {};
  const approved = decision.kind === "CONFIRM" ? { approved: true } : {};
  if (!Object.keys(label).length && !Object.keys(approved).length)
    return action;
  return { ...action, ...approved, ...label } as unknown as Action;
}
const noInput = (reason: string) =>
  /^No input was (sent|executed)/.test(reason)
    ? reason
    : `No input was sent. ${reason}`;
/**
 * Names the verified control an executed step acted on, so the model remembers
 * what it pressed ("click on button “1”") instead of only raw coordinates.
 * Without it, models treated their own earlier input as leftover state and
 * undid it. Uses accessibility names only (never field contents).
 */
export function executedTarget(
  action: Action,
  surface: Surface,
  via?: ExecutionResult["via"],
): string {
  const bounded = (text: string) => {
    const clean = redactSecrets(text.replace(/\s+/g, " ").trim());
    return clean.length > 60 ? clean.slice(0, 59) + "…" : clean;
  };
  // Named targets say what was pressed without reading the screen: the name is
  // the agent's own, and native resolved it to that exact item.
  if (action.type === "menu_item")
    return ` ${bounded(action.path.join(" > "))} in the menus`;
  // A published chord is pressed as its menu item, so it is named like one.
  if (action.type === "hotkey" && via === "menu" && surface.shortcutLabel)
    return ` ${action.keys.join("+")} as “${bounded(surface.shortcutLabel)}” in the menus`;
  if (
    ["click", "double_click", "right_click", "click_control"].includes(
      action.type,
    )
  ) {
    // Native targetLabel can fall back to AXValue; for editable fields use
    // only the field label that native puts in targetText.
    const editableTarget = ["AXTextField", "AXTextArea", "AXComboBox"].includes(
      surface.targetRole ?? "",
    );
    const label = bounded(
      (!editableTarget && surface.targetLabel) ||
        (surface.targetText ?? "").split(" · ")[0] ||
        "",
    );
    const role = (surface.targetRole ?? "")
      .replace(/^AX/, "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase();
    const verb =
      action.type === "click_control"
        ? " click"
        : ` ${action.type.replace("_", " ")}`;
    if (!label) return role ? `${verb} on a ${role}` : "";
    return `${verb} on ${role || "control"} “${label}”`;
  }
  if (action.type === "type_text" && surface.focusedLabel)
    return ` typing into “${bounded(surface.focusedLabel)}”`;
  return "";
}
// Label and role rules live in src/core/labels.ts so learning and replay agree.
export { normalizeLabel, normalizeRole };
const pointerTypes = new Set(["click", "double_click", "right_click", "move"]);
/**
 * Pointer actions one automatic re-aim may repeat at a new position. `drag` is
 * deliberately absent (it is not a pointer type either): it has two endpoints
 * and a path, so a moved target does not translate into the same gesture.
 */
const reaimTypes = new Set(["click", "double_click", "right_click", "move"]);
/**
 * A pointer action re-aimed at the same control in a fresh frame after the
 * screen moved under it. It re-runs the whole pipeline (validation, surface,
 * policy, approval, native revalidation and execute) as the same step, with no
 * new model call. `epoch` and `handsOn` record the runner state it was made
 * in: if either changed (pause, correction, takeover or stop) it is dropped.
 */
interface Reaim {
  action: Record<string, unknown>;
  frame: Frame;
  epoch: number;
  handsOn: boolean;
}
/**
 * Added to the executed step's history entry after an automatic re-aim, so the
 * model's next observation is honest about what actually ran.
 */
export const reaimNote =
  " Note: the screen moved after that screenshot, so this input was automatically re-aimed at the same control (same role and name) in a fresh screenshot before it ran. Only its position changed, not the control.";
/** Pause shown while the user's own mouse or keyboard input holds the run. */
/**
 * The application's own search command to run when typing was refused because
 * nothing identified is focused (Spotify publishes no text fields, but its
 * Edit > Search opens one). Taking the route is a normal menu_item step: it goes
 * through surface, policy and native revalidation like any proposed action, and
 * the model then types into the field the application opened. Undefined when
 * the refusal was for anything else, when a search is already open, or when the
 * application publishes no such command.
 */
export function searchRoute(
  action: Action,
  surface: Surface,
): string[] | undefined {
  if (action.type !== "type_text" || surface.unknown || surface.searchOpenedBy)
    return undefined;
  const path = surface.searchCommand;
  return Array.isArray(path) &&
    path.length >= 2 &&
    path.length <= 3 &&
    path.every((part) => typeof part === "string" && part.trim())
    ? path.map((part) => part.trim())
    : undefined;
}
/**
 * Whether the user's own words asked for a paste. Only then may policy allow
 * Command-V, and only into an identified text field.
 */
export function pasteRequested(
  task: string,
  corrections?: { text: string }[],
  taskSource?: TaskSource,
): boolean {
  // A task the model rewrote or offered is not the user's own words, even
  // after a "yes"; corrections are always the user's.
  const own =
    taskSource === undefined ||
    taskSource === "user_words" ||
    taskSource === "user_words_unsure";
  return /\bpaste\b/i.test(
    [own ? task : "", ...(corrections ?? []).map((c) => c.text)].join("\n"),
  );
}
export const MANUAL_PAUSE_MESSAGE = "Paused — you’re controlling the computer.";
/** Hand-off after repeated unidentified targets; a click by the user resolves it. */
export const TARGET_HANDOFF_MESSAGE =
  "I can’t find the right control. Click it for me and I’ll continue.";
/**
 * The one step a spoken "undo" takes: the frontmost application's own Edit >
 * Undo, pressed by name like any menu item (never a raw CMD+Z), and what the
 * run says about it afterwards.
 */
export const UNDO_MENU_PATH = ["Edit", "Undo"];
export const UNDONE_MESSAGE = "Undone.";
export const NOTHING_TO_UNDO_MESSAGE = "Nothing to undo.";
/** A tool's own undo was tried first and did not go through. */
export const TOOL_UNDO_FAILED_MESSAGE =
  "I couldn’t take the last tool step back.";
/**
 * How long a long-running tool call (the coding agent) counts toward
 * maxSeconds; the time beyond it is the tool's, excluded like held time.
 */
const LONG_CALL_FREE_MS = 30000;
/** Plans never contain terminal or free-form steps; those stay model-only. */
const unplannable = new Set([
  "done",
  "fail",
  "request_user",
  "drag",
  "monitor",
]);
const recallBudgetMs = 2000;
/** After the last plan step, recheck completeWhen this many times, this far apart. */
const planRechecks = 3;
const planRecheckMs = 500;
const planVerifyNote =
  "Known plan steps were executed; verify the result on the current screen and finish";
/**
 * Whether a committed page host (Surface.domain) is `host` or a subdomain of
 * it. A leading "www." is ignored on both sides.
 */
export function pageHostMatches(domain: unknown, host: unknown): boolean {
  if (typeof domain !== "string" || typeof host !== "string") return false;
  const clean = (h: string) =>
    h
      .trim()
      .toLowerCase()
      .replace(/\.$/, "")
      .replace(/^www\./, "");
  const have = clean(domain);
  const want = clean(host);
  if (!have || !want) return false;
  return have === want || have.endsWith("." + want);
}
/** Role and label of the pointer target an executed step acted on (never field values). */
export function surfaceTarget(
  action: Action,
  surface: Surface,
): { role?: string; label?: string } | undefined {
  if (!pointerTypes.has(action.type) || !surface.targetRole) return undefined;
  const editable = ["AXTextField", "AXTextArea", "AXComboBox"].includes(
    surface.targetRole,
  );
  const raw =
    (!editable && surface.targetLabel) ||
    (surface.targetText ?? "").split(" · ")[0] ||
    "";
  // The observed label as is (no ellipsis); learning cuts it to the native limit.
  const label = utf16Prefix(
    redactSecrets(raw.replace(/\s+/g, " ").trim()),
    200,
  );
  return {
    role: surface.targetRole.slice(0, 60),
    ...(label ? { label } : {}),
  };
}
const pastTense: Record<string, string> = {
  open: "Opened",
  switch: "Switched",
  go: "Went",
  search: "Searched",
  type: "Typed",
  press: "Pressed",
  click: "Clicked",
  enter: "Entered",
  select: "Selected",
  scroll: "Scrolled",
  choose: "Chose",
  play: "Played",
  use: "Used",
};
/** Local summary for a plan completed without a model call ("Opened Calculator."). */
export function planSummary(plan: Pick<ReplayPlan, "outline">): string {
  const lines = plan.outline
    .map((line) => line.replace(/\s+/g, " ").trim().replace(/[.]+$/, ""))
    .filter(Boolean)
    .map((line) => {
      const [first, ...rest] = line.split(" ");
      const verb = pastTense[first.toLowerCase()];
      return verb ? [verb, ...rest].join(" ") : line;
    });
  if (!lines.length) return "Done.";
  const text = lines
    .map((line, i) => (i ? line[0].toLowerCase() + line.slice(1) : line))
    .join(", ");
  return redactSecrets(bound(text, 300)) + ".";
}
/**
 * Who answered a pending approval; journaled on UserConfirmed/UserDenied. A
 * "yes" typed in the command bar is "typed", not a click on the pill; a phone
 * ("message", "remote") can only ever decline.
 */
export type ApprovalSource = "voice" | "pill" | "typed" | "message" | "remote";
/**
 * Why the run handed control to the user. "manual_input" is the user acting
 * on their own; the rest are the runner asking: a model question, a policy
 * hand-off, a surface the helper refused, or a target it could not find.
 */
export type TakeoverSource =
  "manual_input" | "request_user" | "policy" | "surface" | "handoff";
/**
 * Where the user's own input landed, as the helper's tap reports it for a
 * background run (design §3): "target" inside the bound window's uncovered
 * rectangles, or a key while that application is frontmost; "screen" is
 * anywhere else, which is normal life for a bound run and a takeover for
 * every other run.
 */
export type TakeoverScope = "screen" | "target";
/** The run a monitor step hands its window over from. */
export interface MonitorHandoff {
  id: string;
  task: string;
  taskSource?: TaskSource;
  origin?: RunOrigin;
  /** Display name of the watched application, for what is said about it. */
  appName?: string;
  /**
   * The actions this run executed, oldest first (the last few): the watch
   * words them for the wake-up run as steps already taken, never quoting
   * typed text (src/assistant/steps.ts, which core cannot import).
   */
  steps: Action[];
  /** The user's corrections to this run, in order: they bind the wake-up run too. */
  corrections: string[];
  /** Set when a watch woke this run: a new watch continues that chain. */
  chain?: WatchChain;
}
/**
 * A step executed before this run existed, while the user was still speaking
 * ("open Slack and…" brings Slack forward before "and"; "go to youtube and…"
 * the browser; "open downloads and…" the folder in Finder):
 * electron/early-start.ts took it through the same native verification and
 * policy as a run step, and the run journals it as its own first frame and
 * step.
 */
export interface RunPrelude {
  /** The frame the step was verified against, captured before the run. */
  frame: Frame;
  /** surface(action) at execute time: the launcher or file resolution policy saw. */
  surface: Surface;
  /** frame_id is frame.id. An open_file only ever opens a standard folder. */
  action: Extract<Action, { type: "open_app" | "open_file" }>;
  /** The ALLOW decision's reason. */
  reason: string;
  outcome?: ExecutionResult;
  /** The final words were exactly this step ("Open Slack."). */
  completes: boolean;
}
/**
 * A run's first step prepared before its words were final (docs/VOICE_PRODUCT.md
 * "Thinking ahead"; design .data/design/endpoint-decider.md §3.3). Runner.prepare
 * takes the first capture and, when that step needs one, sends the model's
 * first request for the hypothesis, exactly as start() would, and holds every
 * effect: nothing is journaled, shown, spoken or executed until
 * start(task, { prepared }) adopts the step for the final words, and a step
 * the final does not keep is let go with discard(). A prepared proposal is
 * never more than a proposal: the adopting run validates it, fetches its
 * surface and takes it through policy and approval like any model step.
 */
export interface PreparedStep {
  /** The words the step was prepared for (the router's task text). */
  readonly task: string;
  /**
   * "model" once the model's first request is in flight; "frame" while, or
   * when, the frame alone is prepared (a recalled plan, a dictation into a
   * focused field, a listed tool step or an undo proposes without the model).
   */
  readonly kind: "model" | "frame";
  /**
   * Resolves once the preparation has done what it can (never rejects): the
   * frame taken and the request sent, or the step given up.
   */
  readonly ready: Promise<void>;
  /** Why the preparation gave up, if it did; undefined while it stands. */
  readonly code: string | undefined;
  /** What the request cost, once it answered; undefined before, and for a frame. */
  readonly usage: Usage | undefined;
  /** Lets the step go: the request in flight is aborted, the frame dropped, nothing journaled. */
  discard(code: string): void;
}
/** A prepared frame older than this when the run starts is dropped (native refuses at 30 s). */
export const PREPARED_FRAME_MAX_AGE_MS = 20_000;
/** What one prepare() holds until start() or discard() decides. */
interface Preparation {
  handle?: PreparedStep;
  task: string;
  run: Run;
  abort: AbortController;
  startedAt: number;
  /** The journal, in order, written only once a run adopts the step. */
  deferred: (
    { type: string; data: Record<string, unknown> } | { frame: Frame }
  )[];
  kind: "model" | "frame";
  frame?: Frame;
  capturedAt?: number;
  screenshot?: ScreenshotUse;
  proposal?: Promise<ProviderResult>;
  /** When the proposal arrived, if it has. */
  proposedAt?: number;
  usage?: Usage;
  /** Set once the preparation ended without a step to adopt. */
  code?: string;
  ready: Promise<void>;
}
/** The words of two task texts, compared: case, punctuation and spacing aside. */
const taskWords = (text: string) =>
  text
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
/** What Runner.start is told about the run it begins. */
export interface StartOptions {
  origin?: RunOrigin;
  taskSource?: TaskSource;
  /** Set on a run a detached watch woke (electron/watch.ts). */
  watch?: WatchContext;
  /** The chain that watch belongs to, for a watch this run starts. */
  chain?: WatchChain;
  /** A step taken while the user was still speaking (electron/early-start.ts). */
  prelude?: RunPrelude;
  /**
   * The words only asked to type this text ("type see you at six",
   * src/voice/dictation.ts): with a known text field focused on the first
   * frame it is typed there without a model call and the run is over.
   */
  dictation?: string;
  /**
   * The task is the user's spoken "undo" right after a run ended: the one
   * step is Edit > Undo, without a model call, and the run ends with what
   * happened.
   */
  undo?: boolean;
  /**
   * One tool step decided before the run (src/assistant/tool-answers.ts toolFastPath): proposed on
   * the first frame as { type: "tool_call", tool, args, finish: true } with no model call; validation,
   * policy and approval apply as to any step, and a tool missing from the frozen list leaves it to the model.
   */
  toolStep?: { tool: string; args: Record<string, unknown> };
  /**
   * Work in a bound window in the background (design §2.2): the window
   * the words name ("in Slack"), the one the prelude opened, or the one
   * focused when the wake word ended. Asked for when the setting is on
   * and the user is at the Mac; the run takes the screen as before when
   * no window binds.
   */
  background?: boolean;
  /**
   * The first step this runner prepared for these words while the user was
   * still speaking (Runner.prepare): its frame is the run's first frame and
   * its proposal, if it made one, the first model result, so the first
   * action comes that much sooner. Dropped, with the run capturing afresh,
   * when the step gave up, the words differ, a prelude preceded it, the
   * frame is older than PREPARED_FRAME_MAX_AGE_MS or another application
   * is in front. Never with a tutorial.
   */
  prepared?: PreparedStep;
}
/** What Runner.prepare is told; a prelude, a watch or another preparation never joins one. */
export type PrepareOptions = Omit<
  StartOptions,
  "watch" | "chain" | "prelude" | "prepared"
>;
/** Executed actions kept for a monitor handoff. */
const HANDOFF_STEPS = 12;
/** Hooks outside the run loop (increment 5A: the detached watch). */
export interface RunnerExtras {
  /**
   * A monitor step bound the frontmost window natively; the watch takes it
   * from here and the run completes. Without this hook monitor is refused.
   */
  onMonitor?(binding: WatchBinding, spec: WatchSpec, run: MonitorHandoff): void;
  /** The tool layer (src/tools registry). Without it a tool_call is refused with TOOL_UNAVAILABLE. */
  tools?: ToolAccess;
}
export class Runner {
  settled = true;
  snapshot: Snapshot = {
    run: null,
    frame: null,
    events: [],
    message: "Ready when you are.",
  };
  private abort = new AbortController();
  private held = false;
  private wake?: () => void;
  private approval?: (yes: boolean) => void;
  private started = 0;
  // Budget time spent paused, in takeover or waiting for approval.
  private heldMs = 0;
  private heldSince?: number;
  private timer?: ReturnType<typeof setTimeout>;
  private history: History = [];
  private invalidActions = 0;
  private denials = 0;
  private credentialDenials = 0;
  private declines = 0;
  private targetingRetries = 0;
  /**
   * The last step of this run the user declined or the policy refused, and
   * whether a done since has been checked against it (doneChallenge). Set
   * for the run, not the streak: a pause, a hint or a correction resets the
   * counters, but does not make the objective complete.
   */
  private refused?: { line: string; checked: boolean };
  /** Applications whose search route the runner already took this run. */
  private searchRoutes = new Set<string>();
  private stateChanges = 0;
  private providerFailures = 0;
  private epoch = 0;
  /** Bumped by amendTask; lets an in-flight recall see the task changed. */
  private amendments = 0;
  /** Actions sent to the controller this run, including interrupted ones. */
  private attempted = 0;
  private interrupts = 0;
  private voiceApproval = false;
  /** Set by confirm()/approveFromVoice(); read once by the approval loop. */
  private approvalSource?: ApprovalSource;
  private signatures: string[] = [];
  private switches: (string | null)[] = [];
  /** The app the last executed open_app left frontmost with no window. */
  private windowlessApp?: { appId: string; name: string };
  private switchWarned = false;
  private loopWarned = false;
  private sinceLoopWarning = 0;
  /** The screen the last executed action ran on, with that action's type. */
  private progress?: { type: string; probe: ProgressProbe };
  /**
   * What the model saw last (src/core/vision.ts): the hash and context of the
   * frame it was sent, the steps since it last had a screenshot, and the
   * action executed since, with whether native input verified its target.
   */
  private shown?: { sha256: string; context: string };
  private sinceImage = 0;
  private lastStep?: { type: string; confirmed: boolean };
  /** Type of the run of actions that is changing nothing, and its length. */
  private stalledType?: string;
  private stalls = 0;
  private stallNoted = false;
  private memoryContext?: MemoryContext;
  /** Active replay plan; cleared for good once abandoned or finished. */
  private plan?: ReplayPlan;
  private planIndex = 0;
  /** Index of a proposed plan step that has not executed yet. */
  private planPending?: number;
  private planChecked = 0;
  private planResult?: {
    id: string;
    source: "skill" | "intent";
    completedSteps: number;
    abandoned: boolean;
    abandonReason?: string;
  };
  private lastOpened = false;
  /** Surface fetched by the latest capture(), for completeWhen.host. */
  private lastSurface?: Surface;
  /** The user acted during this run (takeover, hand-off or correction). */
  private handsOn = false;
  private trajectory: TrajectoryStep[] = [];
  private appsSeen = new Set<string>();
  /** Why a watch woke this run; given to the model with every frame. */
  private watchContext?: WatchContext;
  /** The chain of watches and wakes this run belongs to, when a watch woke it. */
  private watchChain?: WatchChain;
  /** The last few actions executed, for a monitor handoff. */
  private executed: Action[] = [];
  /** The tools this run may call, listed once and frozen; unset without the tool layer. */
  private toolList?: ToolList;
  /**
   * The clock line the frozen list is shown with, taken when the list is:
   * context.tools rides in the request's cacheable workspace part, so it
   * must not change from step to step (policy grounds dates on the live
   * clock, never on this line).
   */
  private toolNow?: string;
  /** The tool whose call did not go through, named on the next screen step's status line. */
  private toolFallback?: string;
  /**
   * The app or folder a prelude opened: a recalled plan that starts by
   * opening it continues at its next step, and with completes the run ends
   * once the app (Finder, for a folder) is in front (checked once, on the
   * first observation).
   */
  private prelude?: {
    appId?: string;
    names: Set<string>;
    paths: Set<string>;
    display: string;
    completes: boolean;
  };
  /**
   * A spoken "undo" waiting to be pressed as the next step. `own`: the run
   * exists for it alone (start with `undo`) and ends with what happened;
   * otherwise it steers a run under way, which pauses again afterwards. A
   * pause meanwhile (the user's, or a declined approval) drops it.
   */
  private undoRequest?: { own: boolean };
  /**
   * The window this run is bound to (design §2.2). It stays for the run's
   * life so the pill can name it; run.target.background says whether steps
   * still go to it in the background.
   */
  private target?: RunTarget;
  /** Misses per kind of step and rung this run (missKey): two, and that rung is skipped for the rest of it. */
  private rungMisses = new Map<string, number>();
  /** Points refused in a row because the covered window's picture may be stale: the second goes in front. */
  private coveredStaleRefusals = 0;
  /** What the postcondition reads found this run, for memory (bounded). */
  private backgroundObservations: BackgroundObservation[] = [];
  /** Run steps at which the window had to come in front, for the cap. */
  private foregroundSteps: number[] = [];
  /** Routes memory says applications drop in the background, by bundle id. */
  private backgroundKnowledge?: Record<string, BackgroundKnowledge>;
  /** The first step prepared before the words were final, until start() or discard() decides. */
  private preparation?: Preparation;
  /**
   * While a preparation's placeholder run stands in the snapshot: journal
   * entries go here instead of the recorder, and nothing is saved or shown.
   */
  private deferring?: Preparation["deferred"];
  /** Routes memory pruned that the pill has named this run. */
  private routesNoted = new Set<BackgroundRoute>();
  /** The bound window is in front for a step: the user's input anywhere pauses the run, as it always did. */
  private inFront = false;
  constructor(
    private controller: Controller,
    private provider: Provider,
    private recorder: Recorder,
    private settings: Settings,
    private emit: (s: Snapshot) => void,
    private recentTasks: ScreenContext["recentTasks"] = [],
    private memory?: MemoryAccess,
    private extras: RunnerExtras = {},
  ) {}
  /**
   * Apply saved settings to the active run. Budgets take effect on the next
   * loop check (and the runtime timer is rescheduled now); protection lists
   * apply to the next policy evaluation.
   */
  updateSettings(next: Settings) {
    this.settings = next;
    if (this.active()) this.schedule();
  }
  private resetLoop() {
    this.signatures = [];
    this.switches = [];
    this.windowlessApp = undefined;
    this.switchWarned = false;
    this.loopWarned = false;
    this.sinceLoopWarning = 0;
    // The user may have changed the screen: the next step sees all of it.
    this.shown = undefined;
    this.lastStep = undefined;
    this.resetProgress();
  }
  private resetProgress() {
    this.progress = undefined;
    this.stalledType = undefined;
    this.stalls = 0;
    this.stallNoted = false;
  }
  /**
   * Compares the fresh observation with the screen the last executed action
   * ran on. When two actions of the same type in a row leave the application,
   * window, screenshot, focus and control count unchanged, one line of advice
   * is added to the history the model already sees, once per stall. The run is
   * never aborted and no policy step is skipped; when the screen changed, the
   * counters reset and nothing is added.
   */
  private trackProgress(frame: Frame) {
    const last = this.progress;
    this.progress = undefined;
    if (!last) return;
    if (!sameProbe(last.probe, progressProbe(frame, this.lastSurface))) {
      this.stalledType = undefined;
      this.stalls = 0;
      this.stallNoted = false;
      return;
    }
    if (last.type !== this.stalledType) {
      this.stalledType = last.type;
      this.stalls = 1;
      this.stallNoted = false;
      return;
    }
    if (++this.stalls < 2 || this.stallNoted) return;
    const entry = this.history[this.history.length - 1];
    if (!entry || entry.type !== last.type) return;
    this.stallNoted = true;
    this.event("NoProgressDetected", { actionType: last.type });
    entry.result += noProgressWarning;
  }
  /**
   * Track an executed action. Returns "warn" when the last executed actions
   * form a short cycle for the first time and "stuck" when the cycle continued
   * for four more actions after the warning.
   */
  private trackLoop(
    action: Action,
    target?: { role?: string; label?: string },
  ): "warn" | "stuck" | undefined {
    this.signatures = [
      ...this.signatures.slice(-3),
      actionSignature(action, target),
    ];
    const period = repetitionPeriod(this.signatures);
    if (!period) {
      this.loopWarned = false;
      this.sinceLoopWarning = 0;
      return undefined;
    }
    if (!this.loopWarned) {
      this.loopWarned = true;
      this.sinceLoopWarning = 0;
      this.event("ActionLoopDetected", { actionType: action.type, period });
      return "warn";
    }
    if (++this.sinceLoopWarning >= 4) {
      this.resetLoop();
      return "stuck";
    }
    return undefined;
  }
  /**
   * Live runs showed models bouncing between two apps (open_app A, B, A, B
   * with a click in between) without reading what they needed. Returns true
   * once when at least four of the last eight executed steps switched apps
   * across two or more applications.
   */
  private trackAppSwitch(action: Action, appId?: string): boolean {
    this.switches = [
      ...this.switches.slice(-7),
      action.type === "open_app" ? (appId ?? action.name) : null,
    ];
    const opened = this.switches.filter((s): s is string => s !== null);
    if (opened.length < 4 || new Set(opened).size < 2) {
      if (opened.length < 2) this.switchWarned = false;
      return false;
    }
    if (this.switchWarned) return false;
    this.switchWarned = true;
    this.event("ActionLoopDetected", { actionType: "open_app", period: 0 });
    return true;
  }
  private publish() {
    // A preparation's run was never begun: nobody is shown it.
    if (this.deferring) return;
    this.emit(structuredClone(this.snapshot));
  }
  private event(type: string, data: Record<string, unknown> = {}) {
    if (this.deferring) {
      this.deferring.push({ type, data });
      return;
    }
    // A preparation's placeholder run was dropped under a late continuation.
    if (!this.snapshot.run) return;
    const e = this.recorder.append(this.snapshot.run.id, type, data);
    this.snapshot.events.push(e);
    this.publish();
  }
  private status(status: RunStatus, message?: string) {
    if (!this.snapshot.run) return;
    // A late async continuation must never revive a finished run.
    if (terminal(this.snapshot.run.status)) return;
    this.snapshot.run.status = status;
    if (message) this.snapshot.message = message;
    if (this.deferring) return;
    this.recorder.save(this.snapshot.run);
    this.publish();
  }
  private active() {
    return !!this.snapshot.run && !terminal(this.snapshot.run.status);
  }
  private activeElapsed() {
    const now = Date.now();
    return (
      now -
      this.started -
      this.heldMs -
      (this.heldSince === undefined ? 0 : now - this.heldSince)
    );
  }
  private schedule() {
    clearTimeout(this.timer);
    if (!this.active() || this.heldSince !== undefined) return;
    const remaining = this.settings.maxSeconds * 1000 - this.activeElapsed();
    this.timer = setTimeout(
      () => {
        if (!this.active() || this.heldSince !== undefined) return;
        if (this.activeElapsed() >= this.settings.maxSeconds * 1000)
          this.stop("Runtime budget reached.");
        else this.schedule();
      },
      Math.max(0, remaining),
    );
  }
  private markHeld() {
    if (this.heldSince === undefined) this.heldSince = Date.now();
    clearTimeout(this.timer);
  }
  private markActive() {
    if (this.heldSince !== undefined) {
      this.heldMs += Date.now() - this.heldSince;
      this.heldSince = undefined;
    }
    this.schedule();
  }
  private resetCounters() {
    this.invalidActions = 0;
    this.denials = 0;
    this.credentialDenials = 0;
    this.declines = 0;
    this.targetingRetries = 0;
    this.stateChanges = 0;
    this.providerFailures = 0;
    this.searchRoutes.clear();
  }
  private check() {
    if (!this.active()) throw new Error("STOPPED");
    if (this.activeElapsed() >= this.settings.maxSeconds * 1000)
      throw new Error("Runtime budget reached.");
    if (this.snapshot.run!.actions >= this.settings.maxActions)
      throw new Error("Action budget reached.");
    if (this.snapshot.run!.usage.cost >= this.settings.maxCost)
      throw new Error("Estimated cost budget reached.");
  }
  private async ready() {
    while (this.held && this.active())
      await new Promise<void>((r) => (this.wake = r));
    this.check();
  }
  /** Wait that ends early when the run is paused or stopped. */
  private sleep(ms: number) {
    const signal = this.abort.signal;
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(t);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const t = setTimeout(done, ms);
      signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    });
  }
  pause(message = "Paused. Capture and input are stopped.") {
    if (!this.active()) return;
    this.epoch++;
    this.held = true;
    this.markHeld();
    this.abort.abort();
    this.controller.stop();
    this.voiceApproval = false;
    this.approval?.(false);
    this.snapshot.pending = undefined;
    // The screen may change while held; a replay never continues after it.
    this.abandonPlan("paused");
    this.undoRequest = undefined;
    this.event("RunPaused");
    this.status("paused", message);
  }
  /**
   * The user's own mouse or keyboard. For a run bound to a background window
   * their hands elsewhere are the point, not a takeover (design §3): only
   * input aimed at the bound window pauses it, or any input while the window
   * is in front for a step. Every other run pauses as it always did.
   */
  manualTakeover(scope: TakeoverScope = "screen") {
    const target = this.boundTarget();
    if (target && scope === "screen" && !this.inFront) return;
    if (this.snapshot.pending && this.snapshot.run?.status === "confirming") {
      this.interruptForVoice();
      return;
    }
    if (!this.active()) return;
    this.handsOn = true;
    this.pause(
      target && scope === "target"
        ? targetHold(target.appName)
        : MANUAL_PAUSE_MESSAGE,
    );
    this.event("UserTakeoverStarted", {
      source: "manual_input",
      scope: target ? scope : "screen",
    });
  }
  /**
   * The bound application activated itself (Safari on an accessibility write,
   * Electron on launch) with no input from the user, and the helper put the
   * user's application back at once (design §3). Journaled; the run goes on.
   */
  targetSelfActivated() {
    if (!this.boundTarget()) return;
    this.event("TargetSelfActivated");
  }
  /**
   * The helper found the binding dead (pid, bundle, launch date or window no
   * longer match) or the window protected. Never re-resolved by name: the run
   * pauses and, on continue, takes the screen as before.
   */
  targetGone(code: TargetCode) {
    const target = this.boundTarget();
    if (!target) return;
    this.leaveBackground("gone", code);
    this.pause(targetGoneMessage(target.appName));
  }
  /** The window this run still works in from the background, if any. */
  private boundTarget(): RunTarget | undefined {
    return this.active() && this.snapshot.run?.target?.background
      ? this.target
      : undefined;
  }
  /** Steps go to the screen from here on; the binding stays for the pill and release. */
  private leaveBackground(reason: string, code?: TargetCode) {
    const run = this.snapshot.run;
    if (!run?.target?.background) return;
    run.target.background = false;
    this.event("TargetLeft", { reason, ...(code ? { code } : {}) });
    this.recorder.save(run);
  }
  stop(reason = "Stopped by you.") {
    if (!this.active()) return;
    this.abort.abort();
    this.controller.stop();
    this.held = false;
    this.voiceApproval = false;
    this.wake?.();
    this.approval?.(false);
    this.snapshot.pending = undefined;
    clearTimeout(this.timer);
    this.event("RunCancelled");
    this.status("cancelled", reason);
  }
  /**
   * Resumes a held run. True only when the run is going again: callers that
   * report the outcome (a texted "continue") must not claim a resume that a
   * pause, takeover or stop landing mid-flight undid.
   */
  async resume(): Promise<boolean> {
    if (!this.active()) return false;
    if (
      this.voiceApproval &&
      this.snapshot.pending &&
      this.snapshot.run?.status === "confirming"
    ) {
      // The approval is still pending; only re-enable native input for it.
      const epoch = this.epoch,
        interrupts = this.interrupts;
      await this.controller.resume();
      if (
        !this.active() ||
        this.held ||
        epoch !== this.epoch ||
        interrupts !== this.interrupts
      ) {
        this.controller.stop();
        return false;
      }
      this.voiceApproval = false;
      return false;
    }
    if (!this.held) return false;
    const epoch = this.epoch;
    await this.controller.resume();
    // A pause, takeover or stop that landed during the native round-trip wins.
    if (!this.active() || epoch !== this.epoch) {
      this.controller.stop();
      return false;
    }
    this.held = false;
    this.resetCounters();
    this.resetLoop();
    this.markActive();
    this.abort = new AbortController();
    this.event("UserTakeoverEnded");
    this.status("capturing", "Resuming with a fresh screenshot.");
    this.wake?.();
    return true;
  }
  confirm(yes: boolean, source: ApprovalSource = "pill") {
    this.approvalSource = source;
    this.approval?.(yes);
    this.approval = undefined;
  }
  interruptForVoice() {
    if (!this.active()) return;
    if (this.snapshot.pending && this.snapshot.run?.status === "confirming") {
      this.voiceApproval = true;
      this.interrupts++;
      this.controller.stop();
      return;
    }
    this.pause();
  }
  async approveFromVoice(yes: boolean, source: ApprovalSource = "voice") {
    const pending = this.snapshot.pending;
    if (!pending || this.snapshot.run?.status !== "confirming")
      throw new Error("Nothing to approve.");
    if (!yes) {
      this.voiceApproval = false;
      if (this.planPending !== undefined) this.abandonPlan("declined");
      this.recordDecline(pending.action, source, pending.reason);
      // A run that exists only for a declined undo has nothing left to do.
      if (this.undoRequest?.own) this.stop("Left as it was.");
      else this.pause();
      return;
    }
    if (this.voiceApproval) {
      const epoch = this.epoch,
        interrupts = this.interrupts;
      await this.controller.resume();
      if (
        !this.active() ||
        epoch !== this.epoch ||
        interrupts !== this.interrupts ||
        this.snapshot.pending !== pending
      ) {
        this.controller.stop();
        return;
      }
      this.voiceApproval = false;
    }
    this.confirm(yes, source);
  }
  /**
   * Counts model usage made on the run's behalf outside the run loop (progress
   * summaries, dialog about it) toward maxCost. Nothing stops here: the loop's
   * next check() sees the total and ends the run if the budget is spent.
   */
  addUsage(usage: Usage) {
    const run = this.snapshot.run;
    if (!run || terminal(run.status)) return;
    const keys = ["inputTokens", "outputTokens", "cost"] as const;
    // All or nothing: a broken figure must not half-apply.
    if (keys.some((k) => !Number.isFinite(usage[k]) || usage[k] < 0)) return;
    for (const k of keys) run.usage[k] += usage[k];
    this.event("UsageAdded", { usage });
    this.recorder.save(run);
  }
  async revise(text: string) {
    if (!this.active()) throw new Error("No active run.");
    text = text.trim();
    if (!text || text.length > 2000)
      throw new Error("Keep the correction under 2,000 characters.");
    if (scanText(text).some((f) => f.action === "BLOCK_UPLOAD"))
      throw new Error("Enter credentials yourself.");
    this.handsOn = true;
    // A correction changes the task; a known plan no longer applies.
    this.abandonPlan("correction");
    if (!this.held) this.pause();
    this.recordCorrection(text);
    this.resetCounters();
    this.resetLoop();
    await this.resume();
  }
  /**
   * "Undo that" during a run: a steering command, not a correction the model
   * reads. The run pauses, its next step is Edit > Undo in the frontmost
   * application (through surface, policy and the approval an "ask" setting
   * still wants, never a model call), and it reports what happened and
   * waits. The words are recorded as a correction, so when the run goes on
   * the model sees the step was taken back at the user's request.
   */
  async undo(words: string) {
    if (!this.active()) throw new Error("No active run.");
    this.handsOn = true;
    this.abandonPlan("undo");
    if (!this.held) this.pause();
    this.recordCorrection(words);
    this.undoRequest = { own: false };
    this.resetCounters();
    this.resetLoop();
    await this.resume();
  }
  private recordCorrection(text: string) {
    const correction = {
      text,
      after_action: this.snapshot.run!.actions,
      timestamp: new Date().toISOString(),
    };
    (this.snapshot.run!.corrections ??= []).push(correction);
    this.event("UserCorrectionRecorded", correction);
    this.recorder.save(this.snapshot.run!);
  }
  /** What a spoken undo came to: the run it steered waits; one of its own ends. */
  private endUndo(undo: { own: boolean }, message: string) {
    this.undoRequest = undefined;
    if (!undo.own) {
      this.pause(message);
      return;
    }
    this.snapshot.run!.summary = message;
    this.event("RunCompleted");
    this.status("completed", message);
  }
  /**
   * Replace the task with a continuation the user spoke before any action ran
   * ("open Google and…" then "check the weather"). Unlike revise() this is not
   * a correction: no UserCorrectionRecorded, no hands-on flag, and the journal
   * records only the new length. In-flight inference for the old wording is
   * discarded through the epoch; a paused or handed-off run resumes.
   */
  /** Actions attempted this run, including ones interrupted mid-execute. */
  get actionsAttempted() {
    return this.attempted;
  }
  async amendTask(text: string) {
    if (!this.active()) throw new Error("No active run.");
    const run = this.snapshot.run!;
    if (run.actions !== 0 || this.attempted !== 0)
      throw new Error("The run already acted. Give a correction instead.");
    if (this.snapshot.pending || run.status === "confirming")
      throw new Error("Answer the pending approval first.");
    text = text.trim();
    if (!text || text.length > 8000)
      throw new Error("Keep the task under 8,000 characters.");
    if (scanText(text).some((f) => f.action === "BLOCK_UPLOAD"))
      throw new Error(
        "Remove credentials from the task. Enter passwords manually during takeover.",
      );
    this.epoch++;
    this.amendments++;
    this.dropAmendedPlan();
    run.task = text;
    this.event("TaskAmended", { taskLength: text.length });
    this.recorder.save(run);
    this.resetCounters();
    this.resetLoop();
    if (this.held) await this.resume();
  }
  /**
   * A replay plan recalled for the original wording no longer applies. No
   * step has run (amendTask requires zero actions), so the plan is also no
   * evidence for or against its skill: memory sees an ordinary model run of
   * the amended task instead of a failed replay.
   */
  private dropAmendedPlan() {
    this.abandonPlan("amended");
    this.planResult = undefined;
  }
  /** Policy, surface and request_user hand-offs: the user acts next. */
  private takeover(
    reason: string,
    source: Exclude<TakeoverSource, "manual_input">,
  ) {
    this.held = true;
    this.handsOn = true;
    this.markHeld();
    this.controller.stop();
    this.abandonPlan("takeover");
    this.snapshot.frame = null;
    this.event("UserTakeoverStarted", { source });
    this.status("takeover", reason);
  }
  private reject(entry: History[number]) {
    this.history.push(entry);
  }
  /** Returns false when the counter reached its limit and the run paused. */
  private countInvalid() {
    if (++this.invalidActions < 4) return true;
    this.invalidActions = 0;
    this.pause(
      "The model keeps proposing invalid actions. Say continue to retry or give a hint.",
    );
    return false;
  }
  private recordDecline(
    action: Action,
    source: ApprovalSource,
    question: string,
  ) {
    this.event("UserDenied", {
      source,
      // The question as a code (src/core/approval-codes.ts), never its text.
      approvalCode: approvalCode(question),
      ...(action.type === "tool_call" ? { actionType: action.type } : {}),
    });
    this.reject({
      type: action.type,
      action: echoAction(action),
      result: declinedResult(question),
    });
    // A "no" to the user's own spoken undo refuses nothing the objective
    // needs, so it never puts the run's done under the check
    // (voice-undo.test.ts: the run goes on as before).
    if (!this.undoRequest) this.refused = { line: question, checked: false };
    return ++this.declines;
  }
  private recoverStateChange(error: unknown, action?: Action) {
    if (!(error instanceof ScreenChangedError)) return false;
    // The kind of change as its fixed code; the helper's sentence is not kept.
    this.event("ActionFailed", {
      code: "STATE_CHANGED",
      ...(error.change ? { change: error.change } : {}),
    });
    this.reject({
      type: "rejected",
      ...(action ? { action: echoAction(action) } : {}),
      result: screenChangedResult(error.change, action),
    });
    if (++this.stateChanges >= 3) {
      this.stateChanges = 0;
      this.pause(
        "The target keeps changing. Wait for it to settle, then continue.",
      );
    }
    return true;
  }
  /**
   * One automatic re-aim for a model-proposed pointer action whose input was
   * refused because the screen moved between the screenshot and the click.
   * The same control is looked up in a fresh frame by accessibility role and
   * normalized label — the rules skill replay uses — and exactly one enabled
   * match re-proposes the same action there. Anything unclear (no match, more
   * than one, an unidentified target, another application, a capture failure,
   * or any user intervention) returns undefined and the model is asked again
   * exactly as today. The caller re-runs the whole pipeline on the result:
   * validation, `controller.surface`, policy, approval, revalidate, execute.
   */
  private async reaim(
    action: Action,
    surface: Surface,
    epoch: number,
  ): Promise<Reaim | undefined> {
    if (!reaimTypes.has(action.type)) return undefined;
    // Only a target the policy actually identified can be recognized again.
    const target = surfaceTarget(action, surface);
    const role = normalizeRole(target?.role ?? "");
    const learned = target?.label ?? "";
    if (!role || !normalizeLabel(learned) || !surface.appId) return undefined;
    const handsOn = this.handsOn;
    if (!this.active() || this.held || epoch !== this.epoch) return undefined;
    let frame: Frame | null;
    try {
      frame = await this.capture();
    } catch {
      // A blocked or failed capture falls back to asking the model.
      return undefined;
    }
    if (
      !frame ||
      !this.active() ||
      this.held ||
      epoch !== this.epoch ||
      handsOn !== this.handsOn
    )
      return undefined;
    // Never re-aim into an application the action was not aimed at.
    if (!frame.appId || frame.appId !== surface.appId) return undefined;
    // Native control names are cut at CONTROL_LABEL_LIMIT; labelMatches
    // accepts a cut live label that the observed label starts with.
    const matches = (frame.context?.controls ?? []).filter(
      (c) =>
        c.enabled !== false &&
        typeof c.label === "string" &&
        typeof c.role === "string" &&
        normalizeRole(c.role) === role &&
        labelMatches(learned, c.label),
    );
    if (matches.length !== 1) return undefined;
    const {
      frame_id: _frameId,
      x: _x,
      y: _y,
      ...rest
    } = action as unknown as Record<string, unknown>;
    return {
      action: { ...rest, x: matches[0].x, y: matches[0].y, frame_id: frame.id },
      frame,
      epoch,
      handsOn,
    };
  }
  /**
   * Recover from a controller failure at any call site. Returns false when the
   * error is not a recoverable native condition and must fail the run.
   */
  private async recoverNative(error: unknown, epoch: number, action?: Action) {
    if (error instanceof SurfaceBlockedError) {
      // The helper refused before sending input; hand control to the user.
      this.takeover(error.message, "surface");
      return true;
    }
    if (this.recoverStateChange(error, action)) return true;
    if (error instanceof TargetError) {
      this.event("ActionFailed", { code: error.code });
      if (error.code === "TARGET_PROTECTED") {
        // As a protected surface in front: the helper refused before input.
        this.takeover(error.message, "surface");
        return true;
      }
      if (error.code === "TARGET_GONE") {
        if (this.boundTarget()) this.targetGone(error.code);
        else this.pause(bound(error.message, 300));
        return true;
      }
      this.reject({
        type: action?.type ?? "rejected",
        ...(action ? { action: echoAction(action) } : {}),
        result: noInput(bound(error.message, 300)),
      });
      this.countInvalid();
      return true;
    }
    if (error instanceof NativeActionError) {
      this.event("ActionFailed", { code: error.code });
      this.reject({
        type: action?.type ?? "rejected",
        ...(action ? { action: echoAction(action) } : {}),
        result: noInput(bound(error.message, 300)),
      });
      this.countInvalid();
      return true;
    }
    if (error instanceof NativeStoppedError) {
      // The latch is usually set by a takeover or voice event still in flight.
      const until = Date.now() + 500;
      while (
        Date.now() < until &&
        this.active() &&
        !this.held &&
        epoch === this.epoch
      )
        await new Promise((r) => setTimeout(r, 25));
      if (this.active() && !this.held && epoch === this.epoch)
        this.pause("Input was interrupted. Say continue when ready.");
      return true;
    }
    if (error instanceof HelperUnavailableError) {
      this.pause("Desktop control restarted. Say continue to resume.");
      return true;
    }
    return false;
  }
  private memoryRun = false;
  private resetMemory() {
    this.memoryContext = undefined;
    this.plan = undefined;
    this.planIndex = 0;
    this.planPending = undefined;
    this.planChecked = 0;
    this.planResult = undefined;
    this.lastOpened = false;
    this.lastSurface = undefined;
    this.handsOn = false;
    this.attempted = 0;
    this.trajectory = [];
    this.appsSeen = new Set();
    this.prelude = undefined;
    this.toolList = undefined;
    this.toolNow = undefined;
    this.toolFallback = undefined;
    this.target = undefined;
    this.rungMisses.clear();
    this.coveredStaleRefusals = 0;
    this.backgroundObservations = [];
    this.foregroundSteps = [];
    this.backgroundKnowledge = undefined;
    this.routesNoted.clear();
    this.inFront = false;
  }
  /**
   * Awaits work for at most `ms`, cancelled with the run: a late answer, an
   * abort or a throw all come back as undefined and the run goes on without.
   */
  private async within<T>(
    ms: number,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<{ value?: T; timedOut: boolean }> {
    const outer = this.abort.signal;
    const limit = new AbortController();
    const onAbort = () => limit.abort();
    outer.addEventListener("abort", onAbort, { once: true });
    if (outer.aborted) limit.abort();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      limit.abort();
    }, ms);
    let value: T | undefined;
    try {
      const pending = Promise.resolve().then(() => work(limit.signal));
      pending.catch(() => {});
      value = await Promise.race([
        pending,
        new Promise<undefined>((resolve) => {
          limit.signal.addEventListener("abort", () => resolve(undefined), {
            once: true,
          });
          if (limit.signal.aborted) resolve(undefined);
        }),
      ]);
    } catch {
      value = undefined;
    } finally {
      clearTimeout(timer);
      outer.removeEventListener("abort", onAbort);
      limit.abort();
    }
    return { value, timedOut };
  }
  /**
   * Recall task-relevant memory once, capped at two seconds and cancelled with
   * the run. Any failure leaves the run without memory.
   */
  private async recall(task: string) {
    const memory = this.memory;
    if (!memory) return;
    const amendments = this.amendments;
    const { value: recall } = await this.within<Recall>(
      recallBudgetMs,
      (signal) => memory.recall(task, signal),
    );
    if (!this.active() || !recall || typeof recall !== "object") return;
    const context = recall.context;
    if (!context || typeof context !== "object") return;
    this.memoryContext = { ...context };
    // For the runner alone: which routes to skip in a bound application.
    if (recall.background && typeof recall.background === "object")
      this.backgroundKnowledge = recall.background;
    const plan = recall.plan;
    if (
      plan &&
      plan.mode === "replay" &&
      Array.isArray(plan.steps) &&
      plan.steps.length > 0
    ) {
      this.plan = {
        ...plan,
        outline: Array.isArray(plan.outline) ? plan.outline : [],
      };
      this.planResult = {
        id: String(plan.id),
        source: plan.source,
        completedSteps: 0,
        abandoned: false,
      };
      // Its first step already ran as the prelude: never open the app twice
      // (the frontmost refusal would abandon the plan).
      if (this.preludeOpens(this.plan)) {
        this.planIndex = 1;
        this.planResult.completedSteps = 1;
      }
    }
    const count = (v: unknown) => (Array.isArray(v) ? v.length : 0);
    this.event("MemoryRecalled", {
      preferences: count(context.preferences),
      episodes: count(context.episodes),
      apps: count(context.apps),
      files: count(context.files),
      plan: plan?.source ?? "none",
      mode: plan?.mode ?? "none",
    });
    // The task was amended while recall ran; its plan matched the old wording.
    if (this.amendments !== amendments) this.dropAmendedPlan();
  }
  /**
   * The tools this run may call, listed once before the first proposal and
   * frozen for the run: at most a second, cancelled with the run, and any
   * failure or a late answer leaves the run with no tools (the screen path).
   */
  private async listTools(tools: ToolAccess, task: string) {
    const { value: list, timedOut } = await this.within<ToolList>(
      TOOL_LIMITS.listBudgetMs,
      (signal) => tools.list(task, signal),
    );
    if (!this.active()) return;
    const listed = Array.isArray(list?.tools)
      ? list.tools.slice(0, TOOL_LIMITS.list)
      : [];
    const unavailable = Array.isArray(list?.unavailable)
      ? list.unavailable.slice(0, TOOL_LIMITS.unavailable)
      : [];
    this.toolList = { tools: listed, unavailable };
    this.toolNow = clockLine(tools.clock());
    this.event("ToolsListed", {
      toolCount: listed.length,
      unavailableCount: unavailable.length,
      ...(timedOut && !list ? { code: "timeout" } : {}),
    });
  }
  /** What the model reads about the tools: one line each, and the clock they run on. */
  private toolObservation(
    tools: ToolAccess,
    list: ToolList,
  ): NonNullable<Observation["tools"]> {
    return {
      now: this.toolNow ?? clockLine(tools.clock()),
      list: list.tools.map(({ id, title, does, params }) => ({
        id,
        title,
        does,
        params,
      })),
      unavailable: list.unavailable,
    };
  }
  /**
   * What policy needs for a tool_call: the frozen spec of the tool it names,
   * the tool layer's validation of the arguments, the calls so far and the
   * clock. Empty when the tool is not in this run's list (policy retries).
   */
  private toolContext(action: Extract<Action, { type: "tool_call" }>): {
    tool?: { spec: ToolSpec; prepared: ToolPrepared; calls: number };
    clock?: ToolClock;
  } {
    const tools = this.extras.tools;
    const spec = this.toolList?.tools.find((t) => t.id === action.tool);
    if (!tools || !spec) return {};
    return {
      tool: {
        spec,
        prepared: tools.prepare(spec, action.args),
        calls: this.snapshot.run!.tools?.calls ?? 0,
      },
      clock: tools.clock(),
    };
  }
  /** The run's objective when it is the user's own words; grounding reads nothing else. */
  private userWords(run: Run): string | undefined {
    return run.taskSource === "user_words" && run.origin !== "watch"
      ? run.task
      : undefined;
  }
  /**
   * A tool step, runner-side beside monitor: never sent to the controller.
   * The tool layer runs the call against the run's abort signal and returns
   * one bounded outcome; the run records it as an executed step, and a
   * verified builtin write asked to finish ends the run with a line built
   * from the store's own values. A long-running call is waited for like a
   * watch: its time past LONG_CALL_FREE_MS is excluded from maxSeconds.
   */
  private async toolCall(
    action: Extract<Action, { type: "tool_call" }>,
    spec: ToolSpec,
    frame: Frame,
    decision: Decision,
    epoch: number,
  ): Promise<"completed" | "continue" | "stopped"> {
    const run = this.snapshot.run!;
    const tools = this.extras.tools!;
    const title = bound(spec.title, 40);
    this.event("PolicyAllowed", {
      reason: decision.reason,
      actionType: action.type,
    });
    this.status(
      "executing",
      spec.longRunning ? `Waiting for ${title}.` : `Using ${title}.`,
    );
    const { frame_id: _frameId, ...executedAction } = action;
    const shown = { type: action.type, tool: action.tool, args: action.args };
    // Counted before the call: an interrupted call may still have acted.
    this.attempted++;
    const started = Date.now();
    // A long call holds the budget clock while it runs, as an approval does,
    // so the runtime timer cannot end the run under it; its first
    // LONG_CALL_FREE_MS are counted back once it returns.
    if (spec.longRunning) this.markHeld();
    let outcome: ToolOutcome;
    try {
      outcome = await tools.call(spec, action.args, this.abort.signal);
    } catch {
      // The tool layer promises not to throw; a broken one reads as away.
      outcome = {
        code: "unavailable",
        text: TOOL_RESULT_TEXT.unavailable.replace("{title}", spec.title),
        resultBytes: 0,
        resultItems: 0,
        durationMs: Date.now() - started,
      };
    } finally {
      if (spec.longRunning && !this.held && this.heldSince !== undefined) {
        this.heldMs -= Math.min(Date.now() - started, LONG_CALL_FREE_MS);
        this.markActive();
      }
    }
    if (!this.active()) return "stopped";
    if (this.held || epoch !== this.epoch) {
      if (this.planPending !== undefined) this.abandonPlan("interrupted");
      this.event("ActionInterrupted", { actionType: action.type });
      this.history.push({
        type: action.type,
        action: shown,
        result: TOOL_RESULT_TEXT.interrupted,
      });
      return "continue";
    }
    const ok = outcome.code === "ok";
    run.actions++;
    run.tools = {
      calls: (run.tools?.calls ?? 0) + 1,
      writes: (run.tools?.writes ?? 0) + (ok && spec.tier !== "read" ? 1 : 0),
    };
    if (ok) this.resetCounters();
    this.executed = [...this.executed, action].slice(-HANDOFF_STEPS);
    const fromPlan =
      this.planPending !== undefined ? this.plan?.source : undefined;
    if (this.planPending !== undefined) {
      this.planPending = undefined;
      this.planIndex++;
      if (this.planResult) this.planResult.completedSteps++;
    }
    if (this.memoryRun && this.trajectory.length < 200)
      this.trajectory.push({
        action: executedAction,
        ...(frame.appId ? { appId: frame.appId } : {}),
        tool: {
          id: spec.id,
          tier: spec.tier,
          code: outcome.code,
          dateKeys: spec.dateKeys,
        },
        ...(fromPlan ? { fromPlan } : {}),
      });
    // The arguments go to the encrypted journal as typed text does; the
    // result never enters any event.
    this.event("ActionExecuted", { action, frame_id: frame.id });
    this.event("ToolCallFinished", {
      tool: spec.trace.tool,
      server: spec.trace.server,
      outcome: outcome.code,
      resultBytes: outcome.resultBytes,
      resultItems: outcome.resultItems,
      durationMs: outcome.durationMs,
      verified: outcome.verified === true,
      finish: action.finish,
      longRunning: spec.longRunning,
    });
    const loop = this.trackLoop(action);
    this.trackAppSwitch(action);
    // Two tool steps change nothing on screen: the no-progress check is not
    // armed, or it would call the next screen step a stall.
    this.progress = undefined;
    this.toolFallback = ok ? undefined : spec.title;
    this.history.push({
      type: action.type,
      action: shown,
      result: outcome.text + (loop === "warn" ? loopWarning : ""),
    });
    if (loop === "stuck") {
      this.pause(
        "I seem to be stuck repeating the same steps. Say continue with a hint.",
      );
      return "continue";
    }
    if (action.finish && ok && outcome.verified && outcome.facts) {
      run.summary = redactSecrets(
        toolDoneLine(outcome.facts, tools.clock(), this.userWords(run)),
      );
      this.event("RunCompleted");
      this.status("completed", run.summary);
      return "completed";
    }
    return "continue";
  }
  /**
   * A tool write within its undo window is taken back through its own
   * provider before Edit > Undo is tried; undefined when there is none.
   */
  private async undoTool(tools: ToolAccess): Promise<ToolOutcome | undefined> {
    try {
      const outcome = await tools.undoLast(this.abort.signal);
      if (outcome) this.event("ToolUndo", { outcome: outcome.code });
      return outcome;
    } catch {
      return undefined;
    }
  }
  /** A plan's first step opens the app or folder the prelude already opened. */
  private preludeOpens(plan: ReplayPlan): boolean {
    const opened = this.prelude;
    const first = plan.steps[0]?.action;
    if (!opened || !first) return false;
    if (first.type === "open_file")
      return (
        first.app === undefined &&
        typeof first.path === "string" &&
        opened.paths.has(first.path.replace(/\/+$/, ""))
      );
    if (first.type !== "open_app") return false;
    if (
      typeof first.name === "string" &&
      opened.names.has(normalizeAppName(first.name))
    )
      return true;
    // The built-in "open X" intent names the app as the index lists it and
    // completes on the bundle being frontmost.
    const done = plan.completeWhen?.appId;
    return (
      plan.steps.length === 1 &&
      !!opened.appId &&
      typeof done === "string" &&
      done.toLowerCase() === opened.appId
    );
  }
  /** Turn the next plan step into a proposal for this frame, or explain why not. */
  private planProposal(
    frame: Frame,
  ): { action: Record<string, unknown> } | { reason: string } {
    const step = this.plan?.steps[this.planIndex];
    if (!step?.action || typeof step.action !== "object")
      return { reason: "invalid_step" };
    const type = step.action.type;
    if (typeof type !== "string" || unplannable.has(type))
      return { reason: "invalid_step" };
    if (step.expectAppId && step.expectAppId !== frame.appId)
      return { reason: "app_mismatch" };
    // A learned tool step needs its tool in this run's frozen list.
    if (
      type === "tool_call" &&
      !this.toolList?.tools.some((t) => t.id === step.action.tool)
    )
      return { reason: "tool_missing" };
    // Learned coordinates are never replayed; pointer steps resolve by label.
    const { frame_id: _frameId, x: _x, y: _y, ...rest } = step.action;
    const action: Record<string, unknown> = { ...rest };
    if (pointerTypes.has(type)) {
      const role = normalizeRole(step.target?.role ?? "");
      const learned = step.target?.label ?? "";
      if (!role || !normalizeLabel(learned))
        return { reason: "missing_control" };
      // Native control names are cut at CONTROL_LABEL_LIMIT; labelMatches
      // accepts a cut live label that the learned label starts with.
      const matches = (frame.context?.controls ?? []).filter(
        (c) =>
          c.enabled !== false &&
          typeof c.label === "string" &&
          typeof c.role === "string" &&
          normalizeRole(c.role) === role &&
          labelMatches(learned, c.label),
      );
      if (matches.length !== 1)
        return {
          reason: matches.length ? "ambiguous_control" : "missing_control",
        };
      action.x = matches[0].x;
      action.y = matches[0].y;
    }
    return { action: { ...action, frame_id: frame.id } };
  }
  private planHint(plan: ReplayPlan, note: string, from = 0) {
    const steps =
      plan.outline.length === plan.steps.length
        ? plan.outline.slice(from)
        : plan.outline;
    this.memoryContext = {
      ...(this.memoryContext ?? { preferences: [], episodes: [] }),
      plan: { source: plan.source, note, steps: steps.slice(0, 12) },
    };
  }
  /** Stop replaying for the rest of this run; the outline stays as a hint. */
  private abandonPlan(reason: string) {
    const plan = this.plan;
    if (!plan) return;
    const index = this.planPending ?? this.planIndex;
    this.plan = undefined;
    this.planPending = undefined;
    if (this.planResult) {
      this.planResult.abandoned = true;
      this.planResult.abandonReason = reason;
    }
    this.event("PlanAbandoned", { index, reason });
    if (index >= plan.steps.length)
      // Held while checking completion: every step already ran.
      this.planHint(plan, planVerifyNote);
    else
      this.planHint(
        plan,
        `Known plan interrupted at step ${index + 1}; continue from the current screen`,
        index,
      );
  }
  /**
   * completeWhen results for this frame; empty when the plan has none. host
   * uses the committed page host from the surface fetched with this frame,
   * never the address-bar edit text.
   */
  private planChecks(plan: ReplayPlan, frame: Frame): boolean[] {
    const when = plan.completeWhen;
    if (!when || typeof when !== "object") return [];
    const checks: boolean[] = [];
    if (when.appId) checks.push(frame.appId === when.appId);
    if (when.host) {
      const surface = this.lastSurface;
      checks.push(
        !!surface &&
          surface.appId === frame.appId &&
          pageHostMatches(surface.domain, when.host),
      );
    }
    if (when.opened) checks.push(this.lastOpened);
    return checks;
  }
  /** Hand the finished run to memory exactly once; never affects the run. */
  private learn(run: Run) {
    const memory = this.memory;
    if (!memory || !this.memoryRun) return;
    this.memoryRun = false;
    try {
      if (this.plan) this.abandonPlan("stopped");
    } catch {
      // Journaling must not prevent learning or settling.
    }
    try {
      const result = memory.learn({
        runId: run.id,
        task: run.task,
        status: run.status,
        synthetic: run.synthetic,
        ...(run.outcome === undefined ? {} : { outcome: run.outcome }),
        summary: run.summary,
        corrections: (run.corrections ?? []).map((c) => c.text),
        steps: this.trajectory,
        appsSeen: [...this.appsSeen],
        tools: run.tools?.calls ?? 0,
        handsOn: this.handsOn,
        ...(this.planResult ? { plan: { ...this.planResult } } : {}),
        usage: { ...run.usage },
        ...(this.backgroundObservations.length
          ? { background: [...this.backgroundObservations] }
          : {}),
      }) as unknown;
      if (result instanceof Promise) result.catch(() => {});
    } catch {
      // Memory is best effort.
    }
  }
  /**
   * A monitor step: the helper binds the frontmost window, the detached watch
   * takes it over through extras.onMonitor, and the run completes so the
   * runner is free for the next task. "completed" ends the loop; "rejected"
   * leaves a history entry and lets the model choose again.
   */
  private async monitor(
    action: Extract<Action, { type: "monitor" }>,
    frame: Frame,
    epoch: number,
  ): Promise<"completed" | "rejected"> {
    const run = this.snapshot.run!;
    const reject = (result: string) => {
      this.history.push({
        type: "monitor",
        action: echoAction(action),
        result,
      });
      return "rejected" as const;
    };
    if (run.synthetic || !this.controller.bindWatch || !this.extras.onMonitor) {
      this.event("ActionFailed", { code: "MONITOR_UNAVAILABLE" });
      return reject(
        "No input was sent. Monitoring isn't available here; use wait, or finish with done.",
      );
    }
    // bindWatch takes the frontmost window, which is the user's, not the
    // bound one: a background run has no window to hand a watch.
    if (this.boundTarget()) {
      this.event("ActionFailed", { code: "MONITOR_UNAVAILABLE" });
      return reject(
        "No input was sent. Watching isn't available while working in the background; use wait, or finish with done.",
      );
    }
    let binding: WatchBinding;
    try {
      binding = await this.controller.bindWatch();
    } catch (error) {
      if (this.held || epoch !== this.epoch) return "rejected";
      if (await this.recoverNative(error, epoch, action)) return "rejected";
      // The helper's own refusals (too many windows watched, no focused
      // window, a window it cannot find on screen) and a slow answer end
      // the step, not the run: the model hears it and finishes another way.
      this.event("ActionFailed", { code: "MONITOR_REFUSED" });
      return reject(
        `No input was sent. The window could not be watched (${bound(error instanceof Error ? error.message : "no answer", 160)}); use wait, or finish with done.`,
      );
    }
    const release = () => {
      void this.controller.unbindWatch?.(binding.token).catch(() => {});
    };
    if (this.held || epoch !== this.epoch) {
      release();
      return "rejected";
    }
    // The watch must hold the window the model looked at, not one that came
    // to the front since the screenshot.
    if (frame.appId && binding.appId !== frame.appId) {
      release();
      this.event("ActionFailed", {
        code: "STATE_CHANGED",
        change: "APP_CHANGED",
      });
      return reject(
        "No input was sent. Another application came to the front before the watch could start; look at the new screenshot and monitor again.",
      );
    }
    const spec = watchSpec(action);
    const appName = frame.context?.appName?.trim() || undefined;
    // The watch may refuse the window (it has woken the model too often in
    // the last hour): the binding is released and the model hears why, in
    // the watch's own words; any other failure gets a fixed line.
    try {
      this.extras.onMonitor(binding, spec, {
        id: run.id,
        task: run.task,
        ...(run.taskSource ? { taskSource: run.taskSource } : {}),
        ...(run.origin ? { origin: run.origin } : {}),
        ...(appName ? { appName } : {}),
        steps: [...this.executed],
        corrections: (run.corrections ?? []).map((c) => c.text),
        ...(this.watchChain ? { chain: { ...this.watchChain } } : {}),
      });
    } catch (error) {
      release();
      this.event("ActionFailed", { code: "MONITOR_REFUSED" });
      const refused =
        error instanceof Error &&
        (error as { code?: unknown }).code === "MONITOR_REFUSED";
      return reject(
        `No input was sent. ${refused ? bound(error.message, 300) : "The watch refused this window; use wait, or finish with done."}`,
      );
    }
    run.actions++;
    this.event("MonitorStarted", {
      appId: binding.appId,
      mode: spec.until,
      delayMs: spec.everyMs,
      durationMs: spec.maxMs,
    });
    this.event("ActionExecuted", { action, frame_id: frame.id });
    const what = appName ?? "it";
    run.summary =
      spec.until === "change"
        ? `Keeping an eye on ${what}. I’ll let you know when it changes.`
        : spec.until === "input"
          ? `Keeping an eye on ${what}. I’ll let you know when it needs you.`
          : `Keeping an eye on ${what}. I’ll let you know when it’s done.`;
    this.event("RunCompleted");
    this.status("completed", run.summary);
    return "completed";
  }
  private async capture() {
    this.lastSurface = undefined;
    const surface = await this.surfaceNow();
    this.lastSurface = surface;
    const decision = surfacePolicy(surface, this.settings);
    if (decision.kind !== "ALLOW") {
      this.takeover(decision.reason, "surface");
      return null;
    }
    const target = this.boundTarget();
    const frame = target
      ? await this.controller.captureTarget!(target.token)
      : await this.controller.capture();
    return this.recordFrame(frame);
  }
  /** The surface of the bound window while the run works there, else the screen's. */
  private surfaceNow(action?: Action) {
    const target = this.boundTarget();
    return target
      ? this.controller.surfaceTarget!(target.token, action)
      : this.controller.surface(action);
  }
  /**
   * The model's copy of a frame: the watch context of a wake-up run and, for
   * a bound run, the window's background facts (the instruction that explains
   * them is the provider's, src/providers/http.ts). Only this copy carries
   * them; snapshots, traces and saved frames do not.
   */
  private modelFrame(frame: Frame): Frame {
    const target = this.boundTarget();
    if (!frame.context || (!this.watchContext && !target)) return frame;
    return {
      ...frame,
      context: {
        ...frame.context,
        ...(this.watchContext && { watch: this.watchContext }),
        ...(target && {
          background: {
            appName: target.appName,
            title: frame.context.windowTitle,
            covered: false,
            staleRisk: false,
            minimized: false,
            ...frame.context.background,
          },
        }),
      },
    };
  }
  /**
   * Binds the window a background run works in (design §2.2), trying in
   * order the windows the words name, the application the prelude opened, and
   * the window focused when the wake word ended (for a run the user started
   * at the Mac). A name that is not an application is skipped; an application
   * the words named that the helper recognized but refused (no window, not
   * running, protected) ends the search, so the run never works in another
   * window than the one asked for: it takes the screen, saying so for a
   * missing window.
   */
  private async bindTarget(run: Run, prelude?: RunPrelude) {
    const opened =
      prelude?.outcome?.launched?.name ||
      (prelude?.action.type === "open_app" ? prelude.action.name : undefined);
    const atMac = run.origin === "voice" || run.origin === "typed";
    const candidates: {
      spec: TargetSpec;
      by: "words" | "prelude" | "focus";
    }[] = [
      ...spokenTargets(run.task).map((spec) => ({
        spec,
        by: "words" as const,
      })),
      ...(opened ? [{ spec: { app: opened }, by: "prelude" as const }] : []),
      ...(atMac ? [{ spec: {}, by: "focus" as const }] : []),
    ];
    let message: string | undefined;
    for (const { spec, by } of candidates) {
      if (!this.active()) return;
      try {
        const target = await this.controller.bindTarget!(spec);
        // Stopped, or a preparation let go, while the helper bound: release it.
        if (!this.active()) {
          void this.controller.unbindTarget?.(target.token).catch(() => {});
          return;
        }
        this.target = target;
        run.target = { ...target, background: true };
        this.event("TargetBound", {
          appId: target.appId,
          windowId: target.windowId,
          by,
        });
        if (!this.deferring) this.recorder.save(run);
        return;
      } catch (error) {
        if (!(error instanceof TargetError) || by !== "words") continue;
        if (error.code === "TARGET_GONE") message = noWindowInFront(spec.app!);
        break;
      }
    }
    if (message) this.status("capturing", message);
  }
  /**
   * One step to the bound window (design §2.5-§2.8): the rungs the ladder
   * and memory leave, each read back; a miss steps down a rung and is
   * remembered; with the background rungs spent and a foreground route left,
   * the window comes in front for the step. Returns undefined when nothing
   * executed and the run already heard why (a history line or a hand-off).
   */
  private async executeBound(
    target: RunTarget,
    action: Action,
    native: Action,
    surface: Surface,
    frame: Frame,
    epoch: number,
  ): Promise<{ outcome: ExecutionResult | undefined } | undefined> {
    if (action.type === "wait") {
      await this.sleep(action.milliseconds);
      return { outcome: undefined };
    }
    if (action.type === "move") {
      this.history.push({
        type: action.type,
        action: echoAction(action),
        result:
          "No input was sent. There is no cursor to move in a background window; click a listed control or a point directly.",
      });
      return undefined;
    }
    const ladder = backgroundLadder(
      action,
      surface.shortcutLabel,
      (rung, route) => this.skipsRung(target, action, rung, route),
    );
    // A capture: nothing is delivered to the window.
    if (!ladder) return { outcome: undefined };
    if (!ladder.rungs.length) {
      if (ladder.foreground)
        return this.foreground(target, action, native, frame, epoch, "pruned");
      this.history.push({
        type: action.type,
        action: echoAction(action),
        result: `No input was sent. ${target.appName} ignores this route in the background; use another control, the menu or the keyboard.`,
      });
      return undefined;
    }
    let outcome: ExecutionResult;
    try {
      outcome = await this.controller.executeTarget!(
        target.token,
        native,
        frame,
        ladder.rungs,
        this.abort.signal,
      );
    } catch (error) {
      if (
        !(error instanceof TargetError) ||
        !NO_BACKGROUND_ROUTE.has(error.code)
      )
        throw error;
      // A covered window whose picture may be stale refused the point: the
      // listed controls are the truth there, so the model is told to use one
      // before the window is asked for; a repeat, or no control to name, is.
      if (
        error.code === "TARGET_COVERED_STALE" &&
        this.coveredStaleRefusals++ === 0 &&
        frame.context?.controls?.length
      ) {
        this.event("ActionFailed", { code: error.code });
        this.history.push({
          type: action.type,
          action: echoAction(action),
          result: coveredStaleRetry(target.appName),
        });
        return undefined;
      }
      // A thrown RUNG_NO_EFFECT means the helper skipped every rung it had
      // already seen miss twice: nothing was tried, so nothing is recorded.
      if (ladder.foreground)
        return this.foreground(
          target,
          action,
          native,
          frame,
          epoch,
          error.code,
        );
      this.event("ActionFailed", { code: error.code });
      this.history.push({
        type: action.type,
        action: echoAction(action),
        result: noInput(bound(error.message, 300)),
      });
      return undefined;
    }
    this.coveredStaleRefusals = 0;
    // The rung that answered, and every rung before it read as no effect.
    const rung =
      outcome.rung && ladder.rungs.includes(outcome.rung)
        ? outcome.rung
        : ladder.rungs[ladder.rungs.length - 1];
    outcome = { ...outcome, rung, effect: outcome.effect ?? "unverifiable" };
    for (const missed of ladder.rungs.slice(0, ladder.rungs.indexOf(rung)))
      this.recordMiss(target, action, missed, rung);
    if (outcome.effect === "changed") {
      this.observe(target, action, rung, "works");
      return { outcome };
    }
    if (outcome.effect === "unverifiable") return { outcome };
    this.recordMiss(
      target,
      action,
      rung,
      ladder.foreground ? "foreground" : undefined,
    );
    if (!ladder.foreground) return { outcome };
    return this.foreground(target, action, native, frame, epoch, "no_effect");
  }
  /**
   * Whether a rung is skipped for this step: the run saw this application
   * ignore it twice for this kind of step, or memory saw it ignore the
   * rung's route (design §5), which the pill names once per route.
   */
  private skipsRung(
    target: RunTarget,
    action: Action,
    rung: Rung,
    route: BackgroundRoute,
  ) {
    if ((this.rungMisses.get(missKey(action, rung)) ?? 0) >= MISS_LIMIT)
      return true;
    const known = this.backgroundKnowledge?.[target.appId]?.[route];
    if (known !== "noop" && known !== "echo") return false;
    if (!this.routesNoted.has(route)) {
      this.routesNoted.add(route);
      this.event("BackgroundRouteSkipped", { route });
      this.status("executing", routeSkipped(target.appName, route));
    }
    return true;
  }
  private recordMiss(target: RunTarget, action: Action, rung: Rung, to?: Rung) {
    const key = missKey(action, rung);
    this.rungMisses.set(key, (this.rungMisses.get(key) ?? 0) + 1);
    this.observe(target, action, rung, "noop");
    if (to)
      this.event("RungStepped", { from: rung, to, actionType: action.type });
  }
  private observe(
    target: RunTarget,
    action: Action,
    rung: Rung,
    verdict: BackgroundObservation["verdict"],
  ) {
    if (this.backgroundObservations.length >= 40) return;
    this.backgroundObservations.push({
      appId: target.appId,
      appName: target.appName,
      route: backgroundRoute(action, rung),
      verdict,
    });
  }
  /**
   * Rung 3 (design §2.8): "I need Slack for a second"; the helper remembers
   * the user's application and activates the bound one; the step then goes
   * the way every step went before: a fresh capture of the screen, the
   * point re-aimed from the window image to the display, today's execute on
   * the HID tap behind the frontmost floors. The user's input anywhere
   * pauses the run meanwhile. The second always ends: whatever way this
   * returns, the helper gives the user's application back and closes the
   * handoff, except past three detours in ten steps, when the run says so,
   * releases the window and finishes in front.
   */
  private async foreground(
    target: RunTarget,
    action: Action,
    native: Action,
    frame: Frame,
    epoch: number,
    reason: string,
  ): Promise<{ outcome: ExecutionResult } | undefined> {
    const run = this.snapshot.run!;
    this.foregroundSteps.push(run.actions);
    const capped = foregroundCapReached(this.foregroundSteps, run.actions);
    this.event("ForegroundRequested", {
      reason,
      actionType: action.type,
      ...(capped ? { final: true } : {}),
    });
    this.status(
      "executing",
      capped
        ? finishInFront(target.appName)
        : foregroundRequest(target.appName),
    );
    this.inFront = true;
    let staysInFront = false;
    try {
      const { frontmost } = await this.controller.foregroundTarget!(
        target.token,
      );
      if (this.held || epoch !== this.epoch) return undefined;
      if (!frontmost) {
        this.takeover(foregroundHandoff(target.appName), "handoff");
        return undefined;
      }
      const screen = this.recordFrame(await this.controller.capture());
      if (!screen || this.held || epoch !== this.epoch) return undefined;
      // The second is the target's alone: input never goes to whatever else
      // came in front meanwhile.
      if ((screen.appId ?? "").toLowerCase() !== target.appId.toLowerCase()) {
        this.takeover(foregroundHandoff(target.appName), "handoff");
        return undefined;
      }
      const outcome = await this.controller.execute(
        aimAtDisplay(
          { ...native, frame_id: screen.id },
          frame.geometry.window,
          screen.geometry,
        ),
        screen,
        this.abort.signal,
      );
      if (capped && this.active() && !this.held && epoch === this.epoch) {
        this.leaveBackground("cap");
        staysInFront = true;
      }
      return {
        outcome: {
          ...(outcome ?? {}),
          rung: "foreground",
          effect: outcome?.effect ?? "unverifiable",
        },
      };
    } finally {
      this.inFront = false;
      await this.endHandoff(target, staysInFront);
    }
  }
  /**
   * Closes the announced second whichever way it ended (design §2.8 step 4):
   * the helper gives the user's application back and its handoff flag
   * clears, so the tap scopes the user's input to the window again. A run
   * that now finishes in front releases the window instead: nothing is
   * restored, and the helper stops tracking it. Neither failure can mask
   * the step's own result.
   */
  private async endHandoff(target: RunTarget, staysInFront: boolean) {
    try {
      if (staysInFront) await this.controller.unbindTarget?.(target.token);
      else await this.controller.restoreRemembered?.();
    } catch {
      // The helper is gone or busy: the next call reports it in its own right.
    }
  }
  private recordFrame(frame: Frame) {
    this.check();
    if (this.held) return null;
    if (frame.context) frame.context.recentTasks = this.recentTasks;
    if (frame.appId && this.appsSeen.size < 50) this.appsSeen.add(frame.appId);
    this.snapshot.frame = frame;
    this.snapshot.run!.frames++;
    // The PNG is the frame of record; the model's reduced rendition is not kept.
    const { preview: _preview, ...stored } = frame;
    this.recorder.frame(this.snapshot.run!.id, stored);
    this.event("FrameCaptured", {
      frame_id: frame.id,
      sha256: frame.sha256,
      geometry: frame.geometry,
      ...(frame.timings && { timings: frame.timings }),
    });
    return frame;
  }
  /**
   * Journals a step taken before this run existed as the run's first frame
   * and step, exactly as the loop records an executed open_app or open_file:
   * the model's history starts with its result, so it is never taken again.
   */
  private applyPrelude(p: RunPrelude) {
    const frame = this.recordFrame(p.frame);
    if (!frame) return;
    this.event("ActionProposed", { action: p.action, early: true });
    this.event("PolicyAllowed", { reason: p.reason });
    this.attempted++;
    this.recordExecuted(p.action, frame, frame, p.surface, p.outcome, {
      early: true,
    });
    const names = new Set<string>();
    const paths = new Set<string>();
    let appId: unknown, display: string;
    if (p.action.type === "open_app") {
      const launched = p.outcome?.launched;
      names.add(normalizeAppName(p.action.name));
      if (typeof launched?.name === "string" && launched.name)
        names.add(normalizeAppName(launched.name));
      appId = launched?.appId;
      display = String(launched?.name || p.action.name);
    } else {
      // The folder opened in Finder: its path as asked and as opened.
      const opened = p.outcome?.opened;
      const path = p.action.path.replace(/\/+$/, "");
      paths.add(path);
      if (typeof opened?.path === "string" && opened.path)
        paths.add(opened.path.replace(/\/+$/, ""));
      appId = opened?.appId;
      display = path.split("/").pop() || path;
    }
    this.prelude = {
      appId:
        typeof appId === "string" && appId ? appId.toLowerCase() : undefined,
      names,
      paths,
      display: bound(display, 100),
      completes: p.completes,
    };
  }
  /**
   * The bookkeeping after an executed step, shared by the loop and by a step
   * taken before the run existed (a prelude): counters, the plan position,
   * what memory learns, the journal entry and the history line the model
   * reads next.
   */
  private recordExecuted(
    action: Action,
    frame: Frame,
    executionFrame: Frame,
    actionSurface: Surface,
    outcome: void | ExecutionResult,
    o: { early?: boolean; reaimed?: boolean } = {},
  ) {
    const run = this.snapshot.run!;
    const { frame_id: _frameId, ...executedAction } = action;
    this.resetCounters();
    run.actions++;
    this.executed = [...this.executed, action].slice(-HANDOFF_STEPS);
    this.lastStep = {
      type: action.type,
      confirmed: actionConfirmed(action, actionSurface, outcome),
    };
    const launched =
      action.type === "open_app" &&
      outcome &&
      outcome.launched &&
      typeof outcome.launched.appId === "string"
        ? {
            appId: bound(outcome.launched.appId, 200),
            name: bound(String(outcome.launched.name || action.name), 120),
            frontmost: outcome.launched.frontmost === true,
            wasRunning: outcome.launched.wasRunning === true,
            ...(typeof outcome.launched.windows === "number" && {
              windows: outcome.launched.windows,
              restoredWindow: outcome.launched.restoredWindow === true,
            }),
          }
        : undefined;
    // Set by an open_app that left its app windowless, cleared by any
    // other executed step.
    this.windowlessApp =
      launched?.frontmost && launched.windows === 0 && !launched.restoredWindow
        ? { appId: launched.appId.toLowerCase(), name: launched.name }
        : undefined;
    const opened =
      action.type === "open_file" &&
      outcome &&
      outcome.opened &&
      typeof outcome.opened.path === "string"
        ? {
            path: bound(outcome.opened.path, 500),
            kind:
              outcome.opened.kind === "folder"
                ? ("folder" as const)
                : ("document" as const),
            ...(typeof outcome.opened.appId === "string" && outcome.opened.appId
              ? { appId: bound(outcome.opened.appId, 200) }
              : {}),
          }
        : undefined;
    if (action.type === "open_file") this.lastOpened = !!opened;
    const via =
      action.type === "hotkey" &&
      outcome &&
      (outcome.via === "menu" || outcome.via === "keys")
        ? outcome.via
        : undefined;
    // Read before planPending is cleared: this step came from the plan.
    const fromPlan =
      this.planPending !== undefined ? this.plan?.source : undefined;
    if (this.planPending !== undefined) {
      this.planPending = undefined;
      this.planIndex++;
      if (this.planResult) this.planResult.completedSteps++;
    }
    if (this.memoryRun && this.trajectory.length < 200) {
      const target = surfaceTarget(action, actionSurface);
      this.trajectory.push({
        action: executedAction,
        ...(frame.appId ? { appId: frame.appId } : {}),
        ...(target ? { target } : {}),
        ...(launched ? { launchedAppId: launched.appId } : {}),
        ...(opened ? { openedPath: opened.path } : {}),
        ...(fromPlan ? { fromPlan } : {}),
      });
    }
    if (launched && this.appsSeen.size < 50) this.appsSeen.add(launched.appId);
    this.event("ActionExecuted", {
      action,
      frame_id: executionFrame.id,
      // Taken before this run existed, while the user was still speaking.
      ...(o.early ? { early: true } : {}),
      // Whether a hotkey was pressed as its menu item or posted as keys.
      ...(via ? { via } : {}),
      // The rung that reached a bound window and what its postcondition read found.
      ...(outcome?.rung
        ? {
            rung: outcome.rung,
            ...(outcome.effect && { effect: outcome.effect }),
          }
        : {}),
      ...(opened ? { opened: { kind: opened.kind } } : {}),
      ...(launched
        ? {
            launched: {
              appId: launched.appId,
              frontmost: launched.frontmost,
              wasRunning: launched.wasRunning,
              ...(launched.windows !== undefined && {
                windows: launched.windows,
                restoredWindow: launched.restoredWindow,
              }),
            },
          }
        : {}),
    });
    const loop = this.trackLoop(action, {
      role: actionSurface.targetRole,
      label: actionSurface.targetLabel,
    });
    const thrashing = this.trackAppSwitch(action, launched?.appId);
    // Compared against the next capture; no extra native call is made.
    this.progress = {
      type: action.type,
      probe: progressProbe(executionFrame, this.lastSurface),
    };
    this.history.push({
      type: action.type,
      action: executedAction,
      result:
        (launched
          ? launched.frontmost
            ? launched.windows === 0 && !launched.restoredWindow
              ? windowlessResult(launched.name)
              : `Opened ${launched.name} (${launched.appId}); frontmost=true. Verify appId on the next screenshot; if no window is visible use the app's New shortcut.`
            : `Launch requested for ${launched.appId}; not frontmost yet. Wait briefly before retrying.`
          : opened
            ? `Opened ${opened.path} (${opened.kind})${opened.appId ? ` in ${opened.appId}` : ""}. Verify the next screenshot.`
            : outcome?.rung
              ? backgroundResult(
                  action,
                  executedTarget(action, actionSurface, via),
                  outcome,
                  this.target?.appName || "the application",
                )
              : ["type_text", "key", "hotkey"].includes(action.type)
                ? `Executed${executedTarget(action, actionSurface, via)}. Verify the next screenshot shows the intended result before done.`
                : `Executed${executedTarget(action, actionSurface)}. Verify the next screenshot.`) +
        (o.reaimed ? reaimNote : "") +
        (loop === "warn" ? loopWarning : "") +
        (thrashing ? appSwitchWarning : ""),
    });
    if (loop === "stuck")
      this.pause(
        "I seem to be stuck repeating the same steps. Say continue with a hint.",
      );
  }
  /** The state every run (and every preparation) begins from. */
  private resetState(undo?: boolean) {
    this.undoRequest = undo ? { own: true } : undefined;
    this.executed = [];
    this.started = Date.now();
    this.heldMs = 0;
    this.heldSince = undefined;
    this.abort = new AbortController();
    this.held = false;
    this.voiceApproval = false;
    this.history = [];
    this.refused = undefined;
    this.resetCounters();
    this.resetLoop();
    this.resetMemory();
  }
  private newRun(task: string, options: StartOptions): Run {
    return {
      id: crypto.randomUUID(),
      task,
      createdAt: new Date().toISOString(),
      status: "capturing",
      privacy: this.settings.privacy,
      provider:
        this.controller.kind === "tutorial"
          ? "tutorial"
          : this.settings.provider,
      model:
        this.controller.kind === "tutorial"
          ? "Scripted tutorial"
          : this.settings.model,
      synthetic: this.controller.kind === "tutorial",
      actions: 0,
      frames: 0,
      usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
      summary: "",
      origin: options.origin ?? "typed",
      ...(options.taskSource ? { taskSource: options.taskSource } : {}),
    };
  }
  /**
   * Whether this run recalls and learns. A wake-up run does neither: its
   * objective is a follow-up that quotes the watched request, and a plan
   * recalled for that request would replay its steps with nobody at the Mac.
   * An undo run's one step is fixed, so there is nothing to recall or learn
   * for it either.
   */
  private usesMemory(run: Run, options: StartOptions): boolean {
    return (
      !!this.memory &&
      !run.synthetic &&
      run.origin !== "watch" &&
      !options.undo &&
      this.controller.kind !== "tutorial" &&
      this.settings.memory !== false
    );
  }
  /**
   * The tool layer for a run: a dictation types, an undo takes back and a
   * practice run drives a simulated screen, so none of them lists tools.
   */
  private toolsFor(run: Run, options: StartOptions): ToolAccess | undefined {
    return run.synthetic || options.dictation !== undefined || options.undo
      ? undefined
      : this.extras.tools;
  }
  /**
   * Prepares a run's first step before its words are final (PreparedStep):
   * the memory recall, the tool list, the first capture and, when that step
   * needs one, the model's first request for `task`, made exactly as start()
   * would make them and held with every effect. No run is begun, saved or
   * shown, nothing is journaled, no input is sent, and the helper's stop
   * latch is lifted for the capture alone and closed again right after it.
   * The step is adopted by start(task, { prepared }) or let go by discard();
   * a preparation nobody adopts by the next start() is let go then. One at a
   * time, and never while a run is active.
   */
  prepare(task: string, options: PrepareOptions = {}): PreparedStep {
    if (this.active() || this.preparation)
      throw new Error("A run is already active.");
    this.watchContext = undefined;
    this.watchChain = undefined;
    this.resetState(options.undo);
    const run = this.newRun(task, options);
    this.snapshot = {
      run,
      frame: null,
      events: [],
      message: "Starting a private run.",
    };
    let finish!: () => void;
    const p: Preparation = {
      task,
      run,
      abort: this.abort,
      startedAt: Date.now(),
      deferred: [],
      kind: "frame",
      ready: new Promise<void>((resolve) => (finish = resolve)),
    };
    p.handle = {
      task,
      get kind() {
        return p.kind;
      },
      get ready() {
        return p.ready;
      },
      get code() {
        return p.code;
      },
      get usage() {
        return p.usage;
      },
      discard: (code) => this.endPreparation(p, code),
    };
    this.preparation = p;
    this.deferring = p.deferred;
    void this.prepareStep(p, options)
      .catch(() => this.failPreparation(p, "native_error"))
      .finally(finish);
    return p.handle;
  }
  private async prepareStep(p: Preparation, options: PrepareOptions) {
    const { run, task } = p;
    const live = () => this.preparation === p && !p.code && this.active();
    this.memoryRun = this.usesMemory(run, options);
    const tools = this.toolsFor(run, options);
    if (
      options.background &&
      this.settings.workInBackground &&
      !run.synthetic &&
      this.controller.bindTarget
    )
      await this.bindTarget(run);
    if (!live()) return;
    const recalled = this.memoryRun ? this.recall(task) : undefined;
    const listed = tools ? this.listTools(tools, task) : undefined;
    // The read-only capture, as capture() takes it: never while a protected,
    // terminal or secure input surface is in front, which simply ends the
    // preparation (the run, if one starts, will say so itself).
    let frame: Frame;
    try {
      const surface = await this.surfaceNow();
      if (!live()) return;
      this.lastSurface = surface;
      if (surfacePolicy(surface, this.settings).kind !== "ALLOW")
        return this.failPreparation(p, "surface");
      const target = this.boundTarget();
      await this.controller.resume();
      try {
        frame = target
          ? await this.controller.captureTarget!(target.token)
          : await this.controller.capture();
      } finally {
        this.controller.stop();
      }
    } catch {
      return this.failPreparation(
        p,
        p.abort.signal.aborted ? (p.code ?? "discarded") : "native_error",
      );
    }
    if (!live()) return;
    if (frame.context) frame.context.recentTasks = this.recentTasks;
    p.frame = frame;
    p.capturedAt = Date.now();
    await recalled;
    await listed;
    if (!live()) return;
    p.deferred.push({ frame });
    // Whether the first step asks the model at all: a recalled plan, a
    // dictation into a focused field, a tool step on the frozen list and an
    // undo all propose on the frame themselves (the loop's own order).
    const proposesItself =
      !!this.plan ||
      !!options.undo ||
      (!!options.toolStep &&
        !!this.toolList?.tools.some((t) => t.id === options.toolStep!.tool)) ||
      (options.dictation !== undefined && focusedTextField(this.lastSurface!));
    if (proposesItself) return;
    const screenshot = screenshotUse({
      mode: this.settings.visionMode,
      frame,
      surface: this.lastSurface,
      shown: this.shown,
      sinceImage: this.sinceImage,
      executed: this.lastStep,
    });
    this.event("ModelRequestStarted", {
      screenshot: screenshot.send,
      screenshotReason: screenshot.reason,
      early: true,
    });
    p.screenshot = screenshot;
    p.kind = "model";
    p.proposal = this.provider.next(
      {
        screenshot,
        task,
        frame: this.modelFrame(frame),
        history: modelHistory(this.history),
        ...(this.memoryContext ? { memory: this.memoryContext } : {}),
        ...(tools &&
        this.toolList &&
        (this.toolList.tools.length || this.toolList.unavailable.length)
          ? { tools: this.toolObservation(tools, this.toolList) }
          : {}),
      },
      p.abort.signal,
    );
    p.proposal.then(
      (result) => {
        p.proposedAt = Date.now();
        p.usage = result.usage;
      },
      () => {},
    );
  }
  /**
   * The preparation gave up on its own (a protected surface in front, a
   * native error): its request, if any, is aborted and its code set. It stays
   * this runner's until start() or discard() logs why and clears it.
   */
  private failPreparation(p: Preparation, code: string) {
    if (p.code) return;
    p.code = code;
    p.abort.abort();
    p.proposal?.catch(() => {});
  }
  /**
   * Ends a preparation without a run: the request in flight is aborted, a
   * bound window released, the placeholder run dropped. Idempotent.
   */
  private endPreparation(p: Preparation, code: string) {
    this.failPreparation(p, code);
    if (this.preparation !== p) return;
    this.preparation = undefined;
    this.deferring = undefined;
    const token = p.run.target?.token;
    if (token) void this.controller.unbindTarget?.(token).catch(() => {});
    this.target = undefined;
    this.snapshot = {
      run: null,
      frame: null,
      events: [],
      message: "Ready when you are.",
    };
  }
  /**
   * Whether the prepared step still fits the run about to start: it stood,
   * these are its words, no early step preceded it, its frame is young
   * enough, and the application in front is the one it saw. Awaits a capture
   * still in flight (the run would take one anyway).
   */
  private async adoptable(
    p: Preparation,
    task: string,
    options: StartOptions,
  ): Promise<string | undefined> {
    await p.ready;
    if (p.code) return p.code;
    if (!p.frame || p.capturedAt === undefined) return "native_error";
    if (options.prelude) return "early_step";
    if (taskWords(task) !== taskWords(p.task)) return "text_changed";
    if (Date.now() - p.capturedAt > PREPARED_FRAME_MAX_AGE_MS) return "stale";
    try {
      const surface = await this.surfaceNow();
      if (p.code) return p.code;
      if (surface.appId !== p.frame.appId) return "screen_changed";
      this.lastSurface = surface;
    } catch {
      return "native_error";
    }
    return undefined;
  }
  async start(task: string, options: StartOptions = {}) {
    const preparation = this.preparation;
    if (this.active() && this.snapshot.run !== preparation?.run)
      throw new Error("A run is already active.");
    // A prepared step this start was not given is let go: a start for other
    // words, or a preparation nobody discarded.
    const offered =
      preparation && options.prepared && options.prepared === preparation.handle
        ? preparation
        : undefined;
    if (preparation && !offered) this.endPreparation(preparation, "superseded");
    this.settled = false;
    const rejected = offered
      ? await this.adoptable(offered, task, options)
      : undefined;
    if (offered && rejected) this.endPreparation(offered, rejected);
    const adopting = offered && !rejected ? offered : undefined;
    this.preparation = undefined;
    this.deferring = undefined;
    this.watchContext = options.watch;
    this.watchChain = options.chain;
    if (!adopting) this.resetState(options.undo);
    // The run's clock starts now, not when its step was prepared.
    else this.started = Date.now();
    const run = this.newRun(task, options);
    // The window the preparation bound, if any, is this run's.
    if (adopting?.run.target) run.target = adopting.run.target;
    this.snapshot = {
      run,
      frame: null,
      events: [],
      message: "Starting a private run.",
    };
    this.recorder.begin(run);
    this.event("RunStarted", {
      privacy: run.privacy,
      synthetic: run.synthetic,
      origin: run.origin,
    });
    this.schedule();
    const history = this.history;
    this.memoryRun = this.usesMemory(run, options);
    if (offered && rejected)
      this.event("SpeculationDiscarded", {
        code: rejected,
        kind: offered.kind,
        ...(offered.usage ? { usage: offered.usage } : {}),
      });
    // The prepared step's journal, in its order, then the step itself for
    // the loop's first iteration: its frame stands in for the capture and
    // its proposal, if it has one, for the model call.
    let adopted:
      | {
          frame: Frame;
          proposal?: Promise<ProviderResult>;
          screenshot?: ScreenshotUse;
        }
      | undefined;
    if (adopting) {
      let frame: Frame | null = null;
      for (const entry of adopting.deferred) {
        if ("frame" in entry) frame = this.recordFrame(entry.frame);
        else this.event(entry.type, entry.data);
      }
      const now = Date.now();
      const done =
        adopting.proposedAt ??
        (adopting.kind === "frame" ? adopting.capturedAt : undefined);
      this.event("SpeculationAdopted", {
        kind: adopting.kind,
        leadMs: now - adopting.startedAt,
        savedMs: Math.max(0, Math.min(done ?? now, now) - adopting.startedAt),
        frameAgeMs: now - adopting.capturedAt!,
      });
      if (frame)
        adopted = {
          frame,
          proposal: adopting.proposal,
          screenshot: adopting.screenshot,
        };
    }
    // Abandon a proposed plan step that did not execute.
    const planFail = (reason: string) => {
      if (this.planPending !== undefined) this.abandonPlan(reason);
    };
    const nativeReason = (error: unknown) =>
      error instanceof ScreenChangedError ? "state_changed" : "native_error";
    // At most one automatic re-aim per model-proposed action; see reaim().
    let reaim: Reaim | undefined;
    let reaimed = false;
    // A search route to take on the next step instead of asking the model.
    let routed: string[] | undefined;
    // Dictated text, typed on the first frame or left to the model for good.
    let dictation = options.dictation;
    // A tool step decided before the run, proposed on the first frame or
    // left to the model for good.
    let toolStep = options.toolStep;
    const tools = this.toolsFor(run, options);
    try {
      // An adopted step bound its window, recalled and listed already.
      if (!adopting) {
        if (options.prelude && !run.synthetic)
          this.applyPrelude(options.prelude);
        if (
          options.background &&
          this.settings.workInBackground &&
          !run.synthetic &&
          this.controller.bindTarget
        )
          await this.bindTarget(run, options.prelude);
      }
      // Recall and the tool list overlap the first capture (the helper
      // answers the index off its queue); both are awaited before anything
      // decides on the frame, so a recalled plan, memory and the frozen tool
      // list are in place exactly as if they had come first.
      let recalled =
        this.memoryRun && !adopting ? this.recall(task) : undefined;
      let listed = tools && !adopting ? this.listTools(tools, task) : undefined;
      if (!this.active()) return;
      await this.controller.resume();
      while (this.active()) {
        await this.ready();
        const epoch = this.epoch;
        // The step prepared before the run stands in on the first pass
        // alone; a pause meanwhile aborted its request, and the pass then
        // captures afresh like any other.
        const first =
          adopted && !this.abort.signal.aborted ? adopted : undefined;
        adopted = undefined;
        // A pause, correction, takeover or stop during the re-aim drops it.
        if (reaim && (reaim.epoch !== epoch || reaim.handsOn !== this.handsOn))
          reaim = undefined;
        this.status(
          "capturing",
          reaim
            ? "The screen moved; re-aiming at the same control."
            : "Seeing the selected surface.",
        );
        let frame: Frame | null;
        if (first) frame = first.frame;
        else
          try {
            frame = reaim ? reaim.frame : await this.capture();
          } catch (error) {
            if (this.held || epoch !== this.epoch) continue;
            if (await this.recoverNative(error, epoch)) continue;
            throw error;
          }
        if (!frame || epoch !== this.epoch) continue;
        if (recalled || listed) {
          await recalled;
          await listed;
          recalled = undefined;
          listed = undefined;
          if (!this.active() || epoch !== this.epoch) continue;
        }
        // Advice only, before the model sees this step's history. A re-aim is
        // the same step: it neither ends nor starts a no-progress streak.
        if (!reaim) this.trackProgress(frame);
        // The prepared request rides on the controller it was sent with.
        if (!first) this.abort = new AbortController();
        if (this.planPending !== undefined) this.abandonPlan("interrupted");
        if (this.plan && this.planIndex >= this.plan.steps.length) {
          const plan = this.plan;
          const checks = this.planChecks(plan, frame);
          if (checks.length && checks.every(Boolean)) {
            this.plan = undefined;
            run.summary = planSummary(plan);
            this.event("PlanCompleted", { source: plan.source });
            this.event("RunCompleted");
            this.status("completed", run.summary);
            break;
          }
          if (checks.length && this.planChecked < planRechecks) {
            // A launched app or page can take a moment to come to the front.
            // Recheck with fresh captures only; the model is never asked here.
            this.planChecked++;
            this.status("capturing", "Checking the result.");
            await this.sleep(planRecheckMs);
            continue;
          }
          this.plan = undefined;
          this.planHint(plan, planVerifyNote);
        }
        // The user's words were only the step the prelude took ("Open
        // Slack."): with that app in front the run is done without a model
        // call, as the built-in intent would be. Checked once.
        const opened = this.prelude;
        if (opened?.completes && !reaim) {
          opened.completes = false;
          if (
            !this.plan &&
            !!opened.appId &&
            frame.appId?.toLowerCase() === opened.appId
          ) {
            run.summary = redactSecrets(`Opened ${opened.display}.`);
            this.event("RunCompleted");
            this.status("completed", run.summary);
            break;
          }
        }
        let result: ProviderResult | undefined;
        if (reaim) {
          // The same step at a new position: no model call and no usage.
          result = {
            action: reaim.action,
            usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
          };
          reaim = undefined;
        } else reaimed = false;
        if (this.plan) {
          const proposal = this.planProposal(frame);
          if ("reason" in proposal) this.abandonPlan(proposal.reason);
          else {
            this.planPending = this.planIndex;
            this.event("PlanStepProposed", {
              source: this.plan.source,
              index: this.planIndex,
            });
            if (proposal.action.type === "tool_call")
              this.event("ToolStepProposed", { source: "plan" });
            this.status("thinking", "Following a known step.");
            this.check();
            result = {
              action: proposal.action,
              usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
            };
          }
        }
        // The words were one tool step (src/assistant/tool-answers.ts). With
        // its tool in this run's frozen list the step is proposed on this
        // frame with no model call, and policy, approval and the finish rule
        // apply as to any step; a tool that is not listed leaves the words to
        // the model as they were said.
        if (!result && toolStep) {
          const step = toolStep;
          toolStep = undefined;
          if (this.toolList?.tools.some((t) => t.id === step.tool)) {
            this.event("ToolStepProposed", { source: "fast_path" });
            this.status("thinking", "Using a tool for this.");
            result = {
              action: {
                type: "tool_call",
                tool: step.tool,
                args: step.args,
                finish: true,
                frame_id: frame.id,
              },
              usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
            };
          }
        }
        // The words were only text to type. With a known text field focused
        // the one step is proposed on this frame and, once typed, ends the
        // run; anything else in front (no field, a button, a blind surface)
        // is the model's to work out from the words as they were said.
        let dictated = false;
        if (!result && dictation !== undefined) {
          const text = dictation;
          dictation = undefined;
          if (this.lastSurface && focusedTextField(this.lastSurface)) {
            this.event("DictationStepProposed");
            result = {
              action: { type: "type_text", text, frame_id: frame.id },
              usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
            };
            dictated = true;
          }
        }
        // The one step a spoken undo takes, proposed like a plan step: no
        // model call, while policy and the approval "ask" wants still apply.
        // A tool write inside its undo window is taken back through its own
        // provider first (the bridge deletes what it created); Edit > Undo
        // is for everything else.
        const undo = result ? undefined : this.undoRequest;
        if (undo && this.extras.tools) {
          this.status("thinking", "Taking the last step back.");
          const taken = await this.undoTool(this.extras.tools);
          if (!this.active()) break;
          if (this.held || epoch !== this.epoch) continue;
          if (taken) {
            this.endUndo(
              undo,
              taken.code === "ok"
                ? `Undone: ${toolUndoLine(taken.facts)}`
                : TOOL_UNDO_FAILED_MESSAGE,
            );
            continue;
          }
        }
        if (undo) {
          this.status("thinking", "Taking the last step back.");
          result = {
            action: {
              type: "menu_item",
              frame_id: frame.id,
              path: UNDO_MENU_PATH,
            },
            usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
          };
        }
        if (!result && routed) {
          // The application's own search command, as a normal proposed step.
          result = {
            action: { type: "menu_item", frame_id: frame.id, path: routed },
            usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
          };
          routed = undefined;
        }
        if (!result) {
          this.status("thinking", "Choosing the next action.");
          // The request prepared before the run is this step's, with the
          // screenshot use it was sent with; its ModelRequestStarted was
          // journaled with the rest of the prepared step.
          const prepared = first?.proposal ? first : undefined;
          const screenshot =
            prepared?.screenshot ??
            screenshotUse({
              mode: this.settings.visionMode,
              frame,
              surface: this.lastSurface,
              shown: this.shown,
              sinceImage: this.sinceImage,
              executed: this.lastStep,
            });
          this.lastStep = undefined;
          if (!prepared)
            this.event("ModelRequestStarted", {
              screenshot: screenshot.send,
              screenshotReason: screenshot.reason,
            });
          try {
            result = prepared
              ? await prepared.proposal!
              : await this.provider.next(
                  {
                    screenshot,
                    // run.task, not the start() argument: amendTask may replace it.
                    task:
                      run.task +
                      (run.corrections?.length
                        ? "\nUser corrections, in order. Preserve earlier constraints unless explicitly superseded:\n" +
                          run.corrections.map((c) => c.text).join("\n")
                        : ""),
                    // Why a watch woke this run, and the background note of a
                    // bound one, stay visible on every step, since the model only
                    // sees one screenshot and the last few history entries whole.
                    // Only the model's copy carries them: the panel text never
                    // enters a Snapshot, a trace or a saved frame.
                    frame: this.modelFrame(frame),
                    history: modelHistory(history),
                    ...(this.memoryContext
                      ? { memory: this.memoryContext }
                      : {}),
                    // The frozen tool list and the clock it runs on, on the
                    // model's copy only, like context.watch above.
                    ...(tools &&
                    this.toolList &&
                    (this.toolList.tools.length ||
                      this.toolList.unavailable.length)
                      ? { tools: this.toolObservation(tools, this.toolList) }
                      : {}),
                  },
                  this.abort.signal,
                );
          } catch (e) {
            if (this.held || epoch !== this.epoch) continue;
            if (!(e instanceof ProviderTransientError)) throw e;
            this.event("ProviderUnavailable", {
              attempt: ++this.providerFailures,
            });
            if (this.providerFailures >= 2) {
              this.providerFailures = 0;
              this.pause(
                "I can’t reach the model service right now. Say continue to try again.",
              );
              continue;
            }
            this.status("thinking", "Reconnecting to the model service.");
            await this.sleep(1500);
            continue;
          }
          if (this.held || epoch !== this.epoch) continue;
          this.providerFailures = 0;
          // The model saw this frame, with or without its screenshot.
          this.shown = { sha256: frame.sha256, context: contextDigest(frame) };
          this.sinceImage =
            screenshot.send === "none" ? this.sinceImage + 1 : 0;
          this.check();
          for (const k of ["inputTokens", "outputTokens", "cost"] as const) {
            if (!Number.isFinite(result.usage[k]) || result.usage[k] < 0)
              throw new Error("Invalid usage accounting.");
            run.usage[k] += result.usage[k];
          }
          const cached = result.usage.cachedInputTokens;
          if (cached !== undefined) {
            if (!Number.isFinite(cached) || cached < 0)
              throw new Error("Invalid usage accounting.");
            run.usage.cachedInputTokens =
              (run.usage.cachedInputTokens ?? 0) + cached;
          }
          this.event("ModelResponseReceived", { usage: result.usage });
          this.check();
          if (result.refused) {
            // A refusal is deterministic for this observation; do not retry it.
            this.event("ActionFailed", { code: "REFUSED" });
            this.pause(
              "The model declined this step. Rephrase the request or take over.",
            );
            continue;
          }
          if (result.problem) {
            // The fixed problem rides on the event (the diagnostics write it
            // for this code alone) and the provider's remedy on the line the
            // model reads; the next call is the retry, within countInvalid's
            // budget of four in a row.
            const problem = bound(String(result.problem), 200);
            this.event("ActionFailed", { code: "MALFORMED_RESPONSE", problem });
            history.push({
              type: "rejected",
              result: malformedRejection(problem, result.remedy),
            });
            this.countInvalid();
            continue;
          }
        }
        if (!result) continue;
        const normalized = normalizePixelCoordinates(
          result.action,
          frame.geometry,
        );
        if (normalized.normalized)
          this.event("ActionNormalized", {
            actionType: knownType(normalized.action),
          });
        let action: Action;
        try {
          action = validateAction(normalized.action, frame);
        } catch (error) {
          if (result.repaired) {
            // The provider guessed this object out of surrounding text and
            // the guess is not an action: a malformed reply, with no echo of
            // what was guessed. A clean reply's schema failure stays an
            // INVALID_ACTION with its cause below.
            planFail("invalid_action");
            this.event("ActionFailed", {
              code: "MALFORMED_RESPONSE",
              problem: REPAIRED_INVALID,
            });
            history.push({
              type: "rejected",
              result: malformedRejection(REPAIRED_INVALID, result.remedy),
            });
            this.countInvalid();
            continue;
          }
          const { cause, message } = invalidReason(
            error,
            normalized.action,
            frame,
          );
          planFail("invalid_action");
          this.event("ActionFailed", { code: "INVALID_ACTION", cause });
          history.push({
            type: "rejected",
            action: echoAction(normalized.action),
            result: message,
          });
          this.countInvalid();
          continue;
        }
        // Without the tool layer a tool step has nowhere to go; the model
        // hears it and drives the screen (the monitor precedent).
        if (action.type === "tool_call" && !this.extras.tools) {
          planFail("tool_missing");
          this.event("ActionFailed", { code: "TOOL_UNAVAILABLE" });
          history.push({
            type: action.type,
            action: echoAction(action),
            result: TOOL_REFUSALS.no_hook,
          });
          continue;
        }
        // Never journal sensitive model-proposed text before the policy boundary.
        // A tool call has no screen target: the surface is fetched with no
        // action, so the protected-surface floors still run and its
        // arguments never reach the helper.
        let actionSurface: Surface;
        const boundWindow = this.boundTarget();
        try {
          actionSurface = await this.surfaceNow(
            action.type === "tool_call" ? undefined : action,
          );
        } catch (error) {
          if (this.held || epoch !== this.epoch) {
            planFail("interrupted");
            continue;
          }
          planFail(nativeReason(error));
          if (await this.recoverNative(error, epoch, action)) continue;
          throw error;
        }
        const userWords = this.userWords(run);
        const toolContext =
          action.type === "tool_call" ? this.toolContext(action) : {};
        const evaluated = evaluate(
          action,
          actionSurface,
          this.settings,
          run.synthetic,
          {
            // A wake-up run's objective quotes the watched request: only the
            // user's own corrections to this run can ask it for a paste.
            pasteRequested: pasteRequested(
              run.origin === "watch" ? "" : run.task,
              run.corrections,
              run.taskSource,
            ),
            ...(userWords ? { userWords } : {}),
            ...toolContext,
            // The same rules, on the bound window's surface, plus the one
            // refusal a bound run adds: input goes to that process alone.
            ...(boundWindow
              ? {
                  target: {
                    pid: boundWindow.pid,
                    appName: boundWindow.appName,
                  },
                }
              : {}),
          },
        );
        // Only an ALLOW is replaced: every refusal keeps its own reason.
        const windowless = this.windowlessApp;
        const decision =
          evaluated.kind === "ALLOW" &&
          action.type === "open_app" &&
          windowless !== undefined &&
          actionSurface.launcherAppId?.toLowerCase() === windowless.appId &&
          actionSurface.appId?.toLowerCase() === windowless.appId
            ? {
                kind: "RETRY" as const,
                reason: windowlessRepeat(windowless.name),
              }
            : evaluated;
        if (this.held || epoch !== this.epoch) {
          planFail("interrupted");
          continue;
        }
        // An undo is never retried or routed around: a greyed-out or missing
        // Edit > Undo means there is nothing to take back, and anything else
        // refused is reported in policy's own words.
        if (undo && decision.kind !== "ALLOW" && decision.kind !== "CONFIRM") {
          this.endUndo(
            undo,
            ["disabled", "missing"].includes(actionSurface.menuStatus ?? "")
              ? NOTHING_TO_UNDO_MESSAGE
              : decision.reason,
          );
          continue;
        }
        if (decision.kind !== "ALLOW" && decision.kind !== "CONFIRM")
          planFail(decision.kind.toLowerCase());
        // A refused tool call has no target to hand over: it counts as an
        // invalid step, and four in a row pause the run as they do today.
        if (decision.kind === "RETRY" && action.type === "tool_call") {
          this.event("ActionRetargetRequested", { actionType: action.type });
          history.push({
            type: action.type,
            action: echoAction(action),
            result: noInput(decision.reason),
          });
          this.countInvalid();
          continue;
        }
        if (decision.kind === "RETRY") {
          this.event("ActionRetargetRequested", {
            actionType: action.type,
            appId: actionSurface.appId,
            targetRole: actionSurface.targetRole,
            focusedRole: actionSurface.focusedRole,
            launcherStatus: actionSurface.launcherStatus,
          });
          const route = searchRoute(action, actionSurface);
          if (route && !this.searchRoutes.has(actionSurface.appId)) {
            this.searchRoutes.add(actionSurface.appId);
            routed = route;
            this.event("SearchRouteTaken", {
              appId: actionSurface.appId,
              depth: route.length,
            });
            history.push({
              type: action.type,
              action: echoAction(action),
              result: `No input was sent: no text field was focused. Opening ${route.join(" > ")} so the application shows its search field; type the text again on the next step.`,
            });
            continue;
          }
          const refused = ++this.targetingRetries;
          history.push({
            type: action.type,
            action: echoAction(action),
            // The model's copy of an entry is cut at MODEL_RESULT_CHARS: the
            // last word must survive the longest refusal reason.
            result:
              refused === REFUSED_TARGETS_LAST_WORD
                ? noInput(decision.reason).slice(
                    0,
                    MODEL_RESULT_CHARS - refusedTargetsWarning.length,
                  ) + refusedTargetsWarning
                : noInput(decision.reason),
          });
          if (refused > REFUSED_TARGETS_LAST_WORD) {
            this.targetingRetries = 0;
            this.takeover(
              action.type === "open_app" &&
                ["unresolved", "ambiguous"].includes(
                  actionSurface.launcherStatus ?? "",
                )
                ? "I couldn’t find that app. Open it yourself, then say continue."
                : TARGET_HANDOFF_MESSAGE,
              "handoff",
            );
          }
          continue;
        }
        if (decision.kind === "DENY") {
          this.event("UserDenied", {
            reason: decision.reason,
            ...(action.type === "tool_call" ? { actionType: action.type } : {}),
          });
          history.push({
            type: action.type,
            action: echoAction(action),
            result: noInput(decision.reason),
          });
          this.refused = { line: decision.reason, checked: false };
          // Repeated attempts to type or send detected secrets stay fatal.
          if (
            (action.type === "type_text" || action.type === "tool_call") &&
            /credential/i.test(decision.reason)
          ) {
            if (++this.credentialDenials >= 3)
              throw new Error("Repeated policy violations.");
          } else if (++this.denials >= 3) {
            this.denials = 0;
            this.pause(decision.reason);
          }
          continue;
        }
        if (decision.kind === "USER_TAKEOVER") {
          if (action.type === "request_user")
            history.push({
              type: "request_user",
              action: { type: "request_user", reason: action.reason },
              result:
                "You asked the user this and the run paused. It resumed only when the user said to continue. Any new details appear as a correction; without one, do not ask the same thing again: act on the most reasonable reading of the objective, or use fail if nothing sensible can be done.",
            });
          this.takeover(
            decision.reason,
            action.type === "request_user" ? "request_user" : "policy",
          );
          continue;
        }
        // The summary is shown to the local user, so keep URLs and identifiers
        // readable and remove only credentials. Contribution bundles never
        // include it (they export executed steps, sanitized separately).
        if (action.type === "done")
          action = { ...action, summary: redactSecrets(action.summary) };
        if (action.type === "fail")
          action = { ...action, reason: redactSecrets(action.reason) };
        this.event("ActionProposed", { action });
        // The question's kind is the only content-free trace of a tool
        // question; its text stays in the encrypted journal.
        const tool = toolContext.tool;
        const questionKind =
          tool?.prepared.ok && decision.kind === "CONFIRM"
            ? decision.floor
              ? "send_to"
              : tool.prepared.question.kind
            : undefined;
        if (action.type === "tool_call" && tool)
          this.event("ToolCallProposed", {
            tool: tool.spec.trace.tool,
            server: tool.spec.trace.server,
            toolTier: tool.spec.tier,
            argsBytes: tool.prepared.ok
              ? tool.prepared.argsBytes
              : JSON.stringify(action.args).length,
            entityCount: tool.prepared.ok
              ? new Set(tool.prepared.groundText.flatMap(entityTokens)).size
              : 0,
            ...(questionKind ? { questionKind } : {}),
          });
        let executionFrame = frame;
        if (decision.kind === "CONFIRM") {
          this.snapshot.pending = { action, reason: decision.reason };
          this.markHeld();
          this.status("confirming", decision.reason);
          this.event("PolicyConfirmationRequested", {
            reason: decision.reason,
            approvalCode: approvalCode(decision.reason),
            actionType: action.type,
            appId: actionSurface.appId,
            targetRole: actionSurface.targetRole,
            focusedRole: actionSurface.focusedRole,
            ...(questionKind ? { questionKind } : {}),
          });
          const allowed = await new Promise<boolean>(
            (resolve) => (this.approval = resolve),
          );
          this.approval = undefined;
          this.snapshot.pending = undefined;
          // A takeover during the prompt latched native input; an explicit
          // approval from the pill re-enables it like a spoken approval does.
          const relatch = this.voiceApproval;
          this.voiceApproval = false;
          if (!this.active()) break;
          if (this.held || epoch !== this.epoch) {
            planFail("interrupted");
            continue;
          }
          this.markActive();
          // Whoever answered set this; a pause resolving the wait never gets
          // here (held wins above), so a missing source is the pill's click.
          const answered = this.approvalSource ?? "pill";
          this.approvalSource = undefined;
          if (!allowed) {
            planFail("declined");
            if (this.recordDecline(action, answered, decision.reason) >= 3) {
              this.declines = 0;
              this.pause(
                "You declined several actions. Say continue with a hint when ready.",
              );
            }
            continue;
          }
          this.event("UserConfirmed", { source: answered });
          if (action.type === "tool_call") {
            // No screen target: nothing to restore or revalidate, and the
            // approval binds to the exact arguments the question rendered.
            // Native input is re-enabled for the screen steps that follow.
            try {
              if (relatch) await this.controller.resume();
            } catch (error) {
              if (this.held || epoch !== this.epoch) {
                planFail("interrupted");
                continue;
              }
              if (await this.recoverNative(error, epoch, action)) continue;
              throw error;
            }
          } else {
            // Replace the approval card before the slower restore/revalidate.
            this.status("capturing", "Checking the screen before acting.");
            const boundNow = this.boundTarget();
            let fresh: Frame | null;
            try {
              if (relatch) await this.controller.resume();
              // The user's application stays in front of a bound run: there
              // is nothing to restore, and its window is checked where it is.
              if (!boundNow) await this.controller.restore?.(frame);
              await this.ready();
              fresh = boundNow
                ? this.recordFrame(
                    await this.controller.revalidateTarget!(
                      boundNow.token,
                      action,
                      frame,
                    ),
                  )
                : this.controller.revalidate
                  ? this.recordFrame(
                      await this.controller.revalidate(action, frame),
                    )
                  : await this.capture();
            } catch (error) {
              if (this.held || epoch !== this.epoch) {
                planFail("interrupted");
                continue;
              }
              planFail(nativeReason(error));
              if (await this.recoverNative(error, epoch, action)) continue;
              throw error;
            }
            if (!fresh) {
              planFail("interrupted");
              continue;
            }
            // A bound window may move between the screenshot and the input
            // without the display changing: the helper maps the input from
            // its current frame and proved the control is still there.
            const change: ScreenChange | undefined =
              fresh.appId !== frame.appId
                ? "APP_CHANGED"
                : !sameGeometry(
                      boundNow ? withoutWindow(fresh.geometry) : fresh.geometry,
                      boundNow ? withoutWindow(frame.geometry) : frame.geometry,
                    )
                  ? "DISPLAY_CHANGED"
                  : !boundNow &&
                      !this.controller.revalidate &&
                      fresh.sha256 !== frame.sha256
                    ? "PIXELS_CHANGED"
                    : undefined;
            if (change) {
              planFail("state_changed");
              this.recoverStateChange(
                new ScreenChangedError(undefined, change),
                action,
              );
              continue;
            }
            executionFrame = fresh;
            action = { ...action, frame_id: fresh.id };
          }
        }
        this.check();
        if (this.held || epoch !== this.epoch) {
          planFail("interrupted");
          continue;
        }
        if (action.type === "done") {
          // A claim made after a refused step is checked once: the model
          // reads the refusal again on a fresh screenshot and says done
          // again or fail. Nothing executes, and no floor moved.
          const refused = this.refused;
          if (refused && !refused.checked) {
            refused.checked = true;
            this.event("ActionFailed", {
              code: "DONE_CHALLENGED",
              actionType: action.type,
            });
            history.push({
              type: "rejected",
              action: echoAction(action),
              result: doneChallenge(refused.line),
            });
            continue;
          }
          run.summary = action.summary;
          this.event("RunCompleted");
          this.status("completed", action.summary);
          break;
        }
        if (action.type === "fail") throw new Error(action.reason);
        if (action.type === "monitor") {
          // Runner-side, never sent to controller.execute: the watch takes
          // the window and this run is over.
          if ((await this.monitor(action, frame, epoch)) === "completed") break;
          continue;
        }
        if (action.type === "tool_call") {
          // Runner-side too: the tool layer runs it, never the controller.
          // Policy retried any tool missing from the list, so its spec is here.
          const state = await this.toolCall(
            action,
            tool!.spec,
            frame,
            decision,
            epoch,
          );
          if (state === "continue") continue;
          break;
        }
        this.event("PolicyAllowed", { reason: decision.reason });
        // The first screen step after a tool that could not do it says so:
        // the words are spoken through the run's status like every step's.
        const fallback = this.toolFallback;
        this.toolFallback = undefined;
        this.status(
          "executing",
          fallback
            ? toolFallbackLine(fallback)
            : action.type === "open_app"
              ? `Opening ${bound(action.name, 100)}.`
              : action.type === "open_file"
                ? `Opening ${bound(action.path.split("/").pop() || "the file", 100)}${action.app ? ` in ${bound(action.app, 60)}` : ""}.`
                : action.type === "menu_item"
                  ? `Choosing ${bound(action.path.join(" › "), 100)}.`
                  : action.type === "click_control"
                    ? `Clicking ${bound(action.label, 100)}.`
                    : `Executing ${action.type.replaceAll("_", " ")}.`,
        );
        const { frame_id: _frameId, ...executedAction } = action;
        const interrupted = () => {
          planFail("interrupted");
          this.event("ActionInterrupted", { actionType: action.type });
          history.push({
            type: action.type,
            action: executedAction,
            result:
              "Interrupted by the user; it may or may not have taken effect. Check the next screenshot before repeating it.",
          });
        };
        let outcome: void | ExecutionResult;
        // Counted before execute: an interrupted action may still have acted.
        this.attempted++;
        const native = nativeAction(action, decision, actionSurface);
        try {
          const toWindow = this.boundTarget();
          if (toWindow) {
            const delivered = await this.executeBound(
              toWindow,
              action,
              native,
              actionSurface,
              executionFrame,
              epoch,
            );
            // Nothing executed, and the run already heard why.
            if (!delivered) {
              planFail("background");
              continue;
            }
            outcome = delivered.outcome;
          } else
            outcome = await this.controller.execute(
              native,
              executionFrame,
              this.abort.signal,
            );
        } catch (e) {
          if (!this.active()) break;
          if (this.held || epoch !== this.epoch) {
            interrupted();
            continue;
          }
          // Native stop checks run between characters, keys and drag steps,
          // so part of the action may already have been posted.
          if (e instanceof NativeStoppedError) interrupted();
          // Read before planFail: abandoning the plan clears planPending.
          const planStep = this.planPending !== undefined;
          planFail(nativeReason(e));
          // The screen moved between the screenshot and the input and native
          // refused it before sending anything: re-aim once at the same
          // control instead of spending another model call. Approved steps
          // are excluded, so consent is asked again rather than reused, and
          // plan steps keep today's behavior (they resolve labels per frame).
          if (
            e instanceof ScreenChangedError &&
            !reaimed &&
            decision.kind === "ALLOW" &&
            !planStep
          ) {
            const next = await this.reaim(action, actionSurface, epoch);
            if (next) {
              reaim = next;
              reaimed = true;
              this.event("ActionReaimed", { actionType: action.type });
              continue;
            }
          }
          if (await this.recoverNative(e, epoch, action)) continue;
          throw e;
        }
        if (!this.active()) break;
        if (this.held || epoch !== this.epoch) {
          interrupted();
          continue;
        }
        this.recordExecuted(
          action,
          frame,
          executionFrame,
          actionSurface,
          outcome,
          { reaimed },
        );
        // Native typed every character into the field it verified as it
        // went, so the words are in; a screenshot to check would only be for
        // a model this run never calls. The summary names no text.
        if (dictated) {
          run.summary = "Typed it.";
          this.event("RunCompleted");
          this.status("completed", run.summary);
          break;
        }
        if (undo) this.endUndo(undo, UNDONE_MESSAGE);
      }
    } catch (e) {
      if (this.active()) {
        const message = e instanceof Error ? e.message : "Run failed.";
        run.summary = message;
        this.event("RunFailed", { code: "RUN_ERROR" });
        this.status("failed", message);
      }
    } finally {
      clearTimeout(this.timer);
      this.controller.stop();
      if (this.target)
        void this.controller.unbindTarget?.(this.target.token).catch(() => {});
      this.learn(run);
      this.settled = true;
      this.recorder.save(run);
      this.publish();
    }
  }
}
