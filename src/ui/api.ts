import type {
  KokoroVoiceId,
  Settings,
  Snapshot,
  Run,
  Frame,
  JournalEvent,
} from "../core/schema";
import type { AppleConsent, ToolsStatus } from "../core/tools";
import type { ToolServerTest } from "../tools/registry";
import type { ModulesStatus } from "../modules/registry";
import type { WatchingStatus } from "../observer/types";
import type {
  LearnedProposals,
  ProposalDecision,
  ProposalKind,
} from "../observer/proposals";
import type { RecipeRejection, RecipesFileError } from "../voice/recipes-file";
import type { Bundle, Review } from "../contribution/bundle";
import type { PillState } from "../voice/router";
import type { MemoryData } from "../memory/types";
import type { RemoteStatus } from "../remote/protocol";
export type { RemoteStatus, ToolsStatus, ToolServerTest };
/**
 * What the Tools pane adds: a recipe (main picks the folder when the recipe
 * needs one and none is given), a pasted Claude Desktop block, or that app's
 * own config file read once.
 */
export type AddToolServerInput =
  | { recipe: string; folder?: string }
  | { paste: string }
  | { claudeDesktop: true };
/** macOS access for the agenda helper, as the Settings window shows it. */
export interface AgendaAccessInfo {
  calendar: string;
  reminders: string;
}
export interface ReviewData {
  run: Run;
  frames: Frame[];
  events: JournalEvent[];
  bundle: Bundle;
  uploaded: boolean;
}
/** What Butler learned locally, for the user's own review in Settings. */
export interface MemorySummary {
  counts: {
    episodes: number;
    preferences: number;
    skills: number;
    apps: number;
  };
  /** The 10 most recently updated preference texts. */
  preferences: string[];
  /** The 10 most recently used skill triggers (task templates). */
  skills: string[];
}
/**
 * Counts plus the 10 most recent preference texts and skill triggers. Episodes
 * (task text) and app usage are only counted; nothing here leaves the Mac.
 */
export function summarizeMemory(data: MemoryData): MemorySummary {
  const recent = <T>(items: T[], at: (item: T) => string) =>
    [...items].sort((a, b) => (at(b) > at(a) ? 1 : at(b) < at(a) ? -1 : 0));
  return {
    counts: {
      episodes: data.episodes.length,
      preferences: data.preferences.length,
      skills: data.skills.length,
      apps: Object.keys(data.apps).length,
    },
    preferences: recent(data.preferences, (p) => p.updatedAt || p.createdAt)
      .slice(0, 10)
      .map((p) => p.text.slice(0, 200)),
    skills: recent(data.skills, (s) => s.lastUsed || s.createdAt)
      .slice(0, 10)
      .map((s) => s.trigger.slice(0, 200)),
  };
}
/** Apple voice quality tiers; "none" when no voice could be resolved. */
export type VoiceQuality = "none" | "default" | "enhanced" | "premium";
/** One installed system voice (locale language, no novelty/Personal voices). */
export interface VoiceOption {
  id: string;
  name: string;
  language: string;
  quality: Exclude<VoiceQuality, "none">;
}
export interface VoiceList {
  voices: VoiceOption[];
  /** The system voice identifier in use ("" when automatic). */
  selected: string;
  engine: Settings["voiceEngine"];
  /** PRIVATE_BYOM with a saved OpenAI key; the natural voice may be used. */
  cloudAllowed: boolean;
}
/**
 * The free on-device natural voice (Kokoro). Nothing about what the user says
 * or types is involved: this is only the one-time model download.
 */
export interface KokoroUiStatus {
  /** Apple Silicon only; Intel Macs keep the Mac voice. */
  supported: boolean;
  /** Every pinned file is present and verified. */
  installed: boolean;
  downloading: boolean;
  /** 0-1 over the whole download. */
  progress: number;
  bytes: number;
  totalBytes: number;
  /**
   * Last failure code: network, http_<status>, checksum_mismatch,
   * size_mismatch, disk_full, load_failed, worker_crashed, not_installed.
   */
  error?: string;
  /** Which voice packs are installed, once the client reports per pack. */
  voices?: Partial<Record<KokoroVoiceId, boolean>>;
}
/**
 * The iMessage channel as Settings sees it (electron/messages.ts owns it).
 * `automation` and `database` are the two macOS permissions in disguise:
 * Automation for the Messages app, Full Disk Access for its database.
 */
