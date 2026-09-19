import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  NativeController,
  nativeTimeout,
  runTarget,
  targetResult,
} from "../electron/controller";
import { TargetError } from "../src/core/errors";
import type { Action, Frame } from "../src/core/schema";

const target = {
  token: "tok-slack-0001",
  pid: 501,
  windowId: 77,
  appId: "com.tinyspeck.slackmacgap",
  appName: "Slack",
  title: "Prateek (DM)",
};
const frame = {
  id: "frame-1",
  sha256: "sha",
  image: "",
  geometry: {
    display_id: 1,
    x: 0,
    y: 0,
    width: 1440,
    height: 900,
    native_width: 2880,
    native_height: 1800,
    model_width: 900,
    model_height: 600,
    scale_factor: 2,
    window: { id: 77, x: 100, y: 80, width: 900, height: 600 },
  },
  capturedAt: 0,
  synthetic: false,
} satisfies Frame;

describe("target deadlines", () => {
  it("captures and checks a bound window like the screen, binds and fronts in eight seconds", () => {
    expect(nativeTimeout("captureTarget", { token: "t" })).toBe(25000);
    expect(nativeTimeout("revalidateTarget", { token: "t" })).toBe(25000);
    expect(nativeTimeout("bindTarget", { app: "Slack" })).toBe(8000);
    expect(nativeTimeout("foregroundTarget", { token: "t" })).toBe(8000);
    expect(nativeTimeout("unbindTarget", { token: "t" })).toBe(3000);
    expect(nativeTimeout("surfaceTarget", { token: "t" })).toBe(15000);
    expect(
      nativeTimeout("executeTarget", {
        token: "t",
        action: { type: "type_text", text: "x".repeat(100) },
        rungs: ["ax", "post"],
      }),
    ).toBe(15000 + 40 * 100);
  });
});

describe("target replies are parsed, bounded and never trusted for shape", () => {
  it("keeps a run target only with a token, ids and names", () => {
    expect(runTarget({ ...target, title: "x".repeat(400) })).toEqual({
      ...target,
      title: "x".repeat(300),
    });
    expect(runTarget({ ...target, title: undefined })).toMatchObject({
      title: "",
    });
    for (const bad of [
      undefined,
      "x",
      { ...target, token: "short" },
      { ...target, token: "has space in it" },
      { ...target, pid: 7.5 },
      { ...target, windowId: "77" },
      { ...target, appName: undefined },
      { ...target, appId: 7 },
    ])
      expect(runTarget(bad)).toBeUndefined();
  });
  it("reads the rung and the effect, and turns a refused step into its code", () => {
    expect(
      targetResult({ executed: true, rung: "post", effect: "changed" }),
    ).toEqual({ rung: "post", effect: "changed" });
    expect(
      targetResult({ executed: true, rung: "sky", effect: "maybe" }),
    ).toEqual({});
    expect(targetResult(null)).toBeUndefined();
    expect(() =>
      targetResult({
        executed: false,
        code: "KEYBOARD_AMBIGUOUS",
        error: "Two windows.",
      }),
    ).toThrow(
      expect.objectContaining({
        code: "KEYBOARD_AMBIGUOUS",
        message: "Two windows.",
      }),
    );
    expect(() => targetResult({ executed: false, code: "SURPRISE" })).toThrow(
      expect.objectContaining({ code: "RUNG_UNAVAILABLE" }),
    );
  });
});

