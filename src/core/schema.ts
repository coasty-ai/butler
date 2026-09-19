import { z } from "zod";
import {
  RESERVED_PROVIDERS,
  TOOL_ID,
  TOOL_LIMITS,
  type ToolSummary,
  type ToolUnavailable,
} from "./tools";
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
// A plain application display name, never a path, bundle identifier, URL or
// document: what open_app launches and what open_file may open an item in.
// Both resolve it natively against the same allow-listed application folders.
const applicationName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[^/\\:\u0000-\u001f\u007f]+$/, "Use a plain application name.")
  .refine((name) => !name.startsWith("."), "Use a plain application name.");
const point = { x: unit, y: unit };
/** Roles context.controls reports (native role names, lowercased, no "AX"). */
export const CONTROL_ROLES: ReadonlySet<string> = new Set([
  "button",
  "link",
  "textfield",
  "textarea",
  "combobox",
  "checkbox",
  "radiobutton",
  "popupbutton",
  "menubutton",
  "menuitem",
  "tab",
  "cell",
  "row",
  "list",
  "table",
  "outline",
  "group",
  "image",
  "statictext",
  "heading",
  "slider",
  "incrementor",
  "disclosuretriangle",
  "toolbar",
  "tabgroup",
  "searchfield",
]);
/** A model-written role as a listed role, or undefined when it names none. */
export function controlRole(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const words = value
    .toLowerCase()
    .replace(/^ax/, "")
    .split(/[^a-z]+/)
    .filter(Boolean);
  const joined = words.join("");
  if (CONTROL_ROLES.has(joined)) return joined;
  const last = words[words.length - 1];
  return last && CONTROL_ROLES.has(last) ? last : undefined;
}
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
  /**
   * Presses a menu item the frontmost application publishes, by name
   * ("Playback" > "Play"). The menu bar is every application's own list of what
   * it can do, it stays readable when the window publishes nothing, and the
   * path is resolved again at the moment of input, so nothing here depends on
   * pixels. See docs/ARCHITECTURE.md.
   */
  z
    .object({
      ...base,
      type: z.literal("menu_item"),
      path: z.array(z.string().trim().min(1).max(60)).min(2).max(3),
    })
    .strict(),
  /**
   * Clicks a control from context.controls by its name instead of its
   * position. The name is the intent; x and y, when given, only tell identical
   * names apart. Resolved again at the moment of input, so a page that
   * animated or a list that reflowed cannot redirect the click.
   */
  z
    .object({
      ...base,
      type: z.literal("click_control"),
      label: z.string().trim().min(1).max(120),
      // Only a filter: a role the model spells its own way ("day cell",
      // "AXButton") is mapped to a listed role or dropped, which widens the
      // match instead of rejecting the whole action (the label still has to
      // match). Live: role "day cell" made the action invalid.
      role: z.preprocess(controlRole, z.string().optional()),
      ...{ x: unit.optional(), y: unit.optional() },
    })
    .strict(),
  // Launch-only primitive. A plain application display name, never a path,
  // bundle identifier, URL or document. The native helper resolves it against
  // allow-listed application folders; see docs/ARCHITECTURE.md.
  z
    .object({
      ...base,
      type: z.literal("open_app"),
      name: applicationName,
    })
    .strict(),
  // Open-only primitive for a document or folder the local system index
  // reported (home-relative "~/..." path). Never executables, apps, scripts or
  // installers; see docs/MEMORY.md. With `app`, the item opens in that
  // application instead of its default one ("open the project folder in
  // Visual Studio Code" is then one step): the name goes through the open_app
  // allow-list natively, so a terminal or a protected app never opens it.
  z
    .object({
      ...base,
      type: z.literal("open_file"),
      path: z
        .string()
        .trim()
        .min(3)
        .max(500)
        .regex(/^~\/[^\u0000-\u001f\u007f]+$/, "Use a ~/ path from context.")
        .refine(
          (path) =>
            !path.split("/").some((part) => part === ".." || part === "."),
          "Use a ~/ path from context.",
        ),
      app: applicationName.optional(),
    })
    .strict(),
  /**
   * Hands the frontmost window to a detached watch (electron/watch.ts) and
   * ends the run: the window's text is then read every every_s seconds with
   * no model call, and a new run wakes the model with context.watch when the
   * agent in it finishes, needs input or the window changes, or when the
   * watch stalls, fails or runs past max_min.
   */
  z
    .object({
      ...base,
      type: z.literal("monitor"),
      reason: z.string().trim().min(1).max(200),
      every_s: z.number().int().min(5).max(60).default(10),
      max_min: z.number().int().min(1).max(180).default(30),
      until: z.enum(["done", "input", "change"]).default("done"),
    })
    .strict(),
  /**
   * Calls one tool from context.tools (src/core/tools.ts) instead of driving
   * the screen: validated, tiered and asked about like any step, executed by
   * the tool layer, never by the native helper.
   */
  z
    .object({
      ...base,
      type: z.literal("tool_call"),
      tool: z.string().regex(TOOL_ID),
      args: z.record(z.string().max(64), z.unknown()).default({}),
      /** "This one call completes the objective": honoured only for a verified builtin write. */
      finish: z.boolean().default(false),
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
/** OpenAI gpt-4o-mini-tts voices offered for the opt-in natural voice. */
export const cloudVoices = [
  "marin",
  "cedar",
  "alloy",
  "coral",
  "sage",
  "verse",
  "ballad",
  "fable",
  "ash",
  "echo",
  "onyx",
] as const;
/** Kokoro voice packs: the base American voice and the British male pair. */
export const kokoroVoices = ["af_heart", "bm_george", "bm_fable"] as const;
export type KokoroVoiceId = (typeof kokoroVoices)[number];
/**
 * How a run was started: what asked for it, not who approved its steps.
 * "bench" is the automation benchmark driving the desktop unattended; it never
 * arrives through the app's IPC, which accepts only the interactive origins.
 */
export type RunOrigin =
  "voice" | "typed" | "message" | "queue" | "watch" | "remote" | "bench";
/**
 * Whose words the task text is. Only "user_words" counts as the user's own
 * request for provenance checks: typed, texted, or speech heard with at least
 * APPROVAL_MIN_CONFIDENCE. A model rewrite or an accepted proposal never does.
 */
export type TaskSource =
  "user_words" | "user_words_unsure" | "model_rewrite" | "proposal";
/** One tool server the user connected (docs/TOOLS.md). */
export const toolServerSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,39}$/)
      .refine((id) => !RESERVED_PROVIDERS.has(id), "Reserved id."),
    name: z.string().trim().min(1).max(40), // the user's label; appears in questions
    transport: z.enum(["stdio", "http"]),
    command: z.string().max(500).default(""),
    args: z.array(z.string().max(500)).max(40).default([]),
    env: z
      .record(z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/), z.string().max(500))
      .default({}), // non-secret
    secretEnv: z
      .array(z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/))
      .max(16)
      .default([]), // values in the vault
    cwd: z.string().max(500).default(""),
    url: z.string().max(300).default(""), // https only; validated by validateToolSettings
    secretHeaders: z
      .array(z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/))
      .max(8)
      .default([]), // values in the vault
    enabled: z.boolean().default(false),
    /** The user read the consent sheet and approved this exact argv (approvedCommand). */
    consented: z.boolean().default(false),
    trust: z.enum(["ask", "reads_unattended"]).default("ask"),
    /** The privacy tier: "none" may run in PRIVATE_LOCAL under the sandbox; "internet" is BYOM only. */
    network: z.enum(["none", "internet"]).default("internet"),
    approvedCommand: z.string().max(64).default(""), // sha256(argv, cwd, sorted env names, url)
    recipe: z.string().max(40).default(""), // ServerRecipe.id that created the row; "" when pasted
    tools: z
      .record(
        z.string().max(128),
        z.object({ on: z.boolean(), pin: z.string().max(64) }).strict(),
      )
      .default({}),
    addedAt: z.number().int().nonnegative(),
  })
  .strict();
