import type { Bridge } from "./api";
import {
  defaultSettings,
  type Frame,
  type JournalEvent,
  type Recorder,
  type Run,
  type Snapshot,
} from "../core/schema";
import { Runner, terminal } from "../core/runner";
import { TutorialController, TutorialProvider } from "../core/tutorial";
import { prepareBundle } from "../contribution/bundle";
import { idlePill, voiceIntent, type PillState } from "../voice/router";
export function previewBridge(): Bridge {
  let settings = structuredClone(defaultSettings),
    pill = { ...idlePill };
  const runs = new Map<string, Run>(),
    events = new Map<string, JournalEvent[]>(),
    frames = new Map<string, Frame[]>();
  const listeners = new Set<(s: Snapshot) => void>(),
    pillListeners = new Set<(s: PillState) => void>(),
    viewListeners = new Set<(s: string) => void>();
  let runner: Runner | undefined;
  const update = (s: Partial<PillState>) => {
    pill = { ...pill, ...s };
    pillListeners.forEach((fn) => fn(pill));
  };
  const recorder: Recorder = {
    begin: (r) => {
      runs.set(r.id, structuredClone(r));
      events.set(r.id, []);
      frames.set(r.id, []);
    },
    save: (r) => runs.set(r.id, structuredClone(r)),
    append: (id, type, data = {}) => {
      const list = events.get(id)!;
      const e: JournalEvent = {
        event_id: crypto.randomUUID(),
        run_id: id,
        sequence_number: list.length + 1,
        monotonic_timestamp: performance.now(),
        wall_clock_timestamp: new Date().toISOString(),
        schema_version: 1,
        type,
        data,
      };
      list.push(e);
      return e;
    },
    frame: (id, frame) => {
      if (!frames.get(id)!.some((f) => f.sha256 === frame.sha256))
        frames.get(id)!.push(frame);
    },
  };
  const bridge: Bridge = {
    info: async () => ({
      desktop: false,
      platform: "browser",
      settings,
      hasKey: false,
      permissions: { screen: false, accessibility: false, supported: false },
      displays: [],
      encrypted: false,
      voice: {
        microphone: false,
        speech: false,
        onDevice: false,
        shortcut: false,
        locale: "",
        handsFree: false,
        wakeListening: false,
      },
    }),
    saveSettings: async (s) => {
      settings = s;
    },
    start: async (task, tutorial) => {
      if (!tutorial)
        throw new Error("Open the macOS app to use your computer.");
      if (runner && !runner.settled)
        throw new Error("A run is already active.");
      runner = new Runner(
        new TutorialController(),
        new TutorialProvider(1000),
        recorder,
        settings,
        (s) => {
          listeners.forEach((f) => f(s));
          const status = s.run?.status;
          update({
            phase:
              status === "completed" || status === "cancelled"
                ? "done"
                : status === "paused" || status === "takeover"
                  ? "paused"
                  : status === "failed"
                    ? "error"
                    : status === "confirming"
                      ? "approval"
                      : "working",
            label:
              status === "completed"
                ? "Done."
                : status === "cancelled"
                  ? "Stopped."
                  : status === "paused"
                    ? "Paused."
                    : status === "failed"
                      ? s.message
                      : "Working…",
            transcript: "",
            synthetic: true,
            canApprove: status === "confirming",
          });
        },
      );
      void runner.start(task);
    },
    pause: async () => runner?.pause(),
    resume: async () => runner?.resume(),
    stop: async () => runner?.stop(),
    confirm: async (yes) => runner?.approveFromVoice(yes),
    openCommand: async () => {
      runner?.interruptForVoice();
      update({
        phase: "text",
        label: "Type a command",
        transcript: "",
        canApprove: false,
      });
    },
    command: async (text) => {
      const i = voiceIntent(text);
      if (i.kind === "stop") {
        runner?.stop();
        return;
      }
      if (i.kind === "pause") {
        runner?.pause();
        return;
      }
      if (i.kind === "resume") {
        await runner?.resume();
        return;
      }
      if (i.kind === "approve" || i.kind === "decline") {
        await runner?.approveFromVoice(i.kind === "approve");
        return;
      }
      if (runner?.snapshot.run && !terminal(runner.snapshot.run.status))
        await runner.revise(text);
      else
        throw new Error(
          "Open the macOS app for real tasks. Try the safe tutorial here.",
        );
    },
    history: async () => [...runs.values()].reverse(),
    loadRun: async (id) => ({
      run: runs.get(id)!,
      frame: frames.get(id)?.at(-1) ?? null,
      events: events.get(id) ?? [],
      message: runs.get(id)?.summary ?? "",
    }),
    deleteRun: async (id) => {
      runs.delete(id);
      events.delete(id);
      frames.delete(id);
    },
    feedback: async (id, success) => {
      runs.get(id)!.outcome = success;
    },
    review: async (id, opts) => {
      const run = runs.get(id)!,
        e = events.get(id)!,
        f = frames.get(id)!;
      return {
        run,
        events: e,
        frames: f,
        bundle: prepareBundle(run, e, f, {
          runId: id,
          level: "trajectory",
          excludedEvents: [],
          excludedFrames: [],
          ...opts,
        }),
        uploaded: false,
      };
    },
    donate: async () => {
      throw new Error(
        "Contributions are available in the desktop app. Nothing leaves this browser preview.",
      );
    },
    withdraw: async () => {},
    exportWorkflow: async () => {
      throw new Error(
        "Use the desktop application for approved workflow export.",
      );
    },
    permissions: async () => {
      throw new Error(
        "Open the macOS app to grant screen and control permissions.",
      );
    },
    voicePermissions: async () => {
      throw new Error(
        "On-device transcription is available in the macOS app. This preview never records audio.",
      );
    },
    pillState: async () => pill,
    dismiss: async () => update(idlePill),
    openSettings: async (section = "settings") =>
      viewListeners.forEach((fn) => fn(section)),
    closeSettings: async () => viewListeners.forEach((fn) => fn("")),
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    subscribePill: (fn) => {
      pillListeners.add(fn);
      return () => pillListeners.delete(fn);
    },
    subscribeView: (fn) => {
      viewListeners.add(fn);
      return () => viewListeners.delete(fn);
    },
  };
  return bridge;
}
