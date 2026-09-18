import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  NativeController,
  PROBE_MAX_CHARS,
  PROBE_MAX_LINES,
  nativeTimeout,
  probeResult,
  watchBinding,
} from "../electron/controller";
import { HelperUnavailableError } from "../src/core/errors";

describe("watch deadlines", () => {
  it("gives a probe ten seconds, binding and focusing eight, flags three", () => {
    expect(nativeTimeout("probe", { token: "t" })).toBe(10000);
    expect(nativeTimeout("bindWatch")).toBe(8000);
    expect(nativeTimeout("focusWatch", { token: "t" })).toBe(8000);
    expect(nativeTimeout("unbindWatch", { token: "t" })).toBe(3000);
    expect(nativeTimeout("setWatchMode", { on: true })).toBe(3000);
  });
});

describe("watch replies are parsed, bounded and never trusted for shape", () => {
  it("keeps a binding only with a token, ids and a bounded title", () => {
    expect(
      watchBinding({
        token: "abcdef12-3456",
        appId: "com.microsoft.VSCode",
        pid: 7,
        windowId: 42,
        title: "x".repeat(400),
      }),
    ).toEqual({
      token: "abcdef12-3456",
      appId: "com.microsoft.VSCode",
      pid: 7,
      windowId: 42,
      title: "x".repeat(300),
    });
    expect(
      watchBinding({ token: "abcdef12", appId: "a", pid: 7, windowId: 1 }),
    ).toMatchObject({
      title: "",
    });
    for (const bad of [
      undefined,
      "x",
      { appId: "a", pid: 7, windowId: 1 },
      { token: "short", appId: "a", pid: 7, windowId: 1 },
      { token: "has space in it", appId: "a", pid: 7, windowId: 1 },
      { token: "abcdef12", appId: "a", pid: 7.5, windowId: 1 },
      { token: "abcdef12", appId: "a", pid: 7, windowId: "1" },
    ])
      expect(watchBinding(bad)).toBeUndefined();
  });
  it("bounds probe lines and drops malformed ones", () => {
    const many = Array.from({ length: PROBE_MAX_LINES + 50 }, (_, i) => ({
      t: `line ${i} ` + "y".repeat(300),
      x: 0.1,
      y: 0.2,
      w: 0.3,
      h: 0.02,
    }));
    const r = probeResult({
      ok: true,
      frontmost: "yes",
      title: "t".repeat(400),
      lines: [
        ...many,
        { t: "outside", x: 1.5, y: 0, w: 0.1, h: 0.1 },
        { t: "negative", x: 0, y: -0.1, w: 0.1, h: 0.1 },
        { t: 7, x: 0, y: 0, w: 0.1, h: 0.1 },
        { t: "   ", x: 0, y: 0, w: 0.1, h: 0.1 },
        "junk",
      ],
      idleMs: -5,
    });
    expect(r).toBeDefined();
    if (!r || !r.ok) throw new Error("expected an ok result");
    expect(r.frontmost).toBe(false);
    expect(r.title.length).toBe(300);
    expect(r.lines.length).toBe(PROBE_MAX_LINES);
    expect(r.lines.every((l) => l.t.length <= PROBE_MAX_CHARS)).toBe(true);
    expect(r.lines.some((l) => l.t === "outside" || l.t === "negative")).toBe(
      false,
    );
    expect(r.idleMs).toBe(0);
  });
  it("maps failures to known codes and rejects other shapes", () => {
    expect(probeResult({ ok: false, code: "secure_input" })).toEqual({
      ok: false,
      code: "secure_input",
    });
    expect(probeResult({ ok: false, code: "surprise" })).toEqual({
      ok: false,
      code: "failed",
    });
    expect(probeResult({ ok: false })).toEqual({ ok: false, code: "failed" });
    expect(probeResult({ ok: true })).toBeUndefined();
    expect(probeResult({ ok: "true", lines: [] })).toBeUndefined();
    expect(probeResult(null)).toBeUndefined();
    expect(probeResult({ ok: true, lines: [], idleMs: 1200 })).toEqual({
      ok: true,
      frontmost: false,
      title: "",
      lines: [],
      idleMs: 1200,
    });
  });
});