export type ToolServer = z.infer<typeof toolServerSchema>;
export const toolsSettingsSchema = z
  .object({
    enabled: z.boolean().default(true), // master switch; inert until a consent below
    /** The Apple bridge (coarena-apple), one consent per app; each asks macOS for its own grant from Settings. */
    apple: z
      .object({
        calendar: z.boolean().default(false),
        reminders: z.boolean().default(false),
        notes: z.boolean().default(false),
        mail: z.boolean().default(false),
      })
      .strict()
      .prefault({}),
    servers: z.array(toolServerSchema).max(TOOL_LIMITS.servers).default([]),
  })
  .strict()
  .prefault({}); // NOT .default({}): inner defaults must apply (measured, plan §3.8)
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
    /**
     * When a step carries its screenshot (src/core/vision.ts). "always":
     * every step, at full size. "auto" (the default): full size on a run's
     * first step, after a step whose target native input could not verify,
     * when the screenshot had to be read for text, on a blind or unknown
     * surface, after the model calls capture and at least every 4th step;
     * left out while the screen is unchanged since the last step; otherwise
     * reduced to at most 1024 px wide when the accessibility context already
     * describes the screen. "text-first": as auto, but left out instead of
     * reduced.
     */
    visionMode: z.enum(["always", "auto", "text-first"]).default("auto"),
    protectedApps: z.array(z.string().max(100)).max(100),
    protectedDomains: z.array(z.string().max(200)).max(100),
    displayId: z.number().int().nonnegative().optional(),
    contributionEndpoint: z.string().max(300),
    handsFree: z.boolean().default(false),
    /** Learn from completed tasks (local encrypted memory, skills, index). */
    memory: z.boolean().default(true),
    /**
     * Read notification banners as they arrive and carry the recent ones in
     * the model's context. Off by default: banners carry other people's
     * messages and one-time codes, so reading them is a choice, never a
     * surprise. Off means the helper never reads them at all.
     */
    notifications: z.boolean().default(false),
    /**
     * Read upcoming events and open reminders so a task knows what is on the
     * user's plate. Needs Calendar and Reminders access, asked for in Settings.
     */
    agenda: z.boolean().default(false),
    /**
     * Spoken replies: "voice" only for turns the user started by voice,
     * "always" also for typed tasks (never typed acknowledgements).
     */
    voiceReplies: z.enum(["off", "voice", "always"]).default("voice"),
    /** "openai" is opt-in and only used in PRIVATE_BYOM with an OpenAI key. */
    /**
     * system: Apple voice (on-device). kokoro: free natural on-device voice
     * after its one-time model download. openai: opt-in cloud voice.
     */
    voiceEngine: z.enum(["system", "kokoro", "openai"]).default("system"),
    /** System engine voice identifier; "" picks the best installed voice. */
    voiceId: z.string().max(200).default(""),
    cloudVoice: z.enum(cloudVoices).default("marin"),
    /** Kokoro voice pack; the British packs are separate downloads. */
    kokoroVoice: z.enum(kokoroVoices).default("af_heart"),
    voiceRate: z.number().min(0.8).max(1.4).default(1),
    /** How long hands-free listening waits through a pause. */
    listeningPatience: z.enum(["quick", "normal", "relaxed"]).default("normal"),
    /** Hands-free only: listen briefly for a reply without the wake phrase. */
    followUpListening: z.boolean().default(true),
    /**
     * How long those windows stay open (src/voice/turns.ts followUpSeconds).
     * "conversation" (the default): after "Hey Butler" and after every reply
     * the window stays open until "thanks", "that's all", "goodbye" or "stop
     * listening", with no timer but a 15-minute cap on silence; anything said
     * in the room meanwhile is taken as addressed to Butler. "short": 3 s to
     * add to a request, 8 s for an answer or a yes. "long": 20 s / 20 s /
     * 12 s. Approvals stay bounded in every mode. A saved "long" stays, and
     * a saved "short" once the picker chose it (followUpWindowChosen); the
     * "short" every earlier build wrote on its own moves to the default once
     * (migrateFollowUpWindow, src/voice/turns.ts).
     */
    followUpWindow: z
      .enum(["short", "long", "conversation"])
      .default("conversation"),
    /**
     * The Keep listening picker was used. Every build before the conversation
     * default filled "short" into a config without the field and saved it
     * back, so only this tells a chosen Briefly from the old default.
     */
    followUpWindowChosen: z.boolean().default(false),
    /**
     * Open the app a spoken request starts with while the user is still
     * talking ("open Slack and…" brings Slack forward before "and";
     * electron/early-start.ts). Only opening or switching to a named,
     * verified app; nothing is typed, clicked or sent early. Local only, so
     * allowed in every privacy mode.
     */
    earlyStart: z.boolean().default(true),
    voiceSounds: z.boolean().default(true),
    /**
     * Free-form turns ("how's it going?", small talk) go to a text-only call
     * on the configured model; "off" keeps the deterministic routing only.
     */
    conversation: z.enum(["model", "off"]).default("model"),
    /**
     * How often a run stops to ask. "ask": every consequential step, as
     * before. "task" (the default): a step the user's own words asked for
     * and that can be undone runs without asking, and is reported instead.
     * "flow": every step that can be undone runs without asking; money
     * leaving, anything going out under the user's name, deletions,
     * installs and account or security settings still ask. "all": those
     * stop asking too — only when the user chose it and ticked what it
     * means (autonomyAllAcknowledged); without that it behaves as "flow".
     * What is refused rather than asked never changes: protected apps and
     * websites, credential fields, secrets in typed text, the emergency
     * stop. Every unasked step is still reported.
     */
    autonomy: z.enum(["ask", "task", "flow", "all"]).default("task"),
    /**
     * The user ticked the acknowledgement beside "allow everything": that it
     * can send, buy, delete and install without asking. Kept separate from
     * the mode so nothing but a deliberate choice can turn it on.
     */
    autonomyAllAcknowledged: z.boolean().default(false),
    /** Text model for dialog and summaries; "" means the run model. */
    dialogModel: z.string().max(100).default(""),
    /** Hourly ceiling for dialog and summary calls, in estimated dollars. */
    dialogHourlyCost: z.number().min(0.05).max(10).default(0.5),
    /**
     * The early decider for free-form turns: TypeSafe's Jev (through
     * OpenRouter) is asked for the dialog act in parallel with the text
     * model, and a confident "start" runs the user's own words at once. It
     * can only make a turn faster, never change what else happens. "auto"
     * (the default) runs it once the user has consented (jevConsented) and
     * an OpenRouter key is stored; "off" is the user's explicit choice; "jev"
     * is the older explicit on, migrated to "auto" at load. Never in
     * PRIVATE_LOCAL.
     */
    decisions: z.enum(["auto", "off", "jev"]).default("auto"),
    /** The user set `decisions` themselves: a stored "off" is theirs. */
    decisionsChosen: z.boolean().default(false),
    /**
     * The user agreed to send the conversation state to OpenRouter and
     * TypeSafe: by typing an OpenRouter key into Settings beside the
     * disclosure, ticking the toggle, or launching with --decide-with-jev.
     * A key imported from a .env is never consent on its own.
     */
    jevConsented: z.boolean().default(false),
    persona: z.enum(["jarvis", "friendly"]).default("jarvis"),
    /** How the assistant addresses the user; letters, spaces and ' . - only. */
    addressAs: z
      .string()
      .trim()
      .max(40)
      .regex(/^[\p{L} .'-]*$/u)
      .default(""),
    /** Short spoken progress lines during a long run started by voice. */
    spokenProgress: z.boolean().default(true),
    /** Minutes between progress updates on long runs; 0 turns them off. */
    progressEveryMinutes: z
      .union([
        z.literal(0),
        z.literal(5),
        z.literal(10),
        z.literal(15),
        z.literal(30),
      ])
      .default(10),
    /** Longest a detached watch of a coding agent may run. */
    watchMaxMinutes: z.number().int().min(5).max(240).default(120),
    /** Minutes without visible change before a watch reports a stall. */
    stallMinutes: z.number().int().min(3).max(60).default(8),
    /** Hold a power assertion during runs and watches (opt-in). */
    keepAwake: z.boolean().default(false),
    /**
     * Text updates and texted commands over iMessage (docs/MESSAGING.md).
     * Off until the user turns it on; the handle lives in the encrypted
     * config, never read from .env at runtime.
     */
    messages: z.boolean().default(false),
    /** The one phone number or iMessage address Butler ever texts. */
    messagesHandle: z.string().trim().max(100).default(""),
    /** Read replies from that handle as commands (status/stop/do …). */
    messagesCommands: z.boolean().default(true),
    /**
     * "texted": only runs started by message. "away": those, plus every run
     * once the user has left the Mac. "all": every run.
     */
    messagesUpdates: z.enum(["texted", "away", "all"]).default("texted"),
    /** Free-form texts steer and ask; off keeps the fixed command words. */
    messagesConversation: z.boolean().default(true),
    /** "detailed" lets progress texts quote window titles and screen text. */
    messagesDetail: z.enum(["brief", "detailed"]).default("brief"),
    /**
     * The phone remote over the user's own Tailscale network (docs/REMOTE.md).
     * Off until the user turns it on; the page is served only on this node's
     * tailnet address, never on the internet, and Funnel is never enabled.
     */
    remoteEnabled: z.boolean().default(false),
    /** The listening port on the tailnet address; never Tailscale's 41641. */
    remotePort: z.number().int().min(1024).max(65535).default(41680),
    /**
     * The one Tailscale login allowed to connect; "" means this Mac's own,
     * captured the first time the remote starts so a later re-login on the
     * Mac cannot silently widen the allow-list.
     */
    remoteUser: z.string().trim().max(200).default(""),
    /**
     * What the phone may see of the screen: nothing, or a content-free
     * thumbnail (a 24-pixel mosaic scaled up: layout and colour, no text).
     */
    remoteScreenshots: z.enum(["off", "thumbnail"]).default("off"),
    /**
     * Phones that have connected, each with what it may do. A row is added
     * with both switches off; only Settings on the Mac flips them. Bounded
     * and pruned least-recently-seen first.
     */
    remoteDevices: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            name: z.string().max(64),
            control: z.boolean(),
            approve: z.boolean(),
            firstSeen: z.number().int().nonnegative(),
            lastSeen: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(12)
      .default([]),
    /**
     * First-run setup was finished or dismissed. False opens the setup view on
     * launch, so quitting to apply a Screen Recording grant comes back to it.
     * Defaults to false for a fresh install; electron/main.ts treats a stored
     * config from before this field as already set up.
     */
    setupComplete: z.boolean().default(false),
    tools: toolsSettingsSchema,
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
  visionMode: "auto",
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
  memory: true,
  notifications: false,
  agenda: false,
  voiceReplies: "voice",
  voiceEngine: "system",
  voiceId: "",
  cloudVoice: "marin",
  kokoroVoice: "af_heart",
  voiceRate: 1,
  listeningPatience: "normal",
  followUpListening: true,
  followUpWindow: "conversation",
  followUpWindowChosen: false,
  earlyStart: true,
  voiceSounds: true,
  conversation: "model",
  autonomy: "task",
  autonomyAllAcknowledged: false,
  dialogModel: "",
  dialogHourlyCost: 0.5,
  decisions: "auto",
  decisionsChosen: false,
  jevConsented: false,
  persona: "jarvis",
  addressAs: "",
  spokenProgress: true,
  progressEveryMinutes: 10,
  watchMaxMinutes: 120,
  stallMinutes: 8,
  keepAwake: false,
  messages: false,
  messagesHandle: "",
  messagesCommands: true,
  messagesUpdates: "texted",
  messagesConversation: true,
  messagesDetail: "brief",
  remoteEnabled: false,
  remotePort: 41680,
  remoteUser: "",
  remoteScreenshots: "off",
  remoteDevices: [],
  setupComplete: false,
  tools: {
    enabled: true,
    apple: { calendar: false, reminders: false, notes: false, mail: false },
    servers: [],
  },
};
/** One phone the remote knows about (settings.remoteDevices). */
export type RemoteDevice = Settings["remoteDevices"][number];
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
  /** Native capture stage times in ms (settle, content, shot, context, controls, ocr, encode, total). */
  timings?: Record<string, number>;
  /**
   * The screenshot at most 1024 px wide as a JPEG, for the model's reduced
   * look (settings.visionMode). The PNG in image stays the frame of record:
   * it is what the hash names, what review shows and what is stored.
   */
  preview?: { image: string; width: number; height: number };
}
export interface ScreenContext {
  appName: string;
  windowTitle: string;
  /**
   * How many windows the frontmost application shows on screen. 0 means it is
   * open and frontmost with no window (Calendar after its window closed), so
   * the screenshot shows whatever is behind it. A count only, never titles.
   */
  windowCount?: number;
  documentName?: string;
  selectedText?: string;
  launcher?: { query: string; selectedResult?: string };
  browserAddress?: string;
  visibleText?: string;
  recentWindows?: { appName: string; title: string }[];
  recentFiles?: string[];
  recentTasks?: { task: string; status: string }[];
  /** Visible controls of the focused window; x/y are screenshot fractions. */
  controls?: {
    role: string;
    label?: string;
    x: number;
    y: number;
    enabled?: boolean;
  }[];
  /**
   * How much of its own interface the frontmost application publishes to the
   * accessibility API. "none" is a blind surface (a Chromium/CEF window such
   * as Spotify): controls is empty and no focused field is reported.
   */
  accessibility?: "none" | "partial" | "full";
  /**
   * The frontmost application's menus, one line each ("Playback: Play, Next
   * [CMD+RIGHT], …"): its own declaration of what it can do, and the only
   * route in an application that publishes no controls. Titles and shortcuts
   * only, never document contents.
   */
  menus?: string[];
  /**
   * Text recognized on-device from the screenshot inside the frontmost window,
   * top to bottom, when accessibility provided little text (Spotify, canvas
   * apps, a browser whose page tree is switched off).
   */
  screenText?: string;
  /**
   * Every application the user has open, most recently used first, with the
   * titles of its windows ("Slack: Prateek J (DM)"), so work already in
   * progress is picked up rather than started again.
   */
  openApps?: string[];
  /**
   * Notifications that arrived while the assistant was running, oldest first
   * ("Slack, 4m ago: Nitish — can you look at this?"). Only while the user
   * has them switched on, never from a protected application (docs/PRIVACY.md).
   */
  notifications?: string[];
  /**
   * Why this run started, when a detached watch woke the model: the cause,
   * the agent's state and how long it was watched, and the text last read
   * from its panel (bounded, redacted; untrusted screen text like the rest).
   */
  watch?: WatchContext;
}
export interface WatchContext {
  cause: string;
  agent?: string;
  state: string;
  minutes: number;
  lastChangeMinutes: number;
  /** What the watched run did before it handed the window over, one line per step, never typed text. */
  steps?: string[];
  /** At most 1500 characters. */
  panelText?: string;
}
/** One line read from a watched window; the box is in fractions of that window, origin top left. */
export interface OcrLine {
  t: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
/** A part of a watched window, in fractions of it, origin top left. */
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}
/**
 * A window the helper agreed to watch. Probes name it by the token alone,
 * which the helper minted, so nothing in TypeScript can point a probe at any
 * other window.
 */
