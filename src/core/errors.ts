export class ScreenChangedError extends Error {
  readonly code = "STATE_CHANGED";
  constructor(message = "The screen changed before input.") {
    super(message);
    this.name = "ScreenChangedError";
  }
}
