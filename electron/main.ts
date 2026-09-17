import {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  globalShortcut,
  dialog,
  session,
  screen,
  Tray,
  Menu,
  nativeImage,
  shell,
} from "electron";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { z } from "zod";
import {
  defaultSettings,
  settingsSchema,
  type Settings,
  type Snapshot,
} from "../src/core/schema";
import {
  MANUAL_PAUSE_MESSAGE,
  Runner,
  TARGET_HANDOFF_MESSAGE,
  terminal,
} from "../src/core/runner";
import { shouldAutoResume, type InputIdleReport } from "../src/core/resume";
import { TutorialController, TutorialProvider } from "../src/core/tutorial";
import { createDesktopProvider } from "./provider";
import { LocalDiagnostics } from "./diagnostics";
import {
  errorDetails,
  trace,
  type DiagnosticSink,
} from "../src/core/diagnostics";
import { validateProviderEndpoint } from "../src/core/privacy";
import { scanText } from "../src/core/sanitize";
import { Vault, seal, unseal, digest } from "../src/storage/vault";
import {
  prepareBundle,
  reviewSchema,
  type Review,
  type Bundle,
} from "../src/contribution/bundle";
import {
  uploadBundle,
  deleteContribution,
  type UploadState,
} from "../src/contribution/client";
import { workflowCandidate } from "../src/gym/workflow";
import { MemoryStore, forgetRunIn } from "../src/memory/store";
import { createMemoryAccess } from "../src/memory/access";
import type { MemoryAccess, SystemIndex } from "../src/memory/types";
import { summarizeMemory } from "../src/ui/api";
import { NativeController, budgetDelay } from "./controller";
import {
  NativeVoice,
  approvalHint,
  continueHint,
  pausedLabel,
  type VoiceEvent,
} from "./voice";
import { Conversation, ANSWER_WINDOW } from "./conversation";
import { createSpeechOutput, selectSpeechEngine } from "./speech-output";
import { desktopTransport } from "./provider";
import {
  createKokoroVoice,
  kokoroSupported,
  type KokoroStatus,
  type KokoroVoice,
} from "./kokoro/client";
import { credentialScope, providerDefaults } from "../src/providers/catalog";
import { planVoiceTurn, type TurnPlan } from "../src/voice/turns";
import { PHRASES } from "../src/voice/phrases";
import { speakableSummary } from "../src/voice/speakable";
import {
  importLaunchCredentials,
  providerKey,
  readCredentials,
  withProviderKey,
  type Credentials,
} from "./credentials";
import {
  idlePill,
  voiceIntent,
  voiceCommandConfidence,
  describeAction,
  type PillState,
} from "../src/voice/router";
if (process.env.COARENA_TEST_DATA_DIR)
  app.setPath("userData", process.env.COARENA_TEST_DATA_DIR);
// Chromium may reorder second-instance argv. Preserve launch argument pairs
// before handing them to the existing process (especially Stop/Continue).
const ownsInstance = app.requestSingleInstanceLock({
  launchArgs: process.argv,
});
if (!ownsInstance) app.quit();
let window: BrowserWindow;
let indicator: BrowserWindow;
let tray: Tray;
let voice: NativeVoice | undefined;
let pill: PillState = { ...idlePill };
let listening = false;
let wakeListening = false;
let voiceInvocation = 0;
let voiceContext: Promise<unknown> = Promise.resolve();
let voiceGate: string | undefined;
let hideTimer: ReturnType<typeof setTimeout> | undefined;
let runner: Runner | undefined;
let native: NativeController | undefined;
let vault: Vault;
let memory: MemoryStore | undefined;
let root: string;
let master: Buffer;
let settings: Settings = defaultSettings;
let credentials: Credentials = {};
let uploads: Record<string, UploadState> = {};
let reviewCache = new Map<string, ReturnType<typeof prepareBundle>>();
let snapshot: Snapshot = {
  run: null,
  frame: null,
  events: [],
  message: "Ready when you are.",
};
let shuttingDown = false;
let donationBusy = false;
let diagnostics: LocalDiagnostics | undefined;
let diagnosticHeartbeat: ReturnType<typeof setInterval> | undefined;
// True only while a voice or typed-command interruption paused a run that was
// otherwise working. A voice outcome without a usable command keeps the run
// paused; only dismissing an untouched text-entry pill undoes this hold.
let voiceHeld = false;
let voiceHeldSequence = 0;
// A short acknowledgement shown under the working pill.
let notice = { text: "", until: 0 };
// Renderer crash reloads per window within the last minute, plus at most one
// deferred reload per window once that budget is exhausted.
const rendererReloads = new Map<BrowserWindow, number[]>();
const deferredReloads = new Map<BrowserWindow, ReturnType<typeof setTimeout>>();
const defaultPause = "Paused. Capture and input are stopped.";
const helperPause = "Desktop control restarted. Say continue to resume.";
const debug: DiagnosticSink = (event, data = {}) =>
  trace(diagnostics?.write, event, { runId: snapshot.run?.id, ...data });
/** The OpenAI key, used for the optional natural voice only. */
function openaiKey() {
  return (
    credentials[credentialScope("openai", providerDefaults.openai.endpoint)] ??
    ""
  );
}
/** Whether the natural (OpenAI) voice may be used with these settings. */
function cloudVoiceAllowed() {
  return (
    settings.privacy === "PRIVATE_BYOM" &&
    selectSpeechEngine({ ...settings, voiceEngine: "openai" }, openaiKey()) ===
      "openai"
  );
}
const voiceCall = async (method: string, data?: Record<string, unknown>) =>
  getVoice().call(method, data);
// The free on-device natural voice (Kokoro), created on first use. Its worker
// forks lazily and exits when idle; the model is a one-time opt-in download.
let kokoro: KokoroVoice | undefined;
function getKokoro() {
  kokoro ??= createKokoroVoice({
    modelDir: join(app.getPath("userData"), "voices", "kokoro"),
    fetch: desktopTransport(debug),
    trace: debug,
  });
  return kokoro;
}
function kokoroUiStatus(status?: KokoroStatus) {
  const supported = process.platform === "darwin" && kokoroSupported();
  const empty = {
    installed: false,
    downloading: false,
    progress: 0,
    bytes: 0,
    totalBytes: 0,
  };
  try {
    return { ...(status ?? getKokoro().status()), supported };
  } catch {
    return { ...empty, supported };
  }
}
function sendKokoroStatus(status?: KokoroStatus) {
  if (window && !window.isDestroyed())
    window.webContents.send("kokoro-status", kokoroUiStatus(status));
}
/** Starts the natural voice worker ahead of a reply when it is the engine. */
function warmKokoro() {
  if (settings.voiceEngine !== "kokoro" || !kokoroSupported()) return;
  const voice = getKokoro();
  if (!voice.status().installed) return;
  void voice
    .warm()
    .catch((error) => debug("KokoroWarmFailed", errorDetails(error)));
}
let kokoroDownload: AbortController | undefined;
/**
 * `--natural-voice`: install the free on-device voice if needed and use it for
 * replies, turning replies on when they were off.
 */
