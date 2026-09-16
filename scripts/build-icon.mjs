import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
mkdirSync("tmp/swift-cache", { recursive: true });
for (const [command, args] of [
  ["swift", ["-module-cache-path", "tmp/swift-cache", "scripts/Icon.swift"]],
  [
    "iconutil",
    ["-c", "icns", "build/open-assist.iconset", "-o", "build/open-assist.icns"],
  ],
]) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