describe("the native controller's target methods", () => {
  function fakeHelper(body: string) {
    const root = mkdtempSync(join(tmpdir(), "coarena-native-target-"));
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
  it("sends the spec, the token, the action and the rungs, and parses what comes back", async () => {
    const { binary, cleanup } = fakeHelper(`
  if (request.method === 'bindTarget') return reply({id: request.id, result: {token: 'tok-slack-0001', pid: 501, windowId: 77, appId: 'com.tinyspeck.slackmacgap', appName: 'Slack', title: 'Prateek (DM)', echo: {app: request.app, title: request.title}}});
  if (request.method === 'executeTarget') return reply({id: request.id, result: {executed: true, rung: request.rungs[request.rungs.length - 1], effect: 'changed', echo: {token: request.token, action: request.action.type}}});
  if (request.method === 'foregroundTarget') return reply({id: request.id, result: {frontmost: 'yes'}});
  if (request.method === 'captureTarget') return reply({id: request.id, result: {id: 'w-1', sha256: 's', image: '', geometry: {display_id: 1, x: 0, y: 0, width: 1, height: 1, native_width: 1, native_height: 1, model_width: 1, model_height: 1, scale_factor: 1, window: {id: 77, x: 1, y: 2, width: 3, height: 4}}, capturedAt: 0, synthetic: false, appId: 'com.tinyspeck.slackmacgap', context: {appName: 'Slack', windowTitle: 'DM', background: {appName: 'Slack', title: 'DM', covered: true, staleRisk: true, minimized: false}, surprise: 1}}});
  reply({id: request.id, result: {method: request.method, token: request.token}});`);
    const controller = new NativeController(binary, () => {});
    try {
      const bound = await controller.bindTarget({ app: "Slack" });
      expect(bound).toEqual(target);
      const result = await controller.executeTarget(
        bound.token,
        { type: "click_control", label: "Send", frame_id: "f" } as Action,
        frame,
        ["ax", "post"],
        new AbortController().signal,
      );
      expect(result).toEqual({ rung: "post", effect: "changed" });
      // A non-boolean answer is not frontmost.
      expect(await controller.foregroundTarget(bound.token)).toEqual({
        frontmost: false,
      });
      const captured = await controller.captureTarget(bound.token);
      // An unknown context field drops the context rather than pass through.
      expect(captured.context).toBeUndefined();
      expect(captured.geometry.window).toEqual({
        id: 77,
        x: 1,
        y: 2,
        width: 3,
        height: 4,
      });
      expect(
        await controller.request("unbindTarget", { token: bound.token }),
      ).toEqual({ method: "unbindTarget", token: bound.token });
    } finally {
      controller.close();
      cleanup();
    }
  });
  it("turns the helper's target codes into TargetErrors and rejects malformed shapes", async () => {
    const { binary, cleanup } = fakeHelper(`
  if (request.method === 'bindTarget') return reply({id: request.id, error: 'The window is gone.', code: 'TARGET_GONE'});
  if (request.method === 'executeTarget') return reply({id: request.id, error: 'Two windows.', code: 'KEYBOARD_AMBIGUOUS'});
  if (request.method === 'surfaceTarget') return reply({id: request.id, error: 'Protected.', code: 'TARGET_PROTECTED'});
  reply({id: request.id, result: {}});`);
    const controller = new NativeController(binary, () => {});
    try {
      await expect(controller.bindTarget({})).rejects.toSatisfy(
        (e: unknown) => e instanceof TargetError && e.code === "TARGET_GONE",
      );
      await expect(
        controller.executeTarget(
          "t",
          { type: "key", key: "ENTER", frame_id: "f" } as Action,
          frame,
          ["post"],
          new AbortController().signal,
        ),
      ).rejects.toSatisfy(
        (e: unknown) =>
          e instanceof TargetError && e.code === "KEYBOARD_AMBIGUOUS",
      );
      await expect(controller.surfaceTarget("t")).rejects.toSatisfy(
        (e: unknown) =>
          e instanceof TargetError && e.code === "TARGET_PROTECTED",
      );
    } finally {
      controller.close();
      cleanup();
    }
  });
  it("reports where the user's input landed and the target events", async () => {
    const { binary, cleanup } = fakeHelper(`
  if (request.method === 'poke') {
    reply({event: 'user_takeover', source: 'tap', scope: 'target'});
    reply({event: 'user_takeover', source: 'tap'});
    reply({event: 'user_takeover', source: 'tap', scope: 'elsewhere'});
    reply({event: 'target_self_activated', token: 'tok-slack-0001'});
    reply({event: 'target_gone', token: 'tok-slack-0001', code: 'TARGET_PROTECTED'});
    reply({event: 'target_gone', token: 'tok-slack-0001', code: 'SURPRISE'});
    reply({event: 'target_gone'});
  }
  reply({id: request.id, result: {}});`);
    const manualInput = vi.fn();
    const targetSelfActivated = vi.fn();
    const targetGone = vi.fn();
    const controller = new NativeController(
      binary,
      () => {},
      manualInput,
      undefined,
      { targetSelfActivated, targetGone },
    );
    try {
      await controller.request("poke");
      expect(manualInput.mock.calls.map(([scope]) => scope)).toEqual([
        "target",
        "screen",
        "screen",
      ]);
      expect(targetSelfActivated).toHaveBeenCalledWith("tok-slack-0001");
      expect(targetGone.mock.calls).toEqual([
        ["tok-slack-0001", "TARGET_PROTECTED"],
        ["tok-slack-0001", "TARGET_GONE"],
      ]);
    } finally {
      controller.close();
      cleanup();
    }
  });
  it("carries the idle report's target facts as two flags, traced as flags, and drops any other shape", async () => {
    const { binary, cleanup } = fakeHelper(`
  if (request.method === 'poke') {
    reply({event: 'user_input_idle', idleMs: 1000, kinds: ['click'], target: {frontmost: false, lastInside: true}});
    reply({event: 'user_input_idle', idleMs: 3000, kinds: ['key'], target: {frontmost: 'yes', lastInside: true, x: 12}});
    reply({event: 'user_input_idle', idleMs: 1000, kinds: ['mouse_move']});
  }
  reply({id: request.id, result: {}});`);
    const inputIdle = vi.fn();
    const diagnostics = vi.fn();
    const controller = new NativeController(
      binary,
      () => {},
      () => {},
      diagnostics,
      { inputIdle },
    );
    try {
      await controller.request("poke");
      expect(inputIdle.mock.calls.map(([report]) => report)).toEqual([
        {
          idleMs: 1000,
          kinds: ["click"],
          target: { frontmost: false, lastInside: true },
        },
        { idleMs: 3000, kinds: ["key"] },
        { idleMs: 1000, kinds: ["mouse_move"] },
      ]);
      expect(
        diagnostics.mock.calls
          .filter(([event]) => event === "NativeInputIdle")
          .map(([, data]) => data),
      ).toEqual([
        {
          durationMs: 1000,
          kind: "click",
          targetFrontmost: false,
          lastInsideTarget: true,
        },
        { durationMs: 3000, kind: "key" },
        { durationMs: 1000, kind: "mouse_move" },
      ]);
    } finally {
      controller.close();
      cleanup();
    }
  });
});
