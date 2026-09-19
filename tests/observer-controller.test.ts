import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NativeController,
  OBSERVE_CONTROLS_MAX,
  OBSERVE_EVERY_MS_DEFAULT,
  OBSERVE_FRAME_MAX_BYTES,
  OBSERVE_TEXT_MAX,
  OBSERVE_TITLE_MAX,
  nativeTimeout,
  observedEvent,
  type ObservedEvent,
} from "../electron/controller";
import { HelperUnavailableError } from "../src/core/errors";
import type { DiagnosticSink } from "../src/core/diagnostics";

const root = join(import.meta.dirname, "..");
const source = (path: string) => readFileSync(join(root, path), "utf8");

/**
 * A helper in Node: answers `observe` by echoing what it was sent, keeps
 * the last observe request for `lastObserve`, and on `emit` writes the
 * given lines to its stdout before answering, so every event reaches the
 * controller ahead of the reply.
 */
function fakeHelper(extra = "") {
  const dir = mkdtempSync(join(tmpdir(), "coarena-native-observe-"));
  const binary = join(dir, "controller.cjs");
  writeFileSync(
    binary,
    `#!${process.execPath}
process.on('SIGUSR1', () => {});
const reply = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let lastObserve;
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  ${extra}
  if (request.method === 'observe') { lastObserve = {on: request.on, tier: request.tier, everyMs: request.everyMs}; return reply({id: request.id, result: {observing: request.on, tier: request.tier, everyMs: request.everyMs}}); }
  if (request.method === 'lastObserve') return reply({id: request.id, result: lastObserve});
  if (request.method === 'emit') { for (const o of request.lines) process.stdout.write((typeof o === 'string' ? o : JSON.stringify(o)) + '\\n'); return reply({id: request.id, result: {emitted: request.lines.length}}); }
  reply({id: request.id, result: {method: request.method}});
});
`,
    { mode: 0o700 },
  );
  return {
    binary,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
function recorder() {
  const traced: { event: string; data: Record<string, unknown> }[] = [];
  const sink: DiagnosticSink = (event, data = {}) =>
    void traced.push({ event, data: { ...data } });
  return { traced, sink };
}

describe("observe: the request", () => {
  it("has a short deadline of its own, like the other flag flips", () => {
    expect(nativeTimeout("observe", { on: false })).toBe(3000);
    expect(nativeTimeout("observe", { on: true })).toBeLessThan(
      nativeTimeout("capture"),
    );
  });
  it("sends the tier and cadence as the helper takes them, with defaults and clamps", async () => {
    const { binary, cleanup } = fakeHelper();
    const controller = new NativeController(binary, () => {});
    try {
      expect(await controller.observe({ on: true })).toEqual({
        observing: true,
      });
      expect(await controller.request("lastObserve")).toEqual({
        on: true,
        tier: "structure",
        everyMs: OBSERVE_EVERY_MS_DEFAULT,
      });
      await controller.observe({ on: true, tier: "text", everyMs: 10 });
      expect(await controller.request("lastObserve")).toMatchObject({
        tier: "text",
        everyMs: 1000,
      });
      await controller.observe({ on: true, tier: "pixels", everyMs: 1e9 });
      expect(await controller.request("lastObserve")).toMatchObject({
        tier: "pixels",
        everyMs: 600_000,
      });
      await controller.observe({ on: true, everyMs: Number.NaN });
      expect(await controller.request("lastObserve")).toMatchObject({
        everyMs: OBSERVE_EVERY_MS_DEFAULT,
      });
      expect(await controller.observe({ on: false })).toEqual({
        observing: false,
      });
      expect(await controller.request("lastObserve")).toEqual({
        on: false,
        tier: "structure",
        everyMs: OBSERVE_EVERY_MS_DEFAULT,
      });
      await expect(
        controller.observe({ on: true, tier: "everything" as never }),
      ).rejects.toThrow(/tier/);
      // The refused tier never reached the helper.
      expect(await controller.request("lastObserve")).toMatchObject({
        on: false,
      });
    } finally {
      controller.close();
      cleanup();
    }
  });
  it("a slow observe fails with its own sentence and never restarts the helper", async () => {
    const { binary, cleanup } = fakeHelper(
      `if (request.method === 'observe') return;`,
    );
    const controller = new NativeController(
      binary,
      () => {},
      () => {},
      undefined,
      {
        timeout: (method) => (method === "observe" ? 50 : 5000),
      },
    );
    try {
      const error = await controller.observe({ on: false }).catch((e) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(HelperUnavailableError);
      expect(error.message).toBe("The observer did not answer in time.");
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

describe("observe: the events", () => {
  const fullFrame = {
    event: "observe_frame",
    atMs: 1700000000000,
    appId: "com.apple.Notes",
    appName: "Notes",
    windowTitle: "T".repeat(400),
    host: "Docs.Example.com",
    focusedRole: "AXTextArea",
    focusedLabel: "Note body",
    controls: Array.from({ length: 80 }, (_, i) => ({
      role: "button",
      label: `Button ${i}`,
      x: 0.5,
      y: 0.5,
    })),
    textDigest: "d".repeat(3000),
    image: "QUJD",
    pid: 42,
    secret: "not in the contract",
  };
  it("delivers frames, actions and dropped notices to the hook, validated and bounded, in order", async () => {
    const { binary, cleanup } = fakeHelper();
    const { traced, sink } = recorder();
    const observed: ObservedEvent[] = [];
    const controller = new NativeController(
      binary,
      () => {},
      () => {},
      sink,
      {
        observed: (event) => void observed.push(event),
      },
    );
    try {
      await controller.request("emit", {
        lines: [
          fullFrame,
          {
            event: "observe_frame",
            atMs: 2,
            excluded: "secure_input",
            appId: "com.1password.1password",
            windowTitle: "Vault",
            textDigest: "leak",
            image: "QUJD",
          },
          { event: "observe_frame", atMs: 3, excluded: "locked", appId: "x" },
          { event: "observe_frame", atMs: 4, excluded: "own_run" },
          {
            event: "observe_action",
            atMs: 5,
            appId: "com.apple.Notes",
            kind: "click",
            target: { role: "AXButton", label: "Save", extra: 1 },
          },
          {
            event: "observe_action",
            atMs: 6,
            appId: "com.apple.Notes",
            kind: "typing",
            typed: { field: "Note body", chars: 12, ms: 1800, text: "never" },
          },
          {
            event: "observe_action",
            atMs: 7,
            appId: "com.apple.Notes",
            kind: "key_chord",
            chord: "CMD+S",
          },
          {
            event: "observe_action",
            atMs: 8,
            appId: "com.apple.Safari",
            kind: "scroll",
            scroll: { direction: "down", ticks: 7 },
          },
          {
            event: "observe_action",
            atMs: 9,
            appId: "com.apple.Notes",
            kind: "menu_item",
            menu: ["File", "Export", "Export as PDF…"],
          },
          {
            event: "observe_action",
            atMs: 10,
            appId: "com.tinyspeck.slackmacgap",
            kind: "app_switch",
            chord: "CMD+TAB",
          },
          {
            event: "observe_dropped",
            atMs: 11,
            reason: "minute_budget",
            dropped: 3,
          },
          // Malformed: no time, an unknown kind, an unknown exclusion, an unknown reason.
          { event: "observe_frame", appId: "com.apple.Notes" },
          { event: "observe_action", atMs: 12, appId: "a", kind: "keystroke" },
          { event: "observe_frame", atMs: 13, excluded: "curious" },
          { event: "observe_dropped", atMs: 14, reason: "because" },
        ],
      });
      expect(observed.map((e) => e.atMs)).toEqual([
        1700000000000, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
      ]);
      const frame = observed[0];
      if (frame.event !== "observe_frame") throw new Error("expected a frame");
      expect(Object.keys(frame).sort()).toEqual(
        [
          "event",
          "atMs",
          "appId",
          "appName",
          "windowTitle",
          "host",
          "focusedRole",
          "focusedLabel",
          "controls",
          "textDigest",
          "image",
        ].sort(),
      );
      expect(frame.windowTitle).toHaveLength(OBSERVE_TITLE_MAX);
      expect(frame.textDigest).toHaveLength(OBSERVE_TEXT_MAX);
      expect(frame.host).toBe("docs.example.com");
      expect(frame.controls).toHaveLength(OBSERVE_CONTROLS_MAX);
      expect(frame.controls![0]).toEqual({ role: "button", label: "Button 0" });
      expect(frame.image).toBe("QUJD");
      expect(observed[1]).toEqual({
        event: "observe_frame",
        atMs: 2,
        excluded: "secure_input",
        appId: "com.1password.1password",
      });
      expect(observed[2]).toEqual({
        event: "observe_frame",
        atMs: 3,
        excluded: "locked",
      });
      expect(observed[3]).toEqual({
        event: "observe_frame",
        atMs: 4,
        excluded: "own_run",
      });
      expect(observed[4]).toEqual({
        event: "observe_action",
        atMs: 5,
        appId: "com.apple.Notes",
        kind: "click",
        target: { role: "AXButton", label: "Save" },
      });
      expect(observed[5]).toEqual({
        event: "observe_action",
        atMs: 6,
        appId: "com.apple.Notes",
        kind: "typing",
        typed: { field: "Note body", chars: 12, ms: 1800 },
      });
      expect(observed[6]).toMatchObject({ kind: "key_chord", chord: "CMD+S" });
      expect(observed[7]).toMatchObject({
        kind: "scroll",
        scroll: { direction: "down", ticks: 7 },
      });
      expect(observed[8]).toMatchObject({
        kind: "menu_item",
        menu: ["File", "Export", "Export as PDF…"],
      });
      expect(observed[9]).toMatchObject({
        kind: "app_switch",
        chord: "CMD+TAB",
      });
      expect(observed[10]).toEqual({
        event: "observe_dropped",
        atMs: 11,
        reason: "minute_budget",
        dropped: 3,
      });
      // The diagnostics saw codes only.
      const frames = traced.filter((t) => t.event === "ObserverFrame");
      expect(frames.map((t) => t.data)).toEqual([
        { appId: "com.apple.Notes", excluded: undefined },
        { appId: "com.1password.1password", excluded: "secure_input" },
        { appId: undefined, excluded: "locked" },
        { appId: undefined, excluded: "own_run" },
      ]);
      expect(
        traced.filter((t) => t.event === "ObserverAction").map((t) => t.data),
      ).toEqual([
        { kind: "click" },
        { kind: "typing" },
        { kind: "key_chord" },
        { kind: "scroll" },
        { kind: "menu_item" },
        { kind: "app_switch" },
      ]);
      expect(
        traced.filter((t) => t.event === "ObserverDropped").map((t) => t.data),
      ).toEqual([{ reason: "minute_budget", dropped: 3 }]);
      expect(
        traced
          .filter((t) => t.event === "ObserverMalformed")
          .map((t) => t.data),
      ).toEqual([
        { kind: "observe_frame" },
        { kind: "observe_action" },
        { kind: "observe_frame" },
        { kind: "observe_dropped" },
      ]);
      const everything = JSON.stringify(traced);
      for (const word of [
        "windowTitle",
        "textDigest",
        "image",
        "QUJD",
        "Note body",
        "CMD+S",
        "Save",
        "Export",
        "docs.example.com",
        "TTTT",
        "dddd",
      ])
        expect(everything, word).not.toContain(word);
    } finally {
      controller.close();
      cleanup();
    }
  });
  it("adds the run going now to an own_run frame, and nothing to any other", async () => {
    const { binary, cleanup } = fakeHelper();
    const observed: ObservedEvent[] = [];
    const controller = new NativeController(
      binary,
      () => {},
      () => {},
      undefined,
      {
        observed: (event) => void observed.push(event),
      },
    );
    try {
      const lines = [
        { event: "observe_frame", atMs: 1, excluded: "own_run" },
        {
          event: "observe_frame",
          atMs: 2,
          excluded: "protected",
          appId: "com.apple.Terminal",
        },
        { event: "observe_frame", atMs: 3, appId: "com.apple.Notes" },
      ];
      await controller.request("emit", { lines });
      controller.setObserveRun("dda590c3-1234-4567-8cd6-c0e751c0cd36");
      await controller.request("emit", { lines });
      controller.setObserveRun(undefined);
      await controller.request("emit", { lines: [lines[0]] });
      expect(observed.map((e) => (e as { runId?: string }).runId)).toEqual([
        undefined,
        undefined,
        undefined,
        "dda590c3-1234-4567-8cd6-c0e751c0cd36",
        undefined,
        undefined,
        undefined,
      ]);
      // A helper that put a runId on a frame itself is not believed.
      await controller.request("emit", {
        lines: [
          {
            event: "observe_frame",
            atMs: 4,
            excluded: "own_run",
            runId: "forged",
          },
        ],
      });
      expect(observed.at(-1)).toEqual({
        event: "observe_frame",
        atMs: 4,
        excluded: "own_run",
      });
    } finally {
      controller.close();
      cleanup();
    }
  });
});

describe("observedEvent", () => {
  it("keeps a full frame's contract fields, bounded, and nothing else", () => {
    const frame = observedEvent({
      event: "observe_frame",
      atMs: 10.4,
      appId: "com.apple.Notes",
      controls: [
        { role: "button", label: "Save" },
        "junk",
        { role: 1, label: "x" },
      ],
      image: "not base64!",
      focusedRole: "AXTextField",
      host: "bad host with spaces",
    });
    expect(frame).toEqual({
      event: "observe_frame",
      atMs: 10,
      appId: "com.apple.Notes",
      focusedRole: "AXTextField",
      controls: [{ role: "button", label: "Save" }],
    });
  });
  it("refuses a picture past the frame cap and keeps one under it", () => {
    const big = "A".repeat(OBSERVE_FRAME_MAX_BYTES + 1);
    expect(
      observedEvent({
        event: "observe_frame",
        atMs: 1,
        appId: "a",
        image: big,
      }),
    ).not.toHaveProperty("image");
    expect(
      observedEvent({
        event: "observe_frame",
        atMs: 1,
        appId: "a",
        image: "QUJDRA==",
      }),
    ).toMatchObject({ image: "QUJDRA==" });
  });
  it("keeps an excluded frame's code and, only for secure input and a protected surface, the application", () => {
    for (const excluded of ["secure_input", "protected"])
      expect(
        observedEvent({
          event: "observe_frame",
          atMs: 1,
          excluded,
          appId: "a",
          windowTitle: "t",
          image: "QUJD",
        }),
      ).toEqual({ event: "observe_frame", atMs: 1, excluded, appId: "a" });
    for (const excluded of ["locked", "own_run", "idle"])
      expect(
        observedEvent({
          event: "observe_frame",
          atMs: 1,
          excluded,
          appId: "a",
          windowTitle: "t",
        }),
      ).toEqual({ event: "observe_frame", atMs: 1, excluded });
  });
  it("refuses what is not in the contract", () => {
    for (const bad of [
      undefined,
      null,
      "frame",
      {},
      { event: "observe_frame" },
      { event: "observe_frame", atMs: "now", appId: "a" },
      { event: "observe_frame", atMs: -1, appId: "a" },
      { event: "observe_frame", atMs: 1 },
      { event: "observe_frame", atMs: 1, appId: "" },
      { event: "observe_frame", atMs: 1, excluded: "sleeping" },
      { event: "observe_action", atMs: 1, appId: "a" },
      { event: "observe_action", atMs: 1, appId: "a", kind: "drag" },
      { event: "observe_action", atMs: 1, kind: "click" },
      { event: "observe_dropped", atMs: 1 },
      { event: "observe_dropped", atMs: 1, reason: "tired" },
      { event: "user_takeover", atMs: 1 },
    ])
      expect(observedEvent(bad), JSON.stringify(bad)).toBeUndefined();
  });
  it("bounds an action's fields and drops malformed ones", () => {
    expect(
      observedEvent({
        event: "observe_action",
        atMs: 1,
        appId: "a",
        kind: "click",
        target: { role: "AXButton" },
        chord: "cmd+s",
        typed: { field: "f", chars: "12", ms: 1 },
        scroll: { direction: "sideways", ticks: 1 },
        menu: ["", 3, "File", ...Array.from({ length: 10 }, (_, i) => `L${i}`)],
      }),
    ).toEqual({
      event: "observe_action",
      atMs: 1,
      appId: "a",
      kind: "click",
      menu: ["File", "L0", "L1", "L2", "L3", "L4"],
    });
    expect(
      observedEvent({
        event: "observe_dropped",
        atMs: 1,
        reason: "frame_too_large",
      }),
    ).toEqual({
      event: "observe_dropped",
      atMs: 1,
      reason: "frame_too_large",
      dropped: 1,
    });
  });
});

describe("source pins", () => {
  const controller = source("native/macos/Controller.swift");
  const observer = source("native/macos/Observer.swift");
  it("the helper answers observe {on:false} on its reader thread, ahead of the command queue", () => {
    const reader = controller.indexOf("while let line = readLine()");
    const intercept = controller.indexOf(
      'if command["method"] as? String == "observe", command["on"] as? Bool == false {emit(["id":command["id"] ?? "","result":stopObserving()]);continue}',
    );
    expect(reader).toBeGreaterThan(0);
    expect(intercept).toBeGreaterThan(reader);
    expect(controller).toContain('case "observe":');
  });
  it("the tap hands the owner's presses, keys and wheel to the observer before the stopped check, never a move or a drag", () => {
    const tap = controller.indexOf("func installTap()");
    const hook = controller.indexOf(
      "observerSawInput(type:type, event:event)",
      tap,
    );
    const stopped = controller.indexOf("if isStopped() {", tap);
    expect(tap).toBeGreaterThan(0);
    expect(hook).toBeGreaterThan(tap);
    expect(hook).toBeLessThan(stopped);
    expect(controller).toContain(
      "guard on, [CGEventType.keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel].contains(type) else { return }",
    );
    // The marked check comes first: Butler's own input never reaches the observer.
    const marked = controller.indexOf("if marked {", tap);
    expect(marked).toBeGreaterThan(tap);
    expect(marked).toBeLessThan(hook);
  });
  it("a frame carries a text digest only from tier text and a picture only at tier pixels, and an excluded frame returns before any content", () => {
    expect(observer.match(/frame\["textDigest"\] = /g)).toHaveLength(1);
    expect(observer.match(/frame\["image"\] = /g)).toHaveLength(1);
    const digest = observer.indexOf('frame["textDigest"] = ');
    const textGate = observer.lastIndexOf("if tier >= .text {", digest);
    expect(textGate).toBeGreaterThan(0);
    expect(digest - textGate).toBeLessThan(200);
    const image = observer.indexOf('frame["image"] = ');
    const pixelGate = observer.lastIndexOf(
      "if tier == .pixels, observeImageAllowed(browser: readings.browser, host: readings.host),",
      image,
    );
    expect(pixelGate).toBeGreaterThan(0);
    expect(image - pixelGate).toBeLessThan(200);
    const excluded = observer.indexOf('frame["excluded"] = exclusion.rawValue');
    const returned = observer.indexOf("return frame", excluded);
    const title = observer.indexOf('frame["windowTitle"] = ');
    expect(excluded).toBeGreaterThan(0);
    expect(returned).toBeLessThan(title);
  });
  it("the observer never sets manual accessibility, sends input or activates an application", () => {
    const start = controller.indexOf("// MARK: observe");
    const end = controller.indexOf(
      "func handle(_ command:[String:Any]) async throws",
    );
    const glue = controller.slice(start, end);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    for (const forbidden of [
      "exposeAccessibilityTree",
      "AXManualAccessibility",
      "postInput(",
      ".post(tap:",
      ".activate(",
      "AXUIElementPerformAction",
      "AXUIElementSetAttributeValue",
      "latch(false)",
    ])
      expect(glue, forbidden).not.toContain(forbidden);
  });
  it("the diagnostics writer keeps exactly the codes of the observer events", () => {
    const diagnostics = source("electron/diagnostics.ts");
    expect(diagnostics).toContain(
      '["ObserverFrame", new Set(["appId", "excluded"])]',
    );
    expect(diagnostics).toContain('["ObserverAction", new Set(["kind"])]');
    expect(diagnostics).toContain(
      '["ObserverDropped", new Set(["reason", "dropped"])]',
    );
  });
  it("the observer is built into the helper and its rules into the safety suite", () => {
    expect(source("scripts/build-native.mjs")).toContain(
      '"native/macos/Observer.swift"',
    );
    const safety = source("scripts/test-native-safety.mjs");
    expect(safety).toContain('"native/macos/Observer.swift"');
    expect(safety).toContain('"tests/native/ObserverTests.swift"');
    expect(source("tests/native/FrameSafetyTests.swift")).toContain(
      "observerChecks(check)",
    );
  });
});
