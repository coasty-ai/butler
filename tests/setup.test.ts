import { describe, expect, it } from "vitest";
import {
  firstTask,
  localModelSizes,
  permissionsReady,
  privacyPanePaths,
  privacyPanes,
  privacySettingsRoot,
  providerKeyMessage,
  resumeSetupAt,
  setupPermissions,
  setupSteps,
  usableOllamaModels,
  type SetupStatus,
} from "../src/ui/api";
import { defaultSettings, settingsSchema } from "../src/core/schema";
import { providerDefaults } from "../src/providers/catalog";
import { validateProviderEndpoint } from "../src/core/privacy";
import { CATALOGUE } from "../src/gym/bench/catalogue";
import { previewBridge } from "../src/ui/preview";

/** A status with nothing granted and no model, as the first poll can return. */
function blank(patch: Partial<SetupStatus> = {}): SetupStatus {
  return {
    supported: true,
    screen: false,
    screenNeedsRelaunch: false,
    accessibility: false,
    microphone: false,
    speech: false,
    onDevice: true,
    locale: "en-US",
    shortcut: true,
    model: { kind: "none", ready: false, detail: "" },
    kokoro: {
      supported: true,
      installed: false,
      downloading: false,
      progress: 0,
      bytes: 0,
      totalBytes: 0,
    },
    complete: false,
    ...patch,
  };
}
const granted = {
  screen: true,
  accessibility: true,
  microphone: true,
  speech: true,
};

