import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
if (process.platform !== "darwin")
  throw new Error("The native controller currently requires macOS.");
mkdirSync("native/bin", { recursive: true });
mkdirSync("tmp/swift-cache", { recursive: true });
const result = spawnSync(
  "swiftc",
  [
    "-O",
    "-parse-as-library",
    "-module-cache-path",
    "tmp/swift-cache",
    "-o",
    "native/bin/coarena-controller",
    "native/macos/Controller.swift",
    "native/macos/FrameSafety.swift",
    "native/macos/InputSafety.swift",
    "native/macos/LaunchSafety.swift",
    "native/macos/FileSafety.swift",
    "native/macos/NamedTargets.swift",
    "native/macos/Workspace.swift",
    "-framework",
    "AppKit",
    "-framework",
    "ScreenCaptureKit",
    "-framework",
    "Vision",
  ],
  { stdio: "inherit" },
);
if (result.status !== 0) process.exit(result.status ?? 1);
const voice = spawnSync(
  "swiftc",
  [
    "-O",
    "-module-cache-path",
    "tmp/swift-cache",
    "-o",
    "native/bin/coarena-voice",
    "-parse-as-library",
    "native/macos/Voice.swift",
    "native/macos/WakePolicy.swift",
    "native/macos/TurnPolicy.swift",
    "native/macos/Speaker.swift",
    "-framework",
    "AppKit",
    "-framework",
    "Speech",
    "-framework",
    "AVFoundation",
    "-Xlinker",
    "-sectcreate",
    "-Xlinker",
    "__TEXT",
    "-Xlinker",
    "__info_plist",
    "-Xlinker",
    "native/macos/Voice-Info.plist",
  ],
  { stdio: "inherit" },
);
if (voice.status !== 0) process.exit(voice.status ?? 1);
// The iMessage helper: AppleScript sending plus a read-only SQLite reader.
const messages = spawnSync(
  "swiftc",
  [
    "-O",
    "-parse-as-library",
    "-module-cache-path",
    "tmp/swift-cache",
    "-o",
    "native/bin/coarena-messages",
    "native/macos/Messages.swift",
    "native/macos/MessagesDatabase.swift",
    "native/macos/MessageSafety.swift",
    "-framework",
    "AppKit",
    "-lsqlite3",
  ],
  { stdio: "inherit" },
);
if (messages.status !== 0) process.exit(messages.status ?? 1);
// The agenda helper: calendar and reminders through EventKit. Its own embedded
// Info.plist carries the usage strings, so its grant is separate from the
// controller's Screen Recording and Accessibility.
const agenda = spawnSync(
  "swiftc",
  [
    "-O",
    "-parse-as-library",
    "-module-cache-path",
    "tmp/swift-cache",
    "-o",
    "native/bin/coarena-agenda",
    "native/macos/Agenda.swift",
    "native/macos/AgendaRules.swift",
    "-framework",
    "EventKit",
    "-Xlinker",
    "-sectcreate",
    "-Xlinker",
    "__TEXT",
    "-Xlinker",
    "__info_plist",
    "-Xlinker",
    "native/macos/Agenda-Info.plist",
  ],
  { stdio: "inherit" },
);
process.exit(agenda.status ?? 1);
