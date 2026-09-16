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
console.log("Starting desktop smoke");
const port = 20000 + (process.pid % 20000);
const root = mkdtempSync(join(tmpdir(), "open-assist-desktop-"));
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
            executablePath: resolve(
              "release/mac-arm64/Open Assist.app/Contents/MacOS/Open Assist",
            ),
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
  const info = await page.evaluate(() => window.coarena.info());
  assert.equal(info.desktop, true);
  assert.equal(info.encrypted, true);
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
      .getByRole("combobox", { name: "Talk to Open Assist" })
      .inputValue(),
    "shortcut",
  );
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
  assert.equal(savedInfo.hasKey, true);
  assert.equal(savedInfo.credentialScopes.length, 3);
  assert.equal(savedInfo.settings.model, "gpt-5.4-mini");
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
          "native voice status without requesting microphone access",
          "real HTTP contribution consent/chunk/commit",
          "approved workflow export",
          "overlay IPC denied",
          "restart recovery",
          "contribution deletion",
          "local deletion",
          "same-run correction and completion",
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