describe("first-run setup", () => {
  it("defaults setupComplete to false and parses a config saved before it", () => {
    expect(defaultSettings.setupComplete).toBe(false);
    const legacy: Record<string, unknown> = structuredClone(defaultSettings);
    delete legacy.setupComplete;
    expect(settingsSchema.parse(legacy).setupComplete).toBe(false);
    // The flag survives a round trip, so quitting mid-setup comes back to it.
    expect(
      settingsSchema.parse({ ...defaultSettings, setupComplete: true })
        .setupComplete,
    ).toBe(true);
  });

  it("has one pane URL and written path per permission", () => {
    expect(Object.keys(privacyPanes).sort()).toEqual([
      "accessibility",
      "automation",
      "fullDisk",
      "input",
      "microphone",
      "screen",
      "speech",
    ]);
    expect(privacyPanes.screen).toBe(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    );
    expect(privacyPanes.speech).toBe(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition",
    );
    expect(privacySettingsRoot).toBe(
      "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension",
    );
    // Every button degrades to a written path when the deep link does nothing.
    for (const pane of Object.keys(
      privacyPanes,
    ) as (keyof typeof privacyPanes)[]) {
      expect(privacyPanes[pane]).toMatch(/^x-apple\.systempreferences:/);
      expect(privacyPanePaths[pane]).toMatch(/^Privacy & Security › /);
    }
    // The checklist shows exactly the four the run loop and voice need.
    expect(setupPermissions.map((p) => p.pane)).toEqual([
      "screen",
      "accessibility",
      "microphone",
      "speech",
    ]);
    for (const row of setupPermissions) expect(row.reason).toMatch(/\.$/);
  });

  it("never shows a tick while Screen Recording needs a relaunch", () => {
    // Granted in the OS preflight, but this process cannot capture yet.
    const stale = blank({ ...granted, screenNeedsRelaunch: true });
    expect(permissionsReady(stale)).toBe(false);
    expect(resumeSetupAt(stale)).toBe("permissions");
    expect(permissionsReady(blank({ ...granted }))).toBe(true);
  });

  it("resumes at the first step that is not done", () => {
    expect(resumeSetupAt(null)).toBe("welcome");
    expect(resumeSetupAt(blank())).toBe("welcome");
    expect(resumeSetupAt(blank({ screen: true }))).toBe("permissions");
    expect(resumeSetupAt(blank({ ...granted }))).toBe("model");
    expect(
      resumeSetupAt(
        blank({
          ...granted,
          model: { kind: "ollama", ready: true, detail: "" },
        }),
      ),
    ).toBe("task");
    expect(setupSteps).toEqual([
      "welcome",
      "permissions",
      "model",
      "voice",
      "task",
      "done",
    ]);
  });

  it("offers only local models the run loop could use", () => {
    expect(
      usableOllamaModels([
        "qwen3-vl:8b",
        "qwen3-vl:8b",
        "nomic-embed-text",
        "bge-reranker",
        "hf.co/someone/qwen-vl",
        "gpt-oss-cloud",
        "llava:13b",
        42,
        "",
      ]),
    ).toEqual(["qwen3-vl:8b", "llava:13b"]);
    expect(usableOllamaModels(undefined)).toEqual([]);
    // Anything offered must survive the PRIVATE_LOCAL rule it will be saved
    // under; a slash or "cloud" in the id is refused there, not here.
    for (const model of usableOllamaModels(["qwen3-vl:8b", "llava:13b"]))
      expect(() =>
        validateProviderEndpoint({
          ...defaultSettings,
          provider: "ollama",
          privacy: "PRIVATE_LOCAL",
          endpoint: providerDefaults.ollama.endpoint,
          model,
        }),
      ).not.toThrow();
    for (const model of ["hf.co/x/y", "gpt-4o-cloud"])
      expect(() =>
        validateProviderEndpoint({
          ...defaultSettings,
          provider: "ollama",
          privacy: "PRIVATE_LOCAL",
          endpoint: providerDefaults.ollama.endpoint,
          model,
        }),
      ).toThrow();
  });

  it("names the default local model and its download size", () => {
    // The size lives beside the id, so it cannot drift away from the default.
    expect(localModelSizes[providerDefaults.ollama.model]).toBe("about 6 GB");
    expect(providerDefaults.ollama.model).toBe(defaultSettings.model);
    expect(localModelSizes["qwen3-vl:2b"]).toBe("about 2 GB");
  });

  it("maps a key check to one sentence without echoing the body", () => {
    const check = (status: number, extra: Record<string, unknown> = {}) =>
      providerKeyMessage({
        provider: "openai",
        model: "gpt-5.4-mini",
        host: "api.openai.com",
        status,
        ...extra,
      });
    expect(check(200).ok).toBe(true);
    expect(check(200).message).toMatch(/The key works\./);
    expect(check(401)).toEqual({
      ok: false,
      message: "The provider rejected this key.",
    });
    expect(check(403).message).toBe("The provider rejected this key.");
    expect(check(404).message).toContain("gpt-5.4-mini");
    expect(check(429).message).toMatch(/rate limiting/);
    expect(check(500).message).toBe(
      "The provider returned HTTP 500. Verify model access and quota.",
    );
    const blocked = providerKeyMessage({
      provider: "google",
      model: "gemini-3.5-flash-lite",
      host: "generativelanguage.googleapis.com",
      status: 403,
      blocked: true,
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.message).toContain("generativelanguage.googleapis.com");
    expect(
      providerKeyMessage({
        provider: "compatible",
        model: "some-model",
        host: "openrouter.ai",
        status: 404,
      }).message,
    ).toContain("openrouter.ai");
  });

  it("proposes the task the bench already grades", () => {
    const task = CATALOGUE.find((t) => t.id === "calculator-multiply");
    expect(task?.instruction).toBe(firstTask);
    expect(firstTask).toBe("Open Calculator and multiply 128 by 46");
  });

  it("detects nothing from the browser preview", async () => {
    const bridge = previewBridge();
    // tests/e2e/app.spec.ts asserts no request leaves 127.0.0.1:5173.
    expect(await bridge.detectOllama()).toEqual({
      running: false,
      models: [],
    });
    const status = await bridge.setupStatus();
    expect(status.supported).toBe(false);
    expect(status.screenNeedsRelaunch).toBe(false);
    expect(status.model.ready).toBe(false);
    // The preview never opens the setup view on its own.
    expect(status.complete).toBe(true);
    expect(await bridge.checkProviderKey(defaultSettings)).toMatchObject({
      ok: false,
    });
    await expect(bridge.openPrivacyPane("screen")).rejects.toThrow();
    await expect(bridge.relaunch()).rejects.toThrow();
    await expect(bridge.completeSetup()).resolves.toBeUndefined();
  });
});
