import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { spawn } from "node:child_process";

const project = fileURLToPath(new URL("../", import.meta.url));
const envFile = join(project, ".env");
if (!existsSync(envFile)) {
  console.error("Create .env using .env.example, then run this command again.");
  process.exit(1);
}
const appPath = join(project, "release/mac-arm64/Open Assist.app");
const args = ["--import-env", envFile, ...process.argv.slice(2)];
const packaged = process.platform === "darwin" && existsSync(appPath);
const child = spawn(
  packaged ? "/usr/bin/open" : join(project, "node_modules/.bin/electron"),
  packaged ? ["-n", appPath, "--args", ...args] : [project, ...args],
  { cwd: project, stdio: "inherit" },
);
child.on("error", () => {
  console.error("Could not launch Open Assist. Run npm run build first.");
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
