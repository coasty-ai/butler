/**
 * The pure rules of a background run (.data/design/background-actuation.md):
 * which window the words name, which rungs a step may take to a window the
 * user is not looking at, how the result reads, and what the run says when it
 * needs the window in front. The runner applies them; nothing here touches
 * the helper.
 */
import type {
  Action,
  ExecutionResult,
  Geometry,
  Rung,
  TargetSpec,
} from "./schema";
import type { BackgroundRoute } from "./memory";

/** Spoken candidates tried before the prelude's app and the focused window. */
export const MAX_SPOKEN_TARGETS = 3;
/** A name's word: letters and digits, joined inside by . ' + or - ("slack.com", "Wi-Fi"); never a boundary word. */
const WORD = String.raw`(?!(?:and|then)\b)[\p{L}\p{N}]+(?:[.'’+-][\p{L}\p{N}]+)*`;
const NAME = `(${WORD}(?:\\s+${WORD}){0,2})`;
/** "in the Notes window called Groceries", "in the Slack app". */
const WINDOW_FORM = new RegExp(
  String.raw`\b(?:in|inside|within)\s+the\s+${NAME}\s+(?:window|app|application)\b(?:\s+(?:called|named|titled)\s+["“']?([^"”'\n,.;:]{1,80}?)["”']?(?=$|[\s,.;:!?]))?`,
  "giu",
);
/** "in Slack, …", "… in Slack" and "… in Slack and …": a name the sentence pauses after. */
const IN_FORM = new RegExp(
  String.raw`\b(?:in|inside|within)\s+${NAME}(?=\s*(?:[,.;:!?]|$)|\s+(?:and|then)\b)`,
  "giu",
);
/**
 * First words that never start an application's name in these phrases:
 * "in the morning", "in ten minutes", "check in with Dana", "log in to".
 */
const NOT_APP = new Set(
  `the a an my your his her its our their this that these those it them here
   there front back background order case fact time general particular short
   brief total summary detail turn return response reply place person parallel
   with to for from of at on by about into onto via and then one two three
   four five six seven eight nine ten fifteen twenty thirty minute minutes
   second seconds hour hours day days week weeks month months morning
   afternoon evening tonight today tomorrow`.split(/\s+/),
);
/**
 * The windows the task's own words name (design §2.2, rule 1), in the order
 * to try them: the explicit "the X window" forms first, then "in X" where the
 * sentence pauses after X, each also as its first word alone ("in Slack about
 * lunch" tries "Slack about lunch" and "Slack"). The helper resolves each name
 * through the launcher rules, so a phrase that is not an app simply fails to
 * bind and the next candidate is tried.
 */
export function spokenTargets(task: string): TargetSpec[] {
  const text = task.replace(/\s+/g, " ").trim();
  const specs: TargetSpec[] = [];
  const seen = new Set<string>();
  const add = (app: string, title?: string) => {
    const key = `${app.toLowerCase()}|${title?.toLowerCase() ?? ""}`;
    if (seen.has(key) || specs.length >= MAX_SPOKEN_TARGETS) return;
    seen.add(key);
    specs.push({ app, ...(title ? { title } : {}) });
  };
  const usable = (name: string) =>
    !NOT_APP.has(name.split(" ")[0].toLowerCase());
  for (const match of text.matchAll(WINDOW_FORM))
    if (usable(match[1])) add(match[1], match[2]?.trim());
  for (const match of text.matchAll(IN_FORM)) {
    const name = match[1];
    if (!usable(name)) continue;
    add(name);
    const first = name.split(" ")[0];
    if (first !== name) add(first);
  }
  return specs;
}

/** What a step takes to the window, in order, and whether it may end in front. */
export interface Ladder {
  rungs: Rung[];
  foreground: boolean;
}
/**
 * The actuation ladder for one step (design §2.5): accessibility first, then
 * events posted to the process, then the window in front. A menu item is an
 * accessibility press and nothing else; a double click has no press; a
 * published shortcut is pressed as its menu item and otherwise goes in front
 * (NSMenu key equivalents need the application frontmost). `skips` prunes a
 * rung the run already saw this application ignore for this kind of step, or
 * memory saw it ignore for the rung's route. Undefined for a step that is
 * not delivered to the window at all.
 */
export function backgroundLadder(
  action: Action,
  shortcutLabel: string | undefined,
  skips: (rung: Rung, route: BackgroundRoute) => boolean,
): Ladder | undefined {
  const all = (rungs: Rung[], foreground: boolean): Ladder => ({
    rungs: rungs.filter((rung) => !skips(rung, backgroundRoute(action, rung))),
    foreground,
  });
  switch (action.type) {
    case "click_control":
    case "click":
    case "right_click":
    case "scroll":
    case "key":
    case "type_text":
      return all(["ax", "post"], true);
    case "double_click":
      return all(["post"], true);
    case "menu_item":
      return all(["ax"], false);
    case "hotkey":
      return shortcutLabel ? all(["ax"], true) : all(["ax", "post"], true);
    default:
      return undefined;
  }
}
/** The memory route a rung belongs to for this kind of step (design §5). */
export function backgroundRoute(action: Action, rung: Rung): BackgroundRoute {
  const typing = ["type_text", "key", "hotkey"].includes(action.type);
  if (rung === "post") return typing ? "keys" : "post";
  return action.type === "type_text" ? "write" : "press";
}
/**
 * The key a run counts misses under: the kind of step and the rung, as the
 * helper counts them (BackgroundInput.swift RungMisses), so a click the
 * application ignores never disables its menu items. Memory keys by route.
 */
