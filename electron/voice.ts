import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import {
  errorDetails,
  trace,
  type DiagnosticSink,
} from "../src/core/diagnostics";
export interface VoiceEvent {
  event: string;
  text?: string;
  message?: string;
  confidence?: number;
  level?: number;
  command?: string;
  enabled?: boolean;
  listening?: boolean;
  textLength?: number;
  source?: string;
}
export class NativeVoice {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<
    string,
    {
      resolve: (data: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    binary: string,
    receive: (event: VoiceEvent) => void,
    private diagnostics?: DiagnosticSink,
  ) {
    this.child = spawn(binary, [], { stdio: "pipe" });
    this.child.stderr.resume();
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      try {
        const data = JSON.parse(line);
        if (data.event) {
          receive(data);
          return;
        }
        const item = this.pending.get(data.id);
        if (!item) return;
        clearTimeout(item.timer);
        this.pending.delete(data.id);
        data.error
          ? item.reject(new Error(data.error))
          : item.resolve(data.result);
      } catch {}
    });
    const fail = () => {
      trace(this.diagnostics, "VoiceUnavailable");
      for (const item of this.pending.values()) {
        clearTimeout(item.timer);
        item.reject(new Error("Voice helper is unavailable."));
      }
      this.pending.clear();
    };
    this.child.on("exit", fail);
    this.child.on("error", fail);
  }
  call(method: string, data: Record<string, unknown> = {}): Promise<any> {
    if (this.child.killed || this.child.exitCode !== null)
      return Promise.reject(new Error("Voice helper is unavailable."));
    const id = crypto.randomUUID();
    const started = performance.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(new Error("Voice setup is waiting for macOS permission."));
        },
        method === "requestPermissions" ? 120000 : 5000,
      );
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, ...data }) + "\n");
    }).then(
      (result) => {
        trace(this.diagnostics, "VoiceResponse", {
          requestId: id,
          method,
          durationMs: Math.round(performance.now() - started),
        });
        return result;
      },
      (error) => {
        trace(this.diagnostics, "VoiceError", {
          requestId: id,
          method,
          durationMs: Math.round(performance.now() - started),
          ...errorDetails(error),
        });
        throw error;
      },
    );
  }
  close() {
    this.child.kill();
  }
}
