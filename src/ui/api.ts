import type {
  Settings,
  Snapshot,
  Run,
  Frame,
  JournalEvent,
} from "../core/schema";
import type { Bundle, Review } from "../contribution/bundle";
import type { PillState } from "../voice/router";
export interface ReviewData {
  run: Run;
  frames: Frame[];
  events: JournalEvent[];
  bundle: Bundle;
  uploaded: boolean;
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
  subscribePill(fn: (state: PillState) => void): () => void;
  subscribeView(fn: (view: string) => void): () => void;
  subscribe(fn: (s: Snapshot) => void): () => void;
}
declare global {
  interface Window {
    coarena?: Bridge;
  }
}
