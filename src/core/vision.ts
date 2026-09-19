import { focusedTextField } from "./policy";
import type {
  Action,
  ExecutionResult,
  Frame,
  ScreenshotReason,
  ScreenshotUse,
  Settings,
  Surface,
} from "./schema";

/*
 * Whether a step carries its screenshot, and how large (settings.visionMode).
 * Live 2026-09-19: the 1440x900 PNG was about a quarter of every request.
 * Anthropic counts an image at width × height / 750 tokens after scaling it
 * to at most 1.15 megapixels (1440x900 → about 1.5k); OpenAI's mini models
 * count ceil(width / 32) × ceil(height / 32) patches, at most 1536, times a
 * per-model multiplier (1.62 for the mini family: 1440x900 → about 2.1k,
 * 1024x640 → about 1k). Most steps of a run change little of a screen the
 * accessibility context already describes. The rules below decide from what
 * the runner already has; nothing here reads pixels.
 */

/** Labeled controls that, with the text below, describe a screen well enough to reduce its screenshot. */
export const DESCRIBED_CONTROLS = 8;
/**
 * The native helper reads the screenshot for text below this many characters
 * of accessibility text (Controller.swift capture), so this many means the
 * text on screen came from the application itself.
 */
export const DESCRIBED_TEXT_CHARS = 600;
/** A screenshot goes with at least every fourth step. */
export const SCREENSHOT_EVERY = 4;

export interface ScreenshotInput {
  mode: Settings["visionMode"];
  frame: Frame;
  /** The surface the frame was captured on. */
  surface?: Surface;
  /**
   * What the model saw last: that frame's hash and context digest. Undefined
   * on a run's first step and after a pause, correction or takeover, when the
   * user may have changed the screen.
   */
  shown?: { sha256: string; context: string };
  /** Model steps since the model last saw a screenshot, full or reduced. */
  sinceImage: number;
  /**
   * The action executed since the model's last step, and whether native
   * input verified its target (actionConfirmed). Undefined when nothing was
   * executed: a rejected step, a step without input.
   */
  executed?: { type: string; confirmed: boolean };
}

/** The accessibility context as one string, for the unchanged-screen check. */
export function contextDigest(frame: Frame): string {
  return JSON.stringify(frame.context ?? null);
}

/**
 * The screenshot rules, in order: "always" sends every one at full size; a
 * full screenshot is never dropped on the first step, after the model called
 * capture, on a blind or unknown surface, when the helper had to read the
 * screenshot for text (screenText), after an action whose target native
 * input could not verify, or when the model has not had one for three steps.
 * Only then does an unchanged screen (same hash, same context) send none,
 * and a screen described by enough labeled controls and text send the
 * reduced rendition ("text-first": none). Anything else is a full screenshot.
 */
export function screenshotUse(input: ScreenshotInput): ScreenshotUse {
  const { mode, frame, surface, shown, executed } = input;
  const full = (reason: ScreenshotReason): ScreenshotUse => ({
    send: "full",
    reason,
  });
  if (mode === "always") return full("always");
  if (!shown) return full("first");
  if (executed?.type === "capture") return full("requested");
  const context = frame.context;
  if (!context || context.accessibility === "none" || surface?.unknown)
    return full("blind");
  if (context.screenText !== undefined) return full("ocr");
  if (executed && !executed.confirmed) return full("unconfirmed");
  if (input.sinceImage >= SCREENSHOT_EVERY - 1) return full("cadence");
  if (shown.sha256 === frame.sha256 && shown.context === contextDigest(frame))
    return { send: "none", reason: "unchanged" };
  const labeled = context.controls?.filter((c) => c.label).length ?? 0;
  if (
    labeled >= DESCRIBED_CONTROLS &&
    (context.visibleText?.length ?? 0) >= DESCRIBED_TEXT_CHARS
  )
    return {
      send: mode === "text-first" ? "none" : "reduced",
      reason: "described",
    };
  return full("changed");
}

/**
 * Whether native input verified the executed action's target, so the next
 * step can read its result from the accessibility context: a menu item or
 * control resolved by name, a hotkey pressed through its menu item, an
 * application brought to the front, a file opened, text or a key into an
 * identified text field, a pointer action whose hit test found a labeled
 * control, and a wait, which sends nothing. Scrolls, drags, moves, keys
 * posted blind and clicks on nothing identified are not.
 */
export function actionConfirmed(
  action: Action,
  surface: Surface,
  outcome: void | ExecutionResult,
): boolean {
  switch (action.type) {
    case "menu_item":
    case "click_control":
    case "wait":
      return true;
    case "open_app":
      return !!outcome && outcome.launched?.frontmost === true;
    case "open_file":
      return !!outcome && !!outcome.opened;
    case "hotkey":
      return !!outcome && outcome.via === "menu";
    case "type_text":
    case "key":
      return focusedTextField(surface);
    case "click":
    case "double_click":
    case "right_click":
      return !!surface.targetLabel;
    default:
      return false;
  }
}

/** The one line a step carries in place of its screenshot. */
export function screenshotNote(use: ScreenshotUse): string | undefined {
  if (use.send !== "none") return undefined;
  return use.reason === "unchanged"
    ? "No screenshot: the screen is unchanged since your last step (same image, controls and text). Call capture if you need to see it."
    : "No screenshot: context.controls and context.visibleText describe this screen. Call capture if you need to see it.";
}
