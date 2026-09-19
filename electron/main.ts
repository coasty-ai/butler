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
  systemPreferences,
  powerSaveBlocker,
} from "electron";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
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
  kokoroVoices,
  settingsSchema,
  type Frame,
  type Run,
  type RunOrigin,
  type Settings,
  type Snapshot,
  type TaskSource,
  type WatchContext,
} from "../src/core/schema";
import {
  MANUAL_PAUSE_MESSAGE,
  Runner,
  TARGET_HANDOFF_MESSAGE,
  terminal,
  type ApprovalSource,
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
import { networkFailure } from "../src/providers/network";
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
import { createAgenda, withAgenda } from "./agenda";
import type { MemoryAccess, SystemIndex } from "../src/core/memory";
import {
  privacyPanes,
  privacySettingsRoot,
  providerKeyMessage,
  summarizeMemory,
  usableOllamaModels,
  type OllamaStatus,
  type PrivacyPane,
  type SetupStatus,
} from "../src/ui/api";
import { NativeController, budgetDelay } from "./controller";
import {
  NativeVoice,
  approvalHint,
  continueHint,
  pausedLabel,
  type VoiceEvent,
} from "./voice";
import { Conversation, ANSWER_WINDOW, type ReplyHandle } from "./conversation";
import { AssistantSession, DIALOG_LIMITS } from "./assistant";
import {
  dialogEligible,
  fastStartLine,
  turnFiller,
} from "../src/assistant/arbitrate";
import { textSettings } from "../src/providers/text";
import {
  MessagesChannel,
  createMessagesHelper,
  importEnvHandle,
  resumeFromText,
  validateMessageSettings,
} from "./messages";
import {
  createSpeechOutput,
  kokoroSpeed,
  selectSpeechEngine,
  type KokoroSpeakOptions,
} from "./speech-output";
import { desktopTransport } from "./provider";
import {
  createKokoroVoice,
  kokoroSupported,
  pickKokoroStatus,
  type KokoroChunk,
  type KokoroStatus,
  type KokoroVoice,
} from "./kokoro/client";
import { credentialScope, providerDefaults } from "../src/providers/catalog";
import {
  APPROVAL_MIN_CONFIDENCE,
  isWakePhraseOnly,
  planVoiceTurn,
  transcriptRequest,
  type TurnPlan,
  type TurnPlanKind,
} from "../src/voice/turns";
import { runView, statusLine } from "../src/assistant/run-view";
import type {
  Channel,
  ProgressFacts,
  ProgressReport,
  ProgressSink,
  RunView,
  TurnDecision,
  WatchState,
} from "../src/assistant/types";
import { PRESENCE_REFRESH_MS, createPresenceService } from "./presence";
import { ProgressReporter, createProgressSummarizer } from "./progress";
import { KeepAwake } from "./power";
import { RemoteServer } from "./remote/server";
import { createTailscaleProvider } from "./remote/tailscale";
import { remoteApprovalTier, validateRemoteSettings } from "../src/remote/auth";
import { remoteTurnReply } from "../src/remote/protocol";
import { TASK_QUEUE_MAX, TaskQueue } from "./task-queue";
import {
  HeldNews,
  WatchManager,
  droppedLine,
  factsLine,
  fallbackReport,
  handoffNotes,
  relayLine,
  wakeTask,
  type FactsHint,
  type RelayGone,
  type RelayRequest,
  type WakeCause,
  type WakeContext,
  type WatchChain,
} from "./watch";
import { PHRASES, allAssistantPhrases } from "../src/voice/phrases";
import { speakableSummary } from "../src/voice/speakable";
import {
  importLaunchCredentials,
  jevKey,
  providerKey,
  readCredentials,
  withJevKey,
  withProviderKey,
  type Credentials,
} from "./credentials";
import {
  jevSettingsToSave,
  launchDecideWithJev,
  migrateDecisions,
} from "./jev";
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
/** The latest partial transcript, for the early dialog request. */
let lastPartial = "";
// A short acknowledgement shown under the working pill.
let notice = { text: "", until: 0 };
/** How long a status or queue answer stays on the working pill. */
const NOTICE_MS = 4000;
/**
 * Tasks waiting for the current run: "after that, …" by voice, a texted task
 * while something runs. Drained two seconds after a run ends; a user's stop
 * empties it.
 */
const taskQueue = new TaskQueue();
/** The most recent run that ended, for "how's it going?" while idle. */
let lastFinished: Run | undefined;
let drainTimer: ReturnType<typeof setTimeout> | undefined;
const QUEUE_DRAIN_MS = 2000;
const QUEUE_DRAIN_ATTEMPTS = 15;
// True while a plan stops one run to start another itself: the stop's end
// must not drain the queue into the gap, or the plan's own start would fail.
let queueHeld = false;
let presenceTimer: ReturnType<typeof setInterval> | undefined;
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
    // status() also carries the per-voice map; the renderer's key list is fixed.
    return { ...pickKokoroStatus(status ?? getKokoro().status()), supported };
  } catch {
    return { ...empty, supported };
  }
}
function sendKokoroStatus(status?: KokoroStatus) {
  if (window && !window.isDestroyed())
    window.webContents.send("kokoro-status", kokoroUiStatus(status));
}
/** The Kokoro voice pack and speed the settings ask for. */
function kokoroOptions(): KokoroSpeakOptions {
  return {
    voice: settings.kokoroVoice,
    speed: kokoroSpeed(settings.voiceRate),
  };
}
/**
 * The Kokoro client as increment 3B widens it: synthesize() and warm() take
 * the voice and speed. Until it lands the extra argument is simply ignored.
 */
function kokoroClient() {
  const voice = getKokoro();
  return {
    status: () => voice.status(),
    warm: voice.warm.bind(voice) as (
      phrases?: readonly string[],
      o?: KokoroSpeakOptions,
    ) => Promise<void>,
    synthesize: voice.synthesize.bind(voice) as (
      text: string,
      signal?: AbortSignal,
      o?: KokoroSpeakOptions,
    ) => AsyncIterable<KokoroChunk>,
  };
}
/** Starts the natural voice worker ahead of a reply when it is the engine. */
function warmKokoro() {
  if (settings.voiceEngine !== "kokoro" || !kokoroSupported()) return;
  const voice = kokoroClient();
  if (!voice.status().installed) return;
  void voice
    // Only the short fixed replies are worth pre-synthesizing.
    .warm(
      allAssistantPhrases().filter((phrase) => phrase.length <= 28),
      kokoroOptions(),
    )
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
/**
 * First run (docs/MODULARITY.md §6). macOS applies a Screen Recording grant
 * only to a process started after it: this process keeps the decision it was
 * launched with for its whole life. Remember that decision so the checklist
 * says "restart needed" instead of showing a tick over a build that cannot
 * capture. `screenSeenDenied` also catches a revoke-and-regrant while running.
 */
let screenSeenDenied = false;
function readScreenAtLaunch() {
  if (process.platform !== "darwin") return;
  try {
    screenSeenDenied =
      systemPreferences.getMediaAccessStatus("screen") !== "granted";
  } catch {
    // Unknown is not "denied": never invent a restart the user does not need.
    screenSeenDenied = false;
  }
}
/** The last local Ollama probe, reused by the polled setup status. */
let ollamaProbe: { at: number; status: OllamaStatus } | undefined;
/** Bounded read; a provider body is inspected for one marker, never echoed. */
async function readBounded(response: Response, limit: number) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const parts: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    parts.push(value);
    if (bytes >= limit) {
      await reader.cancel();
      break;
    }
  }
  return Buffer.concat(parts).toString("utf8").slice(0, limit);
}
/**
 * Is a local Ollama reachable, and which of its models could the loop use?
 * The candidate settings go through `validateProviderEndpoint` first, so this
 * is the same PRIVATE_LOCAL rule the run loop uses rather than a second,
 * weaker definition of "local".
 */
