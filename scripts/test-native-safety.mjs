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
    "native/macos/TurnPolicy.swift",
    "native/macos/LaunchSafety.swift",
    "native/macos/FileSafety.swift",
    "tests/native/WakePolicyTests.swift",
    "tests/native/TurnPolicyTests.swift",
    "tests/native/LaunchSafetyTests.swift",
    "tests/native/FileSafetyTests.swift",
    "tests/native/InputIdleTests.swift",
    "tests/native/FrameSafetyTests.swift",
    "-o",
    "tmp/frame-safety-tests",
  ],
  { stdio: "inherit" },
);
if (build.status !== 0) process.exit(build.status ?? 1);
const test = spawnSync("tmp/frame-safety-tests", [], { stdio: "inherit" });
process.exit(test.status ?? 1);
