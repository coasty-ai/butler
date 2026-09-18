/**
 * What changed when a step was refused before input, as the native helper's
 * fixed code (screenChangeCodes in native/macos/FrameSafety.swift; the list is
 * pinned by tests/fixtures/screen-changes.json). Content-free by construction:
 * any other value from the helper is dropped.
 */
export const screenChanges = [
  "FOCUS_CHANGED",
  "APP_CHANGED",
  "WINDOW_CHANGED",
  "DISPLAY_CHANGED",
  "CONTROLS_CHANGED",
  "TARGET_COVERED",
  "PIXELS_CHANGED",
  "STALE_FRAME",
  "FRAME_EXPIRED",
  "MENU_CHANGED",
] as const;
export type ScreenChange = (typeof screenChanges)[number];
export function screenChange(value: unknown): ScreenChange | undefined {
  return screenChanges.find((code) => code === value);
}
export class ScreenChangedError extends Error {
  readonly code = "STATE_CHANGED";
  constructor(
    message = "The screen changed before input.",
    readonly change?: ScreenChange,
  ) {
    super(message);
    this.name = "ScreenChangedError";
  }
}

/**
 * The provider could not be reached after bounded retries: connection
 * interruptions, HTTP 429/5xx or the request deadline. The run should pause
 * and let the user retry instead of failing.
 */
export class ProviderTransientError extends Error {
  readonly retryable = true;
  constructor(message: string) {
    super(message);
    this.name = "ProviderTransientError";
  }
}

/**
 * The native stop latch was already set when input was attempted, usually by
 * a voice shortcut or manual takeover whose event has not reached the runner
 * yet. No input was sent.
 */
export class NativeStoppedError extends Error {
  readonly code = "STOPPED";
  constructor(
    message = "Native input stopped. Explicitly resume to continue.",
  ) {
    super(message);
    this.name = "NativeStoppedError";
  }
}

export type NativeActionCode =
  | "LAUNCH_FAILED"
  | "APP_UNRESOLVED"
  | "APP_REFUSED"
  | "FILE_UNRESOLVED"
  | "FILE_REFUSED"
  | "OPEN_FAILED"
  // A named menu item or control the helper resolved again at input time and
  // did not press: gone, greyed out, refused, or no longer one control.
  | "TARGET_MISSING"
  | "TARGET_DISABLED"
  | "TARGET_REFUSED"
  | "TARGET_AMBIGUOUS";
/**
 * A recoverable, rejected step reported by the native helper (for example an
 * application that could not be resolved or launched). No GUI input was sent.
 */
export class NativeActionError extends Error {
  constructor(
    readonly code: NativeActionCode,
    message: string,
  ) {
    super(message);
    this.name = "NativeActionError";
  }
}

/**
 * The native helper exited or stopped responding and is being restarted. The
 * run should pause until the user continues.
 */
export class HelperUnavailableError extends Error {
  readonly code = "HELPER_UNAVAILABLE";
  constructor(message = "Desktop control is restarting.") {
    super(message);
    this.name = "HelperUnavailableError";
  }
}

/**
 * The native helper refused to capture or send input because a protected
 * application or domain, secure input or an uninstaller is active. The run
 * should hand control to the user (takeover) instead of failing.
 */
export class SurfaceBlockedError extends Error {
  readonly code = "SURFACE_BLOCKED";
  constructor(message: string) {
    super(message);
    this.name = "SurfaceBlockedError";
  }
}
