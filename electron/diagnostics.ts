import {
  appendFileSync,
  readdirSync,
  writeFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { redactSecrets, sanitizeText, scanText } from "../src/core/sanitize";
import type { Snapshot } from "../src/core/schema";
import type { DiagnosticSink } from "../src/core/diagnostics";

const fields = new Set([
  "runId",
  "requestId",
  "frameId",
  "provider",
  "model",
  "status",
  "phase",
  "method",
  "attempt",
  "durationMs",
  "ttftMs",
  "delayMs",
  "httpStatus",
  "bytes",
  "code",
  "error",
  "name",
  "cause",
  "retryable",
  "actions",
  "frames",
  "usage",
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
  "cost",
  // ModelRequestStarted: whether the step carried its screenshot, and why
  // (fixed codes from src/core/vision.ts).
  "screenshot",
  "screenshotReason",
  "actionType",
  "targetRole",
  "focusedRole",
  "x",
  "y",
  "start_x",
  "start_y",
  "end_x",
  "end_y",
  "delta_x",
  "delta_y",
  "textLength",
  "confidence",
  "synthetic",
  "geometry",
  "width",
  "height",
  "model_width",
  "model_height",
  "scale_factor",
  "permissions",
  "screen",
  "accessibility",
  "microphone",
  "speech",
  "onDevice",
  "shortcut",
  "enabled",
  "listening",
  "pid",
  "sequence",
  "taskLength",
  "appId",
  "cancelled",
  "timedOut",
  "reason",
  "source",
  "sourcePid",
  "eventType",
  "flags",
  "pointerDistance",
  // NativeInputIdle during a bound run: whether the target application is in
  // front and whether the hands are in its window (design §3).
  "targetFrontmost",
  "lastInsideTarget",
  "launcherStatus",
  "launchedAppId",
  "frontmost",
  "wasRunning",
  "launchedWindows",
  "restoredWindow",
  "nameLength",
  "noteLength",
  "problem",
  // ProviderMalformed: the shape of arguments that were not JSON (counts,
  // flags and a parse-error code, src/providers/action-format.ts), and
  // ProviderResponse: whether the action had to be repaired out of text.
  "argumentShape",
  "length",
  "startsWithBrace",
  "endsWithBrace",
  "parseError",
  "parseOffset",
  "openBraces",
  "closeBraces",
  "quotes",
  "backslashes",
  "newlines",
  "backticks",
  "controls",
  "objects",
  "depthAtEnd",
  "quotedAtEnd",
  "leadingProse",
  "trailingProse",
  "repaired",
  "normalized",
  "exitCode",
  "signal",
  "restarts",
  "incompleteReason",
  "stopReason",
  "outputTypes",
  "period",
  // Memory and replay plans: content-free counts and fixed codes only.
  "preferences",
  "episodes",
  "apps",
  "files",
  "folders",
  "skills",
  "index",
  "plan",
  "mode",
  "openedKind",
  "openedAppId",
  // Voice turns and spoken replies: codes, timings, levels and flags only.
  // Spoken or recognized text stays under `text`, which is never allow-listed.
  "kind",
  "priority",
  "interrupted",
  "engine",
  "voiceQuality",
  "window",
  "completeness",
  "patience",
  "endReason",
  "segments",
  "stableMs",
  "quietMs",
  "latencyMs",
  "noiseFloor",
  "threshold",
  "merged",
  "speaking",
  "rate",
  "fallback",
  "utteranceId",
  "remainingMs",
  // The helper's echo cancellation (voice_processing, standby_trace): on or
  // off, the microphone format the tap gets, the channel of it the recognizer
  // reads and that channel's level.
  "voiceProcessing",
  "sampleRate",
  "channels",
  "interleaved",
  "micChannel",
  "micLevel",
  // The phone remote: route names, verdict and tier codes, and a hashed
  // device code. Never a login, an address, a token or a line of text.
  "route",
  "verdict",
  "tier",
  "device",
  // Dialog turns and streamed replies: the act chosen, timings to the ACT
  // line and the first audio, fixed decision codes and sentence counts.
  // The words themselves never appear.
  "act",
  "actMs",
  "firstAudioMs",
  "preempt",
  "stream",
  "sentences",
  "dropped",
  "channel",
  // A refused step's kind of screen change and a hotkey's route (menu or
  // keys): fixed codes from the native helper, never its sentence.
  "change",
  "via",
  // The opt-in Jev decider on a dialog turn: its time, the act it chose and
  // that act's probability, whether it was used, and its failure code.
  "jevMs",
  "jevAct",
  "jevP",
  "jevUsed",
  "jevCode",
  // The early step taken while the user speaks: how it settled, its timings
  // and whether a journaled step was one. Never the app or the words.
  "settle",
  "earlyMs",
  "leadMs",
  "early",
  // A spoken scroll: its direction, pace and how many ticks it posted.
  "direction",
  "linesPerTick",
  "tickMs",
  "ticks",
  // Tools (src/tools): hashed server and tool codes, tiers, outcomes and the
  // kind of question asked; counts, sizes and flags. Never an argument, a
  // result, a description, a command, a path or a URL.
  "server",
  "tool",
  "transport",
  "toolTier",
  "outcome",
  "questionKind",
  // A policy question as a code (src/core/approval-codes.ts), on the
  // question asked and on its decline; the question's text stays out.
  "approvalCode",
  "providerState",
  "answerTier",
  "toolCount",
  "unavailableCount",
  "resultItems",
  "toolCalls",
  "toolWrites",
  "entityCount",
  "added",
  "skippedRemote",
  "refused",
  "secretsMoved",
  "argsBytes",
  "resultBytes",
  "stderrBytes",
  "verified",
  "sandboxed",
  "disclaimed",
  "pinned",
  "finish",
  "longRunning",
  // A coding delegation's folder as a hashed code, never its path.
  "project",
  // The first step prepared while the user spoke (Speculation* events): how
  // much of it was done when the run started and how old its frame was.
  "savedMs",
  "frameAgeMs",
  // NativeSlow and NativeTimedOut: how long a helper request had waited when
  // its deadline passed and the helper was found alive (the wait extended)
  // or not (the helper killed). A measurement beside the method's name.
  "waitedMs",
]);
/** Allow-listed keys that only ever carry a count or position. */
const countFields = new Set([
  "preferences",
  "episodes",
  "apps",
  "files",
  "folders",
  "skills",
  "index",
  "segments",
  "sentences",
  "dropped",
  "launchedWindows",
  "ticks",
  "channels",
  "micChannel",
  "count",
  "restarts",
  "toolCount",
  "unavailableCount",
  "resultItems",
  "toolCalls",
  "toolWrites",
  "entityCount",
  "added",
  "skippedRemote",
  "refused",
  "secretsMoved",
  // The shape of unparseable model arguments: every one a count.
  "length",
  "parseOffset",
  "openBraces",
  "closeBraces",
  "quotes",
  "backslashes",
  "newlines",
  "backticks",
  "controls",
  "objects",
  "depthAtEnd",
  "leadingProse",
  "trailingProse",
]);
/** Allow-listed keys that only ever carry a finite measurement. */
const numberFields = new Set([
  "sampleRate",
  "micLevel",
  "textLength",
  "noteLength",
  "taskLength",
  "durationMs",
  "ttftMs",
  "confidence",
  "stableMs",
  "quietMs",
  "latencyMs",
  "remainingMs",
  "noiseFloor",
  "threshold",
  "rate",
  "actMs",
  "firstAudioMs",
  "jevMs",
  "jevP",
  "earlyMs",
  "leadMs",
  "linesPerTick",
  "tickMs",
  "argsBytes",
  "resultBytes",
  "stderrBytes",
  "savedMs",
  "frameAgeMs",
  "waitedMs",
]);
/** Allow-listed keys that only ever carry a boolean. */
const flagFields = new Set([
  "interrupted",
  "merged",
  "speaking",
  "voiceProcessing",
  "interleaved",
  "fallback",
  "preempt",
  "stream",
  "restoredWindow",
  "jevUsed",
  "early",
  "verified",
  "sandboxed",
  "disclaimed",
  "pinned",
  "finish",
  "longRunning",
  // Unparseable arguments: how they begin and end; a reply's action repaired.
  "startsWithBrace",
  "endsWithBrace",
  "quotedAtEnd",
  "repaired",
]);
/**
 * Allow-listed keys that only ever carry a short fixed code. A numeric value
 * is dropped here: HTTP and exit statuses belong in httpStatus and exitCode.
 */
const codeFields = new Set([
  "plan",
  "mode",
  "openedKind",
  "kind",
  "priority",
  "engine",
  "voiceQuality",
  "window",
  "completeness",
  "patience",
  "endReason",
  "source",
  "phase",
  "code",
  "status",
  "route",
  "verdict",
  "tier",
  "device",
  "act",
  "channel",
  "change",
  "via",
  "jevAct",
  "jevCode",
  "settle",
  "direction",
  "server",
  "tool",
  "transport",
  "toolTier",
  "outcome",
  "questionKind",
  "approvalCode",
  "providerState",
  "answerTier",
  "project",
  // The JSON parser's complaint about model arguments, as a fixed code.
  "parseError",
]);
/**
 * The early step's own events keep only these keys, whatever else a caller
 * passes: a code, how the clause settled and timings, never a name.
 */
const earlyEvents = new Set(["EarlyStartExecuted", "EarlyStartEnded"]);
const earlyFields = new Set([
  "phase",
  "code",
  "settle",
  "earlyMs",
  "leadMs",
  "durationMs",
]);
/**
 * The first step prepared while the user spoke keeps only these keys: a
 * code, its kind, timings and what its request cost. Never the words.
 */
const speculationEvents = new Set([
  "SpeculationStarted",
  "SpeculationSkipped",
  "SpeculationAdopted",
  "SpeculationDiscarded",
]);
const speculationFields = new Set([
  "runId",
  "sequence",
  "synthetic",
  "code",
  "kind",
  "leadMs",
  "savedMs",
  "frameAgeMs",
  "usage",
]);
const memoryEvents = new Set([
  "MemoryRecalled",
  "PlanStepProposed",
  "PlanAbandoned",
  "PlanCompleted",
]);
/** The runner's tool events: hashed ids, codes, counts, sizes and flags only. */
const toolEvents = new Set([
  "ToolsListed",
  "ToolStepProposed",
  "ToolCallProposed",
  "ToolCallFinished",
  "ToolUndo",
]);
const code = (value: unknown) =>
  typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(value)
    ? value
    : undefined;
const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export class LocalDiagnostics {
  readonly file: string;
  private bytes = 0;
  private sequence = 0;
  private lastRun = "";
  private lastEvent = 0;
  private lastStatus = "";
  private warned = false;
  private lastFrame = "";
  private readonly frames: string;
  constructor(
    directory: string,
    private secrets: () => string[] = () => [],
    private output: (line: string) => void = (line) =>
      process.stdout.write(line),
    private maxBytes = 5 * 1024 * 1024,
    /**
     * Opt-in local debugging (COARENA_DIAGNOSTICS_VERBOSE=1): records spoken and
     * typed text, task text, full model actions, pill text, screen context and
     * screenshots. Provider keys are still redacted. Never enable by default.
     */
    readonly verbose = false,
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.frames = join(directory, "frames");
    this.file = join(directory, "current.jsonl");
    if (existsSync(this.file)) {
      chmodSync(this.file, 0o600);
      this.bytes = statSync(this.file).size;
    }
  }
  private cleanVerbose(value: unknown, depth = 0): unknown {
    if (depth > 7) return undefined;
    if (typeof value === "string") {
      if (/^data:image\//.test(value)) return "[image]";
      let text = value;
      for (const secret of this.secrets())
        if (secret) text = text.replaceAll(secret, "[REDACTED:key]");
      // Everything stays readable except credential-shaped spans (tokens,
      // private keys, password/OTP assignments) that were spoken, typed or seen.
      return redactSecrets(text, "[REDACTED:secret]").slice(0, 4000);
    }
    if (typeof value === "number")
      return Number.isFinite(value) ? value : undefined;
    if (typeof value === "boolean" || value === null) return value;
    if (Array.isArray(value))
      return value.slice(0, 80).map((v) => this.cleanVerbose(v, depth + 1));
    if (!value || typeof value !== "object") return undefined;
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [
        key,
        this.cleanVerbose(v, depth + 1),
      ]),
    );
  }
  private clean(value: unknown, depth = 0, field = ""): unknown {
    if (this.verbose) return this.cleanVerbose(value, depth);
    if (depth > 4) return undefined;
    // Counts, measurements and flags never carry text; codes never carry
    // free-form sentences.
    if (countFields.has(field) || numberFields.has(field)) return count(value);
    if (flagFields.has(field))
      return typeof value === "boolean" ? value : undefined;
    if (codeFields.has(field)) return code(value);
    if (typeof value === "string") {
      let text = value;
      for (const secret of this.secrets())
        if (secret) text = text.replaceAll(secret, "[REDACTED:key]");
      // An utterance id is an opaque token (normally a UUID), never a sentence.
      if (field === "utteranceId")
        return /^[A-Za-z0-9_-]{1,64}$/.test(text) && !scanText(text).length
          ? text
          : undefined;
      if (
        ["runId", "frameId", "requestId"].includes(field) &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
          text,
        )
      )
        return text;
      return sanitizeText(text).text.slice(0, 1200);
    }
    if (typeof value === "number")
      return Number.isFinite(value) ? value : undefined;
    if (typeof value === "boolean") return value;
    if (!value || typeof value !== "object" || Array.isArray(value))
      return undefined;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => fields.has(key))
        .map(([key, v]) => [key, this.clean(v, depth + 1, key)]),
    );
  }
  readonly write: DiagnosticSink = (event, data = {}) => {
    try {
      if (!/^[A-Za-z][A-Za-z0-9_.]{0,79}$/.test(event)) return;
      const line =
        JSON.stringify({
          timestamp: new Date().toISOString(),
          pid: process.pid,
          sequence: ++this.sequence,
          event,
          data: this.clean(
            earlyEvents.has(event) && !this.verbose
              ? Object.fromEntries(
                  Object.entries(data).filter(([key]) => earlyFields.has(key)),
                )
              : speculationEvents.has(event) && !this.verbose
                ? Object.fromEntries(
                    Object.entries(data).filter(([key]) =>
                      speculationFields.has(key),
                    ),
                  )
                : data,
          ),
        }) + "\n";
      if (this.bytes + Buffer.byteLength(line) > this.maxBytes) {
        rmSync(this.file + ".3", { force: true });
        for (let i = 2; i >= 0; i--) {
          const from = i ? this.file + "." + i : this.file;
          if (existsSync(from)) renameSync(from, this.file + "." + (i + 1));
        }
        this.bytes = 0;
      }
      appendFileSync(this.file, line, { mode: 0o600 });
      this.bytes += Buffer.byteLength(line);
      this.output(line);
    } catch {
      if (!this.warned) {
        this.warned = true;
        // A full disk or detached terminal must not stop the assistant.
        try {
          this.output('{"event":"DiagnosticWriteFailed"}\n');
        } catch {}
      }
    }
  };
  private saveFrame(s: Snapshot) {
    const frame = s.frame;
    if (!this.verbose || !s.run || !frame || frame.id === this.lastFrame)
      return;
    this.lastFrame = frame.id;
    try {
      const match = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(
        frame.image,
      );
      if (!match) return;
      mkdirSync(this.frames, { recursive: true, mode: 0o700 });
      const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${s.run.id.slice(0, 8)}-${frame.id.slice(0, 8)}.${match[1] === "jpeg" ? "jpg" : match[1]}`;
      writeFileSync(join(this.frames, name), Buffer.from(match[2], "base64"), {
        mode: 0o600,
      });
      // Keep the newest 300 screenshots.
      const files = readdirSync(this.frames).sort();
      for (const old of files.slice(0, Math.max(0, files.length - 300)))
        rmSync(join(this.frames, old), { force: true });
      this.write("FrameSaved", {
        runId: s.run.id,
        frameId: frame.id,
        file: join(this.frames, name),
        appId: frame.appId,
        context: frame.context,
      });
    } catch {
      /* Debug screenshots must never interrupt a run. */
    }
  }
  snapshot(s: Snapshot) {
    if (!s.run) return;
    this.saveFrame(s);
    if (this.lastRun !== s.run.id) {
      this.lastRun = s.run.id;
      this.lastEvent = 0;
      this.lastStatus = "";
    }
    for (const e of s.events) {
      if (e.sequence_number <= this.lastEvent) continue;
      this.lastEvent = e.sequence_number;
      const action = e.data.action as Record<string, unknown> | undefined;
      const launched = e.data.launched as Record<string, unknown> | undefined;
      const opened = e.data.opened as Record<string, unknown> | undefined;
      this.write(e.type, {
        runId: s.run.id,
        sequence: e.sequence_number,
        // Full event payload (action text, corrections, summaries); dropped by
        // the allow-list unless verbose debugging is on.
        data: e.data,
        code: e.data.code,
        // ActionFailed for STATE_CHANGED: which kind of change, as a code.
        change: e.data.change,
        // ActionExecuted for a hotkey: pressed as its menu item or as keys.
        via: e.data.via,
        // A step taken before the run existed, while the user was speaking.
        early: e.data.early,
        // The first step prepared while the user spoke, adopted or let go by
        // the run: its kind and timings (Speculation* events).
        ...(speculationEvents.has(e.type)
          ? {
              kind: code(e.data.kind),
              leadMs: count(e.data.leadMs),
              savedMs: count(e.data.savedMs),
              frameAgeMs: count(e.data.frameAgeMs),
            }
          : {}),
        // A tool question names the item it would add; the question stays in
        // the encrypted journal and only its kind is written here.
        reason: e.data.actionType === "tool_call" ? undefined : e.data.reason,
        questionKind: code(e.data.questionKind),
        approvalCode: code(e.data.approvalCode),
        usage: e.data.usage,
        screenshot: e.data.screenshot,
        screenshotReason: e.data.screenshotReason,
        frameId: e.data.frame_id,
        geometry: e.data.geometry,
        synthetic: s.run.synthetic,
        actionType: e.data.actionType,
        appId: e.data.appId,
        targetRole: e.data.targetRole,
        focusedRole: e.data.focusedRole,
        launcherStatus: e.data.launcherStatus,
        normalized: e.data.normalized,
        // The cycle length of a repeated action; ActionLoopDetected carries no
        // content, and a REFUSED failure is logged by its code alone.
        period: e.data.period,
        // TaskAmended records only the new task's length, never its text.
        taskLength: count(e.data.taskLength),
        // Only the fixed, content-free problem description of a malformed reply.
        problem:
          e.data.code === "MALFORMED_RESPONSE" ? e.data.problem : undefined,
        // Memory recall and replay plans: counts, positions and fixed codes.
        // Preference, episode, skill and file text or paths never appear.
        ...(memoryEvents.has(e.type)
          ? {
              preferences: count(e.data.preferences),
              episodes: count(e.data.episodes),
              apps: count(e.data.apps),
              files: count(e.data.files),
              folders: count(e.data.folders),
              skills: count(e.data.skills),
              index: count(e.data.index),
              plan: code(e.data.plan),
              mode: code(e.data.mode),
              source: code(e.data.source),
              reason: code(e.data.reason),
            }
          : {}),
        ...(toolEvents.has(e.type)
          ? {
              tool: code(e.data.tool),
              server: code(e.data.server),
              toolTier: code(e.data.toolTier),
              outcome: code(e.data.outcome),
              source: code(e.data.source),
              toolCount: count(e.data.toolCount),
              unavailableCount: count(e.data.unavailableCount),
              entityCount: count(e.data.entityCount),
              argsBytes: count(e.data.argsBytes),
              resultBytes: count(e.data.resultBytes),
              resultItems: count(e.data.resultItems),
              durationMs: count(e.data.durationMs),
              verified: e.data.verified,
              finish: e.data.finish,
              longRunning: e.data.longRunning,
            }
          : {}),
        // App names are user metadata; only the bundle id and flags are logged.
        ...(e.type === "ActionExecuted" && launched
          ? {
              launchedAppId: launched.appId,
              frontmost: launched.frontmost,
              wasRunning: launched.wasRunning,
              // A count and a flag: whether a running app came up windowless.
              launchedWindows: launched.windows,
              restoredWindow: launched.restoredWindow,
            }
          : {}),
        // An opened file is logged by kind and handling app, never its path.
        ...(e.type === "ActionExecuted" && opened
          ? { openedKind: code(opened.kind), openedAppId: opened.appId }
          : {}),
        ...(action
          ? {
              actionType: action.type,
              x: action.x,
              y: action.y,
              start_x: action.start_x,
              start_y: action.start_y,
              end_x: action.end_x,
              end_y: action.end_y,
              delta_x: action.delta_x,
              delta_y: action.delta_y,
              textLength:
                typeof action.text === "string"
                  ? action.text.length
                  : undefined,
              nameLength:
                action.type === "open_app" && typeof action.name === "string"
                  ? action.name.length
                  : undefined,
              // The model's note is a value it read on screen: its length only.
              noteLength:
                typeof action.note === "string"
                  ? action.note.length
                  : undefined,
            }
          : {}),
      });
    }
    if (this.lastStatus !== s.run.status) {
      this.lastStatus = s.run.status;
      this.write("RunState", {
        runId: s.run.id,
        status: s.run.status,
        provider: s.run.provider,
        model: s.run.model,
        actions: s.run.actions,
        frames: s.run.frames,
        usage: s.run.usage,
        taskLength: s.run.task.length,
        appId: s.frame?.appId,
        toolCalls: count(s.run.tools?.calls),
        toolWrites: count(s.run.tools?.writes),
        // Verbose-only fields (not in the allow-list).
        task: s.run.task,
        message: s.message,
        summary: s.run.summary,
        corrections: s.run.corrections,
        pending: s.pending,
        // A failed run's message can quote a tool result or the screen, so it
        // is written only for opt-in debugging; RunFailed carries the code.
        ...(s.run.status === "failed" && this.verbose
          ? { error: s.message }
          : {}),
      });
    }
  }
}
