import type {
  Action,
  Controller,
  Frame,
  Provider,
  Recorder,
  Run,
  RunStatus,
  Settings,
  Snapshot,
  ScreenContext,
  Observation,
} from "./schema";
import { validateAction, sameGeometry } from "./schema";
import { evaluate, surfacePolicy } from "./policy";
import { sanitizeText, scanText } from "./sanitize";
import { ScreenChangedError } from "./errors";
export const terminal = (s: RunStatus) =>
  ["completed", "cancelled", "failed"].includes(s);
export class Runner {
  settled = true;
  snapshot: Snapshot = {
    run: null,
    frame: null,
    events: [],
    message: "Ready when you are.",
  };
  private abort = new AbortController();
  private held = false;
  private wake?: () => void;
  private approval?: (yes: boolean) => void;
  private started = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private blocks = 0;
  private epoch = 0;
  private voiceApproval = false;
  constructor(
    private controller: Controller,
    private provider: Provider,
    private recorder: Recorder,
    private settings: Settings,
    private emit: (s: Snapshot) => void,
    private recentTasks: ScreenContext["recentTasks"] = [],
  ) {}
  private publish() {
    this.emit(structuredClone(this.snapshot));
  }
  private event(type: string, data: Record<string, unknown> = {}) {
    const e = this.recorder.append(this.snapshot.run!.id, type, data);
    this.snapshot.events.push(e);
    this.publish();
  }
  private status(status: RunStatus, message?: string) {
    if (!this.snapshot.run) return;
    this.snapshot.run.status = status;
    if (message) this.snapshot.message = message;
    this.recorder.save(this.snapshot.run);
    this.publish();
  }
  private active() {
    return !!this.snapshot.run && !terminal(this.snapshot.run.status);
  }
  private check() {
    if (!this.active()) throw new Error("STOPPED");
    if (Date.now() - this.started >= this.settings.maxSeconds * 1000)
      throw new Error("Runtime budget reached.");
    if (this.snapshot.run!.actions >= this.settings.maxActions)
      throw new Error("Action budget reached.");
    if (this.snapshot.run!.usage.cost >= this.settings.maxCost)
      throw new Error("Estimated cost budget reached.");
  }
  private async ready() {
    while (this.held && this.active())
      await new Promise<void>((r) => (this.wake = r));
    this.check();
  }
  pause(message = "Paused. Capture and input are stopped.") {
    if (!this.active()) return;
    this.epoch++;
    this.held = true;
    this.abort.abort();
    this.controller.stop();
    this.approval?.(false);
    this.snapshot.pending = undefined;
    this.event("RunPaused");
    this.status("paused", message);
  }
  manualTakeover() {
    if (this.snapshot.pending && this.snapshot.run?.status === "confirming") {
      this.interruptForVoice();
      return;
    }
    if (!this.active()) return;
    this.pause("Paused — you’re controlling the computer.");
    this.event("UserTakeoverStarted", { source: "manual_input" });
  }
  stop(reason = "Stopped by you.") {
    if (!this.active()) return;
    this.abort.abort();
    this.controller.stop();
    this.held = false;
    this.wake?.();
    this.approval?.(false);
    this.snapshot.pending = undefined;
    clearTimeout(this.timer);
    this.event("RunCancelled");
    this.status("cancelled", reason);
  }
  async resume() {
    if (!this.active() || !this.held) return;
    await this.controller.resume();
    this.held = false;
    this.abort = new AbortController();
    this.event("UserTakeoverEnded");
    this.status("capturing", "Resuming with a fresh screenshot.");
    this.wake?.();
  }
  confirm(yes: boolean) {
    this.approval?.(yes);
    this.approval = undefined;
  }
  interruptForVoice() {
    if (!this.active()) return;
    if (this.snapshot.pending && this.snapshot.run?.status === "confirming") {
      this.voiceApproval = true;
      this.controller.stop();
      return;
    }
    this.pause();
  }
  async approveFromVoice(yes: boolean) {
    if (!this.snapshot.pending || this.snapshot.run?.status !== "confirming")
      throw new Error("Nothing to approve.");
    if (!yes) {
      this.voiceApproval = false;
      this.pause();
      return;
    }
    if (this.voiceApproval) {
      await this.controller.resume();
      this.voiceApproval = false;
    }
    this.confirm(yes);
  }
  async revise(text: string) {
    if (!this.active()) throw new Error("No active run.");
    text = text.trim();
    if (!text || text.length > 2000)
      throw new Error("Keep the correction under 2,000 characters.");
    if (scanText(text).some((f) => f.action === "BLOCK_UPLOAD"))
      throw new Error("Enter credentials yourself.");
    if (!this.held) this.pause();
    const correction = {
      text,
      after_action: this.snapshot.run!.actions,
      timestamp: new Date().toISOString(),
    };
    (this.snapshot.run!.corrections ??= []).push(correction);
    this.event("UserCorrectionRecorded", correction);
    this.recorder.save(this.snapshot.run!);
    await this.resume();
  }
  private takeover(reason: string) {
    this.held = true;
    this.controller.stop();
    this.snapshot.frame = null;
    this.event("UserTakeoverStarted");
    this.status("takeover", reason);
  }
  private async capture() {
    const surface = await this.controller.surface();
    const decision = surfacePolicy(surface, this.settings);
    if (decision.kind !== "ALLOW") {
      this.takeover(decision.reason);
      return null;
    }
    const frame = await this.controller.capture();
    return this.recordFrame(frame);
  }
  private recordFrame(frame: Frame) {
    this.check();
    if (this.held) return null;
    if (frame.context) frame.context.recentTasks = this.recentTasks;
    this.snapshot.frame = frame;
    this.snapshot.run!.frames++;
    this.recorder.frame(this.snapshot.run!.id, frame);
    this.event("FrameCaptured", {
      frame_id: frame.id,
      sha256: frame.sha256,
      geometry: frame.geometry,
    });
    return frame;
  }
  async start(task: string) {
    if (this.active()) throw new Error("A run is already active.");
    this.settled = false;
    this.started = Date.now();
    this.abort = new AbortController();
    this.held = false;
    this.blocks = 0;
    const run: Run = {
      id: crypto.randomUUID(),
      task,
      createdAt: new Date().toISOString(),
      status: "capturing",
      privacy: this.settings.privacy,
      provider:
        this.controller.kind === "tutorial"
          ? "tutorial"
          : this.settings.provider,
      model:
        this.controller.kind === "tutorial"
          ? "Scripted tutorial"
          : this.settings.model,
      synthetic: this.controller.kind === "tutorial",
      actions: 0,
      frames: 0,
      usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
      summary: "",
    };
    this.snapshot = {
      run,
      frame: null,
      events: [],
      message: "Starting a private run.",
    };
    this.recorder.begin(run);
    this.event("RunStarted", {
      privacy: run.privacy,
      synthetic: run.synthetic,
    });
    this.timer = setTimeout(() => {
      if (this.active()) {
        this.stop("Runtime budget reached.");
      }
    }, this.settings.maxSeconds * 1000);
    const history: Observation["history"] = [];
    let stateChanges = 0;
    let targetingRetries = 0;
    const recoverStateChange = (error: unknown) => {
      if (!(error instanceof ScreenChangedError)) return false;
      this.event("ActionFailed", { code: "STATE_CHANGED" });
      history.push({
        type: "rejected",
        result:
          "No input was sent. The target or window changed; choose an action from the new screenshot. Any earlier approval has expired.",
      });
      if (++stateChanges >= 3) {
        stateChanges = 0;
        this.pause(
          "The target keeps changing. Wait for it to settle, then continue.",
        );
      }
      return true;
    };
    try {
      await this.controller.resume();
      while (this.active()) {
        await this.ready();
        const epoch = this.epoch;
        this.status("capturing", "Seeing the selected surface.");
        let frame: Frame | null;
        try {
          frame = await this.capture();
        } catch (error) {
          if (this.held || epoch !== this.epoch) continue;
          if (recoverStateChange(error)) continue;
          throw error;
        }
        if (!frame || epoch !== this.epoch) continue;
        this.abort = new AbortController();
        this.status("thinking", "Choosing the next action.");
        this.event("ModelRequestStarted");
        let result;
        try {
          result = await this.provider.next(
            {
              task:
                task +
                (run.corrections?.length
                  ? "\nUser corrections, in order. Preserve earlier constraints unless explicitly superseded:\n" +
                    run.corrections.map((c) => c.text).join("\n")
                  : ""),
              frame,
              history: history.slice(-12),
            },
            this.abort.signal,
          );
        } catch (e) {
          if (this.held || epoch !== this.epoch) continue;
          throw e;
        }
        if (this.held || epoch !== this.epoch) continue;
        this.check();
        for (const k of ["inputTokens", "outputTokens", "cost"] as const) {
          if (!Number.isFinite(result.usage[k]) || result.usage[k] < 0)
            throw new Error("Invalid usage accounting.");
          run.usage[k] += result.usage[k];
        }
        this.event("ModelResponseReceived", { usage: result.usage });
        this.check();
        let action: Action;
        try {
          action = validateAction(result.action, frame);
        } catch {
          this.event("ActionFailed", { code: "INVALID_ACTION" });
          history.push({
            type: "rejected",
            result: `No input was executed. Return one action with the current frame_id. All x/y coordinates must be fractions from 0 to 1, never pixels: divide pixel x by ${frame.geometry.model_width} and pixel y by ${frame.geometry.model_height}.`,
          });
          if (++this.blocks >= 3) throw new Error("Repeated invalid actions.");
          continue;
        }
        // Never journal sensitive model-proposed text before the policy boundary.
        const actionSurface = await this.controller.surface(action);
        const decision = evaluate(
          action,
          actionSurface,
          this.settings,
          run.synthetic,
        );
        if (this.held || epoch !== this.epoch) continue;
        if (decision.kind === "RETRY") {
          this.event("ActionRetargetRequested", {
            actionType: action.type,
            appId: actionSurface.appId,
            targetRole: actionSurface.targetRole,
            focusedRole: actionSurface.focusedRole,
          });
          history.push({ type: action.type, result: decision.reason });
          if (++targetingRetries >= 3) {
            targetingRetries = 0;
            this.takeover(
              "I can’t identify the control. Open the target app or field, then say continue.",
            );
          }
          continue;
        }
        if (decision.kind === "DENY") {
          this.event("UserDenied", { reason: decision.reason });
          history.push({ type: action.type, result: decision.reason });
          if (++this.blocks >= 3)
            throw new Error("Repeated policy violations.");
          continue;
        }
        if (decision.kind === "USER_TAKEOVER") {
          this.takeover(decision.reason);
          continue;
        }
        if (action.type === "done")
          action = { ...action, summary: sanitizeText(action.summary).text };
        if (action.type === "fail")
          action = { ...action, reason: sanitizeText(action.reason).text };
        this.event("ActionProposed", { action });
        let executionFrame = frame;
        if (decision.kind === "CONFIRM") {
          this.snapshot.pending = { action, reason: decision.reason };
          this.status("confirming", decision.reason);
          this.event("PolicyConfirmationRequested", {
            reason: decision.reason,
            actionType: action.type,
            appId: actionSurface.appId,
            targetRole: actionSurface.targetRole,
            focusedRole: actionSurface.focusedRole,
          });
          const allowed = await new Promise<boolean>(
            (resolve) => (this.approval = resolve),
          );
          this.approval = undefined;
          this.snapshot.pending = undefined;
          if (!this.active()) break;
          if (this.held || epoch !== this.epoch) continue;
          if (!allowed) {
            this.event("UserDenied");
            history.push({
              type: action.type,
              result:
                "User declined. Choose a different action or request_user.",
            });
            if (++this.blocks >= 3)
              throw new Error("Repeated declined actions.");
            continue;
          }
          this.event("UserConfirmed");
          await this.controller.restore?.(frame);
          await this.ready();
          let fresh: Frame | null;
          try {
            fresh = this.controller.revalidate
              ? this.recordFrame(
                  await this.controller.revalidate(action, frame),
                )
              : await this.capture();
          } catch (error) {
            if (this.held || epoch !== this.epoch) continue;
            if (recoverStateChange(error)) continue;
            throw error;
          }
          if (!fresh) continue;
          if (
            (!this.controller.revalidate && fresh.sha256 !== frame.sha256) ||
            !sameGeometry(fresh.geometry, frame.geometry) ||
            fresh.appId !== frame.appId
          ) {
            recoverStateChange(new ScreenChangedError());
            continue;
          }
          executionFrame = fresh;
          action = { ...action, frame_id: fresh.id };
        }
        this.check();
        if (this.held || epoch !== this.epoch) continue;
        if (action.type === "done") {
          run.summary = action.summary;
          this.event("RunCompleted");
          this.status("completed", action.summary);
          break;
        }
        if (action.type === "fail") throw new Error(action.reason);
        this.event("PolicyAllowed", { reason: decision.reason });
        this.status(
          "executing",
          `Executing ${action.type.replaceAll("_", " ")}.`,
        );
        try {
          await this.controller.execute(
            action,
            executionFrame,
            this.abort.signal,
          );
        } catch (e) {
          if (this.held || epoch !== this.epoch) continue;
          if (!this.active()) break;
          if (recoverStateChange(e)) continue;
          throw e;
        }
        if (!this.active()) break;
        if (this.held) continue;
        stateChanges = 0;
        targetingRetries = 0;
        this.blocks = 0;
        run.actions++;
        this.event("ActionExecuted", { action, frame_id: executionFrame.id });
        const { frame_id: _frameId, ...executedAction } = action;
        history.push({
          type: action.type,
          action: executedAction,
          result: "Executed. Verify the next screenshot.",
        });
      }
    } catch (e) {
      if (this.active()) {
        const message = e instanceof Error ? e.message : "Run failed.";
        run.summary = message;
        this.event("RunFailed", { code: "RUN_ERROR" });
        this.status("failed", message);
      }
    } finally {
      clearTimeout(this.timer);
      this.controller.stop();
      this.settled = true;
      this.recorder.save(run);
      this.publish();
    }
  }
}
