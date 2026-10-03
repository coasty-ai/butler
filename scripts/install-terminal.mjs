import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "darwin")
  throw new Error("Butler requires macOS 14 or later.");
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 12))
  throw new Error("Install Node.js 22.12 or later first.");
const run = (args) => {
  const result = spawnSync("npm", args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: "1" },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
};
if (!existsSync(join(root, "node_modules/.bin/esbuild")))
  run(["ci", "--ignore-scripts"]);
run(["run", "build:terminal"]);
if (
  [
    "coarena-controller",
    "coarena-launch",
    "coarena-voice",
    "coarena-apple",
  ].some((name) => !existsSync(join(root, "native/bin", name)))
)
  run(["run", "build:native"]);
const dir = join(homedir(), ".local/bin");
mkdirSync(dir, { recursive: true });
const command = join(dir, "butler");
const target = join(root, "dist-terminal/main.cjs");
let existing;
try {
  existing = lstatSync(command);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (existing) {
  if (
    !existing.isSymbolicLink() ||
    resolve(dir, readlinkSync(command)) !== target
  )
    throw new Error(
      `${command} already exists. It was left untouched. Start this checkout with npm start.`,
    );
  unlinkSync(command);
}
symlinkSync(target, command);
console.log(
  `\nInstalled Butler. Start with: ${command}\nPreview the animation: ${command} --demo\nIf 'butler' is not on PATH, run: export PATH="$HOME/.local/bin:$PATH"\n`,
);
