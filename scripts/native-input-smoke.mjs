// Real native input, restricted to the disposable fixture's process/window.
// No network calls, persistent screenshots, user files, or provider credentials.
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { NativeController } from "../electron/controller.ts";
import { ScreenChangedError } from "../src/core/errors.ts";
mkdirSync("tmp/swift-cache", { recursive: true });
const build = spawnSync(
  "swiftc",
  [
    "-O",
    "-module-cache-path",
    "tmp/swift-cache",
    "tests/native/RegressionWindow.swift",
    "-o",
    "tmp/regression-window",
    "-framework",
    "AppKit",
  ],
  { stdio: "inherit" },
);
assert.equal(build.status, 0, "Fixture compilation failed");
const fixture = spawn(resolve("tmp/regression-window"), [], {
  stdio: ["pipe", "pipe", "pipe"],
});
fixture.stderr.resume();
const pending = new Map();
let ready;
const boot = new Promise((resolve, reject) => {
  ready = resolve;
  const timeout = setTimeout(
    () => reject(new Error("Fixture did not open")),
    10000,
  );
  timeout.unref();
});
const lines = createInterface({ input: fixture.stdout });
lines.on("line", (line) => {
  const event = JSON.parse(line);
  if (event.event === "ready") ready(event);
  else {
    pending.get(event.id)?.(event.result);
    pending.delete(event.id);
  }
});
function request(method) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(
      () => reject(new Error("Fixture request timed out")),
      5000,
    );
    pending.set(id, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
    fixture.stdin.write(JSON.stringify({ id, method }) + "\n");
  });
}
const packaged = process.argv.includes("--packaged");
const controller = new NativeController(
  resolve(
    packaged
      ? "release/mac-arm64/Open Assist.app/Contents/Resources/coarena-controller"
      : "native/bin/coarena-controller",
  ),
  () => {},
  () => {},
  (event, data) => {
    if (["NativeUserTakeover", "NativeEmergencyStop"].includes(event))
      console.log(JSON.stringify({ event, ...data }));
  },
);
const checks = [];
async function eventually(predicate) {
  let state;
  for (let i = 0; i < 40; i++) {
    state = await request("status");
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return state;
}
try {
  const info = await boot;
  await new Promise((resolve) => setTimeout(resolve, 500));
  await controller.resume();
  async function capture() {
    assert.equal(
      (await controller.surface()).pid,
      info.pid,
      "Fixture is not frontmost; no input sent",
    );
    return controller.capture();
  }
  let target = await request("status");
  await request("stationaryPointer");
  await new Promise((resolve) => setTimeout(resolve, 100));
  await capture();
  checks.push("stationary mouse notification does not pause input");
  await request("movePointer");
  await new Promise((resolve) => setTimeout(resolve, 100));
  await assert.rejects(controller.capture(), /Native input stopped/);
  checks.push("actual pointer movement immediately stops input");
  await controller.resume();
  console.log("Checking native click with animation");
  let frame = await capture();
  assert.equal(
    (
      await controller.surface({
        type: "click",
        frame_id: frame.id,
        x: target.x,
        y: target.y,
        button: "left",
      })
    ).targetLabel,
    "Continue",
    "Fixture target is not the expected button",
  );
  // The clock changes continuously and the focused field has a blinking caret.
  await new Promise((resolve) => setTimeout(resolve, 650));
  await controller.execute(
    {
      type: "click",
      frame_id: frame.id,
      x: target.x,
      y: target.y,
      button: "left",
    },
    frame,
    new AbortController().signal,
  );
  assert.equal((await eventually((state) => state.clicks === 1)).clicks, 1);
  checks.push("actual click succeeds while clock and caret animate");
  console.log("Checking native typing with caret");
  await request("focus");
  frame = await capture();
  await new Promise((resolve) => setTimeout(resolve, 650));
  await controller.execute(
    { type: "type_text", frame_id: frame.id, text: "Safe" },
    frame,
    new AbortController().signal,
  );
  assert.equal(
    (await eventually((state) => state.text === "OriginalSafe")).text,
    "OriginalSafe",
  );
  checks.push("actual typing succeeds with a blinking caret");
  console.log("Checking native keyboard shortcuts");
  frame = await capture();
  await controller.execute(
    { type: "hotkey", frame_id: frame.id, keys: ["CMD", "A"] },
    frame,
    new AbortController().signal,
  );
  let keyboard = await eventually(
    (state) => state.selectionLength === "OriginalSafe".length,
  );
  assert.equal(
    keyboard.selectionLength,
    "OriginalSafe".length,
    JSON.stringify(keyboard.keyEvents),
  );
  checks.push("Command-A selects fixture text and does not trigger takeover");
  // AppKit briefly highlights the menu after a key equivalent.
  await new Promise((resolve) => setTimeout(resolve, 350));
  frame = await capture();
  await controller.execute(
    { type: "hotkey", frame_id: frame.id, keys: ["CMD", "SHIFT", "K"] },
    frame,
    new AbortController().signal,
  );
  keyboard = await eventually((state) => state.shortcuts === 1);
  assert.equal(keyboard.shortcuts, 1, JSON.stringify(keyboard.keyEvents));
  checks.push("Command-Shift-K activates the fixture menu shortcut");
  await new Promise((resolve) => setTimeout(resolve, 350));
  frame = await capture();
  await controller.execute(
    { type: "hotkey", keys: ["CMD", "SPACE"], frame_id: frame.id },
    frame,
    new AbortController().signal,
  );
  await new Promise((resolve) => setTimeout(resolve, 1000));
  frame = await controller.capture();
  assert.equal(
    frame.appId,
    "com.apple.Spotlight",
    "Spotlight must own the input context",
  );
  assert.equal((await controller.surface()).focusedRole, "AXTextField");
  checks.push(
    "Spotlight opens without false takeover and owns the observed input context",
  );
  await controller.execute(
    { type: "key", key: "ESC", frame_id: frame.id },
    frame,
    new AbortController().signal,
  );
  frame = await controller.capture();
  // With a retained search query, macOS may clear it on the first Escape.
  if (frame.appId === "com.apple.Spotlight") {
    await controller.execute({ type: "key", key: "ESC", frame_id: frame.id }, frame, new AbortController().signal);
    await controller.capture();
  }
  await capture();
  checks.push("Escape dismisses Spotlight and returns to the fixture");
  await request("videoOn");
  frame = await capture();
  await new Promise((resolve) => setTimeout(resolve, 350));
  await controller.execute(
    { type: "hotkey", keys: ["CMD", "A"], frame_id: frame.id },
    frame,
    new AbortController().signal,
  );
  assert.equal(
    (
      await eventually(
        (state) => state.selectionLength === "OriginalSafe".length,
      )
    ).selectionLength,
    "OriginalSafe".length,
  );
  frame = await capture();
  await new Promise((resolve) => setTimeout(resolve, 350));
  await controller.execute(
    { type: "type_text", text: "VideoStable", frame_id: frame.id },
    frame,
    new AbortController().signal,
  );
  assert.equal(
    (await eventually((state) => state.text === "VideoStable")).text,
    "VideoStable",
  );
  checks.push(
    "text selection and typing proceed while a large background video animates",
  );
  frame = await capture();
  await new Promise((resolve) => setTimeout(resolve, 350));
  await controller.execute(
    { type: "key", key: "ESC", frame_id: frame.id },
    frame,
    new AbortController().signal,
  );
  checks.push(
    "dismissal shortcut proceeds while a large background video animates",
  );
  await request("videoOff");
  await new Promise((resolve) => setTimeout(resolve, 300));
  frame = await capture();
  await request("focusOther");
  await assert.rejects(
    controller.execute(
      { type: "type_text", frame_id: frame.id, text: "WRONG" },
      frame,
      new AbortController().signal,
    ),
    ScreenChangedError,
  );
  checks.push("changed focused field blocks typing");
  await request("focus");
  frame = await capture();
  await request("longValue");
  await assert.rejects(
    controller.execute(
      { type: "type_text", frame_id: frame.id, text: "WRONG" },
      frame,
      new AbortController().signal,
    ),
    ScreenChangedError,
  );
  checks.push(
    "changed focused value still blocks typing after target-scoped validation",
  );
  await request("focus");
  frame = await capture();
  await request("selectAll");
  await assert.rejects(controller.execute({ type: "type_text", frame_id: frame.id, text: "WRONG" }, frame, new AbortController().signal), ScreenChangedError);
  checks.push("changed text selection still blocks typing");
  for (const mutation of ["move", "relabel", "changeTail", "secondWindow"]) {
    if (mutation === "changeTail") await request("longValue");
    target = await request("status");
    frame = await capture();
    await request(mutation);
    await assert.rejects(
      controller.execute(
        {
          type: "click",
          frame_id: frame.id,
          x: target.x,
          y: target.y,
          button: "left",
        },
        frame,
        new AbortController().signal,
      ),
      ScreenChangedError,
    );
    assert.equal((await request("status")).clicks, 1);
    checks.push(mutation + " blocks stale input");
  }
  const report = { result: "passed", packaged, checks };
  mkdirSync("output/qa", { recursive: true });
  writeFileSync(
    "output/qa/native-input-smoke.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
} finally {
  controller.close();
  await request("close").catch(() => {});
  fixture.kill();
  lines.close();
}