async function probeOllama(): Promise<OllamaStatus> {
  const candidate: Settings = {
    ...settings,
    provider: "ollama",
    privacy: "PRIVATE_LOCAL",
    endpoint:
      settings.provider === "ollama"
        ? settings.endpoint
        : providerDefaults.ollama.endpoint,
    model: providerDefaults.ollama.model,
  };
  const url = validateProviderEndpoint(candidate);
  try {
    const response = await desktopTransport(debug)(`${url.origin}/api/tags`, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return { running: true, models: [] };
    }
    const body = JSON.parse((await readBounded(response, 262144)) || "{}");
    const names = Array.isArray(body?.models)
      ? body.models.map((m: { name?: unknown }) => m?.name)
      : [];
    return { running: true, models: usableOllamaModels(names) };
  } catch (error) {
    debug("OllamaProbeFailed", errorDetails(error));
    return { running: false, models: [] };
  }
}
/** A probe at most every 8 s; `setupStatus` is polled every 2 s. */
async function ollamaStatus(fresh = false): Promise<OllamaStatus> {
  if (!fresh && ollamaProbe && Date.now() - ollamaProbe.at < 8000)
    return ollamaProbe.status;
  const status = await probeOllama().catch(
    () => ({ running: false, models: [] }) as OllamaStatus,
  );
  ollamaProbe = { at: Date.now(), status };
  return status;
}
/** One short line naming the chosen model; never a key or a response body. */
async function modelStatus(): Promise<SetupStatus["model"]> {
  if (settings.provider === "ollama") {
    const local = await ollamaStatus();
    if (!local.running)
      return {
        kind: "ollama",
        ready: false,
        detail: "Ollama is not running on this Mac.",
      };
    const ready = local.models.includes(settings.model);
    return {
      kind: "ollama",
      ready,
      detail: ready
        ? `${settings.model} is installed and runs on this Mac.`
        : `Ollama is running, but ${settings.model} is not installed yet.`,
    };
  }
  const ready = !!providerKey(credentials, settings);
  return {
    kind: ready ? "cloud" : "none",
    ready,
    detail: ready
      ? `${settings.model} · ${settings.provider}, using your own key.`
      : `${settings.model} · ${settings.provider} needs your API key.`,
  };
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
    synthesize: (text, signal, o) => kokoroClient().synthesize(text, signal, o),
  },
});
/** Calendar and Reminders, read by their own helper with the user's permission. */
let agendaClient: ReturnType<typeof createAgenda> | undefined;
function getAgenda() {
  agendaClient ??= createAgenda(
    app.isPackaged
      ? join(process.resourcesPath, "coarena-agenda")
      : join(app.getAppPath(), "native/bin/coarena-agenda"),
  );
  return agendaClient;
}
/** The iMessage helper binary, packaged beside the other helpers. */
function messagesBinary() {
  return app.isPackaged
    ? join(process.resourcesPath, "coarena-messages")
    : join(app.getAppPath(), "native/bin/coarena-messages");
}
/**
 * Texting: updates about a run, and the short command vocabulary (status,
 * stop, pause, continue, do <task>). Approvals never happen by text.
 */
const messages = new MessagesChannel({
  settings: () => settings,
  helper: (onChanged) =>
    createMessagesHelper(messagesBinary(), { diagnostics: debug, onChanged }),
  startTask: async (task) => {
    ensureIdle();
    try {
      await getNative().request("rememberForeground");
    } catch {}
    // Texted words are the owner's own; the run remembers it came by text.
    await dispatch("start", [
      task,
      false,
      { origin: "message", taskSource: "user_words" },
    ]);
  },
  control: {
    pause: () => {
      voiceHeld = false;
      runner?.pause();
    },
    stop: () => {
      cancelVoiceCapture();
      void conversation.stopSpeaking();
      voiceHeld = false;
      taskQueue.clear();
      stopWatches();
      runner?.stop();
    },
    resume: () => {
      voiceHeld = false;
      // The texted reply says "Continuing." only when this is true.
      return resumeFromText(runHeld, resumeHeldRun);
    },
  },
  trace: debug,
});
const conversation = new Conversation({
  settings: () => settings,
  speech,
  voiceCall,
  trace: debug,
  onChange: () => refreshSpeechPill(),
  // The user took the floor: a reply still being written must not speak,
  // and a turn still being decided must not act.
  onInterrupted: () => {
    abortTurn();
    assistant.interrupt();
  },
  // With "model" set but no usable model, narration and fixed lines stay.
  modelActive: () => assistant.available("voice"),
});
/** The turn whose decision is in flight; aborted when the user takes the floor. */
let turnAbort: AbortController | undefined;
function abortTurn() {
  turnAbort?.abort();
  turnAbort = undefined;
}
/**
 * The dialog model behind free-form turns. It sees the sanitized run view,
 * the short thread and, when the user asks about them, recent
 * notifications; never a screenshot, never an approval's action.
 */
const assistant = new AssistantSession({
  settings: () => settings,
  providerKey: () => providerKey(credentials, textSettings(settings)),
  // The opt-in Jev decider's own key; the setting alone never turns it on.
  jevKey: () => jevKey(credentials),
  fetch: desktopTransport(debug),
  view: currentRunView,
  context: dialogContext,
  heldByVoice: () => voiceHoldResumable(),
  // A dialog turn during a run spends that run's budget.
  addUsage: (usage) => runner?.addUsage(usage),
  trace: debug,
});
/** The agenda as last read, refreshed off the critical path at activation. */
let agendaLines: string[] | undefined;
function warmAgenda() {
  if (!settings.agenda) {
    agendaLines = undefined;
    return;
  }
  void getAgenda()
    .read()
    .then((lines) => {
      agendaLines = lines;
    })
    .catch(() => {});
}
/** Screen context from the last frame, only while it is recent. */
function frameContext() {
  const context = snapshot.frame?.context;
  if (!context) return undefined;
  const last = snapshot.events.at(-1)?.wall_clock_timestamp;
  const at = last ? Date.parse(last) : NaN;
  return Number.isFinite(at) && Date.now() - at < 10 * 60_000
    ? context
    : undefined;
}
function dialogContext() {
  const context = settings.notifications ? frameContext() : undefined;
  return {
    agenda: settings.agenda ? agendaLines : undefined,
    notifications: context?.notifications,
    openApps: context?.openApps,
  };
}
/**
 * Who is at the Mac. Asks the helper only while one exists (a run needed it
 * already), and treats a helper without the method as "unknown".
 */
const presence = createPresenceService({
  request: (method) =>
    native ? native.request(method) : Promise.reject(new Error("No helper.")),
  agentInputAt: lastAgentInputAt,
});
/** When the run last posted input itself, which resets the Mac's idle time. */
function lastAgentInputAt(): number | undefined {
  if (!runActive()) return undefined;
  for (let i = snapshot.events.length - 1; i >= 0; i--)
    if (snapshot.events[i].type === "ActionExecuted") {
      const at = Date.parse(snapshot.events[i].wall_clock_timestamp);
      return Number.isFinite(at) ? at : undefined;
    }
  return undefined;
}
/**
 * Every channel that delivers progress updates, and the one reporter that
 * writes them (electron/progress.ts): it follows the run through emit(),
 * summarizes on the dialog model and charges the run's budget.
 */
