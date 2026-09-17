import { afterEach, describe, expect, it, vi } from "vitest";
const network = vi.hoisted(() => ({
  fetch: vi.fn(),
  closeAllConnections: vi.fn().mockResolvedValue(undefined),
  resolveProxy: vi.fn(),
}));
vi.mock("electron", () => ({
  session: { fromPartition: () => network },
  // Enough of app for electron/main to load without starting: it never gets
  // the single-instance lock, so its ready handler returns at once.
  app: {
    requestSingleInstanceLock: () => false,
    quit: () => {},
    on: () => {},
    setPath: () => {},
    whenReady: () => Promise.resolve(),
  },
}));
import { createDesktopProvider } from "../electron/provider";
import {
  shouldPrewarmIndex,
  INDEX_PREWARM_INTERVAL_MS,
} from "../electron/main";
import { defaultSettings, type Observation } from "../src/core/schema";
import { selectProvider } from "../src/providers/catalog";
import { emptyMemory, forgetRunIn } from "../src/memory/store";
import { learnFromRun } from "../src/memory/learn";
import type { LearnInput } from "../src/memory/types";
const o: Observation = {
  task: "fixture",
  history: [],
  frame: {
    id: "frame",
    image: "data:image/png;base64,YWJj",
    sha256: "sha",
    synthetic: true,
    capturedAt: 0,
    geometry: {
      display_id: 1,
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      native_width: 10,
      native_height: 10,
      model_width: 10,
      model_height: 10,
      scale_factor: 1,
    },
  },
};
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
describe("desktop TLS recovery", () => {
  it("retries the same direct endpoint through Node after a failed Chromium TLS record", async () => {
    vi.useFakeTimers();
    network.fetch.mockRejectedValue(
      new Error("net::ERR_SSL_BAD_RECORD_MAC_ALERT"),
    );
    network.resolveProxy.mockResolvedValue("DIRECT");
    const request = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          message: {
            content: JSON.stringify({
              type: "done",
              frame_id: "frame",
              summary: "ok",
            }),
          },
        }),
      ),
    );
    vi.stubGlobal("fetch", request);
    const result = createDesktopProvider(
      selectProvider(defaultSettings, "ollama"),
      "",
    ).next(o, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(500);
    expect((await result).action).toMatchObject({ type: "done" });
    expect(network.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(network.fetch).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe(network.fetch.mock.calls[0][0]);
    expect(request.mock.calls[0][1].redirect).toBe("error");
  });
  it("never bypasses a configured system proxy", async () => {
    vi.useFakeTimers();
    network.fetch.mockRejectedValue(
      new Error("net::ERR_SSL_BAD_RECORD_MAC_ALERT"),
    );
    network.resolveProxy.mockResolvedValue("PROXY localhost:8080");
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    const result = createDesktopProvider(
      selectProvider(defaultSettings, "ollama"),
      "",
    )
      .next(o, new AbortController().signal)
      .catch((e) => e);
    await vi.advanceTimersByTimeAsync(1500);
    expect((await result).message).toContain("ERR_SSL_BAD_RECORD_MAC_ALERT");
    expect(request).not.toHaveBeenCalled();
    expect(network.fetch).toHaveBeenCalledTimes(3);
  });
  it("does not retry or switch transport on certificate failure", async () => {
    network.fetch.mockRejectedValue(
      new Error("net::ERR_CERT_AUTHORITY_INVALID"),
    );
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    await expect(
      createDesktopProvider(selectProvider(defaultSettings, "ollama"), "").next(
        o,
        new AbortController().signal,
      ),
    ).rejects.toThrow("secure connection");
    expect(network.closeAllConnections).not.toHaveBeenCalled();
    expect(network.resolveProxy).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});

describe("forgetting a deleted run", () => {
  const learn = (
    data: ReturnType<typeof emptyMemory>,
    runId: string,
    task: string,
    corrections: string[],
  ) =>
    learnFromRun(
      data,
      {
        runId,
        task,
        status: "completed",
        synthetic: false,
        summary: "done",
        corrections,
        steps: [],
        appsSeen: [],
        usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
      } satisfies LearnInput,
      new Date("2026-09-01T00:00:00Z"),
    );
  it("removes the run's episode and the preferences only it taught", () => {
    const data = emptyMemory();
    learn(data, "run-a", "search for HIV testing clinics near me", [
      "Use   Safari, not Chrome.",
      "Only clinics open on Sunday",
    ]);
    learn(data, "run-b", "open my notes", ["use safari, not chrome"]);
    expect(data.preferences.map((p) => p.weight).sort()).toEqual([1, 2]);
    expect(forgetRunIn(data, "run-a")).toBe(true);
    expect(data.episodes.map((e) => e.id)).toEqual(["run-b"]);
    expect(JSON.stringify(data)).not.toContain("HIV");
    expect(JSON.stringify(data)).not.toContain("Sunday");
    // Reinforced by another run: kept with that run's weight only.
    expect(data.preferences).toHaveLength(1);
    expect(data.preferences[0]).toMatchObject({
      text: "Use Safari, not Chrome.",
      weight: 1,
    });
    expect(forgetRunIn(data, "run-b")).toBe(true);
    expect(data.episodes).toEqual([]);
    expect(data.preferences).toEqual([]);
  });
  it("leaves other memory alone and reports runs it never learned", () => {
    const data = emptyMemory();
    learn(data, "run-a", "open my notes", ["Use Safari"]);
    data.preferences.push({
      ...data.preferences[0],
      id: "pref-usage",
      source: "usage",
      text: "Use Safari",
    });
    const before = JSON.stringify(data);
    expect(forgetRunIn(data, "missing")).toBe(false);
    expect(JSON.stringify(data)).toBe(before);
    forgetRunIn(data, "run-a");
    expect(data.preferences.map((p) => p.id)).toEqual(["pref-usage"]);
    // An episode stored without corrections (older file) is still removed.
    data.episodes.push({ ...JSON.parse(before).episodes[0], id: "old" });
    delete (data.episodes[0] as any).corrections;
    expect(forgetRunIn(data, "old")).toBe(true);
    expect(data.episodes).toEqual([]);
    expect(data.preferences).toHaveLength(1);
  });
});
describe("system index prewarm", () => {
  const idle = {
    memoryEnabled: true,
    runBusy: false,
    inFlight: false,
    now: 100000,
  };
  it("prewarms only with memory on and the native queue free of a run", () => {
    expect(shouldPrewarmIndex(idle)).toBe(true);
    expect(shouldPrewarmIndex({ ...idle, memoryEnabled: false })).toBe(false);
    expect(shouldPrewarmIndex({ ...idle, runBusy: true })).toBe(false);
    expect(shouldPrewarmIndex({ ...idle, inFlight: true })).toBe(false);
  });
  it("spaces prewarms so repeated taps do not fill the native queue", () => {
    const at = (lastStartedAt: number) =>
      shouldPrewarmIndex({ ...idle, lastStartedAt });
    expect(at(idle.now - 1)).toBe(false);
    expect(at(idle.now - INDEX_PREWARM_INTERVAL_MS + 1)).toBe(false);
    expect(at(idle.now - INDEX_PREWARM_INTERVAL_MS)).toBe(true);
  });
});
