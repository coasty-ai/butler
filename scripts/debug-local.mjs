import { spawn } from "node:child_process";
import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const project = fileURLToPath(new URL("../", import.meta.url));
const binary = join(
  project,
  "release/mac-arm64/Open Assist.app/Contents/MacOS/Open Assist",
);
if (process.platform !== "darwin" || !existsSync(binary)) {
  console.error("Build the local Mac app with npm run package:mac first.");
  process.exit(1);
}
const directory = join(project, ".data/diagnostics");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const envFile = join(project, ".env");
const commandIndex = process.argv.indexOf("--command");
if (commandIndex >= 0 && !process.argv[commandIndex + 1]) {
  console.error("--command requires a task.");
  process.exit(1);
}
console.log("Starting Open Assist with live local diagnostics.");
console.log(
  "If Open Assist is already running, quit it first. This command does not interrupt an active task.",
);
console.log("Logs: " + join(directory, "current.jsonl"));
const file = join(directory, "current.jsonl");
appendFileSync(file, "", { mode: 0o600 });
// LaunchServices must own launch attribution. Direct spawn from a terminal or
// editor assigns speech permission to that host, which can trigger a TCC crash.
const { ELECTRON_RUN_AS_NODE: _runAsNode, ...launchEnv } = process.env;
const child = spawn(
  "/usr/bin/open",
  [
    "-n",
    "-g",
    "-W",
    "--env",
    "COARENA_DEV=0",
    "--env",
    "COARENA_DIAGNOSTICS=1",
    "--env",
    "COARENA_DIAGNOSTICS_DIR=" + directory,
    // Records spoken/typed/task text, model actions and screenshots locally.
    ...(process.argv.includes("--verbose")
      ? ["--env", "COARENA_DIAGNOSTICS_VERBOSE=1"]
      : []),
    "--stdout",
    "/dev/null",
    "--stderr",
    "/dev/null",
    join(project, "release/mac-arm64/Open Assist.app"),
    "--args",
    ...(process.argv.includes("--import-env") && existsSync(envFile)
      ? ["--import-env", envFile]
      : []),
    ...process.argv
      .slice(2)
      .filter((arg) =>
        ["--hands-free", "--no-hands-free", "--natural-voice"].includes(arg),
      ),
    ...(commandIndex >= 0 ? ["--command", process.argv[commandIndex + 1]] : []),
  ],
  // macOS open forwards this environment to the app. Editors built on
  // Electron (VS Code) export ELECTRON_RUN_AS_NODE=1, which makes the app
  // start as plain Node and exit silently.
  { cwd: project, stdio: "inherit", env: launchEnv },
);
const tail = spawn("/usr/bin/tail", ["-n", "0", "-F", file], {
  stdio: "inherit",
});
const stop = () => {
  tail.kill();
  child.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("error", () => {
  console.error("Open Assist could not launch.");
  process.exitCode = 1;
});
child.on("exit", (code) => {
  tail.kill();
  process.exitCode = code ?? 1;
});