const progressSinks: ProgressSink[] = [conversation, messages];
const reporter = new ProgressReporter({
  settings: () => settings,
  presence,
  summarize: createProgressSummarizer({
    settings: () => textSettings(settings),
    key: () => providerKey(credentials, settings),
    fetch: desktopTransport(debug),
    trace: debug,
  }),
  addUsage: (runId, usage) => {
    if (snapshot.run?.id === runId) runner?.addUsage(usage);
  },
  sinks: progressSinks,
  trace: debug,
});
/** Holds the display awake during runs and watches when keepAwake is on. */
const power = new KeepAwake({
  settings: () => settings,
  blocker: () => powerSaveBlocker,
  trace: debug,
});
/** The sanitized view of the run every channel answers from. */
function currentRunView() {
  const now = Date.now();
  return runView(snapshot, {
    queued: taskQueue.list(now),
    watches: watchers.list(),
    lastFinished,
    now,
    // The activation that asked paused the run to listen; it goes on once
    // answered, so the answer must not call it paused.
    heldByVoice: voiceHoldResumable(),
  });
}
/** The fixed status line every channel answers "how's it going?" with. */
function statusText() {
  return statusLine(currentRunView());
}
/**
 * The phone remote over the user's own tailnet (docs/REMOTE.md): plain
 * lines and controls from a phone the user allowed in Settings, and routine
 * approvals only from a phone armed for them, never for restricted questions.
 * Every callback is lazy: root and master exist by the time it configures.
 */
const remote = new RemoteServer({
  settings: () => settings,
  persist: (patch) => {
    settings = { ...settings, ...patch };
    saveConfig();
    updateTray();
    refreshSettingsView();
  },
  identity: createTailscaleProvider({ trace: debug }),
  // The page's certificate, sealed with the vault key like the config.
  certStore: {
    load: () => {
      const path = join(root, "remote-cert.enc");
      return existsSync(path)
        ? unseal(master, readFileSync(path), "remote-cert").toString()
        : undefined;
    },
    save: (record) => {
      const path = join(root, "remote-cert.enc");
      writeFileSync(
        path + ".tmp",
        seal(master, Buffer.from(record), "remote-cert"),
        { mode: 0o600 },
      );
      renameSync(path + ".tmp", path);
    },
  },
  converse: steerFromRemote,
  control: {
    pause: () => {
      voiceHeld = false;
      runner?.pause();
    },
    stop: () => {
      cancelVoiceCapture();
      void conversation.stopSpeaking();
      voiceHeld = false;
      taskQueue.clear();
      runner?.stop();
    },
    resume: () => {
      voiceHeld = false;
      return resumeFromText(runHeld, resumeHeldRun);
    },
    approve: approveFromRemote,
    gate: () => currentGate(),
  },
  presence: () => presence.current(),
  runView: currentRunView,
  snapshot: () => snapshot,
  thumbnail: remoteThumbnail,
  trace: debug,
});
progressSinks.push(remote);
/**
 * A phone's line, routed like typed text with nobody at the screen: the
 * router never approves from it, and a "no" only pauses. The reply is the
 * fixed line for the plan; status answers come from the run view.
 */
async function steerFromRemote(
  text: string,
): Promise<{ plan: TurnPlanKind; reply?: string; error?: string }> {
  const gate = currentGate();
  // The same deterministic router first: a phone can never approve (the
  // router answers needClick "channel"), and a "yes" to the assistant's open
  // offer is accepted only when no approval is pending.
  const base = planVoiceTurn({
    text,
    confidence: 1,
    source: "remote",
    gateMatches: !!gate,
    now: Date.now(),
    run: planRun(),
    proposal: assistant.proposal(),
  });
  debug("TurnPlanned", {
    plan: base.kind,
    source: "remote",
    textLength: text.length,
  });
  const accepted =
    (base.kind === "start" || base.kind === "queue") &&
    base.taskSource === "proposal";
  if (accepted) assistant.noteUser(text, "remote");
  let plan: TurnPlan = base;
  let decision: TurnDecision | undefined;
  let modelReply: string | undefined;
  // Then the conversational core, as for typed text: it answers questions,
  // grounds tasks in the phone's words and offers what it cannot ground.
  if (!accepted && dialogEligible(base) && assistant.available("remote")) {
    decision = await assistant.decide({
      turnId: randomUUID(),
      text,
      base,
      run: planRun(),
      view: currentRunView(),
      channel: "remote",
      confidence: 1,
      signal: AbortSignal.timeout(20_000),
    });
    if (decision.code !== "interrupted") {
      plan = decision.plan;
      if (decision.sentences)
        modelReply = await collectReply(decision.sentences);
    }
  }
  const ctx: PlanCtx = {
    origin: "remote",
    channel: "remote",
    taskSource: accepted ? "proposal" : (decision?.taskSource ?? "user_words"),
    replyText:
      plan.kind === "status" ? (modelReply ?? statusText()) : modelReply,
  };
  const outcome = await executePlan(plan, ctx);
  if (!outcome.ok) return { plan: plan.kind, error: outcome.error };
  const reply = remoteTurnReply(plan, {
    modelReply,
    statusLine: plan.kind === "status" ? statusText() : undefined,
  });
  return { plan: plan.kind, ...(reply ? { reply } : {}) };
}
/**
 * The runner's answer for a phone's verdict. The server applied every rule
 * (device switches, tier, presence, nonce); the gate and the tier are checked
 * once more here so nothing but a routine question can be approved from a
 * phone even if the server were wrong.
 */
async function approveFromRemote(yes: boolean): Promise<boolean> {
  if (!currentGate() || !snapshot.pending) return false;
  if (yes && remoteApprovalTier(snapshot.pending) !== "routine") return false;
  void conversation.stopSpeaking();
  void voice?.call("endFollowUp").catch(() => {});
  await runner!.approveFromVoice(yes, "remote");
  return true;
}
/** A 24-pixel mosaic of the frame scaled back up: layout and colour, no text. */
function remoteThumbnail(frame: Frame): Buffer | undefined {
  const match = /^data:image\/(?:png|jpeg);base64,(.+)$/.exec(frame.image);
  if (!match) return undefined;
  const image = nativeImage.createFromBuffer(Buffer.from(match[1], "base64"));
  if (image.isEmpty()) return undefined;
  return image
    .resize({ width: 24, quality: "good" })
    .resize({ width: 360, quality: "good" })
    .toJPEG(50);
}
/** A fixed report straight to the sinks, for lines the reporter has no facts for. */
function onProgress(report: ProgressReport) {
  for (const sink of progressSinks) sink.onProgress(report);
}
/**
 * Detached watches of a coding agent's window (increment 5A). A monitor step
 * hands its window here and its run ends; a wake queues a new run with
 * origin "watch", and a permission question the agent shows is put to the
 * user on the pill, never answered by the app.
 */
const watchers = new WatchManager({
  controller: {
    probe: (token, region) => getNative().probe(token, region),
    unbindWatch: (token) => getNative().unbindWatch(token),
    // Watch mode is on while watches run with no run of its own: the Mac
    // stays awake for them when keepAwake is on, as it does for a run.
    setWatchMode: (on) => {
      power.setWatching(on);
      return getNative().setWatchMode(on);
    },
    focusWatch: (token) => getNative().focusWatch(token),
  },
  presence,
  settings: () => settings,
  onWake: (w, cause, ctx) => queueWake(w, cause, ctx),
  onFacts: (f, hint) => watchFacts(f, hint),
  onRelay: (r) => showRelay(r),
  onRelayGone: (id, reason) => hideRelay(id, reason),
  // A wake waits for room in the queue rather than being dropped after the
  // watch has already let go of its window.
  canWake: () => taskQueue.list(Date.now()).length < TASK_QUEUE_MAX,
  trace: debug,
});
/** Ends every watch, and any news of theirs still waiting for the pill. */
function stopWatches() {
  watchPill.clear();
  return watchers.stop();
}
/**
 * What each queued wake-up run starts with, by queued task id: the queue
 * itself carries only text and origin. Pruned as the queue drains.
 */
