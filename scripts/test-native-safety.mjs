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
    "native/macos/BackgroundInput.swift",
    "native/macos/ClickEffect.swift",
    "native/macos/Reveal.swift",
    "native/macos/Observer.swift",
    "native/macos/WebText.swift",
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
    "tests/native/BackgroundInputTests.swift",
    "tests/native/ClickEffectTests.swift",
    "tests/native/RevealTests.swift",
    "tests/native/ControlRoleTests.swift",
    "tests/native/FrameSafetyTests.swift",
    "tests/native/ObserverTests.swift",
    "tests/native/WebTextTests.swift",
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
if (messageTest.status !== 0) process.exit(messageTest.status ?? 1);
// The Apple bridge's rules and MCP framing against tests/fixtures/apple, and
// the launcher shim as a process. Their own entry point too, so coarena-apple
// stays free of test code and of the fixture store. The shim is built twice:
// as shipped, and told at compile time that sandbox-exec is missing, so the
// 69 path can be seen on a Mac that has it.
const shim = (output, flags) =>
  spawnSync(
    "swiftc",
    [
      "-O",
      "-parse-as-library",
      "-module-cache-path",
      "tmp/swift-cache",
      ...flags,
      "native/macos/Launch.swift",
      "-o",
      output,
    ],
    { stdio: "inherit" },
  );
const launch = shim("tmp/coarena-launch-test", []);
if (launch.status !== 0) process.exit(launch.status ?? 1);
const launchNoSandbox = shim("tmp/coarena-launch-no-sandbox", [
  "-D",
  "LAUNCH_TEST_NO_SANDBOX_EXEC",
]);
if (launchNoSandbox.status !== 0) process.exit(launchNoSandbox.status ?? 1);
const apple = spawnSync(
  "swiftc",
  [
    "-O",
    "-parse-as-library",
    "-module-cache-path",
    "tmp/swift-cache",
    "native/macos/AppleRules.swift",
    "native/macos/AppleProtocol.swift",
    "tests/native/AppleRulesTests.swift",
    "tests/native/AppleProtocolTests.swift",
    "tests/native/LaunchTests.swift",
    "-o",
    "tmp/apple-tests",
  ],
  { stdio: "inherit" },
);
if (apple.status !== 0) process.exit(apple.status ?? 1);
const appleTest = spawnSync("tmp/apple-tests", [], {
  stdio: "inherit",
  env: {
    ...process.env,
    COARENA_LAUNCH: "tmp/coarena-launch-test",
    COARENA_LAUNCH_NO_SANDBOX: "tmp/coarena-launch-no-sandbox",
  },
});
process.exit(appleTest.status ?? 1);
