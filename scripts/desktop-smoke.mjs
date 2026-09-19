import { _electron as electron } from "playwright";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { localApp } from "./local-app.mjs";
console.log("Starting desktop smoke");
const port = 20000 + (process.pid % 20000);
const root = mkdtempSync(join(tmpdir(), "butler-desktop-"));
const desktopData = join(root, "desktop");
mkdirSync(desktopData, { recursive: true });
const envFixture = join(root, "credentials.env");
const fakeKeys = [
  "fixture-openai-key",
  "fixture-anthropic-key",
  "fixture-google-key",
];
writeFileSync(
  envFixture,
  `OPENAI_API_KEY=${fakeKeys[0]}\nANTHROPIC_API_KEY=${fakeKeys[1]}\nGEMINI_API_KEY=${fakeKeys[2]}\n`,
  { mode: 0o600 },
);
const server = spawn(
  process.execPath,
  ["--import", "tsx", "services/ingest/server.ts"],
  {
    env: {
      ...process.env,
      INGEST_PORT: String(port),
      INGEST_DATA_DIR: join(root, "ingest"),
      INGEST_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let application;
async function shutdown(instance) {
  const timer = setTimeout(() => instance.process().kill("SIGKILL"), 5000);
  try {
    await instance.close();
  } finally {
    clearTimeout(timer);
  }
}
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const launch = async (importKeys = false) =>
    electron.launch({
      ...(process.argv.includes("--packaged")
        ? {
            executablePath: localApp(process.cwd()).binary,
            args: importKeys
              ? ["--import-env", envFixture, "--provider", "openai"]
              : [],
          }
        : {
            args: [
              ".",
              ...(importKeys
                ? ["--import-env", envFixture, "--provider", "openai"]
                : []),
            ],
          }),
      env: {
        ...process.env,
        COARENA_DEV: "0",
        COARENA_TEST_DATA_DIR: desktopData,
        COARENA_DIAGNOSTICS: "1",
        COARENA_DIAGNOSTICS_DIR: join(root, "diagnostics"),
      },
      timeout: 30000,
    });
  console.log("Launching Electron");
  application = await launch(true);
  console.log("Electron launched");
  application.process().stderr.on("data", (d) => process.stderr.write(d));
  await application.firstWindow();
  let page;
  for (let i = 0; i < 100; i++) {
    page = application.windows().find((p) => p.url().endsWith("#settings"));
    if (page) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!page) throw Error("Main window did not load");
  console.log("Main window located");
  await page.waitForSelector("h1", { timeout: 15000 });
  console.log("UI ready");
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // First run (docs/MODULARITY.md section 6): no config existed, so the setup
  // view opens by itself on the existing `view` channel.
  await page.waitForSelector(".setup-view", { timeout: 15000 });
  assert.equal(
    await page.locator(".setup-rail li").count(),
    6,
    "Setup shows its six steps",
  );
  const setup = await page.evaluate(() => window.coarena.setupStatus());
  assert.deepEqual(
    Object.keys(setup).sort(),
    [
      "accessibility",
      "complete",
      "kokoro",
      "locale",
      "microphone",
      "model",
      "onDevice",
      "screen",
      "screenNeedsRelaunch",
      "shortcut",
      "speech",
      "supported",
    ],
    "setupStatus has exactly the first-run fields",
  );
  for (const key of [
    "supported",
    "screen",
    "screenNeedsRelaunch",
    "accessibility",
    "microphone",
    "speech",
    "onDevice",
    "shortcut",
    "complete",
  ])
    assert.equal(typeof setup[key], "boolean", `setupStatus.${key}`);
  assert.equal(typeof setup.locale, "string");
  assert.equal(setup.complete, false, "A fresh install has not finished setup");
  assert(
    ["none", "ollama", "cloud"].includes(setup.model.kind),
    `Unexpected model kind ${setup.model.kind}`,
  );
  assert.equal(typeof setup.model.ready, "boolean");
  assert.equal(typeof setup.model.detail, "string");
  // A checklist that ticks Screen Recording before the process can capture is
  // worse than none. The relaunch state is only ever reported for a grant the
  // OS preflight already reports, which is exactly the lying case.
  assert(
    !setup.screenNeedsRelaunch || setup.screen,
    "screenNeedsRelaunch is only meaningful once the OS says granted",
  );
  // The local probe goes through validateProviderEndpoint, so it answers a
  // shape whether or not an Ollama is running on this machine.
  const ollama = await page.evaluate(() => window.coarena.detectOllama());
  assert.equal(typeof ollama.running, "boolean");
  assert(Array.isArray(ollama.models));
  for (const model of ollama.models) {
    assert.equal(typeof model, "string");
    assert(!/cloud|\//i.test(model), `Unusable local model offered: ${model}`);
  }
  // Setup is an additional view: Settings still opens and works as it did.
  await page.evaluate(() => window.coarena.openSettings());
  await page.waitForSelector(".settings-content", { timeout: 15000 });
  assert.equal(
    await page.locator(".setup-view").count(),
    0,
    "Opening Settings leaves the setup view",
  );
  const info = await page.evaluate(() => window.coarena.info());
  assert.equal(info.desktop, true);
  assert.equal(info.encrypted, true);
  const emptyMemory = {
    counts: { episodes: 0, preferences: 0, skills: 0, apps: 0 },
    preferences: [],
    skills: [],
  };
  assert.equal(info.settings.memory, true, "Learning is on by default");
  assert.deepEqual(
    await page.evaluate(() => window.coarena.memorySummary()),
    emptyMemory,
    "A fresh store has learned nothing",
  );
  const activation = await application.evaluate(({ app, BrowserWindow }) => {
    const settingsWindow = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().endsWith("#settings"),
    );
    const pillWindow = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().endsWith("#pill"),
    );
    settingsWindow.hide();
    pillWindow.showInactive();
    app.emit("activate", {}, true);
    const pillDoesNotOpenSettings = !settingsWindow.isVisible();
    pillWindow.hide();
    app.emit("activate", {}, false);
    return { pillDoesNotOpenSettings, reopened: settingsWindow.isVisible() };
  });
  assert.deepEqual(activation, {
    pillDoesNotOpenSettings: true,
    reopened: true,
  });
  assert.equal(info.hasKey, true);
  assert.equal(info.settings.model, "gpt-5.4-mini");
  assert.equal(info.credentialScopes.length, 3);
  for (const key of fakeKeys) {
    assert(!JSON.stringify(info).includes(key), "IPC leaked a key");
    assert(
      !readFileSync(join(desktopData, "config.enc")).includes(Buffer.from(key)),
      "Config is not encrypted",
    );
  }
  // One cheap provider request against the local ingest server: the whole
  // checkProviderKey path without contacting a real provider, and without the
  // key reaching the message.
  const keyCheck = await page.evaluate(async (endpoint) => {
    const saved = (await window.coarena.info()).settings;
    return window.coarena.checkProviderKey(
      {
        ...saved,
        privacy: "PRIVATE_BYOM",
        provider: "compatible",
        endpoint,
        model: "fixture-vision-model",
      },
      "fixture-check-key",
    );
  }, `http://127.0.0.1:${port}`);
  assert.equal(keyCheck.ok, false, "A local stub is not a working provider");
  assert.equal(typeof keyCheck.message, "string");
  assert(
    !keyCheck.message.includes("fixture-check-key"),
    "The key check echoed the key",
  );
  assert(
    !keyCheck.message.includes("{"),
    "The key check echoed the response body",
  );
  // Ollama needs no key, and checkProviderKey says so instead of probing.
  const localKey = await page.evaluate(async () => {
    const saved = (await window.coarena.info()).settings;
    return window.coarena.checkProviderKey({
      ...saved,
      privacy: "PRIVATE_LOCAL",
      provider: "ollama",
      endpoint: "http://127.0.0.1:11434",
      model: "qwen3-vl:8b",
    });
  });
  assert.equal(localKey.ok, false);
  assert.match(localKey.message, /no API key/);
  // A non-loopback endpoint in PRIVATE_LOCAL is refused by the one network
  // rule the run loop uses, not by a second, weaker one.
  const refused = await page.evaluate(async () => {
    const saved = (await window.coarena.info()).settings;
    try {
      await window.coarena.checkProviderKey({
        ...saved,
        privacy: "PRIVATE_LOCAL",
        provider: "ollama",
        endpoint: "https://ollama.example.com",
        model: "qwen3-vl:8b",
      });
      return "allowed";
    } catch {
      return "refused";
    }
  });
  assert.equal(refused, "refused", "The Ollama probe honours PRIVATE_LOCAL");
  const switching = await page.evaluate(async () => {
    const saved = (await window.coarena.info()).settings;
    await window.coarena.saveSettings({
      ...saved,
      provider: "anthropic",
      endpoint: "https://api.anthropic.com",
      model: "claude-haiku-4-5-20251001",
    });
    const anthropic = (await window.coarena.info()).hasKey;
    await window.coarena.saveSettings({
      ...saved,
      provider: "compatible",
      endpoint: "https://example.com",
    });
    const custom = (await window.coarena.info()).hasKey;
    await window.coarena.saveSettings(saved);
    return { anthropic, custom, openai: (await window.coarena.info()).hasKey };
  });
  assert.deepEqual(switching, { anthropic: true, custom: false, openai: true });
  assert.equal(typeof info.voice.onDevice, "boolean");
  assert.equal(info.settings.handsFree, false);
  assert.equal(info.voice.handsFree, false);
  assert.equal(info.voice.wakeListening, false);
  assert.equal(
    await page
      .getByRole("combobox", { name: "Talk to Butler" })
      .inputValue(),
    "shortcut",
  );
  // Spoken replies: defaults, status fields and the settings controls.
  assert.deepEqual(
    {
      voiceReplies: info.settings.voiceReplies,
      voiceEngine: info.settings.voiceEngine,
      voiceId: info.settings.voiceId,
      cloudVoice: info.settings.cloudVoice,
      voiceRate: info.settings.voiceRate,
      listeningPatience: info.settings.listeningPatience,
      followUpListening: info.settings.followUpListening,
      voiceSounds: info.settings.voiceSounds,
    },
    {
      voiceReplies: "voice",
      voiceEngine: "system",
      voiceId: "",
      cloudVoice: "marin",
      voiceRate: 1,
      listeningPatience: "normal",
      followUpListening: true,
      voiceSounds: true,
    },
    "Voice settings have their defaults",
  );
  assert.equal(info.voice.speaking, false, "Nothing is spoken at launch");
  assert(
    ["none", "default", "enhanced", "premium"].includes(
      info.voice.voiceQuality,
    ),
    `Unexpected voiceQuality ${info.voice.voiceQuality}`,
  );
  assert.equal(typeof info.voice.voiceName, "string");
  // The imported OpenAI key in PRIVATE_BYOM allows the opt-in natural voice.
  assert.equal(info.voice.cloudVoiceAllowed, true);
  // The free on-device natural voice reports its status without downloading.
  const kokoroKeys = [
    "bytes",
    "downloading",
    "installed",
    "progress",
    "supported",
    "totalBytes",
  ];
  const assertKokoroStatus = (status, where) => {
    assert.equal(typeof status, "object", `${where} is missing`);
    assert.deepEqual(
      Object.keys(status)
        .filter((key) => key !== "error")
        .sort(),
      kokoroKeys,
      `${where} has unexpected fields`,
    );
    for (const key of ["supported", "installed", "downloading"])
      assert.equal(typeof status[key], "boolean", `${where}.${key}`);
    for (const key of ["progress", "bytes", "totalBytes"])
      assert(
        Number.isFinite(status[key]) && status[key] >= 0,
        `${where}.${key} must be a non-negative number`,
      );
    assert(status.progress <= 1, `${where}.progress must be 0-1`);
    assert(
      status.error === undefined || typeof status.error === "string",
      `${where}.error must be a string code`,
    );
    assert.equal(status.downloading, false, `${where}: nothing downloads`);
  };
  assertKokoroStatus(info.voice.kokoro, "info.voice.kokoro");
  const kokoroStatus = await page.evaluate(() => window.coarena.kokoroStatus());
  assertKokoroStatus(kokoroStatus, "kokoroStatus()");
  assert.equal(kokoroStatus.supported, info.voice.kokoro.supported);
  // COARENA_TEST_DATA_DIR is userData, so nothing is installed yet.
  assert.equal(kokoroStatus.installed, false, "A fresh store has no model");
  assert.equal(kokoroStatus.bytes, 0, "A fresh store has no partial model");
  const voiceList = await page.evaluate(() => window.coarena.voices());
  assert(Array.isArray(voiceList.voices));
  assert.equal(voiceList.engine, "system");
  assert.equal(voiceList.cloudAllowed, true);
  assert.equal(typeof voiceList.selected, "string");
  for (const voice of voiceList.voices) {
    assert.equal(typeof voice.id, "string");
    assert.equal(typeof voice.name, "string");
    assert.equal(typeof voice.language, "string");
    assert(["default", "enhanced", "premium"].includes(voice.quality));
  }
  await page.locator("summary").filter({ hasText: "Voice replies" }).click();
  assert.equal(
    await page.getByRole("combobox", { name: "Speak replies" }).inputValue(),
    "voice",
  );
  const engine = page.getByRole("combobox", { name: "Voice engine" });
  assert.equal(await engine.inputValue(), "system");
  assert.equal(
    await engine
      .locator('option[value="openai"]')
      .evaluate((option) => option.disabled),
    false,
    "Natural voice is selectable with a saved OpenAI key",
  );
  assert.deepEqual(
    await engine
      .locator("option")
      .evaluateAll((options) => options.map((option) => option.value)),
    ["system", "kokoro", "openai"],
    "The engine select offers the Mac, free natural and OpenAI voices",
  );
  assert.equal(
    await engine
      .locator('option[value="kokoro"]')
      .evaluate((option) => option.disabled),
    !kokoroStatus.supported,
    "The free natural voice is selectable only where it is supported",
  );
  const kokoroEngine = await page.evaluate(async () => {
    const saved = (await window.coarena.info()).settings;
    try {
      await window.coarena.saveSettings({ ...saved, voiceEngine: "kokoro" });
      return "saved";
    } catch (error) {
      return error.message;
    } finally {
      await window.coarena.saveSettings(saved);
    }
  });
  assert.equal(kokoroEngine, "saved", "The schema accepts voiceEngine kokoro");
  assert.equal(
    (await page.evaluate(() => window.coarena.info())).settings.voiceEngine,
    "system",
  );
  await page.locator("summary").filter({ hasText: "Listening" }).click();
  assert.equal(
    await page.getByRole("radio", { name: "Normal", exact: true }).isChecked(),
    true,
  );
  const invalidVoice = await page.evaluate(async () => {
    const saved = (await window.coarena.info()).settings;
    try {
      await window.coarena.saveSettings({ ...saved, voiceRate: 3 });
      return "saved";
    } catch {
      return "rejected";
    }
  });
  assert.equal(invalidVoice, "rejected", "Out-of-range voiceRate is refused");
  await page.getByRole("button", { name: "Try the safe tutorial" }).click();
  for (let i = 0; i < 100; i++) {
    if (
      (await page.evaluate(() => window.coarena.history()))[0]?.status ===
      "completed"
    )
      break;
    await new Promise((r) => setTimeout(r, 100));
  }
  let runs = await page.evaluate(() => window.coarena.history());
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "completed");
  assert.equal(runs[0].actions, 3);
  const diagnosticLog = readFileSync(
    join(root, "diagnostics/current.jsonl"),
    "utf8",
  );
  const diagnosticEvents = diagnosticLog
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert(
    diagnosticEvents.some((event) => event.event === "RunCompleted"),
    "Completed task was not streamed",
  );
  assert(
    diagnosticEvents.some((event) => event.event === "ActionExecuted"),
    "Actions were not streamed",
  );
  for (const key of fakeKeys)
    assert(!diagnosticLog.includes(key), "Diagnostic stream leaked a key");
  assert(
    !diagnosticLog.includes(runs[0].task),
    "Diagnostic stream included task text",
  );
  // The synthetic tutorial never recalls or learns.
  assert.deepEqual(
    await page.evaluate(() => window.coarena.memorySummary()),
    emptyMemory,
    "A tutorial run must not add memory",
  );
  assert(
    !diagnosticEvents.some((event) => event.event === "MemoryRecalled"),
    "A tutorial run must not recall memory",
  );
  // The finished run may still be settling; forgetting waits for it.
  let forgot = "";
  for (let i = 0; i < 40; i++) {
    forgot = await page.evaluate(async () => {
      try {
        await window.coarena.forgetMemory();
        return "ok";
      } catch (error) {
        return error.message;
      }
    });
    if (forgot === "ok") break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(forgot, "ok", "Forgetting memory succeeds when idle");
  assert(
    !existsSync(join(desktopData, "memory", "memory.enc")),
    "Forgetting leaves no memory file",
  );
  // "off" keeps later tutorial runs silent while checking persistence.
  await page.evaluate(async () => {
    const saved = (await window.coarena.info()).settings;
    await window.coarena.saveSettings({
      ...saved,
      memory: false,
      voiceReplies: "off",
      listeningPatience: "relaxed",
    });
  });
  assert.equal(
    (await page.evaluate(() => window.coarena.info())).settings.memory,
    false,
  );
  const id = runs[0].id;
  await page.evaluate(async (endpoint) => {
    const info = await window.coarena.info();
    await window.coarena.saveSettings({
      ...info.settings,
      contributionEndpoint: endpoint,
    });
  }, `http://127.0.0.1:${port}`);
  const review = await page.evaluate((id) => window.coarena.review(id), id);
  assert.equal(review.frames.length, 4);
  console.log("Starting contribution upload");
  const result = await page.evaluate(
    (id) =>
      window.coarena.donate({
        runId: id,
        level: "trajectory",
        excludedFrames: [],
        excludedEvents: [],
        affirmative: true,
      }),
    id,
  );
  assert.equal(result.receipt.length, 64);
  const exportPath = join(root, "workflow.json");
  await application.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, exportPath);
  await page.evaluate((id) => window.coarena.exportWorkflow(id), id);
  assert(existsSync(exportPath));
  assert.equal(
    JSON.parse(readFileSync(exportPath, "utf8")).ordered_steps.length,
    3,
  );
  await page.evaluate(() => window.coarena.openSettings());
  await page.screenshot({
    path: "output/qa/electron-settings.png",
    fullPage: true,
  });
  // Finishing setup is a saved flag, so the next launch opens Settings rather
  // than walking the user through first run again.
  await page.evaluate(() => window.coarena.completeSetup());
  assert.equal(
    (await page.evaluate(() => window.coarena.setupStatus())).complete,
    true,
  );
  assert.equal(
    (await page.evaluate(() => window.coarena.info())).settings.setupComplete,
    true,
  );
  const journal = readFileSync(
    join(desktopData, "runs", id, "events.enc"),
    "utf8",
  );
  assert(!journal.includes("Move the card"));
  assert(!journal.includes("ActionExecuted"));
  const overlay = application.windows().find((p) => p.url().endsWith("#pill"));
  assert(overlay);
  assert.equal(
    await overlay.evaluate(async () => {
      try {
        await window.coarena.history();
        return "allowed";
      } catch {
        return "denied";
      }
    }),
    "denied",
  );
  assert.equal(
    await overlay.evaluate(async () => {
      try {
        await window.coarena.memorySummary();
        return "allowed";
      } catch {
        return "denied";
      }
    }),
    "denied",
    "The overlay must not read learned memory",
  );
  for (const method of [
    "voices",
    "previewVoice",
    "openVoiceSettings",
    "kokoroStatus",
    "downloadKokoro",
    "cancelKokoroDownload",
    "removeKokoro",
    // First run is settings-window only; the pill must not reach any of it,
    // least of all relaunch.
    "setupStatus",
    "openPrivacyPane",
    "relaunch",
    "detectOllama",
    "checkProviderKey",
    "completeSetup",
  ])
    assert.equal(
      await overlay.evaluate(async (name) => {
        try {
          await window.coarena[name]();
          return "allowed";
        } catch {
          return "denied";
        }
      }, method),
      "denied",
      `The overlay must not call ${method}`,
    );
  await shutdown(application);
  console.log("Launching Electron");
  application = await launch();
  console.log("Electron launched");
  await application.firstWindow();
  let restarted;
  for (let i = 0; i < 100; i++) {
    restarted = application
      .windows()
      .find((p) => p.url().endsWith("#settings"));
    if (restarted) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!restarted) throw Error("Main window did not reopen");
  await restarted.waitForSelector("h1", { state: "attached" });
  const savedInfo = await restarted.evaluate(() => window.coarena.info());
  assert.equal(
    savedInfo.settings.setupComplete,
    true,
    "Finished setup persists across restarts",
  );
  assert.equal(
    await restarted.locator(".setup-view").count(),
    0,
    "A configured install does not reopen first-run setup",
  );
  assert.equal(savedInfo.hasKey, true);
  assert.equal(savedInfo.credentialScopes.length, 3);
  assert.equal(savedInfo.settings.model, "gpt-5.4-mini");
  assert.equal(
    savedInfo.settings.memory,
    false,
    "The learning toggle persists across restarts",
  );
  assert.equal(savedInfo.settings.voiceReplies, "off");
  assert.equal(
    savedInfo.settings.listeningPatience,
    "relaxed",
    "Voice settings persist across restarts",
  );
  await restarted.evaluate(async () => {
    const saved = (await window.coarena.info()).settings;
    await window.coarena.saveSettings({
      ...saved,
      memory: true,
      voiceReplies: "voice",
      listeningPatience: "normal",
    });
  });
  assert.equal(
    (await restarted.evaluate(() => window.coarena.info())).settings.memory,
    true,
  );
  assert.deepEqual(
    await restarted.evaluate(() => window.coarena.memorySummary()),
    emptyMemory,
  );
  runs = await restarted.evaluate(() => window.coarena.history());
  assert.equal(runs.length, 1);
  assert.equal(runs[0].contribution, result.receipt);
  await restarted.evaluate((id) => window.coarena.withdraw(id), id);
  assert.equal(readdirSync(join(root, "ingest")).length, 0);
  await restarted.evaluate((id) => window.coarena.deleteRun(id), id);
  assert.equal(
    (await restarted.evaluate(() => window.coarena.history())).length,
    0,
  );
  await restarted.evaluate(async () => {
    await window.coarena.start("Move the card and add a note.", true);
    await window.coarena.pause();
    await window.coarena.command("Use the September report.");
  });
  for (let i = 0; i < 100; i++) {
    if (
      (await restarted.evaluate(() => window.coarena.history()))[0]?.status ===
      "completed"
    )
      break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const corrected = (
    await restarted.evaluate(() => window.coarena.history())
  )[0];
  assert.equal(corrected.status, "completed");
  assert.equal(corrected.corrections.length, 1);
  assert.equal(corrected.corrections[0].text, "Use the September report.");
  await restarted.evaluate((id) => window.coarena.deleteRun(id), corrected.id);
  await restarted.evaluate(async () => {
    await window.coarena.start("Move the card and add a note.", true);
    await window.coarena.pause();
  });
  const pausedPill = application
    .windows()
    .find((p) => p.url().endsWith("#pill"));
  const dismissed = await pausedPill.evaluate(async () => {
    await window.coarena.dismiss();
    return (await window.coarena.pillState()).phase;
  });
  assert.equal(dismissed, "paused", "Dismiss must keep a paused run visible");
  assert.equal(
    (await restarted.evaluate(() => window.coarena.history()))[0].status,
    "paused",
    "Dismiss must not resume or stop the run",
  );
  const terminalStatus = (status) =>
    ["completed", "cancelled", "failed"].includes(status);
  const runStatus = async () =>
    (await restarted.evaluate(() => window.coarena.history()))[0]?.status;
  // A "no" or "yes" with nothing pending is not a usable command: the run
  // stays paused and the pill says why.
  const declined = await pausedPill.evaluate(async () => {
    await window.coarena.command("no").catch(() => {});
    return window.coarena.pillState();
  });
  assert.equal(declined.phase, "paused");
  assert.equal(declined.label, "Paused — nothing to approve.");
  await pausedPill.evaluate(() => window.coarena.confirm(true));
  assert.equal(
    await runStatus(),
    "paused",
    "A yes or no with nothing pending must not resume the run",
  );
  // A text pill opened on an already paused run never resumes on dismiss.
  await pausedPill.evaluate(async () => {
    await window.coarena.openCommand();
    await window.coarena.dismiss();
  });
  assert.equal(await runStatus(), "paused");
  // Dismissing an untouched text pill that paused a working run resumes it.
  await pausedPill.evaluate(() => window.coarena.resume());
  let working;
  for (let i = 0; i < 100; i++) {
    working = await runStatus();
    if (!["paused", "confirming"].includes(working)) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  if (!terminalStatus(working)) {
    const tapped = await pausedPill.evaluate(async () => {
      await window.coarena.openCommand();
      return (await window.coarena.pillState()).phase;
    });
    assert.equal(tapped, "text");
    const held = await runStatus();
    await pausedPill.evaluate(() => window.coarena.dismiss());
    if (held === "paused") {
      let resumed;
      for (let i = 0; i < 100; i++) {
        resumed = await runStatus();
        if (resumed !== "paused") break;
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.notEqual(
        resumed,
        "paused",
        "Dismissing an untouched text pill must resume the run it paused",
      );
    }
    await pausedPill.evaluate(() => window.coarena.pause());
  }
  await restarted.evaluate(() => window.coarena.stop());
  let dismissedRun;
  for (let i = 0; i < 100; i++) {
    dismissedRun = (
      await restarted.evaluate(() => window.coarena.history())
    )[0];
    if (terminalStatus(dismissedRun?.status)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  // The resume check above can rarely let the tutorial finish first.
  assert(["cancelled", "completed"].includes(dismissedRun.status));
  for (let i = 0; i < 40; i++) {
    const deleted = await restarted.evaluate(async (id) => {
      try {
        await window.coarena.deleteRun(id);
        return true;
      } catch {
        return false;
      }
    }, dismissedRun.id);
    if (deleted) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const idleContinue = await pausedPill.evaluate(async () => {
    try {
      await window.coarena.command("continue");
      return "ok";
    } catch (error) {
      return error.message;
    }
  });
  assert.equal(idleContinue, "ok", "Continue with no run must not throw");
  await restarted.evaluate(async () => {
    await window.coarena.start("Move the card and add a note.", true);
    await window.coarena.pause();
  });
  const second = spawn(
    application.process().spawnfile,
    [
      ...(process.argv.includes("--packaged") ? [] : [resolve(".")]),
      "--command",
      "Stop",
    ],
    {
      env: {
        ...process.env,
        COARENA_DEV: "0",
        COARENA_TEST_DATA_DIR: desktopData,
      },
      stdio: "ignore",
    },
  );
  await new Promise((resolve, reject) => {
    second.on("error", reject);
    second.on("exit", resolve);
  });
  let stopped;
  for (let i = 0; i < 100; i++) {
    stopped = (await restarted.evaluate(() => window.coarena.history()))[0];
    if (stopped?.status === "cancelled") break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(
    stopped.status,
    "cancelled",
    "Second-instance Stop must cancel the existing run",
  );
  assert.equal(
    stopped.corrections?.length ?? 0,
    0,
    "Launch flags must never become task corrections",
  );
  await restarted.evaluate((id) => window.coarena.deleteRun(id), stopped.id);
  await restarted.evaluate(() => window.coarena.openCommand());
  const textPill = application.windows().find((p) => p.url().endsWith("#pill"));
  await textPill
    .getByRole("textbox", { name: "Command", exact: true })
    .waitFor();
  const pillSize = await textPill.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
  }));
  assert(pillSize.height >= 190);
  await textPill.screenshot({ path: "output/qa/electron-command-pill.png" });
  await textPill.evaluate(() => window.coarena.dismiss());
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        result: "passed",
        checks: [
          "desktop renderer + isolated preload",
          "app reactivation opens Settings without stealing pill focus",
          "OS-backed encrypted history",
          "env import, encrypted credentials and restart persistence",
          "provider switching without credential leakage",
          "scripted tutorial",
          "fresh memory is empty; tutorial runs do not learn; forget succeeds; learning toggle persists; overlay cannot read memory",
          "first run opens the setup view, its status shape, the local model probe and the key check without echoing the key or the body",
          "finished setup persists and does not reopen; the overlay cannot reach any setup method",
          "native voice status without requesting microphone access",
          "voice reply defaults, voice list, natural voice allowed with an OpenAI key, invalid rate refused, voice settings persist, overlay cannot list or preview voices",
          "free natural voice status shape, three voice engines, kokoro engine saves, overlay cannot read, download, cancel or remove it",
          "real HTTP contribution consent/chunk/commit",
          "approved workflow export",
          "overlay IPC denied",
          "restart recovery",
          "contribution deletion",
          "local deletion",
          "same-run correction and completion",
          "dismissing a paused run keeps its pill; idle continue does not throw",
          "yes/no without an approval keeps a held run paused; untouched text pill dismissal resumes",
          "second-instance Stop preserves exact command and cancels without corrections",
          "native text pill expansion",
        ],
        evidenceDirectory: root,
      },
      null,
      2,
    ),
  );
} finally {
  if (application) await shutdown(application).catch(() => {});
  server.kill();
}
