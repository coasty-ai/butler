import type {
  Bridge,
  KokoroUiStatus,
  MessagesInfo,
  RemoteStatus,
  SetupStatus,
  ToolsStatus,
} from "./api";
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
import { PORTS } from "../modules/contracts";
import type { ModulesStatus } from "../modules/registry";
import { RECIPES } from "../voice/recipes";
/** The browser preview never downloads models or plays audio. */
const kokoroUnsupported: KokoroUiStatus = {
  supported: false,
  installed: false,
  downloading: false,
  progress: 0,
  bytes: 0,
  totalBytes: 0,
};
const kokoroMessage =
  "The natural voice downloads in the macOS app. This preview never downloads voices.";
/** The browser preview never reads or sends messages. */
const messagesUnavailable = {
  enabled: false,
  configured: false,
  commands: false,
  updates: "texted",
  automation: "unavailable",
  database: "off",
  listening: false,
} satisfies MessagesInfo;
const messagesMessage =
  "Text updates come from the macOS app. This preview never reads or sends messages.";
/** The browser preview starts no server and asks macOS for nothing. */
const toolsUnavailable: ToolsStatus = {
  apple: {
    state: "needs_install",
    code: "preview",
    access: {
      calendar: "unknown",
      reminders: "unknown",
      notes: "unknown",
      mail: "unknown",
    },
  },
  servers: [],
};
const toolsMessage =
  "Tools connect in the macOS app. This preview starts no server.";
/** The browser preview never listens on a network. */
const remoteUnavailable: RemoteStatus = {
  enabled: false,
  state: "off",
  reason: "The phone remote runs in the macOS app. This preview never listens.",
  tailscale: "none",
  https: false,
  devices: [],
  connected: [],
  locked: false,
};
/**
 * The browser preview detects nothing: no permission read, no Ollama probe and
 * no provider request. tests/e2e/app.spec.ts asserts that no request ever
 * leaves 127.0.0.1:5173, and a live probe here would break it.
 */
const setupUnavailable: SetupStatus = {
  supported: false,
  screen: false,
  screenNeedsRelaunch: false,
  accessibility: false,
  microphone: false,
  speech: false,
  onDevice: false,
  locale: "",
  shortcut: false,
  model: {
    kind: "none",
    ready: false,
    detail: "Open the macOS app to choose a model.",
  },
  kokoro: { ...kokoroUnsupported },
  complete: true,
};
const setupMessage =
  "First-run setup happens in the macOS app. This preview grants no permissions and contacts no provider.";