export const missKey = (action: Action, rung: Rung) => `${action.type}|${rung}`;
/** Misses on one key before the rung is skipped for the rest of the run (design §2.7). */
export const MISS_LIMIT = 2;
/**
 * Re-aims a step for its second in front (design §2.8). The model's points
 * are fractions of the window image; the helper's frontmost path maps
 * fractions of the display, so each point moves through the window's frame
 * at capture into the display's, clamped to it. Named controls, keys and
 * text carry no point and pass unchanged, as does a step with no window
 * frame to map through.
 */
export function aimAtDisplay(
  action: Action,
  window: Geometry["window"],
  display: Geometry,
): Action {
  if (!window || display.width <= 0 || display.height <= 0) return action;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const mapX = (x: number) =>
    clamp((window.x + x * window.width - display.x) / display.width);
  const mapY = (y: number) =>
    clamp((window.y + y * window.height - display.y) / display.height);
  const aimed: Record<string, unknown> = { ...action };
  for (const [xKey, yKey] of [
    ["x", "y"],
    ["start_x", "start_y"],
    ["end_x", "end_y"],
  ] as const) {
    const x = aimed[xKey],
      y = aimed[yKey];
    if (typeof x !== "number" || typeof y !== "number") continue;
    aimed[xKey] = mapX(x);
    aimed[yKey] = mapY(y);
  }
  return aimed as Action;
}
/** Codes from executeTarget that mean "no background route for this step here": rung 3 decides. */
export const NO_BACKGROUND_ROUTE = new Set([
  "TARGET_MINIMIZED",
  "TARGET_OFF_SPACE",
  "TARGET_COVERED_STALE",
  "RUNG_UNAVAILABLE",
  "RUNG_NO_EFFECT",
  "KEYBOARD_AMBIGUOUS",
]);
/**
 * A fully covered window whose picture may be stale refused a point (design
 * §2.3): the first time the model is told to use a listed control instead;
 * only a repeat, or a window listing no controls, goes in front.
 */
export const coveredStaleRetry = (app: string) =>
  `No input was sent. ${app}'s window is fully covered, so its picture may be stale. Use a listed control from context.controls (click_control, type_text into a listed field, or menu_item) instead of a point.`;
/** Foreground detours a run may take before it stays in front: 3 in any 10 steps. */
export const FOREGROUND_CAP = { handoffs: 3, steps: 10 } as const;
/** Whether the detours so far (by run step) reach the cap at this step. */
export function foregroundCapReached(steps: number[], step: number): boolean {
  return (
    steps.filter((s) => s > step - FOREGROUND_CAP.steps && s <= step).length >=
    FOREGROUND_CAP.handoffs
  );
}

/**
 * The history line for a step delivered to a bound window: the rung and what
 * the postcondition read found, honestly (design §2.4, §4). `what` is the
 * target as executedTarget words it; the application's name is the only
 * screen-derived text added.
 */
export function backgroundResult(
  action: Action,
  what: string,
  outcome: ExecutionResult,
  appName: string,
): string {
  const typing = ["type_text", "key", "hotkey"].includes(action.type);
  const via =
    outcome.rung === "ax"
      ? action.type === "type_text"
        ? "by an accessibility write"
        : "by accessibility"
      : outcome.rung === "post"
        ? `by ${typing ? "keys" : "events"} posted to ${appName}`
        : `with ${appName} in front for a second`;
  // In front the step went as every step did before, with no read to report.
  const read =
    outcome.effect === "changed"
      ? "; the window changed"
      : outcome.effect === "none"
        ? `; nothing changed, so ${appName} may ignore this route; use a listed control, the menu or the keyboard instead`
        : outcome.rung === "foreground"
          ? ""
          : "; whether it took could not be read";
  return `Executed${what} ${via}${read}. Verify the next screenshot${typing ? " shows the intended result before done" : ""}.`;
}

/** Rung 3 is about to take the screen; spoken when the user is present (design §2.8). */
export const foregroundRequest = (app: string) => `I need ${app} for a second.`;
export const isForegroundRequest = (message: string) =>
  /^I need .+ for a second\.$/.test(message);
/** The activation did not take: macOS 14 activation follows the user's intent. */
export const foregroundHandoff = (app: string) =>
  `Click into ${app} and I’ll continue.`;
/**
 * The user's hands are in the bound window (design §3). The hold ends on its
 * own once they have left it: the application no longer in front and their
 * last press, scroll or key somewhere else (src/core/resume.ts reads both from
 * the helper's idle report), and the words say exactly that. Settings ›
 * Working and docs/VOICE_PRODUCT.md quote this sentence as it stands.
 */
export const targetHold = (app: string) =>
  `Paused — you’re in ${app}. I’ll continue when you switch away.`;
export const isTargetHold = (message: string) =>
  /^Paused — you’re in .+\. I’ll continue when you switch away\.$/.test(
    message,
  );
export const finishInFront = (app: string) =>
  `${app} keeps ignoring background input; I’ll finish this in front.`;
export const noWindowInFront = (app: string) =>
  `${app} has no window open; I’ll open it in front.`;
export const targetGoneMessage = (app: string) =>
  `${app}’s window went away. Say continue and I’ll go on in front.`;
/** Named once per run when memory pruned a route for this application (design §5). */
export function routeSkipped(app: string, route: BackgroundRoute): string {
  if (route === "write" || route === "keys")
    return `${app} ignores typing in the background; I’ll ask for the window when I need to type.`;
  return `${app} ignores ${route === "press" ? "accessibility presses" : "posted clicks"} in the background; I’ll use another route.`;
}