const wakes = new Map<
  string,
  { watch: WatchContext; chain: WatchChain; spoken: boolean }
>();
function queueWake(w: WatchState, cause: WakeCause, ctx: WakeContext) {
  const now = Date.now();
  const watch: WatchContext = {
    cause,
    ...(w.agent ? { agent: w.agent } : {}),
    state: w.state,
    minutes: w.minutes,
    lastChangeMinutes: Math.max(0, Math.floor((now - w.lastChangeAt) / 60000)),
    ...(ctx.notes.length ? { steps: ctx.notes } : {}),
    ...(ctx.panelTail ? { panelText: ctx.panelTail } : {}),
  };
  // A follow-up that quotes the watched request, never the request itself,
  // and with no taskSource: these are the app's words, not the user's.
  const added = taskQueue.add(wakeTask(w, cause, ctx), "watch", now);
  if (!("position" in added)) {
    // The watch has let go of the window by now: the user hears that the
    // follow-up is not coming instead of nothing at all.
    debug("WatchWakeDropped", {
      cause,
      code: "full" in added ? "queue_full" : "credentials",
    });
    watchNews(w.runId, 0, "final", droppedLine(w, cause), ctx.origin);
    return;
  }
  const queued = taskQueue.list(now).at(-1);
  // The wake-up run answers the way the chain was asked for: a spoken "keep
  // an eye on it" gets its result spoken, however many wakes later.
  if (queued)
    wakes.set(queued.id, {
      watch,
      chain: ctx.chain,
      spoken: ctx.origin === "voice",
    });
  debug("WatchWakeQueued", { cause, status: w.state });
  scheduleQueueDrain();
}
/**
 * The watch's latest line or relay card that a run or the microphone kept
 * off the pill; shown when the pill would otherwise go away (armDoneHide).
 */
const watchPill = new HeldNews<Partial<PillState>>();
/** A watch's card on the pill now, or once the pill is free. */
function showWatchPill(card: Partial<PillState>, relay?: string) {
  const now = watchPill.offer(card, listening || runActive(), relay);
  if (!now) return;
  relayCard = relay;
  setPill(now);
}
/**
 * A fixed line about a watch, to the sinks and the pill. Only fixed lines
 * come through here: nothing read from the watched window is ever spoken or
 * sent. The line is spoken only for a watch asked for by voice and never
 * texted (fallbackReport); the reporter words the watch's own progress.
 */
function watchNews(
  runId: string,
  seq: number,
  kind: ProgressReport["kind"],
  text: string,
  origin?: RunOrigin,
) {
  onProgress(
    fallbackReport({ runId, seq, kind, text, origin, at: Date.now() }),
  );
  showWatchPill({
    phase: "done",
    label: text,
    transcript: "",
    canApprove: false,
    synthetic: false,
    inputLevel: 0,
  });
}
/**
 * Progress from a watch. The reporter words it and decides who hears it
 * (spoken, texted, the phone page) at its own cadence; news that waits on
 * the user (a wake held back, a stall) also shows its fixed line on the pill.
 */
function watchFacts(f: ProgressFacts, hint?: FactsHint) {
  reporter.onWatchFacts(f);
  const text = hint && factsLine(f, hint);
  if (text)
    showWatchPill({
      phase: "done",
      label: text,
      transcript: "",
      canApprove: false,
      synthetic: false,
      inputLevel: 0,
    });
}
/** The relay card on the pill, by relay id, so an answer in the editor clears it. */
let relayCard: string | undefined;
/**
 * The agent asked the user something. The card says what and points at the
 * editor; the click that would answer it lands in increment 5B, and the app
 * never answers on its own.
 */
function showRelay(r: RelayRequest) {
  // Spoken: the fixed line for the kind of request. The question itself is
  // screen text and stays on the pill card, next to the editor.
  onProgress(
    fallbackReport({
      runId: r.runId,
      seq: r.seq,
      kind: "needs_you",
      text: relayLine(r),
      origin: r.origin,
      at: Date.now(),
    }),
  );
  showWatchPill(
    {
      phase: "working",
      label: `${relayLine(r).split(". ")[0]}: ${r.question}`,
      transcript: "Answer it in the editor; I never answer for you.",
      canApprove: false,
      synthetic: false,
      inputLevel: 0,
    },
    r.id,
  );
}
/** The card comes down; only a question answered on screen says so. */
function hideRelay(id: string, reason: RelayGone) {
  watchPill.forget(id);
  if (relayCard !== id) return;
  relayCard = undefined;
  if (listening || runActive()) return;
  setPill({
    phase: "done",
    label: reason === "answered" ? "Answered in the editor." : "",
    transcript: "",
    canApprove: false,
  });
}
/** How an approval answered through a channel is journaled. */
function approvalSource(channel: Channel): ApprovalSource {
  return channel === "voice"
    ? "voice"
    : channel === "app"
      ? "typed"
      : channel === "message"
        ? "message"
        : "remote";
}
/**
 * "Call me …" must be a name, never a word the voice routers act on or the
 * wake phrase: the assistant says it out loud.
 */
function validateAddressAs(name: string) {
  if (!name.trim()) return;
  if (voiceIntent(name).kind !== "command" || isWakePhraseOnly(name))
    throw new Error("Choose a name that is not a command word.");
}
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
    // A watch's news that a run or the microphone kept off the pill comes up
    // before the pill goes away.
    const held = watchPill.take(listening || runActive());
    if (held) {
      relayCard = held.relay;
      setPill(held.item);
      return;
    }
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
        // With no run, the helper emits this only for two Escapes within
        // 0.8 s while a watch is on; during a run, for one Escape. Either way
        // it is the emergency stop and it ends the watches too, as a spoken
        // "stop" does: a watch must not wake a run after it.
        watchPill.clear();
        const watchesStopped = watchers.onEmergencyStop();
        if (!snapshot.run || terminal(snapshot.run.status)) {
          if (watchesStopped)
            setPill({
              phase: "done",
              label: "Stopped watching.",
              transcript: "",
              canApprove: false,
            });
          return;
        }
        cancelVoiceCapture();
        abortTurn();
        void conversation.stopSpeaking();
        voiceHeld = false;
        taskQueue.clear();
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
  return withAgenda(learnedMemory(), settings.agenda ? getAgenda() : undefined);
}
function learnedMemory(): MemoryAccess | undefined {
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
      {
        label: "Set up Open Assist…",
        click: () => showSettings("setup"),
      },
      { label: "Settings…", click: () => showSettings() },
      { label: "Review local runs…", click: () => showSettings("review") },
      ...(settings.remoteEnabled
        ? [
            { type: "separator" as const },
            // Cuts every phone off at once; the setting turns off with it.
            { label: "Lock phone remote", click: () => remote.lock() },
          ]
        : []),
      { type: "separator" },
      { label: "Quit Open Assist", click: () => app.quit() },
    ]),
  );
}
/**
 * The section the settings window should be showing. A view pushed before the
 * renderer subscribed (the first-run setup view, sent during startup) or lost
 * to a renderer crash is re-sent on the next did-finish-load.
 */
