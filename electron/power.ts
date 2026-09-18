/**
 * Keeps the Mac awake while it is working alone. A run started from the
 * phone, or a two-hour watch of a coding agent, ends silently when the
 * display sleeps and the screen locks, so with settings.keepAwake on the app
 * holds a "prevent-display-sleep" assertion for exactly as long as a run is
 * working or a watch is on, and lets go the moment both are over or the app
 * quits. A run waiting for the owner (an approval, a takeover, a pause) is
 * not working: its clock has stopped and the wait has no end, so the hold
 * is released and the Mac may lock with the gate on screen, rather than sit
 * awake and unlocked all night. Opt-in, because an awake, unlocked Mac is
 * visible to anyone nearby; the default leaves the owner's energy and lock
 * settings alone.
 */
import type { Settings, Snapshot } from "../src/core/schema";
import { isActiveStatus } from "../src/assistant/progress";
import { trace, type DiagnosticSink } from "../src/core/diagnostics";

/**
 * Electron's powerSaveBlocker, passed in (lazily, so main.ts loads without
 * touching it) and so tests need no Electron.
 */
export interface PowerBlocker {
  start(type: "prevent-display-sleep"): number;
  stop(id: number): boolean;
  isStarted(id: number): boolean;
}

/** The one rule: hold only when asked to and only while something works. */
export function shouldKeepAwake(i: {
  keepAwake: boolean;
  runActive: boolean;
  watching: boolean;
}): boolean {
  return i.keepAwake && (i.runActive || i.watching);
}

export class KeepAwake {
  private id?: number;
  private runActive = false;
  private watching = false;
  constructor(
    private readonly options: {
      settings: () => Pick<Settings, "keepAwake">;
      blocker: () => PowerBlocker;
      trace?: DiagnosticSink;
    },
  ) {}
  /** Call from emit(): active means capturing, thinking or executing. */
  onSnapshot(s: Snapshot): void {
    this.runActive = !!s.run && isActiveStatus(s.run.status);
    this.apply();
  }
  /** A detached watch (increment 5A) counts as work too. */
  setWatching(on: boolean): void {
    this.watching = on;
    this.apply();
  }
  held(): boolean {
    return this.id !== undefined && this.options.blocker().isStarted(this.id);
  }
  /** Re-reads the setting: also called after the settings are saved. */
  apply(): void {
    const want = shouldKeepAwake({
      keepAwake: this.options.settings().keepAwake,
      runActive: this.runActive,
      watching: this.watching,
    });
    if (want === this.held()) return;
    if (want) {
      try {
        this.id = this.options.blocker().start("prevent-display-sleep");
        trace(this.options.trace, "KeepAwakeStarted");
      } catch (error) {
        // Without the assertion the run still works; the Mac may just sleep.
        this.id = undefined;
        trace(this.options.trace, "KeepAwakeFailed", {
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    } else this.release();
  }
  /** Lets the Mac sleep again; called on quit as well. */
  release(): void {
    if (this.id === undefined) return;
    try {
      this.options.blocker().stop(this.id);
    } catch {}
    this.id = undefined;
    trace(this.options.trace, "KeepAwakeStopped");
  }
}
