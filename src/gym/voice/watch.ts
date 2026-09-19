import {
  TERMINAL,
  followupReady,
  isChatter,
  type DiagnosticEvent,
  type FollowupFacts,
} from "./grade";

/**
 * What the app is doing now, from every diagnostics event the loop has
 * read: listening, speaking, open runs, the open follow-up window, the
 * standby levels, when it last did anything the gate should wait out, and
 * when a person last took over. Pure over event arrays, so the rules that
 * read it are tested from synthetic slices; the script only feeds it.
 */
export class AppWatch {
  listening: boolean | null = null;
  /** The newest non-chatter event. */
  lastEventAt = 0;
  speaking = false;
  speechRequestedAt: number | undefined = undefined;
  speechStartedAt: number | undefined = undefined;
  speechFinishedAt: number | undefined = undefined;
  followupOpen = false;
  followupKind: string | null = null;
  /** When the open window opened; undefined once closed. */
  followupOpenedAt: number | undefined = undefined;
  /** followup_open events seen, a conversation window reopening after every exchange included. */
  followupOpens = 0;
  runs = new Map<string, string>();
  /** The last RunStarted/RunState time per run: how long an open run has been silent. */
  runsAt = new Map<string, number>();
  /** When the latest wake_status was seen. */
  listeningAt: number | undefined = undefined;
  lastActionAt: number | undefined = undefined;
  levels: { at: number; rms: number }[] = [];
  heardTextAt: number | undefined = undefined;
  permissions: Record<string, boolean> | null = null;
  verbose: boolean | null = null;
  /**
   * When a person last took over (`UserTakeoverStarted{manual_input}` or
   * `NativeUserTakeover`). A timestamp, never a latch: the log tail fed at
   * startup holds the session's history, and only a takeover since the
   * current prompt is this turn's.
   */
  takeoverAt: number | undefined = undefined;

  feed(events: DiagnosticEvent[]): void {
    for (const e of events) {
      const d = (e.data ?? {}) as Record<string, unknown>;
      const at = Date.parse(e.timestamp);
      if (!isChatter(e)) this.lastEventAt = Math.max(this.lastEventAt, at);
      if (e.event === "VoiceEvent") {
        if (d.phase === "wake_status") {
          this.listening = d.listening === true;
          this.listeningAt = at;
        }
        if (d.phase === "speech_started") {
          this.speaking = true;
          this.speechStartedAt = at;
        }
        if (d.phase === "speech_finished") {
          this.speaking = false;
          this.speechFinishedAt = at;
        }
        if (d.phase === "followup_open") {
          if (!this.followupOpen) this.followupOpenedAt = at;
          this.followupOpen = true;
          this.followupOpens++;
          this.followupKind = typeof d.kind === "string" ? d.kind : null;
        }
        if (d.phase === "followup_closed") {
          this.followupOpen = false;
          this.followupOpenedAt = undefined;
          this.followupKind = null;
        }
        if (d.phase === "standby_trace") {
          if (d.kind === "level" && typeof d.rms === "number") {
            this.levels.push({ at, rms: d.rms });
            if (this.levels.length > 60) this.levels.shift();
          }
          if (typeof d.textLength === "number" && d.textLength > 0)
            this.heardTextAt = at;
        }
      }
      if (e.event === "SpeechOut" && d.phase === "requested")
        this.speechRequestedAt = at;
      if (e.event === "Permissions" && d.permissions)
        this.permissions = d.permissions as Record<string, boolean>;
      if (e.event === "Command" && typeof d.text === "string")
        this.verbose = true;
      if (e.event === "RunState" && typeof d.task === "string")
        this.verbose = true;
      if (
        e.event === "RunState" &&
        typeof d.runId === "string" &&
        typeof d.status === "string"
      ) {
        this.runs.set(d.runId, d.status);
        this.runsAt.set(d.runId, at);
      }
      if (
        e.event === "RunStarted" &&
        typeof d.runId === "string" &&
        !this.runs.has(d.runId)
      ) {
        this.runs.set(d.runId, "starting");
        this.runsAt.set(d.runId, at);
      }
      if (e.event === "ActionExecuted") this.lastActionAt = at;
      if (e.event === "UserTakeoverStarted") {
        const inner = (d.data ?? {}) as Record<string, unknown>;
        const source = d.source ?? inner.source;
        if (source === "manual_input" || source === undefined)
          this.takeoverAt = Math.max(this.takeoverAt ?? 0, at);
      }
      if (e.event === "NativeUserTakeover")
        this.takeoverAt = Math.max(this.takeoverAt ?? 0, at);
    }
  }

  get runOpen(): boolean {
    for (const status of this.runs.values())
      if (!TERMINAL.has(status)) return true;
    return false;
  }

  /** The runs not terminal at `now`: their status and how long since they last changed (the RUN_LEFT_OPEN evidence). */
  openRuns(now = Date.now()): { status: string; silentMs: number }[] {
    const out: { status: string; silentMs: number }[] = [];
    for (const [runId, status] of this.runs)
      if (!TERMINAL.has(status))
        out.push({ status, silentMs: now - (this.runsAt.get(runId) ?? now) });
    return out;
  }

  /** A person took over at or after `since` (the current prompt's start). */
  takeoverSince(since: number): boolean {
    return this.takeoverAt !== undefined && this.takeoverAt >= since;
  }

  recentLevels(sinceMs: number, now = Date.now()): number[] {
    return this.levels.filter((l) => now - l.at <= sinceMs).map((l) => l.rms);
  }

  followupFacts(now = Date.now()): FollowupFacts {
    return {
      now,
      followupOpen: this.followupOpen,
      followupKind: this.followupKind,
      speaking: this.speaking,
      speechRequestedAt: this.speechRequestedAt,
      speechStartedAt: this.speechStartedAt,
      speechFinishedAt: this.speechFinishedAt,
    };
  }

  /** A follow-up line may be spoken now (grade.ts followupReady). */
  followupReady(kind?: string, now = Date.now()): boolean {
    return followupReady(this.followupFacts(now), kind);
  }
}

/**
 * The lines of a diagnostics text from the first one stamped at or after
 * `sinceMs`; undefined when none is. Lines that are not events are skipped
 * while searching and kept afterwards. The preflight's open-run count reads
 * only the running app's own session this way, not a run a crash cut off
 * hours ago.
 */
export function linesSince(text: string, sinceMs: number): string | undefined {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    let stamp: unknown;
    try {
      stamp = (JSON.parse(line) as { timestamp?: unknown }).timestamp;
    } catch {
      continue;
    }
    if (typeof stamp !== "string") continue;
    const at = Date.parse(stamp);
    if (Number.isFinite(at) && at >= sinceMs) return lines.slice(i).join("\n");
  }
  return undefined;
}