let settingsSection = "";
function showSettings(section = "settings") {
  settingsSection = section;
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
          abortTurn();
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
 * native restore or the runner's own resume was in flight. Returns whether
 * the run was resumed.
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
  return current.resume();
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
      lastPartial = "";
      // A reply is likely soon: have the natural voice and the agenda ready.
      warmKokoro();
      warmAgenda();
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
      if (listening) {
        setPill({
          phase: "working",
          label: "One moment…",
          inputLevel: 0,
          closing: false,
        });
        // The words are almost certainly final: start the model on them.
        assistant.preempt(lastPartial, "voice");
      }
    } else if (event.event === "endpoint_near") {
      if (listening && !pill.closing) setPill({ closing: true });
      if (listening) assistant.preempt(lastPartial, "voice");
    } else if (event.event === "transcript_partial") {
      if (listening) {
        lastPartial = event.text ?? "";
        setPill({ transcript: lastPartial, closing: false });
      }
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
      // A decision still in flight for the cancelled words must not act.
      abortTurn();
      voiceHeld = false;
      taskQueue.clear();
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
      // A wake phrase said again mid-segment starts the request over.
      const heard = transcriptRequest(event);
      if (!heard.text) throw new Error("Didn’t catch that. Try again.");
      await command(heard.text, true, voiceCommandConfidence(event), {
        segments: heard.segments,
      });
    } else if (event.event === "transcript_unconfirmed") {
      if (!listening) return;
      listening = false;
      const text = transcriptRequest(event).text;
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
    // Stuck, handed back, paused or waiting on an approval, rather than
    // waiting on its own question.
    stalled:
      run.status === "confirming" ||
      (runHeld() &&
        (run.status === "paused" ||
          snapshot.message === TARGET_HANDOFF_MESSAGE)),
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
  // The deterministic plan comes first, exactly as before: control words,
  // approval answers (a "yes" may accept the assistant's open offer),
  // fragments and status questions never reach the model.
  const base = planVoiceTurn({
    text,
    confidence,
    segments: extra.segments,
    gateMatches: fromVoice ? !!voiceGate && voiceGate === gate : !!gate,
    now: Date.now(),
    run: planRun(),
    proposal: assistant.proposal(),
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
    plan: base.kind,
    source: context.source,
    window: context.window,
    segments: extra.segments,
    confidence,
    textLength: text.length,
  });
  // Typed text keeps the pill visible until a run actually starts or resumes,
  // so a rejected command stays readable.
  if (!fromVoice) cancelVoiceCapture();
  const channel: Channel = fromVoice ? "voice" : "app";
  // Typed words are the user's; speech counts only when heard clearly.
  const heard: TaskSource =
    fromVoice && confidence < APPROVAL_MIN_CONFIDENCE
      ? "user_words_unsure"
      : "user_words";
  // A "yes" the router turned into the open offer is settled: the task runs
  // exactly as offered, with the offer's provenance, and the model is not
  // asked (it would re-ground the offer against "yes" and offer it again).
  const accepted =
    (base.kind === "start" || base.kind === "queue") &&
    base.taskSource === "proposal";
  if (accepted) assistant.noteUser(text, channel);
  let plan: TurnPlan = base;
  let decision: TurnDecision | undefined;
  let reply: ReplyHandle | undefined;
  let replyText: string | undefined;
  if (!accepted && dialogEligible(base) && assistant.available(channel)) {
    const turnId = randomUUID();
    // One abort per turn: a new activation, a cancel or the emergency stop
    // ends the decision, and a decision that ends that way never acts.
    abortTurn();
    const turn = new AbortController();
    turnAbort = turn;
    const invocation = voiceInvocation;
    // A voice turn gets a filler if the model is slow; a fast start speaks
    // its own fixed line the instant the run is dispatched.
    if (fromVoice)
      reply = conversation.expectReply(turnId, {
        voiceTurn: true,
        filler: turnFiller(base, text),
        fillerAfterMs: DIALOG_LIMITS.fillerAfterMs,
      });
    decision = await assistant.decide({
      turnId,
      text,
      base,
      run: planRun(),
      view: currentRunView(),
      channel,
      confidence,
      signal: turn.signal,
    });
    if (turnAbort === turn) turnAbort = undefined;
    if (
      turn.signal.aborted ||
      decision.code === "interrupted" ||
      (fromVoice && invocation !== voiceInvocation)
    ) {
      // The user took the floor (or cancelled) while the model was
      // thinking: the plan is stale and nothing runs.
      debug("TurnDecided", { plan: base.kind, code: "interrupted" });
      reply?.cancel();
      return;
    }
    plan = decision.plan;
    debug("TurnDecided", { plan: plan.kind, code: decision.code });
    if (reply)
      reply.attach(decision.sentences, {
        acting: decision.acting,
        cannedIfEmpty: base.kind === "start" ? "ackStart" : "ackCorrection",
        // A Jev start is dispatched like a fast start: the same fixed line
        // (or the canned acknowledgement) the instant the run is under way.
        line:
          decision.code === "fast_start" || decision.code === "jev_start"
            ? fastStartLine(text)
            : undefined,
      });
    // Typed turns read the reply on the pill instead.
    else if (decision.sentences)
      replyText = await collectReply(decision.sentences);
  }
  const ctx: PlanCtx = {
    origin: fromVoice ? "voice" : "typed",
    channel,
    // The model may confirm the user's own words but never make them surer
    // than they were heard.
    taskSource: accepted
      ? "proposal"
      : decision?.taskSource === "user_words" && heard === "user_words_unsure"
        ? heard
        : (decision?.taskSource ?? heard),
    // Built before the plan runs: answering may resume the run. The status
    // template always reaches the pill; it is spoken only when the model
    // did not answer itself.
    replyText: plan.kind === "status" ? statusText() : replyText,
    replyPending: !!reply && !!decision?.sentences,
  };
  const outcome = await executePlan(plan, ctx);
  if (!outcome.ok) {
    reply?.cancel();
    throw new Error(outcome.error);
  }
  conversation.acknowledge(plan, {
    source: context.source,
    handsFree: settings.handsFree,
    activationAt: context.activationAt,
    text: ctx.replyText,
    reply,
  });
  // The spoken answer, once it is known, replaces the placeholder card.
  if (reply && plan.kind === "reply")
    void reply.spoken.then((spoken) => {
      if (spoken && !listening && !runActive() && pill.phase === "done")
        setPill({ label: spoken });
    });
}
/** A typed turn's reply, collected for the pill (bounded by the session). */
async function collectReply(sentences: AsyncIterable<string>) {
  const parts: string[] = [];
  try {
    for await (const sentence of sentences) parts.push(sentence);
  } catch {}
  return parts.join(" ") || undefined;
}
/** What a turn plan runs as: where it came from and whose words it carries. */
type PlanCtx = {
  origin: RunOrigin;
  channel: Channel;
  taskSource?: TaskSource;
  /** The line to show or speak for a status or reply plan. */
  replyText?: string;
  /** A spoken reply is on its way and replaces the card once it is known. */
  replyPending?: boolean;
};
/**
 * Runs a turn plan. Never throws: callers that show failures (the voice
 * path, IPC) rethrow the message; others (texts, the queue) report it.
 */
