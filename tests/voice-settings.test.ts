import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  cloudVoices,
  defaultSettings,
  settingsSchema,
  type Settings,
} from "../src/core/schema";
import { previewBridge } from "../src/ui/preview";

const voiceKeys = [
  "voiceReplies",
  "voiceEngine",
  "voiceId",
  "cloudVoice",
  "voiceRate",
  "listeningPatience",
  "followUpListening",
  "voiceSounds",
] as const satisfies readonly (keyof Settings)[];

const expectedDefaults = {
  voiceReplies: "voice",
  voiceEngine: "system",
  voiceId: "",
  cloudVoice: "marin",
  voiceRate: 1,
  listeningPatience: "normal",
  followUpListening: true,
  voiceSounds: true,
} satisfies Pick<Settings, (typeof voiceKeys)[number]>;

/** A config saved before spoken replies existed. */
function legacy(): Record<string, unknown> {
  const config: Record<string, unknown> = structuredClone(defaultSettings);
  for (const key of voiceKeys) delete config[key];
  return config;
}

const parses = (patch: Record<string, unknown>) =>
  settingsSchema.safeParse({ ...legacy(), ...patch }).success;

describe("voice settings", () => {
  it("parses a legacy config with every new default", () => {
    const parsed = settingsSchema.parse(legacy());
    for (const key of voiceKeys)
      expect(parsed[key]).toEqual(expectedDefaults[key]);
    // Configs from before hands-free and memory still parse too.
    const { handsFree: _h, memory: _m, ...older } = legacy();
    expect(settingsSchema.parse(older)).toMatchObject({
      handsFree: false,
      memory: true,
      ...expectedDefaults,
    });
  });

  it("accepts the free natural voice and keeps legacy configs on the Mac voice", () => {
    expect(parses({ voiceEngine: "kokoro" })).toBe(true);
    const saved = {
      ...defaultSettings,
      voiceEngine: "kokoro",
    } satisfies Settings;
    expect(settingsSchema.parse(structuredClone(saved)).voiceEngine).toBe(
      "kokoro",
    );
    // A config saved before any voice engine existed still speaks with the Mac
    // voice, and so does one saved before the natural voice was added.
    expect(settingsSchema.parse(legacy()).voiceEngine).toBe("system");
    const { voiceEngine: _e, ...noEngine } = structuredClone(defaultSettings);
    expect(settingsSchema.parse(noEngine).voiceEngine).toBe("system");
    for (const voiceEngine of ["system", "openai"])
      expect(
        settingsSchema.parse({ ...legacy(), voiceEngine }).voiceEngine,
      ).toBe(voiceEngine);
  });

  it("parses a config saved before the conversational layer with its defaults", () => {
    const inc2 = {
      conversation: "model",
      dialogModel: "",
      dialogHourlyCost: 0.5,
      persona: "jarvis",
      addressAs: "",
      spokenProgress: true,
      kokoroVoice: "af_heart",
      progressEveryMinutes: 10,
      watchMaxMinutes: 120,
      stallMinutes: 8,
      keepAwake: false,
      messagesUpdates: "texted",
      messagesConversation: true,
      messagesDetail: "brief",
      // Reading notifications stays a choice, never a surprise.
      notifications: false,
    } satisfies Partial<Settings>;
    const older: Record<string, unknown> = structuredClone(defaultSettings);
    for (const key of Object.keys(inc2)) delete older[key];
    expect(settingsSchema.parse(older)).toMatchObject(inc2);
    expect(defaultSettings).toMatchObject(inc2);
    // The new keys accept their whole range and nothing beside it.
    expect(parses({ messagesUpdates: "away" })).toBe(true);
    expect(parses({ messagesUpdates: "sometimes" })).toBe(false);
    for (const progressEveryMinutes of [0, 5, 10, 15, 30])
      expect(parses({ progressEveryMinutes })).toBe(true);
    expect(parses({ progressEveryMinutes: 7 })).toBe(false);
    for (const kokoroVoice of ["af_heart", "bm_george", "bm_fable"])
      expect(parses({ kokoroVoice })).toBe(true);
    expect(parses({ kokoroVoice: "af_bella" })).toBe(false);
    for (const persona of ["jarvis", "friendly"])
      expect(parses({ persona })).toBe(true);
    expect(parses({ persona: "pirate" })).toBe(false);
    expect(parses({ conversation: "off" })).toBe(true);
    expect(parses({ conversation: "sometimes" })).toBe(false);
    expect(parses({ addressAs: "Dr. O'Neil-Smith" })).toBe(true);
    expect(parses({ addressAs: "x".repeat(41) })).toBe(false);
    expect(parses({ addressAs: "Bob <script>" })).toBe(false);
    expect(parses({ dialogHourlyCost: 0.05 })).toBe(true);
    expect(parses({ dialogHourlyCost: 0.01 })).toBe(false);
    expect(parses({ dialogHourlyCost: 11 })).toBe(false);
    expect(parses({ watchMaxMinutes: 4 })).toBe(false);
    expect(parses({ watchMaxMinutes: 240 })).toBe(true);
    expect(parses({ stallMinutes: 2 })).toBe(false);
    expect(parses({ stallMinutes: 60 })).toBe(true);
    expect(parses({ messagesDetail: "detailed" })).toBe(true);
    expect(parses({ messagesDetail: "verbose" })).toBe(false);
  });

  it("keeps defaultSettings in step with the schema defaults", () => {
    expect(settingsSchema.parse(defaultSettings)).toEqual(defaultSettings);
    for (const key of voiceKeys)
      expect(defaultSettings[key]).toEqual(expectedDefaults[key]);
  });

  it("round-trips saved voice choices", () => {
    const saved = {
      ...defaultSettings,
      voiceReplies: "always",
      voiceEngine: "openai",
      voiceId: "com.apple.voice.premium.en-US.Ava",
      cloudVoice: "cedar",
      voiceRate: 1.25,
      listeningPatience: "relaxed",
      followUpListening: false,
      voiceSounds: false,
    } satisfies Settings;
    expect(settingsSchema.parse(structuredClone(saved))).toEqual(saved);
  });

  it("rejects an out-of-range or non-numeric voiceRate", () => {
    expect(parses({ voiceRate: 0.8 })).toBe(true);
    expect(parses({ voiceRate: 1.4 })).toBe(true);
    for (const voiceRate of [0.79, 1.41, 0, 2, -1, NaN, Infinity, "1", null])
      expect(parses({ voiceRate }), String(voiceRate)).toBe(false);
  });

  it("enforces the enums", () => {
    for (const voiceReplies of ["off", "voice", "always"])
      expect(parses({ voiceReplies })).toBe(true);
    for (const voiceReplies of ["on", "sometimes", "", true])
      expect(parses({ voiceReplies })).toBe(false);

    expect(parses({ voiceEngine: "system" })).toBe(true);
    expect(parses({ voiceEngine: "kokoro" })).toBe(true);
    expect(parses({ voiceEngine: "openai" })).toBe(true);
    for (const voiceEngine of [
      "Kokoro",
      "kokoro-82m",
      "cloud",
      "OpenAI",
      "elevenlabs",
      "",
      null,
    ])
      expect(parses({ voiceEngine })).toBe(false);

    expect([...cloudVoices]).toEqual([
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
    ]);
    for (const cloudVoice of cloudVoices)
      expect(parses({ cloudVoice })).toBe(true);
    for (const cloudVoice of ["nova", "shimmer", "Marin", ""])
      expect(parses({ cloudVoice })).toBe(false);

    for (const listeningPatience of ["quick", "normal", "relaxed"])
      expect(parses({ listeningPatience })).toBe(true);
    for (const listeningPatience of ["slow", "fast", 1])
      expect(parses({ listeningPatience })).toBe(false);
  });

  it("type-checks the remaining voice fields", () => {
    expect(parses({ voiceId: "x".repeat(200) })).toBe(true);
    expect(parses({ voiceId: "x".repeat(201) })).toBe(false);
    expect(parses({ voiceId: 7 })).toBe(false);
    expect(parses({ followUpListening: "true" })).toBe(false);
    expect(parses({ voiceSounds: 1 })).toBe(false);
    // Still strict: unknown keys are refused.
    expect(parses({ voiceVolume: 0.5 })).toBe(false);
  });

  it("opens apps as they are said by default, and keeps a saved choice", async () => {
    // A config saved before the setting existed turns it on; nothing to keep.
    const { earlyStart: _e, ...older } = structuredClone(defaultSettings);
    expect(settingsSchema.parse(older).earlyStart).toBe(true);
    expect(defaultSettings.earlyStart).toBe(true);
    // Local only: allowed in private local mode too.
    expect(
      settingsSchema.parse({ ...older, privacy: "PRIVATE_LOCAL" }).earlyStart,
    ).toBe(true);
    expect(parses({ earlyStart: false })).toBe(true);
    expect(parses({ earlyStart: "false" })).toBe(false);
    const bridge = previewBridge();
    const info = await bridge.info();
    await bridge.saveSettings({ ...info.settings, earlyStart: false });
    expect((await bridge.info()).settings.earlyStart).toBe(false);
    // The Listening group's checkbox writes it.
    const ui = readFileSync(
      new URL("../src/ui/main.tsx", import.meta.url),
      "utf8",
    );
    expect(ui).toMatch(
      /checked=\{s\.earlyStart\}[\s\S]{0,120}onChange=\{\(e\) => set\("earlyStart", e\.target\.checked\)\}[\s\S]{0,80}Open apps as I say them/,
    );
  });

  it("gives the browser preview inert voice stubs", async () => {
    const bridge = previewBridge();
    const info = await bridge.info();
    expect(info.settings).toMatchObject(expectedDefaults);
    expect(info.voice).toMatchObject({
      speaking: false,
      voiceQuality: "none",
      voiceName: "",
      cloudVoiceAllowed: false,
    });
    expect(await bridge.voices()).toEqual({
      voices: [],
      selected: "",
      engine: "system",
      cloudAllowed: false,
    });
    await expect(bridge.previewVoice()).rejects.toThrow(/macOS app/);
    await expect(bridge.openVoiceSettings()).rejects.toThrow(/macOS app/);
  });

  it("gives the browser preview an unsupported natural voice", async () => {
    const bridge = previewBridge();
    const unsupported = {
      supported: false,
      installed: false,
      downloading: false,
      progress: 0,
      bytes: 0,
      totalBytes: 0,
    };
    expect((await bridge.info()).voice.kokoro).toEqual(unsupported);
    expect(await bridge.kokoroStatus()).toEqual(unsupported);
    await expect(bridge.downloadKokoro()).rejects.toThrow(/macOS app/);
    await expect(bridge.cancelKokoroDownload()).rejects.toThrow(/macOS app/);
    await expect(bridge.removeKokoro()).rejects.toThrow(/macOS app/);
    let calls = 0;
    const unsubscribe = bridge.subscribeKokoro(() => calls++);
    expect(typeof unsubscribe).toBe("function");
    expect(() => unsubscribe()).not.toThrow();
    expect(calls).toBe(0);
    // Status is a copy: callers cannot mutate what later calls return.
    (await bridge.kokoroStatus()).supported = true;
    expect((await bridge.kokoroStatus()).supported).toBe(false);
  });
});