export interface MessagesInfo {
  enabled: boolean;
  configured: boolean;
  commands: boolean;
  updates: "texted" | "away" | "all";
  automation:
    | "granted"
    | "denied"
    | "ask"
    | "messages_closed"
    | "unknown"
    | "unavailable";
  database:
    | "ok"
    | "no_access"
    | "locked"
    | "missing"
    | "unsupported"
    | "unopened"
    | "off";
  listening: boolean;
  /** Last readable failure. Never message content. */
  error?: string;
}
export interface AppInfo {
  desktop: boolean;
  platform: string;
  settings: Settings;
  hasKey: boolean;
  credentialScopes?: string[];
  permissions: { screen: boolean; accessibility: boolean; supported: boolean };
  displays: { id: number; width: number; height: number }[];
  encrypted: boolean;
  voice: {
    microphone: boolean;
    speech: boolean;
    onDevice: boolean;
    shortcut: boolean;
    locale: string;
    handsFree: boolean;
    wakeListening: boolean;
    /** A reply is being spoken right now. */
    speaking: boolean;
    /**
     * Echo cancellation on the microphone (the helper's voice processing,
     * BUTLER_FULL_DUPLEX): listening continues while the natural voice speaks.
     */
    voiceProcessing: boolean;
    /** Quality of the system voice that replies would use. */
    voiceQuality: VoiceQuality;
    /** Display name of that voice ("" when unknown). */
    voiceName: string;
    /** PRIVATE_BYOM with a saved OpenAI key. */
    cloudVoiceAllowed: boolean;
    /** The free on-device natural voice. */
    kokoro: KokoroUiStatus;
  };
  /** Text updates and texted commands; off until the user turns them on. */
  messages: MessagesInfo;
  /** The Apple bridge and the user's MCP servers, as the Tools pane shows them. */
  tools: ToolsStatus;
}
/**
 * Watching how the owner works, as the Watching pane shows it
 * (electron/observer.ts): the switch and tier in force, counts from the
 * work log and the consolidator, never a title, a host or a word.
 */
export type { WatchingStatus };
/** Proposals awaiting a decision and what was approved (src/observer/proposals.ts). */
export type { LearnedProposals, ProposalDecision, ProposalKind };
/** The user's site recipes file as the Modules pane shows it (electron/recipes.ts). */
export interface RecipesStatus {
  path: string;
  exists: boolean;
  loaded: number;
  builtin: number;
  total: number;
  rejected: { index: number; code: RecipeRejection }[];
  error?: RecipesFileError | "unreadable";
  readAt?: number;
}
/**
 * First run (docs/MODULARITY.md §6). Everything below is the setup view's
 * contract: the live permission picture, the deep links it opens and the two
 * checks it runs. None of it belongs on `AppInfo.voice.kokoro`, whose exact
 * key set scripts/desktop-smoke.mjs deep-equals.
 */
export type PrivacyPane =
  | "screen"
  | "accessibility"
  | "microphone"
  | "speech"
  | "input"
  | "automation"
  | "fullDisk";
/**
 * These pane identifiers are not API and can disappear in a macOS release, so
 * every button falls back to `privacySettingsRoot` and the copy always names
 * the written path as well.
 */
export const privacyPanes: Record<PrivacyPane, string> = {
  screen:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  accessibility:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  microphone:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  speech:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition",
  input:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
  automation:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
  fullDisk:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
};
/** Where every pane button lands when its deep link does nothing. */
export const privacySettingsRoot =
  "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension";