async function executePlan(
  plan: TurnPlan,
  ctx: PlanCtx,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await runPlan(plan, ctx);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Something went wrong.",
    };
  }
}
async function runPlan(plan: TurnPlan, ctx: PlanCtx) {
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
      // A stop is for everything the user asked for, queued tasks and
      // watches included.
      taskQueue.clear();
      stopWatches();
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
      // The router never approves from a phone; a plan that says so anyway
      // is answered the way it should have been. A texted "no" only pauses,
      // and the router already matched it to the gate that was relayed.
      if (
        plan.kind === "approve" &&
        (ctx.channel === "message" || ctx.channel === "remote")
      ) {
        fail("Approve this one on the Mac.");
        return;
      }
      // A gate that vanished since planning is a stale answer.
      if (!currentGate()) {
        fail("Nothing to approve.");
        return;
      }
      await runner!.approveFromVoice(
        plan.kind === "approve",
        approvalSource(ctx.channel),
      );
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
          : plan.reason === "channel"
            ? "Approve this one on the Mac."
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
      // With the dialog on and able to answer, an "okay" or "thanks" said by
      // voice lets the run this very activation paused carry on. Any other
      // hold (the user's own pause, a takeover, a helper restart) stays
      // exactly as it was.
      if (
        settings.conversation === "model" &&
        assistant.available("voice") &&
        ctx.channel === "voice" &&
        (await resumeVoiceHold())
      )
        return;
      voiceHeld = false;
      // A held run stays paused and keeps showing why.
      if (runActive()) render();
      else idleCard("Okay.");
      return;
    case "clarify": {
      // No run starts and no correction is recorded; the answer completes it.
      // Dismissing the question must not resume a run the voice hold paused.
      voiceHeld = false;
      // Only a line typed at the Mac takes the keyboard: a phone's question
      // ("do that" from the remote or by text) is answered there.
      const fragment = plan.fragment.replace(/[\s.,…]+$/, "");
      show(
        {
          phase: "text",
          label: plan.question,
          transcript: fragment ? `${fragment} ` : "",
          canApprove: false,
          closing: false,
        },
        ctx.channel === "app",
      );
      return;
    }
    case "status": {
      const text = ctx.replyText ?? statusText();
      if (snapshot.run?.status === "confirming" && snapshot.pending) {
        voiceHeld = false;
        show(approvalPill(snapshot, text));
        return;
      }
      if (!runActive()) {
        voiceHeld = false;
        idleCard(text);
        return;
      }
      notice = { text, until: Date.now() + NOTICE_MS };
      // The activation paused the run to listen; an answered question is no
      // reason to keep it waiting. The working pill then carries the answer.
      if (!(await resumeVoiceHold())) render();
      return;
    }
    case "queue": {
      const added = taskQueue.add(
        plan.text,
        ctx.origin,
        Date.now(),
        // An accepted proposal is the assistant's wording, not the user's.
        plan.taskSource ?? ctx.taskSource,
      );
      if ("refused" in added) {
        voiceHeld = false;
        throw new Error(
          "Remove credentials from the task. Enter passwords manually during takeover.",
        );
      }
      if ("full" in added) {
        voiceHeld = false;
        throw new Error(
          `I can hold ${TASK_QUEUE_MAX} tasks for later, and they’re all taken.`,
        );
      }
      notice = {
        text:
          added.position === 1
            ? "Queued for after this one."
            : `Queued, number ${added.position}.`,
        until: Date.now() + NOTICE_MS,
      };
      if (!runActive()) {
        // The router queues only with a run; one that ended meanwhile is
        // drained like any other end.
        voiceHeld = false;
        idleCard(notice.text);
        scheduleQueueDrain();
        return;
      }
      if (!(await resumeVoiceHold())) render();
      return;
    }
    case "reply": {
      if (!runActive()) {
        voiceHeld = false;
        // A spoken answer on its way is not pre-empted by a stock "Okay.".
        idleCard(ctx.replyText ?? (ctx.replyPending ? "…" : "Okay."));
        return;
      }
      if (ctx.replyText)
        notice = { text: ctx.replyText, until: Date.now() + NOTICE_MS };
      if (!plan.resume) {
        voiceHeld = false;
        render();
        return;
      }
      if (!(await resumeVoiceHold())) render();
      return;
    }
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
    case "replace": {
      // The user moved on from a stalled run: end it without cutting off the
      // spoken acknowledgement, wait for its loop to settle, then start. The
      // queue waits too: the stopped run's end would otherwise drain it into
      // the gap and the replacement would find that task running instead.
      voiceHeld = false;
      queueHeld = true;
      clearTimeout(drainTimer);
      drainTimer = undefined;
      try {
        runner?.stop("Replaced by a new request.");
        for (
          let waited = 0;
          runner && !runner.settled && waited < 3000;
          waited += 50
        )
          await new Promise((resolve) => setTimeout(resolve, 50));
        await dispatch("start", [
          plan.text,
          false,
          { origin: ctx.origin, taskSource: ctx.taskSource },
        ]);
      } finally {
        queueHeld = false;
        // Nothing starts while the replacement runs; if it never did, the
        // queue goes on as after any other end.
        scheduleQueueDrain();
      }
      return;
    }
    case "revise":
    case "start": {
      voiceHeld = false;
      const active = runActive();
      // The router starts only when nothing runs, so a start that finds a
      // run under way (an accepted proposal, a queued task that began
      // meanwhile) waits its turn: applied as a correction it would carry
      // words the user never said, in the user's name.
      if (plan.kind === "start" && active) {
        await runPlan(
          { kind: "queue", text: plan.text, taskSource: plan.taskSource },
          ctx,
        );
        return;
      }
      if (!(snapshot.run?.synthetic && active)) {
        hide();
        await native?.request("restoreRemembered");
      }
      show({
        phase: "working",
        // The pill says where a task came from, never what the phone sent.
        label:
          ctx.channel === "remote"
            ? "From your phone."
            : active
              ? "Got it."
              : "On it.",
        transcript: "",
        canApprove: false,
        closing: false,
      });
      if (active) await runner!.revise(plan.text);
      else
        await dispatch("start", [
          plan.text,
          false,
          // An accepted proposal is the assistant's wording, not the user's.
          {
            origin: ctx.origin,
            taskSource:
              (plan.kind === "start" && plan.taskSource) || ctx.taskSource,
          },
        ]);
      return;
    }
  }
}
/**
 * Bookkeeping that follows the run's life: presence is refreshed while it is
 * active, and its end remembers it for status answers and lets the next
 * queued task start.
 */
function trackRun(s: Snapshot) {
  const run = s.run;
  if (!run) return;
  watchers.setRunActive(!terminal(run.status));
  if (!terminal(run.status)) {
    startPresenceRefresh();
    return;
  }
  const ended = lastFinished?.id !== run.id;
  lastFinished = run;
  if (!ended) return;
  stopPresenceRefresh();
  scheduleQueueDrain();
}
function startPresenceRefresh() {
  if (presenceTimer) return;
  void presence.refresh();
  presenceTimer = setInterval(
    () => void presence.refresh(),
    PRESENCE_REFRESH_MS,
  );
}
function stopPresenceRefresh() {
  clearInterval(presenceTimer);
  presenceTimer = undefined;
}
/**
 * Starts the next queued task once the run that ended has settled. Waits
 * while the user is talking or something else already started, and gives up
 * after half a minute; the next run's end tries again.
 */
