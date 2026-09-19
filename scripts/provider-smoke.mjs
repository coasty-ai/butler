// Opt-in paid API check. Only generated fixture images leave this process.
// It never captures the desktop or sends OS mouse/keyboard input.
import { chromium, _electron as electron } from "playwright";
import { readFileSync, mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { parseEnv } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { localApp } from "./local-app.mjs";
import { HttpProvider } from "../src/providers/http.ts";
import {
  defaultSettings,
  normalizePixelCoordinates,
  validateAction,
} from "../src/core/schema.ts";
import { selectProvider } from "../src/providers/catalog.ts";
import { importEnvCredentials, providerKey } from "../electron/credentials.ts";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";

const provider = process.argv[2] ?? "openai";
const desktop = process.argv.includes("--desktop");
assert(
  ["openai", "anthropic", "google"].includes(provider),
  "Unknown provider",
);
const settings = selectProvider(defaultSettings, provider);
const keys = importEnvCredentials(resolve(".env"), {});
const env = parseEnv(readFileSync(".env", "utf8"));
const client = new HttpProvider(settings, providerKey(keys, settings));
let application;
const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
    : {}),
});
const begin = Date.now();
const report = {
  provider,
  runtime: desktop ? "packaged-electron" : "node",
  model: settings.model,
  success: false,
  steps: [],
  usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
  durationMs: 0,
};
try {
  let desktopModule;
  if (desktop) {
    const root = mkdtempSync(join(tmpdir(), "butler-provider-"));
    desktopModule = join(root, "provider.cjs");
    await build({
      entryPoints: ["scripts/fixtures/desktop-provider.ts"],
      bundle: true,
      platform: "node",
      format: "cjs",
      external: ["electron"],
      outfile: desktopModule,
    });
    application = await electron.launch({
      executablePath: localApp(process.cwd()).binary,
      args: [],
      env: {
        ...process.env,
        COARENA_DEV: "0",
        COARENA_TEST_DATA_DIR: join(root, "data"),
      },
      timeout: 30000,
    });
    await application.firstWindow();
  }
  const context = await browser.newContext({
    viewport: { width: 1000, height: 640 },
    deviceScaleFactor: 1,
    offline: true,
  });
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html><body style="margin:0;background:#111;color:#eee;font:24px sans-serif">
    <h1 style="margin:60px">New project</h1><p style="margin:60px">Butler synthetic test — no personal information.</p>
    <label style="position:absolute;left:100px;top:270px" for="project">Project name</label>
    <input id="project" style="position:absolute;left:100px;top:310px;width:580px;height:55px;font:24px sans-serif">
    <button style="position:absolute;left:720px;top:480px;width:180px;height:64px;font:24px sans-serif" onclick="const name=document.getElementById('project').value; if(name==='Orbit'){document.body.innerHTML='<h1 style=margin:60px>Project Orbit ready</h1><p style=margin:60px>Setup complete.</p>'}">Continue</button>
    </body></html>`);
  const history = [];
  let invalidActions = 0;
  let idleGapTested = false;
  for (let step = 0; step < 6; step++) {
    assert(report.usage.cost < 0.05, "Smoke check cost budget reached");
    const image = await page.screenshot();
    const id = randomUUID();
    const start = Date.now();
    const observation = {
      task: "Enter Orbit in Project name, click Continue, and verify that Project Orbit is ready.",
      history,
      frame: {
        id,
        image: "data:image/png;base64," + image.toString("base64"),
        sha256: createHash("sha256").update(image).digest("hex"),
        synthetic: true,
        capturedAt: Date.now(),
        geometry: {
          display_id: 1,
          x: 0,
          y: 0,
          width: 1000,
          height: 640,
          native_width: 1000,
          native_height: 640,
          model_width: 1000,
          model_height: 640,
          scale_factor: 1,
        },
      },
    };
    const response = desktop
      ? await application.evaluate(
          async (_electron, input) => {
            const require = process
              .getBuiltinModule("module")
              .createRequire(input.modulePath);
            return require(input.modulePath).next(input);
          },
          {
            modulePath: desktopModule,
            settings,
            observation,
            envFile: resolve(".env"),
          },
        )
      : await client.next(observation, AbortSignal.timeout(65000));
    for (const key of Object.keys(report.usage))
      report.usage[key] += response.usage[key];
    // A refusal will repeat on the same input; the runner pauses, so fail here.
    if (response.refused) {
      report.steps.push({
        type: "provider_refused",
        problem: response.problem,
        latencyMs: Date.now() - start,
      });
      assert(false, "The model declined this step");
    }
    // A malformed model reply is a rejected step, like an invalid action.
    if (response.problem) {
      report.steps.push({
        type: "rejected_provider_problem",
        problem: response.problem,
        latencyMs: Date.now() - start,
      });
      history.push({
        type: "rejected",
        result: `${response.problem} Return exactly one action for the current frame_id.`,
      });
      assert(++invalidActions < 3, "Repeated invalid actions");
      continue;
    }
    let action;
    try {
      // The provider already maps the frame alias back to the real id; mirror
      // the runner's pixel-coordinate normalization before validation.
      action = validateAction(
        normalizePixelCoordinates(response.action, observation.frame.geometry)
          .action,
        observation.frame,
      );
    } catch {
      report.steps.push({
        type: "rejected_invalid_action",
        latencyMs: Date.now() - start,
      });
      history.push({
        type: "rejected",
        result:
          "Invalid or stale action. Return one action with the current frame_id.",
      });
      assert(++invalidActions < 3, "Repeated invalid actions");
      continue;
    }
    report.steps.push({ type: action.type, latencyMs: Date.now() - start });
    if (action.type === "done") {
      assert(
        await page
          .getByRole("heading", { name: "Project Orbit ready", exact: true })
          .isVisible(),
        "Model claimed completion before the task was complete",
      );
      report.success = true;
      break;
    }
    switch (action.type) {
      case "click":
        await page.mouse.click(action.x * 1000, action.y * 640, {
          button: action.button,
        });
        break;
      case "type_text":
        await page.keyboard.insertText(action.text);
        break;
      case "key": {
        const key = { TAB: "Tab", ENTER: "Enter", BACKSPACE: "Backspace" }[
          action.key
        ];
        assert(key, "Unsupported fixture key");
        await page.keyboard.press(key);
        break;
      }
      case "capture":
        break;
      case "wait":
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(action.milliseconds, 1000)),
        );
        break;
      default:
        throw new Error(
          "Model proposed an unsupported fixture action: " + action.type,
        );
    }
    history.push({ type: "ActionExecuted", result: JSON.stringify(action) });
    // Exercise the idle connection gap that occurs while awaiting approval.
    if (desktop && !idleGapTested) {
      idleGapTested = true;
      await new Promise((resolve) => setTimeout(resolve, 15000));
    }
  }
  assert(report.success, "Model did not finish within six steps");
} catch (error) {
  let message = String(error.message);
  for (const value of Object.values(env))
    if (value.length > 5) message = message.replaceAll(value, "[REDACTED]");
  report.error = message;
  process.exitCode = 1;
} finally {
  report.durationMs = Date.now() - begin;
  await browser.close();
  if (application) {
    const timer = setTimeout(() => application.process().kill("SIGKILL"), 5000);
    await application.close().finally(() => clearTimeout(timer));
  }
  mkdirSync("output/qa", { recursive: true });
  writeFileSync(
    `output/qa/provider-smoke-${desktop ? "desktop-" : ""}${provider}.json`,
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
}