export interface WatchBinding {
  token: string;
  appId: string;
  pid: number;
  windowId: number;
  title: string;
}
export type ProbeFailure =
  | "window_gone"
  | "not_visible"
  | "protected"
  | "secure_input"
  | "screen_locked"
  | "failed";
/** What one read of the watched window found; lines never enter a Snapshot. */
export type ProbeResult =
  | {
      ok: true;
      frontmost: boolean;
      title: string;
      lines: OcrLine[];
      idleMs: number;
    }
  | { ok: false; code: ProbeFailure };
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
  /** Text of the element originally hit before walking up to its control. */
  targetText?: string;
  /** Host of the web page containing the pointer target, if any. */
  targetWebHost?: string;
  /** A sheet, dialog or alert is focused or contains the target. */
  modal?: boolean;
  focusedSubrole?: string;
  /** Title, description or placeholder of the focused element (bounded). */
  focusedLabel?: string;
  /**
   * Windows the frontmost application shows on screen, reported natively for
   * open_app and for a click on a Dock application. 0 means open with no window.
   */
  windowCount?: number;
  /** open_app resolution produced natively by surface(action). */
  launcherName?: string;
  launcherStatus?: "resolved" | "unresolved" | "ambiguous" | "refused";
  launcherCandidates?: string[];
  /** open_file resolution produced natively by surface(action). */
  fileStatus?: "resolved" | "unresolved" | "refused";
  fileKind?: "document" | "folder";
  fileName?: string;
  /** Display name of the frontmost application, for approval questions. */
  appName?: string;
  /**
   * How much of its own interface the frontmost application publishes.
   * "none" means a real, sized window is frontmost and yet a completed walk
   * found no actionable element, no usable focused element and no hit-test
   * target: a blind surface (Chromium/CEF apps such as Spotify). Absent when
   * there is no verdict (accessibility untrusted, no window yet).
   */
  accessibility?: "none" | "partial" | "full";
  /** menu_item resolution produced natively by surface(action). */
  menuStatus?: "resolved" | "disabled" | "missing" | "refused";
  /** The resolved menu item's own title, for the approval question. */
  menuLabel?: string;
  /** click_control resolution produced natively by surface(action). */
  controlStatus?: "resolved" | "disabled" | "ambiguous" | "missing";
  controlLabel?: string;
  /** The menu item a proposed shortcut invokes in this application, if any. */
  shortcutLabel?: string;
  /**
   * "refused" when that item is one native never presses (Quit, Log Out, Empty
   * Trash): native refuses the chord whichever way it would go (hotkeyRoute).
   */
  shortcutStatus?: "refused";
  /**
   * The application's own search command the agent just ran here ("Search",
   * "Jump to…"), while it is still the context for typing: text typed now
   * goes into that search field even when the field is not exposed.
   */
  searchOpenedBy?: string;
  /**
   * The application's own search command ("Edit", "Search"), reported when
   * text is proposed with nothing identified to type into.
   */
  searchCommand?: string[];
  /**
   * What the agent has typed since searchOpenedBy ran, when that command opened
   * a command palette (or any quick-open box in VS Code and its forks). Set
   * natively only while that command is current. It is the field's exact text
   * unless searchQueryState says otherwise, and is then the text last known.
   */
  searchQuery?: string;
  /**
   * Why searchQuery may not describe what ENTER selects: "moved" after an
   * arrow or page key moved the selection off the top match (the text is
   * unchanged), "edited" after a deletion, a caret key or typing cut short.
   */
  searchQueryState?: "moved" | "edited";
  /**
   * The focused element is a terminal's input (VS Code's integrated xterm.js
   * terminal and the like), where typed text and ENTER run shell commands.
   */
  terminalFocus?: boolean;
}
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cost: number;
  /**
   * Of inputTokens, the tokens the provider served from its prompt cache
   * (Anthropic cache reads, OpenAI cached_tokens, Gemini cached content).
   * Absent when the provider reports no cache.
   */
  cachedInputTokens?: number;
}
/** Why a step carries its screenshot at full size, reduced, or not at all (src/core/vision.ts). */
export type ScreenshotReason =
  | "always"
  | "first"
  | "requested"
  | "blind"
  | "ocr"
  | "unconfirmed"
  | "cadence"
  | "unchanged"
  | "described"
  | "changed";
