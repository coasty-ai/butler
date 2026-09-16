import { afterEach, describe, it, expect, vi } from "vitest";
import {
  buildRequest,
  parseResponse,
  HttpProvider,
} from "../src/providers/http";
import {
  defaultSettings,
  type Observation,
  type Settings,
} from "../src/core/schema";
const o: Observation = {
  task: "local task",
  history: [],
  frame: {
    id: "frame",
    image: "data:image/png;base64,YWJj",
    sha256: "sha",
    synthetic: false,
    capturedAt: 0,
    geometry: {
      display_id: 1,
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      native_width: 100,
      native_height: 100,
      model_width: 100,
      model_height: 100,
      scale_factor: 1,
    },
  },
};
const action = { type: "click", frame_id: "frame", x: 0.2, y: 0.3 },
  args = { action_json: JSON.stringify(action) };
const configs: Record<string, string> = {
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
  google: "https://generativelanguage.googleapis.com",
  compatible: "https://openrouter.ai/api/v1",
  ollama: "http://127.0.0.1:11434",
};
const s = (provider: Settings["provider"]): Settings => ({
  ...defaultSettings,
  provider,
  privacy: provider === "ollama" ? "PRIVATE_LOCAL" : "PRIVATE_BYOM",
  endpoint: configs[provider],
  model: "test",
  inputPrice: 1,
  outputPrice: 2,
});
afterEach(() => vi.useRealTimers());
describe("provider-neutral adapters", () => {
  it("enables bounded reasoning only for the tested mini model and its snapshots", () => {
    for (const model of ["gpt-5.4-mini", "gpt-5.4-mini-2026-03-17"]) {
      const r = buildRequest({ ...s("openai"), model }, "SECRET", o);
      expect(r.body.reasoning).toEqual({ effort: "low" });
      expect(r.body.max_output_tokens).toBe(4096);
    }
    expect(
      buildRequest(s("openai"), "SECRET", o).body.reasoning,
    ).toBeUndefined();
  });
  it("accepts an action after reasoning and accounts for all output tokens", () => {
    const result = parseResponse(
      "openai",
      {
        output: [
          { type: "reasoning", summary: [] },
          {
            type: "function_call",
            name: "coarena_action",
            arguments: JSON.stringify(args),
          },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 102,
          output_tokens_details: { reasoning_tokens: 100 },
        },
      },
      s("openai"),
    );
    expect(result.action).toEqual(action);
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 102,
      cost: 0.000214,
    });
  });
  it.each(Object.keys(configs) as Settings["provider"][])(
    "routes %s directly and keeps credentials outside content",
    (provider) => {
      const r = buildRequest(s(provider), "SECRET_API_KEY", o);
      expect(r.url).toContain(configs[provider]);
      expect(JSON.stringify(r.body)).not.toContain("SECRET_API_KEY");
      expect(JSON.stringify(r.body)).not.toContain("AXDocument");
      if (provider === "openai") expect(r.body.store).toBe(false);
    },
  );
  it("normalizes all provider outputs to the same action", () => {
    const outputs: any = {
      ollama: {
        message: { content: JSON.stringify(action) },
        prompt_eval_count: 10,
        eval_count: 2,
      },
      openai: {
        output: [
          {
            type: "function_call",
            name: "coarena_action",
            arguments: JSON.stringify(args),
          },
        ],
        usage: { input_tokens: 10, output_tokens: 2 },
      },
      anthropic: {
        content: [{ type: "tool_use", name: "coarena_action", input: args }],
        usage: { input_tokens: 10, output_tokens: 2 },
      },
      google: {
        candidates: [
          {
            content: {
              parts: [{ functionCall: { name: "coarena_action", args } }],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
      },
      compatible: {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    name: "coarena_action",
                    arguments: JSON.stringify(args),
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      },
    };
    for (const p of Object.keys(outputs) as Settings["provider"][]) {
      const r = parseResponse(p, outputs[p], s(p));
      expect(r.action).toEqual(action);
      expect(r.usage.inputTokens).toBe(10);
      expect(r.usage.cost).toBe(0.000014);
    }
  });
  it("rejects multiple calls and malformed JSON", () => {
    expect(() =>
      parseResponse(
        "openai",
        { output: [{ type: "function_call" }, { type: "function_call" }] },
        s("openai"),
      ),
    ).toThrow();
    expect(() =>
      parseResponse("ollama", { message: { content: "broken" } }, s("ollama")),
    ).toThrow();
  });
  it("retries 429 without duplicate execution and forbids redirects", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 429 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ message: { content: JSON.stringify(action) } }),
        ),
      );
    const p = new HttpProvider(s("ollama"), "", request);
    const result = await p.next(o, new AbortController().signal);
    expect(result.action).toEqual(action);
    expect(request).toHaveBeenCalledTimes(2);
    for (const call of request.mock.calls)
      expect(call[1].redirect).toBe("error");
  });
  it("never returns provider error bodies containing credentials", async () => {
    const p = new HttpProvider(
      s("openai"),
      "key",
      vi.fn().mockResolvedValue(new Response("SECRET_TOKEN", { status: 401 })),
    );
    await expect(p.next(o, new AbortController().signal)).rejects.toThrow(
      "HTTP 401",
    );
  });
  it("stops network on cancellation", async () => {
    const abort = new AbortController();
    abort.abort();
    const request = vi.fn();
    await expect(
      new HttpProvider(s("ollama"), "", request).next(o, abort.signal),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    new TypeError("fetch failed SECRET", { cause: { code: "ECONNRESET" } }),
    new Error("net::ERR_NETWORK_CHANGED SECRET"),
    new Error("net::ERR_SSL_BAD_RECORD_MAC_ALERT SECRET"),
    new TypeError("fetch failed SECRET", {
      cause: { code: "ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC" },
    }),
  ])("recovers from a transient transport failure", async (error) => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ message: { content: JSON.stringify(action) } }),
        ),
      );
    const result = new HttpProvider(s("ollama"), "", request).next(
      o,
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(500);
    expect((await result).action).toEqual(action);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("bounds repeated connection failures and redacts raw details", async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockRejectedValue(
      new TypeError("SECRET", {
        cause: { code: "UND_ERR_SOCKET", message: "SECRET" },
      }),
    );
    const result = new HttpProvider(s("ollama"), "", request)
      .next(o, new AbortController().signal)
      .catch((e) => e);
    await vi.advanceTimersByTimeAsync(1500);
    const error = await result;
    expect(error.message).toContain("UND_ERR_SOCKET");
    expect(error.message).not.toContain("SECRET");
    expect(request).toHaveBeenCalledTimes(3);
  });
  it.each([
    [{ code: "ENOTFOUND" }, "Cannot resolve"],
    [{ code: "CERT_HAS_EXPIRED" }, "secure connection"],
    [new Error("net::ERR_CERT_AUTHORITY_INVALID SECRET"), "secure connection"],
    [new Error("net::ERR_PROXY_CONNECTION_FAILED SECRET"), "network proxy"],
    [
      new Error("net::ERR_INTERNET_DISCONNECTED SECRET"),
      "network is unavailable",
    ],
    [new Error("Provider returned HTTP SECRET"), "Provider connection failed"],
  ])(
    "does not retry permanent errors or echo secrets",
    async (error, message) => {
      const request = vi.fn().mockRejectedValue(error);
      const result = await new HttpProvider(s("ollama"), "", request)
        .next(o, new AbortController().signal)
        .catch((e) => e);
      expect(result.message).toContain(message);
      expect(result.message).not.toContain("SECRET");
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
  it("cancels during retry backoff without another request", async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockRejectedValue({ code: "ECONNRESET" });
    const abort = new AbortController();
    const result = new HttpProvider(s("ollama"), "", request)
      .next(o, abort.signal)
      .catch((e) => e);
    await vi.advanceTimersByTimeAsync(100);
    abort.abort();
    await vi.advanceTimersByTimeAsync(2000);
    expect((await result).message).toBe("Cancelled.");
    expect(request).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("uses a single deadline across retries and cancels the pending body", async () => {
    vi.useFakeTimers();
    let bodyAborted = false;
    const request = vi
      .fn()
      .mockRejectedValueOnce({ code: "ECONNRESET" })
      .mockImplementationOnce((_url, init) => {
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                init.signal.addEventListener(
                  "abort",
                  () => {
                    bodyAborted = true;
                    controller.error(new DOMException("Aborted", "AbortError"));
                  },
                  { once: true },
                );
              },
            }),
          ),
        );
      });
    const result = new HttpProvider(s("ollama"), "", request)
      .next(o, new AbortController().signal)
      .catch((e) => e);
    await vi.advanceTimersByTimeAsync(60000);
    expect((await result).message).toContain("within 60 seconds");
    expect(bodyAborted).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("discards a disconnected partial response before retrying", async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"message":'));
              controller.error(
                new TypeError("terminated", {
                  cause: { code: "UND_ERR_SOCKET" },
                }),
              );
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ message: { content: JSON.stringify(action) } }),
        ),
      );
    const result = new HttpProvider(s("ollama"), "", request).next(
      o,
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(500);
    expect((await result).action).toEqual(action);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