describe("the native controller's watch methods", () => {
  function fakeHelper(body: string) {
    const root = mkdtempSync(join(tmpdir(), "coarena-native-watch-"));
    const binary = join(root, "controller.cjs");
    writeFileSync(
      binary,
      `#!${process.execPath}
process.on('SIGUSR1', () => {});
const reply = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  ${body}
});
`,
      { mode: 0o700 },
    );
    return {
      binary,
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  }
  it("sends the token and region as given and parses what comes back", async () => {
    const { binary, cleanup } = fakeHelper(`
  if (request.method === 'bindWatch') return reply({id: request.id, result: {token: 'tok-1234-abcd', appId: 'com.microsoft.VSCode', pid: 7, windowId: 42, title: 'users.ts'}});
  if (request.method === 'probe') return reply({id: request.id, result: {ok: true, frontmost: true, title: 'users.ts', idleMs: 40, lines: [{t: 'Queue another message…', x: 0.7, y: 0.9, w: 0.2, h: 0.02}], echo: {token: request.token, region: request.region}}});
  reply({id: request.id, result: {method: request.method, token: request.token, on: request.on}});`);
    const controller = new NativeController(binary, () => {});
    try {
      expect(await controller.bindWatch()).toEqual({
        token: "tok-1234-abcd",
        appId: "com.microsoft.VSCode",
        pid: 7,
        windowId: 42,
        title: "users.ts",
      });
      const probe = await controller.probe("tok-1234-abcd", {
        x: 0.5,
        y: 0,
        w: 0.5,
        h: 1,
      });
      expect(probe).toEqual({
        ok: true,
        frontmost: true,
        title: "users.ts",
        idleMs: 40,
        lines: [
          { t: "Queue another message…", x: 0.7, y: 0.9, w: 0.2, h: 0.02 },
        ],
      });
      expect(await controller.request("probe", { token: "t" })).toMatchObject({
        echo: { token: "t" },
      });
      expect(await controller.request("setWatchMode", { on: true })).toEqual({
        method: "setWatchMode",
        on: true,
      });
      expect(await controller.request("unbindWatch", { token: "x" })).toEqual({
        method: "unbindWatch",
        token: "x",
      });
      expect(await controller.request("focusWatch", { token: "x" })).toEqual({
        method: "focusWatch",
        token: "x",
      });
      await expect(controller.bindWatch()).resolves.toBeDefined();
    } finally {
      controller.close();
      cleanup();
    }
  });
  it("rejects a malformed binding or probe instead of trusting it", async () => {
    const { binary, cleanup } = fakeHelper(`
  if (request.method === 'bindWatch') return reply({id: request.id, result: {token: 'bad token', appId: 'a', pid: 1, windowId: 1}});
  if (request.method === 'probe') return reply({id: request.id, result: {ok: 'yes'}});
  reply({id: request.id, result: {}});`);
    const controller = new NativeController(binary, () => {});
    try {
      await expect(controller.bindWatch()).rejects.toThrow(/no watch binding/);
      await expect(controller.probe("t")).rejects.toThrow(/no probe result/);
    } finally {
      controller.close();
      cleanup();
    }
  });
  it("a slow probe times out without restarting the helper", async () => {
    const { binary, cleanup } = fakeHelper(`
  if (request.method === 'probe') return;
  reply({id: request.id, result: {method: request.method}});`);
    const controller = new NativeController(
      binary,
      () => {},
      () => {},
      undefined,
      {
        timeout: (method) => (method === "probe" ? 50 : 5000),
      },
    );
    try {
      const error = await controller.probe("t").catch((e) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(HelperUnavailableError);
      expect(error.message).toBe("The watch did not answer in time.");
      expect(controller.alive).toBe(true);
      expect(await controller.request("surface")).toEqual({
        method: "surface",
      });
    } finally {
      controller.close();
      cleanup();
    }
  });
});
