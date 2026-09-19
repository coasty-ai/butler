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
  Settings,
  Snapshot,
  ScreenContext,
  Observation,
  Surface,
  MemoryContext,
  TaskSource,
  Usage,
  WatchBinding,
  WatchContext,
} from "./schema";
import type {
  MemoryAccess,
  Recall,
  ReplayPlan,
  TrajectoryStep,
} from "./memory";
import {
  validateAction,
  sameGeometry,
  normalizePixelCoordinates,
} from "./schema";
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
  type ScreenChange,
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
  const whole = history
    .slice(-MODEL_HISTORY_FULL)
    .map((entry) => ({
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
  " Warning: you keep switching between applications. Switching again will not show new information. Read the values you need from the current screenshot and context now, then finish the step in this application.";
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
    this.emit(structuredClone(this.snapshot));
  }
  private event(type: string, data: Record<string, unknown> = {}) {
    const e = this.recorder.append(this.snapshot.run!.id, type, data);
    this.snapshot.events.push(e);
    this.publish();
  }
  private status(status: RunStatus, message?: string) {
    if (!this.snapshot.run) return;
    // A late async continuation must never revive a finished run.
    if (terminal(this.snapshot.run.status)) return;
    this.snapshot.run.status = status;
    if (message) this.snapshot.message = message;
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
  manualTakeover() {
    if (this.snapshot.pending && this.snapshot.run?.status === "confirming") {
      this.interruptForVoice();
      return;
    }
    if (!this.active()) return;
    this.handsOn = true;
    this.pause(MANUAL_PAUSE_MESSAGE);
    this.event("UserTakeoverStarted", { source: "manual_input" });
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
      this.recordDecline(pending.action, source);
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
  private recordDecline(action: Action, source: ApprovalSource) {
    this.event("UserDenied", {
      source,
      ...(action.type === "tool_call" ? { actionType: action.type } : {}),
    });
    this.reject({
      type: action.type,
      action: echoAction(action),
      result:
        "User declined this action. Choose a different approach or request_user.",
    });
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
    const surface = await this.controller.surface();
    this.lastSurface = surface;
    const decision = surfacePolicy(surface, this.settings);
    if (decision.kind !== "ALLOW") {
      this.takeover(decision.reason, "surface");
      return null;
    }
    const frame = await this.controller.capture();
    return this.recordFrame(frame);
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
  async start(
    task: string,
    options: {
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
    } = {},
  ) {
    if (this.active()) throw new Error("A run is already active.");
    this.settled = false;
    this.watchContext = options.watch;
    this.watchChain = options.chain;
    this.undoRequest = options.undo ? { own: true } : undefined;
    this.executed = [];
    this.started = Date.now();
    this.heldMs = 0;
    this.heldSince = undefined;
    this.abort = new AbortController();
    this.held = false;
    this.voiceApproval = false;
    this.history = [];
    this.resetCounters();
    this.resetLoop();
    this.resetMemory();
    const run: Run = {
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
    // A wake-up run neither recalls nor learns: its objective is a follow-up
    // that quotes the watched request, and a plan recalled for that request
    // would replay its steps with nobody at the Mac. An undo run's one step
    // is fixed, so there is nothing to recall or learn for it either.
    this.memoryRun =
      !!this.memory &&
      !run.synthetic &&
      run.origin !== "watch" &&
      !options.undo &&
      this.controller.kind !== "tutorial" &&
      this.settings.memory !== false;
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
    // The tool layer: a dictation types, an undo takes back and a practice
    // run drives a simulated screen, so none of them lists tools.
    const tools =
      run.synthetic || dictation !== undefined || options.undo
        ? undefined
        : this.extras.tools;
    try {
      if (options.prelude && !run.synthetic) this.applyPrelude(options.prelude);
      // Recall and the tool list overlap the first capture (the helper
      // answers the index off its queue); both are awaited before anything
      // decides on the frame, so a recalled plan, memory and the frozen tool
      // list are in place exactly as if they had come first.
      let recalled = this.memoryRun ? this.recall(task) : undefined;
      let listed = tools ? this.listTools(tools, task) : undefined;
      if (!this.active()) return;
      await this.controller.resume();
      while (this.active()) {
        await this.ready();
        const epoch = this.epoch;
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
        this.abort = new AbortController();
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
          const screenshot = screenshotUse({
            mode: this.settings.visionMode,
            frame,
            surface: this.lastSurface,
            shown: this.shown,
            sinceImage: this.sinceImage,
            executed: this.lastStep,
          });
          this.lastStep = undefined;
          this.event("ModelRequestStarted", {
            screenshot: screenshot.send,
            screenshotReason: screenshot.reason,
          });
          try {
            result = await this.provider.next(
              {
                screenshot,
                // run.task, not the start() argument: amendTask may replace it.
                task:
                  run.task +
                  (run.corrections?.length
                    ? "\nUser corrections, in order. Preserve earlier constraints unless explicitly superseded:\n" +
                      run.corrections.map((c) => c.text).join("\n")
                    : ""),
                // Why a watch woke this run stays visible on every step, since
                // the model only sees one screenshot and the last few history
                // entries whole. Only the model's copy carries it: the panel
                // text in it never enters a Snapshot, a trace or a saved frame.
                frame:
                  this.watchContext && frame.context
                    ? {
                        ...frame,
                        context: { ...frame.context, watch: this.watchContext },
                      }
                    : frame,
                history: modelHistory(history),
                ...(this.memoryContext ? { memory: this.memoryContext } : {}),
                // The frozen tool list and the clock it runs on, on the
                // model's copy only, like context.watch above.
                ...(tools &&
                this.toolList &&
                (this.toolList.tools.length || this.toolList.unavailable.length)
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
            this.event("ActionFailed", { code: "MALFORMED_RESPONSE" });
            history.push({
              type: "rejected",
              result: `No input was executed. Your last reply was not exactly one action (${bound(String(result.problem), 200)}). Return exactly one action object using the frame_id from the current context.`,
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
        try {
          actionSurface = await this.controller.surface(
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
          history.push({
            type: action.type,
            action: echoAction(action),
            result: noInput(decision.reason),
          });
          if (++this.targetingRetries >= 3) {
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
            if (this.recordDecline(action, answered) >= 3) {
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
            let fresh: Frame | null;
            try {
              if (relatch) await this.controller.resume();
              await this.controller.restore?.(frame);
              await this.ready();
              fresh = this.controller.revalidate
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
            const change: ScreenChange | undefined =
              fresh.appId !== frame.appId
                ? "APP_CHANGED"
                : !sameGeometry(fresh.geometry, frame.geometry)
                  ? "DISPLAY_CHANGED"
                  : !this.controller.revalidate && fresh.sha256 !== frame.sha256
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
        try {
          outcome = await this.controller.execute(
            nativeAction(action, decision, actionSurface),
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
      this.learn(run);
      this.settled = true;
      this.recorder.save(run);
      this.publish();
    }
  }
}