export function previewBridge(): Bridge {
  let settings = structuredClone(defaultSettings),
    pill = { ...idlePill },
    runPill: Partial<PillState> = idlePill,
    // Journal position when a text-entry tap paused a working run; only
    // dismissing that untouched pill gives the run back.
    textHold: number | undefined;
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
  const lastSequence = () =>
    runner?.snapshot.events.at(-1)?.sequence_number ?? 0;
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
        speaking: false,
        voiceProcessing: false,
        voiceQuality: "none",
        voiceName: "",
        cloudVoiceAllowed: false,
        kokoro: { ...kokoroUnsupported },
      },
      messages: { ...messagesUnavailable },
      tools: structuredClone(toolsUnavailable),
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
          const approval = status === "confirming" && !!s.pending;
          runPill = {
            phase:
              status === "completed" || status === "cancelled"
                ? "done"
                : status === "paused" || status === "takeover"
                  ? "paused"
                  : status === "failed"
                    ? "error"
                    : approval
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
            transcript:
              status === "paused" || status === "takeover"
                ? "Hold ⌥ Space to continue."
                : "",
            synthetic: true,
            canApprove: approval,
          };
          update(runPill);
        },
      );
      void runner.start(task);
    },
    pause: async () => runner?.pause(),
    resume: async () => {
      await runner?.resume();
    },
    stop: async () => runner?.stop(),
    confirm: async (yes) => runner?.approveFromVoice(yes),
    openCommand: async () => {
      const before = runner?.snapshot.run?.status;
      runner?.interruptForVoice();
      textHold =
        before &&
        !terminal(before) &&
        !["paused", "takeover", "confirming"].includes(before) &&
        runner?.snapshot.run?.status === "paused"
          ? lastSequence()
          : undefined;
      update({
        phase: "text",
        label: "Type a command",
        transcript: "",
        canApprove: false,
      });
    },
    command: async (text) => {
      textHold = undefined;
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
        const status = runner?.snapshot.run?.status;
        if (
          !runner?.snapshot.pending &&
          (status === "paused" || status === "takeover")
        ) {
          // A "yes" or "no" with nothing pending never resumes a held run.
          update({
            ...runPill,
            label: "Paused — nothing to approve.",
            transcript: "Hold ⌥ Space to continue.",
          });
          return;
        }
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
    // Like the desktop app, dismissing never hides an active run's controls.
    dismiss: async () => {
      const held = textHold;
      textHold = undefined;
      if (
        pill.phase === "text" &&
        held !== undefined &&
        runner?.snapshot.run?.status === "paused" &&
        lastSequence() === held
      ) {
        await runner.resume();
        return;
      }
      update(
        runner?.snapshot.run && !terminal(runner.snapshot.run.status)
          ? runPill
          : idlePill,
      );
    },
    openSettings: async (section = "settings") =>
      viewListeners.forEach((fn) => fn(section)),
    closeSettings: async () => viewListeners.forEach((fn) => fn("")),
    // The browser preview never learns: runs here are synthetic tutorials.
    memorySummary: async () => ({
      counts: { episodes: 0, preferences: 0, skills: 0, apps: 0 },
      preferences: [],
      skills: [],
    }),
    forgetMemory: async () => {
      if (runner?.snapshot.run && !terminal(runner.snapshot.run.status))
        throw new Error("Stop the active run first.");
    },
    // The browser preview has no system voices and never plays audio or
    // contacts a speech service.
    voices: async () => ({
      voices: [],
      selected: settings.voiceId,
      engine: settings.voiceEngine,
      cloudAllowed: false,
    }),
    previewVoice: async () => {
      throw new Error(
        "Spoken replies play in the macOS app. This preview never plays audio.",
      );
    },
    openVoiceSettings: async () => {
      throw new Error("Open the macOS app to manage system voices.");
    },
    kokoroStatus: async () => ({ ...kokoroUnsupported }),
    downloadKokoro: async () => {
      throw new Error(kokoroMessage);
    },
    cancelKokoroDownload: async () => {
      throw new Error(kokoroMessage);
    },
    removeKokoro: async () => {
      throw new Error(kokoroMessage);
    },
    setupStatus: async () => ({
      ...setupUnavailable,
      model: { ...setupUnavailable.model },
      kokoro: { ...kokoroUnsupported },
    }),
    openPrivacyPane: async () => {
      throw new Error(setupMessage);
    },
    relaunch: async () => {
      throw new Error(setupMessage);
    },
    // Never probes: the preview cannot reach a local Ollama and must not try.
    detectOllama: async () => ({ running: false, models: [] }),
    checkProviderKey: async () => ({ ok: false, message: setupMessage }),
    completeSetup: async () => {},
    messagesStatus: async () => ({ ...messagesUnavailable }),
    remoteStatus: async () => ({ ...remoteUnavailable }),
    setRemoteDevice: async () => ({ ...remoteUnavailable }),
    forgetRemoteDevice: async () => ({ ...remoteUnavailable }),
    lockRemote: async () => ({ ...remoteUnavailable }),
    toolsStatus: async () => structuredClone(toolsUnavailable),
    setAppleTool: async () => {
      throw new Error(toolsMessage);
    },
    addToolServer: async () => {
      throw new Error(toolsMessage);
    },
    testToolServer: async () => ({
      ok: false,
      state: "off",
      toolCount: 0,
      argv: [],
      tools: [],
      code: "preview",
    }),
    approveToolServer: async () => {
      throw new Error(toolsMessage);
    },
    setToolServer: async () => {
      throw new Error(toolsMessage);
    },
    setToolTicked: async () => {
      throw new Error(toolsMessage);
    },
    setToolSecret: async () => {
      throw new Error(toolsMessage);
    },
    forgetToolServer: async () => {
      throw new Error(toolsMessage);
    },
    // The preview has no registry and no data folder: every port built-in, no file.
    modulesStatus: async () =>
      Object.fromEntries(
        (Object.keys(PORTS) as (keyof typeof PORTS)[]).map((port) => [
          port,
          {
            kind: port === "choiceModel" ? "jev" : "builtin",
            fallback: true,
            calls: 0,
          },
        ]),
      ) as ModulesStatus,
    recipesStatus: async () => ({
      path: "~/Library/Application Support/coarena-open-assist/recipes.json",
      exists: false,
      loaded: 0,
      builtin: RECIPES.length,
      total: RECIPES.length,
      rejected: [],
    }),
    agendaStatus: async () => ({ calendar: "unknown", reminders: "unknown" }),
    requestAgendaAccess: async () => ({
      calendar: "unknown",
      reminders: "unknown",
    }),
    sendTestMessage: async () => {
      throw new Error(messagesMessage);
    },
    subscribeKokoro: () => () => {},
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