export interface ScreenshotUse {
  send: "full" | "reduced" | "none";
  reason: ScreenshotReason;
}
export interface Observation {
  task: string;
  frame: Frame;
  history: { type: string; action?: Record<string, unknown>; result: string }[];
  /** Task-relevant memory and system index context (bounded; see docs/MEMORY.md). */
  memory?: MemoryContext;
  /** The tools this run may call, on the model's copy only; never persisted. */
  tools?: { now: string; list: ToolSummary[]; unavailable: ToolUnavailable[] };
  /** How much of the frame's screenshot to send; a full screenshot when absent. */
  screenshot?: ScreenshotUse;
}
export interface MemoryContext {
  /** Learned preferences relevant to the task (sanitized, short). */
  preferences: string[];
  /** Similar past tasks and how they ended (short lines). */
  episodes: string[];
  /** Installed applications relevant to the task or frequently used. */
  apps?: { name: string; bundleId: string }[];
  /** Files matching the task or recently used (home-relative paths). */
  files?: { name: string; path: string; kind: string; lastUsed?: string }[];
  folders?: { name: string; path: string }[];
  /** Outline of a known plan (skill or built-in intent) for the model. */
  plan?: { source: "skill" | "intent"; note: string; steps: string[] };
  /**
   * What the user has to get done: upcoming calendar events and pressing
   * reminders ("To do: …"), read with their permission (docs/PRIVACY.md).
   */
  agenda?: string[];
}
export interface ProviderResult {
  action: unknown;
  usage: Usage;
  /**
   * Set when an HTTP 200 response did not contain one usable action (no tool
   * call, several calls, malformed JSON, truncated output). A fixed,
   * content-free description; the runner treats it as a rejected step.
   */
  problem?: string;
  /**
   * The model or provider declined the step (for example a safety refusal).
   * Retrying the same observation will not help; the run should pause.
   */
  refused?: boolean;
}
export interface Provider {
  next(observation: Observation, signal: AbortSignal): Promise<ProviderResult>;
}
export interface ExecutionResult {
  /**
   * How a hotkey went: pressed as the menu item the application publishes for
   * that chord, or posted as keys to the focused element.
   */
  via?: "menu" | "keys";
  launched?: {
    appId: string;
    name: string;
    frontmost: boolean;
    wasRunning: boolean;
    /**
     * For an application that was already running: the windows it shows after
     * open_app, and whether its own Window menu had to show the main window.
     * Absent after a cold launch, whose window may still be on its way.
     */
    windows?: number;
    restoredWindow?: boolean;
  };
  opened?: {
    path: string;
    kind: "document" | "folder";
    appId?: string;
  };
}
export interface Controller {
  kind: "tutorial" | "native";
  surface(action?: Action): Promise<Surface>;
  capture(): Promise<Frame>;
  execute(
    action: Action,
    frame: Frame,
    signal: AbortSignal,
  ): Promise<void | ExecutionResult>;
  stop(): void;
  resume(): Promise<void>;
  restore?(frame: Frame): Promise<void>;
  revalidate?(action: Action, frame: Frame): Promise<Frame>;
  /** Binds the frontmost window for a detached watch (increment 5A). */
  bindWatch?(): Promise<WatchBinding>;
  /** Reads the bound window's text; no input, no focus change, no screenshot kept. */
  probe?(token: string, region?: Region): Promise<ProbeResult>;
  unbindWatch?(token: string): Promise<void>;
  /** While on, one Escape is the user's own key; two within 0.8 s stop the watch. */
  setWatchMode?(on: boolean): Promise<void>;
  /** Brings the bound window to the front before a wake-up run captures it. */
  focusWatch?(token: string): Promise<void>;
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
  /** Absent on runs recorded before origins existed: treat as "typed". */
  origin?: RunOrigin;
  taskSource?: TaskSource;
  /** Tool calls this run made, and how many of them changed something. */
  tools?: { calls: number; writes: number };
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
export const TOOL_ARGS_TOO_LARGE = "TOOL_ARGS_TOO_LARGE";
/** Nesting depth of a JSON value: 0 for a leaf, 1 for a flat object or array. */
function depth(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  const inner = Array.isArray(value) ? value : Object.values(value);
  return 1 + inner.reduce<number>((max, v) => Math.max(max, depth(v)), 0);
}
export function validateAction(input: unknown, frame: Frame): Action {
  const a = actionSchema.parse(input);
  if (a.frame_id !== frame.id) throw new Error("STALE_FRAME");
  if (
    a.type === "tool_call" &&
    (JSON.stringify(a.args).length > TOOL_LIMITS.argsBytes ||
      depth(a.args) > TOOL_LIMITS.argsDepth)
  )
    throw new Error(TOOL_ARGS_TOO_LARGE);
  if (a.type === "hotkey" && a.keys.length === 1)
    return { type: "key", key: a.keys[0], frame_id: a.frame_id };
  return a;
}
const pointFields = [
  ["x", "model_width"],
  ["y", "model_height"],
  ["start_x", "model_width"],
  ["start_y", "model_height"],
  ["end_x", "model_width"],
  ["end_y", "model_height"],
] as const;
/**
 * Models sometimes return screenshot pixels instead of 0..1 fractions. Values
 * of 2 or more that fit inside the advertised image are unambiguous pixels and
 * are divided by the image size. Values in (1, 2), negatives, non-finite
 * numbers and values beyond the image stay untouched so validation rejects
 * them. Returns the original object when nothing changed.
 */
export function normalizePixelCoordinates(
  input: unknown,
  geometry: Pick<Geometry, "model_width" | "model_height">,
): { action: unknown; normalized: boolean } {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return { action: input, normalized: false };
  const source = input as Record<string, unknown>;
  const present = pointFields.filter(([field]) => field in source);
  if (!present.length) return { action: input, normalized: false };
  const pixels = present.some(
    ([field]) =>
      typeof source[field] === "number" && (source[field] as number) >= 2,
  );
  if (!pixels) return { action: input, normalized: false };
  const fits = present.every(([field, size]) => {
    const value = source[field];
    return (
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= geometry[size]
    );
  });
  if (!fits || geometry.model_width < 2 || geometry.model_height < 2)
    return { action: input, normalized: false };
  const action: Record<string, unknown> = { ...source };
  for (const [field, size] of present) {
    const value = source[field] as number;
    action[field] = Math.min(1, value / geometry[size]);
  }
  return { action, normalized: true };
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
