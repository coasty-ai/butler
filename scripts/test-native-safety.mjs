import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
mkdirSync("tmp/swift-cache", { recursive: true });
const build = spawnSync(
  "swiftc",
  [
    "-O",
    "-parse-as-library",
    "-module-cache-path",
    "tmp/swift-cache",
    "native/macos/FrameSafety.swift",
    "native/macos/InputSafety.swift",
    "native/macos/WakePolicy.swift",
    "tests/native/FrameSafetyTests.swift",
    "-o",
    "tmp/frame-safety-tests",
  ],
  { stdio: "inherit" },
);
if (build.status !== 0) process.exit(build.status ?? 1);
const test = spawnSync("tmp/frame-safety-tests", [], { stdio: "inherit" });
process.exit(test.status ?? 1);
