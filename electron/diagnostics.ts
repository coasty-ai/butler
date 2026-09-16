import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { sanitizeText } from "../src/core/sanitize";
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
  "cost",
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
]);

export class LocalDiagnostics {
  readonly file: string;
  private bytes = 0;
  private sequence = 0;
  private lastRun = "";
  private lastEvent = 0;
  private lastStatus = "";
  private warned = false;
  constructor(
    directory: string,
    private secrets: () => string[] = () => [],
    private output: (line: string) => void = (line) =>
      process.stdout.write(line),
    private maxBytes = 5 * 1024 * 1024,
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.file = join(directory, "current.jsonl");
    if (existsSync(this.file)) {
      chmodSync(this.file, 0o600);
      this.bytes = statSync(this.file).size;
    }
  }
  private clean(value: unknown, depth = 0, field = ""): unknown {
    if (depth > 4) return undefined;
    if (typeof value === "string") {
      let text = value;
      for (const secret of this.secrets())
        if (secret) text = text.replaceAll(secret, "[REDACTED:key]");
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
          data: this.clean(data),
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
  snapshot(s: Snapshot) {
    if (!s.run) return;
    if (this.lastRun !== s.run.id) {
      this.lastRun = s.run.id;
      this.lastEvent = 0;
      this.lastStatus = "";
    }
    for (const e of s.events) {
      if (e.sequence_number <= this.lastEvent) continue;
      this.lastEvent = e.sequence_number;
      const action = e.data.action as Record<string, unknown> | undefined;
      this.write(e.type, {
        runId: s.run.id,
        sequence: e.sequence_number,
        code: e.data.code,
        reason: e.data.reason,
        usage: e.data.usage,
        frameId: e.data.frame_id,
        geometry: e.data.geometry,
        synthetic: s.run.synthetic,
        actionType: e.data.actionType,
        appId: e.data.appId,
        targetRole: e.data.targetRole,
        focusedRole: e.data.focusedRole,
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
        ...(s.run.status === "failed" ? { error: s.message } : {}),
      });
    }
  }
}