/** The written path, so the copy still makes sense without the deep link. */
export const privacyPanePaths: Record<PrivacyPane, string> = {
  screen: "Privacy & Security › Screen & System Audio Recording",
  accessibility: "Privacy & Security › Accessibility",
  microphone: "Privacy & Security › Microphone",
  speech: "Privacy & Security › Speech Recognition",
  input: "Privacy & Security › Input Monitoring",
  automation: "Privacy & Security › Automation",
  fullDisk: "Privacy & Security › Full Disk Access",
};
/** What the setup view needs, polled while it is visible. */
export interface SetupStatus {
  /** macOS 14 or later; desktop control is refused below it. */
  supported: boolean;
  screen: boolean;
  /**
   * Granted in the OS, but this process was launched under the old decision
   * and still cannot capture. A tick here would be a lie: macOS applies
   * Screen Recording only to a process started after the grant.
   */
  screenNeedsRelaunch: boolean;
  accessibility: boolean;
  microphone: boolean;
  speech: boolean;
  /** An on-device speech model exists for `locale`; there is no cloud fallback. */
  onDevice: boolean;
  locale: string;
  /** The voice helper owns Option-Space. */
  shortcut: boolean;
  model: {
    kind: "none" | "ollama" | "cloud";
    ready: boolean;
    /** One short line naming the model, never a key or a response body. */
    detail: string;
  };
  kokoro: KokoroUiStatus;
  /** The user finished or dismissed setup; the view is reachable either way. */
  complete: boolean;
}
/** A local Ollama, seen through `validateProviderEndpoint`, never a raw fetch. */
export interface OllamaStatus {
  running: boolean;
  /** Tags the run loop could actually use, newest listing order kept. */
  models: string[];
}
/** One cheap provider request: it never captures the screen or acts on it. */
export interface ProviderKeyResult {
  ok: boolean;
  message: string;
}
export const setupSteps = [
  "welcome",
  "permissions",
  "model",
  "voice",
  "task",
  "done",
] as const;
export type SetupStep = (typeof setupSteps)[number];
/**
 * The proof task: one draw of the `calculator-multiply` template in
 * src/gym/bench/catalogue.ts, which the bench grades with operands drawn per
 * attempt, so `npm run bench` exercises what first run asks for.
 */
export const firstTask = "Open Calculator and multiply 128 by 46";
/**
 * Download size beside the model id, so the number cannot drift away from
 * `providerDefaults.ollama.model`. Confirmed against the local tag list after
 * a pull rather than trusted afterwards.
 */
export const localModelSizes: Record<string, string> = {
  "qwen3-vl:8b": "about 6 GB",
  "qwen3-vl:2b": "about 2 GB",
};
/** The four permissions the checklist shows, in the order it shows them. */
export const setupPermissions = [
  {
    pane: "screen" as PrivacyPane,
    title: "Screen Recording",
    reason: "So it can see the screen it is working on.",
  },
  {
    pane: "accessibility" as PrivacyPane,
    title: "Accessibility",
    reason:
      "So it can click and type, and stop the moment you touch the mouse.",
  },
  {
    pane: "microphone" as PrivacyPane,
    title: "Microphone",
    reason: "So it can hear you while you hold ⌥Space.",
  },
  {
    pane: "speech" as PrivacyPane,
    title: "Speech Recognition",
    reason:
      "So it can turn what you said into text on this Mac. There is no cloud transcription.",
  },
];
/**
 * Ollama tags the run loop can use. Embedding, reranking and audio models
 * cannot drive a GUI, and an id with a slash or "cloud" in it is refused by
 * `validateProviderEndpoint` in PRIVATE_LOCAL, so offering one would be a trap.
 */