async function useNaturalVoice() {
  if (process.platform !== "darwin" || !kokoroSupported()) return;
  const voice = getKokoro();
  if (!voice.status().installed)
    try {
      await voice.download((status) => sendKokoroStatus(status));
    } catch (error) {
      debug("KokoroDownloadFailed", errorDetails(error));
      return;
    }
  if (settings.voiceEngine !== "kokoro" || settings.voiceReplies === "off") {
    settings = {
      ...settings,
      voiceEngine: "kokoro",
      voiceReplies:
        settings.voiceReplies === "off" ? "voice" : settings.voiceReplies,
    };
    saveConfig();
    refreshSettingsView();
    void getVoice()
      .call("configure", voiceOutputConfig())
      .catch((error) => debug("VoiceSetupFailed", errorDetails(error)));
  }
  debug("NaturalVoiceSelected");
  warmKokoro();
}
const kokoroErrors: Record<string, string> = {
  network: "The download was interrupted. Check your connection and try again.",
  checksum_mismatch: "The downloaded voice did not verify. Try again.",
  size_mismatch: "The downloaded voice did not verify. Try again.",
  disk_full: "Not enough disk space for the natural voice (332 MB).",
  load_failed: "The natural voice could not load on this Mac.",
  worker_crashed: "The natural voice stopped unexpectedly. Try again.",
};
// Spoken replies: the Mac voice in coarena-voice, or natural PCM (on-device
// Kokoro or opt-in OpenAI) played there.
const speech = createSpeechOutput({
  settings: () => settings,
  openaiKey,
  voiceCall,
  fetch: desktopTransport(debug),
  trace: debug,
  kokoro: {
    status: () => getKokoro().status(),
    synthesize: (text, signal) => getKokoro().synthesize(text, signal),
  },
});
const conversation = new Conversation({
  settings: () => settings,
  speech,
  voiceCall,
  trace: debug,
  onChange: () => refreshSpeechPill(),
});
/** Mirrors speaking and follow-up state onto the pill without re-layout. */
function refreshSpeechPill() {
  const speaking = conversation.speaking,
    followUp = conversation.followUp;
  if (pill.speaking === speaking && pill.followUp === followUp) return;
  pill = { ...pill, speaking, followUp };
  if (!indicator || indicator.isDestroyed()) return;
  indicator.webContents.send("pill", pill);
  if (pill.phase === "done") armDoneHide();
}
function armDoneHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    pill = { ...idlePill };
    indicator.hide();
  }, conversation.doneHoldMs(doneRunId));
}
process.on("uncaughtExceptionMonitor", (error) =>
  debug("UncaughtException", errorDetails(error)),
);
function saveConfig() {
  const path = join(root, "config.enc");
  writeFileSync(
    path + ".tmp",
    seal(
      master,
      Buffer.from(JSON.stringify({ settings, credentials, uploads })),
      "config",
    ),
    { mode: 0o600 },
  );
  renameSync(path + ".tmp", path);
}
function getNative() {
  if (process.platform !== "darwin")
    throw new Error("Real desktop control currently requires macOS 14+.");
  if (!native) {
    const binary = app.isPackaged
      ? join(process.resourcesPath, "coarena-controller")
      : join(app.getAppPath(), "native/bin/coarena-controller");
    if (!existsSync(binary))
      throw new Error("Build the native controller with npm run build:native.");
    native = new NativeController(
      binary,
      () => {
        // Only the native Escape emergency stop cancels a run.
        if (shuttingDown) return;
        if (!snapshot.run || terminal(snapshot.run.status)) return;
        cancelVoiceCapture();
        void conversation.stopSpeaking();
        voiceHeld = false;
        runner?.stop("Native emergency stop activated.");
        setPill({
          phase: "done",
          label: "Stopped.",
          transcript: "",
          canApprove: false,
        });
      },
      () => {
        runner?.manualTakeover();
        // Remember this hold so it can end on its own once the user lets go.
        if (snapshot.run?.status === "paused")
          manualHold = { sequence: lastSequence() };
      },
      debug,
      {
        inputIdle: (report) => void resumeAfterManualInput(report),
        onUnavailable: () => {
          if (shuttingDown) return;
          const run = snapshot.run;
          // A crash is not the user's intent to stop: hold the run so it can
          // continue once the helper is back. The tutorial never uses it.
          if (!run || terminal(run.status) || run.synthetic) return;
          // Any helper loss makes an existing pause the system's: it never
          // resumes on its own and the pill says why.
          voiceHeld = false;
          if (run.status === "takeover") return;
          runner?.pause(helperPause);
        },
        onRestart: (pid) => {
          if (shuttingDown) return;
          // Protected apps, domains and display are process-local natively.
          void native
            ?.configure(settings)
            .catch((error) => debug("NativeSetupFailed", errorDetails(error)));
          void voice
            ?.call("configure", { controllerPID: pid })
            .catch((error) => debug("VoiceSetupFailed", errorDetails(error)));
        },
      },
    );
  }
  return native;
}
/**
 * A run held only because the user touched the mouse or keyboard continues on
 * its own once they let go: after about a second of stillness for pointer
 * movement or scrolling, after three seconds when they clicked or typed. A
 * "can't find the control" hand-off continues a second after the user clicks.
 * Anything else that happened in between (voice, approvals, stop, a new
 * pause) keeps the run held.
 */
let manualHold: { sequence: number } | undefined;
async function resumeAfterManualInput(report: InputIdleReport) {
  if (shuttingDown || !runner || !snapshot.run) return;
  if (terminal(snapshot.run.status)) return;
  const source = shouldAutoResume({
    status: snapshot.run.status,
    message: snapshot.message,
    listening,
    holdSequence: manualHold?.sequence,
    lastSequence: lastSequence(),
    report,
  });
  if (!source) return;
  manualHold = undefined;
  voiceHeld = false;
  debug("AutoResume", { source });
  try {
    await resumeHeldRun(runHeld);
  } catch (error) {
    debug("AutoResumeFailed", errorDetails(error));
  }
}
function nativePid() {
  try {
    return getNative().pid;
  } catch {
    return undefined;
  }
}
/**
 * Memory for a real run: recall uses the native system index (Spotlight
 * metadata, never file contents), and learning stops as soon as the user turns
 * the setting off, even for a run that already started.
 */
function runMemory(): MemoryAccess | undefined {
  if (!memory || !settings.memory) return undefined;
  const index = async (query?: string): Promise<SystemIndex | undefined> => {
    try {
      return await getNative().request("index", query ? { query } : {});
    } catch {
      return undefined;
    }
  };
  return createMemoryAccess(memory, index, {
    enabled: () => settings.memory,
    onError: (error) => debug("MemoryAccessFailed", errorDetails(error)),
  });
}
function flushMemory() {
  try {
    memory?.flush();
  } catch (error) {
    debug("MemoryFlushFailed", errorDetails(error));
  }
}
/** Minimum spacing between best-effort system index prewarms. */
export const INDEX_PREWARM_INTERVAL_MS = 10000;
/**
 * Whether to prewarm the native system index now: memory is on, nothing is
 * using the serial native queue for a run, no prewarm is still running and the
 * last one started long enough ago.
 */
export function shouldPrewarmIndex(state: {
  memoryEnabled: boolean;
  runBusy: boolean;
  inFlight: boolean;
  lastStartedAt?: number;
  now: number;
}): boolean {
  return (
    state.memoryEnabled &&
    !state.runBusy &&
    !state.inFlight &&
    (state.lastStartedAt === undefined ||
      state.now - state.lastStartedAt >= INDEX_PREWARM_INTERVAL_MS)
  );
}
let indexPrewarming = false;
let indexPrewarmedAt: number | undefined;
/**
 * Fires one best-effort "index" request without a query so the recall at the
 * next run start hits the native cache. Never awaited, never logged, and never
 * sent while a run owns the native queue.
 */
