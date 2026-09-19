import { expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NativeController,
  nativeSlowLimit,
  nativeTimeout,
  slowMessage,
  slowNotice,
} from "../electron/controller";
import { HelperSlowError, HelperUnavailableError } from "../src/core/errors";

/**
 * A helper whose reader thread answers presence at once whatever its serial
 * queue is doing, like the Swift helper's (ControllerMain reads presence
 * ahead of its command queue). `source` sees `request`, `reply`, and a
 * `presences` counter of the probes it was sent, which `count` reports.
 */
function fakeHelper(source: string) {
  const root = mkdtempSync(join(tmpdir(), "coarena-native-liveness-"));
  const binary = join(root, "helper.cjs");
  writeFileSync(
    binary,
    `#!${process.execPath}
process.on('SIGUSR1', () => {});
let presences = 0;
const reply = (line) => process.stdout.write(JSON.stringify(line) + '\\n');
const presence = (request) => { presences++; reply({id: request.id, result: {hidIdleSeconds: 1, tapIdleSeconds: null, locked: false, displayAsleep: false, displayHeldAwake: false}}); };
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'count') return reply({id: request.id, result: {presences}});
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
type Events = { event: string; data: Record<string, unknown> }[];
const until = async (check: () => boolean, ms = 5000) => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error("Timed out waiting.");
    await new Promise((r) => setTimeout(r, 20));
  }
};
/**
 * Test time: a capture's first deadline D, presence's P (the probe's own
 * deadline, generous because this Mac may be running other suites), and a
 * bound of four deadlines for a capture. Every other request keeps a long
 * deadline so only the request under test can expire.
 */
const D = 150;
const P = 500;
function harness(binary: string) {
  const events: Events = [];
  const counts = { unavailable: 0, restarted: 0, slow: [] as string[] };
  const controller = new NativeController(
    binary,
    () => {},
    () => {},
    (event, data = {}) => events.push({ event, data }),
    {
      timeout: (method) =>
        method === "capture" ? D : method === "presence" ? P : 5000,
      slowLimit: (method) => (method === "capture" ? 4 * D : 10000),
      onUnavailable: () => counts.unavailable++,
      onRestart: () => counts.restarted++,
      onSlow: (method) => counts.slow.push(method),
    },
  );
  const of = (event: string) => events.filter((e) => e.event === event);
  return { controller, events, counts, of };
}

test("a capture's deadline is a first deadline, its bound a minute, and every other request gets one more", () => {
  expect(nativeTimeout("capture")).toBe(25000);
  for (const method of [
    "capture",
    "revalidate",
    "captureTarget",
    "revalidateTarget",
  ])
    expect(nativeSlowLimit(method)).toBe(60000);
  expect(nativeSlowLimit("surface")).toBe(30000);
  expect(nativeSlowLimit("configure")).toBe(30000);
  expect(
    nativeSlowLimit("execute", { action: { type: "click", x: 0.5, y: 0.5 } }),
  ).toBe(30000);
  expect(
    nativeSlowLimit("execute", {
      action: { type: "type_text", text: "x".repeat(100) },
    }),
  ).toBe(2 * (15000 + 4000));
  expect(nativeSlowLimit("execute", { action: { type: "open_app" } })).toBe(
    40000,
  );
  // Never below the first deadline, so a request is never cut short.
  expect(nativeSlowLimit("presence")).toBeGreaterThanOrEqual(
    nativeTimeout("presence"),
  );
});

test("the sentences name reading the screen for a capture or a surface and desktop control for a step", () => {
  for (const method of [
    "capture",
    "captureTarget",
    "surface",
    "surfaceTarget",
  ]) {
    expect(slowNotice(method)).toBe("Reading the screen is slow…");
    expect(slowMessage(method)).toBe(
      "Reading the screen is taking too long. Say continue to try again.",
    );
  }
  for (const method of ["execute", "executeTarget", "configure"]) {
    expect(slowNotice(method)).toBe("Desktop control is slow…");
    expect(slowMessage(method)).toBe(
      "Desktop control is taking too long. Say continue to try again.",
    );
  }
  // The error's default is the step's sentence; the pill line is never spoken.
  expect(new HelperSlowError().message).toBe(slowMessage("execute"));
  expect(new HelperSlowError().code).toBe("HELPER_SLOW");
});

test("a capture past its deadline waits on while the helper answers presence, and its late answer is accepted", async () => {
  // The queue holds the capture for two and a half deadlines; presence
  // answers at once throughout.
  const { binary, cleanup } = fakeHelper(`
  if (request.method === 'presence') return presence(request);
  if (request.method === 'capture') { setTimeout(() => reply({id: request.id, result: {method: 'capture', pid: process.pid}}), ${2.5 * D}); return; }
  reply({id: request.id, result: {method: request.method, pid: process.pid}});`);
  const { controller, counts, of } = harness(binary);
  try {
    // The helper is up before the slow request, so its deadlines are the
    // helper's and not Node's start-up.
    expect(await controller.request("count")).toEqual({ presences: 0 });
    const pid = controller.pid;
    const started = Date.now();
    const frame = await controller.request("capture");
    expect(frame).toMatchObject({ method: "capture", pid });
    expect(Date.now() - started).toBeGreaterThanOrEqual(2.5 * D);
    // Extended at the first deadline and the second, then answered before
    // the third (a probe's own latency can push the second extension past
    // the answer on a loaded Mac, so at least one, at most two).
    const slow = of("NativeSlow");
    expect(slow.length).toBeGreaterThanOrEqual(1);
    expect(slow.length).toBeLessThanOrEqual(2);
    for (const line of slow) expect(line.data.method).toBe("capture");
    expect(slow[0].data.waitedMs).toBeGreaterThanOrEqual(D);
    // Content-free: the method's name and a measurement, nothing else.
    expect(Object.keys(slow[0].data).sort()).toEqual(["method", "waitedMs"]);
    expect(counts.slow).toEqual(slow.map(() => "capture"));
    // Nothing was killed or restarted, and nothing said so.
    expect(of("NativeTimedOut")).toHaveLength(0);
    expect(of("NativeUnavailable")).toHaveLength(0);
    expect(of("NativeRestarted")).toHaveLength(0);
    expect(counts.unavailable).toBe(0);
    expect(counts.restarted).toBe(0);
    expect(controller.alive).toBe(true);
    expect(controller.pid).toBe(pid);
    // One probe per extension, and none for the requests that answered in time.
    expect(await controller.request("count")).toEqual({
      presences: slow.length,
    });
  } finally {
    controller.close();
    cleanup();
  }
});

test("a request whose liveness probe also goes unanswered kills and restarts the helper as before", async () => {
  // A wedged helper: nothing answers after the hang, presence included.
  const { binary, cleanup } = fakeHelper(`
  if (request.method === 'capture') { globalThis.hung = true; return; }
  if (globalThis.hung) return;
  if (request.method === 'presence') return presence(request);
  reply({id: request.id, result: {method: request.method, pid: process.pid}});`);
  const { controller, counts, of } = harness(binary);
  try {
    expect(await controller.request("count")).toEqual({ presences: 0 });
    const first = controller.pid!;
    const started = Date.now();
    const error = await controller.request("capture").catch((e) => e);
    expect(error).toBeInstanceOf(HelperUnavailableError);
    expect(error.message).toBe(
      "Desktop control stopped responding and is restarting.",
    );
    // The deadline, then the probe's own deadline, then the kill.
    expect(Date.now() - started).toBeGreaterThanOrEqual(D + P);
    await until(() => counts.restarted === 1);
    expect(() => process.kill(first, 0)).toThrow();
    expect(counts.unavailable).toBe(1);
    expect(counts.slow).toEqual([]);
    expect(of("NativeSlow")).toHaveLength(0);
    const [timedOut] = of("NativeTimedOut");
    expect(timedOut.data.method).toBe("capture");
    expect(timedOut.data.waitedMs).toBeGreaterThanOrEqual(D + P);
    expect(of("NativeUnavailable")).toHaveLength(1);
    expect(of("NativeRestarted")).toHaveLength(1);
    // The replacement serves later requests.
    expect(await controller.request("surface")).toMatchObject({
      method: "surface",
    });
    expect(controller.pid).not.toBe(first);
  } finally {
    controller.close();
    cleanup();
  }
});

test("the extended wait is bounded: past it an alive helper is kept and the request fails with its own sentence", async () => {
  // The queue never answers the capture; presence answers every time.
  const { binary, cleanup } = fakeHelper(`
  if (request.method === 'presence') return presence(request);
  if (request.method === 'capture') return;
  reply({id: request.id, result: {method: request.method, pid: process.pid}});`);
  const { controller, counts, of } = harness(binary);
  try {
    expect(await controller.request("count")).toEqual({ presences: 0 });
    const pid = controller.pid;
    const started = Date.now();
    const error = await controller.request("capture").catch((e) => e);
    expect(error).toBeInstanceOf(HelperSlowError);
    expect(error).not.toBeInstanceOf(HelperUnavailableError);
    expect(error.message).toBe(
      "Reading the screen is taking too long. Say continue to try again.",
    );
    // The bound is four deadlines: three extensions, each cut to what was
    // left, then the probe at the bound that decides between this and a kill.
    expect(Date.now() - started).toBeGreaterThanOrEqual(4 * D);
    expect(of("NativeSlow")).toHaveLength(3);
    expect(counts.slow).toEqual(["capture", "capture", "capture"]);
    // The failure is traced as the request's own error, never as a hang.
    const [failed] = of("NativeError").filter(
      (e) => e.data.method === "capture",
    );
    expect(failed.data).toMatchObject({
      name: "HelperSlowError",
      code: "HELPER_SLOW",
    });
    expect(of("NativeTimedOut")).toHaveLength(0);
    expect(of("NativeUnavailable")).toHaveLength(0);
    expect(of("NativeRestarted")).toHaveLength(0);
    expect(counts.unavailable).toBe(0);
    expect(counts.restarted).toBe(0);
    // The same helper, with whatever it holds, serves the next request.
    expect(controller.alive).toBe(true);
    expect(controller.pid).toBe(pid);
    expect(await controller.request("surface")).toMatchObject({ pid });
    // Three extensions and the decision at the bound: four probes.
    expect(await controller.request("count")).toEqual({ presences: 4 });
  } finally {
    controller.close();
    cleanup();
  }
});

test("a request that never restarts the helper is never extended and never probes", async () => {
  // A slow Spotlight lookup fails on its one deadline, as before, and the
  // helper hears no presence request for it.
  const { binary, cleanup } = fakeHelper(`
  if (request.method === 'presence') return presence(request);
  if (request.method === 'index') return;
  reply({id: request.id, result: {method: request.method, pid: process.pid}});`);
  const events: Events = [];
  const controller = new NativeController(
    binary,
    () => {},
    () => {},
    (event, data = {}) => events.push({ event, data }),
    { timeout: (method) => (method === "index" ? D : 5000) },
  );
  try {
    expect(await controller.request("count")).toEqual({ presences: 0 });
    const error = await controller
      .request("index", { query: "notes" })
      .catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(HelperSlowError);
    expect(error).not.toBeInstanceOf(HelperUnavailableError);
    expect(error.message).toBe("The system index did not answer in time.");
    expect(events.filter((e) => e.event === "NativeSlow")).toHaveLength(0);
    expect(controller.alive).toBe(true);
    expect(await controller.request("count")).toEqual({ presences: 0 });
  } finally {
    controller.close();
    cleanup();
  }
});

test("one probe serves every request waiting on it", async () => {
  // Two requests pass their deadlines together; the helper is asked once.
  const { binary, cleanup } = fakeHelper(`
  if (request.method === 'presence') return presence(request);
  if (request.method === 'capture' || request.method === 'configure') { setTimeout(() => reply({id: request.id, result: {method: request.method}}), ${1.5 * D}); return; }
  reply({id: request.id, result: {method: request.method}});`);
  const events: Events = [];
  const controller = new NativeController(
    binary,
    () => {},
    () => {},
    (event, data = {}) => events.push({ event, data }),
    {
      timeout: (method) =>
        method === "presence" ? P : method === "count" ? 5000 : D,
      slowLimit: () => 10 * D,
    },
  );
  try {
    expect(await controller.request("count")).toEqual({ presences: 0 });
    const [capture, configure] = await Promise.all([
      controller.request("capture"),
      controller.request("configure"),
    ]);
    expect(capture).toEqual({ method: "capture" });
    expect(configure).toEqual({ method: "configure" });
    expect(
      events
        .filter((e) => e.event === "NativeSlow")
        .map((e) => e.data.method)
        .sort(),
    ).toEqual(["capture", "configure"]);
    expect(await controller.request("count")).toEqual({ presences: 1 });
  } finally {
    controller.close();
    cleanup();
  }
});

test("a second request given up at its bound with nothing answered from the queue between them restarts the helper", async () => {
  // A reader alive over a wedged queue: presence answers, the queue never
  // does. The first capture is given up with the helper kept; the second,
  // with no queued reply in between, is the helper dead for work.
  const { binary, cleanup } = fakeHelper(`
  if (request.method === 'presence') return presence(request);
  if (request.method === 'capture') return;
  reply({id: request.id, result: {method: request.method, pid: process.pid}});`);
  const { controller, counts, of } = harness(binary);
  try {
    expect(await controller.request("count")).toEqual({ presences: 0 });
    const first = controller.pid!;
    await expect(controller.request("capture")).rejects.toBeInstanceOf(
      HelperSlowError,
    );
    expect(counts.restarted).toBe(0);
    await expect(controller.request("capture")).rejects.toBeInstanceOf(
      HelperUnavailableError,
    );
    await until(() => counts.restarted === 1);
    expect(() => process.kill(first, 0)).toThrow();
    expect(of("NativeTimedOut")).toHaveLength(1);
    expect(of("NativeTimedOut")[0].data.method).toBe("capture");
    expect(of("NativeUnavailable")).toHaveLength(1);
    // The first capture's three extensions and the second's three: nothing
    // was extended past its bound.
    expect(of("NativeSlow")).toHaveLength(6);
    // The replacement starts unstalled and serves.
    expect(await controller.request("surface")).toMatchObject({
      method: "surface",
    });
    expect(controller.pid).not.toBe(first);
  } finally {
    controller.close();
    cleanup();
  }
});

test("a queued reply between two requests given up at their bounds keeps the helper", async () => {
  // The queue is slow, not wedged: it answers a surface between two captures
  // it never finishes, so each capture is given up and the helper kept.
  const { binary, cleanup } = fakeHelper(`
  if (request.method === 'presence') return presence(request);
  if (request.method === 'capture') return;
  reply({id: request.id, result: {method: request.method, pid: process.pid}});`);
  const { controller, counts, of } = harness(binary);
  try {
    expect(await controller.request("count")).toEqual({ presences: 0 });
    const pid = controller.pid;
    await expect(controller.request("capture")).rejects.toBeInstanceOf(
      HelperSlowError,
    );
    expect(await controller.request("surface")).toMatchObject({ pid });
    await expect(controller.request("capture")).rejects.toBeInstanceOf(
      HelperSlowError,
    );
    expect(of("NativeTimedOut")).toHaveLength(0);
    expect(of("NativeUnavailable")).toHaveLength(0);
    expect(counts.restarted).toBe(0);
    expect(controller.alive).toBe(true);
    expect(controller.pid).toBe(pid);
    // Presence answers alone never count as the queue answering.
    expect(await controller.request("count")).toEqual({ presences: 8 });
  } finally {
    controller.close();
    cleanup();
  }
});