export function usableOllamaModels(names: unknown): string[] {
  if (!Array.isArray(names)) return [];
  const seen = new Set<string>();
  for (const name of names) {
    if (typeof name !== "string") continue;
    const id = name.trim();
    if (!id || id.length > 100 || seen.has(id)) continue;
    if (/cloud|\//i.test(id)) continue;
    if (/embed|rerank|whisper|(^|[-:_])tts([-:_]|$)|guard/i.test(id)) continue;
    seen.add(id);
  }
  return [...seen];
}
/** True once all four permissions are usable, relaunch included. */
export function permissionsReady(status: SetupStatus): boolean {
  return (
    status.screen &&
    !status.screenNeedsRelaunch &&
    status.accessibility &&
    status.microphone &&
    status.speech
  );
}
/**
 * Where setup resumes. A first launch starts at the welcome; a return after
 * the Screen Recording relaunch lands back on the checklist rather than on a
 * screen the user already read.
 */
export function resumeSetupAt(status: SetupStatus | null): SetupStep {
  if (!status) return "welcome";
  const started =
    status.screen ||
    status.accessibility ||
    status.microphone ||
    status.speech ||
    status.model.ready;
  if (!started) return "welcome";
  if (!permissionsReady(status)) return "permissions";
  if (!status.model.ready) return "model";
  return "task";
}
/**
 * One readable sentence per outcome of the key check. The provider's own
 * response body is never echoed: `blocked` is the single fact read out of it.
 */
export function providerKeyMessage(result: {
  provider: string;
  model: string;
  host: string;
  status: number;
  blocked?: boolean;
}): ProviderKeyResult {
  const { provider, model, host, status } = result;
  if (status >= 200 && status < 300)
    return {
      ok: true,
      message:
        "The key works. The prices below are used only for the local cost estimate — edit them if the provider changes them.",
    };
  if (result.blocked)
    return {
      ok: false,
      message:
        "This Google key is restricted. Allow generativelanguage.googleapis.com in the key's API restrictions, then check again.",
    };
  if (status === 401 || status === 403)
    return { ok: false, message: "The provider rejected this key." };
  if (status === 404)
    return {
      ok: false,
      message:
        provider === "compatible"
          ? `This endpoint does not list models at ${host}, so the key could not be checked here. Save it and try a task.`
          : `The key works, but ${model} is not available to it. Check the model ID.`,
    };
  if (status === 429)
    return {
      ok: false,
      message:
        "The provider is rate limiting requests (HTTP 429). Try again shortly.",
    };
  return {
    ok: false,
    message: `The provider returned HTTP ${status}. Verify model access and quota.`,
  };
}
export interface Bridge {
  info(): Promise<AppInfo>;
  /**
   * `key` is the provider key; `jevKey` the OpenRouter key for the opt-in
   * Jev decider. Either given as "" clears its slot; undefined leaves it.
   */
  saveSettings(
    settings: Settings,
    key?: string,
    jevKey?: string,
  ): Promise<void>;
  start(task: string, tutorial: boolean): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  confirm(yes: boolean): Promise<void>;
  history(): Promise<Run[]>;
  loadRun(id: string): Promise<Snapshot>;
  deleteRun(id: string): Promise<void>;
  feedback(id: string, success: boolean): Promise<void>;
  review(
    id: string,
    options?: Omit<Review, "affirmative" | "runId">,
  ): Promise<ReviewData>;
  donate(review: Review): Promise<{ receipt: string }>;
  withdraw(id: string): Promise<void>;
  exportWorkflow(id: string): Promise<string>;
  permissions(): Promise<void>;
  voicePermissions(): Promise<void>;
  command(text: string): Promise<void>;
  openCommand(): Promise<void>;
  pillState(): Promise<PillState>;
  dismiss(): Promise<void>;
  openSettings(section?: string): Promise<void>;
  closeSettings(): Promise<void>;
  memorySummary(): Promise<MemorySummary>;
  forgetMemory(): Promise<void>;
  /** Settings window only. Installed system voices and engine availability. */
  voices(): Promise<VoiceList>;
  /** Settings window only. Speaks the preview sample with the saved settings. */
  previewVoice(): Promise<void>;
  /** Settings window only. Opens System Settings for Spoken Content voices. */
  openVoiceSettings(): Promise<void>;
  /** Settings window only. Free on-device natural voice availability. */
  kokoroStatus(): Promise<KokoroUiStatus>;
  /**
   * Settings window only. Downloads the natural voice (or one voice pack);
   * resolves once every file is verified, rejects with a readable message
   * (or when cancelled).
   */
  downloadKokoro(voice?: KokoroVoiceId): Promise<void>;
  /** Settings window only. Stops a running download. */
  cancelKokoroDownload(): Promise<void>;
  /** Settings window only. Deletes the model; a saved "kokoro" engine becomes "system". */
  removeKokoro(): Promise<void>;
  /** Settings window only. Re-reads the two macOS permissions for texting. */
  messagesStatus(): Promise<MessagesInfo>;
  /** Settings window only. Which of Calendar and Reminders access is granted. */
  agendaStatus(): Promise<AgendaAccessInfo>;
  /** Settings window only. Asks macOS for Calendar and Reminders access. */
  requestAgendaAccess(): Promise<AgendaAccessInfo>;
  /**
   * Settings window only. Texts the saved handle once so the user can see it
   * arrive; rejects with the macOS setup step that is missing.
   */
  sendTestMessage(): Promise<void>;
  /**
   * Settings window only. The live first-run picture, polled while the setup
   * view is visible. Separate from `info()` so nothing is added to
   * `AppInfo.voice.kokoro`.
   */
  setupStatus(): Promise<SetupStatus>;
  /**
   * Settings window only. Opens one System Settings privacy pane, falling back
   * to Privacy & Security when the undocumented deep link is rejected.
   */
  openPrivacyPane(pane: PrivacyPane): Promise<void>;
  /** Settings window only. Quits and reopens, so a Screen Recording grant applies. */
  relaunch(): Promise<void>;
  /**
   * Settings window only. Looks for a local Ollama through
   * `validateProviderEndpoint`, never a raw fetch to an arbitrary endpoint.
   */
  detectOllama(): Promise<OllamaStatus>;
  /**
   * Settings window only. One cheap provider request that never captures or
   * drives the desktop. The key is used for the check and saved only by
   * `saveSettings`.
   */
  checkProviderKey(
    settings: Settings,
    key?: string,
  ): Promise<ProviderKeyResult>;
  /** Settings window only. Marks first-run setup done; the view stays reachable. */
  completeSetup(): Promise<void>;
  /** Settings window only. The phone remote's state: never a token or content. */
  remoteStatus(): Promise<RemoteStatus>;
  /**
   * Settings window only. What one phone may do; applied and saved at once,
   * since allowing a phone is consent, not a form field. Approve needs control.
   */
  setRemoteDevice(
    id: string,
    patch: { control?: boolean; approve?: boolean },
  ): Promise<RemoteStatus>;
  /** Settings window only. Forgets a phone and revokes its sessions now. */
  forgetRemoteDevice(id: string): Promise<RemoteStatus>;
  /** Settings window only. Cuts every phone off and turns the remote off. */
  lockRemote(): Promise<RemoteStatus>;
  /** Settings window only. The tool layer's state: labels, states, counts, resolved commands. */
  toolsStatus(): Promise<ToolsStatus>;
  /**
   * Settings window only. One Apple consent, applied and saved at once; turning
   * one on asks macOS for that app's grant (the only call that may prompt).
   */
  setAppleTool(consent: AppleConsent, on: boolean): Promise<ToolsStatus>;
  /** Settings window only. Adds rows that still need the user's approval. */
  addToolServer(input: AddToolServerInput): Promise<ToolsStatus>;
  /**
   * Settings window only. Connects once and lists the server's tools for the
   * consent sheet; descriptions are shown here and never traced.
   */
  testToolServer(id: string): Promise<ToolServerTest>;
  /** Settings window only. Pins the exact argv shown, consents, and starts the server. */
  approveToolServer(id: string): Promise<ToolsStatus>;
  /** Settings window only. A row's switches; a network change needs a new approval. */
  setToolServer(
    id: string,
    patch: {
      enabled?: boolean;
      trust?: "ask" | "reads_unattended";
      network?: "none" | "internet";
      name?: string;
    },
  ): Promise<ToolsStatus>;
  /** Settings window only. Ticks one tool at its current pin, or unticks it. */
  setToolTicked(id: string, tool: string, on: boolean): Promise<ToolsStatus>;
  /** Settings window only. A server's variable or header value into the vault; "" deletes. */
  setToolSecret(
    id: string,
    kind: "env" | "header",
    name: string,
    value: string,
  ): Promise<void>;
  /** Settings window only. Removes the row, its vault scopes and its process. */
  forgetToolServer(id: string): Promise<ToolsStatus>;
  /** Settings window only. Each module port's adapter in force, last code and latency (src/modules). */
  modulesStatus(): Promise<ModulesStatus>;
  /** Settings window only. Re-reads the user's recipes file and reports what loaded; never its words. */
  recipesStatus(): Promise<RecipesStatus>;
  /** Settings window only. Watching's switch, tier, pause state and the work log's counts. */
  watchingStatus(): Promise<WatchingStatus>;
  /** Settings window only. Pauses or resumes the observe stream now; the setting stays. */
  setWatchingPaused(paused: boolean): Promise<WatchingStatus>;
  /** Settings window only. Deletes today's work log, or every day's. */
  forgetWatching(scope: "today" | "all"): Promise<WatchingStatus>;
  /** Settings window only. What watching proposed and what the owner approved. */
  learnedProposals(): Promise<LearnedProposals>;
  /** Settings window only. Approve, dismiss ("Not this") or refuse for good ("Never"). */
  decideProposal(
    kind: ProposalKind,
    id: string,
    decision: ProposalDecision,
  ): Promise<LearnedProposals>;
  subscribePill(fn: (state: PillState) => void): () => void;
  subscribeView(fn: (view: string) => void): () => void;
  /** Download progress and install changes for the natural voice. */
  subscribeKokoro(fn: (status: KokoroUiStatus) => void): () => void;
  subscribe(fn: (s: Snapshot) => void): () => void;
}
declare global {
  interface Window {
    coarena?: Bridge;
  }
}
