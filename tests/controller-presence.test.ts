import { expect, test } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NativeController,
  nativeTimeout,
  presenceReport,
} from "../electron/controller";
import { HelperUnavailableError } from "../src/core/errors";

function fakeHelper(source: string) {
  const root = mkdtempSync(join(tmpdir(), "coarena-native-presence-"));
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
const report = {
  hidIdleSeconds: 3.5,
  tapIdleSeconds: null,
  locked: false,
  displayAsleep: false,
  displayHeldAwake: false,
};

test("presence has a short deadline of its own", () => {
  expect(nativeTimeout("presence")).toBe(2000);
  expect(nativeTimeout("presence")).toBeLessThan(nativeTimeout("surface"));
});

test("a presence reply is accepted only in the contract shape", () => {
  expect(presenceReport(report)).toEqual(report);
  expect(
    presenceReport({ ...report, tapIdleSeconds: 12, locked: true }),
  ).toEqual({ ...report, tapIdleSeconds: 12, locked: true });
  expect(presenceReport({ ...report, hidIdleSeconds: 0 })).toEqual({
    ...report,
    hidIdleSeconds: 0,
  });
  // A display held awake (a call sharing the screen, a video) reaches main
  // as read; it is the one sign of a user who is there but not typing.
  expect(presenceReport({ ...report, displayHeldAwake: true })).toEqual({
    ...report,
    displayHeldAwake: true,
  });
  // Extra keys are dropped rather than passed through.
  expect(presenceReport({ ...report, title: "Bank login" })).toEqual(report);
  for (const bad of [
    undefined,
    null,
    "present",
    {},
    { ...report, hidIdleSeconds: undefined },
    { ...report, hidIdleSeconds: "3" },
    { ...report, hidIdleSeconds: -1 },
    { ...report, hidIdleSeconds: Number.NaN },
    { ...report, tapIdleSeconds: undefined },
    { ...report, tapIdleSeconds: "12" },
    { ...report, tapIdleSeconds: -5 },
    { ...report, locked: "no" },
    { ...report, locked: 0 },
    { ...report, displayAsleep: undefined },
    { ...report, displayHeldAwake: undefined },
    { ...report, displayHeldAwake: "yes" },
    { ...report, displayHeldAwake: 1 },
  ])
    expect(presenceReport(bad), JSON.stringify(bad)).toBeUndefined();
});

test("the controller reads presence from the helper and rejects a malformed reply", async () => {
  const { binary, cleanup } = fakeHelper(`
  if (request.method === 'presence') return reply({id: request.id, result: request.count === undefined ? ${JSON.stringify(report)} : {locked: 'yes'}});
  reply({id: request.id, result: {method: request.method}});`);
  const controller = new NativeController(
    binary,
    () => {},
    () => {},
  );
  try {
    expect(await controller.presence()).toEqual(report);
    const error = await controller.request("presence", { count: 1 });
    expect(presenceReport(error)).toBeUndefined();
  } finally {
    controller.close();
    cleanup();
  }
});

test("a malformed presence reply is an error, not a report", async () => {
  const { binary, cleanup } = fakeHelper(`
  reply({id: request.id, result: {hidIdleSeconds: 'soon', tapIdleSeconds: null, locked: false, displayAsleep: false, displayHeldAwake: false}});`);
  const controller = new NativeController(
    binary,
    () => {},
    () => {},
  );
  try {
    await expect(controller.presence()).rejects.toThrow(/presence/);
  } finally {
    controller.close();
    cleanup();
  }
});

test("a slow presence read rejects without restarting the helper", async () => {
  const { binary, cleanup } = fakeHelper(`
  if (request.method === 'presence') return;
  reply({id: request.id, result: {method: request.method, pid: process.pid}});`);
  let unavailable = 0;
  const controller = new NativeController(
    binary,
    () => {},
    () => {},
    undefined,
    {
      onUnavailable: () => unavailable++,
      timeout: (method) => (method === "presence" ? 100 : 5000),
    },
  );
  try {
    const pid = controller.pid;
    const error = await controller.presence().catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(HelperUnavailableError);
    expect(error.message).toContain("Presence");
    expect(controller.alive).toBe(true);
    expect(await controller.request("surface")).toMatchObject({ pid });
    expect(unavailable).toBe(0);
  } finally {
    controller.close();
    cleanup();
  }
});

// The built helper, when present: it handles requests strictly in order on
// one queue, so a presence read must be answered ahead of that queue or it
// waits behind every capture and paced typing of the run it is polled in.
const helperBinary = fileURLToPath(
  new URL("../native/bin/coarena-controller", import.meta.url),
);
test.skipIf(!existsSync(helperBinary))(
  "the built helper answers presence ahead of a request in flight",
  async () => {
    const controller = new NativeController(
      helperBinary,
      () => {},
      () => {},
    );
    try {
      const order: string[] = [];
      // A Spotlight lookup is read-only and holds the queue for a few hundred
      // milliseconds; sent first, it would answer first if presence queued.
      const indexStarted = performance.now();
      const index = controller
        .request("index", { query: "notes budget spreadsheet", limit: 5 })
        .then(() => order.push("index"));
      const started = performance.now();
      const report = await controller.presence();
      const presenceMs = performance.now() - started;
      order.push("presence");
      await index;
      const indexMs = performance.now() - indexStarted;
      expect(order, `presence ${presenceMs} ms, index ${indexMs} ms`).toEqual([
        "presence",
        "index",
      ]);
      // The order above is the property; this bound only catches presence
      // falling back behind a multi-second capture. It is loose because the
      // suite often runs while Swift builds and other suites load the Mac
      // (738 ms was seen at a load average of 10 with the order still right).
      expect(presenceMs).toBeLessThan(2000);
      // The live reply is the contract shape exactly, flags included.
      expect(report).toEqual({
        hidIdleSeconds: expect.any(Number),
        tapIdleSeconds: null,
        locked: expect.any(Boolean),
        displayAsleep: expect.any(Boolean),
        displayHeldAwake: expect.any(Boolean),
      });
    } finally {
      controller.close();
    }
  },
  15000,
);
