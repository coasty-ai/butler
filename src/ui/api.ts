import type {
  Settings,
  Snapshot,
  Run,
  Frame,
  JournalEvent,
} from "../core/schema";
import type { Bundle, Review } from "../contribution/bundle";
import type { PillState } from "../voice/router";
import type { MemoryData } from "../memory/types";
export interface ReviewData {
  run: Run;
  frames: Frame[];
  events: JournalEvent[];
  bundle: Bundle;
  uploaded: boolean;
}
/** What Open Assist learned locally, for the user's own review in Settings. */
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
    /** Quality of the system voice that replies would use. */
    voiceQuality: VoiceQuality;
    /** Display name of that voice ("" when unknown). */
    voiceName: string;
    /** PRIVATE_BYOM with a saved OpenAI key. */
    cloudVoiceAllowed: boolean;
    /** The free on-device natural voice. */
    kokoro: KokoroUiStatus;
  };
}
export interface Bridge {
  info(): Promise<AppInfo>;
  saveSettings(settings: Settings, key?: string): Promise<void>;
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
   * Settings window only. Downloads the natural voice; resolves once every
   * file is verified, rejects with a readable message (or when cancelled).
   */
  downloadKokoro(): Promise<void>;
  /** Settings window only. Stops a running download. */
  cancelKokoroDownload(): Promise<void>;
  /** Settings window only. Deletes the model; a saved "kokoro" engine becomes "system". */
  removeKokoro(): Promise<void>;
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
