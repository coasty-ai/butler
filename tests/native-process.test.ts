import { describe, it, test, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import {
  NativeController,
  budgetDelay,
  nativeTimeout,
} from "../electron/controller";
import {
  NativeVoice,
  approvalHint,
  continueHint,
  pausedLabel,
  type VoiceEvent,
} from "../electron/voice";
import {
  HelperUnavailableError,
  NativeActionError,
  NativeStoppedError,
  ScreenChangedError,
  SurfaceBlockedError,
  screenChanges,
} from "../src/core/errors";
import changeFixture from "./fixtures/screen-changes.json";
import { previewBridge } from "../src/ui/preview";
import { summarizeMemory } from "../src/ui/api";
import type { MemoryData } from "../src/memory/types";
import type { Frame } from "../src/core/schema";

test("a native stop signal preserves the process for resuming and later commands", async () => {
  const root = mkdtempSync(join(tmpdir(), "coarena-native-protocol-"));
  const binary = join(root, "controller.cjs");
  writeFileSync(
    binary,
    `#!${process.execPath}
process.on('SIGUSR1', () => {});
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'human') process.stdout.write(JSON.stringify({event: 'user_takeover'}) + '\\n');
  process.stdout.write(JSON.stringify({id: request.id, result: {method: request.method}}) + '\\n');
});
`,
    { mode: 0o700 },
  );
  let exits = 0;
  let takeovers = 0;
  const controller = new NativeController(
    binary,
    () => {
      exits++;
    },
    () => {
      takeovers++;
    },
  );
  try {
    expect(await controller.request("surface")).toEqual({ method: "surface" });
    controller.stop();
    await controller.resume();
    expect(await controller.request("capture")).toEqual({ method: "capture" });
    controller.stop();
    await controller.resume();
    expect(exits).toBe(0);
    await controller.request("human");
    expect(takeovers).toBe(1);
  } finally {
    controller.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("manual input idle reports reach main with only known kinds", async () => {
  const root = mkdtempSync(join(tmpdir(), "coarena-native-idle-"));
  const binary = join(root, "controller.cjs");
  writeFileSync(
    binary,
    `#!${process.execPath}
process.on('SIGUSR1', () => {});
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'idle') {
    process.stdout.write(JSON.stringify({event: 'user_input_idle', idleMs: 1000, kinds: ['mouse_move', 'secret', 7, 'click']}) + '\\n');
    process.stdout.write(JSON.stringify({event: 'user_input_idle', idleMs: 'soon', kinds: []}) + '\\n');
  }
  process.stdout.write(JSON.stringify({id: request.id, result: {}}) + '\\n');
});
`,
    { mode: 0o700 },
  );
  const reports: { idleMs: number; kinds: string[] }[] = [];
  const controller = new NativeController(
    binary,
    () => {},
    () => {},
    undefined,
    { inputIdle: (report) => reports.push(report) },
  );
  try {
    await controller.request("idle");
    expect(reports).toEqual([{ idleMs: 1000, kinds: ["mouse_move", "click"] }]);
  } finally {
    controller.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function fakeHelper(source: string) {
  const root = mkdtempSync(join(tmpdir(), "coarena-native-restart-"));
  const binary = join(root, "helper.cjs");
  writeFileSync(
    binary,
    `#!${process.execPath}
process.on('SIGUSR1', () => {});
const reply = (line) => process.stdout.write(JSON.stringify(line) + '\\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
${source}
});
`,
    { mode: 0o700 },
  );
  return {
    binary,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
const until = async (check: () => boolean, ms = 5000) => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error("Timed out waiting.");
    await new Promise((r) => setTimeout(r, 20));
  }
};

test("an unexpected helper exit rejects pending work, respawns in place and serves later requests", async () => {
  const { binary, cleanup } = fakeHelper(`
  if (request.method === 'crash') process.exit(3);
  reply({id: request.id, result: {method: request.method, pid: process.pid}});`);
  let emergencies = 0,
    unavailable = 0;
  const restarts: (number | undefined)[] = [];
  const controller = new NativeController(
    binary,
    () => emergencies++,
    () => {},
    undefined,
    {
      onUnavailable: () => unavailable++,
      onRestart: (pid) => restarts.push(pid),
    },
  );
  try {
    const first = controller.pid;
    await expect(controller.request("crash")).rejects.toBeInstanceOf(
      HelperUnavailableError,
    );
    expect(unavailable).toBe(1);
    await expect(controller.request("surface")).rejects.toBeInstanceOf(
      HelperUnavailableError,
    );
    await until(() => restarts.length === 1);
    expect(restarts[0]).toBe(controller.pid);
    expect(controller.pid).not.toBe(first);
    expect(await controller.request("surface")).toMatchObject({
      method: "surface",
      pid: controller.pid,
    });
    expect(emergencies).toBe(0);
  } finally {
    controller.close();
    cleanup();
  }
});

test("a hung request times out, kills the helper and restarts it", async () => {
  const { binary, cleanup } = fakeHelper(`
  // A wedged helper: nothing after a hung request is served, not even the
  // presence its reader thread answers when it is merely busy.
  if (request.method === 'hang') { globalThis.hung = true; return; }
  if (globalThis.hung) return;
  reply({id: request.id, result: {method: request.method}});`);
  const events: string[] = [];
  let restarted = 0;
  const controller = new NativeController(
    binary,
    () => {},
    () => {},
    (event) => events.push(event),
    {
      onRestart: () => restarted++,
      // The liveness probe has presence's deadline (tests/controller-liveness).
      timeout: (method) =>
        method === "hang" ? 200 : method === "presence" ? 100 : 5000,
    },
  );
  try {
    const first = controller.pid!;
    const hung = controller.request("hang");
    const queued = controller.request("surface");
    await expect(hung).rejects.toBeInstanceOf(HelperUnavailableError);
    await expect(queued).rejects.toBeInstanceOf(HelperUnavailableError);
    await until(() => restarted === 1);
    expect(() => process.kill(first, 0)).toThrow();
    expect(await controller.request("surface")).toEqual({ method: "surface" });
    expect(events).toContain("NativeUnavailable");
    expect(events).toContain("NativeRestarted");
  } finally {
    controller.close();
    cleanup();
  }
});

test("a hung native helper gets a grace period after the stop signal before SIGKILL", async () => {
  const root = mkdtempSync(join(tmpdir(), "coarena-native-grace-"));
  const binary = join(root, "helper.cjs"),
    released = join(root, "released");
  // Like a latched drag: the stop signal lets the in-flight request post its
  // button release shortly afterwards. The helper is wedged, so its presence
  // goes unanswered too; a merely slow one is kept (tests/controller-liveness).
  writeFileSync(
    binary,
    `#!${process.execPath}
process.on('SIGUSR1', () => setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(released)}, 'up'), 80));
let hung = false;
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'hang') { hung = true; return; }
  if (hung) return;
  process.stdout.write(JSON.stringify({id: request.id, result: {}}) + '\\n');
});
`,
    { mode: 0o700 },
  );
  let restarted = 0;
  const controller = new NativeController(
    binary,
    () => {},
    () => {},
    undefined,
    {
      onRestart: () => restarted++,
      timeout: (method) =>
        method === "hang" ? 150 : method === "presence" ? 100 : 5000,
    },
  );
  try {
    // The helper is up (and its signal handler installed) before it hangs.
    await controller.request("surface");
    const first = controller.pid!;
    const started = Date.now();
    await expect(controller.request("hang")).rejects.toBeInstanceOf(
      HelperUnavailableError,
    );
    // Requests fail fast while the hung helper is being replaced.
    await expect(controller.request("surface")).rejects.toBeInstanceOf(
      HelperUnavailableError,
    );
    await until(() => restarted === 1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    expect(existsSync(released)).toBe(true);
    expect(() => process.kill(first, 0)).toThrow();
  } finally {
    controller.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an intentional close does not respawn or report the helper as unavailable", async () => {
  const { binary, cleanup } = fakeHelper(`
  reply({id: request.id, result: {}});`);
  const events: string[] = [];
  let unavailable = 0,
    restarted = 0;
  const controller = new NativeController(
    binary,
    () => {},
    () => {},
    (event) => events.push(event),
    { onUnavailable: () => unavailable++, onRestart: () => restarted++ },
  );
  try {
    await controller.request("surface");
    controller.close();
    await until(() => events.includes("NativeClosed"));
    await new Promise((r) => setTimeout(r, 700));
    expect(unavailable).toBe(0);
    expect(restarted).toBe(0);
    expect(events).not.toContain("NativeUnavailable");
    await expect(controller.request("surface")).rejects.toThrow(
      "Native controller is not running.",
    );
  } finally {
    cleanup();
  }
});

test("native error codes map to typed errors and execute returns the launch record", async () => {
  const { binary, cleanup } = fakeHelper(`
  if (request.method === 'stopped') return reply({id: request.id, error: 'Native input stopped. Explicitly resume to continue.', code: 'STOPPED'});
  if (request.method === 'changed') return reply({id: request.id, error: 'The screen changed before input.', code: 'STATE_CHANGED'});
  if (request.method === 'blocked') return reply({id: request.id, error: 'Sensitive input is active. Take over to finish it.', code: 'SURFACE_BLOCKED'});
  if (request.method === 'execute' && request.action.type === 'open_app') {
    if (request.action.name === 'Missing') return reply({id: request.id, error: 'The application could not be launched.', code: 'LAUNCH_FAILED'});
    if (request.action.name === 'Calendar') return reply({id: request.id, result: {executed: true, launched: {appId: 'com.apple.iCal', name: 'Calendar', frontmost: true, wasRunning: true, windows: 0, restoredWindow: false}}});
    if (request.action.name === 'Garbled') return reply({id: request.id, result: {executed: true, launched: {appId: 'com.apple.iCal', name: 'Calendar', frontmost: true, wasRunning: true, windows: '0', restoredWindow: 'yes'}}});
    return reply({id: request.id, result: {executed: true, launched: {appId: 'com.apple.Notes', name: 'Notes', frontmost: true, wasRunning: false}}});
  }
  reply({id: request.id, result: {executed: true}});`);
  const controller = new NativeController(binary, () => {});
  const frame = {} as Frame;
  try {
    await expect(controller.request("stopped")).rejects.toBeInstanceOf(
      NativeStoppedError,
    );
    await expect(controller.request("changed")).rejects.toBeInstanceOf(
      ScreenChangedError,
    );
    const blocked = await controller.request("blocked").catch((e) => e);
    expect(blocked).toBeInstanceOf(SurfaceBlockedError);
    expect(blocked.code).toBe("SURFACE_BLOCKED");
    expect(blocked.message).toBe(
      "Sensitive input is active. Take over to finish it.",
    );
    const failure = await controller
      .execute(
        { type: "open_app", frame_id: "f", name: "Missing" },
        frame,
        new AbortController().signal,
      )
      .catch((e) => e);
    expect(failure).toBeInstanceOf(NativeActionError);
    expect(failure.code).toBe("LAUNCH_FAILED");
    expect(
      await controller.execute(
        { type: "open_app", frame_id: "f", name: "Notes" },
        frame,
        new AbortController().signal,
      ),
    ).toEqual({
      launched: {
        appId: "com.apple.Notes",
        name: "Notes",
        frontmost: true,
        wasRunning: false,
      },
    });
    // A running app that came up windowless reports its window count.
    expect(
      await controller.execute(
        { type: "open_app", frame_id: "f", name: "Calendar" },
        frame,
        new AbortController().signal,
      ),
    ).toEqual({
      launched: {
        appId: "com.apple.iCal",
        name: "Calendar",
        frontmost: true,
        wasRunning: true,
        windows: 0,
        restoredWindow: false,
      },
    });
    // A malformed count is dropped, never read as "no window".
    expect(
      await controller.execute(
        { type: "open_app", frame_id: "f", name: "Garbled" },
        frame,
        new AbortController().signal,
      ),
    ).toEqual({
      launched: {
        appId: "com.apple.iCal",
        name: "Calendar",
        frontmost: true,
        wasRunning: true,
      },
    });
    expect(
      await controller.execute(
        { type: "key", frame_id: "f", key: "ENTER" },
        frame,
        new AbortController().signal,
      ),
    ).toBeUndefined();
  } finally {
    controller.close();
    cleanup();
  }
});

test("the app accepts exactly the change codes native sends", () => {
  expect([...screenChanges].sort()).toEqual([...changeFixture.codes].sort());
});

test("a refused step keeps its kind of change as a known code only", async () => {
  const { binary, cleanup } = fakeHelper(`
  const change = {focus: 'FOCUS_CHANGED', text: 'Budget.xlsx changed', none: undefined}[request.method];
  if (request.method in {focus: 1, text: 1, none: 1}) return reply({id: request.id, error: 'The focused field changed.', code: 'STATE_CHANGED', change});
  reply({id: request.id, result: {}});`);
  const controller = new NativeController(binary, () => {});
  try {
    const focus = await controller.request("focus").catch((e) => e);
    expect(focus).toBeInstanceOf(ScreenChangedError);
    expect(focus.change).toBe("FOCUS_CHANGED");
    expect(focus.message).toBe("The focused field changed.");
    for (const method of ["text", "none"]) {
      const error = await controller.request(method).catch((e) => e);
      expect(error).toBeInstanceOf(ScreenChangedError);
      expect(error.change).toBeUndefined();
    }
  } finally {
    controller.close();
    cleanup();
  }
});

test("a named target the helper did not press is a rejected step, and a hotkey reports its route", async () => {
  const { binary, cleanup } = fakeHelper(`
  if (request.method === 'execute') {
    const keys = request.action.keys.join('+');
    if (keys === 'CMD+Q') return reply({id: request.id, error: 'Menu items that quit an application or end the session are left to the user.', code: 'TARGET_REFUSED'});
    if (keys === 'CMD+E') return reply({id: request.id, error: 'The menu item for CMD+E is greyed out right now.', code: 'TARGET_DISABLED'});
    if (keys === 'CMD+J') return reply({id: request.id, error: 'The menu item for CMD+J is not in this application\\'s menus.', code: 'TARGET_MISSING'});
    if (keys === 'CMD+K') return reply({id: request.id, error: 'The menu item for CMD+K could not be chosen.', code: 'INPUT_FAILED'});
    const via = {'CMD+N': 'menu', 'CMD+T': 'keys', 'CMD+W': 'mouse'}[keys];
    return reply({id: request.id, result: {executed: true, via}});
  }
  reply({id: request.id, result: {}});`);
  const controller = new NativeController(binary, () => {});
  const hotkey = (...keys: string[]) =>
    controller.execute(
      { type: "hotkey", frame_id: "f", keys } as any,
      {} as Frame,
      new AbortController().signal,
    );
  try {
    for (const [keys, code] of [
      [["CMD", "Q"], "TARGET_REFUSED"],
      [["CMD", "E"], "TARGET_DISABLED"],
      [["CMD", "J"], "TARGET_MISSING"],
    ] as const) {
      const error = await hotkey(...keys).catch((e) => e);
      expect(error).toBeInstanceOf(NativeActionError);
      expect(error.code).toBe(code);
    }
    // A press that failed part-way is not a clean refusal.
    const failed = await hotkey("CMD", "K").catch((e) => e);
    expect(failed).not.toBeInstanceOf(NativeActionError);
    expect(await hotkey("CMD", "N")).toEqual({ via: "menu" });
    expect(await hotkey("CMD", "T")).toEqual({ via: "keys" });
    expect(await hotkey("CMD", "W")).toBeUndefined();
  } finally {
    controller.close();
    cleanup();
  }
});

test("per-method native deadlines scale typing and allow slow launches", () => {
  expect(nativeTimeout("capture")).toBe(25000);
  expect(nativeTimeout("revalidate")).toBe(25000);
  expect(nativeTimeout("surface")).toBe(15000);
  expect(
    nativeTimeout("execute", {
      action: { type: "type_text", text: "x".repeat(100) },
    }),
  ).toBe(19000);
  expect(nativeTimeout("execute", { action: { type: "open_app" } })).toBe(
    20000,
  );
  expect(nativeTimeout("execute", { action: { type: "click" } })).toBe(15000);
});

test("the system index and open_file have their own deadlines", () => {
  expect(nativeTimeout("index")).toBe(3000);
  expect(nativeTimeout("index", { query: "q3 report", limit: 10 })).toBe(3000);
  expect(
    nativeTimeout("execute", {
      action: { type: "open_file", path: "~/Documents/a.pdf" },
    }),
  ).toBe(12000);
  expect(
    nativeTimeout("surface", {
      action: { type: "open_file", path: "~/Documents/a.pdf" },
    }),
  ).toBe(15000);
});

test("file error codes map to NativeActionError and execute returns a sanitized open record", async () => {
  const { binary, cleanup } = fakeHelper(`
  if (request.method === 'execute' && request.action.type === 'open_file') {
    const path = request.action.path;
    if (path === '~/missing.txt') return reply({id: request.id, error: 'The file could not be found.', code: 'FILE_UNRESOLVED'});
    if (path === '~/.ssh/id_rsa') return reply({id: request.id, error: 'That file is not allowed.', code: 'FILE_REFUSED'});
    if (path === '~/broken.pages') return reply({id: request.id, error: 'The file could not be opened.', code: 'OPEN_FAILED'});
    if (path === '~/long.txt') return reply({id: request.id, result: {executed: true, opened: {path: '~/' + 'a'.repeat(900), kind: 'document', appId: 'b'.repeat(400)}}});
    if (path === '~/weird') return reply({id: request.id, result: {executed: true, opened: {path: '~/weird', kind: 'application'}}});
    if (path === '~/Projects') return reply({id: request.id, result: {executed: true, opened: {path: '~/Projects', kind: 'folder', appId: 42}}});
    return reply({id: request.id, result: {executed: true, opened: {path, kind: 'document', appId: 'com.apple.Preview', secret: 'x'}}});
  }
  reply({id: request.id, result: {executed: true}});`);
  const controller = new NativeController(binary, () => {});
  const frame = {} as Frame;
  const open = (path: string) =>
    controller.execute(
      { type: "open_file", frame_id: "f", path } as any,
      frame,
      new AbortController().signal,
    );
  try {
    for (const [path, code] of [
      ["~/missing.txt", "FILE_UNRESOLVED"],
      ["~/.ssh/id_rsa", "FILE_REFUSED"],
      ["~/broken.pages", "OPEN_FAILED"],
    ]) {
      const error = await open(path).catch((e) => e);
      expect(error).toBeInstanceOf(NativeActionError);
      expect(error.code).toBe(code);
    }
    expect(await open("~/Documents/Q3.pdf")).toEqual({
      opened: {
        path: "~/Documents/Q3.pdf",
        kind: "document",
        appId: "com.apple.Preview",
      },
    });
    const long = (await open("~/long.txt")) as any;
    expect(long.opened.path.length).toBe(500);
    expect(long.opened.appId.length).toBe(255);
    // Unknown kinds are not trusted as an opened record.
    expect(await open("~/weird")).toBeUndefined();
    // A non-string app id is dropped, the folder record is kept.
    expect(await open("~/Projects")).toEqual({
      opened: { path: "~/Projects", kind: "folder" },
    });
  } finally {
    controller.close();
    cleanup();
  }
});

test("a slow index lookup rejects without restarting the helper", async () => {
  const { binary, cleanup } = fakeHelper(`
  if (request.method === 'index') return;
  reply({id: request.id, result: {method: request.method, pid: process.pid}});`);
  let unavailable = 0;
  const controller = new NativeController(
    binary,
    () => {},
    () => {},
    undefined,
    {
      onUnavailable: () => unavailable++,
      timeout: (method) => (method === "index" ? 100 : 5000),
    },
  );
  try {
    const pid = controller.pid;
    const error = await controller
      .request("index", { query: "notes" })
      .catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(HelperUnavailableError);
    expect(controller.alive).toBe(true);
    expect(await controller.request("surface")).toMatchObject({ pid });
    expect(unavailable).toBe(0);
  } finally {
    controller.close();
    cleanup();
  }
});

test("the voice helper restarts after an exit and reports a stalled call", async () => {
  const { binary, cleanup } = fakeHelper(`
  if (request.method === 'crash') process.exit(1);
  if (request.method === 'hang') return;
  reply({id: request.id, result: {method: request.method}});`);
  let restarted = 0;
  const voice = new NativeVoice(binary, () => {}, undefined, {
    onRestart: () => restarted++,
  });
  try {
    await expect(voice.call("crash")).rejects.toBeInstanceOf(
      HelperUnavailableError,
    );
    await until(() => restarted === 1);
    expect(await voice.call("status")).toEqual({ method: "status" });
    await expect(voice.call("hang")).rejects.toThrow(
      "Voice helper did not respond.",
    );
    await until(() => restarted === 2);
    expect(await voice.call("status")).toEqual({ method: "status" });
  } finally {
    voice.close();
    cleanup();
  }
}, 15000);

test("a voice helper speak call acknowledges at once and reports playback as events", async () => {
  const { binary, cleanup } = fakeHelper(`
  if (request.method === 'speak') {
    reply({id: request.id, result: {accepted: true}});
    reply({event: 'speech_started', utteranceId: request.utteranceId});
    setTimeout(() => reply({event: 'speech_finished', utteranceId: request.utteranceId, interrupted: false}), 20);
    return;
  }
  if (request.method === 'listen') {
    reply({id: request.id, result: {accepted: true}});
    reply({event: 'followup_open', kind: request.kind, seconds: request.seconds});
    return;
  }
  reply({id: request.id, result: {}});`);
  const events: VoiceEvent[] = [];
  const voice = new NativeVoice(binary, (event) => events.push(event));
  try {
    // The helper replies before playback; a stalled reply would time out.
    expect(
      await voice.call("speak", {
        utteranceId: "u1",
        text: "On it.",
        priority: "ack",
      }),
    ).toEqual({ accepted: true });
    await until(() => events.some((e) => e.event === "speech_finished"), 10000);
    expect(events.map((e) => [e.event, e.utteranceId])).toEqual([
      ["speech_started", "u1"],
      ["speech_finished", "u1"],
    ]);
    expect(events[1].interrupted).toBe(false);
    expect(await voice.call("listen", { kind: "answer", seconds: 8 })).toEqual({
      accepted: true,
    });
    await until(() => events.some((e) => e.event === "followup_open"), 10000);
    expect(events.at(-1)).toMatchObject({ kind: "answer", seconds: 8 });
  } finally {
    voice.close();
    cleanup();
  }
}, 30000);

test("sliding-window budgets defer the next attempt until the oldest expires", () => {
  expect(budgetDelay([], 1000, 3, 60000)).toBe(0);
  expect(budgetDelay([1000, 2000], 3000, 3, 60000)).toBe(0);
  expect(budgetDelay([1000, 2000, 3000], 4000, 3, 60000)).toBe(57000);
  // Entries already outside the window do not count.
  expect(budgetDelay([0, 50000, 55000], 61000, 3, 60000)).toBe(0);
  expect(budgetDelay([61000, 50000, 55000], 62000, 3, 60000)).toBe(48000);
});

test("paused pill copy explains the interruption and how to continue", () => {
  expect(pausedLabel("Didn’t catch that. Try again.")).toBe(
    "Paused — didn’t catch that.",
  );
  expect(pausedLabel("Nothing to approve.")).toBe(
    "Paused — nothing to approve.",
  );
  expect(pausedLabel("Voice restarted. Try again.")).toBe(
    "Paused — voice restarted.",
  );
  expect(pausedLabel("Try again.")).toBe("Paused.");
  expect(pausedLabel("API key missing")).toBe("Paused — API key missing.");
  expect(continueHint(true)).toBe("Say ‘continue’ or ‘stop’.");
  expect(continueHint(false)).toBe("Hold ⌥ Space to continue.");
  expect(approvalHint(true)).toBe("Say “yes” or “no”, or click.");
  expect(approvalHint(false)).toBe(
    "Hold ⌥ Space and say “yes”, or click once.",
  );
});

describe("voice hold (the preview bridge mirrors the desktop app)", () => {
  async function working() {
    const bridge = previewBridge();
    const statuses: string[] = [];
    bridge.subscribe((s) => s.run && statuses.push(s.run.status));
    await bridge.start("Move the card and add a note.", true);
    await until(() => statuses.length > 0);
    return {
      bridge,
      status: () => statuses.at(-1),
    };
  }
  it("dismissing an untouched text pill resumes the run it paused", async () => {
    const { bridge, status } = await working();
    try {
      await bridge.openCommand();
      expect(status()).toBe("paused");
      expect((await bridge.pillState()).phase).toBe("text");
      await bridge.dismiss();
      expect(status()).not.toBe("paused");
    } finally {
      await bridge.stop();
    }
  });
  it("a “no” or “yes” with nothing pending keeps the run paused and explains", async () => {
    const { bridge, status } = await working();
    try {
      await bridge.openCommand();
      await bridge.command("no");
      expect(status()).toBe("paused");
      expect(await bridge.pillState()).toMatchObject({
        phase: "paused",
        label: "Paused — nothing to approve.",
      });
      // The hold is gone: a later dismissal only collapses cards.
      await bridge.dismiss();
      expect(status()).toBe("paused");
      await bridge.command("yes");
      expect(status()).toBe("paused");
      await bridge.command("continue");
      expect(status()).not.toBe("paused");
    } finally {
      await bridge.stop();
    }
  });
  it("a text pill opened on an already paused run never resumes on dismiss", async () => {
    const { bridge, status } = await working();
    try {
      await bridge.pause();
      await bridge.openCommand();
      await bridge.dismiss();
      expect(status()).toBe("paused");
    } finally {
      await bridge.stop();
    }
  });
});

describe("learning summary for the settings window", () => {
  const at = (day: number) => new Date(Date.UTC(2026, 0, day)).toISOString();
  it("counts everything and lists only the 10 newest preferences and skill triggers", () => {
    const data: MemoryData = {
      version: 1,
      episodes: Array.from({ length: 3 }, (_, i) => ({
        id: `e${i}`,
        kind: "episode" as const,
        task: `private episode task ${i}`,
        tokens: [],
        status: "completed" as const,
        apps: [],
        summary: "private summary",
        corrections: [],
        actions: 1,
        cost: 0,
        createdAt: at(1),
      })),
      preferences: Array.from({ length: 12 }, (_, i) => ({
        id: `p${i}`,
        kind: "preference" as const,
        text: i === 11 ? "x".repeat(400) : `preference ${i}`,
        tokens: [],
        weight: 1,
        source: "correction" as const,
        createdAt: at(1),
        updatedAt: at(i + 1),
      })),
      skills: Array.from({ length: 11 }, (_, i) => ({
        id: `s${i}`,
        kind: "skill" as const,
        trigger: `open {slot0} in app ${i}`,
        tokens: [],
        slots: [],
        steps: [],
        hintOnly: false,
        successes: 2,
        failures: 0,
        createdAt: at(1),
        lastUsed: at(20 - i),
      })),
      apps: {
        "com.apple.Notes": {
          bundleId: "com.apple.Notes",
          name: "Notes",
          count: 3,
          lastUsed: at(2),
        },
      },
    };
    const summary = summarizeMemory(data);
    expect(summary.counts).toEqual({
      episodes: 3,
      preferences: 12,
      skills: 11,
      apps: 1,
    });
    expect(summary.preferences).toHaveLength(10);
    expect(summary.preferences[0]).toHaveLength(200);
    expect(summary.preferences[1]).toBe("preference 10");
    expect(summary.preferences).not.toContain("preference 0");
    expect(summary.skills).toHaveLength(10);
    expect(summary.skills[0]).toBe("open {slot0} in app 0");
    expect(summary.skills).not.toContain("open {slot0} in app 10");
    // Episode task text is only counted, never listed.
    expect(JSON.stringify(summary)).not.toContain("private");
  });
  it("the preview bridge reports an empty store and refuses to forget during a run", async () => {
    const bridge = previewBridge();
    expect(await bridge.memorySummary()).toEqual({
      counts: { episodes: 0, preferences: 0, skills: 0, apps: 0 },
      preferences: [],
      skills: [],
    });
    await expect(bridge.forgetMemory()).resolves.toBeUndefined();
    await bridge.start("Move the card to Completed.", true);
    try {
      await expect(bridge.forgetMemory()).rejects.toThrow(
        /Stop the active run/,
      );
    } finally {
      await bridge.stop();
    }
  });
});
