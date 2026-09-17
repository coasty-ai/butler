export class ScreenChangedError extends Error {
  readonly code = "STATE_CHANGED";
  constructor(message = "The screen changed before input.") {
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
  | "OPEN_FAILED";
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
