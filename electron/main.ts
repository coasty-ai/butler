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
import { Runner, terminal } from "../src/core/runner";
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
import { NativeController } from "./controller";
import { NativeVoice, type VoiceEvent } from "./voice";
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
const debug: DiagnosticSink = (event, data = {}) =>
  trace(diagnostics?.write, event, { runId: snapshot.run?.id, ...data });
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
        if (shuttingDown) return;
        if (!snapshot.run || terminal(snapshot.run.status)) return;
        cancelVoiceCapture();
        runner?.stop("Native emergency stop activated.");
        setPill({
          phase: "done",
          label: "Stopped.",
          transcript: "",
          canApprove: false,
        });
      },
      () => runner?.manualTakeover(),
      debug,
    );
  }
  return native;
}
function setPill(update: Partial<PillState>, focus = false) {
  clearTimeout(hideTimer);
  pill = { ...pill, ...update };
  if (!indicator || indicator.isDestroyed()) return;
  indicator.webContents.send("pill", pill);
  const expanded = ["text", "approval", "error"].includes(pill.phase);
  const area = screen.getPrimaryDisplay().workArea;
  const width = expanded ? 460 : 340,
    height = expanded
      ? 190
      : pill.phase === "listening" && pill.transcript
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
  if (pill.phase === "done")
    hideTimer = setTimeout(() => {
      pill = { ...idlePill };
      indicator.hide();
    }, 1800);
}
async function toggleHandsFree(enabled = !settings.handsFree) {
  if (!enabled) cancelVoiceCapture();
  await getVoice().call("configure", {
    handsFree: enabled,
    controllerPID: getNative().pid,
  });
  settings = { ...settings, handsFree: enabled };
  if (!enabled) {
    listening = false;
    runner?.pause();
    setPill({
      phase: "done",
      label: "Hands-free off.",
      transcript: "",
      canApprove: false,
    });
  }
  saveConfig();
  updateTray();
  window.webContents.reload();
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
    voice = new NativeVoice(binary, (event) => void receiveVoice(event), debug);
  }
  return voice;
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
async function showCommand() {
  cancelVoiceCapture();
  voiceGate = currentGate();
  runner?.interruptForVoice();
  try {
    await getNative().request("rememberForeground");
  } catch {}
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
async function receiveVoice(event: VoiceEvent) {
  if (!["transcript_partial", "audio_level"].includes(event.event))
    debug("VoiceEvent", {
      phase: event.event,
      textLength: event.text?.length ?? event.textLength,
      source: event.source,
      confidence: event.confidence,
      enabled: event.enabled,
      listening: event.listening,
      error: event.message,
    });
  try {
    if (event.event === "wake_status") {
      wakeListening = event.listening === true;
      updateTray();
    } else if (
      event.event === "shortcut_down" ||
      event.event === "wake_detected"
    ) {
      voiceGate = currentGate();
      listening = true;
      runner?.interruptForVoice();
      // Final recognition also waits for context, even if it arrives immediately.
      const invocation = ++voiceInvocation;
      voiceContext = getNative().request("rememberForeground");
      await voiceContext;
      if (!listening || invocation !== voiceInvocation) return;
      setPill({
        phase: "listening",
        label: "Listening…",
        transcript: "",
        detail: undefined,
        canApprove: false,
        inputLevel: 0,
      });
    } else if (event.event === "shortcut_tap") {
      listening = false;
      await showCommand();
    } else if (event.event === "shortcut_up") {
      if (listening)
        setPill({ phase: "working", label: "On it.", inputLevel: 0 });
    } else if (event.event === "transcript_partial") {
      if (listening) setPill({ transcript: event.text ?? "" });
    } else if (event.event === "audio_level") {
      pill.inputLevel = event.level ?? 0;
      indicator.webContents.send("pill", pill);
    } else if (event.event === "voice_control") {
      if (!listening) return;
      if (event.command?.startsWith("stop")) runner?.stop("Stopped.");
      else runner?.pause();
    } else if (event.event === "voice_cancelled") {
      listening = false;
      voiceInvocation += 1;
      runner?.stop("Stopped.");
      setPill({
        phase: "done",
        label: "Stopped.",
        transcript: "",
        canApprove: false,
      });
    } else if (
      event.event === "transcript_final" ||
      event.event === "transcript_recovered"
    ) {
      if (!listening) return;
      listening = false;
      const invocation = voiceInvocation;
      await voiceContext;
      if (invocation !== voiceInvocation) return;
      await command(event.text ?? "", true, voiceCommandConfidence(event));
    } else if (event.event === "voice_error" || event.event === "wake_error") {
      listening = false;
      setPill({
        phase: "error",
        label: event.message ?? "Try again.",
        canApprove: false,
        inputLevel: 0,
      });
    }
  } catch (error) {
    listening = false;
    setPill({
      phase: "error",
      label: error instanceof Error ? error.message : "Something went wrong.",
      canApprove: false,
    });
  }
}
async function command(text: string, fromVoice = false, confidence = 1) {
  text = z.string().trim().min(1).max(2000).parse(text);
  if (!fromVoice) {
    cancelVoiceCapture();
    indicator.hide();
  }
  const intent = voiceIntent(text),
    active = !!snapshot.run && !terminal(snapshot.run.status);
  if (intent.kind === "stop") {
    runner?.stop("Stopped.");
    setPill({
      phase: "done",
      label: "Stopped.",
      transcript: "",
      canApprove: false,
    });
    return;
  }
  if (intent.kind === "pause") {
    runner?.pause();
    setPill({
      phase: "paused",
      label: "Paused.",
      transcript: settings.handsFree
        ? "Say ‘Hey Assist, continue’."
        : "Hold ⌥ Space to continue.",
      canApprove: false,
    });
    return;
  }
  if (intent.kind === "approve" || intent.kind === "decline") {
    if (!currentGate()) throw new Error("Nothing to approve.");
    if (
      fromVoice &&
      (!voiceGate || voiceGate !== currentGate() || confidence < 0.65)
    )
      throw new Error("Tap once to approve.");
    await runner!.approveFromVoice(intent.kind === "approve");
    voiceGate = undefined;
    if (intent.kind === "decline") return;
    setPill({
      phase: "working",
      label: "On it.",
      transcript: "",
      canApprove: false,
    });
    return;
  }
  if (intent.kind === "resume") {
    if (!active) throw new Error("Nothing to resume.");
    if (!snapshot.run?.synthetic) {
      indicator.hide();
      await native?.request("restore");
    }
    await runner?.resume();
    return;
  }
  if (!(snapshot.run?.synthetic && !terminal(snapshot.run.status))) {
    indicator.hide();
    await native?.request("restoreRemembered");
  }
  if (active) {
    setPill({
      phase: "working",
      label: "Got it.",
      transcript: "",
      canApprove: false,
    });
    await runner!.revise(text);
  } else {
    setPill({
      phase: "working",
      label: "On it.",
      transcript: "",
      canApprove: false,
    });
    await dispatch("start", [text, false]);
  }
}
function emit(s: Snapshot) {
  snapshot = s;
  diagnostics?.snapshot(s);
  if (window && !window.isDestroyed()) window.webContents.send("snapshot", s);
  if (listening) return;
  const status = s.run?.status;
  if (!status) return;
  const common = { synthetic: !!s.run?.synthetic, inputLevel: 0 };
  if (status === "confirming")
    setPill({
      ...common,
      phase: "approval",
      label: s.pending?.reason ?? "Approve this action?",
      detail: s.pending ? describeAction(s.pending.action) : undefined,
      transcript: "Hold ⌥ Space and say “yes”, or click once.",
      canApprove: true,
    });
  else if (status === "paused" || status === "takeover")
    setPill({
      ...common,
      phase: "paused",
      label:
        status === "takeover" || s.message.includes("you’re controlling")
          ? s.message
          : "Paused.",
      transcript: "Hold ⌥ Space to steer or continue.",
      canApprove: false,
    });
  else if (status === "completed")
    setPill({
      ...common,
      phase: "done",
      label: "Done.",
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
      label: s.frame?.context?.appName
        ? `Working in ${s.frame.context.appName}`
        : "Working…",
      transcript: "",
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
      };
      try {
        voiceStatus = await getVoice().call("status");
      } catch {}
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
        voice: voiceStatus,
      };
    }
    case "saveSettings": {
      ensureIdle();
      const next = settingsSchema.parse(args[0]);
      validateProviderEndpoint(next);
      if (args[1] !== undefined) {
        credentials = withProviderKey(credentials, next, args[1]);
      }
      if (next.handsFree !== settings.handsFree)
        await getVoice().call("configure", {
          handsFree: next.handsFree,
          controllerPID: getNative().pid,
        });
      settings = next;
      saveConfig();
      updateTray();
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
      setPill({ ...idlePill });
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
        await getVoice().call("configure", { controllerPID: getNative().pid });
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
      );
      window.hide();
      void runner.start(task).catch(() =>
        setPill({
          phase: "error",
          label: "The local run could not be saved.",
          canApprove: false,
        }),
      );
      return;
    }
    case "pause":
      runner?.pause();
      return;
    case "resume":
      if (snapshot.run && !snapshot.run.synthetic) {
        window.hide();
        indicator.hide();
        await getNative().request("restore");
      }
      await runner?.resume();
      return;
    case "stop":
      cancelVoiceCapture();
      runner?.stop();
      return;
    case "confirm": {
      const yes = z.boolean().parse(args[0]);
      if (yes) indicator.hide();
      await runner?.approveFromVoice(yes);
      return;
    }
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
    if (process.env.COARENA_DIAGNOSTICS === "1") {
      diagnostics = new LocalDiagnostics(
        process.env.COARENA_DIAGNOSTICS_DIR ?? join(root, "diagnostics"),
        () => Object.values(credentials),
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
      win.webContents.on("render-process-gone", (_event, details) =>
        debug("RendererGone", {
          reason: details.reason,
          code: String(details.exitCode),
        }),
      );
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
        throw error;
      }
    });
    if (process.env.COARENA_DEV === "1") {
      await window.loadURL("http://127.0.0.1:5173/#settings");
      await indicator.loadURL("http://127.0.0.1:5173/#pill");
    } else {
      await window.loadFile(join(__dirname, "../dist/index.html"), {
        hash: "settings",
      });
      await indicator.loadFile(join(__dirname, "../dist/index.html"), {
        hash: "pill",
      });
    }
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
    if (process.platform === "darwin") {
      void getVoice()
        .call("enable")
        .catch(() => {});
      void getVoice()
        .call("configure", {
          handsFree: settings.handsFree,
          controllerPID: getNative().pid,
        })
        .catch((error) => debug("VoiceSetupFailed", errorDetails(error)));
    }
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
  })
  .catch(() => {
    dialog.showErrorBox(
      "Open Assist could not start",
      "The encrypted local store could not be opened. Ensure the OS keychain is available. No unencrypted history was created.",
    );
    app.quit();
  });
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  if (shuttingDown) return;
  shuttingDown = true;
  debug("AppStopping");
  clearInterval(diagnosticHeartbeat);
  runner?.stop();
  native?.close();
  voice?.close();
  tray?.destroy();
  globalShortcut.unregisterAll();
});
