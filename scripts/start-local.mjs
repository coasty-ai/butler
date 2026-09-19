import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { localApp, staleBuild } from "./local-app.mjs";

const project = fileURLToPath(new URL("../", import.meta.url));
const envFile = join(project, ".env");
if (!existsSync(envFile)) {
  console.error("Create .env using .env.example, then run this command again.");
  process.exit(1);
}
const local = localApp(project);
const stale = process.platform === "darwin" && staleBuild(local);
if (stale) {
  console.error(stale);
  process.exit(1);
}
const appPath = local.app;
const args = ["--import-env", envFile, ...process.argv.slice(2)];
const packaged = process.platform === "darwin" && existsSync(appPath);
const { ELECTRON_RUN_AS_NODE: _runAsNode, ...launchEnv } = process.env;
const child = spawn(
  packaged ? "/usr/bin/open" : join(project, "node_modules/.bin/electron"),
  packaged ? ["-n", appPath, "--args", ...args] : [project, ...args],
  // VS Code exports ELECTRON_RUN_AS_NODE=1; the app must not inherit it.
  { cwd: project, stdio: "inherit", env: launchEnv },
);
child.on("error", () => {
  console.error("Could not launch Butler. Run npm run build first.");
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
