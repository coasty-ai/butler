import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
if (process.platform !== "darwin")
  throw new Error("The native controller currently requires macOS.");
mkdirSync("native/bin", { recursive: true });
mkdirSync("tmp/swift-cache", { recursive: true });
const compiler = spawnSync("swiftc", ["--version"], { encoding: "utf8" });
if (compiler.status !== 0) process.exit(compiler.status ?? 1);
const digest = (value) => createHash("sha256").update(value).digest("hex");
function compile(args) {
  const outputIndex = args.indexOf("-o") + 1;
  const output = args[outputIndex];
  if (
    process.argv.includes("--terminal") &&
    !["controller", "voice", "apple", "launch"].some(
      (name) => basename(output) === `coarena-${name}`,
    )
  )
    return { status: 0 };
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify([process.platform, process.arch, compiler.stdout, args]),
  );
  for (const file of args.filter((arg) => /\.(swift|plist)$/.test(arg)))
    hash.update(readFileSync(file));
  const fingerprint = hash.digest("hex"),
    stamp = output + ".build.json";
  try {
    const previous = JSON.parse(readFileSync(stamp, "utf8"));
    if (
      previous.fingerprint === fingerprint &&
      existsSync(output) &&
      previous.binary === digest(readFileSync(output))
    ) {
      console.log(`${basename(output)} is current.`);
      return { status: 0 };
    }
  } catch {}
  // Keep a running helper's inode intact, and replace only a successful build.
  // The basename stays stable for the native binary's code-signing identity.
  const temporary = join(dirname(output), `.build-${randomUUID()}`);
  mkdirSync(temporary);
  const destination = join(temporary, basename(output));
  const command = [...args];
  command[outputIndex] = destination;
  try {
    const result = spawnSync("swiftc", command, { stdio: "inherit" });
    if (result.status === 0) {
      renameSync(destination, output);
      writeFileSync(
        stamp,
        JSON.stringify({ fingerprint, binary: digest(readFileSync(output)) }),
      );
    }
    return result;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
const result = compile([
  "-O",
  "-parse-as-library",
  "-module-cache-path",
  "tmp/swift-cache",
  "-o",
  "native/bin/coarena-controller",
  "native/macos/Controller.swift",
  "native/macos/FrameSafety.swift",
  "native/macos/InputSafety.swift",
  "native/macos/ScrollPacing.swift",
  "native/macos/LaunchSafety.swift",
  "native/macos/FileSafety.swift",
  "native/macos/NamedTargets.swift",
  "native/macos/IdeSafety.swift",
  "native/macos/Workspace.swift",
  "native/macos/BackgroundInput.swift",
  "native/macos/ClickEffect.swift",
  "native/macos/Reveal.swift",
  "native/macos/ListNames.swift",
  "native/macos/Observer.swift",
  "native/macos/WebText.swift",
  "-framework",
  "AppKit",
  "-framework",
  "ScreenCaptureKit",
  "-framework",
  "Vision",
]);
if (result.status !== 0) process.exit(result.status ?? 1);
const voice = compile([
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
]);
if (voice.status !== 0) process.exit(voice.status ?? 1);
// The iMessage helper: AppleScript sending plus a read-only SQLite reader.
const messages = compile([
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
]);
if (messages.status !== 0) process.exit(messages.status ?? 1);
// The agenda helper: calendar and reminders through EventKit. Its own embedded
// Info.plist carries the usage strings, so its grant is separate from the
// controller's Screen Recording and Accessibility.
const agenda = compile([
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
]);
if (agenda.status !== 0) process.exit(agenda.status ?? 1);
// The Apple bridge: an MCP stdio server over EventKit and Apple events, with
// its own embedded Info.plist and bundle id, so its Calendars, Reminders and
// Automation grants are its own, separate from the agenda helper's read-only
// grant and from the controller's (docs/TOOLS.md).
const apple = compile([
  "-O",
  "-parse-as-library",
  "-module-cache-path",
  "tmp/swift-cache",
  "-o",
  "native/bin/coarena-apple",
  "native/macos/Apple.swift",
  "native/macos/AppleProtocol.swift",
  "native/macos/AppleRules.swift",
  "-framework",
  "EventKit",
  "-framework",
  "AppKit",
  "-Xlinker",
  "-sectcreate",
  "-Xlinker",
  "__TEXT",
  "-Xlinker",
  "__info_plist",
  "-Xlinker",
  "native/macos/Apple-Info.plist",
]);
if (apple.status !== 0) process.exit(apple.status ?? 1);
// The launcher shim: starts a user-added MCP server with TCC responsibility
// disclaimed and, when asked, without network access.
const launch = compile([
  "-O",
  "-parse-as-library",
  "-module-cache-path",
  "tmp/swift-cache",
  "-o",
  "native/bin/coarena-launch",
  "native/macos/Launch.swift",
]);
process.exit(launch.status ?? 1);