function scheduleQueueDrain(attempt = 0) {
  clearTimeout(drainTimer);
  drainTimer = undefined;
  if (shuttingDown || queueHeld || !taskQueue.list(Date.now()).length) return;
  if (attempt >= QUEUE_DRAIN_ATTEMPTS) return;
  drainTimer = setTimeout(() => void drainQueue(attempt), QUEUE_DRAIN_MS);
}
async function drainQueue(attempt: number) {
  drainTimer = undefined;
  if (shuttingDown) return;
  if (runActive()) return;
  if (listening || (runner && !runner.settled)) {
    scheduleQueueDrain(attempt + 1);
    return;
  }
  const next = taskQueue.next(Date.now());
  if (!next) return;
  const wake = wakes.get(next.id);
  for (const id of wakes.keys())
    if (!taskQueue.list(Date.now()).some((t) => t.id === id)) wakes.delete(id);
  debug("QueuedTaskStarted", {
    source: next.origin,
    textLength: next.text.length,
  });
  try {
    if (wake?.spoken) conversation.noteInput("voice");
    await dispatch("start", [
      next.text,
      false,
      {
        origin: next.origin === "watch" ? "watch" : "queue",
        taskSource: next.taskSource,
        ...(wake ? { watch: wake.watch, chain: wake.chain } : {}),
      },
    ]);
  } catch (error) {
    debug("QueuedTaskFailed", errorDetails(error));
    showFailure(
      error instanceof Error
        ? error.message
        : "The queued task could not start.",
    );
  }
}
function emit(s: Snapshot) {
  snapshot = s;
  diagnostics?.snapshot(s);
  messages.onSnapshot(s);
  reporter.onSnapshot(s);
  power.onSnapshot(s);
  remote.onSnapshot(s);
  trackRun(s);
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
      // A status or reply answered while held shows its line here, since
      // nothing speaks a typed one; the continue hint returns after it.
      transcript:
        notice.until > Date.now()
          ? notice.text
          : s.message === MANUAL_PAUSE_MESSAGE
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
        messages: messages.status(),
      };
    }
    case "saveSettings": {
      const next = settingsSchema.parse(args[0]);
      // The phone list is edited only through setRemoteDevice and
      // forgetRemoteDevice, so a save never carries a stale copy of it.
      next.remoteDevices = settings.remoteDevices;
      validateProviderEndpoint(next);
      // The dialog model shares the endpoint, so the same privacy gate holds.
      if (next.dialogModel) validateProviderEndpoint(textSettings(next));
      validateAddressAs(next.addressAs);
      validateMessageSettings(next);
      validateRemoteSettings(next);
      let nextCredentials =
        args[1] !== undefined
          ? withProviderKey(credentials, next, args[1])
          : credentials;
      // The OpenRouter key for the Jev decider, saved into its own slot. A
      // key typed into Settings, beside the disclosure, is consent; a key
      // that only arrived from a .env never is.
      if (args[2] !== undefined)
        nextCredentials = withJevKey(nextCredentials, args[2]);
      const checked = jevSettingsToSave(
        next,
        typeof args[2] === "string" ? args[2] : undefined,
      );
      next.decisions = checked.decisions;
      next.decisionsChosen = checked.decisionsChosen;
      next.jevConsented = checked.jevConsented;
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
      // The dialog thread belongs to one provider, model and privacy mode.
      if (
        next.provider !== settings.provider ||
        next.endpoint !== settings.endpoint ||
        next.model !== settings.model ||
        next.privacy !== settings.privacy ||
        next.dialogModel !== settings.dialogModel ||
        next.conversation !== settings.conversation
      )
        assistant.reset();
      credentials = nextCredentials;
      settings = next;
      saveConfig();
      updateTray();
      power.apply();
      if (voiceEngineChanged) {
        // A reply in the old engine may still be playing.
        await conversation.stopSpeaking();
        warmKokoro();
      }
      let messagesError: unknown;
      // Saved either way: the channel reports why it is not live.
      await messages.configure().catch((error) => {
        debug("MessagesSetupFailed", errorDetails(error));
        messagesError = error;
      });
      await remote.configure().catch((error) => {
        debug("RemoteSetupFailed", errorDetails(error));
      });
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
      if (messagesError)
        throw new Error(
          `Settings saved, but texting could not start: ${
            messagesError instanceof Error
              ? messagesError.message
              : "try again."
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
      settingsSection = "";
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
      // Only internal callers say where a task came from; the renderer's
      // starts are always "typed" (the IPC handler drops a third argument).
      const from = z
        .object({
          origin: z
            .enum(["voice", "typed", "message", "queue", "watch", "remote"])
            .optional(),
          taskSource: z
            .enum([
              "user_words",
              "user_words_unsure",
              "model_rewrite",
              "proposal",
            ])
            .optional(),
          // Why a watch woke the model; only the queue drain passes it.
          watch: z
            .object({
              cause: z.string().max(40),
              agent: z.string().max(40).optional(),
              state: z.string().max(40),
              minutes: z.number().int().min(0),
              lastChangeMinutes: z.number().int().min(0),
              steps: z.array(z.string().max(120)).max(5).optional(),
              panelText: z.string().max(1500).optional(),
            })
            .strict()
            .optional(),
          // The chain of watches that wake belongs to; only with watch.
          chain: z
            .object({
              startedAt: z.number().finite(),
              wakes: z.number().int().min(0).max(1000),
              origin: z
                .enum(["voice", "typed", "message", "queue", "watch", "remote"])
                .optional(),
            })
            .strict()
            .optional(),
        })
        .optional()
        .parse(args[2]);
      const origin: RunOrigin = from?.origin ?? "typed";
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
        // A monitor step hands its window to the detached watch and ends.
        tutorial
          ? {}
          : {
              onMonitor: (binding, spec, run) =>
                watchers.start(binding, {
                  ...spec,
                  runId: run.id,
                  task: run.task,
                  taskSource: run.taskSource,
                  origin: run.origin,
                  appName: run.appName,
                  notes: handoffNotes(run.steps),
                  corrections: run.corrections,
                  ...(run.chain ? { chain: run.chain } : {}),
                }),
            },
      );
      voiceHeld = false;
      window.hide();
      void runner
        .start(task, {
          origin,
          taskSource:
            from?.taskSource ?? (origin === "typed" ? "user_words" : undefined),
          ...(from?.watch ? { watch: from.watch } : {}),
          ...(from?.watch && from.chain ? { chain: from.chain } : {}),
        })
        .catch((error) => {
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
      taskQueue.clear();
      stopWatches();
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
      await runner?.approveFromVoice(yes, "pill");
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
    case "messagesStatus":
      return messages.refresh();
    case "remoteStatus":
      return remote.status();
    case "setRemoteDevice": {
      const id = z.string().min(1).max(64).parse(args[0]);
      const patch = z
        .object({
          control: z.boolean().optional(),
          approve: z.boolean().optional(),
        })
        .strict()
        .parse(args[1]);
      // Consent takes effect at once, and approve never outlives control.
      settings = {
        ...settings,
        remoteDevices: settings.remoteDevices.map((d) => {
          if (d.id !== id) return d;
          const control = patch.control ?? d.control;
          return {
            ...d,
            control,
            approve: control && (patch.approve ?? d.approve),
          };
        }),
      };
      saveConfig();
      if (patch.control === false) remote.revokeDevice(id);
      refreshSettingsView();
      return remote.status();
    }
    case "forgetRemoteDevice": {
      const id = z.string().min(1).max(64).parse(args[0]);
      settings = {
        ...settings,
        remoteDevices: settings.remoteDevices.filter((d) => d.id !== id),
      };
      saveConfig();
      remote.revokeDevice(id);
      refreshSettingsView();
      return remote.status();
    }
    case "lockRemote":
      remote.lock();
      return remote.status();
    case "agendaStatus":
      return getAgenda().status();
    case "requestAgendaAccess":
      return getAgenda().request();
    case "sendTestMessage":
      await messages.sendTest();
      return;
    case "kokoroStatus":
      return kokoroUiStatus();
    case "downloadKokoro": {
      if (!kokoroSupported())
        throw new Error("The natural voice needs a Mac with Apple Silicon.");
      const pack = z.enum(kokoroVoices).optional().parse(args[0]);
      kokoroDownload ??= new AbortController();
      const controller = kokoroDownload;
      try {
        // Increment 3B's client takes the voice pack to fetch; until it
        // lands the base install is the only pack and the argument is moot.
        const client = getKokoro();
        await (
          client.download.bind(client) as (
            onProgress: (status: KokoroStatus) => void,
            signal: AbortSignal,
            voice?: string,
          ) => Promise<void>
        )((status) => sendKokoroStatus(status), controller.signal, pack);
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
    // First run (docs/MODULARITY.md §6). Settings-window only: the overlay
    // allow-list in the "coarena" handler never reaches any of these.
    case "setupStatus": {
      let permissions = {
        screen: false,
        accessibility: false,
        supported: false,
      };
      let read = false;
      try {
        permissions = await getNative().request("permissions");
        read = true;
      } catch {}
      // Only an answer counts. A helper that could not be reached is not a
      // denial, and inventing one would ask for a restart nobody needs.
      if (read && !permissions.screen) screenSeenDenied = true;
      let voiceStatus = {
        microphone: false,
        speech: false,
        onDevice: false,
        shortcut: false,
        locale: "",
      };
      try {
        voiceStatus = { ...voiceStatus, ...(await getVoice().call("status")) };
      } catch {}
      const status: SetupStatus = {
        supported: permissions.supported,
        screen: permissions.screen,
        // Granted in the OS, but this process was launched under the old
        // decision, so capture would still fail. Never a tick.
        screenNeedsRelaunch: permissions.screen && screenSeenDenied,
        accessibility: permissions.accessibility,
        microphone: voiceStatus.microphone,
        speech: voiceStatus.speech,
        onDevice: voiceStatus.onDevice,
        locale: voiceStatus.locale,
        shortcut: voiceStatus.shortcut,
        model: await modelStatus(),
        kokoro: kokoroUiStatus(),
        complete: settings.setupComplete,
      };
      return status;
    }
    case "openPrivacyPane": {
      const pane = z
        .enum([
          "screen",
          "accessibility",
          "microphone",
          "speech",
          "input",
          "automation",
          "fullDisk",
        ])
        .parse(args[0]) satisfies PrivacyPane;
      // The pane identifiers are not API. Degrade to Privacy & Security, whose
      // written path the setup copy names, rather than failing silently.
      try {
        await shell.openExternal(privacyPanes[pane]);
      } catch (error) {
        debug("PrivacyPaneFailed", { pane, ...errorDetails(error) });
        await shell.openExternal(privacySettingsRoot);
      }
      return;
    }
    case "relaunch":
      debug("RelaunchRequested");
      app.relaunch();
      app.quit();
      return;
    case "detectOllama":
      return ollamaStatus(true);
    case "checkProviderKey": {
      const next = settingsSchema.parse(args[0]);
      const url = validateProviderEndpoint(next);
      if (next.provider === "ollama")
        return {
          ok: false,
          message:
            "A local Ollama model needs no API key. Use the check above instead.",
        };
      const key =
        typeof args[1] === "string" && args[1]
          ? args[1]
          : providerKey(credentials, next);
      if (!key)
        return {
          ok: false,
          message: "Enter your provider key, then check it.",
        };
      const base = url.toString().replace(/\/$/, "");
      const model = encodeURIComponent(next.model);
      // One cheap metadata request per provider: no screenshot, no tokens and
      // nothing that could act on the desktop.
      const probe: { url: string; headers: Record<string, string> } =
        next.provider === "anthropic"
          ? {
              url: `${base}/v1/models/${model}`,
              headers: {
                "x-api-key": key,
                "anthropic-version": "2023-06-01",
              },
            }
          : next.provider === "google"
            ? {
                url: `${base}/v1beta/models/${model}`,
                headers: { "x-goog-api-key": key },
              }
            : next.provider === "openai"
              ? {
                  url: `${base}/v1/models/${model}`,
                  headers: { Authorization: `Bearer ${key}` },
                }
              : {
                  url: `${base}/models`,
                  headers: { Authorization: `Bearer ${key}` },
                };
      try {
        const response = await desktopTransport(debug)(probe.url, {
          method: "GET",
          headers: probe.headers,
          redirect: "error",
          signal: AbortSignal.timeout(8000),
        });
        // Exactly one fact is read out of the body, and it is never echoed:
        // whether Google refused the key for its own API restrictions.
        let blocked = false;
        if (next.provider === "google" && [400, 403].includes(response.status))
          blocked = (await readBounded(response, 4096)).includes(
            "API_KEY_SERVICE_BLOCKED",
          );
        else await response.body?.cancel().catch(() => {});
        debug("ProviderKeyChecked", {
          provider: next.provider,
          httpStatus: response.status,
        });
        return providerKeyMessage({
          provider: next.provider,
          model: next.model,
          host: url.hostname,
          status: response.status,
          blocked,
        });
      } catch (error) {
        debug("ProviderKeyCheckFailed", {
          provider: next.provider,
          ...errorDetails(error),
        });
        const failure = networkFailure(error).message;
        return {
          ok: false,
          message: `Could not reach ${url.hostname}. ${
            failure.startsWith("Provider connection failed")
              ? "Check your connection or proxy."
              : failure
          }`,
        };
      }
    }
    case "completeSetup":
      if (!settings.setupComplete) {
        settings = { ...settings, setupComplete: true };
        saveConfig();
      }
      debug("SetupCompleted");
      return;
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
  // The phone number to text, imported like an API key and never auto-enabled.
  const index = args.indexOf("--import-env");
  const file = index >= 0 ? args[index + 1] : undefined;
  const handle = file ? importEnvHandle(file) : "";
  if (handle && !settings.messagesHandle)
    settings = { ...settings, messagesHandle: handle };
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
    readScreenAtLaunch();
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
    const hadConfig = existsSync(join(root, "config.enc"));
    if (hadConfig) {
      const c = JSON.parse(
        unseal(
          master,
          readFileSync(join(root, "config.enc")),
          "config",
        ).toString(),
      );
      settings = settingsSchema.parse(c.settings);
      // A config written before first-run setup existed belongs to someone who
      // already configured the app; the schema default must not send them
      // through setup.
      if (c.settings?.setupComplete === undefined)
        settings = { ...settings, setupComplete: true };
      credentials = readCredentials(c.credentials);
      if (typeof c.providerKey === "string" && c.providerKey)
        credentials = withProviderKey(credentials, settings, c.providerKey);
      // After the vault: an old "off" with a key stored may be deliberate.
      settings = migrateDecisions(settings, c.settings, !!jevKey(credentials));
      uploads = c.uploads ?? {};
    }
    const decideWithJev = launchDecideWithJev(settings, process.argv);
    if (decideWithJev) {
      settings = decideWithJev;
      saveConfig();
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
    window.webContents.on("did-finish-load", () => {
      if (settingsSection) window.webContents.send("view", settingsSection);
    });
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
        // A start from the renderer is always typed: it never names an origin.
        return await dispatch(
          method,
          method === "start" ? args.slice(0, 2) : args,
        );
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
    // First run: the setup view, which stays pending until it is finished or
    // dismissed, so quitting to apply a Screen Recording grant comes back to it.
    if (!settings.setupComplete) showSettings("setup");
    else if (imported || !hadConfig) showSettings();
    if (process.platform === "darwin") void configureVoice();
    if (process.argv.includes("--natural-voice")) void useNaturalVoice();
    void messages.configure().catch((error) => {
      debug("MessagesSetupFailed", errorDetails(error));
    });
    void remote.configure().catch((error) => {
      debug("RemoteSetupFailed", errorDetails(error));
    });
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
  messages.close();
  remote.close();
  debug("AppStopping");
  clearInterval(diagnosticHeartbeat);
  stopPresenceRefresh();
  reporter.close();
  power.release();
  clearTimeout(drainTimer);
  for (const timer of deferredReloads.values()) clearTimeout(timer);
  deferredReloads.clear();
  stopWatches();
  runner?.stop();
  flushMemory();
  native?.close();
  voice?.close();
  tray?.destroy();
  globalShortcut.unregisterAll();
});