function prewarmIndex() {
  if (process.platform !== "darwin" || shuttingDown) return;
  const now = Date.now();
  if (
    !shouldPrewarmIndex({
      memoryEnabled: !!memory && settings.memory,
      runBusy: runActive() || (!!runner && !runner.settled),
      inFlight: indexPrewarming,
      lastStartedAt: indexPrewarmedAt,
      now,
    })
  )
    return;
  let controller: NativeController;
  try {
    controller = getNative();
  } catch {
    return;
  }
  indexPrewarming = true;
  indexPrewarmedAt = now;
  void controller
    .request("index")
    .catch(() => undefined)
    .finally(() => {
      indexPrewarming = false;
    });
}
function runActive() {
  return !!snapshot.run && !terminal(snapshot.run.status);
}
function runHeld() {
  return (
    runActive() &&
    (snapshot.run!.status === "paused" || snapshot.run!.status === "takeover")
  );
}
let lastPillTrace = "";
// The run a done pill describes (its spoken summary may hold it longer).
let doneRunId: string | undefined;
let nextDoneRunId: string | undefined;
function setPill(update: Partial<PillState>, focus = false) {
  clearTimeout(hideTimer);
  pill = { ...pill, ...update };
  doneRunId = pill.phase === "done" ? nextDoneRunId : undefined;
  nextDoneRunId = undefined;
  if (diagnostics?.verbose) {
    const shown = JSON.stringify([
      pill.phase,
      pill.label,
      pill.transcript,
      pill.detail,
    ]);
    if (shown !== lastPillTrace) {
      lastPillTrace = shown;
      debug("Pill", {
        phase: pill.phase,
        label: pill.label,
        transcript: pill.transcript,
        detail: pill.detail,
        canApprove: pill.canApprove,
      });
    }
  }
  if (!indicator || indicator.isDestroyed()) return;
  indicator.webContents.send("pill", pill);
  const expanded = ["text", "approval", "error"].includes(pill.phase);
  const area = (
    (settings.displayId !== undefined &&
      screen.getAllDisplays().find((d) => d.id === settings.displayId)) ||
    screen.getPrimaryDisplay()
  ).workArea;
  const width = expanded ? 460 : 340,
    height = expanded
      ? 190
      : (pill.phase === "listening" ||
            pill.phase === "working" ||
            pill.phase === "paused") &&
          pill.transcript
        ? 130
        : 94;
  indicator.setBounds(
    {
      x: Math.round(area.x + (area.width - width) / 2),
      y: area.y + area.height - height - 34,
      width,
      height,
    },
    false,
  );
  if (pill.phase === "idle") {
    indicator.hide();
    return;
  }
  if (focus) {
    indicator.show();
    indicator.focus();
  } else indicator.showInactive();
  if (pill.phase === "done") armDoneHide();
}
function refreshSettingsView() {
  // Re-read settings in place; a reload would discard unsaved edits.
  if (window && !window.isDestroyed())
    window.webContents.send("view", "refresh");
}
async function toggleHandsFree(enabled = !settings.handsFree) {
  if (!enabled) {
    cancelVoiceCapture();
    listening = false;
  }
  settings = { ...settings, handsFree: enabled };
  saveConfig();
  updateTray();
  refreshSettingsView();
  await getVoice().call("configure", {
    handsFree: enabled,
    controllerPID: nativePid(),
  });
  if (enabled) return;
  // Turning the microphone off neither pauses nor resumes the task; a run a
  // voice interruption held stays paused until the user continues.
  voiceHeld = false;
  if (runHeld()) showFailure("Hands-free off.");
  else if (runActive()) {
    flash("Hands-free off.");
    renderPill(snapshot);
  } else
    setPill({
      phase: "done",
      label: "Hands-free off.",
      transcript: "",
      canApprove: false,
    });
}
function updateTray() {
  if (!tray) return;
  tray.setToolTip(
    settings.handsFree
      ? wakeListening
        ? "Open Assist · Say Hey Assist"
        : "Open Assist · Hands-free enabled"
      : "Open Assist · Hold Option-Space",
  );
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: settings.handsFree
          ? "Turn off Hey Assist microphone"
          : "Enable Hey Assist · microphone stays on",
        type: "checkbox",
        checked: settings.handsFree,
        click: () =>
          void toggleHandsFree().catch((e) =>
            setPill({ phase: "error", label: e.message }),
          ),
      },
      { type: "separator" },
      {
        label: "Type a command",
        click: () => void showCommand(),
      },
      {
        label: "Try the safe tutorial",
        click: () =>
          void dispatch("start", [
            "Move the card to Completed and add a note.",
            true,
          ]).catch((e) => setPill({ phase: "error", label: e.message })),
      },
      { type: "separator" },
      { label: "Settings…", click: () => showSettings() },
      { label: "Review local runs…", click: () => showSettings("review") },
      { type: "separator" },
      { label: "Quit Open Assist", click: () => app.quit() },
    ]),
  );
}
function showSettings(section = "settings") {
  window.webContents.send("view", section);
  window.show();
  window.focus();
  debug("SettingsOpened", { source: section });
}
function getVoice() {
  if (process.platform !== "darwin") throw new Error("Voice requires macOS.");
  if (!voice) {
    const binary = app.isPackaged
      ? join(process.resourcesPath, "coarena-voice")
      : join(app.getAppPath(), "native/bin/coarena-voice");
    if (!existsSync(binary))
      throw new Error("Build the native voice helper first.");
    voice = new NativeVoice(
      binary,
      (event) => void receiveVoice(event),
      debug,
      {
        onUnavailable: () => {
          if (shuttingDown) return;
          conversation.reset();
          wakeListening = false;
          updateTray();
          if (!listening) return;
          listening = false;
          voiceInvocation += 1;
          showFailure("Voice restarted. Try again.");
        },
        onRestart: () => {
          if (shuttingDown) return;
          conversation.reset();
          void configureVoice();
        },
      },
    );
  }
  return voice;
}
/** Spoken-reply and listening settings the voice helper applies. */
function voiceOutputConfig(s: Settings = settings) {
  return {
    speechEnabled: s.voiceReplies !== "off",
    voiceId: s.voiceId,
    voiceRate: s.voiceRate,
    patience: s.listeningPatience,
    followUp: s.followUpListening,
    sounds: s.voiceSounds,
  };
}
const voiceOutputKeys = [
  "voiceReplies",
  "voiceId",
  "voiceRate",
  "listeningPatience",
  "followUpListening",
  "voiceSounds",
] as const;
async function configureVoice() {
  try {
    await getVoice().call("enable");
  } catch {}
  try {
    await getVoice().call("configure", {
      handsFree: settings.handsFree,
      controllerPID: nativePid(),
      ...voiceOutputConfig(),
    });
  } catch (error) {
    debug("VoiceSetupFailed", errorDetails(error));
  }
}
function currentGate() {
  return snapshot.pending && snapshot.run
    ? JSON.stringify({ run: snapshot.run.id, action: snapshot.pending.action })
    : undefined;
}
function cancelVoiceCapture() {
  listening = false;
  voiceInvocation += 1;
  voiceGate = undefined;
  void voice?.call("cancel").catch(() => {});
}
function interruptForVoice() {
  const before = runActive() ? snapshot.run!.status : undefined,
    stillHeld = voiceHoldResumable();
  runner?.interruptForVoice();
  // Only a pause an interruption caused may be undone automatically; a second
  // press keeps that hold (the runner re-journals the pause).
  if (
    snapshot.run?.status === "paused" &&
    (stillHeld ||
      (before && !["paused", "takeover", "confirming"].includes(before)))
  ) {
    voiceHeld = true;
    voiceHeldSequence = snapshot.events.at(-1)?.sequence_number ?? 0;
  }
}
/**
 * The run is still exactly as the interruption left it. A later takeover,
 * helper restart or correction makes the pause the user's or the system's.
 */
function voiceHoldResumable() {
  return (
    voiceHeld &&
    !!runner &&
    snapshot.run?.status === "paused" &&
    (snapshot.events.at(-1)?.sequence_number ?? 0) === voiceHeldSequence
  );
}
function flash(text: string) {
  notice = { text, until: Date.now() + 2500 };
  if (pill.phase === "working") setPill({ transcript: text });
}
function approvalPill(
  s: Snapshot,
  transcript = approvalHint(settings.handsFree),
): Partial<PillState> {
  return {
    synthetic: !!s.run?.synthetic,
    inputLevel: 0,
    phase: "approval",
    label: s.pending!.reason,
    detail: describeAction(s.pending!.action),
    transcript,
    canApprove: true,
  };
}
function lastSequence() {
  return snapshot.events.at(-1)?.sequence_number ?? 0;
}
/**
 * Re-activates the remembered app and resumes a held run, unless anything
 * happened to the run (a new pause, takeover, stop or voice capture) while the
 * native restore was in flight. Returns whether the run was resumed.
 */
async function resumeHeldRun(held: () => boolean) {
  const current = runner,
    sequence = lastSequence();
  if (!current || !snapshot.run || !held()) return false;
  if (!snapshot.run.synthetic) {
    indicator.hide();
    await getNative().request("restore");
    if (
      listening ||
      runner !== current ||
      !held() ||
      lastSequence() !== sequence
    ) {
      // The newer state owns the pill; re-show it if nothing else will.
      if (!listening && runActive()) renderPill(snapshot);
      return false;
    }
  }
  await current.resume();
  return true;
}
/**
 * Undoes the hold of an untouched text-entry pill that a tap opened while the
 * run was working. Every other voice outcome leaves the run paused.
 */
