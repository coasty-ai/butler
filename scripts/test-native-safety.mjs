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
    "native/macos/ScrollPacing.swift",
    "native/macos/WakePolicy.swift",
    "native/macos/TurnPolicy.swift",
    "native/macos/LaunchSafety.swift",
    "native/macos/FileSafety.swift",
    "native/macos/NamedTargets.swift",
    "native/macos/IdeSafety.swift",
    "native/macos/Workspace.swift",
    "native/macos/AgendaRules.swift",
    "tests/native/WakePolicyTests.swift",
    "tests/native/TurnPolicyTests.swift",
    "tests/native/LaunchSafetyTests.swift",
    "tests/native/FileSafetyTests.swift",
    "tests/native/InputIdleTests.swift",
    "tests/native/ScrollPacingTests.swift",
    "tests/native/NamedTargetTests.swift",
    "tests/native/IdeSafetyTests.swift",
    "tests/native/WorkspaceTests.swift",
    "tests/native/AgendaRulesTests.swift",
    "tests/native/FrameSafetyTests.swift",
    "-o",
    "tmp/frame-safety-tests",
  ],
  { stdio: "inherit" },
);
if (build.status !== 0) process.exit(build.status ?? 1);
const test = spawnSync("tmp/frame-safety-tests", [], { stdio: "inherit" });
if (test.status !== 0) process.exit(test.status ?? 1);
// The messaging rules build separately: they have their own entry point so
// the helper binary stays free of test code.
const messages = spawnSync(
  "swiftc",
  [
    "-O",
    "-parse-as-library",
    "-module-cache-path",
    "tmp/swift-cache",
    "native/macos/MessageSafety.swift",
    "native/macos/MessagesDatabase.swift",
    "tests/native/MessageSafetyTests.swift",
    "-o",
    "tmp/message-safety-tests",
  ],
  { stdio: "inherit" },
);
if (messages.status !== 0) process.exit(messages.status ?? 1);
const messageTest = spawnSync("tmp/message-safety-tests", [], {
  stdio: "inherit",
});
process.exit(messageTest.status ?? 1);
