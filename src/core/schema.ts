import { z } from "zod";
const unit = z.number().finite().min(0).max(1);
export const supportedKeys = [
  "ENTER",
  "TAB",
  "ESC",
  "BACKSPACE",
  "DELETE",
  "SPACE",
  "UP",
  "DOWN",
  "LEFT",
  "RIGHT",
  "HOME",
  "END",
  "PAGEUP",
  "PAGEDOWN",
  "CMD",
  "CTRL",
  "ALT",
  "SHIFT",
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  ..."0123456789",
] as const;
const key = z.enum(supportedKeys);
const base = { frame_id: z.string().min(1).max(100) };
const point = { x: unit, y: unit };
export const actionSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("capture") }).strict(),
  z
    .object({
      ...base,
      type: z.literal("click"),
      ...point,
      button: z.enum(["left", "right"]).default("left"),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("double_click"),
      ...point,
      button: z.enum(["left", "right"]).default("left"),
    })
    .strict(),
  z.object({ ...base, type: z.literal("right_click"), ...point }).strict(),
  z.object({ ...base, type: z.literal("move"), ...point }).strict(),
  z
    .object({
      ...base,
      type: z.literal("drag"),
      start_x: unit,
      start_y: unit,
      end_x: unit,
      end_y: unit,
      duration_ms: z.number().int().min(100).max(2000),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("scroll"),
      delta_x: z.number().int().min(-1000).max(1000),
      delta_y: z.number().int().min(-1000).max(1000),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("type_text"),
      text: z.string().min(1).max(2000),
    })
    .strict(),
  z.object({ ...base, type: z.literal("key"), key }).strict(),
  z
    .object({
      ...base,
      type: z.literal("hotkey"),
      keys: z.array(key).min(1).max(4),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("wait"),
      milliseconds: z.number().int().min(0).max(5000),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("request_user"),
      reason: z.string().max(500),
    })
    .strict(),
  z
    .object({ ...base, type: z.literal("done"), summary: z.string().max(2000) })
    .strict(),
  z
    .object({ ...base, type: z.literal("fail"), reason: z.string().max(500) })
    .strict(),
]);
export type Action = z.infer<typeof actionSchema>;
export const privacySchema = z.enum(["PRIVATE_LOCAL", "PRIVATE_BYOM"]);
export type PrivacyMode = z.infer<typeof privacySchema>;
export const providerSchema = z.enum([
  "ollama",
  "openai",
  "anthropic",
  "google",
  "compatible",
]);
export type ProviderKind = z.infer<typeof providerSchema>;
export const settingsSchema = z
  .object({
    privacy: privacySchema,
    provider: providerSchema,
    model: z.string().min(1).max(100),
    endpoint: z.string().url(),
    maxActions: z.number().int().min(1).max(200),
    maxSeconds: z.number().int().min(10).max(1800),
    maxCost: z.number().min(0.01).max(50),
    inputPrice: z.number().min(0).max(1000),
    outputPrice: z.number().min(0).max(1000),
    protectedApps: z.array(z.string().max(100)).max(100),
    protectedDomains: z.array(z.string().max(200)).max(100),
    displayId: z.number().int().nonnegative().optional(),
    contributionEndpoint: z.string().max(300),
    handsFree: z.boolean().default(false),
  })
  .strict();
