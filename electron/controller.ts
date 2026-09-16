import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { cleanScreenContext } from "../src/core/context";
import { ScreenChangedError } from "../src/core/errors";
import {
  errorDetails,
  trace,
  type DiagnosticSink,
} from "../src/core/diagnostics";
import type {
  Action,
  Controller,
  Frame,
  Settings,
  Surface,
} from "../src/core/schema";
export class NativeController implements Controller {
  kind = "native" as const;
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<
    string,
    {
      resolve: (x: any) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    binary: string,
    private emergency: () => void,
    private manualInput: () => void = () => {},
    private diagnostics?: DiagnosticSink,
  ) {
    this.child = spawn(binary, [], { stdio: "pipe" });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      try {
        const obj = JSON.parse(line);
        if (obj.event === "input_forwarded") {
          trace(this.diagnostics, "NativeInputForwarded", {
            source: obj.source,
          });
          return;
        }
        if (obj.event === "emergency_stop") {
          trace(this.diagnostics, "NativeEmergencyStop");
          this.emergency();
          return;
        }
        if (obj.event === "user_takeover") {
          trace(this.diagnostics, "NativeUserTakeover", {
            source: obj.source,
            delta_x: obj.delta_x,
            delta_y: obj.delta_y,
            sourcePid: obj.sourcePid,
            eventType: obj.eventType,
            flags: obj.flags,
            pointerDistance: obj.pointerDistance,
          });
          this.manualInput();
          return;
        }
        const p = this.pending.get(obj.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(obj.id);
        obj.error
          ? p.reject(
              obj.code === "STATE_CHANGED"
                ? new ScreenChangedError(obj.error)
                : new Error(obj.error),
            )
          : p.resolve(obj.result);
      } catch {
        /* No untrusted native output enters logs */
      }
    });
    this.child.on("error", () => this.fail());
    this.child.on("exit", () => this.fail());
    this.child.stderr.resume();
  }
  private fail() {
    trace(this.diagnostics, "NativeUnavailable");
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(
        new Error("Native controller unavailable. Run npm run build:native."),
      );
    }
    this.pending.clear();
    this.emergency();
  }
  request(method: string, data: Record<string, unknown> = {}): Promise<any> {
    if (this.child.exitCode !== null || this.child.killed)
      return Promise.reject(new Error("Native controller is not running."));
    const id = crypto.randomUUID();
    const started = performance.now();
    trace(this.diagnostics, "NativeRequest", { requestId: id, method });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.stop();
        reject(new Error("Native controller timed out. Input stopped."));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, ...data }) + "\n");
    }).then(
      (result) => {
        trace(this.diagnostics, "NativeResponse", {
          requestId: id,
          method,
          durationMs: Math.round(performance.now() - started),
        });
        return result;
      },
      (error) => {
        trace(this.diagnostics, "NativeError", {
          requestId: id,
          method,
          durationMs: Math.round(performance.now() - started),
          ...errorDetails(error),
        });
        throw error;
      },
    );
  }
  async configure(s: Settings) {
    await this.request("configure", {
      protectedApps: s.protectedApps,
      protectedDomains: s.protectedDomains,
      ...(s.displayId ? { displayId: s.displayId } : {}),
    });
  }
  surface(action?: Action): Promise<Surface> {
    return this.request("surface", action ? { action } : {});
  }
  get pid() {
    return this.child.pid;
  }
  async capture(): Promise<Frame> {
    const frame: Frame = await this.request("capture");
    frame.context = cleanScreenContext(frame.context);
    return frame;
  }
  async execute(action: Action, _frame: Frame, signal: AbortSignal) {
    signal.throwIfAborted();
    const stop = () => this.stop();
    signal.addEventListener("abort", stop, { once: true });
    try {
      await this.request("execute", { action });
    } finally {
      signal.removeEventListener("abort", stop);
    }
  }
  async revalidate(action: Action, _frame: Frame): Promise<Frame> {
    const frame: Frame = await this.request("revalidate", { action });
    frame.context = cleanScreenContext(frame.context);
    return frame;
  }
  stop() {
    // ChildProcess.kill marks `killed` even for a nonterminating signal.
    // Keep the helper reusable after a voice interruption.
    if (this.child.pid && this.child.exitCode === null) {
      try {
        process.kill(this.child.pid, "SIGUSR1");
      } catch {}
    }
  }
  async resume() {
    await this.request("resume");
  }
  async restore() {
    await this.request("restore");
  }
  close() {
    this.stop();
    this.child.kill();
  }
}