async function resumeVoiceHold() {
  const resumable = voiceHoldResumable();
  voiceHeld = false;
  if (!resumable) return false;
  try {
    await resumeHeldRun(
      () => runner !== undefined && snapshot.run?.status === "paused",
    );
  } catch (error) {
    showFailure(
      error instanceof Error ? error.message : "Something went wrong.",
    );
  }
  return true;
}
/**
 * Shows a failed command or voice hiccup without guessing the user's intent:
 * an approval stays answerable, a held run stays paused with the reason and
 * how to continue, otherwise an error card.
 */
function showFailure(message: string) {
  voiceHeld = false;
  if (snapshot.run?.status === "confirming" && snapshot.pending) {
    setPill(approvalPill(snapshot, message));
    return;
  }
  if (runHeld()) {
    setPill({
      synthetic: !!snapshot.run?.synthetic,
      phase: "paused",
      label: pausedLabel(message),
      detail: undefined,
      transcript: continueHint(settings.handsFree),
      canApprove: false,
      inputLevel: 0,
    });
    return;
  }
  setPill({
    phase: "error",
    label: message,
    transcript: "",
    canApprove: false,
    inputLevel: 0,
  });
}
async function showCommand() {
  cancelVoiceCapture();
  voiceGate = currentGate();
  interruptForVoice();
  try {
    await getNative().request("rememberForeground");
  } catch {}
  prewarmIndex();
  setPill(
    {
      phase: "text",
      label: "Tell your computer what to do.",
      transcript: "",
      canApprove: false,
      synthetic:
        !!snapshot.run &&
        !terminal(snapshot.run.status) &&
        snapshot.run.synthetic,
    },
    true,
  );
}
/** Listening ended without a plan: a prompt held back while capturing may speak. */
function listeningEnded() {
  conversation.onSnapshot(snapshot, {
    listening: false,
    handsFree: settings.handsFree,
  });
}
async function receiveVoice(event: VoiceEvent) {
  if (
    event.event !== "audio_level" &&
    (event.event !== "transcript_partial" || diagnostics?.verbose)
  )
    debug("VoiceEvent", {
      phase: event.event,
      // Verbose-only: dropped by the diagnostic allow-list otherwise.
      text: event.text,
      command: event.command,
      textLength: event.text?.length ?? event.textLength,
      source: event.source,
      confidence: event.confidence,
      enabled: event.enabled,
      listening: event.listening,
      error: event.message,
      utteranceId: event.utteranceId,
      interrupted: event.interrupted,
      code: event.code ?? event.reason,
      kind: event.kind,
      segments: event.segments,
      remainingMs: event.remainingMs,
      endReason: event.endReason,
      stableMs: event.stableMs,
      quietMs: event.quietMs,
      completeness: event.completeness,
      patience: event.patience,
      noiseFloor: event.noiseFloor,
      threshold: event.threshold,
    });
  try {
    if (event.event === "wake_status") {
      wakeListening = event.listening === true;
      updateTray();
    } else if (
      event.event === "shortcut_down" ||
      event.event === "wake_detected" ||
      event.event === "followup_detected"
    ) {
      // The helper already latched input and stopped playback.
      conversation.onVoiceEvent(event);
      // A reply is likely soon: have the natural voice ready.
      warmKokoro();
      voiceGate =
        event.event === "followup_detected" && event.kind === "approval"
          ? conversation.windowGate
          : currentGate();
      listening = true;
      interruptForVoice();
      const invocation = ++voiceInvocation;
      setPill({
        phase: "listening",
        label: "Listening…",
        transcript: "",
        detail: undefined,
        canApprove: false,
        inputLevel: 0,
        closing: false,
      });
      // Final recognition also waits for context, even if it arrives immediately.
      voiceContext = getNative().request("rememberForeground");
      await voiceContext;
      if (!listening || invocation !== voiceInvocation) return;
      prewarmIndex();
    } else if (event.event === "shortcut_tap") {
      listening = false;
      await showCommand();
    } else if (event.event === "shortcut_up") {
      if (listening)
        setPill({
          phase: "working",
          label: "One moment…",
          inputLevel: 0,
          closing: false,
        });
    } else if (event.event === "endpoint_near") {
      if (listening && !pill.closing) setPill({ closing: true });
    } else if (event.event === "transcript_partial") {
      if (listening) setPill({ transcript: event.text ?? "", closing: false });
    } else if (event.event === "audio_level") {
      pill.inputLevel = event.level ?? 0;
      indicator.webContents.send("pill", pill);
    } else if (
      event.event === "speech_started" ||
      event.event === "speech_finished" ||
      event.event === "speech_error" ||
      event.event === "followup_open" ||
      event.event === "followup_closed" ||
      event.event === "turn_endpoint"
    ) {
      conversation.onVoiceEvent(event);
    } else if (event.event === "voice_cancelled") {
      listening = false;
      voiceInvocation += 1;
      voiceHeld = false;
      runner?.stop("Stopped.");
      setPill({
        phase: "done",
        label: "Stopped.",
        transcript: "",
        canApprove: false,
        closing: false,
      });
      listeningEnded();
    } else if (
      event.event === "transcript_final" ||
      event.event === "transcript_recovered"
    ) {
      if (!listening) return;
      listening = false;
      const invocation = voiceInvocation;
      await voiceContext;
      if (invocation !== voiceInvocation) return;
      const text = (event.text ?? "").trim();
      if (!text) throw new Error("Didn’t catch that. Try again.");
      await command(text, true, voiceCommandConfidence(event), {
        segments: event.segments,
      });
    } else if (event.event === "transcript_unconfirmed") {
      if (!listening) return;
      listening = false;
      const text = (event.text ?? "").trim();
      if (conversation.planContext(true).source === "ptt" && text) {
        // Never act on an unconfirmed hypothesis: offer it for a one-tap send.
        // Dismissing this pill must not resume a run the voice hold paused.
        voiceHeld = false;
        setPill(
          {
            phase: "text",
            label: "Send this?",
            transcript: text,
            canApprove: false,
            closing: false,
          },
          false,
        );
        listeningEnded();
      } else {
        showFailure("Didn’t catch that. Try again.");
        conversation.say("didntCatch", {
          priority: "urgent",
          listen: ANSWER_WINDOW,
        });
      }
    } else if (event.event === "voice_error" || event.event === "wake_error") {
      listening = false;
      if (event.code === "empty") {
        if (runHeld()) showFailure("Didn’t hear anything.");
        else if (runActive()) renderPill(snapshot);
        else
          setPill({
            phase: "done",
            label: "Didn’t hear anything.",
            transcript: "",
            canApprove: false,
            closing: false,
          });
      } else showFailure(event.message ?? "Try again.");
      listeningEnded();
    }
  } catch (error) {
    listening = false;
    showFailure(
      error instanceof Error ? error.message : "Something went wrong.",
    );
    listeningEnded();
  }
}
function planRun() {
  if (!runActive()) return undefined;
  const run = snapshot.run!;
  return {
    id: run.id,
    status: run.status,
    // An interrupted action may still have acted: never amend after one.
    actions: Math.max(run.actions, runner?.actionsAttempted ?? 0),
    held: runHeld(),
    pendingReason: snapshot.pending?.reason,
    task: run.task,
  };
}
async function command(
  text: string,
  fromVoice = false,
  confidence = 1,
  extra: { segments?: number } = {},
) {
  text = z.string().trim().min(1).max(2000).parse(text);
  const context = conversation.planContext(fromVoice);
  const gate = currentGate();
  const plan = planVoiceTurn({
    text,
    confidence,
    segments: extra.segments,
    gateMatches: fromVoice ? !!voiceGate && voiceGate === gate : !!gate,
    now: Date.now(),
    run: planRun(),
    ...context,
  });
  debug("Command", {
    text,
    fromVoice,
    confidence,
    intent: voiceIntent(text).kind,
    activeRun: snapshot.run?.status,
  });
  debug("TurnPlanned", {
    plan: plan.kind,
    source: context.source,
    window: context.window,
    segments: extra.segments,
    confidence,
    textLength: text.length,
  });
  // Typed text keeps the pill visible until a run actually starts or resumes,
  // so a rejected command stays readable.
  if (!fromVoice) cancelVoiceCapture();
  await executePlan(plan, fromVoice);
  conversation.acknowledge(plan, {
    source: context.source,
    handsFree: settings.handsFree,
    activationAt: context.activationAt,
  });
}
async function executePlan(plan: TurnPlan, fromVoice: boolean) {
  // A newer voice turn that started while this plan runs owns the pill.
  const show = (update: Partial<PillState>, focus = false) => {
    if (!listening) setPill(update, focus);
  };
  const fail = (message: string) => {
    if (!listening) showFailure(message);
  };
  const render = () => {
    if (!listening) renderPill(snapshot);
  };
  const hide = () => {
    if (!listening) indicator.hide();
  };
  const idleCard = (label: string) =>
    show({
      phase: "done",
      label,
      transcript: "",
      canApprove: false,
      closing: false,
    });
  switch (plan.kind) {
    case "stop":
      voiceHeld = false;
      runner?.stop("Stopped.");
      idleCard("Stopped.");
      return;
    case "pause":
      voiceHeld = false;
      runner?.pause();
      show({
        phase: "paused",
        label: "Paused.",
        transcript: continueHint(settings.handsFree),
        canApprove: false,
        closing: false,
      });
      return;
    case "approve":
    case "decline":
      // A gate that vanished since planning is a stale answer.
      if (!currentGate()) {
        fail("Nothing to approve.");
        return;
      }
      await runner!.approveFromVoice(plan.kind === "approve");
      // A newer turn's gate belongs to that turn.
      if (!listening) voiceGate = undefined;
      if (plan.kind === "decline") return;
      show({
        phase: "working",
        label: "On it.",
        transcript: "",
        canApprove: false,
        closing: false,
      });
      return;
    case "needClick":
      fail(
        plan.reason === "restricted"
          ? "Click Yes to confirm this one."
          : "Tap once to approve.",
      );
      return;
    case "confirmAgain":
      fail("Was that a yes or a no?");
      return;
    case "nothingToApprove":
      // A "yes" or "no" with nothing pending is never a request to continue.
      fail("Nothing to approve.");
      return;
    case "nothingRunning":
      voiceHeld = false;
      idleCard("Nothing is running.");
      return;
    case "stillWorking":
      voiceHeld = false;
      // Nothing is held: acknowledge instead of re-activating apps.
      if (snapshot.run?.status === "confirming" && snapshot.pending)
        show(approvalPill(snapshot, "Still waiting for your approval."));
      else {
        notice = { text: "Still on it.", until: Date.now() + 2500 };
        render();
      }
      return;
    case "resume":
      voiceHeld = false;
      if (!runHeld()) {
        if (runActive()) render();
        return;
      }
      await resumeHeldRun(runHeld);
      return;
    case "acknowledge":
      voiceHeld = false;
      // A held run stays paused and keeps showing why.
      if (runActive()) render();
      else idleCard("Okay.");
      return;
    case "clarify":
      // No run starts and no correction is recorded; the answer completes it.
      // Dismissing the question must not resume a run the voice hold paused.
      voiceHeld = false;
      show(
        {
          phase: "text",
          label: plan.question,
          transcript: `${plan.fragment.replace(/[\s.,…]+$/, "")} `,
          canApprove: false,
          closing: false,
        },
        !fromVoice,
      );
      return;
    case "amendTask":
      voiceHeld = false;
      if (!snapshot.run?.synthetic) {
        hide();
        await native?.request("restoreRemembered");
      }
      show({
        phase: "working",
        label: "Got it.",
        transcript: "",
        canApprove: false,
        closing: false,
      });
      await runner!.amendTask(plan.text);
      return;
    case "revise":
    case "start": {
      voiceHeld = false;
      const active = runActive();
      if (!(snapshot.run?.synthetic && active)) {
        hide();
        await native?.request("restoreRemembered");
      }
      show({
        phase: "working",
        label: active ? "Got it." : "On it.",
        transcript: "",
        canApprove: false,
        closing: false,
      });
      if (active) await runner!.revise(plan.text);
      else await dispatch("start", [plan.text, false]);
      return;
    }
  }
}
function emit(s: Snapshot) {
  snapshot = s;
  diagnostics?.snapshot(s);
  if (window && !window.isDestroyed()) window.webContents.send("snapshot", s);
  // Decides what to say about this moment; it never speaks while listening.
  conversation.onSnapshot(s, { listening, handsFree: settings.handsFree });
  if (listening) return;
  renderPill(s);
}
function pillSummary(summary: string | undefined) {
  const text = (summary ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "Done.";
  return text.length > 160 ? `${text.slice(0, 159).trimEnd()}…` : text;
}
function renderPill(s: Snapshot) {
  const status = s.run?.status;
  if (!status) return;
  if (terminal(status)) nextDoneRunId = s.run!.id;
  const common = { synthetic: !!s.run?.synthetic, inputLevel: 0 };
  if (status === "confirming" && s.pending) setPill(approvalPill(s));
  else if (status === "paused" || status === "takeover")
    setPill({
      ...common,
      phase: "paused",
      // Keep specific reasons (takeover, helper restart, unsettled target).
      label:
        status === "takeover" || (s.message && s.message !== defaultPause)
          ? s.message
          : "Paused.",
      transcript:
        s.message === MANUAL_PAUSE_MESSAGE
          ? "I’ll continue when you let go."
          : s.message === TARGET_HANDOFF_MESSAGE
            ? "I’ll continue a moment after you click it."
            : continueHint(settings.handsFree),
      canApprove: false,
    });
  else if (status === "completed")
    setPill({
      ...common,
      phase: "done",
      // The model's own summary (credentials already redacted by the runner);
      // speech uses its own speakable form.
      label: pillSummary(s.run?.summary),
      transcript: "",
      canApprove: false,
    });
  else if (status === "cancelled")
    setPill({
      ...common,
      phase: "done",
      label: "Stopped.",
      transcript: "",
      canApprove: false,
    });
  else if (status === "failed")
    setPill({
      ...common,
      phase: "error",
      label: s.message,
      transcript: "",
      canApprove: false,
    });
  else
    setPill({
      ...common,
      phase: "working",
      // Confirming without a pending action: approval was given and the
      // screen is being revalidated.
      label:
        status === "confirming"
          ? "Checking the screen…"
          : s.frame?.context?.appName
            ? `Working in ${s.frame.context.appName}`
            : "Working…",
      transcript: notice.until > Date.now() ? notice.text : "",
      canApprove: false,
    });
}

function ensureIdle() {
  if (runner && !runner.settled)
    throw new Error(
      "The previous run is still stopping. Try again in a moment.",
    );
  if (snapshot.run && !terminal(snapshot.run.status))
    throw new Error("Stop the active run first.");
}
async function review(
  id: string,
  options?: Omit<Review, "runId" | "affirmative">,
) {
  const run = vault.getRun(id),
    frames = vault.frames(id),
    events = vault.events(id);
  const opts = {
    runId: id,
    level: "trajectory" as const,
    excludedFrames: [],
    excludedEvents: [],
    ...options,
  };
  reviewSchema.parse({ ...opts, affirmative: true });
  const bundle = prepareBundle(run, events, frames, opts);
  reviewCache.set(id, bundle);
  return { run, frames, events, bundle, uploaded: !!uploads[id]?.receipt };
}
async function dispatch(method: string, args: unknown[]): Promise<unknown> {
  switch (method) {
    case "info": {
      let permissions = {
          screen: false,
          accessibility: false,
          supported: false,
        },
        displays = [];
      try {
        permissions = await getNative().request("permissions");
        displays = (await getNative().request("displays")).displays;
      } catch {}
      let voiceStatus = {
        microphone: false,
        speech: false,
        onDevice: false,
        shortcut: false,
        locale: "",
        handsFree: false,
        wakeListening: false,
        speaking: false,
        voiceQuality: "none",
        voiceName: "",
        cloudVoiceAllowed: false,
      };
      try {
        voiceStatus = {
          ...voiceStatus,
          ...(await getVoice().call("status")),
        };
      } catch {}
      voiceStatus.cloudVoiceAllowed = cloudVoiceAllowed();
      const voiceInfo = { ...voiceStatus, kokoro: kokoroUiStatus() };
      debug("Permissions", {
        permissions: {
          screen: permissions.screen,
          accessibility: permissions.accessibility,
          microphone: voiceStatus.microphone,
          speech: voiceStatus.speech,
          onDevice: voiceStatus.onDevice,
          shortcut: voiceStatus.shortcut,
        },
      });
      return {
        desktop: true,
        platform: process.platform,
        settings,
        hasKey: !!providerKey(credentials, settings),
        credentialScopes: Object.keys(credentials),
        permissions,
        displays,
        encrypted: true,
        voice: voiceInfo,
      };
    }
    case "saveSettings": {
      const next = settingsSchema.parse(args[0]);
      validateProviderEndpoint(next);
      const nextCredentials =
        args[1] !== undefined
          ? withProviderKey(credentials, next, args[1])
          : credentials;
      // The active Runner keeps its own provider and privacy; only changes to
      // those require stopping it.
      if (
        next.provider !== settings.provider ||
        next.endpoint !== settings.endpoint ||
        next.model !== settings.model ||
        next.privacy !== settings.privacy ||
        providerKey(nextCredentials, next) !==
          providerKey(credentials, settings)
      )
        ensureIdle();
      // settings.memory is live and harmless: the active run checks it before
      // learning, and the next run decides whether to recall.
      // Protections, display and budgets apply to the active run immediately.
      const live =
        runActive() &&
        !!runner &&
        (JSON.stringify(next.protectedApps) !==
          JSON.stringify(settings.protectedApps) ||
          JSON.stringify(next.protectedDomains) !==
            JSON.stringify(settings.protectedDomains) ||
          next.displayId !== settings.displayId ||
          next.maxCost !== settings.maxCost ||
          next.maxActions !== settings.maxActions ||
          next.maxSeconds !== settings.maxSeconds);
      const handsFreeChanged = next.handsFree !== settings.handsFree;
      const voiceOutputChanged = voiceOutputKeys.some(
        (key) => next[key] !== settings[key],
      );
      const voiceEngineChanged = next.voiceEngine !== settings.voiceEngine;
      credentials = nextCredentials;
      settings = next;
      saveConfig();
      updateTray();
      if (voiceEngineChanged) {
        // A reply in the old engine may still be playing.
        await conversation.stopSpeaking();
        warmKokoro();
      }
      let applyError: unknown;
      if (live) {
        const current = runner!;
        try {
          // The tutorial never uses the native helper.
          if (!snapshot.run!.synthetic) await getNative().configure(next);
          current.updateSettings(next);
        } catch (error) {
          debug("SettingsApplyFailed", errorDetails(error));
          applyError = error;
        }
      }
      if (voiceOutputChanged && next.voiceReplies === "off")
        await conversation.stopSpeaking();
      if (handsFreeChanged || voiceOutputChanged) {
        if (handsFreeChanged && !next.handsFree) {
          cancelVoiceCapture();
          listening = false;
        }
        try {
          await getVoice().call("configure", {
            ...(handsFreeChanged ? { handsFree: next.handsFree } : {}),
            controllerPID: nativePid(),
            ...voiceOutputConfig(next),
          });
        } catch (error) {
          debug("VoiceSetupFailed", errorDetails(error));
          throw new Error(
            `Settings saved, but the voice mode could not be applied: ${
              error instanceof Error ? error.message : "try again."
            }`,
          );
        }
      }
      if (applyError)
        throw new Error(
          `Settings saved, but they could not be applied to the active run: ${
            applyError instanceof Error ? applyError.message : "try again."
          }`,
        );
      return;
    }
    case "command":
      await command(z.string().parse(args[0]));
      return;
    case "openCommand":
      await showCommand();
      return;
    case "pillState":
      return pill;
    case "dismiss":
      void conversation.stopSpeaking();
      conversation.clearFragment();
      // Only an untouched text-entry pill that a tap opened while the run was
      // working gives the run back; every other dismissal just collapses cards.
      if (pill.phase === "text" && voiceHoldResumable()) {
        cancelVoiceCapture();
        await resumeVoiceHold();
        return;
      }
      voiceHeld = false;
      // An active run keeps a visible control; dismiss only collapses cards.
      if (runActive()) renderPill(snapshot);
      else setPill({ ...idlePill });
      return;
    case "openSettings":
      showSettings(typeof args[0] === "string" ? args[0] : "settings");
      return;
    case "closeSettings":
      window.hide();
      return;
    case "voicePermissions":
      await getVoice().call("requestPermissions");
      await getVoice().call("enable");
      return;
    case "permissions":
      await getNative().request("requestPermissions");
      return;
    case "start": {
      ensureIdle();
      const task = z.string().trim().min(1).max(8000).parse(args[0]),
        tutorial = z.boolean().parse(args[1]);
      if (scanText(task).some((f) => f.action === "BLOCK_UPLOAD"))
        throw new Error(
          "Remove credentials from the task. Enter passwords manually during takeover.",
        );
      const controller = tutorial ? new TutorialController() : getNative();
      if (!tutorial) {
        await getNative().configure(settings);
        // Voice is optional for a run; typed commands still work without it.
        try {
          await getVoice().call("configure", {
            controllerPID: getNative().pid,
          });
        } catch (error) {
          debug("VoiceSetupFailed", errorDetails(error));
        }
      }
      const provider = tutorial
        ? new TutorialProvider()
        : createDesktopProvider(
            settings,
            providerKey(credentials, settings),
            debug,
          );
      const recentTasks = vault
        .list()
        .filter((r) => !r.synthetic)
        .slice(0, 3)
        .map((r) => ({ task: r.task.slice(0, 500), status: r.status }));
      runner = new Runner(
        controller,
        provider,
        vault,
        settings,
        emit,
        recentTasks,
        // The synthetic tutorial never recalls or learns.
        tutorial ? undefined : runMemory(),
      );
      voiceHeld = false;
      window.hide();
      void runner.start(task).catch((error) => {
        debug("RunStartFailed", errorDetails(error));
        setPill({
          phase: "error",
          label:
            error instanceof Error && error.message
              ? error.message
              : "The local run could not be saved.",
          transcript: "",
          canApprove: false,
        });
      });
      return;
    }
    case "pause":
      voiceHeld = false;
      runner?.pause();
      return;
    case "resume":
      voiceHeld = false;
      // Re-activating the remembered app is only needed for a held run.
      if (!runHeld()) {
        if (runActive()) renderPill(snapshot);
        return;
      }
      if (!snapshot.run!.synthetic) window.hide();
      await resumeHeldRun(runHeld);
      return;
    case "stop":
      cancelVoiceCapture();
      void conversation.stopSpeaking();
      voiceHeld = false;
      runner?.stop();
      return;
    case "confirm": {
      const yes = z.boolean().parse(args[0]);
      // A click answers: stop the spoken question and its listening window.
      void conversation.stopSpeaking();
      void voice?.call("endFollowUp").catch(() => {});
      if (!currentGate()) {
        // A stale card (the approval already went through or was withdrawn).
        // Neither answer resumes a held run.
        voiceHeld = false;
        if (runActive()) renderPill(snapshot);
        else throw new Error("Nothing to approve.");
        return;
      }
      if (yes) indicator.hide();
      await runner?.approveFromVoice(yes);
      return;
    }
    case "voices": {
      let list: { voices?: unknown; selected?: unknown } = {};
      try {
        list = await getVoice().call("voices");
      } catch (error) {
        debug("VoiceListFailed", errorDetails(error));
      }
      return {
        voices: Array.isArray(list.voices) ? list.voices : [],
        selected: typeof list.selected === "string" ? list.selected : "",
        engine: settings.voiceEngine,
        cloudAllowed: cloudVoiceAllowed(),
      };
    }
    case "previewVoice": {
      const result = await speech.preview(PHRASES.previewSample[0]);
      if (!result.accepted)
        throw new Error(
          result.reason === "disabled"
            ? "Turn on spoken replies to preview a voice."
            : "The voice preview could not play right now. Try again in a moment.",
        );
      return;
    }
    case "kokoroStatus":
      return kokoroUiStatus();
    case "downloadKokoro": {
      if (!kokoroSupported())
        throw new Error("The natural voice needs a Mac with Apple Silicon.");
      kokoroDownload ??= new AbortController();
      const controller = kokoroDownload;
      try {
        await getKokoro().download(
          (status) => sendKokoroStatus(status),
          controller.signal,
        );
      } catch (error) {
        const status = kokoroUiStatus();
        sendKokoroStatus();
        if (controller.signal.aborted) return;
        debug("KokoroDownloadFailed", {
          ...errorDetails(error),
          code: status.error,
        });
        const code = status.error ?? "";
        throw new Error(
          kokoroErrors[code] ??
            (code.startsWith("http_")
              ? "The voice download server is unavailable. Try again later."
              : "The natural voice could not be downloaded. Try again."),
        );
      } finally {
        if (kokoroDownload === controller) kokoroDownload = undefined;
      }
      sendKokoroStatus();
      return;
    }
    case "cancelKokoroDownload":
      kokoroDownload?.abort();
      kokoroDownload = undefined;
      sendKokoroStatus();
      return;
    case "removeKokoro": {
      kokoroDownload?.abort();
      kokoroDownload = undefined;
      await conversation.stopSpeaking();
      await getKokoro().remove();
      if (settings.voiceEngine === "kokoro") {
        settings = { ...settings, voiceEngine: "system" };
        saveConfig();
        refreshSettingsView();
      }
      sendKokoroStatus();
      return;
    }
    case "openVoiceSettings":
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.Accessibility-Settings.extension",
      );
      return;
    case "memorySummary":
      return summarizeMemory(memory!.data());
    case "forgetMemory":
      // A finishing run would otherwise learn into the cleared store.
      ensureIdle();
      memory!.clear();
      debug("MemoryCleared");
      return;
    case "history":
      return vault.list();
    case "loadRun": {
      const id = z.string().uuid().parse(args[0]);
      const run = vault.getRun(id),
        frames = vault.frames(id);
      return {
        run,
        frame: frames.at(-1) ?? null,
        events: vault.events(id),
        message: run.summary,
      };
    }
    case "deleteRun": {
      ensureIdle();
      const id = z.string().uuid().parse(args[0]);
      if (uploads[id])
        throw new Error(
          "Withdraw the contribution before deleting this local run.",
        );
      // What memory learned from the run goes with it, even when learning is
      // off now. Forgotten first so a failed removal can simply be retried.
      if (memory?.data().episodes.some((e) => e.id === id)) {
        memory.update((data) => forgetRunIn(data, id));
        flushMemory();
      }
      vault.remove(id);
      reviewCache.delete(id);
      return;
    }
    case "feedback": {
      const id = z.string().uuid().parse(args[0]),
        success = z.boolean().parse(args[1]),
        run = vault.getRun(id);
      if (!terminal(run.status)) throw new Error("Finish the run first.");
      run.outcome = success;
      vault.append(id, "UserOutcomeRecorded", { success });
      vault.save(run);
      return;
    }
    case "review":
      return review(z.string().uuid().parse(args[0]), args[1] as any);
    case "donate": {
      if (donationBusy) throw new Error("A contribution is already uploading.");
      const opts = reviewSchema.parse(args[0]);
      if (!settings.contributionEndpoint)
        throw new Error(
          "Configure your contribution service in Settings first.",
        );
      const { bundle } = await review(opts.runId, opts);
      donationBusy = true;
      try {
        vault.append(opts.runId, "DonationConsented", {
          level: opts.level,
          version: "2026-09-alpha-1",
        });
        const state = await uploadBundle(
          bundle,
          settings.contributionEndpoint,
          uploads[opts.runId],
          (s) => {
            uploads[opts.runId] = s;
            vault.saveContribution(opts.runId, bundle);
            saveConfig();
          },
        );
        const run = vault.getRun(opts.runId);
        run.contribution = state.receipt;
        vault.save(run);
        vault.append(opts.runId, "UploadCommitted", { receipt: state.receipt });
        return { receipt: state.receipt };
      } finally {
        donationBusy = false;
      }
    }
    case "withdraw": {
      if (donationBusy)
        throw new Error("Wait for the current upload to finish.");
      const id = z.string().uuid().parse(args[0]);
      if (!uploads[id]) throw new Error("No contribution exists.");
      vault.append(id, "DeletionRequested");
      await deleteContribution(uploads[id]);
      delete uploads[id];
      saveConfig();
      const run = vault.getRun(id);
      delete run.contribution;
      vault.save(run);
      return;
    }
    case "exportWorkflow": {
      const id = z.string().uuid().parse(args[0]);
      const receipt = uploads[id]?.receipt;
      if (!receipt)
        throw new Error(
          "Contribute the reviewed trajectory before exporting a workflow candidate.",
        );
      const bundle = vault.contribution<Bundle>(id);
      if (digest(JSON.stringify(bundle)) !== uploads[id].hash)
        throw new Error("The approved contribution checksum did not match.");
      const candidate = workflowCandidate(bundle, receipt);
      const result = await dialog.showSaveDialog(window, {
        defaultPath: "workflow-candidate.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (result.canceled || !result.filePath) return "";
      writeFileSync(result.filePath, JSON.stringify(candidate, null, 2), {
        mode: 0o600,
      });
      return result.filePath;
    }
    default:
      throw new Error("Unsupported application command.");
  }
}
/**
 * Reloads a crashed page so the pill never goes invisible: at most three
 * reloads per window per minute, then one deferred reload once the oldest
 * leaves that window (a later crash cannot be relied on to retry).
 */
function reloadRenderer(win: BrowserWindow) {
  if (shuttingDown || win.isDestroyed() || deferredReloads.has(win)) return;
  const now = Date.now(),
    recent = (rendererReloads.get(win) ?? []).filter((t) => now - t < 60000),
    delay = budgetDelay(recent, now, 3, 60000);
  rendererReloads.set(win, recent);
  if (delay) {
    const timer = setTimeout(() => {
      deferredReloads.delete(win);
      if (shuttingDown || win.isDestroyed() || !win.webContents.isCrashed())
        return;
      reloadRenderer(win);
    }, delay);
    timer.unref?.();
    deferredReloads.set(win, timer);
    return;
  }
  recent.push(now);
  void loadPage(win, win === indicator ? "pill" : "settings")
    .then(() => {
      if (win === indicator) setPill({});
    })
    .catch((error) => debug("RendererReloadFailed", errorDetails(error)));
}
function loadPage(win: BrowserWindow, hash: "settings" | "pill") {
  return process.env.COARENA_DEV === "1"
    ? win.loadURL(`http://127.0.0.1:5173/#${hash}`)
    : win.loadFile(join(__dirname, "../dist/index.html"), { hash });
}
function importLaunch(args: string[]): boolean {
  const imported = importLaunchCredentials(args, settings, credentials);
  if (!imported) return false;
  settings = imported.settings;
  credentials = imported.credentials;
  saveConfig();
  return true;
}
function launchHandsFree(args: string[]): boolean | undefined {
  if (args.includes("--no-hands-free")) return false;
  if (args.includes("--hands-free")) return true;
  return undefined;
}
async function launchCommand(args: string[]): Promise<boolean> {
  const index = args.indexOf("--command");
  if (index < 0) return false;
  const text = z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .refine(
      (value) => !value.startsWith("--"),
      "--command requires task text, not another launch flag.",
    )
    .parse(args[index + 1]);
  debug("LaunchCommand", {
    phase: voiceIntent(text).kind,
    textLength: text.length,
  });
  window.hide();
  await getNative().request("rememberForeground");
  await command(text);
  return true;
}
app.on("second-instance", async (_event, _args, _cwd, additionalData) => {
  if (!window || !root) return;
  try {
    const launch = z
      .object({ launchArgs: z.array(z.string().max(8192)).max(100) })
      .safeParse(additionalData);
    if (!launch.success) {
      showSettings();
      return;
    }
    const args = launch.data.launchArgs;
    if (args.includes("--import-env")) {
      ensureIdle();
      if (importLaunch(args)) window.webContents.reload();
    }
    if (args.includes("--natural-voice")) await useNaturalVoice();
    const handsFree = launchHandsFree(args);
    if (handsFree !== undefined) {
      await toggleHandsFree(handsFree);
      window.hide();
    }
    if (await launchCommand(args)) return;
    if (handsFree !== undefined) return;
    showSettings();
  } catch (error) {
    dialog.showErrorBox("Settings were not changed", (error as Error).message);
  }
});
app.on("activate", (_event, hasVisibleWindows) => {
  if (!hasVisibleWindows && window && !window.isDestroyed()) showSettings();
});
app
  .whenReady()
  .then(async () => {
    if (!ownsInstance) return;
    root =
      process.env.COARENA_TEST_DATA_DIR ??
      join(app.getPath("userData"), "private");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    if (
      !safeStorage.isEncryptionAvailable() ||
      (process.platform === "linux" &&
        safeStorage.getSelectedStorageBackend() === "basic_text")
    )
      throw new Error("An OS-backed secure key store is required.");
    const keyPath = join(root, "vault-key");
    if (existsSync(keyPath))
      master = Buffer.from(
        safeStorage.decryptString(readFileSync(keyPath)),
        "hex",
      );
    else {
      master = randomBytes(32);
      writeFileSync(
        keyPath,
        safeStorage.encryptString(master.toString("hex")),
        { mode: 0o600 },
      );
    }
    if (existsSync(join(root, "config.enc"))) {
      const c = JSON.parse(
        unseal(
          master,
          readFileSync(join(root, "config.enc")),
          "config",
        ).toString(),
      );
      settings = settingsSchema.parse(c.settings);
      credentials = readCredentials(c.credentials);
      if (typeof c.providerKey === "string" && c.providerKey)
        credentials = withProviderKey(credentials, settings, c.providerKey);
      uploads = c.uploads ?? {};
    }
    const handsFree = launchHandsFree(process.argv);
    if (handsFree !== undefined) {
      settings = { ...settings, handsFree };
      saveConfig();
    }
    let imported = false;
    try {
      imported = importLaunch(process.argv);
    } catch (error) {
      dialog.showErrorBox(
        "API keys were not imported",
        (error as Error).message,
      );
    }
    vault = new Vault(join(root, "runs"), master);
    // Sealed with the vault key (AAD "memory"); nothing is stored in plaintext.
    memory = new MemoryStore(join(root, "memory"), master, undefined, {
      onError: (error) => debug("MemoryStoreFailed", errorDetails(error)),
    });
    if (process.env.COARENA_DIAGNOSTICS === "1") {
      diagnostics = new LocalDiagnostics(
        process.env.COARENA_DIAGNOSTICS_DIR ?? join(root, "diagnostics"),
        () => Object.values(credentials),
        undefined,
        undefined,
        process.env.COARENA_DIAGNOSTICS_VERBOSE === "1",
      );
      debug("AppStarted", {
        provider: settings.provider,
        model: settings.model,
        pid: process.pid,
      });
      diagnosticHeartbeat = setInterval(
        () =>
          debug("Heartbeat", {
            status: snapshot.run?.status ?? "idle",
            actions: snapshot.run?.actions ?? 0,
            frames: snapshot.run?.frames ?? 0,
          }),
        20000,
      );
      diagnosticHeartbeat.unref();
    }
    vault.recover();
    window = new BrowserWindow({
      width: 470,
      height: 670,
      minWidth: 430,
      minHeight: 450,
      show: false,
      title: "Open Assist · Settings",
      backgroundColor: "#101010",
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 17, y: 17 },
      webPreferences: {
        preload: join(__dirname, "preload.cjs"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    });
    indicator = new BrowserWindow({
      width: 340,
      height: 94,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      hasShadow: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      backgroundColor: "#00000000",
      webPreferences: {
        preload: join(__dirname, "preload.cjs"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    });
    indicator.setAlwaysOnTop(true, "floating");
    indicator.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    for (const win of [window, indicator]) {
      win.webContents.on("render-process-gone", (_event, details) => {
        debug("RendererGone", {
          reason: details.reason,
          exitCode: details.exitCode,
        });
        if (
          shuttingDown ||
          win.isDestroyed() ||
          details.reason === "clean-exit"
        )
          return;
        reloadRenderer(win);
      });
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      win.webContents.on("will-navigate", (e) => e.preventDefault());
    }
    session.defaultSession.setPermissionRequestHandler(
      (_wc, _permission, callback) => callback(false),
    );
    ipcMain.handle("coarena", async (event, method, args) => {
      const main =
        event.sender === window.webContents &&
        event.senderFrame === window.webContents.mainFrame;
      const overlay =
        event.sender === indicator.webContents &&
        event.senderFrame === indicator.webContents.mainFrame &&
        [
          "pause",
          "resume",
          "stop",
          "confirm",
          "command",
          "openCommand",
          "dismiss",
          "pillState",
          "openSettings",
        ].includes(method);
      if (!main && !overlay) throw new Error("Invalid IPC sender.");
      if (typeof method !== "string" || !Array.isArray(args))
        throw new Error("Invalid command.");
      try {
        return await dispatch(method, args);
      } catch (error) {
        debug("CommandFailed", { method, ...errorDetails(error) });
        // The overlay cannot resize itself; main owns every visible pill error.
        if (!main && method !== "pillState")
          showFailure(
            error instanceof Error ? error.message : "Something went wrong.",
          );
        throw error;
      }
    });
    await loadPage(window, "settings");
    await loadPage(indicator, "pill");
    const bitmap = Buffer.alloc(18 * 18 * 4);
    for (let y = 0; y < 18; y++)
      for (let x = 0; x < 18; x++) {
        const radius = Math.hypot(x - 8.5, y - 8.5);
        const angle = Math.atan2(y - 8.5, x - 8.5) + Math.PI;
        if (
          radius < 1.2 ||
          (radius > 6.2 && radius < 7.5 && angle % 1.57 < 1.2) ||
          (radius > 3.3 && radius < 4.3 && angle % 1.57 < 1)
        ) {
          const i = (y * 18 + x) * 4;
          bitmap[i + 3] = 255;
        }
      }
    const icon = nativeImage.createFromBitmap(bitmap, {
      width: 18,
      height: 18,
    });
    icon.setTemplateImage(true);
    tray = new Tray(icon);
    tray.setTitle("Assist");
    updateTray();
    debug("TrayReady", { geometry: tray.getBounds() });
    globalShortcut.register("CommandOrControl+Shift+Space", () => {
      void showCommand();
    });
    globalShortcut.register("Control+Alt+Escape", () => {
      cancelVoiceCapture();
      void conversation.stopSpeaking();
      voiceHeld = false;
      runner?.stop("Stopped.");
      setPill({
        phase: "done",
        label: "Stopped.",
        transcript: "",
        canApprove: false,
      });
    });
    window.on("close", (e) => {
      if (!shuttingDown) {
        e.preventDefault();
        window.hide();
      }
    });
    app.dock?.hide();
    if (imported || !existsSync(join(root, "config.enc"))) showSettings();
    if (process.platform === "darwin") void configureVoice();
    if (process.argv.includes("--natural-voice")) void useNaturalVoice();
    try {
      await launchCommand(process.argv);
    } catch (error) {
      debug("LaunchCommandFailed", errorDetails(error));
      setPill({
        phase: "error",
        label: (error as Error).message,
        transcript: "",
        canApprove: false,
      });
    }
    // After any launch command, which would otherwise queue behind it; a run
    // that command started skips it.
    prewarmIndex();
  })
  .catch(() => {
    dialog.showErrorBox(
      "Open Assist could not start",
      "The encrypted local store could not be opened. Ensure the OS keychain is available. No unencrypted history was created.",
    );
    app.quit();
  });
app.on("window-all-closed", () => app.quit());
// A run stopped during before-quit may learn afterwards; write that too.
app.on("will-quit", () => {
  flushMemory();
  try {
    kokoro?.dispose();
  } catch {}
});
app.on("before-quit", () => {
  if (shuttingDown) return;
  shuttingDown = true;
  debug("AppStopping");
  clearInterval(diagnosticHeartbeat);
  for (const timer of deferredReloads.values()) clearTimeout(timer);
  deferredReloads.clear();
  runner?.stop();
  flushMemory();
  native?.close();
  voice?.close();
  tray?.destroy();
  globalShortcut.unregisterAll();
});
