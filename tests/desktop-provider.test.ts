import { afterEach, describe, expect, it, vi } from "vitest";
const network = vi.hoisted(() => ({
  fetch: vi.fn(),
  closeAllConnections: vi.fn().mockResolvedValue(undefined),
  resolveProxy: vi.fn(),
}));
vi.mock("electron", () => ({ session: { fromPartition: () => network } }));
import { createDesktopProvider } from "../electron/provider";
import { defaultSettings, type Observation } from "../src/core/schema";
import { selectProvider } from "../src/providers/catalog";
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
    const request = vi
      .fn()
      .mockResolvedValue(
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