export type Settings = z.infer<typeof settingsSchema>;
export const defaultSettings: Settings = {
  privacy: "PRIVATE_LOCAL",
  provider: "ollama",
  model: "qwen3-vl:8b",
  endpoint: "http://127.0.0.1:11434",
  maxActions: 30,
  maxSeconds: 300,
  maxCost: 1,
  inputPrice: 0,
  outputPrice: 0,
  protectedApps: [
    "com.1password.1password",
    "com.agilebits.onepassword7",
    "com.apple.Passwords",
    "com.apple.keychainaccess",
    "com.bitwarden.desktop",
    "com.apple.Terminal",
    "com.googlecode.iterm2",
  ],
  protectedDomains: [
    "paypal.com",
    "chase.com",
    "bankofamerica.com",
    "mychart.com",
    "login.gov",
  ],
  contributionEndpoint: "",
  handsFree: false,
};
export interface Geometry {
  display_id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  native_width: number;
  native_height: number;
  model_width: number;
  model_height: number;
  scale_factor: number;
}
export interface Frame {
  id: string;
  sha256: string;
  image: string;
  geometry: Geometry;
  capturedAt: number;
  synthetic: boolean;
  appId?: string;
  context?: ScreenContext;
}
export interface ScreenContext {
  appName: string;
  windowTitle: string;
  documentName?: string;
  selectedText?: string;
  launcher?: { query: string; selectedResult?: string };
  browserAddress?: string;
  visibleText?: string;
  recentWindows?: { appName: string; title: string }[];
  recentFiles?: string[];
  recentTasks?: { task: string; status: string }[];
}
export interface Surface {
  appId: string;
  pid: number;
  secureInput: boolean;
  domain?: string;
  unknown: boolean;
  targetRole?: string;
  targetSubrole?: string;
  targetAppId?: string;
  targetEnabled?: boolean;
  launcherAppId?: string;
  targetLabel?: string;
  targetURL?: string;
  focusedRole?: string;
  addressBar?: boolean;
  focusedValue?: string;
  launcher?: { query: string; selectedResult?: string };
}
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cost: number;
}
export interface Observation {
  task: string;
  frame: Frame;
  history: { type: string; action?: Record<string, unknown>; result: string }[];
}
export interface Provider {
  next(
    observation: Observation,
    signal: AbortSignal,
  ): Promise<{ action: unknown; usage: Usage }>;
}
export interface Controller {
  kind: "tutorial" | "native";
  surface(action?: Action): Promise<Surface>;
  capture(): Promise<Frame>;
  execute(action: Action, frame: Frame, signal: AbortSignal): Promise<void>;
  stop(): void;
  resume(): Promise<void>;
  restore?(frame: Frame): Promise<void>;
  revalidate?(action: Action, frame: Frame): Promise<Frame>;
}
export type RunStatus =
  | "idle"
  | "capturing"
  | "thinking"
  | "executing"
  | "confirming"
  | "takeover"
  | "paused"
  | "completed"
  | "cancelled"
  | "failed";
export interface JournalEvent {
  event_id: string;
  run_id: string;
  sequence_number: number;
  monotonic_timestamp: number;
  wall_clock_timestamp: string;
  schema_version: 1;
  type: string;
  data: Record<string, unknown>;
}
export interface Run {
  id: string;
  task: string;
  createdAt: string;
  status: RunStatus;
  privacy: PrivacyMode;
  provider: string;
  model: string;
  synthetic: boolean;
  actions: number;
  frames: number;
  usage: Usage;
  summary: string;
  outcome?: boolean;
  contribution?: string;
  corrections?: { text: string; after_action: number; timestamp: string }[];
}
export interface Snapshot {
  run: Run | null;
  frame: Frame | null;
  events: JournalEvent[];
  pending?: { action: Action; reason: string };
  message: string;
}
export interface Recorder {
  begin(run: Run): void;
  append(
    runId: string,
    type: string,
    data?: Record<string, unknown>,
  ): JournalEvent;
  frame(runId: string, frame: Frame): void;
  save(run: Run): void;
}
export function validateAction(input: unknown, frame: Frame): Action {
  const a = actionSchema.parse(input);
  if (a.frame_id !== frame.id) throw new Error("STALE_FRAME");
  if (a.type === "hotkey" && a.keys.length === 1)
    return { type: "key", key: a.keys[0], frame_id: a.frame_id };
  return a;
}
export function sameGeometry(a: Geometry, b: Geometry): boolean {
  // Swift dictionaries do not promise a stable JSON property order. Check
  // every value and key instead; missing/added fields still invalidate approval.
  const keys = Object.keys(a) as (keyof Geometry)[];
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key])
  );
}
export function mapPoint(g: Geometry, x: number, y: number) {
  unit.parse(x);
  unit.parse(y);
  return {
    x: g.x + Math.min(g.width - 1, Math.floor(x * g.width)),
    y: g.y + Math.min(g.height - 1, Math.floor(y * g.height)),
  };
}
